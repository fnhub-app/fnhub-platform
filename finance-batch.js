// NOTE: showAutoEngineModal / runEngineFromModal (auto-engine, never wired to any
// button) and printBatchStatements (superseded by finBatchStatementsDownload in
// finance-pdf-jspdf.js) were deleted in the audit cleanup.

function showRunStatementsModal() {
  var existing = document.getElementById('modalRunStatements');
  if (existing) document.body.removeChild(existing);

  var d = getData();
  var totals = calcAllTotals(d);
  var tenants = (d.tenants || []).filter(function(t){
    if (t.mergedInto) return false;   // never bill a merged-away duplicate (it still carries its own rent)
    var st = t.status || 'active';
    return t.active !== false && st !== 'former' && st !== 'deceased';
  }).slice().sort(function(a,b){ return tenantName(a).localeCompare(tenantName(b)); });

  var rows = tenants.map(function(t){
    var v = totals[t.id] || {};
    var bal = (v.rent||0) + (v.loan||0) + (v.arrangement||0);
    var initials = ((t.first||'')[0]||'') + ((t.last||'')[0]||'');
    var searchVal = (tenantName(t) + ' ' + (t.unit||'')).toLowerCase();
    return '<label data-rs-search="'+escapeHtml(searchVal)+'" style="display:flex;align-items:center;gap:10px;padding:9px 14px;cursor:pointer;border-bottom:1px solid var(--border);">'+
      '<input type="checkbox" class="rs-chk" data-tid="'+t.id+'" checked style="width:15px;height:15px;cursor:pointer;flex-shrink:0;" onchange="_rsUpdateCount()"/>'+
      '<div class="std-row-avatar" style="flex-shrink:0;">'+(initials||'?')+'</div>'+
      '<div style="flex:1;min-width:0;">'+
        '<div style="font-size:13px;font-weight:600;">'+tenantNameHtml(t)+'</div>'+
        '<div style="font-size:11px;color:var(--muted);">'+(t.unit||'No unit')+'</div>'+
      '</div>'+
      '<div style="text-align:right;flex-shrink:0;font-size:13px;">'+
        (bal > 0 ? '<span class="amt-debit">'+fmt(bal)+'</span>' : '<span style="color:var(--success);font-weight:600;">Nil</span>')+
      '</div>'+
    '</label>';
  }).join('');

  var mo = document.createElement('div');
  mo.className = 'modal-ov';
  mo.id = 'modalRunStatements';
  mo.innerHTML =
    '<div class="modal modal-lg" style="max-width:560px;">'+
    '<div class="modal-hdr">'+
      '<div><h2>&#128438; Running Statements</h2>'+
      '<p>Select tenants to include in the batch print</p></div>'+
      '<button class="modal-close" onclick="closeModal(\'modalRunStatements\')">&#x2715;</button>'+
    '</div>'+
    '<div class="modal-body" style="padding:0;">'+
      '<div style="padding:10px 14px;border-bottom:1px solid var(--border);">'+
        '<input id="rs-search" type="text" placeholder="🔍 Search by name or unit…" oninput="_rsSearch(this.value)" style="width:100%;box-sizing:border-box;padding:8px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-size:13px;outline:none;"/>'+
      '</div>'+
      '<div style="display:flex;align-items:center;gap:8px;padding:8px 14px;background:var(--surface);border-bottom:1px solid var(--border);">'+
        '<button class="btn btn-ghost btn-sm" onclick="_rsCheckAll(true)">Check All</button>'+
        '<button class="btn btn-ghost btn-sm" onclick="_rsCheckAll(false)">Uncheck All</button>'+
        '<span id="rs-count" style="margin-left:auto;font-size:12px;color:var(--muted);">'+tenants.length+' of '+tenants.length+' selected</span>'+
      '</div>'+
      '<div id="rs-list" style="max-height:340px;overflow-y:auto;">'+
        (rows || '<div style="padding:30px;text-align:center;color:var(--muted);">No active tenants found.</div>')+
      '</div>'+
    '</div>'+
    '<div class="modal-footer">'+
      '<button class="btn btn-ghost" onclick="closeModal(\'modalRunStatements\')">Cancel</button>'+
      '<button class="btn btn-primary" onclick="finBatchStatementsDownload()">&#11015;&#65039; Download PDF</button>'+
    '</div>'+
    '</div>';

  document.body.appendChild(mo);
  mo.style.display = '';
  mo.classList.add('on');
}

