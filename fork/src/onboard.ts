/**
 * Market onboarding for any Orca Whirlpool. The FORGE program and its math are pool-agnostic, so a
 * new market only needs: a target Whirlpool, a second Whirlpool of the same pair for restoration
 * swaps, and a Pyth feed for each token. `discoverMarket` finds all three from a token mint (Orca's
 * public pool API and Pyth's feed catalogue), checks them on chain, and `setupMarket` registers the
 * market on the fork exactly like the built-in ones. Used by the bootstrap script and the demo
 * control service.
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { type Address, address, type KeyPairSigner } from "@solana/kit";
import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";
import {
  createBucketIx,
  defaultParams,
  depositLiquidityIx,
  fetchBucket,
  fetchMarket,
  forgeIx,
  initializeMarketIx,
  pdas,
  readPool,
} from "@forge/txbuilder";
import { tickIndexToSqrtPrice } from "@orca-so/whirlpools-core";
import { createLookupTable, marketAddresses } from "./alt.js";
import { type Deployment, fundWallet, loadKey } from "./env.js";
import { humanFromSqrt, type MarketSpec, pythAccountFor } from "./markets.js";
import { setScenarioPrice } from "./pyth.js";
import { forkRpc, rawAccount, sendInstructions, USDC } from "./surfnet.js";

const rpc = forkRpc();
const BUCKETS_EACH_SIDE = Number(process.env.FORGE_BUCKETS_EACH_SIDE ?? 8);
const BUCKET_MULTIPLIER = 4; // brief default: 4 x tick spacing (ts64 -> 256 ticks, ~2.6%)
const LP_QUOTE_USD_PER_BUCKET = 50_000; // 50k USD of quote liquidity per bucket below price (fork funds)
const SPL_TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ORCA_API = process.env.ORCA_API_URL ?? "https://api.orca.so/v2/solana";
const HERMES = process.env.PYTH_HERMES_URL ?? "https://hermes.pyth.network";

const hex = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));

type OrcaToken = { address: string; programId: string; symbol: string; decimals: number };
type OrcaPool = { address: string; tickSpacing: number; tvlUsdc: string; adaptiveFeeEnabled?: boolean; tokenA: OrcaToken; tokenB: OrcaToken };

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}`);
  return (await r.json()) as T;
}

/** Pyth feed id for SYMBOL/USD (stablecoins included), or null if Pyth does not publish one. */
export async function pythFeedFor(symbol: string): Promise<string | null> {
  const sym = symbol.replace(/^\$/, "").toUpperCase(); // Orca lists some tickers with a leading $ (e.g. $WIF)
  const feeds = await getJson<{ id: string; attributes: { symbol?: string } }[]>(
    `${HERMES}/v2/price_feeds?query=${encodeURIComponent(sym)}&asset_type=crypto`,
  );
  const f = feeds.find((x) => x.attributes.symbol?.toUpperCase() === `CRYPTO.${sym}/USD`);
  return f ? f.id.replace(/^0x/, "") : null;
}

export class OnboardError extends Error {}

/**
 * From one token mint (paired with `quoteMint`, USDC by default) to a market spec. Picks the target
 * pool (tick spacing 64 when available, else the deepest) and the deepest other pool for
 * restoration swaps; both must be classic SPL tokens with the standard swap (no adaptive fee).
 */
