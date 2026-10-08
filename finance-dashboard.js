function calcAllTotals(d){
  var result={};
  // Only canonical persons get a balance bucket; a row merged into another
  // person has had its ledger/loans canonicalized onto the keeper, so it would
  // otherwise show as a phantom $0 "clear" account.
  d.tenants.forEach(function(t){if(t.mergedInto)return;result[t.id]={rent:0,loan:0,arrangement:0};});
  d.rentLedger.forEach(function(r){if(result[r.tenantId]&&!finIsVoided(r))result[r.tenantId].rent+=r.charge-r.payment;});

  d.loanList.forEach(function(ln){
    if(!result[ln.tenantId])return;
    if(ln.status!=='approved')return; // only count approved loans
    var paid=d.loanPayments.filter(function(p){return p.loanId===ln.id;}).reduce(function(s,p){return s+p.amount;},0);
    result[ln.tenantId].loan+=Math.max(0,ln.principal-paid);
  });
  d.arrangements.forEach(function(arr){
    if(!result[arr.tenantId])return;
    if(arr.status!=='approved')return; // only count approved arrangements
    var paid=d.arrPayments.filter(function(p){return p.arrId===arr.id;}).reduce(function(s,p){return s+p.amount;},0);
    result[arr.tenantId].arrangement+=Math.max(0,arr.totalOwing-paid);
  });
  // Round to cents at the boundary — raw float accumulation leaves 1e-16
  // residue (0.10+0.20-0.30), which made fully-paid accounts fail the
  // "Accounts Clear" <= 0 test and render a danger-styled $0.00.
  Object.keys(result).forEach(function(tid){
    var v = result[tid];
    v.rent = Math.round(v.rent*100)/100;
    v.loan = Math.round(v.loan*100)/100;
    v.arrangement = Math.round(v.arrangement*100)/100;
  });
  return result;
}

function statCard(lbl,val,sub,cls){
  return '<div class="stat-card '+(cls||'')+'"><div class="stat-num">'+val+'</div><div class="stat-lbl">'+lbl+'</div>'+(sub?'<div class="stat-sub">'+sub+'</div>':'')+'</div>';
}

// DASHBOARD

function dashSelectTenant(tid) {
  // Navigate to tenants page and load this profile directly
  showPage('tenants');
  setTimeout(function(){
    var inp = document.getElementById('tenantSearchInput');
    if (inp) { inp.value = tenantName(getTenant(tid)||{})||''; }
    selectTenantProfile(tid);
  }, 150);
}

