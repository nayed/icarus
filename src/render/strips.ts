// Airstrip furniture: edge and threshold lights (points that bloom at night), windsocks and a cabin.
import * as THREE from 'three';
import { STRIPS, headingDir } from '../world/params.ts';
import { paint, merge, box, MAT } from '../plane/geometry.ts';
import { planeShaderMaterial, forShader } from '../plane/material.ts';
import { globals } from './globals.ts';
import { terrainHeight } from '../world/terrain.ts';

const LIGHT_VERT = /* glsl */ `
in vec3 aColor;
uniform vec3 uCamPosF;
uniform mat4 uViewRot;
uniform float uPixelAngle;
out vec3 vColor;
out float vFade;
#include <logdepthbuf_pars_vertex>
void main() {
  vec3 rel = position - uCamPosF;
  float d = length(rel);
  vColor = aColor;
  vFade = 1.0 - smoothstep(6000.0, 12000.0, d);
  gl_Position = projectionMatrix * (uViewRot * vec4(rel, 1.0));
  // ~0.35 m lamp, never smaller than a few pixels so it stays visible far away
  gl_PointSize = clamp(0.35 / max(d * uPixelAngle, 1e-4), 2.5, 14.0);
  #include <logdepthbuf_vertex>
}
`;
const LIGHT_FRAG = /* glsl */ `
in vec3 vColor;
in float vFade;
uniform float uIntensity;
out vec4 fragColor;
#include <logdepthbuf_pars_fragment>
void main() {
  #include <logdepthbuf_fragment>
  vec2 c = gl_PointCoord - 0.5;
  float r = dot(c, c) * 4.0;
  float a = exp(-r * 3.0);
  fragColor = vec4(vColor * a * uIntensity * vFade, 0.0);
}
`;

export class Strips {
  readonly group = new THREE.Group();
  private readonly lightMat: THREE.ShaderMaterial;
  private readonly socks: THREE.Group[] = [];
  readonly material: THREE.ShaderMaterial;

