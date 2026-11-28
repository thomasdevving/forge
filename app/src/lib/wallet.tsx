"use client";

/**
 * Wallets for the fork. Two modes, and in both the browser holds the only signing key:
 *
 *  - demo:   a throwaway key funded by the fork faucet.
 *  - mirror: your own wallet, read-only. The app asks the wallet (or you) only for its public address;
 *            the fork service copies that address's public mainnet balances onto a burner key kept in
 *            this browser, and the burner signs every fork transaction. Your wallet never signs.
 *
 * Transactions are built unsigned by the transaction builder and checked before signing.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { address as toAddress, createKeyPairFromPrivateKeyBytes, getAddressFromPublicKey, getTransactionDecoder, getTransactionEncoder, signTransaction } from "@solana/kit";
import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import { api, type BuiltTx } from "./api";
import { assertForkCluster, b64ToBytes, inspectTransaction, sendAndConfirm } from "./rpc";

type Kind = "demo" | "mirror";
type Ctx = {
  /** The signing address on the fork (demo key or burner). */
  address: string | null;
  kind: Kind | null;
  label: string;
  /** In mirror mode: the real wallet whose balances are copied. */
  mirrorOf: string | null;
  wallets: Wallet[];
  error: string | null;
  /** Connect the demo key; resolves to its address. */
  connectDemo: () => Promise<string>;
  /** Ask a wallet for its public address only, then mirror it. */
  connectWallet: (w: Wallet) => Promise<void>;
  /** Mirror any address typed by the user. */
  connectAddress: (owner: string) => Promise<void>;
  disconnect: () => void;
  /** Fork faucet for the demo key (or `to`, right after connecting, before state has updated). */
  fundDemo: (to?: string) => Promise<string>;
  /** Copy the real wallet's current mainnet balances onto the burner again. */
  resync: () => Promise<string>;
  execute: (txs: BuiltTx[], onStep?: (i: number, sig: string) => void) => Promise<string[]>;
  runPlan: (path: string, body: Record<string, unknown>, onStep?: (n: number, sig: string, of?: number) => void) => Promise<{ sigs: string[]; strategy?: string }>;
};

const WalletCtx = createContext<Ctx | null>(null);
/** Fired after test funds or a re-sync land, so pages can re-read balances right away. */
export const BALANCES_EVENT = "forge:balances";
const DEMO_KEY = "forge.demoSeed.v1";
const SESSION_KEY = "forge.session.v1";
const burnerKey = (owner: string) => `forge.burner.v1.${owner}`;

const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* the key then lives for this tab only */
    }
  },
  del: (k: string) => {
    try {
      localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  },
};

/** A seed from storage, or a new one saved under `key`. */
function seedFor(key: string): Uint8Array {
  const saved = store.get(key);
  if (saved) return Uint8Array.from(JSON.parse(saved));
  const seed = crypto.getRandomValues(new Uint8Array(32));
  store.set(key, JSON.stringify([...seed]));
  return seed;
}

const canConnect = (w: Wallet) => "standard:connect" in w.features && w.chains.some((c) => c.startsWith("solana:"));
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

