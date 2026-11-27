/**
 * FORGE indexer: reads Whirlpool state, tick arrays, fee growth and FORGE accounts from the
 * fork RPC and serves them to the app and the agent. Read-only; holds no keys.
 *
 *   GET /health                        RPC, program, market and seeded-vault checks
 *   GET /markets                       markets with pool price, reference, parameters
 *   GET /markets/:market/buckets       per-bucket liquidity, utilization, borrowable, premiums
 *   GET /markets/:market/stats         live out-of-range liquidity in the target pool
 *   GET /strategies?owner=             strategies with legs and live premium estimates
 *   GET /strategies/:address           one strategy
 *   GET /lp?owner=                     LP positions with owed premium and fees
 */
import Fastify from "fastify";
import cors from "@fastify/cors";
import { type Address, address, createDefaultRpcTransport, createSolanaRpcFromTransport, getBase58Decoder } from "@solana/kit";
import {
  base64ToBytes,
  type Bucket,
  decodeAccount,
  estimateLegPremium,
  fetchMarket,
  fetchRaw,
  FORGE_PROGRAM_ID,
  IDL,
  type LpPosition,
  type Market,
  outOfRangeLiquidity,
  readPool,
  type Strategy,
  x64ToHumanPrice,
} from "@forge/txbuilder";

const RPC_URL = process.env.FORGE_RPC_URL ?? "http://127.0.0.1:8899";
const PORT = Number(process.env.PORT ?? 8787);
const ORIGINS = (process.env.FORGE_ALLOWED_ORIGINS ?? "http://localhost:3000").split(",");
// Every RPC call gives up after 15 s: a request the fork never answers must not hang the indexer.
const baseTransport = createDefaultRpcTransport({ url: RPC_URL });
const rpc = createSolanaRpcFromTransport(((config: Parameters<typeof baseTransport>[0]) =>
  baseTransport({ ...config, signal: config.signal ?? AbortSignal.timeout(15_000) })) as typeof baseTransport);

const KNOWN: Record<string, string> = {
  So11111111111111111111111111111111111111112: "SOL",
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
};
const symbol = (m: string) => KNOWN[m] ?? `${m.slice(0, 4)}…`;
const Q64 = 2 ** 64;

const cache = new Map<string, { at: number; v: unknown }>();
const inflight = new Map<string, Promise<unknown>>();
/** Short-lived cache; concurrent requests for the same key share one RPC round trip. */
async function cached<T>(key: string, ttlMs: number, f: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.v as T;
  const running = inflight.get(key);
  if (running) return running as Promise<T>;
  const p = f()
    .then((v) => {
      cache.set(key, { at: Date.now(), v });
      return v;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

const discOf = (name: string) => getBase58Decoder().decode(Uint8Array.from(IDL.accounts.find((a) => a.name === name)!.discriminator));

async function programAccounts<T>(name: string, memcmp?: { offset: number; bytes: string }): Promise<{ address: Address; data: T }[]> {
  const filters: unknown[] = [{ memcmp: { offset: 0n, bytes: discOf(name), encoding: "base58" } }];
  if (memcmp) filters.push({ memcmp: { offset: BigInt(memcmp.offset), bytes: memcmp.bytes, encoding: "base58" } });
  const res = (await rpc.getProgramAccounts(FORGE_PROGRAM_ID, { encoding: "base64", filters: filters as never }).send()) as unknown as {
    pubkey: Address;
    account: { data: [string, string] };
  }[];
  return res.map((r) => ({ address: r.pubkey, data: decodeAccount<T>(name, base64ToBytes(r.account.data[0])) }));
}

async function clock(): Promise<number> {
  const raw = await fetchRaw(rpc, address("SysvarC1ock11111111111111111111111111111111"));
  const v = new DataView(raw!.buffer, raw!.byteOffset);
  return Number(v.getBigInt64(32, true));
}

/** Decode the market's reference (Pyth pair or fork scenario) for display. */
async function reference(m: Market, now: number) {
  if (m.reference.kind === "ForkScenario") {
    const raw = await fetchRaw(rpc, m.reference.base_account);
    const s = raw ? decodeAccount<{ price_x64: bigint; conf_bps: number; publish_time: bigint }>("ScenarioReference", raw) : null;
    return s
      ? { kind: "ForkScenario", label: "Fork-only scenario reference (trusted demo signer)", price: x64ToHumanPrice(s.price_x64, m.base_decimals, m.quote_decimals), confBps: s.conf_bps, ageSeconds: now - Number(s.publish_time) }
      : null;
  }
  const read = async (a: Address) => {
    const d = await fetchRaw(rpc, a);
    if (!d) return null;
    const v = new DataView(d.buffer, d.byteOffset);
    let o = 40;
    o += d[o] === 0 ? 2 : 1;
    o += 32;
    const price = Number(v.getBigInt64(o, true));
    const conf = Number(v.getBigUint64(o + 8, true));
    const expo = v.getInt32(o + 16, true);
    const pt = Number(v.getBigInt64(o + 20, true));
    return { price: price * 10 ** expo, conf: conf * 10 ** expo, publishTime: pt };
  };
  const b = await read(m.reference.base_account);
  const q = await read(m.reference.quote_account);
  if (!b || !q) return null;
  return {
    kind: "PythPair",
    label: "Pyth base/USD ÷ quote/USD (on the fork, scenario-written for demos)",
    price: b.price / q.price,
    confBps: Math.round((b.conf / b.price + q.conf / q.price) * 1e4 * 100) / 100,
    ageSeconds: now - Math.min(b.publishTime, q.publishTime),
  };
}

function serialize(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x instanceof Uint8Array ? Buffer.from(x).toString("hex") : x)));
}

