import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const alias = { '@': fileURLToPath(new URL('./src', import.meta.url)) };

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { ...alias, 'server-only': fileURLToPath(new URL('./tests/helpers/server-only-stub.ts', import.meta.url)) } },
  test: {
    projects: [
      { extends: true, test: { name: 'unit', include: ['tests/unit/**/*.test.ts'], environment: 'node' } },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          // Integration tests share one database and reset it between files.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
          setupFiles: ['tests/helpers/load-env.ts'],
        },
      },
      {
        extends: true,
        test: { name: 'component', include: ['tests/component/**/*.test.tsx'], environment: 'jsdom', setupFiles: ['tests/helpers/jsdom-setup.ts'] },
      },
    ],
  },
});
