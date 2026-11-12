# STARMENDER

A 60-second procedurally generated animated short film. Everything (character, sets, lighting,
camera work, grade and the full soundtrack) is code: three.js rendered frame by frame in headless
Chrome, plus a Python synthesiser for the score.

    cd film && npm install
    tools/quick.sh      # half-res frames upscaled to 1080p -> out/starmender.mp4
    node tools/render.mjs --frames 0:1440 --out out/frames && tools/build.sh   # full 1920x804 master
    ../.venv/bin/python audio/score.py                                         # re-synthesise the score

`film/timeline.json` is the shot list and audio cue sheet; `film/src/film.js` holds the 17 shots.
