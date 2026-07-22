/**
 * piweb HTTP server — mobile web UI + JSON API + SSE.
 *
 * Deliberately built on node:http with no framework. The surface is small
 * (a dozen JSON routes, one SSE stream, two static trees) and the container
 * image stays dependency-free apart from what the agent core already needs.
 *
 * It never runs pi. Everything that needs a pi subprocess or the worker's
 * in-memory state goes through the control queue in SQLite; see
 * src/worker/control.ts.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  appendWebEvent,
  deleteWebEvents,
  enqueueControl,
  enqueueMessage,
  getChannel,
  getMeta,
  getRecentWebEvents,
  getWebEventsAround,
  getWebEventsBefore,
  getWebEventsSince,
  hasWebEventsAfter,
  hasWebEventsBefore,
  searchWebEvents,
  isChannelBusy,
  isChannelDeleted,
  listDeletedWebSessions,
  listWebSessions,
  purgeChannel,
  renameChannel,
  restoreChannel,
  softDeleteChannel,
  registerChannel,
  type WebEventRow,
} from '../db.js';
import { COMMANDS } from '../commands/catalog.js';
import { mediaDirName, mediaFileName, mediaUrl } from '../media-path.js';
import { rm } from 'node:fs/promises';
import { resolveChannelSessionDir } from '../session/path.js';
import { getSessionModel, providerBadge, providerFromRef } from '../session/model-info.js';
import {
  buildSetCookie,
  COOKIE_NAME,
  cookieIsValid,
  isSameOriginRequest,
  issueCookie,
  parseCookies,
  tailscaleIdentity,
  tokenMatches,
} from './auth.js';

const PUBLIC_DIR = resolve(fileURLToPath(new URL('../../public', import.meta.url)));

/** Body cap. Phone photos arrive base64-inflated, so allow generous headroom. */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  // KaTeX fonts: the wrong type makes some browsers refuse the font.
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const raw = await readBody(req);
  if (!raw) return {} as T;
  return JSON.parse(raw) as T;
}

/** Serve a file from `root`, refusing anything that escapes it via `..`. */
function serveStatic(res: ServerResponse, root: string, relPath: string): boolean {
  const target = join(root, normalize(relPath).replace(/^(\.\.[/\\])+/, ''));
  if (!target.startsWith(root)) return false;
  if (!existsSync(target) || !statSync(target).isFile()) return false;

  res.writeHead(200, {
    'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': root === PUBLIC_DIR ? 'no-cache' : 'public, max-age=31536000',
  });
  createReadStream(target).pipe(res);
  return true;
}

function isSecureRequest(req: IncomingMessage): boolean {
  // Behind Tailscale serve / any TLS proxy the hop to us is plain HTTP, so the
  // forwarded header is what decides whether the cookie may be Secure.
  const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? '';
  return proto.split(',')[0].trim() === 'https';
}

/**
 * Two ways in: a cookie from token login, or a Tailscale identity injected by
 * `tailscale serve`. The identity path is what lets the phone just open the URL
 * with nothing to type; the token remains for local/dev access and for setups
 * that aren't behind serve.
 */
function isAuthed(req: IncomingMessage): boolean {
  if (cookieIsValid(parseCookies(req.headers.cookie)[COOKIE_NAME])) return true;
  return Boolean(tailscaleIdentity(req.headers, req.socket.remoteAddress));
}

function whoami(req: IncomingMessage): string | undefined {
  return tailscaleIdentity(req.headers, req.socket.remoteAddress)?.login;
}

/** A web session is just a channel row with a `web:` jid. */
function webJid(id: string): string {
  return id.startsWith('web:') ? id : `web:${id}`;
}

/** Page size guard: a client asking for 100k events would defeat the point. */
const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;

function clampLimit(raw: string | null): number {
  const n = Number(raw ?? '');
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PAGE;
  return Math.min(Math.floor(n), MAX_PAGE);
}

function serializeEvent(row: WebEventRow) {
  return {
    id: row.rowid,
    kind: row.kind,
    role: row.role,
    content: row.content,
    files: row.files ? (JSON.parse(row.files) as string[]) : [],
    createdAt: row.created_at,
  };
}

