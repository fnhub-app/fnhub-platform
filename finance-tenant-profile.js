// NOTE: runAutoEngine (the unreachable monthly auto-engine, ~160 lines incl. its
// dead in-memory audit pushes) was deleted in the audit cleanup.
function renderTenantProfile(tid) {
  // Resolve a merged duplicate to the canonical person, then use that id for
  // every lookup below — child rows and balances are all keyed to the canonical
  // id after _finCanonicalizeTenantRefs, so a merged-id deep link still opens
  // the full, rolled-up profile instead of an empty one.
  if (typeof finCanonTenantId === 'function') tid = finCanonTenantId(tid);
  var t = getTenant(tid);
  if (!t) return;
  var d = getData();
  var totals = calcAllTotals(d);
  var v = totals[tid] || {};
  var grand = (v.rent||0)+(v.loan||0)+(v.arrangement||0);
  var initials = ((t.first||'')[0]||'') + ((t.last||'')[0]||'');
  if (!initials) initials = '?';
  var inCol = isInCollections(tid);
  var isActive = t.active !== false; // default active
  var typeLabels = {'band-on':'Band On-Reserve','band-off':'Band Off-Reserve','band-staff':'Band Office Staff','clea':'CLEA','community':'Community Member','business':'Business','department':'Department'};

  // Approved loans balance
  var loanBal = 0;
  d.loanList.filter(function(l){return l.tenantId===tid&&l.status==='approved';}).forEach(function(l){
    var paid=d.loanPayments.filter(function(p){return p.loanId===l.id&&p.status!=='reversed';}).reduce(function(s,p){return s+p.amount;},0);
    loanBal += Math.max(0,l.principal-paid);
  });

  var pp = document.getElementById('tenantProfilePanel');
  if (!pp) return;
  pp.innerHTML = '';

  // Reset any prior DocLibrary instance for this tenant \u2014 the old DOM
  // nodes are about to be garbage-collected via innerHTML='' above.
  if (window._ticDocLibs) delete window._ticDocLibs[tid];

  
  // \u2500\u2500 SECTION 1: Account Overview (TOP) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  var s2 = pp.appendChild(document.createElement('div'));
  s2.className = 'card';
  s2.style.marginBottom = '12px';

  // Collections warning
  if (inCol) {
    var colBanner = s2.appendChild(document.createElement('div'));
    colBanner.style.cssText = 'background:var(--danger-bg);border:1.5px solid var(--danger);border-radius:8px;padding:12px 16px;margin-bottom:14px;display:flex;align-items:flex-start;gap:12px;';
    colBanner.innerHTML =
      '<span style="font-size:22px;flex-shrink:0;">&#128680;</span>'+
      '<div style="flex:1;">'+
        '<div style="font-size:13px;font-weight:700;color:var(--danger);margin-bottom:2px;">Account Flagged \u2014 Collections</div>'+
        '<div style="font-size:12px;color:#7f1d1d;margin-bottom:8px;">Auto-payments suspended. Manual payments only.</div>'+
        '<button class="btn btn-ghost btn-sm" style="font-size:11px;border-color:var(--danger);color:var(--danger);" onclick="resolveCollectionFromTIC(\''+tid+'\')">&#10003; Mark Resolved</button>'+
      '</div>';
  }

  // Header row
  var s2hdr = s2.appendChild(document.createElement('div'));
  s2hdr.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px;';
  var s2left = s2hdr.appendChild(document.createElement('div'));
  s2left.style.cssText = 'display:flex;align-items:center;gap:10px;';
  var av = s2left.appendChild(document.createElement('div'));
  av.style.cssText = 'width:44px;height:44px;border-radius:50%;background:var(--dark);display:flex;align-items:center;justify-content:center;font-size:17px;color:var(--yellow);font-weight:700;flex-shrink:0;';
  av.textContent = initials;
  var nameWrap = s2left.appendChild(document.createElement('div'));
  var nameRow = nameWrap.appendChild(document.createElement('div'));
  nameRow.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;';
  var nameEl = nameRow.appendChild(document.createElement('span'));
  nameEl.style.cssText = 'font-size:18px;font-weight:700;';
  nameEl.textContent = tenantName(t);
  var activeBadge = nameRow.appendChild(document.createElement('span'));
  activeBadge.className = isActive ? 'pill pill-green' : 'pill pill-gray';
  activeBadge.style.fontSize = '10px';
  activeBadge.textContent = isActive ? '\u25CF Active' : '\u25CB Inactive';
  if (inCol) {
    var cb2 = nameRow.appendChild(document.createElement('span'));
    cb2.className = 'collections-badge';
    cb2.style.fontSize = '10px';
    cb2.textContent = '\u2691 Collections';
  }
  var subEl = nameWrap.appendChild(document.createElement('div'));
  subEl.style.cssText = 'font-size:12px;color:var(--muted);';
  subEl.textContent = t.unit + ' \u00B7 ' + (typeLabels[t.type]||t.type);

  var s2btns = s2hdr.appendChild(document.createElement('div'));
  s2btns.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;align-items:center;';
  [
    {lbl:'+ Invoice',  fn:'openInvoiceForTenant("'+tid+'")',  cls:'btn btn-ghost btn-sm'},
    {lbl:'+ Payment',  fn:'openPaymentForTenant("'+tid+'")',  cls:'btn btn-primary btn-sm'},
  ].forEach(function(b){
    var btn = s2btns.appendChild(document.createElement('button'));
    btn.className = b.cls; btn.textContent = b.lbl;
    btn.setAttribute('onclick', b.fn);
  });

  // Clickable balance tiles (compact)
  var balGrid = s2.appendChild(document.createElement('div'));
  balGrid.className = 'balance-tiles';
  balGrid.style.cssText = 'display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:4px;';

  var tiles = [
    {key:'rent',        lbl:'Rent Owing',   val:Math.max(0,v.rent||0),        icon:'\uD83C\uDFE0', danger:(v.rent||0)>0},
    {key:'arrangement', lbl:'Arrangement',  val:Math.max(0,v.arrangement||0), icon:'\uD83D\uDCCB', danger:(v.arrangement||0)>0},
    {key:'loan',        lbl:'Loans',        val:loanBal,                       icon:'\uD83D\uDCB0', danger:loanBal>0},
    {key:'total',       lbl:'Total Owing',  val:Math.max(0,grand),             icon:'',   bold:true},
  ];

  tiles.forEach(function(tile){
    var cell = balGrid.appendChild(document.createElement('div'));
    var owing = tile.val > 0.005;
    var isTotal = tile.bold;
    cell.style.cssText = 'border-radius:8px;padding:8px 10px;text-align:center;transition:var(--tr);' +
      'background:' + (isTotal ? 'var(--dark)' : owing ? 'var(--danger-bg)' : 'var(--success-bg)') + ';' +
      (tile.key !== 'total' ? 'cursor:pointer;' : '');
    if (tile.key !== 'total') {
      cell.title = 'Click to view ' + tile.lbl + ' details';
      cell.onmouseenter = function(){ if(!this._active) this.style.opacity='.8'; };
      cell.onmouseleave = function(){ if(!this._active) this.style.opacity='1'; };
      cell.onclick = (function(k, el){ return function(){ showTicDetail(tid, k, balGrid, el); }; })(tile.key, cell);
    }
    // Inline icon + label on one line for the compact layout
    var labelRow = cell.appendChild(document.createElement('div'));
    labelRow.style.cssText = 'font-size:9px;text-transform:uppercase;letter-spacing:.4px;color:' +
      (isTotal ? 'var(--gray)' : 'var(--muted)') + ';margin-bottom:2px;display:flex;align-items:center;justify-content:center;gap:4px;';
    if (tile.icon) {
      var ic = labelRow.appendChild(document.createElement('span'));
      ic.style.cssText = 'font-size:11px;';
      ic.textContent = tile.icon;
    }
    var lblTxt = labelRow.appendChild(document.createElement('span'));
    lblTxt.textContent = tile.lbl;
    var val = cell.appendChild(document.createElement('div'));
    val.style.cssText = 'font-size:15px;font-weight:700;color:' +
      (isTotal ? 'var(--yellow)' : owing ? 'var(--danger)' : 'var(--success)') + ';';
    val.textContent = fmt(tile.val);
  });

  // Detail panel \u2014 shown when a tile is clicked
  var detailPanel = s2.appendChild(document.createElement('div'));
  detailPanel.id = 'tic-detail-panel-' + tid;
  detailPanel.style.cssText = 'margin-top:12px;display:none;';

  // \u2500\u2500 SECTION 2: Contact Details (below overview) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// \u2500\u2500 SECTION 1: Contact Details \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  var s1 = pp.appendChild(document.createElement('div'));
  s1.id = 'tic-contact-' + tid;
  s1.className = 'card';
  s1.style.marginBottom = '12px';

  // Header row \u2014 avatar, name, badges
  var hdr = s1.appendChild(document.createElement('div'));
  hdr.style.cssText = 'display:flex;align-items:center;gap:14px;margin-bottom:12px;';
  var av = hdr.appendChild(document.createElement('div'));
  av.style.cssText = 'width:52px;height:52px;border-radius:50%;background:var(--dark);display:flex;align-items:center;justify-content:center;font-size:20px;color:var(--yellow);flex-shrink:0;font-weight:600;';
  av.textContent = initials;
  var nameBlock = hdr.appendChild(document.createElement('div'));
  nameBlock.style.cssText = 'flex:1;min-width:0;';
  var nameRow = nameBlock.appendChild(document.createElement('div'));
  nameRow.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:2px;';
  var nameEl = nameRow.appendChild(document.createElement('span'));
  nameEl.style.cssText = 'font-size:20px;font-weight:700;';
  nameEl.textContent = tenantName(t);
  // Active/Inactive pill
  var activeBadge = nameRow.appendChild(document.createElement('span'));
  activeBadge.className = isActive ? 'pill pill-green' : 'pill pill-gray';
  activeBadge.style.cssText = 'font-size:10px;cursor:default;';
  activeBadge.textContent = isActive ? '\u25CF Active' : '\u25CB Inactive';
  // Collections flag
  var colBadge = nameRow.appendChild(document.createElement('span'));
  if (inCol) {
    colBadge.className = 'collections-badge';
    colBadge.style.cssText = 'font-size:10px;cursor:pointer;';
    colBadge.innerHTML = '&#128680; Collections &mdash; <u>Resolve</u>';
    colBadge.onclick = function(){ resolveCollectionFromTIC(tid); };
  } else {
    colBadge.className = 'pill pill-gray';
    colBadge.style.cssText = 'font-size:10px;cursor:pointer;border:1px dashed #aaa;';
    colBadge.textContent = '\u2691 Flag Collections';
    colBadge.onclick = function(){ openModal('modalFlagCollections'); setTimeout(function(){ var s=document.getElementById('col-tenant'); if(s) s.value=tid; },80); };
  }
  // Home & Community Care flag
  var hcBadge = nameRow.appendChild(document.createElement('span'));
  if (t.homeCare) {
    hcBadge.className = 'pill';
    hcBadge.style.cssText = 'font-size:10px;cursor:pointer;background:var(--info-blue);color:#fff;border:none;';
    hcBadge.innerHTML = '&#127968; H&amp;CC &mdash; <u>Remove</u>';
    hcBadge.onclick = function(){ toggleHomeCare(tid); };
  } else {
    hcBadge.className = 'pill pill-gray';
    hcBadge.style.cssText = 'font-size:10px;cursor:pointer;border:1px dashed #aaa;';
    hcBadge.textContent = '&#127968; Flag H&CC';
    hcBadge.onclick = function(){ toggleHomeCare(tid); };
  }
  var subEl = nameBlock.appendChild(document.createElement('div'));
  subEl.style.cssText = 'font-size:12px;color:var(--muted);';
  subEl.textContent = (t.unit || 'No unit assigned') + '  \u00B7  ' + (typeLabels[t.type]||t.type||'Unspecified');

  // Edit Tenant button — anchored to the right of the header. Phase F3A.
  var editBtn = hdr.appendChild(document.createElement('button'));
  editBtn.className = 'btn btn-primary btn-sm';
  editBtn.style.cssText = 'flex-shrink:0;';
  editBtn.innerHTML = '&#9998; Edit Tenant';
  editBtn.onclick = function(){ openEditTenant(tid); };

  function makeGrid(parent, fields) {
    var g = parent.appendChild(document.createElement('div'));
    g.className = 'tic-contact-grid'; g.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:1px;border:1px solid var(--border);border-radius:10px;overflow:hidden;background:var(--border);margin-bottom:14px;';
    fields.forEach(function(f){
      var cell = g.appendChild(document.createElement('div'));
      cell.style.cssText = 'background:var(--surface);padding:10px 14px;'+(f.span?'grid-column:span 2;':'');
      var lbl = cell.appendChild(document.createElement('div'));
      lbl.style.cssText = 'font-size:10px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.4px;margin-bottom:3px;display:flex;align-items:center;gap:4px;';
      lbl.textContent = f.lbl;
      if (f.ha) {
        var tag = lbl.appendChild(document.createElement('span'));
        tag.style.cssText = 'font-size:9px;color:var(--muted);font-weight:400;background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:0 4px;line-height:1.6;';
        tag.textContent = '\uD83D\uDD17 Housing App';
      }
      var val = cell.appendChild(document.createElement('div'));
      val.style.cssText = 'font-size:13px;font-weight:500;'+(f.color?'color:'+f.color+';':'');
      if (f.html) val.innerHTML = f.val; else val.textContent = f.val;
    });
    return g;
  }

  // Contact info
  var contactHdr = s1.appendChild(document.createElement('div'));
  contactHdr.style.cssText = 'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--muted);margin-bottom:8px;';
  contactHdr.textContent = 'Contact Information';
  makeGrid(s1, [
    {lbl:'First Name',    val:t.first||'Not on file',    ha:false},
    {lbl:'Last Name',     val:t.last||'Not on file',     ha:false},
    {lbl:'Phone',         val:t.phone||'Not on file',    ha:false},
    {lbl:'Email',         val:t.email||'Not on file',    ha:false},
    {lbl:'Date of Birth', val:t.dob||'Not on file',      ha:false},
    {lbl:'Band #',        val:t.bandNumber||'Not on file', ha:false},
  ]);

  // Address
  var addrHdr = s1.appendChild(document.createElement('div'));
  addrHdr.style.cssText = 'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--muted);margin-bottom:8px;';
  addrHdr.textContent = 'Property & Mailing Address';
  makeGrid(s1, [
    {lbl:'Unit / House #',    val:t.unit||'Not on file',              ha:false},
    {lbl:'Street Address',    val:t.street||'Not on file',            ha:false},
    {lbl:'Community',         val:t.community||(window.NATION_CONFIG && window.NATION_CONFIG.display_name || ""),       ha:false},
    {lbl:'Province / Territory', val:t.province||'Ontario',           ha:false},
    {lbl:'Postal Code',       val:t.postalCode||'Not on file',        ha:false},
    {lbl:'Mailing Address',   val:t.mailingAddress||'Same as above',  ha:false},
  ]);

  // Finance settings (Finance Module owns these)
  var finHdr = s1.appendChild(document.createElement('div'));
  finHdr.style.cssText = 'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--muted);margin-bottom:8px;';
  finHdr.textContent = 'Finance Settings';
  var finFields = [
    {lbl:'Monthly Rent',       val:fmt(t.rent)+' / month'},
    {lbl:'Invoice Preference', val:t.invPref==='email'?'\uD83D\uDCE7 Email':'\uD83D\uDDA8\uFE0F Print / Mail'},
    {lbl:'Auto-Pay',           val:t.autoPay?('\u2713 '+(t.autoPayType==='payroll'?'Payroll Deduction':'EFT')):'Manual', color:t.autoPay?'var(--success)':null},
    {lbl:'Tenant Type',        val:typePill(t.type), html:true},
    {lbl:'Hydro Account #',    val:t.hydroAcct||'Not on file'},
    {lbl:'Union Gas Account #',val:t.gasAcct||'Not on file'},
  ];
  makeGrid(s1, finFields);

  if (t.notes) {
    var notesEl = s1.appendChild(document.createElement('div'));
    notesEl.className = 'ibox yellow';
    notesEl.style.marginTop = '4px';
    notesEl.textContent = '\uD83D\uDCDD ' + t.notes;
  }

  // \u2500\u2500 SECTION 3: Detail tabs (Transaction History + Documents) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  // History uses shared getAllTransactions() + std-* design system.
  // Documents uses the DocLibrary factory. Both live inside a single tab
  // strip to keep the TIC from pancake-stacking as more per-tenant data
  // surfaces over time.
  var detailWrap = pp.appendChild(document.createElement('div'));
  detailWrap.style.marginBottom = '12px';
  detailWrap.innerHTML =
    '<div class="tabs" style="margin-bottom:0;">' +
      '<button class="tab-btn active" data-tic-tab="history" onclick="showTicDetailTab(\''+tid+'\',\'history\')">Transaction History</button>' +
      '<button class="tab-btn" data-tic-tab="docs" onclick="showTicDetailTab(\''+tid+'\',\'docs\')">Documents</button>' +
    '</div>' +
    '<div class="tab-panel on" id="tic-tab-history-'+tid+'"></div>' +
    '<div class="tab-panel" id="tic-tab-docs-'+tid+'"></div>';

  // ── History panel content ──
  var s3 = document.getElementById('tic-tab-history-'+tid);
  s3.className = 'tab-panel on std-table-card';
  s3.id = 'tic-history-' + tid;   // preserve existing id for renderTicHistory

  s3.innerHTML =
    '<div class="std-table-hdr">'+
      '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">'+
        '<h3 style="margin:0;font-size:15px;font-weight:700;">Transaction History</h3>'+
        '<span class="std-table-count" id="tic-hist-count-'+tid+'">\u2014</span>'+
      '</div>'+
      '<div style="display:flex;gap:6px;">'+
        '<button class="btn btn-ghost btn-sm" onclick="exportTicHistory(\''+tid+'\')">&#128196; Export CSV</button>'+
      '</div>'+
    '</div>'+
    // Ledger category chips
    '<div class="std-filter-row" style="flex-wrap:wrap;">'+
      '<span class="std-filter-label">Category</span>'+
      '<div id="tic-hist-chips-'+tid+'" style="display:flex;gap:6px;flex-wrap:wrap;">'+
        '<button type="button" class="btn btn-sm tic-hist-chip is-active" data-ledger="all" onclick="toggleTicHistChip(\''+tid+'\',\'all\')">All</button>'+
        '<button type="button" class="btn btn-sm tic-hist-chip" data-ledger="rent" onclick="toggleTicHistChip(\''+tid+'\',\'rent\')">Rent</button>'+
        '<button type="button" class="btn btn-sm tic-hist-chip" data-ledger="arrangement" onclick="toggleTicHistChip(\''+tid+'\',\'arrangement\')">Arrangement</button>'+
        '<button type="button" class="btn btn-sm tic-hist-chip" data-ledger="loans" onclick="toggleTicHistChip(\''+tid+'\',\'loans\')">Loans</button>'+
        '<button type="button" class="btn btn-sm tic-hist-chip" data-ledger="journal" onclick="toggleTicHistChip(\''+tid+'\',\'journal\')">Journal</button>'+
      '</div>'+
    '</div>'+
    // Standard filter row: type / status / date / amount
    '<div class="std-filter-row" style="flex-wrap:wrap;">'+
      '<span class="std-filter-label">Type</span>'+
      '<select class="std-filter-control narrow" id="tic-hist-type-'+tid+'" onchange="renderTicHistory(\''+tid+'\')">'+
        '<option value="all">All</option>'+
        '<option value="charge">Charges</option>'+
        '<option value="payment">Payments</option>'+
      '</select>'+
      '<div class="std-filter-divider"></div>'+
      '<span class="std-filter-label">Status</span>'+
      '<select class="std-filter-control narrow" id="tic-hist-status-'+tid+'" onchange="renderTicHistory(\''+tid+'\')">'+
        '<option value="all">All</option>'+
        '<option value="posted">Posted</option>'+
        '<option value="pending">Pending</option>'+
        '<option value="reversed">Voided / Reversed</option>'+
      '</select>'+
      '<div class="std-filter-divider"></div>'+
      '<span class="std-filter-label">Date</span>'+
      '<input type="date" class="std-filter-control narrow" id="tic-hist-from-'+tid+'" onchange="renderTicHistory(\''+tid+'\')" title="From"/>'+
      '<span style="color:var(--muted);font-size:11px;">to</span>'+
      '<input type="date" class="std-filter-control narrow" id="tic-hist-to-'+tid+'" onchange="renderTicHistory(\''+tid+'\')" title="To"/>'+
      '<div class="std-filter-divider"></div>'+
      '<span class="std-filter-label">Amount</span>'+
      '<div class="std-amount-range">'+
        '<input type="number" class="std-filter-control narrow" id="tic-hist-amtmin-'+tid+'" onchange="renderTicHistory(\''+tid+'\')" placeholder="Min" style="width:80px;"/>'+
        '<span style="color:var(--muted);font-size:11px;">\u2013</span>'+
        '<input type="number" class="std-filter-control narrow" id="tic-hist-amtmax-'+tid+'" onchange="renderTicHistory(\''+tid+'\')" placeholder="Max" style="width:80px;"/>'+
      '</div>'+
      '<div class="std-filter-spacer"></div>'+
      '<button class="std-filter-clear" onclick="clearTicHistoryFilters(\''+tid+'\')">Clear</button>'+
    '</div>'+
    '<div style="overflow-x:auto;">'+
      '<table class="std-table" id="tic-hist-table-'+tid+'">'+
        '<thead>'+
          '<tr>'+
            '<th>Date</th>'+
            '<th>Category</th>'+
            '<th>Description</th>'+
            '<th class="std-cell-right">Charge</th>'+
            '<th class="std-cell-right">Payment</th>'+
            '<th>Method</th>'+
            '<th>Status</th>'+
            '<th class="std-cell-tail">Actions</th>'+
          '</tr>'+
        '</thead>'+
        '<tbody id="tic-hist-body-'+tid+'">'+
          '<tr class="empty-row"><td colspan="8">Loading\u2026</td></tr>'+
        '</tbody>'+
      '</table>'+
    '</div>';

  // Initial history render (newest-first)
  renderTicHistory(tid);

  // ── Documents panel (lazy-mounted on first tab open; see showTicDetailTab) ──
  // Note: we don't mount DocLibrary up-front because it triggers a Supabase
  // fetch; mount on first switch to the Documents tab to keep the initial
  // TIC open snappy.
}

