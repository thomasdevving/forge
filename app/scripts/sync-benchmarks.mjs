// Extract benchmark summaries for one market from the newest committed results folder that has each file.
// The landing page shows only these measured numbers; nothing is typed in by hand.
// Market: --market NAME or FORGE_PROOF_MARKET (default JUP/USDC). Files without a market field are SOL/USDC.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const results = resolve(here, "../../benchmarks/results");
const out = resolve(here, "../src/data/benchmarks.json");
if (!existsSync(results)) {
  console.log("no benchmarks/results folder; keeping existing src/data/benchmarks.json");
  process.exit(0);
}
const argi = process.argv.indexOf("--market");
const market = argi > 0 ? process.argv[argi + 1] : (process.env.FORGE_PROOF_MARKET ?? "JUP/USDC");
const runs = readdirSync(results).sort().reverse();
const latest = (file) => {
  for (const run of runs) {
    const path = resolve(results, run, file);
    if (!existsSync(path)) continue;
    const data = JSON.parse(readFileSync(path, "utf8"));
    const rowsOk = !("rows" in data) || data.rows.length > 0;
    const name = typeof data.market === "object" && data.market ? data.market.name : (data.market ?? "SOL/USDC");
    if (name === market && rowsOk) return { run, data };
  }
  return null;
};
const rep = latest("replication.json");
const real = latest("realized.json");
const lp = latest("lp_guarantee.json");
const doc = {
  market,
  replication: rep && {
    run: rep.run,
    summary: rep.data.summary,
    boundViolations: rep.data.bound_violations.length,
    spot: rep.data.spot ?? null,
    units: rep.data.units ?? null,
    payoffs: rep.data.summary["optimizer/deep"].payoffs,
  },
  realized: real && {
    run: real.run,
    refused: real.data.rows.filter((r) => r.status === "refused").map((r) => ({ payoff: r.payoff, move: r.move, guard: r.guard })),
    rows: real.data.rows.filter((r) => r.status !== "refused").map((r) => ({
      units: r.units ?? null, slippageBps: r.swap_slippage_bps ?? null, payoff: r.payoff, move: r.move, close: r.close_price, target: r.target, construction: r.construction,
      bound: r.certified_bound, gross: r.realized_full_gross, net: r.realized_net, premium: r.premium,
      feeCredits: r.fee_credits, swapCost: r.restoration_swap_cost, gap: r.gap_to_construction,
      spot: r.spot, legs: r.legs, detail: r.construction_detail ?? null, breakpoints: r.target_breakpoints ?? null,
    })),
  },
  lpGuarantee: lp && {
    run: lp.run,
    seed: lp.data.seed,
    history: lp.data.history ?? null,
    summary: lp.data.summary,
  },
};
writeFileSync(out, JSON.stringify(doc, null, 1) + "\n");
console.log(`wrote ${out} for ${market} (replication ${rep?.run}, realized ${real?.run}, lp ${lp?.run})`);
