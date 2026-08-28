import {
  MAX_SESSION_TITLE_GRAPHEMES,
  extractSessionTitle,
} from './session-title-ranker.js';

export { MAX_SESSION_TITLE_GRAPHEMES, extractSessionTitle };

const graphemeSegmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });

function graphemes(value: string): string[] {
  return [...graphemeSegmenter.segment(value)].map((part) => part.segment);
}

function cleanTitleCandidate(value: string): string {
  const firstUsefulLine = value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line && !/^```/u.test(line));

  return (firstUsefulLine ?? '')
    .replace(/^(?:title|session title|標題|标题)\s*[:：]\s*/iu, '')
    .replace(/^#+\s*/u, '')
    .replace(/^[`*_"'「『【《〈]+/u, '')
    .replace(/[`*_"'」』】》〉]+$/u, '')
    .replace(/[。.!！?？:：;；,，]+$/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** Normalize a caller-supplied candidate and enforce the visible-character contract. */
export function normalizeSessionTitle(output: string, firstPrompt: string): string {
  const generated = cleanTitleCandidate(output);
  const fallback = cleanTitleCandidate(firstPrompt) || 'New session';
  return graphemes(generated || fallback)
    .slice(0, MAX_SESSION_TITLE_GRAPHEMES)
    .join('');
}

export interface GenerateSessionTitleOptions {
  signal?: AbortSignal;
}

/** Generate an extractive title in-process without a model, network call, or KV state. */
export async function generateSessionTitle(
  firstPrompt: string,
  opts: GenerateSessionTitleOptions = {},
): Promise<string> {
  if (opts.signal?.aborted) throw new Error('Session title generation aborted');
  return extractSessionTitle(firstPrompt);
}
