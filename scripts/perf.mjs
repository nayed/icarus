// Frame cost per quality preset at a few viewpoints, measured in the normal frame loop: GPU time
// from timer queries (EXT_disjoint_timer_query_webgl2), main-thread time, and the frame interval.
// Real GPU via ANGLE/EGL by default. usage: node scripts/perf.mjs [--q=high,medium,low] [--w=1920 --h=1080]
import { startServer, launch, waitFrames, report } from './harness.mjs';
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const w = Number(args.w ?? 1920), h = Number(args.h ?? 1080);
const VIEWS = [
  ['fjord', { cam: [-1500, 120, 1900, 80, -2] }],
  ['overview', { cam: [-12000, 3200, 7000, 62, -13] }],
  ['valley', { cam: [6500, 180, 2300, 60, -1] }],
  ['air-chase', { start: 'air', mode: 'chase' }],
  ['air-cockpit', { start: 'air', mode: 'cockpit' }],
  ['runway-chase', { start: 'runway', mode: 'chase' }],
  ['water-chase', { start: 'water', mode: 'chase' }],
];
const server = await startServer();
const { browser, page, problems } = await launch({ width: w, height: h });
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const p95 = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.95)];
let gpuAvailable = true;
for (const q of (args.q ?? 'high,medium,low').split(',')) {
  await page.goto(`${server.url}?debug&noui&q=${q}&t=${args.t ?? 'golden'}`);
  await waitFrames(page, 3, 180000);
  // the map image bakes in the background over the first frames: measure after it
  await page.waitForFunction(() => window.__icarus.map.ready(), null, { timeout: 120000 });
  await page.evaluate(() => window.__icarus.setAutoScale(false));
  for (const [name, v] of VIEWS) {
    await page.evaluate((v) => {
      const api = window.__icarus;
      if (v.cam) api.setCamera(...v.cam);
      else {
        api.session.start('free', v.start, undefined, v.start === 'water' ? { x: 2600, z: 2350, heading: 95 } : 'coastal');
        api.flight.input({ throttle: v.start === 'air' ? 0.65 : 0.05, pitch: 0, roll: 0, yaw: 0, brake: 0 });
        api.setCameraMode(v.mode);
      }
    }, v);
    await waitFrames(page, 30);
    const s = await page.evaluate(() => new Promise((resolve) => {
      const gpu = [], cpu = [], dt = [];
      const t = window.app.world.gpuTimer;
      let lastGpu = t.lastMs, prev = performance.now();
      const tick = (now) => {
        dt.push(now - prev);
        prev = now;
        cpu.push(window.app.cpuMs);
        if (t.lastMs !== lastGpu) { gpu.push(t.lastMs); lastGpu = t.lastMs; }
        if (dt.length < 150) requestAnimationFrame(tick);
        else resolve({ gpu, cpu, dt: dt.slice(1), info: window.__icarus.info() });
      };
      requestAnimationFrame(tick);
    }));
    if (!s.gpu.length) gpuAvailable = false;
    const g = s.gpu.length ? `gpu ${median(s.gpu).toFixed(2)} ms (p95 ${p95(s.gpu).toFixed(2)})` : 'gpu n/a';
    console.log(`${q.padEnd(6)} ${name.padEnd(13)} ${g}  cpu ${median(s.cpu).toFixed(2)} ms  interval ${median(s.dt).toFixed(1)} ms  calls ${s.info.calls}  tris ${(s.info.triangles / 1e6).toFixed(2)}M  ${s.info.size.join('x')}`);
  }
}
if (!gpuAvailable) console.log('(GPU timer queries unavailable in this browser: no GPU times)');
const ok = report(problems);
await browser.close();
await server.close();
process.exit(ok ? 0 : 1);
