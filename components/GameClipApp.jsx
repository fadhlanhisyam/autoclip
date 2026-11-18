'use client';

// AutoClip Gaming: long horizontal gameplay / stream -> vertical split-screen clips
// (facecam on top, gameplay below) with subtitles and a faint watermark.

import { useEffect, useRef, useState } from 'react';
import { fmtTime, fitClips } from '@/lib/highlights';
import { buildAss } from '@/lib/captions';
import { OUT_W, OUT_H, splitHeights, boxPixels, gameFilter } from '@/lib/commands';

const CHUNK_SEC = 480;
const PREVIEW_W = 180;
const PREVIEW_H = 320;

const slug = (s) =>
  (s || 'clip').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'clip';
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function store(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
function save(key, v) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {}
}

export default function GameClipApp() {
  const [password, setPassword] = useState('');
  const [needPassword, setNeedPassword] = useState(false);

  const [file, setFile] = useState(null);
  const [videoUrl, setVideoUrl] = useState(null);
  const [meta, setMeta] = useState(null);

  const [language, setLanguage] = useState('id');
  const [count, setCount] = useState(5);
  const [minDur, setMinDur] = useState(20);
  const [maxDur, setMaxDur] = useState(50);
  const [notes, setNotes] = useState('');
  const [game, setGame] = useState('');

  // layout
  const [noCam, setNoCam] = useState(false);
  const [topRatio, setTopRatio] = useState(0.4);
  const [face, setFace] = useState({ x: 0.02, y: 0.6, w: 0.3 });
  const [gameBox, setGameBox] = useState({ x: 0.2, y: 0, w: 0.6 });
  const [faceNote, setFaceNote] = useState('');
  const [watermark, setWatermark] = useState('');
  const [captions, setCaptions] = useState(true);

  const [stage, setStage] = useState('idle');
  const [status, setStatus] = useState('');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const [data, setData] = useState(null); // {segments, words, peaks}
  const [clips, setClips] = useState([]);
  const [rendering, setRendering] = useState(false);

  const playerRef = useRef(null);
  const stageRef = useRef(null);
  const canvasRef = useRef(null);
  const stopAtRef = useRef(null);
  const dataKeyRef = useRef(null);
  const clipsRef = useRef(clips);
  clipsRef.current = clips;
  const layoutRef = useRef();
  layoutRef.current = { face, gameBox, topRatio, noCam, watermark, captions, meta };

  useEffect(() => {
    try {
      setPassword(localStorage.getItem('autoclip-pass') || '');
    } catch {}
    setWatermark(store('gameclip-wm', ''));
    setTopRatio(store('gameclip-top', 0.4));
  }, []);

  const { top, bottom } = splitHeights(topRatio);
  const faceAspect = OUT_W / top;
  const gameAspect = OUT_W / (noCam ? splitHeights(0.4).bottom : bottom);

  async function api(path, opts = {}) {
    const res = await fetch(path, { ...opts, headers: { ...(opts.headers || {}), 'x-app-password': password } });
    const d = await res.json().catch(() => ({}));
    if (res.status === 401) {
      setNeedPassword(true);
      throw new Error('Password salah atau belum diisi.');
    }
    if (!res.ok) throw new Error(d.error || `Error ${res.status}`);
    return d;
  }

  function pickFile(f) {
    if (!f) return;
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    setFile(f);
    setVideoUrl(URL.createObjectURL(f));
    setMeta(null);
    setData(null);
    setClips([]);
    setStage('idle');
    setError('');
    setFaceNote('');
  }

  // ---------- layout boxes ----------
  function maxW(aspect) {
    return meta ? Math.min(1, (aspect * meta.h) / meta.w) : 1;
  }
  function fitBox(b, aspect) {
    if (!meta) return b;
    const w = clamp(b.w, 0.05, maxW(aspect));
    const hN = (w * meta.w) / aspect / meta.h;
    return { w, x: clamp(b.x, 0, 1 - w), y: clamp(b.y, 0, Math.max(0, 1 - hN)) };
  }
  function centerGame(aspect = gameAspect) {
    const w = maxW(aspect);
    return { x: (1 - w) / 2, y: 0, w };
  }
  function cornerFace(corner) {
    const w = Math.min(0.32, maxW(faceAspect));
    const hN = meta ? (w * meta.w) / faceAspect / meta.h : 0.3;
    const x = corner.includes('kanan') ? 1 - w : 0;
    const y = corner.includes('bawah') ? 1 - hN : 0;
    setFace({ x, y, w });
  }

  async function onMeta(e) {
    const v = e.currentTarget;
    if (meta || !v.videoWidth) return;
    const m = { duration: v.duration, w: v.videoWidth, h: v.videoHeight };
    setMeta(m);
    const gw = Math.min(1, ((OUT_W / bottom) * m.h) / m.w);
    setGameBox({ x: (1 - gw) / 2, y: 0, w: gw });
    // find the facecam automatically
    setFaceNote('Mencari kamera wajah streamer…');
    try {
      const { findFaceBox } = await import('@/lib/face');
      const fb = await findFaceBox(videoUrl, m.duration);
      if (!fb) {
        setFaceNote('Wajah tidak terdeteksi otomatis. Geser kotak kuning ke kamera streamer, atau centang "tanpa facecam".');
        return;
      }
      const aspect = OUT_W / splitHeights(layoutRef.current.topRatio).top;
      let w = clamp(fb.w * 2.8, 0.12, Math.min(1, (aspect * m.h) / m.w));
      const hN = (w * m.w) / aspect / m.h;
      const cx = fb.x + fb.w / 2;
      const cy = fb.y + fb.h / 2;
      setFace({ w, x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - hN * 0.45, 0, 1 - hN) });
      setFaceNote('Kamera wajah terdeteksi. Geser/atur kotak kuning kalau kurang pas.');
    } catch (err) {
      console.warn(err);
      setFaceNote('Deteksi wajah tidak jalan di browser ini. Geser kotak kuning ke kamera streamer.');
    }
  }

  // keep boxes valid when the split ratio changes
  useEffect(() => {
    if (!meta) return;
    setFace((b) => fitBox(b, faceAspect));
    setGameBox((b) => fitBox(b, gameAspect));
    save('gameclip-top', topRatio);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topRatio, noCam, meta]);

  function startDrag(which, e) {
    e.preventDefault();
    const rect = stageRef.current.getBoundingClientRect();
    const b0 = which === 'face' ? face : gameBox;
    const aspect = which === 'face' ? faceAspect : gameAspect;
    const sx = e.clientX;
    const sy = e.clientY;
    const move = (ev) => {
      const nb = fitBox({ ...b0, x: b0.x + (ev.clientX - sx) / rect.width, y: b0.y + (ev.clientY - sy) / rect.height }, aspect);
      which === 'face' ? setFace(nb) : setGameBox(nb);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function boxStyle(b, aspect) {
    if (!meta) return {};
    const p = boxPixels(b, aspect, meta.w, meta.h);
    return {
      left: `${(p.x / meta.w) * 100}%`,
      top: `${(p.y / meta.h) * 100}%`,
      width: `${(p.w / meta.w) * 100}%`,
      height: `${(p.h / meta.h) * 100}%`,
    };
  }

  // live 9:16 preview drawn from the player
  useEffect(() => {
    if (!videoUrl) return;
    let raf;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const cv = canvasRef.current;
      const v = playerRef.current;
      const L = layoutRef.current;
      if (!cv || !v || !L.meta || v.readyState < 2) return;
      const ctx = cv.getContext('2d');
      const k = PREVIEW_W / OUT_W;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, PREVIEW_W, PREVIEW_H);
      const { top: t, bottom: btm } = splitHeights(L.topRatio);
      let capY;
      if (L.noCam) {
        const bh = splitHeights(0.4).bottom;
        const g = boxPixels(L.gameBox, OUT_W / bh, L.meta.w, L.meta.h);
        ctx.filter = 'blur(6px) brightness(0.8)';
        ctx.drawImage(v, 0, 0, PREVIEW_W, PREVIEW_H);
        ctx.filter = 'none';
        const y = ((OUT_H - bh) / 2) * k;
        ctx.drawImage(v, g.x, g.y, g.w, g.h, 0, y, PREVIEW_W, bh * k);
        capY = (OUT_H * 0.83) * k;
      } else {
        const f = boxPixels(L.face, OUT_W / t, L.meta.w, L.meta.h);
        const g = boxPixels(L.gameBox, OUT_W / btm, L.meta.w, L.meta.h);
        ctx.drawImage(v, f.x, f.y, f.w, f.h, 0, 0, PREVIEW_W, t * k);
        ctx.drawImage(v, g.x, g.y, g.w, g.h, 0, t * k, PREVIEW_W, btm * k);
        capY = t * k;
      }
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if (L.captions) {
        ctx.font = 'bold 15px Poppins, sans-serif';
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#000';
        ctx.strokeText('CONTOH SUBTITLE', PREVIEW_W / 2, capY);
        ctx.fillStyle = '#fff';
        ctx.fillText('CONTOH SUBTITLE', PREVIEW_W / 2, capY);
      }
      if (L.watermark) {
        ctx.font = 'bold 7px Poppins, sans-serif';
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.fillText(L.watermark, PREVIEW_W / 2, PREVIEW_H - 12);
      }
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [videoUrl]);

  // ---------- find moments ----------
  async function start() {
    if (!file || !meta) return;
    setError('');
    setStage('working');
    setClips([]);
    try {
      setStatus('Mengecek password…');
      await api('/api/auth', { method: 'POST' });

      const key = `${file.name}|${file.size}|${language}`;
      let d = data && dataKeyRef.current === key ? data : null;
      if (!d) {
        const { getFFmpeg, extractAudioChunks, setPreferMultiThread } = await import('@/lib/ffmpeg');
        setStatus('Memuat mesin video (±30 MB, hanya sekali)…');
        setProgress(0);
        setPreferMultiThread(true);
        await getFFmpeg();

        setStatus('Mengambil audio dari video…');
        const chunks = await extractAudioChunks(file, meta.duration, CHUNK_SEC, setProgress);

        setStatus('Mencari momen paling heboh dari suara (teriakan, ledakan)…');
        setProgress(0);
        const { loudPeaks } = await import('@/lib/loudness');
        const peaks = await loudPeaks(chunks, setProgress);

        const segments = [];
        const words = [];
        let done = 0;
        const results = new Array(chunks.length);
        let next = 0;
        setStatus(`Membuat transkrip (0/${chunks.length})…`);
        setProgress(0);
        const hint = file.name.replace(/\.[^.]+$/, '').replace(/\[[^\]]*\]/g, '').replace(/[_-]+/g, ' ').trim();
        async function worker() {
          while (next < chunks.length) {
            const i = next++;
            const fd = new FormData();
            fd.append('file', chunks[i].blob, `chunk_${i}.mp3`);
            fd.append('language', language);
            fd.append('prompt', hint);
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
        if (!segments.length && !peaks.length) throw new Error('Tidak ada suara streamer atau momen heboh yang terdeteksi di video ini.');
        d = { segments, words, peaks };
        setData(d);
        dataKeyRef.current = key;
      }

      setStatus('AI sedang memilih momen paling berpotensi viral…');
      setProgress(0);
      const { clips: raw } = await api('/api/highlights', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          mode: 'gaming',
          segments: d.segments,
          peaks: d.peaks,
          duration: meta.duration,
          count,
          minDur,
          maxDur,
          language: language === 'en' ? 'en' : 'id',
          notes,
          game,
        }),
      });
      const picked = fitClips(raw, d.segments, { minDur, maxDur, duration: meta.duration }).map((c) => ({
        ...c,
        state: 'idle',
        progress: 0,
      }));
      if (!picked.length) throw new Error('AI tidak menemukan momen yang cocok. Coba ubah durasi atau catatan.');
      setClips(picked);
      setStage('ready');
      setStatus('');
    } catch (e) {
      console.error(e);
      setError(String(e.message || e));
      setStage(data ? 'ready' : 'idle');
    }
  }

  function updateClip(id, patch) {
    setClips((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }

  function preview(c) {
    const p = playerRef.current;
    if (!p) return;
    stopAtRef.current = c.end;
    p.currentTime = c.start;
    p.play();
    stageRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function onTimeUpdate() {
    const p = playerRef.current;
    if (p && stopAtRef.current != null && p.currentTime >= stopAtRef.current) {
      p.pause();
      stopAtRef.current = null;
    }
  }

  // ---------- render ----------
  async function render(id) {
    const c = clipsRef.current.find((x) => x.id === id);
    if (!c || !data) return;
    const L = layoutRef.current;
    const { renderClip, setPreferMultiThread, getFFmpeg } = await import('@/lib/ffmpeg');
    updateClip(id, { state: 'rendering', progress: 0, error: null });
    try {
      setPreferMultiThread(false); // multi-thread rendering can hang in some browsers
      await getFFmpeg();
      const { top: t } = splitHeights(L.topRatio);
      const ass =
        L.captions || L.watermark
          ? buildAss(L.captions ? data.words : [], c.start, c.end, {
              posY: L.noCam ? OUT_H * 0.83 : t,
              fontSize: 58,
              watermark: L.watermark,
            })
          : null;
      const blob = await renderClip(
        file,
        {
          start: c.start,
          end: c.end,
          ass,
          makeFilter: (subs) =>
            gameFilter({ srcW: L.meta.w, srcH: L.meta.h, face: L.face, game: L.gameBox, topRatio: L.topRatio, noCam: L.noCam, subs }),
        },
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
    for (const c of clipsRef.current) if (c.state !== 'done') await render(c.id);
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

  const videoId = (/\[([\w-]{11})\]/.exec(file?.name || '') || [])[1] || '';
  const busy = stage === 'working';
  // any layout change makes finished renders outdated
  const layoutKey = JSON.stringify([face, gameBox, topRatio, noCam, watermark, captions]);
  const lastLayout = useRef(layoutKey);
  useEffect(() => {
    if (lastLayout.current !== layoutKey) {
      lastLayout.current = layoutKey;
      setClips((cs) => cs.map((c) => (c.state === 'done' ? { ...c, state: 'idle' } : c)));
    }
  }, [layoutKey]);

  return (
    <main className="wrap">
      <header className="top">
        <nav className="tabs">
          <a href="/">Podcast / umum</a>
          <a href="/gaming" className="on">
            Gaming
          </a>
        </nav>
        <h1>
          AutoClip Gaming <span className="tag">beta</span>
        </h1>
        <p className="sub">Video gaming horizontal → klip portrait: wajah streamer di atas, gameplay di bawah.</p>
      </header>

      {needPassword && (
        <div className="card warn">
          <label>
            Password aplikasi
            <input
              type="password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                try {
                  localStorage.setItem('autoclip-pass', e.target.value);
                } catch {}
              }}
            />
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
              {(file.size / 1e6).toFixed(0)} MB{meta && ` · ${fmtTime(meta.duration)} · ${meta.w}×${meta.h}`}
            </span>
          ) : (
            <span>
              <b>Pilih video gaming</b> (MP4 horizontal)
              <br />
              Video diproses di komputer Anda, tidak di-upload ke server.
            </span>
          )}
        </label>

        {videoUrl && (
          <div className="layout">
            <div>
              <div
                className="stage"
                ref={stageRef}
                style={meta ? { aspectRatio: `${meta.w} / ${meta.h}` } : undefined}
              >
                <video
                  ref={playerRef}
                  src={videoUrl}
                  controls
                  onLoadedMetadata={onMeta}
                  onTimeUpdate={onTimeUpdate}
                  onError={() => setError('Browser tidak bisa membaca video ini. Ubah dulu ke MP4 (H.264).')}
                />
                {meta && !noCam && (
                  <div className="box face" style={boxStyle(face, faceAspect)} onPointerDown={(e) => startDrag('face', e)}>
                    <span>Wajah</span>
                  </div>
                )}
                {meta && (
                  <div className="box game" style={boxStyle(gameBox, gameAspect)} onPointerDown={(e) => startDrag('game', e)}>
                    <span>Game</span>
                  </div>
                )}
              </div>
              {faceNote && !noCam && <p className="hint">{faceNote}</p>}
            </div>
            <div className="preview9">
              <canvas ref={canvasRef} width={PREVIEW_W} height={PREVIEW_H} />
              <div className="muted">Pratinjau 9:16</div>
            </div>
          </div>
        )}

        {meta && (
          <div className="controls">
            {!noCam && (
              <label>
                Ukuran kotak wajah
                <input
                  type="range"
                  min={0.08}
                  max={maxW(faceAspect)}
                  step={0.005}
                  value={face.w}
                  onChange={(e) => setFace((b) => fitBox({ ...b, w: +e.target.value }, faceAspect))}
                />
              </label>
            )}
            <label>
              Ukuran kotak game
              <input
                type="range"
                min={0.15}
                max={maxW(gameAspect)}
                step={0.005}
                value={gameBox.w}
                onChange={(e) => setGameBox((b) => fitBox({ ...b, w: +e.target.value }, gameAspect))}
              />
            </label>
            {!noCam && (
              <label>
                Tinggi bagian wajah ({Math.round(topRatio * 100)}%)
                <input type="range" min={0.25} max={0.5} step={0.01} value={topRatio} onChange={(e) => setTopRatio(+e.target.value)} />
              </label>
            )}
            {!noCam && (
              <div className="wide presets">
                <span className="muted">Posisi kamera:</span>
                {['kiri atas', 'kanan atas', 'kiri bawah', 'kanan bawah'].map((p) => (
                  <button key={p} className="ghost small" onClick={() => cornerFace(p)}>
                    {p}
                  </button>
                ))}
                <button className="ghost small" onClick={() => setGameBox(centerGame())}>
                  game ke tengah
                </button>
              </div>
            )}
            <label className="check">
              <input type="checkbox" checked={noCam} onChange={(e) => setNoCam(e.target.checked)} />
              Video tanpa facecam
            </label>
            <label className="check">
              <input type="checkbox" checked={captions} onChange={(e) => setCaptions(e.target.checked)} />
              Subtitle otomatis
            </label>
            <label className="wide">
              Watermark (kecil & samar di bawah, kosongkan jika tidak perlu)
              <input
                type="text"
                placeholder="mis. @namaakun"
                value={watermark}
                maxLength={40}
                onChange={(e) => {
                  setWatermark(e.target.value);
                  save('gameclip-wm', e.target.value);
                }}
              />
            </label>
          </div>
        )}

        <div className="grid">
          <label>
            Bahasa streamer
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
            Nama game (opsional)
            <input type="text" placeholder="mis. Mobile Legends" value={game} onChange={(e) => setGame(e.target.value)} disabled={busy} />
          </label>
        </div>
        <label>
          Catatan untuk AI (opsional)
          <input
            type="text"
            placeholder="mis. fokus momen savage / momen lucu / clutch"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            disabled={busy}
          />
        </label>

        <div className="row">
          <button className="primary" onClick={start} disabled={!file || !meta || busy || rendering}>
            {clips.length ? 'Cari ulang momen' : 'Cari momen viral'}
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
            <h2>{clips.length} momen ditemukan</h2>
            <button className="primary" onClick={renderAll} disabled={rendering || busy}>
              Render semua
            </button>
          </div>
          <p className="hint">Render berjalan di browser (gratis). Semua klip memakai tata letak di atas. Jangan tutup tab ini.</p>

          {clips.map((c, i) => (
            <article key={c.id} className="card clip">
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
                  <input type="number" step="0.1" value={c.start} onChange={(e) => updateClip(c.id, { start: +e.target.value, state: 'idle' })} />
                </label>
                <label>
                  Selesai (detik)
                  <input type="number" step="0.1" value={c.end} onChange={(e) => updateClip(c.id, { end: +e.target.value, state: 'idle' })} />
                </label>
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
                    {c.outUrl ? 'Render ulang' : 'Render klip ini'}
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

      <footer className="foot">Transkrip: Whisper (Groq) · Momen: Gemini + deteksi suara heboh · Render: ffmpeg.wasm di browser</footer>
    </main>
  );
}
