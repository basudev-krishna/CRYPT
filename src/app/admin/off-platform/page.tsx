import { redirect } from 'next/navigation';

/** Off-platform money now lives on each member's user page. */
export default function OffPlatformPage() {
  redirect('/admin/users');
}
