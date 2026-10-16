import { defineConfig, devices } from '@playwright/test';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: ['.env.test', '.env.local'], quiet: true });

const PORT = Number(process.env.E2E_PORT ?? 3100);
export const BASE_URL = `http://127.0.0.1:${PORT}`;

/**
 * End-to-end tests run against a production build (`npm run test:e2e` builds
 * first via the pretest:e2e script) and the LOCAL Supabase stack. They create
 * throwaway users (*@e2e.test.local) in the local database.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: [['list']],
  use: { baseURL: BASE_URL, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npx next start -p ${PORT} -H 127.0.0.1`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
