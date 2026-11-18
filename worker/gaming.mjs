// AutoClip Gaming (CMD): paste YouTube links of gameplay / streams, get vertical
// split-screen clips (facecam on top, gameplay below) with subtitles + a faint watermark.
// Free: yt-dlp + ffmpeg on this PC, Whisper/Gemini through the user's AutoClip site.

import { spawn } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAss } from './lib/captions.mjs';
import { fitClips, fmtTime } from './lib/highlights.mjs';
import { findPeaks, speechRanges, pieces } from './lib/loudness.mjs';
import { audioExtractArgs, audioChunkArgs, renderArgs, gameFilter, splitHeights, boxPixels } from './lib/commands.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const exe = (n) => (process.platform === 'win32' ? `${n}.exe` : n);
const readJson = (p, d) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
  } catch {
    return d;
  }
};

const cfg = {
  site: 'https://autoclip-gray.vercel.app',
  password: '',
  language: 'id',
  ...readJson(path.join(HERE, 'config.json'), {}),
};
const GAMING_CFG = path.join(HERE, 'gaming.json');
const g = {
  clips: 4,
  minDur: 20,
  maxDur: 50,
  corner: 3, // 1 kiri atas, 2 kanan atas, 3 kiri bawah, 4 kanan bawah, 5 tanpa facecam
  faceW: 0.28,
  faceDx: 0,
  faceDy: 0,
  gameDx: 0,
  topRatio: 0.4,
  watermark: '',
  game: '',
  ...readJson(GAMING_CFG, {}),
};
const saveG = () => fs.writeFileSync(GAMING_CFG, JSON.stringify(g, null, 2));

const TOOLS = cfg.toolsDir || path.join(ROOT, 'tools');
const YTDLP = cfg.ytdlp || path.join(TOOLS, exe('yt-dlp'));
const FFMPEG = cfg.ffmpeg || path.join(TOOLS, exe('ffmpeg'));
const FFPROBE = cfg.ffprobe || path.join(TOOLS, exe('ffprobe'));
const FONT = cfg.font || path.join(ROOT, 'public', 'fonts', 'Poppins-Bold.ttf');
const OUT_ROOT = cfg.gamingOutDir || path.join(os.homedir(), 'Videos', 'AutoClip Gaming');
const WORK = path.join(HERE, 'work');
const OUT_W = 1080;
const OUT_H = 1920;

const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Jakarta' });
const LOGFILE = path.join(HERE, 'logs', `gaming-${today}.log`);
function log(...a) {
  const t = new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false });
  console.log(`[${t}]`, ...a);
  try {
    fs.mkdirSync(path.dirname(LOGFILE), { recursive: true });
    fs.appendFileSync(LOGFILE, `[${t}] ${a.map(String).join(' ')}\r\n`);
  } catch {}
}
const slug = (s, n = 50) =>
  (s || 'klip').normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, n).replace(/-+$/, '') || 'klip';
const safeName = (s, n = 90) => (s || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, n) || 'video';
const lastLine = (t) => String(t || '').trim().split(/\r?\n/).filter(Boolean).pop()?.slice(0, 300) || '';
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---------- input ----------
const rl = readline.createInterface({ input: process.stdin, terminal: false });
const lines = rl[Symbol.asyncIterator]();
async function ask(q) {
  process.stdout.write(q);
  const { value } = await lines.next();
  return (value ?? '').trim();
}

// ---------- processes ----------
function run(cmd, args, { cwd } = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, windowsHide: true });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => resolve({ code: -1, out, err: String(e) }));
    p.on('close', (code) => resolve({ code, out, err }));
  });
}
let jsRuntime = true;
async function ytdlp(args) {
  const base = ['--no-progress', '--ffmpeg-location', TOOLS];
  if (jsRuntime) base.push('--js-runtimes', `node:${process.execPath}`);
  let r = await run(YTDLP, [...base, ...args]);
  if (r.code !== 0 && /no such option.*js-runtimes/i.test(r.err)) {
    jsRuntime = false;
    r = await run(YTDLP, ['--no-progress', '--ffmpeg-location', TOOLS, ...args]);
  }
  return r;
}
async function ffmpeg(args, cwd) {
  const r = await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', ...args], { cwd });
  if (r.code !== 0) throw new Error(`ffmpeg gagal: ${r.err.slice(-500)}`);
}
async function probe(file) {
  const r = await run(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]);
  if (r.code !== 0) throw new Error(`ffprobe gagal: ${r.err.slice(-300)}`);
  const j = JSON.parse(r.out);
  const v = (j.streams || []).find((s) => s.codec_type === 'video');
  return { w: v?.width, h: v?.height, duration: Number(j.format?.duration || 0) };
}

