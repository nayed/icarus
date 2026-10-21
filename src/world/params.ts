// Single source of truth for world constants. Used by the CPU terrain code and
// injected into GLSL as #defines / const arrays so both sides compute the same thing.

export type Vec2 = readonly [number, number];

/** World axes: +x east, +z south (three.js default, -z is north), +y up. Metres. */
export const SEED = 1337;

export const SEA_LEVEL = 0;

/** Base spacing of the finest terrain clipmap level, in metres (power of two). */
export const TERRAIN_BASE_SPACING = 1;

/** Max fbm octaves at the finest level; each coarser level drops one. */
export const TERRAIN_OCTAVES = 11;
export const TERRAIN_MIN_OCTAVES = 3;

/** A fjord is carved along a polyline; floors rise near the polyline's inland end. */
export interface FjordDef {
  points: Vec2[];
  /** half-width of the flat bottom at the mouth and at the head, metres */
  widthMouth: number;
  widthHead: number;
  /** water depth of the floor at the mouth and head (negative = below sea level) */
  floorMouth: number;
  floorHead: number;
  /** open at both ends (a sound between two waters): no dry valley past the last point */
  open?: boolean;
  /** 0..1.5: how much the width wanders and the shore breaks into coves and points */
  rough?: number;
}

export const FJORDS: FjordDef[] = [
  {
    // Main fjord: from the open sea in the west, winding east into the mountains.
    points: [
      [-3800, 2300], [-2500, 1900], [600, 1500], [3500, 2700], [6400, 2400], [8900, 800],
      [11800, -200], [14700, 900], [17600, 400], [20200, -1300], [22600, -2400], [24800, -2600],
    ],
    widthMouth: 1250, widthHead: 520, floorMouth: -150, floorHead: -70,
  },
  {
    // North arm, branching at the first big bend.
    points: [[8900, 800], [10200, -1900], [11000, -4800], [12600, -7400], [13200, -9200]],
    widthMouth: 720, widthHead: 420, floorMouth: -160, floorHead: -50,
  },
  {
    // South arm.
    points: [[14700, 900], [15900, 3400], [16300, 6200], [17600, 8200]],
    widthMouth: 640, widthHead: 380, floorMouth: -140, floorHead: -40,
  },
  // The main fjord system above shapes the mountains around it (RELIEF_FJORDS); the fjords, sound and
  // lakes below are carved into them, with rough shores.
  {
    // Northern fjord: the longest, from the coast to the eastern mountains, and its three arms.
    points: [[-6500, -12500], [-3000, -12000], [1500, -13300], [6000, -12200], [10000, -14000], [14500, -15800], [19500, -15200], [24000, -17200], [28500, -19600]],
    widthMouth: 1100, widthHead: 480, floorMouth: -180, floorHead: -70, rough: 1,
  },
  { points: [[14500, -15800], [16200, -19500], [17500, -23500]], widthMouth: 650, widthHead: 380, floorMouth: -150, floorHead: -50, rough: 1 },
  { points: [[6000, -12200], [7800, -9000], [8300, -6500]], widthMouth: 600, widthHead: 380, floorMouth: -140, floorHead: -50, rough: 1 },
  { points: [[19500, -15200], [22500, -12000], [24500, -9000]], widthMouth: 600, widthHead: 380, floorMouth: -140, floorHead: -50, rough: 1 },
  {
    // Southern fjord and its three arms.
    points: [[-6500, 12200], [-2500, 11800], [2000, 12600], [6500, 11400], [11000, 12800], [15500, 14200], [20000, 12800], [24500, 14000], [29000, 12500]],
    widthMouth: 1150, widthHead: 500, floorMouth: -180, floorHead: -70, rough: 1,
  },
  { points: [[11000, 12800], [12000, 16800], [11000, 20500]], widthMouth: 620, widthHead: 380, floorMouth: -140, floorHead: -50, rough: 1 },
  { points: [[20000, 12800], [21000, 9500], [23000, 7000]], widthMouth: 600, widthHead: 380, floorMouth: -140, floorHead: -50, rough: 1 },
  { points: [[24500, 14000], [27000, 18500], [29500, 22000]], widthMouth: 560, widthHead: 360, floorMouth: -130, floorHead: -50, rough: 1 },
  // middle fjord, between the northern and the main one
  { points: [[-5500, -5800], [-1500, -5600], [2500, -6800], [5500, -5600]], widthMouth: 800, widthHead: 420, floorMouth: -150, floorHead: -60, rough: 1 },
  // an arm south from the main fjord, east of the coastal strip's peninsula
  { points: [[6400, 2400], [7200, 5500], [6500, 8500]], widthMouth: 520, widthHead: 360, floorMouth: -120, floorHead: -50, rough: 1 },
  // a sound behind the coast, from the northern fjord to the middle one: the coast breaks into islands
  { points: [[-1500, -12200], [-2200, -8500], [-1500, -5700]], widthMouth: 420, widthHead: 420, floorMouth: -70, floorHead: -70, open: true, rough: 1 },
  // an inlet in the north-west
  { points: [[-6500, -20500], [-1500, -20000], [3500, -21500], [7000, -20500]], widthMouth: 700, widthHead: 380, floorMouth: -130, floorHead: -50, rough: 1 },
  // lakes in the valleys, at sea level like the fjords (the deep end is the first point)
  { points: [[26000, 2500], [27600, 4600], [29800, 5600]], widthMouth: 620, widthHead: 340, floorMouth: -45, floorHead: -10, rough: 1.5 },
  { points: [[6500, 17000], [8200, 18600], [8900, 21200]], widthMouth: 600, widthHead: 320, floorMouth: -45, floorHead: -10, rough: 1.5 },
  { points: [[29000, -5000], [30000, -3200], [31800, -2200]], widthMouth: 560, widthHead: 320, floorMouth: -45, floorHead: -10, rough: 1.5 },
  { points: [[14500, 18500], [16300, 19400], [17600, 21800]], widthMouth: 560, widthHead: 320, floorMouth: -45, floorHead: -10, rough: 1.5 },
  { points: [[17000, -4000], [18500, -4900], [19200, -6800]], widthMouth: 520, widthHead: 300, floorMouth: -45, floorHead: -10, rough: 1.5 },
];

