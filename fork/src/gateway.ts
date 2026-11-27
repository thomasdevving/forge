/**
 * Single public entry point for a hosted FORGE stack (Railway): one port, path-prefixed routes to the
 * internal services. HTTP and WebSocket upgrades are forwarded as-is; the prefix is stripped.
 *
 *   /rpc/*       -> RPC proxy :8890 (method allowlist, no cheatcodes; also WebSocket subscriptions)
 *   /indexer/*   -> indexer :8787
 *   /tx/*        -> transaction builder :8788
 *   /compiler/*  -> compiler API :8000
 *   /control/*   -> demo control :8791 (faucet, market onboarding; scenario routes need a token)
 *   /agent/*     -> the Architect :8792 (conversations for the Studio; /agent/hedge is only reachable
 *                   paid, through /x402/hedge)
 *   /x402/*      -> x402 payment layer, in process (x402.ts): paid compile/hedge, settled on the fork;
 *                   disabled (503) unless the settlement RPC is a Surfpool fork
 *   /health      -> gateway + upstream health
 */
import http from "node:http";
import net from "node:net";
import { createX402App } from "./x402.js";

const PORT = Number(process.env.PORT ?? 8080);
const ROUTES: Record<string, number> = { rpc: 8890, indexer: 8787, tx: 8788, compiler: 8000, control: 8791, agent: 8792 };
const x402 = await createX402App().catch((e: Error) => {
  console.log(`[x402] DISABLED (fail closed): ${e.message}`);
  return null;
});

function route(url = "/"): { port: number; path: string } | null {
  const m = /^\/([a-z]+)(\/.*)?$/.exec(url.split("?")[0]!);
  const port = m ? ROUTES[m[1]!] : undefined;
  if (!port) return null;
  const rest = url.slice(m![1]!.length + 1);
  const path = rest.startsWith("/") ? rest : `/${rest}`;
  // the machine endpoint is sold through x402; never expose it unpaid
  if (m![1] === "agent" && /^\/hedge(\/|\?|$)/.test(path)) return null;
  return { port, path };
}

async function upstreamHealth() {
  const out: Record<string, boolean> = {};
  await Promise.all(
    Object.entries(ROUTES).map(async ([name, port]) => {
      const path = name === "rpc" ? "/" : "/health";
      try {
        const r = await fetch(`http://127.0.0.1:${port}${path}`, {
          method: name === "rpc" ? "POST" : "GET",
          headers: { "content-type": "application/json" },
          body: name === "rpc" ? JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }) : undefined,
          signal: AbortSignal.timeout(5_000),
        });
        out[name] = r.ok;
      } catch {
        out[name] = false;
      }
    }),
  );
  return out;
}

const server = http.createServer(async (req, res) => {
  if (req.url === "/health" || req.url === "/") {
    const up = await upstreamHealth();
    const ok = Object.values(up).every(Boolean);
    res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok, services: up }));
  }
  if (/^\/x402(\/|\?|$)/.test(req.url ?? "")) {
    if (x402) return x402.handle(req, res);
    res.writeHead(503, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "x402 disabled" }));
  }
  const r = route(req.url);
  if (!r) {
    res.writeHead(404, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "unknown route" }));
  }
  const up = http.request(
    { host: "127.0.0.1", port: r.port, path: r.path, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${r.port}` } },
    (u) => {
      res.writeHead(u.statusCode ?? 502, u.headers);
      u.pipe(res);
    },
  );
  up.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "upstream unavailable" }));
  });
  req.pipe(up);
});

// WebSocket (RPC subscriptions): splice the raw sockets after rewriting the request line.
server.on("upgrade", (req, socket, head) => {
  const r = route(req.url);
  if (!r) return socket.destroy();
  const up = net.connect(r.port, "127.0.0.1", () => {
    const lines = [`${req.method} ${r.path} HTTP/${req.httpVersion}`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i]!, v = req.rawHeaders[i + 1]!;
      lines.push(`${k}: ${k.toLowerCase() === "host" ? `127.0.0.1:${r.port}` : v}`);
    }
    up.write(lines.join("\r\n") + "\r\n\r\n");
    if (head.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on("error", () => socket.destroy());
  socket.on("error", () => up.destroy());
});

server.listen(PORT, "0.0.0.0", () => console.log(`gateway on :${PORT}`));
