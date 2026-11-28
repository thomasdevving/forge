// Records real browser footage of the running app at 1920x1080.
// Frames come from Chrome's screencast (JPEG, near-lossless), then ffmpeg turns them into a constant 30 fps H.264 file.
// A drawn cursor follows the real mouse so viewers can see what is clicked.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

export const BASE = process.env.FORGE_URL ?? "https://forge-agr18.vercel.app";
export const OUT = new URL("../footage/", import.meta.url).pathname;
export const STATE = new URL("../footage/.state.json", import.meta.url).pathname;
const VW = 1440, VH = 810, DPR = 4 / 3; // renders 1920x1080 with desktop layout and readable text

const CURSOR = `
(() => {
  const mount = () => {
    if (document.getElementById("__demo_cursor")) return;
    const c = document.createElement("div");
    c.id = "__demo_cursor";
    c.innerHTML = '<svg width="26" height="26" viewBox="0 0 26 26"><path d="M3 2 L3 21 L8.2 16.4 L11.6 24 L15 22.5 L11.7 15.1 L18.5 15.1 Z" fill="#f2f4f8" stroke="#101216" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    Object.assign(c.style, { position: "fixed", left: "0", top: "0", width: "26px", height: "26px", zIndex: 2147483647, pointerEvents: "none", transform: "translate(-100px,-100px)", transition: "scale 120ms ease", filter: "drop-shadow(0 2px 4px rgba(0,0,0,.5))" });
    document.documentElement.appendChild(c);
    const pos = JSON.parse(sessionStorage.getItem("__demo_cursor_pos") || "[-100,-100]");
    c.style.transform = "translate(" + pos[0] + "px," + pos[1] + "px)";
    addEventListener("mousemove", (e) => { c.style.transform = "translate(" + (e.clientX - 3) + "px," + (e.clientY - 2) + "px)"; sessionStorage.setItem("__demo_cursor_pos", JSON.stringify([e.clientX - 3, e.clientY - 2])); }, true);
    addEventListener("mousedown", (e) => {
      c.style.scale = "0.86";
      const r = document.createElement("div");
      Object.assign(r.style, { position: "fixed", left: e.clientX - 18 + "px", top: e.clientY - 18 + "px", width: "36px", height: "36px", borderRadius: "50%", border: "2px solid rgba(242,244,248,.85)", zIndex: 2147483646, pointerEvents: "none", transition: "transform 420ms cubic-bezier(.2,.7,.2,1), opacity 420ms ease", transform: "scale(.3)", opacity: "1" });
      document.documentElement.appendChild(r);
      requestAnimationFrame(() => { r.style.transform = "scale(1.4)"; r.style.opacity = "0"; });
      setTimeout(() => r.remove(), 500);
    }, true);
    addEventListener("mouseup", () => { c.style.scale = "1"; }, true);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();
  // hide the Next.js dev badge if this is a dev server
  const st = document.createElement("style");
  st.textContent = "nextjs-portal{display:none!important} ::-webkit-scrollbar{display:none} html{scrollbar-width:none}";
  document.documentElement.appendChild(st);
})();
`;

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function session({ name, storage = true }) {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({ args: ["--hide-scrollbars", "--force-color-profile=srgb"] });
  const ctx = await browser.newContext({
    viewport: { width: VW, height: VH },
    deviceScaleFactor: DPR,
    colorScheme: "dark",
    storageState: storage ? await import("node:fs").then((fs) => (fs.existsSync(STATE) ? STATE : undefined)) : undefined,
  });
  await ctx.addInitScript(CURSOR);
  // the guided tour opens on a first visit; the video shows it only when asked
  await ctx.addInitScript(() => {
    try {
      for (const t of ["studio", "earn", "positions"]) if (!localStorage.getItem(`forge.tour.${t}`)) localStorage.setItem(`forge.tour.${t}`, "1");
    } catch {}
  });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  const dir = `${OUT}/.frames-${name}`;
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const frames = [];
  let recording = false;
  let mouse = [VW / 2, VH / 2];

  cdp.on("Page.screencastFrame", async (f) => {
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
    if (!recording) return;
    const i = frames.length;
    const file = `${dir}/${String(i).padStart(6, "0")}.jpg`;
    frames.push({ file, t: f.metadata.timestamp });
    await writeFile(file, Buffer.from(f.data, "base64"));
  });

  const api = {
    page,
    ctx,
    async start() {
      await cdp.send("Page.startScreencast", { format: "jpeg", quality: 95, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
      recording = true;
      // a heartbeat repaint so still moments still produce frames with timestamps
      await page.evaluate(() => {
        if (window.__beat) return;
        const d = document.createElement("div");
        Object.assign(d.style, { position: "fixed", right: "0", bottom: "0", width: "1px", height: "1px", zIndex: 2147483647, pointerEvents: "none" });
        document.documentElement.appendChild(d);
        let k = 0;
        window.__beat = setInterval(() => { d.style.background = k++ % 2 ? "rgba(16,18,22,.01)" : "rgba(16,18,22,.02)"; }, 33);
      }).catch(() => {});
    },
    async beat() {
      await page.evaluate(() => {
        if (window.__beat) return;
        const d = document.createElement("div");
        Object.assign(d.style, { position: "fixed", right: "0", bottom: "0", width: "1px", height: "1px", zIndex: 2147483647, pointerEvents: "none" });
        document.documentElement.appendChild(d);
        let k = 0;
        window.__beat = setInterval(() => { d.style.background = k++ % 2 ? "rgba(16,18,22,.01)" : "rgba(16,18,22,.02)"; }, 33);
      }).catch(() => {});
    },
    /** Moves the cursor along an eased path. */
    async move(x, y, ms = 700) {
      const [x0, y0] = mouse;
      const n = Math.max(8, Math.round(ms / 16));
      for (let i = 1; i <= n; i++) {
        const k = ease(i / n);
        await page.mouse.move(x0 + (x - x0) * k, y0 + (y - y0) * k);
        await wait(ms / n / 2);
      }
      mouse = [x, y];
    },
    async to(locator, { ms = 700, dx = 0.5, dy = 0.5 } = {}) {
      await locator.waitFor({ state: "visible", timeout: 90_000 });
      await locator.scrollIntoViewIfNeeded().catch(() => {});
      const b = await locator.boundingBox();
      await api.move(b.x + b.width * dx, b.y + b.height * dy, ms);
      return b;
    },
    async click(locator, opts = {}) {
      await api.to(locator, opts);
      await wait(opts.pause ?? 180);
      await page.mouse.down();
      await wait(90);
      await page.mouse.up();
      await wait(opts.after ?? 350);
    },
    /** Opens one of the app's dropdowns, glides down the list and picks `option`, all on camera. */
    async choose(button, option, { via = [] } = {}) {
      await api.click(button, { ms: 800, after: 450 });
      const list = page.getByRole("listbox");
      for (const name of via) {
        await api.to(list.getByRole("option", { name, exact: true }), { ms: 380, dx: 0.3 });
        await wait(260);
      }
      await api.click(list.getByRole("option", { name: option, exact: true }), { ms: 500, dx: 0.3, after: 500 });
    },
    async drag(x1, y1, ms = 900) {
      await page.mouse.down();
      await wait(120);
      await api.move(x1, y1, ms);
      await wait(120);
      await page.mouse.up();
    },
    async type(locator, text, { delay = 45, clear = false } = {}) {
      await api.click(locator);
      // select-all is unreliable in number inputs under headless Chrome: empty the field directly
      if (clear) await locator.fill("");
      for (const ch of text) {
        await page.keyboard.type(ch);
        await wait(delay + Math.random() * delay * 0.6);
      }
    },
    /** Smooth page scroll to an absolute y or an element's top. */
    async scroll(target, ms = 1400, offset = 80) {
      const y = typeof target === "number" ? target : await target.evaluate((el, o) => el.getBoundingClientRect().top + scrollY - o, offset);
      await page.evaluate(
        ([y, ms]) =>
          new Promise((done) => {
            const y0 = scrollY, t0 = performance.now();
            const e = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
            const step = (now) => {
              const k = Math.min(1, (now - t0) / ms);
              scrollTo(0, y0 + (y - y0) * e(k));
              k < 1 ? requestAnimationFrame(step) : done();
            };
            requestAnimationFrame(step);
          }),
        [y, ms],
      );
    },
    async saveState() {
      await ctx.storageState({ path: STATE });
    },
    async stop() {
      recording = false;
      await cdp.send("Page.stopScreencast").catch(() => {});
      await wait(300);
      await browser.close();
      await encode(name, dir, frames);
      await rm(dir, { recursive: true, force: true });
    },
  };
  return api;
}

async function encode(name, dir, frames) {
  if (frames.length < 2) throw new Error(`${name}: no frames captured`);
  // variable-rate frames with their real durations, resampled to a constant 30 fps
  const lines = [];
  for (let i = 0; i < frames.length; i++) {
    const d = i + 1 < frames.length ? Math.max(0.001, frames[i + 1].t - frames[i].t) : 0.5;
    lines.push(`file '${frames[i].file}'`, `duration ${d.toFixed(4)}`);
  }
  lines.push(`file '${frames[frames.length - 1].file}'`);
  const list = `${dir}/list.txt`;
  await writeFile(list, lines.join("\n"));
  const out = `${OUT}/${name}.mp4`;
  await new Promise((ok, bad) => {
    const p = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-vf", "fps=30,scale=1920:1080:flags=lanczos,format=yuv420p", "-c:v", "libx264", "-preset", "slow", "-crf", "14", "-movflags", "+faststart", out], { stdio: "inherit" });
    p.on("exit", (c) => (c === 0 ? ok() : bad(new Error(`ffmpeg exited ${c}`))));
  });
  const secs = frames[frames.length - 1].t - frames[0].t;
  console.log(`${name}: ${frames.length} frames over ${secs.toFixed(1)}s (${(frames.length / secs).toFixed(1)} fps captured) -> ${out}`);
}
