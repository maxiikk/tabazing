// End-to-end tests (tests/e2e/**/*.e2e.js, Chrome; Firefox's are in tests/e2e/firefox/): the real extension in headless Chrome for Testing (puppeteer).
// `npm run test:e2e`. Kept apart from `npm test` (whose include is tests/**/*.test.js): no jsdom, no fake chrome.*.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/e2e/**/*.e2e.js'],
    exclude: ['tests/e2e/firefox/**'], // (Firefox: npm run test:firefox, vitest.firefox.config.js)
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
