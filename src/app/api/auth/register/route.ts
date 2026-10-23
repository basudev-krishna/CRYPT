import { ApiError, body, json, route } from '@/server/http/api';
import { supabaseServer } from '@/server/http/supabase';
import { webDb } from '@/server/db';
import { checkRegistration, registerSchema } from '@/server/signup';

/**
 * Open registration. The account starts 'pending_approval' (set by the auth
 * trigger) and stays unusable until an administrator approves it.
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
        data: { full_name: input.fullName, username: input.username, phone: input.phone, country_code: input.countryCode, referral_code: input.referralCode },
      },
    });
    if (error) {
      if (error.code === 'user_already_exists' || error.code === 'email_exists') throw new ApiError('An account with this email already exists. Sign in instead.', 422, 'email_taken');
      if (/sending.*email/i.test(error.message)) throw new ApiError('We could not send the verification email. Please contact support.', 422, 'email_send_failed');
      if (error.code === 'weak_password') throw new ApiError(error.message, 422, 'weak_password');
      // The only database error a validated sign-up can hit is losing a username race.
      if (/database error/i.test(error.message)) throw new ApiError('That username is taken. Choose another.', 422, 'username_taken');
      throw new ApiError('Registration failed. Try again in a few minutes.', 422, 'signup_failed');
    }
    return json({ signedIn: Boolean(data.session) });
  },
  { limit: 5, windowSeconds: 600 },
);
