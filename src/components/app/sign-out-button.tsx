'use client';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '@/lib/supabase/browser';

export function SignOutButton() {
  const router = useRouter();
  return (
    <button
      type="button"
      className="rounded-full px-3 py-1.5 text-sm text-fg-muted transition hover:bg-white hover:text-fg hover:ring-1 hover:ring-line"
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
