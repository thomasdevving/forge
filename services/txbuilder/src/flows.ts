/**
 * High-level transaction builders. Every builder returns unsigned instructions; the user
 * always signs in their own wallet. Strategies that fit in one transaction pack
 * begin + execute + finalize together so the open (or close) is atomic.
 */
import { type AccountMeta, type Address, getAddressEncoder, getProgramDerivedAddress, type Instruction, type Rpc, type SolanaRpcApi, type TransactionSigner } from "@solana/kit";
import { type Bucket, fetchBucket, fetchMarket, fetchStrategy, type Market, type MarketParams, type ReferenceConfig, type Strategy } from "./accounts.js";
import { bucketTickArrays, liquidityDeltas, type PoolState, readPool, swapTickArrays } from "./orca.js";
import { type AccountInput, forgeIx, pdas, RENT_SYSVAR_ID, ro, rw, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID, WHIRLPOOL_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, FORGE_PROGRAM_ID } from "./program.js";

const SYSTEM = { system_program: SYSTEM_PROGRAM_ID };

export async function initializeConfigIx(upgradeAuthority: TransactionSigner, admin: Address): Promise<Instruction> {
  return forgeIx("initialize_config", {
    upgrade_authority: upgradeAuthority,
    config: await pdas.config(),
    program: FORGE_PROGRAM_ID,
    program_data: await pdas.programData(),
    ...SYSTEM,
  }, { admin });
}

export async function initializeMarketIx(p: {
  admin: TransactionSigner;
  whirlpool: Address;
  swapPool: Address;
  baseMint: Address;
  quoteMint: Address;
  bucketMultiplier: number;
  params: MarketParams;
  reference: ReferenceConfig;
}): Promise<{ ix: Instruction; market: Address }> {
  const market = await pdas.market(p.whirlpool);
  const ix = forgeIx("initialize_market", {
    admin: p.admin,
    config: await pdas.config(),
    market,
    vault: await pdas.vault(market),
    whirlpool: p.whirlpool,
    swap_pool: p.swapPool,
    base_mint: p.baseMint,
    quote_mint: p.quoteMint,
    premium_vault: await pdas.premiumVault(market),
    staging_base: await pdas.stagingBase(market),
    staging_quote: await pdas.stagingQuote(market),
    fee_vault_base: await pdas.feeVaultBase(market),
    fee_vault_quote: await pdas.feeVaultQuote(market),
    token_program: TOKEN_PROGRAM_ID,
    rent: RENT_SYSVAR_ID,
    ...SYSTEM,
  }, { args: { bucket_multiplier: p.bucketMultiplier, params: p.params, reference: p.reference } });
  return { ix, market };
}

export async function createBucketIx(payer: TransactionSigner, market: Address, m: Market, tickLower: number) {
  const bucket = await pdas.bucket(market, tickLower);
  const mint = await pdas.bucketMint(bucket);
  const vault = await pdas.vault(market);
  return {
    bucket,
    ix: forgeIx("create_bucket", {
      payer,
      market,
      vault,
      bucket,
      position_mint: mint,
      position: await pdas.orcaPosition(mint),
      position_token_account: await pdas.ata(vault, mint),
      whirlpool: m.whirlpool,
      token_program: TOKEN_PROGRAM_ID,
      rent: RENT_SYSVAR_ID,
      associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID,
      whirlpool_program: WHIRLPOOL_PROGRAM_ID,
      ...SYSTEM,
    }, { tick_lower: tickLower }),
  };
}

export type LegKindName = "BorrowQuote" | "BorrowBase" | "ProvideQuote" | "ProvideBase";
export const LEG_KIND_TAG: Record<LegKindName, number> = { BorrowQuote: 0, BorrowBase: 1, ProvideQuote: 2, ProvideBase: 3 };
export type LegSpec = { kind: LegKindName; tickLower: number; liquidity: bigint; extraBuffer?: bigint };
const isBorrowTag = (tag: number) => tag <= 1;

/** Per-strategy authority, provided-leg funding accounts and position-mint PDAs. */
export async function strategyPdas(strategy: Address) {
  const enc = getAddressEncoder();
  const seed = async (s: string, extra: Uint8Array[] = []) =>
    (await getProgramDerivedAddress({ programAddress: FORGE_PROGRAM_ID, seeds: [new TextEncoder().encode(s), enc.encode(strategy) as Uint8Array, ...extra] }))[0];
  return {
    authority: await seed("strategy_authority"),
    provideBase: await seed("provide_base"),
    provideQuote: await seed("provide_quote"),
    legMint: (i: number) => seed("leg_mint", [Uint8Array.of(i)]),
  };
}

