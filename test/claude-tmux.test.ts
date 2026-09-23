import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AUTONOMOUS_SYSTEM_PROMPT,
  buildClaudeArgs,
  claudeModelId,
  isClaudeTmuxModelRef,
  invokeClaudeTmux,
  listClaudeTmuxModels,
  tmuxSessionName,
  translateClaudeTranscriptRecord,
  type ClaudeTmuxDependencies,
} from '../src/agent/claude-tmux.js';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Claude tmux model catalog', () => {
  it('is feature gated and exposes stable Claude Code aliases', () => {
    expect(listClaudeTmuxModels(false)).toEqual([]);
    const models = listClaudeTmuxModels(true);
    expect(models.map((model) => model.ref)).toEqual([
      'claude-code/haiku',
      'claude-code/sonnet',
      'claude-code/opus',
    ]);
    const haiku = models.find((m) => m.id === 'haiku');
    const sonnet = models.find((m) => m.id === 'sonnet');
    const opus = models.find((m) => m.id === 'opus');
    expect(haiku?.reasoning).toBe(false);
    expect(haiku?.supportedThinkingLevels).toEqual(['off']);
    expect(sonnet?.reasoning).toBe(true);
    expect(sonnet?.supportedThinkingLevels).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(opus?.reasoning).toBe(true);
    expect(opus?.supportedThinkingLevels).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('recognises only claude-code refs and strips their provider', () => {
    expect(isClaudeTmuxModelRef('claude-code/sonnet')).toBe(true);
    expect(isClaudeTmuxModelRef('CLAUDE-CODE/opus')).toBe(true);
    expect(isClaudeTmuxModelRef('agy/claude-sonnet-4-6')).toBe(false);
    expect(isClaudeTmuxModelRef(undefined)).toBe(false);
    expect(claudeModelId('claude-code/haiku')).toBe('haiku');
  });
});

