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

  it('resolves thinking levels according to supported thinking levels of each model', async () => {
    process.env.CLAUDE_TMUX_ENABLED = 'true';
    vi.resetModules();
    const { listAvailableModels, resolveThinkingForModel } = await import(
      '../src/agent/model-catalog.js'
    );
    const models = listAvailableModels({ forceRefresh: true });
    const sonnet = models.find((m) => m.id === 'sonnet')!;
    const opus = models.find((m) => m.id === 'opus')!;
    const haiku = models.find((m) => m.id === 'haiku')!;

    // Sonnet supports low, medium, high, xhigh, max
    expect(resolveThinkingForModel(sonnet, 'high')).toEqual({
      requested: 'high',
      effective: 'high',
      adjusted: false,
    });
    expect(resolveThinkingForModel(sonnet, 'xhigh')).toEqual({
      requested: 'xhigh',
      effective: 'xhigh',
      adjusted: false,
    });
    expect(resolveThinkingForModel(sonnet, 'max')).toEqual({
      requested: 'max',
      effective: 'max',
      adjusted: false,
    });
    // Off and minimal are adjusted up to low
    expect(resolveThinkingForModel(sonnet, 'off')).toEqual({
      requested: 'off',
      effective: 'low',
      adjusted: true,
      reason: 'unsupported_level',
    });
    expect(resolveThinkingForModel(sonnet, 'minimal')).toEqual({
      requested: 'minimal',
      effective: 'low',
      adjusted: true,
      reason: 'unsupported_level',
    });

    // Opus supports low, medium, high, xhigh, max
    expect(resolveThinkingForModel(opus, 'medium')).toEqual({
      requested: 'medium',
      effective: 'medium',
      adjusted: false,
    });
    expect(resolveThinkingForModel(opus, 'off')).toEqual({
      requested: 'off',
      effective: 'low',
      adjusted: true,
      reason: 'unsupported_level',
    });

    // Haiku does not support reasoning
    expect(resolveThinkingForModel(haiku, 'high')).toEqual({
      requested: 'high',
      effective: 'off',
      adjusted: true,
      reason: 'non_reasoning',
    });
    expect(resolveThinkingForModel(haiku, 'off')).toEqual({
      requested: 'off',
      effective: 'off',
      adjusted: false,
    });
  });
});
