function initTxnFilters() {
  var d = getData();
  // Canonical persons only — merged-away duplicates roll up under the keeper.
  var _tens = (typeof finVisibleTenants==='function')?finVisibleTenants():(d.tenants||[]).filter(function(t){return !t.mergedInto;});
  var opts = _tens.map(function(t){return '<option value="'+t.id+'">'+tenantName(t)+' - '+t.unit+'</option>';}).join('');
  var sel = document.getElementById('txn-filter-tenant');
  if (sel && sel.options.length < 2) sel.innerHTML = '<option value="all">All Tenants</option>'+opts;
}

function getAllTransactions() {
  var d = getData();
  // Honour the header "Show voided entries" toggle like the rent ledger does.
  // Without this filter, every voided ORIGINAL and its reversal both counted
  // in the stat cards (Total Charges/Payments each overstated by every voided
  // amount), and the toggle showPage wires on this page did nothing.
  var _skipVoided = !window._finShowVoided && typeof finIsVoided === 'function';
  function _inc(e){ return !_skipVoided || !finIsVoided(e); }
  var txns = [];
  d.rentLedger.filter(_inc).forEach(function(r) {
    txns.push({ date:r.date, tenantId:r.tenantId, ledger: r.gl || 'rent',
      desc:r.desc, charge:r.charge||0, payment:r.payment||0,
      method:r.method||'', status:r.status||'', ref:r.ref||'', id:r.id });
  });
  d.arrPayments.filter(_inc).forEach(function(p) {
    txns.push({ date:p.date, tenantId:p.tenantId, ledger:'arrangement',
      desc:'Arrangement payment', charge:0, payment:p.amount||0,
      method:p.method||'', status:p.status||'', ref:'', id:p.id });
  });
  d.loanPayments.filter(_inc).forEach(function(p) {
    txns.push({ date:p.date, tenantId:p.tenantId, ledger:'loans',
      desc:'Loan payment', charge:0, payment:p.amount||0,
      method:p.method||'', status:p.status||'', ref:'', id:p.id });
  });
  (d.journalEntries||[]).filter(_inc).forEach(function(e) {
    txns.push({ date:e.date, tenantId:e.tenantId||'', ledger:'journal',
      desc:e.desc||e.memo||'', charge:e.debit||0, payment:e.credit||0,
      method:'', status:e.status||'posted', ref:e.ref||'', id:e.id });
  });
  txns.sort(function(a,b){ return b.date.localeCompare(a.date); });
  return txns;
}

