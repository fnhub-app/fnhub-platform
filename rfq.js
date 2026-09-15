'use strict';

var _rfqCurrentId       = null;
var _rfqSowUnitId       = null;
var _rfqSowPn           = null;
var _rfqSowData         = null;
var _rfqUnitData        = null;
var _rfqScopeItems      = [];
var _rfqSelectedCts     = {};
var _rfqBids            = {};   // staff-entered bids: { [contractorId]: {amount, notes, received_at} }
var _rfqActiveTab       = 'details';
var _rfqAwardingId      = null;
var _rfqScopeDetailRows  = [];
var _rfqMilestoneRows    = [];
var _rfqMaterialsRows    = [];
var _rfqExclusionsRows   = [];
var _rfqClfnSuppliedRows = [];
var _rfqSubcontractorRows = [];  // {contractorId, name, trade, scope} — sub-trades from the contractor registry
var _rfqDocFiles         = [];   // cached list from audit log
var _rfqAttachedPaths    = [];   // paths selected to attach to email
var _rfqContractEmailed  = false; // true once the generated contract has been emailed (locks attach-to-email)
var _rfqDocLib           = null; // DocLibrary instance for this RFQ

// ── Page init (mirrors renos.html IIFE pattern — never loads housing-init.js) ─
(async function initRfq() {
  // Restore session from sessionStorage (same keys as renos.html)
  var token = null, savedRole = null, savedName = null, savedEmail = null;
  try {
    token      = sessionStorage.getItem('clfn_housing_token');
    savedRole  = sessionStorage.getItem('clfn_housing_role')          || 'housing_employee_l1';
    savedName  = sessionStorage.getItem('clfn_housing_name')          || '';
    savedEmail = sessionStorage.getItem('clfn_housing_email_session') || '';
  } catch(e) {}
  if (!token) { window.location.href = 'index.html'; return; }

  HOUSING_HEADERS['Authorization'] = 'Bearer ' + token;
  HOUSING_SESSION.accessToken = token;
  HOUSING_SESSION.role  = savedRole;
  HOUSING_SESSION.name  = savedName;
  HOUSING_SESSION.email = savedEmail;
  window.currentRole    = savedRole;
  if (!window._realRole) window._realRole = savedRole;

  // Verify the role against the staff table — this page previously trusted
  // sessionStorage alone, so a promotion/demotion never applied here until
  // re-login (every other sub-page already resolves).
  if (HOUSING_SESSION.email && typeof resolveHousingRole === 'function') {
    try { await resolveHousingRole(); } catch(e) { console.warn('[RFQ] role resolve:', e); }
    window.currentRole = HOUSING_SESSION.role || savedRole;
    window._realRole   = HOUSING_SESSION.role || savedRole;
  }

  // Header is rendered by renderAppHeader() in housing-init.js (standard pattern)

  try { await loadRfqPageData(); } catch(e) { console.error('[RFQ] data load failed:', e); }

  // RFQ module gate — sub-pages don't run the login hydration, so apply saved
  // module overrides now and bounce back to the dashboard if RFQ is turned off.
  if (typeof initModuleEnablement === 'function') initModuleEnablement();
  if (window.CLFN_MODULES && !window.CLFN_MODULES.isEnabled('rfq')) {
    if (typeof showModuleDisabledNotice === 'function') showModuleDisabledNotice('RFQ / Tendering');
    else window.location.href = 'housing.html';
    return;
  }

  if (typeof _applyTheme          === 'function') _applyTheme((window._appSettings||{}).theme || {});
  if (typeof applyNationOverrides  === 'function') applyNationOverrides();
  // Mark RFQ as the active nav item (housing-init.js renders the nav)
  if (typeof setHeaderNavActive === 'function') setHeaderNavActive('rfq');

  var params = new URLSearchParams(window.location.search);
  var rfqId  = params.get('rfq');
  var unitId = params.get('unit');
  var sowPn  = params.get('sow');

  if (rfqId) {
    showRfqForm(rfqId, null, null);
  } else if (unitId && sowPn) {
    // New RFQ from SOW — show form immediately then fetch SOW data from Supabase
    showRfqForm(null, unitId, sowPn);
    _fetchAndPopulateSow(unitId, sowPn);
  } else {
    renderRfqList();
  }
}());

// Back-navigation refresh. The "Maintenance Request" button leaves this page for
// renos.html; when the user edits the MR's dates there and returns, mobile
// browsers often restore this page from bfcache WITHOUT reloading, so _sowCache
// still holds the old dates. On a bfcache restore, re-fetch the SOW cache and
// re-run _loadRfqSowContext (which re-syncs the read-only MR-sourced date fields)
// without a full reload, so it doesn't discard any in-progress RFQ edits.
window.addEventListener('pageshow', function (e) {
  if (!e.persisted) return;
  // Re-hydrate an open RFQ's recipient selection + bids from the cached record.
  // Navigating away (e.g. the Maintenance Request button) and returning via the
  // mobile back-cache could otherwise leave the Recipients tab showing an empty
  // selection even though the count/record still has recipients.
  if (typeof _rfqCurrentId !== 'undefined' && _rfqCurrentId && window._rfqCache && window._rfqCache[_rfqCurrentId]) {
    var _r = window._rfqCache[_rfqCurrentId];
    _rfqSelectedCts = {};
    (_r.recipient_contractor_ids || []).forEach(function (id) { _rfqSelectedCts[id] = true; });
    if (_r.data && _r.data.bids) { try { _rfqBids = JSON.parse(JSON.stringify(_r.data.bids)); } catch (_e) {} }
    if (typeof updateRecipientBadge === 'function') updateRecipientBadge();
    if (typeof renderContractorCards === 'function' && document.getElementById('rfqContractorGrid')) renderContractorCards();
    if (typeof renderBidsSection === 'function') renderBidsSection();
  }
  if (typeof _rfqSowUnitId === 'undefined' || !_rfqSowUnitId) return;
  fetch(SUPABASE_URL + '/rest/v1/housing_sow?select=unit_id,data', { headers: HOUSING_HEADERS })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (sd) {
      if (!sd) return;
      window._sowCache = {};
      sd.forEach(function (row) { window._sowCache[row.unit_id] = row.data; });
      if (typeof _loadRfqSowContext === 'function') _loadRfqSowContext();
    })
    .catch(function () {});
});

async function loadRfqPageData() {
  var results = await Promise.all([
    fetch(SUPABASE_URL + '/rest/v1/housing_units?select=*&order=street,num&limit=9999', { headers: HOUSING_HEADERS }),
    fetch(SUPABASE_URL + '/rest/v1/housing_sow?select=unit_id,data',                   { headers: HOUSING_HEADERS }),
    fetch(SUPABASE_URL + '/rest/v1/housing_settings?select=key,value',                 { headers: HOUSING_HEADERS }),
    fetch(SUPABASE_URL + '/rest/v1/housing_rfq?select=*&order=created_at.desc',        { headers: HOUSING_HEADERS }),
    fetch(SUPABASE_URL + '/rest/v1/housing_contractors?select=*&order=name',           { headers: HOUSING_HEADERS }),
    fetch(SUPABASE_URL + '/rest/v1/housing_projects?select=id,project_number,name&archived=eq.false&order=created_at.desc&limit=200', { headers: HOUSING_HEADERS })
  ]);
  var uR = results[0], sowR = results[1], stR = results[2], rfqR = results[3], ctR = results[4], prjR = results[5];
  // Capital-project link dropdown (Details tab). Hidden unless the projects
  // module is on and at least one project exists.
  if (prjR && prjR.ok) {
    try {
      window._rfqCapProjects = await prjR.json();
      var cpSel = document.getElementById('rfq_capital_project');
      var cpRow = document.getElementById('rfq_capital_project_row');
      var prjModuleOn = (typeof moduleOn !== 'function') || moduleOn('projects');
      if (cpSel && cpRow && prjModuleOn && window._rfqCapProjects.length) {
        cpSel.innerHTML = '<option value="">— None —</option>' + window._rfqCapProjects.map(function(p) {
          var label = ((p.project_number || '') + ' ' + (p.name || '')).trim().replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; });
          return '<option value="' + p.id + '">' + label + '</option>';
        }).join('');
        cpRow.style.display = '';
      }
    } catch(e) { console.warn('[RFQ] projects load:', e); }
  }
  if (uR && uR.ok) {
    window.housingUnits = (await uR.json()).map(function(row) {
      return Object.assign({}, row.data || {}, {
        id: row.id, num: row.num, street: row.street,
        bedrooms: row.bedrooms, status: row.status || 'vacant',
        assignedTo: row.assigned_to, assignedName: row.assigned_name
      });
    });
  }
  if (sowR && sowR.ok) {
    var sd = await sowR.json();
    window._sowCache = {};
    sd.forEach(function(r) { window._sowCache[r.unit_id] = r.data; });
  }
  if (stR && stR.ok) {
    var settings = await stR.json();
    window._appSettings = {};
    settings.forEach(function(r) { window._appSettings[r.key] = r.value; });
    if (typeof _flattenLegacyAppSettings === 'function') _flattenLegacyAppSettings();
  }
  if (rfqR && rfqR.ok) {
    window._rfqCache = {};
    (await rfqR.json()).forEach(function(r) { window._rfqCache[r.id] = r; });
  }
  if (ctR && ctR.ok) {
    // Matches housing-init.js pattern: spread r.data first so email/phone/etc.
    // from the JSONB data column are preserved; override only the top-level cols.
    window._contractors = (await ctR.json()).map(function(r) {
      return Object.assign({}, r.data || {}, {
        id: r.id, name: r.name, trade: r.trade, status: r.status
      });
    });
  }
}

// ── List view ─────────────────────────────────────────────────────────────────
function showRfqList() {
  document.getElementById('rfqListView').style.display = '';
  document.getElementById('rfqFormView').style.display = 'none';
  renderRfqList();
}

// ── List/Cards toggle (local) ───────────────────────────────────────────────
// rfq.html does NOT load housing-views.js, so mirror the shared
// _viewToggleHtml/_cardTile styling here (locally scoped, like the worklist's
// own toggle). Mode persists per device via localStorage; defaults to 'list'
// (the RFQ page has always shown a table).
function _rfqViewMode() {
  try { return localStorage.getItem('clfn_rfq_view') === 'cards' ? 'cards' : 'list'; } catch (e) { return 'list'; }
}
// Status filters — hide finished RFQs by default (declutter); toggles reveal them.
function _rfqShow(key) { try { return localStorage.getItem('clfn_rfq_show_' + key) === '1'; } catch (e) { return false; } }
window._rfqToggleShow = function (key, el) {
  try { localStorage.setItem('clfn_rfq_show_' + key, (el && el.checked) ? '1' : '0'); } catch (e) {}
  renderRfqList();
};
window._rfqSetView = function (v) {
  try { localStorage.setItem('clfn_rfq_view', v === 'cards' ? 'cards' : 'list'); } catch (e) {}
  renderRfqList();
};
function _rfqViewToggleHtml() {
  var cur = _rfqViewMode();
  function b(v, label, icon) {
    var on = cur === v;
    return '<button type="button" onclick="_rfqSetView(\'' + v + '\')" style="display:flex;align-items:center;gap:5px;padding:5px 12px;'
      + 'border:1px solid ' + (on ? 'var(--yellow)' : 'var(--border)') + ';background:' + (on ? 'var(--yellow)' : 'var(--surface)') + ';'
      + 'color:' + (on ? 'var(--dark)' : 'var(--muted)') + ';font-size:11px;font-weight:700;font-family:DM Sans,sans-serif;cursor:pointer;'
      + 'border-radius:' + (v === 'list' ? '7px 0 0 7px' : '0 7px 7px 0') + ';' + (v === 'cards' ? 'margin-left:-1px;' : '') + '">' + icon + ' ' + label + '</button>';
  }
  return '<div style="display:flex;justify-content:flex-end;margin-bottom:10px;"><div style="display:flex;">' + b('list', 'List', '&#9776;') + b('cards', 'Cards', '&#9638;') + '</div></div>';
}
function _rfqCardPill(text, bg, color) {
  if (!text) return '';
  return '<span style="flex-shrink:0;font-size:10px;font-weight:700;color:' + (color || 'var(--muted)') + ';background:' + (bg || 'var(--bg)') + ';border:1px solid var(--border);border-radius:20px;padding:2px 8px;white-space:nowrap;">' + text + '</span>';
}
function _rfqCardTile(o) {
  var metas = (o.metas || []).filter(function (m) { return m && m.v != null && String(m.v) !== ''; }).map(function (m) {
    return '<div style="display:flex;justify-content:space-between;gap:10px;font-size:12px;margin-top:5px;">'
      + '<span style="color:var(--muted);flex-shrink:0;">' + m.k + '</span>'
      + '<span style="color:var(--text);font-weight:600;text-align:right;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + m.v + '</span></div>';
  }).join('');
  var actions = (o.actions || []).map(function (a) {
    return '<button type="button" onclick="' + a.onclick + '" style="flex:1;background:' + (a.ghost ? 'none' : 'var(--yellow)') + ';color:' + (a.ghost ? 'var(--muted)' : 'var(--dark)') + ';'
      + 'border:' + (a.ghost ? '1px solid var(--border)' : 'none') + ';border-radius:7px;padding:8px 10px;font-size:12px;font-weight:700;font-family:DM Sans,sans-serif;cursor:pointer;white-space:nowrap;">' + a.text + '</button>';
  }).join('');
  return '<div style="border:1px solid var(--border);border-radius:10px;background:var(--surface);padding:13px 14px;display:flex;flex-direction:column;">'
    + '<div ' + (o.open ? 'onclick="' + o.open + '"' : '') + ' style="cursor:' + (o.open ? 'pointer' : 'default') + ';">'
    +   '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;">'
    +     '<span style="font-size:14px;font-weight:700;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-decoration:underline;text-decoration-color:var(--border);text-underline-offset:2px;">' + o.title + '</span>'
    +     _rfqCardPill(o.pill && o.pill.text, o.pill && o.pill.bg, o.pill && o.pill.color)
    +   '</div>'
    +   metas
    + '</div>'
    + (actions ? '<div style="display:flex;gap:6px;margin-top:11px;">' + actions + '</div>' : '')
    + '</div>';
}
// One RFQ card — same filtered+sorted row the table uses, laid out as a tile.
function _rfqRenderCard(r) {
  var rfq  = r.rfq;
  var id   = escapeHtml(rfq.id);
  var clos = rfq.closes_at ? new Date(rfq.closes_at).toLocaleDateString('en-CA') : '';
  var iss  = rfq.issued_at ? new Date(rfq.issued_at).toLocaleDateString('en-CA') : '';
  var rcp  = (rfq.recipient_contractor_ids || []).length;
  var amt  = rfq.award_amount ? '$' + Number(rfq.award_amount).toLocaleString('en-CA', { minimumFractionDigits: 2 }) : '';
  var st   = rfq.status || 'draft';
  var actions = [];
  if (st === 'draft')  actions.push({ text: 'Edit',  ghost: true, onclick: "event.stopPropagation();showRfqForm('" + id + "',null,null)" });
  if (st === 'issued') actions.push({ text: 'Award', ghost: true, onclick: "event.stopPropagation();showAwardModal('" + id + "')" });
  // Editors only — mirrors the form footer's #rfqCancelBtn gate. Non-editors
  // used to see this button anyway; clicking it bailed on _rfqCanEdit with a
  // (suppressed) toast, which read as the button being dead.
  if (st !== 'cancelled' && _rfqCanEdit()) actions.push({ text: 'Cancel', ghost: true, onclick: "event.stopPropagation();cancelRfq('" + id + "')" });
  return _rfqCardTile({
    title: id,
    pill:  { text: st },
    open:  "showRfqForm('" + id + "',null,null)",
    metas: [
      { k: 'Unit / SOW',  v: escapeHtml(r.addr) + (rfq.sow_project_number ? ' &middot; ' + escapeHtml(rfq.sow_project_number) : '') },
      { k: 'Issued',      v: iss },
      { k: 'Closes',      v: clos },
      { k: 'Recipients',  v: rcp || '' },
      { k: 'Awarded To',  v: escapeHtml(r.awardCt || '') },
      { k: 'Award $',     v: amt }
    ],
    actions: actions
  });
}

