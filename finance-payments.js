function saveRentPayment() {
  var tid    = (document.getElementById('rp-tenant')||{}).value;
  var date   = (document.getElementById('rp-date')||{}).value;
  var total  = parseFloat((document.getElementById('rp-amount')||{}).value)||0;
  var method = (document.getElementById('rp-method')||{}).value||'cash';
  var ref    = (document.getElementById('rp-ref')||{}).value||'';
  var notes  = (document.getElementById('rp-notes')||{}).value||'';
  if (!tid)   { toast('Please select a tenant.'); return; }
  if (!date)  { toast('Please enter a payment date.'); return; }
  if (!total) { toast('Please enter an amount.'); return; }
  // Check over-allocation
  var rentAmt = parseFloat((document.getElementById('rp-alloc-rent')||{}).value)||0;
  var arrAmt  = parseFloat((document.getElementById('rp-alloc-arr')||{}).value)||0;
  var loanAmt = parseFloat((document.getElementById('rp-alloc-loan')||{}).value)||0;
  var allocated = Math.round((rentAmt+arrAmt+loanAmt)*100)/100;
  if (allocated > total + 0.005) { toast('Allocated amounts exceed total received. Please adjust.'); return; }
  var unalloc = Math.round((total - allocated)*100)/100;
  if (unalloc > 0.005) rentAmt = Math.round((rentAmt + unalloc)*100)/100; // credit remainder to rent

  var d = getData();
  var t = getTenant(tid);
  var tName = t ? tenantName(t) : tid;
  var voucherAllocs = [];
  var voucherLines = [];
  // Keep-open (non-cash): the form stays open behind the voucher; track the ids
  // of the rows posted so a re-save removes them before re-posting (no duplicate
  // across the rent / arrangement / loan ledgers). The cash path keeps its
  // close -> cash-count chain below, so no 3-way modal stacking.
  var _rpModal = document.getElementById('modalRentPayment');
  var _rpPriorIds = [];
  try { _rpPriorIds = JSON.parse((_rpModal && _rpModal.dataset && _rpModal.dataset.savedEntryIds) || '[]'); } catch(e){}
  var _rpNewIds = [];

  var doSave = function(cashTotal, denoms, receivedBy) {
    var finalTotal = cashTotal || total;
    var d2 = getData();
    _rpNewIds = [];
    if (_rpPriorIds.length) {
      d2.rentLedger   = (d2.rentLedger||[]).filter(function(e){ return _rpPriorIds.indexOf(e.id) === -1; });
      d2.arrPayments  = (d2.arrPayments||[]).filter(function(e){ return _rpPriorIds.indexOf(e.id) === -1; });
      d2.loanPayments = (d2.loanPayments||[]).filter(function(e){ return _rpPriorIds.indexOf(e.id) === -1; });
    }

    // Post rent payment
    if (rentAmt > 0) {
      var rentEntry = {id:uid(),tenantId:tid,date:date,desc:'Rent Payment'+(notes?' ('+notes+')':''),
        charge:0,payment:rentAmt,type:'payment',method:method,status:'posted',ref:ref};
      if (denoms) { rentEntry.denominations=denoms; rentEntry.receivedBy=receivedBy; }
      d2.rentLedger.push(rentEntry); _rpNewIds.push(rentEntry.id);
      if (!d2.auditLog) d2.auditLog=[];
      writeAuditEntry({action:'post_payment',entity_type:'payment',entity_id:rentEntry.id,summary:'Rent payment: '+tName+' \u2014 '+fmt(rentAmt),detail:{after:rentEntry}});
      voucherAllocs.push({label:'Rent', amount:rentAmt, invoices:[]});
      voucherLines.push('Rent: '+fmt(rentAmt));
    }

    // Post arrangement payment
    if (arrAmt > 0) {
      var activeArr = d2.arrangements.filter(function(a){return a.tenantId===tid&&a.status==='approved';});
      var arr = activeArr[0];
      if (arr) {
        var arrEntry = {id:uid(),arrId:arr.id,tenantId:tid,date:date,amount:arrAmt,method:method,type:'regular',ref:ref,notes:notes};
        if (denoms) { arrEntry.denominations=denoms; arrEntry.receivedBy=receivedBy; }
        d2.arrPayments.push(arrEntry); _rpNewIds.push(arrEntry.id);
        if (!d2.auditLog) d2.auditLog=[];
        writeAuditEntry({action:'post_arr_payment',entity_type:'arrPayment',entity_id:arrEntry.id,summary:'Arrangement payment: '+tName+' \u2014 '+fmt(arrAmt),detail:{after:arrEntry}});
        voucherAllocs.push({label:'Arrangement ('+arr.ref+')', amount:arrAmt, invoices:[arr.ref]});
        voucherLines.push('Arrangement: '+fmt(arrAmt));
      }
    }

    // Post loan payment
    if (loanAmt > 0) {
      var activeLoan = d2.loanList.filter(function(l){return l.tenantId===tid&&l.status==='approved';});
      var loan = activeLoan[0];
      if (loan) {
        var loanEntry = {id:uid(),loanId:loan.id,tenantId:tid,date:date,amount:loanAmt,method:method,notes:notes,status:'posted'};
        if (denoms) { loanEntry.denominations=denoms; loanEntry.receivedBy=receivedBy; }
        d2.loanPayments.push(loanEntry); _rpNewIds.push(loanEntry.id);
        if (!d2.auditLog) d2.auditLog=[];
        writeAuditEntry({action:'post_loan_payment',entity_type:'loanPayment',entity_id:loanEntry.id,summary:'Loan payment: '+tName+' \u2014 '+fmt(loanAmt),detail:{after:loanEntry}});
        voucherAllocs.push({label:'Loan ('+loan.type+')', amount:loanAmt, invoices:[loan.type]});
        voucherLines.push('Loan: '+fmt(loanAmt));
      }
    }

    // Single save \u2014 all changes at once
    saveData(d2);
    if (_rpModal && _rpModal.dataset) _rpModal.dataset.savedEntryIds = JSON.stringify(_rpNewIds);
    renderDashboard();
    if (_stmtTid) renderStatementEntries();
    if (document.getElementById('page-tenants').classList.contains('on')) renderTenantProfile(tid);
    generateVoucherFor({date:date,tenantId:tid,ledger:voucherAllocs.length===1?voucherAllocs[0].label.split(' ')[0].toLowerCase():'combined',
      desc:'Payment \u2014 '+voucherLines.join(' | '),charge:0,payment:finalTotal,method:method,status:'posted',id:uid(),
      denominations:denoms||null, allocations:voucherAllocs});
  };

  if (method==='cash') {
    openCashDenom(total, function(cashTotal, denoms, receivedBy) {
      closeModal('modalRentPayment');
      doSave(cashTotal, denoms, receivedBy);
    });
  } else {
    // Keep the form open behind the voucher (non-cash).
    doSave(null,null,null);
  }
}

