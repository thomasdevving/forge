// Capture landing-page screenshots from the running app on the fork.
// A fresh demo wallet is created in a clean browser, funded from the fork faucet, and walks the real
// flow: draw a collar, compile, open, inspect the position, browse Earn. Nothing is staged.
// Usage: node scripts/screenshots.mjs [baseUrl]   (app, services and fork must be running)
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://localhost:3000";
// the market shown on the landing page; any onboarded market works
const MARKET = process.env.FORGE_SHOT_MARKET ?? "JUP/USDC";
const Q = `market=${encodeURIComponent(MARKET)}`;
const OUT = new URL("../public/shots/", import.meta.url);
const W = 1440, H = 900;

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2, colorScheme: "dark" });
// the guided tour opens on a first visit; screenshots show the pages themselves
await context.addInitScript(() => { for (const t of ["studio", "earn", "positions"]) localStorage.setItem(`forge.tour.${t}`, "done"); });
const page = await context.newPage();
const shot = async (name) => {
  await page.waitForTimeout(600);
  await page.screenshot({ path: new URL(`${name}.jpg`, OUT).pathname, type: "jpeg", quality: 86 });
  console.log("saved", name);
};
const button = (name) => page.getByRole("button", { name, exact: true });

await page.goto(`${BASE}/studio?${Q}`);
await page.getByText("Feasible", { exact: true }).waitFor({ timeout: 60_000 });

// wallet: fresh demo key, fork test funds
await button("Connect").click();
await page.getByRole("button", { name: /Demo wallet with test funds/ }).click();
await page.getByText(/^Funded/).waitFor({ timeout: 90_000 });
await page.mouse.click(10, 10);
// wait until the funded balance is on screen, not the zero it shows before the first refresh
await page.getByText(/^[1-9][\d.,]* \S+ · [\d,]+ \S+$/).waitFor({ timeout: 60_000 });
await shot("studio-draw");

const [baseHeld, quoteHeld] = await page.locator('[data-tour="limits"] input[type=number]').evaluateAll((els) => els.slice(0, 2).map((e) => e.value));
const compiled = page.waitForResponse((r) => r.url().includes("/api/compiler/compile") && r.request().method() === "POST");
await button("Compile").click();
const compileRes = await compiled;
const compile = await compileRes.json();
const target = compileRes.request().postDataJSON().payoff;
await page.getByText("Max error").waitFor({ timeout: 90_000 });
await shot("studio-compiled");

await button("Open position").click();
await page.getByRole("link", { name: "View position" }).waitFor({ timeout: 180_000 });
const confirmed = await page.getByText(/transactions? confirmed/).first().textContent();
const txCount = Number(confirmed?.match(/(\d+)/)?.[1] ?? 0);
await shot("studio-open");

await page.getByRole("link", { name: "View position" }).click();
await page.getByText("Premium / cap").first().waitFor({ timeout: 60_000 });
await page.evaluate(() => window.scrollTo(0, 0));
await shot("positions");

await page.goto(`${BASE}/earn?${Q}`);
await page.locator("table tbody tr").nth(5).waitFor({ timeout: 60_000 });
await page.getByText(/^\$[\d.]+K$/).first().waitFor({ timeout: 60_000 }).catch(() => {});
await shot("earn");

// the numbers behind the snapshots, so the landing page can quote them exactly
const market = (await (await fetch(`${BASE}/api/indexer/markets`)).json()).find((m) => m.name.toUpperCase() === MARKET.toUpperCase());
const c = compile.result.construction;
const meta = {
  capturedAt: new Date().toISOString(),
  market: market.name,
  whirlpool: market.whirlpool,
  swapPool: market.swapPool,
  spot: c.spot,
  base: market.name.split("/")[0],
  quote: market.name.split("/")[1],
  holdings: { base: Number(baseHeld), quote: Number(quoteHeld) },
  premiumBudget: 20,
  target,
  legs: c.legs.map((l) => ({ kind: l.kind, priceLower: l.price_lower, priceUpper: l.price_upper })),
  capitalLocked: c.capital_locked,
  certifiedBound: compile.certificate.error.certified_bound,
  maxErrorAt: compile.certificate.error.at_price,
  solveMs: Math.round(compile.result.solve_seconds * 1000),
  hash: compile.certificate.hash,
  openTransactions: txCount,
};
await writeFile(new URL("meta.json", OUT), JSON.stringify(meta, null, 1));
console.log("saved meta", meta.legs.length, "legs, bound", meta.certifiedBound);
await browser.close();
