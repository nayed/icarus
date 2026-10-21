// Regenerates the README screenshots in docs/screenshots/ (1600×900 JPEG, High preset, real GPU).
// usage: node scripts/readme-shots.mjs
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { startServer, launch, waitFrames, report, ROOT } from './harness.mjs';

const OUT = path.join(ROOT, 'docs', 'screenshots');
const W = 1600;
const H = 900;
await mkdir(OUT, { recursive: true });
const server = await startServer();
const { browser, page, problems } = await launch({ width: W, height: H });
const ev = (f, a) => page.evaluate(f, a);
const save = async (name) => {
  // hold the frame while it is captured: a capture can take several frames, and the camera moves on
  // (the hero's mouse-look swing eases back after 1.5 s)
  await ev(() => window.__icarus.setPaused(true));
  await page.screenshot({ path: path.join(OUT, `${name}.jpg`), type: 'jpeg', quality: 85 });
  await ev(() => window.__icarus.setPaused(false));
  console.log('saved', name);
};
/** Free flight from a start point, camera mode, HUD on/off, simulated ahead by `advance` seconds. */
const fly = (t, start, cam, hud, advance) =>
  ev(([t, start, cam, hud, advance]) => {
    const api = window.__icarus;
    api.setTime(t);
    api.session.start('free', start, undefined, 'home');
    api.flight.input({ throttle: start === 'air' ? 0.65 : 0, pitch: 0, roll: 0, yaw: 0 });
    api.setCameraMode(cam);
    const rig = window.app.rig;
    rig.lookYaw = 0; // look() offsets persist across sessions: start every shot from behind
    rig.lookPitch = 0;
    rig.lookHold = 0;
    window.app.hudVisible = hud;
    api.flight.advance(advance);
  }, [t, start, cam, hud, advance]);
/** Orbit the chase camera (mouse-look deltas in pixels) and wait until it has swung round. */
const orbit = async (dx, dy) => {
  await ev(([dx, dy]) => window.app.rig.look(dx, dy), [dx, dy]);
  await waitFrames(page, 80); // settled, and before the look offset starts easing back (1.5 s)
};

await page.goto(`${server.url}?debug&q=high`);
await waitFrames(page, 3, 180000);
await page.waitForFunction(() => document.getElementById('boot').classList.contains('gone'), null, { timeout: 60000 });
// fixed 1/60 s steps: the flight and the cameras evolve the same way on every run
await ev(() => {
  window.__icarus.setAutoScale(false);
  window.__icarus.setFixedDt(1 / 60);
  // the clouds drift with every frame since boot, taken at real time steps: start them from the same
  // place on every run (for one frame, then they drift on from there)
  window.__icarus.setUniform('uCloudOffset', [0, 0]);
  window.__icarus.setUniform('uTime', 0);
});
await waitFrames(page, 2);
await ev(() => {
  window.__icarus.setUniform('uCloudOffset', null);
  window.__icarus.setUniform('uTime', null);
});

// hero: golden hour over the fjord
await fly(16.55, 'air', 'chase', false, 6);
await waitFrames(page, 40);
await orbit(170, 10);
await save('hero');

// main menu over the flight (the real menu sits over a cinematic flight that cuts between shots)
await fly(16.55, 'air', 'chase', false, 14);
await waitFrames(page, 30);
await ev(() => window.app.ui.showMenu());
await page.click('[data-time="golden"]');
await orbit(-250, 40);
await save('menu');
await ev(() => window.app.ui.hideAll());

// the same fjord at five times of day, as vertical slices of one view
const TIMES = [['Dawn', 5.85], ['Day', 12], ['Golden hour', 16.55], ['Dusk', 18.15], ['Night', 22.6]];
const frames = [];
for (const [, t] of TIMES) {
  await ev((t) => {
    window.__icarus.setTime(t);
    window.__icarus.setCamera(-1500, 120, 1900, 80, -2);
  }, t);
  await waitFrames(page, 60);
  frames.push((await page.screenshot({ type: 'png' })).toString('base64'));
}
const slice = W / TIMES.length;
const comp = await browser.newPage({ viewport: { width: W, height: H } });
await comp.setContent(`<!doctype html><html><head>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600&display=swap">
<style>
  body { margin: 0; display: flex; width: ${W}px; height: ${H}px; background: #000; }
  .s { flex: 1; position: relative; background-size: ${W}px ${H}px; }
  .s + .s { box-shadow: -1px 0 0 rgba(255, 255, 255, 0.4); }
  .l { position: absolute; left: 0; right: 0; bottom: 26px; text-align: center; color: #ece8e0;
       font: 600 22px 'Barlow Condensed', 'Arial Narrow', sans-serif; letter-spacing: 0.22em;
       text-transform: uppercase; text-shadow: 0 1px 12px rgba(0, 0, 0, 0.8); }
</style></head><body>
${frames.map((f, i) => `<div class="s" style="background-image: url(data:image/png;base64,${f}); background-position: -${i * slice}px 0"><div class="l">${TIMES[i][0]}</div></div>`).join('\n')}
</body></html>`);
await comp.evaluate(() => document.fonts.ready);
await comp.screenshot({ path: path.join(OUT, 'times-of-day.jpg'), type: 'jpeg', quality: 85 });
await comp.close();
console.log('saved times-of-day');

// aurora over the fjord, on the water at night (thin clouds so the sky shows)
await ev(() => window.__icarus.setUniform('uCloudCover', 0.18));
await fly(22.6, 'water', 'chase', false, 2);
await waitFrames(page, 40);
await orbit(650, 15);
await save('aurora');
await ev(() => window.__icarus.setUniform('uCloudCover', null));

// cockpit at the end of the day
await fly(17.6, 'air', 'cockpit', true, 8);
await waitFrames(page, 40);
await save('cockpit');

// ring run: the autopilot flies the course; shoot as gate 3 comes up
await ev(() => {
  const api = window.__icarus;
  api.setTime(15.2);
  api.session.start('rings', 'air');
  api.setCameraMode('chase');
  window.app.hudVisible = true;
  api.session.autoRings(0);
  api.setFixedDt(1 / 12);
});
for (let k = 0; k < 2000; k++) {
  await waitFrames(page, 1);
  const tg = await ev(() => window.__icarus.session.hud()?.target ?? null);
  if (tg && tg.label === '3' && tg.dist < 330) break;
}
await ev(() => window.__icarus.setFixedDt(1 / 60));
await waitFrames(page, 20);
await save('ring-run');

// landing on the mountain strip: on final with the landing guide, then the results card
await ev(() => {
  const api = window.__icarus;
  api.setTime(14.5);
  api.session.start('landing', undefined, undefined, 'home');
  api.setCameraMode('chase');
  window.app.hudVisible = true;
  api.session.autoLanding(false);
  api.setFixedDt(1 / 12);
});
for (let k = 0; k < 2000; k++) {
  await waitFrames(page, 1);
  if ((await ev(() => window.__icarus.session.hud()?.landing?.dist ?? 1e9)) < 110) break;
}
await ev(() => window.__icarus.setFixedDt(1 / 60));
await waitFrames(page, 20);
await save('landing');
await ev(() => window.__icarus.setFixedDt(1 / 12));
await page.waitForFunction(() => window.__icarus.session.state() === 'results', null, { timeout: 240000 });
await ev(() => window.__icarus.setFixedDt(1 / 60));
await page.waitForTimeout(1800);
await save('results');

const ok = report(problems);
await browser.close();
await server.close();
process.exit(ok ? 0 : 1);
