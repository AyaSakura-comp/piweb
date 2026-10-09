import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

// Match the renderer's syntax extensions. This parser only supplies document
// context; CachedMarkdown still owns rendering, URL sanitation and animation.
const documentParser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
function walk(node, visit) {
  visit(node);
  for (const child of node.children || []) walk(child, visit);
}

export function normalizeDisplayMath(source) {
  const ranges = [];
  walk(documentParser.parse(source), (node) => {
    if (node.type === 'math') ranges.push([node.position.start.offset, node.position.end.offset]);
  });
  // Include unfinished math nodes: otherwise marked can freeze a paragraph at
  // an internal blank line before the closing delimiter arrives.
  for (const [start, end] of ranges.reverse()) {
    const math = source.slice(start, end).replace(/\n(?:[\t ]*\n)+/g, '\n');
    source = source.slice(0, start) + math + source.slice(end);
  }
  return source;
}

// Prefixed currency (NT$, US$, HK$…) is never a math delimiter, but LobeHub's
// preprocessLaTeX pairs it with the next `$` and rewrites the `|` between them
// to `\vert{}` — merging two table cells and breaking the whole table.
// Only a `$` that would OPEN math is currency: in `$A$` or `$x = C$` the
// letter before the closing `$` is a variable, not a dollar prefix.
// A `$` before a digit is left alone: LobeHub already escapes `$2,600`, and a
// second escape would render a literal backslash.
const CURRENCY_BEFORE = /(?<![A-Za-z\\])(?:NT|US|HK|NZ|AU|CA|SG|MX|A|C|S|R)$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

