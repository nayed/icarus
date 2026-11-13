// Game modes: free flight, the fjord ring run and the graded landing.
import * as THREE from 'three';
import type { App, StartPoint } from '../app.ts';
import { buildCourse, courseDef, coursePar, courseStart, parFor, stripIndex, type Gate } from './course.ts';
import { gradeLanding, gradeMail, gradeRings, formatTime, type LandingInput, type ModeResult } from './grading.ts';
import type { Touchdown, PilotInput } from '../sim/aircraft.ts';
import { Autopilot } from '../sim/autopilot.ts';
import { STRIPS, headingDir, type StripDef } from '../world/params.ts';
import { runwayLocal } from '../sim/environment.ts';
import { LANDING_GLIDE, landingAim } from '../sim/scenarios.ts';
import { globals } from '../render/globals.ts';
import { ATMOSPHERE_GLSL, SKYVIEW_SAMPLE_GLSL } from '../render/atmosphere.ts';
import { GLOBALS_GLSL } from '../render/globals.ts';
import { OUTPUT_GLSL } from '../render/post.ts';
import type { ModeMap } from '../ui/chart.ts';
import { bestRun, recordRun } from './records.ts';

export type ModeKind = 'free' | 'rings' | 'landing' | 'attract';

const GATE_VISUAL_RADIUS = 20;

export interface ModeHud {
  title: string;
  timer?: string;
  timerSub?: string;
  /** next target in view space terms: relative bearing (deg, + right), elevation (deg, + up), distance (m) */
  target?: { label: string; bearing: number; elevation: number; dist: number };
  landing?: { dist: number; glideDev: number; centreDev: number; targetKt: number };
  prompt?: string;
  promptTone?: 'info' | 'warn' | 'good';
  /** what the maps show for this mode */
  map?: ModeMap;
}

export abstract class GameMode {
  abstract readonly kind: ModeKind;
  result: ModeResult | null = null;
  protected prompt = '';
  protected promptTone: 'info' | 'warn' | 'good' = 'info';
  protected promptUntil = 0;
  constructor(protected readonly app: App) {}
  abstract begin(): void;
  simStep(_dt: number): void {}
  frame(_dt: number): void {}
  abstract hud(): ModeHud;
  end(): void {}
  protected say(text: string, tone: 'info' | 'warn' | 'good' = 'info', seconds = 3): void {
    this.prompt = text;
    this.promptTone = tone;
    this.promptUntil = this.app.simTime + seconds;
  }
  protected currentPrompt(): Pick<ModeHud, 'prompt' | 'promptTone'> {
    return this.app.simTime < this.promptUntil ? { prompt: this.prompt, promptTone: this.promptTone } : {};
  }
  /** aim() for helpers outside the mode. */
  readonly aimAt = (x: number, y: number, z: number) => this.aim(x, y, z);
  /** Relative bearing/elevation of a world point from the aircraft. */
  protected aim(x: number, y: number, z: number): { bearing: number; elevation: number; dist: number } {
    const ac = this.app.ac;
    const dx = x - ac.pos.x;
    const dy = y - ac.pos.y;
    const dz = z - ac.pos.z;
    const hd = Math.hypot(dx, dz);
    let b = (Math.atan2(dx, -dz) * 180) / Math.PI - ac.heading;
    b = ((b + 540) % 360) - 180;
    return { bearing: b, elevation: (Math.atan2(dy, hd) * 180) / Math.PI, dist: Math.hypot(hd, dy) };
  }
  /** Common amphibian advice: gear position against what is below. */
  protected gearAdvice(): void {
    const t = this.app.telemetry;
    const ac = this.app.ac;
    if (t.agl > 120 || t.agl < 2 || ac.vel.y > 0) return;
    const ground = this.app.env.surface(ac.pos.x, ac.pos.z, { h: 0, nx: 0, ny: 1, nz: 0, level: 0 }).h;
    const overWater = ground < -1;
    if (overWater && ac.gear > 0.5 && t.vs < -0.5) this.say('GEAR DOWN — WATER', 'warn', 1.2);
    else if (!overWater && ac.gear < 0.5 && this.app.env.onRunway(ac.pos.x, ac.pos.z)) this.say('GEAR UP — RUNWAY', 'warn', 1.2);
  }
}

// ---------------------------------------------------------------- free flight

