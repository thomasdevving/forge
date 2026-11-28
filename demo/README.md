# FORGE demo video

Everything needed to rebuild the demo video: the script, the recorder that films the real app, and
the edit (motion graphics plus footage) in [Remotion](https://www.remotion.dev).

- `SCRIPT.md`: what to say over each scene, with timings.
- `record/`: Playwright drives the hosted app and records 1920×1080 takes into `footage/` (gitignored).
- `src/`: the edit. `timeline.tsx` lists every scene in order; `scenes/` holds the graphics.

## Record

```bash
cd demo && npm install
node record/record.mjs trader architect close earn agents proof tour addmarket
```

Each take starts from a clean browser with its own demo wallet, on the hosted fork
(`FORGE_URL` to point elsewhere). Beat timestamps go to `footage/marks.json`, and the edit cuts on them.

The treasury agent's terminal run is captured with real output and timing:

```bash
cd agents/treasury
ANTHROPIC_API_KEY=… FORGE_API=https://forge-backend-production-54df0521.up.railway.app \
TERM_ANSWER="Authorize opening=>y" node ../../demo/record/term.mjs agent "pnpm --filter @forge/treasury-agent start" \
  -- python3 -c "import pty,sys; sys.exit(pty.spawn(sys.argv[1:]) >> 8)" npx tsx src/agent.ts
```

## Add your parts

Put these in `demo/footage/`; the edit picks them up automatically:

| File | What |
|---|---|
| `intro.mp4` | Your on-camera intro, 1920×1080, about 32 s. Until it exists, a placeholder shows the lines. |
| `vo-1.wav` … `vo-4.wav` | Voice-over for parts 1–4; each starts at its part's title card. |
| `music.mp3` | Optional background music, mixed low. |

## Render

```bash
cd demo
npx remotion studio src/index.ts           # preview and scrub
npx remotion render src/index.ts Demo out/forge-demo.mp4
```

`remotion.config.ts` uses Playwright's headless Chrome when it is installed, because Remotion's own
download hangs on some Macs.
