"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";

export type Step = { title: string; body: string; shot: string; path: string; alt: string };

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

/**
 * Pinned, scroll-driven walkthrough: numbered steps on one side with a progress hairline,
 * a browser frame on the other that swaps real screenshots from the fork.
 */
export function Walkthrough({ steps, flip = false, head }: { steps: Step[]; flip?: boolean; head?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [p, setP] = useState(0);
  useEffect(() => {
    const on = () => {
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setP(clamp(-r.top / Math.max(1, r.height - window.innerHeight)));
    };
    on();
    window.addEventListener("scroll", on, { passive: true });
    window.addEventListener("resize", on);
    return () => {
      window.removeEventListener("scroll", on);
      window.removeEventListener("resize", on);
    };
  }, []);
  const n = steps.length;
  const active = Math.min(n - 1, Math.floor(p * n));
  const within = clamp(p * n - active);

  return (
    <div ref={ref} style={{ height: `${n * 75 + 40}vh` }} className="relative">
      <div className="sticky top-0 flex h-dvh items-center">
        <div className={`mx-auto grid w-full max-w-[1480px] items-center gap-8 px-5 sm:px-8 lg:gap-14 ${flip ? "lg:grid-cols-[1.55fr_1fr]" : "lg:grid-cols-[1fr_1.55fr]"}`}>
          <div className={flip ? "lg:order-2" : ""}>
          {head && <div className="mb-8">{head}</div>}
          <ol>
            {steps.map((s, i) => {
              const on = i === active;
              const done = i < active;
              return (
                <li key={s.title} className="border-t border-line last:border-b">
                  <div className="relative py-4">
                    <div className="absolute -top-px left-0 h-px bg-ink transition-[width] duration-150" style={{ width: `${on ? within * 100 : done ? 100 : 0}%` }} />
                    <div className="flex items-baseline gap-4">
                      <span className={`num text-[12px] ${on || done ? "text-ink" : "text-ink-3"}`}>{String(i + 1).padStart(2, "0")}</span>
                      <h3 className={`font-display text-lg font-semibold tracking-tight transition-colors sm:text-xl ${on ? "text-ink" : "text-ink-3"}`}>{s.title}</h3>
                    </div>
                    <div className="grid transition-[grid-template-rows] duration-500" style={{ gridTemplateRows: on ? "1fr" : "0fr" }}>
                      <p className="overflow-hidden pl-9 text-[14px] leading-relaxed text-ink-2">
                        <span className="block pt-2">{s.body}</span>
                      </p>
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
          </div>
          <figure className={`overflow-hidden rounded-[6px] border border-line-strong bg-bg ${flip ? "lg:order-1" : ""}`}>
            <div className="flex h-8 items-center gap-3 border-b border-line px-3">
              <span className="flex gap-1.5" aria-hidden>
                <span className="size-2 bg-line-strong" />
                <span className="size-2 bg-line-strong" />
                <span className="size-2 bg-line-strong" />
              </span>
              <span className="num text-[11px] text-ink-3">forge{steps[active]!.path}</span>
            </div>
            <div className="relative aspect-[16/10] bg-bg">
              {steps.map((s, i) => (
                <img
                  key={s.shot}
                  src={s.shot}
                  alt={s.alt}
                  loading={i === 0 ? "eager" : "lazy"}
                  className="absolute inset-0 size-full object-cover object-top transition-opacity duration-500"
                  style={{ opacity: i === active ? 1 : 0 }}
                />
              ))}
            </div>
          </figure>
        </div>
      </div>
    </div>
  );
}
