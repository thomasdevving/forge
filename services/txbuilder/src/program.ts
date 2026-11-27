import {
  type AccountMeta,
  AccountRole,
  type Address,
  address,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Instruction,
  isTransactionSigner,
  type TransactionSigner,
} from "@solana/kit";
import { encodeArgs, IDL, type IdlAccountItem, instructionDef } from "./idl.js";

export const FORGE_PROGRAM_ID = address(process.env.FORGE_PROGRAM_ID ?? IDL.address);
export const WHIRLPOOL_PROGRAM_ID = address("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
export const TOKEN_PROGRAM_ID = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ASSOCIATED_TOKEN_PROGRAM_ID = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const SYSTEM_PROGRAM_ID = address("11111111111111111111111111111111");
export const RENT_SYSVAR_ID = address("SysvarRent111111111111111111111111111111111");
export const BPF_LOADER_UPGRADEABLE_ID = address("BPFLoaderUpgradeab1e11111111111111111111111");

export type AccountInput = Address | TransactionSigner;
/** Account inputs; a composite group (e.g. `pool`) is given as a nested object. */
export type AccountInputs = { [name: string]: AccountInput | AccountInputs };

function flattenMetas(ixName: string, items: IdlAccountItem[], given: AccountInputs, path: string): AccountMeta[] {
  const out: AccountMeta[] = [];
  for (const acc of items) {
    const here = path ? `${path}.${acc.name}` : acc.name;
    if (acc.accounts) {
      const group = given[acc.name];
      if (!group || typeof group !== "object" || isTransactionSigner(group as TransactionSigner)) {
        throw new Error(`${ixName}: missing account group ${here}`);
      }
      out.push(...flattenMetas(ixName, acc.accounts, group as AccountInputs, here));
      continue;
    }
    const v = (given[acc.name] as AccountInput | undefined) ?? (acc.address ? address(acc.address) : undefined);
    if (v === undefined) throw new Error(`${ixName}: missing account ${here}`);
    const isSigner = Boolean(acc.signer);
    const role = acc.writable
      ? isSigner ? AccountRole.WRITABLE_SIGNER : AccountRole.WRITABLE
      : isSigner ? AccountRole.READONLY_SIGNER : AccountRole.READONLY;
    if (typeof v === "object" && isTransactionSigner(v)) {
      out.push({ address: v.address, role, signer: v } as AccountMeta);
      continue;
    }
    if (isSigner) throw new Error(`${ixName}: account ${here} must be a TransactionSigner`);
    out.push({ address: v as Address, role });
  }
  return out;
}

/** Build a FORGE instruction from its IDL definition. Account order and flags come from the IDL. */
export function forgeIx(
  name: string,
  accounts: AccountInputs,
  args: Record<string, unknown> = {},
  remaining: AccountMeta[] = [],
  programId: Address = FORGE_PROGRAM_ID,
): Instruction {
  const def = instructionDef(name);
  const metas = flattenMetas(name, def.accounts, accounts, "");
  return { programAddress: programId, accounts: [...metas, ...remaining], data: encodeArgs(def, args) };
}

export const ro = (a: Address): AccountMeta => ({ address: a, role: AccountRole.READONLY });
export const rw = (a: Address): AccountMeta => ({ address: a, role: AccountRole.WRITABLE });

const enc = getAddressEncoder();
const utf8 = (s: string) => new TextEncoder().encode(s);
const i32le = (v: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, v, true);
  return b;
};
const u64le = (v: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return b;
};

async function pda(seeds: (Uint8Array | string)[], programId: Address = FORGE_PROGRAM_ID): Promise<Address> {
  const [a] = await getProgramDerivedAddress({ programAddress: programId, seeds: seeds.map((s) => (typeof s === "string" ? utf8(s) : s)) });
  return a;
}

export const pdas = {
  config: () => pda(["config"]),
  market: (whirlpool: Address) => pda(["market", enc.encode(whirlpool) as Uint8Array]),
  vault: (market: Address) => pda(["vault", enc.encode(market) as Uint8Array]),
  premiumVault: (market: Address) => pda(["premium_vault", enc.encode(market) as Uint8Array]),
  stagingBase: (market: Address) => pda(["staging_base", enc.encode(market) as Uint8Array]),
  stagingQuote: (market: Address) => pda(["staging_quote", enc.encode(market) as Uint8Array]),
  feeVaultBase: (market: Address) => pda(["fee_vault_base", enc.encode(market) as Uint8Array]),
  feeVaultQuote: (market: Address) => pda(["fee_vault_quote", enc.encode(market) as Uint8Array]),
  bucket: (market: Address, tickLower: number) => pda(["bucket", enc.encode(market) as Uint8Array, i32le(tickLower)]),
  bucketMint: (bucket: Address) => pda(["bucket_mint", enc.encode(bucket) as Uint8Array]),
  lp: (bucket: Address, owner: Address) => pda(["lp", enc.encode(bucket) as Uint8Array, enc.encode(owner) as Uint8Array]),
  strategy: (market: Address, owner: Address, nonce: bigint) =>
    pda(["strategy", enc.encode(market) as Uint8Array, enc.encode(owner) as Uint8Array, u64le(nonce)]),
  escrowBase: (strategy: Address) => pda(["escrow_base", enc.encode(strategy) as Uint8Array]),
  escrowQuote: (strategy: Address) => pda(["escrow_quote", enc.encode(strategy) as Uint8Array]),
  budget: (strategy: Address) => pda(["budget", enc.encode(strategy) as Uint8Array]),
  scenario: (whirlpool: Address) => pda(["scenario_reference", enc.encode(whirlpool) as Uint8Array]),
  programData: (programId: Address = FORGE_PROGRAM_ID) => pda([enc.encode(programId) as Uint8Array], BPF_LOADER_UPGRADEABLE_ID),
  // Orca
  orcaPosition: (mint: Address) => pda(["position", enc.encode(mint) as Uint8Array], WHIRLPOOL_PROGRAM_ID),
  tickArray: (whirlpool: Address, start: number) => pda(["tick_array", enc.encode(whirlpool) as Uint8Array, String(start)], WHIRLPOOL_PROGRAM_ID),
  oracle: (whirlpool: Address) => pda(["oracle", enc.encode(whirlpool) as Uint8Array], WHIRLPOOL_PROGRAM_ID),
  ata: (owner: Address, mint: Address) =>
    pda([enc.encode(owner) as Uint8Array, enc.encode(TOKEN_PROGRAM_ID) as Uint8Array, enc.encode(mint) as Uint8Array], ASSOCIATED_TOKEN_PROGRAM_ID),
};
