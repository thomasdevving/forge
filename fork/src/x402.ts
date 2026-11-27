/**
 * x402 V2 payment layer for FORGE, self-facilitated, "exact" scheme on SVM, settling on the Surfpool fork.
 * Mounted by the gateway under /x402 (see gateway.ts); also usable standalone (tests build it directly).
 *
 *   GET  /x402           discovery document (free)
 *   GET  /x402/markets   indexer /markets trimmed for agents (free)
 *   POST /x402/verify    compiler POST /verify (free)
 *   POST /x402/compile   compiler POST /compile          price X402_PRICE_COMPILE (default 10000 = 0.01 USDC)
 *   POST /x402/hedge     agent service POST /hedge       price X402_PRICE_HEDGE (provisional, default = compile)
 *
 * Paid flow ("upfront": settle, then work). An unpaid request gets 402 with a base64 PaymentRequired in
 * PAYMENT-REQUIRED. Its requirement carries a challenge id in `extra.memo`: random nonce + expiry + HMAC
 * over (method, path, sha256(body)). The client pays with a partially signed v0 transaction
 * [ComputeBudget limit/price, SPL Token TransferChecked, Memo(challenge)] whose fee payer is our
 * facilitator, and resends the same request with PAYMENT-SIGNATURE. We verify statically (network,
 * scheme, mint, amount, destination ATA, fee-payer isolation, instruction allowlist, compute caps,
 * challenge binding, client signature), co-sign as fee payer, simulate, send and wait for confirmation,
 * record the settlement (memory + append-only JSONL), and only then do the work. The response carries
 * PAYMENT-RESPONSE (base64 SettlementResponse).
 *
 * Replay: one settlement per challenge; a different payment for a settled challenge is never co-signed.
 * If the paid work fails (upstream 5xx or unreachable) the client gets 502 plus the receipt and may resend
 * the same request with the same PAYMENT-SIGNATURE within X402_RETRY_WINDOW_SECONDS (default 900): it is
 * served without a second charge. Once a paid request has been served, the payment is consumed.
 *
 * Fail closed: /x402 is enabled only if the settlement RPC answers the Surfpool-only, read-only
 * `surfnet_getSurfnetInfo` cheatcode and its URL is not a known public mainnet endpoint.
 * TEST ENVIRONMENT ONLY: fork USDC, fork keys, no real funds.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import http from "node:http";
import { dirname, resolve } from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import {
  type Address,
  createSolanaRpc,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getPublicKeyFromAddress,
  getSignatureFromTransaction,
  getTransactionDecoder,
  getUtf8Decoder,
  type KeyPairSigner,
  type Rpc,
  type SignatureBytes,
  type SolanaRpcApi,
  type Transaction,
  type TransactionWithinSizeLimit,
  type TransactionWithLifetime,
  verifySignature,
} from "@solana/kit";
import { COMPUTE_BUDGET_PROGRAM_ADDRESS } from "@solana-program/compute-budget";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { loadKey, STATE_DIR } from "./env.js";
import {
  decodeHeader,
  encodeHeader,
  FORGE_X402_NETWORK,
  FORK_USDC_MINT,
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
  HEADER_PAYMENT_SIGNATURE,
  MEMO_PROGRAM_ADDRESS,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
  type SettlementResponse,
  X402_VERSION,
} from "./x402-client.js";

export { FORGE_X402_NETWORK, FORK_USDC_MINT };
export const SURFPOOL_PROBE_METHOD = "surfnet_getSurfnetInfo";
const USDC_DECIMALS = 6;
const SERVICE_NAME = "FORGE fork (test, no real funds)"; // printable ASCII, <= 32 chars
const TEST_NOTE =
  "TEST ENVIRONMENT. Payments settle on a private Surfpool fork of Solana mainnet, not on mainnet. " +
  "The USDC here is fork-only (minted by cheatcode) and has no value; no real funds move. " +
  "The network id solana:forge-surfpool is deliberately not a real cluster id, so clients configured for mainnet refuse it.";

// ---------------------------------------------------------------- configuration

export type X402Config = {
  rpcUrl: string;
  compilerUrl: string;
  indexerUrl: string;
  agentUrl: string;
  secret: Buffer;
  priceCompile: bigint;
  priceHedge: bigint;
  hedgePriceProvisional: boolean;
  statePath: string;
  publicUrl?: string;
  challengeTtlSeconds: number;
  retryWindowSeconds: number;
  maxAttempts: number;
  upstreamTimeoutMs: number;
  confirmTimeoutMs: number;
  maxComputeUnits: number;
  maxMicroLamports: bigint;
  facilitator?: KeyPairSigner;
  treasury?: Address;
};

export function configFromEnv(env = process.env): X402Config {
  const priceCompile = BigInt(env.X402_PRICE_COMPILE ?? "10000");
  const keyDir = env.FORGE_KEY_DIR;
  return {
    rpcUrl: env.X402_RPC_URL ?? env.FORK_RPC_URL_LOCAL ?? "http://127.0.0.1:8899",
    compilerUrl: env.COMPILER_URL ?? "http://127.0.0.1:8000",
    indexerUrl: env.INDEXER_URL ?? "http://127.0.0.1:8787",
    agentUrl: env.AGENT_URL ?? "http://127.0.0.1:8792",
    secret: env.X402_SECRET ? Buffer.from(env.X402_SECRET, "utf8") : randomBytes(32),
    priceCompile,
    priceHedge: BigInt(env.X402_PRICE_HEDGE ?? priceCompile),
    hedgePriceProvisional: env.X402_HEDGE_PRICE_FINAL !== "1",
    statePath: env.X402_STATE_FILE ?? resolve(keyDir ?? STATE_DIR, "x402-settlements.jsonl"),
    publicUrl: env.X402_PUBLIC_URL,
    challengeTtlSeconds: Number(env.X402_CHALLENGE_TTL_SECONDS ?? 120),
    retryWindowSeconds: Number(env.X402_RETRY_WINDOW_SECONDS ?? 900),
    maxAttempts: Number(env.X402_MAX_ATTEMPTS ?? 5),
    upstreamTimeoutMs: Number(env.X402_UPSTREAM_TIMEOUT_MS ?? 600_000),
    confirmTimeoutMs: Number(env.X402_CONFIRM_TIMEOUT_MS ?? 30_000),
    maxComputeUnits: Number(env.X402_MAX_COMPUTE_UNITS ?? 200_000),
    maxMicroLamports: BigInt(env.X402_MAX_MICROLAMPORTS ?? 50_000),
  };
}

// ---------------------------------------------------------------- fail-closed settlement check

const MAINNET_HOSTS = [
  "api.mainnet-beta.solana.com",
  "api.mainnet.solana.com",
  "mainnet.helius-rpc.com",
  "solana-mainnet.g.alchemy.com",
  "rpc.ankr.com",
  "solana-rpc.publicnode.com",
  "solana.publicnode.com",
  "solana.drpc.org",
  "mainnet.rpcpool.com",
  "solana-api.projectserum.com",
];

/** Enable settlement only on a Surfpool fork that is not a known public mainnet endpoint. */
export async function checkSettlementRpc(url: string): Promise<{ ok: true; surfnetVersion: string } | { ok: false; reason: string }> {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return { ok: false, reason: `invalid settlement RPC URL` };
  }
  if (MAINNET_HOSTS.some((h) => host === h || host.endsWith(`.${h}`)) || /mainnet/.test(host)) {
    return { ok: false, reason: `settlement RPC host ${host} is a public mainnet endpoint` };
  }
  try {
    const call = async (method: string) => {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }),
        signal: AbortSignal.timeout(5_000),
      });
      return (await r.json()) as { result?: Record<string, unknown>; error?: { message: string } };
    };
    const probe = await call(SURFPOOL_PROBE_METHOD);
    if (probe.error || !probe.result) return { ok: false, reason: `settlement RPC does not answer ${SURFPOOL_PROBE_METHOD} (not a Surfpool fork)` };
    const v = await call("getVersion");
    return { ok: true, surfnetVersion: String(v.result?.["surfnet-version"] ?? "unknown") };
  } catch (e) {
    return { ok: false, reason: `settlement RPC unreachable: ${(e as Error).message}` };
  }
}

