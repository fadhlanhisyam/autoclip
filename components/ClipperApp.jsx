'use client';

import { useEffect, useRef, useState } from 'react';
import { fmtTime, snapClips } from '@/lib/highlights';
import { buildAss } from '@/lib/captions';
import { OUT_W, OUT_H } from '@/lib/commands';

const CHUNK_SEC = 480; // 8 min of 32 kbps audio ≈ 1.9 MB, safely under Vercel's 4.5 MB limit

function slug(s) {
  return (s || 'clip').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'clip';
}

export default function ClipperApp() {
  const [password, setPassword] = useState('');
  const [needPassword, setNeedPassword] = useState(false);

  const [file, setFile] = useState(null);
  const [videoUrl, setVideoUrl] = useState(null);
  const [meta, setMeta] = useState(null); // {duration, w, h}

  const [language, setLanguage] = useState('id');
  const [count, setCount] = useState(6);
  const [minDur, setMinDur] = useState(25);
  const [maxDur, setMaxDur] = useState(60);
  const [notes, setNotes] = useState('');
  const [defaultLayout, setDefaultLayout] = useState('crop');

  const [stage, setStage] = useState('idle'); // idle | working | ready
  const [status, setStatus] = useState('');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');

  const [transcript, setTranscript] = useState(null);
  const [clips, setClips] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [rendering, setRendering] = useState(false);
  const [fastMode, setFastMode] = useState(false);
  const [engine, setEngine] = useState('');

  const playerRef = useRef(null);
  const stopAtRef = useRef(null);
  const transcriptKeyRef = useRef(null);
  const clipsRef = useRef(clips);
  clipsRef.current = clips;

  useEffect(() => {
    try {
      setPassword(localStorage.getItem('autoclip-pass') || '');
    } catch {}
  }, []);

  function savePassword(v) {
    setPassword(v);
    try {
      localStorage.setItem('autoclip-pass', v);
    } catch {}
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: { ...(opts.headers || {}), 'x-app-password': password },
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      setNeedPassword(true);
      throw new Error('Password salah atau belum diisi.');
    }
    if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
    return data;
  }

  function pickFile(f) {
    if (!f) return;
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    setFile(f);
    setVideoUrl(URL.createObjectURL(f));
    setMeta(null);
    setTranscript(null);
    setClips([]);
    setStage('idle');
    setError('');
  }

  function onMeta(e) {
    const v = e.currentTarget;
    if (!meta && v.videoWidth) setMeta({ duration: v.duration, w: v.videoWidth, h: v.videoHeight });
  }

  function updateClip(id, patch) {
    setClips((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }

  async function start() {
    if (!file || !meta) return;
    setError('');
    setStage('working');
    setClips([]);
    try {
      // 0. check the password first, so a long job never fails halfway
      setStatus('Mengecek password…');
      await api('/api/auth', { method: 'POST' });

      const tKey = `${file.name}|${file.size}|${language}`;
      let segments = [];
      let words = [];
      if (transcript && transcriptKeyRef.current === tKey) {
        // same video + language: reuse the transcript, only re-pick the moments
        segments = transcript.segments;
        words = transcript.words;
      } else {
      const { getFFmpeg, extractAudioChunks, setPreferMultiThread, isMultiThread } = await import('@/lib/ffmpeg');

      setStatus('Memuat mesin video (±30 MB, hanya sekali)…');
      setProgress(0);
      // multi-core is reliable (and much faster) for audio extraction
      setPreferMultiThread(true);
      await getFFmpeg();

      // 1. audio
      setStatus('Mengambil audio dari video…');
      const chunks = await extractAudioChunks(file, meta.duration, CHUNK_SEC, setProgress);

      // 2. transcript (2 chunks at a time)
      // video title (without extension / [youtube-id]) as a spelling hint for names
      const videoHint = file.name.replace(/\.[^.]+$/, '').replace(/\[[^\]]*\]/g, '').replace(/[_-]+/g, ' ').trim();
      let done = 0;
      setStatus(`Membuat transkrip (0/${chunks.length})…`);
      setProgress(0);
      const results = new Array(chunks.length);
      let next = 0;
      async function worker() {
        while (next < chunks.length) {
          const i = next++;
          const fd = new FormData();
          fd.append('file', chunks[i].blob, `chunk_${i}.mp3`);
          fd.append('language', language);
          fd.append('prompt', videoHint);
          results[i] = await api('/api/transcribe', { method: 'POST', body: fd });
          done++;
          setStatus(`Membuat transkrip (${done}/${chunks.length})…`);
          setProgress(done / chunks.length);
        }
      }
      await Promise.all([worker(), worker()]);
      results.forEach((r, i) => {
        const off = chunks[i].start;
        segments.push(...r.segments.map((s) => ({ ...s, start: s.start + off, end: s.end + off })));
        words.push(...r.words.map((w) => ({ ...w, start: w.start + off, end: w.end + off })));
      });
      if (!segments.length) throw new Error('Tidak ada suara/ucapan yang terdeteksi di video ini.');
      setTranscript({ segments, words });
      transcriptKeyRef.current = tKey;
      }

      // 3. pick highlights
      setStatus('AI sedang memilih momen terbaik…');
      setProgress(0);
      const lang = language === 'en' ? 'en' : 'id';
      const { clips: raw } = await api('/api/highlights', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ segments, count, minDur, maxDur, language: lang, notes }),
      });
      const picked = snapClips(raw, segments, { minDur, maxDur, duration: meta.duration }).map((c) => ({
        ...c,
        centerX: 0.5,
        layout: defaultLayout,
        captions: true,
        showTitle: false,
        state: 'idle',
        progress: 0,
      }));
      if (!picked.length) throw new Error('AI tidak menemukan klip yang cocok. Coba ubah durasi atau catatan.');
      setClips(picked);
      setActiveId(picked[0].id);

      // 4. find faces for the crop
      setStatus('Mencari posisi wajah untuk crop vertikal…');
      try {
        const { findFaceCenter } = await import('@/lib/face');
        for (let i = 0; i < picked.length; i++) {
          setProgress(i / picked.length);
          const cx = await findFaceCenter(videoUrl, picked[i].start, picked[i].end);
          if (cx != null) updateClip(picked[i].id, { centerX: +cx.toFixed(3), faceFound: true });
        }
      } catch (e) {
        console.warn('Deteksi wajah gagal, pakai tengah', e);
      }

      setStage('ready');
      setStatus('');
    } catch (e) {
      console.error(e);
      setError(String(e.message || e));
      setStage(transcript ? 'ready' : 'idle');
    }
  }

  function preview(c) {
    setActiveId(c.id);
    const p = playerRef.current;
    if (!p) return;
    stopAtRef.current = c.end;
    p.currentTime = c.start;
    p.play();
  }

  function onTimeUpdate() {
    const p = playerRef.current;
    if (p && stopAtRef.current != null && p.currentTime >= stopAtRef.current) {
      p.pause();
      stopAtRef.current = null;
    }
  }

  async function render(id) {
    const c = clipsRef.current.find((x) => x.id === id);
    if (!c || !transcript) return;
    const { renderClip, setPreferMultiThread, getFFmpeg, isMultiThread } = await import('@/lib/ffmpeg');
    updateClip(id, { state: 'rendering', progress: 0, error: null });
    try {
      setPreferMultiThread(fastMode);
      await getFFmpeg();
      setEngine(isMultiThread() ? 'Mode cepat (multi-core) aktif' : 'Mode standar (1 core)');
      const ass = c.captions || c.showTitle
        ? buildAss(c.captions ? transcript.words : [], c.start, c.end, { title: c.showTitle ? c.title : '' })
        : null;
      const blob = await renderClip(
        file,
        { start: c.start, end: c.end, srcW: meta.w, srcH: meta.h, centerX: c.centerX, layout: c.layout, ass },
        (p) => updateClip(id, { progress: p }),
      );
      const old = clipsRef.current.find((x) => x.id === id)?.outUrl;
      if (old) URL.revokeObjectURL(old);
      updateClip(id, { state: 'done', progress: 1, outUrl: URL.createObjectURL(blob), size: blob.size });
    } catch (e) {
      console.error(e);
      updateClip(id, { state: 'error', error: String(e.message || e) });
    }
  }

  async function renderAll() {
    setRendering(true);
    for (const c of clipsRef.current) {
      if (c.state !== 'done') await render(c.id);
    }
    setRendering(false);
  }

  async function renderOne(id) {
    setRendering(true);
    await render(id);
    setRendering(false);
  }

  async function cancel() {
    const { cancelFFmpeg } = await import('@/lib/ffmpeg');
    cancelFFmpeg();
    setRendering(false);
    setClips((cs) => cs.map((c) => (c.state === 'rendering' ? { ...c, state: 'idle', progress: 0 } : c)));
    if (stage === 'working') {
      setStage('idle');
      setStatus('');
    }
  }

  // crop rectangle overlay on the preview player
  const active = clips.find((c) => c.id === activeId);
  let overlay = null;
  if (active && meta && active.layout === 'crop' && meta.w / meta.h > OUT_W / OUT_H) {
    const cw = (meta.h * OUT_W) / OUT_H;
    let x = active.centerX * meta.w - cw / 2;
    x = Math.max(0, Math.min(meta.w - cw, x));
    overlay = { left: `${(x / meta.w) * 100}%`, width: `${(cw / meta.w) * 100}%` };
  }

  // YouTube ID from the file name (YT-Download.bat names files 'Judul [ID].mp4'),
  // kept in downloaded clip names so the PC worker knows this video was clipped
  const videoId = (/\[([\w-]{11})\]/.exec(file?.name || '') || [])[1] || '';
  const busy = stage === 'working';

  return (
    <main className="wrap">
      <header className="top">
        <h1>
          AutoClip <span className="tag">beta</span>
        </h1>
        <p className="sub">Video panjang → klip vertikal 9:16 siap upload, lengkap dengan caption.</p>
      </header>

      {needPassword && (
        <div className="card warn">
          <label>
            Password aplikasi
            <input type="password" value={password} onChange={(e) => savePassword(e.target.value)} />
          </label>
          <button onClick={() => setNeedPassword(false)}>Simpan</button>
        </div>
      )}

      <section className="card">
        <label className="drop">
          <input type="file" accept="video/*" onChange={(e) => pickFile(e.target.files?.[0])} disabled={busy} />
          {file ? (
            <span>
              <b>{file.name}</b>
              <br />
              {(file.size / 1e6).toFixed(0)} MB
              {meta && ` · ${fmtTime(meta.duration)} · ${meta.w}×${meta.h}`}
            </span>
          ) : (
            <span>
              <b>Pilih video</b> (MP4 paling aman)
              <br />
              Video diproses di komputer Anda, tidak di-upload ke server.
            </span>
          )}
        </label>

        {videoUrl && (
          <div className="player">
            <video
              ref={playerRef}
              src={videoUrl}
              controls
              onLoadedMetadata={onMeta}
              onTimeUpdate={onTimeUpdate}
              onError={() => setError('Browser tidak bisa membaca video ini. Ubah dulu ke MP4 (H.264).')}
            />
            {overlay && <div className="crop" style={overlay} />}
          </div>
        )}

        <div className="grid">
          <label>
            Bahasa video
            <select value={language} onChange={(e) => setLanguage(e.target.value)} disabled={busy}>
              <option value="id">Indonesia</option>
              <option value="en">English</option>
              <option value="auto">Deteksi otomatis</option>
            </select>
          </label>
          <label>
            Jumlah klip
            <input type="number" min={1} max={15} value={count} onChange={(e) => setCount(+e.target.value)} disabled={busy} />
          </label>
          <label>
            Durasi min (detik)
            <input type="number" min={5} max={170} value={minDur} onChange={(e) => setMinDur(+e.target.value)} disabled={busy} />
          </label>
          <label>
            Durasi maks (detik)
            <input type="number" min={10} max={180} value={maxDur} onChange={(e) => setMaxDur(+e.target.value)} disabled={busy} />
          </label>
          <label>
            Tampilan
            <select value={defaultLayout} onChange={(e) => setDefaultLayout(e.target.value)} disabled={busy}>
              <option value="crop">Crop ikut wajah (podcast, vlog)</option>
              <option value="blur">Layar penuh + latar blur (gaming, layar)</option>
            </select>
          </label>
        </div>
        <label>
          Catatan untuk AI (opsional)
          <input
            type="text"
            placeholder="mis. fokus momen lucu / tips bisnis / bagian debat"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            disabled={busy}
          />
        </label>

        <div className="row">
          <button className="primary" onClick={start} disabled={!file || !meta || busy || rendering}>
            {clips.length ? 'Cari ulang klip' : 'Mulai auto clip'}
          </button>
          {(busy || rendering) && (
            <button className="ghost" onClick={cancel}>
              Batalkan
            </button>
          )}
        </div>

        {busy && (
          <div className="status">
            <div>{status}</div>
            <div className="bar">
              <div style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
          </div>
        )}
        {error && <div className="error">{error}</div>}
      </section>

      {clips.length > 0 && (
        <section>
          <div className="row between">
            <h2>{clips.length} klip ditemukan</h2>
            <button className="primary" onClick={renderAll} disabled={rendering || busy}>
              Render semua
            </button>
          </div>
          <p className="hint">
            Render berjalan di browser Anda (gratis). Kecepatannya tergantung komputer. Jangan tutup tab ini.
            <br />
            <label className="check inline">
              <input
                type="checkbox"
                checked={fastMode}
                onChange={(e) => setFastMode(e.target.checked)}
                disabled={rendering || busy}
              />
              Mode cepat render (eksperimental, pakai semua core CPU). Matikan kalau macet di 0%.
            </label>
            {engine && <span className="muted"> · {engine}</span>}
          </p>

          {clips.map((c, i) => (
            <article key={c.id} className={`card clip ${c.id === activeId ? 'active' : ''}`}>
              <div className="clip-head">
                <div className="score" title="Potensi viral menurut AI">
                  {c.score}
                </div>
                <div className="clip-title">
                  <h3>
                    {i + 1}. {c.title}
                  </h3>
                  <div className="muted">
                    {fmtTime(c.start)} – {fmtTime(c.end)} · {Math.round(c.end - c.start)} detik
                  </div>
                </div>
                <button className="ghost" onClick={() => preview(c)}>
                  ▶ Preview
                </button>
              </div>

              <p className="reason">{c.reason}</p>
              <div className="hook">
                <span>{c.hook}</span>
                <button className="link" onClick={() => navigator.clipboard?.writeText(c.hook)}>
                  Salin
                </button>
              </div>

              <div className="controls">
                <label>
                  Mulai (detik)
                  <input
                    type="number"
                    step="0.1"
                    value={c.start}
                    onChange={(e) => updateClip(c.id, { start: +e.target.value, state: 'idle' })}
                  />
                </label>
                <label>
                  Selesai (detik)
                  <input
                    type="number"
                    step="0.1"
                    value={c.end}
                    onChange={(e) => updateClip(c.id, { end: +e.target.value, state: 'idle' })}
                  />
                </label>
                <label>
                  Tampilan
                  <select value={c.layout} onChange={(e) => updateClip(c.id, { layout: e.target.value, state: 'idle' })}>
                    <option value="crop">Crop</option>
                    <option value="blur">Layar penuh + blur</option>
                  </select>
                </label>
                {c.layout === 'crop' && (
                  <label className="wide">
                    Posisi crop {c.faceFound ? '(wajah terdeteksi)' : ''}
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={c.centerX}
                      onChange={(e) => {
                        setActiveId(c.id);
                        updateClip(c.id, { centerX: +e.target.value, state: 'idle' });
                      }}
                    />
                  </label>
                )}
                <label className="check">
                  <input
                    type="checkbox"
                    checked={c.captions}
                    onChange={(e) => updateClip(c.id, { captions: e.target.checked, state: 'idle' })}
                  />
                  Caption otomatis
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={c.showTitle}
                    onChange={(e) => updateClip(c.id, { showTitle: e.target.checked, state: 'idle' })}
                  />
                  Judul di 4 detik awal
                </label>
                {c.showTitle && (
                  <label className="wide">
                    Teks judul
                    <input type="text" value={c.title} onChange={(e) => updateClip(c.id, { title: e.target.value, state: 'idle' })} />
                  </label>
                )}
              </div>

              <div className="row">
                {c.state === 'rendering' ? (
                  <div className="status grow">
                    <div>Merender… {Math.round(c.progress * 100)}%</div>
                    <div className="bar">
                      <div style={{ width: `${Math.round(c.progress * 100)}%` }} />
                    </div>
                  </div>
                ) : (
                  <button onClick={() => renderOne(c.id)} disabled={rendering || busy}>
                    {c.state === 'done' ? 'Render ulang' : 'Render klip ini'}
                  </button>
                )}
                {c.state === 'done' && c.outUrl && (
                  <a className="button primary" href={c.outUrl} download={`${i + 1}-${slug(c.title)}${videoId ? ` [${videoId}]` : ''}.mp4`}>
                    ⬇ Download ({(c.size / 1e6).toFixed(1)} MB)
                  </a>
                )}
              </div>
              {c.state === 'done' && c.outUrl && <video className="result" src={c.outUrl} controls />}
              {c.error && <pre className="error">{c.error}</pre>}
            </article>
          ))}
        </section>
      )}

      <footer className="foot">Transkrip: Whisper (Groq) · Pemilihan momen: Gemini · Render: ffmpeg.wasm di browser</footer>
    </main>
  );
}
