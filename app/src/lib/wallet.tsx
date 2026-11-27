"use client";

/**
 * Wallets: any Wallet Standard wallet that supports solana:signTransaction, or a throwaway demo
 * wallet (a browser-held key for the fork only, funded by the rate-limited fork faucet).
 * The user always signs; transactions are built unsigned by the transaction builder.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  createKeyPairFromPrivateKeyBytes,
  getAddressFromPublicKey,
  getTransactionDecoder,
  getTransactionEncoder,
  signTransaction,
} from "@solana/kit";
import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import { api, type BuiltTx } from "./api";
import { assertForkCluster, b64ToBytes, inspectTransaction, sendAndConfirm } from "./rpc";

type Kind = "demo" | "standard";
type Ctx = {
  address: string | null;
  kind: Kind | null;
  label: string;
  wallets: Wallet[];
  error: string | null;
  connectDemo: () => Promise<void>;
  connectWallet: (w: Wallet) => Promise<void>;
  disconnect: () => void;
  fundDemo: () => Promise<string>;
  /** Check, sign and send built transactions in order; returns signatures. */
  execute: (txs: BuiltTx[], onStep?: (i: number, sig: string) => void) => Promise<string[]>;
  /** Ask the builder for the next transaction, sign and send it, until the plan is done. */
  runPlan: (path: string, body: Record<string, unknown>, onStep?: (n: number, sig: string, of?: number) => void) => Promise<{ sigs: string[]; strategy?: string }>;
};

const WalletCtx = createContext<Ctx | null>(null);
const DEMO_KEY = "forge.demoSeed.v1";

function canSign(w: Wallet) {
  return "standard:connect" in w.features && "solana:signTransaction" in w.features && w.chains.some((c) => c.startsWith("solana:"));
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [address, setAddress] = useState<string | null>(null);
  const [kind, setKind] = useState<Kind | null>(null);
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [demoKeys, setDemoKeys] = useState<CryptoKeyPair | null>(null);
  const [std, setStd] = useState<{ wallet: Wallet; account: WalletAccount } | null>(null);

  useEffect(() => {
    const { get, on } = getWallets();
    const refresh = () => setWallets(get().filter(canSign));
    refresh();
    const offA = on("register", refresh);
    const offB = on("unregister", refresh);
    // restore a previously created demo wallet
    try {
      const saved = localStorage.getItem(DEMO_KEY);
      if (saved) void loadDemo(Uint8Array.from(JSON.parse(saved)));
    } catch {
      /* storage unavailable: start disconnected */
    }
    return () => {
      offA();
      offB();
    };
  }, []);

  async function loadDemo(seed: Uint8Array) {
    const kp = await createKeyPairFromPrivateKeyBytes(seed);
    setDemoKeys(kp);
    setAddress(await getAddressFromPublicKey(kp.publicKey));
    setKind("demo");
    setLabel("Demo wallet");
  }

  const connectDemo = useCallback(async () => {
    setError(null);
    let seed: Uint8Array | null = null;
    try {
      const saved = localStorage.getItem(DEMO_KEY);
      if (saved) seed = Uint8Array.from(JSON.parse(saved));
    } catch {
      /* ignore */
    }
    if (!seed) {
      seed = crypto.getRandomValues(new Uint8Array(32));
      try {
        localStorage.setItem(DEMO_KEY, JSON.stringify([...seed]));
      } catch {
        /* the wallet then lives for this tab only */
      }
    }
    await loadDemo(seed);
  }, []);

  const connectWallet = useCallback(async (w: Wallet) => {
    setError(null);
    try {
      const feature = w.features["standard:connect"] as { connect: () => Promise<{ accounts: readonly WalletAccount[] }> };
      const { accounts } = await feature.connect();
      const account = accounts[0];
      if (!account) throw new Error("The wallet returned no account.");
      setStd({ wallet: w, account });
      setAddress(account.address);
      setKind("standard");
      setLabel(w.name);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const disconnect = useCallback(() => {
    setAddress(null);
    setKind(null);
    setStd(null);
    setDemoKeys(null);
  }, []);

  const fundDemo = useCallback(async () => {
    if (!address) throw new Error("Connect a wallet first.");
    const r = await api<Record<string, unknown>>("control/faucet", { address });
    // e.g. "20 SOL, 5,000 USDC, 6,097 JUP": wrapped SOL, quote, then each other market's base token
    const parts: string[] = [];
    for (const [k, v] of Object.entries(r)) {
      if (typeof v !== "number" || k === "sol") continue;
      parts.push(`${v.toLocaleString("en-US")} ${k === "wrappedSol" ? "SOL" : k.toUpperCase()}`);
    }
    return parts.join(", ");
  }, [address]);

  const execute = useCallback(
    async (txs: BuiltTx[], onStep?: (i: number, sig: string) => void) => {
      if (!address) throw new Error("Connect a wallet first.");
      await assertForkCluster();
      const sigs: string[] = [];
      for (let i = 0; i < txs.length; i++) {
        const bytes = b64ToBytes(txs[i]!.transaction);
        inspectTransaction(bytes, address);
        let signed: Uint8Array;
        if (kind === "demo" && demoKeys) {
          const tx = getTransactionDecoder().decode(bytes);
          const s = await signTransaction([demoKeys], tx);
          signed = new Uint8Array(getTransactionEncoder().encode(s));
        } else if (kind === "standard" && std) {
          const f = std.wallet.features["solana:signTransaction"] as {
            signTransaction: (...i: { account: WalletAccount; transaction: Uint8Array; chain?: string }[]) => Promise<{ signedTransaction: Uint8Array }[]>;
          };
          const chain = std.account.chains.find((c) => c.startsWith("solana:")) ?? "solana:mainnet";
          const [out] = await f.signTransaction({ account: std.account, transaction: bytes, chain });
          signed = out!.signedTransaction;
        } else {
          throw new Error("No wallet connected.");
        }
        const sig = await sendAndConfirm(signed);
        sigs.push(sig);
        onStep?.(i, sig);
      }
      return sigs;
    },
    [address, kind, demoKeys, std],
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
    () => ({ address, kind, label, wallets, error, connectDemo, connectWallet, disconnect, fundDemo, execute, runPlan }),
    [address, kind, label, wallets, error, connectDemo, connectWallet, disconnect, fundDemo, execute, runPlan],
  );
  return <WalletCtx.Provider value={value}>{children}</WalletCtx.Provider>;
}

export function useWallet(): Ctx {
  const c = useContext(WalletCtx);
  if (!c) throw new Error("useWallet outside WalletProvider");
  return c;
}
