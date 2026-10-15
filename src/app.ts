// Application: owns the world, the aircraft and the loop. The flight model runs at a fixed 120 Hz;
// rendering interpolates between the last two physics states.
import * as THREE from 'three';
import { WorldRenderer } from './render/worldRenderer.ts';
import type { Capabilities } from './render/capabilities.ts';
import type { QualityName } from './render/quality.ts';
import { installDebugHooks } from './debug/hooks.ts';
import { TIME_PRESETS, type TimePreset, elevationDeg } from './world/celestial.ts';
import { Aircraft, type FlightModel, type PilotInput, type Telemetry } from './sim/aircraft.ts';
import { WorldEnv } from './sim/environment.ts';
import { SIM_DT, runwayEnd } from './sim/scenarios.ts';
import { Controls, type Action } from './input/controls.ts';
import { CameraRig, type CameraMode } from './camera/cameras.ts';
import { PlaneModel } from './plane/planeMesh.ts';
import { PlaneShadow } from './render/planeShadow.ts';
import { Strips } from './render/strips.ts';
import { SoundEngine } from './audio/audio.ts';
import { globals } from './render/globals.ts';
import { drawnHeight, makeClipState } from './world/clipmap.ts';
import { AIRCRAFT } from './sim/config.ts';
import { STRIPS, SEA_LEVEL } from './world/params.ts';
import { createMode, type GameMode, type ModeKind } from './game/modes.ts';
import type { ModeResult } from './game/grading.ts';

export type StartPoint = 'runway' | 'water' | 'air' | 'mountain-approach' | 'rings';

export interface FlightSettings {
  model: FlightModel;
  timeOfDay: number;
  /** game minutes per real second (0 = frozen) */
  timeFlow: number;
  windFrom: number;
  windSpeed: number;
  clouds: number;
  volume: number;
}

export type AppState = 'menu' | 'flying' | 'paused' | 'results';

const tmpV = new THREE.Vector3();

export class App {
  readonly world: WorldRenderer;
  readonly ac = new Aircraft();
  readonly env: WorldEnv;
  readonly controls = new Controls();
  readonly rig: CameraRig;
  readonly plane: PlaneModel;
  readonly strips: Strips;
  readonly shadow = new PlaneShadow(512);
  readonly audio = new SoundEngine();
  state: AppState = 'flying';
  settings: FlightSettings = { model: 'assisted', timeOfDay: TIME_PRESETS.dusk, timeFlow: 0.5, windFrom: 40, windSpeed: 4, clouds: 0.45, volume: 0.7 };
  lampOn = false;
  hudVisible = true;
  /** when set, replaces keyboard input (tests) */
  inputOverride: PilotInput | null = null;
  /** free camera for debug screenshots */
  freeCamera = false;
  telemetry: Telemetry = {} as Telemetry;
  frames = 0;
  fixedDt: number | null = null;
  paused = false;
  simTime = 0;
  private acc = 0;
  private last = performance.now();
  private readonly prevPos = new THREE.Vector3();
  private readonly prevQuat = new THREE.Quaternion();
  private readonly drawPos = new THREE.Vector3();
  private readonly drawQuat = new THREE.Quaternion();
  private mouseDown = false;
  /** current game mode */
  session: GameMode | null = null;
  sessionKind: ModeKind = 'free';
  sessionStart: StartPoint = 'runway';
  /** called once when a session produces its result */
  onResult: ((r: ModeResult) => void) | null = null;
  /** observers (HUD) */
  onFrame: ((dt: number) => void)[] = [];
  onSimStep: ((dt: number) => void)[] = [];
  onActionHooks: ((a: Action) => void)[] = [];

  constructor(readonly canvas: HTMLCanvasElement, readonly caps: Capabilities) {
    const q = new URLSearchParams(location.search);
    const quality = (q.get('q') as QualityName) ?? 'high';
    this.world = new WorldRenderer(canvas, caps, ['low', 'medium', 'high'].includes(quality) ? quality : 'high');
    this.env = new WorldEnv(this.world.terrain.cfg);
    const ldr = !caps.floatTargets;
    this.plane = new PlaneModel(ldr);
    this.world.scene.add(this.plane.root);
    this.strips = new Strips(ldr);
    this.world.scene.add(this.strips.group);
    this.rig = new CameraRig(this.world.camera, {
      groundAt: (x, z) => Math.max(drawnHeight(x, z, this.world.clip), SEA_LEVEL + 0.5),
    });
    this.world.onBeforeScene = (r) => {
      const keySun = globals.uKeyIsSun.value > 0.5;
      this.shadow.render(r, this.plane.root, keySun ? globals.uSunDir.value : globals.uMoonDir.value, true);
    };
    const t = q.get('t');
    if (t) this.settings.timeOfDay = t in TIME_PRESETS ? TIME_PRESETS[t as TimePreset] : Number(t);
    if (q.get('model')) this.settings.model = q.get('model') as FlightModel;
    this.applySettings();

    // wire aircraft events to sound
    this.ac.onImpact = (kind, speed) => {
      if (kind === 'wheel') this.audio.thump(speed);
      else if (kind === 'water') this.audio.splash(speed);
      else this.audio.scrape();
    };
    this.ac.onCrash = () => this.audio.crash();
    this.controls.onAction((a) => this.onAction(a));

    canvas.addEventListener('pointerdown', (e) => {
      this.mouseDown = true;
      canvas.setPointerCapture(e.pointerId);
      this.audio.start();
    });
    canvas.addEventListener('pointerup', () => (this.mouseDown = false));
    canvas.addEventListener('pointermove', (e) => {
      if (this.mouseDown) this.rig.look(e.movementX, e.movementY);
    });
    addEventListener('keydown', () => this.audio.start(), { once: true });

    new ResizeObserver(() => this.onResize()).observe(canvas.parentElement!);
    this.onResize();

    const cam = q.get('cam');
    if (cam) {
      const c = cam.split(',').map(Number);
      this.setFreeCamera(c[0], c[1], c[2], c[3], c[4], c[5] ?? 60);
    }
    this.startSession((q.get('mode') as ModeKind) ?? 'free', (q.get('start') as StartPoint) ?? 'runway');
    if (q.has('debug')) installDebugHooks(this);
    requestAnimationFrame(this.loop);
  }

