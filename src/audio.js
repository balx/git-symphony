import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { MIDIBuilder, BasicMIDI, SpessaSynthProcessor, SpessaSynthSequencer, SoundBankLoader, audioToWav } from 'spessasynth_core';
import { INSTRUMENTS, BACKING } from './compose.js';

// GeneralUser GS v2.0.3 by S. Christian Collins, pinned by commit and checksum.
const SOUNDFONT_URL = 'https://raw.githubusercontent.com/mrbumpy409/GeneralUser-GS/97049183643d5fc5a9322a69c5b09efb667c6c3a/GeneralUser-GS.sf2';
const SOUNDFONT_SHA256 = '9575028c7a1f589f5770fccc8cff2734566af40cd26ed836944e9a5152688cfe';
export const SAMPLE_RATE = 48000;

export async function soundfont(log) {
  const dir = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'git-symphony');
  const file = path.join(dir, 'GeneralUser-GS.sf2');
  if (fs.existsSync(file)) return fs.readFileSync(file);
  log('Downloading the GeneralUser GS soundfont (31 MB, first run only)...');
  const res = await fetch(SOUNDFONT_URL);
  if (!res.ok) throw new Error(`soundfont download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const sha = createHash('sha256').update(buf).digest('hex');
  if (sha !== SOUNDFONT_SHA256) throw new Error(`soundfont checksum mismatch (${sha})`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file + '.tmp', buf);
  fs.renameSync(file + '.tmp', file);
  return buf;
}

// [volume, pan, reverb] per channel; melodic volumes are calibrated to equal loudness
const MIX = [[100, 64, 60], [106, 88, 70], [117, 40, 50], [88, 82, 60], [103, 52, 50], [82, 76, 70], [89, 58, 55], [72, 64, 90], [76, 64, 20], [86, 64, 40], [70, 70, 90]];

export function toMidi(song) {
  const mid = new MIDIBuilder({ format: 1, timeDivision: song.ppq, initialTempo: song.bpm, name: `${song.name} - git-symphony` });
  const names = [...INSTRUMENTS.map((x) => x.name), ...BACKING.map((x) => x.name)];
  song.notes.forEach((notes, ch) => {
    if (!notes.length) return;
    const who = song.contributors.find((c) => c.channel === ch);
    mid.addTrack(who ? `${names[ch]} - ${who.name}` : names[ch]);
    const t = mid.tracks.length - 1;
    const midiCh = ch; // channel 9 is GM drums
    const program = ch < 7 ? INSTRUMENTS[ch].program : BACKING.find((b) => b.channel === ch).program;
    if (ch !== 9) mid.programChange(0, t, midiCh, program);
    const [vol, pan, rev] = MIX[ch];
    mid.controllerChange(0, t, midiCh, 7, vol);
    mid.controllerChange(0, t, midiCh, 10, pan);
    mid.controllerChange(0, t, midiCh, 91, rev);
    const events = [];
    for (const n of notes) events.push([n.tick, 1, n], [n.tick + Math.max(1, n.dur), 0, n]);
    events.sort((a, b) => a[0] - b[0] || a[1] - b[1]); // note-offs first on the same tick
    for (const [tick, on, n] of events) on ? mid.noteOn(tick, t, midiCh, n.pitch, n.vel) : mid.noteOff(tick, t, midiCh, n.pitch);
  });
  return mid.writeMIDI();
}

export async function render(midiBuffer, sf2, tailSec = 3) {
  const synth = new SpessaSynthProcessor(SAMPLE_RATE);
  await synth.ready;
  synth.soundBankManager.addSoundBank(SoundBankLoader.fromArrayBuffer(sf2.buffer.slice(sf2.byteOffset, sf2.byteOffset + sf2.byteLength)), 'main');
  const seq = new SpessaSynthSequencer(synth);
  seq.loadNewSongList([BasicMIDI.fromArrayBuffer(midiBuffer)]);
  seq.play();
  const total = Math.ceil((seq.duration + tailSec) * SAMPLE_RATE);
  const L = new Float32Array(total), R = new Float32Array(total);
  for (let i = 0; i < total; i += 128) {
    seq.processTick();
    synth.process(L, R, i, Math.min(128, total - i));
  }
  return [L, R];
}

// ITU-R BS.1770 integrated loudness (48 kHz K-weighting coefficients).
export function loudness([L, R]) {
  const kweight = (x) => {
    const y = new Float32Array(x.length);
    const stages = [
      [[1.53512485958697, -2.69169618940638, 1.19839281085285], [-1.69065929318241, 0.73248077421585]],
      [[1, -2, 1], [-1.99004745483398, 0.99007225036621]],
    ];
    y.set(x);
    for (const [[b0, b1, b2], [a1, a2]] of stages) {
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (let i = 0; i < y.length; i++) {
        const xi = y[i], yi = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1; x1 = xi; y2 = y1; y1 = yi; y[i] = yi;
      }
    }
    return y;
  };
  const kl = kweight(L), kr = kweight(R);
  const block = 0.4 * SAMPLE_RATE, hop = block / 4, blocks = [];
  for (let s = 0; s + block <= kl.length; s += hop) {
    let sum = 0;
    for (let i = s; i < s + block; i++) sum += kl[i] * kl[i] + kr[i] * kr[i];
    blocks.push(sum / block);
  }
  const lufs = (ms) => -0.691 + 10 * Math.log10(ms);
  const gated = (thr) => blocks.filter((z) => lufs(z) > thr);
  const abs = gated(-70);
  if (!abs.length) return -70;
  const rel = lufs(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const g = gated(Math.max(-70, rel));
  return lufs(g.reduce((a, b) => a + b, 0) / g.length);
}

// Gain to the streaming target (-14 LUFS), then a 5 ms look-ahead peak limiter at -1.5 dBFS.
export function master([L, R], target = -14) {
  const gain = 10 ** ((target - loudness([L, R])) / 20);
  const ceil = 10 ** (-1.5 / 20), look = Math.round(0.005 * SAMPLE_RATE), release = 1 / (0.15 * SAMPLE_RATE);
  const n = L.length, need = new Float32Array(n);
  for (let i = 0; i < n; i++) need[i] = Math.min(1, ceil / (Math.max(Math.abs(L[i]), Math.abs(R[i])) * gain || 1e-9));
  let env = 1;
  const dq = []; // sliding-window minimum over [i, i + look]
  for (let i = 0, j = 0; i < n; i++) {
    for (; j <= Math.min(n - 1, i + look); j++) {
      while (dq.length && need[dq.at(-1)] >= need[j]) dq.pop();
      dq.push(j);
    }
    while (dq[0] < i) dq.shift();
    const g = need[dq[0]];
    env = g < env ? g : Math.min(g, env + release);
    L[i] *= gain * env;
    R[i] *= gain * env;
  }
  // cut the reverb tail once it is inaudible, with a short fade
  let end = n;
  while (end > 0 && Math.max(Math.abs(L[end - 1]), Math.abs(R[end - 1])) < 0.002) end--;
  end = Math.min(n, end + SAMPLE_RATE / 5);
  const fade = SAMPLE_RATE / 2;
  for (let i = end - fade; i < end; i++) {
    L[i] *= (end - i) / fade;
    R[i] *= (end - i) / fade;
  }
  return [L.subarray(0, end), R.subarray(0, end)];
}

export const toWav = (channels) => Buffer.from(audioToWav(channels, SAMPLE_RATE, { normalizeAudio: false }));