function referenceAccounts(m: Market): { reference_base: Address; reference_quote: Address } {
  return {
    reference_base: m.reference.base_account,
    // the scenario reference has no quote feed; any readonly account satisfies the slot
    reference_quote: m.reference.kind === "PythPair" ? m.reference.quote_account : SYSTEM_PROGRAM_ID,
  };
}

type LegRef = { tag: number; index: number; tickLower: number; tickUpper: number; bucket?: Address };

/** Remaining accounts per leg: borrowed -> bucket accounts; provided -> its own position. */
async function legRemaining(m: Market, strategy: Address, legs: LegRef[], spacing: number, rpc: Rpc<SolanaRpcApi>): Promise<AccountMeta[]> {
  const sp = await strategyPdas(strategy);
  const out: AccountMeta[] = [];
  for (const l of legs) {
    const ta = await bucketTickArrays(m.whirlpool, l.tickLower, l.tickUpper, spacing);
    if (isBorrowTag(l.tag)) {
      const b = await fetchBucket(rpc, l.bucket!);
      out.push(rw(l.bucket!), rw(b.position), ro(b.position_token_account), rw(ta.lower), rw(ta.upper));
    } else {
      const mint = await sp.legMint(l.index);
      out.push(rw(mint), rw(await pdas.orcaPosition(mint)), rw(await pdas.ata(sp.authority, mint)), rw(ta.lower), rw(ta.upper));
    }
  }
  return out;
}

export type OpenParams = {
  owner: TransactionSigner;
  market: Address;
  nonce: bigint;
  legs: LegSpec[];
  premiumBudget: bigint;
  expiry: bigint;
  openReferenceX64: bigint;
  openToleranceBps: number;
  swapSlippageBps: number;
  certificateHash: Uint8Array;
  userBase: Address;
  userQuote: Address;
};

/** Build the open as a list of transactions (each a list of instructions). One tx if it fits. */
export async function buildOpen(rpc: Rpc<SolanaRpcApi>, p: OpenParams): Promise<{ strategy: Address; transactions: Instruction[][] }> {
  const m = await fetchMarket(rpc, p.market);
  const pool = await readPool(rpc, m.whirlpool);
  const strategy = await pdas.strategy(p.market, p.owner.address, p.nonce);
  const vault = await pdas.vault(p.market);
  const sp = await strategyPdas(strategy);
  const refs = referenceAccounts(m);
  const legRefs: LegRef[] = await Promise.all(p.legs.map(async (l, i) => ({
    tag: LEG_KIND_TAG[l.kind],
    index: i,
    tickLower: l.tickLower,
    tickUpper: l.tickLower + m.bucket_width,
    bucket: isBorrowTag(LEG_KIND_TAG[l.kind]) ? await pdas.bucket(p.market, l.tickLower) : undefined,
  })));
  // begin_open: one remaining account per leg (bucket, or the provided leg's mint PDA)
  const beginRemaining = await Promise.all(legRefs.map(async (l) => rw(l.bucket ?? (await sp.legMint(l.index)))));

  const begin = forgeIx("begin_open", {
    owner: p.owner,
    market: p.market,
    vault,
    strategy,
    escrow_base: await pdas.escrowBase(strategy),
    escrow_quote: await pdas.escrowQuote(strategy),
    budget: await pdas.budget(strategy),
    strategy_authority: sp.authority,
    provide_base: sp.provideBase,
    provide_quote: sp.provideQuote,
    base_mint: m.base_mint,
    quote_mint: m.quote_mint,
    user_base: p.userBase,
    user_quote: p.userQuote,
    whirlpool: m.whirlpool,
    ...refs,
    token_program: TOKEN_PROGRAM_ID,
    rent: RENT_SYSVAR_ID,
    ...SYSTEM,
  }, {
    args: {
      nonce: p.nonce,
      legs: p.legs.map((l) => ({ kind_tag: LEG_KIND_TAG[l.kind], tick_lower: l.tickLower, liquidity: l.liquidity, extra_buffer: l.extraBuffer ?? 0n })),
      premium_budget: p.premiumBudget,
      expiry: p.expiry,
      open_reference_x64: p.openReferenceX64,
      open_tolerance_bps: p.openToleranceBps,
      swap_slippage_bps: p.swapSlippageBps,
      certificate_hash: p.certificateHash,
    },
  }, beginRemaining);

  const execAccounts = {
    owner: p.owner,
    market: p.market,
    vault,
    strategy,
    whirlpool: m.whirlpool,
    whirlpool_vault_a: pool.vaultA,
    whirlpool_vault_b: pool.vaultB,
    escrow_base: await pdas.escrowBase(strategy),
    escrow_quote: await pdas.escrowQuote(strategy),
    strategy_authority: sp.authority,
    provide_base: sp.provideBase,
    provide_quote: sp.provideQuote,
    ...refs,
    token_program: TOKEN_PROGRAM_ID,
    rent: RENT_SYSVAR_ID,
    associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID,
    whirlpool_program: WHIRLPOOL_PROGRAM_ID,
    ...SYSTEM,
  } satisfies Record<string, AccountInput>;
  const batches: number[][] = [];
  for (let i = 0; i < p.legs.length; i += m.params.max_ops_per_tx) {
    batches.push(Array.from({ length: Math.min(m.params.max_ops_per_tx, p.legs.length - i) }, (_, k) => i + k));
  }
  const execIxs: Instruction[] = [];
  for (const batch of batches) {
    const rem = await legRemaining(m, strategy, batch.map((i) => legRefs[i]!), pool.tickSpacing, rpc);
    execIxs.push(forgeIx("execute_open_batch", execAccounts, { leg_indices: batch }, rem));
  }
  const finalize = forgeIx("finalize_open", { owner: p.owner, strategy });
  const transactions = batches.length === 1 ? [[begin, execIxs[0]!, finalize]] : [[begin], ...execIxs.map((x) => [x]), [finalize]];
  return { strategy, transactions };
}

