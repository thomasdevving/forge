import React from "react";
import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import type { TransitionPresentation, TransitionPresentationComponentProps } from "@remotion/transitions";
import { C, mono, sans } from "./theme";
import { MARK_BOTTOM, MARK_TOP, WORDMARK } from "./brand";

export const ease = Easing.bezier(0.22, 1, 0.36, 1);
export const easeInOut = Easing.bezier(0.65, 0, 0.35, 1);

/** How fast a scene's own animation runs: 1.5 plays it in two thirds of the time. Set per timeline item. */
export const Pace = React.createContext(1);

/** The scene's animation clock: the current frame times its pace. */
export function useFrame() {
  return useCurrentFrame() * React.useContext(Pace);
}

/** 0→1 over [start, start+dur] frames of the scene's clock, eased. */
export function useIn(start: number, dur = 18, e = ease) {
  const f = useFrame();
  return interpolate(f, [start, start + dur], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: e });
}

/** 1→0 over the last `dur` frames of the current sequence. */
export function useOut(dur = 12) {
  const f = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  return interpolate(f, [durationInFrames - dur, durationInFrames], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: easeInOut });
}

/** The site's graphite backdrop: faint grid and a soft light from the top. */
export const Backdrop: React.FC<{ children?: React.ReactNode; glow?: number }> = ({ children, glow = 1 }) => (
  <AbsoluteFill style={{ background: C.bg, fontFamily: sans, color: C.ink }}>
    <AbsoluteFill
      style={{
        backgroundImage: `linear-gradient(${C.grid} 1px, transparent 1px), linear-gradient(90deg, ${C.grid} 1px, transparent 1px)`,
        backgroundSize: "64px 64px",
        maskImage: "radial-gradient(ellipse 80% 70% at 50% 40%, black 30%, transparent 85%)",
      }}
    />
    <AbsoluteFill style={{ background: `radial-gradient(ellipse 60% 45% at 50% -5%, rgba(183,196,214,${0.16 * glow}), transparent 70%)` }} />
    {children}
  </AbsoluteFill>
);

export const Mark: React.FC<{ size: number; color?: string; top?: number; bottom?: number }> = ({ size, color = C.ink, top = 1, bottom = 1 }) => (
  <svg width={size} height={(size * 192) / 273} viewBox="0 0 273 192" style={{ overflow: "visible" }}>
    <path d={MARK_TOP} fill={color} style={{ opacity: top, transform: `translateX(${(1 - top) * -60}px)` }} />
    <path d={MARK_BOTTOM} fill={color} style={{ opacity: bottom, transform: `translateX(${(1 - bottom) * 60}px)` }} />
  </svg>
);

export const Wordmark: React.FC<{ height: number; color?: string; opacity?: number }> = ({ height, color = C.ink, opacity = 1 }) => (
  <svg height={height} viewBox="857 222 736 252" style={{ opacity }}>
    <path d={WORDMARK} fill={color} fillRule="evenodd" />
  </svg>
);

/** Small mono label with a leading number, like the site's section heads. */
export const Kicker: React.FC<{ n?: string; children: React.ReactNode; style?: React.CSSProperties }> = ({ n, children, style }) => (
  <div style={{ fontFamily: mono, fontSize: 22, color: C.ink3, display: "flex", alignItems: "center", gap: 18, letterSpacing: 0.5, ...style }}>
    {n && <span style={{ color: C.ink }}>{n}</span>}
    {n && <span style={{ width: 48, height: 1, background: C.lineStrong }} />}
    {children}
  </div>
);

/** A caption chip over footage: what is happening, in a few words. */
export const Caption: React.FC<{ n?: string; text: string; sub?: string; at?: number; dur?: number; fadeIn?: boolean; fadeOut?: boolean }> = ({ n, text, sub, at = 6, dur, fadeIn = true, fadeOut = true }) => {
  const f = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const end = dur ?? durationInFrames;
  const a = Math.min(
    fadeIn ? interpolate(f, [at, at + 14], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease }) : 1,
    fadeOut ? interpolate(f, [end - 12, end - 2], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease }) : 1,
  );
  return (
    <div style={{ position: "absolute", left: 56, bottom: 52, opacity: a, transform: `translateY(${(1 - a) * 16}px)` }}>
      <div
        style={{
          display: "flex", alignItems: "center", gap: 18, padding: "16px 26px 16px 20px",
          background: "rgba(12,14,17,0.88)", border: `1px solid ${C.lineStrong}`, borderRadius: 6,
          boxShadow: "0 18px 48px rgba(0,0,0,0.45)", backdropFilter: "blur(10px)",
        }}
      >
        {n && <span style={{ fontFamily: mono, fontSize: 20, color: C.ink3 }}>{n}</span>}
        <div>
          <div style={{ fontFamily: sans, fontSize: 30, fontWeight: 600, color: C.ink, letterSpacing: -0.4 }}>{text}</div>
          {sub && <div style={{ fontFamily: sans, fontSize: 20, color: C.ink2, marginTop: 4 }}>{sub}</div>}
        </div>
      </div>
    </div>
  );
};

/**
 * Brand transition: two slanted blades, the logo's shape, sweep across and reveal the next scene.
 */
const BladeWipe: React.FC<TransitionPresentationComponentProps<Record<string, unknown>>> = ({ children, presentationDirection, presentationProgress }) => {
  const p = easeInOut(presentationProgress);
  if (presentationDirection === "exiting") {
    return <AbsoluteFill style={{ transform: `scale(${1 - p * 0.04})`, filter: `brightness(${1 - p * 0.5})` }}>{children}</AbsoluteFill>;
  }
  // slanted edge moving from left (-40%) to right (140%)
  const x = -40 + p * 180;
  const skew = 22;
  const clip = `polygon(0% 0%, ${x + skew}% 0%, ${x}% 100%, 0% 100%)`;
  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ clipPath: clip }}>{children}</AbsoluteFill>
      <AbsoluteFill style={{ pointerEvents: "none" }}>
        <svg width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none">
          <polygon points={`${x + skew - 1.6},0 ${x + skew},0 ${x},100 ${x - 1.6},100`} fill={C.ink} opacity={0.9 * Math.sin(Math.PI * p)} />
          <polygon points={`${x + skew - 4.5},0 ${x + skew - 3.3},0 ${x - 3.3},100 ${x - 4.5},100`} fill={C.ink2} opacity={0.45 * Math.sin(Math.PI * p)} />
        </svg>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
export const bladeWipe = (): TransitionPresentation<Record<string, unknown>> => ({ component: BladeWipe, props: {} });

/** Number formatting used across the graphics. */
export const fmt = (n: number, d = 0) => n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
export const usd = (n: number, d = 2) => `$${fmt(n, d)}`;
