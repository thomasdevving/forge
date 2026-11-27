import { describe, expect, it } from "vitest";
import { check } from "../src/proxy.js";

const r = (method: string, params: unknown[] = []) => ({ jsonrpc: "2.0", id: 1, method, params });

describe("public RPC filter", () => {
  it("allows reads and signed transaction submission", () => {
    expect(check(r("getAccountInfo"))).toBeNull();
    expect(check(r("sendTransaction"))).toBeNull();
    expect(check(r("simulateTransaction"))).toBeNull();
  });
  it("blocks cheatcodes, airdrops and account mutation", () => {
    for (const m of ["surfnet_setAccount", "surfnet_timeTravel", "surfnet_setTokenAccount", "requestAirdrop", "surfnet_resetNetwork"]) {
      expect(check(r(m))).not.toBeNull();
    }
  });
  it("limits program scans to FORGE", () => {
    expect(check(r("getProgramAccounts", ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"]))).not.toBeNull();
    expect(check(r("getProgramAccounts", ["8RQGTBgTpbvxZ9BFHpFthHRw5JkaHiUpfrMmjfUv3NN5"]))).toBeNull();
  });
  it("only allows subscription methods over websockets", () => {
    expect(check(r("accountSubscribe"), true)).toBeNull();
    expect(check(r("sendTransaction"), true)).not.toBeNull();
  });
});
