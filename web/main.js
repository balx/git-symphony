import { compose } from '../src/compose.js';
import { toMidi, toWav, SAMPLE_RATE } from '../src/audio.js';
import { W, H, FPS, prepare, drawFrame } from '../src/frame.js';
import { fetchRepo, parseRepo } from '../src/github.js';

const $ = (id) => document.getElementById(id);
const form = $('form'), repoInput = $('repo'), lengthInput = $('length'), tokenInput = $('token'), tokenBox = $('token-box');
const playBtn = $('play'), canvas = $('stage'), hint = $('hint'), status = $('status'), bar = $('bar'), actions = $('actions');
const pauseBtn = $('pause'), replayBtn = $('replay'), videoBtn = $('save-video'), wavBtn = $('save-wav'), midBtn = $('save-mid');

const store = {
  get: (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

// --- history cache (IndexedDB): reloading a repo only costs one request while its branch has not moved ---
const idb = (mode, fn) =>
  new Promise((resolve, reject) => {
    const open = indexedDB.open('git-symphony', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('repos');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction('repos', mode), req = fn(tx.objectStore('repos'));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
    };
  });
const cacheGet = (k) => idb('readonly', (s) => s.get(k)).catch(() => undefined);
const cachePut = (k, v) => idb('readwrite', (s) => s.put(v, k)).catch(() => {});

// --- ui state ---
function setStatus(text, progress = null, error = false) {
  status.textContent = text;
  status.classList.toggle('error', error);
  bar.hidden = progress === null;
  if (progress !== null) bar.firstElementChild.style.transform = `scaleX(${Math.min(1, progress)})`;
}
const busy = (on) => {
  playBtn.disabled = on;
  for (const b of [pauseBtn, replayBtn, videoBtn, wavBtn, midBtn]) b.disabled = on;
};
const fmt = (n) => n.toLocaleString('en-US');
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// --- canvas: 1280x720 drawing space, rendered sharp on high-density screens ---
const ctx = canvas.getContext('2d');
let scale = 1;
function sizeCanvas(s) {
  scale = s;
  canvas.width = W * s;
  canvas.height = H * s;
}
sizeCanvas(Math.min(2, Math.ceil(window.devicePixelRatio || 1)));

// --- audio ---
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
let audioCtx, piece; // piece: { song, state, buffer, duration, midi, name }
let source, startedAt = 0, raf = 0, recorder = null;

const MB = 1024 * 1024;
function renderAudio(midi) {
  return new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') setStatus(`Loading instruments, first time only (${(data.got / MB).toFixed(0)} of ${(data.total / MB).toFixed(0)} MB)`, data.got / data.total);
      if (data.type === 'rendering') setStatus('Rendering audio');
      if (data.type === 'done') resolve([data.L, data.R]);
      if (data.type === 'error') reject(new Error(data.message));
    };
    worker.postMessage({ type: 'render', midi }, [midi]);
  });
}

function frame() {
  const t = Math.min(audioCtx.currentTime - startedAt, piece.duration);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  drawFrame(ctx, piece.state, Math.max(0, t), piece.duration);
  if (recorder) setStatus(`Recording the video in real time (${clock(t)} of ${clock(piece.duration)})`, t / piece.duration);
  raf = t < piece.duration ? requestAnimationFrame(frame) : 0;
}

function start(extraOutput) {
  source?.stop();
  source = audioCtx.createBufferSource();
  source.buffer = piece.buffer;
  source.connect(audioCtx.destination);
  if (extraOutput) source.connect(extraOutput);
  const ended = new Promise((r) => (source.onended = r));
  audioCtx.resume();
  startedAt = audioCtx.currentTime + 0.05;
  source.start(startedAt);
  pauseBtn.textContent = 'Pause';
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(frame);
  return ended;
}

