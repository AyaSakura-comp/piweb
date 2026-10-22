/**
 * Sign the host's Antigravity CLI (`agy`) in to Google from Piweb Settings.
 *
 * agy has no login subcommand: it starts Google's OAuth flow itself whenever
 * it finds no credentials, prints the link, and accepts the code that
 * https://antigravity.google/oauth-callback displays. This module runs that
 * same flow — agy's installed-app client, scopes and redirect — so the phone
 * gets the link and pastes the code back, and writes the result where agy
 * reads it (`~/.gemini/antigravity-cli/antigravity-oauth-token`, the same file
 * agy-usage.ts refreshes).
 *
 * The client secret is not kept here; it is read out of the agy binary, the
 * same way the token refresh finds it.
 */
import { createHash, randomBytes } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import type { AuthInteraction } from '@earendil-works/pi-ai';
import {
  agyTokenPath,
  type AgyAuth,
  findAgyOAuthClientCandidates,
  type OAuthClient,
  readAgyAuth,
  writeAgyAuth,
} from './agy-usage.js';

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const AGY_REDIRECT_URI = 'https://antigravity.google/oauth-callback';
// What `agy` 1.3 asks for when it signs in (its own printed login link).
export const AGY_LOGIN_CLIENT_ID =
  '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const AGY_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
  'https://www.googleapis.com/auth/aicode',
  'openid',
];
const EXCHANGE_TIMEOUT_MS = 15_000;

export class AgyLoginError extends Error {}

export interface AgyLoginDependencies {
  fetchImpl: typeof fetch;
  now: () => number;
  clientCandidates: () => Promise<OAuthClient[]>;
  writeAuth: (auth: AgyAuth) => Promise<void>;
}

const DEFAULT_DEPENDENCIES: AgyLoginDependencies = {
  fetchImpl: fetch,
  now: Date.now,
  clientCandidates: findAgyOAuthClientCandidates,
  writeAuth: writeAgyAuth,
};

const base64url = (bytes: Buffer) => bytes.toString('base64url');

export function createAgyAuthorization(clientId = loginClientId()) {
  const verifier = base64url(randomBytes(32));
  const state = base64url(randomBytes(16));
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    access_type: 'offline',
    client_id: clientId,
    code_challenge: base64url(createHash('sha256').update(verifier).digest()),
    code_challenge_method: 'S256',
    prompt: 'consent',
    redirect_uri: AGY_REDIRECT_URI,
    response_type: 'code',
    scope: AGY_SCOPES.join(' '),
    state,
  }).toString();
  return { url: url.toString(), verifier, state };
}

function loginClientId(): string {
  return process.env.AGY_OAUTH_CLIENT_ID || AGY_LOGIN_CLIENT_ID;
}

/**
 * The callback page shows the bare code (`4/0A…`); a pasted callback address
 * or query string works too. A state that is present must be ours.
 */
export function parseAgyAuthorizationCode(input: string, expectedState: string): string {
  const value = input.trim();
  let params: URLSearchParams | undefined;
  if (/^https?:\/\//i.test(value)) {
    try {
      params = new URL(value).searchParams;
    } catch {
      throw new AgyLoginError('Not a valid sign-in address');
    }
  } else if (/(^|&)code=/.test(value)) {
    params = new URLSearchParams(value.replace(/^\?/, ''));
  }
  const code = params ? params.get('code') : value;
  if (!code) throw new AgyLoginError('No authorization code found');
  const state = params?.get('state');
  if (state && state !== expectedState) throw new AgyLoginError('Sign-in link does not match');
  return code;
}

/** Trade the pasted code for agy's tokens and save them where agy reads them. */
export async function exchangeAgyCode(
  code: string,
  verifier: string,
  signal?: AbortSignal,
  overrides: Partial<AgyLoginDependencies> = {},
): Promise<AgyAuth> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const clientId = loginClientId();
  const envSecret = process.env.AGY_OAUTH_CLIENT_SECRET;
  const secrets = envSecret
    ? [envSecret]
    : (await dependencies.clientCandidates())
        .filter(([id]) => id === clientId)
        .map(([, secret]) => secret);
  if (!secrets.length) throw new AgyLoginError('agy OAuth client not found in the agy binary');

  const timeout = AbortSignal.timeout(EXCHANGE_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  for (const secret of secrets) {
    const response = await dependencies.fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: secret,
        code,
        code_verifier: verifier,
        grant_type: 'authorization_code',
        redirect_uri: AGY_REDIRECT_URI,
      }),
      signal: requestSignal,
    });
    const result: any = await response.json().catch(() => ({}));
    // Google checks the client before it looks at the code, so a secret from
    // another bundled client fails here without spending the code.
    if (response.status === 401 && result?.error === 'invalid_client') continue;
    if (!response.ok)
      throw new AgyLoginError(`Google rejected the code (${result?.error ?? response.status})`);
    if (typeof result?.access_token !== 'string' || typeof result?.refresh_token !== 'string') {
      throw new AgyLoginError('Google returned no agy tokens');
    }
    const expiresIn = Number(result.expires_in ?? 3600);
    const auth: AgyAuth = {
      token: {
        access_token: result.access_token,
        token_type: result.token_type ?? 'Bearer',
        refresh_token: result.refresh_token,
        expiry: new Date(dependencies.now() + expiresIn * 1000).toISOString(),
        expires_in: expiresIn,
      },
      auth_method: 'consumer',
      ...(typeof result.id_token === 'string' ? { id_token: result.id_token } : {}),
    };
    await dependencies.writeAuth(auth);
    return auth;
  }
  throw new AgyLoginError('agy OAuth client secret not accepted');
}

/** The subscription-runtime face of agy, alongside pi's own providers. */
export const agySubscriptionRuntime = {
  async login(_provider: string, _type: 'oauth', interaction: AuthInteraction): Promise<AgyAuth> {
    const authorization = createAgyAuthorization();
    interaction.notify({ type: 'auth_url', url: authorization.url });
    const pasted = await interaction.prompt({
      type: 'manual_code',
      message: 'Paste the code Google shows',
    });
    const code = parseAgyAuthorizationCode(pasted, authorization.state);
    interaction.notify({ type: 'progress', message: 'Exchanging authorization code' });
    return exchangeAgyCode(code, authorization.verifier, interaction.signal);
  },
  async logout(): Promise<void> {
    await unlink(agyTokenPath()).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  },
  async checkAuth(): Promise<boolean> {
    try {
      return Boolean((await readAgyAuth()).token.refresh_token);
    } catch {
      return false;
    }
  },
};
