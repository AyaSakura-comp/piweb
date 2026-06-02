/**
 * Live-stream pi's intermediate session events into a Discord channel.
 *
 * pi emits a JSON event per line in `--mode json` — thinking blocks, tool
 * calls, tool results, turn boundaries. We forward the human-interesting ones
 * (gated by config) as separate Discord messages so the user can watch the
 * agent's reasoning and actions in real time inside its auto-thread.
 *
 * The FINAL assistant text is NOT streamed from here — it flows through the
 * caller's existing outbox/marker path so attachments keep working.
 */

import { config } from '../config.js';
import { logger } from '../logger.js';
import { sendResponse } from './client.js';

/** Discord caps a single message at 2000 chars. We leave headroom for the prefix. */
function truncate(s: string, cap: number): string {
  if (s.length <= cap) return s;
  return s.slice(0, cap - 3) + '...';
}

/** Tag-pretty a tool argument summary; values get squashed to one line. */
function summarizeToolArgs(args: unknown): string {
  if (args == null) return '';
  if (typeof args === 'string') return args.replace(/\s+/g, ' ').slice(0, 200);
  try {
    const s = JSON.stringify(args);
    return s.length > 200 ? s.slice(0, 197) + '...' : s;
  } catch {
    return String(args).slice(0, 200);
  }
}

/**
 * Build a per-jid event handler. The returned function is meant to be passed
 * to `invokeAgent` as `onEvent`. It is async-but-fire-and-forget on Discord
 * sends so it never back-pressures pi.
 */
export function createEventStreamer(jid: string): (event: any) => Promise<void> {
  // Serialize Discord sends per channel so messages arrive in event order
  // even when pi emits faster than the Discord API can accept.
  let pending: Promise<void> = Promise.resolve();
  const enqueueSend = (text: string) => {
    pending = pending
      .then(() => sendResponse(jid, text).then(() => undefined))
      .catch((err) =>
        logger.warn({ err: err?.message, jid }, 'stream-events: send failed'),
      );
    return pending;
  };

  return async (event: any) => {
    if (!event || typeof event !== 'object') return;

    // ── Thinking blocks ─────────────────────────────────────────────────
    // Each turn's thinking arrives as `*_start` / `*_delta` / `*_end`. We
    // fire only on `_end` (one Discord message per thinking block, not per
    // token), using the authoritative `content` field on the end event.
    if (
      config.streamThinking &&
      event.type === 'message_update' &&
      event.assistantMessageEvent?.type === 'thinking_end'
    ) {
      const text = String(event.assistantMessageEvent.content ?? '').trim();
      if (text) {
        const body = truncate(text, config.maxEventChars - 50);
        // Discord quote-block formatting: each line gets `> ` so it renders
        // as an indented gray block.
        const quoted = body
          .split('\n')
          .map((l) => `> ${l}`)
          .join('\n');
        enqueueSend(`💭 *Thinking:*\n${quoted}`);
      }
      return;
    }

    // ── Tool calls (when the assistant decides to invoke a tool) ────────
    // pi-ai's actual event type is `toolcall_end` (single word, not
    // `tool_call_end`). The end event carries the fully resolved ToolCall
    // object: `{ id, name, arguments, ... }`.
    if (
      config.streamTools &&
      event.type === 'message_update' &&
      event.assistantMessageEvent?.type === 'toolcall_end'
    ) {
      const tc = event.assistantMessageEvent.toolCall ?? {};
      const name = tc.name || 'tool';
      const argSummary = summarizeToolArgs(tc.arguments);
      const body = argSummary ? `\`${name}\` ${argSummary}` : `\`${name}\``;
      enqueueSend(truncate(`🔧 ${body}`, config.maxEventChars));
      return;
    }

    // ── Tool results — arrive as their own message (role=tool) after the
    // assistant's toolcall completes. Each content block is a ToolResult
    // referencing the originating tool by id; we forward the textual output.
    if (
      config.streamTools &&
      event.type === 'message_end' &&
      event.message?.role === 'tool'
    ) {
      const parts = event.message.content ?? [];
      const text = parts
        .map((c: any) => {
          // ToolResult content can be a string, an array of TextContent, or
          // an object with `.text` — be defensive.
          if (typeof c?.content === 'string') return c.content;
          if (Array.isArray(c?.content))
            return c.content.map((p: any) => p?.text ?? '').join('\n');
          return c?.text ?? '';
        })
        .join('\n')
        .trim();
      if (text) {
        enqueueSend(truncate(`📤 ${text}`, config.maxEventChars));
      }
      return;
    }

    // Everything else (session header, agent_start/end, turn_*, text_*,
    // message_start/end, deltas, …) we intentionally don't surface — text
    // is delivered by the caller's normal final-response path; the rest is
    // bookkeeping. Log at debug for future expansion.
    if (event.type) {
      logger.debug({ jid, type: event.type, sub: event.assistantMessageEvent?.type }, 'stream-events: unhandled');
    }
  };
}