export function startWebServer(): ReturnType<typeof createServer> {
  // One of the two auth paths must exist. This endpoint can run commands on the
  // host, so starting with neither would publish an unauthenticated RCE.
  if (!config.webAuthToken && !config.webTrustTailscaleIdentity) {
    throw new Error(
      'No authentication configured: set WEB_AUTH_TOKEN, or enable WEB_TRUST_TAILSCALE_IDENTITY behind `tailscale serve`. Refusing to start.',
    );
  }

  // Trusting identity headers while listening on a non-loopback address would
  // let anything that can reach the port forge them. tailscaleIdentity() also
  // enforces this per request; warn loudly because the config is a mistake.
  const loopbackOnly = config.webHost === '127.0.0.1' || config.webHost === '::1';
  if (config.webTrustTailscaleIdentity && !loopbackOnly) {
    logger.warn(
      { webHost: config.webHost },
      'WEB_TRUST_TAILSCALE_IDENTITY is on but WEB_HOST is not loopback — identity headers will be ignored for non-loopback connections',
    );
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      logger.error({ err: err.message, url: req.url }, 'Request failed');
      if (!res.headersSent) sendJson(res, 500, { error: err.message });
      else res.end();
    });
  });

  server.listen(config.webPort, config.webHost, () => {
    logger.info({ host: config.webHost, port: config.webPort }, 'piweb web server listening');
  });

  return server;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;
  const method = req.method ?? 'GET';

  // ── unauthenticated routes ──
  if (path === '/api/login' && method === 'POST') {
    const body = await readJson<{ token?: string }>(req);
    if (!tokenMatches(body.token ?? '')) {
      // Same delay regardless of outcome would be better, but the token is
      // compared in constant time and there is no user enumeration here.
      sendJson(res, 401, { error: 'Invalid token' });
      return;
    }
    res.setHeader('set-cookie', buildSetCookie(issueCookie(), isSecureRequest(req)));
    sendJson(res, 200, { ok: true });
    return;
  }

  if (path === '/api/logout' && method === 'POST') {
    res.setHeader('set-cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; Max-Age=0`);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (path === '/api/me') {
    const identity = tailscaleIdentity(req.headers, req.socket.remoteAddress);
    sendJson(res, 200, {
      authed: isAuthed(req),
      // Lets the UI skip the login screen entirely and show who serve says you
      // are; also the check used to verify header injection is really working.
      via: identity ? 'tailscale' : isAuthed(req) ? 'token' : null,
      login: identity?.login,
      name: identity?.name,
    });
    return;
  }

  // The login screen is part of the SPA, so the shell itself stays public;
  // every route that touches data is gated below.
  if (method === 'GET' && (path === '/' || path === '/index.html')) {
    if (serveStatic(res, PUBLIC_DIR, 'index.html')) return;
    sendJson(res, 500, { error: 'UI not built' });
    return;
  }

  if (method === 'GET' && !path.startsWith('/api/') && !path.startsWith('/media/')) {
    if (serveStatic(res, PUBLIC_DIR, path)) return;
  }

  // ── everything below requires auth ──
  if (!isAuthed(req)) {
    sendJson(res, 401, { error: 'Not authenticated' });
    return;
  }

  // CSRF gate. Tailscale identity is attached by serve to whatever the browser
  // sends, including requests a hostile page triggers, so authentication alone
  // does not make a mutation safe — the origin has to match too.
  if (method !== 'GET' && method !== 'HEAD' && !isSameOriginRequest(req.headers, req.headers.host)) {
    logger.warn(
      { url: req.url, origin: req.headers.origin, login: whoami(req) },
      'Rejected cross-origin state-changing request',
    );
    sendJson(res, 403, { error: 'Cross-origin request refused' });
    return;
  }

  if (method === 'GET' && path.startsWith('/media/')) {
    if (serveStatic(res, config.webMediaDir, decodeURIComponent(path.slice('/media/'.length)))) {
      return;
    }
    sendJson(res, 404, { error: 'Not found' });
    return;
  }

  if (path === '/api/commands' && method === 'GET') {
    sendJson(res, 200, { commands: COMMANDS });
    return;
  }

  if (path === '/api/models' && method === 'GET') {
    const raw = getMeta('models');
    sendJson(res, 200, { models: raw ? JSON.parse(raw) : [] });
    return;
  }

  // ── sessions ──
  if (path === '/api/sessions' && method === 'GET') {
    const sessions = listWebSessions().map((s) => {
      // What pi is really running, read from its own session file — not the
      // override, which can be empty or stale (see session/model-info.ts).
      const running = getSessionModel(s.folder);
      // No session file yet (new, or rotated by /pi new): fall back to the
      // override so the badge reflects what the next run will use.
      const provider = running?.provider || providerFromRef(s.modelOverride);
      return {
        jid: s.jid,
        name: s.name,
        busy: s.busy,
        model: s.modelOverride,
        thinking: s.thinkingOverride,
        cwd: s.cwdOverride,
        lastActivity: s.lastActivity,
        lastReplyId: s.lastReplyId,
        provider,
        runningModel: running?.modelId ?? s.modelOverride,
        // `pending` marks a badge that describes intent rather than a live run.
        pending: !running && Boolean(provider),
        badge: provider ? providerBadge(provider) : null,
      };
    });
    sendJson(res, 200, { sessions });
    return;
  }

  if (path === '/api/sessions' && method === 'POST') {
    const body = await readJson<{ name?: string }>(req);
    const name = (body.name ?? '').trim() || 'New session';
    const id = randomUUID().slice(0, 8);
    const jid = webJid(id);

    registerChannel({
      jid,
      name,
      // Session files are keyed by folder; keep it filesystem-safe and unique.
      folder: `web_${id}`,
      requiresTrigger: false,
      isMain: false,
      modelOverride: '',
      thinkingOverride: '',
      cwdOverride: '',
    });

    // Guarantee a clean pi context for every new session. A freshly minted
    // folder has nothing to rotate, so this is usually a no-op — it is here so
    // "new session" can never inherit an agent context, including if a folder
    // name is ever reused or left behind by a deleted session. Silent: the
    // guarantee is implied by creating the session, so it needs no system line
    // in an otherwise empty transcript.
    enqueueControl(jid, 'pi new', { silent: 'true', keepQueue: 'true' });

    sendJson(res, 200, { jid, name });
    return;
  }

  // Before the /:jid matcher, or "deleted" would be treated as a session id.
  if (path === '/api/sessions/deleted' && method === 'GET') {
    sendJson(res, 200, { sessions: listDeletedWebSessions() });
    return;
  }

  const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)(?:\/(.+))?$/);
  if (sessionMatch) {
    const jid = webJid(decodeURIComponent(sessionMatch[1]));
    const sub = sessionMatch[2];
    const channel = getChannel(jid);

    if (!channel) {
      sendJson(res, 404, { error: 'Session not found' });
      return;
    }

    // Default DELETE is a soft delete into the trash. ?permanent=1 destroys
    // the transcript AND pi's session directory, and cannot be undone.
    if (!sub && method === 'DELETE') {
      if (url.searchParams.get('permanent') === '1') {
        await purgeSessionFiles(channel.folder, jid);
        purgeChannel(jid);
        sendJson(res, 200, { ok: true, permanent: true });
        return;
      }
      softDeleteChannel(jid);
      sendJson(res, 200, { ok: true, permanent: false });
      return;
    }

    if (sub === 'restore' && method === 'POST') {
      const restored = restoreChannel(jid);
      sendJson(res, restored ? 200 : 404, restored ? { ok: true } : { error: 'Not in trash' });
      return;
    }

    // "Clean session" = wipe the visible transcript AND rotate pi's session
    // dir, so the agent's context is genuinely reset rather than just hidden.
    if (sub === 'clear' && method === 'POST') {
      const removed = deleteWebEvents(jid);
      enqueueControl(jid, 'pi new');
      sendJson(res, 200, { ok: true, removed });
      return;
    }

    // Four read modes, all index-backed range scans:
    //   ?after=<id>   catch-up after a reconnect (newer than id)
    //   ?before=<id>  one page of OLDER history (infinite scroll upward)
    //   ?around=<id>  a window centred on an event (jump to a search hit)
    //   (none)        the newest page — what a fresh open shows
    if (sub === 'events' && method === 'GET') {
      const limit = clampLimit(url.searchParams.get('limit'));
      const after = Number(url.searchParams.get('after') ?? '0');
      const before = Number(url.searchParams.get('before') ?? '0');
      const around = Number(url.searchParams.get('around') ?? '0');

      let events;
      if (Number.isFinite(around) && around > 0) {
        events = getWebEventsAround(jid, around, limit);
      } else if (Number.isFinite(before) && before > 0) {
        events = getWebEventsBefore(jid, before, limit);
      } else if (Number.isFinite(after) && after > 0) {
        events = getWebEventsSince(jid, after, limit);
      } else {
        events = getRecentWebEvents(jid, limit);
      }

      const oldest = events.length > 0 ? events[0].rowid : before > 0 ? before : 0;
      const newest = events.length > 0 ? events[events.length - 1].rowid : 0;
      sendJson(res, 200, {
        events: events.map(serializeEvent),
        busy: isChannelBusy(jid),
        // Lets the client stop asking once it has reached either end.
        hasMore: oldest > 0 ? hasWebEventsBefore(jid, oldest) : false,
        hasMoreNewer: newest > 0 ? hasWebEventsAfter(jid, newest) : false,
      });
      return;
    }

    if (sub === 'search' && method === 'GET') {
      const q = (url.searchParams.get('q') ?? '').trim();
      if (q.length < 2) {
        sendJson(res, 200, { hits: [], note: 'Type at least 2 characters' });
        return;
      }
      const hits = searchWebEvents(jid, q, clampLimit(url.searchParams.get('limit')));
      sendJson(res, 200, { hits });
      return;
    }

    if (sub === 'stream' && method === 'GET') {
      streamEvents(req, res, jid, Number(url.searchParams.get('after') ?? '0'));
      return;
    }

    // A trashed session is readable (so it can be previewed) but frozen.
    if (
      (method === 'POST' && (sub === 'messages' || sub === 'commands' || sub === 'clear')) ||
      (method === 'PATCH' && !sub)
    ) {
      if (isChannelDeleted(jid)) {
        sendJson(res, 409, { error: 'This session is in the trash — restore it first' });
        return;
      }
    }

    if (!sub && method === 'PATCH') {
      const body = await readJson<{ name?: string }>(req);
      const name = (body.name ?? '').trim();
      if (!name) {
        sendJson(res, 400, { error: 'Name cannot be empty' });
        return;
      }
      renameChannel(jid, name);
      sendJson(res, 200, { ok: true, name: name.slice(0, 80) });
      return;
    }

    if (sub === 'messages' && method === 'POST') {
      const body = await readJson<{
        text?: string;
        attachments?: Array<{ name: string; dataBase64: string }>;
      }>(req);

      const text = (body.text ?? '').trim();
      const attachments = body.attachments ?? [];
      if (!text && attachments.length === 0) {
        sendJson(res, 400, { error: 'Message is empty' });
        return;
      }

      const savedPaths = await saveUploads(jid, attachments);

      // Mirror the user turn into the transcript immediately so the phone sees
      // its own message without waiting for the worker to pick it up.
      appendWebEvent({
        channelJid: jid,
        kind: 'message',
        role: 'user',
        content: text,
        files: savedPaths.urls,
      });

      enqueueMessage({
        channelJid: jid,
        sender: 'web',
        senderName: 'web',
        content: text,
        timestamp: new Date().toISOString(),
        // AttachmentMeta shape, using the local-file variant: media.ts copies
        // these instead of fetching, so uploads flow through the same
        // transcode/voice-ASR/@file pipeline as Discord attachments.
        attachments:
          savedPaths.files.length > 0
            ? JSON.stringify(
                savedPaths.files.map((filePath, i) => ({
                  url: '',
                  name: attachments[i]?.name ?? 'file',
                  contentType: '',
                  size: 0,
                  filePath,
                })),
              )
            : null,
      });

      sendJson(res, 200, { ok: true });
      return;
    }

    if (sub === 'commands' && method === 'POST') {
      const body = await readJson<{ command?: string; args?: Record<string, string> }>(req);
      const command = (body.command ?? '').trim();
      if (!COMMANDS.some((c) => c.name === command)) {
        sendJson(res, 400, { error: `Unknown command: ${command}` });
        return;
      }

      // Echo the invocation into the transcript so the exchange reads like a
      // conversation rather than settings mutating invisibly.
      appendWebEvent({ channelJid: jid, kind: 'message', role: 'user', content: `/${command}` });
      const rowid = enqueueControl(jid, command, body.args ?? {});
      sendJson(res, 200, { ok: true, rowid });
      return;
    }
  }

  sendJson(res, 404, { error: 'Not found' });
}

