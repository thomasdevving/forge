"use client";

import { useEffect, useRef, useState } from "react";
import { fmtPrice, fmtUsd } from "@/lib/format";
import type { Point } from "@/lib/payoff";

/** Server events (services/agent/src/session.ts AgentEvent). */
type Facts = {
  construction_id: string; label: string; market: string; structure: string; units: number;
  floor_price: number | null; cap_price: number | null; lower_price: number | null;
  value_at_floor_usd: number | null; value_at_cap_usd: number | null; status: string;
  certified_error_bound_usd: number | null; legs: number; capital_locked_usd: number | null;
  premium_floor_per_day_usd?: number; premium_budget_usd?: number; max_days_of_cover_at_floor_rate?: number | null;
  certificate_hash: string | null; verified: boolean;
};
type Card = { construction_id: string; title: string; summary: string; tradeoffs: string[]; recommended: boolean; facts: Facts };
type Ev =
  | { type: "status"; text: string }
  | { type: "text"; delta: string }
  | { type: "tool_start"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; ok: boolean; summary: string }
  | { type: "options"; options: Card[] }
  | { type: "prepared"; construction_id: string; review: Record<string, unknown> }
  | { type: "done"; model: string }
  | { type: "error"; message: string };

type Item =
  | { kind: "user"; text: string }
  | { kind: "text"; text: string }
  | { kind: "step"; id: string; name: string; state: "run" | "ok" | "err"; summary?: string }
  | { kind: "options"; cards: Card[] }
  | { kind: "prepared"; id: string }
  | { kind: "error"; text: string };

export type Design = { market: string; payoff: Point[]; limits: { base: number; quote: number; budget: number }; label: string };

const STEP_LABEL: Record<string, string> = {
  get_wallet_holdings: "Read holdings",
  get_market_data: "Market data",
  get_available_liquidity: "Funded liquidity",
  compile_strategy: "Compile",
  verify_strategy: "Verify certificate",
  compare_strategies: "Compare",
  present_options: "Present options",
  prepare_transaction: "Prepare for signature",
};

const EXAMPLES = [
  "I hold JUP. Protect it against a crash, I can give up some upside, and spend no more than $20 on premium.",
  "Floor 10 SOL at 90% of today's price for a week, cheapest way.",
];

/**
 * "Describe what you want": the FORGE Architect as a side panel of the Studio. The model's text is
 * shown as written; every number on the cards comes from the compiler through the agent service.
 */
