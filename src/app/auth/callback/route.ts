import { NextResponse, type NextRequest } from 'next/server';
import { supabaseServer } from '@/server/http/supabase';

/** Email confirmation / password recovery landing: exchange the PKCE code for a session. */
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code');
  const nextParam = req.nextUrl.searchParams.get('next') ?? '/dashboard';
  // Only allow same-site relative redirects.
  const next = nextParam.startsWith('/') && !nextParam.startsWith('//') ? nextParam : '/dashboard';
  if (code) {
    const supabase = await supabaseServer();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL(next, req.url));
  }
  return NextResponse.redirect(new URL('/login?notice=verify', req.url));
}
