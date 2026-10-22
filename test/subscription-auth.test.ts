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
});
