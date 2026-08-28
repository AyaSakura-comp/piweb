export const MAX_SESSION_TITLE_GRAPHEMES = 10;

const MAX_RANKER_SOURCE_GRAPHEMES = 512;
const MAX_CLAUSES = 8;
const MAX_TOKENS_PER_CLAUSE = 64;
const MAX_CANDIDATE_TOKEN_WINDOW = 16;

const wordSegmenter = new Intl.Segmenter('und', { granularity: 'word' });
const graphemeSegmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });

const STOP_WORDS = new Set(
  `請 请 請問 请问 幫 帮 幫我 帮我 我 想 要 可以 可不可以 能否 麻煩 麻烦 協助 协助 一下
   的 了 在 上 下 中 裡 里 這 这 那 這個 这个 這份 这份 這段 这段 一個 一个 一份 一段
   同一個 同一个 同 會 会 是否 嗎 吗 呢 跟 和 與 与 或 用 使用 改用 跑 把 為什麼
   为什么 怎麼 怎么 如何 什麼 什么 他的 有沒有 有没有 從 从 到 至 并 並 且 並且
   并且 以及 最近 一年 替 但 不要 但不要 是 意思 份 成 で を は が に の と して し
   て ください お願い この その から まで したい please can could would you me my the a
   an this that to for of on in and or do does how what why is are be it its i we want need help
   with from as about task question request after before up 一直 くだ さい した い 後 后 被 重新
   可能 造成 不 都是 三個 三个 然後 然后 請看 请看 http https container keeps exit code
   請求 请求 問題 问题`
    .split(/\s+/u)
    .filter(Boolean),
);

const ACTION_WORDS = new Set(
  `規劃 规划 安排 修正 修复 修復 分析 解釋 解释 比較 比较 產生 产生 建立 新增 修改 實作
   实作 實現 实现 部署 查看 查 告訴 告诉 了解 確認 确认 測試 测试 摘要 影響 影响
   處理 处理 說明 说明 寫 写 翻譯 翻译 生成 找出 提醒 讀取 读取 輸出 输出 需要 檢查
   检查 完成 報 报 調査 implement fix deploy explain analyze compare create add update generate
   test summarize help plan use set run publish refactor investigate configure enable enabling
   restarting 整理 使える`
    .split(/\s+/u)
    .filter(Boolean),
);

const WEAK_WORDS = new Set(
  `app application project page webpage 功能 東西 东西 事情 issue problem image`
    .split(/\s+/u)
    .filter(Boolean),
);

/** Interpretable linear weights for the tiny candidate-span ranker. */
const LINEAR_RANKER_WEIGHTS = {
  contentTokens: 1.8,
  technicalTokens: 1.15,
  fileToken: 1.7,
  preferredLength: 0.14,
  stopTokens: -2.4,
  actionTokens: -0.9,
  weakTokens: -0.7,
  clauseIndex: -1.5,
  skippedTokens: -0.9,
  startsClause: 0.6,
  endsClause: 0.45,
  overPreferredLength: -0.3,
} as const;

type TokenKind = 'stop' | 'action' | 'content';

interface CandidateContext {
  clauseIndex: number;
  skippedTokens: number;
  startsClause: boolean;
  endsClause: boolean;
}

interface RankedCandidate {
  text: string;
  score: number;
  contentTokens: number;
  length: number;
  clauseIndex: number;
}

function graphemes(value: string): string[] {
  return [...graphemeSegmenter.segment(value)].map((part) => part.segment);
}

function graphemeLength(value: string): number {
  return [...graphemeSegmenter.segment(value)].length;
}

function isLatinToken(value: string): boolean {
  return /^[A-Za-z0-9_.+/-]+$/u.test(value);
}

function joinTokens(tokens: readonly string[]): string {
  let result = '';
  let previous = '';
  for (const token of tokens) {
    if (result && isLatinToken(token) && isLatinToken(previous)) result += ' ';
    result += token;
    previous = token;
  }
  return result;
}