// Mirrors renderWorklist() exactly: builds search + table as innerHTML string
// into #rfqListBody so layout, spacing and column-menu are identical.
function renderRfqList() {
  var body  = document.getElementById('rfqListBody');
  if (!body) return;

  // Build the search bar + table container ONCE. Re-renders (every keystroke,
  // via the debounced oninput) then only replace the table container's
  // contents — the search input is never destroyed, so focus and the caret
  // stay put. Previously the whole body (input included) was re-injected on
  // each keystroke, which stole focus and jumped the cursor out of the field.
  if (!document.getElementById('rfq_search_input')) {
    body.innerHTML =
        '<div class="std-search-row std-search-row-wide">'
      +   '<input id="rfq_search_input" class="std-search" type="text"'
      +   ' placeholder="&#128269; Search RFQ #, unit, status, contractor&hellip;"'
      +   ' oninput="clearTimeout(window._rfqST);window._rfqST=setTimeout(renderRfqList,200)"/>'
      + '</div>'
      + '<div style="display:flex;gap:14px;align-items:center;margin:2px 2px 10px;font-size:12px;color:var(--muted);flex-wrap:wrap;">'
      +   '<span style="font-weight:700;">Show:</span>'
      +   '<label style="display:inline-flex;align-items:center;gap:5px;cursor:pointer;"><input type="checkbox" ' + (_rfqShow('cancelled') ? 'checked ' : '') + 'onchange="_rfqToggleShow(\'cancelled\',this)"/> Cancelled</label>'
      +   '<label style="display:inline-flex;align-items:center;gap:5px;cursor:pointer;"><input type="checkbox" ' + (_rfqShow('completed') ? 'checked ' : '') + 'onchange="_rfqToggleShow(\'completed\',this)"/> Completed</label>'
      + '</div>'
      + '<div id="rfq_list_table_wrap"></div>';
  }

  var cache  = window._rfqCache || {};
  var units  = (typeof housingUnits !== 'undefined' ? housingUnits : []);
  // Read current search value from the (persistent) input.
  var prevSearch = ((document.getElementById('rfq_search_input')||{}).value || '');

  // Enrich rows
  var allRows = Object.values(cache).map(function(rfq) {
    var unit    = units.find(function(u){ return u && u.id === rfq.sow_unit_id; }) || {};
    var addr    = ((unit.num||'') + ' ' + (unit.street||'')).trim() || rfq.sow_unit_id || '';
    var awardCt = rfq.awarded_contractor_id
      ? ((window._contractors||[]).find(function(c){ return c && c.id === rfq.awarded_contractor_id; }) || {}).name || rfq.awarded_contractor_id
      : '';
    return { rfq: rfq, addr: addr, awardCt: awardCt };
  });

  // Status filters: hide cancelled + completed (awarded) unless toggled on.
  var _showCancelled = _rfqShow('cancelled');
  var _showCompleted = _rfqShow('completed');
  allRows = allRows.filter(function (r) {
    var st = r.rfq.status || 'draft';
    if (st === 'cancelled' && !_showCancelled) return false;
    if (st === 'awarded'   && !_showCompleted) return false;
    return true;
  });

  // Search
  var search = prevSearch.toLowerCase().trim();
  if (search) {
    allRows = allRows.filter(function(r) {
      return [r.rfq.id, r.addr, r.rfq.sow_project_number, r.rfq.status, r.awardCt]
        .filter(Boolean).join(' ').toLowerCase().indexOf(search) !== -1;
    });
  }

  // Default sort: newest first
  allRows.sort(function(a,b){ return (b.rfq.created_at||'').localeCompare(a.rfq.created_at||''); });

  // Column definitions — same shape as worklist / contractors
  var _cols = {
    id:      { label: 'RFQ #',      accessor: function(r){ return r.rfq.id || ''; } },
    unit:    { label: 'Unit / SOW', accessor: function(r){ return r.addr; } },
    status:  { label: 'Status',     accessor: function(r){ return r.rfq.status || 'draft'; } },
    issued:  { label: 'Issued',     accessor: function(r){ return r.rfq.issued_at || ''; } },
    closes:  { label: 'Closes',     accessor: function(r){ return r.rfq.closes_at || ''; } },
    awarded: { label: 'Awarded To', accessor: function(r){ return r.awardCt; } },
    amount:  { label: 'Award $',    accessor: function(r){ return Number(r.rfq.award_amount) || 0; } }
  };
  var _acc = {};
  Object.keys(_cols).forEach(function(k){ _acc[k] = _cols[k].accessor; });
  var _state = (typeof tableStateGet === 'function') ? tableStateGet('rfq') : { sort:{key:'',dir:1}, filters:{} };
  if (typeof tableRegisterColumns === 'function') {
    tableRegisterColumns('rfq', { columns: _cols, getRows: function(){ return allRows; }, onChange: renderRfqList });
  }
  var sorted = (typeof tableApplyFilterSort === 'function') ? tableApplyFilterSort(allRows, _acc, _state) : allRows;

  // Build row HTML
  var emptyMsg = search
    ? 'No results for &ldquo;' + escapeHtml(search) + '&rdquo;. Click a column header to adjust filters.'
    : 'No RFQs yet. Click &ldquo;+ New RFQ&rdquo; to get started.';
  var rowsHtml = sorted.length ? sorted.map(function(r) {
    var rfq   = r.rfq;
    var clos  = rfq.closes_at ? new Date(rfq.closes_at).toLocaleDateString('en-CA') : '--';
    var iss   = rfq.issued_at ? new Date(rfq.issued_at).toLocaleDateString('en-CA')  : '--';
    var rcp   = (rfq.recipient_contractor_ids || []).length;
    var amt   = rfq.award_amount ? '$' + Number(rfq.award_amount).toLocaleString('en-CA',{minimumFractionDigits:2}) : '--';
    var stCls = 'rfq-status-' + (rfq.status || 'draft');
    return '<tr style="border-bottom:1px solid var(--border);" class="clickable" onclick="showRfqForm(\'' + escapeHtml(rfq.id) + '\',null,null)">'
      + '<td style="padding:11px 14px;font-weight:600;font-size:13px;white-space:nowrap;">' + escapeHtml(rfq.id) + '</td>'
      + '<td style="padding:11px 14px;font-size:12px;">' + escapeHtml(r.addr) + (rfq.sow_project_number ? '<div class="txt-xs-muted">' + escapeHtml(rfq.sow_project_number) + '</div>' : '') + '</td>'
      + '<td style="padding:11px 14px;"><span class="rfq-status-pill ' + stCls + '">' + escapeHtml(rfq.status||'draft') + '</span></td>'
      + '<td style="padding:11px 14px;font-size:12px;color:var(--muted);">' + iss + '</td>'
      + '<td style="padding:11px 14px;font-size:12px;color:var(--muted);">' + clos + '</td>'
      + '<td style="padding:11px 14px;font-size:12px;text-align:center;">' + rcp + '</td>'
      + '<td style="padding:11px 14px;font-size:12px;">' + escapeHtml(r.awardCt || '--') + '</td>'
      + '<td style="padding:11px 14px;font-size:12px;">' + amt + '</td>'
      + '<td style="padding:11px 14px;text-align:right;white-space:nowrap;" onclick="event.stopPropagation();">'
      +   '<div style="display:inline-flex;gap:4px;align-items:center;">'
      +     (rfq.status === 'draft'  ? '<button class="btn btn-ghost btn-sm" onclick="showRfqForm(\'' + escapeHtml(rfq.id) + '\',null,null)">Edit</button>' : '')
      +     (rfq.status === 'issued' ? '<button class="btn btn-ghost btn-sm" onclick="showAwardModal(\'' + escapeHtml(rfq.id) + '\')">Award</button>' : '')
      +     (rfq.status !== 'cancelled' && _rfqCanEdit() ? '<button class="btn btn-ghost btn-sm" style="color:var(--danger);" onclick="cancelRfq(\'' + escapeHtml(rfq.id) + '\')">Cancel</button>' : '')
      +   '</div>'
      + '</td>'
      + '</tr>';
  }).join('')
  : '<tr><td colspan="9" style="padding:32px;text-align:center;color:var(--muted);font-size:13px;font-style:italic;">' + emptyMsg + '</td></tr>';

  // Re-render ONLY the table container (the search input above it persists).
  var _tableWrap = document.getElementById('rfq_list_table_wrap');
  if (!_tableWrap) return;

  // Cards mode: same filtered+sorted rows, laid out as tiles. No table/thead,
  // so return before the column-menu binding below (which needs the thead).
  if (_rfqViewMode() === 'cards') {
    _tableWrap.innerHTML = _rfqViewToggleHtml()
      + (sorted.length
          ? '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px;">'
              + sorted.map(_rfqRenderCard).join('') + '</div>'
          : '<div style="padding:32px;text-align:center;color:var(--muted);font-size:13px;font-style:italic;">' + emptyMsg + '</div>');
    return;
  }

  _tableWrap.innerHTML = _rfqViewToggleHtml()
    + '<div class="std-table-card">'
    +   '<div class="doclib-table-wrap"><table class="std-table">'
    +     '<thead id="rfq_thead"><tr>'
    +       '<th class="std-th-sortable" data-sort-key="id">RFQ #</th>'
    +       '<th class="std-th-sortable" data-sort-key="unit">Unit / SOW</th>'
    +       '<th class="std-th-sortable" data-sort-key="status">Status</th>'
    +       '<th class="std-th-sortable" data-sort-key="issued">Issued</th>'
    +       '<th class="std-th-sortable" data-sort-key="closes">Closes</th>'
    +       '<th>Recipients</th>'
    +       '<th class="std-th-sortable" data-sort-key="awarded">Awarded To</th>'
    +       '<th class="std-th-sortable" data-sort-key="amount">Award $</th>'
    +       '<th></th>'
    +     '</tr></thead>'
    +     '<tbody id="rfqTableBody">' + rowsHtml + '</tbody>'
    +   '</table></div>'
    + '</div>';

  var thead = document.getElementById('rfq_thead');
  if (typeof tableBindColumnMenuClicks  === 'function' && thead) tableBindColumnMenuClicks(thead, 'rfq');
  if (typeof tableRefreshSortIndicators === 'function' && thead) tableRefreshSortIndicators(thead, 'rfq');
}

// ── Form view ─────────────────────────────────────────────────────────────────
// Fetch the SOW record from Supabase and populate form fields.
// Called after showRfqForm() so the form is already visible.
async function _fetchAndPopulateSow(unitId, sowPn) {
  try {
    // (A sessionStorage '_rfq_sow_handoff' fast-path was removed here — no code
    // ever WROTE that key, so the branch was dead and the network fetch below
    // was always the real path. See AUDIT_2026-07.md storage-key inventory.)
    var r = await fetch(
      SUPABASE_URL + '/rest/v1/housing_sow?unit_id=eq.' + encodeURIComponent(unitId) + '&select=data',
      { headers: HOUSING_HEADERS }
    );
    if (!r.ok) return;
    var rows = await r.json();
    if (!rows || !rows.length) return;

    var data = rows[0].data || {};
    var sowsArr = Array.isArray(data.sows) ? data.sows : (Array.isArray(data) ? data : []);
    var sow = sowsArr.find(function(s){ return s && s.project_number === sowPn; })
           || sowsArr[0]
           || null;
    if (!sow) return;

    // Unit address from cached housingUnits (already loaded)
    var unit = (window.housingUnits || []).find(function(u){ return u && u.id === unitId; }) || {};
    var addr = ((unit.num||'') + ' ' + (unit.street||'')).trim()
            || sow.address || unitId;

    // Estimated budget
    var amount = parseFloat(sow.amount || sow.totalCost || sow.total_cost || 0) || 0;
    var amtStr = amount ? '$' + amount.toLocaleString('en-CA', {minimumFractionDigits:2}) : '--';

    // Populate the read-only display fields
    var sowDisp  = document.getElementById('rfq_sow_display');
    var budgDisp = document.getElementById('rfq_budget_display');
    var subLbl   = document.getElementById('rfqFormSub');
    if (sowDisp)  sowDisp.value  = sowPn + (addr ? '  —  ' + addr : '');
    if (budgDisp) budgDisp.value = amtStr;
    if (subLbl)   subLbl.textContent = addr;

    // Populate target dates from SOW
    var tsEl2 = document.getElementById('rfq_target_start');
    var teEl2 = document.getElementById('rfq_target_end');
    if (tsEl2 && sow.startDate) tsEl2.value = sow.startDate;
    if (teEl2 && sow.endDate)   teEl2.value = sow.endDate;

    // Update module-level state so scope tab and context are correct
    _rfqSowData   = sow;
    _rfqUnitData  = unit;

    // Show building name for commercial/admin/band buildings
    var _bldgTypes = ['admin_building','band_building','commercial_building'];
    var _isBldg    = _bldgTypes.indexOf(unit.type || '') >= 0;
    var _bldgNameEl  = document.getElementById('rfq_building_name_display');
    var _bldgNameRow = document.getElementById('rfq_building_name_row');
    if (_bldgNameEl)  _bldgNameEl.value = (_isBldg && unit.buildingName) ? unit.buildingName : '';
    if (_bldgNameRow) _bldgNameRow.style.display = (_isBldg && unit.buildingName) ? '' : 'none';

    // Pre-populate scope items if not already set
    if (!_rfqScopeItems.length && sow) {
      var items = sow.items || sow.lineItems || [];
      _rfqScopeItems = items.map(function(it){ return Object.assign({}, it, {_hidden:false}); });
    }

    // Prefill the Scope Summary paragraph from the SOW work items AND the SOW's
    // notes (Special Instructions / Access Requirements) for a NEW RFQ (blank
    // until now, so staff re-typed it). Never touch a saved RFQ or a value the
    // user already entered.
    if (!_rfqCurrentId) {
      var sumEl = document.getElementById('rfq_sow_summary');
      if (sumEl && !(sumEl.value || '').trim()) {
        var _lines = (sow.items || sow.lineItems || []).map(function(it){
          return ((it.category ? it.category + ': ' : '') + (it.description || '')).trim();
        }).filter(Boolean);
        var _sowNotes = String(sow.notes || '').trim();
        var _parts = [];
        if (_lines.length)  _parts.push('Requested scope of work at ' + addr + ':\n- ' + _lines.join('\n- '));
        if (_sowNotes)      _parts.push('Notes from the maintenance request:\n' + _sowNotes);
        if (_parts.length)  sumEl.value = _parts.join('\n\n');
      }
    }
  } catch(e) {
    console.warn('[rfq] SOW fetch failed:', e);
  }
}

// Navigate back to the maintenance request (SOW) this RFQ was created from.
// Opens renos.html deep-linked to the specific request (unit + project number).
function rfqBackToSow(){
  if(!_rfqSowUnitId){ if(typeof showToast === 'function') showToast('No linked maintenance request for this RFQ.', {type:'info'}); return; }
  var url = 'renos.html?sow=' + encodeURIComponent(_rfqSowUnitId)
          + (_rfqSowPn ? '&pn=' + encodeURIComponent(_rfqSowPn) : '');
  window.location.href = url;
}
window.rfqBackToSow = rfqBackToSow;

// ── Edit permission ──────────────────────────────────────────────────────────
// Only the Housing Manager and the ED tier (ED / super_user) may edit an RFQ.
// Everyone else sees the full record read-only (all info visible, nothing
// editable).
function _rfqCanEdit() {
  var r = (window.CLFN_PERMS && CLFN_PERMS.normalizeRole)
        ? CLFN_PERMS.normalizeRole(window.currentRole)
        : (window.currentRole || '');
  return r === 'ed' || r === 'super_user' || r === 'housing_manager';
}

// Lock or unlock the whole RFQ form based on _rfqCanEdit(). Disables every
// input/select/textarea and every button except navigation (tabs, Back to
// List, Preview PDF). Restores state cleanly when an editor opens it. Safe to
// call repeatedly (after each dynamic re-render / tab switch).
function _rfqApplyReadOnly() {
  var ro = !_rfqCanEdit();
  window._rfqReadOnly = ro;
  var form = document.getElementById('rfqFormView');
  if (!form) return;
  form.classList.toggle('rfq-readonly', ro);

  form.querySelectorAll('input, select, textarea').forEach(function(c) {
    if (ro) {
      if (!c.hasAttribute('data-ro-was')) c.setAttribute('data-ro-was', c.disabled ? '1' : '0');
      c.disabled = true;
    } else if (c.hasAttribute('data-ro-was')) {
      if (c.getAttribute('data-ro-was') === '0') c.disabled = false;
      c.removeAttribute('data-ro-was');
    }
  });

  form.querySelectorAll('button').forEach(function(b) {
    if (b.closest('.pill-tabs') || b.closest('.tab-bar') || b.hasAttribute('data-rfq-keep')) return;
    if (ro) {
      if (!b.hasAttribute('data-ro-was')) b.setAttribute('data-ro-was', b.disabled ? '1' : '0');
      b.disabled = true;
    } else if (b.hasAttribute('data-ro-was')) {
      if (b.getAttribute('data-ro-was') === '0') b.disabled = false;
      b.removeAttribute('data-ro-was');
    }
  });

  // Banner
  var banner = document.getElementById('rfqReadOnlyBanner');
  if (ro && !banner) {
    banner = document.createElement('div');
    banner.id = 'rfqReadOnlyBanner';
    banner.innerHTML = '🔒 View only — only the Housing Manager or Executive Director can edit this RFQ.';
    form.insertBefore(banner, form.firstChild);
  } else if (!ro && banner) {
    banner.remove();
  }
}

function showRfqForm(rfqId, unitId, sowPn) {
  document.getElementById('rfqListView').style.display  = 'none';
  document.getElementById('rfqFormView').style.display  = '';
  switchRfqTab('details');

  _rfqCurrentId            = rfqId || null;
  _rfqSelectedCts          = {};
  _rfqBids                 = {};
  _rfqScopeItems           = [];
  _rfqScopeDetailRows      = [];
  _rfqMilestoneRows        = [];
  _rfqMaterialsRows        = [];
  _rfqExclusionsRows       = [];
  _rfqClfnSuppliedRows     = [];
  _rfqSubcontractorRows    = [];
  _rfqContractingTabInited = false;
  _rfqDocFiles         = [];
  _rfqAttachedPaths    = [];
  _rfqDocLib           = null;

  if (rfqId) {
    // Editing existing
    var rfq = (window._rfqCache || {})[rfqId];
    if (!rfq) { showToast('RFQ not found', {type:'error'}); showRfqList(); return; }
    _rfqSowUnitId = rfq.sow_unit_id;
    _rfqSowPn     = rfq.sow_project_number;
    (rfq.recipient_contractor_ids || []).forEach(function(id){ _rfqSelectedCts[id] = true; });
    _rfqScopeItems = (rfq.data && rfq.data.scope_snapshot) ? JSON.parse(JSON.stringify(rfq.data.scope_snapshot)) : [];
    _rfqBids = (rfq.data && rfq.data.bids) ? JSON.parse(JSON.stringify(rfq.data.bids)) : {};
    _populateFormFields(rfq);
    document.getElementById('rfqFormHeading').textContent = rfqId;
    document.getElementById('rfqIssueBtn').disabled = rfq.status !== 'draft';
    var _unlockBtn = document.getElementById('rfqUnlockBtn');
    if (_unlockBtn) {
      // Unlock is override authority: check the REAL role (view-as must not
      // remove it), and super_user inherits the ED tier.
      var _rr   = window._realRole || window.currentRole || '';
      var _isEd = (_rr === 'ed' || _rr === 'super_user');
      _unlockBtn.style.display = (_isEd && rfq.status === 'issued') ? '' : 'none';
    }
    // Cancel is available on any non-cancelled saved RFQ (incl. awarded — a
    // contracted job that falls through) for editors; awarded cancels prompt to
    // notify the contractor. See cancelRfq.
    var _cancelBtn = document.getElementById('rfqCancelBtn');
    if (_cancelBtn) _cancelBtn.style.display = (rfq.status !== 'cancelled' && (typeof _rfqCanEdit !== 'function' || _rfqCanEdit())) ? '' : 'none';
  } else {
    // New RFQ
    _rfqSowUnitId = unitId || null;
    _rfqSowPn     = sowPn  || null;
    // Blank EVERY form field first by populating from an empty record. The
    // old branch reset only ~10 fields, so a new RFQ opened after viewing
    // another one silently inherited its scope summary, price breakdown,
    // award fields, signatory/site-lead details — and saved them onto the
    // new draft (which also suppressed the SOW scope prefill, since it only
    // fills an empty summary). The defaults below then overwrite as before.
    _populateFormFields({ status: 'draft', data: {} });
    _rfqContractEmailed = false;
    var newId = (typeof generateRfqNumber === 'function') ? generateRfqNumber() : ('RFQ-' + new Date().getFullYear() + '-0001');
    document.getElementById('rfq_number').value = newId;
    document.getElementById('rfq_status_display').value = 'draft';
    // Default issue date = today
    document.getElementById('rfq_issue_date').value = new Date().toISOString().slice(0,10);
    // Default closing: 14 days from now
    var closing = new Date(Date.now() + 14*24*60*60*1000);
    document.getElementById('rfq_closes_at').value = closing.toISOString().slice(0,16);
    // Default contact = current user
    var session = window.HOUSING_SESSION || {};
    document.getElementById('rfq_contact').value = session.name || '';
    document.getElementById('rfq_contact_email').value = session.email || '';
    var cpNewEl = document.getElementById('rfq_capital_project');
    if (cpNewEl) cpNewEl.value = '';
    document.getElementById('rfqFormHeading').textContent = 'New Request for Quotes';
    document.getElementById('rfqIssueBtn').disabled = false;
    var _unlockBtnNew = document.getElementById('rfqUnlockBtn');
    if (_unlockBtnNew) _unlockBtnNew.style.display = 'none';
    var _cancelBtnNew = document.getElementById('rfqCancelBtn');
    if (_cancelBtnNew) _cancelBtnNew.style.display = 'none';
    // Contract defaults
    var cnEl = document.getElementById('rfq_contract_number');
    if (cnEl) cnEl.value = generateContractNumber();
    var cdEl = document.getElementById('rfq_contract_date');
    if (cdEl) cdEl.value = new Date().toISOString().slice(0,10);
    var apEl = document.getElementById('rfq_ap_email');
    if (apEl) apEl.value = (window.NATION_CONFIG && NATION_CONFIG.housing_email) || '';
    renderMilestoneRows();
  }

  // Load SOW data and unit
  _loadRfqSowContext();
  updateRecipientBadge();
  _renderAwardedToDropdown();
  setTimeout(function(){
    if (typeof _initSigPad === 'function') {
      _initSigPad('rfq_sig');
      _initSigPad('rfq_ct_sig');
      _initSigPad('rfq_ct_initial');
    }
    _rfqApplyReadOnly();
  }, 80);
  _rfqApplyReadOnly();
}

