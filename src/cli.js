#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { readRepo } from './git.js';
import { compose } from './compose.js';
import { soundfont, toMidi, render, master, toWav, SAMPLE_RATE } from './audio.js';

const HELP = `Usage: git-symphony <repo> [options]

Turns a git repository's history into music.

Options:
  -l, --length <sec>  length of the piece in seconds (default 60)
  -o, --out <path>    output path without extension (default ./<repo>-symphony)
      --video         also render an .mp4 visualization (needs ffmpeg)
  -h, --help          show this help`;

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    length: { type: 'string', short: 'l', default: '60' },
    out: { type: 'string', short: 'o' },
    video: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});
if (opts.help || positionals.length !== 1) {
  console.log(HELP);
  process.exit(opts.help ? 0 : 1);
}
const seconds = Number(opts.length);
if (!(seconds >= 10 && seconds <= 600)) {
  console.error('--length must be between 10 and 600 seconds');
  process.exit(1);
}

const log = (msg) => console.error(msg);
let t = performance.now();
const step = (msg) => {
  const now = performance.now();
  log(`  ${msg} (${((now - t) / 1000).toFixed(1)}s)`);
  t = now;
};

try {
  const repo = readRepo(path.resolve(positionals[0]));
  step(`read ${repo.commits.length} commits, ${repo.tags.length} tags from ${repo.name}`);
  const song = compose({ ...repo, seconds });
  const noteCount = song.notes.reduce((s, n) => s + n.length, 0);
  step(`composed ${song.bars} bars in ${song.key}, ${noteCount} notes, ${song.contributors.length} instrument${song.contributors.length > 1 ? 's' : ''}, ${song.releases.length} release swells`);

  const out = path.resolve(opts.out || `${repo.name}-symphony`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const midi = toMidi(song);
  fs.writeFileSync(`${out}.mid`, Buffer.from(midi));
  const sf2 = await soundfont(log);
  const audio = master(await render(midi, sf2));
  fs.writeFileSync(`${out}.wav`, toWav(audio));
  step(`wrote ${out}.mid and ${out}.wav`);

  if (opts.video) {
    const { renderVideo } = await import('./video.js');
    await renderVideo(song, `${out}.wav`, `${out}.mp4`, audio[0].length / SAMPLE_RATE);
    step(`wrote ${out}.mp4`);
  }
} catch (e) {
  console.error(`git-symphony: ${e.stderr?.toString().trim() || e.message}`);
  process.exit(1);
}
