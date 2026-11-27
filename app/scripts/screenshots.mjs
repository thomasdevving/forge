// Capture landing-page screenshots from the running app on the fork.
// A fresh demo wallet is created in a clean browser, funded from the fork faucet, and walks the real
// flow: draw a collar, compile, open, inspect the position, browse Earn. Nothing is staged.
// Usage: node scripts/screenshots.mjs [baseUrl]   (app, services and fork must be running)
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://localhost:3000";
const OUT = new URL("../public/shots/", import.meta.url);
const W = 1440, H = 900;

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2, colorScheme: "dark" })).newPage();
const shot = async (name) => {
  await page.waitForTimeout(600);
  await page.screenshot({ path: new URL(`${name}.jpg`, OUT).pathname, type: "jpeg", quality: 86 });
  console.log("saved", name);
};
const button = (name) => page.getByRole("button", { name, exact: true });

await page.goto(`${BASE}/studio`);
await page.getByText("Feasible", { exact: true }).waitFor({ timeout: 60_000 });

// wallet: fresh demo key, fork test funds
await button("Connect").click();
await page.getByRole("button", { name: /Demo wallet/ }).click();
await page.locator("header button.btn-ghost").last().click();
await button("Get test funds").click();
await page.getByText(/^Funded/).waitFor({ timeout: 90_000 });
await page.mouse.click(10, 10);
// wait until the funded balance is on screen, not the zero it shows before the first refresh
await page.getByText(/^[1-9][\d.,]* SOL · [\d,]+ USDC$/).waitFor({ timeout: 60_000 });
await shot("studio-draw");

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

await page.goto(`${BASE}/earn`);
await page.locator("table tbody tr").nth(5).waitFor({ timeout: 60_000 });
await page.getByText(/^\$[\d.]+K$/).first().waitFor({ timeout: 60_000 }).catch(() => {});
await shot("earn");

// the numbers behind the snapshots, so the landing page can quote them exactly
const market = (await (await fetch(`${BASE}/api/indexer/markets`)).json())[0];
const c = compile.result.construction;
const meta = {
  capturedAt: new Date().toISOString(),
  market: market.name,
  spot: c.spot,
  holdings: { base: 10, quote: 2000 },
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
