// Map drawing shared by the HUD's moving map and the pause screen's chart: the baked terrain, the
// airstrips, the ring-run gates and the aircraft, all through one view transform.
import { STRIPS, headingDir } from '../world/params.ts';
import type { WorldMap } from '../render/worldMap.ts';
import type { Gate } from '../game/course.ts';
import { ACC, ALERT_RGB, INK, FONT } from './palette.ts';

/** How the world is laid onto the canvas. */
export interface ChartView {
  /** canvas point (CSS px) where the world point (wx, wz) is drawn */
  sx: number;
  sy: number;
  wx: number;
  wz: number;
  /** CSS px per metre */
  scale: number;
  /** compass direction at the top of the view (radians): 0 for north up, the heading for heading up */
  up: number;
}

/** What a game mode adds to the map: the course with each gate's state, or the strip to land on. */
export interface ModeMap {
  gates?: readonly Gate[];
  /** per gate: 0 ahead, 1 next, 2 passed, 3 missed */
  gateStates?: readonly number[];
  /** index into STRIPS */
  strip?: number;
}

/** Canvas position of the world point (x, z). */
export function toScreen(v: ChartView, x: number, z: number): [number, number] {
  const dx = (x - v.wx) * v.scale;
  const dz = (z - v.wz) * v.scale;
  const c = Math.cos(v.up);
  const s = Math.sin(v.up);
  return [v.sx + dx * c + dz * s, v.sy - dx * s + dz * c];
}

/** World position under a canvas point (the inverse of toScreen). */
export function toWorld(v: ChartView, px: number, py: number): [number, number] {
  const a = px - v.sx;
  const b = py - v.sy;
  const c = Math.cos(v.up);
  const s = Math.sin(v.up);
  return [v.wx + (a * c - b * s) / v.scale, v.wz + (a * s + b * c) / v.scale];
}

/** Canvas rotation (radians, clockwise) of something pointing along a compass heading (radians). */
export function screenAngle(v: ChartView, heading: number): number {
  return heading - v.up;
}

/** The baked terrain image. */
export function drawTerrain(c: CanvasRenderingContext2D, map: WorldMap, v: ChartView): void {
  if (!map.image) return;
  c.save();
  c.translate(v.sx, v.sy);
  c.rotate(-v.up);
  c.scale(v.scale, v.scale);
  c.translate(-v.wx, -v.wz);
  c.drawImage(map.image, map.x0, map.z0, map.extent, map.extent);
  c.restore();
}

/** The airstrips as runway bars; `highlight` (an index into STRIPS) is drawn in the accent. */
export function drawStrips(c: CanvasRenderingContext2D, v: ChartView, highlight = -1): void {
  c.save();
  c.lineCap = 'butt';
  STRIPS.forEach((s, i) => {
    const d = headingDir(s.heading);
    // never shorter than 8 px or thinner than 3 px, whatever the scale
    const half = Math.max(s.halfLength, 4 / v.scale);
    const [ax, ay] = toScreen(v, s.center[0] - d[0] * half, s.center[1] - d[1] * half);
    const [bx, by] = toScreen(v, s.center[0] + d[0] * half, s.center[1] + d[1] * half);
    const w = Math.max(3, s.halfWidth * 2 * v.scale);
    c.beginPath();
    c.moveTo(ax, ay);
    c.lineTo(bx, by);
    c.strokeStyle = 'rgba(6,8,11,0.85)';
    c.lineWidth = w + 3;
    c.stroke();
    c.strokeStyle = i === highlight ? ACC : 'rgba(236,232,224,0.92)';
    c.lineWidth = w;
    c.stroke();
  });
  c.restore();
}

/** The ring-run course: gates still to fly as bars across the flight path, the next one ringed. */
export function drawGates(c: CanvasRenderingContext2D, v: ChartView, gates: readonly Gate[], states: readonly number[], labels = false): void {
  c.save();
  // the course still to fly, dashed
  c.beginPath();
  let started = false;
  gates.forEach((g, k) => {
    if (states[k] >= 2) return;
    const [x, y] = toScreen(v, g.x, g.z);
    if (started) c.lineTo(x, y);
    else c.moveTo(x, y);
    started = true;
  });
  c.setLineDash([3, 4]);
  c.strokeStyle = 'rgba(236,232,224,0.32)';
  c.lineWidth = 1.2;
  c.stroke();
  c.setLineDash([]);
  c.lineCap = 'round';
  gates.forEach((g, k) => {
    const st = states[k];
    if (st === 2) return;
    const [x, y] = toScreen(v, g.x, g.z);
    const half = Math.max(4, g.radius * v.scale);
    c.save();
    c.translate(x, y);
    c.rotate(screenAngle(v, Math.atan2(g.nx, -g.nz)));
    c.beginPath();
    c.moveTo(-half, 0);
    c.lineTo(half, 0);
    c.strokeStyle = 'rgba(6,8,11,0.7)';
    c.lineWidth = st === 1 ? 5.5 : 4.5;
    c.stroke();
    c.strokeStyle = st === 1 ? ACC : st === 3 ? `rgba(${ALERT_RGB},0.8)` : INK;
    c.lineWidth = st === 1 ? 3 : 2;
    c.stroke();
    c.restore();
    if (st === 1) {
      c.beginPath();
      c.arc(x, y, half + 4, 0, Math.PI * 2);
      c.strokeStyle = ACC;
      c.lineWidth = 1.5;
      c.stroke();
    }
    if (labels) label(c, String(k + 1), x, y - half - (st === 1 ? 14 : 10), 12, st === 1 ? ACC : INK);
  });
  c.restore();
}

/** The aircraft from above, pointing along `rot` (canvas radians, 0 = up); `span` in CSS px. */
export function drawAircraft(c: CanvasRenderingContext2D, x: number, y: number, rot: number, span: number, fill = ACC): void {
  // right half of the outline in half-wingspans: the game model's proportions, a little thickened
  const P = [[0.12, -0.7], [0.13, -0.26], [1, -0.26], [1, 0.08], [0.12, 0.08], [0.07, 0.6], [0.4, 0.64], [0.4, 0.84], [0, 0.88]];
  const k = span / 2;
  c.save();
  c.translate(x, y);
  c.rotate(rot);
  c.scale(k, k);
  c.beginPath();
  c.moveTo(0, -0.9);
  for (const [px, py] of P) c.lineTo(px, py);
  for (let i = P.length - 2; i >= 0; i--) c.lineTo(-P[i][0], P[i][1]);
  c.closePath();
  c.shadowColor = 'rgba(0,0,0,0.6)';
  c.shadowBlur = 5;
  c.fillStyle = fill;
  c.fill();
  c.shadowBlur = 0;
  c.lineWidth = 1 / k;
  c.strokeStyle = 'rgba(6,8,11,0.75)';
  c.stroke();
  c.restore();
}

/** Small condensed caption with a soft shadow, centred on (x, y). */
export function label(c: CanvasRenderingContext2D, s: string, x: number, y: number, size: number, col: string, align: CanvasTextAlign = 'center'): void {
  c.save();
  c.font = `600 ${size}px ${FONT}`;
  (c as unknown as { letterSpacing: string }).letterSpacing = `${(size * 0.12).toFixed(1)}px`;
  c.textAlign = align;
  c.textBaseline = 'middle';
  c.shadowColor = 'rgba(0,0,0,0.75)';
  c.shadowBlur = 5;
  c.fillStyle = col;
  c.fillText(s, x, y);
  c.restore();
}