// Switch between the TIC detail tabs. Lazy-mounts DocLibrary on first
// Documents click so the initial TIC render doesn't pay that network cost.
window._ticDocLibs = window._ticDocLibs || {};
function showTicDetailTab(tid, tab) {
  var histPanel = document.getElementById('tic-tab-history-' + tid);
  var docsPanel = document.getElementById('tic-tab-docs-' + tid);
  if (!histPanel || !docsPanel) return;

  // Find the sibling tab buttons (scoped to this tenant's tabs strip)
  var tabsWrap = histPanel.parentElement;
  if (tabsWrap) {
    tabsWrap.querySelectorAll('[data-tic-tab]').forEach(function(btn){
      btn.classList.toggle('active', btn.getAttribute('data-tic-tab') === tab);
    });
  }
  histPanel.classList.toggle('on', tab === 'history');
  docsPanel.classList.toggle('on', tab === 'docs');

  if (tab === 'docs' && !window._ticDocLibs[tid]) {
    docsPanel.innerHTML = '';
    if (window.DocLibrary && typeof SUPABASE_URL === 'string' && SUPABASE_URL) {
      // NOTE: finance_audit_log has a materially different schema than
      // housing_audit_log — occurred_at (not created_at), actor_email +
      // actor_role (not actor), detail jsonb (not text), plus summary and
      // tenant_id columns. The factory is currently hardcoded to the
      // housing shape. Uploads to finance storage should succeed, but
      // the audit-log write will 400 and the list will not persist.
      // This is a known limitation pending Path A schema-normalization
      // work. TODO(Path-A): wire a customSaveMeta opt for finance.
      window._ticDocLibs[tid] = window.DocLibrary.create(docsPanel, {
        entityType:    'tenant',
        entityId:      tid,
        pathPrefix:    'tenants/' + tid,
        supabaseUrl:   SUPABASE_URL,
        supabaseAnon:  SUPABASE_ANON,
        storageBucket: (window.NATION_CONFIG && window.NATION_CONFIG.storage_bucket) || 'housing-files',
        auditTable:    'finance_audit_log',
        getActor:      function(){ return (typeof CURRENT_USER !== 'undefined' ? CURRENT_USER : 'staff'); },
        categories: [
          { key:'id',      label:'ID',            icon:'\uD83E\uDDFE' },
          { key:'lease',   label:'Lease',         icon:'\uD83D\uDCC4' },
          { key:'hydro',   label:'Hydro Bill',    icon:'\u26A1'      },
          { key:'gas',     label:'Gas Bill',      icon:'\uD83D\uDD25' },
          { key:'cheque',  label:'Void Cheque',   icon:'\uD83C\uDFE6' },
          { key:'notice',  label:'Notice / Letter', icon:'\uD83D\uDCEC' },
          { key:'image',   label:'Image',         icon:'\uD83D\uDDBC\uFE0F' },
          { key:'other',   label:'Other',         icon:'\uD83D\uDCCE' }
        ]
      });
    } else {
      docsPanel.innerHTML = '<div class="ibox" style="margin:14px;">Document library is unavailable (storage not configured).</div>';
    }
  }
}

