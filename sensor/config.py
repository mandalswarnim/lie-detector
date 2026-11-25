"""All tunable DSP parameters in one place.

Override from the command line with `--set key=value` (sensor and tools/tune.py).
Defaults marked GUESS must be re-tuned from real recordings (tools/tune.py).
"""
from __future__ import annotations

from dataclasses import dataclass, fields, replace


@dataclass(frozen=True)
class Config:
    fs_nominal: float = 100.0          # DSP rate; faster input is reduced to this
    imu_rate: int = 800                # rate we ask macimu for (800 = native, no dropping)
    decimate: str = "mean"             # "mean" (block average) | "drop" (macimu-style, for A/B)

    # --- heartbeat (BCG) ---
    pulse_lo_hz: float = 0.8
    pulse_hi_hz: float = 3.0
    pulse_order: int = 2
    acf_window_s: float = 8.0          # autocorrelation window (CLAUDE.md: 6-10 s)
    bpm_min: float = 40.0
    bpm_max: float = 160.0
    near_max_frac: float = 0.85        # pick the shortest lag whose ACF >= frac * global max
    channels: str = "accel,gyro"       # which groups feed the heartbeat estimate
    combine: str = "summary"           # "summary" (weighted mean ACF) | "best" (single best channel)
    est_hz: float = 5.0                # BPM estimates per second
    lock_on: float = 0.45              # conf needed to lock          (GUESS)
    lock_off: float = 0.30             # conf below this ...          (GUESS)
    lock_n: int = 5                    # ... consecutive estimates to lock
    unlock_n: int = 10                 # ... consecutive estimates to unlock (2 s at 5 Hz)
    lock_spread_bpm: float = 6.0       # BPM spread allowed across the lock_n estimates
    bpm_smooth: float = 0.3            # EMA weight of a new locked estimate
    motion_gate: float = 0.3           # fidget above this taints the ACF window for acf_window_s

    # --- fidget ---
    # Round 1 (100 Hz, drop-decimated): accel 3-5 Hz best, gyro useless.
    # Round 2 (800 Hz averaged, fidget800_1): small hand shift shows on gyro 0.3-3 Hz (2-4x still)
    # but barely on accel 3-5 (1.1-1.5x). Accel up to 10-20 Hz helps the big squirm but doubles
    # false fidget while still. fidget = max(accel 3-5 ratio, gyro 0.5-5 ratio):
    # small 0.48, big 0.77, still p95 0.11 (>0.3 in 1.5% of frames).
    fidget_lo_hz: float = 3.0          # accel band
    fidget_hi_hz: float = 5.0
    fidget_gyro: int = 1               # also use gyro (needs the 800 Hz averaged stream)
    fidget_gyro_lo_hz: float = 0.5
    fidget_gyro_hi_hz: float = 5.0
    fidget_win_s: float = 1.0
    fidget_dead: float = 0.22          # log10 ratio dead-zone above baseline
    fidget_span: float = 0.55          # log10 ratio over dead-zone that maps to fidget = 1
    baseline_win_s: float = 30.0       # auto baseline: rolling percentile window
    baseline_pct: float = 10.0

    # --- contact (wrists on / off): chassis tilt, see Pipeline._update_contact ---
    # onoff_1 (round 2) showed tilt is NOT a reliable wrists-on signal: normal pressure moved y by
    # <0.1 mg, one transition went +0.8 mg the "wrong" way, only heavy pressure gave -1.6 mg; body
    # shifts on the chair move it as much. Vibration energy is identical on/off. So the default is
    # "always" and the web state machine leaves IDLE on an operator key. "auto" stays for experiments.
    contact_mode: str = "always"       # "always" | "auto" (tilt, experimental)
    contact_axis: str = "y-"           # wrists push accel y more negative on the M4
    contact_on_mg: float = 1.0         # tilt to declare contact (measured: ~2 mg on, <0.4 mg jitter)
    contact_off_mg: float = 0.5        # ... and to release it
    contact_debounce_s: float = 0.5


def apply_overrides(cfg: Config, pairs: list[str] | None) -> Config:
    """Apply ["key=value", ...] overrides, casting to each field's type."""
    if not pairs:
        return cfg
    types = {f.name: f.type for f in fields(Config)}
    changes = {}
    for pair in pairs:
        key, _, raw = pair.partition("=")
        key = key.strip()
        if key not in types:
            raise SystemExit(f"unknown config key: {key!r} (known: {', '.join(types)})")
        t = types[key]
        changes[key] = int(raw) if t == "int" else float(raw) if t == "float" else raw
    return replace(cfg, **changes)
