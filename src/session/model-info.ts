/**
 * Which model a session is actually running.
 *
 * The channel row only holds the *override*, which is empty for a session
 * following the gateway default — and, worse, an override that has been reset
 * does not necessarily take effect (pi resumes with `--continue`, so the model
 * recorded in the session file wins until the session is rotated).
 *
 * pi's own session JSONL records a `model_change` line carrying provider and
 * modelId, so reading that back is the only way to report what is genuinely in
 * use rather than what was requested.
 *
 * Session files reach megabytes, so this never reads one whole: the first
 * model_change sits near the top (right after the session header) and any later
 * one is near the end, so a head slice and a tail slice cover both.
 */

import { openSync, readSync, closeSync, statSync } from 'node:fs';
import { resolveLatestChannelSessionFile } from './path.js';

const HEAD_BYTES = 8 * 1024;
const TAIL_BYTES = 256 * 1024;

export interface SessionModel {
  provider: string;
  modelId: string;
}

function readSlice(file: string, start: number, length: number): string {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const read = readSync(fd, buf, 0, length, start);
    return buf.subarray(0, read).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function lastModelChange(text: string): SessionModel | undefined {
  let found: SessionModel | undefined;
  for (const line of text.split('\n')) {
    // Cheap reject before parsing: most lines are messages.
    if (!line.includes('"model_change"')) continue;
    try {
      const event = JSON.parse(line);
      if (event?.type === 'model_change' && event.provider) {
        found = { provider: String(event.provider), modelId: String(event.modelId ?? '') };
      }
    } catch {
      // A truncated line at a slice boundary — skip it.
    }
  }
  return found;
}

export function getSessionModel(folder: string): SessionModel | undefined {
  try {
    const file = resolveLatestChannelSessionFile(folder);
    if (!file) return undefined;

    const size = statSync(file).size;
    if (size <= HEAD_BYTES + TAIL_BYTES) {
      return lastModelChange(readSlice(file, 0, size));
    }

    // Later changes win, so check the tail first and fall back to the head.
    return (
      lastModelChange(readSlice(file, size - TAIL_BYTES, TAIL_BYTES)) ??
      lastModelChange(readSlice(file, 0, HEAD_BYTES))
    );
  } catch {
    return undefined;
  }
}

/**
 * Provider implied by a model reference (`provider/id`).
 *
 * Used when a session has no pi session file yet — freshly created, or rotated
 * by /pi new and not yet messaged. Reporting the configured override is more
 * honest than showing nothing, which reads as "broken" rather than "not
 * started".
 */
export function providerFromRef(ref: string): string {
  const slash = ref.indexOf('/');
  return slash > 0 ? ref.slice(0, slash) : '';
}

/** The bare model id from a `provider/id` ref, for comparing against a session file's modelId. */
export function modelIdFromRef(ref: string): string {
  const slash = ref.indexOf('/');
  return slash > 0 ? ref.slice(slash + 1) : ref;
}

/**
 * Short badge for a provider. Deliberately a small fixed set: an unknown
 * provider gets a truncated form rather than being hidden, so a new backend
 * shows up as something rather than silently vanishing.
 */
export function providerBadge(provider: string, modelId = ''): { label: string; kind: string } {
  switch (provider) {
    case 'nvim':
      return { label: 'NV', kind: 'nv' };
    case 'openai-codex': {
      // The Codex GPT-5.6 line ships as three variants (Terra/Sol/Luna); show
      // which one rather than a flat "GPT" so they're distinguishable at a
      // glance. modelId is the running id (e.g. "gpt-5.6-terra") or a ref like
      // "openai-codex/gpt-5.6-sol" — match on the codename either way.
      const id = modelId.toLowerCase();
      if (id.includes('astra')) return { label: 'ASTRA', kind: 'astra' };
      if (id.includes('terra')) return { label: 'TERRA', kind: 'terra' };
      if (id.includes('sol')) return { label: 'SOL', kind: 'sol' };
      if (id.includes('luna')) return { label: 'LUNA', kind: 'luna' };
      return { label: 'GPT', kind: 'gpt' };
    }
    case 'local-llama':
    case 'ollama-gemma':
    case 'ollama-lfm2':
    case 'ds4':
      return { label: 'LOCAL', kind: 'local' };
    case 'gemini':
      return { label: 'GEM', kind: 'gem' };
    case 'xai':
      return { label: 'XAI', kind: 'xai' };
    case 'openrouter':
      return { label: 'OR', kind: 'or' };
    case 'sakana':
      return { label: 'SAK', kind: 'sak' };
    default:
      return { label: provider.slice(0, 5).toUpperCase(), kind: 'other' };
  }
}
