/* ============================================================
 * mail-init.js — CLFN Housing Suite
 * Email Intake triage: list forwarded emails, assign to a unit /
 * tenant (files attachments + body to the unit's documents), or dismiss.
 * Rows are created by the `email-intake` Edge Function (Cloudflare Email
 * Routing). Triage-first: nothing is auto-filed.
 * ============================================================ */

'use strict';

window._emailIntake = [];
window._mailQ       = '';
window._mailStatus  = 'new';
window._mailUnitSS  = null;
window._mailActiveId = null;

function _mailHeaders() {
  return Object.assign({}, window.HOUSING_HEADERS || {}, { 'Content-Type': 'application/json' });
}
function _mailEsc(s) {
  return (typeof escapeHtml === 'function') ? escapeHtml(s == null ? '' : String(s))
    : String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function _mailFmtWhen(iso) {
  if (!iso) return '—';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso).slice(0, 16);
  return d.toLocaleDateString('en-CA') + ' ' + d.toTimeString().slice(0, 5);
}

async function _mailLoadUnits() {
  if (window.housingUnits && window.housingUnits.length) return;
  try {
    var r = await fetch(window.SUPABASE_URL + '/rest/v1/housing_units?select=id,num,street,assigned_name,archived&order=street,num&limit=9999', { headers: _mailHeaders() });
    if (!r.ok) return;
    var data = await r.json();
    window.housingUnits = data.map(function(row){ return { id: row.id, num: row.num, street: row.street, assignedName: row.assigned_name, archived: !!row.archived }; });
  } catch(e) { console.warn('[mail] units load:', e); }
}

async function loadEmailIntake() {
  var tb = document.getElementById('mail_tbody');
  if (tb) tb.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:40px;color:var(--muted);">Loading…</td></tr>';
  try {
    var r = await fetch(window.SUPABASE_URL + '/rest/v1/email_intake?select=*&order=created_at.desc&limit=500', { headers: _mailHeaders() });
    if (!r.ok) throw new Error(await r.text());
    window._emailIntake = await r.json();
  } catch(e) {
    console.warn('[mail] load error:', e);
    window._emailIntake = [];
  }
  renderEmailIntakeList();
}
window.loadEmailIntake = loadEmailIntake;

function renderEmailIntakeList() {
  var all  = window._emailIntake || [];
  var list = all.slice();
  var q = (window._mailQ || '').toLowerCase();
  if (q) list = list.filter(function(m){ return ((m.from_email||'') + ' ' + (m.from_name||'') + ' ' + (m.subject||'')).toLowerCase().indexOf(q) !== -1; });
  if (window._mailStatus) list = list.filter(function(m){ return (m.status||'new') === window._mailStatus; });

  // KPI strip
  var kpi = document.getElementById('mail_kpi_strip');
  if (kpi) {
    var nNew = all.filter(function(m){ return (m.status||'new')==='new'; }).length;
    var nAsg = all.filter(function(m){ return m.status==='assigned'; }).length;
    var nDis = all.filter(function(m){ return m.status==='dismissed'; }).length;
    function card(label, val) {
      return '<div class="card" style="padding:12px 16px;min-width:120px;">'
        + '<div style="font-size:22px;font-weight:600;color:var(--text);">' + val + '</div>'
        + '<div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;">' + label + '</div></div>';
    }
    kpi.innerHTML = card('Needs filing', nNew) + card('Filed', nAsg) + card('Dismissed', nDis);
  }

  var tb = document.getElementById('mail_tbody');
  if (!tb) return;
  if (!list.length) {
    tb.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:40px;color:var(--muted);">No emails' + (window._mailStatus ? ' with this status' : '') + '.</td></tr>';
    return;
  }
  tb.innerHTML = list.map(function(m){
    var atts = Array.isArray(m.attachments) ? m.attachments.length : 0;
    var sugg = Array.isArray(m.suggested_match) ? m.suggested_match : [];
    var suggLabel = sugg.length ? _mailEsc(sugg[0].label || '') + (sugg.length > 1 ? ' +' + (sugg.length - 1) : '') : '<span style="color:var(--muted);">—</span>';
    var statusLbl = (m.status === 'assigned') ? 'Filed' : (m.status === 'dismissed') ? 'Dismissed' : 'Needs filing';
    var actionBtn = (m.status === 'new')
      ? '<button class="btn btn-primary" style="padding:5px 12px;font-size:12px;" onclick="openMailTriage(\'' + m.id + '\')">Triage &rarr;</button>'
      : '<button class="btn btn-ghost" style="padding:5px 12px;font-size:12px;" onclick="openMailTriage(\'' + m.id + '\')">View</button>';
    return '<tr style="border-bottom:1px solid var(--border);">'
      + '<td style="padding:10px 12px;">' + _mailEsc(m.from_name || m.from_email || '—') + '<div style="font-size:11px;color:var(--muted);">' + _mailEsc(m.from_name ? (m.from_email||'') : '') + '</div></td>'
      + '<td style="padding:10px 12px;max-width:280px;">' + _mailEsc(m.subject || '(no subject)') + '</td>'
      + '<td style="padding:10px 12px;white-space:nowrap;color:var(--muted);">' + _mailFmtWhen(m.created_at) + '</td>'
      + '<td style="padding:10px 12px;text-align:center;">' + (atts || '—') + '</td>'
      + '<td style="padding:10px 12px;">' + suggLabel + '</td>'
      + '<td style="padding:10px 12px;white-space:nowrap;color:var(--muted);">' + statusLbl + '</td>'
      + '<td style="padding:10px 12px;text-align:right;">' + actionBtn + '</td>'
      + '</tr>';
  }).join('');
}
window.renderEmailIntakeList = renderEmailIntakeList;

