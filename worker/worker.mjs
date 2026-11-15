// AutoClip Worker: the "Downloader + Editor" employees of the Virtual Office.
// Runs on the user's own PC (Windows Task Scheduler, daily). Free: uses yt-dlp,
// ffmpeg and the user's own AutoClip server (Whisper + Gemini free tiers).
//
//  1. pick new videos (antrian.txt first, then sources in channels.txt)
//  2. download AUDIO only -> transcribe via AutoClip /api/transcribe
//  3. AI picks the best moments via AutoClip /api/highlights
//  4. download ONLY those sections in HD
//  5. render vertical 9:16 clips with word-by-word captions (native ffmpeg)
//  6. save to Videos\AutoClip Hasil\<date>\ with a ready-to-paste caption file

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAss } from './lib/captions.mjs';
import { snapClips, fmtTime } from './lib/highlights.mjs';
import { audioExtractArgs, audioChunkArgs, videoFilter, renderArgs } from './lib/commands.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const IS_WIN = process.platform === 'win32';
const exe = (n) => (IS_WIN ? `${n}.exe` : n);

const DEFAULTS = {
  site: 'https://autoclip-gray.vercel.app',
  password: '',
  videosPerDay: 2,
  clipsPerVideo: 3,
  minDur: 25,
  maxDur: 70,
  minVideoMinutes: 8,
  maxVideoMinutes: 150,
  maxAgeDays: 3,
  minViews: 20000,
  layout: 'blur',
  quality: '1080',
  language: 'id',
  notes:
    'Pilih momen paling lucu, emosional, kontroversial, atau mengejutkan yang bisa jadi hook FYP. Lewati pembukaan, iklan/sponsor, dan basa-basi. Mulai klip langsung dari kalimat yang paling kuat.',
};

const cfg = { ...DEFAULTS, ...readJson(path.join(HERE, 'config.json'), {}) };
const TOOLS = cfg.toolsDir || path.join(ROOT, 'tools');
const YTDLP = cfg.ytdlp || path.join(TOOLS, exe('yt-dlp'));
const FFMPEG = cfg.ffmpeg || path.join(TOOLS, exe('ffmpeg'));
const FFPROBE = cfg.ffprobe || path.join(TOOLS, exe('ffprobe'));
const FONT = cfg.font || path.join(ROOT, 'public', 'fonts', 'Poppins-Bold.ttf');
const OUT_ROOT = cfg.outDir || path.join(os.homedir(), 'Videos', 'AutoClip Hasil');
const WORK = path.join(HERE, 'work');
const PROCESSED = path.join(HERE, 'processed.txt');
const QUEUE = path.join(HERE, 'antrian.txt');
const SOURCES = path.join(HERE, 'channels.txt');
const STATUS = path.join(HERE, 'status-terakhir.txt');

const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Jakarta' }); // YYYY-MM-DD
const summary = [];

function log(...a) {
  const t = new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false });
  console.log(`[${t}]`, ...a);
}
function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}
function readLines(p) {
  try {
    return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  } catch {
    return [];
  }
}
const slug = (s, n = 50) =>
  (s || 'klip').normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, n).replace(/-+$/, '') || 'klip';
const safeName = (s, n = 80) => (s || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, n) || 'video';

