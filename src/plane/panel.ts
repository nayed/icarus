// Cockpit instrument panel. The faces, scales and labels are drawn once on a canvas (procedural
// texture); everything that moves every frame (needles, attitude, turn bar, slip ball, compass card)
// is drawn analytically in the panel shader from uniforms. The canvas is redrawn and uploaded only
// when a discrete state changes (flaps, gear, stall warning): no per-frame texture uploads.
import * as THREE from 'three';
import type { Telemetry } from '../sim/aircraft.ts';
import { ATMOSPHERE_GLSL, SKYVIEW_SAMPLE_GLSL } from '../render/atmosphere.ts';
import { GLOBALS_GLSL, globals } from '../render/globals.ts';
import { OUTPUT_GLSL } from '../render/post.ts';

const W = 1024;
const H = 320;
const R = 62;
const COLS = [140, 300, 460];
const ROWS = [82, 236];
const RPM_POS = [640, 82];
const RPM_R = 54;
/** dial sweep: 270 degrees, from bottom-left to bottom-right */
const A0 = -0.75 * Math.PI;
const A1 = 0.75 * Math.PI;
const FONT = '"Barlow Condensed", "Arial Narrow", sans-serif';

const dialAngle = (v: number, lo: number, hi: number) => A0 + ((THREE.MathUtils.clamp(v, lo, hi) - lo) / (hi - lo)) * (A1 - A0);
const vsiAngle = (fpm: number) => -Math.PI / 2 + (THREE.MathUtils.clamp(fpm, -2000, 2000) / 2000) * (Math.PI * 0.8);

