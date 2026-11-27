/** Guided walkthroughs: one per app page. Each step points at an element marked `data-tour="<target>"`. */

export type TourStep = { target: string; title: string; body: string };
export type TourId = "studio" | "earn" | "positions";

const WALLET: TourStep = {
  target: "wallet",
  title: "Your wallet",
  body: "Start with a demo wallet and press Get test funds, or connect your own wallet read-only: its balances are copied to the fork and a temporary key signs for you. Your wallet never signs.",
};

export const TOURS: Record<TourId, TourStep[]> = {
  studio: [
    {
      target: "sim-badge",
      title: "Everything is a simulation",
      body: "FORGE runs on a fork of Solana mainnet. Prices and pools are real, but balances and trades are simulated. No real funds move.",
    },
    WALLET,
    {
      target: "market",
      title: "Pick a market",
      body: "Choose the token to protect. + Add makes a market from any token with Orca pools against USDC and a Pyth price feed: search by name, symbol or mint.",
    },
    {
      target: "presets",
      title: "Start from a preset",
      body: "Protective put, collar, put and call spreads, strangle. Each one draws a starting payoff that you can reshape on the chart.",
    },
    {
      target: "chart",
      title: "Draw the payoff",
      body: "What your position is worth at each closing price. Drag points, double-click to add one, select one and press Delete to remove it. The dashed line is just holding the token; the shaded band is how far it moved in the past.",
    },
    {
      target: "limits",
      title: "Set your limits",
      body: "How much of the token you hold and commit, how much USDC, and the most you will pay in premium. After you compile, a suggested budget appears under these: fund near it, because the position is closed once the budget is used up.",
    },
    {
      target: "compile",
      title: "Compile",
      body: "Feasibility is checked live as you draw. Compile finds the Orca ranges that best match your curve and certifies the worst-case error against it.",
    },
    {
      target: "results",
      title: "Read the result",
      body: "The ranges you borrow from LPs or provide yourself, what it costs (capital locked and premium), and the certificate with its maximum error.",
    },
    {
      target: "open",
      title: "Open the position",
      body: "Open simulates the transactions, certifies the result, then signs and sends. A keeper closes the position for you when the premium reaches the trigger (80% of your cap by default).",
    },
    {
      target: "architect",
      title: "Or describe it in words",
      body: "The Architect takes a sentence like “floor 10 SOL at 90% of today's price for a week” and compiles a few alternatives with real numbers. Load one into the Studio; you still review and sign.",
    },
  ],
  earn: [
    {
      target: "earn-how",
      title: "How lending works",
      body: "Put liquidity in a price range of the Orca pool. While nobody borrows it, it earns normal Orca fees. When a trader borrows it, they pay you at least the fees you miss, times a multiplier.",
    },
    {
      target: "market",
      title: "Pick a market",
      body: "Every market is an Orca pool against USDC. + Add makes a new one from any token with Orca pools and a Pyth price feed.",
    },
    {
      target: "earn-table",
      title: "Choose a range",
      body: "Ranges below the price take USDC, ranges above take the token. Lent out shows how much is borrowed now; You receive when lent is the multiplier on the fees you miss.",
    },
    {
      target: "earn-deposit",
      title: "Deposit",
      body: "Click a row to pick its range, enter an amount in USD and deposit. Withdraw any time while it is idle; lent-out liquidity needs notice first (24 hours by default).",
    },
    {
      target: "earn-earnings",
      title: "Your earnings",
      body: "Orca fees plus premium from borrowers, next to the fees you missed while lent, so you can see what you made over plain Orca.",
    },
    {
      target: "earn-claim",
      title: "Claim and withdraw",
      body: "Claim collects the premium and fees of a range. Withdraw takes your liquidity out, or requests it if the range is lent.",
    },
    WALLET,
  ],
  positions: [
    {
      target: "positions-list",
      title: "Your positions",
      body: "Every position you open in the Studio is listed here, newest first, with its state, ranges and certificate.",
    },
    {
      target: "pos-legs",
      title: "Legs",
      body: "Each row is one range: borrowed from LPs for protection, or provided from your own funds. Escrow and buffer are what is locked for it.",
    },
    {
      target: "pos-premium",
      title: "Premium against the cap",
      body: "Premium builds up while you hold borrowed ranges. The marker is the keeper trigger: when premium reaches it, a keeper closes the position for you.",
    },
    {
      target: "pos-greeks",
      title: "Live numbers",
      body: "Delta, gamma and profit or loss, all at the current pool price.",
    },
    {
      target: "pos-close",
      title: "Close",
      body: "Closing hands the borrowed liquidity back to the LPs' ranges, unwinds what you provided and pays out the result.",
    },
    {
      target: "pos-result",
      title: "After closing",
      body: "A closed position compares the payoff you designed with what was realized at the closing price, then takes off the premium you paid.",
    },
    {
      target: "pos-new",
      title: "New position",
      body: "New takes you to the Studio to design one.",
    },
    WALLET,
  ],
};

export function tourFor(path: string): TourId | null {
  if (path.startsWith("/studio")) return "studio";
  if (path.startsWith("/earn")) return "earn";
  if (path.startsWith("/positions")) return "positions";
  return null;
}

const key = (id: TourId) => `forge.tour.${id}`;

/** True when this page's tour has not been seen. False when it has, or when storage is unavailable. */
export function tourUnseen(id: TourId): boolean {
  try {
    return localStorage.getItem(key(id)) === null;
  } catch {
    return false;
  }
}

export function markTourSeen(id: TourId) {
  try {
    localStorage.setItem(key(id), "done");
  } catch {
    /* storage unavailable */
  }
}