var currentVoucherData = null;
var pendingCashCallback = null;
var pendingPaymentAmount = 0;

function openCashDenom(amount, callback) {
  pendingPaymentAmount = amount;
  pendingCashCallback = callback;
  document.getElementById('cashDenomInfo').innerHTML = 'Payment amount: <strong>'+fmt(amount)+'</strong>. Enter bills and coins received.';
  document.getElementById('denomPaymentDue').textContent = fmt(amount);
  ['100','50','20','10','5','2','1','coin'].forEach(function(d){
    var el = document.getElementById('denom-'+d); if(el) el.value='0';
    var sub = document.getElementById('sub-'+d); if(sub) sub.textContent='$0.00';
  });
  document.getElementById('denomTotalVal').textContent = '$0.00';
  document.getElementById('denomBalanceVal').textContent = '\u2014';
  document.getElementById('denomBalanceVal').style.color = 'var(--gray)';
  document.getElementById('denomBalanceLbl').textContent = 'Balance';
  var msg = document.getElementById('denomStatusMsg'); if(msg) msg.style.display='none';
  var btn = document.getElementById('denomConfirmBtn'); if(btn){btn.disabled=false;btn.style.opacity='1';}
  openModal('modalCashDenom');
}

function calcDenomTotal() {
  var denoms = [
    {id:'100',val:100},{id:'50',val:50},{id:'20',val:20},{id:'10',val:10},
    {id:'5',val:5},{id:'2',val:2},{id:'1',val:1},{id:'coin',val:1,isFloat:true}
  ];
  var total = 0;
  denoms.forEach(function(d) {
    var el = document.getElementById('denom-'+d.id);
    var count = d.isFloat ? (parseFloat(el.value)||0) : (parseInt(el.value)||0);
    var subtotal = d.isFloat ? count : count * d.val;
    total += subtotal;
    var sub = document.getElementById('sub-'+d.id); if(sub) sub.textContent = fmt(subtotal);
  });
  var due = pendingPaymentAmount;
  var diff = Math.round((total - due)*100)/100;
  var btn = document.getElementById('denomConfirmBtn');
  var msg = document.getElementById('denomStatusMsg');
  var balEl = document.getElementById('denomBalanceVal');
  var balLbl = document.getElementById('denomBalanceLbl');
  document.getElementById('denomTotalVal').textContent = fmt(total);
  if (total === 0) {
    balEl.textContent='\u2014'; balEl.style.color='var(--gray)'; balLbl.textContent='Balance';
    msg.style.display='none'; btn.disabled=true; btn.style.opacity='.45';
  } else if (Math.abs(diff) < 0.01) {
    balEl.textContent='Balanced'; balEl.style.color='#4ade80'; balLbl.textContent='Status';
    msg.style.display='block'; msg.style.background='var(--success-bg)'; msg.style.color='var(--success)';
    msg.style.border='1px solid var(--success-border)'; msg.textContent='\u2713 Cash balances exactly. Ready to record.';
    btn.disabled=false; btn.style.opacity='1';
  } else if (diff > 0) {
    balEl.textContent=fmt(diff)+' change'; balEl.style.color='#fb923c'; balLbl.textContent='Change Due';
    msg.style.display='block'; msg.style.background='var(--warn-amber-bg)'; msg.style.color='var(--warn-amber-text)';
    msg.style.border='1px solid #fed7aa'; msg.textContent='Tenant overpaid by '+fmt(diff)+'. Return '+fmt(diff)+' in change.';
    btn.disabled=false; btn.style.opacity='1';
  } else {
    balEl.textContent=fmt(Math.abs(diff))+' short'; balEl.style.color='#f87171'; balLbl.textContent='Still Owing';
    msg.style.display='block'; msg.style.background='var(--danger-bg)'; msg.style.color='var(--danger)';
    msg.style.border='1px solid var(--danger-border)'; msg.textContent='\u2717 Cash is '+fmt(Math.abs(diff))+' short. Cannot record until balanced.';
    btn.disabled=true; btn.style.opacity='.45';
  }
  return total;
}

