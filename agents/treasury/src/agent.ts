/**
 * An external AI treasury agent: a third-party customer of FORGE, not part of the FORGE app.
 *
 * It reads its own (simulated) treasury on the FORGE fork, works out which exposure its policy says to
 * protect, discovers FORGE's machine API, pays for hedge requests in fork USDC over x402, re-verifies the
 * certificates it gets back, checks them against its policy, and stops at "awaiting authorization". A
 * human then approves or declines; only on approval does it build, sign and send the open on the fork.
 *
 * Budgets are enforced in code, not in the prompt: a per-call cap checked before any payment is signed,
 * a total API budget, and the policy's premium budget and size limits on every hedge it may accept.
 *
 *   pnpm --filter @forge/treasury-agent run fund     # fund the simulated treasury on a local fork
 *   pnpm --filter @forge/treasury-agent start     # run (FORGE_API=<gateway>, ANTHROPIC_API_KEY)
 */
import { createInterface } from "node:readline/promises";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { fetchWithPayment, X402ClientError } from "@forge/fork/x402-client";
import { getBase64EncodedWireTransaction, getTransactionDecoder, signTransaction, type KeyPairSigner } from "@solana/kit";
import { z } from "zod";
import { API, balances, get, log, markets, post, policy, rpc, treasuryKey, USDC } from "./common.js";

