'use client';
import { Button, Notice } from '@/components/ui/primitives';

export default function AppError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="mx-auto max-w-lg py-16">
      <Notice tone="danger" title="This page could not be loaded">
        Your balances are unaffected. Please try again; if the problem continues, contact support.
      </Notice>
      <Button className="mt-4" variant="secondary" onClick={reset}>
        Retry
      </Button>
    </div>
  );
}
