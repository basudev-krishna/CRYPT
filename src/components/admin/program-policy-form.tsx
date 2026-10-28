'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiPost } from '@/lib/api-client';
import { Button, Field, Input, Notice, Select, Textarea } from '@/components/ui/primitives';

interface Rank {
  code: string;
  left: string;
  right: string;
  self: string;
  bonus: string;
}

export interface ProgramFormValue {
  program_start: string;
  placement_mode: 'direct' | 'outer';
  matching: { enabled: boolean; tree: 'sponsor' | 'placement'; levels: { level: number; rate_bps: number }[]; min_left: string; min_right: string; min_rank: string | null };
  ranks: { rewards_enabled: boolean; token_id: number | null; levels: Rank[] };
}

const AMOUNT = /^\d{1,12}(\.\d{1,6})?$/;

/** "5, 5, 4" (percent, up to 2 decimals) ↔ level rates in basis points. Invalid input is reported, never guessed. */
function parseRates(text: string): { level: number; rate_bps: number }[] | null {
  const parts = text.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 1 || parts.length > 10) return null;
  const out: { level: number; rate_bps: number }[] = [];
  for (const [i, p] of parts.entries()) {
    const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(p);
    if (!m) return null;
    out.push({ level: i + 1, rate_bps: Number.parseInt(m[1]!, 10) * 100 + Number.parseInt((m[2] ?? '').padEnd(2, '0') || '0', 10) });
  }
  return out;
}

/** One rank per line: "E1 1500 1500 150 50" = code, left, right, own earnings, bonus (USD). */
function parseRanks(text: string): Rank[] | null {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 1 || lines.length > 20) return null;
  const ranks: Rank[] = [];
  for (const l of lines) {
    const [code, left, right, self, bonus, ...rest] = l.split(/\s+/);
    if (rest.length || !code || !/^[A-Za-z0-9]{1,12}$/.test(code) || ![left, right, self, bonus].every((x) => x !== undefined && AMOUNT.test(x))) return null;
    ranks.push({ code, left: left!, right: right!, self: self!, bonus: bonus! });
  }
  return new Set(ranks.map((r) => r.code)).size === ranks.length ? ranks : null;
}

const pct = (bps: number) => `${Math.floor(bps / 100)}${bps % 100 ? `.${String(bps % 100).padStart(2, '0').replace(/0$/, '')}` : ''}`;

/**
 * Save a new program policy version (immutable, audited, alerted). Payouts are
 * switched on separately for matching and ranks; each reward still needs an
 * administrator's approval against the funded pool.
 */
