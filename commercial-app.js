/* ============================================================
 * commercial-app.js — CLFN Housing Suite (Phase CM2)
 * Simple, NON-SCORED application for a business or department to
 * request a commercial / admin / band building. Self-contained,
 * self-injecting modal (mirrors the reno-questionnaire / TIC pattern).
 *
 * Stored in the existing housing_applications table: app_type='commercial',
 * all fields in the data jsonb (sbSaveApplication writes data: app). Not
 * scored, not on the residential Match. Admin reviews and approves/declines.
 *
 * Globals: openCommercialApp(idOrNull), submitCommercialApp(),
 *          commercialAppDecision('approve'|'decline')
 * ============================================================ */
'use strict';

var _caEditId = null;      // id when reviewing/editing an existing commercial app

var _CA_SPACE_TYPES = [
  ['office',    'Office'],
  ['retail',    'Retail / Storefront'],
  ['storage',   'Storage / Warehouse'],
  ['community', 'Community / Program Space'],
  ['other',     'Other']
];

function _caEsc(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  });
}

function _caIsMgmt(){
  var r = window.currentRole || '';
  if (window.ROLE && typeof ROLE.isManagement === 'function') return ROLE.isManagement(r);
  return ['ed','housing_manager','housing_employee_l2','super_user'].indexOf(r) !== -1;
}

// Vacant commercial/admin/band buildings, for the "preferred building" picker.
function _caCommercialUnits(){
  var src = getAllUnits();
  var sec = (window._SECONDARY_TYPES) || ['commercial_building','admin_building','band_building'];
  return src.filter(function(u){ return u && !u.archived && sec.indexOf(u.type) !== -1; });
}

function _caEnsureModal(){
  if (document.getElementById('commercialAppModal')) return;
  if (!document.body) return;
  var wrap = document.createElement('div');
  wrap.id = 'commercialAppModal';
  wrap.className = 'modal-overlay modal-z-1100';
  wrap.style.cssText = 'display:none;align-items:center;justify-content:center;padding:16px;';
  wrap.innerHTML =
      '<div style="background:var(--surface);border-radius:14px;width:100%;max-width:640px;max-height:94vh;display:flex;flex-direction:column;box-shadow:0 24px 60px rgba(0,0,0,0.4);overflow:hidden;">'
    +   '<div class="modal-hdr spacious">'
    +     '<div><div class="lbl-uppercase-sm">Commercial Tenancy</div>'
    +       '<div class="panel-title" id="ca_title">Business / Department Application</div></div>'
    +     '<button type="button" onclick="closeCommercialApp()" class="btn-close-sm">&times;</button>'
    +   '</div>'
    +   '<div style="overflow-y:auto;padding:18px 22px;flex:1;" id="ca_body"></div>'
    +   '<div style="padding:14px 22px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:10px;flex-shrink:0;" id="ca_footer"></div>'
    + '</div>';
  document.body.appendChild(wrap);
  wrap.addEventListener('click', function(e){ if (e.target === wrap) closeCommercialApp(); });
}

function _caField(label, inner, req){
  return '<div class="tic-field" style="margin-bottom:12px;"><label class="tic-field-lbl">' + label
       + (req ? ' <span style="color:var(--danger);">*</span>' : '') + '</label>' + inner + '</div>';
}
function _caInput(id, val, ph, type){
  return '<input id="' + id + '" type="' + (type||'text') + '" value="' + _caEsc(val||'') + '" placeholder="' + _caEsc(ph||'') + '"'
       + ' style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--border);border-radius:7px;font-size:13px;font-family:var(--sans);background:var(--surface);color:var(--text);"/>';
}
function _caTextarea(id, val, ph){
  return '<textarea id="' + id + '" rows="2" placeholder="' + _caEsc(ph||'') + '"'
       + ' style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--border);border-radius:7px;font-size:13px;font-family:var(--sans);background:var(--surface);color:var(--text);resize:vertical;">' + _caEsc(val||'') + '</textarea>';
}

