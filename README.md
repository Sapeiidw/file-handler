# File Handler

Studio pemrosesan gambar lokal: React + TypeScript, FastAPI, Pillow, ONNX Runtime, dan Nginx. Semua gambar diproses pada komputer ini; tidak ada API AI berbayar, telemetri, atau upload gambar ke layanan luar.

**URL production:** http://file-handler.local  
**Project:** `/home/dev/Personal/file-handler`  
**Backend internal:** `127.0.0.1:8788`

## Fitur

- Konversi output **PNG, JPG, WebP, AVIF, TIFF, BMP, ICO, GIF statis, PDF**.
- Input JPG, PNG, WebP, AVIF, HEIC/HEIF, TIFF, BMP, ICO, GIF statis; deteksi konten file oleh decoder.
- Hapus background: **BiRefNet General** untuk kualitas, **BiRefNet Lite** untuk kecepatan. Output mask dipulihkan ke dimensi asli; alpha sumber tetap dihormati.
- Upscale **2× / 4×**: **Real-ESRGAN x4plus FP32** dengan tile overlap 16px, atau Lanczos untuk mode cepat. Alpha diresize terpisah.
- Kompresi, WebP lossless, resize proporsional, rotasi, flip, kecerahan, kontras, saturasi.
- Batch maksimal 20 gambar, progres per file, batalkan antrean/proses, preview sebelum/sesudah, download individual/ZIP, riwayat perangkat.
- Koreksi orientasi EXIF, konversi profil ICC ke sRGB jika profil valid, pembuangan metadata privat dari hasil.

**Batas yang disengaja:** 50 MB/file, input 40 MP, output transformasi maksimal 60 MP. AI upscale CPU maksimal input 2 MP; gunakan mode cepat untuk lebih besar. ICO maksimal 256px; GIF output 256 warna dan background solid. PNG/TIFF memakai kompresi lossless; AVIF memakai kualitas lossy. Pipeline warna menggunakan sRGB 8-bit; HDR/16-bit tidak dipertahankan. Animasi, dokumen multipage, SVG, RAW, dan konversi vektor belum didukung. AI tidak menjamin rekonstruksi detail yang faktual.

## Operasional production

Service user systemd aktif dengan restart otomatis. `Linger=yes` pada user dev memungkinkan service tetap berjalan setelah logout dan saat boot. Nginx aplikasi berjalan sebagai user pada port internal 8088. Domain utama **http://file-handler.local** dilayani Nginx sistem pada port 80 dan diproksikan ke port internal tersebut. Konfigurasi situs lain di `/etc/nginx` tidak diubah.

Pasang domain sekali saja (memerlukan akses administrator untuk memasang virtual host dan entri hosts):

```bash
sudo bash deploy/install-domain.sh
```

Script memasang `deploy/file-handler.local.conf` sebagai virtual host Nginx, mengaktifkannya, menambahkan `127.0.0.1 file-handler.local` ke `/etc/hosts`, menguji konfigurasi, lalu me-reload Nginx. Jika pemasangan gagal, konfigurasi yang disentuh akan dipulihkan dari backup. Port internal `localhost:8088` tetap tersedia untuk diagnosis.

```bash
systemctl --user status file-handler.service file-handler-nginx.service
systemctl --user restart file-handler.service
systemctl --user reload file-handler-nginx.service
journalctl --user -u file-handler.service -f
```

Konfigurasi Nginx aplikasi: `deploy/nginx.conf` (dihasilkan dari `deploy/nginx.conf.template`). Virtual host domain: `deploy/file-handler.local.conf`. Log Nginx aplikasi: `data/nginx-access.log`, `data/nginx-error.log`. API docs: http://file-handler.local/api/docs. Health: http://file-handler.local/api/health.

Pasang ulang/update dari direktori project (Node 22.12+, uv, Python 3.12, Nginx, systemd user):

```bash
./scripts/install-production.sh
```

Script membangun frontend, menginstal dependency terkunci, memverifikasi/download model, menguji konfigurasi Nginx, dan mengaktifkan kedua service. Tidak memerlukan sudo. Port hanya listen pada loopback; konfigurasi ini untuk penggunaan lokal.

## Penyimpanan & performa

