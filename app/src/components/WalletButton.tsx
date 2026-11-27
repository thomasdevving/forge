"use client";

import { useEffect, useRef, useState } from "react";
import { short } from "@/lib/format";
import { useWallet } from "@/lib/wallet";

export function WalletButton() {
  const w = useWallet();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [paste, setPaste] = useState("");
  const [working, setWorking] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const busy = async (label: string, f: () => Promise<string | void>) => {
    setWorking(true);
    setStatus(label);
    try {
      const out = await f();
      setStatus(out ? out : null);
    } catch (e) {
      setStatus((e as Error).message);
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="relative" ref={ref}>
      <button className={`btn !py-1.5 ${w.address ? "btn-ghost" : "btn-primary"}`} onClick={() => setOpen((o) => !o)}>
        {w.address ? (
          <>
            <span className="size-1.5 bg-good" aria-hidden />
            <span className="num">{short(w.mirrorOf ?? w.address)}</span>
          </>
        ) : (
          "Connect"
        )}
      </button>
      {open && (
        <div className="absolute right-0 z-50 mt-2 w-80 border border-line-strong bg-bg p-3 text-[13px]">
          {w.address ? (
            <div className="space-y-3">
              <div>
                <div className="cap">{w.kind === "mirror" ? "Simulating your wallet" : "Demo wallet"}</div>
                {w.mirrorOf && <div className="num mt-1 break-all text-[12px] text-ink">{w.mirrorOf}</div>}
                <div className="mt-1 text-[12px] text-ink-3">
                  {w.kind === "mirror"
                    ? "Your real balances are copied to a temporary key on the fork, which signs everything. Your wallet never signs."
                    : "Throwaway key in this browser. Fork funds only."}
                </div>
                <div className="num mt-1 break-all text-[11px] text-ink-3">signer {w.address}</div>
              </div>
              {w.kind === "mirror" ? (
                <button className="btn btn-ghost w-full" disabled={working} onClick={() => busy("Copying your balances…", async () => `Synced: ${(await w.resync()) || "no SOL or market tokens found"}.`)}>
                  Re-sync balances
                </button>
              ) : (
                <button className="btn btn-ghost w-full" disabled={working} onClick={() => busy("Funding…", async () => `Funded: ${await w.fundDemo()}.`)}>
                  Get test funds
                </button>
              )}
              {status && <p className="text-[12px] text-ink-2">{status}</p>}
              <button className="btn btn-ghost w-full" onClick={() => { w.disconnect(); setStatus(null); setOpen(false); }}>
                Disconnect
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="cap">Use your own portfolio (read-only)</div>
              <p className="text-[12px] leading-snug text-ink-3">
                We only read your public address and balances. A temporary key on the fork gets the same balances and signs
                every action. No pop-ups, no real funds.
              </p>
              {w.wallets.map((x) => (
                <button key={x.name} className="btn btn-ghost w-full !justify-start" disabled={working} onClick={() => busy(`Reading ${x.name}…`, async () => { await w.connectWallet(x); })}>
                  {x.icon && <img src={x.icon} alt="" className="size-5" />}
                  {x.name}
                </button>
              ))}
              <div className="flex gap-2">
                <input className="input" placeholder="or paste a wallet address" value={paste} onChange={(e) => setPaste(e.target.value)} />
                <button className="btn btn-ghost !px-2.5" disabled={working || paste.trim().length < 32} onClick={() => busy("Copying balances…", async () => { await w.connectAddress(paste); })}>
                  Use
                </button>
              </div>
              <div className="cap pt-2">Or start empty</div>
              <button className="btn btn-ghost w-full !justify-start" disabled={working} onClick={() => { void w.connectDemo(); setOpen(false); }}>
                <span className="grid size-5 place-items-center border border-line-strong text-[10px] font-semibold text-ink-2">D</span>
                Demo wallet with test funds
              </button>
              {(status || w.error) && <p className="text-[12px] text-ink-2">{w.error ?? status}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
