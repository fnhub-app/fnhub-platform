// ── ADD TENANT ──────────────────────────────────────────────────────────────
// Handles both active tenants (with a current housing unit) and former
// tenants (moved out but still owe money — need statements/collections).
// Unit is optional. If an opening balance is entered, a seed rent_ledger
// row is created with entry_type='opening_balance' so subsequent ledger
// math Just Works.
// ── Unified Tenant form handlers ─────────────────────────────────────────
// saveTenant() handles BOTH new and edit modes. Mode is read from the
// modalTenantForm dataset. Single id prefix: tf-*. Legacy openEditTenant /
// saveEditTenant remain as thin wrappers that delegate here.

function _tfVal(id) {
  var el = document.getElementById(id);
  return el ? (el.value || '').trim() : '';
}
function _tfChecked(id) {
  var el = document.getElementById(id);
  return !!(el && el.checked);
}

function _tfToggleAutopayType() {
  var row = document.getElementById('tf-autopay-type-row');
  var cb  = document.getElementById('tf-autopay');
  if (row) row.style.display = (cb && cb.checked) ? 'block' : 'none';
}

function _tfResetFields() {
  // Clear every field in the form. Called at the top of openAddTenant.
  ['tf-first','tf-last','tf-dob','tf-band','tf-phone','tf-email',
   'tf-unit','tf-street','tf-community','tf-province','tf-postal','tf-mailing',
   'tf-rent','tf-open-bal','tf-hydro','tf-gas','tf-notes','tf-edit-name',
  ].forEach(function(id){ var el=document.getElementById(id); if(el) el.value=''; });
  ['tf-marital','tf-status','tf-type','tf-invpref','tf-autopay-type'
  ].forEach(function(id){ var el=document.getElementById(id); if(el) el.selectedIndex=0; });
  var ap = document.getElementById('tf-autopay'); if (ap) ap.checked = false;
  var hc = document.getElementById('tf-homecare'); if (hc) hc.checked = false;
  _tfToggleAutopayType();
  // Defaults that differ from empty string:
  var comm = document.getElementById('tf-community');
  if (comm) comm.value = (window.NATION_CONFIG && window.NATION_CONFIG.display_name) || '';
  var prov = document.getElementById('tf-province');
  if (prov) prov.value = 'Ontario';
}

function openAddTenant() {
  var modal = document.getElementById('modalTenantForm');
  if (!modal) return;
  modal.dataset.mode = 'new';
  modal.dataset.tid  = '';
  var title    = document.getElementById('tf-title');
  var subtitle = document.getElementById('tf-subtitle');
  var submit   = document.getElementById('tf-submit');
  var hdr      = document.getElementById('tf-edit-header');
  var openBal  = document.getElementById('tf-open-bal-row');
  if (title)    title.textContent = 'Add Tenant Account';
  if (subtitle) subtitle.textContent = 'Create a new tenant record. Phone and email sync to the Housing App.';
  if (submit)   submit.textContent = 'Add Tenant';
  if (hdr)      hdr.style.display = 'none';
  if (openBal)  openBal.style.display = '';
  _tfResetFields();
  openModal('modalTenantForm');
}