describe('Claude tmux launch contract', () => {
  it('builds a fully autonomous interactive launch without print or bare mode', () => {
    const args = buildClaudeArgs({
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
      modelRef: 'claude-code/sonnet',
      thinking: 'high',
      resume: false,
    });

    expect(args).toEqual(
      expect.arrayContaining([
        '--session-id',
        '550e8400-e29b-41d4-a716-446655440000',
        '--model',
        'sonnet',
        '--effort',
        'high',
        '--permission-mode',
        'bypassPermissions',
        '--disallowedTools',
        'AskUserQuestion',
        '--append-system-prompt',
        AUTONOMOUS_SYSTEM_PROMPT,
      ]),
    );
    expect(args).not.toContain('-p');
    expect(args).not.toContain('--print');
    expect(args).not.toContain('--bare');
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  it('resumes an existing id instead of trying to create it again', () => {
    const id = '550e8400-e29b-41d4-a716-446655440000';
    const args = buildClaudeArgs({ sessionId: id, modelRef: 'claude-code/haiku', resume: true });

    expect(args).toContain('--resume');
    expect(args[args.indexOf('--resume') + 1]).toBe(id);
    expect(args).not.toContain('--session-id');
  });

  it('uses a stable safe tmux name without exposing the channel folder', () => {
    const first = tmuxSessionName('guild/private project');
    const second = tmuxSessionName('guild/private project');

    expect(first).toBe(second);
    expect(first).toMatch(/^piweb-cc-[a-f0-9]{16}$/);
    expect(first).not.toContain('private');
    expect(tmuxSessionName('another')).not.toBe(first);
  });
});

describe('Claude tmux invocation', () => {
  it('launches once, accepts workspace trust, sends through a tmux buffer, and reads the structured result', async () => {
    const fixture = createRuntimeFixture();
    const onEvent = vi.fn();

    const result = await invokeClaudeTmux('web_claude1', 'fix the tests', {
      channelJid: 'web:claude1',
      model: 'claude-code/haiku',
      thinking: 'low',
      cwd: fixture.cwd,
      onEvent,
      dependencies: fixture.dependencies,
    });

    expect(result).toEqual({ ok: true, text: 'Done from tmux.' });
    expect(fixture.launches).toHaveLength(1);
    expect(fixture.launches[0]).toEqual(
      expect.arrayContaining([
        '--session-id',
        fixture.sessionId,
        '--permission-mode',
        'bypassPermissions',
      ]),
    );
    expect(fixture.loadedPrompts).toEqual(['fix the tests']);
    expect(fixture.trustAccepted).toBe(true);
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        assistantMessageEvent: expect.objectContaining({ type: 'toolcall_end' }),
      }),
    );

    expect(fixture.pastes[0]).toEqual(expect.arrayContaining(['paste-buffer', '-d', '-p']));

    const saved = JSON.parse(
      readFileSync(join(fixture.sessionDir, 'claude-tmux-session.json'), 'utf8'),
    );
    expect(saved).toMatchObject({
      sessionId: fixture.sessionId,
      transcriptPath: fixture.transcript,
    });
  });

  it('adds a literal request outside the paste so Claude treats it as the user task', async () => {
    const fixture = createRuntimeFixture();
    await invokeClaudeTmux('web_claude1', 'Reply with exactly BRIDGE_OK.', {
      dependencies: fixture.dependencies,
    });
    const instruction = fixture.sentKeys.find((keys) => keys.includes('-l'));
    expect(instruction?.at(-1)).toBe('Please carry out the following user request: ');
  });

  it('interrupts a recovered running turn when Stop is requested', async () => {
    const fixture = createRuntimeFixture({ runningScreen: true, completeTurns: false });
    persistActiveTurn(fixture, '94', 0);
    fixture.live = true;
    const controller = new AbortController();
    fixture.dependencies.sleep = async () => {
      controller.abort();
    };
    const result = await invokeClaudeTmux('web_claude1', 'recover', {
      turnId: 94,
      model: 'claude-code/haiku',
      cwd: fixture.cwd,
      signal: controller.signal,
      dependencies: fixture.dependencies,
    });
    expect(result).toMatchObject({ ok: false, aborted: true });
    expect(fixture.sentKeys.some((keys) => keys.includes('C-c'))).toBe(true);
  });

  it('stops promptly on a dangerous-operation confirmation instead of timing out', async () => {
    const fixture = createRuntimeFixture({ completeTurns: false });
    const tmux = fixture.dependencies.tmux;
    fixture.dependencies.tmux = async (args) => {
      if (args[0] === 'capture-pane' && fixture.submissionCount) {
        return 'Run shell command\n\n │ Dangerous rm operation on working directory or its ancestor:\n │ /home/chihmin/src/piweb-repro\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel · Tab to amend';
      }
      return tmux(args);
    };
    const result = await invokeClaudeTmux('web_claude1', 'work', {
      dependencies: fixture.dependencies,
    });
    expect(result).toMatchObject({ ok: false });
    expect(result.error).toContain('requires manual confirmation');
    expect(result.error).not.toContain('timed out');
    expect(fixture.sentKeys.some((keys) => keys.includes('C-c'))).toBe(true);
  });

  it('reports a dead pane without waiting for the entire turn timeout', async () => {
    const fixture = createRuntimeFixture({ completeTurns: false });
    const tmux = fixture.dependencies.tmux;
    fixture.dependencies.tmux = async (args) => {
      if (args[0] === 'display-message') return '1\n';
      return tmux(args);
    };
    const result = await invokeClaudeTmux('web_claude1', 'work', {
      dependencies: fixture.dependencies,
    });
    expect(result.error).toContain('pane exited');
  });

  it('preserves UTF-8 characters when a transcript write splits a code point', async () => {
    const fixture = createRuntimeFixture({ completeTurns: false });
    const record = Buffer.from(
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: '完成測試' }],
        },
      }) +
        '\n' +
        JSON.stringify({ type: 'system', subtype: 'turn_duration' }) +
        '\n',
    );
    const split = record.indexOf(Buffer.from('完')) + 1;
    let wrote = false;
    const tmux = fixture.dependencies.tmux;
    fixture.dependencies.tmux = async (args) => {
      const result = await tmux(args);
      if (fixture.submissionCount && !wrote) {
        wrote = true;
        writeFileSync(fixture.transcript, record.subarray(0, split));
      }
      return result;
    };
    fixture.dependencies.sleep = async () => {
      if (wrote) {
        appendFileSync(fixture.transcript, record.subarray(split));
        wrote = false;
      }
    };
    const result = await invokeClaudeTmux('web_claude1', 'work', {
      dependencies: fixture.dependencies,
    });
    expect(result).toEqual({ ok: true, text: '完成測試' });
  });

  it('pastes with bracketed paste mode (-p) to preserve multiline prompts', async () => {
    const fixture = createRuntimeFixture();
    const result = await invokeClaudeTmux('web_claude1', '[Web user: web]\nHello', {
      model: 'claude-code/opus',
      dependencies: fixture.dependencies,
    });

    expect(result).toEqual({ ok: true, text: 'Done from tmux.' });
    expect(fixture.pastes[0]).toEqual(expect.arrayContaining(['paste-buffer', '-d', '-p']));
    expect(fixture.loadedPrompts[0]).toBe('[Web user: web]\nHello');
  });

  it('reuses a live pane and resumes a persisted session after the pane disappears', async () => {
    const fixture = createRuntimeFixture();
    await invokeClaudeTmux('web_claude1', 'first', {
      model: 'claude-code/haiku',
      cwd: fixture.cwd,
      dependencies: fixture.dependencies,
    });
    await invokeClaudeTmux('web_claude1', 'second', {
      model: 'claude-code/haiku',
      cwd: fixture.cwd,
      dependencies: fixture.dependencies,
    });
    expect(fixture.launches).toHaveLength(1);

    fixture.live = false;
    await invokeClaudeTmux('web_claude1', 'third', {
      model: 'claude-code/haiku',
      cwd: fixture.cwd,
      dependencies: fixture.dependencies,
    });
    expect(fixture.launches).toHaveLength(2);
    expect(fixture.launches[1]).toEqual(expect.arrayContaining(['--resume', fixture.sessionId]));
    expect(fixture.launches[1]).not.toContain('--session-id');
  });

  it('restarts with resume when the requested thinking effort changes', async () => {
    const fixture = createRuntimeFixture();
    await invokeClaudeTmux('web_claude1', 'first', {
      model: 'claude-code/haiku',
      thinking: 'low',
      cwd: fixture.cwd,
      dependencies: fixture.dependencies,
    });
    await invokeClaudeTmux('web_claude1', 'second', {
      model: 'claude-code/haiku',
      thinking: 'high',
      cwd: fixture.cwd,
      dependencies: fixture.dependencies,
    });

    expect(fixture.launches).toHaveLength(2);
    expect(fixture.launches[1]).toEqual(
      expect.arrayContaining(['--resume', fixture.sessionId, '--effort', 'high']),
    );
  });

  it('adds staged upload paths to the autonomous prompt', async () => {
    const fixture = createRuntimeFixture();
    fixture.dependencies.prepareAttachments = vi
      .fn()
      .mockResolvedValue(['/tmp/uploaded-photo.png']);

    await invokeClaudeTmux('web_claude1', 'inspect this image', {
      model: 'claude-code/haiku',
      cwd: fixture.cwd,
      attachments: '[{"filePath":"/tmp/source.png"}]',
      dependencies: fixture.dependencies,
    });

    expect(fixture.loadedPrompts[0]).toContain('inspect this image');
    expect(fixture.loadedPrompts[0]).toContain('[Uploaded file: /tmp/uploaded-photo.png]');
  });

  it('persists the stable turn identity and transcript offset before pressing Enter', async () => {
    const fixture = createRuntimeFixture();

    await invokeClaudeTmux('web_claude1', 'durable turn', {
      turnId: 314,
      model: 'claude-code/haiku',
      cwd: fixture.cwd,
      dependencies: fixture.dependencies,
    });

    expect(fixture.stateAtSubmissions).toHaveLength(1);
    expect(fixture.stateAtSubmissions[0]).toMatchObject({
      activeTurn: {
        turnId: '314',
        transcriptOffset: 0,
      },
    });
  });

  it('tails an already submitted recovered turn without waiting for an idle prompt or submitting twice', async () => {
    const fixture = createRuntimeFixture({ runningScreen: true });
    persistActiveTurn(fixture, '91', 0);
    fixture.live = true;
    fixture.appendTurn();

    const result = await invokeClaudeTmux('web_claude1', 'recover me', {
      turnId: 91,
      model: 'claude-code/haiku',
      cwd: fixture.cwd,
      dependencies: fixture.dependencies,
    });

    expect(result).toEqual({ ok: true, text: 'Done from tmux.' });
    expect(fixture.loadedPrompts).toEqual([]);
    expect(fixture.submissionCount).toBe(0);
  });

  it('submits a recovered turn once when the pane is idle and the transcript has no new bytes', async () => {
    const fixture = createRuntimeFixture();
    persistActiveTurn(fixture, '92', 0);
    fixture.live = true;

    const result = await invokeClaudeTmux('web_claude1', 'submit after recovery', {
      turnId: 92,
      model: 'claude-code/haiku',
      cwd: fixture.cwd,
      dependencies: fixture.dependencies,
    });

    expect(result.ok).toBe(true);
    expect(fixture.loadedPrompts).toEqual(['submit after recovery']);
    expect(fixture.submissionCount).toBe(1);
  });

  it('tails a recovered long-running pane even before transcript bytes appear', async () => {
    const fixture = createRuntimeFixture({ runningScreen: true });
    persistActiveTurn(fixture, '93', 0);
    fixture.live = true;
    let appended = false;
    fixture.dependencies.sleep = async () => {
      if (!appended) {
        appended = true;
        fixture.appendTurn();
      }
    };

    const result = await invokeClaudeTmux('web_claude1', 'still running', {
      turnId: 93,
      model: 'claude-code/haiku',
      cwd: fixture.cwd,
      dependencies: fixture.dependencies,
    });

    expect(result.ok).toBe(true);
    expect(fixture.submissionCount).toBe(0);
  });

  it('waits beyond a background-child acknowledgement for the resumed parent final', async () => {
    const fixture = createRuntimeFixture({ completeTurns: false });
    let phase = 0;
    const tmux = fixture.dependencies.tmux;
    fixture.dependencies.tmux = async (args) => {
      const result = await tmux(args);
      if (fixture.submissionCount && phase === 0) {
        phase = 1;
        appendFileSync(
          fixture.transcript,
          [
            {
              type: 'assistant',
              message: {
                role: 'assistant',
                stop_reason: 'end_turn',
                content: [{ type: 'text', text: 'Child still running.' }],
              },
            },
            { type: 'system', subtype: 'turn_duration', pendingBackgroundAgentCount: 1 },
          ]
            .map((row) => JSON.stringify(row))
            .join('\n') + '\n',
        );
      }
      return result;
    };
    fixture.dependencies.sleep = async () => {
      if (phase === 1) {
        phase = 2;
        appendFileSync(
          fixture.transcript,
          [
            {
              type: 'assistant',
              message: {
                role: 'assistant',
                stop_reason: 'end_turn',
                content: [{ type: 'text', text: 'Parent received child final.' }],
              },
            },
            { type: 'system', subtype: 'turn_duration', pendingBackgroundAgentCount: 0 },
          ]
            .map((row) => JSON.stringify(row))
            .join('\n') + '\n',
        );
      }
    };
    const result = await invokeClaudeTmux('web_claude1', 'run child', {
      dependencies: fixture.dependencies,
    });
    expect(result).toEqual({ ok: true, text: 'Parent received child final.' });
    expect(fixture.submissionCount).toBe(1);
  });

  it('does not submit when already aborted before startup', async () => {
    const fixture = createRuntimeFixture();
    const controller = new AbortController();
    controller.abort();

    const result = await invokeClaudeTmux('web_claude1', 'must not run', {
      model: 'claude-code/haiku',
      cwd: fixture.cwd,
      signal: controller.signal,
      dependencies: fixture.dependencies,
    });

    expect(result).toMatchObject({ ok: false, aborted: true });
    expect(fixture.loadedPrompts).toEqual([]);
    expect(fixture.submissionCount).toBe(0);
    expect(fixture.sentKeys.some((keys) => keys.includes('C-c'))).toBe(false);
  });

  it('does not submit or interrupt the pane when attachment staging aborts', async () => {
    const fixture = createRuntimeFixture();
    const controller = new AbortController();
    fixture.dependencies.prepareAttachments = vi.fn().mockImplementation(async () => {
      controller.abort();
      return ['/tmp/too-late.png'];
    });

    const result = await invokeClaudeTmux('web_claude1', 'inspect', {
      model: 'claude-code/haiku',
      cwd: fixture.cwd,
      attachments: '[]',
      signal: controller.signal,
      dependencies: fixture.dependencies,
    });

    expect(result).toMatchObject({ ok: false, aborted: true });
    expect(fixture.loadedPrompts).toEqual([]);
    expect(fixture.submissionCount).toBe(0);
    expect(fixture.sentKeys.some((keys) => keys.includes('C-c'))).toBe(false);
  });

  it('does not press Enter when abort fires while the buffer is being pasted', async () => {
    const fixture = createRuntimeFixture();
    const controller = new AbortController();
    const tmux = fixture.dependencies.tmux;
    fixture.dependencies.tmux = async (args) => {
      const output = await tmux(args);
      if (args[0] === 'paste-buffer') controller.abort();
      return output;
    };

    const result = await invokeClaudeTmux('web_claude1', 'abort paste', {
      model: 'claude-code/haiku',
      cwd: fixture.cwd,
      signal: controller.signal,
      dependencies: fixture.dependencies,
    });

    expect(result).toMatchObject({ ok: false, aborted: true });
    expect(fixture.submissionCount).toBe(0);
    expect(fixture.sentKeys.some((keys) => keys.includes('C-c'))).toBe(false);
  });

  it('always removes its abort listener when setup fails', async () => {
    const fixture = createRuntimeFixture();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    fixture.dependencies.loadBuffer = vi.fn().mockRejectedValue(new Error('buffer failed'));

    const result = await invokeClaudeTmux('web_claude1', 'listener cleanup', {
      model: 'claude-code/haiku',
      cwd: fixture.cwd,
      signal: controller.signal,
      dependencies: fixture.dependencies,
    });

    expect(result.ok).toBe(false);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('waits for each new multiline paste marker instead of accepting a stale transcript marker', async () => {
    const fixture = createRuntimeFixture();
    const prompt = 'same first line\nsame second line';

    const first = await invokeClaudeTmux('web_claude1', prompt, {
      turnId: 201,
      model: 'claude-code/haiku',
      cwd: fixture.cwd,
      dependencies: fixture.dependencies,
    });
    const second = await invokeClaudeTmux('web_claude1', prompt, {
      turnId: 202,
      model: 'claude-code/haiku',
      cwd: fixture.cwd,
      dependencies: fixture.dependencies,
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(fixture.seenPasteMarkers).toEqual(['[Pasted text #1]', '[Pasted text #2]']);
    expect(fixture.submissionCount).toBe(2);
  });

  it('accepts a multiline paste marker with the appended line count', async () => {
    const fixture = createRuntimeFixture({ pasteLineCount: true });
    const result = await invokeClaudeTmux('web_claude1', 'first line\nsecond line', {
      dependencies: fixture.dependencies,
    });

    expect(result).toEqual({ ok: true, text: 'Done from tmux.' });
    expect(fixture.seenPasteMarkers).toEqual(['[Pasted text #1 +1 lines]']);
    expect(fixture.submissionCount).toBe(1);
  });

  it('sends Ctrl-C and preserves the tmux session when aborted', async () => {
    const fixture = createRuntimeFixture({ completeTurns: false });
    const controller = new AbortController();
    const originalSleep = fixture.dependencies.sleep;
    fixture.dependencies.sleep = async (ms) => {
      if (fixture.submissionCount > 0 && !controller.signal.aborted) {
        controller.abort();
      }
      return originalSleep(ms);
    };
    const promise = invokeClaudeTmux('web_claude1', 'keep working', {
      model: 'claude-code/haiku',
      cwd: fixture.cwd,
      signal: controller.signal,
      dependencies: fixture.dependencies,
    });

    await expect(promise).resolves.toMatchObject({ ok: false, aborted: true });
    expect(fixture.sentKeys.some((keys) => keys.includes('C-c'))).toBe(true);
    expect(fixture.live).toBe(true);
  });
});

describe('Claude transcript translation', () => {
  it('maps thinking, tool calls, and final text from assistant records', () => {
    const thinking = translateClaudeTranscriptRecord({
      type: 'assistant',
      message: {
        role: 'assistant',
        stop_reason: 'tool_use',
        content: [
          { type: 'thinking', thinking: 'Inspect the tests first.' },
          { type: 'text', text: 'I will inspect the tests.' },
          { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'test/a.ts' } },
        ],
      },
    });

    expect(thinking.events).toEqual([
      {
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_end', content: 'Inspect the tests first.' },
      },
      {
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_end', content: 'I will inspect the tests.' },
      },
      {
        type: 'message_update',
        assistantMessageEvent: {
          type: 'toolcall_end',
          toolCall: { name: 'Read', arguments: { file_path: 'test/a.ts' } },
        },
      },
    ]);
    expect(thinking.finalText).toBeUndefined();

    const final = translateClaudeTranscriptRecord({
      type: 'assistant',
      message: {
        role: 'assistant',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Implemented and verified.' }],
      },
    });
    expect(final.finalText).toBe('Implemented and verified.');
    expect(final.events).toEqual([]);
  });

  it('maps a text-only narration record ending in tool_use to thinking', () => {
    const translated = translateClaudeTranscriptRecord({
      type: 'assistant',
      message: {
        role: 'assistant',
        stop_reason: 'tool_use',
        content: [{ type: 'text', text: 'I will inspect the repository first.' }],
      },
    });

    expect(translated.events).toEqual([
      {
        type: 'message_update',
        assistantMessageEvent: {
          type: 'thinking_end',
          content: 'I will inspect the repository first.',
        },
      },
    ]);
    expect(translated.finalText).toBeUndefined();
  });

  it('maps tool results from user records and accepts nested content', () => {
    const translated = translateClaudeTranscriptRecord({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: [{ type: 'text', text: '3 tests passed' }],
          },
        ],
      },
    });

    expect(translated.events).toEqual([
      {
        type: 'message_end',
        message: { role: 'tool', content: [{ type: 'text', text: '3 tests passed' }] },
      },
    ]);
  });

  it('marks turn_duration as completion and ignores sidechain chatter', () => {
    expect(
      translateClaudeTranscriptRecord({ type: 'system', subtype: 'turn_duration', durationMs: 42 }),
    ).toMatchObject({ turnComplete: true });

    expect(
      translateClaudeTranscriptRecord({
        type: 'assistant',
        isSidechain: true,
        message: {
          role: 'assistant',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'subagent-only text' }],
        },
      }),
    ).toEqual({ events: [] });
  });
});

