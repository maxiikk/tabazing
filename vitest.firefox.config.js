// End-to-end tests in real Firefox (tests/e2e/firefox/**/*.e2e.js): the Firefox copy of the extension (scripts/firefox.js,
// built by the tests) in the Firefox installed on the machine, through puppeteer. `npm run test:firefox`.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/e2e/firefox/**/*.e2e.js'],
    fileParallelism: false,
    testTimeout: 90_000,
    hookTimeout: 120_000,
  },
});
