// Game modes end to end: ring run (clean and corner-cutting), mountain landing (good and hard), free-flight crash,
// free flight from a random airstrip and from a random spot on the water.
import { startServer, launch, waitFrames, shot, report } from './harness.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const server = await startServer();
const { browser, page, problems } = await launch({ width: 1280, height: 720 });
let failures = 0;
const check = (c, m) => { console.log(`  ${c ? '✓' : '✗'} ${m}`); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function open(mode, extra = '') {
  await page.goto(`${server.url}?debug&q=${args.q ?? 'low'}&mode=${mode}&model=${args.model ?? 'assisted'}&t=${args.t ?? 'golden'}${extra}`);
  await waitFrames(page, 3, 180000);
  await page.evaluate(() => { window.__icarus.setAutoScale(false); window.__icarus.setFixedDt(1 / 15); });
}
async function waitResult(timeoutMs, onTick) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await page.evaluate(() => window.__icarus.session.result());
    if (r) return r;
    if (onTick) await onTick();
    await sleep(250);
  }
  return null;
}
const metrics = (r) => r.metrics.map((m) => `${m.label} ${m.value}`).join(', ');

console.log('\n== ring run, autopilot through the gates');
await open('rings');
let hud = await page.evaluate(() => window.__icarus.session.hud());
check(hud?.target && hud.timer === '0:00.00' && hud.map?.gates?.length === 14 && hud.map.gateStates[0] === 1, `HUD before the first gate: ${JSON.stringify({ ...hud, map: `${hud?.map?.gates?.length} gates, the first one next` })}`);
await page.evaluate(() => window.__icarus.session.autoRings(0));
let shots = 0;
let r = await waitResult(240000, async () => {
  const h = await page.evaluate(() => window.__icarus.session.hud());
  if (shots === 0 && h.timerSub?.startsWith('Gate 3')) { shots++; await shot(page, 'mode-rings-chase'); await page.evaluate(() => window.__icarus.setCameraMode('cinematic')); }
  else if (shots === 1 && h.timerSub?.startsWith('Gate 9')) { shots++; await shot(page, 'mode-rings-cinematic'); await page.evaluate(() => window.__icarus.setCameraMode('cockpit')); }
  else if (shots === 2 && h.timerSub?.startsWith('Gate 12')) { shots++; await shot(page, 'mode-rings-cockpit'); }
});
check(r && r.success && r.metrics[1].value === '14 / 14', `clean run: ${r ? `${r.grade} ${r.headline} (${r.subtitle}) — ${metrics(r)}` : 'no result'}`);
check((await page.evaluate(() => window.__icarus.session.state())) === 'results', 'app switched to the results state');

console.log('\n== ring run, cutting 45 m wide of every gate');
await open('rings');
await page.evaluate(() => window.__icarus.session.autoRings(45));
r = await waitResult(240000);
check(r && r.metrics[1].value !== '14 / 14' && r.subtitle.includes('missed'), `misses are penalised: ${r ? `${r.grade} ${r.headline} (${r.subtitle})` : 'no result'}`);

console.log('\n== mountain landing, autopilot');
await open('landing');
hud = await page.evaluate(() => window.__icarus.session.hud());
check(hud?.landing && hud.landing.dist > 3000, `landing HUD: ${hud?.landing ? `threshold ${hud.landing.dist.toFixed(0)} m, glide ${hud.landing.glideDev.toFixed(0)} m, centre ${hud.landing.centreDev.toFixed(0)} m` : 'missing'}`);
await page.evaluate(() => window.__icarus.session.autoLanding(false));
let shotL = false;
r = await waitResult(240000, async () => {
  const s = await page.evaluate(() => window.__icarus.flight.state());
  if (!shotL && s.agl < 35) { shotL = true; await shot(page, 'mode-landing-final'); }
});
check(r && r.success && ['S', 'A', 'B'].includes(r.grade), `good landing: ${r ? `${r.grade} score ${r.headline} (${r.subtitle}) — ${metrics(r)}` : 'no result'}`);
await sleep(500);
await shot(page, 'mode-landing-stopped');