function createRuntimeFixture(
  options: { completeTurns?: boolean; runningScreen?: boolean; pasteLineCount?: boolean } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'piweb-claude-tmux-test-'));
  tempDirs.push(root);
  const sessionDir = join(root, 'sessions', 'web_claude1');
  const cwd = join(root, 'project');
  const transcript = join(root, 'claude.jsonl');
  const sessionId = '550e8400-e29b-41d4-a716-446655440000';
  const launches: string[][] = [];
  const loadedPrompts: string[] = [];
  const sentKeys: string[][] = [];
  const pastes: string[][] = [];
  let live = false;
  let trustAccepted = false;
  const stateAtSubmissions: any[] = [];
  const seenPasteMarkers: string[] = [];
  let readyCaptures = 0;
  let pasteCaptures = 0;
  let pastePending = false;
  let pasteMarker = 0;
  let currentInput = '';
  let priorScreen = '';
  let pendingPrompt = '';
  let submissionCount = 0;

  const appendTurn = () => {
    appendFileSync(
      transcript,
      [
        JSON.stringify({ type: 'user', message: { role: 'user', content: pendingPrompt } }),
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            stop_reason: 'tool_use',
            content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'README.md' } }],
          },
        }),
        JSON.stringify({
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', content: 'README contents' }],
          },
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: 'Done from tmux.' }],
          },
        }),
        JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 12 }),
      ].join('\n') + '\n',
      'utf8',
    );
  };

  const dependencies: ClaudeTmuxDependencies = {
    randomUUID: () => sessionId,
    resolveSessionDir: () => sessionDir,
    findTranscript: () => transcript,
    loadBuffer: async (text) => {
      pendingPrompt = text;
      loadedPrompts.push(text);
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 1))),
    tmux: async (args) => {
      if (args[0] === 'has-session') {
        if (!live) throw new Error('no session');
        return '';
      }
      if (args[0] === 'new-session') {
        live = true;
        launches.push(args.slice(args.indexOf('/fake/claude') + 1));
        return '';
      }
      if (args[0] === 'list-panes') return '%42\n';
      if (args[0] === 'capture-pane') {
        if (!trustAccepted) return '1. Yes, I trust this folder\n2. No, exit';
        readyCaptures += 1;
        if (options.runningScreen) {
          return `${priorScreen}Working on tools…\nbypass permissions on · esc to interrupt`;
        }
        if (pastePending) {
          pasteCaptures += 1;
          if (pasteCaptures >= 2) {
            currentInput = pendingPrompt.includes('\n')
              ? `[Pasted text #${pasteMarker}${options.pasteLineCount ? ' +1 lines' : ''}]`
              : pendingPrompt;
          }
        }
        return readyCaptures >= 2
          ? `${priorScreen}❯ ${currentInput}\nbypass permissions on · esc to interrupt`
          : 'bypass permissions on · starting Claude Code';
      }
      if (args[0] === 'paste-buffer') {
        pastes.push(args);
        pastePending = true;
        pasteCaptures = 0;
        if (pendingPrompt.includes('\n')) pasteMarker += 1;
        return '';
      }
      if (args[0] === 'send-keys') {
        sentKeys.push(args);
        if (args.at(-1) === 'Enter' && !trustAccepted) {
          trustAccepted = true;
        } else if (args.at(-1) === 'Enter' && currentInput) {
          submissionCount += 1;
          stateAtSubmissions.push(
            JSON.parse(readFileSync(join(sessionDir, 'claude-tmux-session.json'), 'utf8')),
          );
          if (currentInput.startsWith('[Pasted text #')) seenPasteMarkers.push(currentInput);
          priorScreen += `❯ ${currentInput}\n`;
          currentInput = '';
          pastePending = false;
          if (options.completeTurns !== false) appendTurn();
        } else if (args.at(-1) === 'C-u') {
          currentInput = '';
          pastePending = false;
        }
        return '';
      }
      return '';
    },
    claudeBin: '/fake/claude',
    pollMs: 1,
    startupTimeoutMs: 100,
    turnTimeoutMs: 100,
  };

  return {
    root,
    cwd,
    sessionDir,
    transcript,
    sessionId,
    launches,
    loadedPrompts,
    sentKeys,
    pastes,
    stateAtSubmissions,
    seenPasteMarkers,
    appendTurn,
    dependencies,
    get submissionCount() {
      return submissionCount;
    },
    get live() {
      return live;
    },
    set live(value: boolean) {
      live = value;
      if (value) {
        trustAccepted = true;
        readyCaptures = 2;
      }
    },
    get trustAccepted() {
      return trustAccepted;
    },
  };
}

function persistActiveTurn(
  fixture: ReturnType<typeof createRuntimeFixture>,
  turnId: string,
  transcriptOffset: number,
): void {
  mkdirSync(fixture.sessionDir, { recursive: true });
  writeFileSync(
    join(fixture.sessionDir, 'claude-tmux-session.json'),
    `${JSON.stringify(
      {
        sessionId: fixture.sessionId,
        transcriptPath: fixture.transcript,
        cwd: fixture.cwd,
        modelRef: 'claude-code/haiku',
        thinking: '',
        activeTurn: { turnId, transcriptPath: fixture.transcript, transcriptOffset },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}
