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
