// Deception index: weighted, normalised deltas vs the calibration baseline -> 0..100.
// It's theatre built on real signals: every number in the one-liner is measured.

export const WEIGHTS = { fidget: 0.45, latency: 0.25, pitch: 0.15, bpm: 0.15 };

export interface Baseline {
  fidget: number; // mean fidget while still (0..1, usually ~0)
  latency: number; // s, control-question answer latency
  pitch: number; // Hz, median voiced pitch on the control question (0 = unknown)
  bpm: number | null; // locked BPM during calibration, or null
}

export interface Answer {
  fidget: number[]; // fidget samples over the answer window
  latency: number | null; // s from window start to voice onset; null = never spoke
  pitches: number[]; // voiced pitch samples (Hz)
  bpm: number | null; // mean locked BPM during the answer, or null
}

export interface Result {
  index: number; // 0..100
  parts: { fidget: number; latency: number; pitch: number; bpm: number | null }; // each 0..1
  lie: boolean;
  forced: boolean;
  line: string;
  facts: { movePct: number; latency: number | null; pitchPct: number | null; bpmDelta: number | null };
}

const clamp = (x: number, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const pctile = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

export function score(base: Baseline, ans: Answer, threshold: number, force: "T" | "L" | null): Result {
  // Movement: 80th percentile of fidget over the window vs the still baseline.
  // fidget is already normalised against the sensor's stillness baseline.
  const fid = pctile(ans.fidget, 0.8);
  const moveDelta = Math.max(0, fid - base.fidget);
  const pFid = clamp(moveDelta / 0.45);

  // Latency: extra hesitation vs the control question. Silence is suspicious.
  const pLat = ans.latency === null ? 1 : clamp((ans.latency - base.latency - 0.3) / 2.0);

  // Pitch: relative change of median pitch vs control (stress raises it).
  let pPitch = 0;
  let pitchPct: number | null = null;
  if (base.pitch > 0 && ans.pitches.length >= 5) {
    const p = median(ans.pitches);
    pitchPct = ((p - base.pitch) / base.pitch) * 100;
    pPitch = clamp(Math.abs(pitchPct) / 15);
  }

  // BPM rise only counts when the pulse was locked both times.
  let pBpm: number | null = null;
  let bpmDelta: number | null = null;
  if (base.bpm !== null && ans.bpm !== null) {
    bpmDelta = ans.bpm - base.bpm;
    pBpm = clamp(bpmDelta / 10);
  }

  const w = { ...WEIGHTS };
  if (pBpm === null) w.bpm = 0;
  if (base.pitch <= 0) w.pitch = 0;
  const total = w.fidget + w.latency + w.pitch + w.bpm;
  let index =
    (100 * (w.fidget * pFid + w.latency * pLat + w.pitch * pPitch + w.bpm * (pBpm ?? 0))) / total;

  let lie = index >= threshold;
  const forced = force !== null;
  if (force) {
    lie = force === "L";
    // keep the displayed index consistent with the forced verdict
    if (lie && index < threshold) index = Math.min(99, threshold + 8 + Math.random() * 25);
    if (!lie && index >= threshold) index = Math.max(1, threshold - 10 - Math.random() * 25);
  }
  index = Math.round(index);

  const facts = { movePct: Math.round(moveDelta * 100), latency: ans.latency, pitchPct, bpmDelta };
  return { index, parts: { fidget: pFid, latency: pLat, pitch: pPitch, bpm: pBpm }, lie, forced, line: oneLiner(lie, facts), facts };
}

function oneLiner(lie: boolean, f: Result["facts"]): string {
  const bits: string[] = [];
  bits.push(f.movePct >= 5 ? `Movement +${f.movePct}%.` : "Movement nominal.");
  bits.push(f.latency === null ? "No answer given." : `${lie ? "Hesitation" : "Answered in"} ${f.latency.toFixed(1)} s.`);
  if (f.pitchPct !== null && Math.abs(f.pitchPct) >= 4)
    bits.push(`Pitch ${f.pitchPct > 0 ? "+" : ""}${Math.round(f.pitchPct)}%.`);
  if (f.bpmDelta !== null && Math.abs(f.bpmDelta) >= 2)
    bits.push(`Pulse ${f.bpmDelta > 0 ? "+" : ""}${Math.round(f.bpmDelta)}.`);
  const tail = lie
    ? pick([
        "The machine is disappointed in you.",
        "The pens have seen enough.",
        "The machine has notified your mother.",
        "Even the paper is embarrassed.",
        "The needle does not believe you.",
      ])
    : pick([
        "The machine is, reluctantly, satisfied.",
        "Suspiciously honest.",
        "The machine will allow it. This time.",
        "Truth detected. Do not get used to it.",
      ]);
  return `${bits.join(" ")} ${tail}`;
}
