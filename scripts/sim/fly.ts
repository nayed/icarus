// Headless flight experiments for tuning: node scripts/sim/fly.ts <scenario> [model]
import { Aircraft, type PilotInput } from '../../src/sim/aircraft.ts';
import { WorldEnv } from '../../src/sim/environment.ts';
import { Autopilot, idleInput } from '../../src/sim/autopilot.ts';
import { STRIPS, headingDir } from '../../src/world/params.ts';
import { drawnHeight } from '../../src/world/clipmap.ts';

const scen = process.argv[2] ?? 'trim';
const model = (process.argv[3] ?? 'assisted') as 'arcade' | 'assisted' | 'simulation';
const env = new WorldEnv({ M: 128, levels: 11, s0: 1 });
env.gustiness = 0;
const ac = new Aircraft();
ac.model = model;
const ap = new Autopilot();
const inp: PilotInput = idleInput();
const DT = 1 / 120;
const tel = () => ac.telemetry(env);
function run(sec: number, each?: (t: number) => void, every = 1) {
  let acc = 0;
  for (let i = 0; i < Math.round(sec / DT); i++) {
    env.follow(ac.pos.x, ac.pos.z);
    ac.step(DT, inp, env);
    acc += DT;
    if (each && acc >= every - 1e-9) { acc = 0; each(ac.time); }
    if (ac.crashed) { console.log('CRASH', ac.crashReason); return; }
  }
}
const fmt = (n: number, d = 1) => n.toFixed(d).padStart(7);
function line(extra = '') {
  const t = tel();
  console.log(`t${fmt(ac.time)} x${fmt(ac.pos.x, 0)} z${fmt(ac.pos.z, 0)} alt${fmt(t.altitude)} agl${fmt(t.agl)} ias${fmt(t.ias * 1.944)}kt vs${fmt(t.vs * 196.85, 0)}fpm hdg${fmt(t.heading, 0)} pit${fmt(t.pitch)} bank${fmt(t.bank)} a${fmt(t.alpha)} b${fmt(t.beta)} thr${fmt(t.throttle, 2)} elev${fmt(ac.elevator, 2)} gnd${t.wheelsOnGround} w${ac.keelInWater} ${t.stallWarning ? 'STALLWARN' : ''} ${t.stalled ? 'STALL' : ''} ${extra}`);
}
function placeRunway(i: number, back: number) {
  const s = STRIPS[i];
  const d = headingDir(s.heading);
  const x = s.center[0] - d[0] * (s.halfLength - back), z = s.center[1] - d[1] * (s.halfLength - back);
  env.follow(x, z);
  ac.reset(x, drawnHeight(x, z, env.clip) + 2.47, z, s.heading, 0);
}
if (scen === 'trim') {
  ac.reset(-2000, 1000, 2000, 90, 50);
  for (const spd of [30, 40, 50, 60]) {
    ap.reset();
    run(25, () => { const t = tel(); inp.flapNotch = 0; ap.update(ac, { heading: 90, altitude: 1000, speed: spd }, t.ias, DT, inp); }, DT);
    line(`target ${(spd * 1.944).toFixed(0)}kt`);
  }
} else if (scen === 'takeoff') {
  placeRunway(0, 20);
  inp.flapNotch = 1;
  run(2, undefined);
  line('settled');
  inp.throttle = 1;
  let lift = 0;
  const x0 = ac.pos.clone();
  run(40, () => {
    const t = tel();
    if (t.ias > 27) inp.pitch = THREE_clamp((8 - t.pitch) * 0.1, -0.3, 0.6); else inp.pitch = 0;
    if (!lift && t.wheelsOnGround === 0 && t.agl > 0.5) { lift = ac.pos.distanceTo(x0); line(`LIFTOFF at ${lift.toFixed(0)} m`); }
  }, DT);
  line('end');
} else if (scen === 'rest') {
  placeRunway(0, 200);
  inp.brake = 1;
  run(3);
  const p0 = ac.pos.clone(); const q0 = ac.q.clone();
  let maxD = 0, maxA = 0;
  run(10, () => { maxD = Math.max(maxD, ac.pos.distanceTo(p0)); maxA = Math.max(maxA, ac.q.angleTo(q0) * 180 / Math.PI); }, DT);
  line(`drift ${(maxD * 1000).toFixed(3)} mm, rot ${maxA.toFixed(4)} deg`);
}
function THREE_clamp(v: number, a: number, b: number) { return Math.max(a, Math.min(b, v)); }
if (scen === 'open') {
  const elev = Number(process.argv[4] ?? 0), thr = Number(process.argv[5] ?? 0.6);
  ac.reset(-2000, 1500, 2000, 90, 50);
  inp.throttle = thr; inp.pitch = elev;
  run(60, () => {
    const t = tel();
    inp.roll = THREE_clamp(-t.bank * 0.05 + ac.omega.z * 0.4, -1, 1);
  }, DT);
  for (let k = 0; k < 6; k++) { run(10, () => { const t = tel(); inp.roll = THREE_clamp(-t.bank * 0.05 + ac.omega.z * 0.4, -1, 1); }, DT); line(`elev ${elev} thr ${thr}`); }
}
if (scen === 'hold') {
  const spd = Number(process.argv[4] ?? 40);
  ac.reset(-2000, 1000, 2000, 90, spd);
  ap.reset();
  run(40, () => { ap.update(ac, { heading: 90, altitude: 1000, speed: spd }, tel().ias, DT, inp); }, DT);
  for (let k = 0; k < 12; k++) run(2, () => { ap.update(ac, { heading: 90, altitude: 1000, speed: spd }, tel().ias, DT, inp); }, DT), line();
}
if (scen === 'stall') {
  ac.reset(-2000, 1500, 2000, 90, 36);
  ap.reset();
  run(15, () => ap.update(ac, { heading: 90, altitude: 1500, speed: 36 }, tel().ias, DT, inp), DT);
  line('trimmed');
  // idle, hold altitude by pulling until the wing stalls
  let warned = -1, stalled = -1; const y0 = ac.pos.y; let minY = y0; let maxA = 0;
  inp.throttle = 0;
  run(25, () => {
    const t = tel();
    inp.pitch = Math.min(1, inp.pitch + DT * 0.08);
    inp.roll = Math.max(-1, Math.min(1, -t.bank * 0.03 + ac.omega.z * 0.3));
    if (t.stallWarning && warned < 0) { warned = ac.time; line('stall warning'); }
    if (t.stalled && stalled < 0) { stalled = ac.time; line('STALLED'); }
    minY = Math.min(minY, ac.pos.y); maxA = Math.max(maxA, t.alpha);
    if (stalled > 0 && ac.time - stalled > 2) { inp.pitch = -0.5; inp.throttle = 1; }
    if (stalled > 0 && ac.time - stalled > 4) { inp.pitch = THREE_clamp((5 - t.pitch) * 0.05 - ac.omega.x * 0.6, -1, 1); }
  }, DT);
  line(`max alpha ${maxA.toFixed(1)}  altitude lost ${(y0 - minY).toFixed(0)} m`);
}
function approach(stripIdx: number | any, dist: number, water = false) {
  const s = typeof stripIdx === 'number' ? STRIPS[stripIdx] : stripIdx;
  const d = headingDir(s.heading);
  const thr = [s.center[0] - d[0] * s.halfLength, s.center[1] - d[1] * s.halfLength];
  const aim = [thr[0] + d[0] * 120, thr[1] + d[1] * 120];
  const x = aim[0] - d[0] * dist, z = aim[1] - d[1] * dist;
  const gs = 3.5 * Math.PI / 180;
  ac.reset(x, s.elevation + 2.5 + dist * Math.tan(gs), z, s.heading, 31);
  inp.flapNotch = 2; inp.gearDown = !water;
  ap.reset();
  let flare = false, td: any = null;
  ac.onTouchdown = (t) => { if (!td) td = t; };
  run(120, () => {
    const t = tel();
    const rx = ac.pos.x - aim[0], rz = ac.pos.z - aim[1];
    const along = rx * d[0] + rz * d[1];
    const across = -rx * d[1] + rz * d[0];
    const distTo = -along;
    if (!flare && !td) {
      const hTgt = s.elevation + 2.5 + Math.max(distTo, 0) * Math.tan(gs);
      const vs = -Math.max(distTo, 0) * 0 + -31 * Math.sin(gs) + (hTgt - ac.pos.y) * 0.25;
      ap.update(ac, { heading: s.heading - THREE_clamp(across * 0.6, -25, 25), vs, speed: 31, maxBank: 15 }, t.ias, DT, inp);
      if (t.agl < 9) { flare = true; line('flare'); }
    } else if (!td) {
      // attitude flare: ease the nose up to ~7° as the ground comes up, power to idle
      inp.throttle = 0;
      ap.update(ac, { heading: s.heading - THREE_clamp(across * 0.6, -25, 25), vs: -1, speed: 0, throttle: 0, maxBank: 8 }, t.ias, DT, inp);
      const pt = 7 - Math.max(t.agl, 0) * 0.35;
      inp.pitch = THREE_clamp((pt - t.pitch) * 0.12 - ac.omega.x * 0.8 + (-0.6 - t.vs) * 0.15, -1, 1);
    } else {
      // hold the nose off, let it down gently, then brake
      const tsince = ac.time - td.time;
      inp.throttle = 0; inp.roll = 0; inp.brake = water ? 0 : (tsince > 2 ? 1 : 0);
      inp.pitch = THREE_clamp(((tsince < 3 ? 4 - tsince * 1.5 : -1) - t.pitch) * 0.1 - ac.omega.x * 0.8, -1, 1);
      inp.yaw = THREE_clamp(-across * 0.2 + (s.heading - ac.heading) * 0.05, -1, 1);
    }
  }, DT);
  if (td) {
    const rx = td.x - thr[0], rz = td.z - thr[1];
    console.log(`TOUCHDOWN sink ${(td.sinkRate * 196.85).toFixed(0)} fpm, ${(td.groundSpeed * 1.944).toFixed(0)} kt GS, past threshold ${(rx * d[0] + rz * d[1]).toFixed(0)} m, centreline ${(-rx * d[1] + rz * d[0]).toFixed(1)} m, bank ${td.bank.toFixed(1)}, pitch ${td.pitch.toFixed(1)}, runway ${td.onRunway}, water ${td.onWater}`);
  }
  line(ac.crashed ? 'CRASHED ' + ac.crashReason : 'stopped');
}
if (scen === 'land') approach(Number(process.argv[4] ?? 0), 2500);
if (scen === 'waterland') {
  // fake strip on the fjord water: reuse the approach logic with a virtual runway
  approach({ id: 'water', name: 'fjord', center: [3200, 2400], heading: 95, halfLength: 600, halfWidth: 40, elevation: -2.3 }, 2000, process.argv[4] !== 'geardown');
}
if (scen === 'watertakeoff') {
  ac.reset(2600, 0, 2350, 95, 0);
  ac.pos.y = 2.0; inp.gearDown = false; inp.flapNotch = 1;
  run(6); line('floating');
  inp.throttle = 1; const x0 = ac.pos.clone(); let lift = 0;
  run(60, () => {
    const t = tel();
    inp.pitch = THREE_clamp(((t.ias > 26 ? 9 : 4) - t.pitch) * 0.08 - ac.omega.x * 0.6, -1, 1);
    inp.roll = THREE_clamp(-t.bank * 0.04 + ac.omega.z * 0.3, -1, 1);
    inp.yaw = THREE_clamp((95 - ac.heading) * 0.05 + ac.beta, -1, 1);
    if (!lift && ac.keelInWater === 0 && t.agl > 1) { lift = ac.pos.distanceTo(x0); line(`WATER LIFTOFF after ${lift.toFixed(0)} m`); }
  }, DT);
  line('end');
}
if (scen === 'drop') {
  const cases: [string, number, number, number, boolean][] = [
    ['runway 0.4m', 600, 6250, 0.4, true], ['runway 3m', 600, 6250, 3, true], ['slope 0.4m', 4300, -1200, 0.4, true],
    ['steep 2m', 5200, -900, 2, true], ['water 0.4m', 3000, 2400, 0.4, false], ['water 3m', 3000, 2400, 3, false],
    ['mtn strip', 5550, 350, 0.3, true],
  ];
  for (const [label, x, z, h, gear] of cases) {
    const a2 = new Aircraft(); a2.model = model;
    env.follow(x, z);
    const g = Math.max(drawnHeight(x, z, env.clip), 0);
    a2.reset(x, g + 2.5 + h, z, 30, 0);
    const i2 = idleInput(); i2.gearDown = gear; i2.brake = 1;
    let minClear = 1e9; let minWater = 1e9;
    const P = new (a2.pos.constructor as any)();
    for (let i = 0; i < 120 * 10; i++) {
      env.follow(a2.pos.x, a2.pos.z);
      a2.step(DT, i2, env);
      for (const [px, py, pz] of [[-1.3, -2.47, 0.45], [1.3, -2.47, 0.45], [-1.3, -2.37, -3.3], [-1.3, -2.16, -0.9], [1.3, -2.16, -0.9], [0, -0.72, 0.6], [-7.3, 1.32, -0.2], [7.3, 1.32, -0.2], [0, -1.22, -4.55]]) {
        a2.toWorld([px, py, pz], P);
        minClear = Math.min(minClear, P.y - drawnHeight(P.x, P.z, env.clip));
        minWater = Math.min(minWater, P.y - env.waterHeight(P.x, P.z, a2.time));
      }
    }
    console.log(`drop ${label.padEnd(12)} rest CG ${(a2.pos.y - g).toFixed(3)} m above surface | lowest point vs terrain ${minClear.toFixed(3)} m | vs water ${minWater.toFixed(3)} m | speed ${a2.vel.length().toFixed(4)} | ${a2.crashed ? 'CRASH: ' + a2.crashReason : 'ok'}`);
  }
}
