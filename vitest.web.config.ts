import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * The panel's component tests: a browser-like DOM, no database. Kept apart
 * from vitest.config.ts so the ledger suite's database guard and sequential
 * settings do not apply here, and so these run in seconds.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    include: ['web/src/**/*.test.tsx', 'web/src/**/*.test.ts'],
    environment: 'jsdom',
  },
});
