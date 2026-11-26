import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SOUNDFONT_URL, SOUNDFONT_SHA256 } from './audio.js';

/** The soundfont, downloaded once and cached under ~/.cache/git-symphony. */
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
