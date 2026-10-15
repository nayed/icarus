// Small procedural geometry kit: lofts through superellipse sections, airfoil wings, and helpers that
// tag vertices with colour + material parameters so the whole aircraft shares one shader.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** Material parameters: x = gloss (0 matte .. 1 glossy), y = emissive id. */
export type Mat = [number, number];
export const MAT = {
  paint: [0.55, 0] as Mat,
  metal: [0.75, 0] as Mat,
  rubber: [0.1, 0] as Mat,
  glass: [0.98, 0] as Mat,
  matte: [0.2, 0] as Mat,
  navRed: [0.5, 1] as Mat,
  navGreen: [0.5, 2] as Mat,
  navWhite: [0.5, 3] as Mat,
  strobe: [0.5, 4] as Mat,
  lamp: [0.9, 5] as Mat,
};

export type ColorFn = (x: number, y: number, z: number) => { c: THREE.ColorRepresentation; m: Mat };

/** Adds `color` and `aMat` attributes to a geometry (uniform or per-vertex). */
export function paint(g: THREE.BufferGeometry, fn: ColorFn | THREE.ColorRepresentation, mat: Mat = MAT.paint): THREE.BufferGeometry {
  const g2 = g.index ? g.toNonIndexed() : g;
  const pos = g2.getAttribute('position');
  const col = new Float32Array(pos.count * 3);
  const mt = new Float32Array(pos.count * 2);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    let m = mat;
    if (typeof fn === 'function') {
      const r = fn(pos.getX(i), pos.getY(i), pos.getZ(i));
      c.set(r.c);
      m = r.m;
    } else c.set(fn);
    col.set([c.r, c.g, c.b], i * 3);
    mt.set(m, i * 2);
  }
  g2.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g2.setAttribute('aMat', new THREE.BufferAttribute(mt, 2));
  if (!g2.getAttribute('normal')) g2.computeVertexNormals();
  if (g2.getAttribute('uv')) g2.deleteAttribute('uv');
  return g2;
}

export function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  for (const p of parts) {
    for (const k of Object.keys(p.attributes)) if (!['position', 'normal', 'color', 'aMat'].includes(k)) p.deleteAttribute(k);
  }
  const m = mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)), false);
  if (!m) throw new Error('merge failed');
  return m;
}

export interface Section {
  z: number;
  /** half width / half height */
  w: number;
  h: number;
  /** centre height */
  y: number;
  /** superellipse exponent (2 = ellipse, larger = boxier) */
  e: number;
  /** optional extra flattening of the bottom (0..1) */
  flatBottom?: number;
}

/** Closed loft along z through superellipse sections (caps at both ends). */
export function loft(sections: Section[], radial = 24): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  const ring = (s: Section) => {
    for (let k = 0; k < radial; k++) {
      const t = (k / radial) * Math.PI * 2;
      const c = Math.cos(t);
      const sn = Math.sin(t);
      const px = s.w * Math.sign(c) * Math.pow(Math.abs(c), 2 / s.e);
      let py = s.h * Math.sign(sn) * Math.pow(Math.abs(sn), 2 / s.e);
      if (s.flatBottom && py < 0) py *= 1 - s.flatBottom * 0.5;
      pos.push(px, s.y + py, s.z);
    }
  };
  sections.forEach(ring);
  for (let j = 0; j < sections.length - 1; j++) {
    for (let k = 0; k < radial; k++) {
      const a = j * radial + k;
      const b = j * radial + ((k + 1) % radial);
      const c = (j + 1) * radial + k;
      const d = (j + 1) * radial + ((k + 1) % radial);
      idx.push(a, b, d, a, d, c);
    }
  }
  // end caps (fan around the section centre)
  const capStart = pos.length / 3;
  const s0 = sections[0];
  const s1 = sections[sections.length - 1];
  pos.push(0, s0.y, s0.z, 0, s1.y, s1.z);
  const last = (sections.length - 1) * radial;
  for (let k = 0; k < radial; k++) {
    idx.push(capStart, (k + 1) % radial, k);
    idx.push(capStart + 1, last + k, last + ((k + 1) % radial));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** NACA-ish cambered airfoil (unit chord, leading edge at 0, trailing edge at 1), clockwise. */
function airfoil(n = 14, thick = 0.13, camber = 0.03): [number, number][] {
  const up: [number, number][] = [];
  const lo: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const x = (1 - Math.cos((i / n) * Math.PI)) / 2;
    const t = 5 * thick * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4);
    const yc = camber * 4 * x * (1 - x);
    up.push([x, yc + t]);
    lo.push([x, yc - t]);
  }
  return [...up.reverse(), ...lo.slice(1, -1)];
}

/**
 * Wing panel lofted along a span line. `chordAt(s)` and `leAt(s)` (leading-edge z) are given for the span
 * fraction s ∈ [0, 1]; chord runs towards +z (aft). Optional chord range [c0, c1] cuts out a slice
 * (e.g. 0.75..1 for an aileron) so control surfaces can be separate meshes.
 */
export function wing(opts: {
  root: THREE.Vector3;
  tip: THREE.Vector3;
  chordAt: (s: number) => number;
  leAt?: (s: number) => number;
  segs?: number;
  thick?: number;
  c0?: number;
  c1?: number;
  vertical?: boolean;
}): THREE.BufferGeometry {
  const prof = airfoil(12, opts.thick ?? 0.13).filter(([x]) => x >= (opts.c0 ?? 0) - 1e-6 && x <= (opts.c1 ?? 1) + 1e-6);
  const n = prof.length;
  const segs = opts.segs ?? 6;
  const pos: number[] = [];
  const idx: number[] = [];
  for (let j = 0; j <= segs; j++) {
    const s = j / segs;
    const base = new THREE.Vector3().lerpVectors(opts.root, opts.tip, s);
    const ch = opts.chordAt(s);
    const le = opts.leAt ? opts.leAt(s) : base.z;
    for (const [x, y] of prof) {
      if (opts.vertical) pos.push(base.x + y * ch, base.y, le + x * ch);
      else pos.push(base.x, base.y + y * ch, le + x * ch);
    }
  }
  // winding depends on the span direction (left wings and fins run the other way)
  const flip = opts.vertical ? opts.tip.y > opts.root.y : opts.tip.x < opts.root.x;
  const tri = (a: number, b: number, c: number) => (flip ? idx.push(a, c, b) : idx.push(a, b, c));
  for (let j = 0; j < segs; j++) {
    for (let k = 0; k < n; k++) {
      const a = j * n + k;
      const b = j * n + ((k + 1) % n);
      const c = (j + 1) * n + k;
      const d = (j + 1) * n + ((k + 1) % n);
      tri(a, d, b);
      tri(a, c, d);
    }
  }
  // caps
  for (const j of [0, segs]) {
    const c0 = j * n;
    for (let k = 1; k < n - 1; k++) {
      if (j === 0) tri(c0, c0 + k + 1, c0 + k);
      else tri(c0, c0 + k, c0 + k + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** A streamlined strut between two points. */
export function strut(a: THREE.Vector3, b: THREE.Vector3, r = 0.045, flat = 2.2): THREE.BufferGeometry {
  const len = a.distanceTo(b);
  const g = new THREE.CylinderGeometry(r, r, len, 8, 1);
  g.scale(1, 1, flat);
  const dir = new THREE.Vector3().subVectors(b, a).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  g.applyQuaternion(q);
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return g;
}

export function box(w: number, h: number, d: number, x: number, y: number, z: number): THREE.BufferGeometry {
  return new THREE.BoxGeometry(w, h, d).translate(x, y, z);
}
