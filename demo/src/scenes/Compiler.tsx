import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import meta from "../data/shot-meta.json";
import { C, mono, sans } from "../theme";
import { Backdrop, ease, Kicker, useIn, useOut, usd } from "../ui";

type Leg = { kind: string; priceLower: number; priceUpper: number };
const legs = meta.legs as Leg[];
const target = meta.target as [number, number][];
const LABEL: Record<string, { name: string; from: string; color: string }> = {
  borrow_put: { name: "Long put", from: "borrowed from LPs", color: C.ink },
  borrow_call: { name: "Long call", from: "borrowed from LPs", color: C.ink },
  provide_put: { name: "Cash-secured put", from: "your USDC", color: "#7f8da3" },
  provide_call: { name: "Covered call", from: "your JUP", color: "#7f8da3" },
};

const LO = 0.17, HI = 0.33;
const X0 = 170, X1 = 1180, Y0 = 300, Y1 = 760;
const vmin = 520, vmax = 920;
const x = (p: number) => X0 + ((p - LO) / (HI - LO)) * (X1 - X0);
const y = (v: number) => Y1 - ((v - vmin) / (vmax - vmin)) * (Y1 - Y0);
const interp = (p: number) => {
  for (let i = 1; i < target.length; i++) if (p <= target[i]![0]) {
    const [a, va] = target[i - 1]!, [b, vb] = target[i]!;
    return va + ((vb - va) * (p - a)) / (b - a);
  }
  return target[target.length - 1]![1];
};
const path = (to: number) => {
  const pts: string[] = [];
  for (let i = 0; i <= 160; i++) {
    const p = LO + ((to - LO) * i) / 160;
    pts.push(`${x(p).toFixed(1)},${y(interp(p)).toFixed(1)}`);
  }
  return pts.join(" ");
};

