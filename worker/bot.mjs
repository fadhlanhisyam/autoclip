// AutoClip bot Telegram: kirim link YouTube dari HP, PC yang mengerjakan, klip dikirim balik ke chat.
//   node bot.mjs --setup   -> hubungkan bot (sekali)
//   node bot.mjs           -> jalankan bot (biarkan PC menyala)

import { spawn } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONF = path.join(HERE, 'telegram.json');
const LOCK = path.join(HERE, 'bot.pid');
const JOBS = path.join(HERE, 'work', 'bot');
const NODE = process.execPath;
const WCFG = readJsonEarly(path.join(HERE, 'config.json'));
const FFMPEG = WCFG.ffmpeg || path.join(HERE, '..', 'tools', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const FFPROBE = WCFG.ffprobe || path.join(HERE, '..', 'tools', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
function readJsonEarly(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return {};
  }
}
const MAX_UPLOAD = 49 * 1024 * 1024; // Telegram bot limit is 50 MB
const LAYOUT_TIMEOUT = 15 * 60 * 1000; // no answer on the preview -> continue with it

const readJson = (p, d) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
  } catch {
    return d;
  }
};
let conf = readJson(CONF, {});
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Jakarta' });
function log(...a) {
  const t = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false });
  console.log(`[${t}]`, ...a);
  try {
    fs.mkdirSync(path.join(HERE, 'logs'), { recursive: true });
    fs.appendFileSync(path.join(HERE, 'logs', `bot-${today()}.log`), `[${t}] ${a.map(String).join(' ')}\r\n`);
  } catch {}
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ytId = (s) => (/(?:v=|youtu\.be\/|shorts\/|live\/)([\w-]{11})/.exec(s) || [])[1];

// ---------- Telegram API ----------
async function tg(method, params = {}, token = conf.token) {
  const isForm = params instanceof FormData;
  const res = await fetch(`${process.env.TG_API || 'https://api.telegram.org'}/bot${token}/${method}`, {
    method: 'POST',
    headers: isForm ? undefined : { 'content-type': 'application/json' },
    body: isForm ? params : JSON.stringify(params),
    signal: AbortSignal.timeout(method === 'getUpdates' ? 70000 : 300000),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`${method}: ${data.description || res.status}`);
  return data.result;
}
const say = (text, extra = {}) =>
  tg('sendMessage', { chat_id: conf.owner, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra }).catch((e) => log('! kirim pesan gagal:', e.message));
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const kb = (rows) => ({ reply_markup: { inline_keyboard: rows.map((r) => r.map(([text, data]) => ({ text, callback_data: data }))) } });

async function sendFile(method, field, file, extra = {}) {
  const fd = new FormData();
  fd.append('chat_id', String(conf.owner));
  for (const [k, v] of Object.entries(extra)) fd.append(k, typeof v === 'string' ? v : JSON.stringify(v));
  fd.append(field, new Blob([fs.readFileSync(file)]), path.basename(file));
  return tg(method, fd);
}

// ---------- setup ----------
async function setup() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((r) => rl.question(q, (a) => r(a.trim())));
  console.log(`
=====================  HUBUNGKAN AUTOCLIP KE TELEGRAM  =====================
 1. Buka Telegram di HP, cari  @BotFather  (yang ada centang biru).
 2. Kirim:  /newbot
 3. Isi nama bot (bebas, mis. "AutoClip Dlans"), lalu username yang
    diakhiri "bot" (mis. "autoclip_dlans_bot").
 4. BotFather membalas dengan TOKEN, contoh: 123456789:AAH...xyz
    Salin token itu dan tempel di sini (klik kanan = paste).
===========================================================================`);
  let me;
  let token;
  for (;;) {
    token = (await ask('\nToken bot: ')).replace(/\s/g, '');
    try {
      me = await tg('getMe', {}, token);
      break;
    } catch {
      console.log('  Token tidak valid. Pastikan disalin lengkap dari BotFather.');
    }
  }
  const code = String(Math.floor(1000 + Math.random() * 9000));
  console.log(`\n  Bot ditemukan: @${me.username}\n\n  Sekarang buka bot itu di Telegram (t.me/${me.username}) dan kirim pesan:\n\n        /start ${code}\n\n  Menunggu…`);
  let offset = 0;
  let owner;
  while (!owner) {
    const ups = await tg('getUpdates', { offset, timeout: 30 }, token).catch(() => []);
    for (const u of ups) {
      offset = u.update_id + 1;
      const m = u.message;
      if (m?.text?.trim() === `/start ${code}`) owner = m.chat.id;
      else if (m?.text?.startsWith('/start')) await tg('sendMessage', { chat_id: m.chat.id, text: 'Kode salah. Lihat kode di layar PC.' }, token).catch(() => {});
    }
  }
  conf = { token, owner, username: me.username };
  fs.writeFileSync(CONF, JSON.stringify(conf, null, 2));
  await tg('getUpdates', { offset, timeout: 0 }, token).catch(() => {});
  await say(`✅ <b>Terhubung!</b> Bot ini sekarang hanya menerima perintah dari kamu.\n\n${HELP}`);

  // autostart, hidden (no window)
  const vbs = path.join(HERE, 'BOT-HP-tersembunyi.vbs');
  fs.writeFileSync(vbs, `CreateObject("WScript.Shell").Run """${NODE}"" ""${path.join(HERE, 'bot.mjs')}""", 0, False\r\n`);
  const auto = (await ask('\nJalankan bot otomatis (tanpa jendela) setiap PC menyala? (y/n): ')).toLowerCase();
  const startup = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'AutoClip-Bot.vbs');
  if (auto.startsWith('y')) {
    try {
      fs.copyFileSync(vbs, startup);
      console.log('  OK, bot akan jalan otomatis setiap PC menyala.');
    } catch (e) {
      console.log('  Gagal memasang autostart:', e.message);
    }
  } else {
    try {
      fs.rmSync(startup, { force: true });
    } catch {}
  }
  rl.close();
  if (process.platform === 'win32') {
    spawn('wscript.exe', [vbs], { detached: true, stdio: 'ignore' }).unref();
    console.log('\n  Bot sudah berjalan di latar belakang. Coba kirim link YouTube ke bot dari HP!');
  }
}

