import React from "react";
import marksJson from "../footage/marks.json";
import agentLog from "../footage/term-agent.json";
import { s } from "./theme";
import { Footage, type FootageProps, type Zoom } from "./scenes/Footage";
import { Terminal, timeline as termTimeline, type TermLog } from "./scenes/Terminal";
import { Pace } from "./ui";
import { Intro, LogoReveal, Outro, PartTitle } from "./scenes/Titles";
import { RangeOption } from "./scenes/RangeOption";
import { Compiler } from "./scenes/Compiler";
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

type Cap = { n?: string; text: string; sub?: string };
/** One stretch of a take: plays up to `to`, at `speed` or fast enough to last `fit` seconds. */
type Seg = { to: number; speed?: number; fit?: number; zoom?: Zoom; cap?: Cap };

/**
 * A take as one continuous shot: its segments follow each other with no gap in the footage, so
 * the joins are invisible. Only speed, framing and captions change, and the camera eases between
 * framings. The take as a whole fades in.
 */
function take(id: string, src: string, from: number, segs: Seg[]): Item[] {
  let t = from;
  return segs.map((g, i) => {
    const len = Math.max(0.1, g.to - t);
    const speed = g.fit ? Math.max(g.speed ?? 1, len / g.fit) : g.speed ?? 1;
    const prev = segs[i - 1], next = segs[i + 1];
    const item = clip(`${id}-${i}`, src, t, g.to, {
      speed,
      showSpeed: speed >= 1.9,
      zoom: g.zoom,
      zoomFrom: prev?.zoom,
      caption: g.cap,
      captionIn: !(g.cap && prev?.cap === g.cap),
      captionOut: !(g.cap && next?.cap === g.cap),
    }, i === 0 ? "fade" : "cut");
    if (i === 0) item.enterFrames = 12;
    t = g.to;
    return item;
  });
}

const paced = (k: number, el: React.ReactElement) => <Pace.Provider value={k}>{el}</Pace.Provider>;
/** The agent run, faster than real reading speed: the voice-over carries it. */
const TERM_PACE = { maxGap: 0.8, lead: 1.2, read: 0.6 };

/** The intro's length when no recording exists yet; a recording sets its own. */
export const INTRO_SECONDS = 18;

/**
 * The whole edit, in order, kept under three minutes. `files` is what exists in footage/, so missing
 * takes are left out; `introSeconds` is the length of your recorded intro.
 */
