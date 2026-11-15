# AutoClip

Aplikasi web (Next.js) untuk memotong video panjang menjadi klip vertikal 9:16 siap upload ke TikTok, Reels, dan Shorts, lengkap dengan caption otomatis.

**Biaya: Rp0.** Semua layanan yang dipakai gratis:

| Bagian | Layanan | Biaya |
|---|---|---|
| Hosting | Vercel Hobby | Gratis |
| Transkrip suara | Whisper di Groq | Gratis (free tier) |
| AI pemilih momen | Google Gemini API | Gratis (free tier) |
| Potong, crop & caption video | ffmpeg.wasm, berjalan **di browser Anda** | Gratis |

Video **tidak di-upload ke server**. Hanya audio kecil (untuk transkrip) dan teks transkrip (untuk AI) yang dikirim.

---

## Cara kerja

1. Anda memilih video, lalu browser mengambil audionya dan memecahnya jadi potongan kecil.
2. Audio dikirim ke Whisper (Groq) untuk dijadikan transkrip lengkap dengan waktu tiap kata.
3. Gemini membaca transkrip dan memilih momen dengan hook paling kuat (skor 0–100).
4. Deteksi wajah (MediaPipe) mencari posisi pembicara supaya crop vertikal tidak memotong wajah.
5. Browser merender klip 720×1280 dengan caption kata-per-kata (highlight kuning, font Poppins) dan judul di 4 detik pertama.
6. Anda klik Download.

Setiap klip masih bisa diatur sebelum dirender: jam mulai/selesai, posisi crop, mode crop atau layar penuh + blur (cocok untuk gaming), serta caption dan judul.

---

## Langkah deploy (±15 menit)

### 1. Buat API key gratis
- **Groq:** https://console.groq.com/keys, login, lalu klik *Create API Key*.
- **Gemini:** https://aistudio.google.com/apikey, login dengan akun Google, lalu klik *Create API key*.

Tidak perlu memasukkan kartu kredit.

### 2. Upload kode ke GitHub
1. Buat akun di https://github.com, lalu klik **New repository** (misalnya `autoclip`, pilih *Private*).
2. Klik **uploading an existing file**, lalu drag semua isi folder `autoclip` ini (jangan foldernya, tapi isinya), lalu klik **Commit**.

### 3. Deploy di Vercel
1. Login di https://vercel.com dengan akun GitHub.
2. Klik **Add New → Project**, lalu pilih repo `autoclip`, lalu **Import**.
3. Buka bagian **Environment Variables** dan isi:
   - `GROQ_API_KEY` = key dari Groq
   - `GEMINI_API_KEY` = key dari Gemini
   - `APP_PASSWORD` = password bebas buatan Anda (supaya orang lain tidak bisa memakai kuota gratis Anda)
4. Klik **Deploy**. Setelah selesai, Anda mendapat link seperti `autoclip-xxx.vercel.app`.

Saat aplikasi pertama kali meminta password, isi dengan `APP_PASSWORD` tadi.

---

## Tips & batasan

- **Format video:** MP4 (H.264) paling aman. Kalau browser tidak bisa membaca video Anda (misalnya MKV/HEVC), ubah dulu ke MP4.
- **Browser:** Chrome atau Edge di laptop/PC paling cepat. **Mode cepat** memakai semua core CPU. Kalau render macet di 0%, matikan Mode cepat.
- **Kecepatan render:** tergantung komputer. Karena gratis, proses berjalan di komputer Anda sendiri, bukan di server berbayar. Ukuran 720×1280 dipilih supaya cepat, dan tetap tajam di HP.
- **Batas gratis:** Groq dan Gemini punya batas pemakaian per menit dan per hari. Untuk pemakaian pribadi biasanya cukup. Kalau muncul error *429 / rate limit*, tunggu sebentar lalu coba lagi.
- **Privasi:** pada free tier, Google boleh memakai data yang dikirim ke Gemini untuk meningkatkan layanannya. Jangan pakai untuk video yang isinya rahasia.
- **Vercel Hobby** ditujukan untuk pemakaian pribadi/non-komersial. Kalau nanti aplikasi ini mau dijual sebagai layanan, perlu paket berbayar.
- **Claude API (opsional, berbayar):** kalau suatu saat ingin pemilihan momen memakai Claude, isi `ANTHROPIC_API_KEY`. API ini **terpisah** dari langganan Claude.ai dan ada biayanya. Kalau dikosongkan, aplikasi tetap memakai Gemini (gratis).

## Struktur kode

```
app/page.jsx                 halaman utama
app/api/transcribe/route.js  potongan audio → Whisper (Groq)
app/api/highlights/route.js  transkrip → AI pemilih momen (Gemini / Groq / Claude)
components/ClipperApp.jsx    seluruh tampilan & alur kerja
lib/ffmpeg.js                ffmpeg.wasm di browser (audio, render)
lib/commands.js              perintah ffmpeg (crop 9:16, blur, caption)
lib/captions.js              caption kata-per-kata (.ass)
lib/face.js                  deteksi wajah (MediaPipe)
lib/highlights.js            prompt AI, parsing & perapian klip
test/pipeline.test.mjs       tes perintah video dengan ffmpeg asli
```

Menjalankan di komputer sendiri (opsional): salin `.env.example` menjadi `.env.local`, isi key-nya, lalu jalankan `npm install` dan `npm run dev`.

Font caption: Poppins Bold (SIL Open Font License, bebas dipakai komersial).
