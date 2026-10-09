import { afterEach, expect, it, vi } from 'vitest';
const ids = ['gpt-5.3-codex-spark', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.5', 'gpt-5.6-astra', 'gpt-6.1-sol'];
vi.mock('@earendil-works/pi-coding-agent', () => ({
  ModelRuntime: { create: async () => ({}) },
  ModelRegistry: class {
    getAvailable() { return ids.map(id => ({provider: 'openai-codex', id, name: id, reasoning: false})); }
  },
}));
vi.mock('../src/agent/agy.js', () => ({ cachedAgyModels: () => [], listAgyModels: async () => [] }));
const previous = process.env.PIWEB_HIDDEN_MODELS;
afterEach(() => { vi.resetModules(); if (previous === undefined) delete process.env.PIWEB_HIDDEN_MODELS; else process.env.PIWEB_HIDDEN_MODELS = previous; });
it('excludes only configured exact model refs from the published picker catalog', async () => {
  process.env.PIWEB_HIDDEN_MODELS = ids.slice(0,5).map(id => `openai-codex/${id}`).join(',');
  const catalog = await import('../src/agent/model-catalog.js');
  await catalog.primeModelRegistry();
  expect(catalog.listAvailableModels({forceRefresh: true}).filter(m=>m.provider==='openai-codex').map(m=>m.id)).toEqual(['gpt-6.1-sol']);
});
