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
    # 3-5 Hz accel separated fidget from stillness 4.2x vs 2.1x for 5-20 Hz (fidget_1);
    # gyro showed no separation at all, so it is left out.
    fidget_lo_hz: float = 3.0
    fidget_hi_hz: float = 5.0
    fidget_gyro: int = 0
    fidget_win_s: float = 1.0
    fidget_dead: float = 0.20          # log10 ratio dead-zone above baseline (still p95 ~0.02)
    fidget_span: float = 0.7           # log10 ratio over dead-zone that maps to fidget = 1
    baseline_win_s: float = 30.0       # auto baseline: rolling percentile window
    baseline_pct: float = 10.0

    # --- contact (wrists on / off): chassis tilt, see Pipeline._update_contact ---
    contact_mode: str = "auto"         # "auto" (tilt) | "always" (venue fallback)
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
