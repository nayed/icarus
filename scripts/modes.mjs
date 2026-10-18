// Game modes end to end: ring run (clean and corner-cutting), mountain landing (good and hard), free-flight crash.
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
check(hud?.target && hud.timer === '0:00.00', `HUD before the first gate: ${JSON.stringify(hud)}`);
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

const ok = report(problems) && failures === 0;
console.log(ok ? '\nMODE TESTS OK' : `\nMODE TESTS FAILED (${failures})`);
await browser.close();
await server.close();
process.exit(ok ? 0 : 1);
