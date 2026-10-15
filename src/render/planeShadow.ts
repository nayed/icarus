// Shadow of the aircraft on the world: the aircraft is rendered from the key light into a small
// orthographic map of linear depth; terrain, water and trees sample it (planeShadow() in GLOBALS_GLSL).
import * as THREE from 'three';
import { globals } from './globals.ts';

export const LAYER_SHADOW = 2;

export class PlaneShadow {
  readonly target: THREE.WebGLRenderTarget;
  readonly camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.5, 200);
  private readonly material: THREE.ShaderMaterial;
  private readonly scene = new THREE.Scene();
  private readonly lightDir = new THREE.Vector3();
  private readonly center = new THREE.Vector3();

  constructor(size = 512) {
    this.target = new THREE.WebGLRenderTarget(size, size, {
      type: THREE.FloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
    });
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { uOrigin: { value: new THREE.Vector3() }, uDir: { value: new THREE.Vector3() } },
      vertexShader: /* glsl */ `out vec3 vW;
#include <logdepthbuf_pars_vertex>
        void main() { vW = (modelMatrix * vec4(position, 1.0)).xyz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        #include <icarus_logdepth_vertex>
        }`,
      fragmentShader: /* glsl */ `in vec3 vW; uniform vec3 uOrigin; uniform vec3 uDir; out vec4 fragColor;
#include <logdepthbuf_pars_fragment>
        void main() {
          #include <logdepthbuf_fragment>
          fragColor = vec4(dot(vW - uOrigin, uDir), 0.0, 0.0, 1.0);
        }`,
      side: THREE.DoubleSide,
    });
    this.scene.overrideMaterial = this.material;
    this.camera.layers.set(LAYER_SHADOW);
    globals.uPlaneShadowMap.value = this.target.texture;
  }

  /** Renders the shadow caster (`root`) from light direction `L` (pointing towards the light). */
  render(renderer: THREE.WebGLRenderer, root: THREE.Object3D, L: THREE.Vector3, enabled: boolean): void {
    globals.uPlaneShadowOn.value = enabled && L.y > 0.02 ? 1 : 0;
    if (!globals.uPlaneShadowOn.value) return;
    root.getWorldPosition(this.center);
    this.lightDir.copy(L).normalize();
    const cam = this.camera;
    cam.position.copy(this.center).addScaledVector(this.lightDir, 60);
    cam.up.set(0, 1, 0);
    if (Math.abs(this.lightDir.y) > 0.98) cam.up.set(0, 0, -1);
    cam.lookAt(this.center);
    cam.updateMatrixWorld();
    cam.updateProjectionMatrix();
    // depth increases away from the light
    const u = this.material.uniforms;
    u.uOrigin.value.copy(this.center);
    u.uDir.value.copy(this.lightDir).negate();
    const parent = root.parent;
    this.scene.add(root);
    const prevClear = new THREE.Color();
    renderer.getClearColor(prevClear);
    const prevAlpha = renderer.getClearAlpha();
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(new THREE.Color(1e6, 0, 0), 1);
    renderer.clear(true, true, false);
    renderer.render(this.scene, cam);
    renderer.setClearColor(prevClear, prevAlpha);
    parent?.add(root);
    // (P - centre) → (u, v, depth) matrix; centre-relative so fp32 stays precise far from the origin
    const vp = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    const e = vp.elements;
    const d = u.uDir.value;
    globals.uPlaneShadowCenter.value.copy(this.center);
    globals.uPlaneShadowMat.value.set(
      0.5 * e[0], 0.5 * e[4], 0.5 * e[8], 0.5,
      0.5 * e[1], 0.5 * e[5], 0.5 * e[9], 0.5,
      d.x, d.y, d.z, 0,
      0, 0, 0, 1,
    );
  }
}
