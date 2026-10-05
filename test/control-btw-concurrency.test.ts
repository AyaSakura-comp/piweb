import { afterEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => {
  let release!: (value: unknown) => void;
  const sideAnswer = new Promise((resolve) => {
    release = resolve;
  });
  const channel = {
    jid: 'web:a',
    folder: 'web_a',
    kind: 'standard',
    storageToken: 't',
    ownershipEpoch: 1,
  };
  const rows = [
    {
      rowid: 1,
      channel_jid: 'web:a',
      command: 'btw:web',
      args: JSON.stringify({ generation: 'web_a', action: 'send', text: 'slow' }),
    },
    { rowid: 2, channel_jid: 'web:b', command: 'pi status', args: '{}' },
  ];
  let claimed = false;
  return {
    release: (value: unknown) => release(value),
    sideAnswer,
    channel,
    rows,
    claim: () => (claimed ? [] : ((claimed = true), rows)),
    finishControl: vi.fn(),
  };
});

vi.mock('../src/db.js', () => ({
  appendWebEvent: vi.fn(),
  claimPendingControls: vi.fn(() => m.claim()),
  failSettledControl: vi.fn(),
  finishControl: m.finishControl,
  getChannel: vi.fn(() => m.channel),
  recoverStuckControls: vi.fn(() => 0),
  touchControlProcessing: vi.fn((rowid: number) => m.rows.find((row) => row.rowid === rowid)),
}));
vi.mock('../src/commands/index.js', () => ({
  runCommand: vi.fn(async () => ({ ok: true, text: 'status ok' })),
}));
vi.mock('../src/agent/rpc-session.js', () => ({
  activeRpcSessionForBtw: vi.fn(() => ({ btw: () => m.sideAnswer })),
  prepareRpcSession: vi.fn(),
}));
vi.mock('../src/agent/channel-settings.js', () => ({
  computeEffectiveChannelSettings: vi.fn(async () => ({ rawModelRef: '' })),
}));
vi.mock('../src/agent/agy.js', () => ({ isAgyModelRef: () => false }));
vi.mock('../src/agent/claude-tmux.js', () => ({ isClaudeTmuxModelRef: () => false }));
vi.mock('../src/config.js', () => ({ config: { rpcSteer: true } }));
vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

afterEach(async () => {
  const { stopControlLoop } = await import('../src/worker/control.js');
  await stopControlLoop();
});

it('a running BTW side answer does not hold later controls in the queue', async () => {
  const { startControlLoop, stopControlLoop } = await import('../src/worker/control.js');
  startControlLoop();
  // /pi status (row 2) finishes while the BTW send (row 1) is still running.
  await expect.poll(() => m.finishControl.mock.calls.map((call) => call[0])).toEqual([2]);
  m.release({ ok: true, messages: [{ role: 'assistant', content: 'done' }] });
  await expect.poll(() => m.finishControl.mock.calls.map((call) => call[0])).toEqual([2, 1]);
  expect(JSON.parse(m.finishControl.mock.calls[1][2])).toEqual({
    messages: [{ role: 'assistant', content: 'done' }],
    pending: [],
  });
  await stopControlLoop();
});
