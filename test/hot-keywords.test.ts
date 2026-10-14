import { describe, expect, it } from 'vitest';
import { messageKeywords, rankHotKeywords } from '../src/agent/hot-keywords.js';

describe('hot keywords', () => {
  it('splits Chinese and English into words and drops filler, quotes, commands and numbers', () => {
    expect([...messageKeywords('有沒有辦法 commit and push 到 piweb 2026')]).toEqual(['辦法', 'commit', 'push', 'piweb']);
    expect([...messageKeywords('↪ 引用：「部署 qwen 模型」\n可以測試嗎')]).toEqual(['測試']);
    expect(messageKeywords('/pi model').size).toBe(0);
    expect(messageKeywords('ok pi go').size).toBe(0);
  });

  it('counts each word once per message and ranks by messages, ties alphabetically', () => {
    const ranked = rankHotKeywords([
      'commit commit and push',
      'Commit and push',
      'deploy 測試',
      'deploy 測試',
      'push once more',
      'qwen',
    ]);
    expect(ranked).toEqual([
      { word: 'push', count: 3 },
      { word: 'commit', count: 2 },
      { word: 'deploy', count: 2 },
      { word: '測試', count: 2 },
    ]);
  });

  it('keeps at most ten', () => {
    const many = Array.from({ length: 15 }, (_, i) => `keyword${String.fromCharCode(97 + i)}`);
    expect(rankHotKeywords([...many, ...many].map((word) => word))).toHaveLength(10);
  });
});
