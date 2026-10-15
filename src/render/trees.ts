// Instanced trees around the camera. Tiles are generated on the CPU within a per-frame time
// budget (nearest first) and packed into one instance buffer.
import * as THREE from 'three';
import { makeTreeTile, type TreeTile } from '../world/forest.ts';
import { ATMOSPHERE_GLSL, SKYVIEW_SAMPLE_GLSL } from './atmosphere.ts';
import { GLOBALS_GLSL, globals } from './globals.ts';
import { NOISE_GLSL } from '../world/noise.ts';
import { CLOUD_COMMON_GLSL } from './clouds.ts';
import { OUTPUT_GLSL } from './post.ts';

const TILE = 192;

const VERT = /* glsl */ `
in vec4 aTree;   // x, y, z, height
in vec4 aTree2;  // species, rotation, tint, phase
in vec3 aShape;  // ring t (0 trunk base .. 1 apex), angle, trunk flag
uniform float uMaxDist;
out vec3 vWorld;
out vec3 vNormal;
out vec3 vAlbedo;
out float vAO;
#include <logdepthbuf_pars_vertex>
float profile(float t, float birch) {
  // canopy radius (relative to height): pine = 4 stacked tiers, birch = lumpy ovoid
  float tier = fract(t * 4.0 - 0.001);
  float pine = (1.0 - t * 0.92) * 0.34 * (0.55 + 0.45 * (1.0 - tier));
  float bir = sin(clamp(t, 0.0, 1.0) * 3.14159) * 0.3 * (0.75 + 0.25 * t);
  return mix(pine, bir, birch);
}
float h3(vec3 v) { return fract(sin(dot(v, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
void main() {
  vec3 base = aTree.xyz;
  float H = aTree.w;
  float birch = aTree2.x;
  float dist = length(base - uCamPosF);
  float fade = 1.0 - smoothstep(uMaxDist * 0.8, uMaxDist, dist);
  if (fade <= 0.0) { gl_Position = vec4(0.0, 0.0, -2.0, 1.0); return; }
  H *= mix(0.4, 1.0, fade);
  float ang = aShape.y + aTree2.y;
  vec2 dir = vec2(cos(ang), sin(ang));
  vec3 p;
  vec3 n;
  if (aShape.z > 0.5) {
    // trunk
    float r = H * mix(0.022, 0.032, birch);
    float y = aShape.x * H * mix(0.32, 0.4, birch);
    p = vec3(dir.x * r, y, dir.y * r);
    n = vec3(dir.x, 0.0, dir.y);
  } else {
    float t = aShape.x;
    float y0 = mix(0.22, 0.3, birch);
    float y = (y0 + t * (1.0 - y0)) * H;
    float r = profile(t, birch) * H;
    // irregular outline
    float j = h3(vec3(aTree2.w, aShape.y, t));
    r *= mix(0.82 + 0.36 * j, 0.6 + 0.8 * j, birch);
    y += (h3(vec3(aShape.y, t, aTree2.w + 3.1)) - 0.5) * H * 0.05 * birch;
    p = vec3(dir.x * r, y, dir.y * r);
    float dr = (profile(min(t + 0.05, 1.0), birch) - profile(max(t - 0.05, 0.0), birch)) / 0.1 / (1.0 - y0);
    n = normalize(vec3(dir.x, -dr, dir.y) + vec3(0.0, 0.6, 0.0));
  }
  // wind sway grows with height
  float sway = (p.y / max(H, 1.0));
  sway *= sway;
  vec2 w = uWind.xz * 0.02 + vec2(0.0);
  p.xz += (w + 0.08 * vec2(sin(uTime * 1.3 + aTree2.w), cos(uTime * 1.1 + aTree2.w * 1.7))) * sway * H * 0.12;
  vec3 world = base + p;
  vWorld = world;
  vNormal = n;
  vAO = mix(0.45, 1.0, clamp(p.y / H, 0.0, 1.0));
  if (aShape.z > 0.5) {
    vAlbedo = birch > 0.5 ? vec3(0.42, 0.4, 0.37) : vec3(0.06, 0.04, 0.025);
  } else {
    vec3 pineCol = vec3(0.018, 0.034, 0.02) * (0.75 + 0.5 * aTree2.z);
    vec3 birchCol = mix(vec3(0.27, 0.18, 0.032), vec3(0.24, 0.1, 0.02), smoothstep(0.55, 0.85, aTree2.z));
    birchCol = mix(birchCol, vec3(0.14, 0.13, 0.035), step(0.88, aTree2.z));
    birchCol *= 0.8 + 0.4 * h3(vec3(aShape.xy, aTree2.w));
    vAlbedo = mix(pineCol, birchCol, birch);
  }
  gl_Position = projectionMatrix * (uViewRot * vec4(world - uCamPosF, 1.0));
  #include <logdepthbuf_vertex>
}
`;

