var _jeLineCount = 0;
var JE_ACCOUNTS = [
  {value:'rent',         label:'Rent'},
  {value:'arrangement',  label:'Payment Arrangement'},
  {value:'loans',        label:'Loans'},
  {value:'utilities',    label:'Utilities'},
  {value:'bad-debt',     label:'Bad Debt'},
  {value:'debt-recovery',label:'Debt Recovery'},
  {value:'misc',         label:'Miscellaneous'},
  {value:'general',      label:'General'},
];
function _jeAccountOptions(selected) {
  return JE_ACCOUNTS.map(function(a) {
    return '<option value="'+a.value+'"'+(a.value===selected?' selected':'')+'>'+a.label+'</option>';
  }).join('');
}
function jeAddLine(type, account, amount) {
  _jeLineCount++;
  var idx = _jeLineCount;
  var t = type || 'debit';
  var container = document.getElementById('je-lines');
  if (!container) return;
  var row = document.createElement('div');
  row.className = 'je-line-row';
  row.id = 'je-line-'+idx;
  row.innerHTML =
    '<div class="je-line-type-wrap">'+
      '<button type="button" class="je-type-btn je-type-debit'+(t==='debit'?' active':'')+'" onclick="jeSetType('+idx+',\'debit\')">DR</button>'+
      '<button type="button" class="je-type-btn je-type-credit'+(t==='credit'?' active':'')+'" onclick="jeSetType('+idx+',\'credit\')">CR</button>'+
    '</div>'+
    '<select class="je-line-account" id="je-account-'+idx+'" onchange="jeRecalc()">'+_jeAccountOptions(account||'rent')+'</select>'+
    '<input class="je-line-amount" id="je-amount-'+idx+'" type="number" step="0.01" min="0" placeholder="0.00" value="'+(amount||'')+'" oninput="jeRecalc()"/>'+
    '<button type="button" class="je-line-remove" onclick="jeRemoveLine('+idx+')" title="Remove line">&#x2715;</button>';
  container.appendChild(row);
  jeRecalc();
}
function jeSetType(idx, type) {
  var row = document.getElementById('je-line-'+idx);
  if (!row) return;
  row.querySelectorAll('.je-type-btn').forEach(function(b) { b.classList.remove('active'); });
  var btn = row.querySelector('.je-type-'+type);
  if (btn) btn.classList.add('active');
  jeRecalc();
}
function jeRemoveLine(idx) {
  var row = document.getElementById('je-line-'+idx);
  if (row) row.remove();
  jeRecalc();
}
function jeGetLines() {
  var container = document.getElementById('je-lines');
  if (!container) return [];
  var lines = [];
  container.querySelectorAll('.je-line-row').forEach(function(row) {
    var id = row.id.replace('je-line-','');
    var debitBtn = row.querySelector('.je-type-debit');
    var type = (debitBtn && debitBtn.classList.contains('active')) ? 'debit' : 'credit';
    var account = (row.querySelector('.je-line-account')||{}).value || 'rent';
    var amount = parseFloat((row.querySelector('.je-line-amount')||{}).value) || 0;
    lines.push({id:id, type:type, account:account, amount:amount});
  });
  return lines;
}
function jeRecalc() {
  var lines = jeGetLines();
  var totalDebit = 0, totalCredit = 0;
  lines.forEach(function(l) {
    if (l.type === 'debit') totalDebit += l.amount;
    else totalCredit += l.amount;
  });
  var diff = Math.abs(totalDebit - totalCredit);
  var balanced = lines.length >= 2 && diff < 0.005;
  var fmtDebit  = document.getElementById('je-total-debits');
  var fmtCredit = document.getElementById('je-total-credits');
  var fmtDiff   = document.getElementById('je-balance-diff');
  var statusEl  = document.getElementById('je-balance-status');
  var submitBtn = document.getElementById('je-submit-btn');
  if (fmtDebit)  fmtDebit.textContent  = '$'+totalDebit.toFixed(2);
  if (fmtCredit) fmtCredit.textContent = '$'+totalCredit.toFixed(2);
  if (fmtDiff) {
    fmtDiff.textContent = '$'+diff.toFixed(2);
    fmtDiff.className = 'je-balance-amt je-balance-diff'+(balanced?' balanced':' unbalanced');
  }
  if (statusEl) {
    statusEl.innerHTML = balanced
      ? '<span class="je-status-pill je-status-balanced">&#10003; Balanced</span>'
      : '<span class="je-status-pill je-status-unbalanced">Unbalanced</span>';
  }
  if (submitBtn) {
    submitBtn.disabled = !balanced;
    submitBtn.title = balanced ? '' : 'Entry must balance before posting';
  }
}
function jeResetModal() {
  _jeLineCount = 0;
  var container = document.getElementById('je-lines');
  if (container) container.innerHTML = '';
  var memo = document.getElementById('je-memo');
  if (memo) memo.value = '';
  var date = document.getElementById('je-date');
  if (date) date.value = today();
  var errEl = document.getElementById('je-error');
  if (errEl) errEl.style.display = 'none';
  jeAddLine('debit');
  jeAddLine('credit');
}
function saveJournalEntry() {
  var tid  = (document.getElementById('je-tenant')||{}).value||'';
  var date = (document.getElementById('je-date')||{}).value||today();
  var memo = ((document.getElementById('je-memo')||{}).value||'').trim();
  var lines = jeGetLines();
  var errEl = document.getElementById('je-error');
  function showErr(msg) { if (errEl) { errEl.textContent=msg; errEl.style.display='block'; } }
  if (!memo) { showErr('Memo / description is required.'); return; }
  if (lines.length < 2) { showErr('At least two lines are required.'); return; }
  var totalDebit = 0, totalCredit = 0;
  lines.forEach(function(l) {
    if (l.type==='debit') totalDebit += l.amount;
    else totalCredit += l.amount;
  });
  if (Math.abs(totalDebit - totalCredit) >= 0.005) {
    showErr('Entry does not balance. Debits ($'+totalDebit.toFixed(2)+') must equal Credits ($'+totalCredit.toFixed(2)+').');
    return;
  }
  if (errEl) errEl.style.display = 'none';
  var d = getData();
  d.journalEntries = d.journalEntries || [];
  d.auditLog = d.auditLog || [];
  // Keep-open: on a re-save of the same open form, replace the balanced group of
  // rows created a moment ago (matched by ref) instead of posting a duplicate
  // journal entry.
  var _jeModal = document.getElementById('modalJournalEntry');
  var _jeEditRef = (_jeModal && _jeModal.dataset && _jeModal.dataset.savedGroupRef) || '';
  if (_jeEditRef) {
    d.journalEntries = d.journalEntries.filter(function(e){ return e.ref !== _jeEditRef; });
  }
  var groupRef = _jeEditRef || uid();
  lines.forEach(function(l) {
    var entry = {
      id: uid(), tenantId: tid||null, date: date,
      memo: memo, desc: memo, ledger: l.account,
      charge: l.type==='debit' ? l.amount : 0,
      payment: l.type==='credit' ? l.amount : 0,
      debit: l.type==='debit' ? l.amount : 0,
      credit: l.type==='credit' ? l.amount : 0,
      type: 'journal', method: 'journal', status: 'pending-ed', ref: groupRef
    };
    d.journalEntries.push(entry);
    // Real audit row (fire-and-forget POST — safe inside this loop, unlike the
    // legacy auditLog() helper which called saveData() internally).
    writeAuditEntry({action:'post_journal_entry', entity_type:'journal', entity_id:entry.id,
      summary:'Journal entry ('+l.type+'): '+memo, detail:{after:entry}});
  });
  saveData(d);
  if (_jeModal && _jeModal.dataset) _jeModal.dataset.savedGroupRef = groupRef;
  renderDashboard();
  if (document.getElementById('page-journal').classList.contains('on')) renderJournal();
  if (document.getElementById('page-transactions').classList.contains('on')) renderTransactions();
  toast('Journal entry saved.');
}


