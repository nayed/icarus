// The pause screen's chart: the map image north up, opened on the aircraft, with the strips, the
// ring-run course and the track flown so far. Scroll (or + / −) zooms about the cursor, dragging moves
// the chart, a double-click (or ◎) comes back to the aircraft. Above the chart: the distance and bearing
// from the aircraft to the point under the cursor, or else to the current goal.
import type { App } from '../app.ts';
import {
  drawTerrain, drawStrips, drawGates, drawAircraft, label, toScreen, toWorld, rangeAndBearing, scaleBarLength, type ChartView, type ModeMap,
} from './chart.ts';
import { STRIPS, headingDir } from '../world/params.ts';
import { ACC, ACC_RGB, INK, MUTED } from './palette.ts';

/** metres across the chart: closest zoom, widest zoom, and on opening */
const SPAN_MIN = 3000;
const SPAN_MAX = 48000;
const SPAN_OPEN = 18000;

/** Names on the chart: the first word of each strip's name ("Vika coastal strip" → "VIKA"). */
const STRIP_LABELS = STRIPS.map((s) => s.name.split(' ')[0].toUpperCase());

export class PauseMap {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly readout: HTMLElement;
  private w = 1;
  private h = 1;
  private dpr = 1;
  /** world point at the centre of the chart, and metres across its shorter side */
  private cx = 0;
  private cz = 0;
  private span = SPAN_OPEN;
  private open = false;
  private hover: [number, number] | null = null;
  private drag: { id: number; x: number; y: number; cx: number; cz: number } | null = null;
  private waiting = 0;

