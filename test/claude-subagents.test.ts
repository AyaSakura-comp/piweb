import {
  appendFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  truncateSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createClaudeSubagentTracker } from '../src/agent/claude-subagents.js';
import { readSubagents, subagentParentScope } from '../src/session/subagents.js';

const parent = '550e8400-e29b-41d4-a716-446655440000';
const agent = 'a0123456789abcdef';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'claude-children-test-'));
  roots.push(root);
  const channel = join(root, 'channel');
  mkdirSync(channel);
  const project = join(root, 'project');
  mkdirSync(project);
  const transcript = join(project, parent + '.jsonl');
  writeFileSync(transcript, '');
  const children = join(project, parent, 'subagents');
  mkdirSync(children, { recursive: true });
  const file = join(children, `agent-${agent}.jsonl`);
  const target = join(channel, '.claude-subagents', agent, 'session.jsonl');
  const row = (type: string, message: unknown, uuid = type) => ({
    type,
    message,
    uuid,
    sessionId: parent,
    agentId: agent,
    isSidechain: true,
    timestamp: '2026-09-22T00:00:00Z',
  });
  const records = [
    row('user', { role: 'user', content: 'Read sample.txt' }),
    row(
      'assistant',
      {
        role: 'assistant',
        model: 'claude-haiku-test',
        stop_reason: 'tool_use',
        content: [
          { type: 'thinking', thinking: 'Check file' },
          { type: 'tool_use', id: 'read1', name: 'Read', input: { file_path: 'sample.txt' } },
        ],
      },
      'a1',
    ),
    row(
      'user',
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'read1',
            content: [{ type: 'text', text: '中文內容' }],
          },
        ],
      },
      'r1',
    ),
  ];
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { root, channel, project, transcript, children, file, target, row, records };
}
function launch(tracker: ReturnType<typeof createClaudeSubagentTracker>) {
  tracker.observe({
    sessionId: parent,
    type: 'assistant',
    uuid: 'launch',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'call1',
          name: 'Agent',
          input: {
            description: 'Fixture reader',
            prompt: 'Read sample.txt',
            subagent_type: 'general-purpose',
          },
        },
      ],
    },
  });
  tracker.observe({
    sessionId: parent,
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call1', content: 'launched' }],
    },
    toolUseResult: {
      agentId: agent,
      isAsync: true,
      status: 'async_launched',
      resolvedModel: 'claude-haiku-test',
    },
  });
}
const notification = (origin = 'task-notification') => ({
  sessionId: parent,
  type: 'user',
  origin: { kind: origin },
  message: {
    role: 'user',
    content: `<task-notification><task-id>${agent}</task-id><status>completed</status></task-notification>`,
  },
});