const HELP = `<b>Cara pakai</b>
• Kirim <b>link YouTube</b> → pilih 🎮 Gaming / 🛍 Produk / 🎙 Podcast
• <code>/niche skincare</code> → cari podcast yang membahas produk skincare & klipkan
• <code>/status</code> → lihat pekerjaan yang sedang jalan
• <code>/batal</code> → hentikan pekerjaan sekarang
Hasil dikirim ke chat ini (dan ke Google Drive kalau sudah di-setup).
PC harus tetap menyala & online.`;

// ---------- jobs ----------
const queue = [];
let current = null; // { job, child, statusMsg, lines, layoutMsgs, layoutTimer }
const pending = new Map(); // short id -> { url, mode }
let pid = 0;

function enqueue(job) {
  queue.push(job);
  const pos = queue.length + (current ? 1 : 0);
  say(pos > 1 ? `🕒 Masuk antrian (urutan ${pos}).` : '⏳ Mulai dikerjakan…');
  if (!current) runNext();
}

const IMPORTANT = /===|Klip \d+|✓|✗|⏳|AI memilih|momen|Transkrip (hanya|seluruh)|Download audio|Merender|GAGAL|Selesai|☁|Video terpilih|kandidat|tidak menjelaskan|mencoba podcast|Upload/;

