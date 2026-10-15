// Beaver-like amphibian. Body frame: +x right, +y up, +z aft (nose points to -z). CG at the origin.

export type V3 = readonly [number, number, number];

export interface SurfaceDef {
  name: string;
  /** aerodynamic centre in the body frame */
  pos: V3;
  /** spanwise axis (pointing right for wings, up for the fin); lift = cross(span, sectionVelocity) */
  span: V3;
  area: number;
  aspect: number;
  /** incidence relative to the body (rad) */
  incidence: number;
  cla: number;
  alpha0: number;
  clmax: number;
  cd0: number;
  oswald: number;
  /** control effectiveness (ΔCL per unit input) */
  aileron?: number;
  elevator?: number;
  rudder?: number;
  flaps?: boolean;
  /** sits in the propeller slipstream */
  wash: number;
}

const deg = Math.PI / 180;
const DIHEDRAL = 2.2 * deg;

export const AIRCRAFT = {
  name: 'DHC-2 style amphibian',
  mass: 2100,
  /** principal moments about x (pitch), y (yaw), z (roll) */
  inertia: [6200, 10500, 5600] as V3,
  wingSpan: 14.6,
  wingArea: 23.2,
  chord: 1.62,
  /** engine */
  maxPower: 300_000,
  propRadius: 1.3,
  propPos: [0, 0.1, -4.55] as V3,
  maxRpm: 2200,
  idleRpm: 600,
  surfaces: [
    {
      name: 'wingL', pos: [-3.7, 1.15, -0.12], span: [Math.cos(DIHEDRAL), -Math.sin(DIHEDRAL), 0], area: 11.6, aspect: 9.2,
      incidence: 2.0 * deg, cla: 4.9, alpha0: -2.2 * deg, clmax: 1.62, cd0: 0.009, oswald: 0.75, aileron: 0.3, flaps: true, wash: 0.25,
    },
    {
      name: 'wingR', pos: [3.7, 1.15, -0.12], span: [Math.cos(DIHEDRAL), Math.sin(DIHEDRAL), 0], area: 11.6, aspect: 9.2,
      incidence: 2.0 * deg, cla: 4.9, alpha0: -2.2 * deg, clmax: 1.62, cd0: 0.009, oswald: 0.75, aileron: -0.3, flaps: true, wash: 0.25,
    },
    {
      name: 'htail', pos: [0, 0.45, 5.35], span: [1, 0, 0], area: 4.6, aspect: 3.6,
      incidence: -2.6 * deg, cla: 3.4, alpha0: 0, clmax: 1.1, cd0: 0.012, oswald: 0.7, elevator: -0.7, wash: 0.8,
    },
    {
      name: 'vtail', pos: [0, 1.25, 5.55], span: [0, 1, 0], area: 2.6, aspect: 1.7,
      incidence: 0, cla: 2.6, alpha0: 0, clmax: 1.0, cd0: 0.012, oswald: 0.7, rudder: 0.85, wash: 0.8,
    },
  ] as SurfaceDef[],
  /** body drag: equivalent areas (Cd·A, m²) along x (side), y (vertical), z (frontal) */
  bodyDrag: [7.5, 9.0, 0.95] as V3,
  gearDragArea: 0.07,
  /** flaps: notches as fractions of full travel */
  flapNotches: [0, 0.33, 0.66, 1],
  flapCl: 0.7,
  flapCd: 0.075,
  flapStall: -2.5 * deg,
  flapCm: -0.055,
  /** gear: main wheels inside the floats, nose wheels at the bows */
  wheels: [
    { name: 'mainL', pos: [-1.3, -2.47, 0.45] as V3, k: 125_000, c: 16_000, main: true },
    { name: 'mainR', pos: [1.3, -2.47, 0.45] as V3, k: 125_000, c: 16_000, main: true },
    { name: 'noseL', pos: [-1.3, -2.37, -3.3] as V3, k: 70_000, c: 9_000, main: false },
    { name: 'noseR', pos: [1.3, -2.37, -3.3] as V3, k: 70_000, c: 9_000, main: false },
  ],
  /** float keel sample points (both floats), with the waterplane area each represents */
  floatX: 1.3,
  keel: [
    [-3.7, -1.88], [-2.9, -2.04], [-1.9, -2.14], [-0.9, -2.16], [0.12, -2.16], [1.1, -2.09], [2.1, -2.0], [3.1, -1.92],
  ] as [number, number][],
  keelArea: 0.62,
  floatDepth: 0.75,
  /** points that must never touch anything */
  crashPoints: [
    { name: 'wingtip L', pos: [-7.3, 1.32, -0.2] as V3 },
    { name: 'wingtip R', pos: [7.3, 1.32, -0.2] as V3 },
    { name: 'propeller', pos: [0, -1.22, -4.55] as V3 },
    { name: 'tail', pos: [0, 0.35, 6.05] as V3 },
    { name: 'fin', pos: [0, 2.35, 5.85] as V3 },
    { name: 'cowling', pos: [0, -0.62, -3.6] as V3 },
    { name: 'belly', pos: [0, -0.72, 0.6] as V3 },
  ],
  /** eye point for the cockpit camera */
  eye: [-0.33, 0.9, -1.85] as V3,
  /** landing light in the left wing leading edge */
  lamp: [-2.4, 1.1, -1.05] as V3,
};

export const DEG = deg;