const FRAG = /* glsl */ `
in vec3 vWorld;
in vec3 vNormal;
in vec3 vAlbedo;
in float vAO;
out vec4 fragColor;
#include <logdepthbuf_pars_fragment>
void main() {
  #include <logdepthbuf_fragment>
  vec3 N = normalize(vNormal);
  float tsh = terrainShadow(vWorld) * planeShadow(vWorld);
  float shSun = mix(1.0, tsh, uKeyIsSun) * cloudShadowAt(vWorld, uSunDir);
  float shMoon = mix(tsh, 1.0, uKeyIsSun) * cloudShadowAt(vWorld, uMoonDir);
  float ws = (dot(N, uSunDir) + 0.35) / 1.35;
  float wm = (dot(N, uMoonDir) + 0.35) / 1.35;
  vec3 direct = (uSunColor * max(ws, 0.0) * shSun + uMoonColor * max(wm, 0.0) * shMoon) / PI;
  // forward scattering through foliage
  float back = pow(max(dot(normalize(vWorld - uCamPosF), uSunDir), 0.0), 6.0) * 0.6;
  vec3 amb = envDiffuse(N) * vAO;
  vec3 col = vAlbedo * (direct * (1.0 + back) + amb + lampLight(vWorld, N) / PI);
  fragColor = finalOutput(applyFog(col, uCamPosF, vWorld));
}
`;

function treeGeometry(): THREE.InstancedBufferGeometry {
  const shape: number[] = [];
  const index: number[] = [];
  const SEG = 8;
  // pine tiers need a narrow ring just below each wide ring (sawtooth profile)
  const rings = [0, 0.235, 0.25, 0.485, 0.5, 0.735, 0.75, 0.9];
  for (const t of rings) for (let k = 0; k < SEG; k++) shape.push(t, (k / SEG) * Math.PI * 2, 0);
  const apex = shape.length / 3;
  shape.push(1, 0, 0);
  for (let r = 0; r < rings.length - 1; r++) {
    for (let k = 0; k < SEG; k++) {
      const a = r * SEG + k, b = r * SEG + ((k + 1) % SEG), c = (r + 1) * SEG + k, d = (r + 1) * SEG + ((k + 1) % SEG);
      index.push(a, c, b, b, c, d);
    }
  }
  const top = (rings.length - 1) * SEG;
  for (let k = 0; k < SEG; k++) index.push(top + k, apex, top + ((k + 1) % SEG));
  // underside cap
  const bottomCenter = shape.length / 3;
  shape.push(0.0, 0, 0);
  for (let k = 0; k < SEG; k++) index.push(bottomCenter, k, (k + 1) % SEG);
  // trunk (5 sides)
  const t0 = shape.length / 3;
  for (const y of [0, 1]) for (let k = 0; k < 5; k++) shape.push(y, (k / 5) * Math.PI * 2, 1);
  for (let k = 0; k < 5; k++) {
    const a = t0 + k, b = t0 + ((k + 1) % 5), c = t0 + 5 + k, d = t0 + 5 + ((k + 1) % 5);
    index.push(a, c, b, b, c, d);
  }
  const g = new THREE.InstancedBufferGeometry();
  const n = shape.length / 3;
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute('aShape', new THREE.BufferAttribute(new Float32Array(shape), 3));
  g.setIndex(index);
  return g;
}

