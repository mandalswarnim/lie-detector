# CLAUDE.md — MacBook Lie Detector

## The project
A live hackathon demo ("Side Project: After Hours", 2-hour build, **60-second demo**). A volunteer rests their wrists on my MacBook Pro's palm rest. The MacBook's **undocumented internal IMU** (accelerometer + gyroscope, Apple Sensor Processing Unit) feels them squirm and, when it can, their heartbeat. A browser page styled as a 1970s analogue polygraph shows the readings, I ask questions, and the machine stamps **TRUTH** or **LIE**.

The magic is: *"a sensor Apple never told you about can feel you lie."* No external hardware. **No Apple Watch, no phone, no webcam pulse.** Do not suggest them.

It's theatre built on real signals. The verdict is a heuristic, and that's fine.

## Hardware facts (verified on my machine)
- MacBook Pro **M4**, macOS. `AppleSPUHIDDevice` is present.
- `olvvier/apple-silicon-accelerometer` (`macimu`) works here with **sudo**. It reads accel, gyro, lid angle, ambient light.
- **Heartbeat detection is hit-or-miss.** Fidget/movement detection is reliable.
- `motion_live.py` logs tiny vibration events tagged "50Hz,25Hz,12Hz" even on battery (charger never plugged in). Unconfirmed whether these are real noise or just the script's band labels — check in the recordings before filtering for them. Don't assume mains hum.
- Soft surfaces (bed, sofa, lap) ruin the signal. Assume a hard café table.
- Shell is **zsh**: always quote extras, e.g. `pip install -e '.[demo]'`.

## Design principle: never depend on the heartbeat
1. **Fidget is the headline signal.** It must work 100% of the time.
2. **Heartbeat is a bonus.** When it locks: flash "PULSE ACQUIRED", show BPM, draw the beat trace. When it drops: **hold the last good BPM** and flicker a "SIGNAL" lamp. Never show "no heartbeat" or an error to the audience.
3. **No lock within 12 s** → the machine says `SUBJECT'S HEART UNREADABLE — HIGHLY SUSPICIOUS` and scores on fidget + voice. The failure is a joke, not a crash.
4. Calibration screen says **"REMAIN PERFECTLY STILL. HOLD YOUR BREATH."** It improves the signal and it's good theatre.

## Architecture
```
sensor/  Python 3.12, run with sudo
  macimu → ring buffer → DSP → JSON over WebSocket ws://localhost:8765 @ 30 Hz
web/     Vite + TypeScript (vanilla or React), served on localhost:5173
  polygraph UI, Web Audio mic, state machine, scoring, operator keys
tools/   offline analysis + tuning scripts (no sudo)
recordings/  raw sessions from motion_live.py and our own recorder, with true BPM labels
```

### Sensor stream message (keep this contract stable)
```json
{ "t": 0.0, "pulse_wave": 0.0, "bpm": 72, "bpm_conf": 0.0, "bpm_locked": false,
  "bpm_held": true, "fidget": 0.0, "contact": true, "lid": 103, "lux": 1.0 }
```
- `fidget`: 0–1, RMS of 5–20 Hz band over 1 s, normalised against the calibration baseline.
- `contact`: wrists on vs off (signal energy present vs flat).
- `bpm_conf`: 0–1 confidence; `bpm_locked` true only above a tuned threshold.

### Heartbeat DSP (tune from data, don't guess)
- Read **both accel and gyro, all axes**. Pick the best channel from the recordings, or combine them adaptively at runtime by periodicity score.
- Band-pass ~0.8–3 Hz. Plot a spectrum of the recordings first; add notches only for noise peaks that actually appear.
- Prefer **autocorrelation over an 6–10 s window** to individual peak counting; fall back to peaks only if the data says it's better.
- Start from the heartbeat logic in `apple-silicon-accelerometer/motion_live.py`. Read it first, reuse what works, improve what doesn't.