  constructor(ldr: boolean) {
    this.material = planeShaderMaterial(ldr);
    const pos: number[] = [];
    const col: number[] = [];
    const add = (x: number, z: number, c: [number, number, number]) => {
      pos.push(x, terrainHeight(x, z) + 0.35, z);
      col.push(...c);
    };
    const statics: THREE.BufferGeometry[] = [];
    for (const s of STRIPS) {
      const d = headingDir(s.heading);
      const n = [-d[1], d[0]];
      const at = (along: number, across: number): [number, number] => [s.center[0] + d[0] * along + n[0] * across, s.center[1] + d[1] * along + n[1] * across];
      const W = s.halfWidth + 2;
      const step = s.id === 'coastal' ? 60 : 50;
      for (let a = -s.halfLength; a <= s.halfLength + 0.1; a += step) {
        for (const side of [-1, 1]) add(...at(a, side * W), [1.0, 0.85, 0.55]);
      }
      // threshold bars: green facing the approach, red at the far end (both directions)
      for (const end of [-1, 1]) {
        for (let k = -3; k <= 3; k++) {
          add(...at(end * (s.halfLength + 3), (k / 3) * W), [0.15, 1.0, 0.35]);
          add(...at(end * (s.halfLength + 6), (k / 3) * W), [1.0, 0.12, 0.08]);
        }
      }
      // day markers: orange/white cones along the gravel strip edges
      if (s.id === 'mountain') {
        for (let a = -s.halfLength; a <= s.halfLength + 0.1; a += 70) {
          for (const side of [-1, 1]) {
            const [x, z] = at(a, side * (s.halfWidth + 3));
            const cone = new THREE.ConeGeometry(0.35, 0.8, 8).translate(x, terrainHeight(x, z) + 0.4, z);
            statics.push(paint(cone, (_x, y) => ({ c: Math.floor((y - terrainHeight(x, z)) / 0.27) % 2 ? '#f4f1ea' : '#f26a1b', m: MAT.paint })));
          }
        }
      }
      // windsock near the approach end, off to the left of the runway
      const [wx, wz] = at(-s.halfLength + 80, -(s.halfWidth + 22));
      const wy = terrainHeight(wx, wz);
      statics.push(paint(new THREE.CylinderGeometry(0.05, 0.07, 6, 6).translate(wx, wy + 3, wz), '#d9d9d9', MAT.metal));
      const sock = new THREE.Group();
      sock.position.set(wx, wy + 5.8, wz);
      const cone = new THREE.CylinderGeometry(0.42, 0.18, 3.2, 12, 5, true).rotateX(Math.PI / 2).translate(0, 0, 1.6);
      const sockMesh = new THREE.Mesh(
        forShader(paint(cone, (_x, _y, z) => ({ c: Math.floor(z / 0.64) % 2 ? '#f4f1ea' : '#f26a1b', m: MAT.paint }))),
        this.material,
      );
      sockMesh.material = this.material;
      (sockMesh.material as THREE.Material).side = THREE.DoubleSide;
      sock.add(sockMesh);
      this.socks.push(sock);
      this.group.add(sock);
      // a cabin with a warm window by the coastal strip
      if (s.id === 'coastal') {
        const [cx, cz] = at(-s.halfLength + 140, s.halfWidth + 45);
        const cy = terrainHeight(cx, cz);
        const yaw = Math.atan2(d[0], d[1]);
        const house: THREE.BufferGeometry[] = [
          paint(box(6, 3.2, 4.5, 0, 1.6, 0), '#7a2b22', MAT.matte),
          paint(new THREE.CylinderGeometry(0.01, 3.7, 1.8, 4, 1).rotateY(Math.PI / 4).scale(1.15, 1, 0.86).translate(0, 4.1, 0), '#1e1f22', MAT.matte),
          paint(box(0.05, 0.9, 1.1, 3.02, 1.7, 0.8), '#ffffff', [0.5, 3]),
          paint(box(0.05, 2.0, 0.95, 3.02, 1.0, -1.0), '#3b2a20', MAT.matte),
          paint(box(5, 0.1, 3.4, -0.5, 0.05, 0), '#4b4b48', MAT.matte),
        ];
        for (const h of house) {
          h.rotateY(yaw);
          h.translate(cx, cy, cz);
        }
        statics.push(...house);
        // fuel drums
        for (let k = 0; k < 3; k++) statics.push(paint(new THREE.CylinderGeometry(0.3, 0.3, 0.9, 10).translate(cx + 4 + k * 0.7, cy + 0.45, cz + 3), '#9a3b1c', MAT.paint));
      }
    }
    if (statics.length) {
      const m = new THREE.Mesh(forShader(merge(statics)), this.material);
      m.frustumCulled = false;
      m.layers.enable(1);
      this.group.add(m);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aColor', new THREE.Float32BufferAttribute(col, 3));
    this.lightMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: LIGHT_VERT,
      fragmentShader: LIGHT_FRAG,
      uniforms: { uCamPosF: globals.uCamPosF, uViewRot: globals.uViewRot, uPixelAngle: globals.uPixelAngle, uIntensity: { value: 0 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const pts = new THREE.Points(g, this.lightMat);
    pts.frustumCulled = false;
    pts.renderOrder = 700;
    pts.layers.enable(1);
    this.group.add(pts);
  }

  /** wind: air movement vector (m/s); exposure for light intensity. */
  update(wind: THREE.Vector3, exposure: number, time: number, nightFactor: number): void {
    const speed = Math.hypot(wind.x, wind.z);
    for (const s of this.socks) {
      const yaw = Math.atan2(wind.x, wind.z);
      s.rotation.set(0, 0, 0);
      s.rotation.order = 'YXZ';
      s.rotation.y = yaw + Math.sin(time * 1.7 + s.position.x) * 0.06 * Math.min(speed, 6);
      // a limp sock hangs down; it fills out by ~8 m/s
      s.rotation.x = (1 - Math.min(speed / 8, 1)) * 1.2 + Math.sin(time * 2.3) * 0.03;
    }
    this.lightMat.uniforms.uIntensity.value = Math.max(0.6, exposure * 0.004) * (0.15 + 0.85 * nightFactor) * 4;
  }
}
