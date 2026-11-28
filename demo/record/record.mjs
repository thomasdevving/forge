// Real footage for the demo video. Each shot is one continuous take on the live app; nothing is staged.
//   node record/record.mjs <shot> [<shot> ...]      FORGE_URL defaults to the hosted app
// "trader" starts from a clean browser and saves its funded demo wallet for the shots after it.
import { BASE, session, wait } from "./lib.mjs";

const MARKET = process.env.DEMO_MARKET ?? "JUP/USDC";
const btn = (page, name) => page.getByRole("button", { name, exact: true });
const marks = []; // seconds into the take where each beat starts, for the edit
let t0 = 0;
const mark = (label) => {
  marks.push({ label, t: +((Date.now() - t0) / 1000).toFixed(2) });
  console.log(`  ${marks.at(-1).t.toFixed(1)}s  ${label}`);
};

async function studioReady(page) {
  await page.getByText("Feasible", { exact: true }).waitFor({ timeout: 90_000 });
}

/** Off camera: a fresh demo wallet with fork funds (the wallet menu's one-click option). */
async function fundedWallet(page) {
  await page.goto(`${BASE}/studio?market=${encodeURIComponent(MARKET)}`);
  await studioReady(page);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("button", { name: /Demo wallet with test funds/ }).click();
  await page.getByText(/^Funded/).waitFor({ timeout: 120_000 });
  await page.keyboard.press("Escape");
  await page.mouse.click(700, 480);
  await page.getByText(/^[1-9][\d.,]* \S+ · [\d,]+ \S+$/).waitFor({ timeout: 60_000 });
}

/** Off camera: open the default collar so there is a position to show. */
async function openPosition(page) {
  await page.getByRole("button", { name: "Compile", exact: true }).click();
  await page.getByText("Max error").waitFor({ timeout: 90_000 });
  await page.getByRole("button", { name: "Open position" }).click();
  await page.getByRole("link", { name: "View position" }).waitFor({ timeout: 240_000 });
}