  constructor(el: HTMLElement, private readonly app: App) {
    this.canvas = el.querySelector('canvas') as HTMLCanvasElement;
    this.ctx = this.canvas.getContext('2d')!;
    this.readout = el.querySelector('[data-map-readout]') as HTMLElement;
    new ResizeObserver(() => this.draw()).observe(this.canvas);
    const c = this.canvas;
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
        this.zoom(Math.exp(dy * 0.0015), e.offsetX, e.offsetY);
      },
      { passive: false },
    );
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      this.drag = { id: e.pointerId, x: e.offsetX, y: e.offsetY, cx: this.cx, cz: this.cz };
    });
    c.addEventListener('pointermove', (e) => {
      const d = this.drag;
      if (d && d.id === e.pointerId) {
        const k = this.view().scale;
        this.cx = d.cx - (e.offsetX - d.x) / k;
        this.cz = d.cz - (e.offsetY - d.y) / k;
        this.clampCentre();
      }
      this.hover = toWorld(this.view(), e.offsetX, e.offsetY);
      this.draw();
    });
    const end = (e: PointerEvent) => {
      if (this.drag?.id === e.pointerId) this.drag = null;
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => {
      this.hover = null;
      this.draw();
    });
    c.addEventListener('dblclick', () => this.centre());
    el.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('[data-map]') as HTMLElement | null;
      if (!b) return;
      if (b.dataset.map === 'in') this.zoom(1 / 1.6, this.w / 2, this.h / 2);
      else if (b.dataset.map === 'out') this.zoom(1.6, this.w / 2, this.h / 2);
      else this.centre();
    });
  }

  /** Opens on the aircraft at the starting zoom. */
  show(): void {
    this.open = true;
    this.span = SPAN_OPEN;
    this.hover = null;
    this.drag = null;
    this.centre();
  }

  hide(): void {
    this.open = false;
    cancelAnimationFrame(this.waiting);
  }

  /** The view: north up, (cx, cz) in the middle. */
  view(): ChartView {
    return { sx: this.w / 2, sy: this.h / 2, wx: this.cx, wz: this.cz, scale: Math.min(this.w, this.h) / this.span, up: 0 };
  }

  private centre(): void {
    const p = this.app.ac.pos;
    this.cx = p.x;
    this.cz = p.z;
    this.clampCentre();
    this.draw();
  }

  /** Zooms by `f` (> 1 out, < 1 in), keeping the world point under (px, py) where it is. */
  private zoom(f: number, px: number, py: number): void {
    const [wx, wz] = toWorld(this.view(), px, py);
    this.span = Math.min(SPAN_MAX, Math.max(SPAN_MIN, this.span * f));
    const k = this.view().scale;
    this.cx = wx - (px - this.w / 2) / k;
    this.cz = wz - (py - this.h / 2) / k;
    this.clampCentre();
    this.draw();
  }

  /** Keeps the centre over the map image. */
  private clampCentre(): void {
    const m = this.app.world.map;
    if (!m.image) return;
    this.cx = Math.min(m.x0 + m.extent, Math.max(m.x0, this.cx));
    this.cz = Math.min(m.z0 + m.extent, Math.max(m.z0, this.cz));
  }

  draw(): void {
    if (!this.open) return;
    const cv = this.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, cv.clientWidth);
    const h = Math.max(1, cv.clientHeight);
    if (w !== this.w || h !== this.h || dpr !== this.dpr) {
      this.w = w;
      this.h = h;
      this.dpr = dpr;
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    const c = this.ctx;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = '#0b1219';
    c.fillRect(0, 0, w, h);
    const map = this.app.world.map;
    if (!map.image) {
      label(c, 'CHARTING THE FJORD…', w / 2, h / 2, 14, MUTED);
      this.readout.textContent = '';
      // the first map is ready a second or so after the start: draw again when it is
      cancelAnimationFrame(this.waiting);
      this.waiting = requestAnimationFrame(() => {
        if (map.image) this.centre();
        else this.draw();
      });
      return;
    }
    const v = this.view();
    c.imageSmoothingQuality = 'high';
    drawTerrain(c, map, v);
    this.grid(c, v);
    this.track(c, v);
    const mm: ModeMap | undefined = this.app.session?.hud().map;
    drawStrips(c, v, mm?.strip ?? -1);
    STRIPS.forEach((s, i) => {
      // the name beside the runway, off its right-hand side (north up: screen axes are world axes)
      const d = headingDir(s.heading);
      const [x, y] = toScreen(v, s.center[0], s.center[1]);
      label(c, STRIP_LABELS[i], x - d[1] * 16, y + d[0] * 16, 12, i === mm?.strip ? ACC : INK, 'left');
    });
    if (mm?.gates && mm.gateStates) drawGates(c, v, mm.gates, mm.gateStates, true);
    const p = this.app.ac.pos;
    const [ax, ay] = toScreen(v, p.x, p.z);
    // a soft ring makes the aircraft easy to find on a wide chart
    c.beginPath();
    c.arc(ax, ay, 21, 0, Math.PI * 2);
    c.strokeStyle = `rgba(${ACC_RGB},0.35)`;
    c.lineWidth = 1.5;
    c.stroke();
    drawAircraft(c, ax, ay, (this.app.telemetry.heading * Math.PI) / 180, 28);
    this.scaleBar(c, v);
    this.north(c);
    this.readout.textContent = this.hover ? `${rangeAndBearing(p.x, p.z, this.hover[0], this.hover[1])} from the aircraft` : this.goal();
  }

  /** The current goal from the aircraft: the next gate, the strip to land on, or the nearest strip. */
  private goal(): string {
    const p = this.app.ac.pos;
    const mm = this.app.session?.hud().map;
    if (mm?.gates && mm.gateStates) {
      const k = mm.gateStates.indexOf(1);
      if (k >= 0) return `Gate ${k + 1} · ${rangeAndBearing(p.x, p.z, mm.gates[k].x, mm.gates[k].z)}`;
    }
    let i = mm?.strip ?? -1;
    if (i < 0) {
      const d = STRIPS.map((s) => Math.hypot(s.center[0] - p.x, s.center[1] - p.z));
      i = d.indexOf(Math.min(...d));
    }
    const s = STRIPS[i];
    return `${s.name} · ${rangeAndBearing(p.x, p.z, s.center[0], s.center[1])}`;
  }

  /** The track flown this session, faint, ending at the aircraft. */
  private track(c: CanvasRenderingContext2D, v: ChartView): void {
    const t = this.app.track;
    if (t.count < 2) return;
    c.save();
    c.beginPath();
    for (let k = 0; k < t.count; k++) {
      const [x, z] = t.point(k);
      const [sx, sy] = toScreen(v, x, z);
      if (k === 0) c.moveTo(sx, sy);
      else c.lineTo(sx, sy);
    }
    const p = this.app.ac.pos;
    c.lineTo(...toScreen(v, p.x, p.z));
    c.lineJoin = 'round';
    c.strokeStyle = 'rgba(6,8,11,0.5)';
    c.lineWidth = 3.5;
    c.stroke();
    c.strokeStyle = `rgba(${ACC_RGB},0.6)`;
    c.lineWidth = 1.5;
    c.stroke();
    c.restore();
  }

  /** A faint 5 km grid (10 km when zoomed far out). */
  private grid(c: CanvasRenderingContext2D, v: ChartView): void {
    const step = this.span > 30000 ? 10000 : 5000;
    const [x0, z0] = toWorld(v, 0, 0);
    const [x1, z1] = toWorld(v, this.w, this.h);
    c.save();
    c.strokeStyle = 'rgba(236,232,224,0.07)';
    c.lineWidth = 1;
    c.beginPath();
    for (let x = Math.ceil(x0 / step) * step; x <= x1; x += step) {
      const sx = Math.round(toScreen(v, x, 0)[0]) + 0.5;
      c.moveTo(sx, 0);
      c.lineTo(sx, this.h);
    }
    for (let z = Math.ceil(z0 / step) * step; z <= z1; z += step) {
      const sy = Math.round(toScreen(v, 0, z)[1]) + 0.5;
      c.moveTo(0, sy);
      c.lineTo(this.w, sy);
    }
    c.stroke();
    c.restore();
  }

  /** Scale bar in the lower left, a round length near a fifth of the width. */
  private scaleBar(c: CanvasRenderingContext2D, v: ChartView): void {
    const len = scaleBarLength(this.w / 5 / v.scale);
    const px = len * v.scale;
    const x = 16;
    const y = this.h - 18;
    c.save();
    c.beginPath();
    c.moveTo(x, y - 5);
    c.lineTo(x, y);
    c.lineTo(x + px, y);
    c.lineTo(x + px, y - 5);
    c.strokeStyle = 'rgba(6,8,11,0.8)';
    c.lineWidth = 4;
    c.stroke();
    c.strokeStyle = INK;
    c.lineWidth = 1.5;
    c.stroke();
    c.restore();
    label(c, len >= 1000 ? `${len / 1000} KM` : `${len} M`, x + px + 8, y - 2, 11.5, INK, 'left');
  }

  /** North arrow in the upper left (the zoom buttons are on the right). */
  private north(c: CanvasRenderingContext2D): void {
    const x = 22;
    const y = 24;
    c.save();
    c.beginPath();
    c.moveTo(x, y - 12);
    c.lineTo(x + 6, y + 4);
    c.lineTo(x, y);
    c.lineTo(x - 6, y + 4);
    c.closePath();
    c.fillStyle = INK;
    c.shadowColor = 'rgba(0,0,0,0.6)';
    c.shadowBlur = 4;
    c.fill();
    c.restore();
    label(c, 'N', x, y + 14, 11.5, INK);
  }
}
