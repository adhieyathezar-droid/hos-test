import pg from 'pg';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';

// ---------- Database (Postgres biasa lewat DATABASE_URL; portabel ke hosting mana pun) ----------
export const SCHEMA = [
  `create table if not exists users(id serial primary key, username text unique not null, name text not null,
    role text not null check (role in ('sales','ops','finance','admin')), pass_hash text not null,
    active boolean not null default true, failed int not null default 0, locked_until timestamptz, created_at timestamptz not null default now())`,
  `create table if not exists uploads(id serial primary key, kind text not null, filename text, user_id int references users(id),
    at timestamptz not null default now(), rows int, n_new int, n_changed int, n_same int, n_missing int, period text)`,
  `create table if not exists ginee_orders(order_id text primary key, channel text, status text, created_at timestamp, qty int,
    subtotal numeric, total numeric, refund numeric, cancel_reason text, updated_at timestamptz not null default now(), upload_id int)`,
  `create table if not exists ginee_status_history(id bigserial primary key, order_id text, old_status text, new_status text,
    changed_at timestamptz not null default now(), upload_id int)`,
  `create table if not exists revota_lines(line_key text primary key, order_no text, trans_date timestamp, qty int, nett numeric,
    channel text, is_ref boolean, upload_id int)`,
  `create table if not exists dana_lines(line_key text primary key, order_no text, platform text, paid_at timestamp, amount numeric, upload_id int)`,
  `create index if not exists i_ginee_created on ginee_orders(created_at)`,
  `create index if not exists i_hist_order on ginee_status_history(order_id)`,
  `create index if not exists i_rev_date on revota_lines(trans_date)`,
  `create index if not exists i_rev_order on revota_lines(order_no)`,
  `create index if not exists i_dana_date on dana_lines(paid_at)`,
  `create index if not exists i_dana_order on dana_lines(order_no)`,
];
let pool, ready;
export function db() {
  if (globalThis.__DB) return globalThis.__DB;
  if (!pool) {
    const cs = process.env.DATABASE_URL || process.env.NETLIFY_DATABASE_URL;
    if (!cs) throw new HttpError(500, 'DATABASE_URL belum diatur');
    const local = /localhost|127\.0\.0\.1/.test(cs);
    pool = new pg.Pool({ connectionString: cs, max: 3, ssl: local ? undefined : { rejectUnauthorized: false } });
  }
  return {
    query: (s, p) => pool.query(s, p),
    tx: async (fn) => {
      const c = await pool.connect();
      try { await c.query('begin'); const r = await fn(c); await c.query('commit'); return r; }
      catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
    },
  };
}
export async function init() {
  ready ||= (async () => { for (const s of SCHEMA) await db().query(s); })();
  return ready;
}
export class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

// ---------- Login & sesi ----------
export const ROLE_KINDS = { sales: ['ginee'], ops: ['revota'], finance: ['shopee', 'tiktok'], admin: ['ginee', 'revota', 'shopee', 'tiktok'] };
export const ROLE_NAME = { sales: 'Tim Sales', ops: 'Tim Operasional', finance: 'Finance', admin: 'Admin' };
const b64 = (b) => Buffer.from(b).toString('base64url');
const secret = () => { const s = process.env.SESSION_SECRET; if (!s || s.length < 16) throw new HttpError(500, 'SESSION_SECRET belum diatur (min. 16 karakter)'); return s; };
export function signToken(uid) {
  const body = b64(JSON.stringify({ uid, exp: Date.now() + 12 * 3600 * 1000 }));
  return body + '.' + crypto.createHmac('sha256', secret()).update(body).digest('base64url');
}
export function readToken(t) {
  const [body, sig] = (t || '').split('.');
  if (!body || !sig) return null;
  const exp = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  if (sig.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp))) return null;
  const p = JSON.parse(Buffer.from(body, 'base64url').toString());
  return p.exp > Date.now() ? p : null;
}
export const hashPw = (pw) => bcrypt.hash(pw, 10);
export async function userFromReq(req) {
  const m = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.get('cookie') || '');
  const p = m && readToken(m[1]);
  if (!p) return null;
  const r = await db().query('select id,username,name,role,active from users where id=$1', [p.uid]);
  const u = r.rows[0];
  return u && u.active ? u : null;
}
export async function login(username, password) {
  const q = db().query.bind(db());
  let u = (await q('select * from users where lower(username)=lower($1)', [String(username || '')])).rows[0];
  if (!u) {
    const n = (await q('select count(*)::int c from users')).rows[0].c;
    if (n === 0 && process.env.ADMIN_USER && username === process.env.ADMIN_USER && password === process.env.ADMIN_PASSWORD) {
      u = (await q(`insert into users(username,name,role,pass_hash) values($1,'Admin','admin',$2) returning *`, [username, await hashPw(password)])).rows[0];
    } else throw new HttpError(401, 'Username atau kata sandi salah');
  }
  if (u.locked_until && new Date(u.locked_until) > new Date()) throw new HttpError(429, 'Akun dikunci sementara karena terlalu banyak percobaan. Coba lagi 15 menit lagi.');
  if (!u.active) throw new HttpError(403, 'Akun dinonaktifkan. Hubungi Admin.');
  if (!(await bcrypt.compare(String(password || ''), u.pass_hash))) {
    const f = u.failed + 1;
    await q('update users set failed=$2, locked_until=$3 where id=$1', [u.id, f >= 5 ? 0 : f, f >= 5 ? new Date(Date.now() + 15 * 60000) : null]);
    throw new HttpError(401, 'Username atau kata sandi salah');
  }
  await q('update users set failed=0, locked_until=null where id=$1', [u.id]);
  return u;
}