// \u2500\u2500 OPENING BALANCE \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function saveOpeningBalance() {
  var tid    = (document.getElementById('ob-tenant')||{}).value;
  var amount = parseFloat((document.getElementById('ob-amount')||{}).value)||0;
  var date   = (document.getElementById('ob-date')||{}).value||today();
  var notes  = (document.getElementById('ob-notes')||{}).value||'';
  if (!tid)    { toast('Please select a tenant.'); return; }
  if (!amount) { toast('Amount required.'); return; }
  var d = getData(); var t = getTenant(tid);
  // Keep-open: on a re-save of the same open form, UPDATE the opening-balance
  // row created a moment ago instead of pushing a duplicate.
  var _obModal = document.getElementById('modalOpeningBalance');
  var _obEditId = (_obModal && _obModal.dataset && _obModal.dataset.savedEntryId) || '';
  var entry = {id: _obEditId || uid(),tenantId:tid,date:date,
    desc:'Opening Balance'+(notes?' \u2014 '+notes:''),
    charge:amount,payment:0,type:'opening',method:'',status:'approved',ref:'OB-'+tid.slice(-4)};
  var _obIdx = _obEditId ? d.rentLedger.findIndex(function(r){ return r.id === _obEditId; }) : -1;
  if (_obIdx >= 0) { d.rentLedger[_obIdx] = entry; } else { d.rentLedger.push(entry); }
  writeAuditEntry({action:'post_opening_balance',entity_type:'opening-balance',entity_id:entry.id,
    summary:'Opening balance: '+(t?tenantName(t):tid)+' \u2014 '+fmt(amount),detail:{after:entry}});
  saveData(d);
  if (_obModal && _obModal.dataset) _obModal.dataset.savedEntryId = entry.id;
  renderDashboard();
  renderRentLedger();
  toast('Opening balance saved.');
}

