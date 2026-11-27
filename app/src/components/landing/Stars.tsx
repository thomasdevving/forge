/**
 * Sparse star field for the hero sky. Deterministic (seeded), so server and client render the same
 * points; a few twinkle slowly. Kept off the moon by the mask set where it is used.
 */
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

const r = rng(20261127);
const STARS = Array.from({ length: 120 }, (_, i) => {
  const big = r() < 0.08;
  // rounded, so server and browser serialize identical styles
  const f = (v: number, d = 2) => Number(v.toFixed(d));
  return {
    x: f(r() * 100),
    y: f(Math.pow(r(), 1.4) * 72), // denser toward the top, none down at the field
    s: f(big ? 1.6 : 0.6 + r() * 0.7),
    o: f(big ? 0.7 : 0.18 + r() * 0.35),
    tw: i % 9 === 0,
    d: f(r() * 6, 1),
  };
});

export function Stars({ className = "" }: { className?: string }) {
  return (
    <div className={className} aria-hidden>
      {STARS.map((st, i) => (
        <span
          key={i}
          className={`absolute block rounded-full ${st.tw ? "twinkle" : ""}`}
          style={{
            left: `${st.x}%`,
            top: `${st.y}%`,
            width: `${(st.s * 1.6).toFixed(2)}px`,
            height: `${(st.s * 1.6).toFixed(2)}px`,
            backgroundColor: st.s > 1.2 ? "var(--ink)" : "var(--ink-2)",
            opacity: st.o,
            animationDelay: st.tw ? `${st.d}s` : undefined,
          }}
        />
      ))}
    </div>
  );
}
