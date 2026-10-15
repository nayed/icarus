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

## Status
Stage 1 (terrain, sky, clouds, shadows, forests, HDR post) done. Next: water.
