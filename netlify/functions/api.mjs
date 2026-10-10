import { init, db, HttpError, login, signToken, userFromReq, hashPw, ingest, status, ROLE_KINDS, ROLE_NAME } from './_core.mjs';

export const config = { path: '/api/*' };
const json = (status, obj, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });
const pub = (u) => ({ id: u.id, username: u.username, name: u.name, role: u.role, roleName: ROLE_NAME[u.role], kinds: ROLE_KINDS[u.role] });
const ROLES = ['sales', 'ops', 'finance', 'admin'];

export default async function handler(req) {
  try {
    await init();
    const url = new URL(req.url), path = url.pathname.replace(/^\/api\/?/, ''), m = req.method;
    if (m !== 'GET') {
      const o = req.headers.get('origin');
      if (o && new URL(o).host !== url.host) throw new HttpError(403, 'Asal permintaan tidak valid');
      if (!(req.headers.get('content-type') || '').includes('application/json')) throw new HttpError(415, 'Content-Type harus application/json');
    }
    const body = m === 'GET' ? {} : await req.json().catch(() => ({}));

    if (path === 'login' && m === 'POST') {
      const u = await login(body.username, body.password);
      const secure = url.protocol === 'https:' ? '; Secure' : '';
      return json(200, { user: pub(u) }, { 'set-cookie': `sid=${signToken(u.id)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure}` });
    }
    if (path === 'logout' && m === 'POST') return json(200, { ok: true }, { 'set-cookie': 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });

    const user = await userFromReq(req);
    if (!user) throw new HttpError(401, 'Belum login');
    if (path === 'me') return json(200, { user: pub(user) });
    if (path === 'status') return json(200, await status());

    const up = path.match(/^upload\/(ginee|revota|shopee|tiktok)$/);
    if (up && m === 'POST') return json(200, await ingest(user, up[1], body, url.searchParams.get('commit') === '1'));

    if (path.startsWith('users')) {
      if (user.role !== 'admin') throw new HttpError(403, 'Hanya Admin');
      const q = db().query.bind(db());
      if (path === 'users' && m === 'GET') return json(200, { users: (await q('select id,username,name,role,active,created_at from users order by id')).rows });
      if (path === 'users' && m === 'POST') {
        const { username, name, role, password } = body;
        if (!/^[a-z0-9._-]{3,30}$/i.test(username || '') || !ROLES.includes(role) || !name || String(password || '').length < 8) throw new HttpError(400, 'Data tidak valid (username 3-30 karakter, sandi min. 8 karakter, peran valid)');
        try { await q('insert into users(username,name,role,pass_hash) values($1,$2,$3,$4)', [username, String(name).slice(0, 60), role, await hashPw(password)]); }
        catch { throw new HttpError(409, 'Username sudah dipakai'); }
        return json(200, { ok: true });
      }
      const pm = path.match(/^users\/(\d+)$/);
      if (pm && m === 'PATCH') {
        const id = +pm[1];
        if (id === user.id && (body.active === false || (body.role && body.role !== 'admin'))) throw new HttpError(400, 'Tidak bisa menonaktifkan atau menurunkan akun sendiri');
        if (body.role && ROLES.includes(body.role)) await q('update users set role=$2 where id=$1', [id, body.role]);
        if (typeof body.active === 'boolean') await q('update users set active=$2 where id=$1', [id, body.active]);
        if (body.password) { if (String(body.password).length < 8) throw new HttpError(400, 'Sandi min. 8 karakter'); await q('update users set pass_hash=$2, failed=0, locked_until=null where id=$1', [id, await hashPw(body.password)]); }
        return json(200, { ok: true });
      }
    }
    throw new HttpError(404, 'Tidak ditemukan');
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { error: e.message });
    console.error(e);
    return json(500, { error: 'Terjadi kesalahan di server' });
  }
}