function renderTransactions() {
  var d = getData();
  var filterTenant = (document.getElementById('txn-filter-tenant')||{}).value||'all';
  var filterLedger = (document.getElementById('txn-filter-ledger')||{}).value||'all';
  var filterType = (document.getElementById('txn-filter-type')||{}).value||'all';
  var filterFrom = (document.getElementById('txn-filter-from')||{}).value||'';
  var filterTo = (document.getElementById('txn-filter-to')||{}).value||'';
  var all = getAllTransactions();
  var txns = all.slice();
  if(filterTenant!=='all') txns=txns.filter(function(t){return t.tenantId===filterTenant;});
  if(filterLedger!=='all') txns=txns.filter(function(t){return t.ledger===filterLedger;});
  if(filterType==='charge') txns=txns.filter(function(t){return t.charge>0;});
  if(filterType==='payment') txns=txns.filter(function(t){return t.payment>0;});
  if(filterFrom) txns=txns.filter(function(t){return t.date>=filterFrom;});
  if(filterTo) txns=txns.filter(function(t){return t.date<=filterTo;});

  var totalCharge = txns.reduce(function(s,t){ return s+t.charge; }, 0);
  var totalPayment = txns.reduce(function(s,t){ return s+t.payment; }, 0);

  // Stats row
  var statsEl = document.getElementById('txnStats');
  if (statsEl) {
    statsEl.innerHTML =
      statCard('Transactions', txns.length, '', '') +
      statCard('Total Charges', fmt(totalCharge), '', totalCharge>0?'danger':'') +
      statCard('Total Payments', fmt(totalPayment), '', 'success') +
      statCard('Net Balance', fmt(totalCharge-totalPayment), '', totalCharge-totalPayment>0?'danger':'success');
  }

  // Meta + count
  var metaEl = document.getElementById('txn_page_meta');
  if (metaEl) {
    var today = new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'});
    metaEl.textContent = txns.length + ' shown · ' + all.length + ' total · Last updated ' + today;
  }
  var countEl = document.getElementById('txnCount');
  if (countEl) countEl.textContent = txns.length + ' shown · ' + all.length + ' total';

  var ledgerPill = {
    'rent':        '<span class="std-pill std-pill-info">Rent</span>',
    'arrangement': '<span class="std-pill std-pill-pending">Arrangement</span>',
    'loans':       '<span class="std-pill std-pill-info">Loans</span>',
    'loan':        '<span class="std-pill std-pill-info">Loans</span>',
    'journal':     '<span class="std-pill std-pill-voided">Journal</span>',
    'utility':     '<span class="std-pill std-pill-pending">Utility</span>'
  };

  function stdStatusPill(st){
    if (st === 'posted' || st === 'approved') return '<span class="std-pill std-pill-paid">'+(st.charAt(0).toUpperCase()+st.slice(1))+'</span>';
    if (st === 'pending' || st === 'pending-ed') return '<span class="std-pill std-pill-pending">'+(st==='pending-ed'?'Pending ED':'Pending')+'</span>';
    if (st === 'reversed' || st === 'voided') return '<span class="std-pill std-pill-voided">'+(st.charAt(0).toUpperCase()+st.slice(1))+'</span>';
    if (st === 'overdue') return '<span class="std-pill std-pill-overdue">Overdue</span>';
    if (st === 'active') return '<span class="std-pill std-pill-active">Active</span>';
    return '<span class="std-pill std-pill-info">'+(st||'—')+'</span>';
  }

  // Phase 2B: column-menu sort/filter
  var _txnCols = {
    date:    { label: 'Date',    accessor: function(t){ return t.date||''; } },
    tenant:  { label: 'Tenant',  accessor: function(t){ var tn=getTenant(t.tenantId); return tn?tenantName(tn):''; } },
    ledger:  { label: 'Ledger',  accessor: function(t){ return t.ledger||''; } },
    charge:  { label: 'Charge',  accessor: function(t){ return t.charge||0; } },
    payment: { label: 'Payment', accessor: function(t){ return t.payment||0; } },
    method:  { label: 'Method',  accessor: function(t){ return t.method||''; } },
    status:  { label: 'Status',  accessor: function(t){ return t.status||''; } }
  };
  var _txnAcc = {}; Object.keys(_txnCols).forEach(function(k){ _txnAcc[k] = _txnCols[k].accessor; });
  var _txnSt = (typeof tableStateGet==='function') ? tableStateGet('fin-txn') : {sort:{key:'',dir:1},filters:{}};
  if (typeof tableRegisterColumns==='function') tableRegisterColumns('fin-txn', {columns:_txnCols, getRows:function(){return txns;}, onChange:renderTransactions});
  if (!_txnSt.sort.key) txns.sort(function(a,b){ return (b.date||'').localeCompare(a.date||''); });
  txns = (typeof tableApplyFilterSort==='function') ? tableApplyFilterSort(txns, _txnAcc, _txnSt) : txns;

  var _txnCache = {};
  var rows = txns.map(function(t){
    var tn = getTenant(t.tenantId);
    var cacheKey = 'txn_' + t.id;
    _txnCache[cacheKey] = t;
    window._txnVoucherCache = _txnCache;
    return '<tr>'+
      '<td>'+t.date+'</td>'+
      '<td class="std-cell-primary">'+(tn?tenantName(tn):'<span class="std-cell-dash">—</span>')+
        (tn&&tn.unit?'<div style="font-size:11px;color:var(--muted);font-weight:normal;">'+tn.unit+'</div>':'')+'</td>'+
      '<td>'+(ledgerPill[t.ledger]||'<span class="std-pill std-pill-info">'+(t.ledger||'—')+'</span>')+'</td>'+
      '<td style="max-width:260px;white-space:normal;">'+(t.desc||'<span class="std-cell-dash">—</span>')+'</td>'+
      '<td class="std-cell-right">'+(t.charge>0?'<span class="amt-debit">'+fmt(t.charge)+'</span>':'<span class="std-cell-dash">—</span>')+'</td>'+
      '<td class="std-cell-right">'+(t.payment>0?'<span class="amt-credit">'+fmt(t.payment)+'</span>':'<span class="std-cell-dash">—</span>')+'</td>'+
      '<td style="font-size:12px;">'+methodLabel(t.method)+'</td>'+
      '<td>'+stdStatusPill(t.status)+'</td>'+
      '<td class="std-cell-tail"><button class="btn btn-ghost btn-sm" onclick="openVoucher(window._txnVoucherCache[\'txn_'+t.id+'\'])">&#128203;</button></td>'+
    '</tr>';
  }).join('');

  var bodyEl = document.getElementById('transactionsBody');
  if (bodyEl) {
    if (!all.length) {
      bodyEl.innerHTML = '<tr class="empty-row"><td colspan="9">No transactions yet. Record a payment or create an invoice to get started.</td></tr>';
    } else if (!rows) {
      bodyEl.innerHTML = '<tr class="empty-row"><td colspan="9">No transactions match the current filters. <a href="#" onclick="clearTxnFilters();return false;" style="color:var(--text);text-decoration:underline;">Clear filters</a> to show all.</td></tr>';
    } else {
      bodyEl.innerHTML = rows;
    }
  }
  var _txnThead = document.getElementById('fin_txn_thead');
  if (_txnThead && typeof tableBindColumnMenuClicks==='function') tableBindColumnMenuClicks(_txnThead, 'fin-txn');
  if (_txnThead && typeof tableRefreshSortIndicators==='function') tableRefreshSortIndicators(_txnThead, 'fin-txn');
}

