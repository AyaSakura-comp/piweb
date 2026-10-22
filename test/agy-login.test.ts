import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGY_LOGIN_CLIENT_ID,
  AGY_REDIRECT_URI,
  agySubscriptionRuntime,
  createAgyAuthorization,
  exchangeAgyCode,
  parseAgyAuthorizationCode,
} from '../src/agy-login.js';

const originalTokenPath = process.env.AGY_TOKEN_PATH;
let tempDir = '';

beforeEach(() => {
  tempDir = mkdtempSync(resolve(tmpdir(), 'piweb-agy-login-'));
  // A nested path: the first sign-in on a fresh host has no agy directory yet.
  process.env.AGY_TOKEN_PATH = resolve(tempDir, 'antigravity-cli', 'antigravity-oauth-token');
});

afterEach(() => {
  if (originalTokenPath === undefined) delete process.env.AGY_TOKEN_PATH;
  else process.env.AGY_TOKEN_PATH = originalTokenPath;
  rmSync(tempDir, { recursive: true, force: true });
});

const tokenResponse = {
  access_token: 'ya29.access',
  refresh_token: '1//refresh',
  expires_in: 3599,
  token_type: 'Bearer',
  id_token: 'eyJ.id.token',
};

const candidates = async () =>
  [
    ['other-client.apps.googleusercontent.com', 'GOCSPX-other'],
    [AGY_LOGIN_CLIENT_ID, 'GOCSPX-wrong'],
    [AGY_LOGIN_CLIENT_ID, 'GOCSPX-right'],
  ] as const;

function googleToken(fetchCalls: URLSearchParams[]) {
  return vi.fn(async (_url: string, init: any) => {
    const body = new URLSearchParams(init.body);
    fetchCalls.push(body);
    if (body.get('client_secret') !== 'GOCSPX-right') {
      return new Response(JSON.stringify({ error: 'invalid_client' }), { status: 401 });
    }
    return new Response(JSON.stringify(tokenResponse), { status: 200 });
  });
}

describe('agy sign-in', () => {
  it('builds the same Google link agy prints, with a PKCE challenge for its verifier', () => {
    const { url, verifier, state } = createAgyAuthorization();
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://accounts.google.com/o/oauth2/auth');
    const query = parsed.searchParams;
    expect(query.get('client_id')).toBe(AGY_LOGIN_CLIENT_ID);
    expect(query.get('redirect_uri')).toBe(AGY_REDIRECT_URI);
    expect(query.get('access_type')).toBe('offline');
    expect(query.get('prompt')).toBe('consent');
    expect(query.get('state')).toBe(state);
    expect(query.get('scope')!.split(' ')).toEqual(
      expect.arrayContaining([
        'https://www.googleapis.com/auth/cloud-platform',
        'https://www.googleapis.com/auth/aicode',
        'openid',
      ]),
    );
    expect(query.get('code_challenge')).toBe(
      createHash('sha256').update(verifier).digest('base64url'),
    );
  });

  it('takes the bare code the callback page shows, or a pasted callback address', () => {
    expect(parseAgyAuthorizationCode('  4/0AVG-code_1  ', 's')).toBe('4/0AVG-code_1');
    expect(
      parseAgyAuthorizationCode(`${AGY_REDIRECT_URI}?code=4%2F0AVG&state=s&scope=email`, 's'),
    ).toBe('4/0AVG');
    expect(parseAgyAuthorizationCode('code=4%2F0AVG&state=s', 's')).toBe('4/0AVG');
    expect(() => parseAgyAuthorizationCode(`${AGY_REDIRECT_URI}?code=x&state=other`, 's')).toThrow(
      'does not match',
    );
    expect(() => parseAgyAuthorizationCode(`${AGY_REDIRECT_URI}?state=s`, 's')).toThrow(
      'No authorization code',
    );
  });

  it("exchanges the code with agy's client and writes the file agy reads", async () => {
    const calls: URLSearchParams[] = [];
    const fetchImpl = googleToken(calls);
    await exchangeAgyCode('4/0AVG', 'the-verifier', undefined, {
      fetchImpl: fetchImpl as any,
      now: () => Date.parse('2026-10-22T00:00:00Z'),
      clientCandidates: candidates as any,
    });

    // Only the login client is tried; a wrong secret moves on to the next.
    expect(calls.map((c) => c.get('client_secret'))).toEqual(['GOCSPX-wrong', 'GOCSPX-right']);
    expect(Object.fromEntries(calls[1])).toMatchObject({
      client_id: AGY_LOGIN_CLIENT_ID,
      code: '4/0AVG',
      code_verifier: 'the-verifier',
      grant_type: 'authorization_code',
      redirect_uri: AGY_REDIRECT_URI,
    });
    const path = process.env.AGY_TOKEN_PATH!;
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      token: {
        access_token: 'ya29.access',
        token_type: 'Bearer',
        refresh_token: '1//refresh',
        expiry: '2026-10-22T00:59:59.000Z',
        expires_in: 3599,
      },
      auth_method: 'consumer',
      id_token: 'eyJ.id.token',
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(await agySubscriptionRuntime.checkAuth()).toBe(true);
  });

  it('stops at a rejected code instead of retrying it with other secrets', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
    );
    await expect(
      exchangeAgyCode('4/expired', 'v', undefined, {
        fetchImpl: fetchImpl as any,
        clientCandidates: candidates as any,
      }),
    ).rejects.toThrow('invalid_grant');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await agySubscriptionRuntime.checkAuth()).toBe(false);
  });

  it('disconnecting removes the credential file, and is fine when there is none', async () => {
    await agySubscriptionRuntime.logout();
    writeFileSync(resolve(tempDir, 'token'), '');
    process.env.AGY_TOKEN_PATH = resolve(tempDir, 'token');
    writeFileSync(
      process.env.AGY_TOKEN_PATH,
      JSON.stringify({ token: { access_token: 'a', refresh_token: 'r' } }),
    );
    expect(await agySubscriptionRuntime.checkAuth()).toBe(true);
    await agySubscriptionRuntime.logout();
    expect(await agySubscriptionRuntime.checkAuth()).toBe(false);
  });
});
