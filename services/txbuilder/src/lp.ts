/** LP instruction builders: deposits, ladder deposits, claims, withdrawals, fee collection. */
import { type Address, getAddressEncoder, getBase58Decoder, getProgramDerivedAddress, type Instruction, type Rpc, type SolanaRpcApi, type TransactionSigner } from "@solana/kit";
import { type Bucket, fetchBucket, fetchMarket, type Market } from "./accounts.js";
import { base64ToBytes, decodeAccount, IDL } from "./idl.js";
import { bucketTickArrays, liquidityDeltas, type PoolState, readPool, tickArrayStart } from "./orca.js";
import { type AccountInputs, FORGE_PROGRAM_ID, forgeIx, pdas, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID, WHIRLPOOL_PROGRAM_ID } from "./program.js";

export async function bucketPoolAccounts(market: Address, m: Market, bucket: Address, b: Bucket, pool: PoolState): Promise<AccountInputs> {
  const ta = await bucketTickArrays(m.whirlpool, b.tick_lower, b.tick_upper, pool.tickSpacing);
  return {
    market,
    vault: await pdas.vault(market),
    bucket,
    whirlpool: m.whirlpool,
    position: b.position,
    position_token_account: b.position_token_account,
    tick_array_lower: ta.lower,
    tick_array_upper: ta.upper,
    whirlpool_vault_a: pool.vaultA,
    whirlpool_vault_b: pool.vaultB,
    fee_vault_base: m.fee_vault_base,
    fee_vault_quote: m.fee_vault_quote,
    token_program: TOKEN_PROGRAM_ID,
    whirlpool_program: WHIRLPOOL_PROGRAM_ID,
  };
}

async function ctx(rpc: Rpc<SolanaRpcApi>, market: Address, bucket: Address) {
  const m = await fetchMarket(rpc, market);
  const b = await fetchBucket(rpc, bucket);
  const pool = await readPool(rpc, m.whirlpool);
  return { m, b, pool, accounts: await bucketPoolAccounts(market, m, bucket, b, pool) };
}

export async function depositLiquidityIx(p: {
  rpc: Rpc<SolanaRpcApi>;
  lp: TransactionSigner;
  market: Address;
  bucket: Address;
  liquidity: bigint;
  lpBase: Address;
  lpQuote: Address;
  slippageBps?: number;
}): Promise<Instruction> {
  const { m, b, pool, accounts } = await ctx(p.rpc, p.market, p.bucket);
  const d = liquidityDeltas(pool, b.tick_lower, b.tick_upper, p.liquidity, true);
  const [base, quote] = m.base_is_a ? [d.a, d.b] : [d.b, d.a];
  const pad = (v: bigint) => v + (v * BigInt(p.slippageBps ?? 50)) / 10_000n + 1n;
  return forgeIx("deposit_liquidity", {
    lp: p.lp,
    pool: accounts,
    lp_position: await pdas.lp(p.bucket, p.lp.address),
    lp_base: p.lpBase,
    lp_quote: p.lpQuote,
    staging_base: await pdas.stagingBase(p.market),
    staging_quote: await pdas.stagingQuote(p.market),
    system_program: SYSTEM_PROGRAM_ID,
  }, { liquidity: p.liquidity, max_base: pad(base), max_quote: pad(quote) });
}

export async function withdrawLiquidityIx(p: {
  rpc: Rpc<SolanaRpcApi>;
  lp: TransactionSigner;
  market: Address;
  bucket: Address;
  liquidity: bigint;
  lpBase: Address;
  lpQuote: Address;
  slippageBps?: number;
}): Promise<Instruction> {
  const { m, b, pool, accounts } = await ctx(p.rpc, p.market, p.bucket);
  const d = liquidityDeltas(pool, b.tick_lower, b.tick_upper, p.liquidity, false);
  const [base, quote] = m.base_is_a ? [d.a, d.b] : [d.b, d.a];
  const floor = (v: bigint) => v - (v * BigInt(p.slippageBps ?? 50)) / 10_000n;
  return forgeIx("withdraw_liquidity", {
    lp: p.lp,
    pool: accounts,
    lp_position: await pdas.lp(p.bucket, p.lp.address),
    lp_base: p.lpBase,
    lp_quote: p.lpQuote,
  }, { liquidity: p.liquidity, min_base: floor(base), min_quote: floor(quote) });
}

export async function requestWithdrawalIx(lp: TransactionSigner, bucket: Address, liquidity: bigint): Promise<Instruction> {
  return forgeIx("request_lp_withdrawal", { lp, bucket, lp_position: await pdas.lp(bucket, lp.address) }, { liquidity });
}

export async function claimLpIx(rpc: Rpc<SolanaRpcApi>, lp: TransactionSigner, market: Address, bucket: Address, lpBase: Address, lpQuote: Address): Promise<Instruction> {
  const { m, accounts } = await ctx(rpc, market, bucket);
  return forgeIx("claim_lp", {
    lp,
    pool: accounts,
    lp_position: await pdas.lp(bucket, lp.address),
    premium_vault: m.premium_vault,
    lp_base: lpBase,
    lp_quote: lpQuote,
  });
}

export async function collectAndDistributeIx(rpc: Rpc<SolanaRpcApi>, market: Address, bucket: Address): Promise<Instruction> {
  const { accounts } = await ctx(rpc, market, bucket);
  return forgeIx("collect_and_distribute", accounts);
}

// ---- ladder deposit of an existing Orca position ----

