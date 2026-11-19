import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globals: false,
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary'],
      // Only the business rules are held to a number. UI components and scripts are covered by the
      // Playwright suite instead, where they can actually be clicked.
      include: ['src/core/**/*.ts'],
      exclude: ['src/core/**/*.d.ts'],
      thresholds: {
        lines: 85,
        functions: 85,
        statements: 85,
        // Branches stay lower on purpose: error paths that cannot be triggered without a live
        // third-party failure are tested as behaviour, not as every branch in a retry loop.
        branches: 75,
      },
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./', import.meta.url)),
    },
  },
});