// loudness per second, streamed from ffmpeg (works for multi-hour streams)
function loudnessDb(file, cwd) {
  return new Promise((resolve) => {
    const RATE = 8000;
    const p = spawn(FFMPEG, ['-v', 'error', '-i', file, '-f', 's16le', '-ac', '1', '-ar', String(RATE), 'pipe:1'], { cwd, windowsHide: true });
    const db = [];
    let sum = 0;
    let n = 0;
    let rest = null;
    p.stdout.on('data', (buf) => {
      if (rest) {
        buf = Buffer.concat([rest, buf]);
        rest = null;
      }
      const len = buf.length - (buf.length % 2);
      if (len < buf.length) rest = buf.subarray(len);
      for (let i = 0; i < len; i += 2) {
        const s = buf.readInt16LE(i) / 32768;
        sum += s * s;
        if (++n === RATE) {
          db.push(10 * Math.log10(sum / n + 1e-10));
          sum = 0;
          n = 0;
        }
      }
    });
    p.on('close', () => resolve(db));
    p.on('error', () => resolve([]));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(pathname, init = {}, tries = 3) {
  let last;
  let waited = 0;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(cfg.site.replace(/\/$/, '') + pathname, {
        ...init,
        headers: { ...(init.headers || {}), 'x-app-password': cfg.password },
      });
      const text = await res.text();
      let data = {};
      try {
        data = JSON.parse(text);
      } catch {}
      if (res.status === 401) throw Object.assign(new Error('Password AutoClip salah. Jalankan SETUP-WORKER.bat lagi.'), { fatal: true });
      if (res.ok) return data;
      if (res.status === 429 && data.retryAfter) {
        // free Whisper quota used up: wait it out instead of failing
        const sec = Math.min(Number(data.retryAfter) + 15, 3 * 3600);
        if (data.daily && sec > 3600) {
          throw Object.assign(new Error(`Kuota transkrip harian Groq (gratis) sudah habis. Jalankan lagi sekitar ${Math.ceil(sec / 3600)} jam lagi — transkrip yang sudah jadi tersimpan, tidak diulang.`), { fatal: true });
        }
        if (waited + sec > 3 * 3600) throw Object.assign(new Error('Kuota transkrip Groq habis terlalu lama.'), { fatal: true });
        log(`  ⏳ Batas gratis transkrip (±2 jam audio per jam) tercapai. Menunggu ${Math.ceil(sec / 60)} menit, lalu lanjut otomatis… (biarkan jendela ini terbuka)`);
        for (let left = sec; left > 0; left -= 60) {
          await sleep(Math.min(60, left) * 1000);
          if (left > 60 && left % 300 < 60) log(`     sisa ±${Math.ceil((left - 60) / 60)} menit…`);
        }
        waited += sec;
        i--; // a quota wait is not a failed attempt
        continue;
      }
      last = new Error(data.error || `HTTP ${res.status}: ${text.slice(0, 200)}`);
    } catch (e) {
      if (e.fatal) throw e;
      last = e;
    }
    log(`  ! ${pathname} gagal (percobaan ${i + 1}/${tries}): ${String(last.message).slice(0, 200)}`);
    await sleep(8000 * (i + 1));
  }
  throw last;
}

// ---------- layout ----------
function layoutBoxes(srcW, srcH) {
  const { top, bottom } = splitHeights(g.topRatio, OUT_H);
  const noCam = g.corner === 5;
  const fAsp = OUT_W / top;
  const gAsp = OUT_W / (noCam ? splitHeights(0.4, OUT_H).bottom : bottom);
  const fw = clamp(g.faceW, 0.08, Math.min(1, (fAsp * srcH) / srcW));
  const fh = (fw * srcW) / fAsp / srcH;
  const right = g.corner === 2 || g.corner === 4;
  const low = g.corner === 3 || g.corner === 4;
  const face = {
    w: fw,
    x: clamp((right ? 1 - fw : 0) + g.faceDx, 0, 1 - fw),
    y: clamp((low ? 1 - fh : 0) + g.faceDy, 0, Math.max(0, 1 - fh)),
  };
  const gw = Math.min(1, (gAsp * srcH) / srcW);
  const game = { w: gw, x: clamp((1 - gw) / 2 + g.gameDx, 0, 1 - gw), y: 0 };
  return { face, game, noCam, fAsp, gAsp, top };
}

function captionY(top, noCam) {
  // captions.mjs uses a 720x1280 canvas
  return noCam ? 1280 * 0.83 : (top / OUT_H) * 1280;
}

async function makePreview(dir, frame, srcW, srcH) {
  const L = layoutBoxes(srcW, srcH);
  fs.writeFileSync(
    path.join(dir, 'preview.ass'),
    buildAss([{ word: 'CONTOH', start: 0, end: 5 }, { word: 'SUBTITLE', start: 0, end: 5 }], 0, 5, {
      posY: captionY(L.top, L.noCam),
      fontSize: 58,
      watermark: g.watermark,
    }),
  );
  const PW = 304;
  const PH = 540;
  const right = gameFilter({ srcW, srcH, face: L.face, game: L.game, topRatio: g.topRatio, noCam: L.noCam, subs: 'preview.ass', outW: PW, outH: PH })
    .filter.replace('[0:v]', '[s2]')
    .replace(/\[v\]$/, '[r]');
  const fp = boxPixels(L.face, L.fAsp, srcW, srcH);
  const gp = boxPixels(L.game, L.gAsp, srcW, srcH);
  const boxes =
    `drawbox=x=${gp.x}:y=${gp.y}:w=${gp.w}:h=${gp.h}:color=0x4da3ff:t=8` +
    (L.noCam ? '' : `,drawbox=x=${fp.x}:y=${fp.y}:w=${fp.w}:h=${fp.h}:color=yellow:t=8`);
  await ffmpeg(
    ['-y', '-i', frame, '-filter_complex', `[0:v]split[s1][s2];[s1]${boxes},scale=-2:${PH}[l];${right};[l][r]hstack=inputs=2[o]`, '-map', '[o]', '-frames:v', '1', 'preview.jpg'],
    dir,
  );
  return path.join(dir, 'preview.jpg');
}

async function confirmLayout(dir, frame, srcW, srcH) {
  for (;;) {
    const img = await makePreview(dir, frame, srcW, srcH);
    if (process.platform === 'win32') spawn('explorer', [img], { detached: true, stdio: 'ignore' }).unref();
    console.log(`
  Gambar pratinjau dibuka (kiri: video asli, kotak KUNING = wajah, BIRU = game; kanan: hasil 9:16).
  Sudah pas?
    Enter        = pas, lanjut render
    1 2 3 4      = kamera wajah di video asli ada di pojok: 1 kiri atas, 2 kanan atas, 3 kiri bawah, 4 kanan bawah
    5            = video tanpa facecam
    + / -        = kotak wajah lebih besar / kecil
    w a s d      = geser kotak wajah (atas / kiri / bawah / kanan)
    j / l        = geser area game ke kiri / kanan
    t / g        = bagian wajah lebih tinggi / lebih pendek
  (boleh digabung, mis. "++dd")`);
    const a = (await ask('> ')).toLowerCase();
    if (!a) break;
    for (const ch of a) {
      if (/[1-5]/.test(ch)) {
        g.corner = +ch;
        g.faceDx = 0;
        g.faceDy = 0;
      } else if (ch === '+') g.faceW *= 1.12;
      else if (ch === '-') g.faceW /= 1.12;
      else if (ch === 'a') g.faceDx -= 0.02;
      else if (ch === 'd') g.faceDx += 0.02;
      else if (ch === 'w') g.faceDy -= 0.03;
      else if (ch === 's') g.faceDy += 0.03;
      else if (ch === 'j') g.gameDx -= 0.03;
      else if (ch === 'l') g.gameDx += 0.03;
      else if (ch === 't') g.topRatio = clamp(g.topRatio + 0.03, 0.25, 0.5);
      else if (ch === 'g') g.topRatio = clamp(g.topRatio - 0.03, 0.25, 0.5);
    }
    g.faceW = clamp(g.faceW, 0.08, 1);
    saveG();
  }
  saveG();
}

// ---------- one video ----------
async function processVideo(url, idx, total) {
  const id = (/(?:v=|youtu\.be\/|shorts\/|live\/)([\w-]{11})/.exec(url) || [])[1];
  if (!id) throw new Error(`link tidak dikenali: ${url}`);
  url = `https://www.youtube.com/watch?v=${id}`;
  const dir = path.join(WORK, `game-${id}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'fonts'), { recursive: true });
  fs.copyFileSync(FONT, path.join(dir, 'fonts', 'Poppins-Bold.ttf'));

  let r = await ytdlp(['--skip-download', '--print', '%(channel,uploader)s\t%(title)s\t%(duration)s', url]);
  const [channel = '', title = id, dur = '0'] = (lastLine(r.out) || '').split('\t');
  log(`\n=== [${idx}/${total}] ${title} — ${channel} (${fmtTime(Number(dur) || 0)}) ===`);

  log('  Download audio…');
  r = await ytdlp(['-f', 'ba[ext=m4a]/ba/b', '-o', path.join(dir, 'audio.%(ext)s'), url]);
  const audio = fs.readdirSync(dir).find((f) => f.startsWith('audio.') && !/\.part$/.test(f));
  if (!audio) throw new Error(`gagal download audio: ${lastLine(r.err)}`);
  await ffmpeg(audioExtractArgs(audio, 'speech.mp3'), dir);
  const { duration } = await probe(path.join(dir, 'speech.mp3'));

  log('  Mencari momen heboh dari suara (teriakan, ledakan)…');
  const peaks = findPeaks(await loudnessDb('speech.mp3', dir));
  log(`  ${peaks.length} momen suara keras ditemukan.`);

  // transcribe only around the loud moments (saves the free quota), cached per video
  const ranges = speechRanges(peaks, duration);
  const parts = pieces(ranges || [[0, duration]], 480);
  const audioSec = parts.reduce((a, [s0, e0]) => a + e0 - s0, 0);
  log(ranges
    ? `  Transkrip hanya di sekitar momen heboh: ${fmtTime(audioSec)} dari ${fmtTime(duration)} (hemat kuota gratis).`
    : `  Transkrip seluruh audio (${fmtTime(duration)}).`);
  const cacheFile = path.join(HERE, 'cache', `${id}-${cfg.language || 'id'}.json`);
  const cache = readJson(cacheFile, {});
  const segments = [];
  const words = [];
  for (let i = 0; i < parts.length; i++) {
    const [s0, e0] = parts[i];
    const key = `${s0.toFixed(1)}-${e0.toFixed(1)}`;
    let t = cache[key];
    if (!t) {
      const name = `chunk_${i}.mp3`;
      await ffmpeg(audioChunkArgs('speech.mp3', s0, e0 - s0, name), dir);
      const buf = fs.readFileSync(path.join(dir, name));
      if (buf.length < 2000) continue;
      log(`  Transkrip bagian ${i + 1}/${parts.length}…`);
      const fd = new FormData();
      fd.append('file', new Blob([buf], { type: 'audio/mpeg' }), name);
      fd.append('language', cfg.language || 'id');
      t = await api('/api/transcribe', { method: 'POST', body: fd });
      cache[key] = { segments: t.segments, words: t.words };
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify(cache));
    }
    segments.push(...t.segments.map((x) => ({ ...x, start: x.start + s0, end: x.end + s0 })));
    words.push(...t.words.map((w) => ({ ...w, start: w.start + s0, end: w.end + s0 })));
  }
  if (!segments.length && !peaks.length) throw new Error('tidak ada suara streamer atau momen heboh yang terdeteksi');

  log('  AI memilih momen paling berpotensi viral…');
  const h = await api('/api/highlights', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      mode: 'gaming',
      segments,
      peaks,
      duration,
      count: g.clips,
      minDur: g.minDur,
      maxDur: g.maxDur,
      language: cfg.language === 'en' ? 'en' : 'id',
      game: g.game,
      notes: [g.notes, ranges ? 'Speech was only transcribed around the loud moments; pick clips around those moments.' : ''].filter(Boolean).join(' '),
    }),
  });
  const clips = fitClips(h.clips || [], segments, { minDur: g.minDur, maxDur: g.maxDur, duration }).slice(0, g.clips);
  if (!clips.length) throw new Error('AI tidak menemukan momen yang cocok');
  log(`  ${clips.length} momen dipilih (${h.provider || 'AI'}).`);

  const outDir = path.join(OUT_ROOT, today, safeName(`${channel ? channel + ' - ' : ''}${title}`));
  fs.mkdirSync(outDir, { recursive: true });
  const fmt = 'bv*[height<=1080][vcodec^=avc1]+ba[ext=m4a]/bv*[height<=1080]+ba/b[height<=1080]/b';
  const made = [];
  let layoutOk = false;
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    const n = String(i + 1).padStart(2, '0');
    log(`  Klip ${n}: ${fmtTime(c.start)}–${fmtTime(c.end)} "${c.title}"`);
    try {
      let sec;
      for (let attempt = 1; attempt <= 3 && !sec; attempt++) {
        for (const f of fs.readdirSync(dir)) if (f.startsWith(`sec_${n}.`)) fs.rmSync(path.join(dir, f), { force: true });
        r = await ytdlp(['-f', fmt, '--download-sections', `*${c.start.toFixed(2)}-${c.end.toFixed(2)}`, '--force-keyframes-at-cuts', '--merge-output-format', 'mp4', '-o', path.join(dir, `sec_${n}.%(ext)s`), url]);
        if (r.code === 0) sec = fs.readdirSync(dir).find((f) => f.startsWith(`sec_${n}.`) && !/\.(part|ytdl)$/.test(f) && !/\.f\d+\./.test(f));
        if (!sec && attempt < 3) {
          log(`    ! download potongan gagal (percobaan ${attempt}/3), coba lagi…`);
          await new Promise((res) => setTimeout(res, 10000 * attempt));
        }
      }
      if (!sec) throw new Error(`download potongan gagal: ${lastLine(r.err)}`);
      const info = await probe(path.join(dir, sec));
      const len = Math.min(c.end - c.start, info.duration || c.end - c.start);

      if (!layoutOk) {
        await ffmpeg(['-y', '-ss', (len / 2).toFixed(2), '-i', sec, '-frames:v', '1', 'frame.png'], dir);
        await confirmLayout(dir, 'frame.png', info.w, info.h);
        layoutOk = true;
      }
      const L = layoutBoxes(info.w, info.h);
      const subs = `subs_${n}.ass`;
      fs.writeFileSync(
        path.join(dir, subs),
        buildAss(g.subtitles === false ? [] : words, c.start, c.start + len, { posY: captionY(L.top, L.noCam), fontSize: 58, watermark: g.watermark }),
      );
      const filter = gameFilter({ srcW: info.w, srcH: info.h, face: L.face, game: L.game, topRatio: g.topRatio, noCam: L.noCam, subs, outW: OUT_W, outH: OUT_H });
      const outName = `${n}-${slug(c.title)} [${id}].mp4`;
      log('    Merender…');
      await ffmpeg(renderArgs({ input: sec, output: outName, duration: len, filter }), dir);
      fs.renameSync(path.join(dir, outName), path.join(outDir, outName));
      made.push({ ...c, file: outName, len });
      log(`    ✓ ${outName}`);
    } catch (e) {
      log(`    ✗ klip ${n} gagal: ${e.message}`);
    }
  }

  const credit = `🎮 Full: ${title}${channel ? ' — ' + channel : ''} (YouTube)`;
  const tag = channel ? `#${channel.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()}` : '';
  const gameTag = g.game ? `#${g.game.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()}` : '';
  fs.writeFileSync(
    path.join(outDir, 'CAPTION.txt'),
    [
      `SUMBER: ${title}`,
      `CHANNEL: ${channel}`,
      `LINK: ${url}`,
      '',
      ...made.flatMap((c) => [
        `==================== ${c.file} (${Math.round(c.len)} detik, skor ${c.score}) ====================`,
        `Judul: ${c.title}`,
        `Bagian video asli: ${fmtTime(c.start)} – ${fmtTime(c.end)}`,
        `Isi: ${c.reason}`,
        '',
        'CAPTION (siap tempel):',
        c.hook,
        '',
        credit,
        `#gaming ${gameTag} ${tag} #fyp #fypシ`.replace(/\s+/g, ' ').trim(),
        '',
      ]),
    ].join('\r\n'),
  );
  try {
    fs.appendFileSync(path.join(HERE, 'processed.txt'), `${id}\t${today}\t(gaming) ${title}\n`);
  } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
  return { title, made, outDir };
}

// ---------- main ----------
async function main() {
  console.log('\n================  AUTOCLIP GAMING  ================');
  console.log('  Video gaming YouTube -> klip portrait: wajah streamer di atas, game di bawah.\n');
  for (const [name, p] of [['yt-dlp', YTDLP], ['ffmpeg', FFMPEG], ['ffprobe', FFPROBE], ['font', FONT]]) {
    if (!fs.existsSync(p)) throw new Error(`${name} tidak ditemukan di ${p}. Jalankan SETUP-WORKER.bat dulu.`);
  }
  if (!cfg.password) throw new Error('Password AutoClip belum diisi. Jalankan SETUP-WORKER.bat dulu.');
  await api('/api/auth', { method: 'POST' }, 2);

  const links = [];
  console.log('Tempel link YouTube (boleh beberapa, satu per baris). Tekan Enter di baris kosong kalau sudah.');
  for (;;) {
    const a = await ask(links.length ? '> ' : 'Link: ');
    if (!a) {
      if (links.length) break;
      continue;
    }
    for (const s of a.split(/\s+/)) if (/youtu\.?be/.test(s)) links.push(s);
  }
  const game = await ask(`Nama game? (Enter = ${g.game || 'kosong'})\n> `);
  if (game) g.game = game === '-' ? '' : game;
  const n = await ask(`Berapa klip per video? (Enter = ${g.clips})\n> `);
  if (/^\d+$/.test(n) && +n > 0) g.clips = Math.min(10, +n);
  const wm = await ask(`Watermark kecil di bawah? (Enter = ${g.watermark || 'tanpa watermark'} | - = hapus)\n> `);
  if (wm) g.watermark = wm === '-' ? '' : wm.slice(0, 40);
  console.log('\nDi VIDEO ASLI (YouTube), kotak kamera wajah streamer ada di pojok mana?');
  console.log('(Di hasil akhir, wajah selalu otomatis ditaruh di ATAS dan game di BAWAH.)');
  const cam = await ask(`1 kiri atas, 2 kanan atas, 3 kiri bawah, 4 kanan bawah, 5 tidak ada kamera wajah (Enter = ${g.corner})\n> `);
  if (/^[1-5]$/.test(cam)) {
    g.corner = +cam;
    g.faceDx = 0;
    g.faceDy = 0;
  }
  saveG();

  const results = [];
  for (let i = 0; i < links.length; i++) {
    try {
      results.push(await processVideo(links[i], i + 1, links.length));
    } catch (e) {
      if (e.fatal) throw e;
      log(`  ✗ video dilewati: ${e.message}`);
    }
  }
  const total = results.reduce((s, r) => s + r.made.length, 0);
  log(`\nSelesai: ${total} klip dibuat.`);
  if (results[0]) {
    log(`Hasil ada di: ${path.join(OUT_ROOT, today)}`);
    if (process.platform === 'win32' && total) spawn('explorer', [path.join(OUT_ROOT, today)], { detached: true, stdio: 'ignore' }).unref();
  }
}

main()
  .catch((e) => {
    log('GAGAL:', e.message);
    process.exitCode = 1;
  })
  .finally(() => rl.close());