const FRAG = /* glsl */ `
in vec2 vUv;
in vec3 vWorld;
uniform sampler2D uTex;
uniform vec4 uNeedles;   // airspeed, altimeter 10 000 ft, altimeter 1 000 ft, vertical speed (radians)
uniform vec4 uAtt;       // pitch (deg), bank (rad), turn bar (rad), slip ball offset (px)
uniform vec2 uHdgRpm;    // heading (rad), rpm needle (rad)
out vec4 fragColor;
#include <logdepthbuf_pars_fragment>

const vec2 SIZE = vec2(${W}.0, ${H}.0);
const float R = ${R}.0;
// colours in linear space (the canvas texture is sRGB)
const vec3 WHITE = vec3(0.871);
const vec3 AMBER = vec3(0.888, 0.361, 0.070);
const vec3 SKY = vec3(0.047, 0.153, 0.333);
const vec3 GROUND = vec3(0.147, 0.069, 0.027);

float segDist(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}
/** coverage of a shape from its signed distance (pixels of the canvas), antialiased on screen */
float cover(float d) {
  float aa = max(fwidth(d), 1e-3) * 0.75;
  return 1.0 - smoothstep(-aa, aa, d);
}
/** canvas angles: 0 points up (towards -y), clockwise positive */
vec2 dirOf(float a) { return vec2(sin(a), -cos(a)); }
float needle(vec2 p, vec2 c, float a, float len, float w) {
  vec2 d = dirOf(a);
  return cover(segDist(p, c - d * len * 0.15, c + d * len) - w * 0.5);
}
vec2 rot(vec2 q, float a) { float c = cos(a), s = sin(a); return vec2(q.x * c - q.y * s, q.x * sin(a) + q.y * c); }

void main() {
  #include <logdepthbuf_fragment>
  vec2 p = vec2(vUv.x, 1.0 - vUv.y) * SIZE; // canvas pixels, y down
  vec2 cAsi = vec2(${COLS[0]}.0, ${ROWS[0]}.0), cAtt = vec2(${COLS[1]}.0, ${ROWS[0]}.0), cAlt = vec2(${COLS[2]}.0, ${ROWS[0]}.0);
  vec2 cTurn = vec2(${COLS[0]}.0, ${ROWS[1]}.0), cHdg = vec2(${COLS[1]}.0, ${ROWS[1]}.0), cVsi = vec2(${COLS[2]}.0, ${ROWS[1]}.0);
  vec2 cRpm = vec2(${RPM_POS[0]}.0, ${RPM_POS[1]}.0);

  // heading: the compass card in the texture is drawn at north up; turn it under the lubber line
  vec2 uv = vUv;
  vec2 qh = p - cHdg;
  if (dot(qh, qh) < (R - 1.0) * (R - 1.0)) {
    vec2 src = cHdg + rot(qh, uHdgRpm.x);
    uv = vec2(src.x / SIZE.x, 1.0 - src.y / SIZE.y);
  }
  vec3 col = texture(uTex, uv).rgb;

  // attitude indicator: sky/ground and pitch bars turn with the bank, the aircraft symbol stays
  vec2 qa = p - cAtt;
  float inAtt = cover(length(qa) - (R - 2.0));
  if (inAtt > 0.0) {
    vec2 q = rot(qa, uAtt.y);
    float off = uAtt.x * 2.4;
    vec3 ai = mix(SKY, GROUND, cover(off - q.y));
    float lines = cover(abs(q.y - off) - 1.0);
    for (int i = 0; i < 4; i++) {
      float pb = float(i < 2 ? i - 2 : i - 1) * 10.0; // -20, -10, 10, 20
      lines = max(lines, cover(max(abs(q.y - (off - pb * 2.4)) - 1.0, abs(q.x) - 14.0)));
    }
    ai = mix(ai, vec3(1.0), lines);
    col = mix(col, ai, inAtt);
    float sym = min(min(segDist(p, cAtt + vec2(-34.0, 0.0), cAtt + vec2(-10.0, 0.0)), segDist(p, cAtt + vec2(-10.0, 0.0), cAtt + vec2(0.0, 8.0))),
                    min(segDist(p, cAtt + vec2(0.0, 8.0), cAtt + vec2(10.0, 0.0)), segDist(p, cAtt + vec2(10.0, 0.0), cAtt + vec2(34.0, 0.0))));
    col = mix(col, AMBER, cover(sym - 2.0));
  }

  // lubber line of the heading indicator
  vec2 t = p - cHdg;
  float tri = max(max(t.y - (-R + 16.0), (-R + 4.0) - t.y), abs(t.x) - 7.0 * (t.y + R - 4.0) / 12.0);
  col = mix(col, AMBER, cover(tri));

  // turn coordinator: turn bar and slip ball
  vec2 e = rot(vec2(40.0, 0.0), uAtt.z);
  col = mix(col, WHITE, cover(segDist(p, cTurn - e, cTurn + e) - 2.0));
  col = mix(col, WHITE, cover(length(p - (cTurn + vec2(uAtt.w, 37.0))) - 8.0));

  // needles
  float n = needle(p, cAsi, uNeedles.x, R - 10.0, 4.0);
  n = max(n, needle(p, cAlt, uNeedles.y, R * 0.45, 6.0));
  n = max(n, needle(p, cAlt, uNeedles.z, R - 22.0, 3.0));
  n = max(n, needle(p, cVsi, uNeedles.w, R - 10.0, 4.0));
  n = max(n, needle(p, cRpm, uHdgRpm.y, ${RPM_R}.0 - 10.0, 4.0));
  col = mix(col, WHITE, n);

  // daylight through the windshield + warm instrument backlight: it grows as the scene darkens
  // (the exposure rises) up to the level of a dimmed night panel, so colours never wash out
  vec3 light = envDiffuse(vec3(0.0, 0.5, -1.0)) * 1.1 + uSunColor * max(uSunDir.y, 0.0) * 0.12;
  vec3 glow = vec3(1.0, 0.8, 0.6) * min(0.7, (0.1 + 0.5 * smoothstep(20.0, 400.0, uExposure)) * max(1.0, uExposure * 0.0012));
  fragColor = finalOutput(col * (light + glow));
}
`;

export class InstrumentPanel {
  readonly canvas = document.createElement('canvas');
  readonly texture: THREE.CanvasTexture;
  readonly material: THREE.ShaderMaterial;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly uniforms = {
    uTex: { value: null as THREE.Texture | null },
    uNeedles: { value: new THREE.Vector4() },
    uAtt: { value: new THREE.Vector4() },
    uHdgRpm: { value: new THREE.Vector2() },
  };
  /** discrete state the canvas was last drawn for */
  private drawnKey = '';
  /** canvas redraws so far (tests) */
  redraws = 0;

