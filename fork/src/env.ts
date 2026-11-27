/** Keys, deployment state and wallet helpers for fork scripts. Keys live outside the repo. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Address, createKeyPairSignerFromBytes, type Instruction, type KeyPairSigner, type Rpc, type SolanaRpcApi } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getSyncNativeInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { airdrop, sendInstructions, setTokenBalance, WSOL } from "./surfnet.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, "../..");
export const STATE_DIR = resolve(HERE, "../.state");
export const DEPLOYMENT_FILE = resolve(STATE_DIR, "deployment.json");

const KEY_DIR = process.env.FORGE_KEY_DIR ?? resolve(homedir(), ".config/solana");

export async function loadKey(name: string): Promise<KeyPairSigner> {
  const path = process.env[`FORGE_${name.toUpperCase().replace(/-/g, "_")}_KEYPAIR`] ?? resolve(KEY_DIR, `forge-${name}.json`);
  if (!existsSync(path)) throw new Error(`missing keypair ${path} (see .env.example)`);
  return createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(readFileSync(path, "utf8"))));
}

export type Deployment = {
  programId: Address;
  cluster: "surfpool-fork";
  genesisNote: string;
  admin: Address;
  referenceSigner: Address;
  markets: Record<string, {
    market: Address;
    whirlpool: Address;
    swapPool: Address;
    baseMint: Address;
    quoteMint: Address;
    referenceKind: "PythPair" | "ForkScenario";
    referenceBase: Address;
    referenceQuote: Address;
    /** present for markets bootstrapped after multi-market support; SOL/USDC defaults apply otherwise */
    baseDecimals?: number;
    quoteDecimals?: number;
    feedBase?: string;
    feedQuote?: string;
    buckets: { tickLower: number; tickUpper: number; address: Address }[];
    lookupTable: Address;
    scenarioPrice: number;
  }>;
};

export function readDeployment(): Deployment {
  if (!existsSync(DEPLOYMENT_FILE)) throw new Error("no deployment: run `pnpm --filter @forge/fork bootstrap` first");
  return JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8")) as Deployment;
}

export function writeDeployment(d: Deployment): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(DEPLOYMENT_FILE, JSON.stringify(d, null, 2) + "\n");
}

export async function ata(owner: Address, mint: Address): Promise<Address> {
  const [a] = await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  return a;
}

/** Fund a fork wallet with SOL, wrapped SOL and USDC (fork-only balances). */
export async function fundWallet(
  rpc: Rpc<SolanaRpcApi>,
  w: KeyPairSigner,
  opts: { sol?: number; wsol?: bigint; usdc?: bigint; usdcMint: Address; baseMint?: Address; base?: bigint },
): Promise<{ wsol: Address; usdc: Address; base: Address }> {
  // `base` funds any base token; wrapped SOL needs real lamports, every other mint is set directly.
  const baseMint = opts.baseMint ?? WSOL;
  const baseAmount = opts.base ?? opts.wsol ?? 0n;
  const wrap = baseMint === WSOL ? baseAmount : 0n;
  await airdrop(rpc, w.address, (opts.sol ?? 10) + Number(wrap) / 1e9);
  const wsol = await ata(w.address, WSOL);
  const usdc = await ata(w.address, opts.usdcMint);
  const ixs: Instruction[] = [await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: w, owner: w.address, mint: WSOL })];
  if (wrap > 0n) {
    ixs.push(getTransferSolInstruction({ source: w, destination: wsol, amount: wrap }), getSyncNativeInstruction({ account: wsol }));
  }
  await sendInstructions(rpc, w, ixs);
  if (opts.usdc !== undefined) await setTokenBalance(w.address, opts.usdcMint, opts.usdc);
  if (baseMint !== WSOL && baseAmount > 0n) await setTokenBalance(w.address, baseMint, baseAmount);
  const base = baseMint === WSOL ? wsol : await ata(w.address, baseMint);
  return { wsol: base, usdc, base };
}
