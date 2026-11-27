"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BucketInfo } from "@/lib/api";
import { fmtNum, fmtPrice, fmtUsd } from "@/lib/format";
import { interp, type Point } from "@/lib/payoff";

export type Moves = { edges: number[]; horizons: Record<string, { counts: number[]; quantiles: Record<string, number> }> };
export type Horizon = "off" | "1d" | "7d" | "30d";

export type ChosenLeg = { kind: string; priceLower: number; priceUpper: number };

type Props = {
  points: Point[];
  onChange: (p: Point[]) => void;
  compiled: Point[] | null;
  closest: Point[] | null;
  unhedgedUnits: number;
  spot: number | null;
  buckets: BucketInfo[];
  chosen: ChosenLeg[];
  scenario: number;
  /** overlay: historical moves of the base token over this horizon, centred on spot */
  horizon?: Horizon;
  /** historical move distribution for this market's base token, if there is one */
  moves?: Moves | null;
  onScenario: (s: number) => void;
  liquidityScale: number;
};

const W = 920;
const M = { l: 64, r: 18, t: 18, b: 92 };
const BAR_H = 46;

export function PayoffChart(p: Props) {
  const svg = useRef<SVGSVGElement>(null);
  // the drawing takes the shape of its box: height in view units follows the box's aspect ratio
  const [H, setH] = useState(440);
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const r = e!.contentRect;
      if (r.width > 0 && r.height > 0) setH(Math.round(Math.min(760, Math.max(300, (W * r.height) / r.width))));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [drag, setDrag] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);

  const [lo, hi] = [p.points[0]![0], p.points[p.points.length - 1]![0]];
  const yRange = useMemo(() => {
    const vals = [...p.points.map((x) => x[1]), ...(p.compiled ?? []).map((x) => x[1]), p.unhedgedUnits * lo, p.unhedgedUnits * hi];
    const mn = Math.min(0, ...vals), mx = Math.max(...vals);
    const pad = (mx - mn) * 0.08 || 1;
    return [mn - pad * 0.2, mx + pad] as const;
  }, [p.points, p.compiled, p.unhedgedUnits, lo, hi]);

  const x = useCallback((v: number) => M.l + ((v - lo) / (hi - lo)) * (W - M.l - M.r), [lo, hi]);
  const y = useCallback((v: number) => M.t + (1 - (v - yRange[0]) / (yRange[1] - yRange[0])) * (H - M.t - M.b), [yRange, H]);
  const toData = (clientX: number, clientY: number) => {
    const el = svg.current!;
    const pt = el.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const q = pt.matrixTransform(el.getScreenCTM()!.inverse());
    return [lo + ((q.x - M.l) / (W - M.l - M.r)) * (hi - lo), yRange[0] + (1 - (q.y - M.t) / (H - M.t - M.b)) * (yRange[1] - yRange[0])] as const;
  };

  useEffect(() => {
    if (drag === null) return;
    const move = (e: PointerEvent) => {
      const [px, py] = toData(e.clientX, e.clientY);
      const next = p.points.map((q) => [...q] as Point);
      const prev = next[drag - 1]?.[0] ?? -Infinity, nxt = next[drag + 1]?.[0] ?? Infinity;
      const gap = (hi - lo) * 0.01;
      const isEnd = drag === 0 || drag === next.length - 1;
      next[drag] = [isEnd ? next[drag]![0] : Math.min(nxt - gap, Math.max(prev + gap, px)), Math.max(0, py)];
      p.onChange(next);
    };
    const up = () => setDrag(null);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  });

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (selected === null || (e.key !== "Delete" && e.key !== "Backspace")) return;
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (selected === 0 || selected === p.points.length - 1 || p.points.length <= 2) return;
      p.onChange(p.points.filter((_, i) => i !== selected));
      setSelected(null);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [selected, p]);

  const path = (pts: Point[]) => pts.map((q, i) => `${i ? "L" : "M"}${x(q[0]).toFixed(1)},${y(q[1]).toFixed(1)}`).join("");
  const maxBorrow = Math.max(1, ...p.buckets.map((b) => Number(BigInt(b.borrowable))));
  const ticksX = useMemo(() => {
    const n = 6, out: number[] = [];
    for (let i = 0; i <= n; i++) out.push(lo + ((hi - lo) * i) / n);
    return out;
  }, [lo, hi]);
  const ticksY = useMemo(() => {
    const n = 5, out: number[] = [];
    for (let i = 0; i <= n; i++) out.push(yRange[0] + ((yRange[1] - yRange[0]) * i) / n);
    return out;
  }, [yRange]);

  const S = Math.min(hi, Math.max(lo, p.scenario));
  const tS = interp(p.points, S);
  const cS = p.compiled ? interp(p.compiled, S) : null;
  const density = useMemo(() => {
    if (!p.spot || !p.horizon || p.horizon === "off" || !p.moves) return null;
    const mv = p.moves;
    const h = mv.horizons[p.horizon];
    if (!h) return null;
    const max = Math.max(...h.counts, 1);
    const pts = h.counts
      .map((c, i) => [((mv.edges[i]! + mv.edges[i + 1]!) / 2) * p.spot!, c / max] as const)
      .filter(([px]) => px >= lo && px <= hi);
    return { pts, p5: h.quantiles.p5! * p.spot, p95: h.quantiles.p95! * p.spot };
  }, [p.spot, p.horizon, p.moves, lo, hi]);
  const base = H - M.b, DH = (H - M.t - M.b) * 0.34;
  const densityPath = density?.pts.length
    ? `M${x(density.pts[0]![0]).toFixed(1)},${base}` + density.pts.map(([px, v]) => `L${x(px).toFixed(1)},${(base - v * DH).toFixed(1)}`).join("") + `L${x(density.pts[density.pts.length - 1]![0]).toFixed(1)},${base}Z`
    : null;

  const isChosen = (b: BucketInfo) => p.chosen.find((c) => Math.abs(c.priceLower - b.priceLower) < 1e-9);

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <svg
        ref={svg}
        viewBox={`0 0 ${W} ${H}`}
        className="min-h-0 w-full flex-1 touch-none select-none"
        role="application"
        aria-label="Payoff editor. Drag points to shape the payoff; double-click to add a point; select a point and press Delete to remove it."
        onDoubleClick={(e) => {
          const [px, py] = toData(e.clientX, e.clientY);
          if (px <= lo || px >= hi) return;
          const next = [...p.points, [px, Math.max(0, py)] as Point].sort((a, b) => a[0] - b[0]);
          p.onChange(next);
        }}
        onPointerMove={(e) => {
          if (drag !== null || e.buttons) return;
          const [px] = toData(e.clientX, e.clientY);
          if (px > lo && px < hi && (e.target as SVGElement).dataset.track) p.onScenario(px);
        }}
        onPointerDown={(e) => {
          if ((e.target as SVGElement).dataset.handle) return;
          setSelected(null);
          const [px] = toData(e.clientX, e.clientY);
          if (e.clientY && (e.target as SVGElement).dataset.track) p.onScenario(Math.min(hi, Math.max(lo, px)));
        }}
      >
        {/* grid */}
        {ticksY.map((v) => (
          <g key={`y${v}`}>
            <line x1={M.l} x2={W - M.r} y1={y(v)} y2={y(v)} stroke="var(--grid)" />
            <text x={M.l - 8} y={y(v) + 4} textAnchor="end" fontSize="11" fill="var(--ink-3)" fontFamily="var(--font-mono)">{fmtNum(v, 0)}</text>
          </g>
        ))}
        {ticksX.map((v) => (
          <text key={`x${v}`} x={x(v)} y={H - M.b + 18} textAnchor="middle" fontSize="11" fill="var(--ink-3)" fontFamily="var(--font-mono)">{(hi - lo) / 6 < 1 ? fmtPrice(v) : fmtUsd(v, 0)}</text>
        ))}
        <text x={14} y={M.t + 8} fontSize="11" fill="var(--ink-3)" transform={`rotate(-90 14 ${M.t + 8})`} textAnchor="end" fontFamily="var(--font-mono)">USD</text>

        {/* bucket ladder: borrowable liquidity per range, chosen ranges highlighted */}
        <g>
          {p.buckets.filter((b) => b.priceUpper > lo && b.priceLower < hi).map((b) => {
            const x0 = Math.max(x(b.priceLower), M.l) + 1, x1 = Math.min(x(b.priceUpper), W - M.r) - 1;
            const h = Math.max(3, (Number(BigInt(b.borrowable)) / maxBorrow) * BAR_H);
            const ch = isChosen(b);
            const color = b.side === "below" ? "var(--accent)" : b.side === "above" ? "var(--steel)" : "var(--line-strong)";
            return (
              <g key={b.address}>
                <rect x={x0} width={Math.max(1, x1 - x0)} y={H - 34 - h} height={h} fill={color} opacity={ch ? 0.9 : b.side === "spot" ? 0.5 : 0.22}>
                  <title>{`${fmtPrice(b.priceLower)}–${fmtPrice(b.priceUpper)} · ${b.side === "spot" ? "contains spot: not usable" : `${(b.utilization * 100).toFixed(0)}% utilized`}`}</title>
                </rect>
                {ch && <rect x={x0} width={Math.max(1, x1 - x0)} y={H - 34 - BAR_H - 6} height={2} fill="var(--ink)" />}
              </g>
            );
          })}
          <line x1={M.l} x2={W - M.r} y1={H - 34} y2={H - 34} stroke="var(--line-strong)" />
          <text x={M.l} y={H - 14} fontSize="11" fill="var(--ink-3)" fontFamily="var(--font-sans)">Buckets · height = borrowable · bright = used</text>
        </g>

        {/* historical distribution of the base token's moves (Binance 1m history), behind everything */}
        {densityPath && density && (
          <g pointerEvents="none">
            <defs>
              <linearGradient id="pc-dens" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stopColor="var(--accent)" stopOpacity="0.20" />
                <stop offset="1" stopColor="var(--accent)" stopOpacity="0.02" />
              </linearGradient>
            </defs>
            <path d={densityPath} fill="url(#pc-dens)" stroke="var(--accent)" strokeOpacity="0.35" strokeWidth="1" />
            {[["5%", density.p5], ["95%", density.p95]].map(([lab, px]) => (Number(px) > lo && Number(px) < hi ? (
              <g key={lab as string}>
                <line x1={x(px as number)} x2={x(px as number)} y1={base - DH - 6} y2={base} stroke="var(--ink-3)" strokeDasharray="1 3" />
                <text x={x(px as number)} y={base - DH - 10} textAnchor="middle" fontSize="10" fill="var(--ink-3)" fontFamily="var(--font-mono)">{lab}</text>
              </g>
            ) : null))}
          </g>
        )}

        {/* spot */}
        {p.spot && p.spot > lo && p.spot < hi && (
          <g>
            <line x1={x(p.spot)} x2={x(p.spot)} y1={M.t} y2={H - 34} stroke="var(--ink-3)" strokeDasharray="3 5" />
            <text x={x(p.spot) + 5} y={M.t + 12} fontSize="11" fill="var(--ink-2)" fontFamily="var(--font-mono)">spot {fmtPrice(p.spot)}</text>
          </g>
        )}

        {/* scenario track (click anywhere in the plot to move the scenario line) */}
        <rect data-track="1" x={M.l} y={M.t} width={W - M.l - M.r} height={H - M.t - M.b} fill="transparent" />
        <line x1={x(S)} x2={x(S)} y1={M.t} y2={H - M.b} stroke="var(--ink-2)" strokeWidth="1" strokeDasharray="2 3" pointerEvents="none" />

        {/* curves */}
        <path d={path([[lo, p.unhedgedUnits * lo], [hi, p.unhedgedUnits * hi]])} fill="none" stroke="var(--ink-3)" strokeWidth="1.5" strokeDasharray="2 6" pointerEvents="none" />
        {p.closest && <path d={path(p.closest)} fill="none" stroke="var(--warn)" strokeWidth="1.5" strokeDasharray="6 4" pointerEvents="none" />}
        {p.compiled && <path d={path(p.compiled)} fill="none" stroke="var(--ink)" strokeWidth="1.5" pointerEvents="none" />}
        <path d={path(p.points)} fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinejoin="miter" pointerEvents="none" />
        {p.points.map((q, i) => (
          <g key={i}>
            <rect
              data-handle="1"
              x={x(q[0]) - (selected === i ? 6 : 5)}
              y={y(q[1]) - (selected === i ? 6 : 5)}
              width={selected === i ? 12 : 10}
              height={selected === i ? 12 : 10}
              fill={selected === i ? "var(--accent)" : "var(--bg)"}
              stroke="var(--accent)"
              strokeWidth={1.5}
              className="cursor-grab"
              tabIndex={0}
              aria-label={`Breakpoint at ${fmtPrice(q[0])}, value ${fmtNum(q[1], 0)}`}
              onPointerDown={(e) => {
                e.stopPropagation();
                setDrag(i);
                setSelected(i);
              }}
              onFocus={() => setSelected(i)}
            />
          </g>
        ))}
      </svg>

      {/* scenario readout */}
      <div className="pointer-events-none absolute left-[8%] top-3 rounded-[3px] border border-line bg-bg/90 px-3 py-2 text-[11px] backdrop-blur">
        <div className="num text-ink-2">Close at <span className="text-ink">{fmtPrice(S)}</span></div>
        <div className="num mt-1 grid grid-cols-[auto_auto] gap-x-3">
          <span className="text-ink-3">Target</span><span className="text-right">{fmtUsd(tS)}</span>
          <span className="text-ink-3">Compiled</span><span className="text-right">{cS == null ? "—" : fmtUsd(cS)}</span>
          <span className="text-ink-3">Hold</span><span className="text-right">{fmtUsd(p.unhedgedUnits * S)}</span>
        </div>
      </div>
      <input
        type="range"
        className="mt-1 w-full"
        min={lo}
        max={hi}
        step={(hi - lo) / 400}
        value={S}
        onChange={(e) => p.onScenario(Number(e.target.value))}
        aria-label="Scenario closing price"
      />
    </div>
  );
}