async function runNext() {
  const job = queue.shift();
  if (!job) {
    current = null;
    return;
  }
  fs.mkdirSync(JOBS, { recursive: true });
  const result = path.join(JOBS, `result-${Date.now()}.json`);
  let script;
  let args;
  if (job.mode === 'gaming') {
    script = 'gaming.mjs';
    args = ['--bot', '--link', job.url, '--result', result, ...(job.corner ? ['--corner', String(job.corner)] : [])];
  } else if (job.mode === 'niche') {
    script = 'worker.mjs';
    args = ['--niche', job.niche, '--result', result];
  } else {
    script = 'worker.mjs';
    args = ['--link', job.url, '--result', result, ...(job.mode === 'produk' ? ['--produk'] : [])];
  }
  const label = job.mode === 'niche' ? `niche "${job.niche}"` : job.url;
  const statusMsg = await say(`⚙️ <b>${esc(job.mode.toUpperCase())}</b> ${esc(label)}\nMemulai…`);
  const child = spawn(NODE, [path.join(HERE, script), ...args], { cwd: HERE, windowsHide: true });
  current = { job, child, statusMsg, lines: [], layoutMsgs: [], lastEdit: 0, started: Date.now() };
  log('Mulai', job.mode, label);

  const cur = current;
  let buf = '';
  const onData = (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      handleLine(cur, line);
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', (d) => log('stderr:', String(d).slice(0, 300)));
  child.on('close', async (code) => {
    clearTimeout(cur.layoutTimer);
    await updateStatus(cur, true);
    await finish(cur, result, code);
    current = null;
    runNext();
  });
}

function handleLine(cur, line) {
  if (line.startsWith('@@PREVIEW ')) return sendPreview(cur, line.slice(10).trim());
  const clean = line.replace(/^\[[\d.:]+\]\s*/, '').trim();
  if (!clean || !IMPORTANT.test(clean)) return;
  log('  ', clean);
  cur.lines.push(clean.slice(0, 160));
  if (cur.lines.length > 9) cur.lines.shift();
  updateStatus(cur);
}

async function updateStatus(cur, force = false) {
  if (!cur.statusMsg) return;
  const now = Date.now();
  if (!force && now - cur.lastEdit < 4000) {
    clearTimeout(cur.editTimer);
    cur.editTimer = setTimeout(() => updateStatus(cur, true), 4000);
    return;
  }
  cur.lastEdit = now;
  const label = cur.job.mode === 'niche' ? `niche "${cur.job.niche}"` : cur.job.url;
  const mins = Math.round((now - cur.started) / 60000);
  await tg('editMessageText', {
    chat_id: conf.owner,
    message_id: cur.statusMsg.message_id,
    text: `⚙️ <b>${esc(cur.job.mode.toUpperCase())}</b> ${esc(label)} · ${mins} mnt\n\n${cur.lines.map(esc).join('\n')}`,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  }).catch(() => {});
}

const LAYOUT_KB = kb([
  [['✅ Pas, lanjut render', 'L:ok']],
  [['↖', 'L:1'], ['↗', 'L:2'], ['↙', 'L:3'], ['↘', 'L:4'], ['🚫 tanpa facecam', 'L:5']],
  [['➕ wajah', 'L:+'], ['➖ wajah', 'L:-'], ['⬆', 'L:w'], ['⬇', 'L:s'], ['⬅', 'L:a'], ['➡', 'L:d']],
  [['game ⬅', 'L:j'], ['game ➡', 'L:l'], ['bag. wajah ⬆', 'L:t'], ['bag. wajah ⬇', 'L:g']],
]);

async function sendPreview(cur, file) {
  for (const id of cur.layoutMsgs.splice(0)) tg('deleteMessage', { chat_id: conf.owner, message_id: id }).catch(() => {});
  try {
    const m = await sendFile('sendPhoto', 'photo', file, {
      caption:
        'Cek posisi: kiri = video asli (KUNING = wajah, BIRU = game), kanan = hasil 9:16.\n↖↗↙↘ = di pojok mana kamera wajah di video ASLI. Kalau sudah pas, tekan ✅.\n(Tanpa jawaban 15 menit → lanjut otomatis.)',
      reply_markup: LAYOUT_KB.reply_markup,
    });
    cur.layoutMsgs.push(m.message_id);
  } catch (e) {
    log('! kirim pratinjau gagal:', e.message);
    cur.child.stdin.write('\n');
    return;
  }
  clearTimeout(cur.layoutTimer);
  cur.layoutTimer = setTimeout(() => {
    say('⌛ Tidak ada jawaban, lanjut render dengan posisi ini.');
    layoutAnswer(cur, 'ok');
  }, LAYOUT_TIMEOUT);
}

function layoutAnswer(cur, a) {
  clearTimeout(cur.layoutTimer);
  if (a === 'ok') {
    for (const id of cur.layoutMsgs.splice(0)) tg('editMessageReplyMarkup', { chat_id: conf.owner, message_id: id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    cur.child.stdin.write('\n');
  } else {
    cur.child.stdin.write(`${a}\n`);
  }
}

function runP(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => resolve({ code: -1, out }));
    p.on('close', (code) => resolve({ code, out }));
  });
}