function openEditTenant(tid) {
  var t = getTenant(tid);
  if (!t) { toast('Tenant not found.'); return; }
  var modal = document.getElementById('modalTenantForm');
  if (!modal) return;
  modal.dataset.mode = 'edit';
  modal.dataset.tid  = tid;
  var title    = document.getElementById('tf-title');
  var subtitle = document.getElementById('tf-subtitle');
  var submit   = document.getElementById('tf-submit');
  var hdr      = document.getElementById('tf-edit-header');
  var openBal  = document.getElementById('tf-open-bal-row');
  if (title)    title.textContent = 'Edit Tenant Record';
  if (subtitle) subtitle.textContent = 'All tenant fields are editable here. Phone and email are synced to the Housing App.';
  if (submit)   submit.textContent = 'Save Changes';
  if (hdr)      hdr.style.display = '';
  if (openBal)  openBal.style.display = 'none';  // opening balance is new-only

  // Prefill all fields
  var set = function(id, val){ var el=document.getElementById(id); if(el) el.value = (val==null?'':val); };
  set('tf-edit-name', tenantName(t) + (t.unit ? ' — ' + t.unit : ''));
  set('tf-first',     t.first);
  set('tf-last',      t.last);
  set('tf-dob',       t.dob);
  set('tf-band',      t.bandNumber);
  set('tf-marital',   t.marital);
  set('tf-status',    t.status || (t.active===false ? 'former' : 'active'));
  set('tf-phone',     t.phone);
  set('tf-email',     t.email);
  set('tf-unit',      t.unit);
  set('tf-street',    t.street);
  set('tf-community', t.community || (window.NATION_CONFIG && window.NATION_CONFIG.display_name) || '');
  set('tf-province',  t.province  || 'Ontario');
  set('tf-postal',    t.postalCode);
  set('tf-mailing',   t.mailingAddress);
  set('tf-type',      t.type || 'community');
  set('tf-contact',   t.contact || '');
  set('tf-rent',      (t.rent != null ? t.rent : ''));
  set('tf-invpref',   t.invPref || 'email');
  set('tf-hydro',     t.hydroAcct);
  set('tf-gas',       t.gasAcct);
  set('tf-notes',     t.notes);

  var ap = document.getElementById('tf-autopay');
  if (ap) ap.checked = !!t.autoPay;
  var hc = document.getElementById('tf-homecare');
  if (hc) hc.checked = !!t.homeCare;
  set('tf-autopay-type', t.autoPayType || 'eft');
  _tfToggleAutopayType();

  openModal('modalTenantForm');
}

function saveTenant() {
  var modal = document.getElementById('modalTenantForm');
  if (!modal) return;
  var mode  = modal.dataset.mode || 'new';

  // Harvest fields (both modes read from tf-*)
  var first   = _tfVal('tf-first');
  var last    = _tfVal('tf-last');
  var dob     = _tfVal('tf-dob');
  var band    = _tfVal('tf-band');
  var marital = _tfVal('tf-marital');
  var status  = _tfVal('tf-status') || 'active';
  var phone   = _tfVal('tf-phone');
  var email   = _tfVal('tf-email');
  var unit    = _tfVal('tf-unit');
  var street  = _tfVal('tf-street');
  var community = _tfVal('tf-community');
  var province  = _tfVal('tf-province');
  var postal    = _tfVal('tf-postal');
  var mailing   = _tfVal('tf-mailing');
  var type    = _tfVal('tf-type') || 'community';
  var contact = _tfVal('tf-contact');
  var rent    = parseFloat(_tfVal('tf-rent')) || 0;
  var invPref = _tfVal('tf-invpref') || 'email';
  var hydroA  = _tfVal('tf-hydro');
  var gasA    = _tfVal('tf-gas');
  var autoPay = _tfChecked('tf-autopay');
  var autoPayType = autoPay ? (_tfVal('tf-autopay-type') || 'eft') : null;
  var homeCare = _tfChecked('tf-homecare');
  var notes   = _tfVal('tf-notes');

  if (!first || !last) { toast('First and last name are required.'); return; }
  if (status === 'active' && !unit) {
    toast('Unit required for an active tenant. Pick Former if they no longer have a unit.');
    return;
  }

  var d = getData();
  var unitId = unit ? (typeof _resolveUnitId === 'function' ? _resolveUnitId(unit) : null) : null;

  if (mode === 'edit') {
    var tid = modal.dataset.tid;
    if (!tid) { toast('Missing tenant id.'); return; }
    var t = d.tenants.find(function(x){ return x.id === tid; });
    if (!t) { toast('Tenant not found.'); return; }
    var before = JSON.parse(JSON.stringify(t));

    t.first = first; t.last = last;
    t.dob = dob; t.bandNumber = band; t.marital = marital;
    t.phone = phone; t.email = email;
    t.unit = unit; t.street = street; t.community = community;
    t.province = province; t.postalCode = postal; t.mailingAddress = mailing;
    t.type = type; t.contact = contact; t.rent = rent; t.invPref = invPref;
    t.hydroAcct = hydroA; t.gasAcct = gasA;
    t.autoPay = autoPay; t.autoPayType = autoPayType;
    t.homeCare = homeCare;
    t.notes = notes;
    t.status = status;
    t.currentUnitId = unitId;
    t.active = (status === 'active');

    saveData(d);
    writeAuditEntry({
      action: 'update_tenant', entity_type: 'tenant',
      entity_id: tid, tenant_id: tid,
      summary: 'Updated tenant record: ' + tenantName(t),
      detail: { before: before, after: t }
    });
    closeModal('modalTenantForm');
    selectTenantProfile(tid);
    toast('Tenant record saved.');
    return;
  }

  // ── New-tenant path ──
  var openBal = parseFloat(_tfVal('tf-open-bal')) || 0;
  var newTenant = {
    id: uid(),
    first: first, last: last,
    dob: dob, bandNumber: band, marital: marital,
    phone: phone, email: email,
    unit: unit, street: street, community: community,
    province: province, postalCode: postal, mailingAddress: mailing,
    type: type, contact: contact, rent: rent, invPref: invPref,
    hydroAcct: hydroA, gasAcct: gasA,
    autoPay: autoPay, autoPayType: autoPayType,
    homeCare: homeCare,
    notes: notes,
    status: status,
    currentUnitId: unitId,
    active: (status === 'active')
  };
  d.tenants.push(newTenant);

  // Seed ledger row for opening balance (only on new)
  if (openBal > 0) {
    d.rentLedger = d.rentLedger || [];
    d.rentLedger.push({
      id: uid(),
      tenantId: newTenant.id,
      unitId: null,
      date: today(),
      desc: 'Opening balance at account creation',
      charge: openBal, payment: 0,
      type: 'opening',
      method: '', status: 'posted', ref: ''
    });
  }

  saveData(d);
  writeAuditEntry({
    action: 'create_tenant', entity_type: 'tenant',
    entity_id: newTenant.id, tenant_id: newTenant.id,
    summary: 'Added ' + (status === 'former' ? 'former' : status === 'deceased' ? 'deceased' : 'active') +
             ' tenant ' + tenantName(newTenant) +
             (unit ? ' (' + unit + ')' : '') +
             (openBal > 0 ? ' with opening balance $' + openBal.toFixed(2) : ''),
    detail: { unit: unit, status: status, openingBalance: openBal }
  });

  closeModal('modalTenantForm');
  renderDashboard();
  selectTenantProfile(newTenant.id);
  showPage('tenants');
  toast('Tenant added.');
}

