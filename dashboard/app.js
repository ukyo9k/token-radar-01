// Token Launch Radar: the dashboard. Reads window.RADAR (written by main.ts
// from the sealed snapshot) and renders the board, the detail view and the
// already-trading yardstick. No network, no framework: the page works from a
// local folder, and the address bar carries the view (#/p/<slug> for a
// protocol's detail, #/f/<category> for a filtered board) so a view can be
// opened directly.

(function () {
  'use strict';

  var data = window.RADAR || { meta: {}, rows: [], launched: [] };
  var rows = data.rows || [];
  var launched = data.launched || [];
  var meta = data.meta || {};

  var state = { q: '', cat: '', chain: '', watch: false, sort: 'implied', selected: null };

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtUsd(v) {
    if (v == null) return '—';
    if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
    return '$' + Math.round(v);
  }

  function fmtPct(v) {
    if (v == null || !isFinite(v)) return '<span class="flat">—</span>';
    var cls = v > 0 ? 'up' : v < 0 ? 'down' : 'flat';
    var sign = v > 0 ? '+' : '';
    return '<span class="' + cls + '">' + sign + v.toFixed(1) + '%</span>';
  }

  function fmtAge(days) {
    if (days == null) return '—';
    if (days < 30) return days + 'd';
    if (days < 365) return (days / 30).toFixed(1) + 'mo';
    return (days / 365).toFixed(1) + 'y';
  }

  function fmtMult(v) { return '×' + v.toFixed(2); }

  function bySlug(slug) {
    for (var i = 0; i < rows.length; i++) if (rows[i].slug === slug) return rows[i];
    return null;
  }

  function filteredRows() {
    var q = state.q.trim().toLowerCase();
    var out = rows.filter(function (r) {
      if (state.watch && !r.on_watchlist) return false;
      if (state.cat && r.category !== state.cat) return false;
      if (state.chain && r.chains.indexOf(state.chain) === -1) return false;
      if (q && r.name.toLowerCase().indexOf(q) === -1 && r.slug.toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
    var s = state.sort;
    if (s === 'tvl') out.sort(function (a, b) { return b.tvl_usd - a.tvl_usd; });
    else if (s === 'growth') out.sort(function (a, b) { return (b.change_7d == null ? -Infinity : b.change_7d) - (a.change_7d == null ? -Infinity : a.change_7d); });
    else if (s === 'age') out.sort(function (a, b) { return (b.age_days == null ? -1 : b.age_days) - (a.age_days == null ? -1 : a.age_days); });
    else if (s === 'name') out.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
    else out.sort(function (a, b) { return a.rank - b.rank; });
    return out;
  }

  function rowHtml(r) {
    var chains = r.chains.slice(0, 3).map(function (c) { return '<span class="chip">' + esc(c) + '</span>'; }).join('');
    if (r.chains.length > 3) chains += '<span class="chip">+' + (r.chains.length - 3) + '</span>';
    var badge = r.on_watchlist ? '<span class="badge">Watchlist</span>' : '';
    return '<tr data-slug="' + esc(r.slug) + '"' + (state.selected === r.slug ? ' class="selected"' : '') + '>' +
      '<td class="num">' + r.rank + '</td>' +
      '<td><span class="name">' + esc(r.name) + '</span>' + badge + '<br><span class="slug">' + esc(r.slug) + '</span></td>' +
      '<td>' + esc(r.category || '—') + '</td>' +
      '<td>' + chains + '</td>' +
      '<td class="num">' + fmtUsd(r.tvl_usd) + '</td>' +
      '<td class="num">' + fmtPct(r.change_7d) + '</td>' +
      '<td class="num">' + fmtAge(r.age_days) + '</td>' +
      '<td class="num"><b>' + fmtUsd(r.implied_value_usd) + '</b></td>' +
      '</tr>';
  }

  function renderBoard() {
    var list = filteredRows();
    $('count').textContent = list.length + ' of ' + rows.length + ' protocols shown' +
      (state.cat ? ' · category ' + state.cat : '') + (state.chain ? ' · chain ' + state.chain : '');
    var body = $('rows');
    if (list.length === 0) {
      body.innerHTML = '<tr><td colspan="8"><div class="empty">No protocol matches these filters. Clear the search or pick another category.</div></td></tr>';
      return;
    }
    body.innerHTML = list.map(rowHtml).join('');
    var trs = body.querySelectorAll('tr[data-slug]');
    for (var i = 0; i < trs.length; i++) {
      trs[i].addEventListener('click', function () { selectProtocol(this.getAttribute('data-slug'), true); });
    }
  }

  function selectProtocol(slug, pushHash) {
    var r = bySlug(slug);
    var box = $('detail');
    if (!r) { box.hidden = true; state.selected = null; renderBoard(); return; }
    state.selected = slug;
    var steps = r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('');
    var watchNote = r.on_watchlist
      ? 'On the snapshot watchlist: TVL at or above the $50M floor with no token recorded.'
      : 'Below the watchlist floor, ranked here because it passes the same plausibility screen.';
    box.innerHTML =
      '<h2>' + esc(r.name) + ' <span class="slug">' + esc(r.slug) + '</span></h2>' +
      '<p class="tagline">Rank #' + r.rank + ' · ' + esc(r.category || 'Uncategorised') + ' · ' + esc(r.chains.join(', ')) +
      ' · ' + watchNote + '</p>' +
      '<div class="grid">' +
      '<div class="cell"><span>TVL</span><b>' + fmtUsd(r.tvl_usd) + '</b><small>DefiLlama, ' + esc(meta.as_of || '') + '</small></div>' +
      '<div class="cell"><span>7-day change</span><b>' + (r.change_7d == null ? '—' : (r.change_7d > 0 ? '+' : '') + r.change_7d.toFixed(1) + '%') + '</b><small>growth factor ' + r.growth_factor.toFixed(3) + '</small></div>' +
      '<div class="cell"><span>Age, no token</span><b>' + fmtAge(r.age_days) + '</b><small>age factor ' + r.age_factor.toFixed(3) + '</small></div>' +
      '<div class="cell"><span>Category multiple</span><b>' + fmtMult(r.multiple) + '</b><small>median MCap / TVL of trading peers</small></div>' +
      '<div class="cell"><span>Implied value</span><b>' + fmtUsd(r.implied_value_usd) + '</b><small>rank #' + r.rank + ' of ' + rows.length + '</small></div>' +
      '</div>' +
      '<div class="breakdown">' + fmtUsd(r.tvl_usd) + ' TVL × ' + fmtMult(r.multiple) + ' multiple × ' +
      r.growth_factor.toFixed(3) + ' growth × ' + r.age_factor.toFixed(3) + ' age = <b>' + fmtUsd(r.implied_value_usd) + '</b></div>' +
      '<h3>How to farm it</h3>' +
      '<ol class="steps">' + steps + '</ol>' +
      '<p class="note">DefiLlama records no token for ' + esc(r.name) + ' — that is not proof it has none. ' +
      'Gas figures are estimates at snapshot time. Farm with amounts you can afford to lose.</p>';
    box.hidden = false;
    renderBoard();
    if (pushHash) {
      try { history.replaceState(null, '', '#/p/' + r.slug); } catch (e) { /* file URLs may refuse */ }
      box.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function renderLaunched() {
    $('launched-rows').innerHTML = launched.map(function (p) {
      return '<tr>' +
        '<td><span class="name">' + esc(p.name) + '</span>' + (p.symbol ? ' <span class="slug">' + esc(p.symbol) + '</span>' : '') + '</td>' +
        '<td>' + esc(p.category || '—') + '</td>' +
        '<td class="num">' + fmtUsd(p.tvl_usd) + '</td>' +
        '<td class="num">' + fmtUsd(p.mcap_usd) + '</td>' +
        '<td class="num">' + fmtMult(p.ratio) + '</td>' +
        '</tr>';
    }).join('');
  }

  function fillSelects() {
    var cats = {}, chains = {};
    rows.forEach(function (r) {
      if (r.category) cats[r.category] = true;
      r.chains.forEach(function (c) { chains[c] = true; });
    });
    var catSel = $('cat'), chainSel = $('chain');
    Object.keys(cats).sort().forEach(function (c) {
      var o = document.createElement('option'); o.value = c; o.textContent = c; catSel.appendChild(o);
    });
    Object.keys(chains).sort().forEach(function (c) {
      var o = document.createElement('option'); o.value = c; o.textContent = c; chainSel.appendChild(o);
    });
  }

  function renderMeta() {
    $('meta').innerHTML = 'Snapshot <b>' + esc(meta.as_of || '') + '</b><br>' +
      'Source: <b>DefiLlama</b><br>Floor: <b>' + fmtUsd(meta.floor_usd) + '</b>';
    $('stats').innerHTML =
      '<div class="stat"><b>' + rows.length + '</b><span>protocols ranked</span></div>' +
      '<div class="stat"><b>' + (meta.watchlist_size || 0) + '</b><span>on the watchlist</span></div>' +
      '<div class="stat"><b>' + (meta.pretoken_count || 0) + '</b><span>record no token</span></div>' +
      '<div class="stat"><b>' + fmtUsd(rows.length ? rows[0].implied_value_usd : 0) + '</b><span>top implied value</span></div>';
  }

  function showTab(name) {
    var tabs = document.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('active', tabs[i].getAttribute('data-tab') === name);
    $('tab-board').hidden = name !== 'board';
    $('tab-launched').hidden = name !== 'launched';
    $('tab-method').hidden = name !== 'method';
  }

  function readHash() {
    var h = window.location.hash || '';
    var m = h.match(/^#\/p\/([A-Za-z0-9._-]+)$/);
    if (m) { showTab('board'); selectProtocol(m[1], false); return; }
    var f = h.match(/^#\/f\/(.+)$/);
    if (f) {
      var cat = decodeURIComponent(f[1]);
      state.cat = cat;
      $('cat').value = cat;
      state.selected = null;
      $('detail').hidden = true;
      showTab('board');
      renderBoard();
    }
  }

  // Wire the controls.
  $('q').addEventListener('input', function () { state.q = this.value; renderBoard(); });
  $('cat').addEventListener('change', function () { state.cat = this.value; renderBoard(); });
  $('chain').addEventListener('change', function () { state.chain = this.value; renderBoard(); });
  $('watch').addEventListener('change', function () { state.watch = this.checked; renderBoard(); });
  $('sort').addEventListener('change', function () { state.sort = this.value; renderBoard(); });
  var tabs = document.querySelectorAll('.tab');
  for (var i = 0; i < tabs.length; i++) {
    tabs[i].addEventListener('click', function () { showTab(this.getAttribute('data-tab')); });
  }
  window.addEventListener('hashchange', readHash);

  fillSelects();
  renderMeta();
  renderBoard();
  renderLaunched();
  readHash();
})();
