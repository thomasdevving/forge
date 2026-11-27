"use client";

import { useEffect, useState } from "react";
import data from "@/data/agents.json";

type Line = { t: string; who: string; text: string; step?: string; tone?: "good" | "warn" };
const run = data.treasury as { command: string; lines: Line[] };

const STEPS: { key: string; label: string }[] = [
  { key: "discover", label: "discover" },
  { key: "402", label: "402" },
  { key: "paid", label: "paid $0.01" },
  { key: "compile", label: "Architect compiles" },
  { key: "verify", label: "verifier checks" },
  { key: "authorize", label: "awaits approval" },
  { key: "open", label: "opened · 4 tx" },
];

// Pause longer after the lines where the real run waited (payment, human authorization).
const pauseAfter = (l: Line) => (l.step === "402" ? 1100 : l.step === "authorize" ? 1300 : l.step === "verify" ? 500 : 230);

/**
 * The treasury agent's real run, replayed line by line in a terminal frame. Timestamps are the log's own;
 * the replay is compressed. `active` starts the replay; turning it off resets it.
 */
export function AgentTerminal({ active }: { active: boolean }) {
  const [shown, setShown] = useState(0);
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    if (!active) {
      setShown(0);
      return;
    }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setShown(run.lines.length);
      return;
    }
    setShown(0);
    let i = 0;
    let timer = 0;
    const next = () => {
      i += 1;
      setShown(i);
      if (i < run.lines.length) timer = window.setTimeout(next, pauseAfter(run.lines[i - 1]!));
    };
    timer = window.setTimeout(next, 500);
    return () => window.clearTimeout(timer);
  }, [active, epoch]);

  const visible = run.lines.slice(0, shown);
  const reached = new Set(visible.map((l) => l.step).filter(Boolean));
  const done = shown >= run.lines.length;
  const current = [...STEPS].reverse().find((s) => reached.has(s.key))?.key;

  return (
    <div className="flex aspect-[4/3] flex-col sm:aspect-[16/10] bg-[#0c0e11] font-mono text-[9.5px] leading-[1.6] sm:text-[11.5px] sm:leading-[1.75]">
      <div className="flex h-8 shrink-0 items-center gap-3 border-b border-line px-3">
        <span className="flex gap-1.5" aria-hidden><span className="size-2 bg-line-strong" /><span className="size-2 bg-line-strong" /><span className="size-2 bg-line-strong" /></span>
        <span className="truncate text-[10.5px] text-ink-3 sm:text-[11px]">agents/treasury · real run on the fork</span>
        <button
          type="button"
          onClick={() => setEpoch((e) => e + 1)}
          className="ml-auto shrink-0 text-[10.5px] text-ink-3 transition-colors hover:text-ink disabled:opacity-0 sm:text-[11px]"
          disabled={!done}
          aria-label="Replay the run"
        >
          ↻ replay
        </button>
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col justify-end overflow-hidden px-3 pb-2 sm:px-4">
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-10 bg-gradient-to-b from-[#0c0e11] to-transparent" />
        <div className="text-ink-3">
          <span className="text-ink-2">$</span> {run.command}
        </div>
        {visible.map((l, i) => (
          <div key={i} className="grid animate-fade-up grid-cols-[3.2em_1fr] gap-x-2 sm:grid-cols-[3.6em_9.5em_1fr]" style={{ animationDuration: "0.35s" }}>
            <span className="text-right text-ink-3 tabular-nums">{l.t}</span>
            <span className="hidden truncate text-ink-3 sm:block">{l.who}</span>
            <span className={`min-w-0 break-words ${l.tone === "good" ? "text-good" : l.tone === "warn" ? "text-warn" : "text-ink-2"}`}>{l.text}</span>
          </div>
        ))}
        {!done && <span className="mt-0.5 ml-[calc(3.2em+0.5rem)] inline-block h-[1.1em] w-[0.6em] animate-pulse bg-ink-2 sm:ml-[calc(13.1em+1rem)]" aria-hidden />}
      </div>
      <ol className="flex shrink-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 border-t border-line px-3 py-2 text-[9px] sm:px-4 sm:text-[10.5px]" aria-label="Steps of the run">
        {STEPS.map((s, i) => (
          <li key={s.key} className="flex items-center gap-1.5">
            {i > 0 && <span className="text-line-strong" aria-hidden>→</span>}
            <span className={`transition-colors duration-300 ${s.key === current ? "text-ink" : reached.has(s.key) ? "text-ink-2" : "text-ink-3/50"}`}>{s.label}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
