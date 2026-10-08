function searchTenants(q) {
  var resultsEl = document.getElementById('tenantSearchResults');
  if (!q || q.trim().length < 1) {
    if (resultsEl) resultsEl.style.display = 'none';
    return;
  }
  var d = getData();
  var ql = q.trim().toLowerCase();
  var matches = d.tenants.filter(function(t){
    return tenantName(t).toLowerCase().includes(ql) ||
      (t.unit||'').toLowerCase().includes(ql) ||
      (t.phone||'').includes(ql) ||
      (t.email||'').toLowerCase().includes(ql);
  }).slice(0, 8);
  if (!resultsEl) return;
  if (!matches.length) {
    resultsEl.innerHTML = '<div class="tenant-search-result" style="cursor:default;color:var(--muted);">No tenants found</div>';
    resultsEl.style.display = 'block';
    return;
  }
  resultsEl.style.display = 'block';
  resultsEl.innerHTML = matches.map(function(t){
    var initials = ((t.first||'')[0]||'') + ((t.last||'')[0]||'');
    if (!initials) initials = '?';
    var safeId = (t.id||'').replace(/'/g, "\\'");  // defensive; UUIDs won't contain single quotes but older IDs might
    var unitLabel = (t.unit||'').toString();
    var typeLabel = (t.type||'').toString().replace(/-/g,' ');
    return '<div class="tenant-search-result" onclick="openFinanceCard(\''+safeId+'\')">'+
      '<div class="tsr-avatar">'+initials+'</div>'+
      '<div><div class="tsr-name">'+tenantNameHtml(t)+'</div>'+
      '<div class="tsr-meta">'+unitLabel+' &middot; '+typeLabel+'</div></div>'+
    '</div>';
  }).join('');
}

function setTenantsChromeMode(mode) {
  // mode === 'list'   -> show listing header/search/filters/list
  // mode === 'profile' -> hide them (TIC is up)
  var ids = ['tenantsListChromeSubtitle','tenantsListChromeActions','tenantsListChrome'];
  var disp = (mode === 'profile') ? 'none' : '';
  ids.forEach(function(id){
    var el = document.getElementById(id);
    if (el) el.style.display = disp;
  });
}

function selectTenantProfile(tid) {
  var resultsEl = document.getElementById('tenantSearchResults');
  if (resultsEl) resultsEl.style.display = 'none';
  var inp = document.getElementById('tenantSearchInput');
  var t = getTenant(tid);
  if (!t) return;
  if (inp) inp.value = tenantName(t);
  setTenantsChromeMode('profile');
  renderTenantProfile(tid);
}

// Phase F3A — browseable tenant list on the Tenants tab. Shown when no
// profile is selected; clicking a row opens that tenant's profile.
function clearTenantFilters(){
  var ids = ['tfilt_status','tfilt_type','tfilt_arrears','tfilt_col'];
  ids.forEach(function(id){ var el=document.getElementById(id); if(el) el.value=''; });
  renderTenantList();
}

function renderTenantList() {
  var panel = document.getElementById('tenantListPanel');
  if (!panel) return;
  panel.style.display = 'block';
  var d = getData();
  // Canonical persons only — rows merged into another person are hidden; their
  // ledger/loans/arrears roll up under the keeper (see _finCanonicalizeTenantRefs).
  var all = (d.tenants||[]).filter(function(t){ return !t.mergedInto; }).slice().sort(function(a,b){
    return tenantName(a).localeCompare(tenantName(b));
  });

  // Apply filter selections
  var fStatus = (document.getElementById('tfilt_status')||{}).value || '';
  var fType   = (document.getElementById('tfilt_type')||{}).value   || '';
  var fArr    = (document.getElementById('tfilt_arrears')||{}).value|| '';
  var fCol    = (document.getElementById('tfilt_col')||{}).value    || '';

  // Pre-compute which tenants are in collections and who has arrears
  var totals = calcAllTotals(d);
  var colSet = {};
  (d.collections||[]).forEach(function(c){
    if (c.status==='approved' || c.status==='pending-ed') colSet[c.tenantId] = true;
  });

  var list = all.filter(function(t){
    // Status filter — treat missing status as 'active'
    var st = t.status || 'active';
    if (fStatus && st !== fStatus) return false;
    if (fType && t.type !== fType) return false;
    if (fArr) {
      var bal = totals[t.id] || {};
      var owe = (bal.rent||0) + (bal.loan||0) + (bal.arrangement||0);
      var hasArr = owe > 0;
      if (fArr === 'yes' && !hasArr) return false;
      if (fArr === 'no'  && hasArr) return false;
    }
    if (fCol) {
      var inCol = !!colSet[t.id];
      if (fCol === 'yes' && !inCol) return false;
      if (fCol === 'no'  && inCol) return false;
    }
    return true;
  });

  // Page meta line (title card)
  var meta = document.getElementById('tenants_page_meta');
  if (meta) {
    var today = new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'});
    meta.textContent = all.length + ' total · ' + list.length + ' shown · Last updated ' + today;
  }

  if (!all.length) {
    panel.innerHTML = '<div class="std-table-card" style="text-align:center;padding:40px 30px;color:var(--muted);">' +
      '<div style="font-size:28px;margin-bottom:10px;">&#128101;</div>' +
      '<div style="font-size:13px;">No tenants yet. Click <strong>+ Add Tenant</strong> to create the first one.</div>' +
      '</div>';
    return;
  }

  var typeLabels = {
    'band-on':'Band On-Reserve','band-off':'Band Off-Reserve','band-staff':'Band Office Staff',
    'clea':'CLEA','community':'Community Member','business':'Business','department':'Department'
  };

  // Phase 2B: column-menu sort/filter
  var _tCols = {
    name:   { label: 'Name',   accessor: function(t){ return tenantName(t); } },
    unit:   { label: 'Unit',   accessor: function(t){ return t.unit||''; } },
    type:   { label: 'Type',   accessor: function(t){ return t.type||''; } },
    status: { label: 'Status', accessor: function(t){ return t.status||'active'; } }
  };
  var _tAcc = {}; Object.keys(_tCols).forEach(function(k){ _tAcc[k] = _tCols[k].accessor; });
  var _tSt = (typeof tableStateGet==='function') ? tableStateGet('fin-tenants') : {sort:{key:'',dir:1},filters:{}};
  if (typeof tableRegisterColumns==='function') tableRegisterColumns('fin-tenants', {columns:_tCols, getRows:function(){return list;}, onChange:renderTenantList});
  list = (typeof tableApplyFilterSort==='function') ? tableApplyFilterSort(list, _tAcc, _tSt) : list;

  var rows;
  if (!list.length) {
    rows = '<tr class="empty-row"><td colspan="6">No tenants match the current filters. <a href="#" onclick="clearTenantFilters();return false;" style="color:var(--text);text-decoration:underline;">Clear filters</a> to show all.</td></tr>';
  } else {
    rows = list.map(function(t){
      var initials = ((t.first||'')[0]||'') + ((t.last||'')[0]||'');
      if (!initials) initials = '?';
      var safeId = (t.id||'').replace(/'/g, "\\'");
      var st = t.status || 'active';
      var pillClass = st === 'former' ? 'std-pill-former'
                    : st === 'deceased' ? 'std-pill-deceased'
                    : 'std-pill-active';
      var statusText = st.charAt(0).toUpperCase() + st.slice(1);
      var unitCell = t.unit ? t.unit : '<span class="std-cell-dash">—</span>';
      var typeCell = typeLabels[t.type] || (t.type||'').replace(/-/g,' ') || '<span class="std-cell-dash">—</span>';
      var hccBadge = t.homeCare ? '<span class="pill" style="font-size:9px;background:#0891b2;color:#fff;border:none;vertical-align:middle;margin-left:4px;">&#127968; H&amp;CC</span>' : '';
      return '<tr class="clickable" onclick="openFinanceCard(\''+safeId+'\')">'+
        '<td class="std-row-avatar-cell"><div class="std-row-avatar">'+initials+'</div></td>'+
        '<td class="std-cell-primary">'+tenantNameHtml(t)+hccBadge+'</td>'+
        '<td>'+unitCell+'</td>'+
        '<td>'+typeCell+'</td>'+
        '<td><span class="std-pill '+pillClass+'">'+statusText+'</span></td>'+
        '<td class="std-cell-tail">Click to open &rsaquo;</td>'+
      '</tr>';
    }).join('');
  }

  panel.innerHTML =
    '<div class="std-table-card">'+
      '<div class="std-table-hdr">'+
        '<span>All Tenants</span>'+
        '<span class="std-table-count">'+list.length+' shown · '+all.length+' total</span>'+
      '</div>'+
      '<table class="std-table">'+
        '<thead id="fin_tenants_thead"><tr>'+
          '<th></th>'+
          '<th class="std-th-sortable" data-sort-key="name">Name</th>'+
          '<th class="std-th-sortable" data-sort-key="unit">Unit</th>'+
          '<th class="std-th-sortable" data-sort-key="type">Type</th>'+
          '<th class="std-th-sortable" data-sort-key="status">Status</th>'+
          '<th></th>'+
        '</tr></thead>'+
        '<tbody>'+rows+'</tbody>'+
      '</table>'+
    '</div>';
  var _tThead = document.getElementById('fin_tenants_thead');
  if (_tThead && typeof tableBindColumnMenuClicks==='function') tableBindColumnMenuClicks(_tThead, 'fin-tenants');
  if (_tThead && typeof tableRefreshSortIndicators==='function') tableRefreshSortIndicators(_tThead, 'fin-tenants');
}

