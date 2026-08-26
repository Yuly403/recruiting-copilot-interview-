import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/index.ts',          // barrel re-exports
        'src/contracts/index.ts',   // barrel
        'src/drivers/legacy-cli/parsers/index.ts', // barrel
      ],
      thresholds: {
        statements: 60,
        branches: 50,
        functions: 60,
        lines: 60,
      },
      reporter: ['text', 'text-summary', 'html'],
      reportsDirectory: './coverage',
    },
  },
});
