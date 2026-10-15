// Procedural sound: everything is synthesised with WebAudio (no audio files).
export interface AudioState {
  rpm: number;
  throttle: number;
  airspeed: number;
  stall: boolean;
  cockpit: boolean;
  onWater: boolean;
  groundSpeed: number;
  onGround: boolean;
}

export class SoundEngine {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private engineGain!: GainNode;
  private engineFilter!: BiquadFilterNode;
  private crank!: OscillatorNode;
  private fire!: OscillatorNode;
  private fire2!: OscillatorNode;
  private propLfo!: OscillatorNode;
  private propAm!: GainNode;
  private windGain!: GainNode;
  private windFilter!: BiquadFilterNode;
  private rollGain!: GainNode;
  private rollFilter!: BiquadFilterNode;
  private stallGain!: GainNode;
  private noise!: AudioBuffer;
  private cabin!: BiquadFilterNode;
  volume = 0.7;
  /** extra gain factor (quieter behind the menu) */
  ambient = 1;
  private appliedAmbient = 1;
  private muted = false;

  /** Must be called from a user gesture. */
  start(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.cabin = ctx.createBiquadFilter();
    this.cabin.type = 'lowpass';
    this.cabin.frequency.value = 18000;
    this.cabin.connect(comp);
    comp.connect(this.master);
    this.master.connect(ctx.destination);

    // white noise buffer
    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    let b = 0;
    for (let i = 0; i < d.length; i++) {
      const w = Math.random() * 2 - 1;
      b = 0.97 * b + 0.03 * w; // a touch of pink
      d[i] = w * 0.5 + b * 2;
    }

    // engine: crank fundamental + firing pulses through a soft clipper and a throttle-controlled lowpass
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.Q.value = 0.8;
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
      const x = (i / 1023) * 2 - 1;
      curve[i] = Math.tanh(x * 2.5);
    }
    shaper.curve = curve;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    const mix = ctx.createGain();
    mix.gain.value = 0.5;
    this.crank = ctx.createOscillator();
    this.crank.type = 'triangle';
    this.fire = ctx.createOscillator();
    this.fire.type = 'sawtooth';
    this.fire2 = ctx.createOscillator();
    this.fire2.type = 'square';
    const g1 = ctx.createGain();
    g1.gain.value = 0.9;
    const g2 = ctx.createGain();
    g2.gain.value = 0.35;
    const g3 = ctx.createGain();
    g3.gain.value = 0.12;
    this.crank.connect(g1).connect(mix);
    this.fire.connect(g2).connect(mix);
    this.fire2.connect(g3).connect(mix);
    // propeller blade-pass amplitude modulation
    this.propAm = ctx.createGain();
    this.propAm.gain.value = 0.8;
    this.propLfo = ctx.createOscillator();
    this.propLfo.type = 'sine';
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0.2;
    this.propLfo.connect(lfoDepth).connect(this.propAm.gain);
    mix.connect(shaper).connect(this.engineFilter).connect(this.propAm).connect(this.engineGain).connect(this.cabin);
    // exhaust/prop noise layer
    const nsrc = ctx.createBufferSource();
    nsrc.buffer = this.noise;
    nsrc.loop = true;
    const nf = ctx.createBiquadFilter();
    nf.type = 'bandpass';
    nf.frequency.value = 420;
    nf.Q.value = 0.6;
    const ng = ctx.createGain();
    ng.gain.value = 0.25;
    nsrc.connect(nf).connect(ng).connect(this.propAm);
    nsrc.start();

    // wind
    const wsrc = ctx.createBufferSource();
    wsrc.buffer = this.noise;
    wsrc.loop = true;
    wsrc.playbackRate.value = 0.7;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'lowpass';
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    wsrc.connect(this.windFilter).connect(this.windGain).connect(this.cabin);
    wsrc.start();

    // tyre / hull rumble on the ground or water
    const rsrc = ctx.createBufferSource();
    rsrc.buffer = this.noise;
    rsrc.loop = true;
    rsrc.playbackRate.value = 0.4;
    this.rollFilter = ctx.createBiquadFilter();
    this.rollFilter.type = 'lowpass';
    this.rollFilter.frequency.value = 220;
    this.rollGain = ctx.createGain();
    this.rollGain.gain.value = 0;
    rsrc.connect(this.rollFilter).connect(this.rollGain).connect(this.cabin);
    rsrc.start();