/** The mountains rise along the first fjords (the main system), not along every fjord. */
export const RELIEF_FJORDS = 3;

/** Length of each fjord's polyline (m). */
export const FJORD_LENGTH = FJORDS.map((fj) => {
  let l = 0;
  for (let i = 0; i < fj.points.length - 1; i++) l += Math.hypot(fj.points[i + 1][0] - fj.points[i][0], fj.points[i + 1][1] - fj.points[i][1]);
  return l;
});

/**
 * Distance from each fjord's polyline (as fjordDist() measures it) beyond which its carving changes
 * nothing. Conservative: the widest bottom with its wandering, the coves, the gentlest wall (480 + 240 m),
 * and the smooth minimum (up to 100 m less per segment).
 */
export const FJORD_REACH = FJORDS.map((fj) => {
  const r = fj.rough ?? 0;
  const w = Math.max(fj.widthMouth, fj.widthHead) * (1 + 0.35 * r);
  return w * (1 + 0.44 * r) + 720 + 100 * (fj.points.length - 1) + 50;
});

/** The polyline's bounds grown by the reach (x0, z0, x1, z1, in the meandering frame distances use). */
export const FJORD_BOX = FJORDS.map((fj, i) => {
  const xs = fj.points.map((p) => p[0]);
  const zs = fj.points.map((p) => p[1]);
  const R = FJORD_REACH[i];
  return [Math.min(...xs) - R, Math.min(...zs) - R, Math.max(...xs) + R, Math.max(...zs) + R] as const;
});

/**
 * The same for each segment, fjord after fjord (fjord f's segments start at its first point's index
 * minus f). Outside all of a fjord's segment boxes a point is beyond its reach: a long fjord's own box
 * is mostly far from it.
 */
