# FORGE demo video

Everything needed to rebuild the demo video: the script, the recorder that films the real app, and
the edit (motion graphics plus footage) in [Remotion](https://www.remotion.dev).

- `SCRIPT.md`: what to say over each scene, with timings.
- `record/`: Playwright drives the hosted app and records 1920×1080 takes into `footage/` (gitignored).
- `src/`: the edit. `timeline.tsx` lists every scene in order; `scenes/` holds the graphics.

## Record

```bash
cd demo && npm install
node record/record.mjs trader close architect earn agents
```

Each take starts from a clean browser with its own demo wallet, on the hosted fork
(`FORGE_URL` to point elsewhere). Every click happens on camera, dropdowns included. Beat timestamps
go to `footage/marks.json`; the edit plays each take as one continuous shot and only changes its
speed (waits on the network run faster, with a ×N badge), its framing and its captions on those beats.
`proof`, `tour` and `addmarket` are extra takes the three-minute cut leaves out.

The treasury agent's terminal run is captured with real output and timing:

```bash
cd agents/treasury
ANTHROPIC_API_KEY=… FORGE_API=https://forge-backend-production-54df0521.up.railway.app \
TERM_ANSWER="Authorize opening=>y" node ../../demo/record/term.mjs agent "pnpm --filter @forge/treasury-agent start" \
  -- python3 -c "import pty,sys; sys.exit(pty.spawn(sys.argv[1:]) >> 8)" npx tsx src/agent.ts
```

## Add your parts

Your intro and voice-over come from webcam takes:

1. Put the takes (any `.mov` or `.mp4`) in `demo/footage/raw/`.
2. Run `record/takes.sh`. It cleans up the audio (rumble, noise, even loudness), copies every take to
   `footage/cam/`, and cuts `footage/intro.mp4` from the intro take (`INTRO_TAKE`, `INTRO_FROM`,
   `INTRO_TO` pick which take and where).
3. `src/vo.ts` lists every voice-over line: which take, from and to which second, and the scene it
   starts on. `cam: true` shows you in a small round bubble for that line. To find the seconds, a
   transcript with timestamps helps: `whisper-cli -m ggml-base.en.bin -f take.wav -ojf`.

4. Run `python3 record/levels.py`. It measures the intro and every line, and the edit then plays
   each one at the same loudness (−17 LUFS), however loud the take was.

The video takes its length from `intro.mp4`. Optional `music.mp3` in `footage/` is mixed in low.

## Render

```bash
cd demo
npx remotion studio src/index.ts           # preview and scrub
npx remotion render src/index.ts Demo out/forge-demo.mp4
```

`remotion.config.ts` uses Playwright's headless Chrome when it is installed, because Remotion's own
download hangs on some Macs.
