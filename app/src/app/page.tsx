import Link from "next/link";
import bench from "@/data/benchmarks.json";
import { HeroGraphic } from "@/components/landing/HeroGraphic";
import { Example } from "@/components/landing/Example";
import { AgentApiSection, ArchitectSection } from "@/components/landing/AgentsSection";
import { Hero } from "@/components/landing/Hero";
import { ForMode } from "@/components/landing/mode";
import { LiveStrip } from "@/components/landing/LiveStrip";
import { CountUp, Reveal } from "@/components/landing/Reveal";
import { type Step, Walkthrough } from "@/components/landing/Walkthrough";
import { Logo } from "@/components/Logo";
import { SiteNav } from "@/components/landing/SiteNav";
import { config } from "@/lib/config";
import shotMeta from "../../public/shots/meta.json";

type Summary = Record<string, { payoffs: number; feasible: number; median_relative_error_bps: number | null; mean_legs: number | null }>;
const PROOF_MARKET = (bench as { market?: string }).market ?? "SOL/USDC";
const PROOF_BASE = PROOF_MARKET.split("/")[0]!;
const rep = bench.replication as unknown as { run: string; summary: Summary; boundViolations: number; units?: number | null } | null;
const real = bench.realized as unknown as { run: string; refused?: { payoff: string; move: number; guard: string }[]; rows: { slippageBps?: number | null; units?: number | null; payoff: string; move: number; construction: number; gross: number; swapCost: number; bound: number; target: number }[] } | null;
type ProfitRow = { n: number; shareBgeA: number; extraMedianBps: number } | null;
const lpProfit = (bench as unknown as { lpProfit?: { keeper: Record<string, ProfitRow>; noKeeper: Record<string, ProfitRow> } | null }).lpProfit ?? null;
const lp = bench.lpGuarantee as unknown as {
  run: string;
  summary: Record<string, { borrows: number; borrows_eligible: number; borrows_guarantee_holds: number; borrows_guarantee_violations: number; borrows_premium_shortfall: number; restoration_failures_total: number; paths: number }>;
} | null;

const snap = shotMeta as unknown as { market: string; base: string; holdings: { base: number }; openTransactions?: number; spot: number; target: [number, number][]; certifiedBound: number; capitalLocked: number; legs: { kind: string; priceLower: number; priceUpper: number }[] };
const usd = (n: number, d = Math.abs(n) < 1 ? 4 : 2) => `$${n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
const FLOOR = snap.target[1]!, CAP = snap.target[2]!;
const PUTS = snap.legs.filter((l) => l.kind === "borrow_put");
const UNITS = `${snap.holdings.base.toLocaleString("en-US")} ${snap.base}`;

const pctR = (x: number) => (x === 1 ? "100%" : `${(x * 100).toFixed(1)}%`);
const fmt = (n: number, d = 0) => n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

function Head({ n, kicker, title, intro }: { n: React.ReactNode; kicker: string; title: React.ReactNode; intro?: string }) {
  return (
    <Reveal className="mx-auto grid max-w-[1480px] gap-6 px-5 sm:px-8 lg:grid-cols-[1fr_1fr] lg:items-end">
      <div>
        <div className="num flex items-center gap-3 text-[12px] text-ink-3">
          <span className="text-ink">{n}</span>
          <span className="h-px w-8 bg-line-strong" />
          {kicker}
        </div>
        <h2 className="mt-5 font-display text-[clamp(2rem,4.2vw,3.6rem)] font-semibold leading-[0.98] tracking-[-0.03em]">{title}</h2>
      </div>
      {intro && <p className="max-w-lg text-[15px] leading-relaxed text-ink-2 lg:justify-self-end lg:pb-1">{intro}</p>}
    </Reveal>
  );
}

const TRADER: Step[] = [
  {
    title: "Draw what you want",
    body: `You hold ${UNITS} at ${usd(snap.spot, 4)}. You want it never worth less than ${usd(FLOOR[1], 0)}, and you're fine giving up gains above ${usd(CAP[1], 0)}. There is no ${snap.base} options market to buy that from. In FORGE you pick "Collar" or drag the points yourself.`,
    shot: "/shots/studio-draw.jpg", path: "/studio", alt: "Studio with a collar drawn over the bucket ladder",
  },
  {
    title: "FORGE finds the ranges",
    body: `It borrows LP liquidity just below the floor (${PUTS.length ? `${usd(Math.min(...PUTS.map((l) => l.priceLower)), 4)}–${usd(Math.max(...PUTS.map((l) => l.priceUpper)), 4)}` : "below the price"}) and places your ${snap.base} in ranges around the cap. The result matches your line to within ±${usd(snap.certifiedBound)}, checked exactly and written into a certificate.`,
    shot: "/shots/studio-compiled.jpg", path: "/studio", alt: "Compiled collar with cost and certificate",
  },
  {
    title: "Open it on-chain",
    body: `The open is simulated first, then sent as a short series of transactions you sign${snap.openTransactions ? ` (${snap.openTransactions} for this collar)` : ""}. The certificate hash is stored in your position, so anyone can check what you agreed to.`,
    shot: "/shots/studio-open.jpg", path: "/studio", alt: "Open flow with four confirmed steps",
  },
  {
    title: "Close and settle",
    body: "While it is open you see the premium paid against your cap and your current exposure. Closing gives LPs their liquidity back and pays out what the payoff says, from real token balances.",
    shot: "/shots/positions.jpg", path: "/positions", alt: "Open position with legs, premium and greeks",
  },
];

