/*
 * 美図決算：毎日の取り込み
 * TDnet（東証の適時開示）の一覧から決算短信のXBRLを取り、図に使う数字だけを
 * data/companies/<銘柄コード>.json に保存する。ファイルそのものは保存しない。
 *
 * 使い方: node fetch.js                  … 今日と昨日（日本時間）
 *         node fetch.js 20261001 20261031 … 期間を指定
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const { unzipSync, strFromU8 } = require('fflate');
const { DOMParser } = require('@xmldom/xmldom');

global.TanshinParser = require('../engine/parser.js');
const TP = global.TanshinParser;
const K = require('../engine/kessan.js');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const COS = path.join(DATA, 'companies');
const BASE = 'https://www.release.tdnet.info/inbs/';
const UA = 'BizKessan/0.1 (+https://github.com/HIKICHICompany/BizKessan; up to 11 times a day, new filings only)';
const WAIT_MS = 1000; // TDnetへの負担を抑える：1件ごとに1秒あける

class DP { parseFromString(t, m) { return new DOMParser({ onError() {} }).parseFromString(t, m); } }
const sleep = ms => new Promise(r => setTimeout(r, ms));

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': UA } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    }).on('error', reject).setTimeout(60000, function () { this.destroy(new Error('timeout')); });
  });
}

function jstDate(d) { const j = new Date(d.getTime() + 9 * 3600e3); return j.toISOString().slice(0, 10).replace(/-/g, ''); }
function days(from, to) {
  const out = []; let d = new Date(from.slice(0, 4) + '-' + from.slice(4, 6) + '-' + from.slice(6) + 'T00:00:00Z');
  const end = new Date(to.slice(0, 4) + '-' + to.slice(4, 6) + '-' + to.slice(6) + 'T00:00:00Z');
  while (d <= end) { out.push(d.toISOString().slice(0, 10).replace(/-/g, '')); d = new Date(d.getTime() + 864e5); }
  return out;
}
const z2h = s => s.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
const readJSON = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return d; } };

// 銘柄コード → 正式な社名（EDINETの公開名簿から作った一覧）
const NAMES = {};
readJSON(path.join(ROOT, 'app', 'companies.json'), []).forEach(c => { NAMES[c[0].slice(0, 4)] = c[1]; });

async function listDay(ymd) {
  const rows = [];
  for (let p = 1; p < 30; p++) {
    const url = BASE + 'I_list_' + String(p).padStart(3, '0') + '_' + ymd + '.html';
    const r = await get(url);
    if (p === 1) console.log('  一覧', ymd, 'TDnetの応答', r.status);
    if (r.status !== 200 && r.status !== 404) throw new Error('TDnetに届きません（応答 ' + r.status + '）');
    if (r.status !== 200) break;
    const h = r.body.toString('utf8');
    const trs = h.split('<tr>').slice(1);
    let n = 0;
    trs.forEach(tr => {
      const code = (tr.match(/kjCode" noWrap>([0-9A-Z]{4,5})</) || [])[1];
      if (!code) return;
      n++;
      const name = ((tr.match(/kjName" noWrap>([^<]*)</) || [])[1] || '').trim();
      const t = tr.match(/kjTitle"[^>]*><a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
      const zip = (tr.match(/href="([^"]+\.zip)"/) || [])[1];
      const time = ((tr.match(/kjTime" noWrap>([^<]*)</) || [])[1] || '').trim();
      if (!t || !zip) return;
      const title = t[2].replace(/[\s　]+/g, ' ').trim();
      if (!/決算短信/.test(title)) return;
      rows.push({ code, name, title, zip, time, ymd });
    });
    if (!n || !/pager-R" onClick="pager\('I_list_/.test(h)) break;
    await sleep(WAIT_MS);
  }
  return rows;
}

function periodOf(files, title) {
  const d = TP._collect(files, DP);
  const t = z2h(title || '');
  let fye = (d.summary.FiscalYearEnd || '').slice(0, 10);
  // 訂正のお知らせなどサマリーがない開示は、題名の「2026年12月期 第2四半期」から期を読む
  const tm = t.match(/(\d{4})年\s*(\d{1,2})月期/);
  if (!/^\d{4}-\d{2}/.test(fye) && tm) fye = tm[1] + '-' + String(tm[2]).padStart(2, '0');
  if (!/^\d{4}-\d{2}/.test(fye)) {
    // 変則決算などで決算期の欄がないとき：当期の終わり（CurrentYear…）の日付を使う
    const c = d.contexts.CurrentYearInstant || d.contexts.CurrentYearDuration;
    fye = c ? (c.instant || c.end || '') : '';
    if (!fye) {
      // それもなければ、当期の文脈のうち一番遅い日付
      Object.keys(d.contexts).filter(k => /^Current/.test(k)).forEach(k => { const x = d.contexts[k], v = x.instant || x.end || ''; if (v > fye) fye = v; });
    }
  }
  const qf = d.facts.find(f => f.summary && /_QuarterlyPeriod$/.test(f.concept));
  let q = qf ? qf.value : 4;
  if (!qf) { const m = (z2h(d.summary.DocumentName || '') || t).match(/第\s*([1-3])\s*四半期/) || t.match(/第\s*([1-3])\s*四半期/); if (m) q = +m[1]; }
  // 訂正のお知らせは、題名に書かれた「どの期の短信の訂正か」を正とする
  if (/訂正/.test(t) && tm) {
    fye = tm[1] + '-' + String(tm[2]).padStart(2, '0');
    const qm = t.match(/第\s*([1-3])\s*四半期/); q = qm ? +qm[1] : 4;
  }
  return { fye, q, company: d.summary.CompanyName || '' };
}

function fyLabel(fye) { const m = fye.match(/^(\d{4})-(\d{2})/); return m ? m[1] + '年' + (+m[2]) + '月期' : ''; }
function qLabel(q) { return q === 4 ? '通期' : q === 2 ? '第2四半期（中間期）' : '第' + q + '四半期'; }

// 目次：アプリが「データがある銘柄」を知るため（銘柄ごとのファイルから作り直す）
function writeIndex() {
  const index = {};
  fs.readdirSync(COS).filter(f => f.endsWith('.json')).forEach(f => {
    const co = readJSON(path.join(COS, f), null); if (!co || !co.docs.length) return;
    const top = pickLatest(co.docs);
    // [社名, 期の表示, 種類（短信/有報）, 開示日時, 決算期末, 四半期]
    index[co.code] = [co.name, top ? top.label : '', top ? top.kind : '', top ? top.disclosed : '', top ? top.fye : '', top ? top.q : 4];
  });
  fs.writeFileSync(path.join(DATA, 'index.json'), JSON.stringify({ updated: new Date().toISOString(), companies: index }));
  return Object.keys(index).length;
}

async function main() {
  // --index-only：目次だけを作り直す（ほかの取り込みと重なったあとに、食い違いをなくすため）
  if (process.argv.includes('--index-only')) { console.log('目次を作り直しました：', writeIndex(), '社'); return; }
  // --redo を付けると、取り込み済みの開示も読み直して上書きする（今ある数字は消さない）
  const redo = process.argv.includes('--redo');
  const args = process.argv.slice(2).filter(a => /^\d{8}$/.test(a));
  const [from, to] = args.length === 2 ? args : [jstDate(new Date(Date.now() - 864e5)), jstDate(new Date())];
  fs.mkdirSync(COS, { recursive: true });
  const seenPath = path.join(DATA, 'processed.json');
  const seen = new Set(readJSON(seenPath, []));
  let added = 0, failed = 0;
  for (const ymd of days(from, to)) {
    const rows = await listDay(ymd);
    if (!rows.length) continue;
    console.log(ymd, '決算短信', rows.length, '件');
    for (const r of rows) {
      if (seen.has(r.zip) && !redo) continue;
      await sleep(WAIT_MS);
      let files;
      try {
        const z = await get(BASE + r.zip);
        if (z.status !== 200) { console.log('  取得できず', r.code, z.status); failed++; continue; }
        const u = unzipSync(new Uint8Array(z.body)); files = {};
        for (const k in u) if (/\.(htm|xml)$/i.test(k)) files[k] = strFromU8(u[k]);
      } catch (e) { console.log('  取得できず', r.code, e.message); failed++; continue; }
      const code4 = r.code.slice(0, 4);
      const date = ymd.slice(0, 4) + '年' + (+ymd.slice(4, 6)) + '月' + (+ymd.slice(6)) + '日';
      const meta = { name: NAMES[code4] || r.name, code: code4, title: r.title, date };
      let per, pl, bs;
      try { per = periodOf(files, r.title); } catch (e) { per = { fye: '', q: 4 }; }
      try { pl = K.extractPL(files, DP, meta); } catch (e) { pl = { ok: false, reason: '読み取りで問題が起きました' }; }
      try { bs = K.extractBS(files, DP, meta); } catch (e) { bs = { ok: false, reason: '読み取りで問題が起きました' }; }
      if (!per.fye) { const m = z2h(r.title).match(/(\d{4})年\s*(\d{1,2})月期/); if (m) per.fye = m[1] + '-' + String(m[2]).padStart(2, '0'); }
      const doc = {
        id: r.zip.replace(/\.zip$/, ''), kind: 'tanshin', fye: per.fye.slice(0, 7), q: per.q,
        label: fyLabel(per.fye) + ' ' + qLabel(per.q), title: r.title, disclosed: ymd + (r.time ? ' ' + r.time : ''),
        pl: pl.ok ? pl : { ok: false, reason: pl.reason },
        bs: bs.ok ? bs : { ok: false, reason: bs.reason }
      };
      // 損益の model（中間データ）は保存しない：図に使う数字だけ
      if (doc.pl.model) delete doc.pl.model;
      const p = path.join(COS, code4 + '.json');
      const co = readJSON(p, { code: code4, name: meta.name, docs: [] });
      co.name = meta.name;
      // 同じ期・同じ種類なら新しい開示（訂正を含む）で置き換える
      co.docs = co.docs.filter(d => d.id !== doc.id && !(d.kind === doc.kind && d.fye === doc.fye && d.q === doc.q && d.disclosed <= doc.disclosed));
      if (!co.docs.some(d => d.kind === doc.kind && d.fye === doc.fye && d.q === doc.q)) co.docs.push(doc);
      co.docs.sort((a, b) => (b.fye + b.q).localeCompare(a.fye + a.q) || (a.kind === 'yuho' ? -1 : 1));
      co.updated = new Date().toISOString();
      fs.writeFileSync(p, JSON.stringify(co));
      seen.add(r.zip); added++;
      if (!pl.ok || !bs.ok) failed++;
    }
    fs.writeFileSync(seenPath, JSON.stringify([...seen]));
  }
  const nIndex = writeIndex();
  console.log('追加', added, '件／一部読めず', failed, '件／銘柄数', Object.keys(index).length);
}

// 最新の期を選ぶ：期が新しいものを優先。同じ期なら有報を短信より優先
function pickLatest(docs) {
  return docs.slice().sort((a, b) => (b.fye + b.q).localeCompare(a.fye + a.q) || (a.kind === 'yuho' ? -1 : b.kind === 'yuho' ? 1 : 0))[0];
}

main().catch(e => { console.error(e); process.exit(1); });