export const FJORD_SEGMENT_BOX = FJORDS.flatMap((fj, i) => {
  const R = FJORD_REACH[i];
  return fj.points.slice(1).map((b, k) => {
    const a = fj.points[k];
    return [Math.min(a[0], b[0]) - R, Math.min(a[1], b[1]) - R, Math.max(a[0], b[0]) + R, Math.max(a[1], b[1]) + R] as const;
  });
});
/** Index of each fjord's first segment box. */
export const FJORD_FIRST_SEGMENT = FJORDS.map((_, i) => FJORDS.slice(0, i).reduce((n, fj) => n + fj.points.length - 1, 0));

/**
 * Free flight's random starts (on the water, in the air) lie in this box (x0, z0, x1, z1): on the
 * first map (src/render/worldMap.ts), 4 km in from its edges.
 */
export const START_BOX = [-11500, -21000, 29500, 20000] as const;

/** A strip is a flat oriented rectangle blended into the terrain. */
export interface StripDef {
  id: 'coastal' | 'mountain' | 'north' | 'east' | 'south';
  name: string;
  /** asphalt with edge lines, or pale gravel with edge markers and cones */
  surface: 'paved' | 'gravel';
  /** a cabin with a lit window and fuel drums beside the runway */
  cabin: boolean;
  /** take-off headings with a clear climb-out (terrain under a 9 % climb from lift-off) */
  departures: number[];
  center: Vec2;
  /** runway heading in degrees, 0 = north (-z), 90 = east (+x) */
  heading: number;
  halfLength: number;
  halfWidth: number;
  elevation: number;
  /** flattened pad beyond the runway rectangle: along the runway axis and across it */
  padLong: number;
  padLat: number;
  /** distance over which the pad blends back to natural terrain */
  shoulder: number;
}

export const STRIPS: StripDef[] = [
  {
    id: 'coastal', name: 'Vika coastal strip', surface: 'paved', cabin: true, departures: [45, 225],
    center: [600, 6250], heading: 45, halfLength: 450, halfWidth: 13,
    elevation: 20, padLong: 90, padLat: 70, shoulder: 420,
  },
  {
    id: 'mountain', name: 'Hestskar mountain strip', surface: 'gravel', cabin: false, departures: [60, 240],
    center: [5550, 350], heading: 60, halfLength: 210, halfWidth: 9,
    elevation: 798, padLong: 190, padLat: 45, shoulder: 300,
  },
  // sites found with scripts/stripsearch.ts (flat, dry, a clear approach corridor on at least one side)
  {
    // a shelf between the northern fjord and its north-east arm, water on most sides; the ground rises
    // east of it: take off west, over the fjord
    id: 'north', name: 'Hjelle fjord strip', surface: 'gravel', cabin: true, departures: [277],
    center: [16720, -17350], heading: 97, halfLength: 300, halfWidth: 10,
    elevation: 449, padLong: 120, padLat: 50, shoulder: 350,
  },
  {
    // the valley floor at the head of the main fjord: one way, in from the fjord (082) and out over it
    id: 'east', name: 'Botn valley strip', surface: 'gravel', cabin: true, departures: [262],
    center: [24360, -2300], heading: 82, halfLength: 280, halfWidth: 9,
    elevation: 80, padLong: 120, padLat: 50, shoulder: 350,
  },
  {
    // flat lowland among the southern lakes
    id: 'south', name: 'Vatne lake strip', surface: 'paved', cabin: true, departures: [131, 311],
    center: [1750, 17290], heading: 131, halfLength: 340, halfWidth: 12,
    elevation: 95, padLong: 100, padLat: 60, shoulder: 380,
  },
];

/** No trees on a strip, beside it and past its ends (m), fading in over `fade`: a clear runway and approaches. */
export const STRIP_CLEARING = { ends: 250, sides: 35, fade: 40 };

export function headingDir(headingDeg: number): Vec2 {
  const a = (headingDeg * Math.PI) / 180;
  // heading 0 → -z (north), 90 → +x (east)
  return [Math.sin(a), -Math.cos(a)];
}

// ---------- GLSL export ----------

function f(x: number): string {
  // Full precision float literal valid in GLSL.
  const s = Number.isInteger(x) ? x.toFixed(1) : x.toPrecision(9);
  return s.includes('e') ? x.toExponential(8) : s;
}