const AGENT_FAQ = [
  ["What does my agent need?", "A Solana key holding fork USDC, and an HTTP client that can answer a 402. The repository's client (@forge/fork/x402-client) does it in one call and checks the price against your cap before it signs anything. No SOL is needed: FORGE pays the network fee."],
  ["Is this real money?", "No. Payments settle in fork USDC on FORGE's Surfpool fork of mainnet, under the network id solana:forge-surfpool, which a client set up for mainnet refuses. The service will not start against anything but a Surfpool fork."],
  ["How does my agent know the hedge is right?", "Every option comes with a certificate: the exact worst-case error between what was asked and what the Orca ranges deliver. POST /x402/verify re-checks it for free, and the certificate is public by its hash."],
  ["What does it cost?", "A compile is $0.01. A hedge (the Architect, which runs a model) has a provisional price until its cost per run is measured. If the work fails after payment, the same request is served again without a second charge."],
  ["Can FORGE move my agent's funds?", "No. FORGE returns an unsigned plan; your agent, or the human behind it, signs the open. The example treasury agent stops and asks its human signer before it opens anything."],
] as const;

const FAQ = [
  ["Is this an options exchange?", "No order book. Each position is built from Orca liquidity ranges: a borrowed range below the price acts as a put, one above as a call. LPs who deposit into FORGE buckets are the other side and are paid a premium."],
  ["Which tokens work?", "Any token with an Orca Whirlpool and a Pyth price feed. The math is the same for every pool, so a new market is one command: point it at the pool, a second pool for restoration swaps, and the feed. The demo fork runs SOL, JUP and BONK against USDC; add another token from the Studio with “+ Add”."],
  ["Where do the numbers on this page come from?", "From committed benchmark runs on a Surfpool mainnet fork and ten months of Binance prices for the token shown. Nothing is typed in by hand; rerun them with benchmarks/run_all.py --fork."],
  ["What does an LP risk?", "Borrowed liquidity needs a 24-hour notice to withdraw. The guarantee is conditional: finite buffers, capped premium budgets and failed restorations can produce shortfalls, which are recorded and pause new borrowing."],
  ["Is the certified bound the whole cost?", "No. It covers replication error over the stated price range. Premium, pool fees and settlement swap costs are reported separately."],
  ["Are opens and closes atomic?", "Not across batches. Large positions span several transactions; pending states and recovery are explicit and anyone can continue them."],
  ["Can I use it with real funds?", "No. It is unaudited hackathon software that runs on a fork with test funds only."],
] as const;

