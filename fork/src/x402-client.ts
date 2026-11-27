/**
 * x402 V2 client for FORGE's paid endpoints ("exact" scheme on SVM, settled on the FORGE Surfpool fork).
 *
 *   import { fetchWithPayment } from "@forge/fork/x402-client";
 *   const { response, settlement } = await fetchWithPayment(
 *     "https://<gateway>/x402/compile",
 *     { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req) },
 *     signer,                                  // any @solana/kit TransactionSigner holding fork USDC
 *     { maxAtomicPerRequest: 10_000n },        // hard cap, checked BEFORE anything is signed
 *   );
 *
 * On a 402 the helper picks the `exact` requirement for the FORGE fork network, refuses if the price is
 * above the cap, builds [SetComputeUnitLimit, SetComputeUnitPrice, TransferChecked, Memo(challenge)]
 * with the server's facilitator as fee payer, partially signs it (only the payer's signature), and
 * retries once with the PAYMENT-SIGNATURE header. The payer needs fork USDC but no SOL.
 *
 * The request body must be re-sendable (string or bytes) and byte-identical on the retry: the
 * challenge in the memo is bound to it. If the paid work fails after settlement (5xx with a receipt),
 * call `retryWithPayment` with the returned `paymentHeader`: the server serves it again without a
 * second charge within its retry window.
 *
 * Dependencies: @solana/kit and the @solana-program/* packages only. Fork-only: never point a signer
 * holding real funds at this.
 */
