import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { admin, closePools, resetAppData, web, worker } from '../helpers/db';
import { dispatchRiskAlerts, type AlertSender } from '../../src/server/alerts';
import { raiseRiskEvent, type RiskSeverity } from '../../src/server/ops';

class FakeSender implements AlertSender {
  sent: string[] = [];
  failAfter = Infinity;
  async send(text: string) {
    if (this.sent.length >= this.failAfter) throw new Error('down');
    this.sent.push(text);
  }
}

const raise = (kind: string, severity: RiskSeverity) => raiseRiskEvent(worker, { kind, severity, subjectType: 'test', subjectId: kind });
const unalerted = async () =>
  (await admin.query("select kind from public.risk_events where alerted_at is null and severity in ('high', 'critical') order by created_at, id")).rows.map((r) => r.kind);

beforeEach(resetAppData);
afterAll(closePools);

describe('operations alerts', () => {
  it('sends each high/critical event once, oldest first, and ignores lower severities', async () => {
    await raise('first', 'critical');
    await raise('minor', 'medium');
    await raise('second', 'high');
    const sender = new FakeSender();

    expect(await dispatchRiskAlerts(worker, sender, { appEnv: 'test' })).toEqual({ sent: 2, failed: 0 });
    expect(sender.sent[0]).toContain('first');
    expect(sender.sent[1]).toContain('second');
    expect(sender.sent.join()).not.toContain('minor');

    expect(await dispatchRiskAlerts(worker, sender, { appEnv: 'test' })).toEqual({ sent: 0, failed: 0 });
    expect(sender.sent).toHaveLength(2);
  });

  it('keeps undelivered events queued when the channel is down', async () => {
    await raise('a', 'critical');
    await raise('b', 'critical');
    await raise('c', 'high');
    const sender = new FakeSender();
    sender.failAfter = 1;

    expect(await dispatchRiskAlerts(worker, sender, { appEnv: 'test' })).toEqual({ sent: 1, failed: 1 });
    expect(await unalerted()).toEqual(['b', 'c']);

    sender.failAfter = Infinity;
    expect(await dispatchRiskAlerts(worker, sender, { appEnv: 'test' })).toEqual({ sent: 2, failed: 0 });
    expect(await unalerted()).toEqual([]);
  });

  it('says when withdrawals are paused', async () => {
    await admin.query("update public.system_controls set enabled = true where key = 'withdrawals_paused'");
    await raise('payout_status_conflict', 'critical');
    const sender = new FakeSender();
    await dispatchRiskAlerts(worker, sender, { appEnv: 'test' });
    expect(sender.sent[0]).toContain('PAUSED');
  });

  it('does not let the web role silence an alert', async () => {
    await raise('x', 'critical');
    await expect(web.query('update public.risk_events set alerted_at = now()')).rejects.toThrow(/permission denied/);
    // The web role can still resolve events from the admin console.
    await web.query("update public.risk_events set status = 'acknowledged', resolution_note = 'looking'");
    expect(await unalerted()).toEqual(['x']);
  });
});
