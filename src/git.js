import { execFileSync } from 'node:child_process';
import path from 'node:path';

const git = (repo, args) =>
  execFileSync('git', ['-C', repo, '-c', 'core.quotePath=false', ...args], {
    encoding: 'utf8',
    maxBuffer: 1 << 30,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

// Top-level directory, or the extension for files at the repo root.
export const area = (p) => (p.includes('/') ? p.slice(0, p.indexOf('/')) : path.extname(p) || p);

/** Parses `git log --numstat --format=%x1e%H%x1f%ct%x1f%aN%x1f%s` output. */
export function parseLog(text) {
  const commits = [];
  for (const chunk of text.split('\x1e')) {
    if (!chunk.trim()) continue;
    const [header, ...lines] = chunk.split('\n');
    const [hash, ct, author, subject = ''] = header.split('\x1f');
    let size = 0;
    const areas = new Map();
    for (const line of lines) {
      const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (!m) continue;
      const n = m[1] === '-' ? 0 : +m[1] + +m[2]; // binary files count as 0 lines
      size += n;
      const a = area(m[3]);
      areas.set(a, (areas.get(a) || 0) + n + 1);
    }
    let dir = '';
    for (const [a, w] of areas) if (w > (areas.get(dir) || 0)) dir = a;
    commits.push({ hash, time: +ct, author, subject, size, dir });
  }
  return commits.sort((a, b) => a.time - b.time); // stable; git order is topological
}

export function readRepo(repo) {
  const top = git(repo, ['rev-parse', '--show-toplevel']).trim();
  const log = git(top, ['log', '--no-merges', '--numstat', '--no-renames', '--format=%x1e%H%x1f%ct%x1f%aN%x1f%s']);
  const tags = git(top, ['for-each-ref', '--format=%(refname:short)%1f%(creatordate:unix)', 'refs/tags'])
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [name, t] = l.split('\x1f');
      return { name, time: +t };
    });
  return { name: repoName(top), commits: parseLog(log), tags };
}

// Name from the origin URL (a clone may live in any folder), else the folder name.
export const nameFromUrl = (url) => url.trim().replace(/\/+$/, '').replace(/\.git$/, '').split(/[/:]/).pop();

function repoName(top) {
  try {
    return nameFromUrl(git(top, ['config', '--get', 'remote.origin.url'])) || path.basename(top);
  } catch {
    return path.basename(top);
  }
}
