import { describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createClaudeCommandTracker,
  extractTaskNotificationXml,
  findTaskOutputFile,
  readOutputTail,
} from '../src/agent/claude-commands.js';

describe('Claude command tracker', () => {
  it('extracts task notification XML from various record shapes', () => {
    const xml = '<task-notification><task-id>task-1</task-id><status>completed</status></task-notification>';

    // 1. Direct message.content string
    expect(extractTaskNotificationXml({ message: { content: xml } })).toBe(xml);

    // 2. Array of message.content blocks
    expect(extractTaskNotificationXml({ message: { content: [{ type: 'text', text: xml }] } })).toBe(xml);

    // 3. Direct record.content string (queue-operation)
    expect(extractTaskNotificationXml({ type: 'queue-operation', content: xml })).toBe(xml);

    // 4. Attachment prompt
    expect(extractTaskNotificationXml({ type: 'attachment', attachment: { prompt: xml } })).toBe(xml);

    // 5. Rendered array
    expect(extractTaskNotificationXml({ type: 'attachment', rendered: [{ content: xml }] })).toBe(xml);

    // 6. Non-matching record
    expect(extractTaskNotificationXml({ message: { content: 'hello world' } })).toBeNull();
  });

  it('reads output tail with byte capping', () => {
    const testDir = join(tmpdir(), `piweb-cmd-tail-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    try {
      const file = join(testDir, 'sample.output');
      writeFileSync(file, 'line 1\nline 2\nline 3\n');
      expect(readOutputTail(file)).toBe('line 1\nline 2\nline 3\n');

      // Test tail capping with small maxBytes
      expect(readOutputTail(file, 7)).toBe('line 3\n');

      // Non-existent file returns empty
      expect(readOutputTail(join(testDir, 'nonexistent.output'))).toBe('');
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('tracks Bash background tasks with initial tool result and subsequent output polling', () => {
    const sessionId = `test-sess-${Date.now()}`;
    const testDir = join(tmpdir(), `piweb-cmd-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });

    try {
      const tracker = createClaudeCommandTracker(sessionId, { cwd: testDir });

      // 1. Assistant calls Bash with run_in_background
      const assistantCall = {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_bash_1',
              name: 'Bash',
              input: {
                command: 'node worker.js',
                run_in_background: true,
                timeout_ms: 60000,
              },
            },
          ],
        },
      };
      expect(tracker.observe(assistantCall)).toEqual([]);

      // 2. User tool result acknowledges background task
      const outputFile = join(testDir, 'bg_task_1.output');
      writeFileSync(outputFile, 'worker started...\n');

      const userResult = {
        type: 'user',
        toolUseResult: {
          backgroundTaskId: 'bg_task_1',
        },
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_bash_1',
              content: `Command running in background with ID: bg_task_1. Output is being written to: ${outputFile}.`,
            },
          ],
        },
      };

      const launchUpdates = tracker.observe(userResult);
      expect(launchUpdates).toHaveLength(1);
      expect(launchUpdates[0]).toMatchObject({
        id: 'bg_task_1',
        taskId: 'bg_task_1',
        command: 'node worker.js',
        state: 'running',
        agent: 'output-received',
        role: 'claude-command',
        output: 'worker started...\n',
        timeoutMs: 60000,
      });

      // 3. Output file grows -> pollActiveOutputs detects it
      writeFileSync(outputFile, 'worker started...\ncheckpoint 1 reached\n');
      const polled = tracker.pollActiveOutputs();
      expect(polled).toHaveLength(1);
      expect(polled[0].output).toBe('worker started...\ncheckpoint 1 reached\n');

      // 4. Assistant continues dialogue -> agent state becomes 'continued'
      const followUp = {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'I will monitor the worker.' }],
        },
      };
      const contUpdates = tracker.observe(followUp);
      expect(contUpdates).toHaveLength(1);
      expect(contUpdates[0].agent).toBe('continued');
      expect(contUpdates[0].nextAction).toBe('assistant response');

      // 5. Task completion notification arrives with exit code 0
      const completeNotification = {
        type: 'user',
        origin: { kind: 'task-notification' },
        message: {
          role: 'user',
          content: `<task-notification>
<task-id>bg_task_1</task-id>
<output-file>${outputFile}</output-file>
<status>completed</status>
<summary>Background command "node worker.js" completed (exit code 0)</summary>
</task-notification>`,
        },
      };
      writeFileSync(outputFile, 'worker started...\ncheckpoint 1 reached\nDONE\n');
      const finishedUpdates = tracker.observe(completeNotification);
      expect(finishedUpdates).toHaveLength(1);
      expect(finishedUpdates[0]).toMatchObject({
        id: 'bg_task_1',
        state: 'succeeded',
        exitCode: 0,
        output: 'worker started...\ncheckpoint 1 reached\nDONE\n',
      });
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('tracks Monitor tasks with streaming checkpoint events and non-zero exit failure', () => {
    const sessionId = `test-mon-${Date.now()}`;
    const tracker = createClaudeCommandTracker(sessionId);

    // 1. Assistant calls Monitor
    tracker.observe({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_mon_1',
            name: 'Monitor',
            input: {
              description: 'operator E2E rerun checkpoints',
              command: 'watch progress',
              timeout_ms: 1800000,
            },
          },
        ],
      },
    });

    // 2. User returns Monitor started
    const startUpdates = tracker.observe({
      type: 'user',
      toolUseResult: { taskId: 'mon_abc_1', timeoutMs: 1800000 },
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_mon_1',
            content: 'Monitor started (task mon_abc_1, expires in 30m unless the source ends first)',
          },
        ],
      },
    });
    expect(startUpdates).toHaveLength(1);
    expect(startUpdates[0]).toMatchObject({
      id: 'mon_abc_1',
      command: 'operator E2E rerun checkpoints',
      state: 'running',
      role: 'claude-command',
      timeoutMs: 1800000,
    });

    // 3. Interim checkpoint notification arrives
    const checkpoint = tracker.observe({
      type: 'user',
      message: {
        role: 'user',
        content: `<task-notification>
<task-id>mon_abc_1</task-id>
<summary>Monitor event: "operator E2E rerun checkpoints"</summary>
<event>dir evo-operator-live-77482350
checks: empty-conversation</event>
</task-notification>`,
      },
    });
    expect(checkpoint).toHaveLength(1);
    expect(checkpoint[0].state).toBe('running');
    expect(checkpoint[0].output).toContain('dir evo-operator-live-77482350');

    // 4. Failure completion notification arrives (exit code 1)
    const failNotification = tracker.observe({
      type: 'user',
      message: {
        role: 'user',
        content: `<task-notification>
<task-id>mon_abc_1</task-id>
<status>completed</status>
<summary>Monitor "operator E2E rerun checkpoints" completed (exit code 1)</summary>
<event>Error: test failed</event>
</task-notification>`,
      },
    });
    expect(failNotification).toHaveLength(1);
    expect(failNotification[0].state).toBe('failed');
    expect(failNotification[0].exitCode).toBe(1);
  });

  it('marks running tasks as unknown when finished / shut down', () => {
    const sessionId = `test-finish-${Date.now()}`;
    const tracker = createClaudeCommandTracker(sessionId);

    tracker.observe({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'sleep 100' } }],
      },
    });
    tracker.observe({
      type: 'user',
      toolUseResult: { backgroundTaskId: 'bg_orphan' },
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Command running in background with ID: bg_orphan' }],
      },
    });

    expect(tracker.getCommands()[0].state).toBe('running');
    const ended = tracker.finish();
    expect(ended).toHaveLength(1);
    expect(ended[0].state).toBe('unknown');
  });
});
