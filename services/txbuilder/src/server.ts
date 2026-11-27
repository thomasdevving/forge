/**
 * Transaction builder service: returns UNSIGNED v0 transactions (base64) for the user's wallet
 * to review and sign. Holds no keys. Each transaction is simulated and checked against the
 * runtime limits before it is returned.
 *
 *   POST /build/open   { owner, market, nonce, legs[], premiumBudget, expiry, openReferencePrice,
 *                        openToleranceBps, swapSlippageBps, certificateHash, userBase, userQuote }
 *   POST /build/close  { owner, market, strategy, userBase, userQuote }
 *   GET  /health
 */
import Fastify from "fastify";
import cors from "@fastify/cors";
import {
  type Address,
  address,
  compileTransaction,
  createNoopSigner,
  createSolanaRpc,
  getBase64EncodedWireTransaction,
} from "@solana/kit";
import { buildClose, buildOpen, checkpointLegIx, type LegKindName } from "./flows.js";
import { checkpointIxsForBucket, claimLpIx, depositLiquidityIx, requestWithdrawalIx, withdrawLiquidityIx } from "./lp.js";
import { fetchMarket, fetchStrategy } from "./accounts.js";
import { forgeIx, rw } from "./program.js";
import { hexToBytes } from "./idl.js";
import { humanPriceToX64 } from "./orca.js";
import { loadLookupTables, prepareTransaction, SimulationError, TransactionLimitError } from "./tx.js";

const RPC_URL = process.env.FORGE_RPC_URL ?? "http://127.0.0.1:8899";
const PORT = Number(process.env.PORT ?? 8788);
const ORIGINS = (process.env.FORGE_ALLOWED_ORIGINS ?? "http://localhost:3000").split(",");
const LOOKUP_TABLES = (process.env.FORGE_LOOKUP_TABLES ?? "").split(",").filter(Boolean).map((a) => address(a));
const rpc = createSolanaRpc(RPC_URL);

async function encode(owner: Address, plan: Parameters<typeof prepareTransaction>[2][]) {
  const tables = await loadLookupTables(rpc, LOOKUP_TABLES);
  const out = [];
  for (const ixs of plan) {
    // a no-op signer stands in for the wallet: the signature slot stays empty
    const prepared = await prepareTransaction(rpc, createNoopSigner(owner), ixs, tables);
    const wire = getBase64EncodedWireTransaction(compileTransaction(prepared.message));
    out.push({ transaction: wire, computeUnits: prepared.unitsConsumed, computeUnitLimit: prepared.computeUnitLimit, bytes: prepared.bytes, accounts: prepared.loadedAccounts });
  }
  return out;
}

const app = Fastify({ logger: false });
await app.register(cors, { origin: ORIGINS });

app.setErrorHandler((err, _req, reply) => {
  if (err instanceof SimulationError) return reply.code(422).send({ error: err.message, code: err.codeName, logs: err.logs.slice(-12) });
  if (err instanceof TransactionLimitError) return reply.code(422).send({ error: err.message });
  return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
});

app.get("/health", async () => ({ ok: true, rpc: RPC_URL.replace(/\/\/[^@]*@/, "//"), lookupTables: LOOKUP_TABLES }));

type OpenBody = {
  owner: string; market: string; nonce: string;
  legs: { kind: LegKindName; tickLower: number; liquidity: string; extraBuffer?: string }[];
  premiumBudget: string; expiry?: string; openReferencePrice: number; openToleranceBps: number;
  swapSlippageBps: number; certificateHash: string; userBase: string; userQuote: string;
};

/**
 * Staged plans are returned one transaction at a time, chosen from chain state, so every
 * transaction is simulated against the real state it will execute on (a later batch cannot be
 * simulated before the strategy exists). Clients call again until `done`.
 */
app.post<{ Body: OpenBody }>("/build/open", async (req) => {
  const b = req.body;
  const owner = address(b.owner);
  const market = address(b.market);
  const m = await fetchMarket(rpc, market);
  const { strategy, transactions } = await buildOpen(rpc, {
    owner: createNoopSigner(owner),
    market,
    nonce: BigInt(b.nonce),
    legs: b.legs.map((l) => ({ kind: l.kind, tickLower: l.tickLower, liquidity: BigInt(l.liquidity), extraBuffer: BigInt(l.extraBuffer ?? "0") })),
    premiumBudget: BigInt(b.premiumBudget),
    expiry: BigInt(b.expiry ?? "0"),
    openReferenceX64: humanPriceToX64(b.openReferencePrice, m.base_decimals, m.quote_decimals),
    openToleranceBps: b.openToleranceBps,
    swapSlippageBps: b.swapSlippageBps,
    certificateHash: hexToBytes(b.certificateHash),
    userBase: address(b.userBase),
    userQuote: address(b.userQuote),
  });
  const exists = await rpc.getAccountInfo(strategy, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }).send();
  let step = 0;
  if (exists.value) {
    const s = await fetchStrategy(rpc, strategy);
    if (s.state !== "PendingOpen") return { strategy, transactions: [], done: true, state: s.state };
    const per = m.params.max_ops_per_tx;
    const batch = s.legs.findIndex((l) => !l.executed);
    // transactions = [begin], [batch 0], [batch 1], ..., [finalize]
    step = batch < 0 ? transactions.length - 1 : 1 + Math.floor(batch / per);
  }
  return { strategy, transactions: await encode(owner, [transactions[step]!]), done: false, step, steps: transactions.length };
});

