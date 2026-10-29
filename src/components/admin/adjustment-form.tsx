'use client';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { apiPost } from '@/lib/api-client';
import { Button, Field, Input, Notice, Select, Textarea } from '@/components/ui/primitives';

type Fund = 'operator_float' | 'referral_reward_fund';

export interface FloatOption {
  fund: Fund;
  tokenId: number;
  symbol: string;
  balance: string; // formatted
}

const FUNDS: Record<Fund, string> = { operator_float: 'Operator float', referral_reward_fund: 'Reward fund' };
const today = () => new Date().toISOString().slice(0, 10);

/** Busy state, message, a fresh idempotency key per successful submit, refresh on success. */
function useSubmit() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [key, setKey] = useState(() => crypto.randomUUID());
  async function run(url: string, payload: unknown, ok: string, idempotent: boolean): Promise<boolean> {
    setBusy(true);
    setMsg(null);
    const r = await apiPost(url, payload, idempotent ? { idempotencyKey: key } : {});
    setBusy(false);
    setMsg(r.ok ? { ok: true, text: ok } : { ok: false, text: r.error ?? 'Failed' });
    if (r.ok) {
      setKey(crypto.randomUUID());
      router.refresh();
    }
    return r.ok;
  }
  const notice: ReactNode = msg ? <Notice tone={msg.ok ? 'success' : 'danger'}>{msg.text}</Notice> : null;
  return { busy, run, notice };
}

/**
 * The member's balance held with the administrator, with an Edit button: type
 * the new total and the difference is recorded as one entry (never an
 * overwrite), so the history still explains every change.
 */
