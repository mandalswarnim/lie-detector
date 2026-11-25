"""Raw sample sources. Each poll() returns the new samples since the last call.

All times are seconds relative to the source start.
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from scipy import signal


@dataclass
class Chunk:
    accel_t: np.ndarray
    accel: np.ndarray            # (n, 3) g
    gyro_t: np.ndarray
    gyro: np.ndarray             # (m, 3) deg/s
    lid: float | None = None
    lux: float | None = None
    truth: dict = field(default_factory=dict)   # fake only: ground truth for debugging

    @staticmethod
    def empty() -> "Chunk":
        z = np.zeros(0)
        return Chunk(z, np.zeros((0, 3)), z, np.zeros((0, 3)))


# ---------------------------------------------------------------- real

class RealSource:
    name = "real"

    def __init__(self, rate: int = 100):
        from macimu import IMU
        self.rate = rate
        self.imu = IMU(accel=True, gyro=True, als=True, lid=True, sample_rate=rate)
        self.t0: float | None = None

    def start(self) -> None:
        self.imu.start()

    def stop(self) -> None:
        self.imu.stop()

    def _arr(self, samples):
        if not samples:
            return np.zeros(0), np.zeros((0, 3))
        a = np.asarray(samples, float)
        if self.t0 is None:
            self.t0 = a[0, 0]
        return a[:, 0] - self.t0, a[:, 1:4]

    def poll(self) -> Chunk:
        at, a = self._arr(self.imu.read_accel_timed())
        gt, g = self._arr(self.imu.read_gyro_timed())
        als = self.imu.read_als()
        return Chunk(at, a, gt, g, lid=self.imu.read_lid(), lux=als.lux if als else None)


# ---------------------------------------------------------------- fake

def _bcg_shape(phase: np.ndarray) -> np.ndarray:
    """Rough ballistocardiogram beat: small I dip, big J peak, K dip."""
    def g(mu, s):
        d = (phase - mu + 0.5) % 1.0 - 0.5
        return np.exp(-0.5 * (d / s) ** 2)
    return -0.5 * g(0.06, 0.035) + 1.0 * g(0.15, 0.04) - 0.6 * g(0.26, 0.045) + 0.2 * g(0.38, 0.05)


class FakeSource:
    """Synthetic raw IMU that exercises every UI state, on a 150 s loop.

      0-3 s     wrists off (IDLE)
      3-150 s   wrists on; pulse strong / weak in phases so the lock drops and
                re-acquires; fidget bursts every ~10-20 s after the first 20 s.
    Amplitudes are made-up but internally consistent with the default config.
    """
    name = "fake"
    LOOP = 150.0
    PULSE_PHASES = [(0, 8, 0.15), (8, 45, 1.0), (45, 53, 0.1), (53, 100, 1.0),
                    (100, 112, 0.1), (112, 150, 1.0)]

    def __init__(self, fs: float = 100.0, seed: int = 7, realtime: bool = True):
        self.fs, self.realtime = fs, realtime
        self.rng = np.random.default_rng(seed)
        self.n = 0
        self.phase = 0.0
        self.t_start = None
        self.tremor = signal.butter(2, [7, 12], btype="band", fs=fs, output="sos")
        self.zi_tremor = np.zeros((self.tremor.shape[0], 2, 6))
        self.fid_sos = signal.butter(2, [3, 20], btype="band", fs=fs, output="sos")
        self.zi_fid = np.zeros((self.fid_sos.shape[0], 2, 6))
        self.bursts: list[tuple[float, float, float]] = []
        self._plan_loop(0)

    def _plan_loop(self, k: int) -> None:
        t, base = 20.0, k * self.LOOP
        while t < self.LOOP - 5:
            dur = self.rng.uniform(1.0, 3.0)
            amp = self.rng.uniform(4.0, 25.0)
            self.bursts.append((base + t, base + t + dur, amp))
            t += dur + self.rng.uniform(8.0, 18.0)
        self._planned = k

    def start(self) -> None:
        self.t_start = time.monotonic()

    def stop(self) -> None:
        pass

    def bpm_at(self, t: np.ndarray) -> np.ndarray:
        tau = t % self.LOOP
        return 72 + 5 * np.sin(2 * np.pi * tau / 60.0) + 6 * np.exp(-((tau - 75) / 10) ** 2)

    def generate(self, n: int) -> Chunk:
        fs, rng = self.fs, self.rng
        t = (self.n + np.arange(n)) / fs
        self.n += n
        tau = t % self.LOOP
        k = int(t[-1] // self.LOOP)
        if k > self._planned:
            self._plan_loop(k)

        contact = (tau >= 3.0).astype(float)
        amp = np.zeros(n)
        for a, b, v in self.PULSE_PHASES:
            amp[(tau >= a) & (tau < b)] = v
        amp *= contact
        bpm = self.bpm_at(t)
        ph = self.phase + np.cumsum(bpm / 60.0 / fs)
        self.phase = ph[-1] % 1.0
        beat = _bcg_shape(ph % 1.0) * amp

        fid = np.zeros(n)
        for a, b, v in self.bursts:
            m = (t >= a) & (t < b)
            if m.any():
                env = np.sin(np.pi * (t[m] - a) / (b - a))
                fid[m] = np.maximum(fid[m], v * env)
        fid *= contact

        trem, self.zi_tremor = signal.sosfilt(self.tremor, rng.standard_normal((n, 6)), axis=0, zi=self.zi_tremor)
        fn, self.zi_fid = signal.sosfilt(self.fid_sos, rng.standard_normal((n, 6)), axis=0, zi=self.zi_fid)

        accel = np.empty((n, 3))
        accel[:] = (0.012, -0.020, -0.999)                       # gravity, slight tilt
        accel += 1.0e-4 * rng.standard_normal((n, 3))            # sensor noise
        accel += 4.0e-4 * trem[:, :3] * contact[:, None]         # physiological tremor
        accel += 6.0e-4 * beat[:, None] * np.array([0.2, 0.5, 1.0])
        accel += 3.0e-4 * fn[:, :3] * fid[:, None]
        gyro = 0.01 * rng.standard_normal((n, 3))
        gyro += 0.04 * trem[:, 3:] * contact[:, None]
        gyro += 0.06 * beat[:, None] * np.array([1.0, 0.4, 0.2])
        gyro += 0.03 * fn[:, 3:] * fid[:, None]

        return Chunk(t, accel, t.copy(), gyro,
                     lid=103.0 + 0.2 * np.sin(t[-1] / 7), lux=1.0 + 0.1 * np.sin(t[-1] / 13),
                     truth={"bpm": float(bpm[-1]), "pulse_amp": float(amp[-1]),
                            "fidget": float(fid[-1]), "contact": bool(contact[-1])})

    def poll(self) -> Chunk:
        if self.t_start is None:
            self.start()
        due = int((time.monotonic() - self.t_start) * self.fs) - self.n
        return self.generate(due) if due > 0 else Chunk.empty()


# ---------------------------------------------------------------- replay / record

def load_recording(path: str | Path) -> dict:
    d = np.load(path, allow_pickle=False)
    rec = {k: d[k] for k in d.files}
    rec["meta"] = json.loads(str(rec.get("meta", "{}")))
    return rec


class ReplaySource:
    name = "replay"

    def __init__(self, path: str, speed: float = 1.0, loop: bool = True):
        self.rec = load_recording(path)
        self.meta = self.rec["meta"]
        self.speed, self.loop = speed, loop
        r = self.rec
        self.duration = float(max(r["accel_t"][-1], r["gyro_t"][-1] if len(r["gyro_t"]) else 0)) + 0.01
        self.pos = {"accel": 0, "gyro": 0, "lid": 0, "lux": 0}
        self.offset = 0.0           # added to times on each loop so time stays monotonic
        self.cursor = 0.0
        self.t_start = None
        self.done = False

    def start(self) -> None:
        self.t_start = time.monotonic()

    def stop(self) -> None:
        pass

    def _take(self, key: str, until: float):
        t = self.rec[f"{key}_t"]
        i0 = self.pos[key]
        i1 = int(np.searchsorted(t, until, side="right"))
        self.pos[key] = i1
        return t[i0:i1] + self.offset, self.rec[key][i0:i1]

    def advance(self, until: float) -> Chunk:
        """Return samples up to recording time `until` (relative to current loop)."""
        at, a = self._take("accel", until)
        gt, g = self._take("gyro", until)
        _, lid = self._take("lid", until)
        _, lux = self._take("lux", until)
        return Chunk(at, a.reshape(-1, 3), gt, g.reshape(-1, 3),
                     lid=float(lid[-1]) if len(lid) else None,
                     lux=float(lux[-1]) if len(lux) else None)

    def poll(self) -> Chunk:
        if self.t_start is None:
            self.start()
        if self.done:
            return Chunk.empty()
        target = (time.monotonic() - self.t_start) * self.speed - self.offset
        if target < self.duration:
            return self.advance(target)
        chunk = self.advance(self.duration)
        if self.loop:
            self.offset += self.duration
            self.pos = dict.fromkeys(self.pos, 0)
        else:
            self.done = True
        return chunk


class Recorder:
    """Accumulates raw chunks from any source; save() writes recordings/<name>.npz."""

    def __init__(self, name: str, true_bpm: float | None, notes: str = "", source: str = "real"):
        self.name, self.true_bpm, self.notes, self.source = name, true_bpm, notes, source
        self.parts = {k: [] for k in ("accel_t", "accel", "gyro_t", "gyro", "lid_t", "lid", "lux_t", "lux")}

    def add(self, c: Chunk) -> None:
        p = self.parts
        p["accel_t"].append(c.accel_t); p["accel"].append(c.accel)
        p["gyro_t"].append(c.gyro_t); p["gyro"].append(c.gyro)
        t = c.accel_t[-1] if len(c.accel_t) else None
        if t is not None and c.lid is not None:
            p["lid_t"].append([t]); p["lid"].append([c.lid])
        if t is not None and c.lux is not None:
            p["lux_t"].append([t]); p["lux"].append([c.lux])

    def seconds(self) -> float:
        ts = [x for x in self.parts["accel_t"] if len(x)]
        return float(ts[-1][-1]) if ts else 0.0

    def save(self, directory: str | Path = "recordings") -> Path:
        out = {}
        for k, v in self.parts.items():
            if k in ("accel", "gyro"):
                out[k] = np.concatenate(v).reshape(-1, 3) if v else np.zeros((0, 3))
            else:
                out[k] = np.concatenate([np.asarray(x, float) for x in v]) if v else np.zeros(0)
        meta = {"name": self.name, "true_bpm": self.true_bpm, "notes": self.notes,
                "source": self.source, "created": time.strftime("%Y-%m-%d %H:%M:%S"),
                "seconds": round(self.seconds(), 2)}
        for g in ("accel", "gyro"):
            t = out[f"{g}_t"]
            meta[f"fs_{g}"] = round((len(t) - 1) / (t[-1] - t[0]), 2) if len(t) > 1 and t[-1] > t[0] else None
        Path(directory).mkdir(parents=True, exist_ok=True)
        path = Path(directory) / f"{self.name}.npz"
        np.savez_compressed(path, meta=np.array(json.dumps(meta)), **out)
        return path
