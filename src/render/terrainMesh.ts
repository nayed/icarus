// Instanced clipmap meshes + terrain material.
import * as THREE from 'three';
import {
  type ClipmapConfig, type PieceGeometry, ringPiece, centerPiece, trimColumnPiece, trimRowPiece, clipInstances, CLIPMAP_GLSL,
} from '../world/clipmap.ts';
import { worldGlsl, STRIPS } from '../world/params.ts';
import { NOISE_GLSL } from '../world/noise.ts';
import { terrainGlsl } from '../world/terrain.ts';
import { ATMOSPHERE_GLSL, SKYVIEW_SAMPLE_GLSL } from './atmosphere.ts';
import { GLOBALS_GLSL, globals } from './globals.ts';
import { OUTPUT_GLSL } from './post.ts';
import { CLOUD_COMMON_GLSL } from './clouds.ts';
import { FullscreenPass, passMaterial } from './fullscreen.ts';
import { levelOrigin, levelSpacing } from '../world/clipmap.ts';

export function terrainPrefix(): string {
  return worldGlsl() + NOISE_GLSL + terrainGlsl() + CLIPMAP_GLSL;
}

export const TERRAIN_VERT = /* glsl */ `
in vec4 aInst;
out vec3 vWorld;
out vec3 vNormal;
out float vMorph;
#include <logdepthbuf_pars_vertex>
#ifdef HEIGHT_ATLAS
// Heights of every level's lattice, baked when a level moves (see TerrainMesh.update).
uniform highp sampler2D uHeightAtlas;
uniform vec2 uLevelOrigin[ATLAS_LEVELS];
uniform float uS0;
float atlasHeight(vec2 p, int L) {
  float s = uS0 * exp2(float(L));
  ivec2 t = ivec2(round((p - uLevelOrigin[L]) / s)) + (CLIP_M / 2 + 1);
  return texelFetch(uHeightAtlas, ivec2(t.x, t.y + L * ATLAS_W), 0).r;
}
vec3 atlasNormal(vec2 p, int L) {
  float s = uS0 * exp2(float(L));
  float hx0 = atlasHeight(p - vec2(s, 0.0), L);
  float hx1 = atlasHeight(p + vec2(s, 0.0), L);
  float hz0 = atlasHeight(p - vec2(0.0, s), L);
  float hz1 = atlasHeight(p + vec2(0.0, s), L);
  return normalize(vec3(hx0 - hx1, 2.0 * s, hz0 - hz1));
}
// Mirrors clipVertexHeight() using baked lattice heights.
float atlasVertexHeight(vec2 p, float s, int L, float k) {
  float hf = atlasHeight(p, L);
  if (k <= 0.0) return hf;
  ivec2 ii = ivec2(round(p / s));
  int ox = ii.x & 1;
  int oz = ii.y & 1;
  int C = L + 1;
  float hc;
  if (ox == 0 && oz == 0) hc = atlasHeight(p, C);
  else if (ox == 1 && oz == 0) hc = 0.5 * (atlasHeight(p - vec2(s, 0.0), C) + atlasHeight(p + vec2(s, 0.0), C));
  else if (ox == 0 && oz == 1) hc = 0.5 * (atlasHeight(p - vec2(0.0, s), C) + atlasHeight(p + vec2(0.0, s), C));
  else hc = 0.5 * (atlasHeight(p - vec2(s), C) + atlasHeight(p + vec2(s), C));
  return hf * (1.0 - k) + hc * k;
}
#else
vec3 normalAt(vec2 p, float e, int oct) {
  float hx0 = terrainHeight(p - vec2(e, 0.0), oct);
  float hx1 = terrainHeight(p + vec2(e, 0.0), oct);
  float hz0 = terrainHeight(p - vec2(0.0, e), oct);
  float hz1 = terrainHeight(p + vec2(0.0, e), oct);
  return normalize(vec3(hx0 - hx1, 2.0 * e, hz0 - hz1));
}
#endif
void main() {
  float s = aInst.z;
  vec2 p = aInst.xy + position.xz * s;
  float k = morphFactor(p, s);
#ifdef HEIGHT_ATLAS
  int L = int(aInst.w + 0.5);
  float h = atlasVertexHeight(p, s, L, k);
  vec3 n = atlasNormal(p, L);
  if (k > 0.0) {
    vec2 pc = floor(p / (2.0 * s) + 0.5) * 2.0 * s;
    n = normalize(mix(n, atlasNormal(pc, L + 1), k));
  }
#else
  float h = clipVertexHeight(p, s);
  vec3 n = normalAt(p, s, octavesForSpacing(s));
  if (k > 0.0) n = normalize(mix(n, normalAt(p, 2.0 * s, octavesForSpacing(2.0 * s)), k));
#endif
  vWorld = vec3(p.x, h, p.y);
  vNormal = n;
  vMorph = k;
  vec3 rel = vWorld - uCamPosF;
  gl_Position = projectionMatrix * (uViewRot * vec4(rel, 1.0));
  #include <logdepthbuf_vertex>
}
`;

