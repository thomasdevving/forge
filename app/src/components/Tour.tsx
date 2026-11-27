"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { markTourSeen, type TourId, TOURS } from "@/lib/tour";

type Rect = { top: number; left: number; width: number; height: number };

const PAD = 6; // space between the element and the cut-out
const GAP = 12; // space between the cut-out and the popover
const EDGE = 12; // minimum distance from the viewport edge
const SHEET_BELOW = 640; // narrower than this, the popover is a bottom sheet

const find = (target: string) => document.querySelector<HTMLElement>(`[data-tour="${target}"]`);
const visible = (el: HTMLElement | null): el is HTMLElement => {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
};
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** How far to scroll so [top, bottom] sits inside [lo, hi]: the least movement, top first if it is too tall. */
const shift = (top: number, bottom: number, lo: number, hi: number) => {
  if (top < lo + EDGE) return top - lo - EDGE;
  if (bottom > hi - EDGE) return Math.min(top - lo - EDGE, bottom - hi + EDGE);
  return 0;
};

/** Scroll an element into the visible band [0, visibleBottom), through every vertical scroll container. */
function reveal(el: HTMLElement, visibleBottom: number) {
  const behavior: ScrollBehavior = reducedMotion() ? "auto" : "smooth";
  const r = el.getBoundingClientRect();
  let top = r.top, bottom = r.bottom;
  for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy !== "auto" && oy !== "scroll") || p.scrollHeight <= p.clientHeight) continue;
    const c = p.getBoundingClientRect();
    const d = shift(top, bottom, c.top, Math.min(c.bottom, visibleBottom));
    if (!d) continue;
    const zoom = (p as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom ?? 1;
    const before = p.scrollTop;
    p.scrollTo({ top: before + d / zoom, behavior });
    const moved = Math.min(Math.max(before + d / zoom, 0), p.scrollHeight - p.clientHeight) - before;
    top -= moved * zoom;
    bottom -= moved * zoom;
  }
  const d = shift(top, bottom, 0, visibleBottom);
  if (d) window.scrollBy({ top: d, behavior });
}

/**
 * Step-by-step walkthrough. Dims the page with a cut-out around the current element (`data-tour`)
 * and explains it in a small popover. Steps whose element is not on the page are skipped.
 */
