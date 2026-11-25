"""Rank hand positions by how well the heartbeat comes through. No sudo.

  .venv/bin/python tools/compare_positions.py recordings/pos_*.npz recordings/still800_*.npz

For each labelled recording:
  peak dB    over the whole recording (Welch, 16 s segments), the strongest axis's power within
             +-4 BPM of the watch rate, in dB above the median of the 0.7-3 Hz band.
             ~0-2 dB = nothing, 3-5 dB = faint (the palm rest so far), 6+ dB = usable.
  hit%       live estimator: share of estimates within +-5 BPM of the watch (chance ~8%).
  conf       median confidence of the estimates that were right / wrong. Usable means right
             estimates are clearly more confident than wrong ones.
  lock@      first lock time with the current thresholds, and whether the lock was right.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from scipy import signal

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from sensor.config import Config, apply_overrides  # noqa: E402
from sensor.sources import load_recording  # noqa: E402
from tune import simulate  # noqa: E402

AXES = ["ax", "ay", "az", "gx", "gy", "gz"]


def block_mean(x: np.ndarray, k: int) -> np.ndarray:
    m = len(x) // k * k
    return x[:m].reshape(-1, k, x.shape[1]).mean(1)


def spectral(rec: dict, true_bpm: float) -> tuple[str, float, float]:
    fs_in = rec["meta"]["fs_accel"]
    n = min(len(rec["accel"]), len(rec["gyro"]))
    x = np.hstack([rec["accel"][:n], rec["gyro"][:n]])
    k = max(1, round(fs_in / 100))
    x, fs = block_mean(x, k), fs_in / k
    x = x[int(3 * fs):]                                  # skip settling
    f, p = signal.welch(x - x.mean(0), fs=fs, nperseg=min(len(x), int(16 * fs)), axis=0)
    band = (f >= 0.7) & (f <= 3.0)
    near = np.abs(f - true_bpm / 60) <= 4 / 60
    best = ("--", -99.0, 0.0)
    for i, name in enumerate(AXES):
        med = np.median(p[band, i])
        db = 10 * np.log10(p[near, i].max() / med)
        peak_bpm = f[band][np.argmax(p[band, i])] * 60
        if db > best[1]:
            best = (name, db, peak_bpm)
    return best


def live(rec: dict, true_bpm: float) -> dict:
    sim = simulate(rec, apply_overrides(Config(), ["contact_mode=always"]))
    rows = [r for r in sim["rows"] if r[0] > 9 and r[7] is not None]
    raw = np.array([r[7] for r in rows])
    conf = np.array([r[2] for r in rows])
    ok = np.abs(raw - true_bpm) <= 5
    lock_bpm = next((r[1] for r in sim["rows"] if r[3]), None)
    return {
        "hit": ok.mean() if len(ok) else 0.0,
        "c_ok": float(np.median(conf[ok])) if ok.any() else 0.0,
        "c_bad": float(np.median(conf[~ok])) if (~ok).any() else 0.0,
        "lock_t": sim["first_lock"],
        "lock_ok": None if lock_bpm is None else abs(lock_bpm - true_bpm) <= 5,
    }


def main() -> None:
    paths = [p for p in sys.argv[1:] if p.endswith(".npz")]
    if not paths:
        print(__doc__)
        return
    out = []
    for p in paths:
        rec = load_recording(p)
        tb = rec["meta"].get("true_bpm")
        if not tb:
            print(f"skip {p}: no true_bpm label")
            continue
        ax, db, peak = spectral(rec, tb)
        lv = live(rec, tb)
        out.append((Path(p).stem, tb, ax, db, peak, lv))
    out.sort(key=lambda r: (r[5]["hit"], r[3]), reverse=True)
    print(f"{'position':14s} {'watch':>5s}  {'peak dB':>7s} {'axis':4s} {'top':>4s}   {'hit%':>4s}  "
          f"{'conf ok/bad':>11s}  lock@")
    for name, tb, ax, db, peak, lv in out:
        lock = "-" if lv["lock_t"] is None else f"{lv['lock_t']:.0f}s {'right' if lv['lock_ok'] else 'WRONG'}"
        print(f"{name:14s} {tb:5.0f}  {db:+7.1f} {ax:4s} {peak:4.0f}   {lv['hit']:4.0%}  "
              f"{lv['c_ok']:.2f}/{lv['c_bad']:.2f}    {lock}")
    print("\nUsable position: peak >= 6 dB, hit% >= 50%, and conf ok clearly above conf bad.")


if __name__ == "__main__":
    main()
