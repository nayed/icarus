// Procedural Beaver-like amphibian: built from lofts, airfoil wings and primitives at load time.
import * as THREE from 'three';
import { loft, wing, strut, box, paint, merge, MAT, type Mat } from './geometry.ts';
import { planeShaderMaterial, forShader } from './material.ts';
import { InstrumentPanel } from './panel.ts';
import type { Aircraft, Telemetry } from '../sim/aircraft.ts';
import { AIRCRAFT, DEG } from '../sim/config.ts';

const COL = {
  cream: '#e6dcc4',
  accent: '#f2a24b',
  accentDeep: '#c9611f',
  trim: '#29333d',
  belly: '#59626a',
  glass: '#141d24',
  alu: '#aeb3b8',
  aluDark: '#6e757b',
  rubber: '#151515',
  black: '#1c1c1c',
  yellow: '#f2c419',
  interior: '#3a3f3b',
  chrome: '#d4d6d8',
};

const wingY = (x: number) => 1.04 + (Math.abs(x) - 0.62) * Math.tan(2.2 * DEG);
const WING_LE = -1.32;
const CHORD = 1.62;

function fuselage(): THREE.BufferGeometry {
  const S = (z: number, w: number, h: number, y: number, e: number) => ({ z, w, h, y, e });
  const g = loft(
    [
      S(-4.5, 0.5, 0.5, 0.06, 2.1), S(-4.42, 0.58, 0.58, 0.06, 2.15), S(-4.25, 0.62, 0.62, 0.07, 2.2), S(-3.4, 0.64, 0.64, 0.08, 2.3),
      S(-3.1, 0.64, 0.67, 0.12, 2.5), S(-2.75, 0.63, 0.78, 0.16, 2.9), S(-2.35, 0.64, 0.86, 0.17, 3.3), S(-0.9, 0.64, 0.86, 0.16, 3.3),
      S(0.6, 0.6, 0.8, 0.15, 3.0), S(1.6, 0.5, 0.66, 0.19, 2.8), S(3.0, 0.36, 0.48, 0.27, 2.5), S(4.6, 0.22, 0.33, 0.37, 2.3),
      S(5.9, 0.1, 0.18, 0.45, 2.2), S(6.18, 0.04, 0.07, 0.47, 2),
    ],
    32,
  );
  return paint(g, (x, y, z) => {
    const side = Math.abs(x) > 0.25;
    // windows: a sloped windshield from the cowl up to the roof, and cabin side windows
    if (z > -3.12 && z < -2.3) {
      const yWs = 0.6 + (z + 3.12) * 0.25;
      if (y > yWs && Math.abs(x) < 0.6) return { c: COL.glass, m: MAT.glass };
    }
    const winTop = 0.17 + 0.86 * 0.86;
    if (z > -2.3 && z < -0.45 && y > 0.36 && y < winTop && side) {
      const pillar = Math.abs(z + 1.95) < 0.05 || Math.abs(z + 1.1) < 0.05;
      if (!pillar) return { c: COL.glass, m: MAT.glass };
    }
    if (z < -3.35) return { c: z < -4.38 ? COL.trim : COL.accent, m: MAT.paint };
    // cheatline along the sides
    const lineY = 0.02 + (z > 1 ? (z - 1) * 0.05 : 0);
    if (side && Math.abs(y - lineY) < 0.07) return { c: COL.accent, m: MAT.paint };
    if (side && Math.abs(y - (lineY - 0.1)) < 0.025) return { c: COL.trim, m: MAT.paint };
    if (y < -0.45) return { c: COL.belly, m: MAT.paint };
    return { c: COL.cream, m: MAT.paint };
  });
}

