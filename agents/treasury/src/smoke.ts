/**
 * The machine path without a model: discover FORGE, pay for one compile over x402 with fork USDC,
 * re-verify the certificate that comes back. Useful to check a deployment end to end.
 *
 *   FORGE_API=<gateway> pnpm --filter @forge/treasury-agent run smoke
 */
import { fetchWithPayment } from "@forge/fork/x402-client";
import { API, balances, get, log, post, treasuryKey, USDC } from "./common.js";

type Hints = { spot: number; tick_spacing: number; bucket_multiplier: number; market: Record<string, unknown> };

const key = await treasuryKey();
const doc = await get<{ network: string; testEnvironment: boolean; endpoints: { path: string; price?: { usd: string } }[] }>("/x402");
log("FORGE API", `${doc.network}, test environment: ${doc.testEnvironment}; compile costs $${doc.endpoints.find((e) => e.path === "/x402/compile")?.price?.usd}`);
const ms = await get<{ markets?: { name: string; compileHints: Hints }[] } | { name: string; compileHints: Hints }[]>("/x402/markets");
const list = Array.isArray(ms) ? ms : ms.markets ?? [];
const m = list.find((x) => x.name === (process.env.SMOKE_MARKET ?? "JUP/USDC"));
if (!m) throw new Error("market not found");
const h = m.compileHints;
const s = h.spot, u = 3000, f = 0.9 * s, c = 1.12 * s;
const buckets = await get<{ tickLower: number; borrowable: string }[]>(`/indexer/markets/${(m as unknown as { address: string }).address}/buckets`);
const body = JSON.stringify({
  ...h,
  payoff: [[0.55 * s, u * f], [f, u * f], [c, u * c], [1.6 * s, u * c]],
  n_each_side: 10,
  borrowable: Object.fromEntries(buckets.map((b) => [String(b.tickLower), b.borrowable])),
  limits: { base_holdings: u, quote_holdings: 300, premium_budget: 20, max_legs: 8 },
});
const before = (await balances(key.address)).get(USDC) ?? 0;
const r = await fetchWithPayment(`${API}/x402/compile`, { method: "POST", headers: { "content-type": "application/json" }, body }, key, {
  maxAtomicPerRequest: 50_000n,
  onPayment: (p) => log("FORGE API", `402 Payment required: ${Number(p.amount) / 1e6} USDC`),
});
log("Payment", `settled: ${r.settlement?.success} ${r.settlement?.transaction?.slice(0, 16)}…`);
if (!r.response.ok) {
  log("FORGE API", `compile failed: HTTP ${r.response.status} ${(await r.response.text()).slice(0, 200)}`);
  if (r.response.status === 402) log("Ledger", "payment refused: fund the treasury first (pnpm --filter @forge/treasury-agent run fund)");
  process.exit(1);
}
const out = (await r.response.json()) as { result: { status: string }; certificate: { hash: string; error: { certified_bound: number } } };
const v = await post<{ valid: boolean; hash: string }>("/x402/verify", out.certificate);
const after = (await balances(key.address)).get(USDC) ?? 0;
log("Verifier", `${m.name} collar: ${out.result.status}, bound ±$${out.certificate.error.certified_bound.toFixed(2)}, certificate ${v.valid && v.hash === out.certificate.hash ? "verified" : "INVALID"}`);
log("Ledger", `USDC ${before} → ${after} (paid ${(before - after).toFixed(6)})`);
