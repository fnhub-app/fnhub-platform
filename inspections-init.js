/* ============================================================
 * inspections-init.js — CLFN Housing Suite
 * Inspection records: list, create, edit, PDF, SOW creation
 * ============================================================ */

'use strict';

// ── State ────────────────────────────────────────────────────────────────────
window._inspections       = [];   // all inspection records
window._inspEditId        = null; // id of inspection being edited (null = new)
window._inspDocEntityId   = null; // entity scope for the document library
window._inspUnitFilter    = '';
window._inspTypeFilter    = '';
window._inspStatusFilter  = '';

var INSP_TYPES    = ['Move-In','Move-Out','Annual','Routine','Emergency'];

// Annual inspection cadence. Given an inspection date + type, return the next
// due date (YYYY-MM-DD) to stamp on the unit:
//   Move-Out  -> null  (unit is being vacated; no next inspection scheduled)
//   Emergency -> undefined (ad hoc; leave the existing schedule untouched)
//   others    -> +12 months (Move-In starts the annual clock)
var INSPECTION_CADENCE_MONTHS = 12;
function _inspComputeNextDue(dateStr, type){
  if(type === 'Move-Out')  return null;
  if(type === 'Emergency') return undefined;
  if(!dateStr) return undefined;
  var d = new Date(dateStr + 'T00:00:00');
  if(isNaN(d.getTime())) return undefined;
  d.setMonth(d.getMonth() + INSPECTION_CADENCE_MONTHS);
  var mm = ('0' + (d.getMonth() + 1)).slice(-2), dd = ('0' + d.getDate()).slice(-2);
  return d.getFullYear() + '-' + mm + '-' + dd;
}
window._inspComputeNextDue = _inspComputeNextDue;
var INSP_STATUSES = ['pending','pass','fail','needs_repair'];

// Checklist template — sections with items
var INSP_CHECKLIST_TEMPLATE = [
  { section: 'Exterior', items: ['Foundation / Structure','Roof condition','Siding / Exterior walls','Windows & screens','Doors & locks','Driveway / Walkway','Deck / Porch / Steps'] },
  { section: 'Interior – General', items: ['Walls & ceilings','Floors','Doors & hardware','Smoke detectors','Carbon monoxide detector','Fire extinguisher','Pest evidence'] },
  { section: 'Kitchen', items: ['Cabinets & counters','Sink & faucet','Stove / Range','Refrigerator','Dishwasher','Exhaust fan','Plumbing – no leaks'] },
  { section: 'Bathroom(s)', items: ['Toilet','Sink & faucet','Tub / Shower','Caulking & grout','Exhaust fan','Plumbing – no leaks'] },
  { section: 'Bedrooms', items: ['Windows & locks','Closets','Flooring','Walls & ceilings'] },
  { section: 'Mechanical', items: ['Furnace / Heating system','Water heater','Electrical panel','Plumbing – main lines','Ventilation','Air conditioning (if applicable)'] },
  { section: 'Utility Connections', items: ['Hydro meter','Gas meter','Water shut-off accessible'] },
];

// ── Supabase helpers ─────────────────────────────────────────────────────────
function _inspHeaders() {
  return Object.assign({}, window.HOUSING_HEADERS || {}, { 'Content-Type': 'application/json' });
}

async function _inspLoadUnits() {
  // Already populated by loadHousingData -- skip the redundant full-table
  // fetch (it used to fetch every time, then discard the result when units
  // were already loaded).
  if (window.housingUnits && window.housingUnits.length) return;
  try {
    var r = await fetch(
      window.SUPABASE_URL + '/rest/v1/housing_units?select=id,num,street,archived&order=street,num&limit=9999',
      { headers: _inspHeaders() }
    );
    if (!r.ok) return;
    var data = await r.json();
    window.housingUnits = data.map(function(row) {
      return { id: row.id, num: row.num, street: row.street, archived: !!row.archived };
    });
  } catch(e) { console.warn('[Inspections] units load:', e); }
}

async function _inspLoad() {
  try {
    var r = await fetch(
      window.SUPABASE_URL + '/rest/v1/inspections?select=*&order=inspection_date.desc&limit=500',
      { headers: _inspHeaders() }
    );
    if (!r.ok) throw new Error(await r.text());
    window._inspections = await r.json();
  } catch(e) {
    console.warn('[Inspections] load error:', e);
    window._inspections = [];
  }
}

async function _inspSave(record, isNew) {
  var url = window.SUPABASE_URL + '/rest/v1/inspections';
  var method, headers;
  if (isNew) {
    method  = 'POST';
    headers = Object.assign({}, _inspHeaders(), { 'Prefer': 'return=representation' });
  } else {
    method  = 'PATCH';
    url    += '?id=eq.' + encodeURIComponent(record.id);
    headers = Object.assign({}, _inspHeaders(), { 'Prefer': 'return=representation' });
  }
  var r = await fetch(url, { method: method, headers: headers, body: JSON.stringify(record) });
  if (!r.ok) throw new Error(await r.text());
  var rows = await r.json();
  return (rows && rows[0]) || record;
}

async function _inspDelete(id) {
  var r = await fetch(
    window.SUPABASE_URL + '/rest/v1/inspections?id=eq.' + encodeURIComponent(id),
    { method: 'DELETE', headers: _inspHeaders() }
  );
  if (!r.ok) throw new Error(await r.text());
}

