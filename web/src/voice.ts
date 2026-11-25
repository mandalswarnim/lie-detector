// Microphone analysis (Web Audio): RMS level, autocorrelation pitch, voice onset.
// Everything is local; nothing leaves the machine. If the mic is denied or missing,
// level stays 0 and the rest of the app carries on (scoring drops to fidget).

export class Voice {
  ready = false;
  denied = false;
  /** 0..1 loudness above the noise floor, for the VOICE pen */
  level = 0;
  /** dBFS of the last block */
  db = -100;
  /** Hz of the last voiced block, or 0 */
  pitch = 0;
  /** true while someone is talking (with a short hangover) */
  active = false;
  private floorDb = NaN;
  private hist: number[] = []; // recent block levels (dB) for the noise floor
  private frames = 0;
  private lastVoiceAt = 0;
  private ctx: AudioContext | null = null;
  private an: AnalyserNode | null = null;
  private buf = new Float32Array(2048);

  async start(ctx: AudioContext): Promise<void> {
    if (this.ready || this.denied) return;
    this.ctx = ctx;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      const src = ctx.createMediaStreamSource(stream);
      this.an = ctx.createAnalyser();
      this.an.fftSize = 2048;
      src.connect(this.an); // not connected to the speakers
      this.ready = true;
    } catch {
      this.denied = true;
    }
  }

  /** Call once per animation frame. */
  update(now: number): void {
    if (!this.an || !this.ctx) return;
    this.an.getFloatTimeDomainData(this.buf);
    let s = 0;
    for (let i = 0; i < this.buf.length; i++) s += this.buf[i] * this.buf[i];
    const rms = Math.sqrt(s / this.buf.length);
    this.db = 20 * Math.log10(rms + 1e-9);

    // noise floor = 15th percentile of the last ~10 s: speech has gaps, room noise doesn't,
    // so this follows a noisy venue without counting talking as "floor"
    this.hist.push(this.db);
    if (this.hist.length > 600) this.hist.shift();
    if (Number.isNaN(this.floorDb)) this.floorDb = this.db;
    if (++this.frames % 15 === 0) {
      const s = [...this.hist].sort((a, b) => a - b);
      this.floorDb = s[Math.floor(s.length * 0.15)];
    } else if (this.db < this.floorDb) this.floorDb = this.db; // quieter: follow down at once
    const above = this.db - this.floorDb;
    const speaking = above > 12 && this.db > -55;
    if (speaking) this.lastVoiceAt = now;
    this.active = now - this.lastVoiceAt < 250;
    this.level = Math.max(0, Math.min(1, (above - 6) / 30));

    this.pitch = speaking ? this.detectPitch(this.ctx.sampleRate) : 0;
  }

  /** Normalised autocorrelation over 75-400 Hz; 0 if not clearly periodic. */
  private detectPitch(sr: number): number {
    const x = this.buf;
    const n = x.length;
    const minLag = Math.floor(sr / 400);
    const maxLag = Math.min(Math.floor(sr / 75), n - 1);
    let best = 0;
    let bestLag = 0;
    const corr = new Float32Array(maxLag + 2);
    for (let lag = minLag; lag <= maxLag + 1; lag++) {
      let c = 0;
      let e1 = 0;
      let e2 = 0;
      for (let i = 0; i + lag < n; i++) {
        c += x[i] * x[i + lag];
        e1 += x[i] * x[i];
        e2 += x[i + lag] * x[i + lag];
      }
      corr[lag] = c / Math.sqrt(e1 * e2 + 1e-12);
    }
    // first strong peak (avoids octave errors from later multiples)
    for (let lag = minLag + 1; lag <= maxLag; lag++) {
      if (corr[lag] > 0.6 && corr[lag] >= corr[lag - 1] && corr[lag] >= corr[lag + 1]) {
        best = corr[lag];
        bestLag = lag;
        break;
      }
    }
    if (!bestLag) return 0;
    // parabolic interpolation
    const a = corr[bestLag - 1];
    const b = best;
    const c = corr[bestLag + 1];
    const d = a - 2 * b + c;
    const shift = d ? (0.5 * (a - c)) / d : 0;
    return sr / (bestLag + shift);
  }
}
