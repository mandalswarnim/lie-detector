"""Offline heartbeat / fidget / contact tuning against labelled recordings. No sudo.

  .venv/bin/python tools/tune.py recordings/*.npz                 report with current config
  .venv/bin/python tools/tune.py recordings/*.npz --spectrum      + per-axis spectra and peaks
  .venv/bin/python tools/tune.py recordings/*.npz --sweep         + grid search, best configs first
  .venv/bin/python tools/tune.py recordings/*.npz --set acf_window_s=6
  .venv/bin/python tools/tune.py --make-fake 4                    write synthetic test recordings to tools/out/

Runs exactly the sensor's Pipeline, fed in 1/30 s ticks as the live server does.
"""
from __future__ import annotations

import argparse
import itertools
import json
import sys
from dataclasses import replace
from pathlib import Path

import numpy as np
from scipy import signal

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from sensor.config import Config, apply_overrides          # noqa: E402
from sensor.dsp import Pipeline                             # noqa: E402
from sensor.sources import FakeSource, load_recording       # noqa: E402

TICK = 1.0 / 30.0


# ---------------------------------------------------------------- simulate

def simulate(rec: dict, cfg: Config) -> dict:
    meta = rec["meta"]
    p = Pipeline(cfg, meta.get("fs_accel"), meta.get("fs_gyro"))
    at, a, gt, g = rec["accel_t"], rec["accel"], rec["gyro_t"], rec["gyro"]
    lid_t, lid = rec.get("lid_t", np.zeros(0)), rec.get("lid", np.zeros(0))
    end = float(at[-1])
    ia = ig = il = 0
    rows = []
    t = TICK
    while t <= end:
        ja, jg = np.searchsorted(at, t, "right"), np.searchsorted(gt, t, "right")
        jl = np.searchsorted(lid_t, t, "right")
        p.push(at[ia:ja], a[ia:ja], gt[ig:jg], g[ig:jg], float(lid[jl - 1]) if jl > il else None)
        ia, ig, il = ja, jg, jl
        f = p.frame(float(at[ja - 1]) if ja else t)
        rows.append((t, f["bpm"], f["bpm_conf"], f["bpm_locked"], f["fidget"], f["contact"],
                     f["dbg"]["tilt_mg"], f["dbg"]["raw_bpm"], f["dbg"]["best_ch"]))
        t += TICK
    return {"rows": rows, "first_lock": p.first_lock_t}


def truth_at(rec: dict, t: np.ndarray) -> np.ndarray | None:
    if "truth_bpm" in rec:
        return np.interp(t, rec["accel_t"], rec["truth_bpm"])
    tb = rec["meta"].get("true_bpm")
    return None if tb in (None, 0) else np.full(len(t), float(tb))


def score(rec: dict, sim: dict) -> dict:
    rows = sim["rows"]
    t = np.array([r[0] for r in rows])
    locked = np.array([r[3] for r in rows])
    bpm = np.array([np.nan if r[1] is None else r[1] for r in rows])
    fid = np.array([r[4] for r in rows])
    contact = np.array([r[5] for r in rows])
    truth = truth_at(rec, t)
    out = {"dur": float(t[-1]), "first_lock": sim["first_lock"],
           "locked_frac": float(locked.mean()),
           "contact_frac": float(contact.mean()), "fidget_p50": float(np.median(fid)),
           "fidget_p95": float(np.percentile(fid, 95))}
    if truth is not None and locked.any():
        err = np.abs(bpm[locked] - truth[locked])
        out.update(err_med=float(np.median(err)), err_p90=float(np.percentile(err, 90)),
                   wrong_lock=float((err > 10).mean()))
        shown = ~np.isnan(bpm)                      # what the audience sees (locked or held)
        out["shown_err_med"] = float(np.median(np.abs(bpm[shown] - truth[shown])))
    return out


# ---------------------------------------------------------------- reports

def fmt(v, spec=".1f", none="  -"):
    return none if v is None or (isinstance(v, float) and np.isnan(v)) else format(v, spec)


