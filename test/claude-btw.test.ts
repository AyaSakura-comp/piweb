import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildClaudeBtwArgs, claudeBtw, type ClaudeBtwDependencies } from '../src/agent/claude-btw.js';

// A stand-in for `claude -p --input-format stream-json`: it logs how it was
// started, reads the side_question control request and answers it the way
// Claude Code 2.1.311 does. The question picks the behaviour.
const FAKE_CLAUDE = `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const log = process.env.FAKE_CLAUDE_LOG;
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  const newline = input.indexOf('\\n');
  if (newline < 0) return;
  const message = JSON.parse(input.slice(0, newline));
  input = input.slice(newline + 1);
  const { question, history = [] } = message.request;
  appendFileSync(log, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), question, history }) + '\\n');
  const reply = (response) =>
    process.stdout.write(JSON.stringify({ type: 'control_response', response: { request_id: message.request_id, ...response } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'control_request_progress', request_id: message.request_id, status: 'started' }) + '\\n');
  if (question.startsWith('hang')) return;
  if (question.startsWith('crash')) { process.stderr.write('Not logged in'); process.exit(1); }
  const delay = question.startsWith('slow') ? 300 : 0;
  setTimeout(() => {
    if (question.startsWith('error')) reply({ subtype: 'error', error: 'side_question: boom' });
    else if (question.startsWith('synthetic')) reply({ subtype: 'success', response: { response: '(No answer available.)', synthetic: true } });
    else reply({ subtype: 'success', response: { response: 'A:' + question + ' after ' + history.length, synthetic: false } });
  }, delay);
});
process.stdin.on('end', () => process.exit(0));
`;

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(options: { sessionId?: string; transcript?: boolean; timeoutMs?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'claude-btw-test-'));
  tempDirs.push(root);
  const bin = join(root, 'claude');
  writeFileSync(bin, FAKE_CLAUDE);
  chmodSync(bin, 0o755);
  const log = join(root, 'calls.jsonl');
  process.env.FAKE_CLAUDE_LOG = log;
  const sessionDir = join(root, 'session');
  const tuiCwd = join(root, 'tui-cwd');
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(tuiCwd, { recursive: true });
  mkdirSync(join(root, 'channel-cwd'), { recursive: true });
  if (options.sessionId) {
    writeFileSync(
      join(sessionDir, 'claude-tmux-session.json'),
      JSON.stringify({ sessionId: options.sessionId, cwd: tuiCwd, modelRef: 'claude-code/opus', thinking: 'high' }),
    );
  }
  const deps: ClaudeBtwDependencies = {
    resolveSessionDir: () => sessionDir,
    findTranscript: (id) => (options.transcript !== false && id === options.sessionId ? '/x.jsonl' : undefined),
    claudeBin: bin,
    timeoutMs: options.timeoutMs ?? 10_000,
  };
  const calls = () =>
    existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
  const btw = (action: 'snapshot' | 'send' | 'clear', text?: string, folder = 'web_cc') =>
    claudeBtw(folder, action, text, {
      modelRef: 'claude-code/opus',
      thinking: 'high',
      cwd: join(root, 'channel-cwd'),
      dependencies: deps,
    });
  return { root, sessionDir, tuiCwd, calls, btw };
}

