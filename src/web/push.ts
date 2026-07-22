/**
 * Web Push notifications.
 *
 * iOS only delivers Web Push to a site the user has added to the Home Screen
 * and launched from there — permission cannot even be requested in a normal
 * Safari tab. That is why the manifest and apple-touch-icons exist.
 *
 * This lives in the web tier rather than the worker because the web tier holds
 * the subscriptions and is the half with a reason to reach the public internet.
 * It tails web_events from a persisted cursor, so a notification is sent once
 * per reply regardless of whether anyone had the page open.
 */

import webpush from 'web-push';
import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  countPushSubscriptions,
  deletePushSubscription,
  getMaxWebEventRowid,
  getMeta,
  getNotifiableEventsSince,
  listPushSubscriptions,
  setMeta,
} from '../db.js';

const CURSOR_KEY = 'push.cursor';
const VAPID_KEY = 'push.vapid';
const POLL_MS = 2000;

let publicKey = '';
let timer: NodeJS.Timeout | undefined;

/**
 * VAPID keys are generated once and kept in the database rather than an env
 * var: regenerating them silently invalidates every existing subscription, so
 * they must survive restarts and redeploys without anyone having to remember.
 */
function ensureVapidKeys(): { publicKey: string; privateKey: string } {
  const stored = getMeta(VAPID_KEY);
  if (stored) {
    try {
      return JSON.parse(stored);
    } catch {
      logger.warn('push: stored VAPID keys unreadable, regenerating');
    }
  }
  const keys = webpush.generateVAPIDKeys();
  setMeta(VAPID_KEY, JSON.stringify(keys));
  logger.info('push: generated new VAPID keys');
  return keys;
}

export function getPushPublicKey(): string {
  return publicKey;
}

export function startPush(): void {
  const keys = ensureVapidKeys();
  publicKey = keys.publicKey;

  // The subject must be a mailto: or https: URL; push services reject anything
  // else. It is only used as a contact address for the push provider.
  webpush.setVapidDetails(
    config.webPublicOrigin || 'https://piweb.local',
    keys.publicKey,
    keys.privateKey,
  );

  // Start at the current end of the log: enabling notifications must not
  // replay every historical reply as a burst.
  if (getMeta(CURSOR_KEY) == null) {
    setMeta(CURSOR_KEY, String(getMaxWebEventRowid()));
  }

  timer = setInterval(() => void tick(), POLL_MS);
  logger.info({ subscriptions: countPushSubscriptions() }, 'push: started');
}

export function stopPush(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}

function preview(kind: string, content: string): string {
  const text = content.replace(/```[\s\S]*?```/g, ' [code] ').replace(/\s+/g, ' ').trim();
  const body = text.length > 140 ? `${text.slice(0, 139)}…` : text;
  return kind === 'error' ? `⚠️ ${body}` : body;
}

async function tick(): Promise<void> {
  try {
    const cursor = Number(getMeta(CURSOR_KEY) ?? '0');
    const events = getNotifiableEventsSince(cursor);
    if (events.length === 0) return;

    // Advance the cursor before sending: a push failure must not cause the
    // same reply to be re-notified on every tick.
    setMeta(CURSOR_KEY, String(events[events.length - 1].rowid));

    const subs = listPushSubscriptions();
    if (subs.length === 0) return;

    for (const event of events) {
      const payload = JSON.stringify({
        title: event.name || 'piweb',
        body: preview(event.kind, event.content),
        jid: event.channel_jid,
        id: event.rowid,
      });

      await Promise.all(
        subs.map(async (sub) => {
          try {
            await webpush.sendNotification(
              { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
              payload,
            );
          } catch (err: any) {
            // 404/410 mean the browser threw the subscription away — drop it
            // rather than retrying it forever.
            if (err?.statusCode === 404 || err?.statusCode === 410) {
              deletePushSubscription(sub.endpoint);
              logger.info({ endpoint: sub.endpoint.slice(0, 40) }, 'push: subscription expired');
            } else {
              logger.warn({ err: err?.message, status: err?.statusCode }, 'push: send failed');
            }
          }
        }),
      );
    }
  } catch (err: any) {
    logger.warn({ err: err.message }, 'push: tick failed');
  }
}
