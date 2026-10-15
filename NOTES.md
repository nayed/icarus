# Icarus — notes

A calm, procedural flight simulator: a small amphibian over a far-north fjord at the edge of night.
Three.js + TypeScript + Vite. No external models, textures or audio. The only downloads are the two
Google Fonts (Barlow Condensed, Barlow), with condensed system fonts as fallback.

## License
MIT, see [LICENSE](LICENSE). Third-party code: three.js (MIT; its license header is kept in the built
bundle). The Barlow and Barlow Condensed fonts (SIL Open Font License) load from Google Fonts and are
not part of this repository.

## Run
- `npm install`, then `npm run dev` (http://localhost:5173). `npm run build` / `npm run preview` for production.
- `npm test`: vitest (pure TS: clipmap tiling and drawn-surface continuity, flat runways, water mirror,
  the three flight models, grading, forest tiling, resolution scaling).
- Browser checks (Playwright, headless Chromium on the real GPU through ANGLE/EGL; `ICARUS_GPU=swiftshader`
  forces software rendering):
  - `npm run parity`: GPU ↔ CPU terrain (GLSL vs TS, and the real clipmap meshes rasterised vs `drawnHeight()`)
  - `node scripts/flight.mjs`: keyboard flight tests for each flight model
  - `node scripts/modes.mjs`: ring run, mountain landing, crash
  - `node scripts/uishots.mjs`: menu → flight → pause → results flow, desktop and phone
  - `node scripts/fallbacks.mjs`: no WebGL2, no float render targets, logarithmic depth
  - `npm run shots`, `node scripts/planeshots.mjs`: screenshot matrices (`shots/`, git-ignored)
  - `npm run perf`: GPU time (timer queries), main-thread time and frame interval per preset and view
- URL flags: `?q=low|medium|high`, `?t=dawn|day|golden|dusk|night|<hours>`, `?mode=free|rings|landing`
  with `&start=runway|water|air` (skips the menu), `?model=arcade|assisted|simulation`, `?noui`, `?nohud`,
  `?debug` (test API on `window.__icarus`), `?cam=x,y,z,yaw,pitch`, `?force=nowebgl2|nofloat|logdepth|noatlas`.
- Preferences (mode, start, time, model, quality, sliders) persist in `localStorage`.

## Controls (physical keys; the labels in the game follow your keyboard layout)
| | |
|---|---|
| Pitch | W / S or ↑ / ↓ |
| Roll | A / D or ← / → |
| Rudder | Q / E |
| Throttle | R / F |
| Brakes | Space |
| Flaps down / up | X / Z |
| Gear | G (down for the strips, up for the water: the aircraft is an amphibian) |
| Trim | Y / T |
| Camera | C cycles; 1 chase, 2 cockpit, 3 cinematic; drag the mouse to look around |
| Landing light | L |
| HUD / fullscreen | H / K |
| Pause | Esc or P |
| Restart | Backspace |

Menu: Enter flies; Esc on the results card goes back to the menu.

## Modes and flight models
- Free flight: start on the coastal strip, on the water in the fjord, or in the air.
- Ring run: 14 gates down the fjord against the clock (par 4:26); a missed gate costs 5 s. Graded on time.
- Mountain landing: from a 4 km final to the shelf strip at ~800 m. Graded on sink rate, centreline,
  touchdown point, wings level and stopping on the strip. A crash or overrun is an F.
- Arcade: rate-command attitude, protected stall. Assisted: real aerodynamics with auto-trim, turn
  coordination, wing leveller and stall protection. Simulation: raw aerodynamics with no protections
  (propeller torque, P-factor and adverse yaw are left for the pilot).

## How the terrain stays identical on CPU and GPU
- `src/world/noise.ts` and `terrain.ts` hold the TS function and its GLSL mirror side by side. The lattice
  hash is 32-bit integer math (bit-exact on both sides); constants come from `params.ts`.
- `src/world/clipmap.ts` is a geometry clipmap whose vertices sit on each level's lattice. Only the heights
  morph toward the coarser level near a level's edge. `drawnHeight()` reproduces the vertex shader and the
  triangle split, so collision and landing grading use the rendered surface. Lattice heights are baked into
  a float atlas when a level moves (the vertex shader only fetches); on the CPU they are memoised.
- Measured parity (Intel iGPU, fp32 vs fp64): function ≤ 3.5 mm worldwide; rasterised surface vs CPU
  ≤ 0.22 mm near the camera, ≤ 3 mm out to ±30 km.

## Rendering
- HDR half-float target (MSAA), Hillaire atmosphere LUTs, volumetric clouds at ½ or ¼ resolution with
  temporal accumulation and a depth-aware bicubic upsample, bloom mip chain, ACES, vignette, grain.
- Reversed-Z depth where `EXT_clip_control` exists, logarithmic depth otherwise.
- Fallbacks: no WebGL2 → explanation screen. No float render targets → LDR pipeline (tone mapping in the
  materials, flat cloud layer instead of the volumetric one, no terrain self-shadows). Shader compile
  errors and context loss → message screens.
- Quality presets high / medium / low. The resolution scale (0.5–1×) follows the measured GPU frame time
  (`EXT_disjoint_timer_query_webgl2`) where the browser exposes it. Otherwise it follows the frame
  interval and probes upward with exponential backoff, since a vsync-locked interval never shows headroom.

## Verification (this machine: Intel Lunar Lake iGPU, Linux, headless Chromium through ANGLE/EGL)
- `npm test`: 38 tests pass. Coverage: for each flight model, takeoff, runway rest (< 1 mm drift),
  coastal, mountain and water landings, water takeoff, drop tests (never below the drawn surface beyond
  tyre compression), stall and recovery, gear-down water crash; plus grading, forest tiling and scaler
  behaviour.
- Keyboard flight tests (real key events), all three models:
  - runway rest ≤ 0.16 mm drift in 10 s
  - keyboard takeoff (liftoff after 245–280 m at ~70 kt)
  - Simulation stall with the warning before the break, 15–22 m lost, then recovery;
    Arcade/Assisted protected
  - autoland, then rest after rollout
  - lowest contact point never more than the tyre compression (≤ 0.16 m) below the drawn surface
- Modes:
  - autopilot ring run 14/14 (B, 5:19.8)
  - a run 45 m wide of every gate is penalised (C)
  - autopilot mountain landing (B, 75)
  - landing flown into the ground (F, gear collapsed)
  - a crash into the sea ends free flight
- UI flow (menu → Enter → pause → slider → resume → results → menu) at 1920×1080 and 390×844. The menu
  fits from 1366×768 up; on shorter screens the settings scroll and Fly stays in view.
- Fallbacks render with no console errors: `nowebgl2`, `nofloat`, `logdepth`, `nofloat,logdepth`.
- Console: no errors, shader or GL errors, page errors or failed requests in any of the runs above.
- Frame cost at 1920×1080 (GPU time by timer query, steady 16.7 ms frame interval in every view):

  | preset | GPU ms (7 views) | main thread ms |
  |---|---|---|
  | high | 8.8 – 16.2 | ≤ 4.4 |
  | medium | 5.6 – 10.5 | ≤ 3.2 |
  | low (renders at 0.75×) | 2.7 – 5.7 | ≤ 3.1 |

## Not verified
- Other GPUs (discrete NVIDIA/AMD, Apple, mobile), other browsers (Firefox, Safari) and Windows/macOS
  drivers. Frame rates above come from one integrated GPU in headless Chromium.
- Audio: the WebAudio graph is built and its parameters follow the aircraft, but nobody has listened to it.
- Touch devices: the game is flown with a keyboard; on a phone the menu, HUD and cinematic camera work,
  but there are no touch controls.
- Real fullscreen and HiDPI behaviour (headless: the toggle and resize paths run, the window does not change).

## Known limitations
- Water collision uses the analytic Gerstner surface; the drawn water mesh drops short waves on far LOD
  levels, so far from the camera the two can differ by a few cm.
- The drawn terrain depends on the camera (clipmap LOD). Deep penetrations after camera cuts or teleports
  are resolved by moving the aircraft up without adding energy.
- On the LDR fallback the clouds are a flat layer and the terrain has no self-shadowing.
- Trees stream in nearest-first after a start (the nearest 500 m appear at once).