/**
 * Remove everything a purged session owns on disk: pi's session directory
 * (the real conversation) plus its served media and staged uploads.
 */
async function purgeSessionFiles(folder: string, jid: string): Promise<void> {
  const targets = [
    resolveChannelSessionDir(folder),
    join(config.webMediaDir, mediaDirName(jid)),
    join(config.webUploadDir, mediaDirName(jid)),
  ];
  for (const target of targets) {
    await rm(target, { recursive: true, force: true }).catch((err) =>
      logger.warn({ err: err.message, target }, 'purge: failed to remove'),
    );
  }
}

/**
 * Stage browser uploads on disk and return both the pi-facing paths and the
 * browser-facing URLs (so the user's own photo renders in their bubble).
 */
async function saveUploads(
  jid: string,
  attachments: Array<{ name: string; dataBase64: string }>,
): Promise<{ files: string[]; urls: string[] }> {
  if (attachments.length === 0) return { files: [], urls: [] };

  const uploadDir = join(config.webUploadDir, mediaDirName(jid));
  const mediaDir = join(config.webMediaDir, mediaDirName(jid));
  await mkdir(uploadDir, { recursive: true });
  await mkdir(mediaDir, { recursive: true });

  const files: string[] = [];
  const urls: string[] = [];

  for (const attachment of attachments) {
    const safeName = mediaFileName(randomUUID().slice(0, 8), attachment.name);
    const buffer = Buffer.from(attachment.dataBase64, 'base64');

    if (config.maxAttachmentBytes > 0 && buffer.length > config.maxAttachmentBytes) {
      throw new Error(`Attachment exceeds the size limit: ${attachment.name}`);
    }

    const piPath = join(uploadDir, safeName);
    await writeFile(piPath, buffer);
    files.push(piPath);

    // A second copy under the served media root — webUploadDir is deliberately
    // not exposed over HTTP.
    await writeFile(join(mediaDir, safeName), buffer);
    urls.push(mediaUrl(jid, safeName));
  }

  return { files, urls };
}

