// The map image: a north-up shaded relief of the world around the fjord, drawn by the HUD's moving
// map and the pause screen's chart. Baked on the GPU from the same terrainHeight() the world is
// drawn with, a slice of rows per frame, then read back without stalling the pipeline and kept as an
// ImageBitmap. When the aircraft nears an edge, a new map is baked around it.
import * as THREE from 'three';
import { FullscreenPass, passMaterial } from './fullscreen.ts';
import { worldGlsl } from '../world/params.ts';
import { NOISE_GLSL } from '../world/noise.ts';
import { terrainGlsl } from '../world/terrain.ts';
import { stripClearingGlsl } from '../world/forest.ts';

/** texels per side */
export const MAP_SIZE = 2048;
/** metres per texel */
export const MAP_TEXEL = 24;
/** metres per side (49 km) */
export const MAP_EXTENT = MAP_SIZE * MAP_TEXEL;
/** centre of the first map: the fjords, the coast and every start point */
export const MAP_HOME: [number, number] = [9000, -500];
/** a new map is baked around the aircraft when it comes this close to an edge (m) */
const MARGIN = 6000;

/** West and north edges of a map centred on (x, z), snapped to the texel lattice. */
export function mapRegionAround(x: number, z: number): { x0: number; z0: number } {
  return {
    x0: Math.round((x - MAP_EXTENT / 2) / MAP_TEXEL) * MAP_TEXEL,
    z0: Math.round((z - MAP_EXTENT / 2) / MAP_TEXEL) * MAP_TEXEL,
  };
}

/** True when (x, z) lies on the map with west/north edges (x0, z0), at least `margin` inside it. */
export function mapCovers(x0: number, z0: number, x: number, z: number, margin = MARGIN): boolean {
  return x >= x0 + margin && x <= x0 + MAP_EXTENT - margin && z >= z0 + margin && z <= z0 + MAP_EXTENT - margin;
}

// heights go from the first pass to the second packed into 24 bits of an RGBA8 texel, so the map
// also works on the LDR path (no float render targets)
const H_MIN = -1000;
const H_RANGE = 4000;

const HEIGHT_FRAG = () => /* glsl */ `
${worldGlsl()}
${NOISE_GLSL}
${terrainGlsl()}
uniform vec3 uMap; // west edge, north edge, metres per texel
out vec4 fragColor;
void main() {
  // row 0 is the north edge: read back top to bottom, the rows come out as an image, north up
  vec2 p = uMap.xy + (floor(gl_FragCoord.xy) + 0.5) * uMap.z;
  float v = floor(clamp((terrainHeight(p, 7) - (${H_MIN.toFixed(1)})) / ${H_RANGE.toFixed(1)}, 0.0, 1.0) * 16777215.0);
  float r = floor(v / 65536.0);
  float g = floor((v - r * 65536.0) / 256.0);
  fragColor = vec4(r, g, v - r * 65536.0 - g * 256.0, 255.0) / 255.0;
}
`;

