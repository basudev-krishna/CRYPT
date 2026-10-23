import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'dotenv';

// A hosted test database (INTEGRATION_TEST_DB_HOST, see tests/helpers/db.ts) adds
// network latency to every query, so its tests get much longer limits.
// Read without loading, so unit tests never see these variables.
const remoteDb = Boolean(process.env.INTEGRATION_TEST_DB_HOST ?? (existsSync('.env.test') ? parse(readFileSync('.env.test')).INTEGRATION_TEST_DB_HOST : undefined));

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
          testTimeout: remoteDb ? 300_000 : 30_000,
          hookTimeout: remoteDb ? 300_000 : 60_000,
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
