import levels from "./data/vo-levels.json";

/** Every spoken line plays at this loudness (EBU R128), so the voice stays even across takes. */
export const TARGET_LUFS = -17;

/**
 * The volume that brings a measured line to the target, from src/data/vo-levels.json
 * (record/levels.py). Unmeasured lines play as recorded; gains are kept within −6 dB and +14 dB.
 */
export function gainFor(key: string) {
  const measured = (levels as Record<string, number>)[key];
  if (measured === undefined) return 1;
  const db = Math.max(-6, Math.min(14, TARGET_LUFS - measured));
  return Math.round(10 ** (db / 20) * 100) / 100;
}
