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
// A `$` before a digit is left alone: LobeHub already escapes `$2,600`, and a
// second escape would render a literal backslash.
const CURRENCY_PREFIX = /(?<![A-Za-z\\])(?:NT|US|HK|NZ|AU|CA|SG|MX|A|C|S|R)\$(?![$\d])/g;
const LONE_DOLLAR = /(?<![\\$])\$(?![$\d])/g;
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

// `$$` as a symbol (e.g. a "費用 ($$)" price-level header) pairs with the next
// `$$` — often in a later table — as display math, and every `|` in between
// becomes `\vert{}`. Math cannot span a cell, so an unpaired `$$` is literal.
const DOUBLE_DOLLAR = /(?<!\\)\$\$/g;

const escapeLoneDollars = (cell) => {
  if ((cell.match(DOUBLE_DOLLAR) || []).length % 2) cell = cell.replace(DOUBLE_DOLLAR, '\\$\\$');
  const singles = cell.match(LONE_DOLLAR) || [];
  return singles.length % 2 ? cell.replace(LONE_DOLLAR, '\\$') : cell;
};

function protectLine(line) {
  const isRow = /^\s*\|/.test(line);
  return splitCode(line)
    .map(([text, code]) => {
      if (code) return text;
      text = text.replace(CURRENCY_PREFIX, (m) => m.slice(0, -1) + '\\$');
      // Math cannot span a table cell; an unpaired `$` inside one is literal.
      return isRow
        ? text
            .split(/(?<!\\)\|/)
            .map(escapeLoneDollars)
            .join('|')
        : text;
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
