/**
 * Bootstrap FORGE on a running Surfpool mainnet fork: deploy the program, set the admin, and for
 * every market publish the fork reference, register the market (target Whirlpool + a separate
 * restoration Whirlpool), create a ladder of buckets around the price and seed LP liquidity.
 * Fork-only funds throughout. Any Orca Whirlpool works the same way; nothing is SOL-specific.
 *
 * Usage (requires fork/start.sh running):
 *   pnpm --filter @forge/fork bootstrap                         # SOL/USDC and JUP/USDC
 *   FORGE_MARKETS=JUP/USDC pnpm --filter @forge/fork bootstrap  # a subset of the built-in markets
 *   pnpm --filter @forge/fork bootstrap -- --mint <token mint>  # any token: pools and Pyth feeds are discovered
 *   pnpm --filter @forge/fork bootstrap -- --whirlpool <pool> --swap-pool <other pool> \
 *     --feed <pyth feed id of the base token> [--name ABC/USDC]  # or name the pools yourself
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { address } from "@solana/kit";
import { FORGE_PROGRAM_ID, initializeConfigIx, pdas } from "@forge/txbuilder";
import { type Deployment, DEPLOYMENT_FILE, loadKey, readDeployment, ROOT, writeDeployment } from "../src/env.js";
import { discoverMarket, setupMarket } from "../src/onboard.js";
import { MARKETS, type MarketSpec, specFromChain } from "../src/markets.js";
import { airdrop, assertFork, FORK_RPC_URL, forkRpc, rawAccount, sendInstructions } from "../src/surfnet.js";

const rpc = forkRpc();

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

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
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
  // FORGE_SKIP_DEPLOY=1 adds markets to an already deployed program without upgrading it
  if (process.env.FORGE_SKIP_DEPLOY === "1" && (await rawAccount(rpc, FORGE_PROGRAM_ID))) console.log("program present; skipping deploy");
  else await deployProgram(deployerPath);

  if (!(await rawAccount(rpc, await pdas.config()))) {
    await sendInstructions(rpc, deployer, [await initializeConfigIx(deployer, admin.address)]);
    console.log(`config: admin ${admin.address}`);
  }

  // Which markets: an explicit Whirlpool from the command line, or the built-in ones.
  const specs: MarketSpec[] = [];
  const wp = flag("whirlpool");
  const mint = flag("mint");
  if (mint) {
    const spec = await discoverMarket(mint);
    console.log(`discovered ${spec.name}: target ${spec.whirlpool}, restoration ${spec.swapPool}`);
    specs.push(spec);
  } else if (wp) {
    const feed = flag("feed");
    const swapPool = flag("swap-pool");
    if (!feed || !swapPool) throw new Error("--whirlpool needs --swap-pool and --feed <pyth feed id>");
    specs.push(await specFromChain(rpc, { whirlpool: address(wp), swapPool: address(swapPool), feedBase: feed.replace(/^0x/, ""), name: flag("name") }));
  } else {
    for (const name of (process.env.FORGE_MARKETS ?? Object.keys(MARKETS).join(",")).split(",")) {
      const s = MARKETS[name.trim()];
      if (!s) throw new Error(`unknown market ${name}`);
      specs.push(s);
    }
  }

  const previous = existsSync(DEPLOYMENT_FILE) ? readDeployment() : undefined;
  const markets: Deployment["markets"] = { ...(previous?.markets ?? {}) };
  for (const spec of specs) markets[spec.name] = await setupMarket(spec, admin, previous?.markets[spec.name]);

  writeDeployment({
    programId: FORGE_PROGRAM_ID,
    cluster: "surfpool-fork",
    genesisNote: `surfnet ${surf}; mainnet fork, fork-only balances`,
    admin: admin.address,
    referenceSigner: refSigner.address,
    markets,
  });
  console.log(`wrote fork/.state/deployment.json (${Object.keys(markets).join(", ")})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
