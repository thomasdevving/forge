/**
 * Observe Orca's real on-chain behavior on the Surfpool mainnet fork, so the math ports can be
 * checked against the deployed program (not just the SDK):
 *
 *  1. exact token deltas of V1 increase_liquidity / decrease_liquidity in all three regimes
 *     (position below, around and above the current price), and
 *  2. fee growth inside after real swaps through a position, read back from the position's
 *     checkpoint after a liquidity change.
 *
 * Writes math/tests/fixtures/orca_fork_observations.json with raw account bytes (base64) and
 * observed balance changes. Requires a running fork (fork/start.sh). Never touches mainnet.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Address, generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getSyncNativeInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import {
  fetchWhirlpool,
  getDecreaseLiquidityInstruction,
  getIncreaseLiquidityInstruction,
  getPositionAddress,
  getTickArrayAddress,
} from "@orca-so/whirlpools-client";
import { openPositionInstructionsWithTickBounds, setDefaultFunder, swapInstructions } from "@orca-so/whirlpools";
import {
  airdrop,
  assertFork,
  forkRpc,
  rawAccount,
  sendInstructions,
  setTokenBalance,
  SOL_USDC_TS4,
  tokenBalance,
  USDC,
  WSOL,
} from "../src/surfnet.js";

const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;
const U64_MAX = (1n << 64n) - 1n;
const TICK_ARRAY_SPAN = 88;
const rpc = forkRpc();

type Snapshot = { whirlpool: string; position: string | null; tick_lower_array: string; tick_upper_array: string };

async function snapshot(pool: Address, position: Address | null, tl: Address, tu: Address): Promise<Snapshot> {
  return {
    whirlpool: (await rawAccount(rpc, pool))!,
    position: position ? await rawAccount(rpc, position) : null,
    tick_lower_array: (await rawAccount(rpc, tl))!,
    tick_upper_array: (await rawAccount(rpc, tu))!,
  };
}

const startIndex = (tick: number, spacing: number) =>
  Math.floor(tick / (spacing * TICK_ARRAY_SPAN)) * spacing * TICK_ARRAY_SPAN;

async function main() {
  const surf = await assertFork();
  console.log(`fork: surfnet ${surf}`);
  const user: KeyPairSigner = await generateKeyPairSigner();
  setDefaultFunder(user);
  await airdrop(rpc, user.address, 500);
  await setTokenBalance(user.address, USDC, 2_000_000_000_000n); // 2M USDC

  // Wrap 200 SOL into the user's wSOL ATA (Orca V1 instructions need plain token accounts).
  const [wsolAta] = await findAssociatedTokenPda({ owner: user.address, mint: WSOL, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const [usdcAta] = await findAssociatedTokenPda({ owner: user.address, mint: USDC, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  await sendInstructions(rpc, user, [
    await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: user, owner: user.address, mint: WSOL }),
    getTransferSolInstruction({ source: user, destination: wsolAta, amount: 200_000_000_000n }),
    getSyncNativeInstruction({ account: wsolAta }),
  ]);

  const pool = await fetchWhirlpool(rpc, SOL_USDC_TS4);
  const ts = pool.data.tickSpacing;
  const cur = pool.data.tickCurrentIndex;
  const aligned = Math.floor(cur / ts) * ts;
  console.log(`pool ${SOL_USDC_TS4}: tick ${cur}, spacing ${ts}`);

  // Three ranges: fully below price (all quote), around price, fully above price (all base).
  const ranges = [
    { name: "below", lo: aligned - 1200, hi: aligned - 400 },
    { name: "around", lo: aligned - 200, hi: aligned + 200 },
    { name: "above", lo: aligned + 400, hi: aligned + 1200 },
  ];

  const observations: unknown[] = [];
  const positions: Record<string, { mint: Address; position: Address; tl: Address; tu: Address; nft: Address }> = {};

  for (const r of ranges) {
    const open = await openPositionInstructionsWithTickBounds(rpc, SOL_USDC_TS4, { tokenMaxA: 10_000_000n, tokenMaxB: 1_000_000n }, r.lo, r.hi, {
      slippageToleranceBps: 10_000,
    });
    await sendInstructions(rpc, user, open.instructions);
    const [position] = await getPositionAddress(open.positionMint);
    const [tl] = await getTickArrayAddress(SOL_USDC_TS4, startIndex(r.lo, ts));
    const [tu] = await getTickArrayAddress(SOL_USDC_TS4, startIndex(r.hi, ts));
    const nftAcc = await rpc.getTokenAccountsByOwner(user.address, { mint: open.positionMint }, { encoding: "base64" }).send();
    const nft = nftAcc.value[0]!.pubkey;
    positions[r.name] = { mint: open.positionMint, position, tl, tu, nft };

    for (const [kind, L] of [["increase", 123_456_789_012n], ["decrease", 98_765_432_101n], ["increase", 1n], ["decrease", 1n]] as const) {
      const before = await snapshot(SOL_USDC_TS4, position, tl, tu);
      const a0 = await tokenBalance(rpc, wsolAta);
      const b0 = await tokenBalance(rpc, usdcAta);
      const common = {
        whirlpool: SOL_USDC_TS4,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        positionAuthority: user,
        position,
        positionTokenAccount: nft,
        tokenOwnerAccountA: wsolAta,
        tokenOwnerAccountB: usdcAta,
        tokenVaultA: pool.data.tokenVaultA,
        tokenVaultB: pool.data.tokenVaultB,
        tickArrayLower: tl,
        tickArrayUpper: tu,
        liquidityAmount: L,
      };
      const ix =
        kind === "increase"
          ? getIncreaseLiquidityInstruction({ ...common, tokenMaxA: U64_MAX, tokenMaxB: U64_MAX })
          : getDecreaseLiquidityInstruction({ ...common, tokenMinA: 0n, tokenMinB: 0n });
      const sig = await sendInstructions(rpc, user, [ix]);
      const a1 = await tokenBalance(rpc, wsolAta);
      const b1 = await tokenBalance(rpc, usdcAta);
      observations.push({
        kind: "liquidity", regime: r.name, op: kind, liquidity: L.toString(), tick_lower: r.lo, tick_upper: r.hi,
        signature: sig, before,
        // owner balance change; increase pays (negative), decrease receives (positive)
        delta_a: (a1 - a0).toString(), delta_b: (b1 - b0).toString(),
      });
      console.log(`${r.name} ${kind} L=${L}: dA=${a1 - a0} dB=${b1 - b0}`);
    }
  }

  // Fee growth: swap back and forth through the "around" position, then change its liquidity
  // (Full checkpoint mode) and record the post-state. The position's new fee_growth_checkpoint
  // must equal fee growth inside computed from the post-state ticks and globals.
  const around = positions.around!;
  for (const [mint, amount] of [[USDC, 5_000_000_000n], [WSOL, 30_000_000_000n], [USDC, 2_000_000_000n]] as const) {
    const sw = await swapInstructions(rpc, { inputAmount: amount, mint }, SOL_USDC_TS4, { slippageToleranceBps: 10_000 });
    await sendInstructions(rpc, user, sw.instructions);
  }
  const fresh = await fetchWhirlpool(rpc, SOL_USDC_TS4);
  await sendInstructions(rpc, user, [
    getDecreaseLiquidityInstruction({
      whirlpool: SOL_USDC_TS4, tokenProgram: TOKEN_PROGRAM_ADDRESS, positionAuthority: user,
      position: around.position, positionTokenAccount: around.nft, tokenOwnerAccountA: wsolAta, tokenOwnerAccountB: usdcAta,
      tokenVaultA: fresh.data.tokenVaultA, tokenVaultB: fresh.data.tokenVaultB, tickArrayLower: around.tl, tickArrayUpper: around.tu,
      liquidityAmount: 1_000n, tokenMinA: 0n, tokenMinB: 0n,
    }),
  ]);
  const after = await snapshot(SOL_USDC_TS4, around.position, around.tl, around.tu);
  observations.push({
    kind: "fee_growth", tick_lower: ranges[1]!.lo, tick_upper: ranges[1]!.hi, after,
  });

  const here = dirname(fileURLToPath(import.meta.url));
  const target = resolve(here, "../../math/tests/fixtures/orca_fork_observations.json");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(
    target,
    JSON.stringify({ pool: SOL_USDC_TS4, surfnet: surf, slot_note: "local fork state, mainnet-derived", observations }, null, 1) + "\n",
  );
  console.log(`wrote ${observations.length} observations to ${target}`);
  void TOKEN_2022;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