export async function depositTicket(market: Address, lp: Address, nonce: bigint) {
  const enc = getAddressEncoder();
  const n = new Uint8Array(8);
  new DataView(n.buffer).setBigUint64(0, nonce, true);
  const utf8 = (s: string) => new TextEncoder().encode(s);
  const [ticket] = await getProgramDerivedAddress({
    programAddress: FORGE_PROGRAM_ID,
    seeds: [utf8("deposit"), enc.encode(market) as Uint8Array, enc.encode(lp) as Uint8Array, n],
  });
  const escrow = async (s: string) =>
    (await getProgramDerivedAddress({ programAddress: FORGE_PROGRAM_ID, seeds: [utf8(s), enc.encode(ticket) as Uint8Array] }))[0];
  return { ticket, escrowBase: await escrow("deposit_base"), escrowQuote: await escrow("deposit_quote") };
}

export async function beginLpDepositIx(p: {
  rpc: Rpc<SolanaRpcApi>;
  lp: TransactionSigner;
  market: Address;
  nonce: bigint;
  orcaPosition: Address;
  orcaPositionTokenAccount: Address;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
}): Promise<{ ix: Instruction; ticket: Address }> {
  const m = await fetchMarket(p.rpc, p.market);
  const pool = await readPool(p.rpc, m.whirlpool);
  const t = await depositTicket(p.market, p.lp.address, p.nonce);
  return {
    ticket: t.ticket,
    ix: forgeIx("begin_lp_deposit", {
      lp: p.lp,
      market: p.market,
      vault: await pdas.vault(p.market),
      ticket: t.ticket,
      escrow_base: t.escrowBase,
      escrow_quote: t.escrowQuote,
      base_mint: m.base_mint,
      quote_mint: m.quote_mint,
      whirlpool: m.whirlpool,
      lp_orca_position: p.orcaPosition,
      lp_orca_position_token_account: p.orcaPositionTokenAccount,
      tick_array_lower: await pdas.tickArray(m.whirlpool, tickArrayStart(p.tickLower, pool.tickSpacing)),
      tick_array_upper: await pdas.tickArray(m.whirlpool, tickArrayStart(p.tickUpper, pool.tickSpacing)),
      whirlpool_vault_a: pool.vaultA,
      whirlpool_vault_b: pool.vaultB,
      token_program: TOKEN_PROGRAM_ID,
      system_program: SYSTEM_PROGRAM_ID,
      whirlpool_program: WHIRLPOOL_PROGRAM_ID,
    }, { nonce: p.nonce, liquidity: p.liquidity }),
  };
}

export async function executeLpDepositBucketIx(rpc: Rpc<SolanaRpcApi>, payer: TransactionSigner, market: Address, lp: Address, nonce: bigint, bucket: Address): Promise<Instruction> {
  const { accounts } = await ctx(rpc, market, bucket);
  const t = await depositTicket(market, lp, nonce);
  return forgeIx("execute_lp_deposit_bucket", {
    payer,
    pool: accounts,
    ticket: t.ticket,
    lp,
    lp_position: await pdas.lp(bucket, lp),
    escrow_base: t.escrowBase,
    escrow_quote: t.escrowQuote,
    system_program: SYSTEM_PROGRAM_ID,
  });
}

export async function finishLpDepositIx(rpc: Rpc<SolanaRpcApi>, lp: TransactionSigner, market: Address, nonce: bigint, lpBase: Address, lpQuote: Address, cancel = false): Promise<Instruction> {
  const t = await depositTicket(market, lp.address, nonce);
  return forgeIx("finish_lp_deposit", {
    lp,
    market,
    vault: await pdas.vault(market),
    ticket: t.ticket,
    escrow_base: t.escrowBase,
    escrow_quote: t.escrowQuote,
    lp_base: lpBase,
    lp_quote: lpQuote,
    token_program: TOKEN_PROGRAM_ID,
  }, { cancel });
}

/** All open strategy legs borrowing from `bucket` (scans FORGE strategy accounts). */
export async function openLegsOnBucket(rpc: Rpc<SolanaRpcApi>, bucket: Address): Promise<{ strategy: Address; legIndex: number }[]> {
  const disc = IDL.accounts.find((a) => a.name === "Strategy")!.discriminator;
  const res = await rpc
    .getProgramAccounts(FORGE_PROGRAM_ID, {
      encoding: "base64",
      filters: [{ memcmp: { offset: 0n, bytes: getBase58Decoder().decode(Uint8Array.from(disc)) as never, encoding: "base58" } }],
    })
    .send();
  const out: { strategy: Address; legIndex: number }[] = [];
  for (const acc of res as unknown as { pubkey: Address; account: { data: [string, string] } }[]) {
    const s = decodeAccount<{ state: string; leg_count: number; legs: { bucket: Address; executed: boolean; restored: boolean }[] }>(
      "Strategy",
      base64ToBytes(acc.account.data[0]),
    );
    if (!["Open", "PendingClose", "Recovery"].includes(s.state)) continue;
    s.legs.slice(0, s.leg_count).forEach((l, i) => {
      if (l.bucket === bucket && l.executed && !l.restored) out.push({ strategy: acc.pubkey, legIndex: i });
    });
  }
  return out;
}

/** Checkpoint instructions for every open leg on a bucket; prepend them to any share change. */
export async function checkpointIxsForBucket(rpc: Rpc<SolanaRpcApi>, market: Address, bucket: Address): Promise<Instruction[]> {
  const legs = await openLegsOnBucket(rpc, bucket);
  const { checkpointLegIx } = await import("./flows.js");
  return Promise.all(legs.map((l) => checkpointLegIx(rpc, market, l.strategy, l.legIndex)));
}
