import { describe, expect, it, vi } from 'vitest';
import { AlertDeliveryError, EmailSender, formatRiskAlert, getAlertSender, MultiSender, smtpConfig, TelegramSender, type AlertSender, type MailTransport, type RiskAlertRow } from '@/server/alerts';
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
    expect(workerStartupError(env({ ...base, APP_ENV: 'staging' }))).toMatch(/alert channel is required/);
    expect(workerStartupError(env({ ...base, APP_ENV: 'production', TELEGRAM_BOT_TOKEN: 't' }))).toMatch(/alert channel is required/);
    expect(workerStartupError(env({ ...base, APP_ENV: 'production', ...smtp, ALERT_EMAIL_TO: '' }))).toMatch(/alert channel is required/);
    expect(workerStartupError(env({ ...base, APP_ENV: 'production', TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '1' }))).toBeNull();
    expect(workerStartupError(env({ ...base, APP_ENV: 'production', ...smtp }))).toBeNull();
  });
});

const smtp = {
  SMTP_HOST: 'smtp.example.com',
  SMTP_PORT: '587',
  SMTP_USER: 'login@example.com',
  SMTP_PASSWORD: 'smtp-secret',
  ALERT_EMAIL_FROM: 'alerts@example.com',
  ALERT_EMAIL_TO: 'admin@example.com, ops@example.com',
};

describe('email alerts', () => {
  it('reads a complete SMTP configuration and rejects incomplete or malformed ones', () => {
    expect(smtpConfig(env(smtp))).toEqual({
      host: 'smtp.example.com',
      port: 587,
      user: 'login@example.com',
      password: 'smtp-secret',
      from: 'alerts@example.com',
      to: ['admin@example.com', 'ops@example.com'],
    });
    expect(smtpConfig(env({ ...smtp, SMTP_PORT: undefined }))?.port).toBe(587);
    for (const patch of [{ SMTP_HOST: '' }, { SMTP_PASSWORD: ' ' }, { ALERT_EMAIL_TO: '' }, { ALERT_EMAIL_TO: 'not-an-email' }, { ALERT_EMAIL_FROM: 'x' }, { SMTP_PORT: 'abc' }]) {
      expect(smtpConfig(env({ ...smtp, ...patch })), JSON.stringify(patch)).toBeNull();
    }
    expect(getAlertSender(env(smtp))).toBeInstanceOf(EmailSender);
    expect(getAlertSender(env({ ...smtp, TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '1' }))).toBeInstanceOf(MultiSender);
  });

  it('sends the headline as subject and the alert as plain text', async () => {
    const sendMail = vi.fn(async () => ({}));
    await new EmailSender(smtpConfig(env(smtp))!, { sendMail } as MailTransport).send(formatRiskAlert(row, { appEnv: 'production', withdrawalsPaused: false }));
    const [msg] = sendMail.mock.calls[0] as unknown as [{ from: string; to: string[]; subject: string; text: string }];
    expect(msg.from).toBe('alerts@example.com');
    expect(msg.to).toEqual(['admin@example.com', 'ops@example.com']);
    expect(msg.subject).toBe('[EliteWhale] 🚨 CRITICAL · reconciliation_discrepancy');
    expect(msg.text).toContain('Subject: reconciliation_run 7');
  });

  it('reports SMTP failures without leaking the login', async () => {
    const failing = {
      sendMail: async () => {
        throw Object.assign(new Error('Invalid login: 535 login@example.com smtp-secret'), {
          responseCode: 535,
          response: '535 5.7.8 Authentication failed for login@example.com with smtp-secret',
        });
      },
    };
    const err = (await new EmailSender(smtpConfig(env(smtp))!, failing).send('x').catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(AlertDeliveryError);
    expect(err.message).toBe('Email alert not sent (SMTP 535): 535 5.7.8 Authentication failed for <login> with <key>');
  });

  it('counts an alert as delivered when any channel accepts it', async () => {
    const ok: AlertSender = { send: async () => {} };
    const down: AlertSender = {
      send: async () => {
        throw new AlertDeliveryError('down');
      },
    };
    await expect(new MultiSender([down, ok]).send('x')).resolves.toBeUndefined();
    await expect(new MultiSender([down, down]).send('x')).rejects.toThrow(AlertDeliveryError);
  });
});
