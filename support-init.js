/* ============================================================
 * support-init.js — Support triage queue (Phase S1b)
 * Staff view of public.support_tickets: list help/issue reports, open one to
 * read the details + context, reply (emails the reporter), and resolve/reopen.
 * Tickets are filed by the support widget (support-widget.js); staff triage
 * here. Gated by the `support` module.
 * ============================================================ */

'use strict';

window._supportTickets = [];
window._supQ       = '';
window._supStatus  = 'open_new';
window._supCat     = '';
window._supActiveId = null;

var SUP_CAT_LABELS = {
  app_bug: 'Bug', access: 'Sign-in / access', housing: 'Housing question',
  feature: 'Feature request', other: 'Other'
};
var SUP_SOURCE_LABELS = { staff: 'Staff', member: 'Member', contractor: 'Contractor' };

function _supHeaders() {
  return Object.assign({}, window.HOUSING_HEADERS || {}, { 'Content-Type': 'application/json' });
}
function _supEsc(s) {
  return (typeof escapeHtml === 'function') ? escapeHtml(s == null ? '' : String(s))
    : String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function _supWhen(iso) {
  if (!iso) return '—';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso).slice(0, 16);
  return d.toLocaleDateString('en-CA') + ' ' + d.toTimeString().slice(0, 5);
}
function _supStatusBadge(st) {
  st = st || 'new';
  var m = {
    new:      { l: 'New',         bg: 'var(--warn-amber-bg)', c: 'var(--warn-amber-text)' },
    open:     { l: 'In progress', bg: 'var(--info-blue-bg)',  c: 'var(--info-blue)' },
    resolved: { l: 'Resolved',    bg: 'var(--success-bg)',    c: 'var(--success)' }
  }[st] || { l: st, bg: 'var(--bg)', c: 'var(--muted)' };
  return '<span style="display:inline-block;padding:2px 9px;border-radius:10px;font-size:11px;font-weight:700;background:' + m.bg + ';color:' + m.c + ';white-space:nowrap;">' + _supEsc(m.l) + '</span>';
}

async function loadSupportTickets() {
  var tb = document.getElementById('support_tbody');
  if (tb) tb.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:40px;color:var(--muted);">Loading…</td></tr>';
  try {
    var r = await fetch(window.SUPABASE_URL + '/rest/v1/support_tickets?select=*&order=created_at.desc&limit=500', { headers: _supHeaders() });
    if (!r.ok) throw new Error(await r.text());
    window._supportTickets = await r.json();
  } catch (e) {
    console.warn('[support] load error:', e);
    window._supportTickets = [];
    if (tb) tb.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:40px;color:var(--muted);">Could not load tickets. (If this is new, the support_tickets migration may not be run yet.)</td></tr>';
    return;
  }
  renderSupportList();
}
window.loadSupportTickets = loadSupportTickets;

