import React from "react";
import { AbsoluteFill, interpolate, OffthreadVideo, staticFile, useCurrentFrame } from "remotion";
import { C, mono, sans } from "../theme";
import { Backdrop, ease, Kicker, Mark, useIn, useOut, Wordmark } from "../ui";

/** Your on-camera intro (footage/intro.mp4), or a placeholder with the lines to say until it exists. */
export const Intro: React.FC<{ hasVideo: boolean }> = ({ hasVideo }) => {
  const f = useCurrentFrame();
  if (hasVideo) return <AbsoluteFill style={{ background: C.bg }}><OffthreadVideo src={staticFile("intro.mp4")} style={{ width: "100%", height: "100%", objectFit: "cover" }} /></AbsoluteFill>;
  const lines = [
    "You hold a token. The price could drop thirty percent next week.",
    "On Bitcoin or ETH you'd buy a put option.",
    "But most Solana tokens have no options market at all.",
    "They do trade on Orca. That liquidity is all you need.",
    "Built for the Dev3pack hackathon, from an empty repository.",
  ];
  const per = 180;
  const i = Math.min(lines.length - 1, Math.floor(f / per));
  const local = f - i * per;
  const a = interpolate(local, [0, 16, per - 16, per], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <Backdrop glow={0.6}>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", gap: 40 }}>
        <div style={{ width: 860, height: 484, border: `1px dashed ${C.lineStrong}`, borderRadius: 8, display: "grid", placeItems: "center", background: "rgba(20,23,28,0.6)" }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontFamily: mono, fontSize: 22, color: C.ink3, letterSpacing: 1 }}>INTRO · ON CAMERA</div>
            <div style={{ fontFamily: sans, fontSize: 30, color: C.ink2, marginTop: 14 }}>Drop your recording in demo/footage/intro.mp4</div>
          </div>
        </div>
        <div style={{ fontFamily: sans, fontSize: 40, fontWeight: 500, color: C.ink, opacity: a, maxWidth: 1400, textAlign: "center", letterSpacing: -0.5 }}>{lines[i]}</div>
      </AbsoluteFill>
    </Backdrop>
  );
};

/** The mark's two blades slide together, the wordmark and the promise follow. */
export const LogoReveal: React.FC = () => {
  const top = useIn(4, 22);
  const bottom = useIn(10, 22);
  const word = useIn(24, 20);
  const line = useIn(40, 22);
  const out = useOut(14);
  return (
    <Backdrop glow={1.2}>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", opacity: out }}>
        <div style={{ display: "flex", alignItems: "center", gap: 46 }}>
          <Mark size={250} top={top} bottom={bottom} />
          <div style={{ opacity: word, transform: `translateX(${(1 - word) * -24}px)` }}>
            <Wordmark height={176} />
          </div>
        </div>
        <div style={{ marginTop: 56, fontFamily: sans, fontSize: 44, color: C.ink2, letterSpacing: -0.6, opacity: line, transform: `translateY(${(1 - line) * 14}px)` }}>
          Options for tokens that <span style={{ color: C.ink }}>don't have options.</span>
        </div>
      </AbsoluteFill>
    </Backdrop>
  );
};

/** Section opener: big number, title, one line. */
export const PartTitle: React.FC<{ n: string; kicker: string; title: string; sub: string }> = ({ n, kicker, title, sub }) => {
  const f = useCurrentFrame();
  const a = useIn(2, 20);
  const b = useIn(10, 22);
  const c = useIn(20, 22);
  const out = useOut(12);
  const sweep = interpolate(f, [0, 40], [0, 1], { extrapolateRight: "clamp", easing: ease });
  return (
    <Backdrop glow={0.9}>
      <AbsoluteFill style={{ padding: "0 180px", justifyContent: "center", opacity: out }}>
        <div style={{ position: "absolute", right: 150, top: "50%", transform: `translateY(-50%) translateX(${(1 - a) * 60}px)`, opacity: 0.07 * a }}>
          <Mark size={760} />
        </div>
        <Kicker n={n} style={{ opacity: a, fontSize: 26 }}>{kicker}</Kicker>
        <div style={{ height: 2, width: 520 * sweep, background: `linear-gradient(90deg, ${C.ink}, transparent)`, marginTop: 34, opacity: 0.6 }} />
        <div style={{ fontFamily: sans, fontSize: 132, fontWeight: 600, letterSpacing: -4.5, lineHeight: 1, marginTop: 34, opacity: b, transform: `translateY(${(1 - b) * 30}px)` }}>{title}</div>
        <div style={{ fontFamily: sans, fontSize: 40, color: C.ink2, marginTop: 30, letterSpacing: -0.5, opacity: c, transform: `translateY(${(1 - c) * 18}px)` }}>{sub}</div>
      </AbsoluteFill>
    </Backdrop>
  );
};

/** Closing card. */
export const Outro: React.FC = () => {
  const top = useIn(2, 22);
  const bottom = useIn(8, 22);
  const word = useIn(18, 20);
  const l1 = useIn(32, 20);
  const l2 = useIn(44, 20);
  return (
    <Backdrop glow={1.3}>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 36 }}>
          <Mark size={170} top={top} bottom={bottom} />
          <div style={{ opacity: word }}>
            <Wordmark height={120} />
          </div>
        </div>
        <div style={{ marginTop: 44, fontFamily: sans, fontSize: 40, color: C.ink2, opacity: l1 }}>Options for any token on Orca.</div>
        <div style={{ marginTop: 48, display: "flex", gap: 22, opacity: l2 }}>
          {["forge-agr18.vercel.app", "github.com/thomasdevving/forge"].map((t) => (
            <div key={t} style={{ fontFamily: mono, fontSize: 26, color: C.ink, padding: "14px 24px", border: `1px solid ${C.lineStrong}`, borderRadius: 6, background: "rgba(20,23,28,0.7)" }}>{t}</div>
          ))}
        </div>
        <div style={{ position: "absolute", bottom: 64, fontFamily: mono, fontSize: 20, color: C.ink3, opacity: l2, letterSpacing: 0.5 }}>
          Built for the Dev3pack hackathon · Surfpool mainnet fork, test funds only · open source
        </div>
      </AbsoluteFill>
    </Backdrop>
  );
};