function showTicDetail(tid, key, balGrid, clickedCell) {
  var t = getTenant(tid);
  var d = getData();
  var v = (calcAllTotals(d))[tid] || {};
  var panelId = 'tic-detail-panel-' + tid;
  var panel = document.getElementById(panelId);
  if (!panel) return;

  // Highlight active tile, deactivate others
  balGrid.querySelectorAll('div[style*="cursor:pointer"]').forEach(function(c){
    c._active = false;
    c.style.opacity = '1';
    c.style.outline = 'none';
  });
  var clickedTile = clickedCell || null;
  if (clickedTile) { clickedTile._active = true; clickedTile.style.outline = '2px solid var(--yellow)'; }

  // If same tile clicked again, toggle off
  if (panel._currentKey === key && panel.style.display !== 'none') {
    panel.style.display = 'none';
    panel._currentKey = null;
    var contactCard = document.getElementById('tic-contact-' + tid);
    if (contactCard) contactCard.style.display = '';
    return;
  }
  panel._currentKey = key;
  panel.style.display = 'block';
  // Hide contact section when detail panel is active
  var contactCard = document.getElementById('tic-contact-' + tid);
  if (contactCard) contactCard.style.display = 'none';

  var html = '';
  var title = '', icon = '', entries = [];

  if (key === 'rent') {
    title = '\uD83C\uDFE0 Rent Account';
    // Details
    html += '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--border);border-radius:10px;overflow:hidden;margin-bottom:14px;">';
    var details = [
      {lbl:'Monthly Rent',       val: fmt(t.rent)},
      {lbl:'Payment Frequency',  val: 'Monthly'},
      {lbl:'Invoice Preference', val: t.invPref==='email'?'\uD83D\uDCE7 Email':'\uD83D\uDDA8\uFE0F Print / Mail'},
      {lbl:'Auto-Pay',           val: t.autoPay ? '\u2713 '+(t.autoPayType==='payroll'?'Payroll Deduction':'EFT') : 'Manual'},
      {lbl:'Current Balance',    val: fmt(Math.max(0, v.rent||0)), color:(v.rent||0)>0?'var(--danger)':'var(--success)'},
      {lbl:'Status',             val: (v.rent||0)<=0 ? '\u2713 Current' : 'Arrears'},
    ];
    details.forEach(function(d2){
      html += '<div style="background:var(--surface);padding:10px 14px;">' +
        '<div style="font-size:10px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.4px;margin-bottom:3px;">'+d2.lbl+'</div>' +
        '<div style="font-size:13px;font-weight:600;'+(d2.color?'color:'+d2.color+';':'')+'">' + d2.val + '</div>' +
        '</div>';
    });
    html += '</div>';
    // Ledger
    entries = d.rentLedger.filter(function(r){ return r.tenantId===tid && r.status!=='reversed'; })
                          .sort(function(a,b){ return b.date.localeCompare(a.date); });
    html += buildLedgerTable(entries, 'rent');

  } else if (key === 'arrangement') {
    title = '\uD83D\uDCCB Payment Arrangements';
    var arr = d.arrangements.filter(function(a){ return a.tenantId===tid; });
    if (!arr.length) {
      html += '<div style="text-align:center;padding:20px;"><p style="color:var(--muted);margin-bottom:12px;">No arrangements on file.</p><button class="btn btn-primary btn-sm" onclick="openModal(\'modalNewArrangement\');document.getElementById(\'na-tenant\').value=\'' + tid + '\'">+ New Arrangement</button></div>';
    } else {
      arr.forEach(function(a){
        html += '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--border);border-radius:10px;overflow:hidden;margin-bottom:14px;">';
        var aDetails = [
          {lbl:'Reference',        val: a.ref},
          {lbl:'Total Owing',      val: fmt(a.totalOwing)},
          {lbl:'Monthly Payment',  val: fmt(a.monthlyPayment)},
          {lbl:'Start Date',       val: a.startDate},
          {lbl:'Status',           val: a.status},
          {lbl:'Notes',            val: a.notes||'\u2014'},
        ];
        aDetails.forEach(function(d2){
          html += '<div style="background:var(--surface);padding:10px 14px;">' +
            '<div style="font-size:10px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.4px;margin-bottom:3px;">'+d2.lbl+'</div>' +
            '<div style="font-size:13px;font-weight:600;">' + d2.val + '</div>' +
            '</div>';
        });
        html += '</div>';
        var payments = d.arrPayments.filter(function(p){ return p.arrId===a.id; })
                                    .sort(function(a2,b){ return b.date.localeCompare(a2.date); });
        html += buildLedgerTable(payments, 'arrangement');
      });
    }

  } else if (key === 'loan') {
    title = '\uD83D\uDCB0 Loans';
    var loans = d.loanList.filter(function(l){ return l.tenantId===tid; });
    if (!loans.length) {
      html += '<div style="text-align:center;padding:20px;"><p style="color:var(--muted);margin-bottom:12px;">No loans on file.</p><button class="btn btn-primary btn-sm" onclick="openModal(\'modalNewLoan\');document.getElementById(\'ln-tenant\').value=\'' + tid + '\';calcLoan();">+ New Loan</button></div>';
    } else {
      loans.forEach(function(ln){
        html += '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--border);border-radius:10px;overflow:hidden;margin-bottom:14px;">';
        var paid = d.loanPayments.filter(function(p){ return p.loanId===ln.id; })
                                  .reduce(function(sum,p){ return sum+p.amount; }, 0);
        var remaining = Math.max(0, ln.principal - paid);
        var lDetails = [
          {lbl:'Loan Type',        val: ({renovation:'Renovation','rent-to-own':'Rent-to-Own',utilities:'Utilities'}[ln.type]||ln.type)},
          {lbl:'Principal',        val: fmt(ln.principal)},
          {lbl:'Remaining',        val: fmt(remaining), color:remaining>0?'var(--danger)':'var(--success)'},
          {lbl:'Monthly Payment',  val: fmt(ln.payment)},
          {lbl:'Interest Rate',    val: ln.rateType==='none'?'0% (Interest-free)':ln.rate+'% '+ln.rateType},
          {lbl:'Term',             val: ln.term+' months'},
        ];
        lDetails.forEach(function(d2){
          html += '<div style="background:var(--surface);padding:10px 14px;">' +
            '<div style="font-size:10px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.4px;margin-bottom:3px;">'+d2.lbl+'</div>' +
            '<div style="font-size:13px;font-weight:600;'+(d2.color?'color:'+d2.color+';':'')+'">' + d2.val + '</div>' +
            '</div>';
        });
        html += '</div>';
        var lPayments = d.loanPayments.filter(function(p){ return p.loanId===ln.id; })
                                       .sort(function(a,b){ return b.date.localeCompare(a.date); });
        html += buildLedgerTable(lPayments, 'loan');
      });
    }
  }

  panel.innerHTML =
    '<div style="border-top:2px solid var(--yellow);padding-top:14px;">' +
    '<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px;margin-bottom:12px;">' +
      '<div style="font-size:13px;font-weight:700;">' + title + '</div>' +
      '<div style="display:flex;gap:6px;flex-wrap:wrap;">' +
        (key === 'loan'        ? '' : '') +
        (key === 'arrangement' ? '' : '') +
        (d.loanList.some(function(l){ return l.tenantId === tid; }) ? '<button class="btn btn-ghost btn-sm" style="font-size:11px;" onclick="openEditTenant(\'' + tid + '\')">✎ Edit Tenant</button>' : '') +
      '</div>' +
    '</div>' +
    html +
    '</div>';
}

