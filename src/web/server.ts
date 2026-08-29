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
import { extractSessionTitle } from '../agent/session-title.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { buildQuotedDisplay, buildQuotedPrompt, normalizeQuote } from '../quoted-message.js';
import {
  appendWebEvent,
  archiveLifeSessionAndStartNew,
  beginChannelOperation,
  CHANNEL_GENERATION_CHANGED_ERROR,
  commitLifeControlOperation,
  commitLifeMessageOperation,
  deletePushSubscription,
  deleteWebEvents,
  enqueueControl,
  enqueueMessage,
  getChannel,
  getFirstUserMessageContent,
  getMeta,
  getOrCreateLifeChannel,
  getRecentWebEvents,
  getSessionTitleJob,
  getWebEventsAround,
  getWebEventsBefore,
  getWebEventsSince,
  finishChannelOperation,
  hasWebEventsAfter,
  hasWebEventsBefore,
  searchWebEvents,
  isChannelBusy,
  isChannelDeleted,
  isChannelQuarantinedForLifeArchive,
  isLifeArchiveMediaDirQuarantined,
  LIFE_ARCHIVE_QUARANTINE_ERROR,
  listDeletedWebSessions,
  listWebSessions,
  purgeChannel,
  renameChannel,
  restoreChannel,
  softDeleteChannel,
  registerChannel,
  savePushSubscription,
  touchChannelOperation,
  type WebEventRow,
  listSessionMedia,
  getLiveOutput,
} from '../db.js';
import { COMMANDS } from '../commands/catalog.js';
import { mediaDirName, mediaFileName, mediaUrl } from '../media-path.js';
import { rm } from 'node:fs/promises';
import { listSessionFamilyDirs, resolveChannelSessionDir } from '../session/path.js';
import {
  getSessionModel,
  modelIdFromRef,
  providerBadge,
  providerFromRef,
} from '../session/model-info.js';
import { getPushPublicKey, startPush } from './push.js';
import {
  buildSessionTitleSource,
  resolveSessionCreationTitle,
} from './session-title-source.js';
import {
  buildSetCookie,
  COOKIE_NAME,
  cookieIsValid,
  isFunnelRequest,
  isSameOriginRequest,
  issueCookie,
  parseCookies,
  tailscaleIdentity,
  tokenMatches,
} from './auth.js';

export const PUBLIC_DIR = resolve(fileURLToPath(new URL('../../public', import.meta.url)));

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

function cleanStaticRelativePath(relPath: string): string {
  return normalize(relPath).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
}

/** Serve a file from `root`, refusing anything that escapes it via `..`. */
export function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  root: string,
  relPath: string,
): boolean {
  const cleanRel = cleanStaticRelativePath(relPath);
  const target = join(root, cleanRel);
  if (!target.startsWith(root)) return false;
  if (!existsSync(target)) return false;
  const stat = statSync(target);
  if (!stat.isFile()) return false;

  const isImmutable =
    root !== PUBLIC_DIR ||
    cleanRel.startsWith('vendor/') ||
    cleanRel.startsWith('icons/') ||
    cleanRel.startsWith('favicon');

  const cacheControl = isImmutable
    ? 'public, max-age=31536000, immutable'
    : 'no-cache';

  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const lastModified = stat.mtime.toUTCString();

  const headers: Record<string, string | number> = {
    'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': cacheControl,
    'accept-ranges': 'bytes',
    etag,
    'last-modified': lastModified,
  };

  const ifNoneMatch = req.headers['if-none-match'];
  if (ifNoneMatch) {
    if (ifNoneMatch === etag || ifNoneMatch === etag.replace(/^W\//, '') || ifNoneMatch === '*') {
      res.writeHead(304, headers);
      res.end();
      return true;
    }
  } else if (req.headers['if-modified-since']) {
    const ifModifiedSince = new Date(req.headers['if-modified-since']).getTime();
    if (
      Number.isFinite(ifModifiedSince) &&
      Math.floor(stat.mtimeMs / 1000) <= Math.floor(ifModifiedSince / 1000)
    ) {
      res.writeHead(304, headers);
      res.end();
      return true;
    }
  }

  const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
  if (range && (range[1] || range[2])) {
    const suffixLength = range[1] ? undefined : Number(range[2]);
    const start =
      suffixLength === undefined ? Number(range[1]) : Math.max(0, stat.size - suffixLength);
    const requestedEnd = range[2] && range[1] ? Number(range[2]) : stat.size - 1;
    const end = Math.min(requestedEnd, stat.size - 1);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end) {
      res.writeHead(416, { ...headers, 'content-range': `bytes */${stat.size}` });
      res.end();
      return true;
    }
    res.writeHead(206, {
      ...headers,
      'content-range': `bytes ${start}-${end}/${stat.size}`,
      'content-length': end - start + 1,
    });
    if (req.method === 'HEAD') res.end();
    else createReadStream(target, { start, end }).pipe(res);
    return true;
  }

  res.writeHead(200, { ...headers, 'content-length': stat.size });
  if (req.method === 'HEAD') res.end();
  else createReadStream(target).pipe(res);
  return true;
}

