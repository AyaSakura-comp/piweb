import type { AuthEvent, AuthPrompt } from '@earendil-works/pi-ai';
import { CredentialSynchronizationError, type ModelRuntime } from '@earendil-works/pi-coding-agent';
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
import { AGY_PROVIDER, listAgyModels } from '../agent/agy.js';
import { agySubscriptionRuntime } from '../agy-login.js';
import { CLAUDE_PROVIDER, claudeSubscriptionRuntime } from '../claude-login.js';
import { type CodeLoginInteraction, PublicLoginError } from '../subscription-login.js';
import { logger } from '../logger.js';

const SUBSCRIPTION_POLL_MS = 500;
// Sign-ins made outside Settings (pi /login, agy in a terminal) or tokens that
// went away show up on the card within this long.
const STATUS_REFRESH_MS = 30_000;
// How long a browser-link login (Claude) waits for the pasted code.
const MANUAL_CODE_TIMEOUT_MS = 10 * 60_000;
// Hosts a provider's authorization link may point at.
const AUTH_URL_HOSTS: Record<string, readonly string[]> = {
  anthropic: ['claude.ai', 'claude.com', 'console.anthropic.com', 'platform.claude.com'],
  agy: ['accounts.google.com'],
};
const statusMetaKey = (provider: string) => `subscription.${provider}`;
const PUBLIC_STATUS = {
  connecting: 'Connecting to provider',
  failed: 'Subscription operation failed',
  logoutFailed: 'Could not disconnect; try again',
  cancelled: 'Subscription operation cancelled',
  unsupportedProvider: 'Unsupported subscription provider',
  unsupportedPrompt: 'Device login prompt is unsupported',
  unavailableDeviceCode: 'This provider does not offer device-code login',
  unsafeVerificationUrl: 'Provider returned an unsafe verification URL',
  codeTimedOut: 'Timed out waiting for the authorization code; connect again for a new link',
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
  login(providerId: string, type: 'oauth', interaction: CodeLoginInteraction): Promise<unknown>;
  logout(providerId: string, options?: { signal?: AbortSignal }): Promise<void>;
  checkAuth?(providerId: string, options?: { signal?: AbortSignal }): Promise<unknown>;
}

let running = false;
let timer: NodeJS.Timeout | undefined;
let active: Promise<void> | undefined;
let activeController: AbortController | undefined;
let lastStatusRefresh = 0;
const publishedStatus = new Map<string, boolean>();

function publishStatus(provider: string, connected: boolean): void {
  publishedStatus.set(provider, connected);
  setMeta(
    statusMetaKey(provider),
    JSON.stringify({ connected, updatedAt: new Date().toISOString() }),
  );
}

/**
 * A subscription counts as connected only through a sign-in: pi's check also
 * answers for an API key in the environment, which is not a subscription.
 */
function isSubscriptionAuth(check: unknown): boolean {
  if (check && typeof check === 'object' && 'type' in check) {
    return (check as { type?: unknown }).type === 'oauth';
  }
  return Boolean(check);
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

    try {
      await runtime.login(job.provider, 'oauth', {
        signal,
        prompt: promptFor(job.id, signal, flow),
        notify: (event) => onAuthEvent(job, event),
        // The sign-in keeps waiting; Settings shows why the last code failed.
        rejectCode: (message) => updateSubscriptionJobMessage(job.id, message),
      });
    } catch (error: unknown) {
      // pi stored the credential and only failed to reload its model list;
      // the sign-in itself succeeded and the next refresh catches up.
      if (!(error instanceof CredentialSynchronizationError) || signal.aborted) throw error;
      logger.warn({ provider: job.provider }, 'Signed in, but pi could not reload the provider');
    }
    publishStatus(job.provider, true);
    finishSubscriptionJob(job.id, true, 'Connected');
  } catch (error: unknown) {
    // A pasted code that reached the token exchange and failed there is the
    // usual way a pi-run login goes wrong (wrong/expired/truncated code).
    const message = signal.aborted
      ? PUBLIC_STATUS.cancelled
      : error instanceof SafeSubscriptionError
        ? PUBLIC_STATUS[error.code]
        : error instanceof PublicLoginError
          ? error.message
          : job.action === 'logout'
            ? PUBLIC_STATUS.logoutFailed
            : flow.codeTaken
              ? PUBLIC_STATUS.codeRejected
              : PUBLIC_STATUS.failed;
    finishSubscriptionJob(job.id, false, message);
    // Upstream errors can quote tokens or response bodies: log only their kind.
    if (!signal.aborted) {
      logger.warn(
        { err: message, kind: (error as Error)?.name ?? typeof error, provider: job.provider },
        PUBLIC_STATUS.failed,
      );
    }
  }
}

// agy is not a pi provider; Piweb signs it in itself, then refetches its
// model list so the picker has agy's models without waiting out the cache.
// Claude is pi's, but Piweb runs its sign-in so the phone gets a code page
// instead of pi's localhost redirect (src/claude-login.ts).
function routeRuntime(pi: ModelRuntime | SubscriptionRuntime): SubscriptionRuntime {
  const claude = claudeSubscriptionRuntime(pi as ModelRuntime);
  const pick = (provider: string): SubscriptionRuntime =>
    provider === AGY_PROVIDER ? agySubscriptionRuntime : provider === CLAUDE_PROVIDER ? claude : pi;
  return {
    login: async (provider, type, interaction) => {
      const credential = await pick(provider).login(provider, type, interaction);
      if (provider === AGY_PROVIDER) void listAgyModels({ forceRefresh: true }).catch(() => undefined);
      return credential;
    },
    logout: (provider, options) => pick(provider).logout(provider, options),
    checkAuth: async (provider, options) => pick(provider).checkAuth?.(provider, options),
  };
}

/** Publish every provider's status; `changedOnly` skips rewriting unchanged ones. */
async function publishAllStatus(runtime: SubscriptionRuntime, changedOnly = false): Promise<void> {
  lastStatusRefresh = Date.now();
  for (const provider of SUBSCRIPTION_PROVIDERS) {
    try {
      const connected = isSubscriptionAuth(await runtime.checkAuth?.(provider));
      if (!changedOnly || publishedStatus.get(provider) !== connected) {
        publishStatus(provider, connected);
      }
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
      if (Date.now() - lastStatusRefresh >= STATUS_REFRESH_MS) {
        const refresh = getModelRuntime()
          .then((runtime) => publishAllStatus(routeRuntime(runtime), true))
          .catch(() => undefined)
          .finally(() => {
            if (active === refresh) active = undefined;
            schedule();
          });
        active = refresh;
        return;
      }
      schedule();
      return;
    }
    const controller = new AbortController();
    activeController = controller;
    const unwatch = watchForCancel(job.id, controller);
    const current = getModelRuntime()
      .then((runtime) => runSubscriptionJob(job, routeRuntime(runtime), controller.signal))
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
    await publishAllStatus(routeRuntime(runtime));
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
