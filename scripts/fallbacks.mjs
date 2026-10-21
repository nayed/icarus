// Fallback paths: no WebGL2 (explanation panel), no float render targets (LDR pipeline),
// logarithmic depth instead of reversed-Z. Each must run without console errors.
import { startServer, launch, waitFrames, shot, report } from './harness.mjs';
const server = await startServer();
let failures = 0;
const check = (c, m) => { console.log(`  ${c ? '✓' : '✗'} ${m}`); if (!c) failures++; };
const all = [];
for (const force of ['nowebgl2', 'nofloat', 'logdepth', 'nofloat,logdepth']) {
  const { browser, page, problems } = await launch({ width: 1280, height: 720 });
  all.push([force, problems]);
  await page.goto(`${server.url}?debug&force=${force}&q=medium&t=golden`);
  if (force === 'nowebgl2') {
    await page.waitForSelector('.fatal', { timeout: 30000 });
    const text = await page.textContent('.fatal');
    check(/WebGL ?2/i.test(text), `${force}: explanation panel shown ("${text.slice(0, 60).trim()}…")`);
    await shot(page, `fb-${force}`);
  } else {
    await waitFrames(page, 3, 180000);
    await page.waitForFunction(() => document.getElementById('boot').classList.contains('gone'), null, { timeout: 60000 });
    const info = await page.evaluate(() => window.__icarus.info());
    console.log(`  ${force}: hdr ${info.hdr}, reversedZ ${info.reversedZ}, logDepth ${info.logDepth}, ${info.calls} draw calls`);
    await page.evaluate(() => { window.__icarus.setAutoScale(false); window.__icarus.session.start('free', 'air', undefined, 'home'); window.__icarus.setCameraMode('chase'); });
    await waitFrames(page, 60);
    const st = await page.evaluate(() => window.__icarus.flight.state());
    check(!st.crashed, `${force}: flying (alt ${st.altitude.toFixed(0)} m)`);
    await shot(page, `fb-${force.replace(',', '+')}`);
    // a frame with pixels that are not all black: the pipeline is drawing something
    const lum = await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => {
      // runs right after the app's own frame callback, while the drawing buffer is still intact
      const c = document.getElementById('scene');
      const g = document.createElement('canvas');
      g.width = 64; g.height = 36;
      const x = g.getContext('2d');
      x.drawImage(c, 0, 0, 64, 36);
      const d = x.getImageData(0, 0, 64, 36).data;
      let s = 0;
      for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2];
      resolve(s / (64 * 36 * 3));
    })));
    check(lum > 20, `${force}: image mean ${lum.toFixed(1)}/255`);
  }
  await browser.close();
}
let ok = failures === 0;
for (const [f, p] of all) ok = report(p, f) && ok;
console.log(ok ? 'FALLBACKS OK' : 'FALLBACKS FAILED');
await server.close();
process.exit(ok ? 0 : 1);
