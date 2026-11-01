/*
 * 美図決算：銘柄の区分（週1回）
 *  - 東証の上場銘柄一覧（data_j.xlsx）から 市場区分（プライム・スタンダード・グロース）と33業種
 *  - 日経の公式ファイル（日経平均のウエート一覧）から 日経225の構成銘柄
 *    ファイルの日付より後に入れ替えがあれば data/meta/n225_changes.json の内容を反映する
 * 結果は data/meta/market.json（証券コード → 区分）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const { unzipSync, strFromU8 } = require('fflate');

const META = path.join(__dirname, '..', 'data', 'meta');
const OUT = path.join(META, 'market.json');
const UA = 'Mozilla/5.0 (compatible; BizKessan/0.1; weekly)';
const JPX = 'https://www.jpx.co.jp/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_j.xlsx';
const NIKKEI = 'https://indexes.nikkei.co.jp/nkave/archives/file/nikkei_stock_average_weight_jp.csv';

function get(url) {
  return new Promise((res, rej) => {
    https.get(url, { headers: { 'User-Agent': UA } }, r => {
      const b = []; r.on('data', c => b.push(c)); r.on('end', () => res({ status: r.statusCode, body: Buffer.concat(b) }));
    }).on('error', rej);
  });
}

// xlsx を最小限に読む（共有文字列と1枚目のシート）
function readXlsx(buf) {
  const z = unzipSync(new Uint8Array(buf));
  const ss = [];
  const sst = z['xl/sharedStrings.xml'] ? strFromU8(z['xl/sharedStrings.xml']) : '';
  (sst.match(/<si>[\s\S]*?<\/si>/g) || []).forEach(si => {
    ss.push((si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || []).map(t => t.replace(/<[^>]+>/g, '')).join('')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
  });
  const sheet = strFromU8(z['xl/worksheets/sheet1.xml']);
  const rows = [];
  (sheet.match(/<row[\s\S]*?<\/row>/g) || []).forEach(row => {
    const cells = {};
    (row.match(/<c [^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) || []).forEach(c => {
      const ref = (c.match(/r="([A-Z]+)\d+"/) || [])[1];
      const t = (c.match(/ t="([^"]+)"/) || [])[1];
      let v = (c.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      if (v === undefined) { const is = c.match(/<t[^>]*>([\s\S]*?)<\/t>/); v = is ? is[1] : ''; }
      cells[ref] = t === 's' ? ss[+v] : v;
    });
    rows.push(cells);
  });
  return rows;
}

const SEG = { 'プライム（内国株式）': 'P', 'スタンダード（内国株式）': 'S', 'グロース（内国株式）': 'G',
  'プライム（外国株式）': 'P', 'スタンダード（外国株式）': 'S', 'グロース（外国株式）': 'G', 'PRO Market': 'PRO' };

async function main() {
  const force = process.argv.includes('--force');
  fs.mkdirSync(META, { recursive: true });
  let old = null; try { old = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) { /* はじめて */ }
  if (!force && old && Date.now() - Date.parse(old.updated) < 6 * 864e5) { console.log('区分は6日以内に更新済み'); return; }

  const out = { updated: new Date().toISOString(), seg: {}, sector: {}, n225: [], sources: {} };

  const j = await get(JPX);
  if (j.status !== 200) throw new Error('東証の上場銘柄一覧に届きません（' + j.status + '）');
  const rows = readXlsx(j.body);
  const head = rows[0];
  const col = name => Object.keys(head).find(k => head[k] === name);
  const cCode = col('コード'), cSeg = col('市場・商品区分'), cSec = col('33業種区分'), cDate = col('日付');
  rows.slice(1).forEach(r => {
    const code = String(r[cCode] || '').trim().toUpperCase(); const seg = SEG[r[cSeg]];
    if (!code || !seg) return;
    out.seg[code] = seg;
    if (r[cSec] && r[cSec] !== '-') out.sector[code] = r[cSec];
  });
  out.sources.jpx = String(rows[1] && rows[1][cDate] || '');

  const n = await get(NIKKEI);
  if (n.status !== 200) throw new Error('日経の構成銘柄ファイルに届きません（' + n.status + '）');
  const csv = new TextDecoder('shift_jis').decode(n.body);
  let fileDate = '';
  const set = new Set();
  csv.split(/\r?\n/).forEach(line => {
    const f = line.split(',').map(x => x.replace(/^"|"$/g, ''));
    if (f.length > 2 && /^[0-9][0-9A-Z]{3}$/.test(f[1])) { set.add(f[1]); fileDate = f[0].replace(/\//g, '-'); }
  });
  // ファイルの日付より後の入れ替えを反映（日経の発表をもとに手で記録）
  let changes = []; try { changes = JSON.parse(fs.readFileSync(path.join(META, 'n225_changes.json'), 'utf8')); } catch (e) { /* なし */ }
  changes.filter(c => c.effective > fileDate).forEach(c => { c.del.forEach(x => set.delete(x)); c.add.forEach(x => set.add(x)); });
  out.n225 = [...set].sort();
  out.sources.nikkei = fileDate;
  if (out.n225.length !== 225) console.log('注意：日経225の銘柄数が', out.n225.length);

  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log('区分', Object.keys(out.seg).length, '銘柄／日経225', out.n225.length, '銘柄（日経ファイル', fileDate, '）');
}
main().catch(e => { console.error(e.message); process.exit(1); });
