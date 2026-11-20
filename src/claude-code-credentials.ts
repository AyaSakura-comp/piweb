import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ClaudeCodeOAuthCredential {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes?: string[];
}

export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

/**
 * The host Claude Code CLI's OAuth credentials, parsed.
 *
 * Linux (and Windows) keep them in `<config dir>/.credentials.json`. macOS
 * keeps them in the login Keychain instead — a generic password whose service
 * is `Claude Code-credentials`, suffixed with the first 8 hex digits of the
 * config dir's SHA-256 when CLAUDE_CONFIG_DIR is set — and writes no file at
 * all, so reading only the file reports a signed-in Mac as signed out.
 *
 * The file wins when present; the Keychain is the macOS fallback. Rejects
 * when neither yields JSON. Never log what this returns.
 */
export async function readClaudeCodeCredentials(): Promise<unknown> {
  const configDir = claudeConfigDir();
  try {
    return JSON.parse(await readFile(join(configDir, '.credentials.json'), 'utf8'));
  } catch (fileError) {
    if (process.platform !== 'darwin') throw fileError;
  }
  const base = 'Claude Code-credentials';
  const services = process.env.CLAUDE_CONFIG_DIR
    ? [`${base}-${createHash('sha256').update(configDir).digest('hex').slice(0, 8)}`, base]
    : [base];
  let lastError: unknown;
  for (const service of services) {
    try {
      return JSON.parse(await keychainPassword(service));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/**
 * Update the host Claude Code CLI's `<config dir>/.credentials.json` with a
 * fresh OAuth token pair, preserving unrelated keys and subscription metadata
 * while clearing any stale `loginEnded` / `refreshTokenExpiresAt` markers.
 * Written atomically with 0600 permissions. Never log its contents.
 */
export async function writeClaudeCodeCredentials(
  oauth: ClaudeCodeOAuthCredential,
): Promise<void> {
  const configDir = claudeConfigDir();
  const credPath = join(configDir, '.credentials.json');
  let existing: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await readFile(credPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    }
  } catch {
    // Missing or unreadable file: start fresh.
  }

  const prevOauth =
    existing.claudeAiOauth &&
    typeof existing.claudeAiOauth === 'object' &&
    !Array.isArray(existing.claudeAiOauth)
      ? { ...(existing.claudeAiOauth as Record<string, unknown>) }
      : {};
  delete prevOauth.loginEnded;
  delete prevOauth.refreshTokenExpiresAt;

  const nextOauth: Record<string, unknown> = {
    ...prevOauth,
    accessToken: oauth.accessToken,
    refreshToken: oauth.refreshToken,
    expiresAt: oauth.expiresAt,
  };
  if (oauth.scopes && oauth.scopes.length > 0) {
    nextOauth.scopes = oauth.scopes;
  }

  const payload = JSON.stringify({ ...existing, claudeAiOauth: nextOauth });
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const tempPath = join(configDir, `.credentials.json.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
  try {
    await writeFile(tempPath, payload, { encoding: 'utf8', mode: 0o600 });
    await chmod(tempPath, 0o600);
    await rename(tempPath, credPath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

/**
 * Remove `claudeAiOauth` from `<config dir>/.credentials.json` while
 * preserving unrelated keys (such as `mcpOAuth`).
 */
export async function clearClaudeCodeCredentials(): Promise<void> {
  const configDir = claudeConfigDir();
  const credPath = join(configDir, '.credentials.json');
  let existing: Record<string, unknown>;
  try {
    const parsed = JSON.parse(await readFile(credPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    existing = { ...(parsed as Record<string, unknown>) };
  } catch (error: any) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (!('claudeAiOauth' in existing)) return;
  delete existing.claudeAiOauth;
  const payload = JSON.stringify(existing);
  const tempPath = join(configDir, `.credentials.json.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
  try {
    await writeFile(tempPath, payload, { encoding: 'utf8', mode: 0o600 });
    await chmod(tempPath, 0o600);
    await rename(tempPath, credPath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

function keychainPassword(service: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      '/usr/bin/security',
      ['find-generic-password', '-s', service, '-w'],
      { timeout: 5000, maxBuffer: 1024 * 1024 },
      (error, stdout) =>
        error ? reject(new Error(`keychain item ${service} unavailable`)) : resolve(stdout),
    );
  });
}
