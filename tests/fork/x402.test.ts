/**
 * x402 (fork): FORGE's self-facilitated x402 V2 "exact" SVM payment layer. Paid compile settles fork
 * USDC to the treasury before the work, replays are refused, a failed paid request is retried for free,
 * and malformed or hostile payment transactions are rejected before the facilitator signs anything.
 * The agent service's /hedge is stubbed. Requires the fork, the compiler API (:8000) and the x402 keys
 * (fork/scripts/keys.ts).
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AccountRole, type Address, generateKeyPairSigner, type Instruction, type KeyPairSigner, type TransactionSigner } from "@solana/kit";
import { findAssociatedTokenPda, getTransferCheckedInstruction, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { ata } from "@forge/fork/env";
import { assertFork, forkRpc, setTokenBalance, tokenBalance, USDC, WSOL } from "@forge/fork/surfnet";
import { checkSettlementRpc, createX402App, type X402App } from "@forge/fork/x402";
import {
  buildPaymentTransaction,
  decodeHeader,
  fetchWithPayment,
  FORGE_X402_NETWORK,
  memoInstruction,
  paymentHeaderFor,
  paymentInstructions,
  type PaymentRequired,
  type PaymentRequirements,
  retryWithPayment,
  type SettlementResponse,
  X402ClientError,
} from "@forge/fork/x402-client";

const rpc = forkRpc();
const PRICE = 10_000n;
const SECRET = Buffer.from("x402-fork-test-secret-not-a-real-secret");
const COMPILE_BODY = JSON.stringify({
  payoff: [[100, 50], [150, 0], [200, 0]],
  spot: 150,
  tick_spacing: 4,
  bucket_multiplier: 16,
  limits: { base_holdings: 10, quote_holdings: 10_000, premium_budget: 100 },
  method: "baseline",
});
const json = { "content-type": "application/json" };

let x402: X402App;
let base: string;
let treasuryAta: Address;
let payer: KeyPairSigner;
let statePath: string;
// agent stub: /hedge fails while `hedgeFailures` > 0
let hedgeFailures = 0;
let hedgeCalls = 0;
let agentConfigured = true;
const agent = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.url === "/health") {
      res.writeHead(200, json);
      return res.end(JSON.stringify({ ok: true, configured: agentConfigured }));
    }
    hedgeCalls++;
    if (hedgeFailures > 0) {
      hedgeFailures--;
      res.writeHead(500, json);
      return res.end(JSON.stringify({ error: "stub failure" }));
    }
    res.writeHead(200, json);
    res.end(JSON.stringify({ hedge: "stub", request: JSON.parse(body || "{}") }));
  });
});

const treasuryBalance = () => tokenBalance(rpc, treasuryAta);
const post = (path: string, body = COMPILE_BODY, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method: "POST", headers: { ...json, ...headers }, body });

async function challenge(path = "/x402/compile", body = COMPILE_BODY) {
  const r = await post(path, body);
  expect(r.status).toBe(402);
  const pr = decodeHeader<PaymentRequired>(r.headers.get("PAYMENT-REQUIRED")!);
  return { pr, req: pr.accepts[0]! };
}

/** Pay a compile with a hand-made instruction list; returns status, reason and treasury delta. */
async function payWith(make: (req: PaymentRequirements, std: Instruction[]) => Promise<Instruction[]> | Instruction[], opts: { accepted?: (r: PaymentRequirements) => PaymentRequirements } = {}) {
  const { pr, req } = await challenge();
  const ixs = await make(req, await paymentInstructions(req, payer));
  const tx = await buildPaymentTransaction(req, payer, { instructions: ixs });
  const before = await treasuryBalance();
  const r = await post("/x402/compile", COMPILE_BODY, { "PAYMENT-SIGNATURE": paymentHeaderFor(pr, opts.accepted?.(req) ?? req, tx) });
  const sr = r.headers.get("PAYMENT-RESPONSE") ? decodeHeader<SettlementResponse>(r.headers.get("PAYMENT-RESPONSE")!) : null;
  return { status: r.status, reason: sr?.errorReason, delta: (await treasuryBalance()) - before };
}

