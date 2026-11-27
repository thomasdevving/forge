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
      <button className={`btn !py-1.5 ${w.address ? "btn-ghost" : "btn-primary"}`} onClick={() => setOpen((o) => !o)}>
        {w.address ? (
          <>
            <span className="size-1.5 bg-good" aria-hidden />
            <span className="num">{short(w.address)}</span>
          </>
        ) : (
          "Connect"
        )}
      </button>
      {open && (
        <div className="absolute right-0 z-50 mt-2 w-72 border border-line-strong bg-bg p-3">
          {w.address ? (
            <div className="space-y-3">
              <div>
                <div className="cap">{w.label}</div>
                <div className="num mt-1 break-all text-sm">{w.address}</div>
              </div>
              {w.kind === "demo" && (
                <button
                  className="btn btn-ghost w-full"
                  onClick={async () => {
                    setStatus("Funding…");
                    try {
                      await w.fundDemo();
                      setStatus("Funded: 20 SOL, 5,000 USDC.");
                    } catch (e) {
                      setStatus((e as Error).message);
                    }
                  }}
                >
                  Get test funds
                </button>
              )}
              {status && <p className="text-xs text-ink-2">{status}</p>}
              <button className="btn btn-ghost w-full" onClick={() => { w.disconnect(); setOpen(false); }}>
                Disconnect
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="cap mb-1">Wallet</div>
              {w.wallets.map((x) => (
                <button key={x.name} className="btn btn-ghost w-full !justify-start" onClick={() => { void w.connectWallet(x); setOpen(false); }}>
                  {x.icon && <img src={x.icon} alt="" className="size-5" />}
                  {x.name}
                </button>
              ))}
              <button className="btn btn-ghost w-full !justify-start" onClick={() => { void w.connectDemo(); setOpen(false); }}>
                <span className="grid size-5 place-items-center border border-line-strong text-[10px] font-semibold text-ink-2">D</span>
                Demo wallet
              </button>
              <p className="pt-1 text-xs text-ink-3">Throwaway key in this browser. Fork funds only.</p>
              {w.error && <p className="text-xs text-bad">{w.error}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