// ── Render: list view ────────────────────────────────────────────────────────
function renderInspectionsList() {
  var list = window._inspections || [];

  // Apply filters
  if (window._inspUnitFilter)   list = list.filter(function(i){ return (i.unit_address||'').toLowerCase().indexOf(window._inspUnitFilter.toLowerCase()) !== -1; });
  if (window._inspTypeFilter)   list = list.filter(function(i){ return i.type === window._inspTypeFilter; });
  if (window._inspStatusFilter) list = list.filter(function(i){ return i.overall_status === window._inspStatusFilter; });

  // KPIs
  var all    = window._inspections;
  var kpiEl  = document.getElementById('insp_kpi_strip');
  if (kpiEl) {
    var total   = all.length;
    var pass    = all.filter(function(i){ return i.overall_status === 'pass'; }).length;
    var repairs = all.filter(function(i){ return i.overall_status === 'needs_repair'; }).length;
    var fail    = all.filter(function(i){ return i.overall_status === 'fail'; }).length;
    var thisYr  = all.filter(function(i){ return (i.inspection_date||'').startsWith(new Date().getFullYear()+''); }).length;
    kpiEl.innerHTML =
      _inspKpi(total,   'Total')         +
      _inspKpi(pass,    'Pass',    'pass') +
      _inspKpi(repairs, 'Needs Repair','needs_repair') +
      _inspKpi(fail,    'Fail',    'fail') +
      _inspKpi(thisYr,  'This Year');
  }

  var tbody = document.getElementById('insp_tbody');
  if (!tbody) return;
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:32px;color:var(--muted);font-size:13px;">No inspections found.</td></tr>';
    return;
  }
  tbody.innerHTML = list.map(function(insp) {
    var badge   = _inspBadge(insp.overall_status);
    var apprMark = insp.approved_by ? ' <span title="Approved by ' + _esc(insp.approved_by) + '" style="color:var(--success);font-weight:700;">✓</span>' : '';
    var items   = insp.checklist ? JSON.parse(typeof insp.checklist === 'string' ? insp.checklist : JSON.stringify(insp.checklist)) : [];
    var repairs = items.filter(function(it){ return it.rating === 'repair'; }).length;
    var photoCount = (insp.photos ? (typeof insp.photos === 'string' ? JSON.parse(insp.photos) : insp.photos) : []).length;
    return '<tr onclick="openInspectionModal(\'' + _esc(insp.id) + '\')">'
      + '<td><div style="font-weight:600;font-size:13px;">' + _esc(insp.unit_address || insp.unit_id) + '</div></td>'
      + '<td>' + _esc(insp.type || '—') + '</td>'
      + '<td>' + _esc(insp.inspection_date || '—') + '</td>'
      + '<td>' + badge + apprMark + '</td>'
      + '<td>' + _esc(insp.inspector_name || '—') + '</td>'
      + '<td>' + (repairs > 0 ? '<span style="color:var(--warn-amber-text,#b45309);font-weight:600;">' + repairs + ' item' + (repairs===1?'':'s') + '</span>' : '<span style="color:var(--muted);">—</span>') + '</td>'
      + '<td>' + (photoCount > 0 ? '<span style="color:var(--muted);">📷 '+photoCount+'</span>' : '<span style="color:var(--muted);">—</span>') + '</td>'
      + '</tr>';
  }).join('');
}

function _inspKpi(val, lbl, status) {
  var color = status === 'pass' ? 'var(--success)' : status === 'needs_repair' ? '#b45309' : status === 'fail' ? 'var(--danger)' : 'var(--text)';
  return '<div class="insp-kpi"><div class="insp-kpi-val" style="color:' + color + ';">' + val + '</div><div class="insp-kpi-lbl">' + lbl + '</div></div>';
}

function _inspBadge(status) {
  var labels = { pass:'Pass', fail:'Fail', needs_repair:'Needs Repair', pending:'Pending' };
  var cls    = 'insp-badge insp-badge-' + (status || 'pending');
  return '<span class="' + cls + '">' + (labels[status] || status || 'Pending') + '</span>';
}

// _esc lives in shared-ui.js (delegates to escapeHtml — same five-char escape
// this file's local copy did). The top-level copy that was here collided with
// it on window. Do not re-add a page-level _esc.

// ── Modal: open ──────────────────────────────────────────────────────────────
function _inspUuid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c){
    var r = Math.random()*16|0, v = c === 'x' ? r : (r&0x3|0x8); return v.toString(16);
  });
}

// One checklist row (default or custom). Custom rows have an editable label +
// a remove button; default rows have a fixed label. DOM-driven, so collection
// no longer depends on template indexes.
function _inspRatingBtns(rating) {
  function b(r, lbl) {
    return '<button type="button" class="' + (rating === r ? 'active-' + r : '') + '" onclick="_inspSetRating(this,\'' + r + '\')">' + lbl + '</button>';
  }
  return b('pass','✓ Pass') + b('fail','✗ Fail') + b('repair','⚠ Repair') + b('na','N/A');
}
function _inspItemRow(item, rating, note, isCustom) {
  var main = isCustom
    ? '<div class="insp-cl-item-main"><input class="insp-cl-item-label-inp" type="text" placeholder="Custom item…" value="' + _esc(item || '') + '"/>'
        + '<button type="button" class="insp-cl-item-remove" title="Remove row" onclick="_inspRemoveRow(this)">✕</button></div>'
    : '<div class="insp-cl-item-main"><div class="insp-cl-item-label">' + _esc(item) + '</div></div>';
  return '<div class="insp-cl-item' + (isCustom ? ' insp-cl-item-custom' : '') + '">'
    + main
    + '<div class="insp-cl-rating">' + _inspRatingBtns(rating) + '</div>'
    + '<input class="insp-cl-item-note-inp" type="text" placeholder="Notes (optional)" value="' + _esc(note || '') + '"/>'
    + '</div>';
}

