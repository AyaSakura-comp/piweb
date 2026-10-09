import { describe, expect, it } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import katex from 'katex';
import { protectCurrencyDollars } from '../client/document-context.js';
import { preprocessLaTeX } from '@lobehub/streamdown';

// The reply pipeline of client/lobehub-rich.jsx (preprocessReply) followed by
// the same remark syntax the renderer uses. Every case checks the table keeps
// its columns, which spans become math, that KaTeX accepts every formula, and
// what a literal-dollar cell reads as.
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
const render = (source: string) => parser.parse(preprocessLaTeX(protectCurrencyDollars(source)));

const nodes = (node: any): any[] => [node, ...(node.children || []).flatMap(nodes)];
const mathIn = (node: any) =>
  nodes(node)
    .filter((n) => n.type === 'inlineMath' || n.type === 'math')
    .map((n) => n.value);
const textIn = (node: any): string =>
  nodes(node)
    .map((n) => (n.type === 'text' || n.type === 'inlineCode' ? n.value : n.type === 'inlineMath' ? `⟨${n.value}⟩` : ''))
    .join('');
const plainText = (node: any) =>
  nodes(node)
    .filter((n) => n.type === 'text')
    .map((n) => n.value)
    .join('');
const katexError = (formula: string) => {
  try {
    katex.renderToString(formula, { throwOnError: true });
    return '';
  } catch (error) {
    return `${formula}: ${(error as Error).message}`;
  }
};

/** One row `| a | <cell> | b |` under a 3-column header; returns the middle cell. */
function cellOf(cell: string) {
  const tree: any = render(`| A | C | B |\n|---|---|---|\n| a | ${cell} | b |`);
  expect(tree.children.map((n: any) => n.type)).toEqual(['table']);
  const [head, row] = tree.children[0].children;
  expect([head.children.length, row.children.length]).toEqual([3, 3]);
  expect(textIn(row.children[0])).toBe('a');
  expect(textIn(row.children[2])).toBe('b');
  return row.children[1];
}

// [cell markdown, math formulas after preprocessing, visible text (⟨⟩ = math)]
const MATH_CELLS: Array<[string, string[]]> = [
  ['$x$', ['x']],
  ['$x^2$', ['x^2']],
  ['$x_1, x_2$', ['x_1, x_2']],
  ['$x_{i}^{2}$', ['x_{i}^{2}']],
  ['$a^2+b^2=c^2$', ['a^2+b^2=c^2']],
  ['$\\frac{a}{b}$', ['\\frac{a}{b}']],
  ['$\\sqrt{2}$', ['\\sqrt{2}']],
  ['$\\sum_{i=1}^n i$', ['\\sum_{i=1}^n i']],
  ['$\\int_0^1 f(x)\\,dx$', ['\\int_0^1 f(x)\\,dx']],
  ['$\\lim_{n\\to\\infty} a_n$', ['\\lim_{n\\to\\infty} a_n']],
  ['$\\mathbb{R}$', ['\\mathbb{R}']],
  ['$\\text{if } x > 0$', ['\\text{if } x > 0']],
  ['$\\alpha$ / $\\beta$', ['\\alpha', '\\beta']],
  ['$x$ and $y$', ['x', 'y']],
  ['$A$, $B$, $C$', ['A', 'B', 'C']],
  ['$x = A$', ['x = A']],
  ['$S$ 與 $R$', ['S', 'R']],
  ['$\\{1,2\\}$', ['\\{1,2\\}']],
  ['$\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}$', ['\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}']],
  ['$\\binom{n}{k}$', ['\\binom{n}{k}']],
  ['$O(n \\log n)$', ['O(n \\log n)']],
  ['$5$', ['5']],
  ['$1,000$', ['1,000']],
  ['$$E=mc^2$$', ['E=mc^2']],
  ['**$x$**', ['x']],
  ['[$x$](https://example.com)', ['x']],
  ['<br>$x$<br>$y$', ['x', 'y']],
  ['\\(a+b\\)', ['a+b']],
  ['\\[a+b\\]', ['a+b']],
  // A `|` inside a formula must not split the cell (LobeHub → \vert{}).
  ['$|x|$', ['\\vert{}x\\vert{}']],
  ['$P(A|B)$', ['P(A\\vert{}B)']],
  ['$f(x)=|x-1|+|x+1|$', ['f(x)=\\vert{}x-1\\vert{}+\\vert{}x+1\\vert{}']],
  ['$\\left| x \\right|$', ['\\left\\vert{} x \\right\\vert{}']],
  ['$$|x|$$', ['\\vert{}x\\vert{}']],
  ['\\(x|y\\)', ['x\\vert{}y']],
  ['$\\lvert x \\rvert$', ['\\lvert x \\rvert']],
  ['$\\|v\\|$', ['\\|v\\|']],
  ['$a \\| b$', ['a \\| b']],
  ['$\\{x \\mid x>0\\}$', ['\\{x \\mid x>0\\}']],
  // An escaped dollar inside math (remark-math would end the formula there).
  ['$\\$100$', ['\\char"24{}100']],
  ['$x + \\$5$', ['x + \\char"24{}5']],
];

