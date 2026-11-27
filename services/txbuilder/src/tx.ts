/**
 * Transaction preparation under the runtime limits of section 8.5: v0 messages compressed with
 * market lookup tables, compute sized by simulation, and size/account limits enforced before
 * the user signs. A transaction that does not fit is refused, never forced.
 */
import {
  type Address,
  appendTransactionMessageInstructions,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  type Instruction,
  pipe,
  type Rpc,
  setTransactionMessageFeePayer,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type SolanaRpcApi,
  type TransactionSigner,
} from "@solana/kit";
import { fetchAddressLookupTable } from "@solana-program/address-lookup-table";
import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";
import { errorName } from "./idl.js";
import { FORGE_PROGRAM_ID } from "./program.js";

export const LIMITS = {
  maxTransactionBytes: 1232,
  maxLoadedAccounts: 64,
  maxComputeUnits: 1_400_000,
  targetComputeUnits: 1_100_000,
  computeMarginBps: 1_500,
} as const;

export class TransactionLimitError extends Error {}
export class SimulationError extends Error {
  constructor(message: string, public logs: string[], public code?: number, public codeName?: string) {
    super(message);
  }
}

export async function loadLookupTables(rpc: Rpc<SolanaRpcApi>, alts: Address[]): Promise<Record<Address, Address[]>> {
  const out: Record<Address, Address[]> = {};
  for (const a of alts) {
    const t = await fetchAddressLookupTable(rpc, a);
    out[a] = [...t.data.addresses];
  }
  return out;
}

function build(payer: TransactionSigner | Address, ixs: Instruction[], blockhash: { blockhash: string; lastValidBlockHeight: bigint }, cu: number, tables: Record<Address, Address[]>) {
  const base = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => (typeof payer === "string" ? setTransactionMessageFeePayer(payer, m) : setTransactionMessageFeePayerSigner(payer, m)),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash as Parameters<typeof setTransactionMessageLifetimeUsingBlockhash>[0], m),
    (m) => appendTransactionMessageInstructions([getSetComputeUnitLimitInstruction({ units: cu }), ...ixs], m),
  );
  return Object.keys(tables).length ? compressTransactionMessageUsingAddressLookupTables(base, tables) : base;
}

function measure(msg: ReturnType<typeof build>) {
  const tx = compileTransaction(msg);
  const wire = getBase64EncodedWireTransaction(tx);
  const bytes = Buffer.from(wire, "base64").length;
  const staticAccounts = msg.instructions.flatMap((i) => (i.accounts ?? []).map((a) => a.address));
  const loaded = new Set([String(typeof msg.feePayer === "object" ? msg.feePayer.address : msg.feePayer), ...staticAccounts.map(String), ...msg.instructions.map((i) => String(i.programAddress))]);
  return { wire, bytes, loadedAccounts: loaded.size };
}

export type Prepared = {
  message: ReturnType<typeof build>;
  unitsConsumed: number;
  computeUnitLimit: number;
  bytes: number;
  loadedAccounts: number;
  logs: string[];
};

/** Simulate, size compute, and enforce limits. Throws SimulationError with the program error name. */
export async function prepareTransaction(
  rpc: Rpc<SolanaRpcApi>,
  payer: TransactionSigner | Address,
  ixs: Instruction[],
  lookupTables: Record<Address, Address[]> = {},
): Promise<Prepared> {
  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  const probe = build(payer, ixs, blockhash, LIMITS.maxComputeUnits, lookupTables);
  const m0 = measure(probe);
  if (m0.bytes > LIMITS.maxTransactionBytes) {
    throw new TransactionLimitError(`transaction is ${m0.bytes} bytes (limit ${LIMITS.maxTransactionBytes}); split into more batches`);
  }
  if (m0.loadedAccounts > LIMITS.maxLoadedAccounts) {
    throw new TransactionLimitError(`transaction loads ${m0.loadedAccounts} accounts (limit ${LIMITS.maxLoadedAccounts})`);
  }
  const sim = await rpc
    .simulateTransaction(m0.wire as Parameters<SolanaRpcApi["simulateTransaction"]>[0], {
      encoding: "base64",
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: "confirmed",
    })
    .send();
  const logs = sim.value.logs ? [...sim.value.logs] : [];
  if (sim.value.err) {
    const err = sim.value.err as unknown as { InstructionError?: [number, { Custom?: number } | string] };
    const rawCustom = Array.isArray(err.InstructionError) && typeof err.InstructionError[1] === "object" ? err.InstructionError[1].Custom : undefined;
    const custom = rawCustom === undefined ? undefined : Number(rawCustom);
    // Orca is also an Anchor program, so custom codes overlap: name the error only when the
    // failing program in the logs is FORGE itself.
    const failed = [...logs].reverse().find((l) => / failed: /.test(l));
    const failingProgram = failed?.match(/^Program (\S+) failed/)?.[1];
    const name = custom !== undefined && failingProgram === String(FORGE_PROGRAM_ID)
      ? errorName(custom)
      : custom !== undefined && failingProgram ? `${failingProgram}:${custom}` : undefined;
    throw new SimulationError(
      `simulation failed: ${name ?? JSON.stringify(sim.value.err, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`,
      logs,
      custom,
      name,
    );
  }
  const units = Number(sim.value.unitsConsumed ?? 0n);
  if (units > LIMITS.targetComputeUnits) {
    throw new TransactionLimitError(`simulated ${units} CU exceeds the ${LIMITS.targetComputeUnits} CU target; split into more batches`);
  }
  const limit = Math.min(Math.ceil((units * (10_000 + LIMITS.computeMarginBps)) / 10_000), LIMITS.maxComputeUnits);
  const message = build(payer, ixs, blockhash, limit, lookupTables);
  const m1 = measure(message);
  return { message, unitsConsumed: units, computeUnitLimit: limit, bytes: m1.bytes, loadedAccounts: m1.loadedAccounts, logs };
}