function openInspectionModal(id) {
  var insp = id ? (window._inspections || []).find(function(i){ return i.id === id; }) : null;
  window._inspEditId      = id || null;
  window._inspDocEntityId = id || _inspUuid();   // scope for the document library

  // Guided-questionnaire hand-off: a brand-new inspection can arrive pre-filled
  // via window._inspSeed (set by inspection-questionnaire.js). One-shot. `src` is
  // the field-value source for prefills (insp = editing an existing record;
  // seed = a guided new report). Edit-only UI (delete / PDF / approval) stays
  // keyed to `insp` so a seeded record renders as a new, unsaved inspection.
  var seed = (!id && window._inspSeed) ? window._inspSeed : null;
  window._inspSeed = null;
  var src = insp || seed;

  var units = window.housingUnits || [];
  var today = new Date().toISOString().split('T')[0];

  // Build unit data for searchable combobox
  var unitList = units.filter(function(u){ return !u.archived; }).map(function(u){
    return { id: u.id, addr: (u.num ? u.num + ' ' + u.street : u.id) };
  }).sort(function(a,b){ return a.addr.localeCompare(b.addr); });
  var preAddr = insp ? (insp.unit_address || insp.unit_id || '') : '';

  var typeOpts = INSP_TYPES.map(function(t){
    return '<option value="' + t + '"' + (src && src.type === t ? ' selected' : '') + '>' + t + '</option>';
  }).join('');

  var preStatus = (src && src.overall_status) ? src.overall_status : 'pending';
  var statusOpts = INSP_STATUSES.map(function(s){
    var labels = { pending:'Pending', pass:'Pass', fail:'Fail', needs_repair:'Needs Repair' };
    return '<option value="' + s + '"' + (s === preStatus ? ' selected' : '') + '>' + labels[s] + '</option>';
  }).join('');

  // Parse checklist — from the saved record when editing, else from the guided
  // questionnaire seed (same {section,item,rating,notes} shape) for a new report.
  var savedChecklist = [];
  if (insp && insp.checklist) {
    try { savedChecklist = typeof insp.checklist === 'string' ? JSON.parse(insp.checklist) : insp.checklist; } catch(e){}
  } else if (seed && seed.checklist) {
    savedChecklist = seed.checklist;
  }

  // Build checklist HTML — default template rows, then any saved custom rows
  // for the section, then an "Add row" button.
  var clHtml = INSP_CHECKLIST_TEMPLATE.map(function(sec, si) {
    var defaultRows = sec.items.map(function(item) {
      var saved = savedChecklist.find(function(x){ return x.section === sec.section && x.item === item; })
               || savedChecklist.find(function(x){ return x.key === sec.section + '|' + item; })
               || {};
      return _inspItemRow(item, saved.rating || '', saved.notes || '', false);
    }).join('');
    var customRows = savedChecklist.filter(function(x){
      return (x.section === sec.section) && sec.items.indexOf(x.item) === -1;
    }).map(function(x){
      return _inspItemRow(x.item, x.rating || '', x.notes || '', true);
    }).join('');
    return '<div class="insp-cl-section" data-section="' + _esc(sec.section) + '">'
      + '<div class="insp-cl-section-hdr" onclick="_inspToggleSection(this)">'
      +   '<span>' + _esc(sec.section) + '</span>'
      +   '<span style="font-size:11px;color:var(--muted);" id="insp_sec_summary_' + si + '"></span>'
      + '</div>'
      + '<div class="insp-cl-section-body">'
      +   '<div class="insp-cl-rows">' + defaultRows + customRows + '</div>'
      +   '<button type="button" class="insp-cl-addrow" onclick="_inspAddCustomRow(this)">+ Add row</button>'
      + '</div>'
      + '</div>';
  }).join('');

  // AI draft-notes available only when the assistant is loaded + module on.
  var aiNotesOn = (typeof _aiCall === 'function') && (!window.CLFN_MODULES || window.CLFN_MODULES.isEnabled('ai_assistant'));

  // Approval gate: only roles granted 'approveInspection' (Settings > Approval
  // Authority) can approve / sign off the report (stamps approved_by/approved_at).
  var canApproveInsp = (typeof APPROVAL_AUTHORITY === 'undefined') || APPROVAL_AUTHORITY.can('approveInspection', window.currentRole);
  // When the sign-off step is switched OFF in Settings, a completed report is
  // approved automatically on save — so the manual "Approve Report" button is
  // moot and hidden (Revoke stays available for anything already approved).
  var inspApprovalRequired = (typeof APPROVAL_AUTHORITY === 'undefined')
    || (typeof APPROVAL_AUTHORITY.required !== 'function')
    || APPROVAL_AUTHORITY.required('approveInspection');
  var inspApprovedBy = insp && insp.approved_by ? insp.approved_by : '';
  var inspApprovedAt = insp && insp.approved_at ? String(insp.approved_at).slice(0, 10) : '';
  var apprBanner = '';
  if (inspApprovedBy) {
    apprBanner = '<div style="display:flex;align-items:center;gap:8px;margin-bottom:16px;padding:9px 12px;background:var(--success-bg);border:1px solid var(--success-border);border-radius:8px;font-size:12px;color:var(--success);font-weight:600;">'
      + '✓ Approved by ' + _esc(inspApprovedBy) + (inspApprovedAt ? ' on ' + _esc(inspApprovedAt) : '') + '</div>';
  } else if (!canApproveInsp) {
    apprBanner = '<div style="margin-bottom:16px;padding:9px 12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;font-size:12px;color:var(--muted);">Report not yet approved — awaiting sign-off by an authorized approver.</div>';
  }

  var modal = document.getElementById('insp_modal');
  modal.innerHTML =
    '<div style="background:var(--surface);border-radius:12px;width:100%;max-width:740px;max-height:95vh;display:flex;flex-direction:column;box-shadow:0 8px 40px rgba(0,0,0,.35);">'
    + '<div class="modal-hdr">'
    +   '<div><div class="lbl-yellow">🔍 ' + (insp ? 'Edit Inspection' : 'New Inspection') + '</div>'
    +   '<div class="txt-sm-meta">' + (src ? _esc(src.unit_address||src.unit_id||'') + (src.type ? ' · ' + _esc(src.type) : '') : 'Complete the checklist and save.') + '</div></div>'
    +   '<button type="button" onclick="closeInspectionModal()" style="background:none;border:none;font-size:22px;cursor:pointer;color:var(--muted);">&times;</button>'
    + '</div>'
    + '<div style="overflow-y:auto;padding:18px 22px;flex:1;">'

    // ── Details
    + '<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:var(--yellow);margin-bottom:10px;padding-bottom:5px;border-bottom:1px solid var(--border);">Inspection Details</div>'
    + '<div class="tic-grid-2" style="margin-bottom:16px;">'
    +   '<div class="f"><label class="tic-field-lbl">Unit</label><div id="insp_unit_wrap"></div></div>'
    +   '<div class="f"><label class="tic-field-lbl">Type</label><select id="insp_type" class="tic-input">' + typeOpts + '</select></div>'
    +   '<div class="f"><label class="tic-field-lbl">Inspection Date</label><input id="insp_date" type="date" class="tic-input" value="' + _esc(src ? (src.inspection_date||today) : today) + '"/></div>'
    +   '<div class="f"><label class="tic-field-lbl">Overall Status</label><select id="insp_status" class="tic-input">' + statusOpts + '</select></div>'
    +   '<div class="f"><label class="tic-field-lbl">Inspector Name</label><input id="insp_inspector" type="text" class="tic-input" value="' + _esc(src ? (src.inspector_name||'') : (window.HOUSING_SESSION&&window.HOUSING_SESSION.name||'')) + '" placeholder="Full name"/></div>'
    +   '<div class="f"><label class="tic-field-lbl">Inspector Role</label><input id="insp_role" type="text" class="tic-input" value="' + _esc(src ? (src.inspector_role||'') : (window.currentRole||'')) + '" placeholder="Role"/></div>'
    + '</div>'

    // ── Approval status banner
    + apprBanner

    // ── Checklist
    + '<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:var(--yellow);margin:16px 0 10px;padding-bottom:5px;border-bottom:1px solid var(--border);">Inspection Checklist</div>'
    + '<div class="insp-checklist" id="insp_checklist">' + clHtml + '</div>'

    // ── General notes (with AI draft assist)
    + '<div style="display:flex;align-items:center;justify-content:space-between;margin:16px 0 10px;padding-bottom:5px;border-bottom:1px solid var(--border);">'
    +   '<span style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:var(--yellow);">General Notes</span>'
    +   (aiNotesOn ? '<button type="button" id="insp_ai_notes_btn" class="insp-ai-btn" onclick="_inspDraftNotes()"><span style="color:var(--yellow);">✦</span> Draft with AI</button>' : '')
    + '</div>'
    + '<textarea id="insp_notes" class="tic-input" rows="4" style="resize:vertical;min-height:80px;width:100%;box-sizing:border-box;" placeholder="Overall observations, recommendations…">' + _esc(src ? (src.general_notes||'') : '') + '</textarea>'

    // ── Photos & documents (standard upload widget)
    + '<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:var(--yellow);margin:16px 0 10px;padding-bottom:5px;border-bottom:1px solid var(--border);">Photos &amp; Documents</div>'
    + '<div id="insp_doclib"></div>'

    + '</div>'

    // ── Footer
    + '<div class="modal-footer" style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:14px 22px;border-top:1px solid var(--border);">'
    +   '<div style="display:flex;gap:8px;flex-wrap:wrap;">'
    +     (insp ? '<button type="button" class="btn btn-ghost" onclick="_inspConfirmDelete()">Delete</button>' : '')
    +     (insp ? '<button type="button" class="btn btn-ghost" onclick="generateInspectionPDF()">⬇ PDF</button>' : '')
    +     (canApproveInsp && !inspApprovedBy && inspApprovalRequired ? '<button type="button" class="btn" style="background:var(--success);color:#fff;border:1px solid var(--success);" onclick="saveInspection(\'approve\')">✓ Approve Report</button>' : '')
    +     (canApproveInsp && inspApprovedBy ? '<button type="button" class="btn btn-ghost" onclick="saveInspection(\'revoke\')">Revoke Approval</button>' : '')
    +   '</div>'
    +   '<div style="display:flex;gap:8px;">'
    +     '<button type="button" class="btn btn-ghost" onclick="closeInspectionModal()">Cancel</button>'
    +     '<button type="button" class="btn btn-primary" onclick="saveInspection()">Save Inspection</button>'
    +   '</div>'
    + '</div>'
    + '</div>';

  modal.style.display = 'flex';

  // Wire unit searchable select
  var unitItems = (window.housingUnits || [])
    .filter(function(u){ return !u.archived; })
    .map(function(u){ return { id: u.id, label: ((u.num||'') + (u.num&&u.street?' ':'') + (u.street||'')) || u.id }; })
    .sort(function(a,b){ return a.label.localeCompare(b.label); });
  var unitWrap = document.getElementById('insp_unit_wrap');
  if (unitWrap && typeof clfnSearchSelect === 'function') {
    window._inspUnitSS = clfnSearchSelect({
      wrap:        unitWrap,
      items:       unitItems,
      value:       src ? (src.unit_id || '') : '',
      placeholder: 'Search address…',
      onChange:    function(id, label) { window._inspUnitSS._selectedId = id; window._inspUnitSS._selectedLabel = label; }
    });
  }

  // Standard document library for photos/reports, scoped to this inspection.
  var docMount = document.getElementById('insp_doclib');
  if (docMount && window.DocLibrary) {
    docMount.innerHTML = '';
    window._inspDocLib = window.DocLibrary.create(docMount, {
      entityType:    'inspection',
      entityId:      window._inspDocEntityId,
      pathPrefix:    'inspections/' + window._inspDocEntityId + '/photos',
      supabaseUrl:   SUPABASE_URL,
      supabaseAnon:  SUPABASE_ANON,
      storageBucket: STORAGE_BUCKET,
      getAuthToken:  function(){ return (window.HOUSING_HEADERS && window.HOUSING_HEADERS['Authorization'] || '').replace('Bearer ',''); },
      auditTable:    'housing_audit_log',
      getActor:      function(){ return (window.HOUSING_SESSION && window.HOUSING_SESSION.email) || window.currentRole || 'staff'; },
      categories:    [{ key:'photo', label:'Photo', icon:'📷' }, { key:'report', label:'Report', icon:'📄' }, { key:'other', label:'Other', icon:'📎' }]
    });
  } else if (docMount) {
    docMount.innerHTML = '<div style="padding:10px;color:var(--muted);font-size:11px;">Document library unavailable.</div>';
  }

  _inspUpdateSectionSummaries();
}


