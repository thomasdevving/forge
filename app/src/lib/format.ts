export const fmtUsd = (v: number | null | undefined, digits = 2) =>
  v == null || !Number.isFinite(v) ? "—" : v.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits });

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