// \u2500\u2500 REPORTS PAGE \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function renderPeriodSummary() {
  var type  = (document.getElementById('rpt-period-type')||{}).value||'month';
  var month = (document.getElementById('rpt-period-month')||{}).value||'04';
  var year  = (document.getElementById('rpt-period-year')||{}).value||'2026';
  var el    = document.getElementById('rpt-period-content');
  if (!el) return;

  // Show/hide month selector
  var mw = document.getElementById('rpt-month-wrap');
  if (mw) mw.style.display = type==='fiscal' ? 'none' : 'block';

  var d = getData();
  var dateRanges = [];
  var periodLabel = '';

  if (type === 'month') {
    dateRanges = [year+'-'+month];
    var mNames = {
      '01':'January','02':'February','03':'March','04':'April','05':'May','06':'June',
      '07':'July','08':'August','09':'September','10':'October','11':'November','12':'December'
    };
    periodLabel = mNames[month]+' '+year;
  } else if (type === 'quarter') {
    var qMap = {Q1:['04','05','06'],Q2:['07','08','09'],Q3:['10','11','12'],Q4:['01','02','03']};
    var qSel = (document.getElementById('rpt-period-quarter')||{}).value||'Q1';
    var qYear = qSel==='Q4' ? String(parseInt(year)+1) : year;
    dateRanges = qMap[qSel].map(function(m){ return (qSel==='Q4'?qYear:year)+'-'+m; });
    periodLabel = qSel+' FY'+year.slice(2)+'-'+String(parseInt(year)+1).slice(2);
  } else { // fiscal
    var fyStart = parseInt(year);
    for (var mi=4; mi<=12; mi++) dateRanges.push(year+'-'+String(mi).padStart(2,'0'));
    for (var mi2=1; mi2<=3; mi2++) dateRanges.push(String(fyStart+1)+'-'+String(mi2).padStart(2,'0'));
    periodLabel = 'FY '+year+'-'+String(parseInt(year)+1).slice(2)+' (Apr\u2013Mar)';
  }

  // Calculate totals for period
  var rentCharged=0, rentCollected=0, rentArrears=0;
  var arrCollected=0, loanCollected=0;
  var tenantRows = [];

  d.tenants.forEach(function(t){
    var tRentCharged=0, tRentPaid=0, tArrPaid=0, tLoanPaid=0;
    dateRanges.forEach(function(ym){
      d.rentLedger.filter(function(r){return r.tenantId===t.id&&r.date.slice(0,7)===ym&&!finIsVoided(r);}).forEach(function(r){
        tRentCharged += r.charge||0;
        tRentPaid   += r.payment||0;
      });
      d.arrPayments.filter(function(p){return p.tenantId===t.id&&p.date.slice(0,7)===ym&&!finIsVoided(p);}).forEach(function(p){
        tArrPaid += p.amount||0;
      });
      d.loanPayments.filter(function(p){return p.tenantId===t.id&&p.date.slice(0,7)===ym&&!finIsVoided(p);}).forEach(function(p){
        tLoanPaid += p.amount||0;
      });
    });
    var total = tRentPaid + tArrPaid + tLoanPaid;
    if (tRentCharged > 0 || total > 0) {
      rentCharged   += tRentCharged;
      rentCollected += tRentPaid;
      arrCollected  += tArrPaid;
      loanCollected += tLoanPaid;
      tenantRows.push({t:t, charged:tRentCharged, rentPaid:tRentPaid, arrPaid:tArrPaid, loanPaid:tLoanPaid, total:total, variance:tRentPaid-tRentCharged});
    }
  });
  var totalCollected = rentCollected + arrCollected + loanCollected;
  rentArrears = rentCharged - rentCollected;

  // Summary boxes
  var summaryHtml =
    '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:20px;">'+
    [
      {lbl:'Rent Charged',val:rentCharged,color:'var(--text)',sub:'Invoiced this period'},
      {lbl:'Rent Collected',val:rentCollected,color:'var(--success)',sub:'Cash/EFT/Payroll received'},
      {lbl:'Rent Arrears',val:rentArrears,color:rentArrears>0?'var(--danger)':'var(--success)',sub:'Uncollected rent'},
      {lbl:'Arrangement Collected',val:arrCollected,color:'var(--success)',sub:'Payment plan receipts'},
      {lbl:'Loan Collected',val:loanCollected,color:'var(--success)',sub:'Loan repayments'},
      {lbl:'Total Collected',val:totalCollected,color:'var(--yellow)',sub:'All receipts combined',dark:true},
    ].map(function(tile){
      return '<div style="background:'+(tile.dark?'var(--dark)':'var(--surface)')+';border:1px solid var(--border);border-radius:10px;padding:14px;">'+
        '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:'+(tile.dark?'var(--gray)':'var(--muted)')+';margin-bottom:4px;">'+tile.lbl+'</div>'+
        '<div style="font-size:22px;font-weight:700;color:'+tile.color+';">'+fmt(tile.val)+'</div>'+
        '<div style="font-size:11px;color:var(--muted);margin-top:2px;">'+tile.sub+'</div>'+
      '</div>';
    }).join('')+
  '</div>';

  // Detail table \u2014 one row per tenant
  var tRows = tenantRows.map(function(row){
    var variance = row.rentPaid - row.charged;
    return '<tr>'+
      '<td class="std-cell-primary">'+tenantName(row.t)+'<br><span style="font-size:11px;color:var(--muted);font-weight:normal;">'+row.t.unit+'</span></td>'+
      '<td class="std-cell-right amt-debit">'+fmt(row.charged)+'</td>'+
      '<td class="std-cell-right amt-credit">'+fmt(row.rentPaid)+'</td>'+
      '<td class="std-cell-right">'+(row.arrPaid>0?'<span class="amt-credit">'+fmt(row.arrPaid)+'</span>':'<span class="std-cell-dash">\u2014</span>')+'</td>'+
      '<td class="std-cell-right">'+(row.loanPaid>0?'<span class="amt-credit">'+fmt(row.loanPaid)+'</span>':'<span class="std-cell-dash">\u2014</span>')+'</td>'+
      '<td class="std-cell-right"><strong class="amt-credit">'+fmt(row.total)+'</strong></td>'+
      '<td class="std-cell-right" style="color:'+(variance>=0?'var(--success)':'var(--danger)')+';">'+fmt(variance)+'</td>'+
    '</tr>';
  }).join('');

  el.innerHTML =
    '<div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--muted);margin-bottom:12px;">'+
    ''+(window.NATION_CONFIG && window.NATION_CONFIG.short || "")+' Housing Finance &mdash; '+periodLabel+'</div>'+
    summaryHtml+
    '<div class="std-table-card">'+
      '<div class="std-table-hdr">'+
        '<span>Tenant Detail</span>'+
        '<span class="std-table-count">'+tenantRows.length+' tenants · '+periodLabel+'</span>'+
      '</div>'+
      '<table class="std-table">'+
      '<thead><tr>'+
        '<th>Tenant</th>'+
        '<th class="std-cell-right">Rent Charged</th>'+
        '<th class="std-cell-right">Rent Paid</th>'+
        '<th class="std-cell-right">Arrangement</th>'+
        '<th class="std-cell-right">Loan</th>'+
        '<th class="std-cell-right">Total Received</th>'+
        '<th class="std-cell-right">Variance</th>'+
      '</tr></thead>'+
      '<tbody>'+
      (tRows || '<tr class="empty-row"><td colspan="7">No activity in this period.</td></tr>')+
      (tenantRows.length ? '<tr style="background:var(--bg);font-weight:700;border-top:2px solid var(--border);">'+
        '<td>TOTAL</td>'+
        '<td class="std-cell-right amt-debit">'+fmt(rentCharged)+'</td>'+
        '<td class="std-cell-right amt-credit">'+fmt(rentCollected)+'</td>'+
        '<td class="std-cell-right amt-credit">'+fmt(arrCollected)+'</td>'+
        '<td class="std-cell-right amt-credit">'+fmt(loanCollected)+'</td>'+
        '<td class="std-cell-right amt-credit">'+fmt(totalCollected)+'</td>'+
        '<td class="std-cell-right" style="color:'+(rentArrears<=0?'var(--success)':'var(--danger)')+';">'+fmt(rentCollected-rentCharged)+'</td>'+
      '</tr>' : '')+
      '</tbody></table>'+
    '</div>'+
    '<div style="margin-top:12px;font-size:11px;color:var(--muted);">'+
    'Generated: '+new Date().toLocaleString('en-CA')+' &nbsp;|&nbsp; Period: '+periodLabel+' &nbsp;|&nbsp; '+(window.NATION_CONFIG && window.NATION_CONFIG.short || "")+' Housing Finance Module</div>';
}

