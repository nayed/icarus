// Finds candidate airstrip sites on the natural (un-flattened) terrain.
// usage: node scripts/stripsearch.ts mountain|coastal
import { terrainHeight } from '../src/world/terrain.ts';
import { headingDir } from '../src/world/params.ts';

const kind = process.argv[2] ?? 'mountain';
const cfg = kind === 'mountain'
  ? { x0: 3000, x1: 22000, z0: -7000, z1: 7000, half: 255, target: 820, tol: 0.25 }
  : { x0: -9000, x1: 6000, z0: -14000, z1: 14000, half: 520, target: 12, tol: 1.0 };
const res: { x: number; z: number; hdg: number; range: number; mean: number; score: number }[] = [];
for (let x = cfg.x0; x <= cfg.x1; x += 150) for (let z = cfg.z0; z <= cfg.z1; z += 150) {
  const hc = terrainHeight(x, z, 6, false);
  if (Math.abs(hc - cfg.target) > (kind === 'mountain' ? 250 : 30)) continue;
  for (let hdg = 0; hdg < 180; hdg += 15) {
    const [dx, dz] = headingDir(hdg);
    let mn = Infinity, mx = -Infinity, sum = 0, n = 0;
    for (let a = -cfg.half; a <= cfg.half; a += cfg.half / 4) for (const b of [-50, 0, 50]) {
      const h = terrainHeight(x + dx * a - dz * b, z + dz * a + dx * b, 6, false);
      mn = Math.min(mn, h); mx = Math.max(mx, h); sum += h; n++;
    }
    const mean = sum / n;
    if (kind === 'coastal' && (mn < 1.5 || mx > 60)) continue;
    // Approach clearance: terrain 1.5 km beyond each end should be below the strip.
    let clr = 0;
    for (const s of [-1, 1]) for (let a = cfg.half + 300; a <= cfg.half + 1800; a += 300) {
      const h = terrainHeight(x + dx * a * s, z + dz * a * s, 5, false);
      clr = Math.max(clr, h - (cfg.target - 30 + 0.05 * (a - cfg.half)));
    }
    const score = (mx - mn) + cfg.tol * Math.abs(mean - cfg.target) + 0.5 * Math.max(clr, 0) * (s => s)(1);
    res.push({ x, z, hdg, range: mx - mn, mean, score });
  }
}
res.sort((a, b) => a.score - b.score);
const picked: typeof res = [];
for (const r of res) {
  if (picked.every((p) => Math.hypot(p.x - r.x, p.z - r.z) > 1500)) picked.push(r);
  if (picked.length >= 10) break;
}
for (const p of picked) console.log(`x=${p.x} z=${p.z} hdg=${p.hdg} range=${p.range.toFixed(0)} mean=${p.mean.toFixed(0)} score=${p.score.toFixed(0)}`);