function renderAuditLog() {
  var contentEl = document.getElementById('auditLogContent');
  if (!contentEl) return;
  contentEl.innerHTML = '<div style="text-align:center;padding:40px;color:var(--muted);">Loading audit log&hellip;</div>';
  var nation = (typeof _NATION === 'function') ? _NATION() : 'clfn';
  var path = 'finance_audit_log?nation_id=eq.' + encodeURIComponent(nation)
    + '&order=occurred_at.desc&limit=500';
  _fetchFromSupabase(path)
    .then(function(resp) {
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      return resp.json();
    })
    .then(function(data) {
      var filterUser   = ((document.getElementById('audit-filter-user')  ||{}).value || 'all');
      var filterAction = ((document.getElementById('audit-filter-action')||{}).value || 'all');
      var filterSearch = ((document.getElementById('audit-filter-search')||{}).value || '').toLowerCase();
      // Populate user dropdown
      var emails = [];
      (data||[]).forEach(function(e) {
        var u = e.actor_email || e.actor_name || '';
        if (u && emails.indexOf(u) < 0) emails.push(u);
      });
      var uSel = document.getElementById('audit-filter-user');
      if (uSel) {
        uSel.innerHTML = '<option value="all">All Users</option>'
          + emails.map(function(u) {
              return '<option value="'+escapeHtml(u)+'"'+(u===filterUser?' selected':'')+'>'+escapeHtml(u)+'</option>';
            }).join('');
      }
      var filtered = (data||[]).filter(function(e) {
        var actor = e.actor_email || e.actor_name || '';
        if (filterUser !== 'all' && actor !== filterUser) return false;
        if (filterAction !== 'all' && e.action !== filterAction) return false;
        if (filterSearch && !JSON.stringify(e).toLowerCase().includes(filterSearch)) return false;
        return true;
      });
      if (!filtered.length) {
        contentEl.innerHTML = '<div class="card" style="text-align:center;padding:40px;color:var(--muted);">No audit entries found.</div>';
        return;
      }
      var actionIcons = {
        create:'&#10133;', update:'&#9998;', delete:'&#128465;',
        void_entry:'&#8635;', approve:'&#10003;', decline:'&#10007;', reverse:'&#8617;'
      };
      var html = filtered.map(function(e) {
        var icon = actionIcons[e.action] || '&#9679;';
        var ts   = new Date(e.occurred_at).toLocaleString('en-CA');
        var actor = escapeHtml(e.actor_name || e.actor_email || 'Unknown');
        var role  = e.actor_role ? ' <span style="font-size:10px;color:var(--muted);">('+escapeHtml(e.actor_role)+')</span>' : '';
        var detailHtml = '';
        if (e.detail && typeof e.detail === 'object') {
          var keys = Object.keys(e.detail).slice(0, 5);
          if (keys.length) {
            detailHtml = '<div class="audit-diff">'
              + keys.map(function(k){ return escapeHtml(k)+': '+escapeHtml(JSON.stringify(e.detail[k])); }).join('<br>')
              + '</div>';
          }
        }
        return '<div class="audit-entry '+(e.action||'')+'">'+
          '<div class="audit-meta">'+icon+' <strong>'+actor+'</strong>'+role+' &mdash; '+ts+
          ' &mdash; <span style="text-transform:uppercase;font-size:10px;font-weight:700;letter-spacing:.5px;">'+escapeHtml(e.action||'')+'</span></div>'+
          '<div style="font-size:13px;">'+escapeHtml(e.summary||'')+'</div>'+
          detailHtml+
        '</div>';
      }).join('');
      contentEl.innerHTML = '<div class="card"><div class="ctitle">'+filtered.length+' entries</div>'+html+'</div>';
    })
    .catch(function(err) {
      contentEl.innerHTML = '<div class="card" style="text-align:center;padding:40px;color:var(--danger);">Failed to load audit log: '+escapeHtml(err.message)+'</div>';
    });
}

