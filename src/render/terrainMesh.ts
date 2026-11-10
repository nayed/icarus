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
import { stripClearingGlsl } from '../world/forest.ts';

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
  #include <icarus_logdepth_vertex>
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
  return STRIPS.map((s, i) => `  paintRunway(col, rough, P.xz, STRIP${i}_A, STRIP${i}_RW, ${s.surface === 'paved' ? '1.0' : '0.0'}, foot);`).join('\n');
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
  // gravel is pale and dusty so the strip reads against the darker tundra from a long final
  vec3 surf = paved > 0.5 ? vec3(0.045, 0.046, 0.05) * (0.85 + 0.25 * grain) : vec3(0.3, 0.275, 0.235) * (0.82 + 0.3 * grain);
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
  // gravel: white edge markers, 6 m long every 40 m along both sides
  float edgeMk = (1.0 - paved) * step(fract(u / 40.0), 0.15) * (1.0 - smoothstep(0.9 - aa, 0.9 + aa, abs(abs(v) - (RW.y - 1.2))));
  paint = max(paint, edgeMk);
  paint *= mix(0.9, 1.0, paved) * (1.0 - 0.25 * grain);
  // markings fade when smaller than a pixel to avoid shimmer
  paint *= 1.0 - smoothstep(0.6, 2.5, foot);
  surf = mix(surf, vec3(0.62, 0.62, 0.6), paint);
  col = mix(col, surf, inside);
  rough = mix(rough, paved > 0.5 ? 0.7 : 0.95, inside);
}