export function buildTimeline(files: Set<string>, introSeconds = INTRO_SECONDS): Item[] {
  const has = (f: string) => files.has(f);
  const items: Item[] = [];
  const push = (...xs: Item[]) => items.push(...xs);
  const title = (part: number, n: string, kicker: string, head: string, sub: string): Item =>
    ({ id: `p${part}`, dur: s(2.2), el: paced(1.3, <PartTitle n={n} kicker={kicker} title={head} sub={sub} />), enter: "blade", enterFrames: 22, part });

  // 0 · intro on camera, then the logo
  push({ id: "intro", dur: s(introSeconds), el: <Intro hasVideo={has("intro.mp4")} />, enter: "cut" });
  push({ id: "logo", dur: s(2.6), el: paced(1.4, <LogoReveal />), enter: "fade", enterFrames: 14 });

  // 1 · traders
  push(title(1, "01", "For traders", "Protect any token.", "A floor under what you hold, built from Orca liquidity."));
  if (has("trader.mp4")) {
    const T = "trader", m = (l: string, d: number) => at(T, l, d);
    const landing = { text: "The landing page", sub: "forge-agr18.vercel.app" };
    const pick = { n: "01", text: "Pick a token", sub: "JUP: no options market anywhere" };
    const wallet = { n: "02", text: "Demo wallet with test funds", sub: "a fork of Solana mainnet · no real money" };
    const describe = { n: "03", text: "Describe the hedge", sub: "a collar: floor −12%, cap +15%, exact prices shown" };
    const compile = { n: "05", text: "Compile", sub: "then take the suggested budget for 7 days" };
    const results = { n: "06", text: "Ranges, cost and a certificate", sub: "the worst-case error, certified to the cent" };
    const open = { n: "07", text: "Open it on-chain", sub: "simulate, certify, then sign and send" };
    const position = { n: "08", text: "Your position", sub: "ends in 7 days · premium against budget · exposure" };
    push(...take("t", T, m("hero", 0) + 0.3, [
      { to: m("launch", 2.5), cap: landing },
      { to: m("launch", 2.5) + 1.8, cap: landing },
      { to: m("studio", 6), fit: 0.8, cap: landing },
      { to: m("market", 10), speed: 1.2, fit: 3.2, cap: pick },
      { to: m("wallet", 11) + 1.6, speed: 1.2, cap: wallet },
      { to: m("funded", 15), fit: 1.2, cap: wallet },
      { to: m("strategy", 18), speed: 1.6, cap: wallet },
      { to: m("drag-cap", 30), speed: 1.3, zoom: FORM, cap: describe },
      { to: m("duration", 34), speed: 1.2, zoom: CHART, cap: { n: "04", text: "Or drag it on the chart", sub: "the form follows" } },
      { to: m("compile", 37), speed: 1.3, zoom: FORM, cap: { n: "04", text: "Cover for one week", sub: "it closes automatically after 7 days" } },
      { to: m("compile", 37) + 1.4, speed: 1.2, cap: compile },
      { to: m("compiled", 40), fit: 0.8, cap: compile },
      { to: m("results", 44), speed: 1.3, fit: 3.5, cap: compile },
      { to: m("open", 50), speed: 1.3, zoom: RESULTS, cap: results },
      { to: m("open", 50) + 1.4, speed: 1.2, cap: open },
      { to: m("opened", 62), fit: 2, cap: open },
      { to: m("position", 66), speed: 1.3, fit: 2.4, cap: open },
      { to: m("position", 66) + 9.5, speed: 1.45, cap: position },
    ]));
  }
  if (has("close.mp4")) {
    const cap = { n: "09", text: "Close and settle", sub: "LP liquidity restored, payout from real balances" };
    push(...take("close", "close", at("close", "positions", 0) + 0.8, [
      { to: at("close", "closing", 3.3) + 0.6, speed: 1.2, cap },
      { to: at("close", "closed", 7.6), fit: 1.5, cap },
      { to: at("close", "closed", 7.6) + 4.5, speed: 1.4, cap },
    ]));
  }
  if (has("architect.mp4") && MARKS.architect?.some((m) => m.label === "options")) {
    const A = "architect", m = (l: string, d = 0) => at(A, l, d);
    const say = { n: "10", text: "Or just say it", sub: "the Architect compiles real options" };
    const choose = { n: "10", text: "Pick one, review it, sign it", sub: "every number comes from the compiler" };
    push(...take("a", A, m("studio") + 0.6, [
      { to: m("send") + 0.8, speed: 2.2, cap: say },
      { to: m("options"), fit: 2.2, cap: say },
      { to: m("choose", m("options") + 5) + 3.2, speed: 1.35, cap: choose },
    ]));
  }

  // 2 · LPs
  push(title(2, "02", "For liquidity providers", "The other side.", "Your liquidity keeps earning, borrowed or not."));
  if (has("earn.mp4")) {
    const E = "earn", m = (l: string, d: number) => at(E, l, d);
    const bucket = { n: "01", text: "Deposit into a price bucket", sub: "idle, it earns normal Orca fees" };
    const paid = { n: "02", text: "When it's borrowed, the trader pays you", sub: "at least the fees you missed, more as the bucket fills" };
    push(...take("e", E, 0.6, [
      { to: m("pick", 9.3) + 1.2, speed: 1.5, cap: bucket },
      { to: m("deposit", 12.5) + 2.4, speed: 1.3, cap: paid },
      { to: m("deposited", 19.8), fit: 1.2, cap: paid },
      { to: m("claim", 25) + 1.6, speed: 1.3, zoom: { scale: 1.45, x: 0.95, y: 0.75 }, cap: { n: "03", text: "Your earnings, line by line", sub: "Orca fees, premium, extra over plain Orca" } },
    ]));
  }

  // 3 · agents
  push(title(3, "03", "For agents", "Built for agents.", "Any program can buy a hedge, paid per request over x402."));
  if (has("agents.mp4")) {
    const cap = { text: "FORGE for agents", sub: "protect, price, check, discover" };
    push(...take("g", "agents", 0.4, [
      { to: at("agents", "section", 8), speed: 1.6, cap },
      { to: at("agents", "section", 8) + 4.5, speed: 1.6, cap },
    ]));
  }
  const log = agentLog as unknown as TermLog;
  push({
    id: "terminal", dur: s(termTimeline(log, TERM_PACE).end), enter: "fade", enterFrames: 12,
    el: <Terminal log={log} pace={TERM_PACE} title="treasury-agent — a DAO treasury agent buying a hedge" caption={{ n: "→", text: "A treasury agent, end to end", sub: "pays $0.01 over x402, verifies, asks its human, opens" }} />,
  });

  // 4 · why it works
  push(title(4, "04", "Why it works", "How it works.", "The idea, the math, the payment rail and the proof."));
  push({ id: "range", dur: s(13), el: paced(1.7, <RangeOption />), enter: "fade", enterFrames: 12 });
  push({ id: "compiler", dur: s(8.5), el: paced(1.45, <Compiler />), enter: "fade", enterFrames: 12 });
  // values for the x402 diagram, read from the agent's real run
  const paid = log.lines.find((l) => /402 Payment required/.test(l.line))?.line.match(/required: ([\d.]+) USDC/)?.[1] ?? "0.01";
  const tx = log.lines.find((l) => /settled on the fork/.test(l.line))?.line.match(/\(([1-9A-HJ-NP-Za-km-z]{6,})/)?.[1]?.slice(0, 12) ?? "";
  push({ id: "x402", dur: s(7.5), el: paced(1.4, <X402 facts={{ path: "/x402/hedge", price: paid, tx }} />), enter: "fade", enterFrames: 12 });
  push({ id: "proof", dur: s(7.5), el: paced(1.35, <Proof />), enter: "fade", enterFrames: 12 });

  // outro
  push({ id: "outro", dur: s(4), el: paced(1.3, <Outro />), enter: "blade", enterFrames: 22 });
  return items;
}

export const totalFrames = (items: Item[]) => items.reduce((a, it, i) => a + it.dur - (i > 0 && it.enter !== "cut" ? it.enterFrames ?? 0 : 0), 0);
