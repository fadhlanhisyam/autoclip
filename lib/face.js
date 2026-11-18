// Find where the main speaker's face is in a clip, so the vertical crop
// can follow it. Runs MediaPipe face detection in the browser.

const VISION_VER = '0.10.14';
const MODEL =
  'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite';

let detectorPromise = null;

async function getDetector() {
  if (!detectorPromise) {
    detectorPromise = (async () => {
      const { FaceDetector, FilesetResolver } = await import('@mediapipe/tasks-vision');
      const vision = await FilesetResolver.forVisionTasks(
        `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VISION_VER}/wasm`,
      );
      return FaceDetector.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MODEL, delegate: 'CPU' },
        runningMode: 'IMAGE',
        minDetectionConfidence: 0.5,
      });
    })().catch((e) => {
      detectorPromise = null;
      throw e;
    });
  }
  return detectorPromise;
}

function seek(video, t) {
  return new Promise((resolve) => {
    const done = () => {
      video.removeEventListener('seeked', done);
      resolve();
    };
    video.addEventListener('seeked', done);
    video.currentTime = t;
    setTimeout(done, 4000); // never hang on a bad seek
  });
}

const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

// Returns horizontal face center as a ratio 0..1 (0.5 = middle), or null if no face.
export async function findFaceCenter(videoUrl, start, end, samples = 12) {
  const detector = await getDetector();
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  video.src = videoUrl;
  await new Promise((res, rej) => {
    video.onloadeddata = res;
    video.onerror = () => rej(new Error('Video tidak bisa dibaca browser'));
  });

  const scale = Math.min(1, 640 / video.videoWidth);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  const ctx = canvas.getContext('2d');

  const centers = [];
  const step = (end - start) / samples;
  for (let i = 0; i < samples; i++) {
    await seek(video, start + step * (i + 0.5));
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const result = detector.detect(canvas);
    const faces = result.detections || [];
    if (!faces.length) continue;
    // biggest face = most likely the person talking to camera
    const big = faces.reduce((a, b) =>
      a.boundingBox.width * a.boundingBox.height > b.boundingBox.width * b.boundingBox.height ? a : b,
    );
    centers.push((big.boundingBox.originX + big.boundingBox.width / 2) / canvas.width);
  }
  video.removeAttribute('src');
  video.load();
  return centers.length ? median(centers) : null;
}

// Where is the facecam? Samples frames across the whole video and returns the
// median face box (normalized x, y, w, h), or null if no face was found.
export async function findFaceBox(videoUrl, duration, samples = 10) {
  const detector = await getDetector();
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  video.src = videoUrl;
  await new Promise((res, rej) => {
    video.onloadeddata = res;
    video.onerror = () => rej(new Error('Video tidak bisa dibaca browser'));
  });
  // facecams are small, so detect on a larger frame
  const scale = Math.min(1, 1280 / video.videoWidth);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  const ctx = canvas.getContext('2d');
  const boxes = [];
  for (let i = 0; i < samples; i++) {
    await seek(video, duration * ((i + 0.5) / samples));
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const faces = detector.detect(canvas).detections || [];
    if (!faces.length) continue;
    const big = faces.reduce((a, b) =>
      a.boundingBox.width * a.boundingBox.height > b.boundingBox.width * b.boundingBox.height ? a : b,
    );
    const b = big.boundingBox;
    boxes.push({ x: b.originX / canvas.width, y: b.originY / canvas.height, w: b.width / canvas.width, h: b.height / canvas.height });
  }
  video.removeAttribute('src');
  video.load();
  if (boxes.length < Math.max(2, samples / 4)) return null;
  return {
    x: median(boxes.map((b) => b.x)),
    y: median(boxes.map((b) => b.y)),
    w: median(boxes.map((b) => b.w)),
    h: median(boxes.map((b) => b.h)),
  };
}
