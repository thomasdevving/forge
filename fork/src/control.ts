/**
 * Demo control service for the hosted fork. Runs next to Surfpool on the private network.
 *
 *   POST /faucet {address}           public, rate limited: fork-only SOL + wrapped SOL + USDC
 *                                    for throwaway demo wallets
 *   POST /scenario {price}           (Bearer DEMO_CONTROL_TOKEN) move both pools with real swaps
 *                                    and publish the labelled scenario reference
 *   POST /time-travel {seconds}      (Bearer) advance the fork clock, keep the reference fresh
 *   GET  /scenario                   current scenario price and reference age
 *   GET  /health
 *
 * The reference keeper republishes the *scenario price* (never the pool price) every 20 s so the
 * reference stays fresh; the program's checks still compare pools against it.
 */
import Fastify from "fastify";
import cors from "@fastify/cors";
import { address, type Address } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { getCreateAssociatedTokenIdempotentInstructionAsync, getSyncNativeInstruction } from "@solana-program/token";
import { ata, fundWallet, loadKey, readDeployment } from "./env.js";
import { movePoolTo } from "./price.js";
import { FEED_SOL_USD, FEED_USDC_USD, PYTH_SOL_USD, PYTH_USDC_USD, setScenarioPrice } from "./pyth.js";
import { airdrop, assertFork, forkClock, forkRpc, sendInstructions, setTokenBalance, timeTravel, USDC, WSOL } from "./surfnet.js";

const PORT = Number(process.env.PORT ?? 8791);
const TOKEN = process.env.DEMO_CONTROL_TOKEN ?? "";
const ORIGINS = (process.env.FORGE_ALLOWED_ORIGINS ?? "http://localhost:3000").split(",");
const rpc = forkRpc();
const dep = readDeployment();
const sol = dep.markets["SOL/USDC"]!;
let scenarioPrice = sol.scenarioPrice;

async function publish() {
  await setScenarioPrice(PYTH_SOL_USD, FEED_SOL_USD, scenarioPrice);
  await setScenarioPrice(PYTH_USDC_USD, FEED_USDC_USD, 1.0);
}

const faucetSeen = new Map<string, number>();
const ipSeen = new Map<string, number[]>();

const app = Fastify({ logger: false });
await app.register(cors, { origin: ORIGINS });

function authorized(h: string | undefined) {
  return TOKEN.length >= 16 && h === `Bearer ${TOKEN}`;
}

app.get("/health", async () => ({ ok: true, fork: await assertFork().catch(() => null), scenarioPrice }));

app.get("/scenario", async () => ({ scenarioPrice, clock: (await forkClock()).unixTimestamp, label: "fork-only scenario reference" }));

app.post<{ Body: { address: string } }>("/faucet", async (req, reply) => {
  let who: Address;
  try {
    who = address(req.body.address);
  } catch {
    return reply.code(400).send({ error: "invalid address" });
  }
  const now = Date.now();
  if ((faucetSeen.get(who) ?? 0) > now - 10 * 60_000) return reply.code(429).send({ error: "this address was funded recently" });
  const ip = req.ip;
  const recent = (ipSeen.get(ip) ?? []).filter((t) => t > now - 3_600_000);
  if (recent.length >= 10) return reply.code(429).send({ error: "too many faucet requests" });
  ipSeen.set(ip, [...recent, now]);
  faucetSeen.set(who, now);
  await airdrop(rpc, who, 2);
  await setTokenBalance(who, USDC, 5_000_000_000n); // 5,000 fork USDC
  // wrapped SOL needs real lamports backing: fund a temporary payer and wrap into the user's ATA
  const payer = await loadKey("keeper");
  await airdrop(rpc, payer.address, 25);
  const wsolAta = await ata(who, WSOL);
  await sendInstructions(rpc, payer, [
    await getCreateAssociatedTokenIdempotentInstructionAsync({ payer, owner: who, mint: WSOL }),
    getTransferSolInstruction({ source: payer, destination: wsolAta, amount: 20_000_000_000n }),
    getSyncNativeInstruction({ account: wsolAta }),
  ]);
  return { funded: who, sol: 2, wrappedSol: 20, usdc: 5_000, note: "fork-only test funds" };
});

let trader: Awaited<ReturnType<typeof fundWallet>> & { signer: Awaited<ReturnType<typeof loadKey>> } | undefined;
async function getTrader() {
  if (!trader) {
    const signer = await loadKey("keeper");
    const acc = await fundWallet(rpc, signer, { sol: 10, wsol: 500_000_000_000_000n, usdc: 50_000_000_000_000n, usdcMint: USDC });
    trader = { ...acc, signer };
  }
  return trader;
}

app.post<{ Body: { price: number } }>("/scenario", async (req, reply) => {
  if (!authorized(req.headers.authorization)) return reply.code(401).send({ error: "unauthorized" });
  const price = Number(req.body.price);
  if (!(price > 0) || Math.abs(Math.log(price / scenarioPrice)) > Math.log(1.5)) {
    return reply.code(400).send({ error: "price must be positive and within 50% of the current scenario" });
  }
  const t = await getTrader();
  const target = await movePoolTo(rpc, t.signer, sol.whirlpool, price, t.wsol, t.usdc);
  const swap = await movePoolTo(rpc, t.signer, sol.swapPool, price, t.wsol, t.usdc);
  scenarioPrice = price;
  await publish();
  return { scenarioPrice, targetPool: target, restorationPool: swap };
});

app.post<{ Body: { seconds: number } }>("/time-travel", async (req, reply) => {
  if (!authorized(req.headers.authorization)) return reply.code(401).send({ error: "unauthorized" });
  const s = Math.floor(Number(req.body.seconds));
  if (!(s > 0 && s <= 30 * 86_400)) return reply.code(400).send({ error: "seconds must be in (0, 30 days]" });
  const now = await timeTravel(s);
  await publish();
  return { clock: now };
});

await publish();
setInterval(() => void publish().catch((e) => console.error("reference keeper:", e)), 20_000);
await app.listen({ port: PORT, host: process.env.HOST ?? "127.0.0.1" });
console.log(`demo control on :${PORT}`);
