// MODAL
function openModal(id,extra){
  if(extra)currentUtilityType=extra;
  if(id==='modalUtilityCharge')document.getElementById('utilChargeTitle').textContent='Post '+(currentUtilityType==='gas'?'Gas':'Hydro')+' Charge';
  if(id==='modalUtilityPayment')document.getElementById('utilPayTitle').textContent='Record '+(currentUtilityType==='gas'?'Gas':'Hydro')+' Payment';
  populateModalSelects(id);
  // Ensure unit picker datalist is current when the tenant form is opening
  if(id==='modalTenantForm' && typeof _populateUnitDatalist === 'function') _populateUnitDatalist();
  var _mEl = document.getElementById(id);
  if (_mEl) { _mEl.style.display = ''; _mEl.classList.add('on'); }
  // Auto-init payment modal
  if(id==='modalRentPayment'){
    var dateEl=document.getElementById('rp-date');
    if(dateEl&&!dateEl.value) dateEl.value=today();
    setTimeout(function(){ loadUnifiedPaymentContext(); }, 100);
  }
}
function closeModal(id){
  var _mEl = document.getElementById(id);
  if (_mEl) { _mEl.classList.remove('on'); _mEl.style.display = 'none'; }
}

function populateModalSelects(id){
  var d=getData();
  // Canonical persons only — never offer a merged-away duplicate as a charge target.
  var _tens=(typeof finVisibleTenants==='function')?finVisibleTenants():(d.tenants||[]).filter(function(t){return !t.mergedInto;});
  var opts=_tens.map(function(t){return '<option value="'+t.id+'">'+tenantNameHtml(t)+' - '+escapeHtml(t.unit||'')+'</option>';}).join('');
  var selMap={'modalNewInvoice':'inv-tenant','modalRentPayment':'rp-tenant','modalNewLoan':'ln-tenant','modalUtilityCharge':'uc-tenant','modalUtilityPayment':'up-tenant','modalJournalEntry':'je-tenant','modalNewArrangement':'na-tenant','modalFlagCollections':'col-tenant'};
  var selId=selMap[id];
  if(selId){var el=document.getElementById(selId);if(el)el.innerHTML=opts;}
  if(id==='modalOpeningBalance'){
    var cur=document.getElementById('rentTenantSelect');
    var ob=document.getElementById('ob-tenant');
    if(cur&&ob){var t=getTenant(cur.value);if(t)ob.value=tenantName(t);}
  }
  if(id==='modalFlagCollections'){setTimeout(fillCollectionsAmount,60);}
  if(id==='modalNewInvoice'){setTimeout(autoFillInvoice,60);}
}

function initTenantSelects(){
  var d=getData();
  // Canonical persons only — a merged-away duplicate must not be selectable.
  var _tens=(typeof finVisibleTenants==='function')?finVisibleTenants():(d.tenants||[]).filter(function(t){return !t.mergedInto;});
  var opts=_tens.map(function(t){return '<option value="'+t.id+'">'+tenantNameHtml(t)+' - '+escapeHtml(t.unit||'')+'</option>';}).join('');
  ['rentTenantSelect','stmtTenantSelect','loanSchedTenantSelect'].forEach(function(sid){
    var el=document.getElementById(sid);
    if(!el)return;
    var cur=el.value;
    el.innerHTML='<option value="">\u2014 Select Tenant \u2014</option>'+opts;
    if(cur)el.value=cur;
  });
  // Selects that support an "All Tenants" option
  ['journalTenantSelect','arrTenantSelect','loanTenantSelect'].forEach(function(sid){
    var el=document.getElementById(sid);
    if(!el)return;
    var cur=el.value;
    el.innerHTML='<option value="all">All Tenants</option>'+opts;
    if(cur)el.value=cur; else el.value='all';
  });
  // Sync visible search labels
  ['rent','loan','journal','arr'].forEach(function(key){
    syncTenantPickerLabel(key);
  });
}

// ── Tenant search pickers ─────────────────────────────────────────────────
// Replaces the "Select Tenant" dropdowns with a search-as-you-type input.
// Each page has a search input + hidden results panel. Selecting a result
// writes to the hidden <select id="xxxTenantSelect"> and fires its onchange
// so all the existing render code keeps working unchanged.
//
// The hidden select remains the single source of truth for which tenant
// is "selected" on each page. The search input is just UI sugar on top.
var _TENANT_PICKERS = {
  rent:    { input:'rentTenantSearch',    results:'rentTenantResults',    select:'rentTenantSelect',    allowAll:false, trigger:'renderRentLedger' },
  arr:     { input:'arrTenantSearch',     results:'arrTenantResults',     select:'arrTenantSelect',     allowAll:true,  trigger:'renderArrangementsPage' },
  loan:    { input:'loanTenantSearch',    results:'loanTenantResults',    select:'loanTenantSelect',    allowAll:true,  trigger:'renderLoansPage' },
  journal: { input:'journalTenantSearch', results:'journalTenantResults', select:'journalTenantSelect', allowAll:true,  trigger:'renderJournal' }
};

