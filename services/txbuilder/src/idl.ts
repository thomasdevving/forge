/**
 * Minimal Anchor IDL (spec 0.1.0) coder: Borsh encode/decode driven by the program's own IDL,
 * so the client cannot drift from the on-chain layout. Supports the types FORGE uses.
 */
import { type Address, getAddressDecoder, getAddressEncoder } from "@solana/kit";
import idlJson from "../idl/forge.json" with { type: "json" };

export type IdlType =
  | "bool" | "bytes" | "string" | "u8" | "u16" | "u32" | "u64" | "u128" | "i8" | "i16" | "i32" | "i64" | "i128" | "pubkey"
  | { array: [IdlType, number] }
  | { vec: IdlType }
  | { option: IdlType }
  | { defined: { name: string } };

type IdlField = { name: string; type: IdlType };
type IdlTypeDef = {
  name: string;
  type: { kind: "struct"; fields: IdlField[] } | { kind: "enum"; variants: { name: string; fields?: IdlField[] }[] };
};
export type IdlAccountItem = { name: string; writable?: boolean; signer?: boolean; optional?: boolean; address?: string };
export type IdlInstruction = { name: string; discriminator: number[]; accounts: IdlAccountItem[]; args: IdlField[] };

export const IDL = idlJson as unknown as {
  address: string;
  instructions: IdlInstruction[];
  accounts: { name: string; discriminator: number[] }[];
  types: IdlTypeDef[];
  errors: { code: number; name: string; msg: string }[];
};

const types = new Map(IDL.types.map((t) => [t.name, t]));
const addrEnc = getAddressEncoder();
const addrDec = getAddressDecoder();

const INT: Record<string, [number, boolean]> = {
  u8: [1, false], u16: [2, false], u32: [4, false], u64: [8, false], u128: [16, false],
  i8: [1, true], i16: [2, true], i32: [4, true], i64: [8, true], i128: [16, true],
};

class Writer {
  bytes: number[] = [];
  int(v: bigint | number, size: number, signed: boolean) {
    let x = BigInt(v);
    const bits = BigInt(size * 8);
    if (signed && x < 0n) x += 1n << bits;
    if (x < 0n || x >= 1n << bits) throw new RangeError(`integer ${v} does not fit ${size * 8} bits`);
    for (let i = 0; i < size; i++) {
      this.bytes.push(Number(x & 0xffn));
      x >>= 8n;
    }
  }
  raw(b: ArrayLike<number>) {
    for (let i = 0; i < b.length; i++) this.bytes.push(b[i]!);
  }
}

function encodeValue(w: Writer, t: IdlType, v: unknown): void {
  if (typeof t === "string") {
    if (t === "bool") return void w.int(v ? 1 : 0, 1, false);
    if (t === "pubkey") return void w.raw(addrEnc.encode(v as Address));
    if (t === "bytes" || t === "string") {
      const b = t === "string" ? new TextEncoder().encode(v as string) : Uint8Array.from(v as ArrayLike<number>);
      w.int(b.length, 4, false);
      return void w.raw(b);
    }
    const [size, signed] = INT[t]!;
    return void w.int(v as bigint | number, size, signed);
  }
  if ("array" in t) {
    const [inner, len] = t.array;
    const arr = v as unknown[];
    if (inner === "u8" && (v instanceof Uint8Array || Array.isArray(v))) {
      if ((v as ArrayLike<number>).length !== len) throw new RangeError(`expected ${len} bytes`);
      return void w.raw(v as ArrayLike<number>);
    }
    if (arr.length !== len) throw new RangeError(`expected array of ${len}`);
    for (const x of arr) encodeValue(w, inner, x);
    return;
  }
  if ("vec" in t) {
    const arr = v as unknown[];
    w.int(arr.length, 4, false);
    for (const x of arr) encodeValue(w, t.vec, x);
    return;
  }
  if ("option" in t) {
    if (v === null || v === undefined) return void w.int(0, 1, false);
    w.int(1, 1, false);
    return encodeValue(w, t.option, v);
  }
  const def = types.get(t.defined.name);
  if (!def) throw new Error(`unknown type ${t.defined.name}`);
  if (def.type.kind === "struct") {
    const obj = v as Record<string, unknown>;
    for (const f of def.type.fields) {
      if (!(f.name in obj)) throw new Error(`missing field ${def.name}.${f.name}`);
      encodeValue(w, f.type, obj[f.name]);
    }
    return;
  }
  // enums are encoded as { VariantName: {...fields} } or a bare variant name string
  const name = typeof v === "string" ? v : Object.keys(v as object)[0]!;
  const idx = def.type.variants.findIndex((x) => x.name === name);
  if (idx < 0) throw new Error(`unknown variant ${def.name}.${name}`);
  w.int(idx, 1, false);
  const variant = def.type.variants[idx]!;
  for (const f of variant.fields ?? []) encodeValue(w, f.type, (v as Record<string, Record<string, unknown>>)[name]![f.name]);
}