function wings(): { fixed: THREE.BufferGeometry[]; ailL: THREE.BufferGeometry; ailR: THREE.BufferGeometry; flapL: THREE.BufferGeometry; flapR: THREE.BufferGeometry } {
  const fixed: THREE.BufferGeometry[] = [];
  const tipChord = (s: number) => CHORD * (s > 0.93 ? 1 - ((s - 0.93) / 0.07) ** 2 * 0.35 : 1);
  const tipPaint = (x: number) => (Math.abs(x) > 6.9 ? { c: COL.accent, m: MAT.paint } : { c: COL.cream, m: MAT.paint });
  const mk = (side: number, c0: number, c1: number, x0: number, x1: number, chordFn?: (s: number) => number, segs = 6) =>
    wing({
      root: new THREE.Vector3(side * x0, wingY(x0), WING_LE),
      tip: new THREE.Vector3(side * x1, wingY(x1), WING_LE),
      chordAt: chordFn ?? (() => CHORD),
      leAt: () => WING_LE,
      c0,
      c1,
      segs,
      thick: 0.14,
    });
  for (const side of [-1, 1]) {
    fixed.push(paint(mk(side, 0, 0.76, 0.62, 7.3, (s) => tipChord(s), 10), (x) => tipPaint(x)));
    // trailing-edge gap fillers between flap and aileron, and at the tip
    fixed.push(paint(mk(side, 0.75, 1, 4.18, 4.32, undefined, 1), COL.cream));
    fixed.push(paint(mk(side, 0.75, 1, 7.02, 7.3, (s) => tipChord(0.95 + s * 0.05), 2), COL.accent));
    // wing strut and jury strut
    const s0 = new THREE.Vector3(side * 0.56, -0.48, -0.78);
    const s1 = new THREE.Vector3(side * 3.05, wingY(3.05) - 0.05, -0.62);
    fixed.push(paint(strut(s0, s1, 0.04, 2.4), COL.cream));
    fixed.push(paint(strut(new THREE.Vector3(side * 1.9, 0.36, -0.68), new THREE.Vector3(side * 1.9, wingY(1.9) - 0.05, -0.65), 0.025), COL.trim));
  }
  const surf = (side: number, x0: number, x1: number) => {
    const g = mk(side, 0.76, 1, x0, x1, undefined, 3);
    return paint(g, (x) => (Math.abs(x) > 6.9 ? { c: COL.accent, m: MAT.paint } : { c: COL.cream, m: MAT.paint }));
  };
  return { fixed, ailL: surf(-1, 4.32, 7.02), ailR: surf(1, 4.32, 7.02), flapL: surf(-1, 0.62, 4.18), flapR: surf(1, 0.62, 4.18) };
}

function tail(): { fixed: THREE.BufferGeometry[]; elevator: THREE.BufferGeometry; rudder: THREE.BufferGeometry } {
  const fixed: THREE.BufferGeometry[] = [];
  const hc = (s: number) => 1.15 * (1 - 0.3 * s * s);
  const htail = (side: number, c0: number, c1: number) =>
    wing({ root: new THREE.Vector3(side * 0.18, 0.42, 0), tip: new THREE.Vector3(side * 2.55, 0.42, 0), chordAt: hc, leAt: (s) => 4.9 + 0.12 * s * s, c0, c1, segs: 5, thick: 0.1 });
  for (const side of [-1, 1]) fixed.push(paint(htail(side, 0, 0.62), COL.cream));
  const elev = merge([-1, 1].map((side) => paint(htail(side, 0.62, 1), (x) => (Math.abs(x) > 2.3 ? { c: COL.accent, m: MAT.paint } : { c: COL.cream, m: MAT.paint }))));
  // fin: swept leading edge, tall Beaver shape
  const fc = (s: number) => 1.65 * (1 - s) + 0.85 * s;
  const fle = (s: number) => 4.55 + 1.05 * s;
  const fin = (c0: number, c1: number) => wing({ root: new THREE.Vector3(0, 0.48, 0), tip: new THREE.Vector3(0, 2.36, 0), chordAt: fc, leAt: fle, c0, c1, segs: 5, thick: 0.1, vertical: true });
  fixed.push(paint(fin(0, 0.62), (_x, y) => (y > 2.0 ? { c: COL.accent, m: MAT.paint } : { c: COL.cream, m: MAT.paint })));
  const rud = paint(fin(0.62, 1), (_x, y) => (y > 2.0 ? { c: COL.accent, m: MAT.paint } : y < 0.9 ? { c: COL.trim, m: MAT.paint } : { c: COL.cream, m: MAT.paint }));
  return { fixed, elevator: elev, rudder: rud };
}

