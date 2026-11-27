"use client";

/**
 * Illustration (no data): a collar is drawn, then the ranges it compiles to rise from the price
 * axis, then the compiled payoff traces the target. Pure SVG; respects reduced motion.
 */
const W = 640, H = 360, PAD = 36;
const xs = (p: number) => PAD + ((p - 0.6) / (1.5 - 0.6)) * (W - 2 * PAD);
const ys = (v: number) => H - 70 - ((v - 0.78) / (1.22 - 0.78)) * (H - 140);

// target: collar on 1 unit, floor 0.9, cap 1.12 (relative to spot 1.0)
const target = (p: number) => Math.min(Math.max(p, 0.9), 1.12);
// compiled: a smoothed max(p - k, 0) across one range width around each kink
const hinge = (p: number, k: number, w: number) => {
  const a = k * (1 - w), b = k * (1 + w);
  if (p <= a) return 0;
  if (p >= b) return p - k;
  const t = (Math.sqrt(p) - Math.sqrt(a)) / (Math.sqrt(b) - Math.sqrt(a));
  return t * t * (b - k);
};
const compiled = (p: number) => 0.9 + hinge(p, 0.9, 0.025) - hinge(p, 1.12, 0.025);

const path = (f: (p: number) => number) => {
  let d = "";
  for (let i = 0; i <= 160; i++) {
    const p = 0.6 + (i / 160) * 0.9;
    d += `${i ? "L" : "M"}${xs(p).toFixed(1)},${ys(f(p)).toFixed(1)}`;
  }
  return d;
};

const ranges = [
  { lo: 0.85, hi: 0.875, kind: "put" },
  { lo: 0.875, hi: 0.9, kind: "put" },
  { lo: 0.9, hi: 0.925, kind: "put" },
  { lo: 1.095, hi: 1.12, kind: "call" },
  { lo: 1.12, hi: 1.145, kind: "call" },
];

export function HeroGraphic() {
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="A drawn collar payoff compiled into concentrated-liquidity ranges">
      <defs>
        <linearGradient id="hg-put" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="var(--accent)" stopOpacity="0.95" />
          <stop offset="1" stopColor="var(--accent)" stopOpacity="0.35" />
        </linearGradient>
        <linearGradient id="hg-call" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="var(--steel)" stopOpacity="0.9" />
          <stop offset="1" stopColor="var(--steel)" stopOpacity="0.3" />
        </linearGradient>
      </defs>
      {/* axes */}
      <line x1={PAD} x2={W - PAD} y1={H - 52} y2={H - 52} stroke="var(--line-strong)" />
      <line x1={xs(1)} x2={xs(1)} y1={30} y2={H - 52} stroke="var(--ink-3)" strokeDasharray="3 5" />
      <text x={xs(1) + 6} y={42} fill="var(--ink-3)" fontSize="11" fontFamily="var(--font-mono)">spot</text>
      {/* ranges rising from the price axis */}
      {ranges.map((r, i) => {
        const x0 = xs(r.lo) + 1.5, x1 = xs(r.hi) - 1.5;
        return (
          <rect
            key={i}
            x={x0}
            width={x1 - x0}
            y={H - 52 - 64}
            height={64}
            
            fill={r.kind === "put" ? "url(#hg-put)" : "url(#hg-call)"}
            className="animate-rise"
            style={{ animationDelay: `${1.3 + i * 0.12}s` }}
          />
        );
      })}
      {/* unhedged holding */}
      <path d={path((p) => p)} fill="none" stroke="var(--ink-3)" strokeWidth="1.5" strokeDasharray="2 6" opacity="0.7" />
      {/* drawn target */}
      <path d={path(target)} fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinejoin="miter" className="animate-draw" style={{ ["--len" as string]: 1400 }} />
      {/* compiled */}
      <path d={path(compiled)} fill="none" stroke="var(--ink)" strokeWidth="1.6" strokeDasharray="1400" className="animate-draw" style={{ ["--len" as string]: 1400, animationDelay: "2.1s" }} />
      <g fontFamily="var(--font-mono)" fontSize="11">
        <rect x={W - 196} y={20} width={168} height={66} fill="var(--bg)" stroke="var(--line)" />
        <line x1={W - 184} x2={W - 160} y1={38} y2={38} stroke="var(--accent)" strokeWidth="3" />
        <text x={W - 152} y={42} fill="var(--ink-2)">target</text>
        <line x1={W - 184} x2={W - 160} y1={56} y2={56} stroke="var(--ink)" strokeWidth="1.6" />
        <text x={W - 152} y={60} fill="var(--ink-2)">compiled</text>
        <line x1={W - 184} x2={W - 160} y1={74} y2={74} stroke="var(--ink-3)" strokeDasharray="2 4" />
        <text x={W - 152} y={78} fill="var(--ink-2)">hold</text>
      </g>
      <text x={PAD} y={H - 30} fill="var(--ink-3)" fontSize="11" fontFamily="var(--font-mono)">price →</text>
      <text x={xs(0.875)} y={H - 30} fill="var(--accent)" fontSize="11" fontFamily="var(--font-mono)" textAnchor="middle">borrowed · put</text>
      <text x={xs(1.12)} y={H - 30} fill="var(--steel)" fontSize="11" fontFamily="var(--font-mono)" textAnchor="middle">provided · call</text>
    </svg>
  );
}
