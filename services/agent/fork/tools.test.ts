/**
 * The Architect's deterministic side against the local stack (fork, indexer, compiler); run it with
 * `pnpm --filter @forge/agent test:fork` while the stack is up. No model calls:
 * the tools are driven directly, the way the model would call them, to check the numbers and the gates.
 */
import { describe, expect, it } from "vitest";
import { makeTools } from "../src/tools.js";
import { type AgentEvent, createSession } from "../src/session.js";

const s = createSession({ owner: null, portfolio: [{ symbol: "JUP", amount: 20_000 }], quoteHoldings: 500, model: "test" });
const events: AgentEvent[] = [];
const tools = Object.fromEntries(makeTools(s, (e) => events.push(e)).map((t) => [t.name, t]));
const call = async (name: string, args: unknown) => JSON.parse(String(await tools[name]!.run(args as never)));

describe("architect tools", () => {
  let spot = 0;
  let ok = "";

  it("reads supplied holdings and market data", async () => {
    const h = await call("get_wallet_holdings", {});
    expect(h.holdings[0].symbol).toBe("JUP");
    expect(h.holdings[0].usd_value).toBeGreaterThan(0);
    const m = await call("get_market_data", { market: "jup" });
    expect(m.market).toBe("JUP/USDC");
    spot = m.pool_price;
    expect(m.historical_moves.horizons["7d"].p5).toBeLessThan(1);
    const l = await call("get_available_liquidity", { market: "JUP/USDC" });
    expect(l.ranges.length).toBeGreaterThan(4);
  });

  it("compiles and verifies a collar with compiler numbers", async () => {
    const c = await call("compile_strategy", {
      market: "JUP", label: "Balanced", structure: "collar", units: 3000, floor_price: spot * 0.9, cap_price: spot * 1.12,
      lower_price: null, points: null, premium_budget_usd: 20, quote_holdings_usd: null, holding_days: null,
    });
    expect(c.status).toBe("ok");
    expect(c.verified).toBe(true);
    expect(c.certified_error_bound_usd).toBeLessThanOrEqual(c.tolerance_usd);
    expect(c.premium_floor_per_day_usd).toBeGreaterThan(0);
    expect(c.value_at_floor_usd).toBeCloseTo(3000 * spot * 0.9, 1);
    expect(c.holding_days).toBe(30);
    expect(c.suggested_premium_budget_usd).toBeGreaterThan(0);
    expect(c.sigma_annual).toBeGreaterThan(0);
    expect(c.sigma_from).toMatch(/^30d move quantiles/);
    expect(typeof c.budget_below_suggestion).toBe("boolean");
    expect(c.budget_below_suggestion).toBe(20 < c.suggested_premium_budget_usd);
    ok = c.construction_id;
  }, 120_000);

  it("refuses to present or prepare what did not compile", async () => {
    const bad = await call("compile_strategy", {
      market: "JUP", label: "Impossible", structure: "protective_put", units: 5_000_000, floor_price: spot * 0.99,
      lower_price: null, cap_price: null, points: null, premium_budget_usd: 1, quote_holdings_usd: 0, holding_days: 7,
    });
    expect(bad.status).not.toBe("ok");
    const shown = await call("present_options", { options: [{ construction_id: bad.construction_id, title: "x", summary: "x", tradeoffs: [], recommended: false }] });
    expect(shown.error).toMatch(/Not presentable/);
    const prep = await call("prepare_transaction", { construction_id: bad.construction_id });
    expect(prep.error).toMatch(/Cannot prepare/);
    const unknown = await call("prepare_transaction", { construction_id: "c_made_up" });
    expect(unknown.error).toMatch(/Unknown construction_id/);
  }, 120_000);

  it("presents and prepares a verified construction without signing", async () => {
    const shown = await call("present_options", { options: [{ construction_id: ok, title: "Balanced", summary: "s", tradeoffs: ["t"], recommended: true }] });
    expect(shown.shown).toBe(1);
    const card = events.find((e) => e.type === "options");
    expect(card && card.type === "options" && card.options[0]!.facts.certificate_hash).toBeTruthy();
    const v = await call("verify_strategy", { construction_id: ok });
    expect(v.valid && v.stored).toBe(true);
    const p = await call("prepare_transaction", { construction_id: ok });
    expect(p.prepared).toBe(true);
    const prepared = events.find((e) => e.type === "prepared");
    expect(prepared && prepared.type === "prepared" && prepared.review.legs).toBeTruthy();
  }, 120_000);
});
