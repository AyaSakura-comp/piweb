/**
 * Web transport — delivers agent output into SQLite instead of Discord.
 *
 * The web server is a different process (and in the default deployment, a
 * different container) from the worker that runs pi, so "sending" here means
 * appending a row the web server can tail by rowid and push over SSE. That
 * indirection buys two things Discord gave us for free: the transcript is
 * durable, and a phone that slept through a long run replays it on reconnect
 * instead of losing it.
 *
 * Unlike the Discord transport there is no 2000-char message cap, so agent
 * replies are stored whole; only streamed intermediate events are truncated
 * (config.maxEventChars) to keep a chatty tool loop from flooding the UI.
 */

import { copyFile, mkdir, rm } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { mediaDirName, mediaFileName, mediaUrl } from '../media-path.js';
import { logger } from '../logger.js';
import {
  appendWebEvent,
  clearLiveOutput,
  isChannelGenerationCurrent,
  isChannelQuarantinedForLifeArchive,
  setChannelBusy,
  setLiveOutput,
  type WebEventKind,
} from '../db.js';
import type { ChannelWriteFence, Transport } from './index.js';

function truncate(s: string, cap: number): string {
  if (s.length <= cap) return s;
  return s.slice(0, cap - 3) + '...';
}

function summarizeToolArgs(args: unknown): string {
  if (args == null) return '';
  if (typeof args === 'string') return args.replace(/\s+/g, ' ').slice(0, 300);
  if (typeof args === 'object' && args !== null) {
    const obj = args as Record<string, any>;
    if (typeof obj.command === 'string' && obj.command.trim()) {
      return `$ ${obj.command.trim()}`;
    }
    if (typeof obj.CommandLine === 'string' && obj.CommandLine.trim()) {
      return `$ ${obj.CommandLine.trim()}`;
    }
    if (typeof obj.AbsolutePath === 'string' && obj.AbsolutePath.trim()) {
      return obj.AbsolutePath.trim();
    }
    if (typeof obj.TargetFile === 'string' && obj.TargetFile.trim()) {
      return obj.TargetFile.trim();
    }
    if (typeof obj.query === 'string' && obj.query.trim()) {
      return `"${obj.query.trim()}"`;
    }
  }
  try {
    const s = JSON.stringify(args);
    return s.length > 300 ? s.slice(0, 297) + '...' : s;
  } catch {
    return String(args).slice(0, 300);
  }
}

/**
 * Copy an agent-produced file into the web media directory and return the URL
 * the browser should load. Files live anywhere on the host (pi writes wherever
 * it likes); the web server only serves this one directory, so the file has to
 * be copied in rather than linked to.
 */
async function publishFile(
  jid: string,
  filePath: string,
  fence?: ChannelWriteFence,
): Promise<string | undefined> {
  try {
    // A stale worker must not create the archived destination while recovery
    // still needs to rename the old Life media directory into that path.
    if (
      isChannelQuarantinedForLifeArchive(jid) ||
      (fence?.expectedFolder &&
        !isChannelGenerationCurrent(
          jid,
          fence.expectedFolder,
          fence.expectedStorageToken,
          fence.expectedOwnershipEpoch,
        ))
    )
      return undefined;
    const channelDir = join(config.webMediaDir, mediaDirName(jid));
    await mkdir(channelDir, { recursive: true });
    // Keep the extension (the browser sniffs images by it) but prefix a UUID so
    // two runs writing "chart.png" don't clobber each other.
    const safeName =
      mediaFileName(randomUUID().slice(0, 8), basename(filePath)) || `file${extname(filePath)}`;
    const publishedPath = join(channelDir, safeName);
    await copyFile(filePath, publishedPath);
    if (
      fence?.expectedFolder &&
      !isChannelGenerationCurrent(
        jid,
        fence.expectedFolder,
        fence.expectedStorageToken,
        fence.expectedOwnershipEpoch,
      )
    ) {
      await rm(publishedPath, { force: true });
      return undefined;
    }
    return mediaUrl(jid, safeName);
  } catch (err: any) {
    logger.warn({ err: err.message, filePath, jid }, 'web transport: failed to publish file');
    return undefined;
  }
}

/**
 * Streaming reply buffer.
 *
 * pi emits one `text_delta` per token — hundreds per reply — so the DB write is
 * throttled rather than done per delta. The buffer lives in memory and is
 * mirrored into `live_output` at most every FLUSH_MS; the SSE loop polls that
 * row, so the phone sees the answer grow instead of waiting for the whole turn.
 */
const FLUSH_MS = 150;

interface LiveBuffer {
  /** The answer being written. */
  text: string;
  /** The reasoning being written before it, its own lane. */
  thinking: string;
  written: string;
  fence?: ChannelWriteFence;
  timer?: NodeJS.Timeout;
}

function snapshot(buf: LiveBuffer): string {
  return `${buf.thinking}\u0000${buf.text}`;
}

const liveBuffers = new Map<string, LiveBuffer>();