describe('Claude Code BTW (side_question)', () => {
  it('asks the resumed conversation in a fork that is never saved, and keeps the thread', async () => {
    const fx = fixture({ sessionId: 'conv-1' });
    const first = await fx.btw('send', '  what changed?  ');
    expect(first).toEqual({
      messages: [
        { role: 'user', content: 'what changed?' },
        { role: 'assistant', content: 'A:what changed? after 0' },
      ],
      pending: [],
      streaming: [],
    });
    const [call] = fx.calls();
    expect(call.cwd).toBe(fx.tuiCwd);
    expect(call.argv.slice(0, 6)).toEqual(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']);
    const flag = (name: string) => call.argv[call.argv.indexOf(name) + 1];
    expect(flag('--resume')).toBe('conv-1');
    expect(call.argv).toContain('--fork-session');
    expect(call.argv).toContain('--no-session-persistence');
    expect(flag('--model')).toBe('opus');
    expect(flag('--effort')).toBe('high');
    expect(call.argv).toContain('--strict-mcp-config');
    expect(JSON.parse(flag('--settings'))).toEqual({ remoteControlAtStartup: false, disableAllHooks: true });

    // A follow-up carries the earlier side answers as history.
    const second = await fx.btw('send', 'and why?');
    expect(fx.calls()[1].history).toEqual([{ question: 'what changed?', response: 'A:what changed? after 0' }]);
    expect(second.messages.at(-1)).toEqual({ role: 'assistant', content: 'A:and why? after 1' });
    expect((await fx.btw('snapshot')).messages).toHaveLength(4);
  });

  it('before the first turn there is nothing to resume', async () => {
    const fx = fixture();
    await fx.btw('send', 'hello');
    const [call] = fx.calls();
    expect(call.argv).not.toContain('--resume');
    expect(call.argv).not.toContain('--fork-session');
    expect(call.argv).toContain('--no-session-persistence');
    expect(call.cwd).toBe(join(fx.root, 'channel-cwd'));
  });

  it('does not resume a conversation whose transcript is gone', async () => {
    const fx = fixture({ sessionId: 'conv-1', transcript: false });
    await fx.btw('send', 'hello');
    expect(fx.calls()[0].argv).not.toContain('--resume');
  });

  it('lists a question as pending until answered, refuses clear meanwhile, then clears', async () => {
    const fx = fixture({ sessionId: 'conv-1' });
    const sending = fx.btw('send', 'slow one');
    await expect.poll(async () => (await fx.btw('snapshot')).pending).toEqual(['slow one']);
    await expect(fx.btw('clear')).rejects.toThrow('Wait for the BTW answer before clearing');
    await sending;
    expect((await fx.btw('snapshot')).pending).toEqual([]);
    expect((await fx.btw('clear')).messages).toEqual([]);
    expect((await fx.btw('snapshot')).messages).toEqual([]);
  });

  it('answers one side question at a time per session, each seeing the one before', async () => {
    const fx = fixture({ sessionId: 'conv-1' });
    const [a, b] = await Promise.all([fx.btw('send', 'slow first'), fx.btw('send', 'second')]);
    expect(fx.calls().map((call) => call.history.length)).toEqual([0, 1]);
    expect(b.messages.map((m) => m.content)).toEqual([
      'slow first',
      'A:slow first after 0',
      'second',
      'A:second after 1',
    ]);
    expect(a.messages.length).toBeGreaterThanOrEqual(2);
  });

  // Live check 2026-10-29: a question asked before the first turn vanished from
  // the side view as soon as that turn started the Claude conversation.
  it('a side thread from before the first turn carries into the conversation it starts', async () => {
    const fx = fixture();
    await fx.btw('send', 'before');
    writeFileSync(
      join(fx.sessionDir, 'claude-tmux-session.json'),
      JSON.stringify({ sessionId: 'conv-1', cwd: fx.tuiCwd, modelRef: 'claude-code/opus' }),
    );
    expect((await fx.btw('snapshot')).messages.map((m) => m.content)).toEqual(['before', 'A:before after 0']);
    await fx.btw('send', 'after');
    expect(fx.calls()[1].history).toEqual([{ question: 'before', response: 'A:before after 0' }]);
    // Bound to conv-1 now: a later conversation still starts empty.
    writeFileSync(
      join(fx.sessionDir, 'claude-tmux-session.json'),
      JSON.stringify({ sessionId: 'conv-2', cwd: fx.tuiCwd, modelRef: 'claude-code/opus' }),
    );
    expect((await fx.btw('snapshot')).messages).toEqual([]);
  });

  it('a new Claude conversation starts an empty side thread', async () => {
    const fx = fixture({ sessionId: 'conv-1' });
    await fx.btw('send', 'old');
    writeFileSync(
      join(fx.sessionDir, 'claude-tmux-session.json'),
      JSON.stringify({ sessionId: 'conv-2', cwd: fx.tuiCwd, modelRef: 'claude-code/opus' }),
    );
    expect((await fx.btw('snapshot')).messages).toEqual([]);
  });

  it('reports failures and keeps nothing from them', async () => {
    const fx = fixture({ sessionId: 'conv-1' });
    await expect(fx.btw('send', 'error please')).rejects.toThrow('side_question: boom');
    await expect(fx.btw('send', 'synthetic please')).rejects.toThrow('(No answer available.)');
    await expect(fx.btw('send', 'crash please')).rejects.toThrow('Not logged in');
    const snapshot = await fx.btw('snapshot');
    expect(snapshot).toEqual({ messages: [], pending: [], streaming: [] });
  });

  it('gives up on a side question that never answers', async () => {
    const fx = fixture({ sessionId: 'conv-1', timeoutMs: 400 });
    await expect(fx.btw('send', 'hang forever')).rejects.toThrow('Claude BTW timed out');
    expect((await fx.btw('snapshot')).pending).toEqual([]);
  });

  it('builds the headless side-question command line', () => {
    expect(buildClaudeBtwArgs({ modelRef: 'claude-code/haiku' })).not.toContain('--effort');
    expect(buildClaudeBtwArgs({ sessionId: 's', modelRef: 'claude-code/fable', thinking: 'max' })).toEqual(
      expect.arrayContaining(['--resume', 's', '--fork-session', '--model', 'fable', '--effort', 'max']),
    );
  });
});