const BAKE_FRAG = /* glsl */ `
uniform vec2 uLevelOrigin[ATLAS_LEVELS];
uniform float uS0;
out vec4 fragColor;
void main() {
  ivec2 fc = ivec2(gl_FragCoord.xy);
  int L = fc.y / ATLAS_W;
  ivec2 ij = ivec2(fc.x, fc.y - L * ATLAS_W) - (CLIP_M / 2 + 1);
  float s = uS0 * exp2(float(L));
  vec2 p = uLevelOrigin[L] + vec2(ij) * s;
  fragColor = vec4(terrainHeight(p, octavesForSpacing(s)), 0.0, 0.0, 1.0);
}
`;

function stripGlsl(): string {
  return STRIPS.map((s, i) => `  paintRunway(col, rough, P.xz, STRIP${i}_A, STRIP${i}_RW, ${s.id === 'coastal' ? '1.0' : '0.0'}, foot);`).join('\n');
}

const FRAG = /* glsl */ `
in vec3 vWorld;
in vec3 vNormal;
in float vMorph;
out vec4 fragColor;
#include <logdepthbuf_pars_fragment>

// Paints runway surface and markings. paved = 1 asphalt, 0 gravel.
void paintRunway(inout vec3 col, inout float rough, vec2 p, vec4 A, vec2 RW, float paved, float foot) {
  vec2 r = p - A.xy;
  vec2 l = vec2(r.x * A.z + r.y * A.w, -r.x * A.w + r.y * A.z);
  vec2 q = abs(l) - RW;
  float aa = max(foot, 0.05);
  float inside = 1.0 - smoothstep(-aa, aa, max(q.x, q.y));
  if (inside <= 0.0) return;
  float grain = vnoise(p * 1.7, 701u) * 0.5 + vnoise(p * 0.21, 702u) * 0.5;
  vec3 surf = paved > 0.5 ? vec3(0.045, 0.046, 0.05) * (0.85 + 0.25 * grain) : vec3(0.15, 0.13, 0.105) * (0.8 + 0.35 * grain);
  // tyre marks near the touchdown zones (paved only)
  float u = l.x;
  float v = l.y;
  float paint = 0.0;
  float fromEnd = RW.x - abs(u);
  // threshold bars
  float bars = step(6.0, fromEnd) * step(fromEnd, 36.0);
  float stripe = abs(fract((v + RW.y) / 3.2) - 0.5) * 3.2;
  paint = max(paint, bars * (1.0 - smoothstep(0.85 - aa, 0.85 + aa, stripe)) * step(abs(v), RW.y - 2.0));
  // centreline dashes
  float dash = step(fract(u / 50.0), 0.6) * step(abs(u), RW.x - 50.0);
  paint = max(paint, dash * (1.0 - smoothstep(0.45 - aa, 0.45 + aa, abs(v))));
  // edge lines (paved) / aim markers
  paint = max(paint, paved * (1.0 - smoothstep(0.4 - aa, 0.4 + aa, abs(abs(v) - (RW.y - 1.0)))));
  float aim = step(abs(fromEnd - 120.0), 22.0) * (1.0 - smoothstep(1.6 - aa, 1.6 + aa, abs(abs(v) - RW.y * 0.45)));
  paint = max(paint, aim);
  paint *= mix(0.55, 1.0, paved) * (1.0 - 0.25 * grain);
  // markings fade when smaller than a pixel to avoid shimmer
  paint *= 1.0 - smoothstep(0.6, 2.5, foot);
  surf = mix(surf, vec3(0.62, 0.62, 0.6), paint);
  col = mix(col, surf, inside);
  rough = mix(rough, paved > 0.5 ? 0.7 : 0.95, inside);
}

void main() {
  #include <logdepthbuf_fragment>
  if (uReflectPass > 0.5 && vWorld.y < SEA_LEVEL - 0.3) discard;
  vec3 P = vWorld;
  vec3 cam = uCamPosF;
  vec3 V = P - cam;
  float dist = length(V);
  float foot = dist * uPixelAngle;
  vec3 N = normalize(vNormal);
  float y = P.y;

  // ---- material classification
  float nL = vnoise(P.xz * (1.0 / 520.0), 501u);
  float nM = vnoise(P.xz * (1.0 / 110.0), 502u);
  float nS = vnoise(P.xz * (1.0 / 19.0), 503u);
  float nT = vnoise(P.xz * (1.0 / 4.3), 504u);
  float slope = 1.0 - N.y;
  float snowLine = 960.0 + 160.0 * nL + 150.0 * N.z + 45.0 * nM;
  float snow = smoothstep(snowLine - 40.0, snowLine + 60.0, y) * (1.0 - smoothstep(0.34, 0.52, slope + 0.07 * nS));
  // a dusting on gentle slopes a little lower down
  snow = max(snow, 0.6 * smoothstep(snowLine - 170.0, snowLine - 40.0, y) * (1.0 - smoothstep(0.1, 0.2, slope + 0.06 * nT)) * smoothstep(-0.2, 0.5, nS + 0.3 * nT));
  float treeLine = 430.0 + 110.0 * nL;
  float forest = (1.0 - smoothstep(treeLine - 80.0, treeLine + 30.0, y))
    * (1.0 - smoothstep(0.2, 0.36, slope))
    * smoothstep(3.0, 10.0, y)
    * smoothstep(-0.55, 0.05, nM + 0.45 * nS);
  float rock = smoothstep(0.17, 0.33, slope + 0.07 * nS + 0.03 * nT);
  float scree = smoothstep(0.1, 0.2, slope) * (1.0 - rock) * smoothstep(250.0, 600.0, y);
  float beach = (1.0 - smoothstep(1.5, 4.5, y + 2.0 * nS)) * (1.0 - smoothstep(0.2, 0.45, slope));

  // ---- detail normal (procedural micro relief beyond the mesh resolution)
  vec2 dsum = vec2(0.0);
  float detailStr = mix(0.18, 0.45, max(rock, scree)) * (1.0 - 0.75 * snow) * (1.0 - 0.6 * forest);
  for (int i = 0; i < 5; i++) {
    float f = 1.0 / (60.0 / pow(2.3, float(i)));
    float fade = 1.0 - smoothstep(0.15, 0.5, foot * f);
    if (fade <= 0.0) break;
    vec3 g = gnoised(P.xz * f + float(i) * 17.3, 610u + uint(i));
    dsum += g.yz * fade;
  }
  N = normalize(N + vec3(-dsum.x, 0.0, -dsum.y) * detailStr * 0.32);

  // ---- albedo (autumn: golden birch, rusty heath, dark wet rock, fresh snow on the tops)
  vec3 heath = mix(vec3(0.075, 0.068, 0.04), vec3(0.11, 0.07, 0.035), smoothstep(-0.4, 0.5, nM));
  heath = mix(heath, vec3(0.13, 0.05, 0.025), smoothstep(0.35, 0.75, nS) * smoothstep(-0.2, 0.4, nM) * 0.7);
  heath = mix(heath, vec3(0.1, 0.095, 0.08), smoothstep(0.2, 0.9, nT) * 0.35);
  heath *= 0.85 + 0.3 * nT;
  vec3 birch = mix(vec3(0.24, 0.16, 0.03), vec3(0.2, 0.085, 0.02), smoothstep(0.2, 0.9, nS));
  vec3 pine = vec3(0.02, 0.034, 0.02);
  vec3 forestCol = mix(pine, birch, smoothstep(-0.5, 0.4, nL + 0.7 * nM)) * (0.7 + 0.45 * (0.5 + 0.5 * nT));
  float strata = 0.5 + 0.5 * sin(y * 0.07 + nM * 3.0 + nS);
  vec3 rockCol = mix(vec3(0.055, 0.056, 0.06), vec3(0.13, 0.125, 0.12), smoothstep(-0.6, 0.7, nM + 0.25 * strata + 0.3 * nT));
  vec3 screeCol = mix(vec3(0.1, 0.095, 0.085), vec3(0.16, 0.15, 0.135), 0.5 + 0.5 * nT);
  vec3 snowCol = vec3(0.8, 0.83, 0.88) * (0.94 + 0.06 * nT);
  vec3 beachCol = mix(vec3(0.15, 0.14, 0.12), vec3(0.06, 0.055, 0.05), 1.0 - smoothstep(0.0, 2.0, y));
  vec3 col = heath;
  col = mix(col, forestCol, forest);
  col = mix(col, screeCol, scree);
  col = mix(col, rockCol, rock);
  col = mix(col, beachCol, beach);
  col = mix(col, snowCol, snow);
  col = mix(col, vec3(0.04, 0.045, 0.04), 1.0 - smoothstep(-3.0, 0.0, y));
  float rough = 0.9;
STRIP_PAINT

  // ---- lighting
  float tsh = terrainShadow(P);
  float shSun = mix(1.0, tsh, uKeyIsSun) * cloudShadowAt(P, uSunDir);
  float shMoon = mix(tsh, 1.0, uKeyIsSun) * cloudShadowAt(P, uMoonDir);
  float shadow = shSun;
  float ndl = max(dot(N, uSunDir), 0.0);
  float ndm = max(dot(N, uMoonDir), 0.0);
  vec3 direct = (uSunColor * ndl * shSun + uMoonColor * ndm * shMoon) / PI;
  vec3 amb = envDiffuse(N) * (0.6 + 0.4 * N.y);
  vec3 lit = col * (direct + amb + lampLight(P, N) / PI);
  // snow sheen
  vec3 H = normalize(uSunDir - normalize(V));
  float spec = pow(max(dot(N, H), 0.0), 60.0) * snow * 0.4 * shadow;
  lit += uSunColor * spec * ndl / PI;

  vec3 outc = applyFog(lit, cam, P);
  fragColor = finalOutput(outc);
}
`;