async function marketSummary(addr: Address, m: Market) {
  const now = await clock();
  const pool = await readPool(rpc, m.whirlpool);
  const sqrt = Number(pool.sqrtPrice) / Q64;
  const poolPrice = m.base_is_a ? sqrt * sqrt * 10 ** (m.base_decimals - m.quote_decimals) : (1 / (sqrt * sqrt)) * 10 ** (m.base_decimals - m.quote_decimals);
  return {
    address: addr,
    name: `${symbol(m.base_mint)}/${symbol(m.quote_mint)}`,
    whirlpool: m.whirlpool,
    swapPool: m.swap_pool,
    baseMint: m.base_mint,
    quoteMint: m.quote_mint,
    baseDecimals: m.base_decimals,
    quoteDecimals: m.quote_decimals,
    tickSpacing: m.tick_spacing,
    bucketWidth: m.bucket_width,
    poolPrice,
    tickCurrentIndex: pool.tickCurrentIndex,
    reference: await reference(m, now),
    params: m.params,
    opensPaused: m.opens_paused,
    borrowPaused: m.borrow_paused,
    unresolvedStrategies: m.unresolved_strategies,
    outstandingLpShortfall: m.outstanding_lp_shortfall,
    premiumVault: m.premium_vault,
    now,
  };
}

/** Measured forgone fees per bucket: sum of every borrowed leg's cumulative forgone quote. */
async function forgoneByBucket(market: Address): Promise<Map<string, bigint>> {
  const strategies = await programAccounts<Strategy>("Strategy");
  const out = new Map<string, bigint>();
  for (const { data: s } of strategies) {
    if (s.market !== market) continue;
    for (const l of s.legs.slice(0, s.leg_count)) {
      if (l.kind_tag > 1 || !l.executed) continue;
      out.set(l.bucket, (out.get(l.bucket) ?? 0n) + l.cum_forgone_quote);
    }
  }
  return out;
}

async function buckets(market: Address) {
  const m = await fetchMarket(rpc, market);
  const pool = await readPool(rpc, m.whirlpool);
  const list = await programAccounts<Bucket>("Bucket", { offset: 8, bytes: market });
  const forgone = await forgoneByBucket(market);
  const scale = 10 ** (m.base_decimals - m.quote_decimals);
  return list
    .map(({ address: a, data: b }) => {
      const total = b.total_liquidity;
      const cap = (total * BigInt(m.params.curve.cap_ppm)) / 1_000_000n;
      const committed = b.borrowed + b.reserved;
      const borrowable = cap > committed + b.withdrawal_requested ? cap - committed - b.withdrawal_requested : 0n;
      return {
        address: a,
        tickLower: b.tick_lower,
        tickUpper: b.tick_upper,
        priceLower: 1.0001 ** b.tick_lower * scale,
        priceUpper: 1.0001 ** b.tick_upper * scale,
        side: b.tick_upper <= pool.tickCurrentIndex ? "below" : b.tick_lower > pool.tickCurrentIndex ? "above" : "spot",
        totalLiquidity: total,
        borrowed: b.borrowed,
        reserved: b.reserved,
        withdrawalRequested: b.withdrawal_requested,
        withdrawalNoticeStart: b.withdrawal_notice_start,
        utilization: total > 0n ? Number((committed * 1_000_000n) / total) / 1e6 : 0,
        borrowable,
        premiumDistributed: b.premium_distributed,
        feesCollectedBase: b.fees_collected_base,
        feesCollectedQuote: b.fees_collected_quote,
        lpShortfall: b.lp_shortfall_quote,
        forgoneMeasured: forgone.get(a) ?? 0n,
        premiumIndexX64: b.premium_index_x64,
        feeIndexBaseX64: b.fee_index_base_x64,
        feeIndexQuoteX64: b.fee_index_quote_x64,
        openLegs: b.open_legs,
        position: b.position,
      };
    })
    .sort((a, b) => a.tickLower - b.tickLower);
}

