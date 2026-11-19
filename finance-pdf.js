function previewArrangementAgreement(arr) {
  try {
    // Accept arrangement object or read from form
    var fromForm = !arr;
    var tid      = arr ? arr.tenantId   : (document.getElementById('na-tenant')||{}).value||'';
    var t        = getTenant(tid);
    var total    = arr ? arr.totalOwing  : (parseFloat((document.getElementById('na-total')||{}).value)||0);
    var monthly  = arr ? arr.monthlyPayment : (parseFloat((document.getElementById('na-monthly')||{}).value)||0);
    var freq     = arr ? (arr.freq||'monthly') : ((document.getElementById('na-freq')||{}).value||'monthly');
    var firstPay = arr ? (arr.firstPaymentDate||arr.startDate||today()) : ((document.getElementById('na-first-payment')||{}).value||startDate);
    var ppy      = {monthly:12, semimonthly:24, biweekly:26, weekly:52}[freq]||12;
    var freqLabel= {monthly:'Monthly', semimonthly:'Semi-Monthly', biweekly:'Bi-Weekly', weekly:'Weekly'}[freq]||'Monthly';
    var ledger   = arr ? arr.ledger      : ((document.getElementById('na-ledger')||{}).value||'rent');
    var startDate= arr ? arr.startDate   : ((document.getElementById('na-start')||{}).value||today());
    var notes    = arr ? (arr.notes||'') : ((document.getElementById('na-notes')||{}).value||'');
    var ref      = arr ? arr.ref         : ((document.getElementById('na-ref')||{}).value||('ARR-'+today().slice(0,4)+'-001'));

    if (!total || !monthly) {
      document.getElementById('arrAgreementContent').innerHTML =
        '<div style="padding:20px;text-align:center;color:var(--muted);">Enter Total Owing and Monthly Payment to generate the agreement.</div>';
      openModal('modalArrAgreement');
      return;
    }
    if (!t) { t = {first:'[Tenant', last:'Name]', unit:'[Unit]', type:'community'}; }

    var periods  = arr ? (arr.periods||Math.ceil(total/monthly)) : Math.ceil(total/monthly);
    var months   = arr ? (arr.term||Math.ceil(periods/ppy*12)) : Math.ceil(periods/ppy*12);
    var fpP      = firstPay.split('-');
    var payoffDate = new Date(+fpP[0], +fpP[1]-1, +fpP[2]);
    payoffDate.setMonth(payoffDate.getMonth() + months);
    var payoffStr = payoffDate.toLocaleDateString('en-CA',{year:'numeric',month:'long',day:'numeric'});
    var todayStr  = today();
    var yrs = Math.floor(months/12), mos = months%12;
    var termStr = (yrs>0?yrs+(yrs===1?' year':' years')+(mos>0?' and ':''):'')+(mos>0?mos+(mos===1?' month':' months'):'');

    var ledgerLabels = {rent:'Rent Arrears','hydro':'Hydro Arrears','gas':'Gas/Heating Arrears','loans':'Loan Arrears','all':'Combined Arrears (All Ledgers)'};
    var ledgerLabel  = ledgerLabels[ledger] || ledger;

    // Payment schedule \u2014 first 12 + last
    var schedRows = '';
    var bal = total;
    for (var n = 1; n <= months; n++) {
      var pmt    = n === months ? Math.round(bal*100)/100 : monthly;
      bal = Math.max(0, Math.round((bal - pmt)*100)/100);
      if (n <= 12 || n === months) {
        schedRows += '<tr style="border-bottom:1px solid #eee;">' +
          '<td style="text-align:center;padding:5px 6px;">' + n + '</td>' +
          '<td style="text-align:right;padding:5px 6px;">$' + pmt.toFixed(2) + '</td>' +
          '<td style="text-align:right;padding:5px 6px;">$' + bal.toFixed(2) + '</td>' +
        '</tr>';
        if (n === 12 && months > 13) {
          schedRows += '<tr><td colspan="3" style="text-align:center;padding:5px;color:#999;font-size:11px;font-style:italic;">\u2014 ' + (months-13) + ' payments omitted \u2014</td></tr>';
        }
      }
    }

    var html = '<div style="font-family:Georgia,serif;font-size:13px;line-height:1.7;color:#111;">';

    // Header
    html += '<div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid '+window._themeAccentHex()+';padding-bottom:12px;margin-bottom:16px;">';
    html += '<div><div style="font-size:17px;font-weight:700;">'+(window.NATION_CONFIG && window.NATION_CONFIG.display_name || "")+'</div><div style="font-size:12px;color:#666;">Housing Finance Department</div></div>';
    html += '<div style="text-align:right;"><div style="background:#000;color:'+window._themeAccentHex()+';padding:3px 10px;border-radius:4px;font-size:10px;font-weight:700;">PENDING ED APPROVAL</div>';
    html += '<div style="font-size:10px;color:#999;margin-top:3px;">Ref: ' + ref + ' | ' + todayStr + '</div></div>';
    html += '</div>';

    html += '<div style="font-size:15px;font-weight:700;margin-bottom:6px;">Payment Arrangement Agreement</div>';
    html += '<div style="background:#fef9c3;border:1px solid #eab308;border-radius:6px;padding:8px 12px;margin-bottom:14px;font-size:12px;">&#9888; <strong>Draft \u2014 Pending Executive Director Approval.</strong> Not binding until signed by the ED.</div>';

    // Disclosure box
    html += '<div style="border:2px solid #000;border-radius:6px;padding:12px 14px;margin-bottom:16px;">';
    html += '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;border-bottom:1px solid #000;padding-bottom:5px;margin-bottom:10px;">Arrangement Summary</div>';
    html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">';
    html += cobRow('Total Amount Owing',    '$' + total.toFixed(2));
    html += cobRow('Arrears Type',          ledgerLabel);
    html += cobRow((freqLabel||'Monthly')+' Payment', '$' + monthly.toFixed(2));
    html += cobRow('Number of Payments', periods + ' ' + (freqLabel||'monthly').toLowerCase() + ' payments');
    html += cobRow('Repayment Term',        termStr);
    html += cobRow('Start Date',            startDate);
    html += cobRow('Projected Payoff Date', payoffStr);
    html += cobRow('Interest',              'None \u2014 this is a repayment arrangement, not a loan');
    html += '</div></div>';

    // Parties
    html += '<div style="font-size:13px;font-weight:700;border-bottom:2px solid #000;padding-bottom:3px;margin-bottom:8px;">1. Parties</div>';
    html += '<table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:14px;">';
    html += termsRow('Creditor', (window.NATION_CONFIG && window.NATION_CONFIG.display_name || "")+' \u2014 Housing Department');
    html += termsRow('Debtor (Tenant)', tenantName(t));
    html += termsRow('Unit', t.unit);
    html += termsRow('Agreement Date', todayStr);
    html += termsRow('Arrears Type', ledgerLabel);
    if (notes) html += termsRow('Notes', notes);
    html += '</table>';

    // Repayment terms
    html += '<div style="font-size:13px;font-weight:700;border-bottom:2px solid #000;padding-bottom:3px;margin-bottom:8px;">2. Repayment Terms</div>';
    html += '<table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:14px;">';
    html += termsRow('Total Owing', '<strong>$' + total.toFixed(2) + '</strong>');
    html += termsRow('Payment Frequency', freqLabel||'Monthly');
    html += termsRow('Payment Amount', '<strong>$' + monthly.toFixed(2) + ' per ' + (freq==='biweekly'?'two weeks':freq==='weekly'?'week':freq==='semimonthly'?'semi-month':'month') + '</strong>');
    html += termsRow('First Payment Due', firstPay);
    html += termsRow('Final Payment Due', payoffStr);
    html += termsRow('Repayment Term', termStr + ' (' + months + ' payments)');
    html += termsRow('Interest', 'No interest applies to this arrangement');
    html += '</table>';

    // Schedule
    html += '<div style="font-size:13px;font-weight:700;border-bottom:2px solid #000;padding-bottom:3px;margin-bottom:8px;">3. Payment Schedule</div>';
    html += '<table style="width:100%;border-collapse:collapse;font-size:11px;margin-bottom:14px;">';
    html += '<thead><tr style="background:#000;color:#fff;"><th style="padding:5px 6px;text-align:center;">#</th><th style="padding:5px 6px;text-align:right;">Payment</th><th style="padding:5px 6px;text-align:right;">Balance</th></tr></thead>';
    html += '<tbody>' + schedRows + '</tbody></table>';

    // Terms
    html += '<div style="font-size:13px;font-weight:700;border-bottom:2px solid #000;padding-bottom:3px;margin-bottom:8px;">4. Terms &amp; Conditions</div>';
    html += '<ol style="font-size:12px;line-height:1.9;margin-bottom:14px;padding-left:18px;">';
    html += '<li>The Tenant agrees to pay <strong>$' + monthly.toFixed(2) + ' per month</strong> toward outstanding ' + ledgerLabel + ' of <strong>$' + total.toFixed(2) + '</strong>, commencing ' + startDate + '.</li>';
    html += '<li>Payments are due on the same date each month. Failure to pay within 15 days of the due date constitutes default of this arrangement.</li>';
    html += '<li>The Tenant must also maintain current rent payments. This arrangement does not suspend regular rent obligations.</li>';
    html += '<li>In the event of default, '+(window.NATION_CONFIG && window.NATION_CONFIG.short || "")+' may pursue all available remedies including deduction from band payments and termination of tenancy.</li>';
    html += '<li>This arrangement becomes active only upon written approval of the Executive Director of '+(window.NATION_CONFIG && window.NATION_CONFIG.display_name || "")+'.</li>';
    html += '<li>'+(window.NATION_CONFIG && window.NATION_CONFIG.short || "")+' may review and renegotiate this arrangement if the Tenant\u2019s financial circumstances change materially.</li>';
    html += '</ol>';

    // Signatures
    html += '<div style="font-size:13px;font-weight:700;border-bottom:2px solid #000;padding-bottom:3px;margin-bottom:12px;">5. Signatures</div>';
    html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:16px;">';
    html += sigBlock(tenantName(t), 'Tenant \u2014 Debtor');
    html += sigBlock('Housing Manager', (window.NATION_CONFIG && window.NATION_CONFIG.display_name || ""));
    html += '</div>';
    html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:16px;">';
    html += sigBlock('Executive Director', (window.NATION_CONFIG && window.NATION_CONFIG.display_name || ""));
    html += sigBlock('Witness', '');
    html += '</div>';

    html += '<div style="border-top:1px solid #ccc;padding-top:8px;font-size:10px;color:#999;text-align:center;">'+(window.NATION_CONFIG && window.NATION_CONFIG.short || "")+' Housing Finance | Ref: ' + ref + ' | Generated: ' + todayStr + ' | PENDING ED APPROVAL</div>';
    html += '</div>';

    document.getElementById('arrAgreementContent').innerHTML = html;
    openModal('modalArrAgreement');

  } catch(e) {
    var el = document.getElementById('arrAgreementContent');
    if (el) el.innerHTML = '<div style="padding:20px;color:var(--danger);font-size:12px;white-space:pre-wrap;">' + e.message + '</div>';
    openModal('modalArrAgreement');
  }
}


