// @ts-check
/* ============================================================
 * shared-ui.js — CLFN Housing Suite
 * UI primitives: toast, navigation stack, header, role switcher
 * ============================================================
 * Depends on: shared-config.js, shared-auth.js
 * Load order: shared.js → shared-config.js → shared-auth.js → THIS FILE → shared-data.js
 *
 * Exposes (as globals):
 *   showToast(msg, opts)           — notification toast
 *   pushNav(viewName)              — push to navigation stack
 *   goBack()                       — pop navigation stack and navigate
 *   setNavActive(id)               — highlight a sidebar nav button
 *   hideAllViews()                 — hide all page view containers
 *   updateHeaderUser(role)         — update header avatar/name/badge
 *   headerSignOut()                — prompt and sign out
 *   switchRole(role)               — set effective role + refresh UI
 *   updateRoleSwitcherVisibility() — no-op (handled by updateHeaderUser)
 *   edGuard(featureName, callback) — run callback if editScoreModel allowed, else toast and return false
 *   escapeHtml(v)                  — HTML-escape a value for safe innerHTML
 *   applyBrandingToHeader()        — patch nation-name placeholders in the page chrome from NATION_CONFIG
 *   applyNationOverrides()         — merge housing_settings.nation_config_override on top of NATION_CONFIG, then re-brand
 *   buildNationFooterStrip(opts)   — assemble a one-line Confidential footer from NATION_CONFIG contact fields
 *   _showView(id, renderFn)        — hide all + show one view + run renderFn
 *   _navStack                      — navigation history array
 * ============================================================ */

// ── Navigation stack ─────────────────────────────────────────────────────────
window._navStack = [];

// ── escapeHtml ───────────────────────────────────────────────────────────────
// Escape user-supplied data before interpolating it into innerHTML strings.
// Returns the empty string for null/undefined so template literals stay clean.
function escapeHtml(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── showToast → message box ───────────────────────────────────────────────────
// Messages no longer pop as transient stacked toasts (multiple firing at once
// is confusing and easy to miss). Instead they collect in ONE dismissible
// message box in the corner. Rows auto-clear after a configurable window
// (Settings -> Config -> Notifications display; default 10s, 0 = stay until
// dismissed) — see _toastTimeoutMs/_msgboxScheduleClear. Same call signature
// as before so every existing showToast(...) call keeps working.
//   opts.type — 'error' | 'info' | 'default'   (styles the row)
//   opts.duration / opts.position — accepted but ignored (kept for compat)
//
// Only errors and missing-information prompts are shown ('error' — every
// validation/"required field" message in the app already uses this type) plus
// 'info' (degraded/offline-mode notices like "saved locally — will sync when
// network is available", which matter even though they're not errors). Plain
// success confirmations ('default' — no type passed, e.g. "Records merged.",
// "Added: X") are suppressed outright: the UI change the user just performed
// is its own confirmation, so a routine "it worked" message is just clutter
// piling up in the message box (nothing here auto-dismisses).
function showToast(msg, opts) {
  opts = opts || {};
  var type = (opts.type === 'error' || opts.type === 'info') ? opts.type : 'default';
  if (type === 'default') return;
  var text = (msg === null || msg === undefined) ? '' : String(msg);
  if (!text) return;

  function _mount() {
    if (!document.body) {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _mount, { once: true });
      } else {
        setTimeout(_mount, 50);
      }
      return;
    }
    _msgboxAdd(text, type);
  }
  _mount();
}

// Create (once) the fixed message-box shell with a header + "Clear all" button.
function _msgboxEnsure() {
  var box = document.getElementById('clfn_msgbox');
  if (box) return box;
  box = document.createElement('div');
  box.id = 'clfn_msgbox';
  box.setAttribute('role', 'status');
  box.setAttribute('aria-live', 'polite');
  box.innerHTML =
      '<div id="clfn_msgbox_hdr">'
    +   '<span id="clfn_msgbox_title">Notifications</span>'
    +   '<button type="button" id="clfn_msgbox_clear" aria-label="Clear all messages">Clear all &times;</button>'
    + '</div>'
    + '<div id="clfn_msgbox_body"></div>';
  document.body.appendChild(box);
  box.querySelector('#clfn_msgbox_clear').addEventListener('click', function(){
    var b = box.querySelector('#clfn_msgbox_body');
    if (b) b.innerHTML = '';
    box.style.display = 'none';
  });
  return box;
}

// Auto-clear window for message rows, in ms. Configurable per nation via
// Settings -> Config -> "Notifications display" (housing_settings key
// toast_timeout_seconds, hydrated into _appSettings). Default 10s; 0 = rows
// stay until dismissed by hand (the original behaviour).
function _toastTimeoutMs() {
  var v = window._appSettings ? window._appSettings.toast_timeout_seconds : undefined;
  v = (v === undefined || v === null || v === '') ? 10 : Number(v);
  if (isNaN(v) || v <= 0) return 0;
  return Math.min(v, 600) * 1000;
}
function _msgboxScheduleClear(row, body, box) {
  if (row._clfnTimer) { clearTimeout(row._clfnTimer); row._clfnTimer = null; }
  var ms = _toastTimeoutMs();
  if (!ms) return;
  row._clfnTimer = setTimeout(function(){
    row.remove();
    if (!body.children.length) box.style.display = 'none';
  }, ms);
}

// Append a message row (newest on top). Identical repeated messages collapse to
// a single row with a count badge instead of piling up duplicates.
function _msgboxAdd(text, type) {
  var box  = _msgboxEnsure();
  var body = box.querySelector('#clfn_msgbox_body');
  if (!body) return;

  // Dedupe: bump the count on an existing identical row and float it to the top.
  var rows = body.children;
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].getAttribute('data-msg') === text) {
      var badge = rows[i].querySelector('.clfn-msg-count');
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'clfn-msg-count';
        badge.textContent = '1';
        rows[i].insertBefore(badge, rows[i].querySelector('.clfn-msg-x'));
      }
      badge.textContent = String((parseInt(badge.textContent, 10) || 1) + 1);
      body.insertBefore(rows[i], body.firstChild);
      box.style.display = '';
      _msgboxScheduleClear(rows[i], body, box);   // repeat resets the clock
      return;
    }
  }

  var row = document.createElement('div');
  row.className = 'clfn-msg-item clfn-msg-' + type;
  row.setAttribute('data-msg', text);

  var span = document.createElement('span');
  span.className = 'clfn-msg-text';
  span.textContent = text;

  var x = document.createElement('button');
  x.type = 'button';
  x.className = 'clfn-msg-x';
  x.setAttribute('aria-label', 'Dismiss');
  x.innerHTML = '&times;';
  x.addEventListener('click', function(){
    if (row._clfnTimer) clearTimeout(row._clfnTimer);
    row.remove();
    if (!body.children.length) box.style.display = 'none';
  });

  row.appendChild(span);
  row.appendChild(x);
  body.insertBefore(row, body.firstChild);
  box.style.display = '';
  _msgboxScheduleClear(row, body, box);

  // Backstop against a runaway loop flooding the DOM — keep the newest 40.
  while (body.children.length > 40) body.removeChild(body.lastChild);
}
window.showToast = showToast;


