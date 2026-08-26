import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@earendil-works/pi-coding-agent', () => ({
  AuthStorage: { create: () => ({ reload: vi.fn() }) },
  ModelRegistry: {
    create: () => ({ refresh: vi.fn(), getAvailable: () => [] }),
  },
}));
vi.mock('../src/agent/agy.js', () => ({
  cachedAgyModels: () => [],
  listAgyModels: vi.fn().mockResolvedValue([]),
  convertLocalMediaLinks: (text: string) => text,
}));

const previous = process.env.CLAUDE_TMUX_ENABLED;
afterEach(() => {
  vi.resetModules();
  if (previous === undefined) delete process.env.CLAUDE_TMUX_ENABLED;
  else process.env.CLAUDE_TMUX_ENABLED = previous;
});

describe('model catalog Claude tmux merge', () => {
  it('publishes Claude aliases only when the bridge is enabled', async () => {
    process.env.CLAUDE_TMUX_ENABLED = 'true';
    vi.resetModules();
    const enabled = await import('../src/agent/model-catalog.js');
    expect(enabled.listAvailableModels({ forceRefresh: true }).map((model) => model.ref)).toEqual([
      'claude-code/haiku',
      'claude-code/opus',
      'claude-code/sonnet',
    ]);

    process.env.CLAUDE_TMUX_ENABLED = 'false';
    vi.resetModules();
    const disabled = await import('../src/agent/model-catalog.js');
    expect(disabled.listAvailableModels({ forceRefresh: true })).toEqual([]);
  });
});
