/* admin.js — FN Hub super-admin panel (P1: auth gate, nations registry, admins).
 * Talks only to the CONTROL-PLANE ("fnhub-platform") Supabase project. Access is
 * gated by the super_admins allow-list (enforced by RLS on that project). The
 * auto-provisioning wizard (create Supabase project, deploy functions, etc.) is
 * a later phase; here you manage the registry, module licensing, and admins. */
(function () {
  'use strict';

  var PBASE = (window.PLATFORM_SUPABASE_URL || '').replace(/\/$/, '');
  var ANON  = window.PLATFORM_SUPABASE_ANON || '';
  var AUTH  = PBASE + '/auth/v1';
  var REST  = PBASE + '/rest/v1';
  var REDIRECT = location.origin + location.pathname;
  var LS_AT = 'fnhub_admin_at', LS_RT = 'fnhub_admin_rt';

  // Optional modules a nation can be licensed for (mirrors CLFN_MODULES keys).
  // Must mirror the optional-module keys in CLFN_MODULES._licensed
  // (shared-config.js). A key missing here cannot be licensed or un-licensed
  // from this panel: applyNationLicensing() only overrides keys PRESENT in
  // modules_licensed, so an omitted module silently keeps its default (true)
  // for every nation. Add new modules to both places.
  var MODULES = [
    ['finance','Finance'], ['match','Match'], ['contractors','Contractors'],
    ['renovations','Renovations'], ['rfq','RFQ'], ['mapping','Mapping'],
    ['inspections','Inspections'], ['ai_assistant','AI Assistant'],
    ['projects','Capital Projects']
  ];

  // Home Land Homes fee schedule for the invoice builder + recurring-billing
  // picker. Prices live ONLY in admin-pricing.js (window.HLH_PRICING, loaded
  // first by index.html) -- edit them there, never here. Item shape:
  // g=group, d=line description, p=unit price (CAD), q=default qty;
  // hours=qty is entered in hours (unit is per-hour); custom=price is
  // free-entry. NOTE: never edit the d strings — saved nation_billing rows
  // re-select their line item by exact-description match.
  var FEE_SCHEDULE = window.HLH_PRICING.feeSchedule();

  // Provider (Home Land Homes) details -- printed on invoices.
  var PROVIDER = {
    name:  'Home Land Homes',
    addr1: '916 Piper Street, Box 2251',
    addr2: 'Hearst, Ontario  P0L 1N0',
    phone: '705-960-5076',
    email: 'hello@homelandhomes.ca'
  };
  // Past-due interest rate per the agreement (Section 7.5): 1% per month.
  var INTEREST_MONTHLY = 0.01;
  // YYYY-MM-DD for today + n days (browser Date is available here).
  function _dPlus(n){ return new Date(Date.now() + n * 86400000).toISOString().slice(0, 10); }
  // Grouped <select> of the fee schedule (built at render time so _money exists).
  function _feeScheduleSelectHtml(){
    var groups = [];
    FEE_SCHEDULE.forEach(function(it, i){
      var gi = null;
      for (var k = 0; k < groups.length; k++){ if (groups[k].g === it.g){ gi = groups[k]; break; } }
      if (!gi){ gi = { g: it.g, items: [] }; groups.push(gi); }
      gi.items.push({ i: i, it: it });
    });
    var opts = groups.map(function(g){
      return '<optgroup label="' + esc(g.g) + '">' + g.items.map(function(x){
        var price = x.it.custom ? 'enter amount' : (x.it.hours ? _money(x.it.p) + '/hr' : _money(x.it.p));
        return '<option value="' + x.i + '">' + esc(x.it.d) + '  —  ' + price + '</option>';
      }).join('') + '</optgroup>';
    }).join('');
    return '<select id="cn-inv-catalog">' + opts + '</select>';
  }

  var app = document.getElementById('app');
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); };
  var _nations = [];   // last-loaded nations list (so Configure can look one up)

  // External destinations referenced by the checklist + field hints. Supabase
  // dashboard deep links use the "/project/_/..." form, which resolves to the
  // operator's last-opened project (or the picker) -- exact refs aren't known
  // until the nation's project is created.
  var LINKS = {
    supaNew:  'https://supabase.com/dashboard/new',                       // create a project
    supaApi:  'https://supabase.com/dashboard/project/_/settings/api',    // URL + keys
    supaFns:  'https://supabase.com/dashboard/project/_/settings/functions', // Edge Function secrets
    supaCli:  'https://supabase.com/docs/guides/functions/deploy',        // functions deploy docs
    cf:       'https://dash.cloudflare.com',                              // Cloudflare (DNS + Workers)
    gh:       'https://github.com/fnhub-app/fnhub-platform/actions',       // deploy workflows
    azure:    'https://portal.azure.com',                                // Entra app registrations
    resend:   'https://resend.com/domains'                               // verify domain + API keys
  };
  function extLink(href, label){ return '<a href="' + href + '" target="_blank" rel="noopener" style="color:#1d4ed8;font-weight:600;">' + label + '</a>'; }
  // Small muted "where to find it" line under a form field.
  function fieldHint(html){ return '<div class="sub" style="margin:4px 0 0;font-size:11px;line-height:1.45;">' + html + '</div>'; }

  function getAT(){ return localStorage.getItem(LS_AT) || ''; }
  function getRT(){ return localStorage.getItem(LS_RT) || ''; }
  function setSession(at, rt){ if (at) localStorage.setItem(LS_AT, at); if (rt) localStorage.setItem(LS_RT, rt); }
  function clearSession(){ localStorage.removeItem(LS_AT); localStorage.removeItem(LS_RT); }
  function jwtEmail(){ try { return (JSON.parse(atob(getAT().split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))).email || '').toLowerCase(); } catch(e){ return ''; } }

  async function refreshSession(){
    var rt = getRT(); if (!rt) return false;
    try {
      var r = await fetch(AUTH + '/token?grant_type=refresh_token', { method:'POST', headers:{ apikey:ANON, 'Content-Type':'application/json' }, body: JSON.stringify({ refresh_token: rt }) });
      if (!r.ok) return false;
      var d = await r.json(); if (d && d.access_token){ setSession(d.access_token, d.refresh_token || rt); return true; }
    } catch(e){}
    return false;
  }

  async function api(method, path, body, prefer){
    var mk = function(){ var o = { method:method, headers:{ apikey:ANON, Authorization:'Bearer '+getAT(), 'Content-Type':'application/json' } }; if (prefer) o.headers['Prefer'] = prefer; if (body) o.body = JSON.stringify(body); return o; };
    var r = await fetch(REST + path, mk());
    if (r.status === 401 && await refreshSession()) r = await fetch(REST + path, mk());
    return r;
  }

  // ---- Views -----------------------------------------------------------------
  function showLogin(prefill){
    app.innerHTML =
      '<h1>Platform admin sign-in</h1>'
      + '<p class="sub">Restricted to FN Hub platform administrators. Enter your email and we\'ll send a secure sign-in link.</p>'
      + '<label>Email address</label>'
      + '<input id="em" type="email" inputmode="email" autocomplete="email" placeholder="you@example.com" value="' + esc(prefill||'') + '"/>'
      + '<div class="msg" id="lmsg"></div>'
      + '<button class="btn" id="lbtn" type="button">Email me a sign-in link</button>'
      + '<div class="foot">If you reach this page and aren\'t an administrator, you won\'t be able to sign in.</div>';
    document.getElementById('lbtn').addEventListener('click', sendLink);
    document.getElementById('em').addEventListener('keydown', function(e){ if (e.key === 'Enter') sendLink(); });
  }
  function setMsg(id, t, k){ var el = document.getElementById(id); if (el){ el.className = 'msg ' + (k||'err'); el.textContent = t; } }
  // Success message with an inline "View PDF" link (opens a blob URL in a new tab).
  function setMsgWithView(id, text, url){
    var el = document.getElementById(id); if (!el) return;
    el.className = 'msg ok';
    el.innerHTML = esc(text) + ' <a href="' + url + '" target="_blank" rel="noopener" style="font-weight:700;text-decoration:underline;color:inherit;">View PDF &rarr;</a>';
  }

  // ---- Branded modal dialogs (replace native alert/confirm/prompt) -----------
  // The browser's own alert()/confirm()/prompt() render an unbranded
  // "admin.fnhub.app says" box. These build DOM styled to the panel brand
  // (--ink header, --accent primary button) and return Promises so the async
  // invoice/flow code can `await` them. CSP is script-src 'self', so listeners
  // are wired directly (no inline handlers).
  function _dlgEnsureStyle(){
    if (document.getElementById('dlg-style')) return;
    var s = document.createElement('style'); s.id = 'dlg-style';
    s.textContent =
      '.dlg-ov{position:fixed;inset:0;background:rgba(17,17,16,.55);display:flex;align-items:center;justify-content:center;z-index:9999;padding:18px;}'
    + '.dlg{background:var(--surface);border-radius:14px;box-shadow:0 18px 50px rgba(0,0,0,.3);max-width:440px;width:100%;overflow:hidden;animation:dlgin .12s ease-out;}'
    + '@keyframes dlgin{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}'
    + '.dlg-hd{background:var(--ink);color:#fff;padding:12px 18px;font-weight:700;font-size:14px;display:flex;align-items:center;gap:8px;}'
    + '.dlg-hd .dot{width:8px;height:8px;border-radius:50%;background:var(--accent);flex-shrink:0;}'
    + '.dlg-bd{padding:16px 18px;font-size:14px;color:var(--ink);white-space:pre-wrap;line-height:1.5;}'
    + '.dlg-bd label{display:block;font-size:12px;font-weight:600;color:var(--muted);margin:12px 0 4px;white-space:normal;}'
    + '.dlg-err{color:var(--danger);font-size:12px;margin-top:6px;min-height:14px;}'
    + '.dlg-ft{display:flex;justify-content:flex-end;gap:8px;padding:4px 18px 16px;}'
    + '.dlg-ft .btn{margin-top:0;padding:9px 16px;font-size:14px;}';
    document.head.appendChild(s);
  }
  function _dlgOpen(opts){
    _dlgEnsureStyle();
    return new Promise(function(resolve){
      var ov = document.createElement('div'); ov.className = 'dlg-ov';
      var html = '<div class="dlg-hd"><span class="dot"></span>' + esc(opts.title || 'Home Land Homes') + '</div>'
        + '<div class="dlg-bd">' + (opts.bodyHtml || esc(opts.message || ''));
      if (opts.fields){
        opts.fields.forEach(function(f){
          html += '<label for="dlg-f-' + esc(f.key) + '">' + esc(f.label || '') + '</label>'
            + '<input id="dlg-f-' + esc(f.key) + '" type="' + (f.inputType || 'text') + '" value="' + esc(f.defaultValue == null ? '' : f.defaultValue) + '"'
            + (f.placeholder ? ' placeholder="' + esc(f.placeholder) + '"' : '')
            + (f.step ? ' step="' + esc(f.step) + '"' : '') + '/>';
        });
        html += '<div class="dlg-err" id="dlg-err"></div>';
      } else if (opts.prompt){
        html += '<label>' + esc(opts.label || '') + '</label>'
          + '<input id="dlg-input" type="' + (opts.inputType || 'text') + '" value="' + esc(opts.defaultValue == null ? '' : opts.defaultValue) + '"'
          + (opts.placeholder ? ' placeholder="' + esc(opts.placeholder) + '"' : '')
          + (opts.step ? ' step="' + esc(opts.step) + '"' : '') + '/>'
          + '<div class="dlg-err" id="dlg-err"></div>';
      }
      html += '</div><div class="dlg-ft">';
      if (opts.cancel !== false) html += '<button class="btn ghost" type="button" id="dlg-cancel">' + esc(opts.cancelText || 'Cancel') + '</button>';
      html += '<button class="btn" type="button" id="dlg-ok">' + esc(opts.okText || 'OK') + '</button></div>';
      var box = document.createElement('div'); box.className = 'dlg'; box.innerHTML = html;
      ov.appendChild(box); document.body.appendChild(ov);
      var input = box.querySelector('#dlg-input') || box.querySelector('.dlg-bd input');
      var errEl = box.querySelector('#dlg-err');
      if (input){ try { input.focus(); input.select(); } catch(e){} }
      function done(val){ if (ov.parentNode) ov.parentNode.removeChild(ov); document.removeEventListener('keydown', onKey); resolve(val); }
      function ok(){
        if (opts.fields){
          var out = {};
          for (var i = 0; i < opts.fields.length; i++){
            var f = opts.fields[i];
            var el = box.querySelector('#dlg-f-' + f.key);
            var val = (el && el.value || '').trim();
            if (f.validate){ var em = f.validate(val, out); if (em){ if (errEl) errEl.textContent = em; if (el){ try { el.focus(); } catch(e){} } return; } }
            out[f.key] = val;
          }
          done(out);
        } else if (opts.prompt){
          var v = (input && input.value || '').trim();
          if (opts.validate){ var m = opts.validate(v); if (m){ if (errEl) errEl.textContent = m; return; } }
          done(v);
        } else done(true);
      }
      function cancel(){ done((opts.prompt || opts.fields) ? null : false); }
      var okBtn = box.querySelector('#dlg-ok'); if (okBtn) okBtn.onclick = ok;
      var cBtn = box.querySelector('#dlg-cancel'); if (cBtn) cBtn.onclick = cancel;
      ov.addEventListener('click', function(e){ if (e.target === ov) cancel(); });
      function onKey(e){ if (e.key === 'Escape'){ e.preventDefault(); cancel(); } else if (e.key === 'Enter'){ e.preventDefault(); ok(); } }
      document.addEventListener('keydown', onKey);
    });
  }
  function dlgAlert(message, opts){ opts = opts || {}; return _dlgOpen({ title: opts.title, message: message, bodyHtml: opts.bodyHtml, cancel: false, okText: opts.okText || 'OK' }); }
  function dlgConfirm(message, opts){ opts = opts || {}; return _dlgOpen({ title: opts.title, message: message, bodyHtml: opts.bodyHtml, okText: opts.okText || 'Confirm', cancelText: opts.cancelText }); }
  function dlgPrompt(label, defaultValue, opts){ opts = opts || {}; return _dlgOpen({ title: opts.title, message: opts.message || '', bodyHtml: opts.bodyHtml, prompt: true, label: label, defaultValue: defaultValue, inputType: opts.inputType, step: opts.step, placeholder: opts.placeholder, validate: opts.validate, okText: opts.okText || 'Save' }); }
  // Multi-field branded form. fields: [{key,label,inputType,defaultValue,step,placeholder,validate(value,soFar)->errMsg|''}].
  // Resolves an object of {key:value} on OK, or null on cancel.
  function dlgForm(title, fields, opts){ opts = opts || {}; return _dlgOpen({ title: title, message: opts.message || '', bodyHtml: opts.bodyHtml, fields: fields, okText: opts.okText || 'Save', cancelText: opts.cancelText }); }

  async function sendLink(){
    var em = (document.getElementById('em').value || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) { setMsg('lmsg','Please enter a valid email address.'); return; }
    var btn = document.getElementById('lbtn'); btn.disabled = true; btn.textContent = 'Sending…';
    try {
      var r = await fetch(AUTH + '/otp?redirect_to=' + encodeURIComponent(REDIRECT), { method:'POST', headers:{ apikey:ANON, 'Content-Type':'application/json' }, body: JSON.stringify({ email: em, create_user: true }) });
      if (r.ok) {
        app.innerHTML = '<div class="center"><div style="font-size:40px;">📧</div><h1>Check your email</h1>'
          + '<p class="sub">A sign-in link was sent to <b>' + esc(em) + '</b>. Open it on this device.</p>'
          + '<button class="btn ghost" type="button" data-act="reload">Back</button></div>';
      } else { var d = await r.json().catch(function(){return{};}); setMsg('lmsg', (d && (d.msg||d.error_description||d.error)) || 'Could not send the link.'); btn.disabled=false; btn.textContent='Email me a sign-in link'; }
    } catch(e){ setMsg('lmsg','Network error. Please try again.'); btn.disabled=false; btn.textContent='Email me a sign-in link'; }
  }

  async function showDashboard(){
    app.innerHTML = '<div class="center"><p class="sub">Checking access…</p></div>';
    // Gate: RLS only returns super_admins rows to actual admins.
    var meEmail = jwtEmail();
    var r = await api('GET', '/super_admins?select=email,added_by,added_at&order=added_at');
    if (r.status === 401){ clearSession(); showLogin(); return; }
    var admins = r.ok ? await r.json().catch(function(){return[];}) : [];
    var amAdmin = admins.some(function(a){ return String(a.email||'').toLowerCase() === meEmail; });
    if (!amAdmin){
      app.innerHTML = '<div class="center"><div style="font-size:40px;">🚫</div><h1>Not authorized</h1>'
        + '<p class="sub">' + esc(meEmail) + ' is not a platform administrator.</p>'
        + '<button class="btn" type="button" data-act="logout">Sign out</button></div>';
      return;
    }
    document.getElementById('btn_out').style.display = '';

    // Load nations.
    var nr = await api('GET', '/nations?select=*&order=created_at.desc');
    var nations = nr.ok ? await nr.json().catch(function(){return[];}) : [];
    _nations = nations;

    // Load per-nation usage (push-reported by each nation's app). Keyed by
    // subdomain; absent until a nation manager has opened Settings -> Nation.
    var ur = await api('GET', '/nation_usage?select=*');
    var usageRows = ur.ok ? await ur.json().catch(function(){return[];}) : [];
    var usageBySub = {};
    usageRows.forEach(function(u){ if (u && u.subdomain) usageBySub[u.subdomain] = u; });

    // Platform summary for the strip.
    var activeCount = nations.filter(function(n){ return (n.status || '') === 'active'; }).length;
    var totDb = 0, totFiles = 0, totCost = 0;
    nations.forEach(function(n){
      var u = usageBySub[n.subdomain];
      if (u){ totDb += Number(u.database_bytes) || 0; totFiles += Number(u.storage_bytes) || 0; }
      totCost += estCost(n, u).total;
    });
    totCost = Math.round(totCost * 100) / 100;

    var tab = function(k, l, active){ return '<button class="nic-tab' + (active ? ' active' : '') + '" type="button" data-act="nic-tab" data-tab="' + k + '">' + l + '</button>'; };
    var panel = function(k, html, active){ return '<div class="nic-panel' + (active ? ' active' : '') + '" data-panel="' + k + '">' + html + '</div>'; };
    var tile = function(l, v){ return '<div class="nic-strip-tile"><div class="l">' + esc(l) + '</div><div class="v">' + v + '</div></div>'; };

    app.innerHTML =
      '<div class="nic-shell">'
      + '<div class="nic-hero">'
      +   '<h1>Platform Admin</h1>'
      +   '<div class="nic-sub">Home Land Homes control plane &middot; signed in as <code>' + esc(meEmail) + '</code></div>'
      // The control-plane project ref, one click to copy — it's needed for the
      // platform SQL editor, workflow inputs, and function deploys, and was
      // otherwise only findable by dissecting the Supabase URL.
      // Explicit light styling: the ghost-button classes assume a light card,
      // so on this dark hero the button rendered black-on-black (invisible).
      +   '<div class="nic-sub" style="margin-top:4px;">Platform project ref: <code id="plat-ref">' + esc(_refFromUrl(window.PLATFORM_SUPABASE_URL || '') || '') + '</code> '
      +     '<button class="btn sm" type="button" data-act="copy-text" data-copy="' + esc(_refFromUrl(window.PLATFORM_SUPABASE_URL || '') || '') + '" style="padding:2px 10px;font-size:11px;background:transparent;color:#fff;border:1px solid rgba(255,255,255,.5);border-radius:7px;cursor:pointer;">Copy</button></div>'
      + '</div>'
      + '<div class="nic-strip">'
      +   tile('Nations', String(nations.length))
      +   tile('Active', String(activeCount))
      +   tile('Data usage', esc(fmtBytes(totDb)) + ' db &middot; ' + esc(fmtBytes(totFiles)) + ' files')
      +   tile('Est. monthly cost', _money(totCost))
      + '</div>'
      + '<div class="nic-tabs">'
      +   tab('nations', 'Nations', true) + tab('provision', 'Provision') + tab('addnation', 'Add a nation') + tab('migrations', 'Migrations') + tab('admins', 'Administrators')
      + '</div>'
      + '<div class="nic-body">'
      +   panel('nations',   nationsCard(nations, usageBySub), true)
      // The wizard stays expanded; the three long reference guides collapse
      // into <details> cards so the tab is scannable (they had grown into one
      // very long scroll).
      +   panel('provision', provisionCard()
              + foldCard('Adding a nation — step by step', 'The full workflow across Supabase, GitHub, and Cloudflare', addNationStepsCard())
              + foldCard('Email delivery setup — Microsoft 365 (Graph) & Resend', 'Provider-side setup; day-to-day config lives in each nation\'s Email Config tab', emailSetupCard())
              + foldCard('Support login setup — the "Enter" button', 'Per-nation signing keys for platform support sessions', supportLoginSetupCard()), false)
      +   panel('addnation', addNationCard(), false)
      +   panel('migrations', migrationsCard(nations), false)
      +   panel('admins',    adminsCard(admins, meEmail), false)
      + '</div>'
      + '</div>';
    wireAddNation();
  }

  // Human byte formatter for the admin panel (mirrors the nation app's _duFmtBytes).
  function fmtBytes(b){
    if (b == null) return '—';
    b = Number(b) || 0;
    if (b < 1024 * 1024)        return (b / 1024).toFixed(0) + ' KB';
    if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
    return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }
  function timeAgo(iso){
    try {
      var t = new Date(iso).getTime(); if (!t) return '';
      var s = Math.floor((Date.now() - t) / 1000);
      if (s < 60)    return 'just now';
      if (s < 3600)  return Math.floor(s / 60) + 'm ago';
      if (s < 86400) return Math.floor(s / 3600) + 'h ago';
      return Math.floor(s / 86400) + 'd ago';
    } catch(e){ return ''; }
  }
  function usageCell(u){
    if (!u) return '<span style="color:var(--muted);font-style:italic;">not reported</span>';
    return '<div style="font-variant-numeric:tabular-nums;line-height:1.35;">'
      + '<div>' + esc(fmtBytes(u.database_bytes)) + ' <span style="color:var(--muted);">db</span></div>'
      + '<div>' + esc(fmtBytes(u.storage_bytes)) + ' <span style="color:var(--muted);">files</span></div>'
      + '<div style="font-size:10px;color:var(--muted);">' + esc(timeAgo(u.reported_at)) + '</div>'
      + '</div>';
  }
  // Supabase cost model (per the user's plan / published pricing).
  var SUPA_COST = { computeMonthly: 10, dbIncludedGB: 8, storageIncludedGB: 100, dbOverPerGB: 0.125, storageOverPerGB: 0.0213, proOrgMonthly: 25 };
  // Estimated monthly Supabase cost for a nation. A nation counts the $10 Micro
  // compute base only once it has a live project (supabase_url set) -- a bare
  // "provisioning" registry row with no project is $0. Overage from reported usage.
  function estCost(n, u){
    var live = !!(n && n.supabase_url);
    var base = live ? SUPA_COST.computeMonthly : 0;
    var over = 0;
    if (u){
      var dbGB = (Number(u.database_bytes) || 0) / 1073741824;
      var stGB = (Number(u.storage_bytes)  || 0) / 1073741824;
      over += Math.max(0, dbGB - SUPA_COST.dbIncludedGB) * SUPA_COST.dbOverPerGB;
      over += Math.max(0, stGB - SUPA_COST.storageIncludedGB) * SUPA_COST.storageOverPerGB;
    }
    over = Math.round(over * 100) / 100;
    return { live: live, base: base, over: over, total: Math.round((base + over) * 100) / 100 };
  }

  function nationsCard(nations, usageBySub){
    usageBySub = usageBySub || {};
    var totLive = 0, totBase = 0, totOver = 0;
    var rows = nations.length ? nations.map(function(n){
      var st = n.status || 'provisioning';
      var mods = Object.keys(n.modules_licensed || {}).filter(function(k){ return n.modules_licensed[k]; });
      var u = usageBySub[n.subdomain];
      var c = estCost(n, u);
      if (c.live) totLive++;
      totBase += c.base; totOver += c.over;
      var costLine = '<div style="font-size:11px;margin-top:4px;padding-top:4px;border-top:1px dotted var(--line);' + (c.live ? '' : 'color:var(--muted);') + '">'
        + (c.live
            ? '<b>' + _money(c.total) + '</b>/mo <span style="color:var(--muted);">' + (c.over > 0 ? '($10 + ' + _money(c.over) + ' over)' : '(compute)') + '</span>'
            : 'no project &middot; $0')
        + '</div>';
      return '<tr>'
        + '<td><b>' + esc(n.display_name) + '</b><div style="font-size:11px;color:var(--muted);">' + esc(n.subdomain) + '.fnhub.app</div></td>'
        + '<td><span class="pill ' + esc(st) + '">' + esc(st) + '</span></td>'
        + '<td style="font-size:11px;color:var(--muted);">' + esc(mods.join(', ') || '—') + '</td>'
        + '<td style="font-size:12px;">' + usageCell(u) + costLine + '</td>'
        // One action per row — Open / Enter / Suspend moved into the nation's
        // information card (Dashboard -> Overview tab) to declutter the list.
        + '<td><div class="row-actions">'
        +   '<button class="btn sm ghost" type="button" data-act="configure" data-id="' + esc(n.id) + '">Dashboard</button>'
        + '</div></td></tr>';
    }).join('') : '<tr><td colspan="5" class="empty">No nations yet. Add one below.</td></tr>';
    var grand = Math.round((totBase + totOver) * 100) / 100;
    var summary = nations.length
      ? '<div style="display:flex;flex-wrap:wrap;gap:8px 18px;align-items:baseline;margin-top:14px;padding-top:12px;border-top:1px solid var(--line);">'
        +   '<div style="font-size:16px;font-weight:800;">Est. Supabase cost: ' + _money(grand) + '/mo</div>'
        +   '<div style="font-size:12px;color:var(--muted);">' + totLive + ' live project' + (totLive === 1 ? '' : 's') + ' &times; $10 compute = ' + _money(totBase) + (totOver > 0 ? ' + ' + _money(totOver) + ' overage' : '') + '</div>'
        + '</div>'
        + '<p class="sub" style="margin:6px 0 0;font-size:11px;">Per-project Micro compute is $10/mo; overage is $0.125/GB over 8 GB database and $0.0213/GB over 100 GB storage. A nation counts $10 only once it has a live Supabase project (a provisioning-only registry row is $0). <b>Excludes</b> the $25/mo Supabase Pro org base (which includes some compute credit), plus MAU and egress &mdash; see Supabase billing for the exact invoice. Usage is reported by each nation\'s app when a manager opens Settings &rarr; Nation.</p>'
      : '';
    return '<div class="card"><h3>Registered nations</h3>'
      + '<table><thead><tr><th>Nation</th><th>Status</th><th>Licensed modules</th><th>Usage &amp; est. cost</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>'
      + summary
      + '</div>';
  }

  // Sequential, numbered reference of the full "add a nation" workflow across
  // all three surfaces (Supabase, GitHub, Cloudflare). Static guide (no per-
  // nation step tracking). Each step is tagged Automated (the platform already
  // does it) or Manual (an external cloud action the operator performs).
  function stepTag(kind){
    return kind === 'auto'
      ? '<span class="pill" style="font-size:9px;background:#dcfce7;color:#166534;">Automated</span>'
      : '<span class="pill" style="font-size:9px;background:#f4f4f0;color:#696960;">Manual</span>';
  }
  // Collapsible reference card (native <details>): title + one-line subtitle
  // always visible; the body expands on click. Keeps the Provision tab short.
  function foldCard(title, sub, bodyHtml){
    return '<details class="card" style="margin-top:12px;">'
      + '<summary style="cursor:pointer;list-style:none;display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;">'
      +   '<h3 style="margin:0;display:inline;">' + title + '</h3>'
      +   '<span style="font-size:11px;color:var(--muted);">' + sub + ' &middot; <u>show / hide</u></span>'
      + '</summary>'
      + '<div style="margin-top:10px;">' + bodyHtml + '</div>'
      + '</details>';
  }

  function addNationStepsCard(){
    // [ title, kind('auto'|'manual'), html ]
    var steps = [
      ['Register the nation', 'manual',
        'Fill in the <b>Add a nation</b> card below (subdomain, display name, short code). Creates the registry row and reserves <code>&lt;subdomain&gt;.fnhub.app</code>.'],
      ['Create its Supabase project', 'manual',
        'Stand up a fresh <b>database-per-nation</b> project: ' + extLink(LINKS.supaNew, 'Supabase &rarr; New project') + '. Then grab the ref, URL, anon + service_role keys from ' + extLink(LINKS.supaApi, 'Settings &rarr; API') + '.'],
      ['Provision (schema, bucket, first ED)', 'auto',
        'Click <b>Provision this nation</b> below. The platform replays the bootstrap schema, creates the <code>housing-files</code> storage bucket, seeds the first ED, and writes the registry row &mdash; one action. (Requires <code>SB_MGMT_TOKEN</code> set on the platform function.) The service_role key is used once and never stored.'],
      ['Set the AI Assistant key (from this panel)', 'auto',
        'Open the nation\'s <b>Dashboard &rarr; Config &rarr; AI Assistant key</b> and paste the Anthropic key &mdash; the panel writes it onto the nation project for you (no Supabase dashboard visit). Also run the <code>hs_data_usage</code> migration on the project (the <b>Migrations</b> tab can push it fleet-wide) so this panel\'s usage column fills in.'],
      ['Set up email notifications (from this panel)', 'auto',
        'Open the nation\'s <b>Dashboard &rarr; Email Config</b>: pick the provider, fill the From identity + reply-to, <b>Save changes</b>, then click <b>Apply to project</b> (with the provider API key) &mdash; the panel writes the <code>EMAIL_*</code> secrets onto the nation project. The provider-side setup (Entra app for Graph, domain verification for Resend) is manual &mdash; <b>see the &ldquo;Email delivery setup&rdquo; guide below</b>.'],
      ['Deploy the Edge Functions to the project', 'manual',
        'In ' + extLink(LINKS.gh, 'GitHub Actions') + ' run the <b>&ldquo;Deploy Supabase Edge Functions&rdquo;</b> workflow with the nation\'s <b>project ref</b> in the <code>project_ref</code> input (copy the ref from <b>Dashboard &rarr; Config</b>). Pushes to <code>main</code> auto-deploy only to the <code>SUPABASE_PROJECT_ID</code> repo-secret project, so other nations need this manual run per functions change. CLI alternative: <code>supabase functions deploy --project-ref &lt;ref&gt;</code> (' + extLink(LINKS.supaCli, 'docs') + '). Control-plane-only functions (<code>provision-nation</code>, <code>report-nation-usage</code>) are excluded by design.'],
      ['Point the subdomain at the app (Cloudflare)', 'manual',
        'The app itself deploys once and serves <b>every</b> nation by hostname &mdash; but <code>&lt;subdomain&gt;.fnhub.app</code> won\'t resolve until you attach it. In the ' + extLink(LINKS.cf, 'Cloudflare dashboard') + ': <b>Workers &amp; Pages &rarr; clfn-housing-app &rarr; Settings &rarr; Domains &amp; Routes &rarr; Add &rarr; Custom Domain</b>, enter <code>&lt;subdomain&gt;.fnhub.app</code>. Cloudflare creates the DNS record + TLS cert (~1-2 min). <b>Skip this per-nation step</b> by setting up a wildcard once: a proxied <code>*.fnhub.app</code> DNS record + a <code>*.fnhub.app/*</code> Worker route (plan permitting) &mdash; then new subdomains resolve automatically.'],
      ['Set the auth sign-in policy (so staff can log in)', 'manual',
        'In the nation project\'s <b>Authentication &rarr; Sign In / Providers &rarr; Email</b>: keep <b>&ldquo;Allow new users to sign up&rdquo; ON</b> (the in-app Add-Staff flow creates logins via <code>signup</code>), and turn <b>&ldquo;Confirm email&rdquo; OFF</b> unless you have configured custom SMTP on the project. '
        + 'Supabase\'s built-in email is rate-limited and often does not deliver, so with Confirm-email <b>ON but no SMTP</b> a new staff member never receives the verification email and <b>cannot log in</b>. With it <b>OFF</b>, the account is active immediately and the Add-Staff success box shows the <b>default password</b> to share (<code>SHORT + FirstName + 2026!</code>). '
        + '(Auth <i>redirect URLs</i> are already set automatically during provisioning; this is a separate setting.)'],
      ['License the modules', 'manual',
        'Open the nation\'s <b>Dashboard &rarr; Overview</b> and tick which optional modules this nation may use (Finance, RFQ, Inspections, Capital Projects, …).'],
      ['Set status to Active', 'manual',
        'Only <b>active</b> nations publish to <code>nations_public</code> and resolve at <code>&lt;subdomain&gt;.fnhub.app</code>. Flip status to Active in the nation\'s <b>Dashboard &rarr; Overview</b> (Status card &mdash; Suspend/Resume live there too).'],
      ['Hand off to the nation\'s ED', 'manual',
        'The ED signs in at <code>&lt;subdomain&gt;.fnhub.app</code> and adds their own staff. Done &mdash; the nation manages itself from here.']
    ];
    var items = steps.map(function(s, i){
      return '<li style="display:flex;gap:12px;padding:11px 0;border-bottom:1px solid var(--line);align-items:flex-start;">'
        + '<span style="flex:0 0 auto;width:26px;height:26px;border-radius:50%;background:var(--accent);color:var(--ink);font-weight:800;font-size:13px;display:flex;align-items:center;justify-content:center;">' + (i + 1) + '</span>'
        + '<div style="flex:1;"><div style="font-weight:700;font-size:13px;margin-bottom:3px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">' + s[0] + ' ' + stepTag(s[1]) + '</div>'
        + '<div style="font-size:12px;color:var(--muted);line-height:1.55;">' + s[2] + '</div></div>'
        + '</li>';
    }).join('');
    // Body only — the Provision tab wraps this in a collapsible foldCard.
    return '<p class="sub" style="margin:2px 0 6px;"><span class="pill" style="font-size:9px;background:#dcfce7;color:#166534;">Automated</span> steps the platform already handles; <span class="pill" style="font-size:9px;background:#f4f4f0;color:#696960;">Manual</span> steps you do in Supabase, GitHub, or Cloudflare. Links open each destination.</p>'
      + '<ol style="list-style:none;margin:4px 0 0;padding:0;">' + items + '</ol>';
  }

  // Detailed, provider-by-provider email setup reference (Microsoft 365 / Graph
  // and Resend). Static guide -- links open each destination. The secret names
  // mirror supabase/functions/send-notification/index.ts exactly.
  function emailSetupCard(){
    function numList(items){
      return '<ol style="margin:8px 0 0;padding-left:20px;font-size:12px;color:var(--muted);line-height:1.6;">'
        + items.map(function(t){ return '<li style="margin-bottom:5px;">' + t + '</li>'; }).join('')
        + '</ol>';
    }
    // One provider block: heading + EMAIL_PROVIDER value + numbered steps + secrets line.
    function providerBlock(title, providerVal, blurb, steps, secretsLabel, secrets){
      return '<div style="border:1px solid var(--line);border-radius:9px;padding:12px 14px;margin-top:12px;">'
        + '<div style="font-weight:800;font-size:13px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">' + title
        +   ' <code style="background:#f4f4f0;padding:1px 6px;border-radius:5px;">EMAIL_PROVIDER=' + providerVal + '</code></div>'
        + (blurb ? '<div style="font-size:12px;color:var(--muted);margin-top:4px;">' + blurb + '</div>' : '')
        + numList(steps)
        + '<div style="font-size:12px;margin-top:8px;padding-top:8px;border-top:1px dashed var(--line);"><b>' + secretsLabel + ':</b> ' + secrets + '</div>'
        + '</div>';
    }
    var graph = providerBlock(
      'Microsoft 365 (Graph)', 'graph',
      'For a nation that has Microsoft 365. Mail sends <b>from a real mailbox</b>, so it authenticates as internal M365 and is not phishing-flagged &mdash; best deliverability.',
      [
        'In the ' + extLink(LINKS.azure, 'Azure / Entra portal') + ' &rarr; <b>App registrations</b> &rarr; <b>New registration</b>. Name it e.g. &ldquo;&lt;Nation&gt; Housing &mdash; Notifications&rdquo;, single tenant. Create it.',
        '<b>API permissions</b> &rarr; <b>Add a permission</b> &rarr; <b>Microsoft Graph</b> &rarr; <b>Application permissions</b> &rarr; tick <code>Mail.Send</code> &rarr; Add. Then click <b>Grant admin consent</b> (a Global Admin must do this).',
        '<b>Certificates &amp; secrets</b> &rarr; <b>New client secret</b> &rarr; copy the secret <b>Value</b> immediately (not the Secret ID &mdash; the value is shown only once).',
        '<b>Overview</b> &rarr; copy the <b>Directory (tenant) ID</b> and <b>Application (client) ID</b>.',
        'Choose a licensed or shared mailbox to send <b>from</b> (e.g. <code>housing@yournation.ca</code>).',
        '<b>Hardening (recommended):</b> <code>Mail.Send</code> is tenant-wide by default &mdash; the app could send as any mailbox. Scope it to just the housing mailbox with an <b>Application Access Policy</b> (<code>New-ApplicationAccessPolicy</code> in Exchange Online PowerShell).'
      ],
      'Secrets to set',
      secretList(['GRAPH_TENANT_ID', 'GRAPH_CLIENT_ID', 'GRAPH_CLIENT_SECRET', 'GRAPH_FROM_USER (the send-from mailbox)'])
    );
    var resend = providerBlock(
      'Resend', 'resend',
      'For a nation <b>without</b> Microsoft 365. Sends from your own verified domain over an email service. The platform domain <code>fnhub.app</code> is already verified, so a nation can send from <code>&lt;nation&gt;@fnhub.app</code> with no new domain work.',
      [
        'At ' + extLink(LINKS.resend, 'Resend &rarr; Domains') + ' &rarr; <b>Add Domain</b>, enter the sending domain (e.g. <code>mail.yournation.ca</code>). Skip this if sending from the already-verified <code>fnhub.app</code>.',
        'Add the DNS records Resend shows (<b>SPF</b>, <b>DKIM</b>, and the return-path record) at your DNS host &mdash; on Cloudflare the <b>Auto configure</b> button adds them for you &mdash; then wait for <b>Verified</b>. Add a <code>_dmarc</code> TXT record too (Auto-configure does not).',
        '<b>API Keys</b> &rarr; <b>Create API Key</b> with sending access &rarr; copy it.',
        'Pick a FROM address <b>on the verified domain</b> and the nation\'s display name, then enter it all in the nation\'s <b>Dashboard &rarr; Email Config</b> and click <b>Apply to project</b> (paste the API key there) &mdash; the panel writes the secrets for you.'
      ],
      'Secrets it sets',
      secretList(['EMAIL_PROVIDER', 'RESEND_API_KEY', 'EMAIL_FROM (a from-address on the verified domain)', 'EMAIL_FROM_NAME (the nation\'s display name)', 'EMAIL_REPLY_TO'])
    );
    var shared = '<div style="margin-top:14px;padding:11px 13px;background:var(--accent-light);border:1px solid var(--hair);border-radius:9px;font-size:12px;line-height:1.6;">'
      + '<div style="font-weight:800;margin-bottom:4px;">For either provider</div>'
      + '<div>&bull; Day-to-day config lives in the nation\'s <b>Dashboard &rarr; Email Config</b> tab: provider + From identity + reply-to, saved to the registry (the app reads it at boot) and applied to the project\'s secrets with <b>Apply to project</b>. The Supabase dashboard is only needed for the <code>GRAPH_*</code> credentials.</div>'
      + '<div>&bull; <code>EMAIL_PROVIDER</code> defaults to <code>graph</code> if unset; the function only honours a provider whose keys are actually configured.</div>'
      + '<div>&bull; <b>SendGrid</b> is also supported (<code>EMAIL_PROVIDER=sendgrid</code>) with <code>SENDGRID_API_KEY</code> + <code>EMAIL_FROM</code> + <code>EMAIL_FROM_NAME</code> &mdash; same Apply-to-project flow.</div>'
      + '<div>&bull; New/changed secrets are picked up automatically within about a minute &mdash; no redeploy needed.</div>'
      + '<div>&bull; Verify it: the nation app\'s <b>Settings &rarr; Admin &rarr; Config &rarr; Email pipeline</b> shows the resolved provider + from-address (read-only) for that nation.</div>'
      + '</div>';
    // Body only — the Provision tab wraps this in a collapsible foldCard.
    return '<p class="sub" style="margin:2px 0 4px;">Each nation sends its own workflow email through the <code>send-notification</code> Edge Function on <b>that nation\'s Supabase project</b>. Pick <b>one</b> provider per nation. This guide covers the <b>provider-side</b> setup; the per-nation config + secrets are applied from the nation\'s <b>Dashboard &rarr; Email Config</b> tab.</p>'
      + graph + resend + shared;
  }
  // Render a set of secret names as inline code chips.
  function secretList(names){
    return names.map(function(n){
      var parts = n.split(' ('); var code = parts[0];
      var tail = parts.length > 1 ? ' <span style="color:var(--muted);">(' + parts[1] : '';
      return '<code>' + code + '</code>' + tail;
    }).join(', &nbsp;');
  }

  // Setup reference for the per-nation support-login ("Enter") feature. Static
  // guide -- never renders the actual secret VALUE (secrets stay in Supabase).
  function supportLoginSetupCard(){
    function numList(items){
      return '<ol style="margin:8px 0 0;padding-left:20px;font-size:12px;color:var(--muted);line-height:1.6;">'
        + items.map(function(t){ return '<li style="margin-bottom:5px;">' + t + '</li>'; }).join('')
        + '</ol>';
    }
    // Body only — the Provision tab wraps this in a collapsible foldCard.
    return '<p class="sub" style="margin:2px 0 6px;">The <b>Enter as Platform Support</b> button (in a nation\'s <b>Dashboard &rarr; Overview &rarr; Access</b> card) opens a signed-in <b>Platform Support</b> session on that nation\'s app for troubleshooting &mdash; full access, logged on both sides, refusable by the nation, and the nation\'s ED is emailed each time. Each nation has its <b>own signing key</b>: the private key stays on the control plane; the nation holds only its <b>public</b> key (useless if stolen), so there is <b>no shared secret</b>.</p>'
      + '<div style="border:1px solid var(--line);border-radius:9px;padding:12px 14px;margin-top:10px;">'
      +   '<div style="font-weight:800;font-size:13px;">Per-nation setup (once each)</div>'
      +   numList([
              'Open the nation in <b>Dashboard &rarr; Config</b> and click <b>Generate keypair</b> under &ldquo;Support login key.&rdquo; The private key is stored here; the public key is shown (and locked).',
              'Copy that <b>public key</b> into the nation project &rarr; ' + extLink(LINKS.supaFns, 'Settings &rarr; Edge Functions &rarr; Secrets') + ' as <code>SUPPORT_LOGIN_PUBKEY</code>.',
              'Deploy the functions (CI does this on push to <code>main</code>): <code>enter-nation</code> + <code>gen-support-key</code> to the platform project, and <code>support-login</code> to <b>each</b> nation project (deployed with <code>--no-verify-jwt</code>; the nation-functions workflow targets one project at a time via its <code>project_ref</code> input).',
              'Auth redirect URLs are set <b>automatically during provisioning</b> now (Site URL + <code>https://&lt;subdomain&gt;.fnhub.app/**</code>). For a nation provisioned <i>before</i> this, re-run provisioning once (Dashboard &rarr; Config &rarr; Re-run provisioning) or set them by hand in the nation project\'s Auth settings &mdash; otherwise the magic link redirects to <code>localhost</code>.',
              '(One-time, platform DB) run <code>supabase/platform/nation_support_keys.sql</code> in the platform SQL Editor so the keys have somewhere to live.'
            ])
      +   '<div style="font-size:12px;margin-top:8px;padding-top:8px;border-top:1px dashed var(--line);">No shared secret to manage. Only <code>SUPPORT_LOGIN_PUBKEY</code> (a <b>public</b> key) sits on the nation. Rotate anytime from the Config tab &mdash; it locks the old key until you re-copy the new public key.</div>'
      + '</div>'
      + '<div style="margin-top:12px;padding:11px 13px;background:var(--accent-light);border:1px solid var(--hair);border-radius:9px;font-size:12px;line-height:1.6;">'
      +   '<div style="font-weight:800;margin-bottom:4px;">Good to know</div>'
      +   '<div>&bull; <code>enter-nation</code> signs a 2-minute token with the nation\'s private key; the nation verifies it with its public key. A stolen public key can\'t forge a login, and there is no secret that, if leaked, exposes every nation.</div>'
      +   '<div>&bull; The nation\'s <b>ED is emailed</b> on every entry, via that nation\'s own email provider (skipped only if the nation hasn\'t set up email &mdash; the entry is still audited).</div>'
      +   '<div>&bull; A nation can <b>refuse</b> support login: their ED toggles <b>Settings &rarr; Admin &rarr; Config &rarr; Platform Support Access</b> off. Then Enter returns &ldquo;support login is turned off.&rdquo;</div>'
      +   '<div>&bull; Every entry is audited: <code>entered_nation</code> (control plane) + <code>support_session_started</code> (the nation\'s Audit Log). Access is a full super_user session that lapses the same day.</div>'
      + '</div>';
  }

  // Fleet migrations: apply one schema update to many nation projects at once
  // (via the run-nation-migration control-plane function). Avoids pasting a
  // migration into every nation's SQL editor by hand.
  function migrationsCard(nations){
    var provisioned = (nations || []).filter(function(n){ return n.supabase_url; });
    var checks = provisioned.map(function(n){
      var active = n.status === 'active';
      return '<label style="display:inline-flex;align-items:center;gap:6px;font-weight:600;margin:0 14px 6px 0;font-size:12px;">'
        + '<input type="checkbox" class="fm-nation" value="' + esc(n.subdomain) + '"' + (active ? ' checked' : '') + ' style="width:auto;"/> '
        + esc(n.subdomain) + (active ? '' : ' <span style="color:var(--muted);">(' + esc(n.status) + ')</span>') + '</label>';
    }).join('') || '<span class="sub">No provisioned nations yet.</span>';
    return '<div class="card"><h3>Fleet migrations</h3>'
      + '<p class="sub" style="margin:2px 0 8px;">Apply one schema update to many nation projects at once. Give a <b>migration filename</b> from <code>supabase/migrations/</code> (fetched from the repo) OR paste raw SQL. Migrations must be <b>idempotent</b> (<code>create ... if not exists</code>, add-column-if-not-exists) so a re-run is safe. Uses the Management API + <code>SB_MGMT_TOKEN</code>; every run is recorded so already-applied nations are skipped.</p>'
      + '<label>Migration filename (under supabase/migrations/)</label>'
      + '<input id="fm-file" placeholder="20260819_labels_module.sql"/>'
      + '<label style="margin-top:8px;">…or paste raw SQL (leave the filename blank)</label>'
      + '<textarea id="fm-sql" rows="5" placeholder="alter table public.housing_units add column if not exists ..." style="width:100%;font-family:ui-monospace,Menlo,monospace;font-size:12px;padding:8px;border:1px solid var(--line);border-radius:8px;resize:vertical;box-sizing:border-box;"></textarea>'
      + '<label style="margin-top:8px;">Label for pasted SQL (ledger name; optional)</label>'
      + '<input id="fm-label" placeholder="e.g. add_unit_flag_2026_08"/>'
      + '<div style="margin-top:10px;font-size:12px;font-weight:700;color:var(--muted);">Target nations</div>'
      + '<div style="margin:6px 0 10px;">' + checks + '</div>'
      + '<label style="display:inline-flex;align-items:center;gap:8px;font-weight:600;font-size:12px;"><input type="checkbox" id="fm-force" style="width:auto;"/> Force re-run where already applied</label>'
      + '<div class="msg" id="fm-msg"></div>'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px;">'
      +   '<button class="btn ghost" type="button" data-act="fleet-dry">Dry run (preview)</button>'
      +   '<button class="btn" type="button" data-act="fleet-apply">Apply to selected</button>'
      + '</div>'
      + '<div id="fm-results" style="margin-top:12px;"></div>'
      + '</div>';
  }
  function _fmSelectedTargets(){
    var out = [];
    Array.prototype.forEach.call(document.querySelectorAll('.fm-nation'), function(c){ if (c.checked) out.push(c.value); });
    return out;
  }
  window.runFleetMigration = async function(dryRun){
    var file  = ((document.getElementById('fm-file')  || {}).value || '').trim();
    // Be forgiving about pasted paths: the server accepts a bare filename only
    // (its safe-name check rejects slashes with bad_migration_name), but the
    // natural thing to paste is "supabase/migrations/<file>.sql" - strip any
    // leading path and reflect the cleaned value back into the field.
    if (file.indexOf('/') >= 0 || file.indexOf('\\') >= 0){
      file = file.split(/[\\/]/).pop();
      var _fEl = document.getElementById('fm-file'); if (_fEl) _fEl.value = file;
    }
    var sql   = ((document.getElementById('fm-sql')   || {}).value || '');
    var label = ((document.getElementById('fm-label') || {}).value || '').trim();
    var force = !!(document.getElementById('fm-force') || {}).checked;
    var targets = _fmSelectedTargets();
    if (!file && !sql.trim()){ setMsg('fm-msg', 'Enter a migration filename or paste SQL.'); return; }
    if (!targets.length){ setMsg('fm-msg', 'Select at least one target nation.'); return; }
    setMsg('fm-msg', dryRun ? 'Previewing...' : 'Applying...', 'ok');
    // Clear the previous run's results table so a failed attempt can't sit
    // above a stale success table (or vice versa) — message and table always
    // describe the SAME run.
    var _resEl = document.getElementById('fm-results'); if (_resEl) _resEl.innerHTML = '';
    var payload = { targets: targets, dryRun: !!dryRun, force: force };
    if (file) payload.migration = file; else { payload.sql = sql; if (label) payload.label = label; }
    var r;
    try {
      r = await fetch(PBASE + '/functions/v1/run-nation-migration', {
        method: 'POST', headers: { apikey: ANON, Authorization: 'Bearer ' + getAT(), 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } catch (e){ setMsg('fm-msg', 'Network error: ' + String(e).slice(0, 120)); return; }
    var d = await r.json().catch(function(){ return {}; });
    if (!r.ok){ setMsg('fm-msg', 'Failed: ' + (d.message || d.error || ('HTTP ' + r.status))); return; }
    setMsg('fm-msg', (dryRun ? 'Preview' : 'Done') + ' — ' + esc(d.migration) + ' (' + d.count + ' nation(s))', 'ok');
    var rows = (d.results || []).map(function(x){
      var color = x.status === 'applied' ? '#166534' : x.status === 'failed' ? 'var(--danger)' : x.status === 'would_run' ? '#1d4ed8' : 'var(--muted)';
      return '<tr><td><b>' + esc(x.subdomain) + '</b></td><td style="color:' + color + ';font-weight:700;">' + esc(x.status) + '</td>'
        + '<td style="font-size:12px;color:var(--muted);">' + esc(x.detail || '') + '</td></tr>';
    }).join('');
    document.getElementById('fm-results').innerHTML =
      '<table><thead><tr><th>Nation</th><th>Result</th><th>Detail</th></tr></thead><tbody>' + rows + '</tbody></table>';
  };

  function addNationCard(){
    var modChecks = MODULES.map(function(m){
      return '<label style="display:inline-flex;align-items:center;gap:6px;font-weight:600;margin:0 12px 6px 0;"><input type="checkbox" class="an-mod" value="' + m[0] + '" style="width:auto;" checked/> ' + m[1] + '</label>';
    }).join('');
    return '<div class="card"><h3>Add a nation (registry)</h3>'
      + '<p class="sub" style="margin:2px 0 4px;">Registers a nation so <code>&lt;subdomain&gt;.fnhub.app</code> resolves. Point it at that nation\'s Supabase project. (Full auto-provisioning arrives in a later phase.)</p>'
      + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">'
      +   '<div><label>Subdomain</label><input id="an-sub" placeholder="listuguj"/></div>'
      +   '<div><label>Short code</label><input id="an-short" placeholder="LMG"/></div>'
      + '</div>'
      + '<label>Display name</label><input id="an-name" placeholder="Listuguj Mi\'gmaq Government"/>'
      + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">'
      +   '<div><label>Supabase URL</label><input id="an-url" placeholder="https://xxxx.supabase.co"/></div>'
      +   '<div><label>Supabase anon key</label><input id="an-anon" placeholder="eyJ… (publishable)"/></div>'
      + '</div>'
      + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">'
      +   '<div><label>Staff email domain</label><input id="an-domain" placeholder="listuguj.ca"/></div>'
      +   '<div><label>Primary color</label><input id="an-color" placeholder="#f8e41a"/></div>'
      + '</div>'
      + '<label>Licensed modules</label><div style="margin-top:2px;">' + modChecks + '</div>'
      + '<div class="msg" id="an-msg"></div>'
      + '<button class="btn" id="an-btn" type="button">Add nation</button></div>';
  }

  function adminsCard(admins, meEmail){
    var rows = admins.map(function(a){
      var em = String(a.email||'');
      var isMe = em.toLowerCase() === meEmail;
      return '<tr><td>' + esc(em) + (isMe ? ' <span style="color:var(--muted);font-size:11px;">(you)</span>' : '') + '</td>'
        + '<td style="font-size:11px;color:var(--muted);">' + esc(a.added_by||'') + '</td>'
        + '<td>' + (isMe ? '' : '<button class="btn sm danger" data-act="rm-admin" data-email="' + esc(em) + '">Remove</button>') + '</td></tr>';
    }).join('');
    return '<div class="card"><h3>Platform administrators</h3>'
      + '<table><thead><tr><th>Email</th><th>Added by</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>'
      + '<div style="display:flex;gap:8px;margin-top:12px;align-items:flex-end;flex-wrap:wrap;">'
      +   '<div style="flex:1;min-width:200px;"><label>Add administrator</label><input id="adm-email" type="email" placeholder="name@example.com"/></div>'
      +   '<button class="btn sm" type="button" data-act="add-admin">Add</button>'
      + '</div><div class="msg" id="adm-msg"></div></div>';
  }

  // ---- Actions ---------------------------------------------------------------
  function wireAddNation(){
    var btn = document.getElementById('an-btn'); if (!btn) return;
    btn.addEventListener('click', async function(){
      var get = function(id){ return (document.getElementById(id)||{}).value || ''; };
      var sub = get('an-sub').trim().toLowerCase().replace(/[^a-z0-9-]/g,'');
      var name = get('an-name').trim(), short = get('an-short').trim();
      if (!sub || !name || !short){ setMsg('an-msg','Subdomain, display name, and short code are required.'); return; }
      var mods = {};
      Array.prototype.forEach.call(document.querySelectorAll('.an-mod'), function(c){ mods[c.value] = c.checked; });
      var row = {
        subdomain: sub, display_name: name, short: short,
        supabase_url: get('an-url').trim() || null, supabase_anon: get('an-anon').trim() || null,
        email_domain: get('an-domain').trim() || null, primary_color: get('an-color').trim() || null,
        modules_licensed: mods,
        status: (get('an-url').trim() ? 'active' : 'provisioning'),
        provisioned_by: jwtEmail()
      };
      btn.disabled = true; btn.textContent = 'Adding…';
      var r = await api('POST', '/nations', row, 'return=minimal');
      if (r.ok){ await audit('nation_added', sub, name); showDashboard(); }
      else { var t = await r.text(); setMsg('an-msg', /duplicate|unique/i.test(t) ? 'That subdomain is already registered.' : 'Could not add: ' + t); btn.disabled=false; btn.textContent='Add nation'; }
    });
  }

  window.adminSetStatus = async function(id, status){
    var r = await api('PATCH', '/nations?id=eq.' + encodeURIComponent(id), { status: status, updated_at: new Date().toISOString() }, 'return=minimal');
    if (r.ok){ await audit('nation_' + status, id, ''); showDashboard(); }
  };
  window.adminAdd = async function(){
    var em = ((document.getElementById('adm-email')||{}).value || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)){ setMsg('adm-msg','Enter a valid email.'); return; }
    var r = await api('POST', '/super_admins', { email: em, added_by: jwtEmail() }, 'return=minimal');
    if (r.ok){ await audit('admin_added', em, ''); showDashboard(); }
    else { var t = await r.text(); setMsg('adm-msg', /duplicate|unique/i.test(t) ? 'Already an administrator.' : 'Could not add: ' + t); }
  };
  window.adminRemove = async function(email){
    var r = await api('DELETE', '/super_admins?email=eq.' + encodeURIComponent(email), null, 'return=minimal');
    if (r.ok){ await audit('admin_removed', email, ''); showDashboard(); }
  };
  async function audit(action, target, detail){
    try { await api('POST', '/platform_audit', { actor: jwtEmail(), action: action, target: String(target||''), detail: String(detail||'') }, 'return=minimal'); } catch(e){}
  }

  window.adminLogout = function(){
    try { fetch(AUTH + '/logout', { method:'POST', headers:{ apikey:ANON, Authorization:'Bearer '+getAT() } }); } catch(e){}
    clearSession(); document.getElementById('btn_out').style.display = 'none'; showLogin();
  };

  // ---- Configure a nation (P3) -----------------------------------------------
  window.adminHome = function(){ showDashboard(); };

  window.configureNation = async function(id){
    var n = _nations.filter(function(x){ return String(x.id) === String(id); })[0];
    if (!n){
      var r = await api('GET', '/nations?select=*&id=eq.' + encodeURIComponent(id));
      var a = r.ok ? await r.json().catch(function(){return[];}) : [];
      n = a[0];
      // Cache it: _nations is cold on a deep link or after a reload, and
      // showProvision(id) reads this array to prefill. Without this the wizard
      // would open blank with an EDITABLE subdomain and could mint a duplicate
      // registry row instead of updating this one.
      if (n) _nations = _nations.filter(function(x){ return String(x.id) !== String(n.id); }).concat([n]);
    }
    if (!n){ showDashboard(); return; }
    document.getElementById('btn_out').style.display = '';
    app.innerHTML = configureView(n);
    renderNationDocsCard(n.subdomain);
    wireDocFileInput();
    wireLogoUpload();
    renderNationNotes(n.subdomain);
    renderNationInvoices(n.subdomain);
    window.invAddLine();          // seed one empty invoice line
    renderNationBilling(n.subdomain);
    renderSupportKey(n.subdomain);
    loadNicSummary(n.subdomain);
  };

  function configureView(n){
    var g2 = 'display:grid;grid-template-columns:1fr 1fr;gap:10px;';
    var mods = n.modules_licensed || {};
    var modChecks = MODULES.map(function(m){
      return '<label style="display:inline-flex;align-items:center;gap:6px;font-weight:600;margin:0 12px 8px 0;">'
        + '<input type="checkbox" class="cn-mod" value="' + m[0] + '" style="width:auto;"' + (mods[m[0]] ? ' checked' : '') + '/> ' + esc(m[1]) + '</label>';
    }).join('');
    var stOpt = function(v,l){ return '<option value="' + v + '"' + (String(n.status||'provisioning') === v ? ' selected' : '') + '>' + l + '</option>'; };
    var tab = function(k, l, active){ return '<button class="nic-tab' + (active ? ' active' : '') + '" type="button" data-act="nic-tab" data-tab="' + k + '">' + l + '</button>'; };
    var panel = function(k, html, active){ return '<div class="nic-panel' + (active ? ' active' : '') + '" data-panel="' + k + '">' + html + '</div>'; };
    var modCount = Object.keys(n.modules_licensed || {}).filter(function(k){ return n.modules_licensed[k]; }).length;

    // Panel content (existing card markup, regrouped under tabs).
    // Access + status actions live here (moved off the nations-list rows,
    // which now carry only the Dashboard button).
    var nUrl = 'https://' + esc(n.subdomain) + '.fnhub.app';
    var pOverview =
        '<div class="card"><h3>Access</h3>'
      +   '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">'
      +     '<a class="btn sm ghost" href="' + nUrl + '" target="_blank" rel="noopener">Open ' + esc(n.subdomain) + '.fnhub.app &rarr;</a>'
      +     (n.supabase_url ? '<button class="btn sm ghost" type="button" data-act="enter" data-id="' + esc(n.id) + '" title="Sign in to this nation as Platform Support (logged both sides; the nation\'s ED is emailed)">Enter as Platform Support</button>' : '')
      +   '</div>'
      +   '<p class="sub" style="margin:6px 0 0;font-size:11px;">Enter opens a signed-in support session on the nation\'s app &mdash; full access, audited on both sides, and the nation\'s ED is notified each time.</p>'
      + '</div>'
      + '<div class="card"><h3>Branding &amp; contact</h3>'
      +   '<div style="' + g2 + '">'
      +     '<div><label>Display name</label><input id="cn-name" value="' + esc(n.display_name) + '"/></div>'
      +     '<div><label>Short code</label><input id="cn-short" value="' + esc(n.short) + '"/></div>'
      +   '</div>'
      +   '<div style="' + g2 + '">'
      +     '<div><label>Primary color</label><input id="cn-color" placeholder="#f8e41a" value="' + esc(n.primary_color || '') + '"/></div>'
      +     '<div><label>Staff email domain</label><input id="cn-domain" placeholder="nation.ca" value="' + esc(n.email_domain || '') + '"/></div>'
      +   '</div>'
      +   '<label>Housing email</label><input id="cn-housing" placeholder="housing@nation.ca" value="' + esc(n.housing_email || '') + '"/>'
      +   '<label>Logo</label>'
      +   '<div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;">'
      +     '<div id="cn-logo-preview" style="width:56px;height:56px;border-radius:10px;border:1px solid var(--hair);background-color:var(--bg);background-position:center;background-size:contain;background-repeat:no-repeat;flex:0 0 auto;"></div>'
      +     '<div style="flex:1;min-width:180px;"><input id="cn-logo-file" type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp"/>'
      +       '<div class="sub" style="font-size:11px;margin-top:2px;">Square PNG/JPG/SVG. Applied to the nation\'s header, login, favicon and PDFs. Keep it small (a few hundred KB max).</div></div>'
      +     '<button class="btn sm ghost" type="button" data-act="logo-clear">Remove</button>'
      +   '</div>'
      +   '<input id="cn-logo" type="hidden" value="' + esc(n.logo || '') + '"/>'
      + '</div>'
      + '<div class="card"><h3>Licensed modules</h3>'
      +   '<p class="sub" style="margin:2px 0 8px;">Which optional modules this nation is allowed to use. The nation still turns each one on or off in its own in-app settings.</p>'
      +   '<div>' + modChecks + '</div>'
      + '</div>'
      + '<div class="card"><h3>Status</h3>'
      +   '<label>Registry status</label>'
      +   '<select id="cn-status">' + stOpt('provisioning','Provisioning') + stOpt('active','Active') + stOpt('suspended','Suspended') + '</select>'
      +   '<p class="sub" style="margin:6px 0 0;">Only <b>active</b> nations are published to <code>nations_public</code> and resolve at <code>&lt;subdomain&gt;.fnhub.app</code>.</p>'
      +   '<div style="margin-top:10px;">'
      +     (String(n.status||'') === 'suspended'
              ? '<button class="btn sm ghost" type="button" data-act="status" data-status="active" data-id="' + esc(n.id) + '">Resume this nation</button>'
              : '<button class="btn sm danger" type="button" data-act="status" data-status="suspended" data-id="' + esc(n.id) + '">Suspend this nation</button>')
      +   '</div>'
      + '</div>';

    var pSupabase =
        '<div class="card"><h3>Supabase project</h3>'
      +   '<p class="sub" style="margin:2px 0 8px;">The nation\'s own database-per-nation project. The anon key is publishable.</p>'
      +   '<label>Supabase URL</label><input id="cn-url" placeholder="https://xxxx.supabase.co" value="' + esc(n.supabase_url || '') + '"/>'
      +   '<label>Project ref</label>'
      +   '<div style="display:flex;gap:6px;align-items:center;">'
      +     '<input id="cn-ref-view" value="' + esc(_refFromUrl(n.supabase_url) || '') + '" readonly style="background:var(--bg);color:var(--muted);flex:1;" title="Derived from the Supabase URL (the code in https://<ref>.supabase.co). This is what the cost tracker, provisioning, and the function-deploy workflow input key off."/>'
      +     '<button class="btn sm ghost" type="button" data-act="copy-text" data-copy="' + esc(_refFromUrl(n.supabase_url) || '') + '">Copy</button>'
      +   '</div>'
      +   '<label>Supabase anon key</label><input id="cn-anon" placeholder="eyJ..." value="' + esc(n.supabase_anon || '') + '"/>'
      +   '<label>Credentials stored in (reference only — never the secret)</label><input id="cn-cred" placeholder="e.g. 1Password › Supabase › ' + esc(n.subdomain) + '" value="' + esc(n.credentials_note || '') + '"/>'
      +   '<p class="sub" style="margin:4px 0 0;font-size:11px;">Points to where this project\'s <b>database password</b> and <b>service-role key</b> live (a password manager). <b>Do not paste secrets here</b> — this panel is not a secret store; any value saved is readable by a signed-in admin\'s browser.</p>'
      + '</div>'
      + '<div class="card"><h3>Provisioning</h3>'
      +   '<p class="sub" style="margin:2px 0 8px;">'
      +     (n.supabase_url
              ? 'This nation already points at a Supabase project. Re-running provisioning replays the bootstrap schema and re-seeds the bucket and first ED against that project.'
              : 'This nation is registered but has no Supabase project yet. Create the project first, then run the wizard to apply the bootstrap schema, create the storage bucket, and seed the first ED.')
      +   '</p>'
      +   '<button class="btn sm ghost" type="button" data-act="provision" data-id="' + esc(n.id) + '">'
      +     (n.supabase_url ? 'Re-run provisioning &rarr;' : 'Provision this nation &rarr;') + '</button>'
      + '</div>'
      + '<div class="card"><h3>AI Assistant key</h3>'
      +   '<p class="sub" style="margin:2px 0 8px;">Sets this nation\'s <b>Anthropic API key</b> directly on its Supabase project (the <code>ANTHROPIC_API_KEY</code> Edge Function secret the <code>ai-chat</code> function reads). The key is written to the project and is <b>never stored here</b> &mdash; only a masked marker is kept.</p>'
      +   '<div style="font-size:12px;margin-bottom:8px;">'
      +     (n.ai_key_last4
              ? 'Current: <b>set</b> &middot; ...' + esc(n.ai_key_last4) + (n.ai_key_updated_at ? ' &middot; updated ' + esc(timeAgo(n.ai_key_updated_at)) : '')
              : '<span style="color:var(--muted);">No key set for this nation yet.</span>')
      +   '</div>'
      +   '<label>Anthropic API key</label><input id="cn-ai-key" type="password" autocomplete="off" placeholder="sk-ant-..." value=""/>'
      +   '<p class="sub" style="margin:4px 0 0;font-size:11px;">Requires the nation to have a Supabase project, and the <code>ai-chat</code> function deployed to it (see the provisioning checklist). Leave blank and Save does nothing.</p>'
      +   '<div class="msg" id="cn-ai-msg"></div>'
      +   '<button class="btn sm" type="button" data-act="ai-key-save" data-sub="' + esc(n.subdomain) + '">Save &amp; apply to project</button>'
      + '</div>'
      + '<div class="card"><h3>Support login key</h3>'
      +   '<p class="sub" style="margin:2px 0 8px;">Per-nation signing key for the <b>Enter</b> (support login) feature. The <b>private</b> key stays here on the control plane; you copy the <b>public</b> key into this nation\'s <code>SUPPORT_LOGIN_PUBKEY</code> Edge Function secret. A stolen public key cannot forge a login. Once generated the key is <b>locked</b> &mdash; rotating it invalidates the nation\'s current public key until you re-copy it.</p>'
      +   '<div id="cn-supportkey"><div class="empty">Loading key status...</div></div>'
      + '</div>';

    // Per-nation email delivery config -> nations.email jsonb, published via
    // nations_public and consumed by the nation app at boot (NATION_CONFIG.
    // email_config -> sendNotification passes provider/from per message). NO
    // SECRETS here: API keys live in the nation project's Edge Function
    // secrets, and send-notification only honours a provider whose keys are
    // actually configured server-side.
    var nEmail = (n.email && typeof n.email === 'object') ? n.email : {};
    var provOpt = function(v,l){ return '<option value="' + v + '"' + (String(nEmail.provider||'graph') === v ? ' selected' : '') + '>' + l + '</option>'; };
    var pEmail =
        '<div class="card"><h3>Email delivery</h3>'
      +   '<p class="sub" style="margin:2px 0 8px;">How this nation\'s workflow email goes out (application confirmations, work orders, RFQ letters, magic links). This picks the <b>provider and From identity</b> the app requests per message. The matching <b>API keys must be set on the nation\'s own Supabase project</b> (Settings &rarr; Edge Functions &rarr; Secrets: <code>EMAIL_PROVIDER</code>, <code>RESEND_API_KEY</code>/<code>SENDGRID_API_KEY</code> or the <code>GRAPH_*</code> set) &mdash; the function ignores a requested provider whose keys are missing. See the <b>Provision &rarr; Email delivery setup</b> card for the walkthroughs.</p>'
      +   '<label>Provider</label>'
      +   '<select id="cn-em-provider">' + provOpt('graph','Microsoft 365 (Graph) — sends from the nation mailbox') + provOpt('resend','Resend — sends from a verified domain') + provOpt('sendgrid','SendGrid — sends from a verified domain') + '</select>'
      +   '<div style="' + g2 + '">'
      +     '<div><label>From address</label><input id="cn-em-from" placeholder="demo@fnhub.app" value="' + esc(nEmail.from || '') + '"/></div>'
      +     '<div><label>From name</label><input id="cn-em-from-name" placeholder="FN Hub Demo Housing" value="' + esc(nEmail.from_name || '') + '"/></div>'
      +   '</div>'
      +   '<label>Reply-to (a monitored mailbox)</label><input id="cn-em-reply" placeholder="housing@nation.ca" value="' + esc(nEmail.reply_to || '') + '"/>'
      +   '<p class="sub" style="margin:6px 0 0;font-size:11px;">Resend/SendGrid: the From address must be on a domain verified with that provider (SPF + DKIM), or mail lands in spam. Graph ignores From here &mdash; it sends from the mailbox in the nation project\'s <code>GRAPH_FROM_USER</code> secret. Saved with the <b>Save changes</b> button below; takes effect on the nation\'s next page load.</p>'
      + '</div>'
      + '<div class="card"><h3>Apply to project</h3>'
      +   '<p class="sub" style="margin:2px 0 8px;">Writes the matching <b>Edge Function secrets</b> straight onto this nation\'s Supabase project via the Management API (like the AI Assistant key) &mdash; no dashboard visit. Sets <code>EMAIL_PROVIDER</code> + the filled-in <code>EMAIL_FROM</code>/<code>EMAIL_FROM_NAME</code>/<code>EMAIL_REPLY_TO</code> from the fields above, plus the provider API key below. Values are written to the project and <b>never stored here</b>.</p>'
      +   '<label>Provider API key (Resend/SendGrid)</label><input id="cn-em-key" type="password" autocomplete="off" placeholder="re_... / SG...."/>'
      +   '<p class="sub" style="margin:4px 0 0;font-size:11px;">Leave the key blank to re-apply only the non-secret values (an already-set key on the project is kept). For <b>Graph</b>, this button sets <code>EMAIL_PROVIDER=graph</code> only &mdash; the <code>GRAPH_*</code> credentials belong to the nation\'s own Microsoft tenant and are set in the Supabase dashboard by hand. Functions pick up new secrets within about a minute.</p>'
      +   '<div class="msg" id="cn-em-msg"></div>'
      +   '<button class="btn sm" type="button" data-act="email-apply" data-sub="' + esc(n.subdomain) + '">Apply to project</button>'
      +   '<p class="sub" style="margin:10px 0 0;font-size:11px;"><b>Verify it end-to-end:</b> use <b>Overview &rarr; Enter as Platform Support</b>, then on the nation\'s app go to <b>Settings &rarr; Notifications &rarr; &ldquo;Send test email&rdquo;</b> &mdash; one click sends a branded test to your address through the nation\'s real pipeline, and failures show the server\'s actual error. (The nation project must have the current Edge Functions deployed.)</p>'
      + '</div>';

    // Email Intake (forward-to-file) per-nation setup checklist. Read-only doc.
    var iaAddr = esc(n.subdomain) + '@fnhub.app';
    var pEmailIntake =
        '<div class="card"><h3>Email Intake &mdash; setup</h3>'
      +   '<p class="sub" style="margin:2px 0 10px;">Staff forward an email to a nation address; it lands in the app under <b>Operations &rarr; Email Intake</b>, where they file it to a unit/tenant (attachments + body go to the unit&rsquo;s documents). One shared Cloudflare Email Worker (<code>housing-email-intake</code>) routes <code>&lt;nation&gt;@fnhub.app</code> to each nation&rsquo;s database via the platform registry. Do these once per nation:</p>'
      +   '<ol style="margin:0;padding-left:18px;font-size:13px;line-height:1.7;">'
      +     '<li><b>Table</b> &mdash; run the <code>email_intake</code> migration (Fleet migration page). Fleet-wide, so usually already done.</li>'
      +     '<li><b>Edge function</b> &mdash; <code>email-intake</code> deploys to every nation via CI (with <code>--no-verify-jwt</code>). No action needed.</li>'
      +     '<li><b>Secret</b> &mdash; on <b>this nation&rsquo;s Supabase project</b> (Settings &rarr; Edge Functions &rarr; Secrets) set <code>EMAIL_INTAKE_SECRET</code> to the <b>same shared value</b> configured on the Cloudflare worker.</li>'
      +     '<li><b>Cloudflare routing</b> &mdash; Cloudflare &rarr; <b>fnhub.app</b> &rarr; Email &rarr; Email Routing &rarr; Routing rules &rarr; add pattern <code>' + esc(n.subdomain) + '</code> &rarr; action <b>Send to a Worker</b> &rarr; <code>housing-email-intake</code>. Staff then forward to <code>' + iaAddr + '</code>.</li>'
      +     '<li><b>App address</b> &mdash; in the nation app, <b>Settings &rarr; Nation &rarr; Email Intake Address</b> = <code>' + iaAddr + '</code> (this is the default).</li>'
      +     '<li><b>Test</b> &mdash; forward an email to <code>' + iaAddr + '</code>, then check <b>Operations &rarr; Email Intake</b>.</li>'
      +   '</ol>'
      +   '<p class="sub" style="margin:10px 0 0;font-size:11px;"><b>Sender gate:</b> only emails whose sender is an <b>active staff member of this nation</b> create a row &mdash; anything else is dropped (the address is public). Staff forward from their own work address. <b>Do NOT</b> enable Cloudflare Email Routing on the nation&rsquo;s own mail domain (e.g. a Microsoft 365 domain) &mdash; it hijacks the MX and breaks that mail. Use <code>' + iaAddr + '</code>, or have the mail admin auto-forward a friendly address to it. The <code>EMAIL_INTAKE_SECRET</code> must match exactly on the Cloudflare worker and on every nation&rsquo;s Supabase project.</p>'
      + '</div>';

    var pNotes =
        '<div class="card"><h3>Notes</h3>'
      +   '<p class="sub" style="margin:2px 0 8px;">Internal log for this nation (calls, decisions, follow-ups). Visible to platform admins only.</p>'
      +   '<div id="cn-notes"><div class="empty">Loading notes...</div></div>'
      +   '<div style="margin-top:10px;"><textarea id="cn-note-body" rows="2" placeholder="Add a note..." style="width:100%;padding:10px 12px;border:1px solid var(--hair);border-radius:9px;font-size:14px;font-family:inherit;resize:vertical;"></textarea></div>'
      +   '<div class="msg" id="cn-note-msg"></div>'
      +   '<button class="btn sm" type="button" data-act="note-add" data-sub="' + esc(n.subdomain) + '">Add note</button>'
      + '</div>';

    var pBilling =
        '<div class="card"><h3>Recurring billing</h3>'
      +   '<p class="sub" style="margin:2px 0 8px;">Automated subscription invoicing. On each due date the scheduler generates an invoice from this schedule, advances the next date, and (when Auto-send is on) emails the nation. Generated invoices land in the Invoices tab and count toward Outstanding. Set up the daily scheduler once &mdash; see <code>docs/RECURRING-INVOICING.md</code>.</p>'
      +   '<div id="cn-billing"><div class="empty">Loading schedule...</div></div>'
      + '</div>';

    var pInvoices =
        '<div class="card"><h3>Invoices</h3>'
      +   '<p class="sub" style="margin:2px 0 8px;">Subscription, setup and add-on billing for this nation. Creating an invoice generates a PDF and files it in Documents.</p>'
      +   '<div id="cn-invoices"><div class="empty">Loading invoices...</div></div>'
      +   '<div style="margin-top:14px;border-top:1px solid var(--line);padding-top:12px;">'
      +     '<div style="font-weight:700;font-size:13px;margin-bottom:8px;">New invoice</div>'
      +     '<div id="cn-inv-carry" style="display:none;background:var(--accent-light);border:1px solid #fde68a;border-radius:9px;padding:9px 11px;margin-bottom:10px;"></div>'
      +     '<div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;margin-bottom:4px;">'
      +       '<div style="width:150px;"><label>Residential homes</label><input id="cn-inv-homes" type="number" min="1" step="1" placeholder="e.g. 140"/></div>'
      +       '<button class="btn sm ghost" type="button" data-act="inv-find-band">Find band</button>'
      +     '</div>'
      +     '<div class="msg" id="cn-inv-band"></div>'
      +     '<div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;margin-bottom:8px;">'
      +       '<div style="flex:1;min-width:230px;"><label>Fee schedule</label>' + _feeScheduleSelectHtml() + '</div>'
      +       '<button class="btn sm" type="button" data-act="inv-add-catalog">Add selected &darr;</button>'
      +     '</div>'
      +     '<p class="sub" style="margin:0 0 8px;font-size:11px;">Pick a fee-schedule item and Add, or use &ldquo;+ Add line&rdquo; for a free-form line. Count <b>residential</b> homes only for the band (band offices, community buildings and commercial space don&rsquo;t count). <b>Legacy</b> lines are only for a nation still inside a term signed before 2026-10-09 &mdash; never for a new signing or renewal. For hourly items, enter the number of hours in <b>Qty</b> (0.25 precision); for custom / at-cost items, fill in the amount.</p>'
      +     '<div id="cn-inv-lines"></div>'
      +     '<button class="btn sm ghost" type="button" data-act="inv-add-line" style="margin-top:2px;">+ Add blank line</button>'
      +     '<div style="' + g2 + 'margin-top:12px;">'
      +       '<div><label>Tax rate (%)</label><input id="cn-inv-tax" type="number" step="0.01" min="0" placeholder="0" value="0"/></div>'
      +       '<div><label>Due date</label><input id="cn-inv-due" type="date" value="' + _dPlus(30) + '"/><div class="sub" style="font-size:11px;margin-top:2px;">Defaults to 30 days after today (net 30).</div></div>'
      +     '</div>'
      +     '<div style="display:grid;grid-template-columns:150px 110px 1fr;gap:10px;">'
      +       '<div><label>Discount</label><select id="cn-inv-disc-type"><option value="">None</option><option value="percent">Percent (%)</option><option value="fixed">Fixed ($)</option></select></div>'
      +       '<div><label>Value</label><input id="cn-inv-disc-value" type="number" step="0.01" min="0" placeholder="0"/></div>'
      +       '<div><label>Reason shown on invoice (optional)</label><input id="cn-inv-disc-label" placeholder="e.g. Multi-nation partnership discount"/></div>'
      +     '</div>'
      +     '<p class="sub" style="margin:2px 0 8px;font-size:11px;">The discount is taken off the subtotal <b>before tax</b> and prints as its own line on the PDF.</p>'
      +     '<label>Invoice notes (optional)</label><input id="cn-inv-notes" placeholder="Payable within 30 days; e-transfer to..."/>'
      +     '<div class="msg" id="cn-inv-msg"></div>'
      +     '<button class="btn" type="button" data-act="inv-create" data-sub="' + esc(n.subdomain) + '" data-id="' + esc(n.id) + '">Create invoice &amp; PDF</button>'
      +   '</div>'
      + '</div>';

    var pAgreement =
        '<div class="card"><h3>Subscription agreement</h3>'
      +   '<p class="sub" style="margin:2px 0 8px;">Generate the Home Land Homes software subscription agreement for this nation as a PDF. It fills in the nation party details below and is saved to the document library.</p>'
      +   '<label>Nation legal name (party)</label><input id="cn-agr-name" value="' + esc(n.display_name || '') + '"/>'
      +   '<label>Administrative / mailing office address</label><input id="cn-agr-addr" placeholder="123 Main St, Town, ON  A1A 1A1" value="' + esc(n.office_address || '') + '"/>'
      +   '<div class="sub" style="margin:4px 0 0;font-size:11px;">Saved on the nation record and reused on the agreement + recurring-invoice header. Generating the agreement also saves it.</div>'
      +   '<div class="msg" id="cn-agr-msg"></div>'
      +   '<div style="display:flex;gap:8px;flex-wrap:wrap;">'
      +     '<button class="btn ghost" type="button" data-act="agr-save-addr" data-id="' + esc(n.id) + '">Save address</button>'
      +     '<button class="btn" type="button" data-act="gen-agreement" data-id="' + esc(n.id) + '">Generate agreement PDF</button>'
      +   '</div>'
      + '</div>';

    var pDocuments =
        '<div class="card"><h3>Documents</h3>'
      +   '<p class="sub" style="margin:2px 0 8px;">Signed agreements, BCRs, invoices and other files for this nation. Stored privately on the control plane.</p>'
      +   '<div id="cn-docs"><div class="empty">Loading documents...</div></div>'
      +   '<div style="margin-top:14px;">'
      +     '<label>Document type for new uploads</label>'
      +     '<select id="cn-doc-kind"><option value="agreement">Agreement</option><option value="bcr">BCR</option><option value="other" selected>Other</option></select>'
      +     '<div id="cn-doc-drop" style="margin-top:10px;border:2px dashed var(--hair);border-radius:10px;padding:18px 16px;text-align:center;cursor:pointer;background:var(--bg);transition:border-color .15s, background .15s;">'
      +       '<div style="font-size:22px;line-height:1;margin-bottom:6px;pointer-events:none;">&#128228;</div>'
      +       '<div style="font-size:13px;color:var(--muted);pointer-events:none;">Drag &amp; drop a file here, or <b style="color:var(--ink);">click to choose</b></div>'
      +       '<input id="cn-doc-file" type="file" style="display:none;" data-sub="' + esc(n.subdomain) + '"/>'
      +       '<div id="cn-doc-name" style="font-size:12px;font-weight:600;color:var(--ok);margin-top:8px;min-height:16px;"></div>'
      +     '</div>'
      +   '</div>'
      +   '<div class="msg" id="cn-doc-msg"></div>'
      + '</div>';

    return '<div class="nic-shell">'
      + '<div class="nic-hero">'
      +   '<button class="back" type="button" data-act="home">&larr; All nations</button>'
      +   '<h1>' + esc(n.display_name) + '</h1>'
      +   '<div class="nic-sub"><code>' + esc(n.subdomain) + '.fnhub.app</code> &middot; Nation Information Card</div>'
      + '</div>'
      + '<div class="nic-strip">'
      +   '<div class="nic-strip-tile"><div class="l">Status</div><div class="v"><span class="pill ' + esc(n.status||'provisioning') + '">' + esc(n.status||'provisioning') + '</span></div></div>'
      +   '<div class="nic-strip-tile"><div class="l">Licensed modules</div><div class="v">' + modCount + '</div></div>'
      +   '<div class="nic-strip-tile"><div class="l">Data usage</div><div class="v" id="cn-sum-usage" style="color:var(--muted);">&mdash;</div></div>'
      +   '<div class="nic-strip-tile"><div class="l">Outstanding</div><div class="v" id="cn-sum-inv" style="color:var(--muted);">&mdash;</div></div>'
      + '</div>'
      + '<div class="nic-tabs">'
      +   tab('overview', 'Overview', true) + tab('supabase', 'Config') + tab('email', 'Email Config') + tab('emailintake', 'Email Intake') + tab('agreement', 'Agreement')
      +   tab('billing', 'Billing') + tab('invoices', 'Invoices') + tab('notes', 'Notes') + tab('documents', 'Documents')
      + '</div>'
      + '<div class="nic-body">'
      +   panel('overview', pOverview, true) + panel('supabase', pSupabase) + panel('email', pEmail) + panel('emailintake', pEmailIntake)
      +   panel('agreement', pAgreement) + panel('billing', pBilling) + panel('invoices', pInvoices)
      +   panel('notes', pNotes) + panel('documents', pDocuments)
      + '</div>'
      + '<div class="nic-footer">'
      +   '<div class="msg" id="cn-msg"></div>'
      +   '<button class="btn" id="cn-save" type="button" data-act="save-config" data-id="' + esc(n.id) + '">Save changes</button>'
      + '</div>'
      + '</div>';
  }
  window.nicTab = function(name){
    Array.prototype.forEach.call(document.querySelectorAll('.nic-tab'), function(b){ b.classList.toggle('active', b.getAttribute('data-tab') === name); });
    Array.prototype.forEach.call(document.querySelectorAll('.nic-panel'), function(p){ p.classList.toggle('active', p.getAttribute('data-panel') === name); });
  };

  window.saveNationConfig = async function(id){
    var get = function(x){ return (document.getElementById(x) || {}).value || ''; };
    var name = get('cn-name').trim(), short = get('cn-short').trim();
    if (!name || !short){ setMsg('cn-msg','Display name and short code are required.'); return; }
    var mods = {};
    Array.prototype.forEach.call(document.querySelectorAll('.cn-mod'), function(c){ mods[c.value] = c.checked; });
    // Email delivery config -> nations.email jsonb (published via
    // nations_public). Saved null when untouched (graph default + all blank)
    // so nations that never configured email keep a clean row.
    var emProvider = get('cn-em-provider') || 'graph';
    var emFrom     = get('cn-em-from').trim();
    var emFromName = get('cn-em-from-name').trim();
    var emReply    = get('cn-em-reply').trim();
    var emailCfg = (emProvider === 'graph' && !emFrom && !emFromName && !emReply)
      ? null
      : { provider: emProvider, from: emFrom || null, from_name: emFromName || null, reply_to: emReply || null };
    var patch = {
      display_name: name, short: short,
      primary_color: get('cn-color').trim() || null,
      logo: get('cn-logo') || null,
      email_domain:  get('cn-domain').trim() || null,
      housing_email: get('cn-housing').trim() || null,
      supabase_url:  get('cn-url').trim() || null,
      supabase_anon: get('cn-anon').trim() || null,
      credentials_note: get('cn-cred').trim() || null,
      email: emailCfg,
      modules_licensed: mods,
      status: get('cn-status') || 'provisioning',
      updated_at: new Date().toISOString()
    };
    var btn = document.getElementById('cn-save'); if (btn){ btn.disabled = true; btn.textContent = 'Saving...'; }
    var r = await api('PATCH', '/nations?id=eq.' + encodeURIComponent(id), patch, 'return=minimal');
    if (r.ok){ await audit('nation_configured', id, name); showDashboard(); }
    else { var t = await r.text(); setMsg('cn-msg','Could not save: ' + t); if (btn){ btn.disabled = false; btn.textContent = 'Save changes'; } }
  };

  // ---- Provision a nation (P4, assisted) -------------------------------------
  function provisionCard(){
    return '<div class="card"><h3>Provision a nation (assisted)</h3>'
      + '<p class="sub" style="margin:2px 0 8px;">Stand up a new nation on a Supabase project you already created: replay the bootstrap schema, create the storage bucket, seed the first ED, and register it. Needs the bootstrap schema file and the Management API token secret on the platform function.</p>'
      + '<button class="btn" type="button" data-act="provision">Start provisioning wizard</button></div>';
  }

  // https://<ref>.supabase.co -> <ref>, so the wizard can prefill Project ref
  // from the URL already stored on the registry row.
  // Copy a data-copy value to the clipboard with visible button feedback.
  // Clipboard API first; execCommand-on-a-temp-textarea as the fallback.
  window.copyTextBtn = function(btn){
    var text = (btn && btn.getAttribute('data-copy')) || '';
    if (!text) return;
    function done(ok){
      if (!btn) return;
      var orig = btn.textContent;
      btn.textContent = ok ? 'Copied ✓' : 'Copy failed';
      setTimeout(function(){ btn.textContent = orig; }, 1600);
    }
    if (navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).then(function(){ done(true); }, function(){ done(false); });
      return;
    }
    try {
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.cssText = 'position:fixed;opacity:0;';
      document.body.appendChild(ta); ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      done(ok);
    } catch(e){ done(false); }
  };

  function _refFromUrl(url){
    var m = /^https?:\/\/([a-z0-9-]+)\.supabase\.co/i.exec(String(url || '').trim());
    return m ? m[1] : '';
  }

  // showProvision(id?) -- with an id, prefills from the registry row and locks
  // the subdomain, so provisioning an ALREADY-REGISTERED nation (the normal
  // flow: register first, create the project, then provision) updates that row
  // instead of trying to mint a second one. provision-nation upserts on
  // subdomain, so re-running against an existing nation is safe.
  window.showProvision = async function(id){
    document.getElementById('btn_out').style.display = '';
    var n = id ? (_nations.filter(function(x){ return String(x.id) === String(id); })[0] || null) : null;
    // Defensive: if the cache missed, fetch before rendering rather than
    // falling back to a blank wizard (see the note in configureNation).
    if (id && !n){
      var rr = await api('GET', '/nations?select=*&id=eq.' + encodeURIComponent(id));
      var aa = rr.ok ? await rr.json().catch(function(){return[];}) : [];
      n = aa[0] || null;
      if (n) _nations = _nations.concat([n]);
    }
    var v = function(x){ return esc(x == null ? '' : x); };
    var g2 = 'display:grid;grid-template-columns:1fr 1fr;gap:10px;';
    var licensed = (n && n.modules_licensed) || null;
    var modChecks = MODULES.map(function(m){
      // Existing nation: mirror its licensing. New nation: all on by default,
      // matching the Add Nation card.
      var on = licensed ? !!licensed[m[0]] : true;
      return '<label style="display:inline-flex;align-items:center;gap:6px;font-weight:600;margin:0 12px 8px 0;"><input type="checkbox" class="pv-mod" value="' + m[0] + '" style="width:auto;"' + (on ? ' checked' : '') + '/> ' + esc(m[1]) + '</label>';
    }).join('');
    app.innerHTML = '<button class="btn sm ghost" type="button" data-act="' + (n ? 'configure' : 'home') + '"' + (n ? ' data-id="' + v(n.id) + '"' : '') + '>&larr; Back</button>'
      + '<h1 style="margin-top:12px;">' + (n ? 'Provision ' + v(n.display_name) : 'Provision a nation') + '</h1>'
      + '<p class="sub">Assisted: you created the Supabase project; this runs schema, bucket, first ED, and registry.</p>'
      + (n ? '<div class="msg ok" style="display:block;">Prefilled from the registry. The registry row for <code>' + v(n.subdomain) + '</code> will be updated, not duplicated.</div>' : '')
      + '<div class="card"><h3>Nation</h3>'
      +   '<div style="' + g2 + '"><div><label>Subdomain</label><input id="pv-sub" placeholder="listuguj" value="' + v(n && n.subdomain) + '"' + (n ? ' readonly style="background:var(--bg);color:var(--muted);"' : '') + '/></div><div><label>Short code</label><input id="pv-short" placeholder="LMG" value="' + v(n && n.short) + '"/></div></div>'
      +   '<label>Display name</label><input id="pv-name" placeholder="Listuguj Mi\'gmaq Government" value="' + v(n && n.display_name) + '"/>'
      +   '<div style="' + g2 + '"><div><label>Staff email domain</label><input id="pv-domain" placeholder="listuguj.ca" value="' + v(n && n.email_domain) + '"/></div><div><label>Primary color</label><input id="pv-color" placeholder="#f8e41a" value="' + v(n && n.primary_color) + '"/></div></div>'
      +   '<label>Housing email</label><input id="pv-housing" placeholder="housing@listuguj.ca" value="' + v(n && n.housing_email) + '"/>'
      +   '<label style="margin-top:10px;">Licensed modules</label><div>' + modChecks + '</div>'
      + '</div>'
      + '<div class="card"><h3>Target Supabase project ' + extLink(LINKS.supaApi, 'Where to find these &rarr;') + '</h3>'
      +   '<p class="sub" style="margin:2px 0 8px;">The new project you created (' + extLink(LINKS.supaNew, 'create one &rarr;') + '). All four values are on the project\'s <b>Settings &rarr; API</b> page. The service_role key is used once (bucket + ED) and never stored.</p>'
      +   '<div style="' + g2 + '">'
      +     '<div><label>Project ref</label><input id="pv-ref" placeholder="abcdefgh...ref" value="' + v(_refFromUrl(n && n.supabase_url)) + '" title="Supabase -> your project -> Settings -> General -> Reference ID. It is also the string in the dashboard URL: supabase.com/dashboard/project/<ref>"/>' + fieldHint('Settings &rarr; General &rarr; <b>Reference ID</b> (also the code in the dashboard URL).') + '</div>'
      +     '<div><label>Project URL</label><input id="pv-url" placeholder="https://&lt;ref&gt;.supabase.co" value="' + v(n && n.supabase_url) + '" title="Supabase -> Settings -> API -> Project URL (https://<ref>.supabase.co)"/>' + fieldHint('Settings &rarr; API &rarr; <b>Project URL</b>.') + '</div>'
      +   '</div>'
      +   '<label>Anon (publishable) key</label><input id="pv-anon" placeholder="eyJ..." value="' + v(n && n.supabase_anon) + '" title="Supabase -> Settings -> API -> Project API keys -> anon / public. Publishable; safe to store."/>' + fieldHint('Settings &rarr; API &rarr; Project API keys &rarr; <b>anon / public</b>. Publishable &mdash; safe to store.')
      +   '<label>Service role key (used once)</label><input id="pv-service" placeholder="eyJ... (service_role)" title="Supabase -> Settings -> API -> Project API keys -> service_role. SECRET. Used once here (bucket + first ED) and never stored."/>' + fieldHint('Settings &rarr; API &rarr; Project API keys &rarr; <b>service_role</b>. <b style="color:var(--danger);">Secret</b> &mdash; used once, never stored.')
      + '</div>'
      + '<div class="card"><h3>First ED</h3>'
      +   '<div style="' + g2 + '"><div><label>First ED email</label><input id="pv-ed-email" placeholder="ed@listuguj.ca"/></div><div><label>First ED name</label><input id="pv-ed-name" placeholder="Executive Director"/></div></div>'
      +   '<label>First ED password (optional)</label><input id="pv-ed-pass" placeholder="leave blank to auto-generate"/>'
      +   fieldHint('Creates the ED\'s actual sign-in on the new project. Leave blank and a strong password is generated and shown once in the result &mdash; hand it to the ED to change on first login.')
      + '</div>'
      + '<div class="card"><h3>Bootstrap schema <span style="font-weight:400;color:var(--muted);font-size:12px;">(optional)</span></h3>'
      +   '<p class="sub" style="margin:2px 0 8px;">Leave this empty &mdash; the function <b>auto-fetches</b> the current schema from the app repo. Only drop a file to pin a specific version.</p>'
      +   '<div id="pv-drop" style="border:2px dashed var(--hair);border-radius:10px;padding:16px;text-align:center;cursor:pointer;background:var(--bg);transition:border-color .15s, background .15s;">'
      +     '<div style="font-size:20px;line-height:1;margin-bottom:6px;pointer-events:none;">&#128228;</div>'
      +     '<div style="font-size:13px;color:var(--muted);pointer-events:none;">Optional &mdash; drag &amp; drop <code>schema.sql</code>, or <b style="color:var(--ink);">click to choose</b></div>'
      +     '<input id="pv-schema" type="file" accept=".sql,text/plain" style="display:none;" title="Optional. If empty, the current schema is auto-fetched from the repo."/>'
      +     '<div id="pv-schema-name" style="font-size:12px;font-weight:600;color:var(--ok);margin-top:8px;min-height:16px;"></div>'
      +   '</div>'
      + '</div>'
      + '<div class="msg" id="pv-msg"></div>'
      + '<button class="btn" id="pv-btn" type="button" data-act="run-provision">Provision nation</button>'
      + '<div id="pv-results" style="margin-top:14px;"></div>';
    wireSchemaDropzone();
  };

  // Drag-and-drop + click-to-browse for the bootstrap schema file. The panel's
  // CSP has no inline handlers, and drag events can't be delegated, so this is
  // wired directly after showProvision paints. runProvision still reads
  // document.getElementById('pv-schema').files[0], so we assign the dropped
  // file back onto the hidden native input via a DataTransfer.
  function wireSchemaDropzone(){
    var dz = document.getElementById('pv-drop');
    var input = document.getElementById('pv-schema');
    var nameEl = document.getElementById('pv-schema-name');
    if (!dz || !input) return;
    function showName(){ if (nameEl) nameEl.textContent = (input.files && input.files[0]) ? ('✓ ' + input.files[0].name) : ''; }
    function hot(on){ dz.style.borderColor = on ? 'var(--accent)' : 'var(--hair)'; dz.style.background = on ? 'var(--accent-light)' : 'var(--bg)'; }
    input.addEventListener('change', showName);
    dz.addEventListener('click', function(){ input.click(); });
    ['dragenter','dragover'].forEach(function(ev){ dz.addEventListener(ev, function(e){ e.preventDefault(); e.stopPropagation(); hot(true); }); });
    ['dragleave','dragend'].forEach(function(ev){ dz.addEventListener(ev, function(e){ e.preventDefault(); e.stopPropagation(); hot(false); }); });
    dz.addEventListener('drop', function(e){
      e.preventDefault(); e.stopPropagation(); hot(false);
      var files = e.dataTransfer && e.dataTransfer.files;
      if (!files || !files.length) return;
      try { var dt = new DataTransfer(); dt.items.add(files[0]); input.files = dt.files; } catch(err){ /* older browsers: fall back to click */ }
      showName();
    });
  }

  window.runProvision = async function(){
    var get = function(x){ return (document.getElementById(x) || {}).value || ''; };
    var sub = get('pv-sub').trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
    var name = get('pv-name').trim(), short = get('pv-short').trim();
    if (!sub || !name || !short){ setMsg('pv-msg', 'Subdomain, display name, and short code are required.'); return; }
    var mods = {};
    Array.prototype.forEach.call(document.querySelectorAll('.pv-mod'), function(c){ mods[c.value] = c.checked; });
    // Guard: refuse to target the control-plane project (a nation must go on its
    // own Supabase project). PBASE is the control-plane URL this panel talks to.
    var cpRef = String(PBASE || '').replace(/^https?:\/\//, '').split('.')[0];
    var tRef  = get('pv-ref').trim() || _refFromUrl(get('pv-url').trim());
    if (cpRef && tRef && tRef === cpRef){
      setMsg('pv-msg', 'That is the control-plane project (' + cpRef + '). Enter the NATION\'s own Supabase project URL/ref/keys instead.');
      return;
    }
    var schemaSql = '';
    var fileEl = document.getElementById('pv-schema');
    if (fileEl && fileEl.files && fileEl.files[0]) {
      try { schemaSql = await fileEl.files[0].text(); }
      catch (e){ setMsg('pv-msg', 'Could not read the schema file.'); return; }
    }
    var payload = {
      nation: { subdomain: sub, display_name: name, short: short,
                email_domain: get('pv-domain').trim() || null, housing_email: get('pv-housing').trim() || null,
                primary_color: get('pv-color').trim() || null, modules_licensed: mods },
      target: { ref: get('pv-ref').trim() || _refFromUrl(get('pv-url').trim()) || null, url: get('pv-url').trim() || null,
                anon: get('pv-anon').trim() || null, service_role: get('pv-service').trim() || null },
      first_ed: { email: get('pv-ed-email').trim() || null, name: get('pv-ed-name').trim() || null,
                  password: get('pv-ed-pass').trim() || null },
      schema_sql: schemaSql
    };
    var btn = document.getElementById('pv-btn'); if (btn){ btn.disabled = true; btn.textContent = 'Provisioning...'; }
    document.getElementById('pv-results').innerHTML = '<p class="sub">Running... this can take a minute.</p>';
    try {
      var r = await fetch(PBASE + '/functions/v1/provision-nation', {
        method: 'POST',
        headers: { apikey: ANON, Authorization: 'Bearer ' + getAT(), 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      var d = await r.json().catch(function(){ return {}; });
      if (!r.ok){
        setMsg('pv-msg', (d && d.error) ? ('Failed: ' + d.error) : ('Failed: HTTP ' + r.status));
        document.getElementById('pv-results').innerHTML = '';
      } else { renderProvisionResults(d); }
    } catch (e){ setMsg('pv-msg', 'Network error: ' + String(e).slice(0, 120)); document.getElementById('pv-results').innerHTML = ''; }
    if (btn){ btn.disabled = false; btn.textContent = 'Provision nation'; }
  };

  // Support impersonation (SUPER-ADMIN-PLAN 12.3): open a signed-in session on a
  // nation's app as "Platform Support" (super_user, expires end-of-day), audited
  // on both the control plane and the nation. Calls the platform enter-nation
  // function (super-admin JWT), which server-to-server calls the nation's
  // support-login function with the shared secret and returns a magic link.
  window.enterNation = async function(id){
    var n = _nations.filter(function(x){ return String(x.id) === String(id); })[0];
    if (!n){ dlgAlert('Nation not loaded.'); return; }
    if (!n.supabase_url){ dlgAlert('This nation has no Supabase project yet, so there is nothing to enter.'); return; }
    var ok = await dlgConfirm(
      'Open a SUPPORT SESSION on ' + esc(n.display_name) + ' (' + esc(n.subdomain) + '.fnhub.app)?\n\n'
      + 'You will be signed in as Platform Support with full (super_user) access to this nation\'s live data. '
      + 'This is logged on both the control plane and the nation, and the access lapses at end of day. '
      + 'Only enter with the nation\'s awareness.',
      { title: 'Enter nation for support', okText: 'Enter nation' });
    if (!ok) return;
    var r;
    try {
      r = await fetch(PBASE + '/functions/v1/enter-nation', {
        method: 'POST',
        headers: { apikey: ANON, Authorization: 'Bearer ' + getAT(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ subdomain: n.subdomain })
      });
    } catch (e){ dlgAlert('Network error: ' + String(e).slice(0, 120)); return; }
    var d = await r.json().catch(function(){ return {}; });
    if (!r.ok || !d.action_link){
      var msg = d.message || d.error || ('HTTP ' + r.status);
      if (d.error === 'support_disabled') msg = esc(n.display_name) + ' has turned OFF platform support login. Ask the nation to re-enable it in Settings before you can enter.';
      else if (d.error === 'no_support_key') msg = 'No support key for this nation yet. Generate one in Dashboard → Config → Support login key, then set SUPPORT_LOGIN_PUBKEY on the nation project.';
      else if (d.error === 'pubkey_not_set') msg = 'This nation has no SUPPORT_LOGIN_PUBKEY set. Copy its public key (Dashboard → Config → Support login key) into the nation project\'s Edge Function secrets, then redeploy support-login.';
      dlgAlert('Could not enter: ' + msg, { title: 'Support login' });
      return;
    }
    // The action link is a one-time Supabase magic link that lands on the nation
    // app already signed in; open it in a new tab.
    window.open(d.action_link, '_blank', 'noopener');
    dlgAlert('A support session for ' + esc(n.display_name) + ' opened in a new tab (signed in as Platform Support; access ends '
      + esc(d.access_expires_at || 'today') + '). This was logged on both sides.', { title: 'Entered nation' });
  };

  // Support-login signing key (per-nation, asymmetric). The PRIVATE key stays in
  // the control-plane DB; the operator copies the PUBLIC key into the nation's
  // SUPPORT_LOGIN_PUBKEY secret. Generated server-side via gen-support-key.
  function _supportKeyPubBlock(jwk){
    var val = ''; try { val = JSON.stringify(jwk); } catch (e) { val = ''; }
    return '<label style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;">Public key (SUPPORT_LOGIN_PUBKEY)</label>'
      + '<textarea id="cn-supportkey-jwk" readonly rows="3" style="width:100%;font-family:ui-monospace,Menlo,monospace;font-size:11px;background:var(--bg);color:var(--muted);border:1px solid var(--line);border-radius:8px;padding:8px;resize:vertical;box-sizing:border-box;">' + esc(val) + '</textarea>'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px;align-items:center;">'
      +   '<button class="btn sm ghost" type="button" data-act="supportkey-copy">Copy public key</button>'
      +   '<span class="sub" style="font-size:11px;">Paste as <code>SUPPORT_LOGIN_PUBKEY</code> in this nation\'s Settings &rarr; Edge Functions &rarr; Secrets, then (re)deploy <code>support-login</code>.</span>'
      + '</div>';
  }
  async function renderSupportKey(sub){
    var host = document.getElementById('cn-supportkey'); if (!host) return;
    var r = await api('GET', '/nation_support_keys_public?subdomain=eq.' + encodeURIComponent(sub) + '&select=public_jwk,created_at,algorithm&limit=1');
    var row = (r.ok ? await r.json().catch(function(){ return []; }) : [])[0] || null;
    if (row){
      host.innerHTML =
          '<div style="font-size:12px;margin-bottom:8px;"><span class="pill active">Key set</span> &middot; ' + esc(row.algorithm || 'ES256')
            + (row.created_at ? ' &middot; created ' + esc(timeAgo(row.created_at)) : '') + '</div>'
        + _supportKeyPubBlock(row.public_jwk)
        + '<div class="msg" id="cn-supportkey-msg"></div>'
        + '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">'
        +   '<button class="btn sm ghost" type="button" data-act="supportkey-rotate" data-sub="' + esc(sub) + '">Rotate key</button>'
        + '</div>';
    } else {
      host.innerHTML =
          '<div style="font-size:12px;color:var(--muted);margin-bottom:8px;">No support key yet. Generate one, then set <code>SUPPORT_LOGIN_PUBKEY</code> on this nation\'s project.</div>'
        + '<div class="msg" id="cn-supportkey-msg"></div>'
        + '<button class="btn sm" type="button" data-act="supportkey-gen" data-sub="' + esc(sub) + '">Generate keypair</button>';
    }
  }
  window.genSupportKey = async function(sub, rotate){
    if (rotate){
      var ok = await dlgConfirm('Rotate the support key for ' + esc(sub) + '?\n\nThis generates a NEW keypair. The nation\'s CURRENT public key stops working immediately — support login fails for this nation until you copy the new public key into its SUPPORT_LOGIN_PUBKEY secret and redeploy support-login.', { title: 'Rotate support key', okText: 'Rotate key' });
      if (!ok) return;
    }
    setMsg('cn-supportkey-msg', rotate ? 'Rotating...' : 'Generating...', 'ok');
    var r;
    try {
      r = await fetch(PBASE + '/functions/v1/gen-support-key', {
        method: 'POST',
        headers: { apikey: ANON, Authorization: 'Bearer ' + getAT(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ subdomain: sub, rotate: !!rotate })
      });
    } catch (e){ setMsg('cn-supportkey-msg', 'Network error: ' + String(e).slice(0, 120)); return; }
    var d = await r.json().catch(function(){ return {}; });
    if (!r.ok || !d.public_jwk){ setMsg('cn-supportkey-msg', 'Failed: ' + (d.message || d.error || ('HTTP ' + r.status))); return; }
    await renderSupportKey(sub);
    setMsg('cn-supportkey-msg', (d.rotated ? 'Rotated' : 'Generated') + '. Copy the public key into the nation\'s SUPPORT_LOGIN_PUBKEY secret, then redeploy support-login.', 'ok');
  };

  function renderProvisionResults(d){
    var steps = (d && d.steps) || [];
    var rows = steps.map(function(s){
      return '<tr><td>' + (s.ok ? '✅' : '⚠️') + '</td><td><b>' + esc(s.name) + '</b></td>'
        + '<td style="font-size:12px;color:var(--muted);">' + esc(s.detail) + '</td></tr>';
    }).join('');
    var head = d.ok
      ? '<div class="msg ok" style="display:block;">Provisioned <b>' + esc(d.subdomain) + '</b>. Registry updated.</div>'
      : '<div class="msg err" style="display:block;">Finished with issues - review the steps below.</div>';
    // Show the generated ED password once, prominently.
    var pwBox = (d && d.ed_password)
      ? '<div class="msg ok" style="display:block;">Sign-in created for <b>' + esc(d.ed_email || '') + '</b>. Temporary password (shown once): <code style="font-size:14px;">' + esc(d.ed_password) + '</code><br><span style="font-size:12px;">Give this to the ED and have them change it on first login. Save it in your password manager now.</span></div>'
      : '';
    var mel = document.getElementById('pv-msg'); if (mel){ mel.className = 'msg'; mel.textContent = ''; }
    document.getElementById('pv-results').innerHTML = head + pwBox
      + '<div class="card"><h3>Result</h3><table><tbody>' + rows + '</tbody></table>'
      + '<button class="btn sm" type="button" data-act="home" style="margin-top:10px;">Back to nations</button></div>';
  }

  // ==========================================================================
  // Subscription agreement PDF + per-nation document library
  // ==========================================================================
  var STORE = PBASE + '/storage/v1';
  var DOC_BUCKET = 'nation-docs';

  // Lazy-load jsPDF (same build the nation app uses). CSP allows cdnjs here.
  var _jspdfLoading = null;
  function ensureJsPdf(cb, onerr){
    if (window.jspdf && window.jspdf.jsPDF) { cb(); return; }
    if (_jspdfLoading) { _jspdfLoading.then(cb, onerr); return; }
    _jspdfLoading = new Promise(function(resolve, reject){
      var s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
      s.onload = resolve; s.onerror = function(){ reject(new Error('jspdf load failed')); };
      document.head.appendChild(s);
    });
    _jspdfLoading.then(cb, onerr);
  }

  // The agreement, marker-formatted. Placeholders: {{NATION}} {{ADDRESS}} {{DATE}}.
  // Markers:  >disclaimer  #title  %subtitle  ##section  ###clause  -bullet  (blank)=gap
  var AGREEMENT_TPL = [
    '>TEMPLATE - This agreement was prepared as a working draft and is not legal advice. Have it reviewed by a lawyer (ideally one experienced with First Nations clients) before first use, and update the Provider party details upon incorporation.',
    '#SOFTWARE SUBSCRIPTION AGREEMENT',
    '%Home Land Homes - Housing Management Platform',
    'This Software Subscription Agreement (the "Agreement") is made as of the date of last signature below (the "Effective Date") between:',
    'Kevin Proctor, operating as "Home Land Homes" (the "Provider"), and',
    '{{NATION}}, a First Nation with administrative offices at {{ADDRESS}} (the "Nation").',
    '##Background',
    '-The Nation operates a housing department that manages homes, applications, tenancies, maintenance, capital projects and related finances for its members.',
    '-The Provider makes available a housing-management software platform designed for First Nations housing departments.',
    "-Both parties intend that the Nation's data remain under the Nation's ownership and control at all times, consistent with the principles of OCAP(R) (Ownership, Control, Access and Possession).",
    "-The parties acknowledge the United Nations Declaration on the Rights of Indigenous Peoples (UNDRIP), including Article 23 (the right of Indigenous peoples to be actively involved in developing and administering housing programmes through their own institutions) and Article 31 (the right of Indigenous peoples to maintain, control, protect and develop their data and cultural heritage), and the United Nations Declaration on the Rights of Indigenous Peoples Act, S.C. 2021, c. 14. This Agreement is intended to support the Nation's administration of its own housing programme through its own institutions.",
    '-The parties therefore agree as follows.',
    '##1. Definitions',
    '"Customer Data" means all data, records, documents, images and other content submitted to or generated within the Platform by or for the Nation, including personal information of the Nation\'s members, applicants, tenants, staff and contractors.',
    '"Platform" means the Provider\'s hosted housing-management software, including its staff application, tenant/applicant portal, and all modules listed in Schedule A, together with associated documentation.',
    '"Order Form" means Schedule A to this Agreement, which records the subscription tier, fees, term and options selected by the Nation.',
    '"Users" means individuals authorized by the Nation to access the Platform, including staff, leadership, consultants (subject to Section 2.4), and members using the tenant/applicant portal.',
    '"Setup Services" means the one-time onboarding services described in Schedule B.',
    '"Subscription Term" means the Initial Term and each Renewal Term described in Section 8.',
    '##2. Subscription and Access',
    '###2.1 Grant',
    'Subject to this Agreement and payment of the Fees, the Provider grants the Nation a non-exclusive, non-transferable right during the Subscription Term for its Users to access and use the Platform for the Nation\'s internal housing-administration purposes.',
    "###2.2 The Nation's workspace",
    "The Provider will provision a dedicated workspace for the Nation, including a database used solely for the Nation's Customer Data (no other customer's data is stored in the Nation's database), the Nation's own subdomain, and the Nation's branding as supplied by the Nation.",
    '###2.3 Users',
    'The Nation may authorize an unlimited number of Users. The Nation is responsible for its Users\' compliance with this Agreement, for maintaining the accuracy of role assignments, and for promptly deactivating Users who should no longer have access. Login credentials are personal and must not be shared.',
    '###2.4 Consultants and outside contractors',
    "The Nation may grant restricted access to external consultants using the Platform's per-user feature-access controls. Such access is at the Nation's direction and risk, and consultants are Users for the purposes of this Agreement.",
    '###2.5 Restrictions',
    "The Nation will not (and will not permit anyone to): resell or provide the Platform to any third party other than Users; copy, modify or create derivative works of the Platform; reverse engineer the Platform except to the extent permitted by law; use the Platform to violate applicable law; or attempt to access another customer's data.",
    '##3. Provider Obligations',
    '###3.1 Hosting and data location',
    "The Provider will host the Platform and store Customer Data (including backups) on infrastructure located in Canada, and will not transfer Customer Data outside Canada without the Nation's prior written consent, except as strictly required to deliver a feature the Nation has enabled (in which case the Provider will identify the subprocessor and location in advance).",
    '###3.2 Availability and support',
    'The Provider will provide the Platform and support in accordance with Schedule C (Support and Service Levels).',
    '###3.3 Backups',
    "The Provider will maintain automated daily backups of the Nation's database, retained for at least seven (7) days, and will restore from backup without additional charge where data loss results from a Platform failure.",
    '###3.4 Security',
    'The Provider will maintain administrative, technical and organizational safeguards appropriate to the sensitivity of Customer Data, including encryption of data in transit, role-based access control, per-action approval authorities, and tamper-resistant (append-only) audit logging of material actions within the Platform.',
    '###3.5 Updates',
    'The Provider will maintain and update the Platform at no additional charge. Updates will not materially reduce the functionality the Nation has subscribed to during a Subscription Term.',
    '###3.6 Transparency reporting',
    'At least once per contract year, and additionally on the Nation\'s reasonable request, the Provider will give the Nation a written transparency summary covering: availability performance against Schedule C; any security incidents affecting the Nation and their resolution; written confirmation that Customer Data (including backups) remained on infrastructure in Canada in accordance with Section 3.1; any subprocessor additions or changes (Schedule D); and material changes to the Platform. The Provider does not place advertising trackers or third-party analytics in the Platform; operational logs are used only to operate, support and secure the service.',
    '##4. Customer Data - Ownership and Sovereignty',
    '###4.1 Ownership',
    'As between the parties, the Nation owns all right, title and interest in and to Customer Data. The Provider acquires no rights in Customer Data other than the limited license in Section 4.2.',
    '###4.2 Limited license',
    'The Nation grants the Provider a limited, non-exclusive license to host, process, transmit, display and back up Customer Data solely as necessary to provide and support the Platform, and for no other purpose.',
    '###4.3 Prohibited uses',
    'The Provider will not sell Customer Data; will not share Customer Data with any third party except subprocessors necessary to deliver the service; will not use Customer Data for advertising or profiling; and will not use Customer Data to train any artificial-intelligence model. The optional AI Assistant operates only if the Nation selects and initials that add-on in Schedule A; that selection constitutes the Nation\'s prior written approval under Section 3.1 for the limited out-of-Canada processing described in Schedule D. AI queries are processed by the Provider\'s AI subprocessor under agreements that prohibit the use of the Nation\'s data for model training; the AI Assistant has read-only access governed by the requesting User\'s permissions, and the Nation may disable it at any time in Platform settings.',
    '###4.4 Access and control',
    "The Nation controls which Users may access which functions and records through the Platform's role, approval-authority and feature-access settings. The Provider will access the Nation's workspace only for support, maintenance, or as directed by the Nation, and such access is logged.",
    '###4.5 Export',
    'The Nation may request, and the Provider will deliver within fifteen (15) business days, a complete export of Customer Data in machine-readable formats (such as CSV/JSON, plus stored files in their native formats) at no charge no more than twice per year, and at a reasonable fee thereafter.',
    '###4.6 Return and deletion on termination',
    "For sixty (60) days following expiry or termination of this Agreement, the Provider will make a complete export of Customer Data available to the Nation as described in Section 4.5 at no charge. Following that period (or earlier at the Nation's written direction), the Provider will permanently delete Customer Data from production systems, with deletion from rolling backups occurring in the ordinary course within seven (7) days thereafter, and will certify deletion on request.",
    '###4.7 Privacy compliance and breach notice',
    'Each party will comply with privacy laws applicable to it in respect of personal information contained in Customer Data, including the Personal Information Protection and Electronic Documents Act (Canada) to the extent applicable. The Provider will notify the Nation without undue delay, and in any event within seventy-two (72) hours, after becoming aware of any breach of security leading to unauthorized access to or disclosure of Customer Data, and will cooperate with the Nation\'s reasonable investigation and notification obligations.',
    '###4.8 OCAP(R) alignment',
    'The parties record how this Agreement gives effect to the principles of OCAP(R): Ownership - the Nation owns all Customer Data (Section 4.1); Control - the Nation controls access, roles and approvals within the Platform, and the Provider may use Customer Data only as the Nation permits (Sections 4.2-4.4); Access - the Nation may access and export its complete data at any time (Section 4.5); Possession - on exit, the Nation takes possession of its complete records and the Provider deletes its copies (Section 4.6). OCAP(R) is a registered trademark of the First Nations Information Governance Centre (FNIGC); the Provider is not affiliated with, endorsed by, or certified by FNIGC, and this Section describes contractual commitments, not a certification.',
    '###4.9 UNDRIP and interpretation',
    'This Agreement shall be interpreted in a manner consistent with the United Nations Declaration on the Rights of Indigenous Peoples, including the Nation\'s right of self-determination, its right to administer its housing programmes through its own institutions (Article 23), and its rights in respect of its data and information (Article 31 and the principles of Indigenous data sovereignty). Nothing in this Agreement abrogates or derogates from the Nation\'s inherent, Aboriginal or treaty rights, or from the Nation\'s own laws, customs and governance processes. If any provision of this Agreement is ambiguous, the interpretation that best upholds the Nation\'s ownership and control of Customer Data prevails.',
    '###4.10 Government and third-party demands',
    'If the Provider receives a court order, subpoena, or other governmental or third-party demand for Customer Data, the Provider will (unless legally prohibited from doing so): promptly notify the Nation before any disclosure; disclose only the minimum Customer Data it is legally compelled to disclose; and reasonably cooperate, at the Nation\'s request and expense, with the Nation\'s efforts to contest, limit or seek protective treatment of the demand. The Provider will not voluntarily disclose Customer Data to any government or third party.',
    '##5. Setup Services and Data Migration',
    'The Provider will perform the Setup Services described in Schedule B for the one-time fee in Schedule A. Before signature, the Provider will confirm the setup scope in writing following a scoping call, including any additional flat-fee line items for unusually large or complex historical data. The setup fee and any such line items stated in Schedule A are fixed: the Provider will not invoice the Nation for setup amounts beyond those stated in Schedule A.',
    '##6. Nation Obligations',
    "The Nation will: designate a primary administrative contact; provide source records reasonably required for migration in the condition described in Schedule B; ensure information it submits is, to its knowledge, accurate; use the Platform in compliance with applicable law, including privacy law applicable to the Nation's handling of member and tenant information; and pay Fees when due.",
    '##7. Fees and Payment',
    '###7.1 Fees',
    'The Nation will pay the subscription fees, one-time setup fee, and any selected add-on fees stated in Schedule A (the "Fees"). All amounts are in Canadian dollars and exclusive of applicable taxes, if any.',
    '###7.2 Billing',
    'Unless Schedule A states otherwise, subscription Fees are invoiced annually in advance, with billing aligned to the April-March fiscal year where the Nation requests it. Monthly billing, where selected, is charged at the monthly rate stated in Schedule A. Invoices are payable within thirty (30) days.',
    '###7.3 Setup discount',
    "Where the Nation signs a one-year term and pays the first year's subscription in advance, the one-time setup fee is reduced by fifty percent (50%), as reflected in Schedule A.",
    '###7.4 Fee changes',
    'Fees are fixed for the Initial Term. The Provider may adjust Fees effective at a Renewal Term by giving at least sixty (60) days\' written notice before renewal; the Nation may decline renewal in accordance with Section 8.',
    '###7.5 Late amounts',
    'Amounts more than thirty (30) days overdue may bear interest at 1% per month (12.68% annually). The Provider will not suspend the Nation\'s access for non-payment without first giving at least thirty (30) days\' written notice specifically referencing suspension, and will not delete Customer Data as a consequence of non-payment except in accordance with Section 4.6 following termination.',
    '##8. Term and Termination',
    '###8.1 Term',
    'This Agreement begins on the Effective Date and continues for the initial term stated in Schedule A (the "Initial Term"). It renews automatically for successive one-year terms (each a "Renewal Term") unless either party gives written notice of non-renewal at least sixty (60) days before the end of the then-current term.',
    '###8.2 Termination for cause',
    'Either party may terminate this Agreement if the other party materially breaches it and fails to cure the breach within thirty (30) days of written notice describing the breach.',
    '###8.3 Termination by the Nation for data-commitment breach',
    'Without limiting Section 8.2, a breach by the Provider of Section 3.1 (data location) or Section 4.3 (prohibited uses) is deemed material and, if not cured (where curable) within ten (10) days of notice, entitles the Nation to terminate immediately and receive a pro-rata refund of prepaid subscription Fees for the unused portion of the term.',
    '###8.4 Effect of termination',
    'Upon expiry or termination: the Nation\'s access ends (subject to the export period in Section 4.6); Fees accrued to the termination date remain payable; and Sections 4.5-4.10, 9, 11, 12, 13, 14 and 16 survive.',
    '###8.5 Business continuity',
    "If the Provider decides to permanently discontinue the Platform, the Provider will give the Nation at least ninety (90) days' written notice, will extend the export period in Section 4.6 to cover that notice period, and will provide reasonable transition assistance (data export, format documentation, and orderly handover) at the hourly rate in Schedule B. The Provider will maintain current documentation of the Platform's data formats sufficient for the Nation, or a successor provider acting for it, to make full use of exported Customer Data.",
    '##9. Confidentiality',
    "Each party will protect the other party's non-public information received under this Agreement with at least the care it uses for its own confidential information (and no less than reasonable care), will use it only to perform this Agreement, and will not disclose it except to personnel and advisors bound by confidentiality obligations, or as required by law with prompt notice to the other party where permitted. Customer Data is the Nation's confidential information. Pricing granted to the Nation under Schedule A is confidential to both parties; this Section does not restrict the Nation's internal governance processes (including Chief and Council review) or any disclosure required by the Nation's accountability obligations to its members or funders.",
    '##10. Intellectual Property',
    'The Provider owns the Platform and all related intellectual property, including improvements. No rights are granted to the Nation other than the subscription rights in Section 2. The Nation owns its Customer Data (Section 4.1) and its own names, marks and branding; the Nation grants the Provider a limited license to display them within the Nation\'s own workspace solely to provide the service. If the Nation provides suggestions or feedback, the Provider may use it to improve the Platform without obligation, provided doing so never incorporates Customer Data.',
    '##11. Warranties and Disclaimers',
    'The Provider warrants that: (a) it will provide the Platform with reasonable skill and care; (b) the Platform will materially conform to its documentation; and (c) it will not knowingly introduce malicious code. Except as stated in this Agreement, the Platform is provided "as is" and the Provider disclaims all other warranties, express or implied, including merchantability, fitness for a particular purpose and non-infringement, and does not warrant that the Platform will be uninterrupted or error-free. The Platform supports, but does not replace, the Nation\'s own decision-making; housing decisions (including allocations, approvals and financial decisions) remain the Nation\'s.',
    '##12. Indemnities',
    "The Provider will defend and indemnify the Nation against third-party claims alleging that the Platform, as provided by the Provider and used as permitted, infringes Canadian intellectual-property rights, and will pay resulting damages finally awarded or agreed in settlement. If such a claim arises, the Provider may procure the right to continue, modify the Platform to be non-infringing, or terminate the affected subscription with a pro-rata refund. The Nation will defend and indemnify the Provider against third-party claims arising from Customer Data content the Nation submits or the Nation's use of the Platform in violation of law, except to the extent caused by the Provider's breach of this Agreement.",
    '##13. Limitation of Liability',
    "Except for (i) a party's indemnity obligations under Section 12, (ii) the Provider's breach of Section 4.3 (prohibited uses of Customer Data), or (iii) either party's gross negligence or wilful misconduct: neither party is liable for indirect, incidental, special or consequential damages, or loss of profits or revenue; and each party's total aggregate liability under this Agreement is limited to the Fees paid or payable by the Nation in the twelve (12) months preceding the event giving rise to the claim. For breaches described in clause (ii), the Provider's aggregate liability cap is instead two (2) times such Fees.",
    '##14. Publicity',
    "Neither party will publicly name the other, or use the other's name, logo or marks in marketing, case studies, references or announcements, without the other party's prior written consent. For the Nation, such consent may only be given in accordance with the Nation's own governance processes.",
    '##15. Dispute Resolution and Governing Law',
    'The parties will first attempt in good faith to resolve any dispute through discussion between designated representatives for at least thirty (30) days. Failing resolution, the parties will attempt mediation with a mutually agreed mediator before commencing proceedings, except where urgent injunctive relief is required. This Agreement is governed by the laws of the Province of Ontario and the federal laws of Canada applicable in it, without prejudice to the Nation\'s inherent and treaty rights, which are not affected by this Agreement. The parties attorn to the non-exclusive jurisdiction of the courts of Ontario. [Note to counsel: jurisdiction, venue and any dispute-resolution preferences of the Nation - including arbitration or the Nation\'s own processes - should be settled per negotiation.]',
    '##16. General',
    '-Entire agreement. This Agreement (including its Schedules) is the entire agreement between the parties regarding its subject matter and supersedes prior discussions.',
    '-Amendment. Amendments must be in writing and signed by both parties.',
    '-Assignment. Neither party may assign this Agreement without the other\'s written consent, except the Provider may assign it to a corporation it forms to carry on the Home Land Homes business, or in connection with a merger or sale of that business, with written notice to the Nation; the Nation may terminate within sixty (60) days of such notice if the assignee is unacceptable to it, acting reasonably, with a pro-rata refund of prepaid Fees.',
    '-Subcontracting. The Provider may use the subprocessors and third-party systems listed in Schedule D to deliver the Platform and remains responsible for them. The Provider will give the Nation at least thirty (30) days\' written notice before adding or replacing a subprocessor that will process Customer Data; if the Nation reasonably objects on data-protection grounds and no resolution is found, the Nation may terminate the affected feature or this Agreement with a pro-rata refund of prepaid Fees.',
    '-Force majeure. Neither party is liable for delay or failure caused by events beyond its reasonable control, provided it uses reasonable efforts to mitigate.',
    '-Notices. Notices must be in writing and delivered to the contacts listed in Schedule A (email is sufficient, with confirmation of receipt for termination or breach notices).',
    '-Severability; waiver. Invalid provisions are severed without affecting the remainder; a waiver applies only to the instance given in writing.',
    '-Counterparts. This Agreement may be signed in counterparts, including electronically.',
    '##17. Execution',
    'IN WITNESS WHEREOF, the parties have executed this Agreement by their duly authorized representatives as of the Effective Date. Each signatory confirms that they are authorized to bind the party for which they sign. Where the Nation\'s governance processes require it, the Nation\'s signature may be supported by a Band Council Resolution referenced below.',
    '###FOR THE NATION: {{NATION}}',
    'Signature: ______________________________     Date: ____________________',
    'Name: ______________________________     Title: ____________________',
    'Band Council Resolution No. (if applicable): ____________________',
    '###FOR THE PROVIDER: Kevin Proctor, operating as Home Land Homes',
    'Signature: ______________________________     Date: ____________________',
    'Name: Kevin Proctor     Title: Founder, Home Land Homes',
    '{{PROVIDER_CONTACT}}',
    '##Schedule A - Order Form',
    'Select one tier and one billing option. Prices are in Canadian dollars and match the Provider\'s published schedule as of the Effective Date.',
    '###Subscription tiers',
    '-[ ] Small - up to 100 homes: $5,400/year ($450/mo) or $495/month; one-time setup $3,500.',
    '-[ ] Mid-size - 101-300 homes: $9,540/year ($795/mo) or $875/month; one-time setup $6,000.',
    '-[ ] Large - 301-600 homes: $15,000/year ($1,250/mo) or $1,375/month; one-time setup $9,500.',
    '-[ ] 600+ / Tribal Council - custom: annual per quote; monthly per quote; setup per quote.',
    '###Billing and options',
    'Billing option selected: [ ] Annual (invoiced annually in advance)     [ ] Monthly (+10% rate above)',
    'Setup discount: [ ] One-year term with first year prepaid - setup fee reduced 50% to $______ (Section 7.3)',
    'Optional add-on: [ ] AI Staff Assistant - $95/month. Acknowledgement and approval: by selecting this add-on, the Nation acknowledges and approves that each AI query (the staff question and the minimum related housing records needed to answer it) is processed in the United States by the Provider\'s AI subprocessor (Anthropic) as described in Schedule D; that this data is read-only for the query, is not retained for model training, and that the feature may be disabled by the Nation at any time in Platform settings. This selection is the Nation\'s written approval under Section 3.1. Initials: ____________',
    'Email delivery method (Schedule D): [ ] Nation\'s own Microsoft 365 tenant (requires the Nation\'s Microsoft administrator to grant application consent during setup)     [ ] Provider-managed transactional email service (Resend or SendGrid - United States; see Schedule D)',
    'Additional setup line items from scoping call (if any; flat fees - Section 5): ______________________________',
    '###Term and contacts',
    'Initial Term: [ ] One (1) year from the Effective Date     [ ] Other: ______________',
    'Included modules: applications & waitlist, unit inventory, tenants, matching, maintenance & work orders, renovations & RFQ tendering, contractor registry, inspections, capital projects, finance, Chief & Council dashboard, tenant/applicant portal.',
    'Nation\'s primary contact for notices: name ____________________ email ____________________',
    'Provider contact for notices: Kevin Proctor - hello@homelandhomes.ca',
    '##Schedule B - Setup Services (Scope)',
    '###Included in the setup fee',
    '-Provisioning of the Nation\'s dedicated workspace, database, subdomain and branding.',
    '-Configuration of roles, approval authorities and module settings with the Nation\'s administrator.',
    '-Email notification setup using the delivery method selected in Schedule A. Where the Nation\'s own Microsoft 365 tenant is selected, the Nation is responsible for having its Microsoft administrator grant the required application consent; if that consent is not obtained within thirty (30) days of the Effective Date, the parties will proceed with the transactional email service option (Schedule D) so go-live is not delayed.',
    '-Migration of the Nation\'s current unit, tenant and application/waitlist records from up to three (3) source files or systems supplied in reasonably usable condition (spreadsheets, exports, or organized paper records).',
    '-Migration method: where AI tools assist with data mapping, they are used on column structure and synthetic sample data only (Section 4.3); the Nation\'s actual records are transformed and loaded by the Provider directly onto the Nation\'s infrastructure in Canada and are never submitted to AI systems.',
    '-Live remote training: two (2) sessions (Small tier), four (4) sessions (Mid-size tier), or six (6) sessions (Large tier), each up to 90 minutes, recorded for the Nation\'s reuse.',
    '-Go-live support for sixty (60) days following the training period.',
    '###Not included (quoted as flat line items in Schedule A before signature, if requested)',
    '-Entry or cleanup of extensive historical/archival records beyond current state.',
    '-Migration from more than three source systems, or data requiring substantial cleanup or deduplication.',
    '-On-site (in-community) training and related travel.',
    'The Provider will not invoice setup amounts beyond those stated in Schedule A (Section 5). If source data turns out to be materially worse than represented, the parties will discuss scope in good faith, but any additional fee requires the Nation\'s written agreement.',
    '###Additional services and travel (hourly)',
    '-Work outside the included scope that the Nation requests in writing - for example extended data cleanup or entry of historical records, additional training sessions, custom reports, or consulting - is billed at $150 per hour, in fifteen (15) minute increments. The Provider will give a written estimate before starting, and will not exceed the estimate without the Nation\'s written approval.',
    '-Where the Nation requests on-site work, travel expenses (transportation, accommodation, meals and incidentals) are billed at the rates in the National Joint Council (NJC) Travel Directive in effect at the time of travel, at cost, with no markup.',
    '-Time spent in travel is billed at fifty percent (50%) of the hourly rate ($75 per hour), to a maximum of eight (8) hours of travel time per travel day.',
    '##Schedule C - Support and Service Levels',
    '###Support',
    '-Email support at hello@homelandhomes.ca, business hours 9:00-17:00 Eastern, Monday to Friday excluding statutory holidays.',
    '-Response service level: every support request receives a response within twenty-four (24) business hours of receipt (business hours as defined above; hours resume the next business day). Critical issues (Platform unavailable or data at risk) are prioritized ahead of all other requests.',
    '###Availability',
    '-Target availability of 99.5% per calendar month, excluding scheduled maintenance (announced at least 24 hours in advance and scheduled outside business hours where practicable) and force majeure.',
    '-If availability falls below target in two consecutive months, the Nation may request a service credit of 5% of that month\'s subscription fee per full percentage point below target, up to 25% of the monthly fee, as its exclusive remedy for availability shortfalls.',
    '###Data protection operations',
    '-Automated daily database backups retained for at least seven (7) days (Section 3.3).',
    '-Offline-capable field workflows: work entered on degraded connections is queued on-device and synchronized when connectivity returns.',
    '-Append-only audit logging of material actions, available to the Nation\'s authorized administrators within the Platform.',
    '##Schedule D - Third-Party Systems and Subprocessors',
    'The Provider uses the following third-party systems to deliver the Platform. Systems marked "core" are required for the service; systems marked "optional" process Customer Data only if the Nation enables the corresponding feature.',
    '###Supabase (core)',
    'Role: Database, authentication, file storage, serverless functions. Customer Data processed: all Customer Data in the Nation\'s dedicated database and storage. Data location: Canada (Canadian region project).',
    '###Cloudflare (core)',
    'Role: Web delivery, DNS, network security for the application. Customer Data processed: data in transit only; no persistent storage of Customer Data. Data location: global edge network (transit); no storage.',
    '###Email delivery (core) - one of the following, as recorded in Schedule A',
    'Role: outbound email notifications (e.g., application confirmations, work orders, tenant copies). Customer Data processed: names, email addresses, notification content and any attached documents (e.g., PDF copies) of outbound messages. Data location: (a) Nation\'s own Microsoft 365 tenant (Graph): per the Nation\'s Microsoft tenant region. (b) Transactional email service (Resend or SendGrid): United States (message content in transit and delivery logs).',
    '###Anthropic (optional - AI Assistant add-on)',
    'Role: processes staff questions for the AI Assistant. Customer Data processed: the staff question and the minimum related housing records needed to answer it; read-only; not used for model training. Data location: United States.',
    '###OpenStreetMap (core - mapping features)',
    'Role: map display for unit locations. Customer Data processed: unit coordinates only (no names or personal information). Data location: global (OpenStreetMap Foundation infrastructure).',
    'Email delivery depends on the Nation\'s setup, and the method used is recorded in Schedule A. Where the Nation operates Microsoft 365 and its Microsoft administrator grants the required application consent, notifications are sent from the Nation\'s own mailbox and message content remains within the Nation\'s Microsoft environment (option (a)). Where that is not available - including where the Provider is not granted administrator access to configure the Nation\'s Microsoft tenant - the Provider uses a transactional email service (option (b)), in which case message content transits, and delivery logs are held on, infrastructure located in the United States. In all cases, email by its nature leaves the Platform to reach recipients\' own mail systems. The parties may switch between email delivery options after the Effective Date by written agreement (email sufficient), and this Schedule is deemed updated accordingly.',
    'For clarity: the AI Assistant is a paid optional add-on that operates only where the Nation has selected and initialled it in Schedule A, which constitutes the Nation\'s acknowledgement and approval of the processing described above (Sections 3.1 and 4.3). Query data is processed outside Canada only for the duration of each query, is not retained for training, and the feature can be disabled by the Nation at any time in Platform settings, at which point no Customer Data flows to that subprocessor. Apart from outbound email delivered under option (b) above and the optional AI Assistant, no listed system stores Customer Data outside Canada. The Provider will keep this Schedule current under the subcontracting terms in Section 16.'
  ].join('\n');

  function _fmtDateLong(){
    // Admin panel runs in a browser; Date is available here (unlike workflow scripts).
    var d = new Date();
    var mo = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    return mo[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
  }

  function buildAgreementPdf(nationName, address){
    var jsPDF = window.jspdf.jsPDF;
    var doc = new jsPDF({ unit: 'pt', format: 'letter' });
    var M = 56, W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight();
    var maxW = W - M * 2, y = M;
    function ensure(h){ if (y + h > H - M - 20) { doc.addPage(); y = M; } }
    function block(text, o){
      o = o || {};
      doc.setFont('helvetica', o.style || 'normal');
      doc.setFontSize(o.size || 10);
      if (o.color) doc.setTextColor(o.color[0], o.color[1], o.color[2]); else doc.setTextColor(20, 20, 20);
      var indent = o.indent || 0;
      var lines = doc.splitTextToSize(text, maxW - indent);
      var lh = (o.size || 10) * 1.32;
      for (var i = 0; i < lines.length; i++){
        ensure(lh);
        if (o.align === 'center') doc.text(lines[i], W / 2, y, { align: 'center' });
        else doc.text(lines[i], M + indent, y);
        y += lh;
      }
      y += (o.after == null ? 6 : o.after);
    }
    var tpl = AGREEMENT_TPL
      .replace(/\{\{NATION\}\}/g, nationName)
      .replace(/\{\{ADDRESS\}\}/g, address || '______________________________')
      .replace(/\{\{DATE\}\}/g, _fmtDateLong())
      .replace(/\{\{PROVIDER_CONTACT\}\}/g, PROVIDER.name + ' - ' + PROVIDER.addr1 + ', ' + PROVIDER.addr2 + '   ·   ' + PROVIDER.phone + '   ·   ' + PROVIDER.email);
    tpl.split('\n').forEach(function(raw){
      var line = raw;
      if (line === '') { y += 4; return; }
      if (line.charAt(0) === '>') { // disclaimer
        y += 2; block(line.slice(1), { style: 'italic', size: 9, color: [140, 90, 0], after: 10 });
        ensure(1); doc.setDrawColor(220); doc.line(M, y - 4, W - M, y - 4); y += 6; return;
      }
      if (line.slice(0, 1) === '#' && line.slice(0, 2) !== '##') { block(line.slice(1), { style: 'bold', size: 16, align: 'center', after: 3 }); return; }
      if (line.charAt(0) === '%') { block(line.slice(1), { size: 11, align: 'center', color: [90, 90, 90], after: 12 }); return; }
      if (line.slice(0, 3) === '###') { ensure(30); block(line.slice(3), { style: 'bold', size: 10.5, after: 3 }); return; }
      if (line.slice(0, 2) === '##') {
        var htext = line.slice(2);
        if (htext.indexOf('Schedule ') === 0 || htext.indexOf('17. Execution') === 0) { doc.addPage(); y = M; }
        else { ensure(40); y += 6; }
        block(htext, { style: 'bold', size: 12.5, after: 5 });
        return;
      }
      if (line.charAt(0) === '-') { block('•  ' + line.slice(1), { size: 10, indent: 14, after: 5 }); return; }
      block(line, { size: 10 });
    });
    // Footer: brand + page x of y.
    var pages = doc.internal.getNumberOfPages();
    for (var p = 1; p <= pages; p++){
      doc.setPage(p);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(130, 130, 130);
      doc.text('Home Land Homes - Software Subscription Agreement', M, H - 26);
      doc.text('Page ' + p + ' of ' + pages, W - M, H - 26, { align: 'right' });
    }
    return doc;
  }

  // Persist the nation's mailing/office address to the registry row. The field
  // lives on the Agreement tab but had no save path before -- editing it (or
  // generating the agreement) never wrote it back, so it always reloaded blank.
  window.saveNationAgreementAddress = async function(id){
    var n = _nations.filter(function(x){ return String(x.id) === String(id); })[0];
    if (!n){ setMsg('cn-agr-msg', 'Nation not loaded.'); return; }
    var addr = ((document.getElementById('cn-agr-addr') || {}).value || '').trim();
    setMsg('cn-agr-msg', 'Saving...', 'ok');
    var r = await api('PATCH', '/nations?id=eq.' + encodeURIComponent(id),
      { office_address: addr || null, updated_at: new Date().toISOString() }, 'return=minimal');
    if (r.ok){
      n.office_address = addr;                       // keep the in-memory row in sync
      await audit('nation_address_saved', n.subdomain || String(id), addr || '(cleared)');
      setMsg('cn-agr-msg', 'Mailing address saved.', 'ok');
    } else {
      var t = await r.text();
      setMsg('cn-agr-msg', /office_address|column|schema cache/i.test(t)
        ? 'Save failed: the nations.office_address column is missing. Run supabase/platform/nation_office_address.sql on the platform project, then try again.'
        : ('Could not save the address: ' + t));
    }
  };

  window.generateNationAgreement = function(id){
    var n = _nations.filter(function(x){ return String(x.id) === String(id); })[0];
    if (!n){ setMsg('cn-agr-msg', 'Nation not loaded.'); return; }
    var name = ((document.getElementById('cn-agr-name') || {}).value || n.display_name || '').trim();
    var addr = ((document.getElementById('cn-agr-addr') || {}).value || '').trim();
    if (!name){ setMsg('cn-agr-msg', 'Enter the nation legal name.'); return; }
    setMsg('cn-agr-msg', 'Generating...', 'ok');
    ensureJsPdf(async function(){
      try {
        // Persist the address alongside generation so it isn't lost between
        // sessions (best-effort; a missing column must not block the PDF).
        if (addr !== (n.office_address || '')){
          try {
            var pr = await api('PATCH', '/nations?id=eq.' + encodeURIComponent(id),
              { office_address: addr || null, updated_at: new Date().toISOString() }, 'return=minimal');
            if (pr.ok) n.office_address = addr;
          } catch (_e){ /* keep generating even if the save fails */ }
        }
        var doc = buildAgreementPdf(name, addr);
        var safe = name.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '');
        var fname = 'Subscription-Agreement-' + safe + '.pdf';
        var blob = doc.output('blob');
        var viewUrl = URL.createObjectURL(blob);
        doc.save(fname);                                   // download for immediate use
        await uploadDoc(n.subdomain, new File([blob], fname, { type: 'application/pdf' }), 'agreement');
        setMsgWithView('cn-agr-msg', 'Generated and saved to the document library.', viewUrl);
        renderNationDocsCard(n.subdomain);
      } catch (e){ setMsg('cn-agr-msg', 'Could not generate: ' + String(e && e.message || e)); }
    }, function(){ setMsg('cn-agr-msg', 'Could not load the PDF generator (offline?).'); });
  };

  // ---- Document library (control-plane Storage) ------------------------------
  function docPath(sub, filename){
    var safe = String(filename).replace(/[^a-z0-9._-]+/gi, '_');
    // No Math.random/Date entropy needed for uniqueness beyond time; use a short
    // random token from crypto (available in-browser) to avoid collisions.
    var tok = (self.crypto && self.crypto.randomUUID) ? self.crypto.randomUUID().slice(0, 8) : String(performance.now()).replace('.', '');
    return sub + '/' + tok + '_' + safe;
  }
  async function uploadDoc(sub, file, kind){
    var path = docPath(sub, file.name);
    var up = await fetch(STORE + '/object/' + DOC_BUCKET + '/' + encodeURI(path), {
      method: 'POST',
      headers: { apikey: ANON, Authorization: 'Bearer ' + getAT(), 'Content-Type': file.type || 'application/octet-stream' },
      body: file
    });
    if (!up.ok) { var t = await up.text(); throw new Error('upload failed: ' + t.slice(0, 120)); }
    var r = await api('POST', '/nation_documents', {
      subdomain: sub, name: file.name, path: path, kind: kind || 'other',
      size_bytes: file.size || null, uploaded_by: jwtEmail()
    }, 'return=minimal');
    if (!r.ok) throw new Error('metadata write failed');
    await audit('nation_doc_added', sub, file.name);
  }
  async function _signedDocUrl(path){
    var r = await fetch(STORE + '/object/sign/' + DOC_BUCKET + '/' + encodeURI(path), {
      method: 'POST',
      headers: { apikey: ANON, Authorization: 'Bearer ' + getAT(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn: 3600 })
    });
    if (!r.ok) return null;
    var d = await r.json();
    return (d && d.signedURL) ? d.signedURL : null;
  }
  // View: open inline in a new tab (PDFs/images render in the browser).
  window.viewNationDoc = async function(path){
    var s = await _signedDocUrl(path);
    if (s) window.open(STORE + s, '_blank', 'noopener'); else dlgAlert('Could not open the document.');
  };
  // Download: force a save via the &download flag on the signed URL.
  window.downloadNationDoc = async function(path, name){
    var s = await _signedDocUrl(path);
    if (!s){ dlgAlert('Could not create a download link.'); return; }
    var sep = s.indexOf('?') >= 0 ? '&' : '?';
    window.open(STORE + s + sep + 'download=' + encodeURIComponent(name || ''), '_blank', 'noopener');
  };
  window.deleteNationDoc = async function(id, path, sub){
    if (!(await dlgConfirm('Delete this document? This cannot be undone.', { title: 'Delete document', okText: 'Delete' }))) return;
    await fetch(STORE + '/object/' + DOC_BUCKET + '/' + encodeURI(path), {
      method: 'DELETE', headers: { apikey: ANON, Authorization: 'Bearer ' + getAT() }
    }).catch(function(){});
    var r = await api('DELETE', '/nation_documents?id=eq.' + encodeURIComponent(id), null, 'return=minimal');
    if (r.ok){ await audit('nation_doc_deleted', sub, path); renderNationDocsCard(sub); }
  };
  function _docKindLabel(k){ return ({ agreement: 'Agreement', bcr: 'BCR', other: 'Other' })[k] || (k || 'Other'); }
  async function renderNationDocsCard(sub){
    var host = document.getElementById('cn-docs'); if (!host) return;
    var r = await api('GET', '/nation_documents?subdomain=eq.' + encodeURIComponent(sub) + '&order=uploaded_at.desc');
    var docs = r.ok ? await r.json().catch(function(){ return []; }) : [];
    if (!docs.length){ host.innerHTML = '<div class="empty">No documents yet.</div>'; return; }
    var rows = docs.map(function(d){
      var when = '';
      try { when = new Date(d.uploaded_at).toLocaleDateString(); } catch(e){}
      return '<tr>'
        + '<td><b>' + esc(d.name) + '</b></td>'
        + '<td style="font-size:11px;color:var(--muted);">' + esc(_docKindLabel(d.kind)) + '</td>'
        + '<td style="font-size:11px;color:var(--muted);">' + esc(when) + (d.uploaded_by ? ' &middot; ' + esc(d.uploaded_by) : '') + '</td>'
        + '<td><div class="row-actions">'
        +   '<button class="btn sm ghost" type="button" data-act="doc-view" data-path="' + esc(d.path) + '">View</button>'
        +   '<button class="btn sm ghost" type="button" data-act="doc-dl" data-path="' + esc(d.path) + '" data-name="' + esc(d.name) + '">Download</button>'
        +   '<button class="btn sm danger" type="button" data-act="doc-del" data-id="' + esc(d.id) + '" data-path="' + esc(d.path) + '" data-sub="' + esc(sub) + '">Delete</button>'
        + '</div></td></tr>';
    }).join('');
    host.innerHTML = '<table><thead><tr><th>Document</th><th>Type</th><th>Added</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>';
  }
  // Logo uploader for the NIC branding card: reads the chosen image into a data
  // URI kept in a hidden input, saved to nations.logo. Preview shows the current
  // logo; the app applies it as the nation's brand mark.
  function wireLogoUpload(){
    var input = document.getElementById('cn-logo-file');
    var hidden = document.getElementById('cn-logo');
    var preview = document.getElementById('cn-logo-preview');
    if (!preview) return;
    function paint(){ var v = (hidden && hidden.value) || ''; preview.style.backgroundImage = v ? 'url("' + v.replace(/"/g, '\\"') + '")' : ''; }
    paint();
    if (input) input.addEventListener('change', function(){
      var f = input.files && input.files[0]; if (!f) return;
      var reader = new FileReader();
      reader.onload = function(){ if (hidden) hidden.value = String(reader.result || ''); paint(); };
      reader.readAsDataURL(f);
    });
  }

  // Drag-and-drop + click-to-browse for the Documents uploader. Drag events
  // can't be delegated, so this is wired directly after Configure renders.
  function wireDocFileInput(){
    var input = document.getElementById('cn-doc-file');
    var dz = document.getElementById('cn-doc-drop');
    var nameEl = document.getElementById('cn-doc-name');
    if (!input || !dz) return;
    function hot(on){ dz.style.borderColor = on ? 'var(--accent)' : 'var(--hair)'; dz.style.background = on ? 'var(--accent-light)' : 'var(--bg)'; }
    async function handle(file){
      if (!file) return;
      var sub = input.getAttribute('data-sub');
      var kind = (document.getElementById('cn-doc-kind') || {}).value || 'other';
      if (nameEl) nameEl.textContent = file.name;
      setMsg('cn-doc-msg', 'Uploading ' + file.name + '...', 'ok');
      try { await uploadDoc(sub, file, kind); setMsg('cn-doc-msg', 'Uploaded.', 'ok'); if (nameEl) nameEl.textContent = ''; renderNationDocsCard(sub); }
      catch (e){ setMsg('cn-doc-msg', 'Upload failed: ' + String(e && e.message || e)); }
      input.value = '';
    }
    dz.addEventListener('click', function(){ input.click(); });
    input.addEventListener('change', function(){ handle(input.files && input.files[0]); });
    ['dragenter','dragover'].forEach(function(ev){ dz.addEventListener(ev, function(e){ e.preventDefault(); e.stopPropagation(); hot(true); }); });
    ['dragleave','dragend'].forEach(function(ev){ dz.addEventListener(ev, function(e){ e.preventDefault(); e.stopPropagation(); hot(false); }); });
    dz.addEventListener('drop', function(e){
      e.preventDefault(); e.stopPropagation(); hot(false);
      var files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) handle(files[0]);
    });
  }

  // ==========================================================================
  // Nation Information Card: summary, notes, invoices
  // ==========================================================================
  function _money(n, cur){ return (cur || 'CAD') === 'CAD' ? '$' + (Number(n) || 0).toFixed(2) : (Number(n) || 0).toFixed(2) + ' ' + cur; }
  function _sumLbl(t){ return '<div style="color:var(--muted);text-transform:uppercase;letter-spacing:.4px;font-size:10px;font-weight:700;">' + t + '</div>'; }

  async function loadNicSummary(sub){
    try {
      var u = await api('GET', '/nation_usage?subdomain=eq.' + encodeURIComponent(sub));
      var usg = (u.ok ? await u.json().catch(function(){ return []; }) : [])[0];
      var el = document.getElementById('cn-sum-usage');
      if (el){
        el.style.color = usg ? '' : 'var(--muted)';
        el.innerHTML = usg
          ? esc(fmtBytes(usg.database_bytes)) + ' db &middot; ' + esc(fmtBytes(usg.storage_bytes)) + ' files'
          : 'not reported';
      }
    } catch(e){}
    try {
      var iv = await api('GET', '/nation_invoices?subdomain=eq.' + encodeURIComponent(sub) + '&select=total,amount_paid,status');
      var ivr = iv.ok ? await iv.json().catch(function(){ return []; }) : [];
      var out = ivr.filter(_invOwing).reduce(function(a, x){ return a + _invBalance(x); }, 0);
      var iel = document.getElementById('cn-sum-inv');
      if (iel){ iel.style.color = ''; iel.innerHTML = _money(out); }
    } catch(e){}
  }

  // ---- Notes -----------------------------------------------------------------
  async function renderNationNotes(sub){
    var host = document.getElementById('cn-notes'); if (!host) return;
    var r = await api('GET', '/nation_notes?subdomain=eq.' + encodeURIComponent(sub) + '&order=created_at.desc');
    var notes = r.ok ? await r.json().catch(function(){ return []; }) : [];
    if (!notes.length){ host.innerHTML = '<div class="empty">No notes yet.</div>'; return; }
    host.innerHTML = notes.map(function(nt){
      var when = ''; try { when = new Date(nt.created_at).toLocaleString(); } catch(e){}
      return '<div style="padding:8px 0;border-bottom:1px solid var(--line);">'
        + '<div style="font-size:13px;white-space:pre-wrap;">' + esc(nt.body) + '</div>'
        + '<div style="font-size:11px;color:var(--muted);margin-top:3px;">' + esc(nt.author || '') + (when ? ' &middot; ' + esc(when) : '') + '</div>'
        + '</div>';
    }).join('');
  }
  // Push a nation's Anthropic API key to its project's ANTHROPIC_API_KEY secret
  // via the control-plane set-nation-secret function. The key never persists in
  // the control plane or the browser beyond this call.
  window.saveNationAiKey = async function(sub){
    var el = document.getElementById('cn-ai-key');
    var key = (el && el.value || '').trim();
    if (!key){ setMsg('cn-ai-msg', 'Enter a key first.'); return; }
    if (key.length < 8){ setMsg('cn-ai-msg', 'That does not look like a valid key.'); return; }
    setMsg('cn-ai-msg', 'Applying to project...', 'ok');
    try {
      var r = await fetch(PBASE + '/functions/v1/set-nation-secret', {
        method: 'POST',
        headers: { apikey: ANON, Authorization: 'Bearer ' + getAT(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ subdomain: sub, name: 'ANTHROPIC_API_KEY', value: key })
      });
      var d = await r.json().catch(function(){ return {}; });
      if (!r.ok){ setMsg('cn-ai-msg', (d && d.error) ? ('Failed: ' + d.error + (d.detail ? ' (' + d.detail + ')' : '')) : ('Failed: HTTP ' + r.status)); return; }
      if (el) el.value = '';
      setMsg('cn-ai-msg', 'Key applied to the project (...' + esc(d.last4 || '') + '). AI chat will use it on the next request.', 'ok');
      await audit('nation_ai_key_set', sub, '...' + (d.last4 || ''));
    } catch (e){ setMsg('cn-ai-msg', 'Network error: ' + String(e).slice(0, 120)); }
  };

  // Email tab -> "Apply to project": write EMAIL_PROVIDER + From identity (and
  // the provider API key, when entered) onto the nation project's Edge Function
  // secrets through set-nation-secret's batch mode. Mirrors saveNationAiKey.
  window.applyNationEmailSecrets = async function(sub){
    var get = function(x){ return ((document.getElementById(x) || {}).value || '').trim(); };
    var provider = get('cn-em-provider') || 'graph';
    var from     = get('cn-em-from');
    var fromName = get('cn-em-from-name');
    var replyTo  = get('cn-em-reply');
    var key      = get('cn-em-key');
    var secrets = [{ name: 'EMAIL_PROVIDER', value: provider }];
    if (from)     secrets.push({ name: 'EMAIL_FROM',      value: from });
    if (fromName) secrets.push({ name: 'EMAIL_FROM_NAME', value: fromName });
    if (replyTo)  secrets.push({ name: 'EMAIL_REPLY_TO',  value: replyTo });
    if (key){
      if (provider === 'resend')        secrets.push({ name: 'RESEND_API_KEY',   value: key });
      else if (provider === 'sendgrid') secrets.push({ name: 'SENDGRID_API_KEY', value: key });
      else { setMsg('cn-em-msg', 'Graph does not use an API key here - clear the key field (GRAPH_* secrets are set in the Supabase dashboard).'); return; }
    }
    if ((provider === 'resend' || provider === 'sendgrid') && !from){
      setMsg('cn-em-msg', 'Enter a From address above first - ' + provider + ' needs EMAIL_FROM on a verified domain.'); return;
    }
    setMsg('cn-em-msg', 'Applying to project...', 'ok');
    try {
      var r = await fetch(PBASE + '/functions/v1/set-nation-secret', {
        method: 'POST',
        headers: { apikey: ANON, Authorization: 'Bearer ' + getAT(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ subdomain: sub, secrets: secrets })
      });
      var d = await r.json().catch(function(){ return {}; });
      if (!r.ok){ setMsg('cn-em-msg', (d && d.error) ? ('Failed: ' + d.error + (d.name ? ' (' + d.name + ')' : '') + (d.detail ? ' - ' + String(d.detail).slice(0,160) : '')) : ('Failed: HTTP ' + r.status)); return; }
      var kEl = document.getElementById('cn-em-key'); if (kEl) kEl.value = '';
      setMsg('cn-em-msg', 'Applied to the project: ' + (d.applied || []).join(', ') + '. Functions pick this up within about a minute.'
        + (key ? '' : ' (No API key entered - any existing key on the project is unchanged.)'), 'ok');
      await audit('nation_email_secrets_set', sub, (d.applied || []).join(', '));
    } catch (e){ setMsg('cn-em-msg', 'Network error: ' + String(e).slice(0, 120)); }
  };

  window.addNationNote = async function(sub){
    var ta = document.getElementById('cn-note-body');
    var body = (ta && ta.value || '').trim();
    if (!body){ setMsg('cn-note-msg', 'Enter a note first.'); return; }
    var r = await api('POST', '/nation_notes', { subdomain: sub, body: body, author: jwtEmail() }, 'return=minimal');
    if (r.ok){ if (ta) ta.value = ''; setMsg('cn-note-msg', 'Note added.', 'ok'); await audit('nation_note_added', sub, ''); renderNationNotes(sub); }
    else { setMsg('cn-note-msg', 'Could not save the note.'); }
  };

  // ---- Invoices --------------------------------------------------------------
  var INV_STATUS = { draft: ['Draft', 'provisioning'], sent: ['Sent', 'provisioning'], partial: ['Partially paid', 'provisioning'], paid: ['Paid', 'active'], void: ['Void', 'suspended'], carried: ['Carried forward', 'active'] };
  // Outstanding balance on an invoice = total minus what's been received.
  function _invBalance(x){ return Math.round(((Number(x.total) || 0) - (Number(x.amount_paid) || 0)) * 100) / 100; }
  // Statuses that still owe money (feed the Outstanding KPI + carry-forward).
  function _invOwing(x){ return (x.status === 'draft' || x.status === 'sent' || x.status === 'partial') && _invBalance(x) > 0.005; }
  window.invAddLine = function(prefill){
    var host = document.getElementById('cn-inv-lines'); if (!host) return;
    prefill = prefill || {};
    var desc  = esc(prefill.d || '');
    var qty   = (prefill.q != null ? prefill.q : 1);
    var price = (prefill.p != null && prefill.p !== '' ? prefill.p : '');
    var row = document.createElement('div');
    row.className = 'inv-line';
    row.style.cssText = 'display:grid;grid-template-columns:1fr 64px 88px 30px;gap:6px;margin-bottom:6px;align-items:center;';
    row.innerHTML =
        '<input class="inv-desc" placeholder="Description" value="' + desc + '" style="font-size:14px;padding:8px 10px;"/>'
      + '<input class="inv-qty" type="number" step="0.01" value="' + qty + '" title="Quantity" style="font-size:14px;padding:8px 10px;"/>'
      + '<input class="inv-price" type="number" step="0.01" value="' + price + '" placeholder="Unit $" title="Unit price" style="font-size:14px;padding:8px 10px;"/>'
      + '<button class="btn sm danger" type="button" data-act="inv-del-line" title="Remove line" style="padding:6px 0;">&times;</button>';
    host.appendChild(row);
  };
  // Add the selected fee-schedule item as a prefilled invoice line.
  window.invAddCatalogLine = function(){
    var sel = document.getElementById('cn-inv-catalog'); if (!sel) return;
    var it = FEE_SCHEDULE[parseInt(sel.value, 10)]; if (!it) return;
    window.invAddLine({ d: it.d, q: (it.q != null ? it.q : 1), p: it.custom ? '' : it.p });
  };
  // Band finder: residential homes -> published band (admin-pricing.js), and
  // preselect that band's annual line in the catalog. Display only -- it never
  // touches an existing schedule or invoice.
  window.invFindBand = function(){
    var P = window.HLH_PRICING;
    var raw = (document.getElementById('cn-inv-homes') || {}).value;
    var b = P.bandForHomes(raw === '' ? NaN : raw);
    if (!b){ setMsg('cn-inv-band', 'Enter a whole number of residential homes (1 or more).'); return; }
    var sel = document.getElementById('cn-inv-catalog'), idx = -1;
    FEE_SCHEDULE.forEach(function(it, i){
      if (idx !== -1 || it.legacy) return;
      if (b.custom ? /^Subscription — 600\+/.test(it.d) : (it.band === b.key && /annual$/.test(it.d))) idx = i;
    });
    if (sel && idx !== -1) sel.value = String(idx);
    if (b.custom){ setMsg('cn-inv-band', 'xl (600+ homes): no published price — quote it manually (Tribal Council / group pricing).', 'ok'); return; }
    var g = P.GROUPS[b.group];
    setMsg('cn-inv-band', b.key + ' (' + b.min + '-' + b.max + ' homes, ' + g.label + ' group): '
      + P.money(b.annual) + '/yr annual billing or ' + P.money(b.monthly) + '/mo monthly billing; setup '
      + P.money(g.setup) + '; AI add-on ' + P.money(g.ai) + '/mo.', 'ok');
  };
  // Discount helper: percent-of-base or fixed dollars, clamped to [0, base].
  // Returns the rounded dollar amount taken off. Used by manual invoices, the
  // interest recompute, and recurring-billing generation so the three paths
  // can never disagree on the math.
  function _calcDiscount(base, type, value){
    if ((type !== 'percent' && type !== 'fixed') || !(value > 0)) return 0;
    var d = (type === 'percent') ? base * value / 100 : value;
    return Math.round(Math.min(d, Math.max(base, 0)) * 100) / 100;
  }
  // Carried-forward lines are already-tax-inclusive prior balances: the
  // recurring-billing rule (recurring-invoices edge fn) never discounts or
  // re-taxes them, and the admin paths below must agree. Both writers stamp
  // this exact description prefix.
  function _isCarriedLine(l){ return /^Balance carried forward/i.test(String((l && l.description) || '')); }
  function _carriedSubtotal(lines){
    return Math.round((lines || []).filter(_isCarriedLine)
      .reduce(function(a, l){ return a + (Number(l.qty) || 0) * (Number(l.unit_price) || 0); }, 0) * 100) / 100;
  }
  function _collectInvLines(){
    var out = [];
    Array.prototype.forEach.call(document.querySelectorAll('#cn-inv-lines .inv-line'), function(row){
      var desc = (row.querySelector('.inv-desc') || {}).value || '';
      var qty  = parseFloat((row.querySelector('.inv-qty') || {}).value || '0') || 0;
      var price = parseFloat((row.querySelector('.inv-price') || {}).value || '0') || 0;
      if (desc.trim() && (qty || price)) out.push({ description: desc.trim(), qty: qty, unit_price: price });
    });
    return out;
  }
  async function nextInvoiceNumber(){
    var year = new Date().getFullYear();
    var r = await api('GET', '/nation_invoices?select=number');
    var rows = r.ok ? await r.json().catch(function(){ return []; }) : [];
    var re = new RegExp('^HLH-' + year + '-(\\d+)$'), max = 0;
    rows.forEach(function(x){ var m = re.exec(String(x.number || '')); if (m){ var nn = parseInt(m[1], 10); if (nn > max) max = nn; } });
    return 'HLH-' + year + '-' + String(max + 1).padStart(2, '0');
  }
  async function renderNationInvoices(sub){
    var host = document.getElementById('cn-invoices'); if (!host) return;
    var r = await api('GET', '/nation_invoices?subdomain=eq.' + encodeURIComponent(sub) + '&order=issue_date.desc');
    var inv = r.ok ? await r.json().catch(function(){ return []; }) : [];
    // Stash for on-demand PDF view + carry-forward. Clearing any pending
    // carry-forward intent here means a re-render (nation switch / tab reopen)
    // can't leak it onto an unrelated invoice; the create flow runs before any
    // re-render, so the normal carry->create path is unaffected.
    window._nicInvoices = inv;
    window._nicCarryIds = null;
    if (!inv.length){ host.innerHTML = '<div class="empty">No invoices yet.</div>'; }
    else {
      var rows = inv.map(function(x){
        var bal = _invBalance(x);
        var paidAmt = Number(x.amount_paid) || 0;
        // Show "Partially paid" for a sent invoice with some (but not full) payment.
        var effStatus = (x.status === 'sent' && paidAmt > 0.005 && bal > 0.005) ? 'partial' : x.status;
        var st = INV_STATUS[effStatus] || ['?', 'provisioning'];
        var acts = '';
        if (x.status === 'draft') acts += '<button class="btn sm ghost" type="button" data-act="inv-status" data-id="' + esc(x.id) + '" data-status="sent" data-sub="' + esc(sub) + '">Mark sent</button>';
        if (_invOwing(x)) acts += '<button class="btn sm ghost" type="button" data-act="inv-pay" data-id="' + esc(x.id) + '" data-sub="' + esc(sub) + '">Record payment</button>';
        if (x.status === 'sent' || x.status === 'partial' || x.status === 'paid') acts += '<button class="btn sm ghost" type="button" data-act="inv-interest" data-id="' + esc(x.id) + '" data-sub="' + esc(sub) + '" title="Add past-due interest (1%/month)">+ Interest</button>';
        if (x.status !== 'void' && x.status !== 'paid' && x.status !== 'carried') acts += '<button class="btn sm danger" type="button" data-act="inv-status" data-id="' + esc(x.id) + '" data-status="void" data-sub="' + esc(sub) + '">Void</button>';
        var meta = [];
        if (x.due_date)  meta.push('due ' + esc(x.due_date));
        if (Number(x.discount) > 0.005) meta.push('discount -' + _money(x.discount));
        if (paidAmt > 0.005 && bal > 0.005) meta.push('paid ' + _money(paidAmt) + ' of ' + _money(x.total));
        if (x.paid_date) meta.push((bal > 0.005 ? 'last pmt ' : 'paid ') + esc(x.paid_date));
        if (bal > 0.005 && (x.status === 'sent' || x.status === 'partial')) meta.push('<b style="color:var(--danger);">balance ' + _money(bal) + '</b>');
        return '<tr>'
          + '<td><button class="btn sm ghost" type="button" data-act="inv-view" data-id="' + esc(x.id) + '" data-sub="' + esc(sub) + '" title="View invoice PDF" style="margin:0;padding:2px 6px;font-weight:700;text-decoration:underline;">' + esc(x.number) + '</button></td>'
          + '<td style="font-size:11px;color:var(--muted);">' + esc(x.issue_date || '') + '</td>'
          + '<td style="font-variant-numeric:tabular-nums;">' + _money(x.total, x.currency) + '</td>'
          + '<td><span class="pill ' + st[1] + '">' + st[0] + '</span>' + (meta.length ? '<div style="font-size:10px;color:var(--muted);margin-top:2px;">' + meta.join(' · ') + '</div>' : '') + '</td>'
          + '<td><div class="row-actions">' + acts + '</div></td></tr>';
      }).join('');
      host.innerHTML = '<table><thead><tr><th>Invoice</th><th>Issued</th><th>Total</th><th>Status</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>';
    }
    // Carry-forward banner in the New invoice area: total unpaid balance across
    // all owing invoices, one click to add it as a line on the next invoice.
    var cf = document.getElementById('cn-inv-carry');
    if (cf){
      var owing = inv.filter(_invOwing);
      var total = Math.round(owing.reduce(function(a, x){ return a + _invBalance(x); }, 0) * 100) / 100;
      if (owing.length){
        cf.style.display = '';
        cf.innerHTML = '<div style="font-size:12px;color:var(--ink);">Outstanding from ' + owing.length + ' invoice' + (owing.length > 1 ? 's' : '')
          + ': <b>' + _money(total) + '</b> (' + owing.map(function(x){ return esc(x.number); }).join(', ') + ')</div>'
          + '<button class="btn sm ghost" type="button" data-act="inv-carry" data-sub="' + esc(sub) + '" style="margin:6px 0 0;">+ Carry forward ' + _money(total) + ' onto this invoice</button>';
      } else { cf.style.display = 'none'; cf.innerHTML = ''; }
    }
  }
  window.setInvoiceStatus = async function(id, status, sub){
    if (status === 'void' && !(await dlgConfirm('Void this invoice? This cannot be undone.', { title: 'Void invoice', okText: 'Void invoice' }))) return;
    var r = await api('PATCH', '/nation_invoices?id=eq.' + encodeURIComponent(id), { status: status, updated_at: new Date().toISOString() }, 'return=minimal');
    if (r.ok){ await audit('nation_invoice_' + status, sub, id); renderNationInvoices(sub); loadNicSummary(sub); }
  };
  // Re-generate this invoice's PDF from its CURRENT stored data (so interest
  // lines, carried balances, etc. are included) and open it in a new tab.
  window.viewNationInvoice = function(id, sub){
    var inv = (window._nicInvoices || []).filter(function(x){ return String(x.id) === String(id); })[0];
    if (!inv){ dlgAlert('Invoice not loaded — reopen the Invoices tab and try again.'); return; }
    var n = _nations.filter(function(x){ return x.subdomain === sub; })[0];
    ensureJsPdf(function(){
      try {
        var doc = buildInvoicePdf(n, inv);
        var url = URL.createObjectURL(doc.output('blob'));
        window.open(url, '_blank', 'noopener');
      } catch (e){ dlgAlert('Could not open the invoice: ' + String(e && e.message || e)); }
    }, function(){ dlgAlert('Could not load the PDF generator (offline?).'); });
  };
  // Record a (full or partial) payment: accrue amount_paid, stamp the last
  // payment date, and settle the invoice once the balance reaches zero.
  window.invRecordPayment = async function(id, sub){
    var g = await api('GET', '/nation_invoices?id=eq.' + encodeURIComponent(id));
    var inv = (g.ok ? await g.json().catch(function(){ return []; }) : [])[0];
    if (!inv){ dlgAlert('Invoice not found.'); return; }
    var bal = _invBalance(inv);
    // Amount + date captured together; the date defaults to today but can be
    // back-dated when a payment is entered after the fact.
    var res = await dlgForm('Record payment', [
      { key: 'amount', label: 'Amount received (CAD)', inputType: 'number', step: '0.01', defaultValue: bal.toFixed(2),
        validate: function(v){ var f = parseFloat(v); if (isNaN(f) || f <= 0) return 'Enter an amount greater than zero.'; if (f > bal + 0.005) return 'Amount exceeds the outstanding balance (' + _money(bal) + ').'; return ''; } },
      { key: 'date', label: 'Payment received date', inputType: 'date', defaultValue: _dPlus(0),
        validate: function(v){ return /^\d{4}-\d{2}-\d{2}$/.test(v) ? '' : 'Pick the date the payment was received.'; } }
    ], { message: 'Invoice ' + inv.number + ' — total ' + _money(inv.total) + ', balance ' + _money(bal) + '.', okText: 'Record payment' });
    if (res === null) return;
    var amt = res.amount, d = res.date;
    var paid = Math.round(((Number(inv.amount_paid) || 0) + parseFloat(amt)) * 100) / 100;
    var newBal = Math.round(((Number(inv.total) || 0) - paid) * 100) / 100;
    var status = newBal <= 0.005 ? 'paid' : 'sent';
    var r = await api('PATCH', '/nation_invoices?id=eq.' + encodeURIComponent(id), { amount_paid: paid, paid_date: d, status: status, updated_at: new Date().toISOString() }, 'return=minimal');
    if (r.ok){
      await audit('nation_invoice_payment', sub, inv.number + ': ' + _money(parseFloat(amt)) + ' on ' + d + ' (bal ' + _money(newBal) + ')');
      renderNationInvoices(sub); loadNicSummary(sub);
      if (newBal > 0.005) dlgAlert('Payment of ' + _money(parseFloat(amt)) + ' recorded. Remaining balance: ' + _money(newBal) + '.', { title: 'Payment recorded' });
    }
    else { dlgAlert('Could not record the payment.'); }
  };
  // Carry every owing invoice's balance forward as a single line on the next
  // invoice, and mark the source invoices "carried forward" so the balance
  // isn't double-counted. Uses the loaded invoice list.
  window.invCarryForward = async function(sub){
    var owing = (window._nicInvoices || []).filter(_invOwing);
    if (!owing.length){ setMsg('cn-inv-msg', 'No outstanding balances to carry forward.', 'ok'); return; }
    var total = Math.round(owing.reduce(function(a, x){ return a + _invBalance(x); }, 0) * 100) / 100;
    var refs = owing.map(function(x){ return x.number; }).join(', ');
    if (!(await dlgConfirm('Carry ' + _money(total) + ' forward from ' + refs + ' onto this new invoice?\n\nThose invoice(s) will be marked "Carried forward" so the balance is only billed once.', { title: 'Carry forward balance', okText: 'Add line' }))) return;
    window.invAddLine({ d: 'Balance carried forward (' + refs + ')', q: 1, p: total });
    window._nicCarryIds = owing.map(function(x){ return x.id; });
    setMsg('cn-inv-msg', 'Carried ' + _money(total) + ' forward as a line. It will be billed when you create this invoice.', 'ok');
  };
  // Generate a past-due interest charge (Section 7.5: 1%/month) and add it as a
  // line item. Interest is assessed as of the payment date if recorded, else
  // today. Applies only when more than 30 days past the due date. Idempotent:
  // any prior interest line is recomputed, not stacked.
  window.invAddInterest = async function(id, sub){
    var r = await api('GET', '/nation_invoices?id=eq.' + encodeURIComponent(id));
    var inv = (r.ok ? await r.json().catch(function(){ return []; }) : [])[0];
    if (!inv){ dlgAlert('Invoice not found.'); return; }
    if (!inv.due_date){ dlgAlert('This invoice has no due date, so overdue interest cannot be computed. Set a due date first.'); return; }
    var asOf = inv.paid_date || _dPlus(0);
    var days = Math.floor((Date.parse(asOf) - Date.parse(inv.due_date)) / 86400000);
    if (days <= 30){
      dlgAlert('As of ' + asOf + ', this invoice is ' + (days < 0 ? Math.abs(days) + ' day(s) before the due date' : days + ' day(s) past due') + '. Per Section 7.5, interest applies only to amounts more than 30 days overdue.', { title: 'No interest added' });
      return;
    }
    // Base = existing non-interest lines; interest accrues on the pre-tax,
    // post-discount amount (the discount is what the nation actually owed).
    var base = (inv.line_items || []).filter(function(l){ return !l.interest; });
    var baseSubtotal = Math.round(base.reduce(function(a, l){ return a + (Number(l.qty) || 0) * (Number(l.unit_price) || 0); }, 0) * 100) / 100;
    // Discount anchors to the PERIOD FEE only — never the carried-forward
    // balance (same rule as the recurring-invoices generator; recomputing it
    // over the carried line silently inflated the stored discount).
    var carriedSub = _carriedSubtotal(base);
    var feeSub = Math.round((baseSubtotal - carriedSub) * 100) / 100;
    var discount = _calcDiscount(feeSub, inv.discount_type, Number(inv.discount_value) || 0);
    var principal = Math.round((baseSubtotal - discount) * 100) / 100;
    var months = days / 30;
    var interest = Math.round(principal * INTEREST_MONTHLY * months * 100) / 100;
    if (interest <= 0){ dlgAlert('Computed interest is $0.00 — nothing to add.'); return; }
    if (!(await dlgConfirm('Invoice ' + inv.number + ' is ' + days + ' days past the due date (' + inv.due_date + '), assessed as of ' + asOf + '.\n\nInterest at 1%/month (12.68%/yr) on ' + _money(principal) + ' = ' + _money(interest) + '.\n\nAdd this as a line item?', { title: 'Add past-due interest', okText: 'Add interest' }))) return;
    var line = { description: 'Interest — ' + days + ' days past due at 1%/month (Section 7.5), assessed ' + asOf, qty: 1, unit_price: interest, interest: true };
    var lines = base.concat([line]);
    var subtotal = Math.round(lines.reduce(function(a, l){ return a + (Number(l.qty) || 0) * (Number(l.unit_price) || 0); }, 0) * 100) / 100;
    var taxRate = Number(inv.tax_rate) || 0;
    // Tax on the discounted fee + interest only — the carried balance is
    // already tax-inclusive and must never be re-taxed.
    var taxable = Math.round((subtotal - carriedSub - discount) * 100) / 100;
    var tax = Math.round(taxable * taxRate) / 100;
    var total = Math.round((subtotal - discount + tax) * 100) / 100;
    var _patch = { line_items: lines, subtotal: subtotal, tax: tax, total: total, updated_at: new Date().toISOString() };
    if (discount > 0) _patch.discount = discount;
    var pr = await api('PATCH', '/nation_invoices?id=eq.' + encodeURIComponent(id), _patch, 'return=minimal');
    if (pr.ok){
      await audit('nation_invoice_interest', sub, inv.number + ': ' + _money(interest) + ' (' + days + 'd)');
      renderNationInvoices(sub); loadNicSummary(sub);
      dlgAlert('Interest of ' + _money(interest) + ' added to ' + inv.number + '. New total: ' + _money(total) + '. Click the invoice number to view the updated PDF.', { title: 'Interest added' });
    }
    else { dlgAlert('Could not add the interest line.'); }
  };
  window.createNationInvoice = function(sub, id){
    var n = _nations.filter(function(x){ return String(x.id) === String(id); })[0];
    var lines = _collectInvLines();
    if (!lines.length){ setMsg('cn-inv-msg', 'Add at least one line with a description and amount.'); return; }
    var taxRate = parseFloat((document.getElementById('cn-inv-tax') || {}).value || '0') || 0;
    var due = (document.getElementById('cn-inv-due') || {}).value || _dPlus(30);
    var inotes = (document.getElementById('cn-inv-notes') || {}).value || '';
    var discType  = ((document.getElementById('cn-inv-disc-type') || {}).value || '') || null;
    var discValue = parseFloat((document.getElementById('cn-inv-disc-value') || {}).value || '0') || 0;
    var discLabel = ((document.getElementById('cn-inv-disc-label') || {}).value || '').trim();
    if (discType === 'percent' && discValue > 100){ setMsg('cn-inv-msg', 'Percent discount cannot exceed 100%.'); return; }
    var subtotal = Math.round(lines.reduce(function(a, l){ return a + (l.qty * l.unit_price); }, 0) * 100) / 100;
    // Discount + tax come off the CURRENT charges only. A carried-forward
    // balance (added via "+ Carry forward") is an already-tax-inclusive prior
    // total — discounting or re-taxing it double-counts (recurring-billing rule).
    var carriedSub2 = _carriedSubtotal(lines);
    var feeSub2 = Math.round((subtotal - carriedSub2) * 100) / 100;
    var discount = _calcDiscount(feeSub2, discType, discValue);
    var taxable = Math.round((feeSub2 - discount) * 100) / 100;
    var tax = Math.round(taxable * taxRate) / 100;
    var total = Math.round((subtotal - discount + tax) * 100) / 100;
    setMsg('cn-inv-msg', 'Creating...', 'ok');
    ensureJsPdf(async function(){
      try {
        var number = await nextInvoiceNumber();
        var today = new Date().toISOString().slice(0, 10);
        var inv = { subdomain: sub, number: number, issue_date: today, due_date: due, currency: 'CAD',
                    line_items: lines, subtotal: subtotal, tax_rate: taxRate, tax: tax, total: total,
                    amount_paid: 0, status: 'draft', notes: inotes, created_by: jwtEmail() };
        // Discount columns are only sent when one applies, so invoice creation
        // keeps working on a platform DB that predates nation_invoice_discounts.sql.
        if (discount > 0){ inv.discount_type = discType; inv.discount_value = discValue; inv.discount = discount; inv.discount_label = discLabel || null; }
        var r = await api('POST', '/nation_invoices', inv, 'return=minimal');
        if (!r.ok){ var t = await r.text(); setMsg('cn-inv-msg', /duplicate|unique/i.test(t) ? 'Number collision, try again.' : 'Could not save invoice.'); return; }
        // Settle any invoices whose balance was carried onto this one, so the
        // outstanding amount isn't billed twice.
        var carried = window._nicCarryIds || [];
        for (var ci = 0; ci < carried.length; ci++){
          try { await api('PATCH', '/nation_invoices?id=eq.' + encodeURIComponent(carried[ci]), { status: 'carried', notes: ('Carried forward into ' + number), updated_at: new Date().toISOString() }, 'return=minimal'); } catch(e){}
        }
        if (carried.length) await audit('nation_invoice_carried', sub, carried.length + ' invoice(s) -> ' + number);
        window._nicCarryIds = null;
        var doc = buildInvoicePdf(n, inv);
        var fname = number + '.pdf';
        var blob = doc.output('blob');
        var viewUrl = URL.createObjectURL(blob);
        doc.save(fname);
        try { await uploadDoc(sub, new File([blob], fname, { type: 'application/pdf' }), 'invoice'); } catch(e){}
        await audit('nation_invoice_created', sub, number);
        setMsgWithView('cn-inv-msg', 'Invoice ' + number + ' created and filed in Documents.', viewUrl);
        document.getElementById('cn-inv-lines').innerHTML = ''; invAddLine();
        var tn = document.getElementById('cn-inv-notes'); if (tn) tn.value = '';
        var dt = document.getElementById('cn-inv-disc-type');  if (dt) dt.value = '';
        var dv = document.getElementById('cn-inv-disc-value'); if (dv) dv.value = '';
        var dl2 = document.getElementById('cn-inv-disc-label'); if (dl2) dl2.value = '';
        renderNationInvoices(sub); renderNationDocsCard(sub); loadNicSummary(sub);
      } catch (e){ setMsg('cn-inv-msg', 'Could not create: ' + String(e && e.message || e)); }
    }, function(){ setMsg('cn-inv-msg', 'Could not load the PDF generator (offline?).'); });
  };

  function buildInvoicePdf(nation, inv){
    var jsPDF = window.jspdf.jsPDF;
    var doc = new jsPDF({ unit: 'pt', format: 'letter' });
    var M = 56, W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), y = M;
    function t(s, x, yy, o){ o = o || {}; doc.setFont('helvetica', o.style || 'normal'); doc.setFontSize(o.size || 10); if (o.color) doc.setTextColor(o.color[0], o.color[1], o.color[2]); else doc.setTextColor(20, 20, 20); doc.text(String(s), x, yy, o.align ? { align: o.align } : undefined); }
    // Header
    t('Home Land Homes', M, y, { style: 'bold', size: 16 });
    t('INVOICE', W - M, y, { style: 'bold', size: 18, align: 'right', color: [120, 120, 120] });
    y += 16; t('Housing Management Platform', M, y, { size: 10, color: [110, 110, 110] });
    t(inv.number, W - M, y, { size: 11, align: 'right' });
    y += 13; t(PROVIDER.addr1 + ', ' + PROVIDER.addr2, M, y, { size: 9, color: [110, 110, 110] });
    y += 12; t(PROVIDER.phone + '   ·   ' + PROVIDER.email, M, y, { size: 9, color: [110, 110, 110] });
    y += 20; doc.setDrawColor(220); doc.line(M, y, W - M, y); y += 20;
    // Bill to + meta
    t('BILL TO', M, y, { style: 'bold', size: 9, color: [120, 120, 120] });
    t('DETAILS', W - 200, y, { style: 'bold', size: 9, color: [120, 120, 120] });
    y += 14;
    t(nation ? nation.display_name : '', M, y, { style: 'bold', size: 11 });
    t('Issue date: ' + (inv.issue_date || ''), W - 200, y, { size: 10 });
    y += 14;
    if (nation && nation.subdomain) t(nation.subdomain + '.fnhub.app', M, y, { size: 10, color: [110, 110, 110] });
    if (inv.due_date) { t('Due date:  ' + inv.due_date, W - 200, y, { size: 10 }); }
    y += 26;
    // Table header
    var cX = M, cQty = W - M - 190, cUnit = W - M - 110, cAmt = W - M;
    doc.setFillColor(245, 245, 242); doc.rect(M - 6, y - 12, W - M * 2 + 12, 22, 'F');
    t('Description', cX, y, { style: 'bold', size: 9, color: [90, 90, 90] });
    t('Qty', cQty, y, { style: 'bold', size: 9, align: 'right', color: [90, 90, 90] });
    t('Unit', cUnit, y, { style: 'bold', size: 9, align: 'right', color: [90, 90, 90] });
    t('Amount', cAmt, y, { style: 'bold', size: 9, align: 'right', color: [90, 90, 90] });
    y += 20;
    (inv.line_items || []).forEach(function(l){
      var amt = (Number(l.qty) || 0) * (Number(l.unit_price) || 0);
      var lines = doc.splitTextToSize(String(l.description), cQty - cX - 16);
      for (var i = 0; i < lines.length; i++){ t(lines[i], cX, y + i * 13, { size: 10 }); }
      t(String(l.qty), cQty, y, { size: 10, align: 'right' });
      t(_money(l.unit_price), cUnit, y, { size: 10, align: 'right' });
      t(_money(amt), cAmt, y, { size: 10, align: 'right' });
      y += Math.max(lines.length * 13, 16) + 4;
      if (y > H - 140) { doc.addPage(); y = M; }
    });
    doc.setDrawColor(225); doc.line(cQty - 10, y, cAmt, y); y += 16;
    function totalRow(label, val, bold){ t(label, cUnit, y, { size: bold ? 11 : 10, align: 'right', style: bold ? 'bold' : 'normal' }); t(val, cAmt, y, { size: bold ? 11 : 10, align: 'right', style: bold ? 'bold' : 'normal' }); y += bold ? 18 : 15; }
    totalRow('Subtotal', _money(inv.subtotal));
    if (Number(inv.discount) > 0.005){
      var _dl = inv.discount_label ? String(inv.discount_label)
              : (inv.discount_type === 'percent' ? (Number(inv.discount_value) + '%') : '');
      totalRow('Discount' + (_dl ? ' - ' + _dl : ''), '-' + _money(inv.discount));
    }
    if (Number(inv.tax_rate)) totalRow('Tax (' + inv.tax_rate + '%)', _money(inv.tax));
    totalRow('Total (' + inv.currency + ')', _money(inv.total), true);
    // Payment status: show amount received + balance due once a payment exists.
    var _paid = Number(inv.amount_paid) || 0;
    if (_paid > 0.005){
      var _bal = Math.round(((Number(inv.total) || 0) - _paid) * 100) / 100;
      totalRow('Amount paid' + (inv.paid_date ? ' (' + inv.paid_date + ')' : ''), '-' + _money(_paid));
      totalRow(_bal <= 0.005 ? 'Balance due — PAID IN FULL' : 'Balance due', _money(_bal), true);
    }
    if (inv.notes){ y += 14; t('Notes', M, y, { style: 'bold', size: 9, color: [120, 120, 120] }); y += 14; doc.splitTextToSize(String(inv.notes), W - M * 2).forEach(function(ln){ t(ln, M, y, { size: 10 }); y += 13; }); }
    // Standard terms -- printed on every invoice.
    if (y > H - 130) { doc.addPage(); y = M; }
    y += 16; t('Terms', M, y, { style: 'bold', size: 9, color: [120, 120, 120] }); y += 14;
    ['Payment due within 30 days of invoice date.',
     'Amounts more than 30 days overdue may bear interest at 1% per month (12.68% annually).',
     'All amounts are in Canadian dollars, plus applicable taxes if any.'
    ].forEach(function(line){
      doc.splitTextToSize(line, W - M * 2).forEach(function(ln){ t(ln, M, y, { size: 9, color: [90, 90, 90] }); y += 12; });
    });
    t('Home Land Homes - Housing Management Platform', M, H - 26, { size: 8, color: [130, 130, 130] });
    return doc;
  }

  // ---- Recurring billing schedule --------------------------------------------
  var BILL_CADENCE = [['monthly', 'Monthly'], ['annual', 'Annual']];
  window._nicBilling = null;
  // The schedule's line item is chosen from the fee schedule (same catalog as
  // manual invoices). Picking a fee fills the amount; a previously-saved custom
  // description is preserved as its own selected option.
  function _billFeeSelectHtml(selDesc){
    var groups = [], found = false;
    FEE_SCHEDULE.forEach(function(it){
      var gi = null; for (var k = 0; k < groups.length; k++){ if (groups[k].g === it.g){ gi = groups[k]; break; } }
      if (!gi){ gi = { g: it.g, items: [] }; groups.push(gi); }
      gi.items.push(it);
    });
    var opts = groups.map(function(g){
      return '<optgroup label="' + esc(g.g) + '">' + g.items.map(function(it){
        var sel = (it.d === selDesc); if (sel) found = true;
        var price = it.custom ? 'enter amount' : (it.hours ? _money(it.p) + '/hr' : _money(it.p));
        return '<option value="' + esc(it.d) + '" data-amt="' + (it.custom ? '' : it.p) + '"' + (sel ? ' selected' : '') + '>' + esc(it.d) + '  —  ' + price + '</option>';
      }).join('') + '</optgroup>';
    }).join('');
    var custom = (selDesc && !found) ? '<option value="' + esc(selDesc) + '" data-amt="" selected>' + esc(selDesc) + ' (custom)</option>' : '';
    return '<select id="cn-bill-desc">' + custom + opts + '</select>';
  }
  window._billApplyFee = function(sel){
    var opt = sel && sel.options[sel.selectedIndex];
    var amt = opt && opt.getAttribute('data-amt');
    if (amt){ var a = document.getElementById('cn-bill-amount'); if (a) a.value = amt; }
  };
  // Advance a YYYY-MM-DD by the cadence, holding the anchor day-of-month.
  function _advanceBillDate(day, cadence, anchor){
    var d = new Date(day + 'T00:00:00Z');
    var wantDay = (anchor && anchor >= 1 && anchor <= 31) ? anchor : d.getUTCDate();
    if (cadence === 'annual') d.setUTCFullYear(d.getUTCFullYear() + 1); else d.setUTCMonth(d.getUTCMonth() + 1);
    var last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(wantDay, last));
    return d.toISOString().slice(0, 10);
  }
  async function renderNationBilling(sub){
    var host = document.getElementById('cn-billing'); if (!host) return;
    var r = await api('GET', '/nation_billing?subdomain=eq.' + encodeURIComponent(sub) + '&order=created_at.asc&limit=1');
    var row = (r.ok ? await r.json().catch(function(){ return []; }) : [])[0] || null;
    window._nicBilling = row;
    var b = row || { cadence: 'monthly', description: '', unit_amount: '', tax_rate: 0, next_run_date: _dPlus(30), anchor_day: '', due_days: 30, auto_send: false, recipient_email: '', cc_emails: '', active: true, discount_type: '', discount_value: '', discount_label: '' };
    var cadOpts = BILL_CADENCE.map(function(c){ return '<option value="' + c[0] + '"' + (b.cadence === c[0] ? ' selected' : '') + '>' + c[1] + '</option>'; }).join('');
    var g2 = 'display:grid;grid-template-columns:1fr 1fr;gap:10px;';
    var statusLine = row
      ? '<div style="font-size:12px;margin-bottom:8px;">'
        + (row.active ? '<span class="pill active">Active</span>' : '<span class="pill suspended">Paused</span>')
        + ' &middot; next invoice <b>' + esc(row.next_run_date) + '</b>'
        + (row.last_invoice ? ' &middot; last ' + esc(row.last_invoice) + ' on ' + esc(row.last_run_date || '') : '')
        + '</div>'
      : '<div style="font-size:12px;color:var(--muted);margin-bottom:8px;">No schedule yet &mdash; fill this in and Save to start automated billing.</div>';
    host.innerHTML = statusLine
      + '<div style="' + g2 + '">'
      +   '<div><label>Cadence</label><select id="cn-bill-cadence">' + cadOpts + '</select></div>'
      +   '<div><label>Next invoice date</label><input id="cn-bill-next" type="date" value="' + esc(b.next_run_date || '') + '"/></div>'
      + '</div>'
      + '<label>Line item (fee schedule)</label>' + _billFeeSelectHtml(b.description)
      + '<div style="' + g2 + '">'
      +   '<div><label>Amount per period (CAD)</label><input id="cn-bill-amount" type="number" step="0.01" value="' + esc(b.unit_amount === '' ? '' : b.unit_amount) + '"/></div>'
      +   '<div><label>Tax rate (%)</label><input id="cn-bill-tax" type="number" step="0.01" value="' + esc(b.tax_rate || 0) + '"/></div>'
      + '</div>'
      + '<div style="display:grid;grid-template-columns:150px 110px 1fr;gap:10px;">'
      +   '<div><label>Discount</label><select id="cn-bill-disc-type">'
      +     '<option value=""' + (!b.discount_type ? ' selected' : '') + '>None</option>'
      +     '<option value="percent"' + (b.discount_type === 'percent' ? ' selected' : '') + '>Percent (%)</option>'
      +     '<option value="fixed"' + (b.discount_type === 'fixed' ? ' selected' : '') + '>Fixed ($)</option>'
      +   '</select></div>'
      +   '<div><label>Value</label><input id="cn-bill-disc-value" type="number" step="0.01" min="0" value="' + esc(b.discount_value || '') + '"/></div>'
      +   '<div><label>Reason shown on invoice (optional)</label><input id="cn-bill-disc-label" value="' + esc(b.discount_label || '') + '" placeholder="e.g. Multi-nation partnership discount"/></div>'
      + '</div>'
      + '<div class="sub" style="font-size:11px;margin:2px 0 0;">Standing discount for this nation: taken off the period fee <b>before tax</b> on every generated invoice (carried-forward balances are never re-discounted), and printed as its own line.</div>'
      + '<div style="' + g2 + '">'
      +   '<div><label>Bill on day of month (1-28, optional)</label><input id="cn-bill-anchor" type="number" min="1" max="28" value="' + esc(b.anchor_day || '') + '"/></div>'
      +   '<div><label>Payment due (days)</label><input id="cn-bill-due" type="number" min="0" value="' + esc(b.due_days == null ? 30 : b.due_days) + '"/></div>'
      + '</div>'
      + '<label style="display:flex;align-items:center;gap:8px;margin-top:10px;cursor:pointer;font-weight:600;"><input type="checkbox" id="cn-bill-carry" style="width:auto;"' + (b.carry_forward ? ' checked' : '') + '/> <span>Carry any prior unpaid balance forward onto each generated invoice</span></label>'
      + '<div style="font-size:11px;color:var(--muted);margin:2px 0 0 26px;">When on, each auto-invoice adds a "Balance carried forward" line for every still-owing invoice and marks those as carried, so the nation sees one running total owing.</div>'
      + '<label style="display:flex;align-items:center;gap:8px;margin-top:10px;cursor:pointer;font-weight:600;"><input type="checkbox" id="cn-bill-autosend" style="width:auto;"' + (b.auto_send ? ' checked' : '') + '/> <span>Auto-send the invoice by email when generated</span></label>'
      + '<div style="' + g2 + '">'
      +   '<div><label>Billing email</label><input id="cn-bill-email" type="email" value="' + esc(b.recipient_email || '') + '" placeholder="finance@nation.ca"/></div>'
      +   '<div><label>CC (comma-separated, optional)</label><input id="cn-bill-cc" value="' + esc(b.cc_emails || '') + '"/></div>'
      + '</div>'
      + '<div class="msg" id="cn-bill-msg"></div>'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px;">'
      +   '<button class="btn" type="button" data-act="bill-save" data-sub="' + esc(sub) + '">Save schedule</button>'
      +   (row ? '<button class="btn ghost" type="button" data-act="bill-toggle" data-sub="' + esc(sub) + '">' + (row.active ? 'Pause' : 'Resume') + '</button>' : '')
      +   (row ? '<button class="btn ghost" type="button" data-act="bill-run" data-sub="' + esc(sub) + '">Generate now</button>' : '')
      + '</div>';
    // Wire the fee-schedule select programmatically (admin CSP blocks inline handlers).
    var _feeSel = document.getElementById('cn-bill-desc');
    if (_feeSel) _feeSel.onchange = function(){ window._billApplyFee(_feeSel); };
  }
  function _readBilling(){
    function v(id){ var el = document.getElementById(id); return el ? (el.value || '').trim() : ''; }
    function cb(id){ var el = document.getElementById(id); return !!(el && el.checked); }
    return {
      cadence: v('cn-bill-cadence') || 'monthly',
      next_run_date: v('cn-bill-next'),
      description: v('cn-bill-desc'),
      unit_amount: parseFloat(v('cn-bill-amount')) || 0,
      tax_rate: parseFloat(v('cn-bill-tax')) || 0,
      discount_type: (v('cn-bill-disc-type') === 'percent' || v('cn-bill-disc-type') === 'fixed') ? v('cn-bill-disc-type') : null,
      discount_value: parseFloat(v('cn-bill-disc-value')) || 0,
      discount_label: v('cn-bill-disc-label') || null,
      anchor_day: v('cn-bill-anchor') ? parseInt(v('cn-bill-anchor'), 10) : null,
      due_days: v('cn-bill-due') ? parseInt(v('cn-bill-due'), 10) : 30,
      auto_send: cb('cn-bill-autosend'),
      carry_forward: cb('cn-bill-carry'),
      recipient_email: v('cn-bill-email'),
      cc_emails: v('cn-bill-cc')
    };
  }
  window.saveNationBilling = async function(sub){
    var b = _readBilling();
    if (!b.description){ setMsg('cn-bill-msg', 'Enter a line description.'); return; }
    if (!(b.unit_amount > 0)){ setMsg('cn-bill-msg', 'Enter an amount greater than zero.'); return; }
    if (b.discount_type === 'percent' && b.discount_value > 100){ setMsg('cn-bill-msg', 'Percent discount cannot exceed 100%.'); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.next_run_date)){ setMsg('cn-bill-msg', 'Pick the next invoice date.'); return; }
    if (b.auto_send && !b.recipient_email){ setMsg('cn-bill-msg', 'Auto-send needs a billing email.'); return; }
    var existing = window._nicBilling, r;
    if (existing){
      b.updated_at = new Date().toISOString();
      r = await api('PATCH', '/nation_billing?id=eq.' + encodeURIComponent(existing.id), b, 'return=minimal');
    } else {
      b.subdomain = sub; b.active = true; b.created_by = jwtEmail();
      r = await api('POST', '/nation_billing', b, 'return=minimal');
    }
    if (r.ok){ setMsg('cn-bill-msg', 'Schedule saved.', 'ok'); await audit('nation_billing_saved', sub, b.cadence + ' ' + _money(b.unit_amount)); renderNationBilling(sub); }
    else { setMsg('cn-bill-msg', 'Could not save the schedule.'); }
  };
  window.toggleNationBilling = async function(sub){
    var existing = window._nicBilling; if (!existing) return;
    var r = await api('PATCH', '/nation_billing?id=eq.' + encodeURIComponent(existing.id), { active: !existing.active, updated_at: new Date().toISOString() }, 'return=minimal');
    if (r.ok){ await audit('nation_billing_' + (existing.active ? 'paused' : 'resumed'), sub, ''); renderNationBilling(sub); }
  };
  // Generate an invoice from the schedule immediately (manual run / test) and
  // advance the schedule the same way the scheduler would. Email (auto_send) is
  // only sent by the automated scheduler, not this manual run.
  window.runNationBilling = async function(sub){
    var b = window._nicBilling; if (!b){ setMsg('cn-bill-msg', 'Save the schedule first.'); return; }
    var n = _nations.filter(function(x){ return x.subdomain === sub; })[0];
    var _estBase = Math.round((Number(b.unit_amount) || 0) * 100) / 100;
    var _estDisc = _calcDiscount(_estBase, b.discount_type, Number(b.discount_value) || 0);
    var total = Math.round((_estBase - _estDisc) * (1 + (Number(b.tax_rate) || 0) / 100) * 100) / 100;
    if (!(await dlgConfirm('Generate an invoice now from this schedule for ' + (n ? n.display_name : sub) + '?\n\nThis creates ' + _money(total) + (_estDisc > 0 ? ' (after a ' + _money(_estDisc) + ' discount)' : '') + ' and advances the next date. Email is only sent by the automated scheduler, not this manual run.', { title: 'Generate now', okText: 'Generate' }))) return;
    setMsg('cn-bill-msg', 'Generating...', 'ok');
    ensureJsPdf(async function(){
      try {
        var subtotal = Math.round((Number(b.unit_amount) || 0) * 100) / 100;
        var taxRate = Number(b.tax_rate) || 0;
        var discount = _calcDiscount(subtotal, b.discount_type, Number(b.discount_value) || 0);
        var taxable = Math.round((subtotal - discount) * 100) / 100;
        var tax = Math.round(taxable * taxRate) / 100;
        var tot = Math.round((taxable + tax) * 100) / 100;
        var today = new Date().toISOString().slice(0, 10);
        var due = _dPlus(Number(b.due_days) || 30);
        var number = await nextInvoiceNumber();
        var inv = { subdomain: sub, number: number, issue_date: today, due_date: due, currency: 'CAD',
          line_items: [{ description: b.description, qty: 1, unit_price: subtotal }], subtotal: subtotal, tax_rate: taxRate, tax: tax, total: tot,
          amount_paid: 0, status: 'sent', notes: 'Generated from recurring schedule.', created_by: jwtEmail() };
        if (discount > 0){ inv.discount_type = b.discount_type; inv.discount_value = Number(b.discount_value) || 0; inv.discount = discount; inv.discount_label = b.discount_label || null; }
        var r = await api('POST', '/nation_invoices', inv, 'return=minimal');
        if (!r.ok){ var t = await r.text(); setMsg('cn-bill-msg', /duplicate|unique/i.test(t) ? 'Number collision, try again.' : 'Could not create invoice.'); return; }
        var doc = buildInvoicePdf(n, inv); var fname = number + '.pdf'; var blob = doc.output('blob'); var viewUrl = URL.createObjectURL(blob); doc.save(fname);
        try { await uploadDoc(sub, new File([blob], fname, { type: 'application/pdf' }), 'invoice'); } catch(e){}
        var nextRun = _advanceBillDate(b.next_run_date, b.cadence, b.anchor_day);
        await api('PATCH', '/nation_billing?id=eq.' + encodeURIComponent(b.id), { next_run_date: nextRun, last_run_date: today, last_invoice: number, updated_at: new Date().toISOString() }, 'return=minimal');
        await audit('nation_invoice_auto', sub, number + ': ' + _money(tot) + ' (manual run); next ' + nextRun);
        setMsgWithView('cn-bill-msg', 'Invoice ' + number + ' generated. Next invoice on ' + nextRun + '.', viewUrl);
        renderNationBilling(sub); renderNationInvoices(sub); renderNationDocsCard(sub); loadNicSummary(sub);
      } catch (e){ setMsg('cn-bill-msg', 'Could not generate: ' + String(e && e.message || e)); }
    }, function(){ setMsg('cn-bill-msg', 'Could not load the PDF generator (offline?).'); });
  };

  // ---- Event delegation ------------------------------------------------------
  // Every button here is wired through ONE delegated listener keyed on
  // data-act, because this panel's CSP is `script-src 'self'` with NO
  // 'unsafe-inline' (admin/_headers). An inline onclick="..." is silently
  // BLOCKED by the browser -- the button simply does nothing, with only a
  // console CSP violation to show for it. Do not reintroduce inline handlers:
  // add a data-act value and a case below instead.
  // Delegation also survives app.innerHTML re-renders, so nothing needs
  // re-wiring after a view change.
  document.addEventListener('click', function(e){
    var el = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
    if (!el) return;
    var act = el.getAttribute('data-act');
    var id  = el.getAttribute('data-id') || '';
    switch (act){
      case 'home':          window.adminHome(); break;
      case 'logout':        window.adminLogout(); break;
      case 'reload':        location.reload(); break;
      case 'configure':     window.configureNation(id); break;
      case 'enter':         window.enterNation(id); break;
      case 'supportkey-gen':    window.genSupportKey(el.getAttribute('data-sub') || '', false); break;
      case 'supportkey-rotate': window.genSupportKey(el.getAttribute('data-sub') || '', true); break;
      case 'supportkey-copy':   (function(){ var t = document.getElementById('cn-supportkey-jwk'); if (t){ try { t.select(); } catch(e){} try { navigator.clipboard.writeText(t.value); } catch(e){} setMsg('cn-supportkey-msg', 'Public key copied.', 'ok'); } })(); break;
      case 'save-config':   window.saveNationConfig(id); break;
      case 'status':        window.adminSetStatus(id, el.getAttribute('data-status') || ''); break;
      case 'add-admin':     window.adminAdd(); break;
      case 'rm-admin':      window.adminRemove(el.getAttribute('data-email') || ''); break;
      // id is '' from the standalone card, which falls through to the blank
      // wizard; from a Configure page it prefills that nation.
      case 'provision':     window.showProvision(id); break;
      case 'run-provision': window.runProvision(); break;
      case 'fleet-dry':     window.runFleetMigration(true); break;
      case 'fleet-apply':   window.runFleetMigration(false); break;
      case 'agr-save-addr': window.saveNationAgreementAddress(id); break;
      case 'gen-agreement': window.generateNationAgreement(id); break;
      case 'doc-view':      window.viewNationDoc(el.getAttribute('data-path') || ''); break;
      case 'doc-dl':        window.downloadNationDoc(el.getAttribute('data-path') || '', el.getAttribute('data-name') || ''); break;
      case 'doc-del':       window.deleteNationDoc(el.getAttribute('data-id') || '', el.getAttribute('data-path') || '', el.getAttribute('data-sub') || ''); break;
      case 'nic-tab':       window.nicTab(el.getAttribute('data-tab') || ''); break;
      case 'note-add':      window.addNationNote(el.getAttribute('data-sub') || ''); break;
      case 'ai-key-save':   window.saveNationAiKey(el.getAttribute('data-sub') || ''); break;
      case 'email-apply':   window.applyNationEmailSecrets(el.getAttribute('data-sub') || ''); break;
      case 'copy-text':     window.copyTextBtn(el); break;
      case 'inv-add-line':  window.invAddLine(); break;
      case 'inv-add-catalog': window.invAddCatalogLine(); break;
      case 'inv-find-band': window.invFindBand(); break;
      case 'inv-del-line':  { var lr = el.closest && el.closest('.inv-line'); if (lr) lr.remove(); break; }
      case 'inv-create':    window.createNationInvoice(el.getAttribute('data-sub') || '', id); break;
      case 'inv-status':    window.setInvoiceStatus(el.getAttribute('data-id') || '', el.getAttribute('data-status') || '', el.getAttribute('data-sub') || ''); break;
      case 'inv-view':      window.viewNationInvoice(el.getAttribute('data-id') || '', el.getAttribute('data-sub') || ''); break;
      case 'inv-pay':       window.invRecordPayment(el.getAttribute('data-id') || '', el.getAttribute('data-sub') || ''); break;
      case 'inv-carry':     window.invCarryForward(el.getAttribute('data-sub') || ''); break;
      case 'bill-save':     window.saveNationBilling(el.getAttribute('data-sub') || ''); break;
      case 'bill-toggle':   window.toggleNationBilling(el.getAttribute('data-sub') || ''); break;
      case 'bill-run':      window.runNationBilling(el.getAttribute('data-sub') || ''); break;
      case 'logo-clear':    { var _lh = document.getElementById('cn-logo'); var _lp = document.getElementById('cn-logo-preview'); var _lf = document.getElementById('cn-logo-file'); if (_lh) _lh.value = ''; if (_lp) _lp.style.backgroundImage = ''; if (_lf) _lf.value = ''; break; }
      case 'inv-interest':  window.invAddInterest(el.getAttribute('data-id') || '', el.getAttribute('data-sub') || ''); break;
    }
  });

  // ---- Boot ------------------------------------------------------------------
  function parseHash(){ var h = (location.hash||'').replace(/^#/,''); if (!h) return null; var o={}; h.split('&').forEach(function(kv){ var p=kv.split('='); if (p[0]) o[decodeURIComponent(p[0])] = decodeURIComponent(p[1]||''); }); return o; }

  if (!PBASE || PBASE.indexOf('REPLACE_WITH') !== -1 || !ANON || ANON.indexOf('REPLACE_WITH') !== -1){
    app.innerHTML = '<div class="center"><h1>Not configured</h1><p class="sub">Set <code>PLATFORM_SUPABASE_URL</code> and <code>PLATFORM_SUPABASE_ANON</code> in <code>admin-config.js</code> (the fnhub-platform project\'s URL + anon key), then reload.</p></div>';
    return;
  }
  var hash = parseHash();
  if (hash && hash.access_token){ setSession(hash.access_token, hash.refresh_token); try { history.replaceState(null,'',REDIRECT); } catch(e){ location.hash=''; } showDashboard(); }
  else if (hash && hash.error){ showLogin(); setTimeout(function(){ setMsg('lmsg', hash.error_description || 'That sign-in link is invalid or expired.'); }, 0); }
  else if (getAT()){ showDashboard(); }
  else { showLogin(); }
})();
