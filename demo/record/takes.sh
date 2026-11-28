#!/usr/bin/env bash
# Turns the webcam takes in footage/raw/ into what the edit uses:
#   footage/intro.mp4        the on-camera intro, trimmed to the speech
#   footage/cam/<take>.mp4   every take, for voice-over lines and webcam bubbles
# Audio: a high-pass against rumble, light denoising, and loudness evened out to -16 LUFS.
set -euo pipefail
cd "$(dirname "$0")/../footage"
mkdir -p cam
AF="highpass=f=80,afftdn=nf=-25,loudnorm=I=-16:TP=-1.5:LRA=11"
for f in raw/*.mov; do
  b=$(basename "$f" .mov)
  ffmpeg -loglevel error -y -i "$f" -af "$AF" -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p -c:a aac -b:a 192k -ar 48000 -movflags +faststart "cam/$b.mp4"
  echo "cam/$b.mp4"
done
# the intro is take 15.48, from just before the first word to just after the last
INTRO_TAKE=${INTRO_TAKE:-take-15h48} INTRO_FROM=${INTRO_FROM:-1.3} INTRO_TO=${INTRO_TO:-16.9}
ffmpeg -loglevel error -y -ss "$INTRO_FROM" -to "$INTRO_TO" -i "raw/$INTRO_TAKE.mov" -af "$AF,afade=t=in:d=0.08" -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -c:a aac -b:a 192k -ar 48000 -movflags +faststart intro.mp4
echo intro.mp4
