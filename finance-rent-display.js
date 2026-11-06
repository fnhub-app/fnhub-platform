// RENT LEDGER
function clearRentFilters(){
  var ids = ['rfilt_date','rfilt_type','rfilt_status','rfilt_amt_min','rfilt_amt_max'];
  ids.forEach(function(id){
    var el = document.getElementById(id);
    if (!el) return;
    if (id === 'rfilt_date') el.value = 'all';
    else el.value = '';
  });
  renderRentLedger();
}

function renderRentLedger(){
  var d=getData();
  var tid=document.getElementById('rentTenantSelect').value;
  var t=getTenant(tid);
  var bodyEl = document.getElementById('rentLedgerBody');
  var countEl = document.getElementById('rentLedgerCount');
  var metaEl  = document.getElementById('rent_page_meta');

  if(!t){
    // No tenant selected — show summary of all tenants with balances
    var allEntries = d.rentLedger || [];
    var summaryRows = d.tenants.filter(function(tn){ return !tn.archived; }).map(function(tn) {
      var entries = allEntries.filter(function(e){ return e.tenantId === tn.id && !finIsVoided(e); });
      if (!entries.length) return null;
      var charged = entries.reduce(function(s,e){ return s+(e.charge||0); }, 0);
      var paid    = entries.reduce(function(s,e){ return s+(e.payment||0); }, 0);
      var balance = charged - paid;
      var sorted  = entries.slice().sort(function(a,b){ return b.date.localeCompare(a.date); });
      var lastDate = sorted[0] ? sorted[0].date : '—';
      var balCell = balance > 0
        ? '<span class="amt-debit">$'+balance.toFixed(2)+'</span>'
        : balance < 0 ? '<span class="amt-credit">$'+Math.abs(balance).toFixed(2)+' CR</span>'
        : '<span style="color:var(--success);">Nil</span>';
      return '<tr style="cursor:pointer;" onclick="tenantPickerSelect(\'rent\',\''+tn.id+'\')" title="Click to view ledger">'
        + '<td style="font-size:11px;color:var(--muted);">'+lastDate+'</td>'
        + '<td class="std-cell-primary">'+tenantName(tn)+'<span style="font-size:11px;font-weight:400;color:var(--muted);margin-left:6px;">'+tn.unit+'</span></td>'
        + '<td style="color:var(--muted);font-size:12px;">'+entries.length+' entries</td>'
        + '<td class="std-cell-right"><span class="amt-debit">$'+charged.toFixed(2)+'</span></td>'
        + '<td class="std-cell-right"><span class="amt-credit">$'+paid.toFixed(2)+'</span></td>'
        + '<td class="std-cell-right">'+balCell+'</td>'
        + '<td></td><td><span class="std-pill std-pill-info">Click to view</span></td>'
        + '</tr>';
    }).filter(Boolean);
    if (bodyEl) bodyEl.innerHTML = summaryRows.length
      ? summaryRows.join('')
      : '<tr class="empty-row"><td colspan="8">No ledger entries yet.</td></tr>';
    if (countEl) countEl.textContent = summaryRows.length + ' tenants';
    if (metaEl) metaEl.textContent = 'All tenants — click a row to filter';
    document.getElementById('rentStats').innerHTML='';
    return;
  }
  var badge=typePill(t.type)+(t.autoPay?' <span class="pill pill-green">Auto-Pay</span>':'')+collectionsBadge(tid);
  document.getElementById('rentTenantBadge').innerHTML=badge;
  var ob=document.getElementById('ob-tenant');if(ob)ob.value=tenantName(t);

  // Pull filter selections
  var fDate   = (document.getElementById('rfilt_date')  ||{}).value || 'all';
  var fType   = (document.getElementById('rfilt_type')  ||{}).value || '';
  var fStatus = (document.getElementById('rfilt_status')||{}).value || '';
  var fMin    = parseFloat((document.getElementById('rfilt_amt_min')||{}).value);
  var fMax    = parseFloat((document.getElementById('rfilt_amt_max')||{}).value);

  // Date cutoff
  var cutoff = null;
  var todayD = new Date();
  if (fDate === 'this_month') {
    cutoff = new Date(todayD.getFullYear(), todayD.getMonth(), 1);
  } else if (fDate === '30') {
    cutoff = new Date(todayD.getTime() - 30*24*60*60*1000);
  } else if (fDate === '90') {
    cutoff = new Date(todayD.getTime() - 90*24*60*60*1000);
  }
  function passDate(dateStr){
    if (!cutoff) return true;
    var dt = new Date(dateStr);
    return dt >= cutoff;
  }

  // Running balance is computed on UNFILTERED rows to stay accurate.
  // Then we apply filters for display only.
  var allRows = d.rentLedger.filter(function(r){return r.tenantId===tid;}).sort(function(a,b){return a.date.localeCompare(b.date);});
  var balance=0, totalCharged=0, totalPaid=0;

  // First pass — compute running balance and totals across all rows
  allRows.forEach(function(r){
    balance += r.charge - r.payment;
    totalCharged += r.charge;
    totalPaid += r.payment;
    r._runningBalance = balance;
  });

  // Second pass — apply filters for what we render
  var rows = allRows.filter(function(r){
    if (!window._finShowVoided && finIsVoided(r)) return false;
    if (!passDate(r.date)) return false;
    if (fType && (r.type || '') !== fType) return false;
    if (fStatus) {
      // 'active' = default (not reversed, not voided, not overdue)
      var st = r.status || '';
      if (fStatus === 'active' && (st === 'reversed' || st === 'voided' || st === 'overdue')) return false;
      if (fStatus === 'paid'    && r.type !== 'payment') return false;
      if (fStatus === 'voided'  && st !== 'reversed' && st !== 'voided') return false;
      if (fStatus === 'overdue' && st !== 'overdue') return false;
    }
    var amt = (r.charge||0) + (r.payment||0);
    if (!isNaN(fMin) && amt < fMin) return false;
    if (!isNaN(fMax) && amt > fMax) return false;
    return true;
  });

  // Phase 2B: column-menu sort/filter (Balance column excluded — it's a running balance)
  var _rentCols = {
    date:    { label: 'Date',        accessor: function(r){ return r.date||''; } },
    desc:    { label: 'Description', accessor: function(r){ return r.desc||''; } },
    charge:  { label: 'Charge',      accessor: function(r){ return r.charge||0; } },
    payment: { label: 'Payment',     accessor: function(r){ return r.payment||0; } },
    method:  { label: 'Method',      accessor: function(r){ return r.method||''; } },
    status:  { label: 'Status',      accessor: function(r){ return r.status||''; } }
  };
  var _rentAcc = {}; Object.keys(_rentCols).forEach(function(k){ _rentAcc[k] = _rentCols[k].accessor; });
  var _rentSt = (typeof tableStateGet==='function') ? tableStateGet('fin-rent') : {sort:{key:'',dir:1},filters:{}};
  if (typeof tableRegisterColumns==='function') tableRegisterColumns('fin-rent', {columns:_rentCols, getRows:function(){return rows;}, onChange:renderRentLedger});
  rows = (typeof tableApplyFilterSort==='function') ? tableApplyFilterSort(rows, _rentAcc, _rentSt) : rows;

  var html = rows.map(function(r){
    var isArr=r.type==='arrangement-line';
    var isVoid=finIsVoided(r);
    var bal = r._runningBalance;
    var trStyle = isArr ? 'background:var(--yellow-light);' : isVoid ? 'opacity:.45;text-decoration:line-through;' : '';
    return '<tr'+(trStyle?' style="'+trStyle+'"':'')+'>'+
      '<td>'+r.date+'</td>'+
      '<td>'+r.desc+(isArr?' <span class="pill pill-yellow" style="font-size:10px;">Arrangement</span>':'')+'</td>'+
      '<td class="std-cell-right">'+(r.charge>0?'<span class="amt-debit">'+fmt(r.charge)+'</span>':'<span class="std-cell-dash">&mdash;</span>')+'</td>'+
      '<td class="std-cell-right">'+(r.payment>0?'<span class="amt-credit">'+fmt(r.payment)+'</span>':'<span class="std-cell-dash">&mdash;</span>')+'</td>'+
      '<td class="std-cell-right balance-col '+(bal>0?'balance-owed':'balance-clear')+'">'+fmt(bal)+'</td>'+
      '<td style="font-size:12px;">'+methodLabel(r.method)+'</td>'+
      '<td>'+statusPill(r.status)+'</td>'+
      '<td>'+(!isVoid && r.type==='payment'?'<button class="btn btn-danger btn-sm" onclick="openReversal(\''+r.id+'\',\'rent\')">Rev.</button>':'')+'</td></tr>';
  }).join('');

  if (bodyEl) {
    bodyEl.innerHTML = html || '<tr class="empty-row"><td colspan="8">No entries match the current filters. <a href="#" onclick="clearRentFilters();return false;" style="color:var(--text);text-decoration:underline;">Clear filters</a> to show all.</td></tr>';
  }
  if (countEl) countEl.textContent = rows.length + ' shown · ' + allRows.length + ' total';
  if (metaEl) {
    var today = new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'});
    metaEl.textContent = tenantName(t) + ' · ' + (t.unit||'no unit') + ' · Last updated ' + today;
  }
  document.getElementById('rentStats').innerHTML=statCard('Monthly Rent',fmt(t.rent),'','')+statCard('Total Charged',fmt(totalCharged),'','')+statCard('Balance Owing',fmt(balance),'',balance>0?'danger':'success');
  var _rentThead = document.getElementById('fin_rent_thead');
  if (_rentThead && typeof tableBindColumnMenuClicks==='function') tableBindColumnMenuClicks(_rentThead, 'fin-rent');
  if (_rentThead && typeof tableRefreshSortIndicators==='function') tableRefreshSortIndicators(_rentThead, 'fin-rent');
}

