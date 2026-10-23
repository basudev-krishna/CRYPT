export function JsonBlock({ value }: { value: unknown }) {
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-fg-subtle hover:text-fg">details</summary>
      <pre className="mt-2 max-h-64 max-w-xl overflow-auto rounded-xl bg-surface-3 p-3 font-mono text-[11px] text-fg-muted">{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}
