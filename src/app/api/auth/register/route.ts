import { ApiError, body, json, route } from '@/server/http/api';
import { supabaseServer } from '@/server/http/supabase';
import { webDb } from '@/server/db';
import { maybeOne } from '@/server/db-core';
import { checkRegistration, registerSchema } from '@/server/signup';

/**
 * Open registration. The account starts 'active' (set by the auth trigger) and
 * can be used as soon as the member signs in. With a referral id, the chosen
 * team side is placed by the same trigger, atomically with the account.
 */
export const POST = route(
  async (req) => {
    const input = await body(req, registerSchema);
    await checkRegistration(webDb(), input);
    const supabase = await supabaseServer();
    const { data, error } = await supabase.auth.signUp({
      email: input.email,
      password: input.password,
      options: {
        emailRedirectTo: `${req.nextUrl.origin}/auth/callback?next=/dashboard`,
        // Copied into the profile once by the auth trigger; never read from metadata again.
        data: { full_name: input.fullName, username: input.username, phone: input.phone, country_code: input.countryCode, referral_code: input.referralCode, team_side: input.teamSide },
      },
    });
    if (error) {
      if (error.code === 'user_already_exists' || error.code === 'email_exists') throw new ApiError('An account with this email already exists. Sign in instead.', 422, 'email_taken');
      if (/sending.*email/i.test(error.message)) throw new ApiError('We could not send the verification email. Please contact support.', 422, 'email_send_failed');
      if (error.code === 'weak_password') throw new ApiError(error.message, 422, 'weak_password');
      // A validated sign-up can only hit a database error by losing a race for the username or the team position: re-check to say which.
      if (/database error/i.test(error.message)) {
        await checkRegistration(webDb(), input);
        if (input.referralCode) throw new ApiError('That team position was just taken. Choose again.', 422, 'position_taken');
        throw new ApiError('That username is taken. Choose another.', 422, 'username_taken');
      }
      throw new ApiError('Registration failed. Try again in a few minutes.', 422, 'signup_failed');
    }
    // By the new account's id, never the email: for an existing address Auth may answer with a stand-in user.
    const placement =
      input.referralCode && data.user
        ? await maybeOne<{ side: string; parent_code: string }>(
            webDb(),
            `select b.side, p.member_code as parent_code from public.binary_placements b
               join public.user_profiles p on p.user_id = b.parent_user_id where b.user_id = $1`,
            [data.user.id],
          )
        : null;
    return json({ signedIn: Boolean(data.session), placement: placement ? { side: placement.side, parentCode: placement.parent_code } : null });
  },
  { limit: 5, windowSeconds: 600 },
);
