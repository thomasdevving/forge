import React from "react";
import marksJson from "../footage/marks.json";
import agentLog from "../footage/term-agent.json";
import { s } from "./theme";
import { Footage, type FootageProps } from "./scenes/Footage";
import { Terminal, timeline as termTimeline, type TermLog } from "./scenes/Terminal";
import { Intro, LogoReveal, Outro, PartTitle } from "./scenes/Titles";
import { RangeOption } from "./scenes/RangeOption";
import { Compiler } from "./scenes/Compiler";
import { Pricing } from "./scenes/Pricing";
import { X402 } from "./scenes/X402";
import { Proof } from "./scenes/Proof";

type Marks = Record<string, { label: string; t: number }[]>;
const MARKS = marksJson as unknown as Marks;

export type Item = { id: string; dur: number; el: React.ReactElement; enter?: "fade" | "blade" | "cut"; enterFrames?: number; part?: number };

/** A beat in a take, in seconds (falls back when the mark is missing). */
const at = (shot: string, label: string, fallback = 0) => MARKS[shot]?.find((m) => m.label === label)?.t ?? fallback;

const FORM = { scale: 1.6, x: 0.93, y: 0.36 };
const CHART = { scale: 1.32, x: 0.42, y: 0.36 };
const RESULTS = { scale: 1.45, x: 0.36, y: 0.97 };

function clip(id: string, src: string, from: number, to: number, props: Omit<FootageProps, "src" | "from"> = {}, enter: Item["enter"] = "fade"): Item {
  const speed = props.speed ?? 1;
  return { id, dur: Math.max(s(1), s((to - from) / speed)), el: <Footage src={src} from={from} {...props} />, enter, enterFrames: 8 };
}

