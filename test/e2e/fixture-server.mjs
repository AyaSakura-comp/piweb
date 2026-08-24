import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const publicDir = resolve(root, 'public');
const fixtureDir = resolve(root, 'test/e2e/fixtures');
const host = '127.0.0.1';
const port = Number(process.env.PIWEB_E2E_PORT || 4173);

const mime = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.svg': 'image/svg+xml',
  '.webm': 'video/webm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function safeFile(base, relativePath) {
  const file = resolve(base, relativePath.replace(/^\/+/, ''));
  return file === base || file.startsWith(base + sep) ? file : undefined;
}

const server = createServer((request, response) => {
  const pathname = new URL(request.url || '/', `http://${host}:${port}`).pathname;
  if (pathname === '/health') {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('ok');
    return;
  }

  const fixturePrefix = '/fixtures/';
  const file = pathname.startsWith(fixturePrefix)
    ? safeFile(fixtureDir, pathname.slice(fixturePrefix.length))
    : safeFile(publicDir, pathname === '/' ? 'index.html' : pathname);

  if (!file || !existsSync(file) || !statSync(file).isFile()) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }

  response.writeHead(200, {
    'content-type': mime[extname(file).toLowerCase()] || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  if (request.method === 'HEAD') response.end();
  else createReadStream(file).pipe(response);
});

server.listen(port, host, () => {
  console.log(`piweb E2E fixture server listening on http://${host}:${port}`);
});
