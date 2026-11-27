"use client";

import { type ReactNode, useEffect, useState } from "react";

/** The landing has two views: for traders ("people") and for agents. The URL (?for=agents) holds it. */
export type Mode = "people" | "agents";
export const MODE_EVENT = "forge:hero-mode";

/** Reads the view from the URL and follows changes from the toggle, links and history. */
export function useMode(): Mode {
  const [mode, setMode] = useState<Mode>("people");
  useEffect(() => {
    if (window.location.pathname !== "/") return;
    const read = () => setMode(new URLSearchParams(window.location.search).get("for") === "agents" ? "agents" : "people");
    read();
    const onEvent = (e: Event) => setMode((e as CustomEvent<Mode>).detail);
    window.addEventListener("popstate", read);
    window.addEventListener(MODE_EVENT, onEvent);
    return () => {
      window.removeEventListener("popstate", read);
      window.removeEventListener(MODE_EVENT, onEvent);
    };
  }, []);
  return mode;
}

export function switchMode(m: Mode, opts: { dropHash?: boolean; scrollTop?: boolean } = {}) {
  writeMode(m, opts.dropHash);
  window.dispatchEvent(new CustomEvent<Mode>(MODE_EVENT, { detail: m }));
  if (opts.scrollTop) window.scrollTo({ top: 0, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}

/** Writes the hero mode into the URL (?for=agents) without a navigation, keeping the hash. */
export function writeMode(mode: Mode, dropHash = false) {
  const url = new URL(window.location.href);
  if (dropHash) url.hash = "";
  if (mode === "agents") url.searchParams.set("for", "agents");
  else url.searchParams.delete("for");
  window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
}


/** Link elsewhere on the landing that switches to the agents' view and scrolls up to the agent run. */
export function ShowAgentRun({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <a
      href="/?for=agents"
      className={className}
      onClick={(e) => {
        e.preventDefault();
        switchMode("agents", { dropHash: true, scrollTop: true });
      }}
    >
      {children}
    </a>
  );
}

/** Top-menu link to the other view: "For agents" on the traders' page, "For traders" on the agents' page. */
export function OtherModeLink({ className = "" }: { className?: string }) {
  const mode = useMode();
  const next: Mode = mode === "agents" ? "people" : "agents";
  return (
    <a
      href={next === "agents" ? "/?for=agents" : "/"}
      className={className}
      onClick={(e) => {
        if (window.location.pathname !== "/") return;
        e.preventDefault();
        switchMode(next, { dropHash: true, scrollTop: true });
      }}
    >
      {next === "agents" ? "For agents" : "For traders"}
    </a>
  );
}

/** Shows its children only in one view. The server renders the traders' view; the other stays in the
 * page, hidden, so links and search still find it. */
export function ForMode({ only, children }: { only: Mode; children: ReactNode }) {
  const mode = useMode();
  return <div hidden={mode !== only}>{children}</div>;
}

/** The top menu's view-specific links: how it works and LPs for traders; the agent API for agents;
 * and a link to the other view. */
export function ModeNavLinks({ className = "" }: { className?: string }) {
  const mode = useMode();
  return mode === "agents" ? (
    <>
      <a href="/?for=agents#agents" className={className}>How it works</a>
      <OtherModeLink className={className} />
    </>
  ) : (
    <>
      <a href="/#how" className={className}>How it works</a>
      <OtherModeLink className={className} />
      <a href="/#lps" className={className}>For LPs</a>
    </>
  );
}
