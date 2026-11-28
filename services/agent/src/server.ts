/**
 * FORGE Architect service.
 *
 *  GET  /health                               model config and whether a key is set
 *  POST /sessions {owner?, tier?}             start a conversation (owner: wallet address read on the fork)
 *  POST /sessions/:id/messages {text}         one turn, streamed as server-sent events (AgentEvent JSON)
 *  GET  /sessions/:id/constructions/:cid      a construction's facts and its payoff/limits, for the Studio
 *  GET  /sessions/:id/prepared/:cid           the open template of a prepared construction
 *  POST /hedge {objective, portfolio?, usdc?, owner?, tier?}
 *                                             one-shot for machines (behind x402): returns the verified options
 */
import cors from "@fastify/cors";
import Fastify from "fastify";
import { hasKey, MODELS, runTurn } from "./architect.js";
import { type AgentEvent, createSession, getSession } from "./session.js";
import { constructionFacts, openTemplate } from "./tools.js";
import * as forge from "./forge.js";

const PORT = Number(process.env.PORT ?? 8792);
const ORIGINS = (process.env.FORGE_ALLOWED_ORIGINS ?? "http://localhost:3000").split(",").filter(Boolean);
const MAX_TEXT = 2_000;
const tierModel = (t: unknown) => (t === "advanced" ? MODELS.advanced : MODELS.standard);
const isAddress = (a: unknown): a is string => typeof a === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);

// simple per-IP rate limit: model calls cost money
const hits = new Map<string, number[]>();
const all: number[] = [];
function limited(ip: string, perMinute = Number(process.env.AGENT_RATE_PER_MIN ?? 6)) {
  const now = Date.now();
  // and a global ceiling across all callers
  while (all.length && now - all[0]! > 60_000) all.shift();
  if (all.length >= Number(process.env.AGENT_GLOBAL_RATE_PER_MIN ?? 30)) return true;
  all.push(now);
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > perMinute;
}

// behind the gateway: the client address is the last X-Forwarded-For entry (added by the edge proxy)
const app = Fastify({ logger: false, bodyLimit: 64 * 1024, trustProxy: 1 });
await app.register(cors, { origin: ORIGINS });

app.get("/health", async () => ({ ok: true, configured: hasKey(), models: MODELS }));

app.post<{ Body: { owner?: string; tier?: string } }>("/sessions", async (req, reply) => {
  const owner = req.body?.owner;
  if (owner != null && !isAddress(owner)) return reply.code(400).send({ error: "owner must be a base58 address" });
  const s = createSession({ owner: owner ?? null, portfolio: null, quoteHoldings: null, model: tierModel(req.body?.tier) });
  return { id: s.id, model: s.model, configured: hasKey() };
});

app.post<{ Params: { id: string }; Body: { text?: string } }>("/sessions/:id/messages", async (req, reply) => {
  const s = getSession(req.params.id);
  if (!s) return reply.code(404).send({ error: "unknown session" });
  const text = String(req.body?.text ?? "").trim();
  if (!text || text.length > MAX_TEXT) return reply.code(400).send({ error: `text must be 1-${MAX_TEXT} characters` });
  if (s.busy) return reply.code(409).send({ error: "a turn is already running" });
  if (limited(req.ip)) return reply.code(429).send({ error: "too many requests; wait a minute" });

  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    ...(req.headers.origin && ORIGINS.includes(req.headers.origin) ? { "access-control-allow-origin": req.headers.origin } : {}),
  });
  const send = (e: AgentEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
  const ac = new AbortController();
  // the client went away before the turn finished (the request's own "close" fires once its body is read)
  res.on("close", () => {
    if (!res.writableEnded) ac.abort();
  });
  s.busy = true;
  try {
    await runTurn(s, text, send, ac.signal);
  } catch (e) {
    if (!ac.signal.aborted) send({ type: "error", message: (e as Error).message.slice(0, 300) });
  } finally {
    s.busy = false;
    clearInterval(ping);
    res.end();
  }
});

app.get<{ Params: { id: string; cid: string } }>("/sessions/:id/constructions/:cid", async (req, reply) => {
  const c = getSession(req.params.id)?.constructions.get(req.params.cid);
  if (!c) return reply.code(404).send({ error: "unknown construction" });
  return { facts: constructionFacts(c), payoff: c.payoff, limits: c.limits, days: c.days, market: c.market.name };
});

app.get<{ Params: { id: string; cid: string } }>("/sessions/:id/prepared/:cid", async (req, reply) => {
  const s = getSession(req.params.id);
  const c = s?.constructions.get(req.params.cid);
  if (!s || !c || !s.prepared.has(c.id)) return reply.code(404).send({ error: "not prepared" });
  return openTemplate(c, await forge.findMarket(c.market.address));
});

type HedgeBody = { objective?: string; portfolio?: { symbol: string; amount: number }[]; usdc?: number; owner?: string; tier?: string };
app.post<{ Body: HedgeBody }>("/hedge", async (req, reply) => {
  const b = req.body ?? {};
  const objective = String(b.objective ?? "").trim();
  if (!objective || objective.length > MAX_TEXT) return reply.code(400).send({ error: `objective must be 1-${MAX_TEXT} characters` });
  if (b.owner != null && !isAddress(b.owner)) return reply.code(400).send({ error: "owner must be a base58 address" });
  const portfolio = Array.isArray(b.portfolio)
    ? b.portfolio.filter((h) => typeof h?.symbol === "string" && Number.isFinite(h?.amount) && h.amount >= 0).slice(0, 20).map((h) => ({ symbol: h.symbol.slice(0, 12), amount: h.amount }))
    : null;
  const s = createSession({ owner: b.owner ?? null, portfolio, quoteHoldings: Number.isFinite(b.usdc) ? Number(b.usdc) : null, model: tierModel(b.tier) });
  const events: AgentEvent[] = [];
  let text = "";
  const last = await runTurn(s, `${objective}\n\n(This request comes from an automated client through the FORGE API. Present the options with present_options; nothing will be prepared or signed in this call.)`, (e) => {
    if (e.type === "text") text += e.delta;
    else events.push(e);
  });
  const ms = await forge.markets();
  const options = [];
  for (const o of s.options) {
    const c = s.constructions.get(o.construction_id)!;
    const m = ms.find((x) => x.address === c.market.address)!;
    // stored so the caller (or anyone) can fetch and re-verify it by hash
    await forge.storeCertificate(c.response.certificate);
    options.push({ ...o, facts: constructionFacts(c), certificate: c.response.certificate, open: openTemplate(c, m) });
  }
  return {
    model: last?.model ?? s.model,
    message: text.trim(),
    options,
    steps: events.filter((e) => e.type === "tool_result").map((e) => (e.type === "tool_result" ? { tool: e.name, ok: e.ok, summary: e.summary } : null)),
    usage: events.find((e) => e.type === "done")?.type === "done" ? (events.find((e) => e.type === "done") as Extract<AgentEvent, { type: "done" }>).usage : null,
  };
});

await app.listen({ port: PORT, host: process.env.HOST ?? "127.0.0.1" });
console.log(`architect on :${PORT} (${hasKey() ? `models ${MODELS.standard} / ${MODELS.advanced}` : "no API key: turns are refused"})`);
