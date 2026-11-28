import React from "react";
import { AbsoluteFill, interpolate, OffthreadVideo, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { C } from "../theme";
import { Caption, easeInOut } from "../ui";

export type Zoom = { scale: number; x: number; y: number };
export type FootageProps = {
  src: string;
  /** Start in the take, seconds. */
  from: number;
  speed?: number;
  zoom?: Zoom;
  /** Ease the zoom in (default) or start already zoomed. */
  zoomIn?: boolean;
  /** Ease back out before the end (default). */
  zoomOut?: boolean;
  caption?: { n?: string; text: string; sub?: string };
  /** A small "×2" badge while sped up. */
  showSpeed?: boolean;
};

/** A stretch of a real take, optionally sped up and zoomed onto what matters. */
export const Footage: React.FC<FootageProps> = ({ src, from, speed = 1, zoom, zoomIn = true, zoomOut = true, caption, showSpeed }) => {
  const f = useCurrentFrame();
  const { durationInFrames, fps } = useVideoConfig();
  let k = 0;
  if (zoom) {
    const inK = zoomIn ? interpolate(f, [0, 26], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: easeInOut }) : 1;
    const outK = zoomOut ? interpolate(f, [durationInFrames - 22, durationInFrames - 2], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: easeInOut }) : 1;
    k = Math.min(inK, outK);
  }
  const scale = zoom ? 1 + (zoom.scale - 1) * k : 1;
  return (
    <AbsoluteFill style={{ background: C.bg, overflow: "hidden" }}>
      <AbsoluteFill style={{ transform: `scale(${scale})`, transformOrigin: zoom ? `${zoom.x * 100}% ${zoom.y * 100}%` : "50% 50%" }}>
        <OffthreadVideo src={staticFile(`${src}.mp4`)} trimBefore={Math.round(from * fps)} playbackRate={speed} muted style={{ width: "100%", height: "100%" }} />
      </AbsoluteFill>
      {/* a soft vignette keeps captions readable over bright UI */}
      <AbsoluteFill style={{ background: "linear-gradient(0deg, rgba(8,9,11,0.55) 0%, transparent 22%)", pointerEvents: "none" }} />
      {caption && <Caption {...caption} />}
      {showSpeed && speed > 1.05 && (
        <div style={{ position: "absolute", right: 48, bottom: 52, fontFamily: "monospace", fontSize: 22, color: C.ink2, padding: "8px 14px", border: `1px solid ${C.lineStrong}`, borderRadius: 5, background: "rgba(12,14,17,0.8)" }}>
          ×{speed % 1 === 0 ? speed : speed.toFixed(1)}
        </div>
      )}
    </AbsoluteFill>
  );
};
