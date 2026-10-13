import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Pi's current default model ("provider/id" from ~/.pi/agent/settings.json),
 * read fresh (cached by mtime) so a change made while the worker runs — e.g.
 * the switch-qwen-model skill moving between qwen-mtp and Strata — reaches the
 * next run without a restart.
 *
 * A session without a model override must follow this default. Spawning pi
 * with no `--model` is not enough: `--continue` restores the model saved in
 * the session file, so a session last run on a now-stopped local engine would
 * keep calling it (and hang). Passing the default explicitly also makes a warm
 * RPC parent's options differ once the default changes, which retires it and
 * respawns on the new model at the next prompt.
 *
 * Returns undefined when unset or unreadable, leaving pi's own resolution in
 * charge as before. Kept free of the model catalog on purpose: invoke.ts and
 * rpc-session.ts import this, and the catalog starts an agy listing on load.
 */
let cached: { path: string; mtimeMs: number; ref: string | undefined } | undefined;

function settingsPath(): string {
  const dir = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent');
  return join(dir, 'settings.json');
}

export function piDefaultModelRef(): string | undefined {
  const path = settingsPath();
  try {
    const { mtimeMs } = statSync(path);
    if (cached && cached.path === path && cached.mtimeMs === mtimeMs) return cached.ref;
    const settings = JSON.parse(readFileSync(path, 'utf8'));
    const provider = typeof settings.defaultProvider === 'string' ? settings.defaultProvider.trim() : '';
    const model = typeof settings.defaultModel === 'string' ? settings.defaultModel.trim() : '';
    const ref = provider && model ? `${provider}/${model}` : undefined;
    cached = { path, mtimeMs, ref };
    return ref;
  } catch {
    return undefined;
  }
}
