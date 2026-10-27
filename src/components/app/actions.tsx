'use client';
import { useRouter } from 'next/navigation';
import { useId, useRef, useState, type ReactNode } from 'react';
import { apiPost, newIdempotencyKey } from '@/lib/api-client';
import { supabaseBrowser } from '@/lib/supabase/browser';
import { Button, Field, Input, Notice, Select, Textarea } from '@/components/ui/primitives';

/** POST to an endpoint, then refresh server data. */
export function ActionButton({
  url,
  body,
  children,
  confirmText,
  variant = 'secondary',
  idempotent = false,
}: {
  url: string;
  body?: unknown;
  children: ReactNode;
  confirmText?: string;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  idempotent?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef(newIdempotencyKey());
  return (
    <span className="inline-flex flex-col gap-1">
      <Button
        variant={variant}
        className="h-8 px-3 text-xs"
        disabled={busy}
        onClick={async () => {
          if (confirmText && !window.confirm(confirmText)) return;
          setBusy(true);
          setError(null);
          const r = await apiPost(url, body ?? {}, idempotent ? { idempotencyKey: key.current } : {});
          setBusy(false);
          if (!r.ok) setError(r.error ?? 'Failed');
          else router.refresh();
        }}
      >
        {busy ? '…' : children}
      </Button>
      {error ? (
        <span role="alert" className="text-xs text-loss">
          {error}
        </span>
      ) : null}
    </span>
  );
}

/** Staff decision with a mandatory documented note (min 10 chars). */
export function NoteAction({
  url,
  options,
  extra,
  submitLabel = 'Submit',
  noteLabel = 'Documented reason',
  noteField = 'note',
}: {
  url: string;
  /** Choices for a single field (e.g. decision); values are sent as-is, 'true'/'false' as booleans. */
  options?: { value: string; label: string; field: string }[];
  extra?: Record<string, unknown>;
  submitLabel?: string;
  noteLabel?: string;
  noteField?: 'note' | 'reason';
}) {
  const router = useRouter();
  const [note, setNote] = useState('');
  const [choice, setChoice] = useState(options?.[0]?.value ?? '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const id = useId();
  const field = options?.[0]?.field;
  return (
    <form
      className="space-y-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setMsg(null);
        const payload: Record<string, unknown> = { ...extra, [noteField]: note };
        if (field) payload[field] = choice === 'true' ? true : choice === 'false' ? false : choice;
        const r = await apiPost(url, payload);
        setBusy(false);
        setMsg(r.ok ? { ok: true, text: 'Saved' } : { ok: false, text: r.error ?? 'Failed' });
        if (r.ok) {
          setNote('');
          router.refresh();
        }
      }}
    >
      {options ? (
        <Select aria-label="Decision" value={choice} onChange={(e) => setChoice(e.target.value)} className="h-8 text-xs">
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      ) : null}
      <label htmlFor={id} className="sr-only">
        {noteLabel}
      </label>
      <Textarea id={id} placeholder={`${noteLabel} (min 10 characters)`} value={note} onChange={(e) => setNote(e.target.value)} className="h-16 text-xs" />
      <div className="flex items-center gap-2">
        <Button type="submit" variant="secondary" className="h-8 px-3 text-xs" disabled={busy || note.trim().length < 10}>
          {busy ? '…' : submitLabel}
        </Button>
        {msg ? <span className={msg.ok ? 'text-xs text-gain' : 'text-xs text-loss'}>{msg.text}</span> : null}
      </div>
    </form>
  );
}

export function InvestForm({ poolId, symbol, availableDisplay }: { poolId: number; symbol: string; availableDisplay: string }) {
  const router = useRouter();
  const [amount, setAmount] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const key = useRef(newIdempotencyKey());
  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        const r = await apiPost('/api/investments/subscribe', { poolId, amount: amount.trim() }, { idempotencyKey: key.current });
        setMsg(r.ok ? { ok: true, text: 'Queued for the next NAV strike.' } : { ok: false, text: r.error ?? 'Failed' });
        if (r.ok) {
          key.current = newIdempotencyKey();
          setAmount('');
          router.refresh();
        }
      }}
    >
      <Field label={`Invest available cash (${symbol})`} htmlFor="invest-amount" hint={`Available: ${availableDisplay}`}>
        <Input id="invest-amount" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" className="w-44" />
      </Field>
      <Button type="submit" variant="secondary" disabled={!amount}>
        Invest
      </Button>
      {msg ? <p className={msg.ok ? 'w-full text-xs text-gain' : 'w-full text-xs text-loss'}>{msg.text}</p> : null}
    </form>
  );
}

export function RedeemForm({ poolId, freeUnits }: { poolId: number; freeUnits: string }) {
  const router = useRouter();
  const [units, setUnits] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const key = useRef(newIdempotencyKey());
  const submit = async (all: boolean) => {
    const r = await apiPost('/api/investments/redeem', { poolId, units: all ? null : units.trim() }, { idempotencyKey: key.current });
    setMsg(r.ok ? { ok: true, text: 'Redemption queued for the next NAV strike. Proceeds arrive in your available balance.' } : { ok: false, text: r.error ?? 'Failed' });
    if (r.ok) {
      key.current = newIdempotencyKey();
      setUnits('');
      router.refresh();
    }
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Redeem units" htmlFor="redeem-units" hint={`Redeemable: ${freeUnits} units`}>
          <Input id="redeem-units" value={units} onChange={(e) => setUnits(e.target.value)} inputMode="decimal" className="w-44" />
        </Field>
        <Button variant="secondary" disabled={!units} onClick={() => submit(false)}>
          Redeem
        </Button>
        <Button variant="ghost" onClick={() => window.confirm('Redeem all units at the next NAV strike?') && submit(true)}>
          Redeem all
        </Button>
      </div>
      {msg ? <p className={msg.ok ? 'text-xs text-gain' : 'text-xs text-loss'}>{msg.text}</p> : null}
    </div>
  );
}

