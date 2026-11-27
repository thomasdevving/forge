/**
 * FORGE keeper. Closing on someone else's behalf is permissionless once the program allows it; this
 * service is the "someone" that LPs rely on (Benchmark 4: without it, long borrows can out-run their
 * premium budget). Every cycle, for every position:
 *
 *  - Open: checkpoint each borrowed leg so `premium_accrued` is current on-chain, then close it if any
 *    on-chain trigger holds: expired, accrued premium at the keeper trigger (80% of the LP cap by
 *    default), or an LP's withdrawal notice has elapsed on one of its buckets. The program pays the
 *    keeper bounty (1% of the budget) into the keeper's quote account at finalize.
 *  - Opening, past its pending deadline: abort it, so a stalled open releases reserved liquidity.
 *  - Closing or in Recovery, started by this keeper: retry the remaining restorations (a price guard
 *    may have refused them earlier).
 *
 * Usage: pnpm --dir fork keeper     (env: KEEPER_INTERVAL_S, default 30)
 */
import {
  type Address,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  type Instruction,
  type KeyPairSigner,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { getCreateAssociatedTokenIdempotentInstructionAsync } from "@solana-program/token";
import {
  buildClose,
  checkpointLegIx,
  fetchBucket,
  fetchMarket,
  fetchStrategy,
  FORGE_PROGRAM_ID,
  forgeIx,
  IDL,
  loadLookupTables,
  prepareTransaction,
  rw,
} from "@forge/txbuilder";
import { ata, loadKey, readDeployment } from "./env.js";
import { airdrop, forkClock, forkRpc } from "./surfnet.js";

const rpc = forkRpc();
const INTERVAL = Number(process.env.KEEPER_INTERVAL_S ?? 30) * 1000;
const isBorrow = (tag: number) => tag <= 1;
const log = (...a: unknown[]) => console.log(new Date().toISOString(), "[keeper]", ...a);

const STRATEGY_DISC = getBase58Decoder().decode(Uint8Array.from(IDL.accounts.find((a) => a.name === "Strategy")!.discriminator));

async function strategyAddresses(): Promise<Address[]> {
  const res = (await rpc
    .getProgramAccounts(FORGE_PROGRAM_ID, {
      encoding: "base64",
      dataSlice: { offset: 0, length: 0 },
      filters: [{ memcmp: { offset: 0n, bytes: STRATEGY_DISC, encoding: "base58" } }] as never,
    })
    .send()) as unknown as { pubkey: Address }[];
  return res.map((r) => r.pubkey);
}

let tables: Record<Address, Address[]> = {};
async function refreshTables() {
  const d = readDeployment();
  tables = await loadLookupTables(rpc, Object.values(d.markets).map((m) => m.lookupTable));
}

async function send(keeper: KeyPairSigner, ixs: Instruction[]): Promise<string> {
  const prepared = await prepareTransaction(rpc, keeper, ixs, tables);
  const tx = await signTransactionMessageWithSigners(prepared.message);
  const sig = getSignatureFromTransaction(tx);
  await rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: "base64", skipPreflight: true }).send();
  for (let i = 0; i < 80; i++) {
    const { value } = await rpc.getSignatureStatuses([sig]).send();
    const st = value[0];
    if (st?.err) throw new Error(`${sig} failed: ${JSON.stringify(st.err, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return sig;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${sig} not confirmed`);
}

/** The program's crank_allowed: accrued · 10^4 ≥ lp_cap · trigger_bps. */
const budgetTrigger = (accrued: bigint, lpCap: bigint, triggerBps: number) => accrued * 10_000n >= lpCap * BigInt(triggerBps);

async function closeAs(keeper: KeyPairSigner, s: Awaited<ReturnType<typeof fetchStrategy>>, addr: Address, why: string) {
  const m = await fetchMarket(rpc, s.market);
  const keeperQuote = await ata(keeper.address, m.quote_mint);
  await send(keeper, [await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: keeper, owner: keeper.address, mint: m.quote_mint })]);
  const p = {
    caller: keeper,
    market: s.market,
    strategy: addr,
    keeperQuote,
    userBase: await ata(s.owner, m.base_mint),
    userQuote: await ata(s.owner, m.quote_mint),
  };
  const plan = await buildClose(rpc, p);
  log(`closing ${addr} (${why}): ${plan.length} transaction(s)`);
  for (const ixs of plan) await send(keeper, ixs);
  const done = await fetchStrategy(rpc, addr);
  log(`${addr} → ${done.state}, bounty ${done.keeper_bounty_paid}`);
}

/** One pass over every position. Exported for tests. */
export async function runKeeperCycle(keeper: KeyPairSigner) {
  await refreshTables();
  const now = BigInt((await forkClock()).unixTimestamp);
  for (const addr of await strategyAddresses()) {
    let s: Awaited<ReturnType<typeof fetchStrategy>>;
    try {
      s = await fetchStrategy(rpc, addr);
    } catch {
      continue;
    }
    try {
      if (s.state === "Open") {
        const borrowed = s.legs.map((l, i) => ({ l, i })).filter(({ l }) => l.executed && !l.restored && isBorrow(l.kind_tag));
        // bring premium_accrued up to date on-chain (one leg per instruction, two per transaction)
        for (let k = 0; k < borrowed.length; k += 2) {
          await send(keeper, await Promise.all(borrowed.slice(k, k + 2).map(({ i }) => checkpointLegIx(rpc, s.market, addr, i))));
        }
        const fresh = borrowed.length ? await fetchStrategy(rpc, addr) : s;
        const m = await fetchMarket(rpc, s.market);
        let notice = false;
        for (const { l } of borrowed) {
          const b = await fetchBucket(rpc, l.bucket);
          if (b.withdrawal_requested > 0n && b.withdrawal_notice_start > 0n && now >= b.withdrawal_notice_start + BigInt(m.params.notice_period_s)) notice = true;
        }
        const expired = fresh.expiry !== 0n && now >= fresh.expiry;
        const lpCap = fresh.premium_budget - fresh.bounty_reserve;
        const budget = borrowed.length > 0 && budgetTrigger(fresh.premium_accrued, lpCap, fresh.keeper_trigger_bps);
        if (expired || budget || notice) await closeAs(keeper, fresh, addr, expired ? "expired" : budget ? "premium budget at trigger" : "LP withdrawal notice");
      } else if (s.state === "PendingOpen" && s.pending_deadline !== 0n && now > s.pending_deadline) {
        const rem = s.legs.filter((l) => !l.executed && isBorrow(l.kind_tag)).map((l) => rw(l.bucket));
        await send(keeper, [forgeIx("abort_open", { caller: keeper, strategy: addr, market: s.market }, {}, rem)]);
        log(`aborted stalled open ${addr}`);
      } else if ((s.state === "PendingClose" || s.state === "Recovery") && s.keeper === keeper.address) {
        await closeAs(keeper, s, addr, `retry ${s.state}`);
      }
    } catch (e) {
      log(`${addr}: ${(e as Error).message.slice(0, 300)}`);
    }
  }
}

async function main() {
  const keeper = await loadKey("keeper");
  await airdrop(rpc, keeper.address, 50);
  await refreshTables();
  log(`running as ${keeper.address}, every ${INTERVAL / 1000}s`);
  for (;;) {
    try {
      await runKeeperCycle(keeper);
    } catch (e) {
      log(`cycle failed: ${(e as Error).message.slice(0, 300)}`);
    }
    await new Promise((r) => setTimeout(r, INTERVAL));
  }
}

// run as a service only when started directly (tests import runKeeperCycle)
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!)) void main();
