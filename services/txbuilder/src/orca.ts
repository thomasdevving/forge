import type { Address, Rpc, SolanaRpcApi } from "@solana/kit";
import { fetchWhirlpool } from "@orca-so/whirlpools-client";
import { tickIndexToSqrtPrice, tryGetAmountDeltaA, tryGetAmountDeltaB } from "@orca-so/whirlpools-core";
import { pdas } from "./program.js";

export const TICK_ARRAY_SIZE = 88;
export const Q64 = 1n << 64n;

export type PoolState = {
  address: Address;
  tickSpacing: number;
  sqrtPrice: bigint;
  tickCurrentIndex: number;
  mintA: Address;
  mintB: Address;
  vaultA: Address;
  vaultB: Address;
  feeGrowthGlobalA: bigint;
  feeGrowthGlobalB: bigint;
  liquidity: bigint;
};

export async function readPool(rpc: Rpc<SolanaRpcApi>, address: Address): Promise<PoolState> {
  const w = await fetchWhirlpool(rpc, address);
  return {
    address,
    tickSpacing: w.data.tickSpacing,
    sqrtPrice: w.data.sqrtPrice,
    tickCurrentIndex: w.data.tickCurrentIndex,
    mintA: w.data.tokenMintA,
    mintB: w.data.tokenMintB,
    vaultA: w.data.tokenVaultA,
    vaultB: w.data.tokenVaultB,
    feeGrowthGlobalA: w.data.feeGrowthGlobalA,
    feeGrowthGlobalB: w.data.feeGrowthGlobalB,
    liquidity: w.data.liquidity,
  };
}

export const tickArrayStart = (tick: number, spacing: number) => {
  const span = spacing * TICK_ARRAY_SIZE;
  return Math.floor(tick / span) * span;
};

export async function bucketTickArrays(pool: Address, tickLower: number, tickUpper: number, spacing: number) {
  return {
    lower: await pdas.tickArray(pool, tickArrayStart(tickLower, spacing)),
    upper: await pdas.tickArray(pool, tickArrayStart(tickUpper, spacing)),
  };
}

/** Three tick arrays in the swap direction (a_to_b moves the tick down). */
export async function swapTickArrays(pool: PoolState, aToB: boolean): Promise<[Address, Address, Address]> {
  const span = pool.tickSpacing * TICK_ARRAY_SIZE;
  const start = tickArrayStart(pool.tickCurrentIndex, pool.tickSpacing);
  const step = aToB ? -span : span;
  return [
    await pdas.tickArray(pool.address, start),
    await pdas.tickArray(pool.address, start + step),
    await pdas.tickArray(pool.address, start + 2 * step),
  ];
}

/** Exact Orca token deltas for a liquidity change (same rounding as the program). */
export function liquidityDeltas(pool: PoolState, tickLower: number, tickUpper: number, liquidity: bigint, roundUp: boolean) {
  const lo = tickIndexToSqrtPrice(tickLower);
  const hi = tickIndexToSqrtPrice(tickUpper);
  if (pool.tickCurrentIndex < tickLower) return { a: tryGetAmountDeltaA(lo, hi, liquidity, roundUp), b: 0n };
  if (pool.tickCurrentIndex < tickUpper)
    return {
      a: tryGetAmountDeltaA(pool.sqrtPrice, hi, liquidity, roundUp),
      b: tryGetAmountDeltaB(lo, pool.sqrtPrice, liquidity, roundUp),
    };
  return { a: 0n, b: tryGetAmountDeltaB(lo, hi, liquidity, roundUp) };
}

/** Quote atoms per base atom (Q64.64) from a pool sqrt price. */
export function poolQuotePerBaseX64(sqrtPrice: bigint, baseIsA: boolean): bigint {
  const p = (sqrtPrice * sqrtPrice) >> 64n;
  return baseIsA ? p : (Q64 * Q64) / p;
}

/** Human price (quote per base) to Q64.64 quote atoms per base atom. */
export function humanPriceToX64(price: number, baseDecimals: number, quoteDecimals: number): bigint {
  const scaled = BigInt(Math.round(price * 1e12));
  const shift = quoteDecimals - baseDecimals;
  let num = scaled * Q64;
  let den = 10n ** 12n;
  if (shift >= 0) num *= 10n ** BigInt(shift);
  else den *= 10n ** BigInt(-shift);
  return num / den;
}

export function x64ToHumanPrice(x64: bigint, baseDecimals: number, quoteDecimals: number): number {
  return (Number(x64) / 2 ** 64) * 10 ** (baseDecimals - quoteDecimals);
}
