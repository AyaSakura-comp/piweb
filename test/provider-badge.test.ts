import { describe, expect, it } from 'vitest';
import { modelIdFromRef, providerBadge } from '../src/session/model-info.js';

describe('providerBadge', () => {
  it('splits the Codex variants into Astra/Terra/Sol/Luna by model id', () => {
    expect(providerBadge('openai-codex', 'gpt-6-astra')).toEqual({ label: 'ASTRA', kind: 'astra' });
    expect(providerBadge('openai-codex', 'gpt-5.6-astra')).toEqual({ label: 'ASTRA', kind: 'astra' });
    expect(providerBadge('openai-codex', 'gpt-5.6-terra')).toEqual({ label: 'TERRA', kind: 'terra' });
    expect(providerBadge('openai-codex', 'gpt-5.6-sol')).toEqual({ label: 'SOL', kind: 'sol' });
    expect(providerBadge('openai-codex', 'gpt-5.6-luna')).toEqual({ label: 'LUNA', kind: 'luna' });
  });

  it('matches the codename in a full provider/id ref too', () => {
    expect(providerBadge('openai-codex', 'openai-codex/gpt-6-astra').label).toBe('ASTRA');
    expect(providerBadge('openai-codex', 'openai-codex/gpt-5.6-sol').label).toBe('SOL');
  });

  it('falls back to GPT for an unrecognised codex model', () => {
    expect(providerBadge('openai-codex', 'gpt-5.6')).toEqual({ label: 'GPT', kind: 'gpt' });
    expect(providerBadge('openai-codex')).toEqual({ label: 'GPT', kind: 'gpt' });
  });

  it('leaves other providers unchanged', () => {
    expect(providerBadge('local-llama').label).toBe('LOCAL');
    expect(providerBadge('nvim').label).toBe('NV');
    expect(providerBadge('gemini').label).toBe('GEM');
  });
});

describe('modelIdFromRef', () => {
  it('strips the provider from a ref, and passes a bare id through', () => {
    expect(modelIdFromRef('openai-codex/gpt-5.6-sol')).toBe('gpt-5.6-sol');
    expect(modelIdFromRef('gpt-5.6-sol')).toBe('gpt-5.6-sol');
    expect(modelIdFromRef('')).toBe('');
  });
});
