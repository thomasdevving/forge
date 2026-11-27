import { describe, expect, it } from "vitest";
import { AccountRole, address, generateKeyPairSigner } from "@solana/kit";
import { createHash } from "node:crypto";
import { decodeAccount, encodeArgs, encodeType, IDL, instructionDef } from "../src/idl.js";
import { forgeIx } from "../src/program.js";
import { defaultParams } from "../src/accounts.js";

const disc = (s: string) => [...createHash("sha256").update(s).digest().subarray(0, 8)];

describe("IDL coder", () => {
  it("uses Anchor discriminators", () => {
    expect(instructionDef("begin_open").discriminator).toEqual(disc("global:begin_open"));
    expect(IDL.accounts.find((a) => a.name === "Strategy")!.discriminator).toEqual(disc("account:Strategy"));
  });

  it("encodes integers little-endian with exact widths and rejects overflow", () => {
    const data = encodeArgs(instructionDef("update_scenario_reference"), { price_x64: (1n << 64n) + 5n, conf_bps: 7 });
    expect(data.length).toBe(8 + 16 + 2);
    expect(data[8]).toBe(5);
    expect(data[16]).toBe(1);
    expect(data[24]).toBe(7);
    expect(() => encodeArgs(instructionDef("update_scenario_reference"), { price_x64: 1n << 128n, conf_bps: 0 })).toThrow();
  });

  it("encodes vectors, options, enums and nested structs", () => {
    const p = defaultParams();
    const b = encodeType("MarketParams", p);
    // floor u16 + curve 5*u32 + notice u32 + 4*u16 + u32 + 2*u16 + u32 + 3*u16... computed by layout
    expect(b.length).toBeGreaterThan(30);
    const upd = encodeArgs(instructionDef("update_market"), { params: null, opens_paused: true, borrow_paused: null });
    expect([...upd.subarray(8)]).toEqual([0, 1, 1, 0]);
    const batch = encodeArgs(instructionDef("execute_open_batch"), { leg_indices: [0, 1] });
    expect([...batch.subarray(8)]).toEqual([2, 0, 0, 0, 0, 1]);
  });

  it("round-trips an account through decode", () => {
    const acc = IDL.accounts.find((a) => a.name === "ScenarioReference")!;
    const body = encodeType("ScenarioReference", {
      market_whirlpool: address("HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ"),
      signer: address("11111111111111111111111111111111"),
      price_x64: 123n,
      conf_bps: 5,
      publish_time: -1n,
      bump: 254,
    });
    const data = new Uint8Array([...acc.discriminator, ...body]);
    const d = decodeAccount<{ price_x64: bigint; publish_time: bigint; bump: number }>("ScenarioReference", data);
    expect(d.price_x64).toBe(123n);
    expect(d.publish_time).toBe(-1n);
    expect(d.bump).toBe(254);
    expect(() => decodeAccount("Market", data)).toThrow();
  });

  it("builds instructions with IDL account order and signer flags", async () => {
    const owner = await generateKeyPairSigner();
    const strategy = address("HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ");
    const ix = forgeIx("finalize_open", { owner, strategy });
    expect(ix.accounts![0]!.address).toBe(owner.address);
    expect(ix.accounts![0]!.role).toBe(AccountRole.READONLY_SIGNER);
    expect(ix.accounts![1]!.role).toBe(AccountRole.WRITABLE);
    expect(() => forgeIx("finalize_open", { owner: owner.address, strategy })).toThrow(/TransactionSigner/);
  });
});
