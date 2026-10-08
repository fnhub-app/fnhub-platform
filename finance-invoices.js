// \u2500\u2500 Invoice cache and search \u2500\u2500
var _invoiceCache = {};
var _entryCache = {};
function openInvoiceById(invCacheId) {
  var txn = _invoiceCache[invCacheId];
  if (!txn) return;
  openInvoiceVoucher(txn);
}

function matchInvoicesToPayments(tenantId, d) {
  // Voided originals and their reversal rows are excluded on BOTH sides so a
  // voided invoice never shows a phantom remainder and a voided payment never
  // "pays down" a live invoice.
  var _voidOk = (typeof finIsVoided === 'function') ? function(r){ return !finIsVoided(r); } : function(){ return true; };
  var ledger = d.rentLedger.filter(function(r){return r.tenantId===tenantId && _voidOk(r);})
    .sort(function(a,b){return a.date.localeCompare(b.date);});
  var invoices = ledger.filter(function(r){return r.type==='invoice'||r.type==='opening';});
  var payments = ledger.filter(function(r){return r.type==='payment'&&r.status!=='reversed';});
  var invoiceBalances = invoices.map(function(inv){
    return {inv:inv, remaining:inv.charge, payments:[]};
  });
  var paymentPool = payments.map(function(p){return {p:p, remaining:p.payment};});
  paymentPool.forEach(function(pp){
    invoiceBalances.forEach(function(ib){
      if(pp.remaining <= 0 || ib.remaining <= 0) return;
      var applied = Math.min(pp.remaining, ib.remaining);
      ib.remaining = Math.round((ib.remaining - applied)*100)/100;
      pp.remaining = Math.round((pp.remaining - applied)*100)/100;
      ib.payments.push({date:pp.p.date, amount:applied, method:pp.p.method, ref:pp.p.ref});
    });
  });
  return invoiceBalances;
}

function openInvoiceVoucher(txn) {
  currentVoucherData = txn;
  var tn = getTenant(txn.tenantId);
  var isPaid = (txn.invoiceBalance||0) <= 0.005;
  var isPartial = !isPaid && txn.payments && txn.payments.length > 0;
  var statusLabel = isPaid ? 'PAID IN FULL' : isPartial ? 'PARTIALLY PAID' : 'UNPAID';
  var statusBg = isPaid ? 'var(--success)' : isPartial ? 'var(--warn-amber-text)' : 'var(--danger)';
  var voucherNum = txn.ref || ('INV-'+txn.id.slice(-6).toUpperCase());
  var paymentsHtml = '';
  if (txn.payments && txn.payments.length) {
    paymentsHtml = '<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border);">' +
      '<div style="font-size:10px;font-weight:700;text-transform:uppercase;color:var(--muted);margin-bottom:6px;">Payments Applied</div>'+
      txn.payments.map(function(p){
        return '<div style="display:flex;justify-content:space-between;font-size:12px;padding:4px 0;">'+
          '<span>'+p.date+(p.method?' \u00B7 '+methodLabel(p.method):'')+' </span>'+
          '<span class="amt-credit">'+fmt(p.amount)+'</span></div>';
      }).join('')+'</div>';
  }
  var html = '<div class="voucher">' +
    '<div class="voucher-hdr"><div>' +
      '<div style="font-family:var(--serif);font-size:16px;color:#fff;">'+(window.NATION_CONFIG && window.NATION_CONFIG.display_name || "")+'</div>' +
      '<div style="font-size:11px;color:var(--gray);">Housing Finance \u2014 Rent Invoice</div></div>' +
      '<div style="text-align:right;"><div style="font-size:11px;color:var(--gray);">Invoice #</div>' +
      '<div style="color:var(--yellow);font-weight:700;font-size:13px;">'+voucherNum+'</div></div></div>' +
    '<div class="voucher-body">' +
      '<div class="voucher-row"><span class="lbl">Invoice Date</span><span>'+txn.date+'</span></div>' +
      '<div class="voucher-row"><span class="lbl">Tenant</span><span><strong>'+(tn?tenantName(tn):txn.tenantId)+'</strong>'+(tn?' \u2014 '+tn.unit:'')+' </span></div>' +
      '<div class="voucher-row"><span class="lbl">Description</span><span>'+txn.desc+'</span></div>' +
      '<div class="voucher-row"><span class="lbl">Amount Charged</span><span class="txn-type-charge">'+fmt(txn.charge)+'</span></div>' +
      (txn.payments&&txn.payments.length ? '<div class="voucher-row"><span class="lbl">Total Paid</span><span class="amt-credit">'+fmt(txn.payments.reduce(function(s,p){return s+p.amount;},0))+'</span></div>' : '') +
      ((txn.invoiceBalance||0)>0.005 ? '<div class="voucher-row"><span class="lbl">Balance Owing</span><span class="amt-debit">'+fmt(txn.invoiceBalance)+'</span></div>' : '') +
      paymentsHtml +
    '</div>' +
    '<div class="voucher-total" style="background:'+statusBg+';">' +
      '<span style="font-size:13px;color:rgba(255,255,255,0.7);">'+statusLabel+'</span>' +
      '<div style="font-size:26px;color:#fff;">' +
        (isPaid ? fmt(txn.charge) : (txn.invoiceBalance||0)>0.005 ? fmt(txn.invoiceBalance)+' owing' : fmt(txn.charge)) +
      '</div></div>' +
  '</div>';;
  document.getElementById('voucherContent').innerHTML = html;
  document.getElementById('voucher-notes').value = '';
  var voidBtn = document.getElementById('voidInvoiceBtn');
  if (voidBtn) voidBtn.style.display = isPaid ? 'none' : 'inline-flex';
  openModal('modalVoucher');
}

