// Canvas HUD: speed/altitude tapes, heading tape, vertical speed, throttle, status chips,
// flight-path marker, target indicator and mode widgets. Device-pixel-ratio aware.
import * as THREE from 'three';
import type { Telemetry } from '../sim/aircraft.ts';
import type { ModeHud } from '../game/modes.ts';
import { AIRCRAFT } from '../sim/config.ts';

const ACC = '#7fdcc0';
const ACC_RGB = '127,220,192';
/** cautions and warnings stay warm so they stand out from the cool accent */
const ALERT = '#f2a24b';
const ALERT_RGB = '242,162,75';
const INK = 'rgba(236,232,224,0.9)';
const MUTED = 'rgba(236,232,224,0.55)';
const FAINT = 'rgba(236,232,224,0.22)';
const PANEL = 'rgba(9,12,16,0.34)';
const FONT = '"Barlow Condensed", "Roboto Condensed", "Arial Narrow", sans-serif';

export interface HudInput {
  tel: Telemetry;
  mode: ModeHud | null;
  camera: THREE.PerspectiveCamera;
  cameraMode: 'chase' | 'cockpit' | 'cinematic' | 'free';
  aircraftPos: THREE.Vector3;
  aircraftVel: THREE.Vector3;
  aircraftQuat: THREE.Quaternion;
  lamp: boolean;
  modelName: string;
  timeOfDay: number;
  windFrom: number;
  windKt: number;
  time: number;
}

const _v = new THREE.Vector3();

export class Hud {
  private readonly ctx: CanvasRenderingContext2D;
  private w = 1;
  private h = 1;
  private dpr = 1;
  private cssW = 1;
  private cssH = 1;
  visible = true;
  private blink = 0;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  /** CSS size of the HUD (from the app's resize observer: reading clientWidth per frame forces layout) */
  setSize(w: number, h: number): void {
    this.cssW = Math.max(1, w);
    this.cssH = Math.max(1, h);
  }

  private resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.cssW;
    const h = this.cssH;
    if (w !== this.w || h !== this.h || dpr !== this.dpr) {
      this.w = w;
      this.h = h;
      this.dpr = dpr;
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
  }

