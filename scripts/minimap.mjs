// Moving map checks: the map image bakes and matches the CPU terrain; the HUD draws it heading-up
// (HUD pixels compared with the terrain around the aircraft); M toggles it and the choice survives a
// reload; the cinematic camera hides it; a new map is baked when the aircraft nears the edge; the
// phone layout keeps it clear of the heading tape. Prints the bake's cost per frame.
// Screenshots in shots/minimap-*.png.
// usage: node scripts/minimap.mjs
import { startServer, launch, waitFrames, shot, report } from './harness.mjs';

const server = await startServer();
let failures = 0;
const check = (c, m) => {
  console.log(`  ${c ? '✓' : '✗'} ${m}`);
  if (!c) failures++;
};
const all = [];

/** Compares the drawn minimap with the terrain: samples at 1.2 and 2.8 km in 24 directions. */
async function headingUpCheck(page) {
  return page.evaluate(() => {
    const app = window.app;
    const box = app.hud.mapBox;
    if (!box) return null;
    const r = (box.x1 - box.x0) / 2;
    const cx = box.x0 + r;
    const cy = box.y0 + r;
    const k = r / 4000;
    const hdg = (app.telemetry.heading * Math.PI) / 180;
    const p = app.drawPos;
    const ctx = document.getElementById('hud').getContext('2d');
    const dpr = document.getElementById('hud').width / app.hud.canvas.clientWidth;
    let tested = 0, agree = 0, sea = 0, land = 0;
    for (const d of [1200, 2800]) {
      for (let a = 0; a < 24; a++) {
        // a point `d` metres away at screen angle `a` (0 = straight up = the heading)
        const sa = (a / 24) * Math.PI * 2;
        const b = hdg + sa;
        const x = p.x + Math.sin(b) * d;
        const z = p.z - Math.cos(b) * d;
        const h = window.__icarus.terrainHeight(x, z, 7);
        if (Math.abs(h) < 40) continue;
        const sx = cx + Math.sin(sa) * d * k;
        const sy = cy - Math.cos(sa) * d * k;
        const px = ctx.getImageData(Math.round(sx * dpr), Math.round(sy * dpr), 1, 1).data;
        const isSea = px[2] > px[0] + 10 && px[0] < 50;
        tested++;
        if (isSea === h < 0) agree++;
        if (h < 0) sea++;
        else land++;
      }
    }
    return { tested, agree: agree / Math.max(1, tested), sea, land };
  });
}