// ---------- Validasi & ingest ----------
const DT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
const S = (v, n) => String(v ?? '').slice(0, n);
const N = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const CLEAN = {
  ginee: (r) => DT.test(r.created_at) && r.order_id && { order_id: S(r.order_id, 60), channel: S(r.channel, 30), status: S(r.status, 40), created_at: r.created_at, qty: Math.round(N(r.qty)), subtotal: N(r.subtotal), total: N(r.total), refund: N(r.refund), cancel_reason: S(r.cancel_reason, 80) },
  revota: (r) => DT.test(r.trans_date) && r.line_key && { line_key: S(r.line_key, 200), order_no: S(r.order_no, 60), trans_date: r.trans_date, qty: Math.round(N(r.qty)), nett: N(r.nett), channel: S(r.channel, 30), is_ref: !!r.is_ref },
  dana: (r) => DT.test(r.paid_at) && r.line_key && { line_key: S(r.line_key, 200), order_no: S(r.order_no, 60), platform: r.platform === 'TikTok' ? 'TikTok' : 'Shopee', paid_at: r.paid_at, amount: N(r.amount) },
};
const KEY = { ginee: 'order_id', revota: 'line_key', dana: 'line_key' };
const grp = (k) => (k === 'shopee' || k === 'tiktok' ? 'dana' : k);
function clean(kind, recs) {
  if (!Array.isArray(recs) || !recs.length) throw new HttpError(400, 'Tidak ada data di file');
  if (recs.length > 60000) throw new HttpError(413, 'File terlalu besar (maks 60.000 baris). Pecah per periode.');
  const g = grp(kind), map = new Map();
  for (const r of recs) { const c = CLEAN[g](r || {}); if (c) map.set(c[KEY[g]], c); }
  if (!map.size) throw new HttpError(400, 'Tidak ada baris valid');
  return [...map.values()];
}
const ids = (recs, k) => JSON.stringify(recs.map((r) => r[k]));

async function plan(q, kind, recs) {
  const g = grp(kind), k = KEY[g], st = { baru: 0, ubah: 0, sama: 0, hilang: 0 }, changes = [];
  const J = ids(recs, k);
  if (g === 'ginee') {
    const ex = new Map((await q(`select order_id,status,total::float8 total,refund::float8 refund from ginee_orders where order_id in (select jsonb_array_elements_text($1::jsonb))`, [J])).rows.map((r) => [r.order_id, r]));
    for (const r of recs) {
      const o = ex.get(r.order_id);
      if (!o) st.baru++;
      else if (o.status !== r.status || o.total !== r.total || o.refund !== r.refund) { st.ubah++; if (o.status !== r.status && changes.length < 40) changes.push([r.order_id, o.status, r.status]); }
      else st.sama++;
    }
    const lo = recs.reduce((a, r) => (r.created_at < a ? r.created_at : a), '9'), hi = recs.reduce((a, r) => (r.created_at > a ? r.created_at : a), '0');
    st.hilang = (await q(`select count(*)::int c from ginee_orders where created_at between $2::timestamp and $3::timestamp and order_id not in (select jsonb_array_elements_text($1::jsonb))`, [J, lo, hi])).rows[0].c;
    return { st, changes, period: lo.slice(0, 10) + ' s.d. ' + hi.slice(0, 10) };
  }
  const tbl = g === 'revota' ? 'revota_lines' : 'dana_lines', c1 = g === 'revota' ? 'nett' : 'amount', dt = g === 'revota' ? 'trans_date' : 'paid_at';
  const ex = new Map((await q(`select line_key,${c1}::float8 v from ${tbl} where line_key in (select jsonb_array_elements_text($1::jsonb))`, [J])).rows.map((r) => [r.line_key, r.v]));
  for (const r of recs) { const o = ex.get(r.line_key); if (o === undefined) st.baru++; else if (o !== r[c1]) st.ubah++; else st.sama++; }
  const ds = recs.map((r) => r[dt]).sort();
  return { st, changes, period: ds[0].slice(0, 10) + ' s.d. ' + ds[ds.length - 1].slice(0, 10) };
}