function summarize(balances: Record<string, number>) {
  return Object.entries(balances)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${v.toLocaleString("en-US", { maximumFractionDigits: v < 1 ? 4 : 2 })} ${k}`)
    .join(", ");
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [address, setAddress] = useState<string | null>(null);
  const [kind, setKind] = useState<Kind | null>(null);
  const [label, setLabel] = useState("");
  const [mirrorOf, setMirrorOf] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [keys, setKeys] = useState<CryptoKeyPair | null>(null);

  const loadSigner = useCallback(async (seed: Uint8Array) => {
    const kp = await createKeyPairFromPrivateKeyBytes(seed);
    setKeys(kp);
    const a = await getAddressFromPublicKey(kp.publicKey);
    setAddress(a);
    return a;
  }, []);

  const startMirror = useCallback(
    async (owner: string, sync: boolean) => {
      const burner = await loadSigner(seedFor(burnerKey(owner)));
      setKind("mirror");
      setMirrorOf(owner);
      setLabel(`Simulation of ${short(owner)}`);
      store.set(SESSION_KEY, JSON.stringify({ kind: "mirror", owner }));
      if (sync) {
        const r = await api<{ balances: Record<string, number> }>("control/mirror", { owner, burner });
        return summarize(r.balances);
      }
      return "";
    },
    [loadSigner],
  );

  useEffect(() => {
    const { get, on } = getWallets();
    const refresh = () => setWallets(get().filter(canConnect));
    refresh();
    const offA = on("register", refresh);
    const offB = on("unregister", refresh);
    // restore the last session (no re-sync on reload; the burner keeps its fork state)
    try {
      const s = JSON.parse(store.get(SESSION_KEY) ?? "null") as { kind: Kind; owner?: string } | null;
      if (s?.kind === "mirror" && s.owner) void startMirror(s.owner, false);
      else if (s?.kind === "demo" || (!s && store.get(DEMO_KEY))) {
        void loadSigner(seedFor(DEMO_KEY)).then(() => {
          setKind("demo");
          setLabel("Demo wallet");
        });
      }
    } catch {
      /* start disconnected */
    }
    return () => {
      offA();
      offB();
    };
  }, [startMirror, loadSigner]);

  const connectDemo = useCallback(async () => {
    setError(null);
    const a = await loadSigner(seedFor(DEMO_KEY));
    setKind("demo");
    setMirrorOf(null);
    setLabel("Demo wallet");
    store.set(SESSION_KEY, JSON.stringify({ kind: "demo" }));
    return a;
  }, [loadSigner]);

  const dropSession = useCallback(() => {
    setAddress(null);
    setKind(null);
    setMirrorOf(null);
    setKeys(null);
    store.del(SESSION_KEY);
  }, []);

  const connectAddress = useCallback(
    async (input: string) => {
      setError(null);
      let owner: string;
      try {
        owner = toAddress(input.trim());
      } catch {
        setError("That is not a Solana address.");
        return;
      }
      try {
        await startMirror(owner, true);
      } catch (e) {
        dropSession();
        setError(`Could not copy that wallet's balances: ${(e as Error).message}`);
      }
    },
    [startMirror, dropSession],
  );

  const connectWallet = useCallback(
    async (w: Wallet) => {
      setError(null);
      try {
        // read-only: only the public address is used; nothing is ever sent to this wallet to sign
        const feature = w.features["standard:connect"] as { connect: () => Promise<{ accounts: readonly WalletAccount[] }> };
        const { accounts } = await feature.connect();
        const account = accounts[0];
        if (!account) throw new Error("The wallet returned no account.");
        await startMirror(account.address, true);
      } catch (e) {
        dropSession();
        setError((e as Error).message);
      }
    },
    [startMirror, dropSession],
  );

  const disconnect = useCallback(() => {
    dropSession();
    setError(null);
  }, [dropSession]);

  const fundDemo = useCallback(async (to?: string) => {
    const target = to ?? address;
    if (!target) throw new Error("Connect a wallet first.");
    const r = await api<Record<string, unknown>>("control/faucet", { address: target });
    window.dispatchEvent(new Event(BALANCES_EVENT));
    // e.g. "20 SOL, 5,000 USDC, 6,097 JUP": wrapped SOL, quote, then each other market's base token
    const parts: string[] = [];
    for (const [k, v] of Object.entries(r)) {
      if (typeof v !== "number" || k === "sol") continue;
      parts.push(`${v.toLocaleString("en-US")} ${k === "wrappedSol" ? "SOL" : k.toUpperCase()}`);
    }
    return parts.join(", ");
  }, [address]);

  const resync = useCallback(async () => {
    if (!mirrorOf) throw new Error("Not mirroring a wallet.");
    const out = await startMirror(mirrorOf, true);
    window.dispatchEvent(new Event(BALANCES_EVENT));
    return out;
  }, [mirrorOf, startMirror]);

  const execute = useCallback(
    async (txs: BuiltTx[], onStep?: (i: number, sig: string) => void) => {
      if (!address || !keys) throw new Error("Connect a wallet first.");
      await assertForkCluster();
      const sigs: string[] = [];
      for (let i = 0; i < txs.length; i++) {
        const bytes = b64ToBytes(txs[i]!.transaction);
        inspectTransaction(bytes, address);
        const s = await signTransaction([keys], getTransactionDecoder().decode(bytes));
        const sig = await sendAndConfirm(new Uint8Array(getTransactionEncoder().encode(s)));
        sigs.push(sig);
        onStep?.(i, sig);
      }
      window.dispatchEvent(new Event(BALANCES_EVENT));
      return sigs;
    },
    [address, keys],
  );

  const runPlan = useCallback(
    async (path: string, body: Record<string, unknown>, onStep?: (n: number, sig: string, of?: number) => void) => {
      const sigs: string[] = [];
      let strategy: string | undefined;
      for (let guard = 0; guard < 24; guard++) {
        const r = await api<{ transactions: BuiltTx[]; done: boolean; strategy?: string; steps?: number }>(path, body);
        strategy ??= r.strategy;
        if (r.done || r.transactions.length === 0) break;
        const [sig] = await execute(r.transactions);
        sigs.push(sig!);
        onStep?.(sigs.length, sig!, r.steps);
        // single-transaction plans finish in one go; staged plans continue from chain state
        if (r.steps === 1) break;
      }
      return { sigs, strategy };
    },
    [execute],
  );

  const value = useMemo<Ctx>(
    () => ({ address, kind, label, mirrorOf, wallets, error, connectDemo, connectWallet, connectAddress, disconnect, fundDemo, resync, execute, runPlan }),
    [address, kind, label, mirrorOf, wallets, error, connectDemo, connectWallet, connectAddress, disconnect, fundDemo, resync, execute, runPlan],
  );
  return <WalletCtx.Provider value={value}>{children}</WalletCtx.Provider>;
}

export function useWallet(): Ctx {
  const c = useContext(WalletCtx);
  if (!c) throw new Error("useWallet outside WalletProvider");
  return c;
}
