import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveStatic, PUBLIC_DIR } from '../src/web/server.js';

const servers: Server[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('serveStatic caching and conditional validation', () => {
  it('serves immutable vendor assets with long-term max-age cache control', async () => {
    const root = await mkdtemp(join(tmpdir(), 'piweb-static-test-'));
    dirs.push(root);
    await mkdir(join(root, 'vendor', 'katex'), { recursive: true });
    await writeFile(join(root, 'vendor', 'katex', 'katex.min.js'), 'console.log("katex");');

    const server = createServer((req, res) => {
      if (!serveStatic(req, res, root, 'vendor/katex/katex.min.js')) res.writeHead(404).end();
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');

    const response = await fetch(`http://127.0.0.1:${address.port}/vendor/katex/katex.min.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('public, max-age=31536000, immutable');
    expect(response.headers.get('etag')).toBeTruthy();
    expect(response.headers.get('last-modified')).toBeTruthy();
  });

  it('serves application files with no-cache and ETag', async () => {
    const server = createServer((req, res) => {
      if (!serveStatic(req, res, PUBLIC_DIR, 'app.js')) res.writeHead(404).end();
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');

    const response = await fetch(`http://127.0.0.1:${address.port}/app.js`, {
      keepalive: false,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-cache');
    const etag = response.headers.get('etag');
    expect(etag).toBeTruthy();

    // 304 Revalidation with matching If-None-Match
    const reval = await fetch(`http://127.0.0.1:${address.port}/app.js`, {
      headers: { 'if-none-match': etag! },
      keepalive: false,
    });
    expect(reval.status).toBe(304);

    // 200 with non-matching If-None-Match
    const mismatched = await fetch(`http://127.0.0.1:${address.port}/app.js`, {
      headers: { 'if-none-match': 'W/"fake-etag"' },
      keepalive: false,
    });
    expect(mismatched.status).toBe(200);
  });
});