// ---------- process helpers ----------
function run(cmd, args, { cwd, quiet = false } = {}) {
  return new Promise((resolve) => {
    if (!quiet) log('>', path.basename(cmd), args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ').slice(0, 300));
    const p = spawn(cmd, args, { cwd, windowsHide: true });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => resolve({ code: -1, out, err: String(e) }));
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

let jsRuntimeSupported = true;
async function ytdlp(args, opts) {
  const base = ['--no-progress', '--ffmpeg-location', TOOLS];
  if (jsRuntimeSupported && cfg.jsRuntime !== false) base.push('--js-runtimes', `node:${process.execPath}`);
  let r = await run(YTDLP, [...base, ...args], opts);
  if (r.code !== 0 && /no such option.*js-runtimes/i.test(r.err)) {
    jsRuntimeSupported = false;
    r = await run(YTDLP, ['--no-progress', '--ffmpeg-location', TOOLS, ...args], opts);
  }
  return r;
}

async function ffmpeg(args, cwd) {
  const r = await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', ...args], { cwd, quiet: true });
  if (r.code !== 0) throw new Error(`ffmpeg gagal: ${r.err.slice(-600)}`);
}

async function probe(file) {
  const r = await run(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { quiet: true });
  if (r.code !== 0) throw new Error(`ffprobe gagal: ${r.err.slice(-300)}`);
  const j = JSON.parse(r.out);
  const v = (j.streams || []).find((s) => s.codec_type === 'video');
  return { w: v?.width, h: v?.height, duration: Number(j.format?.duration || 0) };
}

// ---------- AutoClip server ----------
async function api(pathname, init = {}, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(cfg.site.replace(/\/$/, '') + pathname, {
        ...init,
        headers: { ...(init.headers || {}), 'x-app-password': cfg.password },
        signal: AbortSignal.timeout(310000),
      });
      const text = await res.text();
      let data = {};
      try {
        data = JSON.parse(text);
      } catch {}
      if (res.status === 401) throw Object.assign(new Error('Password AutoClip salah. Jalankan SETUP-WORKER.bat lagi.'), { fatal: true });
      if (res.ok) return data;
      last = new Error(data.error || `HTTP ${res.status}: ${text.slice(0, 200)}`);
    } catch (e) {
      if (e.fatal) throw e;
      last = e;
    }
    log(`  ! ${pathname} gagal (percobaan ${i + 1}/${tries}): ${String(last.message).slice(0, 200)}`);
    await new Promise((r) => setTimeout(r, 8000 * (i + 1)));
  }
  throw last;
}

// ---------- 1. pick videos ----------
const PRINT = '%(id)s\t%(channel,uploader)s\t%(view_count)s\t%(duration)s\t%(title)s';
function parseListing(out) {
  return out
    .split(/\r?\n/)
    .map((l) => l.split('\t'))
    .filter((p) => p.length >= 5 && /^[\w-]{11}$/.test(p[0]))
    .map(([id, channel, views, dur, ...t]) => ({
      id,
      channel: channel === 'NA' ? '' : channel,
      views: Number(views) || 0,
      duration: Number(dur) || 0,
      title: t.join('\t'),
      url: `https://www.youtube.com/watch?v=${id}`,
    }));
}

async function listSource(line) {
  if (/^(https?:\/\/|@)/i.test(line)) {
    let url = line.startsWith('@') ? `https://www.youtube.com/${line}` : line;
    if (/youtube\.com\/(@|channel\/|c\/)/.test(url) && !/\/(videos|streams|shorts)\/?$/.test(url)) url = url.replace(/\/$/, '') + '/videos';
    const r = await ytdlp(['--flat-playlist', '--playlist-end', '6', '--print', PRINT, url], { quiet: true });
    return parseListing(r.out);
  }
  // "cari: kata kunci | channel: potongan nama channel"
  const m = /^cari:\s*([^|]+?)\s*(?:\|\s*channel:\s*(.+))?$/i.exec(line);
  if (!m) return [];
  const r = await ytdlp(['--flat-playlist', '--print', PRINT, `ytsearchdate12:${m[1]}`], { quiet: true });
  const want = (m[2] || '').toLowerCase().trim();
  return parseListing(r.out).filter((v) => !want || v.channel.toLowerCase().includes(want));
}

async function uploadDate(url) {
  const r = await ytdlp(['--skip-download', '--print', '%(upload_date)s', url], { quiet: true });
  const d = r.out.trim().split(/\r?\n/).pop();
  return /^\d{8}$/.test(d) ? d : null;
}

async function pickVideos(processed) {
  const picked = [];
  // manual queue has priority
  for (const url of readLines(QUEUE)) {
    const id = (/(?:v=|youtu\.be\/|shorts\/|live\/)([\w-]{11})/.exec(url) || [])[1];
    if (id && !processed.has(id) && !picked.some((p) => p.id === id)) {
      picked.push({ id, url: `https://www.youtube.com/watch?v=${id}`, title: '', channel: '', fromQueue: true });
    }
  }
  if (picked.length >= cfg.videosPerDay) return picked.slice(0, cfg.videosPerDay);

  const cands = [];
  for (const line of readLines(SOURCES)) {
    log('Mencari video di:', line);
    try {
      for (const v of await listSource(line)) {
        if (processed.has(v.id) || cands.some((c) => c.id === v.id)) continue;
        if (v.duration && (v.duration < cfg.minVideoMinutes * 60 || v.duration > cfg.maxVideoMinutes * 60)) continue;
        if (v.views && v.views < cfg.minViews) continue;
        cands.push(v);
      }
    } catch (e) {
      log('  ! sumber dilewati:', e.message);
    }
  }
  cands.sort((a, b) => b.views - a.views);
  const minDate = new Date(Date.now() - cfg.maxAgeDays * 86400000).toISOString().slice(0, 10).replace(/-/g, '');
  for (const v of cands) {
    if (picked.length >= cfg.videosPerDay) break;
    const d = await uploadDate(v.url);
    if (d && d < minDate) continue; // too old
    picked.push({ ...v, uploadDate: d });
  }
  return picked;
}

// ---------- 2-6. process one video ----------
async function processVideo(v, idx) {
  const dir = path.join(WORK, v.id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'fonts'), { recursive: true });
  fs.copyFileSync(FONT, path.join(dir, 'fonts', 'Poppins-Bold.ttf'));

  // metadata (title/channel) for queue items
  if (!v.title || !v.channel) {
    const r = await ytdlp(['--skip-download', '--print', '%(channel,uploader)s\t%(title)s\t%(duration)s', v.url], { quiet: true });
    const [ch, title, dur] = (r.out.trim().split(/\r?\n/).pop() || '').split('\t');
    Object.assign(v, { channel: ch || v.channel || '', title: title || v.title || v.id, duration: Number(dur) || v.duration || 0 });
  }
  log(`\n=== [${idx}] ${v.title} — ${v.channel} (${fmtTime(v.duration || 0)}) ===`);

  // 2. audio only
  let r = await ytdlp(['-f', 'ba[ext=m4a]/ba/b', '-o', path.join(dir, 'audio.%(ext)s'), v.url]);
  const audio = fs.readdirSync(dir).find((f) => f.startsWith('audio.'));
  if (!audio) throw new Error(`Gagal download audio: ${r.err.slice(-400)}`);
  await ffmpeg(audioExtractArgs(audio, 'speech.mp3'), dir);
  const { duration } = await probe(path.join(dir, 'speech.mp3'));
  const CH = 480;
  const segments = [];
  const words = [];
  for (let start = 0, i = 0; start < duration; start += CH, i++) {
    const name = `chunk_${i}.mp3`;
    await ffmpeg(audioChunkArgs('speech.mp3', start, CH, name), dir);
    const buf = fs.readFileSync(path.join(dir, name));
    if (buf.length < 2000) continue;
    log(`  Transkrip bagian ${i + 1}/${Math.ceil(duration / CH)}…`);
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type: 'audio/mpeg' }), name);
    fd.append('language', cfg.language);
    const t = await api('/api/transcribe', { method: 'POST', body: fd });
    segments.push(...t.segments.map((s) => ({ ...s, start: s.start + start, end: s.end + start })));
    words.push(...t.words.map((w) => ({ ...w, start: w.start + start, end: w.end + start })));
  }
  if (!segments.length) throw new Error('Tidak ada ucapan yang terdeteksi.');
  log(`  Transkrip: ${words.length} kata.`);

  // 3. AI picks the moments
  log('  AI memilih momen terbaik…');
  const h = await api('/api/highlights', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      segments,
      count: cfg.clipsPerVideo,
      minDur: cfg.minDur,
      maxDur: cfg.maxDur,
      language: cfg.language === 'en' ? 'en' : 'id',
      notes: cfg.notes,
    }),
  });
  const clips = snapClips(h.clips || [], segments, { minDur: cfg.minDur, maxDur: cfg.maxDur, duration }).slice(0, cfg.clipsPerVideo);
  if (!clips.length) throw new Error('AI tidak menemukan momen yang cocok.');
  log(`  ${clips.length} momen dipilih (${h.provider || 'AI'}).`);

  const outDir = path.join(OUT_ROOT, today, safeName(`${v.channel ? v.channel + ' - ' : ''}${v.title}`, 90));
  fs.mkdirSync(outDir, { recursive: true });
  const fmt =
    cfg.quality === 'max'
      ? 'bv*+ba/b'
      : 'bv*[height<=1080][vcodec^=avc1]+ba[ext=m4a]/bv*[height<=1080]+ba/b[height<=1080]/b';

  const made = [];
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    const n = String(i + 1).padStart(2, '0');
    log(`  Klip ${n}: ${fmtTime(c.start)}–${fmtTime(c.end)} "${c.title}"`);
    try {
      // 4. download only this section, cut exactly at the timestamps
      const secTpl = path.join(dir, `sec_${n}.%(ext)s`);
      const findSec = () => fs.readdirSync(dir).find((f) => f.startsWith(`sec_${n}.`) && !/\.(part|ytdl)$/.test(f) && !/\.f\d+\./.test(f));
      let sec;
      // YouTube sometimes answers 403 on a section request; a fresh attempt usually works
      for (let attempt = 1; attempt <= 3 && !sec; attempt++) {
        for (const f of fs.readdirSync(dir)) if (f.startsWith(`sec_${n}.`)) fs.rmSync(path.join(dir, f), { force: true });
        r = await ytdlp([
          '-f', fmt,
          '--download-sections', `*${c.start.toFixed(2)}-${c.end.toFixed(2)}`,
          '--force-keyframes-at-cuts',
          '--merge-output-format', 'mp4',
          '-o', secTpl,
          v.url,
        ]);
        if (r.code === 0) sec = findSec();
        if (!sec && attempt < 3) {
          log(`    ! download potongan gagal (percobaan ${attempt}/3), coba lagi…`);
          await new Promise((res) => setTimeout(res, 10000 * attempt));
        }
      }
      if (!sec) throw new Error(`download potongan gagal: ${r.err.slice(-300)}`);
      const info = await probe(path.join(dir, sec));
      const dur = Math.min(c.end - c.start, info.duration || c.end - c.start);

      // 5. captions + render
      fs.writeFileSync(path.join(dir, `subs_${n}.ass`), buildAss(words, c.start, c.start + dur, {}));
      const filter = videoFilter({ srcW: info.w, srcH: info.h, layout: cfg.layout, subs: `subs_${n}.ass`, fontsDir: 'fonts' });
      const outName = `${n}-${slug(c.title)} [${v.id}].mp4`;
      await ffmpeg(renderArgs({ input: sec, output: outName, duration: dur, filter }), dir);
      fs.renameSync(path.join(dir, outName), path.join(outDir, outName));
      made.push({ ...c, file: outName, dur });
      log(`    ✓ ${outName}`);
    } catch (e) {
      log(`    ✗ klip ${n} gagal: ${e.message}`);
    }
  }

  // 6. caption file
  const credit = `📺 Full: ${v.title}${v.channel ? ' — ' + v.channel : ''} (YouTube)`;
  const tag = v.channel ? `#${v.channel.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()}` : '';
  const txt = [
    `SUMBER: ${v.title}`,
    `CHANNEL: ${v.channel}`,
    `LINK: ${v.url}`,
    '',
    ...made.flatMap((c) => [
      `==================== ${c.file} (${Math.round(c.dur)} detik, skor ${c.score}) ====================`,
      `Judul: ${c.title}`,
      `Bagian video asli: ${fmtTime(c.start)} – ${fmtTime(c.end)}`,
      `Kenapa dipilih: ${c.reason}`,
      '',
      'CAPTION (siap tempel):',
      `${c.hook}`,
      '',
      credit,
      `#fyp #podcastindonesia ${tag}`.trim(),
      '',
    ]),
  ].join('\n');
  fs.writeFileSync(path.join(outDir, 'CAPTION.txt'), txt);
  fs.rmSync(dir, { recursive: true, force: true });
  return { outDir, made };
}

