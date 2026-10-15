// Screenshot matrix: cameras × times of day. Reports console problems.
// usage: node scripts/shots.mjs [--q=high] [--cams=a,b] [--times=dusk,night] [--w=1280 --h=720] [--prefix=s1]
import { startServer, launch, waitFrames, shot, report } from './harness.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const CAMS = {
  fjord: [-1500, 120, 1900, 80, -2],
  fjordmid: [7000, 260, 2300, 55, -4],
  overview: [-12000, 3200, 7000, 62, -13],
  coast: [-5200, 380, 9000, 350, -3],
  topdown: [5000, 26000, 1500, 0, -89.9],
  mstrip: [4700, 1000, 1350, 40, -9],
  cstrip: [-300, 70, 7300, 32, -4],
  ground: [400, 24, 6500, 45, 2],
};
const TIMES = { dawn: 5.85, day: 12, golden: 16.55, dusk: 18.15, night: 22.6 };
const cams = (args.cams ?? Object.keys(CAMS).join(',')).split(',');
const times = (args.times ?? Object.keys(TIMES).join(',')).split(',');
const w = Number(args.w ?? 1280), h = Number(args.h ?? 720);
const prefix = args.prefix ?? 'shot';

const server = await startServer();
const { browser, page, problems } = await launch({ width: w, height: h });
const extra = args.extra ? '&' + args.extra : '';
await page.goto(`${server.url}?debug&q=${args.q ?? 'high'}${extra}`);
await waitFrames(page, 3, 180000);
await page.evaluate(() => window.__icarus.setAutoScale(false));
console.log('info', JSON.stringify(await page.evaluate(() => window.__icarus.info())));
for (const t of times) {
  for (const c of cams) {
    const cam = CAMS[c];
    await page.evaluate(([cam, t]) => { window.__icarus.setTime(t); window.__icarus.setCamera(...cam); }, [cam, TIMES[t] ?? Number(t)]);
    await waitFrames(page, Number(args.settle ?? 24));
    const f = await shot(page, `${prefix}-${c}-${t}`);
    console.log('saved', f);
  }
}
const ok = report(problems);
await browser.close();
await server.close();
process.exit(ok ? 0 : 1);