// ARRANGEMENTS
function calcArrangement(){
  var total      = parseFloat((document.getElementById('na-total')||{}).value)||0;
  var payment    = parseFloat((document.getElementById('na-monthly')||{}).value)||0;
  var freq       = (document.getElementById('na-freq')||{}).value||'monthly';
  var startDate  = (document.getElementById('na-start')||{}).value||today();
  var firstPay   = (document.getElementById('na-first-payment')||{}).value||startDate;
  var el         = document.getElementById('arrCalcResult');
  var payoffInput= document.getElementById('na-payoff-display');
  var payLbl     = document.getElementById('na-payment-label');

  // Update payment label to match frequency
  var freqLabels = {monthly:'Monthly', semimonthly:'Semi-Monthly', biweekly:'Bi-Weekly', weekly:'Weekly'};
  if (payLbl) payLbl.textContent = (freqLabels[freq]||'') + ' Payment ($) *';

  // Periods per year for each frequency
  var ppy = {monthly:12, semimonthly:24, biweekly:26, weekly:52}[freq]||12;

  if (!total||!payment) {
    if (el) el.style.display='none';
    if (payoffInput) payoffInput.value='';
    return;
  }

  el.style.display='block';

  // Total periods needed
  var periods = Math.ceil(total / payment);
  // Convert periods to months for payoff date calc
  var months  = Math.ceil(periods / ppy * 12);

  // Payoff date from first payment date
  var baseDate = firstPay || startDate;
  var baseParts= baseDate.split('-');
  var payoff   = new Date(+baseParts[0], +baseParts[1]-1, +baseParts[2]);
  payoff.setMonth(payoff.getMonth() + months);
  var payoffStr = payoff.toLocaleDateString('en-CA',{year:'numeric',month:'long'});

  var yrs = Math.floor(months/12), mos = months%12;
  var termStr = (yrs>0?yrs+(yrs===1?' year':' years')+(mos>0?' and ':''):'')+(mos>0?mos+(mos===1?' month':' months'):'');
  var freqLbl = {monthly:'per month', semimonthly:'semi-monthly', biweekly:'bi-weekly', weekly:'per week'}[freq]||'per period';

  if (payoffInput) payoffInput.value = payoffStr;
  document.getElementById('arr-monthly-display').textContent = fmt(payment);
  document.getElementById('arr-months').textContent = termStr;
  document.getElementById('arr-months-sub').textContent = periods + ' payments ' + freqLbl;
  document.getElementById('arr-payoff').textContent = payoffStr;
}

