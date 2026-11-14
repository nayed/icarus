// The ring-run circuits (COURSES, in the order the menu shows them). Fjordruta runs down the main fjord and into the north arm,
// generated from the fjord polylines and recentred on the actual water in each cross-section.
// Tinderunden goes round the highest summit (1530 m) at 800–1190 m, through the pass and the saddle
// between it and the ridges around it: placed by hand, each gate as low as the ground under it and
// the legs to it allow, and no leg climbing more than 7 % (the aircraft climbs at about 11 %).
// Holmeleia goes round the big island off the coast at 55–70 m over the sea, Gjelet down a narrow
// gorge, Plaskruta up the main fjord with splash lanes to touch the water in, and Postruta is a mail
// run from one strip to another, all placed by hand.
// tests/game.test.ts checks both for clearance and flies them with the autopilot.
import { FJORDS, SEA_LEVEL, STRIPS, headingDir, type StripDef } from '../world/params.ts';
import { landingAim } from '../sim/scenarios.ts';
import { terrainHeight } from '../world/terrain.ts';

export interface Gate {
  x: number;
  y: number;
  z: number;
  /** unit flight direction through the gate (horizontal) */
  nx: number;
  nz: number;
  radius: number;
  /**
   * A splash lane instead of a ring: water `half` metres either side of (x, z) along (nx, nz) and
   * `halfWidth` across it, marked by buoys, at the water (y = 0). The floats touch down in it, gear
   * up, and the aircraft takes off again before it ends.
   */
  lane?: { half: number; halfWidth: number };
}

/** A splash lane's size (m): 700 m long, 60 m wide. */
export const LANE = { half: 350, halfWidth: 30 };

/** Where a gate is flown into and out of: its middle, or a lane's near and far ends. */
export function gateEnds(g: Gate): { entry: { x: number; z: number }; exit: { x: number; z: number } } {
  const h = g.lane?.half ?? 0;
  return { entry: { x: g.x - g.nx * h, z: g.z - g.nz * h }, exit: { x: g.x + g.nx * h, z: g.z + g.nz * h } };
}

/** The fjord circuit's gate count (the others have their own). */
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

export type CourseId = 'fjord' | 'summits' | 'islands' | 'gorge' | 'splash' | 'mail';

export interface CourseDef {
  id: CourseId;
  name: string;
  /** one line for the menu */
  blurb: string;
  /**
   * A mail run: it starts on the runway of `from`, taking off along `departure`, and ends with the
   * landing on `to`, along its heading, graded with the time.
   */
  mail?: { from: StripDef['id']; departure: number; to: StripDef['id'] };
}

