// CPU ↔ GPU terrain parity:
//  1. GLSL terrainHeight()/clipVertexHeight() vs the TS functions at random points;
//  2. the real clipmap meshes rasterised from above vs drawnHeight() for every pixel,
//     near the camera (level transitions) and over the whole clipmap.
import { startServer, launch, waitFrames, report } from './harness.mjs';

const server = await startServer();
const { browser, page, problems } = await launch({ width: 640, height: 360 });
let failed = false;
for (const q of (process.argv[2] ?? 'high,low').split(',')) {
  await page.goto(`${server.url}?debug&noui&nohud&q=${q}&cam=3210.37,412.6,1987.21,70,-5`);
  await waitFrames(page, 3, 180000);
  await page.evaluate(() => { window.__icarus.setAutoScale(false); window.__icarus.setPaused(true); });
  const res = await page.evaluate(() => {
    const api = window.__icarus;
    const pts = [];
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
    for (let i = 0; i < 4096; i++) pts.push(-20000 + rnd() * 50000, -20000 + rnd() * 40000);
    // lattice points of level 0 / 3 for vertex-height parity near the camera
    const lattice = (s) => { const p = []; for (let i = 0; i < 2048; i++) p.push(Math.round((3210 + (rnd() - 0.5) * 400 * s) / s) * s, Math.round((1987 + (rnd() - 0.5) * 400 * s) / s) * s); return p; };
    return {
      fn: api.gpuTerrain(pts, 1),
      v1: api.gpuTerrain(lattice(1), 1),
      v8: api.gpuTerrain(lattice(8), 8),
      nearMorph: api.rasterParity(3210.37, 1987.21, 300, 600),
      mid: api.rasterParity(3210.37, 1987.21, 3000, 600),
      far: api.rasterParity(3210.37, 1987.21, 60000, 600),
    };
  });
  console.log(`[${q}] terrainHeight GPU vs CPU: max |Δ| = ${res.fn.maxFunctionErr.toExponential(2)} m`);
  console.log(`[${q}] clipVertexHeight s=1: max |Δ| = ${res.v1.maxVertexErr.toExponential(2)} m; s=8: ${res.v8.maxVertexErr.toExponential(2)} m`);
  for (const k of ['nearMorph', 'mid', 'far']) {
    const r = res[k];
    console.log(`[${q}] raster ${k}: ${r.count} px, max |Δ| = ${r.maxErr.toExponential(2)} m, mean ${r.meanErr.toExponential(2)} m, worst at ${r.worst.map((v) => v.toFixed(2)).join(', ')}`);
  }
  const tol = { fn: 0.02, raster: 0.05 };
  if (res.fn.maxFunctionErr > tol.fn || res.v1.maxVertexErr > tol.fn || res.v8.maxVertexErr > tol.fn) failed = true;
  if (['nearMorph', 'mid'].some((k) => res[k].maxErr > tol.raster)) failed = true;
}
const ok = report(problems) && !failed;
console.log(ok ? 'PARITY OK' : 'PARITY FAILED');
await browser.close();
await server.close();
process.exit(ok ? 0 : 1);
