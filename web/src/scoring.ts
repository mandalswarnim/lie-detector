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
  // Each cue has a dead zone so ordinary variation scores 0 and only a clear change counts.
  // Tuned on the M4 recordings: still 6 s windows have fidget p80 ~0 (>0.3 in 3%), a small
  // hand shift ~0.43, a big squirm 0.4-0.45+ with spikes to 1.

  // Movement: 80th percentile of fidget over the window vs the still baseline.
  const fid = pctile(ans.fidget, 0.8);
  const moveDelta = Math.max(0, fid - base.fidget);
  const pFid = clamp((moveDelta - 0.05) / 0.45); // small shift ~0.85, big squirm -> 1

  // Latency: extra hesitation vs this subject's usual (control + earlier answers).
  // Silence counts, but not fully: it can also be a quiet voice or a mic problem.
  const pLat = ans.latency === null ? 0.7 : clamp((ans.latency - base.latency - 0.3) / 1.5);

  // Pitch: relative change of median pitch vs the control question. Octave slips from the
  // detector are folded back; under 8% is normal speech variation.
  let pPitch = 0;
  let pitchPct: number | null = null;
  if (base.pitch > 0 && ans.pitches.length >= 8) {
    const folded = ans.pitches.map((p) => {
      let r = p / base.pitch;
      while (r > 1.6) r /= 2;
      while (r < 0.625) r *= 2;
      return r;
    });
    pitchPct = (median(folded) - 1) * 100;
    pPitch = clamp((Math.abs(pitchPct) - 5) / 15);
  }

  // BPM rise only counts when the pulse was locked both times; +3 is noise.
  let pBpm: number | null = null;
  let bpmDelta: number | null = null;
  if (base.bpm !== null && ans.bpm !== null) {
    bpmDelta = ans.bpm - base.bpm;
    pBpm = clamp((bpmDelta - 3) / 10);
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
  bits.push(f.movePct >= 10 ? `Movement +${f.movePct}%.` : "Movement nominal.");
  bits.push(f.latency === null ? "No answer given." : `${lie ? "Hesitation" : "Answered in"} ${f.latency.toFixed(1)} s.`);
  if (f.pitchPct !== null && Math.abs(f.pitchPct) >= 8)
    bits.push(`Pitch ${f.pitchPct > 0 ? "+" : ""}${Math.round(f.pitchPct)}%.`);
  if (f.bpmDelta !== null && Math.abs(f.bpmDelta) >= 3)
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