  applySettings(): void {
    const s = this.settings;
    this.world.timeOfDay = ((s.timeOfDay % 24) + 24) % 24;
    this.ac.model = s.model;
    this.env.setWind(s.windFrom, s.windSpeed);
    this.world.water.setWind(this.env.baseWind.x, this.env.baseWind.z);
    globals.uWind.value.copy(this.env.baseWind);
    globals.uCloudCover.value = s.clouds;
    this.audio.setVolume(s.volume);
    this.controls.responsiveness = s.model === 'arcade' ? 1.4 : 1;
  }

  /** Centres the drawn surface on the aircraft (after a teleport, before the camera catches up). */
  private recentreSurface(): void {
    this.world.clip = makeClipState(this.world.terrain.cfg, this.ac.pos.x, this.ac.pos.z);
    this.env.clip = this.world.clip;
  }

  /** Puts the aircraft at a start point. */
  startFlight(start: StartPoint): void {
    const ac = this.ac;
    this.env.follow(0, 0);
    if (start === 'runway') {
      const p = runwayEnd(0, 25);
      this.env.follow(p.x, p.z);
      ac.reset(p.x, drawnHeight(p.x, p.z, this.env.clip) + 2.42, p.z, p.heading, 0);
      this.controls.reset(0, true, 1);
    } else if (start === 'water') {
      ac.reset(2600, SEA_LEVEL + 1.85, 2350, 95, 0);
      this.controls.reset(0, false, 1);
    } else if (start === 'mountain-approach') {
      const s = STRIPS[1];
      const d = [Math.sin((s.heading * Math.PI) / 180), -Math.cos((s.heading * Math.PI) / 180)];
      const dist = 4200;
      const x = s.center[0] - d[0] * (s.halfLength + dist);
      const z = s.center[1] - d[1] * (s.halfLength + dist);
      ac.reset(x, s.elevation + 330, z, s.heading, 36);
      this.controls.reset(0.5, true, 1);
    } else {
      ac.reset(-6000, 420, 2300, 80, 45);
      this.controls.reset(0.62, true, 0);
    }
    ac.model = this.settings.model;
    this.prevPos.copy(ac.pos);
    this.prevQuat.copy(ac.q);
    this.acc = 0;
    this.simTime = 0;
    ac.time = 0;
    ac.crashed = false;
    ac.engineOn = true;
    this.lampOn = this.isDark();
    this.rig.snap();
    this.recentreSurface();
  }

  /** Starts (or restarts) a game mode. */
  startSession(kind: ModeKind, start: StartPoint = this.sessionStart): void {
    this.session?.end();
    this.inputOverride = null;
    this.sessionKind = kind;
    this.sessionStart = start;
    this.ac.onTouchdown = null;
    this.session = createMode(this, kind, start);
    this.session.begin();
    this.state = 'flying';
  }

  restartSession(): void {
    this.startSession(this.sessionKind, this.sessionStart);
  }

  /** Resets interpolation and clocks after the aircraft was placed externally. */
  startFlightAt(): void {
    this.prevPos.copy(this.ac.pos);
    this.prevQuat.copy(this.ac.q);
    this.acc = 0;
    this.simTime = 0;
    this.ac.time = 0;
    this.lampOn = this.isDark();
    this.ac.model = this.settings.model;
    this.state = 'flying';
    this.rig.snap();
    this.recentreSurface();
  }

  isDark(): boolean {
    return elevationDeg(globals.uSunDir.value) < -3;
  }

  setFreeCamera(x: number, y: number, z: number, yawDeg: number, pitchDeg: number, fov = 60): void {
    this.freeCamera = true;
    const c = this.world.camera;
    c.position.set(x, y, z);
    c.rotation.set(THREE.MathUtils.degToRad(pitchDeg), -THREE.MathUtils.degToRad(yawDeg), 0, 'YXZ');
    c.up.set(0, 1, 0);
    c.fov = fov;
    c.near = 0.25;
    c.updateProjectionMatrix();
    this.world.trees.prefill(x, z);
  }

