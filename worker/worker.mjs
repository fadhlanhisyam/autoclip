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
import readline from 'node:readline/promises';
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
  nicheMaxAgeDays: 365,
  nicheMinVideoMinutes: 3,
  nicheMinViews: 1000,
  nicheTries: 3,
  nicheFallback: false,
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
const NICHES = path.join(HERE, 'niche.txt');
const STATUS = path.join(HERE, 'status-terakhir.txt');

const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Jakarta' }); // YYYY-MM-DD
const summary = [];

// manual runs (JALANKAN-SEKARANG.bat) also keep a log file, so problems can be checked afterwards
const LOGFILE = process.argv.includes('--tanya') ? path.join(HERE, 'logs', `manual-${today}.log`) : null;
function log(...a) {
  const t = new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false });
  console.log(`[${t}]`, ...a);
  if (LOGFILE) {
    try {
      fs.mkdirSync(path.dirname(LOGFILE), { recursive: true });
      fs.appendFileSync(LOGFILE, `[${t}] ${a.map(String).join(' ')}\r\n`);
    } catch {}
  }
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

// YouTube changes often; an old yt-dlp then fails every search. Update once per run if that happens.
let ytdlpUpdated = false;
async function ytdlpSearch(query) {
  let r = await ytdlp(['--flat-playlist', '--print', PRINT, query], { quiet: true });
  if (r.code !== 0 && !ytdlpUpdated) {
    ytdlpUpdated = true;
    log('  ! yt-dlp error:', lastLine(r.err), '-> mencoba update yt-dlp...');
    const u = await run(YTDLP, ['-U'], { quiet: true });
    log('   ', lastLine(u.out || u.err));
    r = await ytdlp(['--flat-playlist', '--print', PRINT, query], { quiet: true });
  }
  if (r.code !== 0) log('  ! yt-dlp error:', lastLine(r.err));
  return r;
}
const lastLine = (t) => String(t || '').trim().split(/\r?\n/).filter(Boolean).pop()?.slice(0, 300) || '(tanpa pesan)';

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

// niche.txt: "skincare" or "skincare | podcast skincare kulit kering"
function readNiches() {
  return readLines(NICHES).map((l) => {
    const [name, query] = l.split('|').map((s) => s.trim());
    return { name, query: query || `podcast ${name}`, queries: query ? [query] : [`review ${name}`, `review produk ${name} podcast`, `podcast ${name}`] };
  }).filter((n) => n.name);
}

async function nicheCandidates(processed) {
  const out = [];
  const minDate = new Date(Date.now() - cfg.nicheMaxAgeDays * 86400000).toISOString().slice(0, 10).replace(/-/g, '');
  for (const n of readNiches()) {
    log('Mencari podcast untuk niche:', n.name, `(${n.queries.map((q) => `"${q}"`).join(', ')})`);
    const keys = n.name.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && w !== 'podcast');
    const skip = { sudahDiproses: 0, terlaluPendek: 0, terlaluPanjang: 0, viewsSedikit: 0 };
    let found = 0;
    for (const [q, prefix] of n.queries.flatMap((q) => [[q, 'ytsearch20'], [q, 'ytsearchdate20']])) {
      const r = await ytdlpSearch(`${prefix}:${q}`);
      for (const v of parseListing(r.out)) {
        found++;
        if (out.some((c) => c.id === v.id)) continue;
        if (processed.has(v.id)) { skip.sudahDiproses++; continue; }
        if (v.duration && v.duration < cfg.nicheMinVideoMinutes * 60) { skip.terlaluPendek++; continue; }
        if (v.duration && v.duration > cfg.maxVideoMinutes * 60) { skip.terlaluPanjang++; continue; }
        if (v.views && v.views < cfg.nicheMinViews) { skip.viewsSedikit++; continue; }
        const title = v.title.toLowerCase();
        // niche words in the title, plus a bonus for review/product talk
        const match = keys.filter((k) => title.includes(k)).length * 2 + (/review|rekomendasi|produk|unboxing|racun/.test(title) ? 1 : 0);
        out.push({ ...v, niche: n.name, minDate, match });
      }
    }
    const why = Object.entries(skip).filter(([, c]) => c).map(([k, c]) => `${k} ${c}`).join(', ');
    log(`  ${out.filter((c) => c.niche === n.name).length} kandidat untuk "${n.name}" (hasil pencarian ${found}${why ? `; dilewati: ${why}` : ''}).`);
    if (!found) log('  ! Pencarian YouTube tidak mengembalikan hasil sama sekali. Cek koneksi internet / pesan yt-dlp di atas.');
  }
  // titles that mention the niche first, then most watched
  return out.sort((a, b) => b.match - a.match || b.views - a.views);
}

