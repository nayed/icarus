// Sky dome: atmosphere LUT + sun/moon discs + stars + Milky Way + aurora + cirrus.
// Rendered as a far-plane triangle in the main pass and into an equirect environment map.
import * as THREE from 'three';
import { ATMOSPHERE_GLSL, SKYVIEW_SAMPLE_GLSL } from './atmosphere.ts';
import { GLOBALS_GLSL, globals } from './globals.ts';
import { NOISE_GLSL } from '../world/noise.ts';
import { FullscreenPass } from './fullscreen.ts';
import { CLOUD_COMMON_GLSL } from './clouds.ts';

export const SKY_FUNCS_GLSL = /* glsl */ `
uniform vec3 uSunDiscRad;
uniform vec3 uMoonRad;

vec3 sunDisc(vec3 d) {
  const float R = 0.0048;
  float c = dot(d, uSunDir);
  if (c < cos(R * 1.1)) return vec3(0.0);
  float r = sqrt(max(0.0, 1.0 - c * c)) / R;
  float mu = sqrt(max(0.0, 1.0 - min(r * r, 1.0)));
  vec3 limb = 1.0 - vec3(0.42, 0.5, 0.62) * (1.0 - mu);
  vec3 T = lightTransmittance(uTransmittance, vec3(0.0, ATM_RG + uCamAltKm, 0.0), d);
  return uSunDiscRad * T * limb * (1.0 - smoothstep(0.96, 1.04, r));
}

vec3 moonDisc(vec3 d) {
  const float R = 0.0047;
  vec3 m = uMoonDir;
  if (dot(d, m) < cos(R * 1.2)) return vec3(0.0);
  vec3 right = normalize(cross(m, vec3(0.0, 1.0, 0.0)));
  vec3 up = cross(right, m);
  vec2 q = vec2(dot(d, right), dot(d, up)) / R;
  float rr = dot(q, q);
  if (rr > 1.05) return vec3(0.0);
  vec3 n = normalize(q.x * right + q.y * up - sqrt(max(0.0, 1.0 - rr)) * m);
  float lit = max(dot(n, uSunDir), 0.0);
  // maria and craters
  vec2 mq = q * 2.2 + vec2(3.1, 1.7);
  float mar = 0.62 + 0.38 * smoothstep(-0.35, 0.25, vnoise(mq, 401u) + 0.5 * vnoise(mq * 2.3, 402u));
  float crater = 0.92 + 0.08 * vnoise(q * 14.0, 403u);
  vec3 T = lightTransmittance(uTransmittance, vec3(0.0, ATM_RG + uCamAltKm, 0.0), d);
  float edge = 1.0 - smoothstep(0.94, 1.05, rr);
  return uMoonRad * T * (lit * mar * crater + 0.0025) * edge;
}

vec3 stars(vec3 d, float pixAngle) {
  vec3 c = uStarRot * d;
  vec3 a = abs(c);
  uint face;
  vec2 uv;
  if (a.x >= a.y && a.x >= a.z) { face = c.x > 0.0 ? 0u : 1u; uv = c.yz / a.x; }
  else if (a.y >= a.z) { face = c.y > 0.0 ? 2u : 3u; uv = c.xz / a.y; }
  else { face = c.z > 0.0 ? 4u : 5u; uv = c.xy / a.z; }
  const float RES = 240.0;
  vec2 g = (uv * 0.5 + 0.5) * RES;
  vec2 cell = floor(g);
  vec2 f = g - cell;
  uint h = hashU(uint(cell.x) + uint(cell.y) * 4099u + face * 1000003u + 9173u);
  float r1 = float(h & 1023u) / 1023.0;
  float r2 = float((h >> 10u) & 1023u) / 1023.0;
  float r3 = float((h >> 20u) & 1023u) / 1023.0;
  uint h2 = hashU(h);
  float r4 = float(h2 & 1023u) / 1023.0;
  float r5 = float((h2 >> 10u) & 1023u) / 1023.0;
  float present = step(0.58, r4);
  float mag = r1 * r1 * r1 * r1 * r1 * r1;           // few bright, many faint
  vec2 sp = 0.2 + 0.6 * vec2(r2, r3);
  float cellAngle = 1.5708 / (RES * 0.5) * 0.5;
  float distPx = length(f - sp) * cellAngle / max(pixAngle, 1e-5);
  float psf = exp(-distPx * distPx * 1.1);
  float tw = 0.7 + 0.3 * sin(uTime * (2.0 + 5.0 * r5) + r2 * 40.0);
  vec3 tint = mix(vec3(1.0, 0.78, 0.6), vec3(0.72, 0.82, 1.0), r5);
  // Milky Way
  vec3 gal = normalize(vec3(-0.62, 0.48, -0.62));
  float b = dot(c, gal);
  float band = exp(-b * b / 0.025);
  float mw = band * (0.55 + 0.45 * vnoise(c.xy * 9.0 + c.z * 3.0, 411u)) * (1.0 - 0.7 * exp(-(b + 0.03) * (b + 0.03) / 0.0012) * (0.5 + 0.5 * vnoise(c.yz * 14.0, 412u)));
  vec3 starL = tint * (0.04 + 6.0 * mag) * psf * tw * present;
  return (starL + vec3(0.75, 0.82, 1.0) * mw * 0.022) * uStarBright;
}

vec3 aurora(vec3 d, vec2 frag, float pixAngle) {
  if (uAurora <= 0.0 || d.y < 0.015) return vec3(0.0);
  const int N = 26;
  float h0 = 95.0;
  float h1 = 250.0;
  float t0 = h0 / d.y;
  float t1 = min(h1 / d.y, t0 + 700.0);
  float dt = (t1 - t0) / float(N);
  float j = float(hashU(uint(frag.x) * 1973u + uint(frag.y) * 9277u + uint(uTime * 60.0) * 26699u) >> 8u) / 16777216.0;
  vec3 acc = vec3(0.0);
  float drift = uTime * 0.0035;
  for (int i = 0; i < N; i++) {
    float t = t0 + (float(i) + j) * dt;
    vec3 p = d * t;
    float across = p.z + 160.0 * sin(p.x * 0.0021 + drift * 4.0) + 90.0 * vnoise(vec2(p.x * 0.005 + drift, 0.5), 421u);
    float k = fract(across / 300.0) - 0.5;
    float band = abs(k) * 300.0;
    float w = 7.0 + 7.0 * (0.5 + 0.5 * vnoise(vec2(p.x * 0.012, across * 0.004), 422u));
    // band-limit: widen the curtain to the pixel footprint on the layer (energy preserving)
    float fp = t * pixAngle / max(d.y, 0.04) * 1.5;
    float we = sqrt(w * w + fp * fp);
    float curtain = exp(-band * band / (we * we)) * (w / we);
    float rays = 0.35 + 0.65 * smoothstep(-0.3, 0.8, vnoise(vec2(p.x * 0.09 + drift * 12.0, floor(across / 300.0) * 7.0), 423u));
    float hh = p.y;
    float vert = smoothstep(h0, h0 + 7.0, hh) * exp(-(hh - h0) / 42.0);
    vec3 col = mix(vec3(0.12, 1.0, 0.42), vec3(0.75, 0.2, 0.55), smoothstep(118.0, 205.0, hh));
    acc += col * curtain * rays * vert * dt;
  }
  float horizon = smoothstep(0.015, 0.12, d.y);
  return acc * uAurora * horizon * 0.02;
}

/** High thin cirrus lit by the (reddened) sun: mixes over the base sky radiance. */
vec3 cirrus(vec3 d, vec3 base) {
  if (d.y < 0.01) return base;
  float t = 8.0 / d.y;
  vec2 p = d.xz * t + uCloudOffset * 0.0004;
  vec2 q = vec2(p.x * 0.045 + p.y * 0.02, p.y * 0.14 - p.x * 0.03);
  // fade octaves that would alias (pixel footprint in noise space)
  float fw = length(fwidth(q));
  float n = 0.5 * vnoise(q, 431u);
  n += 0.25 * vnoise(q * 2.1 + 3.0, 432u) * (1.0 - smoothstep(0.15, 0.4, fw * 2.1));
  n += 0.125 * vnoise(q * 4.3 + 7.0, 433u) * (1.0 - smoothstep(0.15, 0.4, fw * 4.3));
  n += 0.0625 * vnoise(q * 8.9, 434u) * (1.0 - smoothstep(0.15, 0.4, fw * 8.9));
  float soft = smoothstep(0.1, 0.6, fw);
  float cov = smoothstep(0.55 - 0.5 * uCloudCover, 1.0 + soft, n * 0.9 + 0.5) * smoothstep(0.02, 0.16, d.y) * 0.8;
  if (cov <= 0.0) return base;
  vec3 pos = vec3(0.0, ATM_RG + 8.0, 0.0);
  vec3 sunT = lightTransmittance(uTransmittance, pos, uSunDir);
  vec3 moonT = lightTransmittance(uTransmittance, pos, uMoonDir);
  float ps = 0.25 + 3.0 * miePhase(dot(d, uSunDir), 0.55);
  float pm = 0.25 + 3.0 * miePhase(dot(d, uMoonDir), 0.55);
  vec3 lit = (uSunIllum * sunT * ps + uMoonIllum * moonT * pm) * 0.09 + skyRadiance(vec3(0.0, 1.0, 0.0)) * 0.9;
  return mix(base, lit, cov * 0.65);
}

/** Flat stand-in for the volumetric layer, used where the raymarch is not run (reflections, env map). */
vec3 flatClouds(vec3 d, vec3 base) {
  if (d.y < 0.008 || uCloudCover <= 0.0) return base;
  float camY = abs(uCamPosF.y);
  float mid = 0.5 * (CLOUD_BASE + CLOUD_TOP);
  if (camY > CLOUD_BASE) return base;
  float t = (mid - camY) / d.y;
  vec3 P = vec3(uCamPosF.x, camY, uCamPosF.z) + d * t;
  float w = cloudWeather(P.xz);
  float a = smoothstep(0.12, 0.6, w) * (1.0 - smoothstep(25000.0, 60000.0, t));
  if (a <= 0.0) return base;
  vec3 pos = vec3(0.0, ATM_RG + mid * 0.001, 0.0);
  vec3 sunT = lightTransmittance(uTransmittance, pos, uSunDir);
  vec3 moonT = lightTransmittance(uTransmittance, pos, uMoonDir);
  float thick = smoothstep(0.3, 0.9, w);
  float ps = 0.18 + 1.4 * miePhase(dot(d, uSunDir), 0.6);
  float pm = 0.18 + 1.4 * miePhase(dot(d, uMoonDir), 0.6);
  vec3 lit = (uSunIllum * sunT * ps + uMoonIllum * moonT * pm) * mix(0.9, 0.35, thick) + skyRadiance(vec3(0.0, 1.0, 0.0)) * 0.8;
  return mix(base, lit, a * 0.9);
}

vec3 skyColor(vec3 d, float pixAngle, vec2 frag, bool withDiscs) {
  vec3 dd = vec3(d.x, max(d.y, 0.0), d.z);
  vec3 col = skyRadiance(dd);
  col += stars(d, pixAngle) * smoothstep(-0.01, 0.06, d.y) * lum3(lightTransmittance(uTransmittance, vec3(0.0, ATM_RG + uCamAltKm, 0.0), dd));
  col += aurora(d, frag, pixAngle);
  if (withDiscs) col += moonDisc(d) + sunDisc(d);
  col = cirrus(d, col);
  if (!withDiscs || uReflectPass > 0.5) col = flatClouds(d, col);
  return col;
}
`;

