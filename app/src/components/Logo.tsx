import Link from "next/link";
import { LOGO_VIEWBOX, MARK_BOTTOM, MARK_IN_LOGO, MARK_TOP, MARK_VIEWBOX, WORDMARK, WORDMARK_IN_LOGO } from "@/lib/brand";

/** The mark alone. */
export function Mark({ className = "h-6 w-auto" }: { className?: string }) {
  return (
    <svg viewBox={MARK_VIEWBOX} className={className} aria-hidden>
      <path d={MARK_TOP} fill="var(--ink)" />
      <path d={MARK_BOTTOM} fill="var(--ink)" />
    </svg>
  );
}

/** Mark plus the lowercase wordmark, as one lockup. */
export function Logo({ href = "/", className = "h-[22px] w-auto" }: { href?: string; className?: string }) {
  return (
    <Link href={href} aria-label="FORGE home" className="flex shrink-0 items-center">
      <svg viewBox={LOGO_VIEWBOX} className={className} role="img" aria-label="forge">
        <g transform={MARK_IN_LOGO}>
          <path d={MARK_TOP} fill="var(--ink)" />
          <path d={MARK_BOTTOM} fill="var(--ink)" />
        </g>
        <path d={WORDMARK} transform={WORDMARK_IN_LOGO} fill="var(--ink)" fillRule="evenodd" />
      </svg>
    </Link>
  );
}
