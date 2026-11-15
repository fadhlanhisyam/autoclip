import { checkPassword } from '@/lib/auth';
import { buildPrompt, parseClips } from '@/lib/highlights';

export const runtime = 'nodejs';
export const maxDuration = 300;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RETRY = new Set([429, 500, 502, 503, 504]);

// Free option (default): Google Gemini API free tier. Tries several models and
// retries when Google is overloaded (503) or rate-limited (429).
async function askGemini(prompt) {
  const models = [
    process.env.GEMINI_MODEL,
    'gemini-flash-latest',
    'gemini-flash-lite-latest',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
  ].filter((m, i, a) => m && a.indexOf(m) === i);

  let lastErr = '';
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.4, responseMimeType: 'application/json' },
        }),
      });
      if (res.ok) {
        const data = await res.json();
        const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
        if (text) return text;
        lastErr = `${model}: respons kosong`;
        break;
      }
      lastErr = `${model} ${res.status}: ${(await res.text()).slice(0, 200)}`;
      if (res.status === 404) break; // model not available, try next one
      if (!RETRY.has(res.status)) throw new Error(`Gemini error ${lastErr}`);
      await sleep(3000 * (attempt + 1));
    }
  }
  throw new Error(`Gemini sedang sibuk/tidak tersedia. ${lastErr}`);
}

// Free fallback: Groq LLM. Picks a currently available model automatically,
// because Groq retires models often.
async function pickGroqModel() {
  if (process.env.GROQ_LLM_MODEL) return process.env.GROQ_LLM_MODEL;
  const res = await fetch('https://api.groq.com/openai/v1/models', {
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
  });
  if (!res.ok) throw new Error(`Groq models error ${res.status}`);
  const ids = ((await res.json()).data || [])
    .filter((m) => m.active !== false)
    .map((m) => m.id)
    .filter((id) => !/whisper|guard|tts|playai|orpheus|distil|compound/i.test(id));
  const prefer = ['gpt-oss-120b', 'llama-4-maverick', 'kimi-k2', 'qwen3', 'llama-4-scout', 'gpt-oss-20b', 'llama'];
  for (const p of prefer) {
    const hit = ids.find((id) => id.includes(p));
    if (hit) return hit;
  }
  if (!ids.length) throw new Error('Tidak ada model Groq yang tersedia');
  return ids[0];
}

async function askGroq(prompt) {
  const model = await pickGroqModel();
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: JSON.stringify({
      model,
      temperature: 0.4,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    if (res.status === 413 || res.status === 429) {
      throw new Error(`Transkrip terlalu panjang untuk batas gratis Groq (${model}).`);
    }
    throw new Error(`Groq LLM error ${res.status} (${model}): ${t.slice(0, 300)}`);
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
  return Response.json({ error: errors.join('\n\n') }, { status: 502 });
}
