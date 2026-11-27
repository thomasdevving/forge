/**
 * Demo control service for the hosted fork. Runs next to Surfpool on the private network.
 *
 *   POST /faucet {address}           public, rate limited: fork-only SOL, wrapped SOL, USDC and the
 *                                    base token of every other market, for throwaway demo wallets
 *   POST /scenario {price, market?}  (Bearer DEMO_CONTROL_TOKEN) move a market's two pools with real
 *                                    swaps and publish its labelled scenario reference (default SOL/USDC)
 *   POST /time-travel {seconds}      (Bearer) advance the fork clock, keep the reference fresh
 *   POST /markets {mint}             public, rate limited: onboard any token as a market (Orca pools and
 *                                    Pyth feeds are discovered); runs as a job, one at a time
 *   GET  /markets/jobs/:id           job state and log
 *   POST /mirror {owner, burner}     public, rate limited: copy a real wallet's mainnet balances (SOL and
 *                                    every market token) onto a burner key on the fork; read-only on mainnet
 *   GET  /scenario                   current scenario price and reference age
 *   GET  /health
 *
 * The reference keeper republishes every market's *scenario price* (never the pool price) every 20 s
 * so each reference stays fresh; the program's checks still compare pools against it.
 */
import Fastify from "fastify";
import cors from "@fastify/cors";
import { address, type Address } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { getCreateAssociatedTokenIdempotentInstructionAsync, getSyncNativeInstruction } from "@solana-program/token";
import { ata, fundWallet, loadKey, readDeployment, writeDeployment } from "./env.js";
import { mirrorOnto, readMainnetBalances } from "./mirror.js";
import { discoverMarket, OnboardError, setupMarket } from "./onboard.js";
import { movePoolTo } from "./price.js";
import { MARKETS } from "./markets.js";
import { FEED_USDC_USD, readPyth, setScenarioPrice } from "./pyth.js";
import { airdrop, assertFork, forkClock, forkRpc, sendInstructions, setTokenBalance, timeTravel, USDC, WSOL } from "./surfnet.js";

const PORT = Number(process.env.PORT ?? 8791);
const TOKEN = process.env.DEMO_CONTROL_TOKEN ?? "";
const ORIGINS = (process.env.FORGE_ALLOWED_ORIGINS ?? "http://localhost:3000").split(",");
const rpc = forkRpc();
const dep = readDeployment();
const DEFAULT_MARKET = "SOL/USDC";
// Resume from the reference last published on chain (a restart must not jump back to the
// bootstrap price); fall back to the bootstrap scenario if the account cannot be read.
const scenarios: Record<string, number> = {};
for (const [k, v] of Object.entries(dep.markets)) {
  try {
    const [b, q] = await Promise.all([readPyth(v.referenceBase), readPyth(v.referenceQuote)]);
    scenarios[k] = (Number(b.price) * 10 ** b.exponent) / (Number(q.price) * 10 ** q.exponent);
  } catch {
    scenarios[k] = v.scenarioPrice;
  }
}
const feeds = (name: string) => {
  const d = dep.markets[name]!;
  return {
    base: d.feedBase ?? MARKETS[name]!.feedBase,
    quote: d.feedQuote ?? MARKETS[name]?.feedQuote ?? FEED_USDC_USD,
    decimals: [d.baseDecimals ?? MARKETS[name]?.baseDecimals ?? 9, d.quoteDecimals ?? MARKETS[name]?.quoteDecimals ?? 6] as const,
  };
};

async function publish() {
  for (const [name, d] of Object.entries(dep.markets)) {
    const f = feeds(name);
    await setScenarioPrice(d.referenceBase, f.base, scenarios[name]!);
    await setScenarioPrice(d.referenceQuote, f.quote, 1.0);
  }
}

const faucetSeen = new Map<string, number>();
const ipSeen = new Map<string, number[]>();

const app = Fastify({ logger: false });
await app.register(cors, { origin: ORIGINS });

function authorized(h: string | undefined) {
  return TOKEN.length >= 16 && h === `Bearer ${TOKEN}`;
}

app.get("/health", async () => ({ ok: true, fork: await assertFork().catch(() => null), scenarioPrice: scenarios[DEFAULT_MARKET], scenarios }));

app.get("/scenario", async () => ({ scenarioPrice: scenarios[DEFAULT_MARKET], scenarios, clock: (await forkClock()).unixTimestamp, label: "fork-only scenario reference" }));