const SKY_VERT = /* glsl */ `
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
out vec3 vDir;
void main() {
  vec4 v = uInvProj * vec4(position.xy, 1.0, 1.0);
  vDir = (uCamWorld * vec4(v.xyz / v.w, 0.0)).xyz;
#ifdef USE_REVERSED_DEPTH_BUFFER
  gl_Position = vec4(position.xy, 0.0, 1.0);
#else
  gl_Position = vec4(position.xy, 1.0, 1.0);
#endif
}
`;

const SKY_FRAG = /* glsl */ `
in vec3 vDir;
out vec4 fragColor;
void main() {
  vec3 d = normalize(vDir);
  fragColor = vec4(skyColor(d, uPixelAngle, gl_FragCoord.xy, true), 1.0);
}
`;

const ENV_FRAG = /* glsl */ `
in vec2 vUv;
out vec4 fragColor;
void main() {
  float az = (vUv.x - 0.5) * 2.0 * PI;
  float el = (0.5 - vUv.y) * PI;
  vec3 d = vec3(sin(az) * cos(el), sin(el), -cos(az) * cos(el));
  vec3 col;
  if (d.y >= 0.0) {
    col = skyColor(d, 0.02, gl_FragCoord.xy, false);
  } else {
    // Below the horizon: dim ground/sea bounce so the lower hemisphere is not black.
    vec3 hz = skyRadiance(vec3(d.x, 0.02, d.z));
    vec3 g = (uSunColor * max(uSunDir.y, 0.0) + uMoonColor * max(uMoonDir.y, 0.0)) * 0.06 / PI + skyRadiance(vec3(0.0, 1.0, 0.0)) * 0.12;
    col = mix(hz, g, smoothstep(0.0, 0.25, -d.y));
  }
  fragColor = vec4(col, 1.0);
}
`;