// next niche video that is not too old (checks upload date lazily)
async function takeNiche(pool, exclude, preferNiche) {
  for (let i = 0; i < pool.length; i++) {
    const v = pool[i];
    if (exclude.has(v.id) || (preferNiche && v.niche !== preferNiche)) continue;
    pool.splice(i, 1);
    i--;
    const d = await uploadDate(v.url);
    if (d && d < v.minDate) continue;
    return { ...v, uploadDate: d };
  }
  return null;
}

const nichePool = [];

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

  // 1) niche videos first (one per niche if possible)
  const niches = readNiches();
  if (niches.length) {
    nichePool.push(...(await nicheCandidates(processed)));
    const ids = new Set(picked.map((p) => p.id));
    for (const pass of [0, 1]) {
      for (const n of niches) {
        if (picked.length >= cfg.videosPerDay) break;
        if (pass === 0 && picked.some((p) => p.niche === n.name)) continue;
        const v = await takeNiche(nichePool, ids, pass === 0 ? n.name : null);
        if (v) {
          picked.push(v);
          ids.add(v.id);
        }
      }
    }
    if (picked.length >= cfg.videosPerDay || !cfg.nicheFallback) {
      if (!picked.length) log(`Tidak ada podcast yang cocok untuk niche: ${niches.map((n) => n.name).join(', ')}. Coba kata kunci lain di niche.txt (format: niche | kata kunci).`);
      return picked;
    }
  }

  // 2) then trending podcasts from channels.txt
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