export async function discoverMarket(mint: string, opts: { quoteMint?: string; benchUnits?: number } = {}): Promise<MarketSpec> {
  const quote = opts.quoteMint ?? USDC;
  if (mint === quote) throw new OnboardError("pick a token other than the quote token");
  const { data } = await getJson<{ data: OrcaPool[] }>(`${ORCA_API}/pools?tokensBothOf=${mint},${quote}&size=50`);
  const usable = data
    .filter((p) => p.tokenA.programId === SPL_TOKEN && p.tokenB.programId === SPL_TOKEN && !p.adaptiveFeeEnabled && Number(p.tvlUsdc) > 500)
    .sort((a, b) => Number(b.tvlUsdc) - Number(a.tvlUsdc));
  if (!data.length) throw new OnboardError("no Orca Whirlpool trades this token against the quote token");
  if (usable.length < 2) {
    throw new OnboardError("needs two classic-SPL Orca Whirlpools with over $500 TVL for this pair (one for the market, one for restoration swaps)");
  }
  const target = usable.find((p) => p.tickSpacing === 64) ?? usable[0]!;
  const swap = usable.find((p) => p.address !== target.address)!;
  const { tokenA, tokenB } = target;
  const [feedA, feedB] = await Promise.all([pythFeedFor(tokenA.symbol), pythFeedFor(tokenB.symbol)]);
  if (!feedA || !feedB) throw new OnboardError(`no Pyth USD feed for ${!feedA ? tokenA.symbol : tokenB.symbol}`);
  const [pythBase, pythQuote] = await Promise.all([pythAccountFor(feedA), pythAccountFor(feedB)]);
  for (const [sym, acc] of [[tokenA.symbol, pythBase], [tokenB.symbol, pythQuote]] as const) {
    if (!(await rawAccount(rpc, acc))) throw new OnboardError(`Pyth has a ${sym}/USD feed but no price account on Solana for it`);
  }
  const t = await readPool(rpc, address(target.address));
  const price = humanFromSqrt(t.sqrtPrice, { baseDecimals: tokenA.decimals, quoteDecimals: tokenB.decimals });
  return {
    name: `${tokenA.symbol.replace(/^\$/, "")}/${tokenB.symbol.replace(/^\$/, "")}`,
    whirlpool: address(target.address),
    swapPool: address(swap.address),
    baseMint: address(tokenA.address),
    quoteMint: address(tokenB.address),
    baseDecimals: tokenA.decimals,
    quoteDecimals: tokenB.decimals,
    pythBase,
    feedBase: feedA,
    pythQuote,
    feedQuote: feedB,
    benchUnits: opts.benchUnits ?? Math.max(1, Math.round(730 / Math.max(price, 1e-9))),
    benchSlippageBps: 150,
    // a pool shallower than SOL/USDC's gets a wider restoration slippage cap
    params: Number(swap.tvlUsdc) < 1_000_000 ? { swap_slippage_bps: 150 } : undefined,
  };
}

export type MarketDeployment = Deployment["markets"][string];

