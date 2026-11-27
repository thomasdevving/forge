/**
 * Move an Orca pool's price on the fork with real swaps (no account edits): one exact-input
 * swap of a large amount bounded by a sqrt-price limit stops exactly at the target price.
 */
import type { Address, KeyPairSigner, Rpc, SolanaRpcApi } from "@solana/kit";
import { getSwapInstruction } from "@orca-so/whirlpools-client";
import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";
import { pdas, readPool, swapTickArrays } from "@forge/txbuilder";
import { sendInstructions } from "./surfnet.js";

const U64_MAX = (1n << 64n) - 1n;

export function sqrtPriceForHumanPrice(price: number, decimalsA: number, decimalsB: number): bigint {
  // orca price = B atoms per A atom = human * 10^(dB - dA)
  const atoms = price * 10 ** (decimalsB - decimalsA);
  const sqrt = Math.sqrt(atoms);
  // split to keep precision: sqrt * 2^64
  const hi = Math.floor(sqrt);
  const lo = sqrt - hi;
  return BigInt(hi) * (1n << 64n) + BigInt(Math.floor(lo * 2 ** 53)) * (1n << 11n);
}

/**
 * Swap on `pool` until its price reaches `targetPrice` (token B per token A, human units),
 * crossing at most three tick arrays per transaction; repeats until reached.
 */
export async function movePoolTo(
  rpc: Rpc<SolanaRpcApi>,
  trader: KeyPairSigner,
  poolAddr: Address,
  targetPrice: number,
  traderA: Address,
  traderB: Address,
  decimalsA = 9,
  decimalsB = 6,
): Promise<number> {
  const target = sqrtPriceForHumanPrice(targetPrice, decimalsA, decimalsB);
  for (let i = 0; i < 40; i++) {
    const pool = await readPool(rpc, poolAddr);
    if (pool.sqrtPrice === target) break;
    const aToB = target < pool.sqrtPrice; // selling A lowers the price
    const [t0, t1, t2] = await swapTickArrays(pool, aToB);
    const ix = getSwapInstruction({
      tokenAuthority: trader,
      whirlpool: poolAddr,
      tokenOwnerAccountA: traderA,
      tokenVaultA: pool.vaultA,
      tokenOwnerAccountB: traderB,
      tokenVaultB: pool.vaultB,
      tickArray0: t0,
      tickArray1: t1,
      tickArray2: t2,
      oracle: await pdas.oracle(poolAddr),
      amount: U64_MAX / 4n,
      otherAmountThreshold: 0n,
      sqrtPriceLimit: target,
      amountSpecifiedIsInput: true,
      aToB,
    });
    await sendInstructions(rpc, trader, [getSetComputeUnitLimitInstruction({ units: 1_400_000 }), ix]);
    const after = await readPool(rpc, poolAddr);
    if (after.sqrtPrice === target || after.sqrtPrice === pool.sqrtPrice) break;
  }
  const p = await readPool(rpc, poolAddr);
  return (Number(p.sqrtPrice) / 2 ** 64) ** 2 * 10 ** (decimalsA - decimalsB);
}
