"""30 Hz frame loop + WebSocket broadcast on ws://localhost:8765.

Server -> client: one JSON frame per tick (CLAUDE.md contract, plus "dbg" and "wall_ms").
Client -> server (optional): {"cmd": "calibrate", "seconds": 15} | {"cmd": "reset"}
"""
from __future__ import annotations

import asyncio
import json
import sys
import time

from websockets.asyncio.server import broadcast, serve

from .dsp import Pipeline

FRAME_HZ = 30.0


class Server:
    def __init__(self, source, pipeline: Pipeline, recorder=None, host="localhost", port=8765,
                 seconds: float | None = None, quiet: bool = False):
        self.source, self.dsp, self.recorder = source, pipeline, recorder
        self.host, self.port, self.seconds, self.quiet = host, port, seconds, quiet
        self.clients: set = set()
        self.last_frame: dict | None = None

    async def handler(self, ws):
        self.clients.add(ws)
        self.log(f"client connected ({len(self.clients)})")
        try:
            async for msg in ws:
                self.on_command(msg)
        except Exception:
            pass
        finally:
            self.clients.discard(ws)
            self.log(f"client left ({len(self.clients)})")

    def on_command(self, msg: str) -> None:
        try:
            cmd = json.loads(msg)
        except ValueError:
            return
        now = self.last_frame["t"] if self.last_frame else 0.0
        if cmd.get("cmd") == "calibrate":
            self.dsp.start_calibration(now, float(cmd.get("seconds", 15)))
            self.log("calibration started")
        elif cmd.get("cmd") == "reset":
            self.dsp.reset()
            self.log("session reset")

    def log(self, s: str) -> None:
        if not self.quiet:
            print(f"\r\033[K[sensor] {s}", file=sys.stderr)

    def status(self, f: dict) -> None:
        if self.quiet:
            return
        d = f["dbg"]
        bpm = "  --" if f["bpm"] is None else f"{f['bpm']:5.1f}"
        lock = "LOCK" if f["bpm_locked"] else ("hold" if f["bpm_held"] else "....")
        rec = f"  REC {self.recorder.seconds():5.1f}s" if self.recorder else ""
        sys.stderr.write(
            f"\r\033[K t={f['t']:6.1f}  contact={'ON ' if f['contact'] else 'off'} "
            f"fidget={f['fidget']:.2f}  bpm={bpm} {lock} conf={f['bpm_conf']:.2f} "
            f"raw={d['raw_bpm']} ch={d['best_ch']}  crms={d['contact_rms']:.2e} "
            f"fs={d['fs'][0]:.0f}/{d['fs'][1]:.0f}  clients={len(self.clients)}{rec}")
        sys.stderr.flush()

    async def run(self) -> None:
        self.source.start()
        async with serve(self.handler, self.host, self.port):
            self.log(f"{self.source.name} source -> ws://{self.host}:{self.port} @ {FRAME_HZ:.0f} Hz")
            period = 1.0 / FRAME_HZ
            nxt = time.monotonic()
            last_status = 0.0
            t_now = 0.0
            while True:
                c = self.source.poll()
                if self.recorder:
                    self.recorder.add(c)
                self.dsp.push(c.accel_t, c.accel, c.gyro_t, c.gyro, c.lid, c.lux)
                if len(c.accel_t):
                    t_now = float(c.accel_t[-1])
                f = self.dsp.frame(t_now)
                f["wall_ms"] = round(time.time() * 1000)
                if c.truth:
                    f["dbg"]["truth"] = {k: round(v, 2) if isinstance(v, float) else v
                                         for k, v in c.truth.items()}
                self.last_frame = f
                if self.clients:
                    broadcast(self.clients, json.dumps(f, separators=(",", ":")))
                if time.monotonic() - last_status > 0.5:
                    last_status = time.monotonic()
                    self.status(f)
                if self.seconds is not None and t_now >= self.seconds:
                    self.log(f"reached --seconds {self.seconds}")
                    return
                if getattr(self.source, "done", False):
                    self.log("replay finished")
                    return
                nxt += period
                delay = nxt - time.monotonic()
                if delay < -0.5:          # fell badly behind (laptop slept); resync
                    nxt = time.monotonic()
                await asyncio.sleep(max(0.0, delay))