export class FreeFlight extends GameMode {
  readonly kind = 'free' as const;
  constructor(app: App, readonly start: StartPoint) {
    super(app);
  }
  begin(): void {
    this.app.startFlight(this.start);
    this.app.ac.onTouchdown = (t) => this.touchdown(t);
    const strip = STRIPS[this.app.startStrip];
    this.say(
      this.start === 'water' ? 'Gear is up for the water. R to add power.'
        : this.start === 'runway' ? `${strip.name}. Hold R for power, S to lift off around 60 kt.`
          : 'Free flight. C changes the camera.',
      'info',
      6,
    );
  }
  private touchdown(t: Touchdown): void {
    const fpm = Math.round(t.sinkRate * 196.85);
    const tone = fpm < 350 ? 'good' : fpm < 700 ? 'info' : 'warn';
    this.say(`Touchdown ${fpm} fpm${t.onRunway ? ' · on the strip' : t.onWater ? ' · on the water' : ''}`, tone, 4);
  }
  override frame(): void {
    this.gearAdvice();
    const ac = this.app.ac;
    if (ac.crashed && !this.result) {
      this.result = {
        mode: 'free',
        title: 'Free flight',
        score: 0,
        grade: 'F',
        headline: 'Crashed',
        subtitle: ac.crashReason,
        success: false,
        metrics: [
          { label: 'Flight time', value: formatTime(this.app.simTime), score: 1 },
          { label: ac.crashReason.includes('structural') ? 'Airspeed at break-up' : 'Airspeed at impact', value: `${Math.round(this.app.telemetry.ias * 1.944)} kt`, score: 0 },
        ],
      };
    }
  }
  hud(): ModeHud {
    return { title: 'Free flight', ...this.currentPrompt() };
  }
}

// ---------------------------------------------------------------- ring run

const RING_VERT = /* glsl */ `
out vec3 vWorld;
out vec3 vNormal;
#include <logdepthbuf_pars_vertex>
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <icarus_logdepth_vertex>
}
`;
const RING_FRAG = /* glsl */ `
in vec3 vWorld;
in vec3 vNormal;
uniform float uState; // 0 upcoming, 1 next, 2 passed, 3 missed
uniform float uPulse;
out vec4 fragColor;
#include <logdepthbuf_pars_fragment>
void main() {
  #include <logdepthbuf_fragment>
  vec3 N = normalize(vNormal);
  vec3 V = normalize(uCamPosF - vWorld);
  vec3 base = vec3(0.95, 0.42, 0.1);
  vec3 lit = base * ((uSunColor * max(dot(N, uSunDir), 0.0) + uMoonColor * max(dot(N, uMoonDir), 0.0)) / PI + envDiffuse(N));
  float rim = pow(1.0 - max(dot(N, V), 0.0), 2.0);
  float glow = uState < 0.5 ? 0.3 : uState < 1.5 ? 1.0 + 0.7 * uPulse : uState < 2.5 ? 2.5 * uPulse : 0.6 * uPulse;
  vec3 em = (uState > 2.5 ? vec3(1.0, 0.15, 0.08) : vec3(1.0, 0.62, 0.22)) * glow * 3.0 * max(1.0, uExposure * 0.002) * (0.5 + rim);
  vec3 col = lit + em;
  fragColor = finalOutput(applyFog(col, uCamPosF, vWorld));
}
`;

/**
 * A ring run: the gates against the clock, from the first gate to the last. A mail run (a course with
 * `mail`) starts on a runway instead, and its clock runs on past the last gate to the touchdown on the
 * strip at the other end, graded with the landing.
 */
export class RingRun extends GameMode {
  readonly kind = 'rings' as const;
  readonly course = courseDef(this.app.course);
  readonly gates: Gate[] = buildCourse(this.course.id);
  readonly par = parFor(this.course.id);
  /** the par from the first gate to the last (a mail run's par also has the final in it) */
  private readonly gatesPar = coursePar(this.gates);
  readonly penalty = 5;
  /** a mail run's ends, as indices into STRIPS (read by the autopilot hook) */
  readonly mail = this.course.mail ? { from: stripIndex(this.course.mail.from), departure: this.course.mail.departure, to: stripIndex(this.course.mail.to) } : null;
  private readonly watch = this.mail ? new LandingWatch(this.app, this.mail.to) : null;
  next = 0;
  missed = 0;
  startTime = -1;
  /** when the clock stopped: the last gate, or a mail run's touchdown */
  finishTime = -1;
  /** a mail run: when it passed the last gate, and how long it has been at rest on the ground before that */
  private lastGateAt = -1;
  private restingFor = 0;
  splits: number[] = [];
  private readonly group = new THREE.Group();
  private readonly mats: THREE.ShaderMaterial[] = [];
  private readonly prev = new THREE.Vector3();
  private states: number[] = [];
  private pulse = 0;
  /** seconds since each gate was passed or missed (drives the fade-out) */
  private fade: number[] = [];

