import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cgroupOf, keepPaneThroughOomKills, paneScope } from '../src/agent/tmux-oom.js';

// Real tmux + the user's systemd, no model calls. A pane's scope is capped at
// 64 MB, so the kernel OOM-kills only the child that overruns it — the rest of
// the machine is never short of memory. Opt in: PIWEB_HOST_TMUX=1.
//
// Without the drop-in, systemd (OOMPolicy=stop) then ends the whole pane, as
// it did to the Pi browser session's Claude Code on 2026-11-14.
//
// The cap goes ONLY on a scope that holds nothing but the test's own pane
// process. A first version took the scope a new pane briefly shares with its
// tmux server — the scope of the pane this test was run from — and the cap
// OOM-killed that Claude Code session (2026-11-14 01:40).

const SOCKET = `piweb-oom-test-${process.pid}`;
const root = mkdtempSync(join(tmpdir(), 'piweb-oom-host-'));
const units: string[] = [];

function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { encoding: 'utf8', timeout: 15_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || error.message).trim()));
      else resolve(stdout);
    });
  });
}
const tmux = (args: string[]) => run('tmux', ['-L', SOCKET, ...args]);
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function paneWithOverrunningChild(name: string) {
  const dir = join(root, name);
  const program = `${dir}.py`;
  writeFileSync(
    program,
    `import os, pathlib, time
root = pathlib.Path(${JSON.stringify(dir)}); root.mkdir()
deadline = time.monotonic() + 60
while not (root / 'go').exists():
    if time.monotonic() > deadline: raise SystemExit(2)
    time.sleep(0.05)
pid = os.fork()
if pid == 0:
    hog = b'\\x01' * (400 << 20)
    os._exit(0)
_, status = os.waitpid(pid, 0)
(root / 'child').write_text(str(os.WTERMSIG(status) if os.WIFSIGNALED(status) else -1))
time.sleep(60)
`,
  );
  await tmux(['new-session', '-d', '-s', name, '/usr/bin/python3', program]);
  const pane = (await tmux(['list-panes', '-t', name, '-F', '#{pane_id}'])).trim();
  const [pid, serverPid] = (await tmux(['display-message', '-p', '-t', pane, '#{pane_pid} #{pid}']))
    .trim()
    .split(/\s+/);
  const notIn = [cgroupOf(serverPid), cgroupOf(String(process.pid))].filter((p): p is string => Boolean(p));
  let unit: string | undefined;
  for (let i = 0; !unit && i < 25; i++) {
    unit = paneScope(pid, '/proc', notIn);
    if (!unit) await wait(200);
  }
  expect(unit, 'tmux put the pane in its own systemd scope').toMatch(/^tmux-spawn-/);
  // Second, independent guard: the scope holds exactly this pane's process.
  const path = cgroupOf(pid)!;
  expect(notIn).not.toContain(path);
  const procs = readFileSync(join('/sys/fs/cgroup', path, 'cgroup.procs'), 'utf8').trim().split('\n');
  expect(procs, 'the scope to cap holds only the test pane').toEqual([pid]);
  units.push(unit!);
  await run('systemctl', ['--user', 'set-property', '--runtime', unit!, 'MemoryMax=64M', 'MemorySwapMax=0']);
  return { dir, pane, pid, unit: unit! };
}

async function paneAlive(pane: string): Promise<boolean> {
  try {
    return (await tmux(['display-message', '-p', '-t', pane, '#{pane_dead}'])).trim() === '0';
  } catch {
    return false;
  }
}

afterAll(async () => {
  await tmux(['kill-server']).catch(() => undefined);
  for (const unit of units) {
    rmSync(join(process.env.XDG_RUNTIME_DIR || '/nonexistent', 'systemd', 'user', `${unit}.d`), {
      recursive: true,
      force: true,
    });
  }
  await run('systemctl', ['--user', 'daemon-reload']).catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.env.PIWEB_HOST_TMUX !== '1' || process.platform !== 'linux')(
  'a tmux pane whose command is OOM-killed',
  () => {
    it('loses the whole pane under systemd’s default policy (the failure)', async () => {
      const { dir, pane, unit } = await paneWithOverrunningChild('control');
      expect((await run('systemctl', ['--user', 'show', unit, '-p', 'OOMPolicy', '--value'])).trim()).toBe('stop');
      writeFileSync(join(dir, 'go'), '');
      for (let i = 0; i < 75 && (await paneAlive(pane)); i++) await wait(200);
      expect(await paneAlive(pane)).toBe(false);
    }, 40_000);

    it('keeps the pane, and only the overrunning command dies, once protected', async () => {
      const { dir, pane, pid } = await paneWithOverrunningChild('protected');
      expect(await keepPaneThroughOomKills(pane, { tmux })).toBe('protected');
      writeFileSync(join(dir, 'go'), '');
      for (let i = 0; i < 75 && !existsSync(join(dir, 'child')); i++) await wait(200);
      expect(readFileSync(join(dir, 'child'), 'utf8')).toBe('9'); // SIGKILL from the OOM killer
      await wait(1500);
      expect(await paneAlive(pane)).toBe(true);
      expect((await tmux(['display-message', '-p', '-t', pane, '#{pane_pid}'])).trim()).toBe(pid);
      // A second call finds it already done.
      expect(await keepPaneThroughOomKills(pane, { tmux })).toBe('already');
    }, 40_000);
  },
);
