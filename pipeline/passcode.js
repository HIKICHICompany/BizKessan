/*
 * 今月（または指定の月）の合言葉を出す。関所（worker/src/index.js）と同じ作り方。
 * 使い方: PASS_SECRET=... node passcode.js [2026-12]
 */
'use strict';
const crypto = require('crypto');
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function passcode(secret, ym) {
  const b = crypto.createHmac('sha256', secret).update('code:' + ym).digest();
  let s = ''; for (let i = 0; i < 6; i++) s += ALPHA[b[i] % 32];
  return s;
}
const secret = process.env.PASS_SECRET;
if (!secret) { console.error('PASS_SECRET がありません'); process.exit(1); }
const ym = process.argv[2] || new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 7);
console.log(passcode(secret, ym));
