/**
 * Browser RPC (the public fork endpoint behind the method filter) plus safety checks that run
 * before anything is signed:
 *   - the endpoint is a Surfpool fork running the expected FORGE program (never mainnet);
 *   - every transaction's top-level instructions only call FORGE or the compute-budget program,
 *     and its fee payer is the connected wallet.
 */
import {
  address,
  createSolanaRpc,
  getAddressEncoder,
  getProgramDerivedAddress,
  getBase64Decoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from "@solana/kit";
import { config } from "./config";

export const rpc = createSolanaRpc(config.rpcUrl);
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";

let clusterCheck: Promise<{ surfpool: string }> | null = null;

export function assertForkCluster(): Promise<{ surfpool: string }> {
  clusterCheck ??= (async () => {
    const v = (await rpc.getVersion().send()) as unknown as Record<string, string>;
    if (!v["surfnet-version"]) throw new Error("Refusing to sign: the RPC endpoint is not the FORGE fork.");
    if (config.expectedGenesisHash) {
      const g = await rpc.getGenesisHash().send();
      if (g !== config.expectedGenesisHash) throw new Error("Refusing to sign: unexpected cluster genesis hash.");
    }
    const prog = await rpc.getAccountInfo(config.programId as never, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }).send();
    if (!prog.value?.executable) throw new Error("Refusing to sign: the FORGE program is not deployed on this endpoint.");
    return { surfpool: v["surfnet-version"] };
  })();
  clusterCheck.catch(() => (clusterCheck = null));
  return clusterCheck;
}

export function b64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(getBase64Encoder().encode(b64));
}

export function bytesToB64(b: Uint8Array): string {
  return getBase64Decoder().decode(b);
}

/** Decode an unsigned transaction and enforce what it may do before the wallet sees it. */
export function inspectTransaction(bytes: Uint8Array, wallet: string) {
  const tx = getTransactionDecoder().decode(bytes);
  const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  const keys = msg.staticAccounts.map(String);
  if (keys[0] !== wallet) throw new Error("Refusing to sign: the fee payer is not your wallet.");
  const programs = msg.instructions.map((ix) => keys[ix.programAddressIndex]);
  for (const p of programs) {
    if (p !== config.programId && p !== COMPUTE_BUDGET) throw new Error(`Refusing to sign: unexpected program ${p}.`);
  }
  if (!programs.includes(config.programId)) throw new Error("Refusing to sign: no FORGE instruction in this transaction.");
  const lookups = "addressTableLookups" in msg ? ((msg as { addressTableLookups?: unknown[] }).addressTableLookups?.length ?? 0) : 0;
  return { instructions: programs.length, lookups };
}

export async function sendAndConfirm(signed: Uint8Array): Promise<string> {
  const sig = await rpc.sendTransaction(bytesToB64(signed) as never, { encoding: "base64", preflightCommitment: "confirmed" }).send();
  for (let i = 0; i < 120; i++) {
    const { value } = await rpc.getSignatureStatuses([sig]).send();
    const st = value[0];
    if (st?.err) throw new Error(`Transaction failed: ${JSON.stringify(st.err, (_, x) => (typeof x === "bigint" ? x.toString() : x))}`);
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return sig;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`Transaction ${sig} was not confirmed`);
}

const TOKEN_PROGRAMS = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"];
const addrEnc = getAddressEncoder();

/**
 * The owner's associated token account for a mint (classic SPL Token or Token-2022), read directly. A
 * getTokenAccountsByOwner search would be forwarded by the fork to its mainnet datasource, which rate-limits it.
 */
async function ownTokenAccount(owner: string, mint: string): Promise<{ address: string; uiAmount: number } | null> {
  const keys = await Promise.all(
    TOKEN_PROGRAMS.map(async (program) => (await getProgramDerivedAddress({
      programAddress: address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
      seeds: [addrEnc.encode(address(owner)), addrEnc.encode(address(program)), addrEnc.encode(address(mint))],
    }))[0]),
  );
  const { value } = await rpc.getMultipleAccounts(keys, { encoding: "jsonParsed" }).send();
  for (let i = 0; i < keys.length; i++) {
    const acc = value[i];
    if (!acc || String(acc.owner) !== TOKEN_PROGRAMS[i]) continue;
    const info = (acc.data as unknown as { parsed?: { info?: { mint?: string; tokenAmount?: { uiAmount: number | null } } } }).parsed?.info;
    if (info?.mint === mint) return { address: keys[i]!, uiAmount: info.tokenAmount?.uiAmount ?? 0 };
  }
  return null;
}

export async function tokenBalance(owner: string, mint: string): Promise<number> {
  return (await ownTokenAccount(owner, mint))?.uiAmount ?? 0;
}

export async function tokenAccount(owner: string, mint: string): Promise<string | null> {
  return (await ownTokenAccount(owner, mint))?.address ?? null;
}
