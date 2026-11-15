// Builds an .ass subtitle file with TikTok-style word-by-word highlight captions.
// Times in the output are relative to the clip start.

const W = 720;
const H = 1280;

function assTime(t) {
  t = Math.max(0, t);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const cs = Math.floor((t - Math.floor(t)) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function clean(word) {
  return word.replace(/[{}\\]/g, '').replace(/\s+/g, ' ').trim();
}

// Group words into short on-screen phrases (max N words, break on pauses/punctuation).
export function groupWords(words, maxWords = 3) {
  const groups = [];
  let cur = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const prev = cur[cur.length - 1];
    const pause = prev && w.start - prev.end > 0.6;
    if (cur.length && (cur.length >= maxWords || pause)) {
      groups.push(cur);
      cur = [];
    }
    cur.push(w);
    if (/[.!?,;:]$/.test(w.word)) {
      groups.push(cur);
      cur = [];
    }
  }
  if (cur.length) groups.push(cur);
  return groups;
}

export function buildAss(allWords, clipStart, clipEnd, opts = {}) {
  const {
    fontName = 'Poppins',
    fontSize = 66,
    highlight = '&H0000FFFF', // yellow (ASS is &HAABBGGRR)
    uppercase = true,
    marginV = 360,
    maxWords = 3,
    title = '',
  } = opts;

  const words = allWords
    .filter((w) => w.end > clipStart && w.start < clipEnd)
    .map((w) => ({
      start: Math.max(0, w.start - clipStart),
      end: Math.min(clipEnd - clipStart, w.end - clipStart),
      word: clean(uppercase ? w.word.toUpperCase() : w.word),
    }))
    .filter((w) => w.word);

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,${fontName},${fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,5,2,2,50,50,${marginV},1
Style: Title,${fontName},46,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,3,14,0,8,60,60,150,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const lines = [];
  if (title) {
    const t = clean(title);
    lines.push(`Dialogue: 1,${assTime(0)},${assTime(Math.min(4, clipEnd - clipStart))},Title,,0,0,0,,${t}`);
  }

  for (const g of groupWords(words, maxWords)) {
    for (let i = 0; i < g.length; i++) {
      const start = g[i].start;
      // keep the phrase on screen until the next word (or a short hold after the last one)
      const end = i < g.length - 1 ? g[i + 1].start : g[i].end + 0.15;
      if (end - start < 0.02) continue;
      const text = g
        .map((w, j) => (j === i ? `{\\c${highlight}&\\fscx108\\fscy108}${w.word}{\\r}` : w.word))
        .join(' ');
      lines.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Cap,,0,0,0,,${text}`);
    }
  }

  return header + lines.join('\n') + '\n';
}
