// Ring course: 14 gates down the main fjord and into the north arm. Generated from the fjord
// polylines, recentred on the actual water in each cross-section, then validated for clearance.
import { FJORDS, SEA_LEVEL } from '../world/params.ts';
import { terrainHeight } from '../world/terrain.ts';

export interface Gate {
  x: number;
  y: number;
  z: number;
  /** unit flight direction through the gate (horizontal) */
  nx: number;
  nz: number;
  radius: number;
}

export const GATE_COUNT = 14;
export const GATE_RADIUS = 22;
const HEIGHTS = [85, 110, 75, 135, 95, 70, 120, 90, 150, 105, 75, 125, 95, 80];

/** The path: main fjord from its mouth to the junction, then up the north arm. */
function pathPoints(): [number, number][] {
  const main = FJORDS[0].points;
  const north = FJORDS[1].points;
  return [...main.slice(2, 6), ...north.slice(0, 3)] as [number, number][];
}

function samplePath(pts: [number, number][], s: number): { x: number; z: number; tx: number; tz: number } {
  let acc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[i + 1];
    const len = Math.hypot(bx - ax, bz - az);
    if (acc + len >= s || i === pts.length - 2) {
      const t = Math.min(1, Math.max(0, (s - acc) / len));
      return { x: ax + (bx - ax) * t, z: az + (bz - az) * t, tx: (bx - ax) / len, tz: (bz - az) / len };
    }
    acc += len;
  }
  return { x: pts[0][0], z: pts[0][1], tx: 1, tz: 0 };
}

/** Water centre and width of the fjord across (x, z) along the normal (nx, nz). */
export function waterSection(x: number, z: number, nx: number, nz: number): { cx: number; cz: number; width: number } {
  const step = 15;
  const R = 1100;
  let best = 0;
  let bestH = Infinity;
  for (let o = -R; o <= R; o += step) {
    const h = terrainHeight(x + nx * o, z + nz * o, 6);
    if (h < bestH) {
      bestH = h;
      best = o;
    }
  }
  let lo = best;
  let hi = best;
  while (lo - step >= -R && terrainHeight(x + nx * (lo - step), z + nz * (lo - step), 6) < SEA_LEVEL) lo -= step;
  while (hi + step <= R && terrainHeight(x + nx * (hi + step), z + nz * (hi + step), 6) < SEA_LEVEL) hi += step;
  const mid = (lo + hi) / 2;
  return { cx: x + nx * mid, cz: z + nz * mid, width: hi - lo };
}

let cached: Gate[] | null = null;

export function buildCourse(): Gate[] {
  if (cached) return cached;
  const pts = pathPoints();
  const start = 500;
  const spacing = 950;
  const raw: { x: number; z: number; width: number }[] = [];
  for (let i = 0; i < GATE_COUNT; i++) {
    const p = samplePath(pts, start + i * spacing);
    const w = waterSection(p.x, p.z, -p.tz, p.tx);
    // slalom: alternate sides, staying well inside the water
    const side = i === 0 || i === GATE_COUNT - 1 ? 0 : i % 2 ? 1 : -1;
    const off = side * Math.min(0.2 * w.width, 170);
    raw.push({ x: w.cx - p.tz * off, z: w.cz + p.tx * off, width: w.width });
  }
  const gates: Gate[] = raw.map((g, i) => {
    const a = raw[Math.max(0, i - 1)];
    const b = raw[Math.min(GATE_COUNT - 1, i + 1)];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l = Math.hypot(dx, dz) || 1;
    return { x: g.x, y: SEA_LEVEL + HEIGHTS[i], z: g.z, nx: dx / l, nz: dz / l, radius: GATE_RADIUS };
  });
  cached = gates;
  return gates;
}

/** Smallest clearance of the gate rings and of the straight legs between gates above terrain/water. */
export function courseClearance(gates: Gate[]): { ring: number; leg: number; worstGate: number; worstLeg: number } {
  let ring = Infinity;
  let leg = Infinity;
  let worstGate = -1;
  let worstLeg = -1;
  gates.forEach((g, i) => {
    // ring circle lies in the plane spanned by the side vector and up
    const sx = -g.nz;
    const sz = g.nx;
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      const px = g.x + sx * Math.cos(a) * g.radius;
      const pz = g.z + sz * Math.cos(a) * g.radius;
      const py = g.y + Math.sin(a) * g.radius;
      const c = py - Math.max(terrainHeight(px, pz, 7), SEA_LEVEL);
      if (c < ring) {
        ring = c;
        worstGate = i;
      }
    }
    if (i > 0) {
      const p = gates[i - 1];
      for (let t = 0; t <= 1; t += 0.02) {
        const x = p.x + (g.x - p.x) * t;
        const z = p.z + (g.z - p.z) * t;
        const y = p.y + (g.y - p.y) * t;
        const c = y - Math.max(terrainHeight(x, z, 6), SEA_LEVEL);
        if (c < leg) {
          leg = c;
          worstLeg = i;
        }
      }
    }
  });
  return { ring, leg, worstGate, worstLeg };
}

/** Course length along the gates (m). */
export function courseLength(gates: Gate[]): number {
  let l = 0;
  for (let i = 1; i < gates.length; i++) l += Math.hypot(gates[i].x - gates[i - 1].x, gates[i].y - gates[i - 1].y, gates[i].z - gates[i - 1].z);
  return l;
}

/** Par time: the course flown at ~105 kt with some allowance for the turns. */
export function coursePar(gates: Gate[]): number {
  return Math.round((courseLength(gates) / 54) * 1.08);
}
