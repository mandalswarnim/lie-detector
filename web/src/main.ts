// Polygraph page: paper + pens + gauge (step 4), state machine + calibration (5),
// voice (6), scoring + stamp + sounds (7), operator keys + debug panel (8).
//
// Operator keys (never shown on screen):
//   Space  IDLE: start calibration · READY: start answer · VERDICT: next question
//   1-9    show preset question n      T / L  force next verdict TRUTH / LIE
//   [ ]    LIE threshold -/+ 5         R      reset for next volunteer
//   D      debug panel                 F      fullscreen        M  mute sounds
import { SensorClient } from "./sensor";
import { StripChart } from "./paper";
import { Gauge } from "./gauge";
import { Voice } from "./voice";
import { Sounds } from "./sounds";
import { score, type Baseline, type Result } from "./scoring";
import questions from "./questions.json";

const sensor = new SensorClient();
const $ = (id: string) => document.getElementById(id)!;

const chart = new StripChart($("paper") as HTMLCanvasElement, [
  { label: "PULSE", ink: "#1b2f72" },
  { label: "MOVEMENT", ink: "#a11b1b" },
  { label: "VOICE", ink: "#1f5b30" },
  { label: "GSR", ink: "#231a12" },
]);
const gauge = new Gauge($("gauge") as HTMLCanvasElement);
const sounds = new Sounds();
const voice = new Voice();
voice.start(sounds.ctx); // asks for the mic at load, so the operator grants it during setup

// ---------------------------------------------------------------- timings (s)
const CAL_STILL = 8; // "hold your breath" part; sensor fixes its fidget baseline here
const CAL_TOTAL = 15; // then a control question until 15 s
const HEART_DEADLINE = 12; // no lock by then -> "HEART UNREADABLE"
const ANSWER_MAX = 6;
const ANSWER_MIN = 2.5; // can end early once they've spoken and gone quiet
const ANSWER_QUIET = 1.2;
const ANALYSE = 2;
const VERDICT_HOLD = 1.2; // ignore Space this long after the stamp (no accidental skip)

// ---------------------------------------------------------------- state
type State = "IDLE" | "CALIBRATING" | "READY" | "ANSWER" | "ANALYSING" | "VERDICT";
let state: State = "IDLE";
let since = 0; // performance.now() when the state was entered
let qIndex = 0;
let threshold = 40;
let force: "T" | "L" | null = null;
let heartUnreadable = false;
let everLocked = false;
let calStart = 0;
let baseline: Baseline | null = null;
let last: Result | null = null;
// this subject's own history: verdicts compare against their usual, not just the control question
let subjLat: number[] = [];
let subjPitch: number[] = [];
let subjArousal: number[] = [];
const log: object[] = [];

// per-phase collectors
let calFid: number[] = [];
let calBpm: number[] = [];
let calPitch: number[] = [];
let calLatency: number | null = null;
let ansFid: number[] = [];
let ansBpm: number[] = [];
let ansPitch: number[] = [];
let ansLatency: number | null = null;
let lastVoiceAt = 0;

// caption typing
let typing = "";
let typed = 0;
let lastKeyAt = 0;

function setCaption(text: string, opts: { label?: string; blink?: boolean; type?: boolean } = {}): void {
  $("caption-label").textContent = opts.label ?? "";
  const el = $("caption-text");
  el.classList.toggle("blink", !!opts.blink);
  if (opts.type) {
    typing = text;
    typed = 0;
    el.textContent = "";
  } else {
    typing = "";
    el.textContent = text;
  }
}

function setProgress(frac: number | null, color = "#a11b1b"): void {
  const p = $("progress");
  p.style.visibility = frac === null ? "hidden" : "visible";
  if (frac !== null) {
    $("progress-fill").style.width = `${Math.max(0, Math.min(1, frac)) * 100}%`;
    $("progress-fill").style.background = color;
  }
}

/** Speakers shake the chassis: no sounds while we measure. */
const quietPhase = () => state === "CALIBRATING" || state === "ANSWER";

