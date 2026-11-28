import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { C, mono, sans } from "../theme";
import { Backdrop, ease, easeInOut, Kicker, useIn, useOut } from "../ui";

// prices relative to today's (1.0); one Orca range just below, one above
const LO = 0.55, HI = 1.45;
const PA = 0.78, PB = 0.92;
const CA = 1.08, CB = 1.25;
const X0 = 200, X1 = 1720, BASE = 740, H = 330;
const x = (p: number) => X0 + ((p - LO) / (HI - LO)) * (X1 - X0);

// value of the range's liquidity at price P (Uniswap v3 / Whirlpool math), in units of its USDC escrow
const sq = Math.sqrt;
const L = 1 / (sq(PB) - sq(PA));
const V = (P: number) => (P >= PB ? 1 : P <= PA ? L * P * (1 / sq(PA) - 1 / sq(PB)) : L * (2 * sq(P) - P / sq(PB) - sq(PA)));
// the value axis starts at half the escrow, so the gap (the put) reads clearly
const VMIN = 0.5;
const y = (v: number) => BASE - ((v - VMIN) / (1 - VMIN)) * H;

const curve = (from: number, to: number, f: (p: number) => number) => {
  const n = 120, pts: string[] = [];
  for (let i = 0; i <= n; i++) {
    const p = from + ((to - from) * i) / n;
    pts.push(`${x(p).toFixed(1)},${y(f(p)).toFixed(1)}`);
  }
  return pts;
};

