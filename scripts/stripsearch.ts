// Finds candidate airstrip sites on the natural (un-flattened) terrain: flat over the whole pad, dry,
// in an elevation band, with a clear approach on at least one side (the autoland's: 3.5° to an aim
// point 120 m past the threshold, in a corridor ±150 m wide, 30 m of margin, out to 4 km), away from
// the other strips, and preferably within sight of water.
// usage: node scripts/stripsearch.ts north|east|south|mountain|coastal
import { terrainHeight } from '../src/world/terrain.ts';
import { STRIPS, headingDir } from '../src/world/params.ts';

interface Region { x0: number; x1: number; z0: number; z1: number; half: number; lo: number; hi: number }
const REGIONS: Record<string, Region> = {
  // inside the first map with room to spare (see mapCovers in src/render/worldMap.ts)
  north: { x0: -8000, x1: 27000, z0: -19000, z1: -8500, half: 300, lo: 8, hi: 160 },
  east: { x0: 19000, x1: 27500, z0: -9000, z1: 9000, half: 280, lo: 60, hi: 700 },
  south: { x0: -8000, x1: 27000, z0: 8500, z1: 18000, half: 340, lo: 8, hi: 160 },
  // narrower: the shores of the northern fjord, the valley at the head of the main fjord
  northfjord: { x0: -8000, x1: 27000, z0: -19000, z1: -11000, half: 300, lo: 8, hi: 450 },
  fjordhead: { x0: 21000, x1: 27500, z0: -7000, z1: 3000, half: 280, lo: 30, hi: 400 },
  mountain: { x0: 3000, x1: 22000, z0: -7000, z1: 7000, half: 255, lo: 600, hi: 1000 },
  coastal: { x0: -9000, x1: 6000, z0: -14000, z1: 14000, half: 520, lo: 5, hi: 40 },
};
const kind = process.argv[2] ?? 'north';
const R = REGIONS[kind];
const H = (x: number, z: number) => terrainHeight(x, z, 6, false);
const GS = Math.tan((3.5 * Math.PI) / 180);
const res: { x: number; z: number; hdg: number; range: number; mean: number; clr: number[]; water: number; score: number }[] = [];
for (let x = R.x0; x <= R.x1; x += 120) {
  for (let z = R.z0; z <= R.z1; z += 120) {
    if (STRIPS.some((s) => Math.hypot(s.center[0] - x, s.center[1] - z) < 6000)) continue;
    const hc = H(x, z);
    if (hc < R.lo - 40 || hc > R.hi + 40) continue;
    for (let hdg = 0; hdg < 180; hdg += 10) {
      const [dx, dz] = headingDir(hdg);
      const at = (a: number, b: number) => H(x + dx * a - dz * b, z + dz * a + dx * b);
      // the runway and its pad: flat and dry
      let mn = Infinity, mx = -Infinity, sum = 0, n = 0;
      for (let a = -R.half - 100; a <= R.half + 100; a += (R.half + 100) / 5) {
        for (const b of [-55, -25, 0, 25, 55]) {
          const h = at(a, b);
          mn = Math.min(mn, h);
          mx = Math.max(mx, h);
          sum += h;
          n++;
        }
        if (mx - mn > 60) break;
      }
      const mean = sum / n;
      if (mn < 3 || mx - mn > 60 || mean < R.lo || mean > R.hi) continue;
      // approaches (e = -1: landing along the heading; +1: the other way): worst intrusion into the corridor
      const clr = [-1, 1].map((e) => {
        let worst = 0;
        for (let a = 200; a <= 4000; a += 200) for (const b of [-150, -75, 0, 75, 150]) {
          worst = Math.max(worst, at(e * (R.half - 120 + a), b) + 30 - (mean + 2.5 + GS * a));
        }
        return worst;
      });
      // water within 1.5 km (sampled on a ring): a view, and a fjord to follow on the way in
      let water = 0;
      for (let k = 0; k < 16; k++) {
        const ang = (k / 16) * Math.PI * 2;
        if (H(x + Math.cos(ang) * 1500, z + Math.sin(ang) * 1500) < 0) water++;
      }
      const score = (mx - mn) + 2 * Math.min(...clr) + 0.5 * Math.max(...clr) - 3 * Math.min(water, 6);
      res.push({ x, z, hdg, range: mx - mn, mean, clr, water, score });
    }
  }
}
res.sort((a, b) => a.score - b.score);
const picked: typeof res = [];
for (const r of res) {
  if (picked.every((p) => Math.hypot(p.x - r.x, p.z - r.z) > 2500)) picked.push(r);
  if (picked.length >= 8) break;
}
for (const p of picked) {
  console.log(`x=${p.x} z=${p.z} hdg=${p.hdg} range=${p.range.toFixed(0)} m mean=${p.mean.toFixed(0)} m approaches +${p.clr.map((c) => c.toFixed(0)).join('/+')} m water ${p.water}/16 score=${p.score.toFixed(1)}`);
}