function _populateFormFields(rfq) {
  var d = rfq.data || {};
  function set(id, val) { var el = document.getElementById(id); if (el) el.value = val || ''; }

  set('rfq_number',         rfq.id);
  set('rfq_status_display', rfq.status || 'draft');
  set('rfq_closes_at',      rfq.closes_at ? rfq.closes_at.slice(0,16) : '');
  set('rfq_contact',        d.contact_person || '');
  set('rfq_contact_email',  d.contact_email  || '');
  set('rfq_sub_method',     d.submission_method || 'email');
  set('rfq_capital_project', d.capital_project_id || '');
  set('rfq_issue_date',     d.issue_date || new Date().toISOString().slice(0,10));
  set('rfq_target_start',   d.target_start_date || '');
  set('rfq_target_end',     d.target_completion_date || '');

  // Award
  set('rfq_award_amount', rfq.award_amount ? _rfqFmtMoney(rfq.award_amount) : '');
  set('rfq_award_notes',  rfq.award_notes  || '');

  // Contract Details
  set('rfq_contract_number', d.contract_number || generateContractNumber());
  set('rfq_contract_date',         d.contract_date   || '');
  set('rfq_contract_start',        d.contract_start  || d.target_start_date || '');
  set('rfq_substantial_completion',d.substantial_completion_date || '');
  set('rfq_total_completion',      d.total_completion_date || d.target_completion_date || '');
  set('rfq_ap_email',              d.ap_email || (window.NATION_CONFIG && NATION_CONFIG.housing_email) || '');
  set('rfq_site_lead_name',        d.site_lead_name        || '');
  set('rfq_site_lead_phone',       d.site_lead_phone       || '');
  set('rfq_ct_signatory_name',     d.ct_signatory_name     || '');
  set('rfq_ct_signatory_title',    d.ct_signatory_title    || '');
  set('rfq_ct_quote_number',       d.ct_quote_number       || '');

  // Scope detail
  set('rfq_sow_summary',     d.sow_summary     || '');
  // (sow_detail textarea removed — work items now use dynamic scope detail rows)
  // (materials/exclusions/clfn_supplied now use dynamic rows — loaded above)

  // Price breakdown — stored as numbers; display formatted as $###,###.00.
  function setMoney(id, v){ var el=document.getElementById(id); if(el) el.value = (v===''||v==null) ? '' : _rfqFmtMoney(_rfqParseNum(v)); }
  setMoney('rfq_price_materials',      d.price_materials);
  setMoney('rfq_price_labour',         d.price_labour);
  setMoney('rfq_price_equipment',      d.price_equipment);
  setMoney('rfq_price_subcontractors', d.price_subcontractors);
  setMoney('rfq_price_other',          d.price_other);
  set('rfq_price_tax',       d.price_tax       || '');
  set('rfq_labour_hours',    d.labour_hours    || '');

  // Document attachment selection
  _rfqAttachedPaths = d.attached_doc_paths || [];
  _rfqContractEmailed = !!d.contract_emailed;

  // Dynamic row arrays
  _rfqScopeDetailRows  = d.scope_detail_rows   || [];
  _rfqMaterialsRows    = d.materials_rows      || [];
  _rfqExclusionsRows   = d.exclusions_rows     || [];
  _rfqClfnSuppliedRows = d.clfn_supplied_rows  || [];
  _rfqSubcontractorRows = d.subcontractor_rows || [];
  _rfqMilestoneRows    = (d.milestones || []).filter(function(m){ return m && (m.name || m.gross); });
  setMoney('rfq_holdback_release', d.holdback_release);  // recomputed by _rfqRecalcPrices on tab open
  set('rfq_holdback_days', (d.holdback_days != null && d.holdback_days !== '') ? d.holdback_days : '60');  // default 60-day lien period

  // Signatures
  set('rfq_sig_name',  d.sig_name  || '');
  set('rfq_sig_title', d.sig_title || '');
  set('rfq_ct_sig_date',    d.ct_sig_date    || '');

  _rfqRecalcPrices();

  // Awarded-to dropdown populated after recipients are loaded
  setTimeout(function(){
    _renderAwardedToDropdown();
    var awdEl = document.getElementById('rfq_awarded_to');
    if (awdEl && rfq.awarded_contractor_id) awdEl.value = rfq.awarded_contractor_id;
  }, 150);
}

function _renderAwardedToDropdown() {
  var sel = document.getElementById('rfq_awarded_to');
  if (!sel) return;
  var prev = sel.value;
  sel.innerHTML = '<option value="">-- Select contractor --</option>';
  Object.keys(_rfqSelectedCts).forEach(function(id) {
    var ct = (window._contractors || []).find(function(c){ return c && c.id === id; });
    if (!ct) return;
    var opt = document.createElement('option');
    opt.value = id;
    opt.textContent = ct.name + (ct.trade ? ' (' + ct.trade + ')' : '');
    if (id === prev) opt.selected = true;
    sel.appendChild(opt);
  });
}

function _loadRfqSowContext() {
  _rfqSowData = null; _rfqUnitData = null;
  if (!_rfqSowUnitId) return;

  // Find unit from cache (may enrich the address)
  _rfqUnitData = (window.housingUnits || []).find(function(u){ return u && u.id === _rfqSowUnitId; }) || null;
  var addr = ''
    || (_rfqUnitData ? ((_rfqUnitData.num||'') + ' ' + (_rfqUnitData.street||'')).trim() : '')
    || _rfqSowUnitId;

  // Find SOW in cache for scope items (secondary, best-effort)
  var sowEntry = (window._sowCache || {})[_rfqSowUnitId];
  if (sowEntry) {
    var sowsArr = Array.isArray(sowEntry.sows) ? sowEntry.sows
                : Array.isArray(sowEntry) ? sowEntry : null;
    if (sowsArr && _rfqSowPn) {
      _rfqSowData = sowsArr.find(function(s){ return s && s.project_number === _rfqSowPn; }) || null;
    }
    if (!_rfqSowData && sowsArr && sowsArr.length) _rfqSowData = sowsArr[0] || null;
    if (!_rfqSowData && sowEntry && sowEntry.items) _rfqSowData = sowEntry;
  }

  // Amount: nav context is authoritative (direct from SOW modal DOM), cache is fallback
  var raw = 0 || (_rfqSowData
    ? parseFloat(_rfqSowData.amount || _rfqSowData.totalCost || _rfqSowData.total_cost || 0)
    : 0);
  var amt = raw ? '$' + raw.toLocaleString('en-CA', {minimumFractionDigits:2}) : '--';

  // Populate display fields
  var sowDisp  = document.getElementById('rfq_sow_display');
  var budgDisp = document.getElementById('rfq_budget_display');
  var subLbl   = document.getElementById('rfqFormSub');
  if (sowDisp)  sowDisp.value  = (_rfqSowPn||'') + (addr ? '  —  ' + addr : '');
  if (budgDisp) budgDisp.value = amt;
  if (subLbl)   subLbl.textContent = addr || '';

  // Target Start/Completion are read-only "(from Maintenance Request)" fields, so
  // keep them synced to the LIVE MR here (the _sowCache is loaded fresh at boot),
  // not the RFQ's saved snapshot. Without this, editing the MR's dates after the
  // RFQ was first saved never showed on reopen. Only overwrite when the MR has a
  // value, so a missing cache entry can't wipe the snapshot from _populateFormFields.
  if (_rfqSowData) {
    var tsEl = document.getElementById('rfq_target_start');
    var teEl = document.getElementById('rfq_target_end');
    if (tsEl && _rfqSowData.startDate) tsEl.value = _rfqSowData.startDate;
    if (teEl && _rfqSowData.endDate)   teEl.value = _rfqSowData.endDate;
  }

  // Pre-populate scope items from SOW cache
  if (!_rfqScopeItems.length && _rfqSowData) {
    var rawItems = _rfqSowData.items || _rfqSowData.lineItems || [];
    _rfqScopeItems = rawItems.map(function(it){ return Object.assign({}, it, {_hidden:false}); });
  }

  // Pre-populate scope detail rows from scope items if not yet set
  if (!_rfqScopeDetailRows.length && _rfqScopeItems.length) {
    _rfqScopeDetailRows = _rfqScopeItems
      .filter(function(it){ return !it._hidden && (it.category || it.description); })
      .map(function(it){
        return {
          category:    it.category    || '',
          description: it.description || '',
          notes:       it.amount ? ('$' + Number(it.amount).toLocaleString('en-CA', {minimumFractionDigits:2})) : (it.notes || '')
        };
      });
  }
  renderScopeDetailRows();
  renderMaterialsRows();
  renderExclusionsRows();
  renderClfnSuppliedRows();
  renderSubcontractorRows();
  renderMilestoneRows();
}

// ── Tab switching ─────────────────────────────────────────────────────────────
var _rfqContractingTabInited = false;

function switchRfqTab(tab) {
  _rfqActiveTab = tab;
  ['details','scope','recipients','documents','contracting'].forEach(function(t) {
    var btn = document.getElementById('rfqTabBtn_' + t);
    var panel = document.getElementById('rfqPanel_' + t);
    if (btn)   btn.classList.toggle('active', t === tab);
    if (panel) panel.style.display = (t === tab) ? '' : 'none';
  });
  if (tab === 'scope')      renderScopeTab();
  if (tab === 'recipients') { renderContractorCards(); renderBidsSection(); }
  if (tab === 'documents')  renderDocumentsTab();
  if (tab === 'contracting') {
    // Render dynamic row tables now that the container elements are visible
    renderScopeDetailRows();
    renderMaterialsRows();
    renderExclusionsRows();
    renderClfnSuppliedRows();
    renderSubcontractorRows();
    _rfqSeedDefaultMilestonesIfEmpty();   // tiered default payment schedule when none set yet
    renderMilestoneRows();
    _rfqRecalcPrices();   // compute subtotal/total/holdback + refresh milestones from the loaded prices
    _rfqRenderAwardedContractorInfo();   // show the awarded contractor's on-file details
    _rfqUpdateHoldbackReleaseDate();     // compute the holdback release date from substantial completion
    // Sig pads were hidden at form-open time — init them on first visit
    if (!_rfqContractingTabInited) {
      _rfqContractingTabInited = true;
      setTimeout(function(){
        if (typeof _initSigPad === 'function') {
          _initSigPad('rfq_sig');
          _initSigPad('rfq_ct_sig');
          _initSigPad('rfq_ct_initial');
        }
      }, 50);
    }
  }
  // Re-apply read-only after any tab render re-creates fields/buttons.
  _rfqApplyReadOnly();
}

// ── Scope tab ─────────────────────────────────────────────────────────────────
function renderScopeTab() {
  var el = document.getElementById('rfqScopeContent');
  if (!el) return;
  var items = _rfqScopeItems.filter(function(it){ return it && (it.category || it.description); });
  if (!items.length) {
    el.innerHTML = '<div class="rfq-progress-msg">No line items found in the linked SOW. Save the SOW with at least one item first.</div>';
    return;
  }
  var rows = items.map(function(it, i) {
    return '<tr>'
      + '<td style="padding:6px 8px;"><input type="checkbox" ' + (it._hidden ? '' : 'checked') + ' onchange="_rfqScopeItems[' + i + ']._hidden = !this.checked" style="accent-color:var(--yellow);width:15px;height:15px;"/></td>'
      + '<td style="padding:6px 10px;font-size:12px;">' + escapeHtml(it.category||'--') + '</td>'
      + '<td style="padding:6px 10px;font-size:12px;">' + escapeHtml(it.description||'--') + '</td>'
      + '</tr>';
  });
  el.innerHTML = '<div style="font-size:11px;color:var(--muted);margin-bottom:10px;">Uncheck items to exclude them from the contractor-facing RFQ document. The underlying SOW is not modified.</div>'
    + '<table class="rfq-scope-table"><thead><tr><th style="width:40px;">Show</th><th style="width:28%">Category</th><th>Description</th></tr></thead>'
    + '<tbody>' + rows.join('') + '</tbody></table>';
}

// ── Recipients tab ────────────────────────────────────────────────────────────
function renderContractorCards() {
  var grid = document.getElementById('rfqContractorGrid');
  if (!grid) return;
  var _lockBanner = _rfqBiddingClosed()
    ? '<div class="rfq-progress-msg" style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:8px 12px;margin-bottom:8px;font-size:12px;color:var(--muted);">&#128274; Bidding has closed - recipients are locked.</div>'
    : '';
  var activeOnly   = document.getElementById('rfq_filter_active') && document.getElementById('rfq_filter_active').checked;
  var tradeMatch   = document.getElementById('rfq_filter_trade')  && document.getElementById('rfq_filter_trade').checked;
  var searchEl     = document.getElementById('rfq_ct_search');
  var search       = searchEl ? searchEl.value.toLowerCase().trim() : '';

  var sowCategories = {};
  _rfqScopeItems.filter(function(it){ return !it._hidden && it.category; }).forEach(function(it){ sowCategories[it.category.toLowerCase()] = true; });

  var cts = (window._contractors || []).filter(function(ct) {
    if (!ct || !ct.name) return false;
    // Only exclude contractors with an explicit non-active status;
    // contractors with no status set are treated as active.
    if (activeOnly && ct.status && ct.status !== 'active') return false;
    // Trade match: only filter when SOW has scope items AND contractor has a trade value.
    if (tradeMatch && Object.keys(sowCategories).length && ct.trade) {
      var trade = ct.trade.toLowerCase();
      var hit = Object.keys(sowCategories).some(function(cat) {
        return trade.indexOf(cat) !== -1 || cat.indexOf(trade) !== -1;
      });
      if (!hit) return false;
    }
    if (search) {
      var hay = ((ct.name||'') + ' ' + (ct.trade||'')).toLowerCase();
      if (hay.indexOf(search) === -1) return false;
    }
    return true;
  });

  if (!cts.length) {
    grid.innerHTML = _lockBanner + '<div class="rfq-progress-msg">No matching contractors.</div>';
    return;
  }

  grid.innerHTML = _lockBanner + cts.map(function(ct) {
    var sel = !!_rfqSelectedCts[ct.id];
    // Records store camelCase wsibExpiry — the snake_case field never existed,
    // so every card read "WSIB unknown". Compare as date STRINGS (YYYY-MM-DD)
    // like _rfqContractorEligibility does.
    var _wsibToday = new Date().toISOString().slice(0,10);
    var wsib = ct.wsibExpiry ? (ct.wsibExpiry >= _wsibToday ? 'WSIB valid' : 'WSIB EXPIRED') : 'WSIB unknown';
    var wsibClass = ct.wsibExpiry ? (ct.wsibExpiry >= _wsibToday ? 'rfq-ct-badge-ok' : 'rfq-ct-badge-warn') : 'rfq-ct-badge-warn';
    return '<div class="rfq-ct-card' + (sel ? ' is-selected' : '') + '" onclick="toggleContractor(\'' + escapeHtml(ct.id) + '\')">'
      + '<div class="rfq-ct-name">' + escapeHtml(ct.name) + '</div>'
      + '<div class="rfq-ct-trade">' + escapeHtml(ct.trade||'--') + '</div>'
      + '<div class="rfq-ct-email">' + escapeHtml(ct.email||'No email on file') + '</div>'
      + '<span class="rfq-ct-badge ' + wsibClass + '">' + wsib + '</span>'
      + '</div>';
  }).join('');
  // Re-render leaves fresh inputs ENABLED — re-lock for view-only users
  // (intra-tab renders don't pass through switchRfqTab's re-apply).
  if (window._rfqReadOnly && typeof _rfqApplyReadOnly === 'function') _rfqApplyReadOnly();
}

// Recipients are locked once the bid CLOSE DATE has passed, so bidders can't be
// added/removed after bidding closes. Drafts stay editable — the ED "Unlock RFQ"
// path sends an issued RFQ back to draft, which re-opens recipient editing.
function _rfqBiddingClosed() {
  var rfq = (typeof _rfqCurrentId !== 'undefined' && _rfqCurrentId) ? (window._rfqCache || {})[_rfqCurrentId] : null;
  var status = (rfq && rfq.status) || ((document.getElementById('rfq_status_display') || {}).value) || 'draft';
  if (status === 'draft') return false;
  var closesVal = (rfq && rfq.closes_at) || ((document.getElementById('rfq_closes_at') || {}).value) || '';
  if (!closesVal) return false;
  var closes = new Date(closesVal);
  if (isNaN(closes.getTime())) return false;
  return Date.now() > closes.getTime();
}

function toggleContractor(ctId) {
  if (_rfqBiddingClosed()) {
    if (typeof showToast === 'function') showToast('Bidding has closed for this RFQ - recipients are locked. An ED can Unlock the RFQ to change them.', {type:'info'});
    return;
  }
  if (_rfqSelectedCts[ctId]) delete _rfqSelectedCts[ctId];
  else _rfqSelectedCts[ctId] = true;
  _renderAwardedToDropdown();
  renderContractorCards();
  renderBidsSection();
  updateRecipientBadge();
}

// ── Bids Received (staff-entered tendering) ────────────────────────────────
function renderBidsSection() {
  var mount = document.getElementById('rfqBidsMount');
  if (!mount) return;
  var ids = Object.keys(_rfqSelectedCts);
  if (!ids.length) {
    mount.innerHTML = '<div class="rfq-progress-msg">Select contractors above to record their bids.</div>';
    return;
  }
  var rows = ids.map(function(id){
    var ct  = (window._contractors || []).find(function(c){ return c && c.id === id; }) || { id:id, name:id };
    var bid = _rfqBids[id] || {};
    return { id:id, ct:ct, amount:(bid.amount != null ? bid.amount : ''), notes:bid.notes||'', received:bid.received_at||'', docPath:bid.doc_path||'', docName:bid.doc_name||'' };
  });
  var lowest = null;
  rows.forEach(function(r){ var a = parseFloat(r.amount); if (!isNaN(a) && a > 0 && (lowest === null || a < lowest)) lowest = a; });
  rows.sort(function(a,b){
    var av = parseFloat(a.amount), bv = parseFloat(b.amount);
    var ah = !isNaN(av) && av > 0, bh = !isNaN(bv) && bv > 0;
    if (ah && bh) return av - bv;
    if (ah) return -1; if (bh) return 1;
    return (a.ct.name||'').localeCompare(b.ct.name||'');
  });
  var html = '<table class="rfq-scope-table"><thead><tr>'
    + '<th>Contractor</th><th style="width:135px;">Bid Amount ($)</th><th>Notes</th><th style="width:130px;">Received</th><th style="width:170px;">Quote File</th><th style="width:96px;"></th>'
    + '</tr></thead><tbody>';
  rows.forEach(function(r){
    var av = parseFloat(r.amount); var isLow = !isNaN(av) && av > 0 && lowest !== null && av === lowest;
    var idEsc = escapeHtml(r.id);
    var amtDisp = (r.amount === '' || r.amount == null || isNaN(av)) ? '' : _rfqFmtMoney(av);
    var fileCell = r.docPath
      ? '<a href="#" onclick="_rfqViewBidFile(\'' + idEsc + '\');return false;" title="View attached quote" style="font-size:12px;color:var(--info-blue,#1d4ed8);text-decoration:none;">&#128206; ' + escapeHtml(r.docName || 'Quote') + '</a>'
        + ' <button type="button" onclick="_rfqRemoveBidFile(\'' + idEsc + '\')" title="Remove file" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:12px;padding:0 2px;">&times;</button>'
      : '<label ondragover="event.preventDefault();this.style.borderColor=\'var(--yellow)\';" ondragleave="this.style.borderColor=\'var(--border)\';" ondrop="_rfqDropBidFile(event,\'' + idEsc + '\')" title="Drop a file here or click to choose" style="display:inline-flex;align-items:center;gap:5px;padding:5px 9px;border:1px dashed var(--border);border-radius:6px;font-size:11px;color:var(--muted);cursor:pointer;max-width:158px;">'
        + '<input type="file" onchange="_rfqAttachBidFile(\'' + idEsc + '\', this)" style="display:none;"/>'
        + '<span>&#128206; Drop or choose</span></label>';
    html += '<tr' + (isLow ? ' style="background:var(--success-bg,#f0fdf4);"' : '') + '>'
      + '<td style="padding:6px 10px;font-size:12px;font-weight:600;">' + escapeHtml(r.ct.name||r.id)
      +   (isLow ? ' <span style="font-size:10px;color:var(--success);font-weight:700;">LOWEST</span>' : '') + '</td>'
      + '<td style="padding:4px 8px;"><input type="text" inputmode="decimal" value="' + escapeHtml(amtDisp) + '" onfocus="_rfqCurrencyFocus(this)" oninput="_rfqSetBidAmount(\'' + idEsc + '\',this.value)" onblur="_rfqCurrencyBlur(this)" onchange="renderBidsSection()" class="stg-lookup-input" style="width:118px;" placeholder="$0.00"/></td>'
      + '<td style="padding:4px 8px;"><input type="text" value="' + escapeHtml(r.notes) + '" oninput="_rfqSetBid(\'' + idEsc + '\',\'notes\',this.value)" class="stg-lookup-input" placeholder="Optional"/></td>'
      + '<td style="padding:4px 8px;"><input type="date" value="' + escapeHtml(r.received) + '" oninput="_rfqSetBid(\'' + idEsc + '\',\'received_at\',this.value)" class="stg-lookup-input"/></td>'
      + '<td style="padding:4px 8px;">' + fileCell + '</td>'
      + '<td style="padding:4px 8px;"><button type="button" class="btn btn-primary btn-sm" onclick="_rfqAwardFromBid(\'' + idEsc + '\')"' + ((isNaN(av)||av<=0) ? ' disabled style="opacity:.5;"' : '') + '>Award &rarr;</button></td>'
      + '</tr>';
  });
  html += '</tbody></table>';
  mount.innerHTML = html;
  // Re-render leaves fresh inputs ENABLED — re-lock for view-only users
  // (intra-tab renders don't pass through switchRfqTab's re-apply).
  if (window._rfqReadOnly && typeof _rfqApplyReadOnly === 'function') _rfqApplyReadOnly();
}