app.post<{ Body: { owner: string; market: string; strategy: string; userBase: string; userQuote: string } }>("/build/close", async (req) => {
  const b = req.body;
  const owner = address(b.owner);
  const s = await fetchStrategy(rpc, address(b.strategy));
  if (s.state === "Closed" || s.state === "Cancelled") return { transactions: [], done: true, state: s.state };
  const plan = await buildClose(rpc, {
    caller: createNoopSigner(owner),
    market: address(b.market),
    strategy: address(b.strategy),
    userBase: address(b.userBase),
    userQuote: address(b.userQuote),
  });
  // buildClose already reflects chain state: begin (if open), pending batches, finalize
  return { transactions: await encode(owner, [plan[0]!]), done: false, steps: plan.length };
});

app.post<{ Body: { owner: string; market: string; strategy: string } }>("/build/abort", async (req) => {
  const b = req.body;
  const owner = address(b.owner);
  const s = await fetchStrategy(rpc, address(b.strategy));
  // reservations of unexecuted borrowed legs are released by the abort itself
  const rem = s.legs.filter((l) => !l.executed && l.kind_tag <= 1).map((l) => rw(l.bucket));
  const ix = forgeIx("abort_open", { caller: createNoopSigner(owner), strategy: address(b.strategy), market: address(b.market) }, {}, rem);
  return { transactions: await encode(owner, [[ix]]) };
});

type LpBody = { owner: string; market: string; bucket: string; liquidity?: string; userBase: string; userQuote: string };

app.post<{ Body: LpBody }>("/build/deposit", async (req) => {
  const b = req.body;
  const owner = address(b.owner);
  const s = createNoopSigner(owner);
  const ixs = [
    ...(await checkpointIxsForBucket(rpc, address(b.market), address(b.bucket))),
    await depositLiquidityIx({ rpc, lp: s, market: address(b.market), bucket: address(b.bucket), liquidity: BigInt(b.liquidity ?? "0"), lpBase: address(b.userBase), lpQuote: address(b.userQuote) }),
  ];
  return { transactions: await encode(owner, [ixs]) };
});

app.post<{ Body: LpBody }>("/build/withdraw", async (req) => {
  const b = req.body;
  const owner = address(b.owner);
  const s = createNoopSigner(owner);
  const ixs = [
    ...(await checkpointIxsForBucket(rpc, address(b.market), address(b.bucket))),
    await withdrawLiquidityIx({ rpc, lp: s, market: address(b.market), bucket: address(b.bucket), liquidity: BigInt(b.liquidity ?? "0"), lpBase: address(b.userBase), lpQuote: address(b.userQuote) }),
  ];
  return { transactions: await encode(owner, [ixs]) };
});

app.post<{ Body: LpBody }>("/build/request-withdrawal", async (req) => {
  const b = req.body;
  const owner = address(b.owner);
  return { transactions: await encode(owner, [[await requestWithdrawalIx(createNoopSigner(owner), address(b.bucket), BigInt(b.liquidity ?? "0"))]]) };
});

app.post<{ Body: LpBody }>("/build/claim", async (req) => {
  const b = req.body;
  const owner = address(b.owner);
  const ix = await claimLpIx(rpc, createNoopSigner(owner), address(b.market), address(b.bucket), address(b.userBase), address(b.userQuote));
  return { transactions: await encode(owner, [[ix]]) };
});

app.post<{ Body: { payer: string; market: string; strategy: string; legIndex: number } }>("/build/checkpoint", async (req) => {
  const b = req.body;
  const payer = address(b.payer);
  return { transactions: await encode(payer, [[await checkpointLegIx(rpc, address(b.market), address(b.strategy), b.legIndex)]]) };
});

await app.listen({ port: PORT, host: process.env.HOST ?? "127.0.0.1" });
console.log(`txbuilder on :${PORT}`);
