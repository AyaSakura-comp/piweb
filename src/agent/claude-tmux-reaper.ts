import { execFile } from 'node:child_process';
import { config } from '../config.js';
import { getAllChannels } from '../db.js';
import { logger } from '../logger.js';
import { tmuxSessionName } from './claude-tmux.js';

/**
 * Close the Claude Code TUI of every Piweb session that was deleted (trashed),
 * purged or re-keyed away. The web tier runs in Docker and cannot reach the
 * host's tmux server, so the worker reconciles tmux against SQLite instead.
 *
 * Killing the tmux session only ends the TUI process: Claude's transcript and
 * Piweb's `claude-tmux-session.json` pointer stay, so a session restored from
 * the trash resumes the same Claude conversation on its next turn.
 *
 * Ownership: several Piweb instances (production plus disposable live tests
 * with their own DB) share one tmux server. A `piweb-cc-*` session is ours when
 * its name maps to a channel row in this DB; the reaper then stamps it with
 * `@piweb_owner = <db path>` so it is still recognised after its row is purged.
 * Sessions owned by another DB, or never seen by this one, are left alone.
 */

const PREFIX = 'piweb-cc-';
const OWNER_OPTION = '@piweb_owner';
const REAP_INTERVAL_MS = 60 * 1000;

export interface ReaperDependencies {
  tmux: (args: string[]) => Promise<string>;
  channels: () => Array<{ folder: string; deletedAt?: string }>;
  owner: string;
}

const defaultDependencies = (): ReaperDependencies => ({
  tmux: (args) =>
    new Promise((resolve, reject) => {
      execFile(config.claudeTmuxTmuxBin, args, { timeout: 10_000 }, (err, stdout) =>
        err ? reject(err) : resolve(stdout),
      );
    }),
  channels: getAllChannels,
  owner: config.dbPath,
});

/** One reconciliation pass. Returns the tmux sessions it closed. */
export async function reapOrphanClaudeTmuxSessions(
  deps: ReaperDependencies = defaultDependencies(),
): Promise<string[]> {
  let listing: string;
  try {
    // `#{@option}` expands to the session's user option, or empty when unset.
    listing = await deps.tmux(['list-sessions', '-F', `#{session_name}\t#{${OWNER_OPTION}}`]);
  } catch {
    return []; // No tmux server (or no tmux at all): nothing to clean.
  }
  const sessions = listing
    .split('\n')
    .map((line) => line.split('\t'))
    .filter(([name]) => name?.startsWith(PREFIX));
  if (sessions.length === 0) return [];

  // Read channels after listing tmux: a turn that starts in between belongs to
  // a channel row that already exists, so a fresh session is never mistaken
  // for an orphan.
  const state = new Map<string, 'active' | 'deleted'>();
  for (const channel of deps.channels()) {
    state.set(tmuxSessionName(channel.folder), channel.deletedAt ? 'deleted' : 'active');
  }

  const closed: string[] = [];
  for (const [name, owner = ''] of sessions) {
    const channel = state.get(name);
    if (channel === 'active') {
      if (owner !== deps.owner) {
        await deps
          .tmux(['set-option', '-t', `=${name}:`, OWNER_OPTION, deps.owner])
          .catch(() => undefined);
      }
      continue;
    }
    if (channel !== 'deleted' && owner !== deps.owner) continue;
    try {
      await deps.tmux(['kill-session', '-t', `=${name}`]);
      closed.push(name);
    } catch {
      // Already gone.
    }
  }
  if (closed.length > 0) {
    logger.info({ sessions: closed }, 'Closed Claude Code tmux sessions of deleted Piweb sessions');
  }
  return closed;
}

export function startClaudeTmuxReaper(): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await reapOrphanClaudeTmuxSessions();
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Claude Code tmux reaper failed');
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), REAP_INTERVAL_MS);
  return () => clearInterval(timer);
}
