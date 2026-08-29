/**
 * Transport abstraction.
 *
 * piscord's queue called into `discord/client.js` directly. piweb keeps the
 * same four operations but lets the delivery target be swapped, so the agent
 * core has no idea whether it is talking to Discord or a browser.
 *
 * The worker installs a transport at startup; `getTransport()` throws rather
 * than silently dropping an agent reply if one was never installed.
 */

export interface ChannelWriteFence {
  /** Opaque persisted channel generation; stale workers must not write through a reused JID. */
  expectedFolder?: string;
}

export interface Transport {
  /** Deliver assistant text. Returns false if it could not be delivered. */
  sendResponse(jid: string, text: string, fence?: ChannelWriteFence): Promise<boolean>;
  /** Deliver assistant text plus generated files (outbox markers). */
  sendFilesResponse(
    jid: string,
    text: string,
    files: string[],
    fence?: ChannelWriteFence,
  ): Promise<boolean>;
  /** A short system notice in the transcript (e.g. "interrupted"). Optional. */
  sendNotice?(jid: string, text: string, fence?: ChannelWriteFence): Promise<void>;
  /** Show/refresh a "working" indicator for the channel. */
  setTyping(jid: string, fence?: ChannelWriteFence): Promise<void>;
  /** Clear the working indicator. */
  clearTyping(jid: string, fence?: ChannelWriteFence): Promise<void>;
  /** Build the per-run handler for pi's intermediate events (thinking/tools). */
  createEventStreamer(
    jid: string,
    fence?: ChannelWriteFence,
  ): (event: unknown) => Promise<void>;
}

let active: Transport | undefined;

export function setTransport(transport: Transport): void {
  active = transport;
}

export function getTransport(): Transport {
  if (!active) {
    throw new Error('No transport installed — call setTransport() during startup');
  }
  return active;
}
