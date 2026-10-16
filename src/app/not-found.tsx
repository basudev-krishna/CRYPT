import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="mx-auto max-w-md py-24 text-center">
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <Link href="/" className="mt-4 inline-block text-accent hover:underline">Go home</Link>
    </div>
  );
}