function normalizeSource(value: string): string {
  return value
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(
      /(?:[\w.-]+\/)+([\w.-]+\.(?:ts|js|json|log|md|py|html|css|yml|yaml|pdf))/giu,
      '$1',
    )
    .replace(/\b20\d{2}-\d{2}-\d{2}\b/gu, ' ')
    .replace(/(?:從|从)\s*20\d{2}\s*(?:到|至)\s*20\d{2}/gu, ' ')
    .replace(/^#+\s*/gmu, '')
    .replace(/[\t ]+/gu, ' ')
    .trim();
}

function bounded(value: string): string {
  return graphemes(value).slice(0, MAX_RANKER_SOURCE_GRAPHEMES).join('');
}

interface SourceMarker {
  index: number;
  contentStart: number;
}

function findSourceMarker(value: string, label: string): SourceMarker | undefined {
  const leading = `${label}:\n`;
  if (value.startsWith(leading)) return { index: 0, contentStart: leading.length };

  const embedded = `\n\n${label}:\n`;
  const index = value.indexOf(embedded);
  return index < 0 ? undefined : { index, contentStart: index + embedded.length };
}

function sourceSections(value: string): string[] {
  const quote = findSourceMarker(value, 'Quoted context');
  const attachments = findSourceMarker(value, 'Attachments');
  const firstMarker = [quote?.index, attachments?.index]
    .filter((index): index is number => index !== undefined)
    .sort((left, right) => left - right)[0];
  const primary = firstMarker === undefined ? value : value.slice(0, firstMarker);
  const sections = [primary];

  if (quote) {
    const end = attachments && attachments.index > quote.index ? attachments.index : value.length;
    sections.push(value.slice(quote.contentStart, end));
  }
  if (attachments) sections.push(value.slice(attachments.contentStart));

  return sections.map(bounded).filter((section) => section.trim());
}

function tokenize(value: string): string[] {
  return [...wordSegmenter.segment(value)]
    .filter((part) => part.isWordLike)
    .flatMap((part) => {
      if (graphemeLength(part.segment) <= MAX_SESSION_TITLE_GRAPHEMES) {
        return [part.segment];
      }
      const pieces = part.segment.split(/[._/-]+/u).filter(Boolean);
      return pieces.length > 1
        ? pieces.filter((piece) => graphemeLength(piece) <= MAX_SESSION_TITLE_GRAPHEMES)
        : [];
    })
    .slice(0, MAX_TOKENS_PER_CLAUSE);
}

function tokenKind(token: string): TokenKind {
  const normalized = token.toLocaleLowerCase('und');
  if (
    STOP_WORDS.has(normalized) ||
    WEAK_WORDS.has(normalized) ||
    /^(?:19|20)\d{2}$/u.test(token)
  ) {
    return 'stop';
  }
  if (ACTION_WORDS.has(normalized)) return 'action';
  return 'content';
}

function rankCandidate(
  tokens: readonly string[],
  context: CandidateContext,
): RankedCandidate | undefined {
  const text = joinTokens(tokens);
  const length = graphemeLength(text);
  if (length === 0 || length > MAX_SESSION_TITLE_GRAPHEMES) return undefined;

  const kinds = tokens.map(tokenKind);
  const contentTokens = kinds.filter((kind) => kind === 'content').length;
  if (contentTokens === 0) return undefined;

  const technicalTokens = tokens.filter((token) => /[A-Z0-9_.+-]/u.test(token)).length;
  const fileToken = tokens.some(
    (token) =>
      /\.(?:ts|json|log|md|py|html|css|yml|yaml|pdf)$/iu.test(token) &&
      !/^node\.js$/iu.test(token),
  )
    ? 1
    : 0;
  const stopTokens = kinds.filter((kind) => kind === 'stop').length;
  const actionTokens = kinds.filter((kind) => kind === 'action').length;
  const weakTokens = tokens.filter((token) => WEAK_WORDS.has(token.toLocaleLowerCase('und'))).length;

  const score =
    contentTokens * LINEAR_RANKER_WEIGHTS.contentTokens +
    technicalTokens * LINEAR_RANKER_WEIGHTS.technicalTokens +
    fileToken * LINEAR_RANKER_WEIGHTS.fileToken +
    Math.min(length, 8) * LINEAR_RANKER_WEIGHTS.preferredLength +
    stopTokens * LINEAR_RANKER_WEIGHTS.stopTokens +
    actionTokens * LINEAR_RANKER_WEIGHTS.actionTokens +
    weakTokens * LINEAR_RANKER_WEIGHTS.weakTokens +
    context.clauseIndex * LINEAR_RANKER_WEIGHTS.clauseIndex +
    context.skippedTokens * LINEAR_RANKER_WEIGHTS.skippedTokens +
    Number(context.startsClause) * LINEAR_RANKER_WEIGHTS.startsClause +
    Number(context.endsClause) * LINEAR_RANKER_WEIGHTS.endsClause +
    Math.max(0, length - 8) * LINEAR_RANKER_WEIGHTS.overPreferredLength;

  return { text, score, contentTokens, length, clauseIndex: context.clauseIndex };
}

function pushCandidate(
  candidates: RankedCandidate[],
  tokens: readonly string[],
  context: CandidateContext,
): void {
  const candidate = rankCandidate(tokens, context);
  if (candidate) candidates.push(candidate);
}

function rankSection(source: string): RankedCandidate | undefined {
  const normalized = normalizeSource(source);
  const arithmetic = normalized.match(/\b\d+\s*([+*/-])\s*\d+\b/u);
  if (arithmetic) {
    const text = arithmetic[0].replace(/\s+/gu, '');
    if (graphemeLength(text) <= MAX_SESSION_TITLE_GRAPHEMES) {
      return { text, score: Number.POSITIVE_INFINITY, contentTokens: 1, length: graphemeLength(text), clauseIndex: 0 };
    }
  }

  const clauses = normalized
    .split(/[，。！？?!；;：:\n]|(?:\s+and\s+then\s+)|(?:並且|并且|以及|並|并)/iu)
    .map((clause) => clause.trim())
    .filter(Boolean)
    .slice(0, MAX_CLAUSES);
  const candidates: RankedCandidate[] = [];

  clauses.forEach((clause, clauseIndex) => {
    const clauseTokens = tokenize(clause);
    for (let start = 0; start < clauseTokens.length; start += 1) {
      const endLimit = Math.min(clauseTokens.length, start + MAX_CANDIDATE_TOKEN_WINDOW);
      for (let end = start; end < endLimit; end += 1) {
        const window = clauseTokens.slice(start, end + 1);
        const before = clauseTokens.slice(0, start);
        const after = clauseTokens.slice(end + 1);
        const context = {
          clauseIndex,
          skippedTokens: 0,
          startsClause: before.every((token) => tokenKind(token) !== 'content'),
          endsClause: after.every((token) => tokenKind(token) !== 'content'),
        };
        pushCandidate(candidates, window, context);

        const content = window.filter((token) => tokenKind(token) === 'content');
        if (content.length !== window.length) {
          pushCandidate(candidates, content, {
            ...context,
            skippedTokens: window.length - content.length,
          });
        }
      }
    }
  });

  candidates.sort(
    (left, right) =>
      right.score - left.score ||
      right.contentTokens - left.contentTokens ||
      left.length - right.length ||
      right.clauseIndex - left.clauseIndex,
  );
  return candidates[0];
}

/**
 * Extract a short title with a tiny linear candidate ranker.
 *
 * This preserves source characters exactly: there is no translation,
 * generative model, network request, or model KV state.
 */
export function extractSessionTitle(firstPrompt: string): string {
  const sections = sourceSections(firstPrompt);
  for (const section of sections) {
    const candidate = rankSection(section);
    if (candidate) return candidate.text;
  }

  const fallback = normalizeSource(sections[0] ?? firstPrompt);
  return fallback
    ? graphemes(fallback).slice(0, MAX_SESSION_TITLE_GRAPHEMES).join('')
    : 'Session';
}
