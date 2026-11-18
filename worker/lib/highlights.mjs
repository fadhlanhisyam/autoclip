// Shared helpers for picking highlight clips from a transcript.

export function fmtTime(sec) {
  sec = Math.max(0, sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

// Compact transcript: merge short segments into blocks of up to ~15 s so the
// prompt stays small (faster AI, fits free-tier token limits). Each line is
// [start-end seconds] text.
export function transcriptToText(segments, maxBlock = 15) {
  const lines = [];
  let cur = null;
  for (const s of segments) {
    const text = s.text.trim();
    if (!text) continue;
    if (cur && s.end - cur.start <= maxBlock && s.start - cur.end < 1.5) {
      cur.end = s.end;
      cur.text += ' ' + text;
    } else {
      if (cur) lines.push(cur);
      cur = { start: s.start, end: s.end, text };
    }
  }
  if (cur) lines.push(cur);
  return lines.map((l) => `[${l.start.toFixed(1)}-${l.end.toFixed(1)}] ${l.text}`).join('\n');
}

export function buildPrompt({ segments, count, minDur, maxDur, language, notes, productMode = false, niche = '' }) {
  const lang = language === 'en' ? 'English' : 'Bahasa Indonesia (casual, natural, the way Indonesian TikTok creators write)';
  const total = segments.length ? segments[segments.length - 1].end : 0;
  return `You are an expert short-form video editor ("clipper") who turns long videos into viral TikTok / Reels / YouTube Shorts clips.

Below is a timestamped transcript of a ${fmtTime(total)} long video. Each line is [start-end seconds] text.

Pick the ${count} BEST moments to turn into standalone vertical clips.

What makes a great clip:
- A strong HOOK in the first 3 seconds: a bold claim, a question, a surprising fact, conflict, emotion, or a funny line. Never start with filler ("so", "um", "jadi gini", greetings) or mid-sentence.
- Self-contained: a viewer who never saw the full video understands it without extra context.
- A complete arc: setup -> payoff. End right after the punchline / conclusion, not mid-thought.
- High value or high emotion: funny, controversial, a useful insight or tip, a strong story, a heated moment, a quotable line.
- Each clip is between ${minDur} and ${maxDur} seconds long.
- Clips must not overlap. Spread them across the video if quality allows, but quality comes first.
${notes ? `\nExtra instructions from the user: ${notes}\n` : ''}${productMode ? `
STRICT PRODUCT MODE (affiliate content${niche ? `, niche: ${niche}` : ''}):
- ONLY pick moments where a speaker clearly says the NAME of a specific product (brand and/or product name, e.g. "Vaseline Proderma", "Skintific 5X Ceramide") AND explains what it does: its function, benefits, ingredients, how to use it, or who it is for.
- General talk about a topic without a named product does NOT qualify. A brand name mentioned in passing without any explanation does NOT qualify.
- The clip must contain both the product name and its explanation.
- If no moment qualifies, return {"clips":[]}. Never invent a product that is not in the transcript.
- For each clip also return "product": the product name exactly as spoken in the transcript, and "benefit": one short sentence (${lang}) on the function/benefit explained in the clip.
` : ''}
Use the transcript timestamps: "start" must be the start time of the line where the clip begins and "end" the end time of the line where it ends.

Write "title" and "hook" in ${lang}.
- title: short catchy title for the clip (max 8 words), usable as on-screen headline.
- hook: one punchy caption line to post with the clip.
- reason: one short sentence on why this moment will perform.
- score: 0-100 predicted viral potential, be honest and spread the scores.

Respond with ONLY valid JSON, no markdown, in exactly this shape:
{"clips":[{"start":12.3,"end":58.1,"title":"...","hook":"...","reason":"...","score":87${productMode ? ',"product":"...","benefit":"..."' : ''}}]}

TRANSCRIPT:
${transcriptToText(segments)}`;
}

// Pull the JSON object out of a model reply even if it added extra text.
export function parseClips(text) {
  if (!text) throw new Error('Respons AI kosong');
  let raw = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = raw.indexOf('{');
  const b = raw.lastIndexOf('}');
  if (a === -1 || b === -1) throw new Error('AI tidak mengembalikan JSON');
  const obj = JSON.parse(raw.slice(a, b + 1));
  const clips = Array.isArray(obj) ? obj : obj.clips;
  if (!Array.isArray(clips)) throw new Error('Format JSON AI tidak sesuai');
  return clips
    .map((c) => ({
      start: Number(c.start),
      end: Number(c.end),
      title: String(c.title || '').trim(),
      hook: String(c.hook || '').trim(),
      reason: String(c.reason || '').trim(),
      score: Math.max(0, Math.min(100, Math.round(Number(c.score) || 0))),
      product: String(c.product || '').trim(),
      benefit: String(c.benefit || '').trim(),
    }))
    .filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start);
}

// Snap AI timestamps to real segment boundaries, enforce duration limits,
// remove overlaps, and sort by score.
export function snapClips(clips, segments, { minDur, maxDur, duration }) {
  if (!segments.length) return [];
  const starts = segments.map((s) => s.start);
  const ends = segments.map((s) => s.end);
  const nearest = (arr, t) => arr.reduce((best, v) => (Math.abs(v - t) < Math.abs(best - t) ? v : best), arr[0]);

  const out = [];
  for (const c of clips) {
    let start = nearest(starts, c.start);
    let end = nearest(ends.filter((e) => e > start), c.end) ?? c.end;
    if (!Number.isFinite(end)) end = c.end;
    // too long: cut at the last segment end that fits
    if (end - start > maxDur) {
      const fit = ends.filter((e) => e > start && e - start <= maxDur);
      end = fit.length ? fit[fit.length - 1] : start + maxDur;
    }
    // too short: extend to the next segment ends until long enough
    if (end - start < minDur) {
      const longer = ends.find((e) => e - start >= minDur && e - start <= maxDur);
      if (longer) end = longer;
    }
    // small padding so words aren't clipped
    start = Math.max(0, start - 0.15);
    end = Math.min(duration || end + 0.3, end + 0.3);
    if (end - start < 3) continue;
    out.push({ ...c, start: +start.toFixed(2), end: +end.toFixed(2) });
  }

  out.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const c of out) {
    if (kept.some((k) => c.start < k.end && c.end > k.start)) continue;
    kept.push(c);
  }
  return kept.map((c, i) => ({ ...c, id: `clip-${i + 1}` }));
}

