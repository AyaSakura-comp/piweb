import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../config.js';
import { latestWebEventId, listRecentUserMessages } from '../db.js';
import { logger } from '../logger.js';
import {
  HOT_KEYWORD_WINDOW_DAYS,
  SUPPORTED_HOT_KEYWORD_WINDOWS,
  rankHotKeywords,
  type HotKeyword,
} from '../agent/hot-keywords.js';

/**
 * Keeps `<WEB_MEDIA_DIR>/piweb-shared/hot-keywords.json` current: recounted
 * whenever a web event was added (checked every 30 s; a count over a week of
 * prompts takes tens of milliseconds). The page fetches it each time it
 * connects or comes back into view. The web tier already serves WEB_MEDIA_DIR
 * (authenticated) at /media/, so this needs no web route or image rebuild.
 */

export const HOT_KEYWORDS_RELATIVE_PATH = 'piweb-shared/hot-keywords.json';
const CHECK_MS = 30_000;

let timer: NodeJS.Timeout | undefined;
let countedThrough = -1;

export function publishHotKeywords(): void {
  const windows: Record<number, HotKeyword[]> = {};
  for (const days of SUPPORTED_HOT_KEYWORD_WINDOWS) {
    windows[days] = rankHotKeywords(listRecentUserMessages(days));
  }
  const items = windows[HOT_KEYWORD_WINDOW_DAYS] ?? windows[1] ?? [];
  const target = join(config.webMediaDir, HOT_KEYWORDS_RELATIVE_PATH);
  mkdirSync(dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(
    temp,
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      windowDays: HOT_KEYWORD_WINDOW_DAYS,
      items,
      windows,
    }),
    { mode: 0o644 },
  );
  renameSync(temp, target);
}

function check(): void {
  try {
    const latest = latestWebEventId();
    if (latest === countedThrough) return;
    publishHotKeywords();
    countedThrough = latest;
  } catch (error: any) {
    logger.warn({ err: error?.message }, 'Hot keywords: recount failed');
  }
}

export function startHotKeywordsLoop(): () => void {
  countedThrough = -1;
  check();
  timer = setInterval(check, CHECK_MS);
  return () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };
}
