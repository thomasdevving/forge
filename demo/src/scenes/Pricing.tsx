import React from "react";
import { AbsoluteFill, interpolate } from "remotion";
import research from "../data/research.json";
import { C, mono, sans } from "../theme";
import { Backdrop, ease, Kicker, useFrame, useIn, useOut } from "../ui";

const P = research.pricing;
const base = P.curve.base_ppm / 1e6, kink = P.curve.kink_ppm / 1e6, slope2 = P.curve.slope2_ppm / 1e6, cap = P.curve.cap_ppm / 1e6;
const m = (u: number) => base + (u > kink ? slope2 * (u - kink) : 0);
const mCap = m(cap);
const X0 = 160, X1 = 960, Y0 = 420, Y1 = 860;
const x = (u: number) => X0 + (u / cap) * (X1 - X0);
const y = (v: number) => Y1 - ((v - 0.8) / (mCap + 0.2 - 0.8)) * (Y1 - Y0);

/** How LPs are paid: the forgone fees, times a multiplier that rises as a bucket fills. */
export const Pricing: React.FC = () => {
  const f = useFrame();
  const title = useIn(0, 20);
  const parts = [useIn(20, 18), useIn(44, 18), useIn(68, 18)];
  const draw = interpolate(f, [100, 190], [0, cap], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
  const notes = useIn(190, 20);
  const split = useIn(250, 26);
  const cut = useIn(300, 22);
  const out = useOut(14);
  const pts: string[] = [];
  for (let i = 0; i <= 100; i++) {
    const u = (draw * i) / 100;
    pts.push(`${x(u).toFixed(1)},${y(m(u)).toFixed(1)}`);
  }
  const chip = (a: number, children: React.ReactNode, hi = false) => (
    <span style={{ opacity: a, transform: `translateY(${(1 - a) * 12}px)`, display: "inline-block", padding: "6px 16px", borderRadius: 6, background: hi ? "rgba(183,196,214,0.12)" : "transparent", border: hi ? `1px solid ${C.lineStrong}` : "1px solid transparent" }}>{children}</span>
  );
  return (
    <Backdrop glow={0.8}>
      <AbsoluteFill style={{ opacity: out }}>
        <div style={{ position: "absolute", left: 140, top: 86, opacity: title }}>
          <Kicker n="04">Fair pricing</Kicker>
          <div style={{ fontFamily: sans, fontSize: 64, fontWeight: 600, letterSpacing: -2, marginTop: 18 }}>LPs are paid for what they give up.</div>
          <div style={{ fontFamily: sans, fontSize: 30, color: C.ink2, marginTop: 14, opacity: useIn(10, 20) }}>
            When the position closes they get the exact same liquidity back. While it was out, the borrower pays the fees it missed.
          </div>
        </div>
        <div style={{ position: "absolute", left: 140, top: 312, fontFamily: mono, fontSize: 32, color: C.ink, display: "flex", alignItems: "center", gap: 6 }}>
          {chip(parts[0]!, <>premium = the larger of (</>)}
          {chip(parts[1]!, <span style={{ color: C.ink2 }}>{P.floor_rate_bps / 100}% a year minimum</span>, true)}
          {chip(parts[1]!, <>,</>)}
          {chip(parts[2]!, <><span style={{ color: C.ink }}>multiplier</span> × <span style={{ color: C.good }}>fees the LP missed</span></>, true)}
          {chip(parts[2]!, <>)</>)}
        </div>

        <svg width={1920} height={1080} style={{ position: "absolute", inset: 0 }}>
          <line x1={X0} x2={X1} y1={Y1} y2={Y1} stroke={C.lineStrong} strokeWidth={2} opacity={parts[2]} />
          <line x1={X0} x2={X0} y1={Y0 - 20} y2={Y1} stroke={C.lineStrong} opacity={parts[2]} />
          {[0, 0.2, 0.4, 0.6, 0.8].map((u) => (
            <text key={u} x={x(u)} y={Y1 + 34} fill={C.ink3} fontFamily={mono} fontSize={20} textAnchor="middle" opacity={parts[2]}>{Math.round(u * 100)}%</text>
          ))}
          <text x={X1} y={Y1 + 70} fill={C.ink3} fontFamily={mono} fontSize={20} textAnchor="end" opacity={parts[2]}>share of the range already lent out</text>
          <text x={X0 + 14} y={Y0 + 6} fill={C.ink3} fontFamily={mono} fontSize={20} opacity={parts[2]}>multiplier</text>
          <line x1={x(kink)} x2={x(kink)} y1={Y0 - 10} y2={Y1} stroke={C.ink3} strokeDasharray="3 6" opacity={notes} />
          <polyline points={pts.join(" ")} fill="none" stroke={C.ink} strokeWidth={5} strokeLinejoin="round" />
          <g opacity={notes}>
            <text x={x(0.3)} y={y(base) - 22} fill={C.ink} fontFamily={sans} fontSize={26} fontWeight={600} textAnchor="middle">{base.toFixed(1)}× up to {Math.round(kink * 100)}% lent</text>
            <text x={x(cap) - 10} y={y(mCap) - 22} fill={C.ink} fontFamily={sans} fontSize={26} fontWeight={600} textAnchor="end">{mCap.toFixed(1)}× at the {Math.round(cap * 100)}% cap</text>
          </g>
        </svg>

        {/* where the premium goes */}
        <div style={{ position: "absolute", left: 1100, top: 440, width: 680, opacity: split, transform: `translateY(${(1 - split) * 18}px)` }}>
          <div style={{ fontFamily: mono, fontSize: 20, color: C.ink3, marginBottom: 16 }}>where a premium goes</div>
          <div style={{ display: "flex", height: 84, borderRadius: 6, overflow: "hidden", border: `1px solid ${C.lineStrong}` }}>
            <div style={{ flex: 1, background: "rgba(143,209,176,0.28)", display: "grid", placeItems: "center", fontFamily: sans, fontSize: 24, color: C.ink }}>missed fees → LP</div>
            <div style={{ width: 120 + 60 * cut, display: "flex" }}>
              <div style={{ flex: 9, background: "rgba(143,209,176,0.16)" }} />
              <div style={{ flex: 1 + 2 * cut, background: C.warn, opacity: 0.25 + 0.6 * cut }} />
            </div>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 14, fontFamily: sans, fontSize: 22, color: C.ink2 }}>
            <span>always the LP's, in full</span>
            <span style={{ opacity: cut }}>extra: {100 - P.protocol_fee_bps / 100}% LP · <span style={{ color: C.warn }}>{P.protocol_fee_bps / 100}% protocol</span></span>
          </div>
          <div style={{ marginTop: 34, fontFamily: sans, fontSize: 28, lineHeight: 1.4, color: C.ink, opacity: cut }}>
            The protocol only shares in the extra.<br />Never in what the LP is owed.
          </div>
        </div>
      </AbsoluteFill>
    </Backdrop>
  );
};
