import type { Address, KeyPairSigner, Rpc, SolanaRpcApi } from "@solana/kit";
import { getCreateLookupTableInstructionAsync, getExtendLookupTableInstruction, fetchAddressLookupTable } from "@solana-program/address-lookup-table";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  bucketTickArrays,
  type Bucket,
  FORGE_PROGRAM_ID,
  type Market,
  pdas,
  RENT_SYSVAR_ID,
  readPool,
  SYSTEM_PROGRAM_ID,
  tickArrayStart,
  TOKEN_PROGRAM_ID,
  WHIRLPOOL_PROGRAM_ID,
} from "@forge/txbuilder";
import { sendInstructions } from "./surfnet.js";

const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111" as Address;
const SWAP_ARRAYS_EACH_SIDE = 10;

/** Every recurring address a market's transactions touch. Signers stay in the static message. */
export async function marketAddresses(rpc: Rpc<SolanaRpcApi>, market: Address, m: Market, buckets: { address: Address; b: Bucket }[]): Promise<Address[]> {
  const target = await readPool(rpc, m.whirlpool);
  const swap = await readPool(rpc, m.swap_pool);
  const set = new Set<Address>([
    FORGE_PROGRAM_ID, WHIRLPOOL_PROGRAM_ID, TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID, RENT_SYSVAR_ID, ASSOCIATED_TOKEN_PROGRAM_ID, COMPUTE_BUDGET,
    await pdas.config(), market, await pdas.vault(market), m.premium_vault, await pdas.stagingBase(market), await pdas.stagingQuote(market),
    m.fee_vault_base, m.fee_vault_quote,
    m.base_mint, m.quote_mint, m.whirlpool, target.vaultA, target.vaultB, m.swap_pool, swap.vaultA, swap.vaultB, await pdas.oracle(m.swap_pool),
    m.reference.base_account,
  ]);
  if (m.reference.kind === "PythPair") set.add(m.reference.quote_account);
  for (const { address, b } of buckets) {
    set.add(address);
    set.add(b.position);
    set.add(b.position_token_account);
    const ta = await bucketTickArrays(m.whirlpool, b.tick_lower, b.tick_upper, target.tickSpacing);
    set.add(ta.lower);
    set.add(ta.upper);
  }
  const span = swap.tickSpacing * 88;
  const start = tickArrayStart(swap.tickCurrentIndex, swap.tickSpacing);
  for (let k = -SWAP_ARRAYS_EACH_SIDE; k <= SWAP_ARRAYS_EACH_SIDE; k++) set.add(await pdas.tickArray(m.swap_pool, start + k * span));
  return [...set];
}

/** Create a lookup table with `addresses`, extend in chunks, and wait until it is active. */
export async function createLookupTable(rpc: Rpc<SolanaRpcApi>, authority: KeyPairSigner, addresses: Address[]): Promise<Address> {
  const slot = await rpc.getSlot({ commitment: "finalized" }).send();
  const create = await getCreateLookupTableInstructionAsync({ authority, payer: authority, recentSlot: slot });
  const alt = create.accounts[0].address as Address;
  await sendInstructions(rpc, authority, [create]);
  for (let i = 0; i < addresses.length; i += 25) {
    await sendInstructions(rpc, authority, [
      getExtendLookupTableInstruction({ address: alt, authority, payer: authority, addresses: addresses.slice(i, i + 25) }),
    ]);
  }
  // A lookup table is usable from the slot after its last extension.
  const extendedAt = await rpc.getSlot().send();
  for (let i = 0; i < 40; i++) {
    const now = await rpc.getSlot().send();
    const t = await fetchAddressLookupTable(rpc, alt);
    if (now > extendedAt && t.data.addresses.length === addresses.length) return alt;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`lookup table ${alt} did not activate`);
}