// ---------------------------------------------------------------- challenge binding

const sha256hex = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

function challengeMac(secret: Buffer, method: string, path: string, bodyHash: string, exp: number, nonce: string) {
  return createHmac("sha256", secret).update(`x402v2|${method}|${path}|${bodyHash}|${exp}|${nonce}`).digest("base64url");
}

export function issueChallenge(secret: Buffer, method: string, path: string, bodyHash: string, ttlSeconds: number) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const nonce = randomBytes(12).toString("hex");
  return { id: `forge-x402:${exp}:${nonce}:${challengeMac(secret, method, path, bodyHash, exp, nonce)}`, expiresAt: exp };
}

/** "bound": HMAC matches this method/path/body. "expired" is reported separately. */
export function checkChallenge(secret: Buffer, id: string, method: string, path: string, bodyHash: string): { bound: boolean; expired: boolean } {
  const m = /^forge-x402:(\d{1,12}):([0-9a-f]{24}):([A-Za-z0-9_-]{43})$/.exec(id);
  if (!m) return { bound: false, expired: false };
  const exp = Number(m[1]);
  const want = Buffer.from(challengeMac(secret, method, path, bodyHash, exp, m[2]!));
  const got = Buffer.from(m[3]!);
  const bound = want.length === got.length && timingSafeEqual(want, got);
  return { bound, expired: exp < Math.floor(Date.now() / 1000) };
}

// ---------------------------------------------------------------- settlement store

type SettlementRecord = {
  challenge: string;
  txSignature: string;
  clientSignature: string;
  payer: string;
  amount: string;
  method: string;
  path: string;
  bodyHash: string;
  settledAt: number;
  attempts: number;
  served: boolean;
};
type StoreEvent =
  | ({ type: "settled" } & Omit<SettlementRecord, "attempts" | "served">)
  | { type: "attempt"; challenge: string; at: number; ok: boolean };

