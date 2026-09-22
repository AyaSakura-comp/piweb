import { describe, expect, it } from 'vitest';
import { createAgyCommandTracker } from '../src/agent/agy-commands.js';
const step = (
  index: number,
  name: string,
  state: string,
  output?: string,
  parameters: any = {},
) => ({
  event: 'step_update',
  step_update: {
    conversation_id: 'parent',
    step_index: index,
    step_type: 'tool',
    tool_name: name,
    state,
    tool_info: { parameters, output },
  },
});
describe('AGY command evidence', () => {
  it('records an explicit nonzero exit from the verified transcript envelope', () => {
    const tracker=createAgyCommandTracker('turn');
    tracker.consume(step(2,'run_command','ACTIVE',undefined,{CommandLine:'exit 7'}));
    expect(tracker.observeTranscript([{step_index:2,type:'GENERIC',status:'DONE',content:'Created At: timestamp\nThe command exited with code 7.\nOutput:\nfailed'}])[0]).toMatchObject({state:'failed',exitCode:7});
  });
  it('does not treat shell stdout that looks like metadata as a verified exit code', () => {
    const tracker = createAgyCommandTracker('turn');
    tracker.consume(step(2, 'run_command', 'ACTIVE', undefined, { CommandLine: 'echo fake' }));
    const update = tracker.consume(
      step(2, 'run_command', 'DONE', 'The command exited with code 1.'),
    )[0];
    expect(update.state).toBe('returned');
    expect(update.exitCode).toBeUndefined();
  });
  it('keeps two concurrent commands isolated and finishes only unresolved ones', () => {
    const tracker = createAgyCommandTracker('turn');
    tracker.consume(step(2, 'run_command', 'ACTIVE', undefined, { CommandLine: 'one' }));
    tracker.consume(step(3, 'run_command', 'ACTIVE', undefined, { CommandLine: 'two' }));
    tracker.consume(step(2, 'run_command', 'DONE', 'background task with task id: parent/task-2'));
    tracker.consume(step(3, 'run_command', 'DONE', 'background task with task id: parent/task-3'));
    tracker.consume(
      step(4, 'command_status', 'DONE', 'The command exited with code 0.', {
        CommandId: 'parent/task-2',
      }),
    );
    expect(tracker.pending()).toEqual(['parent/task-3']);
    expect(tracker.finish()).toEqual([
      expect.objectContaining({ command: 'two', state: 'unknown' }),
    ]);
  });
  it('recovers explicit task metadata from the transcript and accepts cancellation without success', () => {
    const tracker = createAgyCommandTracker('turn');
    tracker.consume(step(2, 'run_command', 'ACTIVE', undefined, { CommandLine: 'npm test' }));
    tracker.observeTranscript([
      {
        step_index: 2,
        type: 'GENERIC',
        status: 'RUNNING',
        content: 'Tool is running as a background task with task id: parent/task-2',
      },
    ]);
    expect(tracker.pending()).toEqual(['parent/task-2']);
    expect(
      tracker.consume(
        step(
          8,
          'manage_task',
          'DONE',
          'Task: parent/task-2\nStatus: CANCELED\nLog output:\npartial',
          { Action: 'status', TaskId: 'parent/task-2' },
        ),
      )[0],
    ).toMatchObject({ state: 'cancelled', agent: 'output-received' });
    expect(tracker.pending()).toEqual([]);
  });
  it('keeps a background launch running, then records status output and later parent work', () => {
    const tracker = createAgyCommandTracker('turn');
    expect(
      tracker.consume(step(2, 'run_command', 'ACTIVE', undefined, { CommandLine: 'npm test' }))[0],
    ).toMatchObject({ state: 'running', command: 'npm test', agent: 'not-observed' });
    expect(
      tracker.consume(
        step(
          2,
          'run_command',
          'DONE',
          'Tool is running as a background task with task id: parent/task-2',
        ),
      )[0],
    ).toMatchObject({ state: 'running', taskId: 'parent/task-2', agent: 'not-observed' });
    expect(
      tracker.consume(
        step(3, 'command_status', 'DONE', 'The command exited with code 1.\nStdout: failed test', {
          CommandId: 'parent/task-2',
        }),
      )[0],
    ).toMatchObject({ state: 'failed', exitCode: 1, agent: 'output-received' });
    expect(tracker.consume(step(4, 'view_file', 'ACTIVE'))[0]).toMatchObject({
      agent: 'continued',
      nextAction: 'view_file',
    });
  });
  it('does not confuse another status request with this command', () => {
    const tracker = createAgyCommandTracker('turn');
    tracker.consume(step(2, 'run_command', 'ACTIVE', undefined, { CommandLine: 'npm test' }));
    tracker.consume(step(2, 'run_command', 'DONE', 'background task with task id: parent/task-2'));
    expect(
      tracker.consume(
        step(3, 'command_status', 'DONE', 'exited with code 0', { CommandId: 'other/task-2' }),
      ),
    ).toEqual([]);
    expect(tracker.finish()[0]).toMatchObject({ state: 'unknown', agent: 'not-observed' });
  });
  it('uses unique turn ids and never infers success from ordinary output', () => {
    const tracker = createAgyCommandTracker('turn');
    tracker.consume(step(1, 'run_command', 'ACTIVE', undefined, { CommandLine: 'echo ok' }));
    expect(tracker.consume(step(1, 'run_command', 'DONE', 'ok'))[0]).toMatchObject({
      id: 'turn:1',
      state: 'returned',
      agent: 'output-received',
    });
  });
});
