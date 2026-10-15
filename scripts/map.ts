// Top-down shaded relief map of the CPU terrain, for layout work.
// usage: node scripts/map.ts [x0 z0 size px oct] → shots/map.png
import { writeFileSync, mkdirSync } from 'node:fs';
import { terrainHeight } from '../src/world/terrain.ts';
import { FJORDS, STRIPS } from '../src/world/params.ts';
// @ts-ignore plain JS helper
import { encodePNG } from './lib/png.mjs';

const [x0, z0, size, px, oct] = (process.argv.slice(2).length ? process.argv.slice(2) : ['-14000', '-20000', '42000', '900', '7']).map(Number);
const step = size / px;
const H = new Float32Array(px * px);
const t0 = performance.now();
for (let j = 0; j < px; j++) for (let i = 0; i < px; i++) H[j * px + i] = terrainHeight(x0 + (i + 0.5) * step, z0 + (j + 0.5) * step, oct, !process.env.NOSTRIPS);
const ms = performance.now() - t0;
let lo = Infinity, hi = -Infinity;
for (const h of H) { lo = Math.min(lo, h); hi = Math.max(hi, h); }
const rgb = new Uint8Array(px * px * 3);
const ramp = [
  [-250, [10, 25, 45]], [-1, [40, 80, 110]], [0, [205, 200, 170]], [40, [90, 120, 70]], [300, [60, 90, 55]],
  [550, [120, 115, 95]], [850, [150, 145, 140]], [1100, [235, 238, 245]], [2000, [255, 255, 255]],
];
function col(h) {
  for (let k = 1; k < ramp.length; k++) if (h <= ramp[k][0]) {
    const [h0, c0] = ramp[k - 1], [h1, c1] = ramp[k];
    const t = Math.max(0, Math.min(1, (h - h0) / (h1 - h0)));
    return c0.map((c, n) => c + (c1[n] - c) * t);
  }
  return ramp.at(-1)[1];
}
for (let j = 0; j < px; j++) for (let i = 0; i < px; i++) {
  const h = H[j * px + i];
  const hx = H[j * px + Math.min(i + 1, px - 1)] - H[j * px + Math.max(i - 1, 0)];
  const hz = H[Math.min(j + 1, px - 1) * px + i] - H[Math.max(j - 1, 0) * px + i];
  const nx = -hx / (2 * step), nz = -hz / (2 * step);
  const inv = 1 / Math.hypot(nx, 1, nz);
  const shade = h < 0 ? 1 : Math.max(0.25, (nx * -0.6 + 1 * 0.6 + nz * -0.5) * inv + 0.25);
  const c = col(h);
  for (let n = 0; n < 3; n++) rgb[(j * px + i) * 3 + n] = Math.max(0, Math.min(255, c[n] * shade));
}
function dot(x, z, c, r = 2) {
  const i = Math.round((x - x0) / step), j = Math.round((z - z0) / step);
  for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) {
    const ii = i + a, jj = j + b;
    if (ii >= 0 && jj >= 0 && ii < px && jj < px) rgb.set(c, (jj * px + ii) * 3);
  }
}
for (const f of FJORDS) for (const [x, z] of f.points) dot(x, z, [255, 60, 60], 1);
for (const s of STRIPS) dot(s.center[0], s.center[1], [255, 170, 40], 4);
// 5 km grid ticks
for (let gx = Math.ceil(x0 / 5000) * 5000; gx < x0 + size; gx += 5000)
  for (let gz = Math.ceil(z0 / 5000) * 5000; gz < z0 + size; gz += 5000) dot(gx, gz, [255, 255, 255], 0);
mkdirSync('shots', { recursive: true });
writeFileSync(process.argv[7] ?? 'shots/map.png', encodePNG(px, px, rgb));
console.log(`map ${px}x${px} in ${ms.toFixed(0)} ms (${(ms * 1000 / (px * px)).toFixed(2)} µs/sample), h ∈ [${lo.toFixed(0)}, ${hi.toFixed(0)}]`);
for (const s of STRIPS) console.log(s.id, 'h at centre', terrainHeight(s.center[0], s.center[1]).toFixed(3));
// Extra markers: MARK="x,z;x,z"
for (const m of (process.env.MARK ?? '').split(';').filter(Boolean)) { const [x, z] = m.split(',').map(Number); dot(x, z, [255, 0, 255], 3); }
writeFileSync(process.argv[7] ?? 'shots/map.png', encodePNG(px, px, rgb));
