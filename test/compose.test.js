import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { compose, tagWeight, sha1u32 } from '../src/compose.js';
import { parseLog, nameFromUrl } from '../src/git.js';

const fake = (n, authors = ['ada', 'bob', 'cy', 'dee', 'eve', 'fay', 'gus', 'hal'], dirs = ['src', 'test', 'docs', '.md']) =>
  Array.from({ length: n }, (_, i) => ({
    hash: `h${i}`,
    time: 1e9 + 86400 * (i + 29 * Math.floor(i / 7)), // uneven gaps
    author: authors[i % authors.length],
    subject: `commit ${i}`,
    size: (i * 37) % 3000,
    dir: dirs[i % dirs.length],
  }));
const NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const pitched = (song) => song.notes.flatMap((n, ch) => (ch === 9 ? [] : n));

test('every pitched note stays in the key', () => {
  for (const n of [1, 5, 200, 3000]) {
    const song = compose({ commits: fake(n), seconds: 60 });
    const root = NAMES.indexOf(song.key.split(' ')[0]);
    for (const note of pitched(song)) assert.ok(MAJOR.includes((note.pitch - root + 120) % 12), `${note.pitch} not in ${song.key}`);
  }
});

test('timeline is compressed to the requested length', () => {
  for (const seconds of [30, 60, 90]) {
    const song = compose({ commits: fake(500), seconds });
    assert.ok(Math.abs(song.seconds - seconds) <= 2.7, `${song.seconds} vs ${seconds}`); // within one bar
    const end = song.seconds / song.tickSec;
    for (const n of song.notes.flat()) assert.ok(n.tick >= 0 && n.tick + n.dur <= end);
    const melody = song.notes.slice(0, 7).flat().map((n) => n.tick);
    assert.equal(Math.min(...melody), 0); // first commit opens the piece
    assert.ok(Math.max(...melody) >= end - 2 * 1920 * 1.01); // last commit lands just before the closing bar
  }
});

test('top 6 contributors get their own instrument, everyone else shares one', () => {
  const authors = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'A1'];
  const commits = fake(300, authors);
  const song = compose({ commits, seconds: 60 });
  assert.equal(song.contributors.length, 7);
  assert.deepEqual(song.contributors.map((c) => c.channel), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(new Set(song.contributors.map((c) => c.instrument)).size, 7);
  assert.equal(song.contributors[6].name, '2 others');
  assert.equal(song.contributors.filter((c) => c.name.toLowerCase() === 'a1').length, 1); // case-insensitive merge
  for (const ch of [0, 1, 2, 3, 4, 5, 6]) for (const n of song.notes[ch]) assert.ok(n.commit);
});

test('one-commit repo still makes a full piece', () => {
  const song = compose({ commits: fake(1), seconds: 45 });
  assert.equal(song.contributors.length, 1);
  assert.equal(song.notes[0].length, 1);
  assert.ok(song.notes[7].length >= song.bars); // strings play every bar
  assert.ok(song.notes[8].length >= song.bars); // so does the bass
});

test('binary-only and merge-free logs parse', () => {
  const log = '\x1eaaa\x1f100\x1fAda\x1fadd logo\n\n-\t-\tassets/logo.png\n-\t-\tfavicon.ico\n\x1ebbb\x1f50\x1fBob\x1finit\n\n3\t0\tREADME.md\n\x1eccc\x1f200\x1fBob\x1fempty\n';
  const commits = parseLog(log);
  assert.deepEqual(commits.map((c) => c.hash), ['bbb', 'aaa', 'ccc']); // sorted by time
  assert.equal(commits[1].size, 0);
  assert.equal(commits[1].dir, 'assets');
  assert.equal(commits[0].dir, '.md');
  assert.equal(commits[2].dir, '');
  const song = compose({ commits, seconds: 30 });
  assert.equal(new Set(song.notes.slice(0, 7).flat().map((n) => n.commit.hash)).size, 3); // one note (or chord) each
});

test('empty history is an error', () => {
  assert.throws(() => compose({ commits: [] }), /no commits/);
});

test('deterministic', () => {
  const commits = fake(800);
  const args = { commits, tags: [{ name: 'v1.0.0', time: commits[300].time }], seconds: 60 };
  assert.deepEqual(compose(args), compose(args));
});

test('release tags', () => {
  assert.deepEqual(['v2.0.0', '1.2', 'v1.2.3', 'v2.1.0-rc1', 'nightly'].map(tagWeight), [3, 2, 1, 0, 0]);
  const commits = fake(400);
  const song = compose({ commits, tags: [{ name: 'v1.0.0', time: commits[200].time }], seconds: 60 });
  assert.equal(song.releases.length, 1);
  assert.ok(song.notes[10].length === 3); // bell motif
});

test('repo name comes from the origin URL in any form', () => {
  for (const u of ['https://github.com/kubernetes/kubernetes.git', 'git@github.com:kubernetes/kubernetes.git', 'https://github.com/kubernetes/kubernetes/', 'ssh://git@host/x/kubernetes\n']) {
    assert.equal(nameFromUrl(u), 'kubernetes');
  }
});

test('pure SHA-1 matches node:crypto', () => {
  const cases = ['', 'a', 'src', 'héllo ✓ 漢字', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'y'.repeat(1000), 0.123456789, 'e83c5163316f89bfbde7d9ab23ca2e25604af290'];
  for (const s of cases) assert.equal(sha1u32(s), createHash('sha1').update(String(s)).digest().readUInt32BE(0), String(s));
});