// ── pushNav ───────────────────────────────────────────────────────────────────
function pushNav(viewName) {
  var stack = window._navStack;
  if (stack.length && stack[stack.length - 1] === viewName) return; // no duplicates
  stack.push(viewName);
  if (stack.length > 20) stack.shift(); // cap
}

// ── Cross-page navigation referrer ────────────────────────────────────────────
// In-memory _navStack resets on every page navigation, so a back button on
// housing.html can't know the user came from match.html. setNavReferrer is
// called just before a cross-page redirect; consumeNavReferrer reads-and-clears
// on the destination. Persisted in sessionStorage so it survives the page load.
var CLFN_NAV_REFERRER_KEY = 'clfn_nav_referrer';
// Page-key → URL mapping. Used by goBack / closeApplicationForm when there is
// no in-page back target to fall back on.
window.CLFN_PAGE_ROUTES = window.CLFN_PAGE_ROUTES || {
  'home':        'housing.html',
  'worklist':    'housing.html?view=worklist',
  'inventory':   'inventory.html',
  'match':       'match.html',
  'renovations': 'renos.html',
  'contractors': 'contractors.html',
  'tenants':     'tenants.html',
  'settings':    'housing.html?view=settings'
};
function setNavReferrer(pageKey) {
  if (!pageKey) return;
  try { sessionStorage.setItem(CLFN_NAV_REFERRER_KEY, String(pageKey)); } catch(e) {}
}
function peekNavReferrer() {
  try { return sessionStorage.getItem(CLFN_NAV_REFERRER_KEY) || ''; } catch(e) { return ''; }
}
function consumeNavReferrer() {
  var v = peekNavReferrer();
  try { sessionStorage.removeItem(CLFN_NAV_REFERRER_KEY); } catch(e) {}
  return v;
}
// Read-and-clear the nav referrer and navigate to its route. Returns true when
// it navigated (so a modal close can `return` early), false when there was no
// referrer to honour (the caller should just stay on the current page). Used by
// deep-link-opened modals (unit card, contractor card, …) so that CLOSING a
// form opened via a cross-page worklist link returns the user to where they
// came from (e.g. the landing page) instead of stranding them on the
// destination page.
function _returnToNavReferrer() {
  if (typeof consumeNavReferrer !== 'function') return false;
  var ref = consumeNavReferrer();
  var routes = window.CLFN_PAGE_ROUTES || {};
  if (ref && routes[ref]) { window.location.href = routes[ref]; return true; }
  return false;
}
window._returnToNavReferrer = _returnToNavReferrer;

// ═══════════════════════════════════════════════════════════════════════════
// TABLE SORT + COLUMN-MENU FILTER — shared scaffolding (Phase 2)
// ═══════════════════════════════════════════════════════════════════════════
// Pattern: each <th> the page wants interactive carries data-sort-key="X"
// and class="std-th-sortable". Clicking ANY column header opens a small
// popover anchored to that column with:
//   • Sort: A→Z, Z→A, Clear
//   • Show values: a checklist of every value present in the current data
//     for that column, with counts. Tick/untick to filter that column.
// Sort and column-filters are combinable: one active sort across the table,
// plus per-column filter sets. Empty filter set = column passes through.
//
// State shape (persisted to sessionStorage so an in-tab reload preserves it):
//   { sort:    { key: '', dir: 1 },
//     filters: { colKey: ['valueA','valueB'], … }
//   }
//
// Per-page registration: the render fn calls tableRegisterColumns(page, config)
// each render so the menu has fresh accessor / row-source closures. The
// 'config' shape:
//   { columns: { colKey: { label, accessor: fn(row), filterable: bool } },
//     getRows: fn() → currentFilteredRows (pre-column-filter),
//     onChange: fn() // re-render }

var _TABLE_STATE_KEY = 'clfn_table_state';

function _tableStateAll() {
  try {
    var raw = sessionStorage.getItem(_TABLE_STATE_KEY);
    return raw ? (JSON.parse(raw) || {}) : {};
  } catch(e) { return {}; }
}
function _tableStateSave(all) {
  try { sessionStorage.setItem(_TABLE_STATE_KEY, JSON.stringify(all || {})); } catch(e) {}
}
function tableStateGet(page) {
  var all = _tableStateAll();
  if (!all[page]) all[page] = { sort: { key: '', dir: 1 }, filters: {} };
  if (!all[page].filters || typeof all[page].filters !== 'object') all[page].filters = {};
  return all[page];
}
function tableSetSort(page, key, dir) {
  var all = _tableStateAll();
  var st = all[page] || { sort: { key: '', dir: 1 }, filters: {} };
  if (dir === 0 || dir === null) {
    st.sort = { key: '', dir: 1 };
  } else if (dir === 1 || dir === -1) {
    st.sort = { key: key, dir: dir };
  } else {
    // No explicit dir → cycle asc → desc → off (legacy callers)
    if (st.sort.key !== key)       st.sort = { key: key, dir: 1 };
    else if (st.sort.dir > 0)      st.sort = { key: key, dir: -1 };
    else                            st.sort = { key: '',  dir: 1 };
  }
  all[page] = st;
  _tableStateSave(all);
}
function tableClearSort(page) { tableSetSort(page, '', 0); }

// Per-column filter helpers. Three states:
//   • missing (no filter set)    → show every row (default)
//   • [] empty array              → show nothing (every box unchecked)
//   • ['a','b']                   → show only rows where this column ∈ {a,b}
// tableClearColumnFilter removes the filter entirely (back to default).
// Passing an explicit [] keeps the filter active but with no values selected.
function tableSetColumnFilter(page, colKey, values) {
  var all = _tableStateAll();
  var st = all[page] || { sort: { key: '', dir: 1 }, filters: {} };
  if (!st.filters) st.filters = {};
  if (values == null) delete st.filters[colKey];
  else st.filters[colKey] = (values || []).map(String);
  all[page] = st;
  _tableStateSave(all);
}
function tableClearColumnFilter(page, colKey) {
  tableSetColumnFilter(page, colKey, null);
}

// Refresh ▲/▼ indicators on every <th data-sort-key> inside the given thead.
// Active column also gets the .is-sorted class so the CSS can paint the
// yellow background. Non-active columns clear it.
function tableRefreshSortIndicators(thead, page) {
  if (!thead) return;
  var state = tableStateGet(page);
  thead.querySelectorAll('th[data-sort-key]').forEach(function(th){
    var key = th.getAttribute('data-sort-key');
    var existing = th.querySelector('.std-sort-arrow');
    if (existing) existing.remove();
    // Mark columns that have an active filter so they get an indicator.
    // An explicit empty array (Clear → uncheck all) also counts as filtered.
    var hasFilter = !!(state.filters && state.filters[key] != null);
    th.classList.toggle('is-filtered', hasFilter);
    if (state.sort.key === key) {
      th.classList.add('is-sorted');
      var arrow = document.createElement('span');
      arrow.className = 'std-sort-arrow';
      arrow.textContent = state.sort.dir > 0 ? ' ▲' : ' ▼';
      th.appendChild(arrow);
    } else {
      th.classList.remove('is-sorted');
    }
  });
}