function clearCollectionsFilters(){
  ['cfilt_status','cfilt_amt_min','cfilt_amt_max','cfilt_search'].forEach(function(id){
    var el = document.getElementById(id); if(el) el.value = '';
  });
  var dEl = document.getElementById('cfilt_date'); if (dEl) dEl.value = 'all';
  renderCollections();
}

function renderCollections() {
  var d = getData();
  var all = d.collections || [];

  // Pull filters
  var fStatus = (document.getElementById('cfilt_status') ||{}).value || '';
  var fDate   = (document.getElementById('cfilt_date')   ||{}).value || 'all';
  var fMin    = parseFloat((document.getElementById('cfilt_amt_min')||{}).value);
  var fMax    = parseFloat((document.getElementById('cfilt_amt_max')||{}).value);
  var fSearch = ((document.getElementById('cfilt_search')||{}).value || '').trim().toLowerCase();

  // Date cutoff
  var cutoff = null;
  var todayD = new Date();
  if (fDate === '30')       cutoff = new Date(todayD.getTime() - 30*24*60*60*1000);
  else if (fDate === '90')  cutoff = new Date(todayD.getTime() - 90*24*60*60*1000);
  else if (fDate === '365') cutoff = new Date(todayD.getTime() - 365*24*60*60*1000);

  var list = all.filter(function(c){
    if (cutoff && c.dateFlagged && new Date(c.dateFlagged) < cutoff) return false;
    if (fStatus) {
      if (fStatus === 'active') {
        if (c.status === 'resolved' || c.status === 'cancelled') return false;
      } else if ((c.status||'') !== fStatus) {
        return false;
      }
    }
    var amt = parseFloat(c.amountAtReferral) || 0;
    if (!isNaN(fMin) && amt < fMin) return false;
    if (!isNaN(fMax) && amt > fMax) return false;
    if (fSearch) {
      var t = getTenant(c.tenantId);
      var hay = ((t?tenantName(t):'') + ' ' + (c.agency||'') + ' ' + (c.ref||'') + ' ' + (c.notes||'')).toLowerCase();
      if (hay.indexOf(fSearch) === -1) return false;
    }
    return true;
  });

  // Phase 2B: column-menu sort/filter
  var totals = calcAllTotals(d);
  var _cCols = {
    tenant:           { label: 'Tenant',            accessor: function(c){ var t=getTenant(c.tenantId); return t?tenantName(t):''; } },
    dateFlagged:      { label: 'Date Flagged',       accessor: function(c){ return c.dateFlagged||''; } },
    amountAtReferral: { label: 'Amount at Referral', accessor: function(c){ return parseFloat(c.amountAtReferral)||0; } },
    agency:           { label: 'Agency',             accessor: function(c){ return c.agency||''; } },
    currentBalance:   { label: 'Current Balance',    accessor: function(c){ var b=totals[c.tenantId]||{}; return (b.rent||0)+(b.loan||0)+(b.arrangement||0); } },
    status:           { label: 'Status',             accessor: function(c){ return c.status||''; } }
  };
  var _cAcc = {}; Object.keys(_cCols).forEach(function(k){ _cAcc[k] = _cCols[k].accessor; });
  var _cSt = (typeof tableStateGet==='function') ? tableStateGet('fin-col') : {sort:{key:'',dir:1},filters:{}};
  if (typeof tableRegisterColumns==='function') tableRegisterColumns('fin-col', {columns:_cCols, getRows:function(){return list;}, onChange:renderCollections});
  if (!_cSt.sort.key) list.sort(function(a,b){ return (b.dateFlagged||'').localeCompare(a.dateFlagged||''); });
  list = (typeof tableApplyFilterSort==='function') ? tableApplyFilterSort(list, _cAcc, _cSt) : list;

  // Meta + count
  var metaEl = document.getElementById('col_page_meta');
  if (metaEl) {
    var today = new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'});
    var openCount = all.filter(function(c){ return c.status !== 'resolved' && c.status !== 'cancelled'; }).length;
    metaEl.textContent = openCount + ' open · ' + all.length + ' total · Last updated ' + today;
  }
  var countEl = document.getElementById('collectionsCount');
  if (countEl) countEl.textContent = list.length + ' shown · ' + all.length + ' total';

  var bodyEl = document.getElementById('collectionsBody');
  if (!bodyEl) return;

  if (!all.length) {
    bodyEl.innerHTML = '<tr class="empty-row"><td colspan="8">No collection flags on file. Use <strong>🚨 Flag Account</strong> to refer an account.</td></tr>';
    return;
  }
  if (!list.length) {
    bodyEl.innerHTML = '<tr class="empty-row"><td colspan="8">No collections match the current filters. <a href="#" onclick="clearCollectionsFilters();return false;" style="color:var(--text);text-decoration:underline;">Clear filters</a> to show all.</td></tr>';
    return;
  }

  function pillFor(status){
    if (status === 'approved') return '<span class="std-pill std-pill-overdue">Active</span>';
    if (status === 'pending-ed') return '<span class="std-pill std-pill-pending">Pending ED</span>';
    if (status === 'resolved') return '<span class="std-pill std-pill-paid">Resolved</span>';
    if (status === 'cancelled' || status === 'voided') return '<span class="std-pill std-pill-voided">Cancelled</span>';
    return '<span class="std-pill std-pill-info">'+(status||'—')+'</span>';
  }

  bodyEl.innerHTML = list.map(function(c){
    var t = getTenant(c.tenantId);
    var bal = totals[c.tenantId] || {};
    var curBalance = (bal.rent||0) + (bal.loan||0) + (bal.arrangement||0);
    var safeCid = (c.id||'').replace(/'/g, "\\'");
    var actionBtn = (c.status==='resolved' || c.status==='cancelled')
      ? ''
      : '<button class="btn btn-ghost btn-sm" onclick="resolveCollection(\''+safeCid+'\')">Mark Resolved</button>';
    return '<tr>'+
      '<td class="std-cell-primary">'+(t?tenantName(t):'<span class="std-cell-dash">—</span>')+
        (t&&t.unit?'<div style="font-size:11px;color:var(--muted);font-weight:normal;">'+t.unit+'</div>':'')+'</td>'+
      '<td>'+(c.dateFlagged||'<span class="std-cell-dash">—</span>')+'</td>'+
      '<td class="std-cell-right"><span class="amt-debit">'+fmt(c.amountAtReferral||0)+'</span></td>'+
      '<td style="font-size:12px;">'+
        (c.agency ? '<div>'+c.agency+'</div>' : '<span class="std-cell-dash">—</span>')+
        (c.ref ? '<div style="color:var(--muted);font-size:11px;">Ref: '+c.ref+'</div>' : '')+'</td>'+
      '<td class="std-cell-right '+(curBalance>0?'balance-owed':'balance-clear')+'">'+fmt(curBalance)+'</td>'+
      '<td>'+pillFor(c.status)+'</td>'+
      '<td style="font-size:12px;color:var(--muted);max-width:240px;">'+
        (c.notes ? (c.notes.length>80 ? c.notes.slice(0,80)+'…' : c.notes) : '<span class="std-cell-dash">—</span>')+
        '</td>'+
      '<td class="std-cell-tail">'+actionBtn+'</td>'+
    '</tr>';
  }).join('');
  var _cThead = document.getElementById('fin_col_thead');
  if (_cThead && typeof tableBindColumnMenuClicks==='function') tableBindColumnMenuClicks(_cThead, 'fin-col');
  if (_cThead && typeof tableRefreshSortIndicators==='function') tableRefreshSortIndicators(_cThead, 'fin-col');
}