function splitCode(line) {
  // [text, isCode] segments; an unclosed backtick run stays text.
  const parts = [];
  let last = 0;
  for (const match of line.matchAll(/(`+)[^`]*?\1(?!`)/g)) {
    parts.push([line.slice(last, match.index), false], [match[0], true]);
    last = match.index + match[0].length;
  }
  parts.push([line.slice(last), false]);
  return parts;
}

const findDollar = (text, from, double) => {
  for (let i = from; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === '$' && (text[i + 1] === '$') === double) return i;
    else if (text[i] === '$') i++;
  }
  return -1;
};

/**
 * Split one line into [text, kind] pieces: 'math' for a same-line `$$…$$` or
 * a Pandoc-style `$…$` (non-space just inside both delimiters, closing `$` not
 * followed by a digit), 'currency' for a prefixed `$` that would open math,
 * and 'text' for the rest. In a table row a `$…$` spanning a spaced ` | ` cell
 * boundary is not math: math cannot span cells.
 */
function scanMath(text, isRow) {
  const pieces = [];
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') {
      i++;
      continue;
    }
    if (text[i] !== '$') continue;
    if (text[i + 1] === '$') {
      const close = findDollar(text, i + 2, true);
      if (close > i + 2) {
        pieces.push([text.slice(last, i), 'text'], [text.slice(i, close + 2), 'math']);
        last = close + 2;
        i = close + 1;
      } else i++;
      continue;
    }
    if (/\d/.test(text[i + 1] ?? '')) {
      // LobeHub keeps `$5$` / `$1,000$` as math; any other `$5…` is money.
      const number = /^\$\d+(?:,\d+)*\$(?![$\d])/.exec(text.slice(i));
      if (number) {
        pieces.push([text.slice(last, i), 'text'], [number[0], 'math']);
        last = i + number[0].length;
        i = last - 1;
      }
      continue;
    }
    if (CURRENCY_BEFORE.test(text.slice(0, i))) {
      pieces.push([text.slice(last, i), 'text'], ['$', 'currency']);
      last = i + 1;
      continue;
    }
    if (!text[i + 1] || /\s/.test(text[i + 1])) continue;
    const close = findDollar(text, i + 1, false);
    if (close < 0) continue;
    const body = text.slice(i + 1, close);
    if (/\s$/.test(body) || /\d/.test(text[close + 1] ?? '') || (isRow && /\s\|\s/.test(body))) {
      continue;
    }
    pieces.push([text.slice(last, i), 'text'], [text.slice(i, close + 1), 'math']);
    last = close + 1;
    i = close;
  }
  pieces.push([text.slice(last), 'text']);
  return pieces;
}

// Outside a real same-line formula, a `$`/`$$` in a table cell is literal:
// a "費用 ($$)" price-level header or a lone `$` would otherwise pair with
// one in another cell (or a later table) and every `|` in between would
// become `\vert{}`.
const STRAY_DOLLARS = /(?<!\\)\$(?!\d)/g;

function protectLine(line) {
  const isRow = /^\s*\|/.test(line);
  return splitCode(line)
    .map(([text, code]) => {
      if (code) return text;
      return scanMath(text, isRow)
        .map(([piece, kind]) => {
          // remark-math ends inline math at the first `$`, even an escaped
          // one (`$\$100$`); KaTeX's \char"24 draws the same dollar sign.
          if (kind === 'math') return piece.replace(/(?<!\\)\\\$/g, '\\char"24{}');
          if (kind === 'currency') return '\\$';
          // LobeHub escapes `$5` even when the author already wrote `\$5`,
          // which renders a stray backslash; an entity is a plain `$`.
          piece = piece.replace(/(?<!\\)\\\$(?=\d)/g, '&#36;');
          return isRow ? piece.replace(STRAY_DOLLARS, '\\$') : piece;
        })
        .join('');
    })
    .join('');
}

export function protectCurrencyDollars(source) {
  let fence = null;
  return source
    .split('\n')
    .map((line) => {
      const open = FENCE.exec(line);
      if (fence) {
        if (open && open[1][0] === fence[0] && open[1].length >= fence.length) fence = null;
        return line;
      }
      if (open) {
        fence = open[1];
        return line;
      }
      return /^(?: {4}|\t)/.test(line) ? line : protectLine(line);
    })
    .join('\n');
}

export function documentDefinitions(source) {
  const definitions = new Map();
  walk(documentParser.parse(source), (node) => {
    if (node.type === 'definition' && !definitions.has(node.identifier)) {
      // No positions: unchanged definitions keep upstream plugin options stable
      // during ordinary text growth, so settled blocks need not be reparsed.
      definitions.set(node.identifier, {
        type: 'definition',
        identifier: node.identifier,
        label: node.label,
        url: node.url,
        title: node.title,
      });
    }
  });
  return [...definitions.values()];
}

const entities = (value) => [...value].map((char) => `&#${char.codePointAt(0)};`).join('');
function definitionSource(definition) {
  const label = definition.identifier.replace(/[\\[\]]/g, '\\$&');
  return (
    `[${label}]: <${entities(definition.url)}>\n` +
    (definition.title === null ? '' : `  "${entities(definition.title)}"\n`)
  );
}

// unified documents processor.parser as a replaceable Parser. Wrapping it is
// necessary BEFORE parse: a post-parse transformer cannot recover references
// already classified as literal text in an independently parsed block.
export function remarkDocumentDefinitions({ definitions }) {
  if (!definitions.length) return;
  const parser = this.parser;
  // Put the parse-only definitions BEFORE the block. Appending them would
  // leak their source into an unfinished code fence or display-math tail.
  const prefix = definitions.map(definitionSource).join('\n') + '\n\n';
  this.parser = (source, file) => {
    const tree = parser(prefix + source, file);
    // Only the original block contributes visible nodes. Use document-order
    // definitions (not block-local duplicates) for remark-rehype resolution.
    tree.children = tree.children.filter((node) => node.position.start.offset >= prefix.length);
    const removeDefinitions = (node) => {
      if (node.children) {
        node.children = node.children.filter((child) => child.type !== 'definition');
        node.children.forEach(removeDefinitions);
      }
    };
    removeDefinitions(tree);
    tree.children.push(...definitions.map((definition) => ({ ...definition })));
    return tree;
  };
}
