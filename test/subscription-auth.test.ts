import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalDbPath = process.env.DB_PATH;
let tempDir = '';

beforeEach(async () => {
  tempDir = mkdtempSync(resolve(tmpdir(), 'piweb-subscription-'));
  process.env.DB_PATH = resolve(tempDir, 'gateway.db');
  vi.resetModules();
  const db = await import('../src/db.js');
  db.initDb();
});

afterEach(async () => {
  const db = await import('../src/db.js').catch(() => null);
  db?.closeDb();
  vi.resetModules();
  if (originalDbPath === undefined) delete process.env.DB_PATH;
  else process.env.DB_PATH = originalDbPath;
  rmSync(tempDir, { recursive: true, force: true });
});

describe('Pi subscription jobs', () => {
  it('queues one active OpenAI login and exposes only non-secret device-flow state', async () => {
    const db = await import('../src/db.js');

    const id = db.enqueueSubscriptionJob('openai-codex', 'login');
    expect(db.getSubscriptionJob(id)).toMatchObject({
      id,
      provider: 'openai-codex',
      action: 'login',
      status: 'pending',
      userCode: '',
      verificationUri: '',
    });
    expect(() => db.enqueueSubscriptionJob('openai-codex', 'login')).toThrow(
      'A subscription operation is already active',
    );

    const claimed = db.claimPendingSubscriptionJob();
    expect(claimed).toMatchObject({ id, status: 'processing' });
    db.updateSubscriptionJobDeviceCode(id, {
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://example.test/device',
      expiresInSeconds: 900,
    });
    expect(db.getSubscriptionJob(id)).toMatchObject({
      status: 'waiting',
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://example.test/device',
      expiresAt: expect.any(String),
    });

    db.finishSubscriptionJob(id, true, 'Connected');
    expect(db.getSubscriptionJob(id)).toMatchObject({ status: 'succeeded', message: 'Connected' });
  });

  it('never persists or logs upstream auth progress and exception secrets', async () => {
    const accessToken = 'access-token-VERY-SECRET';
    const refreshToken = 'refresh-token-VERY-SECRET';
    const db = await import('../src/db.js');
    const { logger } = await import('../src/logger.js');
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const { runSubscriptionJob } = await import('../src/worker/subscriptions.js');
    const id = db.enqueueSubscriptionJob('openai-codex', 'login');
    const job = db.claimPendingSubscriptionJob()!;
    const observedJobs: string[] = [];

    const runtime = {
      login: vi.fn(async (_provider: string, _type: string, interaction: any) => {
        interaction.notify({ type: 'progress', message: `Bearer ${accessToken}` });
        observedJobs.push(JSON.stringify(db.getSubscriptionJob(id)));
        interaction.notify({ type: 'info', message: `refresh=${refreshToken}` });
        observedJobs.push(JSON.stringify(db.getSubscriptionJob(id)));
        throw new Error(`OAuth failed with ${refreshToken}`);
      }),
      logout: vi.fn(),
    };

    await runSubscriptionJob(job, runtime as any, new AbortController().signal);

    const persisted = [...observedJobs, JSON.stringify(db.getSubscriptionJob(id))].join('\n');
    const logged = JSON.stringify(warn.mock.calls);
    expect(persisted).not.toContain(accessToken);
    expect(persisted).not.toContain(refreshToken);
    expect(logged).not.toContain(accessToken);
    expect(logged).not.toContain(refreshToken);
    expect(db.getSubscriptionJob(id)).toMatchObject({
      status: 'failed',
      error: 'Subscription operation failed',
    });
  });

  it('allows subscription loop startup to retry after runtime initialization fails', async () => {
    const modelCatalog = await import('../src/agent/model-catalog.js');
    const runtime = {
      login: vi.fn(),
      logout: vi.fn(),
      checkAuth: vi.fn().mockResolvedValue(false),
    };
    const getRuntime = vi
      .spyOn(modelCatalog, 'getModelRuntime')
      .mockRejectedValueOnce(new Error('runtime init leaked refresh-token-VERY-SECRET'))
      .mockResolvedValue(runtime as any);
    const { startSubscriptionLoop, stopSubscriptionLoop } =
      await import('../src/worker/subscriptions.js');

    await expect(startSubscriptionLoop()).rejects.toThrow(
      'Subscription manager initialization failed',
    );
    await expect(startSubscriptionLoop()).resolves.toBeUndefined();
    expect(getRuntime).toHaveBeenCalledTimes(2);
    await stopSubscriptionLoop();
  });

  it('drives the provider device-code flow and marks the job connected when polling completes', async () => {
    const db = await import('../src/db.js');
    const { runSubscriptionJob } = await import('../src/worker/subscriptions.js');
    const id = db.enqueueSubscriptionJob('openai-codex', 'login');
    const job = db.claimPendingSubscriptionJob()!;

    const runtime = {
      login: vi.fn(async (_provider: string, _type: string, interaction: any) => {
        const method = await interaction.prompt({
          type: 'select',
          message: 'Select OpenAI Codex login method:',
          options: [
            { id: 'browser', label: 'Browser' },
            { id: 'device_code', label: 'Device code' },
          ],
        });
        expect(method).toBe('device_code');
        interaction.notify({
          type: 'device_code',
          userCode: 'WXYZ-1234',
          verificationUri: 'https://example.test/device',
          expiresInSeconds: 600,
        });
        return {
          type: 'oauth',
          access: 'secret',
          refresh: 'secret',
          expires: Date.now() + 600_000,
        };
      }),
      logout: vi.fn(),
    };

    await runSubscriptionJob(job, runtime as any, new AbortController().signal);

    expect(runtime.login).toHaveBeenCalledWith(
      'openai-codex',
      'oauth',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(db.getSubscriptionJob(id)).toMatchObject({
      status: 'succeeded',
      userCode: 'WXYZ-1234',
      verificationUri: 'https://example.test/device',
    });
  });

  it('drives the Claude browser-link flow with a pasted code and never keeps the code', async () => {
    const db = await import('../src/db.js');
    const { runSubscriptionJob } = await import('../src/worker/subscriptions.js');
    const id = db.enqueueSubscriptionJob('anthropic', 'login');
    const job = db.claimPendingSubscriptionJob()!;
    const authUrl = 'https://claude.ai/oauth/authorize?code=true&state=abc';
    let received = '';

    const runtime = {
      login: vi.fn(async (_provider: string, _type: string, interaction: any) => {
        interaction.notify({ type: 'auth_url', url: authUrl });
        const pending = interaction.prompt({ type: 'manual_code', message: 'Paste code' });
        // The web tier relays the pasted value; the worker takes it once.
        await vi.waitFor(() =>
          expect(db.getSubscriptionJob(id)).toMatchObject({ status: 'waiting', authUrl }),
        );
        expect(db.submitSubscriptionJobCode('anthropic', 'the-code#abc')).toBe(true);
        expect(db.getSubscriptionJob(id)).toMatchObject({ codeSubmitted: true });
        received = await pending;
        expect(db.getSubscriptionJob(id)).toMatchObject({ codeSubmitted: false });
        return {
          type: 'oauth',
          access: 'secret',
          refresh: 'secret',
          expires: Date.now() + 600_000,
        };
      }),
      logout: vi.fn(),
    };

    await runSubscriptionJob(job, runtime as any, new AbortController().signal);

    expect(received).toBe('the-code#abc');
    expect(runtime.login).toHaveBeenCalledWith('anthropic', 'oauth', expect.anything());
    expect(db.getSubscriptionJob(id)).toMatchObject({
      status: 'succeeded',
      authUrl: '',
      codeSubmitted: false,
    });
    expect(db.getMeta('subscription.anthropic')).toContain('"connected":true');
  });

  it('reports a rejected Claude code and refuses links to other hosts', async () => {
    const db = await import('../src/db.js');
    const { runSubscriptionJob } = await import('../src/worker/subscriptions.js');

    const id = db.enqueueSubscriptionJob('anthropic', 'login');
    const job = db.claimPendingSubscriptionJob()!;
    await runSubscriptionJob(
      job,
      {
        login: vi.fn(async (_p: string, _t: string, interaction: any) => {
          interaction.notify({ type: 'auth_url', url: 'https://claude.ai/oauth/authorize' });
          const pending = interaction.prompt({ type: 'manual_code', message: 'Paste code' });
          db.submitSubscriptionJobCode('anthropic', 'wrong');
          await pending;
          throw new Error('Token exchange request failed. body=secret');
        }),
        logout: vi.fn(),
      } as any,
      new AbortController().signal,
    );
    expect(db.getSubscriptionJob(id)).toMatchObject({
      status: 'failed',
      error: 'Authorization code was not accepted; connect again for a new link',
    });

    const id2 = db.enqueueSubscriptionJob('anthropic', 'login');
    await runSubscriptionJob(
      db.claimPendingSubscriptionJob()!,
      {
        login: vi.fn(async (_p: string, _t: string, interaction: any) => {
          interaction.notify({ type: 'auth_url', url: 'https://evil.example/oauth' });
        }),
        logout: vi.fn(),
      } as any,
      new AbortController().signal,
    );
    expect(db.getSubscriptionJob(id2)).toMatchObject({
      status: 'failed',
      error: 'Provider returned an unsafe verification URL',
      authUrl: '',
    });
  });

  it('a cancelled Claude sign-in stops waiting for the code', async () => {
    const db = await import('../src/db.js');
    const { runSubscriptionJob } = await import('../src/worker/subscriptions.js');
    const id = db.enqueueSubscriptionJob('anthropic', 'login');
    const job = db.claimPendingSubscriptionJob()!;
    const controller = new AbortController();
    const run = runSubscriptionJob(
      job,
      {
        login: vi.fn(async (_p: string, _t: string, interaction: any) => {
          interaction.notify({ type: 'auth_url', url: 'https://claude.ai/oauth/authorize' });
          return interaction.prompt({ type: 'manual_code', message: 'Paste code' });
        }),
        logout: vi.fn(),
      } as any,
      controller.signal,
    );
    await vi.waitFor(() => expect(db.getSubscriptionJob(id)?.status).toBe('waiting'));
    expect(db.cancelSubscriptionJob('anthropic')).toBe(true);
    controller.abort(); // what the loop's cancel watcher does
    await run;
    expect(db.getSubscriptionJob(id)).toMatchObject({ status: 'failed', error: 'Cancelled' });
    expect(db.submitSubscriptionJobCode('anthropic', 'late')).toBe(false);
    // A new sign-in can start right away.
    expect(() => db.enqueueSubscriptionJob('anthropic', 'login')).not.toThrow();
  });

  it('signs the agy CLI in with the code Google shows, through the same job flow', async () => {
    const tokenPath = resolve(tempDir, 'agy', 'antigravity-oauth-token');
    vi.stubEnv('AGY_TOKEN_PATH', tokenPath);
    vi.stubEnv('AGY_OAUTH_CLIENT_SECRET', 'GOCSPX-test');
    const exchange = vi.fn(async (_url: string, init: any) => {
      const body = new URLSearchParams(init.body);
      expect(body.get('code')).toBe('4/0AVG-code');
      return new Response(
        JSON.stringify({ access_token: 'ya29', refresh_token: '1//r', expires_in: 3599 }),
      );
    });
    vi.stubGlobal('fetch', exchange);
    try {
      const db = await import('../src/db.js');
      const { runSubscriptionJob } = await import('../src/worker/subscriptions.js');
      const { agySubscriptionRuntime } = await import('../src/agy-login.js');
      const id = db.enqueueSubscriptionJob('agy', 'login');
      const run = runSubscriptionJob(
        db.claimPendingSubscriptionJob()!,
        agySubscriptionRuntime as any,
        new AbortController().signal,
      );
      await vi.waitFor(() => expect(db.getSubscriptionJob(id)?.status).toBe('waiting'));
      const authUrl = new URL(db.getSubscriptionJob(id)!.authUrl);
      expect(authUrl.hostname).toBe('accounts.google.com');
      // A pasted callback address works as well as the bare code.
      const state = authUrl.searchParams.get('state');
      const callback = `https://antigravity.google/oauth-callback?code=4%2F0AVG-code&state=${state}`;
      expect(db.submitSubscriptionJobCode('agy', callback)).toBe(true);
      await run;
      expect(db.getSubscriptionJob(id)).toMatchObject({ status: 'succeeded', authUrl: '' });
      expect(db.getMeta('subscription.agy')).toContain('"connected":true');
      expect(await agySubscriptionRuntime.checkAuth()).toBe(true);
      expect(exchange).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it('a Claude code that fails for a fixable reason keeps the sign-in waiting and says why', async () => {
    const db = await import('../src/db.js');
    const { runSubscriptionJob } = await import('../src/worker/subscriptions.js');
    const { claudeSubscriptionRuntime } = await import('../src/claude-login.js');
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 3600 })),
      );
    const saveCredential = vi.fn(async () => undefined);
    const pi = { refresh: vi.fn(async () => undefined), logout: vi.fn(), checkAuth: vi.fn() };
    const id = db.enqueueSubscriptionJob('anthropic', 'login');
    const run = runSubscriptionJob(
      db.claimPendingSubscriptionJob()!,
      claudeSubscriptionRuntime(pi, { fetchImpl: fetchImpl as any, saveCredential }) as any,
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(db.getSubscriptionJob(id)?.status).toBe('waiting'));
    const authUrl = new URL(db.getSubscriptionJob(id)!.authUrl);
    expect(authUrl.searchParams.get('redirect_uri')).toBe('https://platform.claude.com/oauth/code/callback');
    const state = authUrl.searchParams.get('state');

    expect(db.submitSubscriptionJobCode('anthropic', 'abc#someone-elses-state')).toBe(true);
    await vi.waitFor(() =>
      expect(db.getSubscriptionJob(id)).toMatchObject({
        status: 'waiting',
        codeSubmitted: false,
        message: expect.stringContaining('older sign-in link'),
      }),
    );
    expect(fetchImpl).not.toHaveBeenCalled();

    expect(db.submitSubscriptionJobCode('anthropic', `expired#${state}`)).toBe(true);
    await vi.waitFor(() =>
      expect(db.getSubscriptionJob(id)).toMatchObject({
        status: 'waiting',
        message: expect.stringContaining('did not accept'),
      }),
    );

    expect(db.submitSubscriptionJobCode('anthropic', `good#${state}`)).toBe(true);
    await run;
    expect(db.getSubscriptionJob(id)).toMatchObject({ status: 'succeeded', authUrl: '' });
    expect(db.getMeta('subscription.anthropic')).toContain('"connected":true');
    expect(saveCredential).toHaveBeenCalledTimes(1);
  });

  it('shows a safe reason for a fatal sign-in error, and for a failed disconnect', async () => {
    const db = await import('../src/db.js');
    const { runSubscriptionJob } = await import('../src/worker/subscriptions.js');
    const { PublicLoginError } = await import('../src/subscription-login.js');
    const id = db.enqueueSubscriptionJob('agy', 'login');
    await runSubscriptionJob(
      db.claimPendingSubscriptionJob()!,
      {
        login: vi.fn(async () => {
          throw new PublicLoginError('Antigravity sign-in needs the agy CLI on the host');
        }),
        logout: vi.fn(),
      } as any,
      new AbortController().signal,
    );
    expect(db.getSubscriptionJob(id)).toMatchObject({
      status: 'failed',
      error: 'Antigravity sign-in needs the agy CLI on the host',
    });

    const out = db.enqueueSubscriptionJob('agy', 'logout');
    await runSubscriptionJob(
      db.claimPendingSubscriptionJob()!,
      {
        login: vi.fn(),
        logout: vi.fn(async () => {
          throw new Error('EACCES /secret/path');
        }),
      } as any,
      new AbortController().signal,
    );
    expect(db.getSubscriptionJob(out)).toMatchObject({
      status: 'failed',
      error: 'Could not disconnect; try again',
    });
  });

  it('a pi sign-in whose model reload fails is still connected', async () => {
    const db = await import('../src/db.js');
    const { runSubscriptionJob } = await import('../src/worker/subscriptions.js');
    const { CredentialSynchronizationError } = await import('@earendil-works/pi-coding-agent');
    const id = db.enqueueSubscriptionJob('openai-codex', 'login');
    await runSubscriptionJob(
      db.claimPendingSubscriptionJob()!,
      {
        login: vi.fn(async () => {
          throw new CredentialSynchronizationError('openai-codex', 'login', undefined, {
            cause: new Error('reload'),
          });
        }),
        logout: vi.fn(),
      } as any,
      new AbortController().signal,
    );
    expect(db.getSubscriptionJob(id)).toMatchObject({ status: 'succeeded' });
    expect(db.getMeta('subscription.openai-codex')).toContain('"connected":true');
  });

  it('counts only a sign-in as a connected subscription, not an API key', async () => {
    const db = await import('../src/db.js');
    const modelCatalog = await import('../src/agent/model-catalog.js');
    const agyLogin = await import('../src/agy-login.js');
    vi.spyOn(agyLogin.agySubscriptionRuntime, 'checkAuth').mockResolvedValue(false);
    const runtime = {
      login: vi.fn(),
      logout: vi.fn(),
      checkAuth: vi.fn(async (provider: string) =>
        provider === 'anthropic' ? { source: 'ANTHROPIC_API_KEY', type: 'api_key' } : { source: 'OAuth', type: 'oauth' },
      ),
    };
    vi.spyOn(modelCatalog, 'getModelRuntime').mockResolvedValue(runtime as any);
    const { startSubscriptionLoop, stopSubscriptionLoop } = await import('../src/worker/subscriptions.js');
    await startSubscriptionLoop();
    await stopSubscriptionLoop();
    expect(db.getMeta('subscription.anthropic')).toContain('"connected":false');
    expect(db.getMeta('subscription.openai-codex')).toContain('"connected":true');
    expect(db.getMeta('subscription.agy')).toContain('"connected":false');
  });
});