function closeInspectionModal() {
  if (window._inspUnitSS) { window._inspUnitSS.destroy(); window._inspUnitSS = null; }
  var modal = document.getElementById('insp_modal');
  if (modal) modal.style.display = 'none';
  window._inspEditId      = null;
  window._inspDocEntityId = null;
  window._inspDocLib      = null;
}

// ── Checklist interaction ────────────────────────────────────────────────────
function _inspSetRating(btn, rating) {
  var key  = btn.getAttribute('data-key');
  var wrap = btn.closest('.insp-cl-rating');
  if (!wrap) return;
  wrap.querySelectorAll('button').forEach(function(b){ b.className = ''; });
  btn.className = 'active-' + rating;
  _inspUpdateSectionSummaries();
}

function _inspToggleSection(hdr) {
  var body = hdr.nextElementSibling;
  if (!body) return;
  body.style.display = body.style.display === 'none' ? '' : 'none';
}

// Append a blank custom row to a section.
function _inspAddCustomRow(btn) {
  var body = btn.closest('.insp-cl-section-body');
  var rows = body ? body.querySelector('.insp-cl-rows') : null;
  if (!rows) return;
  var tmp = document.createElement('div');
  tmp.innerHTML = _inspItemRow('', '', '', true);
  var row = tmp.firstChild;
  rows.appendChild(row);
  var inp = row.querySelector('.insp-cl-item-label-inp');
  if (inp) inp.focus();
  _inspUpdateSectionSummaries();
}

