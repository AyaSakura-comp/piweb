import { resolve } from 'node:path';
import { defineConfig } from 'playwright/test';

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
    url: 'http://127.0.0.1:4173/health',
    reuseExistingServer: !process.env.CI,
  },
  use: {
    baseURL: 'http://127.0.0.1:4173',
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    colorScheme: 'dark',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'on',
  },
  projects: [
    {
      name: 'chromium-mobile',
      use: { browserName: 'chromium' },
    },
  ],
});
