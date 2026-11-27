/**
 * Helpers for talking to a Surfpool fork: RPC clients, cheatcodes, and transaction sending.
 * Cheatcodes only exist on the private fork; the public demo endpoint blocks them.
 */
import {
  addSignersToTransactionMessage,
  appendTransactionMessageInstructions,
  type Address,
  assertIsTransactionWithBlockhashLifetime,
  createDefaultRpcTransport,
  createJsonRpcApi,
  createRpc,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  getBase64Encoder,
  getI64Decoder,
  getSignatureFromTransaction,
  getStructDecoder,
  getU64Decoder,
  type Instruction,
  pipe,
  type Rpc,
  type SolanaRpcApi,
  sendAndConfirmTransactionFactory,
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

/**
 * Surfpool's cheatcodes as a typed @solana/kit RPC API: the same `createRpc` machinery as the
 * Solana API (transport, request shaping, `.send()`), extended with the fork-only methods.
 */
type AccountUpdate = { lamports?: number; data?: string; owner?: Address; executable?: boolean; rent_epoch?: number };
type TokenAccountUpdate = { amount?: number; state?: "initialized" | "frozen"; delegate?: Address | null; delegated_amount?: number; close_authority?: Address | null };
export type SurfnetCheatcodesApi = {
  surfnet_setAccount(pubkey: Address, update: AccountUpdate): unknown;
  surfnet_setTokenAccount(owner: Address, mint: Address, update: TokenAccountUpdate, tokenProgram?: Address): unknown;
  surfnet_timeTravel(config: { absoluteTimestamp?: number; absoluteSlot?: number; absoluteEpoch?: number }): unknown;
  surfnet_getSurfnetInfo(): unknown;
};

export function surfnetRpc(url = FORK_RPC_URL): Rpc<SurfnetCheatcodesApi> {
  return createRpc({
    api: createJsonRpcApi<SurfnetCheatcodesApi>({
      // unwrap the JSON-RPC envelope and surface errors, as kit's Solana API does
      responseTransformer: (response) => {
        const r = response as { result?: unknown; error?: { code: number; message: string } };
        if (r.error) throw new Error(`surfnet cheatcode failed: ${r.error.message} (${r.error.code})`);
        return r.result as never;
      },
    }),
    transport: createDefaultRpcTransport({ url }),
  });
}

const cheats = surfnetRpc();

let rpcId = 0;
/** Escape hatch for a JSON-RPC method with no typed wrapper (prefer forkRpc() and surfnetRpc()). */
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
  const v = (await createSolanaRpc(url).getVersion().send()) as unknown as Record<string, string>;
  const surf = v["surfnet-version"];
  if (!surf) throw new Error(`refusing to run: ${url} is not a Surfpool fork`);
  return surf;
}

/** Fund a fork wallet with SOL. Uses the cheatcode so large fork-only balances don't drain
 *  the local faucet; adds to any existing balance. */
export async function airdrop(rpc: Rpc<SolanaRpcApi>, to: Address, sol: number): Promise<void> {
  const { value: current } = await rpc.getBalance(to).send();
  const add = BigInt(Math.round(sol * 1e9));
  await cheats.surfnet_setAccount(to, { lamports: Number(current + add) }).send();
}

/** Set an SPL token balance for `owner` on the fork (creates the ATA if needed). */
export async function setTokenBalance(owner: Address, mint: Address, amount: bigint): Promise<void> {
  await cheats.surfnet_setTokenAccount(owner, mint, { amount: Number(amount), state: "initialized" }).send();
}

/** The Clock sysvar's layout, decoded with kit codecs. */
const clockDecoder = getStructDecoder([
  ["slot", getU64Decoder()],
  ["epochStartTimestamp", getI64Decoder()],
  ["epoch", getU64Decoder()],
  ["leaderScheduleEpoch", getU64Decoder()],
  ["unixTimestamp", getI64Decoder()],
]);
const CLOCK_SYSVAR = "SysvarC1ock11111111111111111111111111111111" as Address;

/** The fork's on-chain clock (Clock sysvar), which time travel moves ahead of wall time. */
export async function forkClock(url = FORK_RPC_URL): Promise<{ unixTimestamp: number; slot: bigint }> {
  const { value } = await createSolanaRpc(url).getAccountInfo(CLOCK_SYSVAR, { encoding: "base64" }).send();
  if (!value) throw new Error("Clock sysvar not found");
  const c = clockDecoder.decode(getBase64Encoder().encode(value.data[0]));
  return { slot: c.slot, unixTimestamp: Number(c.unixTimestamp) };
}

/** Move the fork clock forward by `seconds` (fork-only cheatcode). */
export async function timeTravel(seconds: number): Promise<number> {
  const now = (await forkClock()).unixTimestamp;
  await cheats.surfnet_timeTravel({ absoluteTimestamp: (now + seconds) * 1000 }).send();
  for (let i = 0; i < 40; i++) {
    const c = await forkClock();
    if (c.unixTimestamp >= now + seconds) return c.unixTimestamp;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("time travel did not take effect");
}

/**
 * Build, sign, send and confirm a v0 transaction. Confirmation uses kit's
 * sendAndConfirmTransactionFactory: a signature subscription raced against block-height expiry of
 * the blockhash, instead of polling.
 */
export async function sendInstructions(
  rpc: Rpc<SolanaRpcApi>,
  payer: TransactionSigner,
  instructions: readonly Instruction[],
  extraSigners: readonly TransactionSigner[] = [],
): Promise<string> {
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
    (m) => addSignersToTransactionMessage([...extraSigners], m),
  );
  const tx = await signTransactionMessageWithSigners(msg);
  assertIsTransactionWithBlockhashLifetime(tx);
  await sendAndConfirm(rpc)(tx, { commitment: "confirmed" });
  return getSignatureFromTransaction(tx);
}

const confirmers = new WeakMap<object, ReturnType<typeof sendAndConfirmTransactionFactory>>();
/** kit's send-and-confirm bound to this RPC and the fork's WebSocket subscriptions (one per RPC). */
export function sendAndConfirm(rpc: Rpc<SolanaRpcApi>, wsUrl = FORK_WS_URL): ReturnType<typeof sendAndConfirmTransactionFactory> {
  let f = confirmers.get(rpc);
  if (!f) {
    f = sendAndConfirmTransactionFactory({ rpc: rpc as never, rpcSubscriptions: forkSubscriptions(wsUrl) as never });
    confirmers.set(rpc, f);
  }
  return f;
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
