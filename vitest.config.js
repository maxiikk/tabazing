// Unit tests (tests/**/*.test.js). `npm test` runs them once, `npm run test:watch` on every change.
// tests/setup/chrome.js installs a fake chrome.* API before each test file.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.js'],
    setupFiles: ['tests/setup/chrome.js', 'tests/setup/dom.js'],
    restoreMocks: true,
    testTimeout: 15000, // the whole suite runs in parallel: a slow machine can take a heavy switcher test past the default 5 s
  },
});