// \u2500\u2500 FINANCE WORKLIST (role-aware) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function renderFinanceWorklist() {
  var wrap = document.getElementById('finance-worklist-wrap');
  var body = document.getElementById('finance-worklist-body');
  var countEl = document.getElementById('finance-worklist-count');
  var titleEl = document.getElementById('finance-worklist-title');
  if (!wrap || !body) return;
  // Read role fresh at call time — _currentRole is set at parse time and may
  // not yet reflect the restored session when called during boot.
  var role = (typeof HOUSING_SESSION !== 'undefined' && HOUSING_SESSION && HOUSING_SESSION.role)
    ? (window.CLFN_PERMS ? window.CLFN_PERMS.normalizeRole(HOUSING_SESSION.role) : HOUSING_SESSION.role)
    : _currentRole;
  var d = getData();
  var items = [];
  var isED = (role === 'ed');
  var isFinance = (role === 'cfo' || role === 'finance_l1' || role === 'housing_manager');
  if (isED || isFinance) {
    // Journal entries pending ED review — group by ref
    var seenRefs = {};
    (d.journalEntries || []).forEach(function(j) {
      if (j.status !== 'pending-ed') return;
      var key = (j.ref && j.ref !== '') ? j.ref : j.id;
      if (seenRefs[key]) return;
      seenRefs[key] = true;
      var groupLines = (j.ref && j.ref !== '')
        ? (d.journalEntries||[]).filter(function(x){ return x.ref === j.ref; })
        : [j];
      var t = getTenant(j.tenantId);
      var tName = t ? tenantName(t) : 'No tenant';
      var totalDR = 0;
      groupLines.forEach(function(x){ totalDR += (x.debit||x.charge||0); });
      items.push({
        icon: '📓',
        label: 'Journal Entry',
        sub: tName + ' · ' + groupLines.length + ' lines · $' + totalDR.toFixed(2) + ' DR',
        memo: j.desc || j.memo || '',
        date: j.date || '',
        approveRef: j.ref || '',
        approveId:  j.id  || '',
        isEDAction: isED,
        action: isED
          ? '<button class="btn btn-xs btn-ghost" onclick="showPage(\'journal\')">View All</button>'
          : '<button class="btn btn-xs btn-ghost" onclick="showPage(\'journal\')">View</button>'
      });
    });
    // Loans pending ED approval
    (d.loanList || []).forEach(function(l) {
      if (l.status !== 'pending-ed') return;
      var t = getTenant(l.tenantId);
      var tName = t ? tenantName(t) : 'No tenant';
      items.push({
        icon: '💰', label: 'Loan Approval',
        sub: tName + ' · $' + (l.principal||0).toFixed(2),
        memo: l.purpose || l.notes || '', date: l.start || '',
        action: isED
          ? '<button class="btn btn-xs btn-primary" onclick="approveLoan(\''+l.id+'\')">Approve</button>'
            + '<button class="btn btn-xs btn-ghost" onclick="showPage(\'loans\')">View</button>'
          : '<button class="btn btn-xs btn-ghost" onclick="showPage(\'loans\')">View</button>'
      });
    });
    // Arrangements pending
    (d.arrangements || []).forEach(function(a) {
      if (a.status !== 'pending-ed' && a.status !== 'pending') return;
      var t = getTenant(a.tenantId);
      var tName = t ? tenantName(t) : 'No tenant';
      items.push({
        icon: '📋', label: 'Payment Arrangement',
        sub: tName + ' · $' + (a.totalOwing||a.amount||0).toFixed(2),
        memo: a.notes || '', date: a.startDate || a.date || '',
        action: '<button class="btn btn-xs btn-ghost" onclick="showPage(\'arrangements\')">View</button>'
      });
    });
    // Pending reversals
    (d.rentLedger || []).forEach(function(r) {
      if (r.status !== 'pending-reversal') return;
      var t = getTenant(r.tenantId);
      var tName = t ? tenantName(t) : 'No tenant';
      items.push({
        icon: '\u21a9\ufe0f', label: 'Pending Reversal',
        sub: tName + ' · $' + (r.amount||r.charge||r.payment||0).toFixed(2),
        memo: r.desc || r.memo || '', date: r.date || '',
        action: '<button class="btn btn-xs btn-ghost" onclick="showPage(\'rent\')">View</button>'
      });
    });
  }
  if (items.length === 0) { wrap.style.display = 'none'; return; }
  wrap.style.display = 'block';
  if (countEl) countEl.textContent = items.length;
  if (titleEl) titleEl.innerHTML = '&#9888; ' + (isED ? 'Requires Your Approval' : 'Pending Items');
  body.innerHTML = items.map(function(item) {
    var actionBtns = '';
    if (item.isEDAction && item.approveRef !== undefined) {
      var r = item.approveRef.replace(/"/g,'&quot;');
      var i = item.approveId.replace(/"/g,'&quot;');
      actionBtns +=
        '<button class="btn btn-xs btn-primary" onclick="approveJournalEntry(&quot;'+r+'&quot;,&quot;'+i+'&quot;)">Approve</button> '
        + '<button class="btn btn-xs btn-ghost" onclick="openEditJournalModal(&quot;'+r+'&quot;,&quot;'+i+'&quot;)">Edit</button> '
        + '<button class="btn btn-xs btn-ghost" style="color:var(--danger);border-color:var(--danger);" onclick="showConfirm(\'Decline Entry\',\'Decline this journal entry?\',function(){declineJournalEntry(&quot;'+r+'&quot;,&quot;'+i+'&quot;);})">Decline</button> '
        + '<button class="btn btn-xs btn-ghost" style="color:var(--muted);" onclick="voidJournalEntry(&quot;'+r+'&quot;,&quot;'+i+'&quot;)">Void</button> ';
    }
    actionBtns += item.action;
    return '<div class="fwl-item">'+
      '<div class="fwl-icon">'+item.icon+'</div>'+
      '<div class="fwl-main">'+
        '<div class="fwl-label">'+item.label+'<span class="fwl-sub">'+item.sub+'</span></div>'+
        (item.memo ? '<div class="fwl-memo">'+item.memo+'</div>' : '')+
      '</div>'+
      '<div class="fwl-date">'+item.date+'</div>'+
      '<div class="fwl-actions">'+actionBtns+'</div>'+
    '</div>';
  }).join('');
}
function approveJournalEntry(ref, fallbackId) {
  var d = getData();
  var toApprove = (ref && ref !== '')
    ? (d.journalEntries||[]).filter(function(j){ return j.ref === ref; })
    : (d.journalEntries||[]).filter(function(j){ return j.id === fallbackId; });
  if (!toApprove.length) return;
  d.auditLog = d.auditLog || [];
  var approver = (typeof HOUSING_SESSION !== 'undefined') ? (HOUSING_SESSION.name || HOUSING_SESSION.email) : 'ED';
  toApprove.forEach(function(j) {
    var prev = j.status;
    j.status = 'posted';
    j.approvedBy = approver;
    j.approvedAt = today();
    writeAuditEntry({action:'approve_journal', entity_type:'journal', entity_id:j.id,
      summary:'Journal entry approved by '+approver, detail:{before:{status:prev}, after:{status:'posted'}}});
  });
  saveData(d);
  renderFinanceWorklist();
  renderDashboard();
  if (document.getElementById('page-journal') && document.getElementById('page-journal').classList.contains('on')) renderJournal();
}

function declineJournalEntry(ref, fallbackId) {
  var d = getData();
  var toDecline = (ref && ref !== '')
    ? (d.journalEntries||[]).filter(function(j){ return j.ref === ref; })
    : (d.journalEntries||[]).filter(function(j){ return j.id === fallbackId; });
  if (!toDecline.length) return;
  d.auditLog = d.auditLog || [];
  var actor = (typeof HOUSING_SESSION !== 'undefined') ? (HOUSING_SESSION.name || HOUSING_SESSION.email) : 'ED';
  toDecline.forEach(function(j) {
    var prev = j.status;
    j.status = 'declined';
    j.declinedBy = actor;
    j.declinedAt = today();
    var rl = (d.rentLedger||[]).find(function(r){ return r.id === j.id; });
    if (rl) { rl.status = 'declined'; }
    writeAuditEntry({action:'decline_journal', entity_type:'journal', entity_id:j.id,
      summary:'Journal entry declined by '+actor, detail:{before:{status:prev}, after:{status:'declined'}}});
  });
  saveData(d);
  renderFinanceWorklist();
  renderDashboard();
  if (document.getElementById('page-journal') && document.getElementById('page-journal').classList.contains('on')) renderJournal();
}

function voidJournalEntry(ref, fallbackId) {
  var d = getData();
  var group = (ref && ref !== '')
    ? (d.journalEntries||[]).filter(function(j){ return j.ref === ref; })
    : (d.journalEntries||[]).filter(function(j){ return j.id === fallbackId; });
  if (!group.length) return;
  var first = group[0];
  var preview = escapeHtml((first.memo || first.desc || '') + (group.length > 1 ? ' (' + group.length + ' lines)' : ''));
  showVoidModal({ label: 'Void Journal Entry', preview: preview }, function(reason) {
    voidJournalGroup(ref, fallbackId, reason);
    renderFinanceWorklist();
    renderDashboard();
    if (document.getElementById('page-journal') && document.getElementById('page-journal').classList.contains('on')) renderJournal();
  });
}

function openEditJournalModal(ref, fallbackId) {
  var d = getData();
  var group = (ref && ref !== '')
    ? (d.journalEntries||[]).filter(function(j){ return j.ref === ref; })
    : (d.journalEntries||[]).filter(function(j){ return j.id === fallbackId; });
  if (!group.length) return;
  var first = group[0];
  // Open journal modal pre-populated with the existing entry's lines
  jeResetModal();
  openModal('modalJournalEntry');
  // Set tenant and date
  var tenantEl = document.getElementById('je-tenant');
  if (tenantEl && first.tenantId) tenantEl.value = first.tenantId;
  var dateEl = document.getElementById('je-date');
  if (dateEl && first.date) dateEl.value = first.date;
  var memoEl = document.getElementById('je-memo');
  if (memoEl) memoEl.value = first.memo || first.desc || '';
  // Clear seed lines and repopulate from group
  _jeLineCount = 0;
  var container = document.getElementById('je-lines');
  if (container) container.innerHTML = '';
  group.forEach(function(j) {
    var type = (j.debit||j.charge||0) > 0 ? 'debit' : 'credit';
    var amount = type === 'debit' ? (j.debit||j.charge||0) : (j.credit||j.payment||0);
    jeAddLine(type, j.ledger, amount);
  });
  jeRecalc();
  // Mark the old entry as replaced when submitted — store ref for save
  window._jeEditRef = ref || fallbackId;
  window._jeEditIds = group.map(function(j){ return j.id; });
}

function kpiCard(lbl, val, sub, accent, onclick) {
  var cls = accent ? ' kpi-accent-'+accent : '';
  if (onclick) cls += ' kpi-clickable';
  var attrs = onclick ? ' onclick="'+onclick+'" role="button" tabindex="0"' : '';
  return '<div class="kpi-card'+cls+'"'+attrs+'>'
    + '<div class="kpi-label">'+lbl+'</div>'
    + '<div class="kpi-value">'+val+'</div>'
    + (sub ? '<div class="kpi-meta">'+sub+'</div>' : '')
    + '</div>';
}

function renderDashboard(){
  if (typeof renderFinanceWorklist === 'function') renderFinanceWorklist();
  var d=getData();
  var totals=calcAllTotals(d);
  var visTenants=(typeof finVisibleTenants==='function')?finVisibleTenants():d.tenants.filter(function(t){return !t.mergedInto;});
  var tR=0,tL=0,tA=0,colCount=0,clearCount=0;
  visTenants.forEach(function(t){
    var v=totals[t.id]||{};tR+=v.rent||0;tL+=v.loan||0;tA+=v.arrangement||0;
    if((v.rent||0)+(v.loan||0)+(v.arrangement||0)<=0) clearCount++;
  });
  colCount=d.collections.filter(function(c){return c.status==='approved';}).length;
  var grand=tR+tL+tA;
  var statsEl = document.getElementById('dashStats');
  if (statsEl) statsEl.innerHTML=
    kpiCard('Total Owing',    fmt(grand),                       'All ledgers — click to view', grand>0?'danger':'', "showKpiDrilldown('total')")+
    kpiCard('Rent Arrears',   fmt(tR),                          'Click to view by tenant',     tR>0?'danger':'',   "showKpiDrilldown('rent')")+
    kpiCard('Accounts Clear', clearCount,                       'of '+visTenants.length+' tenants', 'success',      "showKpiDrilldown('clear')")+
    kpiCard('Collections',    colCount+' file'+(colCount!==1?'s':''), 'Active',                colCount>0?'danger':'', "showPage('collections')");
}

function showKpiDrilldown(type) {
  var d = getData();
  var totals = calcAllTotals(d);
  var title, html;

  if (type === 'total') {
    title = 'Total Owing — All Accounts';
    var items = (typeof finVisibleTenants==='function'?finVisibleTenants():d.tenants).map(function(t) {
      var v = totals[t.id] || {};
      var loanBal = 0;
      d.loanList.filter(function(l){ return l.tenantId===t.id && l.status==='approved'; }).forEach(function(l){
        var paid = d.loanPayments.filter(function(p){ return p.loanId===l.id && p.status!=='reversed'; })
          .reduce(function(s,p){ return s+p.amount; }, 0);
        loanBal += Math.max(0, l.principal - paid);
      });
      return { t:t, rent:v.rent||0, arr:v.arrangement||0, loan:loanBal, total:Math.max(0,v.rent||0)+Math.max(0,v.arrangement||0)+loanBal };
    }).filter(function(r){ return r.total > 0; }).sort(function(a,b){ return b.total - a.total; });

    html = '<table class="tbl"><thead><tr>'
      + '<th>Tenant</th><th>Unit</th><th>Type</th>'
      + '<th class="std-cell-right">Rent</th><th class="std-cell-right">Arrangement</th>'
      + '<th class="std-cell-right">Loans</th><th class="std-cell-right">Total</th>'
      + '</tr></thead><tbody>'
      + (items.length ? items.map(function(r){
          var sid = (r.t.id||'').replace(/'/g,"\\'");
          return '<tr class="clickable" onclick="closeModal(\'modalKpiDrilldown\');openFinanceCard(\''+sid+'\')">'
            + '<td style="font-weight:600;">'+tenantName(r.t)+'</td>'
            + '<td>'+(r.t.unit||'&mdash;')+'</td>'
            + '<td class="std-cell-muted">'+(r.t.type||'').replace(/-/g,' ')+'</td>'
            + '<td class="std-cell-right '+(r.rent>0?'amt-debit':'')+'">'+fmt(Math.max(0,r.rent))+'</td>'
            + '<td class="std-cell-right '+(r.arr>0?'amt-debit':'')+'">'+fmt(r.arr)+'</td>'
            + '<td class="std-cell-right '+(r.loan>0?'amt-debit':'')+'">'+fmt(r.loan)+'</td>'
            + '<td class="std-cell-right amt-debit" style="font-weight:700;">'+fmt(r.total)+'</td>'
            + '</tr>';
        }).join('') : '<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:24px;">No outstanding balances.</td></tr>')
      + '</tbody></table>';

  } else if (type === 'rent') {
    title = 'Rent Arrears';
    var rentItems = (typeof finVisibleTenants==='function'?finVisibleTenants():d.tenants).map(function(t) {
      var rent = totals[t.id] ? (totals[t.id].rent||0) : 0;
      var pmts = (d.rentLedger||[]).filter(function(r){ return r.tenantId===t.id && r.type==='payment' && r.status!=='reversed'; });
      var lastPmt = pmts.length ? pmts.slice().sort(function(a,b){ return b.date.localeCompare(a.date); })[0].date : null;
      return { t:t, rent:rent, lastPmt:lastPmt };
    }).filter(function(r){ return r.rent > 0; }).sort(function(a,b){ return b.rent - a.rent; });

    html = '<table class="tbl"><thead><tr>'
      + '<th>Tenant</th><th>Unit</th><th>Type</th>'
      + '<th class="std-cell-right">Rent Owing</th><th>Last Payment</th>'
      + '</tr></thead><tbody>'
      + (rentItems.length ? rentItems.map(function(r){
          var sid = (r.t.id||'').replace(/'/g,"\\'");
          return '<tr class="clickable" onclick="closeModal(\'modalKpiDrilldown\');openFinanceCard(\''+sid+'\')">'
            + '<td style="font-weight:600;">'+tenantName(r.t)+'</td>'
            + '<td>'+(r.t.unit||'&mdash;')+'</td>'
            + '<td class="std-cell-muted">'+(r.t.type||'').replace(/-/g,' ')+'</td>'
            + '<td class="std-cell-right amt-debit" style="font-weight:700;">'+fmt(r.rent)+'</td>'
            + '<td class="std-cell-muted">'+(r.lastPmt||'None on file')+'</td>'
            + '</tr>';
        }).join('') : '<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:24px;">No rent arrears.</td></tr>')
      + '</tbody></table>';

  } else if (type === 'clear') {
    title = 'Accounts in Good Standing';
    var clearItems = (typeof finVisibleTenants==='function'?finVisibleTenants():d.tenants).filter(function(t){
      var v = totals[t.id]||{};
      var st = t.status||'active';
      return (v.rent||0)+(v.loan||0)+(v.arrangement||0) <= 0 && t.active!==false && st!=='former' && st!=='deceased';
    }).slice().sort(function(a,b){ return tenantName(a).localeCompare(tenantName(b)); });

    html = '<table class="tbl"><thead><tr>'
      + '<th>Tenant</th><th>Unit</th><th>Type</th><th>Balance</th>'
      + '</tr></thead><tbody>'
      + (clearItems.length ? clearItems.map(function(t){
          var sid = (t.id||'').replace(/'/g,"\\'");
          var v = totals[t.id]||{};
          var bal = (v.rent||0)+(v.loan||0)+(v.arrangement||0);
          return '<tr class="clickable" onclick="closeModal(\'modalKpiDrilldown\');openFinanceCard(\''+sid+'\')">'
            + '<td style="font-weight:600;">'+tenantNameHtml(t)+'</td>'
            + '<td>'+(t.unit||'&mdash;')+'</td>'
            + '<td class="std-cell-muted">'+(t.type||'').replace(/-/g,' ')+'</td>'
            + '<td class="amt-credit" style="font-weight:600;">'+(bal < 0 ? fmt(Math.abs(bal))+' CR' : fmt(0))+'</td>'
            + '</tr>';
        }).join('') : '<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:24px;">No accounts found.</td></tr>')
      + '</tbody></table>';
  }

  var existing = document.getElementById('modalKpiDrilldown');
  if (existing) document.body.removeChild(existing);
  var mo = document.createElement('div');
  mo.className = 'modal-ov';
  mo.id = 'modalKpiDrilldown';
  mo.innerHTML =
    '<div class="modal" style="max-width:820px;width:96%;">'
    + '<div class="modal-hdr"><div><h2>'+title+'</h2></div>'
    + '<button class="modal-close" onclick="closeModal(\'modalKpiDrilldown\')">&#x2715;</button></div>'
    + '<div class="modal-body" style="padding:0;"><div class="tbl-wrap">'+html+'</div></div>'
    + '</div>';
  document.body.appendChild(mo);
  mo.style.display = '';
  mo.classList.add('on');
}
