/**
 * Install a program on the Surfpool fork with cheatcodes instead of a deploy transaction, so a hosted
 * fork needs no program keypair: the program account and its programdata account (BPF upgradeable
 * loader layout) are written directly. The upgrade authority is whatever key is passed in.
 */
import { readFileSync } from "node:fs";
import { type Address, address, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
import { rawRpc } from "./surfnet.js";

const LOADER = address("BPFLoaderUpgradeab1e11111111111111111111111");
const enc = getAddressEncoder();

async function setAccount(addr: Address, data: Uint8Array, executable: boolean, lamports: number) {
  await rawRpc("surfnet_setAccount", [addr, { lamports, data: Buffer.from(data).toString("hex"), owner: LOADER, executable }]);
}

export async function installProgram(programId: Address, soPath: string, upgradeAuthority: Address): Promise<Address> {
  const elf = readFileSync(soPath);
  const [programData] = await getProgramDerivedAddress({ programAddress: LOADER, seeds: [enc.encode(programId)] });
  // ProgramData: u32 tag 3 | u64 slot | Option<Pubkey> authority | ELF
  const pd = new Uint8Array(4 + 8 + 1 + 32 + elf.length);
  const v = new DataView(pd.buffer);
  v.setUint32(0, 3, true);
  v.setBigUint64(4, 0n, true);
  pd[12] = 1;
  pd.set(enc.encode(upgradeAuthority), 13);
  pd.set(elf, 45);
  // Program: u32 tag 2 | Pubkey programdata
  const prog = new Uint8Array(4 + 32);
  new DataView(prog.buffer).setUint32(0, 2, true);
  prog.set(enc.encode(programData), 4);
  const rentish = (n: number) => Math.ceil((n + 128) * 6960 * 1.01); // rent-exempt minimum, generously rounded
  await setAccount(programData, pd, false, rentish(pd.length));
  await setAccount(programId, prog, true, rentish(prog.length));
  return programData;
}