// Apply per-column filters + sort. Returns a flat sorted array.
// accessors = { colKey: fn(row) → value }.
function tableApplyFilterSort(rows, accessors, state) {
  state = state || { sort: { key: '', dir: 1 }, filters: {} };
  accessors = accessors || {};
  var filtered = (rows || []).slice();
  // Per-column filters (AND across columns, OR within each column).
  // Missing key = no filter on this column. Empty array = explicit "show
  // nothing" (every box unchecked in the menu — user clicked Clear).
  if (state.filters && typeof state.filters === 'object') {
    Object.keys(state.filters).forEach(function(colKey){
      var values = state.filters[colKey];
      if (values == null) return; // no filter on this column
      var get = accessors[colKey];
      if (typeof get !== 'function') return;
      if (!values.length) { filtered = []; return; } // explicit empty = show nothing
      var allowed = {};
      values.forEach(function(v){ allowed[String(v)] = true; });
      filtered = filtered.filter(function(r){
        var v = get(r);
        if (v == null || v === '') v = '(none)';
        return !!allowed[String(v)];
      });
    });
  }
  // Sort — decorate–sort–undecorate so each row's accessor runs ONCE, not
  // once per comparison. Some accessors are expensive (Reno Score walks the
  // whole inventory + SOW cache; Match Priority scores against every vacant
  // unit), and the comparator used to invoke them O(n log n) times.
  if (state.sort && state.sort.key && typeof accessors[state.sort.key] === 'function') {
    var getS = accessors[state.sort.key];
    var dir = state.sort.dir;
    var decorated = filtered.map(function(r){ return { r: r, v: getS(r) }; });
    decorated.sort(function(a, b){
      var av = a.v, bv = b.v;
      var aN = (av == null || av === '');
      var bN = (bv == null || bv === '');
      if (aN && bN) return 0;
      if (aN) return 1;
      if (bN) return -1;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      var as = String(av).toLowerCase(), bs = String(bv).toLowerCase();
      if (as < bs) return -1 * dir;
      if (as > bs) return  1 * dir;
      return 0;
    });
    filtered = decorated.map(function(d){ return d.r; });
  }
  return filtered;
}

// ── Column-menu popover ─────────────────────────────────────────────────
// One reusable popover element. Each open() rebuilds its content for the
// requested column. Click-outside / Escape close it.
window._tableRegistry = window._tableRegistry || {};
function tableRegisterColumns(page, config) {
  window._tableRegistry[page] = config || {};
}

function _ensureColumnMenu() {
  var menu = document.getElementById('std_col_menu');
  if (menu) return menu;
  menu = document.createElement('div');
  menu.id = 'std_col_menu';
  menu.className = 'std-col-menu';
  menu.style.display = 'none';
  document.body.appendChild(menu);
  return menu;
}

function tableCloseColumnMenu() {
  var menu = document.getElementById('std_col_menu');
  if (menu) { menu.style.display = 'none'; menu.innerHTML = ''; menu.removeAttribute('data-page'); menu.removeAttribute('data-col-key'); }
  document.removeEventListener('click',  _tableMenuOutsideClick, true);
  document.removeEventListener('keydown', _tableMenuKeydown,     true);
}

function _tableMenuOutsideClick(e) {
  var menu = document.getElementById('std_col_menu');
  if (!menu || menu.style.display === 'none') return;
  if (menu.contains(e.target)) return;
  if (e.target.closest('th[data-sort-key]')) return; // header clicks reopen the menu
  tableCloseColumnMenu();
}
function _tableMenuKeydown(e) {
  if (e.key === 'Escape') tableCloseColumnMenu();
}