class Reader {
  constructor(public b: Uint8Array, public o = 0) {}
  int(size: number, signed: boolean): bigint {
    let x = 0n;
    for (let i = size - 1; i >= 0; i--) x = (x << 8n) | BigInt(this.b[this.o + i]!);
    this.o += size;
    if (signed && x >= 1n << BigInt(size * 8 - 1)) x -= 1n << BigInt(size * 8);
    return x;
  }
}

function decodeValue(r: Reader, t: IdlType): unknown {
  if (typeof t === "string") {
    if (t === "bool") return r.int(1, false) !== 0n;
    if (t === "bytes" || t === "string") {
      const len = Number(r.int(4, false));
      const b = r.b.slice(r.o, r.o + len);
      r.o += len;
      return t === "string" ? new TextDecoder().decode(b) : b;
    }
    if (t === "pubkey") {
      const a = addrDec.decode(r.b.subarray(r.o, r.o + 32));
      r.o += 32;
      return a;
    }
    const [size, signed] = INT[t]!;
    const v = r.int(size, signed);
    return size <= 4 ? Number(v) : v;
  }
  if ("array" in t) {
    const [inner, len] = t.array;
    if (inner === "u8") {
      const out = r.b.slice(r.o, r.o + len);
      r.o += len;
      return out;
    }
    return Array.from({ length: len }, () => decodeValue(r, inner));
  }
  if ("vec" in t) {
    const len = Number(r.int(4, false));
    return Array.from({ length: len }, () => decodeValue(r, t.vec));
  }
  if ("option" in t) return r.int(1, false) === 0n ? null : decodeValue(r, t.option);
  const def = types.get(t.defined.name)!;
  if (def.type.kind === "struct") {
    const out: Record<string, unknown> = {};
    for (const f of def.type.fields) out[f.name] = decodeValue(r, f.type);
    return out;
  }
  const variant = def.type.variants[Number(r.int(1, false))]!;
  if (!variant.fields?.length) return variant.name;
  const fields: Record<string, unknown> = {};
  for (const f of variant.fields) fields[f.name] = decodeValue(r, f.type);
  return { [variant.name]: fields };
}

export function encodeArgs(ix: IdlInstruction, args: Record<string, unknown>): Uint8Array {
  const w = new Writer();
  w.raw(ix.discriminator);
  for (const a of ix.args) {
    if (!(a.name in args)) throw new Error(`missing argument ${ix.name}.${a.name}`);
    encodeValue(w, a.type, args[a.name]);
  }
  return new Uint8Array(w.bytes);
}

export function encodeType(name: string, value: unknown): Uint8Array {
  const w = new Writer();
  encodeValue(w, { defined: { name } }, value);
  return new Uint8Array(w.bytes);
}

export function decodeAccount<T = Record<string, unknown>>(name: string, data: Uint8Array): T {
  const acc = IDL.accounts.find((a) => a.name === name);
  if (!acc) throw new Error(`unknown account ${name}`);
  for (let i = 0; i < 8; i++) {
    if (data[i] !== acc.discriminator[i]) throw new Error(`account is not a ${name}`);
  }
  return decodeValue(new Reader(data, 8), { defined: { name } }) as T;
}

export function instructionDef(name: string): IdlInstruction {
  const ix = IDL.instructions.find((i) => i.name === name);
  if (!ix) throw new Error(`unknown instruction ${name}`);
  return ix;
}

export function errorName(code: number): string | undefined {
  return IDL.errors.find((e) => e.code === code)?.name;
}
