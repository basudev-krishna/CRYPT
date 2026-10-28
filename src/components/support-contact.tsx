import type { ReactNode } from 'react';
import { MessageCircle, Send } from 'lucide-react';

/*
 * EliteWhale's contact details and own description (from the group's presentation),
 * shared by the landing page and the member Support page so they never drift apart.
 */

export const SUPPORT_EMAIL = 'elitewhaleofficial@gmail.com';

export const ELITEWHALE_ABOUT = [
  'EliteWhale is a Web3 ecosystem built for real utility, transparent trading, staking and sustainable digital-asset participation.',
  'Powered by blockchain technology and community-driven development, EliteWhale aims to build a secure, scalable and innovative ecosystem for the next generation of Web3 users.',
] as const;

export const ELITEWHALE_VISION =
  'To build a globally accessible Web3 ecosystem where decentralization, transparency and real utility empower people to participate in the future of digital finance.';

export const ELITEWHALE_MISSION =
  'To develop a secure and scalable ecosystem combining staking, trading, blockchain technology and community-driven innovation, while focusing on sustainable utility and long-term Web3 adoption.';

/* lucide-react has no brand icons, so these three are simple outlines in the same stroke style. */
function FacebookIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z" />
    </svg>
  );
}

function InstagramIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2" y="2" width="20" height="20" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <line x1="17.5" y1="6.5" x2="17.51" y2="6.5" />
    </svg>
  );
}

function YoutubeIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2" y="5" width="20" height="14" rx="4" />
      <path d="m10 9 5 3-5 3z" />
    </svg>
  );
}

/** EliteWhale's official profiles and channels. */
export const SOCIAL_LINKS: { label: string; href: string; icon: (props: { size?: number }) => ReactNode }[] = [
  { label: 'Facebook', href: 'https://www.facebook.com/share/1E8egN8ems/', icon: FacebookIcon },
  { label: 'Instagram', href: 'https://www.instagram.com/elitewhaleofficial', icon: InstagramIcon },
  { label: 'Telegram', href: 'https://t.me/elitewhaleofficialtelegram', icon: ({ size }) => <Send size={size} aria-hidden /> },
  { label: 'YouTube', href: 'https://youtube.com/@elitewhale_7', icon: YoutubeIcon },
  { label: 'WhatsApp channel', href: 'https://whatsapp.com/channel/0029Vb8VaWvCRs1lIl5Q4z0G', icon: ({ size }) => <MessageCircle size={size} aria-hidden /> },
];
