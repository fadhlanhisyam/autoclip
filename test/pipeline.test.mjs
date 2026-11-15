// Runs the same ffmpeg commands the browser uses, with native ffmpeg.
// Usage: node test/pipeline.test.mjs
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { audioExtractArgs, audioChunkArgs, videoFilter, renderArgs } from '../lib/commands.js';
import { buildAss, groupWords } from '../lib/captions.js';
import { parseClips, snapClips, buildPrompt } from '../lib/highlights.js';

const dir = '/tmp/autoclip-test';
mkdirSync(dir, { recursive: true });
process.chdir(dir);
const fonts = path.resolve(new URL('../public/fonts', import.meta.url).pathname);
const ff = (args) => execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args]);
const probe = (f) =>
  JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', f]).toString());
const assert = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('ok -', m); };

// 1. a 16:9 test video (90 s) with a moving bright box as "face"
ff(['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=90',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=90',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', 'input.mp4']);

// 2. audio extraction + chunking
ff(audioExtractArgs('input.mp4', 'audio.mp3'));
const a = probe('audio.mp3');
assert(a.streams[0].sample_rate === '16000' && a.streams[0].channels === 1, 'audio is mono 16 kHz');
let total = 0;
for (let s = 0, i = 0; s < 90; s += 40, i++) {
  ff(audioChunkArgs('audio.mp3', s, 40, `chunk_${i}.mp3`));
  const d = +probe(`chunk_${i}.mp3`).format.duration;
  total += d;
  assert(statSync(`chunk_${i}.mp3`).size < 4.5e6, `chunk ${i} < 4.5 MB (${d.toFixed(1)} s)`);
}
assert(Math.abs(total - 90) < 1, `chunks cover the whole audio (${total.toFixed(1)} s)`);

// 3. highlight parsing + snapping
const segments = Array.from({ length: 30 }, (_, i) => ({ start: i * 3, end: i * 3 + 2.8, text: `kalimat ${i}` }));
const reply = '```json\n{"clips":[{"start":10.1,"end":40.4,"title":"Momen A","hook":"h","reason":"r","score":91},{"start":20,"end":35,"title":"overlap","score":50},{"start":60.2,"end":61,"title":"Pendek","score":70}]}\n```';
const clips = snapClips(parseClips(reply), segments, { minDur: 20, maxDur: 60, duration: 90 });
console.log(clips);
assert(clips.length === 2, 'overlapping clip removed');
assert(clips[0].start <= 9.0 && clips[0].end >= 38.8, 'snapped to segment boundaries');
assert(clips[1].end - clips[1].start >= 20, 'too-short clip extended to min duration');
assert(buildPrompt({ segments, count: 3, minDur: 20, maxDur: 60, language: 'id' }).includes('[3.0-5.8] kalimat 1'), 'prompt has timestamps');

// 4. captions
const words = [];
const said = 'ini adalah rahasia yang jarang orang tahu, padahal gampang banget dilakukan! coba deh sekarang juga';
said.split(' ').forEach((w, i) => words.push({ word: w, start: 10 + i * 0.45, end: 10 + i * 0.45 + 0.4 }));
assert(groupWords(words.map(w => ({...w}))).every((g) => g.length <= 3), 'caption groups max 3 words');
const ass = buildAss(words, 10, 25, { title: 'Rahasia yang jarang orang tahu' });
writeFileSync('subs.ass', ass);
assert(ass.includes('RAHASIA') && ass.includes('\\c&H0000FFFF&'), 'ASS has highlighted uppercase words');

// 5. render: crop mode with captions, and blur mode
for (const layout of ['crop', 'blur']) {
  const filter = videoFilter({ srcW: 1920, srcH: 1080, centerX: 0.3, layout, subs: 'subs.ass', fontsDir: fonts });
  const out = `out_${layout}.mp4`;
  const t0 = Date.now();
  ff(renderArgs({ input: 'input.mp4', output: out, start: 10, duration: 15, filter }));
  const p = probe(out);
  const v = p.streams.find((s) => s.codec_type === 'video');
  assert(v.width === 720 && v.height === 1280, `${layout}: output is 720x1280`);
  assert(Math.abs(+p.format.duration - 15) < 0.5, `${layout}: duration ~15 s (${(+p.format.duration).toFixed(2)})`);
  assert(p.streams.some((s) => s.codec_type === 'audio'), `${layout}: has audio`);
  ff(['-ss', '1.2', '-i', out, '-frames:v', '1', `frame_${layout}.png`]);
  console.log(`   rendered in ${((Date.now() - t0) / 1000).toFixed(1)} s (native)`);
}

// 6. already-vertical source falls back to the blur/fit layout
const vf = videoFilter({ srcW: 1080, srcH: 1920, centerX: 0.5, layout: 'crop' });
assert(vf.complex, 'vertical source uses fit layout');
console.log('\nALL TESTS PASSED');
