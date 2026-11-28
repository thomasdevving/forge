"use client";

import { useEffect, useState } from "react";
import { fmtPrice, fmtUsd } from "@/lib/format";
import { clampLevels, PRESETS } from "@/lib/payoff";

export const DURATIONS = [1, 7, 30, 90] as const;

type Props = {
  preset: string;
  /** Level prices read from the chart, or null when the curve was reshaped by hand. */
  levels: number[] | null;
  spot: number | null;
  onPreset: (key: string) => void;
  onLevels: (prices: number[]) => void;
  days: number;
  onDays: (d: number) => void;
  budget: number;
  onBudget: (b: number) => void;
  quote: string;
  suggestion: { budget: number; title: string } | null;
};

const pctOf = (price: number, spot: number) => Math.round((price / spot - 1) * 1000) / 10;

/** A level typed as a % from today's price, with the exact price beside it. */
function LevelRow({ label, price, spot, min, max, onChange }: { label: string; price: number; spot: number; min: number; max: number; onChange: (p: number) => void }) {
  const [text, setText] = useState(String(pctOf(price, spot)));
  const [focused, setFocused] = useState(false);
  // follow the chart while the field is not being typed in
  useEffect(() => {
    if (!focused) setText(String(pctOf(price, spot)));
  }, [price, spot, focused]);
  const commit = (t: string) => {
    const v = Number(t);
    if (t.trim() === "" || !Number.isFinite(v)) return;
    const f = Math.min(max, Math.max(min, 1 + v / 100));
    onChange(f * spot);
  };
  return (
    <label className="grid grid-cols-[88px_minmax(0,1fr)_auto] items-center gap-2">
      <span className="cap">{label}</span>
      <span className="relative block">
        <input
          className="input !py-1 !pl-2 !pr-6 num"
          type="number"
          inputMode="decimal"
          step={0.5}
          value={text}
          aria-label={`${label}, percent from today's price`}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            setText(String(pctOf(price, spot)));
          }}
          onChange={(e) => {
            setText(e.target.value);
            commit(e.target.value);
          }}
        />
        <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-ink-3">%</span>
      </span>
      <span className="num w-[78px] text-right text-[13px] font-medium text-ink">{fmtPrice(price)}</span>
    </label>
  );
}

/** The hedge as a few numbers: strategy, its levels, how long, how much. The chart follows. */
export function HedgeForm(p: Props) {
  const def = PRESETS[p.preset];
  const custom = p.levels === null;
  return (
    <div className="space-y-2.5">
      <label data-tour="presets" className="grid grid-cols-[88px_minmax(0,1fr)] items-center gap-2">
        <span className="cap">Strategy</span>
        <select className="input !py-1 !text-[13px]" value={custom ? "custom" : p.preset} onChange={(e) => p.onPreset(e.target.value)} aria-label="Strategy">
          {custom && <option value="custom">Custom</option>}
          {Object.entries(PRESETS).map(([k, v]) => (
            <option key={k} value={k}>{v.label}</option>
          ))}
        </select>
      </label>
      <p className="pl-[96px] text-[11.5px] leading-snug text-ink-3">
        {custom ? "You reshaped the payoff on the chart. Pick a strategy to start from its levels again." : def?.hint}
      </p>

      {!custom && def && p.spot && p.levels && def.levels.map((lv, i) => (
        <LevelRow
          key={`${p.preset}-${i}`}
          label={lv.label}
          price={p.levels![i]!}
          spot={p.spot!}
          min={lv.min}
          max={lv.max}
          onChange={(price) => {
            const next = [...p.levels!];
            next[i] = price;
            p.onLevels(clampLevels(p.preset, next, p.spot!));
          }}
        />
      ))}

      <div className="grid grid-cols-[88px_minmax(0,1fr)] items-center gap-2">
        <span className="cap">Duration</span>
        <span className="seg !text-[12px]" role="group" aria-label="Duration">
          {DURATIONS.map((d) => (
            <button key={d} type="button" aria-pressed={p.days === d} onClick={() => p.onDays(d)} className="flex-1 !px-2 !py-1">
              {d}d
            </button>
          ))}
        </span>
      </div>

      <label className="grid grid-cols-[88px_minmax(0,1fr)] items-center gap-2">
        <span className="cap">Budget</span>
        <span className="relative block">
          <input
            className="input !py-1 !pl-2 !pr-12 num"
            type="number"
            inputMode="decimal"
            min={0}
            step={1}
            value={p.budget}
            aria-label={`Premium budget in ${p.quote}`}
            onChange={(e) => p.onBudget(Math.max(0, Number(e.target.value) || 0))}
          />
          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-ink-3">{p.quote}</span>
        </span>
      </label>
      <div className="pl-[96px] text-[11.5px] leading-snug text-ink-3">
        {p.suggestion ? (
          <button
            type="button"
            className={`underline decoration-dotted underline-offset-2 hover:text-ink ${p.budget < p.suggestion.budget ? "text-warn" : ""}`}
            onClick={() => p.onBudget(p.suggestion!.budget)}
            title={p.suggestion.title}
          >
            Suggested for {p.days} {p.days === 1 ? "day" : "days"}: {fmtUsd(p.suggestion.budget)}
          </button>
        ) : (
          <span>The most premium you will pay.</span>
        )}
        <span className="block">Closes automatically after {p.days} {p.days === 1 ? "day" : "days"}, or sooner if the budget runs low.</span>
      </div>
    </div>
  );
}