function tableOpenColumnMenu(page, colKey, anchorTh) {
  var cfg = window._tableRegistry[page];
  if (!cfg || !cfg.columns || !cfg.columns[colKey]) return;
  var col = cfg.columns[colKey];
  var state = tableStateGet(page);

  var menu = _ensureColumnMenu();
  menu.setAttribute('data-page', page);
  menu.setAttribute('data-col-key', colKey);

  // Compute unique values + counts from the page's current row source.
  var rows = (typeof cfg.getRows === 'function') ? (cfg.getRows() || []) : [];
  var get  = col.accessor;
  var counts = {};
  rows.forEach(function(r){
    var v = (typeof get === 'function') ? get(r) : null;
    if (v == null || v === '') v = '(none)';
    v = String(v);
    counts[v] = (counts[v] || 0) + 1;
  });
  var valuesList = Object.keys(counts).sort();
  // Three states for selected:
  //   • undefined (filter absent) → all boxes checked (default — show all)
  //   • []                          → all boxes unchecked (user clicked Clear)
  //   • ['vacant', …]               → only those boxes checked
  var hasFilter  = !!(state.filters && state.filters[colKey]);
  var selected   = hasFilter ? state.filters[colKey] : [];
  var selSet     = {}; selected.forEach(function(v){ selSet[v] = true; });
  // allChecked = no explicit filter set yet. Show every value as checked.
  var allChecked = !hasFilter;

  var isFilterable = col.filterable !== false;
  var activeSort   = state.sort.key === colKey ? state.sort.dir : 0;

  // Build HTML
  var html = ''
    + '<div class="std-col-menu-header">' + _esc(col.label || colKey) + '</div>'
    + '<div class="std-col-menu-section">'
    +   '<button type="button" class="std-col-menu-action' + (activeSort === 1 ? ' is-active' : '') + '" data-action="sort-asc">▲ Sort A → Z</button>'
    +   '<button type="button" class="std-col-menu-action' + (activeSort === -1 ? ' is-active' : '') + '" data-action="sort-desc">▼ Sort Z → A</button>'
    +   '<button type="button" class="std-col-menu-action" data-action="sort-clear"' + (activeSort === 0 ? ' disabled' : '') + '>✕ Clear sort</button>'
    + '</div>';
  if (isFilterable && valuesList.length) {
    html += '<div class="std-col-menu-divider"></div>'
          + '<div class="std-col-menu-section std-col-menu-section-values">';
    // Always show a search box inside the popover — even for short lists
    // it's a quick filter, and on long lists (e.g. every address) it's
    // essential. Kept lightweight via a debounced filter on the values list.
    html += '<input type="text" class="std-col-menu-search" placeholder="🔍 Find..." />';
    html += '<div class="std-col-menu-values">';
    valuesList.forEach(function(v){
      var checked = allChecked || !!selSet[v];
      html += '<label class="std-col-menu-value">'
            +   '<input type="checkbox" data-value="' + _esc(v).replace(/"/g, '&quot;') + '"' + (checked ? ' checked' : '') + '/>'
            +   '<span class="std-col-menu-value-label">' + _esc(v) + '</span>'
            +   '<span class="std-col-menu-value-count">' + counts[v] + '</span>'
            + '</label>';
    });
    html += '</div>'
          + '<div class="std-col-menu-footer">'
          +   '<button type="button" class="std-col-menu-link" data-action="select-all">Select all</button>'
          +   '<button type="button" class="std-col-menu-link" data-action="clear-filter">Clear</button>'
          + '</div>'
          + '</div>';
  }
  menu.innerHTML = html;

  // Position the popover near the anchor th. Below the header, right-aligned
  // so it doesn't overflow on far-right columns.
  menu.style.display = 'block';
  menu.style.visibility = 'hidden';
  var rect = anchorTh ? anchorTh.getBoundingClientRect() : null;
  if (rect) {
    var menuW = menu.offsetWidth;
    var menuH = menu.offsetHeight;
    var top   = rect.bottom + window.scrollY + 4;
    var left  = rect.left   + window.scrollX;
    // Prefer left-aligned with the column; if that would overflow the viewport,
    // pull the menu left until it fits.
    if (left + menuW > window.scrollX + document.documentElement.clientWidth - 8) {
      left = Math.max(window.scrollX + 8, window.scrollX + document.documentElement.clientWidth - menuW - 8);
    }
    // If the menu would go off the bottom, flip it above the header.
    if (top + menuH > window.scrollY + document.documentElement.clientHeight - 8) {
      top = Math.max(window.scrollY + 8, rect.top + window.scrollY - menuH - 4);
    }
    menu.style.top  = top  + 'px';
    menu.style.left = left + 'px';
  }
  menu.style.visibility = '';

  // Wire menu interactions
  menu.querySelectorAll('[data-action]').forEach(function(btn){
    btn.addEventListener('click', function(){
      var action = btn.getAttribute('data-action');
      if (action === 'sort-asc')   { tableSetSort(page, colKey, 1); }
      else if (action === 'sort-desc')  { tableSetSort(page, colKey, -1); }
      else if (action === 'sort-clear') { tableClearSort(page); }
      else if (action === 'select-all') {
        // Select all = remove the filter entirely (default state: show every row).
        tableClearColumnFilter(page, colKey);
        menu.querySelectorAll('.std-col-menu-value input[type="checkbox"]').forEach(function(cb){ cb.checked = true; });
      }
      else if (action === 'clear-filter') {
        // Clear = uncheck every box. User can now tick the values they want.
        // Stored as an explicit empty filter so the table shows nothing until
        // they pick at least one value.
        tableSetColumnFilter(page, colKey, []);
        menu.querySelectorAll('.std-col-menu-value input[type="checkbox"]').forEach(function(cb){ cb.checked = false; });
      }
      if (typeof cfg.onChange === 'function') cfg.onChange();
      // For sort actions, close the menu after applying. For filter changes,
      // leave it open so the user can adjust multiple values.
      if (action === 'sort-asc' || action === 'sort-desc' || action === 'sort-clear') {
        tableCloseColumnMenu();
      }
    });
  });
  // Checkbox toggles — apply immediately, leave menu open.
  menu.querySelectorAll('.std-col-menu-value input[type="checkbox"]').forEach(function(cb){
    cb.addEventListener('change', function(){
      // Capture the full current selection from the menu and write it back.
      var newSel = [];
      menu.querySelectorAll('.std-col-menu-value input[type="checkbox"]').forEach(function(cb2){
        if (cb2.checked) newSel.push(cb2.getAttribute('data-value'));
      });
      // If all values are checked, that's the same as "no filter".
      if (newSel.length === valuesList.length) tableClearColumnFilter(page, colKey);
      else tableSetColumnFilter(page, colKey, newSel);
      if (typeof cfg.onChange === 'function') cfg.onChange();
    });
  });
  // Search box within the values list (only present when >8 values)
  var search = menu.querySelector('.std-col-menu-search');
  if (search) {
    search.addEventListener('input', function(){
      var q = (search.value || '').toLowerCase().trim();
      menu.querySelectorAll('.std-col-menu-value').forEach(function(row){
        var label = (row.textContent || '').toLowerCase();
        row.style.display = (!q || label.indexOf(q) !== -1) ? '' : 'none';
      });
    });
    setTimeout(function(){ search.focus(); }, 0);
  }

  // Install outside-click + Escape handlers
  setTimeout(function(){
    document.addEventListener('click',  _tableMenuOutsideClick, true);
    document.addEventListener('keydown', _tableMenuKeydown,     true);
  }, 0);
}

// Wire <th> click handlers — every sortable header opens the column menu.
// Idempotent: dedupes via a data-attribute flag on the thead.
function tableBindColumnMenuClicks(thead, page) {
  if (!thead || thead.getAttribute('data-col-menu-bound') === '1') return;
  thead.setAttribute('data-col-menu-bound', '1');
  thead.addEventListener('click', function(e){
    var th = e.target.closest('th[data-sort-key]');
    if (!th || !thead.contains(th)) return;
    e.stopPropagation();
    tableOpenColumnMenu(page, th.getAttribute('data-sort-key'), th);
  });
}

// Local HTML-escape helper (reuses the existing escapeHtml if available).
function _esc(s) {
  if (typeof escapeHtml === 'function') return escapeHtml(s == null ? '' : String(s));
  return String(s == null ? '' : s).replace(/[&<>"]/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];
  });
}

// ── goBack ────────────────────────────────────────────────────────────────────
// Pops the navigation stack and navigates to the previous view.
// Pages register their view→function map via window._navMap.
// Default map covers the common views; pages can extend it.
function goBack() {
  // Cross-page referrer wins — if a sibling page stamped one before the
  // current page loaded, route back to that page instead of falling through
  // to the in-memory stack (which resets on every navigation).
  var ref = consumeNavReferrer();
  if (ref) {
    var routes = window.CLFN_PAGE_ROUTES || {};
    if (routes[ref]) { window.location.href = routes[ref]; return; }
  }
  var stack = window._navStack;
  if (stack.length) stack.pop();
  while (stack.length && stack[stack.length - 1] === 'app') stack.pop();
  var prev    = stack.length ? stack[stack.length - 1] : null;
  var navMap  = window._navMap || {};
  var handler = prev && navMap[prev];
  if (typeof handler === 'function') { handler(); return; }
  // No in-page back target (e.g. a freshly-loaded sub-page whose in-memory
  // stack is empty). Return to the ACTUAL previous screen using the browser's
  // real history — the user reached this page via a hard navigation — instead
  // of always dumping them at the landing page. Only fall back to home when
  // there's genuinely nowhere to go back to (direct deep-link / bookmark).
  if (window.history.length > 1) { window.history.back(); return; }
  if (typeof showEmployeeHome === 'function') showEmployeeHome();
}

// ── setNavActive ──────────────────────────────────────────────────────────────
function setNavActive(id) {
  var allTabs = [
    'tab_app','tab_dash','tab_scores','tab_settings','tab_match',
    'tab_inventory','tab_contractors','tab_tenants','tab_renos','tab_budget'
  ];
  allTabs.forEach(function(tid) {
    var b = document.getElementById(tid);
    if (b) { b.classList.remove('nav-active'); b.style.background = ''; b.style.color = ''; b.style.borderColor = ''; }
  });
  var el = document.getElementById(id);
  if (!el) return;
  if (id === 'tab_settings') {
    el.style.background   = 'rgba(248,228,26,0.12)';
    el.style.color        = 'var(--yellow)';
    el.style.borderColor  = 'var(--yellow)';
  } else {
    el.style.background   = 'var(--yellow)';
    el.style.color        = '#111';
    el.style.borderColor  = 'var(--yellow)';
  }
  el.classList.add('nav-active');
}

// ── hideAllViews ──────────────────────────────────────────────────────────────
// Hides every top-level view container. Pages can extend window._viewIds
// to include page-specific view IDs.
function hideAllViews(keepId) {
  var base = [
    'appLayout','settingsView','scorecardView',
    'dashView','employeeHomeView','worklistView','landingView',
    'inventoryView','matchView','tenantsView',
    'renoApprovalsView','renosView','contractorsView',
    'renosLoadingView'
  ];
  var extra = window._extraViewIds || [];
  base.concat(extra).forEach(function(id) {
    if (id === keepId) return; // keep the target visible during transition
    var el = document.getElementById(id);
    if (el) { el.style.display = 'none'; el.style.flex = ''; }
  });
  var spb = document.getElementById('stepProgressBar'); if (spb) spb.style.display = 'none';
  var abr = document.getElementById('appBackRow'); if (abr) abr.style.display = 'none';
}

// ── _showView ─────────────────────────────────────────────────────────────────
// Show target view first (before hiding others) so there's never a blank frame.
function _showView(id, renderFn) {
  var el = document.getElementById(id);
  // Show target before hiding others — eliminates blank-frame flash
  if (el) { el.style.display = 'flex'; el.style.width = '100%'; }
  hideAllViews(id);
  // Restore after hideAllViews in case it touched the kept element
  if (el) { el.style.display = 'flex'; el.style.width = '100%'; }
  if (typeof renderFn === 'function') renderFn();
}

// ── updateHeaderUser ──────────────────────────────────────────────────────────
// Updates avatar initials, name label, role badge, and conditional buttons.
// Uses CLFN_PERMS.roleLabel() for display names when available.
function updateHeaderUser(role) {
  var perms = window.CLFN_PERMS;

  // Display label — use CLFN_PERMS if available, fall back to simple map
  var label = (perms && perms.roleLabel) ? perms.roleLabel(role) : (
    { housing_employee_l1: 'Housing Staff', housing_employee_l2: 'Housing Staff',
      housing_manager: 'Housing Manager', ed: 'Executive Director',
      cfo: 'CFO', finance_l1: 'Finance Clerk' }[role] || 'Staff'
  );

  // Short badge (shown next to name). Only management-tier roles get one;
  // for those, derive the letters from the (possibly renamed) label so
  // a rename in Settings -> Nation flows through automatically. Skips
  // common joiners (of, and, the, &) so "Lands & Housing Director" -> "LH".
  function _initialsFromLabel(s) {
    if (!s) return '';
    var words = String(s).trim().split(/\s+/).filter(function(w){
      return w && !/^(of|the|and|a|an|&)$/i.test(w);
    });
    if (!words.length) return '';
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  var BADGE_ROLES = { housing_manager: 1, ed: 1, cfo: 1 };
  var badge = BADGE_ROLES[role] ? _initialsFromLabel(label) : '';

  // Avatar initials — name initials if a session name exists, else
  // derive from the (renamed) label so the avatar tracks the rename
  // even when sessions lack a display name.
  var initials = _initialsFromLabel(label) || '?';
  if (HOUSING_SESSION && HOUSING_SESSION.name) {
    var parts = HOUSING_SESSION.name.trim().split(/\s+/);
    initials = parts.length >= 2
      ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
      : HOUSING_SESSION.name.slice(0, 2).toUpperCase();
  }

  var av     = document.getElementById('header_avatar');     if (av)     av.textContent = initials;
  var nameEl = document.getElementById('header_user_name');  if (nameEl) nameEl.textContent = HOUSING_SESSION.name || label;
  var badgeEl= document.getElementById('header_role_badge');
  if (badgeEl) { badgeEl.textContent = badge; badgeEl.style.display = badge ? '' : 'none'; }

  // Show Settings only for HM / ED
  var settingsBtn = document.getElementById('header_settings_btn');
  if (settingsBtn) settingsBtn.style.display =
    (ROLE.isManagement(role)) ? 'flex' : 'none';

  // Add Staff entry now lives under Settings → Admin → Users (gated via
  // applyRoleVisibility on data-roles="ed,housing_manager"); no header pill.
}

// ── headerSignOut ─────────────────────────────────────────────────────────────
function headerSignOut() {
  if (HOUSING_SESSION && HOUSING_SESSION.accessToken) {
    showConfirm({
      title:       'Sign out?',
      message:     'You will be returned to the sign-in screen.',
      confirmText: 'Sign Out'
    }).then(function(ok){ if (ok) doLogout(); });
  } else {
    switchRole('housing_employee_l1');
    showToast('Signed out.', {type:'info'});
  }
}

// ── switchRole ────────────────────────────────────────────────────────────────
// Sets the effective role (honours view-as). Pages that need post-switch
// rendering should register window._onSwitchRole = function(role){...}
function switchRole(role) {
  window.currentRole = role;
  updateHeaderUser(role);

  // Update nav dashboard label
  var dashLabel = document.getElementById('tab_dash_label');
  if (dashLabel) dashLabel.textContent =
    (ROLE.isManagement(role)) ? 'Dashboard' : 'Home';

  // Hide Settings nav for HE-L1/L2
  var settingsBtn = document.getElementById('tab_settings');
  if (settingsBtn) settingsBtn.style.display =
    (ROLE.isManagement(role)) ? '' : 'none';

  // Notify page — skip during boot to prevent flash back to landing page
  // window._booting is set true before resolveHousingRole and cleared after
  // initHousingPage completes. Interactive role switches (My Role dropdown)
  // happen after boot so _booting is false and _onSwitchRole fires normally.
  if (!window._booting && typeof window._onSwitchRole === 'function') {
    try { window._onSwitchRole(role); } catch(e) { console.warn('[ui] _onSwitchRole error:', e); }
  }
}

// ── updateRoleSwitcherVisibility ──────────────────────────────────────────────
// No-op — handled by updateHeaderUser. Kept as a stub so any residual calls
// in older modules don't throw. Safe to delete once all callers are gone.
function updateRoleSwitcherVisibility() { /* handled by updateHeaderUser */ }

// ── applyBrandingToHeader ────────────────────────────────────────────────────
// Replaces nation-name placeholders in the static page chrome with the values
// from NATION_CONFIG, so the same HTML can ship to any nation.
//
// Hooks (no-ops if the element/marker isn't present on the current page):
//   - <span class="hbrand-sub">              → NATION_CONFIG.display_name
//   - data-nation="display_name"             → NATION_CONFIG.display_name
//   - data-nation="short"                    → NATION_CONFIG.short
//   - data-nation-template="{NATION} — Housing Department"
//                                            → "{display_name} — Housing Department"
//                                              ({SHORT} → short, {NATION} → display)
//   - <title> — only updated if it contains the placeholder token
//                {NATION_DISPLAY_NAME}
//
// Idempotent: safe to call repeatedly; the boot wiring at the bottom of this
// file invokes it once on DOMContentLoaded.
function applyBrandingToHeader() {
  var cfg = window.NATION_CONFIG;
  if (!cfg) return;
  var disp  = cfg.display_name || cfg.name || '';
  var short = cfg.short        || '';

  // .hbrand-sub appears in the header strip on every top-level page.
  document.querySelectorAll('.hbrand-sub').forEach(function(el){
    if (disp) el.textContent = disp;
  });

  // data-nation="display_name" / data-nation="short" — generic hook for any
  // place we want to inject the nation label without hard-coding a class.
  document.querySelectorAll('[data-nation="display_name"]').forEach(function(el){
    if (disp) el.textContent = disp;
  });
  document.querySelectorAll('[data-nation="short"]').forEach(function(el){
    if (short) el.textContent = short;
  });
  // data-nation-template — supports {NATION} and {SHORT} placeholders so
  // markup can read e.g. "{NATION} — Housing Department" and stay nation-agnostic.
  document.querySelectorAll('[data-nation-template]').forEach(function(el){
    var t = el.getAttribute('data-nation-template') || '';
    el.textContent = t.replace(/\{NATION\}/g, disp).replace(/\{SHORT\}/g, short);
  });

  // data-role-label="ed" → resolves via CLFN_PERMS.roleLabel(role), which
  // honors NATION_CONFIG.role_labels overrides. Keeps inline HTML text
  // ("Executive Director") nation-overridable without hardcoded strings.
  if (window.CLFN_PERMS && window.CLFN_PERMS.roleLabel) {
    document.querySelectorAll('[data-role-label]').forEach(function(el){
      var key = el.getAttribute('data-role-label');
      if (key) el.textContent = window.CLFN_PERMS.roleLabel(key);
    });
  }

  // Document title — only swap if a placeholder token is present so we don't
  // clobber pages that intentionally set a static title (e.g. "Sign In").
  // Supports {NATION_DISPLAY_NAME} and {NATION_SHORT} placeholders.
  if (document.title && /\{NATION_(DISPLAY_NAME|SHORT)\}/.test(document.title)) {
    document.title = document.title
      .replace(/\{NATION_DISPLAY_NAME\}/g, disp)
      .replace(/\{NATION_SHORT\}/g,        short);
  }
}

// Run once at boot. Pages that re-render the header later can call this again.
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyBrandingToHeader);
  } else {
    // Document already parsed (deferred shared-ui.js load) — apply immediately.
    applyBrandingToHeader();
  }
}

