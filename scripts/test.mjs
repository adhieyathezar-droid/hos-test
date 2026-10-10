import { PGlite } from '@electric-sql/pglite';
import XLSX from 'xlsx';
import { detect, parseRecords } from '../public/parse.mjs';

const pg = new PGlite();
globalThis.__DB = { query: (s, p) => pg.query(s, p), tx: (fn) => pg.transaction((t) => fn(t)) };
process.env.SESSION_SECRET = 'rahasia-tes-1234567890';
process.env.ADMIN_USER = 'admin'; process.env.ADMIN_PASSWORD = 'Admin12345';
const { default: handler } = await import('../netlify/functions/api.mjs');
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + m); };

async function call(method, path, body, cookie) {
  const r = await handler(new Request('http://localhost' + path, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method === 'GET' ? undefined : JSON.stringify(body || {}) }));
  const sc = r.headers.get('set-cookie');
  return { s: r.status, j: await r.json(), cookie: sc ? sc.split(';')[0] : null };
}
const load = (f) => { const wb = XLSX.readFile('/mnt/user-data/uploads/' + f, { cellDates: true }); return wb.SheetNames.map((n) => XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: null, blankrows: false })); };
const parse = (f) => { const d = detect(load(f)); return d && { kind: d.kind, recs: parseRecords(d.kind, d.rows) }; };

// 1. login & pengguna
let r = await call('POST', '/api/login', { username: 'admin', password: 'salah' }); ok(r.s === 401, 'login salah ditolak (401)');
r = await call('POST', '/api/login', { username: 'admin', password: 'Admin12345' }); ok(r.s === 200 && r.cookie, 'admin pertama dibuat dari env dan bisa login');
const A = r.cookie;
for (const [u, role] of [['sales1', 'sales'], ['ops1', 'ops'], ['fin1', 'finance']]) { r = await call('POST', '/api/users', { username: u, name: u, role, password: 'Sandi12345' }, A); ok(r.s === 200, `admin membuat akun ${u}`); }
const login = async (u) => (await call('POST', '/api/login', { username: u, password: 'Sandi12345' })).cookie;
const S = await login('sales1'), O = await login('ops1'), F = await login('fin1');
r = await call('GET', '/api/users', null, S); ok(r.s === 403, 'sales tidak bisa melihat daftar pengguna');
r = await call('GET', '/api/status'); ok(r.s === 401, 'tanpa login ditolak (401)');

// 2. parsing file asli
const g = parse('OET6AC5C52ECFF47E0001954EBB_20261007120606643_8316301096_pdf_1.xlsx');
const rvA = parse('04__april_2026_cv_hos_revota.xlsx'), rvB = parse('04__april_2026_tiktok_revota.xlsx');
const sh = parse('Jan_-_April_Monitoring_Penerimaan_Platform_Shopee.xlsx'), tk = parse('Jan_-_April_Monitoring_Penerimaan_Platform_Tiktok.xlsx');
const shD = parse('Shopee_Januari_-_April_2026.xlsx'), tkD = parse('Tiktok_Januari_-_April_2026.xlsx');
console.log('terdeteksi:', g?.kind, g?.recs.length, '| revota', rvA?.kind, rvA?.recs.length, rvB?.kind, rvB?.recs.length, '| shopee', shD?.kind, shD?.recs.length, '| tiktok', tkD?.kind, tkD?.recs.length);
ok(g?.kind === 'ginee' && g.recs.length === 7403, 'Ginee: 7.403 pesanan April terbaca');
ok(rvA?.kind === 'revota' && rvB?.kind === 'revota', 'Revota (2 file) terdeteksi');
ok(shD?.kind === 'shopee' && tkD?.kind === 'tiktok', 'Dana Shopee & TikTok terdeteksi');

// 3. hak akses per divisi
r = await call('POST', '/api/upload/revota?commit=1', { filename: 'x', records: rvA.recs.slice(0, 10) }, S); ok(r.s === 403, 'sales upload Revota ditolak server (403)');
r = await call('POST', '/api/upload/ginee?commit=1', { filename: 'x', records: g.recs.slice(0, 10) }, O); ok(r.s === 403, 'ops upload Ginee ditolak server (403)');
r = await call('POST', '/api/upload/ginee?commit=1', { filename: 'x', records: [{ order_id: 'A', created_at: 'rusak' }] }, S); ok(r.s === 400, 'data rusak ditolak (400)');

