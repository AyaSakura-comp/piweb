import { describe, expect, it } from 'vitest';
import {
  MAX_SESSION_TITLE_GRAPHEMES,
  extractSessionTitle,
  generateSessionTitle,
} from '../src/agent/session-title.js';

const CASES: ReadonlyArray<readonly [prompt: string, expectedTitle: string]> = [
  ['幫我規劃台南兩日旅行', '台南兩日旅行'],
  ['請幫我修正登入頁面在手機上的排版錯誤', '登入頁面手機排版錯誤'],
  ['How do I deploy this Node.js app to Docker?', 'Node.js'],
  ['同一個模型會影響KV cache，可以改用CPU跑summary model嗎？', '模型KV cache'],
  ['日本旅行で使える交通系ICカードを比較して', '交通系ICカード'],
  ['帮我修复手机登录页面的布局错误', '手机登录页面布局错误'],
  ['Please analyze /tmp/server.log and explain the timeout', 'server.log'],
  ['# Task\nImplement OAuth callback validation', 'OAuth'],
  ['請摘要 https://example.com/articles/very-long-post', 'long post'],
  ['嗨', '嗨'],
  ['為什麼失敗\n\nQuoted context:\nThe API returned malformed JSON', '失敗'],
  ['\n\nAttachments:\ncrash-report.log', 'report.log'],
  ['幫我跑 2330 從 2024 到 2025 的回測報告', '2330回測報告'],
  ['新增語音輸入功能並修正手機版麥克風按鈕', '手機版麥克風按鈕'],
  ['Could you compare SQLite and PostgreSQL for this project?', 'SQLite'],
  ['分析這份財報並找出營收衰退的原因', '營收衰退原因'],
  ['幫我查 0050 最近一年的股價表現', '0050股價表現'],
  ['替這個 API 新增 rate limiting 與 CSRF 防護', 'CSRF防護'],
  ['幫我處理這個問題\n\nQuoted context:\nOAuth callback state mismatch', 'OAuth'],
  ['/backtest-report 2330 2024-01-01 2025-12-31', '2330'],
  ['這個錯誤是什麼意思：ECONNREFUSED 127.0.0.1:5432', '127.0.0.1'],
  ['Set up GitHub Actions to run tests and publish a Docker image', 'GitHub'],
  ['What is 2 + 2?', '2+2'],
  ['PostgreSQL の slow query を調査してください', 'slow query'],
  ['東京から京都まで新幹線と夜行バスを比較したい', '京都新幹線夜行バス'],
  ['新增刪除 session 功能，但不要影響 voice input 的未提交修改', '刪除session'],
  ['为什么这个 Python 脚本一直报 UnicodeDecodeError？', 'Python脚本'],
  ['帮我写一份上海五日游计划', '上海五日游计划'],
  ['登入後重新整理頁面會被登出，請協助修正', '頁面會登出'],
  ['Docker container keeps restarting with exit code 137', 'Docker'],
  ['Refactor src/auth/session.ts without changing public behavior', 'session.ts'],
  ['檢查使用者輸入是否可能造成 SQL injection', '使用者輸入SQL'],
  ['把會議記錄整理成三個待辦事項', '會議記錄待辦事項'],
  ['需要一個不使用 Transformer 的輕量 session title 方法', '輕量session'],
  ['部署完成後確認 Tailnet HTTPS 與 public Funnel 都是 HTTP 200', 'Funnel 200'],
];

describe('lightweight statistical session-title extraction', () => {
  it.each(CASES)('extracts a useful title from %j', (prompt, expectedTitle) => {
    expect(extractSessionTitle(prompt)).toBe(expectedTitle);
  });

  it('never exceeds the visible-character contract', () => {
    for (const [prompt] of CASES) {
      const title = extractSessionTitle(prompt);
      const length = [
        ...new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(title),
      ].length;
      expect(length).toBeLessThanOrEqual(MAX_SESSION_TITLE_GRAPHEMES);
    }
  });

  it('preserves the writing system instead of converting the first prompt', () => {
    expect(extractSessionTitle('帮我修复手机登录页面的布局错误')).toContain('登录');
    expect(extractSessionTitle('幫我修正手機登入頁面的排版錯誤')).toContain('登入');
  });

  it('does not punycode or lowercase Unicode URL text', () => {
    const title = extractSessionTitle('請摘要 https://Example.測試/文章');

    expect(title).not.toContain('xn--');
    expect(title).toMatch(/[Example測試文章]/u);
  });

  it('does not consume CJK content immediately following a URL', () => {
    expect(extractSessionTitle('請看https://example.com然後修正登入錯誤')).toContain('登入錯誤');
  });

  it('uses a leading quote-only source instead of the marker label', () => {
    expect(extractSessionTitle('Quoted context:\nOAuth callback state mismatch')).toBe('OAuth');
  });

  it('uses a complete bounded fallback when no candidate is rankable', () => {
    expect(extractSessionTitle('```ts\nconst answer = 42;\n```')).toBe('Session');
  });

  it('generates titles in-process without a binary or model path', async () => {
    await expect(generateSessionTitle('幫我規劃台南兩日旅行')).resolves.toBe('台南兩日旅行');
  });
});