// Show matching tenants as the user types. Empty query → empty results (hidden).
function tenantPickerSearch(key, q){
  var cfg = _TENANT_PICKERS[key]; if(!cfg) return;
  var resultsEl = document.getElementById(cfg.results); if(!resultsEl) return;
  var d = getData();
  var ql = (q||'').trim().toLowerCase();
  resultsEl.style.display = 'block';
  var rows = '';
  // Offer "All Tenants" option at the top if this picker supports it
  if (cfg.allowAll) {
    rows += '<div class="tenant-search-result" onclick="tenantPickerSelect(\''+key+'\',\'all\')">'
      + '<div class="tsr-avatar" style="background:var(--yellow);color:#111;">*</div>'
      + '<div><div class="tsr-name">All Tenants</div><div class="tsr-meta">Show every tenant</div></div>'
      + '</div>';
  }
  var matches = d.tenants.filter(function(t){
    if (t.mergedInto) return false;   // never offer a merged-away duplicate
    if (!ql) return true;
    return tenantName(t).toLowerCase().includes(ql)
      || (t.unit||'').toLowerCase().includes(ql)
      || (t.phone||'').includes(ql)
      || (t.email||'').toLowerCase().includes(ql);
  }).slice(0, 10);
  if (!matches.length && ql) {
    rows += '<div class="tenant-search-result" style="cursor:default;color:var(--muted);">No tenants found</div>';
  } else {
    rows += matches.map(function(t){
      var initials = ((t.first||'')[0]||'') + ((t.last||'')[0]||'');
      if (!initials) initials = '?';
      var safeId = (t.id||'').replace(/'/g, "\\'");
      var unitLabel = (t.unit||'');
      var typeLabel = (t.type||'').replace(/-/g,' ');
      return '<div class="tenant-search-result" onclick="tenantPickerSelect(\''+key+'\',\''+safeId+'\')">'
        + '<div class="tsr-avatar">'+initials+'</div>'
        + '<div><div class="tsr-name">'+tenantNameHtml(t)+'</div>'
        + '<div class="tsr-meta">'+(unitLabel?unitLabel+' · ':'')+typeLabel+'</div></div>'
        + '</div>';
    }).join('');
  }
  resultsEl.innerHTML = rows;
}

// Select a tenant — writes to the hidden <select>, fires onchange to re-render.
function tenantPickerSelect(key, tid){
  var cfg = _TENANT_PICKERS[key]; if(!cfg) return;
  var sel = document.getElementById(cfg.select);
  var inp = document.getElementById(cfg.input);
  var resultsEl = document.getElementById(cfg.results);
  if (sel) {
    sel.value = tid;
    // Fire the existing render function
    if (cfg.trigger && typeof window[cfg.trigger] === 'function') window[cfg.trigger]();
  }
  // Update the visible input label
  if (inp) {
    if (tid === 'all') {
      inp.value = '';
      inp.placeholder = 'All Tenants — click to filter by name, unit, phone or email...';
    } else {
      var d = getData();
      var t = d.tenants.find(function(x){ return x.id === tid; });
      inp.value = t ? tenantName(t) + (t.unit ? ' — ' + t.unit : '') : '';
    }
  }
  if (resultsEl) resultsEl.style.display = 'none';
}

// After initTenantSelects runs, sync the visible input with the hidden select's
// current value so re-entering a page shows the previously-selected tenant.
function syncTenantPickerLabel(key){
  var cfg = _TENANT_PICKERS[key]; if(!cfg) return;
  var sel = document.getElementById(cfg.select);
  var inp = document.getElementById(cfg.input);
  if (!sel || !inp) return;
  var tid = sel.value;
  if (!tid || tid === '') {
    inp.value = '';
    return;
  }
  if (tid === 'all') {
    inp.value = '';
    return;
  }
  var d = getData();
  var t = d.tenants.find(function(x){ return x.id === tid; });
  if (t) inp.value = tenantName(t) + (t.unit ? ' — ' + t.unit : '');
}

// Clicking into the search input should show all tenants (or recent) by default
// so the user doesn't have to type to see options.
function tenantPickerFocus(key){
  tenantPickerSearch(key, '');
}