// \u2500\u2500 COLLECTIONS FLAG \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function fillCollectionsAmount() {
  var tid = (document.getElementById('col-tenant')||{}).value;
  if (!tid) return;
  var d = getData(); var totals = calcAllTotals(d); var v = totals[tid]||{};
  var grand = Math.max(0,(v.rent||0)) + Math.max(0,(v.arrangement||0));
  var amtEl = document.getElementById('col-amount');
  if (amtEl) amtEl.value = grand > 0 ? grand.toFixed(2) : '';
}

function saveCollectionsFlag() {
  var tid    = (document.getElementById('col-tenant')||{}).value;
  var amount = parseFloat((document.getElementById('col-amount')||{}).value)||0;
  var agency = (document.getElementById('col-agency')||{}).value||'';
  var notes  = (document.getElementById('col-notes')||{}).value||'';
  if (!tid)    { toast('Please select a tenant.'); return; }
  if (!amount) { toast('Please enter the amount at referral.'); return; }
  var d = getData();
  d.collections = d.collections||[];
  // Keep-open: on a re-save of the same open form, UPDATE the entry created a
  // moment ago instead of pushing a duplicate collections flag.
  var _cfModal = document.getElementById('modalFlagCollections');
  var _cfEditId = (_cfModal && _cfModal.dataset && _cfModal.dataset.savedEntryId) || '';
  var _cfPrev = _cfEditId ? d.collections.find(function(c){ return c.id === _cfEditId; }) : null;
  var entry = {id: _cfEditId || uid(), tenantId:tid,
    dateFlagged: _cfPrev ? _cfPrev.dateFlagged : today(), amountAtReferral:amount,
    agency:agency, notes:notes, status: _cfPrev ? _cfPrev.status : 'approved'};
  if (_cfPrev) { d.collections[d.collections.indexOf(_cfPrev)] = entry; }
  else { d.collections.push(entry); }
  writeAuditEntry({action:'flag_collections',entity_type:'collection',entity_id:entry.id,
    summary:'Collections flag: '+(getTenant(tid)?tenantName(getTenant(tid)):tid)+' \u2014 '+fmt(amount),
    detail:{after:entry}});
  saveData(d);
  if (_cfModal && _cfModal.dataset) _cfModal.dataset.savedEntryId = entry.id;
  renderDashboard();
  renderCollections();
  if (document.getElementById('page-tenants').classList.contains('on')) renderTenantProfile(tid);
  toast('Collections flag saved.');
}