async function apply(q, kind, recs, uid) {
  const g = grp(kind), J = JSON.stringify(recs);
  if (g === 'ginee') {
    await q(`insert into ginee_status_history(order_id,old_status,new_status,upload_id)
      select o.order_id,o.status,x.status,$2 from ginee_orders o join jsonb_to_recordset($1::jsonb) as x(order_id text,status text) on x.order_id=o.order_id where o.status is distinct from x.status`, [J, uid]);
    await q(`insert into ginee_orders(order_id,channel,status,created_at,qty,subtotal,total,refund,cancel_reason,upload_id)
      select order_id,channel,status,created_at::timestamp,qty,subtotal,total,refund,cancel_reason,$2 from jsonb_to_recordset($1::jsonb)
      as x(order_id text,channel text,status text,created_at text,qty int,subtotal numeric,total numeric,refund numeric,cancel_reason text)
      on conflict(order_id) do update set channel=excluded.channel,status=excluded.status,created_at=excluded.created_at,qty=excluded.qty,
      subtotal=excluded.subtotal,total=excluded.total,refund=excluded.refund,cancel_reason=excluded.cancel_reason,updated_at=now(),upload_id=excluded.upload_id`, [J, uid]);
  } else if (g === 'revota') {
    await q(`insert into revota_lines(line_key,order_no,trans_date,qty,nett,channel,is_ref,upload_id)
      select line_key,order_no,trans_date::timestamp,qty,nett,channel,is_ref,$2 from jsonb_to_recordset($1::jsonb)
      as x(line_key text,order_no text,trans_date text,qty int,nett numeric,channel text,is_ref boolean)
      on conflict(line_key) do update set qty=excluded.qty,nett=excluded.nett,channel=excluded.channel,is_ref=excluded.is_ref,upload_id=excluded.upload_id`, [J, uid]);
  } else {
    await q(`insert into dana_lines(line_key,order_no,platform,paid_at,amount,upload_id)
      select line_key,order_no,platform,paid_at::timestamp,amount,$2 from jsonb_to_recordset($1::jsonb)
      as x(line_key text,order_no text,platform text,paid_at text,amount numeric)
      on conflict(line_key) do update set amount=excluded.amount,paid_at=excluded.paid_at,upload_id=excluded.upload_id`, [J, uid]);
  }
}

export async function ingest(user, kind, body, commit) {
  if (!ROLE_KINDS[user.role].includes(kind)) throw new HttpError(403, `Akun ${ROLE_NAME[user.role]} tidak boleh mengunggah file ${kind}. Gunakan akun divisi yang sesuai.`);
  const recs = clean(kind, body?.records), filename = S(body?.filename, 80);
  if (!commit) { const p = await plan(db().query.bind(db()), kind, recs); return { ...p, rows: recs.length, committed: false }; }
  return db().tx(async (t) => {
    const q = t.query.bind(t), p = await plan(q, kind, recs);
    const id = (await q(`insert into uploads(kind,filename,user_id,rows,n_new,n_changed,n_same,n_missing,period) values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
      [kind, filename, user.id, recs.length, p.st.baru, p.st.ubah, p.st.sama, p.st.hilang, p.period])).rows[0].id;
    for (let i = 0; i < recs.length; i += 5000) await apply(q, kind, recs.slice(i, i + 5000), id);
    return { ...p, rows: recs.length, committed: true };
  });
}

export async function status() {
  const q = db().query.bind(db()), WIB = `(now() at time zone 'Asia/Jakarta')`;
  const last = (await q(`select distinct on (g) g, u.at, u.filename, u.rows, usr.name, ((u.at at time zone 'Asia/Jakarta')::date = ${WIB}::date) as today
    from (select *, case when kind in ('shopee','tiktok') then 'dana' else kind end g from uploads) u left join users usr on usr.id=u.user_id order by g, u.at desc`)).rows;
  const days = (await q(`select distinct to_char(trans_date,'YYYY-MM-DD') d from revota_lines where trans_date >= date_trunc('month', ${WIB})`)).rows.map((r) => r.d);
  const hist = (await q(`select u.at,u.kind,u.filename,u.rows,u.n_new,u.n_changed,u.n_missing,u.period,usr.name from uploads u left join users usr on usr.id=u.user_id order by u.at desc limit 15`)).rows;
  const c = (await q(`select (select count(*)::int from ginee_orders) ginee,(select count(*)::int from revota_lines) revota,(select count(*)::int from dana_lines) dana`)).rows[0];
  const today = (await q(`select to_char(${WIB},'YYYY-MM-DD') d`)).rows[0].d;
  return { last, revota_days: days, history: hist, counts: c, today };
}
