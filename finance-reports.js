// ── Reports tab helpers ────────────────────────────────────────────────────
// showReportTab: swap which tab panel is visible AND trigger its render
// exportActiveReport / printActiveReport: dispatch to the right export/print
// fn based on which tab is currently active. These are bound to the
// page-level "Export CSV" and "Print" buttons.
var _activeReportTab = 'rpt-period';

function showReportTab(ev, id){
  document.querySelectorAll('#page-reports .tab-panel').forEach(function(p){p.classList.remove('on');});
  document.querySelectorAll('#page-reports .tab-btn').forEach(function(b){b.classList.remove('active');});
  var tp = document.getElementById(id); if (tp) tp.classList.add('on');
  if (ev && ev.target) ev.target.classList.add('active');
  _activeReportTab = id;
  // Trigger per-tab render
  if (id === 'rpt-period')     renderPeriodSummary();
  if (id === 'rpt-aging')      renderAging();
  if (id === 'rpt-reconcile')  renderReconciliation();
  if (id === 'rpt-loan')       renderLoanSchedule();
  if (id === 'rpt-annual')     renderAnnual();
  updateReportsPageMeta();
}

function updateReportsPageMeta(){
  var metaEl = document.getElementById('reports_page_meta');
  if (!metaEl) return;
  var labels = {
    'rpt-period':    'Period Summary',
    'rpt-aging':     'Arrears Aging',
    'rpt-reconcile': 'Reconciliation',
    'rpt-loan':      'Loan Schedule',
    'rpt-annual':    'Annual Summary'
  };
  var today = new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'});
  metaEl.textContent = (labels[_activeReportTab] || 'Report') + ' · Generated ' + today;

  // Also update the aging "as of" label if we're on that tab
  var asOf = document.getElementById('aging-as-of-label');
  if (asOf) asOf.textContent = today;
}

function exportActiveReport(){
  var tab = _activeReportTab;
  if (tab === 'rpt-period')     return exportPeriodCSV();
  if (tab === 'rpt-aging')      return exportAgingCSV();
  if (tab === 'rpt-reconcile')  return exportReconciliationCSV();
  if (tab === 'rpt-loan')       return exportLoanCSV();
  if (tab === 'rpt-annual')     return exportAnnualCSV();
  toast('Export is not available for this tab.');
}

function printActiveReport(){
  var map = {
    'rpt-period':    'period',
    'rpt-aging':     'aging',
    'rpt-reconcile': 'reconcile',
    'rpt-loan':      'loan',
    'rpt-annual':    'annual'
  };
  var type = map[_activeReportTab];
  if (!type) { toast('Print is not available for this tab.'); return; }
  printReport(type);
}

// Reconciliation CSV export (previously missing — completes the pattern)
function exportReconciliationCSV(){
  var d = getData();
  var mm = (document.getElementById('rec-month')||{}).value || '01';
  var yy = (document.getElementById('rec-year') ||{}).value || String(new Date().getFullYear());
  var periodStart = yy + '-' + mm + '-01';
  // Last day of the month
  var lastDay = new Date(parseInt(yy,10), parseInt(mm,10), 0).getDate();
  var periodEnd = yy + '-' + mm + '-' + String(lastDay).padStart(2,'0');

  // Collect every ledger entry in the period across rent, arrangement, loan
  var rows = [];
  (d.rentLedger||[]).forEach(function(r){
    if (r.date >= periodStart && r.date <= periodEnd) {
      var t = getTenant(r.tenantId);
      rows.push([
        r.date, t?tenantName(t):'', r.tenantId,
        'Rent', r.type || '', r.desc || '',
        r.charge || 0, r.payment || 0,
        methodLabel(r.method), r.status || '', r.ref || ''
      ]);
    }
  });
  (d.arrPayments||[]).forEach(function(p){
    if (p.date >= periodStart && p.date <= periodEnd) {
      var t = getTenant(p.tenantId);
      var a = (d.arrangements||[]).find(function(x){ return x.id === p.arrId; });
      rows.push([
        p.date, t?tenantName(t):'', p.tenantId,
        'Arrangement', p.type || 'payment', a ? ('Arrangement '+a.ref) : '',
        0, p.amount || 0,
        methodLabel(p.method), p.status || '', p.ref || ''
      ]);
    }
  });
  (d.loanPayments||[]).forEach(function(p){
    if (p.date >= periodStart && p.date <= periodEnd) {
      var t = getTenant(p.tenantId);
      var l = (d.loanList||[]).find(function(x){ return x.id === p.loanId; });
      rows.push([
        p.date, t?tenantName(t):'', p.tenantId,
        'Loan', p.type || 'payment', l ? ('Loan '+l.type) : '',
        0, p.amount || 0,
        methodLabel(p.method), p.status || '', p.ref || ''
      ]);
    }
  });

  rows.sort(function(a,b){ return (b[0]||'').localeCompare(a[0]||''); });

  exportStdCSV('Reconciliation-'+yy+'-'+mm,
    ['Date','Tenant','Tenant ID','Ledger','Type','Description','Charge','Payment','Method','Status','Reference'],
    rows
  );
}