  begin(): void {
    const ac = this.app.ac;
    if (this.mail) {
      this.app.startStrip = this.mail.from;
      this.app.startFlight('runway', this.mail.departure);
      ac.onTouchdown = (t) => {
        // touchdowns count from the last gate on (not the wheels leaving the runway at the start)
        if (this.next < this.gates.length || !this.watch) return;
        const said = this.watch.touchdown(t);
        if (!said) return;
        this.finishTime = this.app.simTime;
        this.say(said.text, said.tone, 3);
      };
    } else {
      const s = courseStart(this.gates);
      ac.reset(s.x, s.y, s.z, s.heading, 47);
      this.app.controls.reset(0.72, false, 0);
      this.app.startFlightAt();
    }
    this.prev.copy(ac.pos);
    this.states = this.gates.map((_, i) => (i === 0 ? 1 : 0));
    this.fade = this.gates.map(() => -1);
    const geo = new THREE.TorusGeometry(GATE_VISUAL_RADIUS, 0.9, 10, 72);
    const ldr = !this.app.caps.floatTargets;
    for (const [i, g] of this.gates.entries()) {
      const mat = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: RING_VERT,
        fragmentShader: ATMOSPHERE_GLSL + SKYVIEW_SAMPLE_GLSL + GLOBALS_GLSL + OUTPUT_GLSL + RING_FRAG,
        uniforms: { ...globals, uState: { value: this.states[i] }, uPulse: { value: 0 } },
        defines: ldr ? { LDR_OUTPUT: '' } : {},
      });
      const m = new THREE.Mesh(geo, mat);
      m.position.set(g.x, g.y, g.z);
      // torus lies in the xy plane: face it along the flight direction
      m.lookAt(g.x + g.nx, g.y, g.z + g.nz);
      m.frustumCulled = false;
      m.layers.enable(1);
      this.mats.push(mat);
      this.group.add(m);
    }
    this.app.world.scene.add(this.group);
    if (this.mail) this.say(`The mail for ${STRIPS[this.mail.to].name.split(' ')[0]}. Take off, fly the ${this.gates.length} gates, then land on the ${STRIPS[this.mail.to].name}.`, 'info', 7);
    else this.say(`Fly through all ${this.gates.length} gates. Par ${formatTime(this.par)}.`, 'info', 5);
  }

  override end(): void {
    this.app.world.scene.remove(this.group);
    for (const m of this.mats) m.dispose();
    (this.group.children[0] as THREE.Mesh | undefined)?.geometry.dispose();
  }

  /** Signed distance of p to the gate plane (+ = beyond the gate). */
  private side(g: Gate, p: THREE.Vector3): number {
    return (p.x - g.x) * g.nx + (p.z - g.z) * g.nz;
  }

  override simStep(dt: number): void {
    const ac = this.app.ac;
    const p = ac.pos;
    if (this.result) return;
    if (ac.crashed) {
      this.finish(true);
      return;
    }
    if (this.watch) {
      // past the last gate: over once landed and stopped, given up far from the strip or long after
      if (this.next >= this.gates.length) {
        if (this.watch.step(dt) || (!this.watch.td && (this.watch.distance() > 9000 || this.app.simTime - this.lastGateAt > 300))) this.finish(false);
        return;
      }
      // put down before it (on the way, or back on the runway at the start): over too
      const resting = ac.wheelsOnGround + ac.keelOnGround + ac.keelInWater > 0 && Math.hypot(ac.vel.x, ac.vel.z) < 0.6;
      this.restingFor = resting && this.app.simTime > 20 ? this.restingFor + dt : 0;
      if (this.restingFor > 5) {
        this.finish(false);
        return;
      }
    }
    // check the next gate and the few after it (skipping counts as missing)
    for (let j = this.next; j < Math.min(this.gates.length, this.next + 3); j++) {
      const g = this.gates[j];
      const d0 = this.side(g, this.prev);
      const d1 = this.side(g, p);
      if (d0 < 0 && d1 >= 0) {
        const t = d0 / (d0 - d1);
        const x = this.prev.x + (p.x - this.prev.x) * t;
        const y = this.prev.y + (p.y - this.prev.y) * t;
        const z = this.prev.z + (p.z - this.prev.z) * t;
        const r = Math.hypot(x - g.x, y - g.y, z - g.z);
        if (r <= g.radius) {
          for (let k = this.next; k < j; k++) this.miss(k);
          this.pass(j);
          break;
        } else if (j === this.next && r < g.radius * 6) {
          this.miss(j);
          break;
        }
      }
    }
    this.prev.copy(p);
  }

  private pass(i: number): void {
    const now = this.app.simTime;
    if (this.startTime < 0) this.startTime = now;
    this.states[i] = 2;
    this.fade[i] = 0;
    this.next = i + 1;
    if (i > 0) this.splits.push(now - this.startTime);
    this.app.audio.chime();
    if (this.next < this.gates.length) {
      this.states[this.next] = 1;
      const ghost = (this.gatesPar * i) / (this.gates.length - 1);
      const delta = now - this.startTime - ghost;
      if (i > 0) this.say(`Gate ${i + 1} · ${delta >= 0 ? '+' : '−'}${Math.abs(delta).toFixed(1)} s`, delta <= 0 ? 'good' : 'info', 2);
    } else this.lastGate();
  }


  private miss(i: number): void {
    if (this.startTime < 0) this.startTime = this.app.simTime;
    this.states[i] = 3;
    this.fade[i] = 0;
    this.missed++;
    this.next = i + 1;
    this.say(`Missed gate ${i + 1} · +${this.penalty} s`, 'warn', 2.5);
    this.app.audio.motor(0.25);
    if (this.next < this.gates.length) this.states[this.next] = 1;
    else this.lastGate();
  }

  /** Past the last gate: a ring run is over; a mail run goes on to the landing. */
  private lastGate(): void {
    if (this.watch) {
      this.lastGateAt = this.app.simTime;
      this.say(`Last gate. Land on the ${this.watch.strip.name}.`, 'info', 4);
      return;
    }
    this.finishTime = this.app.simTime;
    this.finish(false);
  }

  private finish(crashed: boolean): void {
    // the clock stopped at the last gate (a mail run: at the touchdown), or runs to now; the gates
    // not flown count as missed
    const time = (this.finishTime > 0 && !crashed ? this.finishTime : this.app.simTime) - Math.max(this.startTime, 0);
    const rings = {
      course: this.course.name,
      time,
      missed: this.missed + this.gates.length - this.next,
      penaltyPerMiss: this.penalty,
      par: this.par,
      gates: this.gates.length,
      crashed,
      crashReason: this.app.ac.crashReason,
      splits: this.splits,
    };
    const r = this.watch ? gradeMail({ rings, landing: this.watch.input() }) : gradeRings(rings);
    // the circuit's best run in this browser: this one, if it beats it
    const seconds = time + rings.missed * this.penalty;
    const isNew = recordRun(this.course.id, { score: r.score, grade: r.grade, seconds, model: this.app.settings.model }, r.success);
    const best = bestRun(this.course.id);
    if (best) r.best = { seconds: best.seconds, grade: best.grade, isNew };
    this.result = r;
  }

  override frame(dt: number): void {
    if (this.watch) this.gearAdvice();
    this.pulse = (this.pulse + dt * 2.2) % (Math.PI * 2);
    this.mats.forEach((m, i) => {
      m.uniforms.uState.value = this.states[i];
      m.uniforms.uPulse.value = 0.5 + 0.5 * Math.sin(this.pulse);
      // passed/missed gates flare briefly, then shrink away
      const mesh = this.group.children[i];
      if (this.fade[i] >= 0) {
        this.fade[i] += dt;
        const k = Math.max(0, 1 - this.fade[i] / 0.7);
        mesh.scale.setScalar(this.states[i] === 2 ? 1 + 0.35 * (1 - k) : 1);
        mesh.visible = k > 0;
        m.uniforms.uPulse.value = k;
      }
    });
  }

  hud(): ModeHud {
    const now = this.app.simTime;
    const elapsed = this.startTime < 0 ? 0 : (this.finishTime > 0 ? this.finishTime : now) - this.startTime;
    const landing = !!this.watch && this.next >= this.gates.length;
    const h: ModeHud = {
      title: `Ring run · ${this.course.name}`,
      timer: formatTime(elapsed + this.missed * this.penalty),
      timerSub: landing ? `Land on ${this.watch!.strip.name.split(' ')[0]}${this.missed ? ` · ${this.missed} missed` : ''}` : `Gate ${Math.min(this.next + 1, this.gates.length)} / ${this.gates.length}${this.missed ? ` · ${this.missed} missed` : ''}`,
      map: { gates: this.gates, gateStates: this.states, strip: this.mail?.to },
      ...this.currentPrompt(),
    };
    const g = this.gates[this.next];
    if (g && !this.result) h.target = { label: `${this.next + 1}`, ...this.aim(g.x, g.y, g.z) };
    if (landing && !this.result) Object.assign(h, this.watch!.hud(this.aimAt));
    return h;
  }
}

