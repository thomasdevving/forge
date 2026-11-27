/**
 * Fork test harness: sends prepared v0 transactions (lookup table, simulated compute, limit
 * checks) to the Surfpool fork and moves markets with real swaps plus an explicitly labelled
 * scenario reference. Requires `fork/start.sh` and `pnpm --filter @forge/fork bootstrap`.
 */
import {
  type Address,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  type Instruction,
  type KeyPairSigner,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { loadLookupTables, prepareTransaction, readPool, type Prepared } from "@forge/txbuilder";
import { ata, fundWallet, readDeployment } from "@forge/fork/env";
import { humanFromSqrt, marketSpec } from "@forge/fork/markets";
import { setScenarioPrice } from "@forge/fork/pyth";
import { movePoolTo } from "@forge/fork/price";
import { assertFork, forkClock, forkRpc, timeTravel, USDC, WSOL } from "@forge/fork/surfnet";

export const rpc = forkRpc();
export const deployment = readDeployment();
/** The market under test: FORGE_MARKET (default SOL/USDC). Every helper below follows it. */
export const spec = marketSpec();
export const sol = deployment.markets[spec.name]!;
if (!sol) throw new Error(`${spec.name} is not bootstrapped on this fork`);
const unit = (decimals: number) => 10n ** BigInt(decimals);
export let tables: Record<Address, Address[]> = {};

export async function setup() {
  await assertFork();
  tables = await loadLookupTables(rpc, [sol.lookupTable]);
}

export async function send(payer: KeyPairSigner, ixs: Instruction[]): Promise<{ sig: string; prepared: Prepared }> {
  const prepared = await prepareTransaction(rpc, payer, ixs, tables);
  const tx = await signTransactionMessageWithSigners(prepared.message);
  const sig = getSignatureFromTransaction(tx);
  await rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: "base64", skipPreflight: true }).send();
  for (let i = 0; i < 80; i++) {
    const { value } = await rpc.getSignatureStatuses([sig]).send();
    const st = value[0];
    if (st?.err) throw new Error(`${sig} failed: ${JSON.stringify(st.err, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return { sig, prepared };
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${sig} not confirmed`);
}

/** A funded user. `wsol` is the market's base token account (wrapped SOL on SOL/USDC). */
export async function newUser(opts: { wsol?: bigint; usdc?: bigint } = {}) {
  const user = await generateKeyPairSigner();
  const base = opts.wsol ?? BigInt(Math.ceil(spec.benchUnits * 20)) * unit(spec.baseDecimals);
  const acc = await fundWallet(rpc, user, { sol: 25, baseMint: spec.baseMint, base, usdc: opts.usdc ?? 200_000n * unit(spec.quoteDecimals), usdcMint: spec.quoteMint });
  return { user, wsol: acc.base, usdc: acc.usdc };
}

export async function tokenAmount(a: Address): Promise<bigint> {
  try {
    const { value } = await rpc.getTokenAccountBalance(a).send();
    return BigInt(value.amount);
  } catch {
    return 0n;
  }
}

export const humanPrice = async (pool: Address) => {
  const p = await readPool(rpc, pool);
  return humanFromSqrt(p.sqrtPrice, spec);
};

/** Labelled fork scenario: publish `price` as the base/USD reference (quote at $1), fresh. */
export async function publishReference(price: number, opts: { ageSeconds?: number; confBps?: number } = {}) {
  await setScenarioPrice(spec.pythBase, spec.feedBase, price, opts.confBps ?? 5, opts.ageSeconds ?? 0);
  await setScenarioPrice(spec.pythQuote, spec.feedQuote, 1.0, 5, opts.ageSeconds ?? 0);
}

let trader: Awaited<ReturnType<typeof newUser>> | undefined;
async function getTrader() {
  // ~$150M a side, enough to push either pool across the whole ladder
  const px = await humanPrice(sol.whirlpool);
  trader ??= await newUser({ wsol: BigInt(Math.ceil(150_000_000 / px)) * unit(spec.baseDecimals), usdc: 150_000_000n * unit(spec.quoteDecimals) });
  return trader;
}

/** Move both the target and restoration pools with real swaps, then publish the reference. */
export async function moveMarket(target: number, opts: { swapPool?: number; reference?: number } = {}) {
  const t = await getTrader();
  const got = await movePoolTo(rpc, t.user, sol.whirlpool, target, t.wsol, t.usdc, spec.baseDecimals, spec.quoteDecimals);
  const gotSwap = await movePoolTo(rpc, t.user, sol.swapPool, opts.swapPool ?? target, t.wsol, t.usdc, spec.baseDecimals, spec.quoteDecimals);
  await publishReference(opts.reference ?? got);
  return { target: got, swap: gotSwap };
}

export async function forkTime(): Promise<number> {
  return (await forkClock()).unixTimestamp;
}

/** Advance the fork clock and republish the reference at the current pool price. */
export async function advance(seconds: number) {
  await timeTravel(seconds);
  await publishReference(await humanPrice(sol.whirlpool));
}

export { ata, USDC, WSOL };

import { buildOpen, fetchBucket, fetchMarket, humanPriceToX64 } from "@forge/txbuilder";

/** Open a long put on the given buckets with `fraction` of each bucket's liquidity. */
export async function openPut(
  u: { user: KeyPairSigner; wsol: Address; usdc: Address },
  bucketLowers: number[],
  nonce: bigint,
  opts: { fraction?: bigint; liquidity?: bigint; budget?: bigint; slippageBps?: number; extraBuffer?: bigint } = {},
) {
  const m = await fetchMarket(rpc, sol.market);
  const price = await humanPrice(sol.whirlpool);
  await publishReference(price);
  const legs = [];
  for (const tl of bucketLowers) {
    const b = sol.buckets.find((x) => x.tickLower === tl)!;
    const bk = await fetchBucket(rpc, b.address);
    legs.push({ kind: "BorrowQuote" as const, tickLower: tl, liquidity: opts.liquidity ?? bk.total_liquidity / (opts.fraction ?? 4n), extraBuffer: opts.extraBuffer ?? 0n });
  }
  const { strategy, transactions } = await buildOpen(rpc, {
    owner: u.user,
    market: sol.market,
    nonce,
    legs,
    premiumBudget: opts.budget ?? 500_000_000n,
    expiry: 0n,
    openReferenceX64: humanPriceToX64(price, spec.baseDecimals, spec.quoteDecimals),
    openToleranceBps: m.params.open_tolerance_bps,
    swapSlippageBps: opts.slippageBps ?? m.params.swap_slippage_bps,
    certificateHash: new Uint8Array(32),
    userBase: u.wsol,
    userQuote: u.usdc,
  });
  for (const tx of transactions) await send(u.user, tx);
  return strategy;
}

/** Bucket lower ticks relative to the bootstrap center bucket (index 8). */
export const bucketBelow = (k: number) => sol.buckets[8]!.tickLower - 256 * k;
