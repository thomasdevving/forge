import Link from "next/link";
import { Logo } from "@/components/Logo";
import { config } from "@/lib/config";
import { MobileMenu } from "./MobileMenu";
import { ModeNavLinks } from "./mode";
import { NavShell } from "./NavShell";

/** Site header for the landing page and the docs. `solid` skips the transparent-over-hero state. */
export function SiteNav({ solid = false }: { solid?: boolean }) {
  return (
  <NavShell solid={solid}>
      <div className="mx-auto flex h-14 max-w-[1480px] items-center gap-8 px-5 sm:px-8">
        <Logo />
        <nav className="hidden items-center gap-5 whitespace-nowrap text-[14px] text-ink-2 md:flex lg:gap-7">
          <ModeNavLinks className="transition-colors hover:text-ink" />
          <Link href="/proof" className="transition-colors hover:text-ink">Proof</Link>
          <Link href="/docs" className="transition-colors hover:text-ink">Docs</Link>
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <a href={config.repoUrl} className="btn btn-ghost !py-1.5 max-sm:!hidden md:max-lg:!hidden" target="_blank" rel="noreferrer">
            <svg viewBox="0 0 16 16" className="size-4" fill="currentColor" aria-hidden><path d="M8 0a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38v-1.34c-2.23.48-2.7-1.07-2.7-1.07-.36-.92-.89-1.17-.89-1.17-.73-.5.05-.49.05-.49.8.06 1.23.83 1.23.83.71 1.22 1.87.87 2.33.66.07-.52.28-.87.5-1.07-1.78-.2-3.65-.89-3.65-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.28.82 2.15 0 3.07-1.87 3.75-3.66 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0 0 8 0Z" /></svg>
            GitHub
          </a>
          <MobileMenu />
          <Link href="/studio" className="btn btn-primary !py-1.5">Launch App <span aria-hidden>↗</span></Link>
        </div>
      </div>
  </NavShell>
  );
}