// ---------------------------------------------------------------- desktop
{
  const { browser, page, problems } = await launch({ width: 1600, height: 900 });
  all.push(problems);
  const ev = (f, a) => page.evaluate(f, a);
  await page.goto(`${server.url}?debug&q=medium`);
  await waitFrames(page, 3, 180000);
  await ev(() => localStorage.clear());
  await page.waitForFunction(() => window.__icarus.map.ready(), null, { timeout: 120000 });
  const info = await ev(() => window.__icarus.map.info());
  check(info.bakes === 1 && info.phase === 'idle', `map baked: ${info.extent / 1000} km square, west edge ${info.x0} m, north edge ${info.z0} m`);
  const c = await ev(() => window.__icarus.map.check(80));
  check(c.agree > 0.995, `sea and land match the CPU terrain at ${(c.agree * 100).toFixed(2)}% of ${c.tested} samples`);

  // cost of a bake per frame (synchronous frames with a GPU sync after each)
  const bench = await ev(() => {
    const api = window.__icarus;
    api.setAutoScale(false);
    const idle = api.benchmark(40).avg;
    api.map.rebake(9000, -500);
    const baking = api.benchmark(24).avg;
    const phase = api.map.info().phase;
    return { idle, baking, phase };
  });
  check(bench.phase === 'heights', `bake cost: ${bench.idle.toFixed(2)} ms per frame idle, ${bench.baking.toFixed(2)} ms while baking heights (rows per frame: ${info.rowsPerFrame})`);
  await page.waitForFunction(() => window.__icarus.map.info().bakes === 2, null, { timeout: 60000 });

  // heading-up in the landing approach (fjord, mountains, coastal strip in range)
  await ev(() => {
    const api = window.__icarus;
    api.setTime(15.5);
    api.session.start('landing');
    api.setCameraMode('chase');
    api.setFixedDt(1 / 60);
  });
  await waitFrames(page, 40);
  await ev(() => window.__icarus.setPaused(true));
  const hu = await headingUpCheck(page);
  check(!!hu && hu.agree > 0.9 && hu.sea >= 5 && hu.land >= 5, `drawn heading-up: ${hu ? `${(hu.agree * 100).toFixed(0)}% of ${hu.tested} map pixels agree with the terrain (${hu.sea} sea, ${hu.land} land)` : 'no map'}`);
  await shot(page, 'minimap-landing');
  await ev(() => window.__icarus.setPaused(false));

  // after a turn the map has turned with it
  await ev(() => {
    const api = window.__icarus;
    api.session.start('free', 'water');
    api.flight.input({ throttle: 0 });
  });
  await waitFrames(page, 30);
  await ev(() => window.__icarus.setPaused(true));
  const hu2 = await headingUpCheck(page);
  check(!!hu2 && hu2.agree > 0.9 && hu2.sea >= 5 && hu2.land >= 5, `on the water, heading ${Math.round(await ev(() => window.app.telemetry.heading))}°: ${hu2 ? `${(hu2.agree * 100).toFixed(0)}% of ${hu2.tested} agree` : 'no map'}`);
  await ev(() => window.__icarus.setPaused(false));
  // and flying back west down the fjord
  await ev(() => {
    window.app.ac.reset(6400, 260, 2300, 250, 48);
    window.app.startFlightAt();
  });
  await waitFrames(page, 30);
  await ev(() => window.__icarus.setPaused(true));
  const hu3 = await headingUpCheck(page);
  check(!!hu3 && hu3.agree > 0.9 && hu3.sea >= 5 && hu3.land >= 5, `heading ${Math.round(await ev(() => window.app.telemetry.heading))}°: ${hu3 ? `${(hu3.agree * 100).toFixed(0)}% of ${hu3.tested} agree (${hu3.sea} sea, ${hu3.land} land)` : 'no map'}`);
  await shot(page, 'minimap-west');
  await ev(() => window.__icarus.setPaused(false));

  // ring run: the course and the next gate
  await ev(() => {
    const api = window.__icarus;
    api.setTime(16.2);
    api.session.start('rings', 'air');
    api.session.autoRings(0);
    api.setFixedDt(1 / 12);
  });
  await page.waitForFunction(() => window.__icarus.session.hud()?.timerSub?.startsWith('Gate 3'), null, { timeout: 120000 });
  await ev(() => window.__icarus.setFixedDt(1 / 60));
  await waitFrames(page, 20);
  await shot(page, 'minimap-rings');

  // M hides and shows it (real key presses), the cinematic camera hides it
  const drawn = () => ev(() => !!window.app.hud.mapBox);
  check(await drawn(), 'drawn in the chase view');
  await page.keyboard.press('KeyM');
  await waitFrames(page, 3);
  const off = await ev(() => ({ on: window.app.mapVisible, saved: JSON.parse(localStorage.getItem('icarus.prefs.v1') || '{}').minimap }));
  check(!off.on && off.saved === false && !(await drawn()), 'M hides it, and the choice is saved');
  await page.keyboard.press('KeyM');
  await waitFrames(page, 3);
  check((await drawn()) && (await ev(() => window.app.mapVisible)), 'M shows it again');
  await page.keyboard.press('Digit3');
  await waitFrames(page, 3);
  check(!(await drawn()), 'hidden in the cinematic camera');
  await page.keyboard.press('Digit2');
  await waitFrames(page, 20);
  check(await drawn(), 'drawn in the cockpit');
  await shot(page, 'minimap-cockpit');

  // off survives a reload
  await page.keyboard.press('KeyM');
  await waitFrames(page, 3);
  await page.reload();
  await waitFrames(page, 3, 180000);
  check((await ev(() => window.app.mapVisible)) === false, 'still off after a reload');
  await ev(() => {
    window.__icarus.session.start('free', 'air');
    window.app.mapVisible = true;
  });

  // flying off the map: a new map is baked around the aircraft
  await page.waitForFunction(() => window.__icarus.map.ready(), null, { timeout: 120000 });
  const before = await ev(() => window.__icarus.map.info());
  await ev(() => window.app.ac.pos.set(30500, 2200, -4000));
  await page.waitForFunction((n) => window.__icarus.map.info().bakes > n, before.bakes, { timeout: 60000 });
  const after = await ev(() => window.__icarus.map.info());
  const ap = await ev(() => ({ x: window.app.ac.pos.x, z: window.app.ac.pos.z }));
  check(after.x0 > before.x0 && ap.x > after.x0 + 6000 && ap.x < after.x0 + after.extent - 6000, `near the east edge a new map is baked around the aircraft (west edge ${before.x0} → ${after.x0} m)`);
  await waitFrames(page, 5);
  await ev(() => window.__icarus.setTime(22.6));
  await waitFrames(page, 30);
  await shot(page, 'minimap-night');
  await browser.close();
}

// ---------------------------------------------------------------- phone
{
  const { browser, page, problems } = await launch({ width: 390, height: 844 });
  all.push(problems);
  const ev = (f, a) => page.evaluate(f, a);
  await page.goto(`${server.url}?debug&q=low&mode=free&start=air`);
  await waitFrames(page, 3, 180000);
  await page.waitForFunction(() => window.__icarus.map.ready(), null, { timeout: 120000 });
  await waitFrames(page, 20);
  const box = await ev(() => window.app.hud.mapBox);
  // the heading tape is centred and min(42% of the width, 420) wide
  const tapeRight = 390 / 2 + Math.min(390 * 0.42, 420) / 2;
  check(!!box && box.x1 <= 390 && box.x0 >= tapeRight, `phone: ${box ? `${box.x1 - box.x0} px map clear of the heading tape (${box.x0.toFixed(0)} ≥ ${tapeRight.toFixed(0)})` : 'no map'}`);
  await shot(page, 'minimap-phone');
  await browser.close();
}

const ok = all.every((p) => report(p)) && failures === 0;
console.log(ok ? 'MINIMAP OK' : `MINIMAP FAILED (${failures})`);
await server.close();
process.exit(ok ? 0 : 1);