function clearArrangementsFilters(){
  ['afilt_status','afilt_ledger','afilt_freq','afilt_amt_min','afilt_amt_max'].forEach(function(id){
    var el = document.getElementById(id); if(el) el.value = '';
  });
  renderArrangementsPage();
}

function renderArrangementsPage(){
  var d = getData();
  var filterTid = (document.getElementById('arrTenantSelect')||{}).value || 'all';
  var all = d.arrangements || [];

  // Apply tenant filter (via picker)
  var list = filterTid === 'all' ? all : all.filter(function(a){ return a.tenantId === filterTid; });

  // Apply other filters
  var fStatus = (document.getElementById('afilt_status')||{}).value || '';
  var fLedger = (document.getElementById('afilt_ledger')||{}).value || '';
  var fFreq   = (document.getElementById('afilt_freq')  ||{}).value || '';
  var fMin    = parseFloat((document.getElementById('afilt_amt_min')||{}).value);
  var fMax    = parseFloat((document.getElementById('afilt_amt_max')||{}).value);
  list = list.filter(function(a){
    if (fStatus) {
      if (fStatus === 'active' && !(a.status === 'approved' || a.status === 'active')) return false;
      if (fStatus !== 'active' && a.status !== fStatus) return false;
    }
    if (fLedger && (a.ledger||'').toLowerCase() !== fLedger) return false;
    if (fFreq   && (a.frequency || 'monthly') !== fFreq) return false;
    var amt = parseFloat(a.totalOwing) || 0;
    if (!isNaN(fMin) && amt < fMin) return false;
    if (!isNaN(fMax) && amt > fMax) return false;
    return true;
  });

  // Page meta
  var metaEl = document.getElementById('arr_page_meta');
  if (metaEl) {
    var today = new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'});
    metaEl.textContent = list.length + ' shown · ' + all.length + ' total · Last updated ' + today;
  }

  var content = document.getElementById('arrangementsContent');
  if (!content) return;

  // Build summary table
  function pillFor(status){
    if (status === 'approved' || status === 'active') return '<span class="std-pill std-pill-active">'+(status==='approved'?'Approved':'Active')+'</span>';
    if (status === 'pending-ed') return '<span class="std-pill std-pill-pending">Pending ED</span>';
    if (status === 'completed')  return '<span class="std-pill std-pill-paid">Completed</span>';
    if (status === 'defaulted')  return '<span class="std-pill std-pill-overdue">Defaulted</span>';
    if (status === 'cancelled' || status === 'voided') return '<span class="std-pill std-pill-voided">'+status.charAt(0).toUpperCase()+status.slice(1)+'</span>';
    return '<span class="std-pill std-pill-info">'+(status||'—')+'</span>';
  }

  // Phase 2B: column-menu sort/filter
  var _arrCols = {
    tenant:     { label: 'Tenant',      accessor: function(a){ var t=getTenant(a.tenantId); return t?tenantName(t):''; } },
    ledger:     { label: 'Ledger',      accessor: function(a){ return (a.ledger||'').toLowerCase(); } },
    totalOwing: { label: 'Total Owing', accessor: function(a){ return parseFloat(a.totalOwing)||0; } },
    remaining:  { label: 'Remaining',   accessor: function(a){
      var pmts=d.arrPayments.filter(function(p){return p.arrId===a.id;});
      var paid=pmts.reduce(function(s,p){return s+p.amount;},0);
      return Math.max(0,(parseFloat(a.totalOwing)||0)-paid);
    }},
    status:     { label: 'Status',      accessor: function(a){ return a.status||''; } }
  };
  var _arrAcc = {}; Object.keys(_arrCols).forEach(function(k){ _arrAcc[k] = _arrCols[k].accessor; });
  var _arrSt = (typeof tableStateGet==='function') ? tableStateGet('fin-arr') : {sort:{key:'',dir:1},filters:{}};
  if (typeof tableRegisterColumns==='function') tableRegisterColumns('fin-arr', {columns:_arrCols, getRows:function(){return list;}, onChange:renderArrangementsPage});
  list = (typeof tableApplyFilterSort==='function') ? tableApplyFilterSort(list, _arrAcc, _arrSt) : list;

  var rows;
  if (all.length === 0) {
    rows = '<tr class="empty-row"><td colspan="7">' +
      '<div style="font-size:24px;margin-bottom:8px;">&#128203;</div>' +
      '<div>No payment arrangements yet. Use the <strong>📋 New Arrangement</strong> button above to create the first one.</div>' +
      '</td></tr>';
  } else if (!list.length) {
    rows = '<tr class="empty-row"><td colspan="7">No arrangements match the current filters. <a href="#" onclick="clearArrangementsFilters();return false;" style="color:var(--text);text-decoration:underline;">Clear filters</a> to show all.</td></tr>';
  } else {
    rows = list.map(function(arr){
      var t = getTenant(arr.tenantId);
      var payments = d.arrPayments.filter(function(p){ return p.arrId === arr.id; });
      var totalPaid = payments.reduce(function(s,p){ return s + p.amount; }, 0);
      var remaining = Math.max(0, arr.totalOwing - totalPaid);
      var pct = arr.totalOwing > 0 ? Math.min(100, (totalPaid/arr.totalOwing)*100) : 0;
      var safeId = (arr.id||'').replace(/'/g, "\\'");
      var progress = '<div style="display:flex;align-items:center;gap:8px;min-width:120px;">'+
        '<div style="flex:1;height:6px;background:var(--border);border-radius:4px;overflow:hidden;"><div style="width:'+pct.toFixed(0)+'%;height:100%;background:var(--yellow);"></div></div>'+
        '<span style="font-size:11px;color:var(--muted);white-space:nowrap;">'+pct.toFixed(0)+'%</span>'+
        '</div>';
      return '<tr class="clickable" onclick="showArrangementDetail(\''+safeId+'\')">'+
        '<td class="std-cell-primary">'+(t?tenantNameHtml(t):'<span class="std-cell-dash">—</span>')+'</td>'+
        '<td style="text-transform:capitalize;">'+(arr.ledger||'<span class="std-cell-dash">—</span>')+'</td>'+
        '<td class="std-cell-right">'+fmt(arr.totalOwing)+'</td>'+
        '<td class="std-cell-right">'+fmt(remaining)+'</td>'+
        '<td>'+progress+'</td>'+
        '<td>'+pillFor(arr.status)+'</td>'+
        '<td class="std-cell-tail">Click to open &rsaquo;</td>'+
      '</tr>';
    }).join('');
  }

  var summary =
    '<div class="std-table-card">'+
      '<div class="std-table-hdr">'+
        '<span>Payment Arrangements</span>'+
        '<span class="std-table-count">'+list.length+' shown · '+all.length+' total</span>'+
      '</div>'+
      '<table class="std-table">'+
        '<thead id="fin_arr_thead"><tr>'+
          '<th class="std-th-sortable" data-sort-key="tenant">Tenant</th>'+
          '<th class="std-th-sortable" data-sort-key="ledger">Ledger</th>'+
          '<th class="std-cell-right std-th-sortable" data-sort-key="totalOwing">Total Owing</th>'+
          '<th class="std-cell-right std-th-sortable" data-sort-key="remaining">Remaining</th>'+
          '<th>Progress</th>'+
          '<th class="std-th-sortable" data-sort-key="status">Status</th>'+
          '<th></th>'+
        '</tr></thead>'+
        '<tbody>'+rows+'</tbody>'+
      '</table>'+
    '</div>';

  // Expanded detail (only if a single-tenant filter is picked) — keep the rich old view below
  var detail = '';
  if (filterTid !== 'all' && list.length) {
    detail = list.map(function(arr){
      var t = getTenant(arr.tenantId);
      var payments = d.arrPayments.filter(function(p){ return p.arrId === arr.id; });
      var totalPaid = payments.reduce(function(s,p){ return s + p.amount; }, 0);
      var remaining = Math.max(0, arr.totalOwing - totalPaid);
      var pct = arr.totalOwing > 0 ? Math.min(100, (totalPaid/arr.totalOwing)*100) : 0;
      var monthsLeft = arr.monthlyPayment > 0 ? Math.ceil(remaining/arr.monthlyPayment) : 0;
      var payoff = new Date(); payoff.setMonth(payoff.getMonth()+monthsLeft);
      var payoffStr = remaining <= 0 ? 'Paid Off' : payoff.toLocaleDateString('en-CA',{year:'numeric',month:'long'});
      var payRows = payments.map(function(p){
        return '<tr><td>'+p.date+'</td><td><span class="amt-credit">'+fmt(p.amount)+'</span></td>'+
          '<td>'+methodLabel(p.method)+'</td>'+
          '<td><span class="pill '+(p.type==='extra'?'pill-purple':'pill-blue')+'">'+p.type+'</span></td>'+
          '<td style="font-size:12px;color:var(--muted);">'+p.ref+'</td>'+
          '<td style="font-size:12px;">'+p.notes+'</td></tr>';
      }).join('');
      return '<div class="card" style="margin-bottom:16px;margin-top:16px;">'+
        '<div class="ctitle" style="justify-content:space-between;">'+
          'Payment Arrangement &mdash; '+(t?tenantNameHtml(t):'')+'&nbsp;'+statusPill(arr.status)+
          (arr.status==='approved'?'<button class="btn btn-primary btn-sm" onclick="openArrPayment(\''+arr.id+'\')">+ Record Payment</button>':'')+'</div>'+
        '<div class="stats-grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:16px;">'+
          statCard('Total Owing',fmt(arr.totalOwing),'At arrangement date','')+
          statCard('Paid to Date',fmt(totalPaid),'','success')+
          statCard('Remaining',fmt(remaining),'',remaining>0?'danger':'success')+
          statCard('Projected Payoff',payoffStr,monthsLeft>0?monthsLeft+' months left':'','')+'</div>'+
        '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;font-size:12px;margin-bottom:14px;padding:12px;background:var(--bg);border-radius:8px;">'+
          '<div><span style="color:var(--muted);display:block;font-size:11px;">Ledger</span><strong style="text-transform:capitalize;">'+arr.ledger+'</strong></div>'+
          '<div><span style="color:var(--muted);display:block;font-size:11px;">Monthly Payment</span><strong>'+fmt(arr.monthlyPayment)+'</strong></div>'+
          '<div><span style="color:var(--muted);display:block;font-size:11px;">Start Date</span><strong>'+arr.startDate+'</strong></div>'+
          '<div><span style="color:var(--muted);display:block;font-size:11px;">Reference #</span><strong>'+arr.ref+'</strong></div>'+
        '</div>'+
        '<div style="height:8px;background:var(--border);border-radius:6px;margin-bottom:6px;overflow:hidden;"><div style="width:'+pct.toFixed(1)+'%;height:100%;background:var(--yellow);border-radius:6px;transition:width .5s;"></div></div>'+
        '<div style="font-size:11px;color:var(--muted);margin-bottom:16px;">'+pct.toFixed(1)+'% repaid &mdash; '+fmt(totalPaid)+' of '+fmt(arr.totalOwing)+'</div>'+
        (arr.notes?'<div class="ibox yellow" style="margin-bottom:14px;">'+arr.notes+'</div>':'')+
        (payRows?'<div class="ctitle">Payment History</div><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Date</th><th>Amount</th><th>Method</th><th>Type</th><th>Ref #</th><th>Notes</th></tr></thead><tbody>'+payRows+'</tbody></table></div>':'<p style="color:var(--muted);font-size:13px;">No payments recorded yet.</p>')+
      '</div>';
    }).join('');
  }

  content.innerHTML = summary + detail;
  var _arrThead = document.getElementById('fin_arr_thead');
  if (_arrThead && typeof tableBindColumnMenuClicks==='function') tableBindColumnMenuClicks(_arrThead, 'fin-arr');
  if (_arrThead && typeof tableRefreshSortIndicators==='function') tableRefreshSortIndicators(_arrThead, 'fin-arr');
}

// Helper: from the arrangements summary table, clicking a row sets the tenant
// picker to just that tenant so the detail card renders below.
function showArrangementDetail(arrId){
  var d = getData();
  var arr = d.arrangements.find(function(a){ return a.id === arrId; });
  if (!arr) return;
  tenantPickerSelect('arr', arr.tenantId);
}

function openArrPayment(arrId){
  currentArrId=arrId;
  var d=getData();
  var arr=d.arrangements.find(function(a){return a.id===arrId;});
  var t=arr?getTenant(arr.tenantId):null;
  var paid=d.arrPayments.filter(function(p){return p.arrId===arrId;}).reduce(function(s,p){return s+p.amount;},0);
  var remaining=arr?Math.max(0,arr.totalOwing-paid):0;
  document.getElementById('arrPaymentInfo').innerHTML='<strong>'+(t?tenantNameHtml(t):'')+'</strong> &mdash; '+escapeHtml(arr.ref||'')+'<br>Remaining balance: <strong>'+fmt(remaining)+'</strong> &mdash; Monthly amount: <strong>'+fmt(arr.monthlyPayment)+'</strong>';
  document.getElementById('ap-date').value=today();
  document.getElementById('ap-amount').value=arr.monthlyPayment.toFixed(2);
  document.getElementById('ap-ref').value='';
  document.getElementById('ap-notes').value='';
  if(t&&t.autoPay)document.getElementById('ap-method').value='auto';
  openModal('modalArrPayment');
}

// LOANS
var _currentLoanId = null;

function clearLoansFilters(){
  ['lfilt_status','lfilt_purpose','lfilt_amt_min','lfilt_amt_max'].forEach(function(id){
    var el = document.getElementById(id); if(el) el.value = '';
  });
  renderLoansPage();
}

function renderLoansPage(){
  var d = getData();
  var tid = (document.getElementById('loanTenantSelect')||{}).value || 'all';
  var content = document.getElementById('loansContent');
  var switcher = document.getElementById('loanSwitcher');
  if (!content) return;

  var all = d.loanList || [];

  // Apply filters
  var fStatus  = (document.getElementById('lfilt_status') ||{}).value || '';
  var fPurpose = (document.getElementById('lfilt_purpose')||{}).value || '';
  var fMin     = parseFloat((document.getElementById('lfilt_amt_min')||{}).value);
  var fMax     = parseFloat((document.getElementById('lfilt_amt_max')||{}).value);

  function passFilter(l){
    if (fStatus && l.status !== fStatus) return false;
    if (fPurpose && (l.type||'') !== fPurpose) return false;
    var p = parseFloat(l.principal) || 0;
    if (!isNaN(fMin) && p < fMin) return false;
    if (!isNaN(fMax) && p > fMax) return false;
    return true;
  }

  // Meta
  var metaEl = document.getElementById('loan_page_meta');
  if (metaEl) {
    var today = new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'});
    var scope = tid === 'all' ? 'All tenants' : (function(){ var tt=getTenant(tid); return tt?tenantName(tt):'—'; })();
    metaEl.textContent = scope + ' · ' + all.length + ' loans total · Last updated ' + today;
  }

  // ALL-TENANTS MODE — summary table
  if (tid === 'all' || !tid) {
    switcher.style.display = 'none';

    var list = all.filter(passFilter);
    var typeLabels = {'renovation':'Renovation','rent-to-own':'Rent-to-Own','utilities':'Utilities','emergency':'Emergency','other':'Other'};

    function pillFor(status){
      if (status === 'approved') return '<span class="std-pill std-pill-approved">Approved</span>';
      if (status === 'pending-ed') return '<span class="std-pill std-pill-pending">Pending ED</span>';
      if (status === 'pending') return '<span class="std-pill std-pill-pending">Pending</span>';
      if (status === 'declined') return '<span class="std-pill std-pill-overdue">Declined</span>';
      if (status === 'completed' || status === 'paid_off') return '<span class="std-pill std-pill-paid">Paid Off</span>';
      return '<span class="std-pill std-pill-info">'+(status||'—')+'</span>';
    }

    // Phase 2B: column-menu sort/filter
    var _lCols = {
      tenant:    { label: 'Tenant',    accessor: function(l){ var t=getTenant(l.tenantId); return t?tenantName(t):''; } },
      purpose:   { label: 'Purpose',   accessor: function(l){ return l.type||''; } },
      principal: { label: 'Principal', accessor: function(l){ return parseFloat(l.principal)||0; } },
      remaining: { label: 'Remaining', accessor: function(l){
        var paid=d.loanPayments.filter(function(p){return p.loanId===l.id&&!finIsVoided(p);}).reduce(function(s,p){return s+p.amount;},0);
        return Math.max(0,(parseFloat(l.principal)||0)-paid);
      }},
      status:    { label: 'Status',    accessor: function(l){ return l.status||''; } }
    };
    var _lAcc = {}; Object.keys(_lCols).forEach(function(k){ _lAcc[k] = _lCols[k].accessor; });
    var _lSt = (typeof tableStateGet==='function') ? tableStateGet('fin-loans') : {sort:{key:'',dir:1},filters:{}};
    if (typeof tableRegisterColumns==='function') tableRegisterColumns('fin-loans', {columns:_lCols, getRows:function(){return list;}, onChange:renderLoansPage});
    list = (typeof tableApplyFilterSort==='function') ? tableApplyFilterSort(list, _lAcc, _lSt) : list;

    var rows;
    if (all.length === 0) {
      rows = '<tr class="empty-row"><td colspan="7">' +
        '<div style="font-size:24px;margin-bottom:8px;">&#128188;</div>' +
        '<div>No loans yet. Use the <strong>+ New Loan</strong> button above to create the first one.</div>' +
        '</td></tr>';
    } else if (!list.length) {
      rows = '<tr class="empty-row"><td colspan="7">No loans match the current filters. <a href="#" onclick="clearLoansFilters();return false;" style="color:var(--text);text-decoration:underline;">Clear filters</a> to show all.</td></tr>';
    } else {
      rows = list.map(function(l){
        var t = getTenant(l.tenantId);
        var paid = d.loanPayments.filter(function(p){ return p.loanId === l.id && !finIsVoided(p); }).reduce(function(s,p){ return s+p.amount; }, 0);
        var remaining = Math.max(0, l.principal - paid);
        var pct = l.principal > 0 ? Math.min(100, (paid/l.principal)*100) : 0;
        var safeId = (l.tenantId||'').replace(/'/g, "\\'");
        var progress = '<div style="display:flex;align-items:center;gap:8px;min-width:120px;">'+
          '<div style="flex:1;height:6px;background:var(--border);border-radius:4px;overflow:hidden;"><div style="width:'+pct.toFixed(0)+'%;height:100%;background:var(--yellow);"></div></div>'+
          '<span style="font-size:11px;color:var(--muted);white-space:nowrap;">'+pct.toFixed(0)+'%</span>'+
          '</div>';
        return '<tr class="clickable" onclick="tenantPickerSelect(\'loan\',\''+safeId+'\')">'+
          '<td class="std-cell-primary">'+(t?tenantNameHtml(t):'<span class="std-cell-dash">—</span>')+'</td>'+
          '<td>'+(typeLabels[l.type]||l.type||'<span class="std-cell-dash">—</span>')+'</td>'+
          '<td class="std-cell-right">'+fmt(l.principal)+'</td>'+
          '<td class="std-cell-right">'+fmt(remaining)+'</td>'+
          '<td>'+progress+'</td>'+
          '<td>'+pillFor(l.status)+'</td>'+
          '<td class="std-cell-tail">Click to open &rsaquo;</td>'+
        '</tr>';
      }).join('');
    }

    content.innerHTML =
      '<div class="std-table-card">'+
        '<div class="std-table-hdr">'+
          '<span>All Loans</span>'+
          '<span class="std-table-count">'+list.length+' shown · '+all.length+' total</span>'+
        '</div>'+
        '<table class="std-table">'+
          '<thead id="fin_loans_thead"><tr>'+
            '<th class="std-th-sortable" data-sort-key="tenant">Tenant</th>'+
            '<th class="std-th-sortable" data-sort-key="purpose">Purpose</th>'+
            '<th class="std-cell-right std-th-sortable" data-sort-key="principal">Principal</th>'+
            '<th class="std-cell-right std-th-sortable" data-sort-key="remaining">Remaining</th>'+
            '<th>Progress</th>'+
            '<th class="std-th-sortable" data-sort-key="status">Status</th>'+
            '<th></th>'+
          '</tr></thead>'+
          '<tbody>'+rows+'</tbody>'+
        '</table>'+
      '</div>';
    var _lThead = document.getElementById('fin_loans_thead');
    if (_lThead && typeof tableBindColumnMenuClicks==='function') tableBindColumnMenuClicks(_lThead, 'fin-loans');
    if (_lThead && typeof tableRefreshSortIndicators==='function') tableRefreshSortIndicators(_lThead, 'fin-loans');
    return;
  }

  // SINGLE-TENANT MODE — detail view
  var t = getTenant(tid);
  if (!t) {
    content.innerHTML = '<div class="std-table-card" style="text-align:center;padding:30px;color:var(--muted);">Select a tenant above.</div>';
    switcher.style.display = 'none';
    return;
  }
  document.getElementById('loanTenantBadge').innerHTML = typePill(t.type)+(t.autoPay?' <span class="pill pill-green">Auto-Pay</span>':'');

  var loans = all.filter(function(l){ return l.tenantId === tid && passFilter(l); });
  if (loans.length === 0){
    switcher.style.display='none';
    var countAll = all.filter(function(l){return l.tenantId === tid;}).length;
    if (countAll === 0) {
      content.innerHTML = '<div class="std-table-card" style="text-align:center;padding:40px 30px;color:var(--muted);">' +
        '<div style="font-size:28px;margin-bottom:10px;">&#128188;</div>' +
        '<div style="font-size:13px;">No loans on file for '+tenantNameHtml(t)+'. Use the <strong>+ New Loan</strong> button above to create one.</div>' +
        '</div>';
    } else {
      content.innerHTML = '<div class="std-table-card" style="text-align:center;padding:30px;color:var(--muted);">No loans match the current filters. <a href="#" onclick="clearLoansFilters();return false;" style="color:var(--text);text-decoration:underline;">Clear filters</a> to show all.</div>';
    }
    return;
  }

  // Loan switcher — show tabs if more than 1 loan
  if (loans.length > 1){
    switcher.style.display = 'block';
    if (!_currentLoanId || !loans.find(function(l){ return l.id === _currentLoanId; })) {
      _currentLoanId = loans[0].id;
    }
    var typeLabels2 = {'renovation':'Renovation','rent-to-own':'Rent-to-Own','utilities':'Utilities','other':'Loan'};
    switcher.innerHTML = '<div class="tabs">'+
      loans.map(function(l){
        var active = l.id === _currentLoanId ? ' active' : '';
        return '<button class="tab-btn'+active+'" onclick="switchLoan(\''+l.id+'\')">'+
          (typeLabels2[l.type]||'Loan')+' &mdash; '+fmt(l.principal)+' '+statusPill(l.status)+
        '</button>';
      }).join('')+
    '</div>';
  } else {
    switcher.style.display = 'none';
    _currentLoanId = loans[0].id;
  }

  var ln = loans.find(function(l){ return l.id === _currentLoanId; }) || loans[0];
  renderLoanDetail(ln, d, t);
}

function switchLoan(loanId){
  _currentLoanId = loanId;
  renderLoansPage();
}

function renderLoanDetail(ln, d, t){
  var content = document.getElementById('loansContent');
  var payments = d.loanPayments.filter(function(p){return p.loanId===ln.id && !finIsVoided(p);});
  var allPayments = d.loanPayments.filter(function(p){return p.loanId===ln.id;});
  var totalPaid = payments.reduce(function(s,p){return s+p.amount;},0);
  var remaining = Math.max(0, ln.principal-totalPaid);
  var pct = ln.principal>0 ? Math.min(100,(totalPaid/ln.principal)*100) : 0;
  var typeLabels = {'renovation':'Renovation Loan','rent-to-own':'Rent-to-Own Loan','utilities':'Utilities Loan','other':'Loan'};
  var typeLabel = typeLabels[ln.type]||'Loan';
  var isDraft    = ln.status === APP_STATUS.DRAFT;
  var isPendingED= ln.status === 'pending-ed';
  var isDeclined = ln.status === 'declined';
  var isPending  = isDraft || isPendingED || isDeclined;
  var nextPayDate = ln.nextPayDate || ln.start || today();

  var payRows = allPayments.map(function(p){
    var isReversed = finIsVoided(p);
    return '<tr style="'+(isReversed?'opacity:.5;':'')+'">' +
      '<td>'+(isReversed?'<s>':'')+p.date+(isReversed?'</s>':'')+'</td>'+
      '<td><span class="'+(isReversed?'':'amt-credit')+'">'+fmt(p.amount)+'</span></td>'+
      '<td>'+methodLabel(p.method)+'</td>'+
      '<td style="color:var(--muted);font-size:12px;">'+(p.notes||'\u2014')+'</td>'+
      '<td>'+(isReversed
        ? '<span class="pill pill-gray" style="font-size:10px;">Reversed</span>'
        : '<button class="btn btn-ghost btn-sm" style="font-size:11px;color:var(--danger);" onclick="reverseLoanPayment(\''+p.id+'\',\''+ln.id+'\')">&#8635; Reverse</button>')+
      '</td>'+
    '</tr>';
  }).join('');


  // Compute approval banner before innerHTML
  var _stageBanner = isDraft
    ? '<div class="ibox yellow" style="margin-bottom:14px;"><div style="font-weight:700;margin-bottom:6px;">&#128338; Stage 1 \u2014 Pending HM Review</div><div style="font-size:12px;margin-bottom:8px;">Submitted by ' + (ln.submittedBy||'Staff') + '. Housing Manager must verify and recommend to ED.</div><div style="display:flex;gap:8px;flex-wrap:wrap;"><button class="btn btn-primary btn-sm" onclick="hmRecommendLoan(\'' + ln.id + '\')">&#10003; Recommend to ED</button><button class="btn btn-ghost btn-sm" style="color:var(--danger);border-color:var(--danger);" onclick="hmDeclineLoan(\'' + ln.id + '\')">&#10007; Decline</button></div></div>'
    : isPendingED
    ? '<div class="ibox yellow" style="margin-bottom:14px;"><div style="font-weight:700;margin-bottom:6px;">&#128338; Stage 2 \u2014 Pending ED Approval</div>' + (ln.hmNotes ? '<div style="font-size:12px;background:rgba(255,255,255,.5);padding:6px 10px;border-radius:6px;margin-bottom:8px;"><strong>HM:</strong> ' + ln.hmNotes + '</div>' : '') + '<div style="display:flex;gap:8px;flex-wrap:wrap;"><button class="btn btn-primary btn-sm" onclick="approveLoan(\'' + ln.id + '\')">&#10003; Approve</button><button class="btn btn-ghost btn-sm" style="color:var(--danger);" onclick="hmDeclineLoan(\'' + ln.id + '\')">&#10007; Decline</button><button class="btn btn-ghost btn-sm" onclick="previewLoanById(\'' + ln.id + '\')">&#128196; Agreement</button></div></div>'
    : isDeclined
    ? '<div style="background:#fef2f2;border:1.5px solid var(--danger);border-radius:10px;padding:14px;margin-bottom:14px;"><strong style="color:var(--danger);">&#10007; Declined</strong><div style="font-size:12px;">' + (ln.declineReason||'') + '</div></div>'
    : '';


  content.innerHTML =
    // Approval stage banner
    _stageBanner+

    // Loan detail card
    '<div class="card" style="margin-bottom:16px;'+(isPending?'border-left:4px solid var(--warn-amber-text);':'')+'">'+
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px;margin-bottom:16px;">'+
        '<div>'+
          '<div style="font-family:\'DM Serif Display\',serif;font-size:20px;">'+typeLabel+'</div>'+
          '<div style="font-size:12px;color:var(--muted);">Started '+ln.start+' &middot; '+ln.term+' month term &middot; '+statusPill(ln.status)+'</div>'+
        '</div>'+
        (!isPending ? '<button class="btn btn-ghost btn-sm" onclick="editLoanNextPayDate(\''+ln.id+'\')">&#128197; Set Next Payment Date</button>' : '')+
      '</div>'+

      // HM verification note -- a permanent home for it. Previously ln.hmNotes
      // showed ONLY in the transient "Pending ED" banner and vanished once the
      // loan was approved; now it stays visible on the loan card. Skipped while
      // pending-ED (the banner above already shows it). (Notes UX audit - Batch 2)
      ((ln.hmNotes && String(ln.hmNotes).trim() && !isPendingED) ? '<div class="ibox" style="margin-bottom:14px;font-size:12px;"><strong>HM note:</strong> ' + escapeHtml(ln.hmNotes) + '</div>' : '')+

      // Next payment date banner (approved loans only)
      (!isPending ? '<div style="background:var(--dark2);border-radius:8px;padding:10px 16px;margin-bottom:14px;display:flex;align-items:center;justify-content:space-between;">'+
        '<div style="font-size:12px;color:var(--gray);">Next Payment Due</div>'+
        '<div style="font-family:\'DM Serif Display\',serif;font-size:16px;color:var(--yellow);" id="ln-next-pay-display">'+nextPayDate+'</div>'+
      '</div>' : '')+

      // Stats
      '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px;">'+
        '<div style="background:var(--bg);border-radius:8px;padding:10px 12px;text-align:center;"><div style="font-size:10px;color:var(--muted);text-transform:uppercase;margin-bottom:3px;">Principal</div><div style="font-family:\'DM Serif Display\',serif;font-size:17px;">'+fmt(ln.principal)+'</div></div>'+
        '<div style="background:#f0fdf4;border-radius:8px;padding:10px 12px;text-align:center;"><div style="font-size:10px;color:var(--muted);text-transform:uppercase;margin-bottom:3px;">Paid</div><div style="font-family:\'DM Serif Display\',serif;font-size:17px;color:var(--success);">'+fmt(totalPaid)+'</div></div>'+
        '<div style="background:'+(remaining>0?'#fef2f2':'#f0fdf4')+';border-radius:8px;padding:10px 12px;text-align:center;"><div style="font-size:10px;color:var(--muted);text-transform:uppercase;margin-bottom:3px;">Remaining</div><div style="font-family:\'DM Serif Display\',serif;font-size:17px;color:'+(remaining>0?'var(--danger)':'var(--success)')+';">'+fmt(remaining)+'</div></div>'+
        '<div style="background:var(--bg);border-radius:8px;padding:10px 12px;text-align:center;"><div style="font-size:10px;color:var(--muted);text-transform:uppercase;margin-bottom:3px;">Monthly</div><div style="font-size:14px;font-weight:600;margin-top:4px;">'+fmt(ln.payment)+'</div></div>'+
      '</div>'+

      // Progress
      '<div style="height:8px;background:var(--border);border-radius:6px;margin-bottom:6px;overflow:hidden;"><div style="width:'+pct.toFixed(1)+'%;height:100%;background:var(--yellow);border-radius:6px;"></div></div>'+
      '<div style="font-size:11px;color:var(--muted);margin-bottom:14px;">'+pct.toFixed(1)+'% repaid &mdash; '+fmt(totalPaid)+' of '+fmt(ln.principal)+'</div>'+

      // Loan terms
      '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;font-size:12px;padding:12px 14px;background:var(--bg);border-radius:8px;">'+
        '<div><div style="color:var(--muted);margin-bottom:2px;">Interest</div><strong>'+(ln.rateType==='none'?'Interest-Free':ln.rate+'% '+ln.rateType)+'</strong></div>'+
        '<div><div style="color:var(--muted);margin-bottom:2px;">Total Interest</div><strong>'+fmt(ln.totalInterest||0)+'</strong></div>'+
        '<div><div style="color:var(--muted);margin-bottom:2px;">Total Repayment</div><strong>'+fmt(ln.totalRepay||ln.principal)+'</strong></div>'+
        '<div><div style="color:var(--muted);margin-bottom:2px;">Frequency</div><strong style="text-transform:capitalize;">'+ln.freq+'</strong></div>'+
      '</div>'+
    '</div>'+

    // Inline payment entry (approved only)
    (!isPending ?
      '<div class="card" style="margin-bottom:16px;">'+
        '<div class="ctitle">Record Payment</div>'+
        '<div style="display:grid;grid-template-columns:1fr 1fr 1fr auto;gap:10px;align-items:flex-end;">'+
          '<div class="f" style="margin:0;"><label>Date</label><input id="lpay-inline-date" type="date" value="'+today()+'"/></div>'+
          '<div class="f" style="margin:0;"><label>Amount ($)</label><input id="lpay-inline-amount" type="number" step="0.01" placeholder="'+ln.payment.toFixed(2)+'" value="'+ln.payment.toFixed(2)+'"/></div>'+
          '<div class="f" style="margin:0;"><label>Method</label>'+
            '<select id="lpay-inline-method">'+
              '<option value="cash">Cash</option>'+
              '<option value="debit">Debit (In-Person)</option>'+
              '<option value="etransfer">E-Transfer</option>'+
              '<option value="online">Online Banking</option>'+
              '<option value="cheque">Cheque</option>'+
              '<option value="auto">Auto Payment</option>'+
            '</select>'+
          '</div>'+
          '<button class="btn btn-primary" style="height:40px;" onclick="saveInlineLoanPayment(\''+ln.id+'\',\''+ln.tenantId+'\',\''+ln.type+'\')">Record</button>'+
        '</div>'+
        '<div class="f" style="margin-top:10px;"><label>Notes (optional)</label><input id="lpay-inline-notes" placeholder="e.g. cheque #1234, arrangement ref..."/></div>'+
      '</div>'
    : '')+

    // Payment history
    '<div class="card">'+
      '<div class="ctitle">Payment History</div>'+
      (allPayments.length
        ? '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Date</th><th>Amount</th><th>Method</th><th>Notes</th><th></th></tr></thead><tbody>'+payRows+'</tbody></table></div>'
        : '<p style="color:var(--muted);font-size:13px;padding:8px 0;">No payments recorded yet.</p>')+
    '</div>';
}

function saveInlineLoanPayment(loanId, tenantId, loanType){
  var date   = document.getElementById('lpay-inline-date').value;
  var amt    = parseFloat(document.getElementById('lpay-inline-amount').value);
  var method = document.getElementById('lpay-inline-method').value;
  var notes  = document.getElementById('lpay-inline-notes').value;
  if(!amt||!date){toast('Amount and date are required.');return;}

  var doSave = function(cashDenoms, receivedBy){
    var d = getData();
    var entry = {id:uid(),loanId:loanId,tenantId:tenantId,date:date,amount:amt,method:method,notes:notes,status:'posted'};
    if(cashDenoms){entry.denominations=cashDenoms;entry.receivedBy=receivedBy;}
    d.loanPayments.push(entry);
    auditLog('create','loanPayment',entry.id,
      'Loan payment: '+(getTenant(tenantId)?tenantName(getTenant(tenantId)):tenantId)+' \u2014 '+loanType+' '+fmt(amt)+' via '+methodLabel(method), null, entry);
    saveData(d);
    renderLoansPage();
    renderDashboard();
    generateVoucherFor({date:date,tenantId:tenantId,ledger:'loans',
      desc:'Loan Payment \u2014 '+loanType,charge:0,payment:amt,method:method,status:'posted',id:entry.id,denominations:cashDenoms||null});
  };
  if(method==='cash') openCashDenom(amt, doSave); else doSave(null,null);
}

function editLoanNextPayDate(loanId){
  var d = getData();
  var ln = d.loanList.find(function(l){return l.id===loanId;});
  if(!ln) return;
  var current = ln.nextPayDate || ln.start || today();
  var newDate = prompt('Set next payment date for this loan:\n(Current: '+current+')', current);
  if(!newDate) return;
  var before = {nextPayDate: ln.nextPayDate};
  ln.nextPayDate = newDate;
  auditLog('update','loan',loanId,'Next payment date set to '+newDate, before, {nextPayDate:newDate});
  saveData(d);
  renderLoansPage();
}