// ---------------------------------------------------------------- landing

/**
 * Watches a landing on strip `index`, along its heading: the touchdown, bounces after it, and the end
 * (stopped on the ground, or climbing away after touching down). Its hud() guides the approach. Used
 * by the landing mode and at the end of a mail run.
 */
class LandingWatch {
  readonly strip: StripDef;
  readonly aimDist: number;
  td: Touchdown | null = null;
  private bounces = 0;
  private airborneSince = -1;
  private stoppedFor = 0;
  private tdAlong = 0;

  constructor(private readonly app: App, readonly index: number) {
    this.strip = STRIPS[index];
    this.aimDist = landingAim(this.strip);
  }

  /** A touchdown: the first is the landing (what to say about it is returned), later ones after a hop are bounces. */
  touchdown(t: Touchdown): { text: string; tone: 'info' | 'warn' | 'good' } | null {
    let said: { text: string; tone: 'info' | 'warn' | 'good' } | null = null;
    if (!this.td) {
      this.td = t;
      this.tdAlong = runwayLocal(this.index, t.x, t.z).along;
      const fpm = Math.round(t.sinkRate * 196.85);
      said = { text: `Touchdown ${fpm} fpm`, tone: fpm < 350 ? 'good' : fpm < 700 ? 'info' : 'warn' };
    } else if (this.airborneSince >= 0 && this.app.simTime - this.airborneSince > 0.25) {
      this.bounces++;
    }
    this.airborneSince = -1;
    return said;
  }

