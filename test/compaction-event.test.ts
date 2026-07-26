import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * pi compacts the context on its own and emits compaction_start/_end. Without
 * surfacing compaction_end the only visible trace is the /pi status context
 * number dropping — or a >100% reading if you look just before it fires.
 */

const tempDirs: string[] = [];

afterEach(() => {
  vi.resetModules();
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function setup() {
  const tempDir = mkdtempSync(join(tmpdir(), 'piweb-compaction-'));
  tempDirs.push(tempDir);
  process.env.DB_PATH = ':memory:';
  process.env.SESSIONS_DIR = resolve(tempDir, 'sessions');

  vi.resetModules();
  const db = await import('../src/db.js');
  const { webTransport } = await import('../src/transport/web.js');
  db.initDb();
  db.registerChannel({
    jid: 'web:abc',
    name: 't',
    folder: 'web_abc',
    requiresTrigger: false,
    isMain: false,
    modelOverride: '',
    thinkingOverride: '',
    cwdOverride: '',
  });
  return { db, stream: webTransport.createEventStreamer('web:abc') };
}

function systemEvents(db: any) {
  return db.getRecentWebEvents('web:abc', 50).filter((e: any) => e.kind === 'system');
}

describe('compaction events', () => {
  it('writes a system notice when pi finishes compacting', async () => {
    const { db, stream } = await setup();
    try {
      await stream({
        type: 'compaction_end',
        reason: 'overflow',
        aborted: false,
        willRetry: true,
        result: { summary: '…', firstKeptEntryId: 'abc', tokensBefore: 304028 },
      });

      const events = systemEvents(db);
      expect(events).toHaveLength(1);
      expect(events[0].role).toBe('compacted');
      // The number pi reports as tokensBefore must reach the user verbatim.
      expect(events[0].content).toContain('304,028');
      expect(events[0].content).toContain('overflowed');
    } finally {
      db.closeDb();
    }
  });

  it('stays silent for compaction_start and for an aborted or failed compaction', async () => {
    const { db, stream } = await setup();
    try {
      await stream({ type: 'compaction_start', reason: 'threshold' });
      await stream({
        type: 'compaction_end',
        reason: 'threshold',
        aborted: true,
        result: { tokensBefore: 1 },
      });
      // pi emits compaction_end with no result when it bails (no model, no auth).
      await stream({ type: 'compaction_end', reason: 'threshold', aborted: false });

      expect(systemEvents(db)).toHaveLength(0);
    } finally {
      db.closeDb();
    }
  });
});
