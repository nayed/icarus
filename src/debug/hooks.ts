// window.__icarus: test/debug API used by the Playwright scripts (enabled with ?debug).
import * as THREE from 'three';
import type { App } from '../app.ts';
import { terrainHeight } from '../world/terrain.ts';
import { drawnHeight, vertexHeight, octavesForSpacing } from '../world/clipmap.ts';
import { terrainVertexShader, terrainPrefix } from '../render/terrainMesh.ts';
import { globals } from '../render/globals.ts';
import { FullscreenPass, passMaterial } from '../render/fullscreen.ts';
import { TERRAIN_OCTAVES, STRIPS } from '../world/params.ts';
import type { StartPoint, FlightSettings } from '../app.ts';
import type { CameraMode } from '../camera/cameras.ts';
import type { FlightModel, PilotInput } from '../sim/aircraft.ts';
import * as scenarios from '../sim/scenarios.ts';
import { SIM_DT } from '../sim/scenarios.ts';
import { Autopilot } from '../sim/autopilot.ts';

export interface ParityStats {
  count: number;
  maxErr: number;
  meanErr: number;
  worst: [number, number, number, number];
}

export function installDebugHooks(app: App): void {
  const w = app.world;
  let autolandHook: ((dt: number) => void) | null = null;
  let autoland: scenarios.ApproachController | null = null;
  const overrides = new Map<string, number | number[] | null>();
  w.onBeforeRender = () => {
    for (const [k, v] of overrides) {
      const u = (globals as Record<string, { value: unknown }>)[k];
      if (!u || v === null) continue;
      if (typeof v === 'number') u.value = v;
      else (u.value as { fromArray(a: number[]): void }).fromArray(v);
    }
  };
  const api = {
    get ready() {
      return app.frames > 2;
    },
    get frame() {
      return app.frames;
    },
    caps: app.caps,
    setTime(h: number) {
      app.settings.timeOfDay = h;
      w.timeOfDay = h;
    },
    setCamera(x: number, y: number, z: number, yaw: number, pitch: number, fov = 60) {
      app.setFreeCamera(x, y, z, yaw, pitch, fov);
    },
    setCameraMode(m: CameraMode) {
      app.setCameraMode(m);
    },
    /** Game sessions: 'free' | 'rings' | 'landing'. */
    session: {
      start(kind: 'free' | 'rings' | 'landing', start: StartPoint = 'runway', model?: FlightModel) {
        if (model) {
          app.settings.model = model;
          app.applySettings();
        }
        app.startSession(kind, start);
      },
      hud: () => app.session?.hud() ?? null,
      result: () => app.session?.result ?? null,
      state: () => app.state,
      gates: () => (app.session && 'gates' in app.session ? (app.session as unknown as { gates: unknown[] }).gates : null),
      /** Fly the ring course with the autopilot (input override), gate by gate. */
      autoRings(cutCorner = 0) {
        const mode = app.session as unknown as { gates: { x: number; y: number; z: number; nx: number; nz: number }[]; next: number };
        const ap = new Autopilot();
        const inp = { ...app.controls.input, gearDown: false, flapNotch: 0 };
        app.inputOverride = inp;
        const hook = () => {
          const g = mode.gates[Math.min(mode.next, mode.gates.length - 1)];
          // line following onto the gate's axis (offset sideways by cutCorner to test misses)
          const cx = g.x - g.nz * cutCorner;
          const cz = g.z + g.nx * cutCorner;
          const rx = app.ac.pos.x - cx;
          const rz = app.ac.pos.z - cz;
          const along = -(rx * g.nx + rz * g.nz);
          const cross = rx * -g.nz + rz * g.nx; // + right of the line
          const look = Math.max(140, along * 0.35);
          const gateHdg = (Math.atan2(g.nx, -g.nz) * 180) / Math.PI;
          const corr = THREE.MathUtils.clamp((Math.atan2(cross, look) * 180) / Math.PI, -65, 65);
          const hdg = (gateHdg - corr + 720) % 360;
          ap.update(app.ac, { heading: hdg, altitude: g.y, speed: 46, maxBank: 45 }, app.telemetry.ias, SIM_DT, inp);
        };
        app.onSimStep.push(hook);
        return true;
      },
      /** Land on the mountain strip with the autopilot; `hard` drives it in with a high sink rate. */
      autoLanding(hard = false) {
        const c = new scenarios.ApproachController(STRIPS[1], false, 70);
        const inp = { ...app.controls.input, flapNotch: 2, gearDown: true, brake: 0 };
        app.inputOverride = inp;
        const prevTd = app.ac.onTouchdown;
        app.ac.onTouchdown = (t) => {
          prevTd?.(t);
          c.onTouchdown(t);
        };
        app.onSimStep.push(() => {
          c.update(app.ac, app.env, inp, SIM_DT);
          if (hard && c.phase === 'flare') {
            inp.pitch = -0.15;
            inp.throttle = 0;
          }
        });
        return true;
      },
    },
    flight: {
      start(p: StartPoint, model?: FlightModel) {
        if (model) {
          app.settings.model = model;
          app.applySettings();
        }
        app.startFlight(p);
        app.state = 'flying';
      },
      settings(s: Partial<FlightSettings>) {
        Object.assign(app.settings, s);
        app.applySettings();
      },
      /** Override the pilot input (null = back to the keyboard). */
      input(i: Partial<PilotInput> | null) {
        if (i === null) app.inputOverride = null;
        else app.inputOverride = { ...(app.inputOverride ?? { ...app.controls.input }), ...i };
      },
      keyboardInput: () => ({ ...app.controls.input }),
      state() {
        const t = app.telemetry;
        return { ...t, x: app.ac.pos.x, y: app.ac.pos.y, z: app.ac.pos.z, time: app.simTime, model: app.ac.model, lamp: app.lampOn, camera: app.rig.mode };
      },
      /** Synchronously advance the live simulation (no rendering). */
      advance(seconds: number) {
        const n = Math.round(seconds / SIM_DT);
        for (let i = 0; i < n; i++) app.stepSim();
        return this.state();
      },
      /** Runs a headless scripted scenario in the page (same code as the unit tests). */
      scenario(name: string, model: FlightModel) {
        const S = scenarios as unknown as Record<string, (...a: unknown[]) => unknown>;
        if (name === 'landCoastal') return scenarios.approach(model, STRIPS[0]);
        if (name === 'landMountain') return scenarios.approach(model, STRIPS[1]);
        if (name === 'landWater') return scenarios.approach(model, scenarios.WATER_LANE, 2000, true);
        return S[name](model);
      },
      /** Live autoland onto 'coastal' | 'mountain' | 'water' (renders while flying); null cancels. */
      autoland(where: 'coastal' | 'mountain' | 'water' | null, dist = 2500) {
        if (autolandHook) {
          const i = app.onSimStep.indexOf(autolandHook);
          if (i >= 0) app.onSimStep.splice(i, 1);
          autolandHook = null;
        }
        if (!where) {
          app.inputOverride = null;
          return null;
        }
        const strip = where === 'water' ? scenarios.WATER_LANE : STRIPS[where === 'coastal' ? 0 : 1];
        const c = new scenarios.ApproachController(strip, where === 'water');
        c.place(app.ac, dist);
        app.startFlightAt();
        app.state = 'flying';
        const inp = { ...app.controls.input, flapNotch: 2, gearDown: where !== 'water', brake: 0 };
        app.inputOverride = inp;
        app.ac.onTouchdown = (t) => c.onTouchdown(t);
        autolandHook = () => c.update(app.ac, app.env, inp, SIM_DT);
        app.onSimStep.push(autolandHook);
        autoland = c;
        return true;
      },
      autolandResult: () => (autoland ? autoland.result(app.ac, app.env) : null),
      autolandPhase: () => autoland?.phase ?? null,
      /** Records the drawn-surface clearance and drift of the live aircraft over `seconds` (real frames). */
      surfaceProbe() {
        const pts: [number, number, number][] = [[-1.3, -2.47, 0.45], [1.3, -2.47, 0.45], [-1.3, -2.37, -3.3], [1.3, -2.37, -3.3], [-1.3, -2.16, -0.9], [1.3, -2.16, -0.9]];
        const P = new THREE.Vector3();
        let min = 1e9;
        for (const p of pts) {
          app.ac.toWorld(p, P);
          min = Math.min(min, P.y - drawnHeight(P.x, P.z, w.clip));
        }
        return { minClearance: min, x: app.ac.pos.x, y: app.ac.pos.y, z: app.ac.pos.z, qx: app.ac.q.x, qy: app.ac.q.y, qz: app.ac.q.z, qw: app.ac.q.w };
      },
    },
    setPaused(p: boolean) {
      app.paused = p;
    },
    setFixedDt(dt: number | null) {
      app.fixedDt = dt;
    },
    setAutoScale(on: boolean) {
      w.scaler.enabled = on;
      if (!on) w.scaler.scale = 1;
    },
    /** Override a shared uniform every frame (null clears the override). */
    setUniform(name: string, value: number | number[] | null) {
      overrides.set(name, value);
      if (value === null) overrides.delete(name);
    },
    terrainHeight: (x: number, z: number, oct = TERRAIN_OCTAVES) => terrainHeight(x, z, oct),
    drawnHeight: (x: number, z: number) => drawnHeight(x, z, w.clip),
    info() {
      const i = w.renderer.info;
      return {
        calls: i.render.calls,
        triangles: i.render.triangles,
        scale: w.scaler.scale,
        size: [w.post.width, w.post.height],
        preset: w.preset.name,
        reversedZ: w.renderer.capabilities.reversedDepthBuffer,
        logDepth: w.renderer.capabilities.logarithmicDepthBuffer,
        hdr: w.caps.floatTargets,
      };
    },
    /**
     * Renders `frames` frames back to back, each followed by a GPU sync; returns ms per frame.
     * full = true runs whole app frames (simulation, cameras, HUD, audio and render).
     */
    benchmark(frames = 60, flyMps = 0, full = false) {
      const gl = w.renderer.getContext();
      const px = new Uint8Array(4);
      // readPixels forces a real GPU sync (gl.finish() does not block in Chrome)
      const sync = () => {
        w.renderer.setRenderTarget(null);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      };
      const was = app.paused;
      app.paused = true;
      w.render(1 / 60);
      sync();
      const times: number[] = [];
      for (let i = 0; i < frames; i++) {
        if (flyMps) w.camera.translateZ(-flyMps / 60);
        const t0 = performance.now();
        if (full) {
          app.paused = false;
          app.frame(1 / 60);
          app.paused = true;
        } else w.render(1 / 60);
        sync();
        times.push(performance.now() - t0);
      }
      app.paused = was;
      times.sort((a, b) => a - b);
      const avg = times.reduce((a, b) => a + b, 0) / times.length;
      return { avg, p50: times[Math.floor(times.length / 2)], p95: times[Math.floor(times.length * 0.95)], ...api.info() };
    },
    /** Per-pass GPU time (ms, averaged over `frames`). */
    profile(frames = 30) {
      const was = app.paused;
      app.paused = true;
      w.profile = new Map();
      for (let i = 0; i < frames; i++) w.render(1 / 60);
      const out: Record<string, number> = {};
      for (const [k, v] of w.profile) out[k] = +(v / frames).toFixed(2);
      w.profile = null;
      app.paused = was;
      return out;
    },
    /** GLSL terrainHeight() and clipVertexHeight() at the given points vs CPU. */
    gpuTerrain(points: number[], spacing = 1) {
      const n = points.length / 2;
      const data = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) {
        data[4 * i] = points[2 * i];
        data[4 * i + 1] = points[2 * i + 1];
      }
      const tex = new THREE.DataTexture(data, n, 1, THREE.RGBAFormat, THREE.FloatType);
      tex.needsUpdate = true;
      const rt = new THREE.WebGLRenderTarget(n, 1, { type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: false });
      const mat = passMaterial(
        terrainPrefix() +
          /* glsl */ `
          uniform sampler2D uPts;
          uniform float uS;
          out vec4 fragColor;
          void main() {
            vec2 p = texelFetch(uPts, ivec2(gl_FragCoord.xy), 0).xy;
            fragColor = vec4(terrainHeight(p, TERRAIN_OCTAVES), clipVertexHeight(p, uS), terrainHeight(p, octavesForSpacing(uS)), 1.0);
          }`,
        { uPts: { value: tex }, uS: { value: spacing }, uClipCenter: w.terrain.uniforms.uClipCenter, uClipM: w.terrain.uniforms.uClipM },
      );
      new FullscreenPass(mat).render(w.renderer, rt);
      const out = new Float32Array(n * 4);
      w.renderer.readRenderTargetPixels(rt, 0, 0, n, 1, out);
      let maxFn = 0;
      let maxV = 0;
      for (let i = 0; i < n; i++) {
        const x = points[2 * i], z = points[2 * i + 1];
        maxFn = Math.max(maxFn, Math.abs(out[4 * i] - terrainHeight(x, z, TERRAIN_OCTAVES)));
        maxFn = Math.max(maxFn, Math.abs(out[4 * i + 2] - terrainHeight(x, z, octavesForSpacing(spacing))));
        maxV = Math.max(maxV, Math.abs(out[4 * i + 1] - vertexHeight(x, z, spacing, w.clip)));
      }
      rt.dispose();
      tex.dispose();
      mat.dispose();
      return { maxFunctionErr: maxFn, maxVertexErr: maxV, sample: Array.from(out.slice(0, 8)) };
    },
    /** Rasterises the real clipmap meshes from above and compares every pixel with drawnHeight(). */
    rasterParity(cx: number, cz: number, extent: number, size = 512): ParityStats {
      const rt = new THREE.WebGLRenderTarget(size, size, { type: THREE.FloatType, format: THREE.RGBAFormat });
      const cam = new THREE.OrthographicCamera(-extent / 2, extent / 2, extent / 2, -extent / 2, 1, 12000);
      cam.position.set(cx, 6000, cz);
      cam.up.set(0, 0, -1);
      cam.lookAt(cx, 0, cz);
      cam.updateMatrixWorld();
      const mat = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: terrainVertexShader(),
        fragmentShader: /* glsl */ `
          in vec3 vWorld; in vec3 vNormal; in float vMorph;
          out vec4 fragColor;
          #include <logdepthbuf_pars_fragment>
          void main() {
            #include <logdepthbuf_fragment>
            fragColor = vec4(vWorld, 1.0);
          }`,
        uniforms: { ...globals, ...w.terrain.uniforms },
        defines: { ...w.terrain.defines },
      });
      const scene = new THREE.Scene();
      scene.overrideMaterial = mat;
      const saved = { pos: globals.uCamPosF.value.clone(), rot: globals.uViewRot.value.clone() };
      globals.uCamPosF.value.set(Math.fround(cx), Math.fround(6000), Math.fround(cz));
      globals.uViewRot.value.extractRotation(cam.matrixWorldInverse);
      const parent = w.terrain.group.parent;
      scene.add(w.terrain.group);
      w.renderer.setRenderTarget(rt);
      w.renderer.setClearColor(0x000000, 0);
      w.renderer.clear(true, true, false);
      w.renderer.render(scene, cam);
      w.renderer.setClearColor(0x000000, 1);
      parent?.add(w.terrain.group);
      globals.uCamPosF.value.copy(saved.pos);
      globals.uViewRot.value.copy(saved.rot);
      const px = new Float32Array(size * size * 4);
      w.renderer.readRenderTargetPixels(rt, 0, 0, size, size, px);
      rt.dispose();
      mat.dispose();
      let count = 0, maxErr = 0, sum = 0;
      let worst: [number, number, number, number] = [0, 0, 0, 0];
      for (let i = 0; i < size * size; i++) {
        if (px[4 * i + 3] < 0.5) continue;
        const x = px[4 * i], y = px[4 * i + 1], z = px[4 * i + 2];
        const e = Math.abs(drawnHeight(x, z, w.clip) - y);
        count++;
        sum += e;
        if (e > maxErr) {
          maxErr = e;
          worst = [x, z, y, drawnHeight(x, z, w.clip)];
        }
      }
      return { count, maxErr, meanErr: sum / Math.max(1, count), worst };
    },
  };
  (window as unknown as { __icarus: typeof api }).__icarus = api;
}
