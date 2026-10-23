import { describe, expect, it } from 'vitest';
import { registerSchema } from '../../src/server/signup';

const valid = {
  fullName: '  Asha Rao ',
  username: 'Asha_Rao',
  email: ' Asha@Example.com ',
  phone: '+91 98765-43210',
  countryCode: 'IN',
  password: 'Strong-Password-2026',
  referralCode: ' ew-000123 ',
  acceptTerms: true,
};

describe('registerSchema', () => {
  it('normalises username, email, phone and referral id', () => {
    expect(registerSchema.parse(valid)).toEqual({
      fullName: 'Asha Rao',
      username: 'asha_rao',
      email: 'asha@example.com',
      phone: '+919876543210',
      countryCode: 'IN',
      password: 'Strong-Password-2026',
      referralCode: 'EW-000123',
      acceptTerms: true,
    });
  });

  it('treats a blank or missing referral id as none', () => {
    expect(registerSchema.parse({ ...valid, referralCode: '  ' }).referralCode).toBeNull();
    const withoutReferral = Object.fromEntries(Object.entries(valid).filter(([k]) => k !== 'referralCode'));
    expect(registerSchema.parse(withoutReferral).referralCode).toBeNull();
  });

  it('rejects bad usernames, phones, weak passwords, unknown formats and unaccepted terms', () => {
    for (const bad of [
      { username: 'abc' },
      { username: 'has space' },
      { username: 'a'.repeat(21) },
      { phone: '9876543210' },
      { phone: '+0123456789' },
      { password: 'short1A' },
      { password: 'alllowercase2026x' },
      { password: 'NoDigitsInThisOne' },
      { countryCode: 'India' },
      { referralCode: 'FRIEND' },
      { email: 'not-an-email' },
      { acceptTerms: false },
    ]) {
      expect(registerSchema.safeParse({ ...valid, ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });
});