function closeMailTriage() {
  var m = document.getElementById('mail_modal');
  if (m) { m.style.display = 'none'; m.innerHTML = ''; }
  window._mailActiveId = null;
  window._mailUnitSS = null;
}
window.closeMailTriage = closeMailTriage;

async function openMailTriage(id) {
  var row = (window._emailIntake || []).filter(function(m){ return m.id === id; })[0];
  if (!row) return;
  window._mailActiveId = id;
  var modal = document.getElementById('mail_modal');
  if (!modal) return;

  var atts = Array.isArray(row.attachments) ? row.attachments : [];
  var sugg = Array.isArray(row.suggested_match) ? row.suggested_match : [];
  var isNew = (row.status || 'new') === 'new';

  var suggHtml = sugg.length
    ? sugg.map(function(s){
        var label = _mailEsc(s.label || '') + (s.reason ? ' — ' + _mailEsc(s.reason) : '');
        var uid = _mailEsc(s.unitId || '');
        return uid
          ? '<button type="button" class="btn btn-ghost" style="font-size:12px;margin:0 6px 6px 0;" onclick="_mailPickSuggestion(\'' + uid + '\',\'' + _mailEsc((s.label||'').replace(/\x27/g,"\\x27")) + '\')">' + label + '</button>'
          : '<span style="display:inline-block;font-size:12px;color:var(--muted);margin:0 6px 6px 0;padding:4px 0;">' + label + ' (name only — pick the unit below)</span>';
      }).join('')
    : '<span style="font-size:12px;color:var(--muted);">No automatic match — pick the unit below.</span>';

  var attHtml = atts.length
    ? atts.map(function(a, i){
        var ap = _mailEsc((a.path||'').replace(/\x27/g,"\\x27"));
        var an = _mailEsc((a.name || ('attachment ' + (i+1))).replace(/\x27/g,"\\x27"));
        return '<div style="display:flex;align-items:center;gap:8px;padding:4px 0;font-size:12.5px;">'
          + '<span>📎 ' + _mailEsc(a.name || ('attachment ' + (i+1))) + '</span>'
          + '<button type="button" class="btn btn-ghost" style="padding:2px 8px;font-size:11px;" onclick="_mailOpenAttachment(\'' + ap + '\',\'' + an + '\')">View</button>'
          + '</div>';
      }).join('') + '<div style="font-size:11px;color:var(--muted);margin-top:4px;">⚠ Attachments are from an unverified external sender — scan before opening.</div>'
    : '<div style="font-size:12px;color:var(--muted);">No attachments.</div>';

  var bodyLink = row.body_path
    ? '<button type="button" class="btn btn-ghost" style="padding:2px 8px;font-size:11px;" onclick="_mailViewFile(\'' + _mailEsc(String(row.body_path).replace(/\x27/g,"\\x27")) + '\')">Open full email</button>'
    : '';

  modal.innerHTML =
    '<div class="card" style="max-width:640px;width:100%;max-height:90vh;overflow:auto;padding:0;">'
    + '<div class="modal-hdr" style="display:flex;justify-content:space-between;align-items:center;padding:14px 18px;">'
    +   '<div class="modal-hdr-title">Triage forwarded email</div>'
    +   '<button type="button" class="btn-close-dark-30" onclick="closeMailTriage()">&times;</button>'
    + '</div>'
    + '<div style="padding:16px 18px;display:flex;flex-direction:column;gap:14px;">'
    +   '<div>'
    +     '<div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;">From</div>'
    +     '<div style="font-size:13px;color:var(--text);">' + _mailEsc(row.from_name || '') + ' &lt;' + _mailEsc(row.from_email || '') + '&gt;</div>'
    +     '<div style="font-size:11px;color:var(--muted);margin-top:6px;">Received ' + _mailFmtWhen(row.created_at) + '</div>'
    +   '</div>'
    +   '<div>'
    +     '<div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;">Subject</div>'
    +     '<div style="font-size:14px;font-weight:600;color:var(--text);">' + _mailEsc(row.subject || '(no subject)') + '</div>'
    +   '</div>'
    +   '<div>'
    +     '<div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;">Preview</div>'
    +     '<div style="font-size:12.5px;color:var(--text);white-space:pre-wrap;max-height:120px;overflow:auto;">' + _mailEsc(row.body_preview || '(no text)') + '</div>'
    +     '<div style="margin-top:6px;">' + bodyLink + '</div>'
    +   '</div>'
    +   '<div>'
    +     '<div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px;">Attachments</div>'
    +     attHtml
    +   '</div>'
    + (isNew
      ? ('<div style="border-top:1px solid var(--border);padding-top:14px;">'
        +   '<div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px;">Suggested match</div>'
        +   '<div style="margin-bottom:10px;">' + suggHtml + '</div>'
        +   '<div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px;">File to unit</div>'
        +   '<div id="mail_unit_wrap"></div>'
        +   '<div style="margin-top:10px;"><label style="font-size:11px;color:var(--muted);">Note (optional)</label>'
        +     '<textarea id="mail_assign_note" rows="2" class="tic-input" style="width:100%;box-sizing:border-box;" placeholder="Why / what this is…"></textarea></div>'
        + '</div>'
        + '<div style="display:flex;justify-content:space-between;gap:8px;border-top:1px solid var(--border);padding-top:14px;">'
        +   '<button type="button" class="btn btn-ghost" onclick="dismissEmailIntake()">Dismiss</button>'
        +   '<div style="display:flex;gap:8px;">'
        +     '<button type="button" class="btn btn-ghost" onclick="closeMailTriage()">Cancel</button>'
        +     '<button type="button" class="btn btn-primary" onclick="assignEmailIntake()">File to unit &rarr;</button>'
        +   '</div>'
        + '</div>')
      : ('<div style="border-top:1px solid var(--border);padding-top:14px;font-size:12.5px;color:var(--muted);">'
        +   (row.status === 'assigned'
              ? ('Filed to ' + _mailEsc(row.matched_tenant_name || row.matched_unit_id || 'a unit') + (row.assigned_by ? ' by ' + _mailEsc(row.assigned_by) : '') + '.')
              : 'This email was dismissed' + (row.assigned_by ? ' by ' + _mailEsc(row.assigned_by) : '') + '.')
        +   (row.assign_notes ? '<div style="margin-top:6px;">Note: ' + _mailEsc(row.assign_notes) + '</div>' : '')
        + '</div>'
        + '<div style="display:flex;justify-content:flex-end;border-top:1px solid var(--border);padding-top:14px;">'
        +   '<button type="button" class="btn btn-ghost" onclick="closeMailTriage()">Close</button>'
        + '</div>'))
    + '</div>'
    + '</div>';

  modal.style.display = 'flex';

  if (isNew) {
    var unitItems = (window.housingUnits || [])
      .filter(function(u){ return !u.archived; })
      .map(function(u){ return { id: u.id, label: ((u.num||'') + (u.num&&u.street?' ':'') + (u.street||'')) || u.id }; })
      .sort(function(a,b){ return a.label.localeCompare(b.label); });
    var wrap = document.getElementById('mail_unit_wrap');
    if (wrap && typeof clfnSearchSelect === 'function') {
      window._mailUnitSS = clfnSearchSelect({
        wrap: wrap, items: unitItems, value: '',
        placeholder: 'Search address…',
        onChange: function(id2, label){ window._mailUnitSS._selectedId = id2; window._mailUnitSS._selectedLabel = label; }
      });
      // Pre-select the top suggested unit, if any.
      var firstUnit = (sugg.filter(function(s){ return s.unitId; })[0] || {}).unitId;
      if (firstUnit && window._mailUnitSS && typeof window._mailUnitSS.setValue === 'function') {
        try { window._mailUnitSS.setValue(firstUnit); window._mailUnitSS._selectedId = firstUnit; } catch(e) {}
      }
    }
  }
}
window.openMailTriage = openMailTriage;

