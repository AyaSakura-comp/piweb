import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Runs before any test module is imported — see test/setup-env.ts. Without
    // it a test can inherit the real deployment's config and database paths.
    setupFiles: ['./test/setup-env.ts'],
  },
});
