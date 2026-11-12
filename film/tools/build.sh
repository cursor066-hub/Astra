#!/usr/bin/env bash
# Assemble the rendered frames and the synthesised score into the final film.
#   tools/build.sh [frames_dir] [audio.wav] [out.mp4]
set -euo pipefail
cd "$(dirname "$0")/.."
FRAMES="${1:-out/frames}"
AUDIO="${2:-out/audio/score.wav}"
OUT="${3:-out/starmender.mp4}"
# 1920x804 scope picture letterboxed into 1920x1080, high quality H.264, AAC audio
ffmpeg -y -loglevel error -framerate 24 -i "$FRAMES/f_%05d.png" -i "$AUDIO" \
  -vf "pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p" \
  -c:v libx264 -preset slow -crf 15 -profile:v high -pix_fmt yuv420p -colorspace bt709 -color_primaries bt709 -color_trc bt709 \
  -c:a aac -b:a 256k -movflags +faststart -t 60 "$OUT"
ffprobe -v error -show_entries format=duration,size -show_entries stream=codec_name,width,height,r_frame_rate -of default=nw=1 "$OUT"
