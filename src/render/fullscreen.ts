import * as THREE from 'three';

/** Fullscreen triangle for post/LUT passes. */
export class FullscreenPass {
  readonly mesh: THREE.Mesh;
  private readonly scene = new THREE.Scene();
  private static camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private static geometry = (() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    return g;
  })();

  constructor(public material: THREE.ShaderMaterial) {
    material.depthTest = false;
    material.depthWrite = false;
    this.mesh = new THREE.Mesh(FullscreenPass.geometry, material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  render(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget | null): void {
    renderer.setRenderTarget(target);
    renderer.render(this.scene, FullscreenPass.camera);
  }
}

export const FULLSCREEN_VERT = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export function passMaterial(fragmentShader: string, uniforms: Record<string, THREE.IUniform>, defines: Record<string, string | number> = {}): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: FULLSCREEN_VERT,
    fragmentShader,
    uniforms,
    defines,
    depthTest: false,
    depthWrite: false,
  });
}
