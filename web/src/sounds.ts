// Synthesised sound effects (no audio files, fully offline).
// NOTE: the laptop speakers shake the chassis, which the IMU reads as fidget.
// The state machine only plays sounds outside CALIBRATING and ANSWER.

export class Sounds {
  ctx: AudioContext;
  private master: GainNode;
  private noise: AudioBuffer;
  private scratch: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  muted = false;

  constructor() {
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.8;
    this.master.connect(this.ctx.destination);
    const len = this.ctx.sampleRate * 2;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  resume(): void {
    if (this.ctx.state !== "running") this.ctx.resume().catch(() => {});
  }

  private burst(at: number, dur: number, freq: number, q: number, gain: number, type: BiquadFilterType = "bandpass") {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(at, Math.random());
    src.stop(at + dur + 0.02);
  }

  private tone(at: number, dur: number, freq: number, gain: number, type: OscillatorType = "sine", slideTo?: number) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, at);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, at + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g).connect(this.master);
    o.start(at);
    o.stop(at + dur + 0.02);
  }

  /** Mechanical relay click (question change). */
  click(): void {
    if (this.muted) return;
    const t = this.ctx.currentTime;
    this.burst(t, 0.03, 3200, 4, 0.9);
    this.burst(t + 0.045, 0.025, 1800, 5, 0.6);
    this.tone(t, 0.04, 140, 0.3, "square");
  }

  /** Typewriter key, for the caption typing out. */
  key(): void {
    if (this.muted) return;
    const t = this.ctx.currentTime;
    this.burst(t, 0.02, 2500 + Math.random() * 1500, 3, 0.35);
  }

  /** Rubber stamp slam. */
  stamp(lie: boolean): void {
    if (this.muted) return;
    const t = this.ctx.currentTime;
    this.tone(t, 0.25, 110, 1.0, "sine", 45);
    this.burst(t, 0.12, 600, 0.8, 1.0, "lowpass");
    this.burst(t + 0.01, 0.05, 2500, 2, 0.5);
    if (lie) {
      // buzzer
      this.tone(t + 0.25, 0.7, 92, 0.25, "sawtooth");
      this.tone(t + 0.25, 0.7, 97, 0.25, "sawtooth");
    } else {
      // bell
      for (const [f, g] of [[1320, 0.25], [2640, 0.08], [3960, 0.04]]) this.tone(t + 0.25, 1.4, f, g);
    }
  }

  /** Bell for "calibration complete" / "pulse acquired". */
  ding(): void {
    if (this.muted) return;
    const t = this.ctx.currentTime;
    this.tone(t, 0.9, 1760, 0.15);
    this.tone(t, 0.9, 3520, 0.04);
  }

  /** Continuous pen scratching while the pens go wild. intensity 0 stops it. */
  scratchOn(intensity: number): void {
    if (this.muted) intensity = 0;
    const t = this.ctx.currentTime;
    if (intensity <= 0) {
      if (this.scratch) {
        this.scratch.gain.gain.setTargetAtTime(0, t, 0.05);
        const s = this.scratch.src;
        setTimeout(() => s.stop(), 300);
        this.scratch = null;
      }
      return;
    }
    if (!this.scratch) {
      const src = this.ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const hp = this.ctx.createBiquadFilter();
      hp.type = "bandpass";
      hp.frequency.value = 5200;
      hp.Q.value = 0.9;
      const gain = this.ctx.createGain();
      gain.gain.value = 0;
      // amplitude flutter like a nib dragging over fibres
      const lfo = this.ctx.createOscillator();
      lfo.frequency.value = 23;
      const lfoGain = this.ctx.createGain();
      lfoGain.gain.value = 1800; // Hz of filter sweep
      lfo.connect(lfoGain).connect(hp.frequency);
      lfo.start();
      src.connect(hp).connect(gain).connect(this.master);
      src.start();
      this.scratch = { src, gain };
    }
    this.scratch.gain.gain.setTargetAtTime(0.35 * intensity, t, 0.05);
  }
}
