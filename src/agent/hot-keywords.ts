/**
 * Hot keywords: the words the user typed most in standard sessions over the
 * last week, shown as multi-select chips above the composer. Pure counting —
 * no language model: `Intl.Segmenter` splits Chinese and English into words,
 * each message counts a word once, filler words are dropped.
 */

export const HOT_KEYWORD_COUNT = 10;
export const HOT_KEYWORD_WINDOW_DAYS = 1;
export const SUPPORTED_HOT_KEYWORD_WINDOWS = [1, 3, 7, 14, 30] as const;

// Function words and filler that rank high in any chat but say nothing about
// what the user works on. Tuned on the user's own month of prompts.
const STOP_WORDS = new Set(
  `的 了 是 我 你 他 她 它 嗎 吗 呢 吧 啊 喔 哦 嗯 在 有 和 跟 與 及 就 都 也 還 要 會 能 可以 可不可以
   一下 這個 那個 這 那 這樣 那樣 這些 那些 什麼 怎麼 怎樣 為什麼 幫 幫我 請 請問 看 看看 一個 一些
   現在 然後 如果 但是 可是 因為 所以 沒有 不是 不要 不 沒 好 好的 對 直接 還是 時候 就是 已經 應該
   需要 可能 一直 其實 還有 或是 或者 這邊 那邊 這裡 那裡 他們 我們 你們 自己 東西 為 把 被 讓 給 從
   到 用 去 來 做 說 想 知道 覺得 比較 一樣 多少 哪 哪裡 哪個 之後 之前 以後 以前 時間 問題 地方 部分
   方式 而且 並且 只 才 再 又 很 太 更 最 非常 真的 一定 先 後 中 上 下 裡 個 次 種 些 點 下來 起來
   出來 一次 兩個 三個 目前 剛剛 剛才 等等 之類 有沒有 他的 想要 我的 我要 我想 你有 另外 你的 一起
   不用 這次 是不是 能不能 要不要 看到 還沒 只有 所有 每個 之前的
   the a an to and or of for in on at is it its this that these those i you me my we our be been
   with do does did can could would should will please what how why when where which who are was
   were not no yes ok okay if then so but just also from as by about into there here have has had
   get got let make use using hello`.split(/\s+/u),
);

const words = new Intl.Segmenter('zh-Hant', { granularity: 'word' });
const graphemes = new Intl.Segmenter('und', { granularity: 'grapheme' });
const graphemeLength = (value: string) => [...graphemes.segment(value)].length;

/** Quoted text ("↪ 引用：「…」") is someone else's words; leave it out. */
function ownText(content: string): string {
  return content.replace(/↪ 引用：「[\s\S]*?」\n?/gu, '').toLowerCase();
}

/** The distinct keywords of one message. */
export function messageKeywords(content: string): Set<string> {
  const text = ownText(content).trim();
  const found = new Set<string>();
  if (!text || text.startsWith('/')) return found;
  for (const part of words.segment(text)) {
    const word = part.segment;
    if (!part.isWordLike || STOP_WORDS.has(word) || /^\d+$/u.test(word)) continue;
    // English needs 3+ letters ("pi" and "ok" are noise); Chinese 2+ characters.
    if (/[a-z]/u.test(word) ? word.length < 3 : graphemeLength(word) < 2) continue;
    found.add(word);
  }
  return found;
}

export interface HotKeyword {
  word: string;
  /** Messages that used it. */
  count: number;
}

/** Top keywords by the number of messages using them (ties: alphabetical, for stable chips). */
export function rankHotKeywords(messages: string[], count = HOT_KEYWORD_COUNT): HotKeyword[] {
  const counts = new Map<string, number>();
  for (const message of messages) {
    for (const word of messageKeywords(message)) counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts]
    .filter(([, uses]) => uses >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, count)
    .map(([word, uses]) => ({ word, count: uses }));
}
