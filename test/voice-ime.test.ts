import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VOICE_SETTINGS,
  diffRuns,
  dictationOptions,
  freshRanges,
  glowLevel,
  mergeOutsideEdit,
  readVoiceSettings,
  saveVoiceSettings,
  typedText,
} from '../public/voice-ime.js';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

describe('voice input settings', () => {
  it('defaults to the Komorebi server and its Gemma 4 E2B on the CPU', () => {
    const settings = readVoiceSettings(memoryStorage());
    expect(settings).toEqual(DEFAULT_VOICE_SETTINGS);
    expect(dictationOptions(settings)).toEqual({
      url: 'wss://komorebi.crayfish-monitor.ts.net/v1/realtime',
      model: 'komorebi-smart-cpu-e2b',
      refine: 'cpu-e2b',
    });
  });

  it('a clean-up API URL becomes an OpenAI-compatible refine endpoint', () => {
    const storage = memoryStorage();
    saveVoiceSettings(
      { url: 'wss://voice.example/v1/realtime', refineUrl: ' https://api.example/v1 ', refineModel: 'tidy', refineKey: 'k' },
      storage,
    );
    const settings = readVoiceSettings(storage);
    expect(settings.refineUrl).toBe('https://api.example/v1');
    expect(dictationOptions(settings)).toEqual({
      url: 'wss://voice.example/v1/realtime',
      model: 'komorebi-smart',
      refine: { provider: 'openai', base_url: 'https://api.example/v1', model: 'tidy', api_key: 'k' },
    });
  });

  it('leaves the key out when there is none and survives broken storage', () => {
    expect(
      dictationOptions({ ...DEFAULT_VOICE_SETTINGS, refineUrl: 'https://api.example/v1' }).refine,
    ).toEqual({ provider: 'openai', base_url: 'https://api.example/v1', model: 'default' });
    expect(readVoiceSettings(memoryStorage({ 'piweb.voiceIme.settings': '{' }))).toEqual(
      DEFAULT_VOICE_SETTINGS,
    );
  });
});

describe('voice input text', () => {
  it('what the user typed is the box minus the sentence still being heard', () => {
    expect(typedText('今天下午開會改成', '改成')).toBe('今天下午開會');
    expect(typedText('今天下午開會', '')).toBe('今天下午開會');
    // The live tail was edited away: everything in the box is typed text.
    expect(typedText('今天下午', '改成')).toBe('今天下午');
  });

  it('an outside edit keeps its text and any sentence the server only appended', () => {
    expect(mergeOutsideEdit('重新寫的', '舊草稿', '舊草稿新的一句。')).toBe('重新寫的新的一句。');
    // A rewrite of text that is no longer in the box is dropped.
    expect(mergeOutsideEdit('重新寫的', '舊草稿', '改過的草稿')).toBe('重新寫的');
  });

  it('room noise stays dark and speech lights the ring', () => {
    expect(glowLevel(0)).toBe(0);
    expect(glowLevel(0.01)).toBe(0);
    expect(glowLevel(0.07)).toBeGreaterThan(0.4);
    expect(glowLevel(0.5)).toBe(1);
  });
});

describe('what the clean-up changed', () => {
  const marked = (before: string, after: string) =>
    freshRanges(before, after).map(([start, end]) => after.slice(start, end));

  it('marks only what the rewrite put in', () => {
    // Filler dropped, punctuation added: only the period is new.
    expect(marked('嗯今天下午三點開會', '今天下午三點開會。')).toEqual(['。']);
    // A spoken correction rewrites an earlier sentence.
    expect(marked('明天三點開會。不對改成四點', '明天四點開會。')).toEqual(['四']);
    expect(marked('我們用 pi web', '我們用 Piweb。')).toEqual(['P', '。']);
  });

  it('nothing changed, a pure deletion, and a first draft', () => {
    expect(freshRanges('一樣的。', '一樣的。')).toEqual([]);
    expect(freshRanges('嗯一樣的。', '一樣的。')).toEqual([]);
    expect(freshRanges('', '全部是新的。')).toEqual([[0, 6]]);
  });

  it('a middle too large to diff is marked whole', () => {
    const before = 'a' + 'x'.repeat(600) + 'b';
    const after = 'a' + 'y'.repeat(600) + 'b';
    expect(freshRanges(before, after)).toEqual([[1, 601]]);
  });
});

describe('how the clean-up changed the text', () => {
  it('keeps, puts in and takes out, in order', () => {
    expect(diffRuns('嗯今天下午三點開會', '今天下午三點開會。')).toEqual([
      ['-', '嗯'],
      ['=', '今天下午三點開會'],
      ['+', '。'],
    ]);
    expect(diffRuns('明天三點開會。不對改成四點', '明天四點開會。')).toEqual([
      ['=', '明天'],
      ['-', '三'],
      ['+', '四'],
      ['=', '點開會。'],
      ['-', '不對改成四點'],
    ]);
  });

  it('the kept and put-in runs spell the new text, the kept and taken-out ones the old', () => {
    const before = '那個我們下禮拜一，呃，下禮拜二開會';
    const after = '我們下禮拜二開會。';
    const runs = diffRuns(before, after);
    expect(runs.filter(([op]) => op !== '-').map(([, t]) => t).join('')).toBe(after);
    expect(runs.filter(([op]) => op !== '+').map(([, t]) => t).join('')).toBe(before);
  });
});
