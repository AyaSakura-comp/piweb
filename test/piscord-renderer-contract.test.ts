import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// piscord (~/src/pi-discord-gateway, src/live-page) renders Discord replies'
// tables, math and mermaid to images, and mirrors replies to a live page, with
// this repo's renderer: it serves public/ files straight to a bare page that
// imports /lobehub-rich.js. That page has none of index.html, and the server
// only hands out the renderer's entry modules, what they import from the same
// directory, app.css, favicon.svg and vendor/. When markdown.js began importing
// ./media-files.js (2026-10-27) an older piscord 404'd it, the module graph
// never loaded and every table went to Discord as raw Markdown. These checks
// keep the renderer inside what that page can load.

const publicDir = resolve(import.meta.dirname, '../public');
const SAME_DIR_MODULE = /^\.\/[\w.-]+\.js$/;

/** Every module specifier in a source: static, side-effect, re-export and dynamic. */
function importSpecifiers(source: string): string[] {
  const specs = new Set<string>();
  const patterns = [
    /\bimport\s*(?:[\w*{}\s,$]+?\s*from\s*)?["']([^"']+)["']/g,
    /\bexport\s*(?:\*|\{[^}]*\})\s*from\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of patterns) for (const m of source.matchAll(re)) specs.add(m[1]);
  return [...specs];
}

function moduleGraph(entry: string): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift()!;
    if (graph.has(file)) continue;
    const specs = importSpecifiers(readFileSync(resolve(publicDir, file), 'utf8'));
    graph.set(file, specs);
    for (const spec of specs) if (SAME_DIR_MODULE.test(spec)) queue.push(spec.slice(2));
  }
  return graph;
}

describe('the renderer piscord loads from public/', () => {
  it('finds every kind of import', () => {
    expect(
      importSpecifiers(
        `import a from './a.js'; import { b } from "./b.js"; import './c.js';\n` +
          `export * from './d.js'; const e = await import('./e.js');` +
          `import{f as g}from"./f.js";`,
      ).sort(),
    ).toEqual(['./a.js', './b.js', './c.js', './d.js', './e.js', './f.js']);
  });

  it('markdown.js imports only same-directory modules that exist', () => {
    for (const [file, specs] of moduleGraph('markdown.js')) {
      for (const spec of specs) {
        expect(spec, `${file} imports ${spec}: piscord serves only ./name.js beside it`).toMatch(
          SAME_DIR_MODULE,
        );
        expect(existsSync(resolve(publicDir, spec)), `${file} imports missing ${spec}`).toBe(true);
      }
    }
  });

  it('the bundle keeps only same-directory modules external', () => {
    const build = readFileSync(resolve(import.meta.dirname, '../scripts/build-client.mjs'), 'utf8');
    const externals = /external:\s*\[([^\]]*)\]/.exec(build)?.[1] ?? '';
    for (const m of externals.matchAll(/["']([^"']+)["']/g)) expect(m[1]).toMatch(SAME_DIR_MODULE);
  });

  it('exports what piscord calls', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../client/lobehub-rich.jsx'), 'utf8');
    for (const name of ['renderLobehubStatic', 'updateLobehubRich'])
      expect(source, `client/lobehub-rich.jsx must export ${name}`).toMatch(
        new RegExp(`export function ${name}\\b`),
      );
  });

  it('keeps the vendor files piscord links', () => {
    for (const file of [
      'app.css',
      'favicon.svg',
      'vendor/katex/katex.min.css',
      'vendor/katex/katex.min.js',
      'vendor/highlight/highlight.min.js',
    ])
      expect(existsSync(resolve(publicDir, file)), file).toBe(true);
  });
});
