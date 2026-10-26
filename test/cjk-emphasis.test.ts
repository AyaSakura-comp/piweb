import { describe, expect, it } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkCjkFriendly from 'remark-cjk-friendly';
import remarkCjkFriendlyGfmStrikethrough from 'remark-cjk-friendly-gfm-strikethrough';

function texts(tree: any, type: string): string[] {
  const own = tree.type === type ? [tree.children.map((n: any) => n.value ?? '').join('')] : [];
  return [...own, ...(tree.children ?? []).flatMap((n: any) => texts(n, type))];
}
const parse = (source: string, cjk = true) => {
  const processor = unified().use(remarkParse).use(remarkGfm);
  if (cjk) processor.use(remarkCjkFriendly).use(remarkCjkFriendlyGfmStrikethrough);
  return processor.parse(source);
};

describe('CJK-friendly emphasis', () => {
  const source = '**decode：**bf16 是 18 tok/s；**品質：**perplexity 差 1.3%，~~舊：~~新';

  it('plain CommonMark leaves labels closed by full-width punctuation literal', () => {
    expect(texts(parse(source, false), 'strong')).toEqual([]);
  });

  it('the renderer plugins close them', () => {
    const tree = parse(source);
    expect(texts(tree, 'strong')).toEqual(['decode：', '品質：']);
    expect(texts(tree, 'delete')).toEqual(['舊：']);
  });

  it('Latin emphasis keeps CommonMark behaviour', () => {
    expect(texts(parse('**bold** and snake_case_name'), 'strong')).toEqual(['bold']);
    expect(texts(parse('snake_case_name and __init__ value'), 'emphasis')).toEqual([]);
  });
});
