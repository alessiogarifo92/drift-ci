import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Fixture repos run real git commands.
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'test/helpers/**/*.ts'],
      exclude: ['src/*/index.ts', 'test/helpers/make-fixture-repo.ts'],
      reporter: [['text', { skipFull: false }], 'json-summary', 'html'],
    },
  },
});
