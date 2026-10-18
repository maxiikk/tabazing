// End-to-end tests (tests/e2e/**/*.e2e.js): the real extension in headless Chrome for Testing (puppeteer).
// `npm run test:e2e`. Kept apart from `npm test` (whose include is tests/**/*.test.js): no jsdom, no fake chrome.*.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/e2e/**/*.e2e.js'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