// \u2500\u2500 ARRANGEMENT MODAL \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function loadArrangementsForTenant() {
  var tid = (document.getElementById('ap-tenant')||{}).value;
  var sel = document.getElementById('ap-arr-select');
  if (!sel) return;
  if (!tid) { sel.innerHTML = '<option value="">\u2014 select tenant first \u2014</option>'; return; }
  var d = getData();
  var arrs = d.arrangements.filter(function(a){return a.tenantId===tid&&a.status==='approved';});
  sel.innerHTML = '<option value="">\u2014 select arrangement \u2014</option>'+
    arrs.map(function(a){return '<option value="'+a.id+'">'+a.ref+' ('+fmt(a.totalOwing)+')</option>';}).join('');
}

function loadArrDetails() {
  var arrId = (document.getElementById('ap-arr-select')||{}).value;
  if (!arrId) return;
  var d = getData();
  var a = d.arrangements.find(function(x){return x.id===arrId;});
  if (!a) return;
  var paid = d.arrPayments.filter(function(p){return p.arrId===arrId&&p.status!=='reversed';}).reduce(function(s,p){return s+p.amount;},0);
  var rem = Math.max(0, a.totalOwing-paid);
  var detailEl = document.getElementById('ap-arr-detail');
  if (detailEl) detailEl.innerHTML =
    '<div style="background:var(--bg);border-radius:8px;padding:10px 12px;font-size:12px;">'+
    'Monthly: <strong>'+fmt(a.monthlyPayment)+'</strong> &nbsp;\u00B7&nbsp; '+
    'Remaining: <strong style="color:'+(rem>0?'var(--danger)':'var(--success)')+';">'+fmt(rem)+'</strong> &nbsp;\u00B7&nbsp; '+
    'Ref: '+a.ref+'</div>';
  var amtEl = document.getElementById('ap-amount');
  if (amtEl) amtEl.value = a.monthlyPayment.toFixed(2);
}

function saveArrangement() {
  var tid          = (document.getElementById('na-tenant')||{}).value||'';
  var totalOwing   = parseFloat((document.getElementById('na-total')||{}).value)||0;
  var payment      = parseFloat((document.getElementById('na-monthly')||{}).value)||0;
  var freq         = (document.getElementById('na-freq')||{}).value||'monthly';
  var ledger       = (document.getElementById('na-ledger')||{}).value||'rent';
  var startDate    = (document.getElementById('na-start')||{}).value||today();
  var firstPayDate = (document.getElementById('na-first-payment')||{}).value||startDate;
  var notes        = (document.getElementById('na-notes')||{}).value||'';
  var refInput     = ((document.getElementById('na-ref')||{}).value||'').trim();
  var errEl        = document.getElementById('na-error');

  if (!tid)       { if(errEl){errEl.textContent='Please select a tenant.';errEl.style.display='block';} return; }
  if (!totalOwing){ if(errEl){errEl.textContent='Total amount owing is required.';errEl.style.display='block';} return; }
  if (!payment)   { if(errEl){errEl.textContent='Payment amount is required.';errEl.style.display='block';} return; }
  if (errEl) errEl.style.display='none';

  var ppy     = {monthly:12, semimonthly:24, biweekly:26, weekly:52}[freq]||12;
  var periods = Math.ceil(totalOwing / payment);
  var months  = Math.ceil(periods / ppy * 12);

  var d   = getData();
  var t   = getTenant(tid);
  var ref = refInput || ('ARR-'+new Date().getFullYear()+'-'+String((d.arrangements||[]).length+1).padStart(3,'0'));

  var entry = {
    id:uid(), tenantId:tid, ref:ref,
    totalOwing:totalOwing, monthlyPayment:payment,
    freq:freq, ledger:ledger,
    startDate:startDate, firstPaymentDate:firstPayDate,
    notes:notes, term:months, periods:periods,
    status:'pending-ed',
    submittedBy:CURRENT_USER, submittedAt:new Date().toISOString()
  };
  d.arrangements = d.arrangements||[];
  d.arrangements.push(entry);
  auditLog('create','arrangement',entry.id,
    'Arrangement submitted: '+(t?tenantName(t):tid)+' \u2014 '+fmt(totalOwing)+' over '+months+' months',
    null,entry);
  saveData(d);
  closeModal('modalNewArrangement');
  renderDashboard();
  if (_stmtTid) renderStatementEntries();
  if (document.getElementById('page-tenants').classList.contains('on')) renderTenantProfile(tid);
  previewArrangementAgreement(entry);
}