/** Settled challenges and transaction signatures: in memory, plus an append-only JSONL file. */
export class SettlementStore {
  private byChallenge = new Map<string, SettlementRecord>();
  private txs = new Set<string>();
  constructor(private path: string, private keepSeconds: number) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (!existsSync(path)) return;
    const cutoff = Date.now() / 1000 - keepSeconds;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as StoreEvent;
        if (e.type === "settled") {
          this.txs.add(e.txSignature);
          if (e.settledAt >= cutoff) {
            const { type: _t, ...rec } = e;
            this.byChallenge.set(e.challenge, { ...rec, attempts: 0, served: false });
          }
        } else if (e.type === "attempt") {
          const r = this.byChallenge.get(e.challenge);
          if (r) {
            r.attempts++;
            r.served ||= e.ok;
          }
        }
      } catch {
        /* a torn last line is skipped */
      }
    }
  }
  private append(e: StoreEvent) {
    appendFileSync(this.path, JSON.stringify(e) + "\n", { mode: 0o600 });
  }
  get(challenge: string) {
    return this.byChallenge.get(challenge);
  }
  hasTx(sig: string) {
    return this.txs.has(sig);
  }
  settled(r: Omit<SettlementRecord, "attempts" | "served">) {
    this.append({ type: "settled", ...r });
    const cutoff = Date.now() / 1000 - this.keepSeconds; // older challenges have expired anyway
    for (const [k, v] of this.byChallenge) if (v.settledAt < cutoff) this.byChallenge.delete(k);
    this.byChallenge.set(r.challenge, { ...r, attempts: 0, served: false });
    this.txs.add(r.txSignature);
  }
  attempt(challenge: string, ok: boolean) {
    this.append({ type: "attempt", challenge, at: Math.floor(Date.now() / 1000), ok });
    const r = this.byChallenge.get(challenge);
    if (r) {
      r.attempts++;
      r.served ||= ok;
    }
  }
}

// ---------------------------------------------------------------- payment verification (static, pre-sign)

export class PaymentError extends Error {
  constructor(public reason: string, message: string, public status = 402) {
    super(message);
  }
}

type SignableTransaction = Transaction & TransactionWithinSizeLimit & TransactionWithLifetime;
type Verified = {
  tx: SignableTransaction;
  challenge: string;
  payer: Address;
  clientSignature: string;
  amount: bigint;
};

const u32le = (d: Uint8Array, o: number) => d[o]! | (d[o + 1]! << 8) | (d[o + 2]! << 16) | ((d[o + 3]! << 24) >>> 0);
const u64le = (d: Uint8Array, o: number) => {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(d[o + i]!);
  return v;
};

type Policy = {
  facilitator: Address;
  treasury: Address;
  treasuryAta: Address;
  price: bigint;
  maxComputeUnits: number;
  maxMicroLamports: bigint;
};

