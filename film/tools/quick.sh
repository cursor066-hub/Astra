#!/usr/bin/env bash
# Fast delivery render: half-resolution frames, upscaled to 1080p. Produces a 12 fps cut as soon as the
# even frames exist, then fills in the odd frames for the full 24 fps film.
set -uo pipefail
cd "$(dirname "$0")/.."
F=out/frames_h
AUDIO=out/audio/score_final.wav
mkdir -p "$F"
VF="scale=1920:804:flags=lanczos,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p"
enc() { # fps out
  ffmpeg -y -loglevel error -framerate "$1" -pattern_type glob -i "$F/f_*.png" -i "$AUDIO" -vf "$VF" -r 24 \
    -c:v libx264 -preset medium -crf 17 -pix_fmt yuv420p -c:a aac -b:a 224k -movflags +faststart -t 60 "$2" && echo "BUILT $2"
}
node tools/render.mjs --frames 0:1440 --part 0/2 --scale 0.5 --out "$F" --skip true --quiet true
enc 12 out/starmender_12fps.mp4
node tools/render.mjs --frames 0:1440 --part 1/2 --scale 0.5 --out "$F" --skip true --quiet true
enc 24 out/starmender.mp4
echo ALL_DONE
