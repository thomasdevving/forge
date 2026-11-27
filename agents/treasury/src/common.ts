/**
 * Shared bits of the treasury agent. It talks to FORGE only through FORGE's public gateway, like any
 * third-party customer: /x402 (discovery, markets, paid hedges, verify), /compiler/certificates, /tx and
 * the public RPC proxy at /rpc. Its key is fork-only and created locally.
 */
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createKeyPairSignerFromBytes } from "@solana/kit";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..");
export const API = (process.env.FORGE_API ?? "http://127.0.0.1:8080").replace(/\/$/, "");
export const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export type Policy = {
  name: string; holdings: { symbol: string; amount: number }[]; usdc: number; objective: string;
  max_decline: number; hedge_premium_budget_usd: number; api_budget_usd: number; api_max_per_call_usd: number;
};
export const policy = JSON.parse(readFileSync(path.join(ROOT, "policy.json"), "utf8")) as Policy;

/** The treasury's fork-only key, created on first use (64-byte JSON, like solana-keygen). */
export async function treasuryKey() {
  const dir = path.join(ROOT, ".state");
  const file = path.join(dir, "treasury-key.json");
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
    const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
    writeFileSync(file, JSON.stringify([...seed, ...pub]), { mode: 0o600 });
  }
  return createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(file, "utf8")) as number[]));
}

export async function get<T>(p: string): Promise<T> {
  const r = await fetch(API + p, { signal: AbortSignal.timeout(30_000) });
  const t = await r.text();
  if (!r.ok) throw new Error(`GET ${p}: ${r.status} ${t.slice(0, 200)}`);
  return JSON.parse(t) as T;
}

export async function post<T>(p: string, body: unknown): Promise<T> {
  const r = await fetch(API + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  const t = await r.text();
  if (!r.ok) throw new Error(`POST ${p}: ${r.status} ${t.slice(0, 300)}`);
  return JSON.parse(t) as T;
}

export async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const r = await post<{ result?: T; error?: { message: string } }>("/rpc", { jsonrpc: "2.0", id: 1, method, params });
  if (r.error) throw new Error(`${method}: ${r.error.message}`);
  return r.result as T;
}

export type MarketRow = { name: string; baseMint: string; poolPrice: number; [k: string]: unknown };

/** FORGE's markets as the free /x402/markets route returns them (shape tolerated loosely). */
export async function markets(): Promise<MarketRow[]> {
  const d = await get<unknown>("/x402/markets");
  const list = (Array.isArray(d) ? d : (d as { markets?: unknown[] }).markets ?? []) as Record<string, unknown>[];
  return list.map((m) => ({
    ...m,
    name: String(m.name ?? m.market),
    baseMint: String(m.baseMint ?? m.base_mint ?? ""),
    poolPrice: Number(m.poolPrice ?? m.pool_price ?? m.price),
  }));
}

/** Token balances (ui amounts) by mint for an owner, through FORGE's public RPC proxy. */
export async function balances(owner: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const programId of ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]) {
    const r = await rpc<{ value: { account: { data: { parsed: { info: { mint: string; tokenAmount: { uiAmount: number | null } } } } } }[] }>(
      "getTokenAccountsByOwner", [owner, { programId }, { encoding: "jsonParsed" }],
    );
    for (const a of r.value) {
      const i = a.account.data.parsed.info;
      out.set(i.mint, (out.get(i.mint) ?? 0) + (i.tokenAmount.uiAmount ?? 0));
    }
  }
  return out;
}

const t0 = Date.now();
export function log(who: string, text: string) {
  const s = ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
  console.log(`${s}s  ${who.padEnd(16)} ${text}`);
}
