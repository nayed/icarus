# Icarus — notes

Procedural fjord flight simulator (Three.js + TypeScript + Vite). No external models, textures or audio.

## Run
- `npm install`, then `npm run dev` (http://localhost:5173). `npm run build` / `npm run preview` for production.
- `npm test`: vitest (pure TS: clipmap tiling, drawn-surface continuity, flat runways, ...).
- `npm run parity`: GPU ↔ CPU terrain check (GLSL function vs TS, and the real clipmap meshes rasterised
  from above vs `drawnHeight()`), `npm run shots`, `npm run perf`, `npm run profile` (Playwright scripts).
  Headless Chromium uses the real GPU through ANGLE/EGL by default; `ICARUS_GPU=swiftshader` forces software.
- Debug URL flags: `?debug` (test API on `window.__icarus`), `&q=low|medium|high`, `&t=dawn|day|golden|dusk|night|<hours>`,
  `&cam=x,y,z,yaw,pitch`, `&force=nofloat|nowebgl2|logdepth|noatlas`.

## How the terrain stays identical on CPU and GPU
- `src/world/noise.ts` / `terrain.ts` hold the TS function and its GLSL mirror side by side. The lattice hash is
  32-bit integer math (bit-exact on both sides); constants come from `params.ts`.
- `src/world/clipmap.ts`: geometry clipmap whose vertices sit on each level's lattice; only heights morph
  toward the coarser level near a level's edge. `drawnHeight()` reproduces the vertex shader and the triangle
  split, so collision uses the rendered surface. Lattice heights are baked into a float atlas when a level
  moves (the vertex shader only fetches); with `force=noatlas` or no float targets it evaluates directly.
- Parity (iGPU, fp32 vs fp64): function ≤ 4 mm worldwide; rasterised surface vs CPU ≤ 0.2 mm near the
  camera, ≤ 3 mm out to ±30 km.

## Controls (physical keys; labels follow your layout)
W/S or ↑/↓ pitch · A/D or ←/→ roll · Q/E rudder · R/F throttle · Space brakes · G gear · X/Z flaps down/up ·
T/Y trim · C camera (1 chase, 2 cockpit, 3 cinematic) · L landing light · H HUD · K fullscreen · drag mouse to look.
Gear down for the strips, gear up for water (the aircraft is an amphibian).

## Status (work in progress)
- Done: stage 1 (terrain, sky, clouds, shadows, forests, HDR post), stage 2 (water), most of stage 3
  (6DOF flight model with 3 models, wheel/float contacts, crash detection, procedural aircraft + cockpit
  panel, chase/cockpit/cinematic cameras, aircraft shadow, strip lights/windsocks, procedural audio).
- Not done yet: stage 4 (ring run, mountain-landing grading), stage 5 (main menu, pause/settings overlay,
  canvas HUD, results card, LDR/no-WebGL2 fallback checks, final sweep). The app currently starts straight
  into free flight on the coastal strip (`?start=runway|water|air`, `?model=arcade|assisted|simulation`).

## Verification so far
- `npm test`: 27 tests: clipmap tiling/continuity, flat runways, water mirror, and for each flight model:
  takeoff, rest on runway (< 1 mm drift), coastal + mountain + water landings, water takeoff, drop tests
  (never below the drawn surface beyond tyre compression), stall + recovery, gear-down water crash.
- `node scripts/flight.mjs`: real key events in the browser for all three models: rest on the runway
  (≤ 0.2 mm drift in 10 s), keyboard takeoff and climb, stall (Simulation: warning before the break, then
  recovery; Arcade/Assisted: protected), rendered autoland, rest after rollout, and the lowest contact point
  never more than the tyre compression (~0.16 m) below the drawn surface.
- Performance (Intel Lunar Lake iGPU, 1080p, `npm run perf`): before the aircraft/water were added,
  high ≈ 13–17 ms, medium ≈ 9 ms, low ≈ 5 ms; with water ≈ 21 / 15 / 9 ms. Not re-measured with the aircraft.

## Known limitations
- Water collision uses the analytic Gerstner surface; the drawn water mesh drops short waves on far LOD
  levels, so far from the camera they can differ by a few cm.
- The drawn terrain depends on the camera (clipmap LOD). Deep penetrations caused by camera cuts or
  teleports are resolved by moving the aircraft up without adding energy.
