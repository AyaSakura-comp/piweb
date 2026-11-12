/**
 * Login details sent from the composer (🔑), sealed so that nothing piweb keeps
 * holds them in plain text: not SQLite (message_queue / web_events /
 * channel_secrets), not the transcript the phone pages through, and not Pi's
 * session JSONL. The user asked for this on 2026-11-12: "放在 disk 的時候至少是
 * 被加密過的，丟到 agent 的時候才解開，至少不要 read session data 的時候就有帳號
 * 密碼 leak".
 *
 * Sealing is X25519 + HKDF-SHA256 + AES-256-GCM to one host key pair:
 *
 * - The host worker owns the private key (config.secretKeyPath, mode 0600,
 *   beside config.env — outside the data directory the web container mounts)
 *   and publishes the public half in `meta` at startup.
 * - The web tier seals each detail with that public key the moment it arrives,
 *   so even the process that received it cannot open what it stored.
 * - The worker opens them only when it hands a turn to an agent, and gives the
 *   agent environment-variable NAMES, never the values (see
 *   src/agent/secret-handoff.ts and pi-extensions/piweb-secrets.ts).
 *
 * What it does not protect against: a program running as this host user (the
 * agents included) can read the key file, as it can read anything else of the
 * user's. The point is that reading the session data — the files, the database,
 * the transcript, the model's own context — never shows the details.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** `meta` key holding the worker's public key (raw X25519, base64url). */
export const SECRET_PUBLIC_KEY_META = 'secrets.public_key';

const VERSION = 'pws1';
const INFO = Buffer.from('piweb-secret-v1');

export const MAX_SECRETS_PER_MESSAGE = 8;
const MAX_NAME_CHARS = 40;
const MAX_VALUE_CHARS = 1024;

export class SecretInputError extends Error {}

/** One login detail as the composer sends it. */
export interface SecretInput {
  /** What the user called it ("GitHub", "公司信箱"). */
  name: string;
  username: string;
  password: string;
}

/** A detail's sealed form, as stored in channel_secrets. */
export interface SealedSecret {
  name: string;
  /** Environment-variable stem: `<base>_USER` and `<base>_PASS`. */
  base: string;
  blob: string;
}

/** An opened detail, only ever held in the worker's memory. */
export interface OpenedSecret {
  name: string;
  base: string;
  username: string;
  password: string;
}

/**
 * The environment-variable stem for a name. ASCII names read as themselves
 * (GitHub → PIWEB_SECRET_GITHUB); a name with no ASCII letters or digits gets a
 * short hash, the same one every time, so re-entering 公司信箱 replaces it.
 */
export function secretVarBase(name: string): string {
  const slug = name
    .normalize('NFKD')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32)
    .replace(/_+$/, '');
  if (slug) return `PIWEB_SECRET_${/^[0-9]/.test(slug) ? `N${slug}` : slug}`;
  const hash = createHash('sha256').update(name).digest('hex').slice(0, 6).toUpperCase();
  return `PIWEB_SECRET_LOGIN_${hash}`;
}

/** Check and tidy what the composer sent; throws SecretInputError. */
export function normalizeSecretInputs(raw: unknown): SecretInput[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new SecretInputError('登入資料格式不對');
  if (raw.length > MAX_SECRETS_PER_MESSAGE)
    throw new SecretInputError(`一則訊息最多 ${MAX_SECRETS_PER_MESSAGE} 組登入資料`);
  const out: SecretInput[] = [];
  const bases = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') throw new SecretInputError('登入資料格式不對');
    const { name, username, password } = item as Record<string, unknown>;
    if (
      (name !== undefined && typeof name !== 'string') ||
      (username !== undefined && typeof username !== 'string') ||
      (password !== undefined && typeof password !== 'string')
    )
      throw new SecretInputError('登入資料格式不對');
    const cleanName = (name ?? '').trim().replace(/\s+/g, ' ');
    if (!cleanName) throw new SecretInputError('登入資料需要名稱');
    if ([...cleanName].length > MAX_NAME_CHARS)
      throw new SecretInputError(`登入資料名稱最多 ${MAX_NAME_CHARS} 字`);
    const user = username ?? '';
    const pass = password ?? '';
    if (!user && !pass) throw new SecretInputError(`「${cleanName}」沒有帳號也沒有密碼`);
    if (user.length > MAX_VALUE_CHARS || pass.length > MAX_VALUE_CHARS)
      throw new SecretInputError(`「${cleanName}」太長`);
    const base = secretVarBase(cleanName);
    if (bases.has(base)) throw new SecretInputError(`「${cleanName}」重複了`);
    bases.add(base);
    out.push({ name: cleanName, username: user, password: pass });
  }
  return out;
}

const b64url = (buffer: Buffer): string => buffer.toString('base64url');

function publicKeyFromRaw(raw: string): KeyObject {
  return createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: raw }, format: 'jwk' });
}

function rawPublicKey(key: KeyObject): string {
  const x = key.export({ format: 'jwk' }).x;
  if (typeof x !== 'string') throw new Error('Not an X25519 key');
  return x;
}

