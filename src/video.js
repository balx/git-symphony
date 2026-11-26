import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createCanvas } from '@napi-rs/canvas';
import { W, H, FPS, prepare, drawFrame } from './frame.js';

export async function renderVideo(song, wavPath, outPath, duration) {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  } catch {
    throw new Error('--video needs ffmpeg on your PATH (e.g. brew install ffmpeg)');
  }
  const ff = spawn('ffmpeg', [
    '-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-r', String(FPS), '-i', '-',
    '-i', wavPath, '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', '-fflags', '+bitexact', outPath,
  ], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = once(ff, 'close');

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const state = prepare(song);
  const frames = Math.ceil(duration * FPS);
  for (let f = 0; f < frames; f++) {
    drawFrame(ctx, state, f / FPS, duration);
    if (!ff.stdin.write(Buffer.from(canvas.data()))) await once(ff.stdin, 'drain');
  }
  ff.stdin.end();
  const [code] = await done;
  if (code !== 0) throw new Error(`ffmpeg exited with code ${code}`);
}
