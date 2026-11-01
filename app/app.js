(function () {
  'use strict';

  // 数字の置き場所（GitHub）。開発中は window.BIZ_DATA_BASE で差し替える
  var DATA = window.BIZ_DATA_BASE || 'https://raw.githubusercontent.com/HIKICHICompany/BizKessan/main/data/';
  var $ = function (id) { return document.getElementById(id); };
  var companies = [], index = {};

  /* ---------- 読み込み ---------- */
  function getJSON(url) {
    return fetch(url + (url.indexOf('?') < 0 ? '?' : '&') + 't=' + Math.floor(Date.now() / 6e5), { cache: 'no-store' })
      .then(function (r) { if (r.status === 404) return null; if (!r.ok) throw new Error('通信 ' + r.status); return r.json(); });
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
    $('main').innerHTML = ''; $('more').hidden = true; $('extra').innerHTML = '';
    status(it.name + 'の決算を読み込んでいます…');
    getJSON(DATA + 'companies/' + it.code + '.json').then(function (co) {
      if (!co || !co.docs || !co.docs.length) {
        status(it.name + 'の決算データはまだありません。決算短信が出た銘柄から順に、毎日夜に追加されます。', true);
        return;
      }
      remember({ code: it.code, name: co.name || it.name });
      var docs = bestPerPeriod(co.docs);
      current = { co: co, docs: docs };
      status('');
      $('main').appendChild(section(docs[0], co, true));
      chips(docs);
    }).catch(function (e) {
      status('データを読み込めませんでした。電波の状態を確かめて、もう一度お試しください。（' + e.message + '）', true);
    });
  }

  function srcBadge(d) { return d.kind === 'yuho' ? '<span class="src yuho">有報</span>' : '<span class="src tanshin">短信</span>'; }

  function section(d, co, isMain) {
    var s = document.createElement('section');
    s.innerHTML = '<div class="period"><h2></h2><p></p></div>';
    s.querySelector('h2').textContent = co.name + '（' + co.code + '）' + d.label;
    s.querySelector('p').innerHTML = srcBadge(d) + '<span></span>';
    s.querySelector('p span:last-child').textContent = (d.title || '') + '　' + (d.disclosed ? fmtDate(d.disclosed) + ' 開示' : '');
    s.appendChild(figure(d.pl, 'pl', '絵でみる儲けの流れ', d, co));
    s.appendChild(figure(d.bs, 'bs', '絵でみるファイナンス', d, co));
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
    var out = kind === 'pl' ? Kessan.renderPL(cfg) : Kessan.renderBS(cfg);
    var id = co.code + '_' + d.fye.replace('-', '') + 'Q' + d.q + '_' + kind;
    figs[id] = { svg: out.svg, w: out.width, h: out.height, file: fileName(co, d, kind) };
    f.innerHTML = '<div class="chart" tabindex="0" role="img"></div><figcaption><span class="name"></span>' +
      '<button type="button" class="btn primary" data-act="share">共有する</button><button type="button" class="btn" data-act="save">画像を保存</button></figcaption>';
    var ch = f.querySelector('.chart');
    ch.innerHTML = out.svg; ch.setAttribute('aria-label', name + '：' + co.name);
    ch.addEventListener('click', function () { ch.classList.toggle('zoom'); });
    f.querySelector('.name').textContent = name;
    f.querySelectorAll('button').forEach(function (b) { b.addEventListener('click', function () { exportFig(id, b.dataset.act); }); });
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
    fill($('chipsQ'), qs, function (d) { return d.q === 4 ? '通期' : d.q === 2 ? '第2四半期（中間）' : '第' + d.q + '四半期'; }, '当期のほかの四半期はまだありません');
    fill($('chipsY'), ys, function (d) { return d.label.replace(/ 通期$/, ''); }, '過去の年次決算は、データがたまりしだい表示します');
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
  function toPng(f) {
    return new Promise(function (res, rej) {
      var img = new Image();
      img.onload = function () {
        var c = document.createElement('canvas'), k = 2;
        c.width = f.w * k; c.height = f.h * k;
        var x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(img, 0, 0, c.width, c.height);
        res(c.toDataURL('image/png').split(',')[1]);
      };
      img.onerror = function () { rej(new Error('画像にできませんでした')); };
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(f.svg);
    });
  }
  function exportFig(id, act) {
    var f = figs[id]; if (!f) return;
    toPng(f).then(function (b64) {
      if (window.AndroidBridge) {
        if (act === 'share') window.AndroidBridge.shareImage(b64, f.file);
        else status(window.AndroidBridge.saveImage(b64, f.file));
        return;
      }
      var a = document.createElement('a'); a.href = 'data:image/png;base64,' + b64; a.download = f.file; a.click();
      status('画像を保存しました（' + f.file + '）');
    }).catch(function (e) { status(e.message, true); });
  }

  /* ---------- 起動 ---------- */
  fetch('companies.json').then(function (r) { return r.json(); }).then(function (c) { companies = c; })
    .catch(function () { status('銘柄の一覧を読み込めませんでした。', true); });
  index = (load('index', {}) || {});
  getJSON(DATA + 'index.json').then(function (ix) { if (ix && ix.companies) { index = ix.companies; store('index', index); } }).catch(function () {});
  drawRecent();
})();