function floats(): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  const S = (z: number, w: number, h: number, y: number, e = 2.6) => ({ z, w, h, y, e, flatBottom: 0.2 });
  for (const side of [-1, 1]) {
    const g = loft(
      [
        S(-4.15, 0.05, 0.06, -1.6, 2), S(-3.85, 0.25, 0.2, -1.7), S(-3.2, 0.37, 0.3, -1.79), S(-2.2, 0.42, 0.36, -1.82), S(-0.2, 0.42, 0.36, -1.82),
        S(0.12, 0.41, 0.35, -1.81), S(0.2, 0.4, 0.31, -1.77), S(1.6, 0.36, 0.27, -1.75), S(3.0, 0.22, 0.18, -1.72), S(3.66, 0.05, 0.06, -1.7, 2),
      ],
      20,
    );
    g.translate(side * AIRCRAFT.floatX, 0, 0);
    out.push(
      paint(g, (_x, y) => {
        if (y > -1.5) return { c: COL.alu, m: MAT.metal };
        if (y > -1.97 && y < -1.9) return { c: COL.accentDeep, m: MAT.paint };
        return { c: y < -1.97 ? COL.aluDark : COL.alu, m: MAT.metal };
      }),
    );
    // float struts to the fuselage
    for (const [z0, z1] of [[-2.25, -2.55], [0.45, 0.25]]) {
      out.push(paint(strut(new THREE.Vector3(side * 1.3, -1.48, z0), new THREE.Vector3(side * 0.42, -0.62, z1), 0.035, 2.2), COL.trim, MAT.metal));
      out.push(paint(strut(new THREE.Vector3(side * 1.3, -1.48, z0), new THREE.Vector3(side * 0.5, -0.5, z1 + 0.6), 0.025, 2.2), COL.trim, MAT.metal));
    }
  }
  for (const z of [-2.25, 0.45]) out.push(paint(strut(new THREE.Vector3(-1.3, -1.5, z), new THREE.Vector3(1.3, -1.5, z), 0.03, 1.6), COL.trim, MAT.metal));
  return out;
}

function wheel(r: number, w: number): THREE.BufferGeometry {
  const tyre = new THREE.CylinderGeometry(r, r, w, 18, 1).rotateZ(Math.PI / 2);
  const hub = new THREE.CylinderGeometry(r * 0.45, r * 0.45, w * 1.08, 12, 1).rotateZ(Math.PI / 2);
  const leg = box(0.05, 0.36, 0.08, 0, r * 0.5 + 0.18, 0);
  return merge([paint(tyre, COL.rubber, MAT.rubber), paint(hub, COL.chrome, MAT.metal), paint(leg, COL.trim, MAT.metal)]);
}

function propeller(): { blades: THREE.BufferGeometry; spinner: THREE.BufferGeometry } {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 3; i++) {
    const b = new THREE.BoxGeometry(0.16, 1.18, 0.035, 1, 6, 1);
    // taper and twist
    const p = b.getAttribute('position');
    for (let k = 0; k < p.count; k++) {
      const y = p.getY(k) + 0.59; // 0 at hub .. 1.18 at tip
      const t = y / 1.18;
      const x = p.getX(k) * (1 - 0.35 * t);
      const tw = (28 - 18 * t) * DEG;
      const z = p.getZ(k);
      p.setXYZ(k, x * Math.cos(tw) - z * Math.sin(tw), y + 0.14, x * Math.sin(tw) + z * Math.cos(tw));
    }
    b.computeVertexNormals();
    b.rotateZ((i * 2 * Math.PI) / 3);
    parts.push(paint(b, (x, y) => (Math.hypot(x, y) > 1.17 ? { c: COL.yellow, m: MAT.paint } : { c: COL.black, m: [0.35, 0] as Mat })));
  }
  const spinner = new THREE.ConeGeometry(0.22, 0.42, 16, 1).rotateX(-Math.PI / 2).translate(0, 0, -0.14);
  return { blades: merge(parts), spinner: paint(spinner, COL.chrome, MAT.metal) };
}

