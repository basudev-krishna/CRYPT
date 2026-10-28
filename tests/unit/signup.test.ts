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
  teamSide: 'right',
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
      teamSide: 'right',
    });
  });

  it('accepts only left or right as the team side', () => {
    expect(registerSchema.parse({ ...valid, teamSide: 'left' }).teamSide).toBe('left');
    expect(registerSchema.safeParse({ ...valid, teamSide: null }).success).toBe(false);
    expect(registerSchema.safeParse({ ...valid, teamSide: undefined }).success).toBe(false);
    expect(registerSchema.safeParse({ ...valid, teamSide: 'middle' }).success).toBe(false);
  });

  it('requires a referral id', () => {
    expect(registerSchema.safeParse({ ...valid, referralCode: '  ' }).success).toBe(false);
    const withoutReferral = Object.fromEntries(Object.entries(valid).filter(([k]) => k !== 'referralCode'));
    expect(registerSchema.safeParse(withoutReferral).success).toBe(false);
  });

  it('rejects bad usernames, phones, weak passwords and unknown formats', () => {
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
    ]) {
      expect(registerSchema.safeParse({ ...valid, ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });
});