// ── applyNationOverrides ─────────────────────────────────────────────────────
// Merges window._appSettings.nation_config_override (a {display_name, short,
// role_labels} object saved via Settings → Nation) on top of the build-time
// NATION_CONFIG, then re-runs applyBrandingToHeader() so any new values land
// in the page chrome immediately. Logo overrides ride along on the existing
// theme.logo settings key (handled by _applyTheme), not on this key.
//
// Call this AFTER housing_settings has been hydrated into _appSettings (i.e.
// from the same boot point that runs initApprovalAuthority and _applyTheme).
// Safe to call multiple times — each call overwrites the previous merge.
function applyNationOverrides() {
  try {
    var saved = window._appSettings && window._appSettings['nation_config_override'];
    if (!saved) return;
    var parsed = (typeof saved === 'string') ? JSON.parse(saved) : saved;
    if (!parsed || typeof parsed !== 'object') return;
    if (!window.NATION_CONFIG) window.NATION_CONFIG = {};
    // Logo lives in _appSettings.theme.logo (managed by _applyTheme), NOT here —
    // applyNationOverrides only owns nation identity, contact info, and labels.
    ['display_name', 'name', 'short',
     'mailing_address', 'website', 'phone', 'email'].forEach(function(k){
      if (parsed[k]) window.NATION_CONFIG[k] = parsed[k];
    });
    if (parsed.role_labels && typeof parsed.role_labels === 'object') {
      window.NATION_CONFIG.role_labels = Object.assign(
        {}, window.NATION_CONFIG.role_labels || {}, parsed.role_labels
      );
    }
    if (parsed.socials && typeof parsed.socials === 'object') {
      window.NATION_CONFIG.socials = Object.assign(
        {}, window.NATION_CONFIG.socials || {}, parsed.socials
      );
    }
    // Auto sign-out window — drive the idle-logout timer from saved config.
    // Default (15 min) stays in shared-auth.js; this overrides it when set and
    // re-arms the watcher so the change applies immediately (not just next login).
    var idleMin = parseInt(parsed.idle_timeout_minutes, 10);
    if (idleMin >= 1 && idleMin <= 1440) {
      window.NATION_CONFIG.idle_timeout_minutes = idleMin;
      window.IDLE_TIMEOUT_MS = idleMin * 60 * 1000;
      if (typeof startIdleTimer === 'function') { try { startIdleTimer(); } catch(e) {} }
    }
    applyBrandingToHeader();
  } catch (e) {
    console.warn('[applyNationOverrides] failed:', e);
  }
}

