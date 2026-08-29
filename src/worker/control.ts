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
import {
  appendWebEvent,
  claimPendingControls,
  finishControl,
  getChannel,
  recoverStuckControls,
  touchControlProcessing,
} from '../db.js';
import { runCommand } from '../commands/index.js';

const CONTROL_POLL_MS = 250;

let running = false;
let timer: NodeJS.Timeout | undefined;

export function startControlLoop(): void {
  if (running) return;
  const recovered = recoverStuckControls();
  if (recovered > 0) logger.warn({ count: recovered }, 'Failed controls left by worker restart');
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
      // A previously claimed row may have been re-keyed while waiting behind a
      // long control. Refresh both its heartbeat and immutable session owner
      // before execution instead of trusting the batch's stale web:life JID.
      const owned = touchControlProcessing(row.rowid);
      if (!owned) continue;
      const channel = getChannel(owned.channel_jid);
      if (!channel) {
        finishControl(owned.rowid, false, 'Session no longer exists');
        continue;
      }

      let args: Record<string, string> = {};
      try {
        args = JSON.parse(owned.args || '{}');
      } catch {
        // A malformed args blob shouldn't wedge the queue — run with none and
        // let the command report its own missing-argument error.
        logger.warn({ rowid: owned.rowid, args: owned.args }, 'control: bad args JSON');
      }

      let ownershipValid = true;
      const renewOwnership = (): boolean => {
        if (!ownershipValid) return false;
        try {
          const current = touchControlProcessing(
            owned.rowid,
            owned.channel_jid,
            channel.folder,
          );
          if (current) return true;
        } catch (err: any) {
          logger.warn({ err: err.message, rowid: owned.rowid }, 'control: heartbeat failed');
        }
        ownershipValid = false;
        logger.warn(
          { rowid: owned.rowid, jid: owned.channel_jid },
          'Control ownership expired; fencing stale result',
        );
        return false;
      };

      const heartbeat = setInterval(renewOwnership, 60_000);
      heartbeat.unref?.();

      let result;
      try {
        result = await runCommand(channel, owned.command, args, {
          assertOwnership: () => {
            if (!renewOwnership()) throw new Error('Control ownership expired');
          },
        });
      } finally {
        clearInterval(heartbeat);
      }
      if (!renewOwnership()) continue;

      // Auto-issued controls (e.g. the `pi new` fired when a session is created)
      // pass silent:true — the user did not type them, so echoing their output
      // would just be noise. Failures are still surfaced.
      const silent = args.silent === 'true' && result.ok;
      if (!silent) {
        appendWebEvent({
          channelJid: owned.channel_jid,
          kind: result.ok ? 'system' : 'error',
          role: owned.command,
          content: result.text,
        });
      }
      finishControl(owned.rowid, result.ok, result.text);

      logger.info(
        { jid: owned.channel_jid, command: owned.command, ok: result.ok },
        'Control command executed',
      );
    }
  } catch (err: any) {
    logger.error({ err: err.message }, 'Control loop error');
  } finally {
    schedule();
  }
}