describe("x402 payment layer (fork)", () => {
  beforeAll(async () => {
    await assertFork();
    await new Promise<void>((r) => agent.listen(0, "127.0.0.1", r));
    statePath = join(mkdtempSync(join(tmpdir(), "forge-x402-")), "settlements.jsonl");
    x402 = await createX402App({ agentUrl: `http://127.0.0.1:${(agent.address() as AddressInfo).port}`, statePath, secret: SECRET, priceCompile: PRICE, priceHedge: PRICE });
    expect(x402.enabled).toBe(true);
    await x402.app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(x402.app.server.address() as AddressInfo).port}`;
    treasuryAta = x402.treasuryAta!;
    payer = await generateKeyPairSigner();
    await setTokenBalance(payer.address, USDC, 1_000_000n); // 1 fork USDC, no SOL: the facilitator pays fees
  });
  afterAll(async () => {
    await x402?.app.close();
    agent.close();
  });

  it("fails closed on a mainnet RPC and opens on the Surfpool fork", async () => {
    expect((await checkSettlementRpc("https://api.mainnet-beta.solana.com")).ok).toBe(false);
    expect((await checkSettlementRpc("https://mainnet.helius-rpc.com/?api-key=x")).ok).toBe(false);
    expect((await checkSettlementRpc("http://127.0.0.1:8899")).ok).toBe(true);
    const closed = await createX402App({ rpcUrl: "https://api.mainnet-beta.solana.com", statePath, secret: SECRET });
    expect(closed.enabled).toBe(false);
    const r = await closed.app.inject({ method: "POST", url: "/x402/compile", payload: COMPILE_BODY, headers: json });
    expect(r.statusCode).toBe(503);
    await closed.app.close();
  });

  it("serves the discovery document", async () => {
    const d = (await (await fetch(`${base}/x402`)).json()) as any;
    expect(d.x402Version).toBe(2);
    expect(d.network).toBe("solana:forge-surfpool");
    expect(d.testEnvironment).toBe(true);
    expect(d.realFunds).toBe(false);
    expect(d.note).toMatch(/TEST ENVIRONMENT/);
    expect(d.asset.mint).toBe(USDC);
    expect(d.payTo).toBe(x402.treasury);
    expect(d.payToTokenAccount).toBe(treasuryAta);
    expect(d.facilitator.feePayer).toBe(x402.facilitator);
    const compile = d.endpoints.find((e: any) => e.path === "/x402/compile");
    const hedge = d.endpoints.find((e: any) => e.path === "/x402/hedge");
    expect(compile.price.amount).toBe("10000");
    expect(compile.price.provisional).toBe(false);
    expect(hedge.price.provisional).toBe(true);
    expect(d.endpoints.filter((e: any) => !e.paid).map((e: any) => e.path)).toEqual(["/x402", "/x402/markets", "/x402/verify"]);
  });

  it("answers an unpaid request with 402 and V2 requirements", async () => {
    const r = await post("/x402/compile");
    expect(r.status).toBe(402);
    expect(r.headers.get("PAYMENT-RESPONSE")).toBeNull();
    const pr = decodeHeader<PaymentRequired>(r.headers.get("PAYMENT-REQUIRED")!);
    expect(pr.x402Version).toBe(2);
    expect(pr.resource.url).toBe(`${base}/x402/compile`);
    expect(pr.accepts).toHaveLength(1);
    const a = pr.accepts[0]!;
    expect(a).toMatchObject({ scheme: "exact", network: FORGE_X402_NETWORK, amount: "10000", asset: USDC, payTo: x402.treasury });
    expect(a.extra).toMatchObject({ feePayer: x402.facilitator, paymentFlow: "upfront", decimals: 6, payToTokenAccount: treasuryAta });
    expect(a.extra!.memo).toMatch(/^forge-x402:\d+:[0-9a-f]{24}:[A-Za-z0-9_-]{43}$/);
    expect(a.extra!.recentBlockhash).toBeTruthy();
    // every 402 carries a fresh challenge
    expect((await challenge()).req.extra!.memo).not.toBe(a.extra!.memo);
  });

  let paidHeader = "";
  it("settles a paid compile upfront: the treasury gains exactly the price", async () => {
    const before = await treasuryBalance();
    const payerAta = await ata(payer.address, USDC);
    const payerBefore = await tokenBalance(rpc, payerAta);
    const events: unknown[] = [];
    const { response, settlement, paid, paymentHeader } = await fetchWithPayment(
      `${base}/x402/compile`,
      { method: "POST", headers: json, body: COMPILE_BODY },
      payer,
      { maxAtomicPerRequest: PRICE, onPayment: (e) => void events.push(e) },
    );
    expect(paid).toBe(true);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result?: { status: string } };
    expect(body.result?.status).toBeTruthy();
    expect(settlement).toMatchObject({ success: true, network: FORGE_X402_NETWORK, payer: payer.address, amount: "10000" });
    expect(settlement!.transaction).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
    expect(events).toHaveLength(1);
    expect((await treasuryBalance()) - before).toBe(PRICE);
    expect(payerBefore - (await tokenBalance(rpc, payerAta))).toBe(PRICE);
    paidHeader = paymentHeader!;
  });

  it("rejects a replay of the same payment (also after a restart, and on another body)", async () => {
    const before = await treasuryBalance();
    const again = await post("/x402/compile", COMPILE_BODY, { "PAYMENT-SIGNATURE": paidHeader });
    expect(again.status).toBe(409);
    expect(decodeHeader<SettlementResponse>(again.headers.get("PAYMENT-RESPONSE")!).errorReason).toBe("payment_already_used");

    const other = await post("/x402/compile", COMPILE_BODY.replace('"spot":150', '"spot":151'), { "PAYMENT-SIGNATURE": paidHeader });
    expect(other.status).toBe(402);
    expect(decodeHeader<SettlementResponse>(other.headers.get("PAYMENT-RESPONSE")!).errorReason).toBe("invalid_exact_svm_payload_memo_mismatch");

    // a restarted server reads the append-only settlement log
    const restarted = await createX402App({ statePath, secret: SECRET, priceCompile: PRICE, priceHedge: PRICE });
    await restarted.app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const url = `http://127.0.0.1:${(restarted.app.server.address() as AddressInfo).port}/x402/compile`;
      const r = await fetch(url, { method: "POST", headers: { ...json, "PAYMENT-SIGNATURE": paidHeader }, body: COMPILE_BODY });
      expect(r.status).toBe(409);
    } finally {
      await restarted.app.close();
    }
    expect(await treasuryBalance()).toBe(before);
  });

  it("serves a retry after the paid work failed without charging again", async () => {
    const body = JSON.stringify({ market: "SOL/USDC", protect_below: 120 });
    const init = { method: "POST", headers: json, body };
    hedgeFailures = 1;
    hedgeCalls = 0;
    const before = await treasuryBalance();
    const first = await fetchWithPayment(`${base}/x402/hedge`, init, payer, { maxAtomicPerRequest: PRICE });
    expect(first.response.status).toBe(502);
    const failed = (await first.response.json()) as { receipt: SettlementResponse; retry: { attemptsLeft: number } };
    expect(failed.receipt.success).toBe(true);
    expect(first.settlement?.transaction).toBe(failed.receipt.transaction);
    expect((await treasuryBalance()) - before).toBe(PRICE);

    const retry = await retryWithPayment(`${base}/x402/hedge`, init, first.paymentHeader!);
    expect(retry.response.status).toBe(200);
    expect(((await retry.response.json()) as { hedge: string }).hedge).toBe("stub");
    expect(retry.settlement?.transaction).toBe(first.settlement?.transaction);
    expect(hedgeCalls).toBe(2);
    expect((await treasuryBalance()) - before).toBe(PRICE); // charged once

    // once served, the payment is consumed
    const third = await retryWithPayment(`${base}/x402/hedge`, init, first.paymentHeader!);
    expect(third.response.status).toBe(409);
    expect((await treasuryBalance()) - before).toBe(PRICE);
  });

  describe("rejects hostile or wrong payments before signing", () => {
    const transferIx = (o: { source: Address; mint: Address; destination: Address; authority: Address | TransactionSigner; amount: bigint }) =>
      getTransferCheckedInstruction({ ...o, decimals: 6 });
    const swap = (std: Instruction[], i: number, ix: Instruction) => std.map((x, k) => (k === i ? ix : x));
    const TRANSFER = 2, MEMO = 3;

    it("wrong amount", async () => {
      const r = await payWith(async (req, std) =>
        swap(std, TRANSFER, transferIx({ source: await ata(payer.address, USDC), mint: USDC, destination: treasuryAta, authority: payer, amount: PRICE - 1n })),
      );
      expect(r).toEqual({ status: 402, reason: "invalid_exact_svm_payload_amount_mismatch", delta: 0n });
    });

    it("wrong mint", async () => {
      const r = await payWith(async (req, std) =>
        swap(std, TRANSFER, transferIx({ source: await ata(payer.address, WSOL), mint: WSOL, destination: await ata(req.payTo as Address, WSOL), authority: payer, amount: PRICE })),
      );
      expect(r).toEqual({ status: 402, reason: "invalid_exact_svm_payload_mint_mismatch", delta: 0n });
    });

    it("wrong payTo", async () => {
      const stranger = await generateKeyPairSigner();
      const r = await payWith(async (_req, std) =>
        swap(std, TRANSFER, transferIx({ source: await ata(payer.address, USDC), mint: USDC, destination: await ata(stranger.address, USDC), authority: payer, amount: PRICE })),
      );
      expect(r).toEqual({ status: 402, reason: "invalid_exact_svm_payload_recipient_mismatch", delta: 0n });
    });

    it("extra instruction", async () => {
      const stranger = await generateKeyPairSigner();
      const data = new Uint8Array(12);
      data[0] = 2; // System Transfer, 1 lamport
      data[4] = 1;
      const systemTransfer: Instruction = {
        programAddress: "11111111111111111111111111111111" as Address,
        accounts: [
          { address: payer.address, role: AccountRole.WRITABLE_SIGNER, signer: payer } as never,
          { address: stranger.address, role: AccountRole.WRITABLE },
        ],
        data,
      };
      const r = await payWith((_req, std) => [...std, systemTransfer]);
      expect(r).toEqual({ status: 402, reason: "invalid_exact_svm_payload_instruction_not_allowed", delta: 0n });
    });

    it("missing memo", async () => {
      const r = await payWith((_req, std) => std.filter((_x, k) => k !== MEMO));
      expect(r).toEqual({ status: 402, reason: "invalid_exact_svm_payload_memo_missing", delta: 0n });
    });

    it("memo bound to a different request", async () => {
      // a genuine challenge, but issued for another body
      const other = (await challenge("/x402/compile", COMPILE_BODY.replace('"spot":150', '"spot":152'))).req.extra!.memo!;
      const r = await payWith((_req, std) => swap(std, MEMO, memoInstruction(other)), {
        accepted: (req) => ({ ...req, extra: { ...req.extra, memo: other } }),
      });
      expect(r).toEqual({ status: 402, reason: "invalid_exact_svm_payload_memo_mismatch", delta: 0n });
    });

    it("forged memo", async () => {
      const r = await payWith((_req, std) => swap(std, MEMO, memoInstruction("forge-x402:9999999999:000000000000000000000000:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")), {
        accepted: (req) => ({ ...req, extra: { ...req.extra, memo: undefined } }),
      });
      expect(r).toEqual({ status: 402, reason: "invalid_exact_svm_payload_memo_mismatch", delta: 0n });
    });

    it("facilitator as transfer authority", async () => {
      const fac = x402.facilitator!;
      const [facAta] = await findAssociatedTokenPda({ owner: fac, mint: USDC, tokenProgram: TOKEN_PROGRAM_ADDRESS });
      const r = await payWith((_req, std) =>
        swap(std, TRANSFER, transferIx({ source: facAta, mint: USDC, destination: treasuryAta, authority: fac, amount: PRICE })),
      );
      expect(r).toEqual({ status: 402, reason: "invalid_exact_svm_payload_fee_payer_isolation", delta: 0n });
    });
  });

  it("client refuses an over-cap price before signing", async () => {
    let signed = 0;
    const counting: TransactionSigner = {
      address: payer.address,
      signTransactions: async (txs) => {
        signed++;
        return payer.signTransactions(txs);
      },
    };
    const before = await treasuryBalance();
    const err = await fetchWithPayment(`${base}/x402/compile`, { method: "POST", headers: json, body: COMPILE_BODY }, counting, { maxAtomicPerRequest: PRICE - 1n }).catch((e) => e);
    expect(err).toBeInstanceOf(X402ClientError);
    expect((err as X402ClientError).code).toBe("price_over_cap");
    expect(signed).toBe(0);
    expect(await treasuryBalance()).toBe(before);
  });

  it("does not ask for payment for a hedge the agent cannot produce", async () => {
    agentConfigured = false;
    try {
      const before = await treasuryBalance();
      const r = await post("/x402/hedge", JSON.stringify({ objective: "x" }));
      expect(r.status).toBe(503);
      expect(r.headers.get("payment-required")).toBeNull();
      expect(await treasuryBalance()).toBe(before);
    } finally {
      agentConfigured = true;
    }
  });
});
