/**
 * Opening the login details (🔑) at the one moment an agent needs them.
 *
 * The web tier stored them sealed (src/secrets.ts). When the worker hands a
 * turn to an agent it opens the session's details and:
 *
 * - writes them to two files in the user's runtime directory (tmpfs on Linux:
 *   $XDG_RUNTIME_DIR/piweb-secrets/<folder>.{json,env}, mode 0600) — memory,
 *   not disk — that exist only while the turn runs;
 * - tells the agent the environment-variable NAMES ($PIWEB_SECRET_GITHUB_PASS),
 *   never the values, so its prompt, its context and its session file only
 *   ever contain names;
 * - scrubs any value that still turns up in what the agent streams back
 *   before it reaches web_events.
 *
 * Pi reads the JSON file through pi-extensions/piweb-secrets.ts (environment
 * variables for bash, names filled in for other tools, values scrubbed from
 * tool results before Pi writes its JSONL). Claude Code and agy have no such
 * hook: their shell commands source the .env file.
 */
import type { KeyObject } from 'node:crypto';
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { channelsWithSecrets, getChannel, getChannelSecrets, setMeta } from '../db.js';
import { logger } from '../logger.js';
import {
  loadOrCreateSecretKey,
  openSecret,
  SECRET_PUBLIC_KEY_META,
  secretRedactor,
  secretVariables,
  type OpenedSecret,
  type SealedSecret,
} from '../secrets.js';
import type { Harness } from './harness-handoff.js';

let privateKey: KeyObject | undefined;

/** Load (or make) the worker's key and publish its public half for the web tier. */
export function initSecretKey(keyPath = config.secretKeyPath): void {
  try {
    const pair = loadOrCreateSecretKey(keyPath);
    privateKey = pair.privateKey;
    setMeta(SECRET_PUBLIC_KEY_META, pair.publicKeyRaw);
    // No turn runs yet: anything left is from a worker that did not finish.
    sweepSecretFiles({ all: true });
  } catch (err: any) {
    // Without a key the composer simply does not offer 🔑; turns still run.
    privateKey = undefined;
    logger.error({ err: err.message, keyPath }, 'Login detail key unavailable');
  }
}

/** Where opened details live while a session can use them (RAM on Linux). */
export function secretsRuntimeDir(): string {
  if (config.secretsRuntimeDir) return config.secretsRuntimeDir;
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (runtime) return join(runtime, 'piweb-secrets');
  let user = 'user';
  try {
    user = String(userInfo().uid >= 0 ? userInfo().uid : userInfo().username);
  } catch {
    // Keep the generic name.
  }
  return join(tmpdir(), `piweb-secrets-${user}`);
}

const fileStem = (folder: string): string => folder.replace(/[^A-Za-z0-9_.-]/g, '_');

/** The two files a session's agent reads its details from. */
export function secretFilesFor(folder: string): { json: string; env: string } {
  const dir = secretsRuntimeDir();
  const stem = fileStem(folder);
  return { json: join(dir, `${stem}.json`), env: join(dir, `${stem}.env`) };
}

/**
 * The Pi extension that serves a session's details to its tools. It is loaded
 * from this checkout's source (Pi compiles TypeScript extensions itself), the
 * same path from src/agent and from dist/agent.
 */
export const PI_SECRETS_EXTENSION = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../pi-extensions/piweb-secrets.ts',
);

/** What a Pi process for this session is started with: the extension and its file. */
export function piSecretSpawn(folder: string): { args: string[]; env: Record<string, string> } {
  return {
    args: ['--extension', PI_SECRETS_EXTENSION],
    env: { PIWEB_SECRETS_FILE: secretFilesFor(folder).json },
  };
}

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