// \u2500\u2500 TIC Transaction History \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// Per-tenant transaction history section embedded in the TIC (renderTenantProfile).
// Reuses: getAllTransactions() (shared with the Transactions page), methodLabel(),
// openVoucher(), the std-* design system. Each tenant's filter state lives in
// window._ticHistState[tid] so chip-toggles survive re-renders.

window._ticHistState = window._ticHistState || {};

function _ticHistGetState(tid) {
  if (!window._ticHistState[tid]) {
    window._ticHistState[tid] = { ledger:'all' }; // default: all categories
  }
  return window._ticHistState[tid];
}

function toggleTicHistChip(tid, ledger) {
  var st = _ticHistGetState(tid);
  st.ledger = ledger;
  // Update visual state on chip buttons
  var group = document.getElementById('tic-hist-chips-' + tid);
  if (group) {
    group.querySelectorAll('.tic-hist-chip').forEach(function(btn){
      if (btn.getAttribute('data-ledger') === ledger) btn.classList.add('is-active');
      else btn.classList.remove('is-active');
    });
  }
  renderTicHistory(tid);
}

function clearTicHistoryFilters(tid) {
  var st = _ticHistGetState(tid);
  st.ledger = 'all';
  ['type','status','from','to','amtmin','amtmax'].forEach(function(k){
    var el = document.getElementById('tic-hist-' + k + '-' + tid);
    if (el) el.value = (k === 'type' || k === 'status') ? 'all' : '';
  });
  // Reset chip visuals
  var group = document.getElementById('tic-hist-chips-' + tid);
  if (group) {
    group.querySelectorAll('.tic-hist-chip').forEach(function(btn){
      if (btn.getAttribute('data-ledger') === 'all') btn.classList.add('is-active');
      else btn.classList.remove('is-active');
    });
  }
  renderTicHistory(tid);
}