  /** After the touchdown: true once the landing is over (stopped, or climbing away above 60 m). */
  step(dt: number): boolean {
    if (!this.td) return false;
    const ac = this.app.ac;
    const contact = ac.wheelsOnGround + ac.keelOnGround + ac.keelInWater > 0;
    if (!contact && this.airborneSince < 0) this.airborneSince = this.app.simTime;
    if (contact && Math.hypot(ac.vel.x, ac.vel.z) < 0.6) this.stoppedFor += dt;
    else this.stoppedFor = 0;
    return this.stoppedFor > 1.5 || (!contact && this.app.telemetry.agl > 60);
  }

  /** The distance (m) from the aircraft to the strip's center. */
  distance(): number {
    const p = this.app.ac.pos;
    return Math.hypot(p.x - this.strip.center[0], p.z - this.strip.center[1]);
  }

  input(): LandingInput {
    const ac = this.app.ac;
    const td = this.td;
    const s = this.strip;
    const thrAlong = -s.halfLength;
    const tdLocal = td ? runwayLocal(this.index, td.x, td.z) : { along: thrAlong - 1000, across: 0 };
    const fin = runwayLocal(this.index, ac.pos.x, ac.pos.z);
    const stopped = !!td && !ac.crashed && Math.abs(fin.along) <= s.halfLength && Math.abs(fin.across) <= s.halfWidth + 2 && Math.hypot(ac.vel.x, ac.vel.z) < 0.6;
    return {
      strip: s.name,
      sinkRate: td?.sinkRate ?? 0,
      centreline: tdLocal.across,
      pastThreshold: tdLocal.along - thrAlong,
      aim: this.aimDist,
      runwayLength: s.halfLength * 2,
      bank: td?.bank ?? 0,
      bounces: this.bounces,
      stoppedOnRunway: stopped,
      crashed: ac.crashed || !td,
      crashReason: ac.crashed ? ac.crashReason : !td ? 'Did not land' : '',
      gearDown: td?.gearDown ?? true,
      onRunway: td?.onRunway ?? false,
      rollout: td ? fin.along - this.tdAlong : 0,
    };
  }

