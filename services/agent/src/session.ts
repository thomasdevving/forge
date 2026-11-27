import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import type { CompileResponse, Market, PayoffSpec, Point } from "./forge.js";

export type Construction = {
  id: string;
  createdAt: number;
  label: string;
  market: Pick<Market, "address" | "name" | "baseDecimals" | "quoteDecimals" | "params">;
  spec: PayoffSpec;
  payoff: Point[];
  limits: { base: number; quote: number; budget: number };
  spotAtCompile: number;
  response: CompileResponse;
  verified: { valid: boolean; hash: string; stored: boolean } | null;
  facts: Record<string, unknown>;
};

/** A presented alternative. Its numbers are read from the stored construction, not from the model. */
export type OptionCard = { construction_id: string; title: string; summary: string; tradeoffs: string[]; recommended: boolean };

export type AgentEvent =
  | { type: "status"; text: string }
  | { type: "text"; delta: string }
  | { type: "tool_start"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; ok: boolean; summary: string }
  | { type: "options"; options: (OptionCard & { facts: Record<string, unknown> })[] }
  | { type: "prepared"; construction_id: string; review: Record<string, unknown> }
  | { type: "done"; model: string; usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number } }
  | { type: "error"; message: string };

export type Session = {
  id: string;
  createdAt: number;
  owner: string | null;
  /** Holdings supplied by an API caller instead of a wallet (e.g. another agent's treasury). */
  portfolio: { symbol: string; amount: number }[] | null;
  quoteHoldings: number | null;
  model: string;
  messages: Anthropic.Beta.Messages.BetaMessageParam[];
  constructions: Map<string, Construction>;
  options: OptionCard[];
  prepared: Set<string>;
  busy: boolean;
};

const sessions = new Map<string, Session>();
const TTL_MS = 6 * 60 * 60 * 1000;

export function createSession(init: Pick<Session, "owner" | "portfolio" | "quoteHoldings" | "model">): Session {
  for (const [k, s] of sessions) if (Date.now() - s.createdAt > TTL_MS) sessions.delete(k);
  const s: Session = { id: randomUUID(), createdAt: Date.now(), messages: [], constructions: new Map(), options: [], prepared: new Set(), busy: false, ...init };
  sessions.set(s.id, s);
  return s;
}

export const getSession = (id: string) => sessions.get(id) ?? null;

export const newConstructionId = () => `c_${randomUUID().slice(0, 8)}`;
