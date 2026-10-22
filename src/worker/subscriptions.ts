import type { AuthEvent, AuthInteraction, AuthPrompt, Credential } from '@earendil-works/pi-ai';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import {
  claimPendingSubscriptionJob,
  finishSubscriptionJob,
  getSubscriptionJob,
  isSubscriptionProvider,
  recoverStuckSubscriptionJobs,
  SUBSCRIPTION_PROVIDERS,
  setMeta,
  type SubscriptionJob,
  takeSubscriptionJobCode,
  updateSubscriptionJobAuthUrl,
  updateSubscriptionJobDeviceCode,
  updateSubscriptionJobMessage,
} from '../db.js';
import { getModelRuntime } from '../agent/model-catalog.js';
import { logger } from '../logger.js';

const SUBSCRIPTION_POLL_MS = 500;
// How long a browser-link login (Claude) waits for the pasted code.
const MANUAL_CODE_TIMEOUT_MS = 10 * 60_000;
// Hosts a provider's authorization link may point at.
const AUTH_URL_HOSTS: Record<string, readonly string[]> = {
  anthropic: ['claude.ai', 'claude.com', 'console.anthropic.com', 'platform.claude.com'],
};
const statusMetaKey = (provider: string) => `subscription.${provider}`;
const PUBLIC_STATUS = {
  connecting: 'Connecting to provider',
  failed: 'Subscription operation failed',
  cancelled: 'Subscription operation cancelled',
  unsupportedProvider: 'Unsupported subscription provider',
  unsupportedPrompt: 'Device login prompt is unsupported',
  unavailableDeviceCode: 'This provider does not offer device-code login',
  unsafeVerificationUrl: 'Provider returned an unsafe verification URL',
  codeTimedOut: 'Timed out waiting for the authorization code',
  codeRejected: 'Authorization code was not accepted; connect again for a new link',
  initializationFailed: 'Subscription manager initialization failed',
} as const;

type SafeErrorCode =
  | 'unsupportedProvider'
  | 'unsupportedPrompt'
  | 'unavailableDeviceCode'
  | 'unsafeVerificationUrl'
  | 'codeTimedOut'
  | 'initializationFailed';

class SafeSubscriptionError extends Error {
  constructor(readonly code: SafeErrorCode) {
    super(PUBLIC_STATUS[code]);
  }
}

interface SubscriptionRuntime {
  login(providerId: string, type: 'oauth', interaction: AuthInteraction): Promise<Credential>;
  logout(providerId: string, options?: { signal?: AbortSignal }): Promise<void>;
  checkAuth?(providerId: string, options?: { signal?: AbortSignal }): Promise<unknown>;
}

let running = false;
let timer: NodeJS.Timeout | undefined;
let active: Promise<void> | undefined;
let activeController: AbortController | undefined;

function publishStatus(provider: string, connected: boolean): void {
  setMeta(
    statusMetaKey(provider),
    JSON.stringify({ connected, updatedAt: new Date().toISOString() }),
  );
}

function selectDeviceCode(prompt: AuthPrompt): Promise<string> {
  if (prompt.type !== 'select') {
    return Promise.reject(new SafeSubscriptionError('unsupportedPrompt'));
  }
  const option = prompt.options.find((candidate) => candidate.id === 'device_code');
  if (!option) return Promise.reject(new SafeSubscriptionError('unavailableDeviceCode'));
  return Promise.resolve(option.id);
}

/**
 * Wait for the code the user pastes in Settings. The provider's own callback
 * server may win first (login on the host itself); it aborts `prompt.signal`.
 */
function waitForManualCode(jobId: string, prompt: AuthPrompt, signal: AbortSignal): Promise<string> {
  const deadline = Date.now() + MANUAL_CODE_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const stop = (error: Error) => {
      clearTimeout(timer);
      reject(error);
    };
    const check = () => {
      if (signal.aborted || prompt.signal?.aborted) {
        stop(new Error('Login prompt aborted'));
        return;
      }
      const code = takeSubscriptionJobCode(jobId);
      if (code) {
        resolve(code);
        return;
      }
      if (Date.now() >= deadline) {
        stop(new SafeSubscriptionError('codeTimedOut'));
        return;
      }
      timer = setTimeout(check, SUBSCRIPTION_POLL_MS);
      timer.unref?.();
    };
    check();
  });
}

function promptFor(jobId: string, signal: AbortSignal, flow: { codeTaken: boolean }) {
  return async (prompt: AuthPrompt): Promise<string> => {
    if (prompt.type === 'select') return selectDeviceCode(prompt);
    if (prompt.type !== 'manual_code') throw new SafeSubscriptionError('unsupportedPrompt');
    const code = await waitForManualCode(jobId, prompt, signal);
    flow.codeTaken = true;
    return code;
  };
}