  /** Until the touchdown: the approach guide (threshold, glide path, centerline) and the aim point. */
  hud(aim: GameMode['aimAt']): Pick<ModeHud, 'landing' | 'target'> {
    if (this.td) return {};
    const ac = this.app.ac;
    const s = this.strip;
    const local = runwayLocal(this.index, ac.pos.x, ac.pos.z);
    const thrAlong = -s.halfLength;
    const aimAlong = thrAlong + this.aimDist;
    const distAim = aimAlong - local.along;
    const want = s.elevation + LANDING_GLIDE.wheels + Math.max(distAim, 0) * Math.tan((LANDING_GLIDE.angle * Math.PI) / 180);
    const d = headingDir(s.heading);
    return {
      landing: { dist: thrAlong - local.along, glideDev: ac.pos.y - want, centreDev: local.across, targetKt: 58 },
      target: { label: 'AIM', ...aim(s.center[0] + d[0] * aimAlong, s.elevation + 1, s.center[1] + d[1] * aimAlong) },
    };
  }
}

/** A final approach to an airstrip (picked at random by App.startSession), graded on the touchdown. */
export class Landing extends GameMode {
  readonly kind = 'landing' as const;
  /** the strip (index into STRIPS), landed on along its heading */
  readonly index = this.app.startStrip;
  readonly strip = STRIPS[this.index];
  private readonly watch = new LandingWatch(this.app, this.index);

  begin(): void {
    this.app.startFlight('approach');
    this.app.controls.reset(0.42, true, 1);
    this.app.ac.onTouchdown = (t) => {
      const said = this.watch.touchdown(t);
      if (said) this.say(said.text, said.tone, 3);
    };
    this.say(`Land on the ${this.strip.name} ahead. Gear down, flaps as needed, aim for the markers.`, 'info', 7);
  }

  override simStep(dt: number): void {
    if (this.result) return;
    // over when stopped or crashed; given up when far away or after a long time without landing
    if (this.app.ac.crashed || this.watch.step(dt) || (!this.watch.td && (this.watch.distance() > 9000 || this.app.simTime > 420))) {
      this.result = gradeLanding(this.watch.input());
    }
  }

  override frame(): void {
    this.gearAdvice();
  }

  hud(): ModeHud {
    return { title: 'Landing', ...this.watch.hud(this.aimAt), map: { strip: this.index }, ...this.currentPrompt() };
  }
}

// ---------------------------------------------------------------- attract (menu background)

/** The autopilot tours the fjord while the menu is open; the cinematic camera does the rest. */
export class AttractFlight extends GameMode {
  readonly kind = 'attract' as const;
  private readonly ap = new Autopilot();
  private readonly route = buildCourse();
  private next = 1;
  private dir = 1;
  private readonly inp: PilotInput = { pitch: 0, roll: 0, yaw: 0, throttle: 0.6, brake: 0, flapNotch: 0, gearDown: false, trim: 0 };

  begin(): void {
    const a = this.route[0];
    const b = this.route[1];
    const hdg = (Math.atan2(b.x - a.x, -(b.z - a.z)) * 180) / Math.PI;
    this.app.ac.reset(a.x, a.y + 230, a.z, hdg, 46);
    this.app.inputOverride = this.inp;
    this.app.startFlightAt();
  }

  override simStep(): void {
    const ac = this.app.ac;
    if (ac.crashed) {
      this.begin();
      return;
    }
    const g = this.route[this.next];
    const d = Math.hypot(g.x - ac.pos.x, g.z - ac.pos.z);
    if (d < 160) {
      if (this.next + this.dir < 0 || this.next + this.dir >= this.route.length) this.dir = -this.dir;
      this.next += this.dir;
    }
    const t = this.route[this.next];
    const hdg = (Math.atan2(t.x - ac.pos.x, -(t.z - ac.pos.z)) * 180) / Math.PI;
    this.ap.update(ac, { heading: (hdg + 360) % 360, altitude: t.y + 230, speed: 45, maxBank: 22 }, this.app.telemetry.ias || 45, 1 / 120, this.inp);
  }

  hud(): ModeHud {
    return { title: '' };
  }
}

export function createMode(app: App, kind: ModeKind, start: StartPoint = 'runway'): GameMode {
  if (kind === 'attract') return new AttractFlight(app);
  if (kind === 'rings') return new RingRun(app);
  if (kind === 'landing') return new Landing(app);
  return new FreeFlight(app, start);
}