function lights(): THREE.BufferGeometry[] {
  const s = (x: number, y: number, z: number, m: Mat, r = 0.05) => paint(new THREE.SphereGeometry(r, 8, 6).translate(x, y, z), '#ffffff', m);
  return [
    s(-7.33, wingY(7.3), -0.62, MAT.navRed),
    s(7.33, wingY(7.3), -0.62, MAT.navGreen),
    s(0, 0.49, 6.2, MAT.navWhite, 0.04),
    s(-7.34, wingY(7.3), -0.25, MAT.strobe, 0.035),
    s(7.34, wingY(7.3), -0.25, MAT.strobe, 0.035),
    paint(new THREE.CircleGeometry(0.09, 12).translate(0, 0, 0).rotateY(Math.PI).translate(-2.4, wingY(2.4) - 0.01, WING_LE - 0.01), '#ffffff', MAT.lamp),
    // exhaust stack and a little antenna
    paint(new THREE.CylinderGeometry(0.05, 0.06, 0.32, 8).rotateX(Math.PI / 2).translate(0.62, -0.32, -3.3), '#3a3532', MAT.metal),
    paint(box(0.02, 0.35, 0.05, 0, 1.2, 1.4), COL.trim),
  ];
}

function interior(): THREE.BufferGeometry {
  const c = COL.interior;
  const parts = [
    paint(box(1.2, 0.04, 3.0, 0, -0.55, -1.2), '#2a2d2b', MAT.matte),
    paint(box(0.04, 0.72, 2.7, -0.6, -0.2, -1.3), c, MAT.matte),
    paint(box(0.04, 0.72, 2.7, 0.6, -0.2, -1.3), c, MAT.matte),
    paint(box(1.25, 0.04, 2.3, 0, 1.0, -1.15), '#4a4d48', MAT.matte),
    // dashboard: glare shield reaching forward to the windshield's lower edge, panel face below it
    paint(box(1.22, 0.03, 0.64, 0, 0.62, -2.81), '#101112', MAT.matte),
    paint(box(1.22, 0.34, 0.04, 0, 0.46, -2.51), '#151515', MAT.matte),
    paint(box(1.22, 0.04, 0.3, 0, 0.29, -2.66), '#141516', MAT.matte),
    // windshield centre post and door pillars
    paint(strut(new THREE.Vector3(-0.58, 0.6, -3.1), new THREE.Vector3(-0.62, 1.0, -2.35), 0.02, 1.5), c, MAT.matte),
    paint(strut(new THREE.Vector3(0.58, 0.6, -3.1), new THREE.Vector3(0.62, 1.0, -2.35), 0.02, 1.5), c, MAT.matte),
    paint(box(0.05, 0.62, 0.06, -0.61, 0.68, -1.95), c, MAT.matte),
    paint(box(0.05, 0.62, 0.06, 0.61, 0.68, -1.95), c, MAT.matte),
    paint(box(0.05, 0.62, 0.06, -0.61, 0.68, -1.1), c, MAT.matte),
    paint(box(0.05, 0.62, 0.06, 0.61, 0.68, -1.1), c, MAT.matte),
    // yoke
    paint(strut(new THREE.Vector3(-0.33, 0.2, -2.48), new THREE.Vector3(-0.33, 0.24, -2.2), 0.02, 1), '#1a1a1a', MAT.metal),
    paint(box(0.32, 0.035, 0.035, -0.33, 0.25, -2.18), '#1a1a1a', MAT.metal),
    paint(box(0.035, 0.12, 0.035, -0.48, 0.3, -2.18), '#1a1a1a', MAT.metal),
    paint(box(0.035, 0.12, 0.035, -0.18, 0.3, -2.18), '#1a1a1a', MAT.metal),
  ];
  return merge(parts);
}

export class PlaneModel {
  readonly root = new THREE.Group();
  readonly material: THREE.ShaderMaterial;
  readonly interiorMaterial: THREE.ShaderMaterial;
  private readonly ailL = new THREE.Group();
  private readonly ailR = new THREE.Group();
  private readonly flapL = new THREE.Group();
  private readonly flapR = new THREE.Group();
  private readonly elevator = new THREE.Group();
  private readonly rudder = new THREE.Group();
  private readonly prop = new THREE.Group();
  private readonly propBlades: THREE.Mesh;
  private readonly propDisc: THREE.Mesh;
  private readonly wheels: THREE.Group[] = [];
  private readonly waterRudders: THREE.Group[] = [];
  readonly cockpit = new THREE.Group();
  readonly exterior = new THREE.Group();
  readonly panel: InstrumentPanel;
  private propAngle = 0;
  private strobeT = 0;

