// Per-pass GPU timings (ms) for a preset and viewpoint.
import { startServer, launch, waitFrames, report } from './harness.mjs';
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const server = await startServer();
const { browser, page, problems } = await launch({ width: Number(args.w ?? 1920), height: Number(args.h ?? 1080) });
for (const q of (args.q ?? 'high,medium,low').split(',')) {
  await page.goto(`${server.url}?debug&q=${q}&t=${args.t ?? 'golden'}&cam=${args.cam ?? '-1500,120,1900,80,-2'}${args.extra ? '&' + args.extra : ''}`);
  await waitFrames(page, 3, 180000);
  await page.evaluate(() => window.__icarus.setAutoScale(false));
  const p = await page.evaluate(() => window.__icarus.profile(30));
  const total = Object.values(p).reduce((a, b) => a + b, 0);
  console.log(q.padEnd(7), Object.entries(p).map(([k, v]) => `${k} ${v}`).join('  '), ` | total ${total.toFixed(1)} ms`);
}
report(problems);
await browser.close();
await server.close();
