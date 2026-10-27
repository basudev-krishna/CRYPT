'use client';
import { useState, useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/primitives';

const noSubscribe = () => () => {};

/** The member's sign-up link. Built from the page origin so it matches whichever host they use. */
export function ReferralLink({ memberCode }: { memberCode: string }) {
  const path = `/register?ref=${encodeURIComponent(memberCode)}`;
  const origin = useSyncExternalStore(noSubscribe, () => window.location.origin, () => '');
  const link = origin + path;
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <code className="break-all rounded-lg bg-surface-3 px-2.5 py-1.5 font-mono text-xs">{link}</code>
      <Button
        variant="secondary"
        className="h-8 px-3 text-xs"
        onClick={async () => {
          await navigator.clipboard.writeText(link);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? 'Copied' : 'Copy link'}
      </Button>
    </div>
  );
}
