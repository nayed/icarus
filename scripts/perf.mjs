// GPU cost per frame for each quality preset at a few viewpoints (real GPU via ANGLE/EGL by default).
import { startServer, launch, waitFrames, report } from './harness.mjs';
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const w = Number(args.w ?? 1920), h = Number(args.h ?? 1080);
const VIEWS = {
  fjord: [-1500, 120, 1900, 80, -2],
  high: [-12000, 3200, 7000, 62, -13],
  low: [6500, 180, 2300, 60, -1],
};
const server = await startServer();
const { browser, page, problems } = await launch({ width: w, height: h });
for (const q of (args.q ?? 'high,medium,low').split(',')) {
  await page.goto(`${server.url}?debug&q=${q}&t=${args.t ?? 'golden'}`);
  await waitFrames(page, 3, 180000);
  await page.evaluate(() => window.__icarus.setAutoScale(false));
  for (const [name, cam] of Object.entries(VIEWS)) {
    const r = await page.evaluate((cam) => { window.__icarus.setCamera(...cam); return window.__icarus.benchmark(90, 60); }, cam);
    console.log(`${q.padEnd(6)} ${name.padEnd(6)} avg ${r.avg.toFixed(2)} ms  p50 ${r.p50.toFixed(2)}  p95 ${r.p95.toFixed(2)}  calls ${r.calls}  tris ${r.triangles}  ${r.size.join('x')}`);
  }
}
report(problems);
await browser.close();
await server.close();
