/**
 * The Architect's tools. The model chooses which to call and with what; the backend computes every
 * result. Two gates live here, not in the prompt:
 *  - present_options only accepts constructions this session compiled and verified;
 *  - prepare_transaction only hands off a construction that compiled within tolerance, verified, has
 *    funded liquidity for every borrowed range and is still fresh against the live pool price.
 */
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaToolRunContext } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import { z } from "zod";
import * as forge from "./forge.js";
import { type AgentEvent, type Construction, newConstructionId, type Session } from "./session.js";

const KIND_NAME: Record<string, string> = { borrow_put: "BorrowQuote", borrow_call: "BorrowBase", provide_put: "ProvideQuote", provide_call: "ProvideBase" };
const FRESH_MS = 10 * 60 * 1000;
const round = (x: number, d = 2) => (Number.isFinite(x) ? Number(x.toFixed(d)) : x);
const sig = (x: number) => (Number.isFinite(x) ? Number(x.toPrecision(6)) : x);

/** The facts of a construction that the UI and the model may show. All of them come from the compiler or the program rules. */
export function constructionFacts(c: Construction) {
  const r = c.response.result;
  const k = r.construction;
  const cert = c.response.certificate;
  return {
    construction_id: c.id,
    label: c.label,
    market: c.market.name,
    structure: c.spec.structure,
    units: c.spec.units,
    floor_price: c.spec.floor_price ?? null,
    cap_price: c.spec.cap_price ?? null,
    lower_price: c.spec.lower_price ?? null,
    spot_at_compile: sig(c.spotAtCompile),
    value_at_floor_usd: c.spec.floor_price ? round(c.spec.units * c.spec.floor_price) : null,
    value_at_cap_usd: c.spec.cap_price ? round(c.spec.units * c.spec.cap_price) : null,
    status: r.status,
    reasons: r.reasons,
    certified_error_bound_usd: cert ? round(cert.error.certified_bound, 4) : null,
    tolerance_usd: round(c.response.tolerance, 4),
    legs: k?.legs.length ?? 0,
    borrowed_ranges: k?.legs.filter((l) => l.kind.startsWith("borrow")).map((l) => ({ kind: l.kind, price_lower: sig(l.price_lower), price_upper: sig(l.price_upper) })) ?? [],
    capital_locked_usd: k ? round(k.capital_locked) : null,
    buffers_usd: k ? round(k.buffer_quote + k.buffer_base * k.spot) : null,
    lp_escrow_usd: k ? round(k.escrow_quote + k.escrow_base * k.spot) : null,
    funded_liquidity_ok: cert ? cert.liquidity_check.every((l) => l.ok) : null,
    verified: c.verified?.valid ?? false,
    certificate_hash: cert?.hash ?? null,
    closest_feasible: r.closest_feasible,
    ...c.facts,
  };
}

function gate(c: Construction): string | null {
  const r = c.response;
  if (r.result.status !== "ok" || !r.result.construction) return "it did not compile within tolerance";
  if (!r.certificate) return "it has no certificate";
  if (!c.verified?.valid || c.verified.hash !== r.certificate.hash) return "its certificate has not been verified (call verify_strategy)";
  if (!r.certificate.liquidity_check.every((l) => l.ok)) return "a borrowed range lacks funded liquidity";
  if (Date.now() - c.createdAt > FRESH_MS) return "it is older than 10 minutes; compile it again";
  return null;
}

