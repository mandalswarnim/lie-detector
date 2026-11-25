# MacBook Lie Detector

A 1970s polygraph that reads the MacBook Pro's undocumented internal IMU
(accelerometer + gyroscope in the Apple Sensor Processing Unit) through the palm rest.
See `CLAUDE.md` for the full brief.

```
sensor/   Python: macimu -> DSP -> JSON over ws://localhost:8765 @ 30 Hz
web/      Vite + TypeScript page on http://localhost:5173
tools/    offline analysis / tuning (no sudo)
recordings/  raw sessions (.npz) with true-BPM labels
apple-silicon-accelerometer/  vendored macimu (unmodified)
```

## Setup (once, needs internet)

```zsh
python3 -m venv .venv                     # Python 3.13 (3.12 also fine)
.venv/bin/pip install -e ./apple-silicon-accelerometer numpy scipy websockets
(cd web && npm install)
```

Everything after this runs offline (the typewriter font is bundled in `web/public/fonts`).

## Run

| What | Command |
|---|---|
| Whole demo, fake sensor | `./run.sh` |
| Whole demo, real IMU | `./run.sh real` (asks for your password) |
| Whole demo, replay | `./run.sh replay recordings/x.npz` |
| Sensor only, fake | `.venv/bin/python -m sensor --fake` |
| Sensor only, real | `sudo .venv/bin/python -m sensor` |
| Replay a recording | `.venv/bin/python -m sensor --replay recordings/x.npz [--speed 4] [--no-loop]` |
| Record raw data | `sudo .venv/bin/python -m sensor --record name --true-bpm 72 --seconds 60` |
| Web only | `cd web && npm run dev` |
| Build web (type-check) | `cd web && npm run build` |
| Tune heartbeat DSP | `.venv/bin/python tools/tune.py recordings/*.npz` |

Extra args after `./run.sh MODE` go to the sensor, e.g. `./run.sh real --set contact_mode=always`.
Any DSP parameter in `sensor/config.py` can be overridden with `--set key=value`.

The sensor prints a live status line (contact, fidget, BPM, lock state, raw estimate,
best channel, contact RMS, sample rate).

## Sensor stream

One JSON frame per tick at 30 Hz:

```json
{ "t": 12.4, "pulse_wave": 0.31, "bpm": 72.0, "bpm_conf": 0.62, "bpm_locked": true,
  "bpm_held": false, "fidget": 0.05, "contact": true, "lid": 103.0, "lux": 1.0,
  "wall_ms": 1795616464140, "dbg": { ... } }
```

- `bpm` is `null` until the first lock of the session; afterwards it always holds the last good value
  (`bpm_held: true` while not locked).
- `dbg` (for the `D` panel): raw estimate, best channel, per-axis periodicity scores, RMS levels,
  baselines, measured sample rates. `wall_ms` lets the page measure latency.

The page can send commands back:
`{"cmd":"calibrate","seconds":15}` (fixes the fidget baseline from the next 15 s) and
`{"cmd":"reset"}` (new volunteer: clears lock, held BPM, baselines).

## Recording sessions for tuning (needs you + sudo)

Hard table, charger unplugged, nothing else touching the table. Rest both wrists on the palm rest,
the way a volunteer would. Count your pulse at your neck for 30 s and double it, before and after
recording, and use the average as `--true-bpm`.

```zsh
sudo .venv/bin/python -m sensor --record still_1   --true-bpm 72 --seconds 60 --notes "wrists on, still"
sudo .venv/bin/python -m sensor --record breath_1  --true-bpm 72 --seconds 60 --notes "hold breath for the first 20 s"
sudo .venv/bin/python -m sensor --record still_2   --true-bpm 72 --seconds 60 --notes "wrists on, still, different hand position"
sudo .venv/bin/python -m sensor --record fidget_1  --true-bpm 72 --seconds 60 --notes "still 20 s, fidget 10 s, still 30 s"
sudo .venv/bin/python -m sensor --record off_1     --seconds 30 --notes "wrists OFF the laptop"
```

Or let a script walk you through all of them: `./tools/record_all.sh` (round 1) and
`./tools/record_all.sh round2` (800 Hz, wrists on/off test, still, small/big fidget, leaning on the table).

## What the recordings showed (M4, 2026-11-25, rounds 1 and 2)

- **Contact: the IMU cannot tell wrists on from off.** Vibration energy is the same either way.
  Chassis tilt looked promising in round 1 (~2 mg), but the deliberate on/off test (`onoff_1`) showed
  normal pressure moves it < 0.1 mg, one change went the wrong way, and shifting in the chair moves
  it as much. So `contact_mode` defaults to `always` (`contact` is always true). The web state machine
  should leave IDLE on an operator key. `--set contact_mode=auto` keeps the tilt detector for experiments.
- **Fidget works.** At 800 Hz (averaged) fidget = max of accel 3-5 Hz and gyro 0.5-5 Hz against the
  stillness baseline. On `fidget800_1`, small hand shift reads ~0.45, big squirm ~0.77, and stillness
  P95 is ~0.11. Each wrist move in `onoff_1` shows as a spike. Leaning on or tapping the **table** also
  reads as fidget (up to 1.0), so nobody touches the table.
