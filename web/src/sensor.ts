// WebSocket client for the sensor stream. Never blocks the UI:
// reconnects silently with backoff and always exposes the last good frame.

export interface SensorFrame {
  t: number;
  pulse_wave: number;
  bpm: number | null; // null until the first lock ever
  bpm_conf: number;
  bpm_locked: boolean;
  bpm_held: boolean;
  fidget: number;
  contact: boolean;
  lid: number | null;
  lux: number | null;
  wall_ms?: number;
  dbg?: Record<string, unknown>;
}

export const EMPTY_FRAME: SensorFrame = {
  t: 0, pulse_wave: 0, bpm: null, bpm_conf: 0, bpm_locked: false, bpm_held: false,
  fidget: 0, contact: false, lid: null, lux: null,
};

export class SensorClient {
  latest: SensorFrame = EMPTY_FRAME;
  connected = false;
  lastFrameAt = 0; // performance.now() of last frame
  latencyMs = 0; // sensor wall clock -> browser receipt
  private ws: WebSocket | null = null;
  private backoff = 250;
  private listeners: ((f: SensorFrame) => void)[] = [];

  constructor(private url = "ws://localhost:8765") {
    this.connect();
  }

  onFrame(fn: (f: SensorFrame) => void): void {
    this.listeners.push(fn);
  }

  /** Stale = no frame for 0.5 s (sensor down, or WS reconnecting). */
  get stale(): boolean {
    return performance.now() - this.lastFrameAt > 500;
  }

  send(cmd: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(cmd));
  }

  private connect(): void {
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.retry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.backoff = 250;
    };
    ws.onmessage = (ev) => {
      let f: SensorFrame;
      try {
        f = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      this.latest = f;
      this.lastFrameAt = performance.now();
      if (f.wall_ms) this.latencyMs = Date.now() - f.wall_ms;
      for (const fn of this.listeners) fn(f);
    };
    ws.onclose = () => {
      this.connected = false;
      this.ws = null;
      this.retry();
    };
    ws.onerror = () => ws.close();
  }

  private retry(): void {
    setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, 2000);
  }
}
