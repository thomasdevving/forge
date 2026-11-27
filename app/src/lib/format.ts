export const fmtUsd = (v: number | null | undefined, digits = 2) =>
  v == null || !Number.isFinite(v) ? "—" : v.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits });

/** Prices of any token: 4 significant digits below $10 ($0.2456, $3.142), 2 decimals above. */
const SUB = "₀₁₂₃₄₅₆₇₈₉";
export const fmtPrice = (v: number | null | undefined) => {
  if (v == null || !Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  // very small prices: $0.0₅188 = 0.00000188 (subscript = number of zeros after "0.0")
  if (a > 0 && a < 0.001) {
    const zeros = -Math.floor(Math.log10(a)) - 1;
    const digits = Math.round(a * 10 ** (zeros + 3)).toString().replace(/0+$/, "") || "0";
    return `${v < 0 ? "-" : ""}$0.0${String(zeros).split("").map((c) => SUB[Number(c)]).join("")}${digits}`;
  }
  const d = a >= 10 ? 2 : a > 0 ? Math.max(2, 3 - Math.floor(Math.log10(a))) : 2;
  return fmtUsd(v, d);
};

export const fmtNum = (v: number | null | undefined, digits = 2) =>
  v == null || !Number.isFinite(v) ? "—" : v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });

export const fmtCompact = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v) ? "—" : v.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 1 });

export const fmtPct = (v: number | null | undefined, digits = 1) =>
  v == null || !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(digits)}%`;

export const atoms = (v: string | number | bigint | null | undefined, decimals: number) =>
  v == null ? 0 : Number(BigInt(v)) / 10 ** decimals;

export const short = (a: string, n = 4) => (a.length > 2 * n + 1 ? `${a.slice(0, n)}…${a.slice(-n)}` : a);

export const ago = (seconds: number) => {
  if (!Number.isFinite(seconds)) return "—";
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
};
