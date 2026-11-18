// Pure builders for ffmpeg arguments. Used by ffmpeg.wasm in the browser and
// by the local test script with native ffmpeg, so both run the same commands.

export const OUT_W = 720;
export const OUT_H = 1280;

const even = (n) => Math.max(2, Math.floor(n / 2) * 2);

export function audioExtractArgs(input, output) {
  // mono 16 kHz 32 kbps mp3: ~14 MB per hour, plenty for speech recognition
  return ['-i', input, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '32k', output];
}

export function audioChunkArgs(input, start, len, output) {
  return ['-ss', String(start), '-t', String(len), '-i', input, '-c', 'copy', output];
}

// layout: 'crop' (follow the face/center, fills the screen) or 'blur' (whole frame + blurred background)
export function videoFilter({ srcW, srcH, centerX = 0.5, layout = 'crop', subs = null, fontsDir = '/fonts' }) {
  const subFilter = subs ? `,ass=${subs}:fontsdir=${fontsDir}` : '';
  const srcRatio = srcW / srcH;
  const outRatio = OUT_W / OUT_H;

  if (layout === 'blur' || srcRatio <= outRatio) {
    // video already vertical, or user wants the whole frame visible
    return {
      complex: true,
      filter:
        `[0:v]split[a][b];` +
        `[a]scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase,crop=${OUT_W}:${OUT_H},boxblur=20:2,eq=brightness=-0.08[bg];` +
        `[b]scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=decrease[fg];` +
        `[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1${subFilter}[v]`,
    };
  }

  const cw = even(srcH * outRatio);
  const ch = even(srcH);
  let x = Math.round(centerX * srcW - cw / 2);
  x = Math.max(0, Math.min(srcW - cw, x));
  return {
    complex: false,
    filter: `crop=${cw}:${ch}:${x}:0,scale=${OUT_W}:${OUT_H},setsar=1${subFilter}`,
  };
}

export function renderArgs({ input, output, start, duration, filter, preset = 'ultrafast', crf = 23 }) {
  const args = ['-ss', start.toFixed(2), '-i', input, '-t', duration.toFixed(2)];
  if (filter.complex) args.push('-filter_complex', filter.filter, '-map', '[v]', '-map', '0:a?');
  else args.push('-vf', filter.filter);
  args.push(
    '-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-pix_fmt', 'yuv420p',
    '-r', '30',
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
    '-movflags', '+faststart',
    output,
  );
  return args;
}

// ---------- gaming: split screen (facecam on top, gameplay below) ----------
// Boxes are normalized to the source frame: x, y = top-left, w = width (0..1).
// Their height follows from the output panel's aspect ratio.
export function splitHeights(topRatio = 0.4) {
  const top = even(OUT_H * Math.min(0.6, Math.max(0.2, topRatio)));
  return { top, bottom: OUT_H - top };
}

export function boxPixels(box, aspect, srcW, srcH) {
  let w = box.w * srcW;
  let h = w / aspect;
  if (h > srcH) {
    h = srcH;
    w = h * aspect;
  }
  w = even(Math.min(w, srcW));
  h = even(Math.min(h, srcH));
  const x = Math.round(Math.max(0, Math.min(srcW - w, box.x * srcW)));
  const y = Math.round(Math.max(0, Math.min(srcH - h, box.y * srcH)));
  return { w, h, x, y };
}

export function gameFilter({ srcW, srcH, face, game, topRatio = 0.4, noCam = false, subs = null, fontsDir = '/fonts' }) {
  const subFilter = subs ? `,ass=${subs}:fontsdir=${fontsDir}` : '';
  if (noCam) {
    // no facecam: gameplay fills the bottom 2/3, blurred copy of the game behind it
    const g = boxPixels(game, OUT_W / splitHeights(0.4).bottom, srcW, srcH);
    return {
      complex: true,
      filter:
        `[0:v]split[a][b];` +
        `[a]scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase,crop=${OUT_W}:${OUT_H},boxblur=20:2,eq=brightness=-0.1[bg];` +
        `[b]crop=${g.w}:${g.h}:${g.x}:${g.y},scale=${OUT_W}:-2[fg];` +
        `[bg][fg]overlay=0:(H-h)/2,setsar=1${subFilter}[v]`,
    };
  }
  const { top, bottom } = splitHeights(topRatio);
  const f = boxPixels(face, OUT_W / top, srcW, srcH);
  const g = boxPixels(game, OUT_W / bottom, srcW, srcH);
  return {
    complex: true,
    filter:
      `[0:v]split[a][b];` +
      `[a]crop=${f.w}:${f.h}:${f.x}:${f.y},scale=${OUT_W}:${top},setsar=1[top];` +
      `[b]crop=${g.w}:${g.h}:${g.x}:${g.y},scale=${OUT_W}:${bottom},setsar=1[bot];` +
      `[top][bot]vstack=inputs=2${subFilter}[v]`,
  };
}
