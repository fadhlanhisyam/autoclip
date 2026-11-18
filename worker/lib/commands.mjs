// ffmpeg argument builders for the PC worker (native ffmpeg, so we can afford 1080x1920).

const even = (n) => Math.max(2, Math.floor(n / 2) * 2);

export function audioExtractArgs(input, output) {
  return ['-y', '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '32k', output];
}

export function audioChunkArgs(input, start, len, output) {
  return ['-y', '-ss', String(start), '-t', String(len), '-i', input, '-c', 'copy', output];
}

// layout: 'crop' (center crop, fills the screen) or 'blur' (whole frame + blurred background)
export function videoFilter({ srcW, srcH, centerX = 0.5, layout = 'blur', subs = null, fontsDir = 'fonts', outW = 1080, outH = 1920 }) {
  const subFilter = subs ? `,ass=${subs}:fontsdir=${fontsDir}` : '';
  if (layout === 'blur' || srcW / srcH <= outW / outH) {
    return {
      complex: true,
      filter:
        `[0:v]split[a][b];` +
        `[a]scale=${outW}:${outH}:force_original_aspect_ratio=increase,crop=${outW}:${outH},boxblur=24:2,eq=brightness=-0.08[bg];` +
        `[b]scale=${outW}:${outH}:force_original_aspect_ratio=decrease[fg];` +
        `[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1${subFilter}[v]`,
    };
  }
  const cw = even((srcH * outW) / outH);
  let x = Math.round(centerX * srcW - cw / 2);
  x = Math.max(0, Math.min(srcW - cw, x));
  return { complex: false, filter: `crop=${cw}:${even(srcH)}:${x}:0,scale=${outW}:${outH},setsar=1${subFilter}` };
}

export function renderArgs({ input, output, duration, filter, preset = 'veryfast', crf = 20 }) {
  const args = ['-y', '-i', input, '-t', duration.toFixed(2)];
  if (filter.complex) args.push('-filter_complex', filter.filter, '-map', '[v]', '-map', '0:a?');
  else args.push('-vf', filter.filter);
  args.push(
    '-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-pix_fmt', 'yuv420p', '-r', '30',
    '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-movflags', '+faststart', output,
  );
  return args;
}

// ---------- gaming: split screen (facecam on top, gameplay below) ----------
// Boxes are normalized to the source frame: x, y = top-left, w = width (0..1);
// the height follows from the output panel's aspect ratio.
export function splitHeights(topRatio = 0.4, outH = 1920) {
  const top = even(outH * Math.min(0.6, Math.max(0.2, topRatio)));
  return { top, bottom: outH - top };
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

export function gameFilter({ srcW, srcH, face, game, topRatio = 0.4, noCam = false, subs = null, fontsDir = 'fonts', outW = 1080, outH = 1920 }) {
  const subFilter = subs ? `,ass=${subs}:fontsdir=${fontsDir}` : '';
  if (noCam) {
    const g = boxPixels(game, outW / splitHeights(0.4, outH).bottom, srcW, srcH);
    return {
      complex: true,
      filter:
        `[0:v]split[a][b];` +
        `[a]scale=${outW}:${outH}:force_original_aspect_ratio=increase,crop=${outW}:${outH},boxblur=24:2,eq=brightness=-0.1[bg];` +
        `[b]crop=${g.w}:${g.h}:${g.x}:${g.y},scale=${outW}:-2[fg];` +
        `[bg][fg]overlay=0:(H-h)/2,setsar=1${subFilter}[v]`,
    };
  }
  const { top, bottom } = splitHeights(topRatio, outH);
  const f = boxPixels(face, outW / top, srcW, srcH);
  const g = boxPixels(game, outW / bottom, srcW, srcH);
  return {
    complex: true,
    filter:
      `[0:v]split[a][b];` +
      `[a]crop=${f.w}:${f.h}:${f.x}:${f.y},scale=${outW}:${top},setsar=1[top];` +
      `[b]crop=${g.w}:${g.h}:${g.x}:${g.y},scale=${outW}:${bottom},setsar=1[bot];` +
      `[top][bot]vstack=inputs=2${subFilter}[v]`,
  };
}
