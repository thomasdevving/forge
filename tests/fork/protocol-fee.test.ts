/**
 * Pricing (fork): the hybrid multiplier and the protocol fee. A closed position pays its premium from
 * the budget; LPs are credited the premium less the protocol's share, which is a fraction of the
 * premium above the forgone fees only; the admin (and only the admin) can withdraw what accrued.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { getCreateAssociatedTokenIdempotentInstructionAsync } from "@solana-program/token";
import { buildClose, fetchBucket, fetchMarket, fetchStrategy, forgeIx, pdas, TOKEN_PROGRAM_ID } from "@forge/txbuilder";
import { loadKey } from "@forge/fork/env";
import { advance, ata, newUser, openPut, rpc, send, setup, sol, tokenAmount, USDC } from "../src/harness.js";

describe("pricing and protocol fee (fork)", () => {
  beforeAll(setup);

  it("uses the hybrid curve and the protocol fee by default", async () => {
    const m = await fetchMarket(rpc, sol.market);
    expect(m.params.curve).toEqual({ base_ppm: 1_100_000, slope1_ppm: 0, kink_ppm: 600_000, slope2_ppm: 6_000_000, cap_ppm: 800_000 });
    expect(m.params.protocol_fee_bps).toBe(1_000);
  });

  it("splits a closed position's premium between LPs and the protocol, never below forgone fees", async () => {
    const u = await newUser();
    const bucket = sol.buckets[1]!;
    const before = await fetchMarket(rpc, sol.market);
    const bBefore = await fetchBucket(rpc, bucket.address);
    const strategy = await openPut(u, [bucket.tickLower], BigInt(Date.now()), { fraction: 8n, budget: 50_000_000n });
    await advance(3 * 86_400);
    for (const ixs of await buildClose(rpc, { caller: u.user, market: sol.market, strategy, userBase: u.wsol, userQuote: u.usdc })) {
      await send(u.user, ixs);
    }
    const s = await fetchStrategy(rpc, strategy);
    expect(s.state).toBe("Closed");
    expect(s.protocol_fee_bps).toBe(1_000);
    const leg = s.legs[0]!;
    expect(leg.premium).toBeGreaterThan(0n);
    // exact program rule: 10% of the excess over forgone fees, rounded down
    const excess = leg.premium > leg.cum_forgone_quote ? leg.premium - leg.cum_forgone_quote : 0n;
    expect(leg.protocol_fee).toBe((excess * 1_000n) / 10_000n);
    expect(s.protocol_fee_paid).toBe(leg.protocol_fee);
    // LPs keep the rest, which is never less than the forgone fees
    const lpCredit = (await fetchBucket(rpc, bucket.address)).premium_distributed - bBefore.premium_distributed;
    expect(lpCredit).toBe(s.premium_paid - s.protocol_fee_paid);
    expect(lpCredit).toBeGreaterThanOrEqual(leg.cum_forgone_quote);
    // booked on the market at finalize
    const after = await fetchMarket(rpc, sol.market);
    expect(after.protocol_fees - before.protocol_fees).toBe(s.protocol_fee_paid);
  });

  it("lets only the admin withdraw protocol fees", async () => {
    const admin = await loadKey("admin");
    const m = await fetchMarket(rpc, sol.market);
    expect(m.protocol_fees).toBeGreaterThan(0n);
    const vault = await pdas.vault(sol.market);
    const outsider = await newUser();
    const accounts = (signer: typeof admin, destination: Awaited<ReturnType<typeof ata>>) => ({
      admin: signer, market: sol.market, vault, premium_vault: m.premium_vault, destination, token_program: TOKEN_PROGRAM_ID,
    });
    // an outsider cannot take them
    await expect(send(outsider.user, [forgeIx("withdraw_protocol_fees", accounts(outsider.user, outsider.usdc), { amount: 1n })])).rejects.toThrow();

    const dest = await ata(admin.address, USDC);
    await send(admin, [await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: admin, owner: admin.address, mint: USDC })]);
    const bal = await tokenAmount(dest);
    await send(admin, [forgeIx("withdraw_protocol_fees", accounts(admin, dest), { amount: m.protocol_fees })]);
    expect(await tokenAmount(dest)).toBe(bal + m.protocol_fees);
    expect((await fetchMarket(rpc, sol.market)).protocol_fees).toBe(0n);
    // and never more than accrued
    await expect(send(admin, [forgeIx("withdraw_protocol_fees", accounts(admin, dest), { amount: 1n })])).rejects.toThrow();
  });
});
