import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { keepPaneThroughOomKills, paneScope } from '../src/agent/tmux-oom.js';
import { describeBridgeFailure } from '../src/agent/claude-tmux.js';

// 2026-11-14: a llama-server the Pi browser session started was OOM-killed;
// systemd (DefaultOOMPolicy=stop) then stopped the pane's whole tmux scope,
// Claude Code included, and the turn failed with "can't find pane: %8".

const SCOPE = 'tmux-spawn-5b32f93e-0f51-438b-8779-8f234d6738e0.scope';
const OLD = 'tmux-spawn-601e3e54-e446-47e5-87d2-620aa7eb0d43.scope';
let root = '';

function setCgroup(pid: string, unit: string) {
  mkdirSync(join(root, 'proc', pid), { recursive: true });
  writeFileSync(join(root, 'proc', pid, 'cgroup'), `0::/user.slice/user-1000.slice/user@1000.service/app.slice/${unit}\n`);
}

function fakeSystemd(initial: Record<string, { policy: string; state: string }>) {
  const units = { ...initial };
  const calls: string[][] = [];
  const systemctl = async (args: string[]) => {
    calls.push(args);
    if (args[1] === 'daemon-reload') {
      for (const [unit, info] of Object.entries(units)) {
        const file = join(root, 'run', 'systemd', 'user', `${unit}.d`, '50-piweb-oom-continue.conf');
        if (existsSync(file) && /OOMPolicy=continue/.test(readFileSync(file, 'utf8'))) info.policy = 'continue';
      }
      return '';
    }
    const unit = units[args[2]];
    if (args[4] === 'OOMPolicy') return `${unit?.policy ?? 'stop'}\n`;
    if (args[4] === 'ActiveState') return `${unit?.state ?? 'inactive'}\n`;
    return '';
  };
  return { units, calls, systemctl };
}

