// The ring-run circuits, 14 gates each. Fjordruta runs down the main fjord and into the north arm,
// generated from the fjord polylines and recentred on the actual water in each cross-section.
// Tinderunden goes round the highest summit (1530 m) at 800–1190 m, through the pass and the saddle
// between it and the ridges around it: placed by hand, each gate as low as the ground under it and
// the legs to it allow, and no leg climbing more than 7 % (the aircraft climbs at about 11 %).
// tests/game.test.ts checks both for clearance and flies them with the autopilot.
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

export type CourseId = 'fjord' | 'summits';

export interface CourseDef {
  id: CourseId;
  name: string;
  /** one line for the menu */
  blurb: string;
}

export const COURSES: readonly CourseDef[] = [
  { id: 'fjord', name: 'Fjordruta', blurb: 'Down the fjord and into the north arm, low over the water.' },
  { id: 'summits', name: 'Tinderunden', blurb: 'Round the highest summit, through its passes, a thousand metres up.' },
];

export function courseDef(id: CourseId): CourseDef {
  return COURSES.find((c) => c.id === id) ?? COURSES[0];
}

/**
 * Tinderunden's gates (x, height, z), clockwise round the summit: up from the main fjord into the high
 * basin south of it, through the pass between it and the south-west ridge, north along its west wall
 * above the north arm, across the arm into the valley behind it, and back south through the saddle
 * north-east of it into the basin.
 */
const SUMMIT_GATES: readonly [number, number, number][] = [
  [13300, 1075, -400], [12800, 1165, -1600], [12250, 1040, -2900], [11600, 980, -3900], [11500, 875, -5100],
  [12300, 805, -6300], [13400, 895, -7000], [14500, 975, -7000], [15500, 985, -6500], [15700, 1055, -5500],
  [15200, 1135, -4500], [15200, 1185, -3300], [14400, 1075, -2400], [14500, 975, -1300],
];

/** Gates through the points (x, y, z), each facing along the line from the gate before it to the one after. */
function gatesThrough(pts: readonly (readonly [number, number, number])[]): Gate[] {
  return pts.map(([x, y, z], i) => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = b[0] - a[0];
    const dz = b[2] - a[2];
    const l = Math.hypot(dx, dz) || 1;
    return { x, y, z, nx: dx / l, nz: dz / l, radius: GATE_RADIUS };
  });
}

const cached = new Map<CourseId, Gate[]>();

export function buildCourse(id: CourseId = 'fjord'): Gate[] {
  let gates = cached.get(id);
  if (!gates) cached.set(id, (gates = id === 'summits' ? gatesThrough(SUMMIT_GATES) : fjordGates()));
  return gates;
}

/** Where a run starts: 1500 m short of the first gate, 10 m above it, flying through it. */
export function courseStart(gates: readonly Gate[]): { x: number; y: number; z: number; heading: number } {
  const g = gates[0];
  return { x: g.x - g.nx * 1500, y: g.y + 10, z: g.z - g.nz * 1500, heading: ((Math.atan2(g.nx, -g.nz) * 180) / Math.PI + 360) % 360 };
}

function fjordGates(): Gate[] {
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
  return gatesThrough(raw.map((g, i) => [g.x, SEA_LEVEL + HEIGHTS[i], g.z] as const));
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
