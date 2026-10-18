import { describe, expect, it, vi } from 'vitest';
import { AlertDeliveryError, formatRiskAlert, getAlertSender, TelegramSender, type RiskAlertRow } from '@/server/alerts';
import { workerStartupError } from '../../workers/startup-guard';

const env = (o: Record<string, string | undefined>) => o as unknown as NodeJS.ProcessEnv;
const row: RiskAlertRow = {
  id: '42',
  kind: 'reconciliation_discrepancy',
  severity: 'critical',
  subject_type: 'reconciliation_run',
  subject_id: '7',
  created_at: new Date('2026-10-18T12:00:00Z'),
};

describe('operations alerts', () => {
  it('formats kind, severity, subject and pause state', () => {
    const text = formatRiskAlert(row, { appEnv: 'staging', withdrawalsPaused: true });
    expect(text).toContain('CRITICAL · reconciliation_discrepancy');
    expect(text).toContain('Subject: reconciliation_run 7');
    expect(text).toContain('#42 at 2026-10-18T12:00:00.000Z');
    expect(text).toContain('Environment: staging');
    expect(text).toContain('PAUSED');
    expect(formatRiskAlert({ ...row, severity: 'high' }, { appEnv: 'staging', withdrawalsPaused: false })).not.toContain('PAUSED');
  });

  it('posts a plain-text message to the configured chat', async () => {
    const fetchFn = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    await new TelegramSender('123:abc', '-100555', fetchFn as unknown as typeof fetch).send('hello');
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.telegram.org/bot123:abc/sendMessage');
    expect(JSON.parse(init.body as string)).toEqual({ chat_id: '-100555', text: 'hello', disable_web_page_preview: true });
  });

  it('reports failures without leaking the bot token', async () => {
    const rejected = new TelegramSender('123:secret', '1', (async () => new Response('', { status: 403 })) as unknown as typeof fetch);
    await expect(rejected.send('x')).rejects.toThrow(/HTTP 403/);
    const down = new TelegramSender('123:secret', '1', (async () => {
      throw new TypeError('fetch failed https://api.telegram.org/bot123:secret/sendMessage');
    }) as unknown as typeof fetch);
    const err = (await down.send('x').catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(AlertDeliveryError);
    expect(err.message).not.toContain('secret');
  });

  it('is only configured with both a token and a chat id', () => {
    expect(getAlertSender(env({}))).toBeNull();
    expect(getAlertSender(env({ TELEGRAM_BOT_TOKEN: 't' }))).toBeNull();
    expect(getAlertSender(env({ TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: ' ' }))).toBeNull();
    expect(getAlertSender(env({ TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '1' }))).toBeInstanceOf(TelegramSender);
  });

  it('refuses to start the worker outside development without an alert channel', () => {
    const base = { DATABASE_URL_WORKER: 'postgres://u:p@127.0.0.1:1/x' };
    expect(workerStartupError(env({ ...base, APP_ENV: 'development' }))).toBeNull();
    expect(workerStartupError(env({ ...base, APP_ENV: 'staging' }))).toMatch(/TELEGRAM_BOT_TOKEN/);
    expect(workerStartupError(env({ ...base, APP_ENV: 'production', TELEGRAM_BOT_TOKEN: 't' }))).toMatch(/TELEGRAM_CHAT_ID/);
    expect(workerStartupError(env({ ...base, APP_ENV: 'production', TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '1' }))).toBeNull();
  });
});
