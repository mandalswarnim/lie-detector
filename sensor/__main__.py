"""MacBook Lie Detector sensor stream.

  sudo .venv/bin/python -m sensor                         real IMU
  .venv/bin/python -m sensor --fake                       synthetic, no sudo
  .venv/bin/python -m sensor --replay recordings/x.npz    replay at real speed
  sudo .venv/bin/python -m sensor --record name --true-bpm 72 [--seconds 60]
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys

from .config import Config, apply_overrides
from .dsp import Pipeline
from .server import Server
from .sources import FakeSource, Recorder, RealSource, ReplaySource


def main() -> None:
    p = argparse.ArgumentParser(prog="python -m sensor", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    src = p.add_mutually_exclusive_group()
    src.add_argument("--fake", action="store_true", help="synthetic signal, no sudo needed")
    src.add_argument("--replay", metavar="NPZ", help="replay a recording at real speed")
    p.add_argument("--speed", type=float, default=1.0, help="replay speed multiplier")
    p.add_argument("--no-loop", action="store_true", help="stop when the replay ends")
    p.add_argument("--record", metavar="NAME", help="save raw samples to recordings/NAME.npz")
    p.add_argument("--true-bpm", type=float, help="true BPM label for --record (count your pulse)")
    p.add_argument("--notes", default="", help="free-text notes stored in the recording")
    p.add_argument("--seconds", type=float, help="stop after this many seconds")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--set", action="append", metavar="KEY=VALUE", help="override a Config value")
    p.add_argument("--quiet", action="store_true")
    a = p.parse_args()

    cfg = apply_overrides(Config(), a.set)
    if a.fake:
        source = FakeSource(fs=cfg.fs_nominal)
    elif a.replay:
        source = ReplaySource(a.replay, speed=a.speed, loop=not a.no_loop)
    else:
        if os.geteuid() != 0:
            sys.exit("Real IMU needs root:  sudo .venv/bin/python -m sensor\n"
                     "(or run without hardware:  .venv/bin/python -m sensor --fake)")
        source = RealSource(rate=cfg.imu_rate)

    if a.record and a.true_bpm is None and not a.fake:
        print("[sensor] warning: --record without --true-bpm; tuning can't score this one", file=sys.stderr)
    recorder = Recorder(a.record, a.true_bpm, a.notes, source.name) if a.record else None

    meta = getattr(source, "meta", {})
    fs_in = getattr(source, "rate", None) or getattr(source, "fs", None)
    pipeline = Pipeline(cfg, meta.get("fs_accel") or fs_in, meta.get("fs_gyro") or fs_in)
    server = Server(source, pipeline, recorder, port=a.port, seconds=a.seconds, quiet=a.quiet)
    try:
        asyncio.run(server.run())
    except KeyboardInterrupt:
        pass
    finally:
        source.stop()
        if recorder:
            path = recorder.save()
            uid, gid = os.environ.get("SUDO_UID"), os.environ.get("SUDO_GID")
            if uid and gid:   # recorded under sudo: give the files back to the user
                for target in (path.parent, path):
                    os.chown(target, int(uid), int(gid))
            print(f"\n[sensor] saved {path} ({recorder.seconds():.1f} s)", file=sys.stderr)
        print(file=sys.stderr)


if __name__ == "__main__":
    main()
