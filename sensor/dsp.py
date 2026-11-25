"""Raw IMU samples -> one stream frame (the JSON contract in CLAUDE.md).

Every source (real, fake, replay) feeds this same pipeline, so replay and
tools/tune.py exercise exactly the code that runs on demo night.

Heartbeat: band-pass 0.8-3 Hz on all six axes (accel xyz + gyro xyz),
normalised autocorrelation over an ~8 s window per axis, combined into a
summary ACF weighted by each axis's periodicity. Lock / hold logic on top.
"""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field

import numpy as np
from scipy import signal

from .config import Config


# ---------------------------------------------------------------- helpers

class Ring:
    """Fixed-capacity ring buffer of shape (cap, k)."""

    def __init__(self, cap: int, k: int):
        self.buf = np.zeros((cap, k))
        self.cap, self.n, self.i = cap, 0, 0

    def extend(self, x: np.ndarray) -> None:
        x = x[-self.cap:]
        m = len(x)
        end = self.i + m
        if end <= self.cap:
            self.buf[self.i:end] = x
        else:
            first = self.cap - self.i
            self.buf[self.i:] = x[:first]
            self.buf[: m - first] = x[first:]
        self.i = end % self.cap
        self.n = min(self.cap, self.n + m)

    def last(self, m: int) -> np.ndarray:
        m = min(m, self.n)
        if m == 0:
            return self.buf[:0]
        idx = (self.i - m + np.arange(m)) % self.cap
        return self.buf[idx]

    def clear(self) -> None:
        self.n, self.i = 0, 0


class StreamFilter:
    """Stateful SOS filter over (n, ch) chunks."""

    def __init__(self, sos: np.ndarray, nch: int):
        self.sos, self.nch, self.zi = sos, nch, None

    def __call__(self, x: np.ndarray) -> np.ndarray:
        if len(x) == 0:
            return x
        if self.zi is None:
            self.zi = signal.sosfilt_zi(self.sos)[:, :, None] * x[0][None, None, :]
        y, self.zi = signal.sosfilt(self.sos, x, axis=0, zi=self.zi)
        return y


def bandpass(lo: float, hi: float, fs: float, order: int = 2) -> np.ndarray:
    hi = min(hi, 0.45 * fs)
    return signal.butter(order, [lo, hi], btype="band", fs=fs, output="sos")


def norm_acf(x: np.ndarray, max_lag: int) -> np.ndarray:
    """Unbiased, lag-0-normalised autocorrelation for lags 0..max_lag."""
    n = len(x)
    x = x - x.mean()
    nfft = 1 << (2 * n - 1).bit_length()
    f = np.fft.rfft(x, nfft)
    r = np.fft.irfft(f * np.conj(f), nfft)[: max_lag + 1]
    if r[0] <= 1e-30:
        return np.zeros(max_lag + 1)
    r = r / (n - np.arange(max_lag + 1))   # unbiased
    return r / r[0]


# ---------------------------------------------------------------- per-group state

