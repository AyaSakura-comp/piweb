import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

// Explicit opt-in: uses the host's Claude login and real model quota, never the
// production DB/config. Run PIWEB_CLAUDE_LIVE=1 npx vitest run test/claude-tmux-live.test.ts.
it.skipIf(process.env.PIWEB_CLAUDE_LIVE !== '1')(
  'real Claude tmux: tools, uploads, reuse, resume, stop and fresh context',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'piweb-claude-live-'));
    const cwd = join(root, 'workspace');
    mkdirSync(cwd);
    vi.stubEnv('PIDG_CONFIG', join(root, 'absent.env'));
    vi.stubEnv('SESSIONS_DIR', join(root, 'sessions'));
    vi.stubEnv('CLAUDE_TMUX_STARTUP_TIMEOUT_MS', '30000');
    vi.stubEnv('CLAUDE_TMUX_TURN_TIMEOUT_MS', '60000');
    vi.resetModules();
    const { invokeClaudeTmux, closeClaudeTmuxSession, tmuxSessionName } =
      await import('../src/agent/claude-tmux.js');
    const { config } = await import('../src/config.js');
    const folder = `live-${randomUUID()}`;
    const secret = `SMOKE_${randomUUID()}`;
    const input = join(cwd, 'input.txt');
    writeFileSync(input, secret);
    const statePath = join(root, 'sessions', folder, 'claude-tmux-session.json');
    const options = { model: 'claude-code/haiku', cwd };
    try {
      const events: any[] = [];
      const first = await invokeClaudeTmux(
        folder,
        'Read the uploaded file with your Read tool and reply with exactly its contents. Remember the code for later.',
        {
          ...options,
          attachments: JSON.stringify([
            {
              filePath: input,
              url: '',
              filename: 'input.txt',
              contentType: 'text/plain',
              size: secret.length,
            },
          ]),
          onEvent: (event) => {
            events.push(event);
          },
        },
      );
      expect(first.ok, first.error).toBe(true);
      expect(first.text).toContain(secret);
      expect(events.some((e) => e.assistantMessageEvent?.type === 'toolcall_end')).toBe(true);
      const id = JSON.parse(readFileSync(statePath, 'utf8')).sessionId;
      const second = await invokeClaudeTmux(
        folder,
        'Reply with the code you read earlier. No tools.',
        options,
      );
      expect(second.ok, second.error).toBe(true);
      expect(second.text).toContain(secret);
      expect(closeClaudeTmuxSession(folder)).toBe(true);
      const resumed = await invokeClaudeTmux(
        folder,
        'Reply with the code you remember. No tools.',
        options,
      );
      expect(resumed.ok, resumed.error).toBe(true);
      expect(resumed.text).toContain(secret);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      try {
        const stopped = await invokeClaudeTmux(
          folder,
          'Use Bash to run sleep 30, then reply DONE.',
          {
            ...options,
            signal: controller.signal,
            onEvent: (event) => {
              if (event.assistantMessageEvent?.type === 'toolcall_end') controller.abort();
            },
          },
        );
        expect(stopped.aborted).toBe(true);
      } finally {
        clearTimeout(timer);
      }
      execFileSync(config.claudeTmuxTmuxBin, ['has-session', '-t', tmuxSessionName(folder)]);
      const afterStop = await invokeClaudeTmux(
        folder,
        'Reply with exactly AFTER_STOP. Do not run tools.',
        options,
      );
      expect(afterStop.ok, afterStop.error).toBe(true);
      expect(afterStop.text).toContain('AFTER_STOP');
      closeClaudeTmuxSession(folder);
      rmSync(join(root, 'sessions', folder), { recursive: true });
      const fresh = await invokeClaudeTmux(
        folder,
        'Reply with exactly FRESH_OK. No tools.',
        options,
      );
      expect(fresh.ok, fresh.error).toBe(true);
      expect(fresh.text).toContain('FRESH_OK');
      expect(JSON.parse(readFileSync(statePath, 'utf8')).sessionId).not.toBe(id);
    } finally {
      closeClaudeTmuxSession(folder);
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  },
  180000,
);