function _rsSearch(q) {
  var labels = document.querySelectorAll('#rs-list label[data-rs-search]');
  var ql = (q || '').toLowerCase().trim();
  for (var i = 0; i < labels.length; i++) {
    labels[i].style.display = (!ql || labels[i].getAttribute('data-rs-search').indexOf(ql) >= 0) ? 'flex' : 'none';
  }
  _rsUpdateCount();
}

function _rsCheckAll(checked) {
  var labels = document.querySelectorAll('#rs-list label[data-rs-search]');
  for (var i = 0; i < labels.length; i++) {
    if (labels[i].style.display === 'none') continue;
    var chk = labels[i].querySelector('.rs-chk');
    if (chk) chk.checked = checked;
  }
  _rsUpdateCount();
}

function _rsUpdateCount() {
  var labels = document.querySelectorAll('#rs-list label[data-rs-search]');
  var total = 0, selected = 0;
  for (var i = 0; i < labels.length; i++) {
    if (labels[i].style.display === 'none') continue;
    total++;
    var chk = labels[i].querySelector('.rs-chk');
    if (chk && chk.checked) selected++;
  }
  var el = document.getElementById('rs-count');
  if (el) el.textContent = selected + ' of ' + total + ' selected';
}


function _renderNoRentList(tenants, isAll) {
  var label = isAll
    ? '&#9888; <strong>' + tenants.length + ' active tenant' + (tenants.length === 1 ? '' : 's') + '</strong> have no monthly rent configured — nothing to post.'
    : '&#9888; <strong>' + tenants.length + ' tenant' + (tenants.length === 1 ? '' : 's') + '</strong> skipped — no monthly rent configured.';
  var rows = tenants.map(function(t) {
    var sid = t.id.replace(/'/g, "\\'");
    return '<tr>'+
      '<td style="font-weight:600;">' + tenantNameHtml(t) + '</td>'+
      '<td style="color:var(--muted);">' + (t.unit || '—') + '</td>'+
      '<td><button class="btn btn-ghost btn-sm" onclick="closeModal(\'modalBatchAccounting\');openFinanceCard(\'' + sid + '\')">Set Rent</button></td>'+
    '</tr>';
  }).join('');
  return '<div style="margin-bottom:12px;border:1px solid var(--warn-amber-border);border-radius:10px;overflow:hidden;">'+
    '<div style="background:var(--warn-amber-bg);padding:10px 14px;font-size:12px;">' + label + '</div>'+
    '<div style="max-height:220px;overflow-y:auto;">'+
      '<table class="tbl" style="margin:0;">'+
        '<thead><tr><th>Tenant</th><th>Address / Unit</th><th></th></tr></thead>'+
        '<tbody>' + rows + '</tbody>'+
      '</table>'+
    '</div>'+
  '</div>';
}

function showBatchAccountingModal() {
  var existing = document.getElementById('modalBatchAccounting');
  if (existing) document.body.removeChild(existing);

  var now = today();
  var defaultMonth = now.slice(0,7);

  var mo = document.createElement('div');
  mo.className = 'modal-ov';
  mo.id = 'modalBatchAccounting';
  mo.innerHTML =
    '<div class="modal modal-lg">'+
    '<div class="modal-hdr">'+
      '<div><h2>&#128202; Batch Accounting</h2><p>Preview and post pending accounting entries in bulk</p></div>'+
      '<button class="modal-close" onclick="closeModal(\'modalBatchAccounting\')">&#x2715;</button>'+
    '</div>'+
    '<div class="modal-body">'+
      '<div class="ibox yellow">&#9888; <strong>Always run Dry Run first.</strong> Live Post will write entries for all tenants in the selected period.</div>'+
      '<div class="fg c2" style="gap:14px;margin-top:16px;">'+
        '<div class="f"><label>Period (Month)</label><input id="ba-month" type="month" value="'+defaultMonth+'"/></div>'+
        '<div class="f"><label>Entry Type</label>'+
          '<select id="ba-type">'+
            '<option value="rent">Rent Charges</option>'+
            '<option value="arrangement">Arrangement Payments Due</option>'+
            '<option value="loan">Loan Payments Due</option>'+
            '<option value="all">All Types</option>'+
          '</select>'+
        '</div>'+
      '</div>'+
      '<div id="ba-results" style="margin-top:16px;"></div>'+
    '</div>'+
    '<div class="modal-footer">'+
      '<button class="btn btn-ghost" onclick="closeModal(\'modalBatchAccounting\')">Close</button>'+
      '<button class="btn btn-ghost" onclick="runBatchAccounting(true)">&#128269; Dry Run</button>'+
      '<button class="btn btn-primary" onclick="if(confirm(\'Post accounting entries for all eligible tenants in this period?\'))runBatchAccounting(false)">&#9654; Live Post</button>'+
    '</div>'+
    '</div>';
  document.body.appendChild(mo);
  mo.style.display = '';
  mo.classList.add('on');
}

function runBatchAccounting(dryRun) {
  var month = (document.getElementById('ba-month')||{}).value || today().slice(0,7);
  var type  = (document.getElementById('ba-type')||{}).value  || 'rent';
  var d = getData();
  var resultsEl = document.getElementById('ba-results');
  if (!resultsEl) return;

  // Determine the date range for the selected month
  var year  = parseInt(month.slice(0,4),10);
  var mon   = parseInt(month.slice(5,7),10);
  var monthStart = month + '-01';
  var monthEndDate = new Date(year, mon, 0);
  var monthEnd = year+'-'+String(mon).padStart(2,'0')+'-'+String(monthEndDate.getDate()).padStart(2,'0');

  var activeTenants = (d.tenants||[]).filter(function(t){
    if (t.mergedInto) return false;   // never bill a merged-away duplicate
    var st = t.status||'active';
    return t.active !== false && st !== 'former' && st !== 'deceased';
  });

  // Build lookups from housing_units cache (set via Inventory > Edit Unit)
  var _unitRentById = {};   // unit id  → monthlyRent
  var _unitRentByName = {}; // assigned_name (lowercase) → monthlyRent (fallback when current_unit_id absent)
  (window._housingUnits || []).forEach(function(u) {
    var rent = u.data && u.data.monthlyRent != null ? Number(u.data.monthlyRent) : 0;
    if (rent > 0) {
      _unitRentById[u.id] = rent;
      if (u.assigned_name) _unitRentByName[u.assigned_name.toLowerCase().trim()] = rent;
    }
  });

  var rows = [];
  var noRentTenants = [];

  activeTenants.forEach(function(t){
    var tid = t.id;

    // Rent charges
    if (type === 'rent' || type === 'all') {
      // Priority: 1) finance tenant profile, 2) housing unit by ID, 3) by assigned_name, 4) last ledger charge
      var monthlyRent = parseFloat(t.rent || 0);
      if (!monthlyRent && t.currentUnitId) {
        monthlyRent = _unitRentById[t.currentUnitId] || 0;
      }
      if (!monthlyRent) {
        var _nameLc = tenantName(t).toLowerCase().trim();
        monthlyRent = _unitRentByName[_nameLc] || 0;
      }
      if (!monthlyRent) {
        var lastCharge = (d.rentLedger||[])
          .filter(function(r){ return r.tenantId === tid && r.type === 'invoice' && r.charge > 0; })
          .sort(function(a,b){ return (b.date||'').localeCompare(a.date||''); })[0];
        monthlyRent = lastCharge ? lastCharge.charge : 0;
      }
      if (monthlyRent > 0) {
        var alreadyCharged = (d.rentLedger||[]).some(function(r){
          return r.tenantId === tid && r.type === 'invoice' && (r.date||'').slice(0,7) === month;
        });
        rows.push({
          tenant: tenantName(t),
          unit: t.unit||'',
          type: 'Rent Charge',
          period: month,
          amount: monthlyRent,
          status: alreadyCharged ? 'already-posted' : 'pending'
        });
      } else {
        noRentTenants.push(t);
      }
    }

    // Arrangement payments due
    if (type === 'arrangement' || type === 'all') {
      (d.arrangements||[]).filter(function(a){
        return a.tenantId===tid && (a.status==='active' || a.status==='approved');
      }).forEach(function(a){
        var due = parseFloat(a.monthlyPayment||0);  // field is monthlyPayment, not monthlyAmount
        if (due > 0) {
          var alreadyPosted = (d.arrPayments||[]).some(function(p){
            return p.arrId===a.id && (p.date||'').slice(0,7) === month;
          });
          rows.push({
            tenant: tenantName(t),
            unit: t.unit||'',
            type: 'Arrangement Due',
            period: month,
            amount: due,
            status: alreadyPosted ? 'already-posted' : 'pending'
          });
        }
      });
    }

    // Loan payments due
    if (type === 'loan' || type === 'all') {
      (d.loanList||[]).filter(function(l){ return l.tenantId===tid && l.status==='approved'; }).forEach(function(l){
        // l.payment is always 0 (client-computed, not persisted) — calculate from loan terms
        var due = parseFloat(calcPaymentAmt(l.principal, l.rate, l.term, l.freq||'monthly')) || 0;
        if (due > 0) {
          var alreadyPosted = (d.loanPayments||[]).some(function(p){
            return p.loanId===l.id && (p.date||'').slice(0,7) === month;
          });
          rows.push({
            tenant: tenantName(t),
            unit: t.unit||'',
            type: 'Loan Payment Due',
            period: month,
            amount: due,
            status: alreadyPosted ? 'already-posted' : 'pending'
          });
        }
      });
    }
  });

  var pending = rows.filter(function(r){ return r.status === 'pending'; });
  var posted  = rows.filter(function(r){ return r.status === 'already-posted'; });
  var totalAmt = pending.reduce(function(s,r){ return s + r.amount; }, 0);

  if (dryRun) {
    // Show preview only
    var html = '<div style="margin-bottom:12px;display:flex;gap:10px;flex-wrap:wrap;">'+
      '<div style="background:var(--success-bg);border:1px solid var(--success-border);border-radius:8px;padding:8px 14px;font-size:12px;">'+
        '<strong style="color:var(--success);">'+pending.length+'</strong> entries to post'+
      '</div>'+
      '<div style="background:var(--warn-amber-bg);border:1px solid var(--warn-amber-border);border-radius:8px;padding:8px 14px;font-size:12px;">'+
        '<strong>'+fmt(totalAmt)+'</strong> total amount'+
      '</div>'+
      '<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:8px 14px;font-size:12px;">'+
        '<strong>'+posted.length+'</strong> already posted (will be skipped)'+
      '</div>'+
    '</div>';

    // Show missing-rent list if any tenants are unconfigured (all-empty or partial)
    if (noRentTenants.length && (type === 'rent' || type === 'all')) {
      html += _renderNoRentList(noRentTenants, !rows.length);
    }

    if (!rows.length && !noRentTenants.length) {
      if (!activeTenants.length) {
        html += '<div class="ibox" style="color:var(--muted);">No active tenants found in the system.</div>';
      } else {
        html += '<div class="ibox" style="color:var(--muted);">No entries found for the selected type and period.</div>';
      }
    } else if (rows.length && !pending.length) {
      html += '<div class="ibox" style="color:var(--success);">&#10003; All accounting entries for this period are already posted — nothing to do.</div>';
    } else if (pending.length) {
      html += '<div style="border:1px solid var(--border);border-radius:10px;overflow:hidden;">'+
        '<table class="tbl">'+
          '<thead><tr>'+
            '<th>Tenant</th><th>Unit</th><th>Type</th><th>Period</th>'+
            '<th style="text-align:right;">Amount</th><th>Action</th>'+
          '</tr></thead>'+
          '<tbody>'+
          pending.map(function(r){
            return '<tr>'+
              '<td style="font-weight:600;">'+r.tenant+'</td>'+
              '<td>'+r.unit+'</td>'+
              '<td>'+r.type+'</td>'+
              '<td>'+r.period+'</td>'+
              '<td style="text-align:right;font-weight:700;color:var(--danger);">'+fmt(r.amount)+'</td>'+
              '<td><span class="pill pill-gray" style="font-size:10px;">Will Post</span></td>'+
            '</tr>';
          }).join('')+
          '</tbody>'+
        '</table>'+
      '</div>';
    }
    resultsEl.innerHTML = html;
    return;
  }

  // Live run — post pending entries
  if (!pending.length) {
    resultsEl.innerHTML = '<div class="ibox" style="color:var(--success);">&#10003; Nothing to post for this period.</div>';
    return;
  }

  var posted2 = 0;
  var now2 = monthStart; // post on first of month
  pending.forEach(function(r){
    var t2 = (d.tenants||[]).find(function(t){ return tenantName(t) === r.tenant && t.unit === r.unit; });
    if (!t2) return;
    if (r.type === 'Rent Charge') {
      var entry = {id:uid(), tenantId:t2.id, date:now2, type:'invoice',
        desc:'Rent charge — '+month, charge:r.amount, payment:0,
        ledger:'rent', method:'', status:'pending', enteredBy:(window.HOUSING_SESSION&&window.HOUSING_SESSION.name)||'Batch'};
      d.rentLedger.push(entry);
      posted2++;
    }
    // Arrangement/Loan due notices are informational — skip auto-posting ledger entries
  });

  if (posted2 > 0) {
    saveData(d);
    toast('Posted '+posted2+' accounting entr'+(posted2===1?'y':'ies')+'.');
  }
  resultsEl.innerHTML = '<div class="ibox" style="color:var(--success);">&#10003; Posted '+posted2+' entr'+(posted2===1?'y':'ies')+'. Refresh the ledger to see changes.</div>';
}