def report(paths: list[Path], cfg: Config) -> list[dict]:
    print(f"\n{'recording':22} {'dur':>5} {'true':>5} {'lock@':>6} {'locked':>7} {'errMed':>6} "
          f"{'errP90':>6} {'wrong':>6} {'contact':>7} {'fidP95':>6}")
    results = []
    for path in paths:
        rec = load_recording(path)
        # labelled sessions start with wrists already on, so the tilt reference can't
        # see "empty": score the heartbeat with contact forced on
        c = replace(cfg, contact_mode="always") if rec["meta"].get("true_bpm") else cfg
        s = score(rec, simulate(rec, c))
        tb = rec["meta"].get("true_bpm")
        print(f"{path.stem[:22]:22} {s['dur']:5.0f} {fmt(tb, '.0f'):>5} {fmt(s['first_lock']):>6} "
              f"{s['locked_frac']:7.0%} {fmt(s.get('err_med')):>6} {fmt(s.get('err_p90')):>6} "
              f"{fmt(s.get('wrong_lock'), '.0%'):>6} {s['contact_frac']:7.0%} {s['fidget_p95']:6.2f}")
        results.append({"name": path.stem, "true_bpm": tb, **s})
    lab = [r for r in results if r["true_bpm"]]
    if lab:
        locks = [r["first_lock"] for r in lab]
        n_ok = sum(1 for x in locks if x is not None and x <= 15)
        errs = [r["err_med"] for r in lab if "err_med" in r]
        print(f"\nlabelled: {len(lab)}  locked within 15 s: {n_ok}/{len(lab)}  "
              f"median BPM error (when locked): {fmt(float(np.median(errs)) if errs else None)}  "
              f"[targets: most <=15 s, error <=5]")
    return results


def spectrum(paths: list[Path]) -> None:
    """Welch spectra per axis; lists the strongest narrow peaks so we only notch what's real."""
    names = ["ax", "ay", "az", "gx", "gy", "gz"]
    for path in paths:
        rec = load_recording(path)
        fs = rec["meta"].get("fs_accel") or 100.0
        data = np.hstack([rec["accel"], rec["gyro"][: len(rec["accel"])]]) if len(rec["gyro"]) >= len(rec["accel"]) \
            else np.hstack([rec["accel"][: len(rec["gyro"])], rec["gyro"]])
        print(f"\n== {path.stem}  fs={fs:.1f} Hz  n={len(data)}  true_bpm={rec['meta'].get('true_bpm')}")
        print(f"   {'axis':4} {'rms 0.8-3':>10} {'rms 5-20':>10} {'rms 20+':>10}   top peaks (Hz @ dB above median)")
        for k, nm in enumerate(names):
            x = signal.detrend(data[:, k])
            f, pxx = signal.welch(x, fs=fs, nperseg=min(len(x), int(fs * 16)))
            band = lambda lo, hi: np.sqrt(np.trapezoid(pxx[(f >= lo) & (f < hi)], f[(f >= lo) & (f < hi)]))
            db = 10 * np.log10(pxx + 1e-30)
            prom = db - signal.medfilt(db, 31)
            pk, _ = signal.find_peaks(prom, height=6, distance=3)
            pk = pk[(f[pk] >= 0.5)]
            top = sorted(pk, key=lambda i: -prom[i])[:6]
            peaks = "  ".join(f"{f[i]:.2f}@{prom[i]:.0f}" for i in sorted(top))
            print(f"   {nm:4} {band(0.8, 3):10.3g} {band(5, 20):10.3g} {band(20, fs / 2):10.3g}   {peaks}")
        tb = rec["meta"].get("true_bpm")
        if tb:
            print(f"   (heartbeat fundamental expected at {tb / 60:.2f} Hz)")


def levels(paths: list[Path], cfg: Config) -> None:
    """Contact = chassis tilt. Absolute accel DC per recording (compare wrists-off vs on),
    plus the live tilt metric / contact state over time (meaningful when a recording
    starts with wrists OFF, e.g. an on/off alternation session)."""
    ax = "xyz".index(cfg.contact_axis[0])
    print(f"\n{'recording':22} accel DC mean x/y/z (mg)          tilt timeline, mg per 2 s (* = contact)")
    for path in paths:
        rec = load_recording(path)
        dc = rec["accel"].mean(0) * 1000
        sim = simulate(rec, cfg)
        rows = sim["rows"]
        tl = []
        for i in range(0, len(rows), 60):
            r = rows[i:i + 60]
            tl.append(f"{np.mean([x[6] for x in r]):+.1f}{'*' if np.mean([x[5] for x in r]) > 0.5 else ' '}")
        print(f"{path.stem[:22]:22} {dc[0]:+8.2f} {dc[1]:+8.2f} {dc[2]:+9.2f}   " + " ".join(tl))
    print(f"contact: axis {cfg.contact_axis}, on > {cfg.contact_on_mg} mg, off < {cfg.contact_off_mg} mg"
          f"  (wrists add ~2 mg on {'xyz'[ax]} on the M4)")


