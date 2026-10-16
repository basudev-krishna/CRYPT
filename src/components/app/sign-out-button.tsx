'use client';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '@/lib/supabase/browser';

export function SignOutButton() {
  const router = useRouter();
  return (
    <button
      type="button"
      className="rounded-md px-2 py-1 text-sm text-fg-muted hover:bg-surface-3 hover:text-fg"
      onClick={async () => {
        await supabaseBrowser().auth.signOut();
        router.replace('/login');
        router.refresh();
      }}
    >
      Sign out
    </button>
  );
}
