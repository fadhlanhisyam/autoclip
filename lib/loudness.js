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

// db: loudness per second of the VOICE band (whole video). Returns the loudest
// sustained spikes relative to the video's normal level, at least `gap` seconds apart.
// A spike must last ~2 of 3 seconds: a streamer yelling does, a single gunshot or
// explosion usually does not.
export function findPeaks(db, { max = 150, gap = 20, minRise = 6 } = {}) {
  if (!db.length) return [];
  const sm = db.map((_, i) => {
    const w = [db[i - 1], db[i], db[i + 1]].filter((v) => v !== undefined).sort((a, b) => a - b);
    return w[Math.floor(w.length / 2)];
  });
  const sorted = [...sm].filter((v) => v > -90).sort((a, b) => a - b);
  if (!sorted.length) return [];
  const base = sorted[Math.floor(sorted.length / 2)];
  const cand = sm
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

// After transcription: what did the streamer say right at each loud moment?
// Loud moments without any speech are most likely game sounds, not the streamer.
// ranges: the transcribed [start, end] parts (null = whole video was transcribed).
export function annotatePeaks(peaks, words, ranges = null, { before = 2, after = 4 } = {}) {
  return peaks.map((p) => {
    if (ranges && !ranges.some(([s, e]) => p.t >= s && p.t <= e)) return p; // not transcribed
    const said = words.filter((w) => w.end > p.t - before && w.start < p.t + after).map((w) => w.word);
    return { ...p, speech: said.slice(0, 10).join(' ') };
  });
}

// Human voice sits mostly between ~300 and ~3400 Hz; filtering to that band makes
// the streamer's yelling stand out and mutes bass-heavy explosions and music.
export const VOICE_BAND = { low: 300, high: 3400 };

// chunks: [{start, blob}] mp3 chunks from extractAudioChunks
export async function loudPeaks(chunks, onProgress) {
  const Ctx = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!Ctx) return [];
  const db = [];
  for (let i = 0; i < chunks.length; i++) {
    try {
      const dec = new Ctx(1, 16000, 16000);
      const buf = await dec.decodeAudioData(await chunks[i].blob.arrayBuffer());
      // voice band only (streamer), see VOICE_BAND
      const ctx = new Ctx(1, buf.length, buf.sampleRate);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = VOICE_BAND.low;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = VOICE_BAND.high;
      src.connect(hp).connect(lp).connect(ctx.destination);
      src.start();
      const voiced = await ctx.startRendering();
      const w = windowDb(voiced.getChannelData(0), voiced.sampleRate);
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

// Which parts of a long gameplay video are worth transcribing? Windows around the
// loudest moments (saves the free Whisper quota). Returns [[start, end], ...] or
// null when there are too few peaks (then transcribe everything).
export function speechRanges(peaks, duration, { top = 15, before = 50, after = 25, minPeaks = 3 } = {}) {
  if (!peaks || peaks.length < minPeaks) return null;
  const best = [...peaks].sort((a, b) => b.db - a.db).slice(0, top).sort((a, b) => a.t - b.t);
  const out = [];
  for (const p of best) {
    const s = Math.max(0, p.t - before);
    const e = Math.min(duration || p.t + after, p.t + after);
    const last = out[out.length - 1];
    if (last && s <= last[1] + 5) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  const total = out.reduce((a, [s, e]) => a + e - s, 0);
  // not worth it if it would cover most of the video anyway
  return duration && total > duration * 0.8 ? null : out;
}

// split ranges into pieces of at most `len` seconds (one Whisper request each)
export function pieces(ranges, len = 480) {
  const out = [];
  for (const [s, e] of ranges) for (let t = s; t < e - 1; t += len) out.push([t, Math.min(e, t + len)]);
  return out;
}
