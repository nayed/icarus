// Aircraft screenshots: start points × cameras × times.
// usage: node scripts/planeshots.mjs [--times=golden,night] [--prefix=p] [--q=high] [--w=1280 --h=720] [--hud] [--plans=air-chase,runway-cockpit]
import { startServer, launch, waitFrames, shot, report } from './harness.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const times = (args.times ?? 'golden,dusk,night').split(',');
const TIMES = { dawn: 5.85, day: 12, golden: 16.55, dusk: 18.15, night: 22.6 };
const prefix = args.prefix ?? 'p';
const server = await startServer();
const { browser, page, problems } = await launch({ width: Number(args.w ?? 1280), height: Number(args.h ?? 720) });
await page.goto(`${server.url}?debug&noui${'hud' in args ? '' : '&nohud'}&q=${args.q ?? 'high'}&start=runway`);
await waitFrames(page, 3, 180000);
await page.evaluate(() => window.__icarus.setAutoScale(false));
const plans = [
  { name: 'runway-chase', start: 'runway', cam: 'chase', advance: 2, input: { throttle: 0 } },
  { name: 'runway-cockpit', start: 'runway', cam: 'cockpit', advance: 2, input: { throttle: 0 } },
  { name: 'air-chase', start: 'air', cam: 'chase', advance: 4, input: { throttle: 0.65, roll: 0.25 } },
  { name: 'air-cockpit', start: 'air', cam: 'cockpit', advance: 4, input: { throttle: 0.65 } },
  { name: 'air-cinematic', start: 'air', cam: 'cinematic', advance: 4, input: { throttle: 0.65 }, real: 1.5 },
  { name: 'water-chase', start: 'water', cam: 'chase', advance: 3, input: { throttle: 0.1 } },
];
const only = args.plans ? args.plans.split(',') : null;
for (const t of times) {
  for (const p of plans.filter((p) => !only || only.includes(p.name))) {
    await page.evaluate(([p, t]) => {
      const api = window.__icarus;
      api.setTime(t);
      api.flight.start(p.start);
      api.flight.input({ pitch: 0, roll: 0, yaw: 0, brake: 0, ...p.input });
      api.setCameraMode(p.cam);
      api.flight.advance(p.advance);
    }, [p, TIMES[t] ?? Number(t)]);
    await waitFrames(page, 30);
    if (p.real) await page.waitForTimeout(p.real * 1000);
    const st = await page.evaluate(() => window.__icarus.flight.state());
    console.log(p.name, t, `ias ${(st.ias * 1.944).toFixed(0)}kt alt ${st.altitude.toFixed(0)} crashed ${st.crashed} ${st.crashReason}`);
    await shot(page, `${prefix}-${p.name}-${t}`);
  }
}
const ok = report(problems);
await browser.close();
await server.close();
process.exit(ok ? 0 : 1);
