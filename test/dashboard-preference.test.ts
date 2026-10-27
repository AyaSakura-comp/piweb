import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readDashboardPreference, saveDashboardPreference } from '../public/session-ui.js';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

describe('Settings → Dashboard preference', () => {
  it('is on unless turned off, and on when storage is unreadable', () => {
    expect(readDashboardPreference(memoryStorage())).toBe(true);
    expect(
      readDashboardPreference({
        getItem: () => {
          throw new Error('blocked');
        },
      }),
    ).toBe(true);
  });

  it('round-trips off and on', () => {
    const storage = memoryStorage();
    saveDashboardPreference(false, storage);
    expect(readDashboardPreference(storage)).toBe(false);
    saveDashboardPreference(true, storage);
    expect(readDashboardPreference(storage)).toBe(true);
  });

  it("never writes the key that holds the Dashboard's layout", () => {
    // The first cut saved "off" under piweb.dashboard and wiped the tiles.
    const dashboard = readFileSync(resolve(import.meta.dirname, '../public/session-dashboard.js'), 'utf8');
    const layoutKey = dashboard.match(/const DASHBOARD_STORAGE_KEY = '([^']+)'/)![1];
    const storage = memoryStorage();
    saveDashboardPreference(false, storage);
    expect([...storage.values.keys()]).toHaveLength(1);
    expect(storage.values.has(layoutKey)).toBe(false);
  });
});
