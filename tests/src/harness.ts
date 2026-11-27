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
import { FEED_SOL_USD, FEED_USDC_USD, PYTH_SOL_USD, PYTH_USDC_USD, setScenarioPrice } from "@forge/fork/pyth";
import { movePoolTo } from "@forge/fork/price";
import { assertFork, forkClock, forkRpc, timeTravel, USDC, WSOL } from "@forge/fork/surfnet";

export const rpc = forkRpc();
export const deployment = readDeployment();
export const sol = deployment.markets["SOL/USDC"]!;
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

export async function newUser(opts: { wsol?: bigint; usdc?: bigint } = {}) {
  const user = await generateKeyPairSigner();
  const acc = await fundWallet(rpc, user, { sol: 25, wsol: opts.wsol ?? 200_000_000_000n, usdc: opts.usdc ?? 200_000_000_000n, usdcMint: USDC });
  return { user, wsol: acc.wsol, usdc: acc.usdc };
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
  return (Number(p.sqrtPrice) / 2 ** 64) ** 2 * 1e3;
};

/** Labelled fork scenario: publish `price` as the SOL/USD reference (USDC at $1), fresh. */
export async function publishReference(price: number, opts: { ageSeconds?: number; confBps?: number } = {}) {
  await setScenarioPrice(PYTH_SOL_USD, FEED_SOL_USD, price, opts.confBps ?? 5, opts.ageSeconds ?? 0);
  await setScenarioPrice(PYTH_USDC_USD, FEED_USDC_USD, 1.0, 5, opts.ageSeconds ?? 0);
}

let trader: Awaited<ReturnType<typeof newUser>> | undefined;
async function getTrader() {
  trader ??= await newUser({ wsol: 2_000_000_000_000_000n, usdc: 200_000_000_000_000n });
  return trader;
}

/** Move both the target and restoration pools with real swaps, then publish the reference. */
export async function moveMarket(target: number, opts: { swapPool?: number; reference?: number } = {}) {
  const t = await getTrader();
  const got = await movePoolTo(rpc, t.user, sol.whirlpool, target, t.wsol, t.usdc);
  const gotSwap = await movePoolTo(rpc, t.user, sol.swapPool, opts.swapPool ?? target, t.wsol, t.usdc);
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
    openReferenceX64: humanPriceToX64(price, 9, 6),
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
