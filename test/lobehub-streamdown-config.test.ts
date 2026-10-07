import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const source = ts.createSourceFile(
  'lobehub-rich.jsx',
  readFileSync(new URL('../client/lobehub-rich.jsx', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JSX,
);
const streamdown: ts.JsxSelfClosingElement[] = [];
function visit(node: ts.Node) {
  if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'Streamdown') {
    streamdown.push(node);
  }
  ts.forEachChild(node, visit);
}
visit(source);

describe('requested LobeHub reply configuration', () => {
  it.each([
    ['granularity', 'char'],
    ['smoothing', 'balanced'],
  ])('explicitly pins %s to %s instead of relying on upstream defaults', (name, value) => {
    expect(streamdown).toHaveLength(1);
    const attribute = streamdown[0].attributes.properties.find(
      (item): item is ts.JsxAttribute =>
        ts.isJsxAttribute(item) && item.name.getText(source) === name,
    );
    expect(
      attribute?.initializer && ts.isStringLiteral(attribute.initializer)
        ? attribute.initializer.text
        : undefined,
    ).toBe(value);
  });
});