def sweep(paths: list[Path], cfg: Config) -> None:
    grid = {
        "acf_window_s": [6.0, 8.0, 10.0],
        "lock_on": [0.35, 0.45, 0.55],
        "combine": ["summary", "best"],
        "channels": ["accel,gyro", "accel", "gyro"],
    }
    recs = [(p, load_recording(p)) for p in paths]
    recs = [(p, r) for p, r in recs if truth_at(r, np.zeros(1)) is not None]
    if not recs:
        print("sweep needs recordings with --true-bpm labels")
        return
    out = []
    keys = list(grid)
    for vals in itertools.product(*grid.values()):
        c = replace(cfg, **dict(zip(keys, vals)), lock_off=min(cfg.lock_off, vals[1] - 0.1),
                    contact_mode="always")
        ss = [score(r, simulate(r, c)) for _, r in recs]
        lock = [s["first_lock"] if s["first_lock"] is not None else 60.0 for s in ss]
        err = [s.get("err_med", 30.0) for s in ss]
        wrong = [s.get("wrong_lock", 1.0) for s in ss]
        # cost: error dominates, then wrong locks, then lock time
        cost = np.mean(err) + 20 * np.mean(wrong) + 0.2 * np.mean(lock)
        out.append((cost, dict(zip(keys, vals)), np.mean(lock), np.mean(err), np.mean(wrong)))
        print(".", end="", flush=True)
    out.sort(key=lambda x: x[0])
    print(f"\n\n{'cost':>6} {'lock@':>6} {'err':>5} {'wrong':>6}  config")
    for cost, kv, lk, er, wr in out[:10]:
        print(f"{cost:6.1f} {lk:6.1f} {er:5.1f} {wr:6.0%}  " + " ".join(f"--set {k}={v}" for k, v in kv.items()))


# ---------------------------------------------------------------- synthetic test data

def make_fake(n: int, seconds: float = 60.0) -> list[Path]:
    """Synthetic labelled recordings (with per-sample truth) to test this tool itself."""
    outdir = ROOT / "tools" / "out"
    outdir.mkdir(parents=True, exist_ok=True)
    paths = []
    for i in range(n):
        src = FakeSource(seed=100 + i, realtime=False)
        src.n = int((i * 37 % 120) * src.fs)          # start each at a different point of the loop
        chunks = [src.generate(int(src.fs)) for _ in range(int(seconds))]
        t = np.concatenate([c.accel_t for c in chunks])
        t0 = t[0]
        truth = src.bpm_at(t)
        meta = {"name": f"fake_{i}", "true_bpm": float(np.mean(truth)), "source": "fake",
                "notes": "synthetic", "fs_accel": src.fs, "fs_gyro": src.fs, "seconds": seconds}
        path = outdir / f"fake_{i}.npz"
        np.savez_compressed(
            path, meta=np.array(json.dumps(meta)),
            accel_t=t - t0, accel=np.concatenate([c.accel for c in chunks]),
            gyro_t=t - t0, gyro=np.concatenate([c.gyro for c in chunks]),
            lid_t=np.zeros(0), lid=np.zeros(0), lux_t=np.zeros(0), lux=np.zeros(0), truth_bpm=truth)
        paths.append(path)
        print(f"wrote {path.relative_to(ROOT)}")
    return paths


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("recordings", nargs="*", type=Path)
    ap.add_argument("--set", action="append", metavar="KEY=VALUE")
    ap.add_argument("--spectrum", action="store_true")
    ap.add_argument("--levels", action="store_true", help="accel DC + tilt/contact timeline per recording")
    ap.add_argument("--sweep", action="store_true")
    ap.add_argument("--make-fake", type=int, metavar="N")
    a = ap.parse_args()
    cfg = apply_overrides(Config(), a.set)

    paths = list(a.recordings)
    if a.make_fake:
        paths += make_fake(a.make_fake)
    if not paths:
        ap.error("give recordings/*.npz (or --make-fake N)")
    if a.spectrum:
        spectrum(paths)
    if a.levels:
        levels(paths, cfg)
    report(paths, cfg)
    if a.sweep:
        sweep(paths, cfg)


if __name__ == "__main__":
    main()