describe('Claude child projection', () => {
  it('projects only owned conversation events with actual model and stable ids', () => {
    const f = fixture();
    appendFileSync(
      f.file,
      JSON.stringify({
        ...f.row('attachment', {}),
        attachment: { type: 'prompt_snapshot', systemPrompt: 'PRIVATE_PROMPT' },
      }) + '\n',
    );
    const tracker = createClaudeSubagentTracker(f.channel, parent);
    launch(tracker);
    tracker.refresh(f.transcript);
    const rows = readFileSync(f.target, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(rows[0]).toMatchObject({
      type: 'session',
      id: agent,
      source: 'claude-code',
      parentSessionId: parent,
    });
    expect(rows).toContainEqual({ type: 'session_info', name: 'Fixture reader' });
    expect(JSON.stringify(rows)).toContain('中文內容');
    expect(JSON.stringify(rows)).toContain('claude-haiku-test');
    expect(JSON.stringify(rows)).toContain('toolCall');
    expect(JSON.stringify(rows)).not.toContain('PRIVATE_PROMPT');
    expect(tracker.hasPending).toBe(true);
    const manifest = JSON.parse(
      readFileSync(join(f.channel, '.claude-subagents', 'parent.json'), 'utf8'),
    );
    expect(manifest.activeIds).toEqual([agent]);
    tracker.stop();
    expect(
      JSON.parse(readFileSync(join(f.channel, '.claude-subagents', 'parent.json'), 'utf8'))
        .activeIds,
    ).toEqual([]);
  });
  it('does not turn user-authored task-notification text into completion', () => {
    const f = fixture();
    const tracker = createClaudeSubagentTracker(f.channel, parent);
    launch(tracker);
    tracker.observe(notification('human'));
    expect(tracker.hasPending).toBe(true);
    tracker.observe(notification());
    expect(tracker.hasPending).toBe(false);
  });
  it('accepts an in-turn completion from a queued task-notification attachment', () => {
    const f = fixture();
    const tracker = createClaudeSubagentTracker(f.channel, parent);
    launch(tracker);
    const prompt = notification().message.content;
    tracker.observe({
      sessionId: parent,
      type: 'attachment',
      attachment: { type: 'queued_command', commandMode: 'prompt', prompt },
    });
    expect(tracker.hasPending).toBe(true);
    tracker.observe({
      sessionId: parent,
      type: 'attachment',
      attachment: { type: 'queued_command', commandMode: 'task-notification', prompt },
    });
    expect(tracker.hasPending).toBe(false);
  });

  it('reads complete records only, preserving split UTF-8 until newline arrives', () => {
    const f = fixture();
    const tracker = createClaudeSubagentTracker(f.channel, parent);
    const final = Buffer.from(
      JSON.stringify(
        f.row(
          'assistant',
          {
            role: 'assistant',
            model: 'claude-opus-test',
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: '完成' }],
          },
          'final',
        ),
      ) + '\n',
    );
    const split = final.indexOf(Buffer.from('完')) + 1;
    appendFileSync(f.file, final.subarray(0, split));
    tracker.refresh(f.transcript);
    expect(readFileSync(f.target, 'utf8')).not.toContain('�');
    appendFileSync(f.file, final.subarray(split));
    tracker.refresh(f.transcript);
    expect(readFileSync(f.target, 'utf8')).toContain('完成');
  });
  it('still snapshots children when parent recovery metadata exceeds the read budget', () => {
    const f = fixture();
    truncateSync(f.transcript, 16 * 1024 * 1024 + 1);
    const tracker = createClaudeSubagentTracker(f.channel, parent);
    launch(tracker);
    tracker.refresh(f.transcript);
    expect(readFileSync(f.target, 'utf8')).toContain('中文內容');
  });

  it('does not expose records from another parent or agent identity', () => {
    const f = fixture();
    appendFileSync(
      f.file,
      JSON.stringify({
        ...f.row('user', { role: 'user', content: 'OTHER_PARENT' }),
        sessionId: 'elsewhere',
      }) + '\n',
    );
    const tracker = createClaudeSubagentTracker(f.channel, parent);
    tracker.refresh(f.transcript);
    expect(existsSync(f.target)).toBe(false);
  });
  it.each(['symlink-file', 'hardlink-file', 'symlink-parent', 'symlink-output'])(
    'refuses unsafe filesystem shape: %s',
    (shape) => {
      const f = fixture();
      if (shape === 'symlink-file') {
        renameSync(f.file, f.file + '.real');
        symlinkSync(f.file + '.real', f.file);
      }
      if (shape === 'hardlink-file') linkSync(f.file, f.file + '.link');
      if (shape === 'symlink-parent') {
        renameSync(f.children, f.children + '.real');
        symlinkSync(f.children + '.real', f.children);
      }
      if (shape === 'symlink-output') symlinkSync(f.project, join(f.channel, '.claude-subagents'));
      const tracker = createClaudeSubagentTracker(f.channel, parent);
      tracker.refresh(f.transcript);
      expect(existsSync(f.target)).toBe(false);
    },
  );
  it('never writes into a replaced generation or after ownership loss', () => {
    const f = fixture();
    let owned = true;
    const tracker = createClaudeSubagentTracker(f.channel, parent, { isCurrent: () => owned });
    tracker.refresh(f.transcript);
    const previous = readFileSync(f.target, 'utf8');
    owned = false;
    appendFileSync(
      f.file,
      JSON.stringify(f.row('user', { role: 'user', content: 'LATE' }, 'late')) + '\n',
    );
    tracker.refresh(f.transcript);
    expect(readFileSync(f.target, 'utf8')).toBe(previous);
    owned = true;
    renameSync(f.channel, f.channel + '.old');
    mkdirSync(f.channel);
    tracker.refresh(f.transcript);
    tracker.stop();
    expect(existsSync(join(f.channel, '.claude-subagents'))).toBe(false);
  });
  it('exposes Claude children through the protected viewer with fresh activity and scope fences', async () => {
    const f = fixture();
    const state = join(f.channel, 'claude-tmux-session.json');
    writeFileSync(
      state,
      JSON.stringify({ sessionId: parent, modelRef: 'claude-code/opus', cwd: f.project }, null, 2),
    );
    const tracker = createClaudeSubagentTracker(f.channel, parent);
    launch(tracker);
    tracker.refresh(f.transcript);
    const list = await readSubagents(f.channel, 'owner', { cwd: f.project });
    expect(list.children).toHaveLength(1);
    expect(list.children[0]).toMatchObject({
      source: 'claude-code',
      running: true,
      name: 'Fixture reader',
    });
    expect(await subagentParentScope(f.channel, 'owner', f.project)).toBe(list.scope);
    const detail = await readSubagents(f.channel, 'owner', {
      scope: list.scope,
      child: list.children[0].id,
      cwd: f.project,
    });
    expect(detail.events?.map((e) => e.kind)).toEqual([
      'message',
      'thinking',
      'tool',
      'tool_result',
    ]);
    tracker.stop();
    expect((await readSubagents(f.channel, 'owner', { cwd: f.project })).children[0].running).toBe(
      false,
    );
    writeFileSync(
      state,
      JSON.stringify({ sessionId: 'other-parent', modelRef: 'claude-code/opus', cwd: f.project }),
    );
    await expect(
      readSubagents(f.channel, 'owner', {
        scope: list.scope,
        child: list.children[0].id,
        cwd: f.project,
      }),
    ).rejects.toThrow('Parent session changed');
    expect((await readSubagents(f.channel, 'owner', { cwd: f.project })).children).toEqual([]);
  });

  it('keeps selected history available across concurrent atomic snapshot replacement', async () => {
    const f = fixture();
    writeFileSync(
      join(f.channel, 'claude-tmux-session.json'),
      JSON.stringify({ sessionId: parent, modelRef: 'claude-code/opus', cwd: f.project }),
    );
    const tracker = createClaudeSubagentTracker(f.channel, parent);
    tracker.refresh(f.transcript);
    const list = await readSubagents(f.channel, 'race-owner');
    let counter = 0;
    const timer = setInterval(() => {
      // Bound growth under the parallel full suite; this test exercises rename
      // overlap, not unbounded transcript growth while readers are scheduled.
      if (counter >= 25) {
        clearInterval(timer);
        return;
      }
      appendFileSync(
        f.file,
        JSON.stringify(
          f.row(
            'assistant',
            {
              role: 'assistant',
              model: 'claude-opus-test',
              stop_reason: 'end_turn',
              content: [{ type: 'text', text: `Update ${counter}` }],
            },
            `update-${counter++}`,
          ),
        ) + '\n',
      );
      tracker.refresh(f.transcript);
    }, 1);
    try {
      for (let i = 0; i < 100; i++) {
        await expect(
          readSubagents(f.channel, 'race-owner', { scope: list.scope, child: list.children[0].id }),
        ).resolves.toMatchObject({ scope: list.scope });
      }
    } finally {
      clearInterval(timer);
      tracker.stop();
    }
  }, 15000);

  it('ignores arbitrary outputFile paths and uncorrelated agent metadata', () => {
    const f = fixture();
    const tracker = createClaudeSubagentTracker(f.channel, parent);
    tracker.observe({
      sessionId: parent,
      type: 'user',
      toolUseResult: { agentId: '../escape', isAsync: true, outputFile: '/etc/passwd' },
    });
    expect(tracker.hasPending).toBe(false);
    tracker.refresh('/etc/passwd');
    expect(existsSync(f.target)).toBe(false);
  });
});
