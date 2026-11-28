import type { Metadata } from "next";
import Link from "next/link";
import { SiteNav } from "@/components/landing/SiteNav";

export const metadata: Metadata = { title: "Not found · FORGE" };

/** 404 for unknown pages: say so plainly and offer the likely next steps. */
export default function NotFound() {
  return (
    <div className="min-h-dvh bg-bg">
      <SiteNav solid />
      <main className="mx-auto flex min-h-dvh max-w-[640px] flex-col justify-center px-5 pb-24 pt-24 sm:px-8">
        <div className="cap num uppercase tracking-[0.18em]">404</div>
        <h1 className="mt-3 text-[32px] font-semibold leading-tight tracking-tight text-ink">This page does not exist.</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-ink-2">The link may be old or mistyped. These are the places most people look for:</p>
        <div className="mt-8 flex flex-wrap gap-2">
          <Link href="/studio" className="btn btn-primary !px-5 !py-2.5">Open the Studio</Link>
          <Link href="/docs" className="btn btn-ghost !px-5 !py-2.5">Read the docs</Link>
          <Link href="/" className="btn btn-ghost !px-5 !py-2.5">Home</Link>
        </div>
      </main>
    </div>
  );
}
