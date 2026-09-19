import type { AuthEvent, AuthInteraction, AuthPrompt, Credential } from '@earendil-works/pi-ai';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import {
  claimPendingSubscriptionJob,
  finishSubscriptionJob,
  recoverStuckSubscriptionJobs,
  setMeta,
  type SubscriptionJob,
  updateSubscriptionJobDeviceCode,
  updateSubscriptionJobMessage,
} from '../db.js';
import { getModelRuntime } from '../agent/model-catalog.js';
import { logger } from '../logger.js';

const SUBSCRIPTION_POLL_MS = 500;
const OPENAI_PROVIDER = 'openai-codex';
const STATUS_META_KEY = `subscription.${OPENAI_PROVIDER}`;
const PUBLIC_STATUS = {
  connecting: 'Connecting to provider',
  failed: 'Subscription operation failed',
  cancelled: 'Subscription operation cancelled',
  unsupportedProvider: 'Unsupported subscription provider',
  unsupportedPrompt: 'Device login prompt is unsupported',
  unavailableDeviceCode: 'This provider does not offer device-code login',
  unsafeVerificationUrl: 'Provider returned an unsafe verification URL',
  initializationFailed: 'Subscription manager initialization failed',
} as const;

type SafeErrorCode =
  | 'unsupportedProvider'
  | 'unsupportedPrompt'
  | 'unavailableDeviceCode'
  | 'unsafeVerificationUrl'
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

function publishStatus(connected: boolean): void {
  setMeta(STATUS_META_KEY, JSON.stringify({ connected, updatedAt: new Date().toISOString() }));
}

function selectDeviceCode(prompt: AuthPrompt): Promise<string> {
  if (prompt.type !== 'select') {
    return Promise.reject(new SafeSubscriptionError('unsupportedPrompt'));
  }
  const option = prompt.options.find((candidate) => candidate.id === 'device_code');
  if (!option) return Promise.reject(new SafeSubscriptionError('unavailableDeviceCode'));
  return Promise.resolve(option.id);
}

function onAuthEvent(jobId: string, event: AuthEvent): void {
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
  try {
    if (job.provider !== OPENAI_PROVIDER) {
      throw new SafeSubscriptionError('unsupportedProvider');
    }
    if (job.action === 'logout') {
      await runtime.logout(job.provider, { signal });
      publishStatus(false);
      finishSubscriptionJob(job.id, true, 'Disconnected');
      return;
    }

    await runtime.login(job.provider, 'oauth', {
      signal,
      prompt: selectDeviceCode,
      notify: (event) => onAuthEvent(job.id, event),
    });
    publishStatus(true);
    finishSubscriptionJob(job.id, true, 'Connected');
  } catch (error: unknown) {
    const message = signal.aborted
      ? PUBLIC_STATUS.cancelled
      : error instanceof SafeSubscriptionError
        ? PUBLIC_STATUS[error.code]
        : PUBLIC_STATUS.failed;
    finishSubscriptionJob(job.id, false, message);
    if (!signal.aborted) logger.warn({ err: message, provider: job.provider }, PUBLIC_STATUS.failed);
  }
}

async function publishInitialStatus(runtime: SubscriptionRuntime): Promise<void> {
  try {
    publishStatus(Boolean(await runtime.checkAuth?.(OPENAI_PROVIDER)));
  } catch {
    logger.warn({ err: 'Subscription status unavailable' }, 'Could not read OpenAI subscription status');
  }
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
    activeController = new AbortController();
    const current = getModelRuntime()
      .then((runtime) => runSubscriptionJob(job, runtime, activeController!.signal))
      .finally(() => {
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
