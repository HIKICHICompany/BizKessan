(function () {
  'use strict';

  // 数字の置き場所：ウェブ版は同じ場所の /data/、Androidアプリは公開先のアドレスから読む
  var API = window.BIZ_API || (location.hostname === 'appassets.androidplatform.net' ? 'https://bizkessan.hikichicompany.workers.dev' : '');
  var DATA = API + '/data/';
  var MEMBER_URL = 'https://note.com/hikichi_company/membership';
  var $ = function (id) { return document.getElementById(id); };
  var companies = [], index = {}, market = { seg: {}, n225: [] }, n225 = {};

  /* ---------- 読み込み ---------- */
  function getJSON(url) {
    var pass = load('pass', null), h = {};
    if (pass && pass.token) h['X-Biz-Token'] = pass.token;
    return fetch(url + (url.indexOf('?') < 0 ? '?' : '&') + 't=' + Math.floor(Date.now() / 6e5), { cache: 'no-store', headers: h })
      .then(function (r) {
        if (r.status === 404) return null;
        if (r.status === 401) return { locked: true };
        if (!r.ok) throw new Error('通信 ' + r.status);
        return r.json();
      });
  }

  /* ---------- 合言葉（noteメンバーシップの特典） ---------- */
  function thisMonth() { return new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 7); }
  function isMember() { var p = load('pass', null); return !!(p && p.token && p.month === thisMonth()); }
  function isFree(code) { return !!n225[code]; }
  function login(code) {
    return fetch(API + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: code }) })
      .then(function (r) { return r.json().catch(function () { return { ok: false, msg: '通信 ' + r.status }; }); })
      .then(function (j) { if (j.ok) store('pass', { token: j.token, month: j.month }); return j; });
  }
  function passState() {
    var el = $('passState'); if (!el) return;
    var p = load('pass', null);
    el.textContent = isMember()
      ? 'メンバーとして全社を見られます（' + (+p.month.slice(5)) + '月の合言葉）。合言葉は毎月1日に替わります。'
      : '日経225の会社は誰でも見られます。それ以外の会社は、noteメンバーシップの特典です。合言葉は毎月1日に替わります。';
  }
  function wirePass(inputEl, btn, msgEl, done) {
    function go() {
      var v = inputEl.value.trim(); if (!v) { inputEl.focus(); return; }
      btn.disabled = true; msgEl.className = 'passmsg'; msgEl.textContent = '確かめています…';
      login(v).then(function (j) {
        btn.disabled = false;
        if (j.ok) { msgEl.className = 'passmsg ok'; msgEl.textContent = 'ありがとうございます。全社を見られるようになりました。'; passState(); drawRows(); if (done) done(); }
        else { msgEl.className = 'passmsg err'; msgEl.textContent = j.msg || '合言葉がちがいます'; }
      }).catch(function () { btn.disabled = false; msgEl.className = 'passmsg err'; msgEl.textContent = 'つながりませんでした。電波の状態を確かめて、もう一度お試しください。'; });
    }
    btn.addEventListener('click', go);
    inputEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  }
  function lockPanel(it) {
    var d = document.createElement('section'); d.className = 'lock';
    var expired = load('pass', null) && !isMember();
    d.innerHTML = '<h2></h2><p></p><div class="passrow"><input type="text" inputmode="latin" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="12" placeholder="合言葉" aria-label="合言葉"><button type="button" class="btn primary">見る</button></div>' +
      '<p class="passmsg" role="status" aria-live="polite"></p><p>合言葉は、<a target="_blank" rel="noopener">noteメンバーシップ</a>の限定記事でお知らせしています。日経225の会社は、合言葉なしで見られます。</p>';
    d.querySelector('h2').textContent = it.name + 'はメンバー特典です';
    d.querySelector('p').textContent = expired ? '月が替わり、合言葉が新しくなりました。今月の合言葉を入れてください。' : '合言葉を入れると、この会社の図を見られます。一度入れれば、その月の間は聞きません。';
    d.querySelector('a').href = MEMBER_URL;
    wirePass(d.querySelector('input'), d.querySelector('button'), d.querySelector('.passmsg'), function () { open(it); });
    return d;
  }
  function store(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 保存できなくても動く */ } }
  function load(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }

  /* ---------- 銘柄さがし ---------- */
  function norm(s) {
    s = (s || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
    return s.replace(/[ぁ-ゖ]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) + 0x60); });
  }
  function find(q) {
    var n = norm(q); if (!n) return [];
    var hits = [];
    companies.forEach(function (c) {
      var code4 = c[0].slice(0, 4).toLowerCase(), name = norm(c[1]), yomi = norm(c[2]), s = -1;
      if (code4 === n) s = 0; else if (code4.indexOf(n) === 0) s = 1;
      else if (name.indexOf(n) === 0 || yomi.indexOf(n) === 0) s = 2;
      else if (name.indexOf(n) >= 0 || yomi.indexOf(n) >= 0) s = 3;
      if (s >= 0) hits.push({ c: c, s: s + (index[c[0].slice(0, 4).toUpperCase()] ? 0 : 0.5) });
    });
    hits.sort(function (a, b) { return a.s - b.s || a.c[1].length - b.c[1].length; });
    return hits.slice(0, 8).map(function (h) { return { code: h.c[0].slice(0, 4).toUpperCase(), name: h.c[1] }; });
  }
  var input = $('q'), list = $('suggest');
  function suggest() {
    var items = find(input.value); list.innerHTML = '';
    items.forEach(function (it) {
      var li = document.createElement('li'), b = document.createElement('button');
      b.type = 'button'; b.setAttribute('role', 'option');
      b.innerHTML = '<span class="code"></span><span class="nm"></span>' + (index[it.code] ? '' : '<span class="nodata">データ準備中</span>');
      b.querySelector('.code').textContent = it.code; b.querySelector('.nm').textContent = it.name;
      b.addEventListener('click', function () { open(it); });
      li.appendChild(b); list.appendChild(li);
    });
    list.hidden = !items.length;
  }
  input.addEventListener('input', suggest);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); var it = find(input.value)[0]; if (it) open(it); }
    else if (e.key === 'ArrowDown') { var f = list.querySelector('button'); if (f) { e.preventDefault(); f.focus(); } }
  });
  document.addEventListener('click', function (e) { if (!e.target.closest('.search')) list.hidden = true; });

  function drawRecent() {
    var ul = $('recent'); ul.innerHTML = '';
    $('recentLab').hidden = !load('recent', []).length;
    load('recent', []).forEach(function (it) {
      var li = document.createElement('li'), b = document.createElement('button');
      b.type = 'button'; b.textContent = it.name + ' ' + it.code;
      b.addEventListener('click', function () { open(it); });
      li.appendChild(b); ul.appendChild(li);
    });
  }
  function remember(it) {
    var r = load('recent', []).filter(function (x) { return x.code !== it.code; });
    r.unshift({ code: it.code, name: it.name }); store('recent', r.slice(0, 8)); drawRecent();
  }
  function status(t, err) { var s = $('status'); s.textContent = t || ''; s.classList.toggle('error', !!err); }

  /* ---------- 期の選び方：期が新しいものを優先、同じ期なら有報を優先 ---------- */
  function order(a, b) { return (b.fye + b.q).localeCompare(a.fye + a.q) || (a.kind === 'yuho' ? -1 : b.kind === 'yuho' ? 1 : 0); }
  function bestPerPeriod(docs) {
    var seen = {}, out = [];
    docs.slice().sort(order).forEach(function (d) { var k = d.fye + 'Q' + d.q; if (!seen[k]) { seen[k] = 1; out.push(d); } });
    return out;
  }

  /* ---------- 表示 ---------- */
  var current = null, figs = {};
  function open(it) {
    list.hidden = true; input.value = it.name + ' ' + it.code; input.blur();
    browseY = window.scrollY; $('browse').hidden = true; $('back').hidden = false; window.scrollTo(0, 0);
    $('main').innerHTML = ''; $('more').hidden = true; $('extra').innerHTML = '';
    status(it.name + 'の決算を読み込んでいます…');
    getJSON(DATA + 'companies/' + it.code + '.json').then(function (co) {
      if (co && co.locked) { status(''); $('main').appendChild(lockPanel(it)); return; }
      if (!co || !co.docs || !co.docs.length) {
        status(it.name + 'の決算データはまだありません。決算短信が出た銘柄から順に、毎日夜に追加されます。', true);
        return;
      }
      remember({ code: it.code, name: co.name || it.name });
      current = { co: co, docs: bestPerPeriod(co.docs) };
      status('');
      draw();
    }).catch(function (e) {
      status('データを読み込めませんでした。電波の状態を確かめて、もう一度お試しください。（' + e.message + '）', true);
    });
  }

  function draw() {
    if (!current) return;
    $('main').innerHTML = ''; $('extra').innerHTML = ''; figs = {};
    $('main').appendChild(section(current.docs[0], current.co, true));
    chips(current.docs);
  }

  /* ---------- 配色 ---------- */
  var themeId = Kessan.setTheme(load('theme', 'standard'));
  function drawThemes() {
    var box = $('themeList'); box.innerHTML = '';
    Kessan.themes().forEach(function (t) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'theme'; b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(t.id === themeId));
      var sw = '<span class="sw">';
      for (var i = 0; i < 6; i += 2) sw += '<span><i style="background:' + t.swatch[i] + '"></i><i style="background:' + t.swatch[i + 1] + '"></i></span>';
      b.innerHTML = sw + '</span><span class="tn"></span>';
      b.querySelector('.tn').textContent = t.name;
      b.addEventListener('click', function () { themeId = Kessan.setTheme(t.id); store('theme', themeId); drawThemes(); draw(); });
      box.appendChild(b);
    });
  }
  $('setBtn').addEventListener('click', function () {
    var p = $('settings'), open = p.hidden; p.hidden = !open; this.setAttribute('aria-expanded', String(open)); if (open) drawThemes();
  });

  function srcBadge(d) { return d.kind === 'yuho' ? '<span class="src yuho">有報</span>' : '<span class="src tanshin">短信</span>'; }

  function section(d, co, isMain) {
    var s = document.createElement('section');
    s.innerHTML = '<div class="period"><div class="ph"><h2></h2></div><p></p></div>';
    s.querySelector('h2').textContent = co.name + '（' + co.code + '）' + Kessan.periodLabel(d.fye, d.q);
    if (isMain) {
      var fb = document.createElement('button'); fb.type = 'button'; fb.className = 'fav';
      var paint = function () { var on = isFav(co.code); fb.setAttribute('aria-pressed', String(on)); fb.textContent = on ? '★ お気に入り' : '☆ お気に入りに追加'; };
      fb.addEventListener('click', function () { toggleFav({ code: co.code, name: co.name }); paint(); });
      paint(); s.querySelector('.ph').appendChild(fb);
    }
    s.querySelector('p').innerHTML = srcBadge(d) + '<span></span>';
    s.querySelector('p span:last-child').textContent = (d.title || '') + '　' + (d.disclosed ? fmtDate(d.disclosed) + ' 開示' : '');
    s.appendChild(figure(d.pl, 'pl', '絵でみる経営成績', d, co));
    s.appendChild(figure(d.bs, 'bs', '絵でみる財政状態', d, co));
    if (isMain) s.insertAdjacentHTML('beforeend', '<p class="hint">図をタップすると拡大し、横にずらして見られます。</p>');
    return s;
  }
  function fmtDate(x) { var m = String(x).match(/^(\d{4})(\d{2})(\d{2})/); return m ? m[1] + '/' + m[2] + '/' + m[3] : x; }

  function figure(cfg, kind, name, d, co) {
    var f = document.createElement('figure');
    if (!cfg || !cfg.ok) {
      f.innerHTML = '<div class="na"></div>';
      f.firstChild.textContent = name + '：' + ((cfg && cfg.reason) || 'この期の数字からは描けませんでした。');
      return f;
    }
    var opt = { period: Kessan.periodLabel(d.fye, d.q) };
    var out = kind === 'pl' ? Kessan.renderPL(cfg, opt) : Kessan.renderBS(cfg, opt);
    var id = co.code + '_' + d.fye.replace('-', '') + 'Q' + d.q + '_' + kind;
    figs[id] = { svg: out.svg, w: out.width, h: out.height, file: fileName(co, d, kind) };
    f.innerHTML = '<div class="chart" tabindex="0" role="img"></div><figcaption><span class="name"></span>' +
      '<button type="button" class="btn primary" data-act="share">共有する</button><button type="button" class="btn" data-act="save">画像を保存</button></figcaption>';
    var ch = f.querySelector('.chart');
    ch.innerHTML = out.svg; ch.setAttribute('aria-label', name + '：' + co.name);
    ch.addEventListener('click', function () { ch.classList.toggle('zoom'); });
    f.querySelector('.name').textContent = name;
    f.querySelectorAll('button').forEach(function (b) { b.addEventListener('click', function () { exportFig(id, b.dataset.act, b); }); });
    return f;
  }
  // ファイル名：銘柄コード＋決算期（例：7551FY2027.3Q2_PL.png）
  function fileName(co, d, kind) {
    var m = (d.fye || '').match(/^(\d{4})-(\d{2})/);
    var fy = m ? 'FY' + m[1] + '.' + (+m[2]) : '';
    return co.code + fy + (d.q === 4 ? '' : 'Q' + d.q) + '_' + (kind === 'pl' ? 'PL' : 'BS') + '.png';
  }

  /* ---------- 期のボタン ---------- */
  function chips(docs) {
    var top = docs[0];
    var qs = docs.filter(function (d) { return d !== top && d.fye === top.fye; });
    var ys = docs.filter(function (d) { return d !== top && d.q === 4 && d.fye < top.fye; });
    fill($('chipsQ'), qs, function (d) { return Kessan.periodLabel(d.fye, d.q).replace(/^\S+ /, ''); }, '当期のほかの四半期はまだありません');
    fill($('chipsY'), ys, function (d) { return Kessan.periodLabel(d.fye, 4).replace(/ 通期$/, ''); }, '過去の年次決算は、データがたまりしだい表示します');
    $('more').hidden = false;
  }
  function fill(box, docs, lab, empty) {
    box.innerHTML = '';
    if (!docs.length) { box.innerHTML = '<span class="none"></span>'; box.firstChild.textContent = empty; return; }
    docs.forEach(function (d) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'chip'; b.setAttribute('aria-pressed', 'false');
      b.textContent = lab(d);
      b.addEventListener('click', function () {
        var key = d.fye + 'Q' + d.q, ex = $('extra'), have = ex.querySelector('[data-k="' + key + '"]');
        if (have) { have.remove(); b.setAttribute('aria-pressed', 'false'); return; }
        var s = section(d, current.co, false); s.dataset.k = key;
        ex.insertBefore(s, ex.firstChild); b.setAttribute('aria-pressed', 'true');
        s.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      box.appendChild(b);
    });
  }

  /* ---------- 画像にする ---------- */
  // 図を画像にする。端末によって大きな画像が作れないときは、小さくして作り直す
  function toPng(f) {
    function attempt(k) {
      return new Promise(function (res, rej) {
        var img = new Image();
        img.onload = function () {
          try {
            var c = document.createElement('canvas');
            c.width = Math.round(f.w * k); c.height = Math.round(f.h * k);
            var x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(img, 0, 0, c.width, c.height);
            var url = c.toDataURL('image/png');
            if (!url || url.length < 200) throw new Error('empty');
            res(url.split(',')[1]);
          } catch (e) { rej(e); }
        };
        img.onerror = function () { rej(new Error('図を読み込めませんでした')); };
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(f.svg);
      });
    }
    return attempt(2).catch(function () { return attempt(1.4); }).catch(function () { return attempt(1); })
      .catch(function () { throw new Error('この端末では画像を作れませんでした'); });
  }
  // 結果は押したボタンのすぐ下に出す（画面の上の方だと見えないため）
  function toast(msg, err) {
    var t = $('toast'); t.textContent = msg; t.classList.toggle('err', !!err); t.hidden = false;
    clearTimeout(toast.tm); toast.tm = setTimeout(function () { t.hidden = true; }, 5000);
  }
  function exportFig(id, act, btn) {
    var f = figs[id]; if (!f) return;
    if (btn) { btn.disabled = true; setTimeout(function () { btn.disabled = false; }, 1500); }
    toast(act === 'share' ? '画像を作っています…' : '保存しています…');
    toPng(f).then(function (b64) {
      if (window.AndroidBridge) {
        var r = act === 'share' ? window.AndroidBridge.shareImage(b64, f.file) : window.AndroidBridge.saveImage(b64, f.file);
        if (r) toast(r, /できません/.test(r)); else document.getElementById('toast').hidden = true;
        return;
      }
      // iPhoneなど：共有の画面を開く（「画像を保存」で写真に入る。XやLINEにもそのまま送れる）
      var file = null;
      try {
        var bin = atob(b64), u8 = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        file = new File([u8], f.file, { type: 'image/png' });
      } catch (e) { file = null; }
      if (file && navigator.canShare && navigator.canShare({ files: [file] }) && (act === 'share' || isTouch())) {
        $('toast').hidden = true;
        navigator.share({ files: [file] }).then(function () {
          if (act === 'save') toast('共有の画面で「画像を保存」を選ぶと、写真に入ります');
        }).catch(function (e) { if (e && e.name !== 'AbortError') fallback(); });
        return;
      }
      fallback();
      function fallback() {
        var a = document.createElement('a'); a.href = URL.createObjectURL(file || new Blob([])); a.download = f.file;
        if (!file) a.href = 'data:image/png;base64,' + b64;
        document.body.appendChild(a); a.click(); a.remove();
        toast(act === 'share' ? 'この端末では共有の画面を開けないため、画像を保存しました（' + f.file + '）' : '保存しました（' + f.file + '）');
      }
    }).catch(function (e) { toast(e.message, true); });
  }

  function isTouch() { return 'ontouchstart' in window || navigator.maxTouchPoints > 0; }

  /* ---------- お気に入り ---------- */
  function favs() { return load('fav', []); }
  function isFav(code) { return favs().some(function (x) { return x.code === code; }); }
  function toggleFav(it) {
    var f = favs(), on = f.some(function (x) { return x.code === it.code; });
    f = on ? f.filter(function (x) { return x.code !== it.code; }) : [{ code: it.code, name: it.name }].concat(f);
    store('fav', f); drawFavs(); if (!$('browse').hidden) drawRows();
  }
  function drawFavs() {
    var ul = $('favs'); ul.innerHTML = '';
    favs().forEach(function (it) {
      var li = document.createElement('li'), b = document.createElement('button');
      b.type = 'button'; b.textContent = '★ ' + it.name + ' ' + it.code;
      b.addEventListener('click', function () { open(it); });
      li.appendChild(b); ul.appendChild(li);
    });
    $('favWrap').hidden = !favs().length;
  }

  /* ---------- 決算の一覧（月・区分で絞り込み） ---------- */
  var SEGN = { P: 'プライム', S: 'スタンダード', G: 'グロース', PRO: 'PRO' };
  var FILTERS = [['all', 'すべて'], ['n225', '日経225'], ['P', 'プライム'], ['S', 'スタンダード'], ['G', 'グロース'], ['fav', '★ お気に入り']];
  var filt = load('filter', 'all'), month = '', shown = 120, browseY = 0;
  function rowsAll() {
    return Object.keys(index).map(function (code) {
      var v = index[code]; return { code: code, name: v[0], label: v[1], kind: v[2], disclosed: v[3] || '', fye: v[4], q: v[5] };
    }).filter(function (r) { return r.disclosed; });
  }
  function drawMonths(all) {
    var ms = {}; all.forEach(function (r) { ms[r.disclosed.slice(0, 6)] = 1; });
    var keys = Object.keys(ms).sort().reverse(), sel = $('month');
    if (!month || keys.indexOf(month) < 0) month = keys[0] || '';
    sel.innerHTML = keys.map(function (k) { return '<option value="' + k + '">' + k.slice(0, 4) + '年' + (+k.slice(4, 6)) + '月に出た決算</option>'; }).join('');
    sel.value = month;
  }
  function drawFilters() {
    var box = $('filters'); box.innerHTML = '';
    FILTERS.forEach(function (f) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'chip'; b.textContent = f[1];
      b.setAttribute('aria-pressed', String(filt === f[0]));
      b.addEventListener('click', function () { filt = f[0]; store('filter', filt); shown = 120; drawFilters(); drawRows(); });
      box.appendChild(b);
    });
  }
  var WD = '日月火水木金土';
  function dayHead(ymd) { var d = new Date(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)); return (+ymd.slice(4, 6)) + '月' + (+ymd.slice(6, 8)) + '日（' + WD[d.getDay()] + '）'; }
  function drawRows() {
    var all = rowsAll(); drawMonths(all);
    var fv = {}; favs().forEach(function (x) { fv[x.code] = 1; });
    var member = isMember();
    var rows = all.filter(function (r) {
      if (r.disclosed.slice(0, 6) !== month) return false;
      if (filt === 'n225') return n225[r.code];
      if (filt === 'fav') return fv[r.code];
      if (filt !== 'all') return market.seg[r.code] === filt;
      return true;
    }).sort(function (a, b) { return b.disclosed.localeCompare(a.disclosed) || a.code.localeCompare(b.code); });
    $('count').textContent = rows.length ? rows.length + '社' : (filt === 'fav' ? 'この月に決算が出たお気に入りはありません。銘柄の画面の「☆ お気に入りに追加」で登録できます。' : 'この条件の決算はまだありません。');
    var box = $('rows'); box.innerHTML = ''; var lastDay = '', ul = null;
    rows.slice(0, shown).forEach(function (r) {
      var day = r.disclosed.slice(0, 8);
      if (day !== lastDay) {
        lastDay = day; var n = rows.filter(function (x) { return x.disclosed.slice(0, 8) === day; }).length;
        var h = document.createElement('h3'); h.className = 'day'; h.textContent = dayHead(day) + '　' + n + '社'; box.appendChild(h);
        ul = document.createElement('ul'); ul.className = 'rows'; box.appendChild(ul);
      }
      var li = document.createElement('li'), b = document.createElement('button');
      b.type = 'button'; b.className = 'row';
      var seg = market.seg[r.code];
      b.innerHTML = '<span class="rt"><span class="rn"></span><span class="rc"></span></span><span class="rb"></span><span class="rp"></span>';
      b.querySelector('.rn').textContent = (fv[r.code] ? '★ ' : '') + r.name;
      b.querySelector('.rc').textContent = r.code;
      b.querySelector('.rb').innerHTML = (n225[r.code] ? '<i class="tg n">225</i>' : '') + (seg ? '<i class="tg s' + seg + '">' + SEGN[seg] + '</i>' : '') + (!member && !n225[r.code] ? '<i class="tg m">メンバー</i>' : '');
      b.querySelector('.rp').textContent = Kessan.periodLabel(r.fye, r.q) || r.label;
      b.addEventListener('click', function () { open({ code: r.code, name: r.name }); });
      li.appendChild(b); ul.appendChild(li);
    });
    $('moreRows').hidden = rows.length <= shown;
  }
  $('month').addEventListener('change', function () { month = this.value; shown = 120; drawRows(); });
  $('moreRows').addEventListener('click', function () { shown += 200; drawRows(); });
  $('back').addEventListener('click', function () {
    $('main').innerHTML = ''; $('more').hidden = true; $('extra').innerHTML = ''; current = null; status('');
    input.value = ''; $('back').hidden = true; $('browse').hidden = false; drawRows(); window.scrollTo(0, browseY);
  });

  /* ---------- 起動 ---------- */
  fetch('companies.json').then(function (r) { return r.json(); }).then(function (c) { companies = c; })
    .catch(function () { status('銘柄の一覧を読み込めませんでした。', true); });
  index = (load('index', {}) || {});
  market = load('market', market) || market;
  var setN = function () { n225 = {}; (market.n225 || []).forEach(function (c) { n225[c] = 1; }); };
  setN(); drawFilters(); drawRows();
  Promise.all([
    getJSON(DATA + 'index.json').then(function (ix) { if (ix && ix.companies) { index = ix.companies; store('index', index); } }),
    getJSON(DATA + 'meta/market.json').then(function (m) { if (m && m.seg) { market = { seg: m.seg, n225: m.n225 }; store('market', market); setN(); } })
  ]).catch(function () { status('一覧を更新できませんでした。前回読み込んだ内容を表示しています。', true); })
    .then(function () { if (!$('browse').hidden) drawRows(); });
  drawRecent(); drawFavs();
  passState(); wirePass($('passSet'), $('passSetBtn'), $('passSetMsg'));
})();
