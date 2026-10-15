// Uniforms shared by every world material. Updated once per frame by the renderer.
import * as THREE from 'three';

export const globals = {
  uTime: { value: 0 },
  uSunDir: { value: new THREE.Vector3(0, 1, 0) },
  uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
  /** pre-exposed irradiance from the sun/moon at the camera altitude (after atmosphere) */
  uSunColor: { value: new THREE.Vector3() },
  uMoonColor: { value: new THREE.Vector3() },
  /** pre-exposed illuminance at the top of the atmosphere (for clouds/cirrus) */
  uSunIllum: { value: new THREE.Vector3() },
  uMoonIllum: { value: new THREE.Vector3() },
  uExposure: { value: 1 },
  uSkyView: { value: null as THREE.Texture | null },
  uTransmittance: { value: null as THREE.Texture | null },
  uEnv: { value: null as THREE.Texture | null },
  uEnvMaxLod: { value: 7 },
  uCamPosF: { value: new THREE.Vector3() },
  uCamAltKm: { value: 0 },
  uViewRot: { value: new THREE.Matrix4() },
  /** radians per pixel vertically */
  uPixelAngle: { value: 0.001 },
  /** x: haze (Mie) multiplier, y: mist density per km, z: mist scale height km */
  uFog: { value: new THREE.Vector3(1, 0.4, 0.09) },
  uCloudCover: { value: 0.45 },
  uWind: { value: new THREE.Vector3(4, 0, 2) },
  /** cloud/cirrus drift offset in metres (integrated wind) */
  uCloudOffset: { value: new THREE.Vector2() },
  uAurora: { value: 0 },
  uStarRot: { value: new THREE.Matrix3() },
  uStarBright: { value: 0 },
  /** landing light: position (w = intensity) and direction (w = cos cone) */
  uLampPos: { value: new THREE.Vector4(0, 0, 0, 0) },
  uLampDir: { value: new THREE.Vector4(0, 0, -1, 0.9) },
  /** terrain shadow map: texture of soft visibility around (origin.xy) with extent origin.z */
  uShadowMap: { value: null as THREE.Texture | null },
  uShadowOrigin: { value: new THREE.Vector4(0, 0, 1, 0) },
  /** 1 when the sun is the shadow-casting key light, 0 for the moon */
  uKeyIsSun: { value: 1 },
  /** artistic fill: lifts sky light on surfaces in twilight so the land stays readable */
  uAmbientBoost: { value: 1 },
  /** 1 while rendering the planar water reflection (underwater geometry is discarded) */
  uReflectPass: { value: 0 },
  /** aircraft shadow map (see PlaneShadow) */
  uPlaneShadowMap: { value: null as THREE.Texture | null },
  uPlaneShadowMat: { value: new THREE.Matrix4() },
  uPlaneShadowCenter: { value: new THREE.Vector3() },
  uPlaneShadowOn: { value: 0 },
};

export type Globals = typeof globals;

