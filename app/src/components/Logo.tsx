import Link from "next/link";
import { LOGO_VIEWBOX, MARK_BAR, MARK_STROKE, MARK_VIEWBOX, WORDMARK } from "@/lib/brand";

/** The F mark alone. */
export function Mark({ className = "h-6 w-auto" }: { className?: string }) {
  return (
    <svg viewBox={MARK_VIEWBOX} className={className} aria-hidden>
      <path d={MARK_STROKE} fill="var(--ink)" fillRule="evenodd" />
      <path d={MARK_BAR} fill="var(--ink)" fillRule="evenodd" />
    </svg>
  );
}

/** Mark plus the lowercase wordmark, as one lockup. */
export function Logo({ href = "/", className = "h-[22px] w-auto" }: { href?: string; className?: string }) {
  return (
    <Link href={href} aria-label="FORGE home" className="flex shrink-0 items-center">
      <svg viewBox={LOGO_VIEWBOX} className={className} role="img" aria-label="forge">
        <path d={MARK_STROKE} fill="var(--ink)" fillRule="evenodd" />
        <path d={MARK_BAR} fill="var(--ink)" fillRule="evenodd" />
        <path d={WORDMARK} fill="var(--ink)" fillRule="evenodd" />
      </svg>
    </Link>
  );
}
