import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

describe('test environment isolation', () => {
  it('never lets a test fall back to a real deployment path', async () => {
    // Regression: test/extension-commands.test.ts called initDb() after config
    // had already been imported, so its late DB_PATH assignment did nothing and
    // the suite opened the piscord gateway's LIVE database and migrated it.
    const { config } = await import('../src/config.js');
    const real = [
      resolve(homedir(), '.local/share', 'piweb'),
      resolve(homedir(), '.local/share', 'piscord-gateway'),
    ];

    for (const path of [
      config.dbPath,
      config.sessionsDir,
      config.webMediaDir,
      config.webUploadDir,
    ]) {
      if (path === ':memory:') continue;
      expect(path.startsWith(tmpdir()), `${path} escapes the temp sandbox`).toBe(true);
      for (const dir of real) expect(path.startsWith(dir)).toBe(false);
    }
  });

  it('wires the guard in before any test module is imported', () => {
    const conf = readFileSync(resolve(import.meta.dirname, '../vitest.config.ts'), 'utf8');
    expect(conf).toContain("setupFiles: ['./test/setup-env.ts']");
  });
});
