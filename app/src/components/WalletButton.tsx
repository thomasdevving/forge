"use client";

import { useEffect, useRef, useState } from "react";
import { short } from "@/lib/format";
import { useWallet } from "@/lib/wallet";

export function WalletButton() {
  const w = useWallet();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  return (
    <div className="relative" ref={ref}>
      <button className={w.address ? "btn btn-ghost" : "btn btn-primary"} onClick={() => setOpen((o) => !o)}>
        {w.address ? (
          <>
            <span className="size-2 rounded-full bg-good" aria-hidden />
            <span className="num">{short(w.address)}</span>
          </>
        ) : (
          "Connect"
        )}
      </button>
      {open && (
        <div className="card absolute right-0 z-50 mt-2 w-72 p-3">
          {w.address ? (
            <div className="space-y-3">
              <div>
                <div className="label">{w.label}</div>
                <div className="num mt-1 break-all text-sm">{w.address}</div>
              </div>
              {w.kind === "demo" && (
                <button
                  className="btn btn-ghost w-full"
                  onClick={async () => {
                    setStatus("Requesting fork funds…");
                    try {
                      await w.fundDemo();
                      setStatus("Funded: 2 SOL, 20 wrapped SOL and 5,000 USDC (fork only).");
                    } catch (e) {
                      setStatus((e as Error).message);
                    }
                  }}
                >
                  Get fork test funds
                </button>
              )}
              {status && <p className="text-xs text-ink-2">{status}</p>}
              <button className="btn btn-ghost w-full" onClick={() => { w.disconnect(); setOpen(false); }}>
                Disconnect
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="label mb-1">Wallet</div>
              {w.wallets.map((x) => (
                <button key={x.name} className="btn btn-ghost w-full !justify-start" onClick={() => { void w.connectWallet(x); setOpen(false); }}>
                  {x.icon && <img src={x.icon} alt="" className="size-5 rounded" />}
                  {x.name}
                </button>
              ))}
              <button className="btn btn-ghost w-full !justify-start" onClick={() => { void w.connectDemo(); setOpen(false); }}>
                <span className="grid size-5 place-items-center rounded bg-ember-soft text-[10px] font-bold text-ember">D</span>
                Demo wallet (fork only)
              </button>
              <p className="pt-1 text-xs leading-relaxed text-ink-3">
                The demo wallet is a throwaway key kept in this browser. It only ever holds fork test funds.
              </p>
              {w.error && <p className="text-xs text-bad">{w.error}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
