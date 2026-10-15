// HDR scene target → bloom mip chain → composite (ACES, vignette, grain, sRGB) to the canvas.
// In LDR mode (no float targets) materials tone-map themselves and the composite only adds grain/vignette.
import * as THREE from 'three';
import { FullscreenPass, passMaterial } from './fullscreen.ts';

export const OUTPUT_GLSL = /* glsl */ `
vec3 acesFitted(vec3 c) {
  const mat3 ACES_IN = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
  const mat3 ACES_OUT = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
  c = ACES_IN * (c / 0.6);
  vec3 a = c * (c + 0.0245786) - 0.000090537;
  vec3 b = c * (0.983729 * c + 0.4329510) + 0.238081;
  return clamp(ACES_OUT * (a / b), 0.0, 1.0);
}
vec3 linearToSrgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
vec4 finalOutput(vec3 c) {
#ifdef LDR_OUTPUT
  return vec4(linearToSrgb(acesFitted(max(c, 0.0))), 1.0);
#else
  return vec4(min(c, vec3(60000.0)), 1.0);
#endif
}
`;

const DOWN_FRAG = /* glsl */ `
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uKaris;
in vec2 vUv;
out vec4 fragColor;
vec3 s(vec2 o) { return texture(uSrc, vUv + o * uTexel).rgb; }
float kw(vec3 c) { return 1.0 / (1.0 + dot(c, vec3(0.2126, 0.7152, 0.0722))); }
void main() {
  vec3 a = s(vec2(-2.0, 2.0)), b = s(vec2(0.0, 2.0)), c = s(vec2(2.0, 2.0));
  vec3 d = s(vec2(-2.0, 0.0)), e = s(vec2(0.0, 0.0)), f = s(vec2(2.0, 0.0));
  vec3 g = s(vec2(-2.0, -2.0)), h = s(vec2(0.0, -2.0)), i = s(vec2(2.0, -2.0));
  vec3 j = s(vec2(-1.0, 1.0)), k = s(vec2(1.0, 1.0)), l = s(vec2(-1.0, -1.0)), m = s(vec2(1.0, -1.0));
  vec3 col;
  if (uKaris > 0.5) {
    vec3 g0 = (a + b + d + e) * 0.25, g1 = (b + c + e + f) * 0.25, g2 = (d + e + g + h) * 0.25, g3 = (e + f + h + i) * 0.25, g4 = (j + k + l + m) * 0.25;
    float w0 = kw(g0), w1 = kw(g1), w2 = kw(g2), w3 = kw(g3), w4 = kw(g4);
    col = (g0 * w0 * 0.125 + g1 * w1 * 0.125 + g2 * w2 * 0.125 + g3 * w3 * 0.125 + g4 * w4 * 0.5) /
          (w0 * 0.125 + w1 * 0.125 + w2 * 0.125 + w3 * 0.125 + w4 * 0.5);
  } else {
    col = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  }
  fragColor = vec4(max(col, 0.0), 1.0);
}
`;

const UP_FRAG = /* glsl */ `
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uWeight;
in vec2 vUv;
out vec4 fragColor;
vec3 s(vec2 o) { return texture(uSrc, vUv + o * uTexel).rgb; }
void main() {
  vec3 col = s(vec2(0.0)) * 4.0
    + (s(vec2(-1.0, 0.0)) + s(vec2(1.0, 0.0)) + s(vec2(0.0, -1.0)) + s(vec2(0.0, 1.0))) * 2.0
    + s(vec2(-1.0, -1.0)) + s(vec2(1.0, -1.0)) + s(vec2(-1.0, 1.0)) + s(vec2(1.0, 1.0));
  fragColor = vec4(col / 16.0 * uWeight, 1.0);
}
`;

const COMPOSITE_FRAG = /* glsl */ `
${OUTPUT_GLSL}
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform float uBloomStrength;
uniform float uVignette;
uniform float uGrain;
uniform float uFrame;
uniform vec2 uUvScale;
uniform float uNight;
in vec2 vUv;
out vec4 fragColor;
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
void main() {
  vec2 uv = vUv;
  vec3 col = texture(uScene, uv).rgb;
#ifdef LDR_OUTPUT
  vec3 disp = col;
#else
  vec3 bloom = texture(uBloom, uv).rgb * BLOOM_NORM;
  col = mix(col, bloom, uBloomStrength);
  // scotopic vision: low light loses colour and shifts blue
  float L = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(col, L * vec3(0.62, 0.78, 1.15), uNight * 0.55);
  vec3 disp = linearToSrgb(acesFitted(col));
#endif
  vec2 q = vUv - 0.5;
  q.x *= 1.15;
  float vig = 1.0 - uVignette * smoothstep(0.25, 0.85, length(q) * 1.25);
  disp *= vig;
  float n = hash12(gl_FragCoord.xy + fract(uFrame * 0.618034) * 1000.0) + hash12(gl_FragCoord.xy * 1.37 + fract(uFrame * 0.414) * 977.0) - 1.0;
  float lum = dot(disp, vec3(0.299, 0.587, 0.114));
  disp += n * (uGrain * (1.0 - 0.6 * lum) + 0.5 / 255.0);
  fragColor = vec4(disp, 1.0);
}
`;

