import { describe, expect, it } from 'vitest';
import { resolveThinkingForModel, type AvailableModelInfo } from '../src/agent/model-catalog.js';

function model(supportedThinkingLevels: AvailableModelInfo['supportedThinkingLevels']) {
  return {
    ref: 'test/reasoner',
    provider: 'test',
    id: 'reasoner',
    name: 'Reasoner',
    reasoning: true,
    supportsXhigh: Boolean(supportedThinkingLevels?.includes('xhigh')),
    supportedThinkingLevels,
  } satisfies AvailableModelInfo;
}

describe('model thinking resolution', () => {
  it('preserves max when the selected model supports it', () => {
    expect(
      resolveThinkingForModel(
        model(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
        'max',
      ),
    ).toMatchObject({ requested: 'max', effective: 'max', adjusted: false });
  });

  it('uses Pi-compatible nearest-level clamping for extended levels', () => {
    expect(
      resolveThinkingForModel(model(['off', 'minimal', 'low', 'medium', 'high', 'max']), 'xhigh'),
    ).toMatchObject({ requested: 'xhigh', effective: 'max', adjusted: true });
    expect(
      resolveThinkingForModel(model(['off', 'minimal', 'low', 'medium', 'high']), 'max'),
    ).toMatchObject({ requested: 'max', effective: 'high', adjusted: true });
  });
});
