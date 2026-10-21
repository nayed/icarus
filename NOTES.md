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
  the three flight models, grading, forest tiling, resolution scaling, map view and coverage).
- Browser checks (Playwright, headless Chromium on the real GPU through ANGLE/EGL; `ICARUS_GPU=swiftshader`
  forces software rendering):
  - `npm run parity`: GPU ↔ CPU terrain (GLSL vs TS, and the real clipmap meshes rasterised vs `drawnHeight()`)
  - `node scripts/flight.mjs`: keyboard flight tests for each flight model
  - `node scripts/modes.mjs`: ring run, landings, crash, free flight's random starts
  - `node scripts/uishots.mjs`: menu → flight → pause → results flow, desktop and phone
  - `node scripts/fallbacks.mjs`: no WebGL2, no float render targets, logarithmic depth
  - `node scripts/maps.mjs`: the map image against the terrain, the HUD map heading-up (its pixels
    against the terrain at three headings), M and its saved setting, re-baking at the edge, phone layout;
    the pause screen's chart (readouts, zoom about the cursor, drag, buttons, track, layouts)
  - `npm run shots`, `node scripts/planeshots.mjs`: screenshot matrices (`shots/`, git-ignored)
  - `node scripts/readme-shots.mjs`: regenerates the README screenshots in `docs/screenshots/`
  - `npm run smoke`: boots the game in the three pipelines (default, `nofloat`, `logdepth`) through the
    menu, a flight, the cockpit, the ring run, the maps and the pause screen, failing on any console or
    shader error. CI runs it on
    the build with software WebGL: `ICARUS_PROD=1 ICARUS_GPU=swiftshader npm run smoke`
