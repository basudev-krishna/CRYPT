'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiPost } from '@/lib/api-client';
import { Button, Field, Input, Mono, Notice, Select, Textarea } from '@/components/ui/primitives';

interface Issued {
  email: string;
  code: string;
  expiresAt: string;
  sponsorMemberCode: string | null;
}

/** Issue a single-use invitation. The code is displayed once here and never again. */
export function InviteForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<Issued | null>(null);
  const link = issued ? `${window.location.origin}/register?invite=${encodeURIComponent(issued.code)}&email=${encodeURIComponent(issued.email)}` : '';
  return (
    <div className="space-y-4">
      <form
        className="grid gap-4 sm:grid-cols-2"
        onSubmit={async (e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const f = new FormData(form);
          setBusy(true);
          setError(null);
          setIssued(null);
          const r = await apiPost<Issued>('/api/admin/invitations', {
            email: String(f.get('email')),
            sponsorMemberCode: String(f.get('sponsor') ?? '').trim() || null,
            validDays: Number(f.get('days')),
            note: String(f.get('note')),
          });
          setBusy(false);
          if (!r.ok || !r.data) return setError(r.error ?? 'Failed');
          setIssued(r.data);
          form.reset();
          router.refresh();
        }}
      >
        <Field label="Email" htmlFor="invite-email">
          <Input id="invite-email" name="email" type="email" required />
        </Field>
        <Field label="Sponsor member id (optional)" htmlFor="invite-sponsor" hint="The existing member who vouches for this person.">
          <Input id="invite-sponsor" name="sponsor" placeholder="EW-000001" maxLength={20} />
        </Field>
        <Field label="Valid for" htmlFor="invite-days">
          <Select id="invite-days" name="days" defaultValue="14">
            <option value="7">7 days</option>
            <option value="14">14 days</option>
            <option value="30">30 days</option>
          </Select>
        </Field>
        <Field label="Documented reason" htmlFor="invite-note" hint="Who this is and why they are being admitted (min 10 characters).">
          <Textarea id="invite-note" name="note" required minLength={10} maxLength={500} className="h-16" />
        </Field>
        <div className="sm:col-span-2">
          <Button type="submit" disabled={busy}>{busy ? 'Issuing…' : 'Issue invitation'}</Button>
        </div>
      </form>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {issued ? (
        <Notice tone="success" title={`Invitation for ${issued.email}`}>
          <p>Send this link to the invitee over a channel you trust. It works once, only for this email, and is not shown again.</p>
          <p className="mt-2 break-all"><Mono>{link}</Mono></p>
          <p className="mt-2">Code: <Mono>{issued.code}</Mono></p>
        </Notice>
      ) : null}
    </div>
  );
}
