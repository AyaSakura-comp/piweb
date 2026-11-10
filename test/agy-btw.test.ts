import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  agyBtw,
  agySideQuestionPrompt,
  askAgySideQuestion,
  buildAgyBtwTuiArgs,
  sideAnswerFromReplay,
  type AgyBtwDependencies,
  type AgyBtwRuntime,
} from '../src/agent/agy-btw.js';

// A stand-in for agy 1.5.4, both halves Piweb uses:
// - the TUI (no `acp`): shows "? for shortcuts", takes a bracketed paste and
//   Enter on its terminal, and for `/btw <question>` writes the log lines agy
//   writes ("Starting conversation update stream for <id>" for the main
//   conversation and the fork, "Stream goroutine exited for <fork>") and keeps
//   the fork's messages in a file it deletes when it exits, as agy deletes the
//   fork. A text without `/btw` is a main-conversation message (recorded).
// - `acp`: `session/load` replays a fork's messages as session/update
//   notifications, as agy's ACP server does.
// The question picks the behaviour: "hang" never answers, "fail" shows an
// error in the /btw card, "two steps" answers in two messages.
const FAKE_AGY = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const argv = process.argv.slice(2);
const calls = process.env.FAKE_AGY_LOG;
const state = process.env.FAKE_AGY_STATE;
const record = (entry) => fs.appendFileSync(calls, JSON.stringify(entry) + '\n');
if (argv[0] === 'acp') {
  record({ mode: 'acp', cwd: process.cwd() });
  const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
    const m = JSON.parse(line);
    if (m.method === 'initialize') return send({ id: m.id, result: { protocolVersion: 1 } });
    if (m.method === 'session/close') return send({ id: m.id, result: {} });
    if (m.method !== 'session/load') return send({ id: m.id, error: { code: -32601, message: 'no ' + m.method } });
    const file = path.join(state, m.params.sessionId + '.json');
    if (!fs.existsSync(file)) return send({ id: m.id, error: { code: -32000, message: 'conversation not found' } });
    const update = (u) => send({ method: 'session/update', params: { sessionId: m.params.sessionId, update: u } });
    update({ sessionUpdate: 'available_commands_update', availableCommands: [] });
    for (const msg of JSON.parse(fs.readFileSync(file, 'utf8'))) {
      if (msg.tool) update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: msg.tool });
      else update({ sessionUpdate: msg.role === 'user' ? 'user_message_chunk' : 'agent_message_chunk', content: { type: 'text', text: msg.text } });
    }
    send({ id: m.id, result: {} });
  });
  return;
}
const opt = (name) => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1]; };
const conversation = opt('--conversation');
const logFile = opt('--log-file');
const logLine = (text) => fs.appendFileSync(logFile, 'I1110 00:00:00.000000 1 server.go:1] ' + text + '\n');
record({ mode: 'tui', argv, cwd: process.cwd() });
if (process.env.FAKE_AGY_TUI === 'exit') {
  // Exiting at once can take the printed line with it; the log keeps it.
  fs.appendFileSync(logFile, 'E1110 00:00:00.000000 1 auth.go:1] not signed in to Antigravity\n');
  process.stdout.write('Error: not signed in to Antigravity\r\n');
  process.exit(1);
}
const forks = [];
const cleanup = () => { for (const fork of forks) fs.rmSync(path.join(state, fork + '.json'), { force: true }); };
for (const signal of ['SIGHUP', 'SIGTERM']) process.on(signal, () => { cleanup(); process.exit(0); });
process.on('exit', cleanup);
const show = (text) => process.stdout.write(text.replace(/\n/g, '\r\n'));
setTimeout(() => {
  // Like agy's TUI, ask the terminal for bracketed paste.
  process.stdout.write('\x1b[?2004h');
  // The conversation so far, with a /btw and an error of its own in it.
  show('Antigravity CLI (fake)\n> /btw sent as a plain message once\n  Error: an old main-turn error\n\n? for shortcuts\n');
  process.stdin.setRawMode(true);
  let input = '';
  let echoed = false;
  process.stdin.on('data', (chunk) => {
    input += chunk.toString('utf8');
    // Enter is a CR after the paste; tmux sends the pasted newlines as CR too.
    const end = input.indexOf('\x1b[201~');
    if (!input.startsWith('\x1b[200~')) {
      if (input.includes('\r')) { record({ mode: 'tui-unpasted' }); input = ''; }
      return;
    }
    if (end < 0) return;
    const text = input.slice(6, end).replace(/\r/g, '\n');
    if (!input.slice(end).includes('\r')) {
      if (!echoed) show('\n> ' + text + '\n');
      echoed = true;
      return;
    }
    input = '';
    echoed = false;
    if (!text.startsWith('/btw ')) { record({ mode: 'main-message', text }); return; }
    const question = text.slice(5);
    record({ mode: 'btw', question });
    const fork = randomUUID();
    forks.push(fork);
    logLine('Starting conversation update stream for ' + conversation);
    logLine('Starting conversation update stream for ' + fork);
    const main = [{ role: 'user', text: 'main question' }, { role: 'assistant', text: 'main answer' }];
    if (question.includes('hang')) return;
    setTimeout(() => {
      let messages;
      if (question.includes('fail')) {
        messages = [...main, { role: 'user', text: question }];
        show('\n ┃ /btw ' + question + '\n ┃\n ┃ Error: failed to construct executor: boom\n ┃ Press Enter/Esc to dismiss\n');
      } else if (question.includes('two steps')) {
        messages = [...main, { role: 'user', text: question }, { role: 'assistant', text: 'Let me look.' }, { tool: 'read_file' }, { role: 'assistant', text: 'Found it.' }];
      } else {
        messages = [...main, { role: 'user', text: question }, { role: 'assistant', text: 'A: ' + question.split('\n').pop() }];
      }
      fs.writeFileSync(path.join(state, fork + '.json'), JSON.stringify(messages));
      logLine('Stream goroutine exited for ' + fork + ', sending completion signal');
    }, 100);
  });
}, Number(process.env.FAKE_AGY_BOOT_MS || 50));
`;

const tempDirs: string[] = [];
const sockets: string[] = [];
let socketCount = 0;
afterEach(() => {
  for (const socket of sockets.splice(0)) {
    try {
      execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' });
    } catch {
      // no server left
    }
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.FAKE_AGY_TUI;
});

function fixture(options: { conversationId?: string; timeoutMs?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'agy-btw-test-'));
  tempDirs.push(root);
  const bin = join(root, 'agy');
  writeFileSync(bin, FAKE_AGY);
  chmodSync(bin, 0o755);
  const log = join(root, 'calls.jsonl');
  const state = join(root, 'state');
  const sessionDir = join(root, 'session');
  const cwd = join(root, 'cwd');
  for (const dir of [state, sessionDir, cwd]) mkdirSync(dir, { recursive: true });
  process.env.FAKE_AGY_LOG = log;
  process.env.FAKE_AGY_STATE = state;
  const socket = `piweb-agy-btw-test-${process.pid}-${++socketCount}`;
  sockets.push(socket);
  const runtime: AgyBtwRuntime = {
    agyBin: bin,
    tmuxBin: 'tmux',
    tmuxSocket: socket,
    timeoutMs: options.timeoutMs ?? 10_000,
    startTimeoutMs: 5_000,
    pollMs: 50,
  };
  let conversationId = options.conversationId;
  const deps: AgyBtwDependencies = {
    resolveSessionDir: () => sessionDir,
    readConversationId: () => conversationId,
    ask: (request) => askAgySideQuestion(request, runtime),
  };
  const calls = () =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
      : [];
  const btw = (action: 'snapshot' | 'send' | 'clear', text?: string, folder = 'web_agy') =>
    agyBtw(folder, action, text, {
      modelRef: 'agy/gemini-3.8-flash-low',
      thinking: 'high',
      cwd,
      dependencies: deps,
    });
  const tuis = () => {
    try {
      return execFileSync('tmux', ['-L', socket, 'list-sessions', '-F', '#{session_name}'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .trim()
        .split('\n')
        .filter(Boolean);
    } catch {
      return [];
    }
  };
  return {
    root,
    sessionDir,
    cwd,
    state,
    calls,
    btw,
    tuis,
    runtime,
    setConversation: (id: string | undefined) => (conversationId = id),
  };
}

describe('AGY BTW (agy’s own /btw in its TUI)', () => {
  it('pastes /btw into a TUI on the conversation, reads the fork’s answer, and closes the TUI', async () => {
    const f = fixture({ conversationId: 'main-conv' });
    const thread = await f.btw('send', 'what is the main task doing?');
    expect(thread).toEqual({
      messages: [
        { role: 'user', content: 'what is the main task doing?' },
        { role: 'assistant', content: 'A: what is the main task doing?' },
      ],
      pending: [],
      streaming: [],
    });
    const calls = f.calls();
    const tui = calls.find((call) => call.mode === 'tui');
    expect(tui.cwd).toBe(f.cwd);
    expect(tui.argv.slice(0, 6)).toEqual([
      '--conversation',
      'main-conv',
      '--model',
      'gemini-3.8-flash-low',
      '--log-file',
      expect.stringMatching(/agy\.log$/),
    ]);
    expect(JSON.parse(tui.argv[tui.argv.indexOf('--settings') + 1])).toEqual({
      trustedWorkspaces: [f.cwd],
    });
    // The question went in as a side question, never as a main message.
    expect(calls.filter((call) => call.mode === 'btw')).toEqual([
      { mode: 'btw', question: 'what is the main task doing?' },
    ]);
    expect(calls.some((call) => call.mode === 'main-message' || call.mode === 'tui-unpasted')).toBe(
      false,
    );
    // The answer was read through acp in the same folder, then the TUI closed
    // and (as agy does) deleted its fork.
    expect(calls.filter((call) => call.mode === 'acp')).toEqual([{ mode: 'acp', cwd: f.cwd }]);
    expect(f.tuis()).toEqual([]);
    expect(readdirSync(f.state)).toEqual([]);
    // The thread is kept for this conversation.
    expect(JSON.parse(readFileSync(join(f.sessionDir, 'agy-btw.json'), 'utf8'))).toEqual({
      conversationId: 'main-conv',
      entries: [
        { question: 'what is the main task doing?', response: 'A: what is the main task doing?' },
      ],
    });
    expect((await f.btw('snapshot')).messages).toHaveLength(2);
  });

  it('keeps a multi-line question in one paste and joins an answer given in several messages', async () => {
    const f = fixture({ conversationId: 'main-conv' });
    const thread = await f.btw('send', 'first line\nsecond line, two steps');
    expect(f.calls().filter((call) => call.mode === 'btw')).toEqual([
      { mode: 'btw', question: 'first line\nsecond line, two steps' },
    ]);
    expect(thread.messages[1].content).toBe('Let me look.\n\nFound it.');
  });

  it('a follow-up carries the earlier side questions and answers in front of it', async () => {
    const f = fixture({ conversationId: 'main-conv' });
    await f.btw('send', 'first');
    const thread = await f.btw('send', 'second');
    const asked = f
      .calls()
      .filter((call) => call.mode === 'btw')
      .map((call) => call.question);
    expect(asked[0]).toBe('first');
    expect(asked[1]).toBe(
      'Earlier side questions in this /btw thread (not part of the main conversation), oldest first:\n\n' +
        'Q: first\nA: A: first\n\nNew side question:\nsecond',
    );
    expect(thread.messages.map((message) => message.content)).toEqual([
      'first',
      'A: first',
      'second',
      'A: second',
    ]);
  });

  it('answers one side question at a time per session, in order', async () => {
    const f = fixture({ conversationId: 'main-conv' });
    const [a, b] = await Promise.all([f.btw('send', 'one'), f.btw('send', 'two')]);
    expect(a.messages.map((message) => message.content)).toEqual(['one', 'A: one']);
    expect(b.messages.map((message) => message.content)).toEqual([
      'one',
      'A: one',
      'two',
      'A: two',
    ]);
  });

  it('lists a question as pending until answered and refuses clear meanwhile, then clears', async () => {
    const f = fixture({ conversationId: 'main-conv' });
    const sending = f.btw('send', 'pending one');
    await expect.poll(async () => (await f.btw('snapshot')).pending).toEqual(['pending one']);
    await expect(f.btw('clear')).rejects.toThrow('Wait for the BTW answer before clearing');
    await sending;
    expect((await f.btw('snapshot')).pending).toEqual([]);
    expect((await f.btw('clear')).messages).toEqual([]);
  });

  it('refuses before the first turn: agy has no conversation and its own /btw fails there', async () => {
    const f = fixture();
    await expect(f.btw('send', 'too early')).rejects.toThrow('要等主對話開始後');
    expect(f.calls()).toEqual([]);
    expect((await f.btw('snapshot')).pending).toEqual([]);
  });

  it('a new agy conversation starts an empty side thread', async () => {
    const f = fixture({ conversationId: 'main-conv' });
    await f.btw('send', 'old');
    f.setConversation('next-conv');
    expect((await f.btw('snapshot')).messages).toEqual([]);
  });

  it('reports the /btw card’s error and keeps nothing', async () => {
    const f = fixture({ conversationId: 'main-conv' });
    await expect(f.btw('send', 'please fail')).rejects.toThrow(
      'agy /btw：failed to construct executor: boom',
    );
    expect((await f.btw('snapshot')).messages).toEqual([]);
    expect(f.tuis()).toEqual([]);
  });

  it('says what the TUI showed when it exits at once', async () => {
    const f = fixture({ conversationId: 'main-conv' });
    process.env.FAKE_AGY_TUI = 'exit';
    await expect(f.btw('send', 'hello')).rejects.toThrow('not signed in to Antigravity');
    expect(f.tuis()).toEqual([]);
  });

  it('gives up on a side question that never answers and closes its TUI', async () => {
    const f = fixture({ conversationId: 'main-conv', timeoutMs: 600 });
    await expect(f.btw('send', 'hang forever')).rejects.toThrow('agy BTW 等待逾時');
    expect(f.tuis()).toEqual([]);
    expect(readdirSync(f.state)).toEqual([]);
  });
});

describe('AGY BTW pieces', () => {
  it('builds the TUI command line: conversation, model, effort only when the id has none', () => {
    const base = { conversationId: 'c1', cwd: '/w', logFile: '/tmp/x.log' };
    expect(
      buildAgyBtwTuiArgs({ ...base, modelRef: 'agy/gemini-3.8-flash-low', thinking: 'high' }),
    ).toEqual([
      '--conversation',
      'c1',
      '--model',
      'gemini-3.8-flash-low',
      '--log-file',
      '/tmp/x.log',
      '--settings',
      '{"trustedWorkspaces":["/w"]}',
    ]);
    expect(
      buildAgyBtwTuiArgs({ ...base, modelRef: 'agy/claude-sonnet-4-6', thinking: 'xhigh' }),
    ).toEqual(expect.arrayContaining(['--model', 'claude-sonnet-4-6', '--effort', 'high']));
    expect(
      buildAgyBtwTuiArgs({ ...base, modelRef: 'agy/claude-sonnet-4-6', thinking: 'off' }),
    ).not.toContain('--effort');
  });

  it('drops control characters so a question cannot end the bracketed paste', () => {
    expect(agySideQuestionPrompt('a\u001b[201~b\r\nc\u0007', [])).toBe('a[201~b\nc');
  });

  it('keeps the newest earlier answers within the budget, oldest first', () => {
    const history = Array.from({ length: 10 }, (_, i) => ({
      question: `q${i}`,
      response: 'x'.repeat(3_000),
    }));
    const prompt = agySideQuestionPrompt('now', history);
    expect(prompt).not.toContain('Q: q5\n');
    expect(prompt.indexOf('Q: q6\n')).toBeLessThan(prompt.indexOf('Q: q9\n'));
    expect(prompt.endsWith('New side question:\nnow')).toBe(true);
    const long = agySideQuestionPrompt('now', [{ question: 'q', response: 'y'.repeat(9_000) }]);
    expect(long).toContain(`A: ${'y'.repeat(4_000)}…`);
  });

  it('takes the answer after the last user message of the replay', () => {
    expect(
      sideAnswerFromReplay([
        { role: 'user', text: 'main' },
        { role: 'assistant', text: 'main answer' },
        { role: 'user', text: 'side' },
        { role: 'assistant', text: ' one ' },
        { role: 'assistant', text: 'two' },
      ]),
    ).toBe('one\n\ntwo');
    expect(sideAnswerFromReplay([{ role: 'user', text: 'side' }])).toBe('');
  });
});
