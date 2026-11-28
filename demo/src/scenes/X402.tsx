import React from "react";
import { AbsoluteFill, interpolate } from "remotion";
import { C, mono, sans } from "../theme";
import { Backdrop, ease, Kicker, useFrame, useIn, useOut } from "../ui";

export type X402Facts = { path: string; price: string; tx: string };

const LANES = [
  { key: "agent", label: "Your agent", sub: "holds fork USDC", x: 360 },
  { key: "api", label: "FORGE API", sub: "/x402", x: 960 },
  { key: "sol", label: "Solana", sub: "Surfpool fork", x: 1560 },
] as const;
const lane = (k: string) => LANES.find((l) => l.key === k)!.x;

/** The x402 exchange, as a sequence diagram, with the values from the real run. */
export const X402: React.FC<{ facts: X402Facts }> = ({ facts }) => {
  const f = useFrame();
  const title = useIn(0, 20);
  const out = useOut(14);
  const msgs = [
    { from: "agent", to: "api", text: `POST ${facts.path}`, sub: "what it holds and what it wants" },
    { from: "api", to: "agent", text: "402 Payment Required", sub: `PAYMENT-REQUIRED: ${facts.price} USDC`, hi: C.warn },
    { from: "agent", to: "api", text: "same request + PAYMENT-SIGNATURE", sub: "a signed USDC transfer, nothing else" },
    { from: "api", to: "sol", text: "settle the transfer", sub: "FORGE pays the network fee" },
    { from: "sol", to: "api", text: "confirmed", sub: `tx ${facts.tx}…`, hi: "#c5a8ff" },
    { from: "api", to: "agent", text: "200 OK + certified options", sub: "PAYMENT-RESPONSE carries the settlement", hi: C.good },
  ];
  const TOP = 330, STEP = 104;
  return (
    <Backdrop glow={0.8}>
      <AbsoluteFill style={{ opacity: out }}>
        <div style={{ position: "absolute", left: 140, top: 86, opacity: title }}>
          <Kicker n="04">x402</Kicker>
          <div style={{ fontFamily: sans, fontSize: 64, fontWeight: 600, letterSpacing: -2, marginTop: 18 }}>HTTP 402, turned into a payment rail.</div>
        </div>
        {LANES.map((l) => (
          <div key={l.key} style={{ position: "absolute", left: l.x - 160, top: 228, width: 320, textAlign: "center", opacity: title }}>
            <div style={{ fontFamily: sans, fontSize: 30, fontWeight: 600 }}>{l.label}</div>
            <div style={{ fontFamily: mono, fontSize: 18, color: C.ink3, marginTop: 4 }}>{l.sub}</div>
          </div>
        ))}
        <svg width={1920} height={1080} style={{ position: "absolute", inset: 0 }}>
          <defs>
            <marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill={C.ink} />
            </marker>
          </defs>
          {LANES.map((l) => <line key={l.key} x1={l.x} x2={l.x} y1={TOP - 20} y2={TOP + STEP * msgs.length} stroke={C.lineStrong} strokeDasharray="4 8" opacity={title} />)}
          {msgs.map((msg, i) => {
            const start = 30 + i * 40;
            const a = interpolate(f, [start, start + 22], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
            const x1 = lane(msg.from), x2 = lane(msg.to), yy = TOP + 30 + i * STEP;
            const xe = x1 + (x2 - x1) * a;
            return (
              <g key={i} opacity={a > 0 ? 1 : 0}>
                <line x1={x1} x2={xe} y1={yy} y2={yy} stroke={msg.hi ?? C.ink} strokeWidth={3} markerEnd={a > 0.96 ? "url(#ah)" : undefined} />
                <circle cx={x1} cy={yy} r={6} fill={msg.hi ?? C.ink} />
              </g>
            );
          })}
        </svg>
        {msgs.map((msg, i) => {
          const start = 30 + i * 40;
          const a = interpolate(f, [start + 8, start + 26], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
          const x1 = lane(msg.from), x2 = lane(msg.to), yy = TOP + 30 + i * STEP;
          return (
            <div key={i} style={{ position: "absolute", left: Math.min(x1, x2), width: Math.abs(x2 - x1), top: yy - 56, textAlign: "center", opacity: a }}>
              <div style={{ fontFamily: mono, fontSize: 25, color: msg.hi ?? C.ink }}>{msg.text}</div>
              <div style={{ fontFamily: sans, fontSize: 20, color: C.ink3, marginTop: 30 }}>{msg.sub}</div>
            </div>
          );
        })}
      </AbsoluteFill>
    </Backdrop>
  );
};
