import { afterEach, describe, expect, it, vi } from 'vitest';

const { liveStatsMock, coldStatusMock } = vi.hoisted(() => ({
  liveStatsMock: vi.fn(),
  coldStatusMock: vi.fn(),
}));

vi.mock('../src/agent/rpc-session.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/agent/rpc-session.js')>()),
  getRpcSessionStats: liveStatsMock,
}));

vi.mock('../src/agent/invoke.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/agent/invoke.js')>()),
  getChannelSessionStatus: coldStatusMock,
}));

vi.mock('../src/agent/channel-settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/agent/channel-settings.js')>()),
  computeEffectiveChannelSettings: vi.fn(async () => ({
    rawModelRef: 'openai-codex/gpt-5.6-sol',
    displayModel: 'openai-codex/gpt-5.6-sol',
    modelInfo: { reasoning: true },
    modelSource: 'override',
    requestedThinking: 'medium',
    effectiveThinking: 'medium',
    hasManagedThinking: true,
    thinkingSource: 'override',
    thinkingAdjusted: false,
    effectiveCwd: '/home/chihmin',
    cwdSource: 'default',
  })),
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

describe('/pi status with a warm RPC session', () => {
  it('shows context usage from the live owner instead of a fresh metadata probe', async () => {
    coldStatusMock.mockResolvedValue({
      createdAt: '2026-09-19T03:59:07.000Z',
      statsSource: 'rpc',
      tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
      contextUsage: { tokens: 427_779, contextWindow: 260_000, percent: 164.5 },
    });
    liveStatsMock.mockResolvedValue({
      tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
      contextUsage: { tokens: 427_779, contextWindow: 1_050_000, percent: 40.7 },
    });
    const { runCommand } = await import('../src/commands/index.js');

    const result = await runCommand(channel(), 'pi status');

    expect(result.ok).toBe(true);
    expect(result.text).toContain('427,779 / 1,050,000 (40.7%)');
    expect(result.text).not.toContain('427,779 / 260,000');
  });
});

function channel() {
  return {
    jid: 'web:status',
    name: 'status test',
    folder: 'web_status',
    requiresTrigger: false,
    isMain: false,
    modelOverride: 'openai-codex/gpt-5.6-sol',
    thinkingOverride: 'medium',
    cwdOverride: '',
  } as any;
}
