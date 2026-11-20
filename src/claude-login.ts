/**
 * Sign pi's `anthropic` provider in to a Claude Pro/Max subscription from
 * Piweb Settings.
 *
 * pi's own Anthropic login redirects to `http://localhost:53692/callback`,
 * which only loads on the host itself: on a phone the browser lands on a dead
 * page and the code has to be dug out of the address bar. This runs the flow
 * Claude Code uses for a sign-in on another device instead — the same public
 * client, redirected to Anthropic's own code page
 * (https://platform.claude.com/oauth/code/callback), which shows a code to
 * copy — and stores the tokens in pi's auth.json exactly as pi's login would.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Credential } from '@earendil-works/pi-ai';
import {
  cleanPastedCode,
  type CodeLoginInteraction,
  isAbort,
  PublicLoginError,
  tokenEndpointError,
  unreachableError,
  withPastedCode,
} from './subscription-login.js';
import {
  type ClaudeCodeOAuthCredential,
  clearClaudeCodeCredentials,
  readClaudeCodeCredentials,
  writeClaudeCodeCredentials,
} from './claude-code-credentials.js';
import { logger } from './logger.js';

export const CLAUDE_PROVIDER = 'anthropic';
const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
export const CLAUDE_REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback';
// Claude Code's public OAuth client, the one pi's Anthropic provider uses too.
export const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
// pi's Anthropic scopes, so the credential is the one pi's own login stores.
const CLAUDE_SCOPES = [
  'org:create_api_key',
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
];
const EXCHANGE_TIMEOUT_MS = 30_000;
// pi treats a token as expired five minutes early; store it the same way.
const EXPIRY_MARGIN_MS = 5 * 60_000;
const WHO = 'Claude';

/** What the Settings card needs from pi's runtime around a Piweb-run login. */
export interface PiCredentialRuntime {
  refresh(options: { providers: string[]; allowNetwork: boolean }): Promise<unknown>;
  logout(providerId: string, options?: { signal?: AbortSignal }): Promise<void>;
  checkAuth(providerId: string, options?: { signal?: AbortSignal }): Promise<unknown>;
}

export interface ClaudeLoginDependencies {
  fetchImpl: typeof fetch;
  now: () => number;
  /** Store the freshly exchanged OAuth tokens for the host Claude Code CLI. */
  saveClaudeCodeCredential: (oauth: ClaudeCodeOAuthCredential) => Promise<void>;
  /** Remove OAuth tokens from the host Claude Code CLI on Disconnect. */
  clearClaudeCodeCredential: () => Promise<void>;
  /** The host Claude Code CLI's credentials file, parsed. */
  readClaudeCodeAuth: () => Promise<unknown>;
}

const DEFAULT_DEPENDENCIES: ClaudeLoginDependencies = {
  fetchImpl: fetch,
  now: Date.now,
  saveClaudeCodeCredential: writeClaudeCodeCredentials,
  clearClaudeCodeCredential: clearClaudeCodeCredentials,
  readClaudeCodeAuth: readClaudeCodeCredentials,
};

/**
 * Whether the host's Claude Code CLI is signed in to a subscription. Piweb's
 * `claude-code/*` sessions run that CLI, so this sign-in is a working Claude
 * connection even when pi's own `anthropic` credential is absent. Only the
 * presence of a refresh token (without a `loginEnded` marker) is checked;
 * nothing is copied out of the file.
 */
export async function claudeCodeSignedIn(
  readAuth: ClaudeLoginDependencies['readClaudeCodeAuth'] = DEFAULT_DEPENDENCIES.readClaudeCodeAuth,
): Promise<boolean> {
  try {
    const oauth = (
      (await readAuth()) as {
        claudeAiOauth?: { refreshToken?: unknown; loginEnded?: unknown };
      } | null
    )?.claudeAiOauth;
    if (oauth?.loginEnded) return false;
    return typeof oauth?.refreshToken === 'string' && oauth.refreshToken.length > 0;
  } catch {
    return false;
  }
}

const isOauth = (check: unknown) =>
  Boolean(check && typeof check === 'object' && (check as { type?: unknown }).type === 'oauth');

const base64url = (bytes: Buffer) => bytes.toString('base64url');

export function createClaudeAuthorization() {
  const verifier = base64url(randomBytes(32));
  const state = base64url(randomBytes(32));
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    code: 'true',
    client_id: CLAUDE_CLIENT_ID,
    response_type: 'code',
    redirect_uri: CLAUDE_REDIRECT_URI,
    scope: CLAUDE_SCOPES.join(' '),
    code_challenge: base64url(createHash('sha256').update(verifier).digest()),
    code_challenge_method: 'S256',
    state,
  }).toString();
  return { url: url.toString(), verifier, state };
}

const retry = (message: string) => new PublicLoginError(message, true);

/**
 * Anthropic's code page shows `code#state`. A pasted callback address (this
 * flow's, or the localhost one from an older pi link) or a bare code works
 * too. A state that is present must be this sign-in's.
 */