@dataclass
class Group:
    """One 3-axis sensor (accel or gyro) and its filter chains.

    Input may arrive faster than cfg.fs_nominal (e.g. 800 Hz native); it is
    block-averaged down by an integer factor first. Averaging (not dropping)
    keeps the out-of-band sensor noise from aliasing into our bands.
    """
    name: str
    fs_in: float
    cfg: Config
    t: Ring = field(init=False)
    pulse: Ring = field(init=False)
    fid: Ring = field(init=False)
    con: Ring = field(init=False)

    def __post_init__(self):
        c = self.cfg
        self.k = max(1, int(round(self.fs_in / c.fs_nominal)))
        self.fs = fs = self.fs_in / self.k
        self._carry_t = np.zeros(0)
        self._carry_x = np.zeros((0, 3))
        cap = int(fs * max(12.0, c.acf_window_s + 2))
        self.t = Ring(cap, 1)
        self.pulse = Ring(cap, 3)
        self.fid = Ring(int(fs * c.fidget_win_s), 1)
        self.con = Ring(int(fs * 1.0), 1)
        self.dc = Ring(int(fs * 1.0), 3)          # raw (gravity incl.) for tilt-based contact
        self.f_pulse = StreamFilter(bandpass(c.pulse_lo_hz, c.pulse_hi_hz, fs, c.pulse_order), 3)
        lo, hi = ((c.fidget_gyro_lo_hz, c.fidget_gyro_hi_hz) if self.name == "gyro"
                  else (c.fidget_lo_hz, c.fidget_hi_hz))
        self.f_fid = StreamFilter(bandpass(lo, hi, fs), 3)
        self.f_con = StreamFilter(bandpass(1.0, 20.0, fs), 3)   # broadband level, debug only
        self.samples = 0

    def _decimate(self, t: np.ndarray, xyz: np.ndarray):
        if self.k == 1:
            return t, xyz
        t = np.concatenate([self._carry_t, t])
        xyz = np.concatenate([self._carry_x, xyz])
        m = len(t) // self.k * self.k
        self._carry_t, self._carry_x = t[m:], xyz[m:]
        if self.cfg.decimate == "drop":          # what macimu's own decimation does (A/B only)
            return t[self.k - 1:m:self.k], xyz[self.k - 1:m:self.k]
        return t[:m].reshape(-1, self.k).mean(1), xyz[:m].reshape(-1, self.k, 3).mean(1)

    def push(self, t: np.ndarray, xyz: np.ndarray) -> None:
        if len(t) == 0:
            return
        t, xyz = self._decimate(t, xyz)
        if len(t) == 0:
            return
        self.samples += len(t)
        self.t.extend(t[:, None])
        self.dc.extend(xyz)
        self.pulse.extend(self.f_pulse(xyz))
        self.fid.extend(np.sum(self.f_fid(xyz) ** 2, axis=1, keepdims=True))
        self.con.extend(np.sum(self.f_con(xyz) ** 2, axis=1, keepdims=True))

    def rms(self, ring: Ring) -> float:
        v = ring.last(ring.cap)
        return float(np.sqrt(v.mean())) if len(v) else 0.0

    def fs_measured(self, seconds: float) -> float:
        t = self.t.last(int(self.fs * seconds))[:, 0]
        if len(t) < 20 or t[-1] <= t[0]:
            return self.fs
        return (len(t) - 1) / (t[-1] - t[0])


# ---------------------------------------------------------------- pipeline