// Rock relief in a vertical plane (q.x along the face, q.y up), so it does not stretch down a steep
// slope the way noise projected from above does: broad beds, strata, thin ledges and vertical cracks.
// Returns the bedding value (about -1..1), the relief's gradient in metres per metre along q, and
// how deep in a crack the point is (0..1); stain is the dark streaks water leaves down a wall.
// warp (metres) folds the beds.
vec4 rockPlane(vec2 q, float warp, float foot, uint seed, out float stain) {
  stain = smoothstep(0.15, 0.7, vnoise(q * vec2(1.0 / 23.0, 1.0 / 380.0) + 11.0, seed + 4u));
  // the beds dip and fold instead of lying level
  q.y += 0.11 * q.x + warp;
  float val = 0.0;
  vec2 grad = vec2(0.0);
  float crack = 0.0;
  float f = 1.0 - smoothstep(0.25, 0.7, foot / 26.0);
  if (f > 0.0) {
    vec3 n = noised(q * vec2(1.0 / 310.0, 1.0 / 26.0), seed);
    val += 0.55 * n.x * f;
    grad += 3.2 * f * n.yz * vec2(1.0 / 310.0, 1.0 / 26.0);
  }
  f = 1.0 - smoothstep(0.25, 0.7, foot / 6.0);
  if (f > 0.0) {
    vec3 n = noised(q * vec2(1.0 / 70.0, 1.0 / 6.0) + 31.7, seed + 1u);
    val += 0.35 * n.x * f;
    grad += 0.9 * f * n.yz * vec2(1.0 / 70.0, 1.0 / 6.0);
  }
  f = 1.0 - smoothstep(0.25, 0.7, foot / 1.7);
  if (f > 0.0) {
    vec3 n = noised(q * vec2(1.0 / 19.0, 1.0 / 1.7) + 7.3, seed + 2u);
    val += 0.2 * n.x * f;
    grad += 0.26 * f * n.yz * vec2(1.0 / 19.0, 1.0 / 1.7);
    // cracks and gullies run down the face
    vec2 qc = vec2(q.x + 2.2 * vnoise(vec2(q.y * (1.0 / 8.0), 0.5), seed + 8u), q.y);
    vec3 c = noised(qc * vec2(1.0 / 4.7, 1.0 / 30.0) + 3.9, seed + 3u);
    float cf = 1.0 - smoothstep(0.2, 0.6, foot / 2.0);
    float d = 1.0 - smoothstep(0.0, 0.22, abs(c.x));
    crack = d * cf;
    grad += 0.9 * cf * d * sign(c.x) * c.yz * vec2(1.0 / 4.7, 1.0 / 30.0);
  }
  return vec4(val, grad, crack);
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
  // fine ground texture, only where a pixel resolves it
  float fF = 1.0 - smoothstep(0.2, 0.6, foot / 0.9);
  float nF = fF > 0.0 ? vnoise(P.xz * (1.0 / 0.9), 505u) * fF : 0.0;
  float fG = 1.0 - smoothstep(0.2, 0.6, foot / 0.21);
  float nG = fG > 0.0 ? vnoise(P.xz * (1.0 / 0.21), 506u) * fG : 0.0;
  // rock relief on steep faces, from the two vertical planes weighted by the way the face looks
  float steep = smoothstep(0.13, 0.38, slope);
  vec3 N0 = N;
  float bed = 0.0;
  float crack = 0.0;
  float stain = 0.0;
  vec3 rockGrad = vec3(0.0);
  if (steep > 0.0) {
    vec2 w2 = N.xz * N.xz;
    // a narrow blend: most pixels read one plane only
    float wx = smoothstep(0.3, 0.7, w2.x / max(w2.x + w2.y, 1e-6));
    float warp = 70.0 * nL + 9.0 * nM;
    if (wx > 0.0) {
      float st;
      vec4 r = rockPlane(P.zy, warp, foot, 620u, st);
      stain += wx * st;
      bed += wx * r.x;
      crack += wx * r.w;
      rockGrad += wx * vec3(0.0, r.z, r.y);
    }
    if (wx < 1.0) {
      float st;
      vec4 r = rockPlane(P.xy, warp, foot, 630u, st);
      stain += (1.0 - wx) * st;
      bed += (1.0 - wx) * r.x;
      crack += (1.0 - wx) * r.w;
      rockGrad += (1.0 - wx) * vec3(r.y, r.z, 0.0);
    }
  }
  float snowLine = 960.0 + 160.0 * nL + 150.0 * N.z + 45.0 * nM;
  // snow holds on the ledges of a steep face and slides off the beds between them
  float snow = smoothstep(snowLine - 40.0, snowLine + 60.0, y) * (1.0 - smoothstep(0.34, 0.52, slope + 0.07 * nS - 0.16 * steep * bed));
  // a dusting on gentle slopes a little lower down
  snow = max(snow, 0.6 * smoothstep(snowLine - 170.0, snowLine - 40.0, y) * (1.0 - smoothstep(0.1, 0.2, slope + 0.06 * nT)) * smoothstep(-0.2, 0.5, nS + 0.3 * nT));
  float treeLine = 430.0 + 110.0 * nL;
  float forest = (1.0 - smoothstep(treeLine - 80.0, treeLine + 30.0, y))
    * (1.0 - smoothstep(0.2, 0.36, slope))
    * smoothstep(3.0, 10.0, y)
    * smoothstep(-0.55, 0.05, nM + 0.45 * nS)
    * stripClearing(P.xz);
  // the finer the noise a pixel resolves, the crisper the edge between heath and rock
  float rock = smoothstep(0.19, 0.31, slope + 0.07 * nS + 0.045 * nT + 0.04 * nF + 0.025 * nG);
  float scree = smoothstep(0.1, 0.2, slope) * (1.0 - rock) * smoothstep(250.0, 600.0, y);
  float beach = (1.0 - smoothstep(1.5, 4.5, y + 2.0 * nS)) * (1.0 - smoothstep(0.2, 0.45, slope));

  // ---- detail normal (procedural micro relief beyond the mesh resolution)
  vec2 dsum = vec2(0.0);
  float detailStr = mix(0.2, 0.75, max(rock, scree)) * (1.0 - 0.75 * snow) * (1.0 - 0.6 * forest);
  for (int i = 0; i < 7; i++) {
    float f = 1.0 / (60.0 / pow(2.3, float(i)));
    float fade = 1.0 - smoothstep(0.15, 0.5, foot * f);
    if (fade <= 0.0) break;
    vec3 g = gnoised(P.xz * f + float(i) * 17.3, 610u + uint(i));
    dsum += g.yz * fade;
  }
  N = normalize(N + vec3(-dsum.x, 0.0, -dsum.y) * detailStr * 0.32);
  // forest canopy seen from above: crowns as bumps where the trees themselves are too far to draw
  if (forest > 0.0) {
    float cf = 1.0 - smoothstep(0.2, 0.6, foot / 7.0);
    if (cf > 0.0) {
      vec3 c = gnoised(P.xz * (1.0 / 7.0) + 5.1, 640u);
      N = normalize(N + vec3(-c.y, 0.0, -c.z) * 0.55 * cf * forest);
    }
  }
  // rock relief: tilt the normal by the relief's gradient within the surface
  float rockBump = steep * rock * (1.0 - 0.85 * snow);
  if (rockBump > 0.0) {
    vec3 gT = rockGrad - N0 * dot(N0, rockGrad);
    N = normalize(N - gT * rockBump);
  }

  // ---- albedo (autumn: golden birch, rusty heath, dark wet rock, fresh snow on the tops)
  vec3 heath = mix(vec3(0.075, 0.068, 0.04), vec3(0.11, 0.07, 0.035), smoothstep(-0.4, 0.5, nM));
  heath = mix(heath, vec3(0.13, 0.05, 0.025), smoothstep(0.35, 0.75, nS) * smoothstep(-0.2, 0.4, nM) * 0.7);
  heath = mix(heath, vec3(0.1, 0.095, 0.08), smoothstep(0.2, 0.9, nT) * 0.35);
  heath *= 0.85 + 0.3 * nT;
  // close up: dry grass tufts and bare patches
  heath = mix(heath, vec3(0.17, 0.135, 0.06), 0.5 * smoothstep(0.0, 0.8, nF + 0.6 * nG));
  heath = mix(heath, vec3(0.045, 0.04, 0.03), 0.5 * smoothstep(0.25, 0.9, -nF - 0.4 * nG));
  vec3 birch = mix(vec3(0.24, 0.16, 0.03), vec3(0.2, 0.085, 0.02), smoothstep(0.2, 0.9, nS));
  vec3 pine = vec3(0.02, 0.034, 0.02);
  vec3 forestCol = mix(pine, birch, smoothstep(-0.5, 0.4, nL + 0.7 * nM)) * (0.7 + 0.45 * (0.5 + 0.5 * nT));
  float strata = 0.5 + 0.5 * sin(y * 0.07 + nM * 3.0 + nS);
  float rockTone = mix(nM + 0.25 * strata + 0.3 * nT, 0.6 * nM + 0.75 * bed + 0.25 * nT, steep);
  vec3 rockCol = mix(vec3(0.05, 0.051, 0.056), vec3(0.14, 0.133, 0.125), smoothstep(-0.6, 0.7, rockTone));
  // iron staining in some beds, dark wet cracks, heath on the ledges below the tree line
  rockCol = mix(rockCol, rockCol * vec3(1.35, 1.0, 0.72), smoothstep(0.0, 0.9, nL + 0.6 * nM - 0.8 * bed) * 0.6);
  rockCol *= (1.0 - 0.28 * crack * steep) * (1.0 - 0.42 * stain * smoothstep(-0.4, 0.3, nL - nM) * smoothstep(0.3, 0.55, slope));
  rockCol = mix(rockCol, heath * 1.15, 0.7 * steep * smoothstep(0.05, 0.4, bed) * (1.0 - smoothstep(0.3, 0.5, slope)) * (1.0 - smoothstep(350.0, 800.0, y)));
  rockCol *= 1.0 + 0.22 * nT + 0.22 * nF + 0.14 * nG;
  vec3 screeCol = mix(vec3(0.1, 0.095, 0.085), vec3(0.16, 0.15, 0.135), 0.5 + 0.5 * nT) * (1.0 + 0.3 * nF + 0.25 * nG);
  vec3 snowCol = vec3(0.75, 0.78, 0.84) * (0.94 + 0.06 * nT);
  // wind-packed drifts: long ripples across the wind, seen in the low sun
  if (snow > 0.0) {
    vec2 wd = normalize(uWind.xz + vec2(1e-3, 0.0));
    vec2 sq = vec2(dot(P.xz, wd), dot(P.xz, vec2(-wd.y, wd.x)));
    float sf = 1.0 - smoothstep(0.2, 0.6, foot / 3.0);
    if (sf > 0.0) {
      vec3 d1 = gnoised(sq * vec2(1.0 / 3.0, 1.0 / 14.0), 650u);
      vec3 d2 = gnoised(sq * vec2(1.0 / 0.8, 1.0 / 3.5) + 9.0, 651u) * (1.0 - smoothstep(0.2, 0.6, foot / 0.8));
      vec2 gs = d1.yz * vec2(1.0, 3.0 / 14.0) + 0.6 * d2.yz * vec2(1.0, 0.8 / 3.5);
      vec3 gw = vec3(gs.x * wd.x - gs.y * wd.y, 0.0, gs.x * wd.y + gs.y * wd.x);
      N = normalize(N - gw * 0.16 * sf * snow);
    }
  }
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
  vec2 tl = terrainLight(P);
  float tsh = tl.x * planeShadow(P);
  float shSun = mix(1.0, tsh, uKeyIsSun) * cloudShadowAt(P, uSunDir);
  float shMoon = mix(tsh, 1.0, uKeyIsSun) * cloudShadowAt(P, uMoonDir);
  float shadow = shSun;
  // less sky reaches the valley floors and the foot of the walls, and the inside of a crack
  float occ = skyOcclusion(tl.y) * (1.0 - 0.35 * crack * rockBump);
  float ndl = max(dot(N, uSunDir), 0.0);
  float ndm = max(dot(N, uMoonDir), 0.0);
  vec3 direct = (uSunColor * ndl * shSun + uMoonColor * ndm * shMoon) / PI;
  vec3 amb = envDiffuse(N) * (0.6 + 0.4 * N.y) * occ;
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
        ATMOSPHERE_GLSL + SKYVIEW_SAMPLE_GLSL + GLOBALS_GLSL + terrainPrefix() + stripClearingGlsl() + CLOUD_COMMON_GLSL + OUTPUT_GLSL + FRAG.replace('STRIP_PAINT', stripGlsl()),
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
