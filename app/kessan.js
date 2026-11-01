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

  /* ---------- 損益：sk.js の CONFIG と同じ形に組み立てる ---------- */
  function extractPL(files, DP, meta) {
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
      var sgaAct = T.val(['SellingGeneralAndAdministrativeExpenses', 'SellingGeneralAndAdministrativeExpensesIFRS'], ctx);
      var opDerived = false;
      if (op === undefined && ifrs && pre !== undefined) {
        var fin = (T.val(['FinanceIncomeIFRS'], ctx) || 0) - (T.val(['FinanceCostsIFRS'], ctx) || 0) + (T.val(['ShareOfProfitLossOfInvestmentsAccountedForUsingEquityMethodIFRS'], ctx) || 0);
        op = pre - fin; opDerived = true;
      }
      if (rev === undefined || op === undefined || ni === undefined) return null;
      if (pre === undefined) pre = ord !== undefined ? ord : op;
      var o = { opDerived: opDerived, rev: rev, gp: gp, cogs: gp !== undefined ? rev - gp : undefined, op: op, sga: gp !== undefined ? gp - op : rev - op, sgaAct: sgaAct, ni: ni, pre: pre, tax: pre - ni };
      if (!ifrs && ord !== undefined) { o.nonop = ord - op; o.sp = pre - ord; o.ord = ord; }
      else { o.nonop = pre - op; o.sp = 0; o.ord = pre; }
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
    var EXT = ['RevenuesFromExternalCustomers', 'RevenueFromExternalCustomersIFRS'];
    var PROF = ['OperatingIncome', 'OperatingProfitLossIFRS', 'SegmentProfitLoss', 'SegmentProfitLossIFRS', 'OrdinaryIncome'];
    var sc = T.byMember(EXT, cur), sp = pri ? T.byMember(EXT, pri) : {}, pc = T.byMember(PROF, cur), pp = pri ? T.byMember(PROF, pri) : {};
    var segs = Object.keys(sc).filter(function (k) { return !SEG_SKIP.test(k) && sc[k] > 0; }).map(function (k) {
      var lbl = T.data.memberLabels[k] || (/OperatingSegmentsNotIncluded/.test(k) ? 'その他' : k.replace(/(ReportableSegments?)?Member$/, ''));
      lbl = lbl.replace(/セグメント$/, '');
      return { name: lbl, sales: sc[k], salesPrev: sp[k], profit: pc[k] !== undefined ? pc[k] : null, profitPrev: pp[k] };
    });
    segs.sort(function (a, b) { return b.sales - a.sales; });
    var segSum = segs.reduce(function (a, b) { return a + b.sales; }, 0), segNote = null;
    if (segs.length < 2 || segSum > c.rev * 1.001 || segSum < c.rev * 0.5) {
      segs = [{ name: '単一セグメント', sales: c.rev, salesPrev: p.rev, profit: null, single: true }];
      segNote = '単一セグメントのため、売上の内訳は開示なし';
    } else {
      var rest = c.rev - segSum;
      if (rest > c.rev * 0.001) segs.push({ name: '調整額など', sales: rest, salesPrev: p.rev !== undefined ? p.rev - Object.keys(sp).filter(function (k) { return !SEG_SKIP.test(k); }).reduce(function (a, k) { return a + sp[k]; }, 0) : undefined, profit: null });
      if (segs.some(function (s) { return s.profit !== null; })) segNote = 'セグメントの利益率はセグメント利益ベース（全社費用などの調整前）';
    }

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
    T.att.forEach(function (f) { if (f.label && !labelOf[f.concept]) labelOf[f.concept] = f.label; });

    var leaves = [];
    function walk(c, sign, depth) {
      var k = kids(c);
      var name = ln(c);
      // 日本基準：有形・無形固定資産は合計のまま、投資その他の資産は中身に分ける
      var keep = /^(PropertyPlantAndEquipment|IntangibleAssets|IntangibleAssetsIFRS|PropertyPlantAndEquipmentIFRS)$/.test(name);
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
      // 引当金の相手：同じ区分の債権（破産更生債権・貸付金・立替金・未収・売掛・保証金など）で、引当金より大きいもの
      var same = leaves.filter(function (x) { return x !== l && x.p === l.p && x.val > 0; });
      var isClaim = function (x) { return /ClaimsProvable|Bankruptcy|Loans|Receivable|Advance|Guarantee|Deposit/i.test(ln(x.c)) || /債権|貸付|立替|未収|売掛|保証金|差入/.test(labelOf[x.c] || ''); };
      var cand = same.filter(isClaim).filter(function (x) { return x.val >= -l.val; });
      if (!cand.length) cand = same.filter(function (x) { return x.val >= -l.val; });
      cand.sort(function (a, b) { return (/ClaimsProvable|Bankruptcy/i.test(ln(b.c)) ? 1 : 0) - (/ClaimsProvable|Bankruptcy/i.test(ln(a.c)) ? 1 : 0) || b.val - a.val; });
      var tgt = cand[0];
      if (tgt) { tgt.val += l.val; if (tgt.pv !== undefined && l.pv !== undefined) tgt.pv += l.pv; tgt.netted = true; l.val = undefined; }
    });
    leaves.forEach(function (l) {
      var val = l.val; if (val === undefined) return;
      var pv = l.pv;
      var base = ln(l.c).replace(/(CA|NCA|IOA)?(IFRS)?$/, '').replace(/(CA|NCA|IOA)$/, '');
      var lab = (labelOf[l.c] || base).replace(/[\s　]+/g, '').replace(/合計$/, '');
      var key = ifrs ? base : l.c;
      // 日本基準で棚卸資産が品目ごとに分かれている場合は、まとめて「棚卸資産」にする
      if (/^(Merchandise|FinishedGoods|MerchandiseAndFinishedGoods|WorkInProcess|RawMaterials|Supplies|RawMaterialsAndSupplies|CostsOnUncompletedConstructionContracts|RealEstateForSale|Inventories)$/.test(base)) { key = '__INV'; lab = '棚卸資産'; }
      var g = groups[key] = groups[key] || { label: lab, v: 0, pv: 0, n: 0, havePrior: true, concepts: [], inv: key === '__INV', netted: false, ord: 1e9 };
      g.ord = Math.min(g.ord, orderOf[l.c] !== undefined ? orderOf[l.c] : 1e9);
      g.v += val; g.pv += (pv || 0); g.n++; g.concepts.push((labelOf[l.c] || base).replace(/[\s　]+/g, ''));
      if (l.netted) g.netted = true;
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
      else if (g.n > 1) notes.push(g.label + 'は流動＋非流動の合計');
      if (g.netted) notes.push(g.label + 'は貸倒引当金を差し引き後');
    });
    if (otherSum > 0) {
      assets.push({ label: ifrs ? 'その他の資産' : 'その他', v: otherSum });
      var parts = others.filter(function (g) { return g.v > 0 && g.label !== 'その他'; }).sort(function (a, b) { return b.v - a.v; }).map(function (g) { return g.label.replace(/^その他の?/, 'その他'); });
      var uniq = parts.filter(function (x, i) { return parts.indexOf(x) === i; });
      var neg = others.some(function (g) { return g.v < 0; });
      notes.push((ifrs ? 'その他の資産' : 'その他') + 'は' + uniq.slice(0, 6).join('・') + (uniq.length > 6 || others.some(function (g) { return g.label === 'その他'; }) ? 'など' : '') + 'の合計' + (neg ? '（貸倒引当金を差し引き後）' : ''));
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

  function renderPL(cfg) {
    // プロジェクトの engine.js の drawSankey と同じ配置（1720×1020、ふち30/20）
    var W = 1780, Hh = 1060, OX = 30, OY = 20;
    var B = svgBuilder(W, Hh);
    var P = cfg.cur, Pp = cfg.prev || {}, segs = cfg.segments || [], U = cfg.unit;
    var k = 360 / P.rev, NW = 44;
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
    B.text(OX + 860, OY + 76, '絵でみる儲けの流れ：' + cfg.name + '（' + cfg.code + '）', { size: cfg.name.length > 14 ? 52 : 60, weight: 900 });
    gy = 92;
    var XS = 310, XR = 600, XG = 880, XO = 1150, XF = 1420;
    var rT = 300, rB = rT + P.rev * k;
    // セグメント
    var segSum = segs.reduce(function (a, b) { return a + b.sales; }, 0) || 1;
    var gapS = segs.length > 1 ? Math.min(120, (560 - P.rev * k) / (segs.length - 1)) : 0;
    var sy = segs.length > 1 ? 160 : rT, cut = rT;
    if (segs.length > 2) {
      var MINH = 86, hs = segs.map(function (sg) { return sg.sales / segSum * P.rev * k; }), slots = hs.map(function (h) { return Math.max(h, MINH); });
      var g = Math.max(10, Math.min(60, (540 - slots.reduce(function (a, b) { return a + b; }, 0)) / (segs.length - 1)));
      var y = 120;
      segs.forEach(function (sg, i) {
        var h = hs[i], ny = y + (slots[i] - h) / 2;
        node(XS, ny, h, PAL.rev); flow(XS + NW, ny, ny + h, XR, cut, cut + h, PAL.segflow);
        var pr = sg.profit == null ? '売上の' + (sg.sales / segSum * 100).toFixed(1) + '%' :
          '利益率 ' + rts(sg.profit, sg.sales) + '%' + (has(sg.profitPrev) && has(sg.salesPrev) ? '（' + pp(rt(sg.profit, sg.sales), rt(sg.profitPrev, sg.salesPrev)).replace(' 前年比', '') + '）' : '');
        var yy = yoy(sg.sales, sg.salesPrev);
        lines(XS - 20, y + slots[i] / 2 - 42, [[sg.name, 26, 900], [fmt(sg.sales) + (yy ? '　' + yy : ''), 19, 700], [pr, 17, 500, M]], 'end');
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
    // 注記は左下の空いた所に、売上原価のラベルにかからない幅（48字）で折り返す
    var notesF = [];
    [cfg.ifrsNote, cfg.segNote].filter(Boolean).forEach(function (t) { for (var i = 0; i < t.length; i += 48) notesF.push(t.slice(i, i + 48)); });
    notesF.forEach(function (t, i) { var pn = T(20, 860 - (notesF.length - 1 - i) * 20); B.text(pn[0], pn[1], t, { size: 15, fill: M, anchor: 'start' }); });
    node(XR, rT, rB - rT, PAL.rev);
    lines(XR + NW / 2, rT - 128, [['売上高', 32, 900], [fmt(P.rev), 32, 700], [yoy(P.rev, Pp.rev), 19, 500, M]]);
    var gT = 230, gH = P.gp * k, cH = P.cogs * k, cT = Math.max(gT + gH + 60, Math.min(680, 860 - cH - 110)), rCut = rT + P.gp * k;
    flow(XR + NW, rT, rCut, XG, gT, gT + gH, PAL.gnflow); flow(XR + NW, rCut, rB, XG, cT, cT + cH, PAL.cogsflow);
    node(XG, gT, gH, PAL.gp); node(XG, cT, cH, PAL.cogs);
    lines(XG + NW / 2, gT - 150, [['売上総利益', 32, 900, GT], [fmt(P.gp), 32, 700, GT], ['粗利率 ' + rt(P.gp, P.rev).toFixed(1) + '%', 19, 500, M], [has(Pp.gp) ? pp(rt(P.gp, P.rev), rt(Pp.gp, Pp.rev)) : '', 19, 500, M]]);
    lines(XG + NW / 2, cT + cH + 6, [['売上原価', 30, 900], ['(' + fmt(P.cogs) + ')', 28, 700], ['売上の' + rt(P.cogs, P.rev).toFixed(1) + '%', 18, 500, M], [has(Pp.cogs) ? pp(rt(P.cogs, P.rev), rt(Pp.cogs, Pp.rev)) : '', 18, 500, M]]);
    var SGAN = cfg.sgaName, NONOPN = cfg.nonopName, TAXN = cfg.ifrs ? '法人所得税' : '法人税等';
    if (P.op >= 0) {
      var oT = 170, oH = Hf(P.op), sT = Math.max(440, oT + oH + 60), sH = P.sga * k, gCut = gT + P.op * k;
      flow(XG + NW, gT, gCut, XO, oT, oT + oH, PAL.gnflow); flow(XG + NW, gCut, gT + gH, XO, sT, sT + sH, PAL.sgaflow);
      node(XO, oT, oH, PAL.op); node(XO, sT, sH, PAL.sga);
      lines(XO + NW / 2, oT - 150, [['営業利益', 32, 900, GT], [fmt(P.op), 32, 700, GT], ['利益率 ' + rt(P.op, P.rev).toFixed(1) + '%', 19, 500, M], [has(Pp.op) ? pp(rt(P.op, P.rev), rt(Pp.op, Pp.rev)) : '', 19, 500, M]]);
      lines(XO + NW / 2, sT + sH + 8, [[SGAN, 30, 900, PAL.sga], ['(' + fmt(P.sga) + ')', 28, 700, PAL.sga], ['売上の' + rt(P.sga, P.rev).toFixed(1) + '%', 18, 500, M]].concat(cfg.sgaNote ? [[cfg.sgaNote, 15, 500, M]] : []));
      // 営業利益 → 当期純利益・税金・営業外や特別の損失（利益の流入は上から入れる）
      var outs = [[TAXN, P.tax]].concat(P.nonop < 0 ? [[NONOPN, -P.nonop]] : []).concat(P.sp < 0 ? [['特別損失', -P.sp]] : []).filter(function (a) { return a[1] > 0; });
      var ins = [].concat(P.nonop > 0 ? [[NONOPN, P.nonop]] : []).concat(P.sp > 0 ? [['特別損益', P.sp]] : []).concat(P.tax < 0 ? [['税金の戻り', -P.tax]] : []);
      var inSum = ins.reduce(function (a, b) { return a + b[1]; }, 0);
      if (P.ni >= 0) {
        var nT = 140, nH = Hf(P.ni), o = oT, ni0 = nT + inSum * k;
        flow(XO + NW, o, o + (P.ni - inSum) * k, XF, ni0, nT + P.ni * k, PAL.gnflow); o += (P.ni - inSum) * k;
        outs.forEach(function (a, i) {
          var yT = Math.max(262, nT + nH + 50) + i * 64, v = a[1];
          flow(XO + NW, o, o + v * k, XF, yT, yT + Hf(v), PAL.cogsflow); o += v * k; node(XF, yT, Hf(v), PAL.cogs);
          lines(XF + NW + 14, yT - 16, [[a[0] + ' (' + fmt(v) + ')', 20, 900]], 'start');
        });
        var iy = nT;
        ins.forEach(function (a, i) {
          var ix = 1300 - i * 70, iyy = 110, v = a[1];
          ad('rect', { x: ix, y: iyy, width: 30, height: Math.max(v * k, 3), fill: PAL.op });
          flow(ix + 30, iyy, iyy + v * k, XF, iy, iy + v * k, PAL.gnflow); iy += v * k;
          lines(ix + 15, iyy - 52, [[a[0], 17, 700, GT], ['+' + fmt(v), 17, 700, GT]]);
        });
        node(XF, nT, nH, PAL.ni);
        lines(XF + NW + 14, nT - 46, [['当期純利益', 30, 900, GT], [fmt(P.ni), 30, 700, GT], ['利益率 ' + rt(P.ni, P.rev).toFixed(1) + '%', 18, 500, M], [has(Pp.ni) ? pp(rt(P.ni, P.rev), rt(Pp.ni, Pp.rev)) : '', 18, 500, M]], 'start');
      } else {
        // 営業利益は出たが、最後は純損失（雛形の形に合わせ、数字だけを示す）
        lines(XF - 60, 200, [['当期純損失', 30, 900, NEG], [(P.ni < 0 ? '△' : '') + fmt(Math.abs(P.ni)), 30, 700, NEG], ['利益率 ' + rts(P.ni, P.rev) + '%', 18, 500, M]], 'start');
      }
    } else {
      // 営業損失：売上総利益のすべてと、足りない分（営業損失）が販管費に流れる
      var sT2 = 300, sH2 = P.sga * k, lossH = -P.op * k;
      flow(XG + NW, gT, gT + gH, XO, sT2, sT2 + gH, PAL.sgaflow);
      var lx = 1000, ly = 600;
      ad('rect', { x: lx, y: ly, width: 26, height: Math.max(lossH, 3), fill: NEG });
      flow(lx + 26, ly, ly + lossH, XO, sT2 + gH, sT2 + sH2, PAL.negflow);
      lines(lx + 40, ly - 14, [['営業損失', 26, 900, NEG], ['(' + fmt(-P.op) + ')', 26, 700, NEG], ['利益率 ' + rts(P.op, P.rev) + '%', 17, 500, M], [has(Pp.op) && has(Pp.rev) ? '前期は ' + rts(Pp.op, Pp.rev) + '%' : '', 17, 500, M]], 'start');
      node(XO, sT2, sH2, PAL.sga);
      lines(XO + NW + 12, sT2 + 10, [[SGAN, 30, 900, PAL.sga], ['(' + fmt(P.sga) + ')', 28, 700, PAL.sga], ['売上の' + rt(P.sga, P.rev).toFixed(1) + '%', 18, 500, M]].concat(cfg.sgaNote ? [[cfg.sgaNote, 15, 500, M]] : []), 'start');
      // 本業以外の利益 → 当期純利益・税金・営業損失の穴埋め
      var niIn = { label: NONOPN, value: Math.max(P.nonop, 0) }, siIn = { label: '特別利益', value: Math.max(P.sp, 0) }, inTot = niIn.value + siIn.value;
      if (inTot > 0 && P.ni > 0) {
        var IX = 1250, IY = 130, h1 = niIn.value * k, h2 = siIn.value * k;
        ad('rect', { x: IX, y: IY, width: 30, height: h1, fill: PAL.op });
        ad('rect', { x: IX, y: IY + h1, width: 30, height: h2, fill: PAL.gnflow, stroke: PAL.op, 'stroke-width': 1 });
        lines(IX - 12, IY - 60, [[niIn.value ? niIn.label + ' +' + fmt(niIn.value) : '', 20, 900, GT], ['', 15], [siIn.value ? siIn.label + ' +' + fmt(siIn.value) : '', 20, 900, GT], ['', 15]], 'end');
        var outs2 = [['当期純利益', P.ni, PAL.ni, PAL.gnflow, GT, 100], [TAXN, P.tax, PAL.cogs, PAL.cogsflow, PAL.fg, 190], ['営業損失の穴埋め', -P.op, NEG, PAL.negflow, NEG, 260], ['営業外費用・特別損失', inTot - P.ni - P.tax + P.op, PAL.cogs, PAL.cogsflow, PAL.fg, 330]].filter(function (a) { return a[1] > 0; });
        var o2 = IY;
        outs2.forEach(function (a) {
          var lab = a[0], v = a[1], h = v * k, yT = a[5];
          flow(IX + 30, o2, o2 + h, XF, yT, yT + Hf(v), a[3]); o2 += h; node(XF, yT, Hf(v), a[2]);
          if (lab === '当期純利益') lines(XF + NW + 14, yT - 46, [['当期純利益', 30, 900, a[4]], [fmt(v), 30, 700, a[4]], ['利益率 ' + rts(P.ni, P.rev) + '%', 18, 500, M], [has(Pp.ni) ? '前期は ' + rts(Pp.ni, Pp.rev) + '%' : '', 18, 500, M]], 'start');
          else lines(XF + NW + 14, yT - 16, [[lab + ' (' + fmt(v) + ')', 19, 900, a[4]]], 'start');
        });
        lines(XF + NW + 14, 370, [['本業以外の利益 ' + fmt(inTot) + ' の行き先', 15, 500, M]], 'start');
      } else {
        lines(XF - 60, 200, [['当期純損益', 30, 900, P.ni < 0 ? NEG : GT], [(P.ni < 0 ? '△' : '') + fmt(Math.abs(P.ni)), 30, 700, P.ni < 0 ? NEG : GT]], 'start');
      }
    }
    var pc = T(1700, 900); B.text(pc[0], pc[1], '©HIKICHI＆Company', { size: 18, weight: 700, fill: M, anchor: 'end' });
    var ps = T(20, 900); B.text(ps[0], ps[1], '単位：' + U.name + '｜出典：' + cfg.source, { size: 17, fill: M, anchor: 'start' });
    return { svg: B.done(), width: W, height: Hh };
  }

  /* ================= 描画：絵でみるファイナンス（貸借対照表の雛形どおり） ================= */
  var BSC = {
    navy: '#2b3a67', asset: '#283862', aflow: 'rgba(160,201,240,0.62)', liab: '#b8bfcd', lflow: 'rgba(184,191,205,0.45)',
    eq: '#6bb3a4', eqStrong: '#1f6157', eflow: 'rgba(107,179,164,0.38)', liabText: '#4a5468', eqText: '#1d5a51', muted: '#7a8394'
  };
  function renderBS(cfg) {
    var W = 2000, H = 1160, B = svgBuilder(W, H), U = cfg.unit;
    var f = function (v) { return Math.round(v / U.div).toLocaleString('ja-JP'); };
    var pct = function (v) { return '総資産の' + (v / cfg.total * 100).toFixed(1) + '%'; };
    var NW = 54, XL = 420, XC = 780, XRt = 1328, SPAN = 546, k = SPAN / cfg.total;
    function rect(x, y, h, c) { B.add('<rect x="' + x + '" y="' + y.toFixed(1) + '" width="' + NW + '" height="' + Math.max(h, 2).toFixed(1) + '" fill="' + c + '"/>'); }
    function band(x0, a0, b0, x1, a1, b1, c) {
      var m = (x0 + x1) / 2;
      B.add('<path d="M' + x0 + ',' + a0 + ' C' + m + ',' + a0 + ' ' + m + ',' + a1 + ' ' + x1 + ',' + a1 + ' L' + x1 + ',' + b1 + ' C' + m + ',' + b1 + ' ' + m + ',' + b0 + ' ' + x0 + ',' + b0 + ' Z" fill="' + c + '" stroke="' + c + '" stroke-width="0.6"/>');
    }
    B.text(W / 2, 92, '絵でみるファイナンス：' + cfg.name + '（' + cfg.code + '）', { size: cfg.name.length > 16 ? 46 : 52, weight: 900, fill: BSC.navy });

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
    var A = cfg.assets, hs = A.map(function (a) { return Math.max(a.v * k, 6); });
    var gapL = A.length > 1 ? (774 - hs.reduce(function (s, h) { return s + h; }, 0)) / (A.length - 1) : 0;
    var y = 198, cut = cT, lastCy = -1e9;
    A.forEach(function (a, i) {
      var h = hs[i], hv = a.v * k;
      rect(XL, y, h, BSC.asset);
      band(XL + NW, y, y + hv, XC, cut, cut + hv, BSC.aflow);
      var cy = Math.max(y + h / 2, lastCy + 74); lastCy = cy;
      B.text(390, cy - 14, a.label, { size: 22, weight: 900, fill: BSC.navy, anchor: 'end' });
      B.text(390, cy + 13, f(a.v), { size: 21, fill: BSC.navy, anchor: 'end' });
      B.text(390, cy + 36, pct(a.v), { size: 16, fill: BSC.muted, anchor: 'end' });
      cut += hv; y += h + gapL;
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
        B.text(1410, ry - 74, r.label, { size: 22, weight: 900, fill: tc, anchor: 'start' });
        B.text(1410, ry - 46, f(r.v) + '（' + pct(r.v) + '）', { size: 20, fill: tc, anchor: 'start' });
      } else {
        var cy = Math.max(ry + h / 2, ry + 10);
        B.text(1410, cy - 14, r.label, { size: 22, weight: 900, fill: tc, anchor: 'start' });
        B.text(1410, cy + 13, f(r.v), { size: 21, fill: tc, anchor: 'start' });
        B.text(1410, cy + 36, pct(r.v), { size: 16, fill: BSC.muted, anchor: 'start' });
      }
      rc += hv; ry += h + gapR;
    });
    // 帯の中ほどに「負債」「純資産」
    function midLabel(spans, title, v, color) {
      if (!spans.length) return;
      var a = spans[0], b = spans[spans.length - 1];
      var yMid = ((a[0] + b[1]) / 2 + (a[2] + b[3]) / 2) / 2;
      B.text(1083, yMid - 4, title + ' ' + f(v), { size: 23, weight: 900, fill: color });
      B.text(1083, yMid + 20, pct(v), { size: 16, fill: color });
    }
    midLabel(ryLiab, '負債', cfg.liab, BSC.liabText);
    midLabel(ryEq, '純資産', cfg.netAssets, BSC.eqText);

    // 足もと
    if (cfg.notes && cfg.notes.length) B.text(40, 1094, cfg.notes.join('。'), { size: 16, fill: BSC.muted, anchor: 'start' });
    B.text(40, 1130, '単位：' + U.name + '｜出典：' + cfg.source, { size: 17, fill: BSC.muted, anchor: 'start' });
    B.text(1960, 1130, '©HIKICHI＆Company', { size: 19, weight: 700, fill: BSC.navy, anchor: 'end' });
    return { svg: B.done(), width: W, height: H };
  }

  var api = { extractPL: extractPL, extractBS: extractBS, renderPL: renderPL, renderBS: renderBS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Kessan = api;
})(this);
