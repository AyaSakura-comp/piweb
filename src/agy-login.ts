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
import {
  agyTokenPath,
  type AgyAuth,
  findAgyOAuthClientCandidates,
  type OAuthClient,
  readAgyAuth,
  writeAgyAuth,
} from './agy-usage.js';
import { logger } from './logger.js';
import {
  cleanPastedCode,
  type CodeLoginInteraction,
  isAbort,
  oauthErrorCode,
  PublicLoginError,
  tokenEndpointError,
  unreachableError,
  withPastedCode,
} from './subscription-login.js';

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
const WHO = 'Google';

/** An agy sign-in failure; its message is safe to show in Settings. */
export class AgyLoginError extends PublicLoginError {}
const retry = (message: string) => new AgyLoginError(message, true);

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
  const value = cleanPastedCode(input);
  if (!value) throw retry('Paste the code Google shows.');
  let params: URLSearchParams | undefined;
  if (/^https?:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw retry('That address is incomplete. Copy the code Antigravity shows and paste it again.');
    }
    if (url.hostname === 'accounts.google.com') {
      throw retry('That is the sign-in link itself. Open it, approve, then paste the code Antigravity shows.');
    }
    params = url.searchParams;
  } else if (/(^|[?&])code=/.test(value)) {
    params = new URLSearchParams(value.replace(/^\?/, ''));
  }
  const declined = params?.get('error');
  if (declined) {
    throw retry(
      declined === 'access_denied'
        ? 'Sign-in was declined on Google. Open Google again and approve to continue.'
        : 'Google did not finish the sign-in. Open Google again and approve to continue.',
    );
  }
  const code = params ? params.get('code') : value;
  if (!code) throw retry('No code found in what was pasted. Copy the code Antigravity shows and paste it.');
  const state = params?.get('state');
  if (state && state !== expectedState) {
    throw retry('That code is from an older sign-in link. Use Open Google on this card, then paste the code it shows.');
  }
  return code;
}

/** The secrets agy's binary carries for its login client; none means no sign-in. */
async function loginSecrets(dependencies: AgyLoginDependencies, clientId: string): Promise<string[]> {
  const envSecret = process.env.AGY_OAUTH_CLIENT_SECRET;
  if (envSecret) return [envSecret];
  let candidates: OAuthClient[];
  try {
    candidates = await dependencies.clientCandidates();
  } catch (error: unknown) {
    // agy-usage explains which: binary missing from PATH, unreadable, no metadata.
    throw new AgyLoginError(
      `Antigravity sign-in needs the agy CLI on the host: ${(error as Error)?.message ?? 'agy not found'}`,
    );
  }
  const secrets = candidates.filter(([id]) => id === clientId).map(([, secret]) => secret);
  if (!secrets.length) {
    throw new AgyLoginError(
      "This agy version's sign-in client was not found in its binary. Update Piweb's agy client (AGY_OAUTH_CLIENT_ID / AGY_OAUTH_CLIENT_SECRET).",
    );
  }
  return secrets;
}

/** Trade the pasted code for agy's tokens and save them where agy reads them. */
export async function exchangeAgyCode(
  code: string,
  verifier: string,
  signal?: AbortSignal,
  overrides: Partial<AgyLoginDependencies> = {},
  secrets?: string[],
): Promise<AgyAuth> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const clientId = loginClientId();
  const candidates = secrets ?? (await loginSecrets(dependencies, clientId));

  for (const secret of candidates) {
    const timeout = AbortSignal.timeout(EXCHANGE_TIMEOUT_MS);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await dependencies.fetchImpl(TOKEN_URL, {
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
    } catch (error: unknown) {
      if (signal?.aborted) throw error;
      throw unreachableError(WHO, timeout.aborted || isAbort(error));
    }
    const result: any = await response.json().catch(() => undefined);
    // Google checks the client before it looks at the code, so a secret from
    // another bundled client fails here without spending the code.
    if (response.status === 401 && oauthErrorCode(result) === 'invalid_client') continue;
    if (!response.ok) throw tokenEndpointError(WHO, response.status, result);
    if (
      typeof result?.access_token !== 'string' ||
      typeof result?.refresh_token !== 'string' ||
      !result.access_token ||
      !result.refresh_token
    ) {
      // Without a refresh token agy would be signed out within the hour.
      throw retry('Google answered without a lasting token. Open Google again and paste the new code.');
    }
    const parsedExpiry = Number(result.expires_in);
    const expiresIn = Number.isFinite(parsedExpiry) && parsedExpiry > 0 ? parsedExpiry : 3600;
    const auth: AgyAuth = {
      token: {
        access_token: result.access_token,
        token_type: typeof result.token_type === 'string' ? result.token_type : 'Bearer',
        refresh_token: result.refresh_token,
        expiry: new Date(dependencies.now() + expiresIn * 1000).toISOString(),
        expires_in: expiresIn,
      },
      auth_method: 'consumer',
      ...(typeof result.id_token === 'string' ? { id_token: result.id_token } : {}),
    };
    try {
      await dependencies.writeAuth(auth);
    } catch (error: unknown) {
      logger.warn({ err: (error as NodeJS.ErrnoException)?.code ?? 'Error' }, 'Could not store the agy credential');
      throw new AgyLoginError(
        "Signed in, but the host couldn't save agy's credential file. Check its disk and permissions, then connect again.",
      );
    }
    return auth;
  }
  throw new AgyLoginError(
    'Google no longer accepts the sign-in client found in the agy binary. Update agy on the host, then connect again.',
  );
}

export function createAgySubscriptionRuntime(overrides: Partial<AgyLoginDependencies> = {}) {
  return {
    async login(_provider: string, _type: 'oauth', interaction: CodeLoginInteraction): Promise<AgyAuth> {
      // Fail before the link is shown when agy itself is missing: approving on
      // Google would otherwise lead to a code nothing can redeem.
      const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
      const secrets = await loginSecrets(dependencies, loginClientId());
      const authorization = createAgyAuthorization();
      interaction.notify({ type: 'auth_url', url: authorization.url });
      return withPastedCode(interaction, 'Paste the code Google shows', async (pasted) => {
        const code = parseAgyAuthorizationCode(pasted, authorization.state);
        interaction.notify({ type: 'progress', message: 'Exchanging authorization code' });
        return exchangeAgyCode(code, authorization.verifier, interaction.signal, overrides, secrets);
      });
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
}

/** The subscription-runtime face of agy, alongside pi's own providers. */
export const agySubscriptionRuntime = createAgySubscriptionRuntime();
