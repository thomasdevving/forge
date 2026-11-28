/**
 * The voice-over, cut from your webcam takes (footage/cam/, made by record/takes.sh).
 * Each line plays from `from` to `to` seconds of its take and starts on the scene it describes:
 * `at` is a timeline item id, `offset` seconds after that item starts. A line never starts before
 * the previous one has finished, so pacing stays natural. `cam` shows you in a small bubble.
 */
export type Line = { take: string; from: number; to: number; at: string; offset?: number; cam?: boolean };

const T1 = "take-15h51", T3 = "take-15h53", T4a = "take-16h11-2", T4b = "take-16h11";

export const VO: Line[] = [
  // 1 · traders
  { take: T1, from: 0.4, to: 4.15, at: "p1", offset: 0.3, cam: true }, // first, the traders. From the landing page, I open the app.
  { take: T1, from: 4.35, to: 9.4, at: "t-3" }, // I pick JUP and connect the demo wallet. Mainnet fork, test money.
  { take: "take-16h35-2", from: 0.0, to: 10.45, at: "t-7" }, // the hedge, a collar: below the floor I get paid the difference; above the cap I give up the extra gains
  { take: T1, from: 15.35, to: 16.95, at: "t-8" }, // dragging the chart does the same thing
  { take: T1, from: 17.15, to: 18.35, at: "t-9" }, // and I want it for one week
  { take: T1, from: 18.75, to: 21.2, at: "t-10" }, // compile and take the suggested budget
  { take: T1, from: 22.15, to: 25.95, at: "t-13" }, // the ranges, the cost, the certified worst-case error
  { take: T1, from: 26.8, to: 28.15, at: "t-14" }, // so I open it on chain
  { take: T1, from: 28.3, to: 34.55, at: "t-16" }, // my position ends in seven days; paid, exposure
  { take: T1, from: 35.15, to: 38.35, at: "close-0" }, // closing gives the LPs their liquidity back
  { take: T1, from: 39.0, to: 44.9, at: "a-0" }, // or tell the Architect
  // 2 · LPs
  { take: T1, from: 47.35, to: 52.85, at: "p2", offset: 0.3, cam: true }, // on the other side, liquidity providers
  { take: T1, from: 53.55, to: 56.65, at: "e-1" }, // when a trader borrows it, you get paid at least the fees you missed
  { take: T1, from: 57.45, to: 59.2, at: "e-3" }, // your earnings are broken down below
  // 3 · agents
  { take: T3, from: 1.15, to: 8.25, at: "p3", offset: 0.3, cam: true }, // agents can do all of this too
  { take: T3, from: 8.7, to: 26.35, at: "terminal", offset: 0.4 }, // here's a treasury agent ... the position is open
  // 4 · why it works
  { take: T4a, from: 7.7, to: 10.2, at: "p4", offset: 0.4, cam: true }, // a range below the price holds only USDC
  { take: T4a, from: 10.7, to: 19.72, at: "range" }, // FORGE borrows it ... that's a put
  { take: T4a, from: 20.2, to: 24.05, at: "compiler" }, // the compiler stacks ranges into your payoff
  { take: T4b, from: 0.5, to: 9.78, at: "pricing" }, // LPs get the exact same liquidity back
  { take: T4b, from: 10.6, to: 17.05, at: "x402" }, // agents pay over x402
  { take: T4b, from: 17.3, to: 27.5, at: "proof" }, // tested on a mainnet fork and ten months of real JUP prices
  { take: T4b, from: 28.05, to: 31.35, at: "outro", offset: 0.3 }, // so that's FORGE. The math and the proof are on the site.
];

/** Seconds of silence kept between two lines that would otherwise run into each other. */
export const GAP = 0.3;

/** Places every line on the video's clock (seconds), given where each timeline item starts. */
export function placeLines(lines: Line[], startOf: (id: string) => number | undefined) {
  let prevEnd = -Infinity;
  return lines.flatMap((l) => {
    const anchor = startOf(l.at);
    if (anchor === undefined) return [];
    const start = Math.max(anchor + (l.offset ?? 0), prevEnd + GAP);
    prevEnd = start + (l.to - l.from);
    return [{ ...l, start }];
  });
}