/** "Concentrated liquidity already is an option": a range below the price, borrowed, becomes a put. */
export const RangeOption: React.FC = () => {
  const f = useCurrentFrame();
  const title = useIn(0, 20);
  const axis = useIn(18, 30);
  const block = useIn(56, 22);
  const escrow = useIn(96, 34);
  const fall = interpolate(f, [150, 370], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: easeInOut });
  const back = interpolate(f, [470, 520], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: easeInOut });
  const P = 1 - 0.38 * fall + 0.38 * back;
  const gap = useIn(250, 24);
  const formula = useIn(380, 26);
  const call = useIn(500, 26);
  const out = useOut(14);

  // curve traced from today's price down to where the price is now (only while falling)
  const traceTo = 1 - 0.38 * fall;
  const traced = curve(1, traceTo, V);
  const shade = traceTo < PB ? [...curve(PB, Math.max(traceTo, LO), V), ...curve(Math.max(traceTo, LO), PB, () => 1)] : null;
  const tokenShare = Math.min(1, Math.max(0, (PB - P) / (PB - PA)));
  const callShare = Math.min(1, Math.max(0, (P - CA) / (CB - CA)));

  const step = f < 96 ? 0 : f < 150 ? 1 : f < 250 ? 2 : f < 470 ? 3 : 4;
  const notes = [
    "An Orca range below today's price holds only USDC.",
    "FORGE borrows it from the LP and locks that USDC in escrow.",
    "The price falls through the range: the liquidity turns into JUP.",
    "Giving the liquidity back now costs less than the escrow. The trader keeps the difference: a put.",
    "The same above the price, with the token, is a call.",
  ];
  const noteA = interpolate(f % 1000, [0, 1], [1, 1]);

  return (
    <Backdrop glow={0.8}>
      <AbsoluteFill style={{ opacity: out }}>
        <div style={{ position: "absolute", left: 140, top: 86, opacity: title, transform: `translateY(${(1 - title) * 16}px)` }}>
          <Kicker n="04">Why it works</Kicker>
          <div style={{ fontFamily: sans, fontSize: 64, fontWeight: 600, letterSpacing: -2, marginTop: 18 }}>A liquidity range already is an option.</div>
        </div>

        <svg width={1920} height={1080} style={{ position: "absolute", inset: 0 }}>
          {/* value axis */}
          <line x1={X0} x2={X0} y1={BASE - H - 40} y2={BASE} stroke={C.lineStrong} opacity={axis} />
          <text x={X0 - 18} y={BASE - H - 52} fill={C.ink3} fontFamily={mono} fontSize={20} textAnchor="start" opacity={axis}>value of the borrowed liquidity</text>
          {/* price axis */}
          <line x1={X0} x2={X0 + (X1 - X0) * axis} y1={BASE + 40} y2={BASE + 40} stroke={C.lineStrong} strokeWidth={2} />
          <text x={X1} y={BASE + 78} fill={C.ink3} fontFamily={mono} fontSize={20} textAnchor="end" opacity={axis}>JUP price →</text>

          {/* escrow line */}
          <line x1={x(HI)} x2={x(HI) - (x(HI) - x(LO)) * escrow} y1={y(1)} y2={y(1)} stroke={C.warn} strokeWidth={2.5} strokeDasharray="10 8" />
          <text x={x(HI) - 10} y={y(1) - 16} fill={C.warn} fontFamily={mono} fontSize={22} textAnchor="end" opacity={escrow}>USDC locked in escrow</text>

          {/* put payoff: escrow minus value */}
          {shade && <polygon points={shade.join(" ")} fill={C.good} opacity={0.22 * Math.max(gap, fall > 0.3 ? 1 : 0)} />}
          {traced.length > 1 && fall > 0 && <polyline points={traced.join(" ")} fill="none" stroke={C.ink} strokeWidth={4} strokeLinejoin="round" />}
          {gap > 0 && (
            <g opacity={gap}>
              <line x1={x(0.66)} x2={x(0.66)} y1={y(V(0.66)) - 6} y2={y(1) + 6} stroke={C.good} strokeWidth={2} />
              <text x={x(0.66) + 18} y={y(V(0.66)) + 54} fill={C.good} fontFamily={sans} fontSize={28} fontWeight={600}>↑ the trader keeps the gap</text>
            </g>
          )}

          {/* ranges on the price axis */}
          <g opacity={block}>
            <rect x={x(PA)} y={BASE + 52} width={x(PB) - x(PA)} height={56} fill={C.lineStrong} />
            <rect x={x(PB) - (x(PB) - x(PA)) * tokenShare} y={BASE + 52} width={(x(PB) - x(PA)) * tokenShare} height={56} fill={C.ink2} />
            <text x={(x(PA) + x(PB)) / 2} y={BASE + 140} fill={C.ink2} fontFamily={mono} fontSize={20} textAnchor="middle">{tokenShare > 0.5 ? "now holds JUP" : "holds USDC"}</text>
          </g>
          <g opacity={call}>
            <rect x={x(CA)} y={BASE + 52} width={x(CB) - x(CA)} height={56} fill={C.ink2} />
            <rect x={x(CA)} y={BASE + 52} width={(x(CB) - x(CA)) * callShare} height={56} fill={C.lineStrong} />
            <text x={(x(CA) + x(CB)) / 2} y={BASE + 140} fill={C.ink2} fontFamily={mono} fontSize={20} textAnchor="middle">holds JUP → a call</text>
          </g>

          {/* today's price and the moving price */}
          <g opacity={axis}>
            <line x1={x(1)} x2={x(1)} y1={BASE - H - 20} y2={BASE + 40} stroke={C.ink3} strokeDasharray="3 6" />
            <text x={x(1)} y={BASE - H - 30} fill={C.ink3} fontFamily={mono} fontSize={20} textAnchor="middle">today</text>
          </g>
          {(fall > 0 || back > 0) && (
            <g>
              <line x1={x(P)} x2={x(P)} y1={BASE - H - 20} y2={BASE + 40} stroke={C.ink} strokeWidth={2} />
              <rect x={x(P) - 52} y={BASE + 22} width={104} height={36} rx={4} fill={C.ink} />
              <text x={x(P)} y={BASE + 47} fill={C.bg} fontFamily={mono} fontSize={20} fontWeight={600} textAnchor="middle">price</text>
              {fall > 0 && back === 0 && <circle cx={x(P)} cy={y(V(P))} r={9} fill={C.ink} />}
            </g>
          )}
        </svg>

        {/* formula */}
        <div style={{ position: "absolute", right: 150, top: 220, opacity: formula, transform: `translateY(${(1 - formula) * 14}px)`, borderLeft: `2px solid ${C.ink2}`, paddingLeft: 26, fontFamily: mono, fontSize: 30, lineHeight: 1.7, color: C.ink2 }}>
          <div>V(P) = L(2√P − P/√p<sub>b</sub> − √p<sub>a</sub>)</div>
          <div style={{ color: C.good }}>put = y<sub>escrow</sub> − V(P) ≥ 0</div>
        </div>

        {/* narration line */}
        <div style={{ position: "absolute", left: 140, right: 140, bottom: 66, fontFamily: sans, fontSize: 34, color: C.ink, letterSpacing: -0.4, opacity: noteA }}>
          {notes.map((n, i) => (
            <div key={i} style={{ position: "absolute", left: 0, right: 0, bottom: 0, opacity: interpolate(f, [[0, 96, 150, 250, 470][i]!, [0, 96, 150, 250, 470][i]! + 14], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease }) * (step === i ? 1 : 0) }}>{n}</div>
          ))}
        </div>
      </AbsoluteFill>
    </Backdrop>
  );
};