function liveBufferKey(jid: string, fence?: ChannelWriteFence): string {
  return `${jid}\u0000${fence?.expectedFolder ?? ''}\u0000${fence?.expectedStorageToken ?? ''}\u0000${fence?.expectedOwnershipEpoch ?? ''}`;
}

function writeEvent(
  event: {
    channelJid: string;
    kind: WebEventKind;
    role?: string;
    content?: string;
    files?: string[];
  },
  fence?: ChannelWriteFence,
): boolean {
  try {
    appendWebEvent(event, fence);
    return true;
  } catch (err: any) {
    logger.warn({ err: err.message, jid: event.channelJid }, 'Fenced web event was not written');
    return false;
  }
}

function flushLive(jid: string, done = false, fence?: ChannelWriteFence): void {
  const key = liveBufferKey(jid, fence);
  const buf = liveBuffers.get(key);
  if (!buf) {
    // `done` with no buffer still has to clear a row left by an aborted turn.
    if (done) {
      try {
        clearLiveOutput(jid, fence);
      } catch (err: any) {
        logger.warn({ err: err.message, jid }, 'Failed to clear live output');
      }
    }
    return;
  }

  if (buf.timer) clearTimeout(buf.timer);
  liveBuffers.delete(key);

  try {
    if (done) clearLiveOutput(jid, fence);
    else if (snapshot(buf) !== buf.written) {
      setLiveOutput(jid, { content: buf.text, thinking: buf.thinking }, fence);
    }
  } catch (err: any) {
    logger.warn({ err: err.message, jid }, 'Failed to publish live output');
  }
}

function appendLive(
  jid: string,
  delta: string,
  lane: 'text' | 'thinking' = 'text',
  fence?: ChannelWriteFence,
): void {
  if (!delta) return;
  const key = liveBufferKey(jid, fence);
  let buf = liveBuffers.get(key);
  if (!buf) {
    buf = { text: '', thinking: '', written: '', fence };
    liveBuffers.set(key, buf);
  }
  buf[lane] += delta;
  if (buf.timer) return;

  buf.timer = setTimeout(() => {
    const current = liveBuffers.get(key);
    if (!current) return;
    current.timer = undefined;
    const snap = snapshot(current);
    if (snap === current.written) return;
    try {
      setLiveOutput(jid, { content: current.text, thinking: current.thinking }, current.fence);
      current.written = snap;
    } catch (err: any) {
      logger.warn({ err: err.message, jid }, 'Failed to publish live output');
    }
  }, FLUSH_MS);
  buf.timer.unref?.();
}

