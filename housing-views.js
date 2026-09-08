/* ============================================================
 * housing-views.js — CLFN Housing Suite
 * View navigation and render functions for housing.html
 *
 * Load order: ... shared-data.js → scoring.js → THIS FILE
 *
 * Exposes:
 *   showDash()              — navigate to dashboard/home
 *   showApp()               — navigate to application form
 *   showSettings()          — navigate to settings panel
 *   showFinance()           — navigate to finance module
 *   showEmployeeHome()      — render role-aware home/tile screen
 *   showTenantsForRole()    — show tenants or tenant search by role
 *   showInventoryForRole()  — show inventory or unit search by role
 *   renderInventoryView()   — render housing inventory table
 *   renderMatchView()       — render housing match table
 *   renderTenantsView()     — render tenants table
 * ============================================================ */

'use strict';

function _fmtUnitType(type) {
  if (!type || type === '0' || type === 'nan') return '';
  return type.replace(/_/g, ' ').replace(/\b\w/g, function(c){ return c.toUpperCase(); });
}

var _FUNDER_LABELS = {
  'ISC':              'ISC',
  'CMHC_95':         'CMHC Sec. 95',
  'section_10':      'Section 10',
  'rent_to_own':     'Rent-to-Own',
  'band_house':      'Band House',
  'privately_owned': 'Privately Owned',
  'Other':           'Other',
};
function _fmtFunder(val) {
  if (!val) return '';
  return _FUNDER_LABELS[val] || val.replace(/_/g, ' ');
}
function _roomBedLabel(u) {
  var n = u ? u.bedrooms : null;
  if (n == null || n === '') return '';
  var isBldg = ['admin_building','band_building','commercial_building'].indexOf(u.type) >= 0;
  return isBldg ? n + (n == 1 ? ' room' : ' rooms') : n + '-bed';
}
// Assignment Type badge — Temporary (urgent/emergency) and Transition
// (probationary) units, set via the Edit Unit modal. Mirrors the ELDERS UNIT
// badge markup pattern used alongside it. See liveMatchPriorityModel
// (scoring.js) for how each type affects Match placement order.
// Living-situation badge for application rows/cards. Distinguishes members
// who live ON reserve but not in their own home (doubled up with family —
// neither a transfer nor an ordinary off-reserve applicant) and those with no
// fixed address. Keys come from shared-config's LIVING_SITUATIONS.
function _livingSituationBadge(a) {
  var ls = a && a.livingSituation;
  if (ls === 'family_on_reserve') return '<span style="display:inline-block;font-size:10px;font-weight:700;background:var(--warn-amber);color:var(--dark);padding:1px 7px;border-radius:4px;white-space:nowrap;">👥 Doubled up · on reserve</span>';
  if (ls === 'temporary_shelter') return '<span style="display:inline-block;font-size:10px;font-weight:700;background:var(--warn-amber);color:var(--dark);padding:1px 7px;border-radius:4px;white-space:nowrap;">\u26fa Temporary shelter</span>';
  if (ls === 'no_fixed_address')  return '<span style="display:inline-block;font-size:10px;font-weight:700;background:var(--danger-bg);color:var(--danger);border:1px solid var(--danger-border);padding:1px 7px;border-radius:4px;white-space:nowrap;">No fixed address</span>';
  return '';
}

// Red "ineligible" badge for applicants on the active BCR list (banished, or
// evicted for harbouring). They stay VISIBLE on Match — flagged, filterable —
// while the Applications-by-Type KPI counts exclude them entirely.
function _bcrIneligibleBadge(a) {
  if (typeof appIsBcrIneligible !== 'function' || !appIsBcrIneligible(a)) return '';
  return '<span style="display:inline-block;font-size:10px;font-weight:700;background:var(--danger-bg);color:var(--danger);border:1px solid var(--danger-border);padding:1px 7px;border-radius:4px;white-space:nowrap;">🚫 Ineligible — BCR list</span>';
}

// Amber good-standing badge (Policy 8.5/12.5): arrears with no approved
// repayment arrangement. Like the BCR badge the applicant stays VISIBLE on
// Match — the block itself fires at the assignment actions
// (appAssignabilityStatus with forAssignment), never as silent exclusion.
function _arrearsWarnBadge(a) {
  var msg = (typeof appArrearsWarning === 'function') ? appArrearsWarning(a) : null;
  if (!msg) return '';
  return '<span title="' + escapeHtml(msg) + '" style="display:inline-block;font-size:10px;font-weight:700;background:var(--warn-amber-bg);color:var(--warn-amber-text);border:1px solid var(--warn-amber);padding:1px 7px;border-radius:4px;white-space:nowrap;">💰 Arrears — arrangement required</span>';
}

function _assignmentTypeBadge(u) {
  if (!u || !u.assignmentType) return '';
  if (u.assignmentType === 'temporary') return '<span style="font-size:9px;background:var(--danger-bg);color:var(--danger);border:1px solid var(--danger-border);padding:1px 5px;border-radius:6px;">TEMPORARY</span>';
  if (u.assignmentType === 'transition') return '<span style="font-size:9px;background:var(--info-blue-bg);color:#1d4ed8;border:1px solid #bfdbfe;padding:1px 5px;border-radius:6px;">TRANSITION</span>';
  return '';
}

// ── List / Cards view toggle (Inventory, Match) ─────────────────────────────
// Mirrors the worklist's List/Cards pattern (clfn_worklist_view in
// shared-data.js renderWorklist) — persisted per device, defaults to List.
// Kept as its own small set of helpers here (not shared with the worklist's
// locally-scoped wlGrid/wlPill/wlCard) since those are private to
// renderWorklist(); this is the shared home for every OTHER page's table.
function _viewMode(key) {
  // Default is Cards for every page — only an explicit saved 'list' preference
  // shows the table. (Users who picked List keep List; everyone else gets Cards.)
  try { return localStorage.getItem('clfn_' + key + '_view') === 'list' ? 'list' : 'cards'; } catch(e) { return 'cards'; }
}
function _viewToggleHtml(key, setFnName) {
  var cur = _viewMode(key);
  function b(v, label, icon) {
    var on = cur === v;
    return '<button type="button" onclick="' + setFnName + '(\'' + v + '\')" style="display:flex;align-items:center;gap:5px;padding:5px 12px;'
      + 'border:1px solid ' + (on ? 'var(--yellow)' : 'var(--border)') + ';background:' + (on ? 'var(--yellow)' : 'var(--surface)') + ';'
      + 'color:' + (on ? 'var(--dark)' : 'var(--muted)') + ';font-size:11px;font-weight:700;font-family:DM Sans,sans-serif;cursor:pointer;'
      + 'border-radius:' + (v === 'list' ? '7px 0 0 7px' : '0 7px 7px 0') + ';' + (v === 'cards' ? 'margin-left:-1px;' : '') + '">' + icon + ' ' + label + '</button>';
  }
  return '<div style="display:flex;justify-content:flex-end;margin-bottom:10px;"><div style="display:flex;">' + b('list', 'List', '&#9776;') + b('cards', 'Cards', '&#9638;') + '</div></div>';
}
// Card-grid builders — used by any page's Cards view. o = {title, pill:{text,bg,color},
// badges:[html], metas:[{k,v}], open:'onclick js', actions:[{text,onclick,ghost} | {html}]}.
function _cardGrid(cards) { return '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px;">' + cards + '</div>'; }
function _cardPill(text, bg, color) {
  if (!text) return '';
  return '<span style="flex-shrink:0;font-size:10px;font-weight:700;color:' + (color||'var(--muted)') + ';background:' + (bg||'var(--bg)') + ';border:1px solid var(--border);border-radius:20px;padding:2px 8px;white-space:nowrap;">' + text + '</span>';
}
function _cardTile(o) {
  var metas = (o.metas||[]).filter(function(m){ return m && m.v != null && String(m.v) !== ''; }).map(function(m){
    return '<div style="display:flex;justify-content:space-between;gap:10px;font-size:12px;margin-top:5px;">'
      + '<span style="color:var(--muted);flex-shrink:0;">' + m.k + '</span>'
      + '<span style="color:var(--text);font-weight:600;text-align:right;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + m.v + '</span></div>';
  }).join('');
  var badges = (o.badges||[]).join(' ');
  var actions = (o.actions||[]).map(function(a){
    if (a.html) return a.html;
    return '<button type="button" onclick="' + a.onclick + '" style="flex:1;background:' + (a.ghost ? 'none' : 'var(--yellow)') + ';color:' + (a.ghost ? 'var(--muted)' : 'var(--dark)') + ';'
      + 'border:' + (a.ghost ? '1px solid var(--border)' : 'none') + ';border-radius:7px;padding:8px 10px;font-size:12px;font-weight:700;font-family:DM Sans,sans-serif;cursor:pointer;white-space:nowrap;">' + a.text + '</button>';
  }).join('');
  return '<div style="border:1px solid var(--border);border-radius:10px;background:var(--surface);padding:13px 14px;display:flex;flex-direction:column;">'
    + '<div ' + (o.open ? 'onclick="' + o.open + '"' : '') + ' style="cursor:' + (o.open ? 'pointer' : 'default') + ';">'
    +   '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;">'
    +     '<span style="font-size:14px;font-weight:700;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-decoration:underline;text-decoration-color:var(--border);text-underline-offset:2px;">' + o.title + '</span>'
    +     _cardPill(o.pill && o.pill.text, o.pill && o.pill.bg, o.pill && o.pill.color)
    +   '</div>'
    +   (badges ? '<div style="margin-top:4px;">' + badges + '</div>' : '')
    +   metas
    + '</div>'
    // flex-wrap: three+ actions (e.g. Override/Archive/Progress on the reno
    // kanban's narrow columns) wrap to a second row instead of overflowing the
    // card — the buttons are nowrap by design, so wrapping is the relief valve.
    + (actions ? '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:11px;">' + actions + '</div>' : '')
    + '</div>';
}

function showDash(){
  var path = window.location.pathname || '';
  var onHousingHome =
    path.endsWith('/housing.html') ||
    path === '/housing.html' ||
    path.endsWith('/') ||
    path === '';
  if (!onHousingHome) {
    // Fade out before navigating — eliminates the flash/jump on departure
    document.body.style.transition = 'opacity .15s ease';
    document.body.style.opacity = '0';
    setTimeout(function() { window.location.href = '/housing.html?view=home'; }, 150);
    return;
  }
  showEmployeeHome();
}
function showApp(){
  var _al=document.getElementById('appLayout');
  if(_al){ _al.style.display='flex'; _al.style.width='100%'; }
  hideAllViews('appLayout');
  setNavActive('tab_app');
  if(_al){ _al.style.display='flex'; _al.style.width='100%'; }
  var spb=document.getElementById('stepProgressBar');if(spb)spb.style.display='block';
  var _abr=document.getElementById('appBackRow');if(_abr)_abr.style.display='block';
  var ta=document.getElementById('tab_app');if(ta)ta.classList.add('active');
}

function showSettings(){
  var role = window.currentRole || 'housing_employee_l1';
  if(!APPROVAL_AUTHORITY.can('accessSettings', role)) {
    showToast('Settings are only accessible to the Housing Manager and Executive Director.', {type:'info'});
    return;
  }
  // Settings view lives in housing.html — if we're on a sub-page (inventory,
  // tenants, match, renos, contractors), hand off so housing.html's ?view=
  // dispatcher can open it.
  if (!document.getElementById('settingsView')) {
    window.location.href = 'housing.html?view=settings';
    return;
  }
  if(!window._navSkipPush) pushNav('settings');
  _showView('settingsView');
  setNavActive('tab_settings');
  populateSettings();
  // Show Users tab first — each tab renders lazily when clicked via showSettingsSection
  showSettingsSection('sec_users');
  // Apply role-based locks after the Users tab has rendered
  setTimeout(applySettingsRoleLocks, 100);
}

// ── Finance Module ────────────────────────────────────────────────────────
// Gated by CLFN_MODULES.isEnabled('finance'). Stashes the current session
// into sessionStorage so finance.html (a separate single-file app) can read
// it, then navigates over.
function showFinance(){
  if(!(window.CLFN_MODULES && window.CLFN_MODULES.isEnabled('finance'))){
    console.warn('[housing] showFinance: finance module not enabled');
    showToast('Finance module is not enabled for this nation.', {type:'error'});
    return;
  }
  // Gate on finance-role access. Use the same authoritative source as
  // showEmployeeHome(): HOUSING_SESSION.role takes priority, then _realRole,
  // then currentRole. This avoids races where the gate sees stale
  // window.currentRole while HOUSING_SESSION.role is already set.
  var gateRole = (typeof HOUSING_SESSION !== 'undefined' && HOUSING_SESSION && HOUSING_SESSION.role)
              || window._realRole
              || window.currentRole
              || 'housing_employee_l1';
  var canAccess = window.CLFN_PERMS.hasFinanceAccess(gateRole);
  if(!canAccess){
    console.warn('[housing] showFinance: role "'+gateRole+'" blocked from finance module');
    showToast('Your role does not have access to the Finance module.', {type:'info'});
    return;
  }
  try {
    stashHousingSession();
  } catch(e) {
    // stashHousingSession already alerted the user; don't navigate.
    return;
  }
  window.location.href = 'finance.html';
}

// Writes the current user's session details into sessionStorage so that
// other same-origin HTML pages (finance.html today, renos.html in the
// future) can recover who is signed in without running the whole login
// flow again. Called on a successful login and whenever we hand off to a
// module in a separate HTML file.
//
// Reads from the globals the login flow actually populates:
//   - HOUSING_SESSION.accessToken  — set at login (line ~16400)
//   - HOUSING_SESSION.name          — set at login (line ~16399)
//   - HOUSING_SESSION.email         — set at login (line ~16398)
//   - HOUSING_SESSION.role          — set by resolveHousingRole()
//   - window._realRole              — also set by resolveHousingRole()
function stashHousingSession(){
  try {
    var token = '';
    var name  = '';
    var email = '';
    var role  = '';

    if (typeof HOUSING_SESSION !== 'undefined' && HOUSING_SESSION) {
      token = HOUSING_SESSION.accessToken || '';
      name  = HOUSING_SESSION.name || '';
      email = HOUSING_SESSION.email || '';
      role  = HOUSING_SESSION.role || '';
    }
    // _realRole takes precedence for role if set (it's the canonical role)
    if (window._realRole) role = window._realRole;

    if (!token) {
      console.warn('[housing] stashHousingSession: NO ACCESS TOKEN. Aborting handoff.');
      alert('Session handoff failed: no access token. Please sign out and sign back in.');
      throw new Error('no access token');
    }
    if (!role) {
      console.warn('[housing] stashHousingSession: NO ROLE. Aborting handoff.');
      alert('Session handoff failed: no role detected. Please sign out and sign back in.');
      throw new Error('no role');
    }

    var sess = {
      accessToken: token,
      role:        role,
      name:        name || email || 'Unknown User',
      email:       email
    };
    sessionStorage.setItem('HOUSING_SESSION', JSON.stringify(sess));
  } catch(e) {
    console.warn('[housing] stashHousingSession failed:', e);
    throw e;  // re-throw so showFinance() can abort navigation
  }
}



