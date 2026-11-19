/* ============================================================================
 * council-dashboard.js — Chief & Council leadership dashboard (Phase LD)
 *
 * A read-only, cross-app KPI view for leadership (Chief & Council). No data
 * edits — it summarises what's already loaded in memory on housing.html
 * (applications, housingUnits, _sowCache), so nothing leaves the nation's
 * control beyond what the app already reads (OCAP-friendly; no Power BI /
 * cloud replication). Charts render with Chart.js, lazy-loaded on first open
 * (already CSP-allowlisted + in the service-worker cache).
 *
 * Access is configurable in Settings > Approval Authority > Leadership
 * Dashboard (`accessLeadershipDashboard`, default ED + HM).
 *
 * Globals: showLeadershipDashboard(), renderLeadershipDashboard().
 * Finance KPIs are intentionally deferred until the finance model is built out.
 * ========================================================================== */
(function () {
  var _charts = {};          // live Chart instances, destroyed before re-render
  var _chartLibPromise = null;

  // ── Chart.js lazy-load (same CDN as ai-assistant / SW cache) ───────────────
  function _ensureChartLib() {
    if (window.Chart) return Promise.resolve();
    if (_chartLibPromise) return _chartLibPromise;
    _chartLibPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js';
      s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { _chartLibPromise = null; reject(new Error('Chart library failed to load')); };
      document.head.appendChild(s);
    });
    return _chartLibPromise;
  }

  function _canAccess() {
    var role = window.currentRole || '';
    if (window.APPROVAL_AUTHORITY && typeof APPROVAL_AUTHORITY.can === 'function') {
      return APPROVAL_AUTHORITY.can('accessLeadershipDashboard', role);
    }
    return role === 'ed' || role === 'housing_manager' || role === 'super_user';
  }

  // ── Public entry ───────────────────────────────────────────────────────────
  function showLeadershipDashboard() {
    if (!_canAccess()) {
      if (typeof showToast === 'function') showToast('You do not have access to the Chief & Council dashboard.', { type: 'error' });
      return;
    }
    if (typeof _showView === 'function') {
      _showView('leadershipDashView', renderLeadershipDashboard);
    } else {
      if (typeof hideAllViews === 'function') hideAllViews('leadershipDashView');
      var v = document.getElementById('leadershipDashView');
      if (v) v.style.display = 'flex';
      renderLeadershipDashboard();
    }
    if (typeof setNavActive === 'function') setNavActive('leadership');
  }

  // ── Small helpers ────────────────────────────────────────────────────────
  function _apps()  { return (typeof applications !== 'undefined' && applications) ? applications : (window.applications || []); }
  function _units() { return (typeof housingUnits  !== 'undefined' && housingUnits)  ? housingUnits  : (window.housingUnits  || []); }
  function _pct(n, d) { return d > 0 ? Math.round((n / d) * 100) : 0; }
  function _esc(s) { return (typeof escapeHtml === 'function') ? escapeHtml(s) : String(s == null ? '' : s); }

  // Flatten every SOW across the unit-keyed cache ({unitId:{sows:[...]}}).
  function _allSows() {
    var out = [];
    var cache = window._sowCache || {};
    Object.keys(cache).forEach(function (uid) {
      var wrap = cache[uid];
      if (!wrap) return;
      var arr = Array.isArray(wrap.sows) ? wrap.sows : (Array.isArray(wrap) ? wrap : []);
      arr.forEach(function (s) { if (s && typeof s === 'object') out.push(s); });
    });
    return out;
  }

  var SCORED = { new_housing: 1, transfer_request: 1 };
  function _isActiveApp(a) { return a && !a.archived && a.status !== 'declined'; }
  function _appType(a) { return (a && (a.appType || a.app_type)) || 'new_housing'; }

  // ── KPI computation ────────────────────────────────────────────────────────
  function _computeKpis() {
    var apps = _apps(), units = _units();

    var activeUnits = units.filter(function (u) { return u && !u.archived; });
    var byStatus = { occupied: 0, vacant: 0, reserved: 0, condemned: 0, other: 0 };
    activeUnits.forEach(function (u) {
      var st = (u.status || '').toLowerCase();
      if (byStatus[st] != null) byStatus[st]++; else byStatus.other++;
    });
    var totalUnits = activeUnits.length;
    // Occupancy = (occupied + reserved) / total units — reserved units are
    // committed stock (a tenant is assigned, moving in), so they count toward
    // occupancy; only truly-vacant units are "available". The full breakdown
    // sums back to total and is shown in the subtitle + occupancy chart.
    var occupancyRate = _pct(byStatus.occupied + byStatus.reserved, totalUnits);
    var outOfService = byStatus.condemned + byStatus.other;
    var occSubtitle = [
      byStatus.occupied + ' occupied',
      byStatus.reserved ? byStatus.reserved + ' reserved' : '',
      byStatus.vacant + ' vacant',
      outOfService ? outOfService + ' other' : ''
    ].filter(Boolean).join(' · ');

    // Waitlist: active, scored, not yet placed.
    var APPROVED = { mgr_approved: 1, hm_approved: 1, ed_approved: 1 };
    var openReview = apps.filter(function (a) {
      return _isActiveApp(a) && (a.status === 'submitted' || a.status === 'file_update' || a.status === 'mgr_approved');
    }).length;
    var awaitingMatch = apps.filter(function (a) {
      return _isActiveApp(a) && APPROVED[a.status] && !a.assignedUnit && SCORED[_appType(a)];
    }).length;

    // Applications by type (active).
    var byType = { 'New Housing': 0, 'Transfer / On-Rez': 0, 'File Update': 0 };
    apps.filter(_isActiveApp).forEach(function (a) {
      var t = _appType(a);
      if (t === 'transfer_request') byType['Transfer / On-Rez']++;
      else if (t === 'existing_tenant') byType['File Update']++;
      else if (t === 'commercial') { /* commercial not counted in residential waitlist */ }
      else byType['New Housing']++;
    });

    // Waitlist by priority tier (active + scored type + not placed). The scoring
    // model stores tiers as "Critical Priority" / "High Priority" / etc.
    // (scoring.js), so match by contains — not equality. Fall back to the
    // numeric score vs. the live thresholds, and bucket anything still
    // unresolved as "Unscored" so outstanding apps never silently disappear.
    var TIERS = ['Critical', 'High', 'Medium', 'Low'];
    function _tierOf(a) {
      var t = (a.tier || a.tier_v2 || '').toString().toLowerCase();
      for (var i = 0; i < TIERS.length; i++) { if (t.indexOf(TIERS[i].toLowerCase()) !== -1) return TIERS[i]; }
      var s = (typeof a.score === 'number') ? a.score : (typeof a.score_v2 === 'number' ? a.score_v2 : null);
      if (s != null) {
        var _t = window.liveV2Tiers || { critical: 80, high: 60, medium: 40 };
        return s >= _t.critical ? 'Critical' : s >= _t.high ? 'High' : s >= _t.medium ? 'Medium' : 'Low';
      }
      return 'Unscored';
    }
    var byTier = { Critical: 0, High: 0, Medium: 0, Low: 0, Unscored: 0 };
    apps.forEach(function (a) {
      if (!_isActiveApp(a) || !SCORED[_appType(a)] || a.assignedUnit) return;
      byTier[_tierOf(a)]++;
    });
    // Always show the full Critical→Low scale; append Unscored only if any exist.
    var tierLabels = TIERS.slice();
    if (byTier.Unscored > 0) tierLabels.push('Unscored');

    // Renovations (SOWs).
    var sows = _allSows();
    var year = new Date().getFullYear();
    var sowStatus = { Draft: 0, 'HM Approved': 0, 'ED / System Approved': 0, Completed: 0 };
    var activeReno = 0, completedYtd = 0;
    // Renovation dollars by work-item category — sum each item's estimated cost
    // (items carry {category, description, cost}) across non-archived SOWs.
    var byCategory = {};
    sows.forEach(function (s) {
      if (s.archived) return;
      var st = s.approval_status || '';
      if (st === 'completed') {
        sowStatus.Completed++;
        if ((s.completed_at || '').slice(0, 4) === String(year)) completedYtd++;
      } else {
        activeReno++;
        if (st === 'ed_approved' || s.system_approved) sowStatus['ED / System Approved']++;
        else if (st === 'hm_approved') sowStatus['HM Approved']++;
        else sowStatus.Draft++;
      }
      var items = Array.isArray(s.items) ? s.items : [];
      items.forEach(function (it) {
        if (!it) return;
        var cat = (it.category || '').toString().trim() || 'Uncategorized';
        var cost = parseFloat(String(it.cost != null ? it.cost : (it.amount || 0)).replace(/[^0-9.-]/g, '')) || 0;
        if (cost > 0) byCategory[cat] = (byCategory[cat] || 0) + cost;
      });
    });

    // Inspections overdue — from the unit's next-due date (no extra fetch).
    var today = new Date().toISOString().slice(0, 10);
    var overdueInsp = activeUnits.filter(function (u) {
      var due = u.nextInspectionDue || u.next_inspection_due || (u.data && u.data.next_inspection_due);
      return due && String(due) < today;
    }).length;

    return {
      totalUnits: totalUnits, occupancyRate: occupancyRate, byStatus: byStatus, occSubtitle: occSubtitle,
      byCategory: byCategory, openReview: openReview, awaitingMatch: awaitingMatch,
      byType: byType, byTier: byTier, tierLabels: tierLabels,
      sowStatus: sowStatus, activeReno: activeReno, completedYtd: completedYtd,
      overdueInsp: overdueInsp, waitlist: apps.filter(function (a) { return _isActiveApp(a) && SCORED[_appType(a)] && !a.assignedUnit; }).length
    };
  }

  // ── Applications trend — count by month over the last 12 months ────────────
  function _appTrend() {
    var apps = _apps();
    var labels = [], counts = [], idx = {};
    var now = new Date();
    for (var i = 11; i >= 0; i--) {
      var d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      var key = d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2);
      var lbl = d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
      idx[key] = labels.length; labels.push(lbl); counts.push(0);
    }
    apps.forEach(function (a) {
      if (!a || a.archived) return;
      var raw = a.submittedAt || a.appDate || a.created_at || a.submitted_at;
      if (!raw) return;
      var key = String(raw).slice(0, 7);
      if (idx[key] != null) counts[idx[key]]++;
    });
    return { labels: labels, counts: counts };
  }

  // ── Chart palette (brand-neutral, readable in light theme) ─────────────────
  var PAL = ['#1d4ed8', '#15803d', '#b45309', '#7c3aed', '#0891b2', '#be123c', '#4b5563', '#ca8a04'];
  var STATUS_COLORS = { occupied: '#15803d', vacant: '#1d4ed8', reserved: '#7c3aed', condemned: '#b91c1c', other: '#9ca3af' };

  // Application types by applicant age. Ages over 95 are treated as
  // placeholder birth dates (migrated records) and excluded, as are missing/
  // invalid DOBs — both are counted so the report says what it left out.
  // Commercial applications carry no personal DOB and are excluded outright.
  function _ageDistribution() {
    var apps = _apps().filter(_isActiveApp).filter(function (a) {
      return !a.deceased && _appType(a) !== 'commercial';
    });
    var buckets = ['<25', '25-34', '35-44', '45-54', '55-64', '65-79', '80-95'];
    var types = ['New Housing', 'Transfer / On-Rez', 'File Update'];
    var grid = {};
    types.forEach(function (t) { grid[t] = buckets.map(function () { return 0; }); });
    var noDob = 0, placeholder = 0, counted = 0;
    apps.forEach(function (a) {
      // Canonical age-from-DOB (policyAgeYears, policy-rules.js) — the local
      // 365.25-day formula it replaced disagreed by 1 near leap-year edges.
      var age = null;
      if (typeof policyAgeYears === 'function') age = policyAgeYears(a.dob);
      else {
        var raw = String(a.dob || '').slice(0, 10);
        var d = raw ? new Date(raw + 'T12:00:00') : null;
        if (d && !isNaN(d.getTime())) age = Math.floor((Date.now() - d.getTime()) / 31557600000);
      }
      if (age == null) { noDob++; return; }
      if (age > 95 || age < 0) { placeholder++; return; }
      var bi = age < 25 ? 0 : age < 35 ? 1 : age < 45 ? 2 : age < 55 ? 3 : age < 65 ? 4 : age < 80 ? 5 : 6;
      var t = _appType(a);
      var label = t === 'transfer_request' ? types[1] : t === 'existing_tenant' ? types[2] : types[0];
      grid[label][bi]++;
      counted++;
    });
    return { buckets: buckets, types: types, grid: grid, noDob: noDob, placeholder: placeholder, counted: counted };
  }

  function _mkChart(canvasId, config) {
    var el = document.getElementById(canvasId);
    if (!el || !window.Chart) return;
    if (_charts[canvasId]) { _charts[canvasId].destroy(); delete _charts[canvasId]; }
    _charts[canvasId] = new Chart(el.getContext('2d'), config);
  }

  function _destroyAll() {
    Object.keys(_charts).forEach(function (k) { try { _charts[k].destroy(); } catch (e) {} });
    _charts = {};
  }

  // ── View shell (self-injected) ─────────────────────────────────────────────
  function _kpiCard(label, value, meta, accent) {
    return '<div class="kpi-card' + (accent ? ' ' + accent : '') + '">'
      + '<div class="kpi-label">' + _esc(label) + '</div>'
      + '<div class="kpi-value">' + _esc(value) + '</div>'
      + (meta ? '<div class="kpi-meta">' + _esc(meta) + '</div>' : '')
      + '</div>';
  }
  function _chartCard(title, canvasId, sub) {
    return '<div class="card ld-chart-card">'
      + '<div class="ld-chart-title">' + _esc(title) + (sub ? ' <span class="ld-chart-sub">' + _esc(sub) + '</span>' : '') + '</div>'
      + '<div class="ld-chart-wrap"><canvas id="' + canvasId + '"></canvas></div>'
      + '</div>';
  }

  function renderLeadershipDashboard() {
    var host = document.getElementById('leadershipDashView');
    if (!host) return;
    if (!_canAccess()) { host.innerHTML = '<div class="empty-state-ctr" style="padding:40px;">You do not have access to this dashboard.</div>'; return; }
    _destroyAll();

    var k = _computeKpis();
    var nation = (window.NATION_CONFIG && (NATION_CONFIG.short || NATION_CONFIG.display_name)) || '';

    var html = ''
      + '<div class="page-header-bar" style="margin-bottom:14px;">'
      +   '<div><h1 style="margin:0;">Reports</h1>'
      +   '<p style="margin:2px 0 0;color:var(--muted);font-size:13px;">' + _esc(nation ? nation + ' — ' : '') + 'Housing at a glance · read-only</p></div>'
      +   '<div style="display:flex;gap:8px;flex-wrap:wrap;">'
      +     '<button class="btn btn-ghost" onclick="if(typeof arrearsCouncilReport===\'function\')arrearsCouncilReport(\'pdf\')" title="Rental arrears report for Chief & Council">&#128196; A/R Report (PDF)</button>'
      +     '<button class="btn btn-ghost" onclick="if(typeof arrearsCouncilReport===\'function\')arrearsCouncilReport(\'csv\')">A/R CSV</button>'
      +     '<button class="btn btn-ghost" onclick="if(typeof arrearsNoHouseReport===\'function\')arrearsNoHouseReport(\'pdf\')" title="People with arrears and NO current housing — former tenancies and unhoused applicants. These balances block a new unit assignment until a repayment arrangement is approved.">&#127962; A/R No-House (PDF)</button>'
      +     '<button class="btn btn-ghost" onclick="if(typeof arrearsNoHouseReport===\'function\')arrearsNoHouseReport(\'csv\')">No-House CSV</button>'
      +     '<button class="btn btn-ghost" onclick="if(typeof _arClsReport===\'function\')_arClsReport(\'pdf\')" title="A/R cleanup classifications — grouped by flag, tenants with their Sage cust #s and totals">&#129529; A/R Cleanup (PDF)</button>'
      +     '<button class="btn btn-ghost" onclick="if(typeof _arClsReport===\'function\')_arClsReport(\'csv\')">Cleanup CSV</button>'
      +     '<button class="btn btn-ghost" onclick="renderLeadershipDashboard()" title="Refresh">&#8635; Refresh</button>'
      +   '</div>'
      + '</div>';

    // KPI strip
    html += '<div class="kpi-strip ld-kpis">'
      + _kpiCard('Total Units', k.totalUnits, 'Active housing stock')
      + _kpiCard('Occupancy Rate', k.occupancyRate + '%', k.occSubtitle, 'kpi-accent-success')
      + _kpiCard('Vacant Units', k.byStatus.vacant, 'Available to fill')
      + _kpiCard('Applicants Waiting', k.waitlist, k.openReview + ' pending review')
      + _kpiCard('Awaiting Match', k.awaitingMatch, 'Approved, no unit yet')
      + _kpiCard('Active Renovations', k.activeReno, k.completedYtd + ' completed this year')
      + _kpiCard('Inspections Overdue', k.overdueInsp, 'Past their due date', k.overdueInsp > 0 ? 'kpi-accent-danger' : '')
      + (function () {
          // Arrears KPI — from the arrears machine's live finance data. When
          // the cache hasn't loaded yet, kick it and re-render once ready.
          if (typeof arrearsReportData !== 'function') return '';
          if (!(window._arrearsCache && window._arrearsCache.loaded)) {
            if (typeof arrearsLoad === 'function' && !window._ldArrKick) {
              window._ldArrKick = true;
              arrearsLoad().then(function () { window._ldArrKick = false; renderLeadershipDashboard(); }).catch(function () {});
            }
            return _kpiCard('Arrears Outstanding', '…', 'loading finance data');
          }
          var ar = arrearsReportData();
          return _kpiCard('Arrears Outstanding',
            '$' + Math.round(ar.sum.outstanding).toLocaleString(),
            ar.sum.inArrears + ' accounts · ' + ar.sum.arrActive + ' arrangements',
            ar.sum.outstanding > 0 ? 'kpi-accent-danger' : 'kpi-accent-success');
        })()
      + '</div>';

    // Charts grid
    html += '<div class="ld-chart-grid">'
      + _chartCard('Unit Occupancy', 'ld_chart_occupancy')
      + _chartCard('Waitlist by Priority', 'ld_chart_tier', 'scored & unplaced')
      + _chartCard('Applications by Type', 'ld_chart_type', 'active')
      + _chartCard('Application Types by Age', 'ld_chart_agedist', (function () {
          var ad = _ageDistribution();
          var excl = ad.noDob + ad.placeholder;
          return ad.counted + ' applicants' + (excl ? ' · ' + excl + ' excluded (no or placeholder birth date)' : '');
        })())
      + _chartCard('Renovation $ by Category', 'ld_chart_renocat', 'estimated cost')
      + _chartCard('Renovation Pipeline', 'ld_chart_sow', 'by approval stage')
      + _chartCard('Applications — Last 12 Months', 'ld_chart_trend')
      + '</div>';

    host.innerHTML = html;

    _ensureChartLib().then(function () {
      var commonLegend = { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } } };

      // Occupancy doughnut
      var occLabels = ['Occupied', 'Vacant', 'Reserved', 'Condemned'];
      var occKeys = ['occupied', 'vacant', 'reserved', 'condemned'];
      _mkChart('ld_chart_occupancy', {
        type: 'doughnut',
        data: { labels: occLabels, datasets: [{ data: occKeys.map(function (kk) { return k.byStatus[kk]; }),
          backgroundColor: occKeys.map(function (kk) { return STATUS_COLORS[kk]; }), borderWidth: 0 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: commonLegend, cutout: '58%' }
      });

      // Waitlist by tier (bar)
      _mkChart('ld_chart_tier', {
        type: 'bar',
        data: { labels: k.tierLabels, datasets: [{ label: 'Applicants', data: k.tierLabels.map(function (t) { return k.byTier[t]; }),
          backgroundColor: k.tierLabels.map(function (_, i) { return PAL[i % PAL.length]; }) }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
          scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } }
      });

      // Applications by type (doughnut)
      var typeLabels = Object.keys(k.byType);
      _mkChart('ld_chart_type', {
        type: 'doughnut',
        data: { labels: typeLabels, datasets: [{ data: typeLabels.map(function (t) { return k.byType[t]; }),
          backgroundColor: typeLabels.map(function (_, i) { return PAL[i % PAL.length]; }), borderWidth: 0 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: commonLegend, cutout: '58%' }
      });

      // Application types by age (stacked bar, ages capped at 95 — older
      // birth dates are migration placeholders and sit in the excluded count)
      var ad = _ageDistribution();
      _mkChart('ld_chart_agedist', {
        type: 'bar',
        data: { labels: ad.buckets, datasets: ad.types.map(function (t, i) {
          return { label: t, data: ad.grid[t], backgroundColor: PAL[i % PAL.length] };
        }) },
        options: { responsive: true, maintainAspectRatio: false, plugins: commonLegend,
          scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } } } }
      });

      // Renovation $ by category (horizontal bar, sorted high→low, dollars)
      var catPairs = Object.keys(k.byCategory).map(function (c) { return [c, k.byCategory[c]]; })
        .sort(function (a, b) { return b[1] - a[1]; });
      var catLabels = catPairs.map(function (p) { return p[0]; });
      var catVals = catPairs.map(function (p) { return p[1]; });
      var money = function (v) { return (typeof formatCurrency === 'function') ? formatCurrency(v) : ('$' + Math.round(v).toLocaleString()); };
      _mkChart('ld_chart_renocat', {
        type: 'bar',
        data: { labels: catLabels.length ? catLabels : ['No renovation costs recorded'],
          datasets: [{ label: 'Estimated $', data: catLabels.length ? catVals : [0],
          backgroundColor: (catLabels.length ? catLabels : [0]).map(function (_, i) { return PAL[i % PAL.length]; }) }] },
        options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false },
            tooltip: { callbacks: { label: function (ctx) { return money(ctx.parsed.x); } } } },
          scales: { x: { beginAtZero: true, ticks: { callback: function (v) { return money(v); } } } } }
      });

      // Renovation pipeline (bar)
      var sowLabels = Object.keys(k.sowStatus);
      _mkChart('ld_chart_sow', {
        type: 'bar',
        data: { labels: sowLabels, datasets: [{ label: 'SOWs', data: sowLabels.map(function (s) { return k.sowStatus[s]; }),
          backgroundColor: ['#9ca3af', '#b45309', '#15803d', '#1d4ed8'] }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
          scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } }
      });

      // Applications trend (line)
      var tr = _appTrend();
      _mkChart('ld_chart_trend', {
        type: 'line',
        data: { labels: tr.labels, datasets: [{ label: 'Applications', data: tr.counts, borderColor: '#1d4ed8',
          backgroundColor: 'rgba(29,78,216,0.12)', fill: true, tension: 0.3, pointRadius: 3 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
          scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } }
      });
    }).catch(function (e) {
      var grid = host.querySelector('.ld-chart-grid');
      if (grid) grid.insertAdjacentHTML('afterbegin', '<div class="card" style="padding:16px;color:var(--danger);">Charts could not load (' + _esc(e.message) + '). KPI numbers above are still accurate.</div>');
    });
  }

  window.showLeadershipDashboard   = showLeadershipDashboard;
  window.renderLeadershipDashboard = renderLeadershipDashboard;
})();