export default function Landing() {
  const opt = rep?.summary["optimizer/thin"];
  const base = rep?.summary["baseline/thin"];
  const lpAll = lp?.summary["all"];
  const realRows = real?.rows ?? [];
  const lpKeeper = Object.values(lpProfit?.keeper ?? {}).filter((r): r is NonNullable<ProfitRow> => !!r);
  const lpNoKeeper = Object.values(lpProfit?.noKeeper ?? {}).filter((r): r is NonNullable<ProfitRow> => !!r);
  const refused = real?.refused ?? [];

  return (
    <div className="overflow-x-clip bg-bg">
      <SiteNav />

      <Hero />

      <ForMode only="people">
      <Example />


      {/* how */}
      <section id="how" className="scroll-mt-14">
        <Walkthrough
          steps={TRADER}
          head={
            <>
              <div className="num flex items-center gap-3 text-[12px] text-ink-3">
                <span className="text-ink">01</span>
                <span className="h-px w-8 bg-line-strong" />
                How it works
              </div>
              <h2 className="mt-4 font-display text-[clamp(1.9rem,3.2vw,2.9rem)] font-semibold leading-[1] tracking-[-0.03em]">One example, start to finish.</h2>
              <p className="mt-3 max-w-md text-[14px] leading-relaxed text-ink-2">{`The ${UNITS} collar from above, in the Studio. Real screens, captured on the fork.`}</p>
            </>
          }
        />
      </section>

      {/* the Architect: describe it instead of drawing it */}
      <section id="architect" className="scroll-mt-14 py-28">
        <Head
          n="02"
          kicker="The Architect"
          title={<>Or describe it.</>}
          intro="Tell the Architect what you hold and what you want. It compiles the alternatives with FORGE's compiler; you pick one and sign."
        />
        <ArchitectSection />
      </section>

      {/* idea */}
      <section className="band">
        <div className="mx-auto grid max-w-[1480px] gap-12 px-5 py-24 sm:px-8 lg:grid-cols-2 lg:items-center">
          <Reveal>
            <div className="num flex items-center gap-3 text-[12px] text-ink-3"><span className="text-ink">03</span><span className="h-px w-8 bg-line-strong" />The idea</div>
            <h2 className="mt-5 font-display text-[clamp(2rem,4vw,3.3rem)] font-semibold leading-[0.98] tracking-[-0.03em]">Concentrated liquidity already is an option.</h2>
            <p className="mt-6 max-w-lg text-[15px] leading-relaxed text-ink-2">
              An Orca range below the price holds only USDC. FORGE borrows it and locks that USDC. If the token falls through the
              range, giving the liquidity back costs less than what was locked, and you keep the difference. That is a put.
              Do the same above the price with the token itself and you get a call.
            </p>
            <div className="num mt-8 border-l border-accent pl-5 text-[14px] leading-8 text-ink-2">
              <div>V(P) = L(2√P − P/√p<sub>b</sub> − √p<sub>a</sub>)</div>
              <div>put = y<sub>escrow</sub> − V(P) ≥ 0</div>
            </div>
          </Reveal>
          <Reveal delay={120}>
            <div className="border border-line bg-bg p-3 sm:p-5">
              <HeroGraphic />
            </div>
          </Reveal>
        </div>
      </section>

      {/* LPs */}
      <section id="lps" className="scroll-mt-14 py-28">
        <Head n="04" kicker="For liquidity providers" title={<>Your liquidity keeps<br />earning, either way.</>} intro="Deposit into a price bucket. While nobody borrows it, it sits in Orca and earns normal fees. When a trader borrows it, they pay you instead." />
        <div className="mx-auto mt-14 grid max-w-[1480px] gap-10 px-5 sm:px-8 lg:grid-cols-[1fr_1.4fr] lg:items-start">
          <ol>
            {[
              ["Paid for what you miss", "Borrowers pay at least the fees your liquidity would have earned in Orca, measured on-chain, plus more as the bucket fills up. A minimum rate pays even in quiet markets."],
              ["Same liquidity back", "When the trade closes, the exact liquidity is restored to the pool. If a borrower's budget runs short, the gap is recorded and new borrowing pauses."],
              ["Leave when you want", "Unborrowed liquidity withdraws instantly. Borrowed liquidity needs 24 hours' notice. At most 80% of a bucket can be lent out."],
            ].map(([t, d], i) => (
              <Reveal key={t} delay={i * 80}>
                <li className="grid grid-cols-[2.5rem_1fr] border-t border-line py-6">
                  <span className="num text-[12px] text-ink-3">{String(i + 1).padStart(2, "0")}</span>
                  <div>
                    <h3 className="font-display text-xl font-semibold tracking-tight">{t}</h3>
                    <p className="mt-2 text-[14px] leading-relaxed text-ink-2">{d}</p>
                  </div>
                </li>
              </Reveal>
            ))}
          </ol>
          <Reveal delay={120}>
            <figure className="overflow-hidden rounded-[6px] border border-line-strong bg-bg">
              <div className="flex h-8 items-center gap-3 border-b border-line px-3">
                <span className="flex gap-1.5" aria-hidden><span className="size-2 bg-line-strong" /><span className="size-2 bg-line-strong" /><span className="size-2 bg-line-strong" /></span>
                <span className="num text-[11px] text-ink-3">forge/earn</span>
              </div>
              <img src="/shots/earn.jpg" alt="Earn: out-of-range liquidity, deposit and the bucket ladder" className="aspect-[16/10] w-full object-cover object-top" loading="lazy" />
            </figure>
          </Reveal>
        </div>
        {lpKeeper.length > 0 && (
          <Reveal className="mx-auto mt-14 max-w-[1480px] px-5 sm:px-8">
            <div className="grid gap-5 border border-line bg-panel/50 p-6 md:grid-cols-[1fr_auto] md:items-center">
              <p className="max-w-3xl text-[14px] leading-relaxed text-ink-2">
                <span className="text-ink">Does it pay?</span> Over {fmt(lpKeeper[0]!.n)} windows of real {PROOF_BASE} prices, FORGE LPs with a keeper ended at
                least level with plain Orca LPs in <span className="num text-ink">{pctR(Math.min(...lpKeeper.map((r) => r.shareBgeA)))}–{pctR(Math.max(...lpKeeper.map((r) => r.shareBgeA)))}</span> of
                them, depending on demand.
                {lpNoKeeper.length > 0 && Math.max(...lpNoKeeper.map((r) => r.shareBgeA)) < 0.5 && " Without a keeper they mostly trailed."}
              </p>
              <Link href="/proof#lp-returns" className="btn btn-ghost !px-4 !py-2 justify-self-start">See the LP evidence <span aria-hidden>→</span></Link>
            </div>
          </Reveal>
        )}
      </section>
      </ForMode>

      <ForMode only="agents">
        {/* the agent API */}
        <section id="agents" className="scroll-mt-14 py-28">
          <Head
            n="01"
            kicker="FORGE for agents"
            title={<>What your agent<br />can do with FORGE.</>}
            intro="Any program that holds Solana tokens can use FORGE on its own: a DAO's treasury agent, a trading bot, a wallet. Each request is paid in USDC over x402 (the web's 402 Payment Required), so there is no account or API key to set up."
          />
          <AgentApiSection />
        </section>
      </ForMode>

      {/* proof */}
      <section id="proof" className="glow-top scroll-mt-14 pt-28 pb-24">
        <Head n={<><ForMode only="people">05</ForMode><ForMode only="agents">02</ForMode></>} kicker="Proof" title={<>Measured on {PROOF_BASE},<br />not promised.</>} intro={`FORGE works on any Orca Whirlpool. The proof runs on ${PROOF_MARKET}, a long-tail market whose pools hold a fraction of SOL’s liquidity, so every number is earned the hard way. Real positions on the fork, ten months of Binance ${PROOF_BASE} prices, one command to reproduce.`} />
        <div className="mx-auto mt-14 max-w-[1480px] px-5 sm:px-8">
          <Reveal>
            <div className="grid border border-line bg-panel/60 md:grid-cols-3">
              <div className="border-line p-6 md:border-r">
                <div className="cap">Payoffs compiled, thin liquidity</div>
                {opt && base ? (
                  <>
                    <div className="num mt-3 text-5xl font-medium tracking-tight"><CountUp value={opt.feasible} />/{opt.payoffs}</div>
                    <p className="mt-3 text-[13px] text-ink-2">vs <span className="num">{base.feasible}/{base.payoffs}</span> for direct replication at each kink. {rep?.boundViolations === 0 ? "0 certificate bounds violated." : `${rep?.boundViolations} bound violations.`}</p>
                  </>
                ) : <p className="cap mt-3">No results recorded.</p>}
              </div>
              <div className="border-t border-line p-6 md:border-r md:border-t-0">
                <div className="cap">Real positions settled on the fork</div>
                {realRows.length ? (
                  <>
                    <div className="num mt-3 text-5xl font-medium tracking-tight"><CountUp value={realRows.length} />{refused.length > 0 && <span className="text-ink-3">/{realRows.length + refused.length}</span>}</div>
                    <p className="mt-3 text-[13px] text-ink-2">
                      Each settled payoff equals the certified construction minus the measured swap cost (largest <span className="num">${fmt(Math.max(...realRows.map((r) => r.swapCost)), 2)}</span>).
                      {refused.length > 0 && <> The other {refused.length}, all closed after a 10% drop, were refused by the program’s price guards: the thin pool could not restore them at a fair price, so FORGE waited instead of overpaying. They stay recoverable.</>}
                    </p>
                  </>
                ) : <p className="cap mt-3">No results recorded.</p>}
              </div>
              <div className="border-t border-line p-6 md:border-t-0">
                <div className="cap">LP guarantee holds</div>
                {lpAll ? (
                  <>
                    <div className="num mt-3 text-5xl font-medium tracking-tight"><CountUp value={lpAll.borrows_guarantee_holds} /></div>
                    <p className="mt-3 text-[13px] text-ink-2">of <span className="num">{fmt(lpAll.borrows_eligible)}</span> eligible borrows, <span className="num">{lpAll.borrows_guarantee_violations}</span> violations over {fmt(lpAll.paths)} path runs. Shortfalls reported, not filtered.</p>
                  </>
                ) : <p className="cap mt-3">No results recorded.</p>}
              </div>
            </div>
          </Reveal>
          <Reveal delay={100}>
            <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3">
              <Link href="/proof" className="btn btn-ghost !px-5 !py-2.5">See all the proof <span aria-hidden>→</span></Link>
              <span className="cap">Method, results and caveats for each benchmark, plus a study of the last eight weeks.</span>
            </div>
          </Reveal>
        </div>
      </section>

      {/* fork: the hero's screens are real and run here */}
      <section id="fork" className="relative">
        <div className="mx-auto grid max-w-[1480px] gap-10 px-5 py-24 sm:px-8 lg:grid-cols-[1fr_1.6fr] lg:items-center">
          <Reveal>
            <div className="num flex items-center gap-3 text-[12px] text-ink-3"><span className="size-1.5 animate-pulse bg-good" />Live right now</div>
            <h2 className="mt-5 font-display text-[clamp(1.9rem,3.4vw,3rem)] font-semibold leading-[1] tracking-[-0.03em]">Running on a copy of Solana mainnet.</h2>
            <p className="mt-5 max-w-md text-[15px] leading-relaxed text-ink-2">
              FORGE runs on a Surfpool fork: Orca’s real pools and programs, copied from mainnet, with test money. Prices can be moved to show a crash. Grab free
              fork funds with the demo wallet and try every step. Nothing touches mainnet.
            </p>
          </Reveal>
          <Reveal delay={120}>
            <LiveStrip />
            <p className="cap mt-3">Read from the fork every 15 seconds.</p>
          </Reveal>
        </div>
      </section>

      <ForMode only="people">
      {/* faq */}
      <section id="faq" className="scroll-mt-14 py-28">
        <div className="mx-auto grid max-w-[1480px] gap-12 px-5 sm:px-8 lg:grid-cols-[1fr_1.4fr]">
          <Reveal>
            <div className="num flex items-center gap-3 text-[12px] text-ink-3"><span className="text-ink">06</span><span className="h-px w-8 bg-line-strong" />Questions</div>
            <h2 className="mt-5 font-display text-[clamp(2rem,4vw,3.3rem)] font-semibold leading-[0.98] tracking-[-0.03em]">Read this before you trust it.</h2>
            <p className="mt-6 max-w-md text-[14px] leading-relaxed text-ink-3">Prior art: Panoptic builds options from CLMM positions on Ethereum. FORGE adds payoff synthesis, certified error, the bucket ladder and testable LP restoration, on Solana.</p>
          </Reveal>
          <Reveal delay={100}>
            <div className="border-b border-line">
              {FAQ.map(([q, a]) => (
                <details key={q} className="group border-t border-line">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-6 py-5 text-[15px] font-medium [&::-webkit-details-marker]:hidden">
                    {q}
                    <span className="relative size-3 shrink-0" aria-hidden>
                      <span className="absolute inset-x-0 top-1/2 h-px bg-ink-2" />
                      <span className="absolute inset-y-0 left-1/2 w-px bg-ink-2 transition-transform group-open:scale-y-0" />
                    </span>
                  </summary>
                  <p className="max-w-2xl pb-5 text-[14px] leading-relaxed text-ink-2">{a}</p>
                </details>
              ))}
            </div>
          </Reveal>
        </div>
      </section>
      </ForMode>
      <ForMode only="agents">
      {/* faq */}
      <section id="faq-agents" className="scroll-mt-14 py-28">
        <div className="mx-auto grid max-w-[1480px] gap-12 px-5 sm:px-8 lg:grid-cols-[1fr_1.4fr]">
          <Reveal>
            <div className="num flex items-center gap-3 text-[12px] text-ink-3"><span className="text-ink">03</span><span className="h-px w-8 bg-line-strong" />Questions</div>
            <h2 className="mt-5 font-display text-[clamp(2rem,4vw,3.3rem)] font-semibold leading-[0.98] tracking-[-0.03em]">What your agent should know.</h2>
          </Reveal>
          <Reveal delay={100}>
            <div className="border-b border-line">
              {AGENT_FAQ.map(([q, a]) => (
                <details key={q} className="group border-t border-line">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-6 py-5 text-[15px] font-medium [&::-webkit-details-marker]:hidden">
                    {q}
                    <span className="relative size-3 shrink-0" aria-hidden>
                      <span className="absolute inset-x-0 top-1/2 h-px bg-ink-2" />
                      <span className="absolute inset-y-0 left-1/2 w-px bg-ink-2 transition-transform group-open:scale-y-0" />
                    </span>
                  </summary>
                  <p className="max-w-2xl pb-5 text-[14px] leading-relaxed text-ink-2">{a}</p>
                </details>
              ))}
            </div>
          </Reveal>
        </div>
      </section>
      </ForMode>

      <ForMode only="people">
      {/* cta */}
      <section className="glow-top">
        <div className="mx-auto max-w-[1480px] px-5 py-28 sm:px-8">
          <Reveal>
            <h2 className="max-w-4xl font-display text-[clamp(2.2rem,5.4vw,4.8rem)] font-semibold leading-[0.95] tracking-[-0.035em]">
              Pick a token. Draw a floor and a cap. <span className="text-ink-3">Watch it settle.</span>
            </h2>
            <div className="mt-10 flex flex-wrap items-center gap-3">
              <Link href="/studio" className="btn btn-primary !px-5 !py-2.5">Launch App <span aria-hidden>↗</span></Link>
              <a href={config.repoUrl} className="btn btn-ghost !px-5 !py-2.5" target="_blank" rel="noreferrer">Read the code</a>
              <span className="cap ml-2">Demo wallet with fork funds · about two minutes</span>
            </div>
          </Reveal>
        </div>
      </section>
      </ForMode>
      <ForMode only="agents">
      <section className="glow-top">
        <div className="mx-auto max-w-[1480px] px-5 py-28 sm:px-8">
          <Reveal>
            <h2 className="max-w-4xl font-display text-[clamp(2.2rem,5.4vw,4.8rem)] font-semibold leading-[0.95] tracking-[-0.035em]">
              Point your agent at /x402. <span className="text-ink-3">It pays per request and gets back a certified hedge.</span>
            </h2>
            <div className="mt-10 flex flex-wrap items-center gap-3">
              <Link href="/docs/agents" className="btn btn-primary !px-5 !py-2.5">Read the agent docs <span aria-hidden>→</span></Link>
              <a href={`${config.repoUrl}/tree/main/agents/treasury`} className="btn btn-ghost !px-5 !py-2.5" target="_blank" rel="noreferrer">See the treasury agent</a>
              <span className="cap ml-2">Test environment · fork USDC · no real funds</span>
            </div>
          </Reveal>
        </div>
      </section>
      </ForMode>

      <footer className="bg-gradient-to-b from-transparent to-sunk/80">
        <div className="mx-auto flex max-w-[1480px] flex-col gap-3 px-5 py-8 text-[12px] text-ink-3 sm:flex-row sm:items-center sm:px-8">
          <Logo className="h-[18px] w-auto" />
          <span className="sm:ml-6">Built for the Dev3pack hackathon on Solana.</span>
          <span className="sm:ml-auto">Not audited · fork only · open source</span>
        </div>
      </footer>
    </div>
  );
}
