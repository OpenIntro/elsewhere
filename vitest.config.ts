import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Resolve @elsewhere/shared to its TypeScript sources (no build needed for tests).
    conditions: ['source'],
  },
  test: {
    include: ['shared/test/**/*.test.ts', 'server/test/**/*.test.ts', 'client/test/**/*.test.ts'],
    environment: 'node',
  },
});
