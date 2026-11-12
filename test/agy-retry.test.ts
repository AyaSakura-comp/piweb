import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 2026-11-12: 「另外如果出現這種伺服器壞掉的要做auto retry」 — agy answered
// "Our servers are experiencing high traffic right now, please try again in a
// minute. (UNAVAILABLE (code 503): No capacity available for model … on the
// server)" and the turn ended there. A fake agy plays Google's side here.

const fake = vi.hoisted(() => ({ root: '' }));

vi.mock('../src/session/path.js', async (original) => ({
  ...(await original<typeof import('../src/session/path.js')>()),
  resolveChannelSessionDir: () => fake.root,
}));
// agy's brain transcript, as the fake agy writes it.
vi.mock('../src/agent/agy-task-transcript.js', () => ({
  readAgyTaskTranscript: () => {
    const file = join(fake.root, 'transcript.jsonl');
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  },
}));
// Never touch the host's agy sign-in.
vi.mock('../src/agy-usage.js', () => ({ ensureFreshAgyToken: async () => undefined }));

const BUSY =
  'Our servers are experiencing high traffic right now, please try again in a minute. ' +
  '(UNAVAILABLE (code 503): No capacity available for model gemini-test-low on the server)';
const CONVERSATION = '12345678-1234-1234-1234-123456789012';

/**
 * Each run takes the next step of FAKE_AGY_PLAN: `busy` (records the message,
 * then fails with BUSY), `busy-early` (fails before recording it), `quota`,
 * or `ok`.
 */
