# Icarus — notes

Procedural fjord flight simulator (Three.js + TypeScript + Vite). No external models, textures or audio.

## Run
- `npm install` then `npm run dev` (http://localhost:5173), `npm run build` / `npm run preview`.
- Tests: `npm test` (vitest, pure TS), Playwright scripts in `scripts/` (`node scripts/<name>.mjs`).
  Headless Chromium uses the real GPU through ANGLE/EGL by default; `ICARUS_GPU=swiftshader` forces software.

## Status
Work in progress — see stages in the commit history.