const COLOUR_FRAG = () => /* glsl */ `
${worldGlsl()}
${NOISE_GLSL}
${stripClearingGlsl()}
uniform sampler2D uHeights;
uniform vec3 uMap;
out vec4 fragColor;
// a dark chart in the colours of the land: heath, forest, rock, snow, and the sea by depth
const vec3 HEATH = vec3(0.31, 0.29, 0.235);
const vec3 FOREST = vec3(0.17, 0.24, 0.18);
const vec3 ROCK = vec3(0.4, 0.4, 0.41);
const vec3 SNOW = vec3(0.8, 0.83, 0.87);
const vec3 SHALLOW = vec3(0.13, 0.23, 0.27);
const vec3 DEEP = vec3(0.055, 0.1, 0.14);
const vec3 SHORE = vec3(0.62, 0.68, 0.66);
float heightAt(ivec2 c) {
  vec3 t = round(texelFetch(uHeights, clamp(c, ivec2(0), ivec2(MAP_SIZE - 1)), 0).rgb * 255.0);
  return (t.r * 65536.0 + t.g * 256.0 + t.b) * (${H_RANGE.toFixed(1)} / 16777215.0) + (${H_MIN.toFixed(1)});
}
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  float s = uMap.z;
  float h = heightAt(c);
  vec2 g = vec2(heightAt(c + ivec2(1, 0)) - heightAt(c - ivec2(1, 0)), heightAt(c + ivec2(0, 1)) - heightAt(c - ivec2(0, 1))) / (2.0 * s);
  vec3 N = normalize(vec3(-g.x, 1.0, -g.y));
  vec2 P = uMap.xy + (vec2(c) + 0.5) * s;
  float slope = 1.0 - N.y;
  // the terrain shader's biomes, without the details finer than a texel
  float nL = vnoise(P * (1.0 / 520.0), 501u);
  float nM = vnoise(P * (1.0 / 110.0), 502u);
  float snowLine = 960.0 + 160.0 * nL + 150.0 * N.z + 45.0 * nM;
  float snow = smoothstep(snowLine - 40.0, snowLine + 60.0, h) * (1.0 - smoothstep(0.34, 0.52, slope));
  float treeLine = 430.0 + 110.0 * nL;
  float forest = (1.0 - smoothstep(treeLine - 80.0, treeLine + 30.0, h)) * (1.0 - smoothstep(0.2, 0.36, slope))
    * smoothstep(3.0, 10.0, h) * smoothstep(-0.55, 0.05, nM) * stripClearing(P);
  float rock = smoothstep(0.17, 0.33, slope);
  vec3 col = mix(HEATH, FOREST, forest);
  col = mix(col, ROCK, rock);
  col = mix(col, SNOW, snow);
  // hill shading, lit from the north-west as on paper maps
  col *= 0.32 + 0.88 * max(dot(N, normalize(vec3(-1.0, 1.2, -1.0))), 0.0);
  // the sea by depth, and a fine line along the shore (distance to it in texels, + on land)
  vec3 sea = mix(SHALLOW, DEEP, smoothstep(0.0, 140.0, -h));
  float shore = h / max(length(g) * s, 0.05);
  col = mix(sea, col, smoothstep(-0.5, 0.5, shore));
  col = mix(col, SHORE, (1.0 - smoothstep(0.0, 1.1, abs(shore))) * 0.7);
  fragColor = vec4(col, 1.0);
}
`;

type Phase = 'idle' | 'compiling' | 'heights' | 'colours' | 'reading';

function target(): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(MAP_SIZE, MAP_SIZE, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: false,
    generateMipmaps: false,
  });
}

export class WorldMap {
  /** the finished map (north up, west on the left), or null until the first bake completes */
  image: ImageBitmap | null = null;
  /** world position of the image's west and north edges (m); it spans MAP_EXTENT on each side */
  x0 = 0;
  z0 = 0;
  readonly extent = MAP_EXTENT;
  /** height rows baked per frame (the colour pass is cheaper and does four times as many) */
  rowsPerFrame = 64;
  /** completed bakes (tests) */
  bakes = 0;
  phase: Phase = 'idle';
  private job: { x0: number; z0: number } | null = mapRegionAround(MAP_HOME[0], MAP_HOME[1]);
  private compiled = false;
  private row = 0;
  private heights: THREE.WebGLRenderTarget | null = null;
  private colours: THREE.WebGLRenderTarget | null = null;
  private readonly heightU = { uMap: { value: new THREE.Vector3() } };
  private readonly colourU = { uMap: { value: new THREE.Vector3() }, uHeights: { value: null as THREE.Texture | null } };
  private readonly heightPass = new FullscreenPass(passMaterial(HEIGHT_FRAG(), this.heightU));
  private readonly colourPass = new FullscreenPass(passMaterial(COLOUR_FRAG(), this.colourU, { MAP_SIZE }));

