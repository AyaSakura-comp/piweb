import { describe, expect, it, vi } from 'vitest';

const { abortChannelTaskMock, stopChannelTaskMock } = vi.hoisted(() => ({
  abortChannelTaskMock: vi.fn(() => {
    throw new Error('legacy stop path used');
  }),
  stopChannelTaskMock: vi.fn(() => ({
    aborted: true,
    cleared: 0,
    preservedSession: true,
  })),
}));

vi.mock('../src/agent/queue.js', () => ({
  abortChannelTask: abortChannelTaskMock,
  isChannelProcessing: vi.fn(() => true),
  stopChannelTask: stopChannelTaskMock,
}));

describe('pi stop command', () => {
  it('uses the session-preserving stop path', async () => {
    const { runCommand } = await import('../src/commands/index.js');
    const channel = {
      jid: 'web:stop-command',
      name: 'stop command',
      folder: 'web_stop_command',
      requiresTrigger: false,
      isMain: false,
      modelOverride: '',
      thinkingOverride: '',
      cwdOverride: '',
    } as const;

    const result = await runCommand(channel, 'pi stop');

    expect(stopChannelTaskMock).toHaveBeenCalledWith(channel.jid);
    expect(abortChannelTaskMock).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, text: 'Aborted the current task.' });
  });
});