// Remove a custom row.
function _inspRemoveRow(btn) {
  var row = btn.closest('.insp-cl-item');
  if (row && row.parentNode) row.parentNode.removeChild(row);
  _inspUpdateSectionSummaries();
}

function _inspUpdateSectionSummaries() {
  document.querySelectorAll('#insp_checklist .insp-cl-section').forEach(function(section, si) {
    var el = document.getElementById('insp_sec_summary_' + si);
    if (!el) return;
    var total   = section.querySelectorAll('.insp-cl-item').length;
    var rated   = section.querySelectorAll('.insp-cl-rating button.active-pass, .insp-cl-rating button.active-fail, .insp-cl-rating button.active-repair, .insp-cl-rating button.active-na').length;
    var repairs = section.querySelectorAll('.insp-cl-rating button.active-repair').length;
    var fails   = section.querySelectorAll('.insp-cl-rating button.active-fail').length;
    var txt     = rated + '/' + total + ' rated';
    if (repairs) txt += ' · ' + repairs + ' repair';
    if (fails)   txt += ' · ' + fails + ' fail';
    el.textContent = txt;
    el.style.color = fails ? 'var(--danger)' : repairs ? '#b45309' : 'var(--muted)';
  });
}

// ── AI: draft general notes ──────────────────────────────────────────────────
async function _inspDraftNotes() {
  if (typeof _aiCall !== 'function') {
    if (typeof showToast === 'function') showToast('AI assistant unavailable.', {type:'error'}); return;
  }
  if (window.CLFN_MODULES && !window.CLFN_MODULES.isEnabled('ai_assistant')) {
    if (typeof showToast === 'function') showToast('AI Assistant is disabled for this nation.', {type:'error'}); return;
  }
  var unitLabel = window._inspUnitSS ? (window._inspUnitSS.getLabel() || '') : '';
  var type      = (document.getElementById('insp_type')   || {}).value || '';
  var status    = (document.getElementById('insp_status') || {}).value || '';
  var checklist = _inspCollectChecklist();
  var findings  = checklist.map(function(it){
    return '- [' + it.section + '] ' + it.item + ': ' + (it.rating || 'not rated') + (it.notes ? ' (' + it.notes + ')' : '');
  });
  var msg = 'You are drafting the GENERAL NOTES field of a housing unit inspection report. '
    + 'Write 2 to 4 concise, professional sentences summarizing the overall unit condition, '
    + 'explicitly calling out any items marked fail or repair and recommending follow-up where needed. '
    + 'Output ONLY the note text - no preamble, no heading, no bullet list.\n\n'
    + 'Unit: ' + (unitLabel || 'N/A') + '\n'
    + 'Inspection type: ' + (type || 'N/A') + '\n'
    + 'Overall status: ' + (status || 'N/A') + '\n'
    + 'Checklist findings:\n' + (findings.length ? findings.join('\n') : '(no items rated yet)');

  var btn  = document.getElementById('insp_ai_notes_btn');
  var orig = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Drafting…'; }
  try {
    var data = await _aiCall({ type:'chat', message: msg, context: { role: window.currentRole || '' }, history: [] });
    if (data && data.error) throw new Error(data.error);
    var reply = (data && data.reply) || '';
    var ta = document.getElementById('insp_notes');
    if (ta && reply.trim()) { ta.value = reply.trim(); ta.focus(); }
    else if (typeof showToast === 'function') showToast('No draft returned.', {type:'info'});
  } catch(e) {
    if (typeof showToast === 'function') showToast('AI draft failed: ' + e.message, {type:'error'});
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = orig; }
  }
}

// ── Collect checklist from DOM ────────────────────────────────────────────────
// DOM-driven so default + custom rows are both captured. Item name comes from
// the fixed label (default rows) or the editable input (custom rows).
function _inspCollectChecklist() {
  var items = [];
  document.querySelectorAll('#insp_checklist .insp-cl-section').forEach(function(sec) {
    var sectionName = sec.getAttribute('data-section') || '';
    sec.querySelectorAll('.insp-cl-item').forEach(function(row) {
      var labelInp = row.querySelector('.insp-cl-item-label-inp');
      var labelDiv = row.querySelector('.insp-cl-item-label');
      var itemName = labelInp ? labelInp.value.trim() : (labelDiv ? labelDiv.textContent.trim() : '');
      if (!itemName) return; // skip blank custom rows
      var activeBtn = row.querySelector('.insp-cl-rating button[class*="active"]');
      var rating    = '';
      if (activeBtn) {
        if (activeBtn.classList.contains('active-pass'))        rating = 'pass';
        else if (activeBtn.classList.contains('active-fail'))   rating = 'fail';
        else if (activeBtn.classList.contains('active-repair')) rating = 'repair';
        else if (activeBtn.classList.contains('active-na'))     rating = 'na';
      }
      var noteInp = row.querySelector('.insp-cl-item-note-inp');
      var notes   = noteInp ? noteInp.value.trim() : '';
      if (rating || notes) {
        items.push({ key: sectionName + '|' + itemName, section: sectionName, item: itemName, rating: rating, notes: notes });
      }
    });
  });
  return items;
}

