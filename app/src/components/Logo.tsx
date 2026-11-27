import Link from "next/link";

export function Logo({ href = "/" }: { href?: string }) {
  return (
    <Link href={href} className="flex items-center gap-2.5 font-display text-[17px] font-bold tracking-tight">
      <svg viewBox="0 0 32 32" className="size-7" aria-hidden>
        <rect width="32" height="32" rx="8" fill="var(--ink)" />
        <path d="M6 21 C 11 21 12 10 16 10 S 21 21 26 21" fill="none" stroke="var(--ember)" strokeWidth="2.8" strokeLinecap="round" />
        <rect x="7" y="23.5" width="4" height="2.2" rx="1.1" fill="var(--ember-2)" />
        <rect x="14" y="23.5" width="4" height="2.2" rx="1.1" fill="var(--ember-2)" />
        <rect x="21" y="23.5" width="4" height="2.2" rx="1.1" fill="var(--ember-2)" />
      </svg>
      FORGE
    </Link>
  );
}
