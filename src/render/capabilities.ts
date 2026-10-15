// Detects what the GPU can do. URL flags can force fallbacks for testing:
//   ?force=nowebgl2   pretend WebGL2 is missing
//   ?force=nofloat    pretend float/half-float colour buffers are missing (LDR path)
//   ?force=logdepth   use a logarithmic depth buffer instead of reversed-Z

export interface Capabilities {
  webgl2: boolean;
  /** can render to RGBA16F/RGBA32F */
  floatTargets: boolean;
  /** can linearly filter 32-bit float textures */
  floatLinear: boolean;
  reversedZ: boolean;
  renderer: string;
  maxTextureSize: number;
  forced: string[];
}

export function forcedFlags(): string[] {
  const q = new URLSearchParams(location.search);
  return (q.get('force') ?? '').split(',').filter(Boolean);
}

export function detectCapabilities(): Capabilities {
  const forced = forcedFlags();
  const canvas = document.createElement('canvas');
  const gl = forced.includes('nowebgl2') ? null : (canvas.getContext('webgl2') as WebGL2RenderingContext | null);
  if (!gl) {
    return { webgl2: false, floatTargets: false, floatLinear: false, reversedZ: false, renderer: '', maxTextureSize: 0, forced };
  }
  const ext = (n: string) => !!gl.getExtension(n);
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const caps: Capabilities = {
    webgl2: true,
    floatTargets: !forced.includes('nofloat') && (ext('EXT_color_buffer_float') || ext('EXT_color_buffer_half_float')),
    floatLinear: ext('OES_texture_float_linear'),
    reversedZ: !forced.includes('logdepth') && ext('EXT_clip_control'),
    renderer: dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER)),
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    forced,
  };
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return caps;
}
