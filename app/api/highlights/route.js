import { checkPassword } from '@/lib/auth';
import { buildPrompt, parseClips } from '@/lib/highlights';

export const runtime = 'nodejs';
export const maxDuration = 300;

// Free option (default): Google Gemini API free tier — large context, handles long transcripts.
async function askGemini(prompt) {
  const model = process.env.GEMINI_MODEL || 'gemini-flash-latest';
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': process.env.GEMINI_API_KEY,
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.4, responseMimeType: 'application/json' },
    }),
  });
  if (!res.ok) throw new Error(`Gemini error ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const data = await res.json();
  return (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
}

// Free fallback: Groq LLM (free tier has a small tokens-per-minute limit, fine for videos up to ~30-40 min).
async function askGroq(prompt) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: process.env.GROQ_LLM_MODEL || 'llama-3.3-70b-versatile',
      temperature: 0.4,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    if (res.status === 413 || res.status === 429) {
      throw new Error('Transkrip terlalu panjang untuk batas gratis Groq. Isi GEMINI_API_KEY (gratis) supaya video panjang bisa diproses.');
    }
    throw new Error(`Groq LLM error ${res.status}: ${t.slice(0, 400)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

// Optional paid option: Claude API (only used if you add ANTHROPIC_API_KEY yourself).
async function askClaude(prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Claude error ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const data = await res.json();
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
}

export async function POST(req) {
  const denied = checkPassword(req);
  if (denied) return denied;

  const body = await req.json();
  const segments = Array.isArray(body.segments) ? body.segments : [];
  if (!segments.length) return Response.json({ error: 'Transkrip kosong' }, { status: 400 });

  const prompt = buildPrompt({
    segments,
    count: Math.min(15, Math.max(1, Number(body.count) || 6)),
    minDur: Number(body.minDur) || 20,
    maxDur: Number(body.maxDur) || 60,
    language: body.language || 'id',
    notes: String(body.notes || '').slice(0, 500),
  });

  const providers = [];
  if (process.env.ANTHROPIC_API_KEY) providers.push(['claude', askClaude]);
  if (process.env.GEMINI_API_KEY) providers.push(['gemini', askGemini]);
  if (process.env.GROQ_API_KEY) providers.push(['groq', askGroq]);
  if (!providers.length) {
    return Response.json({ error: 'Isi GEMINI_API_KEY (gratis) di Environment Variables Vercel.' }, { status: 500 });
  }

  const errors = [];
  for (const [name, ask] of providers) {
    try {
      const clips = parseClips(await ask(prompt));
      return Response.json({ clips, provider: name });
    } catch (err) {
      errors.push(`${name}: ${err.message || err}`);
    }
  }
  return Response.json({ error: errors.join('\n') }, { status: 502 });
}