function _mailPickSuggestion(unitId, label) {
  if (window._mailUnitSS) {
    window._mailUnitSS._selectedId = unitId;
    window._mailUnitSS._selectedLabel = label;
    if (typeof window._mailUnitSS.setValue === 'function') { try { window._mailUnitSS.setValue(unitId); } catch(e) {} }
  }
  if (typeof showToast === 'function') showToast('Unit selected: ' + (label || unitId), { type: 'info' });
}
window._mailPickSuggestion = _mailPickSuggestion;

async function _mailViewFile(path) {
  if (!path) return;
  try {
    var url = (typeof sbGetSignedUrl === 'function') ? await sbGetSignedUrl(path) : '';
    if (url) window.open(url, '_blank');
    else if (typeof showToast === 'function') showToast('Could not open the file.', { type: 'error' });
  } catch(e) { if (typeof showToast === 'function') showToast('Could not open the file.', { type: 'error' }); }
}
window._mailViewFile = _mailViewFile;

// Attachments come from an EXTERNAL, unauthenticated sender and are unverified.
// Warn before opening one so staff treat it like any untrusted download (scan
// first, don't open if the source isn't trusted). The email BODY is stored as
// plain text so it needs no warning; attachments are the risk surface.
async function _mailOpenAttachment(path, name) {
  if (!path) return;
  var msg = 'This file was received by email from an external, unverified sender'
    + (name ? ' (' + name + ')' : '') + '. Only open it if you trust the source, and scan it first. Continue?';
  var okToOpen = true;
  if (typeof showConfirm === 'function') {
    okToOpen = await showConfirm({ title: 'Unverified external file', message: msg, confirmText: 'Open anyway', cancelText: 'Cancel' });
  } else {
    okToOpen = window.confirm(msg);
  }
  if (okToOpen) _mailViewFile(path);
}
window._mailOpenAttachment = _mailOpenAttachment;