  setCameraMode(m: CameraMode): void {
    this.freeCamera = false;
    this.rig.setMode(m);
  }

  private onAction(a: Action): void {
    for (const h of this.onActionHooks) h(a);
    if (this.state !== 'flying') return;
    if (a === 'camera') {
      this.freeCamera = false;
      this.rig.cycle();
    } else if (a === 'camChase') this.setCameraMode('chase');
    else if (a === 'camCockpit') this.setCameraMode('cockpit');
    else if (a === 'camCinematic') this.setCameraMode('cinematic');
    else if (a === 'light') {
      this.lampOn = !this.lampOn;
      this.audio.click();
    } else if (a === 'hud') this.hudVisible = !this.hudVisible;
    else if (a === 'gear') this.audio.motor(4);
    else if (a === 'flapsDown' || a === 'flapsUp') this.audio.motor(1.2);
    else if (a === 'fullscreen') void toggleFullscreen();
  }

  private onResize(): void {
    const el = this.canvas.parentElement!;
    this.world.resize(el.clientWidth, el.clientHeight);
  }

  /** Steps the flight model once (fixed dt). */
  stepSim(): void {
    this.prevPos.copy(this.ac.pos);
    this.prevQuat.copy(this.ac.q);
    // the sim sees the surface that was drawn last frame
    this.env.clip = this.world.clip;
    const input = this.inputOverride ?? this.controls.input;
    this.ac.step(SIM_DT, input, this.env);
    this.simTime += SIM_DT;
    this.session?.simStep(SIM_DT);
    for (const f of this.onSimStep) f(SIM_DT);
  }

  private loop = (now: number): void => {
    requestAnimationFrame(this.loop);
    const realDt = Math.min((now - this.last) / 1000, 0.1);
    this.last = now;
    if (this.paused) return;
    const dt = this.fixedDt ?? realDt;
    this.frame(dt, realDt);
  };

  /** One frame: input, physics catch-up, camera, render. */
  frame(dt: number, realDt = dt): void {
    const flying = this.state === 'flying';
    this.controls.enabled = flying && !this.inputOverride;
    this.controls.update(dt);
    if (flying) {
      this.acc += Math.min(dt, 0.25);
      while (this.acc >= SIM_DT) {
        this.stepSim();
        this.acc -= SIM_DT;
      }
      // time of day flows slowly
      this.world.timeOfDay = (this.world.timeOfDay + (this.settings.timeFlow * dt) / 60 + 24) % 24;
      this.settings.timeOfDay = this.world.timeOfDay;
    }
    const alpha = flying ? this.acc / SIM_DT : 1;
    this.drawPos.lerpVectors(this.prevPos, this.ac.pos, alpha);
    this.drawQuat.slerpQuaternions(this.prevQuat, this.ac.q, alpha);
    this.world.waveTime = this.simTime + this.acc;
    this.telemetry = this.ac.telemetry(this.env, this.telemetry);

    const cockpit = !this.freeCamera && this.rig.mode === 'cockpit';
    this.plane.update(this.ac, this.drawPos, this.drawQuat, dt, this.telemetry, this.lampOn, cockpit);
    if (!this.freeCamera) this.rig.update(dt, { pos: this.drawPos, quat: this.drawQuat, vel: this.ac.vel });
    // landing light
    const lamp = tmpV.set(AIRCRAFT.lamp[0], AIRCRAFT.lamp[1], AIRCRAFT.lamp[2]).applyQuaternion(this.drawQuat).add(this.drawPos);
    globals.uLampPos.value.set(lamp.x, lamp.y, lamp.z, this.lampOn ? globals.uExposure.value * 1.8 : 0);
    const ld = new THREE.Vector3(0, -0.07, -1).normalize().applyQuaternion(this.drawQuat);
    globals.uLampDir.value.set(ld.x, ld.y, ld.z, Math.cos(THREE.MathUtils.degToRad(13)));

    this.session?.frame(dt);
    if (flying && this.session?.result) {
      this.state = 'results';
      this.onResult?.(this.session.result);
    }
    for (const f of this.onFrame) f(dt);
    this.world.render(dt);
    this.strips.update(this.env.baseWind, globals.uExposure.value, this.simTime, this.isDark() ? 1 : 0.2);
    this.audio.update({
      rpm: this.ac.rpm,
      throttle: this.ac.throttle,
      airspeed: this.telemetry.tas,
      stall: this.telemetry.stallWarning && flying,
      cockpit,
      onWater: this.telemetry.onWater,
      onGround: this.telemetry.onGround,
      groundSpeed: this.telemetry.groundSpeed,
    });
    this.frames++;
    if (this.world.scaler.update(realDt * 1000, realDt)) this.onResize();
  }
}

export async function toggleFullscreen(): Promise<void> {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {
    // ignored: fullscreen can be refused (iframes, user settings)
  }
}
