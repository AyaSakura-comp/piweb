/**
 * What the browser-link sign-ins Piweb runs itself (Claude, agy) share: a
 * pasted code that fails for a reason the user can fix — a typo, an old link,
 * an expired code, a network blip — keeps the sign-in waiting for another
 * paste instead of ending it, and every failure carries a message that is
 * safe to show in Settings (never a token, code or upstream body).
 */
import type { AuthInteraction } from '@earendil-works/pi-ai';

/** Sign-in failure whose message is written for Settings and holds no secrets. */
export class PublicLoginError extends Error {
  constructor(
    message: string,
    /** The same sign-in link can still produce a code worth pasting. */
    readonly retryable = false,
  ) {
    super(message);
  }
}

export interface CodeLoginInteraction extends AuthInteraction {
  /** Show why the pasted code failed; the sign-in keeps waiting for another. */
  rejectCode?(message: string): void;
}

// After this many unusable codes the link itself is suspect; start over.
export const MAX_CODE_ATTEMPTS = 5;

/**
 * Prompt for the pasted code and hand it to `use`, prompting again while the
 * failure is retryable. Without `rejectCode` there is nowhere to say why, so
 * the first failure ends the sign-in.
 */
export async function withPastedCode<T>(
  interaction: CodeLoginInteraction,
  message: string,
  use: (pasted: string) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const pasted = await interaction.prompt({ type: 'manual_code', message });
    try {
      return await use(pasted);
    } catch (error: unknown) {
      const retry =
        error instanceof PublicLoginError &&
        error.retryable &&
        attempt < MAX_CODE_ATTEMPTS &&
        !interaction.signal?.aborted &&
        interaction.rejectCode;
      if (!retry) throw error;
      retry(error.message);
    }
  }
}

/**
 * Normalise what a phone pastes: surrounding whitespace, quotes, or a code the
 * clipboard split over lines.
 */
export function cleanPastedCode(input: string): string {
  return input
    .trim()
    .replace(/^["'`<«“‘]+|["'`>»”’.,;]+$/g, '')
    .replace(/\s+/g, '');
}

/** OAuth error codes are short snake_case words; anything else is withheld. */
export function oauthErrorCode(result: unknown): string | undefined {
  const value = (result as { error?: unknown } | null)?.error;
  return typeof value === 'string' && /^[a-z_]{1,64}$/.test(value) ? value : undefined;
}

/** A thrown fetch failure: aborted by the caller, timed out, or unreachable. */
export function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted) || (error as { name?: string })?.name === 'AbortError';
}

/**
 * Classify an OAuth token endpoint's refusal of a pasted code. `who` names the
 * provider in the message ("Claude", "Google").
 */
export function tokenEndpointError(
  who: string,
  status: number,
  result: unknown,
): PublicLoginError {
  const code = oauthErrorCode(result);
  if (code === 'invalid_grant' || status === 400 || status === 401) {
    return new PublicLoginError(
      `${who} did not accept that code — it may be mistyped, expired or already used. Open ${who} again and paste the new code.`,
      true,
    );
  }
  if (status === 429) {
    return new PublicLoginError(
      `${who} is limiting sign-in attempts. Wait a minute, then Submit again.`,
      true,
    );
  }
  if (status >= 500) {
    return new PublicLoginError(`${who} sign-in is having trouble (HTTP ${status}). Submit again shortly.`, true);
  }
  return new PublicLoginError(`${who} refused the sign-in (${code ?? `HTTP ${status}`}).`, true);
}

/** The token request never got an answer. */
export function unreachableError(who: string, timedOut: boolean): PublicLoginError {
  return new PublicLoginError(
    timedOut
      ? `${who} took too long to answer. Submit the same code again.`
      : `Could not reach ${who} from the host. Check its network, then Submit the same code again.`,
    true,
  );
}