function renderSupportList() {
  var all = window._supportTickets || [];
  var list = all.slice();
  var q = (window._supQ || '').toLowerCase();
  if (q) list = list.filter(function (t) {
    return ((t.reporter_name || '') + ' ' + (t.reporter_email || '') + ' ' + (t.subject || '') + ' ' + (t.body || '')).toLowerCase().indexOf(q) !== -1;
  });
  var st = window._supStatus;
  if (st === 'open_new') list = list.filter(function (t) { var s = t.status || 'new'; return s === 'new' || s === 'open'; });
  else if (st) list = list.filter(function (t) { return (t.status || 'new') === st; });
  if (window._supCat) list = list.filter(function (t) { return (t.category || 'other') === window._supCat; });

  var kpi = document.getElementById('support_kpi_strip');
  if (kpi) {
    var nNew = all.filter(function (t) { return (t.status || 'new') === 'new'; }).length;
    var nOpen = all.filter(function (t) { return t.status === 'open'; }).length;
    var nRes = all.filter(function (t) { return t.status === 'resolved'; }).length;
    function card(label, val) {
      return '<div class="card" style="flex:0 0 150px;box-sizing:border-box;padding:14px 16px;">'
        + '<div style="font-size:24px;font-weight:700;color:var(--text);line-height:1.1;">' + val + '</div>'
        + '<div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-top:3px;">' + label + '</div></div>';
    }
    kpi.innerHTML = card('New', nNew) + card('In progress', nOpen) + card('Resolved', nRes);
  }

  var tb = document.getElementById('support_tbody');
  if (!tb) return;
  if (!list.length) {
    tb.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:40px;color:var(--muted);">No tickets' + (st ? ' with this filter' : '') + '.</td></tr>';
    return;
  }
  tb.innerHTML = list.map(function (t) {
    var who = _supEsc(t.reporter_name || t.reporter_email || 'Unknown');
    var src = SUP_SOURCE_LABELS[t.source] || t.source || '';
    var cat = SUP_CAT_LABELS[t.category] || t.category || '';
    var subj = _supEsc(t.subject || '(no subject)');
    var idEsc = String(t.id).replace(/'/g, "\\'");
    return '<tr style="border-bottom:1px solid var(--border);cursor:pointer;" onclick="openSupportTicket(\'' + idEsc + '\')">'
      + '<td style="padding:10px 12px;"><div style="font-weight:600;color:var(--text);">' + who + '</div>'
      +   (src ? '<div style="font-size:11px;color:var(--muted);">' + _supEsc(src) + '</div>' : '') + '</td>'
      + '<td style="padding:10px 12px;color:var(--text);white-space:nowrap;">' + _supEsc(cat) + '</td>'
      + '<td style="padding:10px 12px;color:var(--text);">' + subj + '</td>'
      + '<td style="padding:10px 12px;color:var(--muted);white-space:nowrap;">' + _supWhen(t.created_at) + '</td>'
      + '<td style="padding:10px 12px;">' + _supStatusBadge(t.status) + '</td>'
      + '<td style="padding:10px 12px;text-align:right;"><button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();openSupportTicket(\'' + idEsc + '\')">Open</button></td>'
      + '</tr>';
  }).join('');
}
window.renderSupportList = renderSupportList;

function openSupportTicket(id) {
  var t = (window._supportTickets || []).filter(function (x) { return String(x.id) === String(id); })[0];
  if (!t) return;
  window._supActiveId = id;
  var ctx = t.context || {};
  var cat = SUP_CAT_LABELS[t.category] || t.category || '';
  var src = SUP_SOURCE_LABELS[t.source] || t.source || '';
  var isResolved = (t.status === 'resolved');
  var ctxLines = [];
  if (ctx.url)        ctxLines.push('Page: ' + _supEsc(ctx.url));
  if (ctx.viewport)   ctxLines.push('Viewport: ' + _supEsc(ctx.viewport));
  if (ctx.app_version)ctxLines.push('Version: ' + _supEsc(ctx.app_version));
  if (ctx.user_agent) ctxLines.push('Browser: ' + _supEsc(ctx.user_agent));

  var modal = document.getElementById('support_modal');
  if (!modal) return;
  modal.innerHTML = ''
    + '<div class="card" style="max-width:600px;width:100%;max-height:92vh;overflow:auto;background:var(--surface);">'
    +   '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:16px 18px;border-bottom:1px solid var(--border);">'
    +     '<div><div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);">Support · ' + _supEsc(cat) + '</div>'
    +       '<div style="font-size:17px;font-weight:700;color:var(--text);margin-top:2px;">' + _supEsc(t.subject || '(no subject)') + '</div></div>'
    +     '<button type="button" onclick="closeSupportModal()" class="btn-close-sm">✕</button>'
    +   '</div>'
    +   '<div style="padding:16px 18px;">'
    +     '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:12px;">'
    +       _supStatusBadge(t.status)
    +       '<span style="font-size:12px;color:var(--muted);">' + _supWhen(t.created_at) + '</span>'
    +     '</div>'
    +     '<div style="font-size:13px;color:var(--text);margin-bottom:4px;"><strong>' + _supEsc(t.reporter_name || t.reporter_email || 'Unknown') + '</strong>'
    +       (src ? ' · ' + _supEsc(src) : '') + (t.reporter_role ? ' · ' + _supEsc(t.reporter_role) : '') + '</div>'
    +     (t.reporter_email ? '<div style="font-size:12px;color:var(--muted);margin-bottom:12px;">' + _supEsc(t.reporter_email) + (t.reporter_phone ? ' · ' + _supEsc(t.reporter_phone) : '') + '</div>' : '')
    +     '<div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px 14px;font-size:13px;color:var(--text);white-space:pre-wrap;line-height:1.5;margin-bottom:12px;">' + _supEsc(t.body || '') + '</div>'
    +     _supAttachHtml(t)
    +     (ctxLines.length ? '<div style="font-size:11px;color:var(--muted);line-height:1.6;margin-bottom:14px;word-break:break-all;">' + ctxLines.join('<br>') + '</div>' : '')
    +     _supThreadHtml(t)
    +     (isResolved
        ? '<div style="font-size:12px;color:var(--success);font-weight:600;margin-bottom:12px;">✓ Resolved' + (t.resolved_by ? ' by ' + _supEsc(t.resolved_by) : '') + (t.resolved_at ? ' · ' + _supWhen(t.resolved_at) : '') + '</div>'
        : '')
    +     '<div class="f"><label>Reply to the reporter (optional)</label>'
    +       '<textarea id="support_reply" rows="3" placeholder="' + (t.reporter_email ? 'Your reply is emailed to the reporter…' : 'No email on file — reply will be logged only…') + '" style="width:100%;box-sizing:border-box;resize:vertical;"></textarea></div>'
    +     '<div id="support_modal_err" style="display:none;color:var(--danger);font-size:12px;margin:4px 0;"></div>'
    +   '</div>'
    +   '<div style="display:flex;justify-content:space-between;gap:10px;padding:14px 18px;border-top:1px solid var(--border);flex-wrap:wrap;">'
    +     '<button type="button" onclick="closeSupportModal()" class="btn btn-ghost">Close</button>'
    +     '<div style="display:flex;gap:8px;flex-wrap:wrap;">'
    +       '<button type="button" id="support_reply_btn" onclick="_supReply()" class="btn btn-ghost">Send reply</button>'
    +       (isResolved
          ? '<button type="button" onclick="_supReopen()" class="btn btn-ghost">Reopen</button>'
          : '<button type="button" onclick="_supResolve()" class="btn btn-primary">Resolve</button>')
    +     '</div>'
    +   '</div>'
    + '</div>';
  modal.style.display = 'flex';
  modal.onclick = function (e) { if (e.target === modal) closeSupportModal(); };
}
window.openSupportTicket = openSupportTicket;

// Screenshot gallery for the triage modal. Attachments are base64 data URLs on
// the ticket's `attachments` jsonb (filed by the report widget); render clickable
// thumbnails that open a full-size in-page lightbox (avoids data:-URL popup/CSP
// blocks). Colours use var(--token,#hex) fallbacks to satisfy the colour ratchet.
function _supAttachHtml(t) {
  var atts = (t && t.attachments) || [];
  if (!atts.length) return '';
  var idEsc = String(t.id).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  var thumbs = atts.map(function (a, i) {
    if (!a || !a.dataUrl) return '';
    return '<button type="button" onclick="_supViewImg(\'' + idEsc + '\',' + i + ')" '
      + 'style="padding:0;border:1px solid var(--border);border-radius:8px;overflow:hidden;width:72px;height:72px;cursor:pointer;background:var(--bg);flex:0 0 auto;">'
      + '<img src="' + a.dataUrl + '" alt="" style="width:100%;height:100%;object-fit:cover;display:block;"/></button>';
  }).join('');
  if (!thumbs) return '';
  return '<div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px;">Screenshots (' + atts.length + ')</div>'
    + '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;">' + thumbs + '</div>';
}
function _supViewImg(id, i) {
  var t = (window._supportTickets || []).filter(function (x) { return String(x.id) === String(id); })[0];
  var a = t && t.attachments && t.attachments[i];
  if (!a || !a.dataUrl) return;
  var lb = document.getElementById('support_imgview');
  if (!lb) {
    lb = document.createElement('div');
    lb.id = 'support_imgview';
    lb.style.cssText = 'position:fixed;inset:0;z-index:100000;background:var(--scrim,#0b0b0b);display:flex;align-items:center;justify-content:center;padding:20px;cursor:zoom-out;';
    lb.onclick = function () { lb.style.display = 'none'; };
    document.body.appendChild(lb);
  }
  lb.innerHTML = '<img src="' + a.dataUrl + '" alt="" style="max-width:96vw;max-height:92vh;border-radius:8px;"/>';
  lb.style.display = 'flex';
}
window._supViewImg = _supViewImg;

function _supThreadHtml(t) {
  var tr = Array.isArray(t.transcript) ? t.transcript : [];
  var replies = tr.filter(function (m) { return m && m.role === 'staff'; });
  if (!replies.length) return '';
  return '<div style="margin-bottom:12px;"><div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:6px;">Replies</div>'
    + replies.map(function (m) {
        return '<div style="border-left:2px solid var(--border);padding:4px 0 4px 10px;margin-bottom:6px;font-size:12px;color:var(--text);white-space:pre-wrap;">' + _supEsc(m.text || '')
          + '<div style="font-size:10px;color:var(--muted);margin-top:2px;">' + _supEsc(m.by || '') + (m.at ? ' · ' + _supWhen(m.at) : '') + '</div></div>';
      }).join('')
    + '</div>';
}

function closeSupportModal() {
  var modal = document.getElementById('support_modal');
  if (modal) { modal.style.display = 'none'; modal.innerHTML = ''; }
}
window.closeSupportModal = closeSupportModal;

async function _supPatch(id, patch) {
  patch.updated_at = new Date().toISOString();
  var r = await fetch(window.SUPABASE_URL + '/rest/v1/support_tickets?id=eq.' + encodeURIComponent(id), {
    method: 'PATCH',
    headers: Object.assign({}, _supHeaders(), { 'Prefer': 'return=representation' }),
    body: JSON.stringify(patch)
  });
  if (!r.ok) throw new Error(await r.text());
  var rows = await r.json().catch(function () { return []; });
  var row = rows[0];
  if (row) {
    var i = (window._supportTickets || []).findIndex(function (x) { return String(x.id) === String(id); });
    if (i >= 0) window._supportTickets[i] = row;
  }
  return row;
}

function _supMe() { return (typeof HOUSING_SESSION !== 'undefined' && HOUSING_SESSION && (HOUSING_SESSION.name || HOUSING_SESSION.email)) || (window.currentRole || 'staff'); }

async function _supReply() {
  var id = window._supActiveId;
  var t = (window._supportTickets || []).filter(function (x) { return String(x.id) === String(id); })[0];
  if (!t) return;
  var txt = ((document.getElementById('support_reply') || {}).value || '').trim();
  var err = document.getElementById('support_modal_err');
  if (!txt) { if (err) { err.textContent = 'Type a reply first.'; err.style.display = 'block'; } return; }
  var btn = document.getElementById('support_reply_btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
  if (err) err.style.display = 'none';
  try {
    // Email the reporter when an address is on file (best-effort).
    if (t.reporter_email && typeof window.sendNotification === 'function') {
      var html = '<p>Reply from the housing help desk about your support request'
        + (t.subject ? ' “' + _supEsc(t.subject) + '”' : '') + ':</p>'
        + '<p>' + _supEsc(txt).replace(/\n/g, '<br>') + '</p>';
      try { await window.sendNotification({ to: t.reporter_email, subject: 'Re: ' + (t.subject || 'your support request'), html: html }); }
      catch (e) { console.warn('[support] reply email failed:', e); }
    }
    var thread = Array.isArray(t.transcript) ? t.transcript.slice() : [];
    thread.push({ role: 'staff', by: _supMe(), text: txt, at: new Date().toISOString() });
    var patch = { transcript: thread };
    if ((t.status || 'new') === 'new') patch.status = 'open';   // first reply moves it to in-progress
    await _supPatch(id, patch);
    if (typeof showToast === 'function') showToast(t.reporter_email ? 'Reply sent.' : 'Reply logged (no email on file).', { type: 'info' });
    openSupportTicket(id);   // re-render the modal with the new reply + status
    renderSupportList();
  } catch (e) {
    console.warn('[support] reply failed:', e);
    if (err) { err.textContent = 'Could not save the reply. Try again.'; err.style.display = 'block'; }
    if (btn) { btn.disabled = false; btn.textContent = 'Send reply'; }
  }
}
window._supReply = _supReply;

async function _supResolve() {
  var id = window._supActiveId; if (!id) return;
  try {
    await _supPatch(id, { status: 'resolved', resolved_by: _supMe(), resolved_at: new Date().toISOString() });
    if (typeof showToast === 'function') showToast('Ticket resolved.', { type: 'info' });
    closeSupportModal();
    renderSupportList();
  } catch (e) { console.warn('[support] resolve failed:', e); if (typeof showToast === 'function') showToast('Could not resolve the ticket.', { type: 'error' }); }
}
window._supResolve = _supResolve;

async function _supReopen() {
  var id = window._supActiveId; if (!id) return;
  try {
    await _supPatch(id, { status: 'open', resolved_by: null, resolved_at: null });
    if (typeof showToast === 'function') showToast('Ticket reopened.', { type: 'info' });
    openSupportTicket(id);
    renderSupportList();
  } catch (e) { console.warn('[support] reopen failed:', e); if (typeof showToast === 'function') showToast('Could not reopen the ticket.', { type: 'error' }); }
}
window._supReopen = _supReopen;

// ── Boot (mirrors mail-init.js) ───────────────────────────────────────────────
(async function initSupportPage() {
  try {
    var token = sessionStorage.getItem('clfn_housing_token');
    if (!token) { window.location.href = 'index.html'; return; }

    var savedRole  = sessionStorage.getItem('clfn_housing_role')          || 'housing_employee_l1';
    var savedName  = sessionStorage.getItem('clfn_housing_name')          || '';
    var savedEmail = sessionStorage.getItem('clfn_housing_email_session') || '';
    if (typeof HOUSING_HEADERS !== 'undefined') HOUSING_HEADERS['Authorization'] = 'Bearer ' + token;
    if (typeof HOUSING_SESSION !== 'undefined') {
      HOUSING_SESSION.accessToken = token; HOUSING_SESSION.role = savedRole;
      HOUSING_SESSION.name = savedName; HOUSING_SESSION.email = savedEmail;
    }
    window.currentRole = savedRole; window._realRole = savedRole;

    if (typeof resolveHousingRole === 'function') { try { await resolveHousingRole(); } catch (e) {} }
    var role = (typeof HOUSING_SESSION !== 'undefined' && HOUSING_SESSION.role) || savedRole;
    window.currentRole = role; window._realRole = role;

    if (typeof initModuleEnablement === 'function') try { initModuleEnablement(); } catch (e) {}
    if (window.CLFN_MODULES && !window.CLFN_MODULES.isEnabled('support')) {
      if (typeof showModuleDisabledNotice === 'function') showModuleDisabledNotice('Help & Support');
      else window.location.href = 'housing.html';
      return;
    }

    if (typeof updateHeaderUser             === 'function') updateHeaderUser(role);
    if (typeof updateRoleSwitcherVisibility === 'function') updateRoleSwitcherVisibility();
    if (typeof renderHeaderNav              === 'function') renderHeaderNav();
    if (typeof applyRoleVisibility          === 'function') applyRoleVisibility(role);
    if (typeof setHeaderNavActive           === 'function') setHeaderNavActive('admin');
    if (document.body) document.body.style.opacity = '1';

    if (typeof loadHousingData === 'function') { try { await loadHousingData(); } catch (e) {} }
    if (typeof initModuleEnablement === 'function') try { initModuleEnablement(); } catch (e) {}
    if (typeof moduleOn === 'function' && !moduleOn('support')) {
      if (typeof showModuleDisabledNotice === 'function') showModuleDisabledNotice('Help & Support');
      else window.location.href = 'housing.html';
      return;
    }

    var view = document.getElementById('supportView');
    if (view) view.style.display = 'flex';
    await loadSupportTickets();

    // Deep link from the landing-page worklist (support.html?ticket=<id>):
    // open that ticket's triage modal once the list has loaded.
    try {
      var _tp = new URLSearchParams(window.location.search).get('ticket');
      if (_tp && typeof openSupportTicket === 'function') openSupportTicket(_tp);
    } catch (e) { /* bad/stale id -> just show the list */ }
  } catch (e) {
    console.error('[support] init error:', e);
  } finally {
    if (document.body) document.body.style.opacity = '1';
  }
}());