- CI (`.github/workflows/ci.yml`, on pushes to `main` and pull requests): typecheck, unit tests, build,
  smoke test; on `main` it then deploys `dist/` to GitHub Pages (https://nayed.github.io/icarus/).
  The heavier browser checks need a real GPU and stay local.
  - `npm run perf`: GPU time (timer queries), main-thread time and frame interval per preset and view
- URL flags: `?q=low|medium|high`, `?t=dawn|day|golden|dusk|night|<hours>`, `?mode=free|rings|landing`
  with `&start=runway|water|air` (skips the menu; `&strip=coastal|mountain|north|east|south` picks the
  strip, `&water=x,z,heading` the spot on the water and `&air=x,y,z,heading` the one in the air, else
  they are random),
  `?model=arcade|assisted|simulation`, `?noui`, `?nohud`, `?debug` (test API on `window.__icarus`),
  `?cam=x,y,z,yaw,pitch`, `?force=nowebgl2|nofloat|logdepth|noatlas`.
- Preferences (mode, start, time, model, quality, sliders, map on/off) persist in `localStorage`.

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
| Map | M (heading-up moving map; hidden in the cinematic camera; the choice is remembered) |
| HUD / fullscreen | H / K |
| Pause | Esc or P (in fullscreen, Esc leaves fullscreen and pauses the flight; P resumes). The pause screen has the chart: scroll or + / − to zoom, drag to move, double-click or ◎ for the aircraft |
| Controls | I: pauses on the list of keys (the pause screen's Controls tab); I again flies on. In the menu it opens the controls sheet |
| Restart | Backspace |

Menu: Enter flies; Esc on the results card goes back to the menu.

## Modes and flight models
- Free flight: start on an airstrip, on the water, or in the air. The airstrip is picked at
  random, never the same twice in a row (Restart keeps it), and the aircraft lines up at the end of the
  runway for the clear departure most into the wind, gear down and flaps at 15°.
- The spot on the water is random too (`src/world/waterStart.ts`), gear up and flaps at 15°. First a
  water: the coast and its islands, or a fjord, arm or lake, never the same as last time, more likely
  the bigger it is but not in proportion (the square root of its area: the coast about one start in
  five, each long fjord one in ten, each arm one in twenty to forty). Then spots in it until one is at
  least 5 m deep with a clear take-off at most 70° off the wind: 1 km of open water ahead (lift-off
  takes 70–290 m), then a straight climb-out at 8 % clearing land by 25 m for 2.5 km. The lakes almost
  never pass (mountains all round). The sea also has to be calm enough there (`MAX_SEA`): the open
  coast's waves are rougher than the fjords', and scripted take-offs there start failing from about
  8 m/s of wind, so in a strong wind the start stays in the sheltered fjords. Restart keeps the spot.
  Picking one takes about 2.5 ms (at most about 30).
- The spot in the air is random too (`src/world/airStart.ts`): 87 kt through the air (moving with the
  wind, so a tailwind never starts it slow), 62 % power, gear down and flaps up. A spot anywhere over
  the map, at least 6 km from the last one; of the headings every 15°, one of those whose way over the
  ground for 4 km (±300 m, drifting with the wind) is lowest, so most starts fly down a valley or a
  fjord (three in five are below the ridges around them), and facing the land rather than the open sea;
  a height 150–350 m above the highest ground on that way and within 400 m around, checked every 50 m
  along and 75 m across. Starts stay below 1300 m, under the clouds (base 1550 m): a spot among the
  highest mountains is dropped and another drawn. About a third start over the water. Restart keeps the
  spot. Picking one takes about 8 ms (at most about 40).
- Ring run: 14 gates down the fjord against the clock (par 4:26); a missed gate costs 5 s. Graded on time.
- Landing: a final approach to a random airstrip, never the same twice in a row (Restart keeps it), in
  along its landing direction (below) at 70 kt through the air, gear down and flaps at 15°. The start is
  on the HUD's 4° glide path to the strip's aim point, a sixth of the way along the runway and at least
  60 m in (Hestskar 70 m, Vika 150 m: that also clears the bank 200 m short of Vika's threshold by 10
  m), 4.2 km out, or nearer where the ground further out comes within 30 m plus 1 % of the distance of
  the path: Vatne from 3 km, Hjelle from 2.2 km (past a ridge 2.6 km out). Graded on sink rate,
  centreline, touchdown point (from the aim point), wings level and stopping on the strip. A crash or
  overrun is an F.
- Arcade: rate-command attitude, protected stall. Assisted: real aerodynamics with auto-trim, turn
  coordination, wing leveller and stall protection. Simulation: raw aerodynamics with no protections
  (propeller torque, P-factor and adverse yaw are left for the pilot).
- Units are aviation units: airspeed in knots, altitude in feet, vertical speed in feet per minute.
- Speed limits are indicated airspeed (what the airspeed indicator shows; at altitude the true airspeed
  is higher): the red line is 155 kt, and the airframe breaks up at 175 kt. Past the red line the HUD
  and the panel show OVERSPEED and a clacker sounds. Arcade and Assisted protect the speed: from about
  136 kt the nose comes up by itself and forward stick loses authority, and a dive steeper than 12°
  eases out once the stick is released (Assisted's auto-trim would otherwise hold it).

## Airstrips
| | where | elevation | runway | take-offs | landing | |
|---|---|---|---|---|---|---|
| Vika | the coast, south of the main fjord's mouth | 20 m | 900 m, paved | 045, 225 | 045, from 4.2 km | cabin |
| Hestskar | a shelf north of the main fjord | 798 m | 420 m, gravel | 060, 240 | 060, from 4.2 km | |
| Hjelle | a shelf between the northern fjord and its north-east arm | 449 m | 600 m, gravel | 277 (the ground rises east) | 097, from 2.2 km | cabin |
| Botn | the valley floor at the head of the main fjord | 80 m | 560 m, gravel | 262 | 082, from 4.2 km | one way: in from the fjord, out back over it (a mountain wall beyond); cabin |
| Vatne | lowland among the southern lakes | 95 m | 680 m, paved | 131, 311 | 131, from 3 km | cabin |

Each strip is landed on one way, along its heading: the other way, the final crosses hills (Vika,
Vatne) or rising ground (Hjelle, Botn); Hestskar's other way is untested.

Sites come from `node scripts/stripsearch.ts <region>`: flat over the whole pad, dry, and a clear
approach on at least one side (the autoland's: 3.5° to an aim point 120 m in, a corridor ±150 m wide,
30 m of margin, out to 4 km). Take-off directions are the ones whose climb-out clears the ground at a
9 % climb from lift-off (the aircraft manages about 14 %); every one is flown in the unit tests. No trees
grow on a strip, within 35 m of it or 250 m past its ends.

## How the terrain stays identical on CPU and GPU
- `src/world/noise.ts` and `terrain.ts` hold the TS function and its GLSL mirror side by side. The lattice
  hash is 32-bit integer math (bit-exact on both sides); constants come from `params.ts`.
- `src/world/clipmap.ts` is a geometry clipmap whose vertices sit on each level's lattice. Only the heights
  morph toward the coarser level near a level's edge. `drawnHeight()` reproduces the vertex shader and the
  triangle split, so collision and landing grading use the rendered surface. Lattice heights are baked into
  a float atlas when a level moves (the vertex shader only fetches); on the CPU they are memoised.
- The fjords are polylines in `params.ts`. The first three (the main system) are measured everywhere:
  the mountains rise along them. The others only change the terrain inside their `FJORD_BOX`, whose
  reach is conservative (widest wandering bottom, coves, gentlest wall, the smooth minimum), so skipping
  them outside it changes no height. In GLSL one `fjordDist(f, p)` walks the fjords' shared constant
  arrays: the shader's size does not grow with their number.
- Measured parity (Intel iGPU, fp32 vs fp64): function ≤ 5.4 mm worldwide; rasterised surface vs CPU
  ≤ 0.22 mm near the camera, ≤ 4.5 mm out to ±30 km.

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

## Map
- `src/render/worldMap.ts` bakes a 2048² map image of a 49 km square (24 m per texel) on the GPU, from the
  same `terrainHeight()` the world is drawn with: one pass writes heights (packed into RGBA8, so the LDR
  path works too), a second shades them (the terrain shader's biomes, hill shading lit from the
  north-west, sea by depth, a shoreline). 64 rows per frame, about 40 frames in all; the shader compiles
  off the frame (`KHR_parallel_shader_compile`); the image is read back asynchronously (no stall) into an
  `ImageBitmap`. The first map covers the fjords, the coast and every start point; when the aircraft
  comes within 6 km of an edge, a new one is baked around it.
- `src/ui/chart.ts` draws it (one view transform for the terrain, the strips, the gates and the
  aircraft), for two maps:
  - the HUD's moving map: heading-up, 4 km to the rim, top right. The next gate or the landing aim point
    beyond the rim shows as a caret on the rim.
  - the pause screen's chart (`src/ui/pauseMap.ts`): north up, opens on the aircraft 18 km across
    (3 to 48 km), with the strips by name, the ring-run gates by number, a 5 km grid, a scale bar and
    the track flown this session (`src/game/track.ts`: a point every 25 m, the last 100 km). Above it,
    the distance and bearing from the aircraft to the point under the cursor, or else to the next gate,
    the landing strip or the nearest strip. Beside the settings on wide screens, below them under 900 px.
    It shares that panel with the list of keys: Map and Controls tabs; P opens on the map, I on the keys.

## Verification (this machine: Intel Lunar Lake iGPU, Linux, headless Chromium through ANGLE/EGL)
- `npm test`: 106 tests pass. Coverage: for each flight model, takeoff, runway rest (< 1 mm drift),
  landings on all five strips and on the water, landings from each strip's final in the landing mode,
  take-offs in every listed direction from every strip, water takeoff, take-offs from random spots on
  the water and a minute's flight on from random spots in the air, both in random winds up to 15 m/s,
  drop tests (never below the drawn surface beyond tyre compression), stall and recovery, gear-down
  water crash, speed limits, restarts; plus 150 random water starts (deep, sheltered, a clear take-off
  into the wind, a different water each time) and their spread, 60 random air starts (150 m clear of the
  ground on the way ahead, drifting with the wind, and around, checked at full detail and twice as
  densely as the picker samples; below the clouds; 6 km apart), the landing finals (on the glide path, 2
  km out or more, well above the ground), grading, forest tiling, scaler behaviour, the map's view
  transform, readouts and track, and what the first map covers.
- Keyboard flight tests (real key events, from the coastal strip), all three models:
  - runway rest ≤ 0.16 mm drift in 10 s
  - keyboard takeoff (liftoff after 240–280 m at ~70 kt)
  - Simulation stall with the warning before the break, 15–22 m lost, then recovery;
    Arcade/Assisted protected
  - autoland, then rest after rollout
  - lowest contact point never more than the tyre compression (≤ 0.16 m) below the drawn surface
- Modes:
  - autopilot ring run 14/14 (B, 5:19.8)
  - a run 45 m wide of every gate is penalised (C)
  - autopilot landings on the mountain strip (A, 84) and on Hjelle from its short final (A, 81)
  - landing flown into the ground (F, gear collapsed)
  - a crash into the sea ends free flight
  - free flight from an airstrip: 12 starts from the menu cover all five strips, never the same twice
    in a row; each lines up on its wheels for its departure into the wind; Restart keeps the strip
  - free flight on the water: 8 starts from the menu at 8 different spots, never the same water twice in
    a row; each afloat at its spot, gear up, at rest, facing within 70° of the wind; Restart keeps the
    spot
  - free flight in the air: 8 starts from the menu, each at least 6 km from the one before, flying from
    its spot on its heading at least 140 m above the ground; Restart keeps the spot
  - landing: 10 starts from the menu, never the same strip twice in a row; each on final for its strip,
    2 km out or more, on the centreline and the glide path, gear down; Restart keeps the strip
- UI flow (menu → Enter → pause → slider → resume → results → menu, and I for the controls in the menu
  and in flight) at 1920×1080 and 390×844. The menu
  fits from 1366×768 up; on shorter screens the settings scroll and Fly stays in view.
- Fallbacks render with no console errors: `nowebgl2`, `nofloat`, `logdepth`, `nofloat,logdepth`.
- Map: sea and land in the image match the CPU terrain at 99.95% of 6,359 samples (the rest are
  shoreline texels); the HUD map's pixels agree with the terrain around the aircraft at headings 60°, 95°
  and 253° (100%). Baking adds at most about 1 ms of GPU time per frame (within the benchmark's noise)
  for about 40 frames; drawing the map adds 0.1–0.2 ms to the main thread. The pause chart opens on the
  aircraft, its readouts match the expected distance and bearing, scrolling zooms about the cursor (the
  point under it stays within 0.01 m), dragging follows the pointer to the pixel, and it sits beside the
  settings at 1600×900 and 1280×720 and below them at 860×900.
- Console: no errors, shader or GL errors, page errors or failed requests in any of the runs above.
- Frame cost at 1920×1080 (GPU time by timer query, steady 16.7 ms frame interval in every view),
  measured with the fjords and the five strips on 2026-10-20:

  | preset | GPU ms (7 views) | main thread ms |
  |---|---|---|
  | high | 9.1 – 16.4 | ≤ 6.0 |
  | medium | 6.2 – 9.6 | ≤ 4.7 |
  | low (renders at 0.75×) | 3.0 – 6.3 | ≤ 2.8 |

  The same session before them: 9.6 – 16.5 / 6.6 – 11.0 / 3.2 – 10.4 ms on the GPU, ≤ 6.2 / 4.1 / 3.8 ms
  on the main thread. This laptop iGPU varies a lot from run to run with its clocks and temperature
  (±1 ms on the main thread, more on the GPU), so read these as "no regression", not as a gain.
  Drawing the HUD map costs the main thread 0.1 – 0.2 ms (measured with it on and off).
- The terrain function: 1.78 µs per point on the CPU at 7 octaves (1.51 µs with the three fjords alone;
  evaluating every fjord everywhere would make it 4.5 µs), and the same on the GPU (1.9 vs 2.0 ms per
  131,000 points). The LDR fallback evaluates it per vertex and per water pixel, every frame, and with
  more water in view its GPU-synced frames went from about 38 to about 52 ms (medium, three views).

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
- There is one water level: the lakes are at sea level, like the fjords (which suits valleys near the
  coast; there are no mountain lakes).
- The map has 24 m texels and simplified biome colours (no detail finer than a texel). It is ready
  within about a second on a GPU; with software rendering (SwiftShader) it takes 20–90 s.
