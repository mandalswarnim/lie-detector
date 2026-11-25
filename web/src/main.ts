// Step 1 bare page: live numbers + scrolling traces. The real polygraph
// paper, gauge and state machine come on the night (build steps 4-9).
import { SensorClient, type SensorFrame } from "./sensor";

const sensor = new SensorClient();
const readouts = document.getElementById("readouts")!;
const lamp = document.getElementById("lamp")!;
const canvas = document.getElementById("traces") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;

// ---- trace history, sampled at render time so the paper keeps moving even with no sensor
const SECONDS = 10;
type Sample = { at: number; pulse: number; fidget: number };
const hist: Sample[] = [];

function fmt(f: SensorFrame) {
  const bpm = f.bpm === null ? "---" : f.bpm.toFixed(0);
  const state = f.bpm_locked ? "LOCKED" : f.bpm_held ? "HELD" : "SEARCHING";
  return [
    ["BPM", bpm, state],
    ["CONF", f.bpm_conf.toFixed(2), ""],
    ["FIDGET", f.fidget.toFixed(2), ""],
    ["CONTACT", f.contact ? "ON" : "OFF", ""],
    ["LID", f.lid === null ? "--" : `${f.lid.toFixed(0)}°`, ""],
    ["LUX", f.lux === null ? "--" : f.lux.toFixed(1), ""],
    ["LINK", sensor.stale ? "WAIT" : `${sensor.latencyMs.toFixed(0)} ms`, ""],
  ];
}

function renderReadouts(f: SensorFrame) {
  readouts.innerHTML = fmt(f)
    .map(([k, v, s]) => `<div class="cell"><label>${k}</label><b>${v}</b><small>${s}</small></div>`)
    .join("");
}

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = canvas.clientWidth * dpr;
  canvas.height = canvas.clientHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", resize);
resize();

function drawTrace(y0: number, h: number, label: string, now: number, get: (s: Sample) => number, color: string) {
  const w = canvas.clientWidth;
  ctx.strokeStyle = "rgba(60,40,20,.25)";
  ctx.beginPath();
  ctx.moveTo(0, y0 + h / 2);
  ctx.lineTo(w, y0 + h / 2);
  ctx.stroke();
  ctx.fillStyle = "#3c2814";
  ctx.font = "16px 'Special Elite', monospace";
  ctx.fillText(label, 8, y0 + 18);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  hist.forEach((s, i) => {
    const x = w - ((now - s.at) / (SECONDS * 1000)) * w;
    const y = y0 + h / 2 - get(s) * (h / 2 - 6);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

let lastReadout = 0;
function frame(now: number) {
  const f = sensor.latest;
  const live = !sensor.stale;
  hist.push({ at: now, pulse: live && f.contact ? f.pulse_wave : 0, fidget: live ? f.fidget * 2 - 1 : -1 });
  while (hist.length && now - hist[0].at > SECONDS * 1000) hist.shift();

  ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  const h = canvas.clientHeight / 2;
  drawTrace(0, h, "PULSE", now, (s) => s.pulse, "#1d3f8a");
  drawTrace(h, h, "MOVEMENT", now, (s) => s.fidget, "#8a1d1d");

  if (now - lastReadout > 100) {
    lastReadout = now;
    renderReadouts(f);
    lamp.className = "lamp " + (live ? "on" : "off");
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// expose for console debugging
(window as unknown as { sensor: SensorClient }).sensor = sensor;
