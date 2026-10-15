// End-to-end flight test in the real page with real key events.
// For each flight model: runway rest (jitter), keyboard takeoff, keyboard stall + recovery,
// then a rendered autoland and rest after rollout. Clearance to the drawn surface is sampled throughout.
// usage: node scripts/flight.mjs [--models=arcade,assisted,simulation] [--q=low]
import { startServer, launch, waitFrames, shot, report } from './harness.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const models = (args.models ?? 'arcade,assisted,simulation').split(',');
const server = await startServer();
const { browser, page, problems } = await launch({ width: 1280, height: 720 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const st = () => page.evaluate(() => window.__icarus.flight.state());
const probe = () => page.evaluate(() => window.__icarus.flight.surfaceProbe());
let failures = 0;
const check = (cond, msg) => {
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) failures++;
};

const held = new Set();
async function key(code, down) {
  if (down && !held.has(code)) {
    held.add(code);
    await page.keyboard.down(code);
  } else if (!down && held.has(code)) {
    held.delete(code);
    await page.keyboard.up(code);
  }
}
async function releaseAll() {
  for (const k of [...held]) await key(k, false);
}
/** Bang-bang keyboard pilot: holds a key while the error exceeds a deadband. */
async function steer(err, neg, pos, dead) {
  await key(pos, err > dead);
  await key(neg, err < -dead);
}
/** Sigma-delta keyboard pilot: key pulse density proportional to a command u in [-1, 1]. */
const sd = new Map();
async function modulate(u, neg, pos) {
  let e = (sd.get(pos) ?? 0) + Math.max(-1, Math.min(1, u));
  let dir = 0;
  if (e > 0.5) { dir = 1; e -= 1; } else if (e < -0.5) { dir = -1; e += 1; }
  sd.set(pos, e);
  await key(pos, dir > 0);
  await key(neg, dir < 0);
}
let prev = null;
/** Proportional-derivative attitude hold through the keyboard. */
async function fly(s, { pitch = null, bank = 0, heading = null, dt = 0.05 }) {
  const rates = prev ? { p: (s.pitch - prev.pitch) / dt, b: (s.bank - prev.bank) / dt } : { p: 0, b: 0 };
  prev = s;
  if (pitch !== null) await modulate((pitch - s.pitch) * 0.12 - rates.p * 0.06, 'KeyW', 'KeyS');
  const hErr = heading === null ? 0 : (((heading - s.heading + 540) % 360) - 180);
  // like a pilot: rudder steers on the ground, bank steers in the air
  const onGround = s.wheelsOnGround > 0 || s.onWater;
  const bankTarget = heading !== null && !onGround ? Math.max(-12, Math.min(12, hErr * 1.2)) : bank;
  await modulate((bankTarget - s.bank) * 0.06 - rates.b * 0.05, 'KeyA', 'KeyD');
  await modulate(onGround ? hErr * 0.12 : 0, 'KeyQ', 'KeyE');
}

for (const model of models) {
  console.log(`\n== ${model}`);
  await page.goto(`${server.url}?debug&q=${args.q ?? 'low'}&start=runway&model=${model}&t=golden`);
  await waitFrames(page, 3, 180000);
  await page.evaluate(() => window.__icarus.setAutoScale(false));
  await page.evaluate(() => window.__icarus.setCameraMode('chase'));
  await page.click('#scene'); // focus + audio gesture
  let minClear = 1e9;

  // 1. rest on the runway with the brakes held (real frames, 10 s), steady wind so only numerical jitter remains
  await page.evaluate(() => { window.app.env.gustiness = 0; });
  await key('Space', true);
  await sleep(1500);
  const p0 = await probe();
  let maxD = 0;
  let maxRot = 0;
  for (let i = 0; i < 100; i++) {
    const p = await probe();
    minClear = Math.min(minClear, p.minClearance);
    maxD = Math.max(maxD, Math.hypot(p.x - p0.x, p.y - p0.y, p.z - p0.z));
    const dot = Math.abs(p.qx * p0.qx + p.qy * p0.qy + p.qz * p0.qz + p.qw * p0.qw);
    maxRot = Math.max(maxRot, (2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI);
    await sleep(100);
  }
  await key('Space', false);
  check(maxD < 0.001 && maxRot < 0.01, `runway rest 10 s (steady 4 m/s wind): drift ${(maxD * 1000).toFixed(3)} mm, rotation ${maxRot.toFixed(4)}°`);
  await page.evaluate(() => { window.app.env.gustiness = 0.6; });

  // 2. keyboard takeoff
  const s0 = await st();
  const rwyHdg = s0.heading;
  await key('KeyR', true);
  await sleep(2200);
  await key('KeyR', false);
  let lift = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 150000) {
    const s = await st();
    const p = await probe();
    minClear = Math.min(minClear, p.minClearance);
    if (s.crashed) break;
    const kt = s.ias * 1.944;
    await fly(s, { pitch: kt > 58 ? 7 : s.wheelsOnGround ? 0 : 5, bank: 0, heading: rwyHdg });
    if (!lift && s.wheelsOnGround === 0 && s.agl > 2) lift = { dist: Math.hypot(s.x - s0.x, s.z - s0.z), kt };
    if (s.agl > 350) break;
    await sleep(50);
  }
  await releaseAll();
  let s = await st();
  check(!s.crashed && lift && s.agl > 250, `keyboard takeoff: liftoff after ${lift?.dist.toFixed(0)} m at ${lift?.kt.toFixed(0)} kt, now ${s.agl.toFixed(0)} m AGL climbing ${(s.vs * 196.85).toFixed(0)} fpm ${s.crashReason}`);
  await shot(page, `flight-${model}-climb`);

  // 3. stall: idle power, keep pulling until the wing lets go, then recover
  await key('KeyF', true);
  await sleep(2200);
  await key('KeyF', false);
  let warn = null;
  let stall = null;
  const alt0 = s.altitude;
  let minAlt = alt0;
  let maxAlpha = 0;
  const t1 = Date.now();
  while (Date.now() - t1 < 60000) {
    s = await st();
    minAlt = Math.min(minAlt, s.altitude);
    maxAlpha = Math.max(maxAlpha, s.alpha);
    if (s.crashed) break;
    if (!stall) {
      await fly(s, { bank: 0 });
      await key('KeyS', true);
      await key('KeyW', false);
      if (s.stallWarning && !warn) warn = Date.now();
      if (s.stalled || s.alpha > 16.5) {
        stall = Date.now();
        if (model !== 'arcade') await shot(page, `flight-${model}-stall`);
      }
      // arcade/assisted protect the stall: stop after holding full back-pressure for a while
      if (!stall && Date.now() - t1 > (model === 'simulation' ? 40000 : 15000)) break;
    } else {
      // recovery: unload, full power, then raise the nose to level flight
      const since = Date.now() - stall;
      await key('KeyR', since > 800 && s.throttle < 0.99);
      if (since < 2000) {
        await key('KeyS', false);
        await key('KeyW', true);
        await fly(s, { bank: 0 });
      } else await fly(s, { pitch: 4, bank: 0 });
      if (since > 10000) break;
    }
    await sleep(50);
  }
  await releaseAll();
  s = await st();
  if (model === 'simulation') {
    check(!!warn && !!stall && warn <= stall, `stall: warning ${warn ? 'before' : 'missing'} the break, max α ${maxAlpha.toFixed(1)}°, height lost ${(alt0 - minAlt).toFixed(0)} m`);
    check(!s.crashed && s.vs > -3 && s.ias > 28, `stall recovery: ${s.crashed ? 'crashed ' + s.crashReason : `${(s.ias * 1.944).toFixed(0)} kt, ${(s.vs * 196.85).toFixed(0)} fpm`}`);
  } else {
    check(!s.crashed, `${model} stall protection: ${stall ? 'stalled' : 'no stall'} with full back-pressure (max α ${maxAlpha.toFixed(1)}°), warning ${warn ? 'shown' : 'not shown'}`);
  }

  // 4. rendered autoland on the coastal strip
  await page.evaluate(() => window.__icarus.flight.autoland('coastal', 1400));
  const t2 = Date.now();
  let shotDone = false;
  while (Date.now() - t2 < 120000) {
    s = await st();
    const p = await probe();
    minClear = Math.min(minClear, p.minClearance);
    const phase = await page.evaluate(() => window.__icarus.flight.autolandPhase());
    if (!shotDone && s.agl < 40) {
      shotDone = true;
      await shot(page, `flight-${model}-final`);
    }
    if (s.crashed || (phase === 'rollout' && s.groundSpeed < 0.3)) break;
    await sleep(100);
  }
  const r = await page.evaluate(() => window.__icarus.flight.autolandResult());
  check(!r.crashed && r.touchdown?.onRunway, `autoland: touchdown ${r.touchdown ? (r.touchdown.sinkRate * 196.85).toFixed(0) + ' fpm, ' + r.pastThreshold.toFixed(0) + ' m past threshold, ' + r.centreline.toFixed(1) + ' m off centreline' : 'none'} ${r.crashReason}`);
  // rest after landing (autoland keeps the brakes on), steady wind
  await page.evaluate(() => { window.app.env.gustiness = 0; });
  await sleep(2000);
  const q0 = await probe();
  let drift = 0;
  for (let i = 0; i < 50; i++) {
    const q = await probe();
    minClear = Math.min(minClear, q.minClearance);
    drift = Math.max(drift, Math.hypot(q.x - q0.x, q.y - q0.y, q.z - q0.z));
    await sleep(100);
  }
  check(drift < 0.001, `rest after rollout: drift ${(drift * 1000).toFixed(3)} mm over 5 s`);
  check(minClear > -0.35, `lowest contact point vs drawn surface over the whole run: ${minClear.toFixed(3)} m (tyre/spring compression only)`);
  await shot(page, `flight-${model}-stopped`);
  await page.evaluate(() => window.__icarus.flight.autoland(null));
}
const ok = report(problems) && failures === 0;
console.log(ok ? '\nFLIGHT TESTS OK' : `\nFLIGHT TESTS FAILED (${failures})`);
await browser.close();
await server.close();
process.exit(ok ? 0 : 1);