export function Architect({ open, onClose, owner, onLoad }: { open: boolean; onClose: () => void; owner: string | null; onLoad: (d: Design) => void }) {
  const [session, setSession] = useState<{ id: string; model: string; configured: boolean; owner: string | null } | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  // one conversation per wallet
  useEffect(() => {
    if (!open || (session && session.owner === owner)) return;
    setItems([]);
    fetch("/api/agent/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(owner ? { owner } : {}) })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`Architect unavailable (${r.status})`))))
      .then((s) => setSession({ ...s, owner }))
      .catch((e: Error) => setErr(e.message));
  }, [open, owner, session]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [items, status]);

  const load = async (cid: string) => {
    if (!session) return;
    const r = await fetch(`/api/agent/sessions/${session.id}/constructions/${cid}`);
    if (!r.ok) return setErr("Could not load that construction.");
    const d = (await r.json()) as { market: string; payoff: Point[]; limits: Design["limits"]; facts: Facts };
    onLoad({ market: d.market, payoff: d.payoff, limits: d.limits, label: d.facts.label });
  };

  const send = async (text: string) => {
    if (!session || busy || !text.trim()) return;
    setErr(null);
    setBusy(true);
    setInput("");
    setItems((p) => [...p, { kind: "user", text }]);
    try {
      const res = await fetch(`/api/agent/sessions/${session.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => null);
        throw new Error(j?.error ?? `HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = chunk.split("\n").find((l) => l.startsWith("data: "));
          if (line) apply(JSON.parse(line.slice(6)) as Ev);
        }
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
      setStatus(null);
    }
  };

  const apply = (e: Ev) => {
    if (e.type === "status") return setStatus(e.text);
    setStatus(null);
    setItems((p) => {
      const out = [...p];
      const last = out[out.length - 1];
      switch (e.type) {
        case "text":
          if (last?.kind === "text") out[out.length - 1] = { kind: "text", text: last.text + e.delta };
          else out.push({ kind: "text", text: e.delta });
          break;
        case "tool_start":
          out.push({ kind: "step", id: e.id, name: e.name, state: "run" });
          break;
        case "tool_result": {
          const k = out.findIndex((x) => x.kind === "step" && x.id === e.id);
          const step: Item = { kind: "step", id: e.id, name: e.name, state: e.ok ? "ok" : "err", summary: e.summary };
          if (k >= 0) out[k] = step;
          else out.push(step);
          break;
        }
        case "options":
          out.push({ kind: "options", cards: e.options });
          break;
        case "prepared":
          out.push({ kind: "prepared", id: e.construction_id });
          void load(e.construction_id);
          break;
        case "error":
          out.push({ kind: "error", text: e.message });
          break;
      }
      return out;
    });
  };

  if (!open) return null;
  return (
    <aside className="fixed inset-y-0 right-0 z-40 flex w-full max-w-[460px] flex-col border-l border-line bg-bg shadow-[-24px_0_48px_rgba(0,0,0,0.35)]">
      <div className="flex min-h-12 shrink-0 items-center gap-3 border-b border-line px-4">
        <h2 className="text-[13px] font-semibold">Architect</h2>
        <span className="cap">Describe what you want</span>
        {session && <span className="cap ml-auto num">{session.model}</span>}
        <button className="btn btn-ghost !px-2 !py-1 text-[12px]" onClick={onClose} aria-label="Close the Architect">Close</button>
      </div>

      <div ref={scroller} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4 text-[13px] leading-relaxed">
        {session && !session.configured && (
          <p className="border border-warn/50 p-3 text-warn">The Architect is not configured on this server (no model key). The Studio works as before.</p>
        )}
        {items.length === 0 && session?.configured && (
          <div className="space-y-2">
            <p className="text-ink-2">
              Say what you hold and what you want to happen. The Architect reads your holdings and FORGE&apos;s liquidity, compiles alternatives with the
              FORGE compiler, and hands the one you pick to the Studio. You sign; it never does.
            </p>
            {EXAMPLES.map((x) => (
              <button key={x} className="block w-full border border-line px-3 py-2 text-left text-ink-2 hover:border-ink-3 hover:text-ink" onClick={() => void send(x)}>
                {x}
              </button>
            ))}
          </div>
        )}
        {items.map((it, i) => {
          switch (it.kind) {
            case "user":
              return <p key={i} className="ml-8 border border-line bg-panel/60 px-3 py-2">{it.text}</p>;
            case "text":
              return <p key={i} className="whitespace-pre-wrap text-ink-2">{it.text}</p>;
            case "step":
              return (
                <div key={i} className="flex items-baseline gap-2 text-[12px]">
                  <span className={it.state === "ok" ? "text-good" : it.state === "err" ? "text-bad" : "text-ink-3"}>{it.state === "run" ? "…" : it.state === "ok" ? "✓" : "✕"}</span>
                  <span className="text-ink">{STEP_LABEL[it.name] ?? it.name}</span>
                  {it.summary && <span className="truncate text-ink-3">{it.summary}</span>}
                </div>
              );
            case "options":
              return (
                <div key={i} className="space-y-2">
                  {it.cards.map((c) => (
                    <OptionCard key={c.construction_id} c={c} onReview={() => void load(c.construction_id)} onPick={() => void send(`Prepare "${c.title}" (${c.construction_id}).`)} busy={busy} />
                  ))}
                </div>
              );
            case "prepared":
              return <p key={i} className="border border-good/40 p-3 text-good">Loaded into the Studio. Review it there and open it with your wallet.</p>;
            case "error":
              return <p key={i} className="text-bad">{it.text}</p>;
          }
        })}
        {status && <p className="cap">{status}…</p>}
        {err && <p className="text-bad">{err}</p>}
      </div>

      <form
        className="shrink-0 border-t border-line p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        <textarea
          className="input h-20 resize-none text-[13px]"
          placeholder="I hold 20,000 JUP. Protect it against a crash, keep some upside, max $50 premium."
          value={input}
          maxLength={2000}
          disabled={!session?.configured || busy}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(input);
            }
          }}
        />
        <div className="mt-2 flex items-center gap-2">
          <span className="cap">Numbers come from the FORGE compiler. Simulation only.</span>
          <button className="btn btn-primary ml-auto" disabled={!session?.configured || busy || !input.trim()}>{busy ? "Working" : "Send"}</button>
        </div>
      </form>
    </aside>
  );
}