export function ProfileForm({ displayName, countryCode }: { displayName: string | null; countryCode: string | null }) {
  const router = useRouter();
  const [name, setName] = useState(displayName ?? '');
  const [country, setCountry] = useState(countryCode ?? '');
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <form
      className="grid gap-4 sm:grid-cols-[1fr_140px_auto] sm:items-end"
      onSubmit={async (e) => {
        e.preventDefault();
        const r = await apiPost('/api/profile', { displayName: name.trim() || null, countryCode: country.trim().toUpperCase() || null });
        setMsg(r.ok ? 'Saved' : (r.error ?? 'Failed'));
        if (r.ok) router.refresh();
      }}
    >
      <Field label="Display name" htmlFor="display-name">
        <Input id="display-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
      </Field>
      <Field label="Country (ISO)" htmlFor="country">
        <Input id="country" value={country} onChange={(e) => setCountry(e.target.value)} maxLength={2} placeholder="IN" />
      </Field>
      <Button type="submit" variant="secondary">
        Save
      </Button>
      {msg ? <p className="text-xs text-fg-muted sm:col-span-3">{msg}</p> : null}
    </form>
  );
}

export function KycForm() {
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="grid gap-4 sm:grid-cols-2"
      onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        setBusy(true);
        const r = await apiPost('/api/kyc', {
          fullName: String(f.get('fullName')),
          dateOfBirth: String(f.get('dob')),
          countryCode: String(f.get('country')).toUpperCase(),
          documentType: String(f.get('docType')),
          documentLast4: String(f.get('docLast4')),
        });
        setBusy(false);
        if (r.ok) router.refresh();
        else setErr(r.error ?? 'Failed');
      }}
    >
      <Field label="Full legal name" htmlFor="fullName">
        <Input id="fullName" name="fullName" required minLength={3} autoComplete="name" />
      </Field>
      <Field label="Date of birth" htmlFor="dob">
        <Input id="dob" name="dob" type="date" required autoComplete="bday" />
      </Field>
      <Field label="Country of residence (ISO)" htmlFor="country">
        <Input id="country" name="country" required maxLength={2} placeholder="IN" />
      </Field>
      <Field label="Document type" htmlFor="docType">
        <Select id="docType" name="docType">
          <option value="passport">Passport</option>
          <option value="national_id">National ID</option>
          <option value="driving_licence">Driving licence</option>
        </Select>
      </Field>
      <Field label="Last 4 characters of document number" htmlFor="docLast4" hint="Only these four characters are stored.">
        <Input id="docLast4" name="docLast4" required pattern="[A-Za-z0-9]{4}" maxLength={4} />
      </Field>
      <div className="flex items-end">
        <Button type="submit" disabled={busy}>
          Submit for review
        </Button>
      </div>
      {err ? (
        <div className="sm:col-span-2">
          <Notice tone="danger">{err}</Notice>
        </div>
      ) : null}
    </form>
  );
}

/** TOTP enrolment through Supabase Auth MFA. */
export function MfaEnroll({ enrolled }: { enrolled: boolean }) {
  const router = useRouter();
  const [factor, setFactor] = useState<{ id: string; qr: string; secret: string } | null>(null);
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null);
  if (enrolled) {
    return (
      <div className="space-y-3">
        <Notice tone="success">An authenticator app is enrolled. You will be asked for a code at sign-in and to authorise withdrawals.</Notice>
        <Button
          variant="secondary"
          onClick={async () => {
            await supabaseBrowser().auth.signOut({ scope: 'global' });
            router.replace('/login');
          }}
        >
          Sign out of all devices
        </Button>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      {!factor ? (
        <Button
          onClick={async () => {
            setErr(null);
            const { data, error } = await supabaseBrowser().auth.mfa.enroll({ factorType: 'totp', friendlyName: `Authenticator ${new Date().toISOString().slice(0, 10)}` });
            if (error || !data) return setErr(error?.message ?? 'Enrolment failed');
            setFactor({ id: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
          }}
        >
          Set up authenticator app
        </Button>
      ) : (
        <div className="grid gap-4 sm:grid-cols-[200px_1fr]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={factor.qr} alt="Authenticator QR code" width={200} height={200} className="rounded-lg bg-white p-2" />
          <div className="space-y-3">
            <p className="text-sm text-fg-muted">Scan the QR code, or enter this key manually:</p>
            <code className="block break-all rounded-lg bg-surface-3 px-2.5 py-1.5 font-mono text-xs" data-testid="totp-secret">
              {factor.secret}
            </code>
            <Field label="6-digit code" htmlFor="totp-code">
              <Input id="totp-code" value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" maxLength={6} />
            </Field>
            <Button
              onClick={async () => {
                const { error } = await supabaseBrowser().auth.mfa.challengeAndVerify({ factorId: factor.id, code: code.trim() });
                if (error) return setErr('Code not accepted. Check the time on your device and try again.');
                router.refresh();
              }}
            >
              Verify and enable
            </Button>
          </div>
        </div>
      )}
      {err ? <Notice tone="danger">{err}</Notice> : null}
    </div>
  );
}
