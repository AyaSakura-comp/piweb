/**
 * Keep the test suite off the real deployment's files.
 *
 * `src/config.ts` snapshots the environment at import time, so a test that sets
 * DB_PATH *after* something has already pulled in config silently keeps the
 * default path — and that default used to be the piscord gateway's live
 * database. `initDb()` then ran piweb's migrations against piscord's production
 * data, adding a unique index piscord's own inserts cannot satisfy and breaking
 * @-mentions in Discord until the index was dropped by hand.
 *
 * This runs before any test module is imported, so no test can reach a real
 * path by accident. Tests that want their own database still override these.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const root = mkdtempSync(resolve(tmpdir(), 'piweb-test-'));

process.env.PIDG_CONFIG ??= resolve(root, 'config.env');
process.env.DB_PATH ??= resolve(root, 'gateway.db');
process.env.SESSIONS_DIR ??= resolve(root, 'sessions');
process.env.WEB_MEDIA_DIR ??= resolve(root, 'web-media');
process.env.WEB_UPLOAD_DIR ??= resolve(root, 'web-uploads');