/** Register (or resume) a FORGE market for any Whirlpool: reference, market account, bucket ladder, LP seed, lookup table. */
export async function setupMarket(
  spec: MarketSpec,
  admin: KeyPairSigner,
  prior: MarketDeployment | undefined,
  log: (line: string) => void = console.log,
): Promise<MarketDeployment> {
  log(`\n== ${spec.name}: target ${spec.whirlpool}, restoration ${spec.swapPool}`);
  // Fork reference: start at the target pool's own price (quote at $1). Explicit scenario mode.
  const target = await readPool(rpc, spec.whirlpool);
  const swap = await readPool(rpc, spec.swapPool);
  const price = humanFromSqrt(target.sqrtPrice, spec);
  log(`target pool ${price.toPrecision(6)}, restoration pool ${humanFromSqrt(swap.sqrtPrice, spec).toPrecision(6)}`);

  const market = await pdas.market(spec.whirlpool);
  // Keep the original ladder and reference price across re-runs (e.g. program upgrades):
  // re-centering on a moved fork price would silently change every test's starting point.
  const keepPrior = prior?.market === market && prior.buckets.length > 0;
  const initialPrice = keepPrior ? prior!.scenarioPrice : price;
  await setScenarioPrice(spec.pythBase, spec.feedBase, price); // the pool's current price, as before
  await setScenarioPrice(spec.pythQuote, spec.feedQuote, 1.0);

  if (!(await rawAccount(rpc, market))) {
    const { ix } = await initializeMarketIx({
      admin,
      whirlpool: spec.whirlpool,
      swapPool: spec.swapPool,
      baseMint: spec.baseMint,
      quoteMint: spec.quoteMint,
      bucketMultiplier: BUCKET_MULTIPLIER,
      params: { ...defaultParams(), ...spec.params },
      reference: {
        kind: "PythPair",
        base_account: spec.pythBase,
        quote_account: spec.pythQuote,
        base_feed_id: hex(spec.feedBase),
        quote_feed_id: hex(spec.feedQuote),
      },
    });
    await sendInstructions(rpc, admin, [ix]);
    log(`market ${market}`);
  }
  let m = await fetchMarket(rpc, market);
  // per-market risk overrides (e.g. a wider restoration slippage cap for a thin pool)
  const wanted = { ...m.params, ...spec.params };
  if (JSON.stringify(wanted) !== JSON.stringify(m.params)) {
    await sendInstructions(rpc, admin, [forgeIx("update_market", { admin, market }, { params: wanted, opens_paused: null, borrow_paused: null })]);
    m = await fetchMarket(rpc, market);
    log(`market params updated: ${JSON.stringify(spec.params)}`);
  }
  const width = m.bucket_width;
  const center = keepPrior
    ? prior!.buckets[Math.floor(prior!.buckets.length / 2)]!.tickLower
    : Math.floor(target.tickCurrentIndex / width) * width;
  const lowers: number[] = [];
  for (let k = -BUCKETS_EACH_SIDE; k <= BUCKETS_EACH_SIDE; k++) lowers.push(center + k * width);

  const buckets: { tickLower: number; tickUpper: number; address: Address }[] = [];
  for (const tl of lowers) {
    const { bucket, ix } = await createBucketIx(admin, market, m, tl);
    if (!(await rawAccount(rpc, bucket))) {
      await sendInstructions(rpc, admin, [getSetComputeUnitLimitInstruction({ units: 400_000 }), ix]);
    }
    buckets.push({ tickLower: tl, tickUpper: tl + width, address: bucket });
  }
  log(`buckets: ${buckets.length} of width ${width} ticks around tick ${target.tickCurrentIndex}`);

  // Seed LP liquidity: the same L in every bucket, sized so a bucket just below price holds 50k USD of quote.
  const lp = await loadKey("lp").catch(async () => {
    execFileSync("solana-keygen", ["new", "--no-bip39-passphrase", "--silent", "-o", resolve(process.env.HOME!, ".config/solana/forge-lp.json")]);
    return loadKey("lp");
  });
  const lpAcc = await fundWallet(rpc, lp, {
    sol: 20,
    baseMint: spec.baseMint,
    base: BigInt(Math.ceil(2_000_000 / price)) * 10n ** BigInt(spec.baseDecimals), // ~$2M of base: covers every bucket above price
    usdc: 20_000_000n * 10n ** BigInt(spec.quoteDecimals),
    usdcMint: spec.quoteMint,
  });
  const span = tickIndexToSqrtPrice(center) - tickIndexToSqrtPrice(center - width);
  const L = ((BigInt(LP_QUOTE_USD_PER_BUCKET) * 10n ** BigInt(spec.quoteDecimals)) << 64n) / span;
  for (const b of buckets) {
    const bk = await fetchBucket(rpc, b.address);
    if (bk.total_liquidity > 0n) continue;
    const ix = await depositLiquidityIx({ rpc, lp, market, bucket: b.address, liquidity: L, lpBase: lpAcc.base, lpQuote: lpAcc.usdc });
    await sendInstructions(rpc, lp, [getSetComputeUnitLimitInstruction({ units: 400_000 }), ix]);
  }
  log(`seeded L=${L} per bucket from LP ${lp.address}`);

  // Market lookup table (section 8.5). Reused across runs while the fork keeps its state.
  let lookupTable: Address | undefined = prior?.lookupTable && (await rawAccount(rpc, prior.lookupTable)) ? prior.lookupTable : undefined;
  if (!lookupTable) {
    const bks = await Promise.all(buckets.map(async (b) => ({ address: b.address, b: await fetchBucket(rpc, b.address) })));
    const addrs = await marketAddresses(rpc, market, m, bks);
    lookupTable = await createLookupTable(rpc, admin, addrs);
    log(`lookup table ${lookupTable} with ${addrs.length} addresses`);
  }
  return {
    market,
    whirlpool: spec.whirlpool,
    swapPool: spec.swapPool,
    baseMint: spec.baseMint,
    quoteMint: spec.quoteMint,
    referenceKind: "PythPair",
    referenceBase: spec.pythBase,
    referenceQuote: spec.pythQuote,
    baseDecimals: spec.baseDecimals,
    quoteDecimals: spec.quoteDecimals,
    feedBase: spec.feedBase,
    feedQuote: spec.feedQuote,
    buckets,
    lookupTable,
    scenarioPrice: initialPrice,
  };
}