const MODEL = process.env.TREASURY_MODEL ?? "claude-sonnet-5-5";
const usd = (x: number) => `$${x.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

type Option = {
  construction_id: string; title: string; summary: string; tradeoffs: string[]; recommended: boolean;
  facts: Record<string, any>; certificate: Record<string, any>; open: Record<string, any>;
};

// spend ledger (USDC), enforced in code
const ledger = { spent: 0, calls: [] as { url: string; usdc: number; tx: string | null }[] };
const options = new Map<string, Option>();
const inspected = new Map<string, boolean>();
let chosen: { option: Option; rationale: string } | null = null;

function tools(key: KeyPairSigner) {
  const common = { strict: true, eager_input_streaming: true } as const;
  const wrap = <T>(who: string, fn: (a: T) => Promise<unknown>) => async (a: T) => {
    try {
      return JSON.stringify(await fn(a));
    } catch (e) {
      log(who, `error: ${(e as Error).message.slice(0, 160)}`);
      return JSON.stringify({ error: (e as Error).message });
    }
  };
  return [
    betaZodTool({
      ...common,
      name: "read_treasury",
      description: "Read the treasury's balances on the FORGE fork and its policy. Call first.",
      inputSchema: z.object({}),
      run: wrap("Treasury Agent", async () => {
        const ms = await markets();
        const bal = await balances(key.address);
        const rows = policy.holdings.map((h) => {
          const m = ms.find((x) => x.name.split("/")[0]!.toLowerCase() === h.symbol.toLowerCase());
          const amount = m ? bal.get(m.baseMint) ?? 0 : 0;
          return { symbol: h.symbol, amount, price: m?.poolPrice ?? null, usd_value: m ? amount * m.poolPrice : null, forge_market: m?.name ?? null };
        });
        log("Treasury Agent", `analyzing ${rows.map((r) => `${r.symbol} ${r.usd_value != null ? usd(r.usd_value) : "?"}`).join(", ")}`);
        return {
          holdings: rows, usdc: bal.get(USDC) ?? 0,
          policy: { objective: policy.objective, max_decline: policy.max_decline, hedge_premium_budget_usd: policy.hedge_premium_budget_usd, api_budget_usd: policy.api_budget_usd },
          api_spent_usd: ledger.spent,
        };
      }),
    }),
    betaZodTool({
      ...common,
      name: "discover_forge",
      description: "Read FORGE's public API description (endpoints, prices, network) and its supported markets. Free.",
      inputSchema: z.object({}),
      run: wrap("FORGE API", async () => {
        const doc = await get<unknown>("/x402");
        const ms = await markets();
        log("FORGE API", `discovered ${ms.length} markets: ${ms.map((m) => m.name).join(", ")}`);
        return { api: doc, markets: ms.map((m) => ({ market: m.name, price: m.poolPrice })) };
      }),
    }),
    betaZodTool({
      ...common,
      name: "request_hedge",
      description: "Ask FORGE to construct hedge alternatives for one exposure. Paid per call in USDC over x402 (FORGE states the price; calls above the per-call cap or the remaining API budget are refused before anything is signed). Returns verified alternatives with certificate hashes.",
      inputSchema: z.object({
        symbol: z.string(),
        units: z.number().describe("Tokens to protect; at most what the treasury holds"),
        max_premium_usd: z.number().describe("Most premium this hedge may cost; within the policy's budget"),
        objective: z.string().describe("The protection wanted, in plain words, including the decline to cover and the upside preference"),
      }),
      run: wrap("Treasury Agent", async (a: { symbol: string; units: number; max_premium_usd: number; objective: string }) => {
        const held = policy.holdings.find((h) => h.symbol.toLowerCase() === a.symbol.toLowerCase());
        if (!held) throw new Error(`${a.symbol} is not in the treasury`);
        const bal = await balances(key.address);
        const m = (await markets()).find((x) => x.name.split("/")[0]!.toLowerCase() === a.symbol.toLowerCase());
        if (!m) throw new Error(`FORGE has no ${a.symbol} market`);
        const have = bal.get(m.baseMint) ?? 0;
        if (a.units > have + 1e-9) throw new Error(`asked to hedge ${a.units} ${a.symbol}, treasury holds ${have}`);
        if (a.max_premium_usd > policy.hedge_premium_budget_usd) throw new Error(`premium ${a.max_premium_usd} exceeds the policy budget ${policy.hedge_premium_budget_usd}`);
        const remaining = policy.api_budget_usd - ledger.spent;
        const cap = Math.min(policy.api_max_per_call_usd, remaining);
        if (cap <= 0) throw new Error("API budget used up");
        log("Treasury Agent", `requesting a hedge: ${a.units.toLocaleString("en-US")} ${a.symbol}, premium ≤ ${usd(a.max_premium_usd)}`);
        const body = JSON.stringify({
          objective: `${a.objective} Hedge ${a.units} ${a.symbol}. Maximum premium ${a.max_premium_usd} USD.`,
          portfolio: [{ symbol: a.symbol, amount: a.units }],
          usdc: Math.min(bal.get(USDC) ?? 0, a.max_premium_usd * 5),
        });
        let price = 0;
        const res = await fetchWithPayment(`${API}/x402/hedge`, { method: "POST", headers: { "content-type": "application/json" }, body }, key, {
          maxAtomicPerRequest: BigInt(Math.floor(cap * 1e6)),
          onPayment: (p) => {
            price = Number(p.amount) / 1e6;
            log("FORGE API", `402 Payment required: ${price} USDC (cap ${cap.toFixed(4)})`);
          },
        }).catch((e) => {
          if (e instanceof X402ClientError) throw new Error(`payment refused: ${e.message}`);
          throw e;
        });
        if (res.paid) {
          ledger.spent += price;
          const tx = (res.settlement as { transaction?: string } | null)?.transaction ?? null;
          ledger.calls.push({ url: "/x402/hedge", usdc: price, tx });
          log("Payment", `settled on the fork${tx ? ` (${tx.slice(0, 12)}…)` : ""}; API spend ${usd(ledger.spent)} of ${usd(policy.api_budget_usd)}`);
        }
        const text = await res.response.text();
        if (!res.response.ok) throw new Error(`FORGE answered ${res.response.status}: ${text.slice(0, 300)}`);
        const d = JSON.parse(text) as { message: string; options: Option[]; steps: { tool: string; ok: boolean; summary: string }[] };
        for (const s of d.steps ?? []) log("FORGE Architect", `${s.ok ? "✓" : "✕"} ${s.tool}: ${s.summary}`);
        for (const o of d.options) options.set(o.construction_id, o);
        return {
          forge_message: d.message,
          options: d.options.map((o) => ({ option_id: o.construction_id, title: o.title, summary: o.summary, tradeoffs: o.tradeoffs, recommended: o.recommended, facts: o.facts })),
        };
      }),
    }),
    betaZodTool({
      ...common,
      name: "inspect_option",
      description: "Independently re-verify an option's certificate with FORGE's verifier and check it against the treasury policy (market, size, premium budget, protected value at the policy's maximum decline). Free. An option must pass before it can be submitted.",
      inputSchema: z.object({ option_id: z.string() }),
      run: wrap("Treasury Agent", async ({ option_id }: { option_id: string }) => {
        const o = options.get(option_id);
        if (!o) throw new Error(`unknown option ${option_id}`);
        const f = o.facts;
        const stored = await get<Record<string, unknown>>(`/compiler/certificates/${f.certificate_hash}`).catch(() => null);
        const v = await post<{ valid: boolean; hash: string }>("/x402/verify", stored ?? o.certificate);
        const held = policy.holdings.find((h) => f.market.toLowerCase().startsWith(h.symbol.toLowerCase() + "/"));
        const floorOk = f.floor_price == null ? false : f.floor_price >= f.spot_at_compile * (1 - policy.max_decline) - 1e-12;
        const checks = {
          certificate_verified: v.valid && v.hash === f.certificate_hash,
          certificate_published: stored != null,
          compiled_within_tolerance: f.status === "ok",
          market_held: !!held,
          size_within_holdings: !!held && f.units <= held.amount + 1e-9,
          premium_within_budget: f.premium_budget_usd <= policy.hedge_premium_budget_usd + 1e-9,
          covers_max_decline: floorOk,
          funded_liquidity: f.funded_liquidity_ok === true,
        };
        const pass = Object.values(checks).every(Boolean);
        inspected.set(option_id, pass);
        log("Verifier", `${o.title}: ${pass ? "all policy checks pass" : `fails ${Object.entries(checks).filter(([, x]) => !x).map(([k]) => k).join(", ")}`} · bound ±${usd(f.certified_error_bound_usd)}`);
        return { option_id, pass, checks, certified_error_bound_usd: f.certified_error_bound_usd };
      }),
    }),
    betaZodTool({
      ...common,
      name: "submit_for_authorization",
      description: "Submit the chosen option to the treasury's human signer. Only options that passed inspect_option qualify. Ends the run; nothing is signed until the human approves.",
      inputSchema: z.object({ option_id: z.string(), rationale: z.string() }),
      run: wrap("Treasury Agent", async ({ option_id, rationale }: { option_id: string; rationale: string }) => {
        const o = options.get(option_id);
        if (!o) throw new Error(`unknown option ${option_id}`);
        if (inspected.get(option_id) !== true) throw new Error("this option has not passed inspect_option");
        chosen = { option: o, rationale };
        log("Treasury Agent", `constraints checked; awaiting authorization for "${o.title}"`);
        return { submitted: true };
      }),
    }),
  ];
}

const SYSTEM = `You are the treasury agent of a DAO. You manage risk for its token treasury according to its policy. You are a customer of FORGE, an external Solana service that constructs certified hedges from on-chain liquidity and charges per request in USDC over x402.

