/*
 * 美図決算：合言葉の関所
 * ・画面（app/）はそのまま出す
 * ・数字（data/）のうち、日経225の会社と目次は誰でも見られる（お試し）
 * ・それ以外の会社の数字は、月替わりの合言葉で受け取った「通行証」がある人だけに渡す
 * 合言葉は毎月1日（日本時間）に切り替わる。切り替え後7日間は前の月の合言葉・通行証も通す。
 */
const GRACE_DAYS = 7;
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 見間違えやすい I O 0 1 は使わない

const enc = new TextEncoder();
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}
const hex = b => [...b].map(x => x.toString(16).padStart(2, '0')).join('');

// 日本時間の年月と日
function jstNow(d = new Date()) {
  const j = new Date(d.getTime() + 9 * 3600e3);
  return { ym: j.toISOString().slice(0, 7), day: j.getUTCDate() };
}
function prevYm(ym) {
  let [y, m] = ym.split('-').map(Number); m -= 1; if (m === 0) { m = 12; y -= 1; }
  return y + '-' + String(m).padStart(2, '0');
}
// 今使える月（今月と、月初7日間は先月も）
function validMonths(now = jstNow()) { return now.day <= GRACE_DAYS ? [now.ym, prevYm(now.ym)] : [now.ym]; }

export async function passcode(secret, ym) {
  const b = await hmac(secret, 'code:' + ym);
  let s = ''; for (let i = 0; i < 6; i++) s += ALPHA[b[i] % 32];
  return s;
}
async function tokenFor(secret, ym) { return ym + '.' + hex(await hmac(secret, 'tok:' + ym)).slice(0, 32); }
async function tokenOk(secret, tok) {
  if (!tok) return false;
  const ym = tok.split('.')[0];
  if (!validMonths().includes(ym)) return false;
  return tok === await tokenFor(secret, ym);
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Biz-Token',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS } });
}

let n225Cache = null, n225At = 0;
async function n225(env, req) {
  if (n225Cache && Date.now() - n225At < 3600e3) return n225Cache;
  try {
    const r = await env.ASSETS.fetch(new URL('/data/meta/market.json', req.url));
    const m = await r.json(); n225Cache = new Set(m.n225 || []); n225At = Date.now();
  } catch (e) { n225Cache = new Set(); }
  return n225Cache;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url), p = url.pathname;
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const SECRET = env.PASS_SECRET;

    if (p === '/api/login' && req.method === 'POST') {
      if (!SECRET) return json({ ok: false, msg: '準備中です' }, 503);
      let code = '';
      try { code = String((await req.json()).code || ''); } catch (e) { }
      code = code.normalize('NFKC').toUpperCase().replace(/[^A-Z0-9]/g, '');
      for (const ym of validMonths()) {
        if (code && code === await passcode(SECRET, ym)) return json({ ok: true, token: await tokenFor(SECRET, ym), month: ym });
      }
      await new Promise(r => setTimeout(r, 800)); // 総当たりを遅くする
      return json({ ok: false, msg: '合言葉がちがいます' }, 401);
    }
    if (p === '/api/check') {
      return json({ ok: await tokenOk(SECRET, req.headers.get('X-Biz-Token')) });
    }

    if (p.startsWith('/data/')) {
      const m = p.match(/^\/data\/companies\/([0-9A-Z]{4})\.json$/);
      if (m) {
        const free = (await n225(env, req)).has(m[1]);
        if (!free && !(await tokenOk(SECRET, req.headers.get('X-Biz-Token')))) {
          return json({ locked: true, msg: 'この会社はメンバー特典です。合言葉を入れると見られます。' }, 401);
        }
      } else if (!/^\/data\/(index\.json|meta\/[\w.-]+\.json)$/.test(p)) {
        return json({ msg: 'ありません' }, 404);
      }
      const r = await env.ASSETS.fetch(req);
      const h = new Headers(r.headers); Object.entries(CORS).forEach(([k, v]) => h.set(k, v));
      h.set('Cache-Control', m ? 'private, no-store' : 'public, max-age=300');
      return new Response(r.body, { status: r.status, headers: h });
    }
    return env.ASSETS.fetch(req);
  },
};