function save(blob, filename) {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

// --- main flow ---
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  let key;
  try {
    const { owner, repo } = parseRepo(repoInput.value);
    key = `${owner}/${repo}`.toLowerCase();
  } catch (err) {
    setStatus('Enter a repository as owner/name, for example expressjs/express, or paste its GitHub URL.', null, true);
    repoInput.focus();
    return;
  }
  const token = tokenInput.value.trim();
  if (!token) {
    tokenBox.open = true;
    setStatus('Add a GitHub token to read the history (see "GitHub token" above).', null, true);
    tokenInput.focus();
    return;
  }
  audioCtx ??= new AudioContext();
  audioCtx.resume(); // inside the click, so browsers allow sound later
  source?.stop();
  busy(true);
  hint.hidden = true;
  canvas.parentElement.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  worker.postMessage({ type: 'preload' }); // download instruments while the history loads
  history.replaceState(null, '', `?repo=${encodeURIComponent(key)}`);
  try {
    setStatus('Reading the commit history', 0);
    const cached = await cacheGet(key);
    const t0 = performance.now();
    const repo = await fetchRepo(key, token, {
      cached,
      onProgress: ({ done, total }) => {
        const secs = (performance.now() - t0) / 1000, left = done > 300 ? (secs / done) * (total - done) : null;
        setStatus(`Reading the commit history (${fmt(done)} of ${fmt(total)} commits${left > 20 ? `, about ${clock(left)} left` : ''})`, done / total);
      },
    });
    store.set('token', token);
    tokenBox.open = false;
    if (repo !== cached) cachePut(key, repo);
    const seconds = Number(lengthInput.value);
    const song = compose({ ...repo, seconds });
    const midi = toMidi(song);
    const [L, R] = await renderAudio(midi.slice(0));
    const buffer = audioCtx.createBuffer(2, L.length, SAMPLE_RATE);
    buffer.copyToChannel(L, 0);
    buffer.copyToChannel(R, 1);
    piece = { song, state: prepare(song), buffer, duration: L.length / SAMPLE_RATE, midi, L, R, name: `${repo.name}-symphony` };
    setStatus(`${repo.name}: ${fmt(repo.commits.length)} commits by ${fmt(new Set(repo.commits.map((c) => c.author.toLowerCase())).size)} people, in ${song.key}`);
    actions.hidden = false;
    busy(false);
    start();
  } catch (err) {
    busy(false);
    actions.hidden = !piece;
    hint.hidden = !!piece; // keep the empty-state message until something has played
    setStatus(err.message, null, true);
  }
});

pauseBtn.addEventListener('click', () => {
  if (!piece) return;
  if (!raf) return start(); // finished: play again
  if (audioCtx.state === 'running') {
    audioCtx.suspend();
    pauseBtn.textContent = 'Resume';
  } else {
    audioCtx.resume();
    pauseBtn.textContent = 'Pause';
  }
});
replayBtn.addEventListener('click', () => piece && start());
wavBtn.addEventListener('click', () => save(new Blob([toWav([piece.L, piece.R])], { type: 'audio/wav' }), `${piece.name}.wav`));
midBtn.addEventListener('click', () => save(new Blob([piece.midi], { type: 'audio/midi' }), `${piece.name}.mid`));

const VIDEO_TYPES = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'];
const videoType = typeof MediaRecorder !== 'undefined' && VIDEO_TYPES.find((t) => MediaRecorder.isTypeSupported(t));
if (!videoType) videoBtn.remove();

videoBtn.addEventListener('click', async () => {
  busy(true);
  const hiDpi = scale;
  sizeCanvas(1); // record at 1280x720, like the command-line video
  const dest = audioCtx.createMediaStreamDestination();
  const stream = new MediaStream([...canvas.captureStream(FPS).getVideoTracks(), ...dest.stream.getAudioTracks()]);
  const chunks = [];
  recorder = new MediaRecorder(stream, { mimeType: videoType, videoBitsPerSecond: 8_000_000 });
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise((r) => (recorder.onstop = r));
  recorder.start(1000);
  await start(dest);
  recorder.stop();
  await stopped;
  recorder = null;
  stream.getTracks().forEach((t) => t.stop());
  sizeCanvas(hiDpi);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  drawFrame(ctx, piece.state, piece.duration, piece.duration);
  const type = videoType.split(';')[0];
  save(new Blob(chunks, { type }), `${piece.name}.${type === 'video/mp4' ? 'mp4' : 'webm'}`);
  setStatus('Video saved.');
  busy(false);
});

// --- startup ---
tokenInput.value = store.get('token');
tokenInput.addEventListener('change', () => store.set('token', tokenInput.value.trim()));
$('forget').addEventListener('click', () => {
  tokenInput.value = '';
  store.set('token', '');
  setStatus('Token removed from this browser.');
});
if (!tokenInput.value) tokenBox.open = true;
const fromUrl = new URLSearchParams(location.search).get('repo');
if (fromUrl) repoInput.value = fromUrl;
