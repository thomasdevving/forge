/**
 * FORGE Architect: turns a financial objective into compiled, verified alternatives.
 * Claude interprets the objective and explores structures; FORGE's compiler, verifier and program rules
 * produce every number; the user signs. Runs on the Messages API tool runner (we host the loop because
 * the tools are FORGE's own services).
 */
import Anthropic from "@anthropic-ai/sdk";
import { makeTools } from "./tools.js";
import type { AgentEvent, Session } from "./session.js";

export const MODELS = {
  standard: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5",
  advanced: process.env.ANTHROPIC_ADVANCED_MODEL ?? "claude-opus-5-5",
};
const EFFORT = (process.env.AGENT_EFFORT ?? "medium") as "low" | "medium" | "high";
// Server-side refusal fallbacks: on a policy decline the API re-runs the request on a fallback model.
const FALLBACKS = (process.env.AGENT_FALLBACKS ?? "default") !== "off";
const MAX_ITERATIONS = Number(process.env.AGENT_MAX_ITERATIONS ?? 24);

export const hasKey = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
let client: Anthropic | null = null;
const anthropic = () => (client ??= new Anthropic());

export const SYSTEM = `You are FORGE Architect, a financial engineering agent inside FORGE, a Solana protocol that builds options-like payoffs on tokens that have no options market by borrowing and providing ranges of Orca Whirlpool concentrated liquidity.

How the work is divided:
- You interpret the user's objective, separate hard constraints (stated limits such as a maximum premium, a minimum protected value, which token) from preferences (keep upside, cheaper is better), and explore alternative structures.
- FORGE's tools compute everything numeric: payoff breakpoints, feasibility, legs, capital locked, the certified worst-case replication error, funded liquidity and premium facts. You never estimate, compute or round these yourself; you quote the tool results. If a number is not in a tool result, you do not state it.
- The user signs. You cannot sign, send or move funds. prepare_transaction only readies a verified construction for the user's review.

Working method:
1. Read holdings (get_wallet_holdings) when the request concerns what the user owns, and market data (get_market_data) for each token involved. The historical move quantiles are end/start price ratios over 1, 7 and 30 days; use them to ground what a crash or a typical move means for this token, and cite the period they cover.
2. Check funded liquidity (get_available_liquidity) on the side you need: protection below spot borrows ranges below the price.
3. Compile several alternatives (compile_strategy), typically: maximum protection, balanced, and budget-optimized. Vary the floor, cap, structure or size; keep every hard constraint in each. If one is infeasible, read the reasons and closest_feasible and try a nearby construction.
4. Never relax a hard constraint silently. If no construction satisfies all of them, say which constraint blocks it, compile the closest alternative, and label that option as a compromise that needs the user's approval.
5. Present the alternatives with present_options (only verified constructions qualify), then write a short message: which option you recommend and why, the trade-offs in plain language, and what the premium figures mean (premium is at least the time floor per day; the budget caps the total and the keeper closes the position when it is mostly used).
6. When the user picks an option, call verify_strategy if needed, then prepare_transaction, and tell them to review and sign it in the Studio.

Context: everything runs on a Surfpool fork of Solana mainnet with simulated funds; say so if the user asks about real money. Keep messages short and concrete. Use the user's numbers and the tool results; no filler.`;

export async function runTurn(s: Session, text: string, emit: (e: AgentEvent) => void, signal?: AbortSignal) {
  if (!hasKey()) throw new Error("The Architect is not configured on this server (no Anthropic API key).");
  const tools = makeTools(s, emit);
  const messages = [...s.messages, { role: "user" as const, content: text }];
  const runner = anthropic().beta.messages.toolRunner(
    {
      model: s.model,
      max_tokens: 16_000,
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: EFFORT },
      system: SYSTEM,
      tools,
      messages,
      cache_control: { type: "ephemeral" },
      thread: false,
      max_iterations: MAX_ITERATIONS,
      stream: true,
      ...(FALLBACKS ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    },
    { signal },
  );

  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  let last: Anthropic.Beta.Messages.BetaMessage | null = null;
  for await (const stream of runner) {
    let thinking = false;
    stream.on("thinking", () => {
      if (!thinking) emit({ type: "status", text: "Thinking" });
      thinking = true;
    });
    stream.on("text", (delta) => emit({ type: "text", delta }));
    stream.on("contentBlock", (b) => {
      if (b.type === "tool_use") emit({ type: "tool_start", id: b.id, name: b.name, input: b.input });
    });
    const msg = await stream.finalMessage();
    last = msg;
    usage.input_tokens += msg.usage.input_tokens;
    usage.output_tokens += msg.usage.output_tokens;
    usage.cache_read_input_tokens += msg.usage.cache_read_input_tokens ?? 0;
    usage.cache_creation_input_tokens += msg.usage.cache_creation_input_tokens ?? 0;
    if (msg.stop_reason === "refusal") {
      emit({ type: "error", message: "The model declined this request." });
      break;
    }
    if (msg.stop_reason === "max_tokens") {
      emit({ type: "error", message: "The reply was cut off. Try a narrower request." });
      break;
    }
  }
  // keep the whole exchange (thinking blocks included, unchanged) for the next turn
  const history = [...runner.params.messages];
  if (last && history.at(-1)?.role !== "assistant") history.push({ role: "assistant", content: last.content });
  s.messages = history;
  emit({ type: "done", model: last?.model ?? s.model, usage });
  return last;
}
