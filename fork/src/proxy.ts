/**
 * Public HTTPS/WSS front for the hosted fork (section 11). Only standard read methods and signed
 * transaction submission pass; Surfpool cheatcodes, airdrops, account mutation and admin APIs
 * are blocked. getProgramAccounts is limited to the FORGE program. Per-IP rate limits apply.
 * TLS terminates at the reverse proxy in front of this process (see deploy/Caddyfile).
 */
import http from "node:http";
import { WebSocket, WebSocketServer } from "ws";

const UPSTREAM = process.env.FORK_UPSTREAM_RPC ?? "http://127.0.0.1:8899";
const UPSTREAM_WS = process.env.FORK_UPSTREAM_WS ?? "ws://127.0.0.1:8900";
const PORT = Number(process.env.PORT ?? 8890);
const FORGE_PROGRAM = process.env.FORGE_PROGRAM_ID ?? "8RQGTBgTpbvxZ9BFHpFthHRw5JkaHiUpfrMmjfUv3NN5";
const RATE_PER_MIN = Number(process.env.RPC_RATE_PER_MIN ?? 600);
const ORIGINS = (process.env.FORGE_ALLOWED_ORIGINS ?? "*").split(",");

export const ALLOWED = new Set([
  "getAccountInfo", "getMultipleAccounts", "getBalance", "getTokenAccountBalance", "getTokenAccountsByOwner",
  "getProgramAccounts", "getLatestBlockhash", "isBlockhashValid", "getSignatureStatuses", "sendTransaction",
  "simulateTransaction", "getSlot", "getBlockHeight", "getBlockTime", "getVersion", "getGenesisHash", "getHealth",
  "getMinimumBalanceForRentExemption", "getEpochInfo", "getRecentPrioritizationFees", "getFeeForMessage",
  "getTransaction", "getSignaturesForAddress", "getTokenSupply", "getTokenLargestAccounts",
]);
export const ALLOWED_WS = new Set([
  "accountSubscribe", "accountUnsubscribe", "signatureSubscribe", "signatureUnsubscribe",
  "slotSubscribe", "slotUnsubscribe", "programSubscribe", "programUnsubscribe",
]);

type Req = { jsonrpc: string; id: unknown; method: string; params?: unknown[] };

/** Returns an error message if the request must be blocked, else null. */
export function check(r: Req, ws = false): string | null {
  if (!r || typeof r.method !== "string") return "invalid request";
  if (r.method.startsWith("surfnet_")) return "cheatcodes are not available on the public endpoint";
  const allowed = ws ? ALLOWED_WS : ALLOWED;
  if (!allowed.has(r.method)) return `method ${r.method} is not allowed`;
  if ((r.method === "getProgramAccounts" || r.method === "programSubscribe") && r.params?.[0] !== FORGE_PROGRAM) {
    return "getProgramAccounts is limited to the FORGE program";
  }
  return null;
}

const buckets = new Map<string, { tokens: number; at: number }>();
function allow(ip: string, cost = 1): boolean {
  const now = Date.now();
  const b = buckets.get(ip) ?? { tokens: RATE_PER_MIN, at: now };
  b.tokens = Math.min(RATE_PER_MIN, b.tokens + ((now - b.at) / 60_000) * RATE_PER_MIN);
  b.at = now;
  if (b.tokens < cost) return false;
  b.tokens -= cost;
  buckets.set(ip, b);
  return true;
}

function cors(req: http.IncomingMessage, res: http.ServerResponse) {
  const origin = req.headers.origin ?? "";
  if (ORIGINS.includes("*") || ORIGINS.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type, solana-client");
}

const err = (id: unknown, message: string) => ({ jsonrpc: "2.0", id, error: { code: -32601, message } });

export function createProxy() {
  const server = http.createServer(async (req, res) => {
    cors(req, res);
    if (req.method === "OPTIONS") return res.writeHead(204).end();
    if (req.method !== "POST") return res.writeHead(405).end();
    const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ?? req.socket.remoteAddress ?? "?";
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 1_000_000) return res.writeHead(413).end();
    }
    let parsed: Req | Req[];
    try {
      parsed = JSON.parse(body);
    } catch {
      return res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify(err(null, "parse error")));
    }
    const list = Array.isArray(parsed) ? parsed : [parsed];
    if (list.length > 50 || !allow(ip, list.length)) {
      return res.writeHead(429, { "content-type": "application/json" }).end(JSON.stringify(err(null, "rate limited")));
    }
    const blocked = list.map((r) => check(r));
    if (blocked.some(Boolean)) {
      const out = list.map((r, i) => (blocked[i] ? err(r?.id, blocked[i]!) : err(r?.id, "batch rejected")));
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(Array.isArray(parsed) ? out : out[0]));
    }
    const up = await fetch(UPSTREAM, { method: "POST", headers: { "content-type": "application/json" }, body });
    res.writeHead(up.status, { "content-type": "application/json" });
    res.end(await up.text());
  });

  const wss = new WebSocketServer({ server });
  wss.on("connection", (client, req) => {
    const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ?? req.socket.remoteAddress ?? "?";
    const upstream = new WebSocket(UPSTREAM_WS);
    const pending: string[] = [];
    upstream.on("open", () => pending.splice(0).forEach((m) => upstream.send(m)));
    upstream.on("message", (m) => client.readyState === WebSocket.OPEN && client.send(m.toString()));
    upstream.on("close", () => client.close());
    client.on("message", (raw) => {
      let r: Req;
      try {
        r = JSON.parse(raw.toString());
      } catch {
        return client.send(JSON.stringify(err(null, "parse error")));
      }
      const why = check(r, true) ?? (allow(ip) ? null : "rate limited");
      if (why) return client.send(JSON.stringify(err(r.id, why)));
      const s = JSON.stringify(r);
      if (upstream.readyState === WebSocket.OPEN) upstream.send(s);
      else pending.push(s);
    });
    client.on("close", () => upstream.close());
  });
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createProxy().listen(PORT, process.env.HOST ?? "127.0.0.1", () => console.log(`rpc proxy on :${PORT} -> ${UPSTREAM}`));
}
