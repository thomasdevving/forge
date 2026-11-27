/**
 * Market registry. FORGE itself is pool-agnostic: a market is any Orca Whirlpool (the target),
 * a second Whirlpool of the same pair for restoration swaps, and a Pyth feed for the base token
 * (quote priced by its own feed). Mints and decimals are read from chain; the Pyth price account
 * is derived from the feed id. The two entries below are the markets this fork demo ships with;
 * `specFromChain` turns any other Whirlpool into a spec the same way.
 */
import { type Address, address, getProgramDerivedAddress, type Rpc, type SolanaRpcApi } from "@solana/kit";
import { readPool } from "@forge/txbuilder";
import { FEED_SOL_USD, FEED_USDC_USD, PYTH_SOL_USD, PYTH_USDC_USD } from "./pyth.js";
import { USDC, WSOL } from "./surfnet.js";

export type MarketSpec = {
  name: string;
  whirlpool: Address;
  swapPool: Address;
  baseMint: Address;
  quoteMint: Address;
  baseDecimals: number;
  quoteDecimals: number;
  pythBase: Address;
  feedBase: string;
  pythQuote: Address;
  feedQuote: string;
  /** Base units for benchmark payoffs, sized to roughly the same USD notional in every market. */
  benchUnits: number;
  /** Restoration swap slippage cap for benchmark positions; thin pools need a wider cap. */
  benchSlippageBps: number;
  /** Per-market risk overrides on top of the default market parameters (set by the admin). */
  params?: { swap_slippage_bps?: number };
};

const PYTH_PUSH_ORACLE = address("pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT");
export const JUP = address("JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN");
export const FEED_JUP_USD = "0a0408d619e9380abad35060f9192039ed5042fa6f82301d0e48bb52be830996";

/** Pyth sponsored price-feed account (shard 0) for a feed id. */
export async function pythAccountFor(feedId: string): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: PYTH_PUSH_ORACLE,
    seeds: [new Uint8Array([0, 0]), Uint8Array.from(Buffer.from(feedId, "hex"))],
  });
  return pda;
}

export const MARKETS: Record<string, MarketSpec> = {
  "SOL/USDC": {
    name: "SOL/USDC",
    whirlpool: address("HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ"), // Orca ts64
    swapPool: address("Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE"), // Orca ts4
    baseMint: WSOL,
    quoteMint: USDC,
    baseDecimals: 9,
    quoteDecimals: 6,
    pythBase: PYTH_SOL_USD,
    feedBase: FEED_SOL_USD,
    pythQuote: PYTH_USDC_USD,
    feedQuote: FEED_USDC_USD,
    benchUnits: 10,
    benchSlippageBps: 50,
  },
  "JUP/USDC": {
    name: "JUP/USDC",
    whirlpool: address("HrLmpzp8Nu5wkn9SGZYSS9Ms6deTvMgGc6BETp4161ZX"), // Orca ts64
    swapPool: address("4Ui9QdDNuUaAGqCPcDSp191QrixLzQiLxJ1Gnqvz3szP"), // Orca ts4, the deepest JUP/USDC pool
    baseMint: JUP,
    quoteMint: USDC,
    baseDecimals: 6,
    quoteDecimals: 6,
    pythBase: address("7dbob1psH1iZBS7qPsm3Kwbf5DzSXK8Jyg31CTgTnxH5"), // = pythAccountFor(FEED_JUP_USD)
    feedBase: FEED_JUP_USD,
    pythQuote: PYTH_USDC_USD,
    feedQuote: FEED_USDC_USD,
    benchUnits: 3000,
    benchSlippageBps: 150, // the JUP/USDC restoration pool holds ~$54k
    params: { swap_slippage_bps: 150 },
  },
};

/** The market selected by FORGE_MARKET (default SOL/USDC). */
export function marketSpec(name = process.env.FORGE_MARKET ?? "SOL/USDC"): MarketSpec {
  const m = MARKETS[name];
  if (!m) throw new Error(`unknown market ${name}; known: ${Object.keys(MARKETS).join(", ")}`);
  return m;
}

async function mintDecimals(rpc: Rpc<SolanaRpcApi>, mint: Address): Promise<number> {
  const { value } = await rpc.getAccountInfo(mint, { encoding: "base64" }).send();
  if (!value) throw new Error(`mint ${mint} not found`);
  return Buffer.from(value.data[0], "base64")[44]!; // SPL Mint layout: decimals at offset 44
}

/** Any Whirlpool -> a market spec: mints and decimals from chain, Pyth account from the feed id. */
export async function specFromChain(
  rpc: Rpc<SolanaRpcApi>,
  opts: { whirlpool: Address; swapPool: Address; feedBase: string; feedQuote?: string; name?: string; benchUnits?: number },
): Promise<MarketSpec> {
  const [t, s] = await Promise.all([readPool(rpc, opts.whirlpool), readPool(rpc, opts.swapPool)]);
  if (t.mintA !== s.mintA || t.mintB !== s.mintB) throw new Error("target and swap pool must trade the same pair");
  const feedQuote = opts.feedQuote ?? FEED_USDC_USD;
  const [baseDecimals, quoteDecimals, pythBase, pythQuote] = await Promise.all([
    mintDecimals(rpc, t.mintA),
    mintDecimals(rpc, t.mintB),
    pythAccountFor(opts.feedBase),
    pythAccountFor(feedQuote),
  ]);
  return {
    name: opts.name ?? `${t.mintA.slice(0, 4)}/${t.mintB.slice(0, 4)}`,
    whirlpool: opts.whirlpool,
    swapPool: opts.swapPool,
    baseMint: t.mintA,
    quoteMint: t.mintB,
    baseDecimals,
    quoteDecimals,
    pythBase,
    feedBase: opts.feedBase,
    pythQuote,
    feedQuote,
    benchUnits: opts.benchUnits ?? 1,
    benchSlippageBps: 150,
  };
}

/** Human price (quote per base) from a Whirlpool sqrt price. */
export const humanFromSqrt = (sqrtPriceX64: bigint, m: Pick<MarketSpec, "baseDecimals" | "quoteDecimals">) =>
  (Number(sqrtPriceX64) / 2 ** 64) ** 2 * 10 ** (m.baseDecimals - m.quoteDecimals);
