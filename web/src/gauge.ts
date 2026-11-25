// Brass analogue BPM gauge. The face is rendered once per resize to an offscreen
// canvas; only the needle is drawn per frame, driven by an underdamped spring so it
// swings and settles like a moving-coil meter.

const MIN = 40;
const MAX = 160;
const REST = MIN - 6; // needle parks on the stop pin below the scale
const A0 = (225 * Math.PI) / 180; // angle of MIN (screen coords, y down => use -sin)
const A1 = (-45 * Math.PI) / 180; // angle of MAX

function angleOf(bpm: number): number {
  const f = (bpm - MIN) / (MAX - MIN);
  return A0 + (A1 - A0) * f;
}

export class Gauge {
  private ctx: CanvasRenderingContext2D;
  private face = document.createElement("canvas");
  private size = 0;
  private pos = REST; // in BPM units
  private vel = 0;
  private lastT = 0;
  target = REST;
  /** extra needle tremble, 0..1 (e.g. from fidget) */
  tremble = 0;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
    new ResizeObserver(() => requestAnimationFrame(() => this.resize())).observe(canvas);
    this.resize();
  }

  /** null = no reading: the needle rests on the stop pin. */
  set(bpm: number | null): void {
    this.target = bpm === null ? REST : Math.min(MAX + 4, Math.max(MIN, bpm));
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const s = Math.min(this.canvas.clientWidth, this.canvas.clientHeight);
    if (!s) return;
    this.size = s;
    for (const c of [this.canvas, this.face]) {
      c.width = Math.round(this.canvas.clientWidth * dpr);
      c.height = Math.round(this.canvas.clientHeight * dpr);
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const f = this.face.getContext("2d")!;
    f.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.drawFace(f);
  }

  private center(): [number, number, number] {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    return [w / 2, h / 2, this.size / 2];
  }

  private drawFace(g: CanvasRenderingContext2D): void {
    const [cx, cy, R] = this.center();
    const pt = (a: number, r: number): [number, number] => [cx + Math.cos(a) * r, cy - Math.sin(a) * r];

    // brass bezel
    let grad = g.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
    grad.addColorStop(0, "#f7e4a2");
    grad.addColorStop(0.35, "#c9a24f");
    grad.addColorStop(0.6, "#8c6a26");
    grad.addColorStop(1, "#e2c77c");
    g.fillStyle = grad;
    g.beginPath();
    g.arc(cx, cy, R * 0.98, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = "#5a4214";
    g.lineWidth = 2;
    g.stroke();
    // inner bevel
    grad = g.createLinearGradient(cx + R, cy + R, cx - R, cy - R);
    grad.addColorStop(0, "#f2dc95");
    grad.addColorStop(1, "#7d5c1e");
    g.fillStyle = grad;
    g.beginPath();
    g.arc(cx, cy, R * 0.9, 0, Math.PI * 2);
    g.fill();

    // cream dial face, slightly aged at the edge
    grad = g.createRadialGradient(cx, cy - R * 0.2, R * 0.1, cx, cy, R * 0.86);
    grad.addColorStop(0, "#fbf3dc");
    grad.addColorStop(0.85, "#efe0b8");
    grad.addColorStop(1, "#d9c38f");
    g.fillStyle = grad;
    g.beginPath();
    g.arc(cx, cy, R * 0.86, 0, Math.PI * 2);
    g.fill();

    // red zone 110-160
    g.strokeStyle = "rgba(160, 28, 28, 0.85)";
    g.lineWidth = R * 0.07;
    g.beginPath();
    g.arc(cx, cy, R * 0.7, -angleOf(110), -angleOf(MAX), false);
    g.stroke();

    // ticks
    g.strokeStyle = "#2b1d0e";
    g.fillStyle = "#2b1d0e";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.font = `${Math.round(R * 0.13)}px 'Special Elite', monospace`;
    for (let b = MIN; b <= MAX; b += 5) {
      const a = angleOf(b);
      const major = b % 20 === 0;
      const mid = b % 10 === 0;
      const [x0, y0] = pt(a, R * 0.78);
      const [x1, y1] = pt(a, R * (major ? 0.64 : mid ? 0.69 : 0.73));
      g.lineWidth = major ? 3 : mid ? 2 : 1;
      g.beginPath();
      g.moveTo(x0, y0);
      g.lineTo(x1, y1);
      g.stroke();
      if (major) {
        const [tx, ty] = pt(a, R * 0.52);
        g.fillText(String(b), tx, ty);
      }
    }

    // legends
    g.font = `${Math.round(R * 0.1)}px 'Special Elite', monospace`;
    g.fillText("PULSE", cx, cy - R * 0.25);
    g.font = `${Math.round(R * 0.065)}px 'Special Elite', monospace`;
    g.fillText("BEATS / MIN", cx, cy + R * 0.3);
    g.fillText("MODEL 7", cx, cy + R * 0.62);

    // stop pin
    const [px, py] = pt(angleOf(REST - 2), R * 0.74);
    g.fillStyle = "#3a3a3a";
    g.beginPath();
    g.arc(px, py, R * 0.025, 0, Math.PI * 2);
    g.fill();
  }

  draw(now: number): void {
    const { ctx } = this;
    const [cx, cy, R] = this.center();
    if (!R) return;
    const dt = this.lastT ? Math.min(0.05, (now - this.lastT) / 1000) : 0.016;
    this.lastT = now;

    // underdamped spring (zeta ~0.45): swings past and settles in ~1 s
    const k = 40;
    const c = 2 * Math.sqrt(k) * 0.45;
    const jitter = (Math.random() - 0.5) * (0.6 + this.tremble * 5);
    this.vel += (k * (this.target - this.pos) - c * this.vel) * dt + jitter;
    this.pos += this.vel * dt;
    if (this.pos < REST) {
      this.pos = REST; // bounce off the stop pin
      this.vel = Math.abs(this.vel) * 0.3;
    }

    ctx.clearRect(0, 0, this.canvas.clientWidth, this.canvas.clientHeight);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.face, 0, 0);
    ctx.restore();

    const a = angleOf(this.pos);
    const tip: [number, number] = [cx + Math.cos(a) * R * 0.76, cy - Math.sin(a) * R * 0.76];
    const tail: [number, number] = [cx - Math.cos(a) * R * 0.14, cy + Math.sin(a) * R * 0.14];
    // shadow, then needle
    for (const [dx, col, wid] of [[4, "rgba(0,0,0,0.22)", 5], [0, "#111", 3.2]] as const) {
      ctx.strokeStyle = col;
      ctx.lineWidth = wid;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(tail[0] + dx, tail[1] + dx);
      ctx.lineTo(tip[0] + dx, tip[1] + dx);
      ctx.stroke();
    }
    ctx.strokeStyle = "#a01c1c";
    ctx.lineWidth = 3.2;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * R * 0.5, cy - Math.sin(a) * R * 0.5);
    ctx.lineTo(tip[0], tip[1]);
    ctx.stroke();

    // hub
    const g = ctx.createRadialGradient(cx - R * 0.02, cy - R * 0.02, 1, cx, cy, R * 0.08);
    g.addColorStop(0, "#f8e7ad");
    g.addColorStop(1, "#7a5718");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.07, 0, Math.PI * 2);
    ctx.fill();

    // glass glare
    const gl = ctx.createLinearGradient(cx - R, cy - R, cx, cy);
    gl.addColorStop(0, "rgba(255,255,255,0.28)");
    gl.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = gl;
    ctx.beginPath();
    ctx.ellipse(cx - R * 0.2, cy - R * 0.35, R * 0.55, R * 0.3, -0.6, 0, Math.PI * 2);
    ctx.fill();
  }
}
