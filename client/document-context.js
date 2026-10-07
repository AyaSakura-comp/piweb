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