/** Which way the restoration swap would go for each remaining leg at the current price. */
function restorationDirection(m: Market, pool: PoolState, s: Strategy, legIdx: number): "buyBase" | "sellBase" | "none" {
  const l = s.legs[legIdx]!;
  if (!isBorrowTag(l.kind_tag)) return "none";
  const d = liquidityDeltas(pool, l.tick_lower, l.tick_upper, l.liquidity, true);
  const [needBase, needQuote] = m.base_is_a ? [d.a, d.b] : [d.b, d.a];
  if (needBase > l.escrow_base) return "buyBase";
  if (needQuote > l.escrow_quote) return "sellBase";
  return "none";
}

export type CloseParams = { caller: TransactionSigner; market: Address; strategy: Address; keeperQuote?: Address; userBase: Address; userQuote: Address };

export async function buildCloseBatch(rpc: Rpc<SolanaRpcApi>, p: CloseParams, legIndices: number[]): Promise<Instruction> {
  const m = await fetchMarket(rpc, p.market);
  const pool = await readPool(rpc, m.whirlpool);
  const swapPool = await readPool(rpc, m.swap_pool);
  const s = await fetchStrategy(rpc, p.strategy);
  // all legs in one batch share one swap direction; the builder groups them accordingly
  const dirs = legIndices.map((i) => restorationDirection(m, pool, s, i)).filter((d) => d !== "none");
  const dir = dirs[0] ?? "none";
  const payIsA = dir === "buyBase" ? !m.base_is_a : m.base_is_a;
  const [t0, t1, t2] = await swapTickArrays(swapPool, payIsA);
  const sp = await strategyPdas(p.strategy);
  const rem = await legRemaining(
    m,
    p.strategy,
    legIndices.map((i) => ({ tag: s.legs[i]!.kind_tag, index: i, tickLower: s.legs[i]!.tick_lower, tickUpper: s.legs[i]!.tick_upper, bucket: s.legs[i]!.bucket })),
    pool.tickSpacing,
    rpc,
  );
  return forgeIx("execute_close_batch", {
    caller: p.caller,
    market: p.market,
    vault: await pdas.vault(p.market),
    strategy: p.strategy,
    whirlpool: m.whirlpool,
    whirlpool_vault_a: pool.vaultA,
    whirlpool_vault_b: pool.vaultB,
    escrow_base: await pdas.escrowBase(p.strategy),
    escrow_quote: await pdas.escrowQuote(p.strategy),
    budget: await pdas.budget(p.strategy),
    premium_vault: m.premium_vault,
    ...referenceAccounts(m),
    swap_pool: m.swap_pool,
    swap_vault_a: swapPool.vaultA,
    swap_vault_b: swapPool.vaultB,
    swap_tick_array_0: t0,
    swap_tick_array_1: t1,
    swap_tick_array_2: t2,
    swap_oracle: await pdas.oracle(m.swap_pool),
    strategy_authority: sp.authority,
    provide_base: sp.provideBase,
    provide_quote: sp.provideQuote,
    owner: s.owner,
    token_program: TOKEN_PROGRAM_ID,
    whirlpool_program: WHIRLPOOL_PROGRAM_ID,
  }, { leg_indices: legIndices }, rem);
}