import {
  address,
  type Address,
  appendTransactionMessageInstructions,
  type Blockhash,
  createNoopSigner,
  createTransactionMessage,
  getBase64Decoder,
  getBase64Encoder,
  getBase64EncodedWireTransaction,
  getUtf8Decoder,
  getUtf8Encoder,
  type Instruction,
  partiallySignTransactionMessageWithSigners,
  pipe,
  type Rpc,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type GetLatestBlockhashApi,
  type TransactionSigner,
} from "@solana/kit";
import { getSetComputeUnitLimitInstruction, getSetComputeUnitPriceInstruction } from "@solana-program/compute-budget";
import { findAssociatedTokenPda, getTransferCheckedInstruction, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";

export const X402_VERSION = 2;
/** Custom CAIP-2 style id for the FORGE Surfpool fork. Deliberately not the mainnet genesis id. */
export const FORGE_X402_NETWORK = "solana:forge-surfpool";
export const FORK_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as Address;
export const MEMO_PROGRAM_ADDRESS = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr" as Address;
export const HEADER_PAYMENT_REQUIRED = "PAYMENT-REQUIRED";
export const HEADER_PAYMENT_SIGNATURE = "PAYMENT-SIGNATURE";
export const HEADER_PAYMENT_RESPONSE = "PAYMENT-RESPONSE";
/** Compute budget the helper requests; the server caps both. */
export const CLIENT_COMPUTE_UNIT_LIMIT = 50_000;
export const CLIENT_COMPUTE_UNIT_PRICE = 1n;

export type ResourceInfo = { url: string; description?: string; mimeType?: string; serviceName?: string };
export type PaymentRequirements = {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: {
    feePayer?: string;
    memo?: string;
    recentBlockhash?: string;
    lastValidBlockHeight?: string;
    decimals?: number;
    paymentFlow?: string;
    [k: string]: unknown;
  };
};
export type PaymentRequired = {
  x402Version: number;
  error?: string;
  resource: ResourceInfo;
  accepts: PaymentRequirements[];
  extensions?: Record<string, unknown>;
};
export type PaymentPayload = {
  x402Version: number;
  resource?: ResourceInfo;
  accepted: PaymentRequirements;
  payload: { transaction: string };
  extensions?: Record<string, unknown>;
};
export type SettlementResponse = {
  success: boolean;
  errorReason?: string;
  payer?: string;
  transaction: string;
  network: string;
  amount?: string;
  extensions?: Record<string, unknown>;
};

export class X402ClientError extends Error {
  constructor(public code: "price_over_cap" | "no_acceptable_requirement" | "payment_declined" | "malformed_402" | "no_blockhash", message: string) {
    super(message);
  }
}

// ---- base64 JSON header codec (UTF-8 safe, no Buffer/btoa dependency) ----
export function encodeHeader(value: unknown): string {
  return getBase64Decoder().decode(getUtf8Encoder().encode(JSON.stringify(value)));
}
export function decodeHeader<T>(value: string): T {
  return JSON.parse(getUtf8Decoder().decode(getBase64Encoder().encode(value.trim()))) as T;
}

export function memoInstruction(text: string): Instruction {
  return { programAddress: MEMO_PROGRAM_ADDRESS, accounts: [], data: getUtf8Encoder().encode(text) };
}

/** The standard payment instructions for a requirement: compute budget, TransferChecked, Memo. */
export async function paymentInstructions(req: PaymentRequirements, signer: TransactionSigner): Promise<Instruction[]> {
  const mint = address(req.asset);
  const [source] = await findAssociatedTokenPda({ owner: signer.address, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const [destination] = await findAssociatedTokenPda({ owner: address(req.payTo), mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const memo = req.extra?.memo;
  if (!memo) throw new X402ClientError("malformed_402", "requirement has no extra.memo challenge");
  return [
    getSetComputeUnitLimitInstruction({ units: CLIENT_COMPUTE_UNIT_LIMIT }),
    getSetComputeUnitPriceInstruction({ microLamports: CLIENT_COMPUTE_UNIT_PRICE }),
    getTransferCheckedInstruction({ source, mint, destination, authority: signer, amount: BigInt(req.amount), decimals: req.extra?.decimals ?? 6 }),
    memoInstruction(memo),
  ];
}

/** Build and partially sign (payer only; the facilitator signs as fee payer at settlement). */
export async function buildPaymentTransaction(
  req: PaymentRequirements,
  signer: TransactionSigner,
  opts: { instructions?: Instruction[]; rpc?: Rpc<GetLatestBlockhashApi> } = {},
): Promise<string> {
  const feePayer = req.extra?.feePayer;
  if (!feePayer) throw new X402ClientError("malformed_402", "requirement has no extra.feePayer");
  let lifetime: { blockhash: Blockhash; lastValidBlockHeight: bigint } | undefined;
  if (req.extra?.recentBlockhash && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(req.extra.recentBlockhash)) {
    lifetime = { blockhash: req.extra.recentBlockhash as Blockhash, lastValidBlockHeight: BigInt(req.extra.lastValidBlockHeight ?? "0") };
  } else if (opts.rpc) {
    lifetime = (await opts.rpc.getLatestBlockhash().send()).value;
  }
  if (!lifetime) throw new X402ClientError("no_blockhash", "no recentBlockhash in the requirement and no rpc given");
  const ixs = opts.instructions ?? (await paymentInstructions(req, signer));
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(createNoopSigner(address(feePayer)), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  const tx = await partiallySignTransactionMessageWithSigners(msg);
  return getBase64EncodedWireTransaction(tx);
}

export function paymentHeaderFor(pr: PaymentRequired, accepted: PaymentRequirements, transaction: string): string {
  const payload: PaymentPayload = { x402Version: X402_VERSION, resource: pr.resource, accepted, payload: { transaction } };
  return encodeHeader(payload);
}

export async function readPaymentRequired(res: Response): Promise<PaymentRequired> {
  const h = res.headers.get(HEADER_PAYMENT_REQUIRED);
  try {
    if (h) return decodeHeader<PaymentRequired>(h);
    return (await res.clone().json()) as PaymentRequired;
  } catch {
    throw new X402ClientError("malformed_402", "402 without a readable PAYMENT-REQUIRED header");
  }
}

export function readSettlement(res: Response): SettlementResponse | null {
  const h = res.headers.get(HEADER_PAYMENT_RESPONSE);
  if (!h) return null;
  try {
    return decodeHeader<SettlementResponse>(h);
  } catch {
    return null;
  }
}

export type PaymentEvent = { url: string; requirement: PaymentRequirements; amount: bigint; payTo: string; challenge: string };

export type FetchWithPaymentOptions = {
  /** Hard cap in atomic units of the asset (USDC: 6 decimals). A higher price is refused before signing. */
  maxAtomicPerRequest: bigint | number | string;
  /** Called after the cap check and before signing; return false to decline the payment. */
  onPayment?: (p: PaymentEvent) => boolean | void | Promise<boolean | void>;
  /** Network to accept (default the FORGE fork). */
  network?: string;
  /** Asset mint to accept (default the fork's USDC). */
  asset?: string;
  /** Only needed if the server gives no recentBlockhash. */
  rpc?: Rpc<GetLatestBlockhashApi>;
  fetch?: typeof fetch;
};

export type FetchWithPaymentResult = {
  response: Response;
  /** Decoded PAYMENT-RESPONSE (null when no payment was needed). */
  settlement: SettlementResponse | null;
  paid: boolean;
  /** The PAYMENT-SIGNATURE value sent; reuse it with `retryWithPayment` if the paid work failed. */
  paymentHeader?: string;
  requirement?: PaymentRequirements;
};

function withHeader(init: RequestInit, name: string, value: string): RequestInit {
  const headers = new Headers(init.headers);
  headers.set(name, value);
  return { ...init, headers };
}

export async function fetchWithPayment(url: string, init: RequestInit, signer: TransactionSigner, opts: FetchWithPaymentOptions): Promise<FetchWithPaymentResult> {
  const f = opts.fetch ?? fetch;
  const first = await f(url, init);
  if (first.status !== 402) return { response: first, settlement: readSettlement(first), paid: false };

  const pr = await readPaymentRequired(first);
  if (pr.x402Version !== X402_VERSION) throw new X402ClientError("malformed_402", `unsupported x402Version ${pr.x402Version}`);
  const network = opts.network ?? FORGE_X402_NETWORK;
  const asset = opts.asset ?? FORK_USDC_MINT;
  const known = new Set([undefined, "authorization", "upfront"]);
  const req = pr.accepts.find((a) => a.scheme === "exact" && a.network === network && a.asset === asset && known.has(a.extra?.paymentFlow));
  if (!req) throw new X402ClientError("no_acceptable_requirement", `no exact/${network}/${asset} requirement offered`);

  // the cap is checked before anything is signed
  const amount = BigInt(req.amount);
  const cap = BigInt(opts.maxAtomicPerRequest);
  if (amount < 0n || amount > cap) throw new X402ClientError("price_over_cap", `price ${amount} exceeds cap ${cap}`);

  const event: PaymentEvent = { url, requirement: req, amount, payTo: req.payTo, challenge: req.extra?.memo ?? "" };
  if (opts.onPayment && (await opts.onPayment(event)) === false) throw new X402ClientError("payment_declined", "onPayment declined");

  const transaction = await buildPaymentTransaction(req, signer, { rpc: opts.rpc });
  const paymentHeader = paymentHeaderFor(pr, req, transaction);
  const response = await f(url, withHeader(init, HEADER_PAYMENT_SIGNATURE, paymentHeader));
  return { response, settlement: readSettlement(response), paid: true, paymentHeader, requirement: req };
}

/** Resend a request with a payment that already settled (e.g. the paid work failed); not charged again. */
export async function retryWithPayment(url: string, init: RequestInit, paymentHeader: string, f: typeof fetch = fetch) {
  const response = await f(url, withHeader(init, HEADER_PAYMENT_SIGNATURE, paymentHeader));
  return { response, settlement: readSettlement(response) };
}
