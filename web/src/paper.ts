// Strip-chart recorder: cream graph paper scrolling right-to-left under fixed pens.
// History is kept per render frame with timestamps, so the paper speed is exact and
// a resize just redraws. Values are lane units: -1 (bottom) .. +1 (top).

export interface Channel {
  label: string;
  ink: string;
}

type Row = { at: number; v: number[] };

const GRID_MINOR = "rgba(196, 120, 70, 0.20)";
const GRID_MAJOR = "rgba(176, 90, 50, 0.42)";
const LABEL_INK = "#4a2e17";

export class StripChart {
  private rows: Row[] = [];
  private ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  /** seconds of history visible left of the pens */
  seconds = 8;
  /** pens sit this far across the paper; fresh paper to their right */
  penFrac = 0.86;

  constructor(private canvas: HTMLCanvasElement, private channels: Channel[]) {
    this.ctx = canvas.getContext("2d")!;
    new ResizeObserver(() => requestAnimationFrame(() => this.resize())).observe(canvas);
    this.resize();
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    this.w = this.canvas.clientWidth;
    this.h = this.canvas.clientHeight;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  push(now: number, values: number[]): void {
    this.rows.push({ at: now, v: values });
    const keep = this.seconds * 1000 + 500;
    while (this.rows.length && now - this.rows[0].at > keep) this.rows.shift();
  }

  draw(now: number): void {
    const { ctx, w, h } = this;
    if (!w || !h) return;
    const penX = w * this.penFrac;
    const speed = penX / this.seconds; // px per second
    const lanes = this.channels.length;
    const top = Math.max(28, h * 0.05); // margin for the time ticks
    const laneH = (h - top) / lanes;
    const amp = laneH * 0.42;
    const xOf = (at: number) => penX - ((now - at) / 1000) * speed;

    // ---- paper + scrolling grid
    ctx.fillStyle = "#fbf4df";
    ctx.fillRect(0, 0, w, h);
    const minor = Math.max(12, Math.round(h / 44));
    const shift = ((now / 1000) * speed) % (minor * 5);
    ctx.lineWidth = 1;
    for (let i = -1; i * minor - shift < w + minor * 5; i++) {
      const x = Math.round(i * minor - shift) + 0.5;
      const idx = i + Math.floor(((now / 1000) * speed) / (minor * 5)) * 5;
      ctx.strokeStyle = ((idx % 5) + 5) % 5 === 0 ? GRID_MAJOR : GRID_MINOR;
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    for (let j = 0; top + j * minor <= h; j++) {
      const y = Math.round(top + j * minor) + 0.5;
      ctx.strokeStyle = j % 5 === 0 ? GRID_MAJOR : GRID_MINOR;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    // ---- time ticks along the top edge, one per second, stamped every 5 s
    ctx.fillStyle = LABEL_INK;
    ctx.strokeStyle = LABEL_INK;
    ctx.font = `${Math.round(top * 0.55)}px 'Special Elite', monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    const sNow = now / 1000;
    for (let s = Math.floor(sNow - this.seconds - 1); s <= sNow; s++) {
      const x = penX - (sNow - s) * speed;
      if (x < 0 || s < 0) continue;
      const big = s % 5 === 0;
      ctx.beginPath();
      ctx.moveTo(x, top - (big ? top * 0.35 : top * 0.18));
      ctx.lineTo(x, top);
      ctx.stroke();
      if (big) ctx.fillText(String(s % 1000).padStart(3, "0"), x, top * 0.55);
    }

    // ---- lane separators + baselines + labels
    for (let c = 0; c < lanes; c++) {
      const y0 = top + c * laneH;
      const mid = y0 + laneH / 2;
      ctx.strokeStyle = "rgba(74, 46, 23, 0.55)";
      ctx.setLineDash([2, 6]);
      ctx.beginPath();
      ctx.moveTo(0, mid);
      ctx.lineTo(w, mid);
      ctx.stroke();
      ctx.setLineDash([]);
      if (c > 0) {
        ctx.strokeStyle = "rgba(74, 46, 23, 0.7)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(0, y0);
        ctx.lineTo(w, y0);
        ctx.stroke();
        ctx.lineWidth = 1;
      }
    }

    // ---- ink: a wide faint pass (bleed into the paper) then the line itself
    for (let c = 0; c < lanes; c++) {
      const mid = top + c * laneH + laneH / 2;
      const ink = this.channels[c].ink;
      for (const [width, alpha] of [[5, 0.12], [2.2, 0.92]] as const) {
        ctx.strokeStyle = ink;
        ctx.globalAlpha = alpha;
        ctx.lineWidth = width;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.beginPath();
        let started = false;
        for (const r of this.rows) {
          const x = xOf(r.at);
          if (x < -10) continue;
          const y = mid - r.v[c] * amp;
          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // ---- labels (drawn over the ink, on a paper tab so they stay readable)
    const fs = Math.max(18, Math.round(laneH * 0.16));
    ctx.font = `${fs}px 'Special Elite', monospace`;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    for (let c = 0; c < lanes; c++) {
      const y0 = top + c * laneH;
      const label = this.channels[c].label;
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = "rgba(251, 244, 223, 0.9)";
      ctx.fillRect(8, y0 + 8, tw + 16, fs + 10);
      ctx.strokeStyle = this.channels[c].ink;
      ctx.lineWidth = 2;
      ctx.strokeRect(8, y0 + 8, tw + 16, fs + 10);
      ctx.fillStyle = this.channels[c].ink;
      ctx.fillText(label, 16, y0 + 13);
    }

    // ---- pens: a rod from a pivot on the right edge to the tip on the paper
    const last = this.rows[this.rows.length - 1];
    for (let c = 0; c < lanes; c++) {
      const mid = top + c * laneH + laneH / 2;
      const tipY = mid - (last ? last.v[c] : 0) * amp;
      const pivotX = w - 14;
      ctx.strokeStyle = "#2a2a2a";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(pivotX, mid);
      ctx.lineTo(penX, tipY);
      ctx.stroke();
      ctx.fillStyle = this.channels[c].ink;
      ctx.beginPath();
      ctx.arc(penX, tipY, 4, 0, Math.PI * 2);
      ctx.fill();
      const g = ctx.createRadialGradient(pivotX - 3, mid - 3, 1, pivotX, mid, 10);
      g.addColorStop(0, "#f6e2a0");
      g.addColorStop(1, "#8a6420");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(pivotX, mid, 9, 0, Math.PI * 2);
      ctx.fill();
    }

    // shadow where the paper runs under the pen carriage
    const sh = ctx.createLinearGradient(w - 60, 0, w, 0);
    sh.addColorStop(0, "rgba(60, 40, 20, 0)");
    sh.addColorStop(1, "rgba(60, 40, 20, 0.28)");
    ctx.fillStyle = sh;
    ctx.fillRect(w - 60, 0, 60, h);
  }
}