function printAgreement(contentId) {
  var content = document.getElementById(contentId);
  if (!content) return;
  var w = window.open('', '_blank', 'width=800,height=600');
  if (!w) { toast('Print popup blocked. Please allow popups for this site.'); return; }
  w.document.write(
    '<html><head><title>'+(window.NATION_CONFIG && window.NATION_CONFIG.short || "")+' Agreement</title>' +
    '<style>body{font-family:Georgia,serif;margin:24px;font-size:13px;line-height:1.6;}' +
    '@media print{body{margin:0;}}</style></head><body>' +
    content.innerHTML +
    '</body></html>'
  );
  w.document.close();
  w.focus();
  setTimeout(function(){ w.print(); }, 400);
}

function previewLoanById(loanId) {
  var d = getData();
  var ln = d.loanList.find(function(x){ return x.id === loanId; });
  previewLoanAgreement(ln || null);
}

function previewLoanAgreement(loan) {
  try {
    _previewLoanAgreementInner(loan);
  } catch(e) {
    var msg = 'Error: ' + e.message + '\n' + (e.stack||'').slice(0,300);
    var el = document.getElementById('loanAgreementContent');
    if (el) el.innerHTML = '<div style="padding:20px;color:var(--danger);font-size:12px;white-space:pre-wrap;font-family:monospace;">' + msg + '</div>';
    openModal('modalLoanAgreement');
  }
}

