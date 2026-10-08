// NAVIGATION
// showPage defined below
function showPage(id) {
  var _curEl = document.querySelector('.page.on');
  var _curId = _curEl ? _curEl.id.replace('page-','') : 'home';
  if (_curId !== id && id !== 'home') _prevPage = _curId;
  document.querySelectorAll('.page').forEach(function(p){p.classList.remove('on');});
  var pg = document.getElementById('page-'+id); if(pg) pg.classList.add('on');
  // The "Show voided entries" bar is only relevant to the Rent Ledger and
  // Transactions views (the only ones that honour _finShowVoided); hide it
  // everywhere else (dashboard, tenants, loans, etc.).
  var _vb = document.getElementById('fin-void-bar');
  if (_vb) _vb.style.display = (id === 'rent' || id === 'transactions') ? 'flex' : 'none';
  // Return to top whenever a new page is shown so users don't land mid-scroll
  window.scrollTo({top:0, behavior:'instant'});
  if(id==='home') renderHome();
  if(id==='tenants') {
    setTimeout(function(){
      setTenantsChromeMode('list');
      var inp = document.getElementById('tenantSearchInput');
      if(inp){ inp.value=''; searchTenants(''); inp.focus(); }
      var pp = document.getElementById('tenantProfilePanel');
      if(pp) pp.innerHTML='<div style="text-align:center;padding:20px 0 40px;color:var(--muted);font-size:13px;">Select a tenant from the list below to view their record.</div>';
      var listEl = document.getElementById('tenantListPanel');
      if(listEl) listEl.style.display='block';
      renderTenantList();
    }, 80);
  }
  if(id==='rent'){initTenantSelects();renderRentLedger();}
  if(id==='arrangements'){initTenantSelects();renderArrangementsPage();}
  if(id==='loans'){initTenantSelects();renderLoansPage();}
  if(id==='journal'){initTenantSelects();renderJournal();}
  if(id==='reports'){
    initTenantSelects();
    var _now=new Date();
    var _mo=document.getElementById('rpt-period-month'); if(_mo)_mo.value=String(_now.getMonth()+1).padStart(2,'0');
    var _yr=document.getElementById('rpt-period-year'); if(_yr)_yr.value=String(_now.getFullYear());
    var _rm=document.getElementById('rec-month'); if(_rm)_rm.value=String(_now.getMonth()+1).padStart(2,'0');
    var _ry=document.getElementById('rec-year'); if(_ry)_ry.value=String(_now.getFullYear());
    _activeReportTab = 'rpt-period';
    renderPeriodSummary();
    updateReportsPageMeta();
  }
  if(id==='collections') renderCollections();
  if(id==='transactions'){initTxnFilters();renderTransactions();}
  if(id==='auditlog') renderAuditLog();
  if(id==='statement') { /* rendered on demand via goToTenant() */ }
  // Update back button label on the new page
  var _bLabels = {home:'Home',tenants:'Tenants',rent:'Rent Ledger',arrangements:'Arrangements',loans:'Loans',journal:'Journal',reports:'Reports',collections:'Collections',transactions:'Transactions',auditlog:'Audit Log',entryforms:'Entry Forms'};
  var _newPg = document.getElementById('page-'+id);
  if (_newPg) {
    var _backBtnEl = _newPg.querySelector('.back-btn-yellow');
    if (_backBtnEl) {
      var _cNodes = _backBtnEl.childNodes;
      for (var _ni = _cNodes.length-1; _ni >= 0; _ni--) {
        if (_cNodes[_ni].nodeType === 3 && _cNodes[_ni].textContent.trim()) {
          _cNodes[_ni].textContent = '\n      Back to '+(_bLabels[_prevPage]||'Previous')+'\n    ';
          break;
        }
      }
    }
  }
}

// ── HOME — tile grid landing page ────────────────────────────────────────
// Replaces the old sidebar-nav dashboard as the default view. Users pick a
// tile to drill into a specific area. Mirrors housing.html's home.
var _prevPage = 'home';
function finGoBack(){ showPage(_prevPage || 'home'); }


function renderHome(){
  var dateEl = document.getElementById('home_date');
  if(dateEl){
    var dd = new Date();
    dateEl.textContent = dd.toLocaleDateString('en-US',{weekday:'long'}) + ' · ' + dd.toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'});
  }
  var nameEl = document.getElementById('home_user_name');
  if(nameEl){
    nameEl.textContent = (typeof HOUSING_SESSION !== 'undefined' && HOUSING_SESSION && HOUSING_SESSION.name) ? HOUSING_SESSION.name : 'Finance Staff';
  }
  if (typeof renderDashboard === 'function') renderDashboard();
}

// ── Finance landing page search ────────────────────────────────────────────
function finTabSwitch(tab) {
  document.querySelectorAll('#fin_lookup_tabs .lookup-tab').forEach(function(b){
    b.classList.toggle('active', b.getAttribute('data-fin-tab') === tab);
  });
  var inp = document.getElementById('fin_search_input');
  if (inp && inp.value.trim()) finHomeSearch(inp.value);
}

