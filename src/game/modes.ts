// Game modes: free flight, the fjord ring run and the graded mountain landing.
import * as THREE from 'three';
import type { App, StartPoint } from '../app.ts';
import { buildCourse, coursePar, type Gate } from './course.ts';
import { gradeLanding, gradeRings, formatTime, type ModeResult } from './grading.ts';
import type { Touchdown } from '../sim/aircraft.ts';
import { STRIPS, headingDir } from '../world/params.ts';
import { runwayLocal } from '../sim/environment.ts';
import { globals } from '../render/globals.ts';
import { ATMOSPHERE_GLSL, SKYVIEW_SAMPLE_GLSL } from '../render/atmosphere.ts';
import { GLOBALS_GLSL } from '../render/globals.ts';
import { OUTPUT_GLSL } from '../render/post.ts';

export type ModeKind = 'free' | 'rings' | 'landing';

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
    this.say(this.start === 'water' ? 'Gear is up for the water. R to add power.' : this.start === 'runway' ? 'Hold R for power, S to lift off around 60 kt.' : 'Free flight. C changes the camera.', 'info', 6);
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
        grade: 'F',
        headline: 'Crashed',
        subtitle: ac.crashReason,
        success: false,
        metrics: [
          { label: 'Flight time', value: formatTime(this.app.simTime), score: 1 },
          { label: 'Airspeed at impact', value: `${Math.round(this.app.telemetry.ias * 1.944)} kt`, score: 0 },
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
  #include <logdepthbuf_vertex>
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

export class RingRun extends GameMode {
  readonly kind = 'rings' as const;
  readonly gates: Gate[] = buildCourse();
  readonly par = coursePar(this.gates);
  readonly penalty = 5;
  next = 0;
  missed = 0;
  startTime = -1;
  finishTime = -1;
  splits: number[] = [];
  private readonly group = new THREE.Group();
  private readonly mats: THREE.ShaderMaterial[] = [];
  private readonly prev = new THREE.Vector3();
  private states: number[] = [];
  private pulse = 0;
  /** seconds since each gate was passed or missed (drives the fade-out) */
  private fade: number[] = [];

  begin(): void {
    const g0 = this.gates[0];
    const ac = this.app.ac;
    const back = 1500;
    const hdg = (Math.atan2(g0.nx, -g0.nz) * 180) / Math.PI;
    ac.reset(g0.x - g0.nx * back, g0.y + 10, g0.z - g0.nz * back, hdg, 47);
    this.app.controls.reset(0.72, false, 0);
    this.app.startFlightAt();
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
    this.say(`Fly through all ${this.gates.length} gates. Par ${formatTime(this.par)}.`, 'info', 5);
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

  override simStep(): void {
    const ac = this.app.ac;
    const p = ac.pos;
    if (this.result) return;
    if (ac.crashed) {
      this.finish(true);
      return;
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
      const ghost = (this.par * i) / (this.gates.length - 1);
      const delta = now - this.startTime - ghost;
      if (i > 0) this.say(`Gate ${i + 1} · ${delta >= 0 ? '+' : '−'}${Math.abs(delta).toFixed(1)} s`, delta <= 0 ? 'good' : 'info', 2);
    } else {
      this.finishTime = now;
      this.finish(false);
    }
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
    else {
      this.finishTime = this.app.simTime;
      this.finish(false);
    }
  }

  private finish(crashed: boolean): void {
    const time = crashed ? this.app.simTime - Math.max(this.startTime, 0) : this.finishTime - this.startTime;
    this.result = gradeRings({
      time,
      missed: this.missed + (crashed ? this.gates.length - this.next : 0),
      penaltyPerMiss: this.penalty,
      par: this.par,
      gates: this.gates.length,
      crashed,
      crashReason: this.app.ac.crashReason,
      splits: this.splits,
    });
  }

  override frame(dt: number): void {
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
    const h: ModeHud = {
      title: 'Ring run',
      timer: formatTime(elapsed + this.missed * this.penalty),
      timerSub: `Gate ${Math.min(this.next + 1, this.gates.length)} / ${this.gates.length}${this.missed ? ` · ${this.missed} missed` : ''}`,
      ...this.currentPrompt(),
    };
    const g = this.gates[this.next];
    if (g && !this.result) h.target = { label: `${this.next + 1}`, ...this.aim(g.x, g.y, g.z) };
    return h;
  }
}

// ---------------------------------------------------------------- mountain landing

export class MountainLanding extends GameMode {
  readonly kind = 'landing' as const;
  readonly strip = STRIPS[1];
  readonly aimDist = 60;
  private td: Touchdown | null = null;
  private bounces = 0;
  private airborneSince = -1;
  private stoppedFor = 0;
  private tdAlong = 0;
  private maxAlong = -1e9;

  begin(): void {
    this.app.startFlight('mountain-approach');
    this.app.controls.reset(0.42, true, 1);
    this.app.ac.onTouchdown = (t) => {
      if (!this.td) {
        this.td = t;
        this.tdAlong = runwayLocal(1, t.x, t.z).along;
        const fpm = Math.round(t.sinkRate * 196.85);
        this.say(`Touchdown ${fpm} fpm`, fpm < 350 ? 'good' : fpm < 700 ? 'info' : 'warn', 3);
      } else if (this.airborneSince >= 0 && this.app.simTime - this.airborneSince > 0.25) {
        this.bounces++;
      }
      this.airborneSince = -1;
    };
    this.say('Land on the Hestskar strip ahead. Gear down, flaps as needed, aim for the markers.', 'info', 7);
  }

  override simStep(dt: number): void {
    if (this.result) return;
    const ac = this.app.ac;
    const t = this.app.telemetry;
    if (ac.crashed) {
      this.finish();
      return;
    }
    if (this.td) {
      const contact = ac.wheelsOnGround + ac.keelOnGround + ac.keelInWater > 0;
      if (!contact && this.airborneSince < 0) this.airborneSince = this.app.simTime;
      const local = runwayLocal(1, ac.pos.x, ac.pos.z);
      this.maxAlong = Math.max(this.maxAlong, local.along);
      if (contact && Math.hypot(ac.vel.x, ac.vel.z) < 0.6) this.stoppedFor += dt;
      else this.stoppedFor = 0;
      if (this.stoppedFor > 1.5) this.finish();
      // a go-around after touchdown: climbing away above 60 m resets nothing but ends badly
      if (!contact && t.agl > 60) this.finish();
    } else {
      // gave up: far away or long time
      const d = Math.hypot(ac.pos.x - this.strip.center[0], ac.pos.z - this.strip.center[1]);
      if (d > 9000 || this.app.simTime > 420) this.finish();
    }
  }

  private finish(): void {
    const ac = this.app.ac;
    const td = this.td;
    const thrAlong = -this.strip.halfLength;
    const tdLocal = td ? runwayLocal(1, td.x, td.z) : { along: thrAlong - 1000, across: 0 };
    const fin = runwayLocal(1, ac.pos.x, ac.pos.z);
    const stopped = !!td && !ac.crashed && Math.abs(fin.along) <= this.strip.halfLength && Math.abs(fin.across) <= this.strip.halfWidth + 2 && Math.hypot(ac.vel.x, ac.vel.z) < 0.6;
    this.result = gradeLanding({
      sinkRate: td?.sinkRate ?? 0,
      centreline: tdLocal.across,
      pastThreshold: tdLocal.along - thrAlong,
      aim: this.aimDist,
      runwayLength: this.strip.halfLength * 2,
      bank: td?.bank ?? 0,
      bounces: this.bounces,
      stoppedOnRunway: stopped,
      crashed: ac.crashed || !td,
      crashReason: ac.crashed ? ac.crashReason : !td ? 'Did not land' : '',
      gearDown: td?.gearDown ?? true,
      onRunway: td?.onRunway ?? false,
      rollout: td ? fin.along - this.tdAlong : 0,
    });
  }

  override frame(): void {
    this.gearAdvice();
  }

  hud(): ModeHud {
    const ac = this.app.ac;
    const s = this.strip;
    const local = runwayLocal(1, ac.pos.x, ac.pos.z);
    const thrAlong = -s.halfLength;
    const toThr = thrAlong - local.along;
    const aimAlong = thrAlong + this.aimDist;
    const distAim = aimAlong - local.along;
    // 4° glide path to the aim point
    const want = s.elevation + 2.4 + Math.max(distAim, 0) * Math.tan((4 * Math.PI) / 180);
    const d = headingDir(s.heading);
    const thx = s.center[0] + d[0] * aimAlong;
    const thz = s.center[1] + d[1] * aimAlong;
    return {
      title: 'Mountain landing',
      landing: this.td ? undefined : { dist: toThr, glideDev: ac.pos.y - want, centreDev: local.across, targetKt: 58 },
      target: this.td ? undefined : { label: 'AIM', ...this.aim(thx, s.elevation + 1, thz) },
      ...this.currentPrompt(),
    };
  }
}

export function createMode(app: App, kind: ModeKind, start: StartPoint = 'runway'): GameMode {
  if (kind === 'rings') return new RingRun(app);
  if (kind === 'landing') return new MountainLanding(app);
  return new FreeFlight(app, start);
}