async function strategyView(addr: Address, s: Strategy) {
  const m = await fetchMarket(rpc, s.market);
  const pool = await readPool(rpc, m.whirlpool);
  const now = await clock();
  const sqrt = Number(pool.sqrtPrice) / Q64;
  const refX64 = BigInt(Math.floor(sqrt * sqrt * Q64)); // pool price as the estimate's conversion
  const legs = await Promise.all(
    s.legs.slice(0, s.leg_count).map(async (l) => ({ ...l, estimate: await estimateLegPremium(rpc, m, pool, s, l, refX64, now) })),
  );
  const accruedEstimate = legs.reduce((a, l) => a + l.estimate.premium, 0n);
  return { address: addr, ...s, legs, accruedEstimate, lpCap: s.premium_budget - s.bounty_reserve, now };
}

const app = Fastify({ logger: false });
await app.register(cors, { origin: ORIGINS });

app.get("/health", async () => {
  const checks: Record<string, boolean | string> = {};
  try {
    const v = (await rpc.getVersion().send()) as Record<string, unknown>;
    checks.rpc = true;
    checks.cluster = "surfnet-version" in v ? `surfpool ${v["surfnet-version"]}` : "non-fork";
  } catch {
    checks.rpc = false;
  }
  checks.program = Boolean(await fetchRaw(rpc, FORGE_PROGRAM_ID).catch(() => null));
  const markets = await programAccounts<Market>("Market").catch(() => []);
  checks.market = markets.length > 0;
  if (markets.length) {
    const bs = await buckets(markets[0]!.address).catch(() => []);
    checks.seededVault = bs.some((b) => b.totalLiquidity > 0n);
  }
  return { ok: Object.values(checks).every((v) => v !== false), checks };
});

app.get("/markets", async () =>
  cached("markets", 2_000, async () => {
    const list = await programAccounts<Market>("Market");
    return serialize(await Promise.all(list.map(({ address: a, data }) => marketSummary(a, data))));
  }),
);

app.get<{ Params: { market: string } }>("/markets/:market/buckets", async (req) =>
  cached(`buckets:${req.params.market}`, 2_000, async () => serialize(await buckets(address(req.params.market)))),
);

app.get<{ Params: { market: string } }>("/markets/:market/stats", async (req) =>
  cached(`stats:${req.params.market}`, 10_000, async () => {
    const m = await fetchMarket(rpc, address(req.params.market));
    const pool = await readPool(rpc, m.whirlpool);
    const sqrt = Number(pool.sqrtPrice) / Q64;
    const price = sqrt * sqrt * 10 ** (m.base_decimals - m.quote_decimals);
    return serialize({ pool: m.whirlpool, price, outOfRange: await outOfRangeLiquidity(rpc, pool, price, 6, m.base_decimals, m.quote_decimals) });
  }),
);

app.get<{ Querystring: { owner?: string } }>("/strategies", async (req) => {
  if (!req.query.owner) return [];
  const list = await programAccounts<Strategy>("Strategy", { offset: 8, bytes: address(req.query.owner) });
  const views = await Promise.all(list.map(({ address: a, data }) => strategyView(a, data)));
  return serialize(views.sort((a, b) => Number(b.created_at - a.created_at)));
});

app.get<{ Params: { address: string } }>("/strategies/:address", async (req) => {
  const raw = await fetchRaw(rpc, address(req.params.address));
  if (!raw) return { error: "not found" };
  return serialize(await strategyView(address(req.params.address), decodeAccount<Strategy>("Strategy", raw)));
});

app.get<{ Querystring: { owner?: string } }>("/lp", async (req) => {
  if (!req.query.owner) return [];
  const list = await programAccounts<LpPosition>("LpPosition", { offset: 8, bytes: address(req.query.owner) });
  const Q = 1n << 64n;
  const out = await Promise.all(
    list.map(async ({ address: a, data: lp }) => {
      const raw = await fetchRaw(rpc, lp.bucket);
      const b = raw ? decodeAccount<Bucket>("Bucket", raw) : null;
      const owed = (idx: bigint, then: bigint) => (lp.liquidity * (((idx - then) % (1n << 128n)) + (1n << 128n)) % (1n << 128n)) / Q;
      return {
        address: a,
        ...lp,
        market: b?.market,
        tickLower: b?.tick_lower,
        tickUpper: b?.tick_upper,
        shareOfBucket: b && b.total_liquidity > 0n ? Number((lp.liquidity * 1_000_000n) / b.total_liquidity) / 1e6 : 0,
        premiumOwedNow: b ? lp.premium_owed + owed(b.premium_index_x64, lp.premium_index_x64) : lp.premium_owed,
        feesOwedBaseNow: b ? lp.fee_owed_base + owed(b.fee_index_base_x64, lp.fee_index_base_x64) : lp.fee_owed_base,
        feesOwedQuoteNow: b ? lp.fee_owed_quote + owed(b.fee_index_quote_x64, lp.fee_index_quote_x64) : lp.fee_owed_quote,
      };
    }),
  );
  return serialize(out);
});

await app.listen({ port: PORT, host: process.env.HOST ?? "127.0.0.1" });
console.log(`indexer on :${PORT} (rpc ${RPC_URL})`);