function _ticHistFilteredRows(tid) {
  var st = _ticHistGetState(tid);
  // getAllTransactions() is the shared data source (see renderTransactions).
  // It returns every txn across rent/arrangement/loans/journal already sorted
  // newest-first (desc by date string).
  var all = (typeof getAllTransactions === 'function') ? getAllTransactions() : [];
  // Narrow to this tenant
  var rows = all.filter(function(r){ return r.tenantId === tid; });
  // Category chip
  if (st.ledger && st.ledger !== 'all') {
    rows = rows.filter(function(r){
      // getAllTransactions normalizes loan payments to ledger:'loans'; keep it tolerant
      if (st.ledger === 'loans') return r.ledger === 'loans' || r.ledger === 'loan';
      return r.ledger === st.ledger;
    });
  }
  // Type: charge vs payment
  var typ = (document.getElementById('tic-hist-type-' + tid)||{}).value || 'all';
  if (typ === 'charge')  rows = rows.filter(function(r){ return (r.charge||0) > 0; });
  if (typ === 'payment') rows = rows.filter(function(r){ return (r.payment||0) > 0; });
  // Status
  var status = (document.getElementById('tic-hist-status-' + tid)||{}).value || 'all';
  if (status !== 'all') {
    rows = rows.filter(function(r){
      var s = (r.status||'').toLowerCase();
      if (status === 'posted')   return s === 'posted' || s === 'approved' || s === '';
      if (status === 'pending')  return s === 'pending' || s === 'pending-ed';
      if (status === 'reversed') return s === 'reversed' || s === 'voided';
      return true;
    });
  }
  // Date range
  var from = (document.getElementById('tic-hist-from-' + tid)||{}).value || '';
  var to   = (document.getElementById('tic-hist-to-'   + tid)||{}).value || '';
  if (from) rows = rows.filter(function(r){ return (r.date||'') >= from; });
  if (to)   rows = rows.filter(function(r){ return (r.date||'') <= to; });
  // Amount range (applies to the larger of charge/payment per row)
  var amin = parseFloat((document.getElementById('tic-hist-amtmin-' + tid)||{}).value);
  var amax = parseFloat((document.getElementById('tic-hist-amtmax-' + tid)||{}).value);
  if (!isNaN(amin)) rows = rows.filter(function(r){ return Math.max(r.charge||0, r.payment||0) >= amin; });
  if (!isNaN(amax)) rows = rows.filter(function(r){ return Math.max(r.charge||0, r.payment||0) <= amax; });
  return rows;
}