export function ProgramPolicyForm({ initial, tokens }: { initial: ProgramFormValue; tokens: { id: number; symbol: string; network: string }[] }) {
  const router = useRouter();
  const [start, setStart] = useState(initial.program_start.slice(0, 10));
  const [mode, setMode] = useState(initial.placement_mode);
  const [matchOn, setMatchOn] = useState(initial.matching.enabled ? 'true' : 'false');
  const [tree, setTree] = useState(initial.matching.tree);
  const [rates, setRates] = useState(initial.matching.levels.map((l) => pct(l.rate_bps)).join(', '));
  const [minLeft, setMinLeft] = useState(initial.matching.min_left);
  const [minRight, setMinRight] = useState(initial.matching.min_right);
  const [minRank, setMinRank] = useState(initial.matching.min_rank ?? '');
  const [rankOn, setRankOn] = useState(initial.ranks.rewards_enabled ? 'true' : 'false');
  const [tokenId, setTokenId] = useState(initial.ranks.token_id ? String(initial.ranks.token_id) : '');
  const [ranksText, setRanksText] = useState(initial.ranks.levels.map((r) => [r.code, r.left, r.right, r.self, r.bonus].join(' ')).join('\n'));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const levels = parseRates(rates);
  const ranks = parseRanks(ranksText);
  const total = levels?.reduce((s, l) => s + l.rate_bps, 0) ?? 0;
  const valid = levels && total <= 10_000 && ranks && AMOUNT.test(minLeft) && AMOUNT.test(minRight) && start && (rankOn === 'false' || tokenId) && note.trim().length >= 10;

  async function submit() {
    if (!levels || !ranks) return;
    const payouts = [matchOn === 'true' && 'matching', rankOn === 'true' && 'rank'].filter(Boolean).join(' and ');
    if (!window.confirm(payouts ? `Switch on ${payouts} rewards, paid from the operator reward pool after your approval of each?` : 'Save with matching and rank payouts off?')) return;
    setBusy(true);
    setMsg(null);
    const r = await apiPost('/api/admin/program-policy', {
      note,
      policy: {
        program_start: new Date(`${start}T00:00:00Z`).toISOString(),
        placement_mode: mode,
        matching: { enabled: matchOn === 'true', tree, levels, min_left: minLeft.trim(), min_right: minRight.trim(), min_rank: minRank || null },
        ranks: { rewards_enabled: rankOn === 'true', token_id: tokenId ? Number(tokenId) : null, levels: ranks },
      },
    });
    setBusy(false);
    if (!r.ok) setMsg({ ok: false, text: r.error ?? 'Failed' });
    else {
      setMsg({ ok: true, text: 'Saved as a new policy version.' });
      setNote('');
      router.refresh();
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Applies to earnings from (UTC)" htmlFor="pp-start">
          <Input id="pp-start" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
        </Field>
        <Field label="Sign-up side already taken" htmlFor="pp-mode" hint="Never switches the side the member chose.">
          <Select id="pp-mode" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
            <option value="outer">Place further down that side</option>
            <option value="direct">Refuse; member picks the other side</option>
          </Select>
        </Field>
      </div>

      <h3 className="pt-2 text-xs font-semibold uppercase tracking-wider text-fg-muted">Matching bonus</h3>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Matching payouts" htmlFor="pp-match">
          <Select id="pp-match" value={matchOn} onChange={(e) => setMatchOn(e.target.value)}>
            <option value="false">Off (information only)</option>
            <option value="true">On</option>
          </Select>
        </Field>
        <Field label="Match earnings along" htmlFor="pp-tree">
          <Select id="pp-tree" value={tree} onChange={(e) => setTree(e.target.value as typeof tree)}>
            <option value="sponsor">Referral line (who referred whom)</option>
            <option value="placement">Team line (left/right positions)</option>
          </Select>
        </Field>
        <Field label="Minimum rank to receive matching" htmlFor="pp-minrank">
          <Select id="pp-minrank" value={minRank} onChange={(e) => setMinRank(e.target.value)}>
            <option value="">None</option>
            {(ranks ?? initial.ranks.levels).map((r) => (
              <option key={r.code} value={r.code}>{r.code}</option>
            ))}
          </Select>
        </Field>
      </div>
      <Field
        label="Rates per level (%)"
        htmlFor="pp-rates"
        error={levels ? (total > 10_000 ? 'All levels together may not exceed 100%' : null) : 'Use the form 5, 5, 4 with at most 10 levels and 2 decimals'}
        hint="Level 1 first. Applied to each operator-funded earning (referral rewards and bonuses for work), never to deposits."
      >
        <Input id="pp-rates" value={rates} onChange={(e) => setRates(e.target.value)} spellCheck={false} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Minimum left team volume (USD)" htmlFor="pp-minl" error={AMOUNT.test(minLeft) ? null : 'Enter an amount'}>
          <Input id="pp-minl" value={minLeft} onChange={(e) => setMinLeft(e.target.value)} inputMode="decimal" />
        </Field>
        <Field label="Minimum right team volume (USD)" htmlFor="pp-minr" error={AMOUNT.test(minRight) ? null : 'Enter an amount'}>
          <Input id="pp-minr" value={minRight} onChange={(e) => setMinRight(e.target.value)} inputMode="decimal" />
        </Field>
      </div>

      <h3 className="pt-2 text-xs font-semibold uppercase tracking-wider text-fg-muted">Ranks</h3>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Rank reward payouts" htmlFor="pp-rank">
          <Select id="pp-rank" value={rankOn} onChange={(e) => setRankOn(e.target.value)}>
            <option value="false">Off (ranks tracked only)</option>
            <option value="true">On</option>
          </Select>
        </Field>
        <Field label="Pay rank rewards in" htmlFor="pp-token" error={rankOn === 'true' && !tokenId ? 'Choose a token' : null}>
          <Select id="pp-token" value={tokenId} onChange={(e) => setTokenId(e.target.value)}>
            <option value="">Choose…</option>
            {tokens.map((t) => (
              <option key={t.id} value={t.id}>{t.symbol} ({t.network})</option>
            ))}
          </Select>
        </Field>
      </div>
      <Field
        label="Rank ladder"
        htmlFor="pp-ranks"
        error={ranks ? null : 'One rank per line: code left right own bonus, e.g. E1 1500 1500 150 50'}
        hint="Per line: code, left team volume, right team volume, own earnings, bonus (all USD). Ranks are reached in this order and kept permanently."
      >
        <Textarea id="pp-ranks" value={ranksText} onChange={(e) => setRanksText(e.target.value)} rows={10} spellCheck={false} className="font-mono text-xs" />
      </Field>

      <Field label="Reason for the change" htmlFor="pp-note">
        <Textarea id="pp-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
      </Field>
      <Button className="h-8 px-3 text-xs" disabled={busy || !valid} onClick={submit}>
        {busy ? '…' : 'Save new version'}
      </Button>
      {msg ? <Notice tone={msg.ok ? 'success' : 'danger'}>{msg.text}</Notice> : null}
    </div>
  );
}
