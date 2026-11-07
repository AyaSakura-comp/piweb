import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

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
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
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