  constructor() {
    this.canvas.width = W;
    this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.uniforms.uTex.value = this.texture;
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { ...globals, ...this.uniforms },
      vertexShader: /* glsl */ `out vec2 vUv; out vec3 vWorld;
#include <logdepthbuf_pars_vertex>
        void main() { vUv = uv; vWorld = (modelMatrix * vec4(position, 1.0)).xyz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        #include <icarus_logdepth_vertex>
        }`,
      fragmentShader: ATMOSPHERE_GLSL + SKYVIEW_SAMPLE_GLSL + GLOBALS_GLSL + OUTPUT_GLSL + FRAG,
    });
    this.update(null);
  }

  update(t: Telemetry | null): void {
    const kt = (t?.ias ?? 0) * 1.944;
    const ft = (t?.altitude ?? 0) * 3.281;
    const u = this.uniforms;
    u.uNeedles.value.set(dialAngle(kt, 0, 180), ((ft / 10000) % 1) * Math.PI * 2, ((ft / 1000) % 1) * Math.PI * 2, vsiAngle((t?.vs ?? 0) * 196.85));
    const bank = t?.bank ?? 0;
    u.uAtt.value.set(t?.pitch ?? 0, (bank * Math.PI) / 180, (THREE.MathUtils.clamp(bank, -30, 30) * Math.PI) / 180, THREE.MathUtils.clamp(-(t?.beta ?? 0) * 2.2, -32, 32));
    u.uHdgRpm.value.set(((t?.heading ?? 0) * Math.PI) / 180, dialAngle((t?.rpm ?? 0) / 100, 0, 25));
    const gear = t?.gear ?? 1;
    const key = `${t?.flapNotch ?? 0}|${gear > 0.98 ? 'down' : gear < 0.02 ? 'up' : 'transit'}|${t?.stallWarning ? 1 : 0}`;
    if (key !== this.drawnKey) {
      this.drawnKey = key;
      this.draw(t);
    }
  }

  /** Faces, scales, labels and the discrete indicators. */
  private draw(t: Telemetry | null): void {
    this.redraws++;
    const c = this.ctx;
    c.fillStyle = '#16191b';
    c.fillRect(0, 0, W, H);
    // panel texture: subtle panel line
    c.strokeStyle = 'rgba(255,255,255,0.04)';
    c.lineWidth = 2;
    c.strokeRect(6, 6, W - 12, H - 12);
    this.dial(COLS[0], ROWS[0], R, 'KNOTS', 0, 180, [
      [40, 100, '#e8e8e8'],
      [50, 140, '#3fbf5f'],
      [140, 155, '#e3c13d'],
    ], [155]);
    this.bezel(COLS[1], ROWS[0], R);
    this.altimeter(COLS[2], ROWS[0], R);
    this.turn(COLS[0], ROWS[1], R);
    this.compass(COLS[1], ROWS[1], R);
    this.vsi(COLS[2], ROWS[1], R);
    this.dial(RPM_POS[0], RPM_POS[1], RPM_R, 'RPM ×100', 0, 25, [[6, 22, '#3fbf5f']], [23]);
    // right block: flaps, gear, warnings
    c.font = `600 22px ${FONT}`;
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
    c.fillStyle = gear > 0.98 ? '#3fdc6a' : gear < 0.02 ? '#4aa3ff' : '#e3c13d';
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
    c.font = `500 16px ${FONT}`;
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

  private tick(x: number, y: number, a: number, r0: number, r1: number, w: number, col: string): void {
    const c = this.ctx;
    c.strokeStyle = col;
    c.lineWidth = w;
    c.beginPath();
    c.moveTo(x + Math.sin(a) * r0, y - Math.cos(a) * r0);
    c.lineTo(x + Math.sin(a) * r1, y - Math.cos(a) * r1);
    c.stroke();
  }

  private dial(x: number, y: number, r: number, label: string, lo: number, hi: number, arcs: [number, number, string][], red: number[]): void {
    const c = this.ctx;
    this.bezel(x, y, r);
    for (const [s, e, col] of arcs) {
      c.strokeStyle = col;
      c.lineWidth = 5;
      c.beginPath();
      c.arc(x, y, r - 9, dialAngle(s, lo, hi) - Math.PI / 2, dialAngle(e, lo, hi) - Math.PI / 2);
      c.stroke();
    }
    for (const rv of red) this.tick(x, y, dialAngle(rv, lo, hi), r - 18, r, 4, '#e8473b');
    for (let i = 0; i <= 10; i++) this.tick(x, y, A0 + (i / 10) * (A1 - A0), r - 14, r - 3, 2, '#cfd2d4');
    c.fillStyle = '#8f9599';
    c.font = `600 15px ${FONT}`;
    c.textAlign = 'center';
    c.fillText(label, x, y + r * 0.5);
  }

  private altimeter(x: number, y: number, r: number): void {
    const c = this.ctx;
    this.bezel(x, y, r);
    c.fillStyle = '#cfd2d4';
    c.font = `600 16px ${FONT}`;
    c.textAlign = 'center';
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      c.fillText(String(i), x + Math.sin(a) * (r - 18), y - Math.cos(a) * (r - 18) + 6);
    }
    c.fillStyle = '#8f9599';
    c.fillText('ALT', x, y + 26);
  }

  private turn(x: number, y: number, r: number): void {
    const c = this.ctx;
    this.bezel(x, y, r);
    // standard-rate marks for the turn bar, and the slip ball's tube
    for (const s of [-1, 1]) this.tick(x, y, s * (Math.PI / 2 + Math.PI / 12), 44, 54, 3, '#cfd2d4');
    this.tick(x, y, Math.PI / 2, 44, 54, 3, '#6b7175');
    this.tick(x, y, -Math.PI / 2, 44, 54, 3, '#6b7175');
    c.fillStyle = '#0b0c0d';
    c.fillRect(x - 40, y + 28, 80, 18);
    c.strokeStyle = '#3a3f43';
    c.lineWidth = 1.5;
    for (const s of [-1, 1]) {
      c.beginPath();
      c.moveTo(x + s * 10, y + 28);
      c.lineTo(x + s * 10, y + 46);
      c.stroke();
    }
    c.fillStyle = '#8f9599';
    c.font = `600 14px ${FONT}`;
    c.textAlign = 'center';
    c.fillText('TURN · SLIP', x, y - 30);
  }

  /** compass card at north up (the shader turns it) */
  private compass(x: number, y: number, r: number): void {
    const c = this.ctx;
    this.bezel(x, y, r);
    c.save();
    c.translate(x, y);
    for (let i = 0; i < 36; i++) {
      const a = (i / 36) * Math.PI * 2;
      this.tick(0, 0, a, r - (i % 3 === 0 ? 11 : 7), r - 2, i % 3 === 0 ? 2 : 1.5, '#cfd2d4');
    }
    c.fillStyle = '#cfd2d4';
    c.font = `600 16px ${FONT}`;
    c.textAlign = 'center';
    const lbl = ['N', '3', '6', 'E', '12', '15', 'S', '21', '24', 'W', '30', '33'];
    for (let i = 0; i < 12; i++) {
      c.save();
      c.rotate((i / 12) * Math.PI * 2);
      c.fillStyle = i % 3 === 0 ? '#f2a24b' : '#cfd2d4';
      c.fillText(lbl[i], 0, -r + 28);
      c.restore();
    }
    c.restore();
  }

  private vsi(x: number, y: number, r: number): void {
    const c = this.ctx;
    this.bezel(x, y, r);
    for (let v = -2000; v <= 2000; v += 500) this.tick(x, y, vsiAngle(v), r - (v % 1000 === 0 ? 14 : 9), r - 3, 2, '#cfd2d4');
    c.fillStyle = '#cfd2d4';
    c.font = `600 14px ${FONT}`;
    c.textAlign = 'center';
    for (const [v, s] of [[0, '0'], [1000, '1'], [2000, '2'], [-1000, '1']] as const) {
      const a = vsiAngle(v);
      c.fillText(s, x + Math.sin(a) * (r - 24), y - Math.cos(a) * (r - 24) + 5);
    }
    c.fillStyle = '#8f9599';
    c.fillText('VERT SPEED', x + 6, y + 30);
  }
}
