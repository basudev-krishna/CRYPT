import { AppShell } from '@/components/app/shell';
import { pageStaff } from '@/server/http/auth';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const staff = await pageStaff();
  return (
    <AppShell email={`${staff.email} · ${staff.roles.join(', ')}`} isStaff variant="admin">
      {children}
    </AppShell>
  );
}
