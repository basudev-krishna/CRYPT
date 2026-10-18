/**
 * Operations alerts: push high and critical risk events (automatic pauses,
 * reconciliation discrepancies, payout anomalies, dead-lettered jobs, failed
 * valuations) to a channel people actually watch.
 *
 * Messages carry the event kind, severity and subject only. Event details can
 * hold addresses and user ids, which stay in the admin console rather than
 * being copied to a third-party messenger.
 */
import { many, withTransaction, type Db } from './db-core';
import { isControlEnabled } from './ops';
import type pg from 'pg';

export interface AlertSender {
  send(text: string): Promise<void>;
}

export class AlertDeliveryError extends Error {
  override name = 'AlertDeliveryError';
  readonly code = 'alert_delivery_failed';
}

export interface RiskAlertRow {
  id: string;
  kind: string;
  severity: 'high' | 'critical';
  subject_type: string;
  subject_id: string;
  created_at: Date;
}

/** Plain text (no parse_mode), so event fields never need markup escaping. */
export function formatRiskAlert(e: RiskAlertRow, ctx: { appEnv: string; withdrawalsPaused: boolean }): string {
  const lines = [
    `${e.severity === 'critical' ? '🚨 CRITICAL' : '⚠️ HIGH'} · ${e.kind}`,
    `Subject: ${e.subject_type} ${e.subject_id}`,
    `Risk event #${e.id} at ${e.created_at.toISOString()}`,
    `Environment: ${ctx.appEnv}`,
  ];
  if (ctx.withdrawalsPaused) lines.push('Withdrawals are currently PAUSED. Resuming needs a different admin.');
  lines.push('Investigate in /admin before resolving.');
  return lines.join('\n');
}

export class TelegramSender implements AlertSender {
  constructor(
    private readonly botToken: string,
    private readonly chatId: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async send(text: string): Promise<void> {
    let res: Response;
    try {
      res = await this.fetchFn(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: this.chatId, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      // The request URL contains the bot token, so the underlying error is not echoed.
      throw new AlertDeliveryError('Telegram unreachable');
    }
    if (!res.ok) throw new AlertDeliveryError(`Telegram rejected the alert (HTTP ${res.status})`);
  }
}

/** Null when no channel is configured; the startup guard decides whether that is allowed. */
export function getAlertSender(env: NodeJS.ProcessEnv): AlertSender | null {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const chat = env.TELEGRAM_CHAT_ID?.trim();
  return token && chat ? new TelegramSender(token, chat) : null;
}

/**
 * Send unalerted high/critical events, oldest first. Rows stay locked while
 * sending so two workers never alert the same event concurrently; a failed send
 * leaves the event unalerted for the next run.
 */
export async function dispatchRiskAlerts(
  pool: pg.Pool,
  sender: AlertSender,
  opts: { appEnv: string; limit?: number },
): Promise<{ sent: number; failed: number }> {
  return withTransaction(pool, async (db: Db) => {
    const rows = await many<RiskAlertRow>(
      db,
      `select id::text, kind, severity::text as severity, subject_type, subject_id, created_at
         from public.risk_events
        where alerted_at is null and severity in ('high', 'critical')
        order by created_at, id limit $1
        for update skip locked`,
      [opts.limit ?? 20],
    );
    if (rows.length === 0) return { sent: 0, failed: 0 };
    const withdrawalsPaused = await isControlEnabled(db, 'withdrawals_paused');
    let sent = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        await sender.send(formatRiskAlert(row, { appEnv: opts.appEnv, withdrawalsPaused }));
      } catch {
        failed++;
        break; // channel is down; keep order and retry everything on the next run
      }
      await db.query('update public.risk_events set alerted_at = now() where id = $1', [row.id]);
      sent++;
    }
    return { sent, failed };
  });
}
