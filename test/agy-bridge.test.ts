import { mkdtempSync, rmSync } from 'node:fs';
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
  translateAgyEvent,
  writeAgyConversationId,
} = await import('../src/agent/agy.js');

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
