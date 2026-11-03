import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VOICE_SETTINGS,
  diffRuns,
  dictationOptions,
  freshRanges,
  glowLevel,
  meterBars,
  mergeOutsideEdit,
  readVoiceSettings,
  saveVoiceSettings,
  typedText,
  voiceStatus,
} from '../public/voice-ime.js';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

describe('voice input settings', () => {
  it('defaults to the Komorebi server, TEA for the sentences and its Gemma 4 E2B on the CPU', () => {
    const settings = readVoiceSettings(memoryStorage());
    expect(settings).toEqual(DEFAULT_VOICE_SETTINGS);
    expect(dictationOptions(settings)).toEqual({
      url: 'wss://komorebi.crayfish-monitor.ts.net/v1/realtime',
      processing: true,
      model: 'komorebi-tea-npu-e2b',
      refine: 'npu-e2b',
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
      processing: true,
      model: 'komorebi-tea',
      refine: { provider: 'openai', base_url: 'https://api.example/v1', model: 'tidy', api_key: 'k' },
    });
  });

  it('with the clean-up off, sentences go in as heard (refine: false)', () => {
    const storage = memoryStorage();
    saveVoiceSettings({ ...DEFAULT_VOICE_SETTINGS, tidy: false }, storage);
    const settings = readVoiceSettings(storage);
    expect(settings.tidy).toBe(false);
    expect(dictationOptions(settings)).toMatchObject({ model: 'komorebi-tea-npu-e2b', refine: false });
    // Off wins over a custom clean-up API too; on by default.
    expect(
      dictationOptions({ ...settings, refineUrl: 'https://api.example/v1' }).refine,
    ).toBe(false);
    expect(readVoiceSettings(memoryStorage()).tidy).toBe(true);
    expect(readVoiceSettings(memoryStorage({ 'piweb.voiceIme.settings': '{"tidy":"no"}' })).tidy).toBe(true);
  });

  it('通話模式收音 off records without the browser processing (processing: false)', () => {
    const storage = memoryStorage();
    saveVoiceSettings({ ...DEFAULT_VOICE_SETTINGS, callAudio: false }, storage);
    const settings = readVoiceSettings(storage);
    expect(settings.callAudio).toBe(false);
    expect(dictationOptions(settings).processing).toBe(false);
    expect(dictationOptions({ ...settings, tidy: false }).processing).toBe(false);
    expect(readVoiceSettings(memoryStorage()).callAudio).toBe(true);
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

  it('room noise stays dark and quiet iPhone speech still lights the ring', () => {
    // 100 ms readings from a real iPhone capture (2026-10-31): pauses 0.0006,
    // speech 0.0031 median, 0.0065 at the 90th percentile.
    expect(glowLevel(0)).toBe(0);
    expect(glowLevel(0.0006)).toBe(0);
    expect(glowLevel(0.0031)).toBeGreaterThan(0.25);
    expect(glowLevel(0.0031)).toBeLessThan(0.4);
    expect(glowLevel(0.0065)).toBeGreaterThan(0.5);
    expect(glowLevel(0.5)).toBe(1);
  });

  it('the meter puts the newest level in the middle and the two before it outside', () => {
    expect(meterBars([0, 0, 0])).toEqual([0.17, 0.17, 0.17, 0.17, 0.17]);
    const bars = meterBars([1, 0.5, 0.5]);
    expect(bars[2]).toBe(1);
    expect(bars[1]).toBe(bars[3]);
    expect(bars[0]).toBe(bars[4]);
    expect(bars[0]).toBeLessThan(bars[1]);
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

describe('voice status', () => {
  const backends = (asr: string, refine: string, reason = '') => ({
    type: 'komorebi.backends',
    backends: [
      { role: 'asr', name: 'sensevoice', state: asr, reason: asr === 'unavailable' ? reason : '' },
      { role: 'refine', name: 'npu-e2b', state: refine, reason: refine === 'unavailable' ? reason : '' },
    ],
  });

  it('says it is opening until the microphone listens', () => {
    expect(voiceStatus({ connecting: true }).placeholder).toBe('語音輸入開啟中…');
    expect(voiceStatus({}).placeholder).toBe('點一下畫面開始收音…');
    expect(voiceStatus({ listening: true }).placeholder).toBe('說話即可輸入…');
  });

  it('says the recognizer is starting, and only then that speech goes in', () => {
    const starting = voiceStatus({ listening: true, service: backends('starting', 'ready') });
    expect(starting).toEqual(expect.objectContaining({ placeholder: '語音服務啟動中…', failed: false }));
    expect(starting.title).toContain('說的話會在啟動後出現');
    expect(voiceStatus({ listening: true, service: backends('ready', 'ready') }).placeholder).toBe('說話即可輸入…');
  });

  it('a clean-up model starting or missing still takes speech, as heard', () => {
    expect(voiceStatus({ listening: true, service: backends('ready', 'starting') }).placeholder).toBe(
      '可說話，整理模型啟動中',
    );
    const missing = voiceStatus({ listening: true, service: backends('ready', 'unavailable', '主機記憶體不足') });
    expect(missing).toEqual({
      placeholder: '說話即可輸入…',
      title: '語音輸入中：整理模型無法啟動（主機記憶體不足），照原句輸入（點一下關閉）',
      failed: false,
    });
  });

  it('a recognizer that cannot start reads as a failure, with the reason', () => {
    expect(voiceStatus({ listening: true, service: backends('unavailable', 'ready', '服務已停用') })).toEqual({
      placeholder: '語音辨識無法啟動（服務已停用）',
      title: '語音辨識無法啟動（服務已停用）（點一下關閉）',
      failed: true,
    });
  });

  it('a microphone being revived says so, ahead of a reconnect', () => {
    const state = voiceStatus({ listening: true, reviving: true, reconnecting: true });
    expect(state).toEqual(expect.objectContaining({ placeholder: '麥克風恢復中…', failed: false }));
  });

  it('a dropped connection that is coming back reads as reconnecting, not as a failure', () => {
    const state = voiceStatus({ listening: true, reconnecting: true, service: backends('ready', 'ready') });
    expect(state).toEqual(expect.objectContaining({ placeholder: '語音重新連線中…', failed: false }));
    expect(state.title).toContain('點一下關閉');
    expect(voiceStatus({ reconnecting: true }).placeholder).toBe('點一下畫面開始收音…'); // not listening
  });

  it('a connection or microphone error comes first; a server without the event reads as before', () => {
    expect(voiceStatus({ error: '連線中斷', listening: true, service: backends('starting', 'ready') }).placeholder).toBe(
      '語音輸入：連線中斷',
    );
    expect(voiceStatus({ listening: true, service: null }).title).toBe('語音輸入中（點一下關閉）');
  });
});