// ── buildNationFooterStrip ───────────────────────────────────────────────────
// Returns a single-line "Confidential" footer string assembled from the saved
// NATION_CONFIG contact fields. Used by every print template (contractor
// agreement, work order, SOW, application snapshot, reno report) so they all
// render the same "{Nation} Housing Department · {address} · {phone} · {email}
// · {website} · Confidential" strip. Empty fields are skipped.
//
//   opts.includeConfidential — when true (default), appends "· Confidential"
//   opts.suffix              — extra trailing text (e.g. "Work Order")
function buildNationFooterStrip(opts) {
  opts = opts || {};
  var cfg = window.NATION_CONFIG || {};
  var disp = cfg.display_name || cfg.name || '';
  // Collapse multi-line addresses to comma-separated for single-line footers.
  var addr = (cfg.mailing_address || '').replace(/\s*\n+\s*/g, ', ').trim();
  var parts = [];
  if (disp)        parts.push(disp + ' Housing Department');
  if (addr)        parts.push(addr);
  if (cfg.phone)   parts.push(cfg.phone);
  if (cfg.email)   parts.push(cfg.email);
  if (cfg.website) parts.push(cfg.website);
  if (opts.suffix) parts.push(opts.suffix);
  if (opts.includeConfidential !== false) parts.push('Confidential');
  return parts.join(' · ');
}

// ── edGuard ───────────────────────────────────────────────────────────────────
// Wraps a callback with the editScoreModel approval gate. If the current role
// is allowed, the callback is invoked and the function returns true (or the
// callback's return value when it returns one). Otherwise a toast is shown
// and false is returned.
// Usage: edGuard('scoring model changes', function(){ ...do edit... });
function edGuard(featureName, callback) {
  var role = window.currentRole;
  if (window.APPROVAL_AUTHORITY && APPROVAL_AUTHORITY.can('editScoreModel', role)) {
    if (typeof callback === 'function') {
      var rv = callback();
      return (rv === undefined) ? true : rv;
    }
    return true;
  }
  showToast((featureName || 'This action') + ' requires Executive Director access.', { type: 'error' });
  return false;
}

