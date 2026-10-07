import { describe, expect, it } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import {
  normalizeDisplayMath,
  documentDefinitions,
  remarkDocumentDefinitions,
} from '../client/document-context.js';

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
