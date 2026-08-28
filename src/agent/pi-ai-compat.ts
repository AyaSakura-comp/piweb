import * as PiAI from '@earendil-works/pi-ai';
import type { Model } from '@earendil-works/pi-ai';

export type PiAiThinkingExports = {
  getSupportedThinkingLevels?: (model: Model<any>) => readonly string[];
  supportsXhigh?: (model: Model<any>) => boolean;
};

const piAiThinking = PiAI as unknown as PiAiThinkingExports;
const BASE_LEVELS = ['off', 'minimal', 'low', 'medium', 'high'] as const;

/** Return Pi's complete capability list, including newer levels such as max. */
export function getModelSupportedThinkingLevels(
  model: Model<any>,
  piAi: PiAiThinkingExports = piAiThinking,
): readonly string[] {
  if (typeof piAi.getSupportedThinkingLevels === 'function') {
    return piAi.getSupportedThinkingLevels(model);
  }

  if (typeof piAi.supportsXhigh === 'function' && piAi.supportsXhigh(model)) {
    return [...BASE_LEVELS, 'xhigh'];
  }

  return BASE_LEVELS;
}

export function supportsModelXhigh(
  model: Model<any>,
  piAi: PiAiThinkingExports = piAiThinking,
): boolean {
  return getModelSupportedThinkingLevels(model, piAi).includes('xhigh');
}