function enter(s: State, now: number): void {
  state = s;
  since = now;
  switch (s) {
    case "IDLE":
      setCaption("PLACE BOTH WRISTS ON THE PALM REST", { label: "SUBJECT NOT CONNECTED", blink: true });
      setProgress(null);
      $("stamp").hidden = true;
      break;
    case "CALIBRATING":
      calStart = now;
      calFid = [];
      calBpm = [];
      calPitch = [];
      calLatency = null;
      sensor.send({ cmd: "calibrate", seconds: CAL_STILL - 1 });
      setCaption("REMAIN PERFECTLY STILL. HOLD YOUR BREATH.", { label: "CALIBRATION" });
      break;
    case "READY": {
      $("stamp").hidden = true;
      setProgress(null);
      const q = questions[qIndex % questions.length];
      setCaption(q.toUpperCase(), { label: `QUESTION ${(qIndex % questions.length) + 1}`, type: true });
      sounds.click();
      break;
    }
    case "ANSWER":
      typing = "";
      $("caption-text").textContent = questions[qIndex % questions.length].toUpperCase();
      $("caption-label").textContent = "● ANSWER NOW";
      ansFid = [];
      ansBpm = [];
      ansPitch = [];
      ansLatency = null;
      lastVoiceAt = 0;
      break;
    case "ANALYSING":
      setCaption("ANALYSING", { label: "PLEASE WAIT" });
      setProgress(null);
      sounds.scratchOn(1);
      break;
    case "VERDICT": {
      sounds.scratchOn(0);
      const cal = baseline ?? { fidget: 0, latency: 1, pitch: 0, bpm: null };
      const base = {
        ...cal,
        latency: median([cal.latency, ...subjLat]),
        pitch: cal.pitch > 0 ? median([cal.pitch, ...subjPitch]) : 0,
      };
      const bpmMean = ansBpm.length ? ansBpm.reduce((a, b) => a + b, 0) / ansBpm.length : null;
      last = score(base, { fidget: ansFid, latency: ansLatency, pitches: ansPitch, bpm: bpmMean }, threshold, force, subjArousal);
      subjArousal.push(last.arousal);
      force = null;
      if (ansLatency !== null) subjLat.push(Math.min(ansLatency, 4));
      if (ansPitch.length >= 8) subjPitch.push(median(ansPitch));
      const entry = {
        q: (qIndex % questions.length) + 1,
        verdict: last.lie ? "LIE" : "TRUTH",
        index: last.index,
        forced: last.forced,
        fidget: +last.parts.fidget.toFixed(2),
        latency: +last.parts.latency.toFixed(2),
        pitch: +last.parts.pitch.toFixed(2),
        bpm: last.parts.bpm === null ? null : +last.parts.bpm.toFixed(2),
        lat_s: ansLatency === null ? null : +ansLatency.toFixed(2),
        base_lat_s: +base.latency.toFixed(2),
        arousal: +last.arousal.toFixed(3),
        pitch_pct: last.facts.pitchPct === null ? null : Math.round(last.facts.pitchPct),
      };
      log.push(entry);
      console.log("[verdict]", JSON.stringify(entry));
      showStamp(last);
      setCaption(last.line, { label: `DECEPTION INDEX ${last.index}` });
      break;
    }
  }
}

function showStamp(r: Result): void {
  const st = $("stamp");
  st.className = r.lie ? "lie" : "truth";
  $("stamp-word").textContent = r.lie ? "LIE" : "TRUTH";
  $("stamp-index").textContent = `INDEX ${r.index}`;
  st.hidden = false;
  // restart the slam animation
  st.style.animation = "none";
  void st.offsetWidth;
  st.style.animation = "";
  sounds.stamp(r.lie);
  const app = $("app");
  app.classList.remove("shake");
  void app.offsetWidth;
  app.classList.add("shake");
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}

function finishCalibration(): void {
  baseline = {
    fidget: calFid.length ? median(calFid) : 0,
    latency: calLatency ?? 1.0,
    pitch: calPitch.length >= 5 ? median(calPitch) : 0,
    bpm: calBpm.length ? calBpm.reduce((a, b) => a + b, 0) / calBpm.length : null,
  };
}

function bannerShow(text: string, cls: string, ms: number, now: number): void {
  const b = $("banner");
  b.textContent = text;
  b.className = cls;
  b.hidden = false;
  bannerUntil = now + ms;
}