export function terrainVertexShader(): string {
  return ATMOSPHERE_GLSL + SKYVIEW_SAMPLE_GLSL + GLOBALS_GLSL + terrainPrefix() + TERRAIN_VERT;
}

export class TerrainMesh {
  readonly group = new THREE.Group();
  readonly material: THREE.ShaderMaterial;
  private readonly attrs: { ring: THREE.InstancedBufferAttribute; center: THREE.InstancedBufferAttribute; column: THREE.InstancedBufferAttribute; row: THREE.InstancedBufferAttribute };
  private readonly meshes: THREE.Mesh[] = [];
  readonly uniforms = {
    uClipCenter: { value: new THREE.Vector2() },
    uClipM: { value: 0 },
    uHeightAtlas: { value: null as THREE.Texture | null },
    uLevelOrigin: { value: [] as THREE.Vector2[] },
    uS0: { value: 1 },
  };
  /** Baked lattice heights (null → vertices evaluate the terrain function directly). */
  private readonly atlas: THREE.WebGLRenderTarget | null = null;
  private readonly bake: FullscreenPass | null = null;
  private readonly baked: { x: number; z: number }[] = [];
  readonly defines: Record<string, string | number>;

  constructor(readonly cfg: ClipmapConfig, ldr: boolean, useAtlas: boolean) {
    this.uniforms.uClipM.value = cfg.M;
    this.uniforms.uS0.value = cfg.s0;
    const atlasLevels = cfg.levels + 1; // one extra level only feeds the outermost morph
    const W = cfg.M + 3;
    this.defines = useAtlas ? { HEIGHT_ATLAS: '', CLIP_M: cfg.M, ATLAS_LEVELS: atlasLevels, ATLAS_W: W } : {};
    for (let L = 0; L < atlasLevels; L++) {
      this.uniforms.uLevelOrigin.value.push(new THREE.Vector2(1e9, 1e9));
      this.baked.push({ x: NaN, z: NaN });
    }
    if (useAtlas) {
      this.atlas = new THREE.WebGLRenderTarget(W, W * atlasLevels, {
        type: THREE.FloatType,
        format: THREE.RedFormat,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        depthBuffer: false,
        generateMipmaps: false,
      });
      this.uniforms.uHeightAtlas.value = this.atlas.texture;
      const bm = passMaterial(terrainPrefix() + BAKE_FRAG, { uLevelOrigin: this.uniforms.uLevelOrigin, uS0: this.uniforms.uS0, uClipCenter: this.uniforms.uClipCenter, uClipM: this.uniforms.uClipM }, this.defines);
      this.bake = new FullscreenPass(bm);
    }
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: terrainVertexShader(),
      fragmentShader:
        ATMOSPHERE_GLSL + SKYVIEW_SAMPLE_GLSL + GLOBALS_GLSL + terrainPrefix() + CLOUD_COMMON_GLSL + OUTPUT_GLSL + FRAG.replace('STRIP_PAINT', stripGlsl()),
      uniforms: { ...globals, ...this.uniforms },
      defines: { ...this.defines, ...(ldr ? { LDR_OUTPUT: '' } : {}) },
    });
    const make = (piece: PieceGeometry, count: number) => {
      const g = new THREE.InstancedBufferGeometry();
      const pos = new Float32Array((piece.local.length / 2) * 3);
      for (let v = 0; v < piece.local.length / 2; v++) {
        pos[3 * v] = piece.local[2 * v];
        pos[3 * v + 2] = piece.local[2 * v + 1];
      }
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setIndex(new THREE.BufferAttribute(piece.index, 1));
      const inst = new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4);
      inst.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('aInst', inst);
      g.instanceCount = count;
      const m = new THREE.Mesh(g, this.material);
      m.frustumCulled = false;
      m.layers.enable(1); // visible in the water reflection
      this.meshes.push(m);
      this.group.add(m);
      return inst;
    };
    const L = cfg.levels;
    this.attrs = {
      center: make(centerPiece(cfg.M), 1),
      ring: make(ringPiece(cfg.M), L),
      column: make(trimColumnPiece(cfg.M), L - 1),
      row: make(trimRowPiece(cfg.M), L - 1),
    };
    // fine levels first so early depth rejects the coarse ones underneath
    this.meshes.forEach((m, i) => (m.renderOrder = i));
  }

  /** Re-centres the clipmap on (x, z) and re-bakes the levels that moved. Must match the ClipState used for collision. */
  update(renderer: THREE.WebGLRenderer, x: number, z: number): number {
    const inst = clipInstances(this.cfg, x, z);
    this.uniforms.uClipCenter.value.set(Math.fround(x), Math.fround(z));
    const put = (a: THREE.InstancedBufferAttribute, v: number[]) => {
      (a.array as Float32Array).set(v);
      a.needsUpdate = true;
    };
    put(this.attrs.ring, inst.ring);
    put(this.attrs.center, inst.center);
    put(this.attrs.column, inst.column);
    put(this.attrs.row, inst.row);
    let baked = 0;
    if (this.atlas && this.bake) {
      const W = this.cfg.M + 3;
      for (let L = 0; L < this.baked.length; L++) {
        const s = levelSpacing(this.cfg, L);
        const ox = levelOrigin(x, s);
        const oz = levelOrigin(z, s);
        this.uniforms.uLevelOrigin.value[L].set(ox, oz);
        const b = this.baked[L];
        if (b.x === ox && b.z === oz) continue;
        b.x = ox;
        b.z = oz;
        this.atlas.scissor.set(0, L * W, W, W);
        this.atlas.scissorTest = true;
        this.bake.render(renderer, this.atlas);
        baked++;
      }
      this.atlas.scissorTest = false;
    }
    return baked;
  }

  dispose(): void {
    for (const m of this.meshes) m.geometry.dispose();
    this.material.dispose();
    this.atlas?.dispose();
    this.bake?.material.dispose();
  }
}
