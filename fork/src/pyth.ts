/**
 * Pyth reference on the fork. Pyth `PriceUpdateV2` accounts are cached by Surfpool at first
 * fetch and then go stale. Two explicit modes:
 *
 *  - live:     re-read the real mainnet account and write it back with its real values (used
 *              when the fork price tracks mainnet);
 *  - scenario: write an explicitly labelled scenario price for a crash/rally demo. This is a
 *              fork-only trusted assumption, never available on a real cluster.
 *
 * The FORGE program still runs every check (owner, verification level, feed id, staleness,
 * confidence, pool deviation); nothing here disables a guard.
 */
import { type Address } from "@solana/kit";
import { forkClock, rawRpc } from "./surfnet.js";

export const PYTH_RECEIVER = "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ" as Address;
export const PYTH_SOL_USD = "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE" as Address;
export const PYTH_USDC_USD = "Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX" as Address;
export const FEED_SOL_USD = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
export const FEED_USDC_USD = "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a";

export type PythPrice = { price: bigint; conf: bigint; exponent: number; publishTime: bigint; feedId: string };

async function getRaw(addr: Address, url?: string): Promise<{ data: Uint8Array; lamports: number; owner: string }> {
  const r = await rawRpc<{ value: { data: [string, string]; lamports: number; owner: string } | null }>(
    "getAccountInfo",
    [addr, { encoding: "base64" }],
    url,
  );
  if (!r.value) throw new Error(`account ${addr} not found`);
  return { data: new Uint8Array(Buffer.from(r.value.data[0], "base64")), lamports: r.value.lamports, owner: r.value.owner };
}

export function decodePriceUpdate(d: Uint8Array): PythPrice {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  let o = 40;
  const level = d[o]!;
  o += level === 0 ? 2 : 1;
  const feedId = Buffer.from(d.subarray(o, o + 32)).toString("hex");
  o += 32;
  return {
    feedId,
    price: v.getBigInt64(o, true),
    conf: v.getBigUint64(o + 8, true),
    exponent: v.getInt32(o + 16, true),
    publishTime: v.getBigInt64(o + 20, true),
  };
}

/** Encode a fully verified PriceUpdateV2, keeping the original discriminator and authority. */
export function encodePriceUpdate(template: Uint8Array, p: PythPrice, postedSlot: bigint): Uint8Array {
  const out = new Uint8Array(template.length);
  out.set(template.subarray(0, 40)); // discriminator + write_authority
  const v = new DataView(out.buffer);
  let o = 40;
  out[o++] = 1; // VerificationLevel::Full
  out.set(Buffer.from(p.feedId, "hex"), o);
  o += 32;
  v.setBigInt64(o, p.price, true);
  v.setBigUint64(o + 8, p.conf, true);
  v.setInt32(o + 16, p.exponent, true);
  v.setBigInt64(o + 20, p.publishTime, true); // publish_time
  v.setBigInt64(o + 28, p.publishTime, true); // prev_publish_time
  v.setBigInt64(o + 36, p.price, true); // ema_price
  v.setBigUint64(o + 44, p.conf, true); // ema_conf
  v.setBigUint64(o + 52, postedSlot, true);
  return out;
}

export async function readPyth(addr: Address, url?: string): Promise<PythPrice> {
  return decodePriceUpdate((await getRaw(addr, url)).data);
}

async function writeAccount(addr: Address, data: Uint8Array, lamports: number, owner: string): Promise<void> {
  await rawRpc("surfnet_setAccount", [addr, { lamports, owner, data: Buffer.from(data).toString("hex") }]);
}

async function forkNow(): Promise<{ ts: bigint; slot: bigint }> {
  const c = await forkClock();
  return { ts: BigInt(c.unixTimestamp), slot: c.slot };
}

/** Labelled fork scenario: set a feed to `usd` with a confidence of `confBps`, published now. */
export async function setScenarioPrice(addr: Address, feedId: string, usd: number, confBps = 5, ageSeconds = 0): Promise<PythPrice> {
  const cur = await getRaw(addr);
  const exponent = -8;
  const price = BigInt(Math.round(usd * 1e8));
  const conf = (price * BigInt(confBps)) / 10_000n;
  const { ts, slot } = await forkNow();
  const p = { price, conf, exponent, publishTime: ts - BigInt(ageSeconds), feedId };
  await writeAccount(addr, encodePriceUpdate(cur.data, p, slot), cur.lamports, cur.owner);
  return p;
}

/** Live mode: copy the current real mainnet value onto the fork (publish time is mainnet's). */
export async function refreshFromMainnet(addr: Address, mainnetUrl = "https://api.mainnet-beta.solana.com"): Promise<PythPrice> {
  const live = await getRaw(addr, mainnetUrl);
  await writeAccount(addr, live.data, live.lamports, live.owner);
  return decodePriceUpdate(live.data);
}
