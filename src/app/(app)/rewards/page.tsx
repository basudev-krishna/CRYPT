import { redirect } from 'next/navigation';

/** Rank and matching now have their own tabs. */
export default function RewardsPage() {
  redirect('/rewards/rank');
}
