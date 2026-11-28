// Runs a real command and records each output line with the time it appeared, for the terminal scenes.
//   node record/term.mjs <name> "<shown command>" -- <cmd> [args...]
// TERM_ANSWER="<text in a prompt>=><reply>" types the reply into the process once that prompt appears (run it under
// `script -q /dev/null` so it gets a terminal); the reply is recorded as typed input on the prompt line.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
const [name, shown, sep, cmd, ...args] = process.argv.slice(2);
if (sep !== "--" || !cmd) throw new Error('usage: term.mjs <name> "<shown command>" -- <cmd> [args...]');
const out = new URL("../footage/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const t0 = Date.now();
const lines = [];
const p = spawn(cmd, args, { env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" } });
const [askFor, reply] = (process.env.TERM_ANSWER ?? "").split("=>");
let answered = false;
const take = (stream) => {
  let buf = "";
  stream.on("data", (d) => {
    buf += d.toString().replace(/\r/g, "");
    if (askFor && !answered && buf.includes(askFor)) {
      answered = true;
      setTimeout(() => p.stdin.write(`${reply}\n`), 1800);
    }
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\x1b\[[0-9;]*m/g, "");
      buf = buf.slice(i + 1);
      lines.push({ t: (Date.now() - t0) / 1000, line });
      process.stdout.write(line + "\n");
    }
  });
};
take(p.stdout);
take(p.stderr);
p.on("exit", (code) => {
  writeFileSync(`${out}/term-${name}.json`, JSON.stringify({ command: shown, code, lines }, null, 2));
  console.log(`[saved term-${name}.json, exit ${code}]`);
});