const SHOTS = {
  /** Landing hero, into the Studio, demo wallet, draw a collar, compile, open, the position. */
  async trader(s) {
    const { page } = s;
    await page.goto(BASE);
    await page.waitForLoadState("networkidle").catch(() => {});
    await wait(1500);
    await s.start();
    mark("hero");
    await s.move(600, 420, 1);
    await wait(3200);
    await s.move(380, 520, 1200);
    await wait(600);
    mark("launch");
    await s.click(page.getByRole("link", { name: /Launch App/ }).nth(1), { ms: 900 });
    await studioReady(page);
    await s.beat();
    mark("studio");
    await wait(1500);

    // market
    const sel = page.getByLabel("Market");
    await s.to(sel, { ms: 800 });
    await wait(300);
    await sel.selectOption(MARKET);
    await studioReady(page);
    mark("market");
    await wait(1200);

    // wallet
    mark("wallet");
    await s.click(btn(page, "Connect"));
    await wait(500);
    await s.click(page.getByRole("button", { name: /Demo wallet with test funds/ }), { ms: 600 });
    await page.getByText(/^Funded/).waitFor({ timeout: 120_000 });
    mark("funded");
    await wait(1600);
    await page.keyboard.press("Escape");
    await s.move(700, 480, 700);
    await page.mouse.click(700, 480).catch(() => {});
    await page.getByText(/^[1-9][\d.,]* \S+ · [\d,]+ \S+$/).waitFor({ timeout: 60_000 }).catch(() => {});
    await s.saveState();
    await wait(800);

    // describe the hedge in the form
    const form = (label) => page.getByLabel(`${label}, percent from today's price`);
    const duration = (d) => page.getByRole("group", { name: "Duration" }).getByRole("button", { name: d, exact: true });
    mark("strategy");
    const strat = page.getByLabel("Strategy");
    await s.to(strat, { ms: 900 });
    await wait(400);
    await strat.selectOption("protective_put");
    await wait(1500);
    await strat.selectOption("collar");
    await wait(1400);
    mark("floor");
    await s.type(form("Floor"), "-12", { clear: true, delay: 160 });
    await wait(1200);
    mark("cap");
    await s.type(form("Cap"), "15", { clear: true, delay: 160 });
    await wait(1400);
    // the chart and the form are the same thing: drag the cap and the form follows
    mark("drag-cap");
    const handle = (i) => page.locator('rect[data-handle="1"]').nth(i);
    let b = await s.to(handle(2), { ms: 900 });
    await s.drag(b.x + b.width / 2 - 30, b.y + b.height / 2, 1100);
    await wait(1200);
    mark("duration");
    await s.click(duration("30d"), { ms: 800 });
    await wait(900);
    await s.click(duration("7d"), { ms: 500 });
    await wait(1000);
    // scrub the scenario line across the chart
    mark("scenario");
    const chart = await page.locator('svg[role="application"]').boundingBox();
    await s.move(chart.x + chart.width * 0.3, chart.y + chart.height * 0.55, 800);
    await s.move(chart.x + chart.width * 0.85, chart.y + chart.height * 0.55, 2200);
    await wait(500);

    // compile, take the suggested budget for the duration, compile again
    mark("compile");
    await s.click(btn(page, "Compile"), { ms: 900 });
    await page.getByText("Max error").waitFor({ timeout: 90_000 });
    mark("compiled");
    await wait(1400);
    const hint = page.getByText(/^Suggested for 7 days/);
    if (await hint.count()) {
      mark("budget");
      await s.click(hint, { ms: 900 });
      await wait(1000);
      await s.click(btn(page, "Compile"), { ms: 800 });
      await page.getByText("Max error").waitFor({ timeout: 90_000 });
      await wait(1000);
    }
    mark("results");
    await s.to(page.locator('[data-tour="results"]'), { ms: 900, dx: 0.2, dy: 0.5 });
    await wait(1600);
    await s.to(page.locator('[data-tour="results"]'), { ms: 900, dx: 0.62, dy: 0.5 });
    await wait(1400);
    await s.to(page.locator('[data-tour="results"]'), { ms: 900, dx: 0.88, dy: 0.5 });
    await wait(1800);

    // open
    mark("open");
    await s.click(btn(page, "Open position"), { ms: 900 });
    await page.getByRole("link", { name: "View position" }).waitFor({ timeout: 240_000 });
    mark("opened");
    await wait(2500);
    mark("view");
    await s.click(page.getByRole("link", { name: "View position" }), { ms: 800 });
    await page.getByText("Premium / cap").first().waitFor({ timeout: 90_000 });
    await s.beat();
    mark("position");
    await wait(1500);
    await s.to(page.getByText(/^ends in/).first(), { ms: 900 }).catch(() => {});
    await wait(1400);
    await s.to(page.getByText("Premium / cap").first(), { ms: 900 });
    await wait(1500);
    await s.to(page.getByText("Delta").first(), { ms: 900 });
    await wait(1500);
    await s.scroll(320, 1400);
    await wait(2000);
  },

  /** Ask the Architect in words, read its options, load one into the Studio. */
  async architect(s) {
    const { page } = s;
    await page.goto(`${BASE}/studio?market=${encodeURIComponent(MARKET)}`);
    await studioReady(page);
    await wait(1200);
    await s.start();
    mark("studio");
    await wait(800);
    await s.click(btn(page, "Architect"), { ms: 900 });
    const box = page.locator('aside[aria-label="Architect"] textarea');
    await box.waitFor({ timeout: 30_000 });
    await wait(900);
    mark("type");
    await s.type(box, process.env.ARCHITECT_PROMPT ?? "I hold 3,000 JUP. Protect it if JUP drops more than 10% this week, keep some upside. Max $15 premium.", { delay: 38 });
    await wait(500);
    mark("send");
    await s.click(page.locator('aside[aria-label="Architect"]').getByRole("button", { name: /^Send$/ }), { ms: 600 });
    await page.locator('aside[aria-label="Architect"]').getByRole("button", { name: "Choose" }).first().waitFor({ timeout: 240_000 });
    mark("options");
    await wait(1500);
    const aside = page.locator('aside[aria-label="Architect"]');
    await s.to(aside.getByRole("button", { name: "Choose" }).first(), { ms: 900, dx: -2, dy: -3 });
    await wait(2500);
    mark("choose");
    await s.click(aside.getByRole("button", { name: "Choose" }).first(), { ms: 700 });
    await page.getByText(/Loaded into the Studio/).waitFor({ timeout: 60_000 }).catch(() => {});
    await wait(2200);
    mark("close");
    // choosing loads the design into the Studio, which usually closes the panel itself
    const closeBtn = page.getByRole("button", { name: "Close the Architect" });
    if (await closeBtn.isVisible().catch(() => false)) await s.click(closeBtn, { ms: 700 });
    await wait(2500);
  },

  /** Close the position opened in "trader": legs restored, payout settled. */
  async close(s) {
    const { page } = s;
    await fundedWallet(page);
    await openPosition(page);
    await page.goto(`${BASE}/positions`);
    await page.getByText("Premium / cap").first().waitFor({ timeout: 90_000 });
    await wait(1200);
    await s.start();
    mark("positions");
    await wait(1500);
    await s.click(btn(page, "Close").first(), { ms: 900 });
    mark("closing");
    await page.getByText(/^Closed/).first().waitFor({ timeout: 240_000 }).catch(() => {});
    mark("closed");
    await wait(2500);
    await s.to(page.getByText("Realized net").first(), { ms: 900 }).catch(() => {});
    await wait(2500);
  },

  /** The LP side: buckets, a deposit, earnings, claim. */
  async earn(s) {
    const { page } = s;
    await fundedWallet(page);
    await page.goto(`${BASE}/earn?market=${encodeURIComponent(MARKET)}`);
    await page.locator("table tbody tr").nth(5).waitFor({ timeout: 90_000 });
    await wait(1500);
    await s.start();
    mark("earn");
    await wait(1000);
    await s.to(page.locator('[data-tour="earn-how"]'), { ms: 900, dx: 0.2 });
    await wait(1200);
    await s.to(page.locator('[data-tour="earn-how"]'), { ms: 1000, dx: 0.7 });
    await wait(1200);
    mark("table");
    const rows = page.locator("table tbody tr");
    const n = await rows.count();
    // a range just below the price: the kind traders borrow as protection
    const below = await rows.evaluateAll((els) => els.map((e) => e.textContent ?? ""));
    let pickIdx = Math.max(0, Math.floor(n / 2) - 3);
    await s.to(rows.nth(1), { ms: 900, dx: 0.3 });
    await s.to(rows.nth(Math.min(n - 1, pickIdx + 4)), { ms: 1600, dx: 0.3 });
    await wait(400);
    mark("pick");
    await s.click(rows.nth(pickIdx), { ms: 900, dx: 0.3 });
    await wait(1500);
    void below;
    mark("deposit");
    const amt = page.locator('[data-tour="earn-deposit"] input[type=number]');
    await s.type(amt, "500", { clear: true, delay: 120 });
    await wait(900);
    await s.click(page.locator('[data-tour="earn-deposit"]').getByRole("button", { name: "Deposit" }), { ms: 800 });
    await page.getByText(/^Deposited/).waitFor({ timeout: 180_000 }).catch(() => {});
    mark("deposited");
    await wait(2000);
    mark("earnings");
    await s.to(page.locator('[data-tour="earn-earnings"]'), { ms: 900, dy: 0.3 });
    await wait(2000);
    const claim = page.locator('[data-tour="earn-claim"]').first();
    if (await claim.count()) {
      mark("claim");
      await s.to(claim, { ms: 900 });
      await wait(1800);
    }
  },

  /** The hero's agent view and what an agent can do. */
  async agents(s) {
    const { page } = s;
    await page.goto(BASE);
    await page.waitForLoadState("networkidle").catch(() => {});
    await wait(1500);
    await s.start();
    mark("hero");
    await s.move(900, 500, 1);
    await wait(1200);
    mark("toggle");
    await s.click(page.getByRole("button", { name: "For agents" }).last(), { ms: 1000 });
    await wait(3500);
    mark("section");
    await s.scroll(page.locator("#agents"), 1800, 40);
    await wait(3000);
    await s.scroll(page.locator("#agents").locator("h3").first(), 1600, 120).catch(() => {});
    await wait(3000);
    await s.scroll(await page.evaluate(() => scrollY + 600), 1600);
    await wait(3000);
  },

  /** The proof page, top to bottom. */
  async proof(s) {
    const { page } = s;
    await page.goto(`${BASE}/proof`);
    await page.waitForLoadState("networkidle").catch(() => {});
    await wait(1500);
    await s.start();
    mark("top");
    await s.move(900, 600, 1);
    await wait(2500);
    for (const id of ["replication", "realized", "guarantee", "lp-returns", "recent"]) {
      mark(id);
      await s.scroll(page.locator(`#${id}`), 1600, 40);
      await wait(2600);
    }
  },

  /** The guided tour: its first steps. */
  async tour(s) {
    const { page } = s;
    await page.goto(`${BASE}/studio?market=${encodeURIComponent(MARKET)}`);
    await studioReady(page);
    await wait(1000);
    await s.start();
    await wait(800);
    mark("tour");
    await s.click(page.getByRole("button", { name: /tour of this page/i }), { ms: 900 });
    await wait(2200);
    for (let i = 0; i < 4; i++) {
      await s.click(btn(page, "Next"), { ms: 500 });
      await wait(2000);
    }
    await s.click(page.getByText("Skip tour"), { ms: 600 }).catch(() => {});
    await wait(800);
  },

  /** Any token with an Orca pool and a Pyth feed: the + Add search. */
  async addmarket(s) {
    const { page } = s;
    await page.goto(`${BASE}/studio?market=${encodeURIComponent(MARKET)}`);
    await studioReady(page);
    await wait(1000);
    await s.start();
    await wait(800);
    mark("add");
    await s.click(page.getByRole("button", { name: /\+ ?Add/ }).first(), { ms: 900 });
    await wait(900);
    for (const ch of "WIF") {
      await page.keyboard.type(ch);
      await wait(180);
    }
    await wait(3500);
    await page.keyboard.press("Escape");
    await wait(800);
  },
};