// Telegram bots may only send files up to 50 MB: make a smaller copy just for the chat
async function telegramCopy(file) {
  const size = fs.statSync(file).size;
  if (size <= MAX_UPLOAD) return { file, temp: false };
  const pr = await runP(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  const dur = Number(pr.out.trim()) || 60;
  const kbps = Math.max(800, Math.floor((42 * 8 * 1024) / dur) - 128); // aim ~42 MB
  const out = path.join(JOBS, `tg-${Date.now()}.mp4`);
  const r = await runP(FFMPEG, ['-y', '-v', 'error', '-i', file, '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`, '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out]);
  if (r.code !== 0 || !fs.existsSync(out) || fs.statSync(out).size > MAX_UPLOAD) {
    fs.rmSync(out, { force: true });
    return null;
  }
  return { file: out, temp: true };
}

async function finish(cur, resultFile, code) {
  const r = readJson(resultFile, null);
  fs.rmSync(resultFile, { force: true });
  if (cur.cancelled) return say('🛑 Dibatalkan.');
  if (!r) return say(`❌ Gagal (kode ${code}). Baris terakhir:\n${esc(cur.lines.slice(-3).join('\n'))}`);
  let sent = 0;
  let total = 0;
  for (const item of r.items || []) {
    if (item.error && !item.made?.length) {
      await say(`❌ ${esc(item.title || item.url || '')}\n${esc(item.error)}`);
      continue;
    }
    for (const c of item.made || []) {
      total++;
      const caption = [
        `<b>${esc(c.title)}</b>`,
        c.product ? `🛍 ${esc(c.product)}${c.benefit ? ' — ' + esc(c.benefit) : ''}` : '',
        c.hook ? `\n${esc(c.hook)}` : '',
        `\n🎬 ${esc(item.title || '')}${item.channel ? ' — ' + esc(item.channel) : ''}`,
      ]
        .filter(Boolean)
        .join('\n')
        .slice(0, 1000);
      try {
        const tgFile = await telegramCopy(c.file);
        if (!tgFile) {
          await say(`${caption}\n\n📁 Terlalu besar untuk Telegram — ada di PC / Google Drive.`);
          continue;
        }
        try {
          await sendFile('sendVideo', 'video', tgFile.file, { caption, parse_mode: 'HTML', supports_streaming: 'true', width: '1080', height: '1920' });
        } finally {
          if (tgFile.temp) fs.rmSync(tgFile.file, { force: true });
        }
        sent++;
      } catch (e) {
        log('! kirim video gagal:', e.message);
        await say(`${caption}\n\n⚠️ Gagal dikirim ke Telegram (${esc(e.message)}). File ada di PC.`);
      }
    }
  }
  const mins = Math.round((Date.now() - cur.started) / 60000);
  await say(total ? `✅ Selesai: ${total} klip (${sent} terkirim ke sini) dalam ${mins} menit.` : `Selesai tanpa klip. ${esc((r.summary || []).slice(-2).join('\n'))}`);
}

// ---------- messages ----------
async function onMessage(m) {
  const text = (m.text || m.caption || '').trim();
  if (!text) return;
  if (text.startsWith('/start') || text === '/help' || text === '/bantuan') return say(HELP);
  if (text === '/status') {
    if (!current) return say(queue.length ? `🕒 Antrian: ${queue.length}` : '💤 Tidak ada pekerjaan. Kirim link YouTube untuk mulai.');
    const mins = Math.round((Date.now() - current.started) / 60000);
    return say(`⚙️ Sedang: ${esc(current.job.mode)} ${esc(current.job.url || current.job.niche)} (${mins} mnt)\n${esc(current.lines.slice(-4).join('\n'))}\nAntrian: ${queue.length}`);
  }
  if (text === '/batal') {
    if (!current) return say('Tidak ada pekerjaan yang jalan.');
    current.cancelled = true;
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(current.child.pid), '/t', '/f'], { windowsHide: true });
    else current.child.kill();
    return;
  }
  const niche = /^\/niche\s+(.+)/i.exec(text);
  if (niche) return enqueue({ mode: 'niche', niche: niche[1].trim().slice(0, 60) });

  const urls = text.split(/\s+/).filter((s) => ytId(s));
  if (!urls.length) return say('Kirim link YouTube, atau ketik /help.');
  for (const url of urls) {
    const k = String(++pid);
    pending.set(k, { url: `https://www.youtube.com/watch?v=${ytId(url)}` });
    await say(`Mau dijadikan klip apa?\n${esc(url)}`, kb([[['🎮 Gaming', `M:${k}:gaming`], ['🛍 Produk', `M:${k}:produk`], ['🎙 Podcast', `M:${k}:podcast`]]]));
  }
}

