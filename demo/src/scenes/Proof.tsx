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
  const tiles = [
    { big: opt.feasible, suffix: ` / ${opt.payoffs}`, label: "payoffs compiled on JUP's thin liquidity", note: `vs ${naive.feasible} / ${naive.payoffs} when replicating each kink directly` },
    { big: rep.boundViolations, suffix: "", label: "certificate bounds violated", note: "every certified error held on the fork" },
    { big: lp.borrows_eligible, suffix: "", label: "borrows checked against the LP guarantee", note: `${lp.borrows_guarantee_violations} violations over ${fmt(lp.paths)} price paths` },
    { big: Math.round(keeper.shareBgeA * 100), suffix: "%", label: "of windows: FORGE LPs ≥ plain Orca LPs", note: `${fmt(keeper.n)} windows, ten months of JUP prices, 50% lent, keeper on` },
  ];
  return (
    <Backdrop glow={1}>
      <AbsoluteFill style={{ opacity: out }}>
        <div style={{ position: "absolute", left: 140, top: 86, opacity: title }}>
          <Kicker n="04">Proof</Kicker>
          <div style={{ fontFamily: sans, fontSize: 64, fontWeight: 600, letterSpacing: -2, marginTop: 18 }}>Measured, not promised.</div>
        </div>
        <div style={{ position: "absolute", left: 140, right: 140, top: 300, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 28 }}>
          {tiles.map((t, i) => {
            const a = interpolate(f, [22 + i * 16, 46 + i * 16], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
            const n = Math.round(t.big * interpolate(f, [30 + i * 16, 90 + i * 16], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease }));
            return (
              <div key={i} style={{ padding: "34px 38px", border: `1px solid ${C.lineStrong}`, borderRadius: 8, background: "rgba(20,23,28,0.75)", opacity: a, transform: `translateY(${(1 - a) * 22}px)` }}>
                <div style={{ fontFamily: mono, fontSize: 96, fontWeight: 500, letterSpacing: -3, lineHeight: 1 }}>{fmt(n)}<span style={{ color: C.ink3 }}>{t.suffix}</span></div>
                <div style={{ fontFamily: sans, fontSize: 30, color: C.ink, marginTop: 18 }}>{t.label}</div>
                <div style={{ fontFamily: sans, fontSize: 22, color: C.ink3, marginTop: 8 }}>{t.note}</div>
              </div>
            );
          })}
        </div>
        <div style={{ position: "absolute", left: 140, bottom: 70, fontFamily: mono, fontSize: 22, color: C.ink3, opacity: useIn(110, 20) }}>
          Plus {realized} real positions settled on the fork · reproduce all of it: uv run python benchmarks/run_all.py --fork
        </div>
      </AbsoluteFill>
    </Backdrop>
  );
};