function voidCurrentInvoice() {
  if (!currentVoucherData) { toast('No invoice selected.'); return; }
  var txn = currentVoucherData;
  if (!txn.id) { toast('Cannot void \u2014 invoice ID not found.'); return; }
  var d = getData();
  var inv = d.rentLedger.find(function(r){ return r.id === txn.id; });
  if (!inv) { toast('Invoice not found \u2014 it may already be voided.'); return; }
  if (finIsVoided(inv)) { toast('Invoice is already voided.'); return; }
  var hasPayments = txn.payments && txn.payments.length > 0;
  showVoidModal({
    label: 'Void Invoice',
    preview: escapeHtml(txn.desc || '') + ' &nbsp;&middot;&nbsp; ' + fmt(txn.charge)
      + (hasPayments ? ' &nbsp;<span style="color:var(--danger);">&#9888; This invoice has payments applied.</span>' : '')
  }, function(reason) {
    voidLedgerEntry('rentLedger', txn.id, reason);
    if (typeof closeModal === 'function') closeModal('modalVoucher');
    renderDashboard();
    if (document.getElementById('page-rent') && document.getElementById('page-rent').classList.contains('on')) renderRentLedger();
    setTimeout(function(){ toast('Invoice voided. Reversal credit posted to ledger.'); }, 300);
  });
}

// ── Invoice form (save / GL / autofill) ───────────────────────────────────
// Legacy openEditTenant / saveEditTenant removed in Phase F3 — both now
// live in the unified Tenant form block earlier in this file. openEditTenant
// is re-declared there; saveEditTenant no longer exists because saveTenant()
// handles both new and edit modes.

var GL_ACCOUNTS = {
  'rent':           {code:'4100', name:'Rent Revenue',              ledger:'rent',        type:'invoice'},
  'service':        {code:'4200', name:'Service / Admin Fee',       ledger:'rent',        type:'service'},
  // Charge-back for tenant-caused damage/vandalism. Posts to the rent ledger
  // like service/utility (type falls through to entry_type adjustment_debit in
  // _rentLedgerToRow, so it round-trips); the GL code rides the ref + desc.
  'vandalism':      {code:'4250', name:'Damage / Vandalism Recovery', ledger:'rent',      type:'vandalism'},
  'loan-principal': {code:'1220', name:'Loan Receivable',           ledger:'loans',       type:'loan-charge'},
  'loan-interest':  {code:'4300', name:'Interest Revenue',          ledger:'loans',       type:'loan-interest'},
  'arrangement':    {code:'1210', name:'Arrangement Receivable',    ledger:'arrangement', type:'arr-charge'},
  'utility-hydro':  {code:'4400', name:'Hydro / Utility Revenue',   ledger:'rent',        type:'utility'},
  'utility-gas':    {code:'4410', name:'Gas / Heating Revenue',     ledger:'rent',        type:'utility'},
  // type was 'journal', which _rentLedgerToRow deliberately skips (real
  // journal entries live in finance_journal) — so GL-9000 charges displayed,
  // altered the balance, then VANISHED on reload (never persisted). As an
  // 'adjustment' they map to entry_type 'adjustment_debit' (allowed by the
  // ledger CHECK constraint) and round-trip like every other charge.
  'other':          {code:'9000', name:'General / Journal Entry',   ledger:'rent',        type:'adjustment'},
};