function saveArrPayment() {
  var tid   = (document.getElementById('ap-tenant')||{}).value;
  var arrId = (document.getElementById('ap-arr-select')||{}).value;
  var date  = (document.getElementById('ap-date')||{}).value;
  var amt   = parseFloat((document.getElementById('ap-amount')||{}).value)||0;
  var method= (document.getElementById('ap-method')||{}).value||'cash';
  var type  = (document.getElementById('ap-type')||{}).value||'regular';
  var notes = (document.getElementById('ap-notes')||{}).value||'';
  if (!tid)   { toast('Please select a tenant.'); return; }
  if (!arrId) { toast('Please select an arrangement.'); return; }
  if (!amt)   { toast('Amount required.'); return; }
  if (!date)  { toast('Date required.'); return; }
  var doSave = function(cashTotal, denoms, receivedBy) {
    var finalAmt = cashTotal||amt;
    var d = getData(); var t = getTenant(tid);
    var a = d.arrangements.find(function(x){return x.id===arrId;});
    var entry = {id:uid(),arrId:arrId,tenantId:tid,date:date,amount:finalAmt,
      method:method,type:type,ref:'',notes:notes};
    if (denoms) { entry.denominations=denoms; entry.receivedBy=receivedBy; }
    d.arrPayments.push(entry);
    writeAuditEntry({action:'post_arr_payment',entity_type:'arrPayment',entity_id:entry.id,
      summary:'Arrangement payment: '+(t?tenantName(t):tid)+' \u2014 '+fmt(finalAmt),detail:{after:entry}});
    saveData(d);
    closeModal('modalArrPayment');
    renderDashboard();
    if (_stmtTid) renderStatementEntries();
    if (document.getElementById('page-tenants').classList.contains('on')) renderTenantProfile(tid);
    generateVoucherFor({date:date,tenantId:tid,ledger:'arrangement',
      desc:'Arrangement Payment'+(a?' \u2014 '+a.ref:''),charge:0,payment:finalAmt,
      method:method,status:'posted',id:entry.id,denominations:denoms||null});
  };
  if (method==='cash') { closeModal('modalArrPayment'); setTimeout(function(){openCashDenom(amt,doSave);},150); }
  else doSave(null,null,null);
}

// \u2500\u2500 LOAN PAYMENT MODAL \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function loadLoansForTenant() {
  var tid = (document.getElementById('lpay-tenant-select')||{}).value;
  var sel = document.getElementById('lpay-loan-select');
  if (!sel) return;
  if (!tid) { sel.innerHTML = '<option value="">\u2014 select tenant first \u2014</option>'; return; }
  var d = getData();
  var loans = d.loanList.filter(function(l){return l.tenantId===tid&&l.status==='approved';});
  sel.innerHTML = '<option value="">\u2014 select loan \u2014</option>'+
    loans.map(function(l){
      var typeLabel={renovation:'Renovation','rent-to-own':'Rent-to-Own',utilities:'Utilities',other:'Loan'}[l.type]||'Loan';
      return '<option value="'+l.id+'">'+typeLabel+' \u2014 '+fmt(l.principal)+'</option>';
    }).join('');
  var amtEl = document.getElementById('lpay-amount');
  if (amtEl && loans[0]) amtEl.value = loans[0].payment.toFixed(2);
}

