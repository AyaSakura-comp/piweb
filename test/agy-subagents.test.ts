import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshotAgySubagents, watchAgySubagents } from '../src/agent/agy-subagents.js';
import { readSubagents } from '../src/session/subagents.js';

const roots: string[] = [];
const jsonl = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join('\n') + '\n';

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('agy subagent projection', () => {
  it('copies an agy child transcript into channel-owned storage and exposes it in Subagents', async () => {
    const root = mkdtempSync(join(tmpdir(), 'piweb-agy-children-'));
    const brain = mkdtempSync(join(tmpdir(), 'piweb-agy-brain-'));
    roots.push(root, brain);
    const childId = '9867c3a3-0eac-4977-8091-bb445d42e343';
    const transcriptDir = join(brain, childId, '.system_generated', 'logs');
    mkdirSync(transcriptDir, { recursive: true });
    const transcript = join(transcriptDir, 'transcript.jsonl');
    writeFileSync(
      transcript,
      jsonl([
        {
          step_index: 0,
          source: 'USER_EXPLICIT',
          type: 'USER_INPUT',
          status: 'DONE',
          created_at: '2026-09-22T03:33:13Z',
          content: '<USER_REQUEST>\nRun mobile E2E\n</USER_REQUEST>',
        },
        {
          step_index: 1,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: '2026-09-22T03:33:14Z',
          thinking: 'Checking the responsive layout.',
          tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm test' } }],
        },
        {
          step_index: 2,
          source: 'MODEL',
          type: 'GENERIC',
          status: 'DONE',
          created_at: '2026-09-22T03:33:15Z',
          content: '3 tests passed',
        },
        {
          step_index: 3,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: '2026-09-22T03:33:16Z',
          content: 'Mobile E2E passed.',
        },
      ]),
    );

    snapshotAgySubagents(root, 'parent-agy-conversation', [
      {
        type: 'research',
        role: 'Mobile tester',
        task: 'Run mobile E2E',
        conversationId: childId,
        logUri: `file://${transcript}`,
      },
    ]);

    const list = await readSubagents(root, 'owner');
    expect(list.children).toHaveLength(1);
    expect(list.children[0]).toMatchObject({
      name: 'Mobile tester',
      task: 'Run mobile E2E',
      model: 'agy/research',
      state: 'Response complete',
      source: 'agy',
    });

    const detail = await readSubagents(root, 'owner', {
      scope: list.scope,
      child: list.children[0].id,
    });
    expect(detail.events?.map((event) => event.kind)).toEqual([
      'message',
      'thinking',
      'tool',
      'tool_result',
      'message',
    ]);
    expect(detail.events?.at(-1)?.content).toBe('Mobile E2E passed.');
  });

  it('keeps refreshing a launched child until its delayed final response is persisted', async () => {
    const root = mkdtempSync(join(tmpdir(), 'piweb-agy-watch-'));
    const brain = mkdtempSync(join(tmpdir(), 'piweb-agy-watch-brain-'));
    roots.push(root, brain);
    const childId = 'delayed-child';
    const transcriptDir = join(brain, childId, '.system_generated', 'logs');
    mkdirSync(transcriptDir, { recursive: true });
    const transcript = join(transcriptDir, 'transcript.jsonl');
    const initial = {
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      content: '<USER_REQUEST>Run delayed work</USER_REQUEST>',
    };
    writeFileSync(transcript, jsonl([initial]));
    const record = {
      type: 'self',
      role: 'Delayed witness',
      task: 'Run delayed work',
      conversationId: childId,
      logUri: `file://${transcript}`,
    };

    const watching = watchAgySubagents(root, 'parent', [record], {
      intervalMs: 10,
      timeoutMs: 500,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    writeFileSync(
      transcript,
      jsonl([
        initial,
        {
          step_index: 1,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          content: '# Delayed complete\n\nAGY-WATCH-42',
        },
      ]),
    );
    await watching;

    const list = await readSubagents(root, 'owner');
    expect(list.children[0]).toMatchObject({ state: 'Response complete', source: 'agy' });
    const detail = await readSubagents(root, 'owner', {
      scope: list.scope,
      child: list.children[0].id,
    });
    expect(detail.events?.at(-1)?.content).toContain('AGY-WATCH-42');
  });

  it.each(['acknowledgement', 'abort', 'ownership', 'deleted', 'replaced'])(
    'fences watcher lifecycle: %s',
    async (scenario) => {
      const root = mkdtempSync(join(tmpdir(), 'agy-lifecycle-'));
      roots.push(root);
      const channel = join(root, 'channel');
      const logs = join(root, 'child', '.system_generated', 'logs');
      mkdirSync(channel);
      mkdirSync(logs, { recursive: true });
      const source = join(logs, 'transcript.jsonl');
      const ack = {
        step_index: 0,
        type: scenario === 'acknowledgement' ? 'PLANNER_RESPONSE' : 'USER_INPUT',
        status: 'DONE',
        content: 'I will report later.',
      };
      writeFileSync(source, jsonl([ack]));
      const record = {
        type: 'self',
        role: 'witness',
        task: 'test',
        conversationId: 'child',
        logUri: `file://${source}`,
      };
      const controller = new AbortController();
      let owned = true;
      const watching = watchAgySubagents(channel, 'parent', [record], {
        intervalMs: 10,
        timeoutMs: 100,
        signal: controller.signal,
        isCurrent: () => owned,
      });
      const destination = join(channel, '.agy-subagents', 'child', 'session.jsonl');
      const initial = readFileSync(destination, 'utf8');
      if (scenario === 'abort') controller.abort();
      if (scenario === 'ownership') owned = false;
      if (scenario === 'deleted' || scenario === 'replaced') {
        // Retain the old inode elsewhere so replacement cannot reuse it.
        const { renameSync } = await import('node:fs');
        renameSync(channel, join(root, 'retired'));
        if (scenario === 'replaced') mkdirSync(channel);
      }
      writeFileSync(
        source,
        jsonl([
          ack,
          { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'FINAL-RESULT' },
        ]),
      );
      await watching;
      if (scenario === 'acknowledgement')
        expect(readFileSync(destination, 'utf8')).toContain('FINAL-RESULT');
      else if (scenario === 'deleted' || scenario === 'replaced')
        expect(existsSync(destination)).toBe(false);
      else expect(readFileSync(destination, 'utf8')).toBe(initial);
    },
  );

  it('refuses a transcript path whose child directory does not match its conversation id', () => {
    const root = mkdtempSync(join(tmpdir(), 'piweb-agy-children-'));
    const foreign = mkdtempSync(join(tmpdir(), 'piweb-agy-foreign-'));
    roots.push(root, foreign);
    const transcript = join(foreign, 'transcript.jsonl');
    writeFileSync(transcript, '{}\n');

    expect(() =>
      snapshotAgySubagents(root, 'parent', [
        {
          type: 'research',
          role: 'Unsafe',
          task: 'Read arbitrary file',
          conversationId: 'expected-child-id',
          logUri: `file://${transcript}`,
        },
      ]),
    ).toThrow(/transcript path/i);
  });
});