// ── Save ─────────────────────────────────────────────────────────────────────
async function saveInspection(approveAction) {
  var unitId   = window._inspUnitSS ? window._inspUnitSS.getValue() : '';
  var unitAddr = window._inspUnitSS ? window._inspUnitSS.getLabel() : '';
  if (!unitId) { if(typeof showToast==='function') showToast('Please select a unit.', {type:'error'}); return; }

  var date    = (document.getElementById('insp_date')       || {}).value || '';
  var type    = (document.getElementById('insp_type')       || {}).value || '';
  var status  = (document.getElementById('insp_status')     || {}).value || 'pending';
  var inspector = (document.getElementById('insp_inspector') || {}).value || '';
  var role    = (document.getElementById('insp_role')        || {}).value || '';
  var notes   = (document.getElementById('insp_notes')       || {}).value || '';
  if (!date) { if(typeof showToast==='function') showToast('Please enter an inspection date.', {type:'error'}); return; }

  var checklist = _inspCollectChecklist();

  // Approval is gated by the approveInspection authority (Settings > Approval Authority).
  var canApproveInsp = (typeof APPROVAL_AUTHORITY === 'undefined') || APPROVAL_AUTHORITY.can('approveInspection', window.currentRole);
  if ((approveAction === 'approve' || approveAction === 'revoke') && !canApproveInsp) {
    if (typeof showToast === 'function') showToast('You are not authorized to approve inspection reports.', {type:'error'});
    return;
  }

  var isNew  = !window._inspEditId;
  var record = {
    id:              window._inspDocEntityId,   // matches the document-library scope
    unit_id:         unitId,
    unit_address:    unitAddr,
    type:            type,
    inspection_date: date,
    inspector_name:  inspector,
    inspector_role:  role,
    overall_status:  status,
    checklist:       checklist,
    general_notes:   notes,
    created_by:      (window.HOUSING_SESSION && window.HOUSING_SESSION.email) || window.currentRole || '',
  };
  // Approval sign-off. On a normal save the approved_* columns are omitted so a
  // PATCH leaves any existing approval untouched; they're only written when an
  // authorized approver explicitly approves or revokes.
  if (approveAction === 'approve') {
    record.approved_by = (window.HOUSING_SESSION && (window.HOUSING_SESSION.name || window.HOUSING_SESSION.email)) || window.currentRole || 'staff';
    record.approved_at = new Date().toISOString();
  } else if (approveAction === 'revoke') {
    record.approved_by = null;
    record.approved_at = null;
  } else if ((status === 'pass' || status === 'fail' || status === 'needs_repair')
      && typeof APPROVAL_AUTHORITY !== 'undefined' && APPROVAL_AUTHORITY.chainDisabled
      && APPROVAL_AUTHORITY.chainDisabled('inspection')
      // Guard on the EXISTING saved record — `record` is a fresh form scrape
      // that never carries approved_by, so the old `!record.approved_by` check
      // was always true and every edit-save replaced a real HM/ED sign-off
      // (made before the setting was switched off) with "System".
      && !(function(){
        var _ex = (window._inspections || []).find(function(x){ return x && x.id === window._inspEditId; });
        return _ex && _ex.approved_by;
      })()) {
    // The inspection sign-off step is switched OFF in Settings — auto-approve a
    // completed report on save ("any off = fully approved"), recorded as System.
    record.approved_by = 'System — approval disabled';
    record.approved_at = new Date().toISOString();
  }
  // Photos/documents are managed live by the document library (Supabase Storage
  // + audit log), so the legacy `photos` column is intentionally left untouched.

  var saveBtn = document.querySelector('#insp_modal .btn-primary');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }

  try {
    var saved = await _inspSave(record, isNew);

    // Update local cache
    var idx = (window._inspections||[]).findIndex(function(i){ return i.id === (window._inspEditId || saved.id); });
    if (idx >= 0) window._inspections[idx] = saved;
    else window._inspections.unshift(saved);

    // Update unit inspection dates (shared with the guided questionnaire's save).
    _inspUpdateUnitDates(unitId, date, type);

    if(typeof showToast==='function') showToast(approveAction === 'approve' ? 'Inspection approved.' : approveAction === 'revoke' ? 'Approval revoked.' : 'Inspection saved.', {type:'info'});

    // Check if any items need attention — prompt to create a Maintenance Request.
    // BOTH 'repair' (needs-repair) AND 'fail' items generate a request; previously
    // only 'repair' did, so an inspection with FAILED items produced no MR.
    var repairItems = _inspRepairItems(checklist);
    closeInspectionModal();
    renderInspectionsList();

    // Optional note on the tenant file when the report is approved (sign-off =
    // completion). SEQUENCED: the note prompt resolves BEFORE the SOW prompt —
    // _inspPromptSOW opens the full SOW modal, and firing the note dialog
    // unawaited used to stack it on top of the form the user was sent to fill.
    var _notePromise = Promise.resolve();
    if (approveAction === 'approve') {
      try {
        var _iu = (typeof housingUnits !== 'undefined' ? housingUnits : []).find(function(u){ return u.id === unitId; });
        var _itn = _iu && _iu.assignedName;
        if (_itn && typeof promptTenantNote === 'function') {
          _notePromise = promptTenantNote(_itn, {
            title: 'Inspection note (optional)',
            message: 'Add a note for ' + _itn + ' on this inspection (follow-up, condition). Leave blank to skip.',
            placeholder: 'e.g. Smoke detector battery replaced; follow up on window seal…',
            context: 'inspection',
            prefix: '[Inspection ' + (type || '') + ' ' + (date || '') + ']'
          }).catch(function(){});
        }
      } catch(e){ console.warn('[Inspections] note prompt threw:', e); }
    }
    if (repairItems.length && status !== 'pass') {
      _notePromise.then(function(){ _inspPromptSOW(saved, repairItems); });
    }
  } catch(e) {
    if(typeof showToast==='function') showToast('Save failed: ' + e.message, {type:'error'});
    console.warn('[Inspections] save error:', e);
  } finally {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save Inspection'; }
  }
}