function _caRenderBody(app){
  app = app || {};
  var kind = app.kind || 'business';
  var spaceOpts = _CA_SPACE_TYPES.map(function(o){
    return '<option value="' + o[0] + '"' + (app.spaceType === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
  }).join('');
  var unitOpts = '<option value="">— No preference —</option>' + _caCommercialUnits().map(function(u){
    var addr = ((u.num||'') + ' ' + (u.street||'')).trim() || u.id;
    return '<option value="' + _caEsc(u.id) + '"' + (app.preferredUnit === u.id ? ' selected' : '') + '>'
         + _caEsc(addr) + (u.status && u.status !== 'vacant' ? ' (' + _caEsc(u.status) + ')' : '') + '</option>';
  }).join('');

  return ''
    + '<div style="font-size:12px;color:var(--muted);margin-bottom:16px;line-height:1.5;">A short request for a business or department to occupy a commercial, admin, or band building. Not scored or waitlisted — reviewed by staff for availability and fit.</div>'
    + _caField('Applicant Type',
        '<div style="display:flex;gap:18px;">'
        + '<label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;"><input type="radio" name="ca_kind" value="business" ' + (kind==='business'?'checked':'') + ' style="accent-color:var(--yellow);"/> Business</label>'
        + '<label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;"><input type="radio" name="ca_kind" value="department" ' + (kind==='department'?'checked':'') + ' style="accent-color:var(--yellow);"/> Department</label>'
        + '</div>', true)
    + _caField('Business / Department Name', _caInput('ca_org', app.orgName, 'Legal or operating name'), true)
    + '<div class="tic-grid-2" style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">'
    +   _caField('Contact Person', _caInput('ca_contact', app.contactPerson, 'Primary contact'), true)
    +   _caField('Contact Phone', _caInput('ca_phone', app.contactPhone, 'Phone', 'tel'))
    +   _caField('Contact Email', _caInput('ca_email', app.contactEmail, 'Email', 'email'))
    +   _caField('Space Type', '<select id="ca_space" style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--border);border-radius:7px;font-size:13px;font-family:var(--sans);background:var(--surface);color:var(--text);">' + spaceOpts + '</select>')
    +   _caField('Approx. Size Needed', _caInput('ca_size', app.sizeNeeded, 'e.g. 1,200 sq ft or 3 rooms'))
    +   _caField('Monthly Rent / Fee ($)', _caInput('ca_rent', app.rentAmount, '0.00', 'number'))
    +   _caField('Department Number', _caInput('ca_dept', app.deptNumber, 'Cost centre / dept no.'))
    +   _caField('Preferred Building', '<select id="ca_unit" style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--border);border-radius:7px;font-size:13px;font-family:var(--sans);background:var(--surface);color:var(--text);">' + unitOpts + '</select>')
    +   _caField('Desired Start', _caInput('ca_start', app.desiredStart, '', 'date'), true)
    +   _caField('Desired End (optional)', _caInput('ca_end', app.desiredEnd, 'Leave blank if ongoing', 'date'))
    + '</div>'
    + _caField('Intended Use', _caTextarea('ca_use', app.intendedUse, 'What the space will be used for'))
    + _caField('Notes', _caTextarea('ca_notes', app.notes, 'Anything else staff should know'));
}

function _caStatusLabel(s){
  return { submitted:'Submitted — Awaiting Review', ed_approved:'Approved', declined:'Declined' }[s] || (s || 'Draft');
}

function openCommercialApp(id){
  _caEnsureModal();
  var modal = document.getElementById('commercialAppModal');
  if (!modal) { if (typeof showToast==='function') showToast('Commercial application not available on this page.', { type:'error' }); return; }
  // Boot deep links (?openScorecard= / ?openApp= from the worklist Review
  // button) route commercial apps straight here BEFORE any page view was
  // shown -- the modal then floated over an empty page, and closing it after
  // approve/assign stranded the user on a blank screen. Put the landing page
  // behind the modal whenever nothing is visible.
  try {
    var _anyViewVisible = Array.prototype.some.call(
      document.querySelectorAll('.page-view'),
      function(v){ return v.offsetHeight > 0; }
    );
    var _wiz = document.getElementById('appLayout');
    if (!_anyViewVisible && !(_wiz && _wiz.offsetHeight > 0)) {
      if (typeof showLanding === 'function') showLanding();
      else if (typeof showEmployeeHome === 'function') showEmployeeHome();
      else if (typeof showWorklist === 'function') showWorklist();
    }
  } catch(e){ /* background view is best-effort */ }
  var existing = id
    ? (typeof applications !== 'undefined' ? applications : []).find(function(a){ return a.id === id && a.appType === 'commercial'; })
    : null;
  _caEditId = existing ? existing.id : null;

  document.getElementById('ca_title').textContent = existing
    ? ('Commercial Application — ' + (_caStatusLabel(existing.status)))
    : 'Business / Department Application';
  document.getElementById('ca_body').innerHTML = _caRenderBody(existing || {});

  // Footer: submit (new) OR review/assign actions (existing, mgmt only).
  var footer = document.getElementById('ca_footer');
  var review    = existing && existing.status === 'submitted' && _caIsMgmt();
  var canAssign = existing && existing.status === 'ed_approved' && !existing.assignedUnit && _caIsMgmt();
  footer.innerHTML =
      '<button type="button" onclick="closeCommercialApp()" class="btn btn-ghost">Close</button>'
    + (canAssign ? '<button type="button" onclick="openCommercialAssign()" class="btn btn-primary">Assign to Building →</button>' : '')
    + (existing
        ? (review
            ? '<button type="button" onclick="commercialAppDecision(\'decline\')" class="btn btn-ghost" style="color:var(--danger);border-color:var(--danger);">Decline</button>'
              + '<button type="button" onclick="commercialAppDecision(\'approve\')" class="btn btn-primary">Approve</button>'
            : (canAssign ? '' : '<button type="button" onclick="submitCommercialApp()" class="btn btn-primary">Save Changes</button>'))
        : '<button type="button" onclick="submitCommercialApp()" class="btn btn-primary">Submit Application</button>');

  modal.style.display = 'flex';
}

function closeCommercialApp(){
  var m = document.getElementById('commercialAppModal');
  if (m) m.style.display = 'none';
  _caEditId = null;
}

function _caCollect(){
  var v = function(id){ var e = document.getElementById(id); return e ? (e.value||'').trim() : ''; };
  var kindEl = document.querySelector('input[name="ca_kind"]:checked');
  return {
    kind:          kindEl ? kindEl.value : 'business',
    orgName:       v('ca_org'),
    contactPerson: v('ca_contact'),
    contactPhone:  v('ca_phone'),
    contactEmail:  v('ca_email'),
    spaceType:     v('ca_space'),
    sizeNeeded:    v('ca_size'),
    rentAmount:    v('ca_rent'),
    deptNumber:    v('ca_dept'),
    preferredUnit: v('ca_unit'),
    desiredStart:  v('ca_start'),
    desiredEnd:    v('ca_end'),
    intendedUse:   v('ca_use'),
    notes:         v('ca_notes')
  };
}

function submitCommercialApp(){
  var f = _caCollect();
  if (!f.orgName)       { if (typeof showToast==='function') showToast('Business / Department name is required.', { type:'error' }); return; }
  if (!f.contactPerson) { if (typeof showToast==='function') showToast('Contact person is required.', { type:'error' }); return; }
  if (!f.desiredStart)  { if (typeof showToast==='function') showToast('Desired start date is required.', { type:'error' }); return; }

  var existing = _caEditId
    ? (typeof applications !== 'undefined' ? applications : []).find(function(a){ return a.id === _caEditId; })
    : null;
  var nowIso = new Date().toISOString();
  var today  = nowIso.slice(0,10);

  var app = Object.assign({}, existing || {}, f, {
    id:        (existing && existing.id) || (typeof generateAppId === 'function' ? generateAppId() : 'APP-' + Date.now()),
    appType:   'commercial',
    status:    (existing && existing.status) || 'submitted',
    // Display name in the residential apps table (renders fn + ln).
    fn:        f.orgName,
    ln:        '',
    classification: f.kind === 'department' ? 'Department' : 'Business',
    appDate:   (existing && existing.appDate) || today,
    submittedAt: (existing && existing.submittedAt) || nowIso,
    score:     null,
    tier:      null,
    created_by_email: (existing && existing.created_by_email) || (window.HOUSING_SESSION && HOUSING_SESSION.email) || null
  });

  _caPersist(app, (existing ? 'Commercial application updated.' : 'Commercial application submitted.'),
    (existing ? 'commercial_app_updated' : 'commercial_app_submitted'));
}

function commercialAppDecision(decision){
  var existing = _caEditId
    ? (typeof applications !== 'undefined' ? applications : []).find(function(a){ return a.id === _caEditId; })
    : null;
  if (!existing) return;
  if (!_caIsMgmt()) { if (typeof showToast==='function') showToast('You do not have authority to approve commercial applications.', { type:'error' }); return; }
  var approve = decision === 'approve';
  if (typeof showConfirm !== 'function') return;
  showConfirm({
    title:   approve ? 'Approve commercial application?' : 'Decline commercial application?',
    message: approve
      ? 'This approves the request. It can then be matched to an available commercial building.'
      : 'This declines the request. The applicant will not be placed.',
    confirmText: approve ? 'Approve' : 'Decline',
    danger: !approve
  }).then(function(ok){
    if (!ok) return;
    var f = _caCollect();
    var app = Object.assign({}, existing, f, {
      fn: f.orgName || existing.fn, ln: '',
      status: approve ? 'ed_approved' : 'declined',
      decidedAt: new Date().toISOString(),
      decidedBy: (window.HOUSING_SESSION && HOUSING_SESSION.name) || window.currentRole || 'staff'
    });
    _caPersist(app, approve ? 'Commercial application approved.' : 'Commercial application declined.',
      approve ? 'commercial_app_approved' : 'commercial_app_declined');
  });
}

function _caPersist(app, okMsg, auditAction){
  var save = (typeof sbSaveApplication === 'function')
    ? sbSaveApplication(app)
    : Promise.reject(new Error('save unavailable'));
  save.then(function(){
    // Keep the in-memory applications array in sync.
    if (typeof applications !== 'undefined' && applications) {
      var idx = applications.findIndex(function(a){ return a.id === app.id; });
      if (idx >= 0) applications[idx] = app; else applications.unshift(app);
    }
    if (typeof auditEntry === 'function') {
      auditEntry(app.id, auditAction, (app.classification || 'Commercial') + ' — ' + (app.orgName||'') + ' (' + _caStatusLabel(app.status) + ')', window.currentRole || 'staff');
    }
    if (typeof showToast === 'function') showToast('✓ ' + okMsg, {type:'info'});
    closeCommercialApp();
    // Reached from the residential wizard's Business/Department radio, the
    // wizard is still the visible view behind the modal -- close it so staff
    // land back where they started (usually the landing page) instead of a
    // fresh application form.
    try {
      var _wiz = document.getElementById('appLayout');
      if (_wiz && _wiz.offsetHeight > 0) {
        if (typeof closeApplicationForm === 'function') closeApplicationForm();
        else if (typeof showLanding === 'function') showLanding();
      }
    } catch(e){ /* view handoff is best-effort */ }
    if (typeof renderApplications === 'function') renderApplications();
    if (typeof renderWorklist === 'function') renderWorklist();
  }).catch(function(err){
    if (typeof showToast === 'function') showToast('Save failed: ' + (err && err.message || err), { type:'error' });
  });
}

// ── Assign to Building (CM3 — assignment only, no matching model) ────────────
function _caTypeLabel(t){ return (typeof _fmtUnitType === 'function') ? (_fmtUnitType(t) || t) : (t || ''); }

function openCommercialAssign(){
  var app = _caEditId ? (typeof applications !== 'undefined' ? applications : []).find(function(a){ return a.id === _caEditId; }) : null;
  if (!app) return;
  if (!_caIsMgmt()) { if (typeof showToast==='function') showToast('You do not have authority to assign.', { type:'error' }); return; }

  var units = _caCommercialUnits().slice().sort(function(a,b){ return (a.status==='vacant'?0:1) - (b.status==='vacant'?0:1); });
  var opts = '<option value="">— Select a building —</option>' + units.map(function(u){
    var addr = ((u.num||'') + ' ' + (u.street||'')).trim() || u.id;
    return '<option value="' + _caEsc(u.id) + '">' + _caEsc(addr) + ' (' + _caEsc(_caTypeLabel(u.type)) + ' · ' + _caEsc(u.status || 'vacant') + ')</option>';
  }).join('');
  var today = new Date().toISOString().slice(0,10);
  var selStyle = 'width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--border);border-radius:7px;font-size:13px;font-family:var(--sans);background:var(--surface);color:var(--text);';

  document.getElementById('ca_title').textContent = 'Assign ' + (app.orgName || 'Applicant') + ' to a Building';
  document.getElementById('ca_body').innerHTML =
      '<div style="font-size:12px;color:var(--muted);margin-bottom:16px;line-height:1.5;">Assign this approved ' + _caEsc((app.classification||'business').toLowerCase()) + ' to a commercial, admin, or band building. This sets the building\'s occupant and records the tenant as a ' + (app.kind === 'department' ? 'department' : 'business') + '.</div>'
    + _caField('Building', '<select id="ca_assign_unit" style="' + selStyle + '">' + opts + '</select>', true)
    + _caField('Move-in / Start Date', _caInput('ca_assign_date', app.desiredStart || today, '', 'date'));
  document.getElementById('ca_footer').innerHTML =
      '<button type="button" onclick="openCommercialApp(\'' + _caEsc(app.id) + '\')" class="btn btn-ghost">&larr; Back</button>'
    + '<button type="button" onclick="confirmAssignCommercial()" class="btn btn-primary">Assign</button>';
}

function confirmAssignCommercial(){
  var app = _caEditId ? (typeof applications !== 'undefined' ? applications : []).find(function(a){ return a.id === _caEditId; }) : null;
  if (!app) return;
  var unitId = (document.getElementById('ca_assign_unit') || {}).value || '';
  var date   = (document.getElementById('ca_assign_date') || {}).value || new Date().toISOString().slice(0,10);
  if (!unitId) { if (typeof showToast==='function') showToast('Select a building.', { type:'error' }); return; }
  var src  = getAllUnits();
  var unit = src.find(function(u){ return u.id === unitId; });
  if (!unit) { if (typeof showToast==='function') showToast('Building not found.', { type:'error' }); return; }
  var addr = ((unit.num||'') + ' ' + (unit.street||'')).trim();
  var org  = app.orgName || app.fn || 'Business';

  // 1) Put the org onto the building (the sync trigger creates a tenant row by name).
  unit.assignedName = org;
  unit.assignedTo   = app.id;
  unit.assignedDate = date;
  if (app.deptNumber) unit.deptNumber = app.deptNumber;   // cost-centre on the building
  if (unit.status === 'vacant') unit.status = 'occupied';
  var unitSave = (typeof saveUnitWithDraftFallback === 'function') ? saveUnitWithDraftFallback(unit) : Promise.resolve(true);

  // 2) Once the unit save commits (trigger has created the tenant), type that
  //    tenant as business/department + contact + rent + link the application.
  var _rent = parseFloat(String(app.rentAmount || '').replace(/[^0-9.-]/g, ''));
  var _tFields = {
    tenant_type:    app.kind === 'department' ? 'department' : 'business',
    contact_person: app.contactPerson || null,
    application_id: app.id,
    current_unit_id: unit.id
  };
  if (!isNaN(_rent)) _tFields.monthly_rent = _rent;
  Promise.resolve(unitSave).then(function(){
    setTimeout(function(){ _caPatchTenant(org, _tFields); }, 700);
  });

  // 3) Link the application and mark it assigned.
  var upApp = Object.assign({}, app, {
    assignedUnit: unit.id, assignedAddress: addr, status: 'assigned', assignedAt: new Date().toISOString()
  });
  _caPersist(upApp, 'Assigned ' + org + ' to ' + (addr || 'the building') + '.', 'commercial_app_assigned');
  if (typeof renderInventoryView === 'function') renderInventoryView();
  if (typeof renderTenantsView  === 'function') renderTenantsView();
}

function _caPatchTenant(orgName, fields){
  try {
    if (typeof SUPABASE_URL === 'undefined' || !window.HOUSING_HEADERS) return;
    var qs = 'full_name=eq.' + encodeURIComponent(orgName) + '&merged_into=is.null';
    fetch(SUPABASE_URL + '/rest/v1/tenants?' + qs, {
      method:  'PATCH',
      headers: Object.assign({}, HOUSING_HEADERS, { 'Prefer': 'return=minimal' }),
      body:    JSON.stringify(fields)
    }).catch(function(e){ console.warn('[commercial] tenant type patch failed:', e); });
  } catch(e){ console.warn('[commercial] tenant patch threw:', e); }
}

window.openCommercialApp      = openCommercialApp;
window.closeCommercialApp     = closeCommercialApp;
window.submitCommercialApp    = submitCommercialApp;
window.commercialAppDecision  = commercialAppDecision;
window.openCommercialAssign   = openCommercialAssign;
window.confirmAssignCommercial = confirmAssignCommercial;