const names = process.argv.slice(2);
if (!names.length) {
  console.log(`shots: ${Object.keys(SHOTS).join(", ")}`);
  process.exit(0);
}
const { writeFile, readFile } = await import("node:fs/promises");
const failed = [];
const marksFile = new URL("../footage/marks.json", import.meta.url).pathname;
for (const name of names) {
  const fn = SHOTS[name];
  if (!fn) throw new Error(`unknown shot ${name}`);
  console.log(`recording ${name}`);
  marks.length = 0;
  const s = await session({ name, storage: false });
  const start = s.start;
  s.start = async () => {
    await start();
    t0 = Date.now();
  };
  try {
    await fn(s);
  } catch (e) {
    failed.push(name);
    console.log(`  ${name} FAILED: ${e.message.split("\n")[0]}`);
    await s.page.screenshot({ path: new URL(`../footage/failed-${name}.png`, import.meta.url).pathname }).catch(() => {});
  } finally {
    await s.stop();
    const all = JSON.parse(await readFile(marksFile, "utf8").catch(() => "{}"));
    all[name] = [...marks];
    await writeFile(marksFile, JSON.stringify(all, null, 2));
  }
}
if (failed.length) {
  console.log(`failed: ${failed.join(", ")}`);
  process.exitCode = 1;
}
