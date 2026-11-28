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

// The 2026-11-28 failure, against the real TUI: a message stopped before
// Claude's first output is put back in the prompt box, and the next message
// carries a handoff note taller than the box (its ❯ row scrolls away).
it.skipIf(process.env.PIWEB_CLAUDE_LIVE !== '1')(
  'real Claude tmux: a message after an early stop is delivered alone',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'piweb-claude-live-'));
    const cwd = join(root, 'workspace');
    mkdirSync(cwd);
    vi.stubEnv('PIDG_CONFIG', join(root, 'absent.env'));
    vi.stubEnv('SESSIONS_DIR', join(root, 'sessions'));
    vi.stubEnv('CLAUDE_TMUX_STARTUP_TIMEOUT_MS', '30000');
    vi.stubEnv('CLAUDE_TMUX_TURN_TIMEOUT_MS', '60000');
    vi.resetModules();
    const { invokeClaudeTmux, closeClaudeTmuxSession, tmuxSessionName, readPromptBox } =
      await import('../src/agent/claude-tmux.js');
    const { config } = await import('../src/config.js');
    const folder = `live-${randomUUID()}`;
    const name = tmuxSessionName(folder);
    const statePath = join(root, 'sessions', folder, 'claude-tmux-session.json');
    const options = { model: 'claude-code/haiku', cwd };
    const screen = () =>
      execFileSync(config.claudeTmuxTmuxBin, ['capture-pane', '-p', '-t', name], { encoding: 'utf8' });
    try {
      const warm = await invokeClaudeTmux(
        folder,
        '[Web user: web]\nReply with exactly WARM_OK. No tools.',
        options,
      );
      expect(warm.ok, warm.error).toBe(true);
      expect(warm.text).toContain('WARM_OK');

      // Stop the next message the moment its turn shows as running.
      const controller = new AbortController();
      const watch = setInterval(() => {
        try {
          if (/esc to interrupt/iu.test(screen())) controller.abort();
        } catch {
          /* the pane is not up yet */
        }
      }, 50);
      let stopped;
      try {
        stopped = await invokeClaudeTmux(
          folder,
          '[Web user: web]\nWrite a 3000 word essay about the history of tea, in full. No tools.',
          { ...options, signal: controller.signal },
        );
      } finally {
        clearInterval(watch);
      }
      expect(stopped.aborted).toBe(true);
      // Claude Code put the stopped message back for editing.
      const left = readPromptBox(screen());
      expect(left.text).toContain('history of tea');

      const after = await invokeClaudeTmux(
        folder,
        '[System handoff: The user interrupted the previous task. Do not resume or continue the previous task. ' +
          'Follow only the latest instruction below. If asked for a screenshot, take it and immediately return it ' +
          'using [[file: /absolute/path/to/screenshot.png]].]\n[Web user: web]\n' +
          'Reply with exactly AFTER_EARLY_STOP and nothing else. No tools.',
        options,
      );
      expect(after.ok, after.error).toBe(true);
      expect(after.text).toContain('AFTER_EARLY_STOP');

      // What Claude was handed is the new message alone.
      const transcript = JSON.parse(readFileSync(statePath, 'utf8')).transcriptPath;
      const prompts = readFileSync(transcript, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((record) => record.type === 'user' && typeof record.message?.content === 'string')
        .map((record) => record.message.content as string);
      const last = prompts.at(-1) ?? '';
      expect(last).toContain('AFTER_EARLY_STOP');
      expect(last).not.toContain('history of tea');
      expect(readPromptBox(screen()).framed).toBe(true);
    } finally {
      closeClaudeTmuxSession(folder);
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  },
  180000,
);
