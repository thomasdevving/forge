import Link from "next/link";
import data from "@/data/agents.json";
import { ShowAgentRun } from "./Hero";
import { Reveal } from "./Reveal";

const a = data.architect;
const usd = (n: number, d = 2) => `$${n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
const price = (n: number) => `$${n.toFixed(5).replace(/0+$/, "").replace(/\.$/, "")}`;

function OptionCard({ o }: { o: (typeof a.options)[number] }) {
  const f = o.facts;
  const rows: [string, string][] = [
    ["Floor · cap", `${price(f.floor_price)} · ${price(f.cap_price)}`],
    ["Worth", `${usd(f.value_at_floor_usd, 0)} – ${usd(f.value_at_cap_usd, 0)}`],
    ["Certified error", `±${usd(f.certified_error_bound_usd)}`],
    ["Premium from", `${usd(f.premium_floor_per_day_usd)}/day`],
  ];
  return (
    <div className={`border p-4 ${o.recommended ? "border-line-strong bg-panel/70" : "border-line bg-panel/40"}`}>
      <div className="flex items-baseline justify-between gap-3">
        <h4 className="text-[14.5px] font-semibold tracking-tight">{o.title}</h4>
        {o.recommended && <span className="cap shrink-0">Recommended</span>}
      </div>
      <dl className="num mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12.5px]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="font-sans text-ink-3">{k}</dt>
            <dd className="text-right text-ink">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="num mt-3 truncate text-[11px] text-ink-3" title={f.certificate_hash}>verified · {f.certificate_hash.slice(0, 12)}…</div>
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

/** The Architect, for traders: describe the hedge in words. Every figure is from a real run (src/data/agents.json). */
export function ArchitectSection() {
  const compiles = a.tools.filter((t) => t.name === "compile_strategy");
  const feasible = compiles.filter((t) => !t.summary.includes("infeasible")).length;
  return (
    <div className="mx-auto mt-14 max-w-[1480px] px-5 sm:px-8">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-10 lg:grid-cols-[1.25fr_1fr] lg:items-start lg:gap-16">
        <Reveal>
          <figure className="overflow-hidden rounded-[6px] border border-line-strong bg-bg">
            <div className="flex h-8 items-center gap-3 border-b border-line px-3">
              <span className="flex gap-1.5" aria-hidden><span className="size-2 bg-line-strong" /><span className="size-2 bg-line-strong" /><span className="size-2 bg-line-strong" /></span>
              <span className="num truncate text-[11px] text-ink-3">Studio · Architect</span>
            </div>
            <div className="p-4 sm:p-6">
              <p className="border-l border-accent pl-3 text-[15px] leading-relaxed text-ink">{a.request}</p>
              <p className="num mt-4 text-[11.5px] text-ink-3">
                Read holdings, prices, past moves and liquidity · compiled {compiles.length} structures, {feasible} feasible
              </p>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {[...a.options].sort((x, y) => Number(y.recommended) - Number(x.recommended)).map((o) => <OptionCard key={o.title} o={o} />)}
              </div>
            </div>
          </figure>
          <figcaption className="cap mt-3">A real Architect run on the fork. Titles are Claude&apos;s; every number is the compiler&apos;s.</figcaption>
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
    </div>
  );
}

const t = data.treasury.result;

/** What an agent can buy, in plain words, with the endpoint behind each. The hedge example is the real treasury run. */
const USES = [
  {
    title: "Protect what it holds",
    body: "Your agent says what it holds and what it wants, in plain words. It gets back hedges that are already checked and ready to sign.",
    example: `“Protect ${t.units.toLocaleString("en-US")} ${t.base} against a 30% drop, at most $${t.premiumBudgetUsd} premium.” → a put flooring it at $${t.floor}, certified to ±$${t.certifiedErrorUsd.toFixed(2)}.`,
    endpoint: "POST /x402/hedge",
  },
  {
    title: "Price any payoff",
    body: "Send the payoff it wants, as price points. FORGE answers with the exact Orca ranges, the capital it locks, the premium and the worst-case error.",
    example: "Lets a trading bot see what protection costs before it commits.",
    endpoint: "POST /x402/compile",
  },
  {
    title: "Check before it trusts",
    body: "Re-check any certificate, its own or one it was handed. The math is redone from scratch.",
    example: "Free, so an agent can verify every number it is shown.",
    endpoint: "POST /x402/verify",
  },
  {
    title: "Find what it can hedge",
    body: "List the tokens FORGE supports, with live pool prices and limits.",
    example: "Free. Any token with an Orca pool and a price feed can be added.",
    endpoint: "GET /x402/markets",
  },
] as const;

const priceOf = (path: string) => data.x402.endpoints.find((e) => path.endsWith(e.path))?.price ?? "";

/** FORGE for agents: what an agent can do, how a paid request works, the endpoints and the client. */
export function AgentApiSection() {
  return (
    <div className="mx-auto mt-14 max-w-[1480px] px-5 sm:px-8">
      <Reveal>
        <div className="grid border border-line sm:grid-cols-2 lg:grid-cols-4">
          {USES.map((u, i) => (
            <div key={u.title} className={`flex flex-col border-line p-6 ${i > 0 ? "max-sm:border-t" : ""} ${i % 2 ? "sm:border-l" : ""} ${i >= 2 ? "sm:max-lg:border-t" : ""} ${i > 0 ? "lg:border-l" : ""}`}>
              <div className="num text-[12px] text-ink-3">{String(i + 1).padStart(2, "0")}</div>
              <h3 className="mt-3 font-display text-[19px] font-semibold tracking-tight">{u.title}</h3>
              <p className="mt-2 text-[14px] leading-relaxed text-ink-2">{u.body}</p>
              <p className="mt-3 text-[12.5px] leading-relaxed text-ink-3">{u.example}</p>
              <div className="num mt-auto flex items-center justify-between gap-3 pt-5 text-[11.5px]">
                <span className="text-ink-2">{u.endpoint}</span>
                <span className={priceOf(u.endpoint) === "free" ? "text-ink-3" : "text-ink"}>{priceOf(u.endpoint)}</span>
              </div>
            </div>
          ))}
        </div>
        <p className="cap mt-3">
          The hedge example is a real run: an example treasury agent paid ${t.apiSpendUsd.toFixed(2)}, checked the certificate against its own rules, asked its human, then
          opened the position in {t.transactions} transactions.
        </p>
      </Reveal>

      <div className="mt-20 grid grid-cols-[minmax(0,1fr)] gap-10 lg:grid-cols-[1fr_1.3fr] lg:items-start lg:gap-14">
        <Reveal>
          <h3 className="font-display text-[clamp(1.4rem,2.2vw,1.9rem)] font-semibold leading-tight tracking-[-0.02em]">How a paid request works</h3>
          <ol className="mt-6 max-w-lg space-y-5">
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
          <div className="mt-8 flex flex-wrap gap-x-6 gap-y-3 text-[13px]">
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