async function onCallback(q) {
  tg('answerCallbackQuery', { callback_query_id: q.id }).catch(() => {});
  const d = q.data || '';
  const msg = q.message;
  const clearButtons = (extra) =>
    tg('editMessageText', { chat_id: conf.owner, message_id: msg.message_id, text: `${msg.text}\n\n→ ${extra}`, disable_web_page_preview: true }).catch(() => {});
  if (d.startsWith('L:')) {
    if (current?.layoutMsgs.includes(msg.message_id)) layoutAnswer(current, d.slice(2));
    return;
  }
  const mm = /^M:(\d+):(\w+)$/.exec(d);
  if (mm) {
    const p = pending.get(mm[1]);
    if (!p) return;
    if (mm[2] === 'gaming') {
      clearButtons('🎮 Gaming');
      return say(
        'Di video ASLI, kamera wajah streamer ada di pojok mana?',
        kb([
          [['↖ kiri atas', `C:${mm[1]}:1`], ['↗ kanan atas', `C:${mm[1]}:2`]],
          [['↙ kiri bawah', `C:${mm[1]}:3`], ['↘ kanan bawah', `C:${mm[1]}:4`]],
          [['🚫 tanpa facecam', `C:${mm[1]}:5`], ['🔁 sama seperti terakhir', `C:${mm[1]}:0`]],
        ]),
      );
    }
    pending.delete(mm[1]);
    clearButtons(mm[2] === 'produk' ? '🛍 Produk (affiliate)' : '🎙 Podcast');
    return enqueue({ mode: mm[2], url: p.url });
  }
  const cm = /^C:(\d+):([0-5])$/.exec(d);
  if (cm) {
    const p = pending.get(cm[1]);
    if (!p) return;
    pending.delete(cm[1]);
    clearButtons(['posisi terakhir', 'kiri atas', 'kanan atas', 'kiri bawah', 'kanan bawah', 'tanpa facecam'][+cm[2]]);
    return enqueue({ mode: 'gaming', url: p.url, corner: +cm[2] || null });
  }
}

// keep Windows awake while the bot runs (screen may still turn off)
function keepAwake() {
  if (process.platform !== 'win32') return;
  const ps = `$s=Add-Type -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);' -Name P -Namespace W -PassThru; while($true){ [void]$s::SetThreadExecutionState(0x80000001); if(-not (Get-Process -Id ${process.pid} -EA SilentlyContinue)){exit}; Start-Sleep 60 }`;
  spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
}

async function main() {
  if (process.argv.includes('--setup')) return setup();
  if (!conf.token || !conf.owner) {
    console.log('Bot belum di-setup. Jalankan SETUP-BOT-HP.bat dulu.');
    process.exitCode = 1;
    return;
  }
  // single instance
  const old = Number(readJson(LOCK, 0));
  if (old && old !== process.pid) {
    try {
      process.kill(old, 0);
      console.log(`Bot sudah berjalan (PID ${old}).`);
      return;
    } catch {}
  }
  fs.writeFileSync(LOCK, String(process.pid));
  process.on('exit', () => {
    try {
      if (Number(readJson(LOCK, 0)) === process.pid) fs.rmSync(LOCK, { force: true });
    } catch {}
  });
  keepAwake();
  log(`Bot @${conf.username || ''} berjalan di ${os.hostname()}.`);
  await say(`🟢 AutoClip online di PC (${esc(os.hostname())}). Kirim link YouTube kapan saja.`);

  let offset = 0;
  for (;;) {
    let ups = [];
    try {
      ups = await tg('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] });
    } catch (e) {
      log('! getUpdates:', e.message);
      await sleep(10000);
      continue;
    }
    for (const u of ups) {
      offset = u.update_id + 1;
      const chat = u.message?.chat?.id ?? u.callback_query?.message?.chat?.id;
      if (chat !== conf.owner) continue; // only the owner may use this bot
      try {
        if (u.message) await onMessage(u.message);
        else if (u.callback_query) await onCallback(u.callback_query);
      } catch (e) {
        log('! error:', e.message);
        say(`⚠️ ${esc(e.message)}`);
      }
    }
  }
}

main().catch((e) => {
  log('GAGAL:', e.message);
  process.exitCode = 1;
});
