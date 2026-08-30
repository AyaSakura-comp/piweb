import { afterEach, describe, expect, it, vi } from 'vitest';

const originalDbPath = process.env.DB_PATH;

function channel() {
  return {
    jid: 'web:cron123',
    name: 'Cron session',
    folder: 'web_cron123',
    requiresTrigger: false,
    isMain: false,
    modelOverride: '',
    thinkingOverride: '' as const,
    cwdOverride: '',
  };
}

afterEach(() => {
  vi.resetModules();
  if (originalDbPath === undefined) delete process.env.DB_PATH;
  else process.env.DB_PATH = originalDbPath;
});

describe('scheduled task web commands', () => {
  it('creates a recurring task bound to the current web session', async () => {
    process.env.DB_PATH = ':memory:';
    vi.resetModules();
    const db = await import('../src/db.js');
    const { runCommand } = await import('../src/commands/index.js');
    db.initDb();

    try {
      db.registerChannel({ ...channel(), kind: 'standard' });
      const owner = db.getChannel('web:cron123')!;
      const result = await runCommand(owner, 'task cron', {
        text: 'daily report | 0 9 * * * | Generate the daily report',
      });

      expect(result.ok).toBe(true);
      expect(db.listScheduledTasks()[0]).toMatchObject({
        name: 'daily report',
        type: 'recurring',
        schedule: '0 9 * * *',
        channel_jid: 'web:cron123',
        prompt: 'Generate the daily report',
      });
    } finally {
      db.closeDb();
    }
  });

  it('does not mutate a session trashed immediately after ownership validation', async () => {
    process.env.DB_PATH = ':memory:';
    vi.resetModules();
    const db = await import('../src/db.js');
    const { runCommand } = await import('../src/commands/index.js');
    db.initDb();

    try {
      db.registerChannel({ ...channel(), kind: 'standard' });
      const owner = db.getChannel('web:cron123')!;
      let checked = false;
      const result = await runCommand(
        owner,
        'task cron',
        { text: 'stale task | 0 9 * * * | must not be created' },
        {
          assertOwnership: () => {
            if (checked) return;
            checked = true;
            db.softDeleteChannel(owner.jid, owner.folder, owner.storageToken);
          },
        },
      );

      expect(result.ok).toBe(false);
      expect(db.listScheduledTasks()).toEqual([]);
    } finally {
      db.closeDb();
    }
  });

  it('rejects malformed recurring task input without creating a task', async () => {
    process.env.DB_PATH = ':memory:';
    vi.resetModules();
    const db = await import('../src/db.js');
    const { runCommand } = await import('../src/commands/index.js');
    db.initDb();

    try {
      const result = await runCommand(channel(), 'task cron', { text: 'missing separators' });

      expect(result.ok).toBe(false);
      expect(db.listScheduledTasks()).toHaveLength(0);
    } finally {
      db.closeDb();
    }
  });

  it('lists only tasks belonging to the current web session', async () => {
    process.env.DB_PATH = ':memory:';
    vi.resetModules();
    const db = await import('../src/db.js');
    const { runCommand } = await import('../src/commands/index.js');
    db.initDb();

    try {
      const future = new Date(Date.now() + 60_000).toISOString();
      db.addScheduledTask({
        name: 'mine',
        type: 'recurring',
        schedule: '* * * * *',
        channelJid: 'web:cron123',
        prompt: 'mine prompt',
        nextRunAt: future,
      });
      db.addScheduledTask({
        name: 'other',
        type: 'recurring',
        schedule: '* * * * *',
        channelJid: 'web:other',
        prompt: 'other prompt',
        nextRunAt: future,
      });

      const result = await runCommand(channel(), 'task list');

      expect(result.ok).toBe(true);
      expect(result.text).toContain('mine');
      expect(result.text).not.toContain('other');
    } finally {
      db.closeDb();
    }
  });
});
