import React from "react";
import { Audio, interpolate, OffthreadVideo, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { C } from "../theme";
import { gainFor } from "../levels";

const SIZE = 290;
// where your face sits in the 1620×1080 take, as a share of width and height
const FACE = { x: 0.53, y: 0.38 };
const H = 380, W = (H * 1620) / 1080;

/**
 * One voice-over line from a webcam take. With `show`, you appear in a round bubble (bottom right)
 * that pops in and out with the line; otherwise only the sound plays.
 */
export const Cam: React.FC<{ take: string; from: number; to: number; show?: boolean }> = ({ take, from, to, show }) => {
  const f = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const src = staticFile(`cam/${take}.mp4`);
  const trim = { trimBefore: Math.round(from * fps), trimAfter: Math.round(to * fps) };
  const volume = gainFor(`${take}@${from}-${to}`);
  if (!show) return <Audio src={src} {...trim} volume={volume} />;
  const pop = spring({ frame: f, fps, config: { damping: 18, stiffness: 160 } });
  const out = interpolate(f, [durationInFrames - 9, durationInFrames - 1], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const k = Math.min(pop, out);
  return (
    <div
      style={{
        position: "absolute", right: 56, bottom: 128, width: SIZE, height: SIZE, borderRadius: "50%", overflow: "hidden",
        border: `3px solid ${C.ink}`, boxShadow: "0 18px 48px rgba(0,0,0,0.55)", background: C.bg,
        transform: `scale(${0.6 + 0.4 * k})`, opacity: k, transformOrigin: "80% 80%",
      }}
    >
      <OffthreadVideo
        src={src}
        {...trim}
        volume={volume}
        style={{ position: "absolute", height: H, width: W, maxWidth: "none", left: SIZE / 2 - FACE.x * W, top: SIZE / 2 - FACE.y * H }}
      />
    </div>
  );
};
