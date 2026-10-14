import * as THREE from 'three';

// Stage 0 probe: confirm WebGL2 + extensions in the test browser.
const canvas = document.getElementById('scene') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, reversedDepthBuffer: true });
renderer.setSize(window.innerWidth, window.innerHeight, false);
const gl = renderer.getContext() as WebGL2RenderingContext;
const exts = gl.getSupportedExtensions() ?? [];
const info = {
  webgl2: gl instanceof WebGL2RenderingContext,
  renderer: (() => { const e = gl.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); })(),
  floatColor: exts.includes('EXT_color_buffer_float'),
  halfFloatColor: exts.includes('EXT_color_buffer_half_float'),
  floatLinear: exts.includes('OES_texture_float_linear'),
  clipControl: exts.includes('EXT_clip_control'),
  reversed: renderer.capabilities.reversedDepthBuffer,
  maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE),
};
console.log('[probe]', JSON.stringify(info));
(window as unknown as { __probe: unknown }).__probe = info;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x203040);
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(0, 1, 3);
const mesh = new THREE.Mesh(new THREE.TorusKnotGeometry(0.6, 0.2, 128, 16), new THREE.MeshNormalMaterial());
scene.add(mesh);
renderer.setAnimationLoop((t) => {
  mesh.rotation.y = t * 0.001;
  renderer.render(scene, camera);
});
