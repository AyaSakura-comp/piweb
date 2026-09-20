import { resolve } from 'node:path';
import { defineConfig } from 'playwright/test';

const fixtureOrigin = `http://127.0.0.1:${Number(process.env.PIWEB_E2E_PORT || 4173)}`;

export default defineConfig({
  testDir: './test/e2e',
  outputDir: resolve(import.meta.dirname, 'artifacts/playwright/test-results'),
  reporter: [
    ['list'],
    [
      'html',
      {
        open: 'never',
        outputFolder: resolve(import.meta.dirname, 'artifacts/playwright/report'),
      },
    ],
  ],
  snapshotPathTemplate: '{testDir}/__screenshots__/{projectName}/{testFilePath}/{arg}{ext}',
  webServer: {
    command: 'node test/e2e/fixture-server.mjs',
    url: `${fixtureOrigin}/health`,
    reuseExistingServer: !process.env.CI,
  },
  use: {
    baseURL: fixtureOrigin,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    colorScheme: 'dark',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: { mode: 'on', size: { width: 390, height: 844 } },
  },
  projects: [
    {
      name: 'chromium-mobile',
      use: { browserName: 'chromium' },
    },
  ],
});