/** The whole edit, in order. `files` is what exists in footage/, so missing takes are left out. */
export function buildTimeline(files: Set<string>): Item[] {
  const has = (f: string) => files.has(f);
  const items: Item[] = [];
  const push = (...xs: Item[]) => items.push(...xs);

  // 0 · intro on camera, then the logo
  push({ id: "intro", dur: s(32), el: <Intro hasVideo={has("intro.mp4")} />, enter: "cut" });
  push({ id: "logo", dur: s(4.2), el: <LogoReveal />, enter: "fade", enterFrames: 16 });

  // 1 · traders
  push({ id: "p1", dur: s(2.8), el: <PartTitle n="01" kicker="For traders" title="Protect any token." sub="A floor under what you hold, built from Orca liquidity." />, enter: "blade", enterFrames: 26, part: 1 });
  if (has("trader.mp4")) {
    const T = "trader";
    push(
      clip("t-hero", T, 0.4, at(T, "launch", 7) + 1.4, { caption: { text: "The landing page", sub: "forge-agr18.vercel.app" } }),
      clip("t-market", T, at(T, "studio", 13.7) - 0.2, at(T, "wallet", 17.8), { caption: { n: "01", text: "Pick a token", sub: "JUP: no options market anywhere" } }),
      clip("t-wallet", T, at(T, "wallet", 17.8), at(T, "funded", 24.2) + 1.6, { speed: 1.6, showSpeed: true, caption: { n: "02", text: "Demo wallet with test funds", sub: "a fork of Solana mainnet · no real money" } }),
      clip("t-form", T, at(T, "strategy", 27.6) - 0.2, at(T, "drag-cap", 39), { zoom: FORM, caption: { n: "03", text: "Describe the hedge", sub: "a collar: floor −12%, cap +15%, exact prices shown" } }),
      clip("t-drag", T, at(T, "drag-cap", 39), at(T, "duration", 43.3), { zoom: CHART, caption: { n: "04", text: "Or drag it on the chart", sub: "the form follows" } }),
      clip("t-duration", T, at(T, "duration", 43.3), at(T, "scenario", 48.2), { zoom: FORM, caption: { n: "05", text: "Cover for one week", sub: "it closes automatically after 7 days" } }),
      clip("t-scenario", T, at(T, "scenario", 48.2), at(T, "compile", 52.8), { caption: { text: "What you get at any closing price" } }),
      clip("t-compile", T, at(T, "compile", 52.8), at(T, "results", 62.7), { speed: 1.3, caption: { n: "06", text: "Compile", sub: "then take the suggested budget for 7 days" } }),
      clip("t-results", T, at(T, "results", 62.7), at(T, "open", 71.3), { zoom: RESULTS, caption: { n: "07", text: "Ranges, cost and a certificate", sub: "the worst-case error, certified to the cent" } }),
      clip("t-open", T, at(T, "open", 71.3), at(T, "opened", 84.5) + 1.2, { speed: 2.2, showSpeed: true, caption: { n: "08", text: "Open it on-chain", sub: "simulate, certify, then sign and send" } }),
      clip("t-position", T, at(T, "view", 87) - 0.3, at(T, "position", 89.6) + 11.5, { caption: { n: "09", text: "Your position", sub: "ends in 7 days · premium against budget · exposure" } }),
    );
  }
  if (has("close.mp4")) push(clip("close", "close", at("close", "positions", 0) + 2.4, at("close", "closed", 7.6) + 5.5, { caption: { n: "10", text: "Close and settle", sub: "LP liquidity restored, payout from real balances" } }));
  if (has("architect.mp4") && MARKS.architect?.some((m) => m.label === "options")) {
    const A = "architect";
    const send = at(A, "send"), opts = at(A, "options");
    push(
      clip("a-type", A, at(A, "type") - 1.6, send + 0.8, { caption: { n: "11", text: "Or just say it", sub: "the Architect compiles real options" } }),
      clip("a-wait", A, send + 0.8, opts, { speed: Math.max(1, (opts - send - 0.8) / 4.5), showSpeed: true }, "cut"),
      clip("a-options", A, opts, at(A, "choose", opts + 5) + 4.5, { caption: { n: "11", text: "Pick one, review it, sign it", sub: "every number comes from the compiler" } }, "cut"),
    );
  }
  if (has("tour.mp4")) push(clip("tour", "tour", at("tour", "tour", 0.8) + 0.4, at("tour", "tour", 0.8) + 8.5, { speed: 1.3, caption: { text: "New here? The tour walks you through it" } }));

  // 2 · LPs
  push({ id: "p2", dur: s(2.8), el: <PartTitle n="02" kicker="For liquidity providers" title="The other side." sub="Your liquidity keeps earning, borrowed or not." />, enter: "blade", enterFrames: 26, part: 2 });
  if (has("earn.mp4")) {
    const E = "earn";
    push(
      clip("e-how", E, 0.4, at(E, "pick", 9.4), { caption: { n: "01", text: "Deposit into a price bucket", sub: "idle, it earns normal Orca fees" } }),
      clip("e-deposit", E, at(E, "pick", 9.4), at(E, "deposited", 19.3) + 1.5, { speed: 1.2, caption: { n: "02", text: "When it's borrowed, the trader pays you", sub: "at least the fees you missed, more as the bucket fills" } }),
      clip("e-earnings", E, at(E, "deposited", 19.3) + 1.5, at(E, "claim", 24.5) + 2.8, { zoom: { scale: 1.45, x: 0.95, y: 0.75 }, caption: { n: "03", text: "Your earnings, line by line", sub: "Orca fees, premium, extra over plain Orca" } }),
    );
  }

  // 3 · agents
  push({ id: "p3", dur: s(2.8), el: <PartTitle n="03" kicker="For agents" title="Built for agents." sub="Any program can buy a hedge, paid per request over x402." />, enter: "blade", enterFrames: 26, part: 3 });
  if (has("agents.mp4")) {
    const G = "agents";
    push(
      clip("g-toggle", G, 0.4, at(G, "section", 8), { caption: { text: "FORGE for agents" } }),
      clip("g-section", G, at(G, "section", 8), 22.5, { speed: 1.15, caption: { text: "What an agent can do", sub: "protect, price, check, discover" } }),
    );
  }
  const log = agentLog as unknown as TermLog;
  push({
    id: "terminal", dur: s(termTimeline(log).end), enter: "fade", enterFrames: 14,
    el: <Terminal log={log} title="treasury-agent — a DAO treasury agent buying a hedge" caption={{ n: "→", text: "A treasury agent, end to end", sub: "pays $0.01 over x402, verifies, asks its human, opens" }} />,
  });

  // 4 · why it works
  push({ id: "p4", dur: s(2.8), el: <PartTitle n="04" kicker="Why it works" title="How it works." sub="The idea, the math, the payment rail and the proof." />, enter: "blade", enterFrames: 26, part: 4 });
  push({ id: "range", dur: s(22), el: <RangeOption />, enter: "fade", enterFrames: 14 });
  push({ id: "compiler", dur: s(13), el: <Compiler />, enter: "fade", enterFrames: 14 });
  push({ id: "pricing", dur: s(14), el: <Pricing />, enter: "fade", enterFrames: 14 });
  // values for the x402 diagram, read from the agent's real run
  const paid = log.lines.find((l) => /402 Payment required/.test(l.line))?.line.match(/required: ([\d.]+) USDC/)?.[1] ?? "0.01";
  const tx = log.lines.find((l) => /settled on the fork/.test(l.line))?.line.match(/\(([1-9A-HJ-NP-Za-km-z]{6,})/)?.[1]?.slice(0, 12) ?? "";
  push({ id: "x402", dur: s(12), el: <X402 facts={{ path: "/x402/hedge", price: paid, tx }} />, enter: "fade", enterFrames: 14 });
  push({ id: "proof", dur: s(12), el: <Proof />, enter: "fade", enterFrames: 14 });
  if (has("proof.mp4")) push(clip("proof-page", "proof", 0.6, Math.max(6, (MARKS.proof?.at(-1)?.t ?? 14) + 2.4), { speed: 1.4, caption: { text: "Method, results and caveats", sub: "forge-agr18.vercel.app/proof" } }));

  // outro
  push({ id: "outro", dur: s(8), el: <Outro />, enter: "blade", enterFrames: 26 });
  return items;
}

export const totalFrames = (items: Item[]) => items.reduce((a, it, i) => a + it.dur - (i > 0 && it.enter !== "cut" ? it.enterFrames ?? 0 : 0), 0);