function onAuthEvent(job: SubscriptionJob, event: AuthEvent): void {
  const jobId = job.id;
  if (event.type === 'auth_url') {
    let url: URL;
    try {
      url = new URL(event.url);
    } catch {
      throw new SafeSubscriptionError('unsafeVerificationUrl');
    }
    if (url.protocol !== 'https:' || !AUTH_URL_HOSTS[job.provider]?.includes(url.hostname)) {
      throw new SafeSubscriptionError('unsafeVerificationUrl');
    }
    updateSubscriptionJobAuthUrl(jobId, url.toString(), new Date(Date.now() + MANUAL_CODE_TIMEOUT_MS));
    return;
  }
  if (event.type === 'device_code') {
    let verification: URL;
    try {
      verification = new URL(event.verificationUri);
    } catch {
      throw new SafeSubscriptionError('unsafeVerificationUrl');
    }
    if (verification.protocol !== 'https:') {
      throw new SafeSubscriptionError('unsafeVerificationUrl');
    }
    updateSubscriptionJobDeviceCode(jobId, {
      userCode: event.userCode,
      verificationUri: verification.toString(),
      expiresInSeconds: event.expiresInSeconds,
    });
    return;
  }
  if (event.type === 'progress' || event.type === 'info') {
    updateSubscriptionJobMessage(jobId, PUBLIC_STATUS.connecting);
  }
}

export async function runSubscriptionJob(
  job: SubscriptionJob,
  runtime: SubscriptionRuntime,
  signal: AbortSignal,
): Promise<void> {
  const flow = { codeTaken: false };
  try {
    if (!isSubscriptionProvider(job.provider)) {
      throw new SafeSubscriptionError('unsupportedProvider');
    }
    if (job.action === 'logout') {
      await runtime.logout(job.provider, { signal });
      publishStatus(job.provider, false);
      finishSubscriptionJob(job.id, true, 'Disconnected');
      return;
    }

    await runtime.login(job.provider, 'oauth', {
      signal,
      prompt: promptFor(job.id, signal, flow),
      notify: (event) => onAuthEvent(job, event),
    });
    publishStatus(job.provider, true);
    finishSubscriptionJob(job.id, true, 'Connected');
  } catch (error: unknown) {
    // A pasted code that reached the token exchange and failed there is the
    // usual way a Claude login goes wrong (wrong/expired/truncated code).
    const message = signal.aborted
      ? PUBLIC_STATUS.cancelled
      : error instanceof SafeSubscriptionError
        ? PUBLIC_STATUS[error.code]
        : flow.codeTaken
          ? PUBLIC_STATUS.codeRejected
          : PUBLIC_STATUS.failed;
    finishSubscriptionJob(job.id, false, message);
    if (!signal.aborted) logger.warn({ err: message, provider: job.provider }, PUBLIC_STATUS.failed);
  }
}

async function publishInitialStatus(runtime: SubscriptionRuntime): Promise<void> {
  for (const provider of SUBSCRIPTION_PROVIDERS) {
    try {
      publishStatus(provider, Boolean(await runtime.checkAuth?.(provider)));
    } catch {
      logger.warn({ err: 'Subscription status unavailable', provider }, 'Could not read subscription status');
    }
  }
}

// Settings can cancel an operation (the job row turns failed); abort the
// provider flow so its callback server and polling stop too.
function watchForCancel(jobId: string, controller: AbortController): () => void {
  const interval = setInterval(() => {
    if (getSubscriptionJob(jobId)?.status === 'failed') controller.abort();
  }, SUBSCRIPTION_POLL_MS);
  interval.unref?.();
  return () => clearInterval(interval);
}

function schedule(delay = SUBSCRIPTION_POLL_MS): void {
  if (!running || timer || active) return;
  timer = setTimeout(() => {
    timer = undefined;
    const job = claimPendingSubscriptionJob();
    if (!job) {
      schedule();
      return;
    }
    const controller = new AbortController();
    activeController = controller;
    const unwatch = watchForCancel(job.id, controller);
    const current = getModelRuntime()
      .then((runtime) => runSubscriptionJob(job, runtime, controller.signal))
      .finally(() => {
        unwatch();
        if (active === current) active = undefined;
        activeController = undefined;
        schedule(0);
      });
    active = current;
  }, delay);
  timer.unref?.();
}

export async function startSubscriptionLoop(): Promise<void> {
  if (running) return;
  const recovered = recoverStuckSubscriptionJobs();
  if (recovered) logger.warn({ count: recovered }, 'Failed subscription jobs left by worker restart');
  running = true;
  try {
    const runtime = await getModelRuntime();
    await publishInitialStatus(runtime);
    schedule(0);
  } catch {
    running = false;
    throw new SafeSubscriptionError('initializationFailed');
  }
}

export async function stopSubscriptionLoop(): Promise<void> {
  running = false;
  if (timer) clearTimeout(timer);
  timer = undefined;
  activeController?.abort();
  await active;
}