// ── clfnSearchSelect — reusable searchable combobox ─────────────────────────
// Usage:
//   clfnSearchSelect({
//     wrap:        Element,          // container element to render into
//     items:       [{id, label}],    // option list
//     value:       '',               // initial selected id
//     placeholder: 'Search…',
//     onChange:    function(id, label) {}
//   })
// Returns { getValue, setValue, destroy }
//
// Renders a text input + body-portal dropdown so overflow:hidden parents
// cannot clip the list. Arrow keys / Enter / Escape for keyboard nav.
(function(){
  var _ESC = typeof escapeHtml === 'function' ? escapeHtml : function(s){
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  };

  function _portal() {
    var d = document.getElementById('clfn-ss-portal');
    if (!d) {
      d = document.createElement('div');
      d.id = 'clfn-ss-portal';
      document.body.appendChild(d);
    }
    return d;
  }

  window.clfnSearchSelect = function(opts) {
    var wrap        = opts.wrap;
    var items       = opts.items || [];
    var placeholder = opts.placeholder || 'Search…';
    var onChange    = opts.onChange || function(){};
    var selectedId  = opts.value || '';
    var selectedLabel = '';

    // Find initial label
    if (selectedId) {
      var found = items.find(function(it){ return it.id === selectedId; });
      if (found) selectedLabel = found.label;
    }

    // Build input
    wrap.innerHTML = '';
    wrap.className = (wrap.className || '') + ' clfn-ss-wrap';
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'tic-input clfn-ss-input';
    input.placeholder = placeholder;
    input.autocomplete = 'off';
    input.value = selectedLabel;
    wrap.appendChild(input);

    // Caret icon
    var caret = document.createElement('span');
    caret.className = 'clfn-ss-caret';
    caret.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="12" height="12"><polyline points="6 9 12 15 18 9"/></svg>';
    wrap.appendChild(caret);

    // Portal dropdown
    var drop = document.createElement('div');
    drop.className = 'clfn-ss-drop';
    _portal().appendChild(drop);

    var activeIdx = -1;
    var isOpen = false;

    function getFiltered(q) {
      var query = (q || '').toLowerCase().trim();
      return query
        ? items.filter(function(it){ return it.label.toLowerCase().indexOf(query) !== -1; })
        : items.slice();
    }

    function position() {
      var r = input.getBoundingClientRect();
      drop.style.left  = r.left + 'px';
      drop.style.top   = (r.bottom + 2) + 'px';
      drop.style.width = r.width + 'px';
    }

    function renderDrop(filtered) {
      activeIdx = -1;
      if (!filtered.length) {
        drop.innerHTML = '<div class="clfn-ss-empty">No results</div>';
      } else {
        drop.innerHTML = filtered.map(function(it, i){
          var sel = it.id === selectedId ? ' clfn-ss-selected' : '';
          return '<div class="clfn-ss-item' + sel + '" data-idx="' + i + '" data-id="' + _ESC(it.id) + '" data-label="' + _ESC(it.label) + '">' + _ESC(it.label) + '</div>';
        }).join('');
      }
      // Scroll selected item into view
      var sel = drop.querySelector('.clfn-ss-selected');
      if (sel) sel.scrollIntoView({ block: 'nearest' });
    }

    function open() {
      position();
      renderDrop(getFiltered(input.value));
      drop.style.display = 'block';
      isOpen = true;
      input.select();
    }

    function close() {
      drop.style.display = 'none';
      isOpen = false;
      activeIdx = -1;
      // Restore display label
      input.value = selectedLabel;
    }

    function selectItem(id, label) {
      selectedId    = id;
      selectedLabel = label;
      input.value   = label;
      drop.style.display = 'none';
      isOpen = false;
      activeIdx = -1;
      onChange(id, label);
    }

    function highlightIdx(i, items) {
      var rows = drop.querySelectorAll('.clfn-ss-item');
      rows.forEach(function(r){ r.classList.remove('clfn-ss-active'); });
      if (i >= 0 && i < rows.length) {
        rows[i].classList.add('clfn-ss-active');
        rows[i].scrollIntoView({ block: 'nearest' });
      }
    }

    input.addEventListener('focus', function(){ open(); });
    input.addEventListener('click', function(){ if(!isOpen) open(); });

    input.addEventListener('input', function(){
      selectedId = ''; selectedLabel = '';
      position();
      var f = getFiltered(input.value);
      renderDrop(f);
      drop.style.display = 'block';
      isOpen = true;
    });

    input.addEventListener('keydown', function(e){
      if (!isOpen) { open(); return; }
      var rows = drop.querySelectorAll('.clfn-ss-item');
      if (e.key === 'ArrowDown')  { e.preventDefault(); activeIdx = Math.min(activeIdx + 1, rows.length - 1); highlightIdx(activeIdx, rows); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); activeIdx = Math.max(activeIdx - 1, 0); highlightIdx(activeIdx, rows); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        if (activeIdx >= 0 && rows[activeIdx]) {
          selectItem(rows[activeIdx].getAttribute('data-id'), rows[activeIdx].getAttribute('data-label'));
        }
      }
      else if (e.key === 'Escape') { close(); }
    });

    drop.addEventListener('mousedown', function(e){
      var item = /** @type {Element} */(e.target).closest('.clfn-ss-item');
      if (item) { e.preventDefault(); selectItem(item.getAttribute('data-id'), item.getAttribute('data-label')); }
    });

    // Persistent outside-click closer. The old {once:true} listener only
    // re-armed on an INSIDE click while open — after the first selection or
    // any outside click it was consumed and never re-added, so from the second
    // open onward the dropdown stayed glued open until Escape.
    document.addEventListener('click', function(e){
      if (isOpen && !wrap.contains(/** @type {Node} */(e.target)) && !drop.contains(/** @type {Node} */(e.target))) close();
    });

    caret.addEventListener('mousedown', function(e){
      e.preventDefault();
      if (isOpen) close(); else { input.focus(); open(); }
    });

    return {
      getValue: function(){ return selectedId; },
      getLabel: function(){ return selectedLabel; },
      setValue: function(id, label){
        selectedId = id; selectedLabel = label || id;
        input.value = selectedLabel;
      },
      destroy: function(){
        if (drop.parentNode) drop.parentNode.removeChild(drop);
        wrap.innerHTML = '';
      }
    };
  };
}());

// ── Tip popover toggle (shared) ─────────────────────────────────────────────
// Drives the `.tip-panel` open/close state used on form fields and table
// headers. Wired into markup via onclick="toggleTip('id')" or closeTip('id').
function toggleTip(id){
  var el = document.getElementById(id);
  if(el) el.classList.toggle('is-open');
}
function closeTip(id){
  var el = document.getElementById(id);
  if(el) el.classList.remove('is-open');
}

