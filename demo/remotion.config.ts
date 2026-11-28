import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { Config } from "@remotion/cli/config";

// footage/ holds the recorded takes and your intro/voice-over files; it is the public dir of the video
Config.setPublicDir("./footage");
Config.setVideoImageFormat("jpeg");
Config.setJpegQuality(92);
Config.setOverwriteOutput(true);
Config.setDelayRenderTimeoutInMilliseconds(120_000);

// Remotion's own headless Chrome download hangs on some Macs; Playwright's (installed for the recorder) works
const cache = path.join(homedir(), "Library/Caches/ms-playwright");
if (existsSync(cache)) {
  const dir = readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().at(-1);
  const bin = dir && path.join(cache, dir, `chrome-headless-shell-mac-${process.arch === "arm64" ? "arm64" : "x64"}`, "chrome-headless-shell");
  if (bin && existsSync(bin)) Config.setBrowserExecutable(bin);
}