const FAKE_AGY = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.FAKE_AGY_ROOT;
const calls = path.join(root, 'calls.jsonl');
const n = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\\n').filter(Boolean).length : 0;
const step = (process.env.FAKE_AGY_PLAN.split(',')[n] || 'ok').trim();
const emit = (x) => console.log(JSON.stringify(x));
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.once('line', (line) => {
  const input = JSON.parse(line).message.content;
  fs.appendFileSync(calls, JSON.stringify({ argv: process.argv.slice(2), input }) + '\\n');
  // Like agy 1.5.7 for a model whose id fixes its effort.
  const argv = process.argv.slice(2);
  if (process.env.FAKE_AGY_REJECT_EFFORT && argv.includes('--effort')) {
    const model = argv[argv.indexOf('--model') + 1];
    const effort = argv[argv.indexOf('--effort') + 1];
    emit({ event: 'result', result: { status: 'ERROR', error:
      'invalid model selection (--model "' + model + '" --effort "' + effort + '"): --model ' + model + ' conflicts with --effort=' + effort } });
    process.exit(1);
  }
  if (step !== 'busy-early') {
    fs.appendFileSync(path.join(root, 'transcript.jsonl'),
      JSON.stringify({ type: 'USER_INPUT', created_at: new Date().toISOString().replace(/\\.\\d+Z$/, 'Z') }) + '\\n');
  }
  emit({ event: 'init', conversation_id: ${JSON.stringify(CONVERSATION)} });
  if (step === 'ok') {
    emit({ event: 'result', result: { status: 'SUCCESS', response: 'Done after the retry.' } });
    process.exit(0);
  }
  const error = step === 'quota' ? 'RESOURCE_EXHAUSTED (code 429): Resets in 2h10m' : ${JSON.stringify(BUSY)};
  emit({ event: 'result', result: { status: 'ERROR', error } });
  process.exit(1);
});
`;

let savedBin = '';
let savedDelays: number[] = [];

beforeEach(async () => {
  fake.root = mkdtempSync(join(tmpdir(), 'agy-retry-'));
  const executable = join(fake.root, 'agy');
  writeFileSync(executable, FAKE_AGY, { mode: 0o700 });
  process.env.FAKE_AGY_ROOT = fake.root;
  const { config } = await import('../src/config.js');
  savedBin = config.agyBin;
  savedDelays = config.agyRetryDelaysMs;
  config.agyBin = executable;
  config.agyRetryDelaysMs = [20, 20, 20];
});

afterEach(async () => {
  const { config } = await import('../src/config.js');
  config.agyBin = savedBin;
  config.agyRetryDelaysMs = savedDelays;
  delete process.env.FAKE_AGY_ROOT;
  delete process.env.FAKE_AGY_PLAN;
  delete process.env.FAKE_AGY_REJECT_EFFORT;
  rmSync(fake.root, { recursive: true, force: true });
});

function calls(): Array<{ argv: string[]; input: string }> {
  const file = join(fake.root, 'calls.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

const notes = (events: any[]) =>
  events
    .filter((e) => e.type === 'message_update' && e.assistantMessageEvent?.type === 'thinking_end')
    .map((e) => String(e.assistantMessageEvent.content));

describe('agy turns that hit a passing server error', () => {
  it('run again by themselves, continuing the message agy already recorded', async () => {
    process.env.FAKE_AGY_PLAN = 'busy,busy,ok';
    const { invokeAgy, AGY_RETRY_CONTINUE } = await import('../src/agent/agy.js');
    const events: any[] = [];
    const result = await invokeAgy('channel', 'Original request 7731', {
      onEvent: (event) => {
        events.push(event);
      },
      isCurrent: () => true,
    });

    expect(result).toEqual({ ok: true, text: 'Done after the retry.' });
    const runs = calls();
    expect(runs).toHaveLength(3);
    expect(runs[0].input).toContain('Original request 7731');
    // agy had already written the message into the conversation: a retry
    // continues it rather than sending it a second time.
    for (const run of runs.slice(1)) {
      expect(run.input).toBe(AGY_RETRY_CONTINUE);
      expect(run.argv.join(' ')).toContain(`--conversation ${CONVERSATION}`);
    }
    const said = notes(events);
    expect(said).toHaveLength(2);
    expect(said[0]).toContain('Google 的模型伺服器目前滿載');
    expect(said[0]).toContain('第 1/3 次');
    expect(said[1]).toContain('第 2/3 次');
  });

  it('send the message again when agy failed before recording it', async () => {
    process.env.FAKE_AGY_PLAN = 'busy-early,ok';
    const { invokeAgy } = await import('../src/agent/agy.js');
    const result = await invokeAgy('channel', 'Original request 7731', { isCurrent: () => true });
    expect(result.ok).toBe(true);
    expect(calls().map((run) => run.input.includes('Original request 7731'))).toEqual([true, true]);
  });

  it('give up after the last wait and say how often they tried', async () => {
    process.env.FAKE_AGY_PLAN = 'busy,busy,busy,busy,ok';
    const { invokeAgy } = await import('../src/agent/agy.js');
    const result = await invokeAgy('channel', 'Original request 7731', { isCurrent: () => true });
    expect(calls()).toHaveLength(4);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('No capacity available');
    expect(result.error).toContain('已自動重試 3 次');
  });

  it('are not retried when the failure lasts (quota)', async () => {
    process.env.FAKE_AGY_PLAN = 'quota,ok';
    const { invokeAgy } = await import('../src/agent/agy.js');
    const result = await invokeAgy('channel', 'Original request 7731', { isCurrent: () => true });
    expect(calls()).toHaveLength(1);
    expect(result).toMatchObject({ ok: false });
    expect(result.error).toContain('quota exhausted');
    expect(result.error).not.toContain('自動重試');
  });

  it('stop waiting when a newer message interrupts the turn', async () => {
    process.env.FAKE_AGY_PLAN = 'busy,ok';
    const { config } = await import('../src/config.js');
    config.agyRetryDelaysMs = [60_000];
    const { invokeAgy } = await import('../src/agent/agy.js');
    const controller = new AbortController();
    const started = Date.now();
    const result = await invokeAgy('channel', 'Original request 7731', {
      signal: controller.signal,
      isCurrent: () => true,
      onEvent: (event) => {
        if (notes([event]).length) setTimeout(() => controller.abort(), 10);
      },
    });
    expect(result).toEqual({ ok: false, text: '', aborted: true });
    expect(Date.now() - started).toBeLessThan(30_000);
    await new Promise((done) => setTimeout(done, 100));
    expect(calls()).toHaveLength(1);
  });
});

describe('an agy run', () => {
  it('settles as soon as agy exits (stdout ended before the exit event)', async () => {
    process.env.FAKE_AGY_PLAN = 'ok';
    const { invokeAgy } = await import('../src/agent/agy.js');
    const started = Date.now();
    expect((await invokeAgy('channel', 'hello', { isCurrent: () => true })).ok).toBe(true);
    // It used to wait out the 2 s "a grandchild still holds stdout" window every time.
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

// 2026-11-13: agy 1.5.7 added gemini-4-hydrogen-xhigh and every turn on it
// failed with "--model gemini-4-hydrogen-xhigh conflicts with --effort=high".
describe('an agy model whose id fixes its effort', () => {
  it('runs without --effort when the id ends in -xhigh', async () => {
    process.env.FAKE_AGY_PLAN = 'ok';
    process.env.FAKE_AGY_REJECT_EFFORT = '1';
    const { invokeAgy } = await import('../src/agent/agy.js');
    const result = await invokeAgy('channel', 'Original request 7731', {
      model: 'agy/gemini-4-hydrogen-xhigh',
      thinking: 'high',
      isCurrent: () => true,
    });
    expect(result).toEqual({ ok: true, text: 'Done after the retry.' });
    const runs = calls();
    expect(runs).toHaveLength(1);
    expect(runs[0].argv).toContain('gemini-4-hydrogen-xhigh');
    expect(runs[0].argv).not.toContain('--effort');
  });

  it('runs again without --effort when agy says an unknown id conflicts with it', async () => {
    process.env.FAKE_AGY_PLAN = 'ok,ok';
    process.env.FAKE_AGY_REJECT_EFFORT = '1';
    const { invokeAgy } = await import('../src/agent/agy.js');
    const events: any[] = [];
    const result = await invokeAgy('channel', 'Original request 7731', {
      model: 'agy/gemini-9-ultra',
      thinking: 'high',
      isCurrent: () => true,
      onEvent: (event) => {
        events.push(event);
      },
    });
    expect(result).toEqual({ ok: true, text: 'Done after the retry.' });
    const runs = calls();
    expect(runs).toHaveLength(2);
    expect(runs[0].argv.join(' ')).toContain('--effort high');
    expect(runs[1].argv).not.toContain('--effort');
    // agy refused the flags before starting, so the message itself goes again.
    expect(runs[1].input).toContain('Original request 7731');
    expect(notes(events)).toEqual([]);
  });

  it('does not loop when agy still refuses without --effort', async () => {
    process.env.FAKE_AGY_PLAN = 'quota,quota';
    process.env.FAKE_AGY_REJECT_EFFORT = '1';
    const { invokeAgy } = await import('../src/agent/agy.js');
    const result = await invokeAgy('channel', 'Original request 7731', {
      model: 'agy/gemini-9-ultra',
      thinking: 'high',
      isCurrent: () => true,
    });
    expect(result.ok).toBe(false);
    expect(calls()).toHaveLength(2);
  });
});

describe('which agy failures pass by themselves', () => {
  it('reads the server-side ones and leaves the rest', async () => {
    const { isPassingAgyServerFailure } = await import('../src/agent/agy.js');
    expect(isPassingAgyServerFailure(BUSY)).toBe(true);
    expect(isPassingAgyServerFailure('API error (attempt 1): request failed: stream idle timeout (5m0s): context deadline exceeded')).toBe(true);
    expect(isPassingAgyServerFailure('Eligibility check failed: 502 Bad Gateway')).toBe(true);
    expect(isPassingAgyServerFailure('RESOURCE_EXHAUSTED (code 429): Resets in 2h')).toBe(false);
    expect(isPassingAgyServerFailure('UNAUTHENTICATED: please sign in')).toBe(false);
    expect(isPassingAgyServerFailure('timeout waiting for response')).toBe(false);
    expect(isPassingAgyServerFailure('')).toBe(false);
  });

  it('takes its waits from AGY_RETRY_DELAYS', async () => {
    const { parseRetryDelays } = await import('../src/config.js');
    expect(parseRetryDelays('15s,30s,60s,120s')).toEqual([15_000, 30_000, 60_000, 120_000]);
    expect(parseRetryDelays('500ms, 2m, junk')).toEqual([500, 120_000]);
    expect(parseRetryDelays('off')).toEqual([]);
  });
});