// ── login throttling ──
//
// Keyed by forwarded client address where available. Deliberately simple and
// in-memory: a restart clearing the counters is fine, since the point is to
// make online guessing impractical, not to be an audit trail.
const MAX_FAILURES = 8;
const LOCKOUT_MS = 60_000;
const failures = new Map<string, { count: number; until: number }>();

function clientKey(req: IncomingMessage): string {
  const fwd = (req.headers['x-forwarded-for'] as string | undefined) ?? '';
  return fwd.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
}

function isRateLimited(key: string): boolean {
  const entry = failures.get(key);
  if (!entry) return false;
  if (Date.now() > entry.until) {
    failures.delete(key);
    return false;
  }
  return entry.count >= MAX_FAILURES;
}

function recordFailure(key: string): void {
  const entry = failures.get(key) ?? { count: 0, until: 0 };
  entry.count += 1;
  entry.until = Date.now() + LOCKOUT_MS;
  failures.set(key, entry);
}

function clearFailures(key: string): void {
  failures.delete(key);
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

const LIFE_GENERATION_RE = /^web_life_[0-9a-f]{8}$/;

function requireLifeGeneration(res: ServerResponse, raw: unknown): string | undefined {
  if (typeof raw !== 'string') {
    sendJson(res, 400, { error: 'Life generation is required' });
    return undefined;
  }
  const generation = raw.trim();
  if (!LIFE_GENERATION_RE.test(generation)) {
    sendJson(res, 400, { error: 'Life generation is malformed' });
    return undefined;
  }
  return generation;
}

function heartbeatChannelOperation(operationId: string | undefined): {
  renew: () => boolean;
  stop: () => void;
} {
  if (!operationId) return { renew: () => true, stop: () => {} };
  let valid = true;
  const renew = () => {
    if (!valid) return false;
    try {
      valid = touchChannelOperation(operationId);
    } catch {
      valid = false;
    }
    return valid;
  };
  const timer = setInterval(renew, 60_000);
  timer.unref?.();
  return {
    renew,
    stop: () => clearInterval(timer),
  };
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

  startPush();

  return server;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;
  const method = req.method ?? 'GET';

  // ── unauthenticated routes ──
  if (path === '/api/login' && method === 'POST') {
    // With Funnel on, this endpoint faces the internet and the token is the
    // only thing standing in front of host command execution, so throttle
    // guessing rather than letting it run at line rate.
    const who = clientKey(req);
    if (isRateLimited(who)) {
      logger.warn({ who }, 'login: rate limited');
      sendJson(res, 429, { error: 'Too many attempts — wait a minute' });
      return;
    }

    const body = await readJson<{ token?: string }>(req);
    if (!tokenMatches(body.token ?? '')) {
      recordFailure(who);
      // Same delay regardless of outcome would be better, but the token is
      // compared in constant time and there is no user enumeration here.
      sendJson(res, 401, { error: 'Invalid token' });
      return;
    }
    clearFailures(who);
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
      // Lets the UI show that this visit came in over the public internet.
      funnel: isFunnelRequest(req.headers),
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
  if ((method === 'GET' || method === 'HEAD') && (path === '/' || path === '/index.html')) {
    if (serveStatic(req, res, PUBLIC_DIR, 'index.html')) return;
    sendJson(res, 500, { error: 'UI not built' });
    return;
  }

  if ((method === 'GET' || method === 'HEAD') && !path.startsWith('/api/') && !path.startsWith('/media/')) {
    if (serveStatic(req, res, PUBLIC_DIR, path)) return;
  }

  // ── everything below requires auth ──
  if (!isAuthed(req)) {
    sendJson(res, 401, { error: 'Not authenticated' });
    return;
  }

  // CSRF gate. Tailscale identity is attached by serve to whatever the browser
  // sends, including requests a hostile page triggers, so authentication alone
  // does not make a mutation safe — the origin has to match too.
  if (
    method !== 'GET' &&
    method !== 'HEAD' &&
    !isSameOriginRequest(req.headers, req.headers.host)
  ) {
    logger.warn(
      { url: req.url, origin: req.headers.origin, login: whoami(req) },
      'Rejected cross-origin state-changing request',
    );
    sendJson(res, 403, { error: 'Cross-origin request refused' });
    return;
  }

  if (method === 'GET' && path.startsWith('/media/')) {
    const relativePath = cleanStaticRelativePath(
      decodeURIComponent(path.slice('/media/'.length)),
    );
    const directory = relativePath.split(/[\\/]/, 1)[0] ?? '';
    if (isLifeArchiveMediaDirQuarantined(directory)) {
      sendJson(res, 503, { error: LIFE_ARCHIVE_QUARANTINE_ERROR });
      return;
    }
    if (serveStatic(req, res, config.webMediaDir, relativePath)) return;
    sendJson(res, 404, { error: 'Not found' });
    return;
  }

  // ── push ──
  if (path === '/api/push/key' && method === 'GET') {
    sendJson(res, 200, { key: getPushPublicKey() });
    return;
  }

  if (path === '/api/push/subscribe' && method === 'POST') {
    const body = await readJson<{
      endpoint?: string;
      keys?: { p256dh?: string; auth?: string };
    }>(req);
    if (!body.endpoint || !body.keys?.p256dh || !body.keys?.auth) {
      sendJson(res, 400, { error: 'Invalid subscription' });
      return;
    }
    savePushSubscription({
      endpoint: body.endpoint,
      p256dh: body.keys.p256dh,
      auth: body.keys.auth,
    });
    logger.info('push: subscription saved');
    sendJson(res, 200, { ok: true });
    return;
  }

  if (path === '/api/push/unsubscribe' && method === 'POST') {
    const body = await readJson<{ endpoint?: string }>(req);
    if (body.endpoint) deletePushSubscription(body.endpoint);
    sendJson(res, 200, { ok: true });
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
  // Starting a new Life conversation promotes the current transcript and Pi
  // folder into the ordinary session list, then replaces the singleton with a
  // new empty folder. No worker-side `pi new` is needed or enqueued.
  if (path === '/api/life-session/new' && method === 'POST') {
    const body = await readJson<{ generation?: unknown }>(req);
    const generation = requireLifeGeneration(res, body?.generation);
    if (!generation) return;

    const firstPrompt = getFirstUserMessageContent('web:life')?.trim() ?? '';
    const id = randomUUID().slice(0, 8);
    try {
      const { archived, life } = archiveLifeSessionAndStartNew({
        archivedJid: webJid(id),
        archivedName: firstPrompt ? extractSessionTitle(firstPrompt) : 'Life',
        expectedFolder: generation,
      });
      sendJson(res, 200, {
        archived: { jid: archived.jid, name: archived.name, kind: 'standard' },
        life: {
          jid: life.jid,
          name: life.name,
          kind: 'life',
          model: '',
          thinking: '',
          generation: life.folder,
          created: true,
        },
      });
    } catch (error) {
      const message = (error as Error).message;
      if (
        message === 'Life session still has active or queued work' ||
        message === 'Life session changed before it could be archived'
      ) {
        sendJson(res, 409, { error: message });
        return;
      }
      if (message === 'Life session does not exist') {
        sendJson(res, 404, { error: message });
        return;
      }
      throw error;
    }
    return;
  }

  // Life is created separately from ordinary sessions: its unique empty folder
  // needs no asynchronous `pi new`, so the first message cannot race a reset.
  if (path === '/api/life-session' && method === 'POST') {
    const { channel, created } = getOrCreateLifeChannel();
    sendJson(res, 200, {
      jid: channel.jid,
      name: channel.name,
      kind: 'life',
      model: '',
      thinking: '',
      generation: channel.folder,
      created,
    });
    return;
  }

  if (path === '/api/sessions' && method === 'GET') {
    const sessions = listWebSessions().map((s) => {
      // The badge must track the model the session is *set to*, so picking a
      // model in the sheet is reflected immediately.
      //
      // An override, when set, is passed to pi as `--model` on every run
      // (channel-settings.ts), so it is what the session uses — it wins. The
      // session file only records what the last run happened to use, which goes
      // stale the moment the model is changed and no message has been sent yet.
      // With no override (following the gateway default) the session file is the
      // only honest source, so fall back to it.
      const running = getSessionModel(s.folder);
      const overrideProvider = providerFromRef(s.modelOverride);
      const provider = overrideProvider || running?.provider || '';
      // For the Codex GPT-5.6 variants the badge is the codename (Terra/Sol/Luna),
      // which needs the model id, not just the provider.
      const badgeModelId = s.modelOverride || running?.modelId || '';
      return {
        jid: s.jid,
        name: s.name,
        kind: s.kind,
        busy: s.busy,
        model: s.modelOverride,
        thinking: s.thinkingOverride,
        cwd: s.cwdOverride,
        lastActivity: s.lastActivity,
        lastReplyId: s.lastReplyId,
        provider,
        runningModel: badgeModelId,
        // `pending` marks a badge that describes intent rather than a live run:
        // an override chosen but not yet exercised by an actual run. The
        // override is a ref ("openai-codex/gpt-5.6-sol"); modelId is the bare id.
        pending: overrideProvider
          ? modelIdFromRef(s.modelOverride) !== (running?.modelId ?? '')
          : !running,
        badge: provider ? providerBadge(provider, badgeModelId) : null,
      };
    });
    sendJson(res, 200, { sessions });
    return;
  }

  if (path === '/api/sessions' && method === 'POST') {
    const body = await readJson<{ name?: string }>(req);
    const { name, prepareSessionTitle } = resolveSessionCreationTitle(body.name);
    const id = randomUUID().slice(0, 8);
    const jid = webJid(id);

    // Existing and explicitly named API sessions are deliberately not auto-renamed.
    // Preparing the row in the same transaction makes only unnamed UI sessions eligible.
    registerChannel(
      {
        jid,
        name,
        // Session files are keyed by folder; keep it filesystem-safe and unique.
        folder: `web_${id}`,
        requiresTrigger: false,
        isMain: false,
        modelOverride: '',
        thinkingOverride: '',
        cwdOverride: '',
      },
      { prepareSessionTitle },
    );

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

    // The DB re-key becomes visible before its media/upload renames can finish.
    // Quarantine the archived owner before reading a body, staging files, or
    // touching its Pi/transcript state; recovery is the only allowed writer.
    if (isChannelQuarantinedForLifeArchive(jid)) {
      sendJson(res, 503, { error: LIFE_ARCHIVE_QUARANTINE_ERROR });
      return;
    }

    const channel = getChannel(jid);
    if (!channel) {
      sendJson(res, 404, { error: 'Session not found' });
      return;
    }

    // Life exposes transcript/message/search/stream routes, but is not a
    // manageable session. Enforce this here as well as hiding the controls.
    if (
      channel.kind === 'life' &&
      ((!sub && (method === 'PATCH' || method === 'DELETE')) ||
        (method === 'POST' && ['clear', 'restore'].includes(sub ?? '')))
    ) {
      sendJson(res, 409, { error: 'Life always uses default settings and cannot be managed' });
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

    // Every Life read is bound to the generation the tab selected. Otherwise a
    // stale tab could page, search, or stream the replacement web:life and mix
    // a different conversation into its old UI.
    let expectedLifeGeneration: string | undefined;
    if (
      channel.kind === 'life' &&
      method === 'GET' &&
      ['events', 'media', 'search', 'stream'].includes(sub ?? '')
    ) {
      expectedLifeGeneration = requireLifeGeneration(res, url.searchParams.get('generation'));
      if (!expectedLifeGeneration) return;
      if (expectedLifeGeneration !== channel.folder) {
        sendJson(res, 409, { error: 'Life session generation changed' });
        return;
      }
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
        // Opening a session mid-reply should show the text so far, not nothing.
        partial: getLiveOutput(jid),
        // Lets the client stop asking once it has reached either end.
        hasMore: oldest > 0 ? hasWebEventsBefore(jid, oldest) : false,
        hasMoreNewer: newest > 0 ? hasWebEventsAfter(jid, newest) : false,
        // Navigation may arrive from a notification before the browser's
        // session-list cache refreshes. Let that event request prove whether
        // the target is a live standard session, Life, or a frozen trash item.
        session: {
          jid: channel.jid,
          name: channel.name,
          kind: channel.kind ?? 'standard',
          ...(channel.kind === 'life' ? { generation: channel.folder } : {}),
          deleted: isChannelDeleted(jid),
        },
      });
      return;
    }

    if (sub === 'media' && method === 'GET') {
      sendJson(res, 200, { items: listSessionMedia(jid) });
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
      streamEvents(
        req,
        res,
        jid,
        Number(url.searchParams.get('after') ?? '0'),
        expectedLifeGeneration,
      );
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
        quote?: string;
        attachments?: Array<{ name: string; dataBase64: string }>;
        lifeGeneration?: unknown;
      }>(req);

      const lifeGeneration =
        channel.kind === 'life'
          ? requireLifeGeneration(res, body?.lifeGeneration)
          : undefined;
      if (channel.kind === 'life' && !lifeGeneration) return;
      const operationId =
        channel.kind === 'life' ? beginChannelOperation(jid, lifeGeneration!) : undefined;
      if (channel.kind === 'life' && !operationId) {
        sendJson(res, 409, { error: 'Life session changed while this message was submitted' });
        return;
      }
      const operationHeartbeat = heartbeatChannelOperation(operationId);

      try {
        const text = (body.text ?? '').trim();
        const quote = normalizeQuote(body.quote);
        const attachments = body.attachments ?? [];
        if (!text && !quote && attachments.length === 0) {
          sendJson(res, 400, { error: 'Message is empty' });
          return;
        }

        const savedPaths = await saveUploads(jid, attachments, operationId);
        if (!operationHeartbeat.renew()) {
          await cleanupOperationUploads(savedPaths);
          sendJson(res, 409, { error: 'Life session changed while uploads were saved' });
          return;
        }

        // Capture exactly the first normal prompt for an independent title job.
        // The message and title source commit together, so a crash cannot let a
        // later turn take this first-turn slot. The worker erases its copy after
        // the in-process statistical title extraction finishes.
        const titleSource = buildSessionTitleSource(
          text,
          quote,
          attachments.map((file) => file.name),
        );
        const immediateSessionTitle = titleSource ? extractSessionTitle(titleSource) : undefined;
        const queuedMessage = {
          sender: 'web',
          senderName: 'web',
          content: buildQuotedPrompt(text, quote),
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
          sessionTitlePrompt: titleSource,
          immediateSessionTitle,
        };
        let messageRowid: number;
        try {
          if (operationId && lifeGeneration) {
            messageRowid = commitLifeMessageOperation({
              operationId,
              channelJid: jid,
              expectedFolder: lifeGeneration,
              event: {
                kind: 'message',
                role: 'user',
                content: buildQuotedDisplay(text, quote),
                files: savedPaths.urls,
              },
              message: queuedMessage,
            });
          } else {
            appendWebEvent({
              channelJid: jid,
              kind: 'message',
              role: 'user',
              content: buildQuotedDisplay(text, quote),
              files: savedPaths.urls,
            });
            messageRowid = enqueueMessage({ channelJid: jid, ...queuedMessage });
          }
        } catch (error) {
          await cleanupOperationUploads(savedPaths);
          if ((error as Error).message === CHANNEL_GENERATION_CHANGED_ERROR) {
            sendJson(res, 409, { error: 'Life session changed before the message committed' });
            return;
          }
          throw error;
        }

        const titleJob = getSessionTitleJob(jid);
        const appliedSessionTitle =
          immediateSessionTitle &&
          titleJob?.status === 'done' &&
          titleJob.message_rowid === messageRowid &&
          getChannel(jid)?.name === immediateSessionTitle
            ? immediateSessionTitle
            : undefined;
        sendJson(res, 200, {
          ok: true,
          ...(appliedSessionTitle ? { sessionTitle: appliedSessionTitle } : {}),
        });
        return;
      } finally {
        operationHeartbeat.stop();
        if (operationId) finishChannelOperation(operationId);
      }
    }

    if (sub === 'commands' && method === 'POST') {
      const body = await readJson<{
        command?: string;
        args?: Record<string, string>;
        lifeGeneration?: unknown;
      }>(req);
      const lifeGeneration =
        channel.kind === 'life'
          ? requireLifeGeneration(res, body?.lifeGeneration)
          : undefined;
      if (channel.kind === 'life' && !lifeGeneration) return;
      const operationId =
        channel.kind === 'life' ? beginChannelOperation(jid, lifeGeneration!) : undefined;
      if (channel.kind === 'life' && !operationId) {
        sendJson(res, 409, { error: 'Life session changed while this command was submitted' });
        return;
      }
      const operationHeartbeat = heartbeatChannelOperation(operationId);

      try {
        const command = (body.command ?? '').trim();
        if (
          channel.kind === 'life' &&
          ['pi model', 'pi reset-model', 'pi thinking', 'pi cwd', 'pi reset-cwd'].includes(command)
        ) {
          sendJson(res, 409, { error: 'Life always uses default settings' });
          return;
        }
        if (!COMMANDS.some((c) => c.name === command)) {
          sendJson(res, 400, { error: `Unknown command: ${command}` });
          return;
        }

        // Echo and enqueue commit together for Life so a stale request cannot
        // split one invocation across two folder generations.
        let rowid: number;
        if (operationId && lifeGeneration) {
          try {
            rowid = commitLifeControlOperation({
              operationId,
              channelJid: jid,
              expectedFolder: lifeGeneration,
              command,
              args: body.args ?? {},
            });
          } catch (error) {
            if ((error as Error).message === CHANNEL_GENERATION_CHANGED_ERROR) {
              sendJson(res, 409, { error: 'Life session changed before the command committed' });
              return;
            }
            throw error;
          }
        } else {
          appendWebEvent({ channelJid: jid, kind: 'message', role: 'user', content: `/${command}` });
          rowid = enqueueControl(jid, command, body.args ?? {});
        }
        sendJson(res, 200, { ok: true, rowid });
        return;
      } finally {
        operationHeartbeat.stop();
        if (operationId) finishChannelOperation(operationId);
      }
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
    ...listSessionFamilyDirs(resolveChannelSessionDir(folder)),
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
interface SavedUploads {
  files: string[];
  urls: string[];
  operationDirs: string[];
}

async function cleanupOperationUploads(saved: SavedUploads): Promise<void> {
  await Promise.all(
    saved.operationDirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})),
  );
}

async function saveUploads(
  jid: string,
  attachments: Array<{ name: string; dataBase64: string }>,
  operationId?: string,
): Promise<SavedUploads> {
  if (attachments.length === 0) return { files: [], urls: [], operationDirs: [] };

  // Life uploads stay in an operation-unique subdirectory. If a suspended
  // request loses its lease while writeFile is pending, its path can never be
  // mistaken for files from a newer request; archive moves the old root as one.
  const relativeOperationDir = operationId ? join('.operations', operationId) : '';
  const uploadDir = join(config.webUploadDir, mediaDirName(jid), relativeOperationDir);
  const mediaDir = join(config.webMediaDir, mediaDirName(jid), relativeOperationDir);
  const operationDirs = operationId ? [uploadDir, mediaDir] : [];

  try {
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
      const urlName = operationId ? `.operations/${operationId}/${safeName}` : safeName;
      urls.push(mediaUrl(jid, urlName));
    }

    return { files, urls, operationDirs };
  } catch (error) {
    await cleanupOperationUploads({ files: [], urls: [], operationDirs });
    throw error;
  }
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
  expectedLifeGeneration?: string,
): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // Without this an nginx/Tailscale hop may buffer the stream into silence.
    'x-accel-buffering': 'no',
  });

  const streamGeneration = expectedLifeGeneration ?? null;
  let cursor = afterRowid;
  let lastBusy: boolean | undefined;
  let lastLiveSeq = -1;
  let closed = false;

  const send = (event: string, data: unknown) => {
    if (closed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  send('hello', { cursor });
  if (streamGeneration) send('generation', { generation: streamGeneration });

  const timer = setInterval(() => {
    if (closed) return;
    try {
      if (streamGeneration) {
        const current = getChannel(jid);
        const currentGeneration = current?.kind === 'life' ? current.folder : null;
        if (currentGeneration !== streamGeneration) {
          send('generation', { generation: currentGeneration });
          cleanup();
          res.end();
          return;
        }
      }

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

      // The reply as it is being generated. Sent only when it changes, and
      // once more as null when it ends, so the client can drop the preview
      // exactly when the finished message row arrives.
      const live = getLiveOutput(jid);
      const liveSeq = live?.seq ?? 0;
      if (liveSeq !== lastLiveSeq) {
        lastLiveSeq = liveSeq;
        send('partial', live ? { content: live.content, thinking: live.thinking, seq: live.seq } : null);
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