  /** Keeps the aircraft on the map: plans a new map around (x, z) when it nears the edge of this one. */
  follow(x: number, z: number): void {
    if (this.job) return; // the bake in progress comes first
    if (this.image && mapCovers(this.x0, this.z0, x, z)) return;
    this.job = mapRegionAround(x, z);
  }

  /** Bakes a new map around (x, z) after the one in progress (tests). */
  rebake(x: number, z: number): void {
    if (!this.job) this.job = mapRegionAround(x, z);
  }

  /** Advances the bake by one slice. Call once per frame, after the frame's own rendering. */
  update(r: THREE.WebGLRenderer): void {
    const job = this.job;
    if (!job || this.phase === 'compiling' || this.phase === 'reading') return;
    this.heights ??= target();
    this.colours ??= target();
    if (!this.compiled && !r.extensions.has('KHR_parallel_shader_compile')) this.compiled = true;
    if (!this.compiled) {
      // the height pass is the whole terrain function in a fragment shader: compile it off the frame
      this.phase = 'compiling';
      void Promise.all([this.heightPass.compileAsync(r, this.heights), this.colourPass.compileAsync(r, this.colours)]).then(() => {
        this.compiled = true;
        this.phase = 'idle';
      });
      return;
    }
    if (this.phase === 'idle') {
      this.phase = 'heights';
      this.row = 0;
    }
    if (this.phase === 'heights') {
      this.heightU.uMap.value.set(job.x0, job.z0, MAP_TEXEL);
      this.slice(r, this.heightPass, this.heights, this.rowsPerFrame);
      if (this.row >= MAP_SIZE) {
        this.phase = 'colours';
        this.row = 0;
      }
      return;
    }
    this.colourU.uMap.value.set(job.x0, job.z0, MAP_TEXEL);
    this.colourU.uHeights.value = this.heights.texture;
    this.slice(r, this.colourPass, this.colours, this.rowsPerFrame * 4);
    if (this.row >= MAP_SIZE) {
      this.phase = 'reading';
      void this.readBack(r, this.colours, job);
    }
  }

  private slice(r: THREE.WebGLRenderer, pass: FullscreenPass, rt: THREE.WebGLRenderTarget, rows: number): void {
    const n = Math.min(rows, MAP_SIZE - this.row);
    rt.scissor.set(0, this.row, MAP_SIZE, n);
    rt.scissorTest = true;
    pass.render(r, rt);
    rt.scissorTest = false;
    this.row += n;
  }

  /**
   * Reads the colours back asynchronously (no pipeline stall), then swaps the image. All bands are
   * requested at once: each waits for a GPU fence, and where the GPU runs many frames behind (software
   * rendering) waiting for them one after another would multiply that delay. Each band is still copied
   * out in its own task.
   */
  private async readBack(r: THREE.WebGLRenderer, rt: THREE.WebGLRenderTarget, job: { x0: number; z0: number }): Promise<void> {
    const size = MAP_SIZE;
    const data = new Uint8Array(size * size * 4);
    const band = 256;
    try {
      const reads: Promise<unknown>[] = [];
      for (let y = 0; y < size; y += band) {
        reads.push(r.readRenderTargetPixelsAsync(rt, 0, y, size, band, data.subarray(y * size * 4, (y + band) * size * 4)));
      }
      await Promise.all(reads);
      const image = await createImageBitmap(new ImageData(new Uint8ClampedArray(data.buffer), size, size));
      this.image?.close();
      this.image = image;
      this.x0 = job.x0;
      this.z0 = job.z0;
      this.bakes++;
    } catch (e) {
      // keep the previous map; follow() plans another bake
      console.warn('Map bake failed', e);
    }
    // 32 MB of render targets: free them until the next bake
    this.heights?.dispose();
    this.colours?.dispose();
    this.heights = null;
    this.colours = null;
    this.job = null;
    this.phase = 'idle';
  }
}