console.log('\n== mountain landing, flown into the ground');
await open('landing');
await page.evaluate(() => window.__icarus.session.autoLanding(true));
r = await waitResult(240000);
check(r && (!r.success || ['C', 'D', 'F'].includes(r.grade)), `hard landing: ${r ? `${r.grade} score ${r.headline} (${r.subtitle}) — ${metrics(r)}` : 'no result'}`);

console.log('\n== free flight, dive into the sea');
await open('free', '&start=air');
await page.evaluate(() => window.__icarus.flight.input({ pitch: -1, throttle: 1 }));
r = await waitResult(60000);
check(r && r.grade === 'F' && !r.success, `crash ends the session: ${r ? `${r.headline} — ${r.subtitle}` : 'no result'}`);

console.log('\n== ring run, crash then retry');
await open('rings');
await page.evaluate(() => window.__icarus.flight.input({ pitch: -1, throttle: 1 }));
r = await waitResult(90000);
check(r && !r.success, `the crash ends the run: ${r ? `${r.grade} ${r.headline}` : 'no result'}`);
// whether the wreck's engine has stopped depends on frame timing (a physics step after the crash in
// the same frame stops it): force that state, then do what Retry does. The retry used to keep it stopped.
await page.evaluate(() => { window.app.ac.engineOn = false; window.__icarus.flight.input(null); window.app.restartSession(); });
await waitFrames(page, 30);
const eng = await page.evaluate(() => ({ on: window.app.ac.engineOn, rpm: window.app.ac.rpm, thr: window.app.ac.throttle, state: window.__icarus.session.state() }));
check(eng.state === 'flying' && eng.on && eng.rpm > 1500, `the retry starts with the engine running: ${Math.round(eng.rpm)} rpm at ${Math.round(eng.thr * 100)}% power`);

console.log('\n== menu flight: a crash restarts it, the menu stays');
await page.evaluate(() => window.app.enterMenu());
await waitFrames(page, 10);
await page.evaluate(() => window.app.ac.crash('test'));
await waitFrames(page, 20);
const menu = await page.evaluate(() => ({ state: window.__icarus.session.state(), crashed: window.app.ac.crashed, on: window.app.ac.engineOn }));
check(menu.state === 'menu' && !menu.crashed && menu.on, `background flight restarted with its engine, state stays ${menu.state}`);

console.log('\n== free flight from an airstrip: a random strip, lined up for its departure into the wind');
// the menu's Fly with Free flight and Airstrip chosen
const startFromMenu = () => page.evaluate(() => {
  const ui = window.app.ui;
  Object.assign(ui.prefs, { mode: 'free', start: 'runway' });
  ui.fly();
});
const where = () => page.evaluate(() => {
  const app = window.app;
  const id = window.__icarus.session.startStrip();
  return {
    id,
    state: window.__icarus.session.state(),
    onRunway: app.env.onRunway(app.ac.pos.x, app.ac.pos.z),
    speed: Math.hypot(app.ac.vel.x, app.ac.vel.z),
    heading: app.telemetry.heading,
    prompt: window.__icarus.session.hud()?.prompt ?? '',
    reason: app.ac.crashReason,
    dt: app.fixedDt,
    gear: app.ac.gear,
    wheels: app.ac.wheelsOnGround,
  };
});
const ids = [];
const bad = [];
let lined = 0;
let named = 0;
for (let k = 0; k < 12; k++) {
  await startFromMenu();
  await waitFrames(page, 3);
  const w = await where();
  const want = await page.evaluate((id) => {
    const app = window.app;
    // the departure most into the wind, as App.startFlight picks it
    const s = { coastal: [45, 225], mountain: [60, 240], north: [277], east: [262], south: [131, 311] }[id];
    const wind = app.settings.windFrom;
    return s.reduce((a, b) => (Math.cos(((wind - b) * Math.PI) / 180) > Math.cos(((wind - a) * Math.PI) / 180) ? b : a));
  }, w.id);
  ids.push(w.id);
  // gear down and on its wheels from the first frames (the flight before, in the menu, was gear up)
  if (w.state === 'flying' && w.onRunway && w.speed < 0.5 && w.gear === 1 && w.wheels >= 3 && Math.abs(((w.heading - want + 540) % 360) - 180) < 2) lined++;
  else bad.push(`${w.id}: ${w.state}${w.reason ? ` (${w.reason})` : ''}, ${w.onRunway ? 'on' : 'off'} the runway, ${w.speed.toFixed(2)} m/s, gear ${w.gear.toFixed(2)}, ${w.wheels} wheels down, heading ${w.heading.toFixed(1)} (want ${want})`);
  if (w.prompt.length > 0) named++;
}
const distinct = new Set(ids).size;
const repeats = ids.filter((id, k) => k > 0 && id === ids[k - 1]).length;
check(distinct >= 3 && repeats === 0, `12 flights from the menu: ${distinct} different strips, never the same twice in a row (${ids.join(', ')})`);
check(lined === 12, `every start on the runway, at rest on its wheels, facing its departure into the wind (${lined}/12)${bad.length ? `: ${bad.join('; ')}` : ''}`);
const last = await where();
check(named === 12 && /strip\. Hold R/.test(last.prompt), `the start prompt names the strip: "${last.prompt}"`);
await page.keyboard.press('Backspace');
await waitFrames(page, 3);
const again = await where();
check(again.id === last.id && again.onRunway, `Restart keeps the strip (${last.id} → ${again.id})`);

