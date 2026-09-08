import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Fast, deterministic tests only: no network, no real-time sleeps.
    // Integration (testnet) tests live under tests/integration and run via `npm run test:integration`.
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globals: false,
    // Reliability suites (Phase 13+) may need more time than the default.
    testTimeout: 20_000,
  },
});
