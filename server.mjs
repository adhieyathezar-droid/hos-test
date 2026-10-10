// Server Node biasa: menyajikan halaman (public/) dan meneruskan /api/* ke handler yang sama dengan versi Netlify.
// Jalan di hosting mana pun yang bisa menjalankan Node (Render, Railway, VPS, Docker).
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import handler from './netlify/functions/api.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' };
const MAX_BODY = 20 * 1024 * 1024;

export function createApp() {
  return http.createServer(async (req, res) => {
    try {
      const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0];
      const url = new URL(req.url, `${proto}://${req.headers.host}`);
      if (url.pathname.startsWith('/api/')) {
        const chunks = []; let size = 0;
        for await (const c of req) { size += c.length; if (size > MAX_BODY) { res.writeHead(413, { 'content-type': 'application/json' }); return res.end('{"error":"File terlalu besar"}'); } chunks.push(c); }
        const hasBody = !['GET', 'HEAD'].includes(req.method);
        const r = await handler(new Request(url, { method: req.method, headers: req.headers, body: hasBody ? Buffer.concat(chunks) : undefined }));
        const h = {}; r.headers.forEach((v, k) => { if (k !== 'set-cookie') h[k] = v; });
        const sc = r.headers.getSetCookie?.(); if (sc?.length) h['set-cookie'] = sc;
        res.writeHead(r.status, h); return res.end(Buffer.from(await r.arrayBuffer()));
      }
      let p = decodeURIComponent(url.pathname); if (p.endsWith('/')) p += 'index.html';
      const file = path.join(root, path.normalize(p));
      if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
      const data = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'same-origin' });
      res.end(data);
    } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'EISDIR') { res.writeHead(404); return res.end('Tidak ditemukan'); }
      console.error(e); res.writeHead(500); res.end('Kesalahan server');
    }
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = process.env.PORT || 8888;
  createApp().listen(port, () => console.log('Server jalan di port ' + port));
}
