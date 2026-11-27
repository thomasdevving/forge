/**
 * Helpers for talking to a Surfpool fork: RPC clients, cheatcodes, and transaction sending.
 * Cheatcodes only exist on the private fork; the public demo endpoint blocks them.
 */
import {
  addSignersToTransactionMessage,
  appendTransactionMessageInstructions,
  type Address,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  type Instruction,
  lamports,
  pipe,
  type Rpc,
  type SolanaRpcApi,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type TransactionSigner,
} from "@solana/kit";

export const FORK_RPC_URL = process.env.FORK_RPC_URL_LOCAL ?? "http://127.0.0.1:8899";
export const FORK_WS_URL = process.env.FORK_WS_URL_LOCAL ?? "ws://127.0.0.1:8900";

export const WSOL = "So11111111111111111111111111111111111111112" as Address;
export const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as Address;
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
export const WHIRLPOOL_PROGRAM = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc" as Address;
export const SOL_USDC_TS4 = "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE" as Address;
export const SOL_USDC_TS64 = "HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ" as Address;

export function forkRpc(url = FORK_RPC_URL): Rpc<SolanaRpcApi> {
  return createSolanaRpc(url);
}

export function forkSubscriptions(url = FORK_WS_URL) {
  return createSolanaRpcSubscriptions(url);
}

let rpcId = 0;
/** Call a Surfpool JSON-RPC method (cheatcode or standard) and return its result. */
export async function rawRpc<T = unknown>(method: string, params: unknown[], url = FORK_RPC_URL): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: { message: string; code: number } };
  if (body.error) throw new Error(`${method} failed: ${body.error.message} (${body.error.code})`);
  return body.result as T;
}

/** Assert we are talking to a Surfpool fork, never to a real cluster. */
export async function assertFork(url = FORK_RPC_URL): Promise<string> {
  const v = await rawRpc<Record<string, string>>("getVersion", [], url);
  const surf = v["surfnet-version"];
  if (!surf) throw new Error(`refusing to run: ${url} is not a Surfpool fork`);
  return surf;
}

/** Fund a fork wallet with SOL. Uses the cheatcode so large fork-only balances don't drain
 *  the local faucet; adds to any existing balance. */
export async function airdrop(rpc: Rpc<SolanaRpcApi>, to: Address, sol: number): Promise<void> {
  const { value: current } = await rpc.getBalance(to).send();
  const add = BigInt(Math.round(sol * 1e9));
  await rawRpc("surfnet_setAccount", [to, { lamports: Number(current + add) }]);
  void lamports;
}

/** Set an SPL token balance for `owner` on the fork (creates the ATA if needed). */
export async function setTokenBalance(owner: Address, mint: Address, amount: bigint): Promise<void> {
  await rawRpc("surfnet_setTokenAccount", [owner, mint, { amount: Number(amount), state: "initialized" }]);
}

/** The fork's on-chain clock (Clock sysvar), which time travel moves ahead of wall time. */
export async function forkClock(url = FORK_RPC_URL): Promise<{ unixTimestamp: number; slot: bigint }> {
  const r = await rawRpc<{ value: { data: [string, string] } }>("getAccountInfo", ["SysvarC1ock11111111111111111111111111111111", { encoding: "base64" }], url);
  const b = Buffer.from(r.value.data[0], "base64");
  return { slot: b.readBigUInt64LE(0), unixTimestamp: Number(b.readBigInt64LE(32)) };
}

/** Move the fork clock forward by `seconds` (fork-only cheatcode). */
export async function timeTravel(seconds: number): Promise<number> {
  const now = (await forkClock()).unixTimestamp;
  await rawRpc("surfnet_timeTravel", [{ absoluteTimestamp: (now + seconds) * 1000 }]);
  for (let i = 0; i < 40; i++) {
    const c = await forkClock();
    if (c.unixTimestamp >= now + seconds) return c.unixTimestamp;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("time travel did not take effect");
}

export async function sendInstructions(
  rpc: Rpc<SolanaRpcApi>,
  payer: TransactionSigner,
  instructions: readonly Instruction[],
  extraSigners: readonly TransactionSigner[] = [],
): Promise<string> {
  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
    (m) => addSignersToTransactionMessage([...extraSigners], m),
  );
  const tx = await signTransactionMessageWithSigners(msg);
  const sig = getSignatureFromTransaction(tx);
  await rpc
    .sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: "base64", preflightCommitment: "confirmed" })
    .send();
  for (let i = 0; i < 60; i++) {
    const { value } = await rpc.getSignatureStatuses([sig]).send();
    const st = value[0];
    if (st?.err) throw new Error(`transaction ${sig} failed: ${JSON.stringify(st.err, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return sig;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`transaction ${sig} not confirmed`);
}

export async function tokenBalance(rpc: Rpc<SolanaRpcApi>, account: Address): Promise<bigint> {
  try {
    const { value } = await rpc.getTokenAccountBalance(account).send();
    return BigInt(value.amount);
  } catch {
    return 0n;
  }
}

export async function rawAccount(rpc: Rpc<SolanaRpcApi>, addr: Address): Promise<string | null> {
  const { value } = await rpc.getAccountInfo(addr, { encoding: "base64" }).send();
  return value ? value.data[0] : null;
}
