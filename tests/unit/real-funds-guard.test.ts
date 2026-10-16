import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { assertDemoModeAllowed, assertRealFundsDisabled, realFundsRequested } from '@/server/phase-guard';
import { workerStartupError } from '../../workers/startup-guard';

const env = (o: Record<string, string | undefined>) => o as unknown as NodeJS.ProcessEnv;
const base = { DATABASE_URL_WORKER: 'postgres://u:p@127.0.0.1:1/x' };

describe('real-funds phase guard', () => {
  it('treats only unset, "false" and "0" as off', () => {
    for (const v of [undefined, '', 'false', '0', ' FALSE ']) expect(realFundsRequested(env({ REAL_FUNDS_ENABLED: v }))).toBe(false);
    for (const v of ['true', '1', 'TRUE', 'yes', 'on', 'enabled']) expect(realFundsRequested(env({ REAL_FUNDS_ENABLED: v }))).toBe(true);
  });

  it('throws from the web server environment check', () => {
    expect(() => assertRealFundsDisabled(env({ REAL_FUNDS_ENABLED: '1' }))).toThrow(/not supported/);
    expect(() => assertRealFundsDisabled(env({ REAL_FUNDS_ENABLED: 'false' }))).not.toThrow();
  });

  it('refuses demo mode in production', () => {
    expect(() => assertDemoModeAllowed(env({ DEMO_MODE: 'true', APP_ENV: 'production' }))).toThrow();
    expect(() => assertDemoModeAllowed(env({ DEMO_MODE: 'true', APP_ENV: 'development' }))).not.toThrow();
  });

  it('blocks worker startup when real funds are requested', () => {
    expect(workerStartupError(env({ ...base, REAL_FUNDS_ENABLED: 'true' }))).toMatch(/Refusing to start/);
    expect(workerStartupError(env({ ...base, REAL_FUNDS_ENABLED: '1' }))).toMatch(/Refusing to start/);
    expect(workerStartupError(env({ ...base, REAL_FUNDS_ENABLED: 'false' }))).toBeNull();
    expect(workerStartupError(env({ REAL_FUNDS_ENABLED: 'false' }))).toMatch(/DATABASE_URL_WORKER/);
  });

  it('the real worker process exits non-zero before connecting when REAL_FUNDS_ENABLED is on', () => {
    for (const value of ['true', '1']) {
      const res = spawnSync(process.execPath, ['--import', 'tsx', 'workers/index.ts'], {
        env: { ...process.env, ...base, REAL_FUNDS_ENABLED: value },
        encoding: 'utf8',
        timeout: 60_000,
      });
      expect(res.status).toBe(1);
      expect(res.stderr).toMatch(/Refusing to start/);
      expect(res.stdout).not.toMatch(/worker\.started/);
    }
  }, 120_000);
});
