/**
 * Read-only portfolio mirror. A real wallet's public balances are read from mainnet (public data; the
 * wallet never signs anything) and copied onto a burner key on the fork, so the user can try FORGE with
 * their own portfolio while every transaction is signed by the burner and stays on the fork.
 *
 * Mirrored: native SOL (put into wrapped SOL, the form the markets trade, keeping a little for fees)
 * and the base and quote token of every listed market. Nothing else.
 */
import { type Address, type Instruction, type KeyPairSigner, type Rpc, type SolanaRpcApi } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { getCreateAssociatedTokenIdempotentInstructionAsync, getSyncNativeInstruction } from "@solana-program/token";
import { ata } from "./env.js";
import { airdrop, sendInstructions, setTokenBalance, WSOL } from "./surfnet.js";

const MAINNET_RPC = process.env.MAINNET_RPC_URL ?? process.env.FORK_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const SPL_TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const FEE_SOL = 0.05; // left as native SOL on the burner for transaction fees and rent

async function mainnet<T>(method: string, params: unknown[]): Promise<T> {
  const r = await fetch(MAINNET_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  const j = (await r.json()) as { result?: T; error?: { message: string } };
  if (j.error || j.result === undefined) throw new Error(`mainnet ${method}: ${j.error?.message ?? r.status}`);
  return j.result;
}

export type MirrorToken = { symbol: string; mint: string; decimals: number; raw: bigint };

/** The owner's mainnet balances of SOL and the given mints (atoms). */
export async function readMainnetBalances(owner: Address, mints: { symbol: string; mint: string; decimals: number }[]) {
  const [{ value: lamports }, { value: accounts }] = await Promise.all([
    mainnet<{ value: number }>("getBalance", [owner, { commitment: "confirmed" }]),
    mainnet<{ value: { account: { data: { parsed: { info: { mint: string; tokenAmount: { amount: string } } } } } }[] }>("getTokenAccountsByOwner", [
      owner,
      { programId: SPL_TOKEN },
      { encoding: "jsonParsed", commitment: "confirmed" },
    ]),
  ]);
  const held = new Map<string, bigint>();
  for (const a of accounts) {
    const { mint, tokenAmount } = a.account.data.parsed.info;
    held.set(mint, (held.get(mint) ?? 0n) + BigInt(tokenAmount.amount));
  }
  const tokens: MirrorToken[] = mints.map((m) => ({ ...m, raw: held.get(m.mint) ?? 0n }));
  return { lamports: BigInt(lamports), tokens };
}

/** Give `burner` the owner's balances on the fork. `payer` funds the wrapped-SOL deposit. */
export async function mirrorOnto(rpc: Rpc<SolanaRpcApi>, payer: KeyPairSigner, burner: Address, bal: Awaited<ReturnType<typeof readMainnetBalances>>) {
  const feeLamports = BigInt(FEE_SOL * 1e9);
  const wsolFromNative = bal.lamports > feeLamports ? bal.lamports - feeLamports : 0n;
  const wsolHeld = bal.tokens.find((t) => t.mint === WSOL)?.raw ?? 0n;
  const wrap = wsolFromNative + wsolHeld;
  await airdrop(rpc, burner, FEE_SOL);
  // Wrapped SOL needs real lamports behind it: wrap only what is missing (a re-sync must not add on top),
  // and lower the balance directly if the real wallet now holds less.
  const wsolAta = await ata(burner, WSOL);
  let current = 0n;
  try {
    current = BigInt((await rpc.getTokenAccountBalance(wsolAta).send()).value.amount);
  } catch {
    /* no wrapped SOL account yet */
  }
  if (wrap > current) {
    const add = wrap - current;
    await airdrop(rpc, payer.address, Number(add) / 1e9 + 1);
    const ixs: Instruction[] = [
      await getCreateAssociatedTokenIdempotentInstructionAsync({ payer, owner: burner, mint: WSOL }),
      getTransferSolInstruction({ source: payer, destination: wsolAta, amount: add }),
      getSyncNativeInstruction({ account: wsolAta }),
    ];
    await sendInstructions(rpc, payer, ixs);
  } else if (wrap < current) {
    await setTokenBalance(burner, WSOL, wrap);
  }
  for (const t of bal.tokens) if (t.mint !== WSOL) await setTokenBalance(burner, t.mint as Address, t.raw);
  const out: Record<string, number> = { SOL: Number(wrap) / 1e9 };
  for (const t of bal.tokens) if (t.mint !== WSOL) out[t.symbol] = Number(t.raw) / 10 ** t.decimals;
  return out;
}
