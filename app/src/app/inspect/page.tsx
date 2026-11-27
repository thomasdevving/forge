"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { rpc } from "@/lib/rpc";

type Tx = {
  slot: bigint;
  blockTime: bigint | null;
  meta: { err: unknown; fee: bigint; computeUnitsConsumed?: bigint; logMessages: readonly string[] | null; preTokenBalances?: readonly unknown[]; postTokenBalances?: readonly unknown[] } | null;
  transaction: { message: { accountKeys: readonly { pubkey: string; signer: boolean; writable: boolean }[] } };
};

function Inner() {
  const sig = useSearchParams().get("sig") ?? "";
  const [tx, setTx] = useState<Tx | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!sig) return;
    rpc
      .getTransaction(sig as never, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" })
      .send()
      .then((t) => (t ? setTx(t as unknown as Tx) : setErr("Not found on this fork (it may have been restarted).")))
      .catch((e) => setErr((e as Error).message));
  }, [sig]);
  return (
    <AppShell>
      <div className="label">Fork transaction</div>
      <h1 className="num mt-1 break-all text-lg font-semibold">{sig || "—"}</h1>
      <p className="mt-1 text-xs text-warn">This transaction exists only on the FORGE Surfpool fork. It is not on mainnet and public explorers will not find it.</p>
      {err && <div className="card mt-4 p-4 text-sm text-bad">{err}</div>}
      {tx && (
        <div className="mt-5 grid gap-5 lg:grid-cols-[1fr_1.4fr]">
          <div className="card space-y-2 p-5 text-sm">
            <div className="flex justify-between"><span className="text-ink-3">Status</span><span className={tx.meta?.err ? "text-bad" : "text-good"}>{tx.meta?.err ? "failed" : "success"}</span></div>
            <div className="flex justify-between"><span className="text-ink-3">Slot</span><span className="num">{tx.slot.toString()}</span></div>
            <div className="flex justify-between"><span className="text-ink-3">Fee</span><span className="num">{tx.meta ? `${Number(tx.meta.fee) / 1e9} SOL` : "—"}</span></div>
            <div className="flex justify-between"><span className="text-ink-3">Compute</span><span className="num">{tx.meta?.computeUnitsConsumed?.toString() ?? "—"} CU</span></div>
            <div className="label pt-3">Accounts</div>
            <ul className="num max-h-80 space-y-1 overflow-y-auto text-[11px]">
              {tx.transaction.message.accountKeys.map((k) => (
                <li key={k.pubkey} className="flex gap-2"><span className="w-8 shrink-0 text-ink-3">{k.signer ? "sig" : ""}{k.writable ? " w" : ""}</span><span className="break-all">{k.pubkey}</span></li>
              ))}
            </ul>
          </div>
          <div className="card p-5">
            <div className="label">Program logs (FORGE and Orca CPIs)</div>
            <pre className="num mt-3 max-h-[560px] overflow-auto whitespace-pre-wrap rounded-lg bg-sunk p-3 text-[11px] leading-relaxed text-ink-2">{(tx.meta?.logMessages ?? []).join("\n")}</pre>
          </div>
        </div>
      )}
    </AppShell>
  );
}

export default function Inspect() {
  return (
    <Suspense>
      <Inner />
    </Suspense>
  );
}
