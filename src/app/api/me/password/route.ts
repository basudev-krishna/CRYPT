import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { requestActor, requireUser } from '@/server/http/auth';
import { ApiError, body, json, route } from '@/server/http/api';
import { supabaseServer } from '@/server/http/supabase';
import { withWebTransaction } from '@/server/db';
import { serverEnv } from '@/server/env';
import { recordAudit } from '@/server/ops';
import { registerSchema } from '@/server/signup';

const schema = z.object({ currentPassword: z.string().min(1).max(200), newPassword: registerSchema.shape.password });

/**
 * Change the signed-in member's password, e.g. one an administrator chose when
 * creating the account. The current password is checked first, on a cookieless
 * client, so a borrowed open session alone cannot take the account over.
 */
export const POST = route(
  async (req) => {
    const user = await requireUser();
    const { currentPassword, newPassword } = await body(req, schema);
    const env = serverEnv();
    const check = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { error: wrong } = await check.auth.signInWithPassword({ email: user.email, password: currentPassword });
    if (wrong) throw new ApiError('Your current password is not correct.', 422, 'invalid_current_password');
    await check.auth.signOut({ scope: 'local' });
    const { error } = await (await supabaseServer()).auth.updateUser({ password: newPassword });
    if (error) {
      if (error.code === 'same_password') throw new ApiError('Choose a password different from the current one.', 422, 'same_password');
      if (error.code === 'weak_password') throw new ApiError(error.message, 422, 'weak_password');
      throw new ApiError('The password could not be changed. Try again in a few minutes.', 422, 'password_change_failed');
    }
    const actor = await requestActor(user);
    await withWebTransaction((db) => recordAudit(db, actor, 'auth.password_changed', { type: 'user', id: user.id }));
    return json({ ok: true });
  },
  { limit: 5, windowSeconds: 300 },
);
