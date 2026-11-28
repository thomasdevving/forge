import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { C, mono, sans } from "../theme";
import { Backdrop, Caption, useIn } from "../ui";

export type TermLog = { command: string; lines: { t: number; line: string }[] };

const clean = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\[\d*[GJK]/g, "").replace(/\r/g, "");

/**
 * Maps the run's real clock onto video time: output plays at real speed, and any silence longer than
 * `maxGap` (waiting on the network or the model) is shortened to `maxGap`, with a working indicator.
 */
export function timeline(log: TermLog, maxGap = 1.4, lead = 1.8) {
  const out: { at: number; line: string; waited: number }[] = [];
  let real = 0, video = lead;
  for (const l of log.lines) {
    const line = clean(l.line);
    const gap = l.t - real;
    // every line gets time to be read, longer lines more; long silences are shortened to maxGap
    const read = line.trim() ? 0.3 + Math.min(1.4, line.length / 150) : 0.1;
    video += Math.max(Math.min(Math.max(0, gap), maxGap), read);
    out.push({ at: video, line, waited: gap > maxGap ? gap : 0 });
    real = l.t;
  }
  return { rows: out, end: video + 3.5 };
}

const LABEL_COLOR: Record<string, string> = {
  "Treasury Agent": C.ink,
  "FORGE API": "#9fb8ff",
  "FORGE Architect": C.ink2,
  Payment: C.warn,
  Verifier: C.good,
  Ledger: C.ink3,
  "Solana (fork)": "#c5a8ff",
};

function Row({ line }: { line: string }) {
  const m = line.match(/^\s*([\d.]+)s\s{2}(\S[^]*?)\s{2,}(.*)$/);
  if (m) {
    const [, , label, msg] = m;
    const color = LABEL_COLOR[label!.trim()] ?? C.ink2;
    const bad = msg!.startsWith("✕");
    return (
      <div style={{ display: "grid", gridTemplateColumns: "250px 1fr", gap: 18, lineHeight: 1.45 }}>
        <span style={{ color }}>{label!.trim()}</span>
        <span style={{ color: bad ? C.bad : msg!.startsWith("✓") ? C.ink : C.ink2 }}>{msg}</span>
      </div>
    );
  }
  if (/^Authorize opening/.test(line.trim())) {
    const [q, a] = line.trim().split(/\]\s*/);
    return <div style={{ color: C.ink, lineHeight: 1.45 }}>{q}] <span style={{ background: C.ink, color: C.bg, padding: "0 6px" }}>{a}</span></div>;
  }
  return <div style={{ color: line.startsWith("Authorization request") ? C.warn : C.ink2, lineHeight: 1.45, whiteSpace: "pre-wrap" }}>{line}</div>;
}

/** A real terminal run, replayed with its own output and timing. */
export const Terminal: React.FC<{ log: TermLog; title: string; caption?: { n?: string; text: string; sub?: string } }> = ({ log, title, caption }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = f / fps;
  const { rows } = timeline(log);
  const shown = rows.filter((r) => r.at <= t);
  const typed = Math.floor(interpolate(t, [0.3, 1.3], [0, log.command.length], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }));
  const next = rows.find((r) => r.at > t);
  const waiting = next && next.waited > 0 && t > next.at - 1.4;
  const enter = useIn(0, 18);
  return (
    <Backdrop glow={0.7}>
      <AbsoluteFill style={{ padding: "70px 110px 150px", opacity: enter, transform: `translateY(${(1 - enter) * 24}px)` }}>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", border: `1px solid ${C.lineStrong}`, borderRadius: 10, background: C.sunk, boxShadow: "0 30px 80px rgba(0,0,0,0.5)", overflow: "hidden" }}>
          <div style={{ height: 52, display: "flex", alignItems: "center", gap: 10, padding: "0 20px", borderBottom: `1px solid ${C.line}`, background: C.elev }}>
            {[0, 1, 2].map((i) => <span key={i} style={{ width: 13, height: 13, borderRadius: 7, background: C.lineStrong }} />)}
            <span style={{ fontFamily: mono, fontSize: 18, color: C.ink3, marginLeft: 16 }}>{title}</span>
          </div>
          <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "flex-end", padding: "24px 30px", fontFamily: mono, fontSize: 22, overflow: "hidden" }}>
            <div style={{ color: C.ink, lineHeight: 1.45 }}>
              <span style={{ color: C.good }}>$</span> {log.command.slice(0, typed)}
              {typed < log.command.length && <span style={{ background: C.ink, marginLeft: 2 }}>&nbsp;</span>}
            </div>
            {shown.map((r, i) => <Row key={i} line={r.line} />)}
            {waiting && (
              <div style={{ color: C.ink3, lineHeight: 1.45 }}>
                {"⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"[Math.floor(f / 3) % 10]} working · {next!.waited.toFixed(0)}s of real time shortened
              </div>
            )}
          </div>
        </div>
      </AbsoluteFill>
      {caption && <Caption {...caption} />}
      <div style={{ position: "absolute", right: 110, bottom: 64, fontFamily: sans, fontSize: 20, color: C.ink3 }}>Real run against the hosted FORGE API · output unedited</div>
    </Backdrop>
  );
};
