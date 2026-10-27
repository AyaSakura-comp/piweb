import { afterEach, expect, it, vi } from 'vitest';

// btw:web picks the side-question backend by the session's harness: pi-btw in
// the Pi RPC, Claude Code's own /btw for claude-code/*, none for AGY.
const m = vi.hoisted(() => {
  const models: Record<string, string> = {
    web_pi: '',
    web_claude: 'claude-code/opus',
    web_agy: 'agy/gemini-3-pro',
  };
  const channels = Object.keys(models).map((folder) => ({
    jid: folder.replace('_', ':'),
    folder,
    kind: 'standard',
    storageToken: 't',
    ownershipEpoch: 1,
  }));
  const rows = channels.map((channel, i) => ({
    rowid: i + 1,
    channel_jid: channel.jid,
    command: 'btw:web',
    args: JSON.stringify({ generation: channel.folder, action: 'send', text: `hi ${channel.folder}` }),
  }));
  let claimed = false;
  return {
    models,
    channels,
    rows,
    claim: () => (claimed ? [] : ((claimed = true), rows)),
    finishControl: vi.fn(),
    piBtw: vi.fn(async () => ({ messages: [{ role: 'assistant', content: 'pi side' }] })),
    claudeBtw: vi.fn(async () => ({
      messages: [{ role: 'assistant', content: 'claude side' }],
      pending: [],
      streaming: [],
    })),
  };
});

vi.mock('../src/db.js', () => ({
  appendWebEvent: vi.fn(),
  claimPendingControls: vi.fn(() => m.claim()),
  failSettledControl: vi.fn(),
  finishControl: m.finishControl,
  getChannel: vi.fn((jid: string) => m.channels.find((channel) => channel.jid === jid)),
  recoverStuckControls: vi.fn(() => 0),
  touchControlProcessing: vi.fn((rowid: number) => m.rows.find((row) => row.rowid === rowid)),
}));
vi.mock('../src/commands/index.js', () => ({ runCommand: vi.fn() }));
vi.mock('../src/agent/rpc-session.js', () => ({
  activeRpcSessionForBtw: vi.fn(() => ({ btw: m.piBtw })),
  prepareRpcSession: vi.fn(),
}));
vi.mock('../src/agent/channel-settings.js', () => ({
  computeEffectiveChannelSettings: vi.fn(async (channel: { folder: string }) => ({
    rawModelRef: m.models[channel.folder],
    hasManagedThinking: true,
    effectiveThinking: 'high',
    effectiveCwd: '/work',
  })),
}));
vi.mock('../src/agent/agy.js', () => ({ isAgyModelRef: (ref: string) => ref.startsWith('agy/') }));
vi.mock('../src/agent/claude-tmux.js', () => ({
  isClaudeTmuxModelRef: (ref: string) => ref.startsWith('claude-code/'),
}));
vi.mock('../src/agent/claude-btw.js', () => ({ claudeBtw: m.claudeBtw }));
vi.mock('../src/config.js', () => ({ config: { rpcSteer: true, claudeTmuxEnabled: true } }));
vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

afterEach(async () => {
  const { stopControlLoop } = await import('../src/worker/control.js');
  await stopControlLoop();
});

it('routes BTW to pi-btw, to Claude Code’s /btw, or refuses it for AGY', async () => {
  const { startControlLoop } = await import('../src/worker/control.js');
  startControlLoop();
  await expect.poll(() => m.finishControl.mock.calls.length).toBe(3);
  const finished = Object.fromEntries(
    m.finishControl.mock.calls.map(([rowid, ok, text]) => [m.rows[rowid - 1].channel_jid, { ok, text }]),
  );

  expect(m.piBtw).toHaveBeenCalledExactlyOnceWith('send', 'hi web_pi');
  expect(JSON.parse(finished['web:pi'].text).messages[0].content).toBe('pi side');

  expect(m.claudeBtw).toHaveBeenCalledExactlyOnceWith('web_claude', 'send', 'hi web_claude', {
    modelRef: 'claude-code/opus',
    thinking: 'high',
    cwd: '/work',
  });
  expect(finished['web:claude'].ok).toBe(true);
  expect(JSON.parse(finished['web:claude'].text)).toEqual({
    messages: [{ role: 'assistant', content: 'claude side' }],
    pending: [],
    streaming: [],
  });

  expect(finished['web:agy']).toEqual({ ok: false, text: 'BTW is not available with AGY' });
});
