import { z } from 'zod';
import { ApiError, body, json, route } from '@/server/http/api';
import { supabaseServer } from '@/server/http/supabase';
import { webDb } from '@/server/db';
import { resolveLoginEmail } from '@/server/signup';

const schema = z.object({ identifier: z.string().trim().min(1).max(254), password: z.string().min(1).max(200) });
const INVALID = 'Invalid username/email or password.';

/** Sign in with a username or email. Sets the Supabase session cookies on success. */
export const POST = route(
  async (req) => {
    const { identifier, password } = await body(req, schema);
    const email = await resolveLoginEmail(webDb(), identifier);
    if (!email) throw new ApiError(INVALID, 401, 'invalid_credentials');
    const supabase = await supabaseServer();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      if (error.code === 'email_not_confirmed') throw new ApiError('Please verify your email address first.', 403, 'email_unverified');
      throw new ApiError(INVALID, 401, 'invalid_credentials');
    }
    const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    return json({ next: data?.nextLevel === 'aal2' && data.currentLevel !== 'aal2' ? '/login/mfa' : '/dashboard' });
  },
  { limit: 10, windowSeconds: 300 },
);