async function _mailPatchRow(id, patch) {
  var r = await fetch(window.SUPABASE_URL + '/rest/v1/email_intake?id=eq.' + encodeURIComponent(id), {
    method: 'PATCH',
    headers: Object.assign({}, _mailHeaders(), { 'Prefer': 'return=minimal' }),
    body: JSON.stringify(patch)
  });
  if (!r.ok) throw new Error(await r.text());
}

async function assignEmailIntake() {
  var id = window._mailActiveId;
  var row = (window._emailIntake || []).filter(function(m){ return m.id === id; })[0];
  if (!row) return;
  var unitId = (window._mailUnitSS && window._mailUnitSS._selectedId) || '';
  if (!unitId) { if (typeof showToast === 'function') showToast('Pick a unit to file this email to.', { type: 'info' }); return; }

  var unit = (window.housingUnits || []).filter(function(u){ return String(u.id) === String(unitId); })[0] || {};
  var tenantName = unit.assignedName || (window._mailUnitSS && window._mailUnitSS._selectedLabel) || '';
  var note = (document.getElementById('mail_assign_note') || {}).value || '';
  var actor = (window.HOUSING_SESSION && window.HOUSING_SESSION.email) || window.currentRole || 'staff';

  if (typeof showToast === 'function') showToast('Filing to unit…', { type: 'info' });

  var filed = [];
  try {
    // File each attachment to the unit's document library (entity 'tenant' +
    // unit id). The objects already live in Storage under email-intake/<id>/,
    // so we only record the file-meta rows -- no re-upload (same one-object,
    // many-entities pattern fileContractPdf uses).
    var atts = Array.isArray(row.attachments) ? row.attachments : [];
    for (var i = 0; i < atts.length; i++) {
      var a = atts[i];
      if (!a || !a.path) continue;
      if (typeof sbSaveFileMeta === 'function') {
        await sbSaveFileMeta('tenant', String(unitId), a.path, a.name || ('attachment-' + (i+1)), a.size || 0, a.contentType || 'application/octet-stream');
        filed.push(a.path);
      }
    }
    // File the email body too, so the message itself is on the unit file.
    if (row.body_path && typeof sbSaveFileMeta === 'function') {
      var isHtml = /\.html$/i.test(row.body_path);
      var bodyName = 'Email - ' + String(row.subject || 'message').slice(0, 80) + (isHtml ? '.html' : '.txt');
      await sbSaveFileMeta('tenant', String(unitId), row.body_path, bodyName, 0, isHtml ? 'text/html' : 'text/plain');
      filed.push(row.body_path);
    }

    await _mailPatchRow(id, {
      status: 'assigned', matched_unit_id: String(unitId), matched_tenant_name: tenantName || null,
      filed_paths: filed, assigned_by: actor, assigned_at: new Date().toISOString(), assign_notes: note || null
    });

    if (typeof auditEntry === 'function') {
      auditEntry(String(unitId), 'email_filed',
        'Filed forwarded email "' + (row.subject || '(no subject)') + '" from ' + (row.from_email || 'unknown')
        + (filed.length ? ' (' + filed.length + ' file(s))' : '') + (note ? ' — ' + note : ''), actor);
    }

    // Reflect locally + refresh.
    row.status = 'assigned'; row.matched_unit_id = String(unitId); row.matched_tenant_name = tenantName; row.filed_paths = filed;
    if (typeof showToast === 'function') showToast('Filed to ' + (tenantName || unit.num + ' ' + unit.street || 'unit') + ' — see the unit\'s Documents.', { type: 'info' });
    closeMailTriage();
    renderEmailIntakeList();
    // Keep the unit doc library fresh if it's mounted anywhere on this page.
    if (typeof udpRenderFilePreviews === 'function') { try { udpRenderFilePreviews(String(unitId)); } catch(e) {} }
  } catch(e) {
    console.warn('[mail] assign failed:', e);
    if (typeof showToast === 'function') showToast('Could not file the email: ' + ((e && e.message) || e), { type: 'error' });
  }
}
window.assignEmailIntake = assignEmailIntake;

