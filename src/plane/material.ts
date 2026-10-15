// Shared shader for the aircraft: vertex colours + per-vertex gloss/emissive id, lit like the world.
import * as THREE from 'three';
import { ATMOSPHERE_GLSL, SKYVIEW_SAMPLE_GLSL } from '../render/atmosphere.ts';
import { GLOBALS_GLSL, globals } from '../render/globals.ts';
import { NOISE_GLSL } from '../world/noise.ts';
import { CLOUD_COMMON_GLSL } from '../render/clouds.ts';
import { OUTPUT_GLSL } from '../render/post.ts';

const VERT = /* glsl */ `
in vec3 aColor;
in vec2 aMat;
out vec3 vWorld;
out vec3 vNormal;
out vec3 vColor;
out vec2 vMat;
#include <logdepthbuf_pars_vertex>
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vColor = aColor;
  vMat = aMat;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;

const FRAG = /* glsl */ `
in vec3 vWorld;
in vec3 vNormal;
in vec3 vColor;
in vec2 vMat;
uniform vec4 uNav;
uniform float uLampOn;
uniform float uInterior;
out vec4 fragColor;
#include <logdepthbuf_pars_fragment>
void main() {
  #include <logdepthbuf_fragment>
  vec3 N = normalize(vNormal);
  float gloss = vMat.x;
  // seen from inside the cabin: windows are holes, other hull panels read as the same painted sheet
  float inside = 0.0;
  if (!gl_FrontFacing) {
    if (gloss > 0.95) discard;
    N = -N;
    inside = 1.0;
  }
  vec3 V = normalize(uCamPosF - vWorld);
  int em = int(vMat.y + 0.5);
  float tsh = terrainShadow(vWorld) * mix(planeShadow(vWorld + N * 0.08), 1.0, uInterior);
  float shSun = mix(1.0, tsh, uKeyIsSun) * cloudShadowAt(vWorld, uSunDir);
  float shMoon = mix(tsh, 1.0, uKeyIsSun) * cloudShadowAt(vWorld, uMoonDir);
  // the cabin interior is mostly shaded by the airframe
  float interior = max(uInterior, inside);
  float occl = mix(1.0, 0.35, interior);
  vec3 direct = (uSunColor * max(dot(N, uSunDir), 0.0) * shSun + uMoonColor * max(dot(N, uMoonDir), 0.0) * shMoon) / PI * occl;
  vec3 amb = envDiffuse(N) * (0.6 + 0.4 * N.y) * mix(1.0, 0.5, interior);
  // hull panels seen from the cabin take the interior trim colour
  vec3 base = mix(vColor, vec3(0.06, 0.065, 0.06), inside * 0.85);
  vec3 col = base * (direct + amb);
  float NdV = max(dot(N, V), 0.0);
  float F = 0.04 + 0.96 * pow(1.0 - NdV, 5.0);
  vec3 R = reflect(-V, N);
  col += envSpecular(R, 1.0 - gloss) * F * gloss * occl;
  vec3 H = normalize(uSunDir + V);
  float sp = pow(max(dot(N, H), 0.0), mix(10.0, 600.0, gloss * gloss)) * gloss * mix(0.2, 6.0, gloss * gloss);
  col += uSunColor * sp * shSun * max(dot(N, uSunDir), 0.0) * 0.25;
  // lights: brighter (relative to the scene) at night so they bloom
  float li = 5.0 * max(1.0, uExposure * 0.0025);
  if (em == 1) col += vec3(1.0, 0.06, 0.03) * li * uNav.x;
  else if (em == 2) col += vec3(0.05, 1.0, 0.25) * li * uNav.y;
  else if (em == 3) col += vec3(1.0, 0.95, 0.85) * li * uNav.z;
  else if (em == 4) col += vec3(1.0) * li * 6.0 * uNav.w;
  else if (em == 5) col += vec3(1.0, 0.93, 0.8) * li * 8.0 * uLampOn;
  fragColor = finalOutput(applyFog(col, uCamPosF, vWorld));
}
`;

export function planeShaderMaterial(ldr: boolean, extra: Record<string, THREE.IUniform> = {}): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: VERT,
    fragmentShader: ATMOSPHERE_GLSL + SKYVIEW_SAMPLE_GLSL + NOISE_GLSL + GLOBALS_GLSL + CLOUD_COMMON_GLSL + OUTPUT_GLSL + FRAG,
    uniforms: {
      ...globals,
      uNav: { value: new THREE.Vector4(1, 1, 1, 0) },
      uLampOn: { value: 0 },
      uInterior: { value: 0 },
      ...extra,
    },
    defines: ldr ? { LDR_OUTPUT: '' } : {},
  });
}

/** Renames color → aColor for the custom shader. */
export function forShader(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const c = g.getAttribute('color');
  if (c) {
    g.setAttribute('aColor', c);
    g.deleteAttribute('color');
  }
  return g;
}
