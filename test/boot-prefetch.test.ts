import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const publicDir = resolve(import.meta.dirname, '../public');
const html = readFileSync(resolve(publicDir, 'index.html'), 'utf8');
const read = (pathname: string) => readFileSync(resolve(publicDir, `.${pathname}`), 'utf8');

/** Every module app.js loads statically, as the URL the browser keys it by. */
function staticImportGraph(entry: string): string[] {
  const seen = new Set<string>();
  const visit = (url: URL) => {
    const key = url.pathname + url.search;
    if (seen.has(key)) return;
    seen.add(key);
    const source = read(url.pathname);
    const specifiers = [
      ...source.matchAll(/^\s*(?:import|export)\s[^;]*?\sfrom\s+['"]([^'"]+)['"]/gms),
      ...source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm),
    ].map((match) => match[1]);
    for (const specifier of specifiers) visit(new URL(specifier, url));
  };
  visit(new URL(entry, 'http://piweb.test/'));
  return [...seen];
}

describe('boot prefetch in index.html', () => {
  it('modulepreloads exactly the static import graph of the app.js it loads', () => {
    const entry = html.match(/<script src="([^"]+)" type="module"><\/script>/)![1];
    const preloads = [...html.matchAll(/<link rel="modulepreload" href="([^"]+)"/g)].map((m) => m[1]);
    const graph = staticImportGraph(entry);
    expect(graph).toContain(entry);
    expect(graph.length).toBeGreaterThan(20);
    expect([...preloads].sort()).toEqual([...graph].sort());
  });

  it('starts the GETs before any stylesheet, which would hold an inline script back', () => {
    const prefetch = html.indexOf('window.piwebBootPrefetch');
    expect(prefetch).toBeGreaterThan(0);
    expect(prefetch).toBeLessThan(html.indexOf('rel="stylesheet"'));
  });

  it('prefetches the paths boot asks for, events at the first page size', () => {
    const app = read('/app.js');
    for (const path of ['/api/me', '/api/commands', '/api/models', '/api/sessions', '/api/sessions/deleted']) {
      expect(html).toContain(`'${path}'`);
      expect(app).toContain(`api('${path}')`);
    }
    const pageSize = app.match(/const PAGE_SIZE = (\d+);/)![1];
    expect(html).toContain(`/events?limit=${pageSize}\``);
    expect(app).toContain('/events?limit=${PAGE_SIZE}`');
  });
});
