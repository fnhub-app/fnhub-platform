/* ============================================================================
 * support-widget.js — Help / Report-an-Issue widget (Phase S1a, staff app)
 *
 * Self-injecting modal opened via window.openSupportWidget() (wired to the
 * avatar menu). Files a row into public.support_tickets — RLS gates the insert
 * to reporter_user_id = auth.uid(), so we set it from the JWT `sub` — then
 * best-effort emails the nation's support_email via sendNotification. Gated by
 * the `support` module.
 *
 * The AI chat layer (support-chat Edge Function) + the community/contractor
 * portal surfaces come in later phases; this file is staff-only for now and
 * keys off HOUSING_SESSION, which only exists on the staff app.
 * ==========================================================================*/
(function () {
  'use strict';

  function _esc(s) {
    if (typeof escapeHtml === 'function') return escapeHtml(String(s == null ? '' : s));
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function _token() {
    return (typeof HOUSING_SESSION !== 'undefined' && HOUSING_SESSION && HOUSING_SESSION.accessToken) || '';
  }
  // The authenticated user's id (JWT `sub`) — the RLS insert policy requires the
  // row's reporter_user_id to equal it.
  function _authUid() {
    try {
      var t = _token(); if (!t) return '';
      var b = t.split('.')[1]; if (!b) return '';
      var p = JSON.parse(atob(b.replace(/-/g, '+').replace(/_/g, '/')));
      return p.sub || '';
    } catch (e) { return ''; }
  }

  var CATS = [
    { k: 'app_bug', l: 'Something is broken / a bug' },
    { k: 'access',  l: 'Sign-in / access problem' },
    { k: 'housing', l: 'Housing question (how do I…)' },
    { k: 'feature', l: 'Suggestion / feature request' },
    { k: 'other',   l: 'Something else' }
  ];

  function _ensure() {
    if (document.getElementById('supportWidget')) return;
    var ov = document.createElement('div');
    ov.id = 'supportWidget';
    ov.className = 'modal-overlay modal-overlay-centered modal-z-1100';
    ov.setAttribute('style', 'display:none;');
    ov.onclick = function (e) { if (e.target === ov) closeSupportWidget(); };
    var optsHtml = CATS.map(function (c) { return '<option value="' + c.k + '">' + _esc(c.l) + '</option>'; }).join('');
    ov.innerHTML = ''
      + '<div class="modal-body modal-body-md" style="max-width:520px;">'
      +   '<div class="modal-hdr spacious" style="display:flex;align-items:center;justify-content:space-between;">'
      +     '<div class="panel-title">🛟 Get Help / Report an Issue</div>'
      +     '<button type="button" onclick="closeSupportWidget()" class="btn-close-sm">✕</button>'
      +   '</div>'
      +   '<div style="padding:18px 20px;">'
      +     '<div id="support_form">'
      +       '<div class="f"><label>What do you need?</label><select id="support_cat">' + optsHtml + '</select></div>'
      +       '<div class="f"><label>Subject</label><input id="support_subject" type="text" placeholder="Short summary" autocomplete="off"/></div>'
      +       '<div class="f"><label>Details</label><textarea id="support_body" rows="5" placeholder="What happened, what you expected, and any steps to reproduce…" style="width:100%;box-sizing:border-box;resize:vertical;"></textarea></div>'
      +       '<div style="font-size:11px;color:var(--muted);margin:4px 0 10px;line-height:1.5;">We’ll include the page you’re on and your account so the team can follow up. Your message goes to your nation’s housing help desk.</div>'
      +       '<div id="support_err" style="display:none;color:var(--danger);font-size:12px;margin-bottom:8px;"></div>'
      +     '</div>'
      +     '<div id="support_done" style="display:none;text-align:center;padding:14px 0;">'
      +       '<div style="font-size:34px;line-height:1;">✅</div>'
      +       '<div style="font-weight:700;margin:8px 0 4px;">Thanks — your report was sent.</div>'
      +       '<div style="font-size:12px;color:var(--muted);">The housing help desk will follow up.</div>'
      +       '<div id="support_ref" style="font-size:11px;color:var(--muted);margin-top:6px;"></div>'
      +     '</div>'
      +   '</div>'
      +   '<div class="modal-footer" style="display:flex;justify-content:flex-end;gap:10px;padding:14px 20px;border-top:1px solid var(--border);">'
      +     '<button type="button" onclick="closeSupportWidget()" class="btn btn-ghost">Close</button>'
      +     '<button type="button" id="support_send_btn" onclick="_supportSubmit()" class="btn btn-primary">Send to help desk</button>'
      +   '</div>'
      + '</div>';
    document.body.appendChild(ov);
  }

  function openSupportWidget() {
    if (typeof moduleOn === 'function' && !moduleOn('support')) {
      if (typeof showToast === 'function') showToast('Help & Support is turned off for this nation.', { type: 'info' });
      return;
    }
    _ensure();
    var f = document.getElementById('support_form'), d = document.getElementById('support_done');
    if (f) f.style.display = '';
    if (d) d.style.display = 'none';
    ['support_subject', 'support_body'].forEach(function (id) { var e = document.getElementById(id); if (e) e.value = ''; });
    var err = document.getElementById('support_err'); if (err) err.style.display = 'none';
    var btn = document.getElementById('support_send_btn'); if (btn) { btn.disabled = false; btn.textContent = 'Send to help desk'; btn.style.display = ''; }
    var ov = document.getElementById('supportWidget'); if (ov) ov.style.display = 'flex';
    var sub = document.getElementById('support_subject'); if (sub) setTimeout(function () { try { sub.focus(); } catch (e) {} }, 30);
  }
  function closeSupportWidget() { var ov = document.getElementById('supportWidget'); if (ov) ov.style.display = 'none'; }

  function _ctx() {
    return {
      page: (location.pathname.replace(/^.*\//, '') || 'index.html'),
      url: location.href,
      app_version: (window.CLFN_APP_VERSION || ''),
      user_agent: navigator.userAgent,
      viewport: (window.innerWidth || 0) + 'x' + (window.innerHeight || 0)
    };
  }

  async function _supportSubmit() {
    var cat = (document.getElementById('support_cat') || {}).value || 'other';
    var subject = ((document.getElementById('support_subject') || {}).value || '').trim();
    var body = ((document.getElementById('support_body') || {}).value || '').trim();
    var err = document.getElementById('support_err');
    function fail(msg) { if (err) { err.textContent = msg; err.style.display = 'block'; } }
    if (!body) { fail('Please describe the issue.'); return; }
    var uid = _authUid();
    if (!uid) { fail('Could not confirm your sign-in — please reload and try again.'); return; }
    var btn = document.getElementById('support_send_btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
    if (err) err.style.display = 'none';
    var nc = window.NATION_CONFIG || {};
    var row = {
      nation: nc.id || nc.short || '',
      source: 'staff',
      reporter_user_id: uid,
      reporter_name: (typeof HOUSING_SESSION !== 'undefined' && HOUSING_SESSION.name) || '',
      reporter_email: (typeof HOUSING_SESSION !== 'undefined' && HOUSING_SESSION.email) || '',
      reporter_role: (window.currentRole || window._realRole || ''),
      category: cat,
      subject: subject || ('[' + cat + '] support request'),
      body: body,
      context: _ctx(),
      status: 'new'
    };
    try {
      var r = await fetch(SUPABASE_URL + '/rest/v1/support_tickets', {
        method: 'POST',
        headers: Object.assign({}, (typeof HOUSING_HEADERS !== 'undefined' ? HOUSING_HEADERS : {}),
          { 'Content-Type': 'application/json', 'Prefer': 'return=representation' }),
        body: JSON.stringify(row)
      });
      if (!r.ok) {
        var t = await r.text().catch(function () { return ''; });
        throw new Error('HTTP ' + r.status + ' ' + t.slice(0, 160));
      }
      var saved = await r.json().catch(function () { return []; });
      var ticket = (saved && saved[0]) || row;
      _supportNotify(ticket);
      var f = document.getElementById('support_form'), d = document.getElementById('support_done');
      if (f) f.style.display = 'none';
      if (d) d.style.display = '';
      var ref = document.getElementById('support_ref');
      if (ref && ticket.id) ref.textContent = 'Reference: ' + String(ticket.id).slice(0, 8);
      if (btn) btn.style.display = 'none';
    } catch (e) {
      console.warn('[support] submit failed:', e);
      fail('Could not send your report. Check your connection and try again. (If this keeps happening, the support_tickets migration may not be run yet.)');
      if (btn) { btn.disabled = false; btn.textContent = 'Send to help desk'; }
    }
  }

  // Best-effort email to the nation's help desk. The ticket is already stored
  // (staff see it in the queue regardless), so a failed email never blocks.
  function _supportNotify(ticket) {
    try {
      var nc = window.NATION_CONFIG || {};
      var to = nc.support_email || nc.housing_email || '';
      if (!to || typeof window.sendNotification !== 'function') return;
      var catLabel = (CATS.filter(function (c) { return c.k === ticket.category; })[0] || {}).l || ticket.category;
      var ctxUrl = (ticket.context && ticket.context.url) || '';
      var html = ''
        + '<p><strong>New support request</strong> — ' + _esc(catLabel) + '</p>'
        + '<p><strong>From:</strong> ' + _esc(ticket.reporter_name || ticket.reporter_email || 'staff')
        +   ' (' + _esc(ticket.reporter_email || '') + (ticket.reporter_role ? (' · ' + _esc(ticket.reporter_role)) : '') + ')</p>'
        + (ticket.subject ? ('<p><strong>Subject:</strong> ' + _esc(ticket.subject) + '</p>') : '')
        + '<p><strong>Details:</strong><br>' + _esc(ticket.body).replace(/\n/g, '<br>') + '</p>'
        + '<p><small>Page: ' + _esc(ctxUrl) + '</small></p>';
      window.sendNotification({ to: to, subject: 'Support request: ' + (ticket.subject || catLabel), html: html })
        .catch(function (e) { console.warn('[support] notify failed:', e); });
    } catch (e) { /* best-effort */ }
  }

  window.openSupportWidget = openSupportWidget;
  window.closeSupportWidget = closeSupportWidget;
  window._supportSubmit = _supportSubmit;
})();