// ---------------------------------------------------------------- heart estimate (H toggles)
// The IMU can't hold a confident lock at the palm rest (see README), so by default the display
// falls back to the median of the sensor's raw estimates over the last 20 s, ignoring moments of
// fidget. On the M4 recordings that median sat ~3-10 BPM from the watch. Display only: scoring
// still uses locked BPM alone.
let estimateOn = true;
const rawHist: { at: number; bpm: number }[] = [];
let estBpm: number | null = null;
function updateEstimate(now: number): void {
  const f = sensor.latest;
  const raw = (f.dbg?.raw_bpm as number | null | undefined) ?? null;
  if (!sensor.stale && raw !== null && raw >= 50 && raw <= 120 && f.fidget < 0.3) {
    if (!rawHist.length || now - rawHist[rawHist.length - 1].at > 200) rawHist.push({ at: now, bpm: raw });
  }
  while (rawHist.length && now - rawHist[0].at > 20000) rawHist.shift();
  if (rawHist.length >= 25) {
    const m = median(rawHist.map((r) => r.bpm));
    estBpm = estBpm === null ? m : estBpm + 0.05 * (m - estBpm); // drift slowly, like a real needle
  }
}
/** What the gauge/counter show: real lock or held value first, else the estimate. */
function shownBpm(): number | null {
  const f = sensor.latest;
  if (f.bpm !== null && (f.bpm_locked || !estimateOn || estBpm === null)) return f.bpm;
  return estimateOn ? estBpm ?? f.bpm : f.bpm;
}
const heartShown = () => sensor.latest.bpm_locked || (estimateOn && estBpm !== null);
let heartWasShown = false;

// ---------------------------------------------------------------- per-frame logic
function tick(now: number): void {
  const el = (now - since) / 1000;
  const f = sensor.latest;
  const live = !sensor.stale;

  // heart lock / unreadable (only once a session has started)
  const hs = heartShown();
  if (hs && !heartWasShown) {
    everLocked = true;
    if (heartUnreadable) heartUnreadable = false;
    if (state !== "IDLE") {
      bannerShow("PULSE ACQUIRED", "good", 2200, now);
      if (!quietPhase()) sounds.ding();
    }
  }
  heartWasShown = hs;
  if (state !== "IDLE" && !everLocked && !heartUnreadable && (now - calStart) / 1000 >= HEART_DEADLINE) {
    heartUnreadable = true;
    bannerShow("SUBJECT'S HEART UNREADABLE\n— HIGHLY SUSPICIOUS —", "bad", 4000, now);
  }
  $("heart-tag").hidden = !heartUnreadable || hs;

  // caption typing (with typewriter keys)
  if (typing && typed < typing.length && now - lastKeyAt > 28) {
    lastKeyAt = now;
    typed++;
    $("caption-text").textContent = typing.slice(0, typed);
    if (typing[typed - 1] !== " " && !quietPhase()) sounds.key();
  }

  switch (state) {
    case "IDLE":
      break;

    case "CALIBRATING": {
      if (live) calFid.push(f.fidget);
      if (f.bpm_locked && f.bpm !== null) calBpm.push(f.bpm);
      setProgress(el / CAL_TOTAL, "#1f5b30");
      if (el >= CAL_STILL && $("caption-label").textContent === "CALIBRATION") {
        setCaption("CONTROL QUESTION: STATE YOUR NAME.", { label: "CALIBRATION · CONTROL" });
      }
      if (el >= CAL_STILL) {
        if (voice.active && calLatency === null) calLatency = el - CAL_STILL;
        if (voice.pitch > 0) calPitch.push(voice.pitch);
      }
      if (el >= CAL_TOTAL) {
        finishCalibration();
        sounds.ding();
        enter("READY", now);
      }
      break;
    }

    case "ANSWER": {
      if (live) ansFid.push(f.fidget);
      if (f.bpm_locked && f.bpm !== null) ansBpm.push(f.bpm);
      if (voice.active) {
        if (ansLatency === null) ansLatency = el;
        lastVoiceAt = now;
      }
      if (voice.pitch > 0) ansPitch.push(voice.pitch);
      setProgress(1 - el / ANSWER_MAX);
      const doneTalking = ansLatency !== null && (now - lastVoiceAt) / 1000 > ANSWER_QUIET && el > ANSWER_MIN;
      if (el >= ANSWER_MAX || doneTalking) enter("ANALYSING", now);
      break;
    }

    case "ANALYSING":
      $("caption-text").textContent = "ANALYSING" + ".".repeat(1 + (Math.floor(el * 4) % 3));
      if (el >= ANALYSE) enter("VERDICT", now);
      break;

    case "READY":
    case "VERDICT":
      break;
  }
}

// ---------------------------------------------------------------- pens
const pen = { pulse: 0, move: 0, voice: 0 };
let gsr = 0;
let lastNow = 0;
let bannerUntil = 0;
let wild = 0; // 0..1, pens thrash during ANALYSING