function autoFillInvoice() {
  var tid = (document.getElementById('inv-tenant')||{}).value;
  if (!tid) return;
  var t = getTenant(tid);
  if (!t) return;
  var now = new Date();
  var months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  var monthEl = document.getElementById('inv-month');
  var yearEl  = document.getElementById('inv-year');
  if (monthEl) monthEl.value = months[now.getMonth()];
  if (yearEl)  yearEl.value  = now.getFullYear();
  var dueEl = document.getElementById('inv-due');
  if (dueEl) dueEl.value = now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0')+'-01';
  var delEl = document.getElementById('inv-delivery');
  if (delEl) delEl.value = t.invPref==='email' ? 'email' : 'print';
  // Populate loan selector
  var d = getData();
  var loanSel = document.getElementById('inv-loan-select');
  if (loanSel) {
    var loans = d.loanList.filter(function(l){return l.tenantId===tid&&l.status==='approved';});
    loanSel.innerHTML = loans.map(function(l){
      var lbl = {renovation:'Renovation','rent-to-own':'Rent-to-Own',utilities:'Utilities',other:'Loan'}[l.type]||'Loan';
      return '<option value="'+l.id+'">'+lbl+' \u2014 '+fmt(l.principal)+'</option>';
    }).join('') || '<option value="">No active loans</option>';
  }
  // Populate arrangement selector
  var arrSel = document.getElementById('inv-arr-select');
  if (arrSel) {
    var arrs = d.arrangements.filter(function(a){return a.tenantId===tid&&a.status==='approved';});
    arrSel.innerHTML = arrs.map(function(a){
      return '<option value="'+a.id+'">'+a.ref+' \u2014 '+fmt(a.totalOwing)+'</option>';
    }).join('') || '<option value="">No active arrangements</option>';
  }
  onInvGLChange();
}

function onInvGLChange() {
  var gl = (document.getElementById('inv-gl')||{}).value||'rent';
  var tid = (document.getElementById('inv-tenant')||{}).value;
  var glInfo = GL_ACCOUNTS[gl];
  var t = getTenant(tid);
  var d = getData();

  // Show/hide loan and arrangement rows
  var loanRow = document.getElementById('inv-loan-row');
  var arrRow  = document.getElementById('inv-arr-row');
  if (loanRow) loanRow.style.display = (gl==='loan-principal'||gl==='loan-interest') ? 'block' : 'none';
  if (arrRow)  arrRow.style.display  = gl==='arrangement' ? 'block' : 'none';

  // Auto-fill amount and description
  var amtEl  = document.getElementById('inv-amount');
  var descEl = document.getElementById('inv-desc');
  var month  = (document.getElementById('inv-month')||{}).value||'';
  var year   = (document.getElementById('inv-year')||{}).value||'';

  if (gl === 'rent' && t) {
    if (amtEl && !amtEl.value) amtEl.value = t.rent ? t.rent.toFixed(2) : '';
    if (descEl) descEl.value = month+' '+year+' Rent \u2014 '+t.unit;
  } else if (gl === 'loan-interest') {
    var loanId = (document.getElementById('inv-loan-select')||{}).value;
    var loan = d.loanList.find(function(l){return l.id===loanId;});
    if (loan && amtEl && !amtEl.value) {
      var intAmt = loan.rateType==='none' ? 0 : Math.round(loan.principal*(loan.rate/100/12)*100)/100;
      amtEl.value = intAmt.toFixed(2);
    }
    if (descEl) descEl.value = month+' '+year+' Loan Interest'+(t?' \u2014 '+tenantName(t):'');
  } else if (gl === 'loan-principal') {
    var loanId2 = (document.getElementById('inv-loan-select')||{}).value;
    var loan2 = d.loanList.find(function(l){return l.id===loanId2;});
    if (loan2 && amtEl && !amtEl.value) amtEl.value = loan2.payment.toFixed(2);
    if (descEl) descEl.value = month+' '+year+' Loan Payment Due'+(t?' \u2014 '+tenantName(t):'');
  } else if (gl === 'arrangement') {
    var arrId = (document.getElementById('inv-arr-select')||{}).value;
    var arr = d.arrangements.find(function(a){return a.id===arrId;});
    if (arr && amtEl && !amtEl.value) amtEl.value = arr.monthlyPayment.toFixed(2);
    if (descEl) descEl.value = month+' '+year+' Arrangement Payment'+(arr?' \u2014 '+arr.ref:'');
  } else if (gl === 'service') {
    if (descEl) descEl.value = 'Service Charge'+(t?' \u2014 '+tenantName(t):'');
  } else if (gl === 'vandalism') {
    if (descEl) descEl.value = 'Unit Vandalism / Damage'+(t&&t.unit?' \u2014 '+t.unit:(t?' \u2014 '+tenantName(t):''));
  } else if (gl === 'utility-hydro') {
    if (descEl) descEl.value = month+' '+year+' Hydro Charge'+(t?' \u2014 '+t.unit:'');
  } else if (gl === 'utility-gas') {
    if (descEl) descEl.value = month+' '+year+' Gas Charge'+(t?' \u2014 '+t.unit:'');
  }

  // GL info box
  var infoEl = document.getElementById('inv-gl-info');
  if (infoEl && glInfo) {
    infoEl.innerHTML = '<strong>GL '+glInfo.code+' \u2014 '+glInfo.name+'</strong><br>'+
      '<span style="color:var(--muted);">'+
      (gl==='rent'?'Posts to rent ledger. Appears in Period Summary and Reconciliation reports as Rent Revenue.':
       gl==='service'?'Service or admin fee. Posts to rent ledger under Service GL. Separate line in reports.':
       gl==='vandalism'?'Charge-back for tenant-caused damage or vandalism. Posts to the rent ledger under the Damage/Vandalism GL (4250). Shows as a separate line in reports.':
       gl==='loan-principal'?'Posts charge against the selected loan. Reduces loan outstanding balance when paid.':
       gl==='loan-interest'?'Interest charge posts to Interest Revenue GL (4300). Reported separately from principal.':
       gl==='arrangement'?'Posts against the selected payment arrangement ledger.':
       gl==='utility-hydro'||gl==='utility-gas'?'Utility charge. Posts to rent ledger under utility GL code.':
       'General journal entry. Use for adjustments, corrections, or miscellaneous charges.')+
      '</span>';
  }
}

