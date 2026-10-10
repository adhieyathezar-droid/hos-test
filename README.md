# Upload Data Penjualan HOS

Aplikasi upload data (Ginee, Revota, dana platform) dengan login per divisi.
Frontend statis (`public/`) + satu Netlify Function (`netlify/functions/api.mjs`) + Postgres.

## Pasang di Netlify (uji coba)
1. Taruh folder ini di repositori GitHub, lalu di Netlify pilih **Add new site > Import an existing project**.
   Atau tanpa GitHub: `npm i -g netlify-cli`, lalu `netlify deploy --prod` dari folder ini.
2. Siapkan database Postgres. Dua cara:
   - **Netlify Database** (aktifkan di dashboard situs; hanya untuk paket Netlify berbasis kredit), atau
   - Postgres gratis dari **Neon** atau **Supabase**, lalu salin connection string-nya.
3. Di Netlify: **Site configuration > Environment variables**, isi:
   - `DATABASE_URL` = connection string Postgres (isi ini secara eksplisit, apa pun penyedianya)
   - `SESSION_SECRET` = teks acak minimal 32 karakter
   - `ADMIN_USER` dan `ADMIN_PASSWORD` = akun Admin pertama (dibuat otomatis saat login pertama; sandi min. 8 karakter)
4. Deploy ulang, buka situsnya, login sebagai admin, lalu buat akun per divisi di tab **Pengguna**.
   Tabel database dibuat otomatis saat pertama kali diakses.

## Pasang di Render (alternatif jika kredit Netlify habis)
Aplikasi ini juga bisa jalan sebagai server Node biasa (`npm start`, file `server.mjs`).
1. Database: buat project gratis di **neon.tech**, salin connection string (postgresql://...). Database Neon gratis tidak kedaluwarsa.
   Jangan pakai Postgres gratis milik Render: database itu dihapus 30 hari setelah dibuat.
2. Taruh folder ini di repositori GitHub (privat).
3. Di render.com: **New > Blueprint**, pilih repositori itu. File `render.yaml` sudah mengatur semuanya.
   Render meminta nilai `DATABASE_URL` (dari Neon), `ADMIN_USER`, dan `ADMIN_PASSWORD`. `SESSION_SECRET` dibuat otomatis.
4. Setelah status Live, buka alamat `...onrender.com` dan login sebagai admin.
Catatan: layanan gratis Render tidur setelah 15 menit tanpa pengunjung dan butuh sekitar 1 menit untuk bangun pada akses pertama.
Untuk pemakaian harian oleh tim, paket berbayar terkecil menghilangkan masalah itu.

## Hak akses
Sales hanya Ginee. Operasional hanya Revota. Finance hanya Shopee/TikTok. Admin semuanya dan mengelola akun.
Dicek di server, bukan hanya di layar.

## Tes
`npm install && npm test` (dan `npm run test:server`) menjalankan tes lengkap (Postgres in-memory) dengan file asli di `/mnt/user-data/uploads`;
ubah path di `scripts/test.mjs` bila dijalankan di komputer lain.

## Catatan untuk tim IT (pindah ke produksi)
- Database Postgres standar; kode hanya butuh `DATABASE_URL`. Function berbentuk ESM Node 20+ (handler Request/Response).
- Batas per upload: 60.000 baris dan sekitar 6 MB (batas payload Netlify Functions). File dibaca di browser, server hanya menerima data ringkas.
- Sesi: cookie HttpOnly + SameSite=Strict, berlaku 12 jam. Kunci akun 15 menit setelah 5 salah sandi.
- Sebelum dipakai untuk data keuangan nyata: tinjau keamanan, pasang backup database, atur rotasi `SESSION_SECRET`, pertimbangkan 2FA.
- Tabel: users, uploads, ginee_orders, ginee_status_history, revota_lines, dana_lines (lihat `_core.mjs`).