console.log('\n== free flight on the water: a random spot each time, facing into the wind');
const afloat = () => page.evaluate(() => {
  const app = window.app;
  return {
    spot: window.__icarus.session.waterStart(),
    state: window.__icarus.session.state(),
    x: app.ac.pos.x,
    z: app.ac.pos.z,
    keel: app.ac.keelInWater,
    gear: app.ac.gear,
    speed: Math.hypot(app.ac.vel.x, app.ac.vel.z),
    heading: app.telemetry.heading,
    wind: app.settings.windFrom,
    reason: app.ac.crashReason,
  };
});
const spots = [];
const adrift = [];
const angle = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
for (let k = 0; k < 8; k++) {
  await page.evaluate(() => {
    const ui = window.app.ui;
    Object.assign(ui.prefs, { mode: 'free', start: 'water' });
    ui.fly();
  });
  await waitFrames(page, 3);
  const w = await afloat();
  spots.push(w);
  const at = Math.hypot(w.x - w.spot.x, w.z - w.spot.z);
  if (!(w.state === 'flying' && w.keel > 0 && w.gear === 0 && w.speed < 1 && at < 5 && angle(w.heading, w.spot.heading) < 2 && angle(w.spot.heading, w.wind) <= 70)) {
    adrift.push(`(${Math.round(w.spot.x)}, ${Math.round(w.spot.z)}) on ${w.spot.heading}°: ${w.state}${w.reason ? ` (${w.reason})` : ''}, ${at.toFixed(1)} m from it, ${w.keel} keel points in the water, gear ${w.gear.toFixed(2)}, ${w.speed.toFixed(2)} m/s, heading ${w.heading.toFixed(1)}, wind from ${w.wind}`);
  }
}
check(adrift.length === 0, `8 flights from the menu: afloat at the spot, gear up, at rest, facing its heading within 70° of the wind${adrift.length ? `: ${adrift.join('; ')}` : ''}`);
const waters = spots.map((w) => w.spot.water);
const places = new Set(spots.map((w) => `${Math.round(w.spot.x)},${Math.round(w.spot.z)}`)).size;
check(places === 8 && waters.every((w, k) => k === 0 || w !== waters[k - 1]), `8 different spots, never the same water twice in a row (${waters.join(', ')})`);
await page.keyboard.press('Backspace');
await waitFrames(page, 3);
const back = await afloat();
const was = spots[7].spot;
check(back.spot.x === was.x && back.spot.z === was.z && Math.hypot(back.x - was.x, back.z - was.z) < 5, `Restart keeps the spot (${Math.round(was.x)}, ${Math.round(was.z)})`);

const ok = report(problems) && failures === 0;
console.log(ok ? '\nMODE TESTS OK' : `\nMODE TESTS FAILED (${failures})`);
await browser.close();
await server.close();
process.exit(ok ? 0 : 1);