export function parseClaudeAuthorizationCode(
  input: string,
  expectedState: string,
): { code: string; state: string } {
  const value = cleanPastedCode(input);
  if (!value) throw retry('Paste the code Claude shows.');
  let code: string | null | undefined;
  let state: string | null | undefined;
  if (/^https?:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw retry(
        'That address is incomplete. Copy the whole code Claude shows and paste it again.',
      );
    }
    if (url.pathname.endsWith('/oauth/authorize')) {
      throw retry(
        'That is the sign-in link itself. Open it, approve, then paste the code Claude shows.',
      );
    }
    const declined = url.searchParams.get('error');
    if (declined) {
      throw retry(
        declined === 'access_denied'
          ? 'Sign-in was declined on Claude. Open Claude again and approve to continue.'
          : 'Claude did not finish the sign-in. Open Claude again and approve to continue.',
      );
    }
    code = url.searchParams.get('code');
    state = url.searchParams.get('state') ?? url.hash.replace(/^#/, '') ?? undefined;
  } else if (/(^|[?&])code=/.test(value)) {
    const params = new URLSearchParams(value.replace(/^\?/, ''));
    code = params.get('code');
    state = params.get('state');
  } else {
    [code, state] = value.split('#', 2);
  }
  if (!code)
    throw retry('No code found in what was pasted. Copy the code Claude shows and paste it.');
  if (state && state !== expectedState) {
    throw retry(
      'That code is from an older sign-in link. Use Open Claude on this card, then paste the code it shows.',
    );
  }
  return { code, state: expectedState };
}

/** Trade the pasted code for tokens and store them as pi's `anthropic` credential. */
export async function exchangeClaudeCode(
  code: string,
  state: string,
  verifier: string,
  signal?: AbortSignal,
  overrides: Partial<ClaudeLoginDependencies> = {},
): Promise<Credential> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const timeout = AbortSignal.timeout(EXCHANGE_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await dependencies.fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: CLAUDE_CLIENT_ID,
        code,
        state,
        redirect_uri: CLAUDE_REDIRECT_URI,
        code_verifier: verifier,
      }),
      signal: requestSignal,
    });
  } catch (error: unknown) {
    if (signal?.aborted) throw error;
    throw unreachableError(WHO, timeout.aborted || isAbort(error));
  }
  const result: any = await response.json().catch(() => undefined);
  if (!response.ok) throw tokenEndpointError(WHO, response.status, result);

  const expiresIn = Number(result?.expires_in);
  if (
    typeof result?.access_token !== 'string' ||
    typeof result?.refresh_token !== 'string' ||
    !result.access_token ||
    !result.refresh_token
  ) {
    throw retry(
      'Claude answered without a usable token. Open Claude again and paste the new code.',
    );
  }
  const expiresAt =
    dependencies.now() +
    (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : 3600_000);
  const credential: Credential = {
    type: 'oauth',
    refresh: result.refresh_token,
    access: result.access_token,
    expires: expiresAt - EXPIRY_MARGIN_MS,
  } as Credential;
  const scopes =
    typeof result?.scope === 'string' && result.scope.trim()
      ? result.scope.trim().split(/\s+/)
      : [...CLAUDE_SCOPES];
  // Store ONLY in Claude Code's credentials file so Claude Code is the single
  // owner of the single-use rotating refresh token (sharing it with pi's
  // auth.json causes whichever process refreshes first to invalidate the other).
  try {
    await dependencies.saveClaudeCodeCredential({
      accessToken: result.access_token,
      refreshToken: result.refresh_token,
      expiresAt,
      scopes,
    });
  } catch (error: unknown) {
    logger.warn(
      { err: (error as Error)?.name ?? 'Error' },
      'Could not store the Claude Code credential',
    );
    throw new PublicLoginError(
      "Signed in, but the host couldn't save Claude Code credentials (.credentials.json). Check its disk and permissions, then connect again.",
    );
  }
  return credential;
}

/**
 * The subscription-runtime face of Claude: Piweb signs Claude Code in directly
 * (single owner of the rotating OAuth refresh token), and clears any stale
 * duplicate OAuth entry in pi's auth.json so pi never races Claude Code to
 * refresh the same token.
 */
export function claudeSubscriptionRuntime(
  pi: PiCredentialRuntime,
  overrides: Partial<ClaudeLoginDependencies> = {},
) {
  const readClaudeCodeAuth =
    overrides.readClaudeCodeAuth ?? DEFAULT_DEPENDENCIES.readClaudeCodeAuth;
  const clearClaudeCode =
    overrides.clearClaudeCodeCredential ?? DEFAULT_DEPENDENCIES.clearClaudeCodeCredential;
  return {
    async login(
      _provider: string,
      _type: 'oauth',
      interaction: CodeLoginInteraction,
    ): Promise<Credential> {
      const authorization = createClaudeAuthorization();
      interaction.notify({ type: 'auth_url', url: authorization.url });
      const credential = await withPastedCode(
        interaction,
        'Paste the code Claude shows',
        async (pasted) => {
          const { code, state } = parseClaudeAuthorizationCode(pasted, authorization.state);
          interaction.notify({ type: 'progress', message: 'Exchanging authorization code' });
          return exchangeClaudeCode(
            code,
            state,
            authorization.verifier,
            interaction.signal,
            overrides,
          );
        },
      );
      // Remove any duplicate OAuth credential in pi's auth.json so pi never
      // rotates the refresh token out from under Claude Code.
      await Promise.resolve()
        .then(async () => {
          if (isOauth(await pi.checkAuth(CLAUDE_PROVIDER, { signal: interaction.signal }))) {
            await pi.logout(CLAUDE_PROVIDER, { signal: interaction.signal });
          }
        })
        .catch((error: unknown) =>
          logger.warn(
            { err: (error as Error)?.name ?? 'Error' },
            'Could not clear duplicate pi Claude credential',
          ),
        );
      return credential;
    },
    async logout(provider: string, options?: { signal?: AbortSignal }): Promise<void> {
      await clearClaudeCode();
      if (isOauth(await pi.checkAuth(provider, options))) {
        await pi.logout(provider, options);
      }
    },
    async checkAuth(_provider: string, _options?: { signal?: AbortSignal }): Promise<unknown> {
      return (await claudeCodeSignedIn(readClaudeCodeAuth))
        ? { type: 'oauth', via: 'claude-code' }
        : undefined;
    },
  };
}
