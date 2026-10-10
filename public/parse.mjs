// Parser bersama: dipakai browser (sebelum kirim) dan tes. Tidak bergantung pada library apa pun.
export const REQ = {
  ginee: ['Order ID', 'Status', 'Create Time'],
  revota: ['orderNo', 'dateTrans', 'Nett'],
  shopee: ['No. Pesanan', 'Total Penghasilan', 'Tanggal Dana Dilepaskan'],
  tiktok: ['ID Pesanan/Penyesuaian', 'Jumlah penyelesaian pembayaran', 'Waktu pembayaran pesanan'],
};
export const KIND_NAME = { ginee: 'Ginee', revota: 'Revota', shopee: 'Dana Shopee', tiktok: 'Dana TikTok' };
const p2 = (n) => String(n).padStart(2, '0');
const fmt = (y, mo, d, h, mi) => `${y}-${p2(mo)}-${p2(d)} ${p2(h)}:${p2(mi)}`;

export function iso(v) {
  if (v == null || v === '') return '';
  if (v instanceof Date) {
    const x = new Date(v.getTime() + 30000); // bulatkan ke menit terdekat (selisih detik dari Excel)
    return fmt(x.getFullYear(), x.getMonth() + 1, x.getDate(), x.getHours(), x.getMinutes());
  }
  if (typeof v === 'number') {
    const ms = Math.round((v - 25569) * 86400 * 1000) + 30000;
    const x = new Date(ms);
    return fmt(x.getUTCFullYear(), x.getUTCMonth() + 1, x.getUTCDate(), x.getUTCHours(), x.getUTCMinutes());
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{2})[-\/](\d{2})[-\/](\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (m) return fmt(m[3], m[2], m[1], m[4] || 0, m[5] || 0);
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?/);
  return m ? fmt(m[1], m[2], m[3], m[4] || 0, m[5] || 0) : '';
}

// sheets: array of array-of-arrays (satu per sheet). Mengembalikan {kind, rows} atau null.
export function detect(sheets) {
  for (const aoa of sheets) {
    for (let i = 0; i < Math.min(aoa.length, 20); i++) {
      const hd = (aoa[i] || []).map((x) => (x == null ? '' : String(x).trim()));
      for (const k of Object.keys(REQ)) {
        if (REQ[k].every((c) => hd.includes(c))) {
          const rows = [];
          for (let r = i + 1; r < aoa.length; r++) {
            const o = {};
            hd.forEach((h, j) => { if (h) o[h] = aoa[r][j]; });
            rows.push(o);
          }
          return { kind: k, rows };
        }
      }
    }
  }
  return null;
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

export function parseRecords(kind, rows) {
  if (kind === 'ginee') {
    const by = new Map(); let cur = null;
    for (const r of rows) {
      const id = r['Order ID'];
      if (id != null && String(id).trim() !== '') {
        const key = String(id).trim();
        if (by.has(key)) { by.get(key).qty += Math.round(num(r['Qty'])); cur = by.get(key); continue; } // Order ID dobel (mis. Lazada): digabung
        cur = { order_id: key, channel: String(r['Channel'] || ''), status: String(r['Status'] || ''),
          created_at: iso(r['Create Time']), qty: Math.round(num(r['Qty'])), subtotal: num(r['Subtotal']),
          total: num(r['Total']), refund: num(r['Return Refund Amount']), cancel_reason: String(r['Cancel Reason'] || '').slice(0, 80) };
        by.set(key, cur);
      } else if (cur) cur.qty += Math.round(num(r['Qty']));
    }
    return [...by.values()].filter((o) => o.created_at);
  }
  if (kind === 'revota') {
    const g = {};
    return rows.filter((r) => r.orderNo != null && r.dateTrans).map((r) => {
      const o = String(r.orderNo).trim();
      const b = `${r.noTrans ?? ''}|${o}|${r.sku ?? r.productCode ?? r.kodeBarang ?? r.itemCode ?? r.barcode ?? ''}`;
      g[b] = (g[b] || 0) + 1;
      return { line_key: `${b}#${g[b]}`, order_no: o, trans_date: iso(r.dateTrans), qty: Math.round(num(r.qty)),
        nett: num(r.Nett), channel: String(r.channelSales || ''), is_ref: !!(r.referenceTrans && r.referenceTrans !== '-') };
    }).filter((r) => r.trans_date);
  }
  const sp = kind === 'shopee', g = {};
  const A = sp ? ['No. Pesanan', 'Tanggal Dana Dilepaskan', 'Total Penghasilan'] : ['ID Pesanan/Penyesuaian', 'Waktu pembayaran pesanan', 'Jumlah penyelesaian pembayaran'];
  return rows.filter((r) => r[A[0]] != null && String(r[A[0]]).trim() !== '').map((r) => {
    const o = String(r[A[0]]).trim(), jt = sp ? '' : String(r['Jenis transaksi'] || '');
    const b = `${sp ? 'S' : 'T'}|${o}|${jt}`; g[b] = (g[b] || 0) + 1;
    return { line_key: `${b}#${g[b]}`, order_no: o, platform: sp ? 'Shopee' : 'TikTok', paid_at: iso(r[A[1]]), amount: num(r[A[2]]) };
  }).filter((r) => r.paid_at);
}
