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
];

/** A strip is a flat oriented rectangle blended into the terrain. */
export interface StripDef {
  id: 'coastal' | 'mountain';
  name: string;
  center: Vec2;
  /** runway heading in degrees, 0 = north (-z), 90 = east (+x) */
  heading: number;
  halfLength: number;
  halfWidth: number;
  elevation: number;
  /** flattened pad around the runway (margin beyond the runway rectangle) */
  padMargin: number;
  /** distance over which the pad blends back to natural terrain */
  shoulder: number;
}

export const STRIPS: StripDef[] = [
  {
    id: 'coastal', name: 'Vika coastal strip',
    center: [600, 6250], heading: 45, halfLength: 450, halfWidth: 13,
    elevation: 20, padMargin: 70, shoulder: 420,
  },
  {
    id: 'mountain', name: 'Hestskar mountain strip',
    center: [5550, 350], heading: 60, halfLength: 210, halfWidth: 9,
    elevation: 798, padMargin: 45, shoulder: 300,
  },
];

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
  FJORDS.forEach((fj, i) => {
    lines.push(`const int FJ${i}_N = ${fj.points.length};`);
    lines.push(`const vec2 FJ${i}_P[${fj.points.length}] = vec2[${fj.points.length}](${vec2s(fj.points)});`);
    lines.push(
      `const vec4 FJ${i}_W = vec4(${f(fj.widthMouth)}, ${f(fj.widthHead)}, ${f(fj.floorMouth)}, ${f(fj.floorHead)});`,
    );
  });
  STRIPS.forEach((s, i) => {
    const d = headingDir(s.heading);
    lines.push(`const vec4 STRIP${i}_A = vec4(${f(s.center[0])}, ${f(s.center[1])}, ${f(d[0])}, ${f(d[1])});`);
    lines.push(
      `const vec4 STRIP${i}_B = vec4(${f(s.halfLength + s.padMargin)}, ${f(s.halfWidth + s.padMargin)}, ${f(s.elevation)}, ${f(s.shoulder)});`,
    );
    lines.push(`const vec2 STRIP${i}_RW = vec2(${f(s.halfLength)}, ${f(s.halfWidth)});`);
  });
  return lines.join('\n') + '\n';
}