export function skyShaderPrefix(): string {
  return ATMOSPHERE_GLSL + SKYVIEW_SAMPLE_GLSL + NOISE_GLSL + GLOBALS_GLSL + CLOUD_COMMON_GLSL + SKY_FUNCS_GLSL;
}

export class Sky {
  readonly mesh: THREE.Mesh;
  readonly env: THREE.WebGLRenderTarget;
  private readonly envPass: FullscreenPass;
  readonly uniforms = {
    uSunDiscRad: { value: new THREE.Vector3() },
    uMoonRad: { value: new THREE.Vector3() },
    uInvProj: { value: new THREE.Matrix4() },
    uCamWorld: { value: new THREE.Matrix4() },
  };

  constructor(type: THREE.TextureDataType, envWidth = 256) {
    const uniforms = { ...globals, ...this.uniforms };
    const mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: SKY_VERT,
      fragmentShader: skyShaderPrefix() + SKY_FRAG,
      uniforms,
      depthWrite: false,
      depthTest: true,
      depthFunc: THREE.LessEqualDepth,
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1000;

    this.env = new THREE.WebGLRenderTarget(envWidth, envWidth / 2, {
      type,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      generateMipmaps: true,
      depthBuffer: false,
    });
    globals.uEnv.value = this.env.texture;
    globals.uEnvMaxLod.value = Math.log2(envWidth / 2);
    const envMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: /* glsl */ `out vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: skyShaderPrefix() + ENV_FRAG,
      uniforms,
    });
    this.envPass = new FullscreenPass(envMat);
  }

  updateCamera(camera: THREE.PerspectiveCamera): void {
    this.uniforms.uInvProj.value.copy(camera.projectionMatrixInverse);
    this.uniforms.uCamWorld.value.copy(camera.matrixWorld);
  }

  renderEnv(renderer: THREE.WebGLRenderer): void {
    this.envPass.render(renderer, this.env);
  }
}
