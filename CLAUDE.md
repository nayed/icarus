# Icarus

Browser flight simulator: a small amphibious bush plane over a far-north fjord at the edge of night.
Three.js + TypeScript + Vite. The mood is calm, cinematic and a little lonely ("a flight you'd take for
the view, not for a score"). User-facing notes (controls, URL flags, verification, known limitations)
live in NOTES.md; keep them current when behaviour changes.

## Hard requirements
- Everything procedural: no external models, textures or audio files. Textures are drawn on canvases or
  computed in shaders, sound is WebAudio synthesis. Google Fonts (Barlow Condensed, Barlow) are the only
  network dependency.
- 60 fps target, graceful fallbacks (no WebGL2 → message screen; no float render targets → LDR path).

## Commands
- Setup on a new machine: `npm install`, then `npx playwright install chromium` (browser checks need it).
- `npm run dev` · `npm run build` (tsc + vite) · `npx tsc --noEmit` · `npm test` (vitest, `tests/`)
- Browser checks, headless Chromium; each fails on any console error, shader error or failed request:
  - `npm run parity`: terrain identical on CPU and GPU
  - `node scripts/flight.mjs [--models=simulation]`: keyboard flight tests per flight model
  - `node scripts/modes.mjs`: ring run, mountain landing, crash, free flight's random starts
  - `node scripts/uishots.mjs`: menu → flight → pause → results flow, desktop and phone
  - `node scripts/fallbacks.mjs`: `?force=nowebgl2|nofloat|logdepth`
  - `node scripts/maps.mjs`: the map image, the HUD's moving map and the pause screen's chart
  - `npm run perf`: GPU time from timer queries, main-thread time, frame interval
  - `npm run smoke`: what CI runs in the browser (all three pipelines, fails on console/shader errors)
  - `npm run shots`, `node scripts/planeshots.mjs [--hud]`: screenshots into `shots/` (git-ignored)
  - `node scripts/readme-shots.mjs`: the README screenshots in `docs/screenshots/` (repeatable: fixed
    time steps). Rerun it after visible changes and look at the results before committing them.
- `ICARUS_GPU=egl` (default: real GPU through ANGLE, set up on Linux) or `swiftshader` (software, slow; use
  it if WebGL fails headless on another OS). `ICARUS_PROD=1` runs the scripts against `dist/` (build first).
- Scratch experiments go in `scripts/scratch/` (git-ignored).

## Rules that are easy to break
- The terrain exists twice: each function in `src/world/noise.ts` and `src/world/terrain.ts` has a TS
  version and a GLSL mirror next to it, sharing constants from `src/world/params.ts`. Change both
  together, then run `npm run parity`.
- Collision and landing grading use `drawnHeight()`/`drawnSurface()` in `src/world/clipmap.ts`, which
  replicate the clipmap vertex shader (level choice, height morph, triangle split). Shader changes there
  need the CPU side too (parity's raster check catches drift).
- `src/world` and `src/sim` must stay plain enough for Node's type stripping (`node scripts/map.ts`,
  `node scripts/sim/fly.ts`): no parameter properties, enums or namespaces, and no DOM.
- Fjords are polylines in `FJORDS` (`src/world/params.ts`). Fjords past the first `RELIEF_FJORDS` are
  skipped outside `FJORD_BOX`, whose reach mirrors `carveFjord()`'s widths, coves and walls: change them
  together, or the skip stops being exact (parity catches it only where it samples).
- Airstrips are `STRIPS` in `params.ts`: find a site with `node scripts/stripsearch.ts`, add an autoland
  test (`tests/flight.test.ts`), and append (the mountain landing uses index 1).
- Free flights on the water and in the air start at random spots (`src/world/waterStart.ts`,
  `src/world/airStart.ts`), checked on the CPU terrain. The water checks assume a lift-off within 700 m
  and seas no rougher than `MAX_SEA`: retune them with the flight model or the waves (the tests fly
  from random spots). Scripts that need a repeatable start pin it: `session.start(kind, start, model,
  'home')`, or `&strip=`, `&water=`, `&air=` in the URL.
- Imports use explicit `.ts` extensions.
- Custom ShaderMaterials output pre-exposed HDR through `finalOutput()`. Vertex shaders use
  `#include <icarus_logdepth_vertex>` (registered in `src/render/worldRenderer.ts`), not three's
  `logdepthbuf_vertex`, which needs `<common>`.
- Browser scripts drive the app through `window.__icarus` (`?debug`, `src/debug/hooks.ts`); update it
  when app or session APIs change.
- Measure performance with `npm run perf`. Per-pass readPixels profiling misleads on integrated GPUs
  (they change clocks when the pipeline stalls).

## Workflow
- After a change: typecheck, `npm test`, and the browser scripts that cover it. For anything visual,
  take screenshots with the scripts and look at them before calling it done.
- Work and commit directly on `main` (no feature branches). Never push unless asked.
- CI (`.github/workflows/ci.yml`) runs typecheck, unit tests, build and the smoke test on every push
  to `main`, then deploys the build to GitHub Pages. Keep `base: './'` in `vite.config.ts`: the site
  is served under `/icarus/`.

## Design decisions to keep
- UI: dark glass panels, Barlow Condensed for display type, Barlow for body text, and one accent:
  aurora mint `#7fdcc0` (`--accent`/`--accent-rgb` in `src/ui/styles.css`, `ACC` in `src/ui/palette.ts`
  for the canvases).
- Warnings and error screens stay amber (`--alert`, `ALERT`) so they stand out from the accent.
- The cockpit instruments stay amber, and the aircraft's orange livery is orange on purpose (chosen by
  the user): do not recolour either to mint.
- Logo `docs/logo.svg` (README) and favicon `public/favicon.svg` are hand-written SVG: dusk fjord, mint
  aurora, the aircraft in its livery, drawn at the game model's dimensions. Change them together.
- The aircraft is an amphibian: gear down for the strips, gear up for the water.
