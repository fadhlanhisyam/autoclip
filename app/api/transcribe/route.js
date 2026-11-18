import { checkPassword } from '@/lib/auth';

export const runtime = 'nodejs';
export const maxDuration = 120;

// Receives one small audio chunk (< 4 MB) from the browser and forwards it to
// Whisper on Groq. Returns segments + word timestamps relative to the chunk.
export async function POST(req) {
  const denied = checkPassword(req);
  if (denied) return denied;

  const key = process.env.GROQ_API_KEY;
  if (!key) {
    return Response.json({ error: 'GROQ_API_KEY belum diisi di Environment Variables Vercel.' }, { status: 500 });
  }

  const form = await req.formData();
  const file = form.get('file');
  const language = form.get('language');
  const hint = String(form.get('prompt') || '').slice(0, 400);
  if (!file) return Response.json({ error: 'File audio tidak ada' }, { status: 400 });

  const out = new FormData();
  out.append('file', file, 'chunk.mp3');
  // turbo: tested better than large-v3 on multi-speaker podcasts (large-v3 skipped
  // speech and hallucinated repeated lines). Prompt hints are opt-in only, because
  // they can also make Whisper skip speech.
  out.append('model', process.env.GROQ_WHISPER_MODEL || 'whisper-large-v3-turbo');
  if (hint && process.env.WHISPER_USE_PROMPT === '1') out.append('prompt', hint);
  out.append('response_format', 'verbose_json');
  out.append('timestamp_granularities[]', 'word');
  out.append('timestamp_granularities[]', 'segment');
  out.append('temperature', '0');
  if (language && language !== 'auto') out.append('language', String(language));

  let res;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: out,
    });
    if (res.status !== 429 && res.status < 500) break;
    if (res.status === 429) break; // free-tier audio quota: retrying in seconds won't help
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
  }

  if (!res.ok) {
    const text = await res.text();
    if (res.status === 429) {
      // tell the caller how long to wait (free tier: ~2 h of audio per hour, 8 h per day)
      const m = /try again in\s+(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:([\d.]+)s)?/i.exec(text);
      let retryAfter = Number(res.headers.get('retry-after')) || 0;
      if (m && (m[1] || m[2] || m[3])) retryAfter = (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + Math.ceil(+m[3] || 0);
      const daily = /per day|\(ASD\)/i.test(text);
      return Response.json(
        {
          error: `Batas gratis transkrip Groq tercapai${daily ? ' (kuota harian)' : ''}. Coba lagi dalam ${Math.ceil((retryAfter || 600) / 60)} menit.`,
          retryAfter: retryAfter || 600,
          daily,
        },
        { status: 429 },
      );
    }
    return Response.json({ error: `Groq error ${res.status}: ${text.slice(0, 400)}` }, { status: 502 });
  }

  const data = await res.json();
  const segments = (data.segments || []).map((s) => ({
    start: s.start,
    end: s.end,
    text: (s.text || '').trim(),
  })).filter((s) => s.text);
  const words = (data.words || []).map((w) => ({
    start: w.start,
    end: w.end,
    word: (w.word || '').trim(),
  })).filter((w) => w.word);

  return Response.json({ segments, words, language: data.language || null });
}
