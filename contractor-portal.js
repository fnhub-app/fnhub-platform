// ============================================================================
// contractor-portal.js — Contractor Portal B1 proof surface.
//
// Minimal, self-contained. SMS one-time-code login via Supabase phone auth
// (Twilio Verify), then a read-only "My Work Orders" list from the RLS-scoped
// contractor_work_orders projection. Loads only the shared CONFIG layer
// (SUPABASE_URL/ANON + nation branding) — never the staff bundle.
//
// The data boundary is enforced by Postgres RLS, not by this file: a contractor
// only ever receives their own rows regardless of what this code requests.
// ============================================================================
(function () {
  'use strict';

  function el(id) { return document.getElementById(id); }
  function show(id) { var e = el(id); if (e) e.classList.remove('hidden'); }
  function hide(id) { var e = el(id); if (e) e.classList.add('hidden'); }
  function setMsg(m, isErr) {
    var e = el('cp_msg'); if (!e) return;
    e.textContent = m || '';
    e.className = isErr ? 'cp-msg cp-err' : 'cp-msg';
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c];
    });
  }

  // Local E.164 normalizer (the portal does not load shared-data.js). NA-first:
  // 10 digits -> +1…, 11 starting with 1 -> +…, else digits-only with a '+'.
  function e164(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (/^\+[1-9]\d{7,14}$/.test(s)) return s;
    var d = s.replace(/[^\d]/g, '');
    if (d.length === 10) return '+1' + d;
    if (d.length === 11 && d.charAt(0) === '1') return '+' + d;
    if (d.length >= 8 && d.length <= 15) return '+' + d;
    return '';
  }

  var SB = window.SUPABASE_URL;
  var ANON = window.SUPABASE_ANON;
  var session = null;
  var _resendTimer = null;
  var workOrders = [];   // last-loaded rows, indexed by the detail view
  var currentWO = null;  // the work order whose detail is open (for downloads)

  // POST the OTP request for a phone. Shared by the first "Text me a code" and
  // the "Resend code" button. Returns true on success.
  async function sendOtp(phone) {
    var r = await fetch(SB + '/auth/v1/otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': ANON },
      body: JSON.stringify({ phone: phone })
    });
    if (!r.ok) {
      var d = await r.json().catch(function () { return {}; });
      throw new Error(d.msg || d.error_description || d.error || ('HTTP ' + r.status));
    }
    return true;
  }

  // Disable the Resend button for a cooldown so repeated taps can't trip the
  // provider's SMS rate limit; count down in the button label.
  function startResendCooldown(secs) {
    var btn = el('cp_resend'); if (!btn) return;
    var n = secs;
    if (_resendTimer) { clearInterval(_resendTimer); _resendTimer = null; }
    function tick() {
      if (n <= 0) {
        btn.disabled = false; btn.textContent = 'Resend code';
        if (_resendTimer) { clearInterval(_resendTimer); _resendTimer = null; }
        return;
      }
      btn.disabled = true; btn.textContent = 'Resend code (' + n + 's)';
      n--;
    }
    tick();
    _resendTimer = setInterval(tick, 1000);
  }

  async function requestCode() {
    var phone = e164(el('cp_phone').value);
    if (!phone) { setMsg('Enter a valid mobile number.', true); return; }
    setMsg('Sending code…');
    try {
      await sendOtp(phone);
      el('cp_phone_sent').textContent = phone;
      hide('cp_step_phone'); show('cp_step_code'); setMsg('');
      startResendCooldown(30);
    } catch (err) { setMsg('Could not send a code: ' + err.message, true); }
  }

  // Resend to the same number without leaving the code step.
  async function resendCode() {
    var phone = e164(el('cp_phone').value);
    if (!phone) { setMsg('Enter your number again.', true); return; }
    setMsg('Sending a new code…');
    try {
      await sendOtp(phone);
      var codeEl = el('cp_code'); if (codeEl) { codeEl.value = ''; codeEl.focus(); }
      setMsg('A new code was sent to ' + phone + '.');
      startResendCooldown(30);
    } catch (err) { setMsg('Could not resend: ' + err.message, true); }
  }

  async function verifyCode() {
    var phone = e164(el('cp_phone').value);
    var token = (el('cp_code').value || '').trim();
    if (!token) { setMsg('Enter the code from the text.', true); return; }
    setMsg('Verifying…');
    try {
      var r = await fetch(SB + '/auth/v1/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': ANON },
        body: JSON.stringify({ phone: phone, token: token, type: 'sms' })
      });
      var d = await r.json();
      if (!r.ok || !d.access_token) {
        throw new Error(d.msg || d.error_description || d.error || ('HTTP ' + r.status));
      }
      session = d;
      await claimAndLoad();
    } catch (err) { setMsg('Verification failed: ' + err.message, true); }
  }

  async function claimAndLoad() {
    setMsg('Signing you in…');
    // Link this login to a contractor (invite/claim). The Edge Function creates
    // the mapping only when an invite matches AND the phone is on the
    // contractor's record; otherwise there is simply no access (empty).
    try {
      var cr = await fetch(SB + '/functions/v1/contractor-claim', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': ANON,
          'Authorization': 'Bearer ' + session.access_token
        },
        body: '{}'
      });
      var cd = await cr.json().catch(function () { return {}; });
      if (!cr.ok || !cd.linked) { hide('cp_login'); show('cp_notlinked'); return; }
    } catch (e) { hide('cp_login'); show('cp_notlinked'); return; }
    await loadWorkOrders();
  }

  async function loadWorkOrders() {
    try {
      var r = await fetch(SB + '/rest/v1/contractor_work_orders?select=*&order=updated_at.desc', {
        headers: { 'apikey': ANON, 'Authorization': 'Bearer ' + session.access_token }
      });
      var rows = await r.json();
      renderWorkOrders(Array.isArray(rows) ? rows : []);
      hide('cp_login'); show('cp_app');
    } catch (e) { setMsg('Could not load your work orders: ' + e.message, true); }
  }

  function renderWorkOrders(rows) {
    workOrders = rows || [];
    el('cp_count').textContent = rows.length + (rows.length === 1 ? ' work order' : ' work orders');
    // Each row carries data-cpwo = its index into workOrders, so the delegated
    // click handler (wired in init) can open the right detail regardless of
    // which status section it lands in.
    function section(title, statusKey) {
      var list = rows.map(function (w, i) { return { w: w, i: i }; })
                     .filter(function (x) { return (x.w.status || 'active') === statusKey; });
      if (!list.length) return '';
      return '<h3 class="cp-h3">' + title + ' (' + list.length + ')</h3>' + list.map(function (x) {
        var w = x.w;
        return '<div class="cp-wo" data-cpwo="' + x.i + '"><div>'
             + '<div class="cp-wo-addr">' + esc(w.address || w.sow_unit_id || '') + '</div>'
             + '<div class="cp-wo-meta">#' + esc(w.sow_project_number || '') + '</div></div>'
             + '<span class="cp-wo-chev">&rsaquo;</span></div>';
      }).join('');
    }
    var html = section('Active', 'active') + section('In process', 'in_process') + section('Closed', 'closed');
    el('cp_list').innerHTML = html || '<div class="cp-empty">No work orders assigned to you yet.</div>';
  }

  // Work-order detail — what the contractor sees after tapping a property.
  // Reads the row's `data` jsonb (scope / dates / contact / documents) that the
  // staff client syncs into the RLS-scoped projection. Documents are LISTED in
  // Phase 1; download is wired in Phase 2 (signed-URL Edge Function).
  function setDetailMsg(m, isErr) {
    var e = el('cp_detail_msg'); if (!e) return;
    e.textContent = m || '';
    e.className = isErr ? 'cp-msg cp-err' : 'cp-msg';
  }

  // Fetch a short-lived signed URL for ONE work-order document from the
  // contractor-file Edge Function (which re-checks ownership server-side) and
  // open it. The tab is opened synchronously so pop-up blockers don't eat it.
  function downloadDocument(path) {
    if (!path || !session || !session.access_token || !currentWO) return;
    var win = window.open('', '_blank');
    setDetailMsg('Opening document...');
    fetch(SB + '/functions/v1/contractor-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': ANON, 'Authorization': 'Bearer ' + session.access_token },
      body: JSON.stringify({ unitId: currentWO.sow_unit_id, projectNumber: currentWO.sow_project_number, path: path })
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, d: d }; });
    }).then(function (res) {
      if (res.ok && res.d && res.d.url) {
        if (win) { win.location = res.d.url; } else { window.location = res.d.url; }
        setDetailMsg('');
      } else {
        if (win) { try { win.close(); } catch (e) { /* ignore */ } }
        setDetailMsg('Could not open that document. Please contact the housing office.', true);
      }
    }).catch(function () {
      if (win) { try { win.close(); } catch (e) { /* ignore */ } }
      setDetailMsg('Could not open that document. Please contact the housing office.', true);
    });
  }

  function showWorkOrder(idx) {
    var w = workOrders[idx];
    if (!w) return;
    currentWO = w;
    var d = w.data || {};
    var statusLabel = ({ active: 'Active', in_process: 'In process', closed: 'Closed' })[w.status || 'active'] || (w.status || '');
    function field(label, val) {
      if (!val) return '';
      return '<div class="cp-field"><div class="cp-field-l">' + esc(label) + '</div><div class="cp-field-v">' + esc(val) + '</div></div>';
    }
    var scope = Array.isArray(d.scopeItems) ? d.scopeItems : [];
    var scopeHtml = '<h3 class="cp-h3">Scope of work</h3>' + (scope.length
      ? scope.map(function (it) {
          return '<div class="cp-scope">' + (it.category ? '<div class="cp-scope-cat">' + esc(it.category) + '</div>' : '')
               + '<div>' + esc(it.description || '') + '</div></div>';
        }).join('')
      : '<div class="cp-empty">No scope items listed.</div>');
    var docs = Array.isArray(d.documents) ? d.documents : [];
    var docsHtml = '<h3 class="cp-h3">Documents</h3>' + (docs.length
      ? docs.map(function (f) {
          // data-cpdoc carries the URI-encoded storage path; the delegated
          // handler decodes it and calls downloadDocument (ownership re-checked
          // server-side by the contractor-file Edge Function).
          return '<div class="cp-doc" data-cpdoc="' + encodeURIComponent(f.path || '') + '" role="button" tabindex="0">'
               + '<span>&#128196;</span><span class="cp-doc-name">' + esc(f.name || 'Document') + '</span>'
               + '<span class="cp-doc-dl">Download</span></div>';
        }).join('')
      : '<div class="cp-empty">No documents shared.</div>');
    el('cp_detail').innerHTML =
      '<button type="button" class="cp-back" data-cp-back>&larr; Back to work orders</button>'
      + '<h1>' + esc(w.address || w.sow_unit_id || '') + '</h1>'
      + '<p class="cp-sub">#' + esc(w.sow_project_number || '') + ' &middot; ' + esc(statusLabel) + '</p>'
      + field('Target start', d.targetStart)
      + field('Target completion', d.targetCompletion)
      + field('Condition', d.condition)
      + field('Housing contact', d.contactName)
      + field('Contact phone', d.contactPhone)
      + scopeHtml
      + docsHtml
      + '<div class="cp-msg" id="cp_detail_msg"></div>';
    hide('cp_app'); show('cp_detail');
    try { window.scrollTo(0, 0); } catch (e) { /* non-fatal */ }
  }

  function backToWorkOrders() { hide('cp_detail'); show('cp_app'); }

  function init() {
    if (!SB || !ANON) { setMsg('Portal is not configured for this nation.', true); return; }
    var s = el('cp_send'); if (s) s.addEventListener('click', requestCode);
    var v = el('cp_verify'); if (v) v.addEventListener('click', verifyCode);
    var rs = el('cp_resend'); if (rs) rs.addEventListener('click', resendCode);
    var b = el('cp_back'); if (b) b.addEventListener('click', function () {
      if (_resendTimer) { clearInterval(_resendTimer); _resendTimer = null; }
      hide('cp_step_code'); show('cp_step_phone'); setMsg('');
    });
    // Tap a work order -> detail; delegated so it survives list re-renders.
    var listEl = el('cp_list');
    if (listEl) listEl.addEventListener('click', function (e) {
      var row = e.target && e.target.closest ? e.target.closest('.cp-wo') : null;
      if (!row) return;
      var idx = parseInt(row.getAttribute('data-cpwo'), 10);
      if (!isNaN(idx)) showWorkOrder(idx);
    });
    var detailEl = el('cp_detail');
    if (detailEl) detailEl.addEventListener('click', function (e) {
      if (!e.target || !e.target.closest) return;
      if (e.target.closest('[data-cp-back]')) { backToWorkOrders(); return; }
      var doc = e.target.closest('.cp-doc[data-cpdoc]');
      if (doc) {
        var p = doc.getAttribute('data-cpdoc');
        if (p) downloadDocument(decodeURIComponent(p));
      }
    });
    applyNationBranding();
  }

  // Brand the portal dynamically from the resolved nation (name + colour +
  // logo), the same NATION_CONFIG the staff app and other public pages use, so
  // a new nation is themed automatically from its registry entry — nothing here
  // is CLFN-specific. No colour literals live in this file (the accent value is
  // the nation's own; the on-accent text colour is chosen in CSS via the
  // data-accent flag), so the colour guard stays clean.
  function applyNationBranding() {
    var nc = window.NATION_CONFIG || {};
    try {
      el('cp_brand').textContent = (nc.display_name || nc.short || 'Housing') + ' — Contractor Portal';
    } catch (e) { /* keep default brand */ }
    try {
      if (nc.primary_color) {
        var root = document.documentElement;
        root.style.setProperty('--cp-accent', nc.primary_color);
        // Pick readable text on the accent fill: dark text on a light colour,
        // light text on a dark one. CSS owns the two ink values.
        root.setAttribute('data-accent', _isLightColor(nc.primary_color) ? 'light' : 'dark');
      }
    } catch (e) { /* keep default accent */ }
    try {
      var logoEl = el('cp_logo');
      if (logoEl && nc.logo) {
        var img = document.createElement('img');
        img.alt = ''; img.src = nc.logo;
        logoEl.appendChild(img);
        logoEl.style.display = 'block';
      }
    } catch (e) { /* no logo is fine */ }
  }

  // Relative-luminance test on a #rgb / #rrggbb string (no colour literals).
  function _isLightColor(hex) {
    var c = String(hex || '').trim().replace(/^#/, '');
    if (c.length === 3) c = c.charAt(0) + c.charAt(0) + c.charAt(1) + c.charAt(1) + c.charAt(2) + c.charAt(2);
    if (c.length !== 6) return false;
    var r = parseInt(c.substr(0, 2), 16), g = parseInt(c.substr(2, 2), 16), b = parseInt(c.substr(4, 2), 16);
    if (isNaN(r) || isNaN(g) || isNaN(b)) return false;
    var L = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return L > 0.6;
  }

  if (document.readyState !== 'loading') init();
  else document.addEventListener('DOMContentLoaded', init);
})();