function writePrivate(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

function removeFiles(folder: string): void {
  const files = secretFilesFor(folder);
  rmSync(files.json, { force: true });
  rmSync(files.env, { force: true });
}

function writeFiles(folder: string, secrets: OpenedSecret[]): void {
  if (secrets.length === 0) {
    removeFiles(folder);
    return;
  }
  mkdirSync(secretsRuntimeDir(), { recursive: true, mode: 0o700 });
  const files = secretFilesFor(folder);
  writePrivate(
    files.json,
    JSON.stringify({
      version: 1,
      secrets: secrets.map(({ name, base, username, password }) => ({ name, base, username, password })),
    }),
  );
  const lines = secretVariables(secrets).map(([name, value]) => `export ${name}=${shellQuote(value)}`);
  writePrivate(files.env, `# piweb login details. Never print this file.\n${lines.join('\n')}\n`);
}

/** Open every detail a session holds; ones that no longer open are reported. */
function openAll(channelJid: string): { opened: OpenedSecret[]; failed: SealedSecret[] } {
  const opened: OpenedSecret[] = [];
  const failed: SealedSecret[] = [];
  for (const sealed of getChannelSecrets(channelJid)) {
    if (!privateKey) {
      failed.push(sealed);
      continue;
    }
    try {
      opened.push(openSecret(privateKey, sealed));
    } catch (err: any) {
      // A replaced key file: the detail must be entered again.
      logger.warn({ channelJid, base: sealed.base, err: err.message }, 'Login detail did not open');
      failed.push(sealed);
    }
  }
  return { opened, failed };
}

/**
 * Remove runtime files no turn should be reading: at worker start all of them,
 * later (with the hourly trash sweep) those of sessions that no longer hold
 * details — cleared or purged while a turn ran.
 */
export function sweepSecretFiles({ all = false } = {}): void {
  try {
    const keep = new Set<string>();
    if (!all) {
      for (const jid of channelsWithSecrets()) {
        const channel = getChannel(jid);
        if (channel) keep.add(fileStem(channel.folder));
      }
    }
    let names: string[] = [];
    try {
      names = readdirSync(secretsRuntimeDir());
    } catch {
      return;
    }
    for (const name of names) {
      const stem = name.replace(/\.(json|env)(\.\d+\.tmp)?$/, '');
      if (!keep.has(stem)) rmSync(join(secretsRuntimeDir(), name), { force: true });
    }
  } catch (err: any) {
    logger.warn({ err: err.message }, 'Login detail file sweep failed');
  }
}

export interface SecretHandoff {
  /** Added to the agent's prompt: names and how to use them, never values. */
  prompt: string;
  /** Whether anything needs scrubbing (no details: skip the walk per event). */
  scrubs: boolean;
  /** Swaps any value for its `$NAME` (for what streams back to the phone). */
  redact: (text: string) => string;
  /** The turn is over: the opened values leave the runtime dir. */
  release: () => void;
}

const NONE: SecretHandoff = { prompt: '', scrubs: false, redact: (text) => text, release: () => {} };

function parseMessageSecrets(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.map((item) => (item && typeof item.base === 'string' ? item.base : '')).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function usageFor(harness: Harness, folder: string, example: string): string {
  if (harness === 'pi') {
    return (
      `In bash they are environment variables: put the name in double quotes ("$${example}"), never the value. ` +
      `In any other tool argument (a form field, a browser action, a file you write) write the name, ` +
      `for example $${example}, and it is filled in when the tool runs.`
    );
  }
  return (
    `They are shell variables in a file only this machine's user can read. In each shell command that ` +
    `needs them, load the file first: . ${shellQuote(secretFilesFor(folder).env)} && <command using "$${example}">. ` +
    `Other tools cannot read them, so use a shell command (curl, a script) when you need them.`
  );
}

/**
 * Prepare a turn's login details. `messageSecrets` is the queued message's
 * `secrets` column; `includeAll` also re-announces the session's earlier
 * details (after a switch to another agent, which never saw them).
 */
export function prepareSecretHandoff(
  channel: { jid: string; folder: string },
  messageSecrets: string | null | undefined,
  harness: Harness,
  includeAll = false,
): SecretHandoff {
  const announced = new Set(parseMessageSecrets(messageSecrets));
  if (announced.size === 0 && !includeAll && getChannelSecrets(channel.jid).length === 0) {
    removeFiles(channel.folder);
    return NONE;
  }
  const { opened, failed } = openAll(channel.jid);
  try {
    writeFiles(channel.folder, opened);
  } catch (err: any) {
    logger.error({ err: err.message, folder: channel.folder }, 'Login detail files not written');
  }
  const redact = secretRedactor(opened);
  const release = () => {
    try {
      removeFiles(channel.folder);
    } catch (err: any) {
      logger.warn({ err: err.message, folder: channel.folder }, 'Login detail files not removed');
    }
  };
  const scrubs = opened.length > 0;
  const listed = opened.filter((secret) => includeAll || announced.has(secret.base));
  const lost = failed.filter((secret) => includeAll || announced.has(secret.base));
  if (listed.length === 0 && lost.length === 0) return { prompt: '', scrubs, redact, release };

  const lines = listed.map((secret) => {
    const parts = [
      secret.username ? `account $${secret.base}_USER` : '',
      secret.password ? `password $${secret.base}_PASS` : '',
    ].filter(Boolean);
    return `- ${secret.name}: ${parts.join(', ')}`;
  });
  for (const { name } of lost) lines.push(`- ${name}: could not be opened; ask the user to enter it again with 🔑`);
  const first = listed[0];
  const example = first ? `${first.base}_${first.password ? 'PASS' : 'USER'}` : 'PIWEB_SECRET_NAME_PASS';
  const prompt =
    `\n\n[Login details from the user (🔑). The values are hidden from you and are never stored in plain text.]\n` +
    `${lines.join('\n')}\n` +
    `${usageFor(harness, channel.folder, example)} ` +
    `Never print, echo or write out the values (or the file holding them), and never ask the user to type them in chat.`;
  return { prompt, scrubs, redact, release };
}