function getDenominations() {
  return {
    '$100': parseInt(document.getElementById('denom-100').value)||0,
    '$50':  parseInt(document.getElementById('denom-50').value)||0,
    '$20':  parseInt(document.getElementById('denom-20').value)||0,
    '$10':  parseInt(document.getElementById('denom-10').value)||0,
    '$5':   parseInt(document.getElementById('denom-5').value)||0,
    '$2':   parseInt(document.getElementById('denom-2').value)||0,
    '$1':   parseInt(document.getElementById('denom-1').value)||0,
    'coin': parseFloat(document.getElementById('denom-coin').value)||0
  };
}

function confirmCashDenom() {
  var total = calcDenomTotal();
  var due = pendingPaymentAmount;
  var diff = Math.round((total - due)*100)/100;
  if (total === 0 || diff < -0.005) { toast('Cash does not balance. Please correct before confirming.'); return; }
  var denoms = getDenominations();
  var receivedBy = (document.getElementById('denom-receivedby')||{}).value || CURRENT_USER;
  closeModal('modalCashDenom');
  if (pendingCashCallback) pendingCashCallback(total, denoms, receivedBy);
}

function printDenomSheet() {
  var total = calcDenomTotal();
  var denoms = getDenominations();
  var due = pendingPaymentAmount;
  var diff = Math.round((total - due)*100)/100;
  var w = window.open('','_blank','width=520,height=680');
  if (!w) { toast('Print popup blocked. Please allow popups for this site.'); return; }
  var rows = [
    ['$100 bill', denoms['$100'], denoms['$100']*100],
    ['$50 bill',  denoms['$50'],  denoms['$50']*50],
    ['$20 bill',  denoms['$20'],  denoms['$20']*20],
    ['$10 bill',  denoms['$10'],  denoms['$10']*10],
    ['$5 bill',   denoms['$5'],   denoms['$5']*5],
    ['$2 coin',   denoms['$2'],   denoms['$2']*2],
    ['$1 coin',   denoms['$1'],   denoms['$1']*1],
    ['Coin (other $)', denoms['coin'], denoms['coin']],
  ];
  var tableRows = rows.map(function(r){ return '<tr><td>'+r[0]+'</td><td style="text-align:center;">'+r[1]+'</td><td style="text-align:right;">$'+r[2].toFixed(2)+'</td></tr>'; }).join('');
  var balClass = Math.abs(diff)<0.01?'balanced':diff>0?'over':'short';
  var balMsg = Math.abs(diff)<0.01?'\u2713 Balanced':'Change due: $'+diff.toFixed(2);
  w.document.write('<html><head><title>Cash Sheet</title><style>body{font-family:sans-serif;padding:24px;}table{width:100%;border-collapse:collapse;margin-bottom:16px;}th,td{padding:8px 10px;border:1px solid #ddd;font-size:14px;}th{background:#111;color:#fff;}.balanced{background:#f0fdf4;color:#15803d;padding:10px;border-radius:6px;}.over{background:#fff7ed;color:#c2410c;padding:10px;border-radius:6px;}.sig-line{border-bottom:1px solid #333;height:28px;margin-bottom:6px;margin-top:20px;}@media print{.no-print{display:none;}}</style></head><body>');
  w.document.write('<h2>'+(window.NATION_CONFIG && window.NATION_CONFIG.short || "")+' Housing \u2014 Cash Receipt</h2><p>Date: '+new Date().toLocaleDateString('en-CA')+'</p>');
  w.document.write('<table><thead><tr><th>Denomination</th><th>Count</th><th>Subtotal</th></tr></thead><tbody>'+tableRows+'<tr style="font-weight:bold;"><td colspan="2">Total Cash Received</td><td style="text-align:right;">$'+total.toFixed(2)+'</td></tr><tr style="font-weight:bold;"><td colspan="2">Payment Due</td><td style="text-align:right;">$'+due.toFixed(2)+'</td></tr></tbody></table>');
  w.document.write('<div class="'+balClass+'">'+balMsg+'</div>');
  w.document.write('<div class="sig-line"></div><p>Received By: ________________________________</p>');
  w.document.write('<div class="no-print" style="margin-top:20px;"><button onclick="window.print()">Print</button></div>');
  w.document.write('</body></html>');
  w.print();
}