// ---- read-only mirror of a real wallet onto a burner key ----
const mirrorSeen = new Map<string, number>();
app.post<{ Body: { owner: string; burner: string } }>("/mirror", async (req, reply) => {
  let owner: Address, burner: Address;
  try {
    owner = address(String(req.body?.owner ?? "").trim());
    burner = address(String(req.body?.burner ?? "").trim());
  } catch {
    return reply.code(400).send({ error: "owner and burner must be Solana addresses" });
  }
  if (owner === burner) return reply.code(400).send({ error: "the burner must be a separate key" });
  const now = Date.now();
  if ((mirrorSeen.get(burner) ?? 0) > now - 60_000) return reply.code(429).send({ error: "mirrored less than a minute ago" });
  const recent = (ipSeen.get(req.ip) ?? []).filter((x) => x > now - 3_600_000);
  if (recent.length >= 20) return reply.code(429).send({ error: "too many requests" });
  ipSeen.set(req.ip, [...recent, now]);
  mirrorSeen.set(burner, now);
  // every market's base and quote token, once each
  const mints = new Map<string, { symbol: string; mint: string; decimals: number }>();
  for (const [name, d] of Object.entries(dep.markets)) {
    const [b, q] = name.split("/");
    const [bd, qd] = feeds(name).decimals;
    mints.set(d.baseMint, { symbol: b!, mint: d.baseMint, decimals: bd });
    mints.set(d.quoteMint, { symbol: q!, mint: d.quoteMint, decimals: qd });
  }
  try {
    const bal = await readMainnetBalances(owner, [...mints.values()]);
    const balances = await mirrorOnto(rpc, await loadKey("keeper"), burner, bal);
    return { owner, burner, balances, note: "fork-only copy of public mainnet balances" };
  } catch (e) {
    return reply.code(502).send({ error: `could not read mainnet balances: ${(e as Error).message}` });
  }
});

app.post<{ Body: { address: string } }>("/faucet", async (req, reply) => {
  let who: Address;
  try {
    who = address(req.body.address);
  } catch {
    return reply.code(400).send({ error: "invalid address" });
  }
  const now = Date.now();
  if ((faucetSeen.get(who) ?? 0) > now - 10 * 60_000) return reply.code(429).send({ error: "this address was funded recently" });
  const ip = req.ip;
  const recent = (ipSeen.get(ip) ?? []).filter((t) => t > now - 3_600_000);
  if (recent.length >= 10) return reply.code(429).send({ error: "too many faucet requests" });
  ipSeen.set(ip, [...recent, now]);
  faucetSeen.set(who, now);
  await airdrop(rpc, who, 2);
  await setTokenBalance(who, USDC, 5_000_000_000n); // 5,000 fork USDC
  // wrapped SOL needs real lamports backing: fund a temporary payer and wrap into the user's ATA
  const payer = await loadKey("keeper");
  await airdrop(rpc, payer.address, 25);
  const wsolAta = await ata(who, WSOL);
  await sendInstructions(rpc, payer, [
    await getCreateAssociatedTokenIdempotentInstructionAsync({ payer, owner: who, mint: WSOL }),
    getTransferSolInstruction({ source: payer, destination: wsolAta, amount: 20_000_000_000n }),
    getSyncNativeInstruction({ account: wsolAta }),
  ]);
  // every other market's base token: about 1,500 USD worth at its scenario price
  const extra: Record<string, number> = {};
  for (const [name, d] of Object.entries(dep.markets)) {
    if (d.baseMint === WSOL) continue;
    const units = Math.ceil(1_500 / scenarios[name]!);
    await setTokenBalance(who, d.baseMint, BigInt(units) * 10n ** BigInt(feeds(name).decimals[0]));
    extra[name.split("/")[0]!] = units;
  }
  return { funded: who, sol: 2, wrappedSol: 20, usdc: 5_000, ...extra, note: "fork-only test funds" };
});

type Trader = Awaited<ReturnType<typeof fundWallet>> & { signer: Awaited<ReturnType<typeof loadKey>> };
const traders = new Map<string, Trader>();
/** A keeper-owned trader holding ~$50M of each side of a market, for scenario swaps. */
async function getTrader(name: string) {
  let t = traders.get(name);
  if (!t) {
    const d = dep.markets[name]!;
    const [bd, qd] = feeds(name).decimals;
    const signer = await loadKey("keeper");
    const base = BigInt(Math.ceil(50_000_000 / scenarios[name]!)) * 10n ** BigInt(bd);
    const acc = await fundWallet(rpc, signer, { sol: 10, baseMint: d.baseMint, base, usdc: 50_000_000n * 10n ** BigInt(qd), usdcMint: d.quoteMint });
    t = { ...acc, signer };
    traders.set(name, t);
  }
  return t;
}

