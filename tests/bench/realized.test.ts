/**
 * Benchmark 2: theoretical vs realized (section 12.3). For each payoff and closing price:
 * compile (Python optimizer) and certify (independent verifier), open the construction through
 * FORGE + Orca on the fork with the certificate hash stored on-chain, move the market with real
 * swaps, settle, and compare
 *
 *   target f(S)  |  certified construction fhat(S)  |  certified bound
 *   realized gross payoff (token balances, before premium and fee credits)
 *   realized net payoff (after premium, fees and execution costs)
 *
 * Restoration swap costs are measured separately against the reference price, so the
 * certificate and the execution are compared at the same price. Writes JSON + Markdown to
 * $FORGE_BENCH_OUT (or benchmarks/results/<run>).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  buildCloseBatch,
  buildFinalizeClose,
  buildOpen,
  fetchBucket,
  fetchMarket,
  fetchStrategy,
  forgeIx,
  humanPriceToX64,
  type LegKindName,
} from "@forge/txbuilder";
import { ROOT } from "@forge/fork/env";
import { humanPrice, moveMarket, newUser, publishReference, rpc, send, setup, sol, tokenAmount } from "../src/harness.js";

type Cert = { hash: string; error: { certified_bound: number; rounding_bound: number }; construction: { cash: number; base: number; legs: { kind: string; tick_lower: number; liquidity_onchain: number }[] } };
const KIND: Record<string, LegKindName> = { borrow_put: "BorrowQuote", borrow_call: "BorrowBase", provide_put: "ProvideQuote", provide_call: "ProvideBase" };

function python(input: unknown): any {
  const out = execFileSync("uv", ["run", "--quiet", "python", "-m", "forge_compiler.cli"], {
    cwd: ROOT,
    input: JSON.stringify(input),
    encoding: "utf8",
    maxBuffer: 64 << 20,
  });
  return JSON.parse(out);
}

const rows: Record<string, unknown>[] = [];
const SCENARIOS: { name: string; preset: (spot: number) => { name: string; args: number[] } }[] = [
  { name: "protective_put", preset: (s) => ({ name: "protective_put", args: [10, 0.92 * s, s] }) },
  { name: "collar", preset: (s) => ({ name: "collar", args: [10, 0.92 * s, 1.08 * s, s] }) },
  { name: "call_spread", preset: (s) => ({ name: "call_spread", args: [5, 1.04 * s, 1.1 * s, s] }) },
  { name: "strangle", preset: (s) => ({ name: "strangle", args: [10, 0.93 * s, 1.07 * s, s] }) },
];
const MOVES = [0.9, 1.0, 1.1];

describe("Benchmark 2: theoretical vs realized (fork)", () => {
  let u: Awaited<ReturnType<typeof newUser>>;
  let nonce = 7000n;

  beforeAll(async () => {
    await setup();
    u = await newUser({ wsol: 50_000_000_000n, usdc: 5_000_000_000n });
  });

  for (const sc of SCENARIOS) {
    for (const mv of MOVES) {
      it(`${sc.name} closed at ${mv}x`, async () => {
        await moveMarket(sol.scenarioPrice);
        const m = await fetchMarket(rpc, sol.market);
        const spot = await humanPrice(sol.whirlpool);
        const borrowable: Record<string, string> = {};
        for (const b of sol.buckets) {
          const bk = await fetchBucket(rpc, b.address);
          const cap = (bk.total_liquidity * BigInt(m.params.curve.cap_ppm)) / 1_000_000n;
          const free = cap - bk.borrowed - bk.reserved - bk.withdrawal_requested;
          borrowable[String(b.tickLower)] = String(free > 0n ? free : 0n);
        }
        const compiled = python({
          preset: sc.preset(spot), spot, tick_spacing: 64, bucket_multiplier: 4, n_each_side: 8, borrowable,
          limits: { base_holdings: 10, quote_holdings: 2_000, premium_budget: 20, max_legs: 8 },
          market: { whirlpool: sol.whirlpool, base_decimals: 9, quote_decimals: 6 },
        });
        expect(compiled.result.status).toBe("ok");
        const cert = compiled.certificate as Cert;
        const legs = cert.construction.legs.map((l) => ({ kind: KIND[l.kind]!, tickLower: l.tick_lower, liquidity: BigInt(Math.round(l.liquidity_onchain)) }));
        await publishReference(spot);
        const q0 = await tokenAmount(u.usdc);
        const b0 = await tokenAmount(u.wsol);
        const plan = await buildOpen(rpc, {
          owner: u.user, market: sol.market, nonce: nonce++, legs, premiumBudget: 20_000_000n, expiry: 0n,
          openReferenceX64: humanPriceToX64(spot, 9, 6), openToleranceBps: 50, swapSlippageBps: 50,
          certificateHash: Uint8Array.from(Buffer.from(cert.hash, "hex")), userBase: u.wsol, userQuote: u.usdc,
        });
        for (const tx of plan.transactions) await send(u.user, tx);
        const s0 = await fetchStrategy(rpc, plan.strategy);
        expect(Buffer.from(s0.certificate_hash).toString("hex")).toBe(cert.hash); // certificate pinned on-chain

        const S = spot * mv;
        await moveMarket(S);
        const closeP = await humanPrice(sol.whirlpool);
        const p = { caller: u.user, market: sol.market, strategy: plan.strategy, userBase: u.wsol, userQuote: u.usdc };
        await send(u.user, [forgeIx("begin_close", { caller: u.user, market: sol.market, strategy: plan.strategy }, {}, [])]);
        const pending = s0.legs.map((_, i) => i);
        for (let i = 0; i < pending.length; i += 2) {
          await publishReference(closeP);
          await send(u.user, [await buildCloseBatch(rpc, p, pending.slice(i, i + 2))]);
        }
        await send(u.user, [await buildFinalizeClose(rpc, p)]);
        const s = await fetchStrategy(rpc, plan.strategy);
        expect(s.state).toBe("Closed");

        // realized, valued at the actual closing price
        const dQ = Number((await tokenAmount(u.usdc)) - q0) / 1e6;
        const dB = Number((await tokenAmount(u.wsol)) - b0) / 1e9;
        const premium = Number(s.premium_paid + s.keeper_bounty_paid) / 1e6;
        const fees = Number(s.fee_credit_quote) / 1e6 + (Number(s.fee_credit_base) / 1e9) * closeP;
        const providedFunding = s0.legs.reduce((a, l) => a + Number(l.provided_quote) / 1e6 + (Number(l.provided_base) / 1e9) * closeP, 0);
        const realizedNet = dQ + dB * closeP;
        // gross: the legs' payoff before premium and fee credits; provided legs are valued as
        // positions (their funding is the user's own collateral, part of the construction)
        const realizedGrossLegs = realizedNet + premium - fees + providedFunding;
        // restoration swap cost vs the reference (same-price comparison)
        let swapCost = 0;
        for (const l of s.legs) {
          if (l.swap_in === 0n) continue;
          // put legs buy base with quote; call legs sell base for quote
          if (l.kind_tag === 0) swapCost += Number(l.swap_in) / 1e6 - (Number(l.swap_out) / 1e9) * closeP;
          else if (l.kind_tag === 1) swapCost += (Number(l.swap_in) / 1e9) * closeP - Number(l.swap_out) / 1e6;
        }
        const ev = python({ evaluate: compiled.certificate, prices: [closeP] });
        const fhat = ev.fhat[0] as number;
        const target = ev.target[0] as number;
        const free = cert.construction.cash + cert.construction.base * closeP; // held outside FORGE
        const realizedFull = free + realizedGrossLegs;
        const bound = cert.error.certified_bound;
        const atoms = 2 * legs.length * (closeP * 1e-9 + 1e-6) * 4; // per-leg rounding allowance
        const row = {
          payoff: sc.name, move: mv, spot, close_price: closeP, legs: legs.map((l) => `${l.kind}@${l.tickLower}`),
          certificate_hash: cert.hash, target, construction: fhat, certified_bound: bound,
          construction_detail: cert.construction,
          target_breakpoints: (compiled.certificate as { target: { breakpoints: number[][] } }).target.breakpoints,
          // net = everything the user ends with from the construction: gross - premium + fee credits
          realized_full_gross: realizedFull, realized_net: realizedFull - premium + fees, premium, fee_credits: fees,
          restoration_swap_cost: swapCost, gap_to_construction: realizedFull - fhat, gap_to_target: realizedFull - target,
        };
        rows.push(row);
        console.log(row);
        // acceptance: realized vs designed within the certified bound plus documented costs
        expect(Math.abs(realizedFull - fhat)).toBeLessThanOrEqual(Math.max(swapCost, 0) + atoms + 0.01);
        expect(Math.abs(realizedFull - target)).toBeLessThanOrEqual(bound + Math.max(swapCost, 0) + atoms + 0.01);
      });
    }
  }

  it("writes the results", () => {
    const dir = process.env.FORGE_BENCH_OUT ?? resolve(ROOT, "benchmarks/results", `realized-${new Date().toISOString().replace(/[:.]/g, "")}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, "realized.json"), JSON.stringify({ benchmark: "realized", rows }, null, 1) + "\n");
    const lines = [
      "# Benchmark 2: theoretical vs realized (Surfpool mainnet fork, real Orca CPIs)",
      "",
      "| payoff | close | target | certified construction | bound | realized gross | realized net | premium | fee credits | restoration swap cost | gap to construction |",
      "|---|---|---|---|---|---|---|---|---|---|---|",
      ...rows.map((r: any) =>
        `| ${r.payoff} | ${r.move}x (${r.close_price.toFixed(2)}) | ${r.target.toFixed(2)} | ${r.construction.toFixed(2)} | ${r.certified_bound.toFixed(2)} | ${r.realized_full_gross.toFixed(2)} | ${r.realized_net.toFixed(2)} | ${r.premium.toFixed(4)} | ${r.fee_credits.toFixed(4)} | ${r.restoration_swap_cost.toFixed(4)} | ${r.gap_to_construction.toFixed(4)} |`),
    ];
    writeFileSync(resolve(dir, "realized.md"), lines.join("\n") + "\n");
    expect(rows.length).toBe(SCENARIOS.length * MOVES.length);
  });
});