function saveLoan() {
  var tid       = (document.getElementById('ln-tenant')||{}).value||'';
  var loanType  = (document.getElementById('ln-type')||{}).value||'other';
  var rateType  = (document.getElementById('ln-rate-type')||{}).value||'none';
  var rate      = rateType==='none' ? 0 : (parseFloat((document.getElementById('ln-rate')||{}).value)||0);
  var principal = parseFloat((document.getElementById('ln-principal')||{}).value)||0;
  var term      = parseInt((document.getElementById('ln-term')||{}).value)||0;
  var freq      = (document.getElementById('ln-freq')||{}).value||'monthly';
  var start     = (document.getElementById('ln-start')||{}).value||today();
  var notes     = ((document.getElementById('ln-notes')||{}).value||'').trim();
  var payment   = parseFloat((document.getElementById('ln-payment')||{}).value)||0;

  if (!tid)       { toast('Please select a tenant.'); return; }
  if (!principal) { toast('Please enter the loan principal.'); return; }
  if (!term)      { toast('Please enter the term or payment to calculate the term.'); return; }
  if (!notes)     { toast('Please enter the loan purpose.'); return; }

  if (!payment) payment = calcPaymentAmt(principal, rate, term, freq);
  var periods      = termToPeriods(term, freq);
  var totalRepay   = Math.round(payment * periods * 100) / 100;
  var totalInterest= Math.max(0, Math.round((totalRepay - principal) * 100) / 100);

  var advanceDate      = (document.getElementById('ln-advance')||{}).value || start;
  var firstPaymentDate = (document.getElementById('ln-first-payment')||{}).value || start;

  var d = getData();
  var t = getTenant(tid);
  var loan = {
    id: uid(), tenantId: tid,
    type: loanType, rateType: rateType, rate: rate,
    principal: principal, term: term, freq: freq,
    start: start, advanceDate: advanceDate, firstPaymentDate: firstPaymentDate,
    notes: notes,
    payment: payment, totalInterest: totalInterest, totalRepay: totalRepay,
    status: (_currentRole==='finance_clerk'||_currentRole==='housing_staff') ? 'draft' : 'pending-ed',
    submittedBy: CURRENT_USER, submittedAt: new Date().toISOString()
  };
  d.loanList = d.loanList || [];
  d.loanList.push(loan);
  auditLog('create', 'loan', loan.id,
    'Loan submitted for ED approval: ' + (t?tenantName(t):tid) + ' \u2014 $' + principal.toFixed(2) + ' over ' + fmtTermLabel(term),
    null, loan);
  saveData(d);
  renderDashboard();
  if (_stmtTid) renderStatementEntries();
  // Open the loan agreement immediately
  closeModal('modalNewLoan');
  previewLoanAgreement(null);
}

function saveLoanPayment() {
  var tid    = (document.getElementById('lpay-tenant-select')||{}).value;
  var loanId = (document.getElementById('lpay-loan-select')||{}).value;
  var date   = (document.getElementById('lpay-date')||{}).value;
  var amt    = parseFloat((document.getElementById('lpay-amount')||{}).value)||0;
  var method = (document.getElementById('lpay-method')||{}).value||'cash';
  var notes  = (document.getElementById('lpay-notes')||{}).value||'';
  if (!tid)    { toast('Please select a tenant.'); return; }
  if (!loanId) { toast('Please select a loan.'); return; }
  if (!amt)    { toast('Amount required.'); return; }
  if (!date)   { toast('Date required.'); return; }
  var doSave = function(cashTotal, denoms, receivedBy) {
    var finalAmt = cashTotal||amt;
    var d = getData(); var t = getTenant(tid);
    var l = d.loanList.find(function(x){return x.id===loanId;});
    var entry = {id:uid(),loanId:loanId,tenantId:tid,date:date,amount:finalAmt,
      method:method,notes:notes,status:'posted'};
    if (denoms) { entry.denominations=denoms; entry.receivedBy=receivedBy; }
    d.loanPayments.push(entry);
    writeAuditEntry({action:'post_loan_payment',entity_type:'loanPayment',entity_id:entry.id,
      summary:'Loan payment: '+(t?tenantName(t):tid)+' \u2014 '+fmt(finalAmt),detail:{after:entry}});
    saveData(d);
    closeModal('modalLoanPayment');
    renderDashboard();
    if (_stmtTid) renderStatementEntries();
    if (document.getElementById('page-tenants').classList.contains('on')) renderTenantProfile(tid);
    generateVoucherFor({date:date,tenantId:tid,ledger:'loans',
      desc:'Loan Payment'+(l?' \u2014 '+l.type:''),charge:0,payment:finalAmt,
      method:method,status:'posted',id:entry.id,denominations:denoms||null});
  };
  if (method==='cash') { closeModal('modalLoanPayment'); setTimeout(function(){openCashDenom(amt,doSave);},150); }
  else doSave(null,null,null);
}