export const webTransport: Transport = {
  async sendResponse(jid: string, text: string, fence?: ChannelWriteFence): Promise<boolean> {
    // The finished message replaces the streaming preview; clear it first so a
    // poll landing between the two can never show the reply twice.
    flushLive(jid, true, fence);
    const body = text?.trim();
    if (!body) return true;
    return writeEvent(
      { channelJid: jid, kind: 'message', role: 'assistant', content: body },
      fence,
    );
  },

  async sendFilesResponse(
    jid: string,
    text: string,
    files: string[],
    fence?: ChannelWriteFence,
  ): Promise<boolean> {
    flushLive(jid, true, fence);
    const urls: string[] = [];
    for (const file of files) {
      const url = await publishFile(jid, file, fence);
      if (url) urls.push(url);
    }

    return writeEvent(
      {
        channelJid: jid,
        kind: 'message',
        role: 'assistant',
        content: text?.trim() ?? '',
        files: urls,
      },
      fence,
    );
  },

  async sendNotice(jid: string, text: string, fence?: ChannelWriteFence): Promise<void> {
    writeEvent({ channelJid: jid, kind: 'system', role: 'interrupt', content: text }, fence);
  },

  async setTyping(jid: string, fence?: ChannelWriteFence): Promise<void> {
    try {
      setChannelBusy(jid, true, fence);
    } catch {
      // A stale worker is fenced after Life rotates; the replacement owns busy.
    }
  },

  async clearTyping(jid: string, fence?: ChannelWriteFence): Promise<void> {
    // Final worker cleanup owns the old channel generation until this returns.
    // Cancel any throttled flush before clearing busy; otherwise its timer could
    // recreate live_output after Life has been archived and replaced.
    flushLive(jid, true, fence);
    try {
      setChannelBusy(jid, false, fence);
    } catch {
      // The old generation no longer owns this reused JID.
    }
  },

  createEventStreamer(jid: string, fence?: ChannelWriteFence): (event: any) => Promise<void> {
    return async (event: any) => {
      if (!event || typeof event !== 'object') return;
      if (
        fence?.expectedFolder &&
        !isChannelGenerationCurrent(
          jid,
          fence.expectedFolder,
          fence.expectedStorageToken,
          fence.expectedOwnershipEpoch,
        )
      )
        return;

      // Assistant text, token by token. Buffered and throttled by appendLive;
      // the finished message still arrives through sendResponse, which clears
      // the preview so the reply never appears twice.
      if (
        config.streamPartialText &&
        event.type === 'message_update' &&
        event.assistantMessageEvent?.type === 'text_delta'
      ) {
        appendLive(jid, String(event.assistantMessageEvent.delta ?? ''), 'text', fence);
        return;
      }

      // Reasoning, token by token, on its own lane. The finished block still
      // arrives as a `thinking` row below, so the lane is emptied on
      // thinking_end to stop the preview and the real block both showing.
      if (
        config.streamPartialText &&
        config.streamThinking &&
        event.type === 'message_update' &&
        event.assistantMessageEvent?.type === 'thinking_delta'
      ) {
        appendLive(jid, String(event.assistantMessageEvent.delta ?? ''), 'thinking', fence);
        return;
      }

      // A turn that ends without a reply (aborted, error, empty) must not leave
      // half a sentence frozen on screen.
      if (event.type === 'turn_end' || event.type === 'agent_end') {
        flushLive(jid, true, fence);
        return;
      }

      // Thinking blocks: fire on `_end` only, so one bubble per block rather
      // than one per token.
      if (
        config.streamThinking &&
        event.type === 'message_update' &&
        event.assistantMessageEvent?.type === 'thinking_end'
      ) {
        const buf = liveBuffers.get(liveBufferKey(jid, fence));
        if (buf) {
          buf.thinking = '';
          try {
            setLiveOutput(jid, { content: buf.text, thinking: '' }, fence);
            buf.written = snapshot(buf);
          } catch {
            /* the next flush will retry */
          }
        }

        const text = String(event.assistantMessageEvent.content ?? '').trim();
        if (text) {
          writeEvent(
            {
              channelJid: jid,
              kind: 'thinking',
              content: truncate(text, config.maxEventChars),
            },
            fence,
          );
        }
        return;
      }

      // Tool calls. pi-ai's event type is `toolcall_end` (one word).
      if (
        config.streamTools &&
        event.type === 'message_update' &&
        event.assistantMessageEvent?.type === 'toolcall_end'
      ) {
        // Text followed by a tool call is intermediate narration, not the final
        // answer. Fold it into thinking and clear the answer lane before the
        // tool row lands; otherwise it stays behind as a stray assistant bubble
        // throughout the rest of the tool loop.
        const buf = liveBuffers.get(liveBufferKey(jid, fence));
        const narration = buf?.text.trim() ?? '';
        if (buf && narration) {
          if (config.streamThinking) {
            writeEvent(
              {
                channelJid: jid,
                kind: 'thinking',
                content: truncate(narration, config.maxEventChars),
              },
              fence,
            );
          }
          buf.text = '';
          try {
            setLiveOutput(jid, { content: '', thinking: buf.thinking }, fence);
            buf.written = snapshot(buf);
          } catch {
            /* the next flush will retry */
          }
        }

        const tc = event.assistantMessageEvent.toolCall ?? {};
        writeEvent(
          {
            channelJid: jid,
            kind: 'tool',
            role: tc.name || 'tool',
            content: truncate(summarizeToolArgs(tc.arguments), config.maxEventChars),
          },
          fence,
        );
        return;
      }

      // Context compaction. pi compacts on its own once the context approaches
      // the model's window (settings.compaction in ~/.pi/agent/settings.json),
      // replacing older turns with a summary. Without this the only visible
      // trace is the context number in /pi status suddenly dropping — or, if you
      // look at the wrong moment, a reading above 100%. `tokensBefore` is the
      // size it compacted away from; pi reports no "after", so don't invent one.
      if (event.type === 'compaction_end' && event.result && !event.aborted) {
        const before = Number(event.result.tokensBefore ?? 0);
        const reason = event.reason === 'overflow' ? 'context overflowed' : 'context threshold';
        writeEvent(
          {
            channelJid: jid,
            kind: 'system',
            role: 'compacted',
            // No leading emoji: the row already renders as "ⓘ compacted", and the
            // obvious pick (🗜) has no glyph in the UI font and shows as tofu.
            content:
              `Compacted the context (${reason}) — ${before.toLocaleString('en-US')} tokens ` +
              `summarised. Older turns are now a summary; recent ones were kept, and pi ` +
              `continues in the same session.`,
          },
          fence,
        );
        return;
      }

      // Tool results arrive as their own role=tool message after the call.
      if (config.streamTools && event.type === 'message_end' && event.message?.role === 'tool') {
        const parts = event.message.content ?? [];
        const text = parts
          .map((c: any) => {
            if (typeof c?.content === 'string') return c.content;
            if (Array.isArray(c?.content))
              return c.content.map((p: any) => p?.text ?? '').join('\n');
            return c?.text ?? '';
          })
          .join('\n')
          .trim();
        if (text) {
          writeEvent(
            {
              channelJid: jid,
              kind: 'tool_result',
              content: truncate(text, config.maxEventChars),
            },
            fence,
          );
        }
        return;
      }
    };
  },
};
