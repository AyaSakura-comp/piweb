const MAX_QUOTE_LENGTH = 12_000;
const DISPLAY_PREVIEW_LENGTH = 67;

export function normalizeQuote(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\r\n?/g, '\n').trim().slice(0, MAX_QUOTE_LENGTH);
}

function previewQuote(quote: string): string {
  const oneLine = quote.replace(/\s+/g, ' ').trim();
  return oneLine.length <= DISPLAY_PREVIEW_LENGTH
    ? oneLine
    : `${oneLine.slice(0, DISPLAY_PREVIEW_LENGTH - 1).trimEnd()}…`;
}

export function buildQuotedPrompt(text: string, quoteValue: unknown): string {
  const quote = normalizeQuote(quoteValue);
  if (!quote) return text;
  const reply = text ? `\n\n${text}` : '';
  return `<quoted_selection>\n${quote}\n</quoted_selection>${reply}`;
}

export function buildQuotedDisplay(text: string, quoteValue: unknown): string {
  const quote = normalizeQuote(quoteValue);
  if (!quote) return text;
  const reply = text ? `\n${text}` : '';
  return `↪ 引用：「${previewQuote(quote)}」${reply}`;
}
