/**
 * Token accounts without searching the RPC.
 *
 * On a Surfpool fork, getTokenAccountsByOwner is not answered from the fork's own state: Surfpool forwards
 * it to the mainnet datasource, where it is one of the most expensive calls and the public endpoint
 * rate-limits it (429), which surfaces as "Internal JSON-RPC error". Every token account FORGE creates or
 * funds is an associated token account, whose address follows from (owner, token program, mint). So we
 * derive those addresses and read them with one getMultipleAccounts, which the fork answers itself.
 */
import { address, getAddressEncoder, getProgramDerivedAddress, type Address } from "@solana/kit";

export const TOKEN_PROGRAM: string = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM: string = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

const enc = getAddressEncoder();

/** The associated token account of `owner` for `mint` under `tokenProgram`. */
export async function associatedTokenAddress(owner: string, mint: string, tokenProgram = TOKEN_PROGRAM): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: address(ATA_PROGRAM),
    seeds: [enc.encode(address(owner)), enc.encode(address(tokenProgram)), enc.encode(address(mint))],
  });
  return pda;
}

type RawAccount = { owner: string; data: unknown; lamports: number | bigint; executable: boolean; rentEpoch?: number | bigint; space?: number | bigint };
type Rpc = { getMultipleAccounts: (keys: Address[], cfg: { encoding: "jsonParsed" | "base64" }) => { send: () => Promise<{ value: (RawAccount | null)[] }> } };

export type TokenAccount = { address: Address; mint: string; program: string; amount: string; uiAmount: number; decimals: number; account: RawAccount };

/**
 * The owner's associated token accounts for these mints, under either token program, read in one call
 * (chunked at 100 keys). Accounts that do not exist are left out.
 */
export async function tokenAccountsFor(rpc: Rpc, owner: string, mints: string[], programs = [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]): Promise<TokenAccount[]> {
  const keys: { address: Address; mint: string; program: string }[] = [];
  for (const mint of [...new Set(mints)]) for (const program of programs) keys.push({ address: await associatedTokenAddress(owner, mint, program), mint, program });
  const out: TokenAccount[] = [];
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    const { value } = await rpc.getMultipleAccounts(chunk.map((k) => k.address), { encoding: "jsonParsed" }).send();
    value.forEach((acc, j) => {
      const k = chunk[j]!;
      if (!acc || String(acc.owner) !== k.program) return;
      const info = (acc.data as { parsed?: { info?: { mint?: string; tokenAmount?: { amount: string; uiAmount: number | null; decimals: number } } } })?.parsed?.info;
      if (!info?.tokenAmount || info.mint !== k.mint) return;
      out.push({ address: k.address, mint: k.mint, program: k.program, amount: info.tokenAmount.amount, uiAmount: info.tokenAmount.uiAmount ?? 0, decimals: info.tokenAmount.decimals, account: acc });
    });
  }
  return out;
}