// tmux answers '#{pane_pid} #{pid}': the pane's process, then the server's.
const deps = (systemctl: (args: string[]) => Promise<string>, extra: object = {}) => ({
  tmux: async () => '4242 100\n',
  systemctl,
  runtimeDir: join(root, 'run'),
  procRoot: join(root, 'proc'),
  sleep: async () => undefined,
  platform: 'linux' as const,
  ...extra,
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tmux-oom-'));
  setCgroup('100', 'claude-discord.service'); // the tmux server
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('keepPaneThroughOomKills', () => {
  it('gives a tmux pane scope OOMPolicy=continue with a runtime drop-in', async () => {
    setCgroup('4242', SCOPE);
    const sd = fakeSystemd({ [SCOPE]: { policy: 'stop', state: 'active' } });
    expect(await keepPaneThroughOomKills('%13', deps(sd.systemctl))).toBe('protected');
    const file = join(root, 'run', 'systemd', 'user', `${SCOPE}.d`, '50-piweb-oom-continue.conf');
    expect(readFileSync(file, 'utf8')).toMatch(/^\[Scope\]\nOOMPolicy=continue$/m);
    expect(sd.calls.filter((c) => c[1] === 'daemon-reload')).toHaveLength(1);
  });

  it('does nothing more for a scope that already continues', async () => {
    setCgroup('4242', SCOPE);
    const sd = fakeSystemd({ [SCOPE]: { policy: 'continue', state: 'active' } });
    expect(await keepPaneThroughOomKills('%13', deps(sd.systemctl))).toBe('already');
    expect(sd.calls.filter((c) => c[1] === 'daemon-reload')).toHaveLength(0);
  });

  it('waits for tmux to move a new pane into its scope', async () => {
    setCgroup('4242', 'claude-discord.service');
    const sd = fakeSystemd({ [SCOPE]: { policy: 'stop', state: 'active' } });
    let slept = 0;
    const outcome = await keepPaneThroughOomKills(
      '%13',
      deps(sd.systemctl, {
        sleep: async () => {
          if (++slept === 2) setCgroup('4242', SCOPE);
        },
      }),
    );
    expect(outcome).toBe('protected');
    expect(slept).toBe(2);
  });

  it("never takes the tmux server's own scope for the pane's", async () => {
    // A tmux server started from inside another pane lives in that pane's
    // scope, and a new pane sits there too until tmux moves it.
    const OUTER = 'tmux-spawn-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.scope';
    setCgroup('100', OUTER);
    setCgroup('4242', OUTER);
    const sd = fakeSystemd({
      [OUTER]: { policy: 'stop', state: 'active' },
      [SCOPE]: { policy: 'stop', state: 'active' },
    });
    let slept = 0;
    const outcome = await keepPaneThroughOomKills(
      '%13',
      deps(sd.systemctl, {
        sleep: async () => {
          if (++slept === 3) setCgroup('4242', SCOPE);
        },
      }),
    );
    expect(outcome).toBe('protected');
    expect(existsSync(join(root, 'run', 'systemd', 'user', `${OUTER}.d`))).toBe(false);
    expect(existsSync(join(root, 'run', 'systemd', 'user', `${SCOPE}.d`))).toBe(true);
  });

  it('gives up rather than guess when the pane never leaves the server scope', async () => {
    const OUTER = 'tmux-spawn-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.scope';
    setCgroup('100', OUTER);
    setCgroup('4242', OUTER);
    const sd = fakeSystemd({ [OUTER]: { policy: 'stop', state: 'active' } });
    expect(await keepPaneThroughOomKills('%13', deps(sd.systemctl))).toBe('no-scope');
    expect(sd.calls).toHaveLength(0);
  });

  it('leaves panes outside a tmux scope alone', async () => {
    setCgroup('4242', 'claude-discord.service');
    const sd = fakeSystemd({});
    expect(await keepPaneThroughOomKills('%13', deps(sd.systemctl))).toBe('no-scope');
    expect(sd.calls).toHaveLength(0);
  });

  it('clears its drop-ins for scopes that have ended, not for live ones', async () => {
    setCgroup('4242', SCOPE);
    const dir = join(root, 'run', 'systemd', 'user');
    const LIVE = 'tmux-spawn-11111111-2222-3333-4444-555555555555.scope';
    for (const unit of [OLD, LIVE]) {
      mkdirSync(join(dir, `${unit}.d`), { recursive: true });
      writeFileSync(join(dir, `${unit}.d`, '50-piweb-oom-continue.conf'), '[Scope]\nOOMPolicy=continue\n');
    }
    const sd = fakeSystemd({
      [SCOPE]: { policy: 'stop', state: 'active' },
      [LIVE]: { policy: 'continue', state: 'active' },
    });
    expect(await keepPaneThroughOomKills('%13', deps(sd.systemctl))).toBe('protected');
    expect(existsSync(join(dir, `${OLD}.d`))).toBe(false);
    expect(existsSync(join(dir, `${LIVE}.d`, '50-piweb-oom-continue.conf'))).toBe(true);
  });

  it('never throws, and is a no-op off Linux', async () => {
    const failing = async () => {
      throw new Error('Failed to connect to bus');
    };
    setCgroup('4242', SCOPE);
    expect(await keepPaneThroughOomKills('%13', deps(failing))).toBe('failed');
    expect(await keepPaneThroughOomKills('%13', deps(failing, { platform: 'darwin' }))).toBe('unsupported');
  });

  it('reads the scope from /proc/<pid>/cgroup', () => {
    setCgroup('4242', SCOPE);
    expect(paneScope('4242', join(root, 'proc'))).toBe(SCOPE);
    expect(paneScope('9999', join(root, 'proc'))).toBeUndefined();
    expect(
      paneScope('4242', join(root, 'proc'), [
        `/user.slice/user-1000.slice/user@1000.service/app.slice/${SCOPE}`,
      ]),
    ).toBeUndefined();
  });
});

describe('a Claude Code pane that vanished mid-turn', () => {
  it('is reported as Claude Code having ended, not as a bare tmux error', () => {
    const text = describeBridgeFailure("can't find pane: %8");
    expect(text).toContain('Claude Code 在這一輪中途結束了');
    expect(text).toContain('再傳一則訊息會重新開啟並接著原本的對話');
    expect(text).toContain("can't find pane: %8");
    expect(describeBridgeFailure('timed out')).toBe('Claude Code tmux bridge failed: timed out');
  });
});