function printReport(type) {
  var contentId = {
    period:'rpt-period-content', aging:'aging-content',
    reconcile:'rec-content', loan:'loan-sched-content',
    annual:'annual-content', journal:'journal-content'
  }[type];
  var titleMap = {period:'Period Summary',aging:'Arrears Aging',reconcile:'Reconciliation',
    loan:'Loan Schedule',annual:'Annual Summary',journal:'Journal Entries'};
  var el = document.getElementById(contentId);
  if (!el) return;
  var w = window.open('','_blank','width=900,height=700');
  if (!w) { toast('Print popup blocked. Please allow popups for this site.'); return; }
  w.document.write('<!DOCTYPE html><html><head><title>'+(window.NATION_CONFIG && window.NATION_CONFIG.short || "")+' Finance \u2014 '+titleMap[type]+'</title><style>'+
    'body{font-family:Georgia,serif;max-width:900px;margin:20px auto;padding:0 20px;font-size:12px;}'+
    'h2{font-size:18px;}table{width:100%;border-collapse:collapse;margin:10px 0;}'+
    'th{background:#111;color:#fff;padding:7px 10px;text-align:left;font-size:11px;}'+
    'td{padding:7px 10px;border-bottom:1px solid #eee;vertical-align:top;}'+
    '.amt-debit{color:#ef4444;font-weight:600;}.amt-credit{color:#16a34a;font-weight:600;}'+
    '.pill{display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;}'+
    '@media print{button{display:none!important;}}'+
  '</style></head><body>');
  w.document.write('<div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid '+window._themeAccentHex()+';padding-bottom:12px;margin-bottom:16px;">'+
    '<div><div style="font-size:18px;font-weight:bold;">'+(window.NATION_CONFIG && window.NATION_CONFIG.display_name || "")+'</div>'+
    '<div style="font-size:13px;color:#666;">Housing Finance \u2014 '+titleMap[type]+'</div></div>'+
    '<div style="text-align:right;font-size:11px;color:#888;">'+new Date().toLocaleDateString('en-CA',{year:'numeric',month:'long',day:'numeric'})+'<br>CONFIDENTIAL</div>'+
  '</div>');
  w.document.write(el.innerHTML);
  w.document.write('<div style="margin-top:30px;display:grid;grid-template-columns:1fr 1fr;gap:40px;padding-top:16px;border-top:1px solid #ddd;">'+
    '<div><div style="border-bottom:1px solid #333;height:40px;margin-bottom:6px;"></div><div style="font-size:11px;">Prepared by (Housing Manager)</div></div>'+
    '<div><div style="border-bottom:1px solid #333;height:40px;margin-bottom:6px;"></div><div style="font-size:11px;">Received by (Finance)</div></div>'+
  '</div>');
  w.document.write('<div style="margin-top:20px;text-align:center;"><button onclick="window.print()" style="background:#111;color:'+window._themeAccentHex()+';border:none;padding:10px 28px;font-size:13px;font-weight:700;border-radius:6px;cursor:pointer;">&#128424; Print / Save PDF</button></div>');
  w.document.write('</body></html>');
  w.document.close();
  setTimeout(function(){w.print();},400);
}