const LITERAL_CELLS: Array<[string, string]> = [
  ['$10', '$10'],
  ['$5 and $10', '$5 and $10'],
  ['~$2,600', '~$2,600'],
  ['$4.99/月', '$4.99/月'],
  ['$5-$10', '$5-$10'],
  ['約 $3 起', '約 $3 起'],
  ['$ 100', '$ 100'],
  ['($)', '($)'],
  ['費用 ($$)', '費用 ($$)'],
  ['$$$', '$$$'],
  ['$', '$'],
  ['$$', '$$'],
  ['a $ b', 'a $ b'],
  ['a $ b $ c', 'a $ b $ c'],
  ['\\$5', '$5'],
  ['$x\\$', '$x$'],
  ['NT$500', 'NT$500'],
  ['NT$ 500', 'NT$ 500'],
  ['(NT$)', '(NT$)'],
  ['US$ / HK$', 'US$ / HK$'],
  ['A$ 與 C$', 'A$ 與 C$'],
  ['$abc', '$abc'],
  ['`$x$`', '$x$'],
  ['`$x\\|y$`', '$x|y$'],
];

describe('LaTeX inside Markdown table cells', () => {
  for (const [cell, math] of MATH_CELLS) {
    it(`math ${cell}`, () => {
      const node = cellOf(cell);
      expect(mathIn(node)).toEqual(math);
      expect(math.map(katexError).filter(Boolean)).toEqual([]);
      expect(plainText(node)).not.toContain('\\vert{}');
    });
  }

  for (const [cell, text] of LITERAL_CELLS) {
    it(`literal ${cell}`, () => {
      const node = cellOf(cell);
      expect(mathIn(node)).toEqual([]);
      expect(textIn(node)).toBe(text);
    });
  }

  it('mixes math, prices and currency headers across the cells of one row', () => {
    const tree: any = render(
      [
        '| 項目 | 價格 (NT$) | 美元 (US$) | 公式 | 等級 ($$) |',
        '|---|---|---|---|---|',
        '| A | NT$1,200 | $40 | $\\frac{p}{q}$ | $$ |',
        '| B | 約 $3 | US$5 | $|x| \\le 1$ | $$$ |',
        '| C | 免費 | — | $x$ 或 $y$ | $ |',
      ].join('\n'),
    );
    expect(tree.children.map((n: any) => n.type)).toEqual(['table']);
    const rows = tree.children[0].children;
    expect(rows.map((row: any) => row.children.length)).toEqual([5, 5, 5, 5]);
    expect(rows.map((row: any) => mathIn(row))).toEqual([
      [],
      ['\\frac{p}{q}'],
      ['\\vert{}x\\vert{} \\le 1'],
      ['x', 'y'],
    ]);
    expect(textIn(rows[0])).toBe('項目價格 (NT$)美元 (US$)公式等級 ($$)');
    expect(textIn(rows[1].children[4])).toBe('$$');
  });

  it('keeps several tables apart when each has a ($$) or (NT$) header', () => {
    const table = (unit: string) => `| 活動 | 費用 (${unit}) |\n|---|---|\n| x | $5 |`;
    const tree: any = render(
      [table('$$'), '說明 $a$ 與 $b$', table('NT$'), '| 公式 |\n|---|\n| $|x|$ |', table('$$')].join(
        '\n\n',
      ),
    );
    expect(tree.children.map((n: any) => n.type)).toEqual([
      'table',
      'paragraph',
      'table',
      'table',
      'table',
    ]);
    expect(mathIn(tree)).toEqual(['a', 'b', '\\vert{}x\\vert{}']);
    expect(plainText(tree)).not.toContain('\\vert{}');
  });

  it('a spaced | between two dollars stays a cell boundary, not one formula', () => {
    const node: any = render('| a $b | c$ d |\n|---|---|\n| 1 | 2 |');
    expect(node.children[0].children[0].children.map(textIn)).toEqual(['a $b', 'c$ d']);
  });
});

describe('LaTeX outside tables is unchanged by the table rules', () => {
  const prose: Array<[string, string[]]> = [
    ['質能 $E=mc^2$ 與 $a^2+b^2=c^2$', ['E=mc^2', 'a^2+b^2=c^2']],
    ['設 $x = A$ 且 $y = C$', ['x = A', 'y = C']],
    ['$A$、$B$ 兩點', ['A', 'B']],
    ['價格 NT$ 與 US$，公式 $x$', ['x']],
    ['售價 $5，折扣後 $3', []],
    ['$|x| < 1$', ['\\vert{}x\\vert{} < 1']],
    ['$$\n\\int_0^1 x\\,dx\n$$', ['\\int_0^1 x\\,dx']],
    ['$\\$100$ 的公式', ['\\char"24{}100']],
    ['已跳脫 \\$5 與 \\$', []],
  ];
  for (const [source, math] of prose) {
    it(source.replace(/\n/g, '⏎'), () => {
      const tree = render(source);
      expect(mathIn(tree)).toEqual(math);
      expect(math.map(katexError).filter(Boolean)).toEqual([]);
    });
  }

  it('an author-escaped \\$5 reads as $5, not \\$5', () => {
    expect(plainText(render('已跳脫 \\$5 與 \\$'))).toBe('已跳脫 $5 與 $');
  });

  it('leaves fenced and indented code alone', () => {
    const code = '```\n| $x | NT$ | $$ |\n```\n\n    NT$ $a | b$';
    expect(protectCurrencyDollars(code)).toBe(code);
  });
});