class Pipeline:
    def __init__(self, cfg: Config, fs_accel: float | None = None, fs_gyro: float | None = None):
        self.cfg = cfg
        self.accel = Group("accel", fs_accel or cfg.fs_nominal, cfg)
        self.gyro = Group("gyro", fs_gyro or cfg.fs_nominal, cfg)
        self.lid: float | None = None
        self.lux: float | None = None
        self.reset()

    # ---- session state (R key / new volunteer)
    def reset(self) -> None:
        c = self.cfg
        self.contact = c.contact_mode == "always"
        self.tilt_ref: float | None = None
        self.tilt = 0.0
        self._contact_pending_since: float | None = None
        self.contact_since = 0.0
        self.base_hist = {g: deque(maxlen=int(c.baseline_win_s * 30)) for g in ("accel", "gyro")}
        self.base_fixed: dict[str, float] | None = None
        self.calib_until: float | None = None
        self.calib_vals: dict[str, list[float]] = {"accel": [], "gyro": []}
        self.fidget = 0.0
        self.last_motion_t = -1e9
        self.conf = 0.0
        self.locked = False
        self.bpm: float | None = None
        self.hist: deque = deque(maxlen=max(self.cfg.lock_n, 2))
        self.low_count = 0
        self.disagree = 0
        self.best_ch = 0
        self.ch_scores = np.zeros(6)
        self.raw_bpm: float | None = None
        self.first_lock_t: float | None = None
        self._last_est_t = -1e9
        self._pulse_scale = 1e-9

    def start_calibration(self, now: float, seconds: float) -> None:
        self.calib_until = now + seconds
        self.calib_vals = {"accel": [], "gyro": []}

    # ---- input
    def push(self, accel_t, accel, gyro_t, gyro, lid=None, lux=None) -> None:
        self.accel.push(np.asarray(accel_t, float), np.asarray(accel, float).reshape(-1, 3))
        self.gyro.push(np.asarray(gyro_t, float), np.asarray(gyro, float).reshape(-1, 3))
        if lid is not None:
            self.lid = lid
        if lux is not None:
            self.lux = lux

    # ---- output (call at frame rate, ~30 Hz)
    def frame(self, now: float) -> dict:
        c = self.cfg
        self._update_contact(now)
        self._update_fidget(now)
        if now - self._last_est_t >= 1.0 / c.est_hz - 1e-6:
            self._last_est_t = now
            self._estimate_bpm(now)
        return {
            "t": round(now, 3),
            "pulse_wave": round(self._pulse_wave(), 4),
            "bpm": None if self.bpm is None else round(self.bpm, 1),
            "bpm_conf": round(self.conf, 3),
            "bpm_locked": self.locked,
            "bpm_held": (not self.locked) and self.bpm is not None,
            "fidget": round(self.fidget, 3),
            "contact": self.contact,
            "lid": None if self.lid is None else round(self.lid, 1),
            "lux": None if self.lux is None else round(self.lux, 2),
            "dbg": {
                "raw_bpm": None if self.raw_bpm is None else round(self.raw_bpm, 1),
                "best_ch": ["ax", "ay", "az", "gx", "gy", "gz"][self.best_ch],
                "ch_scores": [round(float(s), 2) for s in self.ch_scores],
                "tilt_mg": round(self.tilt, 2),
                "contact_rms": float(f"{self.accel.rms(self.accel.con):.3g}"),
                "fid_rms": [float(f"{self.accel.rms(self.accel.fid):.3g}"),
                            float(f"{self.gyro.rms(self.gyro.fid):.3g}")],
                "base": [float(f"{b:.3g}") for b in self._baseline()],
                "calibrating": self.calib_until is not None,
                "fs": [round(self.accel.fs_measured(5), 1), round(self.gyro.fs_measured(5), 1)],
            },
        }

    # ---- contact
    def _update_contact(self, now: float) -> None:
        """Wrists on the palm rest tip the chassis: accel DC moves ~2 mg along
        the contact axis (measured on the M4: -3.2 mg empty vs -5.0..-5.7 mg
        with wrists). Vibration energy can't tell on from off (it is sensor
        noise either way), so contact is tilt relative to an empty reference."""
        c = self.cfg
        dc = self.accel.dc.last(self.accel.dc.cap)
        if len(dc) < 0.5 * self.accel.dc.cap:
            return
        axis = "xyz".index(c.contact_axis[0])
        sign = -1.0 if c.contact_axis.endswith("-") else 1.0
        v = float(dc[:, axis].mean())
        half = len(dc) // 2
        # only (re)take a reference from a settled window, never mid-transition
        steady = abs(dc[half:, axis].mean() - dc[:half, axis].mean()) * 1000.0 < 0.3
        if self.tilt_ref is None:
            if not steady:
                return
            self.tilt_ref = v                     # assume empty at start / after reset
        self.tilt = sign * (v - self.tilt_ref) * 1000.0     # mg, positive = wrists pressing
        if self.tilt < -c.contact_on_mg and steady:
            # reference was taken with wrists already on; they just lifted
            self.tilt_ref, self.tilt = v, 0.0
        if not self.contact and abs(self.tilt) < c.contact_off_mg:
            self.tilt_ref += 0.002 * (v - self.tilt_ref)    # follow slow drift while empty
        if c.contact_mode == "always":
            self.contact = True
            return
        want = self.tilt > (c.contact_off_mg if self.contact else c.contact_on_mg)
        if want == self.contact:
            self._contact_pending_since = None
            return
        if self._contact_pending_since is None:
            self._contact_pending_since = now
        elif now - self._contact_pending_since >= c.contact_debounce_s:
            self.contact = want
            self._contact_pending_since = None
            if want:
                self.contact_since = now

    # ---- fidget
    def _baseline(self) -> list[float]:
        if self.base_fixed:
            return [self.base_fixed["accel"], self.base_fixed["gyro"]]
        out = []
        for g in ("accel", "gyro"):
            h = self.base_hist[g]
            # ~2 s of history before trusting it: a tiny early baseline makes everything look like fidget
            out.append(float(np.percentile(h, self.cfg.baseline_pct)) if len(h) >= 60 else 0.0)
        return out

    def _update_fidget(self, now: float) -> None:
        c = self.cfg
        ra, rg = self.accel.rms(self.accel.fid), self.gyro.rms(self.gyro.fid)
        warm = self.accel.fid.n >= self.accel.fid.cap and self.gyro.fid.n >= self.gyro.fid.cap     # 1 s window full; earlier RMS reads low
        if self.contact and warm:
            self.base_hist["accel"].append(ra)
            self.base_hist["gyro"].append(rg)
        if self.calib_until is not None:
            self.calib_vals["accel"].append(ra)
            self.calib_vals["gyro"].append(rg)
            if now >= self.calib_until:
                if len(self.calib_vals["accel"]) >= 10:
                    self.base_fixed = {g: float(np.median(v)) for g, v in self.calib_vals.items()}
                self.calib_until = None
        ba, bg = self._baseline()
        if not self.contact or ba <= 0:
            target = 0.0
        else:
            ratio = ra / max(ba, 1e-12)
            if c.fidget_gyro and bg > 0:     # gyro catches slow hand shifts at 800 Hz
                ratio = max(ratio, rg / bg)
            lr = np.log10(max(ratio, 1e-9))
            target = float(np.clip((lr - c.fidget_dead) / c.fidget_span, 0.0, 1.0))
        # fast attack, slower release so bursts read clearly on the pen
        k = 0.6 if target > self.fidget else 0.15
        self.fidget += k * (target - self.fidget)
        if self.fidget > c.motion_gate:
            self.last_motion_t = now

    # ---- heartbeat
    def _channel_acfs(self):
        """Per-axis normalised ACFs resampled to a common lag grid (seconds)."""
        c = self.cfg
        lag_s = np.arange(60.0 / c.bpm_max * 0.5, 60.0 / c.bpm_min + 1e-9, 0.005)
        acfs = []
        for gname in ("accel", "gyro"):
            g = getattr(self, gname)
            n = int(g.fs * c.acf_window_s)
            x = g.pulse.last(n)
            use = gname in c.channels
            if len(x) < 0.75 * n or not use:
                acfs.extend([np.zeros_like(lag_s)] * 3)
                continue
            fs = g.fs_measured(c.acf_window_s)
            max_lag = int(np.ceil(lag_s[-1] * fs)) + 1
            lags = np.arange(max_lag + 1) / fs
            for k in range(3):
                acfs.append(np.interp(lag_s, lags, norm_acf(x[:, k], max_lag)))
        return lag_s, np.array(acfs)

    def _pick_period(self, lag_s: np.ndarray, acf: np.ndarray):
        """Shortest local max in the BPM range whose height is near the global max."""
        c = self.cfg
        lo, hi = 60.0 / c.bpm_max, 60.0 / c.bpm_min
        m = (lag_s >= lo) & (lag_s <= hi)
        idx = np.where(m)[0]
        if len(idx) < 3:
            return None, 0.0
        a = acf[idx]
        peaks = [i for i in range(1, len(a) - 1) if a[i] >= a[i - 1] and a[i] >= a[i + 1]]
        if not peaks:
            return None, 0.0
        top = max(a[i] for i in peaks)
        if top <= 0:
            return None, 0.0
        i = next(i for i in peaks if a[i] >= c.near_max_frac * top)
        # parabolic interpolation
        y0, y1, y2 = a[i - 1], a[i], a[i + 1]
        den = y0 - 2 * y1 + y2
        off = 0.5 * (y0 - y2) / den if abs(den) > 1e-12 else 0.0
        step = lag_s[1] - lag_s[0]
        lag = lag_s[idx[i]] + off * step
        return lag, float(np.clip(y1, 0.0, 1.0))

    def _estimate_bpm(self, now: float) -> None:
        c = self.cfg
        if not self.contact:
            self._miss()
            return
        lag_s, acfs = self._channel_acfs()
        if not acfs.any():
            self._miss()
            return
        scores = np.array([self._pick_period(lag_s, a)[1] for a in acfs])
        self.ch_scores = scores
        best = int(np.argmax(scores))
        if scores[best] > scores[self.best_ch] + 0.1:     # hysteresis for the drawn trace
            self.best_ch = best
        if c.combine == "best":
            summary = acfs[best]
        else:
            # only axes that actually look periodic; pure-noise axes still score ~0.3
            w = np.where(scores >= 0.6 * scores[best], np.clip(scores, 0, None) ** 2, 0.0)
            summary = (w[:, None] * acfs).sum(0) / w.sum() if w.sum() > 0 else acfs[best]
        lag, conf = self._pick_period(lag_s, summary)
        if lag is None:
            self._miss()
            return
        if now - self.last_motion_t < c.acf_window_s:
            conf *= 0.3              # motion inside the ACF window: periodic-looking artifact
        est = 60.0 / lag
        self.raw_bpm = est
        self.conf = 0.5 * self.conf + 0.5 * conf
        self.hist.append((est, conf))

        if not self.locked:
            recent = list(self.hist)[-c.lock_n:]
            if (len(recent) == c.lock_n and all(cf >= c.lock_on for _, cf in recent)
                    and max(b for b, _ in recent) - min(b for b, _ in recent) <= c.lock_spread_bpm):
                self.locked = True
                self.low_count = 0
                self.bpm = float(np.median([b for b, _ in recent]))
                if self.first_lock_t is None:
                    self.first_lock_t = now
        else:
            if conf < c.lock_off:
                self.low_count += 1
                if self.low_count >= c.unlock_n:
                    self.locked = False
            else:
                self.low_count = 0
                if abs(est - self.bpm) <= 15:              # reject wild jumps, keep the lock
                    self.bpm += c.bpm_smooth * (est - self.bpm)
                    self.disagree = 0
                elif conf >= c.lock_on:
                    # confident and consistently elsewhere (e.g. we locked on a
                    # double period): re-lock instead of staying stuck forever
                    self.disagree += 1
                    recent = [b for b, _ in list(self.hist)[-c.lock_n:]]
                    if (self.disagree >= c.lock_n
                            and max(recent) - min(recent) <= c.lock_spread_bpm):
                        self.bpm = float(np.median(recent))
                        self.disagree = 0

    def _miss(self) -> None:
        self.conf *= 0.7
        self.hist.clear()
        if self.locked:
            self.low_count += 1
            if self.low_count >= self.cfg.unlock_n or not self.contact:
                self.locked = False

    def _pulse_wave(self) -> float:
        g, k = (self.accel, self.best_ch) if self.best_ch < 3 else (self.gyro, self.best_ch - 3)
        x = g.pulse.last(int(g.fs * 4))
        if len(x) < 10:
            return 0.0
        sd = float(np.std(x[:, k]))
        self._pulse_scale += 0.05 * (sd - self._pulse_scale)
        v = x[-1, k] / max(self._pulse_scale * 2.5, 1e-12)
        return float(np.clip(v, -1.0, 1.0))