async function dismissEmailIntake() {
  var id = window._mailActiveId;
  var row = (window._emailIntake || []).filter(function(m){ return m.id === id; })[0];
  if (!row) return;
  var note = (document.getElementById('mail_assign_note') || {}).value || '';
  var actor = (window.HOUSING_SESSION && window.HOUSING_SESSION.email) || window.currentRole || 'staff';
  try {
    await _mailPatchRow(id, { status: 'dismissed', assigned_by: actor, assigned_at: new Date().toISOString(), assign_notes: note || null });
    if (typeof auditEntry === 'function') {
      auditEntry('EMAIL:' + id, 'email_dismissed', 'Dismissed forwarded email "' + (row.subject || '') + '" from ' + (row.from_email || 'unknown') + (note ? ' — ' + note : ''), actor);
    }
    row.status = 'dismissed';
    if (typeof showToast === 'function') showToast('Email dismissed.', { type: 'info' });
    closeMailTriage();
    renderEmailIntakeList();
  } catch(e) {
    console.warn('[mail] dismiss failed:', e);
    if (typeof showToast === 'function') showToast('Could not dismiss: ' + ((e && e.message) || e), { type: 'error' });
  }
}
window.dismissEmailIntake = dismissEmailIntake;

// ── Page init ────────────────────────────────────────────────────────────────
(async function initMailPage() {
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

    if (typeof resolveHousingRole === 'function') { try { await resolveHousingRole(); } catch(e) {} }
    var role = (typeof HOUSING_SESSION !== 'undefined' && HOUSING_SESSION.role) || savedRole;
    window.currentRole = role; window._realRole = role;

    if (typeof initModuleEnablement === 'function') try { initModuleEnablement(); } catch(e) {}
    if (window.CLFN_MODULES && !window.CLFN_MODULES.isEnabled('email_intake')) {
      if (typeof showModuleDisabledNotice === 'function') showModuleDisabledNotice('Email Intake');
      else window.location.href = 'housing.html';
      return;
    }

    if (typeof updateHeaderUser             === 'function') updateHeaderUser(role);
    if (typeof updateRoleSwitcherVisibility === 'function') updateRoleSwitcherVisibility();
    if (typeof renderHeaderNav              === 'function') renderHeaderNav();
    if (typeof applyRoleVisibility          === 'function') applyRoleVisibility(role);
    if (typeof setHeaderNavActive           === 'function') setHeaderNavActive('operations');

    if (typeof loadHousingData === 'function') { try { await loadHousingData(); } catch(e) {} }
    // Module re-check after settings hydration (direct-URL fail-open guard).
    if (typeof initModuleEnablement === 'function') try { initModuleEnablement(); } catch(e) {}
    if (typeof moduleOn === 'function' && !moduleOn('email_intake')) {
      if (typeof showModuleDisabledNotice === 'function') showModuleDisabledNotice('Email Intake');
      else window.location.href = 'housing.html';
      return;
    }

    var view = document.getElementById('mailView');
    if (view) view.style.display = 'flex';

    await _mailLoadUnits();
    await loadEmailIntake();
  } catch(e) {
    console.error('[mail] init error:', e);
  } finally {
    document.body.style.opacity = '1';
  }
}());