function wobble(t: number, seed: number): number {
  return Math.sin(t * 7.3 + seed) * 0.5 + Math.sin(t * 13.1 + seed * 2.1) * 0.3 + Math.sin(t * 23.7 + seed * 3.7) * 0.2;
}

function draw(now: number): void {
  const dt = lastNow ? Math.min(0.1, (now - lastNow) / 1000) : 0.016;
  lastNow = now;
  const t = now / 1000;
  const f = sensor.latest;
  const live = !sensor.stale;
  const tremor = () => (Math.random() - 0.5) * 0.025;

  wild += ((state === "ANALYSING" ? 1 : 0) - wild) * (state === "ANALYSING" ? 0.08 : 0.04);
  const thrash = (seed: number) => wild * (wobble(t * 2.3, seed) * 0.6 + (Math.random() - 0.5) * 0.7);

  const pulseGain = !live ? 0 : f.bpm_locked ? 0.85 : heartShown() ? 0.55 : 0.22;
  pen.pulse += ((f.pulse_wave ?? 0) * pulseGain - pen.pulse) * 0.55;

  const fid = live ? f.fidget : 0;
  pen.move += (fid - pen.move) * (fid > pen.move ? 0.5 : 0.12);
  const moveY = -0.75 + pen.move * 0.9 + wobble(t, 1) * pen.move * 0.75 + (Math.random() - 0.5) * pen.move * 0.35;

  pen.voice += (voice.level - pen.voice) * 0.5;
  const voiceY = pen.voice * (wobble(t * 1.7, 4) * 0.7 + (Math.random() - 0.5) * 0.5);

  const target = Math.min(1, 0.75 * fid + 0.5 * voice.level);
  gsr += (target - gsr) * (1 - Math.exp(-dt / 3));
  const gsrY = -0.55 + gsr * 1.3 + Math.sin(t / 9) * 0.06 + Math.sin(t / 3.3) * 0.02;

  const c = (v: number) => Math.max(-1, Math.min(1, v));
  chart.push(now, [
    c(pen.pulse + tremor() + thrash(1)),
    c(moveY + tremor() + thrash(2)),
    c(voiceY + tremor() + thrash(3)),
    c(gsrY + tremor() * 0.4 + thrash(4) * 0.6),
  ]);
  chart.draw(now);

  const bpmShown = shownBpm();
  gauge.set(bpmShown);
  gauge.tremble = Math.max(pen.move, wild);
  gauge.draw(now);

  $("banner").hidden = now > bannerUntil;
  $("lamp-link").classList.toggle("on", live || Math.floor(t * 1.5) % 2 === 0);
  $("lamp-signal").classList.toggle("on", !heartShown() && f.bpm_held && Math.random() < 0.55);
  $("lamp-pulse").classList.toggle("on", heartShown() && ((t * (bpmShown ?? 60)) / 60) % 1 < 0.3);
  $("bpm").textContent = bpmShown === null ? "---" : String(Math.round(bpmShown)).padStart(3, " ");

  // stress meter: live GSR, or the deception index while a verdict is up
  const meter = state === "VERDICT" && last ? last.index / 100 : Math.min(1, gsr * 1.1 + wild * Math.random() * 0.6);
  $("stress-fill").style.width = `${Math.round(meter * 100)}%`;
  $("stress-mark").style.left = `${threshold}%`;
  $("meter-label").textContent = state === "VERDICT" ? "DECEPTION" : "STRESS";
}