function saveInvoice() {
  var tid    = (document.getElementById('inv-tenant')||{}).value;
  var gl     = (document.getElementById('inv-gl')||{}).value||'rent';
  var month  = (document.getElementById('inv-month')||{}).value;
  var year   = (document.getElementById('inv-year')||{}).value;
  var amount = parseFloat((document.getElementById('inv-amount')||{}).value)||0;
  var desc   = (document.getElementById('inv-desc')||{}).value||'';
  var notes  = (document.getElementById('inv-notes')||{}).value||'';
  var loanId = (document.getElementById('inv-loan-select')||{}).value;
  var arrId  = (document.getElementById('inv-arr-select')||{}).value;
  if (!tid)    { toast('Please select a tenant.'); return; }
  if (!amount) { toast('Please enter an amount.'); return; }

  var glInfo = GL_ACCOUNTS[gl];
  var monthNum = ['January','February','March','April','May','June','July','August','September','October','November','December'].indexOf(month)+1;
  var dateStr  = year+'-'+String(monthNum).padStart(2,'0')+'-01';
  var ref = glInfo.code+'-'+year+String(monthNum).padStart(2,'0')+'-'+tid.slice(-4).toUpperCase();
  var d = getData();
  var t = getTenant(tid);

  // Check duplicate for rent invoices
  if (gl==='rent') {
    var exists = d.rentLedger.some(function(r){
      return r.tenantId===tid&&r.type==='invoice'&&r.date.slice(0,7)===dateStr.slice(0,7)&&r.status!=='reversed';
    });
    if (exists && !confirm('A rent invoice already exists for '+month+' '+year+'. Create another?')) return;
  }

  var finalDesc = desc || (month+' '+year+' \u2014 '+(glInfo.name));
  if (notes) finalDesc += ' ('+notes+')';

  var entry = {
    id:uid(), tenantId:tid, date:dateStr,
    desc:finalDesc, charge:amount, payment:0,
    type:glInfo.type, gl:gl, glCode:glInfo.code,
    method:'', status:'approved', ref:ref,
    loanId:(gl==='loan-principal'||gl==='loan-interest')?loanId:null,
    arrId:gl==='arrangement'?arrId:null,
  };

  d.rentLedger.push(entry);
  // Real finance_audit_log row \u2014 the old d.auditLog array was never persisted,
  // so invoice/charge postings left no audit trail at all.
  writeAuditEntry({action:'post_charge',entity_type:'charge',entity_id:entry.id,
    summary:'Charge posted GL'+glInfo.code+': '+(t?tenantName(t):tid)+' \u2014 '+finalDesc+' \u2014 '+fmt(amount),
    detail:{after:entry}});
  saveData(d);
  closeModal('modalNewInvoice');
  renderDashboard();
  if (_stmtTid) renderStatementEntries();
  if (document.getElementById('page-tenants').classList.contains('on')) renderTenantProfile(tid);
  // Show voucher
  openInvoiceVoucher({date:dateStr,tenantId:tid,ledger:gl,desc:finalDesc,
    charge:amount,payment:0,method:'',status:'unpaid',id:entry.id,ref:ref,
    invoiceBalance:amount,payments:[], glCode:glInfo.code, glName:glInfo.name});
}



function openInvoiceForTenant(id){
  openModal('modalNewInvoice');
  setTimeout(function(){
    var s=document.getElementById('inv-tenant');if(s)s.value=id;
    autoFillInvoice();
  },60);
}
function openPaymentForTenant(id){
  openModal('modalRentPayment');
  setTimeout(function(){
    var s=document.getElementById('rp-tenant');
    if(s){ s.value=id; loadUnifiedPaymentContext(); }
  },80);
}

