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

import { copyFile, mkdir } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { mediaDirName, mediaFileName, mediaUrl } from '../media-path.js';
import { logger } from '../logger.js';
import { appendWebEvent, setChannelBusy } from '../db.js';
import type { Transport } from './index.js';

function truncate(s: string, cap: number): string {
  if (s.length <= cap) return s;
  return s.slice(0, cap - 3) + '...';
}

function summarizeToolArgs(args: unknown): string {
  if (args == null) return '';
  if (typeof args === 'string') return args.replace(/\s+/g, ' ').slice(0, 300);
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
async function publishFile(jid: string, filePath: string): Promise<string | undefined> {
  try {
    const channelDir = join(config.webMediaDir, mediaDirName(jid));
    await mkdir(channelDir, { recursive: true });
    // Keep the extension (the browser sniffs images by it) but prefix a UUID so
    // two runs writing "chart.png" don't clobber each other.
    const safeName =
      mediaFileName(randomUUID().slice(0, 8), basename(filePath)) || `file${extname(filePath)}`;
    await copyFile(filePath, join(channelDir, safeName));
    return mediaUrl(jid, safeName);
  } catch (err: any) {
    logger.warn({ err: err.message, filePath, jid }, 'web transport: failed to publish file');
    return undefined;
  }
}

export const webTransport: Transport = {
  async sendResponse(jid: string, text: string): Promise<boolean> {
    const body = text?.trim();
    if (!body) return true;
    appendWebEvent({ channelJid: jid, kind: 'message', role: 'assistant', content: body });
    return true;
  },

  async sendFilesResponse(jid: string, text: string, files: string[]): Promise<boolean> {
    const urls: string[] = [];
    for (const file of files) {
      const url = await publishFile(jid, file);
      if (url) urls.push(url);
    }

    appendWebEvent({
      channelJid: jid,
      kind: 'message',
      role: 'assistant',
      content: text?.trim() ?? '',
      files: urls,
    });
    return true;
  },

  async sendNotice(jid: string, text: string): Promise<void> {
    appendWebEvent({ channelJid: jid, kind: 'system', role: 'interrupt', content: text });
  },

  async setTyping(jid: string): Promise<void> {
    setChannelBusy(jid, true);
  },

  async clearTyping(jid: string): Promise<void> {
    setChannelBusy(jid, false);
  },

  createEventStreamer(jid: string): (event: any) => Promise<void> {
    return async (event: any) => {
      if (!event || typeof event !== 'object') return;

      // Thinking blocks: fire on `_end` only, so one bubble per block rather
      // than one per token.
      if (
        config.streamThinking &&
        event.type === 'message_update' &&
        event.assistantMessageEvent?.type === 'thinking_end'
      ) {
        const text = String(event.assistantMessageEvent.content ?? '').trim();
        if (text) {
          appendWebEvent({
            channelJid: jid,
            kind: 'thinking',
            content: truncate(text, config.maxEventChars),
          });
        }
        return;
      }

      // Tool calls. pi-ai's event type is `toolcall_end` (one word).
      if (
        config.streamTools &&
        event.type === 'message_update' &&
        event.assistantMessageEvent?.type === 'toolcall_end'
      ) {
        const tc = event.assistantMessageEvent.toolCall ?? {};
        appendWebEvent({
          channelJid: jid,
          kind: 'tool',
          role: tc.name || 'tool',
          content: truncate(summarizeToolArgs(tc.arguments), config.maxEventChars),
        });
        return;
      }

      // Tool results arrive as their own role=tool message after the call.
      if (config.streamTools && event.type === 'message_end' && event.message?.role === 'tool') {
        const parts = event.message.content ?? [];
        const text = parts
          .map((c: any) => {
            if (typeof c?.content === 'string') return c.content;
            if (Array.isArray(c?.content)) return c.content.map((p: any) => p?.text ?? '').join('\n');
            return c?.text ?? '';
          })
          .join('\n')
          .trim();
        if (text) {
          appendWebEvent({
            channelJid: jid,
            kind: 'tool_result',
            content: truncate(text, config.maxEventChars),
          });
        }
        return;
      }
    };
  },
};
