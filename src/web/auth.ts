/**
 * Shared-token auth.
 *
 * This endpoint can make pi run arbitrary commands on the host, so it is not
 * safe to rely on "it's only on the tailnet". A single shared token is enough
 * for a personal deployment; it is exchanged for an HttpOnly cookie so the
 * token itself isn't sitting in localStorage where any injected script could
 * read it.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { getMeta, setMeta } from '../db.js';

/**
 * Cookie-signing secret, persisted in the database.
 *
 * It used to be `randomBytes(32)` at module load, which regenerated on every
 * process start — so every restart or redeploy silently invalidated all login
 * cookies and forced a re-login. Persisting it means a session survives
 * restarts, which is what makes "log in once and stay logged in" actually hold.
 *
 * Resolved lazily on first use, not at import: the module is imported before
 * initDb() runs, so touching the database at import time would crash.
 */
let signingKey: Buffer | undefined;

function getSigningKey(): Buffer {
  if (signingKey) return signingKey;
  const stored = getMeta('auth.signingKey');
  if (stored) {
    signingKey = Buffer.from(stored, 'base64');
  } else {
    signingKey = randomBytes(32);
    setMeta('auth.signingKey', signingKey.toString('base64'));
  }
  return signingKey;
}

export const COOKIE_NAME = 'piweb_session';

/** Constant-time compare so a wrong token can't be recovered by timing. */
export function tokenMatches(candidate: string): boolean {
  const expected = Buffer.from(config.webAuthToken, 'utf8');
  const given = Buffer.from(candidate ?? '', 'utf8');
  if (expected.length === 0 || expected.length !== given.length) return false;
  return timingSafeEqual(expected, given);
}

export function issueCookie(): string {
  const expiresAt = Date.now() + config.webSessionTtlSec * 1000;
  const payload = String(expiresAt);
  const sig = createHmac('sha256', getSigningKey()).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

export function cookieIsValid(value: string | undefined): boolean {
  if (!value) return false;
  const [payload, sig] = value.split('.');
  if (!payload || !sig) return false;

  const expected = createHmac('sha256', getSigningKey()).update(payload).digest('hex');
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;

  const expiresAt = Number(payload);
  return Number.isFinite(expiresAt) && Date.now() < expiresAt;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

// ── Tailscale identity ──────────────────────────────────────────────────────

/**
 * `tailscale serve` injects these for tailnet (non-Funnel) traffic. They are
 * plain HTTP headers, so they are only meaningful when the request cannot have
 * come from anywhere but the sidecar — hence the loopback requirement below.
 * Tagged devices have no user identity and send no login header.
 */
export const TS_LOGIN_HEADER = 'tailscale-user-login';
export const TS_NAME_HEADER = 'tailscale-user-name';
/**
 * Set by `tailscale serve` on requests that arrived over Funnel, i.e. from the
 * public internet with no tailnet identity behind them.
 */
export const TS_FUNNEL_HEADER = 'tailscale-funnel-request';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function isLoopbackConnection(remoteAddress: string | undefined): boolean {
  return !!remoteAddress && LOOPBACK.has(remoteAddress);
}

export interface TailscaleIdentity {
  login: string;
  name: string;
}

/**
 * Identity for a request, or undefined if it must not be trusted.
 *
 * Refusing anything non-loopback is the whole security property: a request that
 * reached the port directly (another container on the docker network, or the
 * port being published) could set these headers to anything it liked.
 */
export function isFunnelRequest(headers: NodeJS.Dict<string | string[]>): boolean {
  return Boolean(headers[TS_FUNNEL_HEADER]);
}

export function tailscaleIdentity(
  headers: NodeJS.Dict<string | string[]>,
  remoteAddress: string | undefined,
): TailscaleIdentity | undefined {
  if (!config.webTrustTailscaleIdentity) return undefined;
  if (!isLoopbackConnection(remoteAddress)) return undefined;

  // A Funnel request comes from the public internet and carries no tailnet
  // identity. serve overwrites the identity headers for tailnet traffic, but
  // relying on it to also strip them when there is nothing to overwrite would
  // stake host command execution on undocumented behaviour. Refuse outright:
  // public visitors must use the token.
  if (isFunnelRequest(headers)) return undefined;

  const login = String(headers[TS_LOGIN_HEADER] ?? '').trim();
  if (!login) return undefined;

  const allowed = config.webAllowedLogins
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowed.length > 0 && !allowed.includes(login)) return undefined;

  return { login, name: String(headers[TS_NAME_HEADER] ?? '').trim() || login };
}

// ── CSRF ────────────────────────────────────────────────────────────────────

/**
 * Whether a state-changing request may proceed.
 *
 * This matters MORE with identity headers than with a token: serve attaches the
 * device's identity to every request the browser makes, so a malicious page open
 * in any tab would otherwise be able to drive the agent. Browsers always send
 * Origin on POST/DELETE, so requiring it to match is a reliable check; we accept
 * Sec-Fetch-Site: same-origin as an equivalent signal for clients that send it.
 */
export function isSameOriginRequest(
  headers: NodeJS.Dict<string | string[]>,
  host: string | undefined,
): boolean {
  const fetchSite = String(headers['sec-fetch-site'] ?? '').trim();
  if (fetchSite === 'same-origin' || fetchSite === 'none') return true;
  if (fetchSite && fetchSite !== 'same-site') return false;

  const origin = String(headers.origin ?? '').trim();
  if (!origin) {
    // No Origin and no Sec-Fetch-Site: a non-browser client (curl, scripts).
    // Those cannot be driven by a hostile web page, so they are not a CSRF
    // vector; they still need a valid cookie or token to get anywhere.
    return true;
  }

  const expected = config.webPublicOrigin.trim();
  if (expected) return origin === expected;

  // Fall back to comparing against the Host the request was addressed to.
  try {
    return !!host && new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function buildSetCookie(value: string, secure: boolean): string {
  const attrs = [
    `${COOKIE_NAME}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${config.webSessionTtlSec}`,
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}