function renderInventoryView(){
  // Scroll-collapse: shrink the page header to a compact title bar once the
  // list scrolls, freeing space on tablet/mobile (shared-ui.js). Idempotent —
  // safe to call on every render.
  (function(){
    var _hdr = document.querySelector('#inventoryView .page-header-bar');
    var _area = document.querySelector('.content-area');
    if (_hdr && _area && typeof _initScrollCollapse === 'function') _initScrollCollapse(_area, _hdr);
  })();
  var showRenoCol = (ROLE.isManagement(window.currentRole));
  var th = document.getElementById('inv_reno_score_th');
  if(th) th.style.display = showRenoCol ? '' : 'none';
  // Render the Vacant Lots panel (separate from the buildings table).
  if(typeof _renderLotsList === 'function') _renderLotsList();
  // The buildings table excludes lot records (record_type:'lot').
  var units = getAllUnits().slice().filter(function(u){ return !(typeof _isLot==='function' && _isLot(u)); });
  var search = (document.getElementById('inv_search')||{}).value||'';
  var _searchLc = (search || '').toLowerCase().trim();
  // Pre-filter (search bar only — every other filter is now in the column-
  // menu popovers via tableApplyFilterSort below). Archived units stay
  // hidden by default; users can re-include them via the Status column
  // menu (or — once we add an "Include archived" toggle).
  var filtered = units.filter(function(u){
    if(u.archived) return false;
    if(_searchLc) {
      // Scan every visible column: address, status, type, beds, tenant name.
      var hay = [
        u.num, u.street, u.status, u.type, u.bedrooms,
        u.assignedName, u.funder, u.foundation,
        (u.accessible ? 'accessible' : ''),
        (u.isElders ? 'elders' : ''),
        (u.monthlyRent != null ? String(u.monthlyRent) : '')
      ].filter(Boolean).join(' ').toLowerCase();
      if (hay.indexOf(_searchLc) === -1) return false;
    }
    return true;
  });

  var vacantCount = units.filter(function(u){return u.status==='vacant' && !u.archived;}).length;
  var el = document.getElementById('inv_count'); if(el) el.textContent = units.filter(function(u){return !u.archived;}).length;
  var ve = document.getElementById('inv_vacant_count'); if(ve) ve.textContent = vacantCount+' vacant';

  var _invMode = _viewMode('inventory');
  var toggleEl = document.getElementById('inv_view_toggle');
  if (toggleEl) toggleEl.innerHTML = _viewToggleHtml('inventory', '_invSetView');
  var tableWrapEl = document.getElementById('inv_table_wrap');
  var cardsEl     = document.getElementById('inv_cards');
  if (tableWrapEl) tableWrapEl.style.display = (_invMode === 'cards') ? 'none' : '';
  if (cardsEl)     cardsEl.style.display     = (_invMode === 'cards') ? '' : 'none';

  var tbody = document.getElementById('inv_tbody');
  if(!tbody) return;
  if(!filtered.length){
    var _emptyHtml = '<tr><td colspan="11" style="padding:32px;text-align:center;color:var(--muted);">No units match the current filters.</td></tr>';
    if (_invMode === 'cards') { if (cardsEl) cardsEl.innerHTML = '<div class="card" style="text-align:center;padding:40px;color:var(--muted);">No units match the current filters.</div>'; }
    else tbody.innerHTML = _emptyHtml;
    return;
  }

  var statusStyle = {
    vacant:      {bg:'var(--success-bg)',c:'var(--success)',label:'Vacant'},
    occupied:    {bg:'var(--info-blue-bg)',c:'#1d4ed8',label:'Occupied'},
    under_repair:{bg:'var(--warn-amber-bg)',c:'var(--warn-amber-text)',label:'Vacant'},
    reserved:    {bg:'#faf5ff',c:'#7c3aed',label:'Reserved'},
    new_construction: {bg:'var(--info-blue-bg)',c:'var(--info-blue)',label:'New Construction'},
    condemned:   {bg:'var(--danger-bg)',c:'var(--danger)',label:'Condemned'},
    archived:    {bg:'#f4f4f0',c:'var(--gray)',   label:'Archived'}
  };

  // ── Column-menu sort + filter via the shared scaffolding (Phase 2A) ────
  // Each accessor defines how a column reads from a unit row, plus a
  // user-facing label and whether the column is worth showing a value
  // checklist for (Address/Reno Score skip the checklist — too many uniques).
  // Every column is filterable — even Address and Reno Score. The popover's
  // search box makes long value lists manageable.
  var _invColumns = {
    addr:        { label: 'Address',       accessor: function(u){ return ((u.num||'') + ' ' + (u.street||'')).trim(); } },
    bedrooms:    { label: 'Beds',          accessor: function(u){ return parseInt(u.bedrooms, 10) || 0; } },
    bathrooms:   { label: 'Baths',         accessor: function(u){ return parseInt(u.bathrooms, 10) || 0; } },
    type:        { label: 'Type',          accessor: function(u){ return _fmtUnitType(u.type) || '(none)'; } },
    foundation:  { label: 'Foundation',    accessor: function(u){ return (u.foundation && u.foundation !== '0' && u.foundation !== 'nan') ? u.foundation : '(none)'; } },
    accessible:  { label: 'Accessibility', accessor: function(u){ return u.accessible ? 'Accessible' : 'Non-accessible'; } },
    funder:      { label: 'Funder',        accessor: function(u){ return _fmtFunder(u.funder) || '(none)'; } },
    status:      { label: 'Status',        accessor: function(u){ return (statusStyle[u.status]||{}).label || u.status || 'Unknown'; } },
    rent:        { label: 'Rent',          accessor: function(u){ return (u.monthlyRent != null && u.monthlyRent !== '') ? Number(u.monthlyRent) : -1; } },
    reno_score:  { label: 'Reno Score',    accessor: function(u){ try { return calcRenoScore(u.id).score; } catch(e){ return 0; } } }
  };
  // Build a plain accessor map for tableApplyFilterSort.
  var _invAccessors = {};
  Object.keys(_invColumns).forEach(function(k){ _invAccessors[k] = _invColumns[k].accessor; });

  var _invState = (typeof tableStateGet === 'function') ? tableStateGet('inventory') : { sort:{key:'',dir:1}, filters:{} };

  // Register the columns + a getter for the pre-sort row source so the
  // column menu can compute uniques + counts on demand.
  if (typeof tableRegisterColumns === 'function') {
    tableRegisterColumns('inventory', {
      columns:  _invColumns,
      getRows:  function(){ return filtered; },
      onChange: renderInventoryView
    });
  }

  // Apply per-column filters + sort → flat list.
  var _invRows = (typeof tableApplyFilterSort === 'function')
    ? tableApplyFilterSort(filtered, _invAccessors, _invState)
    : filtered;

  // ─────────────────────────────────────────────────────────────────────
  function _invRowHtml(u){
    var ss = statusStyle[u.status]||{bg:'#f0f0ec',c:'var(--gray)',label:u.status||'Unknown'};
    var addr = u.num+' '+u.street;
    var bath = (u.bathrooms&&u.bathrooms!=='0'&&u.bathrooms!=='nan') ? u.bathrooms : '—';
    var fnd  = (u.foundation&&u.foundation!=='nan'&&u.foundation!=='0') ? u.foundation : '—';
    var type = _fmtUnitType(u.type) || '—';
    var funder = _fmtFunder(u.funder)||'—';
    var uid = u.id.replace(/'/g,"\\'");
    return '<tr style="border-bottom:1px solid var(--border);transition:background .12s;" onmouseover="this.style.background=\'var(--bg)\'" onmouseout="this.style.background=\'\'">'
      +'<td style="padding:9px 14px;font-size:13px;font-weight:600;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" onclick="openUnitEditModal(\''+uid+'\')">'+'<span style="text-decoration:underline;text-decoration-color:var(--border);text-underline-offset:2px;">'+addr+'</span>'
      +(u.isElders?' <span style="font-size:9px;background:var(--warn-amber-bg);color:var(--warn-amber);border:1px solid var(--warn-amber-border);padding:1px 5px;border-radius:6px;">ELDERS UNIT</span>':'')
      +' '+_assignmentTypeBadge(u)
      +'</td>'
      +'<td style="padding:9px 10px;text-align:center;font-size:13px;font-weight:700;color:var(--text);">'+u.bedrooms+'</td>'
      +'<td style="padding:9px 10px;text-align:center;font-size:12px;color:var(--muted);">'+bath+'</td>'
      +'<td style="padding:9px 10px;font-size:12px;color:var(--muted);text-transform:capitalize;">'+type+'</td>'
      +'<td class="col-hide-tablet" style="padding:9px 10px;font-size:12px;color:var(--muted);text-transform:capitalize;">'+fnd+'</td>'
      +'<td style="padding:9px 10px;text-align:center;font-size:14px;">'+(u.accessible?'<span title="Accessible">♿</span>':'<span style="color:var(--border);">—</span>')+'</td>'
      +'<td class="col-hide-tablet" style="padding:9px 10px;font-size:12px;color:var(--muted);">'+funder+'</td>'
      +'<td style="padding:9px 14px;"><span style="font-size:11px;font-weight:700;padding:3px 10px;border-radius:10px;background:'+ss.bg+';color:'+ss.c+';">'+ss.label+'</span>'
      +(u.under_renovation?' <span style="font-size:10px;font-weight:700;padding:2px 7px;border-radius:8px;background:var(--warn-amber-bg);color:var(--warn-amber-text);margin-left:4px;">🔨 Reno</span>':'')
      +(u.assignedName?' <span class="js-lbl-sm">→ '+u.assignedName+'</span>':'')+'</td>'
      +(function(){
        var r = (u.monthlyRent != null && u.monthlyRent !== '') ? Number(u.monthlyRent) : null;
        return '<td class="col-hide-tablet" style="padding:9px 10px;text-align:right;font-size:13px;font-weight:600;color:var(--text);">'
          + (r != null ? '$' + r.toFixed(2) : '<span style="color:var(--border);">—</span>')
          + '</td>';
      })()
      +(ROLE.isManagement(window.currentRole) ? (function(){
        var _hasSow = !!getSowData(u.id);
        var _hasProg = !!(window._renoProgress && window._renoProgress[u.id]);
        if(_hasSow||_hasProg){
          var _rs=calcRenoScore(u.id); var _sc=_rs.score;
          var _tier=_sc>=40?{label:'Critical',c:'var(--danger)',bg:'var(--danger-bg)'}:_sc>=25?{label:'High',c:'#7a6000',bg:'#fef9ec'}:_sc>=12?{label:'Medium',c:'#1d4ed8',bg:'var(--info-blue-bg)'}:{label:'Low',c:'var(--success)',bg:'var(--success-bg)'};
          return '<td style="padding:9px 10px;">'
            +'<div data-inv-reno-sow="'+uid+'" style="display:flex;align-items:center;gap:5px;cursor:pointer;" title="Open Maintenance Request">'
            +'<span style="font-size:14px;font-weight:800;color:var(--text);">'+_sc+'</span>'
            +'<span style="font-size:10px;font-weight:700;padding:2px 7px;border-radius:8px;background:'+_tier.bg+';color:'+_tier.c+';">'+_tier.label+'</span>'
            +'</div></td>';
        }
        return '<td style="padding:9px 10px;"><span style="font-size:11px;color:var(--border);">—</span></td>';
      })() : '')
      +'<td style="padding:9px 10px;text-align:center;width:1%;white-space:nowrap;">'
      +'<div style="display:flex;align-items:center;justify-content:center;gap:6px;">'
      +'<button type="button" onclick="event.stopPropagation();openSowModal(\''+uid+'\')" title="Maintenance Request" style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:14px;padding:4px;">🔨</button>'
      +'<button type="button" onclick="event.stopPropagation();openUnitEditModal(\''+uid+'\')" title="Edit unit" style="background:none;border:1px solid var(--border);color:var(--muted);border-radius:6px;padding:4px 8px;cursor:pointer;font-size:12px;transition:all .15s;" onmouseover="this.style.borderColor=\'var(--yellow)\';this.style.color=\'var(--yellow)\'" onmouseout="this.style.borderColor=\'var(--border)\';this.style.color=\'var(--muted)\'">'
      +'<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>'
      +'</button>'
      +'</div>'
      +'</td>'
      +'</tr>';
  }

  // Card renderer — same statusStyle/uid/badge logic as the table row, laid
  // out as a _cardTile instead of a <tr>.
  function _invCardHtml(u){
    var ss = statusStyle[u.status]||{bg:'#f0f0ec',c:'var(--gray)',label:u.status||'Unknown'};
    var addr = u.num+' '+u.street;
    var bath = (u.bathrooms&&u.bathrooms!=='0'&&u.bathrooms!=='nan') ? u.bathrooms : '';
    var uid = u.id.replace(/'/g,"\\'");
    var badges = [];
    if(u.isElders) badges.push('<span style="font-size:9px;background:var(--warn-amber-bg);color:var(--warn-amber);border:1px solid var(--warn-amber-border);padding:1px 5px;border-radius:6px;">ELDERS UNIT</span>');
    if(_assignmentTypeBadge(u)) badges.push(_assignmentTypeBadge(u));
    if(u.under_renovation) badges.push('<span style="font-size:10px;font-weight:700;padding:2px 7px;border-radius:8px;background:var(--warn-amber-bg);color:var(--warn-amber-text);">🔨 Reno</span>');
    var r = (u.monthlyRent != null && u.monthlyRent !== '') ? Number(u.monthlyRent) : null;
    var metas = [
      {k:'Beds / Baths', v: u.bedrooms + ' bd' + (bath ? ' · ' + bath + ' ba' : '')},
      {k:'Type',   v: _fmtUnitType(u.type) || '—'},
      {k:'Funder', v: _fmtFunder(u.funder) || '—'},
      {k:'Rent',   v: r != null ? '$'+r.toFixed(2) : '—'},
      {k:'Tenant', v: u.assignedName || ''}
    ];
    if (ROLE.isManagement(window.currentRole)) {
      var _hasSow = !!getSowData(u.id);
      var _hasProg = !!(window._renoProgress && window._renoProgress[u.id]);
      if (_hasSow || _hasProg) metas.push({k:'Reno Score', v: calcRenoScore(u.id).score});
    }
    return _cardTile({
      title: addr,
      pill: {text: ss.label, bg: ss.bg, color: ss.c},
      badges: badges,
      metas: metas,
      open: "openUnitEditModal('"+uid+"')",
      actions: [
        {text:'🔨 Maintenance', onclick:"event.stopPropagation();openSowModal('"+uid+"')", ghost:true},
        {text:'✏️ Edit', onclick:"event.stopPropagation();openUnitEditModal('"+uid+"')"}
      ]
    });
  }

  if (_invMode === 'cards') {
    if (cardsEl) cardsEl.innerHTML = _cardGrid(_invRows.map(_invCardHtml).join(''));
    if (cardsEl) cardsEl.querySelectorAll('[data-inv-reno-sow]').forEach(function(cell){
      cell.addEventListener('click', function(e){ e.stopPropagation(); openSowModal(cell.getAttribute('data-inv-reno-sow')); });
    });
    // Column-menu registration still needs to happen so the popovers (opened
    // from the table header) reflect the current filtered set once the user
    // switches back to List — but there's no header to bind clicks to here.
    return;
  }

  // Empty-state path
  if (!_invRows.length) {
    tbody.innerHTML = '<tr><td colspan="11" style="padding:32px;text-align:center;color:var(--muted);">No units match the current filters.</td></tr>';
  } else {
    tbody.innerHTML = _invRows.map(_invRowHtml).join('');
  }

  // Wire column-menu click + sort indicators on the table header.
  var thead = document.getElementById('inv_thead');
  if (typeof tableBindColumnMenuClicks === 'function') tableBindColumnMenuClicks(thead, 'inventory');
  if (typeof tableRefreshSortIndicators === 'function') tableRefreshSortIndicators(thead, 'inventory');

  // Wire action buttons
  tbody.querySelectorAll('[data-inv-reno-sow]').forEach(function(cell){
    cell.addEventListener('click', function(e){ e.stopPropagation(); openSowModal(cell.getAttribute('data-inv-reno-sow')); });
  });
  tbody.querySelectorAll('[data-sow-uid]').forEach(function(btn){
    btn.addEventListener('click', function(e){ e.stopPropagation(); openSowModal(btn.getAttribute('data-sow-uid')); });
  });
  tbody.querySelectorAll('[data-uid]').forEach(function(row){
    row.addEventListener('click', function(){ openUnitEditModal(row.getAttribute('data-uid')); });
  });
}
window._invSetView = function(v){
  try { localStorage.setItem('clfn_inventory_view', v === 'cards' ? 'cards' : 'list'); } catch(e){}
  renderInventoryView();
};

// ── Unit Edit Modal ──────────────────────────────────────

function renderMatchView(){
  // Scroll-collapse: shrink the page header to a compact title bar once the
  // list scrolls, freeing space on tablet/mobile (shared-ui.js). Idempotent —
  // safe to call on every render.
  (function(){
    var _hdr = document.querySelector('#matchView .page-header-bar');
    var _area = document.querySelector('.content-area');
    if (_hdr && _area && typeof _initScrollCollapse === 'function') _initScrollCollapse(_area, _hdr);
  })();
  var allApps = (typeof applications !== 'undefined' ? applications : []);
  var allUnits = getAllUnits();

  // Tenancy is authoritative on the UNIT (housing_units.assigned_name) and is
  // NOT reliably synced back onto the application record: assignedUnit/status
  // are only written when a unit is assigned to a tenant whose assignedTo ===
  // the application id (see housing-modals.js saveUnitEdit). So an applicant can
  // be housed in reality while their application still looks unassigned --
  // backfilled/legacy tenants, names typed directly, existing-tenant
  // assignments, or a duplicate approved app. Map current tenancy (unit address)
  // by linked app-id and by tenant name so the Match view can both flag housed
  // applicants and decide who genuinely belongs in the queue.
  var _mNorm = function(s){ return (s||'').toString().toLowerCase().replace(/\s+/g,' ').trim(); };
  var _housedAddrByAppId = {};
  var _housedAddrByName  = {};
  allUnits.forEach(function(u){
    if(u.archived) return;
    var occupied = u.status==='occupied' || u.status==='reserved' || !!u.assignedName;
    if(!occupied) return;
    var addr = ((u.num||'') + ' ' + (u.street||'')).trim();
    if(u.assignedTo)   _housedAddrByAppId[u.assignedTo] = addr;
    if(u.assignedName) _housedAddrByName[_mNorm(u.assignedName)] = addr;
  });
  // Address of the applicant's CURRENT home, when housed via a unit that is not
  // this application's own assignment (i.e. a real, separate tenancy). '' = not
  // currently housed elsewhere. Used to flag transfer/upgrade applicants.
  function _currentTenancyAddr(a){
    return _housedAddrByAppId[a.id]
        || _housedAddrByName[_mNorm((a.fn||'')+' '+(a.ln||''))]
        || '';
  }

  // Search-bar pre-filter. All other filtering happens via the column-menu
  // popovers (see tableApplyFilterSort below).
  var search = (document.getElementById('match_search')||{}).value||'';
  var _searchLc = (search || '').toLowerCase().trim();
  // Structural eligibility — everyone who could ever appear on Match,
  // regardless of the search box or column-menu filters. Kept separate from
  // the text-search filter below because the exclusive per-unit allocation
  // (_priorityOrder / _matchAllocation further down) must run over the FULL
  // eligible pool: if it ran over the search-narrowed list instead, typing a
  // search query would silently remove someone's competitors and could hand
  // the searched-for applicant a unit they wouldn't actually be entitled to
  // once everyone else is back in the running.
  var eligibleApps = allApps.filter(function(a){
    if(a.archived) return false;
    // Deceased applicants never rank or match (score is zeroed too).
    if(a.deceased) return false;
    // Existing-tenant FILE UPDATES are record updates, not housing requests, and
    // are never scored/ranked -> they must never appear on Match, regardless of
    // unit or status.
    if(a.appType === 'existing_tenant') return false;
    if(a.status===APP_STATUS.DRAFT||a.status===APP_STATUS.ARCHIVED||a.status===APP_STATUS.FILE_UPDATE) return false;
    // This application already resulted in a placement -> it's done, not a
    // pending match.
    if(a.status==='assigned' || !!a.assignedUnit) return false;
    // Match shows only applications that have cleared approval and are awaiting
    // placement. Not-yet-approved (submitted / Pending HM), returned, and
    // declined applications are hidden from the queue. The approval rule is the
    // shared appIsAssignable() so Match, confirmAssignment, the unit-edit gate,
    // and the Add-Tenant modal stay in lockstep.
    if(typeof appIsAssignable === 'function'){
      if(!appIsAssignable(a)) return false;
    } else if(a.status!==APP_STATUS.MGR_APPROVED
       && a.status!==APP_STATUS.HM_APPROVED
       && a.status!==APP_STATUS.ED_APPROVED) return false;
    // The Application Type decides who gets matched. Two of the three types are
    // SCORED + RANKED and so belong on Match:
    //   new_housing      - applicant seeking a new unit
    //   transfer_request - current tenant applying for a different unit
    // (existing_tenant "file update" is NOT scored and is excluded above by the
    // file_update status.) A scored applicant who is currently housed (a
    // transfer) stays in the queue and is flagged with the "On Rez" identifier
    // in the row. A housed person surfacing via any OTHER, non-scored record
    // (e.g. a stale existing-tenant anomaly) is suppressed -- they already have
    // a home and aren't being ranked.
    var _scored = (a.appType === 'new_housing' || a.appType === 'transfer_request');
    if(_currentTenancyAddr(a) && !_scored) return false;
    return true;
  });
  // Text search narrows what's DISPLAYED only — never who competes for units.
  var filtered = _searchLc ? eligibleApps.filter(function(a){
    var hay = [
      a.fn, a.ln, a.id, a.tier, a.status, a.reserve,
      a.score, a.classification, a.assignedAddress
    ].filter(function(v){ return v != null; }).join(' ').toLowerCase();
    return hay.indexOf(_searchLc) !== -1;
  }) : eligibleApps;

  var content = document.getElementById('match_content');
  if(!content) return;

  // For each applicant find their best matching vacant unit. Scoring itself
  // lives in the shared matchBestUnit() (shared-data.js) so the Match page
  // and the worklist's Ready to Match section score/filter applicants
  // against real inventory identically — see that function's comment for
  // the bedroom-fit/accessibility/Elders rules.
  var _eldersMin = (window._appSettings && window._appSettings.eldersAgeMin) || 65;
  function bestUnit(app){
    return (typeof matchBestUnit === 'function') ? matchBestUnit(app) : null;
  }

  var tierColor = {
    'Critical Priority': 'var(--success)',
    'High Priority':   '#1d4ed8',
    'Medium Priority': 'var(--warn-amber-text)',
    'Low Priority':    '#6b7280'
  };
  // Status wording comes from the shared 'match' variant of
  // formatAppStatusLabel (shared-data.js) — raw-status fallback preserved.

  // ── Column-menu sort + filter via the shared scaffolding (Phase 2B) ────
  function _bestUnitAddr(app){
    var b = _allocatedUnit(app);
    return b && b.unit ? (b.unit.num + ' ' + b.unit.street) : '';
  }
  // Placement order — combines "has a matching unit" + that unit's
  // Assignment Type + reserve status + current-house status (see
  // liveMatchPriorityModel, scoring.js) on top of the raw score, so who gets
  // matched first is a distinct, ED-adjustable decision from need/urgency.
  // Ranked highest bonus to lowest:
  //   1. Has a suitable vacant unit at all (bestUnit() != null) — an
  //      applicant nobody can place today shouldn't sit at the top of the
  //      queue ahead of someone who can be placed right now.
  //   2. Best-matching unit is a Temporary (urgent/emergency) unit — jumps
  //      the queue outright, stacking on top of the tier below.
  //   3. On-Reserve+NoHouse > Off-Reserve+NoHouse > On-Reserve+HasHouse >
  //      Off-Reserve+HasHouse — house status dominates, reserve status is
  //      the secondary tiebreak, so an off-reserve applicant with no house
  //      outranks an on-reserve applicant who already has one. If the
  //      best-matching unit is a Transition unit (demonstrating the tenant
  //      can care for a unit — lower urgency), the applicant's real reserve/
  //      house status is ignored and they're scored at the bottom of this
  //      tier (as if off-reserve with a house) regardless of their own status.
  // Within any tier, score still wins since every bonus dwarfs the
  // ~100-point max application score.
  // Memoized per render — the shared matchPriorityOf() walks the whole unit
  // list (matchBestUnit) per call, and this used to be invoked inside the sort
  // comparator (O(n log n) full-inventory scans) plus once more per row for
  // the sortable column accessor. The memo lives in this render's closure, so
  // any data change that triggers a re-render naturally rebuilds it.
  var _mpMemo = {};
  function _matchPriorityOf(a){
    var k = a && a.id;
    if (k && Object.prototype.hasOwnProperty.call(_mpMemo, k)) return _mpMemo[k];
    // Delegates to the shared matchPriorityOf() (shared-data.js) so this page
    // and the worklist's Ready to Match section rank applicants — and
    // therefore allocate units — in the same order. Passes the fuller,
    // cross-referenced current-tenancy check as hasHouse since this page (and
    // only this page) has already resolved it via _currentTenancyAddr.
    var v = (typeof matchPriorityOf === 'function')
      ? matchPriorityOf(a, { hasHouse: !!(a.assignedUnit || a.appType==='transfer_request' || _currentTenancyAddr(a)) })
      : (a.score || 0);
    if (k) _mpMemo[k] = v;
    return v;
  }

  // Exclusive per-unit allocation for DISPLAY (Best Unit cell, Assign button
  // default, and the Best Unit sortable column) — bestUnit()/_matchPriorityOf
  // above stay non-exclusive on purpose: an applicant either has an eligible
  // unit *category* or doesn't, independent of anyone else, so ranking never
  // depends on allocation order (which would be circular). This second pass
  // walks applicants in canonical Match Priority order and greedily claims
  // each one's best still-unclaimed vacant unit (shared-data.js), so two rows
  // never both show the same still-vacant unit as their recommendation — the
  // lower-priority applicant shows Unmatched instead. Computed over the full
  // structurally-eligible pool (eligibleApps — before search text or column-
  // menu filters narrow what's displayed) in Match Priority order, so who
  // "wins" a unit never changes just because the table is searched, filtered,
  // or re-sorted to a different column.
  var _priorityOrder = eligibleApps.slice().sort(function(a, b){ return _matchPriorityOf(b) - _matchPriorityOf(a); });
  var _matchAllocation = (typeof matchAllocateExclusive === 'function') ? matchAllocateExclusive(_priorityOrder) : {};
  function _allocatedUnit(app){ return _matchAllocation[app.id] || null; }

  var _matchColumns = {
    applicant:     { label: 'Applicant',      accessor: function(a){ return ((a.fn||'') + ' ' + (a.ln||'')).trim(); } },
    score:         { label: 'Score',          accessor: function(a){ return a.score || 0; } },
    tier:          { label: 'Tier',           accessor: function(a){ return (a.tier || 'Low Priority').replace(' Priority',''); } },
    reserve:       { label: 'Reserve',        accessor: function(a){ return a.reserve || '(none)'; } },
    bestUnit:      { label: 'Best Unit',      accessor: function(a){ return _bestUnitAddr(a) || '(unmatched)'; } },
    status:        { label: 'Status',         accessor: function(a){ return formatAppStatusLabel(a.status, {variant:'match'}) || a.status || 'Unknown'; } },
    hasHouse:      { label: 'Has House',      accessor: function(a){ return (a.assignedUnit || a.appType==='transfer_request' || _currentTenancyAddr(a)) ? 1 : 0; } },
    matchPriority: { label: 'Match Priority', accessor: _matchPriorityOf },
    action:        { label: 'Action',         accessor: function(a){ var ready = !a.assignedUnit && (a.status==='ed_approved'||a.status==='mgr_approved'||a.status==='hm_approved'); return ready ? 1000 + (a.score||0) : (a.score||0); } }
  };
  var _matchAccessors = {};
  Object.keys(_matchColumns).forEach(function(k){ _matchAccessors[k] = _matchColumns[k].accessor; });

  var _matchState = (typeof tableStateGet === 'function') ? tableStateGet('match') : { sort:{key:'matchPriority',dir:-1}, filters:{} };
  if (_matchState.sort && (!_matchState.sort.key || _matchState.sort.key === 'action')) _matchState.sort = { key: 'matchPriority', dir: -1 };

  if (typeof tableRegisterColumns === 'function') {
    tableRegisterColumns('match', {
      columns:  _matchColumns,
      getRows:  function(){ return filtered; },
      onChange: renderMatchView
    });
  }

  var _matchRows = (typeof tableApplyFilterSort === 'function')
    ? tableApplyFilterSort(filtered, _matchAccessors, _matchState)
    : filtered.slice().sort(function(a,b){ return (b.score||0)-(a.score||0); });

  var _matchMode = _viewMode('match');
  var _matchToggleHtml = _viewToggleHtml('match', '_matchSetView');

  if(!_matchRows.length){
    content.innerHTML = _matchToggleHtml + '<div class="card" style="text-align:center;padding:40px;color:var(--muted);">No applicants match the current filters.</div>';
    return;
  }

  // Delete (archive) gate — controlled by the deleteApplication approval
  // authority (Settings > Approval Authority > Housing Application). Default ED.
  var _canDeleteApp = (typeof APPROVAL_AUTHORITY !== 'undefined')
    && APPROVAL_AUTHORITY.can('deleteApplication', window.currentRole);
  function _matchDelBtn(appId, block){
    if(!_canDeleteApp) return '';
    return '<button data-del-app="'+appId+'" title="Delete (archive) application"'
      + (block ? ' style="background:transparent;border:1px solid var(--danger);color:var(--danger);padding:8px 12px;border-radius:7px;cursor:pointer;font-size:12px;font-weight:700;font-family:DM Sans,sans-serif;white-space:nowrap;"'
               : ' style="background:transparent;border:1px solid var(--border);color:var(--danger);padding:6px 9px;border-radius:7px;cursor:pointer;font-size:12px;font-weight:700;line-height:1;"')
      + '>🗑</button>';
  }

  var rows = _matchRows.map(function(app, i){
    var best = _allocatedUnit(app);
    // Escaped at source — applicant names/addresses can originate from the
    // public portal, and this row HTML is built by string concatenation.
    var name = escapeHtml(((app.fn||'')+' '+(app.ln||'')).trim());
    var curAddr = escapeHtml(_currentTenancyAddr(app) || '');   // current home address, if resolvable
    var isTransfer = (app.appType === 'transfer_request') || !!curAddr;  // current tenant moving
    var tCol = tierColor[app.tier] || '#6b7280';
    var tier = (app.tier||'Low Priority').replace(' Priority','');
    var needsBeds = 1;
    if(app.habitants) needsBeds = Math.max(1, 1+(app.coApp?1:0)+app.habitants.length);
    var needsAccess = app.accessibility && app.accessibility!=='None' && app.accessibility!=='0' && app.accessibility!==0;

    var matchPct = best ? Math.round(Math.max(0,best.score)/24*100) : 0;
    var unitCell = best
      ? '<div onclick="openMatchScorecard(\''+app.id+'\',\''+best.unit.id+'\')" style="cursor:pointer;">'
        +'<div style="font-weight:600;font-size:13px;color:var(--text);text-decoration:underline;text-underline-offset:2px;">'+(best.unit.num+' '+best.unit.street)+'</div>'
        +'<div style="display:flex;align-items:center;gap:8px;margin:3px 0;">'
        +'<div style="height:4px;width:80px;background:var(--border);border-radius:3px;overflow:hidden;"><div style="height:100%;width:'+matchPct+'%;background:'+tCol+';border-radius:3px;"></div></div>'
        +'<span class="js-lbl-sm">'+matchPct+'% match</span>'
        +'</div>'
        +'<div class="js-lbl-sm">'+_roomBedLabel(best.unit)+' · '+(_fmtUnitType(best.unit.type)||'—')+'</div>'
        +'</div>'
      : '<span class="js-txt-muted-sm">Unmatched</span>';

    var reqs = [];
    if(needsAccess) reqs.push('<span style="font-size:10px;color:var(--info-blue);">Needs accessible unit</span>');
    var age = app.dob ? Math.floor((new Date()-new Date(app.dob))/(365.25*24*3600*1000)) : 0;
    if(age>=_eldersMin) reqs.push('<span style="font-size:10px;color:var(--warn-amber);">Elders eligible</span>');

    var sl = formatAppStatusLabel(app.status, {variant:'match'}) || app.status || '';
    var appDateStr = app.appDate ? 'Applied '+app.appDate : '';

    // "Has a unit" is the source of truth — an app with an assignedUnit is
    // housed regardless of stored status. Conversely, anything WITHOUT a unit
    // that has cleared approval (mgr/ed/hm) — or is marked 'assigned' due to
    // a data anomaly — gets the Assign button so a unit can be attached.
    var hasUnit    = !!app.assignedUnit;
    var hasHouseReal = hasUnit || isTransfer;   // real tenancy, incl. transfer applicants
    var isAssigned = hasUnit;
    var canAssign  = !hasUnit && (
                       app.status === APP_STATUS.ED_APPROVED ||
                       app.status === APP_STATUS.MGR_APPROVED ||
                       app.status === APP_STATUS.HM_APPROVED ||
                       app.status === 'assigned'
                     );
    var assignCell = isAssigned
      ? '<div style="font-size:11px;font-weight:700;color:var(--success);">✓ '+(app.assignedAddress||'Assigned')+'</div>'
      : (canAssign
          ? '<button data-assign-app="'+app.id+'" data-assign-unit="'+(best?best.unit.id:'')+'" style="background:var(--yellow);border:none;color:var(--dark);padding:6px 14px;border-radius:7px;cursor:pointer;font-size:12px;font-weight:700;font-family:DM Sans,sans-serif;white-space:nowrap;">Assign →</button>'
          : '<span class="js-lbl-sm">Awaiting approval</span>');

    return '<tr style="border-bottom:1px solid var(--border);transition:background .12s;">'
      +'<td style="padding:12px 14px;color:var(--muted);font-size:12px;font-weight:600;width:32px;">'+(i+1)+'</td>'
      +'<td style="padding:12px 10px;cursor:pointer;" onclick="openAppFromMatch(\''+app.id+'\');">'
        +'<div style="font-weight:700;font-size:13px;color:var(--text);text-decoration:underline;text-underline-offset:2px;">'+name+'</div>'
        +'<div class="js-lbl-sm">'+app.id+'</div>'
        +(isTransfer?'<div style="margin-top:4px;"><span style="display:inline-block;font-size:10px;font-weight:700;background:var(--warn-amber);color:#111;padding:1px 7px;border-radius:4px;white-space:nowrap;">🏠 On Rez'+(curAddr?' · '+curAddr:'')+'</span> <span style="font-size:10px;color:var(--muted);font-weight:600;">transfer</span></div>':'')
        +(!isTransfer && _livingSituationBadge(app) ? '<div style="margin-top:4px;">'+_livingSituationBadge(app)+'</div>' : '')
        +(_bcrIneligibleBadge(app) ? '<div style="margin-top:4px;">'+_bcrIneligibleBadge(app)+'</div>' : '')
        +(_arrearsWarnBadge(app) ? '<div style="margin-top:4px;">'+_arrearsWarnBadge(app)+'</div>' : '')
      +'</td>'
      +'<td style="padding:12px 10px;white-space:nowrap;font-size:18px;font-weight:800;color:'+tCol+';">'+(app.score||0)+'</td>'
      +'<td style="padding:12px 10px;white-space:nowrap;font-size:11px;font-weight:700;color:'+tCol+';">'+tier+'</td>'
      +'<td style="padding:12px 10px;white-space:nowrap;font-size:12px;color:var(--muted);">'+(app.reserve||'—')+'</td>'
      +'<td style="padding:12px 10px;max-width:180px;">'+unitCell+'</td>'
      +'<td style="padding:12px 14px;">'
        +'<div style="font-size:12px;font-weight:700;color:'+tCol+';">'+sl+'</div>'
        +(appDateStr?'<div style="font-size:11px;color:var(--muted);margin-top:2px;">'+appDateStr+'</div>':'')
        +(reqs.length?'<div style="margin-top:3px;">'+reqs.join(' ')+'</div>':'')
      +'</td>'
      +'<td style="padding:12px 14px;white-space:nowrap;">'
        +(hasHouseReal
          ? '<span style="font-size:12px;font-weight:700;color:var(--success);">Yes</span>'+(curAddr?'<div class="js-lbl-sm">'+curAddr+'</div>':'')
          : '<span style="font-size:12px;color:var(--muted);">No</span>')
      +'</td>'
      +'<td style="padding:12px 14px;white-space:nowrap;"><div style="display:flex;align-items:center;gap:8px;">'+assignCell+_matchDelBtn(app.id,false)+'</div></td>'
      +'</tr>';
  }).join('');

  // Card renderer — same per-applicant computation as the table row, laid
  // out as a _cardTile. The Assign button uses the same data-assign-app/
  // data-assign-unit + addEventListener wiring as the table (below) rather
  // than an inline onclick, so both views share one wiring path.
  function _matchCardHtml(app, i){
    var best = _allocatedUnit(app);
    var name = escapeHtml(((app.fn||'')+' '+(app.ln||'')).trim());
    var curAddr = escapeHtml(_currentTenancyAddr(app) || '');
    var isTransfer = (app.appType === 'transfer_request') || !!curAddr;
    var tCol = tierColor[app.tier] || '#6b7280';
    var tier = (app.tier||'Low Priority').replace(' Priority','');
    var matchPct = best ? Math.round(Math.max(0,best.score)/24*100) : 0;
    var sl = formatAppStatusLabel(app.status, {variant:'match'}) || app.status || '';
    var hasUnit = !!app.assignedUnit;
    var hasHouseReal = hasUnit || isTransfer;
    var canAssign = !hasUnit && (
      app.status === APP_STATUS.ED_APPROVED ||
      app.status === APP_STATUS.MGR_APPROVED ||
      app.status === APP_STATUS.HM_APPROVED ||
      app.status === 'assigned'
    );
    var badges = [];
    if (isTransfer) badges.push('<span style="display:inline-block;font-size:10px;font-weight:700;background:var(--warn-amber);color:#111;padding:1px 7px;border-radius:4px;white-space:nowrap;">🏠 On Rez'+(curAddr?' · '+curAddr:'')+'</span>');
    if (!isTransfer && _livingSituationBadge(app)) badges.push(_livingSituationBadge(app));
    if (_bcrIneligibleBadge(app)) badges.push(_bcrIneligibleBadge(app));
    if (_arrearsWarnBadge(app)) badges.push(_arrearsWarnBadge(app));
    var metas = [
      {k:'Score',     v: app.score||0},
      {k:'Reserve',   v: app.reserve||''},
      {k:'Best Unit', v: best ? (best.unit.num+' '+best.unit.street+' · '+matchPct+'% match') : 'Unmatched'},
      {k:'Status',    v: sl},
      {k:'Has House', v: hasHouseReal ? ('Yes'+(curAddr?' — '+curAddr:'')) : 'No'}
    ];
    var actions = [];
    if (hasUnit) {
      actions.push({html:'<div style="flex:1;text-align:center;font-size:11px;font-weight:700;color:var(--success);padding:8px 0;">✓ '+(app.assignedAddress||'Assigned')+'</div>'});
    } else if (canAssign) {
      actions.push({html:'<button type="button" data-assign-app="'+app.id+'" data-assign-unit="'+(best?best.unit.id:'')+'" style="flex:1;background:var(--yellow);border:none;color:var(--dark);padding:8px 10px;border-radius:7px;cursor:pointer;font-size:12px;font-weight:700;font-family:DM Sans,sans-serif;white-space:nowrap;">Assign →</button>'});
    }
    if (_canDeleteApp) actions.push({html: _matchDelBtn(app.id, true)});
    return _cardTile({
      title: name,
      pill: {text: tier, bg:'var(--bg)', color: tCol},
      badges: badges,
      metas: metas,
      open: "openAppFromMatch('"+app.id+"')",
      actions: actions
    });
  }

  if (_matchMode === 'cards') {
    content.innerHTML = _matchToggleHtml + _cardGrid(_matchRows.map(_matchCardHtml).join(''));
  } else {
    content.innerHTML = _matchToggleHtml + '<div class="std-table-card">'
      +'<div class="doclib-table-wrap">'
      +'<table class="std-table" style="min-width:650px;">'
      +'<thead id="match_thead"><tr>'
      +'<th>#</th>'
      +'<th class="std-th-sortable" data-sort-key="applicant">Applicant</th>'
      +'<th class="std-th-sortable" data-sort-key="score">Score</th>'
      +'<th class="std-th-sortable" data-sort-key="tier">Tier</th>'
      +'<th class="std-th-sortable" data-sort-key="reserve">Reserve</th>'
      +'<th class="std-th-sortable" data-sort-key="bestUnit">Best Unit Match</th>'
      +'<th class="std-th-sortable" data-sort-key="status">Status</th>'
      +'<th class="std-th-sortable" data-sort-key="hasHouse">Has House</th>'
      +'<th class="std-th-sortable" data-sort-key="action">Action</th>'
      +'</tr></thead>'
      +'<tbody id="match_tbody" data-table-page="match">'+rows+'</tbody>'
      +'</table></div></div>';
    // Wire column-menu click + sort indicators on the table header (list mode only).
    var matchThead = document.getElementById('match_thead');
    if (typeof tableBindColumnMenuClicks === 'function') tableBindColumnMenuClicks(matchThead, 'match');
    if (typeof tableRefreshSortIndicators === 'function') tableRefreshSortIndicators(matchThead, 'match');
  }
  // Wire assign buttons — shared by both views, since both render
  // [data-assign-app] buttons into the same #match_content mount.
  var matchContent = document.getElementById('match_content');
  if(matchContent) matchContent.querySelectorAll('[data-assign-app]').forEach(function(btn){
    btn.addEventListener('click', function(e){
      e.stopPropagation();
      openAssignModal(btn.getAttribute('data-assign-app'), btn.getAttribute('data-assign-unit'));
    });
  });
  // Wire delete (archive) buttons — shared by both views.
  if(matchContent) matchContent.querySelectorAll('[data-del-app]').forEach(function(btn){
    btn.addEventListener('click', function(e){
      e.stopPropagation();
      _matchDeleteApp(btn.getAttribute('data-del-app'));
    });
  });
}

// Delete (archive) an application from the Match list. Gated by the
// deleteApplication approval authority; soft-deletes via archiveApplication
// (record preserved + audited), then refreshes Match.
function _matchDeleteApp(appId){
  if(typeof APPROVAL_AUTHORITY !== 'undefined' && !APPROVAL_AUTHORITY.can('deleteApplication', window.currentRole)){
    if(typeof showToast === 'function') showToast('You are not authorized to delete applications.', {type:'info'});
    return;
  }
  var apps = (typeof applications !== 'undefined' && applications) ? applications : [];
  var app  = apps.find(function(a){ return a.id === appId; });
  var name = app ? (((app.fn||'')+' '+(app.ln||'')).trim() || appId) : appId;
  function doIt(){
    if(typeof archiveApplication === 'function') archiveApplication(appId);
    if(typeof renderMatchView === 'function') renderMatchView();
  }
  if(typeof showConfirm === 'function'){
    showConfirm({
      title:       'Delete application?',
      message:     'Remove <strong>'+escapeHtml(name)+'</strong> from the match list? The application is archived (hidden from active lists) and its record is preserved in the audit trail.',
      confirmText: 'Delete',
      danger:      true
    }).then(function(ok){ if(ok) doIt(); });
  } else if(window.confirm('Delete '+name+'?')){ doIt(); }
}
window._matchDeleteApp = _matchDeleteApp;
window._matchSetView = function(v){
  try { localStorage.setItem('clfn_match_view', v === 'cards' ? 'cards' : 'list'); } catch(e){}
  renderMatchView();
};
window._tenSetView = function(v){
  try { localStorage.setItem('clfn_tenants_view', v === 'cards' ? 'cards' : 'list'); } catch(e){}
  renderTenantsView();
};


function renderTenantsView(){
  // Scroll-collapse: shrink the page header to a compact title bar once the
  // list scrolls, freeing space on tablet/mobile (shared-ui.js). Idempotent —
  // safe to call on every render.
  (function(){
    var _hdr = document.querySelector('#tenantsView .page-header-bar');
    var _area = document.querySelector('.content-area');
    if (_hdr && _area && typeof _initScrollCollapse === 'function') _initScrollCollapse(_area, _hdr);
  })();
  var showRenoCol = (ROLE.isManagement(window.currentRole));
  var th = document.getElementById('ten_reno_score_th');
  if(th) th.style.display = showRenoCol ? '' : 'none';
  function hasSowOrReno(uid){
    try{
      var sow = getSowData(uid);
      var prog = (window._renoProgress && window._renoProgress[uid]) || null;
      return !!(sow&&sow!=='null') || !!(prog&&prog!=='null');
    }catch(e){return false;}
  }
  // Shallow copy of the live in-memory units (this render only reads unit
  // fields and re-orders the array — the old JSON.parse(JSON.stringify(...))
  // deep clone re-serialized every unit on every render for no benefit).
  var allUnits = (typeof housingUnits !== 'undefined' && housingUnits.length)
    ? housingUnits.slice()
    : getAllUnits();
  var units = allUnits.filter(function(u){return (u.status==='occupied'||u.status==='reserved') && !u.archived;});
  var search = ((document.getElementById('tenant_search')||{}).value||'').toLowerCase().trim();
  if(search) units = units.filter(function(u){
    // Scan every visible column on the Tenants row.
    var hay = [
      u.num, u.street, u.assignedName, u.assignedDate, u.status,
      u.bedrooms, u.type, u.classification
    ].filter(function(v){ return v != null; }).join(' ').toLowerCase();
    return hay.indexOf(search) !== -1;
  });
  setText('tenant_count',units.length);

  // Default sort — address ascending. Preserved when no column-menu sort
  // is active (tableApplyFilterSort leaves order alone when state.sort.key
  // is empty).
  units.sort(function(a,b){
    var av = ((a.num||'')+' '+(a.street||'')).toLowerCase();
    var bv = ((b.num||'')+' '+(b.street||'')).toLowerCase();
    return av < bv ? -1 : av > bv ? 1 : 0;
  });

  // ── Column-menu sort + filter (Phase 2B) ─────────────────────
  var _tenColumns = {
    address:    { label: 'Unit / Address', accessor: function(u){ return ((u.num||'')+' '+(u.street||'')).trim(); } },
    tenant:     { label: 'Tenant Name',    accessor: function(u){ return u.assignedName || '(unassigned)'; } },
    move_in:    { label: 'Move-In Date',   accessor: function(u){ return u.assignedDate || '(none)'; } },
    status:     { label: 'Status',         accessor: function(u){ return u.status === 'reserved' ? 'Reserved' : 'Occupied'; } },
    reno_score: { label: 'Reno Score',     accessor: function(u){ return hasSowOrReno(u.id) ? (calcRenoScore(u.id).score || 0) : 0; } }
  };
  var _tenAccessors = {};
  Object.keys(_tenColumns).forEach(function(k){ _tenAccessors[k] = _tenColumns[k].accessor; });

  var _tenState = (typeof tableStateGet === 'function') ? tableStateGet('tenants') : { sort:{key:'',dir:1}, filters:{} };

  if (typeof tableRegisterColumns === 'function') {
    tableRegisterColumns('tenants', {
      columns:  _tenColumns,
      getRows:  function(){ return units; },
      onChange: renderTenantsView
    });
  }

  units = (typeof tableApplyFilterSort === 'function')
    ? tableApplyFilterSort(units, _tenAccessors, _tenState)
    : units;

  var _tenMode = _viewMode('tenants');
  var _tenToggleEl = document.getElementById('ten_view_toggle');
  if (_tenToggleEl) _tenToggleEl.innerHTML = _viewToggleHtml('tenants', '_tenSetView');
  var _tenTableWrapEl = document.getElementById('ten_table_wrap');
  var _tenCardsEl     = document.getElementById('ten_cards');
  if (_tenTableWrapEl) _tenTableWrapEl.style.display = (_tenMode === 'cards') ? 'none' : '';
  if (_tenCardsEl)     _tenCardsEl.style.display     = (_tenMode === 'cards') ? '' : 'none';

  // Card renderer — same status/badge/reno-score logic as the table row,
  // laid out as a _cardTile instead of a <tr>.
  function _tenCardHtml(u){
    var _showRenoScore = (ROLE.isManagement(window.currentRole));
    var uid = String(u.id).replace(/'/g,"\\'");
    var badges = [];
    if(u.isElders) badges.push('<span style="font-size:9px;background:var(--warn-amber-bg);color:var(--warn-amber);border:1px solid var(--warn-amber-border);padding:1px 5px;border-radius:6px;">ELDERS UNIT</span>');
    if(_assignmentTypeBadge(u)) badges.push(_assignmentTypeBadge(u));
    var metas = [
      {k:'Beds', v: u.bedrooms ? (u.bedrooms + '-bed' + (u.accessible ? ' · Accessible' : '')) : ''},
      {k:'Move-In Date', v: u.assignedDate || ''}
    ];
    if (_showRenoScore) {
      if (hasSowOrReno(u.id)) metas.push({k:'Reno Score', v: calcRenoScore(u.id).score});
    }
    var _openCall = u.assignedName ? "openTenantCard('"+uid+"')" : "openUnitEditModal('"+uid+"')";
    return _cardTile({
      title: u.assignedName || 'No tenant assigned',
      pill: {text: (u.status==='reserved'?'Reserved':'Occupied'), bg: (u.status==='reserved'?'#faf5ff':'var(--info-blue-bg)'), color: (u.status==='reserved'?'#7c3aed':'#1d4ed8')},
      badges: badges,
      metas: [{k:'Address', v: ((u.num||'')+' '+(u.street||'')).trim()}].concat(metas),
      open: _openCall,
      actions: [
        {text:'🪪 Card', onclick:"event.stopPropagation();"+_openCall, ghost:true},
        {text:'🔨 Maintenance', onclick:"event.stopPropagation();openSowModal('"+uid+"')", ghost:true},
        {text:'📎 Files', onclick:"event.stopPropagation();openTenantFilesPanel('"+uid+"')", ghost:true}
      ]
    });
  }

  if (_tenMode === 'cards') {
    if (_tenCardsEl) _tenCardsEl.innerHTML = units.length
      ? _cardGrid(units.map(_tenCardHtml).join(''))
      : '<div class="card" style="text-align:center;padding:40px;color:var(--muted);">No tenants match the current filters.</div>';
    return;
  }

  var tbody=document.getElementById('tenants_tbody');
  if(!tbody) return;
  if(!units.length){
    tbody.innerHTML='<tr><td colspan="7" style="padding:32px;text-align:center;color:var(--muted);">No tenants match the current filters.</td></tr>';
    var _tenTheadEmpty = document.getElementById('tenants_thead');
    if (typeof tableBindColumnMenuClicks === 'function')   tableBindColumnMenuClicks(_tenTheadEmpty, 'tenants');
    if (typeof tableRefreshSortIndicators === 'function') tableRefreshSortIndicators(_tenTheadEmpty, 'tenants');
    return;
  }
  tbody.innerHTML=units.map(function(u){
    var name=u.assignedName||'<span style="color:var(--muted);font-style:italic;">No tenant assigned</span>';
    var date=u.assignedDate||'—';
    var fileCount=0; // loaded async when panel opens
    var statusBg=u.status==='reserved'?'#faf5ff':'var(--info-blue-bg)';
    var statusC=u.status==='reserved'?'#7c3aed':'#1d4ed8';
    var renoCell='';
    var _showRenoScore=(ROLE.isManagement(window.currentRole));
    if(_showRenoScore && hasSowOrReno(u.id)){
      var rs=calcRenoScore(u.id); var s=rs.score;
      var tier=s>=40?{label:'Critical',c:'var(--danger)',bg:'var(--danger-bg)'}:s>=25?{label:'High',c:'#7a6000',bg:'#fef9ec'}:s>=12?{label:'Medium',c:'#1d4ed8',bg:'var(--info-blue-bg)'}:{label:'Low',c:'var(--success)',bg:'var(--success-bg)'};
      renoCell='<div data-reno-sow="'+u.id+'" style="display:flex;align-items:center;gap:5px;cursor:pointer;" title="Open Maintenance Request"><span style="font-size:14px;font-weight:800;color:var(--text);">'+s+'</span><span style="font-size:10px;font-weight:700;padding:2px 7px;border-radius:8px;background:'+tier.bg+';color:'+tier.c+';">'+tier.label+'</span></div>';
    } else if(_showRenoScore) {
      renoCell='<span style="font-size:11px;color:var(--border);">—</span>';
    }
    // fileCount already set above
    return '<tr class="clickable" data-tuid="'+escapeHtml(u.id)+'">'
      +'<td><div class="std-cell-primary">'+escapeHtml(u.num)+' '+escapeHtml(u.street)+(u.isElders?' <span style="font-size:9px;background:var(--warn-amber-bg);color:var(--warn-amber);border:1px solid var(--warn-amber-border);padding:1px 5px;border-radius:6px;">ELDERS UNIT</span>':'')+' '+_assignmentTypeBadge(u)+'</div><div class="tbl-sub">'+escapeHtml(String(u.bedrooms||''))+'-bed'+(u.accessible?' · Accessible':'')+'</div></td>'
      +'<td class="std-cell-primary">'+escapeHtml(name)+'</td>'
      +'<td class="std-cell-dash">'+date+'</td>'
      +'<td><span class="std-pill std-pill-info">'+(u.status==='reserved'?'Reserved':'Occupied')+'</span></td>'
      +(_showRenoScore?'<td>'+renoCell+'</td>':'')
      +'<td>'
        +'<button type="button" data-files-uid="'+u.id+'" title="Tenant Files" style="background:none;border:none;cursor:pointer;display:flex;align-items:center;gap:4px;color:var(--muted);font-size:12px;font-weight:600;padding:3px 6px;border-radius:5px;">'
          +'\uD83D\uDCCE '+(fileCount>0?'<span style="background:var(--yellow);color:var(--dark);font-size:10px;font-weight:800;padding:1px 5px;border-radius:8px;">'+fileCount+'</span>':'<span style="color:var(--border);font-size:11px;">—</span>')
        +'</button>'
      +'</td>'
      +'<td style="padding:10px 10px;text-align:right;white-space:nowrap;">'
        +'<button type="button" data-tic-uid="'+u.id+'" title="Tenant Information Card" class="tic-tenant-card-btn">🪪</button>'
        +'<button type="button" data-sow-uid="'+u.id+'" title="Maintenance Request" style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:14px;">🔨</button>'
      +'</td>'
      +'</tr>';
  }).join('');
  tbody.querySelectorAll('[data-tuid]').forEach(function(row){
    row.addEventListener('click',function(e){
      if(e.target.closest('[data-sow-uid]') || e.target.closest('[data-tic-uid]')
         || e.target.closest('[data-files-uid]') || e.target.closest('[data-reno-sow]')) return;
      var uid = row.getAttribute('data-tuid');
      // Clicking a tenant row opens their Tenant Information Card (from which the
      // application can be opened/updated). If the unit has no tenant assigned
      // yet, fall back to the unit editor.
      var u = (window.housingUnits||[]).find(function(x){ return String(x.id) === String(uid); });
      if(u && u.assignedName && typeof openTenantCard === 'function') openTenantCard(uid);
      else openUnitEditModal(uid);
    });
  });
  tbody.querySelectorAll('[data-sow-uid]').forEach(function(btn){
    btn.addEventListener('click',function(e){e.stopPropagation();openSowModal(btn.getAttribute('data-sow-uid'));});
  });
  tbody.querySelectorAll('[data-tic-uid]').forEach(function(btn){
    btn.addEventListener('click',function(e){
      e.stopPropagation();
      if(typeof openTenantCard === 'function') openTenantCard(btn.getAttribute('data-tic-uid'));
    });
  });
  tbody.querySelectorAll('[data-reno-sow]').forEach(function(cell){
    cell.addEventListener('click',function(e){e.stopPropagation();openSowModal(cell.getAttribute('data-reno-sow'));});
  });
  tbody.querySelectorAll('[data-files-uid]').forEach(function(btn){
    btn.addEventListener('click',function(e){e.stopPropagation();openTenantFilesPanel(btn.getAttribute('data-files-uid'));});
  });

  // Column-menu click + sort indicators
  var _tenThead = document.getElementById('tenants_thead');
  if (typeof tableBindColumnMenuClicks === 'function')   tableBindColumnMenuClicks(_tenThead, 'tenants');
  if (typeof tableRefreshSortIndicators === 'function') tableRefreshSortIndicators(_tenThead, 'tenants');
}




















// (showScores removed — was calling getElementById with a missing argument and had zero callers anywhere. Dead code from an earlier scoring view design.)

var _scoresSortKey='score', _scoresSortDir=-1;




// ── Application Scores view ──

// ── Scorecard document functions ──────────────────────────────────────────────


// ── Scorecard docs — DocLibrary instance (Phase C Turn 3) ────────────
// Uses the factory with customLoader + customDelete because the scorecard
// merges two data sources:
//   1. app_documents table — manually-assigned migrated files
//   2. applications/{appId}/ storage folder — directly-uploaded files
// The factory's default audit-log loader doesn't know about this dual
// model, so we hand-roll the loader/delete. Everything else (render,
// upload, filter, view) is standard factory behavior.
//
// Note on upload behavior: the factory's built-in upload writes a
// file_uploaded audit row keyed by entity_type='application'. The storage
// listing in our customLoader picks that file up on the next refresh.

// ── Step 6 Document Library ───────────────────────────────────────────────────
// Initialised once when the user navigates to the Documents step.
// Re-uses the same DocLibrary factory as the scorecard panel.
var _step6DocLib = null;
var _step6DocLibAppId = null; // tracks which app the current lib was built for

function showTenantsForRole() {
  var role = window.currentRole || 'housing_employee_l1';
  if(ROLE.isManagement(role)) {
    showTenants();
  } else {
    openTenantSearch();
  }
}

function openTenantSearch() {
  // tenantSearchModal was replaced by unitSearchModal — delegate to working version
  openUnitSearch();
}

function closeTenantSearch() {
  var m = document.getElementById('unitSearchModal');
  if(m) m.style.display='none';
  document.body.classList.remove('modal-open');
}

// Called when an employee clicks a tenant row in tenantSearchFilter results.
// Opens the tenant files panel for the selected unit, or the application if linked.
function selectTenantRecord(rec) {
  closeTenantSearch();
  if (!rec) return;
  if (rec.appId) {
    // Has a linked application — open it in the worklist viewer
    if (typeof wlOpenApp === 'function') { wlOpenApp(rec.appId); return; }
  }
  if (rec.id && typeof openTenantFilesPanel === 'function') {
    // No application — open tenant files by unit ID
    openTenantFilesPanel(rec.id);
  }
}

function tenantSearchFilter(q) {
  // Search both housing units (occupied/reserved) AND applications (for names).
  // Read-only over the live array — no clone needed (the old deep clone
  // re-serialized every unit on every keystroke of the search box).
  var allUnits = (typeof housingUnits !== 'undefined' && housingUnits.length)
    ? housingUnits
    : getAllUnits();

  var allApps = (typeof applications !== 'undefined') ? applications : [];
  var qq = q.trim().toLowerCase();

  // Build tenant records from applications that are assigned, plus occupied units
  var tenantRecords = [];

  // From assigned applications — primary source
  allApps.filter(function(a){ return a.assignedUnit && !a.archived; }).forEach(function(a){
    var name = ((a.fn||'')+' '+(a.ln||'')).trim();
    var unit = allUnits.find(function(u){ return u.id === a.assignedUnit; });
    var addr = unit ? (unit.num+' '+unit.street) : (a.assignedAddress||'—');
    tenantRecords.push({ id: a.assignedUnit||a.id, name: name, addr: addr,
      status: 'occupied', appId: a.id, unitObj: unit });
  });

  // Also catch any occupied units not linked to an application
  allUnits.filter(function(u){ return (u.status==='occupied'||u.status==='reserved') && u.assignedName; })
    .forEach(function(u){
      // Skip if already added via application
      if(tenantRecords.find(function(r){ return r.id === u.id; })) return;
      tenantRecords.push({ id: u.id, name: u.assignedName||'', addr: (u.num+' '+u.street),
        status: u.status, appId: null, unitObj: u });
    });

  var filtered = qq
    ? tenantRecords.filter(function(r){
        return r.name.toLowerCase().includes(qq) || r.addr.toLowerCase().includes(qq);
      })
    : tenantRecords.slice(0, 20);

  var container = document.getElementById('tenant_search_results');
  if(!container) return;
  container.style.background = '#f4f4f0';
  container.style.borderRadius = '8px';
  container.style.padding = filtered.length ? '8px' : '0';

  if(!filtered.length) {
    container.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted);font-size:13px;font-style:italic;">'
      + (q ? 'No tenants found matching "'+escapeHtml(q)+'"' : 'No assigned tenants on file.')
      + '</div>';
    return;
  }

  // Rows are keyed by INDEX into a module-level results array instead of the
  // old JSON.stringify(...).replace(/"/g,"'") inline-onclick hack — that broke
  // with a SyntaxError on any name/address containing an apostrophe (O'Brien)
  // and injected the raw strings into the handler. Display strings are escaped.
  window._tenSearchResults = filtered;
  container.innerHTML = filtered.map(function(r, _ri) {
    var bg = r.status==='reserved' ? '#faf5ff' : 'var(--info-blue-bg)';
    return '<div onclick="_selTenantRec('+_ri+')" '
      + 'style="display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:7px;cursor:pointer;background:'+bg+';margin-bottom:6px;transition:opacity .1s;" '
      + 'onmouseover="this.style.opacity=\'0.8\'" onmouseout="this.style.opacity=\'1\'">'
      + '<div style="width:36px;height:36px;border-radius:50%;background:var(--yellow);color:var(--dark);font-size:13px;font-weight:800;display:flex;align-items:center;justify-content:center;flex-shrink:0;">'
      + escapeHtml(r.name ? r.name.charAt(0).toUpperCase() : '?') + '</div>'
      + '<div><div class="js-txt-bold">'+escapeHtml(r.name)+'</div>'
      + '<div class="js-lbl-sm">'+escapeHtml(r.addr)+'</div></div>'
      + '</div>';
  }).join('');
}
// Click hand-off for the tenant-search rows above.
window._selTenantRec = function(i){
  var rec = (window._tenSearchResults || [])[i];
  if (rec && typeof selectTenantRecord === 'function') selectTenantRecord(rec);
};

function showInventoryForRole() {
  var role = window.currentRole || 'housing_employee_l1';
  if(ROLE.isManagement(role)) {
    showInventory();
  } else {
    openUnitSearch();
  }
}

function openUnitSearch() {
  unitSearchFilter('');
  var m = document.getElementById('unitSearchModal');
  if(m){ m.style.setProperty('display','flex','important'); document.body.classList.add('modal-open'); }
  setTimeout(function(){ var i=document.getElementById('unit_search_input'); if(i){i.value='';i.focus();} }, 150);
}

function closeUnitSearch() {
  var m = document.getElementById('unitSearchModal');
  if(m) m.style.display='none';
  document.body.classList.remove('modal-open');
}

function unitSearchFilter(q) {
  var allUnits = getAllUnits();
  var filtered = q.trim().length > 0
    ? allUnits.filter(function(u){ return (u.num+' '+u.street).toLowerCase().includes(q.toLowerCase()); })
    : allUnits.slice(0,20);

  var statusStyle = {
    vacant:      {bg:'var(--success-bg)',c:'var(--success)',label:'Vacant'},
    occupied:    {bg:'var(--info-blue-bg)',c:'#1d4ed8',label:'Occupied'},
    under_repair:{bg:'var(--success-bg)',c:'var(--success)',label:'Vacant'},
    reserved:    {bg:'#faf5ff',c:'#7c3aed',label:'Reserved'},
    new_construction: {bg:'var(--info-blue-bg)',c:'var(--info-blue)',label:'New Construction'},
    condemned:   {bg:'var(--danger-bg)',c:'var(--danger)',label:'Condemned'}
  };

  var container = document.getElementById('unit_search_results');
  if(!container) return;

  if(!filtered.length) {
    container.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted);font-size:13px;font-style:italic;">No units found matching "'+escapeHtml(q)+'"</div>';
    return;
  }

  container.innerHTML = filtered.map(function(u) {
    var ss = statusStyle[u.status]||{bg:'#f0f0ec',c:'var(--gray)',label:u.status};
    return '<div onclick="closeUnitSearch();openUnitEditModal(\''+u.id.replace(/'/g,"\\'")+'\')" '
      +'style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border:1px solid var(--border);border-radius:8px;cursor:pointer;background:var(--bg);transition:border-color .12s;" '
      +'onmouseover="this.style.borderColor=\'var(--yellow)\'" onmouseout="this.style.borderColor=\'var(--border)\'">'
      +'<div>'
        +'<div style="font-weight:700;font-size:13px;">'+escapeHtml(u.num)+' '+escapeHtml(u.street)+'</div>'
        +'<div class="js-lbl-sm">'+escapeHtml(_roomBedLabel(u))+' · '+escapeHtml(_fmtUnitType(u.type)||'—')+'</div>'
      +'</div>'
      +'<span style="font-size:11px;font-weight:700;padding:3px 10px;border-radius:8px;background:'+ss.bg+';color:'+ss.c+';">'+escapeHtml(ss.label)+'</span>'
      +'</div>';
  }).join('');
}

// ── Global Header Export ──
window._currentExportView = null; // set by each showXxx function







// ── Shared export engine ──


// ── Inventory export ──


// ── Match export ──



// ── Landing view (Phase B) ────────────────────────────────────────────────
// Replaces the old employeeHomeView + worklistView with a single unified
// landing. Stop-A version: render greeting + role tag + active-nav state.
// Lookup wiring, collapsible state, count pills, and worklist body are
// populated in Stop B (housing-init.js).
function showLanding() {
  if (!document.getElementById('landingView')) {
    // Sub-page navigation: bounce back to housing.html.
    if (!window.location.pathname.includes('housing.html') &&
        !window.location.pathname.endsWith('/') &&
        window.location.pathname !== '/') {
      document.body.style.transition = 'opacity .15s ease';
      document.body.style.opacity = '0';
      setTimeout(function(){ window.location.href = 'housing.html'; }, 150);
      return;
    }
  }
  if(!window._navSkipPush) pushNav('home');
  setExportView(null);

  if (typeof hideAllViews === 'function') hideAllViews('landingView');
  var lv = document.getElementById('landingView');
  if (lv) { lv.style.display = 'flex'; lv.style.width = '100%'; }
  if (typeof setNavActive === 'function') setNavActive('tab_dash');
  if (typeof setHeaderNavActive === 'function') setHeaderNavActive('home');

  // Greeting — same population logic as the old showEmployeeHome.
  var role = (typeof HOUSING_SESSION !== 'undefined' && HOUSING_SESSION && HOUSING_SESSION.role)
          || window._realRole || window.currentRole || 'housing_employee_l1';
  var roleLabels = {
    employee:            'Staff',
    housing_employee_l1: 'Staff',
    housing_employee_l2: 'Staff',
    housing_manager:     (typeof CLFN_PERMS !== 'undefined') ? CLFN_PERMS.roleLabel(ROLE.HOUSING_MANAGER) : 'Housing Manager',
    ed:                  (typeof CLFN_PERMS !== 'undefined') ? CLFN_PERMS.roleLabel(ROLE.ED) : 'Executive Director',
    cfo:                 (typeof CLFN_PERMS !== 'undefined') ? CLFN_PERMS.roleLabel(ROLE.CFO) : 'CFO',
    finance_l1:          (typeof CLFN_PERMS !== 'undefined') ? CLFN_PERMS.roleLabel(ROLE.FINANCE_L1) : 'Finance Clerk'
  };
  // (per-role subtitles object removed — the subtitle is hard-set to the
  // shared wellness line further down and never read this map)

  // Date line
  var dateEl = document.getElementById('emp_home_date');
  if (dateEl) {
    var d = new Date();
    var dayStr  = d.toLocaleDateString('en-US', { weekday: 'long' });
    var dateStr = d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    dateEl.textContent = dayStr + ' · ' + dateStr;
  }

  // Greeting name (first name only)
  var nameEl = document.getElementById('emp_home_name');
  if (nameEl) {
    var userName = (typeof HOUSING_SESSION !== 'undefined' && HOUSING_SESSION.name) ? HOUSING_SESSION.name : '';
    var firstName = userName ? userName.split(/\s+/)[0] : (roleLabels[role] || 'there');
    nameEl.textContent = firstName;
  }

  // Role tag pill next to the name
  var tagEl = document.getElementById('emp_home_role_tag');
  if (tagEl) {
    tagEl.textContent = roleLabels[role] || 'Staff';
    tagEl.style.display = 'inline-flex';
  }

  // Subtitle — one consistent landing message app-wide (see finance.html home
  // subtitle + the other landing renderer below; keep all three in sync).
  var subEl = document.getElementById('emp_home_subtitle');
  if (subEl) subEl.textContent = "Here's what's happening today.";

  // KPI strip — housing-only metrics from the in-memory caches.
  _renderLandingKpis();

  // Refresh the action worklist so freshly created/submitted items (e.g. a new
  // application just submitted) appear immediately on return to the landing page,
  // instead of only after a full reload / re-login.
  if (typeof renderWorklist === 'function' && document.getElementById('worklist_body')) renderWorklist();

  // Recent Activity — kick off the role-aware render so the count pill
  // (#recent_count_pill) reflects today's events on first paint, not just
  // after the user expands the section. The body update happens against
  // a hidden element (section defaults collapsed) and primes the
  // auditLog cache so the eventual expand renders instantly.
  if (typeof renderRecentActivity === 'function') renderRecentActivity(role);
}

// An application "done by a tenant/member" — created from an applicant-portal
// submission (source stamped by _appSubApprove), or an existing application a
// portal update/transfer was merged into (_appSubMerge stamps last_portal_merge).
function _appIsPortal(a){
  return !!(a && (a.source === 'portal' || a.portal_submission_id || a.last_portal_merge));
}

// _renderLandingKpis — Open Apps · Critical · Vacant · Awaiting Match.
// All counts come from the in-memory `applications` and `housingUnits`
// arrays so no extra Supabase round-trips run on every landing render.
// Finance metrics intentionally excluded — landing stays housing-only.
function _renderLandingKpis(){
  function setKpi(id, val){
    var el = document.getElementById(id);
    if (el) el.textContent = (val == null ? '—' : String(val));
  }
  var apps  = (typeof applications !== 'undefined' && applications) ? applications : [];
  // Exclude lot records (record_type:'lot') from all housing-unit KPIs/counts.
  var units = ((typeof housingUnits  !== 'undefined' && housingUnits)  ? housingUnits  : [])
    .filter(function(u){ return !(typeof _isLot==='function' && _isLot(u)); });

  var STATUS = (typeof APP_STATUS !== 'undefined') ? APP_STATUS : {
    SUBMITTED: 'submitted', FILE_UPDATE: 'file_update',
    MGR_APPROVED: 'mgr_approved', ED_APPROVED: 'ed_approved'
  };

  var openApps = apps.filter(function(a){
    if(!a || a.archived) return false;
    // Deceased and BCR-ineligible applicants live outside the pipeline counts
    // (same rule as every Applications-by-Type row).
    if(a.deceased) return false;
    if(typeof appIsBcrIneligible === 'function' && appIsBcrIneligible(a)) return false;
    return a.status === STATUS.SUBMITTED
        || a.status === STATUS.FILE_UPDATE
        || a.status === STATUS.MGR_APPROVED;
  }).length;

  var vacant = units.filter(function(u){
    return u && !u.archived && u.status === 'vacant';
  }).length;
  // Vacant-card breakdown: houses out of service (same state tests as the
  // reconcile report's buckets, so the two never disagree).
  var condemnedN = units.filter(function(u){
    return u && !u.archived && (u.status||'').toLowerCase() === 'condemned';
  }).length;
  // "Of which under repair" — a SUBSET of the vacant headline, not a separate
  // pool. sbLoadUnits migrates status='under_repair' to status 'vacant' +
  // under_renovation=true at boot, so every unoccupied unit under repair IS
  // vacant-status; the old "exclude vacant status" guard (meant to stop a
  // double count) therefore excluded them all and pinned this row at 0. As an
  // explicit of-which subset there is nothing to double count.
  var underRepairN = units.filter(function(u){
    if(!u || u.archived) return false;
    if(u.assignedTo || u.assignedName) return false;   // occupied units being repaired aren't vacant stock
    return (u.status||'').toLowerCase() === 'vacant' && !!u.under_renovation;
  }).length;
  // "Of which with an open Maintenance Request" — derived LIVE from the SOW
  // data (hasActiveSows in shared-sow.js: not completed / cancelled /
  // archived), unlike the under-renovation row above, which reads the unit's
  // persisted under_renovation flag (flipped when a request is approved,
  // cleared when the last one completes). The two rows cross-check each
  // other: a gap means either a stale flag or an open request that hasn't
  // been approved yet.
  var vacantOpenSowN = units.filter(function(u){
    if(!u || u.archived) return false;
    if(u.assignedTo || u.assignedName) return false;
    if((u.status||'').toLowerCase() !== 'vacant') return false;
    return typeof hasActiveSows === 'function' && hasActiveSows(u.id);
  }).length;

  // Application-type breakdown (active = non-archived, not declined):
  //   new_housing      → New Applications (seeking a new unit)
  //   existing_tenant  → File Updates
  //   transfer_request → House Requests (existing tenant transfer)
  // Housed = linked to a real unit. Derived live from the units, so unlinking a
  // tenant returns them to the New Applications waitlist automatically.
  var _housedIdx = (typeof buildHousedIndex === 'function') ? buildHousedIndex(units) : {};
  function _isHoused(a){ return (typeof appIsHoused === 'function') ? appIsHoused(a, _housedIdx) : (a.status === 'assigned' || !!a.assignedUnit || !!_housedIdx[a.id]); }
  // BCR-listed applicants (banished / evicted for harbouring) are ineligible —
  // out of the type counts entirely; Match still lists them flagged.
  var _bcrBlocked = function(a){ return typeof appIsBcrIneligible === 'function' && appIsBcrIneligible(a); };
  function _activeOfType(pred, excludeHoused){
    return apps.filter(function(a){
      if(!a || a.archived || a.status === 'declined') return false;
      if(a.deceased) return false;   // deceased apps live in their own group
      if(_bcrBlocked(a)) return false;
      if(excludeHoused && _isHoused(a)) return false;
      return pred(a.appType || 'new_housing');
    }).length;
  }
  // New Applications = the real waitlist: seeking-a-unit apps that are NOT
  // housed. Commercial (business/department) applications are excluded — they
  // request buildings, not waitlist spots, and were inflating this count.
  var newApps       = _activeOfType(appIsWaitlistType, true);
  // Subset annotation: new applications still sitting in DRAFT (started but
  // never submitted) — same population rules as the New Applications row.
  var draftApps = apps.filter(function(a){
    if(!a || a.archived || a.status !== 'draft' || a.deceased) return false;
    if(_bcrBlocked(a) || _isHoused(a)) return false;
    return appIsWaitlistType(a.appType);
  }).length;
  // Subset annotation: doubled-up members — on reserve without a home of
  // their own (staying with family). Same population rules as New Applications.
  var doubledApps = apps.filter(function(a){
    if(!a || a.archived || a.status === 'declined' || a.status === 'draft' || a.deceased) return false;
    if(_bcrBlocked(a) || _isHoused(a)) return false;
    if(!appIsWaitlistType(a.appType)) return false;
    return a.livingSituation === 'family_on_reserve';
  }).length;
  var fileUpdates   = _activeOfType(function(t){ return t === 'existing_tenant'; });
  var houseRequests = _activeOfType(function(t){ return t === 'transfer_request'; });

  // Online (self-serve) applications — submitted or updated by members through
  // the applicant portal. Same population rules as the type card (non-archived,
  // not declined/deceased/BCR-blocked), but housed apps stay counted: a portal
  // application that got someone housed is still a self-serve application.
  function _portalOfType(pred){
    return apps.filter(function(a){
      if(!a || a.archived || a.status === 'declined' || a.deceased) return false;
      if(_bcrBlocked(a)) return false;
      if(!(typeof _appIsPortal === 'function' ? _appIsPortal(a) : (a.source === 'portal' || a.portal_submission_id || a.last_portal_merge))) return false;
      return !pred || pred(a.appType || 'new_housing');
    }).length;
  }
  var portalTotal     = _portalOfType(null);
  var portalNew       = _portalOfType(appIsWaitlistType);
  var portalUpdates   = _portalOfType(function(t){ return t === 'existing_tenant'; });
  var portalTransfers = _portalOfType(function(t){ return t === 'transfer_request'; });

  setKpi('kpi_open_apps',       openApps);
  setKpi('kpi_vacant',          vacant);
  setKpi('kpi_under_repair',    underRepairN);
  setKpi('kpi_vacant_open_sow', vacantOpenSowN);
  setKpi('kpi_condemned',       condemnedN);
  setKpi('kpi_new_apps',        newApps);
  setKpi('kpi_draft_apps',      draftApps);
  setKpi('kpi_doubled_apps',    doubledApps);
  setKpi('kpi_file_updates',    fileUpdates);
  setKpi('kpi_house_requests',  houseRequests);
  setKpi('kpi_portal_apps',      portalTotal);
  setKpi('kpi_portal_new',       portalNew);
  setKpi('kpi_portal_updates',   portalUpdates);
  setKpi('kpi_portal_transfers', portalTransfers);

  // (Likely-Housed / Reconcile / Archived-Applications quick actions moved to
  // the Operations nav dropdown's Data Health section — housing-init.js.)

  // Scroll-collapse: shrink the KPI strip to icon-only once the page scrolls,
  // freeing space on tablet/mobile (shared-ui.js). _initScrollCollapse is
  // itself idempotent, so calling it on every render is safe.
  var _kpiStrip = document.getElementById('landing_kpi_strip');
  var _contentArea = document.querySelector('.content-area');
  if (_kpiStrip && _contentArea && typeof _initScrollCollapse === 'function') {
    _initScrollCollapse(_contentArea, _kpiStrip);
  }
}

var _kpiDrillData = null; // { title, headers, rows, colWidths, filename }

function showHousingKpiDrilldown(type) {
  var apps  = (typeof applications !== 'undefined' && applications) ? applications : [];
  var units = (typeof housingUnits  !== 'undefined' && housingUnits)  ? housingUnits  : [];

  // Status wording: shared 'kpi' variant of formatAppStatusLabel
  // (shared-data.js) — raw-status fallback for unmapped statuses (e.g. draft).
  function STATUS_LBL(a){ return formatAppStatusLabel(a.status, {variant:'kpi'}) || a.status || ''; }
  var URGENT_LABELS = {
    'homeless':'Homeless','domestic_violence':'Domestic Violence','fire_disaster':'Fire / Disaster',
    'temporary_shelter':'Temporary Shelter',
    'homeless_eviction':'Homeless / Eviction','eviction_risk':'Eviction Risk','separation':'Separation',
    'none':'','':''
  };
  function tierPill(tier) {
    var colors = {'Critical Priority':'var(--danger)','High Priority':'var(--warn-amber-text)','Medium Priority':'var(--info-blue)'};
    var c = colors[tier] || 'var(--muted)';
    return '<span style="font-size:11px;font-weight:700;color:'+c+';">'+(tier||'—')+'</span>';
  }
  function daysSince(dateStr) {
    if (!dateStr) return '—';
    var d = Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
    return d >= 0 ? d + 'd' : '—';
  }
  function daysSinceRaw(dateStr) {
    if (!dateStr) return '';
    var d = Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
    return d >= 0 ? d + ' days' : '';
  }
  function appRow(a, cols) {
    var sid = (a.id||'').replace(/'/g,"\\'");
    // Stamp which drill list opened the app so Back (form OR scorecard)
    // returns to this list (reopened fresh) instead of the landing page.
    // Status-branched open (wlOpenApp): draft/returned -> the edit wizard;
    // everything else -> the SCORECARD, where the score breakdown and the
    // ED Adjustment Factor panel live. Opening the wizard unconditionally
    // here had hidden the scorecard/ED-points form from review flows.
    return '<tr class="clickable" onclick="_closeHousingKpiDrill();window._appFormReturnDrill=\''+type+'\';'
      + 'if(typeof wlOpenApp===\'function\'){wlOpenApp(\''+sid+'\');}else if(typeof window.openEditModal===\'function\'){window.openEditModal(\''+sid+'\');}">'
      + cols + '</tr>';
  }

  var title, html, exportHeaders, exportRows, exportColWidths;
  var today = new Date().toISOString().slice(0,10);

  if (type === 'open') {
    title = 'Open Applications';
    var rows = apps.filter(function(a){
      if (!a || a.archived || a.deceased) return false;
      if (typeof appIsBcrIneligible === 'function' && appIsBcrIneligible(a)) return false;
      return a.status==='submitted' || a.status==='file_update' || a.status==='mgr_approved';
    }).slice().sort(function(a,b){ return (b.score||0)-(a.score||0); });
    exportHeaders = ['Applicant','App ID','Status','Tier','Score','Days Waiting'];
    exportColWidths = [28,16,14,22,8,12];
    exportRows = rows.map(function(a){
      return [(a.fn||'')+' '+(a.ln||''), a.id||'', STATUS_LBL(a),
              a.tier_v2||a.tier||'', a.score||0, daysSinceRaw(a.appDate)];
    });
    html = '<table class="tbl"><thead><tr>'
      + '<th>Applicant</th><th>Status</th><th>Tier</th><th class="std-cell-right">Score</th><th>Waiting</th>'
      + '</tr></thead><tbody>'
      + (rows.length ? rows.map(function(a){
          return appRow(a,
            '<td style="font-weight:600;">'+escapeHtml((a.fn||'')+' '+(a.ln||''))+'</td>'
            +'<td>'+escapeHtml(STATUS_LBL(a))+'</td>'
            +'<td>'+tierPill(a.tier_v2||a.tier)+'</td>'
            +'<td class="std-cell-right" style="font-weight:700;">'+(a.score||0)+'</td>'
            +'<td class="std-cell-muted">'+daysSince(a.appDate)+'</td>'
          );
        }).join('') : '<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:24px;">No open applications.</td></tr>')
      + '</tbody></table>';

  } else if (type === 'vacant' || type === 'under_repair' || type === 'vacant_open_sow' || type === 'condemned') {
    // One unit-table branch for the Vacant card and its breakdown rows.
    // Filters MIRROR the KPI predicates in _renderLandingKpis exactly.
    var _unitCfg = {
      vacant:       { title:'Vacant Units', empty:'No vacant units.',
                      pred:function(u){ return u.status==='vacant'; } },
      under_repair: { title:'Vacant Units Under Repair / Renovation', empty:'No vacant units under repair.',
                      pred:function(u){
                        if(u.assignedTo || u.assignedName) return false;
                        return (u.status||'').toLowerCase()==='vacant' && !!u.under_renovation;
                      } },
      vacant_open_sow: { title:'Vacant Units with an Open Maintenance Request', empty:'No vacant units with an open maintenance request.',
                      pred:function(u){
                        if(u.assignedTo || u.assignedName) return false;
                        if((u.status||'').toLowerCase()!=='vacant') return false;
                        return typeof hasActiveSows === 'function' && hasActiveSows(u.id);
                      } },
      condemned:    { title:'Condemned Units', empty:'No condemned units.',
                      pred:function(u){ return (u.status||'').toLowerCase()==='condemned'; } }
    }[type];
    title = _unitCfg.title;
    var rows = units.filter(function(u){ return u && !u.archived && _unitCfg.pred(u); })
      .slice().sort(function(a,b){ return ((a.street||'')+(a.num||'')).localeCompare((b.street||'')+(b.num||'')); });
    exportHeaders = ['Address','Bedrooms','Type','Classification','Accessible','Elders Unit'];
    exportColWidths = [28,10,16,20,12,12];
    exportRows = rows.map(function(u){
      return [(u.num||'')+' '+(u.street||''), u.bedrooms||'',
              _fmtUnitType(u.type)||'', u.classification||'',
              u.accessible?'Yes':'', u.isElders?'Yes':''];
    });
    html = '<table class="tbl"><thead><tr>'
      + '<th>Address</th><th class="std-cell-right">Beds</th><th>Type</th><th>Classification</th>'
      + '</tr></thead><tbody>'
      + (rows.length ? rows.map(function(u){
          var sid = (u.id||'').replace(/'/g,"\\'");
          return '<tr class="clickable" onclick="_closeHousingKpiDrill();window.location.href=\'inventory.html?unit='+sid+'\'">'
            +'<td style="font-weight:600;">'+escapeHtml((u.num||'')+' '+(u.street||''))+'</td>'
            +'<td class="std-cell-right">'+(u.bedrooms||'—')+'</td>'
            +'<td class="std-cell-muted">'+escapeHtml(_fmtUnitType(u.type)||'—')+'</td>'
            +'<td class="std-cell-muted">'+escapeHtml(u.classification||'—')+'</td>'
            +'</tr>';
        }).join('') : '<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:24px;">'+_unitCfg.empty+'</td></tr>')
      + '</tbody></table>';

  } else if (type === 'new_apps' || type === 'file_updates' || type === 'house_requests' || type === 'draft_apps' || type === 'deceased_apps' || type === 'doubled_apps'
          || type === 'portal_apps' || type === 'portal_new' || type === 'portal_updates' || type === 'portal_transfers') {
    var _typeCfg = {
      new_apps:       { title:'New Applications',                          pred:appIsWaitlistType, empty:'No active new applications.' },
      draft_apps:     { title:'New Applications — In Draft',               pred:appIsWaitlistType, empty:'No draft applications.' },
      doubled_apps:   { title:'New Applications — Doubled Up (on reserve)', pred:appIsWaitlistType, empty:'No doubled-up applicants on file.' },
      file_updates:   { title:'File Updates — Existing Tenant',            pred:function(t){ return t==='existing_tenant'; },   empty:'No active file updates.' },
      house_requests: { title:'House Requests — Existing Tenant Transfer', pred:function(t){ return t==='transfer_request'; },  empty:'No active house requests.' },
      deceased_apps:  { title:'Applications — Deceased',                   pred:function(){ return true; },                     empty:'No deceased-flagged applications.' },
      // Online (self-serve) groups — the portal KPI card. Same population
      // rules as _portalOfType in _renderLandingKpis (housed apps included).
      portal_apps:      { title:'Online Applications — Submitted by Members',    pred:function(){ return true; },                    empty:'No online applications yet.' },
      portal_new:       { title:'Online Applications — New Housing',             pred:appIsWaitlistType,                             empty:'No online new applications.' },
      portal_updates:   { title:'Online Applications — File Updates',            pred:function(t){ return t==='existing_tenant'; },  empty:'No online file updates.' },
      portal_transfers: { title:'Online Applications — Transfer Requests',       pred:function(t){ return t==='transfer_request'; }, empty:'No online transfer requests.' }
    }[type];
    title = _typeCfg.title;
    // New Applications drilldown excludes housed (linked) apps, matching the KPI.
    var _housedIdx2 = (typeof buildHousedIndex === 'function') ? buildHousedIndex(units) : {};
    var _isHoused2 = function(a){ return (typeof appIsHoused === 'function') ? appIsHoused(a, _housedIdx2) : (a.status === 'assigned' || !!a.assignedUnit || !!_housedIdx2[a.id]); };
    var rows = apps.filter(function(a){
      if (!a || a.archived) return false;
      // Deceased apps live only in their own group; every other group excludes them.
      if (type === 'deceased_apps') return !!a.deceased;
      if (a.deceased || a.status==='declined') return false;
      // BCR-listed (banished / harbouring-evicted) applicants are excluded
      // from every type group — Match shows them flagged as ineligible.
      if (typeof appIsBcrIneligible === 'function' && appIsBcrIneligible(a)) return false;
      if ((type === 'new_apps' || type === 'draft_apps' || type === 'doubled_apps') && _isHoused2(a)) return false;
      if (type === 'draft_apps' && a.status !== 'draft') return false;
      if (type === 'doubled_apps' && (a.status === 'draft' || a.livingSituation !== 'family_on_reserve')) return false;
      if (type.indexOf('portal_') === 0 && !_appIsPortal(a)) return false;
      return _typeCfg.pred(a.appType || 'new_housing');
    }).slice().sort(function(a,b){ return (b.score||0)-(a.score||0); });
    exportHeaders = ['Applicant','App ID','Tier','Score','Status','Days Waiting'];
    exportColWidths = [28,16,22,8,14,12];
    exportRows = rows.map(function(a){
      return [(a.fn||'')+' '+(a.ln||''), a.id||'', a.tier_v2||a.tier||'',
              a.score||0, STATUS_LBL(a), daysSinceRaw(a.appDate)];
    });
    html = '<table class="tbl"><thead><tr>'
      + '<th>Applicant</th><th>Status</th><th>Tier</th><th class="std-cell-right">Score</th><th>Waiting</th>'
      + '</tr></thead><tbody>'
      + (rows.length ? rows.map(function(a){
          return appRow(a,
            '<td style="font-weight:600;">'+escapeHtml((a.fn||'')+' '+(a.ln||''))+'</td>'
            +'<td>'+escapeHtml(STATUS_LBL(a))+'</td>'
            +'<td>'+tierPill(a.tier_v2||a.tier)+'</td>'
            +'<td class="std-cell-right" style="font-weight:700;">'+(a.score||0)+'</td>'
            +'<td class="std-cell-muted">'+daysSince(a.appDate)+'</td>'
          );
        }).join('') : '<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:24px;">'+_typeCfg.empty+'</td></tr>')
      + '</tbody></table>';
  }

  _kpiDrillData = {
    title:     title,
    headers:   exportHeaders,
    rows:      exportRows,
    colWidths: exportColWidths,
    filename:  nationShort() + '_' + (title||type).replace(/[^a-zA-Z0-9]+/g,'_') + '_' + today
  };

  var existing = document.getElementById('modalHousingKpiDrill');
  if (existing) existing.remove();
  var mo = document.createElement('div');
  mo.className = 'modal-ov';
  mo.id = 'modalHousingKpiDrill';
  mo.innerHTML =
    '<div class="modal" style="max-width:860px;width:96%;">'
    + '<div class="modal-hdr modal-hdr-stack">'
    +   '<div><h2>' + title + '</h2>'
    +   (exportRows && exportRows.length ? '<div class="modal-hdr-sub">' + exportRows.length + ' record' + (exportRows.length===1?'':'s') + '</div>' : '')
    +   '</div>'
    +   '<div class="flex-gap8 flex-wrap" style="align-items:center;">'
    +     '<button class="btn btn-ghost-dark" onclick="_kpiDrillPrint()">&#128438; Print</button>'
    +     '<div class="export-dropdown">'
    +       '<button onclick="toggleExportMenu(this)" class="btn btn-primary">&#128196; Export</button>'
    +       '<div class="header-export-menu">'
    +         '<button onclick="_kpiDrillExport(\'pdf\')"   class="header-export-item">Save as PDF</button>'
    +         '<button onclick="_kpiDrillExport(\'excel\')" class="header-export-item">Excel (.xlsx)</button>'
    +         '<button onclick="_kpiDrillExport(\'csv\')"   class="header-export-item">CSV</button>'
    +       '</div>'
    +     '</div>'
    +     '<button class="modal-close" onclick="_closeHousingKpiDrill()">&#x2715;</button>'
    +   '</div>'
    + '</div>'
    + '<div class="modal-body" style="padding:0;"><div class="tbl-wrap">'+html+'</div></div>'
    + '</div>';
  mo.addEventListener('click', function(e){ if (e.target === mo) _closeHousingKpiDrill(); });
  document.body.appendChild(mo);
  mo.style.display = '';
  mo.classList.add('on');
}

function _closeHousingKpiDrill() {
  var m = document.getElementById('modalHousingKpiDrill');
  if (m) m.remove();
}

function _kpiDrillExport(format) {
  if (!_kpiDrillData || !_kpiDrillData.rows) return;
  if (typeof _doExport === 'function') {
    _doExport(format, _kpiDrillData.headers, _kpiDrillData.rows,
              _kpiDrillData.filename, _kpiDrillData.colWidths, false);
  }
}

function _kpiDrillPrint() {
  if (!_kpiDrillData) return;
  var d = _kpiDrillData;
  var nation = nationDisplay();
  var dateStr = new Date().toLocaleDateString('en-CA', {year:'numeric',month:'long',day:'numeric'});
  var thead = '<tr>' + d.headers.map(function(h){ return '<th>'+h+'</th>'; }).join('') + '</tr>';
  var tbody = (d.rows && d.rows.length)
    ? d.rows.map(function(r){ return '<tr>' + r.map(function(c){ return '<td>'+(c==null?'':c)+'</td>'; }).join('') + '</tr>'; }).join('')
    : '<tr><td colspan="'+d.headers.length+'" style="text-align:center;padding:20px;color:#666;">No records.</td></tr>';
  var html = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>'+d.title+'</title>'
    + '<style>'
    + 'body{font-family:Arial,sans-serif;font-size:12px;color:#111;margin:24px;}'
    + 'h1{font-size:16px;margin:0 0 2px;}p{margin:0 0 14px;font-size:11px;color:#555;}'
    + 'table{width:100%;border-collapse:collapse;}'
    + 'th{background:#111;color:#fff;padding:6px 8px;text-align:left;font-size:11px;}'
    + 'td{padding:5px 8px;border-bottom:1px solid #e5e5e5;font-size:11px;}'
    + 'tr:nth-child(even) td{background:#f9f9f9;}'
    + '@media print{body{margin:12px;}}'
    + '</style></head><body>'
    + '<h1>'+d.title+'</h1>'
    + '<p>'+nation+' &mdash; Generated '+dateStr+(d.rows?' &mdash; '+d.rows.length+' record'+(d.rows.length===1?'':'s'):'')+'</p>'
    + '<table><thead>'+thead+'</thead><tbody>'+tbody+'</tbody></table>'
    + '<script>window.onload=function(){window.print();}<\/script>'
    + '</body></html>';
  var w = window.open('', '_blank', 'width=960,height=700');
  if (w) { w.document.write(html); w.document.close(); }
}

// ── "Likely already housed" report ──────────────────────────────────────────
// New-housing applications whose applicant is already housed (has a current
// tenancy on a unit) — candidates to reclassify as an Existing House Request
// (transfer) or a File Update. Uses the same tenancy lookups as the Match view.
function _housingLikelyHousedApps(){
  var apps  = (typeof applications !== 'undefined' && applications) ? applications : [];
  var units = (typeof housingUnits  !== 'undefined' && housingUnits)  ? housingUnits  : [];
  // Map each unit that is LINKED to an application (unit.assignedTo === app.id).
  // Linkage is the only reliable "has a house" signal; a name match is not used —
  // if an application is not linked to a unit we treat it as no house.
  var byId = (typeof buildHousedIndex === 'function') ? buildHousedIndex(units) : {};
  var out = [];
  apps.forEach(function(a){
    if(!a || a.archived || a.status==='declined') return;
    var t = a.appType || 'new_housing';
    if(t === 'existing_tenant' || t === 'transfer_request') return;  // already classified
    // Commercial (business/department) applications occupy buildings BY
    // DESIGN once assigned — they are never "likely already housed"
    // residential candidates to reclassify as a transfer or file update.
    if(t === 'commercial') return;
    // Housed only if the application is LINKED to a real housing unit.
    var addr = '', via = '';
    if (byId[a.id])          { addr = (byId[a.id] === true ? 'Assigned unit' : byId[a.id]); via = 'Unit assigned to this application'; }
    else if (a.assignedUnit) { addr = a.assignedAddress || 'Assigned unit'; via = 'Application linked to a unit'; }
    // Status says Assigned but nothing backs it: the New Applications count
    // treats these as housed, so without this leg they were invisible to BOTH
    // lists. Surface them here for cleanup (not-housed / reclassify).
    else if (a.status === 'assigned') { addr = a.assignedAddress || '(no unit on file)'; via = 'Status is Assigned but no unit is linked'; }
    if(!addr) return;                                 // not linked to a unit -> not housed
    out.push({ app:a, addr:addr, via:via });
  });
  out.sort(function(x,y){ return (y.app.score||0)-(x.app.score||0); });
  return out;
}

function showLikelyHousedReport(){
  var list = _housingLikelyHousedApps();
  var today = new Date().toISOString().slice(0,10);
  var esc = (typeof escapeHtml === 'function') ? escapeHtml : function(s){ return String(s==null?'':s); };
  var STATUS_LBL = function(a){ return (typeof formatAppStatusLabel==='function' ? formatAppStatusLabel(a.status,{variant:'kpi'}) : a.status) || a.status || ''; };

  var rowsHtml = list.length ? list.map(function(x){
    var a = x.app; var sid = (a.id||'').replace(/'/g,"\\'");
    return '<tr>'
      + '<td style="font-weight:600;">'+esc((a.fn||'')+' '+(a.ln||''))+'</td>'
      + '<td class="std-cell-muted">'+esc(x.addr)+(x.via?'<div style="font-size:10px;color:var(--muted);">'+esc(x.via)+'</div>':'')+'</td>'
      + '<td>'+esc(STATUS_LBL(a))+'</td>'
      + '<td class="std-cell-right" style="font-weight:700;">'+(a.score||0)+'</td>'
      + '<td><div style="display:flex;flex-wrap:wrap;gap:4px;">'
      +   '<button class="btn btn-ghost btn-xs" onclick="_reclassifyApp(\''+sid+'\',\'transfer_request\')">&rarr; Transfer</button>'
      +   '<button class="btn btn-ghost btn-xs" onclick="_reclassifyApp(\''+sid+'\',\'existing_tenant\')">&rarr; File Update</button>'
      +   '<button class="btn btn-ghost btn-xs" title="They live at this address but it is not their own home — unlink the unit, keep this a New Application, and return them to the waitlist" onclick="_lhMarkNotHoused(\''+sid+'\')">&#128101; Doubled up &mdash; not housed</button>'
      +   '<button class="btn btn-ghost btn-xs" onclick="_closeLikelyHoused();window._appFormReturnDrill=\'likely_housed\';if(typeof window.openEditModal===\'function\')window.openEditModal(\''+sid+'\');">Open</button>'
      + '</div></td>'
      + '</tr>';
  }).join('') : '<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:24px;">No new applications match an existing tenancy — your New Applications count looks clean.</td></tr>';

  _kpiDrillData = {
    title:     'Likely Already Housed',
    headers:   ['Applicant','Current Address','Status','Score'],
    rows:      list.map(function(x){ return [(x.app.fn||'')+' '+(x.app.ln||''), x.addr, STATUS_LBL(x.app), x.app.score||0]; }),
    colWidths: [30,34,20,10],
    filename:  nationShort() + '_Likely_Already_Housed_' + today
  };

  var existing = document.getElementById('modalLikelyHoused');
  if (existing) existing.remove();
  var mo = document.createElement('div');
  mo.className = 'modal-ov';
  mo.id = 'modalLikelyHoused';
  mo.innerHTML =
    '<div class="modal" style="max-width:920px;width:96%;max-height:92vh;display:flex;flex-direction:column;overflow:hidden;">'
    + '<div class="modal-hdr modal-hdr-stack" style="flex-shrink:0;">'
    +   '<div><h2>Likely Already Housed</h2>'
    +     '<div style="font-size:11px;opacity:.7;margin-top:2px;max-width:640px;">'+list.length+' application'+(list.length===1?'':'s')+' matched to a house. Reclassify each, or use the bulk button. Nothing changes until you click.</div>'
    +   '</div>'
    +   '<div class="flex-gap8 flex-wrap" style="align-items:center;">'
    +     '<button class="btn btn-ghost-dark" onclick="_kpiDrillPrint()">&#128438; Print</button>'
    +     '<div class="export-dropdown"><button onclick="toggleExportMenu(this)" class="btn btn-primary">&#128196; Export</button>'
    +       '<div class="header-export-menu">'
    +         '<button onclick="_kpiDrillExport(\'pdf\')"   class="header-export-item">Save as PDF</button>'
    +         '<button onclick="_kpiDrillExport(\'excel\')" class="header-export-item">Excel (.xlsx)</button>'
    +         '<button onclick="_kpiDrillExport(\'csv\')"   class="header-export-item">CSV</button>'
    +       '</div></div>'
    +     '<button class="modal-close" onclick="_closeLikelyHoused()">&#x2715;</button>'
    +   '</div>'
    + '</div>'
    + (list.length ? '<div style="flex-shrink:0;padding:10px 16px;border-bottom:1px solid var(--border);background:var(--bg);"><button class="btn btn-primary" style="width:100%;" onclick="_reclassifyAllHoused()" title="Set every listed application to File Update (existing tenant)">&#8635; Reclassify all '+list.length+' to File Update</button></div>' : '')
    + '<div class="modal-body" style="padding:0;flex:1;min-height:0;overflow:auto;-webkit-overflow-scrolling:touch;"><div class="tbl-wrap" style="min-width:100%;">'
    +   '<table class="tbl" style="min-width:640px;"><thead><tr><th>Applicant</th><th>Current Address</th><th>Status</th><th class="std-cell-right">Score</th><th>Reclassify</th></tr></thead><tbody>'
    +   rowsHtml
    +   '</tbody></table>'
    + '</div></div>'
    + '</div>';
  mo.addEventListener('click', function(e){ if (e.target === mo) _closeLikelyHoused(); });
  document.body.appendChild(mo);
  mo.style.display = '';
  mo.classList.add('on');
}
window.showLikelyHousedReport = showLikelyHousedReport;

function _closeLikelyHoused(){ var m = document.getElementById('modalLikelyHoused'); if (m) m.remove(); }
window._closeLikelyHoused = _closeLikelyHoused;

async function _reclassifyApp(appId, newType){
  var apps = (typeof applications !== 'undefined' && applications) ? applications : [];
  var idx = apps.findIndex(function(a){ return a && a.id === appId; });
  if (idx < 0) return;
  if (!_mgmtActionGate()) return;
  var role = window.currentRole || 'staff';
  var a = apps[idx];
  var typeLbl = (newType === 'transfer_request') ? 'Existing House Request (transfer)' : 'File Update (existing tenant)';
  var name = ((a.fn||'')+' '+(a.ln||'')).trim() || a.id;
  var go = (typeof showConfirm === 'function')
    ? await showConfirm({ title:'Reclassify application?', message:'Change ' + name + '’s application from New Application to ' + typeLbl + '?', confirmText:'Reclassify', cancelText:'Cancel' })
    : window.confirm('Reclassify ' + name + ' to ' + typeLbl + '?');
  if (!go) return;
  var prev = a.appType || 'new_housing';
  a.appType = newType;
  _saveAppRecord(a);
  if (typeof auditEntry === 'function') auditEntry(a.id, 'app_reclassified', 'Application type changed from ' + prev + ' to ' + newType + ' (Likely-Already-Housed review)', role);
  if (typeof showToast === 'function') showToast(name + ' reclassified to ' + typeLbl + '.', {type:'info'});
  if (typeof _renderLandingKpis === 'function') _renderLandingKpis();
  showLikelyHousedReport();  // refresh — the reclassified row drops off the list
}
window._reclassifyApp = _reclassifyApp;

// Bulk: set every listed housed application to File Update (existing tenant).
async function _reclassifyAllHoused(){
  if (!_mgmtActionGate()) return;
  var role = window.currentRole || 'staff';
  var list = _housingLikelyHousedApps();
  if (!list.length) { if (typeof showToast === 'function') showToast('Nothing to reclassify.', {type:'info'}); return; }
  var go = (typeof showConfirm === 'function')
    ? await showConfirm({ title:'Reclassify all to File Update?', message:'Set all ' + list.length + ' housed applications to File Update (existing tenant)? They will drop off the New Applications count. This does not change their unit or tenancy.', confirmText:'Reclassify all', cancelText:'Cancel' })
    : window.confirm('Reclassify all ' + list.length + ' to File Update?');
  if (!go) return;
  var done = 0;
  list.forEach(function(x){
    var a = x.app; if (!a) return;
    var prev = a.appType || 'new_housing';
    if (prev === 'existing_tenant') return;
    a.appType = 'existing_tenant';
    _saveAppRecord(a);
    if (typeof auditEntry === 'function') auditEntry(a.id, 'app_reclassified', 'Application type changed from ' + prev + ' to existing_tenant (bulk Likely-Already-Housed cleanup)', role);
    done++;
  });
  if (typeof showToast === 'function') showToast(done + ' application' + (done===1?'':'s') + ' reclassified to File Update.', {type:'info'});
  if (typeof _renderLandingKpis === 'function') _renderLandingKpis();
  showLikelyHousedReport();  // refresh — the list should now be empty
}
window._reclassifyAllHoused = _reclassifyAllHoused;

// ── Units <-> Applications reconciliation ───────────────────────────────────
// Accounts for EVERY unit (so assigned + vacant + everything else = total) and
// surfaces the application-side duplicates/stale links that inflate the counts.
function _housingReconcile(){
  var apps  = (typeof applications !== 'undefined' && applications) ? applications : [];
  var units = (typeof housingUnits  !== 'undefined' && housingUnits)  ? housingUnits  : [];
  var norm  = function(s){ return (s||'').toString().toLowerCase().replace(/\s+/g,' ').trim(); };

  // Every unit lands in exactly one bucket. Condemned gets its OWN bucket:
  // it used to fall into `other` ("Other / no status"), which both mislabeled
  // a legitimate state and put condemned units in the Set-to-Vacant sweep's
  // target list — one click away from becoming assignable again.
  var buckets = { assigned:[], vacant:[], reno:[], reserved:[], newconst:[], condemned:[], archived:[], other:[] };
  units.forEach(function(u){
    if(!u) return;
    if(u.archived){ buckets.archived.push(u); return; }
    var st = (u.status||'').toLowerCase();
    if(u.assignedName || u.assignedTo){ buckets.assigned.push(u); }
    else if(st === 'vacant'){ buckets.vacant.push(u); }
    else if(st === 'condemned'){ buckets.condemned.push(u); }
    else if(st === 'new_construction'){ buckets.newconst.push(u); }
    else if(u.under_renovation || st.indexOf('renovat') !== -1 || st.indexOf('repair') !== -1){ buckets.reno.push(u); }
    else if(st === 'reserved'){ buckets.reserved.push(u); }
    else { buckets.other.push(u); }
  });

  var activeApps = apps.filter(function(a){ return a && !a.archived && a.status!=='declined'; });
  var unitById   = {}; units.forEach(function(u){ if(u && !u.archived) unitById[u.id]=u; });
  var appById    = {}; activeApps.forEach(function(a){ appById[a.id]=a; });

  // People with more than one active application (by name).
  var byName = {};
  activeApps.forEach(function(a){ var k=norm((a.fn||'')+' '+(a.ln||'')); if(!k) return; (byName[k]=byName[k]||[]).push(a); });
  var dupPeople = Object.keys(byName).filter(function(k){ return byName[k].length>1; })
    .map(function(k){ return { name:((byName[k][0].fn||'')+' '+(byName[k][0].ln||'')).trim() || '(no name)', apps:byName[k] }; })
    .sort(function(x,y){ return y.apps.length-x.apps.length; });
  var dupExtra = dupPeople.reduce(function(s,p){ return s+(p.apps.length-1); }, 0);

  // Applications claiming a unit that is missing / vacant / held by someone else.
  var stale = activeApps.filter(function(a){
    if(!a.assignedUnit && a.status!=='assigned') return false;
    var u = a.assignedUnit ? unitById[a.assignedUnit] : null;
    if(a.assignedUnit && !u) return true;                                 // unit missing/archived
    if(u && !(u.assignedName || u.assignedTo)) return true;               // unit is vacant
    if(u && u.assignedTo && u.assignedTo!==a.id
        && norm(u.assignedName)!==norm((a.fn||'')+' '+(a.ln||''))) return true;  // held by someone else
    return false;
  }).map(function(a){
    var u = a.assignedUnit ? unitById[a.assignedUnit] : null;
    var why = !u ? 'Unit not found' : (!(u.assignedName||u.assignedTo) ? 'Unit is vacant' : 'Unit held by ' + (u.assignedName||'someone else'));
    return { app:a, claimed:(a.assignedAddress || a.assignedUnit || '—'), why:why };
  });

  // Occupied units nothing references (no linked app, no claim, no name match).
  var occNoApp = buckets.assigned.filter(function(u){
    // Commercial / admin / band BUILDINGS are occupied by a department or
    // business, not a member — they never need a person-style file-update
    // application, so the create-apps sweep must not offer to mint one.
    var _sec = window._SECONDARY_TYPES || ['commercial_building', 'admin_building', 'band_building'];
    if(_sec.indexOf(u.type) !== -1) return false;
    if(u.assignedTo && appById[u.assignedTo]) return false;
    if(activeApps.some(function(a){ return a.assignedUnit===u.id; })) return false;
    if(activeApps.some(function(a){ return norm((a.fn||'')+' '+(a.ln||''))===norm(u.assignedName); })) return false;
    return true;
  });

  // New Applications from ON-RESERVE members with no Living Situation on file
  // (or an own-home contradiction) — the doubled-up cleanup backlog. These
  // predate the Living Situation field; new intakes can't reach this state
  // (the on-reserve validation blocks them).
  var _housedIdx3 = (typeof buildHousedIndex === 'function') ? buildHousedIndex(units) : {};
  var onRezUnclassified = activeApps.filter(function(a){
    if(a.deceased || a.status === 'draft') return false;
    if(!appIsWaitlistType(a.appType)) return false;
    if(appIsHoused(a, _housedIdx3)) return false;   // housed — Likely-Housed handles those
    // Same shared rule as the wizard validation + Residency-card badges.
    return typeof onRezNewAppIssue === 'function' && onRezNewAppIssue(a.reserve, a.livingSituation || '') !== '';
  }).sort(function(x,y){ return (y.score||0)-(x.score||0); });

  // Address check — ONLY for applicants actually assigned to a unit: does the
  // application's own street line match the assigned unit's address? Drift
  // happens when the address was typed at intake and the person was later
  // housed (or migrated data kept the old address). The UNIT address is the
  // authoritative one; the Merge action writes it onto the application.
  function _normAddr(x){ return String(x || '').toLowerCase().replace(/[.,#]/g, ' ').replace(/\s+/g, ' ').trim(); }
  var addrMismatch = [];
  activeApps.forEach(function(a){
    if (a.deceased) return;
    var unit = (a.assignedUnit && unitById[a.assignedUnit]) ? unitById[a.assignedUnit]
      : units.find(function(u){ return u && !u.archived && u.assignedTo === a.id; }) || null;
    if (!unit) return;
    var unitAddr = ((unit.num || '') + ' ' + (unit.street || '')).trim();
    if (!unitAddr) return;
    var appAddr = (a.street || '').trim();
    var na = _normAddr(appAddr), nu = _normAddr(unitAddr);
    // A blank application address is a mismatch too — it should carry the
    // unit's. Containment either way counts as a match ("1 Main St" vs
    // "1 Main").
    if (na && (na === nu || na.indexOf(nu) !== -1 || nu.indexOf(na) !== -1)) return;
    addrMismatch.push({ app: a, unit: unit, unitAddr: unitAddr, appAddr: appAddr || '(blank)' });
  });

  // Units missing Year Built — the rent age factor falls back to 1.00
  // (unverified) for these, so the adjusted target rent can't be computed
  // properly. A valid Major Renovation Year also counts (it IS the effective
  // year). Archived and condemned units are excluded (not rent-bearing).
  function _validYr(v){ var n = parseInt(v, 10); return !isNaN(n) && n >= 1800 && n <= 2200; }
  var missingYear = units.filter(function(u){
    if (!u || u.archived || u.status === 'condemned') return false;
    if (typeof rentAgeInfo === 'function') return rentAgeInfo(u).source === 'no_year';
    return !_validYr(u.year) && !_validYr(u.majorRenoYear);
  });

  // Total = ACTIVE units only — archived (demolished/removed) units are
  // history, not stock, so they don't inflate the headline count. They keep
  // their own state-table row for the full accounting.
  return { totalUnits:(units.length - buckets.archived.length), buckets:buckets, dupPeople:dupPeople, dupExtra:dupExtra, stale:stale, occNoApp:occNoApp, onRezUnclassified:onRezUnclassified, addrMismatch:addrMismatch, missingYear:missingYear };
}

function showReconcileReport(){
  var R = _housingReconcile();
  var esc = (typeof escapeHtml === 'function') ? escapeHtml : function(s){ return String(s==null?'':s); };
  var uAddr = function(u){ return ((u.num||'')+' '+(u.street||'')).trim() || u.id || '—'; };
  // Condemned is an ACCEPTED unit state (its own bucket, own KPI) — it does
  // not belong in the "gap" of unexplained units.
  var gap = R.buckets.reno.concat(R.buckets.reserved, R.buckets.other);   // the "not assigned / not vacant" units
  // Break the gap down by its raw status value so the "other / no status" units
  // are explained (e.g. left as 'updated' after an edit, or blank).
  var gapByStatus = {};
  gap.forEach(function(u){ var s = (u.status && String(u.status).trim()) ? u.status : '(blank)'; gapByStatus[s] = (gapByStatus[s]||0)+1; });
  var gapStatusTbl = '<table class="tbl" style="margin-bottom:8px;"><thead><tr><th>Status value</th><th class="std-cell-right">Units</th></tr></thead><tbody>'
    + Object.keys(gapByStatus).sort(function(a,b){ return gapByStatus[b]-gapByStatus[a]; })
        .map(function(s){ return '<tr><td>'+esc(s)+'</td><td class="std-cell-right" style="font-weight:700;">'+gapByStatus[s]+'</td></tr>'; }).join('')
    + '</tbody></table>';
  var _otherN = R.buckets.other.length;
  var markVacantBtn = _otherN
    ? '<button class="btn btn-primary" style="margin-bottom:10px;" onclick="_reconMarkVacant()">&#8635; Set '+_otherN+' no-status unit'+(_otherN===1?'':'s')+' to Vacant</button>'
      + '<div style="font-size:11px;color:var(--muted);margin-bottom:8px;">These have no tenant and no clear status. Units under renovation or reserved are left as-is; condemned units are an accepted state and not listed here.</div>'
    : '';

  function tile(label, val, color){
    return '<div style="flex:1 1 120px;min-width:120px;border:1px solid var(--border);border-radius:10px;padding:10px 12px;">'
      + '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);">'+label+'</div>'
      + '<div style="font-size:22px;font-weight:800;'+(color?'color:'+color+';':'')+'">'+val+'</div></div>';
  }
  function stateRow(label, arr, note){
    return '<tr><td>'+label+'</td><td class="std-cell-right" style="font-weight:700;">'+arr.length+'</td><td class="std-cell-muted">'+(note||'')+'</td></tr>';
  }

  var stateTbl =
    '<table class="tbl"><thead><tr><th>Unit state</th><th class="std-cell-right">Count</th><th></th></tr></thead><tbody>'
    + stateRow('Assigned / occupied', R.buckets.assigned)
    + stateRow('Vacant', R.buckets.vacant)
    + stateRow('Under renovation / repair', R.buckets.reno)
    + stateRow('Reserved (no tenant)', R.buckets.reserved)
    + stateRow('New Construction', R.buckets.newconst, R.buckets.newconst.length ? 'accepted state' : '')
    + stateRow('Condemned', R.buckets.condemned, R.buckets.condemned.length ? 'accepted state' : '')
    + stateRow('Other / no status', R.buckets.other, R.buckets.other.length ? 'see below' : '')
    + stateRow('Archived', R.buckets.archived, R.buckets.archived.length ? 'not counted in total' : '')
    + '<tr style="border-top:2px solid var(--border);"><td style="font-weight:800;">Total active units</td><td class="std-cell-right" style="font-weight:800;">'+R.totalUnits+'</td><td></td></tr>'
    + '</tbody></table>';

  var gapTbl = gap.length
    ? '<table class="tbl"><thead><tr><th>Unit</th><th>State</th><th>Status field</th></tr></thead><tbody>'
      + gap.map(function(u){
          var state = (u.under_renovation || (u.status||'').toLowerCase().indexOf('renovat')!==-1 || (u.status||'').toLowerCase().indexOf('repair')!==-1) ? 'Under renovation'
                    : ((u.status||'').toLowerCase()==='reserved' ? 'Reserved' : 'Other / no status');
          return '<tr class="clickable" onclick="_closeReconcile();window.location.href=\'inventory.html?unit='+esc(String(u.id).replace(/'/g,""))+'\'">'
            + '<td style="font-weight:600;">'+esc(uAddr(u))+'</td><td>'+state+'</td><td class="std-cell-muted">'+esc(u.status||'(none)')+'</td></tr>';
        }).join('')
      + '</tbody></table>'
    : '<div style="padding:12px;color:var(--muted);font-size:12px;">Every unit is either assigned or vacant.</div>';

  var dupTbl = R.dupPeople.length
    ? '<table class="tbl"><thead><tr><th>Applicant</th><th class="std-cell-right"># Apps</th><th>Types / statuses</th><th>Action</th></tr></thead><tbody>'
      + R.dupPeople.slice(0,80).map(function(p){
          var types = p.apps.map(function(a){ return (a.appType||'new_housing').replace('_',' '); }).join(', ');
          var ids = p.apps.map(function(a){ return a.id; }).join(',');
          return '<tr><td style="font-weight:600;">'+esc(p.name)+'</td><td class="std-cell-right" style="font-weight:700;">'+p.apps.length+'</td><td class="std-cell-muted">'+esc(types)+'</td>'
            + '<td><button class="btn btn-ghost btn-xs" onclick="_reconMergePrompt(\''+esc(ids)+'\')">&#8646; Merge</button></td></tr>';
        }).join('')
      + '</tbody></table>' + (R.dupPeople.length>80 ? '<div style="padding:8px 12px;color:var(--muted);font-size:11px;">Showing first 80 of '+R.dupPeople.length+'. Export for the full list.</div>' : '')
    : '<div style="padding:12px;color:var(--muted);font-size:12px;">No applicant has more than one active application.</div>';

  var staleTbl = R.stale.length
    ? '<table class="tbl"><thead><tr><th>Applicant</th><th>Claimed unit</th><th>Issue</th><th></th></tr></thead><tbody>'
      + R.stale.map(function(s){
          var a=s.app; var sid=(a.id||'').replace(/'/g,"\\'");
          return '<tr><td style="font-weight:600;">'+esc((a.fn||'')+' '+(a.ln||''))+'</td><td class="std-cell-muted">'+esc(s.claimed)+'</td><td class="std-cell-muted">'+esc(s.why)+'</td>'
            + '<td><button class="btn btn-ghost btn-xs" onclick="_reconClearLink(\''+sid+'\')">Clear link</button></td></tr>';
        }).join('')
      + '</tbody></table>'
    : '<div style="padding:12px;color:var(--muted);font-size:12px;">No stale unit links.</div>';

  // On-reserve New Applications with no living situation — doubled-up cleanup.
  var _orN = R.onRezUnclassified.length;
  var _orBlankN = R.onRezUnclassified.filter(function(a){ return !a.livingSituation; }).length;
  var onRezBulkBtn = _orBlankN
    ? '<button class="btn btn-primary" style="margin-bottom:10px;" onclick="_reconMarkAllDoubledUp()">&#128101; Mark all '+_orBlankN+' as Doubled Up</button>'
      + '<div style="font-size:11px;color:var(--muted);margin-bottom:8px;">On-reserve members with a New Application, no unit, and no Living Situation on file. Marking them Doubled Up sets Living Situation to &ldquo;Staying with family on reserve&rdquo; — they stay New Applications and keep their place on the waitlist. Anyone listed with &ldquo;own home&rdquo; should be opened and reclassified instead.</div>'
    : '';
  var onRezTbl = _orN
    ? '<table class="tbl"><thead><tr><th>Applicant</th><th>Status</th><th class="std-cell-right">Score</th><th>Living Situation</th><th></th></tr></thead><tbody>'
      + R.onRezUnclassified.slice(0,120).map(function(a){
          var sid = (a.id||'').replace(/'/g,"\\'");
          var lsLbl = a.livingSituation === 'own_home'
            ? '<span style="font-weight:700;color:var(--danger);">Own home — reclassify</span>'
            : '<span class="std-cell-muted">(not set)</span>';
          return '<tr><td style="font-weight:600;">'+esc((a.fn||'')+' '+(a.ln||''))+'</td>'
            + '<td class="std-cell-muted">'+esc((typeof formatAppStatusLabel==='function' ? formatAppStatusLabel(a.status,{variant:'kpi'}) : a.status) || a.status || '')+'</td>'
            + '<td class="std-cell-right" style="font-weight:700;">'+(a.score||0)+'</td>'
            + '<td>'+lsLbl+'</td>'
            + '<td><div style="display:flex;flex-wrap:wrap;gap:4px;">'
            + (a.livingSituation === 'own_home' ? '' :
               '<button class="btn btn-ghost btn-xs" onclick="_reconMarkDoubledUp(\''+sid+'\')">&#128101; Doubled Up</button>')
            + '<button class="btn btn-ghost btn-xs" onclick="_closeReconcile();if(typeof window.openEditModal===\'function\')window.openEditModal(\''+sid+'\');">Open</button>'
            + '</div></td></tr>';
        }).join('')
      + '</tbody></table>' + (_orN>120 ? '<div style="padding:8px 12px;color:var(--muted);font-size:11px;">Showing first 120 of '+_orN+'.</div>' : '')
    : '<div style="padding:12px;color:var(--muted);font-size:12px;">Every on-reserve new application has a living situation on file.</div>';

  // Address check — assigned applicants whose application address differs
  // from their unit's. Merge writes the unit address (the winner) onto the
  // application's street line; city/province/postal are left as entered.
  var _amN = R.addrMismatch.length;
  var addrBulkBtn = _amN
    ? '<button class="btn btn-primary" style="margin-bottom:10px;" onclick="_reconMergeAllAddresses()">&#127968; Merge all '+_amN+' to the unit address</button>'
      + '<div style="font-size:11px;color:var(--muted);margin-bottom:8px;">The unit address wins: merging copies the assigned unit\u2019s address onto the application\u2019s street line (city/province/postal are left as entered). Each merge is audited.</div>'
    : '';
  var addrTbl = _amN
    ? '<table class="tbl"><thead><tr><th>Applicant</th><th>Application address</th><th>Unit address</th><th></th></tr></thead><tbody>'
      + R.addrMismatch.slice(0,120).map(function(x){
          var a = x.app, sid = (a.id||'').replace(/'/g,"\\'");
          return '<tr><td style="font-weight:600;">'+esc((a.fn||'')+' '+(a.ln||''))+'</td>'
            + '<td class="std-cell-muted">'+esc(x.appAddr)+'</td>'
            + '<td style="font-weight:600;">'+esc(x.unitAddr)+'</td>'
            + '<td><div style="display:flex;flex-wrap:wrap;gap:4px;">'
            + '<button class="btn btn-ghost btn-xs" onclick="_reconMergeAddress(\''+sid+'\')">&#8646; Merge &rarr; unit</button>'
            + '<button class="btn btn-ghost btn-xs" onclick="_closeReconcile();if(typeof window.openEditModal===\'function\')window.openEditModal(\''+sid+'\');">Open</button>'
            + '</div></td></tr>';
        }).join('')
      + '</tbody></table>' + (_amN>120 ? '<div style="padding:8px 12px;color:var(--muted);font-size:11px;">Showing first 120 of '+_amN+'.</div>' : '')
    : '<div style="padding:12px;color:var(--muted);font-size:12px;">Every assigned applicant\u2019s address matches their unit.</div>';

  // BCR entries missing details — Tenant-Card stubs (blocking is already in
  // effect for them) waiting for the BCR date/reason to be completed.
  var bcrIncomplete = (window._bcrRegistry || []).filter(function(b){
    return b && b.active !== false && (typeof bcrIsIncomplete === 'function' ? bcrIsIncomplete(b) : !b.bcrd_date);
  });
  var bcrTbl = bcrIncomplete.length
    ? '<div style="font-size:11px;color:var(--muted);margin-bottom:8px;">These people ARE already blocked from housing — only the BCR paperwork details (date / resolution number) are missing.</div>'
      + '<table class="tbl"><thead><tr><th>Name</th><th>Reason on file</th><th>BCR date</th><th></th></tr></thead><tbody>'
      + bcrIncomplete.map(function(b){
          // Name goes in a data-attribute (HTML-escaped) and is read back via
          // dataset by the delegated click handler below — never interpolated
          // into an onclick string, where quotes in a real name break out of
          // the attribute (applicant-typed names reach this table).
          return '<tr><td style="font-weight:600;">'+esc(b.full_name||'—')+'</td>'
            + '<td class="std-cell-muted">'+esc(b.reason||'—')+'</td>'
            + '<td class="std-cell-muted">'+esc(b.bcrd_date||'(missing)')+'</td>'
            + '<td><button class="btn btn-ghost btn-xs" data-bcr-complete="'+esc(b.full_name||'')+'">Complete &rarr;</button></td></tr>';
        }).join('')
      + '</tbody></table>'
    : '<div style="padding:12px;color:var(--muted);font-size:12px;">Every BCR entry has its details on file.</div>';

  // Units missing Year Built — rent age factor stuck at the unverified 1.00
  // fallback until a year (or major renovation year) is entered on the card.
  var _myN = (R.missingYear || []).length;
  var missingYearTbl = _myN
    ? '<div style="font-size:11px;color:var(--muted);margin-bottom:8px;">These units rent at age factor 1.00 (unverified fallback) — enter Year Built (or a Major Renovation Year) on the unit card and the adjusted target rent recalculates automatically.</div>'
      + '<table class="tbl"><thead><tr><th>Unit</th><th>Status</th><th>Tenant</th></tr></thead><tbody>'
      + R.missingYear.slice(0,120).map(function(u){
          return '<tr class="clickable" onclick="_closeReconcile();window.location.href=\'inventory.html?unit='+esc(String(u.id).replace(/'/g,""))+'\'">'
            + '<td style="font-weight:600;">'+esc(uAddr(u))+'</td>'
            + '<td class="std-cell-muted">'+esc(u.status||'—')+'</td>'
            + '<td class="std-cell-muted">'+esc(u.assignedName||'—')+'</td></tr>';
        }).join('')
      + '</tbody></table>' + (_myN>120 ? '<div style="padding:8px 12px;color:var(--muted);font-size:11px;">Showing first 120 of '+_myN+'.</div>' : '')
    : '<div style="padding:12px;color:var(--muted);font-size:12px;">Every active unit has a construction year on file.</div>';

  // Backfill button — creates a linked tenant-file application for every
  // occupied unit missing one (migrated/test data), restoring TIC linkage.
  var noAppBtn = R.occNoApp.length
    ? '<button class="btn btn-primary" style="margin-bottom:10px;" onclick="_reconCreateAppsForOccupied()">&#128196; Create tenant file applications for all ' + R.occNoApp.length + '</button>'
      + '<div style="font-size:11px;color:var(--muted);margin-bottom:8px;">Creates an <strong>Existing Tenant (file update)</strong> application per unit — linked to the unit and tenant so the Tenant Card works — never scored, never on the waitlist or Match. Each creation is audited.</div>'
    : '';
  var noAppTbl = R.occNoApp.length
    ? '<table class="tbl"><thead><tr><th>Unit</th><th>Tenant</th></tr></thead><tbody>'
      + R.occNoApp.slice(0,80).map(function(u){
          return '<tr class="clickable" onclick="_closeReconcile();window.location.href=\'inventory.html?unit='+esc(String(u.id).replace(/'/g,""))+'\'"><td style="font-weight:600;">'+esc(uAddr(u))+'</td><td class="std-cell-muted">'+esc(u.assignedName||'—')+'</td></tr>';
        }).join('')
      + '</tbody></table>'
    : '<div style="padding:12px;color:var(--muted);font-size:12px;">Every occupied unit has an application on file.</div>';

  // Export = the gap units (the immediate "missing" question).
  _kpiDrillData = {
    title:     'Unit Reconciliation',
    headers:   ['Unit','State','Status field'],
    rows:      gap.map(function(u){ return [uAddr(u), (u.status||'(none)'), u.status||'']; }),
    colWidths: [40,30,30],
    filename:  nationShort() + '_Unit_Reconciliation_' + new Date().toISOString().slice(0,10)
  };

  var existing = document.getElementById('modalReconcile');
  if (existing) existing.remove();
  var mo = document.createElement('div');
  mo.className = 'modal-ov'; mo.id = 'modalReconcile';
  var secH = function(t, n, color){ return '<div style="margin:18px 2px 8px;font-size:13px;font-weight:800;color:'+(color||'var(--text)')+';">'+t+(n!=null?' <span style="color:var(--muted);font-weight:600;">('+n+')</span>':'')+'</div>'; };
  mo.innerHTML =
    '<div class="modal" style="max-width:960px;width:96%;max-height:92vh;display:flex;flex-direction:column;overflow:hidden;">'
    + '<div class="modal-hdr modal-hdr-stack" style="flex-shrink:0;">'
    +   '<div><h2>Unit &amp; Application Reconciliation</h2>'
    +     '<div class="modal-hdr-sub">Accounts for every unit, and finds the duplicate/stale applications that inflate the counts.</div>'
    +   '</div>'
    +   '<div class="flex-gap8 flex-wrap" style="align-items:center;">'
    +     '<button class="btn btn-ghost-dark" onclick="_kpiDrillPrint()">&#128438; Print</button>'
    +     '<div class="export-dropdown"><button onclick="toggleExportMenu(this)" class="btn btn-primary">&#128196; Export gap</button>'
    +       '<div class="header-export-menu">'
    +         '<button onclick="_kpiDrillExport(\'excel\')" class="header-export-item">Excel (.xlsx)</button>'
    +         '<button onclick="_kpiDrillExport(\'csv\')"   class="header-export-item">CSV</button>'
    +       '</div></div>'
    +     '<button class="modal-close" onclick="_closeReconcile()">&#x2715;</button>'
    +   '</div>'
    + '</div>'
    + '<div class="modal-body" style="padding:16px;flex:1;min-height:0;overflow:auto;-webkit-overflow-scrolling:touch;">'
    +   '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:6px;">'
    +     tile('Total active units', R.totalUnits)
    +     tile('Assigned', R.buckets.assigned.length)
    +     tile('Vacant', R.buckets.vacant.length)
    +     tile('Not assigned/vacant', gap.length, gap.length ? '#b45309' : '')
    +     tile('Duplicate apps', R.dupExtra, R.dupExtra ? '#b45309' : '')
    +   '</div>'
    +   secH('Units by state — every unit accounted for')
    +   stateTbl
    +   secH('Units not assigned or vacant (the gap)', gap.length, gap.length?'#b45309':null)
    +   gapStatusTbl
    +   markVacantBtn
    +   gapTbl
    +   secH('On-reserve new applications — living situation not set', R.onRezUnclassified.length, R.onRezUnclassified.length?'var(--warn-amber-text)':null)
    +   onRezBulkBtn
    +   onRezTbl
    +   secH('People with more than one application', R.dupExtra+' extra', R.dupExtra?'#b45309':null)
    +   dupTbl
    +   secH('Applications with a stale unit link', R.stale.length, R.stale.length?'#b45309':null)
    +   staleTbl
    +   secH('Address check \u2014 application vs assigned unit', R.addrMismatch.length, R.addrMismatch.length?'var(--warn-amber-text)':null)
    +   addrBulkBtn
    +   addrTbl
    +   secH('BCR entries missing details', bcrIncomplete.length, bcrIncomplete.length?'var(--warn-amber-text)':null)
    +   bcrTbl
    +   secH('Units missing Year Built (rent age factor unverified)', _myN, _myN?'var(--warn-amber-text)':null)
    +   missingYearTbl
    +   secH('Occupied units with no application', R.occNoApp.length, R.occNoApp.length?'var(--warn-amber-text)':null)
    +   noAppBtn
    +   noAppTbl
    + '</div>'
    + '</div>';
  mo.addEventListener('click', function(e){
    if (e.target === mo) { _closeReconcile(); return; }
    var btn = e.target.closest && e.target.closest('[data-bcr-complete]');
    if (btn) {
      var nm = btn.getAttribute('data-bcr-complete') || '';
      _closeReconcile();
      if (typeof openBcrManager === 'function') openBcrManager(nm);
    }
  });
  document.body.appendChild(mo);
  mo.style.display = ''; mo.classList.add('on');
}
window.showReconcileReport = showReconcileReport;

function _closeReconcile(){ var m = document.getElementById('modalReconcile'); if (m) m.remove(); }
window._closeReconcile = _closeReconcile;

// ── Shared bits for the review/reconcile actions ─────────────────────────────
// Management gate (7 hand-copies before consolidation) — toasts and returns
// false when the current role can't run cleanup actions.
function _mgmtActionGate(){
  var role = window.currentRole || 'staff';
  if (typeof ROLE !== 'undefined' && ROLE.isManagement && !ROLE.isManagement(role)) {
    if (typeof showToast === 'function') showToast('Only management can do this.', { type:'error' });
    return false;
  }
  return true;
}
// Draft-fallback-or-direct application save (8 hand-copies before).
function _saveAppRecord(a){
  if (typeof saveApplicationWithDraftFallback === 'function') { saveApplicationWithDraftFallback(a); return; }
  if (typeof sbSaveApplication === 'function') sbSaveApplication(a).catch(function(){});
}

// ── Archived applications — the restore surface for soft-deleted records ─────
// Same authority as deleting (deleteApplication). Restore clears the archived
// flag, stamps restoredAt/restoredBy (archive history is kept), audits, saves.
function showArchivedApplications(){
  var esc = (typeof escapeHtml === 'function') ? escapeHtml : function(x){ return String(x == null ? '' : x); };
  var apps = (typeof applications !== 'undefined' && applications) ? applications : [];
  var list = apps.filter(function(a){ return a && a.archived; })
    .slice().sort(function(x, y){ return String(y.archivedAt || '').localeCompare(String(x.archivedAt || '')); });
  var canDel = (typeof APPROVAL_AUTHORITY !== 'undefined') && APPROVAL_AUTHORITY.can('deleteApplication', window.currentRole);
  var rows = list.length ? list.slice(0, 150).map(function(a){
    var sid = (a.id || '').replace(/'/g, "\\'");
    var name = ((a.fn || '') + ' ' + (a.ln || '')).trim() || a.id;
    var mergedNote = a.mergedInto ? '<div style="font-size:10px;color:var(--muted);">Merged into ' + esc(a.mergedInto) + '</div>' : '';
    return '<tr><td style="font-weight:600;">' + esc(name) + mergedNote + '</td>'
      + '<td class="std-cell-muted">' + esc(a.id || '') + '</td>'
      + '<td class="std-cell-muted">' + esc((a.appType || 'new_housing').replace(/_/g, ' ')) + '</td>'
      + '<td class="std-cell-muted">' + esc(a.archivedAt || '\u2014') + (a.archivedBy ? ' \u00b7 ' + esc(a.archivedBy) : '') + '</td>'
      + '<td>' + (canDel ? '<button class="btn btn-ghost btn-xs" onclick="_restoreArchivedApp(\'' + sid + '\')">&#8635; Restore</button>' : '') + '</td></tr>';
  }).join('') : '<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:24px;">No archived applications.</td></tr>';
  var ex = document.getElementById('modalArchivedApps'); if (ex) ex.remove();
  var mo = document.createElement('div');
  mo.className = 'modal-ov'; mo.id = 'modalArchivedApps';
  mo.innerHTML =
    '<div class="modal" style="max-width:860px;width:96%;max-height:92vh;display:flex;flex-direction:column;overflow:hidden;">'
    + '<div class="modal-hdr"><div><h2>Archived Applications</h2>'
    + '<div class="modal-hdr-sub">Deleted applications are archived, never destroyed \u2014 restore returns one to the active lists.</div></div>'
    + '<button class="modal-close" onclick="var m=document.getElementById(\'modalArchivedApps\');if(m)m.remove();">&#x2715;</button></div>'
    + '<div class="modal-body" style="padding:0 16px 16px;flex:1;min-height:0;overflow:auto;-webkit-overflow-scrolling:touch;">'
    + '<table class="tbl"><thead><tr><th>Applicant</th><th>App ID</th><th>Type</th><th>Archived</th><th></th></tr></thead><tbody>'
    + rows + '</tbody></table>'
    + (list.length > 150 ? '<div style="padding:8px 12px;color:var(--muted);font-size:11px;">Showing first 150 of ' + list.length + '.</div>' : '')
    + '</div></div>';
  mo.addEventListener('click', function(e){ if (e.target === mo) mo.remove(); });
  document.body.appendChild(mo);
  mo.style.display = ''; mo.classList.add('on');
}
window.showArchivedApplications = showArchivedApplications;

async function _restoreArchivedApp(appId){
  if (typeof APPROVAL_AUTHORITY === 'undefined' || !APPROVAL_AUTHORITY.can('deleteApplication', window.currentRole)) {
    if (typeof showToast === 'function') showToast('You are not authorized to restore applications.', { type:'error' });
    return;
  }
  var role = window.currentRole || 'staff';
  var apps = (typeof applications !== 'undefined' && applications) ? applications : [];
  var a = apps.find(function(x){ return x && x.id === appId; });
  if (!a || !a.archived) return;
  var escFn = (typeof escapeHtml === 'function') ? escapeHtml : function(x){ return String(x == null ? '' : x); };
  var name = ((a.fn || '') + ' ' + (a.ln || '')).trim() || a.id;
  var msg = 'Restore ' + escFn(name) + '\u2019s application to the active lists?';
  if (a.mergedInto) msg += ' NOTE: this application was merged into ' + escFn(a.mergedInto) + ' \u2014 restoring it recreates a duplicate for that person.';
  var go = (typeof showConfirm === 'function')
    ? await showConfirm({ title: 'Restore application?', message: msg, confirmText: 'Restore', cancelText: 'Cancel' })
    : window.confirm('Restore ' + name + '?');
  if (!go) return;
  a.archived = false;
  a.restoredAt = new Date().toISOString().split('T')[0];
  a.restoredBy = role;
  _saveAppRecord(a);
  if (typeof auditEntry === 'function') auditEntry(a.id, 'application_restored', 'Archived application restored to the active lists', role);
  if (typeof showToast === 'function') showToast(name + '\u2019s application restored.', { type:'info' });
  if (typeof _renderLandingKpis === 'function') { try { _renderLandingKpis(); } catch(e){} }
  showArchivedApplications();
}
window._restoreArchivedApp = _restoreArchivedApp;

// Likely-Housed review: "Doubled up — not housed". The applicant lives at the
// linked address but it is NOT their own home (staying with family), so the
// unit link on their application is wrong data. Unlinks the application from
// the unit (unit keeps its tenant NAME + occupied status — the household
// really lives there), restores the app's pre-assignment status, stamps
// Living Situation as doubled-up when blank, and returns them to the
// waitlist / Match as a New Application.
async function _lhMarkNotHoused(appId){
  var apps = (typeof applications !== 'undefined' && applications) ? applications : [];
  var a = apps.find(function(x){ return x && x.id === appId; });
  if (!a) return;
  if (!_mgmtActionGate()) return;
  var role = window.currentRole || 'staff';
  var name = ((a.fn||'')+' '+(a.ln||'')).trim() || a.id;
  var units = (typeof housingUnits !== 'undefined' && housingUnits) ? housingUnits : [];
  var linked = units.filter(function(u){ return u && !u.archived && u.assignedTo === appId; });
  var addr = linked.length ? (((linked[0].num||'')+' '+(linked[0].street||'')).trim()) : (a.assignedAddress || 'the linked unit');
  // Message reflects what will actually change: a unit genuinely pointing at
  // this application gets unlinked (keeping its tenant name); an app-side-only
  // stale link (migrated data — no unit points back) is just cleared.
  // showConfirm renders title/message as HTML — name/addr are record data
  // (portal applicants type their own names) and MUST be escaped.
  var escFn = (typeof escapeHtml === 'function') ? escapeHtml : function(s){ return String(s == null ? '' : s); };
  var eName = escFn(name), eAddr = escFn(addr);
  var msg = linked.length
    ? (eName + ' lives at ' + eAddr + ' but it is not their own home (doubled up). This unlinks their application from the unit — the unit keeps its tenant name and stays occupied — keeps the application a New Application, and returns them to the waitlist and Match.')
    : (eName + ' is not the tenant of record on any unit — their application just carries an old link to ' + eAddr + ' from the previous system. This clears that stale link, keeps the application a New Application, and returns them to the waitlist and Match. No unit record is changed.');
  var go = (typeof showConfirm === 'function')
    ? await showConfirm({
        title: 'Mark ' + eName + ' as not housed?',
        message: msg,
        confirmText: 'Not housed — unlink', cancelText: 'Cancel' })
    : window.confirm('Mark ' + name + ' as not housed and clear the link to ' + addr + '?');
  if (!go) return;
  // Unit side: drop the application link, keep the household's name/occupancy.
  linked.forEach(function(u){
    u.assignedTo = null;
    if (typeof saveUnitWithDraftFallback === 'function') saveUnitWithDraftFallback(u);
  });
  // Application side: clear the assignment cluster, restore approved status.
  clearAppUnitLink(a);
  if (!a.livingSituation) a.livingSituation = 'family_on_reserve';
  _saveAppRecord(a);
  if (typeof auditEntry === 'function') auditEntry(a.id, 'app_marked_not_housed',
    'Marked doubled-up / not housed — unit link to ' + addr + ' removed (Likely-Already-Housed review); stays New Application', role);
  if (typeof showToast === 'function') showToast(name + ' marked as doubled up — back on the waitlist as a New Application.', {type:'info'});
  if (typeof _renderLandingKpis === 'function') _renderLandingKpis();
  showLikelyHousedReport();  // refresh — the row drops off the list
}
window._lhMarkNotHoused = _lhMarkNotHoused;

// Reconcile: doubled-up cleanup — stamp Living Situation on on-reserve New
// Applications that predate the field. Per-row and bulk variants; both
// management-only, audited, and refresh the report + KPIs.
function _reconStampDoubledUp(a, role){
  a.livingSituation = 'family_on_reserve';
  _saveAppRecord(a);
  if (typeof auditEntry === 'function') auditEntry(a.id, 'app_marked_doubled_up',
    'Living Situation set to staying-with-family (doubled up) via reconciliation', role);
}
async function _reconMarkDoubledUp(appId){
  var apps = (typeof applications !== 'undefined' && applications) ? applications : [];
  var a = apps.find(function(x){ return x && x.id === appId; });
  if (!a) return;
  if (!_mgmtActionGate()) return;
  var role = window.currentRole || 'staff';
  _reconStampDoubledUp(a, role);
  if (typeof showToast === 'function') showToast(((a.fn||'')+' '+(a.ln||'')).trim() + ' marked Doubled Up.', {type:'info'});
  if (typeof _renderLandingKpis === 'function') _renderLandingKpis();
  showReconcileReport();
}
window._reconMarkDoubledUp = _reconMarkDoubledUp;
async function _reconMarkAllDoubledUp(){
  if (!_mgmtActionGate()) return;
  var role = window.currentRole || 'staff';
  var R = _housingReconcile();
  // Bulk skips the own-home contradictions — those need a person to reclassify.
  var list = R.onRezUnclassified.filter(function(a){ return !a.livingSituation; });
  if (!list.length) return;
  var go = (typeof showConfirm === 'function')
    ? await showConfirm({
        title: 'Mark ' + list.length + ' applicant' + (list.length===1?'':'s') + ' as Doubled Up?',
        message: 'Sets Living Situation to "Staying with family on reserve (doubled up)" on every on-reserve New Application with no living situation on file. They stay New Applications and keep their waitlist place. Each change is audited.',
        confirmText: 'Mark all Doubled Up', cancelText: 'Cancel' })
    : window.confirm('Mark ' + list.length + ' applicants as Doubled Up?');
  if (!go) return;
  list.forEach(function(a){ _reconStampDoubledUp(a, role); });
  if (typeof showToast === 'function') showToast(list.length + ' applicant' + (list.length===1?'':'s') + ' marked Doubled Up.', {type:'info'});
  if (typeof _renderLandingKpis === 'function') _renderLandingKpis();
  showReconcileReport();
}
window._reconMarkAllDoubledUp = _reconMarkAllDoubledUp;

// Address merge: the assigned unit's address is authoritative — copy it onto
// the application's street line (and the assignedAddress mirror).
// Scorecard Back — mirrors closeApplicationForm's drill-return: when the
// scorecard was opened from a KPI drilldown list (or Likely-Housed report),
// Back reopens that list fresh; otherwise it falls back to the dashboard.
function scorecardBack(){
  var drill = window._appFormReturnDrill || null;
  window._appFormReturnDrill = null;
  if (drill) {
    if (typeof showLanding === 'function') showLanding();
    else if (typeof showEmployeeHome === 'function') showEmployeeHome();
    if (drill === 'likely_housed') {
      if (typeof showLikelyHousedReport === 'function') showLikelyHousedReport();
    } else if (typeof showHousingKpiDrilldown === 'function') {
      showHousingKpiDrilldown(drill);
    }
    return;
  }
  if (typeof showDash === 'function') showDash();
}
window.scorecardBack = scorecardBack;

// Backfill: create a linked tenant-file application for every occupied unit
// that has none (migrated/test data). Type 'existing_tenant' — the file-update
// type is never scored, never on the waitlist or Match — status 'assigned',
// linked both ways (app.assignedUnit + unit.assignedTo) so the TIC resolves,
// with the tenants row's application_id patched when it can be found.
async function _reconCreateAppsForOccupied(){
  if (!_mgmtActionGate()) return;
  var role = window.currentRole || 'staff';
  var R = _housingReconcile();
  var list = R.occNoApp;
  if (!list.length) return;
  var go = (typeof showConfirm === 'function')
    ? await showConfirm({
        title: 'Create ' + list.length + ' tenant file application' + (list.length === 1 ? '' : 's') + '?',
        message: 'Each occupied unit with no application gets an Existing Tenant (file update) application — linked to the unit and tenant so the Tenant Card and workflows resolve. They are never scored, waitlisted, or shown on Match. Every creation is audited.',
        confirmText: 'Create ' + list.length, cancelText: 'Cancel' })
    : window.confirm('Create ' + list.length + ' tenant file applications?');
  if (!go) return;
  var apps = (typeof applications !== 'undefined' && applications) ? applications : (window.applications = []);
  var today = new Date().toISOString().split('T')[0];
  var made = 0;
  for (var i = 0; i < list.length; i++) {
    var u = list[i];
    var name = String(u.assignedName || '').trim();
    if (!name) continue;
    var parts = name.split(/\s+/);
    var addr = ((u.num || '') + ' ' + (u.street || '')).trim();
    // generateAppId scans applications[] — push BEFORE the next iteration so
    // ids increment instead of colliding.
    var id = (typeof generateAppId === 'function') ? generateAppId() : ('APP-BF-' + Date.now() + '-' + i);
    var app = {
      id: id,
      appType: 'existing_tenant',
      status: 'assigned',
      fn: parts[0] || '',
      ln: parts.slice(1).join(' '),
      street: addr,
      assignedUnit: u.id,
      assignedAddress: addr,
      appDate: (u.assignedDate || today),
      assignedAt: u.assignedDate || new Date().toISOString(),
      createdAt: new Date().toISOString(),
      backfilled: true
    };
    apps.push(app);
    _saveAppRecord(app);
    // Link the unit back to the application (the TIC's first resolution step).
    u.assignedTo = app.id;
    if (typeof saveUnitWithDraftFallback === 'function') saveUnitWithDraftFallback(u);
    else if (typeof sbSaveUnit === 'function') sbSaveUnit(u);
    // Patch the trigger-synced tenants row's linkage when resolvable.
    if (typeof sbResolveTenantId === 'function') {
      (function(appId, tName){
        sbResolveTenantId(tName).then(function(tid){
          if (!tid) return;
          return fetch(SUPABASE_URL + '/rest/v1/tenants?id=eq.' + encodeURIComponent(tid), {
            method: 'PATCH',
            headers: Object.assign({}, HOUSING_HEADERS, { 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
            body: JSON.stringify({ application_id: appId })
          });
        }).catch(function(e){ console.warn('[backfill] tenant link failed:', e); });
      })(app.id, name);
    }
    if (typeof auditEntry === 'function') auditEntry(app.id, 'application_created',
      'Tenant file application backfilled for ' + name + ' at ' + addr + ' (occupied unit had no application)', role);
    made++;
  }
  if (typeof showToast === 'function') showToast(made + ' tenant file application' + (made === 1 ? '' : 's') + ' created and linked.', { type: 'info' });
  if (typeof _renderLandingKpis === 'function') { try { _renderLandingKpis(); } catch(e){} }
  showReconcileReport();
}
window._reconCreateAppsForOccupied = _reconCreateAppsForOccupied;

function _reconApplyUnitAddress(a, unitAddr, role){
  var prev = a.street || '(blank)';
  a.street = unitAddr;
  a.assignedAddress = unitAddr;
  _saveAppRecord(a);
  if (typeof auditEntry === 'function') auditEntry(a.id, 'app_address_merged',
    'Application address merged to unit address: "' + prev + '" \u2192 "' + unitAddr + '" (reconciliation; unit wins)', role);
}
function _reconFindAddrPair(appId){
  var R = _housingReconcile();
  return R.addrMismatch.find(function(x){ return x.app && x.app.id === appId; }) || null;
}
async function _reconMergeAddress(appId){
  if (!_mgmtActionGate()) return;
  var role = window.currentRole || 'staff';
  var pair = _reconFindAddrPair(appId);
  if (!pair) return;
  _reconApplyUnitAddress(pair.app, pair.unitAddr, role);
  if (typeof showToast === 'function') showToast(((pair.app.fn||'')+' '+(pair.app.ln||'')).trim() + ' \u2014 address set to ' + pair.unitAddr + '.', {type:'info'});
  showReconcileReport();
}
window._reconMergeAddress = _reconMergeAddress;
async function _reconMergeAllAddresses(){
  if (!_mgmtActionGate()) return;
  var role = window.currentRole || 'staff';
  var R = _housingReconcile();
  var list = R.addrMismatch;
  if (!list.length) return;
  var go = (typeof showConfirm === 'function')
    ? await showConfirm({
        title: 'Merge ' + list.length + ' address' + (list.length===1?'':'es') + ' to the unit address?',
        message: 'Each listed application\u2019s street line is replaced with its assigned unit\u2019s address (the unit wins). City, province and postal code are left as entered. Every change is audited.',
        confirmText: 'Merge all', cancelText: 'Cancel' })
    : window.confirm('Merge ' + list.length + ' addresses to the unit address?');
  if (!go) return;
  list.forEach(function(x){ _reconApplyUnitAddress(x.app, x.unitAddr, role); });
  if (typeof showToast === 'function') showToast(list.length + ' address' + (list.length===1?'':'es') + ' merged to the unit address.', {type:'info'});
  showReconcileReport();
}
window._reconMergeAllAddresses = _reconMergeAllAddresses;

async function _reconClearLink(appId){
  var apps = (typeof applications !== 'undefined' && applications) ? applications : [];
  var a = apps.find(function(x){ return x && x.id === appId; });
  if (!a) return;
  if (!_mgmtActionGate()) return;
  var role = window.currentRole || 'staff';
  var name = ((a.fn||'')+' '+(a.ln||'')).trim() || a.id;
  var go = (typeof showConfirm === 'function')
    ? await showConfirm({ title:'Clear unit link?', message:'Clear the stale unit link on ' + name + '’s application and return it to the active list?', confirmText:'Clear link', cancelText:'Cancel' })
    : window.confirm('Clear unit link for ' + name + '?');
  if (!go) return;
  clearAppUnitLink(a);
  _saveAppRecord(a);
  if (typeof auditEntry === 'function') auditEntry(a.id, 'status_change', 'Stale unit link cleared via reconciliation', role);
  if (typeof showToast === 'function') showToast('Unit link cleared for ' + name + '.', {type:'info'});
  if (typeof _renderLandingKpis === 'function') _renderLandingKpis();
  showReconcileReport();
}
window._reconClearLink = _reconClearLink;

// Bulk: set the "other / no status" units (no tenant, unrecognized status) to
// Vacant so they become available for assignment. Renovation/reserved untouched.
async function _reconMarkVacant(){
  if (!_mgmtActionGate()) return;
  var role = window.currentRole || 'staff';
  var targets = _housingReconcile().buckets.other;
  if (!targets.length) { if (typeof showToast === 'function') showToast('Nothing to update.', {type:'info'}); return; }
  var go = (typeof showConfirm === 'function')
    ? await showConfirm({ title:'Set to Vacant?', message:'Set ' + targets.length + ' unit' + (targets.length===1?'':'s') + ' that have no tenant and no clear status to Vacant (available for assignment)? Units under renovation, reserved, or condemned are not touched.', confirmText:'Set to Vacant', cancelText:'Cancel' })
    : window.confirm('Set ' + targets.length + ' units to Vacant?');
  if (!go) return;
  var done = 0;
  targets.forEach(function(u){
    var was = (u.status && String(u.status).trim()) ? u.status : 'blank';
    u.status = 'vacant';
    if (typeof saveUnitWithDraftFallback === 'function') saveUnitWithDraftFallback(u);
    else if (typeof sbSaveUnit === 'function') sbSaveUnit(u).catch(function(){});
    if (typeof auditEntry === 'function') auditEntry('UNIT:'+u.id, 'unit_status_change', 'Status set to vacant via reconciliation (was ' + was + ')', role);
    done++;
  });
  if (typeof showToast === 'function') showToast(done + ' unit' + (done===1?'':'s') + ' set to Vacant.', {type:'info'});
  if (typeof _renderLandingKpis === 'function') _renderLandingKpis();
  showReconcileReport();
}
window._reconMarkVacant = _reconMarkVacant;

// Best application to KEEP when merging: prefer the one linked to a unit, then
// the furthest-along status, then the most recent, then the highest score.
function _reconBestApp(list){
  var rank = { assigned:6, ed_approved:5, hm_approved:4, mgr_approved:3, submitted:2, file_update:2, returned:1, draft:0 };
  return list.slice().sort(function(a,b){
    var au=a.assignedUnit?1:0, bu=b.assignedUnit?1:0; if(au!==bu) return bu-au;
    var ar=rank[a.status]||0, br=rank[b.status]||0; if(ar!==br) return br-ar;
    var ad=Date.parse(a.appDate||a.created_at||a.assignedAt||'')||0, bd=Date.parse(b.appDate||b.created_at||b.assignedAt||'')||0; if(ad!==bd) return bd-ad;
    return (b.score||0)-(a.score||0);
  })[0];
}

// Merge chooser — pick which of a person's applications to KEEP.
function _reconMergePrompt(idsCsv){
  var apps = (typeof applications !== 'undefined' && applications) ? applications : [];
  var ids  = String(idsCsv||'').split(',').filter(Boolean);
  var group = ids.map(function(id){ return apps.find(function(a){ return a && a.id === id; }); }).filter(Boolean);
  if (group.length < 2) { if (typeof showToast === 'function') showToast('Nothing to merge.', {type:'info'}); return; }
  var esc = (typeof escapeHtml === 'function') ? escapeHtml : function(s){ return String(s==null?'':s); };
  var best = _reconBestApp(group);
  var rowsHtml = group.map(function(a){
    var nm  = ((a.fn||'')+' '+(a.ln||'')).trim() || a.id;
    var meta = (a.appType||'new_housing').replace('_',' ') + '  &middot;  ' + (a.status||'—')
             + (a.assignedAddress ? ('  &middot;  '+a.assignedAddress) : '')
             + (a.score!=null ? ('  &middot;  score '+a.score) : '');
    return '<label style="display:flex;align-items:flex-start;gap:9px;padding:9px 10px;border:1px solid var(--border);border-radius:8px;margin-bottom:6px;cursor:pointer;">'
      + '<input type="radio" name="recon_keep" value="'+esc(a.id)+'"'+(a.id===best.id?' checked':'')+' style="margin-top:3px;flex-shrink:0;accent-color:var(--yellow);"/>'
      + '<div><div style="font-weight:700;font-size:13px;">'+esc(nm)+'</div>'
      + '<div style="font-size:11px;color:var(--muted);">'+meta+'  &middot;  '+esc(a.id)+'</div></div></label>';
  }).join('');
  var ex = document.getElementById('modalReconMerge'); if (ex) ex.remove();
  var mo = document.createElement('div'); mo.className = 'modal-ov'; mo.id = 'modalReconMerge'; mo.style.zIndex = '300';
  mo.innerHTML =
    '<div class="modal" style="max-width:560px;width:96%;max-height:88vh;display:flex;flex-direction:column;overflow:hidden;">'
    + '<div class="modal-hdr" style="flex-shrink:0;"><div><h2>Merge Applications</h2>'
    +   '<div class="modal-hdr-sub">Pick the application to KEEP. The others are archived and any missing details fold into the kept one (reversible).</div></div>'
    +   '<button class="modal-close" onclick="var m=document.getElementById(\'modalReconMerge\');if(m)m.remove();">&#x2715;</button></div>'
    + '<div class="modal-body" style="padding:16px;flex:1;min-height:0;overflow:auto;">'+rowsHtml+'</div>'
    + '<div class="modal-footer" style="flex-shrink:0;"><button class="btn btn-ghost" onclick="var m=document.getElementById(\'modalReconMerge\');if(m)m.remove();">Cancel</button>'
    +   '<button class="btn btn-primary" onclick="_reconDoMerge()">Merge</button></div>'
    + '</div>';
  mo.addEventListener('click', function(e){ if (e.target === mo) mo.remove(); });
  document.body.appendChild(mo); mo.style.display = ''; mo.classList.add('on');
  window._reconMergeIds = ids;
}
window._reconMergePrompt = _reconMergePrompt;

// Perform the merge: fold missing fields into the kept application, archive the
// rest with a merged_into pointer (reversible), audit both sides.
async function _reconDoMerge(){
  var role = window.currentRole || 'staff';
  // Same authority as the tenant-record merge manager (mergeTenants, default
  // HM + ED) — this WAS gated on deleteApplication (ED-only), so a Housing
  // Manager the Settings screen promised merge rights to was blocked here.
  var canMerge = (typeof APPROVAL_AUTHORITY === 'undefined')
    ? (typeof ROLE !== 'undefined' && ROLE.isManagement && ROLE.isManagement(role))
    : APPROVAL_AUTHORITY.can('mergeTenants', role);
  if (!canMerge) { if (typeof showToast === 'function') showToast('You are not authorized to merge duplicate records.', { type:'error' }); return; }
  var sel = document.querySelector('#modalReconMerge input[name="recon_keep"]:checked');
  if (!sel) { if (typeof showToast === 'function') showToast('Pick the application to keep.', {type:'info'}); return; }
  var canonicalId = sel.value;
  var ids  = window._reconMergeIds || [];
  var apps = (typeof applications !== 'undefined' && applications) ? applications : [];
  var canon = apps.find(function(a){ return a && a.id === canonicalId; });
  if (!canon) return;
  var dups = ids.filter(function(id){ return id !== canonicalId; })
                .map(function(id){ return apps.find(function(a){ return a && a.id === id; }); }).filter(Boolean);
  if (!dups.length) { var m0=document.getElementById('modalReconMerge'); if(m0) m0.remove(); return; }
  var cname = ((canon.fn||'')+' '+(canon.ln||'')).trim() || canon.id;
  var go = (typeof showConfirm === 'function')
    ? await showConfirm({ title:'Merge '+dups.length+' into 1?', message:'Keep '+cname+' ('+canon.id+') and archive '+dups.length+' duplicate application'+(dups.length===1?'':'s')+', folding any missing details into the kept one? Archived applications can be restored by an administrator.', confirmText:'Merge', cancelText:'Cancel' })
    : window.confirm('Merge '+dups.length+' into '+cname+'?');
  if (!go) return;
  var scalarFold = ['email','phone','dob','band','reserve','street','city','prov','postal','maritalStatus','homeCondition'];
  var arrFold    = ['habitants','incomes','references','pets'];
  dups.forEach(function(d){
    scalarFold.forEach(function(f){ if((canon[f]==null||canon[f]==='') && d[f]) canon[f]=d[f]; });
    if(!canon.assignedUnit && d.assignedUnit){ canon.assignedUnit=d.assignedUnit; canon.assignedAddress=d.assignedAddress; if(d.status==='assigned') canon.status='assigned'; }
    arrFold.forEach(function(arr){ if((!canon[arr] || !canon[arr].length) && d[arr] && d[arr].length) canon[arr]=d[arr]; });
    if((canon.score==null || canon.score===0) && d.score) canon.score=d.score;
    d.archived=true; d.mergedInto=canonicalId;
    d.declineReason=(d.declineReason ? d.declineReason+'; ' : '')+'Merged into '+canonicalId;
    _saveAppRecord(d);
    if(typeof auditEntry === 'function') auditEntry(d.id, 'application_merged', 'Merged into '+canonicalId+' via reconciliation', role);
  });
  _saveAppRecord(canon);
  if(typeof auditEntry === 'function') auditEntry(canon.id, 'application_merged', 'Absorbed '+dups.length+' duplicate application(s) via reconciliation', role);
  if(typeof showToast === 'function') showToast('Merged '+dups.length+' duplicate'+(dups.length===1?'':'s')+' into '+cname+'.', {type:'info'});
  var m=document.getElementById('modalReconMerge'); if(m) m.remove();
  if(typeof _renderLandingKpis === 'function') _renderLandingKpis();
  showReconcileReport();
}
window._reconDoMerge = _reconDoMerge;

// Compat shims — old call sites continue to work.
function showEmployeeHome(){
  // The tile-grid landing this function used to render (#employeeHomeView,
  // ~250 lines) was deleted in the audit cleanup: no page ships that markup
  // anymore, so on housing.html this ALWAYS delegated to showLanding() and the
  // tile builder below it was unreachable. Kept as the delegation + the
  // sub-page bounce so the many legacy call sites keep working.
  if (document.getElementById('landingView')) return showLanding();
  if (!window.location.pathname.includes('housing.html') &&
      !window.location.pathname.endsWith('/') &&
      window.location.pathname !== '/') {
    document.body.style.transition = 'opacity .15s ease';
    document.body.style.opacity = '0';
    setTimeout(function() { window.location.href = 'housing.html'; }, 150);
  }
}

async function renderRecentActivity(role) {
  var el = document.getElementById('emp_recent_activity');
  if(!el) return;

  var myEmail = (typeof HOUSING_SESSION !== 'undefined' && HOUSING_SESSION ? HOUSING_SESSION.email : '') || '';
  var myName  = (typeof HOUSING_SESSION !== 'undefined' && HOUSING_SESSION ? HOUSING_SESSION.name  : '') || '';

  // ── Load activity scoped to the current user ──────────────────────────────
  // The in-memory auditLog[] is already per-session (only this user's actions
  // from the current page load). When loading from Supabase use the user-scoped
  // query so one HM/ED does not see another's recent activity.
  var log = (typeof auditLog !== 'undefined' && auditLog && auditLog.length) ? auditLog.slice() : [];
  if(!log.length) {
    el.innerHTML = '<div style="color:var(--muted);font-style:italic;font-size:13px;">Loading activity…</div>';
    try {
      var loader = (typeof sbLoadMyRecentActivity === 'function') ? sbLoadMyRecentActivity : sbLoadAuditLog;
      var loaded = await loader(150);
      if(Array.isArray(loaded)) {
        log = loaded;
        if(typeof auditLog !== 'undefined') { try { auditLog = loaded.slice(); } catch(e){} }
      }
    } catch(e) { console.warn('[RECENT ACTIVITY] load failed:', e); }
  }

  // ── Per-user filter: only show entries that belong to the current user ────
  // New entries store email in actor; legacy entries store the role string.
  // For legacy entries, fall back to name matching when available.
  function isMyEntry(e) {
    if (!myEmail && !myName) return true; // no identity — show all (shouldn't happen post-login)
    if (e.user && e.user === myEmail) return true;  // email match (new entries)
    if (e.name && myName && e.name === myName) return true; // name match (legacy entries)
    // Legacy entries with only a role string — include only if from in-memory log
    // (which is per-session). Supabase-loaded role-string entries are ambiguous;
    // exclude them to prevent showing another user's actions.
    if (!myEmail && e.user && e.user.indexOf('@') === -1 && e.name === myName) return true;
    return false;
  }

  var apps  = (typeof applications !== 'undefined') ? applications : [];
  var units = (typeof housingUnits  !== 'undefined') ? housingUnits  : [];

  // ── Action-type filters (what kinds of actions are relevant per role) ──────
  var roleFilters = {
    employee: function(e) {
      return ['application_submitted','file_update_submitted','draft_saved','signature_captured'].indexOf(e.action) >= 0;
    },
    housing_manager: function(e) {
      return ['application_submitted','file_update_submitted','status_change','status',
              'hm_approved','sow_created','sow_updated','sow_hm_approval','sow_tenant_signed',
              'sow_staff_signed','sow_accountability','unit_edit',
              'settings_scoring_change','settings_scoring_add','settings_scoring_delete',
              'settings_unit_score_save','settings_reno_score_save',
              'settings_budget_save','settings_user_add','settings_user_remove'].indexOf(e.action) >= 0;
    },
    ed: function(e) {
      return e.action !== 'draft_saved' && e.action !== 'signature_captured' && e.action !== 'settings_saved';
    }
  };

  var filterFn = roleFilters[role] || roleFilters.employee;
  // 40 rows initially; "Show all" reveals everything loaded (the loader
  // fetches 150 from the server, so that's the true ceiling per page load).
  var allMine = log.filter(function(e){ return filterFn(e) && isMyEntry(e); });
  var _showAll = window._recentActivityShowAll === true;
  var filtered = _showAll ? allMine : allMine.slice(0, 40);
  var _hiddenN = allMine.length - filtered.length;

  if(!filtered.length) {
    el.innerHTML = '<div style="color:var(--muted);font-style:italic;font-size:13px;">No recent activity yet.</div>';
    return;
  }

  // ── Icon + colour map ──────────────────────────────────────────────────────
  var icons = {
    'application_submitted':    {icon:'📨', color:'var(--success)', label:'Application Submitted'},
    'file_update_submitted':    {icon:'📨', color:'var(--success)', label:'File Update Submitted'},
    'draft_saved':              {icon:'💾', color:'var(--muted)', label:'Draft Saved'},
    'signature_captured':       {icon:'✍️', color:'var(--muted)', label:'Signature Captured'},
    'status_change':            {icon:'🔄', color:'#1d4ed8', label:'Status Changed'},
    'status':                   {icon:'🔄', color:'#1d4ed8', label:'Status Changed'},
    'application_opened':       {icon:'📂', color:'var(--muted)', label:'Opened for Edit'},
    'declined':                 {icon:'✕',  color:'var(--danger)', label:'Declined'},
    'archived':                 {icon:'📦', color:'var(--muted)', label:'Archived'},
    'unarchived':               {icon:'📤', color:'var(--muted)', label:'Unarchived'},
    'ed_adjustment':            {icon:'⭐', color:'#7a5c00', label:'Score Adjusted'},
    'unit_edit':                {icon:'🏠', color:'#7c3aed', label:'Unit Updated'},
    'unit_assigned':            {icon:'🔑', color:'var(--success)', label:'Unit Assigned'},
    'unit_archived':            {icon:'🏚️', color:'var(--gray)',    label:'Unit Archived'},
    'unit_unarchived':          {icon:'📤', color:'#1d4ed8', label:'Unit Restored'},
    'sow_created':              {icon:'🔨', color:'var(--warn-amber-text)', label:'Request Created'},
    'sow_updated':              {icon:'🔨', color:'var(--warn-amber-text)', label:'Request Updated'},
    'sow_hm_approval':          {icon:'✅', color:'var(--success)', label:'Request Approved'},
    'sow_ed_approval':          {icon:'✅', color:'var(--success)', label:'Request Approved (ED)'},
    'sow_tenant_signed':        {icon:'✍️', color:'#1d4ed8', label:'Tenant Signed Request'},
    'sow_staff_signed':         {icon:'✍️', color:'var(--muted)', label:'Staff Signed Request'},
    'sow_accountability':       {icon:'⚠️', color:'var(--danger)', label:'Accountability Flagged'},
    'ct_submitted':             {icon:'🧰', color:'var(--success)', label:'Contractor Application'},
    'ct_updated':               {icon:'🧰', color:'var(--gray)',    label:'Contractor Updated'},
    'hm_recommended':           {icon:'✅', color:'#1d4ed8', label:'HM Recommended'},
    'approved':                 {icon:'✅', color:'var(--success)', label:'Approved'},
    'returned':                 {icon:'↩️', color:'#7c3aed', label:'Returned for Info'},
    'settings_scoring_change':  {icon:'⚙️', color:'#7c3aed', label:'Rubric Value Changed'},
    'settings_scoring_add':     {icon:'⚙️', color:'var(--success)', label:'Rubric Criteria Added'},
    'settings_scoring_delete':  {icon:'⚙️', color:'var(--danger)', label:'Rubric Criteria Removed'},
    'settings_scoring_reset':   {icon:'⚙️', color:'var(--danger)', label:'Scoring Model Reset'},
    'settings_unit_score_save': {icon:'⚙️', color:'#7c3aed', label:'Unit Scoring Updated'},
    'settings_reno_score_save': {icon:'⚙️', color:'var(--warn-amber-text)', label:'Reno Scoring Updated'},
    'settings_budget_save':     {icon:'💰', color:'var(--success)', label:'Budget Saved'},
    'settings_user_add':        {icon:'👤', color:'var(--success)', label:'User Added'},
    'settings_user_remove':     {icon:'👤', color:'var(--danger)', label:'User Removed'},
    'settings_saved':           {icon:'⚙️', color:'var(--muted)', label:'Settings Saved'}
  };

  // ── Group by calendar day (LOCAL time, not UTC) ────────────────────────────
  // Using toISOString().slice(0,10) here was giving us a UTC date string while
  // dayLabel() parses it back as local — so an event at 9 PM yesterday in EDT
  // (= 1 AM UTC today) was bucketed under "Today". Build the key from local
  // date components so the bucket matches what dayLabel will show.
  var today     = new Date(); today.setHours(0,0,0,0);
  var yesterday = new Date(today); yesterday.setDate(yesterday.getDate()-1);

  function _localDateKey(ts){
    var d = new Date(ts);
    var y  = d.getFullYear();
    var m  = String(d.getMonth()+1).padStart(2,'0');
    var dd = String(d.getDate()).padStart(2,'0');
    return y + '-' + m + '-' + dd;
  }

  var groups = {}; // key = YYYY-MM-DD (local), value = []
  var order  = [];
  filtered.forEach(function(e) {
    var key = _localDateKey(e.ts);
    if(!groups[key]) { groups[key] = []; order.push(key); }
    groups[key].push(e);
  });

  function dayLabel(key) {
    var d = new Date(key + 'T00:00:00');
    d.setHours(0,0,0,0);
    if(d.getTime() === today.getTime())     return 'Today';
    if(d.getTime() === yesterday.getTime()) return 'Yesterday';
    return d.toLocaleDateString('en-CA', {weekday:'long', month:'short', day:'numeric'});
  }

  function timeStr(ts) {
    var d = new Date(ts);
    return d.toLocaleTimeString('en-CA', {hour:'2-digit', minute:'2-digit', hour12:true});
  }

  // View mode shared with the worklist toggle (one preference drives both).
  // Defaults to Cards; only an explicit saved 'list' shows the list layout.
  var _view = (function(){ try { return localStorage.getItem('clfn_worklist_view') === 'list' ? 'list' : 'cards'; } catch(e){ return 'cards'; } })();
  function _recentToggleBar(){
    function b(v, label, icon){
      var on = _view === v;
      var click = 'if(typeof _wlSetView===\'function\'){_wlSetView(\''+v+'\');}else{try{localStorage.setItem(\'clfn_worklist_view\',\''+v+'\');}catch(e){}if(typeof renderRecentActivity===\'function\')renderRecentActivity(\''+role+'\');}';
      return '<button type="button" onclick="'+click+'" style="display:flex;align-items:center;gap:5px;padding:5px 12px;'
        + 'border:1px solid '+(on?'var(--yellow)':'var(--border)')+';background:'+(on?'var(--yellow)':'var(--surface)')+';'
        + 'color:'+(on?'var(--dark)':'var(--muted)')+';font-size:11px;font-weight:700;font-family:DM Sans,sans-serif;cursor:pointer;'
        + 'border-radius:'+(v==='list'?'7px 0 0 7px':'0 7px 7px 0')+';'+(v==='cards'?'margin-left:-1px;':'')+'">'+icon+' '+label+'</button>';
    }
    return '<div style="display:flex;justify-content:flex-end;margin-bottom:8px;"><div style="display:flex;">'
      + b('list','List','&#9776;') + b('cards','Cards','&#9638;') + '</div></div>';
  }

  // Resolve the entity name / display id / icon meta for an audit entry.
  function _resolveEntry(e) {
    var meta = icons[e.action] || {icon:'•', color:'var(--muted)', label: e.action.replace(/_/g,' ')};
    var appId = e.appId || '';
    var displayId = appId;
    var extraName = '';
    if(appId && !appId.startsWith('SOW:') && !appId.startsWith('UNIT:') && !appId.startsWith('CT:') && appId !== 'SETTINGS') {
      var linkedApp = apps.find(function(a){ return a.id === appId; });
      if(linkedApp) extraName = ((linkedApp.fn||'') + ' ' + (linkedApp.ln||'')).trim();
    } else if(appId.startsWith('SOW:')) {
      var uid = appId.slice(4);
      var linkedUnit = units.find(function(u){ return u.id === uid; });
      if(linkedUnit) extraName = linkedUnit.num + ' ' + linkedUnit.street;
      displayId = 'MR';
    } else if(appId.startsWith('UNIT:')) {
      displayId = appId.slice(5);
    } else if(appId.startsWith('CT:')) {
      displayId = appId.slice(3);
    }
    return { meta: meta, extraName: extraName, displayId: displayId };
  }

  function renderEntry(e) {
    var r = _resolveEntry(e);
    return '<div style="display:flex;align-items:flex-start;gap:10px;padding:8px 0 8px 0;">'
      + '<div style="width:28px;height:28px;border-radius:7px;background:var(--bg);display:flex;align-items:center;justify-content:center;font-size:13px;flex-shrink:0;margin-top:1px;border:1px solid var(--border);">'+r.meta.icon+'</div>'
      + '<div style="flex:1;min-width:0;">'
        + '<div style="font-size:12px;font-weight:600;color:var(--text);">'
          + (r.extraName ? '<span style="color:'+r.meta.color+';">'+r.extraName+'</span> · ' : '')
          + r.meta.label
        + '</div>'
        + '<div style="font-size:11px;color:var(--muted);margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'+(e.detail||'—')+'</div>'
        + (r.displayId && r.displayId!=='SETTINGS' ? '<div style="font-size:10px;color:var(--muted);margin-top:1px;font-family:monospace;opacity:.7;">'+r.displayId+'</div>' : '')
      + '</div>'
      + '<div style="font-size:10px;color:var(--muted);white-space:nowrap;flex-shrink:0;padding-top:3px;">'+timeStr(e.ts)+'</div>'
      + '</div>';
  }

  function renderEntryCard(e) {
    var r = _resolveEntry(e);
    return '<div style="border:1px solid var(--border);border-radius:10px;background:var(--surface);padding:10px 11px;">'
      + '<div style="display:flex;align-items:center;gap:8px;">'
      +   '<div style="width:26px;height:26px;border-radius:7px;background:var(--bg);display:flex;align-items:center;justify-content:center;font-size:13px;flex-shrink:0;border:1px solid var(--border);">'+r.meta.icon+'</div>'
      +   '<span style="font-size:11px;font-weight:700;color:'+r.meta.color+';flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'+r.meta.label+'</span>'
      +   '<span style="font-size:10px;color:var(--muted);white-space:nowrap;flex-shrink:0;">'+timeStr(e.ts)+'</span>'
      + '</div>'
      + (r.extraName ? '<div style="font-size:13px;font-weight:700;color:var(--text);margin-top:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'+r.extraName+'</div>' : '')
      + '<div style="font-size:11px;color:var(--muted);margin-top:'+(r.extraName?'2px':'6px')+';">'+(e.detail||'—')+'</div>'
      + (r.displayId && r.displayId!=='SETTINGS' ? '<div style="font-size:10px;color:var(--muted);margin-top:4px;font-family:monospace;opacity:.7;">'+r.displayId+'</div>' : '')
      + '</div>';
  }

  el.innerHTML = _recentToggleBar() + order.map(function(key, i) {
    var groupId = 'act_group_' + key.replace(/-/g,'');
    var isToday = dayLabel(key) === 'Today';
    // Cards: a responsive grid of tiles; List: the timeline rows.
    var entriesHtml = (_view === 'cards')
      ? '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px;padding-top:6px;">' + groups[key].map(renderEntryCard).join('') + '</div>'
      : groups[key].map(renderEntry).join('');
    var entriesWrapStyle = (_view === 'cards')
      ? 'display:'+(isToday?'block':'none')+';'
      : 'display:'+(isToday?'block':'none')+';padding-left:12px;border-left:2px solid var(--border);';
    return '<div style="margin-bottom:'+(i<order.length-1?'8px':'0')+'">'
      // Day header — clickable
      + '<div onclick="var g=document.getElementById(\''+groupId+'\');var ch=document.getElementById(\''+groupId+'_ch\');var open=g.style.display!==\'none\';g.style.display=open?\'none\':\'block\';ch.style.transform=open?\'rotate(-90deg)\':\'rotate(0deg)\';" '
        + 'style="display:flex;align-items:center;gap:10px;padding:6px 0;cursor:pointer;user-select:none;">'
        + '<svg id="'+groupId+'_ch" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="2.5" style="flex-shrink:0;transition:transform .2s;transform:'+(isToday?'rotate(0deg)':'rotate(-90deg)')+'"><polyline points="6 9 12 15 18 9"/></svg>'
        + '<div style="font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.8px;color:var(--muted);">'+dayLabel(key)+'</div>'
        + '<div style="flex:1;height:1px;background:var(--border);"></div>'
        + '<div class="js-lbl-xs">'+groups[key].length+' event'+(groups[key].length!==1?'s':'')+'</div>'
      + '</div>'
      // Entries — today open by default, previous days collapsed
      + '<div id="'+groupId+'" style="'+entriesWrapStyle+'">'
        + entriesHtml
      + '</div>'
      + '</div>';
  }).join('')
  // "Show all" footer — the list caps at 40 rows until expanded.
  + (_hiddenN > 0
      ? '<div style="text-align:center;padding:8px 0 2px;"><button class="btn btn-ghost" style="padding:4px 14px;font-size:12px;" onclick="window._recentActivityShowAll=true;renderRecentActivity(\'' + String(role||'').replace(/[^a-z_]/g,'') + '\')">Show all ' + allMine.length + ' &#9662;</button></div>'
      : (_showAll && allMine.length > 40
          ? '<div style="text-align:center;padding:8px 0 2px;"><button class="btn btn-ghost" style="padding:4px 14px;font-size:12px;" onclick="window._recentActivityShowAll=false;renderRecentActivity(\'' + String(role||'').replace(/[^a-z_]/g,'') + '\')">Show fewer &#9652;</button></div>'
          : ''));

  // Update the section count pill — show TODAY's event count only (post role
  // filter), so the header reflects "what happened today" rather than the full
  // visible window. Reuses the local date key so the pill matches the "Today"
  // group rendered above.
  var rcp = document.getElementById('recent_count_pill');
  if(rcp){
    var todayKey = _localDateKey(today);
    var todayCount = (groups[todayKey] || []).length;
    rcp.textContent = todayCount;
  }
}

// ══════════════════════════════════════════════════════
// TENANT FILES
// ══════════════════════════════════════════════════════
// Migrated to window.DocLibrary (shared.js) in Phase C.
// The modal shell (id="tenantFilesPanel", header w/ tfp_title) stays;
// DocLibrary mounts into #tfp_mount. The factory handles upload, list,
// view, delete, and categories.
var _tenantFilesUnitId = null;
var _tenantFilesLib = null;

// Categories for housing-side tenant documents. Shared between the
// tenant-files-unit modal and the Unit Detail Panel preview below.
var _HOUSING_TENANT_DOC_CATEGORIES = [
  { key:'id',          label:'ID',              icon:'\uD83E\uDDFE' },
  { key:'lease',       label:'Lease',           icon:'\uD83D\uDCC4' },
  { key:'application', label:'Application',     icon:'\uD83D\uDCDD' },
  { key:'inspection',  label:'Inspection',      icon:'\uD83D\uDD0D' },
  { key:'insurance',   label:'Insurance',       icon:'\uD83D\uDEE1\uFE0F' },
  { key:'notice',      label:'Notice / Letter', icon:'\uD83D\uDCEC' },
  { key:'image',       label:'Image',           icon:'\uD83D\uDDBC\uFE0F' },
  { key:'other',       label:'Other',           icon:'\uD83D\uDCCE' }
];

// Retained as a thin compat wrapper: udpRenderFilePreviews still calls
// this. Once that path is fully migrated to DocLibrary, this can go away.
// ── Settings page patches ─────────────────────────────────────────────────
// Runs once after DOMContentLoaded so that housing.html's inline
// showSettingsSection has already been defined.
document.addEventListener('DOMContentLoaded', function(){

  // Patch showSettingsSection so switching to Nation tab calls
  //    renderNationPanel() automatically, without touching housing.html.
  var _origSSS = window.showSettingsSection;
  window.showSettingsSection = function(secId){
    if(typeof _origSSS === 'function') _origSSS(secId);
    if(secId === 'sec_nation' && typeof renderNationPanel === 'function'){
      renderNationPanel();
    }
    if(secId === 'sec_themes' && typeof renderThemesPanel === 'function'){
      renderThemesPanel();
    }
    if(secId === 'sec_required_fields' && typeof renderRequiredFieldsPanel === 'function'){
      renderRequiredFieldsPanel();
    }
  };
});

