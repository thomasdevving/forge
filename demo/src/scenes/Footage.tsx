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
  /** Where the camera ends up (eased in over the first second); none is the full frame. */
  zoom?: Zoom;
  /** Where the camera starts: the previous segment's framing, so segments of one take join seamlessly. */
  zoomFrom?: Zoom;
  caption?: { n?: string; text: string; sub?: string };
  /** The caption is already on screen from the previous segment, or stays on into the next one. */
  captionIn?: boolean;
  captionOut?: boolean;
  /** A small "×2" badge while sped up. */
  showSpeed?: boolean;
};

const FULL: Zoom = { scale: 1, x: 0.5, y: 0.5 };

/**
 * A stretch of a real take, optionally sped up, with a camera that eases from the previous
 * segment's framing to this one's.
 */
export const Footage: React.FC<FootageProps> = ({ src, from, speed = 1, zoom, zoomFrom, caption, captionIn = true, captionOut = true, showSpeed }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const a = zoomFrom ?? FULL, b = zoom ?? FULL;
  const k = interpolate(f, [0, 28], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: easeInOut });
  // move the focus point in the zoomed image's own coordinates so pans don't swing
  const scale = a.scale + (b.scale - a.scale) * k;
  const fx = (a.x * (a.scale - 1) + (b.x * (b.scale - 1) - a.x * (a.scale - 1)) * k) / Math.max(1e-6, scale - 1);
  const fy = (a.y * (a.scale - 1) + (b.y * (b.scale - 1) - a.y * (a.scale - 1)) * k) / Math.max(1e-6, scale - 1);
  const origin = scale > 1.0001 ? `${fx * 100}% ${fy * 100}%` : "50% 50%";
  return (
    <AbsoluteFill style={{ background: C.bg, overflow: "hidden" }}>
      <AbsoluteFill style={{ transform: `scale(${scale})`, transformOrigin: origin }}>
        <OffthreadVideo src={staticFile(`${src}.mp4`)} trimBefore={Math.round(from * fps)} playbackRate={speed} muted style={{ width: "100%", height: "100%" }} />
      </AbsoluteFill>
      {/* a soft vignette keeps captions readable over bright UI */}
      <AbsoluteFill style={{ background: "linear-gradient(0deg, rgba(8,9,11,0.55) 0%, transparent 22%)", pointerEvents: "none" }} />
      {caption && <Caption {...caption} fadeIn={captionIn} fadeOut={captionOut} />}
      {showSpeed && speed > 1.05 && (
        <div style={{ position: "absolute", right: 48, bottom: 52, fontFamily: "monospace", fontSize: 22, color: C.ink2, padding: "8px 14px", border: `1px solid ${C.lineStrong}`, borderRadius: 5, background: "rgba(12,14,17,0.8)" }}>
          ×{speed % 1 === 0 ? speed : speed.toFixed(1)}
        </div>
      )}
    </AbsoluteFill>
  );
};