## Modes (all must exist)
- `sudo python -m sensor` — real data.
- `python -m sensor --fake` — synthetic but believable signal (fidget bursts, a pulse that locks and drops). Build all UI against this; no sudo needed.
- `python -m sensor --replay recordings/x.npz` — replay a recording at real speed. Use it to test DSP changes and the UI without touching the laptop.
- `python -m sensor --record name --true-bpm 72` — save raw data for tuning.

## Web page
**Look:** cream graph paper scrolling right-to-left with ink pens (PULSE, MOVEMENT, VOICE, plus a smoothed "GSR" combo trace), a brass analogue BPM gauge with a needle, typewriter monospace, paper texture, pen scratch sounds, a mechanical click on each question, a rubber-stamp slam for TRUTH (green) / LIE (red) with screen shake. Full-screen, readable from 5 metres.

**State machine:** `IDLE` (blink "PLACE BOTH WRISTS ON THE PALM REST", wait for `contact`) → `CALIBRATING` (15 s, control questions, record baselines) → `READY` (question shown big) → `ANSWER` (Space starts a ~6 s window) → `ANALYSING` (2 s, pens go wild) → `VERDICT` (stamp + dry one-liner, e.g. "Movement +40%. Hesitation 1.8 s. The machine is disappointed in you.") → back to `READY`.

**Voice (Web Audio):** RMS volume, autocorrelation pitch, and answer latency (time from question start to voice onset).

**Scoring:** weighted, normalised deltas vs baseline → 0–100 deception index. Default weights: fidget 0.45, latency 0.25, voice pitch 0.15, BPM rise 0.15 (BPM weight only counts when it was locked). LIE threshold adjustable live.

**Operator keys (never shown on screen):**
`Space` start answer · `1`–`9` preset questions · `T`/`L` force next verdict TRUTH/LIE · `[` `]` threshold · `R` reset for next volunteer · `D` debug panel (raw channels, conf, latency, scores) · `F` fullscreen.

Preset questions live in `web/src/questions.json` and are editable.

## Rules for working on this repo
- **Fully offline.** No CDN fonts/scripts at runtime; bundle everything. Venue Wi-Fi will be bad.
- **One command per part**, documented in README.md with exact commands. Add a `./run.sh` that starts sensor + web together and opens the browser.
- UI never blocks on the sensor. If the WebSocket drops, auto-reconnect silently and keep animating.
- Keep latency low: sensor → screen under 100 ms.
- Before saying something works, **run it**: run the DSP against the recordings and report lock time + BPM error per recording; build the web app; check the fake and replay modes end to end. Real-sensor checks need me (sudo + wrists), so tell me exactly what to run and what I should see.
- Small, working increments. After each step, everything still starts with one command.
- Don't add dependencies without reason. Python: `macimu`, `numpy`, `scipy`, `websockets`. Web: Vite + TS, nothing heavy.
- Don't refactor the vendored `apple-silicon-accelerometer` repo; import from it or copy what's needed into `sensor/`.

## Build order
**Before the night (skeleton):**
1. `--fake` stream + WebSocket + bare page showing live numbers.
2. Real `macimu` stream + `--record` + `--replay`.
3. Tune heartbeat DSP offline against labelled recordings (`tools/tune.py`). Target: lock in ≤15 s on most recordings, BPM error ≤5.

**On the night (the fun part):**
4. Polygraph paper + pens + gauge. 5. State machine + calibration. 6. Mic voice trace + latency. 7. Scoring + stamp + sounds. 8. Operator keys + debug panel. 9. Polish, and rehearse the 60 seconds.

## Demo-night checklist (put in README)
- Battery charged. Do not update macOS before the event.
- Hard table, nothing else touching it.
- `./run.sh`, check debug panel once, press `D` to hide, `F` fullscreen.
- Backup: screen recording of a good run, and `--replay` of a good session ready.