function vec2s(points: readonly Vec2[]): string {
  return points.map(([x, z]) => `vec2(${f(x)}, ${f(z)})`).join(', ');
}

/** Constants and arrays shared by all terrain-related shaders. */
export function worldGlsl(): string {
  const lines: string[] = [];
  lines.push(`#define SEED ${SEED >>> 0}u`);
  lines.push(`#define SEA_LEVEL ${f(SEA_LEVEL)}`);
  lines.push(`#define TERRAIN_OCTAVES ${TERRAIN_OCTAVES}`);
  lines.push(`#define TERRAIN_MIN_OCTAVES ${TERRAIN_MIN_OCTAVES}`);
  // Fjords in shared arrays, walked by one GLSL function: the shader's size does not grow with their
  // number (a function per fjord, inlined at every terrainHeight() call, made some shaders too big to link).
  const n = FJORDS.length;
  const pts = FJORDS.flatMap((fj) => fj.points);
  let first = 0;
  const ranges = FJORDS.map((fj) => {
    const r = `ivec2(${first}, ${fj.points.length})`;
    first += fj.points.length;
    return r;
  });
  lines.push(`#define FJORD_COUNT ${n}`);
  lines.push(`#define RELIEF_FJORDS ${RELIEF_FJORDS}`);
  // the main system also gets constant-size arrays of its own: its distance loops unroll
  FJORDS.slice(0, RELIEF_FJORDS).forEach((fj, i) => {
    lines.push(`const int FJ${i}_N = ${fj.points.length};`);
    lines.push(`const vec2 FJ${i}_P[${fj.points.length}] = vec2[${fj.points.length}](${vec2s(fj.points)});`);
  });
  lines.push(`const vec2 FJ_P[${pts.length}] = vec2[${pts.length}](${vec2s(pts)});`);
  // first point and point count of each fjord
  lines.push(`const ivec2 FJ_R[${n}] = ivec2[${n}](${ranges.join(', ')});`);
  lines.push(`const vec4 FJ_W[${n}] = vec4[${n}](${FJORDS.map((fj) => `vec4(${f(fj.widthMouth)}, ${f(fj.widthHead)}, ${f(fj.floorMouth)}, ${f(fj.floorHead)})`).join(', ')});`);
  // open, rough, length, reach
  lines.push(`const vec4 FJ_X[${n}] = vec4[${n}](${FJORDS.map((fj, i) => `vec4(${fj.open ? '1.0' : '0.0'}, ${f(fj.rough ?? 0)}, ${f(FJORD_LENGTH[i])}, ${f(FJORD_REACH[i])})`).join(', ')});`);
  // the box beyond which each fjord changes nothing, and the same per segment
  lines.push(`const vec4 FJ_B[${n}] = vec4[${n}](${FJORD_BOX.map((b) => `vec4(${b.map(f).join(', ')})`).join(', ')});`);
  const nseg = FJORD_SEGMENT_BOX.length;
  lines.push(`const vec4 FJ_SB[${nseg}] = vec4[${nseg}](${FJORD_SEGMENT_BOX.map((b) => `vec4(${b.map(f).join(', ')})`).join(', ')});`);
  STRIPS.forEach((s, i) => {
    const d = headingDir(s.heading);
    lines.push(`const vec4 STRIP${i}_A = vec4(${f(s.center[0])}, ${f(s.center[1])}, ${f(d[0])}, ${f(d[1])});`);
    lines.push(
      `const vec4 STRIP${i}_B = vec4(${f(s.halfLength + s.padLong)}, ${f(s.halfWidth + s.padLat)}, ${f(s.elevation)}, ${f(s.shoulder)});`,
    );
    lines.push(`const vec2 STRIP${i}_RW = vec2(${f(s.halfLength)}, ${f(s.halfWidth)});`);
    lines.push(`const vec2 STRIP${i}_CLEAR = vec2(${f(s.halfLength + STRIP_CLEARING.ends)}, ${f(s.halfWidth + STRIP_CLEARING.sides)});`);
  });
  return lines.join('\n') + '\n';
}