    // stall horn
    const horn = ctx.createOscillator();
    horn.type = 'square';
    horn.frequency.value = 410;
    const hf = ctx.createBiquadFilter();
    hf.type = 'lowpass';
    hf.frequency.value = 1500;
    this.stallGain = ctx.createGain();
    this.stallGain.gain.value = 0;
    horn.connect(hf).connect(this.stallGain).connect(comp);
    horn.start();

    for (const o of [this.crank, this.fire, this.fire2, this.propLfo]) o.start();
    this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, ctx.currentTime, 0.3);
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.ctx && !this.muted) this.master.gain.setTargetAtTime(v * this.ambient, this.ctx.currentTime, 0.1);
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : this.volume * this.ambient, this.ctx.currentTime, 0.15);
  }

  update(s: AudioState): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    if (this.ambient !== this.appliedAmbient && !this.muted) {
      this.appliedAmbient = this.ambient;
      this.master.gain.setTargetAtTime(this.volume * this.ambient, t, 0.4);
    }
    const rps = Math.max(s.rpm, 1) / 60;
    // 9-cylinder radial: firing frequency = rps * 4.5
    this.crank.frequency.setTargetAtTime(rps, t, 0.05);
    this.fire.frequency.setTargetAtTime(rps * 4.5, t, 0.05);
    this.fire2.frequency.setTargetAtTime(rps * 9.0, t, 0.05);
    this.propLfo.frequency.setTargetAtTime(rps * 3, t, 0.05);
    const load = 0.35 + 0.65 * s.throttle;
    this.engineFilter.frequency.setTargetAtTime(260 + 1500 * s.throttle * (s.rpm / 2200), t, 0.08);
    this.engineGain.gain.setTargetAtTime(s.rpm > 50 ? (0.16 + 0.22 * load) * (s.cockpit ? 1.15 : 0.8) : 0, t, 0.1);
    const v = Math.min(s.airspeed / 70, 1.4);
    this.windGain.gain.setTargetAtTime(v * v * (s.cockpit ? 0.18 : 0.32), t, 0.1);
    this.windFilter.frequency.setTargetAtTime(300 + 2600 * v, t, 0.1);
    const roll = s.onGround || s.onWater ? Math.min(s.groundSpeed / 25, 1) : 0;
    this.rollGain.gain.setTargetAtTime(roll * (s.onWater ? 0.35 : 0.22), t, 0.08);
    this.rollFilter.frequency.setTargetAtTime(s.onWater ? 900 : 180 + 200 * roll, t, 0.1);
    this.stallGain.gain.setTargetAtTime(s.stall ? 0.07 : 0, t, 0.03);
    this.cabin.frequency.setTargetAtTime(s.cockpit ? 2600 : 16000, t, 0.2);
  }

  private burst(freq: number, q: number, dur: number, gain: number, type: BiquadFilterType = 'bandpass'): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.cabin);
    src.start(t, Math.random());
    src.stop(t + dur + 0.05);
  }

  private tone(freq: number, dur: number, gain: number, type: OscillatorType = 'sine', bendTo?: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const o = ctx.createOscillator();
    o.type = type;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    o.frequency.setValueAtTime(freq, t);
    if (bendTo) o.frequency.exponentialRampToValueAtTime(bendTo, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.cabin);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  thump(speed: number): void {
    const k = Math.min(speed / 3, 1.5);
    this.tone(70, 0.25, 0.25 * k, 'sine', 40);
    this.burst(300, 0.8, 0.18, 0.18 * k, 'lowpass');
    if (speed > 0.6) this.burst(2600, 3, 0.25, 0.05 * k); // tyre chirp
  }

  splash(speed: number): void {
    const k = Math.min(speed / 2 + 0.3, 1.5);
    this.burst(900, 0.5, 0.9, 0.25 * k);
    this.burst(2500, 0.8, 0.5, 0.08 * k);
  }

  scrape(): void {
    this.burst(1400, 2, 0.6, 0.2);
  }

  crash(): void {
    this.burst(160, 0.5, 1.6, 0.6, 'lowpass');
    this.burst(900, 0.6, 1.2, 0.25);
  }

  motor(dur: number): void {
    this.tone(150, dur, 0.035, 'sawtooth', 120);
  }

  chime(): void {
    for (const [f, g, d] of [[880, 0.12, 1.4], [1320 * 1.003, 0.06, 1.0], [1760 * 0.997, 0.04, 0.8], [2637, 0.02, 0.5]] as const) this.tone(f, d, g);
  }

  click(): void {
    this.tone(1800, 0.05, 0.04, 'triangle');
  }
}