// \u2500\u2500 ED APPROVALS \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function hmRecommendLoan(loanId) {
  var d=getData(), ln=d.loanList.find(function(x){return x.id===loanId;});
  if(!ln) return;
  var notes=prompt('Recommendation notes for the ED:');
  if(!notes||!notes.trim()){toast('Notes required.');return;}
  var prev=ln.status;
  ln.status='pending-ed'; ln.hmRecommendedBy=CURRENT_USER;
  ln.hmRecommendedDate=today(); ln.hmNotes=notes.trim();
  auditLog('update','loan',loanId,'HM recommended: '+notes,{status:prev},{status:'pending-ed'});
  saveData(d); renderLoansPage();
  toast('Forwarded to Executive Director.');
}

function hmDeclineLoan(loanId) {
  var d=getData(), ln=d.loanList.find(function(x){return x.id===loanId;});
  if(!ln) return;
  var reason=prompt('Reason for declining:');
  if(!reason||!reason.trim()) return;
  var prev=ln.status;
  ln.status='declined'; ln.declinedBy=CURRENT_USER;
  ln.declinedDate=today(); ln.declineReason=reason.trim();
  auditLog('update','loan',loanId,'Declined: '+reason,{status:prev},{status:'declined'});
  saveData(d); renderLoansPage();
}

