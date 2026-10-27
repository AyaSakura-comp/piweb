import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it, vi } from 'vitest';

// Explicit opt-in: uses the host's Claude login and real model quota, never the
// production DB/config. Run PIWEB_CLAUDE_LIVE=1 npx vitest run test/claude-btw-live.test.ts
// (with CLAUDE_TMUX_BIN pointing at claude when it is not on PATH).
it.skipIf(process.env.PIWEB_CLAUDE_LIVE !== '1')(
  'real Claude: a side question beside a running TUI turn sees it and leaves it untouched',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'piweb-claude-btw-live-'));
    const cwd = join(root, 'workspace');
    mkdirSync(cwd);
    vi.stubEnv('PIDG_CONFIG', join(root, 'absent.env'));
    vi.stubEnv('SESSIONS_DIR', join(root, 'sessions'));
    vi.stubEnv('CLAUDE_TMUX_STARTUP_TIMEOUT_MS', '30000');
    vi.stubEnv('CLAUDE_TMUX_TURN_TIMEOUT_MS', '90000');
    vi.resetModules();
    const { invokeClaudeTmux, closeClaudeTmuxSession, findClaudeTranscript } = await import(
      '../src/agent/claude-tmux.js'
    );
    const { claudeBtw } = await import('../src/agent/claude-btw.js');
    const folder = `live-btw-${randomUUID()}`;
    const codeword = `BTW_${randomUUID().slice(0, 8)}`;
    const options = { model: 'claude-code/haiku', cwd };
    const btwOptions = { modelRef: 'claude-code/haiku', cwd };
    try {
      const first = await invokeClaudeTmux(
        folder,
        `Remember this codeword for later: ${codeword}. Reply with just OK. No tools.`,
        options,
      );
      expect(first.ok, first.error).toBe(true);

      // A main turn that is still running (a tool call in flight) …
      let toolStarted!: () => void;
      const started = new Promise<void>((resolve) => (toolStarted = resolve));
      const running = invokeClaudeTmux(
        folder,
        'Use the Bash tool to run exactly: sleep 25 && echo SLEPT_OK. Then reply with its output.',
        {
          ...options,
          onEvent: (event) => {
            if (event.assistantMessageEvent?.type === 'toolcall_end') toolStarted();
          },
        },
      );
      await started;
      const statePath = join(root, 'sessions', folder, 'claude-tmux-session.json');
      const transcript = findClaudeTranscript(JSON.parse(readFileSync(statePath, 'utf8')).sessionId)!;
      const before = readFileSync(transcript, 'utf8');
      const projectFiles = () => readdirSync(dirname(transcript)).sort();
      const filesBefore = projectFiles();

      // … and a side question beside it: it sees the conversation and the command.
      const side = await claudeBtw(
        folder,
        'send',
        'What is the codeword, and what command is the main conversation running right now? One line.',
        btwOptions,
      );
      const answer = side.messages.at(-1)!.content;
      expect(answer).toContain(codeword);
      expect(answer).toMatch(/sleep/i);
      // A follow-up sees the earlier side answer.
      const followUp = await claudeBtw(
        folder,
        'send',
        'Repeat your previous side answer word for word.',
        btwOptions,
      );
      expect(followUp.messages).toHaveLength(4);
      expect(followUp.messages.at(-1)!.content).toContain(codeword);

      // The main turn finishes normally, and its transcript never saw the side chat.
      const done = await running;
      expect(done.ok, done.error).toBe(true);
      expect(done.text).toContain('SLEPT_OK');
      const after = readFileSync(transcript, 'utf8');
      expect(after.startsWith(before)).toBe(true);
      expect(after).not.toContain('Repeat your previous side answer');
      expect(after).not.toContain('what command is the main conversation running');
      // The forks were never saved as conversations of their own.
      expect(projectFiles()).toEqual(filesBefore);
      expect((await claudeBtw(folder, 'clear', undefined, btwOptions)).messages).toEqual([]);
    } finally {
      closeClaudeTmuxSession(folder);
      rmSync(root, { recursive: true, force: true });
    }
  },
  240_000,
);