function _rfqSetBid(id, field, val) {
  if (!_rfqBids[id]) _rfqBids[id] = {};
  _rfqBids[id][field] = val;
}

// Store the bid amount as a clean number (empty stays empty) so sort/award/PDF
// logic keeps working; the cell displays it formatted as $###,###.00.
function _rfqSetBidAmount(id, raw) {
  var clean = String(raw || '').replace(/[$,\s]/g, '');
  _rfqSetBid(id, 'amount', clean === '' ? '' : (parseFloat(clean) || 0));
  // If this contractor is already the awarded one, flow the edited bid straight
  // through to the Scope Award card's Award Amount.
  var awardedSel = document.getElementById('rfq_awarded_to');
  if (awardedSel && awardedSel.value === id && typeof _rfqSyncAwardAmountFromBid === 'function') {
    _rfqSyncAwardAmountFromBid();
  }
}

// Drag-and-drop onto a bid row's file dropzone.
function _rfqDropBidFile(e, id) {
  e.preventDefault();
  if (e.currentTarget) e.currentTarget.style.borderColor = 'var(--border)';
  var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (!file) return;
  _rfqAttachBidFile(id, { files: [file], value: '' });   // reuse the upload path
}

// ── Bid quote-file attach (stored on rfq.data.bids[id].doc_path) ────────────
async function _rfqAttachBidFile(id, inputEl) {
  // Hard guard: the dropzone is a <label ondrop> — disabling its child file
  // input does not neutralize the drop handler, so a view-only user could
  // still trigger an (orphan) Storage upload via drag-and-drop.
  if (typeof _rfqCanEdit === 'function' && !_rfqCanEdit()) { showToast('View only — only the Housing Manager or ED can edit this RFQ', {type:'error'}); return; }
  var file = inputEl && inputEl.files && inputEl.files[0];
  if (!file) return;
  if (typeof window.sbUploadFile !== 'function') { showToast('File upload is not available on this page', {type:'error'}); return; }
  var rfqId = _rfqCurrentId || (document.getElementById('rfq_number') || {}).value || 'draft';
  var safe  = String(file.name).replace(/[^\w.\-]+/g, '_');
  var path  = 'rfq/' + rfqId + '/bids/' + id + '_' + safe;
  showToast('Uploading ' + file.name + '…', {type:'info'});
  try {
    await window.sbUploadFile(path, file);
    if (!_rfqBids[id]) _rfqBids[id] = {};
    _rfqBids[id].doc_path = path;
    _rfqBids[id].doc_name = file.name;
    renderBidsSection();
    // Persist the reference so it survives a reload (only when the RFQ has a
    // linked SOW/unit — otherwise saveRfqDraft would toast "No SOW linked").
    if (_rfqSowUnitId && typeof saveRfqDraft === 'function') {
      try { await saveRfqDraft(); } catch(e) { console.warn('[rfq] post-attach save failed:', e); }
    }
    showToast('✓ Quote attached for ' + (( (window._contractors||[]).find(function(c){return c&&c.id===id;})||{}).name || 'contractor'), {type:'info'});
  } catch(e) {
    console.warn('[rfq] bid file upload failed:', e);
    showToast('Upload failed — see console', { type: 'error' });
  }
  if (inputEl) inputEl.value = '';   // allow re-selecting the same file
}

function _rfqViewBidFile(id) {
  var bid = _rfqBids[id] || {};
  if (!bid.doc_path) return;
  if (typeof window.sbGetSignedUrl !== 'function') { showToast('Cannot open file', {type:'error'}); return; }
  // Open the tab synchronously (before the await) so the browser doesn't block it.
  var w = window.open('', '_blank');
  window.sbGetSignedUrl(bid.doc_path).then(function(url) {
    if (w) w.location = url; else window.location = url;
  }).catch(function(e) {
    console.warn('[rfq] sign bid file failed:', e);
    if (w) w.close();
    showToast('Could not open the file', { type: 'error' });
  });
}

function _rfqRemoveBidFile(id) {
  if (!_rfqBids[id]) return;
  delete _rfqBids[id].doc_path;
  delete _rfqBids[id].doc_name;
  renderBidsSection();
  if (_rfqSowUnitId && typeof saveRfqDraft === 'function') { try { saveRfqDraft(); } catch(e) {} }
}

async function _rfqAwardFromBid(id) {
  var bid = _rfqBids[id] || {};
  var amt = parseFloat(bid.amount) || 0;
  if (!(amt > 0)) { showToast('Enter a bid amount first', {type:'error'}); return; }
  if (!_rfqCurrentId) { showToast('Save and issue the RFQ before awarding', {type:'error'}); return; }
  // Persist the recorded bids first so the award (and the regret emails to the
  // other bidders) see them in the cached RFQ record.
  if (typeof saveRfqDraft === 'function') { try { await saveRfqDraft(); } catch(e){ console.warn('[rfq] pre-award save failed:', e); } }
  showAwardModal(_rfqCurrentId, { contractorId:id, amount:amt, notes:bid.notes || '' });
}

function selectAllMatchingContractors() {
  if (_rfqBiddingClosed()) {
    if (typeof showToast === 'function') showToast('Bidding has closed for this RFQ - recipients are locked.', {type:'info'});
    return;
  }
  var activeOnly = document.getElementById('rfq_filter_active') && document.getElementById('rfq_filter_active').checked;
  var sowCategories = {};
  _rfqScopeItems.filter(function(it){ return !it._hidden && it.category; }).forEach(function(it){ sowCategories[it.category.toLowerCase()] = true; });
  (window._contractors || []).forEach(function(ct) {
    if (!ct || !ct.name) return;
    if (activeOnly && ct.status && ct.status !== 'active') return;   // same predicate as the card grid — no-status contractors count as active
    if (Object.keys(sowCategories).length) {
      var trade = (ct.trade || '').toLowerCase();
      if (!Object.keys(sowCategories).some(function(cat){ return trade.indexOf(cat) !== -1 || cat.indexOf(trade) !== -1; })) return;
    }
    _rfqSelectedCts[ct.id] = true;
  });
  renderContractorCards();
  updateRecipientBadge();
}

function updateRecipientBadge() {
  var n   = Object.keys(_rfqSelectedCts).length;
  var el  = document.getElementById('rfqRecipientBadge');
  var btn = document.getElementById('rfqTabBtn_recipients');
  if (el) { el.textContent = n; el.style.display = n ? '' : 'none'; }
}

// ── Build RFQ payload from form ───────────────────────────────────────────────
function _buildRfqPayload() {
  var id   = document.getElementById('rfq_number').value.trim();
  var snap = _rfqScopeItems.filter(function(it){ return !it._hidden && (it.category || it.description); });
  function fv(elId) { var el = document.getElementById(elId); return el ? el.value.trim() : ''; }
  function fn(elId) { return parseFloat(fv(elId)) || null; }

  var milestones       = _readMilestoneRows();
  var scopeDetailRows  = _readScopeDetailRows();
  var materialsRows    = _readMaterialsRows();
  var exclusionsRows   = _readExclusionsRows();
  var clfnSuppliedRows = _readClfnSuppliedRows();
  var subcontractorRows = _readSubcontractorRows();

  return {
    id:                      id,
    sow_unit_id:             _rfqSowUnitId || '',
    sow_project_number:      _rfqSowPn || '',
    status:                  _rfqCurrentId ? ((window._rfqCache||{})[_rfqCurrentId] || {}).status || 'draft' : 'draft',
    closes_at:               fv('rfq_closes_at') || null,
    recipient_contractor_ids: Object.keys(_rfqSelectedCts),
    awarded_contractor_id:   fv('rfq_awarded_to')   || null,
    award_amount:            _rfqParseNum(fv('rfq_award_amount')) || null,
    award_notes:             fv('rfq_award_notes')   || null,
    data: {
      contact_person:         fv('rfq_contact'),
      contact_email:          fv('rfq_contact_email'),
      submission_method:      fv('rfq_sub_method'),
      capital_project_id:     fv('rfq_capital_project') || null,
      issue_date:             fv('rfq_issue_date') || new Date().toISOString().slice(0,10),
      target_start_date:      fv('rfq_target_start'),
      target_completion_date: fv('rfq_target_end'),
      scope_snapshot:         snap,
      bids:                   _rfqBids,

      sig_name:               fv('rfq_sig_name'),
      sig_title:              fv('rfq_sig_title'),
      sig_data:               (typeof getSigDataURL === 'function') ? getSigDataURL('rfq_sig') : '',
      // Contract details
      contract_number:              fv('rfq_contract_number'),
      contract_date:                fv('rfq_contract_date'),
      contract_start:               fv('rfq_contract_start'),
      substantial_completion_date:  fv('rfq_substantial_completion'),
      total_completion_date:        fv('rfq_total_completion'),
      ap_email:                     fv('rfq_ap_email'),
      site_lead_name:               fv('rfq_site_lead_name'),
      site_lead_phone:              fv('rfq_site_lead_phone'),
      ct_signatory_name:            fv('rfq_ct_signatory_name'),
      ct_signatory_title:           fv('rfq_ct_signatory_title'),
      ct_quote_number:              fv('rfq_ct_quote_number'),
      // Scope detail
      attached_doc_paths: _rfqAttachedPaths.slice(),
      contract_emailed:   !!_rfqContractEmailed,
      sow_summary:        fv('rfq_sow_summary'),
      // Snapshot the initiating request's notes so the RFQ document (preview +
      // emailed) can show them without re-resolving the SOW. Preserve an
      // existing snapshot when the live SOW isn't loaded.
      sow_notes:          (_rfqSowData && _rfqSowData.notes)
                            || (((window._rfqCache || {})[_rfqCurrentId] || {}).data || {}).sow_notes
                            || '',
      scope_detail_rows:  scopeDetailRows,
      materials_rows:     materialsRows,
      exclusions_rows:    exclusionsRows,
      clfn_supplied_rows: clfnSuppliedRows,
      subcontractor_rows: subcontractorRows,
      // Price breakdown — stored as clean numbers (formatting is display-only).
      price_materials:      _rfqParseNum(fv('rfq_price_materials')),
      price_labour:         _rfqParseNum(fv('rfq_price_labour')),
      price_equipment:      _rfqParseNum(fv('rfq_price_equipment')),
      price_subcontractors: _rfqParseNum(fv('rfq_price_subcontractors')),
      price_other:          _rfqParseNum(fv('rfq_price_other')),
      price_tax:       fv('rfq_price_tax'),
      labour_hours:    fv('rfq_labour_hours'),
      // Milestones
      milestones:          milestones,
      holdback_release:    _rfqParseNum(fv('rfq_holdback_release')),
      holdback_days:       fv('rfq_holdback_days'),
      // Contractor signature
      ct_sig_data:    (typeof getSigDataURL === 'function') ? getSigDataURL('rfq_ct_sig')      : '',
      ct_sig_date:    fv('rfq_ct_sig_date'),
      ct_initial_data:(typeof getSigDataURL === 'function') ? getSigDataURL('rfq_ct_initial')  : '',
      witness_date:   fv('rfq_witness_date')
    },
    created_by: (window.HOUSING_SESSION && window.HOUSING_SESSION.email) || '',
    updated_at: new Date().toISOString()
  };
}