  constructor(ldr: boolean) {
    this.material = planeShaderMaterial(ldr);
    this.interiorMaterial = planeShaderMaterial(ldr);
    this.interiorMaterial.uniforms.uInterior.value = 1;
    this.interiorMaterial.side = THREE.DoubleSide;
    const mesh = (g: THREE.BufferGeometry, mat = this.material) => {
      const m = new THREE.Mesh(forShader(g), mat);
      m.frustumCulled = false;
      m.layers.enable(1);
      m.layers.enable(2);
      return m;
    };
    const w = wings();
    const t = tail();
    this.exterior.add(mesh(merge([fuselage(), ...w.fixed, ...t.fixed, ...floats(), ...lights()])));

    // control surfaces rotate about their hinge lines: geometry is moved into the hinge frame
    // (pivot at the origin, hinge along the local axis) and the pivot group restores the tilt.
    const hingeZ = WING_LE + 0.76 * CHORD;
    const dih = 2.2 * DEG;
    const hinged = (grp: THREE.Group, g: THREE.BufferGeometry, pivot: THREE.Vector3, tilt: THREE.Euler) => {
      g.translate(-pivot.x, -pivot.y, -pivot.z);
      g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(tilt).invert());
      grp.position.copy(pivot);
      const tiltG = new THREE.Group();
      tiltG.position.copy(pivot);
      tiltG.rotation.copy(tilt);
      grp.position.set(0, 0, 0);
      grp.add(mesh(g));
      tiltG.add(grp);
      this.exterior.add(tiltG);
    };
    hinged(this.ailL, w.ailL, new THREE.Vector3(-5.67, wingY(5.67), hingeZ), new THREE.Euler(0, 0, -dih));
    hinged(this.ailR, w.ailR, new THREE.Vector3(5.67, wingY(5.67), hingeZ), new THREE.Euler(0, 0, dih));
    hinged(this.flapL, w.flapL, new THREE.Vector3(-2.4, wingY(2.4), hingeZ), new THREE.Euler(0, 0, -dih));
    hinged(this.flapR, w.flapR, new THREE.Vector3(2.4, wingY(2.4), hingeZ), new THREE.Euler(0, 0, dih));
    hinged(this.elevator, t.elevator, new THREE.Vector3(0, 0.42, 4.9 + 0.62 * 1.15), new THREE.Euler());
    // rudder hinge runs from (y 0.48, z 5.58) to (y 2.36, z 6.27): tilted aft about x
    hinged(this.rudder, t.rudder, new THREE.Vector3(0, 1.42, 5.925), new THREE.Euler(Math.atan2(0.69, 1.88), 0, 0));