export const COURSES: readonly CourseDef[] = [
  { id: 'fjord', name: 'Fjordruta', blurb: 'Down the fjord and into the north arm, low over the water.' },
  { id: 'summits', name: 'Tinderunden', blurb: 'Round the highest summit, through its passes, 3,300 feet up.' },
  { id: 'islands', name: 'Holmeleia', blurb: 'Round the big island off the coast and through the sounds, low over the open sea.' },
  { id: 'gorge', name: 'Gjelet', blurb: 'Down a narrow gorge from its head to the fjord, weaving low between walls 2,300 feet high.' },
  {
    id: 'splash',
    name: 'Plaskruta',
    blurb: 'Up the main fjord toward Botn, low over the water, with three splash lanes: gear up, touch down between the buoys, and go again.',
  },
  {
    id: 'mail',
    name: 'Postruta',
    blurb: 'The mail run: off the Hestskar mountain strip, down past the coast to the lakes, then land on the Vatne strip. Graded on the time and the landing.',
    mail: { from: 'mountain', departure: 240, to: 'south' },
  },
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

/**
 * Holmeleia's gates (x, height, z), clockwise round the hook-shaped island off the fjord's mouth, 300 to
 * 650 m off its shores and 55–70 m over the sea: west through the sound between it and the round island
 * to its south, through the gap by the islet south-west of it, north along its west coast, round its
 * head, and back south down its east side.
 */
const ISLAND_GATES: readonly [number, number, number][] = [
  [-7300, 60, 3050], [-8300, 55, 3130], [-9400, 60, 3400], [-10400, 65, 2950], [-10450, 55, 1900],
  [-10450, 55, 800], [-10850, 60, -150], [-11950, 70, -800], [-11850, 60, -2000], [-10650, 55, -2650],
  [-9350, 65, -2500], [-8150, 60, -2000], [-7600, 55, -850], [-7800, 55, 450],
];

/**
 * Gjelet's gates (x, height, z), down the narrow arm south-east of the main fjord, from the head of its
 * gorge to its mouth on the southern fjord: 500–900 m wide between walls 600–870 m high, the gates
 * weaving 60 m either side of the middle, 620 m apart, 55–65 m over the water after the first two drop
 * into it. The run starts over the dry head of the valley.
 */
const GORGE_GATES: readonly [number, number, number][] = [
  [28311, 160, 21007], [27894, 110, 20543], [27615, 70, 19980], [27200, 60, 19520], [26951, 55, 18931],
  [26558, 60, 18405], [26449, 65, 17756], [26113, 55, 17233], [25882, 60, 16653], [25406, 55, 16208],
  [25210, 65, 15607], [24848, 60, 15099], [24652, 55, 14499], [24656, 60, 13787],
];

/**
 * Plaskruta's gates (x, height, z) and splash lanes (height 0), up the eastern half of the main fjord
 * from the junction toward Botn, where the water is sheltered (a quarter of the open sea's waves): the
 * rings weave 120 m either side of the water's middle, 50–60 m over it, lined up with the lanes before
 * and after them. The water is 900–1300 m wide and 70–100 m deep at the lanes.
 */
const SPLASH_GATES: readonly [number, number, number][] = [
  [9370, 60, 348], [10432, 50, 28], [11602, 0, 46], [12538, 50, 203], [13550, 60, 659], [14648, 50, 843],
  [15724, 0, 772], [16791, 50, 489], [17636, 60, -77], [18595, 50, -615], [19610, 0, -1072], [20714, 50, -1335],
  [21764, 60, -1667], [22628, 50, -2223],
];
/** which of them are splash lanes */
const SPLASH_LANES = [2, 6, 10];

/**
 * Postruta's gates (x, height, z), from the Hestskar mountain strip (798 m) to the Vatne lake strip
 * (95 m): down across the main fjord's mouth and the coastal plain past Vika, over the bay, south along
 * the peninsula's west coast and round its tip, across the southern fjord and up the channel to the
 * lake, the last gate on the final, 2.8 km out on the 4° glide path. No leg dives more than 8.5 %.
 */
const MAIL_GATES: readonly [number, number, number][] = [
  [4300, 900, 1100], [3250, 830, 2050], [2350, 730, 3150], [1600, 620, 4300], [850, 510, 5400],
  [-150, 410, 6450], [-1300, 320, 7300], [-2250, 240, 8400], [-2450, 190, 9750], [-2150, 160, 11050],
  [-1200, 160, 12150], [-650, 180, 13350], [-700, 230, 14450], [-529, 293, 15309],
];

/** Index into STRIPS of a strip id. */
export function stripIndex(id: StripDef['id']): number {
  return STRIPS.findIndex((s) => s.id === id);
}

/** Where a landing on strip i aims to touch down: the landing mode's aim point, along the strip's heading. */
export function landingPoint(i: number): { x: number; z: number } {
  const s = STRIPS[i];
  const d = headingDir(s.heading);
  const back = s.halfLength - landingAim(s);
  return { x: s.center[0] - d[0] * back, z: s.center[1] - d[1] * back };
}

/**
 * Gates through the points (x, y, z), each facing along the line from the gate before it to the one
 * after (or to `after` for the last one); the points at `lanes` are splash lanes.
 */
function gatesThrough(pts: readonly (readonly [number, number, number])[], after?: { x: number; z: number }, lanes: readonly number[] = []): Gate[] {
  return pts.map(([x, y, z], i) => {
    const a = pts[Math.max(0, i - 1)];
    const b = i === pts.length - 1 && after ? [after.x, 0, after.z] : pts[Math.min(pts.length - 1, i + 1)];
    const dx = b[0] - a[0];
    const dz = b[2] - a[2];
    const l = Math.hypot(dx, dz) || 1;
    const g: Gate = { x, y, z, nx: dx / l, nz: dz / l, radius: GATE_RADIUS };
    if (lanes.includes(i)) g.lane = LANE;
    return g;
  });
}

const cached = new Map<CourseId, Gate[]>();

export function buildCourse(id: CourseId = 'fjord'): Gate[] {
  let gates = cached.get(id);
  if (!gates) {
    gates =
      id === 'summits' ? gatesThrough(SUMMIT_GATES)
        : id === 'islands' ? gatesThrough(ISLAND_GATES)
          : id === 'gorge' ? gatesThrough(GORGE_GATES)
            : id === 'splash' ? gatesThrough(SPLASH_GATES, undefined, SPLASH_LANES)
          : id === 'mail' ? gatesThrough(MAIL_GATES, landingPoint(stripIndex('south')))
            : fjordGates();
    cached.set(id, gates);
  }
  return gates;
}

/**
 * A circuit's par (s): its gates flown at about 105 kt (coursePar), and on a mail run the final from
 * the last gate to the touchdown at about 64 kt.
 */
export function parFor(id: CourseId): number {
  const gates = buildCourse(id);
  const mail = courseDef(id).mail;
  if (!mail) return coursePar(gates);
  const g = gates[gates.length - 1];
  const p = landingPoint(stripIndex(mail.to));
  return coursePar(gates) + Math.round(Math.hypot(p.x - g.x, p.z - g.z) / 33);
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

/**
 * Smallest clearance of the gate rings and of the straight legs between gates above terrain/water.
 * A leg to or from a splash lane runs from the gate to the lane's near end, or from its far end, down
 * to the water or up from it: only the land under it counts.
 */
export function courseClearance(gates: Gate[]): { ring: number; leg: number; worstGate: number; worstLeg: number } {
  let ring = Infinity;
  let leg = Infinity;
  let worstGate = -1;
  let worstLeg = -1;
  gates.forEach((g, i) => {
    // ring circle lies in the plane spanned by the side vector and up
    const sx = -g.nz;
    const sz = g.nx;
    for (let k = 0; k < 24 && !g.lane; k++) {
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
      const a = gateEnds(p).exit;
      const b = gateEnds(g).entry;
      const splash = !!(p.lane || g.lane);
      for (let t = 0; t <= 1; t += 0.02) {
        const x = a.x + (b.x - a.x) * t;
        const z = a.z + (b.z - a.z) * t;
        const y = p.y + (g.y - p.y) * t;
        const h = terrainHeight(x, z, 6);
        if (splash && h <= SEA_LEVEL) continue;
        const c = y - Math.max(h, SEA_LEVEL);
        if (c < leg) {
          leg = c;
          worstLeg = i;
        }
      }
    }
  });
  return { ring, leg, worstGate, worstLeg };
}

/** A splash lane's shallowest water (m deep) over its length and width, and 300 m before it. */
export function laneDepth(g: Gate): number {
  if (!g.lane) return Infinity;
  const { half, halfWidth } = g.lane;
  let depth = Infinity;
  for (let a = -half - 300; a <= half; a += 25) {
    for (const b of [-halfWidth, 0, halfWidth]) depth = Math.min(depth, SEA_LEVEL - terrainHeight(g.x + g.nx * a - g.nz * b, g.z + g.nz * a + g.nx * b, 7));
  }
  return depth;
}

/** Course length along the gates (m). */
export function courseLength(gates: Gate[]): number {
  let l = 0;
  for (let i = 1; i < gates.length; i++) l += Math.hypot(gates[i].x - gates[i - 1].x, gates[i].y - gates[i - 1].y, gates[i].z - gates[i - 1].z);
  return l;
}

/**
 * Par time: the course flown at ~105 kt with some allowance for the turns, and 30 s for each splash
 * lane (slowing down for it, the touchdown, speeding up again).
 */
export function coursePar(gates: Gate[]): number {
  return Math.round((courseLength(gates) / 54) * 1.08) + 30 * gates.filter((g) => g.lane).length;
}