/** Decode and check a PaymentPayload transaction against the requirement. Throws PaymentError. */
export async function verifyPaymentTransaction(b64: string, p: Policy): Promise<Verified> {
  let tx: SignableTransaction;
  let msg: ReturnType<ReturnType<typeof getCompiledTransactionMessageDecoder>["decode"]>;
  try {
    tx = getTransactionDecoder().decode(getBase64Encoder().encode(b64)) as SignableTransaction;
    msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  } catch (e) {
    throw new PaymentError("invalid_payload", `transaction does not decode: ${(e as Error).message}`, 400);
  }
  if (msg.version !== 0 && msg.version !== "legacy") throw new PaymentError("invalid_exact_svm_payload_transaction_version", "only legacy or v0 transactions");
  if (msg.version === 0 && (msg.addressTableLookups?.length ?? 0) > 0) {
    throw new PaymentError("invalid_exact_svm_payload_address_lookup_tables", "address lookup tables are not accepted");
  }
  const keys = msg.staticAccounts;
  // fee payer is the facilitator
  if (keys[0] !== p.facilitator) throw new PaymentError("invalid_exact_svm_payload_fee_payer", "fee payer must be the facilitator (extra.feePayer)");

  let transfer: { source: Address; mint: Address; destination: Address; authority: Address; amount: bigint; decimals: number } | undefined;
  let transfers = 0, memos = 0, limits = 0, prices = 0;
  let memo: string | undefined;
  for (const ix of msg.instructions) {
    const program = keys[ix.programAddressIndex];
    const idx = ix.accountIndices ?? [];
    const data = (ix.data ?? new Uint8Array()) as Uint8Array;
    // fee-payer isolation: never a program, never in any instruction's accounts
    if (ix.programAddressIndex === 0 || idx.includes(0)) {
      throw new PaymentError("invalid_exact_svm_payload_fee_payer_isolation", "the facilitator may only pay fees; it appears in an instruction");
    }
    if (program === COMPUTE_BUDGET_PROGRAM_ADDRESS) {
      if (idx.length) throw new PaymentError("invalid_exact_svm_payload_compute_budget", "compute budget instruction with accounts");
      if (data[0] === 2 && data.length === 5) {
        if (++limits > 1 || u32le(data, 1) > p.maxComputeUnits) throw new PaymentError("invalid_exact_svm_payload_compute_budget", `compute unit limit above ${p.maxComputeUnits} or repeated`);
      } else if (data[0] === 3 && data.length === 9) {
        if (++prices > 1 || u64le(data, 1) > p.maxMicroLamports) throw new PaymentError("invalid_exact_svm_payload_compute_budget", `compute unit price above ${p.maxMicroLamports} micro-lamports or repeated`);
      } else {
        throw new PaymentError("invalid_exact_svm_payload_compute_budget", "only SetComputeUnitLimit and SetComputeUnitPrice are allowed");
      }
    } else if (program === TOKEN_PROGRAM_ADDRESS) {
      // TransferChecked: [source, mint, destination, authority], data = 12 | amount u64 | decimals u8
      if (data[0] !== 12 || data.length !== 10 || idx.length !== 4) {
        throw new PaymentError("invalid_exact_svm_payload_instruction_not_allowed", "only SPL Token TransferChecked (single authority) is allowed");
      }
      transfers++;
      transfer = { source: keys[idx[0]!]!, mint: keys[idx[1]!]!, destination: keys[idx[2]!]!, authority: keys[idx[3]!]!, amount: u64le(data, 1), decimals: data[9]! };
    } else if (program === MEMO_PROGRAM_ADDRESS) {
      if (idx.length) throw new PaymentError("invalid_exact_svm_payload_memo", "memo must not reference accounts");
      memos++;
      try {
        memo = new TextDecoder("utf-8", { fatal: true }).decode(data);
      } catch {
        throw new PaymentError("invalid_exact_svm_payload_memo", "memo is not UTF-8");
      }
    } else {
      throw new PaymentError("invalid_exact_svm_payload_instruction_not_allowed", `program ${program} is not allowed`);
    }
  }
  // signer set: exactly the facilitator and one client, the transfer authority
  if (msg.header.numSignerAccounts !== 2) throw new PaymentError("invalid_exact_svm_payload_signers", "exactly two signers: facilitator (fee payer) and the payer");
  const payer = keys[1]!;
  if (transfers !== 1 || !transfer) throw new PaymentError("invalid_exact_svm_payload_transfer", `exactly one TransferChecked required (found ${transfers})`);
  if (transfer.mint !== FORK_USDC_MINT) throw new PaymentError("invalid_exact_svm_payload_mint_mismatch", "transfer mint is not the required asset");
  if (transfer.destination !== p.treasuryAta) throw new PaymentError("invalid_exact_svm_payload_recipient_mismatch", "transfer destination is not the payTo associated token account");
  if (transfer.amount !== p.price) throw new PaymentError("invalid_exact_svm_payload_amount_mismatch", `transfer amount ${transfer.amount} is not the price ${p.price}`);
  if (transfer.decimals !== USDC_DECIMALS) throw new PaymentError("invalid_exact_svm_payload_amount_mismatch", "transfer decimals mismatch");
  if (transfer.authority !== payer) throw new PaymentError("invalid_exact_svm_payload_signers", "transfer authority must be the payer signer");
  if (transfer.source === transfer.destination) throw new PaymentError("invalid_exact_svm_payload_transfer", "source equals destination");
  if (memos !== 1 || memo === undefined) throw new PaymentError("invalid_exact_svm_payload_memo_missing", `exactly one Memo with the challenge id required (found ${memos})`);

  // the payer's signature must be present and valid over the message
  const sig = tx.signatures[payer];
  if (!sig) throw new PaymentError("invalid_exact_svm_payload_signature", "payer signature missing");
  const valid = await verifySignature(await getPublicKeyFromAddress(payer), sig as SignatureBytes, tx.messageBytes).catch(() => false);
  if (!valid) throw new PaymentError("invalid_exact_svm_payload_signature", "payer signature is invalid");
  return { tx, challenge: memo, payer, clientSignature: getBase58Decoder().decode(sig), amount: transfer.amount };
}

// ---------------------------------------------------------------- the app

type Product = {
  name: "compile" | "hedge";
  path: string;
  price: bigint;
  description: string;
  upstream: string;
  provisional: boolean;
};

export type X402App = {
  app: FastifyInstance;
  enabled: boolean;
  reason?: string;
  facilitator?: Address;
  treasury?: Address;
  treasuryAta?: Address;
  config: X402Config;
  /** Raw Node handler for mounting in another http server (the gateway). */
  handle: (req: http.IncomingMessage, res: http.ServerResponse) => void;
};

function buildFastify(): { app: FastifyInstance; handle: () => X402App["handle"] } {
  let handler: X402App["handle"] | undefined;
  const app = Fastify({
    logger: false,
    bodyLimit: 1_048_576,
    serverFactory: (h) => {
      handler = h as X402App["handle"];
      return http.createServer(h);
    },
  });
  // keep the raw body: the challenge binds sha256(body)
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer" }, (req, body, done) => {
    const raw = body as Buffer;
    (req as unknown as { rawBody: Buffer }).rawBody = raw;
    const ct = String(req.headers["content-type"] ?? "");
    if (!raw.length || !ct.includes("json")) return done(null, undefined);
    try {
      done(null, JSON.parse(raw.toString("utf8")));
    } catch {
      const err = new Error("invalid JSON body") as Error & { statusCode: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });
  return { app, handle: () => handler! };
}

