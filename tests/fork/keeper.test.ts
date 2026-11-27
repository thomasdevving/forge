/**
 * Keeper (fork): a position whose accrued premium reaches the keeper trigger is checkpointed and
 * closed by the keeper service, which collects the bounty. Before the trigger it is left alone.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { fetchStrategy } from "@forge/txbuilder";
import { loadKey } from "@forge/fork/env";
import { runKeeperCycle } from "@forge/fork/keeper";
import { advance, newUser, openPut, rpc, setup, sol } from "../src/harness.js";

describe("keeper service (fork)", () => {
  beforeAll(setup);

  it("leaves a fresh position open, then closes it once the premium budget hits the trigger", async () => {
    const keeper = await loadKey("keeper");
    const u = await newUser();
    // a small borrow with a 1 USDC budget: the time floor alone reaches 80% of the cap within days
    // a bucket at the bottom of the ladder is below the price wherever the market currently sits
    const strategy = await openPut(u, [sol.buckets[1]!.tickLower], BigInt(Date.now()), { fraction: 8n, budget: 1_000_000n });

    await runKeeperCycle(keeper);
    const before = await fetchStrategy(rpc, strategy);
    expect(before.state).toBe("Open");

    await advance(5 * 86_400);
    await runKeeperCycle(keeper);
    const after = await fetchStrategy(rpc, strategy);
    expect(after.state).toBe("Closed");
    expect(after.keeper).toBe(keeper.address);
    expect(after.keeper_bounty_paid).toBeGreaterThan(0n);
    expect(after.premium_accrued * 10_000n).toBeGreaterThanOrEqual((after.premium_budget - after.bounty_reserve) * BigInt(after.keeper_trigger_bps));
  });
});