export interface PostOptions {
  hdr: boolean;
  bloomLevels: number;
  samples: number;
}

export class Post {
  readonly scene: THREE.WebGLRenderTarget;
  private readonly mips: THREE.WebGLRenderTarget[] = [];
  private readonly down: FullscreenPass;
  private readonly up: FullscreenPass;
  private readonly composite: FullscreenPass;
  readonly composeUniforms = {
    uScene: { value: null as THREE.Texture | null },
    uBloom: { value: null as THREE.Texture | null },
    uBloomStrength: { value: 0.045 },
    uVignette: { value: 0.32 },
    uGrain: { value: 0.022 },
    uFrame: { value: 0 },
    uUvScale: { value: new THREE.Vector2(1, 1) },
    uNight: { value: 0 },
  };
  private readonly downU = { uSrc: { value: null as THREE.Texture | null }, uTexel: { value: new THREE.Vector2() }, uKaris: { value: 0 } };
  private readonly upU = { uSrc: { value: null as THREE.Texture | null }, uTexel: { value: new THREE.Vector2() }, uWeight: { value: 1 } };
  width = 0;
  height = 0;

  constructor(readonly opts: PostOptions) {
    const type = opts.hdr ? THREE.HalfFloatType : THREE.UnsignedByteType;
    this.scene = new THREE.WebGLRenderTarget(1, 1, {
      type,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      samples: opts.samples,
    });
    this.scene.depthTexture = new THREE.DepthTexture(1, 1, THREE.FloatType);
    this.scene.depthTexture.minFilter = THREE.NearestFilter;
    this.scene.depthTexture.magFilter = THREE.NearestFilter;
    if (opts.hdr) {
      for (let i = 0; i < opts.bloomLevels; i++) {
        this.mips.push(
          new THREE.WebGLRenderTarget(1, 1, {
            type,
            format: THREE.RGBAFormat,
            minFilter: THREE.LinearFilter,
            magFilter: THREE.LinearFilter,
            depthBuffer: false,
          }),
        );
      }
    }
    const defines: Record<string, string> = opts.hdr
      ? { BLOOM_NORM: (1 / Math.max(1, opts.bloomLevels)).toFixed(6) }
      : { LDR_OUTPUT: '', BLOOM_NORM: '1.0' };
    this.down = new FullscreenPass(passMaterial(DOWN_FRAG, this.downU));
    const upMat = passMaterial(UP_FRAG, this.upU);
    upMat.blending = THREE.AdditiveBlending;
    upMat.transparent = true;
    this.up = new FullscreenPass(upMat);
    this.composite = new FullscreenPass(passMaterial(COMPOSITE_FRAG, this.composeUniforms, defines));
    this.composeUniforms.uScene.value = this.scene.texture;
    this.composeUniforms.uBloom.value = this.mips[0]?.texture ?? null;
  }

  dispose(): void {
    this.scene.depthTexture?.dispose();
    this.scene.dispose();
    for (const m of this.mips) m.dispose();
  }

  setSize(w: number, h: number): void {
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.scene.setSize(w, h);
    let mw = w;
    let mh = h;
    for (const m of this.mips) {
      mw = Math.max(1, mw >> 1);
      mh = Math.max(1, mh >> 1);
      m.setSize(mw, mh);
    }
  }

  /** Bloom from the scene target, then composite to the canvas (null target). */
  finish(renderer: THREE.WebGLRenderer, frame: number, source: THREE.Texture = this.scene.texture): void {
    const prevAuto = renderer.autoClear;
    this.composeUniforms.uScene.value = source;
    if (this.mips.length) {
      let src: THREE.Texture = source;
      let sw = this.width;
      let sh = this.height;
      this.mips.forEach((m, i) => {
        this.downU.uSrc.value = src;
        this.downU.uTexel.value.set(1 / sw, 1 / sh);
        this.downU.uKaris.value = i === 0 ? 1 : 0;
        this.down.render(renderer, m);
        src = m.texture;
        sw = m.width;
        sh = m.height;
      });
      renderer.autoClear = false;
      for (let i = this.mips.length - 1; i > 0; i--) {
        const s = this.mips[i];
        this.upU.uSrc.value = s.texture;
        this.upU.uTexel.value.set(1 / s.width, 1 / s.height);
        this.upU.uWeight.value = 1;
        this.up.render(renderer, this.mips[i - 1]);
      }
      renderer.autoClear = prevAuto;
    }
    this.composeUniforms.uFrame.value = frame;
    this.composite.render(renderer, null);
  }
}