function OptionCard({ c, onReview, onPick, busy }: { c: Card; onReview: () => void; onPick: () => void; busy: boolean }) {
  const f = c.facts;
  return (
    <div className={`border p-3 ${c.recommended ? "border-ink-3" : "border-line"}`}>
      <div className="flex items-baseline gap-2">
        <div className="font-semibold text-ink">{c.title}</div>
        {c.recommended && <span className="tag">Recommended</span>}
        <span className="cap ml-auto">{f.structure.replace("_", " ")}</span>
      </div>
      <p className="mt-1 text-[12.5px] text-ink-2">{c.summary}</p>
      <div className="mt-2 grid grid-cols-2 gap-x-4">
        {f.floor_price != null && <div className="kv"><span>Floor</span><span>{fmtPrice(f.floor_price)}{f.value_at_floor_usd != null && ` · ${fmtUsd(f.value_at_floor_usd)}`}</span></div>}
        {f.cap_price != null && <div className="kv"><span>Cap</span><span>{fmtPrice(f.cap_price)}{f.value_at_cap_usd != null && ` · ${fmtUsd(f.value_at_cap_usd)}`}</span></div>}
        <div className="kv"><span>Size</span><span>{f.units.toLocaleString("en-US")} {f.market.split("/")[0]}</span></div>
        <div className="kv"><span>Worst-case error</span><span>±{fmtUsd(f.certified_error_bound_usd ?? 0)}</span></div>
        {f.premium_floor_per_day_usd != null && <div className="kv"><span>Premium from</span><span>{fmtUsd(f.premium_floor_per_day_usd)}/day</span></div>}
        {f.premium_budget_usd != null && <div className="kv"><span>Max premium</span><span>{fmtUsd(f.premium_budget_usd)}</span></div>}
        {f.capital_locked_usd != null && <div className="kv"><span>Capital locked</span><span>{fmtUsd(f.capital_locked_usd)}</span></div>}
        <div className="kv"><span>Ranges</span><span>{f.legs}</span></div>
      </div>
      {c.tradeoffs.length > 0 && (
        <ul className="mt-2 list-disc space-y-0.5 pl-4 text-[12px] text-ink-3">
          {c.tradeoffs.map((t) => <li key={t}>{t}</li>)}
        </ul>
      )}
      <div className="mt-3 flex items-center gap-2">
        <span className="cap num" title={f.certificate_hash ?? ""}>{f.verified ? `Verified ${f.certificate_hash?.slice(0, 8)}…` : "Not verified"}</span>
        <button className="btn btn-ghost ml-auto !py-1 text-[12px]" onClick={onReview}>Review in Studio</button>
        <button className="btn btn-primary !py-1 text-[12px]" disabled={busy} onClick={onPick}>Choose</button>
      </div>
    </div>
  );
}