// ── Scroll-collapse (shared) ─────────────────────────────────────────────────
// Toggles an `.is-scrolled` class on a "key info" element (a .tic-strip,
// .kpi-strip, or .page-header-bar) once its scroll container passes a small
// threshold, and removes it near the top — mirrors the MyChart-style pattern
// of a hero/tile row shrinking to a compact bar once the user starts reading
// content, then expanding back when they scroll back up. Purely visual: CSS
// (housing.css) owns what "collapsed" looks like per element type; this just
// flips the class. Idempotent — wiring the same stripEl twice is a no-op, so
// callers can call this from a render function that runs more than once.
function _initScrollCollapse(scrollEl, stripEl, opts){
  if(!scrollEl || !stripEl) return;
  if(stripEl.dataset.scrollCollapseWired === '1') return;
  stripEl.dataset.scrollCollapseWired = '1';
  var threshold = (opts && opts.threshold) || 16;
  var ticking = false;
  function apply(){
    var isWin = (scrollEl === window);
    var y = isWin ? (window.scrollY || document.documentElement.scrollTop) : scrollEl.scrollTop;
    var isOn = stripEl.classList.contains('is-scrolled');
    if(!isOn){
      // Collapsing the strip makes the scroll container taller (the strip is a
      // sibling above it), which REDUCES the container's overflow. On a short
      // card that removes the overflow entirely: scrollTop snaps to 0, the
      // strip expands, the content overflows again — flashing every frame.
      // So only collapse when the content overflows (in the current expanded
      // state) by clearly MORE than the strip will reclaim, guaranteeing the
      // container is still scrollable after collapsing.
      var overflow = isWin
        ? ((document.documentElement.scrollHeight || 0) - window.innerHeight)
        : (scrollEl.scrollHeight - scrollEl.clientHeight);
      if(y > threshold && overflow > threshold + 48) stripEl.classList.add('is-scrolled');
    } else {
      // Once collapsed, only expand when scrolled back near the top — a small
      // hysteresis band so we never toggle rapidly at the threshold boundary.
      if(y < Math.max(0, threshold - 8)) stripEl.classList.remove('is-scrolled');
    }
    ticking = false;
  }
  function onScroll(){
    if(ticking) return;
    ticking = true;
    (window.requestAnimationFrame || function(fn){ setTimeout(fn, 16); })(apply);
  }
  scrollEl.addEventListener('scroll', onScroll, { passive: true });
  apply(); // initial state — handles a modal reopened mid-scroll, or a page loaded already scrolled
}
window._initScrollCollapse = _initScrollCollapse;

/* ============================================================================
 * Global swipe-between-tabs (touch devices). One document-level listener makes
 * a horizontal swipe move to the previous/next tab of whatever tab group is
 * active on screen — modals (.tic-tab/.tic-active), Settings sub-tabs
 * (.tab-btn/.active), and group pills (.pill-tab/.active). Loaded on every page
 * via shared-ui.js, so it works app-wide. Swipe left = next tab, right = prev.
 * ========================================================================== */
(function(){
  if (window._swipeTabsWired) return;
  window._swipeTabsWired = true;

  var CONV = [
    { sel: '.tic-tab',  active: 'tic-active' },  // modals (Edit Unit / TIC / SOW) — top surface
    { sel: '.tab-btn',  active: 'active'     },  // sub-tabs
    { sel: '.pill-tab', active: 'active'     }   // group pills
  ];

  function _vis(el){ return !!(el && el.offsetParent !== null && el.getClientRects().length); }

  // Is the swipe inside a DEDICATED horizontal scroller (table, tab bar, card
  // rail)? If so, let native scrolling win instead of switching tabs. A vertical
  // scroll container (overflow-y auto/scroll) is NOT counted even if its
  // overflow-x computes to auto (a CSS quirk) — otherwise a slightly-too-wide
  // field row would silently disable swipe inside modals/pages.
  function _inHScroll(el){
    var n = el, guard = 0;
    while (n && n.nodeType === 1 && guard++ < 14) {
      try {
        var s = getComputedStyle(n);
        var xScroll = (s.overflowX === 'auto' || s.overflowX === 'scroll') && n.scrollWidth > n.clientWidth + 4;
        var yScroll = (s.overflowY === 'auto' || s.overflowY === 'scroll');
        if (xScroll && !yScroll) return true;   // horizontal-only scroller — preserve it
      } catch (_e) {}
      n = n.parentElement;
    }
    return false;
  }

  function _groupFor(activeEl, sel){
    var parent = activeEl.parentElement; if (!parent) return null;
    var tabs = Array.prototype.filter.call(parent.querySelectorAll(sel), function(t){ return t.parentElement === parent && _vis(t); });
    if (tabs.length < 2) return null;
    var idx = tabs.indexOf(activeEl); if (idx < 0) return null;
    return { tabs: tabs, idx: idx, parent: parent };
  }

  // Pick the tab group to drive: modal groups win (they sit on top); otherwise
  // the on-page group whose tab bar is vertically nearest the swipe.
  function _findGroup(y){
    var cands = [];
    for (var c = 0; c < CONV.length; c++) {
      var actives = document.querySelectorAll(CONV[c].sel + '.' + CONV[c].active);
      for (var a = 0; a < actives.length; a++) {
        if (!_vis(actives[a])) continue;
        var g = _groupFor(actives[a], CONV[c].sel);
        if (g) { g.conv = c; cands.push(g); }
      }
    }
    if (!cands.length) return null;
    var modal = cands.filter(function(g){ return g.conv === 0; });
    var pool = modal.length ? modal : cands;
    var best = null, bestDist = Infinity;
    for (var i = 0; i < pool.length; i++) {
      var r = pool[i].parent.getBoundingClientRect();
      var d = Math.abs((r.top + r.bottom) / 2 - y);
      if (d < bestDist) { bestDist = d; best = pool[i]; }
    }
    return best;
  }

  var sx = null, sy = null, st = 0, sEl = null;
  document.addEventListener('touchstart', function(e){
    if (!e.touches || e.touches.length !== 1) { sx = null; return; }
    var t = e.touches[0]; sx = t.clientX; sy = t.clientY; st = Date.now(); sEl = e.target;
  }, { passive: true });

  document.addEventListener('touchend', function(e){
    if (sx == null) return;
    var t = e.changedTouches[0];
    var dx = t.clientX - sx, dy = t.clientY - sy, dt = Date.now() - st, el = sEl, y = sy;
    sx = null;
    if (dt > 700) return;                                 // too slow to be a flick
    if (Math.abs(dx) < 60) return;                        // min horizontal travel
    if (Math.abs(dx) < Math.abs(dy) * 1.7) return;        // must be mostly horizontal
    if (el && el.closest && el.closest('input,textarea,select,[contenteditable="true"],[data-noswipe],table')) return;
    if (_inHScroll(el)) return;
    var g = _findGroup(y);
    if (!g) return;
    var nx = dx < 0 ? g.idx + 1 : g.idx - 1;              // swipe left => next tab
    if (nx < 0 || nx >= g.tabs.length) return;
    g.tabs[nx].click();
    try { g.tabs[nx].scrollIntoView({ inline: 'center', block: 'nearest' }); } catch (_e) {}
  }, { passive: true });
})();