/**
 * SSE tail of a channel's events.
 *
 * Polls SQLite rather than being pushed to, because the producer is a different
 * process (and container). At 400ms the lag is invisible next to how long pi
 * takes to think, and it keeps the two halves coupled only through the DB.
 */
function streamEvents(
  req: IncomingMessage,
  res: ServerResponse,
  jid: string,
  afterRowid: number,
): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // Without this an nginx/Tailscale hop may buffer the stream into silence.
    'x-accel-buffering': 'no',
  });

  let cursor = afterRowid;
  let lastBusy: boolean | undefined;
  let closed = false;

  const send = (event: string, data: unknown) => {
    if (closed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  send('hello', { cursor });

  const timer = setInterval(() => {
    if (closed) return;
    try {
      const rows = getWebEventsSince(jid, cursor);
      for (const row of rows) {
        cursor = row.rowid;
        send('event', serializeEvent(row));
      }

      const busy = isChannelBusy(jid);
      if (busy !== lastBusy) {
        lastBusy = busy;
        send('busy', { busy });
      }
    } catch (err: any) {
      logger.warn({ err: err.message, jid }, 'SSE poll failed');
    }
  }, 400);

  // Comment frames keep intermediaries from reaping an idle stream while pi is
  // thinking for minutes with nothing to say.
  const keepAlive = setInterval(() => {
    if (!closed) res.write(': keep-alive\n\n');
  }, 15_000);

  const cleanup = () => {
    closed = true;
    clearInterval(timer);
    clearInterval(keepAlive);
  };

  req.on('close', cleanup);
  req.on('error', cleanup);
}
