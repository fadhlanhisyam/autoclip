/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  // Cross-origin isolation enables SharedArrayBuffer, which lets ffmpeg.wasm
  // use all CPU cores (multi-thread) for much faster rendering.
  // "credentialless" keeps CDN scripts/models loadable without extra headers.
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          { key: 'Cross-Origin-Embedder-Policy', value: 'credentialless' },
        ],
      },
    ];
  },
};

export default nextConfig;