function _previewLoanAgreementInner(loan) {
  // Can be called with a loan object (from loan detail view)
  // or without (reads from the new loan modal form fields)
  var fromForm = !loan;

  var tid      = loan ? loan.tenantId  : document.getElementById('ln-tenant').value;
  var t        = getTenant(tid);
  var principal= loan ? loan.principal : (parseFloat(document.getElementById('ln-principal').value) || 0);
  var rateType = loan ? loan.rateType  : document.getElementById('ln-rate-type').value;
  var rate     = (rateType === 'none') ? 0 : (loan ? (loan.rate||0) : (parseFloat(document.getElementById('ln-rate').value) || 0));
  var term     = loan ? loan.term      : (parseInt(document.getElementById('ln-term').value) || 0);
  var freq     = loan ? loan.freq      : document.getElementById('ln-freq').value;
  var loanType = loan ? loan.type      : document.getElementById('ln-type').value;
  var startDate    = loan ? (loan.advanceDate||loan.start||today()) : (document.getElementById('ln-start').value || today());
  var advanceDate  = loan ? (loan.advanceDate||loan.start||startDate) : ((document.getElementById('ln-advance')||{}).value || startDate);
  var firstPayDate = loan ? (loan.firstPaymentDate||loan.start||startDate) : ((document.getElementById('ln-first-payment')||{}).value || startDate);
  var notes    = loan ? (loan.notes||'') : ((document.getElementById('ln-notes').value||'').trim());

  // Any staff can preview the agreement - just need principal and term
  if (!principal || !term) {
    document.getElementById('loanAgreementContent').innerHTML =
      '<div style="padding:20px;text-align:center;color:var(--muted);">Enter Principal and Term (or Payment) to generate the agreement preview.</div>';
    openModal('modalLoanAgreement');
    return;
  }
  // Tenant is optional for preview - use placeholder if not selected
  if (!t) { t = {first:'[Tenant', last:'Name]', unit:'[Unit]', type:'community'}; }

  var payment       = calcPaymentAmt(principal, rate, term, freq);
  var periods       = termToPeriods(term, freq);
  var totalRepay    = Math.round(payment * periods * 100) / 100;
  var totalInterest = Math.max(0, Math.round((totalRepay - principal) * 100) / 100);
  var termLabel     = fmtTermLabel(term);

  // \u2500\u2500 True Cost of Borrowing \u2014 includes ALL interest charges \u2500\u2500\u2500\u2500\u2500\u2500
  // The agreement may be generated at two points:
  //   1. Before ED approval  \u2192 accrualDays = advance-to-firstPayment gap
  //   2. After ED approval   \u2192 retroInterest already posted on the loan record
  // We use whichever is greater for disclosure purposes.
  var accrualDays = 0;
  var accrualInterest = 0;
  var truePrincipal      = principal;
  var trueAccrualDays    = accrualDays;
  var trueAccrualInterest= accrualInterest;

  // If loan is already approved and has retroInterest recorded, use that instead
  // (previewLoanAgreement is also called from the TIC loan panel after approval)
  // We check via the ln-* fields which are always present here.

  // Adjusted opening balance for amortization
  var adjustedPrincipal  = Math.round((truePrincipal + trueAccrualInterest) * 100) / 100;

  // Recalculate payment and totals using adjusted principal if accrual exists
  var truePayment   = trueAccrualInterest > 0
    ? calcPaymentAmt(adjustedPrincipal, rate, term, freq)
    : payment;
  var truePeriods   = termToPeriods(term, freq);
  var trueTotalRepay= Math.round(truePayment * truePeriods * 100) / 100;
  var trueInterest  = Math.max(0, Math.round((trueTotalRepay + trueAccrualInterest - truePrincipal) * 100) / 100);

  // APR \u2014 true APR including accrual period
  var trueAPR = rate; // same nominal rate; accrual is just a period extension
  var aprStr  = rateType === 'none'
    ? '0% (Interest-Free)'
    : rate.toFixed(2) + '%';
  var interestStr = rateType === 'none'
    ? '0% \u2014 Interest-Free'
    : rate.toFixed(2) + '% per annum (' + rateType + ')';


  var freqLabel = freq === 'monthly'     ? 'Monthly'     :
                  freq === 'semimonthly' ? 'Semi-Monthly' :
                  freq === 'biweekly'    ? 'Bi-Weekly'    :
                  freq === 'weekly'      ? 'Weekly'       : 'Monthly';

  var typeLabel = loanType === 'renovation'  ? 'Renovation Loan'       :
                  loanType === 'rent-to-own' ? 'Rent-to-Own Program'   :
                  loanType === 'utilities'   ? 'Utilities Loan'        : 'Loan';

  // Final payment date
  var startParts = startDate.split('-');
  var startY = parseInt(startParts[0]) || 2026;
  var startM = parseInt(startParts[1]) || 1;
  var startD = parseInt(startParts[2]) || 1;
  var endM   = startM + term - 1;
  var endY   = startY + Math.floor(endM / 12);
  endM       = endM % 12 + 1;
  var finalDate = endY + '-' + String(endM).padStart(2,'0') + '-' + String(startD).padStart(2,'0');

  var ref       = 'LA-' + (Date.now() % 999999).toString().toUpperCase();
  var todayStr  = today();

  // Calculate accrued interest for gap between advance date and first payment date
  accrualDays = 0;
  accrualInterest = 0;
  if (advanceDate && firstPayDate && advanceDate !== firstPayDate && rate > 0) {
    // Use explicit part parsing \u2014 Safari rejects ISO strings in new Date()
    var advP = advanceDate.split('-');
    var fppP = firstPayDate.split('-');
    if (advP.length === 3 && fppP.length === 3) {
      var advMs = new Date(+advP[0], +advP[1]-1, +advP[2]).getTime();
      var fppMs = new Date(+fppP[0], +fppP[1]-1, +fppP[2]).getTime();
      if (!isNaN(advMs) && !isNaN(fppMs) && fppMs > advMs) {
        accrualDays = Math.round((fppMs - advMs) / 86400000);
        accrualInterest = Math.round(principal * (rate/100) * (accrualDays/365) * 100) / 100;
      }
    }
  }


  // Amortization schedule uses adjusted opening balance
  var schedRows = '';
  var bal = isNaN(adjustedPrincipal) ? principal : adjustedPrincipal;
  var usePayment = isNaN(truePayment) || truePayment <= 0 ? payment : truePayment;
  var mRate = (isNaN(rate) || rate <= 0) ? 0 : rate / 100 / 12;
  for (var n = 1; n <= term; n++) {
    var intPmt  = mRate > 0 ? Math.round(bal * mRate * 100) / 100 : 0;
    var prinPmt = n === term ? Math.round(bal * 100) / 100 : Math.max(0, Math.round((usePayment - intPmt) * 100) / 100);
    bal = Math.max(0, Math.round((bal - prinPmt) * 100) / 100);
    var showRow = n <= 12 || n === term;
    if (showRow) {
      schedRows += '<tr style="border-bottom:1px solid #eee;">' +
        '<td style="text-align:center;padding:5px 6px;">'    + n                    + '</td>' +
        '<td style="text-align:right;padding:5px 6px;">$'    + payment.toFixed(2)   + '</td>' +
        '<td style="text-align:right;padding:5px 6px;">$'    + intPmt.toFixed(2)    + '</td>' +
        '<td style="text-align:right;padding:5px 6px;">$'    + prinPmt.toFixed(2)   + '</td>' +
        '<td style="text-align:right;padding:5px 6px;">$'    + bal.toFixed(2)       + '</td>' +
      '</tr>';
      if (n === 12 && term > 13) {
        schedRows += '<tr><td colspan="5" style="text-align:center;padding:5px;color:#999;font-size:11px;font-style:italic;">\u2014 ' + (term - 13) + ' payments omitted \u2014</td></tr>';
      }
    }
  }

  // Build HTML sections
  interestStr  = rateType === 'none' ? '0% \u2014 Interest-Free' : (rate.toFixed(2) + '% per annum (' + rateType + ')');
  aprStr       = rateType === 'none' ? '0% (Interest-Free)' : (rate.toFixed(2) + '%');
  var borrowerName = tenantName(t);

  var html = '<div style="font-family:Georgia,serif;font-size:13px;line-height:1.7;color:#111;">';

  // Header
  html += '<div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid '+window._themeAccentHex()+';padding-bottom:12px;margin-bottom:16px;">';
  html += '<div><div style="font-size:17px;font-weight:700;">'+(window.NATION_CONFIG && window.NATION_CONFIG.display_name || "")+'</div><div style="font-size:12px;color:#666;">Housing Finance Department</div></div>';
  html += '<div style="text-align:right;"><div style="background:#000;color:'+window._themeAccentHex()+';padding:3px 10px;border-radius:4px;font-size:10px;font-weight:700;">PENDING ED APPROVAL</div>';
  html += '<div style="font-size:10px;color:#999;margin-top:3px;">Ref: ' + ref + ' | ' + todayStr + '</div></div>';
  html += '</div>';

  // Title
  html += '<div style="font-size:15px;font-weight:700;margin-bottom:8px;">' + typeLabel + ' Agreement</div>';
  html += '<div style="background:#fef9c3;border:1px solid #eab308;border-radius:6px;padding:8px 12px;margin-bottom:14px;font-size:12px;">&#9888; <strong>Draft \u2014 Pending Executive Director Approval.</strong> Not binding until signed.</div>';

  // COBDS
  html += '<div style="border:2px solid #000;border-radius:6px;padding:12px 14px;margin-bottom:16px;">';
  html += '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;border-bottom:1px solid #000;padding-bottom:5px;margin-bottom:10px;">Cost of Borrowing Disclosure Statement</div>';
  html += '<div style="font-size:10px;color:#555;margin-bottom:8px;">As required under the <em>Cost of Credit Disclosure Act</em> and applicable consumer protection legislation.</div>';
  html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">';
  html += cobRow('Principal Amount',              '$' + truePrincipal.toFixed(2));
  if (trueAccrualInterest > 0) {
    html += cobRow('Accrued Interest (' + trueAccrualDays + ' days, advance to first payment)', '$' + trueAccrualInterest.toFixed(2));
    html += cobRow('Adjusted Opening Balance',    '<strong>$' + adjustedPrincipal.toFixed(2) + '</strong>');
  }
  html += cobRow('Annual Interest Rate',          interestStr);
  html += cobRow('Annual Percentage Rate (APR)',  aprStr);
  html += cobRow('Term',                          termLabel + ' (' + term + ' months)');
  html += cobRow('Payment Amount',                '$' + truePayment.toFixed(2) + ' ' + freqLabel.toLowerCase());
  html += cobRow('Number of Payments',            String(truePeriods));
  html += cobRow('Total Interest Charges',        '$' + trueInterest.toFixed(2));
  html += cobRow('Total Cost of Borrowing',       '<strong>$' + trueTotalRepay.toFixed(2) + '</strong>');
  html += cobRow('Prepayment Penalty',            'None');
  html += cobRow('Default Rate',                  'Same as contract rate');
  html += '</div></div>';

  // Parties
  html += '<div style="font-size:13px;font-weight:700;border-bottom:2px solid #000;padding-bottom:3px;margin-bottom:8px;">1. Parties</div>';
  html += '<table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:14px;">';
  html += termsRow('Lender',          (window.NATION_CONFIG && window.NATION_CONFIG.display_name || "")+' \u2014 Housing Department');
  html += termsRow('Borrower',        borrowerName);
  html += termsRow('Unit',            t.unit);
  html += termsRow('Agreement Date',  todayStr);
  html += termsRow('Loan Purpose',    notes || 'Not specified');
  html += '</table>';

  // Loan Terms
  html += '<div style="font-size:13px;font-weight:700;border-bottom:2px solid #000;padding-bottom:3px;margin-bottom:8px;">2. Loan Terms</div>';
  html += '<table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:14px;">';
  html += termsRow('Loan Type',          typeLabel);
  html += termsRow('Principal',          '<strong>$' + truePrincipal.toFixed(2) + '</strong>');
  if (trueAccrualInterest > 0) {
    html += termsRow('Accrued Interest (' + trueAccrualDays + ' days)', '$' + trueAccrualInterest.toFixed(2));
    html += termsRow('Adjusted Opening Balance', '<strong>$' + adjustedPrincipal.toFixed(2) + '</strong>');
  }
  html += termsRow('Interest Rate',      interestStr);
  html += termsRow('Term',               termLabel + ' (' + term + ' months)');
  html += termsRow('Payment Frequency',  freqLabel);
  html += termsRow('Payment Amount',     '<strong>$' + truePayment.toFixed(2) + ' ' + freqLabel.toLowerCase() + '</strong>');
  html += termsRow('Loan Advance Date',  advanceDate);
  html += termsRow('First Payment Date', firstPayDate);
  html += termsRow('Final Payment Date', finalDate);
  html += '</table>';

  // Repayment Schedule
  html += '<div style="font-size:13px;font-weight:700;border-bottom:2px solid #000;padding-bottom:3px;margin-bottom:8px;">3. Repayment Schedule</div>';
  html += '<table style="width:100%;border-collapse:collapse;font-size:11px;margin-bottom:14px;">';
  html += '<thead><tr style="background:#000;color:#fff;">';
  html += '<th style="padding:5px 6px;text-align:center;">#</th>';
  html += '<th style="padding:5px 6px;text-align:right;">Payment</th>';
  html += '<th style="padding:5px 6px;text-align:right;">Interest</th>';
  html += '<th style="padding:5px 6px;text-align:right;">Principal</th>';
  html += '<th style="padding:5px 6px;text-align:right;">Balance</th>';
  html += '</tr></thead><tbody>' + schedRows + '</tbody></table>';

  // Terms & Conditions
  html += '<div style="font-size:13px;font-weight:700;border-bottom:2px solid #000;padding-bottom:3px;margin-bottom:8px;">4. Terms &amp; Conditions</div>';
  html += '<ol style="font-size:12px;line-height:1.9;margin-bottom:14px;padding-left:18px;">';
  html += '<li>The Borrower agrees to repay <strong>$' + principal.toFixed(2) + '</strong>';
  if (rateType !== 'none') html += ' plus interest at ' + rate.toFixed(2) + '% per annum';
  html += ' in ' + freqLabel.toLowerCase() + ' instalments of <strong>$' + payment.toFixed(2) + '</strong>.</li>';
  html += '<li>Payments are due on the same date each ' + (freq === 'monthly' ? 'month' : 'period') + ' commencing ' + startDate + '.</li>';
  html += '<li>The Borrower may prepay all or part of this loan at any time without penalty.</li>';
  html += '<li>In the event of default (missed payment exceeding 30 days), '+(window.NATION_CONFIG && window.NATION_CONFIG.short || "")+' may deduct outstanding amounts from any band payments or benefits owed to the Borrower.</li>';
  html += '<li>This loan becomes active only upon written approval of the Executive Director of '+(window.NATION_CONFIG && window.NATION_CONFIG.display_name || "")+'.</li>';
  html += '<li>'+(window.NATION_CONFIG && window.NATION_CONFIG.short || "")+' may assign housing staff to assist with financial planning if the account falls into arrears.</li>';
  html += '<li>This agreement is governed by the laws of Ontario and applicable federal legislation.</li>';
  html += '</ol>';

  // Signatures
  html += '<div style="font-size:13px;font-weight:700;border-bottom:2px solid #000;padding-bottom:3px;margin-bottom:12px;">5. Signatures</div>';
  html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:16px;">';
  html += sigBlock(borrowerName, 'Borrower');
  html += sigBlock('Housing Manager', (window.NATION_CONFIG && window.NATION_CONFIG.display_name || ""));
  html += '</div>';
  html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:16px;">';
  html += sigBlock('Executive Director', (window.NATION_CONFIG && window.NATION_CONFIG.display_name || ""));
  html += sigBlock('Witness', '');
  html += '</div>';

  // Footer
  html += '<div style="border-top:1px solid #ccc;padding-top:8px;font-size:10px;color:#999;text-align:center;">';
  html += ''+(window.NATION_CONFIG && window.NATION_CONFIG.short || "")+' Housing Finance | Ref: ' + ref + ' | Generated: ' + todayStr + ' | PENDING ED APPROVAL';
  html += '</div>';
  html += '</div>';

  document.getElementById('loanAgreementContent').innerHTML = html;
  openModal('modalLoanAgreement');
}


function cobRow(lbl, val) {
  return '<div style="background:#f9f9f7;padding:6px 8px;border-radius:4px;">' +
    '<div style="font-size:10px;color:#666;margin-bottom:2px;">' + lbl + '</div>' +
    '<div style="font-size:12px;font-weight:600;">' + val + '</div>' +
  '</div>';
}

function termsRow(lbl, val) {
  return '<tr style="border-bottom:1px solid #eee;">' +
    '<td style="padding:6px 8px;font-weight:600;color:#444;width:40%;font-size:12px;">' + lbl + '</td>' +
    '<td style="padding:6px 8px;font-size:12px;">' + val + '</td>' +
  '</tr>';
}

function sigBlock(name, role) {
  return '<div>' +
    '<div style="border-bottom:1px solid #333;height:36px;margin-bottom:5px;"></div>' +
    '<div style="font-size:12px;font-weight:600;">' + name + '</div>' +
    (role ? '<div style="font-size:11px;color:#666;">' + role + '</div>' : '') +
    '<div style="font-size:11px;color:#999;">Date: _______________</div>' +
  '</div>';
}