export async function buildFinalizeClose(rpc: Rpc<SolanaRpcApi>, p: CloseParams): Promise<Instruction> {
  const m = await fetchMarket(rpc, p.market);
  const s = await fetchStrategy(rpc, p.strategy);
  // every leg's bucket: the program credits whichever legs still have unpaid premium
  const unpaidBuckets = [...new Set(s.legs.filter((l) => isBorrowTag(l.kind_tag)).map((l) => l.bucket))].map((b) => rw(b));
  return forgeIx("finalize_close", {
    caller: p.caller,
    market: p.market,
    vault: await pdas.vault(p.market),
    strategy: p.strategy,
    owner: s.owner,
    escrow_base: await pdas.escrowBase(p.strategy),
    escrow_quote: await pdas.escrowQuote(p.strategy),
    budget: await pdas.budget(p.strategy),
    premium_vault: m.premium_vault,
    user_base: p.userBase,
    user_quote: p.userQuote,
    keeper_quote: p.keeperQuote ?? p.userQuote,
    strategy_authority: (await strategyPdas(p.strategy)).authority,
    provide_base: (await strategyPdas(p.strategy)).provideBase,
    provide_quote: (await strategyPdas(p.strategy)).provideQuote,
    token_program: TOKEN_PROGRAM_ID,
  }, {}, unpaidBuckets);
}

/** Full close plan: begin (if Open), restoration batches, finalize. One tx if it fits. */
export async function buildClose(rpc: Rpc<SolanaRpcApi>, p: CloseParams): Promise<Instruction[][]> {
  const m = await fetchMarket(rpc, p.market);
  const s = await fetchStrategy(rpc, p.strategy);
  const pending = s.legs.map((l, i) => ({ l, i })).filter(({ l }) => l.executed && !l.restored).map(({ i }) => i);
  const begin = s.state === "Open"
    ? [forgeIx("begin_close", { caller: p.caller, market: p.market, strategy: p.strategy }, {}, s.legs.filter((l) => isBorrowTag(l.kind_tag)).map((l) => ro(l.bucket)))]
    : [];
  const batches: number[][] = [];
  for (let i = 0; i < pending.length; i += m.params.max_ops_per_tx) batches.push(pending.slice(i, i + m.params.max_ops_per_tx));
  const execs = await Promise.all(batches.map((b) => buildCloseBatch(rpc, p, b)));
  const finalize = await buildFinalizeClose(rpc, p);
  if (batches.length <= 1) return [[...begin, ...execs, finalize]];
  return [...(begin.length ? [begin] : []), ...execs.map((e) => [e]), [finalize]];
}

export async function checkpointLegIx(rpc: Rpc<SolanaRpcApi>, market: Address, strategy: Address, legIndex: number): Promise<Instruction> {
  const m = await fetchMarket(rpc, market);
  const s = await fetchStrategy(rpc, strategy);
  const l = s.legs[legIndex]!;
  const ta = await bucketTickArrays(m.whirlpool, l.tick_lower, l.tick_upper, m.tick_spacing);
  return forgeIx("checkpoint_leg", {
    market,
    vault: await pdas.vault(market),
    strategy,
    whirlpool: m.whirlpool,
    budget: await pdas.budget(strategy),
    premium_vault: m.premium_vault,
    ...referenceAccounts(m),
    token_program: TOKEN_PROGRAM_ID,
  }, { leg_index: legIndex }, [rw(l.bucket), ro(ta.lower), ro(ta.upper)]);
}

export async function recordRecoveryIx(rpc: Rpc<SolanaRpcApi>, market: Address, strategy: Address, legIndex: number): Promise<Instruction> {
  const m = await fetchMarket(rpc, market);
  return forgeIx("record_recovery", {
    market,
    strategy,
    whirlpool: m.whirlpool,
    swap_pool: m.swap_pool,
    ...referenceAccounts(m),
  }, { leg_index: legIndex });
}

export async function topUpBufferIx(owner: TransactionSigner, strategy: Address, source: Address, escrow: Address, legIndex: number, amount: bigint): Promise<Instruction> {
  return forgeIx("top_up_buffer", { owner, strategy, source, escrow, token_program: TOKEN_PROGRAM_ID }, { leg_index: legIndex, amount });
}

export async function initScenarioReferenceIx(admin: TransactionSigner, whirlpool: Address, signer: Address) {
  const scenario = await pdas.scenario(whirlpool);
  return { scenario, ix: forgeIx("init_scenario_reference", { admin, config: await pdas.config(), whirlpool, scenario, ...SYSTEM }, { signer }) };
}

export async function updateScenarioReferenceIx(signer: TransactionSigner, scenario: Address, priceX64: bigint, confBps: number) {
  return forgeIx("update_scenario_reference", { signer, scenario }, { price_x64: priceX64, conf_bps: confBps });
}