- **Heartbeat: not readable at the palm rest.** Over a full 60 s spectrum gyro-y does show a faint peak at
  the true rate (+3-4 dB), so the pulse is physically there, but in any 8-20 s window the estimate is
  within ±5 BPM only 13-43% of the time and confidence doesn't separate right from wrong. Averaging
  800 Hz beats dropping to 100 Hz (25-30% vs 14-26%) but not enough. Lock thresholds stay strict, so the
  machine never shows a confident wrong BPM: it will usually say "SUBJECT'S HEART UNREADABLE — HIGHLY
  SUSPICIOUS" after 12 s, which is the planned joke.
- **Hand position (round 3):** palm rest, firm inner-wrist press, forearms across, hands flat on the
  keys and fingertips on the lid all stay at the noise level (<= 4 dB, <= 42% of estimates right).
  Keep the palm rest.
- Mains-like tones exist at ~100, 34 and 65 Hz but are far above the pulse and fidget bands. The
  "50Hz/25Hz/12Hz" tags in motion_live.py are just wavelet band labels.

Then `.venv/bin/python tools/tune.py recordings/*.npz`.

## Operating the polygraph

Flow: `IDLE` (blinks "PLACE BOTH WRISTS ON THE PALM REST") → `CALIBRATING` 15 s (8 s "REMAIN
PERFECTLY STILL. HOLD YOUR BREATH.", then the control question "STATE YOUR NAME") → `READY`
(question typed out) → `ANSWER` (up to 6 s, ends early when they stop talking) → `ANALYSING` 2 s
(pens go wild) → `VERDICT` (TRUTH/LIE stamp, deception index, one-liner) → `READY`.

If the pulse hasn't locked 12 s into calibration, the machine stamps "SUBJECT'S HEART UNREADABLE —
HIGHLY SUSPICIOUS" and keeps a red HEART UNREADABLE tag under the counter. Scoring then uses
fidget + voice only.

Operator keys (nothing on screen mentions them):

| Key | Does |
|---|---|
| `Space` | IDLE: start calibration · READY: start the answer · VERDICT: next question |
| `1`–`9` | show preset question n (from `web/src/questions.json`) |
| `T` / `L` | force the next verdict TRUTH / LIE (the index shown is made consistent) |
| `[` / `]` | LIE threshold −/+ 5 (default 50; the white tick on the meter) |
| `R` | reset for the next volunteer (back to IDLE, sensor baseline cleared) |
| `D` | debug panel: state, link latency, BPM/conf, fidget, mic dB/pitch, baseline, last scores |
| `F` | fullscreen · `M` mute sounds |

Scoring: deception index 0–100 = weighted deltas vs calibration. Weights: fidget 0.45, answer latency
0.25, voice pitch change 0.15, BPM rise 0.15. The BPM weight counts only when the pulse was locked
in both calibration and the answer. Pitch counts only if the control question gave a pitch. Saying
nothing counts as strong (not maximum) hesitation. Every cue has a dead zone so normal behaviour
scores ~0: fidget p80 under 0.1, under 0.5 s slower than the subject's usual, pitch change under 8%,
pulse rise under 3 BPM. "Usual" means the median of the control question and this subject's
earlier answers. Typical results: calm answer 0-20, small fidget ~30, big squirm 50+, squirm plus
hesitation plus pitch 80+. Each verdict is logged to the browser console as `[verdict] {...}`.

The `--fake` sensor injects random fidget bursts every 8-18 s, so verdicts there are random. Judge
how reliable it is on `./run.sh real` only. Sounds are synthesised (no files) and never play during
calibration or an answer, because the speakers shake the chassis and the IMU would read it as fidget.

The browser asks for the microphone when the page opens: click Allow once.

### 60-second demo script

1. (0 s) "This MacBook has a motion sensor Apple never told anyone about. It can feel you lie."
   Volunteer rests both wrists on the palm rest. `Space`.
2. (0–15 s) Calibration: they hold still and hold their breath, then say their name. The heart
   either locks (PULSE ACQUIRED) or gets declared UNREADABLE — HIGHLY SUSPICIOUS (laugh line).
3. (15–30 s) `1`: an easy question. `Space`, they answer, the stamp lands.
4. (30–55 s) `9` "Are you lying to me right now?" (or `6`/`7`). Press `L` first if you need the
   punchline to land.
5. (55–60 s) Read the one-liner aloud. `R` for the next volunteer.

## Demo-night checklist

- Battery charged. Do not update macOS before the event.
- Hard table, nothing else touching it.
- `./run.sh real`, click Allow for the microphone, check the debug panel once (MIC shows dB and
  jumps when you talk; LINK in ms), press `D` to hide it, `F` for fullscreen.
- Rehearse once with a real voice: the `MIC` line should show `VOICE` while talking and a pitch.
- Nobody leans on or touches the table during a question: it reads as fidget.
- Backup: a screen recording of a good run, and `./run.sh replay recordings/<good>.npz` ready.