export function makeTools(s: Session, emit: (e: AgentEvent) => void) {
  const wrap = <T>(name: string, run: (args: T) => Promise<unknown>, summarize: (out: any) => string) =>
    async (args: T, ctx?: BetaToolRunContext) => {
      const id = ctx?.toolUse.id ?? name;
      try {
        const out = await run(args);
        emit({ type: "tool_result", id, name, ok: true, summary: summarize(out) });
        return JSON.stringify(out);
      } catch (e) {
        const msg = (e as Error).message;
        emit({ type: "tool_result", id, name, ok: false, summary: msg.slice(0, 200) });
        return JSON.stringify({ error: msg });
      }
    };
  const get = (id: string) => {
    const c = s.constructions.get(id);
    if (!c) throw new Error(`Unknown construction_id ${id}. Use an id returned by compile_strategy in this conversation.`);
    return c;
  };
  const common = { strict: true, eager_input_streaming: true } as const;

  return [
    betaZodTool({
      ...common,
      name: "get_wallet_holdings",
      description: "Read the user's token holdings (supported FORGE markets and USDC only) with their USD value at the live pool price. Call this first whenever the request refers to what the user holds.",
      inputSchema: z.object({}),
      run: wrap("get_wallet_holdings", async () => {
        if (s.portfolio) {
          const ms = await forge.markets();
          const rows = s.portfolio.map((h) => {
            const m = ms.find((x) => forge.baseSymbol(x).toLowerCase() === h.symbol.toLowerCase());
            return { symbol: h.symbol, amount: h.amount, usd_value: m ? round(h.amount * m.poolPrice) : null, supported: !!m || h.symbol.toUpperCase() === "USDC" };
          });
          return { source: "supplied by the caller", holdings: rows, usdc: s.quoteHoldings ?? 0 };
        }
        if (!s.owner) return { source: "none", holdings: [], note: "No wallet is connected. Ask the user what they hold." };
        const rows = await forge.holdings(s.owner);
        return { source: "wallet on the FORGE fork", holdings: rows.map((r) => ({ ...r, usd_value: round(r.usd_value) })) };
      }, (o) => `${o.holdings.length} holdings`),
    }),
    betaZodTool({
      ...common,
      name: "get_market_data",
      description: "List FORGE markets, or get one market's live pool price, reference price, premium rules and historical price-move quantiles (end/start price over 1, 7 and 30 days). Call before choosing floor or cap levels.",
      inputSchema: z.object({ market: z.string().describe('Token symbol or market name, e.g. "JUP" or "JUP/USDC". Use "all" to list every market.') }),
      run: wrap("get_market_data", async ({ market }: { market: string }) => {
        if (market.toLowerCase() === "all") {
          return { markets: (await forge.markets()).map((m) => ({ market: m.name, pool_price: sig(m.poolPrice), opens_paused: m.opensPaused })) };
        }
        const m = await forge.findMarket(market);
        return {
          market: m.name,
          pool_price: sig(m.poolPrice),
          reference_price: m.reference ? sig(m.reference.price) : null,
          reference_age_s: m.reference?.ageSeconds ?? null,
          opens_paused: m.opensPaused,
          borrow_paused: m.borrowPaused,
          premium_floor_rate_per_year: m.params.floor_rate_bps / 1e4,
          max_ranges_per_strategy: m.params.max_buckets_per_strategy,
          keeper_closes_at_share_of_budget: m.params.keeper_trigger_bps / 1e4,
          historical_moves: forge.moveQuantiles(m),
        };
      }, (o) => (o.markets ? `${o.markets.length} markets` : `${o.market} at ${o.pool_price}`)),
    }),
    betaZodTool({
      ...common,
      name: "get_available_liquidity",
      description: "Funded LP liquidity for a market, per price range: how much can be borrowed, utilization, and the premium multiplier at that utilization. Protection below spot borrows ranges below the price; capped upside provides ranges above.",
      inputSchema: z.object({ market: z.string() }),
      run: wrap("get_available_liquidity", async ({ market }: { market: string }) => {
        const m = await forge.findMarket(market);
        const bs = await forge.buckets(m);
        return {
          market: m.name,
          pool_price: sig(m.poolPrice),
          ranges: bs.map((b) => {
            const total = Number(BigInt(b.totalLiquidity));
            return {
              price_lower: sig(b.priceLower), price_upper: sig(b.priceUpper), side: b.side,
              borrowable_share: total > 0 ? round(Number(BigInt(b.borrowable)) / total, 3) : 0,
              utilization: round(b.utilization, 3),
              premium_multiplier_now: round(forge.multiplier(m, b.utilization), 3),
            };
          }),
        };
      }, (o) => `${o.ranges.length} ranges on ${o.market}`),
    }),
    betaZodTool({
      ...common,
      name: "compile_strategy",
      description: "Build a payoff from a structure and its levels, then run the FORGE compiler against live funded liquidity. Returns a construction_id with the compiler's facts: status, certified error bound, legs, capital locked, premium facts and a suggested premium budget for the holding period (an estimate from past moves). The compiler, not you, decides feasibility and every number. Compile each alternative you want to compare.",
      inputSchema: z.object({
        market: z.string(),
        label: z.string().describe("Short name, e.g. Balanced"),
        structure: z.enum(["protective_put", "collar", "put_spread", "custom"]),
        units: z.number().describe("Base tokens covered"),
        floor_price: z.number().nullable().describe("Protected price (protective_put, collar) or the upper protected level (put_spread)"),
        cap_price: z.number().nullable().describe("Collar only: upside is capped here"),
        lower_price: z.number().nullable().describe("put_spread only: protection stops below this price"),
        points: z.array(z.object({ price: z.number(), value_usd: z.number() })).nullable().describe("custom only: breakpoints of the position's value in USD by price"),
        premium_budget_usd: z.number().describe("Most the user will pay in premium for this position"),
        quote_holdings_usd: z.number().nullable().describe("USDC the user can commit; null to use the wallet balance"),
        holding_days: z.number().nullable().describe("How long the user intends to keep the position, in days; null for 30. Sets the horizon of the suggested premium budget."),
      }),
      run: wrap("compile_strategy", async (a: {
        market: string; label: string; structure: forge.Structure; units: number; floor_price: number | null; cap_price: number | null;
        lower_price: number | null; points: { price: number; value_usd: number }[] | null; premium_budget_usd: number; quote_holdings_usd: number | null; holding_days: number | null;
      }) => {
        const m = await forge.findMarket(a.market);
        if (m.opensPaused) throw new Error(`${m.name} has opens paused`);
        const bs = await forge.buckets(m);
        const spec: forge.PayoffSpec = { structure: a.structure, units: a.units, floor_price: a.floor_price, cap_price: a.cap_price, lower_price: a.lower_price, points: a.points?.map((p) => [p.price, p.value_usd] as forge.Point) ?? null };
        const payoff = forge.buildPayoff(spec, m.poolPrice);
        let quote = a.quote_holdings_usd;
        if (quote == null) {
          if (s.quoteHoldings != null) quote = s.quoteHoldings;
          else if (s.owner) quote = (await forge.holdings(s.owner)).find((h) => h.mint === m.quoteMint)?.amount ?? 0;
          else quote = 0;
        }
        const limits = { base: a.units, quote, budget: a.premium_budget_usd };
        const response = await forge.compile(forge.compileRequest(m, bs, payoff, limits));
        const c: Construction = {
          id: newConstructionId(), createdAt: Date.now(), label: a.label,
          market: { address: m.address, name: m.name, baseDecimals: m.baseDecimals, quoteDecimals: m.quoteDecimals, params: m.params },
          spec, payoff, limits, spotAtCompile: m.poolPrice, response, verified: null, facts: {},
        };
        if (response.result.construction) {
          const legs = response.result.construction.legs;
          const days = a.holding_days != null && a.holding_days > 0 ? a.holding_days : 30;
          c.facts = { ...forge.costFacts(m, bs, legs, a.premium_budget_usd), ...forge.budgetSuggestion(m, bs, legs, a.premium_budget_usd, days) };
        }
        if (response.certificate) {
          const v = await forge.verify(response.certificate);
          c.verified = { valid: v.valid && v.hash === response.certificate.hash, hash: v.hash, stored: false };
        }
        s.constructions.set(c.id, c);
        return constructionFacts(c);
      }, (o) => `${o.label}: ${o.status}${o.certified_error_bound_usd != null ? `, bound ±$${o.certified_error_bound_usd}` : ""}`),
    }),
    betaZodTool({
      ...common,
      name: "verify_strategy",
      description: "Independently re-verify a construction's certificate (recompute its hash and exact error bound) and store it so anyone can fetch it by hash. Required before prepare_transaction.",
      inputSchema: z.object({ construction_id: z.string() }),
      run: wrap("verify_strategy", async ({ construction_id }: { construction_id: string }) => {
        const c = get(construction_id);
        const cert = c.response.certificate;
        if (!cert) throw new Error("This construction has no certificate (it did not compile within tolerance).");
        const v = await forge.verify(cert);
        const valid = v.valid && v.hash === cert.hash;
        const stored = valid ? (await forge.storeCertificate(cert)).hash === cert.hash : false;
        c.verified = { valid, hash: v.hash, stored };
        return { construction_id, valid, certificate_hash: v.hash, stored, certified_error_bound_usd: round(cert.error.certified_bound, 4) };
      }, (o) => (o.valid ? `verified ${String(o.certificate_hash).slice(0, 10)}…` : "verification failed")),
    }),
    betaZodTool({
      ...common,
      name: "compare_strategies",
      description: "Side-by-side facts for constructions compiled in this conversation.",
      inputSchema: z.object({ construction_ids: z.array(z.string()) }),
      run: wrap("compare_strategies", async ({ construction_ids }: { construction_ids: string[] }) => ({
        rows: construction_ids.map((id) => constructionFacts(get(id))),
      }), (o) => `${o.rows.length} compared`),
    }),
    betaZodTool({
      ...common,
      name: "present_options",
      description: "Show the user the alternatives as cards. Call this once you have compiled the options, before your final message. Cards display the compiler's numbers; you supply only the title, a one-line summary and the trade-offs. Only constructions that compiled and verified can be presented.",
      inputSchema: z.object({
        options: z.array(z.object({
          construction_id: z.string(),
          title: z.string(),
          summary: z.string(),
          tradeoffs: z.array(z.string()),
          recommended: z.boolean(),
        })),
      }),
      run: wrap("present_options", async ({ options }: { options: { construction_id: string; title: string; summary: string; tradeoffs: string[]; recommended: boolean }[] }) => {
        const bad = options.map((o) => ({ o, c: s.constructions.get(o.construction_id) })).filter(({ c }) => !c || c.response.result.status !== "ok" || !c.verified?.valid);
        if (bad.length) throw new Error(`Not presentable (unknown, infeasible or unverified): ${bad.map(({ o }) => o.construction_id).join(", ")}`);
        s.options = options;
        emit({ type: "options", options: options.map((o) => ({ ...o, facts: constructionFacts(get(o.construction_id)) })) });
        return { shown: options.length };
      }, (o) => `${o.shown} options shown`),
    }),
    betaZodTool({
      ...common,
      name: "prepare_transaction",
      description: "Prepare a verified construction for the user's review and signature. This never signs or sends anything: the user reviews it in the Studio and signs with their own wallet. Call only when the user has chosen an option.",
      inputSchema: z.object({ construction_id: z.string() }),
      run: wrap("prepare_transaction", async ({ construction_id }: { construction_id: string }) => {
        const c = get(construction_id);
        const why = gate(c);
        if (why) throw new Error(`Cannot prepare ${construction_id}: ${why}.`);
        const m = await forge.findMarket(c.market.address);
        const drift = Math.abs(m.poolPrice / c.spotAtCompile - 1) * 1e4;
        if (drift > m.params.open_tolerance_bps) throw new Error(`The pool moved ${drift.toFixed(0)} bps since compile (tolerance ${m.params.open_tolerance_bps}); compile it again.`);
        if (!c.verified!.stored) {
          await forge.storeCertificate(c.response.certificate);
          c.verified!.stored = true;
        }
        s.prepared.add(c.id);
        const review = openTemplate(c, m);
        emit({ type: "prepared", construction_id: c.id, review });
        return { prepared: true, construction_id: c.id, note: "Ready for the user's review. Nothing has been signed or sent." };
      }, () => "ready for review"),
    }),
  ];
}

/** What a wallet needs to open the position through the transaction builder (owner, nonce and token accounts are the signer's). */
export function openTemplate(c: Construction, m: forge.Market) {
  const k = c.response.result.construction!;
  return {
    market: m.address,
    marketName: m.name,
    payoff: c.payoff,
    limits: c.limits,
    legs: k.legs.map((l) => ({ kind: KIND_NAME[l.kind], tickLower: l.tick_lower, liquidity: String(Math.round(l.liquidity_onchain)) })),
    premiumBudget: String(Math.round(c.limits.budget * 10 ** m.quoteDecimals)),
    openReferencePrice: m.reference?.price ?? m.poolPrice,
    openToleranceBps: m.params.open_tolerance_bps,
    swapSlippageBps: m.params.swap_slippage_bps,
    certificateHash: c.response.certificate!.hash,
  };
}