// 4. alur Ginee: hari ke-1 (status lama) lalu hari ke-3 (status berubah)
const day1 = g.recs.map((o, i) => (i < 10 ? { ...o, status: 'Shipping' } : o));
r = await call('POST', '/api/upload/ginee?commit=0', { filename: 'ginee_tgl1.xlsx', records: day1 }, S); ok(r.s === 200 && r.j.st.baru === 7403 && !r.j.committed, 'pratinjau hari 1: 7.403 baru, belum tersimpan');
r = await call('GET', '/api/status', null, S); ok(r.j.counts.ginee === 0, 'pratinjau tidak menyimpan apa pun');
r = await call('POST', '/api/upload/ginee?commit=1', { filename: 'ginee_tgl1.xlsx', records: day1 }, S); ok(r.s === 200 && r.j.st.baru === 7403, 'simpan hari 1');
r = await call('POST', '/api/upload/ginee?commit=1', { filename: 'ginee_tgl1_lagi.xlsx', records: day1 }, S); ok(r.j.st.baru === 0 && r.j.st.ubah === 0 && r.j.st.sama === 7403, 'upload file yang sama dua kali: tidak dobel');
r = await call('POST', '/api/upload/ginee?commit=1', { filename: 'ginee_tgl3.xlsx', records: g.recs }, S);
ok(r.j.st.ubah === 10 && r.j.st.baru === 0 && r.j.changes.length === 10 && r.j.changes[0][1] === 'Shipping', 'hari 3: 10 pesanan berubah status Shipping -> final, terlihat di ringkasan');
let c = await pg.query(`select count(*)::int n from ginee_orders`); ok(c.rows[0].n === 7403, 'tabel pesanan tetap 7.403 baris (ditimpa, bukan ditambah)');
c = await pg.query(`select count(*)::int n from ginee_status_history`); ok(c.rows[0].n === 10, 'riwayat perubahan status tercatat 10 baris');
r = await call('POST', '/api/upload/ginee?commit=0', { filename: 'sebagian', records: g.recs.slice(0, 7000) }, S); ok(r.j.st.hilang > 0, `pesanan hilang terdeteksi saat file lebih pendek (${r.j.st.hilang})`);

// 5. Revota harian & Finance
const ops = [...rvA.recs, ...rvB.recs];
r = await call('POST', '/api/upload/revota?commit=1', { filename: 'revota_april', records: ops }, O); ok(r.s === 200, `Revota disimpan: ${r.j.rows} baris, ${r.j.st.baru} baru`);
r = await call('POST', '/api/upload/revota?commit=1', { filename: 'revota_april_lagi', records: ops }, O); ok(r.j.st.baru === 0, 'Revota upload ulang: tidak dobel');
r = await call('POST', '/api/upload/shopee?commit=1', { filename: 'shopee', records: shD.recs }, F); ok(r.s === 200, `Dana Shopee disimpan: ${r.j.rows} baris`);
r = await call('POST', '/api/upload/tiktok?commit=1', { filename: 'tiktok', records: tkD.recs }, F); ok(r.s === 200, `Dana TikTok disimpan: ${r.j.rows} baris`);
r = await call('GET', '/api/status', null, A); console.log('status:', JSON.stringify({ counts: r.j.counts, last: r.j.last.map((x) => [x.g, x.name, x.today]), hari_revota: r.j.revota_days.length }));
ok(r.j.last.length === 3 && r.j.history.length >= 6, 'status & riwayat upload terisi untuk 3 jalur');

// 6. pencocokan lintas sumber (bukti data bisa digabung nanti)
c = await pg.query(`select count(*)::int n from ginee_orders g where status='Completed' and exists(select 1 from revota_lines r where r.order_no=g.order_id) and exists(select 1 from dana_lines d where d.order_no=g.order_id)`);
console.log('pesanan Completed yang ada di Revota DAN dana:', c.rows[0].n);
ok(c.rows[0].n > 3000, 'tiga sumber bisa digabung lewat nomor pesanan');
r = await call('PATCH', '/api/users/2', { active: false }, A); r = await call('POST', '/api/login', { username: 'sales1', password: 'Sandi12345' }); ok(r.s === 403, 'akun dinonaktifkan tidak bisa login');
console.log(`\nHASIL: ${pass} lulus, ${fail} gagal`); process.exit(fail ? 1 : 0);
