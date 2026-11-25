import { createHash } from 'node:crypto';

export const BPM = 90;
export const PPQ = 480;
const SLOT = PPQ / 2; // the grid is 8th notes, 8 slots per bar
const BAR_SEC = 240 / BPM;

const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const PENTATONIC = [0, 2, 4, 7, 9];
const KEYS = [0, 2, 3, 5, 7, 9]; // C D Eb F G A major
const KEY_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const PROGRESSIONS = [
  [0, 4, 5, 3], // I V vi IV
  [5, 3, 0, 4], // vi IV I V
  [0, 5, 3, 4], // I vi IV V
  [3, 0, 4, 5], // IV I V vi
];

// Channels 0-5: top contributors, 6: everyone else, 7: pad, 8: bass, 9: drums, 10: release bells.
export const INSTRUMENTS = [
  { name: 'Piano', program: 0, lo: 60, hi: 84 },
  { name: 'Celesta', program: 8, lo: 72, hi: 93 },
  { name: 'Pizzicato', program: 45, lo: 55, hi: 79 },
  { name: 'Harp', program: 46, lo: 60, hi: 84 },
  { name: 'Marimba', program: 12, lo: 60, hi: 84 },
  { name: 'Vibraphone', program: 11, lo: 64, hi: 86 },
  { name: 'Nylon guitar', program: 24, lo: 52, hi: 76 },
];
export const BACKING = [
  { channel: 7, name: 'Strings', program: 48 },
  { channel: 8, name: 'Bass', program: 32 },
  { channel: 9, name: 'Drums', program: 0 },
  { channel: 10, name: 'Tubular bells', program: 14 },
];
export const COLORS = ['#ff6b6b', '#4cc9f0', '#ffd166', '#c77dff', '#06d6a0', '#ff9f1c', '#8b95a7'];

const BASS_PATTERNS = [ // [slot, semitones above root, length in slots] per density level
  [[0, 0, 8]],
  [[0, 0, 4], [4, 7, 4]],
  [[0, 0, 3], [3, 0, 1], [4, 7, 3], [7, 12, 1]],
  [[0, 0, 2], [2, 0, 1], [3, 0, 1], [4, 7, 2], [6, 7, 1], [7, 12, 1]],
];
const PHRASE = [0, 2, 4, 3, 5, 4, 2, 1]; // melodic contour over one bar, in scale steps
const KICK = 36, STICK = 37, SNARE = 38, HAT = 42, OPEN_HAT = 46, CRASH = 49, CRASH2 = 57;

const hash01 = (s) => createHash('sha1').update(String(s)).digest().readUInt32BE(0) / 2 ** 32;
const nearest = (target, lo, hi, pcs) => {
  let best = null;
  for (let p = lo; p <= hi; p++)
    if (pcs.includes(p % 12) && (best === null || Math.abs(p - target) < Math.abs(best - target))) best = p;
  return best;
};

// How "big" a release tag is: 3 = X.0(.0), 2 = X.Y(.0), 1 = patch, 0 = not a plain version (rc, beta, ...).
export const tagWeight = (name) => {
  const m = name.match(/^[a-z_-]*?v?(\d+)\.(\d+)(?:\.(\d+))?$/i);
  if (!m) return 0;
  return +(m[3] || 0) ? 1 : +m[2] ? 2 : 3;
};

/**
 * Pure mapping from git history to music.
 * commits: [{hash, time, author, subject, size, dir}] sorted by time.
 * Returns MIDI-ready notes per channel (ticks) plus timing data for the video.
 */