// ── Shared post-save steps (used by saveInspection AND the guided
//    questionnaire in inspection-questionnaire.js — keep both paths calling
//    these so they can't drift again) ─────────────────────────────────────────
function _inspUpdateUnitDates(unitId, date, type) {
  if (typeof housingUnits === 'undefined') return;
  var unit = housingUnits.find(function(u){ return u.id === unitId; });
  if (!unit) return;
  unit.lastInspectionDate = date;
  // Advance the next-due date from this inspection (annual cadence).
  var _nd = _inspComputeNextDue(date, type);
  if (_nd !== undefined) unit.nextInspectionDue = _nd;
  if (typeof sbSaveUnit === 'function') sbSaveUnit(unit);
}
window._inspUpdateUnitDates = _inspUpdateUnitDates;

function _inspRepairItems(checklist) {
  return (checklist || []).filter(function(it){ return it.rating === 'repair' || it.rating === 'fail'; });
}
window._inspRepairItems = _inspRepairItems;

// ── SOW prompt ───────────────────────────────────────────────────────────────
function _inspPromptSOW(insp, repairItems) {
  var msg = repairItems.length + ' item' + (repairItems.length===1?'':'s') + ' marked as failed or needing repair. Create a Maintenance Request for this unit?';
  if (!confirm(msg)) return;

  if (typeof openSowModal !== 'function') {
    if(typeof showToast==='function') showToast('Open the unit\'s Maintenance Request to create the repair request.', {type:'info'});
    return;
  }

  // Hand the repair items to the SOW modal via the shared seed path (same as the
  // reno questionnaire): force a fresh SOW and let openSowModal apply the seed
  // in-flow. Do NOT write window._sowCache directly — that cache holds each
  // unit's SOW *record data* (`{sows:[...]}`), not `{items}`, so the old code
  // both used the wrong function name (openSOWModal) and could clobber real data.
  window._sowForceNew = true;
  window._sowSeed = {
    items: repairItems.map(function(it) {
      var flag = it.rating === 'fail' ? ' (FAILED)' : ' (needs repair)';
      return { category: _inspSowCategory(it), description: it.item + flag + (it.notes ? ': ' + it.notes : '') };
    }),
    notes: 'Generated from inspection' + (insp.id ? ' ' + insp.id : '') + '.'
  };
  openSowModal(insp.unit_id);
  if(typeof showToast==='function') showToast('Repair items pre-loaded into the Maintenance Request.', {type:'info'});
}

// Map an inspection checklist row to the closest SOW_CATEGORIES entry
// (housing-modals-sow.js). The SOW modal's category <select> only preselects
// on an EXACT match, and the raw checklist section names ('Exterior',
// 'Bathroom(s)', 'Mechanical'…) match nothing — every seeded item used to
// land with a blank category. Item keywords first, then a section fallback.
function _inspSowCategory(it) {
  var t = ((it.item || '') + ' ' + (it.section || '')).toLowerCase();
  if (/roof/.test(t))                                        return 'Roofing';
  if (/window|door/.test(t))                                 return 'Windows & Doors';
  if (/foundation|structure|deck|porch|steps/.test(t))       return 'Foundation / Structure';
  if (/plumb|sink|faucet|toilet|tub|shower|caulk|water heater|water shut/.test(t)) return 'Plumbing';
  if (/electric|panel|hydro meter|smoke|carbon monoxide/.test(t)) return 'Electrical';
  if (/furnace|heating|ventilation|air condition|exhaust fan|gas meter/.test(t))  return 'Heating / HVAC';
  if (/floor/.test(t))                                       return 'Flooring';
  if (/siding|exterior wall/.test(t))                        return 'Exterior Walls / Siding';
  if (/wall|ceiling/.test(t))                                return 'Interior Walls / Drywall';
  var bySection = {
    'Kitchen':             'Kitchen',
    'Bathroom(s)':         'Bathroom',
    'Mechanical':          'Heating / HVAC',
    'Exterior':            'Exterior Walls / Siding',
    'Interior – General':  'Interior Walls / Drywall',
    'Bedrooms':            'Other',
    'Utility Connections': 'Other'
  };
  return bySection[it.section] || 'Other';
}

// ── Delete ───────────────────────────────────────────────────────────────────
function _inspConfirmDelete() {
  if (!window._inspEditId) return;
  if (!confirm('Delete this inspection record? This cannot be undone.')) return;
  _inspDelete(window._inspEditId).then(function() {
    window._inspections = (window._inspections||[]).filter(function(i){ return i.id !== window._inspEditId; });
    closeInspectionModal();
    renderInspectionsList();
    if(typeof showToast==='function') showToast('Inspection deleted.', {type:'info'});
  }).catch(function(e) {
    if(typeof showToast==='function') showToast('Delete failed: ' + e.message, {type:'error'});
  });
}