export function BalanceEditor({ userId, balance, display }: { userId: string; balance: string; display: ReactNode }) {
  const [editing, setEditing] = useState(false);
  const [target, setTarget] = useState(balance);
  const [date, setDate] = useState(today);
  const [reason, setReason] = useState('');
  const { busy, run, notice } = useSubmit();
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm text-fg-muted">Total balance</p>
          <p className="text-2xl font-semibold">{display}</p>
        </div>
        {editing ? null : (
          <Button className="h-8 px-3 text-xs" variant="secondary" onClick={() => (setTarget(balance), setEditing(true))}>
            Edit
          </Button>
        )}
      </div>
      {editing ? (
        <div className="space-y-3 border-t border-line pt-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="New total (USDT)" htmlFor="bal-target">
              <Input id="bal-target" value={target} onChange={(e) => setTarget(e.target.value)} inputMode="decimal" autoFocus />
            </Field>
            <Field label="Date" htmlFor="bal-date">
              <Input id="bal-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
          </div>
          <Field label="Reason (optional, shown to the member)" htmlFor="bal-reason">
            <Textarea id="bal-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="e.g. Paid me 200 USDT in cash on 20 Oct" />
          </Field>
          <div className="flex gap-2">
            <Button
              className="h-8 px-3 text-xs"
              disabled={busy || !target.trim() || !date || target.trim() === balance}
              onClick={async () => {
                if (!window.confirm(`Change the balance from ${balance} to ${target.trim()} USDT?`)) return;
                if (await run(`/api/admin/users/${userId}/offchain/balance`, { target, expected: balance, occurredOn: date, reason: reason.trim() || undefined }, 'Balance updated.', true)) {
                  setReason('');
                  setEditing(false);
                }
              }}
            >
              {busy ? '…' : 'Save'}
            </Button>
            <Button className="h-8 px-3 text-xs" variant="secondary" disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      {notice}
    </div>
  );
}

/**
 * Add a reward or interest. Saved at once to the member's record (held with
 * the administrator). If a funded operator float or reward fund exists, it
 * can instead be paid as withdrawable balance from it, posted by the worker.
 */
export function RewardForm({
  userId,
  floats: allFloats,
  canPersonal,
  category = null,
}: {
  userId: string;
  floats: FloatOption[];
  canPersonal: boolean;
  /** 'matching_bonus': recorded held with you and shown on the member's Matching bonus tab. */
  category?: 'matching_bonus' | null;
}) {
  const floats = category ? [] : allFloats;
  const noun = category === 'matching_bonus' ? 'Matching bonus' : 'Reward';
  const idp = category ? 'mb' : 'rw';
  // Straight to the available balance whenever a funded float or reward fund can pay it.
  const [withdrawable, setWithdrawable] = useState(!canPersonal || floats.length > 0);
  const [option, setOption] = useState(() => Math.max(0, floats.findIndex((f) => f.fund === 'referral_reward_fund')));
  const [amount, setAmount] = useState('');
  const [source, setSource] = useState('');
  const [date, setDate] = useState(today);
  const [reason, setReason] = useState('');
  const { busy, run, notice } = useSubmit();
  if (!canPersonal && !floats.length) return <Notice tone="info">Only administrators can add these.</Notice>;
  const fund = withdrawable ? floats[option] : undefined;
  // Reason and source are optional; the stored reason needs 10+ characters, so short ones get a prefix.
  const typed = [source.trim(), reason.trim()].filter(Boolean).join(': ');
  const fullReason = typed.length >= 10 ? typed : typed ? `${noun} added: ${typed}` : `${noun} added by the administrator`;
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label={`Amount (${fund?.symbol ?? 'USDT'})`} htmlFor={`${idp}-amount`}>
          <Input id={`${idp}-amount`} value={amount} onChange={(e) => setAmount(e.target.value.replace(/^-/, ''))} inputMode="decimal" placeholder="50.00" />
        </Field>
        <Field label="Source (optional)" htmlFor={`${idp}-source`}>
          <Input id={`${idp}-source`} value={source} onChange={(e) => setSource(e.target.value)} maxLength={80} placeholder="e.g. Offline event, Interest" />
        </Field>
        {fund ? null : (
          <Field label="Date" htmlFor={`${idp}-date`}>
            <Input id={`${idp}-date`} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
        )}
      </div>
      <Field label="Reason (optional, shown to the member)" htmlFor={`${idp}-reason`}>
        <Textarea id={`${idp}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="e.g. 1st prize at the team meet on 20 Oct" />
      </Field>
      {floats.length ? (
        <div className="space-y-2">
          {canPersonal ? (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={withdrawable} onChange={(e) => setWithdrawable(e.target.checked)} />
              Add to their available balance (withdrawable)
            </label>
          ) : null}
          {withdrawable ? (
            <Field label="Paid from" htmlFor={`${idp}-fund`}>
              <Select id={`${idp}-fund`} value={option} onChange={(e) => setOption(Number(e.target.value))}>
                {floats.map((f, i) => (
                  <option key={`${f.fund}:${f.tokenId}`} value={i}>
                    {FUNDS[f.fund]} · {f.symbol} (available {f.balance})
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
        </div>
      ) : null}
      <Button
        className="h-8 px-3 text-xs"
        disabled={busy || !amount.trim() || (!fund && !date)}
        onClick={async () => {
          if (!window.confirm(`Add a ${noun.toLowerCase()} of ${amount.trim()} ${fund?.symbol ?? 'USDT'}${fund ? ` from the ${FUNDS[fund.fund].toLowerCase()}` : ''}?`)) return;
          const ok = fund
            ? await run(`/api/admin/users/${userId}/adjustments`, { tokenId: fund.tokenId, direction: 'credit', fund: fund.fund, amount, reason: fullReason }, 'Recorded. It posts within a few seconds.', false)
            : await run(`/api/admin/users/${userId}/offchain/entries`, { kind: 'earnings', category, amount, occurredOn: date, reason: fullReason }, `${noun} added.`, true);
          if (ok) {
            setAmount('');
            setSource('');
            setReason('');
          }
        }}
      >
        {busy ? '…' : `Add ${noun.toLowerCase()}`}
      </Button>
      {notice}
    </div>
  );
}

/**
 * Record a deposit a member paid the administrator personally (cash, bank,
 * another wallet). With a funded operator float it is credited straight to the
 * member's available balance from that float (the default); otherwise it is
 * recorded in the balance the administrator holds for them. Either way it
 * shows in the member's deposit history.
 */
export function ManualDepositForm({
  members,
  userId: fixedUserId,
  floats: allFloats,
}: {
  members?: { userId: string; label: string }[];
  userId?: string;
  floats: FloatOption[];
}) {
  const floats = allFloats.filter((f) => f.fund === 'operator_float');
  const [userId, setUserId] = useState(fixedUserId ?? '');
  const [withdrawable, setWithdrawable] = useState(floats.length > 0);
  const [option, setOption] = useState(0);
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(today);
  const [note, setNote] = useState('');
  const { busy, run, notice } = useSubmit();
  const fund = withdrawable ? floats[option] : undefined;
  const label = fixedUserId ? 'this member' : (members?.find((m) => m.userId === userId)?.label ?? '');
  const typed = note.trim();
  const reason = typed.length >= 10 ? typed : typed ? `Deposit received: ${typed}` : 'Deposit received by the administrator';
  const idp = fixedUserId ? 'ud' : 'dp';
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        {fixedUserId ? null : (
          <Field label="Member" htmlFor={`${idp}-member`}>
            <Select id={`${idp}-member`} value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">Choose…</option>
              {(members ?? []).map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.label}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label={`Amount (${fund?.symbol ?? 'USDT'})`} htmlFor={`${idp}-amount`}>
          <Input id={`${idp}-amount`} value={amount} onChange={(e) => setAmount(e.target.value.replace(/^-/, ''))} inputMode="decimal" placeholder="500.00" />
        </Field>
        {fund ? null : (
          <Field label="Date" htmlFor={`${idp}-date`}>
            <Input id={`${idp}-date`} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
        )}
      </div>
      <Field label="Note (optional, shown to the member)" htmlFor={`${idp}-note`}>
        <Input id={`${idp}-note`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="e.g. Cash, bank transfer" />
      </Field>
      {floats.length ? (
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={withdrawable} onChange={(e) => setWithdrawable(e.target.checked)} />
            Add to their available balance (from your operator float)
          </label>
          {withdrawable && floats.length > 1 ? (
            <Field label="Paid from" htmlFor={`${idp}-fund`}>
              <Select id={`${idp}-fund`} value={option} onChange={(e) => setOption(Number(e.target.value))}>
                {floats.map((f, i) => (
                  <option key={f.tokenId} value={i}>
                    {FUNDS[f.fund]} · {f.symbol} (available {f.balance})
                  </option>
                ))}
              </Select>
            </Field>
          ) : withdrawable && fund ? (
            <p className="text-xs text-fg-subtle">
              Operator float available: {fund.balance} {fund.symbol}
            </p>
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-fg-subtle">
          Kept as held by you. To add deposits to available balance, top up your operator float with USDT sent to the group wallet (Trading &amp; allocation).
        </p>
      )}
      <Button
        className="h-8 px-3 text-xs"
        disabled={busy || !userId || !amount.trim() || (!fund && !date)}
        onClick={async () => {
          if (!window.confirm(`Add a deposit of ${amount.trim()} ${fund?.symbol ?? 'USDT'} for ${label}${fund ? ' to their available balance' : ''}?`)) return;
          const ok = fund
            ? await run(`/api/admin/users/${userId}/adjustments`, { tokenId: fund.tokenId, direction: 'credit', fund: 'operator_float', amount, reason }, 'Deposit recorded. It posts within a few seconds.', false)
            : await run(`/api/admin/users/${userId}/offchain/entries`, { kind: 'contribution', amount, occurredOn: date, reason }, 'Deposit added.', true);
          if (ok) {
            setAmount('');
            setNote('');
          }
        }}
      >
        {busy ? '…' : 'Add deposit'}
      </Button>
      {notice}
    </div>
  );
}
