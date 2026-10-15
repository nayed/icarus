// Cockpit instrument panel drawn on a canvas (procedural texture), redrawn ~15 times a second.
import * as THREE from 'three';
import type { Telemetry } from '../sim/aircraft.ts';
import { ATMOSPHERE_GLSL, SKYVIEW_SAMPLE_GLSL } from '../render/atmosphere.ts';
import { GLOBALS_GLSL, globals } from '../render/globals.ts';
import { OUTPUT_GLSL } from '../render/post.ts';

const W = 1024;
const H = 320;

export class InstrumentPanel {
  readonly canvas = document.createElement('canvas');
  readonly texture: THREE.CanvasTexture;
  readonly material: THREE.ShaderMaterial;
  private readonly ctx: CanvasRenderingContext2D;
  private acc = 1;

  constructor() {
    this.canvas.width = W;
    this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { ...globals, uTex: { value: this.texture } },
      vertexShader: /* glsl */ `out vec2 vUv; out vec3 vWorld;
#include <logdepthbuf_pars_vertex>
        void main() { vUv = uv; vWorld = (modelMatrix * vec4(position, 1.0)).xyz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        #include <logdepthbuf_vertex>
        }`,
      fragmentShader:
        ATMOSPHERE_GLSL + SKYVIEW_SAMPLE_GLSL + GLOBALS_GLSL + OUTPUT_GLSL +
        /* glsl */ `in vec2 vUv; in vec3 vWorld; uniform sampler2D uTex; out vec4 fragColor;
#include <logdepthbuf_pars_fragment>
        void main() {
          #include <logdepthbuf_fragment>
          vec4 t = texture(uTex, vUv);
          // dim daylight on the panel + warm instrument lighting that matters at night
          // daylight through the windshield + warm instrument lighting (always readable)
          vec3 light = envDiffuse(vec3(0.0, 0.5, -1.0)) * 1.1 + uSunColor * max(uSunDir.y, 0.0) * 0.12;
          // instrument backlight: always on, and relatively brighter as the scene gets darker
          vec3 glow = vec3(1.0, 0.8, 0.6) * (0.1 + 0.5 * smoothstep(20.0, 400.0, uExposure)) * max(1.0, uExposure * 0.0012);
          fragColor = finalOutput(t.rgb * (light + glow));
        }`,
    });
    this.draw(null);
  }

  update(t: Telemetry, dt: number): void {
    this.acc += dt;
    if (this.acc < 1 / 15) return;
    this.acc = 0;
    this.draw(t);
  }

  private draw(t: Telemetry | null): void {
    const c = this.ctx;
    c.fillStyle = '#16191b';
    c.fillRect(0, 0, W, H);
    // panel texture: subtle screws and panel lines
    c.strokeStyle = 'rgba(255,255,255,0.04)';
    c.lineWidth = 2;
    c.strokeRect(6, 6, W - 12, H - 12);
    const r = 62;
    const cols = [140, 300, 460];
    const rows = [82, 236];
    const kt = (t?.ias ?? 0) * 1.944;
    const alt = (t?.altitude ?? 0) * 3.281;
    this.dial(cols[0], rows[0], r, 'KNOTS', kt, 0, 180, [
      [40, 100, '#e8e8e8'],
      [50, 140, '#3fbf5f'],
      [140, 155, '#e3c13d'],
    ], [155]);
    this.attitude(cols[1], rows[0], r, t?.pitch ?? 0, t?.bank ?? 0);
    this.altimeter(cols[2], rows[0], r, alt);
    this.turn(cols[0], rows[1], r, t?.beta ?? 0, t ? t.bank : 0);
    this.heading(cols[1], rows[1], r, t?.heading ?? 0);
    this.vsi(cols[2], rows[1], r, (t?.vs ?? 0) * 196.85);
    // right block: rpm, flaps, gear, warnings
    this.dial(640, rows[0], 54, 'RPM ×100', (t?.rpm ?? 0) / 100, 0, 25, [[6, 22, '#3fbf5f']], [23]);
    c.font = '600 22px "Barlow Condensed", "Arial Narrow", sans-serif';
    c.textAlign = 'left';
    c.fillStyle = '#9aa0a3';
    c.fillText('FLAPS', 840, 70);
    const notch = t?.flapNotch ?? 0;
    for (let i = 0; i < 4; i++) {
      c.fillStyle = i <= notch ? '#f2a24b' : '#2a2f33';
      c.fillRect(840 + i * 34, 82, 28, 14);
    }
    c.fillStyle = '#9aa0a3';
    c.fillText('GEAR', 840, 140);
    const gear = t?.gear ?? 1;
    const lampCol = gear > 0.98 ? '#3fdc6a' : gear < 0.02 ? '#4aa3ff' : '#e3c13d';
    c.fillStyle = lampCol;
    c.beginPath();
    c.arc(855, 165, 11, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = '#d8dadb';
    c.fillText(gear > 0.98 ? 'DOWN · LAND' : gear < 0.02 ? 'UP · WATER' : 'IN TRANSIT', 876, 172);
    if (t?.stallWarning) {
      c.fillStyle = '#e8473b';
      c.fillRect(840, 220, 150, 34);
      c.fillStyle = '#fff';
      c.fillText('STALL', 885, 245);
    }
    c.fillStyle = '#5d6366';
    c.font = '500 16px "Barlow Condensed", "Arial Narrow", sans-serif';
    c.fillText('LN-ICR', 840, 300);
    this.texture.needsUpdate = true;
  }

  private bezel(x: number, y: number, r: number): void {
    const c = this.ctx;
    c.fillStyle = '#0b0c0d';
    c.beginPath();
    c.arc(x, y, r + 8, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = '#121416';
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.fill();
  }

  private needle(x: number, y: number, ang: number, len: number, w = 4, col = '#f0f0f0'): void {
    const c = this.ctx;
    c.strokeStyle = col;
    c.lineWidth = w;
    c.lineCap = 'round';
    c.beginPath();
    c.moveTo(x - Math.sin(ang) * len * 0.15, y + Math.cos(ang) * len * 0.15);
    c.lineTo(x + Math.sin(ang) * len, y - Math.cos(ang) * len);
    c.stroke();
  }

  private dial(x: number, y: number, r: number, label: string, v: number, lo: number, hi: number, arcs: [number, number, string][], red: number[]): void {
    const c = this.ctx;
    this.bezel(x, y, r);
    const a0 = -0.75 * Math.PI;
    const a1 = 0.75 * Math.PI;
    const ang = (u: number) => a0 + ((u - lo) / (hi - lo)) * (a1 - a0);
    for (const [s, e, col] of arcs) {
      c.strokeStyle = col;
      c.lineWidth = 5;
      c.beginPath();
      c.arc(x, y, r - 9, ang(s) - Math.PI / 2, ang(e) - Math.PI / 2);
      c.stroke();
    }
    for (const rv of red) {
      const a = ang(rv);
      c.strokeStyle = '#e8473b';
      c.lineWidth = 4;
      c.beginPath();
      c.moveTo(x + Math.sin(a) * (r - 18), y - Math.cos(a) * (r - 18));
      c.lineTo(x + Math.sin(a) * r, y - Math.cos(a) * r);
      c.stroke();
    }
    c.strokeStyle = '#cfd2d4';
    c.lineWidth = 2;
    for (let i = 0; i <= 10; i++) {
      const a = a0 + (i / 10) * (a1 - a0);
      c.beginPath();
      c.moveTo(x + Math.sin(a) * (r - 14), y - Math.cos(a) * (r - 14));
      c.lineTo(x + Math.sin(a) * (r - 3), y - Math.cos(a) * (r - 3));
      c.stroke();
    }
    c.fillStyle = '#8f9599';
    c.font = '600 15px "Barlow Condensed", "Arial Narrow", sans-serif';
    c.textAlign = 'center';
    c.fillText(label, x, y + r * 0.5);
    this.needle(x, y, ang(THREE.MathUtils.clamp(v, lo, hi)), r - 10);
  }

  private attitude(x: number, y: number, r: number, pitch: number, bank: number): void {
    const c = this.ctx;
    this.bezel(x, y, r);
    c.save();
    c.beginPath();
    c.arc(x, y, r - 2, 0, Math.PI * 2);
    c.clip();
    c.translate(x, y);
    c.rotate((-bank * Math.PI) / 180);
    const off = pitch * 2.4;
    c.fillStyle = '#3d6d9c';
    c.fillRect(-r * 2, -r * 2 + off, r * 4, r * 2);
    c.fillStyle = '#6b4a2e';
    c.fillRect(-r * 2, off, r * 4, r * 2);
    c.strokeStyle = '#fff';
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(-r, off);
    c.lineTo(r, off);
    for (const p of [-20, -10, 10, 20]) {
      c.moveTo(-14, off - p * 2.4);
      c.lineTo(14, off - p * 2.4);
    }
    c.stroke();
    c.restore();
    c.strokeStyle = '#f2a24b';
    c.lineWidth = 4;
    c.beginPath();
    c.moveTo(x - 34, y);
    c.lineTo(x - 10, y);
    c.lineTo(x, y + 8);
    c.lineTo(x + 10, y);
    c.lineTo(x + 34, y);
    c.stroke();
  }

  private altimeter(x: number, y: number, r: number, ft: number): void {
    const c = this.ctx;
    this.bezel(x, y, r);
    c.fillStyle = '#cfd2d4';
    c.font = '600 16px "Barlow Condensed", "Arial Narrow", sans-serif';
    c.textAlign = 'center';
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      c.fillText(String(i), x + Math.sin(a) * (r - 18), y - Math.cos(a) * (r - 18) + 6);
    }
    c.fillStyle = '#8f9599';
    c.fillText('ALT', x, y + 26);
    this.needle(x, y, ((ft / 10000) % 1) * Math.PI * 2, r * 0.45, 6);
    this.needle(x, y, ((ft / 1000) % 1) * Math.PI * 2, r - 22, 3);
  }

  private turn(x: number, y: number, r: number, beta: number, bank: number): void {
    const c = this.ctx;
    this.bezel(x, y, r);
    c.save();
    c.translate(x, y);
    c.rotate((THREE.MathUtils.clamp(bank, -30, 30) * Math.PI) / 180);
    c.strokeStyle = '#f0f0f0';
    c.lineWidth = 4;
    c.beginPath();
    c.moveTo(-40, 0);
    c.lineTo(40, 0);
    c.stroke();
    c.restore();
    // slip ball
    c.fillStyle = '#0b0c0d';
    c.fillRect(x - 40, y + 28, 80, 18);
    c.fillStyle = '#f0f0f0';
    c.beginPath();
    c.arc(x + THREE.MathUtils.clamp(-beta * 2.2, -32, 32), y + 37, 8, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = '#8f9599';
    c.font = '600 14px "Barlow Condensed", "Arial Narrow", sans-serif';
    c.textAlign = 'center';
    c.fillText('TURN · SLIP', x, y - 30);
  }

  private heading(x: number, y: number, r: number, hdg: number): void {
    const c = this.ctx;
    this.bezel(x, y, r);
    c.save();
    c.translate(x, y);
    c.rotate((-hdg * Math.PI) / 180);
    c.fillStyle = '#cfd2d4';
    c.font = '600 16px "Barlow Condensed", "Arial Narrow", sans-serif';
    c.textAlign = 'center';
    const lbl = ['N', '3', '6', 'E', '12', '15', 'S', '21', '24', 'W', '30', '33'];
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      c.save();
      c.rotate(a);
      c.fillText(lbl[i], 0, -r + 24);
      c.restore();
    }
    c.restore();
    c.fillStyle = '#f2a24b';
    c.beginPath();
    c.moveTo(x, y - r + 4);
    c.lineTo(x - 7, y - r + 16);
    c.lineTo(x + 7, y - r + 16);
    c.fill();
  }

  private vsi(x: number, y: number, r: number, fpm: number): void {
    const c = this.ctx;
    this.bezel(x, y, r);
    const a = -Math.PI / 2 + (THREE.MathUtils.clamp(fpm, -2000, 2000) / 2000) * (Math.PI * 0.8);
    c.fillStyle = '#8f9599';
    c.font = '600 14px "Barlow Condensed", "Arial Narrow", sans-serif';
    c.textAlign = 'center';
    c.fillText('VERT SPEED', x + 6, y + 30);
    this.needle(x, y, a, r - 10);
  }
}
