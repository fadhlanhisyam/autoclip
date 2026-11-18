// Find loud moments (screams, explosions, hype) in the audio chunks, in the browser.
// Pure helpers are exported so they can be tested without a browser.

const WIN = 1; // seconds per loudness window

// samples: Float32Array of mono PCM, rate in Hz -> dB per window
export function windowDb(samples, rate, win = WIN) {
  const n = Math.floor(rate * win);
  const out = [];
  for (let i = 0; i + n <= samples.length; i += n) {
    let sum = 0;
    for (let j = i; j < i + n; j++) sum += samples[j] * samples[j];
    out.push(10 * Math.log10(sum / n + 1e-10));
  }
  return out;
}

// db: loudness per second (whole video). Returns the loudest spikes relative to
// the video's normal level, at least `gap` seconds apart.
export function findPeaks(db, { max = 40, gap = 20, minRise = 6 } = {}) {
  if (!db.length) return [];
  const sorted = [...db].filter((v) => v > -90).sort((a, b) => a - b);
  if (!sorted.length) return [];
  const base = sorted[Math.floor(sorted.length / 2)];
  const cand = db
    .map((v, t) => ({ t: t * WIN, db: v - base }))
    .filter((p) => p.db >= minRise)
    .sort((a, b) => b.db - a.db);
  const kept = [];
  for (const p of cand) {
    if (kept.some((k) => Math.abs(k.t - p.t) < gap)) continue;
    kept.push(p);
    if (kept.length >= max) break;
  }
  return kept.sort((a, b) => a.t - b.t);
}

// chunks: [{start, blob}] mp3 chunks from extractAudioChunks
export async function loudPeaks(chunks, onProgress) {
  const Ctx = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!Ctx) return [];
  const db = [];
  for (let i = 0; i < chunks.length; i++) {
    try {
      const ctx = new Ctx(1, 16000, 16000);
      const buf = await ctx.decodeAudioData(await chunks[i].blob.arrayBuffer());
      const w = windowDb(buf.getChannelData(0), buf.sampleRate);
      const at = Math.round(chunks[i].start / WIN);
      for (let k = 0; k < w.length; k++) db[at + k] = w[k];
    } catch (e) {
      console.warn('Analisis suara gagal untuk potongan', i, e);
    }
    onProgress && onProgress((i + 1) / chunks.length);
  }
  for (let k = 0; k < db.length; k++) if (db[k] === undefined) db[k] = -100;
  return findPeaks(db);
}
