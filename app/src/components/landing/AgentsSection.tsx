import Link from "next/link";
import data from "@/data/agents.json";
import { ShowAgentRun } from "./Hero";
import { Reveal } from "./Reveal";

const a = data.architect;
const usd = (n: number, d = 2) => `$${n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
const price = (n: number) => `$${n.toFixed(5).replace(/0+$/, "").replace(/\.$/, "")}`;

/** Marks who produced a value: the compiler (filled) or Claude (outline). */
function By({ who }: { who: "forge" | "claude" }) {
  return (
    <span className="cap inline-flex items-center gap-1.5">
      <span className={`size-1.5 ${who === "forge" ? "bg-accent" : "border border-ink-3"}`} aria-hidden />
      {who === "forge" ? "computed by FORGE" : "written by Claude"}
    </span>
  );
}

function OptionCard({ o }: { o: (typeof a.options)[number] }) {
  const f = o.facts;
  const rows: [string, string][] = [
    ["Floor · cap", `${price(f.floor_price)} · ${price(f.cap_price)}`],
    ["Worth at least", usd(f.value_at_floor_usd, 0)],
    ["Worth at most", usd(f.value_at_cap_usd, 0)],
    ["Certified error", `±${usd(f.certified_error_bound_usd)}`],
    ["Premium from", `${usd(f.premium_floor_per_day_usd)}/day`],
    ["Capital locked", usd(f.capital_locked_usd)],
  ];
  return (
    <div className={`flex flex-col border bg-panel/60 ${o.recommended ? "border-line-strong" : "border-line"}`}>
      <div className="border-b border-line p-4">
        <By who="claude" />
        <div className="mt-1.5 flex items-baseline justify-between gap-3">
          <h4 className="text-[15px] font-semibold tracking-tight">{o.title}</h4>
          {o.recommended && <span className="num shrink-0 border border-line-strong px-1.5 py-0.5 text-[10px] uppercase tracking-[0.14em] text-ink-2">Recommended</span>}
        </div>
      </div>
      <div className="p-4">
        <By who="forge" />
        <dl className="num mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12.5px]">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="font-sans text-ink-3">{k}</dt>
              <dd className="text-right text-ink">{v}</dd>
            </div>
          ))}
        </dl>
        <div className="num mt-3 truncate text-[11px] text-ink-3" title={f.certificate_hash}>
          {f.legs} ranges · verified · {f.certificate_hash.slice(0, 12)}…
        </div>
      </div>
      <div className="mt-auto border-t border-line p-4">
        <By who="claude" />
        <ul className="mt-1.5 space-y-1 text-[12.5px] leading-snug text-ink-2">
          {o.tradeoffs.map((t) => (
            <li key={t} className="grid grid-cols-[10px_1fr] gap-1.5"><span className="text-ink-3" aria-hidden>–</span>{t}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

const SPLIT = [
  ["Claude interprets", "Separates hard limits from preferences, chooses the structures to try, and writes each option's title and trade-offs."],
  ["FORGE computes every number", "Feasibility, ranges, capital, premium and the certified worst-case error come from the compiler and verifier. Only options that compiled and verified can be shown."],
  ["You sign", "The Architect can prepare a position, but it never signs. You review it in the Studio and open it with your own wallet."],
] as const;

const FLOW = [
  ["Ask", "Call a paid endpoint. FORGE answers 402 with the price and a one-time challenge."],
  ["Pay", "Sign one USDC transfer. FORGE pays the network fee and settles it before any work runs."],
  ["Receive", "Send the same request with the payment signature. The answer carries the result and the settlement transaction."],
] as const;

/** The AI side: the Architect for people, x402 for agents. Every figure is from a real run (src/data/agents.json). */
export function AgentsSection() {
  return (
    <div className="mx-auto mt-14 max-w-[1480px] px-5 sm:px-8">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-10 lg:grid-cols-[1.3fr_1fr] lg:items-start lg:gap-14">
        <Reveal>
          <figure className="overflow-hidden rounded-[6px] border border-line-strong bg-bg">
            <div className="flex h-8 items-center gap-3 border-b border-line px-3">
              <span className="flex gap-1.5" aria-hidden><span className="size-2 bg-line-strong" /><span className="size-2 bg-line-strong" /><span className="size-2 bg-line-strong" /></span>
              <span className="num truncate text-[11px] text-ink-3">forge/studio · Architect</span>
            </div>
            <div className="p-4 sm:p-5">
              <div className="cap">You</div>
              <p className="mt-1.5 border-l border-accent pl-3 text-[15px] leading-relaxed text-ink">{a.request}</p>

              <ol className="num mt-5 space-y-0.5 text-[11.5px] leading-relaxed" aria-label="Architect tool calls">
                {a.tools.map((t, i) => {
                  const infeasible = t.summary.includes("infeasible");
                  return (
                    <li key={i} className="grid grid-cols-[14px_minmax(0,auto)_1fr] gap-x-2">
                      <span className="text-good" aria-hidden>✓</span>
                      <span className="text-ink-3">{t.name}</span>
                      <span className={`min-w-0 break-words ${infeasible ? "text-ink-3" : "text-ink-2"}`}>{t.summary}</span>
                    </li>
                  );
                })}
              </ol>

              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                {[...a.options].sort((x, y) => Number(y.recommended) - Number(x.recommended)).map((o) => <OptionCard key={o.title} o={o} />)}
              </div>

              <div className="mt-5 cap">Architect</div>
              <p className="mt-1.5 text-[14px] leading-relaxed text-ink-2">{a.closing}</p>
            </div>
          </figure>
          <figcaption className="cap mt-3">
            Tool calls, options and reply from a real Architect run on the fork ({a.options[0]!.facts.units.toLocaleString("en-US")} JUP at {price(a.options[0]!.facts.spot_at_compile)}, ${a.options[0]!.facts.premium_budget_usd} premium cap), as returned; the put spread was infeasible, so it was not offered. The request shown is the docs example with the same inputs.
          </figcaption>
        </Reveal>

        <Reveal delay={100}>
          <ol>
            {SPLIT.map(([t, d], i) => (
              <li key={t} className="grid grid-cols-[2.5rem_1fr] border-t border-line py-6 first:border-t-0 first:pt-0">
                <span className="num text-[12px] text-ink-3">{String(i + 1).padStart(2, "0")}</span>
                <div>
                  <h3 className="font-display text-xl font-semibold tracking-tight">{t}</h3>
                  <p className="mt-2 text-[14px] leading-relaxed text-ink-2">{d}</p>
                </div>
              </li>
            ))}
          </ol>
          <Link href="/docs/architect" className="mt-2 inline-flex items-center gap-2 text-[13px] text-ink-2 underline decoration-line-strong underline-offset-4 hover:text-ink">
            How the Architect works <span aria-hidden>→</span>
          </Link>
        </Reveal>
      </div>

      {/* agents */}
      <div className="mt-24 grid grid-cols-[minmax(0,1fr)] gap-10 lg:grid-cols-[1fr_1.3fr] lg:items-start lg:gap-14">
        <Reveal>
          <div className="num text-[12px] text-ink-3">FORGE for agents</div>
          <h3 className="mt-4 font-display text-[clamp(1.6rem,2.6vw,2.3rem)] font-semibold leading-[1.05] tracking-[-0.03em]">
            Other agents buy the same engine, <span className="text-ink-3">one request at a time.</span>
          </h3>
          <p className="mt-4 max-w-lg text-[15px] leading-relaxed text-ink-2">
            Programs and AI agents pay over x402, HTTP&apos;s 402 status, in USDC. No account, no API key. FORGE is its own facilitator: it checks the
            payment, pays the fee and settles it, then does the work.
          </p>
          <ol className="mt-7 max-w-lg space-y-4">
            {FLOW.map(([t, d], i) => (
              <li key={t} className="grid grid-cols-[28px_1fr] gap-x-3">
                <span className="num pt-[1px] text-[13px] text-ink-3">{String(i + 1).padStart(2, "0")}</span>
                <div>
                  <div className="text-[15px] font-medium text-ink">{t}</div>
                  <p className="mt-1 text-[13.5px] leading-relaxed text-ink-2">{d}</p>
                </div>
              </li>
            ))}
          </ol>
          <div className="mt-7 flex flex-wrap gap-x-6 gap-y-3 text-[13px]">
            <Link href="/docs/agents" className="inline-flex items-center gap-2 text-ink-2 underline decoration-line-strong underline-offset-4 hover:text-ink">Read the agent docs <span aria-hidden>→</span></Link>
            <ShowAgentRun className="inline-flex items-center gap-2 text-ink-2 underline decoration-line-strong underline-offset-4 hover:text-ink">Watch a treasury agent buy a hedge <span aria-hidden>↑</span></ShowAgentRun>
          </div>
        </Reveal>

        <Reveal delay={100}>
          <div className="overflow-hidden rounded-[6px] border border-line-strong bg-bg">
            <div className="flex h-8 items-center gap-3 border-b border-line px-3">
              <span className="flex gap-1.5" aria-hidden><span className="size-2 bg-line-strong" /><span className="size-2 bg-line-strong" /><span className="size-2 bg-line-strong" /></span>
              <span className="num truncate text-[11px] text-ink-3">x402 · {data.x402.network}</span>
            </div>
            <table className="num w-full text-[12px]">
              <tbody>
                {data.x402.endpoints.map((e) => (
                  <tr key={e.path} className="border-b border-line last:border-b-0">
                    <td className="w-14 py-2.5 pl-4 text-ink-3">{e.method}</td>
                    <td className="py-2.5 pr-3 text-ink">{e.path}</td>
                    <td className="hidden py-2.5 pr-3 font-sans text-[12.5px] text-ink-2 sm:table-cell">{e.does}</td>
                    <td className={`py-2.5 pr-4 text-right ${e.price === "free" ? "text-ink-3" : "text-ink"}`}>{e.price}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <pre className="num overflow-x-auto border-t border-line bg-sunk px-4 py-4 text-[11.5px] leading-relaxed text-ink-2">
              <code>
                <span className="text-ink-3">import</span> {"{ fetchWithPayment }"} <span className="text-ink-3">from</span> <span className="text-ink">&quot;@forge/fork/x402-client&quot;</span>;{"\n"}
                <span className="text-ink-3">const</span> {"{ response }"} = <span className="text-ink-3">await</span> fetchWithPayment(url, init, signer, {"{ maxAtomicPerRequest: 50_000n }"});
              </code>
            </pre>
          </div>
          <p className="cap mt-3">Test environment: payments settle in fork USDC on FORGE&apos;s Surfpool fork. The service refuses to start anywhere else. The hedge price is provisional.</p>
        </Reveal>
      </div>
    </div>
  );
}
