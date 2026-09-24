import { resolve } from 'node:path';
import { defineConfig } from 'playwright/test';

// Opt-in real PiWeb + worker; start a disposable loopback server separately.
export default defineConfig({
  testDir: './test/e2e',
  testMatch: 'btw-live-video.spec.ts',
  outputDir: resolve(import.meta.dirname, 'artifacts/playwright/btw-live-results'),
  reporter: [['list']],
  use: {
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    colorScheme: 'dark',
    screenshot: 'only-on-failure',
    trace: 'off',
    video: { mode: 'on', size: { width: 390, height: 844 } },
  },
  projects: [{ name: 'chromium-mobile', use: { browserName: 'chromium' } }],
});
