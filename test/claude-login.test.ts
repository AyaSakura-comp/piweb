import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  CLAUDE_CLIENT_ID,
  CLAUDE_REDIRECT_URI,
  claudeSubscriptionRuntime,
  createClaudeAuthorization,
  exchangeClaudeCode,
  parseClaudeAuthorizationCode,
} from '../src/claude-login.js';
import { MAX_CODE_ATTEMPTS, PublicLoginError, withPastedCode } from '../src/subscription-login.js';

const tokenResponse = { access_token: 'sk-ant-oat-access', refresh_token: 'sk-ant-ort-refresh', expires_in: 28800 };
const answer = (status: number, body: unknown) =>
  vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));

describe('Claude sign-in', () => {
  it("sends the phone to Anthropic's code page, not pi's localhost callback", () => {
    const { url, verifier, state } = createClaudeAuthorization();
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://claude.ai/oauth/authorize');
    const query = parsed.searchParams;
    expect(query.get('redirect_uri')).toBe('https://platform.claude.com/oauth/code/callback');
    expect(query.get('client_id')).toBe(CLAUDE_CLIENT_ID);
    expect(query.get('code')).toBe('true');
    expect(query.get('state')).toBe(state);
    expect(query.get('scope')!.split(' ')).toContain('user:inference');
    expect(query.get('code_challenge')).toBe(createHash('sha256').update(verifier).digest('base64url'));
  });

  it('reads the code page, a callback address or a bare code, and explains everything else', () => {
    const ok = { code: 'abc', state: 's' };
    expect(parseClaudeAuthorizationCode('abc#s', 's')).toEqual(ok);
    expect(parseClaudeAuthorizationCode('  "abc#s"\n', 's')).toEqual(ok);
    expect(parseClaudeAuthorizationCode('abc', 's')).toEqual(ok);
    expect(parseClaudeAuthorizationCode(`${CLAUDE_REDIRECT_URI}?code=abc&state=s`, 's')).toEqual(ok);
    expect(parseClaudeAuthorizationCode('code=abc&state=s', 's')).toEqual(ok);

    const fails = (input: string, message: string) => {
      let error: unknown;
      try {
        parseClaudeAuthorizationCode(input, 's');
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(PublicLoginError);
      expect(error).toMatchObject({ retryable: true, message: expect.stringContaining(message) });
    };
    // A code from the localhost link of an older (pi-run) sign-in.
    fails('http://localhost:53692/callback?code=abc&state=old', 'older sign-in link');
    fails('abc#old', 'older sign-in link');
    fails('https://claude.ai/oauth/authorize?code=true&client_id=x', 'sign-in link itself');
    fails(`${CLAUDE_REDIRECT_URI}?error=access_denied&state=s`, 'declined');
    fails(`${CLAUDE_REDIRECT_URI}?state=s`, 'No code found');
    fails('#s', 'No code found');
    fails('  ', 'Paste the code');
  });

  it('exchanges the code with the same redirect and stores a pi OAuth credential', async () => {
    const fetchImpl = answer(200, tokenResponse);
    const saveCredential = vi.fn(async () => undefined);
    const credential = await exchangeClaudeCode('abc', 's', 'the-verifier', undefined, {
      fetchImpl: fetchImpl as any,
      now: () => 1_000_000,
      saveCredential,
    });
    const [url, init] = (fetchImpl.mock.calls[0] as unknown) as [string, RequestInit];
    expect(url).toBe('https://platform.claude.com/v1/oauth/token');
    expect(JSON.parse(String(init.body))).toEqual({
      grant_type: 'authorization_code',
      client_id: CLAUDE_CLIENT_ID,
      code: 'abc',
      state: 's',
      redirect_uri: CLAUDE_REDIRECT_URI,
      code_verifier: 'the-verifier',
    });
    expect(credential).toEqual({
      type: 'oauth',
      access: 'sk-ant-oat-access',
      refresh: 'sk-ant-ort-refresh',
      expires: 1_000_000 + 28800_000 - 300_000,
    });
    expect(saveCredential).toHaveBeenCalledWith(credential);
  });

  it('classifies every failure, never quoting the upstream body', async () => {
    const run = (fetchImpl: any, saveCredential: any = vi.fn()) =>
      exchangeClaudeCode('abc', 's', 'v', undefined, { fetchImpl, saveCredential });
    const expectFailure = async (promise: Promise<unknown>, retryable: boolean, text: string) => {
      const error = await promise.then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(PublicLoginError);
      expect(error).toMatchObject({ retryable, message: expect.stringContaining(text) });
      expect((error as Error).message).not.toContain('secret-body');
    };
    await expectFailure(run(answer(400, { error: 'invalid_grant', error_description: 'secret-body' })), true, 'did not accept');
    await expectFailure(run(answer(401, 'secret-body')), true, 'did not accept');
    await expectFailure(run(answer(429, {})), true, 'limiting');
    await expectFailure(run(answer(502, 'secret-body')), true, 'HTTP 502');
    await expectFailure(run(answer(403, { error: 'secret body!' })), true, 'HTTP 403');
    await expectFailure(run(answer(200, 'not json secret-body')), true, 'usable token');
    await expectFailure(run(answer(200, { access_token: 'a' })), true, 'usable token');
    await expectFailure(
      run(
        vi.fn(async () => {
          throw new TypeError('fetch failed secret-body');
        }),
      ),
      true,
      'Could not reach Claude',
    );
    await expectFailure(
      run(
        vi.fn(async () => {
          throw new DOMException('The operation timed out.', 'TimeoutError');
        }),
      ),
      true,
      'Could not reach Claude',
    );
    await expectFailure(
      run(
        answer(200, tokenResponse),
        vi.fn(async () => {
          throw new Error('EACCES secret-body');
        }),
      ),
      false,
      "couldn't save",
    );
  });

  it('a cancelled sign-in stops the exchange instead of reporting a network error', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      init.signal?.throwIfAborted();
      return new Response('{}');
    });
    await expect(
      exchangeClaudeCode('abc', 's', 'v', controller.signal, { fetchImpl: fetchImpl as any }),
    ).rejects.not.toBeInstanceOf(PublicLoginError);
  });

  it('keeps the same link waiting through fixable codes, then reloads pi', async () => {
    const pi = { refresh: vi.fn(async () => undefined), logout: vi.fn(), checkAuth: vi.fn() };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(tokenResponse)));
    const saveCredential = vi.fn(async () => undefined);
    const runtime = claudeSubscriptionRuntime(pi, { fetchImpl: fetchImpl as any, saveCredential });
    let state = '';
    const pastes = ['abc#old-state', 'expired#STATE', 'good#STATE'];
    const rejected: string[] = [];
    await runtime.login('anthropic', 'oauth', {
      notify: (event: any) => {
        if (event.type === 'auth_url') state = new URL(event.url).searchParams.get('state')!;
      },
      prompt: async () => pastes.shift()!.replace('STATE', state),
      rejectCode: (message: string) => rejected.push(message),
    });
    expect(rejected).toEqual([
      expect.stringContaining('older sign-in link'),
      expect.stringContaining('did not accept'),
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(saveCredential).toHaveBeenCalledTimes(1);
    expect(pi.refresh).toHaveBeenCalledWith({ providers: ['anthropic'], allowNetwork: false });
  });

  it('a failed pi reload after storing the credential does not undo the sign-in', async () => {
    const pi = { refresh: vi.fn(async () => Promise.reject(new Error('reload'))), logout: vi.fn(), checkAuth: vi.fn() };
    const runtime = claudeSubscriptionRuntime(pi, {
      fetchImpl: answer(200, tokenResponse) as any,
      saveCredential: vi.fn(async () => undefined),
    });
    let state = '';
    await expect(
      runtime.login('anthropic', 'oauth', {
        notify: (event: any) => {
          if (event.type === 'auth_url') state = new URL(event.url).searchParams.get('state')!;
        },
        prompt: async () => `good#${state}`,
      }),
    ).resolves.toMatchObject({ type: 'oauth' });
  });
});

describe('pasted-code retries', () => {
  const fixable = () => Promise.reject(new PublicLoginError('try again', true));

  it(`gives up after ${MAX_CODE_ATTEMPTS} unusable codes`, async () => {
    const rejectCode = vi.fn();
    const prompt = vi.fn(async () => 'x');
    await expect(withPastedCode({ notify: vi.fn(), prompt, rejectCode }, 'm', fixable)).rejects.toThrow(
      'try again',
    );
    expect(prompt).toHaveBeenCalledTimes(MAX_CODE_ATTEMPTS);
    expect(rejectCode).toHaveBeenCalledTimes(MAX_CODE_ATTEMPTS - 1);
  });

  it('ends at once on a failure that a new code cannot fix, or with nowhere to say why', async () => {
    const prompt = vi.fn(async () => 'x');
    await expect(
      withPastedCode({ notify: vi.fn(), prompt, rejectCode: vi.fn() }, 'm', () =>
        Promise.reject(new PublicLoginError('fatal')),
      ),
    ).rejects.toThrow('fatal');
    await expect(withPastedCode({ notify: vi.fn(), prompt }, 'm', fixable)).rejects.toThrow('try again');
    expect(prompt).toHaveBeenCalledTimes(2);
  });
});