function finHomeSearch(query) {
  var resultsEl = document.getElementById('fin_search_results');
  if (!resultsEl) return;
  var q = (query||'').trim().toLowerCase();
  if (!q) { resultsEl.classList.remove('open'); resultsEl.innerHTML = ''; return; }

  var activeTab = 'all';
  var tabEl = document.querySelector('#fin_lookup_tabs .lookup-tab.active');
  if (tabEl) activeTab = tabEl.getAttribute('data-fin-tab') || 'all';

  var d = getData();
  var results = [];

  if (activeTab === 'all' || activeTab === 'tenants') {
    var limit = activeTab === 'all' ? 4 : 8;
    var _seenTen = {};
    (d.tenants||[]).filter(function(t){
      if (t.archived || t.mergedInto) return false;   // skip rows merged into a canonical person
      var hit = tenantName(t).toLowerCase().includes(q) ||
        (t.unit||'').toLowerCase().includes(q) ||
        (t.phone||'').toLowerCase().includes(q) ||
        (t.email||'').toLowerCase().includes(q);
      if (!hit) return false;
      // One line per person. The tenant-sync trigger inserts a fresh row per
      // assignment and never matches by name, so one person accumulates
      // several identical rows; collapse them by normalized name + unit so the
      // dropdown shows the person once (the newest row wins, load order).
      var pk = (typeof normNameKey === 'function' ? normNameKey(tenantName(t)) : tenantName(t).toLowerCase())
             + '|' + (t.unit||'').toLowerCase().trim();
      if (_seenTen[pk]) return false;
      _seenTen[pk] = true;
      return true;
    }).slice(0, limit).forEach(function(t){
      results.push({type:'tenant', id:t.id, iconCls:'type-tenant', iconTxt:'T',
        title:tenantNameHtml(t), sub:escapeHtml(t.unit||'')+(t.type?' · '+escapeHtml(t.type.replace(/-/g,' ')):''),
        badge:'Tenant', badgeCls:'badge-tenant'});
    });
  }

  if (activeTab === 'all' || activeTab === 'ledger') {
    var limit2 = activeTab === 'all' ? 3 : 8;
    (d.rentLedger||[]).filter(function(r){
      var t = getTenant(r.tenantId);
      return t && !t.archived && (
        tenantName(t).toLowerCase().includes(q) ||
        (r.desc||'').toLowerCase().includes(q) ||
        (r.ref||'').toLowerCase().includes(q)
      );
    }).slice(0, limit2).forEach(function(r){
      var t = getTenant(r.tenantId);
      if (!t) return;
      results.push({type:'tenant', id:r.tenantId, iconCls:'type-sow', iconTxt:'$',
        title:tenantNameHtml(t) + ' — ' + (r.type==='payment'?'Payment':'Invoice'),
        sub:escapeHtml(r.date||'')+(r.desc?' · '+escapeHtml(r.desc):''), badge:'Ledger', badgeCls:'badge-sow'});
    });
  }

  if (activeTab === 'all' || activeTab === 'loans') {
    var limit3 = activeTab === 'all' ? 3 : 8;
    (d.loanList||[]).filter(function(l){
      var t = getTenant(l.tenantId);
      return t && !t.archived && (
        tenantName(t).toLowerCase().includes(q) ||
        (l.purpose||'').toLowerCase().includes(q)
      );
    }).slice(0, limit3).forEach(function(l){
      var t = getTenant(l.tenantId);
      if (!t) return;
      results.push({type:'tenant', id:l.tenantId, iconCls:'type-unit', iconTxt:'L',
        title:tenantNameHtml(t) + ' — Loan',
        sub:'$'+(l.principal||0).toFixed(2)+' · '+escapeHtml(l.status||''), badge:'Loan', badgeCls:'badge-unit'});
    });
  }

  if (!results.length) {
    resultsEl.classList.add('open');
    resultsEl.innerHTML = '<div class="lookup-empty">No matches found</div>';
    return;
  }
  resultsEl.classList.add('open');
  resultsEl.innerHTML = results.map(function(r){
    var safeId = (r.id||'').replace(/'/g,"\\'");
    return '<div class="lookup-result" onclick="finSearchSelectResult(\''+r.type+'\',\''+safeId+'\')">'
      + '<div class="lookup-result-icon '+r.iconCls+'">'+r.iconTxt+'</div>'
      + '<div class="lookup-result-main">'
        + '<div class="lookup-result-title">'+r.title+'</div>'
        + '<div class="lookup-result-sub">'+r.sub+'</div>'
      + '</div>'
      + '<span class="lookup-result-badge '+r.badgeCls+'">'+r.badge+'</span>'
      + '</div>';
  }).join('');
}

function finSearchSelectResult(type, id) {
  var el = document.getElementById('fin_search_results');
  if (el) { el.classList.remove('open'); el.innerHTML = ''; }
  var inp = document.getElementById('fin_search_input');
  if (inp) inp.value = '';
  openFinanceCard(id);
}


function openNewLoanForTenant(tid) {
  openModal('modalNewLoan');
  setTimeout(function(){
    var s = document.getElementById('ln-tenant'); if(s) s.value = tid;
    if (typeof calcLoan === 'function') calcLoan();
  }, 80);
}
