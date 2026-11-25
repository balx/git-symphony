import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createCanvas } from '@napi-rs/canvas';

const W = 1280, H = 720, FPS = 30;
const PLAYHEAD = 400, PPS = 170; // playhead x, pixels per second
const ROLL_TOP = 132, ROLL_BOTTOM = 512;
const SANS = '"Helvetica Neue", Helvetica, Arial, sans-serif';
const MONO = '"SF Mono", Menlo, Consolas, monospace';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const rgba = (hex, a) => `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a})`;
const ease = (x) => 1 - (1 - Math.min(1, Math.max(0, x))) ** 3;

function fit(ctx, text, width) {
  if (ctx.measureText(text).width <= width) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(text.slice(0, mid) + '…').width <= width) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo).trimEnd() + '…';
}

export async function renderVideo(song, wavPath, outPath, duration) {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  } catch {
    throw new Error('--video needs ffmpeg on your PATH (e.g. brew install ffmpeg)');
  }
  const color = (ch) => song.contributors.find((c) => c.channel === ch)?.color ?? '#8b95a7';
  const notes = song.notes
    .slice(0, 7)
    .flatMap((list, ch) => list.map((n) => ({ t0: n.tick * song.tickSec, t1: (n.tick + n.dur) * song.tickSec, pitch: n.pitch, vel: n.vel, ch, color: color(ch), commit: n.commit })))
    .sort((a, b) => a.t0 - b.t0);
  const lo = Math.min(...notes.map((n) => n.pitch), 60) - 2, hi = Math.max(...notes.map((n) => n.pitch), 72) + 2;
  const rowH = (ROLL_BOTTOM - ROLL_TOP) / (hi - lo + 1);
  const y = (p) => ROLL_BOTTOM - (p - lo + 1) * rowH;
  const releases = song.releases.map((r) => ({ name: r.name, t: r.tick * song.tickSec }));

  // one caption per beat: the biggest commit that sounds in it
  const captions = [];
  for (const n of notes) {
    const beat = Math.floor(n.t0 / (60 / song.bpm));
    const last = captions.at(-1);
    if (last?.beat === beat) {
      if (n.commit.size > last.commit.size) Object.assign(last, { commit: n.commit, color: n.color });
    } else captions.push({ beat, t: n.t0, commit: n.commit, color: n.color });
  }

  const dateAt = (t) => {
    const tl = song.timeline;
    let i = tl.findIndex((e) => e.sec > t);
    if (i === -1) i = tl.length;
    const unix = i === 0 ? tl[0].time : tl[i - 1].time;
    const d = new Date(unix * 1000);
    return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  };

  const ff = spawn('ffmpeg', [
    '-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-r', String(FPS), '-i', '-',
    '-i', wavPath, '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', '-fflags', '+bitexact', outPath,
  ], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = once(ff, 'close');

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#0f1522');
  bg.addColorStop(1, '#07090f');

  let first = 0; // index of the first note that may still be visible
  const frames = Math.ceil(duration * FPS);
  for (let f = 0; f < frames; f++) {
    const t = f / FPS;
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // header
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#6b7689';
    ctx.font = `600 13px ${SANS}`;
    ctx.textAlign = 'left';
    ctx.fillText('G I T - S Y M P H O N Y', 48, 50);
    ctx.textAlign = 'right';
    ctx.fillText(`${song.key.toUpperCase()}  ·  ${song.bpm} BPM`, W - 48, 50);
    ctx.fillStyle = '#e8edf5';
    ctx.font = `700 36px ${SANS}`;
    ctx.textAlign = 'left';
    ctx.fillText(fit(ctx, song.name, 700), 48, 92);
    ctx.textAlign = 'right';
    ctx.font = `600 36px ${MONO}`;
    ctx.fillText(dateAt(t), W - 48, 92);

    // octave guide lines
    ctx.fillStyle = 'rgba(255,255,255,0.035)';
    for (let p = lo; p <= hi; p++) if (p % 12 === 0) ctx.fillRect(0, Math.round(y(p) + rowH), W, 1);

    // releases
    ctx.font = `600 12px ${MONO}`;
    ctx.textAlign = 'left';
    for (const r of releases) {
      const x = PLAYHEAD + (r.t - t) * PPS;
      if (x < -200 || x > W + 10) continue;
      const flash = t >= r.t ? Math.max(0, 1 - (t - r.t) / 1.5) : 0;
      ctx.fillStyle = `rgba(255,214,102,${0.25 + 0.6 * flash})`;
      for (let yy = ROLL_TOP - 6; yy < ROLL_BOTTOM; yy += 8) ctx.fillRect(Math.round(x), yy, 1.5, 4);
      ctx.fillStyle = `rgba(255,214,102,${0.6 + 0.4 * flash})`;
      ctx.fillText(r.name, x + 6, ROLL_TOP - 2);
    }

    // notes
    while (first < notes.length && notes[first].t1 < t - PLAYHEAD / PPS) first++;
    const playing = new Set();
    for (let i = first; i < notes.length; i++) {
      const n = notes[i];
      const x = PLAYHEAD + (n.t0 - t) * PPS;
      if (x > W) break;
      const w = Math.max(4, (n.t1 - n.t0) * PPS - 3), h = Math.max(6, rowH * 0.9);
      const active = t >= n.t0 && t < n.t1;
      const yy = y(n.pitch) + (rowH - h) / 2;
      if (active) {
        playing.add(n.ch);
        ctx.shadowColor = n.color;
        ctx.shadowBlur = 16;
        ctx.fillStyle = n.color;
      } else {
        ctx.fillStyle = rgba(n.color, t > n.t1 ? 0.28 : 0.6);
      }
      ctx.beginPath();
      ctx.roundRect(x, yy, w, h, Math.min(3, h / 2));
      ctx.fill();
      ctx.shadowBlur = 0;
      // a ripple on the playhead when the note starts
      const age = t - n.t0;
      if (age >= 0 && age < 0.5) {
        ctx.strokeStyle = rgba(n.color, 0.7 * (1 - age / 0.5));
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(PLAYHEAD, yy + h / 2, 4 + ease(age / 0.5) * (10 + n.vel / 6), 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // playhead
    const ph = ctx.createLinearGradient(0, ROLL_TOP - 10, 0, ROLL_BOTTOM + 10);
    ph.addColorStop(0, 'rgba(255,255,255,0)');
    ph.addColorStop(0.5, 'rgba(255,255,255,0.55)');
    ph.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = ph;
    ctx.fillRect(PLAYHEAD - 1, ROLL_TOP - 10, 2, ROLL_BOTTOM - ROLL_TOP + 20);

    // commit captions, newest at the bottom
    let c = captions.length;
    while (c > 0 && captions[c - 1].t > t) c--;
    const shown = captions.slice(Math.max(0, c - 4), c);
    ctx.textAlign = 'left';
    shown.forEach((cap, i) => {
      const age = t - cap.t, rank = shown.length - 1 - i;
      const alpha = ease(age / 0.25) * [1, 0.55, 0.32, 0.16][rank];
      const yy = 662 - rank * 30 + (1 - ease(age / 0.25)) * 10;
      ctx.fillStyle = rgba(cap.color, alpha);
      ctx.beginPath();
      ctx.arc(54, yy - 5, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = `600 16px ${SANS}`;
      const author = fit(ctx, cap.commit.author, 180);
      ctx.fillText(author, 68, yy);
      const aw = ctx.measureText(author).width;
      ctx.fillStyle = `rgba(214,222,235,${alpha})`;
      ctx.font = `400 16px ${SANS}`;
      ctx.fillText(fit(ctx, cap.commit.subject, 760 - aw - 80), 68 + aw + 12, yy);
    });

    // legend
    ctx.font = `500 13px ${SANS}`;
    song.contributors.forEach((who, i) => {
      const yy = 560 + i * 18 + (7 - song.contributors.length) * 9;
      const on = playing.has(who.channel);
      ctx.fillStyle = rgba(who.color, on ? 1 : 0.55);
      ctx.beginPath();
      ctx.arc(W - 48 - 6 - 0, yy - 4, on ? 5 : 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.textAlign = 'right';
      ctx.fillStyle = on ? '#e8edf5' : '#8892a4';
      ctx.fillText(`${fit(ctx, who.name, 170)}  ·  ${who.instrument}`, W - 66, yy);
    });

    // progress
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(0, H - 4, W, 4);
    const prog = ctx.createLinearGradient(0, 0, W, 0);
    prog.addColorStop(0, '#4cc9f0');
    prog.addColorStop(1, '#c77dff');
    ctx.fillStyle = prog;
    ctx.fillRect(0, H - 4, (W * t) / duration, 4);

    if (!ff.stdin.write(Buffer.from(canvas.data()))) await once(ff.stdin, 'drain');
  }
  ff.stdin.end();
  const [code] = await done;
  if (code !== 0) throw new Error(`ffmpeg exited with code ${code}`);
}