export class Trees {
  readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly tiles = new Map<string, TreeTile>();
  private aTree: THREE.InstancedBufferAttribute;
  private aTree2: THREE.InstancedBufferAttribute;
  private capacity: number;
  private dirty = true;
  private lastKeys = '';
  readonly uniforms = { uMaxDist: { value: 1500 } };

  constructor(maxTrees: number, private readonly radius: number, private readonly cell: number, ldr: boolean) {
    this.geometry = treeGeometry();
    this.capacity = maxTrees;
    this.aTree = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 4), 4);
    this.aTree2 = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 4), 4);
    this.aTree.setUsage(THREE.DynamicDrawUsage);
    this.aTree2.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('aTree', this.aTree);
    this.geometry.setAttribute('aTree2', this.aTree2);
    this.geometry.instanceCount = 0;
    this.uniforms.uMaxDist.value = radius;
    const mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: ATMOSPHERE_GLSL + SKYVIEW_SAMPLE_GLSL + GLOBALS_GLSL + VERT,
      fragmentShader: ATMOSPHERE_GLSL + SKYVIEW_SAMPLE_GLSL + NOISE_GLSL + GLOBALS_GLSL + CLOUD_COMMON_GLSL + OUTPUT_GLSL + FRAG,
      uniforms: { ...globals, ...this.uniforms },
      defines: ldr ? { LDR_OUTPUT: '' } : {},
    });
    this.mesh = new THREE.Mesh(this.geometry, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
  }

  /** Generates missing tiles near (x, z) within `budgetMs` and repacks when the set changes. */
  update(x: number, z: number, budgetMs = 2): void {
    const R = Math.ceil(this.radius / TILE);
    const cx = Math.floor(x / TILE);
    const cz = Math.floor(z / TILE);
    const want: [number, number, number][] = [];
    for (let j = -R; j <= R; j++) {
      for (let i = -R; i <= R; i++) {
        const dx = Math.max(0, Math.abs(i) - 0.5) * TILE;
        const dz = Math.max(0, Math.abs(j) - 0.5) * TILE;
        const d = Math.hypot(dx, dz);
        if (d <= this.radius) want.push([cx + i, cz + j, d]);
      }
    }
    want.sort((a, b) => a[2] - b[2]);
    const keys = new Set(want.map(([i, j]) => `${i},${j}`));
    const t0 = performance.now();
    for (const [i, j] of want) {
      const k = `${i},${j}`;
      if (this.tiles.has(k)) continue;
      if (performance.now() - t0 > budgetMs) break;
      this.tiles.set(k, makeTreeTile(i, j, TILE, this.cell));
      this.dirty = true;
    }
    for (const k of this.tiles.keys()) {
      if (!keys.has(k)) {
        this.tiles.delete(k);
        this.dirty = true;
      }
    }
    const keyStr = [...keys].join(';');
    if (keyStr !== this.lastKeys) {
      this.lastKeys = keyStr;
      this.dirty = true;
    }
    if (this.dirty) this.repack(keys);
  }

  /** Synchronously fills everything within `radius` (used while loading). */
  prefill(x: number, z: number): void {
    this.update(x, z, 1e9);
  }

  private repack(keys: Set<string>): void {
    this.dirty = false;
    const a = this.aTree.array as Float32Array;
    const b = this.aTree2.array as Float32Array;
    let n = 0;
    for (const k of keys) {
      const t = this.tiles.get(k);
      if (!t) continue;
      for (let q = 0; q < t.count && n < this.capacity; q++, n++) {
        const o = q * 8;
        a.set(t.data.subarray(o, o + 4), n * 4);
        b.set(t.data.subarray(o + 4, o + 8), n * 4);
      }
    }
    this.geometry.instanceCount = n;
    this.aTree.needsUpdate = true;
    this.aTree2.needsUpdate = true;
  }

  get count(): number {
    return this.geometry.instanceCount;
  }
}