export function Tour({ id, open, onClose }: { id: TourId; open: boolean; onClose: () => void }) {
  const steps = TOURS[id];
  const [index, setIndex] = useState<number | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const [size, setSize] = useState({ w: 340, h: 180 });
  const [view, setView] = useState({ w: 0, h: 0 });
  const pop = useRef<HTMLDivElement>(null);
  const nextBtn = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const titleId = useId();
  const bodyId = useId();

  const present = useCallback(() => steps.map((s) => visible(find(s.target))), [steps]);

  const close = useCallback(() => {
    markTourSeen(id);
    setIndex(null);
    setRect(null);
    onCloseRef.current();
    returnFocus.current?.focus?.();
  }, [id]);

  // on open: wait for the page to render its first available step (data loads in after mount)
  useEffect(() => {
    if (!open) return;
    returnFocus.current = document.activeElement as HTMLElement | null;
    let tries = 0;
    const t = setInterval(() => {
      const first = present().indexOf(true);
      if (first >= 0) {
        clearInterval(t);
        setIndex(first);
      } else if (++tries > 30) {
        clearInterval(t);
        onCloseRef.current();
      }
    }, 150);
    return () => clearInterval(t);
  }, [open, present]);

  const go = useCallback(
    (dir: 1 | -1) => {
      if (index === null) return;
      const p = present();
      for (let i = index + dir; i >= 0 && i < steps.length; i += dir) if (p[i]) return setIndex(i);
      if (dir === 1) close();
    },
    [index, present, steps.length, close],
  );

  // bring the step's element into view (vertically only: the app frame clips sideways on purpose)
  useEffect(() => {
    if (index === null) return;
    const el = find(steps[index]!.target);
    if (!el) return;
    const sheet = window.innerWidth < SHEET_BELOW;
    reveal(el, sheet ? window.innerHeight - (pop.current?.offsetHeight ?? 220) : window.innerHeight);
  }, [index, steps]);

  // follow the element every frame: scrolling, resizing and data refreshes all move it
  useEffect(() => {
    if (index === null) return;
    let raf = 0;
    let last = "";
    const tick = () => {
      const el = find(steps[index]!.target);
      const r = el?.getBoundingClientRect();
      const next = r && r.width > 0 ? { top: r.top, left: r.left, width: r.width, height: r.height } : null;
      const vw = window.innerWidth, vh = window.innerHeight;
      const k = next ? `${Math.round(next.top)},${Math.round(next.left)},${Math.round(next.width)},${Math.round(next.height)},${vw},${vh}` : `none,${vw},${vh}`;
      if (k !== last) {
        last = k;
        setRect(next);
        setView({ w: vw, h: vh });
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [index, steps]);

  // popover size, for placement
  useLayoutEffect(() => {
    const el = pop.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.offsetWidth, h: el.offsetHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [index === null]); // eslint-disable-line react-hooks/exhaustive-deps

  // focus moves into the popover when it opens, and back to Next if a step disables the focused button
  useEffect(() => {
    if (index !== null && !pop.current?.contains(document.activeElement)) nextBtn.current?.focus({ preventScroll: true });
  }, [index]);

  // keyboard: Esc closes, arrows move, Tab stays inside the popover
  useEffect(() => {
    if (index === null) return;
    const on = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        go(1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        go(-1);
      } else if (e.key === "Tab" && pop.current) {
        const f = [...pop.current.querySelectorAll<HTMLElement>("button:not(:disabled)")];
        if (!f.length) return;
        const at = f.indexOf(document.activeElement as HTMLElement);
        if (e.shiftKey ? at <= 0 : at === f.length - 1) {
          e.preventDefault();
          f[e.shiftKey ? f.length - 1 : 0]!.focus();
        } else if (at === -1) {
          e.preventDefault();
          f[0]!.focus();
        }
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.stopPropagation(); // the page underneath is inert while the tour is open
      }
    };
    window.addEventListener("keydown", on, true);
    return () => window.removeEventListener("keydown", on, true);
  }, [index, go, close]);

  if (!open || index === null || typeof document === "undefined") return null;

  const step = steps[index]!;
  const avail = present();
  const order = avail.reduce<number[]>((a, ok, i) => (ok || i === index ? [...a, i] : a), []);
  const pos = order.indexOf(index) + 1;
  const last = !avail.some((ok, i) => ok && i > index);
  const first = !avail.some((ok, i) => ok && i < index);
  const sheet = view.w > 0 && view.w < SHEET_BELOW;

  const hole = rect && {
    top: rect.top - PAD,
    left: rect.left - PAD,
    width: rect.width + PAD * 2,
    height: rect.height + PAD * 2,
  };

  // place the popover below, above, right or left of the cut-out, else inside the bottom-right corner
  const { w, h } = size;
  const vw = view.w, vh = view.h;
  // a bottom sheet moves to the top when the element sits at the very end of the page, under it
  const sheetTop = sheet && !!hole && hole.top + hole.height > vh - h && hole.top >= h;
  let place = { top: vh - EDGE - h, left: vw - EDGE - w };
  if (!sheet && hole) {
    const clampX = (x: number) => Math.min(Math.max(x, EDGE), vw - EDGE - w);
    const clampY = (y: number) => Math.min(Math.max(y, EDGE), vh - EDGE - h);
    const cx = clampX(hole.left + hole.width / 2 - w / 2);
    const bottom = hole.top + hole.height;
    const right = hole.left + hole.width;
    if (bottom + GAP + h <= vh - EDGE && bottom + GAP >= EDGE) place = { top: bottom + GAP, left: cx };
    else if (hole.top - GAP - h >= EDGE && hole.top - GAP <= vh) place = { top: hole.top - GAP - h, left: cx };
    else if (right + GAP + w <= vw - EDGE) place = { top: clampY(hole.top), left: right + GAP };
    else if (hole.left - GAP - w >= EDGE) place = { top: clampY(hole.top), left: hole.left - GAP - w };
    else place = { top: vh - EDGE - h, left: vw - EDGE - w };
  }

  return createPortal(
    <div className="fixed inset-0 z-[100]" data-tour-overlay>
      {/* the page stays visible but inert while the tour runs */}
      <div className="absolute inset-0" onMouseDown={(e) => e.preventDefault()} aria-hidden />
      {hole ? (
        <div
          aria-hidden
          className="pointer-events-none absolute rounded-[4px] border border-accent motion-safe:transition-[top,left,width,height] motion-safe:duration-200 motion-safe:ease-out"
          style={{ ...hole, boxShadow: "0 0 0 9999px rgba(6, 7, 9, 0.72)" }}
        />
      ) : (
        <div aria-hidden className="pointer-events-none absolute inset-0 bg-[rgba(6,7,9,0.72)]" />
      )}
      <div
        ref={pop}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className={
          sheet
            ? `animate-fade-up absolute inset-x-0 bg-bg px-4 ${sheetTop ? "top-0 border-b border-line-strong pb-4 pt-[max(1rem,env(safe-area-inset-top))] shadow-[0_24px_48px_rgba(0,0,0,0.45)]" : "bottom-0 border-t border-line-strong pb-[max(1rem,env(safe-area-inset-bottom))] pt-4 shadow-[0_-24px_48px_rgba(0,0,0,0.45)]"}`
            : "animate-fade-up absolute w-[340px] max-w-[calc(100vw-24px)] rounded-[4px] border border-line-strong bg-bg p-4 shadow-[0_24px_60px_-18px_rgba(0,0,0,0.85)] motion-safe:transition-[top,left] motion-safe:duration-200 motion-safe:ease-out"
        }
        style={sheet ? undefined : place}
      >
        <div className="flex items-baseline justify-between gap-3">
          <span className="cap num">
            {String(pos).padStart(2, "0")} / {String(order.length).padStart(2, "0")}
          </span>
          <button className="cap hover:text-ink" onClick={close}>
            Skip tour
          </button>
        </div>
        <div aria-live="polite">
          <h2 id={titleId} className="mt-2 text-[14px] font-semibold text-ink">
            {step.title}
          </h2>
          <p id={bodyId} className="mt-1.5 text-[12.5px] leading-relaxed text-ink-2">
            {step.body}
          </p>
        </div>
        <div className="mt-4 flex items-center gap-2">
          <div className="flex gap-1" aria-hidden>
            {order.map((i) => (
              <span key={i} className={`h-[3px] w-3 ${i === index ? "bg-ink" : i < index ? "bg-ink-3" : "bg-line-strong"}`} />
            ))}
          </div>
          <div className="ml-auto flex gap-2">
            <button className="btn btn-ghost !px-3 !py-1.5 !text-[12px]" onClick={() => go(-1)} disabled={first}>
              Back
            </button>
            <button ref={nextBtn} className="btn btn-primary !px-3 !py-1.5 !text-[12px]" onClick={() => (last ? close() : go(1))}>
              {last ? "Done" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
