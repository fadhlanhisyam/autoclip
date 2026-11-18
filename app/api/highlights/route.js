import { checkPassword } from '@/lib/auth';
import { buildPrompt, buildGamingPrompt, parseClips } from '@/lib/highlights';

export const runtime = 'nodejs';
export const maxDuration = 300;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RETRY = new Set([429, 500, 502, 503, 504]);
const BUDGET_MS = 250000; // stay under maxDuration (300 s) so we can always answer
let deadline = 0;
const timeLeft = () => deadline - Date.now();

async function fetchT(url, opts, ms) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.max(1000, ms));
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Free option (default): Google Gemini API free tier. Tries several models,
// with a per-request timeout, and gives up early enough to try Groq.
async function askGemini(prompt) {
  const models = [
    process.env.GEMINI_MODEL,
    'gemini-flash-latest',
    'gemini-2.5-flash',
    'gemini-flash-lite-latest',
    'gemini-2.5-flash-lite',
  ].filter((m, i, a) => m && a.indexOf(m) === i);

  const errs = [];
  for (const model of models) {
    if (timeLeft() < 70000) break; // keep time for the Groq fallback
    try {
      const res = await fetchT(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.4, responseMimeType: 'application/json' },
          }),
        },
        Math.min(100000, timeLeft() - 60000),
      );
      if (res.ok) {
        const data = await res.json();
        const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
        if (text) return text;
        errs.push(`${model}: respons kosong`);
        continue;
      }
      errs.push(`${model} ${res.status}`);
      if (!RETRY.has(res.status) && res.status !== 404) {
        throw new Error(`Gemini error ${model} ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      await sleep(1500);
    } catch (e) {
      if (e.name === 'AbortError') errs.push(`${model}: timeout`);
      else throw e;
    }
  }
  throw new Error(`Gemini sedang sibuk (${errs.join(', ') || 'tidak sempat dicoba'})`);
}

// Free fallback: Groq LLM. Picks a currently available model automatically,
// because Groq retires models often.
async function pickGroqModel(promptChars) {
  if (process.env.GROQ_LLM_MODEL) return process.env.GROQ_LLM_MODEL;
  const res = await fetch('https://api.groq.com/openai/v1/models', {
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
  });
  if (!res.ok) throw new Error(`Groq models error ${res.status}`);
  const ids = ((await res.json()).data || [])
    .filter((m) => m.active !== false)
    .map((m) => m.id)
    .filter((id) => !/whisper|guard|tts|playai|orpheus|distil|compound/i.test(id));
  // long transcripts need a model with a high free-tier tokens-per-minute limit
  const big = promptChars / 3.5 > 7000;
  const prefer = big
    ? ['llama-4-scout', 'llama-4-maverick', 'gpt-oss-120b', 'kimi-k2', 'qwen3', 'llama']
    : ['gpt-oss-120b', 'llama-4-maverick', 'kimi-k2', 'qwen3', 'llama-4-scout', 'gpt-oss-20b', 'llama'];
  for (const p of prefer) {
    const hit = ids.find((id) => id.includes(p));
    if (hit) return hit;
  }
  if (!ids.length) throw new Error('Tidak ada model Groq yang tersedia');
  return ids[0];
}

async function askGroq(prompt) {
  const model = await pickGroqModel(prompt.length);
  const res = await fetchT('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: JSON.stringify({
      model,
      temperature: 0.4,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }],
    }),
  }, Math.max(5000, timeLeft() - 5000));
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
  deadline = Date.now() + BUDGET_MS;

  const body = await req.json();
  const segments = Array.isArray(body.segments) ? body.segments : [];
  const gaming = body.mode === 'gaming';
  const peaks = gaming && Array.isArray(body.peaks) ? body.peaks.slice(0, 60).filter((p) => Number.isFinite(p?.t) && Number.isFinite(p?.db)).map((p) => ({ t: p.t, db: p.db, speech: p.speech === undefined ? undefined : String(p.speech).slice(0, 120) })) : [];
  if (!segments.length && !peaks.length) return Response.json({ error: 'Transkrip kosong' }, { status: 400 });

  const common = {
    segments,
    count: Math.min(15, Math.max(1, Number(body.count) || 6)),
    minDur: Number(body.minDur) || 20,
    maxDur: Number(body.maxDur) || 60,
    language: body.language || 'id',
    notes: String(body.notes || '').slice(0, 800),
  };
  const prompt = gaming
    ? buildGamingPrompt({ ...common, peaks, duration: Number(body.duration) || 0, game: String(body.game || '').slice(0, 60) })
    : buildPrompt({ ...common, productMode: body.productMode === true, niche: String(body.niche || '').slice(0, 100) });

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
