// Browser-side video processing with ffmpeg.wasm (runs on the user's computer,
// so long videos never have to be uploaded to Vercel).

import { audioExtractArgs, audioChunkArgs, renderArgs, videoFilter } from './commands';

const CORE_ST = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd';
const CORE_MT = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core-mt@0.12.6/dist/umd';
const FONT_URL = '/fonts/Poppins-Bold.ttf';

let ffmpeg = null;
let multiThread = false;
let preferMT = true;

export function setPreferMultiThread(v) {
  if (v !== preferMT) {
    preferMT = v;
    cancelFFmpeg(); // reload with the other core next time
  }
}

export function isMultiThread() {
  return multiThread;
}
let loading = null;
let mountedFile = null;
let inputPath = null;
let fontReady = false;
let logListener = null;

export async function getFFmpeg() {
  if (ffmpeg) return ffmpeg;
  if (loading) return loading;
  loading = (async () => {
    const { FFmpeg } = await import('@ffmpeg/ffmpeg');
    const { toBlobURL } = await import('@ffmpeg/util');
    const canMT = preferMT && typeof SharedArrayBuffer !== 'undefined' && globalThis.crossOriginIsolated;
    const ff = new FFmpeg();
    ff.on('log', ({ message }) => logListener && logListener(message));
    if (canMT) {
      try {
        await ff.load({
          coreURL: await toBlobURL(`${CORE_MT}/ffmpeg-core.js`, 'text/javascript'),
          wasmURL: await toBlobURL(`${CORE_MT}/ffmpeg-core.wasm`, 'application/wasm'),
          workerURL: await toBlobURL(`${CORE_MT}/ffmpeg-core.worker.js`, 'text/javascript'),
        });
        multiThread = true;
        ffmpeg = ff;
        return ff;
      } catch (err) {
        console.warn('Multi-thread gagal dimuat, pakai single-thread', err);
        ff.terminate();
        return loadSingle(FFmpeg, toBlobURL);
      }
    }
    return loadSingle(FFmpeg, toBlobURL);
  })();
  try {
    return await loading;
  } finally {
    loading = null;
  }
}

async function loadSingle(FFmpeg, toBlobURL) {
  const ff = new FFmpeg();
  ff.on('log', ({ message }) => logListener && logListener(message));
  await ff.load({
    coreURL: await toBlobURL(`${CORE_ST}/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await toBlobURL(`${CORE_ST}/ffmpeg-core.wasm`, 'application/wasm'),
  });
  multiThread = false;
  ffmpeg = ff;
  return ff;
}

function parseTime(msg) {
  const m = /time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(msg);
  return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : null;
}

async function run(args, expectedSec, onProgress) {
  const ff = await getFFmpeg();
  const tail = [];
  logListener = (msg) => {
    tail.push(msg);
    if (tail.length > 30) tail.shift();
    const t = parseTime(msg);
    if (t != null && expectedSec && onProgress) onProgress(Math.min(1, t / expectedSec));
  };
  try {
    const code = await ff.exec(args);
    if (code !== 0) throw new Error(`ffmpeg gagal (kode ${code}):\n${tail.slice(-8).join('\n')}`);
  } finally {
    logListener = null;
  }
}

// Make the user's file readable by ffmpeg without copying it into memory.
export async function mountInput(file) {
  const ff = await getFFmpeg();
  if (mountedFile === file && inputPath) return inputPath;
  const ext = (file.name.split('.').pop() || 'mp4').toLowerCase().replace(/[^a-z0-9]/g, '') || 'mp4';
  const safe = new File([file], `input.${ext}`, { type: file.type });

  try { await ff.unmount('/in'); } catch {}
  try { await ff.deleteDir('/in'); } catch {}
  try {
    await ff.createDir('/in');
    await ff.mount('WORKERFS', { files: [safe] }, '/in');
    inputPath = `/in/input.${ext}`;
  } catch (err) {
    // Fallback: copy into memory (works for files up to ~1.5 GB)
    console.warn('WORKERFS mount gagal, pakai writeFile', err);
    const { fetchFile } = await import('@ffmpeg/util');
    await ff.writeFile(`input.${ext}`, await fetchFile(file));
    inputPath = `input.${ext}`;
  }
  mountedFile = file;
  return inputPath;
}

// Extract speech audio and split it into chunks small enough for a Vercel request.
export async function extractAudioChunks(file, duration, chunkSec, onProgress) {
  const ff = await getFFmpeg();
  const input = await mountInput(file);
  await run(audioExtractArgs(input, 'audio.mp3'), duration, onProgress);
  const chunks = [];
  for (let start = 0, i = 0; start < duration; start += chunkSec, i++) {
    const name = `chunk_${i}.mp3`;
    await run(audioChunkArgs('audio.mp3', start, chunkSec, name));
    const data = await ff.readFile(name);
    await ff.deleteFile(name);
    if (data.byteLength > 1000) chunks.push({ start, blob: new Blob([data], { type: 'audio/mpeg' }) });
  }
  await ff.deleteFile('audio.mp3');
  return chunks;
}

async function ensureFont() {
  if (fontReady) return;
  const ff = await getFFmpeg();
  const buf = new Uint8Array(await (await fetch(FONT_URL)).arrayBuffer());
  try { await ff.createDir('/fonts'); } catch {}
  await ff.writeFile('/fonts/Poppins-Bold.ttf', buf);
  fontReady = true;
}

// Render one vertical clip. Returns a Blob (mp4).
export async function renderClip(file, { start, end, srcW, srcH, centerX, layout, ass }, onProgress) {
  const ff = await getFFmpeg();
  const input = await mountInput(file);
  let subs = null;
  if (ass) {
    await ensureFont();
    await ff.writeFile('subs.ass', new TextEncoder().encode(ass));
    subs = 'subs.ass';
  }
  const duration = end - start;
  const filter = videoFilter({ srcW, srcH, centerX, layout, subs });
  await run(renderArgs({ input, output: 'out.mp4', start, duration, filter }), duration, onProgress);
  const data = await ff.readFile('out.mp4');
  await ff.deleteFile('out.mp4');
  if (subs) await ff.deleteFile('subs.ass');
  return new Blob([data], { type: 'video/mp4' });
}

export function cancelFFmpeg() {
  if (ffmpeg) {
    ffmpeg.terminate();
    ffmpeg = null;
    mountedFile = null;
    inputPath = null;
    fontReady = false;
  }
}