function approveLoan(loanId) {
  var d = getData();
  var l = d.loanList.find(function(x){ return x.id === loanId; });
  if (!l) return;
  var t = getTenant(l.tenantId);

  var approvalDate = today();
  var advanceDate  = l.advanceDate || l.start || approvalDate;
  var rate         = l.rate || 0;
  var rateType     = l.rateType || 'none';

  // Calculate days from advance to approval
  var advParts = advanceDate.split('-');
  var appParts = approvalDate.split('-');
  var advMs  = new Date(+advParts[0], +advParts[1]-1, +advParts[2]).getTime();
  var appMs  = new Date(+appParts[0], +appParts[1]-1, +appParts[2]).getTime();
  var daysToApproval = (!isNaN(advMs) && !isNaN(appMs)) ? Math.max(0, Math.round((appMs - advMs) / 86400000)) : 0;

  // Accrued interest from advance to approval date
  var retroInterest = 0;
  if (rateType !== 'none' && rate > 0 && daysToApproval > 0) {
    retroInterest = Math.round(l.principal * (rate / 100) * (daysToApproval / 365) * 100) / 100;
  }

  // Check if first payment date has already passed
  var firstPayDate  = l.firstPaymentDate || l.start || approvalDate;
  var fppParts = firstPayDate.split('-');
  var fppMs    = new Date(+fppParts[0], +fppParts[1]-1, +fppParts[2]).getTime();
  var firstPaymentOverdue = !isNaN(fppMs) && !isNaN(appMs) && fppMs < appMs;

  // Build confirmation message
  var msg = 'Approve loan for ' + (t ? tenantName(t) : 'tenant') + '?\n\n';
  msg += 'Principal: ' + fmt(l.principal) + '\n';
  msg += 'Advance Date: ' + advanceDate + '\n';
  msg += 'Approval Date: ' + approvalDate + '\n';
  if (daysToApproval > 0) {
    msg += 'Days since advance: ' + daysToApproval + ' days\n';
    if (retroInterest > 0) {
      msg += 'Accrued interest to date: ' + fmt(retroInterest) + ' (will be added to principal)\n';
    }
  }
  if (firstPaymentOverdue) {
    msg += '\n\u26a0 First payment date (' + firstPayDate + ') has already passed. A missed payment will be recorded.';
  }
  msg += '\n\nThis cannot be undone.';

  if (!confirm(msg)) return;

  // Record approval
  l.status       = 'approved';
  l.approvedBy   = CURRENT_USER;
  l.approvedDate = approvalDate;
  l.daysToApproval = daysToApproval;

  // Add retroactive interest as a journal entry if applicable
  if (retroInterest > 0) {
    l.retroInterest = retroInterest;
    l.adjustedPrincipal = Math.round((l.principal + retroInterest) * 100) / 100;
    // Post an interest charge to the rent ledger
    d.rentLedger = d.rentLedger || [];
    d.rentLedger.push({
      id: uid(), tenantId: l.tenantId, date: approvalDate,
      desc: 'Accrued interest: advance (' + advanceDate + ') to approval (' + approvalDate + ') \u2014 ' + daysToApproval + ' days @ ' + rate + '%',
      charge: retroInterest, payment: 0,
      type: 'loan-interest', gl: 'loan-interest', glCode: '4300',
      method: '', status: 'approved',
      ref: 'ACCRUAL-' + loanId.slice(-6).toUpperCase(),
      loanId: loanId
    });
  }

  // If first payment already overdue, post a missed payment notice
  if (firstPaymentOverdue) {
    d.rentLedger = d.rentLedger || [];
    d.rentLedger.push({
      id: uid(), tenantId: l.tenantId, date: approvalDate,
      desc: 'NOTICE: First payment due ' + firstPayDate + ' was overdue at time of loan approval',
      charge: 0, payment: 0,
      type: 'notice', gl: 'loan-principal', glCode: '1220',
      method: '', status: 'approved',
      ref: 'OVERDUE-' + loanId.slice(-6).toUpperCase(),
      loanId: loanId
    });
  }

  writeAuditEntry({
    action: 'approve_loan', entity_type: 'loan', entity_id: loanId,
    summary: 'Loan approved: ' + fmt(l.principal) +
      (retroInterest > 0 ? ' + ' + fmt(retroInterest) + ' accrued interest (' + daysToApproval + ' days)' : '') +
      (firstPaymentOverdue ? ' | First payment was overdue' : ''),
    detail: { before: {status: 'pending-ed'}, after: {status: 'approved', approvedDate: approvalDate} }
  });

  saveData(d);
  renderLoansPage();
  renderDashboard();
  toast('Loan approved.' +
    (retroInterest > 0 ? '\n\nAccrued interest of ' + fmt(retroInterest) + ' for ' + daysToApproval + ' days has been posted.' : '') +
    (firstPaymentOverdue ? '\n\nNote: First payment date has passed \u2014 please follow up with tenant.' : ''));
}

// \u2500\u2500 REVERSALS \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function openReversal(entryId, ledger) {
  var d = getData();
  var entry = d.rentLedger.find(function(r){ return r.id === entryId; });
  if (!entry) return;
  if (finIsVoided(entry)) { toast('Entry is already voided.'); return; }
  showVoidModal({
    label: 'Void Rent Entry',
    preview: escapeHtml(entry.desc || '') + ' &nbsp;&middot;&nbsp; ' + fmt(entry.charge || entry.payment) + ' &nbsp;&middot;&nbsp; ' + (entry.date || '')
  }, function(reason) {
    voidLedgerEntry('rentLedger', entryId, reason);
    renderRentLedger();
    renderDashboard();
  });
}

function saveReversal() { /* replaced by openReversal \u2192 showVoidModal flow */ }

function reverseLoanPayment(pmtId, loanId) {
  var d = getData();
  var p = d.loanPayments.find(function(x){ return x.id === pmtId; });
  if (!p) return;
  if (finIsVoided(p)) { toast('Payment is already voided.'); return; }
  showVoidModal({
    label: 'Void Loan Payment',
    preview: fmt(p.amount) + ' &nbsp;&middot;&nbsp; ' + (p.date || '')
  }, function(reason) {
    voidLedgerEntry('loanPayments', pmtId, reason);
    renderLoansPage();
    renderDashboard();
  });
}