// ---------- gaming ----------
// peaks: [{t, db}] loud moments (screams, explosions, hype) found in the audio.
export function buildGamingPrompt({ segments, peaks = [], duration, count, minDur, maxDur, language, notes, game = '' }) {
  const lang = language === 'en' ? 'English' : 'Bahasa Indonesia (casual, gaul, the way Indonesian gaming TikTok creators write)';
  return `You are an expert gaming clipper who turns long gameplay videos / livestreams${game ? ` of ${game}` : ''} into viral TikTok / Reels / YouTube Shorts clips.

The video is ${fmtTime(duration)} long. You get (1) the streamer's speech with timestamps and (2) a list of moments where the STREAMER'S VOICE suddenly gets loud (yelling, screaming, hype), with what they said at that second. Times are in seconds.

Pick the ${count} BEST moments with the highest viral potential. TOP PRIORITY: the streamer's own loud, excited reactions (yelling, screaming, rage, hype, panic, laughing hard) together with what caused them. A loud moment with no streamer speech is probably just game sound: rank it lower. Great gaming clips:
- Strong streamer reactions: screaming, rage, hype, panic, laughing, jumpscares.
- Clutch plays, 1vX, multi-kills, insane aim, last-second wins, comebacks.
- Big fails, funny deaths, bugs/glitches, trolling, unexpected events.
- Funny banter or roasting with teammates or chat.
- The first 2 seconds must already be interesting (action or a strong line). Start a few seconds BEFORE the climax so the viewer gets the setup, end right after the payoff/reaction.
- Each clip is between ${minDur} and ${maxDur} seconds long, clips must not overlap.
- Build the clip around the loud reaction: start a few seconds before it (the cause), end after the reaction calms down.
${notes ? `\nExtra instructions from the user: ${notes}\n` : ''}
Write "title" and "hook" in ${lang}.
- title: short catchy title (max 8 words).
- hook: one punchy caption line to post with the clip.
- reason: one short sentence on what happens in the clip.
- score: 0-100 predicted viral potential, be honest and spread the scores.

Respond with ONLY valid JSON, no markdown, in exactly this shape:
{"clips":[{"start":12.3,"end":58.1,"title":"...","hook":"...","reason":"...","score":87}]}

STREAMER LOUD MOMENTS (time: voice loudness above normal — what the streamer said right then):
${peaks.length ? peaks.map((p) => `${p.t.toFixed(1)}: +${p.db.toFixed(0)} dB — ${p.speech === undefined ? '(not transcribed)' : p.speech ? `"${p.speech}"` : '(no speech, probably game sound)'}`).join('\n') : '(none detected)'}

SPEECH:
${segments.length ? transcriptToText(segments) : '(no speech detected)'}`;
}

// Clean up AI timestamps without a transcript to snap to (gaming videos can be
// mostly game audio): clamp to the video, enforce durations, drop overlaps.
export function fitClips(clips, segments, { minDur, maxDur, duration }) {
  if (segments.length) {
    const snapped = snapClips(clips, segments, { minDur, maxDur, duration });
    if (snapped.length) return snapped;
  }
  const out = [];
  for (const c of clips) {
    let start = Math.max(0, c.start);
    let end = Math.min(duration || c.end, c.end);
    if (end - start > maxDur) end = start + maxDur;
    if (end - start < minDur) end = Math.min(duration || start + minDur, start + minDur);
    if (end - start < minDur && duration) start = Math.max(0, end - minDur);
    if (end - start < 3) continue;
    out.push({ ...c, start: +start.toFixed(2), end: +end.toFixed(2) });
  }
  out.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const c of out) if (!kept.some((k) => c.start < k.end && c.end > k.start)) kept.push(c);
  return kept.map((c, i) => ({ ...c, id: `clip-${i + 1}` }));
}
