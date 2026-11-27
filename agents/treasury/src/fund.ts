/**
 * Give the treasury its simulated portfolio on the FORGE fork: the tokens in policy.json plus USDC for
 * premiums and API payments. Uses Surfpool cheatcodes on the raw fork RPC, so it only works against a
 * fork you run (FORK_RPC_URL, default http://127.0.0.1:8899). Refuses anything that does not answer the
 * Surfpool-only cheatcode, so it can never be pointed at mainnet.
 *
 *   pnpm --filter @forge/treasury-agent setup
 */
import { log, markets, policy, treasuryKey, USDC } from "./common.js";

const FORK = process.env.FORK_RPC_URL ?? "http://127.0.0.1:8899";

async function call(method: string, params: unknown[]) {
  const r = await fetch(FORK, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = (await r.json()) as { result?: unknown; error?: { message: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

const key = await treasuryKey();
await call("surfnet_getSurfnetInfo", []).catch(() => {
  throw new Error(`${FORK} is not a Surfpool fork; refusing to fund anything.`);
});
const ms = await markets();
const decimals = async (mint: string) => {
  const r = (await call("getAccountInfo", [mint, { encoding: "jsonParsed" }])) as { value: { data: { parsed: { info: { decimals: number } } } } };
  return r.value.data.parsed.info.decimals;
};
const set = async (mint: string, ui: number) => {
  const d = await decimals(mint);
  await call("surfnet_setTokenAccount", [key.address, mint, { amount: Math.round(ui * 10 ** d), state: "initialized" }]);
};

await call("surfnet_setAccount", [key.address, { lamports: 2_000_000_000 }]);
for (const h of policy.holdings) {
  const m = ms.find((x) => x.name.split("/")[0]!.toLowerCase() === h.symbol.toLowerCase());
  if (!m) {
    log("setup", `${h.symbol}: no FORGE market, not funded`);
    continue;
  }
  await set(m.baseMint, h.amount);
  log("setup", `${h.symbol} ${h.amount.toLocaleString("en-US")}`);
}
await set(USDC, policy.usdc);
log("setup", `USDC ${policy.usdc} · treasury ${key.address}`);
