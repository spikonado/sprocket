#!/usr/bin/env bash
# Encodes an edited recording for the home page as public/media/<id>.mp4 plus a poster from its
# first frame. Run with ffmpeg on PATH, e.g. `nix shell nixpkgs#ffmpeg -c bash scripts/encode-media.sh in.mov parts`.
# Loop clips play muted, so only the film keeps its audio.
set -euo pipefail

input=$1
id=$2
width=${3:-1600}
out="$(dirname "$0")/../public/media"
mkdir -p "$out"

audio=(-an)
[[ $id == film ]] && audio=(-c:a aac -b:a 128k)

ffmpeg -y -loglevel error -i "$input" \
	-vf "scale=$width:-2:flags=lanczos,fps=30,format=yuv420p" \
	-c:v libx264 -preset slow -crf 26 -profile:v high -movflags +faststart \
	"${audio[@]}" "$out/$id.mp4"

ffmpeg -y -loglevel error -i "$out/$id.mp4" -frames:v 1 -c:v libwebp -quality 82 "$out/$id.webp"