// Is (part of) the product name really spoken inside the clip? Fuzzy on purpose:
// Whisper may spell brands slightly differently ("Vaselin" vs "Vaseline").
function productSpoken(c, words) {
  if (!c.product) return false;
  const norm = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');
  const tokens = c.product.split(/\s+/).map(norm).filter((w) => w.length >= 3);
  if (!tokens.length) return false;
  const spoken = words.filter((w) => w.end > c.start - 2 && w.start < c.end + 2).map((w) => norm(w.word));
  return tokens.some((tk) => spoken.some((s) => s && (s.startsWith(tk.slice(0, 5)) || tk.startsWith(s.slice(0, 5))) && s.length >= 3));
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
      notes: v.niche
        ? `Klip untuk konten AFFILIATE niche "${v.niche}". Pilih momen saat pembicara menyebut NAMA produk ${v.niche} tertentu (merek/nama produk) dan menjelaskan fungsi, manfaat, kandungan, atau cara pakainya. Klip harus dimulai dari kalimat yang kuat dan memuat nama produk + penjelasannya.`
        : cfg.notes,
      productMode: !!v.niche && cfg.productOnly !== false,
      niche: v.niche || '',
    }),
  });
  let clips = snapClips(h.clips || [], segments, { minDur: cfg.minDur, maxDur: cfg.maxDur, duration });
  if (v.niche && cfg.productOnly !== false) {
    // keep only clips whose product name was really spoken inside the clip
    const before = clips.length;
    clips = clips.filter((c) => productSpoken(c, words));
    if (before !== clips.length) log(`  ${before - clips.length} klip dibuang: nama produk tidak benar-benar diucapkan.`);
  }
  clips = clips.slice(0, cfg.clipsPerVideo);
  if (!clips.length) {
    throw Object.assign(new Error(v.niche ? `video ini tidak menjelaskan produk ${v.niche} secara spesifik` : 'AI tidak menemukan momen yang cocok.'), { notRelevant: !!v.niche });
  }
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
    ...(v.niche ? [`NICHE AFFILIATE: ${v.niche}`] : []),
    '',
    ...made.flatMap((c) => [
      `==================== ${c.file} (${Math.round(c.dur)} detik, skor ${c.score}) ====================`,
      `Judul: ${c.title}`,
      `Bagian video asli: ${fmtTime(c.start)} – ${fmtTime(c.end)}`,
      `Kenapa dipilih: ${c.reason}`,
      ...(c.product ? [`PRODUK: ${c.product}`, `FUNGSI: ${c.benefit}`, `-> Pasang link affiliate "${c.product}" di keranjang kuning / bio`] : []),
      '',
      'CAPTION (siap tempel):',
      `${c.hook}`,
      ...(c.product ? [`${c.product}: ${c.benefit} Link produknya ada di keranjang kuning 👇`] : []),
      '',
      credit,
      `#fyp #podcastindonesia ${tag}${v.niche ? ' #' + v.niche.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase() : ''}`.trim(),
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

// ---------- interactive questions (only when started with --tanya) ----------
function writeNiches(list) {
  const header = (fs.existsSync(NICHES) ? fs.readFileSync(NICHES, 'utf8').replace(/^\uFEFF/, '') : '')
    .split(/\r?\n/)
    .filter((l) => l.trim().startsWith('#'));
  fs.writeFileSync(NICHES, [...header, '', ...list, ''].join('\r\n'));
}

async function askUser() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (q) => {
    process.stdout.write(q);
    const { value } = await lines.next();
    return value ?? '';
  };
  try {
    const current = readNiches().map((n) => n.name);
    console.log('\n==============================================');
    console.log('  Niche produk affiliate saat ini: ' + (current.length ? current.join(', ') : '(belum ada)'));
    console.log('==============================================');
    const a = (await ask('Niche produk hari ini? (pisahkan dengan koma | Enter = tetap | - = tanpa niche)\n> ')).trim();
    if (a === '-') {
      writeNiches([]);
      log('Niche dikosongkan: worker mencari podcast yang sedang ramai.');
    } else if (a) {
      const list = a.split(',').map((s) => s.trim()).filter(Boolean);
      writeNiches(list);
      log('Niche disimpan:', list.join(', '));
    }
    const b = (await ask('Ada link YouTube khusus? (tempel, pisahkan dengan spasi | Enter = cari otomatis)\n> ')).trim();
    const links = b.split(/\s+/).filter((s) => /youtu\.?be/.test(s));
    if (links.length) {
      fs.appendFileSync(QUEUE, '\n' + links.join('\n') + '\n');
      log(`${links.length} link ditambahkan ke antrian.`);
    }
    const c = (await ask(`Berapa video yang diproses kali ini? (Enter = ${cfg.videosPerDay})\n> `)).trim();
    if (/^\d+$/.test(c) && +c > 0) cfg.videosPerDay = Math.min(10, +c);
  } finally {
    rl.close();
  }
}

// ---------- main ----------
async function main() {
  log('AutoClip Worker mulai. Tanggal:', today);
  if (process.argv.includes('--tanya')) await askUser();
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
    const ns = readNiches().map((n) => n.name);
    summary.push(ns.length && !cfg.nicheFallback
      ? `Tidak ada podcast baru yang cocok untuk niche: ${ns.join(', ')}. Coba kata kunci lain (niche.txt, format: niche | kata kunci).`
      : 'Tidak ada video baru yang cocok hari ini.');
    log(summary[0]);
    return;
  }
  log(`Video terpilih: ${videos.length}`);

  let i = 0;
  const done = [];
  for (let v of videos) {
    let tries = 0;
    while (v) {
      i++;
      done.push(v);
      try {
        const { outDir, made } = await processVideo(v, i);
        summary.push(`✓ ${made.length} klip dari "${v.title}" (${v.channel})${v.niche ? ' [niche: ' + v.niche + ']' : ''} → ${outDir}`);
        fs.appendFileSync(PROCESSED, `${v.id}\t${today}\t${(v.title || '').slice(0, 80)}\n`);
        v = null;
      } catch (e) {
        log('  ✗', e.message);
        fs.rmSync(path.join(WORK, v.id), { recursive: true, force: true });
        if (e.fatal) throw e;
        // never retry the same video tomorrow (avoid loops on broken videos)
        fs.appendFileSync(PROCESSED, `${v.id}\t${today}\t${(v.title || '').slice(0, 80)}\n`);
        if (e.notRelevant && ++tries < cfg.nicheTries) {
          const next = await takeNiche(nichePool, new Set(done.map((d) => d.id)), v.niche);
          if (next) {
            log(`  → mencoba podcast ${v.niche} berikutnya: "${next.title}"`);
            v = next;
            continue;
          }
        }
        summary.push(`✗ "${v.title || v.url}": ${e.message}`);
        v = null;
        continue;
      }
    }
  }
  const videosDone = done;
  // remove processed queue entries
  const doneIds = new Set(videosDone.map((v) => v.id));
  const rest = (fs.existsSync(QUEUE) ? fs.readFileSync(QUEUE, 'utf8').split(/\r?\n/) : []).filter(
    (l) => !doneIds.has((/(?:v=|youtu\.be\/|shorts\/|live\/)([\w-]{11})/.exec(l) || [])[1]),
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