    // propeller and its motion-blur disc
    const p = propeller();
    this.propBlades = mesh(p.blades);
    this.prop.add(this.propBlades, mesh(p.spinner));
    this.prop.position.set(0, 0.08, -4.6);
    this.exterior.add(this.prop);
    const discMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { uAlpha: { value: 0 }, uExposureN: { value: 1 }, ...{ uSunColor: { value: new THREE.Vector3() } } },
      vertexShader: /* glsl */ `out vec2 vP;
#include <logdepthbuf_pars_vertex>
        void main() { vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        #include <logdepthbuf_vertex>
        }`,
      fragmentShader: /* glsl */ `in vec2 vP; uniform float uAlpha; out vec4 fragColor;
#include <logdepthbuf_pars_fragment>
        void main() {
          #include <logdepthbuf_fragment>
          float r = length(vP) / 1.32;
          float tip = smoothstep(0.88, 0.92, r) * (1.0 - smoothstep(0.98, 1.0, r));
          float body = (1.0 - smoothstep(0.9, 1.0, r)) * smoothstep(0.1, 0.25, r);
          vec3 c = mix(vec3(0.05), vec3(0.9, 0.7, 0.1), tip);
          float a = uAlpha * (body * 0.16 + tip * 0.32);
          fragColor = vec4(c * a * 0.15, a);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      side: THREE.DoubleSide,
    });
    this.propDisc = new THREE.Mesh(new THREE.CircleGeometry(1.32, 48), discMat);
    this.propDisc.position.set(0, 0.08, -4.66);
    this.propDisc.frustumCulled = false;
    this.propDisc.renderOrder = 600;
    this.exterior.add(this.propDisc);

    // wheels (retract into the floats) and water rudders
    for (const wd of AIRCRAFT.wheels) {
      const r = wd.main ? 0.28 : 0.17;
      const g = new THREE.Group();
      g.position.set(wd.pos[0], wd.pos[1] + r, wd.pos[2]);
      g.add(mesh(wheel(r, wd.main ? 0.16 : 0.11)));
      this.wheels.push(g);
      this.exterior.add(g);
    }
    for (const side of [-1, 1]) {
      const g = new THREE.Group();
      g.position.set(side * AIRCRAFT.floatX, -1.72, 3.6);
      g.add(mesh(paint(box(0.02, 0.36, 0.22, 0, -0.18, 0.08), COL.trim, MAT.metal)));
      this.waterRudders.push(g);
      this.exterior.add(g);
    }
    this.root.add(this.exterior);

    // cockpit interior + instrument panel (only drawn from the cockpit camera)
    this.cockpit.add(mesh(interior(), this.interiorMaterial));
    this.panel = new InstrumentPanel();
    const panelMesh = new THREE.Mesh(new THREE.PlaneGeometry(1.12, 0.32), this.panel.material);
    panelMesh.position.set(-0.08, 0.455, -2.46);
    panelMesh.rotation.x = 8 * DEG;
    this.cockpit.add(panelMesh);
    this.cockpit.visible = false;
    this.root.add(this.cockpit);
  }

  /** Pose + animated parts. `alpha` interpolates between the previous and current sim pose. */
  update(ac: Aircraft, pos: THREE.Vector3, quat: THREE.Quaternion, dt: number, tel: Telemetry, lampOn: boolean, cockpitView: boolean): void {
    this.root.position.copy(pos);
    this.root.quaternion.copy(quat);
    this.root.updateMatrixWorld(true);
    this.ailL.rotation.x = ac.aileron * 18 * DEG;
    this.ailR.rotation.x = -ac.aileron * 18 * DEG;
    this.flapL.rotation.x = ac.flaps * 40 * DEG;
    this.flapR.rotation.x = ac.flaps * 40 * DEG;
    this.elevator.rotation.x = -ac.elevator * 24 * DEG;
    this.rudder.rotation.y = ac.rudder * 25 * DEG;
    // propeller: real rotation at low rpm, blur disc above ~800 rpm
    const rps = ac.rpm / 60;
    this.propAngle = (this.propAngle + rps * 2 * Math.PI * dt) % (Math.PI * 2);
    const blur = THREE.MathUtils.smoothstep(ac.rpm, 450, 900);
    this.prop.rotation.z = blur > 0.5 ? this.propAngle * 0.13 : this.propAngle;
    this.propBlades.visible = blur < 0.98;
    (this.propDisc.material as THREE.ShaderMaterial).uniforms.uAlpha.value = blur;
    // gear: wheels slide up into the floats; water rudders drop when the gear is up
    for (let i = 0; i < this.wheels.length; i++) {
      const wd = AIRCRAFT.wheels[i];
      const r = wd.main ? 0.28 : 0.17;
      this.wheels[i].position.y = wd.pos[1] + r + (1 - ac.gear) * 0.34;
      this.wheels[i].visible = ac.gear > 0.02;
    }
    for (const wr of this.waterRudders) wr.rotation.x = -(ac.gear) * 80 * DEG + ac.rudder * 0;
    for (const wr of this.waterRudders) wr.rotation.y = ac.rudder * 20 * DEG * (1 - ac.gear);
    // lights: steady nav, double-flash strobes
    this.strobeT = (this.strobeT + dt) % 1.2;
    const strobe = this.strobeT < 0.05 || (this.strobeT > 0.15 && this.strobeT < 0.2) ? 1 : 0;
    const u = this.material.uniforms;
    u.uNav.value.set(1, 1, 1, ac.crashed ? 0 : strobe);
    u.uLampOn.value = lampOn ? 1 : 0;
    this.cockpit.visible = cockpitView;
    this.material.side = cockpitView ? THREE.DoubleSide : THREE.FrontSide;
    if (cockpitView) this.panel.update(tel, dt);
  }
}