function sealKey(shared: Buffer, ephemeral: string, recipient: string): Buffer {
  const salt = Buffer.concat([Buffer.from(ephemeral, 'base64url'), Buffer.from(recipient, 'base64url')]);
  return Buffer.from(hkdfSync('sha256', shared, salt, INFO, 32));
}

const aadFor = (base: string): Buffer => Buffer.from(`${VERSION}\0${base}`);

/** Seal one detail to the worker's public key (raw X25519, base64url). */
export function sealSecret(publicKeyRaw: string, input: SecretInput): SealedSecret {
  const recipient = publicKeyFromRaw(publicKeyRaw);
  const ephemeral = generateKeyPairSync('x25519');
  const ephemeralRaw = rawPublicKey(ephemeral.publicKey);
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient });
  const key = sealKey(shared, ephemeralRaw, publicKeyRaw);
  const iv = randomBytes(12);
  const base = secretVarBase(input.name);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aadFor(base));
  const body = Buffer.concat([
    cipher.update(JSON.stringify({ u: input.username, p: input.password }), 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return { name: input.name, base, blob: [VERSION, ephemeralRaw, b64url(iv), b64url(body)].join('.') };
}

/** Open a sealed detail with the worker's private key. Throws if it was altered. */
export function openSecret(privateKey: KeyObject, sealed: SealedSecret): OpenedSecret {
  const [version, ephemeralRaw, ivText, bodyText] = sealed.blob.split('.');
  if (version !== VERSION || !ephemeralRaw || !ivText || !bodyText)
    throw new Error('Unknown sealed secret format');
  const recipientRaw = rawPublicKey(createPublicKey(privateKey));
  const shared = diffieHellman({ privateKey, publicKey: publicKeyFromRaw(ephemeralRaw) });
  const key = sealKey(shared, ephemeralRaw, recipientRaw);
  const body = Buffer.from(bodyText, 'base64url');
  if (body.length < 16) throw new Error('Sealed secret is truncated');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivText, 'base64url'));
  decipher.setAAD(aadFor(sealed.base));
  decipher.setAuthTag(body.subarray(body.length - 16));
  const plain = Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]);
  const parsed = JSON.parse(plain.toString('utf8')) as { u?: unknown; p?: unknown };
  return {
    name: sealed.name,
    base: sealed.base,
    username: typeof parsed.u === 'string' ? parsed.u : '',
    password: typeof parsed.p === 'string' ? parsed.p : '',
  };
}

/**
 * The worker's key pair: read from `path`, or made there (0600, directory 0700)
 * on first use. A key file other users could read is tightened, not trusted
 * as-is.
 */
export function loadOrCreateSecretKey(path: string): { privateKey: KeyObject; publicKeyRaw: string } {
  if (existsSync(path)) {
    try {
      chmodSync(path, 0o600);
    } catch {
      // Read-only mounts: still usable, just not ours to fix.
    }
    const privateKey = createPrivateKey(readFileSync(path, 'utf8'));
    if (privateKey.asymmetricKeyType !== 'x25519')
      throw new Error(`${path} is not an X25519 private key`);
    return { privateKey, publicKeyRaw: rawPublicKey(createPublicKey(privateKey)) };
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const pair = generateKeyPairSync('x25519');
  const pem = pair.privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, pem, { mode: 0o600, flag: 'wx' });
  renameSync(tmp, path);
  return { privateKey: pair.privateKey, publicKeyRaw: rawPublicKey(pair.publicKey) };
}

/** Variable name → value for each opened detail (empty values left out). */
export function secretVariables(secrets: OpenedSecret[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const secret of secrets) {
    if (secret.username) out.push([`${secret.base}_USER`, secret.username]);
    if (secret.password) out.push([`${secret.base}_PASS`, secret.password]);
  }
  return out;
}

/**
 * Values shorter than this are not scrubbed from output: a 3-letter username
 * would otherwise turn every "bob" in a log into a variable name.
 */
export const MIN_REDACT_CHARS = 4;

/** A function that swaps each value for `$NAME` in any string. */
export function secretRedactor(secrets: OpenedSecret[]): (text: string) => string {
  const pairs = secretVariables(secrets)
    .filter(([, value]) => value.length >= MIN_REDACT_CHARS)
    .sort((a, b) => b[1].length - a[1].length);
  if (pairs.length === 0) return (text) => text;
  return (text) => {
    let out = text;
    for (const [name, value] of pairs) {
      if (out.includes(value)) out = out.split(value).join(`$${name}`);
    }
    return out;
  };
}

/**
 * Apply a string redactor through a JSON-like value. Returns the same object
 * when nothing changed, a changed copy otherwise (the input is never mutated).
 */
export function redactDeep<T>(value: T, redact: (text: string) => string, depth = 0): T {
  if (typeof value === 'string') return redact(value) as T;
  if (depth > 32 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const out = redactDeep(item, redact, depth + 1);
      if (out !== item) changed = true;
      return out;
    });
    return (changed ? next : value) as T;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const out = redactDeep(item, redact, depth + 1);
    if (out !== item) changed = true;
    next[key] = out;
  }
  return (changed ? next : value) as T;
}
