/*
 * 決算短信（TDnet XBRL）から損益の流れを読み取る。
 * ブラウザ（WebView）とNode（テスト）の両方で動くように、DOMParserは外から受け取る。
 */
(function (root) {
  'use strict';

  var NS_IX = ['http://www.xbrl.org/2008/inlineXBRL', 'http://www.xbrl.org/2013/inlineXBRL'];
  var NS_XBRLI = 'http://www.xbrl.org/2003/instance';
  var NS_XBRLDI = 'http://xbrl.org/2006/xbrldi';
  var NS_LINK = 'http://www.xbrl.org/2003/linkbase';
  var NS_XLINK = 'http://www.w3.org/1999/xlink';

  // 見慣れた短い呼び名（会社ごとの長い表記より優先）
  var SHORT = {
    NetSales: '売上高', RevenueIFRS: '売上収益', NetSalesIFRS: '売上高', OperatingRevenue1: '営業収益',
    OperatingRevenue2: '営業収益', CostOfSales: '売上原価', CostOfSalesIFRS: '売上原価',
    GrossProfit: '売上総利益', GrossProfitIFRS: '売上総利益',
    SellingGeneralAndAdministrativeExpenses: '販管費', SellingGeneralAndAdministrativeExpensesIFRS: '販管費',
    OperatingIncome: '営業利益', OperatingProfitLossIFRS: '営業利益', OperatingExpenses: '営業費用',
    NonOperatingIncome: '営業外収益', NonOperatingExpenses: '営業外費用', OrdinaryIncome: '経常利益',
    ExtraordinaryIncome: '特別利益', ExtraordinaryLoss: '特別損失',
    IncomeBeforeIncomeTaxes: '税引前利益', ProfitLossBeforeTaxIFRS: '税引前利益',
    IncomeTaxes: '法人税等', IncomeTaxExpenseIFRS: '法人税等',
    ProfitLoss: '純利益', ProfitLossIFRS: '純利益', NetIncomeLoss: '純利益',
    ProfitLossAttributableToOwnersOfParent: '親会社株主の純利益',
    ProfitLossAttributableToOwnersOfParentIFRS: '親会社所有者の純利益',
    ProfitLossAttributableToNonControllingInterests: '非支配株主分',
    ProfitLossAttributableToNonControllingInterestsIFRS: '非支配持分',
    OtherIncomeIFRS: 'その他の収益', OtherExpensesIFRS: 'その他の費用',
    FinanceIncomeIFRS: '金融収益', FinanceCostsIFRS: '金融費用',
    ShareOfProfitLossOfInvestmentsAccountedForUsingEquityMethodIFRS: '持分法損益',
    OrdinaryIncomeBNK: '経常収益', OrdinaryExpensesBNK: '経常費用',
    OrdinaryIncomeINS: '経常収益', OrdinaryExpensesINS: '経常費用'
  };

  // 損失側に名前を変えるもの
  var LOSS_NAME = {
    '売上総利益': '売上総損失', '営業利益': '営業損失', '経常利益': '経常損失', '税引前利益': '税引前損失',
    '純利益': '純損失', '親会社株主の純利益': '親会社株主の純損失', '親会社所有者の純利益': '親会社所有者の純損失'
  };

  var SALES_RE = /^(NetSales|NetSalesIFRS|RevenueIFRS|Revenue|OperatingRevenue1|OperatingRevenue2|SalesRevenueIFRS)$/;
  var PROFIT_ROOTS = /^(ProfitLoss|ProfitLossIFRS|NetIncomeLoss|ProfitLossAttributableToOwnersOfParent|ProfitLossAttributableToOwnersOfParentIFRS)$/;

  function stripBom(t) { return t.charCodeAt(0) === 0xFEFF ? t.slice(1) : t; }
  function localName(concept) { var i = concept.lastIndexOf('_'); return i < 0 ? concept : concept.slice(i + 1); }
  function clean(s) { return (s || '').replace(/[\s　]+/g, ' ').trim(); }

  function parseDoc(text, DP) {
    return new DP().parseFromString(stripBom(text), 'application/xml');
  }

  function byNS(doc, ns, name) {
    if (Array.isArray(ns)) return ns.reduce(function (a, n) { return a.concat(byNS(doc, n, name)); }, []);
    return Array.prototype.slice.call(doc.getElementsByTagNameNS(ns, name));
  }

  function closestRowLabel(el) {
    var n = el;
    while (n && n.localName !== 'tr') n = n.parentNode;
    if (!n) return '';
    for (var c = n.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 1 && (c.localName === 'td' || c.localName === 'th')) {
        var t = clean(c.textContent);
        if (t) return t;
      }
    }
    return '';
  }

  function parseNumber(el) {
    if (el.getAttribute('xsi:nil') === 'true') return null;
    var fmt = el.getAttribute('format') || '';
    var txt = clean(el.textContent);
    if (/fixed-zero|fixedzero/.test(fmt) || /^[－\-ー―‐−]$/.test(txt) || txt === '') return 0;
    var num = parseFloat(txt.replace(/[^\d.]/g, ''));
    if (isNaN(num)) return null;
    var scale = parseInt(el.getAttribute('scale') || '0', 10);
    var v = num * Math.pow(10, scale);
    if (el.getAttribute('sign') === '-') v = -v;
    return v;
  }

  /* ---------- 事実（数字）と期間を集める ---------- */
  function collect(files, DP) {
    var facts = [];          // {concept, ctx, value, label, file}
    var contexts = {};       // id -> {members:[], start, end, instant}
    var cal = {};            // role -> {children: {parent: [{c,w,o}]}}
    var memberLabels = {};   // member local name -> 日本語ラベル
    var summary = {};        // 会社名など

    Object.keys(files).forEach(function (name) {
      var text = files[name];
      if (/ixbrl\.htm$/i.test(name)) {
        var doc = parseDoc(text, DP);
        byNS(doc, NS_XBRLI, 'context').forEach(function (c) {
          var id = c.getAttribute('id');
          var members = byNS(c, NS_XBRLDI, 'explicitMember').map(function (m) { return clean(m.textContent); });
          if (!/Summary\//i.test(name)) members = members.filter(function (m) { return !/:NonConsolidatedMember$/.test(m); });
          var st = byNS(c, NS_XBRLI, 'startDate')[0], en = byNS(c, NS_XBRLI, 'endDate')[0], ins = byNS(c, NS_XBRLI, 'instant')[0];
          contexts[id] = { members: members, start: st && clean(st.textContent), end: en && clean(en.textContent), instant: ins && clean(ins.textContent) };
        });
        var isSummary = /Summary\//i.test(name);
        byNS(doc, NS_IX, 'nonFraction').forEach(function (el) {
          var v = parseNumber(el);
          if (v === null) return;
          var concept = (el.getAttribute('name') || '').replace(':', '_');
          facts.push({ concept: concept, ctx: el.getAttribute('contextRef'), value: v, label: closestRowLabel(el), file: name, summary: isSummary,
            unit: Math.pow(10, parseInt(el.getAttribute('scale') || '0', 10)) });
        });
        if (isSummary) {
          byNS(doc, NS_IX, 'nonNumeric').forEach(function (el) {
            var n = (el.getAttribute('name') || '').split(':').pop();
            if (!summary[n]) summary[n] = clean(el.textContent);
          });
        }
      } else if (/-cal\.xml$/i.test(name)) {
        var cdoc = parseDoc(text, DP);
        byNS(cdoc, NS_LINK, 'calculationLink').forEach(function (link) {
          var role = link.getAttributeNS(NS_XLINK, 'role') || link.getAttribute('xlink:role');
          var locs = {};
          byNS(link, NS_LINK, 'loc').forEach(function (l) {
            var href = l.getAttributeNS(NS_XLINK, 'href') || l.getAttribute('xlink:href');
            locs[l.getAttributeNS(NS_XLINK, 'label') || l.getAttribute('xlink:label')] = href.split('#')[1];
          });
          var children = (cal[role] = cal[role] || { children: {} }).children;
          byNS(link, NS_LINK, 'calculationArc').forEach(function (a) {
            var from = locs[a.getAttributeNS(NS_XLINK, 'from') || a.getAttribute('xlink:from')];
            var to = locs[a.getAttributeNS(NS_XLINK, 'to') || a.getAttribute('xlink:to')];
            if (!from || !to) return;
            (children[from] = children[from] || []).push({ c: to, w: parseFloat(a.getAttribute('weight') || '1'), o: parseFloat(a.getAttribute('order') || '0') });
          });
        });
      } else if (/-lab\.xml$/i.test(name)) {
        var ldoc = parseDoc(text, DP);
        var locs2 = {}, lab = {};
        byNS(ldoc, NS_LINK, 'loc').forEach(function (l) {
          var href = l.getAttributeNS(NS_XLINK, 'href') || l.getAttribute('xlink:href');
          locs2[l.getAttributeNS(NS_XLINK, 'label') || l.getAttribute('xlink:label')] = href.split('#')[1];
        });
        byNS(ldoc, NS_LINK, 'label').forEach(function (l) {
          var lang = l.getAttribute('xml:lang');
          var role = l.getAttributeNS(NS_XLINK, 'role') || l.getAttribute('xlink:role') || '';
          if (lang !== 'ja' || !/\/role\/label$/.test(role)) return;
          lab[l.getAttributeNS(NS_XLINK, 'label') || l.getAttribute('xlink:label')] = clean(l.textContent);
        });
        byNS(ldoc, NS_LINK, 'labelArc').forEach(function (a) {
          var f = locs2[a.getAttributeNS(NS_XLINK, 'from') || a.getAttribute('xlink:from')];
          var t = lab[a.getAttributeNS(NS_XLINK, 'to') || a.getAttribute('xlink:to')];
          if (f && t) memberLabels[localName(f)] = t;
        });
      }
    });
    Object.keys(cal).forEach(function (r) {
      var ch = cal[r].children;
      Object.keys(ch).forEach(function (p) { ch[p].sort(function (a, b) { return a.o - b.o; }); });
    });
    return { facts: facts, contexts: contexts, cal: cal, memberLabels: memberLabels, summary: summary };
  }

  /* ---------- 今期と前年同期の期間を選ぶ ---------- */
  var CUR_PREF = ['CurrentYearDuration', 'InterimDuration', 'CurrentYTDDuration', 'CurrentAccumulatedQ3Duration',
    'CurrentAccumulatedQ2Duration', 'CurrentAccumulatedQ1Duration'];

  function days(a, b) { return (Date.parse(b) - Date.parse(a)) / 864e5; }

  function choosePeriods(data, factsSel) {
    var ids = {};
    factsSel.forEach(function (f) {
      var c = data.contexts[f.ctx];
      if (c && !c.members.length && c.start && c.end) ids[f.ctx] = c;
    });
    var list = Object.keys(ids);
    var cur = null;
    for (var i = 0; i < CUR_PREF.length && !cur; i++) if (ids[CUR_PREF[i]]) cur = CUR_PREF[i];
    if (!cur) {
      // 前年以外で、いちばん長い期間（累計）を今期とみなす
      var cand = list.filter(function (id) { return !/^Prior/.test(id); });
      cand.sort(function (a, b) {
        var ea = ids[a].end, eb = ids[b].end;
        if (ea !== eb) return ea < eb ? 1 : -1;
        return days(ids[b].start, ids[b].end) - days(ids[a].start, ids[a].end);
      });
      cur = cand[0] || null;
    }
    if (!cur) return null;
    var c = ids[cur], len = days(c.start, c.end), prior = null;
    list.forEach(function (id) {
      if (id === cur) return;
      var p = ids[id], gap = days(p.end, c.end);
      if (gap > 330 && gap < 400 && Math.abs(days(p.start, p.end) - len) < 20) prior = prior || id;
    });
    return { cur: cur, prior: prior, start: c.start, end: c.end };
  }

  /* ---------- 計算の木から損益の段を組み立てる ---------- */
  function pickRole(data) {
    var best = null;
    Object.keys(data.cal).forEach(function (role) {
      if (/Segment|CashFlow|Changes|FinancialPosition|BalanceSheet/i.test(role)) return;
      var ch = data.cal[role].children;
      var top = Object.keys(ch).filter(function (p) { return PROFIT_ROOTS.test(localName(p)); });
      if (!top.length) return;
      var size = Object.keys(ch).length;
      var score = size + (/StatementOfIncome|ProfitOrLoss|ProfitAndLoss/i.test(role) ? 1000 : 0) - (/ComprehensiveIncome/i.test(role) ? 500 : 0);
      if (!best || score > best.score) best = { role: role, score: score, top: top };
    });
    return best;
  }

  function analyze(files, DP) {
    var data = collect(files, DP);
    var pick = pickRole(data);
    var attach = data.facts.filter(function (f) { return !f.summary; });
    var info = {
      company: data.summary.CompanyName || '',
      code: (data.summary.SecuritiesCode || '').slice(0, 4),
      document: data.summary.DocumentName || '',
      standard: data.facts.some(function (f) { return /^jpigp_cor_/.test(f.concept); }) ? 'IFRS' : 'JP'
    };
    if (!pick) return summaryOnly(data, info);

    var ch = data.cal[pick.role].children;
    var chainFacts = attach.filter(function (f) { return ch[f.concept] || isChild(ch, f.concept); });
    var per = choosePeriods(data, chainFacts.length ? chainFacts : attach);
    if (!per) return summaryOnly(data, info);
    info.period = per;

    // 値と行ラベル
    var val = {}, pval = {}, rowLabel = {};
    attach.forEach(function (f) {
      if (f.ctx === per.cur && val[f.concept] === undefined) { val[f.concept] = f.value; if (f.label) rowLabel[f.concept] = f.label; }
      if (f.ctx === per.prior && pval[f.concept] === undefined) pval[f.concept] = f.value;
    });
    function get(map, c) {
      if (map[c] !== undefined) return map[c];
      var kids = ch[c];
      if (!kids) return undefined;
      var s = 0, any = false;
      kids.forEach(function (k) { var v = get(map, k.c); if (v !== undefined) { s += k.w * v; any = true; } });
      return any ? s : undefined;
    }
    function label(c) { return SHORT[localName(c)] || rowLabel[c] || localName(c); }
    var unit = 1;
    attach.forEach(function (f) { if (ch[f.concept] && f.unit > unit) unit = f.unit; });
    var tol = unit * 3;
    function isMulti(c) {
      var ks = ch[c] || [];
      return ks.length >= 2 && ks.every(function (k) {
        var g = ch[k.c] || [];
        return k.w > 0 && g.filter(function (x) { return x.w > 0; }).length === 1 && g.some(function (x) { return x.w < 0; }) &&
          g.every(function (x) { return !ch[x.c] || positiveOnly(x.c); });
      });
    }
    function positiveOnly(c) {
      var kids = ch[c];
      if (!kids) return true;
      return kids.every(function (k) { return k.w > 0 && positiveOnly(k.c); });
    }
    function depth(c) {
      var kids = ch[c] || [];
      var d = 0;
      kids.forEach(function (k) { if (k.w > 0 && ch[k.c]) d = Math.max(d, 1 + depth(k.c)); });
      return kids.length ? d + 1 : 0;
    }

    // 最終の利益（親会社帰属を優先）
    var topConcept = pick.top.sort(function (a, b) { return depth(b) - depth(a); })[0];
    var stages = [];
    var node = topConcept, guard = 0;
    while (ch[node] && !positiveOnly(node) && !isMulti(node) && guard++ < 20) {
      var kids = ch[node];
      var plus = kids.filter(function (k) { return k.w > 0; });
      var main = plus.slice().sort(function (a, b) {
        var d = depth(b.c) - depth(a.c);
        if (d) return d;
        return Math.abs(get(val, b.c) || 0) - Math.abs(get(val, a.c) || 0);
      })[0];
      if (!main) break;
      var terms = kids.filter(function (k) { return k !== main; }).map(function (k) {
        return { concept: k.c, label: label(k.c), sign: k.w > 0 ? 1 : -1, value: get(val, k.c) || 0, prior: get(pval, k.c) };
      });
      stages.unshift({ result: node, main: main.c, terms: terms });
      node = main.c;
    }
    var forced = null;
    function mkTerm(k) { return { concept: k.c, label: label(k.c), sign: k.w > 0 ? 1 : -1, value: get(val, k.c) || 0, prior: get(pval, k.c) }; }
    if (ch[node] && positiveOnly(node)) {
      // 収益合計 = 売上収益 + その他の収益 のような形：売上の項目を主役にする
      var sk = ch[node].filter(function (k) { return SALES_RE.test(localName(k.c)); })[0];
      if (sk) {
        stages.unshift({ result: node, main: sk.c, terms: ch[node].filter(function (k) { return k !== sk; }).map(mkTerm) });
        node = sk.c;
      }
    } else if (ch[node] && isMulti(node)) {
      // 事業ごとの総利益の合計（建設業など）：売上と原価を事業ごとに分けて合算する
      var ks = ch[node];
      {
        var sales = [], costs = [];
        ks.forEach(function (k) {
          ch[k.c].forEach(function (x) { (x.w > 0 ? sales : costs).push(x); });
        });
        val.__SALES = 0; pval.__SALES = 0; var anyPrior = false;
        sales.forEach(function (x) { val.__SALES += get(val, x.c) || 0; var pv = get(pval, x.c); if (pv !== undefined) { pval.__SALES += pv; anyPrior = true; } });
        if (!anyPrior) delete pval.__SALES;
        rowLabel.__SALES = '売上高';
        stages.unshift({ result: node, main: '__SALES', terms: costs.map(function (x) { var t = mkTerm(x); t.sign = -1; return t; }) });
        forced = { kind: 'revenue', items: sales.map(function (x) { return { label: label(x.c), value: get(val, x.c) || 0, prior: get(pval, x.c) }; }).filter(function (x) { return x.value > 0; }) };
        node = '__SALES';
      }
    }
    var revenue = node;
    var revValue = get(val, revenue);
    if (!revValue || revValue <= 0 || stages.length === 0) return summaryOnly(data, info);

    // 帰属の段（純利益 → 非支配 / 親会社帰属）
    var last = stages.length ? stages[stages.length - 1].result : revenue;
    var ln = localName(last);
    if (/^ProfitLoss(IFRS)?$/.test(ln)) {
      var owners = Object.keys(val).filter(function (c) { return /^ProfitLossAttributableToOwnersOf/.test(localName(c)); })[0];
      var nci = Object.keys(val).filter(function (c) { return /^ProfitLossAttributableToNonControlling/.test(localName(c)); })[0];
      var plv = get(val, last);
      if (owners && !nci && plv !== undefined && Math.abs(plv - val[owners]) > 0) {
        nci = '__NCI'; val.__NCI = plv - val[owners];
        if (pval[owners] !== undefined && get(pval, last) !== undefined) pval.__NCI = get(pval, last) - pval[owners];
        rowLabel.__NCI = /IFRS/.test(ln) ? '非支配持分' : '非支配株主分';
      }
      if (owners && nci && Math.abs(val[nci]) > 0) {
        if (!SHORT[localName(owners)]) rowLabel[owners] = /IFRS/.test(ln) ? '親会社所有者の純利益' : '親会社株主の純利益';
        if (!SHORT[localName(nci)] && nci !== '__NCI') rowLabel[nci] = /IFRS/.test(ln) ? '非支配持分' : '非支配株主分';
        stages.push({ result: owners, main: last, terms: [{ concept: nci, label: label(nci), sign: -1, value: val[nci], prior: pval[nci] }] });
      }
    }

    // 段ごとの数字を確定し、合わない差は「その他」で埋める
    var out = [];
    stages.forEach(function (s) {
      var m = get(val, s.main) || 0, r = get(val, s.result);
      var sum = m;
      s.terms.forEach(function (t) { sum += t.sign * t.value; });
      if (r === undefined) r = sum;
      var diff = r - sum;
      var terms = s.terms.filter(function (t) { return t.value !== 0; });
      if (Math.abs(diff) > tol && terms.length && terms.length <= 10) {
        // 会社の計算定義が崩れている場合：つじつまが合う項目の組み合わせを探す（多く残る組を優先）
        var best = null;
        for (var mask = (1 << terms.length) - 1; mask >= 0; mask--) {
          var ss = m, cnt = 0;
          for (var b = 0; b < terms.length; b++) if (mask & (1 << b)) { ss += terms[b].sign * terms[b].value; cnt++; }
          if (Math.abs(r - ss) <= tol && (!best || cnt > best.cnt)) best = { mask: mask, cnt: cnt };
        }
        if (best) {
          terms = terms.filter(function (t, i) { return best.mask & (1 << i); });
          diff = 0;
        }
      }
      if (Math.abs(diff) > tol) {
        terms.push({ concept: 'Other', label: diff > 0 ? 'その他の収益' : 'その他の費用', sign: diff > 0 ? 1 : -1, value: Math.abs(diff), prior: undefined, plug: true });
      }
      if (!terms.length && Math.abs(r - m) <= tol && out.length) return; // 何も起きない段は省く
      out.push({
        result: { concept: s.result, label: label(s.result), value: r, prior: get(pval, s.result) },
        main: { concept: s.main, label: label(s.main), value: m, prior: get(pval, s.main) },
        terms: terms
      });
    });

    var breakdown = segments(data, attach, per, revValue, revenue, ch, val, pval, label) || (forced && forced.items.length >= 2 ? forced : null);

    return {
      ok: true, mode: 'full', info: info,
      revenue: { concept: revenue, label: label(revenue), value: revValue, prior: get(pval, revenue) },
      breakdown: breakdown, stages: out, tol: tol
    };
  }

  function isChild(ch, c) {
    for (var p in ch) if (ch[p].some(function (k) { return k.c === c; })) return true;
    return false;
  }

  /* ---------- セグメント別の売上（あれば） ---------- */
  function segments(data, attach, per, revValue, revenue, ch, val, pval, label) {
    var EXT = /^(jpcrp_cor_RevenuesFromExternalCustomers|jpigp_cor_RevenueFromExternalCustomersIFRS)$/;
    var curBy = {}, priBy = {};
    attach.forEach(function (f) {
      if (!EXT.test(f.concept)) return;
      var c = data.contexts[f.ctx];
      if (!c || c.members.length !== 1) return;
      var m = c.members[0], ml = m.split(':').pop();
      if (/^(ReportableSegments|TotalOfReportableSegmentsAndOthers|ReconcilingItems|EntityTotal|ConsolidatedOrNonConsolidated)/.test(ml)) return;
      var key = ml;
      if (c.end === per.end && c.start === per.start) { if (curBy[key] === undefined) curBy[key] = f.value; }
      else if (per.prior && data.contexts[per.prior] && c.end === data.contexts[per.prior].end && c.start === data.contexts[per.prior].start) { if (priBy[key] === undefined) priBy[key] = f.value; }
    });
    var keys = Object.keys(curBy).filter(function (k) { return curBy[k] > 0; });
    var items = keys.map(function (k) {
      var lbl = data.memberLabels[k] || (/OperatingSegmentsNotIncluded/.test(k) ? 'その他' : k.replace(/(ReportableSegments?|Segments?)?Member$/, ''));
      lbl = lbl.replace(/(事業)?(セグメント|部門)$/, function (all, j) { return j ? '事業' : ''; }) || lbl;
      return { label: lbl, value: curBy[k], prior: priBy[k] };
    });
    var total = items.reduce(function (s, x) { return s + x.value; }, 0);
    if (items.length >= 2 && total <= revValue * 1.001 && total >= revValue * 0.5) {
      var diff = revValue - total;
      if (diff > revValue * 0.001) items.push({ label: '調整額など', value: diff });
      items.sort(function (a, b) { return b.value - a.value; });
      return { kind: 'segment', items: items };
    }
    // 売上高そのものに内訳がある場合（例：銀行の経常収益）
    var kids = (ch[revenue] || []).filter(function (k) { return k.w > 0; });
    if (kids.length >= 2) {
      var its = kids.map(function (k) { return { label: label(k.c), value: val[k.c] || 0, prior: pval[k.c] }; }).filter(function (x) { return x.value > 0; });
      var tot = its.reduce(function (s, x) { return s + x.value; }, 0);
      if (its.length >= 2 && Math.abs(tot - revValue) <= revValue * 0.001) {
        its.sort(function (a, b) { return b.value - a.value; });
        return { kind: 'revenue', items: its };
      }
    }
    return null;
  }

  /* ---------- 添付の財務諸表がないときは、サマリーの数字だけで描く ---------- */
  var S_REV = /^(NetSales|NetSalesIFRS|NetSalesUS|Revenue|RevenueIFRS|RevenuesIFRS|SalesIFRS|OperatingRevenues|OperatingRevenuesIFRS|OperatingRevenuesUS|NetSalesAndOperatingRevenues|NetSalesAndOperatingRevenuesIFRS|NetSalesAndOperatingRevenuesUS|TotalRevenuesUS|OrdinaryRevenuesBK|OrdinaryRevenuesIN)$/;
  var S_OP = /^(OperatingIncome|OperatingProfitIFRS|OperatingIncomeIFRS|OperatingIncomeUS|OperatingProfitUS)$/;
  var S_PBT = /^(OrdinaryIncome|ProfitBeforeTaxIFRS|IncomeBeforeIncomeTaxesUS|IncomeBeforeIncomeTaxesIFRS)$/;
  var S_NET = /^(ProfitAttributableToOwnersOfParent|ProfitAttributableToOwnersOfParentIFRS|NetIncomeAttributableToOwnersOfParentUS|NetIncomeUS|NetIncome|Profit|ProfitIFRS)$/;

  function summaryFigures(data) {
    // サマリーの期間は「CurrentAccumulatedQ2Duration_ConsolidatedMember_ResultMember」のような形
    var sum = data.facts.filter(function (f) { return f.summary; });
    var rows = {};
    sum.forEach(function (f) {
      var c = data.contexts[f.ctx];
      if (!c || !c.start) return;
      var ms = c.members.map(function (m) { return m.split(':').pop(); });
      if (ms.some(function (m) { return !/^(ConsolidatedMember|NonConsolidatedMember|ResultMember)$/.test(m); })) return;
      if (ms.indexOf('ResultMember') < 0 && ms.length) return;
      var cons = ms.indexOf('NonConsolidatedMember') >= 0 ? 'N' : 'C';
      var key = c.start + '/' + c.end + '/' + cons;
      (rows[key] = rows[key] || { start: c.start, end: c.end, cons: cons, v: {} });
      var ln = localName(f.concept);
      if (rows[key].v[ln] === undefined) rows[key].v[ln] = f.value;
    });
    function find(v, re) {
      var hit; for (var k in v) if (re.test(k)) { if (/Owners|Attributable/.test(k)) return v[k]; if (hit === undefined) hit = v[k]; }
      return hit;
    }
    var list = Object.keys(rows).map(function (k) { return rows[k]; }).filter(function (r) { return find(r.v, S_REV) !== undefined; });
    if (!list.length) return null;
    list.sort(function (a, b) {
      if (a.end !== b.end) return a.end < b.end ? 1 : -1;
      if (a.cons !== b.cons) return a.cons === 'C' ? -1 : 1;
      return days(b.start, b.end) - days(a.start, a.end);
    });
    var cur = list[0];
    var prior = list.filter(function (r) {
      var gap = days(r.end, cur.end);
      return r.cons === cur.cons && gap > 330 && gap < 400 && Math.abs(days(r.start, r.end) - days(cur.start, cur.end)) < 20;
    })[0];
    function pack(r) { return r && { rev: find(r.v, S_REV), op: find(r.v, S_OP), pbt: find(r.v, S_PBT), net: find(r.v, S_NET) }; }
    return { cur: pack(cur), prior: pack(prior) || {}, start: cur.start, end: cur.end };
  }

  function summaryOnly(data, info) {
    var fig = summaryFigures(data);
    if (!fig || !fig.cur.rev || fig.cur.rev <= 0 || (fig.cur.op === undefined && fig.cur.net === undefined)) {
      return { ok: false, reason: 'この会社の形式（銀行・保険など）の読み取りには、まだ対応していません。', info: info };
    }
    info.period = { start: fig.start, end: fig.end };
    var c = fig.cur, p = fig.prior;
    var steps = [
      { key: 'op', label: '営業利益', cost: '営業費用', gain: '営業外などの収益' },
      { key: 'pbt', label: c.op !== undefined ? '税引前利益' : '経常利益', cost: '営業外・特別など', gain: '営業外・特別など' },
      { key: 'net', label: '純利益', cost: '税金など', gain: '税金など（戻り）' }
    ];
    var stages = [], prev = { label: '売上高', value: c.rev, prior: p.rev };
    steps.forEach(function (st) {
      var v = c[st.key];
      if (v === undefined) return;
      var d = v - prev.value;
      var res = { label: st.label, value: v, prior: p[st.key] };
      stages.push({ main: prev, result: res, terms: d === 0 ? [] : [{ label: d > 0 ? st.gain : st.cost, sign: d > 0 ? 1 : -1, value: Math.abs(d) }] });
      prev = res;
    });
    return {
      ok: true, mode: 'summary', info: info,
      revenue: { label: '売上高', value: c.rev, prior: p.rev },
      breakdown: null, stages: stages, tol: 1
    };
  }

  var api = { analyze: analyze, LOSS_NAME: LOSS_NAME, _collect: collect, _summaryFigures: summaryFigures };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TanshinParser = api;
})(this);
