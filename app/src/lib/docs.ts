import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** The docs shown on the site, in reading order. Files live in the repository's docs/ folder. */
export const DOCS = [
  { slug: "overview", title: "What FORGE is", group: "Guide" },
  { slug: "trading", title: "Trading in the Studio", group: "Guide" },
  { slug: "liquidity", title: "Providing liquidity", group: "Guide" },
  { slug: "markets", title: "Adding a token", group: "Guide" },
  { slug: "certificates", title: "Certificates", group: "Reference" },
  { slug: "math", title: "The math", group: "Reference" },
  { slug: "orca-integration", title: "Orca integration", group: "Reference" },
  { slug: "deployment", title: "Deployment", group: "Reference" },
] as const;

export type DocSlug = (typeof DOCS)[number]["slug"];

/** Read at build time (static generation): the app runs from app/, the docs sit next to it. */
export function readDoc(slug: string): string | null {
  if (!DOCS.some((d) => d.slug === slug)) return null;
  try {
    return readFileSync(resolve(process.cwd(), "..", "docs", `${slug}.md`), "utf8");
  } catch {
    return null;
  }
}