// ── PDF export ───────────────────────────────────────────────────────────────
function generateInspectionPDF() {
  var insp = window._inspEditId ? (window._inspections||[]).find(function(i){ return i.id === window._inspEditId; }) : null;
  if (!insp) return;

  var loadjsPDF = function(cb) {
    // Delegates to the shared lazy-loader in shared.js (single implementation;
    // also fixes the old copy skipping autotable when jsPDF was already loaded).
    window.loadJsPdf({ autotable: true }).then(function(){ cb(); }, function(){
      if(typeof showToast==='function') showToast('Could not load the PDF library.', {type:'error'});
    });
  };

  loadjsPDF(function() {
    var doc = new window.jspdf.jsPDF({ orientation:'portrait', unit:'mm', format:'letter' });
    var nation = nationShort();
    var y = 16;

    doc.setFontSize(14); doc.setFont('helvetica','bold');
    doc.text(nation + ' Housing — Unit Inspection Report', 14, y); y += 7;

    doc.setFontSize(9); doc.setFont('helvetica','normal');
    doc.text('Unit: ' + (insp.unit_address || insp.unit_id), 14, y);
    doc.text('Type: ' + (insp.type||'—'), 90, y); y += 5;
    doc.text('Date: ' + (insp.inspection_date||'—'), 14, y);
    doc.text('Inspector: ' + (insp.inspector_name||'—'), 90, y); y += 5;
    doc.text('Status: ' + (insp.overall_status||'—').replace('_',' ').toUpperCase(), 14, y); y += 3;

    doc.setDrawColor(200,200,200); doc.line(14, y, 200, y); y += 5;

    // Checklist table
    var checklist = insp.checklist ? (typeof insp.checklist === 'string' ? JSON.parse(insp.checklist) : insp.checklist) : [];
    var tableRows = [];
    var fmtRating = function(r){ r = r || '—'; return r.charAt(0).toUpperCase() + r.slice(1).replace('_',' '); };
    INSP_CHECKLIST_TEMPLATE.forEach(function(sec) {
      // Default template items
      sec.items.forEach(function(item) {
        var cl = checklist.find(function(x){ return (x.section === sec.section && x.item === item) || x.key === sec.section + '|' + item; }) || {};
        tableRows.push([sec.section, item, fmtRating(cl.rating), cl.notes || '']);
      });
      // Custom rows added to this section
      checklist.filter(function(x){ return x.section === sec.section && sec.items.indexOf(x.item) === -1; }).forEach(function(x){
        tableRows.push([sec.section, x.item, fmtRating(x.rating), x.notes || '']);
      });
    });

    doc.autoTable({
      startY: y,
      head: [['Section','Item','Rating','Notes']],
      body: tableRows,
      theme: 'striped',
      headStyles: { fillColor:[17,17,15], textColor: window._themeAccentHex(), fontSize:7, fontStyle:'bold' },
      bodyStyles: { fontSize:7 },
      columnStyles: { 0:{cellWidth:35}, 1:{cellWidth:65}, 2:{cellWidth:22}, 3:{cellWidth:55} },
      margin: { left:14, right:14 }
    });

    y = doc.lastAutoTable.finalY + 6;

    if (insp.general_notes) {
      doc.setFontSize(9); doc.setFont('helvetica','bold');
      doc.text('General Notes', 14, y); y += 4;
      doc.setFont('helvetica','normal');
      var lines = doc.splitTextToSize(insp.general_notes, 180);
      doc.text(lines, 14, y); y += lines.length * 4 + 4;
    }

    // Signature lines
    if (y > 230) { doc.addPage(); y = 16; }
    doc.setDrawColor(150,150,150);
    doc.line(14, y+14, 90, y+14);
    doc.line(110, y+14, 186, y+14);
    doc.setFontSize(8);
    doc.text('Inspector Signature', 14, y+18);
    doc.text('Date', 110, y+18);

    var filename = nation + '_Inspection_' + (insp.unit_address||insp.unit_id).replace(/\s+/g,'_') + '_' + (insp.inspection_date||'');
    doc.save(filename + '.pdf');
  });
}

// ── Page init ────────────────────────────────────────────────────────────────
(async function initInspectionsPage() {
  try {
    var token = sessionStorage.getItem('clfn_housing_token');
    if (!token) { window.location.href = 'index.html'; return; }

    var savedRole  = sessionStorage.getItem('clfn_housing_role')          || 'housing_employee_l1';
    var savedName  = sessionStorage.getItem('clfn_housing_name')          || '';
    var savedEmail = sessionStorage.getItem('clfn_housing_email_session') || '';
    if (typeof HOUSING_HEADERS !== 'undefined') HOUSING_HEADERS['Authorization'] = 'Bearer ' + token;
    if (typeof HOUSING_SESSION !== 'undefined') {
      HOUSING_SESSION.accessToken = token;
      HOUSING_SESSION.role        = savedRole;
      HOUSING_SESSION.name        = savedName;
      HOUSING_SESSION.email       = savedEmail;
    }
    window.currentRole = savedRole;
    window._realRole   = savedRole;

    if (typeof resolveHousingRole === 'function') {
      try { await resolveHousingRole(); } catch(e) { console.warn('[inspections] role resolve:', e); }
    }
    var role = (typeof HOUSING_SESSION !== 'undefined' && HOUSING_SESSION.role) || savedRole;
    window.currentRole = role;
    window._realRole   = role;

    if (typeof initModuleEnablement         === 'function') try { initModuleEnablement(); } catch(e) {}
    if (window.CLFN_MODULES && !window.CLFN_MODULES.isEnabled('inspections')) {
      if (typeof showModuleDisabledNotice === 'function') showModuleDisabledNotice('Inspections');
      else window.location.href = 'housing.html';
      return;
    }

    if (typeof updateHeaderUser             === 'function') updateHeaderUser(role);
    if (typeof updateRoleSwitcherVisibility === 'function') updateRoleSwitcherVisibility();
    if (typeof renderHeaderNav              === 'function') renderHeaderNav();
    if (typeof applyRoleVisibility          === 'function') applyRoleVisibility(role);
    if (typeof setHeaderNavActive           === 'function') setHeaderNavActive('inspections');
    // Reveal the shell immediately (progressive render); the list fills as data loads.
    if (document.body) document.body.style.opacity = '1';

    if (typeof loadHousingData === 'function') {
      try { await loadHousingData(); } catch(e) { console.warn('[inspections] data load:', e); }
    }
    // Module gate RE-CHECK after settings hydration: the pre-load check above
    // ran before housing_settings existed, so a persisted "module off" was
    // never seen there (the gate failed open on direct URLs).
    if (typeof initModuleEnablement === 'function') try { initModuleEnablement(); } catch(e) {}
    if (typeof moduleOn === 'function' && !moduleOn('inspections')) {
      if (typeof showModuleDisabledNotice === 'function') showModuleDisabledNotice('Inspections');
      else window.location.href = 'housing.html';
      return;
    }
    // Pick up any ED-customised approval-authority overrides (e.g. approveInspection).
    if (typeof initApprovalAuthority === 'function') { try { initApprovalAuthority(); } catch(e) {} }
    // Show the view (page-view-wide is display:none by default)
    var view = document.getElementById('inspectionsView');
    if (view) view.style.display = 'flex';

    // Units (skipped when already loaded) and the inspections list are
    // independent -- load them together, then render once. Previously serial.
    await Promise.all([
      _inspLoadUnits().catch(function(e){ console.warn('[inspections] units load:', e); }),
      _inspLoad().catch(function(e){ console.warn('[inspections] insp load:', e); })
    ]);
    renderInspectionsList();
  } catch(e) {
    console.error('[inspections] init error:', e);
  } finally {
    document.body.style.opacity = '1';
  }
}());