/** The compiler: ranges stacked to trace the payoff you drew, with a certified worst-case error. */
export const Compiler: React.FC = () => {
  const f = useCurrentFrame();
  const title = useIn(0, 20);
  const draw = interpolate(f, [16, 70], [LO, HI], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
  const compiled = interpolate(f, [70 + legs.length * 22, 110 + legs.length * 22], [LO, HI], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
  const cert = useIn(250, 26);
  const out = useOut(14);
  const hold = meta.holdings.base;
  return (
    <Backdrop glow={0.8}>
      <AbsoluteFill style={{ opacity: out }}>
        <div style={{ position: "absolute", left: 140, top: 86, opacity: title }}>
          <Kicker n="04">The compiler</Kicker>
          <div style={{ fontFamily: sans, fontSize: 64, fontWeight: 600, letterSpacing: -2, marginTop: 18 }}>Ranges stacked to trace your line.</div>
        </div>
        <svg width={1920} height={1080} style={{ position: "absolute", inset: 0 }}>
          <line x1={X0} x2={X1} y1={Y1 + 30} y2={Y1 + 30} stroke={C.lineStrong} strokeWidth={2} />
          <text x={X1} y={Y1 + 66} fill={C.ink3} fontFamily={mono} fontSize={20} textAnchor="end">JUP price →</text>
          {/* hold line */}
          <line x1={x(LO)} y1={y(hold * LO)} x2={x(HI)} y2={y(hold * HI)} stroke={C.ink3} strokeWidth={2} strokeDasharray="3 8" opacity={title} />
          {/* today */}
          <line x1={x(meta.spot)} x2={x(meta.spot)} y1={Y0 - 10} y2={Y1 + 30} stroke={C.ink3} strokeDasharray="3 6" opacity={title} />
          <text x={x(meta.spot)} y={Y0 - 22} fill={C.ink3} fontFamily={mono} fontSize={20} textAnchor="middle" opacity={title}>today {usd(meta.spot, 4)}</text>
          {/* target */}
          <polyline points={path(draw)} fill="none" stroke={C.accent} strokeWidth={6} strokeLinejoin="round" opacity={0.55} />
          {/* legs */}
          {legs.map((l, i) => {
            const a = interpolate(f, [70 + i * 22, 88 + i * 22], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
            const lab = LABEL[l.kind] ?? { name: l.kind, from: "", color: C.ink2 };
            return <rect key={i} x={x(l.priceLower)} width={Math.max(3, x(l.priceUpper) - x(l.priceLower) - 3)} y={Y1 + 44 - 60 * a} height={60 * a} fill={lab.color} opacity={0.9} />;
          })}
          {/* compiled */}
          {compiled > LO && <polyline points={path(compiled)} fill="none" stroke={C.ink} strokeWidth={2.5} strokeLinejoin="round" />}
        </svg>
        {/* legend of the legs */}
        <div style={{ position: "absolute", left: 1240, top: 300, width: 600 }}>
          <div style={{ fontFamily: mono, fontSize: 20, color: C.ink3, marginBottom: 14 }}>{meta.market} collar · {hold.toLocaleString("en-US")} JUP</div>
          {legs.map((l, i) => {
            const a = interpolate(f, [70 + i * 22, 88 + i * 22], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
            const lab = LABEL[l.kind] ?? { name: l.kind, from: "", color: C.ink2 };
            return (
              <div key={i} style={{ display: "grid", gridTemplateColumns: "14px 1fr auto", gap: 16, alignItems: "center", padding: "12px 0", borderTop: `1px solid ${C.line}`, opacity: a, transform: `translateX(${(1 - a) * 20}px)` }}>
                <span style={{ width: 14, height: 14, background: lab.color }} />
                <span style={{ fontFamily: sans, fontSize: 25, color: C.ink }}>{lab.name} <span style={{ color: C.ink3, fontSize: 20 }}>· {lab.from}</span></span>
                <span style={{ fontFamily: mono, fontSize: 19, color: C.ink2 }}>{usd(l.priceLower, 4)}–{usd(l.priceUpper, 4)}</span>
              </div>
            );
          })}
        </div>
        {/* certificate */}
        <div style={{ position: "absolute", left: 1240, top: 720, width: 600, padding: "22px 26px", border: `1px solid ${C.good}`, borderRadius: 8, background: "rgba(21,32,28,0.9)", opacity: cert, transform: `translateY(${(1 - cert) * 18}px) scale(${0.97 + 0.03 * cert})` }}>
          <div style={{ fontFamily: mono, fontSize: 20, color: C.good, letterSpacing: 1 }}>CERTIFICATE</div>
          <div style={{ fontFamily: sans, fontSize: 40, fontWeight: 600, marginTop: 8 }}>max error ±{usd(meta.certifiedBound)}</div>
          <div style={{ fontFamily: sans, fontSize: 21, color: C.ink2, marginTop: 6 }}>checked with exact arithmetic over the whole price range</div>
          <div style={{ fontFamily: mono, fontSize: 18, color: C.ink3, marginTop: 10 }}>hash {meta.hash.slice(0, 24)}…</div>
        </div>
        <div style={{ position: "absolute", left: 170, top: 860, display: "flex", gap: 34, fontFamily: sans, fontSize: 22, color: C.ink2, opacity: title }}>
          <span><span style={{ display: "inline-block", width: 28, height: 4, background: C.accent, opacity: 0.6, verticalAlign: "middle", marginRight: 10 }} />what you drew</span>
          <span style={{ opacity: compiled > LO ? 1 : 0.3 }}><span style={{ display: "inline-block", width: 28, height: 2, background: C.ink, verticalAlign: "middle", marginRight: 10 }} />what the ranges pay</span>
          <span><span style={{ display: "inline-block", width: 28, borderTop: `2px dashed ${C.ink3}`, verticalAlign: "middle", marginRight: 10 }} />just holding</span>
        </div>
      </AbsoluteFill>
    </Backdrop>
  );
};