  clear(): void {
    this.resize();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  draw(i: HudInput, dt: number): void {
    this.clear();
    if (!this.visible) return;
    this.blink += dt;
    const c = this.ctx;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.lineCap = 'round';
    c.lineJoin = 'round';
    const W = this.w;
    const H = this.h;
    const small = W < 760;
    const cockpit = i.cameraMode === 'cockpit';
    const cx = W / 2;
    // in the cockpit the lower part of the screen is the instrument panel: keep the HUD above it
    const cy = cockpit ? H * 0.36 : H * 0.5;
    const spread = Math.min(W * 0.27, 330);
    const tapeH = cockpit ? Math.min(H * 0.26, 200) : Math.min(H * 0.38, 290);

    if (i.cameraMode === 'cockpit') this.horizon(i, cx, cy);
    this.flightPath(i);
    if (i.mode?.target) this.target(i);
    if (!small) {
      this.speedTape(i, cx - spread, cy, tapeH);
      this.altTape(i, cx + spread, cy, tapeH);
    } else {
      this.compactReadout(i);
    }
    this.headingTape(i, cx, small ? 76 : 30, Math.min(W * 0.42, 420));
    if (!cockpit) {
      this.throttle(i, small ? 18 : 34, H - (small ? 120 : 150));
      this.chips(i, cx, H - (small ? 22 : 34));
    }
    if (i.mode) this.modeWidget(i.mode, small);
    if (i.mode?.landing && !small) this.landingGuide(i, cx, cy, spread, tapeH);
    const warning = i.tel.stallWarning ? 'STALL' : i.tel.overspeed ? 'OVERSPEED' : '';
    if (warning && Math.floor(this.blink * 3) % 2 === 0) this.text(warning, cx, cy - tapeH * 0.42, 26, ALERT, 'center', 0.32);
    if (i.mode?.prompt) {
      const tone = i.mode.promptTone ?? 'info';
      const col = tone === 'warn' ? ALERT : INK;
      const a = tone === 'warn' ? 0.65 + 0.35 * Math.sin(this.blink * 9) : 1;
      c.globalAlpha = a;
      const py = cockpit ? cy + tapeH * 0.62 : H - (small ? 156 : 86);
      this.textFit(i.mode.prompt.toUpperCase(), cx, py, small ? 15 : 20, col, W - 32, 0.18);
      c.globalAlpha = 1;
    }
  }

  // ---------------------------------------------------------------- primitives

  private text(s: string, x: number, y: number, size: number, col: string, align: CanvasTextAlign = 'left', track = 0.08, weight = 600): void {
    const c = this.ctx;
    c.font = `${weight} ${size}px ${FONT}`;
    c.textAlign = align;
    c.textBaseline = 'middle';
    c.fillStyle = col;
    (c as unknown as { letterSpacing: string }).letterSpacing = `${(size * track).toFixed(1)}px`;
    c.shadowColor = 'rgba(0,0,0,0.55)';
    c.shadowBlur = 8;
    c.fillText(s, x, y);
    c.shadowBlur = 0;
    (c as unknown as { letterSpacing: string }).letterSpacing = '0px';
  }

  /** Soft dark halo behind the next strokes/fills (symbols over bright sky, snow or water). */
  private halo(on: boolean): void {
    this.ctx.shadowColor = 'rgba(0,0,0,0.55)';
    this.ctx.shadowBlur = on ? 5 : 0;
  }

  /** Centred text that wraps onto two balanced lines when it is wider than `maxW`. */
  private textFit(s: string, x: number, y: number, size: number, col: string, maxW: number, track = 0.08): void {
    const c = this.ctx;
    c.font = `600 ${size}px ${FONT}`;
    const width = (t: string) => c.measureText(t).width + t.length * size * track;
    if (width(s) <= maxW) {
      this.text(s, x, y, size, col, 'center', track);
      return;
    }
    const words = s.split(' ');
    let best = 1;
    let bestW = Infinity;
    for (let k = 1; k < words.length; k++) {
      const w = Math.max(width(words.slice(0, k).join(' ')), width(words.slice(k).join(' ')));
      if (w < bestW) {
        bestW = w;
        best = k;
      }
    }
    const fit = bestW > maxW ? Math.max(10, Math.floor((size * maxW) / bestW)) : size;
    const lh = fit * 1.3;
    this.text(words.slice(0, best).join(' '), x, y - lh / 2, fit, col, 'center', track);
    this.text(words.slice(best).join(' '), x, y + lh / 2, fit, col, 'center', track);
  }

  private roundRect(x: number, y: number, w: number, h: number, r: number): void {
    const c = this.ctx;
    // arcTo with a radius larger than half the box draws stray curls
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  /** Vertical tape with values scrolling past a centre window. */
  private tape(x: number, cy: number, h: number, value: number, unitPx: number, minor: number, major: number, label: (v: number) => string, side: 'left' | 'right', markers: { v: number; col: string; shape: 'chevron' | 'bug' | 'band' }[]): void {
    const c = this.ctx;
    const w = 64;
    const x0 = side === 'left' ? x - w : x;
    // soft panel
    const g = c.createLinearGradient(0, cy - h / 2, 0, cy + h / 2);
    g.addColorStop(0, 'rgba(9,12,16,0)');
    g.addColorStop(0.18, PANEL);
    g.addColorStop(0.82, PANEL);
    g.addColorStop(1, 'rgba(9,12,16,0)');
    c.fillStyle = g;
    c.fillRect(x0, cy - h / 2, w, h);
    c.save();
    c.beginPath();
    c.rect(x0 - 40, cy - h / 2, w + 80, h);
    c.clip();
    const span = h / 2 / unitPx;
    const start = Math.floor((value - span) / minor) * minor;
    const edge = side === 'left' ? x : x;
    for (let v = start; v <= value + span; v += minor) {
      const y = cy - (v - value) * unitPx;
      const isMajor = Math.abs(v / major - Math.round(v / major)) < 1e-6;
      const len = isMajor ? 12 : 6;
      const fade = 1 - Math.min(1, Math.abs(y - cy) / (h / 2)) ** 2;
      c.globalAlpha = 0.25 + 0.75 * fade;
      c.strokeStyle = INK;
      c.lineWidth = 1.5;
      c.beginPath();
      if (side === 'left') {
        c.moveTo(edge, y);
        c.lineTo(edge - len, y);
      } else {
        c.moveTo(edge, y);
        c.lineTo(edge + len, y);
      }
      c.stroke();
      if (isMajor && Math.abs(y - cy) > 16) this.text(label(v), side === 'left' ? edge - 18 : edge + 18, y, 14, MUTED, side === 'left' ? 'right' : 'left', 0.04, 500);
    }
    c.globalAlpha = 1;
    for (const m of markers) {
      const y = cy - (m.v - value) * unitPx;
      if (m.shape === 'band') {
        // from the marker value up to the top of the tape, along its edge
        const top = cy - h / 2;
        const bottom = Math.min(y, cy + h / 2);
        if (bottom > top) {
          c.fillStyle = m.col;
          c.fillRect(side === 'left' ? edge - 4 : edge, top, 4, bottom - top);
        }
        continue;
      }
      if (Math.abs(y - cy) > h / 2) continue;
      c.fillStyle = m.col;
      c.beginPath();
      const s = side === 'left' ? 1 : -1;
      if (m.shape === 'bug') {
        c.moveTo(edge + s * 1, y);
        c.lineTo(edge + s * 9, y - 6);
        c.lineTo(edge + s * 9, y + 6);
      } else {
        c.moveTo(edge - s * 2, y - 5);
        c.lineTo(edge - s * 10, y);
        c.lineTo(edge - s * 2, y + 5);
      }
      c.closePath();
      c.fill();
    }
    c.restore();
    // edge line
    c.strokeStyle = FAINT;
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(edge, cy - h / 2 + 20);
    c.lineTo(edge, cy + h / 2 - 20);
    c.stroke();
  }

  private window(x: number, cy: number, text: string, side: 'left' | 'right', sub?: string): void {
    const c = this.ctx;
    const w = 78;
    const h = 34;
    const x0 = side === 'left' ? x - w - 6 : x + 6;
    c.fillStyle = 'rgba(9,12,16,0.72)';
    this.roundRect(x0, cy - h / 2, w, h, 7);
    c.fill();
    c.strokeStyle = ACC;
    c.lineWidth = 1.5;
    c.stroke();
    // pointer notch towards the tape
    c.fillStyle = ACC;
    c.beginPath();
    if (side === 'left') {
      c.moveTo(x - 6, cy - 5);
      c.lineTo(x, cy);
      c.lineTo(x - 6, cy + 5);
    } else {
      c.moveTo(x + 6, cy - 5);
      c.lineTo(x, cy);
      c.lineTo(x + 6, cy + 5);
    }
    c.fill();
    this.text(text, x0 + w / 2, cy + 1, 22, INK, 'center', 0.03);
    if (sub) this.text(sub, x0 + w / 2, cy + h / 2 + 13, 12.5, MUTED, 'center', 0.14);
  }

  // ---------------------------------------------------------------- instruments

  private speedTape(i: HudInput, x: number, cy: number, h: number): void {
    const kt = i.tel.ias * 1.944;
    const stallKt = stallSpeedKt(i.tel.flaps);
    const markers: { v: number; col: string; shape: 'chevron' | 'bug' | 'band' }[] = [
      { v: stallKt, col: `rgba(${ALERT_RGB},0.75)`, shape: 'chevron' },
      // the red line: a band from the never-exceed speed upwards
      { v: AIRCRAFT.vne * 1.944, col: `rgba(${ALERT_RGB},0.85)`, shape: 'band' },
    ];
    if (i.mode?.landing) markers.push({ v: i.mode.landing.targetKt, col: ACC, shape: 'bug' });
    this.tape(x, cy, h, kt, 2.6, 5, 20, (v) => String(Math.max(0, v)), 'left', markers);
    this.window(x, cy, String(Math.max(0, Math.round(kt))), 'left', `GS ${Math.round(i.tel.groundSpeed * 1.944)}`);
    this.text('KT', x - 46, cy - h / 2 - 2, 12, MUTED, 'center', 0.2);
  }

  private altTape(i: HudInput, x: number, cy: number, h: number): void {
    const ft = i.tel.altitude * 3.281;
    this.tape(x, cy, h, ft, 0.13, 100, 500, (v) => String(v), 'right', []);
    const agl = i.tel.agl * 3.281;
    this.window(x, cy, String(Math.round(ft / 10) * 10), 'right', agl < 1500 ? `RA ${Math.max(0, Math.round(agl))}` : undefined);
    this.text('FT', x + 46, cy - h / 2 - 2, 12, MUTED, 'center', 0.2);
    // vertical speed: bar beside the tape
    const fpm = i.tel.vs * 196.85;
    const vx = x + 92;
    const vh = h * 0.42;
    const c = this.ctx;
    c.strokeStyle = FAINT;
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(vx, cy - vh);
    c.lineTo(vx, cy + vh);
    for (const t of [-1, -0.5, 0, 0.5, 1]) {
      c.moveTo(vx - (t === 0 ? 7 : 4), cy - t * vh);
      c.lineTo(vx, cy - t * vh);
    }
    c.stroke();
    const k = Math.sign(fpm) * Math.min(1, Math.sqrt(Math.abs(fpm) / 2000));
    c.strokeStyle = Math.abs(fpm) > 1200 && fpm < 0 && i.tel.agl < 150 ? ALERT : INK;
    c.lineWidth = 3;
    c.beginPath();
    c.moveTo(vx, cy);
    c.lineTo(vx, cy - k * vh);
    c.stroke();
    this.text(`${fpm >= 0 ? '+' : '−'}${Math.abs(Math.round(fpm / 10) * 10)}`, vx + 8, cy - k * vh, 13, INK, 'left', 0.04);
    this.text('FPM', vx, cy + vh + 14, 11, MUTED, 'center', 0.18);
  }

  private headingTape(i: HudInput, cx: number, y: number, w: number): void {
    const c = this.ctx;
    const hdg = i.tel.heading;
    const pxPerDeg = 3.2;
    const g = c.createLinearGradient(cx - w / 2, 0, cx + w / 2, 0);
    g.addColorStop(0, 'rgba(9,12,16,0)');
    g.addColorStop(0.15, PANEL);
    g.addColorStop(0.85, PANEL);
    g.addColorStop(1, 'rgba(9,12,16,0)');
    c.fillStyle = g;
    c.fillRect(cx - w / 2, y - 14, w, 30);
    c.save();
    c.beginPath();
    c.rect(cx - w / 2, y - 30, w, 60);
    c.clip();
    const span = w / 2 / pxPerDeg;
    for (let d = Math.floor((hdg - span) / 5) * 5; d <= hdg + span; d += 5) {
      const x = cx + (d - hdg) * pxPerDeg;
      const dd = ((d % 360) + 360) % 360;
      const major = dd % 30 === 0;
      const fade = 1 - Math.min(1, Math.abs(x - cx) / (w / 2)) ** 2;
      c.globalAlpha = 0.2 + 0.8 * fade;
      c.strokeStyle = INK;
      c.lineWidth = 1.5;
      c.beginPath();
      c.moveTo(x, y + 14);
      c.lineTo(x, y + 14 - (major ? 9 : 5));
      c.stroke();
      if (major && Math.abs(x - cx) > 24) {
        const lbl = dd === 0 ? 'N' : dd === 90 ? 'E' : dd === 180 ? 'S' : dd === 270 ? 'W' : String(dd / 10).padStart(2, '0');
        this.text(lbl, x, y - 4, 14, MUTED, 'center', 0.06, 500);
      }
    }
    c.globalAlpha = 1;
    if (i.mode?.target) {
      const b = Math.max(-span + 4, Math.min(span - 4, i.mode.target.bearing));
      const x = cx + b * pxPerDeg;
      c.fillStyle = ACC;
      c.beginPath();
      c.moveTo(x, y + 14);
      c.lineTo(x - 6, y + 23);
      c.lineTo(x + 6, y + 23);
      c.closePath();
      c.fill();
    }
    c.restore();
    c.fillStyle = 'rgba(9,12,16,0.72)';
    this.roundRect(cx - 28, y - 15, 56, 26, 6);
    c.fill();
    c.strokeStyle = ACC;
    c.lineWidth = 1.5;
    c.stroke();
    this.text(String(Math.round(hdg) % 360).padStart(3, '0'), cx, y - 1, 18, INK, 'center', 0.06);
  }

  private compactReadout(i: HudInput): void {
    const kt = Math.round(i.tel.ias * 1.944);
    const ft = Math.round((i.tel.altitude * 3.281) / 10) * 10;
    const fpm = Math.round((i.tel.vs * 196.85) / 10) * 10;
    this.text(`${kt}`, 18, this.h * 0.5 - 18, 30, INK, 'left', 0.02);
    this.text('KT', 18, this.h * 0.5 + 8, 11, MUTED, 'left', 0.2);
    this.text(`${ft}`, this.w - 18, this.h * 0.5 - 18, 30, INK, 'right', 0.02);
    this.text(`FT · ${fpm >= 0 ? '+' : '−'}${Math.abs(fpm)} FPM`, this.w - 18, this.h * 0.5 + 8, 11, MUTED, 'right', 0.14);
  }

  private throttle(i: HudInput, x: number, y: number): void {
    const c = this.ctx;
    const h = 96;
    c.fillStyle = PANEL;
    this.roundRect(x, y, 10, h, 5);
    c.fill();
    const t = i.tel.throttle;
    if (h * t >= 1) {
      c.fillStyle = ACC;
      this.roundRect(x, y + h * (1 - t), 10, h * t, 5);
      c.fill();
    }
    this.text(`${Math.round(t * 100)}%`, x + 20, y + 10, 20, INK, 'left', 0.03);
    this.text('PWR', x + 20, y + 32, 11.5, MUTED, 'left', 0.2);
    this.text(`${Math.round(i.tel.rpm)}`, x + 20, y + 62, 16, INK, 'left', 0.03, 500);
    this.text('RPM', x + 20, y + 80, 11.5, MUTED, 'left', 0.2);
  }

  private chips(i: HudInput, cx: number, y: number): void {
    const t = i.tel;
    const notch = ['UP', '15°', '30°', '45°'][t.flapNotch] ?? 'UP';
    const items: [string, boolean][] = [
      [`FLAPS ${notch}`, t.flapNotch > 0],
      [t.gear > 0.98 ? 'GEAR DN' : t.gear < 0.02 ? 'GEAR UP' : 'GEAR ···', t.gear > 0.02 && t.gear < 0.98],
    ];
    if (t.brake > 0.05) items.push(['BRAKES', true]);
    if (i.lamp) items.push(['LIGHT', false]);
    items.push([i.modelName.toUpperCase(), false]);
    const c = this.ctx;
    c.font = `600 12.5px ${FONT}`;
    (c as unknown as { letterSpacing: string }).letterSpacing = '2px';
    const widths = items.map(([s]) => c.measureText(s).width + 22);
    (c as unknown as { letterSpacing: string }).letterSpacing = '0px';
    const total = widths.reduce((a, b) => a + b, 0) + (items.length - 1) * 8;
    let x = cx - total / 2;
    items.forEach(([s, hot], k) => {
      const w = widths[k];
      c.fillStyle = hot ? `rgba(${ACC_RGB},0.16)` : PANEL;
      this.roundRect(x, y - 12, w, 24, 12);
      c.fill();
      c.strokeStyle = hot ? `rgba(${ACC_RGB},0.6)` : 'rgba(255,255,255,0.1)';
      c.lineWidth = 1;
      c.stroke();
      this.text(s, x + w / 2, y + 1, 12.5, hot ? ACC : INK, 'center', 0.16);
      x += w + 8;
    });
  }

  private project(p: THREE.Vector3, cam: THREE.PerspectiveCamera): { x: number; y: number; behind: boolean } {
    _v.copy(p).applyMatrix4(cam.matrixWorldInverse);
    const behind = _v.z > -0.1;
    _v.applyMatrix4(cam.projectionMatrix);
    return { x: (_v.x * 0.5 + 0.5) * this.w, y: (0.5 - _v.y * 0.5) * this.h, behind };
  }

  private flightPath(i: HudInput): void {
    if (i.aircraftVel.length() < 12) return;
    const p = _v.copy(i.aircraftVel).normalize().multiplyScalar(400).add(i.aircraftPos);
    const s = this.project(p.clone(), i.camera);
    if (s.behind || s.x < 0 || s.y < 0 || s.x > this.w || s.y > this.h) return;
    const c = this.ctx;
    c.strokeStyle = ACC;
    c.lineWidth = 2;
    c.beginPath();
    c.arc(s.x, s.y, 7, 0, Math.PI * 2);
    c.moveTo(s.x - 7, s.y);
    c.lineTo(s.x - 17, s.y);
    c.moveTo(s.x + 7, s.y);
    c.lineTo(s.x + 17, s.y);
    c.moveTo(s.x, s.y - 7);
    c.lineTo(s.x, s.y - 13);
    this.halo(true);
    c.stroke();
    this.halo(false);
  }

  private horizon(i: HudInput, cx: number, cy: number): void {
    // conformal pitch ladder in the cockpit: lines at fixed pitch angles around the aircraft heading
    const c = this.ctx;
    const cam = i.camera;
    const hdg = (i.tel.heading * Math.PI) / 180;
    const fwd = new THREE.Vector3(Math.sin(hdg), 0, -Math.cos(hdg));
    const right = new THREE.Vector3(Math.cos(hdg), 0, Math.sin(hdg));
    c.lineWidth = 1.5;
    for (const pitch of [-20, -10, -5, 0, 5, 10, 20]) {
      const pr = (pitch * Math.PI) / 180;
      const center = fwd.clone().multiplyScalar(Math.cos(pr)).add(new THREE.Vector3(0, Math.sin(pr), 0)).multiplyScalar(1000).add(cam.position);
      const half = pitch === 0 ? 260 : 60;
      const a = this.project(center.clone().addScaledVector(right, -half), cam);
      const b = this.project(center.clone().addScaledVector(right, half), cam);
      if (a.behind || b.behind) continue;
      c.strokeStyle = pitch === 0 ? `rgba(${ACC_RGB},0.55)` : 'rgba(236,232,224,0.28)';
      c.setLineDash(pitch < 0 ? [6, 6] : []);
      c.beginPath();
      if (pitch === 0) {
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        const dx = (b.x - a.x) / 2;
        const dy = (b.y - a.y) / 2;
        const gap = 0.18;
        c.moveTo(a.x, a.y);
        c.lineTo(mx - dx * gap, my - dy * gap);
        c.moveTo(mx + dx * gap, my + dy * gap);
        c.lineTo(b.x, b.y);
      } else {
        c.moveTo(a.x, a.y);
        c.lineTo(b.x, b.y);
      }
      c.stroke();
      c.setLineDash([]);
      if (pitch !== 0) this.text(`${Math.abs(pitch)}`, b.x + 8, b.y, 12, 'rgba(236,232,224,0.4)', 'left', 0.04, 500);
    }
    void cx;
    void cy;
  }

  private target(i: HudInput): void {
    const t = i.mode!.target!;
    const hdg = ((i.tel.heading + t.bearing) * Math.PI) / 180;
    const el = (t.elevation * Math.PI) / 180;
    const world = new THREE.Vector3(Math.sin(hdg) * Math.cos(el), Math.sin(el), -Math.cos(hdg) * Math.cos(el)).multiplyScalar(t.dist).add(i.aircraftPos);
    const s = this.project(world, i.camera);
    const c = this.ctx;
    const m = 46;
    const on = !s.behind && s.x > m && s.y > m && s.x < this.w - m && s.y < this.h - m;
    const dist = t.dist > 950 ? `${(t.dist / 1000).toFixed(1)} KM` : `${Math.round(t.dist)} M`;
    if (on) {
      const r = 18;
      c.strokeStyle = ACC;
      c.lineWidth = 2;
      c.beginPath();
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        c.moveTo(s.x + sx * r, s.y + sy * (r - 7));
        c.lineTo(s.x + sx * r, s.y + sy * r);
        c.lineTo(s.x + sx * (r - 7), s.y + sy * r);
      }
      this.halo(true);
      c.stroke();
      this.halo(false);
      this.text(t.label, s.x, s.y - r - 12, 15, ACC, 'center', 0.1);
      this.text(dist, s.x, s.y + r + 12, 12, INK, 'center', 0.12);
    } else {
      // arrow on the screen edge, pointing the way to turn
      let ax = s.x - this.w / 2;
      let ay = s.y - this.h / 2;
      if (s.behind) {
        ax = -ax;
        ay = -ay;
        if (Math.abs(ax) < 1 && Math.abs(ay) < 1) ax = t.bearing > 0 ? 1 : -1;
      }
      const ang = Math.atan2(ay, ax);
      const rx = this.w / 2 - m;
      const ry = this.h / 2 - m;
      const k = Math.min(rx / Math.abs(Math.cos(ang) || 1e-6), ry / Math.abs(Math.sin(ang) || 1e-6));
      const px = this.w / 2 + Math.cos(ang) * k;
      const py = this.h / 2 + Math.sin(ang) * k;
      c.save();
      c.translate(px, py);
      c.rotate(ang);
      c.fillStyle = ACC;
      c.beginPath();
      c.moveTo(14, 0);
      c.lineTo(-6, -10);
      c.lineTo(-2, 0);
      c.lineTo(-6, 10);
      c.closePath();
      this.halo(true);
      c.fill();
      this.halo(false);
      c.restore();
      this.text(`${t.label} · ${dist}`, px - Math.cos(ang) * 34, py - Math.sin(ang) * 26, 12.5, INK, 'center', 0.12);
    }
  }

  private landingGuide(i: HudInput, cx: number, cy: number, spread: number, tapeH: number): void {
    const l = i.mode!.landing!;
    const c = this.ctx;
    // glide path: vertical scale left of the altitude tape (±40 m)
    const gx = cx + spread - 24;
    const gh = tapeH * 0.36;
    c.strokeStyle = FAINT;
    c.lineWidth = 1;
    for (const t of [-1, -0.5, 0.5, 1]) {
      c.beginPath();
      c.arc(gx, cy - t * gh, 2.5, 0, Math.PI * 2);
      c.stroke();
    }
    c.beginPath();
    c.moveTo(gx - 8, cy);
    c.lineTo(gx + 8, cy);
    c.stroke();
    const gy = cy + Math.max(-1, Math.min(1, l.glideDev / 40)) * gh;
    c.fillStyle = ACC;
    c.beginPath();
    c.moveTo(gx, gy - 7);
    c.lineTo(gx + 6, gy);
    c.lineTo(gx, gy + 7);
    c.lineTo(gx - 6, gy);
    c.closePath();
    this.halo(true);
    c.fill();
    this.halo(false);
    // centreline: horizontal scale below the centre (±40 m)
    const ly = cy + tapeH * 0.5 + 10;
    const lw = 110;
    c.strokeStyle = FAINT;
    for (const t of [-1, -0.5, 0.5, 1]) {
      c.beginPath();
      c.arc(cx + t * lw, ly, 2.5, 0, Math.PI * 2);
      c.stroke();
    }
    c.beginPath();
    c.moveTo(cx, ly - 8);
    c.lineTo(cx, ly + 8);
    c.stroke();
    const lx = cx - Math.max(-1, Math.min(1, l.centreDev / 40)) * lw;
    c.fillStyle = ACC;
    c.beginPath();
    c.moveTo(lx - 7, ly);
    c.lineTo(lx, ly - 6);
    c.lineTo(lx + 7, ly);
    c.lineTo(lx, ly + 6);
    c.closePath();
    this.halo(true);
    c.fill();
    this.halo(false);
    const d = l.dist > 950 ? `${(l.dist / 1000).toFixed(1)} KM` : `${Math.max(0, Math.round(l.dist))} M`;
    this.text(`THRESHOLD ${d}`, cx, ly + 22, 12.5, INK, 'center', 0.16);
  }

  private modeWidget(m: ModeHud, small: boolean): void {
    const x = small ? 18 : 34;
    const y = small ? 26 : 34;
    this.text(m.title.toUpperCase(), x, y, small ? 12 : 13, MUTED, 'left', 0.24);
    if (m.timer) {
      this.text(m.timer, x - 1, y + (small ? 26 : 32), small ? 28 : 38, INK, 'left', 0.02);
      if (m.timerSub) this.text(m.timerSub.toUpperCase(), x, y + (small ? 50 : 62), small ? 11.5 : 13, ACC, 'left', 0.16);
    }
  }
}

/** Approximate stall speed (kt) for the current flap setting (1 g, mid weight). */
export function stallSpeedKt(flaps: number): number {
  const clmax = AIRCRAFT.surfaces[0].clmax + AIRCRAFT.flapCl * flaps;
  const v = Math.sqrt((2 * AIRCRAFT.mass * 9.81) / (1.225 * AIRCRAFT.wingArea * clmax * 0.92));
  return v * 1.944;
}