function renderTicHistory(tid) {
  var body = document.getElementById('tic-hist-body-' + tid);
  var countEl = document.getElementById('tic-hist-count-' + tid);
  if (!body) return;

  var rows = _ticHistFilteredRows(tid);
  var totalAll = (typeof getAllTransactions === 'function')
    ? getAllTransactions().filter(function(r){ return r.tenantId === tid; }).length
    : 0;

  if (countEl) {
    countEl.textContent = rows.length === totalAll
      ? (rows.length + ' total')
      : (rows.length + ' shown \u00B7 ' + totalAll + ' total');
  }

  var ledgerPill = {
    'rent':        '<span class="std-pill std-pill-info">Rent</span>',
    'arrangement': '<span class="std-pill std-pill-pending">Arrangement</span>',
    'loans':       '<span class="std-pill std-pill-info">Loans</span>',
    'loan':        '<span class="std-pill std-pill-info">Loans</span>',
    'journal':     '<span class="std-pill std-pill-voided">Journal</span>',
    'utility':     '<span class="std-pill std-pill-pending">Utility</span>'
  };

  function stdStatusPill(st){
    st = (st||'').toLowerCase();
    if (st === 'posted' || st === 'approved' || st === '') return '<span class="std-pill std-pill-paid">Posted</span>';
    if (st === 'pending' || st === 'pending-ed') return '<span class="std-pill std-pill-pending">'+(st==='pending-ed'?'Pending ED':'Pending')+'</span>';
    if (st === 'reversed' || st === 'voided') return '<span class="std-pill std-pill-voided">'+(st==='voided'?'Voided':'Reversed')+'</span>';
    if (st === 'overdue') return '<span class="std-pill std-pill-overdue">Overdue</span>';
    return '<span class="std-pill std-pill-info">'+st+'</span>';
  }

  if (!rows.length) {
    body.innerHTML = totalAll === 0
      ? '<tr class="empty-row"><td colspan="8">No transactions yet for this tenant.</td></tr>'
      : '<tr class="empty-row"><td colspan="8">No transactions match the current filters. <a href="#" onclick="clearTicHistoryFilters(\''+tid+'\');return false;" style="color:var(--text);text-decoration:underline;">Clear filters</a> to show all.</td></tr>';
    return;
  }

  // Voucher cache (shared pattern used on the Transactions page)
  window._txnVoucherCache = window._txnVoucherCache || {};

  body.innerHTML = rows.map(function(r){
    var cacheKey = 'txn_' + r.id;
    window._txnVoucherCache[cacheKey] = r;
    var isReversed = (r.status === 'reversed' || r.status === 'voided');
    var canVoid = !isReversed && r.id;
    // escape ledger/id for inline attribute use
    var ledgerAttr = (r.ledger||'').replace(/"/g,'&quot;');
    var idAttr = (r.id||'').replace(/"/g,'&quot;');
    return '<tr'+(isReversed?' style="opacity:.55;"':'')+'>'+
      '<td>'+(r.date||'<span class="std-cell-dash">\u2014</span>')+'</td>'+
      '<td>'+(ledgerPill[r.ledger]||'<span class="std-pill std-pill-info">'+(r.ledger||'\u2014')+'</span>')+'</td>'+
      '<td style="max-width:280px;white-space:normal;">'+(r.desc||'<span class="std-cell-dash">\u2014</span>')+'</td>'+
      '<td class="std-cell-right">'+((r.charge||0)>0?'<span class="amt-debit">'+fmt(r.charge)+'</span>':'<span class="std-cell-dash">\u2014</span>')+'</td>'+
      '<td class="std-cell-right">'+((r.payment||0)>0?'<span class="amt-credit">'+fmt(r.payment)+'</span>':'<span class="std-cell-dash">\u2014</span>')+'</td>'+
      '<td style="font-size:12px;">'+(typeof methodLabel==='function'?methodLabel(r.method):(r.method||''))+'</td>'+
      '<td>'+stdStatusPill(r.status)+'</td>'+
      '<td class="std-cell-tail" style="white-space:nowrap;">'+
        '<button class="btn btn-ghost btn-sm" title="View voucher" onclick="openVoucher(window._txnVoucherCache[\'txn_'+r.id+'\'])">&#128203;</button> '+
        (canVoid
          ? '<button class="btn btn-ghost btn-sm" title="Void / reverse this transaction" style="color:var(--danger);" onclick="voidTicTransaction(\''+ledgerAttr+'\',\''+idAttr+'\',\''+tid+'\')">&#8634; Void</button>'
          : '<span class="std-cell-dash" style="font-size:11px;">\u2014</span>')+
      '</td>'+
    '</tr>';
  }).join('');
}

function exportTicHistory(tid) {
  if (typeof exportStdCSV !== 'function') { toast('CSV export unavailable.'); return; }
  var t = getTenant(tid);
  var name = t ? tenantName(t).replace(/\s+/g,'_') : 'tenant';
  var rows = _ticHistFilteredRows(tid);
  var headers = ['Date','Category','Description','Charge','Payment','Method','Status','Ref'];
  var out = rows.map(function(r){
    return [
      r.date||'',
      r.ledger||'',
      r.desc||'',
      (r.charge||0).toFixed(2),
      (r.payment||0).toFixed(2),
      r.method||'',
      r.status||'',
      r.ref||''
    ];
  });
  exportStdCSV('tenant-history-' + name, headers, out);
}

// Approval-ready void. For now: immediate void with reason prompt and audit
// entry. Later, this will branch on user role to queue the reversal for
// approval instead of applying it immediately \u2014 the call-site signature
// stays the same.
function voidTicTransaction(ledger, id, tid) {
  if (!id || !ledger) { toast('Cannot void \u2014 missing reference.'); return; }
  var collectionMap = {
    rent: 'rentLedger', utility: 'rentLedger',
    arrangement: 'arrPayments',
    loans: 'loanPayments', loan: 'loanPayments',
    journal: 'journalEntries'
  };
  var collectionKey = collectionMap[ledger];
  if (!collectionKey) { toast('Cannot void \u2014 unknown ledger type.'); return; }
  var d = getData();
  var rec = (d[collectionKey]||[]).find(function(x){ return x.id === id; });
  if (!rec) { toast('Transaction not found \u2014 it may have already been voided.'); return; }
  if (finIsVoided(rec)) { toast('Already voided.'); return; }
  showVoidModal({
    label: 'Void Transaction',
    preview: escapeHtml(rec.desc || rec.memo || ledger) + (rec.amount || rec.charge || rec.payment ? ' &nbsp;&middot;&nbsp; ' + fmt(rec.amount || rec.charge || rec.payment) : '') + (rec.date ? ' &nbsp;&middot;&nbsp; ' + rec.date : '')
  }, function(reason) {
    voidLedgerEntry(collectionKey, id, reason);
    toast('Transaction voided.');
    renderTicHistory(tid);
    if (typeof renderTenantProfile === 'function') renderTenantProfile(tid);
    if (typeof renderDashboard === 'function') renderDashboard();
  });
}

// \u2500\u2500 Ledger row actions \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function openEntryVoucher(eid) {
  var cached = _entryCache[eid];
  if (!cached) { toast('Entry not found in cache.'); return; }
  var e = cached.entry;
  if (e.type === 'payment' || e.type === 'adjustment' || (!e.charge && (e.payment||e.amount))) {
    openVoucher({
      date:e.date, tenantId:e.tenantId, ledger:'rent',
      desc:e.desc||e.memo||e.notes||'Payment',
      charge:0, payment:e.payment||e.amount||0,
      method:e.method||'', status:e.status||'posted',
      id:e.id, ref:e.ref||e.id, invoiceBalance:0, payments:[]
    });
  } else {
    openInvoiceVoucher({
      date:e.date, tenantId:e.tenantId, ledger:'rent',
      desc:e.desc||e.memo||'Invoice',
      charge:e.charge||0, payment:0, method:'',
      status:e.status||'approved', id:e.id, ref:e.ref||e.id,
      invoiceBalance:e.charge||0, payments:[],
      glCode:e.glCode||'4100', glName:e.glName||'Rent Revenue'
    });
  }
}

// (_pendingReversal removed with the retired submitReversal flow)
var _pendingAdjustment = null;

function reverseEntry(entryId, ledgerType) {
  // RETIRED the legacy "pending reversal" flow (submitReversal): it pushed a
  // negative-amount row whose money effect applied IMMEDIATELY despite the
  // 'pending-ed' label, offered no approve action anywhere, and duplicated the
  // newer void pattern. This entry point now routes straight to the audited
  // void flow (reason modal -> voidLedgerEntry -> reversal row + audit).
  var cached = _entryCache[entryId];
  if (!cached) { toast('Entry not found.'); return; }
  var e = cached.entry;
  var key = ledgerType === 'arrangement' ? 'arrPayments'
          : ledgerType === 'loan'        ? 'loanPayments'
          : 'rentLedger';
  showVoidModal({
    label: 'Void Entry',
    preview: detailCell('Date', e.date) +
             detailCell('Description', e.desc || e.memo || '\u2014') +
             detailCell('Amount', fmt(e.charge > 0 ? e.charge : (e.payment || e.amount || 0)))
  }, function(reason){
    voidLedgerEntry(key, entryId, reason);
    if (e.tenantId) renderTenantProfile(e.tenantId);
  });
}

function openAdjustment(entryId, ledgerType) {
  var cached = _entryCache[entryId];
  if (!cached) { toast('Entry not found.'); return; }
  var e = cached.entry;
  var t = getTenant(e.tenantId);
  _pendingAdjustment = {entryId: entryId, ledgerType: ledgerType};
  var det = document.getElementById('adj-entry-details');
  if (det) det.innerHTML =
    detailCell('Date', e.date) +
    detailCell('Description', e.desc||e.memo||'\u2014') +
    detailCell('Charge', e.charge>0 ? fmt(e.charge) : '\u2014') +
    detailCell('Payment', (e.payment||e.amount)>0 ? fmt(e.payment||e.amount) : '\u2014') +
    detailCell('Method', e.method||'\u2014') +
    detailCell('Tenant', t ? tenantName(t) : '\u2014');
  var dateEl = document.getElementById('adj-date');
  var amtEl  = document.getElementById('adj-amount');
  var rsEl   = document.getElementById('adj-reason');
  var tyEl   = document.getElementById('adj-type');
  var prev   = document.getElementById('adj-preview');
  if (dateEl) dateEl.value = today();
  if (amtEl)  amtEl.value  = '';
  if (rsEl)   rsEl.value   = '';
  if (tyEl)   tyEl.value   = 'credit';
  if (prev)   prev.style.display = 'none';
  openModal('modalAdjustEntry');
}

function onAdjTypeChange() {
  var amt  = parseFloat((document.getElementById('adj-amount')||{}).value)||0;
  var type = (document.getElementById('adj-type')||{}).value;
  var prev = document.getElementById('adj-preview');
  if (!prev) return;
  if (!amt) { prev.style.display='none'; return; }
  prev.style.display = 'block';
  var isCredit = type==='credit';
  prev.innerHTML = '<strong>Preview:</strong> Will post a <span style="color:'+
    (isCredit?'var(--success)':'var(--danger)')+';font-weight:700;">'+
    (isCredit?'credit of '+fmt(amt)+' (reduces balance)':'charge of '+fmt(amt)+' (increases balance)')+
    '</span> to the selected GL account.';
}

function submitAdjustment() {
  if (!_pendingAdjustment) return;
  var amount  = parseFloat((document.getElementById('adj-amount')||{}).value)||0;
  var adjType = (document.getElementById('adj-type')||{}).value||'credit';
  var reason  = (document.getElementById('adj-reason')||{}).value||'';
  var adjDate = (document.getElementById('adj-date')||{}).value||today();
  var gl      = (document.getElementById('adj-gl')||{}).value||'9000';
  if (!amount||amount<=0) { toast('Please enter a valid amount.'); return; }
  if (!reason.trim())     { toast('Please enter a reason.'); return; }
  var isCredit = adjType==='credit';
  var d = getData();
  var ledgerType = _pendingAdjustment.ledgerType;
  var entryId    = _pendingAdjustment.entryId;
  var ledger = ledgerType==='arrangement' ? d.arrPayments :
               ledgerType==='loan'        ? d.loanPayments : d.rentLedger;
  var entry = ledger.find(function(e){ return e.id===entryId; });
  if (!entry) { toast('Original entry not found.'); return; }
  var adj = {
    id:uid(), tenantId:entry.tenantId, date:adjDate,
    desc:'Adjustment: '+reason,
    charge: isCredit?0:amount, payment:isCredit?amount:0,
    type:'adjustment', method:'adjustment',
    gl:gl, glCode:gl, status:'approved',
    ref:'ADJ-'+entryId.slice(-6).toUpperCase(), linkedEntryId:entryId
  };
  ledger.push(adj);
  auditLog('create', ledgerType, adj.id,
    'Adjustment posted: '+reason+' \u2014 '+(isCredit?'Credit':'Charge')+' '+fmt(amount), null, adj);
  saveData(d);
  closeModal('modalAdjustEntry');
  _pendingAdjustment = null;
  if (entry.tenantId) renderTenantProfile(entry.tenantId);
}

function detailCell(lbl, val) {
  return '<div>' +
    '<div style="font-size:10px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.4px;margin-bottom:3px;">'+lbl+'</div>' +
    '<div style="font-size:13px;font-weight:500;">'+(val||'\u2014')+'</div>' +
  '</div>';
}


function buildLedgerTable(entries, type) {
  if (!entries.length) return '<div style="text-align:center;padding:16px;color:var(--muted);font-size:13px;">No entries on file.</div>';

  // Cache entries by ID so onclick handlers can look them up safely
  entries.forEach(function(e){ _entryCache[e.id] = {entry:e, type:type}; });

  var running = 0;
  var rows = entries.slice().reverse().map(function(e){
    var charge  = e.charge  || e.debit  || 0;
    var payment = e.payment || e.credit || e.amount || 0;
    running += charge - payment;
    return {e:e, charge:charge, payment:payment, bal:running};
  }).reverse();

  var html = '<div class="tbl-wrap"><table class="tbl">' +
    '<thead><tr><th>Date</th><th>Description</th><th>Charge</th><th>Payment</th><th>Balance</th><th>Method</th><th></th></tr></thead><tbody>';

  rows.forEach(function(r){
    var e = r.e;
    // finIsVoided covers both the legacy 'reversed' status and the current
    // void pattern (status 'void' / voidsId), so voided rows strike through.
    var isReversed = (typeof finIsVoided === 'function') ? finIsVoided(e) : (e.status === 'reversed');
    var desc = e.desc || e.memo || e.notes || '\u2014';
    var eid  = e.id;

    var descCell = isReversed
      ? '<span style="text-decoration:line-through;color:var(--muted);">' + desc + '</span>'
      : '<a href="#" style="color:var(--text);text-decoration:underline;text-underline-offset:2px;" ' +
          'onclick="event.preventDefault();openEntryVoucher(\'' + eid + '\')">' + desc + '</a>';

    var actions = !isReversed
      ? '<button class="btn btn-ghost btn-sm" style="font-size:10px;padding:2px 6px;" ' +
            'onclick="reverseEntry(\'' + eid + '\',\'' + type + '\')">\u2298 Void</button> ' +
        '<button class="btn btn-ghost btn-sm" style="font-size:10px;padding:2px 6px;" ' +
            'onclick="openAdjustment(\'' + eid + '\',\'' + type + '\')">\u00B1 Adjust</button>'
      : '';

    html += '<tr style="' + (isReversed ? 'opacity:.5;' : '') + '">' +
      '<td style="white-space:nowrap;">' + e.date + '</td>' +
      '<td>' + descCell + '</td>' +
      '<td>' + (r.charge  > 0 ? '<span class="amt-debit">'  + fmt(r.charge)  + '</span>' : '\u2014') + '</td>' +
      '<td>' + (r.payment > 0 ? '<span class="amt-credit">' + fmt(r.payment) + '</span>' : '\u2014') + '</td>' +
      '<td style="font-weight:600;color:' + (r.bal>0.005?'var(--danger)':r.bal<-0.005?'var(--success)':'var(--muted)') + ';">' + fmt(r.bal) + '</td>' +
      '<td style="text-transform:capitalize;">' + (e.method || '\u2014') + '</td>' +
      '<td style="white-space:nowrap;">' + actions + '</td>' +
    '</tr>';
  });

  html += '</tbody></table></div>';
  return html;
}


function updateModalTenantContext(tenantSelId, contextDivId) {
  var tid = (document.getElementById(tenantSelId)||{}).value;
  var el = document.getElementById(contextDivId);
  if (!el) return;
  if (!tid) { el.innerHTML = ''; return; }
  var t = getTenant(tid);
  if (!t) { el.innerHTML = ''; return; }
  var d = getData();
  var totals = calcAllTotals(d);
  var v = totals[tid]||{};
  var grand = Math.max(0,(v.rent||0)) + Math.max(0,(v.arrangement||0)) + Math.max(0,(v.loan||0));
  el.innerHTML = '<div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px 14px;display:flex;justify-content:space-between;align-items:center;font-size:12px;">'+
    '<div><strong>'+tenantName(t)+'</strong> &mdash; '+t.unit+'</div>'+
    '<div style="display:flex;gap:14px;">'+
      '<span>Rent: <strong class="'+(v.rent>0?'amt-debit':'amt-credit')+'">'+fmt(Math.max(0,v.rent||0))+'</strong></span>'+
      (v.arrangement>0?'<span>Arrangement: <strong class="amt-debit">'+fmt(v.arrangement)+'</strong></span>':'')+''+
      (grand>0?'<span>Total: <strong class="amt-debit">'+fmt(grand)+'</strong></span>':'<span style="color:var(--success);">&#10003; Current</span>')+
    '</div>'+
  '</div>';
}

function loadUnifiedPaymentContext() {
  var tid = (document.getElementById('rp-tenant')||{}).value;
  if (!tid) return;
  updateModalTenantContext('rp-tenant','rp-context');
  var t = getTenant(tid);
  if (t&&t.autoPay){var m=document.getElementById('rp-method');if(m)m.value='auto';}
  var dateEl = document.getElementById('rp-date');
  if (dateEl && !dateEl.value) dateEl.value = today();
  // Pre-fill total with amount due
  var d = getData(); var totals = calcAllTotals(d); var v = totals[tid]||{};
  var rentOwing = Math.max(0, v.rent||0);
  var activeArr = d.arrangements.filter(function(a){return a.tenantId===tid&&a.status==='approved';});
  var arr = activeArr[0]||null;
  var activeLoan = d.loanList.filter(function(l){return l.tenantId===tid&&l.status==='approved';});
  var loan = activeLoan[0]||null;
  var totalDue = rentOwing + (arr?arr.monthlyPayment:0) + (loan?loan.payment:0);
  var amtEl = document.getElementById('rp-amount');
  if (amtEl && totalDue > 0) amtEl.value = totalDue.toFixed(2);
  updateAllocationUI();
}

function updateAllocationUI() {
  var tid = (document.getElementById('rp-tenant')||{}).value;
  var amtEl = document.getElementById('rp-amount');
  var editor = document.getElementById('rp-alloc-editor');
  if (!tid || !amtEl) return;
  var total = parseFloat(amtEl.value)||0;
  if (total <= 0) { if(editor) editor.style.display='none'; return; }
  if (editor) editor.style.display='block';
  var d = getData(); var totals = calcAllTotals(d); var v = totals[tid]||{};
  var rentOwing = Math.max(0, v.rent||0);
  var activeArr = d.arrangements.filter(function(a){return a.tenantId===tid&&a.status==='approved';});
  var arr = activeArr[0]||null;
  var arrMonthly = arr ? arr.monthlyPayment : 0;
  var activeLoan = d.loanList.filter(function(l){return l.tenantId===tid&&l.status==='approved';});
  var loan = activeLoan[0]||null;
  var loanMonthly = loan ? loan.payment : 0;
  var rentLbl = document.getElementById('rp-rent-owing-lbl');
  if (rentLbl) rentLbl.textContent = rentOwing>0 ? fmt(rentOwing)+' owing' : 'Current';
  var arrRow = document.getElementById('rp-arr-row');
  var arrLbl = document.getElementById('rp-arr-lbl');
  if (arrRow) arrRow.style.display = arr ? 'flex' : 'none';
  if (arrLbl && arr) arrLbl.textContent = arr.ref+' \u00B7 '+fmt(arrMonthly)+'/mo';
  var loanRow = document.getElementById('rp-loan-row');
  var loanLbl = document.getElementById('rp-loan-lbl');
  if (loanRow) loanRow.style.display = loan ? 'flex' : 'none';
  if (loanLbl && loan) loanLbl.textContent = loan.type+' \u00B7 '+fmt(loanMonthly)+'/mo';
  // Auto-allocate waterfall
  var remaining = total;
  var rentAlloc = Math.min(remaining, rentOwing); remaining = Math.round((remaining-rentAlloc)*100)/100;
  var arrAlloc  = arr  ? Math.min(remaining, arrMonthly)  : 0; remaining = Math.round((remaining-arrAlloc)*100)/100;
  var loanAlloc = loan ? Math.min(remaining, loanMonthly) : 0;
  var rentInput = document.getElementById('rp-alloc-rent');
  var arrInput  = document.getElementById('rp-alloc-arr');
  var loanInput = document.getElementById('rp-alloc-loan');
  if (rentInput) rentInput.value = rentAlloc>0 ? rentAlloc.toFixed(2) : '';
  if (arrInput  && arr)  arrInput.value  = arrAlloc>0  ? arrAlloc.toFixed(2)  : '';
  if (loanInput && loan) loanInput.value = loanAlloc>0 ? loanAlloc.toFixed(2) : '';
  updateUnallocated();
}

function onAllocChange() { updateUnallocated(); }

function updateUnallocated() {
  var total = parseFloat((document.getElementById('rp-amount')||{}).value)||0;
  var rent  = parseFloat((document.getElementById('rp-alloc-rent')||{}).value)||0;
  var arr   = parseFloat((document.getElementById('rp-alloc-arr')||{}).value)||0;
  var loan  = parseFloat((document.getElementById('rp-alloc-loan')||{}).value)||0;
  var allocated = Math.round((rent+arr+loan)*100)/100;
  var unalloc = Math.round((total-allocated)*100)/100;
  var lbl = document.getElementById('rp-unalloc-lbl');
  var val = document.getElementById('rp-unalloc-val');
  var warn = document.getElementById('rp-alloc-warning');
  if (lbl) lbl.textContent = unalloc < -0.005 ? 'Over-allocated' : unalloc > 0.005 ? 'Unallocated (Credit to Rent)' : '\u2713 Fully Allocated';
  if (val) { val.textContent = fmt(Math.abs(unalloc)); val.style.color = unalloc < -0.005 ? 'var(--danger)' : unalloc > 0.005 ? '#f59e0b' : 'var(--success)'; }
  if (warn) { warn.style.display = unalloc < -0.005 ? 'block' : 'none'; if(unalloc<-0.005) warn.textContent = '\u26A0 Allocated '+fmt(allocated)+' exceeds received '+fmt(total)+'. Reduce one of the amounts.'; }
  var tid = (document.getElementById('rp-tenant')||{}).value;
  if (tid) {
    var d = getData(); var totals = calcAllTotals(d); var v = totals[tid]||{};
    var rentOwing = Math.max(0, v.rent||0);
    var rs = document.getElementById('rp-rent-status');
    if (rs) { rs.textContent = rent>=rentOwing?'\u2713 Clear':fmt(Math.abs(rentOwing-rent))+' left'; rs.style.color = rent>=rentOwing?'var(--success)':'var(--danger)'; }
  }
}

// CURRENT_USER is the display name tracked in audit log entries. Falls back
// to the role label if no name is present in the session.
var CURRENT_USER = (HOUSING_SESSION && HOUSING_SESSION.name) || 'Unknown User';

// Sidebar has been removed in the home-tiles refactor. These are kept as
// no-ops because several legacy onclick handlers still call closeSidebarOnNav().
function closeSidebarOnNav(){}


function auditLog(action, entity, entityId, description, before, after) {
  // NOTE: auditLog only updates _memStore. The caller is responsible for
  // calling saveData() afterward. This avoids double-saves that cause
  // spurious Supabase upserts on every operation.
  if (!_memStore) return;
  if (!_memStore.auditLog) _memStore.auditLog = [];
  _memStore.auditLog.push({
    id: uid(), ts: new Date().toISOString(), user: CURRENT_USER,
    action: action, entity: entity, entityId: entityId,
    description: description, before: before||null, after: after||null
  });
  // Fire-and-forget to finance_audit_log directly (no saveData needed)
  _writeAuditEntry({
    action: action, entity_type: entity, entity_id: entityId,
    summary: description
  });
}

// (auto-invoicing/payment engine deleted in the audit cleanup \u2014 it was never
// reachable from any UI)


function toggleHomeCare(tid) {
  var d = getData();
  var t = d.tenants.find(function(x){ return x.id === tid; });
  if (!t) return;
  t.homeCare = !t.homeCare;
  saveData(d);
  writeAuditEntry({
    action: 'update_tenant', entity_type: 'tenant', entity_id: tid, tenant_id: tid,
    summary: (t.homeCare ? 'Flagged' : 'Removed') + ' Home & Community Care for ' + tenantName(t)
  });
  renderTenantProfile(tid);
  toast(tenantName(t) + (t.homeCare ? ' flagged as H&CC.' : ' H&CC flag removed.'));
}

