// Extract benchmark summaries from the newest committed results folder that has each file.
// The landing page shows only these measured numbers; nothing is typed in by hand.
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
const runs = readdirSync(results).sort().reverse();
const latest = (file) => {
  const run = runs.find((r) => existsSync(resolve(results, r, file)));
  return run ? { run, data: JSON.parse(readFileSync(resolve(results, run, file), "utf8")) } : null;
};
const rep = latest("replication.json");
const real = latest("realized.json");
const lp = latest("lp_guarantee.json");
const doc = {
  replication: rep && {
    run: rep.run,
    summary: rep.data.summary,
    boundViolations: rep.data.bound_violations.length,
    payoffs: rep.data.summary["optimizer/deep"].payoffs,
  },
  realized: real && {
    run: real.run,
    rows: real.data.rows.map((r) => ({
      payoff: r.payoff, move: r.move, close: r.close_price, target: r.target, construction: r.construction,
      bound: r.certified_bound, gross: r.realized_full_gross, net: r.realized_net, premium: r.premium,
      feeCredits: r.fee_credits, swapCost: r.restoration_swap_cost, gap: r.gap_to_construction,
      spot: r.spot, legs: r.legs, detail: r.construction_detail ?? null, breakpoints: r.target_breakpoints ?? null,
    })),
  },
  lpGuarantee: lp && {
    run: lp.run,
    seed: lp.data.seed,
    summary: lp.data.summary,
  },
};
writeFileSync(out, JSON.stringify(doc, null, 1) + "\n");
console.log(`wrote ${out} (replication ${rep?.run}, realized ${real?.run}, lp ${lp?.run})`);
