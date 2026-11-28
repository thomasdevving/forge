import { loadFont as loadJakarta } from "@remotion/google-fonts/PlusJakartaSans";
import { loadFont as loadMono } from "@remotion/google-fonts/IBMPlexMono";

/** The app's own palette (app/src/app/globals.css), so the video and the product look like one thing. */
export const C = {
  bg: "#101216",
  elev: "#14171c",
  sunk: "#0c0e11",
  ink: "#f2f4f8",
  ink2: "#b7c4d6",
  ink3: "#67768c",
  line: "#23272f",
  lineStrong: "#323844",
  accent: "#b7c4d6",
  good: "#8fd1b0",
  warn: "#d8bf8a",
  bad: "#e58a96",
  grid: "rgba(183,196,214,0.06)",
};

export const FPS = 30;
export const sans = loadJakarta("normal", { weights: ["400", "500", "600", "700"], subsets: ["latin"] }).fontFamily;
export const mono = loadMono("normal", { weights: ["400", "500", "600"], subsets: ["latin"] }).fontFamily;

/** Seconds to frames. */
export const s = (sec: number) => Math.round(sec * FPS);
