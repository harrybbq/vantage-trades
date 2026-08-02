import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // The ledger tests share one database and assert on global balances, so
    // they must not interleave.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 20_000,
  },
});