app.post<{ Body: { price: number; market?: string } }>("/scenario", async (req, reply) => {
  if (!authorized(req.headers.authorization)) return reply.code(401).send({ error: "unauthorized" });
  const name = req.body.market ?? DEFAULT_MARKET;
  const d = dep.markets[name];
  if (!d) return reply.code(400).send({ error: `unknown market ${name}` });
  const price = Number(req.body.price);
  if (!(price > 0) || Math.abs(Math.log(price / scenarios[name]!)) > Math.log(1.5)) {
    return reply.code(400).send({ error: "price must be positive and within 50% of the current scenario" });
  }
  const t = await getTrader(name);
  const [bd, qd] = feeds(name).decimals;
  const target = await movePoolTo(rpc, t.signer, d.whirlpool, price, t.base, t.usdc, bd, qd);
  const swap = await movePoolTo(rpc, t.signer, d.swapPool, price, t.base, t.usdc, bd, qd);
  scenarios[name] = price;
  await publish();
  return { market: name, scenarioPrice: price, targetPool: target, restorationPool: swap };
});

app.post<{ Body: { seconds: number } }>("/time-travel", async (req, reply) => {
  if (!authorized(req.headers.authorization)) return reply.code(401).send({ error: "unauthorized" });
  const s = Math.floor(Number(req.body.seconds));
  if (!(s > 0 && s <= 30 * 86_400)) return reply.code(400).send({ error: "seconds must be in (0, 30 days]" });
  const now = await timeTravel(s);
  await publish();
  return { clock: now };
});

// ---- market onboarding: any token with two classic Orca Whirlpools and Pyth feeds ----
type Job = { id: string; mint: string; state: "queued" | "running" | "done" | "failed"; log: string[]; market?: string; error?: string };
const jobs = new Map<string, Job>();
const onboardSeen = new Map<string, number[]>();
let queue: Promise<void> = Promise.resolve();

async function runJob(job: Job) {
  job.state = "running";
  try {
    job.log.push("finding Orca pools and Pyth feeds");
    const spec = await discoverMarket(job.mint);
    job.log.push(`${spec.name}: target ${spec.whirlpool}, restoration ${spec.swapPool}`);
    if (dep.markets[spec.name]) {
      job.market = spec.name;
      job.log.push("already listed");
    } else {
      const admin = await loadKey("admin");
      const md = await setupMarket(spec, admin, undefined, (line) => job.log.push(line));
      const d = readDeployment(); // re-read: other tools may have written since startup
      d.markets[spec.name] = md;
      writeDeployment(d);
      dep.markets[spec.name] = md;
      scenarios[spec.name] = md.scenarioPrice;
      await publish();
      job.market = spec.name;
    }
    job.state = "done";
  } catch (e) {
    job.state = "failed";
    job.error = e instanceof OnboardError ? e.message : `setup failed: ${(e as Error).message}`;
  }
}

app.post<{ Body: { mint: string } }>("/markets", async (req, reply) => {
  let mint: string;
  try {
    mint = address(String(req.body?.mint ?? "").trim());
  } catch {
    return reply.code(400).send({ error: "not a token mint address" });
  }
  const existing = Object.entries(dep.markets).find(([, m]) => m.baseMint === mint);
  if (existing) return { id: null, state: "done", market: existing[0], log: ["already listed"] };
  const now = Date.now();
  const recent = (onboardSeen.get(req.ip) ?? []).filter((t) => t > now - 3_600_000);
  if (recent.length >= 5) return reply.code(429).send({ error: "too many new markets from this address; try again later" });
  onboardSeen.set(req.ip, [...recent, now]);
  const job: Job = { id: Math.random().toString(36).slice(2, 10), mint, state: "queued", log: [] };
  jobs.set(job.id, job);
  queue = queue.then(() => runJob(job));
  return job;
});

app.get<{ Params: { id: string } }>("/markets/jobs/:id", async (req, reply) => jobs.get(req.params.id) ?? reply.code(404).send({ error: "unknown job" }));

await publish();
setInterval(() => void publish().catch((e) => console.error("reference keeper:", e)), 20_000);
await app.listen({ port: PORT, host: process.env.HOST ?? "127.0.0.1" });
console.log(`demo control on :${PORT}`);