const rawBody = (req: FastifyRequest) => (req as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
const pathOf = (req: FastifyRequest) => req.url.split("?")[0]!;

async function upstream(url: string, init: { method: string; body?: Buffer; timeoutMs: number }) {
  const r = await fetch(url, {
    method: init.method,
    headers: init.body ? { "content-type": "application/json" } : undefined,
    body: init.body && init.body.length ? new Uint8Array(init.body) : undefined,
    signal: AbortSignal.timeout(init.timeoutMs),
  });
  return { status: r.status, contentType: r.headers.get("content-type") ?? "application/json", text: await r.text() };
}

export async function createX402App(overrides: Partial<X402Config> = {}): Promise<X402App> {
  const config = { ...configFromEnv(), ...overrides };
  const { app, handle } = buildFastify();

  const disable = async (reason: string): Promise<X402App> => {
    console.log(`[x402] DISABLED (fail closed): ${reason}`);
    app.all("/x402", async (_q, reply) => reply.code(503).send({ error: "x402 disabled", reason }));
    app.all("/x402/*", async (_q, reply) => reply.code(503).send({ error: "x402 disabled", reason }));
    await app.ready();
    return { app, enabled: false, reason, config, handle: handle() };
  };

  const check = await checkSettlementRpc(config.rpcUrl);
  if (!check.ok) return disable(check.reason);

  let facilitator: KeyPairSigner, treasury: Address;
  try {
    facilitator = config.facilitator ?? (await loadKey("x402-facilitator"));
    treasury = config.treasury ?? (await loadKey("x402-treasury")).address;
  } catch (e) {
    return disable(`x402 keys unavailable: ${(e as Error).message} (run fork/scripts/keys.ts)`);
  }
  if (facilitator.address === treasury) return disable("facilitator and treasury must be different keys");
  const rpc: Rpc<SolanaRpcApi> = createSolanaRpc(config.rpcUrl);
  const [treasuryAta] = await findAssociatedTokenPda({ owner: treasury, mint: FORK_USDC_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });

  // fork-only setup: fee SOL for the facilitator, an existing treasury token account (cheatcodes)
  const raw = async (method: string, params: unknown[]) => {
    const r = await fetch(config.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const b = (await r.json()) as { error?: { message: string } };
    if (b.error) throw new Error(`${method}: ${b.error.message}`);
  };
  try {
    const { value: bal } = await rpc.getBalance(facilitator.address).send();
    if (bal < 1_000_000_000n) await raw("surfnet_setAccount", [facilitator.address, { lamports: 10_000_000_000 }]);
    const { value: acct } = await rpc.getAccountInfo(treasuryAta, { encoding: "base64" }).send();
    if (!acct) await raw("surfnet_setTokenAccount", [treasury, FORK_USDC_MINT, { amount: 0, state: "initialized" }]);
  } catch (e) {
    return disable(`could not prepare facilitator/treasury on the fork: ${(e as Error).message}`);
  }

  const store = new SettlementStore(config.statePath, config.retryWindowSeconds + config.challengeTtlSeconds);
  const inFlight = new Set<string>();
  const products: Record<string, Product> = {
    compile: {
      name: "compile",
      path: "/x402/compile",
      price: config.priceCompile,
      description: "Compile a target payoff into a FORGE construction (compiler POST /compile)",
      upstream: `${config.compilerUrl}/compile`,
      provisional: false,
    },
    hedge: {
      name: "hedge",
      path: "/x402/hedge",
      price: config.priceHedge,
      description: "Request a hedge from the FORGE agent service (POST /hedge)",
      upstream: `${config.agentUrl}/hedge`,
      provisional: config.hedgePriceProvisional,
    },
  };
  const usd = (a: bigint) => (Number(a) / 10 ** USDC_DECIMALS).toFixed(6).replace(/0{1,4}$/, "");
  const baseUrl = (req: FastifyRequest) => {
    if (config.publicUrl) return config.publicUrl.replace(/\/$/, "");
    const proto = String(req.headers["x-forwarded-proto"] ?? "http").split(",")[0];
    const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost").split(",")[0];
    return `${proto}://${host}`;
  };

  async function paymentRequired(req: FastifyRequest, product: Product, error: string): Promise<PaymentRequired> {
    const path = pathOf(req);
    const ch = issueChallenge(config.secret, req.method, path, sha256hex(rawBody(req)), config.challengeTtlSeconds);
    let lifetime: { blockhash: string; lastValidBlockHeight: bigint } | undefined;
    try {
      lifetime = (await rpc.getLatestBlockhash({ commitment: "confirmed" }).send()).value;
    } catch {
      /* the client fetches its own */
    }
    const accepts: PaymentRequirements = {
      scheme: "exact",
      network: FORGE_X402_NETWORK,
      amount: product.price.toString(),
      asset: FORK_USDC_MINT,
      payTo: treasury,
      maxTimeoutSeconds: config.challengeTtlSeconds,
      extra: {
        feePayer: facilitator.address,
        memo: ch.id,
        ...(lifetime ? { recentBlockhash: lifetime.blockhash, lastValidBlockHeight: lifetime.lastValidBlockHeight.toString() } : {}),
        paymentFlow: "upfront",
        decimals: USDC_DECIMALS,
        payToTokenAccount: treasuryAta,
        challengeExpiresAt: new Date(ch.expiresAt * 1000).toISOString(),
        testEnvironment: true,
      },
    };
    return {
      x402Version: X402_VERSION,
      error,
      resource: { url: `${baseUrl(req)}${path}`, description: `${product.description}. ${TEST_NOTE}`, mimeType: "application/json", serviceName: SERVICE_NAME },
      accepts: [accepts],
    };
  }

  async function reject(req: FastifyRequest, reply: FastifyReply, product: Product, e: PaymentError, extra: Partial<SettlementResponse> = {}) {
    const pr = await paymentRequired(req, product, e.message);
    reply.code(e.status).header(HEADER_PAYMENT_REQUIRED, encodeHeader(pr));
    // a failed payment attempt also gets a SettlementResponse; a plain unpaid request does not
    if (e.reason !== "payment_required") {
      const sr: SettlementResponse = { success: false, errorReason: e.reason, transaction: "", network: FORGE_X402_NETWORK, ...extra };
      reply.header(HEADER_PAYMENT_RESPONSE, encodeHeader(sr));
    }
    return reply.send({ ...pr, errorReason: e.reason });
  }

  async function settle(v: Verified): Promise<string> {
    const [sigs] = await facilitator.signTransactions([v.tx]);
    const signed = { ...v.tx, signatures: Object.freeze({ ...v.tx.signatures, ...sigs }) } as SignableTransaction;
    const wire = getBase64EncodedWireTransaction(signed);
    const sig = getSignatureFromTransaction(signed);
    if (store.hasTx(sig)) throw new PaymentError("duplicate_settlement", "transaction already settled", 409);
    // a payment that landed after an earlier `settlement_pending` is recognised instead of resent
    const { value: prior } = await rpc.getSignatureStatuses([sig], { searchTransactionHistory: true }).send();
    if (prior[0] && !prior[0].err && prior[0].confirmationStatus !== "processed") return sig;
    const sim = await rpc.simulateTransaction(wire, { encoding: "base64", sigVerify: true, commitment: "confirmed" }).send();
    if (sim.value.err) {
      const logs = (sim.value.logs ?? []).slice(-4).join(" | ");
      const reason = JSON.stringify(sim.value.err, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
      throw new PaymentError(/insufficient/i.test(logs) ? "insufficient_funds" : "invalid_transaction_state", `simulation failed: ${reason} ${logs}`);
    }
    await rpc.sendTransaction(wire, { encoding: "base64", skipPreflight: true }).send();
    const deadline = Date.now() + config.confirmTimeoutMs;
    while (Date.now() < deadline) {
      const { value } = await rpc.getSignatureStatuses([sig]).send();
      const st = value[0];
      if (st?.err) throw new PaymentError("invalid_transaction_state", `settlement failed on chain: ${JSON.stringify(st.err, (_k, x) => (typeof x === "bigint" ? x.toString() : x))}`);
      if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return sig;
      await new Promise((r) => setTimeout(r, 250));
    }
    const err = new PaymentError("settlement_pending", "settlement broadcast but not confirmed in time; retry later with the same payment");
    (err as PaymentError & { transaction?: string }).transaction = sig;
    throw err;
  }

  async function doWork(req: FastifyRequest, reply: FastifyReply, product: Product, receipt: SettlementResponse, challenge: string) {
    const header = encodeHeader(receipt);
    try {
      const r = await upstream(product.upstream, { method: "POST", body: rawBody(req), timeoutMs: config.upstreamTimeoutMs });
      if (r.status >= 500) throw new Error(`upstream ${product.name} returned ${r.status}: ${r.text.slice(0, 300)}`);
      store.attempt(challenge, true);
      return reply.code(r.status).header("content-type", r.contentType).header(HEADER_PAYMENT_RESPONSE, header).send(r.text);
    } catch (e) {
      store.attempt(challenge, false);
      const rec = store.get(challenge)!;
      return reply
        .code(502)
        .header(HEADER_PAYMENT_RESPONSE, header)
        .send({
          error: `paid work failed: ${(e as Error).message}`,
          receipt: receipt,
          retry: {
            how: "resend the identical request (same body) with the same PAYMENT-SIGNATURE header; it is not charged again",
            until: new Date((rec.settledAt + config.retryWindowSeconds) * 1000).toISOString(),
            attemptsLeft: Math.max(0, config.maxAttempts - rec.attempts),
          },
        });
    }
  }

  /** Never ask for (or take) payment for a hedge the agent service cannot produce (e.g. no model key). */
  async function hedgeAvailable(): Promise<boolean> {
    try {
      const r = await fetch(`${config.agentUrl}/health`, { signal: AbortSignal.timeout(5_000) });
      return r.ok && ((await r.json()) as { configured?: boolean }).configured === true;
    } catch {
      return false;
    }
  }

  async function paid(req: FastifyRequest, reply: FastifyReply, product: Product) {
    if (product === products.hedge && !(await hedgeAvailable())) {
      return reply.code(503).send({ error: "hedge_unavailable", message: "The FORGE Architect is not configured on this server; nothing was charged." });
    }
    const header = req.headers[HEADER_PAYMENT_SIGNATURE.toLowerCase()];
    if (!header) return reject(req, reply, product, new PaymentError("payment_required", "PAYMENT-SIGNATURE header is required"));
    let payload: PaymentPayload;
    try {
      payload = decodeHeader<PaymentPayload>(String(header));
      if (typeof payload?.payload?.transaction !== "string" || typeof payload.accepted !== "object") throw new Error("shape");
    } catch {
      return reject(req, reply, product, new PaymentError("invalid_payload", "PAYMENT-SIGNATURE is not a base64 PaymentPayload", 400));
    }
    const path = pathOf(req);
    const bodyHash = sha256hex(rawBody(req));
    try {
      const a = payload.accepted;
      if (payload.x402Version !== X402_VERSION) throw new PaymentError("invalid_x402_version", "x402Version must be 2");
      if (a.scheme !== "exact") throw new PaymentError("invalid_scheme", "scheme must be exact");
      if (a.network !== FORGE_X402_NETWORK) throw new PaymentError("invalid_network", `network must be ${FORGE_X402_NETWORK}`);
      if (a.asset !== FORK_USDC_MINT) throw new PaymentError("invalid_payment_requirements", "asset is not the fork USDC mint");
      if (a.payTo !== treasury) throw new PaymentError("invalid_payment_requirements", "payTo is not the FORGE treasury");
      if (a.amount !== product.price.toString()) throw new PaymentError("invalid_payment_requirements", `amount must be ${product.price}`);
      if (a.extra?.feePayer !== undefined && a.extra.feePayer !== facilitator.address) throw new PaymentError("invalid_payment_requirements", "feePayer is not the FORGE facilitator");

      const v = await verifyPaymentTransaction(payload.payload.transaction, {
        facilitator: facilitator.address,
        treasury,
        treasuryAta,
        price: product.price,
        maxComputeUnits: config.maxComputeUnits,
        maxMicroLamports: config.maxMicroLamports,
      });
      if (a.extra?.memo !== undefined && a.extra.memo !== v.challenge) throw new PaymentError("invalid_exact_svm_payload_memo_mismatch", "memo differs from accepted.extra.memo");
      const ch = checkChallenge(config.secret, v.challenge, req.method, path, bodyHash);
      if (!ch.bound) throw new PaymentError("invalid_exact_svm_payload_memo_mismatch", "memo is not a challenge issued for this request (method, path and body)");

      // already settled: serve an idempotent retry of the same payment, refuse anything else
      const rec = store.get(v.challenge);
      if (rec) {
        if (rec.clientSignature !== v.clientSignature) throw new PaymentError("duplicate_settlement", "this challenge is already paid by another transaction", 409);
        const receipt: SettlementResponse = { success: true, transaction: rec.txSignature, network: FORGE_X402_NETWORK, payer: rec.payer, amount: rec.amount };
        if (rec.served) throw new PaymentError("payment_already_used", "this payment was already used for a served request", 409);
        if (Date.now() / 1000 > rec.settledAt + config.retryWindowSeconds) throw new PaymentError("retry_window_expired", "the free retry window for this payment has passed");
        if (rec.attempts >= config.maxAttempts) throw new PaymentError("retry_limit_reached", "no retries left for this payment");
        if (inFlight.has(v.challenge)) throw new PaymentError("settlement_in_progress", "this payment is being processed", 409);
        inFlight.add(v.challenge);
        try {
          return await doWork(req, reply, product, receipt, v.challenge);
        } finally {
          inFlight.delete(v.challenge);
        }
      }
      if (ch.expired) throw new PaymentError("challenge_expired", "challenge expired; request a new one");
      if (inFlight.has(v.challenge)) throw new PaymentError("settlement_in_progress", "this challenge is being settled", 409);
      inFlight.add(v.challenge);
      try {
        const sig = await settle(v);
        store.settled({
          challenge: v.challenge,
          txSignature: sig,
          clientSignature: v.clientSignature,
          payer: v.payer,
          amount: v.amount.toString(),
          method: req.method,
          path,
          bodyHash,
          settledAt: Math.floor(Date.now() / 1000),
        });
        const receipt: SettlementResponse = { success: true, transaction: sig, network: FORGE_X402_NETWORK, payer: v.payer, amount: v.amount.toString() };
        return await doWork(req, reply, product, receipt, v.challenge);
      } finally {
        inFlight.delete(v.challenge);
      }
    } catch (e) {
      if (e instanceof PaymentError) {
        const tx = (e as PaymentError & { transaction?: string }).transaction;
        return reject(req, reply, product, e, tx ? { transaction: tx } : {});
      }
      console.error(`[x402] unexpected error on ${path}: ${(e as Error).message}`);
      return reject(req, reply, product, new PaymentError("unexpected_settle_error", `unexpected error: ${(e as Error).message}`, 500));
    }
  }

  // ---- routes
  app.get("/x402", async (req) => discovery(baseUrl(req)));
  app.get("/x402/markets", async (_req, reply) => {
    try {
      const r = await fetch(`${config.indexerUrl}/markets`, { signal: AbortSignal.timeout(15_000) });
      if (!r.ok) return reply.code(502).send({ error: `indexer returned ${r.status}` });
      const ms = (await r.json()) as Record<string, any>[];
      return {
        network: FORGE_X402_NETWORK,
        note: TEST_NOTE,
        markets: ms.map((m) => ({
          address: m.address,
          name: m.name,
          baseMint: m.baseMint,
          quoteMint: m.quoteMint,
          baseDecimals: m.baseDecimals,
          quoteDecimals: m.quoteDecimals,
          whirlpool: m.whirlpool,
          tickSpacing: m.tickSpacing,
          bucketWidth: m.bucketWidth,
          poolPrice: m.poolPrice,
          reference: m.reference ? { price: m.reference.price, ageSeconds: m.reference.ageSeconds, kind: m.reference.kind } : null,
          opensPaused: m.opensPaused,
          borrowPaused: m.borrowPaused,
          limits: m.params ? { maxBucketsPerStrategy: m.params.max_buckets_per_strategy, maxOpsPerTx: m.params.max_ops_per_tx, floorRateBps: m.params.floor_rate_bps } : undefined,
          compileHints: {
            spot: m.poolPrice,
            tick_spacing: m.tickSpacing,
            bucket_multiplier: m.tickSpacing ? Math.round(m.bucketWidth / m.tickSpacing) : undefined,
            market: { whirlpool: m.whirlpool, base_decimals: m.baseDecimals, quote_decimals: m.quoteDecimals },
          },
        })),
      };
    } catch (e) {
      return reply.code(502).send({ error: `indexer unavailable: ${(e as Error).message}` });
    }
  });
  app.post("/x402/verify", async (req, reply) => {
    try {
      const r = await upstream(`${config.compilerUrl}/verify`, { method: "POST", body: rawBody(req), timeoutMs: 60_000 });
      return reply.code(r.status).header("content-type", r.contentType).send(r.text);
    } catch (e) {
      return reply.code(502).send({ error: `compiler unavailable: ${(e as Error).message}` });
    }
  });
  app.post("/x402/compile", (req, reply) => paid(req, reply, products.compile!));
  app.post("/x402/hedge", (req, reply) => paid(req, reply, products.hedge!));

  function discovery(base: string) {
    const ep = (p: Product) => ({
      method: "POST",
      path: p.path,
      url: `${base}${p.path}`,
      paid: true,
      description: p.description,
      price: { amount: p.price.toString(), asset: FORK_USDC_MINT, decimals: USDC_DECIMALS, usd: usd(p.price), provisional: p.provisional },
      requestBody: "application/json; byte-identical on the paid retry (the challenge binds sha256 of the body)",
    });
    return {
      x402Version: X402_VERSION,
      service: "FORGE",
      testEnvironment: true,
      realFunds: false,
      note: TEST_NOTE,
      network: FORGE_X402_NETWORK,
      scheme: "exact",
      paymentFlow: "upfront",
      asset: { mint: FORK_USDC_MINT, symbol: "USDC", decimals: USDC_DECIMALS, tokenProgram: TOKEN_PROGRAM_ADDRESS, note: "fork-only USDC" },
      payTo: treasury,
      payToTokenAccount: treasuryAta,
      facilitator: { selfHosted: true, feePayer: facilitator.address, settlesOn: "FORGE Surfpool fork", surfnetVersion: check.ok ? check.surfnetVersion : undefined },
      headers: { paymentRequired: HEADER_PAYMENT_REQUIRED, paymentSignature: HEADER_PAYMENT_SIGNATURE, paymentResponse: HEADER_PAYMENT_RESPONSE },
      transaction: {
        format: "base64 partially signed transaction (legacy or v0, no address lookup tables) in PaymentPayload.payload.transaction",
        feePayer: facilitator.address,
        signers: "exactly two: the facilitator (fee payer, signs at settlement) and the payer (transfer authority)",
        allowedInstructions: [
          `ComputeBudget SetComputeUnitLimit (<= ${config.maxComputeUnits}) and SetComputeUnitPrice (<= ${config.maxMicroLamports} micro-lamports), optional, at most one each`,
          "SPL Token TransferChecked of exactly `amount` fork USDC to payToTokenAccount, authority = payer",
          "Memo whose UTF-8 data is exactly accepts[0].extra.memo (the challenge id)",
        ],
        challenge: `accepts[0].extra.memo; bound to method, path and sha256(body); expires after ${config.challengeTtlSeconds}s`,
      },
      retryPolicy: {
        windowSeconds: config.retryWindowSeconds,
        maxAttempts: config.maxAttempts,
        rule: "if the paid work fails (502 with a receipt), resend the identical request with the same PAYMENT-SIGNATURE; it is served without a second charge. A served payment cannot be reused.",
      },
      endpoints: [
        { method: "GET", path: "/x402", url: `${base}/x402`, paid: false, description: "this document" },
        { method: "GET", path: "/x402/markets", url: `${base}/x402/markets`, paid: false, description: "FORGE markets with compile hints" },
        { method: "POST", path: "/x402/verify", url: `${base}/x402/verify`, paid: false, description: "verify a construction certificate (compiler POST /verify)" },
        ep(products.compile!),
        ep(products.hedge!),
      ],
      client: "import { fetchWithPayment } from \"@forge/fork/x402-client\"",
    };
  }

  await app.ready();
  console.log(`[x402] enabled: settling on Surfpool ${check.surfnetVersion} at ${new URL(config.rpcUrl).host} (network ${FORGE_X402_NETWORK}, fee payer ${facilitator.address}, payTo ${treasury})`);
  return { app, enabled: true, config, facilitator: facilitator.address, treasury, treasuryAta, handle: handle() };
}
