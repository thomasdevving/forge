/**
 * Create the fork-only keypairs a hosted stack needs (deployer, admin, reference, keeper, lp, and the
 * x402 treasury and facilitator) if they do not exist yet, in Solana CLI format (64-byte JSON array)
 * under FORGE_KEY_DIR. These keys only ever sign on the fork; they are generated inside the container
 * and never leave it.
 *
 * Usage: FORGE_KEY_DIR=/data/keys pnpm --dir fork exec tsx scripts/keys.ts
 */
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const dir = process.env.FORGE_KEY_DIR ?? resolve(homedir(), ".config/solana");
mkdirSync(dir, { recursive: true, mode: 0o700 });
for (const name of ["deployer", "admin", "reference", "keeper", "lp", "x402-treasury", "x402-facilitator"]) {
  const path = resolve(dir, `forge-${name}.json`);
  if (existsSync(path)) continue;
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  writeFileSync(path, JSON.stringify([...seed, ...pub]), { mode: 0o600 });
  console.log(`created ${name} key`);
}
