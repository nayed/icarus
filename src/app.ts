// Application shell: main loop, resize, debug camera. Grows into the full game in later stages.
import * as THREE from 'three';
import { WorldRenderer } from './render/worldRenderer.ts';
import type { Capabilities } from './render/capabilities.ts';
import type { QualityName } from './render/quality.ts';
import { installDebugHooks } from './debug/hooks.ts';
import { TIME_PRESETS } from './world/celestial.ts';
import { terrainHeight } from './world/terrain.ts';

export class App {
  readonly world: WorldRenderer;
  private last = performance.now();
  private keys = new Set<string>();
  yaw = 0;
  pitch = 0;
  paused = false;
  fixedDt: number | null = null;
  frames = 0;

  constructor(readonly canvas: HTMLCanvasElement, readonly caps: Capabilities) {
    const q = new URLSearchParams(location.search);
    const quality = (q.get('q') as QualityName) ?? 'high';
    this.world = new WorldRenderer(canvas, caps, ['low', 'medium', 'high'].includes(quality) ? quality : 'high');
    const t = q.get('t');
    this.world.timeOfDay = t ? (t in TIME_PRESETS ? TIME_PRESETS[t as keyof typeof TIME_PRESETS] : Number(t)) : TIME_PRESETS.dusk;
    const cam = (q.get('cam') ?? '-2500,260,2300,80,-4').split(',').map(Number);
    this.setCamera(cam[0], cam[1], cam[2], cam[3], cam[4], cam[5] ?? 60);

    new ResizeObserver(() => this.onResize()).observe(canvas.parentElement!);
    this.onResize();
    addEventListener('keydown', (e) => this.keys.add(e.code));
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    if (q.has('debug')) installDebugHooks(this);
    requestAnimationFrame(this.loop);
  }

  setCamera(x: number, y: number, z: number, yawDeg: number, pitchDeg: number, fov = 60): void {
    const c = this.world.camera;
    c.position.set(x, y, z);
    this.yaw = THREE.MathUtils.degToRad(yawDeg);
    this.pitch = THREE.MathUtils.degToRad(pitchDeg);
    c.fov = fov;
    c.updateProjectionMatrix();
    this.applyCameraRotation();
    this.world.trees.prefill(x, z);
  }

  private applyCameraRotation(): void {
    // yaw: heading (0 = north/-z, 90 = east/+x); pitch: up positive
    this.world.camera.rotation.set(this.pitch, -this.yaw, 0, 'YXZ');
  }

  private onResize(): void {
    const el = this.canvas.parentElement!;
    this.world.resize(el.clientWidth, el.clientHeight);
  }

  private flyDebug(dt: number): void {
    const k = this.keys;
    const c = this.world.camera;
    const speed = (k.has('ShiftLeft') ? 600 : 120) * dt;
    const fwd = new THREE.Vector3(Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, Math.sin(this.yaw));
    if (k.has('KeyW')) c.position.addScaledVector(fwd, speed);
    if (k.has('KeyS')) c.position.addScaledVector(fwd, -speed);
    if (k.has('KeyD')) c.position.addScaledVector(right, speed);
    if (k.has('KeyA')) c.position.addScaledVector(right, -speed);
    if (k.has('KeyE')) c.position.y += speed;
    if (k.has('KeyQ')) c.position.y -= speed;
    if (k.has('ArrowLeft')) this.yaw -= dt;
    if (k.has('ArrowRight')) this.yaw += dt;
    if (k.has('ArrowUp')) this.pitch = Math.min(1.5, this.pitch + dt);
    if (k.has('ArrowDown')) this.pitch = Math.max(-1.5, this.pitch - dt);
    if (k.has('BracketRight')) this.world.timeOfDay = (this.world.timeOfDay + dt) % 24;
    if (k.has('BracketLeft')) this.world.timeOfDay = (this.world.timeOfDay + 24 - dt) % 24;
    const ground = terrainHeight(c.position.x, c.position.z, 6);
    c.position.y = Math.max(c.position.y, Math.max(ground, 0) + 2);
    this.applyCameraRotation();
  }

  private loop = (now: number): void => {
    requestAnimationFrame(this.loop);
    const realDt = Math.min((now - this.last) / 1000, 0.1);
    this.last = now;
    if (this.paused) return;
    const dt = this.fixedDt ?? realDt;
    this.flyDebug(dt);
    const t0 = performance.now();
    this.world.render(dt);
    this.frames++;
    if (this.world.scaler.update(realDt * 1000, realDt)) this.onResize();
    void t0;
  };
}
