/**
 * finance-fic.js — Financial Information Card (FIC)
 * Overlay modal on finance.html showing a per-tenant financial summary.
 * Reads from getData() / getTenant() / calcAllTotals() (finance.html globals).
 *
 * window.openFinanceCard(tid)   — open for a tenant UUID
 * window.closeFinanceCard()     — close
 */
(function () {
  'use strict';

  // ── CSS ───────────────────────────────────────────────────────────────────
  var FIC_CSS = [
    '.fic-overlay{position:fixed;inset:0;background:rgba(0,0,0,.52);z-index:9100;',
    '  display:none;align-items:flex-start;justify-content:center;padding:20px;overflow-y:auto;}',
    '.fic-overlay.fic-open{display:flex;}',
    '.fic-modal{background:var(--surface);border-radius:14px;width:100%;max-width:900px;',
    '  margin:auto;box-shadow:0 12px 48px rgba(0,0,0,.45);display:flex;flex-direction:column;',
    '  max-height:calc(100vh - 40px);overflow:hidden;}',
    '.fic-hdr{background:var(--card-hdr-bg,#1e293b);color:#fff;padding:20px 24px 16px;',
    '  display:flex;align-items:flex-start;gap:16px;flex-shrink:0;}',
    '.fic-avatar{width:52px;height:52px;border-radius:50%;background:var(--yellow);color:#111;',
    '  display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:800;flex-shrink:0;}',
    '.fic-title-block{flex:1;min-width:0;}',
    '.fic-name{font-size:20px;font-weight:700;line-height:1.2;}',
    '.fic-sub{font-size:13px;color:rgba(255,255,255,.62);margin-top:3px;}',
    '.fic-close-btn{background:none;border:none;color:rgba(255,255,255,.65);font-size:20px;',
    '  cursor:pointer;padding:4px 8px;border-radius:6px;line-height:1;flex-shrink:0;}',
    '.fic-close-btn:hover{color:#fff;background:rgba(255,255,255,.12);}',
    '.fic-balance-bar{display:grid;grid-template-columns:repeat(4,1fr);',
    '  border-bottom:1px solid var(--border);flex-shrink:0;}',
    '.fic-bal-cell{padding:14px 18px;border-right:1px solid var(--border);text-align:center;}',
    '.fic-bal-cell:last-child{border-right:none;background:var(--bg);}',
    '.fic-bal-label{font-size:10px;font-weight:700;text-transform:uppercase;',
    '  letter-spacing:.6px;color:var(--muted);margin-bottom:4px;}',
    '.fic-bal-value{font-size:18px;font-weight:800;color:var(--text);}',
    '.fic-bal-value.fic-debit{color:#dc2626;}',
    '.fic-tabs{display:flex;border-bottom:1px solid var(--border);background:var(--bg);',
    '  padding:0 12px;gap:2px;flex-shrink:0;overflow-x:auto;}',
    '.fic-tab{padding:10px 16px;border:none;background:none;font-size:13px;font-weight:600;',
    '  color:var(--muted);cursor:pointer;border-bottom:2.5px solid transparent;',
    '  margin-bottom:-1px;font-family:DM Sans,sans-serif;white-space:nowrap;}',
    '.fic-tab.active{color:var(--yellow);border-bottom-color:var(--yellow);}',
    '.fic-tab:hover:not(.active){color:var(--text);}',
    '.fic-body{flex:1;overflow-y:auto;padding:20px 24px;}',
    '.fic-panel{display:none;}',
    '.fic-panel.active{display:block;}',
    '.fic-footer{padding:14px 24px;border-top:1px solid var(--border);display:flex;',
    '  gap:8px;flex-wrap:wrap;align-items:center;background:var(--bg);flex-shrink:0;}',
    '.fic-footer-spacer{flex:1;}',
    '.fic-account-card{background:var(--surface);border:1px solid var(--border);',
    '  border-radius:10px;padding:16px;margin-bottom:12px;}',
    '.fic-account-card-header{display:flex;justify-content:space-between;',
    '  align-items:flex-start;margin-bottom:10px;}',
    '.fic-progress-bar{height:6px;background:var(--border);border-radius:3px;overflow:hidden;}',
    '.fic-progress-fill{height:100%;background:var(--yellow);border-radius:3px;}',
    'body.fic-open-body{overflow:hidden;}',
    '@media(max-width:600px){',
    '  .fic-balance-bar{grid-template-columns:repeat(2,1fr);}',
    '  .fic-bal-cell{padding:10px 12px;}',
    '  .fic-bal-value{font-size:14px;}',
    '  .fic-body{padding:14px 16px;}',
    '  .fic-footer{padding:12px 16px;}',
    '}'
  ].join('\n');

  // ── State ─────────────────────────────────────────────────────────────────
  var _ficTid = null;

  // ── Helpers ───────────────────────────────────────────────────────────────
  function _el(id) { return document.getElementById(id); }

  function _initials(name) {
    if (!name) return '?';
    return name.trim().split(/\s+/).map(function (w) { return w[0] || ''; })
      .join('').slice(0, 2).toUpperCase();
  }

  function _fmt(n) {
    return typeof fmt === 'function' ? fmt(n) : '$' + (+(n) || 0).toFixed(2);
  }

  function _balCell(label, amount, isDebt, dark) {
    var cellStyle = dark ? ' style="background:var(--bg)"' : '';
    return '<div class="fic-bal-cell"' + cellStyle + '>'
      + '<div class="fic-bal-label">' + label + '</div>'
      + '<div class="fic-bal-value' + (isDebt && amount > 0 ? ' fic-debit' : '') + '">'
      + _fmt(amount) + '</div></div>';
  }

  // ── Inject CSS ────────────────────────────────────────────────────────────
  function _injectCSS() {
    if (_el('fic-styles')) return;
    var s = document.createElement('style');
    s.id = 'fic-styles';
    s.textContent = FIC_CSS;
    document.head.appendChild(s);
  }

  // ── Build modal DOM ───────────────────────────────────────────────────────
  function _buildModal() {
    if (_el('ficModal')) return;
    var div = document.createElement('div');
    div.id = 'ficModal';
    div.className = 'fic-overlay';
    div.innerHTML =
      '<div class="fic-modal">'
      + '<div class="fic-hdr">'
      +   '<div class="fic-avatar" id="ficAvatar">?</div>'
      +   '<div class="fic-title-block">'
      +     '<div class="fic-name" id="ficName">Loading…</div>'
      +     '<div class="fic-sub" id="ficSub"></div>'
      +   '</div>'
      +   '<button class="fic-close-btn" onclick="closeFinanceCard()">&#x2715;</button>'
      + '</div>'
      + '<div class="fic-balance-bar" id="ficBalBar"></div>'
      + '<div class="fic-tabs" id="ficTabs">'
      +   '<button class="fic-tab active" data-fic-tab="overview">Overview</button>'
      +   '<button class="fic-tab" data-fic-tab="loans">Loans</button>'
      +   '<button class="fic-tab" data-fic-tab="arrangements">Arrangements</button>'
      +   '<button class="fic-tab" data-fic-tab="invoices">Invoices</button>'
      + '</div>'
      + '<div class="fic-body">'
      +   '<div class="fic-panel active" id="fic_panel_overview"></div>'
      +   '<div class="fic-panel" id="fic_panel_loans"></div>'
      +   '<div class="fic-panel" id="fic_panel_arrangements"></div>'
      +   '<div class="fic-panel" id="fic_panel_invoices"></div>'
      + '</div>'
      + '<div class="fic-footer" id="ficFooter"></div>'
      + '</div>';
    document.body.appendChild(div);

    _el('ficTabs').addEventListener('click', function (e) {
      var tab = e.target.getAttribute && e.target.getAttribute('data-fic-tab');
      if (tab) _ficSwitchTab(tab);
    });
    div.addEventListener('click', function (e) {
      if (e.target === div) closeFinanceCard();
    });
  }

  // ── Tab switch ────────────────────────────────────────────────────────────
  function _ficSwitchTab(tab) {
    document.querySelectorAll('#ficTabs .fic-tab').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-fic-tab') === tab);
    });
    document.querySelectorAll('#ficModal .fic-panel').forEach(function (p) {
      p.classList.toggle('active', p.id === 'fic_panel_' + tab);
    });
  }

  // ── Balance bar ───────────────────────────────────────────────────────────
  function _renderBalanceBar(tid, d) {
    var bar = _el('ficBalBar');
    if (!bar) return;
    var totals = typeof calcAllTotals === 'function' ? calcAllTotals(d) : {};
    var v = totals[tid] || {};
    var rent = v.rent || 0;
    var arr  = v.arrangement || 0;
    var loanBal = 0;
    (d.loanList || []).filter(function (l) { return l.tenantId === tid && l.status === 'approved'; })
      .forEach(function (l) {
        var paid = (d.loanPayments || [])
          .filter(function (p) { return p.loanId === l.id && p.status !== 'reversed'; })
          .reduce(function (s, p) { return s + p.amount; }, 0);
        loanBal += Math.max(0, (l.principal || 0) - paid);
      });
    var total = Math.max(0, rent) + Math.max(0, arr) + loanBal;
    bar.innerHTML =
        _balCell('Rent Owing',    Math.max(0, rent), true,  false)
      + _balCell('Arrangements',  Math.max(0, arr),  true,  false)
      + _balCell('Loans',         loanBal,            true,  false)
      + _balCell('Total Owing',   total,              true,  true);
  }

  // ── Overview tab — recent 20 transactions ─────────────────────────────────
  function _renderOverview(tid, d) {
    var panel = _el('fic_panel_overview');
    if (!panel) return;
    var entries = [];

    (d.rentLedger || []).filter(function (r) { return r.tenantId === tid; })
      .forEach(function (r) {
        entries.push({
          date: r.date, ledger: 'Rent', desc: r.desc || '',
          charge: r.charge || 0, payment: r.payment || 0, status: r.status || 'posted'
        });
      });

    (d.arrPayments || []).forEach(function (p) {
      var arr = (d.arrangements || []).find(function (a) { return a.id === p.arrId; });
      if (!arr || arr.tenantId !== tid) return;
      entries.push({
        date: p.date, ledger: 'Arr.', desc: 'Arrangement Payment' + (arr.ref ? ' — ' + arr.ref : ''),
        charge: 0, payment: p.amount || 0, status: p.status || 'posted'
      });
    });

    (d.loanPayments || []).forEach(function (p) {
      var loan = (d.loanList || []).find(function (l) { return l.id === p.loanId; });
      if (!loan || loan.tenantId !== tid) return;
      entries.push({
        date: p.date, ledger: 'Loan', desc: 'Loan Payment' + (loan.type ? ' — ' + loan.type : ''),
        charge: 0, payment: p.amount || 0, status: p.status || 'posted'
      });
    });

    entries.sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
    var total   = entries.length;
    var recent  = entries.slice(0, 20);

    if (!recent.length) {
      panel.innerHTML = '<div class="empty-state-ctr" style="padding:32px 0;">No transactions on file.</div>';
      return;
    }

    panel.innerHTML = '<div class="tbl-wrap"><table class="tbl">'
      + '<thead><tr><th>Date</th><th>Ledger</th><th>Description</th>'
      + '<th class="std-cell-right">Charge</th><th class="std-cell-right">Payment</th>'
      + '<th>Status</th></tr></thead><tbody>'
      + recent.map(function (e) {
          var rev  = e.status === 'reversed';
          var st   = rev ? ' style="opacity:.45;text-decoration:line-through;"' : '';
          var sCls = e.status === 'posted' ? 'pill-green' : (rev ? 'pill-gray' : 'pill-yellow');
          var lCls = e.ledger === 'Rent' ? 'pill-blue' : (e.ledger === 'Loan' ? 'std-pill-overdue' : 'pill-yellow');
          return '<tr' + st + '>'
            + '<td class="std-cell-muted">' + (e.date || '') + '</td>'
            + '<td><span class="std-pill ' + lCls + '" style="font-size:10px;">' + e.ledger + '</span></td>'
            + '<td>' + (e.desc || '') + '</td>'
            + '<td class="std-cell-right">'
            +   (e.charge > 0 ? '<span class="amt-debit">' + _fmt(e.charge) + '</span>' : '<span class="std-cell-dash">—</span>')
            + '</td>'
            + '<td class="std-cell-right">'
            +   (e.payment > 0 ? '<span class="amt-credit">' + _fmt(e.payment) + '</span>' : '<span class="std-cell-dash">—</span>')
            + '</td>'
            + '<td><span class="std-pill ' + sCls + '" style="font-size:10px;">' + (e.status || '') + '</span></td>'
            + '</tr>';
        }).join('')
      + '</tbody></table></div>'
      + (total > 20
          ? '<div style="text-align:center;padding:10px 0;font-size:12px;color:var(--muted);">'
            + 'Showing 20 of ' + total + ' entries — use Full Statement for complete history.</div>'
          : '');
  }

  // ── Loans tab ─────────────────────────────────────────────────────────────
  function _renderLoans(tid, d) {
    var panel = _el('fic_panel_loans');
    if (!panel) return;
    var loans = (d.loanList || []).filter(function (l) { return l.tenantId === tid; })
      .slice().sort(function (a, b) { return (b.startDate || '').localeCompare(a.startDate || ''); });

    if (!loans.length) {
      panel.innerHTML = '<div class="empty-state-ctr" style="padding:32px 0;">No loans on file.</div>';
      return;
    }

    panel.innerHTML = loans.map(function (l) {
      var pmts    = (d.loanPayments || []).filter(function (p) { return p.loanId === l.id && p.status !== 'reversed'; });
      var paid    = pmts.reduce(function (s, p) { return s + (p.amount || 0); }, 0);
      var balance = Math.max(0, (l.principal || 0) - paid);
      var pct     = (l.principal || 0) > 0 ? Math.min(100, Math.round((paid / l.principal) * 100)) : 0;
      var sCls    = l.status === 'approved' ? 'pill-green' : (l.status === 'rejected' ? 'pill-red' : 'pill-yellow');
      return '<div class="fic-account-card">'
        + '<div class="fic-account-card-header">'
        +   '<div>'
        +     '<div style="font-weight:700;font-size:15px;">' + (l.type || 'Loan') + '</div>'
        +     '<div class="txt-sm-meta" style="margin-top:3px;">Principal: ' + _fmt(l.principal || 0) + ' · Start: ' + (l.startDate || '—') + '</div>'
        +   '</div>'
        +   '<span class="std-pill ' + sCls + '">' + (l.status || 'pending') + '</span>'
        + '</div>'
        + '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:10px;">'
        +   '<div><div class="txt-sm-meta">Paid</div><div class="js-txt-bold amt-credit">' + _fmt(paid) + '</div></div>'
        +   '<div><div class="txt-sm-meta">Balance</div><div class="js-txt-bold' + (balance > 0 ? ' amt-debit' : '') + '">' + _fmt(balance) + '</div></div>'
        +   '<div><div class="txt-sm-meta">Progress</div><div class="js-txt-bold">' + pct + '%</div></div>'
        + '</div>'
        + '<div class="fic-progress-bar"><div class="fic-progress-fill" style="width:' + pct + '%;"></div></div>'
        + '</div>';
    }).join('');
  }

  // ── Arrangements tab ──────────────────────────────────────────────────────
  function _renderArrangements(tid, d) {
    var panel = _el('fic_panel_arrangements');
    if (!panel) return;
    var arrs = (d.arrangements || []).filter(function (a) { return a.tenantId === tid; })
      .slice().sort(function (a, b) { return (b.startDate || '').localeCompare(a.startDate || ''); });

    if (!arrs.length) {
      panel.innerHTML = '<div class="empty-state-ctr" style="padding:32px 0;">No arrangements on file.</div>';
      return;
    }

    panel.innerHTML = arrs.map(function (a) {
      var pmts    = (d.arrPayments || []).filter(function (p) { return p.arrId === a.id && p.status !== 'reversed'; });
      var paid    = pmts.reduce(function (s, p) { return s + (p.amount || 0); }, 0);
      var balance = Math.max(0, (a.totalOwing || 0) - paid);
      var pct     = (a.totalOwing || 0) > 0 ? Math.min(100, Math.round((paid / a.totalOwing) * 100)) : 0;
      var sCls    = a.status === 'completed' ? 'pill-green' : (a.status === 'suspended' ? 'pill-red' : 'pill-yellow');
      return '<div class="fic-account-card">'
        + '<div class="fic-account-card-header">'
        +   '<div>'
        +     '<div style="font-weight:700;font-size:15px;">' + (a.ref || 'Arrangement') + '</div>'
        +     '<div class="txt-sm-meta" style="margin-top:3px;">Total: ' + _fmt(a.totalOwing || 0) + ' · Start: ' + (a.startDate || '—') + '</div>'
        +   '</div>'
        +   '<div style="display:flex;align-items:center;gap:8px;">'
        +     '<button class="btn btn-ghost btn-sm" onclick="if(typeof previewArrangementAgreement===\'function\'){var d2=getData();var a2=(d2.arrangements||[]).find(function(x){return x.id===\'' + a.id + '\';});if(a2)previewArrangementAgreement(a2);}">&#128196; Agreement</button>'
        +     '<span class="std-pill ' + sCls + '">' + (a.status || 'active') + '</span>'
        +   '</div>'
        + '</div>'
        + '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:10px;">'
        +   '<div><div class="txt-sm-meta">Paid</div><div class="js-txt-bold amt-credit">' + _fmt(paid) + '</div></div>'
        +   '<div><div class="txt-sm-meta">Balance</div><div class="js-txt-bold' + (balance > 0 ? ' amt-debit' : '') + '">' + _fmt(balance) + '</div></div>'
        +   '<div><div class="txt-sm-meta">Progress</div><div class="js-txt-bold">' + pct + '%</div></div>'
        + '</div>'
        + '<div class="fic-progress-bar"><div class="fic-progress-fill" style="width:' + pct + '%;"></div></div>'
        + '</div>';
    }).join('');
  }

  // ── Invoices tab ──────────────────────────────────────────────────────────
  function _renderInvoices(tid, d) {
    var panel = _el('fic_panel_invoices');
    if (!panel) return;
    var charges = (d.rentLedger || [])
      .filter(function (r) { return r.tenantId === tid && (r.charge || 0) > 0; })
      .slice().sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });

    if (!charges.length) {
      panel.innerHTML = '<div class="empty-state-ctr" style="padding:32px 0;">No charges on file.</div>';
      return;
    }

    panel.innerHTML = '<div class="tbl-wrap"><table class="tbl">'
      + '<thead><tr><th>Date</th><th>Description</th>'
      + '<th class="std-cell-right">Amount</th><th>Reference</th><th>Status</th></tr></thead><tbody>'
      + charges.map(function (r) {
          var sCls = r.status === 'paid' ? 'pill-green' : (r.status === 'reversed' ? 'pill-gray' : 'pill-yellow');
          var st   = r.status === 'reversed' ? ' style="opacity:.45;text-decoration:line-through;"' : '';
          return '<tr' + st + '>'
            + '<td class="std-cell-muted">' + (r.date || '') + '</td>'
            + '<td>' + (r.desc || '') + '</td>'
            + '<td class="std-cell-right"><span class="amt-debit">' + _fmt(r.charge || 0) + '</span></td>'
            + '<td class="std-cell-muted">' + (r.ref || '—') + '</td>'
            + '<td><span class="std-pill ' + sCls + '" style="font-size:10px;">' + (r.status || 'unpaid') + '</span></td>'
            + '</tr>';
        }).join('')
      + '</tbody></table></div>';
  }

  // ── Footer ────────────────────────────────────────────────────────────────
  function _renderFooter(tid) {
    var footer = _el('ficFooter');
    if (!footer) return;
    var role = window.currentRole || '';
    var canAA = function (key) {
      return (typeof APPROVAL_AUTHORITY !== 'undefined' && APPROVAL_AUTHORITY.can)
        ? APPROVAL_AUTHORITY.can(key, role) : true;
    };
    var sid = (tid || '').replace(/'/g, "\\'");
    var btns = [];
    if (canAA('recordPayment'))
      btns.push('<button class="btn btn-ghost" onclick="closeFinanceCard();setTimeout(function(){openPaymentForTenant(\'' + sid + '\');},80);">💰 Record Payment</button>');
    if (canAA('createInvoice'))
      btns.push('<button class="btn btn-ghost" onclick="closeFinanceCard();setTimeout(function(){openInvoiceForTenant(\'' + sid + '\');},80);">📄 Create Invoice</button>');
    if (canAA('createArrangement'))
      btns.push('<button class="btn btn-ghost" onclick="closeFinanceCard();setTimeout(function(){openNewArrForTenant(\'' + sid + '\');},80);">📋 Arrangement</button>');
    if (canAA('manageLoan'))
      btns.push('<button class="btn btn-ghost" onclick="closeFinanceCard();setTimeout(function(){openNewLoanForTenant(\'' + sid + '\');},80);">💴 New Loan</button>');
    footer.innerHTML = btns.join('')
      + '<span class="fic-footer-spacer"></span>'
      + '<button class="btn btn-primary" onclick="closeFinanceCard();goToTenant(\'' + sid + '\');">Full Statement &#8594;</button>';
  }

  // ── Full render ───────────────────────────────────────────────────────────
  function _renderFic(tid) {
    // Resolve a merged duplicate to the canonical person so every per-tenant
    // filter below (ledger, loans, arrangements) rolls up under one record —
    // child rows are keyed to the canonical id after _finCanonicalizeTenantRefs.
    if (typeof finCanonTenantId === 'function') tid = finCanonTenantId(tid);
    var t    = typeof getTenant === 'function' ? getTenant(tid) : null;
    var name = t
      ? (typeof tenantName === 'function' ? tenantName(t) : (t.full_name || 'Tenant'))
      : 'Tenant';
    var sub  = t
      ? [(t.unit || ''), (t.type || '').replace(/-/g, ' ')].filter(Boolean).join(' · ')
      : '';

    var avEl = _el('ficAvatar'); if (avEl) avEl.textContent = _initials(name);
    var nmEl = _el('ficName');   if (nmEl) nmEl.textContent = name;
    var sbEl = _el('ficSub');    if (sbEl) sbEl.textContent = sub;

    var d = typeof getData === 'function' ? getData() : {};
    _renderBalanceBar(tid, d);
    _renderOverview(tid, d);
    _renderLoans(tid, d);
    _renderArrangements(tid, d);
    _renderInvoices(tid, d);
    _renderFooter(tid);
    _ficSwitchTab('overview');
  }

  // ── Public API ────────────────────────────────────────────────────────────
  window.openFinanceCard = function (tid) {
    _ficTid = tid;
    _injectCSS();
    _buildModal();
    var modal = _el('ficModal');
    if (modal) modal.classList.add('fic-open');
    document.body.classList.add('fic-open-body');
    _renderFic(tid);
  };

  window.closeFinanceCard = function () {
    var modal = _el('ficModal');
    if (modal) modal.classList.remove('fic-open');
    document.body.classList.remove('fic-open-body');
    _ficTid = null;
  };

  window.refreshFinanceCard = function () {
    if (_ficTid) _renderFic(_ficTid);
  };

})();
