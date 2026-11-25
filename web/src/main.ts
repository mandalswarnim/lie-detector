// Step 4: polygraph paper + pens + brass BPM gauge + lamps.
// The state machine (step 5) will drive the caption and IDLE/CALIBRATING screens.
import { SensorClient } from "./sensor";
import { StripChart } from "./paper";
import { Gauge } from "./gauge";

const sensor = new SensorClient();
const $ = (id: string) => document.getElementById(id)!;

const chart = new StripChart($("paper") as HTMLCanvasElement, [
  { label: "PULSE", ink: "#1b2f72" },
  { label: "MOVEMENT", ink: "#a11b1b" },
  { label: "VOICE", ink: "#1f5b30" },
  { label: "GSR", ink: "#231a12" },
]);
const gauge = new Gauge($("gauge") as HTMLCanvasElement);

/** Inputs other steps will feed. voice: 0..1 RMS level from the mic (step 6). */
export const inputs = { voice: 0 };

/** Caption under the paper: questions, instructions (state machine sets it). */
export function setCaption(text: string, blink = false): void {
  const el = $("caption-text");
  el.textContent = text;
  el.classList.toggle("blink", blink);
}

// ---------------------------------------------------------------- pen signals
// Smoothed so 30 Hz sensor frames draw as continuous ink at 60 fps.
const pen = { pulse: 0, move: 0, voice: 0, gsr: 0 };
let gsr = 0; // slow "skin response": combo of movement + voice
let lastNow = 0;
let wasLocked = false;
let bannerUntil = 0;

function wobble(t: number, seed: number): number {
  return (
    Math.sin(t * 7.3 + seed) * 0.5 +
    Math.sin(t * 13.1 + seed * 2.1) * 0.3 +
    Math.sin(t * 23.7 + seed * 3.7) * 0.2
  );
}

function step(now: number): void {
  const dt = lastNow ? Math.min(0.1, (now - lastNow) / 1000) : 0.016;
  lastNow = now;
  const t = now / 1000;
  const f = sensor.latest;
  const live = !sensor.stale;
  const tremor = () => (Math.random() - 0.5) * 0.025; // pens are never perfectly dead

  // PULSE: full swing when locked, a small searching scrawl otherwise
  const pulseGain = !live ? 0 : f.bpm_locked ? 0.85 : 0.22;
  pen.pulse += ((f.pulse_wave ?? 0) * pulseGain - pen.pulse) * 0.55;

  // MOVEMENT: rises with fidget and scribbles harder the more they squirm
  const fid = live ? f.fidget : 0;
  pen.move += (fid - pen.move) * (fid > pen.move ? 0.5 : 0.12);
  const moveY = -0.75 + pen.move * 0.9 + wobble(t, 1) * pen.move * 0.75 + (Math.random() - 0.5) * pen.move * 0.35;

  // VOICE: mic level (step 6); flat until then
  pen.voice += (inputs.voice - pen.voice) * 0.4;
  const voiceY = pen.voice * wobble(t * 1.7, 4) * 0.9;

  // GSR: slow lag (tau ~3 s) of movement + voice, plus a lazy drift
  const target = Math.min(1, 0.75 * fid + 0.4 * inputs.voice);
  gsr += (target - gsr) * (1 - Math.exp(-dt / 3));
  pen.gsr = -0.55 + gsr * 1.3 + Math.sin(t / 9) * 0.06 + Math.sin(t / 3.3) * 0.02;

  chart.push(now, [
    pen.pulse + tremor(),
    Math.max(-1, Math.min(1, moveY)) + tremor(),
    voiceY + tremor(),
    pen.gsr + tremor() * 0.4,
  ]);

  // gauge: held BPM stays on the dial (never show "no heartbeat")
  gauge.set(f.bpm);
  gauge.tremble = pen.move;

  // lock banner: flash "PULSE ACQUIRED" on each new lock
  if (f.bpm_locked && !wasLocked) bannerUntil = now + 2200;
  wasLocked = f.bpm_locked;
  $("banner").hidden = now > bannerUntil;

  // lamps: POWER = link, SIGNAL flickers while holding a lost lock, PULSE = locked
  $("lamp-link").classList.toggle("on", live || Math.floor(t * 1.5) % 2 === 0);
  $("lamp-signal").classList.toggle("on", f.bpm_held && Math.random() < 0.55);
  // PULSE lamp beats with the locked rate
  $("lamp-pulse").classList.toggle("on", f.bpm_locked && ((t * (f.bpm ?? 60)) / 60) % 1 < 0.3);

  $("bpm").textContent = f.bpm === null ? "---" : String(Math.round(f.bpm)).padStart(3, " ");
  $("stress-fill").style.width = `${Math.round(Math.min(1, gsr * 1.1) * 100)}%`;
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
  $("debug").textContent = [
    `LINK     ${sensor.stale ? "WAITING" : `${sensor.latencyMs.toFixed(0)} ms`}`,
    `BPM      ${n(f.bpm, 1)}  ${f.bpm_locked ? "LOCKED" : f.bpm_held ? "HELD" : "SEARCHING"}  conf ${n(f.bpm_conf)}`,
    `RAW BPM  ${n(d.raw_bpm as number, 1)}  ch ${d.best_ch ?? "--"}`,
    `FIDGET   ${n(f.fidget)}   GSR ${n(gsr)}`,
    `CONTACT  ${f.contact ? "ON" : "OFF"}`,
    `LID      ${n(f.lid, 0)}   LUX ${n(f.lux, 1)}`,
    `FS       ${JSON.stringify(d.fs ?? "--")}`,
  ].join("\n");
}

window.addEventListener("keydown", (e) => {
  if (e.repeat) return;
  const k = e.key.toLowerCase();
  if (k === "d") {
    debugOn = !debugOn;
    $("debug").hidden = !debugOn;
  } else if (k === "f") {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  }
});

function frame(now: number): void {
  step(now);
  chart.draw(now);
  gauge.draw(now);
  renderDebug(now);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// expose for console debugging
(window as unknown as { sensor: SensorClient }).sensor = sensor;
