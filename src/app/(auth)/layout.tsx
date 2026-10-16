import { Logo } from '@/components/app/shell';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-[calc(100vh-30px)] max-w-md flex-col justify-center px-4 py-12">
      <div className="mb-8 flex justify-center">
        <Logo />
      </div>
      {children}
    </div>
  );
}
