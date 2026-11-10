import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

// Explicit opt-in: uses the host's agy login and real Gemini quota, never the
// production DB/config. Run
//   PIWEB_AGY_LIVE=1 AGY_BIN=$HOME/.local/bin/agy npx vitest run test/agy-btw-live.test.ts
// It leaves no agy conversation behind: the side questions' forks go with their
// TUI, and the one main conversation it made is removed at the end.
it.skipIf(process.env.PIWEB_AGY_LIVE !== '1')(
  'real agy: a side question beside a running turn sees it, a follow-up sees the side thread, the main conversation never sees either',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'piweb-agy-btw-live-'));
    const cwd = join(root, 'workspace');
    mkdirSync(cwd);
    vi.stubEnv('PIDG_CONFIG', join(root, 'absent.env'));
    vi.stubEnv('SESSIONS_DIR', join(root, 'sessions'));
    vi.resetModules();
    const { invokeAgy, readAgyConversationId } = await import('../src/agent/agy.js');
    const { agyBtw, replayAgyConversation } = await import('../src/agent/agy-btw.js');
    const { config } = await import('../src/config.js');
    const folder = `live-agy-btw-${randomUUID()}`;
    const fruit = ['durian', 'rambutan', 'mangosteen'][Math.floor(Math.random() * 3)];
    const model = process.env.PIWEB_AGY_LIVE_MODEL || 'agy/gemini-3.8-flash-low';
    const options = { model, cwd };
    const btwOptions = { modelRef: model, cwd };
    let conversationId: string | undefined;
    try {
      const first = await invokeAgy(
        folder,
        `My favourite fruit is ${fruit}. Reply with just OK. No tools.`,
        options,
      );
      expect(first.ok, first.error).toBe(true);
      conversationId = readAgyConversationId(folder);
      expect(conversationId).toBeTruthy();

      // A main turn that is still running (a tool call in flight) …
      let toolStarted!: () => void;
      const started = new Promise<void>((resolve) => (toolStarted = resolve));
      const running = invokeAgy(
        folder,
        'Use your shell tool to run exactly: sleep 25 && echo SLEPT_OK (in the foreground, wait for it). Then reply with its output.',
        {
          ...options,
          onEvent: (event: any) => {
            if (event.assistantMessageEvent?.type === 'toolcall_end') toolStarted();
          },
        },
      );
      await started;

      // … and a side question beside it: it sees the conversation and the command.
      const side = await agyBtw(
        folder,
        'send',
        'What is my favourite fruit, and what shell command is the main conversation running? ' +
          'Also pick a random two-digit number. Answer in three short lines.',
        btwOptions,
      );
      const answer = side.messages.at(-1)!.content;
      expect(answer.toLowerCase()).toContain(fruit);
      expect(answer).toMatch(/sleep/i);
      const number = /\b\d{2}\b/.exec(answer.replace(/\b25\b/g, ''))?.[0];
      expect(number, answer).toBeTruthy();
      // A follow-up sees the earlier side answer (Piweb carries the thread).
      const followUp = await agyBtw(
        folder,
        'send',
        'Which two-digit number did you pick in your previous side answer? Reply with only the number.',
        btwOptions,
      );
      expect(followUp.messages).toHaveLength(4);
      expect(followUp.messages.at(-1)!.content).toContain(number);

      // The main turn finishes normally, and its conversation never saw the side chat.
      const done = await running;
      expect(done.ok, done.error).toBe(true);
      expect(done.text).toContain('SLEPT_OK');
      const main = await replayAgyConversation({
        bin: config.agyBin,
        conversationId: conversationId!,
        cwd,
        timeoutMs: 60_000,
      });
      const said = main.map((message) => message.text).join('\n');
      expect(main.filter((message) => message.role === 'user')).toHaveLength(2);
      expect(said).not.toMatch(/two-digit|\/btw|side answer/i);
      // None of this process's TUIs is left on the private tmux server.
      let left = '';
      try {
        left = execFileSync(
          config.agyTmuxBin,
          ['-L', 'piweb-agy-btw', 'list-sessions', '-F', '#{session_name}'],
          {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
          },
        );
      } catch {
        // no server: nothing left
      }
      expect(left.split('\n').filter((name) => name.startsWith(`btw-${process.pid}-`))).toEqual([]);
      expect((await agyBtw(folder, 'clear', undefined, btwOptions)).messages).toEqual([]);
    } finally {
      if (conversationId && /^[0-9a-f-]{36}$/.test(conversationId)) {
        const store = join(homedir(), '.gemini', 'antigravity-cli');
        for (const suffix of ['.db', '.db-wal', '.db-shm']) {
          rmSync(join(store, 'conversations', `${conversationId}${suffix}`), { force: true });
        }
        rmSync(join(store, 'brain', conversationId), { recursive: true, force: true });
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
  300_000,
);
