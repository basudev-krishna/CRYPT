import { AppShell } from '@/components/app/shell';
import { pageUser } from '@/server/http/auth';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await pageUser();
  return (
    <AppShell email={user.email} isStaff={user.roles.length > 0}>
      {children}
    </AppShell>
  );
}
