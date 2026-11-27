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
import { buildClose, buildOpen, type LegKindName } from "./flows.js";
import { fetchMarket } from "./accounts.js";
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

app.post<{ Body: OpenBody }>("/build/open", async (req) => {
  const b = req.body;
  const owner = address(b.owner);
  const m = await fetchMarket(rpc, address(b.market));
  const { strategy, transactions } = await buildOpen(rpc, {
    owner: createNoopSigner(owner),
    market: address(b.market),
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
  return { strategy, transactions: await encode(owner, transactions) };
});

app.post<{ Body: { owner: string; market: string; strategy: string; userBase: string; userQuote: string } }>("/build/close", async (req) => {
  const b = req.body;
  const owner = address(b.owner);
  const plan = await buildClose(rpc, {
    caller: createNoopSigner(owner),
    market: address(b.market),
    strategy: address(b.strategy),
    userBase: address(b.userBase),
    userQuote: address(b.userQuote),
  });
  return { transactions: await encode(owner, plan) };
});

await app.listen({ port: PORT, host: process.env.HOST ?? "127.0.0.1" });
console.log(`txbuilder on :${PORT}`);
