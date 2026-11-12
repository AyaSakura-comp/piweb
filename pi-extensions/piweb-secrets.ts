/**
 * piweb login details (🔑) inside a Pi session.
 *
 * piweb starts every Pi turn process with `--extension <this file>` and
 * PIWEB_SECRETS_FILE pointing at the session's opened details (a 0600 file in
 * the user's runtime dir that exists only while a piweb turn runs; see
 * src/agent/secret-handoff.ts). What was read last is kept in this process's
 * memory, so a turn Pi starts on its own (a subagent finishing) still works. The model is told only variable names such as
 * $PIWEB_SECRET_GITHUB_PASS. This extension makes those names work while
 * keeping the values out of everything Pi records:
 *
 * - bash: the values are environment variables of this process, which every
 *   bash tool call inherits, so "$PIWEB_SECRET_GITHUB_PASS" expands in the
 *   shell. The command Pi stores still says only the name.
 * - write / edit: names in their arguments are filled in just before the tool
 *   runs (the agent writing a config file means the value). Pi hands
 *   `tool_call` a copy of the arguments, so the assistant message in the
 *   session JSONL keeps the names.
 * - every other tool keeps the names: its arguments may go on to another model
 *   (browser_intent's planner, a subagent's task, a search query). A tool that
 *   must type a value does it itself, from this process's environment, at the
 *   last moment: browser_intent (pi-nodriver-browser) types $PIWEB_SECRET_*
 *   as the value only in the command sent to Chrome, and hides values in the
 *   pages it reads back.
 * - tool results: any value that comes back (a page that echoes the account,
 *   `cat` of a config file) is swapped for its name before Pi stores the
 *   result or shows it to the model.
 *
 * Never a file, no details: the extension does nothing.
 */
import { readFileSync } from 'node:fs';

interface Detail {
  base?: unknown;
  username?: unknown;
  password?: unknown;
}

/** Values shorter than this are not scrubbed (a 3-letter account is too common a word). */
const MIN_REDACT_CHARS = 4;
const PREFIX = 'PIWEB_SECRET_';
/** Tools whose arguments get the values: they act on them directly, no model reads them. */
const FILLED_TOOLS = new Set(['write', 'edit']);

let lastRead: Array<[string, string]> = [];

/** The file's details; between piweb turns (no file) the last ones read. */
function variables(): Array<[string, string]> {
  const file = process.env.PIWEB_SECRETS_FILE;
  if (!file) return [];
  let secrets: Detail[] = [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    secrets = Array.isArray(parsed?.secrets) ? parsed.secrets : [];
  } catch {
    return lastRead;
  }
  const out: Array<[string, string]> = [];
  for (const secret of secrets) {
    if (typeof secret.base !== 'string' || !secret.base.startsWith(PREFIX)) continue;
    if (typeof secret.username === 'string' && secret.username) out.push([`${secret.base}_USER`, secret.username]);
    if (typeof secret.password === 'string' && secret.password) out.push([`${secret.base}_PASS`, secret.password]);
  }
  lastRead = out;
  return out;
}

/** Keep this process's environment equal to the file: new values set, removed ones gone. */
function syncEnvironment(pairs: Array<[string, string]>): void {
  const names = new Set(pairs.map(([name]) => name));
  for (const key of Object.keys(process.env)) {
    if (key.startsWith(PREFIX) && !names.has(key)) delete process.env[key];
  }
  for (const [name, value] of pairs) process.env[name] = value;
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `$NAME` / `${NAME}` → value, in place, through every string of the arguments. */
function fillIn(target: unknown, pairs: Array<[string, string]>): void {
  const values = new Map(pairs);
  const names = pairs.map(([name]) => escape(name)).join('|');
  const pattern = new RegExp(`\\$\\{(${names})\\}|\\$(${names})(?![A-Za-z0-9_])`, 'g');
  const fill = (text: string): string =>
    text.replace(pattern, (whole, braced: string | undefined, bare: string | undefined) => values.get(braced ?? bare ?? '') ?? whole);
  const walk = (node: unknown, depth: number): void => {
    if (depth > 32 || !node || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const value = record[key];
      if (typeof value === 'string') {
        const next = fill(value);
        if (next !== value) record[key] = next;
      } else walk(value, depth + 1);
    }
  };
  walk(target, 0);
}

function redactor(pairs: Array<[string, string]>): ((text: string) => string) | undefined {
  const scrub = pairs
    .filter(([, value]) => value.length >= MIN_REDACT_CHARS)
    .sort((a, b) => b[1].length - a[1].length);
  if (scrub.length === 0) return undefined;
  return (text) => {
    let out = text;
    for (const [name, value] of scrub) if (out.includes(value)) out = out.split(value).join(`$${name}`);
    return out;
  };
}

/** A redacted copy of a JSON-like value, or the value itself when nothing matched. */
function redactDeep<T>(value: T, redact: (text: string) => string, depth = 0): T {
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

// Pi's ExtensionAPI, narrowed to what this file uses (no import from Pi, so
// the file loads with whichever Pi build PI_BIN points at).
interface Api {
  on(event: 'tool_call', handler: (event: { toolName: string; input: Record<string, unknown> }) => unknown): void;
  on(
    event: 'tool_result',
    handler: (event: { content: unknown; details: unknown }) => unknown,
  ): void;
}

export default function piwebSecrets(pi: Api): void {
  if (!process.env.PIWEB_SECRETS_FILE) return;

  pi.on('tool_call', (event) => {
    const pairs = variables();
    // Every tool call: bash expands the names from here, browser_intent types from here.
    syncEnvironment(pairs);
    // A shell expands the names itself, with its own quoting rules (pasting a
    // value into the command text could break or inject into it); any tool
    // not listed may hand its arguments to another model.
    if (pairs.length === 0 || !FILLED_TOOLS.has(event.toolName)) return undefined;
    fillIn(event.input, pairs);
    return undefined;
  });

  pi.on('tool_result', (event) => {
    const redact = redactor(variables());
    if (!redact) return undefined;
    const content = redactDeep(event.content, redact);
    const details = redactDeep(event.details, redact);
    if (content === event.content && details === event.details) return undefined;
    return { content, details };
  });
}