// ---------- videos the user already clipped manually ----------
// Files from YT-Download.bat (and AutoClip web downloads) carry the YouTube ID
// in their name: "Judul [lqeDF5JwYvM].mp4". Any such ID counts as already clipped.
function scanManualIds(processed) {
  const home = os.homedir();
  const dirs = cfg.scanDirs || [
    path.join(home, 'Videos', 'YT Download'),
    path.join(home, 'Downloads'),
    OUT_ROOT,
  ];
  const found = new Map();
  const walk = (d, depth) => {
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const m = /\[([\w-]{11})\]/.exec(e.name);
      if (m && !processed.has(m[1]) && !found.has(m[1])) found.set(m[1], e.name);
      if (e.isDirectory() && depth > 0) walk(path.join(d, e.name), depth - 1);
    }
  };
  for (const d of dirs) walk(d, 2);
  if (found.size) {
    const lines = [...found].map(([id, name]) => `${id}\t${today}\t(manual) ${name.slice(0, 80)}`);
    fs.appendFileSync(PROCESSED, lines.join('\n') + '\n');
    for (const id of found.keys()) processed.add(id);
    log(`Ditemukan ${found.size} video yang sudah Anda clip/download sendiri -> dicatat ke processed.txt`);
  }
}

// ---------- main ----------
async function main() {
  log('AutoClip Worker mulai. Tanggal:', today);
  for (const [name, p] of [['yt-dlp', YTDLP], ['ffmpeg', FFMPEG], ['ffprobe', FFPROBE], ['font', FONT]]) {
    if (!fs.existsSync(p)) throw new Error(`${name} tidak ditemukan di ${p}. Jalankan YT-Download.bat sekali / SETUP-WORKER.bat.`);
  }
  if (!cfg.password) throw new Error('Password AutoClip belum diisi. Jalankan SETUP-WORKER.bat.');
  await api('/api/auth', { method: 'POST' }, 2);

  // keep yt-dlp fresh (YouTube changes often)
  await run(YTDLP, ['-U'], { quiet: true });

  const processed = new Set(readLines(PROCESSED).map((l) => l.split(/\s/)[0]));
  scanManualIds(processed);
  const videos = await pickVideos(processed);
  if (!videos.length) {
    summary.push('Tidak ada video baru yang cocok hari ini.');
    log(summary[0]);
    return;
  }
  log(`Video terpilih: ${videos.length}`);

  let i = 0;
  for (const v of videos) {
    i++;
    try {
      const { outDir, made } = await processVideo(v, i);
      summary.push(`✓ ${made.length} klip dari "${v.title}" (${v.channel}) → ${outDir}`);
    } catch (e) {
      summary.push(`✗ "${v.title || v.url}": ${e.message}`);
      log('  ✗', e.message);
      if (e.fatal) throw e;
    } finally {
      // never retry the same video tomorrow (avoid loops on broken videos)
      fs.appendFileSync(PROCESSED, `${v.id}\t${today}\t${(v.title || '').slice(0, 80)}\n`);
    }
  }
  // remove processed queue entries
  const done = new Set(videos.map((v) => v.id));
  const rest = (fs.existsSync(QUEUE) ? fs.readFileSync(QUEUE, 'utf8').split(/\r?\n/) : []).filter(
    (l) => !done.has((/(?:v=|youtu\.be\/|shorts\/|live\/)([\w-]{11})/.exec(l) || [])[1]),
  );
  if (fs.existsSync(QUEUE)) fs.writeFileSync(QUEUE, rest.join('\n'));
}

main()
  .catch((e) => {
    summary.push(`GAGAL: ${e.message}`);
    log('GAGAL:', e.message);
    process.exitCode = 1;
  })
  .finally(() => {
    const text = `AutoClip Worker — ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}\n${summary.join('\n')}\n`;
    try {
      fs.writeFileSync(STATUS, text);
      const dayDir = path.join(OUT_ROOT, today);
      if (fs.existsSync(dayDir)) fs.appendFileSync(path.join(dayDir, 'RINGKASAN.txt'), text + '\n');
    } catch {}
    log('\n' + text);
  });
