import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import playwrightConfig from '../playwright.config.js';

const root = resolve(import.meta.dirname, '..');

describe('Playwright end-to-end test setup', () => {
  it('exposes dedicated E2E and visual-baseline commands', () => {
    const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(existsSync(resolve(root, 'playwright.config.ts'))).toBe(true);
    expect(packageJson.scripts['test:e2e']).toBe('playwright test');
    expect(packageJson.scripts['test:e2e:update']).toBe('playwright test --update-snapshots=all');
  });

  it('records every E2E run as video under the ignored artifacts directory', () => {
    expect(playwrightConfig.use?.video).toBe('on');
    expect(playwrightConfig.outputDir).toBe(resolve(root, 'artifacts/playwright/test-results'));
  });

  it('captures mobile visual evidence and stores reviewable screenshot baselines', () => {
    expect(playwrightConfig.use?.viewport).toEqual({ width: 390, height: 844 });
    expect(playwrightConfig.use?.screenshot).toBe('only-on-failure');
    expect(playwrightConfig.use?.trace).toBe('retain-on-failure');
    expect(playwrightConfig.snapshotPathTemplate).toContain('__screenshots__');
  });

  it('boots a deterministic local fixture server instead of depending on a live account', () => {
    expect(existsSync(resolve(root, 'test/e2e/fixture-server.mjs'))).toBe(true);
    expect(playwrightConfig.use?.baseURL).toBe('http://127.0.0.1:4173');
    expect(playwrightConfig.webServer).toMatchObject({
      command: 'node test/e2e/fixture-server.mjs',
      url: 'http://127.0.0.1:4173/health',
    });
  });

  it('runs the mobile suite in an explicitly named Chromium project', () => {
    expect(playwrightConfig.projects).toEqual([
      expect.objectContaining({
        name: 'chromium-mobile',
        use: { browserName: 'chromium' },
      }),
    ]);
  });

  it('writes an HTML evidence report that links screenshots, traces, and videos', () => {
    expect(playwrightConfig.reporter).toEqual([
      ['list'],
      [
        'html',
        {
          open: 'never',
          outputFolder: resolve(root, 'artifacts/playwright/report'),
        },
      ],
    ]);
  });

  it('keeps live-account E2E checks opt-in and free of embedded credentials', () => {
    const legacyPath = resolve(root, 'test/playwright-live-scroll.test.ts');
    const liveSpecPath = resolve(root, 'test/e2e/live-scroll.spec.ts');

    expect(existsSync(legacyPath)).toBe(false);
    expect(existsSync(liveSpecPath)).toBe(true);
    const source = readFileSync(liveSpecPath, 'utf8');
    expect(source).toContain('PIWEB_E2E_LIVE_URL');
    expect(source).toContain('PIWEB_E2E_TOKEN');
    expect(source).not.toContain('2169');
    expect(source).not.toContain('piweb.crayfish-monitor.ts.net');
  });
});