function exportPeriodCSV() {
  var el = document.getElementById('rpt-period-content');
  if (!el) return;
  var d = getData();
  var month = (document.getElementById('rpt-period-month')||{}).value||'04';
  var year  = (document.getElementById('rpt-period-year')||{}).value||'2026';
  var ym = year+'-'+month;
  var rows = [['Tenant','Unit','Type','Rent Charged','Rent Paid','Arrangement Paid','Loan Paid','Total Received','Variance']];
  d.tenants.forEach(function(t){
    var rc=0,rp=0,ap=0,lp=0;
    d.rentLedger.filter(function(r){return r.tenantId===t.id&&r.date.slice(0,7)===ym&&r.status!=='reversed';}).forEach(function(r){rc+=r.charge||0;rp+=r.payment||0;});
    d.arrPayments.filter(function(p){return p.tenantId===t.id&&p.date.slice(0,7)===ym&&p.status!=='reversed';}).forEach(function(p){ap+=p.amount||0;});
    d.loanPayments.filter(function(p){return p.tenantId===t.id&&p.date.slice(0,7)===ym&&p.status!=='reversed';}).forEach(function(p){lp+=p.amount||0;});
    var total = rp+ap+lp;
    if (rc>0||total>0) rows.push([tenantName(t),t.unit,t.type,rc,rp,ap,lp,total,rp-rc]);
  });
  var csv = rows.map(function(r){return r.map(function(v){return '"'+String(v).replace(/"/g,'""')+'"';}).join(',');}).join('\n');
  var blob = new Blob([csv],{type:'text/csv'});
  var a = document.createElement('a'); a.href=URL.createObjectURL(blob);
  a.download=(window.NATION_CONFIG && window.NATION_CONFIG.short || "")+'-Period-'+ym+'.csv'; a.click();
}

function exportAgingCSV() {
  var d = getData(); var totals = calcAllTotals(d); var now = new Date();
  var rows = [['Tenant','Unit','Current (0-30)','31-60 Days','61-90 Days','90+ Days','Total Owing']];
  d.tenants.forEach(function(t){
    var v=totals[t.id]||{}; var bal=Math.max(0,v.rent||0);
    if (bal<=0) return;
    // Age by the oldest invoice with a REMAINING balance (see renderAging).
    var _oldestUnpaid=matchInvoicesToPayments(t.id, d).find(function(ib){ return ib.remaining > 0.005; });
    var oldest=_oldestUnpaid?_oldestUnpaid.inv:null; var days=oldest?Math.floor((now-new Date(oldest.date))/86400000):0;
    var c=days<=30?bal:0, b31=days<=60&&days>30?bal:0, b61=days<=90&&days>60?bal:0, b90=days>90?bal:0;
    rows.push([tenantName(t),t.unit,c,b31,b61,b90,bal]);
  });
  var csv = rows.map(function(r){return r.map(function(v){return '"'+String(v).replace(/"/g,'""')+'"';}).join(',');}).join('\n');
  var blob = new Blob([csv],{type:'text/csv'}); var a=document.createElement('a');
  a.href=URL.createObjectURL(blob); a.download=(window.NATION_CONFIG && window.NATION_CONFIG.short || "")+'-Aging-'+today()+'.csv'; a.click();
}

function exportLoanCSV() {
  var d=getData();
  var rows=[['Tenant','Unit','Loan Type','Principal','Paid','Remaining','Monthly Payment','Rate','Status']];
  d.loanList.forEach(function(l){
    var t=getTenant(l.tenantId);
    var paid=d.loanPayments.filter(function(p){return p.loanId===l.id&&p.status!=='reversed';}).reduce(function(s,p){return s+p.amount;},0);
    rows.push([t?tenantName(t):'',t?t.unit:'',l.type,l.principal,paid,Math.max(0,l.principal-paid),l.payment,l.rateType==='none'?'0%':(l.rate+'% '+l.rateType),l.status]);
  });
  var csv=rows.map(function(r){return r.map(function(v){return '"'+String(v).replace(/"/g,'""')+'"';}).join(',');}).join('\n');
  var blob=new Blob([csv],{type:'text/csv'}); var a=document.createElement('a');
  a.href=URL.createObjectURL(blob); a.download=(window.NATION_CONFIG && window.NATION_CONFIG.short || "")+'-Loans-'+today()+'.csv'; a.click();
}

function exportAnnualCSV() {
  var year=parseInt((document.getElementById('annualYear')||{}).value||2025);
  var d=getData();
  var months=['Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec','Jan','Feb','Mar'];
  var rows=[['Month','Rent Charged','Rent Collected','Arrangement Collected','Loan Collected','Total Collected','Arrears']];
  months.forEach(function(m,i){
    var mo=i<9?i+4:i-8; var yr=mo>=4?year:year+1;
    var ym=yr+'-'+String(mo).padStart(2,'0');
    var charged=0,rPaid=0,aPaid=0,lPaid=0;
    d.rentLedger.filter(function(r){return r.date.slice(0,7)===ym&&r.status!=='reversed';}).forEach(function(r){charged+=r.charge||0;rPaid+=r.payment||0;});
    d.arrPayments.filter(function(p){return p.date.slice(0,7)===ym&&p.status!=='reversed';}).forEach(function(p){aPaid+=p.amount||0;});
    d.loanPayments.filter(function(p){return p.date.slice(0,7)===ym&&p.status!=='reversed';}).forEach(function(p){lPaid+=p.amount||0;});
    rows.push([m+' '+yr,charged,rPaid,aPaid,lPaid,rPaid+aPaid+lPaid,rPaid-charged]);
  });
  var csv=rows.map(function(r){return r.map(function(v){return '"'+String(v).replace(/"/g,'""')+'"';}).join(',');}).join('\n');
  var blob=new Blob([csv],{type:'text/csv'}); var a=document.createElement('a');
  a.href=URL.createObjectURL(blob); a.download=(window.NATION_CONFIG && window.NATION_CONFIG.short || "")+'-Annual-FY'+year+'.csv'; a.click();
}


function renderAging() {
  var d = getData(); var totals = calcAllTotals(d);
  var buckets = {'Current':[],'31-60':[],'61-90':[],'90+':[]};
  d.tenants.forEach(function(t){
    var v = totals[t.id]||{};
    var balance = Math.max(0,(v.rent||0));
    if (balance <= 0) return;
    // Oldest invoice WITH A REMAINING BALANCE (FIFO payment matching) — the
    // old code aged the entire balance by the tenant's first invoice EVER, so
    // anyone with history instantly reported as 90+ days.
    var _oldestUnpaid = matchInvoicesToPayments(t.id, d).find(function(ib){ return ib.remaining > 0.005; });
    var oldest = _oldestUnpaid ? _oldestUnpaid.inv : null;
    var days = oldest ? Math.floor((new Date() - new Date(oldest.date))/86400000) : 0;
    var bucket = days<=30?'Current':days<=60?'31-60':days<=90?'61-90':'90+';
    buckets[bucket].push({tid:t.id,name:tenantName(t),unit:t.unit||'',balance:balance,days:days,oldest:oldest?oldest.date:''});
  });
  var el = document.getElementById('aging-content');
  if (!el) return;

  // Summary tiles
  var bucketMeta = {
    'Current': { color:'var(--success)',    label:'Current (0–30 days)',       pillClass:'std-pill-paid' },
    '31-60':   { color:'#f59e0b',           label:'31–60 Days',                pillClass:'std-pill-pending' },
    '61-90':   { color:'#f97316',           label:'61–90 Days',                pillClass:'std-pill-pending' },
    '90+':     { color:'var(--danger)',     label:'90+ Days (Critical)',       pillClass:'std-pill-overdue' }
  };

  var grandTotal = 0;
  Object.keys(buckets).forEach(function(k){
    buckets[k].forEach(function(x){ grandTotal += x.balance; });
  });

  var summaryHtml = '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px;">' +
    Object.keys(buckets).map(function(k){
      var items = buckets[k];
      var total = items.reduce(function(s,x){return s+x.balance;},0);
      var meta  = bucketMeta[k];
      return '<div style="background:var(--surface);border:1px solid var(--border);border-top:3px solid '+meta.color+';border-radius:10px;padding:14px;">'+
        '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);margin-bottom:4px;">'+meta.label+'</div>'+
        '<div style="font-size:22px;font-weight:700;color:'+meta.color+';">'+fmt(total)+'</div>'+
        '<div style="font-size:11px;color:var(--muted);margin-top:2px;">'+items.length+' tenant'+(items.length===1?'':'s')+'</div>'+
      '</div>';
    }).join('') +
    '</div>';

  // Flatten into one big table
  var flatRows = [];
  Object.keys(buckets).forEach(function(k){
    buckets[k].forEach(function(x){
      flatRows.push({ bucket:k, meta:bucketMeta[k], row:x });
    });
  });
  // Sort by days descending (oldest first)
  flatRows.sort(function(a,b){ return b.row.days - a.row.days; });

  var rows;
  if (!flatRows.length) {
    rows = '<tr class="empty-row"><td colspan="5">No outstanding rent balances. Every tenant is current.</td></tr>';
  } else {
    rows = flatRows.map(function(fr){
      var x = fr.row;
      var safeId = (x.tid||'').replace(/'/g, "\\'");
      return '<tr class="clickable" onclick="openFinanceCard(\''+safeId+'\')">'+
        '<td class="std-cell-primary">'+escapeHtml(x.name)+
          (x.unit?'<div style="font-size:11px;color:var(--muted);font-weight:normal;">'+escapeHtml(x.unit)+'</div>':'')+'</td>'+
        '<td>'+(x.oldest||'<span class="std-cell-dash">—</span>')+'</td>'+
        '<td class="std-cell-right">'+x.days+' days</td>'+
        '<td class="std-cell-right amt-debit"><strong>'+fmt(x.balance)+'</strong></td>'+
        '<td><span class="std-pill '+fr.meta.pillClass+'">'+fr.bucket+'</span></td>'+
      '</tr>';
    }).join('');
  }

  el.innerHTML = summaryHtml +
    '<div class="std-table-card">' +
      '<div class="std-table-hdr">' +
        '<span>Aging Detail</span>' +
        '<span class="std-table-count">'+flatRows.length+' tenants with arrears · '+fmt(grandTotal)+' total</span>' +
      '</div>' +
      '<table class="std-table">' +
        '<thead><tr>' +
          '<th>Tenant</th>' +
          '<th>Oldest Unpaid</th>' +
          '<th class="std-cell-right">Days Outstanding</th>' +
          '<th class="std-cell-right">Balance</th>' +
          '<th>Bucket</th>' +
        '</tr></thead>' +
        '<tbody>'+rows+'</tbody>' +
      '</table>' +
    '</div>';
}

function renderAnnual() {
  var year = parseInt((document.getElementById('annualYear')||{}).value||new Date().getFullYear());
  var d = getData();
  var el = document.getElementById('annual-content');
  if (!el) return;

  // Fiscal year runs Apr (year) through Mar (year+1)
  var fyMonths = [
    {m:4,  y:year},   {m:5,  y:year},   {m:6,  y:year},
    {m:7,  y:year},   {m:8,  y:year},   {m:9,  y:year},
    {m:10, y:year},   {m:11, y:year},   {m:12, y:year},
    {m:1,  y:year+1}, {m:2,  y:year+1}, {m:3,  y:year+1}
  ];
  var mNames = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  var totalCharged = 0, totalCollected = 0, totalArrCollected = 0, totalLoanCollected = 0;

  var rows = fyMonths.map(function(mo){
    var ym = String(mo.y) + '-' + String(mo.m).padStart(2,'0');
    var charged = (d.rentLedger||[]).filter(function(r){ return r.date.slice(0,7)===ym && r.charge>0 && r.status!=='reversed'; })
                                     .reduce(function(s,r){ return s+r.charge; }, 0);
    var rentCollected = (d.rentLedger||[]).filter(function(r){ return r.date.slice(0,7)===ym && r.payment>0 && r.status!=='reversed'; })
                                           .reduce(function(s,r){ return s+r.payment; }, 0);
    var arrCollected = (d.arrPayments||[]).filter(function(p){ return p.date.slice(0,7)===ym && p.status!=='reversed'; })
                                           .reduce(function(s,p){ return s+p.amount; }, 0);
    var loanCollected = (d.loanPayments||[]).filter(function(p){ return p.date.slice(0,7)===ym && p.status!=='reversed'; })
                                              .reduce(function(s,p){ return s+p.amount; }, 0);
    var totalMonth = rentCollected + arrCollected + loanCollected;
    var variance = rentCollected - charged;

    totalCharged       += charged;
    totalCollected     += rentCollected;
    totalArrCollected  += arrCollected;
    totalLoanCollected += loanCollected;

    return '<tr>'+
      '<td class="std-cell-primary">'+mNames[mo.m]+' '+mo.y+'</td>'+
      '<td class="std-cell-right amt-debit">'+fmt(charged)+'</td>'+
      '<td class="std-cell-right amt-credit">'+fmt(rentCollected)+'</td>'+
      '<td class="std-cell-right">'+(arrCollected>0?'<span class="amt-credit">'+fmt(arrCollected)+'</span>':'<span class="std-cell-dash">—</span>')+'</td>'+
      '<td class="std-cell-right">'+(loanCollected>0?'<span class="amt-credit">'+fmt(loanCollected)+'</span>':'<span class="std-cell-dash">—</span>')+'</td>'+
      '<td class="std-cell-right"><strong>'+fmt(totalMonth)+'</strong></td>'+
      '<td class="std-cell-right" style="color:'+(variance>=0?'var(--success)':'var(--danger)')+';">'+fmt(variance)+'</td>'+
    '</tr>';
  }).join('');

  var totalAllCollected = totalCollected + totalArrCollected + totalLoanCollected;
  var totalVariance = totalCollected - totalCharged;
  var collectionRate = totalCharged > 0 ? (totalCollected / totalCharged * 100) : 0;

  // Summary tiles on top
  var summaryHtml = '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px;">'+
    [
      {lbl:'Rent Charged',       val:fmt(totalCharged),       color:'var(--text)',    sub:'FY'+year+'–'+String(year+1).slice(2)+' total'},
      {lbl:'Rent Collected',     val:fmt(totalCollected),     color:'var(--success)', sub:collectionRate.toFixed(1)+'% collection rate'},
      {lbl:'Rent Variance',      val:fmt(totalVariance),      color:totalVariance>=0?'var(--success)':'var(--danger)', sub:totalVariance>=0?'Above plan':'Arrears outstanding'},
      {lbl:'Total Collections',  val:fmt(totalAllCollected),  color:'var(--yellow)',  sub:'Rent + Arr + Loan', dark:true}
    ].map(function(tile){
      return '<div style="background:'+(tile.dark?'var(--dark)':'var(--surface)')+';border:1px solid var(--border);border-radius:10px;padding:14px;">'+
        '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:'+(tile.dark?'var(--gray)':'var(--muted)')+';margin-bottom:4px;">'+tile.lbl+'</div>'+
        '<div style="font-size:22px;font-weight:700;color:'+tile.color+';">'+tile.val+'</div>'+
        '<div style="font-size:11px;color:var(--muted);margin-top:2px;">'+tile.sub+'</div>'+
      '</div>';
    }).join('')+
    '</div>';

  el.innerHTML = summaryHtml +
    '<div class="std-table-card">'+
      '<div class="std-table-hdr"><span>Monthly Rollup</span>'+
        '<span class="std-table-count">FY '+year+'–'+String(year+1).slice(2)+' · Apr '+year+' – Mar '+(year+1)+'</span></div>'+
      '<table class="std-table">'+
        '<thead><tr>'+
          '<th>Month</th>'+
          '<th class="std-cell-right">Charged</th>'+
          '<th class="std-cell-right">Rent Collected</th>'+
          '<th class="std-cell-right">Arrangement</th>'+
          '<th class="std-cell-right">Loan</th>'+
          '<th class="std-cell-right">Total Collected</th>'+
          '<th class="std-cell-right">Variance</th>'+
        '</tr></thead>'+
        '<tbody>'+rows+
          '<tr style="background:var(--bg);font-weight:700;border-top:2px solid var(--border);">'+
            '<td>FY TOTAL</td>'+
            '<td class="std-cell-right amt-debit">'+fmt(totalCharged)+'</td>'+
            '<td class="std-cell-right amt-credit">'+fmt(totalCollected)+'</td>'+
            '<td class="std-cell-right amt-credit">'+fmt(totalArrCollected)+'</td>'+
            '<td class="std-cell-right amt-credit">'+fmt(totalLoanCollected)+'</td>'+
            '<td class="std-cell-right amt-credit">'+fmt(totalAllCollected)+'</td>'+
            '<td class="std-cell-right" style="color:'+(totalVariance>=0?'var(--success)':'var(--danger)')+';">'+fmt(totalVariance)+'</td>'+
          '</tr>'+
        '</tbody>'+
      '</table>'+
    '</div>';
}

function renderLoanSchedule() {
  var tid = (document.getElementById('loanSchedTenantSelect')||{}).value || '';
  var el  = document.getElementById('loan-sched-content');
  if (!el) return;
  var d = getData();
  var allLoans = (d.loanList||[]).filter(function(l){ return l.status === 'approved'; });
  var loans = tid ? allLoans.filter(function(l){ return l.tenantId === tid; }) : allLoans;

  var typeLabels = {renovation:'Renovation', 'rent-to-own':'Rent-to-Own', utilities:'Utilities', emergency:'Emergency', other:'Loan'};

  var totalPrincipal = 0, totalPaid = 0, totalRemaining = 0;
  var rows = loans.map(function(l){
    var t = getTenant(l.tenantId);
    var paid = d.loanPayments.filter(function(p){ return p.loanId === l.id && p.status !== 'reversed'; })
                              .reduce(function(s,p){ return s+p.amount; }, 0);
    var rem = Math.max(0, l.principal - paid);
    var pct = l.principal > 0 ? Math.min(100, (paid/l.principal)*100) : 0;
    totalPrincipal += l.principal || 0;
    totalPaid      += paid;
    totalRemaining += rem;
    var progress = '<div style="display:flex;align-items:center;gap:8px;min-width:120px;">'+
      '<div style="flex:1;height:6px;background:var(--border);border-radius:4px;overflow:hidden;"><div style="width:'+pct.toFixed(0)+'%;height:100%;background:var(--yellow);"></div></div>'+
      '<span style="font-size:11px;color:var(--muted);white-space:nowrap;">'+pct.toFixed(0)+'%</span>'+
      '</div>';
    return '<tr>'+
      '<td class="std-cell-primary">'+(t?tenantNameHtml(t):'<span class="std-cell-dash">—</span>')+
        (t&&t.unit?'<div style="font-size:11px;color:var(--muted);font-weight:normal;">'+escapeHtml(t.unit)+'</div>':'')+'</td>'+
      '<td>'+(typeLabels[l.type]||l.type||'<span class="std-cell-dash">—</span>')+'</td>'+
      '<td class="std-cell-right">'+fmt(l.principal)+'</td>'+
      '<td class="std-cell-right amt-credit">'+fmt(paid)+'</td>'+
      '<td class="std-cell-right" style="color:'+(rem>0?'var(--danger)':'var(--success)')+';"><strong>'+fmt(rem)+'</strong></td>'+
      '<td class="std-cell-right">'+fmt(l.payment)+'</td>'+
      '<td>'+progress+'</td>'+
    '</tr>';
  }).join('');

  var scopeLabel = tid
    ? (function(){ var t = getTenant(tid); return t ? tenantName(t) : 'Selected tenant'; })()
    : 'All tenants';

  var body;
  if (!loans.length) {
    body = '<tr class="empty-row"><td colspan="7">No approved loans'+(tid?' for the selected tenant.':'.')+'</td></tr>';
  } else {
    body = rows +
      '<tr style="background:var(--bg);font-weight:700;border-top:2px solid var(--border);">'+
        '<td colspan="2">TOTAL</td>'+
        '<td class="std-cell-right">'+fmt(totalPrincipal)+'</td>'+
        '<td class="std-cell-right amt-credit">'+fmt(totalPaid)+'</td>'+
        '<td class="std-cell-right" style="color:'+(totalRemaining>0?'var(--danger)':'var(--success)')+';">'+fmt(totalRemaining)+'</td>'+
        '<td></td><td></td>'+
      '</tr>';
  }

  el.innerHTML =
    '<div class="std-table-card">'+
      '<div class="std-table-hdr"><span>Approved Loan Schedule</span>'+
        '<span class="std-table-count">'+loans.length+' loan'+(loans.length===1?'':'s')+' · '+scopeLabel+'</span></div>'+
      '<table class="std-table">'+
        '<thead><tr>'+
          '<th>Tenant</th>'+
          '<th>Type</th>'+
          '<th class="std-cell-right">Principal</th>'+
          '<th class="std-cell-right">Paid</th>'+
          '<th class="std-cell-right">Remaining</th>'+
          '<th class="std-cell-right">Scheduled Payment</th>'+
          '<th>Progress</th>'+
        '</tr></thead>'+
        '<tbody>'+body+'</tbody>'+
      '</table>'+
    '</div>';
}

function clearJournalFilters(){
  ['jfilt_status','jfilt_ledger','jfilt_amt_min','jfilt_amt_max'].forEach(function(id){
    var el = document.getElementById(id); if(el) el.value = '';
  });
  var dEl = document.getElementById('jfilt_date'); if (dEl) dEl.value = 'all';
  renderJournal();
}

function renderJournal() {
  var tid = (document.getElementById('journalTenantSelect')||{}).value||'all';
  var d = getData();
  // Source: journalEntries table + opening balances from rentLedger
  var openingBalances = (d.rentLedger||[]).filter(function(r){ return r.type==='opening' || r.type==='opening_balance'; });
  var all = (d.journalEntries||[]).concat(openingBalances);
  // Deduplicate by id in case any overlap
  var seenIds = {};
  all = all.filter(function(r){ if (seenIds[r.id]) return false; seenIds[r.id]=true; return true; });

  // Tenant filter
  var list = tid === 'all' ? all : all.filter(function(r){ return r.tenantId === tid; });

  // Additional filters
  var fStatus = (document.getElementById('jfilt_status')||{}).value || '';
  var fLedger = (document.getElementById('jfilt_ledger')||{}).value || '';
  var fDate   = (document.getElementById('jfilt_date')  ||{}).value || 'all';
  var fMin    = parseFloat((document.getElementById('jfilt_amt_min')||{}).value);
  var fMax    = parseFloat((document.getElementById('jfilt_amt_max')||{}).value);

  var cutoff = null;
  var todayD = new Date();
  if (fDate === 'this_month') cutoff = new Date(todayD.getFullYear(), todayD.getMonth(), 1);
  else if (fDate === '30')    cutoff = new Date(todayD.getTime() - 30*24*60*60*1000);
  else if (fDate === '90')    cutoff = new Date(todayD.getTime() - 90*24*60*60*1000);

  list = list.filter(function(r){
    if (!window._finShowVoided && finIsVoided(r)) return false;
    if (cutoff && new Date(r.date) < cutoff) return false;
    if (fStatus && (r.status||'') !== fStatus) return false;
    // Journal entries don't have their own ledger field; for now we treat them all as 'rent'
    // (they live in rentLedger). If the ledger field gets added later, this filter will work.
    if (fLedger && (r.ledger || 'rent') !== fLedger) return false;
    var amt = (r.charge||0) + (r.payment||0);
    if (!isNaN(fMin) && amt < fMin) return false;
    if (!isNaN(fMax) && amt > fMax) return false;
    return true;
  });

  // Phase 2B: column-menu sort/filter (sort must come before ref-grouping)
  var _jCols = {
    date:     { label: 'Date',      accessor: function(r){ return r.date||''; } },
    tenant:   { label: 'Tenant',    accessor: function(r){ var t=getTenant(r.tenantId); return t?tenantName(t):''; } },
    ledger:   { label: 'Ledger',    accessor: function(r){ return r.ledger||'rent'; } },
    debit:    { label: 'Debit',     accessor: function(r){ return r.charge||0; } },
    credit:   { label: 'Credit',    accessor: function(r){ return r.payment||0; } },
    postedBy: { label: 'Posted By', accessor: function(r){ return r.postedBy||r.enteredBy||''; } },
    status:   { label: 'Status',    accessor: function(r){ return r.status||''; } }
  };
  var _jAcc = {}; Object.keys(_jCols).forEach(function(k){ _jAcc[k] = _jCols[k].accessor; });
  var _jSt = (typeof tableStateGet==='function') ? tableStateGet('fin-journal') : {sort:{key:'',dir:1},filters:{}};
  if (typeof tableRegisterColumns==='function') tableRegisterColumns('fin-journal', {columns:_jCols, getRows:function(){return list;}, onChange:renderJournal});
  if (!_jSt.sort.key) list.sort(function(a,b){ return b.date.localeCompare(a.date); });
  list = (typeof tableApplyFilterSort==='function') ? tableApplyFilterSort(list, _jAcc, _jSt) : list;

  // Update meta + count
  var metaEl = document.getElementById('journal_page_meta');
  if (metaEl) {
    var today = new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'});
    metaEl.textContent = list.length + ' shown · ' + all.length + ' total · Last updated ' + today;
  }
  var countEl = document.getElementById('journalCount');
  if (countEl) countEl.textContent = list.length + ' shown · ' + all.length + ' total';

  var bodyEl = document.getElementById('journalBody');
  if (!bodyEl) return;

  if (!all.length) {
    bodyEl.innerHTML = '<tr class="empty-row"><td colspan="8">No journal entries yet. Use <strong>+ New Entry</strong> to create the first one.</td></tr>';
    return;
  }
  if (!list.length) {
    bodyEl.innerHTML = '<tr class="empty-row"><td colspan="8">No entries match the current filters. <a href="#" onclick="clearJournalFilters();return false;" style="color:var(--text);text-decoration:underline;">Clear filters</a> to show all.</td></tr>';
    return;
  }

  function stdPillForStatus(st){
    if (st === 'approved') return '<span class="std-pill std-pill-approved">Approved</span>';
    if (st === 'pending-ed') return '<span class="std-pill std-pill-pending">Pending ED</span>';
    if (st === 'pending') return '<span class="std-pill std-pill-pending">Pending</span>';
    if (st === 'void' || st === 'reversed') return '<span class="std-pill std-pill-voided">Voided</span>';
    if (st === 'declined') return '<span class="std-pill std-pill-overdue">Declined</span>';
    return '<span class="std-pill std-pill-info">'+(st||'—')+'</span>';
  }

  // Group multi-line entries by ref (shared groupRef from multi-line JE form).
  var refGroups = {};
  var refOrder  = [];
  list.forEach(function(r) {
    var key = (r.ref && r.ref !== '') ? r.ref : r.id;
    if (!refGroups[key]) { refGroups[key] = []; refOrder.push(key); }
    refGroups[key].push(r);
  });
  bodyEl.innerHTML = refOrder.map(function(key) {
    var group = refGroups[key];
    var first = group[0];
    var t = getTenant(first.tenantId);
    var postedBy = first.postedBy || first.enteredBy || '<span class="std-cell-dash">—</span>';
    var memo = first.desc || '<span class="std-cell-dash">—</span>';
    if (group.length === 1) {
      var r = first;
      return '<tr>'+
        '<td>'+r.date+'</td>'+
        '<td class="std-cell-primary">'+(t?tenantNameHtml(t):'<span class="std-cell-dash">—</span>')+'</td>'+
        '<td>'+memo+'</td>'+
        '<td style="text-transform:capitalize;">'+(r.ledger||'rent')+'</td>'+
        '<td class="std-cell-right">'+(r.charge>0?'<span class="amt-debit">'+fmt(r.charge)+'</span>':'<span class="std-cell-dash">—</span>')+'</td>'+
        '<td class="std-cell-right">'+(r.payment>0?'<span class="amt-credit">'+fmt(r.payment)+'</span>':'<span class="std-cell-dash">—</span>')+'</td>'+
        '<td style="font-size:12px;color:var(--muted);">'+postedBy+'</td>'+
        '<td>'+stdPillForStatus(r.status)+'</td>'+
      '</tr>';
    }
    // Multi-line grouped entry
    var totalDR = 0, totalCR = 0;
    group.forEach(function(r){ totalDR += (r.charge||r.debit||0); totalCR += (r.payment||r.credit||0); });
    var groupRef = first.ref || '';
    var groupId  = first.id  || '';
    var isPending = (first.status === 'pending-ed' || first.status === 'pending');
    // ED tier: super_user inherits everything granted to ed.
    var _edTier = function(r){ return r === 'ed' || r === 'super_user'; };
    var isED = (typeof _currentRole !== 'undefined' && _edTier(_currentRole))
            || (typeof HOUSING_SESSION !== 'undefined' && HOUSING_SESSION && _edTier(HOUSING_SESSION.role));
    var _r = groupRef.replace(/"/g,'&quot;'), _i = groupId.replace(/"/g,'&quot;');
    var actionCell = isPending && isED
      ? '<td class="je-action-cell">'
        + '<button class="btn btn-xs btn-primary" onclick="approveJournalEntry(&quot;'+_r+'&quot;,&quot;'+_i+'&quot;)">Approve</button> '
        + '<button class="btn btn-xs btn-ghost" onclick="openEditJournalModal(&quot;'+_r+'&quot;,&quot;'+_i+'&quot;)">Edit</button> '
        + '<button class="btn btn-xs btn-ghost" style="color:var(--danger);border-color:var(--danger);" onclick="showConfirm(\'Decline\',\'Decline this entry?\',function(){declineJournalEntry(&quot;'+_r+'&quot;,&quot;'+_i+'&quot;);})">Decline</button> '
        + '<button class="btn btn-xs btn-ghost" style="color:var(--muted);" onclick="voidJournalEntry(&quot;'+_r+'&quot;,&quot;'+_i+'&quot;)">Void</button>'
        + '</td>'
      : '<td></td>';
    var header = '<tr class="je-group-header-row">'+
      '<td>'+first.date+'</td>'+
      '<td class="std-cell-primary">'+(t?tenantNameHtml(t):'<span class="std-cell-dash">—</span>')+'</td>'+
      '<td><span class="je-group-label">📓 '+memo+'</span></td>'+
      '<td><span class="je-group-badge">'+group.length+' lines</span></td>'+
      '<td class="std-cell-right"><span class="amt-debit">'+fmt(totalDR)+'</span></td>'+
      '<td class="std-cell-right"><span class="amt-credit">'+fmt(totalCR)+'</span></td>'+
      '<td style="font-size:12px;color:var(--muted);">'+postedBy+'</td>'+
      '<td>'+stdPillForStatus(first.status)+'</td>'+
    '</tr>';
    var subRows = group.map(function(r, i) {
      var isLast = i === group.length - 1;
      var isDebit = (r.charge||r.debit||0) > 0;
      var drCell = isDebit ? '<span class="amt-debit">'+fmt(r.charge||r.debit)+'</span>' : '<span class="std-cell-dash">—</span>';
      var crCell = !isDebit ? '<span class="amt-credit">'+fmt(r.payment||r.credit)+'</span>' : '<span class="std-cell-dash">—</span>';
      return '<tr class="je-group-line-row'+(isLast?' je-group-line-last':'')+'">'+
        '<td style="font-size:11px;color:var(--muted);padding-left:8px;"><span class="je-tree-connector">'+(isLast?'└':'├')+'</span> '+first.date+'</td>'+
        '<td></td>'+
        '<td>'+(isDebit?'<span class="je-dr-badge">DR</span>':'<span class="je-cr-badge">CR</span>')+'</td>'+
        '<td style="font-size:12px;text-transform:capitalize;color:var(--muted);">'+(r.ledger||'rent')+'</td>'+
        '<td class="std-cell-right">'+drCell+'</td>'+
        '<td class="std-cell-right">'+crCell+'</td>'+
        '<td colspan="2"></td>'+
      '</tr>';
    }).join('');
    return header + subRows;
  }).join('');
  var _jThead = document.getElementById('fin_journal_thead');
  if (_jThead && typeof tableBindColumnMenuClicks==='function') tableBindColumnMenuClicks(_jThead, 'fin-journal');
  if (_jThead && typeof tableRefreshSortIndicators==='function') tableRefreshSortIndicators(_jThead, 'fin-journal');
}


function renderBatchList() {
  var d = getData();
  var el = document.getElementById('batch-list');
  if (!el) return;
  var now = new Date();
  var months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  var month = months[now.getMonth()]; var year = now.getFullYear();
  var pending = d.tenants.filter(function(t){
    if (t.mergedInto) return false;   // merged-away duplicate — the keeper is billed instead
    var alreadyInvoiced = d.rentLedger.some(function(r){
      return r.tenantId===t.id&&r.type==='invoice'&&r.date.slice(0,7)===(year+'-'+String(now.getMonth()+1).padStart(2,'0'))&&r.status!=='reversed';
    });
    return !alreadyInvoiced && t.active!==false && t.rent>0;
  });
  el.innerHTML = pending.length
    ? '<div style="font-size:12px;color:var(--muted);margin-bottom:10px;">'+pending.length+' tenants without a '+month+' invoice:</div>'+
      pending.map(function(t){return '<div style="padding:8px 0;border-bottom:1px solid var(--border);font-size:13px;display:flex;justify-content:space-between;">'+
        '<span>'+tenantNameHtml(t)+' \u2014 '+escapeHtml(t.unit||'')+'</span><span>'+fmt(t.rent)+'</span></div>';}).join('')
    : '<div style="text-align:center;padding:20px;color:var(--muted);">All tenants have invoices for '+month+'.</div>';
}

function clearTxnFilters() {
  var els = ['txn-filter-tenant','txn-filter-ledger','txn-filter-type','txn-filter-from','txn-filter-to'];
  els.forEach(function(id){var el=document.getElementById(id);if(el)el.value=el.tagName==='SELECT'?el.options[0].value:'';});
  renderTransactions();
}