// ---------------------------------------------------------------- debug panel (D)
let debugOn = false;
let lastDebug = 0;
function renderDebug(now: number): void {
  if (!debugOn || now - lastDebug < 150) return;
  lastDebug = now;
  const f = sensor.latest;
  const d = (f.dbg ?? {}) as Record<string, unknown>;
  const n = (v: number | null | undefined, p = 2) => (v === null || v === undefined ? "--" : v.toFixed(p));
  const b = baseline;
  const p = last?.parts;
  $("debug").textContent = [
    `STATE    ${state}  ${((now - since) / 1000).toFixed(1)} s   Q ${(qIndex % questions.length) + 1}`,
    `THRESH   ${threshold}   FORCE ${force ?? "-"}   ${sounds.muted ? "MUTED" : "sound on"}`,
    `LINK     ${sensor.stale ? "WAITING" : `${sensor.latencyMs.toFixed(0)} ms`}`,
    `BPM      ${n(f.bpm, 1)}  ${f.bpm_locked ? "LOCKED" : f.bpm_held ? "HELD" : "SEARCHING"}  conf ${n(f.bpm_conf)}  raw ${n(d.raw_bpm as number, 1)} ${d.best_ch ?? ""}`,
    `FIDGET   ${n(f.fidget)}   GSR ${n(gsr)}   CONTACT ${f.contact ? "ON" : "OFF"}`,
    `HEART    ${estimateOn ? "estimate ON" : "estimate off"}  est ${n(estBpm, 1)}  (${rawHist.length} raw)  shown ${n(shownBpm(), 0)}`,
    `MIC      ${voice.denied ? "DENIED" : voice.ready ? `${n(voice.db, 0)} dB  lvl ${n(voice.level)}  pitch ${n(voice.pitch, 0)} Hz ${voice.active ? "VOICE" : ""}` : "starting"}`,
    `BASE     ${b ? `fid ${n(b.fidget)}  lat ${n(b.latency)} s  pitch ${n(b.pitch, 0)}  bpm ${n(b.bpm, 1)}` : "--"}`,
    `LAST     ${last ? `${last.lie ? "LIE" : "TRUTH"} ${last.index}${last.forced ? " (forced)" : ""}  fid ${n(p!.fidget)} lat ${n(p!.latency)} pit ${n(p!.pitch)} bpm ${n(p!.bpm)}` : "--"}`,
    `LID      ${n(f.lid, 0)}   LUX ${n(f.lux, 1)}   FS ${JSON.stringify(d.fs ?? "--")}`,
  ].join("\n");
}

// ---------------------------------------------------------------- operator keys
window.addEventListener("keydown", (e) => {
  if (e.repeat || e.metaKey || e.ctrlKey) return;
  sounds.resume();
  const now = performance.now();
  const k = e.key.toLowerCase();
  const el = (now - since) / 1000;

  if (k === " ") {
    e.preventDefault();
    if (state === "IDLE") enter("CALIBRATING", now);
    else if (state === "READY") enter("ANSWER", now);
    else if (state === "VERDICT" && el > VERDICT_HOLD) {
      qIndex++;
      enter("READY", now);
    }
  } else if (/^[1-9]$/.test(k)) {
    const i = Number(k) - 1;
    if (i < questions.length && (state === "READY" || state === "VERDICT")) {
      qIndex = i;
      enter("READY", now);
    }
  } else if (k === "t" || k === "l") {
    force = k === "t" ? "T" : "L";
  } else if (k === "[" || k === "]") {
    threshold = Math.max(5, Math.min(95, threshold + (k === "]" ? 5 : -5)));
  } else if (k === "r") {
    sensor.send({ cmd: "reset" });
    sounds.scratchOn(0);
    baseline = null;
    last = null;
    subjLat = [];
    subjPitch = [];
    subjArousal = [];
    force = null;
    heartUnreadable = false;
    everLocked = false;
    qIndex = 0;
    bannerUntil = 0;
    enter("IDLE", now);
  } else if (k === "d") {
    debugOn = !debugOn;
    $("debug").hidden = !debugOn;
  } else if (k === "f") {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  } else if (k === "h") {
    estimateOn = !estimateOn;
  } else if (k === "m") {
    sounds.muted = !sounds.muted;
    if (sounds.muted) sounds.scratchOn(0);
  }
});

// contact_mode=auto support: wrists going on while IDLE starts calibration by itself
let contactSince = 0;
function autoStart(now: number): void {
  const f = sensor.latest;
  if (state !== "IDLE" || sensor.stale) return;
  if (!f.contact) {
    contactSince = -1; // saw "off": the next sustained "on" is a real placement
  } else if (contactSince === -1) {
    contactSince = now;
  } else if (contactSince > 0 && now - contactSince > 1500) {
    contactSince = 0;
    enter("CALIBRATING", now);
  }
}

// ---------------------------------------------------------------- loop
enter("IDLE", performance.now());
function frame(now: number): void {
  voice.update(now);
  updateEstimate(now);
  autoStart(now);
  tick(now);
  draw(now);
  renderDebug(now);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// expose for console debugging
Object.assign(window as object, { sensor, voice, sounds, polygraph: { get state() { return state; }, get last() { return last; }, get baseline() { return baseline; }, log }  });
