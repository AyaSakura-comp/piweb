import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const publicDir = resolve(root, 'public');
const fixtureDir = resolve(root, 'test/e2e/fixtures');
const host = '127.0.0.1';
const port = Number(process.env.PIWEB_E2E_PORT || 4173);

const claudeFixture = {
  nextId: 1,
  busy: false,
  model: 'claude-code/haiku',
  thinking: 'high',
  events: [],
  clients: new Set(),
  timers: new Set(),
};

const CLAUDE_MODELS = ['haiku', 'sonnet', 'opus'].map((id) => ({
  ref: `claude-code/${id}`,
  provider: 'claude-code',
  id,
  name: `Claude ${id[0].toUpperCase()}${id.slice(1)} (Claude Code)`,
  reasoning: true,
  supportsXhigh: true,
}));

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

function sendJson(response, status, value) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(value));
}

function fixtureSession() {
  const id = claudeFixture.events.at(-1)?.id ?? 0;
  return {
    jid: 'web:claude1',
    name: 'Claude tmux lab',
    folder: 'web_claude1',
    model: claudeFixture.model,
    thinking: claudeFixture.thinking,
    cwd: '/home/demo/project',
    busy: claudeFixture.busy,
    lastReplyId: id,
    lastActivity: '2026-08-25 09:00:00',
    provider: 'claude-code',
    runningModel: claudeFixture.model.split('/')[1],
    pendingModel: false,
    badge: { label: 'CLAUDE', kind: 'claude' },
  };
}

function writeSse(response, event, data, id) {
  if (id) response.write(`id: ${id}\n`);
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event, data, id) {
  for (const response of claudeFixture.clients) writeSse(response, event, data, id);
}

function appendFixtureEvent(kind, content, role = '') {
  const event = {
    id: claudeFixture.nextId++,
    kind,
    role,
    content,
    files: [],
    createdAt: new Date().toISOString(),
  };
  claudeFixture.events.push(event);
  broadcast('event', event, event.id);
  return event;
}

function setFixtureBusy(busy) {
  claudeFixture.busy = busy;
  broadcast('busy', { busy });
}

function scheduleFixture(delay, fn) {
  const timer = setTimeout(() => {
    claudeFixture.timers.delete(timer);
    fn();
  }, delay);
  claudeFixture.timers.add(timer);
}

function clearFixtureTimers() {
  for (const timer of claudeFixture.timers) clearTimeout(timer);
  claudeFixture.timers.clear();
}

function readJsonBody(request, callback) {
  let raw = '';
  request.on('data', (chunk) => {
    raw += chunk;
  });
  request.on('end', () => {
    try {
      callback(raw ? JSON.parse(raw) : {});
    } catch {
      callback({});
    }
  });
}

function handleClaudeFixtureApi(request, response, pathname) {
  const method = request.method || 'GET';
  if (pathname === '/api/me' && method === 'GET') {
    sendJson(response, 200, { authed: true, via: 'token', funnel: false });
    return true;
  }
  if (pathname === '/api/commands' && method === 'GET') {
    sendJson(response, 200, {
      commands: [
        {
          name: 'pi model',
          description: 'Set model',
          arg: { name: 'model', kind: 'model', required: true },
        },
        { name: 'pi stop', description: 'Stop current task' },
      ],
    });
    return true;
  }
  if (pathname === '/api/models' && method === 'GET') {
    sendJson(response, 200, { models: CLAUDE_MODELS });
    return true;
  }
  if (pathname === '/api/sessions' && method === 'GET') {
    sendJson(response, 200, { sessions: [fixtureSession()] });
    return true;
  }
  if (pathname === '/api/sessions/deleted' && method === 'GET') {
    sendJson(response, 200, { sessions: [] });
    return true;
  }

  const decoded = decodeURIComponent(pathname);
  if (decoded === '/api/sessions/web:claude1/events' && method === 'GET') {
    sendJson(response, 200, {
      events: claudeFixture.events,
      busy: claudeFixture.busy,
      hasMore: false,
      hasMoreNewer: false,
      partial: null,
    });
    return true;
  }
  if (decoded === '/api/sessions/web:claude1/stream' && method === 'GET') {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    claudeFixture.clients.add(response);
    writeSse(response, 'busy', { busy: claudeFixture.busy });
    request.on('close', () => claudeFixture.clients.delete(response));
    return true;
  }
  if (decoded === '/api/sessions/web:claude1/messages' && method === 'POST') {
    readJsonBody(request, (body) => {
      const text = String(body.text || '');
      appendFixtureEvent('message', text, 'user');
      setFixtureBusy(true);
      if (/long verification/i.test(text)) {
        scheduleFixture(300, () =>
          appendFixtureEvent('thinking', 'Running an extended verification pass…'),
        );
      } else {
        scheduleFixture(350, () =>
          appendFixtureEvent('thinking', 'Reading the bridge implementation'),
        );
        scheduleFixture(700, () => appendFixtureEvent('tool', 'README.piweb.md', 'Read'));
        scheduleFixture(1050, () =>
          appendFixtureEvent('tool_result', 'Persistent tmux bridge documentation loaded.'),
        );
        scheduleFixture(1500, () => {
          appendFixtureEvent(
            'message',
            'Claude Code stays warm in tmux, works autonomously, and streams its structured tool activity back into Piweb.',
            'assistant',
          );
          setFixtureBusy(false);
        });
      }
      sendJson(response, 202, { ok: true });
    });
    return true;
  }
  if (decoded === '/api/sessions/web:claude1/commands' && method === 'POST') {
    readJsonBody(request, (body) => {
      if (body.command === 'pi model' && body.args?.model) claudeFixture.model = body.args.model;
      if (body.command === 'pi stop') {
        clearFixtureTimers();
        appendFixtureEvent('system', 'Stopped the Claude Code tmux task.', 'interrupt');
        setFixtureBusy(false);
      }
      sendJson(response, 202, { ok: true });
    });
    return true;
  }
  return false;
}

const server = createServer((request, response) => {
  const pathname = new URL(request.url || '/', `http://${host}:${port}`).pathname;
  if (handleClaudeFixtureApi(request, response, pathname)) return;
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
