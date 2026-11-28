import React from "react";
import { AbsoluteFill, interpolate } from "remotion";
import bench from "../data/benchmarks.json";
import { C, mono, sans } from "../theme";
import { Backdrop, ease, fmt, Kicker, useFrame, useIn, useOut } from "../ui";

type Summary = { payoffs: number; feasible: number };
const rep = bench.replication as unknown as { summary: Record<string, Summary>; boundViolations: number };
const opt = rep.summary["optimizer/thin"]!, naive = rep.summary["baseline/thin"]!;
const lp = (bench.lpGuarantee as unknown as { summary: { all: { borrows_eligible: number; borrows_guarantee_violations: number; paths: number } } }).summary.all;
const keeper = (bench as unknown as { lpProfit: { keeper: Record<string, { n: number; shareBgeA: number }> } }).lpProfit.keeper["u50-long"]!;
const realized = (bench.realized as unknown as { rows: unknown[] }).rows.length;

/** The measured results, every number read from app/src/data/benchmarks.json. */
export const Proof: React.FC = () => {
  const f = useFrame();
  const title = useIn(0, 20);
  const out = useOut(14);
  // each tile: the number, then what it counts, in plain words
  const tiles = [
    { big: opt.feasible, suffix: ` of ${opt.payoffs}`, label: "hedges could be built from JUP's small pools", note: `the obvious way, copying each corner directly, managed ${naive.feasible} of ${naive.payoffs}` },
    { big: rep.boundViolations, suffix: "", label: "times a hedge was off by more than promised", note: "every promised error limit held, checked on the fork" },
    { big: lp.borrows_guarantee_violations, suffix: ` of ${fmt(lp.borrows_eligible)}`, label: "loans where an LP got less than the fees it missed", note: `simulated over ${fmt(lp.paths)} real price paths, whenever the trader's budget covered the premium` },
    { big: Math.round(keeper.shareBgeA * 100), suffix: "%", label: "of the time, LPs beat or matched plain Orca", note: `${fmt(keeper.n)} periods across ten months of JUP prices, with half the liquidity lent` },
  ];
  return (
    <Backdrop glow={1}>
      <AbsoluteFill style={{ opacity: out }}>
        <div style={{ position: "absolute", left: 140, top: 86, opacity: title }}>
          <Kicker n="04">How we tested it</Kicker>
          <div style={{ fontFamily: sans, fontSize: 64, fontWeight: 600, letterSpacing: -2, marginTop: 18 }}>Does it hold up? We checked.</div>
          <div style={{ fontFamily: sans, fontSize: 30, color: C.ink2, marginTop: 14 }}>
            On a copy of Solana mainnet with JUP's real pools, and on ten months of real JUP prices.
          </div>
        </div>
        <div style={{ position: "absolute", left: 140, right: 140, top: 330, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 28 }}>
          {tiles.map((t, i) => {
            const a = interpolate(f, [22 + i * 16, 46 + i * 16], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
            const n = Math.round(t.big * interpolate(f, [30 + i * 16, 90 + i * 16], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease }));
            return (
              <div key={i} style={{ padding: "34px 38px", border: `1px solid ${C.lineStrong}`, borderRadius: 8, background: "rgba(20,23,28,0.75)", opacity: a, transform: `translateY(${(1 - a) * 22}px)` }}>
                <div style={{ fontFamily: mono, fontSize: 96, fontWeight: 500, letterSpacing: -3, lineHeight: 1 }}>{fmt(n)}<span style={{ color: C.ink3 }}>{t.suffix}</span></div>
                <div style={{ fontFamily: sans, fontSize: 29, color: C.ink, marginTop: 18 }}>{t.label}</div>
                <div style={{ fontFamily: sans, fontSize: 22, color: C.ink3, marginTop: 8 }}>{t.note}</div>
              </div>
            );
          })}
        </div>
        <div style={{ position: "absolute", left: 140, right: 140, bottom: 44, display: "flex", justifyContent: "space-between", alignItems: "flex-end", opacity: useIn(110, 20) }}>
          <div style={{ fontFamily: mono, fontSize: 20, color: C.ink3 }}>Plus {realized} real positions opened and closed on the fork<br />rerun all of it: uv run python benchmarks/run_all.py --fork</div>
          <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 18px", border: `1px solid ${C.lineStrong}`, borderRadius: 6, background: "rgba(20,23,28,0.8)" }}>
            <span style={{ fontFamily: sans, fontSize: 22, color: C.ink2 }}>Method, charts and caveats:</span>
            <span style={{ fontFamily: mono, fontSize: 22, color: C.ink }}>forge-agr18.vercel.app/proof</span>
          </div>
        </div>
      </AbsoluteFill>
    </Backdrop>
  );
};
