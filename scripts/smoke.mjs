// Smoke test for CI: boots the game in headless Chromium and fails on any console, shader or page
// error. Shaders only compile in a browser, so this catches what typecheck, unit tests and the build
// cannot. Runs the three pipeline variants (HDR with reversed-Z, no float render targets, logarithmic
// depth) through the menu, a flight in the chase and cockpit views, the ring run and the map.
// Software WebGL is enough: ICARUS_GPU=swiftshader. Against the build: npm run build, ICARUS_PROD=1.
// usage: node scripts/smoke.mjs
import { startServer, launch, waitFrames, report } from './harness.mjs';

const T = 300000; // software rendering compiles and draws slowly: generous timeouts
const server = await startServer();
let failures = 0;
const check = (c, m) => {
  console.log(`  ${c ? '✓' : '✗'} ${m}`);
  if (!c) failures++;
};
let ok = true;
for (const force of ['', 'nofloat', 'logdepth']) {
  const label = force || 'default';
  console.log(`== ${label}`);
  const t0 = Date.now();
  const { browser, page, problems } = await launch({ width: 960, height: 540 });
  try {
    await page.goto(`${server.url}?debug&q=low${force ? `&force=${force}` : ''}`);
    await page.waitForFunction(() => document.getElementById('boot')?.classList.contains('gone'), null, { timeout: T });
    const state = () => page.evaluate(() => window.__icarus.session.state());
    if (!force) console.log(`  renderer: ${await page.evaluate(() => window.app.world.caps.renderer)}`);
    check((await state()) === 'menu', 'boots into the menu');
    await page.keyboard.press('Enter');
    await waitFrames(page, 10, T);
    check((await state()) === 'flying', 'Enter starts a flight');
    await page.keyboard.press('Digit2');
    await waitFrames(page, 10, T);
    check(await page.evaluate(() => window.app.rig.mode === 'cockpit'), 'cockpit view renders');
    await page.evaluate(() => window.__icarus.session.start('rings', 'air'));
    await waitFrames(page, 10, T);
    check(await page.evaluate(() => window.__icarus.session.hud()?.title === 'Ring run'), 'ring run renders');
    check(await page.evaluate(() => !!window.app.hud.mapBox), 'minimap drawn');
    // the map image is baked in the background, a slice per frame. Its passes are the same in every
    // pipeline (8-bit targets, no depth), and in software rendering the slower ones take minutes to
    // finish it: wait for it in the default pipeline only
    if (!force) {
      await page.waitForFunction(() => window.__icarus.map.ready(), null, { timeout: T, polling: 500 });
      const map = await page.evaluate(() => window.__icarus.map.check(40));
      check(map.agree > 0.99, `map baked, sea and land match the terrain (${(map.agree * 100).toFixed(1)}%)`);
    }
  } catch (e) {
    check(false, `${label}: ${e.message.split('\n')[0]}`);
  }
  ok = report(problems, label) && ok;
  console.log(`  (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  await browser.close();
}
await server.close();
ok = ok && failures === 0;
console.log(ok ? 'SMOKE OK' : 'SMOKE FAILED');
process.exit(ok ? 0 : 1);