Work like this: read the treasury, decide which exposure the policy says to protect (by USD value), discover what FORGE supports, request a hedge for that exposure within the policy's premium budget, inspect every option you might choose, and submit one for the human signer's authorization. If a request fails or no option passes inspection, adjust (a smaller size, a different floor within the policy, a cheaper structure) without exceeding any budget, and explain what you changed. You pay real (test-environment) money for each request, so do not request more than needed. You never sign or send transactions yourself. Report in short sentences.`;

async function execute(key: KeyPairSigner, o: Option) {
  const ms = await markets();
  const m = ms.find((x) => x.name === o.facts.market)!;
  const bal = await rpc<{ value: { pubkey: string; account: { data: { parsed: { info: { mint: string } } } } }[] }>("getTokenAccountsByOwner", [key.address, { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" }, { encoding: "jsonParsed" }]);
  const acct = (mint: string) => bal.value.find((a) => a.account.data.parsed.info.mint === mint)?.pubkey;
  const body = { ...o.open, owner: key.address, nonce: String(Date.now()), userBase: acct(m.baseMint), userQuote: acct(USDC) };
  for (let guard = 0; guard < 24; guard++) {
    const r = await post<{ transactions: { transaction: string }[]; done: boolean; strategy?: string; steps?: number }>("/tx/build/open", body);
    if (r.done || r.transactions.length === 0) return log("Treasury Agent", `position ${r.strategy ?? ""} open`);
    const tx = await signTransaction([key.keyPair], getTransactionDecoder().decode(Buffer.from(r.transactions[0]!.transaction, "base64")));
    const sig = await rpc<string>("sendTransaction", [getBase64EncodedWireTransaction(tx), { encoding: "base64" }]);
    for (let i = 0; i < 60; i++) {
      const st = await rpc<{ value: ({ confirmationStatus?: string; err: unknown } | null)[] }>("getSignatureStatuses", [[sig]]);
      if (st.value[0]?.err) throw new Error(`${sig} failed`);
      if (st.value[0]?.confirmationStatus === "confirmed" || st.value[0]?.confirmationStatus === "finalized") break;
      await new Promise((res) => setTimeout(res, 300));
    }
    log("Solana (fork)", `confirmed ${sig.slice(0, 16)}…`);
    if (r.steps === 1) return log("Treasury Agent", `position ${r.strategy ?? ""} open`);
  }
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) throw new Error("Set ANTHROPIC_API_KEY.");
  const key = await treasuryKey();
  log("Treasury Agent", `${policy.name} · ${key.address.slice(0, 8)}… · FORGE at ${API} · ${MODEL}`);
  const runner = new Anthropic().beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 8_000,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    system: SYSTEM,
    tools: tools(key),
    messages: [{ role: "user", content: `Policy objective: ${policy.objective}` }],
    thread: false,
    max_iterations: 16,
    stream: true,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  });
  let text = "";
  for await (const stream of runner) {
    stream.on("text", (d) => (text += d));
    const msg = await stream.finalMessage();
    if (text.trim()) log("Treasury Agent", text.trim().replace(/\s+/g, " ").slice(0, 400));
    text = "";
    if (msg.stop_reason === "refusal" || msg.stop_reason === "max_tokens") {
      log("Treasury Agent", `stopped: ${msg.stop_reason}`);
      break;
    }
  }
  log("Ledger", `API spend ${usd(ledger.spent)} over ${ledger.calls.length} paid call(s); budget ${usd(policy.api_budget_usd)}`);
  const c = chosen as { option: Option; rationale: string } | null;
  if (!c) return log("Treasury Agent", "no option submitted");
  const f = c.option.facts;
  console.log(`\nAuthorization request\n  ${c.option.title}: ${f.units} ${String(f.market).split("/")[0]}, floor ${f.floor_price}, cap ${f.cap_price ?? "none"}, premium ≤ ${usd(f.premium_budget_usd)}, bound ±${usd(f.certified_error_bound_usd)}\n  certificate ${f.certificate_hash}\n  ${c.rationale}\n`);
  if (!process.stdin.isTTY) return log("Treasury Agent", "no terminal to approve from; not executed");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const yes = /^y(es)?$/i.test((await rl.question("Authorize opening it on the FORGE fork? [y/N] ")).trim());
  rl.close();
  if (!yes) return log("Treasury Agent", "declined by the signer; nothing sent");
  await execute(key, c.option);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
