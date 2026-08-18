import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveChannelSessionDirMock } = vi.hoisted(() => ({
  resolveChannelSessionDirMock: vi.fn(),
}));

vi.mock('../src/session/path.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/session/path.js')>()),
  resolveChannelSessionDir: resolveChannelSessionDirMock,
}));

const {
  agyModelId,
  formatAgyError,
  isAgyModelRef,
  modelIdEncodesEffort,
  parseAgyModels,
  readAgyConversationId,
  convertLocalMediaLinks,
  createAgyEventTranslator,
  describeToolCall,
  humanizeDuration,
  translateAgyEvent,
  unwrapUntilDoneGoal,
  writeAgyConversationId,
} = await import('../src/agent/agy.js');

const { UNTIL_DONE_MARKER } = await import('../src/agent/invoke.js');

describe('agy model refs', () => {
  it('recognises only the agy provider prefix', () => {
    expect(isAgyModelRef('agy/gemini-3.1-pro-high')).toBe(true);
    expect(isAgyModelRef('AGY/gemini-3.1-pro-high')).toBe(true);
    expect(isAgyModelRef('local-llama/qwen3.6-35b-q4')).toBe(false);
    expect(isAgyModelRef('openai-codex/gpt-5.6-sol')).toBe(false);
    expect(isAgyModelRef('')).toBe(false);
    expect(isAgyModelRef(undefined)).toBe(false);
  });

  it('strips the prefix to the id agy expects', () => {
    expect(agyModelId('agy/gemini-3.1-pro-high')).toBe('gemini-3.1-pro-high');
    expect(agyModelId('agy/claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
  });
});

describe('modelIdEncodesEffort', () => {
  // agy rejects `--model gemini-3.5-flash-low --effort medium` outright with
  // "conflicts with --effort", so the suffix must suppress the flag.
  it('detects the effort suffix agy bakes into most model ids', () => {
    expect(modelIdEncodesEffort('gemini-3.5-flash-low')).toBe(true);
    expect(modelIdEncodesEffort('gemini-3.1-pro-high')).toBe(true);
    expect(modelIdEncodesEffort('gpt-oss-120b-medium')).toBe(true);
  });

  it('leaves ids without an effort suffix free to take --effort', () => {
    expect(modelIdEncodesEffort('claude-sonnet-4-6')).toBe(false);
    expect(modelIdEncodesEffort('claude-opus-4-6-thinking')).toBe(false);
    expect(modelIdEncodesEffort('')).toBe(false);
  });
});

describe('parseAgyModels', () => {
  it('parses the two-column listing and ignores the status line', () => {
    const models = parseAgyModels(
      'Fetching available models...\n' +
        'gemini-3.1-pro-high\tGemini 3.1 Pro (High)\n' +
        'gemini-3.7-flash-low\tGemini 3.7 Flash (Low)\n' +
        '\n',
    );

    expect(models).toHaveLength(2);
    expect(models[0]).toEqual({
      ref: 'agy/gemini-3.1-pro-high',
      provider: 'agy',
      id: 'gemini-3.1-pro-high',
      name: 'Gemini 3.1 Pro (High)',
      reasoning: true,
      supportsXhigh: false,
    });
    expect(models[1].ref).toBe('agy/gemini-3.7-flash-low');
  });

  it('returns nothing for empty or malformed output', () => {
    expect(parseAgyModels('')).toEqual([]);
    expect(parseAgyModels('Fetching available models...\n')).toEqual([]);
  });
});

describe('translateAgyEvent', () => {
  it('extracts the conversation id from init', () => {
    const out = translateAgyEvent({ event: 'init', conversation_id: 'abc-123', init: {} });
    expect(out.conversationId).toBe('abc-123');
    expect(out.events).toEqual([]);
  });

  it('maps an active tool step onto a pi toolcall_end event', () => {
    const out = translateAgyEvent({
      event: 'step_update',
      step_update: {
        step_index: 3,
        state: 'ACTIVE',
        step_type: 'tool',
        tool_name: 'run_command',
        tool_info: { name: 'run_command', parameters: { CommandLine: 'echo hi' } },
      },
    });

    expect(out.events).toHaveLength(1);
    expect(out.events[0]).toEqual({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'toolcall_end',
        toolCall: { name: 'run_command', arguments: { CommandLine: 'echo hi' } },
      },
    });
  });

  it('maps a finished tool step onto a role=tool message_end event', () => {
    const out = translateAgyEvent({
      event: 'step_update',
      step_update: {
        state: 'DONE',
        step_type: 'tool',
        tool_name: 'run_command',
        tool_info: { name: 'run_command', parameters: {}, output: 'BRIDGE_TOOL_PROBE\r\n' },
      },
    });

    expect(out.events[0]).toEqual({
      type: 'message_end',
      message: { role: 'tool', content: [{ type: 'text', text: 'BRIDGE_TOOL_PROBE\r\n' }] },
    });
  });

  it('accumulates assistant text deltas without emitting events', () => {
    const out = translateAgyEvent({
      event: 'step_update',
      step_update: { state: 'ACTIVE', step_type: 'agent_response', text_delta: 'PIWEB' },
    });
    expect(out.textDelta).toBe('PIWEB');
    expect(out.events).toEqual([]);
  });

  it('surfaces reasoning steps as thinking blocks on completion only', () => {
    const active = translateAgyEvent({
      event: 'step_update',
      step_update: { state: 'ACTIVE', step_type: 'thinking', text_delta: 'half a thought' },
    });
    expect(active.events).toEqual([]);

    const done = translateAgyEvent({
      event: 'step_update',
      step_update: { state: 'DONE', step_type: 'thinking', text_delta: 'a whole thought' },
    });
    expect(done.events[0]).toEqual({
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_end', content: 'a whole thought' },
    });
  });

  it('carries agy own error text out of a failed result event', () => {
    const out = translateAgyEvent({
      event: 'result',
      result: {
        conversation_id: '',
        status: 'ERROR',
        response: '',
        error: '--model gemini-3.5-flash-low conflicts with --effort=medium',
      },
    });
    expect(out.status).toBe('ERROR');
    expect(out.errorText).toBe('--model gemini-3.5-flash-low conflicts with --effort=medium');
  });

  it('takes the final response and status from the result event', () => {
    const out = translateAgyEvent({
      event: 'result',
      result: { conversation_id: 'abc-123', status: 'SUCCESS', response: 'done\n' },
    });
    expect(out.finalText).toBe('done\n');
    expect(out.status).toBe('SUCCESS');
    expect(out.conversationId).toBe('abc-123');
  });

  it('ignores steps it has no mapping for, and junk input', () => {
    expect(translateAgyEvent({ event: 'step_update', step_update: { step_type: 'checkpoint' } }).events).toEqual([]);
    expect(translateAgyEvent(null).events).toEqual([]);
    expect(translateAgyEvent({ event: 'mystery' }).events).toEqual([]);
  });
});

describe('unwrapUntilDoneGoal', () => {
  // agy has no --until-done loop, so the sentinel must never reach the prompt.
  it('replaces the sentinel with an autonomous instruction carrying the goal', () => {
    const out = unwrapUntilDoneGoal(
      `[Web user: Alice]\n${UNTIL_DONE_MARKER} ship the release notes`,
    );
    expect(out).not.toContain(UNTIL_DONE_MARKER);
    expect(out).toContain('Goal: ship the release notes');
    expect(out).toContain('[Web user: Alice]');
    expect(out).toContain('without pausing to ask');
  });

  it('leaves an ordinary message untouched', () => {
    expect(unwrapUntilDoneGoal('just a normal question')).toBe('just a normal question');
  });

  it('drops a sentinel with no goal rather than emitting it', () => {
    const out = unwrapUntilDoneGoal(`hello ${UNTIL_DONE_MARKER}   `);
    expect(out).toBe('hello');
  });
});

describe('formatAgyError', () => {
  it('turns a quota failure into a readable line with the reset time', () => {
    const text = formatAgyError(
      'ERROR',
      'RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 4h5m58s.',
    );
    expect(text).toBe('agy (Gemini) quota exhausted — resets in 4h5m58s.');
  });

  it('still reports quota exhaustion when no reset time is given', () => {
    expect(formatAgyError('ERROR', 'code 429 quota')).toContain('quota exhausted');
  });

  // agy's own wording for --print-timeout reads like the model went silent; it
  // actually means our own cap cut the turn, and the conversation survives.
  it('explains a print-timeout instead of repeating agy raw wording', () => {
    const text = formatAgyError('ERROR', 'timeout waiting for response');
    expect(text).toContain('print-timeout');
    expect(text).toContain('對話本身沒有遺失');
    expect(text).toContain('AGY_PRINT_TIMEOUT');
  });

  it('passes other failures through with their status', () => {
    expect(formatAgyError('FAILED', 'model unavailable')).toBe(
      'agy failed (FAILED): model unavailable',
    );
    expect(formatAgyError('exit 1', '')).toBe('agy failed (exit 1)');
  });
});

describe('conversation id persistence', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agy-test-'));
    resolveChannelSessionDirMock.mockReturnValue(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('round-trips a conversation id for a channel', () => {
    expect(readAgyConversationId('web_abc')).toBeUndefined();
    writeAgyConversationId('web_abc', 'e1ea9c7e-2a33-44bf-b341-646979431a71');
    expect(readAgyConversationId('web_abc')).toBe('e1ea9c7e-2a33-44bf-b341-646979431a71');
  });

  it('treats a corrupt store as no conversation rather than throwing', () => {
    writeAgyConversationId('web_abc', 'x');
    const { writeFileSync } = require('node:fs');
    writeFileSync(join(dir, 'agy-conversation.json'), 'not json', 'utf8');
    expect(readAgyConversationId('web_abc')).toBeUndefined();
  });
});

describe('convertLocalMediaLinks', () => {
  let dir: string;
  let png: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agy-media-'));
    png = join(dir, 'chart.png');
    writeFileSync(png, 'not really a png');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // agy writes markdown; the attachment pipeline only reads pi's outbox marker.
  it('turns a markdown image of a real local file into an outbox marker', () => {
    const out = convertLocalMediaLinks(`成果如下：\n![benchmark chart](${png})`, dir);
    expect(out).toContain(`[[file: ${png}]]`);
    expect(out).not.toContain('![');
  });

  it('keeps the caption when the link is not an image embed', () => {
    const out = convertLocalMediaLinks(`[報告](${png})`, dir);
    expect(out).toBe(`報告 [[file: ${png}]]`);
  });

  it('resolves a relative path against the run cwd', () => {
    const out = convertLocalMediaLinks('![c](chart.png)', dir);
    expect(out).toContain(`[[file: ${png}]]`);
  });

  it('unwraps a file:// URL', () => {
    const out = convertLocalMediaLinks(`![c](file://${png})`, dir);
    expect(out).toContain(`[[file: ${png}]]`);
  });

  it('leaves http links and ordinary prose alone', () => {
    const text = 'see [docs](https://example.com/a.png) and ![x](https://e.com/b.png)';
    expect(convertLocalMediaLinks(text, dir)).toBe(text);
  });

  it('leaves a link to a file that does not exist alone', () => {
    const text = `![missing](${join(dir, 'nope.png')})`;
    expect(convertLocalMediaLinks(text, dir)).toBe(text);
  });

  it('leaves a directory alone', () => {
    const text = `![d](${dir})`;
    expect(convertLocalMediaLinks(text, dir)).toBe(text);
  });

  it('converts every image in a reply', () => {
    const second = join(dir, 'b.png');
    writeFileSync(second, 'x');
    const out = convertLocalMediaLinks(`![a](${png}) 與 ![b](${second})`, dir);
    expect(out).toContain(`[[file: ${png}]]`);
    expect(out).toContain(`[[file: ${second}]]`);
  });
});

describe('createAgyEventTranslator', () => {
  const response = (text: string) => ({
    event: 'step_update',
    step_update: { state: 'DONE', step_type: 'agent_response', text_delta: text },
  });
  const toolCall = (name: string) => ({
    event: 'step_update',
    step_update: { state: 'ACTIVE', step_type: 'tool', tool_name: name, tool_info: { name } },
  });
  const result = (text: string) => ({
    event: 'result',
    result: { conversation_id: 'c', status: 'SUCCESS', response: text },
  });
  const thinkingTexts = (events: any[]) =>
    events
      .filter((e) => e.assistantMessageEvent?.type === 'thinking_end')
      .map((e) => e.assistantMessageEvent.content);

  it('shows narration that precedes a tool call, before that call', () => {
    const translate = createAgyEventTranslator();
    expect(translate(response('先檢查環境')).events).toEqual([]);

    const out = translate(toolCall('run_command')).events;
    expect(thinkingTexts(out)).toEqual(['先檢查環境']);
    // Order matters: the narration explains the call that follows it.
    expect(out[0].assistantMessageEvent.type).toBe('thinking_end');
    expect(out[1].assistantMessageEvent.type).toBe('toolcall_end');
  });

  it('never emits the final answer as a thinking block', () => {
    const translate = createAgyEventTranslator();
    translate(response('這是最終答案'));
    const out = translate(result('這是最終答案'));
    expect(thinkingTexts(out.events)).toEqual([]);
    expect(out.finalText).toBe('這是最終答案');
  });

  it('emits one block per narration step across a multi-step run', () => {
    const translate = createAgyEventTranslator();
    const seen: string[] = [];
    for (const raw of [
      response('步驟一'),
      toolCall('a'),
      response('步驟二'),
      toolCall('b'),
      response('結論'),
      result('結論'),
    ]) {
      seen.push(...thinkingTexts(translate(raw).events));
    }
    expect(seen).toEqual(['步驟一', '步驟二']);
  });

  it('ignores whitespace-only narration', () => {
    const translate = createAgyEventTranslator();
    translate(response('   \n '));
    expect(thinkingTexts(translate(toolCall('a')).events)).toEqual([]);
  });

  it('still passes tool events through untouched when there is no narration', () => {
    const translate = createAgyEventTranslator();
    const out = translate(toolCall('run_command')).events;
    expect(out).toHaveLength(1);
    expect(out[0].assistantMessageEvent.type).toBe('toolcall_end');
  });
});

describe('describeToolCall', () => {
  it('names the command so a stalled call is recognisable', () => {
    expect(describeToolCall('run_command', { CommandLine: './scripts/verify_x.sh' })).toBe(
      'run_command ./scripts/verify_x.sh',
    );
  });

  it('falls back to the bare tool name when there is nothing useful', () => {
    expect(describeToolCall('manage_task', {})).toBe('manage_task');
    expect(describeToolCall('view_file', undefined)).toBe('view_file');
    expect(describeToolCall('x', { n: 5 })).toBe('x');
  });

  it('collapses whitespace and truncates a long argument', () => {
    const out = describeToolCall('run_command', { CommandLine: 'a\n b  c' });
    expect(out).toBe('run_command a b c');
    const long = describeToolCall('run_command', { CommandLine: 'x'.repeat(200) });
    expect(long.length).toBeLessThan(100);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('humanizeDuration', () => {
  it('reads naturally at each scale', () => {
    expect(humanizeDuration(45_000)).toBe('45 秒');
    expect(humanizeDuration(120_000)).toBe('2 分');
    expect(humanizeDuration(150_000)).toBe('2 分 30 秒');
  });
});
