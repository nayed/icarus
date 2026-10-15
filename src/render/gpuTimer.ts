// GPU time of a frame from EXT_disjoint_timer_query_webgl2, where the browser exposes it (Chrome
// desktop does; Firefox and Safari usually do not). Results arrive a few frames late.
interface TimerExt {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

export class GpuTimer {
  private readonly ext: TimerExt | null;
  private readonly free: WebGLQuery[] = [];
  private readonly pending: WebGLQuery[] = [];
  private active: WebGLQuery | null = null;
  /** newest GPU frame time in ms, -1 until one has been measured */
  lastMs = -1;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExt | null;
  }

  begin(): void {
    if (!this.ext || this.active || this.pending.length >= 4) return;
    const q = this.free.pop() ?? this.gl.createQuery();
    if (!q) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.active = q;
  }

  end(): void {
    if (!this.ext || !this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
  }

  /** Collects finished queries; returns true when a new time arrived. */
  poll(): boolean {
    if (!this.ext) return false;
    const gl = this.gl;
    // a disjoint event (GPU reset, power state change) invalidates the queries in flight
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT) as boolean;
    let got = false;
    while (this.pending.length) {
      const q = this.pending[0];
      if (!disjoint && !gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      this.pending.shift();
      if (!disjoint) {
        this.lastMs = (gl.getQueryParameter(q, gl.QUERY_RESULT) as number) / 1e6;
        got = true;
      }
      this.free.push(q);
    }
    return got;
  }
}
