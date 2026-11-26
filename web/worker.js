// Loads the soundfont (cached in the browser after the first visit) and renders audio off the main thread.
import { render, master, SOUNDFONT_URL, SOUNDFONT_SHA256 } from '../src/audio.js';

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function download() {
  const res = await fetch(SOUNDFONT_URL);
  if (!res.ok) throw new Error(`Could not download the instruments (HTTP ${res.status}).`);
  const total = Number(res.headers.get('content-length')) || 31_000_000;
  const buf = new Uint8Array(total);
  let got = 0, out = buf;
  for (const reader = res.body.getReader(); ; ) {
    const { done, value } = await reader.read();
    if (done) break;
    if (got + value.length > out.length) { // content-length was missing or wrong
      const bigger = new Uint8Array(Math.max(out.length * 2, got + value.length));
      bigger.set(out.subarray(0, got));
      out = bigger;
    }
    out.set(value, got);
    got += value.length;
    postMessage({ type: 'progress', got, total: Math.max(total, got) });
  }
  const sf2 = out.subarray(0, got);
  if (hex(await crypto.subtle.digest('SHA-256', sf2)) !== SOUNDFONT_SHA256) throw new Error('The instrument download was corrupted. Reload the page to try again.');
  return sf2;
}

async function loadSoundfont() {
  const cache = await caches.open('git-symphony-soundfont-v1').catch(() => null); // no Cache API outside secure contexts
  const hit = await cache?.match(SOUNDFONT_URL);
  if (hit) return new Uint8Array(await hit.arrayBuffer());
  const sf2 = await download();
  await cache?.put(SOUNDFONT_URL, new Response(sf2)).catch(() => {}); // quota errors only cost a re-download
  return sf2;
}

let soundfont;
const ready = () => (soundfont ??= loadSoundfont().catch((e) => { soundfont = null; throw e; }));

onmessage = async ({ data }) => {
  try {
    if (data.type === 'preload') await ready();
    if (data.type === 'render') {
      const sf2 = await ready();
      postMessage({ type: 'rendering' });
      const [L, R] = master(await render(data.midi, sf2));
      postMessage({ type: 'done', L, R }, [L.buffer, R.buffer]);
    }
  } catch (e) {
    postMessage({ type: 'error', message: e.message });
  }
};