// ── Save draft ────────────────────────────────────────────────────────────────
async function saveRfqDraft() {
  if (!_rfqCanEdit()) { showToast('View only — only the Housing Manager or ED can edit this RFQ', {type:'error'}); return; }
  var payload = _buildRfqPayload();
  if (!payload.sow_unit_id) { showToast('No SOW linked to this RFQ', {type:'info'}); return; }
  // Visible feedback: the corner message panel is easy to miss, so the button
  // itself goes busy and a footer indicator confirms the save inline.
  var saveBtn = document.getElementById('rfqSaveDraftBtn');
  var savedInd = document.getElementById('rfq_saved_indicator');
  var btnLabel = saveBtn ? saveBtn.textContent : '';
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
  if (savedInd) savedInd.textContent = '';
  try {
    if (!_rfqCurrentId) {
      // FIRST save of a new RFQ — collision-safe insert. RFQ numbers are
      // generated by scanning the in-memory cache, so two people creating an
      // RFQ at the same time can pick the same RFQ-YYYY-NNNN. The old
      // merge-duplicates upsert would then silently OVERWRITE the other RFQ.
      // Instead do a plain insert (errors on a duplicate id); on a 409 conflict
      // bump the number and retry so nothing is lost.
      var saved = false, lastErr = '', attempts = 0;
      while (!saved && attempts < 6) {
        attempts++;
        var ri = await fetch(SUPABASE_URL + '/rest/v1/housing_rfq', {
          method: 'POST',
          headers: Object.assign({}, HOUSING_HEADERS, {'Prefer':'return=minimal'}),
          body: JSON.stringify(payload)
        });
        if (ri.ok) { saved = true; break; }
        if (ri.status === 409) {
          var m = /^(.*-)(\d+)$/.exec(payload.id);
          if (m) {
            var numStr = String(parseInt(m[2], 10) + 1);
            while (numStr.length < m[2].length) numStr = '0' + numStr;
            payload.id = m[1] + numStr;
            var numEl = document.getElementById('rfq_number'); if (numEl) numEl.value = payload.id;
            continue;   // retry with the next number
          }
        }
        lastErr = await ri.text(); break;
      }
      if (!saved) throw new Error(lastErr || 'Could not claim a unique RFQ number');
    } else {
      // Re-save of an existing RFQ — upsert (update) on the known id.
      var ru = await fetch(SUPABASE_URL + '/rest/v1/housing_rfq', {
        method: 'POST',
        headers: Object.assign({}, HOUSING_HEADERS, {'Prefer':'resolution=merge-duplicates,return=minimal'}),
        body: JSON.stringify(payload)
      });
      if (!ru.ok) throw new Error(await ru.text());
    }
    window._rfqCache[payload.id] = payload;
    _rfqCurrentId = payload.id;
    if (typeof auditEntry === 'function') auditEntry('RFQ:' + payload.id, 'created', 'RFQ draft saved', window.currentRole || 'staff');
    if (savedInd) savedInd.textContent = '✓ Draft saved ' + new Date().toLocaleTimeString();
    if (saveBtn) { saveBtn.textContent = '✓ Saved'; setTimeout(function(){ saveBtn.textContent = btnLabel; }, 1600); }
    showToast('Draft saved — ' + payload.id, {type:'info'});
  } catch(e) {
    console.error('[rfq] save failed:', e);
    if (savedInd) savedInd.textContent = '⚠ Save failed — try again';
    if (saveBtn) saveBtn.textContent = btnLabel;
    showToast('Save failed — check your connection and try again', { type: 'error' });
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

// ── Preview PDF ───────────────────────────────────────────────────────────────
function previewRfqPdf() {
  var payload = _buildRfqPayload();
  if (typeof buildRfqDocumentHtml !== 'function') { showToast('Document builder not available', {type:'error'}); return; }
  var sow = _rfqSowData;
  var unit = _rfqUnitData;
  var html = buildRfqDocumentHtml(payload, sow, unit);
  if (typeof showPrintPanel === 'function') showPrintPanel(html, payload.id);
  else {
    var w = window.open('','_blank');
    if (w) { w.document.write(html); w.document.close(); }
  }
}

// ── Issue RFQ ─────────────────────────────────────────────────────────────────
async function issueRfq() {
  if (!_rfqCanEdit()) { showToast('View only — only the Housing Manager or ED can edit this RFQ', {type:'error'}); return; }
  var payload = _buildRfqPayload();
  // Validate
  if (!payload.sow_unit_id)                         { showToast('No SOW linked', {type:'info'}); return; }
  if (!payload.closes_at)                           { showToast('Bid closing date is required', {type:'error'}); return; }
  if (new Date(payload.closes_at) <= new Date())    { showToast('Closing date must be in the future', {type:'info'}); return; }
  if (!payload.data.scope_snapshot.length)          { showToast('Add at least one scope item', {type:'error'}); return; }
  if (!payload.recipient_contractor_ids.length)     { showToast('Select at least one recipient', {type:'error'}); return; }

  var n = payload.recipient_contractor_ids.length;
  var confirmed = await showConfirm({
    title: 'Issue RFQ ' + payload.id + '?',
    message: 'This will email the RFQ package to ' + n + ' contractor' + (n===1?'':'s') + ' immediately and cannot be unsent.',
    confirmText: 'Issue RFQ',
    danger: false
  });
  if (!confirmed) return;

  showToast('Issuing RFQ to ' + n + ' contractor' + (n===1?'':'s') + '...', {type:'info'});

  try {
    // NEVER-SAVED RFQ: claim the number through saveRfqDraft's collision-safe
    // insert first. RFQ numbers are generated from the in-memory cache, so two
    // users can pick the same RFQ-YYYY-NNNN — the old direct merge-duplicates
    // upsert here silently REPLACED the other user's RFQ and then emailed
    // contractors under its number. saveRfqDraft retries on 409 and bumps the
    // number (updating #rfq_number), so we rebuild the payload after it runs.
    if (!_rfqCurrentId) {
      await saveRfqDraft();
      if (!_rfqCurrentId) { showToast('Could not save the RFQ — not issued', {type:'error'}); return; }
      payload = _buildRfqPayload();   // pick up the (possibly bumped) number
    }
    payload.status    = 'issued';
    payload.issued_at = new Date().toISOString();
    // From here the id is OURS (inserted above or previously saved) — the
    // upsert is a legitimate update of our own row.
    var r = await fetch(SUPABASE_URL + '/rest/v1/housing_rfq', {
      method: 'POST',
      headers: Object.assign({}, HOUSING_HEADERS, {'Prefer':'resolution=merge-duplicates,return=minimal'}),
      body: JSON.stringify(payload)
    });
    if (!r.ok) throw new Error(await r.text());
    window._rfqCache[payload.id] = payload;
    _rfqCurrentId = payload.id;
    if (typeof auditEntry === 'function') auditEntry('RFQ:' + payload.id, 'issued', 'RFQ issued to ' + n + ' contractors', window.currentRole || 'staff');

    // Send emails
    if (typeof sendRfqToRecipients === 'function') {
      var cts = (window._contractors || []).filter(function(ct){ return ct && payload.recipient_contractor_ids.indexOf(ct.id) !== -1; });
      await sendRfqToRecipients(payload, cts);
    }
    document.getElementById('rfqIssueBtn').disabled = true;
  } catch(e) { console.error('[rfq] issue failed:', e); showToast('Issue failed — see console', {type:'error'}); }
}

// ── Unlock RFQ (ED only) ───────────────────────────────────────────────────────
async function unlockRfq() {
  if (!_rfqCanEdit()) { showToast('View only — only the Housing Manager or ED can edit this RFQ', {type:'error'}); return; }
  var rfqId = _rfqCurrentId;
  if (!rfqId) return;
  var confirmed = await showConfirm({
    title: 'Unlock ' + rfqId + '?',
    message: 'This returns the RFQ to draft status so it can be edited. Contractors who already received the issued RFQ should be notified separately.',
    confirmText: 'Unlock',
    danger: false
  });
  if (!confirmed) return;
  try {
    var r = await fetch(SUPABASE_URL + '/rest/v1/housing_rfq?id=eq.' + encodeURIComponent(rfqId), {
      method: 'PATCH',
      headers: Object.assign({}, HOUSING_HEADERS, { 'Content-Type': 'application/json', 'Prefer': 'return=representation' }),
      body: JSON.stringify({ status: 'draft', issued_at: null, updated_at: new Date().toISOString() })
    });
    if (!r.ok) { showToast('Failed to unlock RFQ', {type:'error'}); return; }
    var rows = await r.json();
    if (rows && rows[0] && window._rfqCache) window._rfqCache[rfqId] = rows[0];
    if (typeof auditEntry === 'function') auditEntry('RFQ:' + rfqId, 'unlocked', 'RFQ returned to draft', window.currentRole || 'staff');
    showToast('RFQ unlocked — now in draft', {type:'info'});
    showRfqForm(rfqId, null, null);
  } catch(e) {
    console.warn('[rfq] unlock failed:', e);
    showToast('Failed to unlock RFQ', {type:'error'});
  }
}

// ── Cancel RFQ ────────────────────────────────────────────────────────────────
async function cancelRfq(rfqId) {
  // {type:'error'} is required — type-less toasts are suppressed entirely, so
  // this guard used to bail with NO visible feedback (button looked dead).
  if (!_rfqCanEdit()) { showToast('View only — only the Housing Manager or ED can cancel this RFQ.', {type:'error'}); return; }
  var rfq = (window._rfqCache || {})[rfqId] || {};
  var wasAwarded = rfq.status === 'awarded' && !!rfq.awarded_contractor_id;
  var awardedCt  = wasAwarded ? (window._contractors || []).find(function(c){ return c && c.id === rfq.awarded_contractor_id; }) : null;
  var canNotify  = wasAwarded && awardedCt && awardedCt.email;

  // When cancelling an AWARDED RFQ, offer to email a cancellation notice to the
  // awarded contractor (default on). Plain confirm otherwise.
  var conf;
  if (canNotify) {
    conf = await showConfirm({
      title:       'Cancel ' + rfqId + '?',
      message:     'This RFQ was awarded to <strong>' + escapeHtml(awardedCt.name || 'the contractor') + '</strong>. Cancelling marks it cancelled (it cannot be re-issued).',
      confirmText: 'Cancel RFQ', danger: true,
      checkbox:    { label: 'Email a cancellation notice to ' + (awardedCt.name || 'the awarded contractor'), defaultChecked: true }
    });
  } else {
    conf = await showConfirm({ title: 'Cancel ' + rfqId + '?', message: 'This marks the RFQ as cancelled. It cannot be re-issued.', confirmText: 'Cancel RFQ', danger: true });
  }
  var ok = (typeof conf === 'object' && conf !== null) ? !!conf.ok : !!conf;
  if (!ok) return;
  var doNotify = canNotify && (typeof conf === 'object' && conf !== null ? !!conf.checked : false);

  try {
    var r = await fetch(SUPABASE_URL + '/rest/v1/housing_rfq?id=eq.' + encodeURIComponent(rfqId), {
      method: 'PATCH', headers: Object.assign({}, HOUSING_HEADERS, {'Prefer':'return=minimal'}),
      body: JSON.stringify({ status: 'cancelled', updated_at: new Date().toISOString() })
    });
    if (!r.ok) throw new Error(await r.text());
    if (window._rfqCache && window._rfqCache[rfqId]) window._rfqCache[rfqId].status = 'cancelled';
    if (typeof auditEntry === 'function') auditEntry('RFQ:' + rfqId, 'cancelled', 'RFQ cancelled' + (wasAwarded ? ' (was awarded to ' + ((awardedCt && awardedCt.name) || rfq.awarded_contractor_id) + ')' : '') + (doNotify ? ' — contractor notified' : ''), window.currentRole || 'staff');

    if (doNotify) {
      var units = (typeof housingUnits !== 'undefined' ? housingUnits : []);
      var unit  = (units || []).find(function(u){ return u && u.id === rfq.sow_unit_id; }) || {};
      var addr  = ((unit.num || '') + ' ' + (unit.street || '')).trim() || rfq.sow_unit_id || '';
      // Composes from the editable `rfq_cancelled` template (Settings ->
      // Notifications). Falls back to an inline send if notifications.js isn't
      // loaded on this page (defensive — it normally is).
      if (typeof notifyRfqCancelled === 'function') {
        notifyRfqCancelled(rfq, awardedCt, addr).catch(function(e){ console.warn('[rfq] cancel notify failed:', e); });
      } else if (typeof window.sendNotification === 'function') {
        var natShort = (window.NATION_CONFIG && NATION_CONFIG.short) || 'Housing';
        window.sendNotification({
          to: awardedCt.email, to_name: awardedCt.name || '',
          subject: rfqId + ' — Contract Cancellation Notice',
          bodyHtml: '<p>Dear ' + escapeHtml(awardedCt.name || 'Contractor') + ',</p>'
            + '<p>We are writing to inform you that <strong>' + escapeHtml(rfqId) + '</strong>'
            + (addr ? ' (' + escapeHtml(addr) + ')' : '') + ', previously awarded to you, has been <strong>cancelled</strong>.</p>'
            + '<p>Please do not proceed with any further work under this award. If work was already underway, contact the Housing Department to arrange settlement for work completed to date.</p>'
            + '<p>We apologize for any inconvenience and thank you for your understanding.</p>'
            + '<p>Sincerely,<br/>' + escapeHtml(natShort) + ' Housing</p>',
          event: 'rfq_cancelled', entity_type: 'rfq', entity_id: rfqId
        }).catch(function(e){ console.warn('[rfq] cancel notify failed:', e); });
      }
    }

    showToast(rfqId + ' cancelled' + (doNotify ? ' — contractor notified' : ''), {type:'info'});
    renderRfqList();
  } catch(e) { console.error('[rfq] cancel failed:', e); showToast('Cancel failed: ' + (e && e.message ? e.message : 'unknown error'), {type:'error'}); }
}

// ── Award modal ───────────────────────────────────────────────────────────────
// prefill (optional): { contractorId, amount, notes } — used by "Award from bid".
function showAwardModal(rfqId, prefill) {
  _rfqAwardingId = rfqId;
  var rfq = (window._rfqCache || {})[rfqId];
  if (!rfq) return;
  var cts = (rfq.recipient_contractor_ids || []).map(function(id){
    return (window._contractors || []).find(function(c){ return c && c.id === id; });
  }).filter(Boolean);

  // Merge the live in-memory bid edits over the saved record ONLY when this
  // modal is for the currently open RFQ. _rfqBids is module state hydrated by
  // showRfqForm and not cleared on Back-to-List — awarding another RFQ from a
  // list row used to show the previously opened RFQ's bid amounts in this
  // dropdown's "(bid $…)" suffixes.
  var _bidsForThis = (rfqId === _rfqCurrentId) ? (_rfqBids || {}) : {};
  var bids = Object.assign({}, (rfq.data && rfq.data.bids) || {}, _bidsForThis);
  var opts = cts.map(function(ct){
    var b = bids[ct.id]; var amt = b && parseFloat(b.amount);
    var suffix = (amt && amt > 0) ? '  (bid $' + amt.toLocaleString('en-CA', {minimumFractionDigits:2}) + ')' : '';
    return '<option value="' + escapeHtml(ct.id) + '">' + escapeHtml(ct.name) + suffix + '</option>';
  }).join('');

  document.getElementById('rfqAwardBody').innerHTML =
      '<div class="f" style="margin-bottom:12px;"><label>Winning Contractor</label>'
    + '<select id="award_ct_id" class="stg-lookup-input"><option value="">-- Select --</option>' + opts + '</select></div>'
    + '<div class="f" style="margin-bottom:12px;"><label>Award Amount ($)</label>'
    + '<input type="number" id="award_amount" class="stg-lookup-input" placeholder="0.00" min="0" step="0.01"/></div>'
    + '<div class="f"><label>Notes (optional)</label>'
    + '<textarea id="award_notes" class="stg-lookup-input" rows="2" placeholder="Any notes for the award decision..."></textarea></div>';

  if (prefill) {
    var sel = document.getElementById('award_ct_id'); if (sel && prefill.contractorId) sel.value = prefill.contractorId;
    var amt = document.getElementById('award_amount'); if (amt && prefill.amount != null) amt.value = prefill.amount;
    var nt  = document.getElementById('award_notes');  if (nt && prefill.notes) nt.value = prefill.notes;
  }

  var modal = document.getElementById('rfqAwardModal');
  modal.style.display = 'flex';
}

function closeAwardModal() {
  document.getElementById('rfqAwardModal').style.display = 'none';
  _rfqAwardingId = null;
}

// Returns a list of eligibility problems for awarding to this contractor
// (empty = good to go): not approved, or expired WSIB / insurance.
function _rfqContractorEligibility(ct) {
  if (!ct) return ['not found in the contractor registry'];
  var issues = [];
  if ((ct.status || '') !== 'approved') issues.push('not approved (status: ' + (ct.status || 'unknown').replace(/_/g,' ') + ')');
  var today = new Date().toISOString().slice(0,10);
  if (ct.wsibExpiry && ct.wsibExpiry < today) issues.push('WSIB expired ' + ct.wsibExpiry);
  if (ct.insExpiry  && ct.insExpiry  < today) issues.push('insurance expired ' + ct.insExpiry);
  return issues;
}

async function confirmAward() {
  if (!_rfqCanEdit()) { showToast('View only — only the Housing Manager or ED can edit this RFQ', {type:'error'}); return; }
  var ctId   = document.getElementById('award_ct_id').value;
  var amount = document.getElementById('award_amount').value;
  var notes  = document.getElementById('award_notes').value.trim();
  if (!ctId)   { showToast('Select a contractor', {type:'error'}); return; }
  if (!amount) { showToast('Enter the award amount', {type:'error'}); return; }
  // Capture the RFQ id BEFORE closeAwardModal() clears _rfqAwardingId — otherwise
  // awardRfq() was being handed null.
  var rfqId = _rfqAwardingId;
  var ct    = (window._contractors || []).find(function(c){ return c && c.id === ctId; });

  // Eligibility warning (not a hard block — ED can override): flag awarding to
  // an un-approved contractor or one with expired WSIB / insurance.
  var _elig = _rfqContractorEligibility(ct);
  if (_elig.length && typeof showConfirm === 'function') {
    var _go = await showConfirm({
      title:       'Contractor eligibility',
      message:     escapeHtml((ct && ct.name) || 'This contractor') + ' is ' + escapeHtml(_elig.join('; ')) + '. Award anyway?',
      confirmText: 'Award anyway', cancelText: 'Cancel'
    });
    if (!_go) return;   // leave the award modal open so they can pick another
  }
  closeAwardModal();
  if (typeof awardRfq !== 'function') return;
  var ok = await awardRfq(rfqId, ctId, amount, notes);
  if (!ok) return;

  // Hand off straight into the contract instead of stranding the user on the
  // list and making them re-open + re-key everything.
  var amtLabel = '$' + (parseFloat(amount) || 0).toLocaleString('en-CA', {minimumFractionDigits:2});
  var proceed  = (typeof showConfirm === 'function')
    ? await showConfirm({
        title:       'Awarded',
        message:     escapeHtml((ct && ct.name) || 'Contractor') + ' awarded ' + amtLabel + '. Set up the contract now?',
        confirmText: 'Set up contract →', cancelText: 'Later'
      })
    : false;
  if (proceed) {
    showRfqForm(rfqId);
    switchRfqTab('contracting');
    _rfqSeedContractFromAward(rfqId);
  } else {
    renderRfqList();
  }
}

// Manual award (no notifications) — for tenders run manually/offline where the
// app is used only for contracting. Records the awarded contractor + amount from
// the Scope Award card, marks the linked SOW approved, and jumps to Contracting
// WITHOUT issuing the RFQ or emailing anyone.
async function _rfqManualAward() {
  if (!_rfqCanEdit()) { showToast('View only — only the Housing Manager or ED can edit this RFQ', {type:'error'}); return; }
  var ctId = (document.getElementById('rfq_awarded_to') || {}).value || '';
  var amt  = _rfqParseNum((document.getElementById('rfq_award_amount') || {}).value);
  if (!ctId)       { showToast('Select the awarded contractor above (Awarded To)', {type:'error'}); return; }
  if (!(amt > 0))  { showToast('Enter the award amount', {type:'error'}); return; }
  // The award patches the cached RFQ record, so make sure it exists first.
  if (typeof saveRfqDraft === 'function') { try { await saveRfqDraft(); } catch(e){ console.warn('[rfq] manual-award pre-save failed:', e); } }
  if (!_rfqCurrentId) { showToast('Save the RFQ first', {type:'info'}); return; }
  var ct   = (window._contractors || []).find(function(c){ return c && c.id === ctId; });
  var elig = (typeof _rfqContractorEligibility === 'function') ? _rfqContractorEligibility(ct) : [];
  var msg  = escapeHtml((ct && ct.name) || 'This contractor') + ' will be recorded as the awarded contractor for '
           + _rfqFmtMoney(amt) + '. <strong>No emails will be sent</strong>, and the linked SOW will be marked approved.'
           + (elig.length ? '<br><br>Note: ' + escapeHtml((ct && ct.name) || 'the contractor') + ' is ' + escapeHtml(elig.join('; ')) + '.' : '');
  if (typeof showConfirm === 'function') {
    var go = await showConfirm({ title: 'Record award (no notifications)?', message: msg, confirmText: 'Record award', cancelText: 'Cancel' });
    if (!go) return;
  }
  var notes = (document.getElementById('rfq_award_notes') || {}).value || '';
  var ok = (typeof awardRfq === 'function') ? await awardRfq(_rfqCurrentId, ctId, amt, notes, { skipNotify: true }) : false;
  if (ok) {
    showRfqForm(_rfqCurrentId);
    switchRfqTab('contracting');
    _rfqSeedContractFromAward(_rfqCurrentId);
  }
}

// Prefill the Contracting tab from the award so the contractor + price aren't
// re-entered: select the awarded contractor (fills signatory), and seed the
// contract price from the award amount when the breakdown is still empty (so
// the on-screen Contract Price matches what the PDF prints).
function _rfqSeedContractFromAward(rfqId) {
  var rfq = (window._rfqCache || {})[rfqId];
  if (!rfq) return;
  var awEl = document.getElementById('rfq_awarded_to');
  if (awEl && rfq.awarded_contractor_id) awEl.value = rfq.awarded_contractor_id;
  if (typeof _rfqAutoFillContractor === 'function') _rfqAutoFillContractor();
  // NOTE: we intentionally do NOT seed the price breakdown from the award
  // amount. Dumping the full contract value into the "Other" line was
  // confusing and wrong on the generated contract. Staff enter the real
  // breakdown (materials/labour/etc.); the Contract Price total derives from
  // it, and the awarded amount is shown on the Scope > Award card as reference.
}

// ── Contract number generation ────────────────────────────────────────────
function generateContractNumber() {
  return window.nextContractNumber();
}

// ── Scope detail dynamic rows ─────────────────────────────────────────────
function renderScopeDetailRows() {
  var el = document.getElementById('rfq_scope_detail_rows');
  if (!el) return;
  if (!_rfqScopeDetailRows.length) {
    el.innerHTML = '<div style="font-size:11px;color:var(--muted);padding:10px 0;font-style:italic;">No items — click "+ Add Item" or link this RFQ to a SOW with scope items.</div>';
    return;
  }
  el.innerHTML = '<div style="overflow-x:auto;">'
    + '<table class="std-table" style="width:100%;table-layout:fixed;">'
    + '<thead><tr>'
    + '<th style="width:22%;">Category</th>'
    + '<th style="width:38%;">Description</th>'
    + '<th style="width:32%;">Notes / Specs</th>'
    + '<th style="width:8%;"></th>'
    + '</tr></thead><tbody>'
    + _rfqScopeDetailRows.map(function(row, i) {
        return '<tr>'
          + '<td style="padding:4px 6px;"><input type="text" id="rfq_sdr_cat_' + i + '" value="' + escapeHtml(row.category || '') + '" class="stg-lookup-input" style="padding:4px 6px;font-size:12px;" placeholder="Category"/></td>'
          + '<td style="padding:4px 6px;"><input type="text" id="rfq_sdr_desc_' + i + '" value="' + escapeHtml(row.description || '') + '" class="stg-lookup-input" style="padding:4px 6px;font-size:12px;" placeholder="Description"/></td>'
          + '<td style="padding:4px 6px;"><input type="text" id="rfq_sdr_notes_' + i + '" value="' + escapeHtml(row.notes || '') + '" class="stg-lookup-input" style="padding:4px 6px;font-size:12px;" placeholder="Specs, notes, amount"/></td>'
          + '<td style="padding:4px 6px;text-align:center;"><button type="button" onclick="removeScopeDetailRow(' + i + ')" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:18px;line-height:1;" title="Remove">&times;</button></td>'
          + '</tr>';
      }).join('')
    + '</tbody></table></div>';
  // Re-render leaves fresh inputs ENABLED — re-lock for view-only users
  // (intra-tab renders don't pass through switchRfqTab's re-apply).
  if (window._rfqReadOnly && typeof _rfqApplyReadOnly === 'function') _rfqApplyReadOnly();
}

function addScopeDetailRow(row) {
  _readScopeDetailRows();
  _rfqScopeDetailRows.push(row || { category: '', description: '', notes: '' });
  renderScopeDetailRows();
}

function removeScopeDetailRow(i) {
  _readScopeDetailRows();
  _rfqScopeDetailRows.splice(i, 1);
  renderScopeDetailRows();
}

function _readScopeDetailRows() {
  var rows = [];
  var i = 0;
  while (document.getElementById('rfq_sdr_cat_' + i)) {
    rows.push({
      category:    (document.getElementById('rfq_sdr_cat_'   + i) || {}).value || '',
      description: (document.getElementById('rfq_sdr_desc_'  + i) || {}).value || '',
      notes:       (document.getElementById('rfq_sdr_notes_' + i) || {}).value || ''
    });
    i++;
  }
  _rfqScopeDetailRows = rows;
  return rows;
}

// ── Materials & Specifications dynamic rows ───────────────────────────────
function renderMaterialsRows() {
  var el = document.getElementById('rfq_materials_rows');
  if (!el) return;
  if (!_rfqMaterialsRows.length) {
    el.innerHTML = '<div style="font-size:11px;color:var(--muted);padding:8px 0;font-style:italic;">No items — click "+ Add Material".</div>';
    return;
  }
  el.innerHTML = '<div style="overflow-x:auto;"><table class="std-table" style="width:100%;table-layout:fixed;">'
    + '<thead><tr><th style="width:30%;">Material / Product</th><th style="width:38%;">Specification / Standard</th><th style="width:24%;">Notes</th><th style="width:8%;"></th></tr></thead><tbody>'
    + _rfqMaterialsRows.map(function(r, i) {
        return '<tr>'
          + '<td style="padding:4px 6px;"><input type="text" id="rfq_mat_material_'+i+'" value="'+escapeHtml(r.material||'')+'" class="stg-lookup-input" style="padding:4px 6px;font-size:12px;" placeholder="e.g. IKO Cambridge shingles"/></td>'
          + '<td style="padding:4px 6px;"><input type="text" id="rfq_mat_spec_'+i+'" value="'+escapeHtml(r.specification||'')+'" class="stg-lookup-input" style="padding:4px 6px;font-size:12px;" placeholder="e.g. ASTM D3462, 30-year"/></td>'
          + '<td style="padding:4px 6px;"><input type="text" id="rfq_mat_notes_'+i+'" value="'+escapeHtml(r.notes||'')+'" class="stg-lookup-input" style="padding:4px 6px;font-size:12px;" placeholder="Optional"/></td>'
          + '<td style="padding:4px 6px;text-align:center;"><button type="button" onclick="removeMaterialsRow('+i+')" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:18px;line-height:1;" title="Remove">&times;</button></td>'
          + '</tr>';
      }).join('')
    + '</tbody></table></div>';
  // Re-render leaves fresh inputs ENABLED — re-lock for view-only users
  // (intra-tab renders don't pass through switchRfqTab's re-apply).
  if (window._rfqReadOnly && typeof _rfqApplyReadOnly === 'function') _rfqApplyReadOnly();
}
function addMaterialsRow() { _readMaterialsRows(); _rfqMaterialsRows.push({material:'',specification:'',notes:''}); renderMaterialsRows(); }
function removeMaterialsRow(i) { _readMaterialsRows(); _rfqMaterialsRows.splice(i,1); renderMaterialsRows(); }
function _readMaterialsRows() {
  var rows = []; var i = 0;
  while (document.getElementById('rfq_mat_material_'+i)) {
    rows.push({ material:(document.getElementById('rfq_mat_material_'+i)||{}).value||'', specification:(document.getElementById('rfq_mat_spec_'+i)||{}).value||'', notes:(document.getElementById('rfq_mat_notes_'+i)||{}).value||'' });
    i++;
  }
  _rfqMaterialsRows = rows; return rows;
}

// ── Exclusions & Assumptions dynamic rows ────────────────────────────────
function renderExclusionsRows() {
  var el = document.getElementById('rfq_exclusions_rows');
  if (!el) return;
  if (!_rfqExclusionsRows.length) {
    el.innerHTML = '<div style="font-size:11px;color:var(--muted);padding:8px 0;font-style:italic;">No exclusions — click "+ Add Exclusion".</div>';
    return;
  }
  el.innerHTML = '<div style="overflow-x:auto;"><table class="std-table" style="width:100%;table-layout:fixed;">'
    + '<thead><tr><th>Exclusion / Assumption</th><th style="width:8%;"></th></tr></thead><tbody>'
    + _rfqExclusionsRows.map(function(r, i) {
        return '<tr>'
          + '<td style="padding:4px 6px;"><input type="text" id="rfq_excl_text_'+i+'" value="'+escapeHtml(r.text||'')+'" class="stg-lookup-input" style="padding:4px 6px;font-size:12px;" placeholder="e.g. Disposal of hazardous materials is excluded"/></td>'
          + '<td style="padding:4px 6px;text-align:center;"><button type="button" onclick="removeExclusionRow('+i+')" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:18px;line-height:1;" title="Remove">&times;</button></td>'
          + '</tr>';
      }).join('')
    + '</tbody></table></div>';
  // Re-render leaves fresh inputs ENABLED — re-lock for view-only users
  // (intra-tab renders don't pass through switchRfqTab's re-apply).
  if (window._rfqReadOnly && typeof _rfqApplyReadOnly === 'function') _rfqApplyReadOnly();
}
function addExclusionRow() { _readExclusionsRows(); _rfqExclusionsRows.push({text:''}); renderExclusionsRows(); }
function removeExclusionRow(i) { _readExclusionsRows(); _rfqExclusionsRows.splice(i,1); renderExclusionsRows(); }
function _readExclusionsRows() {
  var rows = []; var i = 0;
  while (document.getElementById('rfq_excl_text_'+i)) {
    rows.push({ text:(document.getElementById('rfq_excl_text_'+i)||{}).value||'' });
    i++;
  }
  _rfqExclusionsRows = rows; return rows;
}

// ── Items Supplied by Nation dynamic rows ─────────────────────────────────
function renderClfnSuppliedRows() {
  var el = document.getElementById('rfq_clfn_supplied_rows');
  if (!el) return;
  if (!_rfqClfnSuppliedRows.length) {
    el.innerHTML = '<div style="font-size:11px;color:var(--muted);padding:8px 0;font-style:italic;">No items — click "+ Add Item" or leave empty if none.</div>';
    return;
  }
  el.innerHTML = '<div style="overflow-x:auto;"><table class="std-table" style="width:100%;table-layout:fixed;">'
    + '<thead><tr><th>Item Supplied by Nation</th><th style="width:8%;"></th></tr></thead><tbody>'
    + _rfqClfnSuppliedRows.map(function(r, i) {
        return '<tr>'
          + '<td style="padding:4px 6px;"><input type="text" id="rfq_clfn_item_'+i+'" value="'+escapeHtml(r.item||'')+'" class="stg-lookup-input" style="padding:4px 6px;font-size:12px;" placeholder="e.g. Paint, hardware, fixtures"/></td>'
          + '<td style="padding:4px 6px;text-align:center;"><button type="button" onclick="removeClfnSuppliedRow('+i+')" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:18px;line-height:1;" title="Remove">&times;</button></td>'
          + '</tr>';
      }).join('')
    + '</tbody></table></div>';
  // Re-render leaves fresh inputs ENABLED — re-lock for view-only users
  // (intra-tab renders don't pass through switchRfqTab's re-apply).
  if (window._rfqReadOnly && typeof _rfqApplyReadOnly === 'function') _rfqApplyReadOnly();
}
function addClfnSuppliedRow() { _readClfnSuppliedRows(); _rfqClfnSuppliedRows.push({item:''}); renderClfnSuppliedRows(); }
function removeClfnSuppliedRow(i) { _readClfnSuppliedRows(); _rfqClfnSuppliedRows.splice(i,1); renderClfnSuppliedRows(); }
function _readClfnSuppliedRows() {
  var rows = []; var i = 0;
  while (document.getElementById('rfq_clfn_item_'+i)) {
    rows.push({ item:(document.getElementById('rfq_clfn_item_'+i)||{}).value||'' });
    i++;
  }
  _rfqClfnSuppliedRows = rows; return rows;
}

// ── Subcontractors dynamic rows ───────────────────────────────────────────
// Sub-trades the awarded contractor will engage, picked from the contractor
// registry. Stored as {contractorId, name, trade, scope}; name/trade are
// snapshotted from the registry at pick time so the contract prints even if the
// registry later changes. Rendered onto the contract with a mandatory
// WSIB + $2M liability clause (see _rfqBuildContractPdf).
function _rfqSubOptions(selectedId) {
  var opts = '<option value="">— Select from contractor registry —</option>';
  (window._contractors || []).slice()
    .sort(function(a,b){ return ((a&&a.name)||'').localeCompare((b&&b.name)||''); })
    .forEach(function(c){
      if (!c || !c.name) return;
      var trade = c.trade ? ' (' + c.trade + ')' : '';
      opts += '<option value="' + escapeHtml(c.id) + '"' + (c.id === selectedId ? ' selected' : '') + '>' + escapeHtml(c.name + trade) + '</option>';
    });
  return opts;
}
function renderSubcontractorRows() {
  var el = document.getElementById('rfq_subcontractor_rows');
  if (!el) return;
  if (!_rfqSubcontractorRows.length) {
    el.innerHTML = '<div style="font-size:11px;color:var(--muted);padding:8px 0;font-style:italic;">No subcontractors — click "+ Add Subcontractor" or leave empty if the contractor is self-performing.</div>';
    return;
  }
  var today = new Date().toISOString().slice(0,10);
  el.innerHTML = '<div style="overflow-x:auto;"><table class="std-table" style="width:100%;table-layout:fixed;">'
    + '<thead><tr><th style="width:34%;">Subcontractor</th><th style="width:44%;">Scope of Work</th><th style="width:14%;">Compliance</th><th style="width:8%;"></th></tr></thead><tbody>'
    + _rfqSubcontractorRows.map(function(r, i) {
        // Live compliance flag from the registry (WSIB / insurance expiry).
        var ct = (window._contractors || []).find(function(c){ return c && c.id === r.contractorId; });
        var flag = '<span style="font-size:10px;color:var(--muted);">—</span>';
        if (ct) {
          var issues = (typeof _rfqContractorEligibility === 'function') ? _rfqContractorEligibility(ct) : [];
          flag = issues.length
            ? '<span title="' + escapeHtml(issues.join('; ')) + '" style="font-size:10px;font-weight:700;color:var(--danger);">&#9888; Check</span>'
            : '<span style="font-size:10px;font-weight:700;color:var(--success);">&#10003; OK</span>';
        }
        return '<tr>'
          + '<td style="padding:4px 6px;"><select id="rfq_sub_ct_'+i+'" onchange="_rfqOnSubContractorChange('+i+')" class="stg-lookup-input" style="padding:4px 6px;font-size:12px;">'+_rfqSubOptions(r.contractorId||'')+'</select></td>'
          + '<td style="padding:4px 6px;"><input type="text" id="rfq_sub_scope_'+i+'" value="'+escapeHtml(r.scope||'')+'" class="stg-lookup-input" style="padding:4px 6px;font-size:12px;" placeholder="e.g. Electrical rough-in and finish"/></td>'
          + '<td style="padding:4px 6px;text-align:center;">'+flag+'</td>'
          + '<td style="padding:4px 6px;text-align:center;"><button type="button" onclick="removeSubcontractorRow('+i+')" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:18px;line-height:1;" title="Remove">&times;</button></td>'
          + '</tr>';
      }).join('')
    + '</tbody></table></div>';
  if (window._rfqReadOnly && typeof _rfqApplyReadOnly === 'function') _rfqApplyReadOnly();
}
function addSubcontractorRow() { _readSubcontractorRows(); _rfqSubcontractorRows.push({contractorId:'',name:'',trade:'',scope:''}); renderSubcontractorRows(); }
function removeSubcontractorRow(i) { _readSubcontractorRows(); _rfqSubcontractorRows.splice(i,1); renderSubcontractorRows(); }
// Selecting a contractor snapshots their name + trade onto the row.
function _rfqOnSubContractorChange(i) {
  _readSubcontractorRows();
  var row = _rfqSubcontractorRows[i]; if (!row) return;
  var ct = (window._contractors || []).find(function(c){ return c && c.id === row.contractorId; });
  row.name  = ct ? (ct.name || '')  : '';
  row.trade = ct ? (ct.trade || '') : '';
  renderSubcontractorRows();
}
function _readSubcontractorRows() {
  var rows = []; var i = 0;
  while (document.getElementById('rfq_sub_ct_'+i)) {
    var ctId = (document.getElementById('rfq_sub_ct_'+i)||{}).value||'';
    var prev = _rfqSubcontractorRows[i] || {};
    var ct = (window._contractors || []).find(function(c){ return c && c.id === ctId; });
    rows.push({
      contractorId: ctId,
      name:  ct ? (ct.name || '')  : (prev.name  || ''),
      trade: ct ? (ct.trade || '') : (prev.trade || ''),
      scope: (document.getElementById('rfq_sub_scope_'+i)||{}).value||''
    });
    i++;
  }
  _rfqSubcontractorRows = rows; return rows;
}

// ── Milestone dynamic rows ────────────────────────────────────────────────
function renderMilestoneRows() {
  var el = document.getElementById('rfq_milestone_rows');
  if (!el) return;
  if (!_rfqMilestoneRows.length) {
    el.innerHTML = '<div style="font-size:11px;color:var(--muted);padding:10px 0;font-style:italic;">No milestones — click "+ Add Milestone" to add payment milestones.</div>';
    _rfqCheckMilestoneTotal();
    return;
  }
  var mfmt = function(v){ return (v === '' || v == null) ? '' : _rfqFmtMoney(_rfqParseNum(v)); };
  el.innerHTML = '<div style="overflow-x:auto;">'
    + '<table class="std-table" style="min-width:560px;">'
    + '<thead><tr>'
    + '<th style="width:26%;">Milestone</th>'
    + '<th style="width:10%;">%</th>'
    + '<th style="width:18%;">Gross ($)</th>'
    + '<th style="width:18%;">Holdback ($)</th>'
    + '<th style="width:18%;">Net</th>'
    + '<th style="width:8%;"></th>'
    + '</tr></thead><tbody>'
    + _rfqMilestoneRows.map(function(m, i) {
        return '<tr>'
          + '<td style="padding:4px 6px;"><input type="text"   id="rfq_mr_name_' + i + '"     value="' + escapeHtml(m.name    || '') + '" class="stg-lookup-input" style="padding:4px 6px;font-size:12px;" placeholder="e.g. Mobilization"/></td>'
          + '<td style="padding:4px 6px;"><input type="number" id="rfq_mr_pct_' + i + '"      value="' + escapeHtml(m.pct     || '') + '" class="stg-lookup-input" style="padding:4px 6px;font-size:12px;" placeholder="%" min="0" max="100" step="0.1" oninput="_rfqCalcMilestoneRow(' + i + ',\'pct\')"/></td>'
          + '<td style="padding:4px 6px;"><input type="text"   inputmode="decimal" id="rfq_mr_gross_' + i + '" value="' + escapeHtml(mfmt(m.gross)) + '" class="stg-lookup-input" style="padding:4px 6px;font-size:12px;" placeholder="$0.00" onfocus="_rfqCurrencyFocus(this)" oninput="_rfqCalcMilestoneRow(' + i + ',\'gross\')" onblur="_rfqCurrencyBlur(this)"/></td>'
          + '<td style="padding:4px 6px;"><input type="text"   id="rfq_mr_holdback_' + i + '" value="' + escapeHtml(mfmt(m.holdback)) + '" class="stg-lookup-input" style="padding:4px 6px;font-size:12px;background:var(--bg);color:var(--muted);" readonly title="10% of gross"/></td>'
          + '<td style="padding:4px 6px;"><input type="text"   id="rfq_mr_net_' + i + '"      value="' + escapeHtml(mfmt(m.net)) + '" class="stg-lookup-input" style="padding:4px 6px;font-size:12px;background:var(--bg);color:var(--muted);" readonly/></td>'
          + '<td style="padding:4px 6px;text-align:center;"><button type="button" onclick="removeMilestoneRow(' + i + ')" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:18px;line-height:1;" title="Remove">&times;</button></td>'
          + '</tr>';
      }).join('')
    + '</tbody></table></div>';
  _rfqCheckMilestoneTotal();
  // Re-render leaves fresh inputs ENABLED — re-lock for view-only users
  // (intra-tab renders don't pass through switchRfqTab's re-apply).
  if (window._rfqReadOnly && typeof _rfqApplyReadOnly === 'function') _rfqApplyReadOnly();
}

function addMilestoneRow() {
  _readMilestoneRows();
  _rfqMilestoneRows.push({ name: '', pct: '', gross: '', holdback: '', net: '' });
  renderMilestoneRows();
}

function removeMilestoneRow(i) {
  _readMilestoneRows();
  _rfqMilestoneRows.splice(i, 1);
  renderMilestoneRows();
}

// Build one milestone row from a DOLLAR amount. pct is left blank unless a
// clean round percent is supplied: _rfqRefreshMilestonesFromTotal re-derives
// gross from pct (when pct > 0) every time the contract price recalcs, so a
// row whose true percentage isn't round (the material deposit, the remainder)
// must carry exact dollars + blank pct or each refresh would drift its value.
function _rfqMilestoneFromAmount(name, gross, pct, kind) {
  gross = Math.round((parseFloat(gross) || 0) * 100) / 100;
  var holdback = Math.round(gross * 10) / 100;             // 10% holdback
  var net = Math.round((gross - holdback) * 100) / 100;
  return { name: name, kind: kind || '', pct: (pct == null ? '' : String(pct)),
           gross: String(gross || ''), holdback: String(holdback || ''),
           net: String(net >= 0 ? net : 0) };
}

// Push gross (+ derived holdback/net, and the reference % for kind-driven rows)
// onto milestone row i, in both the DOM and _rfqMilestoneRows.
function _rfqSetMilestoneGross(i, gross, total) {
  gross = Math.round((parseFloat(gross) || 0) * 100) / 100;
  var grossEl = document.getElementById('rfq_mr_gross_' + i);
  var hbEl    = document.getElementById('rfq_mr_holdback_' + i);
  var netEl   = document.getElementById('rfq_mr_net_' + i);
  var pctEl   = document.getElementById('rfq_mr_pct_' + i);
  var hb  = Math.round(gross * 10) / 100;
  var net = Math.round((gross - hb) * 100) / 100;
  if (grossEl) grossEl.value = _rfqFmtMoney(gross);
  if (hbEl)    hbEl.value    = _rfqFmtMoney(hb);
  if (netEl)   netEl.value   = _rfqFmtMoney(net >= 0 ? net : 0);
  var kind = (_rfqMilestoneRows[i] && _rfqMilestoneRows[i].kind) || '';
  var showPct = (kind === 'material' || kind === 'remainder');
  if (pctEl && showPct) pctEl.value = total > 0 ? String(Math.round(gross / total * 10000) / 100) : '';
  if (_rfqMilestoneRows[i]) {
    _rfqMilestoneRows[i].gross    = String(gross || '');
    _rfqMilestoneRows[i].holdback = String(hb || '');
    _rfqMilestoneRows[i].net      = String(net >= 0 ? net : 0);
    if (pctEl && showPct) _rfqMilestoneRows[i].pct = pctEl.value;
  }
}

// Default milestone schedule — DYNAMIC, driven by the Price Breakdown:
//   Milestone 1 "50% Material" = HALF THE MATERIALS LINE of the breakdown
//   (a materials deposit so the contractor can purchase supply), then fixed
//   phases as a % of the contract price, and the FINAL phase = whatever
//   remains of the contract.
//     <  $75k: Material + Phase 1 25% + Phase 2 25% + Phase 3 (remainder)
//     >= $75k: Material + Phase 1-3 at 20% each   + Phase 4 (remainder)
// Seeded once when the schedule is empty; it does NOT auto-track later
// breakdown edits — "Reset to default schedule" recomputes from the current
// breakdown. Rows stay fully editable.
function _rfqDefaultMilestones(total) {
  total = parseFloat(total) || 0;
  var materials  = _rfqParseNum((document.getElementById('rfq_price_materials') || {}).value);
  var matDeposit = Math.round(materials * 50) / 100;       // 50% of Materials
  var big        = total >= 75000;
  var phasePct   = big ? 20 : 25;
  var midPhases  = big ? ['Phase 1', 'Phase 2', 'Phase 3'] : ['Phase 1', 'Phase 2'];
  if (total > 0) matDeposit = Math.min(matDeposit, total); // never exceed the contract
  function pctOf(g){ return total > 0 ? Math.round(g / total * 10000) / 100 : null; }
  // `kind` drives the LIVE recompute in _rfqRefreshMilestonesFromTotal:
  //   'material'  -> 50% of the Materials line (re-read each price change)
  //   'phase'     -> pct of the contract price
  //   'remainder' -> whatever is left of the contract after the others
  // The pct column on material/remainder rows is shown for reference only; their
  // gross is re-derived from the kind, so they no longer sit static while the
  // pct-based phases update.
  var rows  = [ _rfqMilestoneFromAmount('50% Material', matDeposit, pctOf(matDeposit), 'material') ];
  var spent = matDeposit;
  midPhases.forEach(function(name){
    // Clamp each phase to what's left so an outsized material deposit can't push
    // the seeded schedule past the contract price. A clamped row becomes a fixed
    // dollar amount (no kind, blank pct) so it isn't re-derived.
    var ideal     = Math.round(total * phasePct) / 100;
    var remaining = Math.max(0, Math.round((total - spent) * 100) / 100);
    var gross     = Math.min(ideal, remaining);
    var clean     = gross === ideal;
    spent += gross;
    rows.push(_rfqMilestoneFromAmount(name, gross, clean ? phasePct : null, clean ? 'phase' : ''));
  });
  var rem = Math.max(0, Math.round((total - spent) * 100) / 100);
  rows.push(_rfqMilestoneFromAmount(big ? 'Phase 4' : 'Phase 3', rem, pctOf(rem), 'remainder'));
  return rows;
}

// Contract value used to pick the tier + compute gross: the awarded amount if
// recorded, else the current price-breakdown total.
function _rfqContractValueForMilestones() {
  var award = _rfqParseNum(((window._rfqCache || {})[_rfqCurrentId] || {}).award_amount);
  if (award > 0) return award;
  return (typeof _rfqContractTotal === 'function') ? _rfqContractTotal() : 0;
}

// Seed defaults only when there are no milestones yet (never clobbers a saved
// or in-progress schedule). Called when the Contracting tab renders.
function _rfqSeedDefaultMilestonesIfEmpty() {
  if (_rfqMilestoneRows && _rfqMilestoneRows.length) return;
  _rfqMilestoneRows = _rfqDefaultMilestones(_rfqContractValueForMilestones());
}

// "Reset to default schedule" button — re-applies the tiered defaults for the
// CURRENT contract value, replacing whatever is there (HM/ED only).
function resetMilestonesToDefault() {
  if (typeof _rfqCanEdit === 'function' && !_rfqCanEdit()) { showToast('View only — only the Housing Manager or ED can edit this RFQ', {type:'error'}); return; }
  _rfqMilestoneRows = _rfqDefaultMilestones(_rfqContractValueForMilestones());
  renderMilestoneRows();
  if (typeof _rfqCheckMilestoneTotal === 'function') _rfqCheckMilestoneTotal();
}

// Recompute one milestone row. source = 'pct' (gross = pct% of contract price)
// or 'gross' (pct = gross / contract price). Holdback auto = 10% of gross.
function _rfqCalcMilestoneRow(i, source) {
  var total   = _rfqContractTotal();
  var pctEl   = document.getElementById('rfq_mr_pct_' + i);
  var grossEl = document.getElementById('rfq_mr_gross_' + i);
  var hbEl    = document.getElementById('rfq_mr_holdback_' + i);
  var netEl   = document.getElementById('rfq_mr_net_' + i);
  if (!pctEl || !grossEl) return;
  var pct   = _rfqParseNum(pctEl.value);
  var gross = _rfqParseNum(grossEl.value);
  if (source === 'pct' && total > 0) {
    gross = total * pct / 100;
    grossEl.value = _rfqFmtMoney(gross);
  } else if (source === 'gross' && total > 0) {
    pct = gross / total * 100;
    pctEl.value = String(Math.round(pct * 100) / 100);
  }
  var holdback = gross * 0.10;                 // 10% holdback
  if (hbEl)  hbEl.value  = _rfqFmtMoney(holdback);
  var net = gross - holdback;
  if (netEl) netEl.value = _rfqFmtMoney(net >= 0 ? net : 0);
  if (_rfqMilestoneRows[i]) {
    // A manual edit overrides the auto schedule for this row: drop its kind so
    // the price-change refresh stops re-deriving it (the typed value sticks). A
    // typed percent keeps it phase-driven; a typed dollar makes it fixed.
    _rfqMilestoneRows[i].kind     = (source === 'pct' && _rfqParseNum(pctEl.value) > 0) ? 'phase' : '';
    _rfqMilestoneRows[i].pct      = pctEl.value;
    _rfqMilestoneRows[i].gross    = String(gross || '');
    _rfqMilestoneRows[i].holdback = String(holdback || '');
    _rfqMilestoneRows[i].net      = String(net >= 0 ? net : 0);
  }
  _rfqCheckMilestoneTotal();
}

// When the contract price (or the Materials line) changes, re-derive every
// milestone's gross: 'material' rows = 50% of the Materials line, pct-bearing
// 'phase' rows = pct of the contract, and 'remainder' rows = whatever is left.
// This is why the material deposit and the final phase now track price edits
// too — previously only rows carrying a round pct were refreshed, so those two
// (which deliberately store a blank pct) sat static.
function _rfqRefreshMilestonesFromTotal() {
  var total     = _rfqContractTotal();
  var materials = _rfqParseNum((document.getElementById('rfq_price_materials') || {}).value);
  // Pass 1: material + phase (and fixed) rows; sum them so remainder can be derived.
  var i = 0, sumNonRemainder = 0;
  var remainderIdxs = [];
  while (document.getElementById('rfq_mr_gross_' + i)) {
    var kind = (_rfqMilestoneRows[i] && _rfqMilestoneRows[i].kind) || '';
    if (kind === 'remainder') { remainderIdxs.push(i); i++; continue; }
    var pct = _rfqParseNum((document.getElementById('rfq_mr_pct_' + i) || {}).value);
    var g;
    if (kind === 'material') {
      g = Math.round(materials * 50) / 100;                     // 50% of the Materials line
      _rfqSetMilestoneGross(i, g, total);
    } else if (pct > 0 && total > 0) {
      g = total * pct / 100;
      _rfqSetMilestoneGross(i, g, total);
    } else {
      g = _rfqParseNum((document.getElementById('rfq_mr_gross_' + i) || {}).value);   // fixed / manual — leave as-is
    }
    sumNonRemainder += (parseFloat(g) || 0);
    i++;
  }
  // Pass 2: remainder rows take whatever is left of the contract price.
  remainderIdxs.forEach(function(ri){
    var g = Math.max(0, Math.round((total - sumNonRemainder) * 100) / 100);
    _rfqSetMilestoneGross(ri, g, total);
    sumNonRemainder += g;   // a 2nd remainder (unusual) would then be 0
  });
  _rfqCheckMilestoneTotal();
}

// Summary + guard: total of milestone gross cannot exceed the contract price.
function _rfqCheckMilestoneTotal() {
  var summ = document.getElementById('rfq_milestone_summary');
  if (!summ) return true;
  var total = _rfqContractTotal();
  var sumGross = 0, i = 0;
  while (document.getElementById('rfq_mr_gross_' + i)) { sumGross += _rfqParseNum(document.getElementById('rfq_mr_gross_' + i).value); i++; }
  if (i === 0) { summ.innerHTML = ''; return true; }
  var over = sumGross > total + 0.005;
  var pctOfTotal = total > 0 ? Math.round(sumGross / total * 1000) / 10 : 0;
  summ.innerHTML = 'Milestones total <strong>' + _rfqFmtMoney(sumGross) + '</strong> of contract price <strong>' + _rfqFmtMoney(total) + '</strong>'
    + (total > 0 ? ' (' + pctOfTotal + '%)' : '')
    + (over ? ' &mdash; <span style="color:var(--danger,#dc2626);font-weight:700;">exceeds the contract price</span>' : '');
  summ.style.color = over ? 'var(--danger,#dc2626)' : 'var(--muted)';
  return !over;
}

function _readMilestoneRows() {
  var rows = [];
  var i = 0;
  while (document.getElementById('rfq_mr_name_' + i)) {
    rows.push({
      name:     (document.getElementById('rfq_mr_name_' + i) || {}).value || '',
      // Preserve the auto-calc kind (material/phase/remainder) across DOM reads —
      // it isn't an input, so carry it from the existing row by index.
      kind:     (_rfqMilestoneRows[i] && _rfqMilestoneRows[i].kind) || '',
      pct:      (document.getElementById('rfq_mr_pct_'  + i) || {}).value || '',
      // Store clean numbers (strip $ , formatting) so the payload/PDF parse cleanly.
      gross:    String(_rfqParseNum((document.getElementById('rfq_mr_gross_'    + i) || {}).value) || ''),
      holdback: String(_rfqParseNum((document.getElementById('rfq_mr_holdback_' + i) || {}).value) || ''),
      net:      String(_rfqParseNum((document.getElementById('rfq_mr_net_'      + i) || {}).value) || '')
    });
    i++;
  }
  _rfqMilestoneRows = rows;
  return rows;
}

// ── Auto-fill contractor details when awarded-to changes ──────────────────
// When a contractor is picked in the Scope-tab Award card, prepopulate as much
// of the Contracting page as possible: signatory + site lead from the record,
// the read-only contractor-detail panel, and the contract amount into pricing.
function _rfqAutoFillContractor() {
  var sel = document.getElementById('rfq_awarded_to');
  var ct  = (sel && sel.value) ? (window._contractors || []).find(function(c){ return c && c.id === sel.value; }) : null;
  if (ct) {
    var setIfBlank = function(id, val){ var el = document.getElementById(id); if (el && !el.value.trim() && val) el.value = val; };
    setIfBlank('rfq_ct_signatory_name',  ct.sigCt && ct.sigCt.name  ? ct.sigCt.name  : ct.name  || '');
    setIfBlank('rfq_ct_signatory_title', ct.sigCt && ct.sigCt.title ? ct.sigCt.title : '');
    setIfBlank('rfq_site_lead_phone',    ct.phone || '');
  }
  // Flow the awarded contractor's recorded bid through to the award amount so a
  // bid entered on the Recipients tab populates the award (and the contract).
  _rfqSyncAwardAmountFromBid();
  _rfqRenderAwardedContractorInfo();
}

// Set the Scope Award card's Award Amount from the awarded contractor's recorded
// bid (Recipients tab). Called when the awarded contractor is (re)selected and
// whenever that contractor's bid amount is edited, so the quoted amount flows
// through the RFQ -> award -> contract without re-keying.
function _rfqSyncAwardAmountFromBid() {
  var sel  = document.getElementById('rfq_awarded_to');
  var ctId = sel && sel.value;
  if (!ctId) return;
  var bid = (_rfqBids && _rfqBids[ctId]) || {};
  var amt = parseFloat(bid.amount);
  if (isNaN(amt) || amt <= 0) return;
  var amtEl = document.getElementById('rfq_award_amount');
  if (amtEl) amtEl.value = (typeof _rfqFmtMoney === 'function') ? _rfqFmtMoney(amt) : String(amt);
}

// (Removed _rfqSeedPriceFromAward — it auto-filled the "Other" price line with
// the full award amount, which was confusing and produced a bad contract. The
// price breakdown is now entered by staff; the Contract Price total derives
// from it, and the awarded amount is shown on the Scope > Award card.)

// Holdback release timing: N days after Substantial Completion -> a date.
function _rfqAddDays(dateStr, days) {
  if (!dateStr) return '';
  var d = new Date(dateStr + 'T12:00:00');
  if (isNaN(d.getTime())) return '';
  d.setDate(d.getDate() + (parseInt(days, 10) || 0));
  return d.toISOString().slice(0, 10);
}
function _rfqUpdateHoldbackReleaseDate() {
  var out = document.getElementById('rfq_holdback_release_date');
  if (!out) return;
  var sc   = (document.getElementById('rfq_substantial_completion') || {}).value || '';
  var days = (document.getElementById('rfq_holdback_days') || {}).value || '';
  if (sc && days !== '') {
    var rd = _rfqAddDays(sc, days);
    out.textContent = rd ? ('Est. release date: ' + rd) : '';
  } else if (!sc && days !== '') {
    out.textContent = 'Set a Substantial Completion Date to compute the release date.';
  } else {
    out.textContent = '';
  }
}

// Read-only summary of the awarded contractor's on-file details (the ones that
// print on the contract but have no form field), shown at the top of Contract
// Details so staff can verify before generating.
function _rfqRenderAwardedContractorInfo() {
  var box = document.getElementById('rfq_awarded_ct_info');
  if (!box) return;
  var sel = document.getElementById('rfq_awarded_to');
  var ct  = (sel && sel.value) ? (window._contractors || []).find(function(c){ return c && c.id === sel.value; }) : null;
  if (!ct) { box.style.display = 'none'; box.innerHTML = ''; return; }
  var today = new Date().toISOString().slice(0,10);
  var row = function(label, val){
    return val ? '<div style="display:flex;gap:8px;"><span style="min-width:96px;color:var(--muted);">' + label + '</span><span style="color:var(--text);">' + escapeHtml(String(val)) + '</span></div>' : '';
  };
  var expiring = function(num, exp){
    if (!num) return '';
    var s = String(num);
    if (exp) s += ' (exp ' + exp + (exp < today ? ' — EXPIRED' : '') + ')';
    return s;
  };
  var phone = ct.phone ? ((typeof formatPhone === 'function') ? formatPhone(ct.phone) : ct.phone) : '';
  box.style.display = '';
  box.innerHTML = '<div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px 12px;font-size:12px;line-height:1.7;margin-bottom:14px;">'
    + '<div style="font-weight:700;color:var(--text);margin-bottom:4px;">&#127981; Awarded Contractor</div>'
    + row('Name', ct.name)
    + row('Trade', ct.trade)
    + row('Address', ct.address)
    + row('Phone', phone)
    + row('Email', ct.email)
    + row('GST/HST #', ct.hst)
    + row('WSIB #', expiring(ct.wsibNum, ct.wsibExpiry))
    + row('Insurance', ct.insProvider ? (ct.insProvider + (ct.insExpiry ? ' (exp ' + ct.insExpiry + (ct.insExpiry < today ? ' — EXPIRED' : '') + ')' : '')) : '')
    + '</div>';
}

// ── Currency helpers ($###,###.00) ───────────────────────────────────────
function _rfqParseNum(v){ return parseFloat(String(v == null ? '' : v).replace(/[$,\s]/g, '')) || 0; }
function _rfqFmtMoney(n){ return '$' + (Number(n) || 0).toLocaleString('en-CA', {minimumFractionDigits:2, maximumFractionDigits:2}); }
// On focus, strip formatting so the field is easy to edit; on blur, re-format.
function _rfqCurrencyFocus(el){ if (el) el.value = String(el.value || '').replace(/[$,\s]/g, ''); }
function _rfqCurrencyBlur(el){ if (!el) return; var raw = String(el.value || '').replace(/[$,\s]/g, ''); el.value = (raw === '') ? '' : _rfqFmtMoney(parseFloat(raw) || 0); }

// Contract price = sum of the price-breakdown lines.
function _rfqContractTotal(){
  return _rfqParseNum((document.getElementById('rfq_price_materials')     || {}).value)
       + _rfqParseNum((document.getElementById('rfq_price_labour')        || {}).value)
       + _rfqParseNum((document.getElementById('rfq_price_equipment')     || {}).value)
       + _rfqParseNum((document.getElementById('rfq_price_subcontractors')|| {}).value)
       + _rfqParseNum((document.getElementById('rfq_price_other')         || {}).value);
}

// ── Price auto-calculation (tax always $0 for First Nations) ─────────────
function _rfqRecalcPrices() {
  function setRO(id, val) { var el = document.getElementById(id); if (el) el.value = _rfqFmtMoney(val || 0); }
  var sub = _rfqContractTotal();
  setRO('rfq_price_subtotal',       sub);
  setRO('rfq_price_total_incl_tax', sub);          // tax = 0
  setRO('rfq_holdback_release',     sub * 0.10);   // holdback release = 10% of contract price
  // Contract price changed -> refresh each milestone's gross/holdback/net from its %.
  _rfqRefreshMilestonesFromTotal();
  _rfqCheckMilestoneTotal();
}

// ── Documents tab ─────────────────────────────────────────────────────────

function renderDocumentsTab() {
  var rfqId = _rfqCurrentId || document.getElementById('rfq_number').value.trim();
  if (!rfqId) {
    var m = document.getElementById('rfq_doc_lib_mount');
    if (m) m.innerHTML = '<div class="rfq-progress-msg">Save the RFQ draft first to enable document uploads.</div>';
    return;
  }

  // Mount the standard DocLibrary (drag-and-drop, preview, delete)
  var mount = document.getElementById('rfq_doc_lib_mount');
  if (mount && window.DocLibrary) {
    mount.innerHTML = '';
    _rfqDocLib = window.DocLibrary.create(mount, {
      entityType:    'rfq',
      entityId:      rfqId,
      readOnly:      !_rfqCanEdit(),   // viewers see docs but can't upload/delete
      pathPrefix:    'tenants/' + (_rfqSowUnitId || rfqId),
      supabaseUrl:   SUPABASE_URL,
      supabaseAnon:  SUPABASE_ANON,
      storageBucket: STORAGE_BUCKET,
      getAuthToken:  function(){ return (window.HOUSING_HEADERS && window.HOUSING_HEADERS['Authorization'] || '').replace('Bearer ',''); },
      auditTable:    'housing_audit_log',
      getActor:      function(){ return (window.HOUSING_SESSION && window.HOUSING_SESSION.email) || window.currentRole || 'staff'; },
      categories: [
        { key:'site_plan', label:'Site Plan',       icon:'📍' },
        { key:'report',    label:'Report / Study',  icon:'📋' },
        { key:'spec',      label:'Specification',   icon:'📄' },
        { key:'photo',     label:'Photo',           icon:'📷' },
        { key:'image',     label:'Image',           icon:'🖼️' },
        { key:'other',     label:'Other',           icon:'📎' }
      ],
      maxSizeMB: 25,
      onChange: function(action) {
        if (action === 'upload' || action === 'delete') _rfqRefreshAttachList();
      }
    });
  } else if (mount) {
    mount.innerHTML = '<div class="rfq-progress-msg">Document library not available.</div>';
  }

  // Render the email-attachment selection list
  _rfqRefreshAttachList();
}

// True once the contract has been emailed AND the current user lacks the
// unlockEmailAttachments authority — the attach-to-email list is then frozen.
function _rfqAttachLocked() {
  if (!_rfqContractEmailed) return false;
  var role = (typeof CLFN_PERMS !== 'undefined' && CLFN_PERMS.normalizeRole)
    ? CLFN_PERMS.normalizeRole(window.currentRole) : (window.currentRole || '');
  if (typeof APPROVAL_AUTHORITY !== 'undefined' && APPROVAL_AUTHORITY.can) {
    return !APPROVAL_AUTHORITY.can('unlockEmailAttachments', role);
  }
  // Fallback if the authority registry isn't loaded: HM / ED / super_user unlock.
  return !(role === 'housing_manager' || role === 'ed' || role === 'super_user');
}

async function _rfqRefreshAttachList() {
  var el = document.getElementById('rfq_doc_attach_section');
  if (!el) return;
  var rfqId = _rfqCurrentId || document.getElementById('rfq_number').value.trim();
  if (!rfqId) { el.innerHTML = ''; return; }

  var _locked = _rfqAttachLocked();
  var _lockBanner = _locked
    ? '<div style="display:flex;align-items:center;gap:8px;background:var(--warn-amber-bg);border:1px solid var(--warn-amber-border);border-radius:7px;padding:8px 12px;margin-bottom:10px;font-size:11px;color:var(--warn-amber-text,#7a6000);">&#128274; Attaching files is locked because the contract has been emailed. A Housing Manager or ED can unlock this in Settings &rarr; Approval Authority.</div>'
    : '';

  el.innerHTML = '<div style="border-top:1px solid var(--border);padding-top:14px;">'
    + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">'
    +   '<div style="font-size:12px;font-weight:600;color:var(--text);">&#128231; Attach to contractor email</div>'
    +   '<button type="button" class="btn btn-ghost" style="font-size:11px;padding:4px 10px;" onclick="_rfqRefreshAttachList()">&#8635; Refresh</button>'
    + '</div>'
    + _lockBanner
    + '<div id="rfq_doc_attach_list"><div style="font-size:11px;color:var(--muted);font-style:italic;">Loading&hellip;</div></div>'
    + '<div style="margin-top:8px;font-size:10px;color:var(--muted);">Checked files will be attached to each contractor email when you issue the RFQ. Max 3 MB per file (Graph API limit). Larger files should be shared via link instead.</div>'
    + '</div>';

  try {
    _rfqDocFiles = (typeof sbLoadFileMeta === 'function') ? await sbLoadFileMeta('rfq', rfqId) : [];
  } catch(e) { _rfqDocFiles = []; }

  var listEl = document.getElementById('rfq_doc_attach_list');
  if (!listEl) return;

  if (!_rfqDocFiles.length) {
    listEl.innerHTML = '<div style="font-size:11px;color:var(--muted);font-style:italic;">No files yet — upload using the document library above, then click Refresh.</div>';
    return;
  }

  listEl.innerHTML = _rfqDocFiles.map(function(f) {
    var isAttached = _rfqAttachedPaths.indexOf(f.path) !== -1;
    var dispName   = f.name || f.path.split('/').pop().replace(/^\d+_/, '');
    var sizeKb     = f.size ? Math.round(f.size / 1024) + ' KB' : '';
    var tooBig     = f.size && f.size > 3 * 1024 * 1024;
    var _disabled  = tooBig || _locked;
    var safePath   = escapeHtml(f.path).replace(/'/g, "\\'");
    return '<label style="display:flex;align-items:center;gap:10px;padding:9px 12px;background:var(--bg);border-radius:7px;margin-bottom:6px;cursor:' + (_disabled ? 'default' : 'pointer') + ';border:1px solid var(--border);' + (_locked ? 'opacity:.7;' : '') + '">'
      +   '<input type="checkbox" '
      +     (isAttached ? 'checked ' : '')
      +     (_disabled ? 'disabled ' : '')
      +     'onchange="_rfqToggleAttach(\'' + safePath + '\', this.checked)" '
      +     'style="width:15px;height:15px;accent-color:var(--yellow);flex-shrink:0;cursor:' + (_disabled ? 'default' : 'pointer') + ';"/>'
      +   '<div style="min-width:0;flex:1;">'
      +     '<div style="font-size:12px;font-weight:500;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHtml(dispName) + '</div>'
      +     '<div style="font-size:10px;color:var(--muted);margin-top:1px;">'
      +       escapeHtml(sizeKb)
      +       (tooBig ? ' &mdash; <span style="color:var(--danger,#dc2626);">&#9888; exceeds 3 MB &mdash; cannot attach to email</span>' : '')
      +     '</div>'
      +   '</div>'
      + '</label>';
  }).join('');
  // Async render — switchRfqTab's read-only sweep ran before the awaited
  // load resolved, leaving live checkboxes/buttons for view-only users.
  if (window._rfqReadOnly && typeof _rfqApplyReadOnly === 'function') _rfqApplyReadOnly();
}

function _rfqToggleAttach(path, checked) {
  // Frozen once the contract has been emailed (unless the user can unlock).
  if (_rfqAttachLocked()) { if (typeof _rfqRefreshAttachList === 'function') _rfqRefreshAttachList(); return; }
  _rfqAttachedPaths = _rfqAttachedPaths.filter(function(p){ return p !== path; });
  if (checked) _rfqAttachedPaths.push(path);
}

// ── Contract readiness gate ──────────────────────────────────────────────
// Don't produce a blank / half-signed contract. Mirrors the TIC lease gate:
// require an awarded contractor, a price, key dates, and both signatures.
function _rfqContractMissing() {
  var missing = [];
  var fv  = function(id){ var el=document.getElementById(id); return el ? (el.value||'').trim() : ''; };
  var sig = function(id){ return (typeof getSigDataURL==='function') ? getSigDataURL(id) : ''; };
  var rfqId = _rfqCurrentId || fv('rfq_number');
  var rfq   = (window._rfqCache || {})[rfqId] || {};
  if (!(fv('rfq_awarded_to') || rfq.awarded_contractor_id)) missing.push('Awarded contractor (select on the Contracting tab)');
  var priceOk = (parseFloat(rfq.award_amount)||0) > 0
    || ['rfq_price_materials','rfq_price_labour','rfq_price_equipment','rfq_price_subcontractors','rfq_price_other']
         .some(function(id){ return _rfqParseNum(fv(id)) > 0; });
  if (!priceOk) missing.push('Contract price (award amount or price breakdown)');
  if (!fv('rfq_contract_date')) missing.push('Contract date');
  if (!fv('rfq_total_completion') && !fv('rfq_target_end')) missing.push('Completion date');
  // Milestone gross total cannot exceed the contract price.
  var _total = _rfqContractTotal();
  var _sumG = 0, _mi = 0;
  while (document.getElementById('rfq_mr_gross_' + _mi)) { _sumG += _rfqParseNum(document.getElementById('rfq_mr_gross_' + _mi).value); _mi++; }
  if (_mi > 0 && _sumG > _total + 0.005) {
    missing.push('Milestone payments (' + _rfqFmtMoney(_sumG) + ') exceed the contract price (' + _rfqFmtMoney(_total) + ')');
  }
  return missing;
}
// Signatures are a SOFT check — contracts are often generated first, then
// signed on paper / re-generated. Returns which sig blocks are still blank.
function _rfqContractMissingSigs() {
  var sig = function(id){ return (typeof getSigDataURL==='function') ? getSigDataURL(id) : ''; };
  var out = [];
  if (!sig('rfq_sig'))         out.push('Owner / Nation representative signature');
  if (!sig('rfq_ct_sig'))      out.push('Contractor signature');
  if (!sig('rfq_ct_initial'))  out.push('Contractor acknowledgement initial');
  return out;
}
function _rfqShowChecklist(title, items) {
  var existing = document.getElementById('rfq_checklist_modal');
  if (existing) existing.remove();
  var rows = items.map(function(it){
    return '<div style="display:flex;align-items:flex-start;gap:9px;padding:8px 0;border-bottom:1px solid var(--border);">'
      + '<span style="color:var(--danger,#dc2626);font-size:14px;line-height:1.3;">&#9711;</span>'
      + '<span style="font-size:12.5px;color:var(--text);line-height:1.5;">' + escapeHtml(it) + '</span></div>';
  }).join('');
  var m = document.createElement('div');
  m.id = 'rfq_checklist_modal';
  m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.72);z-index:11000;display:flex;align-items:center;justify-content:center;padding:16px;';
  m.innerHTML =
      '<div style="background:var(--surface);border-radius:12px;width:100%;max-width:440px;box-shadow:0 8px 40px rgba(0,0,0,.4);">'
    + '<div class="modal-hdr"><div><div class="lbl-yellow">&#9888;&#65039; ' + escapeHtml(title) + '</div>'
    +   '<div class="txt-sm-meta">Complete these before generating the contract:</div></div></div>'
    + '<div style="padding:14px 22px 4px;">' + rows + '</div>'
    + '<div style="padding:14px 22px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;">'
    +   '<button type="button" onclick="document.getElementById(\'rfq_checklist_modal\').remove()" class="btn btn-primary">Got it</button>'
    + '</div></div>';
  document.body.appendChild(m);
}

// ── Build the contractor agreement PDF ───────────────────────────────────
// All header / body / Schedule B / acknowledgement / signature drawing,
// extracted verbatim from generateContractorContract. tokens/d come from the
// caller's form scrape; numFmt is the caller's currency formatter (shared so
// Schedule B matches the token formatting). Returns the finished PDF Blob.
async function _rfqBuildContractPdf(tokens, d, savedBody, numFmt) {
  // Delegates to the shared builder (shared-contract.js). RFQ uses the default
  // signature canvas ids (rfq_sig / rfq_ct_sig / rfq_ct_initial).
  return window.buildContractPdf(tokens, d, savedBody, numFmt);
}

// ── Download + file the contract PDF ─────────────────────────────────────
// Browser download, then the dual doc-library filing (unit 'tenant' meta +
// this RFQ's meta) with the doc-lib / attach-list refreshes and the final
// toast. Extracted verbatim from generateContractorContract.
async function _rfqFileContractPdf(blob, filename) {
  return window.fileContractPdf(blob, filename, {
    unitId: _rfqSowUnitId,
    entities: _rfqCurrentId ? [{ type: 'rfq', id: _rfqCurrentId }] : [],
    savedMsg: _rfqCurrentId ? 'Contract PDF saved - added to RFQ and unit documents' : 'Contract PDF saved - also added to unit documents',
    onFiled: function(){
      if (_rfqDocLib && typeof _rfqDocLib.refresh === 'function') _rfqDocLib.refresh();
      if (typeof _rfqRefreshAttachList === 'function') _rfqRefreshAttachList();
    }
  });
}

// ── Generate Contractor Agreement PDF ────────────────────────────────────
// Renders the contract body from notifications.js CONTRACTS_DOCS_REGISTRY
// via jsPDF text primitives. getContractBody() always returns a non-empty
// body (registry default when no saved override), so no AcroForm fallback.
// Orchestrator: permission + readiness gates → token build →
// _rfqBuildContractPdf → _rfqFileContractPdf.
async function generateContractorContract() {
  if (!_rfqCanEdit()) { showToast('View only — only the Housing Manager or ED can generate a contract', {type:'error'}); return; }
  // Readiness gate — hard-block on missing contract essentials.
  var _missing = _rfqContractMissing();
  if (_missing.length) { _rfqShowChecklist('Not ready to generate', _missing); return; }
  // Resolve the awarded contractor + current award state early, for the
  // confirm messaging and the first-time award-on-generate.
  var _rfqId0    = _rfqCurrentId || (document.getElementById('rfq_number')||{}).value || '';
  _rfqId0        = String(_rfqId0).trim();
  var _rfq0      = (window._rfqCache || {})[_rfqId0] || {};
  var _ctId0     = ((document.getElementById('rfq_awarded_to')||{}).value || '').trim() || _rfq0.awarded_contractor_id;
  var _ct0       = (window._contractors || []).find(function(c){ return c && c.id === _ctId0; }) || {};
  var _needsAward = _rfq0.status !== 'awarded';
  // Signatures are soft — allow generating an unsigned copy to sign on paper.
  var _noSigs = _rfqContractMissingSigs();

  if (_needsAward && typeof showConfirm === 'function') {
    // First-time generation: ONE confirm covering generate + award + approve.
    var _sigNote = _noSigs.length ? ' Signatures are not captured (' + _noSigs.join(', ') + ') — you can sign on paper and re-generate.' : '';
    var _goAward = await showConfirm({
      title:       'Generate & Award Contract?',
      message:     'This will generate the contract, award this RFQ to ' + escapeHtml(_ct0.name || 'the selected contractor') + ', and approve the linked maintenance request.' + _sigNote + ' Continue?',
      confirmText: 'Generate & Award', cancelText: 'Cancel'
    });
    if (!_goAward) return;
  } else if (_noSigs.length && typeof showConfirm === 'function') {
    // Already awarded (re-generating) — keep the soft signature confirm only.
    var _goSig = await showConfirm({
      title:       'Generate without signatures?',
      message:     'No signature captured for: ' + _noSigs.join(', ') + '. Generate the contract anyway (e.g. to sign on paper)? You can re-generate after signing.',
      confirmText: 'Generate anyway', cancelText: 'Cancel'
    });
    if (!_goSig) return;
  }

  if (typeof showToast === 'function') showToast('Generating contract PDF…', {type:'info'});

  // Build data directly from current form state — don't depend on saveRfqDraft
  // completing successfully or _rfqCache being up to date. Save is fire-and-forget.
  var currentPayload = _buildRfqPayload();
  var d = currentPayload.data || {};
  // Await this save so it can't land AFTER the award-on-generate PATCH below
  // and revert status 'awarded' back to 'draft'. Still resilient (catch).
  if (typeof saveRfqDraft === 'function') { try { await saveRfqDraft(); } catch(e){ console.warn('[contract] background save failed:', e); } }

  var rfqId = _rfqCurrentId || document.getElementById('rfq_number').value.trim();
  var rfq   = (window._rfqCache || {})[rfqId] || {};

  function fv(id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; }

  // Resolve awarded contractor
  var ctId = fv('rfq_awarded_to') || rfq.awarded_contractor_id;
  var ct   = (window._contractors || []).find(function(c){ return c && c.id === ctId; }) || {};

  // Resolve unit address
  var unit = (window.housingUnits || []).find(function(u){ return u && u.id === _rfqSowUnitId; }) || {};
  var addr = (unit.num || '') + ' ' + (unit.street || '');
  addr = addr.trim() || _rfqSowUnitId || '';

  // Price totals
  function numFmt(v) { return v ? '$' + Number(v).toLocaleString('en-CA', {minimumFractionDigits:2, maximumFractionDigits:2}) : ''; }
  var pMat  = parseFloat(d.price_materials || 0);
  var pLab  = parseFloat(d.price_labour    || 0);
  var pEqp  = parseFloat(d.price_equipment || 0);
  var pSubc = parseFloat(d.price_subcontractors || 0);
  var pOth  = parseFloat(d.price_other     || 0);
  var pSub  = pMat + pLab + pEqp + pSubc + pOth;
  var pTot  = pSub; // First Nations — tax always $0

  // First-time generation awards the RFQ + approves the linked SOW (confirmed
  // above). skipNotify: the contract email below is the contractor's notice.
  // Awarding here also sets rfq.award_amount so the contract price renders.
  if (_needsAward && typeof awardRfq === 'function') {
    var _awardAmt = (parseFloat(rfq.award_amount) || pTot) || 0;
    try {
      await awardRfq(rfqId, ctId, _awardAmt, d.award_notes || rfq.award_notes || null, { skipNotify: true });
      rfq = (window._rfqCache || {})[rfqId] || rfq;
      ct  = (window._contractors || []).find(function(c){ return c && c.id === ctId; }) || ct;
    } catch(e) { console.warn('[contract] award-on-generate failed:', e); }
  }

  var tokens = {
    rfqNumber:               rfqId,
    contractNumber:          d.contract_number          || '',
    contractDate:            d.contract_date            || '',
    propertyAddress:         addr,
    projectType:             (_rfqSowData && (_rfqSowData.condition || _rfqSowData.type)) || '',
    sowReference:            _rfqSowPn || rfq.sow_project_number || '',
    quoteNumber:             d.ct_quote_number || rfqId,
    contractorQuoteNumber:   d.ct_quote_number || '',
    startDate:               d.contract_start           || d.target_start_date       || '',
    substantialCompletionDate: d.substantial_completion_date || '',
    totalCompletionDate:     d.total_completion_date    || d.target_completion_date  || '',
    contractorLegalName:     ct.name    || '',
    contractorOperatingName: ct.name    || '',
    contractorAddressLine1:  ct.address || '',
    contractorAddressLine2:  '',
    contractorGstHst:        ct.hst     || '',
    contractorWsib:          ct.wsibNum || '',
    contractorPhone:         ct.phone   || '',
    contractorSignatoryName: d.ct_signatory_name  || (ct.sigCt && ct.sigCt.name)  || ct.name || '',
    contractorSignatoryTitle:d.ct_signatory_title || (ct.sigCt && ct.sigCt.title) || '',
    contractorSignatoryEmail:ct.email   || '',
    contractorSiteLead:      d.site_lead_name  || '',
    contractorSiteLeadPhone: d.site_lead_phone || '',
    contractPrice:           numFmt(rfq.award_amount),
    contractPriceExclTax:    d.contract_price_excl_tax ? numFmt(d.contract_price_excl_tax) : numFmt(pSub),
    apEmail:                 d.ap_email || '',
    nationName:              (window.NATION_CONFIG && NATION_CONFIG.display_name) || 'Housing Authority',
    nationShort:             (window.NATION_CONFIG && NATION_CONFIG.short) || '',
    clfnSignatoryName:       d.sig_name  || '',
    clfnSignatoryTitle:      d.sig_title || '',
    sowSummary:              d.sow_summary     || '',
    sowDetailTable:          (d.scope_detail_rows || []).filter(function(r){ return r.category || r.description; }).map(function(r, i){ return (i+1) + '. ' + [r.category, r.description, r.notes].filter(Boolean).join(' — '); }).join('\n') || '',
    materialsSpecifications: (d.materials_rows    || []).filter(function(r){ return r.material || r.specification; }).map(function(r, i){ return (i+1) + '. ' + [r.material, r.specification, r.notes].filter(Boolean).join(' — '); }).join('\n') || '',
    exclusionsAssumptions:   (d.exclusions_rows   || []).filter(function(r){ return r.text; }).map(function(r, i){ return (i+1) + '. ' + r.text; }).join('\n') || '',
    clfnSuppliedItems:       (d.clfn_supplied_rows|| []).filter(function(r){ return r.item; }).map(function(r, i){ return (i+1) + '. ' + r.item; }).join('\n') || 'None',
    priceMaterials:          numFmt(pMat),
    priceLabour:             numFmt(pLab),
    priceEquipment:          numFmt(pEqp),
    priceSubcontractors:     numFmt(pSubc),
    priceOther:              numFmt(pOth),
    priceSubtotal:           numFmt(pSub),
    priceTax:                '$0.00',
    priceTotalInclTax:       numFmt(pTot),
    labourHours:             d.labour_hours    || '',
    holdbackRelease:         numFmt(d.holdback_release)
  };

  var filename = (tokens.nationShort || 'Housing') + '_Contract_' + rfqId + '.pdf';

  // ── jsPDF path ─────────────────────────────────────────────────────────
  var savedBody = (typeof getContractBody === 'function') ? getContractBody('contractor_agreement') : '';
  if (!savedBody || !savedBody.trim()) {
    if (typeof showToast === 'function') showToast('Contract body not found — check Settings → Contracts', {type:'error'});
    return;
  }
  try {
      var blob = await _rfqBuildContractPdf(tokens, d, savedBody, numFmt);
      await _rfqFileContractPdf(blob, filename);
      // Email the contract to the awarded contractor (confirm + uncheckable
      // recipient). Best-effort — the contract is already generated + filed.
      await _rfqEmailContract(blob, filename, ct, (d.ap_email || ''), rfqId, addr);
  } catch(e) {
    console.error('[contract] generation failed:', e);
    if (typeof showToast === 'function') showToast('Contract PDF failed: ' + e.message, {type:'error'});
  }
}

// Base64-encode a Blob (strips the data: URI prefix) for email attachments.
function _rfqBlobToBase64(blob) {
  return new Promise(function(resolve, reject) {
    try {
      var fr = new FileReader();
      fr.onload  = function(){ var s = String(fr.result || ''); resolve(s.substring(s.indexOf(',') + 1)); };
      fr.onerror = function(){ reject(fr.error || new Error('read failed')); };
      fr.readAsDataURL(blob);
    } catch(e) { reject(e); }
  });
}

// Email the generated contract PDF to the awarded contractor. Shows a confirm
// with an uncheckable recipient (uncheck to skip). From-address is the fixed
// nation mailbox (Microsoft Graph); reply-to is the AP/Invoice email so the
// contractor's replies route to accounts payable. On send, marks the RFQ
// contract_emailed (which locks the "attach to email" list) and persists it.
async function _rfqEmailContract(blob, filename, ct, apEmail, rfqId, addr) {
  try {
    if (typeof showConfirm !== 'function' || typeof sendNotification !== 'function') return;
    if (!ct || !ct.email) { if (typeof showToast === 'function') showToast('No contractor email on file — contract not emailed.', {type:'error'}); return; }
    var _esc = escapeHtml; // shared-ui.js (same five-char escape)
    var r = await showConfirm({
      title:       'Email Contract to Contractor?',
      message:     'Send the generated contract (PDF attached) to the awarded contractor? Uncheck to skip sending.',
      confirmText: 'Send Contract', cancelText: 'Cancel',
      checkbox:    { label: _esc(ct.name || 'Contractor') + ' (' + _esc(ct.email) + ')', defaultChecked: true }
    });
    var ok  = (typeof r === 'object' && r) ? r.ok : r;
    var snd = (typeof r === 'object' && r) ? r.checked : false;
    if (!ok || !snd) return;

    var b64 = await _rfqBlobToBase64(blob);
    var short = (window.NATION_CONFIG && NATION_CONFIG.short) || 'Housing';
    var opts = {
      to:          ct.email,
      to_name:     ct.name || '',
      subject:     short + ' Housing — Contract: ' + (addr || rfqId),
      bodyHtml:    '<p>Hello ' + _esc(ct.name || '') + ',</p>'
                 + '<p>Please find the attached contract for <strong>' + _esc(addr || 'the project') + '</strong> (' + _esc(rfqId) + ').</p>'
                 + '<p>Please review, sign, and return a copy. If you have any questions, reply to this email'
                 + (apEmail ? ' or contact ' + _esc(apEmail) : '') + '.</p>'
                 + '<p>Thank you,<br/>' + _esc(short) + ' Housing</p>',
      attachments: [{ name: filename, contentType: 'application/pdf', contentBytes: b64 }],
      event:       'rfq_contract',
      entity_type: 'rfq',
      entity_id:   rfqId
    };
    if (apEmail) { opts.cc = apEmail; opts.reply_to = apEmail; }
    await sendNotification(opts);

    // Mark emailed → locks the attach-to-email list (see _rfqAttachLocked).
    _rfqContractEmailed = true;
    var rfq = (window._rfqCache || {})[rfqId];
    if (rfq) { rfq.data = rfq.data || {}; rfq.data.contract_emailed = true; }
    if (typeof saveRfqDraft === 'function') saveRfqDraft().catch(function(){});
    if (typeof _rfqRefreshAttachList === 'function') _rfqRefreshAttachList();
    if (typeof showToast === 'function') showToast('✓ Contract emailed to ' + (ct.name || 'contractor'), {type:'info'});
  } catch(e) {
    console.warn('[contract] email failed:', e);
    if (typeof showToast === 'function') showToast('Contract email failed: ' + (e.message || 'unknown error'), {type:'error'});
  }
}