export function compose({ name = 'repo', commits, tags = [], seconds = 60 }) {
  if (!commits.length) throw new Error('repository has no commits');
  const seed = hash01(commits[0].hash);
  const key = KEYS[Math.floor(seed * KEYS.length)];
  const prog = PROGRESSIONS[Math.floor(hash01(seed) * PROGRESSIONS.length)];
  const bars = Math.max(4, Math.round(seconds / BAR_SEC)); // last bar is the closing chord
  const body = bars - 1;
  const slots = body * 8;

  const chordDegree = (bar) => (bar === bars - 1 ? 0 : bar === bars - 2 ? 4 : prog[bar % 4]);
  const chord = (bar) => {
    const d = chordDegree(bar);
    return [d, d + 2, d + 4].map((i) => (key + MAJOR[i % 7]) % 12);
  };
  const scale = PENTATONIC.map((s) => (key + s) % 12);

  // Timeline: half real time, half commit order, so quiet years shrink but still show.
  const t0 = commits[0].time, t1 = commits.at(-1).time, n = commits.length;
  const pos = commits.map((c, i) => 0.5 * (t1 > t0 ? (c.time - t0) / (t1 - t0) : 0) + 0.5 * (n > 1 ? i / (n - 1) : 0));
  const slotOf = (p) => Math.min(slots - 1, Math.floor(p * slots));
  const posAtTime = (t) => { // for tags
    if (t <= t0) return 0;
    if (t >= t1) return 1;
    let i = commits.findIndex((c) => c.time > t);
    const a = commits[i - 1], b = commits[i];
    const f = b.time > a.time ? (t - a.time) / (b.time - a.time) : 0;
    return pos[i - 1] + f * (pos[i] - pos[i - 1]);
  };

  // Contributors -> instruments
  const who = (c) => c.author.toLowerCase();
  const counts = new Map(), display = new Map();
  for (const c of commits) {
    counts.set(who(c), (counts.get(who(c)) || 0) + 1);
    if (!display.has(who(c))) display.set(who(c), c.author);
  }
  const ranked = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const channelOf = new Map(ranked.map(([a], i) => [a, Math.min(i, 6)]));
  const contributors = ranked.slice(0, 6).map(([a, count], i) => ({ name: display.get(a), count, channel: i, instrument: INSTRUMENTS[i].name, color: COLORS[i] }));
  if (ranked.length > 6)
    contributors.push({ name: `${ranked.length - 6} others`, count: ranked.slice(6).reduce((s, x) => s + x[1], 0), channel: 6, instrument: INSTRUMENTS[6].name, color: COLORS[6] });

  // Activity density per bar -> texture level 0..3
  const perBar = new Array(body).fill(0);
  pos.forEach((p) => perBar[Math.floor(slotOf(p) / 8)]++);
  const smooth = perBar.map((_, i) => {
    const w = perBar.slice(Math.max(0, i - 2), i + 3);
    return w.reduce((a, b) => a + b, 0) / w.length;
  });
  const busy = smooth.filter((v) => v > 0).sort((a, b) => a - b);
  // quiet stretches -> 0, then the busiest third of the piece -> 3; the first bars build up
  const level = smooth.map((v, i) => (v ? Math.min(i + 1, 1 + Math.floor((3 * busy.indexOf(v)) / busy.length)) : 0));

  const notes = Array.from({ length: 11 }, () => []); // per channel: {tick, dur, pitch, vel, commit?}
  const add = (ch, slot, len, pitch, vel, commit) =>
    notes[ch].push({ tick: Math.round(slot * SLOT), dur: Math.round(len * SLOT), pitch, vel: Math.round(vel), commit });

  // Melody: one note per contributor per 8th (their biggest commit there). Busier bars allow more
  // voices; bigger commits go first, and "everyone else" keeps one seat once there are two.
  const bySlot = new Map();
  pos.forEach((p, i) => {
    const s = slotOf(p);
    if (!bySlot.has(s)) bySlot.set(s, new Map());
    const m = bySlot.get(s), ch = channelOf.get(who(commits[i]));
    if (!m.has(ch) || commits[i].size > m.get(ch).size) m.set(ch, commits[i]);
  });
  const picks = [...bySlot].sort((a, b) => a[0] - b[0]).flatMap(([s, m]) => {
    const voices = Math.max(1, level[Math.floor(s / 8)]);
    const entries = [...m].sort((a, b) => b[1].size - a[1].size || a[0] - b[0]);
    const named = entries.filter(([ch]) => ch < 6), others = entries.find(([ch]) => ch === 6);
    const chosen = !others ? named.slice(0, voices) : voices >= 2 || !named.length ? [...named.slice(0, voices - 1), others] : named.slice(0, 1);
    return chosen.map(([ch, c]) => ({ s, ch, c }));
  });
  // Size is ranked within the piece, so every repo gets the full dynamic range.
  const sizes = picks.map((p) => p.c.size).sort((a, b) => a - b);
  const rank = (size) => (sizes.length > 1 ? sizes.findIndex((x) => x >= size) / (sizes.length - 1) : 0.5);
  const ladders = INSTRUMENTS.map((x) => Array.from({ length: x.hi - x.lo + 1 }, (_, i) => x.lo + i).filter((p) => scale.includes(p % 12)));
  const ringing = new Map(); // `${ch}:${pitch}` -> note, to avoid overlapping identical notes
  for (const { s, ch, c } of picks) {
    const bar = Math.floor(s / 8), inBar = s % 8, harmony = chord(bar), inst = INSTRUMENTS[ch];
    const r = rank(c.size), huge = r >= 0.97 && c.size > 0;
    const len = Math.min(8 - inBar, huge ? 8 : r < 0.5 ? 1 : r < 0.8 ? 2 : 4);
    const vel = 56 + 50 * r;
    // the directory picks the starting note, a fixed phrase shape moves it through the bar
    const ladder = ladders[ch], step = PHRASE[(inBar + 3 * ch) % 8];
    let pitch = ladder[Math.min(ladder.length - 1, Math.floor(hash01(c.dir) * 5) + step)];
    if (inBar % 2 === 0 || len >= 2) pitch = nearest(pitch, inst.lo, inst.hi, harmony); // on the beat: chord tones only
    const chordNotes = [pitch];
    if (huge) // the biggest commits: a full chord below the melody note
      for (let p = pitch - 1; chordNotes.length < 3 && p >= inst.lo - 12; p--) if (harmony.includes(p % 12)) chordNotes.push(p);
    for (const p of chordNotes) {
      const prev = ringing.get(`${ch}:${p}`);
      if (prev && prev.tick + prev.dur > s * SLOT) prev.dur = s * SLOT - prev.tick;
      add(ch, s, len, p, p === pitch ? vel : vel - 12, c);
      ringing.set(`${ch}:${p}`, notes[ch].at(-1));
    }
  }

  // Backing: strings + bass follow the chords, drums join as activity grows.
  for (let bar = 0; bar < bars; bar++) {
    const harmony = chord(bar), root = harmony[0], s0 = bar * 8;
    const coda = bar === bars - 1, lvl = coda ? 1 : level[bar];
    for (const pc of harmony) add(7, s0, 8, 55 + ((pc - 7 + 12) % 12), 46 + 8 * lvl);
    if (lvl >= 2) add(7, s0, 8, 67 + ((root - 7 + 12) % 12), 40 + 6 * lvl);
    const bassRoot = 35 + ((root - 11 + 12) % 12);
    for (const [s, iv, len] of coda ? [[0, 0, 8]] : BASS_PATTERNS[lvl]) add(8, s0 + s, len, bassRoot + iv, 72 + 6 * lvl - (s % 2) * 10);
    if (coda) {
      add(7, s0, 8, 67 + ((root - 7 + 12) % 12), 60);
      add(9, s0, 1, CRASH, 70);
      continue;
    }
    if (bar === 0 || lvl === 0) continue;
    add(9, s0, 1, KICK, 82);
    add(9, s0 + 4, 1, KICK, 72);
    if (lvl >= 2) for (let s = 0; s < 8; s++) add(9, s0 + s, 1, HAT, s % 2 ? 34 : 48);
    if (lvl === 2) [2, 6].forEach((s) => add(9, s0 + s, 1, STICK, 58));
    if (lvl === 3) {
      add(9, s0 + 3, 1, KICK, 62);
      [2, 6].forEach((s) => add(9, s0 + s, 1, SNARE, 74));
      add(9, s0 + 7, 1, OPEN_HAT, 44);
    }
  }

  // Releases: a cymbal swell into the bar, then a bell motif. At most one every 4 bars.
  const releases = [];
  const candidates = tags
    .map((t) => ({ ...t, weight: tagWeight(t.name), bar: Math.floor(slotOf(posAtTime(t.time)) / 8) }))
    .filter((t) => t.weight > 0 && t.bar > 0);
  const gap = (t) => Math.min(Infinity, ...releases.map((r) => Math.abs(r.bar - t.bar)));
  while (releases.length < Math.max(1, Math.floor(body / 6))) {
    // biggest release first, then the one farthest from those already chosen
    const next = candidates.filter((t) => gap(t) >= 4).sort((a, b) => b.weight - a.weight || gap(b) - gap(a) || a.time - b.time)[0];
    if (!next) break;
    releases.push(next);
  }
  releases.sort((a, b) => a.bar - b.bar);
  for (const r of releases) {
    const s0 = r.bar * 8, root = chord(r.bar)[0];
    for (let i = 0; i < 8; i++) notes[9].push({ tick: (s0 - 4) * SLOT + i * (SLOT / 2), dur: SLOT / 2, pitch: CRASH, vel: 20 + i * 8 });
    add(9, s0, 2, CRASH2, 96);
    const bell = 60 + ((root - 0 + 12) % 12);
    [[0, 0], [2, 7], [4, 12]].forEach(([s, iv]) => add(10, s0 + s, 4, bell + iv, 78));
  }

  for (const ch of notes) ch.sort((a, b) => a.tick - b.tick || a.pitch - b.pitch);
  const barTicks = 8 * SLOT;
  return {
    name,
    bpm: BPM,
    ppq: PPQ,
    key: `${KEY_NAMES[key]} major`,
    progression: prog,
    bars,
    seconds: bars * BAR_SEC,
    tickSec: 60 / BPM / PPQ,
    notes,
    level,
    contributors,
    releases: releases.map((r) => ({ name: r.name, tick: r.bar * barTicks })),
    // commit timeline for the video: when (in seconds) each commit's moment passes
    timeline: commits.map((c, i) => ({ sec: pos[i] * body * BAR_SEC, time: c.time })),
  };
}