/** GLSL declarations matching `globals`, plus shared helpers. Needs ATMOSPHERE_GLSL and SKYVIEW_SAMPLE_GLSL. */
export const GLOBALS_GLSL = /* glsl */ `
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform vec3 uSunColor;
uniform vec3 uMoonColor;
uniform vec3 uSunIllum;
uniform vec3 uMoonIllum;
uniform float uExposure;
uniform sampler2D uSkyView;
uniform sampler2D uTransmittance;
uniform sampler2D uEnv;
uniform float uEnvMaxLod;
uniform vec3 uCamPosF;
uniform float uCamAltKm;
uniform mat4 uViewRot;
uniform float uPixelAngle;
uniform vec3 uFog;
uniform float uCloudCover;
uniform vec3 uWind;
uniform vec2 uCloudOffset;
uniform float uAurora;
uniform mat3 uStarRot;
uniform float uStarBright;
uniform vec4 uLampPos;
uniform vec4 uLampDir;
uniform sampler2D uShadowMap;
uniform vec4 uShadowOrigin;
uniform float uKeyIsSun;
uniform float uAmbientBoost;
uniform float uReflectPass;
uniform sampler2D uPlaneShadowMap;
uniform mat4 uPlaneShadowMat;
uniform vec3 uPlaneShadowCenter;
uniform float uPlaneShadowOn;

float saturate(float x) { return clamp(x, 0.0, 1.0); }
vec3 saturate(vec3 x) { return clamp(x, 0.0, 1.0); }
float lum3(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

vec3 skyRadiance(vec3 d) { return texture(uSkyView, skyViewUv(d)).rgb; }

vec2 equirectUv(vec3 d) {
  return vec2(atan(d.x, -d.z) / (2.0 * PI) + 0.5, acos(clamp(d.y, -1.0, 1.0)) / PI);
}
/** Pre-exposed sky irradiance / PI around direction n (blurred environment). */
vec3 envDiffuse(vec3 n) {
  return textureLod(uEnv, equirectUv(n), uEnvMaxLod - 1.0).rgb * uAmbientBoost;
}
vec3 envSpecular(vec3 r, float rough) {
  return textureLod(uEnv, equirectUv(r), rough * (uEnvMaxLod - 1.0)).rgb;
}

float expAvg(float h0, float h1, float H) {
  float dh = h1 - h0;
  float e0 = exp(-max(h0, -0.5) / H);
  if (abs(dh) < 1e-4) return e0;
  return H * (e0 - exp(-max(h1, -0.5) / H)) / dh;
}
/** Aerial perspective: transmittance along camera → P (per channel). */
vec3 fogTransmittance(vec3 cam, vec3 P) {
  float dist = length(P - cam) * 0.001;
  float h0 = cam.y * 0.001;
  float h1 = P.y * 0.001;
  vec3 tau = RAY_SCAT * (dist * expAvg(h0, h1, RAY_H))
    + vec3(MIE_EXT * uFog.x * dist * expAvg(h0, h1, MIE_H))
    + vec3(uFog.y * dist * expAvg(h0, h1, uFog.z));
  return exp(-tau);
}
vec3 applyFog(vec3 col, vec3 cam, vec3 P) {
  vec3 d = normalize(P - cam);
  vec3 T = fogTransmittance(cam, P);
  // looking down, the in-scattered light is closer to the sky mirrored upwards than to the bright horizon
  vec3 sky = skyRadiance(vec3(d.x, max(abs(d.y), 0.015), d.z));
  return col * T + sky * (1.0 - T);
}

/** Soft terrain shadow from the shadow map (1 = lit). */
float terrainShadow(vec3 P) {
  if (uShadowOrigin.z <= 1.0) return 1.0;
  vec2 uv = (P.xz - uShadowOrigin.xy) / uShadowOrigin.z + 0.5;
  vec2 e = min(uv, 1.0 - uv);
  float fade = smoothstep(0.0, 0.06, min(e.x, e.y));
  if (fade <= 0.0) return 1.0;
  return mix(1.0, texture(uShadowMap, uv).r, fade);
}

/** Shadow cast by the aircraft (1 = lit). */
float planeShadow(vec3 P) {
  if (uPlaneShadowOn < 0.5) return 1.0;
  vec3 q = (uPlaneShadowMat * vec4(P - uPlaneShadowCenter, 1.0)).xyz;
  if (q.x <= 0.0 || q.y <= 0.0 || q.x >= 1.0 || q.y >= 1.0) return 1.0;
  vec2 ts = 1.0 / vec2(textureSize(uPlaneShadowMap, 0));
  float s = 0.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    float d = texture(uPlaneShadowMap, q.xy + vec2(float(i), float(j)) * ts * 1.5).r;
    s += q.z > d + 0.12 ? 0.0 : 1.0;
  }
  return mix(0.15, 1.0, s / 9.0);
}

/** Landing light contribution (pre-exposed irradiance) at P with normal N. */
vec3 lampLight(vec3 P, vec3 N) {
  if (uLampPos.w <= 0.0) return vec3(0.0);
  vec3 L = uLampPos.xyz - P;
  float d2 = max(dot(L, L), 1.0);
  L *= inversesqrt(d2);
  float cone = smoothstep(uLampDir.w, uLampDir.w + 0.04, dot(-L, uLampDir.xyz));
  return vec3(1.0, 0.93, 0.82) * uLampPos.w * cone * max(dot(N, L), 0.0) / d2;
}
`;
