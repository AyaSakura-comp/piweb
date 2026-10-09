import { describe, expect, it } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import {
  normalizeDisplayMath,
  documentDefinitions,
  protectCurrencyDollars,
  remarkDocumentDefinitions,
} from '../client/document-context.js';
import { preprocessLaTeX } from '@lobehub/streamdown';

const parse = (block: string, document: string) =>
  unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    .use(remarkDocumentDefinitions, { definitions: documentDefinitions(document) })
    .parse(block);
const references = (tree: any): any[] =>
  [tree, ...(tree.children || []).flatMap(references)].filter((n) =>
    ['linkReference', 'imageReference'].includes(n.type),
  );

describe('document context before block parsing', () => {
  it('collapses only blank lines in actual math, including unfinished display nodes', () => {
    expect(normalizeDisplayMath('Prefix.\n\n$$\nx^2\n\n+y^2\n$$\n\nEnd.')).toBe(
      'Prefix.\n\n$$\nx^2\n+y^2\n$$\n\nEnd.',
    );
    expect(normalizeDisplayMath('$$\nx\n\n')).toBe('$$\nx\n');
    const code = '```text\n$$\nx\n\ny\n$$\n```\n\n`$$ x $$`\n\n    $$\n    x\n\n    y\n    $$';
    expect(normalizeDisplayMath(code)).toBe(code);
  });
  for (const use of ['[reference][ ReF ]', '[ref][]', '[ref]', '![image][ref]']) {
    for (const before of [true, false]) {
      it(`resolves ${use} with definition ${before ? 'before' : 'after'} use`, () => {
        const def = '[ref]: https://example.test "Title"';
        const document = before ? `${def}\n\n${use}` : `${use}\n\n${def}`;
        const tree: any = parse(use, document);
        expect(references(tree)).toHaveLength(1);
        expect(tree.children.at(-1)).toMatchObject({
          type: 'definition',
          identifier: 'ref',
          url: 'https://example.test',
          title: 'Title',
        });
      });
    }
  }
  it('keeps first-definition precedence even when block contains a later duplicate', () => {
    const doc = '[ref]: https://first.test\n\n[ref]: https://second.test\n\n[ref]';
    const tree: any = parse('[ref]: https://second.test\n\n[ref]', doc);
    expect(tree.children.filter((n: any) => n.type === 'definition')).toEqual(
      documentDefinitions(doc),
    );
    expect(references(tree)).toHaveLength(1);
  });
  it('preserves unsafe URLs for the existing downstream URL sanitizer, without HTML interpolation', () => {
    const doc = '[ref]: javascript:alert(1) "<unsafe>"\n\n[ref]';
    const tree: any = parse('[ref]', doc);
    expect(references(tree)).toHaveLength(1);
    expect(tree.children.at(-1)).toMatchObject({ url: 'javascript:alert(1)', title: '<unsafe>' });
  });
  it('does not leak document definitions into an unfinished code or math tail', () => {
    for (const tail of ['```text\n[ref]', '$$\nx^2']) {
      const tree: any = parse(tail, '[ref]: https://example.test\n\n' + tail);
      expect(tree.children[0].value).not.toContain('example.test');
      expect(tree.children[0].value).toBe(tail.includes('```') ? '[ref]' : 'x^2');
    }
  });
  it('does not invent references from code or definitions from code', () => {
    expect(documentDefinitions('```\n[ref]: https://example.test\n```')).toEqual([]);
    expect(references(parse('`[ref]`', '[ref]: https://example.test'))).toEqual([]);
  });
});

describe('currency dollars before LaTeX preprocessing', () => {
  const parseTypes = (source: string) =>
    unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkMath)
      .parse(source)
      .children.map((node: any) => node.type);
  const table =
    '| 型號 | 台灣售價 (NT$) | 匯率換算 (NT$) | 差價 |\n|---|---|---|---|\n| **A** | ~$2,600 | 139,900 | x |';

  it('keeps a table whose header has two NT$ cells', () => {
    expect(parseTypes(preprocessLaTeX(table))).toEqual(['paragraph']); // upstream bug
    expect(parseTypes(preprocessLaTeX(protectCurrencyDollars(table)))).toEqual(['table']);
  });
  it('keeps two tables whose headers have a ($$) price-level cell', () => {
    const levels = '| 活動 | 費用 ($$) |\n|---|---|\n| A | 免費 |';
    const twoTables = `${levels}\n\n說明\n\n${levels}`;
    expect(preprocessLaTeX(twoTables)).toMatch(/\\vert\{\}/); // upstream bug
    const fixed = preprocessLaTeX(protectCurrencyDollars(twoTables));
    expect(fixed).not.toMatch(/\\vert\{\}/);
    expect(parseTypes(fixed)).toEqual(['table', 'paragraph', 'table']);
    expect(protectCurrencyDollars('| $$x$$ | a |')).toBe('| $$x$$ | a |');
  });
  it('escapes prefixed currency and unpaired cell dollars only', () => {
    expect(protectCurrencyDollars('價格 (NT$) 與 US$')).toBe('價格 (NT\\$) 與 US\\$');
    expect(protectCurrencyDollars('| $x$ | a $ b |')).toBe('| $x$ | a \\$ b |');
  });
  it('leaves digit-led amounts to LobeHub so they are escaped exactly once', () => {
    const amounts = '| ~$2,600 | **$4,999** | NT$100 | US$5 |';
    expect(protectCurrencyDollars(amounts)).toBe(amounts);
    expect(preprocessLaTeX(protectCurrencyDollars(table))).not.toMatch(/\\\\\$/);
  });
  it('leaves math, code spans and code blocks alone', () => {
    const kept = [
      '$a+b$ and $$c$$',
      '| `NT$` | $\\alpha$ |',
      '```\nNT$ | x$\n```',
      '    NT$ indented code',
      'A $x$ term',
    ].join('\n\n');
    expect(protectCurrencyDollars(kept)).toBe(kept);
  });
});
