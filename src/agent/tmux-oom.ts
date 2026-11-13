import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { logger } from '../logger.js';

/**
 * tmux (3.4+, built with systemd) starts every pane in its own user scope,
 * `tmux-spawn-<uuid>.scope`, and systemd's DefaultOOMPolicy=stop ends a whole
 * unit once the kernel's OOM killer has taken any process in it. So when a
 * command Claude Code runs (a llama-server it started, say) is OOM-killed,
 * systemd also stops Claude Code itself and the pane disappears: the worker
 * then fails with "can't find pane: %8" (2026-11-14, the Pi browser session,
 * twice in ten minutes).
 *
 * A runtime drop-in with OOMPolicy=continue makes systemd leave the rest of
 * the scope alone: the killed command fails, Claude Code sees that and goes
 * on. OOMPolicy cannot be changed with `systemctl set-property`, hence the
 * drop-in and a reload of the user manager (~0.2 s, once per new pane).
 */

const DROP_IN = '50-piweb-oom-continue.conf';
const SCOPE = /^tmux-spawn-[0-9a-f-]+\.scope$/;

export interface PaneOomDeps {
  tmux: (args: string[]) => Promise<string>;
  systemctl?: (args: string[]) => Promise<string>;
  /** Defaults to $XDG_RUNTIME_DIR. */
  runtimeDir?: string;
  /** Defaults to /proc. */
  procRoot?: string;
  sleep?: (ms: number) => Promise<void>;
  platform?: NodeJS.Platform;
}

export type PaneOomOutcome = 'protected' | 'already' | 'no-scope' | 'unsupported' | 'failed';

function runSystemctl(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('systemctl', args, { encoding: 'utf8', timeout: 10_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || error.message).trim()));
      else resolve(stdout);
    });
  });
}

/** A process's cgroup v2 path (`/user.slice/…/tmux-spawn-….scope`). */
export function cgroupOf(pid: string, procRoot = '/proc'): string | undefined {
  try {
    const line = readFileSync(join(procRoot, pid, 'cgroup'), 'utf8')
      .split('\n')
      .find((entry) => entry.startsWith('0::'));
    return line?.slice(3).trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The pane's own tmux scope, if its process is in one. A new pane starts in
 * the tmux server's cgroup and is moved a moment later; a server started from
 * inside another pane sits in THAT pane's tmux-spawn scope, so a cgroup the
 * pane shares with `notIn` (the server, this process) is never taken for the
 * pane's own (2026-11-14: a test did, and capped the wrong pane).
 */
export function paneScope(pid: string, procRoot = '/proc', notIn: string[] = []): string | undefined {
  const path = cgroupOf(pid, procRoot);
  if (!path || notIn.includes(path)) return undefined;
  const unit = path.split('/').pop()?.trim();
  return unit && SCOPE.test(unit) ? unit : undefined;
}

/**
 * Keep the pane's scope running when the OOM killer takes one of its
 * processes. Never throws; safe to call at every turn (a scope that already
 * has the policy costs one `systemctl show`).
 */
export async function keepPaneThroughOomKills(pane: string, deps: PaneOomDeps): Promise<PaneOomOutcome> {
  const platform = deps.platform ?? process.platform;
  const runtimeDir = deps.runtimeDir ?? process.env.XDG_RUNTIME_DIR;
  if (platform !== 'linux' || !runtimeDir) return 'unsupported';
  const systemctl = deps.systemctl ?? runSystemctl;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  try {
    const [pid, serverPid] = (await deps.tmux(['display-message', '-p', '-t', pane, '#{pane_pid} #{pid}']))
      .trim()
      .split(/\s+/);
    if (!/^\d+$/.test(pid ?? '') || !/^\d+$/.test(serverPid ?? '')) return 'no-scope';
    const notIn = [cgroupOf(serverPid, deps.procRoot), cgroupOf(String(process.pid), deps.procRoot)].filter(
      (path): path is string => Boolean(path),
    );
    // tmux moves a new pane into its scope a moment after starting it.
    let unit = paneScope(pid, deps.procRoot, notIn);
    for (let tries = 0; !unit && tries < 15; tries++) {
      await sleep(200);
      unit = paneScope(pid, deps.procRoot, notIn);
    }
    if (!unit) return 'no-scope';

    const policy = (await systemctl(['--user', 'show', unit, '-p', 'OOMPolicy', '--value'])).trim();
    if (policy === 'continue') return 'already';

    const unitDir = join(runtimeDir, 'systemd', 'user');
    await removeStaleDropIns(unitDir, systemctl);
    mkdirSync(join(unitDir, `${unit}.d`), { recursive: true });
    writeFileSync(
      join(unitDir, `${unit}.d`, DROP_IN),
      '# piweb: a Claude Code pane outlives an OOM-killed command (src/agent/tmux-oom.ts)\n' +
        '[Scope]\nOOMPolicy=continue\n',
    );
    await systemctl(['--user', 'daemon-reload']);
    const now = (await systemctl(['--user', 'show', unit, '-p', 'OOMPolicy', '--value'])).trim();
    if (now !== 'continue') {
      logger.warn({ pane, unit, policy: now }, 'Claude Code pane scope kept its OOM policy');
      return 'failed';
    }
    logger.info({ pane, unit }, 'Claude Code pane now outlives OOM-killed commands');
    return 'protected';
  } catch (err: any) {
    logger.warn({ pane, err: err?.message }, 'Could not set the Claude Code pane OOM policy');
    return 'failed';
  }
}

/** Our drop-ins for tmux scopes that have since ended. */
async function removeStaleDropIns(unitDir: string, systemctl: (args: string[]) => Promise<string>): Promise<void> {
  if (!existsSync(unitDir)) return;
  for (const entry of readdirSync(unitDir)) {
    if (!entry.endsWith('.d') || !SCOPE.test(entry.slice(0, -2))) continue;
    const file = join(unitDir, entry, DROP_IN);
    if (!existsSync(file)) continue;
    const state = (await systemctl(['--user', 'show', entry.slice(0, -2), '-p', 'ActiveState', '--value']).catch(
      () => '',
    )).trim();
    if (state === 'active' || state === 'activating' || state === 'deactivating') continue;
    try {
      unlinkSync(file);
      rmdirSync(join(unitDir, entry));
    } catch {
      // Another file in the directory, or already gone: leave it.
    }
  }
}
