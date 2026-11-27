/**
 * Bootstrap FORGE on a running Surfpool mainnet fork:
 *   deploy the program, set the admin, publish the fork reference, register the SOL/USDC
 *   market (target: Orca SOL/USDC ts64, restoration swaps: the separate ts4 pool), create a
 *   ladder of buckets around the price and seed LP liquidity. Fork-only funds throughout.
 *
 * Usage: pnpm --filter @forge/fork bootstrap   (requires fork/start.sh running)
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { address, type Address } from "@solana/kit";
import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";
import {
  createBucketIx,
  defaultParams,
  depositLiquidityIx,
  fetchBucket,
  fetchMarket,
  FORGE_PROGRAM_ID,
  initializeConfigIx,
  initializeMarketIx,
  pdas,
  readPool,
} from "@forge/txbuilder";
import { tickIndexToSqrtPrice } from "@orca-so/whirlpools-core";
import { createLookupTable, marketAddresses } from "../src/alt.js";
import { DEPLOYMENT_FILE, fundWallet, loadKey, readDeployment, ROOT, writeDeployment } from "../src/env.js";
import { FEED_SOL_USD, FEED_USDC_USD, PYTH_SOL_USD, PYTH_USDC_USD, setScenarioPrice } from "../src/pyth.js";
import { airdrop, assertFork, FORK_RPC_URL, forkRpc, rawAccount, sendInstructions, SOL_USDC_TS4, SOL_USDC_TS64, USDC, WSOL } from "../src/surfnet.js";

const rpc = forkRpc();
const BUCKETS_EACH_SIDE = Number(process.env.FORGE_BUCKETS_EACH_SIDE ?? 8);
const BUCKET_MULTIPLIER = 4; // brief default: 4 x tick spacing (ts64 -> 256 ticks, ~2.6%)
const LP_QUOTE_PER_BUCKET = 50_000_000_000n; // 50k USDC of liquidity per bucket (fork funds)

const hex = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));

async function deployProgram(deployerPath: string) {
  const so = resolve(ROOT, "target/deploy/forge.so");
  const kp = resolve(ROOT, "target/deploy/forge-keypair.json");
  if (!existsSync(so)) throw new Error("build the program first: anchor build");
  const existing = await rawAccount(rpc, FORGE_PROGRAM_ID);
  console.log(existing ? "upgrading program" : "deploying program");
  execFileSync("solana", ["program", "deploy", so, "--program-id", kp, "--keypair", deployerPath, "--upgrade-authority", deployerPath, "--url", FORK_RPC_URL, "--use-rpc"], {
    stdio: "inherit",
  });
}

async function main() {
  const surf = await assertFork();
  console.log(`surfnet ${surf} at ${FORK_RPC_URL}; program ${FORGE_PROGRAM_ID}`);
  const deployer = await loadKey("deployer");
  const admin = await loadKey("admin");
  const refSigner = await loadKey("reference");
  const keeper = await loadKey("keeper");
  for (const k of [deployer, admin, refSigner, keeper]) await airdrop(rpc, k.address, 100);

  const deployerPath = process.env.FORGE_DEPLOYER_KEYPAIR ?? resolve(process.env.HOME!, ".config/solana/forge-deployer.json");
  await deployProgram(deployerPath);

  if (!(await rawAccount(rpc, await pdas.config()))) {
    await sendInstructions(rpc, deployer, [await initializeConfigIx(deployer, admin.address)]);
    console.log(`config: admin ${admin.address}`);
  }

  // Fork reference: start at the target pool's own price (USDC at $1). Explicit scenario mode.
  const target = await readPool(rpc, SOL_USDC_TS64);
  const swap = await readPool(rpc, SOL_USDC_TS4);
  const price = (Number(target.sqrtPrice) / 2 ** 64) ** 2 * 1e3;
  const swapPrice = (Number(swap.sqrtPrice) / 2 ** 64) ** 2 * 1e3;
  console.log(`target pool ${price.toFixed(4)}, restoration pool ${swapPrice.toFixed(4)}`);
  await setScenarioPrice(PYTH_SOL_USD, FEED_SOL_USD, price);
  await setScenarioPrice(PYTH_USDC_USD, FEED_USDC_USD, 1.0);

  const market = await pdas.market(SOL_USDC_TS64);
  if (!(await rawAccount(rpc, market))) {
    const { ix } = await initializeMarketIx({
      admin,
      whirlpool: SOL_USDC_TS64,
      swapPool: SOL_USDC_TS4,
      baseMint: WSOL,
      quoteMint: USDC,
      bucketMultiplier: BUCKET_MULTIPLIER,
      params: defaultParams(),
      reference: {
        kind: "PythPair",
        base_account: PYTH_SOL_USD,
        quote_account: PYTH_USDC_USD,
        base_feed_id: hex(FEED_SOL_USD),
        quote_feed_id: hex(FEED_USDC_USD),
      },
    });
    await sendInstructions(rpc, admin, [ix]);
    console.log(`market ${market}`);
  }
  const m = await fetchMarket(rpc, market);
  const width = m.bucket_width;
  // Keep the original ladder and reference price across re-runs (e.g. program upgrades):
  // re-centering on a moved fork price would silently change every test's starting point.
  const prior = existsSync(DEPLOYMENT_FILE) ? readDeployment().markets["SOL/USDC"] : undefined;
  const keepPrior = prior?.market === market && prior.buckets.length > 0;
  const center = keepPrior
    ? prior!.buckets[Math.floor(prior!.buckets.length / 2)]!.tickLower
    : Math.floor(target.tickCurrentIndex / width) * width;
  const initialPrice = keepPrior ? prior!.scenarioPrice : price;
  const lowers: number[] = [];
  for (let k = -BUCKETS_EACH_SIDE; k <= BUCKETS_EACH_SIDE; k++) lowers.push(center + k * width);

  const buckets: { tickLower: number; tickUpper: number; address: Address }[] = [];
  for (const tl of lowers) {
    const { bucket, ix } = await createBucketIx(admin, market, m, tl);
    if (!(await rawAccount(rpc, bucket))) {
      await sendInstructions(rpc, admin, [getSetComputeUnitLimitInstruction({ units: 400_000 }), ix]);
    }
    buckets.push({ tickLower: tl, tickUpper: tl + width, address: bucket });
  }
  console.log(`buckets: ${buckets.length} of width ${width} ticks around tick ${target.tickCurrentIndex}`);

  // Seed LP liquidity: the same L in every bucket, sized so a bucket below price holds 50k USDC.
  const lp = await loadKey("lp").catch(async () => {
    execFileSync("solana-keygen", ["new", "--no-bip39-passphrase", "--silent", "-o", resolve(process.env.HOME!, ".config/solana/forge-lp.json")]);
    return loadKey("lp");
  });
  const lpAcc = await fundWallet(rpc, lp, { sol: 20, wsol: 20_000_000_000_000n, usdc: 20_000_000_000_000n, usdcMint: USDC });
  const span = tickIndexToSqrtPrice(center) - tickIndexToSqrtPrice(center - width);
  const L = (LP_QUOTE_PER_BUCKET << 64n) / span;
  for (const b of buckets) {
    const bk = await fetchBucket(rpc, b.address);
    if (bk.total_liquidity > 0n) continue;
    const pool = await readPool(rpc, SOL_USDC_TS64);
    const ix = await depositLiquidityIx({ lp, market, m, bucket: b.address, b: bk, pool, liquidity: L, lpBase: lpAcc.wsol, lpQuote: lpAcc.usdc });
    await sendInstructions(rpc, lp, [getSetComputeUnitLimitInstruction({ units: 400_000 }), ix]);
  }
  console.log(`seeded L=${L} per bucket from LP ${lp.address}`);

  // Market lookup table (section 8.5). Reused across runs while the fork keeps its state.
  let lookupTable: Address | undefined;
  if (existsSync(DEPLOYMENT_FILE)) {
    const prev = readDeployment().markets["SOL/USDC"]?.lookupTable;
    if (prev && (await rawAccount(rpc, prev))) lookupTable = prev;
  }
  if (!lookupTable) {
    const bks = await Promise.all(buckets.map(async (b) => ({ address: b.address, b: await fetchBucket(rpc, b.address) })));
    const addrs = await marketAddresses(rpc, market, m, bks);
    lookupTable = await createLookupTable(rpc, admin, addrs);
    console.log(`lookup table ${lookupTable} with ${addrs.length} addresses`);
  }

  writeDeployment({
    programId: FORGE_PROGRAM_ID,
    cluster: "surfpool-fork",
    genesisNote: `surfnet ${surf}; mainnet fork, fork-only balances`,
    admin: admin.address,
    referenceSigner: refSigner.address,
    markets: {
      "SOL/USDC": {
        market,
        whirlpool: SOL_USDC_TS64,
        swapPool: SOL_USDC_TS4,
        baseMint: WSOL,
        quoteMint: USDC,
        referenceKind: "PythPair",
        referenceBase: PYTH_SOL_USD,
        referenceQuote: PYTH_USDC_USD,
        buckets,
        lookupTable,
        scenarioPrice: initialPrice,
      },
    },
  });
  console.log("wrote fork/.state/deployment.json");
  void address;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