- Metadata job di SQLite WAL. File masuk/hasil disimpan di `data/<uuid>/` dengan permission privat. UUID acak dan riwayat browser membatasi penemuan file; aplikasi lokal ini tidak memakai akun/login.
- Retensi default 24 jam, pembersihan setiap 10 menit. Riwayat browser hanya menyimpan ID job. File asli dan preview ikut dihapus. Penghapusan manual tersedia di setiap baris hasil.
- Maksimal 60 job aktif dan batas penerimaan berdasarkan penggunaan storage 5 GB. File output sementara bisa menaikkan penggunaan melewati batas ini; disk harus tetap memiliki ruang cadangan.
- Dua worker konversi, satu worker AI, 4 thread inferensi. Respons API tetap tersedia saat AI memproses. Upscale ditile untuk membatasi memori. Model dimuat sesuai kebutuhan dan disimpan pada cache dua sesi. Memori API dibatasi systemd 8 GB.
- Job aktif ditandai gagal jika service restart; file selesai dan riwayat tetap tersedia. Pembatalan upscale diperiksa per tile; segmentasi yang sedang berjalan baru berhenti sesudah satu inferensi selesai.
- File ZIP memakai ZIP_STORED karena data gambar sudah terkompresi, lalu dibuang setelah download.
- Default engine CPU. Waktu AI meningkat mengikuti ukuran gambar dan perangkat. Mode cepat tersedia tanpa mengklaimnya sebagai rekonstruksi AI.

Environment yang dapat ditambahkan ke unit `file-handler.service`: `AI_THREADS`, `OMP_NUM_THREADS`, `DATA_DIR`, `MODEL_DIR`, `RETENTION_HOURS`, `MAX_STORAGE_MB`. Setelah mengubah unit: `systemctl --user daemon-reload && systemctl --user restart file-handler.service`.

## Development & verifikasi

```bash
uv pip install -r requirements-dev.txt
npm ci
npm run lint
npm test
npm run build
# Terminal 1
.venv/bin/python -m uvicorn backend.app:app --host 127.0.0.1 --port 8788
# Terminal 2
npm run dev
```

Hentikan service backend production sebelum menjalankan development backend pada port yang sama, atau gunakan port lain dan ubah proxy Vite. Jangan menjalankan beberapa proses API yang memakai direktori data sama: setiap proses memiliki antrean internal sendiri.

`npm test` menguji seluruh format output, alpha, flattening, resize/rotasi, EXIF, ZIP, pembatalan, retensi, penghapusan file, input rusak/animasi, opsi ilegal, isolasi riwayat, dan cross-origin upload. `npx playwright install chromium && npm run test:e2e` menguji alur browser desktop/mobile melalui Nginx production yang sudah aktif, termasuk background removal AI sungguhan, perbandingan gambar, download individual/ZIP, dan dokumentasi API offline. `scripts/verify_ai.py` menjalankan ketiga model sungguhan serta menghasilkan gambar/report di `data/verification/`. Ini menguji kesehatan pipeline, bukan benchmark kualitas universal.

## Model & atribusi

Unduh pertama kali memerlukan internet (~1,2 GB). Setelah itu seluruh pemrosesan offline. `scripts/download_models.py` memverifikasi checksum sebelum memindahkan file model ke nama final; model tidak masuk Git.

- [BiRefNet](https://github.com/ZhengPeng7/BiRefNet), Peng Zheng dkk., MIT. Weight General dan Lite dari [rilis rembg](https://github.com/danielgatis/rembg/releases/tag/v0.0.0); checksum MD5 cocok dengan [implementasi rembg](https://github.com/danielgatis/rembg/tree/main/rembg/sessions). MD5 dipakai untuk kecocokan upstream, unduhan memakai HTTPS.
- [Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN), Xintao Wang dkk., BSD-3-Clause. Weight x4plus; [konversi ONNX SkillSafe](https://huggingface.co/skillsafe-ai/realesrgan-x4plus) dengan SHA-256 `4851ec156207d271f5328605d0582eeb851e656227da8aca093ced9e60789291`.
- Gambar contoh: [REVOLT di Unsplash](https://unsplash.com/photos/164_6wVEHfI), didistribusikan via images.unsplash.com/photo-1542291026-7eec264c27ff, [Unsplash License](https://unsplash.com/license).
- Font Inter: [Rasmus Andersson](https://github.com/rsms/inter), SIL Open Font License; dihost lokal melalui Fontsource. Ikon Lucide: ISC.

Lisensi pihak ketiga tersimpan di `THIRD_PARTY_NOTICES.md` dan `licenses/`.
