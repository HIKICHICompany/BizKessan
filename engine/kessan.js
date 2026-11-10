/*
 * 絵でみる決算 ― 「絵でみる儲けの流れ」（損益）と「絵でみるファイナンス」（貸借対照表）
 * 経営分析ツールのプロジェクトの形（sk.js と 貸借対照表の雛形）に合わせて、
 * 決算短信のXBRLから数字を取り出し、SVGの文字列を作る。
 */
(function (root) {
  'use strict';
  var TP = root.TanshinParser || (typeof require !== 'undefined' ? require('./parser.js') : null);

  function ln(c) { var i = c.lastIndexOf('_'); return i < 0 ? c : c.slice(i + 1); }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function cleanName(s) { return (s || '').replace(/株式会社|（株）/g, '').replace(/^\s+|\s+$/g, '').replace(/\s+/g, ' '); }

  /* ---------- 共通：事実を引く道具 ---------- */
  function tools(files, DP) {
    var data = TP._collect(files, DP);
    var att = data.facts.filter(function (f) { return !f.summary; });
    var unitScale = 0;
    att.forEach(function (f) { if (/NetSales|Revenue|Assets/.test(f.concept) && f.unit > 1) unitScale = Math.max(unitScale, f.unit); });
    var unit = unitScale >= 1e6 ? { div: 1e6, name: '百万円' } : unitScale >= 1e3 ? { div: 1e3, name: '千円' } : { div: 1, name: '円' };
    function plain(ctxId) { var c = data.contexts[ctxId]; return c && !c.members.length; }
    function val(names, ctx) {
      var re = new RegExp('^(' + names.join('|') + ')$');
      for (var i = 0; i < att.length; i++) { var f = att[i]; if (f.ctx === ctx && re.test(ln(f.concept))) return f.value; }
      return undefined;
    }
    function byMember(names, ctx) {
      // セグメントなど、次元付きの値：{member: value}
      var re = new RegExp('^(' + names.join('|') + ')$'), out = {};
      att.forEach(function (f) {
        if (!re.test(ln(f.concept))) return;
        var c = data.contexts[f.ctx]; if (!c || c.members.length !== 1) return;
        var base = data.contexts[ctx];
        if (!base || c.start !== base.start || c.end !== base.end || c.instant !== base.instant) return;
        var m = c.members[0].split(':').pop();
        if (out[m] === undefined) out[m] = f.value;
      });
      return out;
    }
    var title = (data.summary.DocumentName || '').replace(/\s+/g, ' ');
    return { data: data, att: att, unit: unit, val: val, byMember: byMember, plain: plain, summary: data.summary };
  }

  var SEG_SKIP = /^(ReportableSegments|TotalOfReportableSegmentsAndOthers|ReconcilingItems|EntityTotal|ConsolidatedOrNonConsolidated|CorporateAndEliminations|Elimination)/;

  /* ---------- セグメント：売上の内訳 ----------
   * 1) 報告セグメントの数字（タグ付き）。外部顧客への売上を優先し、なければ
   *    セグメントの売上からセグメント間の売上を引く。会社ごとに科目名が違うので幅広く拾う。
   * 2) 単一セグメントの会社で、製品・サービス別などの表（タグなし）があれば、それを内訳に使う。 */
  var SEG_NONSEG = /RetainedEarnings|Equity|Capital|Treasury|ComprehensiveIncome|NonControlling|Shareholders|ExchangeDifferences|FairValue|CashFlowHedge|Remeasurements|Subscription|Adjust|Adjsut/i;
  function segFiles(files) { return Object.keys(files).filter(function (n) { return /sg\d*-/i.test(n.split('/').pop()) && /ixbrl\.htm$/i.test(n); }); }
  function segmentsOf(T, files, cur, pri, c, p) {
    var sgSet = {}; segFiles(files).forEach(function (n) { sgSet[n] = 1; });
    var hasSg = Object.keys(sgSet).length > 0;
    function pick(re, ctx) {
      var out = {}, base = T.data.contexts[ctx]; if (!base) return out;
      T.att.forEach(function (f) {
        if (!re.test(ln(f.concept))) return;
        if (hasSg && !sgSet[f.file]) return;
        var x = T.data.contexts[f.ctx]; if (!x || x.members.length !== 1) return;
        if (x.start !== base.start || x.end !== base.end) return;
        var mm = x.members[0].split(':').pop();
        if (SEG_SKIP.test(mm) || SEG_NONSEG.test(mm)) return;
        if (out[mm] === undefined) out[mm] = f.value;
      });
      return out;
    }
    var EXT = /^(RevenuesFromExternalCustomers|RevenueFromExternalCustomers|SalesToExternalCustomers|NetSalesToExternalCustomers|OperatingRevenueFromExternalCustomers|RevenuesFromExternalCustomersIFRS|RevenueFromExternalCustomersIFRS|SalesToExternalCustomersIFRS)$/;
    var TOT = /^(NetSales|NetSalesIFRS|Revenue|Revenues|Revenue\d*IFRS|RevenueIFRS|OperatingRevenue\d*|NetSalesOfCompletedConstructionContracts|OperatingRevenueIFRS|SalesRevenueIFRS)$/;
    var INTER = /^(IntersegmentSales|IntersegmentSalesOrTransfers|IntersegmentSalesIFRS|TransactionsWithOtherSegments|InterSegmentRevenue\w*)$/;
    var PROF = /^(SegmentProfitLoss|SegmentProfitLossIFRS|SegmentIncome|OperatingIncome|OperatingIncomeLoss|OperatingProfitLossIFRS|OrdinaryIncome|ProfitLossAttributableToOwnersOfParentIFRS|ProfitLossAttributableToOwnersOfParent)$/;
    function sales(ctx) {
      if (!ctx) return {};
      var e = pick(EXT, ctx); if (Object.keys(e).length) return e;
      var t = pick(TOT, ctx), i = pick(INTER, ctx);
      Object.keys(t).forEach(function (k) { if (i[k] !== undefined) t[k] -= i[k]; });
      return t;
    }
    function profit(ctx) {
      if (!ctx) return {};
      // 利益の科目が複数あるときは、セグメント利益を先に使う
      var order = ['SegmentProfitLoss', 'SegmentProfitLossIFRS', 'SegmentIncome', 'OperatingIncome', 'OperatingIncomeLoss', 'OperatingProfitLossIFRS', 'OrdinaryIncome', 'ProfitLossAttributableToOwnersOfParentIFRS', 'ProfitLossAttributableToOwnersOfParent'];
      for (var i = 0; i < order.length; i++) { var o = pick(new RegExp('^' + order[i] + '$'), ctx); if (Object.keys(o).length) return o; }
      return {};
    }
    function label(k) {
      var l = T.data.memberLabels[k] || (/OperatingSegmentsNotIncluded|Others?Member$/.test(k) ? 'その他' : k.replace(/(ReportableSegments?)?Member$/, ''));
      l = l.replace(/セグメント$/, '').replace(/^報告セグメント[・\s]*/, '');
      return /^Others?$/i.test(l) ? 'その他' : l;
    }
    var sc = sales(cur), sp = sales(pri), pc = profit(cur), pp = profit(pri);
    var segs = Object.keys(sc).filter(function (k) { return sc[k] > 0; }).map(function (k) {
      return { name: label(k), sales: sc[k], salesPrev: sp[k], profit: pc[k] !== undefined ? pc[k] : null, profitPrev: pp[k] };
    });
    segs.sort(function (a, b) { return b.sales - a.sales; });
    var sum = segs.reduce(function (a, b) { return a + b.sales; }, 0);
    if (segs.length >= 2 && sum <= c.rev * 1.001 && sum >= c.rev * 0.5) {
      var rest = c.rev - sum, note = null;
      // 図に並べるのは最大7つまで。多いときは小さいものを「その他」にまとめる
      var cap = rest > c.rev * 0.001 ? 6 : 7;
      if (segs.length > cap) {
        var keep = segs.filter(function (s) { return s.name !== 'その他'; }).slice(0, cap - 1);
        var rem = segs.filter(function (s) { return keep.indexOf(s) < 0; });
        var add = function (f) { return rem.every(function (s) { return s[f] != null; }) ? rem.reduce(function (a, s) { return a + s[f]; }, 0) : (f === 'profit' ? null : undefined); };
        segs = keep.concat([{ name: 'その他', sales: add('sales'), salesPrev: add('salesPrev'), profit: add('profit'), profitPrev: add('profitPrev') }]);
        note = 'その他には小さいセグメント（' + rem.filter(function (s) { return s.name !== 'その他'; }).map(function (s) { return s.name; }).join('、') + '）を含む';
      }
      if (rest > c.rev * 0.001) {
        var sumP = Object.keys(sp).reduce(function (a, k) { return a + (sp[k] > 0 ? sp[k] : 0); }, 0);
        segs.push({ name: '調整額など', sales: rest, salesPrev: p.rev !== undefined && sumP ? p.rev - sumP : undefined, profit: null });
      }
      if (segs.some(function (s) { return s.profit !== null; })) note = (note ? note + '。' : '') + 'セグメントの利益率はセグメント利益ベース（全社費用などの調整前）';
      return { segs: segs, note: note };
    }
    // 単一セグメント：事業の名前と、製品別などの表を探す
    var text = '', html = '';
    segFiles(files).forEach(function (n) { html += files[n]; });
    text = html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&#160;|&nbsp;/g, ' ').replace(/\s+/g, '');
    var biz = (text.match(/[「『]?([^、。「」『』（）]{2,20}?)[」』]?の単一(の)?(事業)?セグメント/) || text.match(/セグメントは[「『]?([^、。「」『』]{2,20}?)[」』]?(単一|のみ)/) || [])[1];
    if (biz) biz = biz.replace(/^(当社グループ|当社|当グループ)(は|の)?/, '').replace(/^.*(は|、)/, '').replace(/のみ$/, '');
    var tb = tableBreakdown(html, c.rev, p.rev, T.unit);
    if (tb) {
      tb.items.forEach(function (it) { it.profit = null; });
      return { segs: tb.items, note: '単一セグメント' + (biz ? '（' + biz + '）' : '') + 'のため、' + (tb.title || '製品・サービス別') + 'の売上を表示' };
    }
    return { segs: [{ name: biz || '単一セグメント', sales: c.rev, salesPrev: p.rev, profit: null, single: true }],
      note: '単一セグメント' + (biz ? '（' + biz + '）' : '') + 'のため、売上の内訳は開示なし' };
  }

  // タグのない表から内訳を読む：「合計」の行が売上高と一致する表だけを使う
  function tableBreakdown(html, rev, revPrev, unit) {
    if (!html || !rev) return null;
    var txt = function (s) { return s.replace(/<[^>]+>/g, '').replace(/&#160;|&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim(); };
    var num = function (s) { var t = s.replace(/[,，\s]/g, '').replace(/^△|^▲|^-|^－/, '-'); return /^-?\d+(\.\d+)?$/.test(t) ? parseFloat(t) : null; };
    var tables = html.split(/<table/i).slice(1), before = html.split(/<table/i);
    for (var ti = 0; ti < tables.length; ti++) {
      var tHtml = tables[ti].split(/<\/table>/i)[0];
      var pre = txt(before.slice(0, ti + 1).join(' ').slice(-1500));
      var mul = /単位[:：]\s*千円/.test(pre + txt(tHtml).slice(0, 80)) ? 1e3 : /単位[:：]\s*円/.test(pre) ? 1 : /単位[:：]\s*億円/.test(pre) ? 1e8 : 1e6;
      var rows = tHtml.split(/<tr/i).slice(1).map(function (r) {
        var cells = r.split(/<t[dh]/i).slice(1).map(function (x) { return txt('<' + x); });
        cells = cells.filter(function (x) { return x !== ''; });
        return { label: cells[0] || '', nums: cells.slice(1).map(num).filter(function (v) { return v !== null; }) };
      });
      var tot = -1, col = null;
      rows.forEach(function (r, i) {
        if (tot >= 0 || !/^(合計|計|売上(高|収益)合計|外部顧客への売上(高|収益))$/.test(r.label.replace(/\s/g, ''))) return;
        r.nums.forEach(function (v, j) { if (col === null && Math.abs(v * mul - rev) <= Math.max(rev * 0.002, mul)) { tot = i; col = j - r.nums.length; } });
      });
      if (tot < 0) continue;
      var colP = null, tr = rows[tot];
      if (revPrev) tr.nums.forEach(function (v, j) { if (j - tr.nums.length !== col && Math.abs(v * mul - revPrev) <= Math.max(revPrev * 0.002, mul)) colP = j - tr.nums.length; });
      var items = [];
      for (var i = 0; i < tot; i++) {
        var r = rows[i]; if (!r.label || r.nums.length < tr.nums.length) continue;
        var v = r.nums[r.nums.length + col]; if (!(v > 0)) continue;
        items.push({ name: r.label, sales: v * mul, salesPrev: colP === null ? undefined : r.nums[r.nums.length + colP] * mul });
      }
      var s = items.reduce(function (a, b) { return a + b.sales; }, 0);
      if (items.length < 2 || Math.abs(s - rev) > Math.max(rev * 0.002, mul * items.length)) continue;
      var title = (pre.match(/[（(]\d[）)]\s*([^（(）)]{2,24}?)に関する情報[^（(]*$/) || [])[1];
      title = title ? title.replace(/及び/, '・') + '別' : null;
      if (title) title = title.replace(/^製品・サービス別$/, '製品・サービス別');
      items.sort(function (a, b) { return b.sales - a.sales; });
      return { items: items, title: title };
    }
    return null;
  }

  /* ---------- 損益：sk.js の CONFIG と同じ形に組み立てる ---------- */
  /* ---------- 米国基準：タグのない財務諸表の表を読み、サマリーの数字と照らして合うときだけ使う ---------- */
  function isUS(files) { return Object.keys(files).some(function (n) { return /edus(sm|fr)/i.test(n); }); }
  function usTables(files, kind) {
    // kind: 'pl' | 'bs'。添付の該当ページの表を、行ごとに「科目名・前期・当期」に直す
    var re = new RegExp(kind + '\\d*-[^/]*ixbrl\\.htm$', 'i'), html = '';
    Object.keys(files).filter(function (n) { return /Attachment/i.test(n) && re.test(n.split('/').pop()); }).sort().forEach(function (n) { html += files[n]; });
    if (!html) return null;
    var txt = function (s) { return s.replace(/<[^>]+>/g, '').replace(/&#160;|&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim(); };
    var plainText = txt(html.replace(/<style[\s\S]*?<\/style>/gi, ''));
    var mul = /単位[^）)]{0,4}千円/.test(plainText) ? 1e3 : /単位[^）)]{0,4}億円/.test(plainText) ? 1e8 : /百万円/.test(plainText) ? 1e6 : 1e6;
    var rows = [];
    html.replace(/<style[\s\S]*?<\/style>/gi, '').split(/<tr[\s>]/i).slice(1).forEach(function (r) {
      var cells = r.split(/<\/tr>/i)[0].split(/<t[dh][\s>]/i).slice(1).map(function (c) { return txt('<' + c); }).filter(function (c) { return c !== ''; });
      var label = [], amts = [], paren = false, started = false;
      cells.forEach(function (c) {
        var t = c.replace(/[\s　]/g, '');
        var m = t.match(/^[(（]?([△▲\-－]?)([0-9,]+)[)）]?$/);
        if (/^[-－―]$/.test(t)) { started = true; amts.push(0); return; }
        if (m && (/,/.test(m[2]) || m[2].length >= 1) && !/\./.test(t)) {
          started = true; if (/^[(（]/.test(t)) paren = true;
          amts.push((m[1] ? -1 : 1) * parseInt(m[2].replace(/,/g, ''), 10) * mul); return;
        }
        if (/^[△▲\-]?[0-9]+\.[0-9]+%?$/.test(t)) { started = true; return; } // 割合の列はとばす
        if (!started) label.push(t);
      });
      var lab = label.length ? label[label.length - 1] : '';
      if (!lab && !amts.length) return;
      rows.push({ label: lab, all: label.join(''), amts: amts, paren: paren });
    });
    return { rows: rows, mul: mul };
  }
  function usSummary(T) {
    var o = {};
    T.data.facts.forEach(function (f) {
      if (!f.summary) return;
      var n = ln(f.concept), c = f.ctx || '';
      if (!/ResultMember/.test(c) || /NonConsolidated/.test(c)) return;
      var when = /^Current/.test(c) ? 'cur' : /^Prior/.test(c) ? 'pri' : null; if (!when) return;
      if (o[n + '_' + when] === undefined) o[n + '_' + when] = f.value;
    });
    return o;
  }
  // 表のどの列が当期かを、サマリーの数字（当期・前期）に一致する列で決める
  function usColumn(rows, target, tol) {
    for (var i = 0; i < rows.length; i++) for (var j = 0; j < rows[i].amts.length; j++) if (Math.abs(rows[i].amts[j] - target) <= tol) return { row: i, col: j };
    return null;
  }
  function usMeta(T, meta, tb) {
    var name = cleanName(meta && meta.name || T.summary.CompanyName);
    return { name: name, code: (meta && meta.code) || '', unit: tb.mul >= 1e6 ? { div: 1e6, name: '百万円' } : { div: tb.mul, name: tb.mul === 1e3 ? '千円' : '円' },
      source: name + ' ' + ((meta && meta.title) || '決算短信') + (meta && meta.date ? ' ' + meta.date : '') };
  }
  function extractPLUS(files, DP, meta) {
    var T = tools(files, DP), S = usSummary(T), tb = usTables(files, 'pl');
    var fail = { ok: false, reason: '米国基準の損益計算書の表を、サマリーの数字と照らして読み取れませんでした。' };
    if (!tb || S.NetSalesUS_cur === undefined || S.OperatingIncomeUS_cur === undefined) return fail;
    var tol = tb.mul, R = tb.rows;
    var a = usColumn(R, S.NetSalesUS_cur, tol); if (!a) return fail;
    var CUR = a.col, PRI = CUR === 0 ? 1 : 0;
    var v = function (r, col) { return r && r.amts.length > col ? r.amts[col] : undefined; };
    var find = function (re, from, to) { for (var i = from || 0; i < (to === undefined ? R.length : to); i++) if (re.test(R[i].label) && R[i].amts.length) return i; return -1; };
    var byVal = function (x) { if (x === undefined) return -1; for (var i = 0; i < R.length; i++) if (Math.abs(v(R[i], CUR) - x) <= tol) return i; return -1; };
    var iRev = a.row, iOp = byVal(S.OperatingIncomeUS_cur), iPre = byVal(S.IncomeBeforeIncomeTaxesUS_cur), iPar = byVal(S.NetIncomeUS_cur);
    if (iOp < 0 || iPre < 0 || iPar < 0 || !(iRev < iOp && iOp < iPre && iPre < iPar)) return fail;
    var iCogs = find(/^売上原価/, iRev + 1, iOp), iGp = find(/^売上総利益/, iRev + 1, iOp), iSga = find(/^販売費及び一般管理費/, iRev + 1, iOp);
    // 非支配持分を含む純利益：「非支配持分控除前…純利益」か「（四半期・中間・当期）純利益」の行。なければ親会社分＋非支配持分
    var iNi = find(/(非支配持分控除前.*純利益|^(四半期|中間|当期)?純利益$)/, iPre + 1, iPar);
    var iNci = find(/非支配持分(に)?帰属/, iPre + 1, iPar);
    var iEq = find(/^持分法(による)?投資損益$/, iPre + 1, iNi < 0 ? iPar : iNi);
    function pl(col, sumRev) {
      var rev = v(R[iRev], col); if (rev === undefined) return null;
      var op = v(R[iOp], col), pre = v(R[iPre], col), par = v(R[iPar], col);
      var ni = iNi >= 0 ? v(R[iNi], col) : (iNci >= 0 ? par + v(R[iNci], col) : par);
      if (iEq >= 0) pre += v(R[iEq], col); // 税引後の持分法損益は、営業外の側にまとめる（税金の箱を正しく保つ）
      var gp = iGp >= 0 ? v(R[iGp], col) : (iCogs >= 0 ? rev - v(R[iCogs], col) : undefined);
      var sgaAct = iSga >= 0 ? v(R[iSga], col) : undefined;
      var o = { opDerived: false, rev: rev, gp: gp, cogs: gp !== undefined ? rev - gp : undefined, op: op, sga: gp !== undefined ? gp - op : rev - op, sgaAct: sgaAct, ni: ni, niParent: par, pre: pre, tax: pre - ni };
      o.nonop = pre - op; o.sp = 0; o.ord = pre;
      return o;
    }
    var c = pl(CUR), p = pl(PRI) || {};
    if (!c || [c.rev, c.op, c.pre, c.ni].some(function (x) { return x === undefined || isNaN(x); })) return fail;
    // 前期の列も、サマリーの前期の売上高と合うときだけ使う
    if (S.NetSalesUS_pri !== undefined && Math.abs((p.rev || 0) - S.NetSalesUS_pri) > tol) p = {};
    var M = usMeta(T, meta, tb), f = function (x) { return Math.round(x / M.unit.div).toLocaleString('ja-JP'); };
    var sgaName = c.gp === undefined ? '営業費用' : '販管費', sgaNote = null;
    if (c.gp !== undefined && c.sgaAct !== undefined && Math.abs(c.sgaAct - c.sga) > tol * 3) {
      sgaName = '販管費等';
      var others = []; for (var i = (iGp >= 0 ? iGp : iRev) + 1; i < iOp; i++) { var r = R[i]; if (i === iSga || i === iCogs || !r.amts.length || /合計|^計$/.test(r.label)) continue; others.push(r); }
      var diff = c.sga - c.sgaAct;
      var lab = others.length === 1 && /費/.test(others[0].label) && !/収益/.test(others[0].label) ? others[0].label : (diff > 0 ? 'その他の営業費用' : 'その他の営業収益');
      sgaNote = '販管費' + f(c.sgaAct) + (diff > 0 ? '＋' : '−') + lab + f(Math.abs(diff));
    }
    return { ok: true, kind: 'pl', usgaap: true, ifrsNote: null, unit: M.unit, ifrs: false, name: M.name, code: M.code, source: M.source,
      cur: c, prev: p, segments: [{ name: '全社', sales: c.rev, salesPrev: p.rev, profit: null, single: true }], segNote: null,
      sgaName: sgaName, sgaNote: sgaNote, nonopName: '営業外損益' };
  }
  function extractBSUS(files, DP, meta) {
    var T = tools(files, DP), S = usSummary(T), tb = usTables(files, 'bs');
    var fail = { ok: false, reason: '米国基準の貸借対照表の表を、サマリーの数字と照らして読み取れませんでした。' };
    if (!tb || S.TotalAssetsUS_cur === undefined) return fail;
    var tol = tb.mul, R = tb.rows;
    var a = usColumn(R, S.TotalAssetsUS_cur, tol); if (!a) return fail;
    var CUR = a.col, PRI = CUR === 0 ? 1 : 0, iTot = a.row;
    var v = function (r, col) { return r && r.amts.length > col ? r.amts[col] : undefined; };
    var find = function (re, from, to) { for (var i = from || 0; i < (to === undefined ? R.length : to); i++) if (re.test(R[i].label) && R[i].amts.length) return i; return -1; };
    // 左：資産の明細（小計・合計の行は除く）。引当金などのマイナスは、直前の債権の行から差し引く
    var leaves = [];
    for (var i = 0; i < iTot; i++) {
      var r = R[i], x = v(r, CUR); if (x === undefined || r.paren || /合計$|^計$/.test(r.label) || !r.label) continue;
      if (x < 0) {
        var t = null; for (var j = leaves.length - 1; j >= 0; j--) if (/債権|売掛金|リース/.test(leaves[j].label)) { t = leaves[j]; break; }
        (t || leaves[leaves.length - 1] || { v: 0 }).v += x; continue;
      }
      leaves.push({ label: r.label.replace(/[（(]注[0-9０-９]*[)）]$/, ''), v: x });
    }
    var sum = leaves.reduce(function (s, l) { return s + l.v; }, 0), total = v(R[iTot], CUR);
    if (Math.abs(sum - total) > tol * 3) return fail;
    // 小さいものは「その他の資産」にまとめる（現金は残す）
    var big = [], small = 0;
    leaves.forEach(function (l, k) { if (k === 0 || l.v >= total * 0.04) big.push({ label: l.label, v: l.v, merged: false }); else small += l.v; });
    while (big.length > 8) { var mi = 1; for (var q = 2; q < big.length; q++) if (big[q].v < big[mi].v) mi = q; small += big[mi].v; big.splice(mi, 1); }
    if (small > 0) big.push({ label: 'その他の資産', v: small });
    // 右：負債と純資産
    var iLiab = find(/^負債合計$/, iTot + 1), iNA = find(/^純資産合計$|^資本合計$/, iTot + 1);
    var na = S.NetAssetsUS_cur !== undefined ? S.NetAssetsUS_cur : v(R[iNA], CUR);
    var liab = iLiab >= 0 ? v(R[iLiab], CUR) : (na !== undefined ? total - na : undefined);
    if (liab === undefined || na === undefined || Math.abs(liab + na - total) > tol * 3) return fail;
    var iCL = find(/^流動負債(合計)?$/, iTot + 1), iFL = find(/^固定負債(合計)?$/, iTot + 1);
    var cl = v(R[iCL], CUR), fl = v(R[iFL], CUR);
    var right = [];
    if (cl !== undefined && fl !== undefined && Math.abs(cl + fl - liab) <= tol * 3) { right.push({ label: '流動負債', v: cl, kind: 'liab' }); right.push({ label: '固定負債', v: fl, kind: 'liab' }); }
    else right.push({ label: '負債', v: liab, kind: 'liab' });
    var se = S.ShareholdersEquityUS_cur !== undefined ? S.ShareholdersEquityUS_cur : v(R[find(/^株主資本(合計)?$/, iTot + 1)], CUR);
    if (se !== undefined && se <= na + tol) {
      right.push({ label: '株主資本', v: se, kind: 'eq', strong: true });
      if (na - se > tol) right.push({ label: '非支配持分', v: na - se, kind: 'eq' });
    } else right.push({ label: '純資産', v: na, kind: 'eq', strong: true });
    var M = usMeta(T, meta, tb);
    return { ok: true, kind: 'bs', usgaap: true, unit: M.unit, ifrs: false, name: M.name, code: M.code, source: M.source,
      total: total, totalPrev: v(R[iTot], PRI), liab: liab, netAssets: na, assets: big, right: right, notes: [], kpi: null };
  }

  function extractPL(files, DP, meta) {
    if (isUS(files)) return extractPLUS(files, DP, meta);
    var m = TP.analyze(files, DP);
    if (!m.ok || m.mode !== 'full') return { ok: false, reason: m.reason || 'この短信は財務諸表の添付がないため、この形では描けません。', model: m };
    var T = tools(files, DP), cur = m.info.period.cur, pri = m.info.period.prior;
    var ifrs = T.att.some(function (f) { return /^jpigp_cor_/.test(f.concept); });
    function pl(ctx) {
      if (!ctx) return null;
      var rev = ctx === cur ? m.revenue.value : m.revenue.prior;
      var gp = T.val(['GrossProfit', 'GrossProfitIFRS'], ctx);
      var op = T.val(['OperatingIncome', 'OperatingProfitLossIFRS', 'OperatingIncomeLoss'], ctx);
      var ord = T.val(['OrdinaryIncome'], ctx);
      var pre = T.val(['IncomeBeforeIncomeTaxes', 'ProfitLossBeforeTaxIFRS', 'IncomeLossBeforeIncomeTaxes'], ctx);
      var ni = T.val(['ProfitLoss', 'ProfitLossIFRS'], ctx);
      // 親会社株主に帰属する純利益（非支配株主の分を除いたもの。短信の見出しの数字）
      var niParent = T.val(['ProfitLossAttributableToOwnersOfParent', 'ProfitLossAttributableToOwnersOfParentIFRS'], ctx);
      // 非継続事業（売却した事業など）の損益：税引前利益の外にあるので、別の流れとして扱う
      var disc = T.val(['ProfitLossFromDiscontinuedOperationsIFRS', 'ProfitLossFromDiscontinuedOperations'], ctx);
      var sgaAct = T.val(['SellingGeneralAndAdministrativeExpenses', 'SellingGeneralAndAdministrativeExpensesIFRS'], ctx);
      var opDerived = false;
      if (op === undefined && ifrs && pre !== undefined) {
        var fin = (T.val(['FinanceIncomeIFRS'], ctx) || 0) - (T.val(['FinanceCostsIFRS'], ctx) || 0) + (T.val(['ShareOfProfitLossOfInvestmentsAccountedForUsingEquityMethodIFRS'], ctx) || 0);
        op = pre - fin; opDerived = true;
      }
      if (rev === undefined || op === undefined || ni === undefined) return null;
      if (pre === undefined) pre = ord !== undefined ? ord : op;
      var o = { opDerived: opDerived, rev: rev, gp: gp, cogs: gp !== undefined ? rev - gp : undefined, op: op, sga: gp !== undefined ? gp - op : rev - op, sgaAct: sgaAct, ni: ni, niParent: niParent, pre: pre, tax: pre - ni };
      if (!ifrs && ord !== undefined) { o.nonop = ord - op; o.sp = pre - ord; o.ord = ord; }
      else { o.nonop = pre - op; o.sp = 0; o.ord = pre; }
      if (disc !== undefined && disc !== 0) { o.disc = disc; o.sp += disc; o.tax = pre + disc - ni; } // 税金は継続事業の分だけになる
      return o;
    }
    var c = pl(cur), p = pl(pri) || {};
    if (!c) return { ok: false, reason: '損益の主な段（営業利益・純利益）が読み取れませんでした。', model: m };

    // 販管費の呼び方（その他の収益・費用を含めて合わせる場合）
    var sgaName = '販管費', sgaNote = null;
    if (c.gp === undefined) sgaName = '営業費用';
    else if (c.sgaAct !== undefined && Math.abs(c.sgaAct - c.sga) > T.unit.div * 3) {
      sgaName = '販管費等';
      var diff = c.sgaAct - c.sga, f = function (v) { return Math.round(v / T.unit.div).toLocaleString('ja-JP'); };
      sgaNote = diff > 0 ? '販管費' + f(c.sgaAct) + '−その他収益純額' + f(diff) : '販管費' + f(c.sgaAct) + '＋その他費用純額' + f(-diff);
    }

    // セグメント（外部顧客への売上と、あれば利益）
    var sg = segmentsOf(T, files, cur, pri, c, p);
    var segs = sg.segs, segNote = sg.note;

    var ifrsNote = null;
    if (ifrs) {
      var rep = [];
      var revLab = m.revenue.label || '売上収益';
      if (revLab !== '売上高') rep.push(revLab + '→売上高');
      if (sgaName === '販管費等') rep.push('販管費＋その他の収益・費用→販管費等');
      rep.push('金融収益・金融費用・持分法損益→金融損益等');
      rep.push('当期利益→当期純利益');
      ifrsNote = 'IFRSの科目は次のように置き換えています：' + rep.join('、');
      if (c.opDerived) ifrsNote += '。営業利益の開示がないため、税引前利益から金融損益等を除いて算出';
    }
    var name = cleanName(meta && meta.name || m.info.company);
    return {
      ok: true, kind: 'pl', ifrsNote: ifrsNote, unit: T.unit, ifrs: ifrs,
      name: name, code: (meta && meta.code) || m.info.code,
      source: name + ' ' + ((meta && meta.title) || '決算短信') + (meta && meta.date ? ' ' + meta.date : ''),
      cur: c, prev: p, segments: segs, segNote: segNote, sgaName: sgaName, sgaNote: sgaNote,
      nonopName: ifrs ? '金融損益等' : '営業外損益',
    };
  }

  // 1枚目（サマリー）から、配当と通期予想の箱を作る
  function kpiFromSummary(T, m) {
    var d = T.data, boxes = [];
    var rows = [];
    // 予想（通期）
    var fc = {};
    d.facts.forEach(function (f) {
      if (!f.summary) return;
      var c = d.contexts[f.ctx]; if (!c) return;
      var ms = c.members.map(function (x) { return x.split(':').pop(); });
      if (ms.indexOf('ForecastMember') < 0 || /Upper|Lower/.test(ms.join())) return;
      if (ms.some(function (x) { return /NonConsolidated/.test(x); })) return;
      var k = ln(f.concept);
      if (fc[k] === undefined && /^(NetSales|NetSalesIFRS|SalesIFRS|Revenue|RevenueIFRS|RevenuesIFRS|NetSalesUS|OperatingRevenues|OperatingIncome|OperatingIncomeIFRS|OperatingProfitIFRS|OperatingIncomeUS)$/.test(k) && /Year/.test(f.ctx)) fc[k] = f.value;
    });
    var oku = function (v) { return Math.round(v / 1e8).toLocaleString('ja-JP') + '億円'; };
    var fr = fc.NetSales || fc.NetSalesIFRS || fc.SalesIFRS || fc.Revenue || fc.RevenueIFRS || fc.RevenuesIFRS || fc.NetSalesUS || fc.OperatingRevenues, fo = fc.OperatingIncome || fc.OperatingIncomeIFRS || fc.OperatingProfitIFRS || fc.OperatingIncomeUS;
    if (fr || fo) boxes.push({ title: '通期の会社予想', rows: [fr ? '売上 ' + oku(fr) : '', fo ? '営業利益 ' + oku(fo) : ''].filter(Boolean) });
    // 配当（年間）
    var dv = {}, dvp;
    d.facts.forEach(function (f) {
      if (!f.summary || ln(f.concept) !== 'DividendPerShare') return;
      var c = d.contexts[f.ctx]; if (!c) return;
      var ms = c.members.map(function (x) { return x.split(':').pop(); });
      if (ms.indexOf('AnnualMember') < 0) return;
      var key = (/^Current/.test(f.ctx) ? 'cur' : /^Prior/.test(f.ctx) ? 'pri' : 'x') + (ms.indexOf('ForecastMember') >= 0 ? 'F' : 'R');
      if (dv[key] === undefined) dv[key] = f.value;
    });
    var cd = dv.curF !== undefined ? dv.curF : dv.curR, pd = dv.priR;
    if (cd !== undefined) {
      var yen = function (v) { return (Math.round(v * 100) / 100).toLocaleString('ja-JP') + '円'; };
      boxes.push({ title: '株主還元', rows: ['配当 年' + yen(cd) + (dv.curF !== undefined ? '（予想）' : ''), pd !== undefined ? '前期 年' + yen(pd) : ''].filter(Boolean) });
    }
    return boxes.slice(0, 2);
  }

  /* ---------- 貸借対照表 ---------- */
  var CUR_INST = ['CurrentYearInstant', 'InterimInstant', 'CurrentQuarterInstant', 'CurrentAccumulatedQ1Instant', 'CurrentAccumulatedQ2Instant', 'CurrentAccumulatedQ3Instant'];

  function extractBS(files, DP, meta) {
    if (isUS(files)) return extractBSUS(files, DP, meta);
    var T = tools(files, DP), d = T.data;
    var ifrs = T.att.some(function (f) { return /^jpigp_cor_/.test(f.concept); });
    // 期末（今期）と前期末の時点
    var inst = {};
    T.att.forEach(function (f) { var c = d.contexts[f.ctx]; if (c && c.instant && !c.members.length && /^(Assets|AssetsIFRS)$/.test(ln(f.concept))) inst[f.ctx] = c.instant; });
    var ids = Object.keys(inst);
    var cur = CUR_INST.filter(function (x) { return inst[x]; })[0] || ids.filter(function (x) { return !/^Prior/.test(x); }).sort(function (a, b) { return inst[a] < inst[b] ? 1 : -1; })[0];
    if (!cur) return { ok: false, reason: 'この短信からは貸借対照表を読み取れませんでした。' };
    var pri = ids.filter(function (x) { return x !== cur && /^Prior/.test(x); }).sort(function (a, b) { return inst[a] < inst[b] ? 1 : -1; })[0];
    function v(names, ctx) { return T.val(names, ctx || cur); }

    // 計算の定義から、資産の明細を集める
    var role = null;
    Object.keys(d.cal).forEach(function (r) {
      var ch = d.cal[r].children;
      if (Object.keys(ch).some(function (p) { return /^(Assets|AssetsIFRS)$/.test(ln(p)); })) role = role || r;
    });
    if (!role) return { ok: false, reason: '貸借対照表の構成が読み取れませんでした。' };
    var ch = d.cal[role].children;
    function kids(c) { return (ch[c] || []); }
    var top = Object.keys(ch).filter(function (p) { return /^(Assets|AssetsIFRS)$/.test(ln(p)); })[0];
    var orderOf = {};
    T.att.forEach(function (f, i) { if (orderOf[f.concept] === undefined && f.ctx === cur) orderOf[f.concept] = i; });
    var labelOf = {};
    // 科目名は貸借対照表のページの行の名前を優先する（キャッシュ・フロー計算書の「期首残高」などを拾わないため）
    var cleanLab = function (l) {
      return String(l).replace(/^\s*(?:[Ⅰ-Ⅹ]+|[IVX]+[\s．.]|[（(][0-9０-９]+[）)]|[0-9０-９]+[．.])\s*/, '').replace(/の?(期首|期末|四半期末|中間期末|中間連結会計期間末)残高.*$/, '').trim();
    };
    var isBS = function (f) { return /(bs|fs)\d*-/i.test(String(f.file).split('/').pop()); };
    T.att.forEach(function (f) { if (f.label && isBS(f) && !labelOf[f.concept]) labelOf[f.concept] = cleanLab(f.label); });
    T.att.forEach(function (f) { if (f.label && !labelOf[f.concept] && !/(cf|ss)\d*-/i.test(String(f.file).split('/').pop())) labelOf[f.concept] = cleanLab(f.label); });
    T.att.forEach(function (f) { if (f.label && !labelOf[f.concept]) labelOf[f.concept] = cleanLab(f.label); });

    var leaves = [];
    function walk(c, sign, depth) {
      var k = kids(c);
      var name = ln(c);
      // 日本基準：有形・無形固定資産は合計のまま、投資その他の資産は中身に分ける
      var keep = /^(PropertyPlantAndEquipment|IntangibleAssets)(?!Gross|Net)/.test(name);
      if (!k.length || keep) { leaves.push({ c: c, s: sign, p: walk.parent }); return; }
      var saved = walk.parent; walk.parent = c;
      k.forEach(function (x) { walk(x.c, sign * x.w, depth + 1); });
      walk.parent = saved;
    }
    walk(top, 1, 0);
    // 流動・非流動で同じ科目はまとめる（例：その他の金融資産）
    var groups = {};
    // 貸倒引当金などのマイナス項目は、すぐ前の項目から差し引く（例：破産更生債権等−貸倒引当金）
    leaves.forEach(function (l) { l.val = T.val([ln(l.c)], cur); l.pv = pri ? T.val([ln(l.c)], pri) : undefined; if (l.val !== undefined) l.val *= l.s; if (l.pv !== undefined) l.pv *= l.s; l.s = 1; });
    // 引当金は、同じ区分に破産更生債権などがあればそこから差し引き、なければ「その他」に含める（雛形どおり）
    leaves.forEach(function (l) {
      if (l.val === undefined || l.val >= 0) return;
      var nm0 = ln(l.c);
      if (/AccumulatedDepreciation|AccumulatedImpairment/.test(nm0)) {
        var idx = leaves.indexOf(l), prev = null;
        for (var pi = idx - 1; pi >= 0; pi--) if (leaves[pi].val > 0 && leaves[pi].p === l.p) { prev = leaves[pi]; break; }
        if (prev) { prev.val += l.val; if (prev.pv !== undefined && l.pv !== undefined) prev.pv += l.pv; l.val = undefined; }
        return;
      }
      // 引当金の相手：同じ区分の債権。破産更生債権→売掛金・貸付金・立替金→保証金の順に、大きいものから差し引く
      var rank = function (x) {
        var n = ln(x.c), lb = labelOf[x.c] || '';
        if (/^Cash|現金/.test(n + lb)) return -1;
        if (/ClaimsProvable|Bankruptcy|破産更生/.test(n + lb)) return 3;
        if (/Receivable|Loans|Advance|売掛|貸付|立替|未収/.test(n + lb)) return 2;
        if (/InvestmentLoss/.test(nm0) && /InvestmentSecurities|投資有価証券/.test(n + lb)) return 2;
        if (/Guarantee|保証金|差入/.test(n + lb)) return 1;
        return 0;
      };
      // 相手は債権のたぐいだけ。見つからなければ差し引かず「その他」に含める
      var cands = leaves.filter(function (x) { return x !== l && x.p === l.p && x.val > 0 && rank(x) >= 1; })
        .sort(function (a, b) { return rank(b) - rank(a) || b.val - a.val; });
      var rest = -l.val, restP = l.pv !== undefined ? -l.pv : 0;
      cands.forEach(function (x) {
        if (rest <= 0) return;
        var take = Math.min(rest, x.val); x.val -= take; rest -= take; x.netted = true;
        if (x.pv !== undefined && restP > 0) { var tp = Math.min(restP, x.pv); x.pv -= tp; restP -= tp; }
      });
      if (rest <= 0) l.val = undefined; else l.val = -rest;
    });
    leaves.forEach(function (l) {
      var val = l.val; if (val === undefined) return;
      var pv = l.pv;
      var base = ln(l.c).replace(/(CA|NCA|IOA)?(IFRS)?$/, '').replace(/(CA|NCA|IOA)$/, '');
      var lab = (labelOf[l.c] || base).replace(/[\s　]+/g, '').replace(/合計$/, '');
      var key = ifrs ? base : (lab || l.c);
      // 日本基準で棚卸資産が品目ごとに分かれている場合は、まとめて「棚卸資産」にする
      if (/^(Merchandise|FinishedGoods|MerchandiseAndFinishedGoods|WorkInProcess|RawMaterials|Supplies|RawMaterialsAndSupplies|CostsOnUncompletedConstructionContracts|RealEstateForSale|Inventories)$/.test(base)) { key = '__INV'; lab = '棚卸資産'; }
      var g = groups[key] = groups[key] || { label: lab, v: 0, pv: 0, n: 0, havePrior: true, concepts: [], inv: key === '__INV', netted: false, ord: 1e9 };
      g.ord = Math.min(g.ord, orderOf[l.c] !== undefined ? orderOf[l.c] : 1e9);
      g.v += val; g.pv += (pv || 0); g.n++; g.concepts.push((labelOf[l.c] || base).replace(/[\s　]+/g, ''));
      if (l.netted) g.netted = true;
      (g.parents = g.parents || []).push(ln(l.p || ''));
      if (pv === undefined) g.havePrior = false;
    });
    var total = v(['Assets', 'AssetsIFRS']), totalP = pri ? v(['Assets', 'AssetsIFRS'], pri) : undefined;
    var items = Object.keys(groups).map(function (k) { return groups[k]; });
    var shown = items.filter(function (g) { return g.v >= total * 0.02 && !/^その他(の)?(流動資産|非流動資産|固定資産|投資その他の資産|資産)?$/.test(g.label); }).sort(function (a, b) { return b.v - a.v; }).slice(0, 7).sort(function (a, b) { return a.ord - b.ord; });
    var others = items.filter(function (g) { return shown.indexOf(g) < 0; });
    var otherSum = total - shown.reduce(function (a, g) { return a + g.v; }, 0);
    var assets = shown.map(function (g) { return { label: g.label, v: g.v, merged: g.n > 1 }; });
    var notes = [];
    shown.forEach(function (g) {
      if (g.inv && g.n > 1) notes.push('棚卸資産は' + g.concepts.join('・') + 'の合計');
      else if (g.n > 1) {
        var cur = g.parents.some(function (p) { return /^Current/.test(p); }), non = g.parents.some(function (p) { return !/^Current/.test(p); });
        notes.push(g.label + 'は' + (cur && non ? (ifrs ? '流動＋非流動' : '流動＋固定') : '複数の区分') + 'の合計');
      }
      if (g.netted) notes.push(g.label + 'は引当金を差し引き後');
    });
    if (otherSum > 0) {
      assets.push({ label: ifrs ? 'その他の資産' : 'その他', v: otherSum });
      var parts = others.filter(function (g) { return g.v > 0 && g.label !== 'その他'; }).sort(function (a, b) { return b.v - a.v; }).map(function (g) { return g.label.replace(/^その他の?/, 'その他'); });
      var uniq = parts.filter(function (x, i) { return parts.indexOf(x) === i; });
      var neg = others.some(function (g) { return g.v < 0 || g.netted; });
      notes.push((ifrs ? 'その他の資産' : 'その他') + 'は' + uniq.slice(0, 6).join('・') + (uniq.length > 6 || others.some(function (g) { return g.label === 'その他'; }) ? 'など' : '') + 'の合計' + (neg ? '（引当金などを差し引き後）' : ''));
    }

    // 負債
    var cl = v(['CurrentLiabilities', 'TotalCurrentLiabilitiesIFRS', 'CurrentLiabilitiesIFRS']);
    var ncl = v(['NoncurrentLiabilities', 'NonCurrentLabilitiesIFRS', 'NonCurrentLiabilitiesIFRS', 'NoncurrentLiabilitiesIFRS']);
    var liab = v(['Liabilities', 'LiabilitiesIFRS']);
    if (liab === undefined) liab = (cl || 0) + (ncl || 0);
    if (ncl === undefined && cl !== undefined) ncl = liab - cl;
    // 純資産
    var na = v(['NetAssets', 'EquityIFRS']);
    var right;
    if (cl === undefined) right = [{ label: '負債', v: liab, kind: 'liab' }]; // 銀行など、流動・固定の区分がない会社
    else {
      var resid = liab - cl - (ncl || 0);
      if (Math.abs(resid) > T.unit.div * 3) { ncl = (ncl || 0) + resid; notes.push((ifrs ? '非流動負債' : '固定負債') + 'には、流動・固定のどちらにも入らない負債（準備金など）を含む'); }
      right = [{ label: '流動負債', v: cl, kind: 'liab' }, { label: ifrs ? '非流動負債' : '固定負債', v: ncl || 0, kind: 'liab' }];
    }
    var ratio, ratioP, ratioName, ratioBase, ratioBaseName;
    if (ifrs) {
      var re = v(['RetainedEarningsIFRS']) || 0, ts = v(['TreasurySharesIFRS']) || 0; // 自己株式は負の値
      var reNet = re + ts, restEq = na - reNet;
      if (reNet > 0 && restEq > 0) {
        right.push({ label: ts ? '利益剰余金（自己株式控除後）' : '利益剰余金', v: reNet, kind: 'eq' });
        right.push({ label: '資本金・資本剰余金・その他資本等', v: restEq, kind: 'eq' });
        notes.push('資本等は資本金・剰余金・その他資本・非支配持分の合計' + (ts ? '。利益剰余金は自己株式△' + fmtU(-ts, T.unit) + '控除後' : ''));
      } else right.push({ label: '純資産', v: na, kind: 'eq' });
      ratioBase = v(['EquityAttributableToOwnersOfParentIFRS']);
      ratioName = '親会社帰属持分比率'; ratioBaseName = '親会社帰属持分';
      ratio = ratioBase / total;
      var rbp = pri ? v(['EquityAttributableToOwnersOfParentIFRS'], pri) : undefined;
      ratioP = rbp !== undefined && totalP ? rbp / totalP : undefined;
    } else {
      var se = v(['ShareholdersEquity']), oci = v(['ValuationAndTranslationAdjustments', 'AccumulatedOtherComprehensiveIncome']) || 0;
      var sr = v(['SubscriptionRightsToShares']) || 0, nci = v(['NonControllingInterests']) || 0;
      if (se !== undefined && se > 0) {
        var restN = na - se;
        right.push({ label: '株主資本', v: se, kind: 'eq', strong: true });
        var tolN = T.unit.div * 3;
        if (Math.abs(restN) <= tolN) right[right.length - 1].v = na;
        else if (restN > 0) {
          var lab2 = oci > 0 && !sr && !nci ? 'その他の包括利益累計額' : oci >= restN * 0.9 ? 'その他の包括利益累計額など' : '非支配株主持分など';
          right.push({ label: lab2, v: lab2 === 'その他の包括利益累計額' ? oci : restN, kind: 'eq' });
          if (lab2 !== 'その他の包括利益累計額') notes.push(lab2 + 'は、その他の包括利益累計額・新株予約権・非支配株主持分の合計');
        } else {
          notes.push('純資産は株主資本からその他の包括利益累計額など△' + fmtU(-restN, T.unit) + 'を差し引いた額');
          right[right.length - 1].v = na; right[right.length - 1].label = '株主資本など';
        }
      } else right.push({ label: '純資産', v: na, kind: 'eq' });
      ratioBase = na - sr - nci; ratioName = '自己資本比率'; ratioBaseName = '株主資本';
      ratio = ratioBase / total;
      if (pri) {
        var nap = v(['NetAssets'], pri), srp = v(['SubscriptionRightsToShares'], pri) || 0, ncip = v(['NonControllingInterests'], pri) || 0;
        ratioP = nap !== undefined && totalP ? (nap - srp - ncip) / totalP : undefined;
      }
    }
    if (ifrs) notes.unshift('IFRSの科目は次のように置き換えています：資本合計→純資産');
    // 資産の特徴：いちばん大きい資産と、現金
    var cash = assets.filter(function (a) { return /現金/.test(a.label); })[0];
    var feat = [assets[0]];
    if (cash && cash !== assets[0]) feat.push(cash); else if (assets[1] && !/^その他/.test(assets[1].label)) feat.push(assets[1]);

    var name = cleanName(meta && meta.name || T.summary.CompanyName);
    return {
      ok: true, kind: 'bs', unit: T.unit, ifrs: ifrs, name: name, code: (meta && meta.code) || (T.summary.SecuritiesCode || '').slice(0, 4),
      source: name + ' ' + ((meta && meta.title) || '決算短信') + (meta && meta.date ? ' ' + meta.date : ''),
      total: total, totalPrev: totalP, liab: liab, netAssets: na, assets: assets, right: right, notes: notes,
      kpi: [
        { title: ratioName, rows: [(ratio * 100).toFixed(1) + '%' + (ratioP !== undefined ? '（前期末 ' + (ratioP * 100).toFixed(1) + '%）' : ''), ratioBaseName + ' ' + fmtU(ratioName === '自己資本比率' ? (v(['ShareholdersEquity']) || ratioBase) : ratioBase, T.unit)] },
        { title: '資産の特徴', rows: feat.map(function (a) { return shortLabel(a.label) + ' ' + fmtU(a.v, T.unit); }) }
      ]
    };
  }
  function shortLabel(s) { return s.replace(/及びその他の債権$/, '').replace(/^受取手形及び売掛金$/, '売上債権'); }
  function fmtU(v, unit) { return Math.round(v / unit.div).toLocaleString('ja-JP'); }

  /* ================= 描画：絵でみる儲けの流れ（sk.js と同じ配置） ================= */
  var PAL = {
    fg: '#1d2433', muted: '#5d6678', rev: '#2b3a67', cogs: '#b3bac8', gp: '#7cbf99', op: '#55a37b', ord: '#3c8a62', ni: '#2a6a49', neg: '#c0563f', sga: '#8b6bb8',
    segflow: 'rgba(43,58,103,0.28)', gnflow: 'rgba(124,191,153,0.45)', cogsflow: 'rgba(179,186,200,0.55)', sgaflow: 'rgba(139,107,184,0.40)', negflow: 'rgba(192,86,63,0.35)'
  };
  var NOTE_URL = 'https://note.com/hikichi_company';
  // 出典の文の最後の開示日を切り出す（日付は図の右下に出す）
  function splitDate(src) {
    var m = String(src || '').match(/^(.*?)[\s　]*(\d{4}年\d{1,2}月\d{1,2}日)[\s　]*$/);
    return m ? { src: m[1], date: m[2] } : { src: src || '', date: '' };
  }
  // 決算期の表記：決算が始まる年で FY2026Q2（通期は FY2026）。fye は '2027-03' の形
  // 決算期の表記：2027年3月期 第2四半期（4〜9月）。四半期は期首からの累計の月
  function periodLabel(fye, q) {
    var m = String(fye || '').match(/^(\d{4})-(\d{2})/); if (!m) return '';
    var y = +m[1], mo = +m[2], head = y + '年' + mo + '月期';
    if (!q || q === 4) return head + ' 通期';
    var start = mo % 12 + 1, end = (mo + 3 * q - 1) % 12 + 1;
    return head + ' 第' + q + '四半期（' + start + '〜' + end + '月）';
  }
  function fyCode(fye, q) {
    var m = String(fye || '').match(/^(\d{4})-(\d{2})/); if (!m) return '';
    var y = +m[1] - (+m[2] === 12 ? 0 : 1);
    return 'FY' + y + (q && q !== 4 ? 'Q' + q : '');
  }
  var FONT = "'Zen Kaku Gothic New','Noto Sans CJK JP','Noto Sans JP',sans-serif";

  function svgBuilder(W, H) {
    var out = [];
    return {
      add: function (s) { out.push(s); },
      text: function (x, y, t, o) {
        o = o || {};
        out.push('<text x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" text-anchor="' + (o.anchor || 'middle') + '" font-size="' + o.size + '" font-weight="' + (o.weight || 500) + '" fill="' + (o.fill || PAL.fg) + '">' + esc(t) + '</text>');
      },
      done: function () {
        return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" font-family="' + esc(FONT) + '"><rect width="' + W + '" height="' + H + '" fill="#ffffff"/>' + out.join('') + '</svg>';
      }
    };
  }

  function renderPL(cfg, opt) {
    // プロジェクトの engine.js の drawSankey と同じ配置（1720×1020、ふち30/20）
    var W = 1780, Hh = 1060, OX = 30, OY = 20;
    var B = svgBuilder(W, Hh);
    var P = cfg.cur, Pp = cfg.prev || {}, segs = cfg.segments || [], U = cfg.unit;
    var k = 360 / P.rev, NW = 44;
    // 本業以外の利益がとても大きい会社（売上より大きい売却益など）は、図が下にはみ出さないよう全体の縮尺を下げる
    var inAll = Math.max(P.nonop || 0, 0) + Math.max(P.sp || 0, 0) + Math.max(-(P.tax || 0), 0);
    if (P.op >= 0 && P.ni >= 0 && inAll > P.ni) k = Math.min(k, 380 / (P.op + inAll));
    var Hf = function (v) { return Math.max(Math.abs(v) * k, 2.5); };
    var fmt = function (v) { return Math.round(v / U.div).toLocaleString('ja-JP'); };
    var has = function (x) { return x !== undefined && x !== null && !isNaN(x); };
    var yoy = function (a, b) { return has(b) && b > 0 ? (a >= b ? '+' : '△') + Math.abs((a / b - 1) * 100).toFixed(1) + '% 前年比' : ''; };
    var rt = function (v, b) { return v / b * 100; };
    var sgn = function (v, d) { return (v < 0 ? '△' : '') + Math.abs(v).toFixed(d); };
    var rts = function (v, b) { return sgn(v / b * 100, 1); };
    var pp = function (a, b) { if (!has(a) || !has(b)) return ''; var d = a - b; return (d >= 0 ? '+' : '△') + Math.abs(d).toFixed(1) + 'pp 前年比'; };
    var gy = 0;
    function T(x, y) { return [OX + x, OY + gy + y]; }
    function ad(tag, a) {
      var p = T(a.x || 0, a.y || 0), s = '<' + tag;
      for (var key in a) { var v = a[key]; if (key === 'x') v = p[0]; if (key === 'y') v = p[1]; s += ' ' + key + '="' + v + '"'; }
      B.add(s + '/>');
    }
    function flow(x0, a0, b0, x1, a1, b1, c) {
      var p = T(0, 0), dx = p[0], dy = p[1], mm = (x0 + x1) / 2;
      B.add('<path d="M' + (x0 + dx) + ',' + (a0 + dy) + ' C' + (mm + dx) + ',' + (a0 + dy) + ' ' + (mm + dx) + ',' + (a1 + dy) + ' ' + (x1 + dx) + ',' + (a1 + dy) +
        ' L' + (x1 + dx) + ',' + (b1 + dy) + ' C' + (mm + dx) + ',' + (b1 + dy) + ' ' + (mm + dx) + ',' + (b0 + dy) + ' ' + (x0 + dx) + ',' + (b0 + dy) + ' Z" fill="' + c + '"/>');
    }
    function node(x, y, h, c) { ad('rect', { x: x, y: y, width: NW, height: h, fill: c }); }
    function lines(x, y, arr, anchor) {
      var yy = y;
      arr.forEach(function (a) { yy += a[1] * 1.22; if (!a[0]) return; var p = T(x, yy); B.text(p[0], p[1], a[0], { size: a[1], weight: a[2] || 500, fill: a[3] || PAL.fg, anchor: anchor || 'middle' }); });
    }
    var M = PAL.muted, GT = PAL.ord, NEG = PAL.neg;
    var ttl = cfg.name + '（' + cfg.code + '）' + (opt && opt.period ? '　' + opt.period : '');
    var TTL_SIZE = ttl.length > 24 ? 50 : 58;
    B.text(OX + 860, OY + 76, ttl, { size: TTL_SIZE, weight: 900 });
    gy = 92;
    // 図の本体は少し小さくして、下に余白をつくる（題名と下の欄はそのままの大きさ）
    var SC = 0.93, scX = W / 2, scY = OY + 110;
    B.add('<g transform="translate(' + scX + ' ' + scY + ') scale(' + SC + ') translate(' + (-scX) + ' ' + (-scY) + ')">');
    var XS = 305, XR = 610, XG = 900, XO = 1180, XF = 1455; // 左右の余白がそろう幅
    // 税引前利益の箱が入る形（本業以外の利益が純利益より大きい）は、列が1つ増えるので、すべての列を同じ間隔に並べ直す
    var XPcol = XO + NW + 96;
    if (P.op >= 0 && P.ni >= 0 && inAll > P.ni) {
      var cols = has(P.gp) ? 6 : 5, step = (XF - XS) / (cols - 1), ci = 1;
      XR = XS + step * ci++; if (has(P.gp)) XG = XS + step * ci++; XO = XS + step * ci++; XPcol = XS + step * ci++;
    }
    var rT = 300, rB = rT + P.rev * k;
    // セグメント
    // 注記と出典は左下の枠（売上原価のラベルにかからない幅）に、下から積む
    var wrapN = function (t, n) { var o = []; for (var i = 0; i < t.length; i += n) o.push(t.slice(i, i + n)); return o; };
    var footL = [];
    // 長い注記は載せない（図をすっきり見せる）。営業利益を計算で出したときだけ、ひとこと添える
    if (P.opDerived) footL.push(['営業利益は開示がないため、税引前利益から金融損益等を除いて算出', 15]);
    var srcDate = splitDate(cfg.source);
    // 言葉の途中で切れないよう、空白やかっこの前で折り返す
    var wrapSoft = function (t, n) {
      var o = [];
      while (t.length > n) {
        var cut = -1;
        for (var i = n; i > n * 0.5; i--) { if (/[\s　（〔(\[]/.test(t.charAt(i))) { cut = i; break; } }
        if (cut < 0) cut = n;
        o.push(t.slice(0, cut).replace(/[\s　]+$/, '')); t = t.slice(cut).replace(/^[\s　]+/, '');
      }
      if (t) o.push(t); return o;
    };
    footL.push(['単位：' + U.name, 15]);
    wrapSoft('出典：' + srcDate.src, 44).forEach(function (x) { footL.push([x, 15]); });
    var segSum = segs.reduce(function (a, b) { return a + b.sales; }, 0) || 1;
    var gapS = segs.length > 1 ? Math.min(120, (560 - P.rev * k) / (segs.length - 1)) : 0;
    var sy = segs.length > 1 ? 160 : rT, cut = rT;
    if (segs.length >= 2) {
      // 注記にかからない高さの中で、セグメントを上下にバランスよく広げ、売上高の箱を中心にそろえる
      var segTop = 130, segBottom = 800, avail = segBottom - segTop;
      var MINH = Math.max(64, Math.min(86, (avail - 10 * (segs.length - 1)) / segs.length));
      var hs = segs.map(function (sg) { return sg.sales / segSum * P.rev * k; }), slots = hs.map(function (h) { return Math.max(h, MINH); });
      var slotSum = slots.reduce(function (a, b) { return a + b; }, 0);
      var g = Math.max(6, Math.min(100, (avail - slotSum) / (segs.length - 1)));
      var blockH = slotSum + g * (segs.length - 1), mid = (rT + rB) / 2;
      var y = Math.max(segTop, Math.min(mid - blockH / 2, segBottom - blockH));
      segs.forEach(function (sg, i) {
        var h = hs[i], ny = y + (slots[i] - h) / 2;
        node(XS, ny, h, PAL.rev); flow(XS + NW, ny, ny + h, XR, cut, cut + h, PAL.segflow);
        var pr = sg.profit == null ? '売上の' + (sg.sales / segSum * 100).toFixed(1) + '%' :
          '利益率 ' + rts(sg.profit, sg.sales) + '%' + (has(sg.profitPrev) && has(sg.salesPrev) ? '（' + pp(rt(sg.profit, sg.sales), rt(sg.profitPrev, sg.salesPrev)).replace(' 前年比', '') + '）' : '');
        var yy = yoy(sg.sales, sg.salesPrev);
        lines(XS - 20, y + slots[i] / 2 - 42, [[sg.name, Math.min(26, Math.floor(300 / Math.max(1, sg.name.length))), 900], [fmt(sg.sales) + (yy ? '　' + yy : ''), 19, 700], [pr, 17, 500, M]], 'end');
        cut += h; y += slots[i] + g;
      });
    } else segs.forEach(function (sg) {
      var h = sg.sales / segSum * P.rev * k;
      node(XS, sy, h, PAL.rev); flow(XS + NW, sy, sy + h, XR, cut, cut + h, PAL.segflow);
      lines(XS + NW / 2, sy - 80, [[fmt(sg.sales), 30, 700], [yoy(sg.sales, sg.salesPrev), 19, 500, M]]);
      var info = sg.profit == null ? [['売上の' + (sg.sales / segSum * 100).toFixed(1) + '%', 19, 500, M]]
        : [['セグメント利益率 ' + rts(sg.profit, sg.sales) + '%', 19, 500, M], [has(sg.profitPrev) ? pp(rt(sg.profit, sg.sales), rt(sg.profitPrev, sg.salesPrev)) : '', 19, 500, M]];
      lines(XS - 24, sy + 4, [[sg.name, sg.name.length > 8 ? 26 : 34, 900]].concat(info), 'end');
      cut += h; sy += h + gapS;
    });
    node(XR, rT, rB - rT, PAL.rev);
    lines(XR + NW / 2, rT - 128, [['売上高', 32, 900], [fmt(P.rev), 32, 700], [yoy(P.rev, Pp.rev), 19, 500, M]]);
    // 売上総利益の開示がない会社（売上原価を分けない形）は、売上高から直接、営業利益と営業費用へつなぐ
    var noGP = !has(P.gp), XSRC = noGP ? XR : XG;
    var gT = noGP ? rT : 230, gH = (noGP ? P.rev : P.gp) * k;
    if (!noGP) {
    var cH = P.cogs * k, cT = Math.max(gT + gH + 60, Math.min(680, 860 - cH - 110)), rCut = rT + P.gp * k;
    flow(XR + NW, rT, rCut, XG, gT, gT + gH, PAL.gnflow); flow(XR + NW, rCut, rB, XG, cT, cT + cH, PAL.cogsflow);
    node(XG, gT, gH, PAL.gp); node(XG, cT, cH, PAL.cogs);
    lines(XG + NW / 2, gT - 150, [['売上総利益', 32, 900, GT], [fmt(P.gp), 32, 700, GT], ['粗利率 ' + rt(P.gp, P.rev).toFixed(1) + '%', 19, 500, M], [has(Pp.gp) ? pp(rt(P.gp, P.rev), rt(Pp.gp, Pp.rev)) : '', 19, 500, M]]);
    lines(XG + NW / 2, cT + cH + 6, [['売上原価', 30, 900], ['(' + fmt(P.cogs) + ')', 28, 700], ['売上の' + rt(P.cogs, P.rev).toFixed(1) + '%', 18, 500, M], [has(Pp.cogs) ? pp(rt(P.cogs, P.rev), rt(Pp.cogs, Pp.rev)) : '', 18, 500, M]]);
    }
    var SGAN = cfg.sgaName, NONOPN = cfg.nonopName, TAXN = cfg.ifrs ? '法人所得税' : '法人税等';
    if (P.op >= 0) {
      var oT = 170, oH = Hf(P.op), sH = P.sga * k, gCut = gT + P.op * k;
      // 営業利益 → 当期純利益・税金・営業外や特別の損失（利益の流入は上から入れる）
      var outs = [[TAXN, P.tax]].concat(P.nonop < 0 ? [[NONOPN, -P.nonop]] : []).concat(P.sp < 0 ? [[P.disc ? '非継続事業の損失' : '特別損失', -P.sp]] : []).filter(function (a) { return a[1] > 0; });
      var ins = [].concat(P.nonop > 0 ? [[NONOPN, P.nonop]] : []).concat(P.sp > 0 ? [[P.disc ? '非継続事業の利益' : '特別損益', P.sp]] : []).concat(P.tax < 0 ? [['税金の戻り', -P.tax]] : []);
      var inSum = ins.reduce(function (a, b) { return a + b[1]; }, 0);
      // 本業以外の利益が当期純利益より大きいとき（例：大きな売却益や持分法の利益）は、
      // 営業利益と本業以外の利益をいったん「税引前利益」の箱に集めてから、純利益と税金に分ける
      var preMode = P.ni >= 0 && inSum > P.ni;
      // この形では、本業以外の利益の箱を上に積み、営業利益の箱はその下に下げる（流れが交わらない）
      var insTops = [];
      if (preMode) {
        var yy0 = 150;
        ins.forEach(function (a) { insTops.push(yy0); yy0 += Hf(a[1]) + 84; }); // 箱の上に2行の見出しが入る間
        oT = yy0 - 84 + 50; // 最後の箱のすぐ下（見出しは箱の右下に置く）
      }
      // 販管費の箱は、流れが平らな線にならないよう、出どころより少し下に置く（下にはみ出さない範囲で）
      var sT = Math.min(Math.max(440, oT + oH + 60, gCut + 90), Math.max(440, oT + oH + 60, 850 - sH - 110)); // 下の欄にかからない高さまで
      // 販管費の見出し（箱の右）が営業利益の見出しの下に来るよう、箱の中心をそろえて置く
      if (preMode) sT = Math.min(Math.max(oT + oH + 50, oT + oH + 116 + 62 - sH / 2), 850 - sH);
      flow(XSRC + NW, gT, gCut, XO, oT, oT + oH, PAL.gnflow); flow(XSRC + NW, gCut, gT + gH, XO, sT, sT + sH, PAL.sgaflow);
      node(XO, oT, oH, PAL.op); node(XO, sT, sH, PAL.sga);
      if (preMode) lines(XO + NW + 14, oT + oH - 4, [['営業利益', 28, 900, GT], [fmt(P.op), 28, 700, GT], ['利益率 ' + rt(P.op, P.rev).toFixed(1) + '%', 17, 500, M], [has(Pp.op) ? pp(rt(P.op, P.rev), rt(Pp.op, Pp.rev)) : '', 17, 500, M]], 'start');
      else lines(XO + NW / 2, oT - 150, [['営業利益', 32, 900, GT], [fmt(P.op), 32, 700, GT], ['利益率 ' + rt(P.op, P.rev).toFixed(1) + '%', 19, 500, M], [has(Pp.op) ? pp(rt(P.op, P.rev), rt(Pp.op, Pp.rev)) : '', 19, 500, M]]);
      var sgaLines = [[SGAN, 30, 900, PAL.sga], ['(' + fmt(P.sga) + ')', 28, 700, PAL.sga], ['売上の' + rt(P.sga, P.rev).toFixed(1) + '%', 18, 500, M]].concat(cfg.sgaNote ? [[cfg.sgaNote, 15, 500, M]] : []);
      // この形では販管費の見出しを箱の右に置き、図が下に伸びないようにする
      if (preMode) lines(XO + NW + 16, sT + sH / 2 - 62, sgaLines, 'start');
      else lines(XO + NW / 2, sT + sH + 8, sgaLines);
      if (preMode) {
        // 営業利益（上）と本業以外の利益（営業利益の箱の下に並べる）を、税引前利益の箱に集める
        var XP = XPcol, PW = 36, pT = 140, pV = P.op + inSum, pH = pV * k;
        // 箱の名前：引くものが税金だけなら税引前利益、日本基準で特別損失も引くなら経常利益、それ以外は利益の合計
        var onlyTax = outs.every(function (a) { return a[0] === TAXN; });
        var preName = ins.some(function (a) { return a[0] === '税金の戻り'; }) || P.disc ? '利益の合計'
          : onlyTax ? '税引前利益'
          : !cfg.ifrs && P.sp <= 0 && P.nonop > 0 && outs.every(function (a) { return a[0] === TAXN || a[0] === '特別損失'; }) ? '経常利益' : '利益の合計';
        // 税引前利益の箱の上の部分に本業以外の利益、下の部分に営業利益が入る
        var py = pT;
        ins.forEach(function (a, i) {
          var v = a[1], h = Hf(v), iy2 = insTops[i];
          ad('rect', { x: XO, y: iy2, width: NW, height: h, fill: PAL.op });
          flow(XO + NW, iy2, iy2 + v * k, XP, py, py + v * k, PAL.gnflow);
          lines(XO + NW / 2, iy2 - 64, [[a[0], 24, 900, GT], ['+' + fmt(v), 24, 700, GT]]);
          py += v * k;
        });
        flow(XO + NW, oT, oT + P.op * k, XP, py, py + P.op * k, PAL.gnflow);
        ad('rect', { x: XP, y: pT, width: PW, height: pH, fill: PAL.op });
        lines(XP + PW / 2, pT - 66, [[preName, 24, 900, GT], [fmt(pV), 24, 700, GT]]);
        // 税引前利益 → 当期純利益（上）・税金など（下）
        var nT2 = pT, nH2 = Hf(P.ni), op2 = pT;
        flow(XP + PW, op2, op2 + P.ni * k, XF, nT2, nT2 + nH2, PAL.gnflow); op2 += P.ni * k;
        var yN2 = Math.max(has(P.niParent) && P.niParent !== P.ni ? 290 : 262, nT2 + nH2 + 50);
        outs.forEach(function (a) {
          var yT = yN2, v = a[1]; yN2 = yT + Hf(v) + 52;
          flow(XP + PW, op2, op2 + v * k, XF, yT, yT + Hf(v), PAL.cogsflow); op2 += v * k; node(XF, yT, Hf(v), PAL.cogs);
          lines(XF + NW + 14, yT - 16, [[a[0] + ' (' + fmt(v) + ')', 20, 900]], 'start');
        });
        node(XF, nT2, nH2, PAL.ni);
        lines(XF + NW + 14, nT2 - 46, [['当期純利益', 30, 900, GT], [fmt(P.ni), 30, 700, GT], ['利益率 ' + rt(P.ni, P.rev).toFixed(1) + '%', 18, 500, M], [has(Pp.ni) ? pp(rt(P.ni, P.rev), rt(Pp.ni, Pp.rev)) : '', 18, 500, M]]
          .concat(has(P.niParent) && P.niParent !== P.ni ? [['うち親会社株主 ' + (P.niParent < 0 ? '△' : '') + fmt(Math.abs(P.niParent)), 18, 700, GT]] : []), 'start');
      } else if (P.ni >= 0) {
        var nT = 140, nH = Hf(P.ni), o = oT, ni0 = nT + inSum * k;
        flow(XO + NW, o, o + (P.ni - inSum) * k, XF, ni0, nT + P.ni * k, PAL.gnflow); o += (P.ni - inSum) * k;
        var hasParentLine = has(P.niParent) && P.niParent !== P.ni;
        var yNext = Math.max(hasParentLine ? 290 : 262, nT + nH + 50); // 「うち親会社株主」の行があるときは、その下に間をあける
        outs.forEach(function (a, i) {
          // 箱どうしが重ならないよう、前の箱の高さ＋すき間の下に置く
          var yT = yNext, v = a[1]; yNext = yT + Hf(v) + 52;
          flow(XO + NW, o, o + v * k, XF, yT, yT + Hf(v), PAL.cogsflow); o += v * k; node(XF, yT, Hf(v), PAL.cogs);
          lines(XF + NW + 14, yT - 16, [[a[0] + ' (' + fmt(v) + ')', 20, 900]], 'start');
        });
        var iy = nT;
        ins.forEach(function (a, i) {
          var ix = XO + NW + 96 + i * 88, iyy = 110, v = a[1]; // 2つあるときも、営業利益の見出しや互いに重ならない間隔
          ad('rect', { x: ix, y: iyy, width: 30, height: Math.max(v * k, 3), fill: PAL.op });
          flow(ix + 30, iyy, iyy + v * k, XF, iy, iy + v * k, PAL.gnflow); iy += v * k;
          lines(ix + 15, iyy - 52, [[a[0], ins.length > 1 ? 16 : 17, 700, GT], ['+' + fmt(v), ins.length > 1 ? 16 : 17, 700, GT]]);
        });
        node(XF, nT, nH, PAL.ni);
        lines(XF + NW + 14, nT - 46, [['当期純利益', 30, 900, GT], [fmt(P.ni), 30, 700, GT], ['利益率 ' + rt(P.ni, P.rev).toFixed(1) + '%', 18, 500, M], [has(Pp.ni) ? pp(rt(P.ni, P.rev), rt(Pp.ni, Pp.rev)) : '', 18, 500, M]]
          .concat(has(P.niParent) && P.niParent !== P.ni ? [['うち親会社株主 ' + (P.niParent < 0 ? '△' : '') + fmt(Math.abs(P.niParent)), 18, 700, GT]] : []), 'start');
      } else {
        // 営業利益は出たが、最後は純損失（雛形の形に合わせ、数字だけを示す）
        lines(XF - 60, 200, [['当期純損失', 30, 900, NEG], [(P.ni < 0 ? '△' : '') + fmt(Math.abs(P.ni)), 30, 700, NEG], ['利益率 ' + rts(P.ni, P.rev) + '%', 18, 500, M]], 'start');
      }
    } else {
      // 営業損失：売上総利益のすべてと、足りない分（営業損失）が販管費に流れる
      var sT2 = 300, sH2 = P.sga * k, lossH = -P.op * k;
      flow(XSRC + NW, gT, gT + gH, XO, sT2, sT2 + gH, PAL.sgaflow);
      // 売上総利益がない形では、営業費用の流れと重ならないよう、営業損失の箱を費用の箱の左下に置く
      var lx = noGP ? XO - 150 : XG + 120, ly = noGP ? Math.min(sT2 + sH2 + 40, 800) : 600;
      ad('rect', { x: lx, y: ly, width: 26, height: Math.max(lossH, 3), fill: NEG });
      flow(lx + 26, ly, ly + lossH, XO, sT2 + gH, sT2 + sH2, PAL.negflow);
      lines(noGP ? lx - 12 : lx + 40, ly - 14, [['営業損失', 26, 900, NEG], ['(' + fmt(-P.op) + ')', 26, 700, NEG], ['利益率 ' + rts(P.op, P.rev) + '%', 17, 500, M], [has(Pp.op) && has(Pp.rev) ? '前期は ' + rts(Pp.op, Pp.rev) + '%' : '', 17, 500, M]], noGP ? 'end' : 'start');
      node(XO, sT2, sH2, PAL.sga);
      // 販管費の名前は箱の下に（右側は本業以外の利益の流れに使う）
      lines(XO + NW / 2, sT2 + sH2 + 8, [[SGAN, 30, 900, PAL.sga], ['(' + fmt(P.sga) + ')', 28, 700, PAL.sga], ['売上の' + rt(P.sga, P.rev).toFixed(1) + '%', 18, 500, M]].concat(cfg.sgaNote ? [[cfg.sgaNote, 15, 500, M]] : []));
      // 本業以外の利益 → 当期純利益・税金・営業損失の穴埋め
      var niIn = { label: NONOPN, value: Math.max(P.nonop, 0) }, siIn = { label: P.disc ? '非継続事業の利益' : '特別利益', value: Math.max(P.sp, 0) }, inTot = niIn.value + siIn.value;
      if (inTot > 0 && P.ni > 0) {
        var IX = XO + NW + 122, IY = 130, h1 = niIn.value * k, h2 = siIn.value * k;
        ad('rect', { x: IX, y: IY, width: 30, height: h1, fill: PAL.op });
        ad('rect', { x: IX, y: IY + h1, width: 30, height: h2, fill: PAL.gnflow, stroke: PAL.op, 'stroke-width': 1 });
        lines(IX - 6, IY - 66, [[niIn.value ? niIn.label + ' +' + fmt(niIn.value) : '', 19, 900, GT], [siIn.value ? siIn.label + ' +' + fmt(siIn.value) : '', 19, 900, GT]]);
        var outs2 = [['当期純利益', P.ni, PAL.ni, PAL.gnflow, GT, 100], [TAXN, P.tax, PAL.cogs, PAL.cogsflow, PAL.fg, 190], ['営業損失の穴埋め', -P.op, NEG, PAL.negflow, NEG, 260], ['営業外費用・特別損失', inTot - P.ni - P.tax + P.op, PAL.cogs, PAL.cogsflow, PAL.fg, 330]].filter(function (a) { return a[1] > 0; });
        var o2 = IY, yNext2 = 100;
        outs2.forEach(function (a) {
          // 箱が大きくても重ならないよう、上から順に積む
          var lab = a[0], v = a[1], h = v * k, yT = yNext2; yNext2 = yT + Hf(v) + (lab === '当期純利益' ? 100 : 44);
          flow(IX + 30, o2, o2 + h, XF, yT, yT + Hf(v), a[3]); o2 += h; node(XF, yT, Hf(v), a[2]);
          if (lab === '当期純利益') lines(XF + NW + 14, yT - 46, [['当期純利益', 30, 900, a[4]], [fmt(v), 30, 700, a[4]], ['利益率 ' + rts(P.ni, P.rev) + '%', 18, 500, M], [has(Pp.ni) ? '前期は ' + rts(Pp.ni, Pp.rev) + '%' : '', 18, 500, M]], 'start');
          else lines(XF + NW + 14, yT - 16, [[lab + ' (' + fmt(v) + ')', 19, 900, a[4]]], 'start');
        });
        lines(XF + NW + 14, yNext2 - 30, [['本業以外の利益 ' + fmt(inTot) + ' の行き先', 15, 500, M]], 'start');
      } else {
        lines(XF - 60, 200, [['当期純損益', 30, 900, P.ni < 0 ? NEG : GT], [(P.ni < 0 ? '△' : '') + fmt(Math.abs(P.ni)), 30, 700, P.ni < 0 ? NEG : GT]], 'start');
      }
    }
    B.add('</g>');
    // 下の欄：左に出典と「美図決算：…」（題名と同じ大きさ）、右に開示日・©・note
    var baseY = Hh - 26, xL = OX + 20, xR = OX + 1700;
    B.text(xL, baseY, '美図決算：絵でみる経営成績', { size: TTL_SIZE, weight: 900, fill: PAL.rev, anchor: 'start' });
    B.text(xR, baseY, NOTE_URL, { size: 16, fill: M, anchor: 'end' });
    B.text(xR, baseY - 24, '©HIKICHI＆Company', { size: 18, weight: 700, fill: M, anchor: 'end' });
    // 注記と単位・出典は右下（日付の上）に、下から積む
    var fTop = baseY - 24 - 58; // ©から2行ほど離す
    footL.forEach(function (a, i) { B.text(xR, fTop - (footL.length - 1 - i) * 19, a[0], { size: a[1], fill: M, anchor: 'end' }); });
    return { svg: B.done(), width: W, height: Hh };
  }

  /* ================= 描画：絵でみるファイナンス（貸借対照表の雛形どおり） ================= */
  var BSC = {
    navy: '#2b3a67', asset: '#283862', aflow: 'rgba(160,201,240,0.62)', liab: '#b8bfcd', lflow: 'rgba(184,191,205,0.45)',
    eq: '#6bb3a4', eqStrong: '#1f6157', eflow: 'rgba(107,179,164,0.38)', liabText: '#4a5468', eqText: '#1d5a51', muted: '#7a8394'
  };
  /* ================= 配色パターン =================
   * 6色：資産・負債・資本（貸借対照表）と、収益・費用・利益（損益）。
   * 資産と収益、負債と費用、資本と利益は近い色に寄せる。
   * 「標準」は、これまでの配色（売上高＝紺、売上原価＝灰、販管費＝紫、利益＝緑）そのまま。 */
  var DEFAULT_PAL = JSON.parse(JSON.stringify(PAL)), DEFAULT_BSC = JSON.parse(JSON.stringify(BSC));
  var THEMES = [
    { id: 'standard', name: '標準', c: { asset: '#283862', revenue: '#2b3a67', liability: '#b8bfcd', cost: '#b3bac8', equity: '#6bb3a4', profit: '#55a37b', sga: '#8b6bb8' } },
    { id: 'wa', name: '和（藍・鈍色・松葉）', c: { asset: '#22406f', revenue: '#2c5088', liability: '#8f877b', cost: '#9c9488', equity: '#5a7a34', profit: '#6c8e3c', sga: '#6e5a7e' } },
    { id: 'yuubae', name: '夕映え', c: { asset: '#4a3c88', revenue: '#5a4b9c', liability: '#c6a685', cost: '#d0b292', equity: '#c4701c', profit: '#d68228', sga: '#9c6b8f', neg: '#7a1f2b' } },
    { id: 'pastel', name: 'パステル', c: { asset: '#6f97cc', revenue: '#83a9da', liability: '#d4b0b0', cost: '#dfbdbd', equity: '#7fbf9c', profit: '#8fcbaa', sga: '#b9a3d6' } },
    { id: 'mono', name: 'モノクロ（印刷向け）', c: { asset: '#2b2b2b', revenue: '#3a3a3a', liability: '#a3a3a3', cost: '#b2b2b2', equity: '#646464', profit: '#757575', sga: '#8a8a8a', neg: '#111111' } }
  ];
  function hex(c) { var n = parseInt(c.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
  function toHex(a) { return '#' + a.map(function (v) { return ('0' + Math.round(Math.max(0, Math.min(255, v))).toString(16)).slice(-2); }).join(''); }
  function mix(c, d, t) { var a = hex(c), b = hex(d); return toHex(a.map(function (v, i) { return v + (b[i] - v) * t; })); }
  function rgba(c, al) { var a = hex(c); return 'rgba(' + a[0] + ',' + a[1] + ',' + a[2] + ',' + al + ')'; }
  function lum(c) { var a = hex(c); return (0.299 * a[0] + 0.587 * a[1] + 0.114 * a[2]) / 255; }
  function ink(c) { var x = c; for (var i = 0; i < 6 && lum(x) > 0.5; i++) x = mix(x, '#000000', 0.18); return x; } // 文字は読める濃さまで暗くする
  function setTheme(id) {
    var t = THEMES.filter(function (x) { return x.id === id; })[0] || THEMES[0];
    if (t.id === 'standard') { Object.assign(PAL, DEFAULT_PAL); Object.assign(BSC, DEFAULT_BSC); return t.id; }
    var c = t.c, neg = c.neg || '#c0563f';
    Object.assign(PAL, {
      rev: c.revenue, segflow: rgba(c.revenue, 0.28),
      cogs: c.cost, cogsflow: rgba(c.cost, 0.55),
      sga: ink(c.sga), sgaflow: rgba(c.sga, 0.40),
      gp: mix(c.profit, '#ffffff', 0.3), op: c.profit, ord: ink(mix(c.profit, '#000000', 0.2)), ni: mix(c.profit, '#000000', 0.3),
      gnflow: rgba(mix(c.profit, '#ffffff', 0.3), 0.45), neg: neg, negflow: rgba(neg, 0.35)
    });
    Object.assign(BSC, {
      navy: ink(c.asset), asset: c.asset, aflow: rgba(mix(c.asset, '#ffffff', 0.62), 0.62),
      liab: c.liability, lflow: rgba(c.liability, 0.45), liabText: ink(mix(c.liability, '#000000', 0.45)),
      eq: mix(c.equity, '#ffffff', 0.15), eqStrong: mix(c.equity, '#000000', 0.35), eflow: rgba(c.equity, 0.36), eqText: ink(mix(c.equity, '#000000', 0.4))
    });
    return t.id;
  }
  function themes() { return THEMES.map(function (t) { var c = t.c; return { id: t.id, name: t.name, swatch: [c.asset, c.revenue, c.liability, c.cost, c.equity, c.profit] }; }); }

  function renderBS(cfg, opt) {
    var noteLines = [];
    var nt = ''; // 長い注記は載せない（図をすっきり見せる）
    for (var ni = 0; ni < nt.length; ni += 104) noteLines.push(nt.slice(ni, ni + 104)); // 右下の開示日にかからない幅
    var EXT = Math.max(0, noteLines.length - 2) * 22;
    var W = 2000, H = 1160 + EXT, B = svgBuilder(W, H), U = cfg.unit;
    var f = function (v) { return Math.round(v / U.div).toLocaleString('ja-JP'); };
    var pct = function (v) { return '総資産の' + (v / cfg.total * 100).toFixed(1) + '%'; };
    var NW = 54, XL = 1000 - 560, XRt = 1000 + 560 - NW, XC = (XL + XRt) / 2, /* 総資産の柱を真ん中に：左右の流れの横幅をそろえる */ SPAN = 546, k = SPAN / cfg.total;
    function rect(x, y, h, c) { B.add('<rect x="' + x + '" y="' + y.toFixed(1) + '" width="' + NW + '" height="' + Math.max(h, 2).toFixed(1) + '" fill="' + c + '"/>'); }
    function band(x0, a0, b0, x1, a1, b1, c) {
      var m = (x0 + x1) / 2;
      B.add('<path d="M' + x0 + ',' + a0 + ' C' + m + ',' + a0 + ' ' + m + ',' + a1 + ' ' + x1 + ',' + a1 + ' L' + x1 + ',' + b1 + ' C' + m + ',' + b1 + ' ' + m + ',' + b0 + ' ' + x0 + ',' + b0 + ' Z" fill="' + c + '" stroke="' + c + '" stroke-width="0.6"/>');
    }
    var ttlB = cfg.name + '（' + cfg.code + '）' + (opt && opt.period ? '　' + opt.period : '');
    var TTLB_SIZE = ttlB.length > 26 ? 46 : 52;
    B.text(W / 2, 92, ttlB, { size: TTLB_SIZE, weight: 900, fill: BSC.navy });
    // 図の本体は少し小さくして、下に余白をつくる
    var scXB = W / 2, scYB = 130;
    B.add('<g transform="translate(' + scXB + ' ' + (scYB + 0) + ') scale(1) translate(' + (-scXB) + ' ' + (-scYB) + ')">');

    // 中央：総資産
    var cT = 303, cB = cT + SPAN;
    rect(XC, cT, SPAN, BSC.asset);
    B.text(XC + NW / 2, 208, '総資産', { size: 32, weight: 900, fill: BSC.navy });
    B.text(XC + NW / 2, 248, f(cfg.total), { size: 34, weight: 700, fill: BSC.navy });
    if (cfg.totalPrev) {
      var ch = (cfg.total / cfg.totalPrev - 1) * 100;
      B.text(XC + NW / 2, 282, '前期末比 ' + (ch >= 0 ? '+' : '△') + Math.abs(ch).toFixed(1) + '%', { size: 19, fill: BSC.muted });
    }

    // 左：資産の内訳（198〜972の帯に等間隔）
    // 小さい箱でも名前・金額・割合の3行が重ならないよう、箱ごとに最低の高さ（枠）をとり、箱は枠の真ん中に置く
    var A = cfg.assets, hs = A.map(function (a) { return Math.max(a.v * k, 6); });
    var MINS = 78, slotsA = hs.map(function (h) { return Math.max(h, MINS); });
    var gapL = A.length > 1 ? Math.max(4, (774 - slotsA.reduce(function (s, h) { return s + h; }, 0)) / (A.length - 1)) : 0;
    var blockA = slotsA.reduce(function (s, h) { return s + h; }, 0) + gapL * (A.length - 1);
    var y = 198 + Math.max(0, (774 - blockA) / 2), cut = cT;
    A.forEach(function (a, i) {
      var h = hs[i], hv = a.v * k, ny = y + (slotsA[i] - h) / 2;
      rect(XL, ny, h, BSC.asset);
      band(XL + NW, ny, ny + hv, XC, cut, cut + hv, BSC.aflow);
      var cy = y + slotsA[i] / 2;
      B.text(XL - 30, cy - 14, a.label, { size: 22, weight: 900, fill: BSC.navy, anchor: 'end' });
      B.text(XL - 30, cy + 13, f(a.v), { size: 21, fill: BSC.navy, anchor: 'end' });
      B.text(XL - 30, cy + 36, pct(a.v), { size: 16, fill: BSC.muted, anchor: 'end' });
      cut += hv; y += slotsA[i] + gapL;
    });

    // 右：負債と純資産（226〜946の帯に等間隔）
    var R = cfg.right, rh = R.map(function (r) { return Math.max(r.v * k, 2); });
    var gapR = R.length > 1 ? (720 - rh.reduce(function (s, h) { return s + h; }, 0)) / (R.length - 1) : 0;
    var ry = 226, rc = cT, liabTop = null, liabBot = null, eqTop = null, eqBot = null, ryLiab = [], ryEq = [];
    R.forEach(function (r, i) {
      var h = rh[i], hv = r.v * k, isL = r.kind === 'liab';
      var col = isL ? BSC.liab : (r.strong && R.filter(function (x) { return x.kind === 'eq'; }).length > 1 && hv > SPAN * 0.5 ? BSC.eqStrong : BSC.eq);
      band(XC + NW, rc, rc + hv, XRt, ry, ry + hv, isL ? BSC.lflow : BSC.eflow);
      rect(XRt, ry, h, col);
      if (isL) { ryLiab.push([rc, rc + hv, ry, ry + hv]); } else { ryEq.push([rc, rc + hv, ry, ry + hv]); }
      var tc = isL ? BSC.liabText : BSC.eqText, last = i === R.length - 1;
      if (false) {
        // いちばん下は、右下の箱と重ならないよう上に2行で書く
        B.text(XRt + NW + 28, ry - 74, r.label, { size: 22, weight: 900, fill: tc, anchor: 'start' });
        B.text(XRt + NW + 28, ry - 46, f(r.v) + '（' + pct(r.v) + '）', { size: 20, fill: tc, anchor: 'start' });
      } else {
        var cy = Math.max(ry + h / 2, ry + 10);
        B.text(XRt + NW + 28, cy - 14, r.label, { size: 22, weight: 900, fill: tc, anchor: 'start' });
        B.text(XRt + NW + 28, cy + 13, f(r.v), { size: 21, fill: tc, anchor: 'start' });
        B.text(XRt + NW + 28, cy + 36, pct(r.v), { size: 16, fill: BSC.muted, anchor: 'start' });
      }
      rc += hv; ry += h + gapR;
    });
    // 帯の中ほどに「負債」「純資産」
    function midLabel(spans, title, v, color) {
      if (!spans.length) return;
      var a = spans[0], b = spans[spans.length - 1];
      var yMid = ((a[0] + b[1]) / 2 + (a[2] + b[3]) / 2) / 2;
      B.text((XC + NW + XRt) / 2, yMid - 4, title + ' ' + f(v), { size: 23, weight: 900, fill: color });
      B.text((XC + NW + XRt) / 2, yMid + 20, pct(v), { size: 16, fill: color });
    }
    midLabel(ryLiab, '負債', cfg.liab, BSC.liabText);
    midLabel(ryEq, '純資産', cfg.netAssets, BSC.eqText);

    // 足もと
    B.add('</g>');
    noteLines.forEach(function (t, i) { B.text(40, 1078 + EXT - (noteLines.length - 1 - i) * 22, t, { size: 15, fill: BSC.muted, anchor: 'start' }); });
    var srcDateB = splitDate(cfg.source);
    var bY = H - 28;
    B.text(40, bY, '美図決算：絵でみる財政状態', { size: TTLB_SIZE, weight: 900, fill: BSC.navy, anchor: 'start' });
    B.text(1960, bY, NOTE_URL, { size: 17, fill: BSC.muted, anchor: 'end' });
    B.text(1960, bY - 26, '©HIKICHI＆Company', { size: 19, weight: 700, fill: BSC.navy, anchor: 'end' });
    B.text(1960, bY - 26 - 58, '単位：' + U.name + '｜出典：' + srcDateB.src, { size: 16, fill: BSC.muted, anchor: 'end' });
    return { svg: B.done(), width: W, height: H };
  }

  var api = { extractPL: extractPL, extractBS: extractBS, renderPL: renderPL, renderBS: renderBS, fyCode: fyCode, periodLabel: periodLabel, setTheme: setTheme, themes: themes };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Kessan = api;
})(this);
