/**
 * Control-queue loop — the worker half of the web command path.
 *
 * The web server can't execute commands itself (see src/commands/index.ts), so
 * it writes an intent row and this loop drains it. Results are appended to the
 * channel transcript as a `system` event, which means command output reaches
 * the phone over the same SSE stream as everything else — no separate polling
 * path, and it survives a reconnect like any other message.
 *
 * Polled faster than the message queue: a settings tweak should feel instant,
 * whereas a message is about to spend seconds inside pi anyway.
 */

import { logger } from '../logger.js';
import { appendWebEvent, claimPendingControls, finishControl, getChannel } from '../db.js';
import { runCommand } from '../commands/index.js';

const CONTROL_POLL_MS = 250;

let running = false;
let timer: NodeJS.Timeout | undefined;

export function startControlLoop(): void {
  if (running) return;
  running = true;
  schedule(0);
}

export function stopControlLoop(): void {
  running = false;
  if (timer) {
    clearTimeout(timer);
    timer = undefined;
  }
}

function schedule(delayMs = CONTROL_POLL_MS): void {
  if (!running || timer) return;
  timer = setTimeout(() => {
    timer = undefined;
    void tick();
  }, delayMs);
}

async function tick(): Promise<void> {
  if (!running) return;

  try {
    const rows = claimPendingControls();
    for (const row of rows) {
      const channel = getChannel(row.channel_jid);
      if (!channel) {
        finishControl(row.rowid, false, 'Session no longer exists');
        continue;
      }

      let args: Record<string, string> = {};
      try {
        args = JSON.parse(row.args || '{}');
      } catch {
        // A malformed args blob shouldn't wedge the queue — run with none and
        // let the command report its own missing-argument error.
        logger.warn({ rowid: row.rowid, args: row.args }, 'control: bad args JSON');
      }

      const result = await runCommand(channel, row.command, args);

      // Auto-issued controls (e.g. the `pi new` fired when a session is created)
      // pass silent:true — the user did not type them, so echoing their output
      // would just be noise. Failures are still surfaced.
      const silent = args.silent === 'true' && result.ok;
      if (!silent) {
        appendWebEvent({
          channelJid: row.channel_jid,
          kind: result.ok ? 'system' : 'error',
          role: row.command,
          content: result.text,
        });
      }
      finishControl(row.rowid, result.ok, result.text);

      logger.info(
        { jid: row.channel_jid, command: row.command, ok: result.ok },
        'Control command executed',
      );
    }
  } catch (err: any) {
    logger.error({ err: err.message }, 'Control loop error');
  } finally {
    schedule();
  }
}