function renderReconciliation() {
  var month = (document.getElementById('rec-month')||{}).value||'04';
  var year  = (document.getElementById('rec-year')||{}).value||'2026';
  var el    = document.getElementById('rec-content');
  if (!el) return;
  var ym = year+'-'+month;
  var mNames = {'01':'January','02':'February','03':'March','04':'April','05':'May','06':'June',
    '07':'July','08':'August','09':'September','10':'October','11':'November','12':'December'};
  var periodLabel = mNames[month]+' '+year;
  var d = getData();

  // Prior month closing balance (all entries before this month)
  var priorRentBal = 0;
  d.rentLedger.filter(function(r){return r.date.slice(0,7)<ym&&!finIsVoided(r);}).forEach(function(r){
    priorRentBal += (r.charge||0)-(r.payment||0);
  });

  // This month activity
  var thisCharged=0, thisRentPaid=0, thisArrPaid=0, thisLoanPaid=0;
  d.rentLedger.filter(function(r){return r.date.slice(0,7)===ym&&!finIsVoided(r);}).forEach(function(r){
    thisCharged  += r.charge||0;
    thisRentPaid += r.payment||0;
  });
  d.arrPayments.filter(function(p){return p.date.slice(0,7)===ym&&!finIsVoided(p);}).forEach(function(p){thisArrPaid+=p.amount||0;});
  d.loanPayments.filter(function(p){return p.date.slice(0,7)===ym&&!finIsVoided(p);}).forEach(function(p){thisLoanPaid+=p.amount||0;});

  var closingRentBal = priorRentBal + thisCharged - thisRentPaid;
  var totalCollected = thisRentPaid + thisArrPaid + thisLoanPaid;

  // Collection by method
  var byMethod = {};
  d.rentLedger.filter(function(r){return r.date.slice(0,7)===ym&&r.payment>0&&!finIsVoided(r);}).forEach(function(r){
    var m = r.method||'unknown'; byMethod[m]=(byMethod[m]||0)+r.payment;
  });
  d.arrPayments.filter(function(p){return p.date.slice(0,7)===ym&&!finIsVoided(p);}).forEach(function(p){
    var m = p.method||'unknown'; byMethod[m]=(byMethod[m]||0)+p.amount;
  });
  d.loanPayments.filter(function(p){return p.date.slice(0,7)===ym&&!finIsVoided(p);}).forEach(function(p){
    var m = p.method||'unknown'; byMethod[m]=(byMethod[m]||0)+p.amount;
  });

  var methodRows = Object.keys(byMethod).map(function(m){
    return '<tr><td>'+methodLabel(m)+'</td><td class="amt-credit">'+fmt(byMethod[m])+'</td></tr>';
  }).join('');

  el.innerHTML =
    '<div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--muted);margin-bottom:16px;">'+
    ''+(window.NATION_CONFIG && window.NATION_CONFIG.short || "")+' Housing Finance &mdash; Monthly Reconciliation &mdash; '+periodLabel+'</div>'+

    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">'+

      // LEFT COLUMN — reconciliation + methods
      '<div>'+

        // Rent Account Reconciliation
        '<div class="std-table-card" style="margin-bottom:14px;">'+
          '<div class="std-table-hdr"><span>Rent Account Reconciliation</span><span class="std-table-count">'+periodLabel+'</span></div>'+
          '<table class="std-table">'+
            '<tbody>'+
              '<tr><td>Opening Balance <span style="color:var(--muted);font-size:11px;">(prior month arrears)</span></td>'+
                '<td class="std-cell-right" style="color:'+(priorRentBal>0?'var(--danger)':'var(--success)')+';"><strong>'+fmt(priorRentBal)+'</strong></td></tr>'+
              '<tr><td>+ Rent Charged This Month</td>'+
                '<td class="std-cell-right amt-debit">'+fmt(thisCharged)+'</td></tr>'+
              '<tr><td>&minus; Rent Payments Received</td>'+
                '<td class="std-cell-right amt-credit">('+fmt(thisRentPaid)+')</td></tr>'+
              '<tr style="background:var(--bg);font-weight:700;border-top:2px solid var(--border);">'+
                '<td>Closing Balance <span style="color:var(--muted);font-size:11px;font-weight:normal;">(rent arrears)</span></td>'+
                '<td class="std-cell-right" style="color:'+(closingRentBal>0?'var(--danger)':'var(--success)')+';"><strong>'+fmt(closingRentBal)+'</strong></td>'+
              '</tr>'+
            '</tbody>'+
          '</table>'+
        '</div>'+

        // Collections by Method
        '<div class="std-table-card">'+
          '<div class="std-table-hdr"><span>Collections by Payment Method</span><span class="std-table-count">'+Object.keys(byMethod).length+' method'+(Object.keys(byMethod).length===1?'':'s')+'</span></div>'+
          '<table class="std-table">'+
            '<thead><tr><th>Method</th><th class="std-cell-right">Amount</th></tr></thead>'+
            '<tbody>'+
              (methodRows || '<tr class="empty-row"><td colspan="2">No payments recorded this period.</td></tr>')+
              (methodRows ? '<tr style="background:var(--bg);font-weight:700;border-top:2px solid var(--border);">'+
                '<td>Total Collected</td>'+
                '<td class="std-cell-right amt-credit">'+fmt(totalCollected)+'</td></tr>' : '')+
            '</tbody>'+
          '</table>'+
        '</div>'+

      '</div>'+

      // RIGHT COLUMN — GL posting summary
      '<div>'+
        '<div class="std-table-card">'+
          '<div class="std-table-hdr"><span>Summary for Finance</span><span class="std-table-count">To post in accounting software</span></div>'+
          '<table class="std-table">'+
            '<thead><tr><th>Account</th><th>Type</th><th class="std-cell-right">Amount</th></tr></thead>'+
            '<tbody>'+
              [
                {acct:'Rent Revenue (4100)',          amount:thisCharged,    type:'CR'},
                {acct:'Rent Receivable (1200)',       amount:thisRentPaid,   type:'DR'},
                {acct:'Arrangement Receivable (1210)',amount:thisArrPaid,    type:'DR'},
                {acct:'Loan Receivable (1220)',       amount:thisLoanPaid,   type:'DR'}
              ].map(function(row){
                return '<tr>'+
                  '<td class="std-cell-primary">'+row.acct+'</td>'+
                  '<td>'+(row.type==='CR'?'<span class="std-pill std-pill-overdue">CR</span>':'<span class="std-pill std-pill-paid">DR</span>')+'</td>'+
                  '<td class="std-cell-right"><strong style="color:'+(row.type==='CR'?'var(--danger)':'var(--success)')+';">'+fmt(row.amount)+'</strong></td>'+
                '</tr>';
              }).join('')+
            '</tbody>'+
          '</table>'+
          '<div style="padding:10px 14px;background:var(--bg);font-size:11px;color:var(--muted);border-top:1px solid var(--border);">&#9432; Account codes are indicative. Confirm with your chart of accounts.</div>'+
        '</div>'+
      '</div>'+
    '</div>'+

    '<div style="margin-top:12px;font-size:11px;color:var(--muted);">Generated: '+new Date().toLocaleString('en-CA')+' | '+(window.NATION_CONFIG && window.NATION_CONFIG.short || "")+' Housing Finance Module</div>';
}

