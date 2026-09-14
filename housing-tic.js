/* ============================================================
 * housing-tic.js — Tenant Information Card (TIC)
 *
 * Self-contained IIFE that powers the full-screen tenant dashboard
 * triggered from tenants.html row clicks.
 *
 * Public entry points:
 *   window.openTenantCard(idOrUnitId)
 *   window.closeTenantCard()
 *
 * Loaded after housing-modals.js so the optional handoff to
 * openSowModal() (footer "New Work Order" button) resolves.
 * Depends on globals from:
 *   shared-config.js   — SUPABASE_URL, SUPABASE_ANON, STORAGE_BUCKET, ROLE
 *   shared-auth.js     — HOUSING_HEADERS, HOUSING_SESSION
 *   shared-ui.js       — showToast
 *   shared-data.js     — auditEntry, sbSaveApplication
 *   approval-authority.js — APPROVAL_AUTHORITY (optional)
 *   In-memory caches   — applications[], housingUnits[]
 *   window.DocLibrary  — Documents tab mount
 * ============================================================ */

(function(){
  'use strict';

  // ── Schema constants ──────────────────────────────────────────────────────
  var TIC_T = {
    tenants:      'tenants',
    rent_ledger:  'rent_ledger',
    tenant_notes: 'tenant_notes',
    applications: 'housing_applications'
  };
  // Per-tenant emergency-contact column names on the tenants table.
  var TIC_EC = {
    name:         'emergency_contact_name',
    relationship: 'emergency_contact_relationship',
    phone:        'emergency_contact_phone',
    address:      'emergency_contact_address'
  };

  var TIC_VULN_OPTIONS = [
    'Elder in Household',
    'Household Disability',
    'Single Parent',
    'Medical Condition',
    'Mental Health',
    'Domestic Violence',
    'Veteran',
    'Youth',
    'Other'
  ];
  var TIC_C = {
    tenant_pk:          'id',
    tenant_fk:          'tenant_id',
    full_name:          'full_name',
    unit_number:        'unit_number',
    bedrooms:           'bedrooms',
    housing_stream:     'housing_stream',
    move_in_date:       'move_in_date',
    lease_type:         'lease_type',
    band_membership:    'band_membership',
    scoring_points:     'scoring_points',
    file_number:        'file_number',
    wait_list_date:     'wait_list_date',
    vulnerability:      'vulnerability_flags',
    tenancy_status:     'tenancy_status',
    approved_by:        'approved_by',
    application_id:     'application_id',
    relationship:       'relationship',
    date_of_birth:      'date_of_birth',
    role:               'role',
    mobile_phone:       'mobile_phone',
    home_phone:         'home_phone',
    email:              'email',
    mailing_address:    'mailing_address',
    address:            'address',
    pet_name:           'pet_name',
    species:            'species',
    breed:              'breed',
    sex:                'sex',
    age_years:          'age_years',
    approval_status:    'approval_status',
    notes:              'notes',
    monthly_rent:       'monthly_rent',
    arrears_balance:    'arrears_balance',
    arrangement_status: 'arrangement_status',
    arrangement_payment:'arrangement_payment',
    arrangement_start:  'arrangement_start',
    arrangement_clear:  'arrangement_clear_date',
    note_body:          'note_body',
    created_at:         'created_at',
    author_name:        'author_name',
    phone:              'phone',
    hydro_account:      'hydro_account_number',
    hydro_meter:        'hydro_meter_number',
    gas_account:        'gas_account',
    gas_meter:          'gas_meter_number',
    home_care:          'home_care',
    lease_start_date:   'lease_start_date',
    lease_end_date:     'lease_end_date'
  };

  var TIC_SCORE_CAP = 100;
  var TIC_PHONE_RE  = /^[0-9 ()\-+]+$/;
  var TIC_EMAIL_RE  = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  var TIC_UUID_RE   = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var TIC_MISSING_TABLES = {};

  // ── Module state ──────────────────────────────────────────────────────────
  // The application is the source of truth for occupants / contact /
  // references / pets. The tenants row holds tenant-specific fields and the
  // emergency-contact columns. The other tables are tenant-only side data.
  var _ticState = {
    tenant: null,        // tenants row
    unit:   null,        // housing_units row
    application: null,   // housing_applications row (rich data lives in .data merged via sbLoadApplications)
    ledger: null,        // rent_ledger row
    notes: [],           // tenant_notes rows
    applicationNotes: [],// housing_application_notes rows — merged into Notes panel
    movementLog: [],     // tenant_movement_log rows for this tenant (by name)
    activeTab: 'overview',
    prevFocus: null,
    keyHandler: null
  };

  // ── DOM helpers ───────────────────────────────────────────────────────────
  function _ticEl(id){ return document.getElementById(id); }
  function _ticEsc(s){
    if(s == null) return '';
    return String(s).replace(/[&<>"']/g, function(c){
      return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];
    });
  }
  function _ticInitials(name){
    if(!name) return '—';
    var parts = String(name).trim().split(/\s+/);
    return ((parts[0]||'').charAt(0) + (parts[parts.length-1]||'').charAt(0)).toUpperCase() || '—';
  }
  function _ticFmtMoney(n){
    if(n == null || n === '' || isNaN(Number(n))) return '—';
    return '$' + Number(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function _ticFmtDate(s){
    if(!s) return '—';
    try {
      var d = new Date(s);
      if(isNaN(d.getTime())) return String(s);
      return d.toISOString().slice(0,10);
    } catch(e){ return String(s); }
  }
  function _ticFmtDT(s){
    if(!s) return '—';
    try {
      var d = new Date(s);
      if(isNaN(d.getTime())) return String(s);
      return d.toISOString().replace('T',' ').slice(0,16) + ' UTC';
    } catch(e){ return String(s); }
  }
  // Age-from-DOB: delegate to the canonical policyAgeYears (policy-rules.js,
  // loaded on every page housing-tic.js loads on) so the min-age policy gate
  // and the TIC never disagree; local formula kept only as a fallback.
  function _ticAgeNum(dob){
    if(!dob) return null;
    if(typeof policyAgeYears === 'function'){
      var a = policyAgeYears(dob);
      return (a != null && a >= 0) ? a : null;
    }
    var d = new Date(dob);
    if(isNaN(d.getTime())) return null;
    var age = new Date(Date.now() - d.getTime()).getUTCFullYear() - 1970;
    return age >= 0 ? age : null;
  }
  function _ticAge(dob){
    var a = _ticAgeNum(dob);
    return a == null ? '' : String(a) + ' yrs';
  }
  function _ticPet(species){
    var s = (species||'').toLowerCase();
    if(s.indexOf('dog')   >= 0) return '🐕';
    if(s.indexOf('cat')   >= 0) return '🐈';
    if(s.indexOf('bird')  >= 0) return '🐦';
    if(s.indexOf('fish')  >= 0) return '🐟';
    if(s.indexOf('rab')   >= 0) return '🐇';
    if(s.indexOf('rep')   >= 0 || s.indexOf('liz') >= 0 || s.indexOf('snake') >= 0) return '🦎';
    return '🐾';
  }

  // ── Supabase wrappers ─────────────────────────────────────────────────────
  function _ticReady(){
    return (typeof SUPABASE_URL !== 'undefined' && typeof HOUSING_HEADERS !== 'undefined');
  }
  function _ticGet(path){
    if(!_ticReady()) return Promise.reject(new Error('supabase config not loaded'));
    var tableKey = (path.split('?')[0] || '').split('/')[0];
    if(TIC_MISSING_TABLES[tableKey]) return Promise.resolve({ _ticMissing: true, _status: 404 });
    return fetch(SUPABASE_URL + '/rest/v1/' + path, { headers: HOUSING_HEADERS })
      .then(function(r){
        if(r.status === 404){ TIC_MISSING_TABLES[tableKey] = true; return { _ticMissing: true, _status: 404 }; }
        if(r.status === 400) return { _ticMissing: true, _status: 400 };
        if(!r.ok) return { _ticError: true, _status: r.status };
        return r.json();
      })
      .catch(function(err){ return { _ticError: true, _err: String(err) }; });
  }
  // Field Employees (maintenance crew) get a read-only Tenant Information Card —
  // they need the unit/tenant context to do a work order but must not edit tenant
  // data. Edits are blocked at the entry points (_ticOnBodyChange / toggles) for
  // clean UX; this is the hard backstop on the write path.
  function _ticReadOnlyRole(){
    return (window.currentRole || '') === 'field_employee';
  }
  // Eviction notices are a serious legal action — restricted to HM/ED.
  function _ticCanEvict(){
    var r = window.currentRole || '';
    if (typeof CLFN_PERMS !== 'undefined' && CLFN_PERMS.normalizeRole) r = CLFN_PERMS.normalizeRole(r);
    return r === 'ed' || r === 'housing_manager';
  }
  function _ticWrite(method, path, body){
    if(!_ticReady()) return Promise.reject(new Error('supabase config not loaded'));
    if(_ticReadOnlyRole()) return Promise.reject(new Error('read-only role'));
    var hdrs = Object.assign({}, HOUSING_HEADERS, { 'Prefer': 'return=representation' });
    return fetch(SUPABASE_URL + '/rest/v1/' + path, {
      method: method,
      headers: hdrs,
      body: JSON.stringify(body)
    }).then(function(r){
      if(!r.ok) return r.text().then(function(t){ throw new Error('HTTP '+r.status+': '+t); });
      var ind = document.getElementById('tic_saved_indicator');
      if(ind) ind.textContent = '✓ Saved ' + new Date().toLocaleTimeString([], {hour:'numeric', minute:'2-digit'});
      return r.json();
    });
  }
  function _ticIsArray(v){ return Array.isArray(v); }
  function _ticIsMissing(v){ return v && v._ticMissing === true; }
  function _ticIsError(v){   return v && v._ticError === true; }

  // ── Resolve tenant + unit ─────────────────────────────────────────────────
  function _ticResolveTenant(idOrUnitId){
    var lookupAsTenantId = TIC_UUID_RE.test(String(idOrUnitId));
    var primary = lookupAsTenantId
      ? _ticGet(TIC_T.tenants + '?' + TIC_C.tenant_pk + '=eq.' + encodeURIComponent(idOrUnitId) + '&select=*')
      : Promise.resolve([]);
    return primary.then(function(rows){
      if(_ticIsArray(rows) && rows.length) return { tenant: rows[0], byUnit: false };
      // Treat as unit id: find unit in housingUnits, then look up tenant by assigned_name.
      var unit = _ticFindUnitById(idOrUnitId);
      if(!unit) return _ticResolveApplicant(idOrUnitId);   // maybe an application id
      if(!unit.assignedName) return { tenant: null, byUnit: true, unit: unit };
      return _ticGet(TIC_T.tenants + '?' + TIC_C.full_name + '=eq.' + encodeURIComponent(unit.assignedName) + '&merged_into=is.null&select=*')
        .then(function(rows2){
          if(_ticIsArray(rows2) && rows2.length) return { tenant: rows2[0], byUnit: true, unit: unit };
          return { tenant: null, byUnit: true, unit: unit };
        });
    });
  }
  function _ticFindUnitById(id){
    try {
      var src = getAllUnits();
      for(var i=0;i<src.length;i++){ if(String(src[i].id) === String(id)) return src[i]; }
    } catch(e){}
    return null;
  }
  function _ticFindAppById(id){
    try {
      var src = (typeof applications !== 'undefined' && applications) ? applications : [];
      for(var i=0;i<src.length;i++){ if(String(src[i].id) === String(id)) return src[i]; }
    } catch(e){}
    return null;
  }
  // Virtual (un-saved) tenant built from an application. Has no tenant_pk, so the
  // first field edit creates the real tenants row (status 'applicant').
  function _ticVirtualTenantFromApp(app){
    var nm = ((app.fn||'') + ' ' + (app.ln||'')).trim() || app.applicant_name || 'Applicant';
    var vt = {};
    vt[TIC_C.full_name]      = nm;
    vt[TIC_C.application_id] = app.id;
    vt[TIC_C.email]          = app.email || '';
    vt.status = 'applicant';
    vt._virtual = true;
    return vt;
  }
  // Open a card by application id: reuse a tenants row already linked to the
  // application, else a virtual tenant that create-on-edit will persist.
  function _ticResolveApplicant(id){
    var app = _ticFindAppById(id);
    if(!app) return Promise.resolve({ tenant: null, byUnit: false, unit: null });
    return _ticGet(TIC_T.tenants + '?' + TIC_C.application_id + '=eq.' + encodeURIComponent(app.id) + '&select=*&order=created_at.desc')
      .then(function(rows){
        if(_ticIsArray(rows) && rows.length){
          var trow = rows[0];
          // If they're housed, surface their unit too (rent/utilities/history).
          return { tenant: trow, byUnit:false, unit: _ticFindUnitById(trow.current_unit_id) || null };
        }
        return { tenant: _ticVirtualTenantFromApp(app), byUnit:false, unit:null, virtual:true };
      });
  }

  // ── Per-tab parallel loaders ──────────────────────────────────────────────
  // Only tenant-side rows are fetched here. Occupants / Contact / References /
  // Pets all read from _ticState.application (loaded by _ticLoadApplication).
  function _ticLoadAll(tenantId, unit){
    var fk = encodeURIComponent(tenantId);
    var tenantName = (_ticState.tenant && _ticState.tenant[TIC_C.full_name]) || '';
    var movLogP = tenantName
      ? _ticGet('tenant_movement_log?tenant_name=eq.' + encodeURIComponent(tenantName) + '&order=move_out_date.desc')
      : Promise.resolve([]);
    return Promise.all([
      _ticGet(TIC_T.rent_ledger  + '?' + TIC_C.tenant_fk + '=eq.' + fk + '&select=*&limit=1'),
      _ticGet(TIC_T.tenant_notes + '?' + TIC_C.tenant_fk + '=eq.' + fk + '&select=*&order=' + TIC_C.created_at + '.desc'),
      movLogP
    ]).then(function(res){
      _ticState.ledger      = _ticIsArray(res[0]) ? (res[0][0] || null) : res[0];
      _ticState.notes       = _ticIsArray(res[1]) ? res[1] : (res[1] || []);
      _ticState.movementLog = _ticIsArray(res[2]) ? res[2] : [];
      _ticState.unit        = unit || _ticState.unit;
    });
  }
  // Resolves the linked application (full row) and caches it for read-only
  // surfacing across the Overview, Occupants (co-app/habitants), Pets, and
  // References tabs. Uses the same name-fallback chain as the View Application
  // footer button so a tenant without an explicit application_id still wires up.
  function _ticLoadApplication(){
    return _ticFindApplicationForTenant().then(function(appId){
      if(!appId){ _ticState.application = null; return; }
      var local = (typeof applications !== 'undefined' && applications && applications.length)
                ? applications : (window.SP_APPLICATIONS || []);
      var hydrated = null;
      for(var i=0;i<local.length;i++){
        if(local[i] && local[i].id === appId){ hydrated = local[i]; break; }
      }
      var appPromise = hydrated
        ? Promise.resolve().then(function(){ _ticState.application = hydrated; })
        : _ticGet(TIC_T.applications + '?id=eq.' + encodeURIComponent(appId) + '&select=*&limit=1').then(function(rows){
            if(_ticIsArray(rows) && rows.length){
              var raw = rows[0];
              // The applications table stores rich data in a JSONB `data` column.
              // Mirror sbLoadApplications: spread data first so callers see a flat
              // app object with fn/ln/pets/references/etc. directly addressable.
              _ticState.application = Object.assign({}, raw.data || {}, raw, { id: raw.id });
            } else {
              _ticState.application = null;
            }
          });
      // After the application row resolves, also pull any internal notes that
      // were captured during intake. These are merged into the TIC Notes panel
      // alongside tenant_notes so attribution carries over once the applicant
      // becomes a tenant.
      return appPromise.then(function(){
        if(typeof window.sbLoadAppNotes !== 'function') return;
        return window.sbLoadAppNotes(appId).then(function(rows){
          _ticState.applicationNotes = Array.isArray(rows) ? rows : [];
        }).catch(function(){ _ticState.applicationNotes = []; });
      });
    }).catch(function(){ _ticState.application = null; _ticState.applicationNotes = []; });
  }

  // ── Render: hero, strip, tabs ─────────────────────────────────────────────
  function _ticRenderHero(){
    var t = _ticState.tenant || {};
    var u = _ticState.unit   || {};
    var name = t[TIC_C.full_name] || u.assignedName || 'Unknown Tenant';
    _ticEl('tic_avatar').textContent = _ticInitials(name);
    _ticEl('tic_name').textContent   = name;

    var subParts = [];
    if(t[TIC_C.unit_number]) subParts.push('Unit ' + t[TIC_C.unit_number]);
    else if(u.num)           subParts.push('Unit ' + u.num + (u.street?' '+u.street:''));
    if(t[TIC_C.bedrooms] != null)    subParts.push(t[TIC_C.bedrooms] + '-bed');
    else if(u.bedrooms != null)      subParts.push(u.bedrooms + '-bed');
    _ticEl('tic_hero_sub').textContent = subParts.join(' · ');

    var badges = [];
    var stream = t[TIC_C.housing_stream];
    if(stream) badges.push('<span class="std-pill std-pill-info">' + _ticEsc(stream) + '</span>');
    var status = t[TIC_C.tenancy_status] || u.status;
    if(status) badges.push('<span class="std-pill std-pill-info">' + _ticEsc(status) + '</span>');
    var band   = t[TIC_C.band_membership] || ((_ticState.application || {}).band) || '';
    if(band) badges.push('<span class="std-pill std-pill-info">' + _ticEsc(band) + '</span>');
    // BCR / ineligibility flag — prominent so staff see it before any action.
    if(typeof bcrLookup === 'function'){
      var _bcr = bcrLookup(name);
      if(_bcr){
        badges.unshift('<span class="std-pill" style="background:#7f1d1d;color:#fff;font-weight:700;">⛔ BCR’d — ineligible'
          + (_bcr.bcrd_date ? ' (' + _ticEsc(_bcr.bcrd_date) + ')' : '') + '</span>');
      }
    }
    // Last-note-age nudge: red when there are no notes or the newest is older
    // than the stale threshold, so staff are prompted to keep the file current.
    var _na = _ticLastNoteInfo();
    if(_na){ badges.push(_na.badge); }
    _ticEl('tic_hero_badges').innerHTML = badges.join('');
  }
  // Newest note across tenant_notes (_ticState.notes) + intake application notes
  // (_ticState.applicationNotes) — both carry `created_at`. Returns a badge HTML
  // string; null only if the state isn't ready. Stale threshold = 90 days.
  var _TIC_NOTE_STALE_DAYS = 90;
  function _ticLastNoteInfo(){
    var rows = [].concat(
      _ticIsArray(_ticState.notes) ? _ticState.notes : [],
      _ticIsArray(_ticState.applicationNotes) ? _ticState.applicationNotes : []
    );
    var newest = 0;
    rows.forEach(function(n){
      var v = n && (n[TIC_C.created_at] || n.created_at);
      if(!v) return;
      var t = new Date(v).getTime();
      if(!isNaN(t) && t > newest) newest = t;
    });
    if(!newest){
      return { days: null, stale: true, badge: '<span class="std-pill" style="background:#7f1d1d;color:#fff;font-weight:700;" title="No notes on file — add one">🕑 No notes</span>' };
    }
    var days = Math.floor((Date.now() - newest) / 86400000);
    var stale = days > _TIC_NOTE_STALE_DAYS;
    var ago = days <= 0 ? 'today' : days === 1 ? '1 day ago' : days + ' days ago';
    var style = stale
      ? 'background:var(--danger-bg);color:var(--danger);border:1px solid #fca5a5;font-weight:700;'
      : 'background:#f4f4f0;color:var(--muted);';
    return { days: days, stale: stale,
      badge: '<span class="std-pill" style="' + style + '" title="Newest note on this tenant file">🕑 Last note: ' + ago + '</span>' };
  }
  function _ticRenderStrip(){
    var t = _ticState.tenant  || {};
    var l = _ticState.ledger  || {};
    var u = _ticState.unit    || {};
    // Rent prefers the per-tenant ledger row; falls back to the unit's
    // monthlyRent (set on the Inventory > Edit Unit form) so newly added units
    // surface their rate even before a ledger row exists for the tenant.
    var rent = (l[TIC_C.monthly_rent] != null)
             ? l[TIC_C.monthly_rent]
             : (u.monthlyRent != null ? u.monthlyRent : (u.monthly_rent != null ? u.monthly_rent : null));
    var arrears = (l[TIC_C.arrears_balance] != null) ? Number(l[TIC_C.arrears_balance]) : null;
    _ticEl('tic_strip_rent').textContent    = rent != null ? _ticFmtMoney(rent) : '—';

    var arrearsEl = _ticEl('tic_strip_arrears');
    arrearsEl.classList.remove('tic-arrears-bad','tic-arrears-good');
    if(arrears == null){
      arrearsEl.textContent = '—';
    } else if(arrears > 0){
      arrearsEl.textContent = _ticFmtMoney(arrears);
      arrearsEl.classList.add('tic-arrears-bad');
    } else {
      arrearsEl.textContent = _ticFmtMoney(0);
      arrearsEl.classList.add('tic-arrears-good');
    }

    _ticEl('tic_strip_movein').textContent = _ticFmtDate(t[TIC_C.move_in_date] || u.assignedDate);
    _ticEl('tic_strip_lease').textContent  = t[TIC_C.lease_type]    || '—';
    _ticEl('tic_strip_status').textContent = t[TIC_C.tenancy_status] || u.status || '—';

    // Lease end date — highlight if expiring within 90 days or already expired
    var leaseEndEl = _ticEl('tic_strip_lease_end');
    if (leaseEndEl) {
      var leaseEnd = t[TIC_C.lease_end_date];
      leaseEndEl.textContent = leaseEnd ? _ticFmtDate(leaseEnd) : '—';
      leaseEndEl.style.color = '';
      if (leaseEnd) {
        var daysLeft = Math.ceil((new Date(leaseEnd) - new Date()) / 86400000);
        if (daysLeft < 0)  leaseEndEl.style.color = 'var(--danger,#ef4444)';
        else if (daysLeft <= 90) leaseEndEl.style.color = 'var(--warn-amber-text,#b45309)';
      }
    }
    var hccEl   = _ticEl('tic_strip_hcc');
    var hccTile = document.getElementById('tic_strip_hcc_tile');
    var isHcc   = !!t[TIC_C.home_care];
    if (hccEl) {
      hccEl.textContent = isHcc ? 'Yes — click to remove' : 'No — click to flag';
      hccEl.style.color = isHcc ? 'var(--success)' : 'var(--muted)';
    }
    if (hccTile) {
      hccTile.title = isHcc ? 'Click to remove H&CC flag' : 'Click to flag as Home & Community Care';
      hccTile.style.background = isHcc ? 'var(--success-bg)' : '';
    }
  }

  // ── Render: Overview ──────────────────────────────────────────────────────
  // Editable rows write to the `tenants` table via PATCH. Read-only rows are
  // unit-derived (bedrooms, unit_number) or system-set (approved_by) and
  // always render as plain text.
  var TIC_TENANCY_OPTIONS = ['active','vacated','transferred','evicted','suspended','deceased','bankrupt','banished','harbouring'];
  var TIC_LEASE_TYPE_OPTIONS = ['Rental','Rent-to-Own','Lease-to-Own','Market','Subsidized','Elders','Family Compound','Other'];
  var TIC_INCOME_PERSONS = ['Applicant','Co-Applicant'];
  // Derived from the canonical shared-config list ('No Income' excluded —
  // staff record actual income rows only); inline fallback keeps the TIC
  // working if shared-config predates INCOME_TYPES.
  var TIC_INCOME_TYPES = (window.INCOME_TYPES || []).map(function(t){ return t.v; })
    .filter(function(v){ return v !== 'No Income'; });
  if(!TIC_INCOME_TYPES.length) TIC_INCOME_TYPES = ['Employed','Self-Employment','OW','ODSP','CPP','EI','Pension','Other'];
  var TIC_OVERVIEW_FIELDS = [
    { key: TIC_C.wait_list_date,  label: 'Wait List Date',      type: 'date',   readOnly: true },
    { key: TIC_C.lease_type,      label: 'Lease Type',          type: 'select', options: TIC_LEASE_TYPE_OPTIONS },
    { key: TIC_C.band_membership, label: 'Band Membership',     type: 'text' },
    // Unit details
    { key: TIC_C.unit_number,     label: 'Unit Number',         type: 'text',   readOnly: true, group: 'unit' },
    { key: TIC_C.bedrooms,        label: 'Bedrooms',            type: 'number', readOnly: true, group: 'unit' },
    { key: TIC_C.move_in_date,      label: 'Move-In Date',        type: 'date',   group: 'unit' },
    { key: TIC_C.lease_start_date,  label: 'Lease Start Date',    type: 'date',   group: 'unit' },
    { key: TIC_C.lease_end_date,    label: 'Lease End Date',      type: 'date',   group: 'unit' },
    { key: TIC_C.tenancy_status,    label: 'Tenancy Status',      type: 'select', options: TIC_TENANCY_OPTIONS, group: 'unit' },
    { key: TIC_C.vulnerability,   label: 'Vulnerability Flags', type: 'multi',  options: TIC_VULN_OPTIONS, group: 'unit' },
    { key: TIC_C.application_id,  label: 'Application Number',  type: 'text',   group: 'meta',      readOnly: true },
    { key: TIC_C.hydro_account,   label: 'Hydro Account #',     type: 'text',   group: 'utilities' },
    { key: TIC_C.hydro_meter,     label: 'Hydro Meter #',       type: 'text',   group: 'utilities', saveTarget: 'unit' },
    { key: TIC_C.gas_account,     label: 'Union Gas Account #', type: 'text',   group: 'utilities' },
    { key: TIC_C.gas_meter,       label: 'Gas Meter #',         type: 'text',   group: 'utilities', saveTarget: 'unit' }
  ];

  function _ticOverviewRowVal(field){
    var t = _ticState.tenant || {};
    var u = _ticState.unit   || {};
    var a = _ticState.application;
    // Fields marked saveTarget:'unit' are stored on housing_units, not tenants.
    var v = field.saveTarget === 'unit' ? u[field.key] : t[field.key];
    // Unit-derived fall-throughs (read-only rows)
    if(field.key === TIC_C.unit_number && (v == null || v === '') && u.num){
      return (u.num + (u.street ? ' ' + u.street : ''));
    }
    if(field.key === TIC_C.bedrooms && (v == null || v === '') && u.bedrooms != null){
      return u.bedrooms;
    }
    if(field.key === TIC_C.move_in_date && (v == null || v === '') && u.assignedDate){
      return u.assignedDate;
    }
    if(field.key === TIC_C.tenancy_status && (v == null || v === '') && u.status){
      return u.status;
    }
    // Band Membership — fall back to the linked application's band number.
    // Applications (staff wizard and the external portal alike) store it as
    // app.band; the tenants.band_membership column only fills once staff
    // save it on the TIC, so without this fall-through a portal applicant's
    // band number never showed here.
    if(field.key === TIC_C.band_membership && (v == null || v === '') && a && a.band){
      return a.band;
    }
    // Application Number — prefer the resolved application's id over a
    // potentially stale tenants.application_id column.
    if(field.key === TIC_C.application_id){
      if(a && a.id) return a.id;
      return v || '';
    }
    // Wait List Date — derived from the application's appDate (the canonical
    // source used by scoring). Tenants column override is honoured if present.
    if(field.key === TIC_C.wait_list_date){
      if(v) return v;
      if(a && a.appDate)     return a.appDate;
      if(a && a.submittedAt) return a.submittedAt;
      return '';
    }
    // Vulnerability Flags — only fall back to derived defaults from the
    // application when the stored column is genuinely unset (null/undefined).
    // An explicit empty array means the user unchecked everything; respect it.
    if(field.key === TIC_C.vulnerability){
      if(_ticIsArray(v)) return v;
      if(typeof v === 'string'){
        var trimmed = v.trim();
        if(!trimmed) return [];
        return trimmed.split(',').map(function(s){return s.trim();}).filter(function(s){return s.length;});
      }
      // v is null or undefined → derive from the linked application's flags
      var derived = [];
      if(a && a.elderInHousehold)    derived.push('Elder in Household');
      if(a && a.householdDisability) derived.push('Household Disability');
      return derived;
    }
    return v;
  }
  function _ticOverviewRowDisplay(field){
    var v = _ticOverviewRowVal(field);
    if(field.type === 'date')   return _ticFmtDate(v);
    if(field.type === 'array'){
      if(_ticIsArray(v) && v.length) return v.join(', ');
      if(typeof v === 'string' && v.trim()) return v;
      return '';
    }
    return (v == null) ? '' : String(v);
  }
  function _ticOverviewInputHtml(field){
    var rawVal = _ticOverviewRowVal(field);
    if(rawVal == null) rawVal = '';
    if(field.type === 'multi'){
      var current = _ticIsArray(rawVal) ? rawVal : [];
      return '<div class="tic-vuln-grid">' + (field.options || []).map(function(o){
        var ck = current.indexOf(o) >= 0 ? ' checked' : '';
        return '<label class="tic-chk"><input type="checkbox" data-tic-ov-input="1" data-tic-vuln="' + _ticEsc(o) + '"' + ck + '/> ' + _ticEsc(o) + '</label>';
      }).join('') + '</div>';
    }
    if(field.type === 'select'){
      var opts = (field.options || []).map(function(o){
        var sel = (String(o) === String(rawVal)) ? ' selected' : '';
        return '<option value="' + _ticEsc(o) + '"' + sel + '>' + _ticEsc(o) + '</option>';
      }).join('');
      return '<select class="tic-input" data-tic-ov-input="1"><option value="">—</option>' + opts + '</select>';
    }
    if(field.type === 'array'){
      var asText = _ticIsArray(rawVal) ? rawVal.join(', ') : (rawVal || '');
      return '<input class="tic-input" type="text" data-tic-ov-input="1" placeholder="comma-separated" value="' + _ticEsc(asText) + '"/>';
    }
    if(field.type === 'date'){
      var d = rawVal ? String(rawVal).slice(0,10) : '';
      return '<input class="tic-input" type="date" data-tic-ov-input="1" value="' + _ticEsc(d) + '"/>';
    }
    if(field.type === 'number'){
      return '<input class="tic-input" type="number" data-tic-ov-input="1" value="' + _ticEsc(rawVal) + '"/>';
    }
    return '<input class="tic-input" type="text" data-tic-ov-input="1" value="' + _ticEsc(rawVal) + '"/>';
  }
  function _ticOverviewRowHtml(field){
    if(field.readOnly){
      var disp = _ticOverviewRowDisplay(field);
      var has  = (disp !== '' && disp !== '—');
      return '<div class="tic-row tic-row-readonly">'
           +   '<div class="tic-row-lbl">' + _ticEsc(field.label) + '</div>'
           +   '<div class="tic-row-val">' + (has ? _ticEsc(disp) : '<span class="tic-field-val tic-empty">—</span>') + '</div>'
           + '</div>';
    }
    return '<div class="tic-row tic-row-edit" data-tic-ov-key="' + _ticEsc(field.key) + '" data-tic-ov-type="' + field.type + '">'
         +   '<div class="tic-row-lbl">' + _ticEsc(field.label) + '</div>'
         +   '<div class="tic-row-val">' + _ticOverviewInputHtml(field) + '</div>'
         + '</div>';
  }

  function _ticIncomeRows(){
    var a = _ticState.application;
    if(!a || !_ticIsArray(a.incomes)) return [];
    return a.incomes.filter(function(r){
      return r && (r.incomeType || r.employer || r.primaryAmt != null);
    });
  }
  function _ticRenderOverview(){
    var l = _ticState.ledger  || {};

    function renderGroup(filter){
      return TIC_OVERVIEW_FIELDS.filter(filter).map(_ticOverviewRowHtml).join('');
    }

    var html = ''
      + '<div class="tic-section">'
      +   '<div class="tic-section-h">Application Summary</div>'
      +   '<div class="tic-rows">'
      +     renderGroup(function(f){ return !f.group; })
      +   '</div>'
      + '</div>'
      + '<div class="tic-section">'
      +   '<div class="tic-section-h">Unit Details</div>'
      +   '<div class="tic-rows">'
      +     renderGroup(function(f){ return f.group === 'unit'; })
      +   '</div>'
      + '</div>';

    // Income section — editable list of app.incomes. Amount is intentionally
    // hidden from the TIC; if it's set elsewhere (application form), the value
    // is preserved through edits but never displayed or surfaced for input.
    var app     = _ticState.application;
    var incomes = _ticIsArray(app && app.incomes) ? app.incomes : [];
    html += '<div class="tic-section">'
         +    '<div class="tic-section-h">Employment &amp; Income</div>';
    if(!app){
      html += '<div class="tic-pending-inline">No linked application — income is sourced from the application form.</div>';
    } else {
      var realIncomes = incomes.filter(function(r){ return r && (r.incomeType || r.employer || r.person); });
      if(!realIncomes.length){
        html += '<div class="tic-empty">No income records on the application.</div>';
      } else {
        html += '<table class="tic-table"><thead><tr>'
             +    '<th>Person</th><th>Type</th><th>Employer</th><th></th>'
             +    '</tr></thead><tbody>';
        incomes.forEach(function(r, idx){
          if(!r || (!r.incomeType && !r.employer && !r.person)) return;
          html += '<tr data-tic-inc-idx="' + idx + '">'
               +   '<td>' + _ticEsc(r.person || '—') + '</td>'
               +   '<td>' + _ticEsc(r.incomeType || '—') + '</td>'
               +   '<td>' + _ticEsc(r.employer || '—') + '</td>'
               +   '<td class="tic-row-actions">'
               +     '<button type="button" class="btn btn-ghost" data-tic-action="inc-edit">Edit</button>'
               +     '<button type="button" class="btn btn-ghost" data-tic-action="inc-delete">Delete</button>'
               +   '</td>'
               + '</tr>';
        });
        html += '</tbody></table>';
      }
      html += '<div class="tic-form-actions"><button type="button" class="btn btn-primary" data-tic-action="inc-add">+ Add Income Record</button></div>';
      // Person options: Applicant/Co-Applicant plus every named household
      // member. Portal submissions record income against the member's NAME
      // (the online form's "Who" is free text), so without these options an
      // online record's person could never be shown or re-selected here.
      var personNames = TIC_INCOME_PERSONS.slice();
      (( app && _ticIsArray(app.habitants)) ? app.habitants : []).forEach(function(h){
        var nm = [h && h.fn, h && h.ln].filter(Boolean).join(' ').trim();
        if(nm && personNames.indexOf(nm) < 0) personNames.push(nm);
      });
      var personOpts = personNames.map(function(p){ return '<option value="' + _ticEsc(p) + '">' + _ticEsc(p) + '</option>'; }).join('');
      var typeOpts   = TIC_INCOME_TYPES.map(function(t){ return '<option value="' + _ticEsc(t) + '">' + _ticEsc(t) + '</option>'; }).join('');
      // Form mirrors the application form's persisted income shape:
      // {person, incomeType, employer, primaryAmt}. Employer field reveals
      // when Income Type is Employed/Self-Employment (matches app form behaviour).
      html += '<div id="tic_inc_form" class="tic-add-form" data-tic-inc-mode="add">'
           +   '<div class="tic-grid-2">'
           +     '<div class="tic-field"><label class="tic-field-lbl">Person *</label>'
           +       '<select class="tic-input" id="tic_inc_person"><option value="">—</option>' + personOpts + '</select></div>'
           +     '<div class="tic-field"><label class="tic-field-lbl">Income Type *</label>'
           +       '<select class="tic-input" id="tic_inc_type"><option value="">—</option>' + typeOpts + '</select></div>'
           +     '<div class="tic-field tic-grid-span-2 tic-inc-employer-row"><label class="tic-field-lbl">Employer</label><input class="tic-input" id="tic_inc_employer" type="text"/></div>'
           +     '<div class="tic-field"><label class="tic-field-lbl">Primary Amount</label><input class="tic-input" id="tic_inc_amount" type="number" min="0" step="0.01" placeholder="0.00"/></div>'
           +     '<div class="tic-field"><label class="tic-field-lbl">Period</label>'
           +       '<select class="tic-input" id="tic_inc_period"><option value="">—</option><option value="month">Per Month</option><option value="annual">Per Year</option></select></div>'
           +   '</div>'
           +   '<div class="tic-form-actions">'
           +     '<button type="button" class="btn btn-ghost"   data-tic-action="inc-cancel">Cancel</button>'
           +     '<button type="button" class="btn btn-primary" data-tic-action="inc-save">Save</button>'
           +   '</div>'
           + '</div>';
    }
    html += '</div>';

    var u_for_rent = _ticState.unit || {};
    var displayRent = (l[TIC_C.monthly_rent] != null)
                    ? l[TIC_C.monthly_rent]
                    : (u_for_rent.monthlyRent != null ? u_for_rent.monthlyRent : (u_for_rent.monthly_rent != null ? u_for_rent.monthly_rent : null));
    html += '<div class="tic-section">'
         +    '<div class="tic-section-h">Application Linkage</div>'
         +    '<div class="tic-rows">'
         +      renderGroup(function(f){ return f.group === 'meta'; })
         +    '</div>'
         + '</div>'
         + '<div class="tic-section">'
         +    '<div class="tic-section-h">Rent Arrangement</div>'
         +    '<div class="tic-grid-3">'
         +      _ticField('Monthly Rent',           _ticFmtMoney(displayRent))
         +      _ticField('Arrears Balance',        _ticFmtMoney(l[TIC_C.arrears_balance]))
         +      _ticField('Arrangement Status',     l[TIC_C.arrangement_status])
         +      _ticField('Arrangement Payment',    _ticFmtMoney(l[TIC_C.arrangement_payment]))
         +      _ticField('Arrangement Start',      _ticFmtDate(l[TIC_C.arrangement_start]))
         +      _ticField('Clear-By Date',          _ticFmtDate(l[TIC_C.arrangement_clear]))
         +    '</div>'
         + '</div>'
        ;

    var u = _ticState.unit || {};
    var mapHtml = ''
      + '<div class="map-widget">'
      +   '<div class="map-widget-header">'
      +     '<span class="map-pin-icon">&#128205;</span>'
      +     '<div>'
      +       '<div class="map-widget-label">Unit Location</div>'
      +       '<div class="map-widget-address" id="map-unit-address">&#8212;</div>'
      +     '</div>'
      +   '</div>'
      +   '<div class="map-frame-wrap">'
      +     '<iframe id="map-iframe" class="map-frame" src="" allowfullscreen title="Unit location map"></iframe>'
      +     '<div class="map-no-coords" id="map-no-coords" style="display:none;">'
      +       '<span>&#128205;</span>'
      +       '<p>Coordinates not yet set for this unit.<br>Add lat/lng in the unit record to enable the map.</p>'
      +     '</div>'
      +   '</div>'
      +   '<div class="map-widget-footer">'
      +     '<div class="map-coords" id="map-coords-display">&#8212;</div>'
      +     '<a class="map-osm-link" id="map-osm-link" href="#" target="_blank" rel="noopener">Open in Map &#8599;</a>'
      +   '</div>'
      + '</div>';

    var photoWrapHtml = '<div class="unit-photo-wrap" id="unit-photo-wrap" style="display:none;">'
      + '<img class="unit-photo-img" id="unit-photo-img" src="" alt="House photo"/>'
      + '</div>';

    // Mapping module gate — when the nation has the Mapping feature turned off
    // (Settings → Nation), hide the location/photo column entirely.
    var mapOn = (typeof moduleOn === 'function') ? moduleOn('mapping') : true;

    var canSetLoc = mapOn
      && typeof APPROVAL_AUTHORITY !== 'undefined'
      && APPROVAL_AUTHORITY.can('setUnitLocation', window.currentRole || '');
    var adminBtnHtml = canSetLoc
      ? '<button type="button" class="btn-set-location" data-tic-action="slp-open">&#128205; Set Location &amp; Photo</button>'
      : '';

    _ticEl('tic_panel_overview').innerHTML =
      '<div class="tic-overview-columns' + (mapOn ? '' : ' tic-overview-nomap') + '">'
      + '<div class="tic-overview-main">' + html + '</div>'
      + (mapOn ? '<div class="tic-overview-map">' + photoWrapHtml + mapHtml + adminBtnHtml + '</div>' : '')
      + '</div>';

    if(mapOn) _ticInitMap(u);

    // Arrears & repayment (Policy s.12 machine, arrears.js) — reads the
    // FINANCE ledger/arrangements; renders below the overview columns.
    if (typeof arrearsRenderTicPanel === 'function') {
      try {
        var _arMain = _ticEl('tic_panel_overview').querySelector('.tic-overview-main');
        if (_arMain) {
          var _arMount = document.createElement('div');
          _arMount.id = 'tic_arrears_mount';
          _arMain.appendChild(_arMount);
          var _arName = (_ticState.tenant && _ticState.tenant[TIC_C.full_name])
                     || (_ticState.unit && _ticState.unit.assignedName) || '';
          var _arRent = (_ticState.unit && (_ticState.unit.monthlyRent != null ? _ticState.unit.monthlyRent : _ticState.unit.monthly_rent)) || 0;
          arrearsRenderTicPanel(_arMount, _arName, Number(_arRent) || 0);
        }
      } catch(e) { console.warn('[TIC] arrears panel failed:', e); }
    }
  }

  var _ticUtilDocLib    = null;
  var _ticUtilDocLibKey = null;

  function _ticRenderUtilities(){
    var panel = _ticEl('tic_panel_utilities');
    if(!panel) return;
    var unit = _ticState.unit;
    var key  = (unit && unit.id) ? String(unit.id) : null;

    // Only rebuild HTML when switching to a different unit — preserving the
    // mounted DocLibrary instance between tab switches on the same unit.
    if(_ticUtilDocLibKey !== key || !_ticUtilDocLib){
      _ticUtilDocLib    = null;
      _ticUtilDocLibKey = null;

      var rows = TIC_OVERVIEW_FIELDS
        .filter(function(f){ return f.group === 'utilities'; })
        .map(_ticOverviewRowHtml).join('');

      panel.innerHTML =
        '<div class="tic-section">'
        + '<div class="tic-section-h">Account &amp; Meter Numbers</div>'
        + '<div class="tic-rows">' + rows + '</div>'
        + '</div>'
        + '<div class="tic-section" style="margin-top:16px;">'
        + '<div class="tic-section-h">Utility Bills</div>'
        + '<div id="tic_util_doclib_mount" style="margin-top:8px;"></div>'
        + '</div>';

      if(!key){
        var m = _ticEl('tic_util_doclib_mount');
        if(m) m.innerHTML = '<div class="tic-empty">No unit linked — bill storage unavailable.</div>';
        return;
      }
      if(!window.DocLibrary){
        var m2 = _ticEl('tic_util_doclib_mount');
        if(m2) m2.innerHTML = '<div class="tic-pending-inline">Document library not loaded.</div>';
        return;
      }
      var mount = _ticEl('tic_util_doclib_mount');
      if(!mount) return;
      _ticUtilDocLibKey = key;
      _ticUtilDocLib = window.DocLibrary.create(mount, {
        entityType:    'unit',
        entityId:      unit.id,
        pathPrefix:    'units/' + unit.id + '/utility-bills',
        supabaseUrl:   SUPABASE_URL,
        supabaseAnon:  (typeof SUPABASE_ANON !== 'undefined') ? SUPABASE_ANON : '',
        storageBucket: (typeof STORAGE_BUCKET !== 'undefined') ? STORAGE_BUCKET : 'housing-files',
        auditTable:    'housing_audit_log',
        getAuthToken:  function(){ return (window.HOUSING_HEADERS && window.HOUSING_HEADERS['Authorization'] || '').replace('Bearer ',''); },
        getActor:      function(){ return (window.HOUSING_SESSION && window.HOUSING_SESSION.email) || window.currentRole || 'staff'; },
        readOnly: _ticReadOnlyRole(),
        categories: [
          { key:'hydro_bill', label:'Hydro Bill', icon:'⚡' },
          { key:'gas_bill',   label:'Gas Bill',   icon:'🔥' },
          { key:'other',      label:'Other',      icon:'📎' }
        ],
        maxSizeMB: 25
      });
    }
  }

  function _ticInitMap(unit){
    var u   = unit || {};
    var lat = u.latitude  != null ? parseFloat(u.latitude)  : null;
    var lng = u.longitude != null ? parseFloat(u.longitude) : null;
    var addrEl   = document.getElementById('map-unit-address');
    var iframeEl = document.getElementById('map-iframe');
    var noCrdEl  = document.getElementById('map-no-coords');
    var coordEl  = document.getElementById('map-coords-display');
    var linkEl   = document.getElementById('map-osm-link');
    if(!iframeEl) return;

    var photoWrap = document.getElementById('unit-photo-wrap');
    var photoImg  = document.getElementById('unit-photo-img');
    if(photoWrap && photoImg){
      if(u.photo_url){
        photoImg.src = (typeof sbGetFileUrl === 'function') ? sbGetFileUrl(u.photo_url) : u.photo_url;
        photoWrap.style.display = 'block';
      } else {
        photoWrap.style.display = 'none';
      }
    }

    var address = [u.num && u.street ? u.num + ' ' + u.street : (u.address || ''),
                   u.city || ''].filter(Boolean).join(', ');
    if(addrEl) addrEl.textContent = address || '—';

    if(!lat || !lng || isNaN(lat) || isNaN(lng)){
      iframeEl.style.display   = 'none';
      if(noCrdEl) noCrdEl.style.display  = 'flex';
      if(linkEl)  linkEl.style.display   = 'none';
      if(coordEl) coordEl.textContent    = 'No coordinates';
      return;
    }

    var OFFSET = 0.005;
    var bbox = [
      (lng - OFFSET).toFixed(6),
      (lat - OFFSET * 0.7).toFixed(6),
      (lng + OFFSET).toFixed(6),
      (lat + OFFSET * 0.7).toFixed(6)
    ].join('%2C');
    iframeEl.src = 'https://www.openstreetmap.org/export/embed.html'
      + '?bbox=' + bbox + '&layer=mapnik'
      + '&marker=' + lat.toFixed(7) + '%2C' + lng.toFixed(7);
    iframeEl.style.display  = 'block';
    if(noCrdEl) noCrdEl.style.display  = 'none';
    if(coordEl) coordEl.textContent    = lat.toFixed(5) + '° N  /  ' + Math.abs(lng).toFixed(5) + '° W';
    if(linkEl){
      linkEl.href           = 'https://www.openstreetmap.org/?mlat=' + lat + '&mlon=' + lng + '&zoom=17';
      linkEl.style.display  = 'inline-block';
    }
  }

  function _ticField(label, value){
    var has = (value != null && value !== '' && value !== '—');
    return '<div class="tic-field"><div class="tic-field-lbl">' + _ticEsc(label) + '</div>'
         + '<div class="tic-field-val' + (has ? '' : ' tic-empty') + '">' + (has ? _ticEsc(value) : '—') + '</div></div>';
  }

  function _ticOverviewFieldByKey(key){
    for(var i=0;i<TIC_OVERVIEW_FIELDS.length;i++){
      if(TIC_OVERVIEW_FIELDS[i].key === key) return TIC_OVERVIEW_FIELDS[i];
    }
    return null;
  }
  function _ticOverviewSave(rowEl){
    var key   = rowEl.getAttribute('data-tic-ov-key');
    var field = _ticOverviewFieldByKey(key);
    if(!field || field.readOnly) return;
    var body  = {};
    var raw   = '';
    var inp   = null;
    if(field.type === 'multi'){
      var checks = rowEl.querySelectorAll('input[type="checkbox"][data-tic-vuln]');
      var picked = [];
      for(var i=0;i<checks.length;i++){ if(checks[i].checked) picked.push(checks[i].getAttribute('data-tic-vuln')); }
      body[key] = picked.length ? picked : null;
      inp = rowEl;
    } else {
      inp = rowEl.querySelector('[data-tic-ov-input]');
      if(!inp) return;
      raw = inp.value;
      if(field.type === 'array'){
        var arr = String(raw||'').split(',').map(function(s){return s.trim();}).filter(function(s){return s.length;});
        body[key] = arr.length ? arr : null;
      } else if(field.type === 'number'){
        body[key] = (raw === '' || raw == null) ? null : Number(raw);
      } else {
        body[key] = (raw === '') ? null : raw;
      }
    }
    // Skip no-op saves (typing then leaving unchanged)
    var prevRaw = _ticOverviewRowVal(field);
    if(field.type === 'array' || field.type === 'multi'){
      var prevArr = _ticIsArray(prevRaw) ? prevRaw : [];
      var newArr  = _ticIsArray(body[key]) ? body[key] : [];
      if(prevArr.slice().sort().join('|') === newArr.slice().sort().join('|')) return;
    } else {
      var prevNorm = (prevRaw == null) ? null : (field.type === 'number' ? Number(prevRaw) : String(prevRaw));
      var newNorm  = body[key];
      if(prevNorm === newNorm) return;
      if(prevNorm == null && newNorm == null) return;
    }
    inp.classList.add('tic-saving');
    var prevForAudit = prevRaw;

    var savePromise;
    if (field.saveTarget === 'unit') {
      // Save to housing_units instead of tenants
      var unitId = _ticState.unit && _ticState.unit.id;
      if (!unitId) {
        inp.classList.remove('tic-saving');
        if (typeof showToast === 'function') showToast('No unit record to save.', { type:'error' });
        return;
      }
      savePromise = _ticWrite('PATCH', 'housing_units?id=eq.' + encodeURIComponent(unitId), body)
        .then(function(rows){
          // Merge the CHANGED FIELDS onto the mapped unit — adopting the raw
          // PostgREST row (rows[0], snake_case + unflattened data jsonb) used
          // to replace the camelCase unit every other TIC read expects, so
          // rent/dates/amortization silently blanked until reopen.
          Object.assign(_ticState.unit, body);
          // Keep the in-memory housingUnits cache in sync so the unit card reflects changes immediately
          if (window.housingUnits) {
            var idx = window.housingUnits.findIndex(function(x){ return x.id === unitId; });
            if (idx !== -1) Object.assign(window.housingUnits[idx], body);
          }
        });
    } else {
      var pk = _ticState.tenant && _ticState.tenant[TIC_C.tenant_pk];
      if (!pk) {
        // Applicant with no tenant row yet — create one (status 'applicant',
        // linked by application_id), then this and future edits PATCH it.
        var t0 = _ticState.tenant || {};
        var insert = Object.assign({
          full_name:      t0[TIC_C.full_name] || '',
          status:         'applicant',
          application_id: t0[TIC_C.application_id] || null
        }, body);
        if (!insert.full_name) {
          inp.classList.remove('tic-saving');
          if (typeof showToast === 'function') showToast('No name on file to create a record.', { type:'error' });
          return;
        }
        savePromise = _ticWrite('POST', TIC_T.tenants, insert).then(function(rows){
          var saved = (rows && rows[0]) || insert;
          _ticState.tenant = saved;
          _ticRenderHero();
          _ticRenderStrip();
        });
      } else {
        savePromise = _ticWrite('PATCH', TIC_T.tenants + '?' + TIC_C.tenant_pk + '=eq.' + encodeURIComponent(pk), body)
          .then(function(rows){
            var saved = (rows && rows[0]) || Object.assign({}, _ticState.tenant, body);
            _ticState.tenant = saved;
            _ticRenderHero();
            _ticRenderStrip();
          });
      }
    }

    savePromise
      .then(function(){
        inp.classList.remove('tic-saving');
        var beforeStr = _ticIsArray(prevForAudit) ? prevForAudit.join(', ') : (prevForAudit == null ? '' : String(prevForAudit));
        var afterStr  = _ticIsArray(body[key]) ? body[key].join(', ') : (body[key] == null ? '' : String(body[key]));
        _ticAudit('tic_overview_change', _ticDescribe(field.label, beforeStr, afterStr));
        // No success toast here — the field's .tic-saving highlight clearing
        // is already the save confirmation; a toast per field is noisy when
        // editing several Overview fields in a row.
        if (key === TIC_C.tenancy_status && body[key] === 'banished') _ticSyncBanishedToBcr();
        if (key === TIC_C.tenancy_status && body[key] === 'harbouring') _ticPromptHarbouring();
        if (key === TIC_C.tenancy_status && body[key] === 'deceased') _ticSyncDeceasedToApplication();
      })
      .catch(function(err){
        inp.classList.remove('tic-saving');
        inp.classList.add('tic-input-error');
        if (typeof showToast === 'function') showToast('Save failed: ' + err.message, { type:'error' });
      });
  }

  // Keep the BCR (Band Council Resolution ineligibility) registry in sync when
  // staff mark a tenancy Banished here — the BCR list is what's actually
  // checked at application-approval / unit-assignment time, so a Tenancy
  // Status of "banished" with no matching BCR entry would silently NOT block
  // future housing of that person. Only opens the (HM/ED-gated) Add form —
  // never auto-writes a registry row with no date/reason on file.
  function _ticSyncBanishedToBcr(){
    var t = _ticState.tenant || {};
    var u = _ticState.unit   || {};
    var name = t[TIC_C.full_name] || u.assignedName || '';
    if (!name) return;
    if (typeof bcrLookup === 'function' && bcrLookup(name)) {
      // Already listed — reopen the manager only if their entry is missing
      // details (BCR date), so it can be completed.
      var _ex = bcrLookup(name);
      if (typeof bcrIsIncomplete === 'function' && bcrIsIncomplete(_ex)
          && typeof APPROVAL_AUTHORITY !== 'undefined' && APPROVAL_AUTHORITY.can('manageBcr', window.currentRole)
          && typeof openBcrManager === 'function') openBcrManager(name);
      return;
    }
    // Write the registry row IMMEDIATELY (marked details-pending) so the
    // eligibility block takes effect even if the details form is abandoned —
    // an unfinished form must never leave a banished person housable. The
    // stub surfaces in Reconcile ("BCR entries missing details") until a
    // BCR date is filled in.
    // Single source: shared-data.js's constant (housing-tic always loads after
    // shared-data) — a drifted literal here would write stubs bcrIsIncomplete
    // no longer recognizes.
    var _pending = window.BCR_PENDING_REASON;
    var _added = (typeof sbAddBcr === 'function')
      ? sbAddBcr(name, '', _pending, '').catch(function(e){ console.warn('[TIC] BCR stub write failed:', e); return null; })
      : Promise.resolve(null);
    _added.then(function(row){
      var canManage = !(typeof APPROVAL_AUTHORITY !== 'undefined' && !APPROVAL_AUTHORITY.can('manageBcr', window.currentRole));
      // The write FAILED (offline, RLS denial, …) — never claim the block is
      // in place when it isn't. Tell staff plainly and, when authorized, open
      // the manager so they can add the entry by hand.
      if (!row) {
        if (typeof showToast === 'function') showToast(
          'Could not add ' + name + ' to the BCR list — eligibility is NOT blocked yet. '
          + (canManage ? 'Add them in the form now, or retry from the BCR list later.'
                       : 'Ask a Housing Manager or ED to add them so eligibility checks pick it up.'),
          {type:'error'});
        if (canManage && typeof openBcrManager === 'function') openBcrManager(name);
        return;
      }
      if (!canManage) {
        if (typeof showToast === 'function') showToast(name + ' added to the BCR list (eligibility now blocked) — ask a Housing Manager or ED to complete the BCR date and reason.', {type:'info'});
        return;
      }
      if (typeof showToast === 'function') showToast(name + ' added to the BCR list — complete the BCR date and reason.', {type:'info'});
      if (typeof openBcrManager === 'function') openBcrManager(name);
    });
  }

  // Harbouring = housing/sheltering someone who is on the BCR list. The
  // status itself carries no automatic block; open the manager so staff can
  // record WHO is being harboured (their name goes on the list, not the
  // harbouring tenant's).
  function _ticPromptHarbouring(){
    if (typeof APPROVAL_AUTHORITY !== 'undefined' && !APPROVAL_AUTHORITY.can('manageBcr', window.currentRole)) {
      if (typeof showToast === 'function') showToast('Status saved. If the person being harboured is not on the BCR list yet, ask a Housing Manager or ED to add them.', {type:'info'});
      return;
    }
    if (typeof showToast === 'function') showToast('Record who is being harboured — add them to the BCR list if they are not on it yet.', {type:'info'});
    if (typeof openBcrManager === 'function') openBcrManager('');
  }

  // Flow a Tenancy Status of "deceased" onto the person's housing application
  // (the deceased flag zero-scores it, keeps it off Match, and blocks
  // assignment). One-way, like the Banished→BCR sync — clearing the status
  // does not un-flag the application; staff do that from the application form.
  function _ticSyncDeceasedToApplication(){
    try {
      var t = _ticState.tenant || {};
      var u = _ticState.unit   || {};
      var name  = t[TIC_C.full_name] || u.assignedName || '';
      var appId = t[TIC_C.application_id] || u.assignedTo || '';
      var today = new Date().toISOString().slice(0, 10);
      var role  = window.currentRole || 'staff';

      // In-memory first (pages that loaded applications[] at boot).
      var apps = (typeof applications !== 'undefined' && applications) ? applications : (window.applications || []);
      var app = null;
      if (appId) app = apps.find(function(a){ return a && a.id === appId; });
      if (!app && name) {
        var lc = name.trim().toLowerCase();
        app = apps.find(function(a){
          return a && !a.archived && (((a.fn || '') + ' ' + (a.ln || '')).trim().toLowerCase() === lc);
        });
      }
      if (app) {
        if (app.deceased) return;   // already flagged
        // Shared setter (shared-data.js): flag + date + save + audit + KPIs.
        if (typeof setAppDeceased === 'function') {
          setAppDeceased(app, { deceased: true, date: today, role: role,
            detail: 'Marked deceased from the Tenant Card (Tenancy Status)' });
        }
        if (typeof showToast === 'function') showToast('Application for ' + name + ' marked Deceased.', {type:'info'});
        return;
      }

      // Not in memory (e.g. tenants.html) — patch the application's data blob
      // by id. `deceased` rides the jsonb, so only that column is touched.
      if (!appId) {
        if (name && typeof showToast === 'function') showToast('No linked application found for ' + name + ' — if they have one on file, open it and tick Deceased there too.', {type:'info'});
        return;
      }
      _ticGet('housing_applications?id=eq.' + encodeURIComponent(appId) + '&select=id,data')
        .then(function(rows){
          if (!rows || rows._ticMissing || rows._ticError || !rows[0]) return;
          var d = rows[0].data || {};
          if (d.deceased) return;
          d.deceased = true;
          if (!d.deceasedDate) d.deceasedDate = today;
          return _ticWrite('PATCH', 'housing_applications?id=eq.' + encodeURIComponent(appId), { data: d })
            .then(function(){
              if (typeof auditEntry === 'function') auditEntry(appId, 'app_deceased_set', 'Marked deceased from the Tenant Card (Tenancy Status)', role);
              if (typeof showToast === 'function') showToast('Application' + (name ? ' for ' + name : '') + ' marked Deceased.', {type:'info'});
            });
        })
        .catch(function(e){ console.warn('[TIC] deceased -> application sync failed:', e); });
    } catch(e){ console.warn('[TIC] deceased sync:', e); }
  }

  function _ticToggleHomeCare(){
    if(_ticReadOnlyRole()){
      if(typeof showToast === 'function') showToast('Read-only access — editing tenant details is disabled for your role.', {type:'error'});
      return;
    }
    var t  = _ticState.tenant;
    var pk = t && t[TIC_C.tenant_pk];
    if (!pk) return;
    var newVal = !t[TIC_C.home_care];
    _ticWrite('PATCH', TIC_T.tenants + '?' + TIC_C.tenant_pk + '=eq.' + encodeURIComponent(pk), { home_care: newVal })
      .then(function(rows){
        _ticState.tenant = (rows && rows[0]) || Object.assign({}, t, { home_care: newVal });
        _ticRenderStrip();
        _ticAudit('tic_overview_change', (newVal ? 'Flagged' : 'Removed') + ' Home & Community Care');
        if (typeof showToast === 'function') showToast(newVal ? 'Flagged as Home & Community Care.' : 'H&CC flag removed.', {type:'info'});
      })
      .catch(function(err){
        if (typeof showToast === 'function') showToast('Save failed: ' + err.message, { type:'error' });
      });
  }
  window._ticToggleHomeCare = _ticToggleHomeCare;

  function _ticOnBodyChange(ev){
    var inp = ev.target;
    if(!inp || !inp.getAttribute) return;
    if(_ticReadOnlyRole()){
      if(typeof showToast === 'function') showToast('Read-only access — editing tenant details is disabled for your role.', {type:'error'});
      return;
    }
    // Income Type change → toggle Employer field visibility (no save fires).
    if(inp.id === 'tic_inc_type'){ _ticIncApplyDynamic(); return; }
    // Occupant income sources (form-field tic_hab_inc saves via hab-save, not here).
    var quickPerson = inp.getAttribute('data-tic-inc-quick');
    if(quickPerson){ _ticQuickIncomeSave(quickPerson, inp.value); return; }
    var habIncIdx = inp.getAttribute('data-tic-hab-inc');
    if(habIncIdx != null){ _ticHabIncomeSave(habIncIdx, inp.value); return; }
    var row = inp.closest && inp.closest('.tic-row');
    if(!row) return;
    if(inp.getAttribute('data-tic-ov-input')      === '1') { _ticOverviewSave(row);     return; }
    if(inp.getAttribute('data-tic-occ-input')     === '1') { _ticOccInlineSave(row);    return; }
    if(inp.getAttribute('data-tic-contact-input') === '1') { _ticContactInlineSave(row); return; }
  }

  // ── Audit log helper ─────────────────────────────────────────────────────
  // Wraps the existing auditEntry() in shared-data.js so every TIC mutation
  // lands in housing_audit_log + the in-memory auditLog[]. Falls back to the
  // tenant id when no application is linked.
  function _ticAudit(action, detail){
    if(typeof auditEntry !== 'function') return;
    var app = _ticState.application;
    var t   = _ticState.tenant;
    var entityId = (app && app.id) || (t && t[TIC_C.tenant_pk]) || 'TIC';
    var role = window.currentRole || 'staff';
    try { auditEntry(entityId, action, detail, role); } catch(e) {}
  }
  function _ticDescribe(label, before, after){
    var b = (before == null || before === '') ? '∅' : ('"' + String(before) + '"');
    var a = (after  == null || after  === '') ? '∅' : ('"' + String(after)  + '"');
    return label + ': ' + b + ' → ' + a;
  }

  // ── Income (employment) CRUD on app.incomes ──────────────────────────────
  // Income types where an employer field makes sense; for OW/ODSP/CPP/EI/etc.
  // the application form hides the Employer Details group.
  var TIC_INCOME_EMPLOYER_TYPES = ['Employed','Self-Employment'];

  // Records that came in through the applicant portal used its old friendly
  // type labels; normalize the unambiguous ones to the canonical staff values
  // so the OW/ODSP household-rent machinery recognizes them.
  var TIC_INCOME_TYPE_ALIASES = window.INCOME_TYPE_CANON || {
    'Employment': 'Employed', 'Self-employed': 'Self-Employment',
    'Employment Insurance': 'EI', 'Disability (ODSP)': 'ODSP',
    'Social Assistance': 'OW', 'Ontario Works': 'OW', 'Child Benefit': 'Other'
  };
  // Set a <select>'s value; if the stored value isn't among its options
  // (a portal person name, an unmapped type), inject it as a real option so
  // Edit shows the record's actual data instead of a silently blank select.
  function _ticSelectSet(el, val){
    if(!el) return;
    var v = String(val == null ? '' : val);
    el.value = v;
    if(v && el.value !== v){
      var o = document.createElement('option');
      o.value = v; o.textContent = v;
      el.appendChild(o); el.value = v;
    }
  }

  function _ticIncApplyDynamic(){
    var typeEl = _ticEl('tic_inc_type');
    var empRow = document.querySelector('#tic_inc_form .tic-inc-employer-row');
    if(!typeEl || !empRow) return;
    var t = typeEl.value;
    var showEmp = TIC_INCOME_EMPLOYER_TYPES.indexOf(t) >= 0;
    empRow.style.display = showEmp ? '' : 'none';
  }
  function _ticResetIncForm(){
    var f = _ticEl('tic_inc_form'); if(!f) return;
    f.removeAttribute('data-tic-inc-idx');
    f.setAttribute('data-tic-inc-mode','add');
    f.classList.remove('tic-open');
    ['tic_inc_person','tic_inc_type','tic_inc_employer','tic_inc_amount','tic_inc_period'].forEach(function(id){
      var el = _ticEl(id); if(el) el.value = '';
    });
    _ticIncApplyDynamic();
  }
  function _ticIncEditOpen(idx){
    var app = _ticState.application;
    var i = Number(idx);
    var r = (app && app.incomes && app.incomes[i]) || null;
    if(!r) return;
    var form = _ticEl('tic_inc_form');
    form.setAttribute('data-tic-inc-mode','edit');
    form.setAttribute('data-tic-inc-idx', String(i));
    var t = r.incomeType || '';
    if(TIC_INCOME_TYPE_ALIASES[t]) t = TIC_INCOME_TYPE_ALIASES[t];
    _ticSelectSet(_ticEl('tic_inc_person'), r.person || '');
    _ticSelectSet(_ticEl('tic_inc_type'), t);
    _ticEl('tic_inc_employer').value = r.employer   || '';
    _ticEl('tic_inc_amount').value   = (r.primaryAmt != null ? r.primaryAmt : '');
    _ticEl('tic_inc_period').value   = r.incomePeriod || '';
    form.classList.add('tic-open');
    _ticIncApplyDynamic();
  }
  function _ticSaveIncome(){
    var app = _ticState.application;
    if(!app){ if(typeof showToast === 'function') showToast('No linked application.', { type:'error' }); return; }
    var form   = _ticEl('tic_inc_form');
    var mode   = form.getAttribute('data-tic-inc-mode') || 'add';
    var person = (_ticEl('tic_inc_person').value||'').trim();
    var type   = (_ticEl('tic_inc_type').value||'').trim();
    if(!person || !type){
      if(typeof showToast === 'function') showToast('Person and income type are required.', { type:'error' });
      return;
    }
    var employer = (_ticEl('tic_inc_employer').value||'').trim();
    var hasEmp   = TIC_INCOME_EMPLOYER_TYPES.indexOf(type) >= 0;
    var amtRaw   = (_ticEl('tic_inc_amount').value||'').trim();
    var period   = (_ticEl('tic_inc_period').value||'').trim();
    var amt      = (amtRaw === '') ? null : Number(amtRaw);
    // Match the application form's persisted shape exactly: {person, incomeType,
    // employer, primaryAmt}. incomePeriod is round-tripped through the JSONB
    // since it doesn't conflict with the app's collection logic.
    var entry = {
      person:       person,
      incomeType:   type,
      employer:     hasEmp ? employer : '',
      primaryAmt:   amt
    };
    if(period) entry.incomePeriod = period;
    app.incomes  = _ticIsArray(app.incomes) ? app.incomes : [];
    var auditAction, auditDetail;
    if(mode === 'edit'){
      var i = Number(form.getAttribute('data-tic-inc-idx'));
      if(isNaN(i) || !app.incomes[i]) return;
      var prev = app.incomes[i];
      auditAction = 'tic_income_update';
      auditDetail = 'Updated income: ' + (prev.person||'?') + '/' + (prev.incomeType||'?') + ' → ' + person + '/' + type + (entry.employer ? ' @ ' + entry.employer : '');
      app.incomes[i] = entry;
    } else {
      auditAction = 'tic_income_add';
      auditDetail = 'Added income: ' + person + '/' + type + (entry.employer ? ' @ ' + entry.employer : '');
      app.incomes.push(entry);
    }
    _ticPersistApplication()
      .then(function(){
        _ticRenderOverview();
        _ticAudit(auditAction, auditDetail);
        if(typeof showToast === 'function') showToast(mode === 'edit' ? 'Income record updated.' : 'Income record added.', {type:'info'});
      })
      .catch(function(err){
        if(typeof showToast === 'function') showToast('Save failed: ' + err.message, { type:'error' });
      });
  }
  function _ticIncDelete(idx){
    var app = _ticState.application;
    var i = Number(idx);
    if(!app || isNaN(i) || !app.incomes || !app.incomes[i]) return;
    var r = app.incomes[i];
    if(!confirm('Delete income record for ' + (r.person||'?') + ' (' + (r.incomeType||'?') + ')?')) return;
    var detail = 'Removed income: ' + (r.person||'?') + '/' + (r.incomeType||'?') + (r.employer ? ' @ ' + r.employer : '');
    app.incomes.splice(i, 1);
    _ticPersistApplication()
      .then(function(){
        _ticRenderOverview();
        _ticAudit('tic_income_delete', detail);
        if(typeof showToast === 'function') showToast('Income record removed.', {type:'info'});
      })
      .catch(function(err){
        if(typeof showToast === 'function') showToast('Delete failed: ' + err.message, { type:'error' });
      });
  }

  // ── Application-side persistence helper ──────────────────────────────────
  // Mutates _ticState.application in place, then round-trips via the existing
  // sbSaveApplication so the housing_applications row stays the source of truth.
  // Also mirrors the change into the in-memory `applications` cache so other
  // pages see it without a reload.
  function _ticPersistApplication(){
    var app = _ticState.application;
    if(!app || !app.id){
      return Promise.reject(new Error('No application linked to this tenant.'));
    }
    if(typeof saveApplicationWithDraftFallback !== 'function' && typeof sbSaveApplication !== 'function'){
      return Promise.reject(new Error('Application save helper is not available on this page.'));
    }
    var _save = (typeof saveApplicationWithDraftFallback === 'function')
      ? saveApplicationWithDraftFallback(app)
      : sbSaveApplication(app);
    return Promise.resolve(_save).then(function(ok){
      // saveApplicationWithDraftFallback resolves true (synced) or false
      // (queued locally — will sync later). Either way the local draft is
      // safe, so we treat both as success here. The legacy sbSaveApplication
      // path resolves true or throws; the throw is handled by .catch below.
      if(ok === false){
        if(typeof showToast === 'function') showToast('Saved locally — will sync when network is available.', { type:'info', duration:3500 });
      }
      var arr = (typeof applications !== 'undefined' && applications) || null;
      if(arr && arr.length){
        for(var i=0;i<arr.length;i++){
          if(arr[i] && arr[i].id === app.id){ arr[i] = app; break; }
        }
      }
      return app;
    });
  }
  function _ticAppFullName(p){
    if(!p) return '';
    var n = ((p.fn||'') + ' ' + (p.ln||'')).trim();
    return n || (p.full_name || '');
  }

  // ── Render: Occupants (from app.coApp + app.habitants) ────────────────────
  function _ticRenderOccupants(){
    var app = _ticState.application;
    var html = '';

    if(!app){
      html = '<div class="tic-pending-inline">No linked application — household members are sourced from the application form.</div>';
      _ticEl('tic_panel_occupants').innerHTML = html;
      return;
    }

    // Household OW/ODSP shelter-rent card — recipients + calculated total.
    html += _ticHouseholdRentCardHtml();

    // Primary applicant — income source quick-set (writes into app.incomes so
    // the Employment & Income section on Overview stays the single record).
    html += '<div class="tic-section">';
    html +=   '<div class="tic-section-h">Primary Applicant</div>';
    html +=   '<div class="tic-row tic-row-edit">'
         +     '<div class="tic-row-lbl">' + _ticEsc(((app.fn||'') + ' ' + (app.ln||'')).trim() || 'Applicant') + ' — Income Source</div>'
         +     '<div class="tic-row-val">' + _ticIncomeSelectHtml('data-tic-inc-quick="Applicant"', _ticPersonIncomeType('Applicant')) + '</div>'
         +   '</div>';
    html += '</div>';

    // Co-applicant block
    html += '<div class="tic-section tic-section-spaced">';
    html +=   '<div class="tic-section-h">Co-Applicant</div>';
    var hasCo = !!app.hasCoApp;
    html +=   '<div class="tic-row tic-row-edit" data-tic-occ-key="hasCoApp">'
         +     '<div class="tic-row-lbl">Has Co-Applicant</div>'
         +     '<div class="tic-row-val">'
         +       '<select class="tic-input" data-tic-occ-input="1">'
         +         '<option value="no"' + (hasCo ? '' : ' selected') + '>No</option>'
         +         '<option value="yes"' + (hasCo ? ' selected' : '') + '>Yes</option>'
         +       '</select>'
         +     '</div>'
         +   '</div>';
    if(hasCo){
      var co = app.coApp || {};
      html +=   _ticOccCoRow('First Name',     'fn',      co.fn)
            +   _ticOccCoRow('Last Name',      'ln',      co.ln)
            +   _ticOccCoRow('Date of Birth',  'dob',     co.dob,     'date')
            +   _ticOccCoRow('Band Number',    'band',    co.band)
            +   _ticOccCoRow('Cell Phone',     'cell',    co.cell,    'tel')
            +   _ticOccCoRow('Email',          'email',   co.email,   'email');
      html +=   '<div class="tic-row tic-row-edit">'
           +     '<div class="tic-row-lbl">Income Source</div>'
           +     '<div class="tic-row-val">' + _ticIncomeSelectHtml('data-tic-inc-quick="Co-Applicant"', _ticPersonIncomeType('Co-Applicant')) + '</div>'
           +   '</div>';
    }
    html += '</div>';

    // Habitants
    html += '<div class="tic-section tic-section-spaced">';
    html +=   '<div class="tic-section-h">Other Household Members</div>';
    var hab = _ticIsArray(app.habitants) ? app.habitants : [];
    var realHab = hab.filter(function(h){ return h && (h.fn || h.ln); });
    if(!realHab.length){
      html += '<div class="tic-empty">No additional household members on the application.</div>';
    } else {
      html += '<table class="tic-table"><thead><tr>'
           + '<th>Name</th><th>Relationship</th><th>DOB</th><th>Age</th><th>Income (18+)</th><th></th>'
           + '</tr></thead><tbody>';
      hab.forEach(function(h, idx){
        if(!h || (!h.fn && !h.ln)) return;
        // Income source only for adults — 18+ by DOB, or DOB unknown (staff
        // can still record it; the rent calc only counts confirmed adults or
        // members explicitly marked with a source).
        var ageN = _ticAgeNum(h.dob);
        var showInc = (ageN == null) || ageN >= 18;
        html += '<tr data-tic-hab-idx="' + idx + '">'
             +   '<td>' + _ticEsc(_ticAppFullName(h) || '—') + '</td>'
             +   '<td>' + _ticEsc(h.relationship || '—') + '</td>'
             +   '<td>' + _ticEsc(_ticFmtDate(h.dob)) + '</td>'
             +   '<td>' + _ticEsc(_ticAge(h.dob)) + '</td>'
             +   '<td>' + (showInc ? _ticIncomeSelectHtml('data-tic-hab-inc="' + idx + '"', h.incomeSource || '') : '<span style="color:var(--muted);">—</span>') + '</td>'
             +   '<td class="tic-row-actions">'
             +     '<button type="button" class="btn btn-ghost" data-tic-action="hab-edit">Edit</button>'
             +     '<button type="button" class="btn btn-ghost" data-tic-action="hab-delete">Delete</button>'
             +   '</td>'
             + '</tr>';
      });
      html += '</tbody></table>';
    }
    html += '<div class="tic-form-actions"><button type="button" class="btn btn-primary" data-tic-action="hab-add">+ Add Household Member</button></div>';
    html += '<div id="tic_hab_form" class="tic-add-form" data-tic-hab-mode="add">'
         +   '<div class="tic-grid-2">'
         +     '<div class="tic-field"><label class="tic-field-lbl">First Name *</label><input class="tic-input" id="tic_hab_fn" type="text"/></div>'
         +     '<div class="tic-field"><label class="tic-field-lbl">Last Name *</label><input class="tic-input" id="tic_hab_ln" type="text"/></div>'
         +     '<div class="tic-field"><label class="tic-field-lbl">Date of Birth</label><input class="tic-input" id="tic_hab_dob" type="date"/></div>'
         +     '<div class="tic-field"><label class="tic-field-lbl">Relationship</label><select class="tic-input" id="tic_hab_rel"><option value="">Select</option><option>Spouse</option><option>Child</option><option>Parent</option><option>Sibling</option><option>Other</option></select></div>'
         +     '<div class="tic-field"><label class="tic-field-lbl">Income Source (18+)</label>' + _ticIncomeSelectHtml('id="tic_hab_inc"', '') + '</div>'
         +   '</div>'
         +   '<div class="tic-form-actions">'
         +     '<button type="button" class="btn btn-ghost"   data-tic-action="hab-cancel">Cancel</button>'
         +     '<button type="button" class="btn btn-primary" data-tic-action="hab-save">Save</button>'
         +   '</div>'
         + '</div>';
    html += '</div>';

    _ticEl('tic_panel_occupants').innerHTML = html;
  }
  function _ticOccCoRow(label, key, val, type){
    var t = type || 'text';
    var v = (val == null) ? '' : String(val);
    if(t === 'date' && v) v = v.slice(0,10);
    return '<div class="tic-row tic-row-edit" data-tic-occ-key="coApp.' + _ticEsc(key) + '">'
         +   '<div class="tic-row-lbl">' + _ticEsc(label) + '</div>'
         +   '<div class="tic-row-val"><input class="tic-input" type="' + t + '" data-tic-occ-input="1" value="' + _ticEsc(v) + '"/></div>'
         + '</div>';
  }
  // ── Occupant income sources + household OW/ODSP shelter rent ─────────────
  // Adults (18+) have an Income Source recorded on the Occupants tab. The
  // primary applicant / co-applicant quick-selects read+write app.incomes
  // (same records as Overview's Employment & Income); other household members
  // store incomeSource on their habitants[] entry. When any adult is on
  // OW/ODSP, the household's calculated rent is computeHouseholdShelterRent
  // (shared-config.js — split model) and can be applied as the monthly rent.
  function _ticIncomeSelectHtml(attr, val){
    var opts = '<option value="">—</option>';
    TIC_INCOME_TYPES.forEach(function(t){
      opts += '<option value="' + _ticEsc(t) + '"' + (val === t ? ' selected' : '') + '>' + _ticEsc(t) + '</option>';
    });
    return '<select class="tic-input" ' + attr + '>' + opts + '</select>';
  }
  // First income row's type for a person ('Applicant'/'Co-Applicant') — an
  // OW/ODSP row wins so the select surfaces the benefit status.
  // Canonicalize a stored income type through the portal-label alias map so
  // legacy portal records ('Ontario Works', 'Disability (ODSP)', …) read as
  // OW/ODSP here the same way they do in the edit form.
  function _ticCanonIncomeType(t){
    t = t || '';
    return TIC_INCOME_TYPE_ALIASES[t] || t;
  }
  function _ticPersonIncomeType(person){
    var app = _ticState.application;
    var rows = _ticIsArray(app && app.incomes) ? app.incomes : [];
    var first = '';
    for(var i = 0; i < rows.length; i++){
      var r = rows[i];
      if(!r || r.person !== person) continue;
      var t = _ticCanonIncomeType(r.incomeType);
      if(t === 'OW' || t === 'ODSP') return t;
      if(!first && t) first = t;
    }
    return first;
  }
  function _ticPersonProgram(person){
    var t = _ticPersonIncomeType(person);
    return (t === 'OW' || t === 'ODSP') ? t : '';
  }
  // One entry per person living in the house, for computeHouseholdShelterRent.
  function _ticHouseholdMembers(){
    var app = _ticState.application;
    if(!app) return [];
    var members = [];
    members.push({ name: ((app.fn||'') + ' ' + (app.ln||'')).trim() || 'Applicant', adult: true, program: _ticPersonProgram('Applicant') });
    if(app.hasCoApp){
      var co = app.coApp || {};
      members.push({ name: ((co.fn||'') + ' ' + (co.ln||'')).trim() || 'Co-Applicant', adult: true, program: _ticPersonProgram('Co-Applicant') });
    }
    var hab = _ticIsArray(app.habitants) ? app.habitants : [];
    hab.forEach(function(h){
      if(!h || (!h.fn && !h.ln)) return;
      var ageN = _ticAgeNum(h.dob);
      var t = _ticCanonIncomeType(h.incomeSource);
      // Adult when DOB confirms 18+, or DOB unknown but an income source was
      // recorded (staff marked them as an income-earning adult).
      var adult = (ageN != null) ? ageN >= 18 : !!t;
      members.push({ name: _ticAppFullName(h), adult: adult, program: (t === 'OW' || t === 'ODSP') ? t : '' });
    });
    return members;
  }
  function _ticCurrentRentAmount(){
    var l = _ticState.ledger || {};
    var u = _ticState.unit || {};
    if(l[TIC_C.monthly_rent] != null) return Number(l[TIC_C.monthly_rent]);
    if(u.monthlyRent  != null) return Number(u.monthlyRent);
    if(u.monthly_rent != null) return Number(u.monthly_rent);
    return null;
  }
  function _ticHouseholdRentCardHtml(){
    if(typeof computeHouseholdShelterRent !== 'function') return '';
    var calc = computeHouseholdShelterRent(_ticHouseholdMembers());
    var html = '<div class="tic-section">';
    html += '<div class="tic-section-h">Household Rent Calculation</div>';
    if(!calc.hasRecipients){
      html += '<div class="tic-empty">No household members on OW/ODSP — the standard market-rent calculation applies. Record income sources below for adults (18+).</div>';
      return html + '</div>';
    }
    var cur = _ticCurrentRentAmount();
    var money = function(v){ return '$' + Number(v).toLocaleString('en-CA', {minimumFractionDigits:2, maximumFractionDigits:2}); };
    html += '<table class="tic-table"><thead><tr><th>Recipient</th><th>Program</th><th>Benefit Unit</th><th>Shelter Allowance</th></tr></thead><tbody>';
    calc.lines.forEach(function(ln){
      html += '<tr><td>' + _ticEsc(ln.name || '—') + '</td><td>' + _ticEsc(ln.program) + '</td>'
           +  '<td>' + ln.size + (ln.size === 1 ? ' person' : ' people') + '</td>'
           +  '<td>' + money(ln.amount) + '/mo</td></tr>';
    });
    html += '</tbody></table>';
    html += '<div class="tic-row"><div class="tic-row-lbl">Calculated Monthly Rent (' + calc.householdSize + ' in household)</div>'
         +  '<div class="tic-row-val" style="font-weight:800;">' + money(calc.total) + '/month</div></div>';
    if(cur != null){
      html += '<div class="tic-row"><div class="tic-row-lbl">Current Monthly Rent</div><div class="tic-row-val">' + money(cur) + '/month</div></div>';
    } else {
      html += '<div class="tic-pending-inline">No monthly rent is set yet — the calculated shelter amount is the default.</div>';
    }
    var canSet = !_ticReadOnlyRole()
      && (typeof APPROVAL_AUTHORITY === 'undefined' || APPROVAL_AUTHORITY.can('assignRentAmount', window.currentRole));
    if(canSet && cur !== calc.total){
      html += '<div class="tic-form-actions"><button type="button" class="btn btn-primary" data-tic-action="occ-apply-shelter-rent">Set ' + money(calc.total) + ' as Monthly Rent</button></div>';
    }
    return html + '</div>';
  }
  async function _ticApplyShelterRent(){
    if(_ticReadOnlyRole()) return;
    if(typeof APPROVAL_AUTHORITY !== 'undefined' && !APPROVAL_AUTHORITY.can('assignRentAmount', window.currentRole)){
      if(typeof showToast === 'function') showToast('You are not authorized to set the rent amount.', {type:'error'});
      return;
    }
    var calc = computeHouseholdShelterRent(_ticHouseholdMembers());
    if(!calc.hasRecipients) return;
    var total = calc.total;
    var go = (typeof showConfirm === 'function')
      ? await showConfirm({ title:'Set monthly rent?',
          message:'Set the monthly rent to $' + total.toFixed(2) + ' — the calculated OW/ODSP shelter allowance for this household (' + calc.lines.length + ' recipient' + (calc.lines.length===1?'':'s') + ', ' + calc.householdSize + ' in household)?',
          confirmText:'Set Rent', cancelText:'Cancel' })
      : window.confirm('Set monthly rent to $' + total.toFixed(2) + '?');
    if(!go) return;
    try {
      var u = _ticState.unit;
      if(u && u.id){
        u.monthlyRent = total;
        if(window.housingUnits){
          var i = window.housingUnits.findIndex(function(x){ return x.id === u.id; });
          if(i !== -1) window.housingUnits[i].monthlyRent = total;
        }
        if(typeof saveUnitWithDraftFallback === 'function') saveUnitWithDraftFallback(u);
        else if(typeof sbSaveUnit === 'function') await sbSaveUnit(u);
      }
      // Mirror onto the rent ledger row when one exists (it wins the display).
      var l = _ticState.ledger;
      if(l && l.id){
        await _ticWrite('PATCH', TIC_T.rent_ledger + '?id=eq.' + encodeURIComponent(l.id), { monthly_rent: total });
        _ticState.ledger[TIC_C.monthly_rent] = total;
      }
      _ticAudit('tic_rent_set_shelter', 'Monthly rent set to $' + total.toFixed(2) + ' from the OW/ODSP shelter-allowance calculation (' + calc.lines.length + ' recipient(s), household of ' + calc.householdSize + ')');
      if(typeof showToast === 'function') showToast('Monthly rent set to $' + total.toFixed(2) + '.', {type:'info'});
      _ticRenderOccupants(); _ticRenderOverview(); _ticRenderStrip();
    } catch(err){
      if(typeof showToast === 'function') showToast('Rent save failed: ' + err.message, {type:'error'});
    }
  }
  // Quick-set for the Applicant / Co-Applicant income source — upserts into
  // app.incomes (updates the person's existing row, preserving employer and
  // amount; creates one when they have none).
  function _ticQuickIncomeSave(person, type){
    var app = _ticState.application;
    if(!app) return;
    app.incomes = _ticIsArray(app.incomes) ? app.incomes : [];
    var row = null;
    for(var i = 0; i < app.incomes.length; i++){
      var r = app.incomes[i];
      if(r && r.person === person){
        if(r.incomeType === 'OW' || r.incomeType === 'ODSP'){ row = r; break; }
        if(!row) row = r;
      }
    }
    var prev = row ? row.incomeType : '';
    if(row) row.incomeType = type || '';
    else if(type) app.incomes.push({ person: person, incomeType: type, employer: '', primaryAmt: null });
    _ticPersistApplication()
      .then(function(){
        _ticAudit('tic_income_update', _ticDescribe(person + ' income source', prev, type));
        _ticRenderOccupants();
      })
      .catch(function(err){
        if(typeof showToast === 'function') showToast('Save failed: ' + err.message, {type:'error'});
      });
  }
  function _ticHabIncomeSave(idx, type){
    var app = _ticState.application;
    var i = Number(idx);
    if(!app || isNaN(i) || !app.habitants || !app.habitants[i]) return;
    var h = app.habitants[i];
    var prev = h.incomeSource || '';
    h.incomeSource = type || '';
    _ticPersistApplication()
      .then(function(){
        _ticAudit('tic_habitant_update', _ticDescribe((_ticAppFullName(h) || 'household member') + ' income source', prev, type));
        _ticRenderOccupants();
      })
      .catch(function(err){
        if(typeof showToast === 'function') showToast('Save failed: ' + err.message, {type:'error'});
      });
  }

  // Save handler for inline-edit rows on the Occupants tab. Triggered by the
  // body-level change listener; key looks like "hasCoApp" or "coApp.fn".
  function _ticOccInlineSave(rowEl){
    var app = _ticState.application;
    if(!app) return;
    var key = rowEl.getAttribute('data-tic-occ-key');
    var inp = rowEl.querySelector('[data-tic-occ-input]');
    if(!key || !inp) return;
    var v   = inp.value;
    var auditDetail = '';
    if(key === 'hasCoApp'){
      var prevHas = !!app.hasCoApp;
      app.hasCoApp = (v === 'yes');
      if(app.hasCoApp && !app.coApp) app.coApp = {};
      if(!app.hasCoApp) app.coApp = null;
      auditDetail = _ticDescribe('hasCoApp', prevHas ? 'yes' : 'no', app.hasCoApp ? 'yes' : 'no');
    } else if(key.indexOf('coApp.') === 0){
      var prop = key.slice(6);
      app.coApp = app.coApp || {};
      var prevVal = app.coApp[prop];
      app.coApp[prop] = v || null;
      auditDetail = _ticDescribe('coApp.' + prop, prevVal, app.coApp[prop]);
    } else { return; }
    inp.classList.add('tic-saving');
    _ticPersistApplication()
      .then(function(){
        inp.classList.remove('tic-saving');
        _ticRenderHero(); _ticRenderStrip(); _ticRenderOccupants();
        _ticAudit('tic_coapp_change', auditDetail);
      })
      .catch(function(err){
        inp.classList.remove('tic-saving');
        inp.classList.add('tic-input-error');
        if(typeof showToast === 'function') showToast('Save failed: ' + err.message, { type:'error' });
      });
  }
  function _ticHabFindIdx(idx){ return Number(idx); }
  function _ticHabEditOpen(idx){
    var app = _ticState.application;
    var i = _ticHabFindIdx(idx);
    var h = (app && app.habitants && app.habitants[i]) || null;
    if(!h) return;
    var form = _ticEl('tic_hab_form');
    form.setAttribute('data-tic-hab-mode','edit');
    form.setAttribute('data-tic-hab-idx', String(i));
    _ticEl('tic_hab_fn').value  = h.fn  || '';
    _ticEl('tic_hab_ln').value  = h.ln  || '';
    _ticEl('tic_hab_dob').value = h.dob ? String(h.dob).slice(0,10) : '';
    _ticEl('tic_hab_rel').value = h.relationship || '';
    var incEl = _ticEl('tic_hab_inc'); if(incEl) incEl.value = h.incomeSource || '';
    form.classList.add('tic-open');
  }
  function _ticResetHabForm(){
    var f = _ticEl('tic_hab_form'); if(!f) return;
    f.removeAttribute('data-tic-hab-idx');
    f.setAttribute('data-tic-hab-mode','add');
    f.classList.remove('tic-open');
    ['tic_hab_fn','tic_hab_ln','tic_hab_dob','tic_hab_rel','tic_hab_inc'].forEach(function(id){
      var el = _ticEl(id); if(el) el.value='';
    });
  }
  function _ticSaveHabitant(){
    var app = _ticState.application;
    if(!app){ if(typeof showToast === 'function') showToast('No linked application.', { type:'error' }); return; }
    var form = _ticEl('tic_hab_form');
    var mode = form.getAttribute('data-tic-hab-mode') || 'add';
    var fn = (_ticEl('tic_hab_fn').value||'').trim();
    var ln = (_ticEl('tic_hab_ln').value||'').trim();
    if(!fn || !ln){
      if(typeof showToast === 'function') showToast('First and last name are required.', { type:'error' });
      return;
    }
    var entry = {
      fn:           fn,
      ln:           ln,
      dob:          (_ticEl('tic_hab_dob').value||'').trim() || '',
      relationship: (_ticEl('tic_hab_rel').value||'').trim() || '',
      incomeSource: ((_ticEl('tic_hab_inc')||{}).value||'').trim() || ''
    };
    app.habitants = _ticIsArray(app.habitants) ? app.habitants : [];
    var auditAction, auditDetail;
    if(mode === 'edit'){
      var idx = Number(form.getAttribute('data-tic-hab-idx'));
      if(isNaN(idx) || !app.habitants[idx]) return;
      var prev = app.habitants[idx];
      auditAction = 'tic_habitant_update';
      auditDetail = 'Updated household member: ' + (_ticAppFullName(prev) || '?') + ' → ' + _ticAppFullName(entry) + ' (' + (entry.relationship||'—') + ')';
      app.habitants[idx] = entry;
    } else {
      auditAction = 'tic_habitant_add';
      auditDetail = 'Added household member: ' + _ticAppFullName(entry) + ' (' + (entry.relationship||'—') + ')';
      app.habitants.push(entry);
    }
    _ticPersistApplication()
      .then(function(){
        _ticRenderOccupants();
        _ticAudit(auditAction, auditDetail);
        if(typeof showToast === 'function') showToast(mode === 'edit' ? 'Household member updated.' : 'Household member added.', {type:'info'});
      })
      .catch(function(err){
        if(typeof showToast === 'function') showToast('Save failed: ' + err.message, { type:'error' });
      });
  }
  function _ticHabDelete(idx){
    var app = _ticState.application;
    var i = Number(idx);
    if(!app || isNaN(i) || !app.habitants || !app.habitants[i]) return;
    var h = app.habitants[i];
    if(!confirm('Remove "' + (_ticAppFullName(h) || 'this household member') + '" from the application?')) return;
    var detail = 'Removed household member: ' + (_ticAppFullName(h) || '?') + ' (' + (h.relationship||'—') + ')';
    app.habitants.splice(i, 1);
    _ticPersistApplication()
      .then(function(){
        _ticRenderOccupants();
        _ticAudit('tic_habitant_delete', detail);
        if(typeof showToast === 'function') showToast('Household member removed.', {type:'info'});
      })
      .catch(function(err){
        if(typeof showToast === 'function') showToast('Delete failed: ' + err.message, { type:'error' });
      });
  }

  // ── Render: Contact (from application primary applicant) ─────────────────
  function _ticRenderContact(){
    var app = _ticState.application;
    if(!app){
      _ticEl('tic_panel_contact').innerHTML =
        '<div class="tic-pending-inline">No linked application — contact info is sourced from the application form.</div>';
      return;
    }
    var rows = [
      { key:'phone',    label:'Phone',           type:'tel'   },
      { key:'email',    label:'Email',           type:'email' },
      { key:'street',   label:'Street Address',  type:'text'  },
      { key:'city',     label:'City',            type:'text'  },
      { key:'province', label:'Province',        type:'text'  },
      { key:'postal',   label:'Postal Code',     type:'text'  }
    ];
    var html = '<div class="tic-section"><div class="tic-section-h">Contact Information</div><div class="tic-rows">';
    rows.forEach(function(r){
      var v = (app[r.key] == null) ? '' : String(app[r.key]);
      html += '<div class="tic-row tic-row-edit" data-tic-contact-key="' + _ticEsc(r.key) + '" data-tic-input-type="' + r.type + '">'
           +   '<div class="tic-row-lbl">' + _ticEsc(r.label) + '</div>'
           +   '<div class="tic-row-val"><input class="tic-input" type="' + r.type + '" data-tic-contact-input="1" value="' + _ticEsc(v) + '"/></div>'
           + '</div>';
    });
    html += '</div></div>';
    _ticEl('tic_panel_contact').innerHTML = html;
  }
  function _ticContactInlineSave(rowEl){
    var app = _ticState.application;
    if(!app) return;
    var key  = rowEl.getAttribute('data-tic-contact-key');
    var type = rowEl.getAttribute('data-tic-input-type') || 'text';
    var inp  = rowEl.querySelector('[data-tic-contact-input]');
    if(!key || !inp) return;
    var v = (inp.value||'').trim();
    inp.classList.remove('tic-input-error');
    if(type === 'tel'   && v && !TIC_PHONE_RE.test(v)){ inp.classList.add('tic-input-error'); if(typeof showToast === 'function') showToast('Phone format is invalid.', { type:'error' }); return; }
    if(type === 'email' && v && !TIC_EMAIL_RE.test(v)){ inp.classList.add('tic-input-error'); if(typeof showToast === 'function') showToast('Email format is invalid.', { type:'error' }); return; }
    if(String(app[key] || '') === v) return;
    var prev = app[key];
    app[key] = v || null;
    inp.classList.add('tic-saving');
    _ticPersistApplication()
      .then(function(){
        inp.classList.remove('tic-saving');
        _ticAudit('tic_contact_change', _ticDescribe(key, prev, app[key]));
      })
      .catch(function(err){
        inp.classList.remove('tic-saving');
        inp.classList.add('tic-input-error');
        if(typeof showToast === 'function') showToast('Save failed: ' + err.message, { type:'error' });
      });
  }

  // ── Render: Emergency Contacts (sourced from app.references) ─────────────
  // The application form's "References" step is now relabelled as Emergency
  // Contacts. The TIC mirrors that: this tab reads/writes app.references[]
  // with full CRUD. Form ids and ref-* action prefixes remain internal so the
  // existing handlers work unchanged.
  function _ticRenderEmergency(){
    var app = _ticState.application;
    if(!app){
      _ticEl('tic_panel_emergency').innerHTML =
        '<div class="tic-pending-inline">No linked application — emergency contacts are sourced from the application form.</div>';
      return;
    }
    var refs = _ticAppReferences();
    var realRefs = refs.filter(function(r){ return r && (r.fn || r.ln || r.phone || r.email); });
    var html = '<div class="tic-section"><div class="tic-section-h">Emergency Contacts</div>';
    if(!realRefs.length){
      html += '<div class="tic-empty">No emergency contacts on the application.</div>';
    } else {
      html += '<table class="tic-table"><thead><tr>'
           + '<th>Name</th><th>Relationship</th><th>Phone</th><th>Email</th><th></th>'
           + '</tr></thead><tbody>';
      refs.forEach(function(r, idx){
        if(!r || (!r.fn && !r.ln && !r.phone && !r.email)) return;
        html += '<tr data-tic-ref-idx="' + idx + '">'
             +   '<td>' + _ticEsc(_ticAppFullName(r) || '—') + '</td>'
             +   '<td>' + _ticEsc(r.relationship || '—') + '</td>'
             +   '<td>' + _ticEsc(r.phone ? formatPhone(r.phone) : '—') + '</td>'
             +   '<td>' + _ticEsc(r.email || '—') + '</td>'
             +   '<td class="tic-row-actions">'
             +     '<button type="button" class="btn btn-ghost" data-tic-action="ref-edit">Edit</button>'
             +     '<button type="button" class="btn btn-ghost" data-tic-action="ref-delete">Delete</button>'
             +   '</td>'
             + '</tr>';
      });
      html += '</tbody></table>';
    }
    html += '<div class="tic-form-actions"><button type="button" class="btn btn-primary" data-tic-action="ref-add">+ Add Emergency Contact</button></div>';
    html += '<div id="tic_ref_form" class="tic-add-form" data-tic-ref-mode="add">'
         +   '<div class="tic-grid-2">'
         +     '<div class="tic-field"><label class="tic-field-lbl">First Name *</label><input class="tic-input" id="tic_ref_fn" type="text"/></div>'
         +     '<div class="tic-field"><label class="tic-field-lbl">Last Name</label><input class="tic-input" id="tic_ref_ln" type="text"/></div>'
         +     '<div class="tic-field"><label class="tic-field-lbl">Relationship</label><input class="tic-input" id="tic_ref_rel" type="text"/></div>'
         +     '<div class="tic-field"><label class="tic-field-lbl">Phone</label><input class="tic-input" id="tic_ref_phone" type="tel" placeholder="(705)-000-0000" oninput="fmtPhone(this)"/></div>'
         +     '<div class="tic-field"><label class="tic-field-lbl">Email</label><input class="tic-input" id="tic_ref_email" type="email"/></div>'
         +   '</div>'
         +   '<div class="tic-form-actions">'
         +     '<button type="button" class="btn btn-ghost"   data-tic-action="ref-cancel">Cancel</button>'
         +     '<button type="button" class="btn btn-primary" data-tic-action="ref-save">Save</button>'
         +   '</div>'
         + '</div>';
    html += '</div>';
    _ticEl('tic_panel_emergency').innerHTML = html;
  }

  // ── Render: References (from app.references) ─────────────────────────────
  function _ticAppReferences(){
    var a = _ticState.application;
    if(!a || !_ticIsArray(a.references)) return [];
    return a.references;
  }
  // Old References tab was consolidated into Emergency Contacts. The function
  // is kept as an alias so existing save-handler refresh calls continue to work.
  function _ticRenderReferences(){ _ticRenderEmergency(); }
  function _ticResetRefForm(){
    var f = _ticEl('tic_ref_form'); if(!f) return;
    f.removeAttribute('data-tic-ref-idx');
    f.setAttribute('data-tic-ref-mode','add');
    f.classList.remove('tic-open');
    ['tic_ref_fn','tic_ref_ln','tic_ref_rel','tic_ref_phone','tic_ref_email'].forEach(function(id){
      var el = _ticEl(id); if(el) el.value='';
    });
  }
  function _ticRefEditOpen(idx){
    var i = Number(idx);
    var r = _ticAppReferences()[i];
    if(!r) return;
    var form = _ticEl('tic_ref_form');
    form.setAttribute('data-tic-ref-mode','edit');
    form.setAttribute('data-tic-ref-idx', String(i));
    _ticEl('tic_ref_fn').value    = r.fn    || '';
    _ticEl('tic_ref_ln').value    = r.ln    || '';
    _ticEl('tic_ref_rel').value   = r.relationship || '';
    _ticEl('tic_ref_phone').value = r.phone ? formatPhone(r.phone) : '';
    _ticEl('tic_ref_email').value = r.email || '';
    form.classList.add('tic-open');
  }
  function _ticSaveReference(){
    var app = _ticState.application;
    if(!app){ if(typeof showToast === 'function') showToast('No linked application.', { type:'error' }); return; }
    var form = _ticEl('tic_ref_form');
    var mode = form.getAttribute('data-tic-ref-mode') || 'add';
    var fn = (_ticEl('tic_ref_fn').value||'').trim();
    if(!fn){ if(typeof showToast === 'function') showToast('Emergency contact first name is required.', { type:'error' }); return; }
    var phone = (_ticEl('tic_ref_phone').value||'').trim();
    var email = (_ticEl('tic_ref_email').value||'').trim();
    if(phone && !TIC_PHONE_RE.test(phone)){ if(typeof showToast === 'function') showToast('Phone format is invalid.', { type:'error' }); return; }
    if(email && !TIC_EMAIL_RE.test(email)){ if(typeof showToast === 'function') showToast('Email format is invalid.', { type:'error' }); return; }
    var entry = {
      fn:           fn,
      ln:           (_ticEl('tic_ref_ln').value||'').trim(),
      relationship: (_ticEl('tic_ref_rel').value||'').trim(),
      phone:        phone,
      email:        email
    };
    app.references = _ticIsArray(app.references) ? app.references : [];
    var auditAction, auditDetail;
    if(mode === 'edit'){
      var i = Number(form.getAttribute('data-tic-ref-idx'));
      if(isNaN(i) || !app.references[i]) return;
      var prev = app.references[i];
      auditAction = 'tic_reference_update';
      auditDetail = 'Updated emergency contact: ' + (_ticAppFullName(prev) || '?') + ' → ' + _ticAppFullName(entry);
      app.references[i] = entry;
    } else {
      auditAction = 'tic_reference_add';
      auditDetail = 'Added emergency contact: ' + _ticAppFullName(entry) + (entry.relationship ? ' (' + entry.relationship + ')' : '');
      app.references.push(entry);
    }
    _ticPersistApplication()
      .then(function(){
        _ticRenderReferences();
        _ticAudit(auditAction, auditDetail);
        if(typeof showToast === 'function') showToast(mode === 'edit' ? 'Emergency contact updated.' : 'Emergency contact added.', {type:'info'});
      })
      .catch(function(err){
        if(typeof showToast === 'function') showToast('Save failed: ' + err.message, { type:'error' });
      });
  }
  function _ticRefDelete(idx){
    var app = _ticState.application;
    var i = Number(idx);
    if(!app || isNaN(i) || !app.references || !app.references[i]) return;
    var r = app.references[i];
    if(!confirm('Delete emergency contact "' + (_ticAppFullName(r) || 'this contact') + '"?')) return;
    var detail = 'Removed emergency contact: ' + (_ticAppFullName(r) || '?');
    app.references.splice(i, 1);
    _ticPersistApplication()
      .then(function(){
        _ticRenderReferences();
        _ticAudit('tic_reference_delete', detail);
        if(typeof showToast === 'function') showToast('Emergency contact removed.', {type:'info'});
      })
      .catch(function(err){
        if(typeof showToast === 'function') showToast('Delete failed: ' + err.message, { type:'error' });
      });
  }

  // ── Render: Pets (from app.pets) ──────────────────────────────────────────
  function _ticAppPets(){
    var a = _ticState.application;
    if(!a || !_ticIsArray(a.pets)) return [];
    return a.pets;
  }
  function _ticRenderPets(){
    var app = _ticState.application;
    if(!app){
      _ticEl('tic_panel_pets').innerHTML =
        '<div class="tic-pending-inline">No linked application — pets are sourced from the application form.</div>';
      return;
    }
    var pets = _ticAppPets();
    var realPets = pets.filter(function(p){ return p && (p.name || p.type); });
    var html = '<div class="tic-section"><div class="tic-section-h">Pets</div>';
    if(!realPets.length){
      html += '<div class="tic-empty">No pets on the application.</div>';
    } else {
      html += '<div class="tic-pet-grid">';
      pets.forEach(function(p, idx){
        if(!p || (!p.name && !p.type)) return;
        html += '<div class="tic-pet-card" data-tic-pet-idx="' + idx + '">'
             +   '<div class="tic-pet-icon">' + _ticPet(p.type) + '</div>'
             +   '<div class="tic-pet-body">'
             +     '<div class="tic-pet-name">' + _ticEsc(p.name || 'Unnamed') + '</div>'
             +     '<div class="tic-pet-meta">' + _ticEsc(p.type || '—')
             +       (p.size ? ' · ' + _ticEsc(p.size) : '')
             +     '</div>'
             +     (p.desc ? '<div class="tic-pet-meta">' + _ticEsc(p.desc) + '</div>' : '')
             +     '<div class="tic-pet-actions">'
             +       '<button type="button" class="btn btn-ghost" data-tic-action="pet-edit">Edit</button>'
             +       '<button type="button" class="btn btn-ghost" data-tic-action="pet-delete">Delete</button>'
             +     '</div>'
             +   '</div>'
             + '</div>';
      });
      html += '</div>';
    }
    html += '<div class="tic-form-actions"><button type="button" class="btn btn-primary" data-tic-action="pet-add">+ Add Pet</button></div>';
    html += '<div id="tic_pet_form" class="tic-add-form" data-tic-pet-mode="add">'
         +   '<div class="tic-grid-2">'
         +     '<div class="tic-field"><label class="tic-field-lbl">Pet Name *</label><input class="tic-input" id="tic_pet_name" type="text"/></div>'
         +     '<div class="tic-field"><label class="tic-field-lbl">Type *</label><input class="tic-input" id="tic_pet_type" type="text" placeholder="dog, cat, bird…"/></div>'
         +     '<div class="tic-field"><label class="tic-field-lbl">Size</label><input class="tic-input" id="tic_pet_size" type="text" placeholder="small, medium, large"/></div>'
         +     '<div class="tic-field tic-grid-span-2"><label class="tic-field-lbl">Description</label><input class="tic-input" id="tic_pet_desc" type="text"/></div>'
         +   '</div>'
         +   '<div class="tic-form-actions">'
         +     '<button type="button" class="btn btn-ghost"   data-tic-action="pet-cancel">Cancel</button>'
         +     '<button type="button" class="btn btn-primary" data-tic-action="pet-save">Save</button>'
         +   '</div>'
         + '</div>';
    html += '</div>';
    _ticEl('tic_panel_pets').innerHTML = html;
  }
  function _ticPetEditOpen(idx){
    var i = Number(idx);
    var p = _ticAppPets()[i];
    if(!p) return;
    var form = _ticEl('tic_pet_form');
    form.setAttribute('data-tic-pet-mode','edit');
    form.setAttribute('data-tic-pet-idx', String(i));
    _ticEl('tic_pet_name').value = p.name || '';
    _ticEl('tic_pet_type').value = p.type || '';
    _ticEl('tic_pet_size').value = p.size || '';
    _ticEl('tic_pet_desc').value = p.desc || '';
    form.classList.add('tic-open');
  }
  function _ticPetDelete(idx){
    var app = _ticState.application;
    var i = Number(idx);
    if(!app || isNaN(i) || !app.pets || !app.pets[i]) return;
    var p = app.pets[i];
    if(!confirm('Delete pet "' + (p.name || 'this pet') + '"?')) return;
    var detail = 'Removed pet: ' + (p.name||'?') + ' (' + (p.type||'?') + ')';
    app.pets.splice(i, 1);
    _ticPersistApplication()
      .then(function(){
        _ticRenderPets();
        _ticAudit('tic_pet_delete', detail);
        if(typeof showToast === 'function') showToast('Pet removed.', {type:'info'});
      })
      .catch(function(err){
        if(typeof showToast === 'function') showToast('Delete failed: ' + err.message, { type:'error' });
      });
  }

  // ── Render: Documents (DocLibrary mount) ──────────────────────────────────
  // Mirrors the standalone tenantFilesPanel pattern in shared-data.js — same
  // entityType, pathPrefix, storage bucket. Uses unit id since that's how the
  // existing file system keys tenant docs.
  var _ticDocLib = null;
  var _ticDocLibKey = null;
  function _ticRenderDocuments(){
    var p = _ticEl('tic_panel_documents');
    if(!p) return;
    var unit = _ticState.unit;
    if(!unit || !unit.id){
      p.innerHTML = '<div class="tic-empty">No unit linked — document library unavailable.</div>';
      return;
    }
    var key = String(unit.id);
    if(_ticDocLibKey === key && _ticDocLib){ return; } // already mounted for this tenant
    // Eviction notices are HM/ED-only; hide them from other roles.
    var evictBtns = _ticCanEvict()
      ? ( '<button type="button" onclick="window._ticOpenEvictionNoticeModal && window._ticOpenEvictionNoticeModal(\'standard\')" class="header-export-item">Notice of Eviction &mdash; Standard (Drug-Related)</button>'
        + '<button type="button" onclick="window._ticOpenEvictionNoticeModal && window._ticOpenEvictionNoticeModal(\'immediate\')" class="header-export-item">Notice of IMMEDIATE Eviction (Safety Risk)</button>' )
      : '';
    p.innerHTML = '<div style="padding:10px 14px;border-bottom:1px solid var(--border);display:flex;justify-content:flex-end;">'
      + '<div class="export-dropdown">'
      +   '<button type="button" onclick="toggleExportMenu(this)" class="btn btn-primary">&#128196; Generate Forms &#9660;</button>'
      +   '<div class="header-export-menu header-export-menu--wide">'
      +     '<div class="header-export-group">Occupancy Agreements</div>'
      +     '<button type="button" onclick="window._ticOpenLeaseModal && window._ticOpenLeaseModal()" class="header-export-item">'+(nationShort())+' Residential Occupancy Agreement</button>'
      +     '<button type="button" onclick="window._ticOpenLeaseModal && window._ticOpenLeaseModal(\'temporary_lease\')" class="header-export-item">Temporary Occupancy Agreement (Fixed Term)</button>'
      +     '<button type="button" onclick="window._ticOpenLeaseModal && window._ticOpenLeaseModal(\'monthly_temp_lease\')" class="header-export-item">Month-to-Month Occupancy Agreement (All-Inclusive)</button>'
      +     '<button type="button" onclick="window._ticOpenLeaseModal && window._ticOpenLeaseModal(\'commercial_lease\')" class="header-export-item">Commercial Occupancy &amp; Lease Agreement</button>'
      +     '<button type="button" onclick="window._ticOpenReplacementLeaseModal && window._ticOpenReplacementLeaseModal()" class="header-export-item">Replacement Lease Agreement (No Appliances)</button>'
      +     '<button type="button" onclick="window._ticOpenLeaseModal && window._ticOpenLeaseModal(\'replacement_contract\')" class="header-export-item">Rental / Homeownership Agreement (Replacement Contract)</button>'
      +     '<div class="header-export-group">Notices</div>'
      +     '<button type="button" onclick="window._ticOpenInspectionNoticeModal && window._ticOpenInspectionNoticeModal()" class="header-export-item">Notice of Inspection &mdash; 48 Hours</button>'
      +     evictBtns
      +     '<div class="header-export-group">Consents</div>'
      +     '<button type="button" onclick="window._ticOpenHydroOneConsentModal && window._ticOpenHydroOneConsentModal()" class="header-export-item">Hydro One &mdash; Consent for Disclosure</button>'
      +   '</div>'
      + '</div>'
      + '</div>'
      + '<div id="tic_doclib_mount"></div>';
    var mount = _ticEl('tic_doclib_mount');
    if(!window.DocLibrary){
      p.innerHTML = '<div class="tic-pending-inline">Document library is not loaded on this page.</div>';
      return;
    }
    try {
      var _ticUnit = unit;
      _ticDocLib = window.DocLibrary.create(mount, {
        entityType:    'tenant',
        entityId:      unit.id,
        pathPrefix:    'tenants/' + unit.id,
        supabaseUrl:   SUPABASE_URL,
        supabaseAnon:  (typeof SUPABASE_ANON !== 'undefined') ? SUPABASE_ANON : '',
        storageBucket: (typeof STORAGE_BUCKET !== 'undefined') ? STORAGE_BUCKET : 'housing-files',
        getAuthToken:  function(){
          return (window.HOUSING_HEADERS && window.HOUSING_HEADERS['Authorization'] || '').replace('Bearer ','');
        },
        readOnly: _ticReadOnlyRole(),
        categories: [
          { key:'id',          label:'ID',              icon:'🧾' },
          { key:'income',      label:'Income / Pay',    icon:'💰' },
          { key:'reference',   label:'Reference',       icon:'📝' },
          { key:'housing_hist',label:'Housing History', icon:'🏠' },
          { key:'medical',     label:'Medical',         icon:'⚕️'  },
          { key:'migrated',    label:'Migrated',        icon:'📂' },
          { key:'image',       label:'Image',           icon:'🖼️' },
          { key:'other',       label:'Other',           icon:'📎' }
        ],
        // Load from BOTH tenant folder and the linked application
        customLoader: async function() {
          var allFiles = [];
          var unitId = _ticUnit && _ticUnit.id;

          // Source 1: tenant-specific docs from Storage
          try {
            var tf = await sbListFiles('tenants/' + unitId + '/');
            (tf || []).filter(function(f){ return f.name && f.name !== '.emptyFolderPlaceholder'; })
              .forEach(function(f){
                allFiles.push({
                  path:    'tenants/' + unitId + '/' + f.name,
                  name:    f.name,
                  size:    f.metadata ? (f.metadata.size || 0) : 0,
                  type:    f.metadata ? (f.metadata.mimetype || '') : '',
                  category:'other',
                  addedAt: f.created_at ? f.created_at.slice(0,10) : ''
                });
              });
          } catch(e) { console.warn('[tic docs] tenant files:', e); }

          // Source 2: application documents (app_documents table + storage folder)
          var app = _ticState.application;
          if (app && app.id) {
            var appId = app.id;
            try {
              var r2 = await fetch(
                SUPABASE_URL + '/rest/v1/app_documents?app_id=eq.' + encodeURIComponent(appId) + '&select=*&order=added_at.asc',
                { headers: HOUSING_HEADERS }
              );
              if (r2.ok) {
                (await r2.json()).forEach(function(row){
                  if (!allFiles.find(function(x){ return x.path === row.file_path; })) {
                    allFiles.push({
                      path:     row.file_path,
                      name:     row.file_name || row.file_path.split('/').pop(),
                      size:     row.file_size || 0,
                      type:     row.file_type || '',
                      category: row.category  || 'migrated',
                      addedAt:  (row.added_at || '').slice(0,10),
                      addedBy:  row.added_by,
                      source:   'application',
                      docId:    row.id
                    });
                  }
                });
              }
            } catch(e) { console.warn('[tic docs] app_documents:', e); }

            try {
              var af = await sbListFiles('applications/' + appId + '/');
              (af || []).filter(function(f){ return f.name && f.name !== '.emptyFolderPlaceholder'; })
                .forEach(function(f){
                  var fp = 'applications/' + appId + '/' + f.name;
                  if (!allFiles.find(function(x){ return x.path === fp; })) {
                    allFiles.push({
                      path:    fp,
                      name:    f.name,
                      size:    f.metadata ? (f.metadata.size || 0) : 0,
                      type:    f.metadata ? (f.metadata.mimetype || '') : '',
                      category:'other',
                      addedAt: f.created_at ? f.created_at.slice(0,10) : '',
                      source:  'application'
                    });
                  }
                });
            } catch(e) { console.warn('[tic docs] application folder:', e); }
          }

          return allFiles;
        },
        // Prevent deletion of application-sourced docs from within the TIC
        customDelete: async function(file) {
          if (file && file.source === 'application') {
            if (typeof showToast === 'function') showToast('This document belongs to the application — manage it from the application form', {type:'info'});
            return;
          }
          // Standard delete for tenant-owned docs
          if (typeof sbDeleteFile === 'function') await sbDeleteFile(file.path);
          try {
            await fetch(SUPABASE_URL + '/rest/v1/housing_audit_log', {
              method: 'POST',
              headers: Object.assign({}, HOUSING_HEADERS, {'Prefer':'return=minimal'}),
              body: JSON.stringify({
                entity_type: 'tenant', entity_id: String(_ticUnit.id),
                action: 'file_deleted',
                detail: JSON.stringify({path: file.path, name: file.name}),
                actor: window.currentRole || 'staff',
                created_at: new Date().toISOString()
              })
            });
          } catch(e) {}
        }
      });
      _ticDocLibKey = key;
    } catch(err){
      p.innerHTML = '<div class="tic-error-inline">Failed to mount document library: ' + _ticEsc(err && err.message || err) + '</div>';
    }
  }

  // ── Render: Notes ─────────────────────────────────────────────────────────
  function _ticRenderNotes(){
    var tenantNotes = _ticIsArray(_ticState.notes) ? _ticState.notes : [];
    var appNotes    = _ticIsArray(_ticState.applicationNotes) ? _ticState.applicationNotes : [];
    var tenantNotesErrored = _ticIsError(_ticState.notes);

    // Normalize application-note rows into the tenant-note shape so a single
    // render path covers both. App notes carry over from intake so they show
    // up identically alongside notes added in the TIC.
    var normalizedAppNotes = appNotes.map(function(n){
      var row = {};
      row[TIC_C.author_name] = n.author_name || n.author_email || 'Unknown';
      row[TIC_C.note_body]   = n.body || '';
      row[TIC_C.created_at]  = n.created_at || null;
      return row;
    });

    var merged = tenantNotes.concat(normalizedAppNotes);
    merged.sort(function(a, b){
      var aT = a[TIC_C.created_at] || '';
      var bT = b[TIC_C.created_at] || '';
      if(aT === bT) return 0;
      return aT < bT ? 1 : -1; // newest first
    });

    var html = '<div class="tic-section">'
             +   '<div class="tic-section-h">Add a Note</div>'
             +   '<textarea id="tic_note_input" class="tic-textarea" placeholder="Type your note…"></textarea>'
             +   '<div class="tic-form-actions">'
             +     '<button type="button" class="btn btn-primary" data-tic-action="note-save">Add Note</button>'
             +   '</div>'
             + '</div>';
    html += '<div class="tic-section tic-section-spaced"><div class="tic-section-h">Notes &amp; History</div>';
    html += '<div id="tic_notes_list">';
    if(tenantNotesErrored && !merged.length){
      html += '<div class="tic-error-inline">Unable to load notes.</div>';
    } else if(!merged.length){
      html += '<div class="tic-empty">No notes yet.</div>';
    } else {
      merged.forEach(function(n){
        html += _ticNoteHtml(n);
      });
    }
    html += '</div>';
    html += '</div>';
    _ticEl('tic_panel_notes').innerHTML = html;
  }
  function _ticNoteHtml(n){
    return '<div class="tic-note">'
         +   '<div class="tic-note-meta"><span class="tic-note-author">' + _ticEsc(n[TIC_C.author_name]||'Unknown') + '</span> · ' + _ticEsc(_ticFmtDT(n[TIC_C.created_at])) + '</div>'
         +   '<div class="tic-note-body">' + _ticEsc(n[TIC_C.note_body]||'') + '</div>'
         + '</div>';
  }

  // ── Render: Unit History ──────────────────────────────────────────────────
  function _ticRenderTenancyHistory(){
    var panel = _ticEl('tic_panel_history');
    if (!panel) return;
    var rows = _ticState.movementLog || [];
    if (!rows.length) {
      panel.innerHTML = '<div class="tic-empty">No unit history on record for this tenant.</div>';
      return;
    }
    var html = '<div style="display:flex;flex-direction:column;gap:8px;">';
    rows.forEach(function(r){
      var mi  = r.move_in_date  ? _ticFmtDate(r.move_in_date)  : '—';
      var mo  = r.move_out_date ? _ticFmtDate(r.move_out_date) : '—';
      var dur = r.duration_days != null ? (r.duration_days + ' days') : '—';
      html += '<div style="border:1px solid var(--border);border-radius:8px;padding:12px 14px;background:var(--bg);">'
        + '<div style="font-size:12px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.6px;margin-bottom:6px;">'
        +   _ticEsc(r.unit_address || r.unit_id || 'Unit') + '</div>'
        + '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;">'
        +   '<div><div class="tic-field-lbl">Move-In</div><div style="font-size:13px;font-weight:600;">' + _ticEsc(mi) + '</div></div>'
        +   '<div><div class="tic-field-lbl">Move-Out</div><div style="font-size:13px;font-weight:600;">' + _ticEsc(mo) + '</div></div>'
        +   '<div><div class="tic-field-lbl">Duration</div><div style="font-size:13px;font-weight:600;">' + _ticEsc(dur) + '</div></div>'
        + '</div>'
        + '</div>';
    });
    html += '</div>';
    panel.innerHTML = html;
  }

  // ── Tab switching ─────────────────────────────────────────────────────────
  function _ticSwitchTab(name){
    _ticState.activeTab = name;
    var tabs = document.querySelectorAll('#ticModal .tic-tab');
    for(var i=0;i<tabs.length;i++){
      tabs[i].classList.toggle('tic-active', tabs[i].getAttribute('data-tic-tab') === name);
    }
    var panels = document.querySelectorAll('#ticModal .tic-panel');
    for(var j=0;j<panels.length;j++){
      panels[j].classList.remove('tic-active');
    }
    var p = _ticEl('tic_panel_' + name);
    if(p) p.classList.add('tic-active');
    if(name === 'documents')  _ticRenderDocuments();
    if(name === 'utilities')  _ticRenderUtilities();
  }

  // ── Save handlers ─────────────────────────────────────────────────────────
  function _ticSavePet(){
    var app = _ticState.application;
    if(!app){ if(typeof showToast === 'function') showToast('No linked application.', { type:'error' }); return; }
    var form = _ticEl('tic_pet_form');
    var mode = form.getAttribute('data-tic-pet-mode') || 'add';
    var name = (_ticEl('tic_pet_name').value||'').trim();
    var type = (_ticEl('tic_pet_type').value||'').trim();
    if(!name || !type){
      if(typeof showToast === 'function') showToast('Pet name and type are required.', { type:'error' });
      return;
    }
    var entry = {
      name: name,
      type: type,
      size: (_ticEl('tic_pet_size').value||'').trim(),
      desc: (_ticEl('tic_pet_desc').value||'').trim()
    };
    app.pets = _ticIsArray(app.pets) ? app.pets : [];
    var auditAction, auditDetail;
    if(mode === 'edit'){
      var i = Number(form.getAttribute('data-tic-pet-idx'));
      if(isNaN(i) || !app.pets[i]) return;
      var prev = app.pets[i];
      auditAction = 'tic_pet_update';
      auditDetail = 'Updated pet: ' + (prev.name || '?') + ' (' + (prev.type||'?') + ') → ' + entry.name + ' (' + entry.type + ')';
      app.pets[i] = entry;
    } else {
      auditAction = 'tic_pet_add';
      auditDetail = 'Added pet: ' + entry.name + ' (' + entry.type + ')';
      app.pets.push(entry);
    }
    _ticPersistApplication()
      .then(function(){
        _ticRenderPets();
        _ticAudit(auditAction, auditDetail);
        if(typeof showToast === 'function') showToast(mode === 'edit' ? 'Pet updated.' : 'Pet added.', {type:'info'});
      })
      .catch(function(err){
        if(typeof showToast === 'function') showToast('Save failed: ' + err.message, { type:'error' });
      });
  }
  // Ensure a real tenants row exists for the current card and resolve its pk.
  // Applicant TICs open with a VIRTUAL tenant (no pk); child records like notes
  // need a valid tenant_id, so the first such write creates the row (status
  // 'applicant', linked by application_id). Mirrors the create-on-save in
  // _ticSaveField. Rejects if there's no name to create a record from.
  function _ticEnsureTenantRow(){
    var t0 = _ticState.tenant || {};
    var pk = t0[TIC_C.tenant_pk];
    if (pk) return Promise.resolve(pk);
    var name = t0[TIC_C.full_name] || '';
    if (!name) return Promise.reject(new Error('No name on file to create a record.'));
    var insert = {
      full_name:      name,
      status:         'applicant',
      application_id: t0[TIC_C.application_id] || null
    };
    return _ticWrite('POST', TIC_T.tenants, insert).then(function(rows){
      var saved = (rows && rows[0]) || insert;
      _ticState.tenant = saved;
      if (typeof _ticRenderHero  === 'function') _ticRenderHero();
      if (typeof _ticRenderStrip === 'function') _ticRenderStrip();
      var newPk = saved[TIC_C.tenant_pk];
      if (!newPk) throw new Error('Could not create the tenant record.');
      return newPk;
    });
  }

  function _ticSaveNote(){
    var inp = _ticEl('tic_note_input');
    var body = (inp && inp.value || '').trim();
    if(!body){
      if(typeof showToast === 'function') showToast('Note cannot be empty.', { type:'error' });
      return;
    }
    var author = (typeof HOUSING_SESSION !== 'undefined' && HOUSING_SESSION.name)
               ? HOUSING_SESSION.name
               : (sessionStorage.getItem('clfn_housing_name') || 'Unknown');
    // Ensure a tenant row (and thus a tenant_id) exists before inserting the
    // note — applicant TICs have no tenant row until the first write, which
    // previously caused a null tenant_id not-null violation.
    _ticEnsureTenantRow().then(function(pk){
      var payload = {};
      payload[TIC_C.tenant_fk]   = pk;
      payload[TIC_C.note_body]   = body;
      payload[TIC_C.author_name] = author;
      payload[TIC_C.created_at]  = new Date().toISOString();
      return _ticWrite('POST', TIC_T.tenant_notes, payload).then(function(rows){
        var added = (rows && rows[0]) || payload;
        _ticState.notes.unshift(added);
        var list = _ticEl('tic_notes_list');
        if(list){
          if(list.querySelector('.tic-empty')) list.innerHTML = '';
          list.insertAdjacentHTML('afterbegin', _ticNoteHtml(added));
        }
        if(inp) inp.value = '';
        if(typeof _ticRenderHero === 'function') _ticRenderHero();  // refresh last-note badge
        _ticAudit('tic_note_add', 'Added note (' + body.length + ' chars)');
        if(typeof showToast === 'function') showToast('Note added.', {type:'info'});
      });
    })
    .catch(function(err){
      if(typeof showToast === 'function') showToast('Save failed: ' + err.message, { type:'error' });
    });
  }

  // ── Inline-edit for Contact rows ──────────────────────────────────────────

  // ── Action delegate ───────────────────────────────────────────────────────
  function _ticResetPetForm(){
    var f = _ticEl('tic_pet_form'); if(!f) return;
    f.removeAttribute('data-tic-pet-idx');
    f.setAttribute('data-tic-pet-mode','add');
    f.classList.remove('tic-open');
    ['tic_pet_name','tic_pet_type','tic_pet_size','tic_pet_desc'].forEach(function(id){
      var el = _ticEl(id); if(el) el.value='';
    });
  }
  function _ticOnBodyClick(ev){
    var btn = ev.target;
    var act = btn && btn.getAttribute && btn.getAttribute('data-tic-action');
    if(!act) return;
    if(act === 'slp-open')     { _slpOpen(); return; }
    // Income (employment)
    if(act === 'inc-add')      { _ticResetIncForm(); _ticEl('tic_inc_form').classList.add('tic-open'); return; }
    if(act === 'inc-cancel')   { _ticResetIncForm(); return; }
    if(act === 'inc-save')     { _ticSaveIncome(); return; }
    if(act === 'inc-edit')     {
      var irow = btn.closest('[data-tic-inc-idx]');
      if(irow) _ticIncEditOpen(irow.getAttribute('data-tic-inc-idx'));
      return;
    }
    if(act === 'inc-delete')   {
      var irow2 = btn.closest('[data-tic-inc-idx]');
      if(irow2) _ticIncDelete(irow2.getAttribute('data-tic-inc-idx'));
      return;
    }
    if(act === 'occ-apply-shelter-rent'){ _ticApplyShelterRent(); return; }
    // Habitants (household members on application)
    if(act === 'hab-add')      { _ticResetHabForm(); _ticEl('tic_hab_form').classList.add('tic-open'); return; }
    if(act === 'hab-cancel')   { _ticResetHabForm(); return; }
    if(act === 'hab-save')     { _ticSaveHabitant(); return; }
    if(act === 'hab-edit')     {
      var hrow = btn.closest('[data-tic-hab-idx]');
      if(hrow) _ticHabEditOpen(hrow.getAttribute('data-tic-hab-idx'));
      return;
    }
    if(act === 'hab-delete')   {
      var hrow2 = btn.closest('[data-tic-hab-idx]');
      if(hrow2) _ticHabDelete(hrow2.getAttribute('data-tic-hab-idx'));
      return;
    }
    // Pets
    if(act === 'pet-add')      { _ticResetPetForm(); _ticEl('tic_pet_form').classList.add('tic-open'); return; }
    if(act === 'pet-cancel')   { _ticResetPetForm(); return; }
    if(act === 'pet-save')     { _ticSavePet(); return; }
    if(act === 'pet-edit')     {
      var pcard = btn.closest('[data-tic-pet-idx]');
      if(pcard) _ticPetEditOpen(pcard.getAttribute('data-tic-pet-idx'));
      return;
    }
    if(act === 'pet-delete')   {
      var pcard2 = btn.closest('[data-tic-pet-idx]');
      if(pcard2) _ticPetDelete(pcard2.getAttribute('data-tic-pet-idx'));
      return;
    }
    // References
    if(act === 'ref-add')      { _ticResetRefForm(); _ticEl('tic_ref_form').classList.add('tic-open'); return; }
    if(act === 'ref-cancel')   { _ticResetRefForm(); return; }
    if(act === 'ref-save')     { _ticSaveReference(); return; }
    if(act === 'ref-edit')     {
      var rrow = btn.closest('[data-tic-ref-idx]');
      if(rrow) _ticRefEditOpen(rrow.getAttribute('data-tic-ref-idx'));
      return;
    }
    if(act === 'ref-delete')   {
      var rrow2 = btn.closest('[data-tic-ref-idx]');
      if(rrow2) _ticRefDelete(rrow2.getAttribute('data-tic-ref-idx'));
      return;
    }
    // Notes
    if(act === 'note-save')    { _ticSaveNote(); return; }
  }

  // ── Quick-actions footer ──────────────────────────────────────────────────
  function _ticGoToApplication(appId){
    window.location.href = 'housing.html?openApp=' + encodeURIComponent(appId);
  }
  // The unit currently assigned to this tenant, resolved from the unit object or
  // the tenant's unit_id / current_unit_id. '' = no unit assigned.
  function _ticAssignedUnitId(){
    return (_ticState.unit && _ticState.unit.id)
        || (_ticState.tenant && (_ticState.tenant.unit_id || _ticState.tenant.current_unit_id))
        || '';
  }
  // Show the "View Unit" footer button only when the tenant has an assigned
  // unit; hide it otherwise.
  function _ticSyncFooter(){
    var btn = _ticEl('tic_act_view_unit');
    if(btn) btn.style.display = _ticAssignedUnitId() ? '' : 'none';
    // Delete Application — same authority as everywhere else deletion lives
    // (deleteApplication, Settings > Approval Authority > Housing Application,
    // default ED). Soft-delete: the record is archived, never destroyed.
    var del = _ticEl('tic_act_delete_app');
    if(del){
      var canDel = (typeof APPROVAL_AUTHORITY !== 'undefined')
        && APPROVAL_AUTHORITY.can('deleteApplication', window.currentRole);
      del.style.display = canDel ? '' : 'none';
    }
    // Correct Name — management only. A deliberate action (not a field edit)
    // because renaming touches tenants + housing_units + the application, and
    // a bare unit rename would trip the sync trigger into splitting history.
    var ren = _ticEl('tic_act_rename');
    if(ren){
      var canRen = (typeof ROLE !== 'undefined') && ROLE.isManagement && ROLE.isManagement(window.currentRole);
      ren.style.display = canRen ? '' : 'none';
    }
  }

  // CM5 — commercial-tailored TIC. For a business/department tenant (or a
  // commercial application), hide the residential-only tabs (Occupants,
  // Emergency Contacts, Pets) but KEEP Utilities so hydro/gas info is captured,
  // plus Overview, Contact, Documents, Unit History, Notes. Re-run on every open
  // so it restores the tabs for ordinary residential tenants.
  function _ticIsCommercial(){
    var t = _ticState.tenant || {};
    var app = _ticState.application || {};
    var ty = t.tenant_type || t.type || '';
    return ty === 'business' || ty === 'department' || (app && app.appType === 'commercial');
  }
  function _ticApplyCommercialMode(){
    var modal = _ticEl('ticModal');
    if(!modal) return;
    var isComm = _ticIsCommercial();
    modal.classList.toggle('tic-commercial', !!isComm);
    var hide = { occupants:1, emergency:1, pets:1 };   // residential-only
    var tabs = modal.querySelectorAll('.tic-tabs [data-tic-tab]');
    var activeHidden = false;
    for(var i=0;i<tabs.length;i++){
      var name = tabs[i].getAttribute('data-tic-tab');
      var hideIt = isComm && !!hide[name];
      tabs[i].style.display = hideIt ? 'none' : '';
      if(hideIt && tabs[i].classList.contains('tic-active')) activeHidden = true;
    }
    if(activeHidden && typeof _ticSwitchTab === 'function') _ticSwitchTab('overview');
  }
  function _ticFindApplicationForTenant(){
    // 1) unit.assignedTo — set by the assign-unit flow and reflects the most
    //    recent application linked to this unit. Checked before tenant.application_id
    //    so that existing-tenant file updates (where the tenants row still carries
    //    an old application_id) resolve to the new file-update application.
    var unitAppId = (_ticState.unit && _ticState.unit.assignedTo) || '';
    if(unitAppId) return Promise.resolve(unitAppId);
    // 2) explicit linkage on the tenants row
    var appId = (_ticState.tenant && _ticState.tenant[TIC_C.application_id]) || '';
    if(appId) return Promise.resolve(appId);
    // 3) fall back to local cache by name (avoids a network round-trip when possible)
    var name = (_ticState.tenant && _ticState.tenant[TIC_C.full_name])
            || (_ticState.unit && _ticState.unit.assignedName)
            || '';
    if(!name) return Promise.resolve('');
    var parts = String(name).trim().split(/\s+/);
    var fn = parts[0] || '';
    var ln = parts.slice(1).join(' ');
    var local = (typeof applications !== 'undefined' && applications && applications.length)
              ? applications : (window.SP_APPLICATIONS || []);
    var cached = local.filter(function(a){
      return ((a.fn||'').toLowerCase() === fn.toLowerCase())
          && ((a.ln||'').toLowerCase() === ln.toLowerCase());
    }).sort(function(a,b){
      return String(b.created_at||b.createdAt||'').localeCompare(String(a.created_at||a.createdAt||''));
    });
    if(cached.length && cached[0].id) return Promise.resolve(cached[0].id);
    // 3) live search Supabase as last resort. fn/ln live in the JSONB `data`
    // column on housing_applications, so use PostgREST's `data->>field` syntax.
    var qs = 'data->>fn=eq.' + encodeURIComponent(fn)
           + (ln ? '&data->>ln=eq.' + encodeURIComponent(ln) : '')
           + '&select=id&order=submitted_at.desc.nullslast&limit=1';
    return _ticGet(TIC_T.applications + '?' + qs).then(function(rows){
      if(_ticIsArray(rows) && rows.length && rows[0].id) return rows[0].id;
      return '';
    }).catch(function(){ return ''; });
  }
  // ── Correct Name (spelling fix across ALL linked records) ─────────────────
  // Field edits can't fix a misspelled name safely: renaming the unit's
  // assigned_name alone makes the DB sync trigger mark the real tenant row
  // "moved out" and mint a brand-new row under the corrected spelling —
  // splitting arrears/notes history. This action repairs everything in the
  // right order:
  //   1. rename the tenants row FIRST (history + finance FKs stay on it),
  //   2. rename housing_units.assigned_name (the trigger then finds no
  //      active old-name row to retire, but still mints a duplicate —
  //      which step 3 folds away via merged_into),
  //   3. fix the linked application's fn/ln,
  // and audits the correction. Management only.
  function _ticCorrectName(){
    if(!(typeof ROLE !== 'undefined' && ROLE.isManagement && ROLE.isManagement(window.currentRole))){
      if(typeof showToast === 'function') showToast('Only management can correct names.', {type:'error'});
      return;
    }
    var tn = _ticState.tenant || {};
    var u  = _ticState.unit || {};
    // Fall back to the linked APPLICATION's name — applicants on the waitlist
    // have no tenant row or unit yet, and their misspellings need fixing too.
    var app0 = _ticState.application || null;
    var oldName = tn[TIC_C.full_name] || u.assignedName
      || (app0 ? [app0.fn, app0.ln].filter(Boolean).join(' ') : '') || '';
    if(!oldName){ if(typeof showToast === 'function') showToast('No name on file to correct.', {type:'error'}); return; }
    var parts = String(oldName).trim().split(/\s+/);
    var ex = document.getElementById('ticRenameModal'); if(ex) ex.remove();
    var mo = document.createElement('div');
    mo.id = 'ticRenameModal';
    mo.className = 'modal-ov on';
    mo.style.zIndex = '10060';
    mo.innerHTML =
        '<div class="modal" style="max-width:440px;">'
      + '<div class="modal-hdr"><div><h2 style="font-size:16px;">Correct Name</h2>'
      +   '<div class="modal-hdr-sub">Fixes the spelling on the tenant record, the unit, and the application together, and keeps all history on the same file.</div></div>'
      +   '<button class="modal-close" onclick="var m=document.getElementById(\'ticRenameModal\');if(m)m.remove();">&#x2715;</button></div>'
      + '<div style="padding:16px;">'
      +   '<div style="font-size:12px;color:var(--muted);margin-bottom:10px;">Currently on file: <strong>' + _ticEsc(oldName) + '</strong></div>'
      +   '<div style="display:flex;gap:8px;">'
      +     '<div style="flex:1;"><label style="font-size:11px;font-weight:700;">First name</label><input id="tic_ren_fn" type="text" value="' + _ticEsc(parts[0] || '') + '" style="width:100%;box-sizing:border-box;font-size:13px;padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);"/></div>'
      +     '<div style="flex:1;"><label style="font-size:11px;font-weight:700;">Last name</label><input id="tic_ren_ln" type="text" value="' + _ticEsc(parts.slice(1).join(' ')) + '" style="width:100%;box-sizing:border-box;font-size:13px;padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);"/></div>'
      +   '</div>'
      +   '<div style="font-size:11px;color:var(--muted);margin-top:10px;">Note: the BCR registry is name-keyed — if this person is listed there, update that entry separately.</div>'
      +   '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px;">'
      +     '<button class="btn btn-ghost" onclick="var m=document.getElementById(\'ticRenameModal\');if(m)m.remove();">Cancel</button>'
      +     '<button class="btn btn-primary" id="tic_ren_save">Save Corrected Name</button>'
      +   '</div>'
      + '</div></div>';
    mo.addEventListener('click', function(e){ if(e.target === mo) mo.remove(); });
    document.body.appendChild(mo);
    var saveBtn = mo.querySelector('#tic_ren_save');
    saveBtn.addEventListener('click', function(){ _ticRunRename(oldName, mo); });
  }
  async function _ticRunRename(oldName, mo){
    var fn = ((document.getElementById('tic_ren_fn')||{}).value || '').trim();
    var ln = ((document.getElementById('tic_ren_ln')||{}).value || '').trim();
    var newFull = (fn + ' ' + ln).trim();
    if(!newFull){ if(typeof showToast === 'function') showToast('Enter the corrected name.', {type:'error'}); return; }
    if(newFull === oldName){ mo.remove(); return; }
    var tn = _ticState.tenant || {};
    var u  = _ticState.unit || {};
    var hdrs = function(extra){ return Object.assign({}, (window.HOUSING_HEADERS||{}), extra||{}); };
    try {
      // 1) tenants row first — keeps id (finance ledger FK) and history.
      if(tn.id){
        var r1 = await fetch(SUPABASE_URL + '/rest/v1/tenants?id=eq.' + encodeURIComponent(tn.id), {
          method:'PATCH', headers:hdrs({'Content-Type':'application/json','Prefer':'return=minimal'}),
          body: JSON.stringify({ full_name: newFull })
        });
        if(!r1.ok) throw new Error('tenant rename HTTP ' + r1.status);
        tn[TIC_C.full_name] = newFull;
      }
      // 2) unit assignment (fires the sync trigger — duplicate handled below).
      if(u.id && u.assignedName === oldName){
        var r2 = await fetch(SUPABASE_URL + '/rest/v1/housing_units?id=eq.' + encodeURIComponent(u.id), {
          method:'PATCH', headers:hdrs({'Content-Type':'application/json','Prefer':'return=minimal'}),
          body: JSON.stringify({ assigned_name: newFull })
        });
        if(!r2.ok) throw new Error('unit rename HTTP ' + r2.status);
        u.assignedName = newFull;
        var mem = (window.housingUnits||[]).find(function(x){ return x && x.id === u.id; });
        if(mem) mem.assignedName = newFull;
        // Fold away the trigger-minted duplicate (keep the original row).
        if(tn.id){
          try {
            var dups = await (await fetch(SUPABASE_URL + '/rest/v1/tenants?full_name=eq.' + encodeURIComponent(newFull)
              + '&current_unit_id=eq.' + encodeURIComponent(u.id) + '&merged_into=is.null&select=id', { headers: hdrs() })).json();
            for(var di=0; di<(dups||[]).length; di++){
              if(dups[di].id && dups[di].id !== tn.id){
                await fetch(SUPABASE_URL + '/rest/v1/tenants?id=eq.' + encodeURIComponent(dups[di].id), {
                  method:'PATCH', headers:hdrs({'Content-Type':'application/json','Prefer':'return=minimal'}),
                  body: JSON.stringify({ merged_into: tn.id, status: 'former', current_unit_id: null })
                });
              }
            }
            // Make sure the original stayed active on the unit (belt & suspenders
            // against trigger ordering differences between deployments).
            await fetch(SUPABASE_URL + '/rest/v1/tenants?id=eq.' + encodeURIComponent(tn.id), {
              method:'PATCH', headers:hdrs({'Content-Type':'application/json','Prefer':'return=minimal'}),
              body: JSON.stringify({ status: 'active', current_unit_id: u.id, moved_out_at: null })
            });
          } catch(_de){ /* duplicate cleanup is best-effort */ }
        }
      }
      // 3) linked application fn/ln (in-memory + persisted via the normal save).
      var appId = await _ticFindApplicationForTenant();
      if(appId){
        var appMem = (typeof applications !== 'undefined' && applications || []).find(function(a){ return a && a.id === appId; });
        if(appMem){
          appMem.fn = fn; appMem.ln = ln;
          if(typeof sbSaveApplication === 'function') await sbSaveApplication(appMem);
        } else {
          // App not loaded on this page — surgical jsonb update.
          try {
            var rows = await (await fetch(SUPABASE_URL + '/rest/v1/housing_applications?id=eq.' + encodeURIComponent(appId) + '&select=data', { headers: hdrs() })).json();
            if(rows && rows[0]){
              var d = rows[0].data || {};
              d.fn = fn; d.ln = ln;
              await fetch(SUPABASE_URL + '/rest/v1/housing_applications?id=eq.' + encodeURIComponent(appId), {
                method:'PATCH', headers:hdrs({'Content-Type':'application/json','Prefer':'return=minimal'}),
                body: JSON.stringify({ data: d })
              });
            }
          } catch(_ape){ /* best-effort */ }
        }
      }
      if(typeof auditEntry === 'function') auditEntry(appId || (tn.id ? ('TENANT:' + tn.id) : 'SETTINGS'), 'name_corrected',
        'Name corrected: "' + oldName + '" → "' + newFull + '" (tenant record' + (u.id && u.assignedName === newFull ? ' + unit' : '') + (appId ? ' + application ' + appId : '') + ')',
        window.currentRole || 'staff');
      mo.remove();
      _ticRenderHero();
      if(typeof _ticRenderOverview === 'function') try { _ticRenderOverview(); } catch(_re){}
      if(typeof showToast === 'function') showToast('Name corrected to ' + newFull + ' across tenant, unit and application records.', {type:'info'});
      if(typeof renderWorklist === 'function' && document.getElementById('worklist_body')) renderWorklist();
    } catch(err){
      if(typeof showToast === 'function') showToast('Name correction failed: ' + err.message, {type:'error'});
    }
  }

  function _ticOnFooterClick(ev){
    var t = ev.target;
    if(!t || !t.id) return;
    if(t.id === 'tic_act_rename'){ _ticCorrectName(); return; }
    if(t.id === 'tic_act_view_app'){
      _ticFindApplicationForTenant().then(function(appId){
        if(!appId){
          if(typeof showToast === 'function') showToast('No application found for this tenant.', {type:'error'});
          return;
        }
        _ticGoToApplication(appId);
      });
      return;
    }
    if(t.id === 'tic_act_delete_app'){
      if(typeof APPROVAL_AUTHORITY !== 'undefined' && !APPROVAL_AUTHORITY.can('deleteApplication', window.currentRole)){
        if(typeof showToast === 'function') showToast('You are not authorized to delete applications.', {type:'error'});
        return;
      }
      _ticFindApplicationForTenant().then(function(appId){
        if(!appId){
          if(typeof showToast === 'function') showToast('No application found for this tenant.', {type:'error'});
          return;
        }
        var tn = _ticState.tenant || {};
        var name = tn[TIC_C.full_name] || ((_ticState.unit||{}).assignedName) || appId;
        var esc = (typeof escapeHtml === 'function') ? escapeHtml : function(x){ return String(x==null?'':x); };
        var proceed = function(ok){
          if(!ok) return;
          var inMem = (typeof applications !== 'undefined' && applications)
            ? applications.find(function(a){ return a && a.id === appId; }) : null;
          if(inMem && typeof archiveApplication === 'function'){
            // Canonical soft-delete: archive + save + audit + refresh + toast.
            archiveApplication(appId);
            _ticSyncFooter();
            return;
          }
          // Applications not loaded on this page — archive the row directly
          // (same fields archiveApplication stamps).
          var today = new Date().toISOString().split('T')[0];
          _ticGet('housing_applications?id=eq.' + encodeURIComponent(appId) + '&select=id,data')
            .then(function(rows){
              if(!rows || rows._ticMissing || rows._ticError || !rows[0]){
                if(typeof showToast === 'function') showToast('Could not load the application to delete it.', {type:'error'});
                return;
              }
              var d = rows[0].data || {};
              d.archived = true; d.archivedAt = today; d.archivedBy = window.currentRole || 'staff';
              return _ticWrite('PATCH', 'housing_applications?id=eq.' + encodeURIComponent(appId),
                { archived: true, data: d })
                .then(function(){
                  if(typeof auditEntry === 'function') auditEntry(appId, 'archived', 'Application archived from the Tenant Card', window.currentRole || 'staff');
                  if(typeof showToast === 'function') showToast('Application archived — the record is preserved in the audit trail.', {type:'info'});
                });
            })
            .catch(function(e){ if(typeof showToast === 'function') showToast('Delete failed: ' + e.message, {type:'error'}); });
        };
        if(typeof showConfirm === 'function'){
          showConfirm({
            title: 'Delete application?',
            message: 'Delete <strong>' + esc(name) + '</strong>\u2019s housing application? It is ARCHIVED (hidden from active lists, the waitlist, and Match) \u2014 the record and its documents are preserved in the audit trail and an administrator can restore it.',
            confirmText: 'Delete', danger: true
          }).then(proceed);
        } else { proceed(window.confirm('Delete ' + name + '\u2019s application?')); }
      });
      return;
    }
    if(t.id === 'tic_act_view_unit'){
      var vuUnitId = _ticAssignedUnitId();
      if(!vuUnitId){
        if(typeof showToast === 'function') showToast('No unit assigned to this tenant.', {type:'error'});
        return;
      }
      _ticClose();
      window.location.href = 'inventory.html?unit=' + encodeURIComponent(vuUnitId);
      return;
    }
    if(t.id === 'tic_act_new_wo'){
      var unitId = (_ticState.tenant && _ticState.tenant.unit_id) || (_ticState.unit && _ticState.unit.id);
      if(!unitId){
        if(typeof showToast === 'function') showToast('No unit linked to this tenant.', {type:'error'});
        return;
      }
      _ticClose();
      if(typeof openSowModal === 'function'){
        window._sowForceNew = true;   // "New Work Order" always starts a fresh request
        openSowModal(unitId);
      } else {
        if(typeof showToast === 'function') showToast('Work order module not loaded on this page.', {type:'info'});
      }
      return;
    }
    if(t.id === 'tic_act_ledger'){
      var ticTid = _ticState.tenant && (_ticState.tenant.id || _ticState.tenant[TIC_C.tenant_pk]);
      if(ticTid){
        window.location.href = 'finance.html?fic=' + encodeURIComponent(ticTid);
      } else {
        if(typeof showToast === 'function') showToast('No tenant linked.', {type:'info'});
      }
      return;
    }
    if(t.id === 'tic_act_finance'){
      var finTid = _ticState.tenant && (_ticState.tenant.id || _ticState.tenant[TIC_C.tenant_pk]);
      if(finTid){
        window.location.href = 'finance.html?fic=' + encodeURIComponent(finTid);
      } else {
        if(typeof showToast === 'function') showToast('No tenant linked.', {type:'info'});
      }
      return;
    }
    if(t.id === 'tic_act_letter'){
      if(typeof showToast === 'function') showToast('Generate letter — coming soon.', {type:'info'});
      return;
    }
    if(t.id === 'tic_act_invite'){
      var iApp = _ticState.application || {};
      var iTn  = _ticState.tenant || {};
      var iEmail = (iApp && iApp.email) || iTn.email || '';
      var iName  = (iApp && ((iApp.fn||'') + ' ' + (iApp.ln||'')).trim()) || iTn.full_name || iTn.name || 'this applicant';
      var iAppId = (iApp && iApp.id) || '';
      if(typeof inviteApplicantToPortal === 'function') inviteApplicantToPortal(iEmail, iName, iAppId);
      else if(typeof showToast === 'function') showToast('Invite is not available on this page.', {type:'error'});
      return;
    }
    if(t.id === 'tic_act_flag'){
      if(typeof showToast === 'function') showToast('Flag for review — coming soon.', {type:'info'});
      return;
    }
  }

  // ── Tab click delegate ────────────────────────────────────────────────────
  function _ticOnTabClick(ev){
    var name = ev.target && ev.target.getAttribute && ev.target.getAttribute('data-tic-tab');
    if(name) _ticSwitchTab(name);
  }

  // ── Focus trap + ESC ──────────────────────────────────────────────────────
  function _ticTrapFocus(modal){
    function handler(e){
      if(e.key === 'Escape'){
        e.preventDefault();
        _ticClose();
        return;
      }
      if(e.key !== 'Tab') return;
      var nodes = modal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      var focusable = [];
      for(var i=0;i<nodes.length;i++){
        var n = nodes[i];
        if(!n.hasAttribute('disabled') && n.offsetParent !== null) focusable.push(n);
      }
      if(!focusable.length) return;
      var first = focusable[0], last = focusable[focusable.length-1];
      if(e.shiftKey && document.activeElement === first){ e.preventDefault(); last.focus(); }
      else if(!e.shiftKey && document.activeElement === last){ e.preventDefault(); first.focus(); }
    }
    return handler;
  }

  // ── Open / Close ──────────────────────────────────────────────────────────
  function _ticOpen(){
    var modal = _ticEl('ticModal');
    if(!modal) return false;
    modal.classList.add('tic-open');
    document.body.classList.add('tic-modal-open');
    _ticState.prevFocus = document.activeElement;
    var closeBtn = _ticEl('tic_close_btn');
    if(closeBtn) setTimeout(function(){ closeBtn.focus(); }, 0);
    _ticState.keyHandler = _ticTrapFocus(modal);
    document.addEventListener('keydown', _ticState.keyHandler);
    return true;
  }
  function _ticClose(){
    var modal = _ticEl('ticModal');
    if(modal) modal.classList.remove('tic-open');
    document.body.classList.remove('tic-modal-open');
    if(_ticState.keyHandler){
      document.removeEventListener('keydown', _ticState.keyHandler);
      _ticState.keyHandler = null;
    }
    if(_ticState.prevFocus && _ticState.prevFocus.focus){
      try { _ticState.prevFocus.focus(); } catch(e){}
    }
    _ticState.prevFocus = null;
  }

  // ── Wiring (idempotent) ───────────────────────────────────────────────────
  var _ticWired = false;
  function _ticWire(){
    if(_ticWired) return;
    var modal = _ticEl('ticModal');
    if(!modal) return;

    var closeBtn = _ticEl('tic_close_btn');
    if(closeBtn) closeBtn.addEventListener('click', _ticClose);

    modal.addEventListener('click', function(e){ if(e.target === modal) _ticClose(); });

    var tabBar = modal.querySelector('.tic-tabs');
    if(tabBar) tabBar.addEventListener('click', _ticOnTabClick);

    var body = modal.querySelector('.tic-body');
    if(body){
      body.addEventListener('click',  _ticOnBodyClick);
      body.addEventListener('change', _ticOnBodyChange);
    }

    var footer = modal.querySelector('.tic-footer');
    if(footer) footer.addEventListener('click', _ticOnFooterClick);
    // "Last saved" indicator — TIC fields auto-save per field; this gives a
    // persistent timestamp alongside the brief per-field highlight.
    if(footer && !footer.querySelector('#tic_saved_indicator')){
      var savedEl = document.createElement('span');
      savedEl.id = 'tic_saved_indicator';
      savedEl.style.cssText = 'font-size:11px;font-weight:600;color:var(--muted);white-space:nowrap;align-self:center;';
      footer.insertBefore(savedEl, footer.firstChild);
    }

    // Scroll-collapse: shrink the info strip to icon-only once the tab body
    // scrolls, freeing space on tablet/mobile (shared-ui.js).
    var strip = modal.querySelector('.tic-strip');
    if(body && strip && typeof _initScrollCollapse === 'function') _initScrollCollapse(body, strip);

    _ticWired = true;
  }

  // ── Public entry point ────────────────────────────────────────────────────
  function openTenantCard(idOrUnitId){
    var modal = _ticEl('ticModal');
    if(!modal){
      if(typeof showToast === 'function') showToast('Tenant card not available on this page.', { type:'error' });
      return;
    }
    _ticWire();

    // Reset state + UI
    _ticState.tenant = null; _ticState.unit = null; _ticState.application = null;
    _ticState.ledger = null; _ticState.notes = []; _ticState.applicationNotes = [];
    _ticState.movementLog = [];
    _ticSyncFooter();   // hide View Unit until the assigned unit resolves
    var _si = document.getElementById('tic_saved_indicator');
    if(_si) _si.textContent = _ticReadOnlyRole() ? '' : '💾 Fields save automatically';
    _ticApplyCommercialMode();   // restore all tabs until the tenant resolves
    _ticDocLib = null; _ticDocLibKey = null;
    _ticUtilDocLib = null; _ticUtilDocLibKey = null;
    ['overview','utilities','occupants','contact','emergency','references','pets','documents','notes','history'].forEach(function(n){
      var p = _ticEl('tic_panel_' + n); if(p) p.innerHTML = '';
    });
    _ticEl('tic_loading').style.display = '';
    // Read-only roles (Field Employee) get a greyed, non-editable card. Saves are
    // already blocked in JS; this class drives the visual disabled state in CSS.
    modal.classList.toggle('tic-readonly', _ticReadOnlyRole());
    _ticSwitchTab('overview');
    _ticOpen();

    _ticResolveTenant(idOrUnitId).then(function(resolved){
      _ticState.tenant = resolved.tenant;
      _ticState.unit   = resolved.unit || _ticFindUnitById(idOrUnitId);

      if(!_ticState.tenant && !_ticState.unit){
        _ticEl('tic_loading').style.display = 'none';
        _ticEl('tic_panel_overview').innerHTML = '<div class="tic-error-inline">Tenant not found.</div>';
        return;
      }

      _ticRenderHero();
      _ticRenderStrip();
      _ticSyncFooter();
      _ticApplyCommercialMode();

      var pkValue = _ticState.tenant ? _ticState.tenant[TIC_C.tenant_pk] : null;
      var loadAll = pkValue ? _ticLoadAll(pkValue, _ticState.unit) : Promise.resolve();
      var loadApp = _ticLoadApplication();
      Promise.all([loadAll, loadApp]).then(function(){
        _ticEl('tic_loading').style.display = 'none';
        _ticRenderHero();
        _ticRenderStrip();
        _ticRenderOverview();
        _ticRenderUtilities();
        _ticRenderOccupants();
        _ticRenderContact();
        _ticRenderEmergency();
        _ticRenderReferences();
        _ticRenderPets();
        _ticRenderNotes();
        _ticRenderTenancyHistory();
        _ticApplyCommercialMode();   // application may now be loaded (appType signal)
        // Auto-open the agreement modal when arriving via the "Generate Agreement"
        // hand-off from a just-completed unit assignment (set in confirmAssignment).
        var _autoLease = window._ticAutoLease;
        window._ticAutoLease = null;
        if (_autoLease && _ticState.unit && _ticState.unit.id) {
          setTimeout(function(){ _ticOpenLeaseModal(_autoLease); }, 300);
        }
      }).catch(function(err){
        _ticEl('tic_loading').style.display = 'none';
        if(typeof showToast === 'function') showToast('Some tenant data could not be loaded.', { type:'error' });
        _ticRenderOverview();
        _ticRenderUtilities();
        _ticRenderOccupants();
        _ticRenderContact();
        _ticRenderEmergency();
        _ticRenderReferences();
        _ticRenderPets();
        _ticRenderNotes();
        _ticRenderTenancyHistory();
      });
    }).catch(function(){
      _ticEl('tic_loading').style.display = 'none';
      _ticEl('tic_panel_overview').innerHTML = '<div class="tic-error-inline">Unable to load tenant.</div>';
    });
  }



  // ════════════════════════════════════════════════════════════════════════
  // CLFN Residential Occupancy Agreement — pdf-lib based generator
  // Fills the official AcroForm PDF (templates/lease-001.pdf, 65 fields)
  // with tenant data, embeds drawn/typed initials and signatures,
  // saves data back to source tables, uploads to tenant document library.
  // ════════════════════════════════════════════════════════════════════════

  async function _loadPdfLib() {
    if (window.PDFLib && window.PDFLib.PDFDocument) return;
    await new Promise(function(resolve, reject) {
      var s = document.createElement('script');
      // jsdelivr, NOT unpkg — unpkg.com is not in the CSP script-src allowlist
      // (`_headers` permits only cdnjs + jsdelivr), so the old unpkg URL was
      // blocked by the browser and this loader always failed.
      s.src = 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js';
      s.onload  = resolve;
      s.onerror = function(){ reject(new Error('pdf-lib load failed')); };
      document.head.appendChild(s);
    });
  }


  // ── Lease initials pop-out ─────────────────────────────────────────────────
  // Captured initials live here so both the pop-out and the PDF generator can
  // read them without relying on live DOM elements.
  var _leaseInitials = {};
  // Captured signatures + initials survive a modal close/reopen so staff don't
  // lose work when they close the agreement to check a detail. Keyed by
  // docKey|unitId so different agreements (and different units) don't collide.
  var _leaseDraft = {};

  // Which agreement the lease modal/generator is currently working with. The
  // standard month-to-month lease is 'residential_lease'; the fixed-term
  // temporary occupancy agreement is 'temporary_lease'. Both share the same
  // modal, initials pop-out, and jsPDF generator -- only the body, clause set,
  // title, and filename differ (all keyed off this).
  var _ticLeaseDocKey = 'residential_lease';
  var _LEASE_TITLES = {
    residential_lease:    'Residential Lease Agreement',
    temporary_lease:      'Temporary Residential Occupancy Agreement (Fixed Term)',
    monthly_temp_lease:   'Month-to-Month Occupancy Agreement (All-Inclusive)',
    commercial_lease:     'Commercial Occupancy & Lease Agreement',
    replacement_contract: 'Rental / Homeownership Agreement — Replacement Contract'
  };
  var _LEASE_FILE_SLUGS = {
    residential_lease:    'Occupancy_Agreement',
    temporary_lease:      'Temporary_Occupancy_Agreement',
    monthly_temp_lease:   'Month_to_Month_Occupancy_Agreement',
    commercial_lease:     'Commercial_Lease_Agreement',
    replacement_contract: 'Replacement_Contract'
  };
  // Docs that are FIXED-TERM (need an end date). The replacement contract is a
  // blank re-issue with no baked-in term, so it is NOT fixed-term.
  var _LEASE_FIXED_TERM = { temporary_lease: 1, commercial_lease: 1 };

  // Returns the effective initials clauses — saved overrides from Settings →
  // Delegates to notifications.js CONTRACTS_DOCS_REGISTRY which is always loaded.
  function _getEffectiveLeaseClauses() {
    return (typeof getContractClauses === 'function')
      ? getContractClauses(_ticLeaseDocKey)
      : [];
  }

  function _ticOpenInitialsPopout(idx) {
    idx = idx || 0;
    var clauses = _getEffectiveLeaseClauses();
    var clause  = clauses[idx];
    if (!clause) return;
    var total  = clauses.length;
    var isLast = idx === total - 1;

    var existing = document.getElementById('ls_initials_popout');
    if (existing) existing.remove();

    var pop = document.createElement('div');
    pop.id = 'ls_initials_popout';
    pop.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:10100;display:flex;align-items:center;justify-content:center;padding:16px;';

    var captured = _leaseInitials[clause.id] || '';

    pop.innerHTML =
        '<div style="background:var(--surface);border-radius:12px;width:100%;max-width:580px;max-height:90vh;display:flex;flex-direction:column;box-shadow:0 8px 40px rgba(0,0,0,.4);">'
      // Header
      + '<div class="modal-hdr"><div>'
      +   '<div class="lbl-yellow">Required Initial ' + (idx+1) + ' of ' + total + '</div>'
      +   '<div class="txt-sm-meta" style="font-weight:600;">' + clause.label + '</div>'
      + '</div></div>'
      // Progress bar
      + '<div style="height:4px;background:var(--border);"><div style="height:4px;background:var(--yellow);width:' + Math.round(((idx+1)/total)*100) + '%;transition:width .3s;"></div></div>'
      // Clause text
      + '<div style="padding:20px 22px;flex:1;overflow-y:auto;">'
      +   '<div style="background:var(--bg);border:1px solid var(--border);border-left:3px solid var(--yellow);border-radius:6px;padding:14px 16px;font-size:12.5px;line-height:1.7;color:var(--text);margin-bottom:18px;">' + clause.text + '</div>'
      // Initial pad
      +   '<div class="tic-field-lbl" style="margin-bottom:6px;">Tenant Initials</div>'
      +   '<div class="sig-canvas-wrap">'
      +     '<div class="tab-bar">'
      +       '<button type="button" onclick="setSigMethod(\'po_init_' + idx + '\',\'canvas\')" id="po_init_' + idx + '_tab_canvas" class="tab-item active">&#9999;&#65039; Draw</button>'
      +       '<button type="button" onclick="setSigMethod(\'po_init_' + idx + '\',\'type\')"   id="po_init_' + idx + '_tab_type"   class="tab-item">&#9000;&#65039; Type</button>'
      +       '<button type="button" onclick="setSigMethod(\'po_init_' + idx + '\',\'wet\')"    id="po_init_' + idx + '_tab_wet"    class="tab-item">&#128396; Wet</button>'
      +     '</div>'
      +     '<div id="po_init_' + idx + '_panel_canvas" class="bg-paper">'
      +       '<canvas id="po_init_' + idx + '" width="400" height="70" style="width:100%;height:70px;display:block;touch-action:none;cursor:crosshair;"></canvas>'
      +       '<div style="display:flex;align-items:center;justify-content:space-between;padding:3px 10px;border-top:1px solid var(--border);">'
      +         '<span class="txt-xs-muted">Sign with finger or mouse</span>'
      +         '<button type="button" onclick="clearSig(\'po_init_' + idx + '\')" style="background:none;border:1px solid var(--border);border-radius:5px;padding:2px 8px;font-size:10px;color:var(--muted);cursor:pointer;font-family:DM Sans,sans-serif;">Clear</button>'
      +       '</div>'
      +     '</div>'
      +     '<div id="po_init_' + idx + '_panel_type" class="sec-hidden">'
      +       '<input type="text" id="po_init_' + idx + '_typed" placeholder="Type initials (e.g. LS)" style="width:100%;border:none;border-bottom:2px solid var(--dark);background:transparent;font-size:22px;font-family:Georgia,serif;font-style:italic;color:var(--text);outline:none;padding:4px 0;box-sizing:border-box;"/>'
      +       '<div style="font-size:10px;color:var(--muted);margin-top:6px;">Typing your initials constitutes a legal electronic acknowledgement</div>'
      +     '</div>'
      +     '<div id="po_init_' + idx + '_panel_wet" class="sec-hidden">'
      +       '<div style="font-size:11px;color:var(--muted);line-height:1.5;margin-bottom:8px;">Print this form and collect initials on paper, or use an e-signature service. Note the reference below.</div>'
      +       '<input type="text" id="po_init_' + idx + '_wet_ref" placeholder="Reference # (optional)" style="width:100%;padding:6px 9px;border:1px solid var(--border);border-radius:5px;font-size:12px;font-family:DM Sans,sans-serif;background:var(--surface);color:var(--text);box-sizing:border-box;"/>'
      +     '</div>'
      +   '</div>'
      + '</div>'
      // Footer nav
      + '<div style="padding:14px 22px;border-top:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;flex-shrink:0;">'
      +   (idx > 0
          ? '<button type="button" onclick="window._ticInitialSaveAndNav(' + idx + ',-1)" class="btn btn-ghost">&#8592; Back</button>'
          : '<div></div>')
      +   '<button type="button" onclick="window._ticInitialSaveAndNav(' + idx + ',1)" class="btn btn-primary">'
      +     (isLast ? '&#10003; Complete Initials' : 'Next &#8594;')
      +   '</button>'
      + '</div>'
      + '</div>';

    document.body.appendChild(pop);

    setTimeout(function() {
      if (typeof _initSigPad === 'function') _initSigPad('po_init_' + idx);
      // If there was a previously captured initial for this clause, show a note
      if (captured) {
        var statusEl = document.createElement('div');
        statusEl.style.cssText = 'font-size:11px;color:var(--success,#15803d);margin-top:8px;';
        statusEl.textContent = 'Previously captured — draw or type a new initial to replace.';
        var wrap = document.getElementById('po_init_' + idx + '_panel_canvas');
        if (wrap) wrap.parentNode.insertBefore(statusEl, wrap.nextSibling);
      }
    }, 80);
  }

  function _ticInitialSaveAndNav(idx, dir) {
    // Capture the current initial
    var canvasId = 'po_init_' + idx;
    var captured = '';
    if (typeof getSigDataURL === 'function') {
      captured = getSigDataURL(canvasId);
    }
    // Fall back to previously stored value if nothing new was drawn
    var clauses = _getEffectiveLeaseClauses();
    if (!captured) captured = _leaseInitials[clauses[idx].id] || '';

    if (captured) {
      _leaseInitials[clauses[idx].id] = captured;
    }

    var total   = clauses.length;
    var nextIdx = idx + dir;

    // Update the status button in the parent modal
    var doneCount = Object.keys(_leaseInitials).length;
    var statusEl  = document.getElementById('ls_initials_status');
    var btnEl     = document.getElementById('ls_initials_btn');
    if (statusEl) statusEl.textContent = doneCount + ' of ' + total + ' initials captured';
    if (btnEl) {
      btnEl.textContent = doneCount === total ? '✓ All Initials Complete' : 'Review & Initial →';
      btnEl.style.background = doneCount === total ? 'var(--success,#15803d)' : '';
    }

    if (nextIdx >= 0 && nextIdx < total) {
      // Navigate to next/prev clause
      var pop = document.getElementById('ls_initials_popout');
      if (pop) pop.remove();
      _ticOpenInitialsPopout(nextIdx);
    } else {
      // Done — close pop-out and return to main modal
      var pop = document.getElementById('ls_initials_popout');
      if (pop) pop.remove();
    }
  }
  // Capture the inline initials pads (ls_init_<i>) into _leaseInitials, keyed
  // by clause id so the PDF generators (which read _leaseInitials[clause.id])
  // and the draft snapshot stay unchanged. Called before any read of initials.
  function _ticCaptureInlineInitials() {
    var clauses = _getEffectiveLeaseClauses();
    clauses.forEach(function(c, i){
      var v = (typeof getSigDataURL === 'function') ? getSigDataURL('ls_init_' + i) : '';
      if (v) _leaseInitials[c.id] = v;
      // A cleared pad must also clear the captured copy — otherwise the
      // readiness gate still counts the stale initial and the PDF prints it.
      // Only clear when the pad EXISTS in the DOM (v === '' from a mounted,
      // empty pad); a missing pad (modal closed) must not wipe saved drafts.
      else if (document.getElementById('ls_init_' + i)) delete _leaseInitials[c.id];
    });
  }

  // ── Readiness gate ─────────────────────────────────────────────────────
  // Hard requirement: without a fixed-term end date the document would
  // print with a core term literally missing, so this alone still blocks.
  function _ticLeaseMissingHard() {
    var fv  = function(id){ var e=document.getElementById(id); return e ? (e.value||'').trim() : ''; };
    var isTemp = !!_LEASE_FIXED_TERM[_ticLeaseDocKey];
    var missing = [];
    if (isTemp && !fv('ls_end_date')) missing.push('End date (required for a fixed-term agreement)');
    return missing;
  }
  // Soft requirement: initials/signatures are often collected on paper or
  // added after an unsigned copy is printed — warn, but let staff proceed.
  function _ticLeaseMissingSigs() {
    _ticCaptureInlineInitials();
    var missing = [];
    var fv  = function(id){ var e=document.getElementById(id); return e ? (e.value||'').trim() : ''; };
    var sig = function(id){ return (typeof getSigDataURL==='function') ? getSigDataURL(id) : ''; };
    var clauses  = _getEffectiveLeaseClauses();
    var initDone = 0;
    clauses.forEach(function(c){ if (_leaseInitials[c.id]) initDone++; });
    if (clauses.length && initDone < clauses.length) {
      missing.push('Tenant initials (' + initDone + ' of ' + clauses.length + ' captured)');
    }
    if (!sig('ls_sig_tenant')) missing.push('Primary tenant signature');
    if (fv('ls_co_name') && document.getElementById('ls_sig_cotenant') && !sig('ls_sig_cotenant')) {
      missing.push('Co-tenant signature');
    }
    if (!sig('ls_sig_staff')) missing.push('Housing staff / landlord signature');
    return missing;
  }

  function _ticShowLeaseChecklist(items) {
    var existing = document.getElementById('ls_checklist_modal');
    if (existing) existing.remove();
    var rows = items.map(function(it){
      return '<div style="display:flex;align-items:flex-start;gap:9px;padding:8px 0;border-bottom:1px solid var(--border);">'
        + '<span style="color:var(--danger,#dc2626);font-size:14px;line-height:1.3;">&#9711;</span>'
        + '<span style="font-size:12.5px;color:var(--text);line-height:1.5;">' + _ticEsc(it) + '</span></div>';
    }).join('');
    var m = document.createElement('div');
    m.id = 'ls_checklist_modal';
    m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.72);z-index:10200;display:flex;align-items:center;justify-content:center;padding:16px;';
    m.innerHTML =
        '<div style="background:var(--surface);border-radius:12px;width:100%;max-width:440px;box-shadow:0 8px 40px rgba(0,0,0,.4);">'
      + '<div class="modal-hdr"><div>'
      +   '<div class="lbl-yellow">&#9888;&#65039; Not ready to generate</div>'
      +   '<div class="txt-sm-meta">Complete these before generating the agreement:</div>'
      + '</div></div>'
      + '<div style="padding:14px 22px 4px;">' + rows + '</div>'
      + '<div style="padding:14px 22px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;">'
      +   '<button type="button" onclick="document.getElementById(\'ls_checklist_modal\').remove()" class="btn btn-primary">Got it</button>'
      + '</div></div>';
    document.body.appendChild(m);
  }

  // Soft-check confirm for missing initials/signatures. Deliberately not the
  // generic showConfirm() — that renders at z-index 1100, which sits BEHIND
  // this modal's z-index 10000 and would be invisible/unclickable. Matches
  // _ticShowLeaseChecklist's z-index tier (10200) instead. Returns Promise<boolean>.
  function _ticConfirmMissingSigs(items) {
    return new Promise(function(resolve){
      var existing = document.getElementById('ls_sig_confirm_modal');
      if (existing) existing.remove();
      var rows = items.map(function(it){
        return '<div style="display:flex;align-items:flex-start;gap:9px;padding:8px 0;border-bottom:1px solid var(--border);">'
          + '<span style="color:var(--danger,#dc2626);font-size:14px;line-height:1.3;">&#9711;</span>'
          + '<span style="font-size:12.5px;color:var(--text);line-height:1.5;">' + _ticEsc(it) + '</span></div>';
      }).join('');
      var m = document.createElement('div');
      m.id = 'ls_sig_confirm_modal';
      m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.72);z-index:10200;display:flex;align-items:center;justify-content:center;padding:16px;';
      m.innerHTML =
          '<div style="background:var(--surface);border-radius:12px;width:100%;max-width:440px;box-shadow:0 8px 40px rgba(0,0,0,.4);">'
        + '<div class="modal-hdr"><div>'
        +   '<div class="lbl-yellow">&#9888;&#65039; Generate without all signatures?</div>'
        +   '<div class="txt-sm-meta">Missing:</div>'
        + '</div></div>'
        + '<div style="padding:14px 22px 4px;">' + rows + '</div>'
        + '<div style="padding:14px 22px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:10px;">'
        +   '<button type="button" data-sc-cancel class="btn btn-ghost">Cancel</button>'
        +   '<button type="button" data-sc-confirm class="btn btn-primary">Generate anyway</button>'
        + '</div></div>';
      document.body.appendChild(m);
      function close(ok){ if (m.parentNode) m.parentNode.removeChild(m); resolve(ok); }
      m.querySelector('[data-sc-cancel]').onclick  = function(){ close(false); };
      m.querySelector('[data-sc-confirm]').onclick = function(){ close(true); };
      m.addEventListener('click', function(e){ if (e.target === m) close(false); });
    });
  }

  // ── Draft persistence (survive close/reopen) ───────────────────────────
  function _ticLeaseDraftKey() {
    var u = _ticState.unit || {};
    return _ticLeaseDocKey + '|' + (u.id || '');
  }
  function _ticSnapshotLeaseDraft() {
    if (!document.getElementById('tic_lease_modal')) return;
    _ticCaptureInlineInitials();
    var sigs = {};
    ['ls_sig_tenant','ls_sig_cotenant','ls_sig_staff'].forEach(function(id){
      if (!document.getElementById(id) && !document.getElementById(id+'_typed')) return;
      var v = (typeof getSigDataURL==='function') ? getSigDataURL(id) : '';
      if (v) sigs[id] = v;
    });
    _leaseDraft[_ticLeaseDraftKey()] = {
      initials: JSON.parse(JSON.stringify(_leaseInitials || {})),
      sigs: sigs
    };
  }
  function _ticRestoreSig(id, val) {
    if (!val) return;
    if (val.indexOf('typed:') === 0) {
      var t = document.getElementById(id+'_typed');
      if (t) { t.value = val.slice(6); if (typeof setSigMethod==='function') setSigMethod(id,'type'); }
      return;
    }
    if (val.indexOf('wet:') === 0) {
      var w = document.getElementById(id+'_wet_ref');
      if (w) { var r = val.slice(4); w.value = (r==='pending' ? '' : r); if (typeof setSigMethod==='function') setSigMethod(id,'wet'); }
      return;
    }
    var canvas = document.getElementById(id);
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    var img = new Image();
    img.onload = function(){ ctx.drawImage(img, 0, 0, canvas.width, canvas.height); canvas.classList.add('has-sig'); };
    img.src = val;
  }
  function _ticCloseLeaseModal() {
    try { _ticSnapshotLeaseDraft(); } catch(e) { console.warn('[lease] draft snapshot failed:', e); }
    var m = document.getElementById('tic_lease_modal');
    if (m) m.remove();
  }

  // ── Modal ──────────────────────────────────────────────────────────────
  function _ticOpenLeaseModal(docKey) {
    // An agreement requires a linked unit — its address/details come from the
    // unit card. No unit = no agreement.
    if (!(_ticState.unit && _ticState.unit.id)) {
      if (typeof showToast === 'function') showToast('Assign a unit to this tenant before creating an agreement.', { type:'error' });
      return;
    }
    _ticLeaseDocKey = ({ temporary_lease:1, monthly_temp_lease:1, commercial_lease:1, replacement_contract:1 }[docKey]) ? docKey : 'residential_lease';
    var isTemp = !!_LEASE_FIXED_TERM[_ticLeaseDocKey];   // fixed-term docs need an end date
    var _docTitle   = _LEASE_TITLES[_ticLeaseDocKey] || 'Residential Lease Agreement';
    var _clauseList = _getEffectiveLeaseClauses();
    var _clauseN    = _clauseList.length;
    // Restore any captured initials/signatures from a prior open of THIS
    // agreement (keyed by docKey|unitId) so closing to check a detail is safe.
    var _draft = _leaseDraft[_ticLeaseDraftKey()];
    _leaseInitials = (_draft && _draft.initials) ? _draft.initials : {};
    var t   = _ticState.tenant      || {};
    var u   = _ticState.unit        || {};
    var app = _ticState.application || {};
    var l   = _ticState.ledger      || {};
    var today = new Date().toISOString().split('T')[0];

    var tenantName = t[TIC_C.full_name] || ((app.fn||'') + ' ' + (app.ln||'')).trim();
    var coName = '';
    if (app.hasCoApp && app.coApp) coName = ((app.coApp.fn||'') + ' ' + (app.coApp.ln||'')).trim();
    var emergRef = (app.references || [])[0] || {};
    var emerg = ((emergRef.fn||'') + ' ' + (emergRef.ln||'')).trim();
    if (emergRef.phone) emerg += (emerg ? ' ' : '') + emergRef.phone;
    var habitants = (app.habitants || []).filter(function(h){ return h && (h.fn || h.ln); });
    // Applicant details — prefer the application, fall back to the tenant record
    // so existing tenants (whose application may not be loaded) still prefill.
    var _has = function(v){ return v != null && v !== ''; };
    var tBand  = app.band  || t.band_number   || '';
    var tDob   = app.dob   || t.date_of_birth || '';
    var tPhone = app.phone || t.phone || '';
    var tEmail = app.email || t.email || '';
    // Rent must appear on EVERY agreement: ledger -> unit card -> tenant -> app.
    // Track the source so staff can see (and trust or override) where it came from.
    var rentAmt = '', rentSrc = '';
    if      (_has(l[TIC_C.monthly_rent]))  { rentAmt = String(l[TIC_C.monthly_rent]);  rentSrc = 'rent ledger'; }
    else if (u && _has(u.monthlyRent))     { rentAmt = String(u.monthlyRent);          rentSrc = 'unit card'; }
    else if (u && _has(u.monthly_rent))    { rentAmt = String(u.monthly_rent);         rentSrc = 'unit card'; }
    else if (t && _has(t.monthly_rent))    { rentAmt = String(t.monthly_rent);         rentSrc = 'tenant record'; }
    else if (app && _has(app.rentAmount))  { rentAmt = String(app.rentAmount);         rentSrc = 'application'; }
    else if (app && _has(app.rent))        { rentAmt = String(app.rent);               rentSrc = 'application'; }
    // Unit details come from the unit card.
    var bedBath = u
      ? [ (u.bedrooms ? String(u.bedrooms) + ' bed' : ''),
          (u.bathrooms && u.bathrooms !== '0' && u.bathrooms !== 'nan' ? String(u.bathrooms) + ' bath' : '') ]
          .filter(Boolean).join(' / ')
      : '';
    var startDate = t[TIC_C.lease_start_date] || t[TIC_C.move_in_date] || (u && u.assignedDate) || '';
    var endDate   = t[TIC_C.lease_end_date]   || '';
    // Homeownership / amortization prefill (Replacement Contract only). Home
    // value defaults from the unit's Insured / CMHC value; rate + term default
    // to the nation's standard homeownership terms (editable in the modal).
    var _amortValue = (u && (u.insuredValue || u.cmhcValue)) ? String(u.insuredValue || u.cmhcValue) : '';
    var _isReplacement = (_ticLeaseDocKey === 'replacement_contract');

    var existing = document.getElementById('tic_lease_modal');
    if (existing) existing.remove();

    function inp(id, val, ph, type) {
      return '<input id="' + id + '" type="' + (type||'text') + '" value="' + _ticEsc(val||'') + '" placeholder="' + _ticEsc(ph||'') + '" style="width:100%;padding:6px 9px;border:1px solid var(--border);border-radius:5px;font-size:12px;font-family:DM Sans,sans-serif;background:var(--surface);color:var(--text);box-sizing:border-box;"/>';
    }
    function fld(label, inputHtml) {
      return '<div class="tic-field"><label class="tic-field-lbl">' + label + '</label>' + inputHtml + '</div>';
    }
    function secH(title) {
      return '<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:var(--yellow);margin:16px 0 10px;padding-bottom:5px;border-bottom:1px solid var(--border);">' + title + '</div>';
    }
    function initPad(id, clauseText) {
      return '<div style="margin-bottom:14px;padding:10px 12px;background:var(--bg);border-radius:7px;border:1px solid var(--border);">'
        + '<div style="font-size:11px;color:var(--text);margin-bottom:8px;line-height:1.5;">' + clauseText + '</div>'
        + '<div class="tic-field-lbl" style="margin-bottom:5px;">Tenant Initials</div>'
        + '<div class="sig-canvas-wrap">'
        + '<div class="tab-bar">'
        + '<button type="button" onclick="setSigMethod(\'' + id + '\',\'canvas\')" id="' + id + '_tab_canvas" class="tab-item active">&#9999;&#65039; Draw</button>'
        + '<button type="button" onclick="setSigMethod(\'' + id + '\',\'type\')"   id="' + id + '_tab_type"   class="tab-item">&#9000;&#65039; Type</button>'
        + '<button type="button" onclick="setSigMethod(\'' + id + '\',\'wet\')"    id="' + id + '_tab_wet"    class="tab-item">&#128396; Wet</button>'
        + '</div>'
        + '<div id="' + id + '_panel_canvas" class="bg-paper"><canvas id="' + id + '" width="400" height="70" style="width:100%;height:70px;display:block;touch-action:none;cursor:crosshair;"></canvas>'
        + '<div style="display:flex;align-items:center;justify-content:space-between;padding:3px 10px;border-top:1px solid var(--border);">'
        + '<span class="txt-xs-muted">Sign with finger or mouse</span>'
        + '<button type="button" onclick="clearSig(\'' + id + '\')" style="background:none;border:1px solid var(--border);border-radius:5px;padding:2px 8px;font-size:10px;color:var(--muted);cursor:pointer;font-family:DM Sans,sans-serif;">Clear</button>'
        + '</div></div>'
        + '<div id="' + id + '_panel_type" class="sec-hidden"><input type="text" id="' + id + '_typed" placeholder="Type initials (e.g. JD)" style="width:100%;border:none;border-bottom:2px solid var(--dark);background:transparent;font-size:20px;font-family:Georgia,serif;font-style:italic;color:var(--text);outline:none;padding:4px 0;box-sizing:border-box;"/>'
        + '<div style="font-size:10px;color:var(--muted);margin-top:6px;">Typing your initials constitutes a legal electronic acknowledgement</div></div>'
        + '<div id="' + id + '_panel_wet" class="sec-hidden"><div style="font-size:11px;color:var(--muted);line-height:1.5;margin-bottom:8px;">Print this form, collect initials on paper, and note the reference below.</div>'
        + '<input type="text" id="' + id + '_wet_ref" placeholder="Reference # (optional)" style="width:100%;padding:6px 9px;border:1px solid var(--border);border-radius:5px;font-size:12px;font-family:DM Sans,sans-serif;background:var(--surface);color:var(--text);box-sizing:border-box;"/></div>'
        + '</div></div>';
    }
    function sigPad(id, label) {
      return '<div style="margin-bottom:14px;"><div class="tic-field-lbl" style="margin-bottom:6px;">' + label + '</div>'
        + '<div class="sig-canvas-wrap"><div class="tab-bar">'
        + '<button type="button" onclick="setSigMethod(\'' + id + '\',\'canvas\')" id="' + id + '_tab_canvas" class="tab-item active">&#9999;&#65039; Draw</button>'
        + '<button type="button" onclick="setSigMethod(\'' + id + '\',\'type\')"   id="' + id + '_tab_type"   class="tab-item">&#9000;&#65039; Type</button>'
        + '<button type="button" onclick="setSigMethod(\'' + id + '\',\'wet\')"    id="' + id + '_tab_wet"    class="tab-item">&#128396; Wet</button>'
        + '</div>'
        + '<div id="' + id + '_panel_canvas" class="bg-paper"><canvas id="' + id + '" width="600" height="90" style="width:100%;height:90px;display:block;touch-action:none;cursor:crosshair;"></canvas>'
        + '<div style="display:flex;align-items:center;justify-content:space-between;padding:4px 10px;border-top:1px solid var(--border);">'
        + '<span class="txt-xs-muted">Sign with finger or mouse</span>'
        + '<button type="button" onclick="clearSig(\'' + id + '\')" style="background:none;border:1px solid var(--border);border-radius:5px;padding:2px 8px;font-size:10px;color:var(--muted);cursor:pointer;font-family:DM Sans,sans-serif;">Clear</button>'
        + '</div></div>'
        + '<div id="' + id + '_panel_type" class="sec-hidden"><input type="text" id="' + id + '_typed" placeholder="Type full legal name" style="width:100%;border:none;border-bottom:2px solid var(--dark);background:transparent;font-size:18px;font-family:Georgia,serif;font-style:italic;color:var(--text);outline:none;padding:4px 0;box-sizing:border-box;"/>'
        + '<div style="font-size:10px;color:var(--muted);margin-top:6px;">Typing your name constitutes a legal electronic signature</div></div>'
        + '<div id="' + id + '_panel_wet" class="sec-hidden"><div style="font-size:11px;color:var(--muted);line-height:1.5;margin-bottom:8px;">Print this form and collect a wet signature, or use an e-signature service and attach the signed copy to this tenant\'s file.</div>'
        + '<input type="text" id="' + id + '_wet_ref" placeholder="Reference # or e-sign envelope ID (optional)" style="width:100%;padding:6px 9px;border:1px solid var(--border);border-radius:5px;font-size:12px;font-family:DM Sans,sans-serif;background:var(--surface);color:var(--text);box-sizing:border-box;"/></div>'
        + '</div></div>';
    }

    // Authorized occupants come straight from the application's household
    // members (no editable Schedule A section in the form); the generator reads
    // _ticState.application.habitants directly into the occupant tokens.

    var modal = document.createElement('div');
    modal.id = 'tic_lease_modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.72);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px;';
    modal.innerHTML =
        '<div style="background:var(--surface);border-radius:12px;width:100%;max-width:700px;max-height:95vh;display:flex;flex-direction:column;box-shadow:0 8px 40px rgba(0,0,0,.35);">'
      + '<div class="modal-hdr"><div>'
      +   '<div class="lbl-yellow">&#128209; '+((window.NATION_CONFIG&&window.NATION_CONFIG.short)||'')+' '+_ticEsc(_docTitle)+'</div>'
      +   '<div class="txt-sm-meta">Review pre-filled details, collect all initials and signatures, then generate.</div>'
      + '</div><button type="button" onclick="window._ticCloseLeaseModal && window._ticCloseLeaseModal()" style="background:none;border:none;font-size:22px;cursor:pointer;color:var(--muted);">&times;</button></div>'
      + '<div style="overflow-y:auto;padding:18px 22px;flex:1;">'

      + secH('Parties &amp; Dates')
      + '<div class="tic-grid-2">'
      + fld('Execution Date',           inp('ls_exec_date',  today,                '', 'date'))
      + fld('Lease Start Date',         inp('ls_start_date', startDate,            '', 'date'))
      + fld(isTemp ? 'End Date (required)' : 'Lease End Date', inp('ls_end_date', endDate, isTemp ? 'Fixed-term end date' : 'Leave blank if month-to-month', 'date'))
      + fld('Primary Tenant Name',      inp('ls_t_name',     tenantName,           'Full legal name'))
      + fld('Co-Tenant Name',           inp('ls_co_name',    coName,               'Leave blank if none'))
      + fld('Band Membership #',        inp('ls_t_band',     tBand,                'Band number'))
      + fld('Date of Birth (Primary)',  inp('ls_t_dob',      tDob,                 'YYYY-MM-DD', 'date'))
      + fld('Telephone',                inp('ls_t_phone',    tPhone,               'Phone'))
      + fld('Email',                    inp('ls_t_email',    tEmail,               'Email'))
      + fld('Emergency Contact',        inp('ls_t_emerg',    emerg,                'Name and phone'))
      + fld('Lot Number',               inp('ls_r_lot',      u.num||'',            'Lot'))
      + fld('Street Name',              inp('ls_r_street',   u.street||'',         'Street'))
      + fld('Bedrooms / Bathrooms',     inp('ls_r_bed',      bedBath,              'e.g. 3 bed / 1 bath'))
      + fld('Funding Stream',           inp('ls_r_stream',   t[TIC_C.housing_stream]||'', 'e.g. Section 95'))
      + fld('Allocation Date',          inp('ls_r_alloc',    t[TIC_C.move_in_date]||u.assignedDate||'', '', 'date'))
      + '<div class="tic-field"><label class="tic-field-lbl">Monthly Rent ($)</label>' + inp('ls_rent', rentAmt, '0.00')
      +   (rentSrc
            ? '<div style="font-size:10px;color:var(--muted);margin-top:3px;">Prefilled from ' + rentSrc + ' &mdash; edit if incorrect</div>'
            : '<div style="font-size:10px;color:var(--danger,#dc2626);margin-top:3px;">No rent on file &mdash; enter the monthly rent</div>')
      + '</div>'
      + '</div>'

      + (_isReplacement
          ? secH('Homeownership &amp; Amortization (optional)')
            + '<div style="font-size:11px;color:var(--muted);margin-bottom:10px;">Fill these in to append a <strong>Schedule B &mdash; Amortization Schedule</strong> to the contract. The monthly payment equals the <strong>Monthly Rent</strong> entered above &mdash; the payoff period is calculated from the financed amount, interest rate, and that rent. Enter a <strong>Last Payment Date</strong> to show payments made to date and flag any overpayment. Leave the Home Value blank to omit the schedule.</div>'
            + '<div class="tic-grid-2">'
            + fld('Home Value ($)',            inp('ls_amort_value', _amortValue, '0.00'))
            + fld('Down Payment ($)',          inp('ls_amort_down',  '',          '0.00'))
            + fld('Annual Interest Rate (%)',  inp('ls_amort_rate',  '3',         'e.g. 3.00'))
            + fld('First Payment Date',        inp('ls_amort_first', startDate,   '', 'date'))
            + fld('Last Payment Date (optional)', inp('ls_amort_last', '',        'Date of most recent payment', 'date'))
            + '</div>'
          : '')

      + secH('Required Initials')
      + '<div style="font-size:11px;color:var(--muted);margin-bottom:12px;">The tenant initials each required clause below. Every clause must be initialed before the agreement can be generated.</div>'
      + (_clauseN
          ? _clauseList.map(function(c, i){
              return '<div style="margin-bottom:16px;">'
                + '<div style="font-size:11px;font-weight:700;color:var(--text);margin-bottom:6px;">' + (i+1) + '. ' + _ticEsc(c.label || c.id || ('Clause ' + (i+1))) + '</div>'
                + initPad('ls_init_' + i, c.text || '')
                + '</div>';
            }).join('')
          : '<div style="font-size:11px;color:var(--muted);margin-bottom:12px;">No required initials for this agreement.</div>')

      + secH('Signatures')
      + sigPad('ls_sig_tenant', 'Primary Tenant Signature')
      + (coName ? sigPad('ls_sig_cotenant', 'Co-Tenant Signature') : '')
      + sigPad('ls_sig_staff', 'Housing Staff / Landlord Signature')

      + '</div>'
      + '<div style="padding:14px 22px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:10px;flex-shrink:0;">'
      + '<button type="button" onclick="window._ticCloseLeaseModal && window._ticCloseLeaseModal()" class="btn btn-ghost">Cancel</button>'
      + '<button type="button" onclick="window._ticGenerateLeasePdf && window._ticGenerateLeasePdf()" class="btn btn-primary">Generate PDF</button>'
      + '</div>'
      + '</div>';

    document.body.appendChild(modal);
    var toInit = ['ls_sig_tenant','ls_sig_staff'];
    if (coName) toInit.push('ls_sig_cotenant');
    _clauseList.forEach(function(c, i){ toInit.push('ls_init_' + i); });
    setTimeout(function() {
      if (typeof _initSigPad === 'function') toInit.forEach(function(id){ _initSigPad(id); });
      // Re-apply signatures + initials captured before a close/reopen of this
      // agreement. Signatures are keyed by pad id; initials are stored by
      // clause id, so map each clause back to its inline pad (ls_init_<i>).
      if (_draft && _draft.sigs) {
        Object.keys(_draft.sigs).forEach(function(id){ _ticRestoreSig(id, _draft.sigs[id]); });
      }
      if (_draft && _draft.initials) {
        _clauseList.forEach(function(c, i){
          if (_draft.initials[c.id]) _ticRestoreSig('ls_init_' + i, _draft.initials[c.id]);
        });
      }
    }, 80);
  }

  // ── Data save-back ────────────────────────────────────────────────────
  async function _ticLeaseSaveChanges() {
    var app = _ticState.application;
    var t   = _ticState.tenant || {};
    var l   = _ticState.ledger || {};
    var fv  = function(id){ var e=document.getElementById(id); return e ? (e.value||'').trim() : ''; };

    if (app && app.id) {
      // Occupants are no longer edited on this form (no Schedule A section) —
      // they live on the application, so we leave app.habitants untouched.
      var coFull = fv('ls_co_name');
      if (coFull) {
        app.hasCoApp = true;
        if (!app.coApp) app.coApp = {};
        var cp = coFull.split(/\s+/);
        app.coApp.fn = cp[0]||''; app.coApp.ln = cp.slice(1).join(' ')||'';
      }
      var nPhone=fv('ls_t_phone'), nEmail=fv('ls_t_email'), nDob=fv('ls_t_dob'), nBand=fv('ls_t_band');
      if (nPhone) app.phone = nPhone;
      if (nEmail) app.email = nEmail;
      if (nDob)   app.dob   = nDob;
      if (nBand)  app.band  = nBand;
      try { await _ticPersistApplication(); } catch(e) { console.warn('[lease] app persist failed:', e); }
    }

    var pk = t[TIC_C.tenant_pk];
    if (pk) {
      var tPatch = {};
      var nStream = fv('ls_r_stream');
      var nMovein = fv('ls_r_alloc');
      var nLeaseStart = fv('ls_start_date');
      var nLeaseEnd   = fv('ls_end_date') || null;
      if (nStream     && nStream     !== (t[TIC_C.housing_stream]  ||'')) { tPatch[TIC_C.housing_stream]   = nStream;     t[TIC_C.housing_stream]   = nStream; }
      if (nMovein     && nMovein     !== (t[TIC_C.move_in_date]    ||'')) { tPatch[TIC_C.move_in_date]     = nMovein;     t[TIC_C.move_in_date]     = nMovein; }
      if (nLeaseStart && nLeaseStart !== (t[TIC_C.lease_start_date]||'')) { tPatch[TIC_C.lease_start_date] = nLeaseStart; t[TIC_C.lease_start_date] = nLeaseStart; }
      if (nLeaseEnd !== (t[TIC_C.lease_end_date]||null))                  { tPatch[TIC_C.lease_end_date]   = nLeaseEnd;   t[TIC_C.lease_end_date]   = nLeaseEnd; }
      if (Object.keys(tPatch).length) {
        try { await _ticWrite('PATCH', TIC_T.tenants+'?'+TIC_C.tenant_pk+'=eq.'+encodeURIComponent(pk), tPatch); }
        catch(e) { console.warn('[lease] tenant patch failed:', e); }
      }
    }

    if (l.id) {
      var nRent = parseFloat(fv('ls_rent'));
      if (!isNaN(nRent) && nRent !== Number(l[TIC_C.monthly_rent])) {
        try {
          await _ticWrite('PATCH', TIC_T.rent_ledger+'?id=eq.'+encodeURIComponent(l.id), { monthly_rent: nRent });
          _ticState.ledger[TIC_C.monthly_rent] = nRent;
        } catch(e) { console.warn('[lease] rent patch failed:', e); }
      }
    }

    if (typeof _ticRenderOverview  === 'function') _ticRenderOverview();
    if (typeof _ticRenderOccupants === 'function') _ticRenderOccupants();
    if (typeof _ticRenderStrip     === 'function') _ticRenderStrip();
  }

  // ── Money + amortization helpers (Replacement Contract, Schedule B) ──────
  function _ticMoney(v){
    if (typeof formatCurrency === 'function') return formatCurrency(v);
    return '$' + (Number(v)||0).toLocaleString('en-CA', { minimumFractionDigits:2, maximumFractionDigits:2 });
  }
  function _ticEnsureAutoTable(){
    return new Promise(function(resolve){
      try { if (window.jspdf && window.jspdf.jsPDF && typeof (new window.jspdf.jsPDF()).autoTable === 'function') { resolve(true); return; } } catch(e){}
      var s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.5.31/jspdf.plugin.autotable.min.js';
      s.onload  = function(){ resolve(true); };
      s.onerror = function(){ resolve(false); };
      document.head.appendChild(s);
    });
  }
  // Build a monthly amortization schedule where the MONTHLY PAYMENT EQUALS THE
  // RENT (the rent the tenant pays is applied to the home purchase). The payoff
  // period is derived from the financed amount, interest rate, and that rent —
  // it is not a fixed term. No-op unless a home value AND a rent are present.
  async function _ticRenderAmortSchedule(ctx){
    var fv  = function(id){ var e=document.getElementById(id); return e ? (e.value||'').trim() : ''; };
    var num = function(id){ var v=parseFloat((fv(id)||'').replace(/[^0-9.\-]/g,'')); return isNaN(v)?0:v; };
    var pdf = ctx.pdf;
    // Instead of silently omitting the schedule when an input is missing, print
    // a visible "Schedule B" note explaining what to fill in — so staff can see
    // why the table did not appear.
    function _amortNote(msg){
      ctx.needSpace(22); ctx.gap(8);
      if (typeof ctx.sectionHeader === 'function') ctx.sectionHeader('Schedule B — Amortization Schedule');
      pdf.setFont('helvetica','normal'); pdf.setFontSize(9); pdf.setTextColor(150,30,30);
      var l = pdf.splitTextToSize(msg, ctx.contentW);
      pdf.text(l, ctx.marginL, ctx.y + 4); ctx.y += l.length * 4 + 6; pdf.setTextColor(0);
    }
    var value   = num('ls_amort_value');
    var down    = num('ls_amort_down');
    var rate    = num('ls_amort_rate');         // annual %
    var payment = num('ls_rent');               // monthly payment == the rent
    var first   = fv('ls_amort_first');
    var lastPay = fv('ls_amort_last');
    var principal = value - down;
    if (value <= 0)    { _amortNote('Amortization schedule omitted: enter a Home Value in the "Homeownership & Amortization" section of the form to generate Schedule B.'); return; }
    if (payment <= 0)  { _amortNote('Amortization schedule omitted: no Monthly Rent was entered. The rent is used as the monthly payment — enter it to generate Schedule B.'); return; }
    if (principal <= 0){ _amortNote('Amortization schedule omitted: the down payment is greater than or equal to the home value, so there is nothing to amortize.'); return; }
    var mr = rate > 0 ? (rate/100/12) : 0;

    // Social housing program: the rent is a subsidized contribution. When it
    // does not cover the monthly carrying cost (interest) the un-recovered
    // value grows — that end-of-term value is the cost to the community.
    var firstInterest = mr > 0 ? principal * mr : 0;
    var subsidized = payment < firstInterest - 0.005;

    // Build the schedule for the full 25-year (300-payment) term, or until the
    // home value is fully recovered if that happens sooner. The payment column
    // always equals the rent.
    var startD = first   ? new Date(first   + 'T12:00:00') : null;
    var lastD  = lastPay ? new Date(lastPay + 'T12:00:00') : null;
    // Monthly payments made from the first payment date through the last payment
    // date (inclusive). 0 when no last payment date is entered.
    var paymentsMade = (startD && lastD)
      ? Math.max(0, (lastD.getFullYear()-startD.getFullYear())*12 + (lastD.getMonth()-startD.getMonth()) + 1)
      : 0;

    var MONTHS_25Y = 300;
    var body = [], bal = principal, cumInt = 0, totalRent = 0, n = 0, paidOff = false;
    var payoffMonth = 0, payoffPayment = 0, balAtLast = null;
    while (n < MONTHS_25Y){
      var interest = mr > 0 ? bal * mr : 0;
      var princ = payment - interest;            // negative when rent < carrying cost
      if (princ >= bal){ princ = bal; bal = 0; paidOff = true; }  // final payment
      else { bal = bal - princ; }                // princ < 0 -> value not recovered grows
      cumInt += interest;
      totalRent += (princ + interest);           // rent actually collected this month
      var dLbl = '';
      if (startD){ var dd = new Date(startD.getFullYear(), startD.getMonth() + n, 1); dLbl = dd.toLocaleString('en-CA', { month:'short', year:'numeric' }); }
      body.push([ String(n+1), dLbl, rate.toFixed(2)+'%', _ticMoney(princ+interest), _ticMoney(princ), _ticMoney(interest), _ticMoney(bal), _ticMoney(cumInt) ]);
      n++;
      if (paymentsMade && n === paymentsMade) balAtLast = bal;    // scheduled balance after payments made
      if (paidOff){ payoffMonth = n; payoffPayment = princ + interest; break; }
    }
    var remaining = bal;                          // value at end of term = cost to community

    // ── Payments-to-date / overpayment analysis (needs a Last Payment Date) ──
    var totalPaidToDate = 0, overpaid = 0, owingAtLast = 0;
    if (paymentsMade > 0){
      totalPaidToDate = paymentsMade * payment;
      if (paidOff && paymentsMade >= payoffMonth){
        // Amount required to fully own = every scheduled payment up to payoff
        // (the final one is a smaller partial payment).
        var requiredToOwn = (payoffMonth - 1) * payment + payoffPayment;
        overpaid = totalPaidToDate - requiredToOwn;
        if (overpaid < 0.005) overpaid = 0;
      } else {
        // Not yet paid off by the last payment date -> still owing the scheduled balance.
        owingAtLast = (balAtLast != null) ? balAtLast : remaining;
      }
    }

    ctx.needSpace(40); ctx.gap(8);
    if (typeof ctx.sectionHeader === 'function') ctx.sectionHeader('Schedule B — Social Housing Cost Schedule (25-Year Term)');
    pdf.setFont('helvetica','normal'); pdf.setFontSize(8.5); pdf.setTextColor(60);
    var summary = 'Home value ' + _ticMoney(value)
      + (down>0 ? '   Down payment ' + _ticMoney(down) : '')
      + '   Community carrying rate ' + rate.toFixed(2) + '%'
      + '   Monthly rent (subsidized contribution) ' + _ticMoney(payment);
    var sLines = pdf.splitTextToSize(summary, ctx.contentW);
    pdf.text(sLines, ctx.marginL, ctx.y + 3); ctx.y += sLines.length * 4 + 4; pdf.setTextColor(0);

    // Social-housing framing note.
    pdf.setFont('helvetica','normal'); pdf.setFontSize(8.5); pdf.setTextColor(80);
    var intro = subsidized
      ? 'This is a social housing program. The monthly rent is a subsidized contribution that is applied against the home value and the community\'s carrying cost over the 25-year term. Because the rent is set below the full carrying cost, the community subsidizes the difference; the value still owing at the end of the term is the cost to the community.'
      : 'This is a social housing program. The monthly rent is applied against the home value and the community\'s carrying cost over the 25-year term. The value still owing at the end of the term is the cost to the community.';
    var iLines = pdf.splitTextToSize(intro, ctx.contentW);
    ctx.needSpace(iLines.length * 4 + 4);
    pdf.text(iLines, ctx.marginL, ctx.y + 3); ctx.y += iLines.length * 4 + 5; pdf.setTextColor(0);

    // Cost-to-the-community summary block (the headline figures).
    var termLbl = paidOff ? (Math.floor(n/12) + ' yr ' + (n%12) + ' mo — value fully recovered') : '25 years (300 payments)';
    var rows2 = [
      ['Home value (start of term)',              _ticMoney(value)],
      ['Rent collected over the term',            _ticMoney(totalRent) + '  (' + n + ' payments)'],
      ['Community carrying cost over the term',   _ticMoney(cumInt)],
      ['Value at end of term (COST TO COMMUNITY)', _ticMoney(remaining)]
    ];
    pdf.setFontSize(9);
    for (var ri = 0; ri < rows2.length; ri++){
      var bold = (ri === rows2.length - 1);
      ctx.needSpace(6);
      pdf.setFont('helvetica', bold ? 'bold' : 'normal'); pdf.setTextColor(bold ? 20 : 60);
      pdf.text(rows2[ri][0], ctx.marginL + 2, ctx.y + 4);
      pdf.text(rows2[ri][1], ctx.marginL + ctx.contentW, ctx.y + 4, { align: 'right' });
      ctx.y += 5.5;
    }
    ctx.y += 2; pdf.setFont('helvetica','normal'); pdf.setTextColor(0);

    // ── Payments Made to Date (only when a Last Payment Date is entered) ──────
    if (paymentsMade > 0){
      ctx.needSpace(26); ctx.gap(3);
      pdf.setFont('helvetica','bold'); pdf.setFontSize(9.5); pdf.setTextColor(20);
      pdf.text('Payments Made to Date', ctx.marginL, ctx.y + 4); ctx.y += 6.5;
      var lastLbl = lastD ? lastD.toLocaleString('en-CA', { month:'long', year:'numeric' }) : '';
      var rows3 = [
        ['Payments made (through ' + lastLbl + ')', String(paymentsMade)],
        ['Total paid to date',                      _ticMoney(totalPaidToDate)]
      ];
      var _emph;   // index of the row to emphasize
      if (paidOff && paymentsMade >= payoffMonth){
        rows3.push(['Home fully paid at payment #',   String(payoffMonth)]);
        rows3.push([ overpaid > 0 ? 'OVERPAYMENT (paid beyond full value)' : 'Paid exactly in full',
                     _ticMoney(overpaid) ]);
        _emph = rows3.length - 1;
      } else {
        rows3.push(['Balance still owing as of last payment', _ticMoney(owingAtLast)]);
        _emph = rows3.length - 1;
      }
      pdf.setFontSize(9);
      for (var qi = 0; qi < rows3.length; qi++){
        var qEmph = (qi === _emph);
        ctx.needSpace(6);
        pdf.setFont('helvetica', qEmph ? 'bold' : 'normal');
        // Amber for an overpayment, dark for everything else.
        if (qEmph && overpaid > 0) pdf.setTextColor(176, 108, 0);
        else pdf.setTextColor(qEmph ? 20 : 60);
        pdf.text(rows3[qi][0], ctx.marginL + 2, ctx.y + 4);
        pdf.text(rows3[qi][1], ctx.marginL + ctx.contentW, ctx.y + 4, { align: 'right' });
        ctx.y += 5.5;
      }
      ctx.y += 3; pdf.setFont('helvetica','normal'); pdf.setTextColor(0);
    }

    // ── Table (drawn with plain jsPDF primitives — no external library) ──────
    // Columns: #, Date, Rate, Payment, Principal, Interest, Balance, Cum. Int.
    var colW     = [9, 22, 14, 25, 25, 24, 30, 30];
    var colAlign = ['center','left','center','right','right','right','right','right'];
    var colHdr   = ['#','Date','Rate','Payment','Principal','Interest','Balance','Cum. Int.'];
    var tableW = 0, colLeft = [], _acc = ctx.marginL, ci;
    for (ci = 0; ci < colW.length; ci++) { colLeft[ci] = _acc; _acc += colW[ci]; tableW += colW[ci]; }
    var colX = function(c){ return colAlign[c]==='center' ? colLeft[c]+colW[c]/2 : colAlign[c]==='right' ? colLeft[c]+colW[c]-1.5 : colLeft[c]+1.5; };
    var colOpt = function(c){ return colAlign[c]==='center' ? {align:'center'} : colAlign[c]==='right' ? {align:'right'} : undefined; };
    var rowH = 4.2;
    function _drawAmortHead(){
      ctx.needSpace(6);
      pdf.setFillColor(40,40,40); pdf.rect(ctx.marginL, ctx.y, tableW, 5, 'F');
      pdf.setFont('helvetica','bold'); pdf.setFontSize(7); pdf.setTextColor(255);
      for (var c=0;c<colHdr.length;c++) pdf.text(colHdr[c], colX(c), ctx.y+3.4, colOpt(c));
      ctx.y += 5; pdf.setTextColor(0);
    }
    _drawAmortHead();
    for (var r=0;r<body.length;r++){
      var _pg = ctx.pageNum;
      ctx.needSpace(rowH);
      if (ctx.pageNum !== _pg) _drawAmortHead();       // repeat the header on each new page
      if (r % 2 === 1){ pdf.setFillColor(246,246,246); pdf.rect(ctx.marginL, ctx.y, tableW, rowH, 'F'); }
      pdf.setFont('helvetica','normal'); pdf.setFontSize(7); pdf.setTextColor(45);
      for (var c2=0;c2<colHdr.length;c2++){ var cell = body[r][c2]; pdf.text(String(cell==null?'':cell), colX(c2), ctx.y+2.9, colOpt(c2)); }
      ctx.y += rowH;
    }
    // Closing highlighted row: the value at end of term = cost to the community.
    ctx.needSpace(8);
    pdf.setFillColor(window._themeAccentHex()); pdf.rect(ctx.marginL, ctx.y, tableW, 6, 'F');
    pdf.setFont('helvetica','bold'); pdf.setFontSize(8); pdf.setTextColor(20);
    var _closeMsg = paidOff
      ? ('HOME VALUE FULLY RECOVERED AT PAYMENT ' + n + ' - COST TO COMMUNITY ' + _ticMoney(0))
      : ('VALUE AT END OF 25-YEAR TERM - COST TO THE COMMUNITY: ' + _ticMoney(remaining));
    pdf.text(_closeMsg, ctx.marginL + tableW/2, ctx.y+4, {align:'center'});
    ctx.y += 6 + 6; pdf.setFont('helvetica','normal'); pdf.setTextColor(0);
  }

  // ── PDF generator ─────────────────────────────────────────────────────
  // Sets the linked application's street address to the assigned unit's
  // address (unit wins). Fired when the occupancy agreement is generated;
  // no-op when they already match, no unit/application is linked, or the
  // application is commercial (business address stays).
  function _ticSyncTenantAddressToUnit(){
    var app  = _ticState.application;
    var unit = _ticState.unit;
    if(!app || !unit) return;
    if((app.appType || app.app_type) === 'commercial') return;
    var addr = ((unit.num||'') + ' ' + (unit.street||'')).trim();
    if(!addr || (app.street||'').trim() === addr) return;
    var prev = app.street || '(blank)';
    app.street = addr;
    app.assignedAddress = addr;
    _ticPersistApplication()
      .then(function(){
        _ticAudit('app_address_merged', 'Address set to assigned unit: "' + prev + '" → "' + addr + '" (occupancy agreement generated; unit wins)');
      })
      .catch(function(e){ console.warn('[lease] address persist failed:', e); });
  }

  async function _ticGenerateLeasePdf() {
    // Hard gate — don't generate with a core term (fixed-term end date)
    // literally missing from the document.
    var _missingHard = _ticLeaseMissingHard();
    if (_missingHard.length) { _ticShowLeaseChecklist(_missingHard); return; }
    // Initials/signatures are a soft check — often collected on paper or
    // added after an unsigned copy is printed. Warn, but let staff proceed.
    var _missingSigs = _ticLeaseMissingSigs();
    if (_missingSigs.length) {
      var _go = await _ticConfirmMissingSigs(_missingSigs);
      if (!_go) return;
    }

    if (typeof showToast === 'function') showToast('Saving changes and generating PDF...', {type:'info'});

    try { await _ticLeaseSaveChanges(); } catch(e) { console.warn('[lease] save-back failed:', e); }
    // The agreement makes the tenancy official — the tenant's street address
    // follows the unit (unit wins; street line only, same convention as the
    // assignment write-back + reconcile merge). Covers tenancies assigned
    // before the automatic write-back existed.
    try { _ticSyncTenantAddressToUnit(); } catch(e) { console.warn('[lease] address sync failed:', e); }

    var fv  = function(id){ var e=document.getElementById(id); return e ? (e.value||'').trim() : ''; };
    var sig = function(id){ return (typeof getSigDataURL==='function') ? getSigDataURL(id) : ''; };

    var execDate  = fv('ls_exec_date');
    var d = execDate ? new Date(execDate+'T12:00:00') : null;
    var execDay   = d ? String(d.getDate()) : '';
    var execMonth = d ? d.toLocaleString('en-CA',{month:'long'}) : '';
    var execYear  = d ? String(d.getFullYear()) : '';

    // Authorized occupants come from the application's household members.
    var _occ = ((_ticState.application && _ticState.application.habitants) || []).filter(function(h){ return h && (h.fn || h.ln); });
    var _occName = function(i){ return _occ[i] ? ((_occ[i].fn||'') + ' ' + (_occ[i].ln||'')).trim() : ''; };
    var _occRel  = function(i){ return _occ[i] ? (_occ[i].relationship || '') : ''; };

    // Lease-start date broken into day / month / year. For the Replacement
    // Contract the "Rental Agreement made as of the __ day of __" line reflects
    // the ORIGINAL agreement date (the lease start), not today's execution date.
    var _sd = fv('ls_start_date') ? new Date(fv('ls_start_date') + 'T12:00:00') : null;
    var startDay   = _sd ? String(_sd.getDate()) : '';
    var startMonth = _sd ? _sd.toLocaleString('en-CA', { month:'long' }) : '';
    var startYear  = _sd ? String(_sd.getFullYear()) : '';

    var tokens = {
      nationName:             (window.NATION_CONFIG && NATION_CONFIG.display_name) || 'Housing Authority',
      nationShort:            (window.NATION_CONFIG && NATION_CONFIG.short) || '',
      executionDay:           execDay,
      executionMonth:         execMonth,
      executionYear:          execYear,
      startDay:               startDay,
      startMonth:             startMonth,
      startYear:              startYear,
      termStartDate:          fv('ls_start_date'),
      termEndDate:            fv('ls_end_date'),
      termEndDateOrOpen:      fv('ls_end_date') || 'Open-ended (month-to-month, no fixed end date)',
      contactPerson:          (_ticState.tenant && (_ticState.tenant.contact_person || _ticState.tenant.contactPerson)) || '',
      tenantName:             fv('ls_t_name'),
      coTenantName:           fv('ls_co_name'),
      tenantBandNumber:       fv('ls_t_band'),
      tenantDOB:              fv('ls_t_dob'),
      tenantPhone:            fv('ls_t_phone'),
      tenantEmail:            fv('ls_t_email'),
      tenantEmergencyContact: fv('ls_t_emerg'),
      residenceLot:           fv('ls_r_lot'),
      residenceStreet:        fv('ls_r_street'),
      residenceBedBath:       fv('ls_r_bed'),
      residenceStream:        fv('ls_r_stream'),
      residenceAllocDate:     fv('ls_r_alloc'),
      rentAmount:             fv('ls_rent'),
      homeValue:              (function(){ var v=parseFloat((fv('ls_amort_value')||'').replace(/[^0-9.]/g,'')); return (!isNaN(v)&&v>0) ? _ticMoney(v) : '$______________'; })(),
      downPayment:            (function(){ var v=parseFloat((fv('ls_amort_down')||'').replace(/[^0-9.]/g,'')); return (!isNaN(v)&&v>0) ? _ticMoney(v) : ''; })(),
      downPaymentClause:      (function(){ var v=parseFloat((fv('ls_amort_down')||'').replace(/[^0-9.]/g,'')); return (!isNaN(v)&&v>0) ? ' (with a down payment of ' + _ticMoney(v) + ')' : ''; })(),
      landlordName:           (_ticState.tenant ? (_ticState.tenant.approved_by || '') : ''),
      occupant1Name:          _occName(0), occupant2Name: _occName(1),
      occupant3Name:          _occName(2), occupant4Name: _occName(3),
      occupant5Name:          _occName(4), occupant6Name: _occName(5),
      occupant1Relationship:  _occRel(0),  occupant2Relationship: _occRel(1),
      occupant3Relationship:  _occRel(2),  occupant4Relationship: _occRel(3),
      occupant5Relationship:  _occRel(4),  occupant6Relationship: _occRel(5)
    };

    // ── jsPDF path — used when a contract body has been saved in Settings ─
    var savedBody = (typeof getContractBody === 'function') ? getContractBody(_ticLeaseDocKey) : '';
    if (savedBody && savedBody.trim()) {
      try {
        if (typeof _loadJsPdf === 'function') await _loadJsPdf();
        var logoDataUrl = (typeof _fetchLogoForPdf === 'function') ? await _fetchLogoForPdf() : null;
        var ctx = _makePdfDoc({
          nationName:     tokens.nationName,
          headerTitle:    _LEASE_TITLES[_ticLeaseDocKey] || 'Residential Lease Agreement',
          headerSubtitle: ['Tenant: ' + tokens.tenantName, tokens.residenceStreet].filter(Boolean).join('  —  '),
          logoDataUrl:    logoDataUrl
        });
        var pdf = ctx.pdf;

        // Substitute tokens then render HTML blocks
        var substituted = (typeof _substitutePlaceholders === 'function')
          ? _substitutePlaceholders(savedBody, tokens) : savedBody;
        var blocks = (typeof _parseHtmlToBlocks === 'function')
          ? _parseHtmlToBlocks(substituted) : [];
        if (typeof _renderBlocksToPdf === 'function') _renderBlocksToPdf(ctx, blocks);

        // Amortization schedule (Replacement Contract, Schedule B) — appended
        // after the agreement body, before the signature blocks.
        if (_ticLeaseDocKey === 'replacement_contract') {
          try { await _ticRenderAmortSchedule(ctx); } catch(e){ console.warn('[lease] amort schedule failed:', e); }
        }

        // Signatures section
        ctx.needSpace(50); ctx.gap(8);
        ctx.sectionHeader('Signatures');

        function _addSigBlock(label, sigId, nameVal) {
          ctx.needSpace(24);
          pdf.setFont('helvetica', 'bold'); pdf.setFontSize(9); pdf.setTextColor(60);
          pdf.text(label, ctx.marginL, ctx.y + 3); ctx.y += 6;
          var sigData = sig(sigId);
          if (sigData && sigData.indexOf('data:image/png;base64,') === 0) {
            try { pdf.addImage(sigData, 'PNG', ctx.marginL, ctx.y, 50, 12); } catch(e) {}
            ctx.y += 14;
          } else if (sigData && sigData.indexOf('typed:') === 0) {
            pdf.setFont('helvetica', 'italic'); pdf.setFontSize(14); pdf.setTextColor(20);
            pdf.text(sigData.replace('typed:',''), ctx.marginL, ctx.y + 4);
            ctx.y += 8;
          } else if (sigData && sigData.indexOf('wet:') === 0) {
            pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9); pdf.setTextColor(80);
            var ref = sigData.replace('wet:','');
            pdf.text(ref === 'pending' ? 'Wet signature on file' : 'E-sign: '+ref, ctx.marginL, ctx.y + 4);
            ctx.y += 8;
          } else {
            pdf.setDrawColor(160); pdf.setLineWidth(0.4);
            pdf.line(ctx.marginL, ctx.y + 8, ctx.marginL + 70, ctx.y + 8);
            ctx.y += 11;
          }
          pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8.5); pdf.setTextColor(80);
          if (nameVal) { pdf.text(nameVal, ctx.marginL, ctx.y + 3); ctx.y += 5; }
          pdf.text('Date: ' + (execDate || '___________'), ctx.marginL, ctx.y + 3);
          ctx.y += 7; pdf.setTextColor(0);
        }

        var _partyLabel = (_ticLeaseDocKey === 'temporary_lease' || _ticLeaseDocKey === 'monthly_temp_lease') ? 'Occupant' : 'Tenant';
        _addSigBlock('Landlord / Housing Manager', 'ls_sig_staff',    tokens.landlordName);
        _addSigBlock(_partyLabel,                  'ls_sig_tenant',   tokens.tenantName);
        if (tokens.coTenantName) _addSigBlock('Co-' + _partyLabel, 'ls_sig_cotenant', tokens.coTenantName);

        // Initials summary
        var clauses = _getEffectiveLeaseClauses();
        var withInitials = clauses.filter(function(cl){ return _leaseInitials[cl.id]; });
        if (withInitials.length) {
          ctx.needSpace(20); ctx.gap(6);
          ctx.sectionHeader(_partyLabel + ' Initials — Required Clauses');
          withInitials.forEach(function(cl) {
            var initData = _leaseInitials[cl.id];
            ctx.needSpace(18);
            pdf.setFont('helvetica', 'bold'); pdf.setFontSize(8.5); pdf.setTextColor(50);
            var labelLines = pdf.splitTextToSize(cl.label || cl.id, ctx.contentW - 55);
            pdf.text(labelLines, ctx.marginL, ctx.y + 3);
            if (initData && initData.indexOf('data:image/png;base64,') === 0) {
              try { pdf.addImage(initData, 'PNG', ctx.marginL + ctx.contentW - 52, ctx.y - 1, 28, 8); } catch(e) {}
            } else if (initData && initData.indexOf('typed:') === 0) {
              pdf.setFont('helvetica', 'italic'); pdf.setFontSize(12); pdf.setTextColor(20);
              pdf.text(initData.replace('typed:',''), ctx.marginL + ctx.contentW - 52, ctx.y + 4);
            }
            ctx.y += Math.max(labelLines.length * 4 + 1, 10);
            pdf.setTextColor(0);
          });
        }

        var base64 = ctx.finish();
        var binStr = atob(base64);
        var arr = new Uint8Array(binStr.length);
        for (var bi = 0; bi < binStr.length; bi++) arr[bi] = binStr.charCodeAt(bi);
        var blob = new Blob([arr], { type: 'application/pdf' });
        var nationShort = tokens.nationShort || 'Housing';
        var tenantSlug  = tokens.tenantName.replace(/\s+/g,'_') || 'Tenant';
        var filename    = nationShort + '_' + (_LEASE_FILE_SLUGS[_ticLeaseDocKey] || 'Occupancy_Agreement') + '_' + tenantSlug + '.pdf';

        var url  = URL.createObjectURL(blob);
        var link = document.createElement('a');
        link.href = url; link.download = filename; link.click();
        setTimeout(function(){ URL.revokeObjectURL(url); }, 3000);

        var unit = _ticState.unit || {};
        var _leaseQueued = false;
        if (unit.id) {
          try {
            var storePath = 'tenants/' + unit.id + '/' + Date.now() + '_' + filename;
            // Resilient: uploads now if online, otherwise queues to IndexedDB and
            // syncs on reconnect — so the signed agreement saves with no internet.
            if (typeof window.uploadFileResilient === 'function') {
              var _up = await window.uploadFileResilient(storePath, blob, {
                entityType: 'tenant', entityId: String(unit.id), filename: filename,
                size: blob.size, contentType: 'application/pdf'
              });
              _leaseQueued = !!(_up && _up.queued);
            } else {
              await window.sbUploadFile(storePath, blob);
              if (typeof window.sbSaveFileMeta === 'function') {
                await window.sbSaveFileMeta('tenant', String(unit.id), storePath, filename, blob.size, 'application/pdf');
              }
            }
            _ticDocLibKey = null; _ticDocLib = null;
            _ticUtilDocLibKey = null; _ticUtilDocLib = null;
          } catch(e) { console.warn('[lease] doc library upload failed:', e); }
        }
        var mo = document.getElementById('tic_lease_modal');
        if (mo) mo.remove();
        if (typeof showToast === 'function') showToast(_leaseQueued
          ? 'Agreement saved on this device — it will upload to the document library when you are back online.'
          : 'Occupancy Agreement saved to document library', {type:'info'});
        return;
      } catch(e) {
        console.error('[lease] jsPDF generation failed:', e);
        if (typeof showToast === 'function') showToast('PDF generation failed — see console', {type:'error'});
        return;
      }
    }

    // ── AcroForm fallback — used when no contract body has been saved ──────
    try { await _loadPdfLib(); } catch(e) {
      if (typeof showToast==='function') showToast('PDF library unavailable', {type:'error'}); return;
    }

    var fieldValues = {
      'execution_day':             execDay,
      'execution_month':           execMonth,
      'execution_year':            execYear,
      'term_start_date':           tokens.termStartDate,
      'tenant_primary_name':       tokens.tenantName,
      'tenant_cotenant_name':      tokens.coTenantName,
      'tenant_band_number':        tokens.tenantBandNumber,
      'tenant_dob':                tokens.tenantDOB,
      'tenant_po_box':             '',
      'tenant_phone':              tokens.tenantPhone,
      'tenant_email':              tokens.tenantEmail,
      'tenant_emergency_contact':  tokens.tenantEmergencyContact,
      'residence_lot':             tokens.residenceLot,
      'residence_street':          tokens.residenceStreet,
      'residence_unit_type':       '',
      'residence_bed_bath':        tokens.residenceBedBath,
      'residence_stream':          tokens.residenceStream,
      'residence_allocation_date': tokens.residenceAllocDate,
      'rent_amount':               tokens.rentAmount,
      'sig_landlord_name':         tokens.landlordName,
      'sig_landlord_title':        'Housing Manager',
      'sig_landlord_date':         execDate,
      'sig_tenant1_name':          tokens.tenantName,
      'sig_tenant1_date':          execDate,
      'sig_tenant2_name':          tokens.coTenantName,
      'sig_tenant2_date':          execDate,
    };
    for (var oi = 0; oi < 6; oi++) {
      var oIdx = oi + 1;
      fieldValues['occupant_'+oIdx+'_name']         = fv('ls_occ_name_'+oi);
      fieldValues['occupant_'+oIdx+'_relationship']  = fv('ls_occ_rel_'+oi);
      fieldValues['occupant_'+oIdx+'_dob']           = fv('ls_occ_dob_'+oi);
      fieldValues['occupant_'+oIdx+'_band']          = fv('ls_occ_band_'+oi);
    }

    var initSigs = {
      'init_drug_ack':    (_leaseInitials['ls_init_drug']  || sig('ls_init_drug')),
      'init_3_3':         (_leaseInitials['ls_init_3_3']   || sig('ls_init_3_3')),
      'init_3_4a':        (_leaseInitials['ls_init_3_4a']  || sig('ls_init_3_4a')),
      'init_3_4b':        (_leaseInitials['ls_init_3_4b']  || sig('ls_init_3_4b')),
      'ack_jurisdiction': (_leaseInitials['ls_init_juris'] || sig('ls_init_juris')),
      'sig_landlord':     sig('ls_sig_staff'),
      'sig_tenant1':      sig('ls_sig_tenant'),
      'sig_tenant2':      sig('ls_sig_cotenant'),
    };

    try {
      var pdfUrl   = window.location.origin + '/templates/lease-001.pdf';
      var resp     = await fetch(pdfUrl);
      if (!resp.ok) throw new Error('Could not fetch base PDF: ' + resp.status);
      var pdfBytes = await resp.arrayBuffer();

      var PDFLib = window.PDFLib;
      var pdfDoc = await PDFLib.PDFDocument.load(pdfBytes);
      var form   = pdfDoc.getForm();
      var pages  = pdfDoc.getPages();
      var stdFont = await pdfDoc.embedFont(PDFLib.StandardFonts.Helvetica);

      var fieldPos = {};
      var allPDFFields = form.getFields();
      for (var ffi = 0; ffi < allPDFFields.length; ffi++) {
        try {
          var ff = allPDFFields[ffi];
          var fw = ff.acroField.getWidgets();
          if (!fw.length) continue;
          var fwR = fw[0].getRectangle();
          var fwP = fw[0].P();
          var fpIdx = -1;
          for (var fpi = 0; fpi < pages.length; fpi++) {
            if (pages[fpi].ref.objectNumber === fwP.objectNumber) { fpIdx = fpi; break; }
          }
          if (fpIdx >= 0) fieldPos[ff.getName()] = { pageIdx: fpIdx, rect: fwR };
        } catch(e) {}
      }

      Object.keys(fieldValues).forEach(function(name) {
        var val = fieldValues[name];
        if (val == null || val === '') return;
        var pos = fieldPos[name];
        if (!pos) return;
        try {
          var sz = Math.min(9, pos.rect.height * 0.72);
          pages[pos.pageIdx].drawText(String(val), {
            x: pos.rect.x + 2, y: pos.rect.y + pos.rect.height * 0.18,
            size: sz, font: stdFont, color: PDFLib.rgb(0,0,0), maxWidth: pos.rect.width - 4
          });
        } catch(e) { console.warn('[lease] text draw failed for', name, ':', e); }
      });

      var pmtPos = fieldPos['pmt_pad'];
      if (pmtPos) {
        try {
          pages[pmtPos.pageIdx].drawText('X', {
            x: pmtPos.rect.x + pmtPos.rect.width * 0.2,
            y: pmtPos.rect.y + pmtPos.rect.height * 0.1,
            size: Math.min(10, pmtPos.rect.height * 0.8),
            font: stdFont, color: PDFLib.rgb(0,0,0)
          });
        } catch(e) {}
      }

      var sigEntries = Object.keys(initSigs);
      for (var si = 0; si < sigEntries.length; si++) {
        var fieldName = sigEntries[si];
        var sigData   = initSigs[fieldName];
        if (!sigData) continue;
        try {
          var allFields = form.getFields();
          var targetField = null;
          for (var fi = 0; fi < allFields.length; fi++) {
            if (allFields[fi].getName() === fieldName) { targetField = allFields[fi]; break; }
          }
          if (!targetField) continue;
          var widgets = targetField.acroField.getWidgets();
          if (!widgets.length) continue;
          var widget  = widgets[0];
          var rect    = widget.getRectangle();
          var pageRef = widget.P();
          var pageIdx = -1;
          for (var pi = 0; pi < pages.length; pi++) {
            if (pages[pi].ref.objectNumber === pageRef.objectNumber) { pageIdx = pi; break; }
          }
          if (pageIdx < 0) continue;
          if (sigData.indexOf('data:image/png;base64,') === 0) {
            var b64    = sigData.split(',')[1];
            var raw    = atob(b64);
            var pngArr = new Uint8Array(raw.length);
            for (var bi = 0; bi < raw.length; bi++) pngArr[bi] = raw.charCodeAt(bi);
            var pngImg = await pdfDoc.embedPng(pngArr);
            pages[pageIdx].drawImage(pngImg, { x: rect.x, y: rect.y, width: rect.width, height: rect.height });
            try { targetField.setText(''); } catch(e2) {}
          } else if (sigData.indexOf('typed:') === 0) {
            try { targetField.setText(sigData.replace('typed:','')); } catch(e2) {}
          } else if (sigData.indexOf('wet:') === 0) {
            var ref = sigData.replace('wet:','');
            try { targetField.setText(ref === 'pending' ? 'Wet signature on file' : 'E-sign: '+ref); } catch(e2) {}
          }
        } catch(e) { console.warn('[lease pdf] sig embed failed for', fieldName, e); }
      }

      pages.forEach(function(page) {
        try { page.node.delete(PDFLib.PDFName.of('Annots')); } catch(e) {}
      });
      try { pdfDoc.catalog.delete(PDFLib.PDFName.of('AcroForm')); } catch(e) {}

      var tenantName  = tokens.tenantName || 'Tenant';
      var filename    = (nationShort())+'_Occupancy_Agreement_' + tenantName.replace(/\s+/g,'_') + '.pdf';
      var filledBytes = await pdfDoc.save();
      var blob = new Blob([filledBytes], { type: 'application/pdf' });

      var url  = URL.createObjectURL(blob);
      var link = document.createElement('a');
      link.href = url; link.download = filename; link.click();
      setTimeout(function(){ URL.revokeObjectURL(url); }, 3000);

      var unit = _ticState.unit || {};
      if (unit.id) {
        try {
          var storePath = 'tenants/' + unit.id + '/' + Date.now() + '_' + filename;
          await window.sbUploadFile(storePath, blob);
          if (typeof window.sbSaveFileMeta === 'function') {
            await window.sbSaveFileMeta('tenant', String(unit.id), storePath, filename, blob.size, 'application/pdf');
          }
          _ticDocLibKey = null; _ticDocLib = null;
          _ticUtilDocLibKey = null; _ticUtilDocLib = null;
        } catch(e) { console.warn('[lease] doc library upload failed:', e); }
      }

      var mo = document.getElementById('tic_lease_modal');
      if (mo) mo.remove();
      if (typeof showToast === 'function') showToast('Occupancy Agreement saved to document library', {type:'info'});

    } catch(e) {
      console.error('[lease] PDF generation failed:', e);
      if (typeof showToast === 'function') showToast('PDF generation failed — see console', {type:'error'});
    }
  }
  // ── Hydro One Consent for Disclosure — pre-generation modal ───────────────
  function _ticOpenHydroOneConsentModal() {
    var t   = _ticState.tenant      || {};
    var u   = _ticState.unit        || {};
    var app = _ticState.application || {};
    var today = new Date().toISOString().split('T')[0];

    var custName   = t[TIC_C.full_name]      || ((app.fn||'') + ' ' + (app.ln||'')).trim();
    var custPhone  = app.phone               || '';
    var custAddr   = u.num ? ((u.num||'') + ' ' + (u.street||'')).trim() : (app.street||'');
    var custCity   = app.city                || '';
    var custPostal = app.postal              || '';
    var hydroAcct  = t[TIC_C.hydro_account]  || '';
    var hydroMeter = t[TIC_C.hydro_meter]    || '';
    var tpName     = nationDisplay() + ' Housing';
    var tpPhone    = (window.NATION_CONFIG && NATION_CONFIG.phone) || '';

    var existing = document.getElementById('tic_hydroone_modal');
    if (existing) existing.remove();

    function inp(id, val, ph) {
      return '<input id="' + id + '" type="text" value="' + _ticEsc(val||'') + '" placeholder="' + _ticEsc(ph||'') + '" style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px;font-family:DM Sans,sans-serif;background:var(--surface);color:var(--text);box-sizing:border-box;"/>';
    }
    function fld(label, inputHtml) {
      return '<div class="tic-field"><label class="tic-field-lbl">' + label + '</label>' + inputHtml + '</div>';
    }

    var modal = document.createElement('div');
    modal.id = 'tic_hydroone_modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.72);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px;';
    modal.innerHTML =
        '<div style="background:var(--surface);border-radius:12px;width:100%;max-width:680px;max-height:95vh;display:flex;flex-direction:column;box-shadow:0 8px 40px rgba(0,0,0,.35);">'
      + '<div class="modal-hdr"><div>'
      +   '<div class="lbl-yellow">&#128196; Hydro One &mdash; Consent for Disclosure</div>'
      +   '<div class="txt-sm-meta">Complete the details below, collect the tenant signature, then generate the PDF.</div>'
      + '</div><button type="button" onclick="document.getElementById(\'tic_hydroone_modal\').remove()" style="background:none;border:none;font-size:22px;cursor:pointer;color:var(--muted);">&times;</button></div>'

      + '<div style="overflow-y:auto;padding:20px 24px;flex:1;">'

      // Part A
      + '<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:var(--yellow);margin-bottom:12px;padding-bottom:5px;border-bottom:1px solid var(--border);">Part A &mdash; Customer Information</div>'
      + '<div class="tic-grid-2" style="margin-bottom:16px;">'
      +   fld('Name',            inp('ho_name',   custName,   'Full legal name'))
      +   fld('Phone #',         inp('ho_phone',  custPhone,  '(___) ___-____'))
      +   fld('Service Address', inp('ho_addr',   custAddr,   'Street address'))
      +   fld('City / Town',     inp('ho_city',   custCity,   'City or town'))
      +   fld('Postal Code',     inp('ho_postal', custPostal, 'A1A 1A1'))
      +   fld('Bill Account #',  inp('ho_acct',   hydroAcct,  'Hydro One account number'))
      +   fld('Meter #',         inp('ho_meter',  hydroMeter, 'Meter number'))
      + '</div>'

      // Third Party (read-only display)
      + '<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:var(--yellow);margin-bottom:10px;padding-bottom:5px;border-bottom:1px solid var(--border);">Third Party (pre-filled)</div>'
      + '<div style="padding:10px 14px;background:var(--bg);border-radius:6px;font-size:12px;margin-bottom:16px;color:var(--text);">'
      +   '<strong>' + _ticEsc(tpName) + '</strong>'
      +   (tpPhone ? '<div style="color:var(--muted);margin-top:2px;">Phone: ' + _ticEsc(tpPhone) + '</div>' : '')
      + '</div>'

      // Part B — Checkboxes
      + '<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:var(--yellow);margin-bottom:10px;padding-bottom:5px;border-bottom:1px solid var(--border);">Part B &mdash; Information to Disclose</div>'
      + '<div style="display:flex;flex-direction:column;gap:10px;margin-bottom:16px;font-size:12px;">'
      + '<label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;"><input type="checkbox" id="ho_chk_usage" checked style="margin-top:3px;accent-color:var(--yellow);width:15px;height:15px;"/> <span><strong>Electricity Usage</strong> — historical and ongoing meter readings, dates, interval data, and energy charges (up to 24 months)</span></label>'
      + '<label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;"><input type="checkbox" id="ho_chk_acct" checked style="margin-top:3px;accent-color:var(--yellow);width:15px;height:15px;"/> <span><strong>Account Information</strong> — name, contact info, service address, account number, meter number, customer rate class</span></label>'
      + '<label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;"><input type="checkbox" id="ho_chk_billing" checked style="margin-top:3px;accent-color:var(--yellow);width:15px;height:15px;"/> <span><strong>Billing Information</strong> — billing period details, current and last read dates, days per period, current charges (up to 24 months, excluding payment info)</span></label>'
      + '<div style="display:flex;align-items:center;gap:8px;">'
      +   '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;white-space:nowrap;"><input type="checkbox" id="ho_chk_other" style="accent-color:var(--yellow);width:15px;height:15px;"/> <strong>Other (specify):</strong></label>'
      +   '<input type="text" id="ho_other_text" placeholder="Specify other information…" style="flex:1;padding:5px 8px;border:1px solid var(--border);border-radius:5px;font-size:12px;font-family:DM Sans,sans-serif;background:var(--surface);color:var(--text);"/>'
      + '</div>'
      + '</div>'

      // Signature
      + '<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:var(--yellow);margin-bottom:10px;padding-bottom:5px;border-bottom:1px solid var(--border);">Customer Signature</div>'
      + '<div class="sig-canvas-wrap" style="margin-bottom:16px;">'
      +   '<div class="tab-bar">'
      +     '<button type="button" onclick="setSigMethod(\'tic_hydro_sig\',\'canvas\')" id="tic_hydro_sig_tab_canvas" class="tab-item active">&#9999;&#65039; Draw</button>'
      +     '<button type="button" onclick="setSigMethod(\'tic_hydro_sig\',\'type\')"   id="tic_hydro_sig_tab_type"   class="tab-item">&#9000;&#65039; Type</button>'
      +     '<button type="button" onclick="setSigMethod(\'tic_hydro_sig\',\'wet\')"    id="tic_hydro_sig_tab_wet"    class="tab-item">&#128396; Wet / E-Sign</button>'
      +   '</div>'
      +   '<div id="tic_hydro_sig_panel_canvas" class="bg-paper">'
      +     '<canvas id="tic_hydro_sig" width="700" height="110" style="width:100%;height:110px;display:block;touch-action:none;cursor:crosshair;"></canvas>'
      +     '<div style="display:flex;align-items:center;justify-content:space-between;padding:5px 10px;border-top:1px solid var(--border);">'
      +       '<span class="txt-xs-muted">Sign with finger or mouse</span>'
      +       '<button type="button" onclick="clearSig(\'tic_hydro_sig\')" style="background:none;border:1px solid var(--border);border-radius:5px;padding:2px 8px;font-size:10px;color:var(--muted);cursor:pointer;font-family:DM Sans,sans-serif;">Clear</button>'
      +     '</div>'
      +   '</div>'
      +   '<div id="tic_hydro_sig_panel_type" class="sec-hidden">'
      +     '<input type="text" id="tic_hydro_sig_typed" placeholder="Type full legal name" style="width:100%;border:none;border-bottom:2px solid var(--dark);background:transparent;font-size:18px;font-family:Georgia,serif;font-style:italic;color:var(--text);outline:none;padding:4px 0;box-sizing:border-box;"/>'
      +     '<div style="font-size:10px;color:var(--muted);margin-top:8px;">Typing your name constitutes a legal electronic signature</div>'
      +   '</div>'
      +   '<div id="tic_hydro_sig_panel_wet" class="sec-hidden">'
      +     '<div style="font-size:12px;font-weight:600;color:var(--text);margin-bottom:8px;">Print or email for signature</div>'
      +     '<div style="font-size:11px;color:var(--muted);line-height:1.6;margin-bottom:10px;">Print this form and collect a wet signature, or use an e-signature service and attach the signed copy to this tenant\'s file.</div>'
      +     '<input type="text" id="tic_hydro_sig_wet_ref" placeholder="Reference # or e-sign envelope ID (optional)" style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;font-size:12px;font-family:DM Sans,sans-serif;background:var(--surface);color:var(--text);box-sizing:border-box;"/>'
      +   '</div>'
      + '</div>'

      // Date
      + '<div class="tic-field"><label class="tic-field-lbl">Date of Authorization</label>'
      + '<input id="ho_date" type="date" value="' + today + '" style="padding:7px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px;font-family:DM Sans,sans-serif;background:var(--surface);color:var(--text);"/></div>'
      + '</div>'

      // Footer
      + '<div style="padding:14px 24px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:10px;flex-shrink:0;">'
      +   '<button type="button" onclick="document.getElementById(\'tic_hydroone_modal\').remove()" class="btn btn-ghost">Cancel</button>'
      +   '<button type="button" onclick="window._ticGenerateHydroOneConsentPdf && window._ticGenerateHydroOneConsentPdf()" class="btn btn-primary">Generate PDF</button>'
      + '</div>'
      + '</div>';

    document.body.appendChild(modal);
    setTimeout(function() {
      if (typeof _initSigPad === 'function') _initSigPad('tic_hydro_sig');
    }, 80);
  }

  // ── Hydro One Consent for Disclosure — PDF generator ──────────────────────
  // Replicates the official Hydro One form layout exactly so it is accepted.
  // Part C (Termination) is rendered blank for later use.
  //
  // Fixes applied vs v1:
  //   • Checkboxes: drawn tick lines (✓ glyph is absent in jsPDF Helvetica)
  //   • Part B sigs: single clean two-column block — no duplicate Name rows
  //   • Part C: clean two-column blocks — no stray "Hydro"/"One" inline text
  async function _ticGenerateHydroOneConsentPdf() {
    if (typeof _loadJsPdf === 'function') await _loadJsPdf();
    if (!window.jspdf || !window.jspdf.jsPDF) { if (typeof showToast === 'function') showToast('PDF library unavailable', {type:'error'}); return; }

    var fv = function(id) { var e = document.getElementById(id); return e ? (e.value || '').trim() : ''; };
    var fc = function(id) { var e = document.getElementById(id); return e ? e.checked : false; };
    function markRequired(id) {
      var e = document.getElementById(id);
      if (e) { e.style.borderColor = 'var(--danger)'; e.focus(); }
    }
    function clearRequired(id) {
      var e = document.getElementById(id);
      if (e) e.style.borderColor = '';
    }

    var hydroAcct  = fv('ho_acct');
    var hydroMeter = fv('ho_meter');

    // Meter # and Bill Account # are required by Hydro One
    var missing = [];
    if (!hydroAcct)  missing.push('ho_acct');
    if (!hydroMeter) missing.push('ho_meter');
    ['ho_acct', 'ho_meter'].forEach(clearRequired);
    if (missing.length) {
      missing.forEach(markRequired);
      if (typeof showToast === 'function') showToast('Bill Account # and Meter # are required', {type:'error'});
      return;
    }

    var custName   = fv('ho_name');
    var custPhone  = fv('ho_phone');
    var custAddr   = fv('ho_addr');
    var custCity   = fv('ho_city');
    var custPostal = fv('ho_postal');
    var dateRaw    = fv('ho_date');
    var chkUsage   = fc('ho_chk_usage');
    var chkAcct    = fc('ho_chk_acct');
    var chkBilling = fc('ho_chk_billing');
    var chkOther   = fc('ho_chk_other');
    var otherText  = fv('ho_other_text');
    var sigData    = (typeof getSigDataURL === 'function') ? getSigDataURL('tic_hydro_sig') : '';

    var tpName  = nationDisplay() + ' Housing';
    var tpPhone = (window.NATION_CONFIG && NATION_CONFIG.phone) || '';
    var dateDisp = dateRaw ? (function(){ var d = new Date(dateRaw + 'T12:00:00'); return isNaN(d) ? dateRaw : d.toLocaleDateString('en-CA'); })() : '';

    var pdf  = new window.jspdf.jsPDF({ unit:'mm', format:'letter', orientation:'portrait', compress:true });
    var W    = pdf.internal.pageSize.getWidth();   // 215.9
    var L    = 12, R = 12;
    var CW   = W - L - R;                          // 191.9
    var y    = 10;
    var lh   = 3.8; // standard line height for body text

    // Helpers
    function hline(yy, lw) { pdf.setDrawColor(0); pdf.setLineWidth(lw||0.2); pdf.line(L, yy, W-R, yy); }
    function uline(x1, x2, yy) { pdf.setDrawColor(0); pdf.setLineWidth(0.15); pdf.line(x1, yy, x2, yy); }
    function fline(label, val, x, w, yy) {
      pdf.setFont('helvetica','normal'); pdf.setFontSize(6.5); pdf.setTextColor(90);
      pdf.text(label, x, yy - 2.8);
      pdf.setTextColor(0); pdf.setFontSize(8.5);
      if (val) pdf.text(String(val).substring(0, Math.floor(w / 1.8)), x, yy);
      uline(x, x + w, yy + 0.8);
    }
    // Draw checkbox square + tick mark via lines (✓ glyph missing in jsPDF Helvetica)
    function chkBox(x, yy, checked) {
      pdf.setDrawColor(0); pdf.setLineWidth(0.35); pdf.setFillColor(255,255,255);
      pdf.rect(x, yy - 3.2, 3.8, 3.8, 'FD');
      if (checked) {
        pdf.setDrawColor(0); pdf.setLineWidth(0.6);
        pdf.line(x + 0.5, yy - 1.4, x + 1.5, yy - 0.2);
        pdf.line(x + 1.5, yy - 0.2, x + 3.3, yy - 2.8);
      }
    }
    function chkRow(x, yy, checked, boldLabel, description) {
      chkBox(x, yy, checked);
      var tx = x + 5.5;
      pdf.setFont('helvetica','bold'); pdf.setFontSize(7.5); pdf.setTextColor(0);
      pdf.text(boldLabel + ':', tx, yy);
      var descLines = pdf.splitTextToSize(description, CW - 5.5 - 3);
      pdf.setFont('helvetica','normal'); pdf.setFontSize(7.5);
      pdf.text(descLines, tx, yy + lh);
      return yy + lh + descLines.length * lh + 1.5;
    }
    // Render a signature into an existing signature line area.
    // Does NOT write "Name (Print)" or "Signature:" labels — caller owns those.
    function renderSig(sigImg, x, lineY, w) {
      var sigH = 15;
      if (sigImg && sigImg.indexOf('data:image') === 0) {
        try { pdf.addImage(sigImg, 'PNG', x, lineY - sigH, w, sigH); } catch(e) {}
      } else if (sigImg && sigImg.indexOf('typed:') === 0) {
        pdf.setFont('helvetica','italic'); pdf.setFontSize(12); pdf.setTextColor(0);
        pdf.text(sigImg.replace('typed:',''), x + 1, lineY - 3);
        pdf.setFont('helvetica','normal'); pdf.setFontSize(7.5);
      } else if (sigImg && sigImg.indexOf('wet:') === 0) {
        var ref = sigImg.replace('wet:','');
        pdf.setFont('helvetica','normal'); pdf.setFontSize(7); pdf.setTextColor(100);
        pdf.text(ref === 'pending' ? 'Physical signature on file' : 'E-sign ref: ' + ref, x + 1, lineY - 5);
        pdf.setTextColor(0); pdf.setFontSize(7.5);
      }
    }


    // ═══════════════════════════════════════════════════════════════════
    // HEADER — embedded PNG (exact Hydro One branding, 801×109px original)
    // ═══════════════════════════════════════════════════════════════════
    var _hydroHdrB64 = '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';
    var _hdrH = CW * (109 / 801); // preserve aspect ratio
    pdf.addImage('data:image/png;base64,' + _hydroHdrB64, 'PNG', L, y, CW, _hdrH);
    y += _hdrH + 3;
    hline(y, 0.3); y += 4;


    // ═══════════════════════════════════════════════════════════════════
    // PART A: Customer Information
    // ═══════════════════════════════════════════════════════════════════
    pdf.setFont('helvetica','bold'); pdf.setFontSize(8); pdf.setTextColor(0);
    pdf.text('PART A: Customer Information (complete ', L, y);
    var uStart = L + pdf.getStringUnitWidth('PART A: Customer Information (complete ') * 8 / pdf.internal.scaleFactor;
    pdf.setFont('helvetica','bolditalic');
    pdf.text('all', uStart, y);
    var uEnd = uStart + pdf.getStringUnitWidth('all') * 8 / pdf.internal.scaleFactor;
    uline(uStart, uEnd, y + 0.5);
    pdf.setFont('helvetica','bold');
    pdf.text(' applicable customer information)', uEnd, y);
    y += 6;

    var c1 = CW * 0.42, c2 = CW * 0.31, c3 = CW - c1 - c2;
    fline('Name',            custName,  L,         c1 - 2,  y);
    fline('Premises Phone #',custPhone, L + c1,    c2 - 2,  y);
    fline('Alt/Bus #',       '',        L + c1+c2, c3,      y);
    y += 7;

    fline('Meter #',         hydroMeter,L,         CW * 0.42 - 2, y);
    fline('Bill Account #',  hydroAcct, L + CW*0.42, CW * 0.58 - 2, y);
    y += 7;

    var aW = CW * 0.40, cW2 = CW * 0.38, pW = CW - aW - cW2;
    fline('Address',    custAddr,   L,          aW - 2,  y);
    fline('City/Town',  custCity,   L + aW,     cW2 - 2, y);
    fline('Postal Code',custPostal, L + aW+cW2, pW,      y);
    y += 7;

    pdf.setFont('helvetica','bold'); pdf.setFontSize(8); pdf.setTextColor(0);
    pdf.text('Service Location', L, y);
    var slX = L + 28;
    fline('Lot #',      '', slX,       44,          y);
    fline('Concession', '', slX + 46,  60,          y);
    fline('Township',   '', slX + 108, CW - 28 - 46 - 62, y);
    y += 7;

    pdf.setFont('helvetica','normal'); pdf.setFontSize(8);
    pdf.text('Reg. Plan #', L, y);      uline(L + 19, L + 50, y + 0.8);
    pdf.text('RP Lot #', L + 53, y);    uline(L + 65, L + 88, y + 0.8);
    pdf.text('911 # address', L + 91, y); uline(L + 109, W - R, y + 0.8);
    y += 7;

    pdf.setFont('helvetica','bold'); pdf.setFontSize(7.5);
    pdf.text('Mailing address for billing (if different from above):', L, y);
    fline('Name', '', L + 86, CW - 86, y);
    y += 6;
    fline('Address',    '', L,          aW - 2,  y);
    fline('City/Town',  '', L + aW,     cW2 - 2, y);
    fline('Postal Code','', L + aW+cW2, pW,      y);
    y += 7;

    // Third Party
    pdf.setFont('helvetica','bold'); pdf.setFontSize(8.5); pdf.setTextColor(0);
    pdf.text('Third Party Information', L, y);
    y += 5;
    fline('Name', tpName, L, CW, y);
    y += 7;
    var phW = CW * 0.33 - 2;
    fline('Phone #', tpPhone, L,              phW,          y);
    fline('Cell #',  '',       L + CW * 0.33, phW,          y);
    fline('Fax #',   '',       L + CW * 0.66, CW * 0.34-2, y);
    y += 5;

    hline(y, 0.5); y += 4;

    // ═══════════════════════════════════════════════════════════════════
    // PART B: Consent
    // ═══════════════════════════════════════════════════════════════════
    pdf.setFont('helvetica','bold'); pdf.setFontSize(8); pdf.setTextColor(0);
    pdf.text('PART B: Consent for Disclosure of Information to Above-Named Third-Party', L, y);
    y += 4.5;

    pdf.setFont('helvetica','normal'); pdf.setFontSize(7.5);
    var preamble1 = pdf.splitTextToSize(
      'The above-noted customer hereby consents to the disclosure by Hydro One Networks Inc. the following account related information to the Third-Party named above.',
      CW);
    pdf.text(preamble1, L, y); y += preamble1.length * lh + 1.5;
    pdf.text('The relevant account-related information that can be disclosed is as follows:', L, y);
    y += 5;

    y = chkRow(L + 2, y, chkUsage,
      'Electricity Usage',
      'Your electricity usage data for up to the last 24 months (if applicable) includes a historical and ongoing meter readings and dates, interval data, and energy charges.');
    y = chkRow(L + 2, y, chkAcct,
      'Account Information',
      'Your account information comprises personal details (like your name and contact information) as well as your service address, account number, meter number, and customer rate class.');
    y = chkRow(L + 2, y, chkBilling,
      'Billing Information',
      'Your billing information for up to the last 24 months (if applicable) includes billing period details, current and last read dates, number of days in each billing period, current charges for each bill period excluding payment information (i.e. past due balance, due dates).');
    // Other
    chkBox(L + 2, y, chkOther);
    pdf.setFont('helvetica','normal'); pdf.setFontSize(7.5); pdf.setTextColor(0);
    pdf.text('Other (please specify): ' + (chkOther && otherText ? otherText : ''), L + 7.5, y);
    uline(L + 49, W - R, y + 0.8);
    y += 5;

    var durLines = pdf.splitTextToSize(
      'The above consent remains in effect from the date of authorization to the date that written termination of the consent is received by Hydro One Networks Inc., or the account is no longer in the account holder\'s name, whichever happens first.',
      CW);
    pdf.setFont('helvetica','normal'); pdf.setFontSize(7.5);
    pdf.text(durLines, L, y); y += durLines.length * lh + 3;

    // Date
    pdf.setFont('helvetica','normal'); pdf.setFontSize(7.5);
    pdf.text('Date: ' + dateDisp, L, y);
    uline(L + 10, L + 70, y + 0.8);
    y += 7;

    // Part B — Name (Print) row
    var halfW = (CW - 4) / 2;
    var col2X = L + halfW + 4;
    pdf.setFont('helvetica','normal'); pdf.setFontSize(7.5); pdf.setTextColor(0);
    pdf.text('Name (Print): ' + custName, L, y);
    uline(L + 26, L + halfW, y + 0.8);
    pdf.text('Name (Print):', col2X, y);
    uline(col2X + 26, W - R, y + 0.8);
    y += 7;

    // Part B — Signature row (left = customer, right = Hydro One blank)
    pdf.text('Signature:', L, y);
    pdf.text('Signature:', col2X, y);
    var sigLineY = y + 16;
    renderSig(sigData, L + 18, sigLineY, halfW - 18);
    uline(L + 18, L + halfW, sigLineY);
    uline(col2X + 18, W - R, sigLineY);
    y = sigLineY + 4;

    // Note box
    pdf.setDrawColor(0); pdf.setLineWidth(0.3); pdf.setFillColor(245,245,245);
    var noteText = 'Note:  For Hydro One accounts where two parties are responsible, both account holders must sign the above consent before account information will be disclosed.';
    var noteLines = pdf.splitTextToSize(noteText, CW - 6);
    var noteH = noteLines.length * lh + 5;
    pdf.rect(L, y, CW, noteH, 'FD');
    pdf.setFont('helvetica','normal'); pdf.setFontSize(7); pdf.setTextColor(0);
    pdf.text(noteLines, L + 3, y + 4);
    y += noteH + 4;

    hline(y, 0.5); y += 4;

    // ═══════════════════════════════════════════════════════════════════
    // PART C: Termination (blank — completed only when terminating)
    // ═══════════════════════════════════════════════════════════════════
    pdf.setFont('helvetica','bold'); pdf.setFontSize(8); pdf.setTextColor(0);
    pdf.text('PART C: Termination of Consent for Disclosure of Information to Above-Named Third-Party', L, y);
    y += 4.5;

    pdf.setFont('helvetica','normal'); pdf.setFontSize(7.5);
    var termLines = pdf.splitTextToSize(
      'The above-noted customer terminates consent to the disclosure of account-related information to the Third-Party above-named effective as of the date signed below.',
      CW);
    pdf.text(termLines, L, y); y += termLines.length * lh + 5;

    // Part C — two clean signature columns (both blank)
    function blankSigCol(x, w) {
      pdf.setFont('helvetica','normal'); pdf.setFontSize(7.5); pdf.setTextColor(0);
      pdf.text('Date:', x, y); uline(x + 10, x + w, y + 0.8);
    }
    blankSigCol(L,     halfW); blankSigCol(col2X, halfW);
    y += 7;
    pdf.text('Name (Print):', L,     y); uline(L + 26,     L + halfW,  y + 0.8);
    pdf.text('Name (Print):', col2X, y); uline(col2X + 26, W - R,      y + 0.8);
    y += 7;
    pdf.text('Signature:',    L,     y); uline(L + 18,     L + halfW,  y + 0.8);
    pdf.text('Signature:',    col2X, y); uline(col2X + 18, W - R,      y + 0.8);
    y += 10;
    pdf.text('Name (Print):', L,     y); uline(L + 26,     L + halfW,  y + 0.8);
    pdf.text('Name (Print):', col2X, y); uline(col2X + 26, W - R,      y + 0.8);
    y += 7;
    pdf.text('Signature:',    L,     y); uline(L + 18,     L + halfW,  y + 0.8);
    pdf.text('Signature:',    col2X, y); uline(col2X + 18, W - R,      y + 0.8);

    // Rotated watermark (left margin, matching the original)
    pdf.setFontSize(6.5); pdf.setTextColor(120);
    pdf.text('Hydro One Networks Inc.  04/12', 6, 262, { angle: 90 });
    pdf.setTextColor(0);

    // ── Output ────────────────────────────────────────────────────────────────
    var filename = 'HydroOne_Consent_' + (custName || 'Tenant').replace(/\s+/g, '_') + '.pdf';

    // Download to browser
    pdf.save(filename);

    // Save to tenant document library
    var unit = _ticState.unit || {};
    if (unit.id) {
      try {
        var blob      = pdf.output('blob');
        var storePath = 'tenants/' + unit.id + '/' + Date.now() + '_' + filename;
        await window.sbUploadFile(storePath, blob);
        if (typeof window.sbSaveFileMeta === 'function') {
          await window.sbSaveFileMeta('tenant', String(unit.id), storePath, filename, blob.size, 'application/pdf');
        }
        // Force doc-lib remount so the new file appears immediately
        _ticDocLibKey = null;
        _ticDocLib    = null;
        // Close the modal now that the PDF is done
        var mo = document.getElementById('tic_hydroone_modal');
        if (mo) mo.remove();
        if (typeof showToast === 'function') showToast('✓ PDF saved to document library', {type:'info'});
      } catch (e) {
        console.warn('[tic] PDF upload to doc library failed:', e);
        var mo2 = document.getElementById('tic_hydroone_modal');
        if (mo2) mo2.remove();
        if (typeof showToast === 'function') showToast('✓ PDF downloaded (document library save failed — see console)', {type:'error'});
      }
    } else {
      var mo3 = document.getElementById('tic_hydroone_modal');
      if (mo3) mo3.remove();
      if (typeof showToast === 'function') showToast('✓ PDF generated', {type:'info'});
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Notice of Housing Inspection — 48 Hours' Notice (Housing Policy s. 13.9)
  // Fill-in modal + PDF generator. Nation identity (name / short / phone /
  // email) is read from NATION_CONFIG so no CLFN literal is baked in.
  // ════════════════════════════════════════════════════════════════════════════

  // Friendly long date, e.g. "Wednesday, July 19, 2026". Accepts a yyyy-mm-dd.
  function _inspFmtDateLong(d) {
    if (!d) return '';
    try { var dt = new Date(d + 'T12:00:00'); if (isNaN(dt)) return d;
      return dt.toLocaleDateString('en-CA', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
    } catch(e) { return d; }
  }
  // served date (yyyy-mm-dd) + 48h -> friendly long date of the day the period ends.
  function _inspExpiryFromServed(servedYmd) {
    if (!servedYmd) return '';
    try { var dt = new Date(servedYmd + 'T12:00:00'); if (isNaN(dt)) return '';
      dt.setDate(dt.getDate() + 2); // 48 hours
      return dt.toLocaleDateString('en-CA', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
    } catch(e) { return ''; }
  }
  // Recompute the expiry field when the served date changes (staff can still
  // append a time). Exposed so the inline onchange can reach it.
  window._ticRecalcNoticeExpiry = function() {
    var s = document.getElementById('insp_served');
    var e = document.getElementById('insp_expiry');
    if (s && e) e.value = _inspExpiryFromServed(s.value);
  };

  function _ticOpenInspectionNoticeModal() {
    var t   = _ticState.tenant      || {};
    var u   = _ticState.unit        || {};
    var app = _ticState.application || {};
    var today = new Date().toISOString().split('T')[0];

    var tenantName = t[TIC_C.full_name] || ((app.fn||'') + ' ' + (app.ln||'')).trim();
    var unitAddr   = u.num ? ((u.num||'') + ' ' + (u.street||'')).trim() : (app.street||'');
    var hmName     = (window.HOUSING_SESSION && HOUSING_SESSION.name) || '';
    var nc         = window.NATION_CONFIG || {};
    var hPhone     = nc.phone || '';
    var hEmail     = nc.housing_email || nc.email || '';
    var fileRef    = u.id ? String(u.id) : '';

    var existing = document.getElementById('tic_inspnotice_modal');
    if (existing) existing.remove();

    function inp(id, val, ph, type) {
      return '<input id="' + id + '" type="' + (type||'text') + '" value="' + _ticEsc(val||'') + '" placeholder="' + _ticEsc(ph||'') + '" style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px;font-family:DM Sans,sans-serif;background:var(--surface);color:var(--text);box-sizing:border-box;"/>';
    }
    function fld(label, inputHtml) {
      return '<div class="tic-field"><label class="tic-field-lbl">' + label + '</label>' + inputHtml + '</div>';
    }
    function hdr(text) {
      return '<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:var(--yellow);margin:4px 0 12px;padding-bottom:5px;border-bottom:1px solid var(--border);">' + text + '</div>';
    }

    var modal = document.createElement('div');
    modal.id = 'tic_inspnotice_modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.72);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px;';
    modal.innerHTML =
        '<div style="background:var(--surface);border-radius:12px;width:100%;max-width:680px;max-height:95vh;display:flex;flex-direction:column;box-shadow:0 8px 40px rgba(0,0,0,.35);">'
      + '<div class="modal-hdr"><div>'
      +   '<div class="lbl-yellow">&#128196; Notice of Inspection &mdash; 48 Hours</div>'
      +   '<div class="txt-sm-meta">Confirm the details below, then generate the notice PDF. It is filed to this tenant\'s documents.</div>'
      + '</div><button type="button" onclick="document.getElementById(\'tic_inspnotice_modal\').remove()" style="background:none;border:none;font-size:22px;cursor:pointer;color:var(--muted);">&times;</button></div>'

      + '<div style="overflow-y:auto;padding:20px 24px;flex:1;">'

      + hdr('Letter Details')
      + '<div class="tic-grid-2" style="margin-bottom:16px;">'
      +   fld('File Reference',     inp('insp_fileref',    fileRef,    'Optional reference'))
      +   fld('Letter Date',        inp('insp_letterdate', today,      '', 'date'))
      +   fld('Name of Tenant',     inp('insp_tenant',     tenantName, 'Full name of tenant'))
      +   fld('Housing Unit / Address', inp('insp_address', unitAddr,  'Unit address'))
      + '</div>'

      + hdr('Inspection Notice')
      + '<div class="tic-grid-2" style="margin-bottom:12px;">'
      +   fld('Date Notice Served <span style="color:var(--danger);">*</span>', inp('insp_served', today, '', 'date').replace('/>', ' oninput="window._ticRecalcNoticeExpiry && window._ticRecalcNoticeExpiry()"/>'))
      +   fld('48-Hour Period Ends', inp('insp_expiry', _inspExpiryFromServed(today), 'Auto-filled from served date'))
      + '</div>'
      + fld('Purpose / Reason for Inspection <span style="color:var(--danger);">*</span>',
          '<textarea id="insp_purpose" rows="2" placeholder="e.g. Annual condition inspection; follow-up on reported maintenance" style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px;font-family:DM Sans,sans-serif;background:var(--surface);color:var(--text);box-sizing:border-box;resize:vertical;"></textarea>')
      + '<div class="tic-grid-2" style="margin:12px 0 16px;">'
      +   fld('Conducted By (Housing Manager) <span style="color:var(--danger);">*</span>', inp('insp_hm', hmName, 'Housing Manager name'))
      +   fld('Housing Phone',  inp('insp_phone', hPhone, 'Housing Department phone'))
      +   fld('Housing Email',  inp('insp_email', hEmail, 'Housing Department email'))
      + '</div>'

      + hdr('For Housing Office Use &mdash; Record of Notice (optional)')
      + '<div class="tic-grid-2" style="margin-bottom:4px;">'
      +   fld('Notice Delivered By',  inp('insp_delivered_by', '', 'Staff name'))
      +   fld('Date &amp; Time Delivered', inp('insp_delivered_at', '', 'e.g. 2026-07-17 2:15 PM'))
      +   fld('Method of Delivery',
            '<select id="insp_method" style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px;font-family:DM Sans,sans-serif;background:var(--surface);color:var(--text);box-sizing:border-box;">'
          +   '<option value="">&mdash; Select &mdash;</option>'
          +   '<option>hand-delivered</option><option>posted on door</option><option>mail</option><option>email</option>'
          + '</select>')
      + '</div>'
      + '<div style="font-size:11px;color:var(--muted);margin-top:2px;">Leave the Record of Notice blank to complete it by hand on the printed copy.</div>'
      + '</div>'

      // Footer
      + '<div style="padding:14px 24px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:10px;flex-shrink:0;">'
      +   '<button type="button" onclick="document.getElementById(\'tic_inspnotice_modal\').remove()" class="btn btn-ghost">Cancel</button>'
      +   '<button type="button" onclick="window._ticGenerateInspectionNoticePdf && window._ticGenerateInspectionNoticePdf()" class="btn btn-primary">Generate PDF</button>'
      + '</div>'
      + '</div>';

    document.body.appendChild(modal);
  }

  async function _ticGenerateInspectionNoticePdf() {
    if (typeof _loadJsPdf === 'function') await _loadJsPdf();
    if (!window.jspdf || !window.jspdf.jsPDF) { if (typeof showToast === 'function') showToast('PDF library unavailable', {type:'error'}); return; }

    var fv = function(id) { var e = document.getElementById(id); return e ? (e.value || '').trim() : ''; };
    function markRequired(id, on) { var e = document.getElementById(id); if (e) e.style.borderColor = on ? 'var(--danger)' : ''; }

    var tenant   = fv('insp_tenant');
    var address  = fv('insp_address');
    var servedYmd= fv('insp_served');
    var purpose  = fv('insp_purpose');
    var hmName   = fv('insp_hm');
    var fileRef  = fv('insp_fileref');
    var letterYmd= fv('insp_letterdate');
    var expiry   = fv('insp_expiry') || _inspExpiryFromServed(servedYmd);
    var hPhone   = fv('insp_phone');
    var hEmail   = fv('insp_email');
    var delBy    = fv('insp_delivered_by');
    var delAt    = fv('insp_delivered_at');
    var delMethod= fv('insp_method');

    // Required: served date, purpose, HM name.
    var missing = [];
    ['insp_served','insp_purpose','insp_hm'].forEach(function(id){ markRequired(id, false); });
    if (!servedYmd) missing.push('insp_served');
    if (!purpose)   missing.push('insp_purpose');
    if (!hmName)    missing.push('insp_hm');
    if (missing.length) {
      missing.forEach(function(id){ markRequired(id, true); });
      var f = document.getElementById(missing[0]); if (f) f.focus();
      if (typeof showToast === 'function') showToast('Date served, purpose, and Housing Manager are required', {type:'error'});
      return;
    }

    var nationName  = (typeof nationDisplay === 'function') ? nationDisplay() : ((window.NATION_CONFIG||{}).display_name || '');
    var nationSh    = (typeof nationShort   === 'function') ? nationShort()   : ((window.NATION_CONFIG||{}).short || nationName);
    var servedLong  = _inspFmtDateLong(servedYmd);
    var letterLong  = _inspFmtDateLong(letterYmd) || _inspFmtDateLong(new Date().toISOString().split('T')[0]);

    var logo = (typeof _fetchLogoForPdf === 'function') ? await _fetchLogoForPdf() : null;
    if (typeof _makePdfDoc !== 'function') { if (typeof showToast === 'function') showToast('PDF letterhead helper unavailable', {type:'error'}); return; }
    var ctx = _makePdfDoc({
      headerTitle:    'Notice of Inspection',
      headerSubtitle: "48 Hours' Notice",
      logoDataUrl:    logo,
      footerLeft:     nationName + ' Housing Department — Confidential'
    });
    var pdf = ctx.pdf;
    ctx.marginB = 14; // tighten the bottom margin a touch so the notice fits one page
    var L = ctx.marginL, CW = ctx.contentW, RX = ctx.pageW - ctx.marginR;

    // Compact local writers — tuned so the whole notice fits on one page.
    // STEP is the per-line height; blanks print nothing (no dash / underscore).
    var BODY = 8.5, STEP = 3.5;
    function para(text, opts) {
      opts = opts || {};
      pdf.setFont('helvetica', opts.bold ? 'bold' : 'normal');
      pdf.setFontSize(opts.size || BODY);
      pdf.setTextColor(opts.color != null ? opts.color : 40);
      var lines = pdf.splitTextToSize(String(text), CW);
      ctx.needSpace(lines.length * STEP + 1.9);
      pdf.text(lines, L, ctx.y + 2.6);
      ctx.y += lines.length * STEP + 1.9;
      pdf.setTextColor(0); pdf.setFont('helvetica','normal');
    }
    function metaLine(label, val) {
      var v = (val == null ? '' : String(val)).trim();   // blank prints nothing
      var lbl = label + ':';
      pdf.setFont('helvetica','bold'); pdf.setFontSize(BODY);
      var lw = pdf.getTextWidth(lbl + ' ');
      var vlines = v ? pdf.splitTextToSize(v, CW - lw) : [''];
      ctx.needSpace(vlines.length * STEP + 0.9);
      pdf.setTextColor(20); pdf.text(lbl, L, ctx.y + 2.6);
      if (v) { pdf.setFont('helvetica','normal'); pdf.setTextColor(40); pdf.text(vlines, L + lw, ctx.y + 2.6); }
      ctx.y += vlines.length * STEP + 0.9;
      pdf.setTextColor(0); pdf.setFont('helvetica','normal');
    }
    function bullet(text) {
      pdf.setFont('helvetica','normal'); pdf.setFontSize(BODY); pdf.setTextColor(40);
      var lines = pdf.splitTextToSize(String(text), CW - 5);
      ctx.needSpace(lines.length * STEP + 1.5);
      pdf.text('-', L + 1, ctx.y + 2.6);
      pdf.text(lines, L + 5, ctx.y + 2.6);
      ctx.y += lines.length * STEP + 1.5;
      pdf.setTextColor(0);
    }
    function sect(title) {
      ctx.needSpace(9); ctx.y += 2.6;
      pdf.setFont('helvetica','bold'); pdf.setFontSize(8.5); pdf.setTextColor(90);
      pdf.text(String(title).toUpperCase(), L, ctx.y + 2.6);
      pdf.setDrawColor(window._themeAccentHex()); pdf.setLineWidth(0.6);
      pdf.line(L, ctx.y + 3.6, RX, ctx.y + 3.6); pdf.setDrawColor(0);
      ctx.y += 5.6; pdf.setTextColor(0); pdf.setFont('helvetica','normal');
    }

    // Letter head block ------------------------------------------------------
    metaLine('File Reference', fileRef);
    metaLine('Date', letterLong);
    metaLine('Name of Tenant', tenant);
    metaLine('Housing Unit / Address', address);
    metaLine('Community', nationName);
    ctx.gap(3.5);

    para("RE: Notice of Housing Inspection — 48 Hours' Notice", { bold:true, size:9.5, color:20 });
    ctx.gap(1.5);
    para('Dear ' + (tenant || 'Tenant') + ',');
    para('This letter is formal notice that the ' + nationName + ' ("' + nationSh + '") Housing Department will be conducting an inspection of your housing unit. Under Section 13.9 of the ' + nationSh + " Housing Policy, the Housing Manager reserves the right to inspect any Band housing unit by providing residents with at least forty-eight (48) hours' notice. This notice is served on you on " + servedLong + ', and the inspection may be carried out at any time once the 48-hour notice period has ended.');

    sect('Details of the Inspection');
    metaLine('Date this notice is served', servedLong);
    metaLine('48-hour notice period ends', expiry);
    metaLine('Inspection will be conducted', 'At any time on or after the end of the 48-hour notice period shown above');
    metaLine('Purpose / reason for inspection', purpose);
    metaLine('Inspection to be conducted by', hmName + ', Housing Manager, and authorized Housing staff and/or contractors');
    ctx.gap(1.5);
    para('In accordance with Section 13.9 of the ' + nationSh + ' Housing Policy, no specific appointment time is required. The inspection may take place at any time after the 48-hour notice period has ended, and no further reminder or second notice will be given before it is carried out. Housing staff will access all areas of the unit as reasonably required for the purpose stated above.');

    sect('What to Expect');
    bullet('The inspection will be carried out by the Housing Manager together with authorized Housing staff and/or contractors.');
    bullet('Findings will be documented in writing, and photographs may be taken to record the condition of the unit.');
    bullet('You are welcome to be present during the inspection, but your presence is not required for it to proceed.');
    bullet('Housing staff will not remove any property from the unit as part of a routine inspection.');

    sect('Your Responsibility as a Tenant');
    para('As a condition of your housing agreement, Section 13.1 of the ' + nationSh + ' Housing Policy requires all tenants to allow authorized staff and contractors access to the unit for inspections, maintenance, and repairs with reasonable notice. Refusing to permit reasonable access for inspection may be treated as tenant neglect and may constitute non-compliance with the terms of your housing agreement and this Policy.');

    var contact = (hPhone || hEmail)
      ? ('If you have any questions about this notice, please contact the Housing Department at ' + [hPhone, hEmail].filter(Boolean).join(' or ') + '.')
      : 'If you have any questions about this notice, please contact the Housing Department.';
    para(contact);
    para('Miigwetch for your cooperation.');
    ctx.gap(2.5);
    para('Sincerely,');
    // Blank space for the Housing Manager's handwritten signature, then a
    // signature line with the printed name/title beneath it.
    ctx.gap(11);
    ctx.needSpace(8);
    pdf.setDrawColor(120); pdf.setLineWidth(0.3); pdf.line(L, ctx.y, L + 72, ctx.y); pdf.setDrawColor(0);
    ctx.y += 3.2;
    para(hmName, { bold:true, color:20 });
    para('Housing Manager');
    para(nationName + ' — Housing Department');
    var sigBits = [];
    if (hPhone) sigBits.push('Phone: ' + hPhone);
    if (hEmail) sigBits.push('Email: ' + hEmail);
    if (sigBits.length) para(sigBits.join('   |   '));

    // Record of Notice (office use) — blank fields print nothing -------------
    sect('For Housing Office Use — Record of Notice (Housing Policy s. 13.9)');
    metaLine('Notice delivered by', delBy);
    metaLine('Date & time delivered', delAt);
    metaLine('Method of delivery', delMethod);
    metaLine('48-hour period ends', expiry);
    ctx.gap(3);
    pdf.setFont('helvetica','italic'); pdf.setFontSize(7.3); pdf.setTextColor(120);
    var authLines = pdf.splitTextToSize('Authority: ' + nationSh + ' Housing Policy, Version 5.8 — s. 13.9 (Inspections) and s. 13.1 (General Obligations).', CW);
    ctx.needSpace(authLines.length * 3.2 + 1);
    pdf.text(authLines, L, ctx.y + 2.4); ctx.y += authLines.length * 3.2;
    pdf.setTextColor(0); pdf.setFont('helvetica','normal');

    ctx.finish(); // draw footers (Page X of Y)

    var tenantSlug = (tenant || 'Tenant').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '') || 'Tenant';
    var filename   = nationSh.replace(/[^a-z0-9]+/gi, '') + '_Inspection_Notice_' + tenantSlug + '.pdf';

    // Download to browser
    pdf.save(filename);

    // Save to tenant document library
    var unit = _ticState.unit || {};
    var mo = document.getElementById('tic_inspnotice_modal');
    if (unit.id && typeof window.sbUploadFile === 'function') {
      try {
        var blob      = pdf.output('blob');
        var storePath = 'tenants/' + unit.id + '/' + Date.now() + '_' + filename;
        await window.sbUploadFile(storePath, blob);
        if (typeof window.sbSaveFileMeta === 'function') {
          await window.sbSaveFileMeta('tenant', String(unit.id), storePath, filename, blob.size, 'application/pdf');
        }
        _ticDocLibKey = null; _ticDocLib = null; // force doc-lib remount so it appears
        if (mo) mo.remove();
        if (typeof showToast === 'function') showToast('✓ Notice saved to document library', {type:'info'});
      } catch (e) {
        console.warn('[tic] inspection notice upload failed:', e);
        if (mo) mo.remove();
        if (typeof showToast === 'function') showToast('✓ Notice downloaded (document library save failed — see console)', {type:'error'});
      }
    } else {
      if (mo) mo.remove();
      if (typeof showToast === 'function') showToast('✓ Notice generated', {type:'info'});
    }
  }

  window._ticOpenInspectionNoticeModal   = _ticOpenInspectionNoticeModal;
  window._ticGenerateInspectionNoticePdf = _ticGenerateInspectionNoticePdf;

  // ════════════════════════════════════════════════════════════════════════════
  // Eviction Notices — Standard (s. 26.2) + Immediate (s. 26.3)
  // One modal + one PDF generator, parameterized by `kind`
  // ('standard' | 'immediate'). Both follow the same letterhead + record-of-
  // service layout as the inspection notice; the eviction notices run to two
  // pages, which _makePdfDoc handles (header redrawn + "Page X of Y" footers).
  // ════════════════════════════════════════════════════════════════════════════

  // Shared compact letter writers (mirrors the inspection notice's inline
  // writers). Blank meta values print just the label so a field can be
  // completed by hand on the printed copy.
  function _ticLetterWriters(ctx) {
    var pdf = ctx.pdf;
    var L = ctx.marginL, CW = ctx.contentW, RX = ctx.pageW - ctx.marginR;
    var BODY = 8.5, STEP = 3.5;
    function para(text, opts) {
      opts = opts || {};
      pdf.setFont('helvetica', opts.bold ? 'bold' : 'normal');
      pdf.setFontSize(opts.size || BODY);
      pdf.setTextColor(opts.color != null ? opts.color : 40);
      var lines = pdf.splitTextToSize(String(text), CW);
      ctx.needSpace(lines.length * STEP + 1.9);
      pdf.text(lines, L, ctx.y + 2.6);
      ctx.y += lines.length * STEP + 1.9;
      pdf.setTextColor(0); pdf.setFont('helvetica','normal');
    }
    function metaLine(label, val) {
      var v = (val == null ? '' : String(val)).trim();
      var lbl = label + ':';
      pdf.setFont('helvetica','bold'); pdf.setFontSize(BODY);
      var lw = pdf.getTextWidth(lbl + ' ');
      var vlines = v ? pdf.splitTextToSize(v, CW - lw) : [''];
      ctx.needSpace(vlines.length * STEP + 0.9);
      pdf.setTextColor(20); pdf.text(lbl, L, ctx.y + 2.6);
      if (v) { pdf.setFont('helvetica','normal'); pdf.setTextColor(40); pdf.text(vlines, L + lw, ctx.y + 2.6); }
      ctx.y += vlines.length * STEP + 0.9;
      pdf.setTextColor(0); pdf.setFont('helvetica','normal');
    }
    function bullet(text) {
      pdf.setFont('helvetica','normal'); pdf.setFontSize(BODY); pdf.setTextColor(40);
      var lines = pdf.splitTextToSize(String(text), CW - 5);
      ctx.needSpace(lines.length * STEP + 1.5);
      pdf.text('-', L + 1, ctx.y + 2.6);
      pdf.text(lines, L + 5, ctx.y + 2.6);
      ctx.y += lines.length * STEP + 1.5;
      pdf.setTextColor(0);
    }
    function sect(title) {
      ctx.needSpace(9); ctx.y += 2.6;
      pdf.setFont('helvetica','bold'); pdf.setFontSize(8.5); pdf.setTextColor(90);
      pdf.text(String(title).toUpperCase(), L, ctx.y + 2.6);
      pdf.setDrawColor(window._themeAccentHex()); pdf.setLineWidth(0.6);
      pdf.line(L, ctx.y + 3.6, RX, ctx.y + 3.6); pdf.setDrawColor(0);
      ctx.y += 5.6; pdf.setTextColor(0); pdf.setFont('helvetica','normal');
    }
    function signature(hmName, nationName, hPhone, hEmail) {
      para('Sincerely,');
      ctx.gap(11); ctx.needSpace(8);
      pdf.setDrawColor(120); pdf.setLineWidth(0.3); pdf.line(L, ctx.y, L + 72, ctx.y); pdf.setDrawColor(0);
      ctx.y += 3.2;
      para(hmName, { bold:true, color:20 });
      para('Housing Manager');
      para(nationName + ' — Housing Department');
      var bits = [];
      if (hPhone) bits.push('Phone: ' + hPhone);
      if (hEmail) bits.push('Email: ' + hEmail);
      if (bits.length) para(bits.join('   |   '));
    }
    return { para:para, metaLine:metaLine, bullet:bullet, sect:sect, signature:signature,
             L:L, CW:CW, RX:RX, BODY:BODY, STEP:STEP };
  }

  function _ticOpenEvictionNoticeModal(kind) {
    if (!_ticCanEvict()) { if (typeof showToast === 'function') showToast('Eviction notices are restricted to the Housing Manager or Executive Director', {type:'info'}); return; }
    var immediate = (kind === 'immediate');
    var k = immediate ? 'immediate' : 'standard';

    var t   = _ticState.tenant      || {};
    var u   = _ticState.unit        || {};
    var app = _ticState.application || {};
    var today = new Date().toISOString().split('T')[0];

    var tenantName = t[TIC_C.full_name] || ((app.fn||'') + ' ' + (app.ln||'')).trim();
    var unitAddr   = u.num ? ((u.num||'') + ' ' + (u.street||'')).trim() : (app.street||'');
    var hmName     = (window.HOUSING_SESSION && HOUSING_SESSION.name) || '';
    var nc         = window.NATION_CONFIG || {};
    var hPhone     = nc.phone || '';
    var hEmail     = nc.housing_email || nc.email || '';
    var fileRef    = u.id ? String(u.id) : '';

    var existing = document.getElementById('tic_eviction_modal');
    if (existing) existing.remove();

    function inp(id, val, ph, type) {
      return '<input id="' + id + '" type="' + (type||'text') + '" value="' + _ticEsc(val||'') + '" placeholder="' + _ticEsc(ph||'') + '" style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px;font-family:DM Sans,sans-serif;background:var(--surface);color:var(--text);box-sizing:border-box;"/>';
    }
    function ta(id, ph, rows) {
      return '<textarea id="' + id + '" rows="' + (rows||2) + '" placeholder="' + _ticEsc(ph||'') + '" style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px;font-family:DM Sans,sans-serif;background:var(--surface);color:var(--text);box-sizing:border-box;resize:vertical;"></textarea>';
    }
    function fld(label, inputHtml) {
      return '<div class="tic-field"><label class="tic-field-lbl">' + label + '</label>' + inputHtml + '</div>';
    }
    function req() { return ' <span style="color:var(--danger);">*</span>'; }
    function hdr(text) {
      return '<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:var(--yellow);margin:4px 0 12px;padding-bottom:5px;border-bottom:1px solid var(--border);">' + text + '</div>';
    }

    // Kind-specific timeline fields
    var timelineHtml = immediate
      ? ( hdr('Executive Director Approval &amp; Vacate (s. 26.3)')
        + '<div class="tic-grid-2" style="margin-bottom:16px;">'
        +   fld('Executive Director Name' + req(), inp('evx_ed_name', '', 'Full name of the ED'))
        +   fld('ED Approval Date' + req(),        inp('evx_ed_date', today, '', 'date'))
        +   fld('Vacate By (Date &amp; Time)' + req(), inp('evx_vacate', '', 'e.g. 2026-07-20 5:00 PM'))
        + '</div>' )
      : ( hdr('Response &amp; Timeline (s. 26.2)')
        + '<div class="tic-grid-2" style="margin-bottom:16px;">'
        +   fld('Response Deadline' + req(),   inp('evx_response', '', '', 'date'))
        +   fld('Vacate By (if eviction proceeds)', inp('evx_vacate', '', '', 'date'))
        + '</div>' );

    var titleLbl = immediate ? 'Notice of IMMEDIATE Eviction' : 'Notice of Eviction — Standard';
    var subLbl   = immediate
      ? 'Immediate safety risk (drug-related). Requires Executive Director approval.'
      : 'Standard eviction proceedings with an opportunity to respond.';

    var modal = document.createElement('div');
    modal.id = 'tic_eviction_modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.72);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px;';
    modal.innerHTML =
        '<div style="background:var(--surface);border-radius:12px;width:100%;max-width:720px;max-height:95vh;display:flex;flex-direction:column;box-shadow:0 8px 40px rgba(0,0,0,.35);">'
      + '<div class="modal-hdr"><div>'
      +   '<div class="lbl-yellow">&#128196; ' + _ticEsc(titleLbl) + '</div>'
      +   '<div class="txt-sm-meta">' + subLbl + ' Confirm the details below, then generate the PDF. It is filed to this tenant\'s documents.</div>'
      + '</div><button type="button" onclick="document.getElementById(\'tic_eviction_modal\').remove()" style="background:none;border:none;font-size:22px;cursor:pointer;color:var(--muted);">&times;</button></div>'

      + '<div style="overflow-y:auto;padding:20px 24px;flex:1;">'

      + hdr('Letter Details')
      + '<div class="tic-grid-2" style="margin-bottom:16px;">'
      +   fld('File Reference',           inp('evx_fileref',    fileRef,    'Optional reference'))
      +   fld('Letter Date',              inp('evx_letterdate', today,      '', 'date'))
      +   fld('Name of Tenant' + req(),   inp('evx_tenant',     tenantName, 'Full name of tenant'))
      +   fld('Housing Unit / Address',   inp('evx_address',    unitAddr,   'Unit address'))
      + '</div>'

      + hdr('Grounds &amp; Evidence (s. 26.1)')
      + '<div class="tic-grid-2" style="margin-bottom:12px;">'
      +   fld('Unit Inspected / Attended On', inp('evx_discovery_date', '', '', 'date'))
      +   fld('Discovered During',            inp('evx_discovery_method', 'inspection under Housing Policy s. 13.9', 'How it was discovered'))
      + '</div>'
      + fld('Description of Substances / Evidence Found', ta('evx_evidence', 'Describe what was found and where', 2))
      + '<div class="tic-grid-2" style="margin:12px 0 16px;">'
      +   fld('Person(s) Involved / Residing in Unit', inp('evx_persons', '', 'Names of persons involved'))
      +   fld('Referred to Police (NAPS) On',          inp('evx_police_date', '', '', 'date'))
      +   fld('Police File No.',                        inp('evx_police_file', '', 'NAPS file reference'))
      + '</div>'

      + timelineHtml

      + hdr('Signatory &amp; Contact')
      + '<div class="tic-grid-2" style="margin-bottom:16px;">'
      +   fld('Housing Manager' + req(), inp('evx_hm', hmName, 'Housing Manager name'))
      +   fld('Housing Phone',  inp('evx_phone', hPhone, 'Housing Department phone'))
      +   fld('Housing Email',  inp('evx_email', hEmail, 'Housing Department email'))
      + '</div>'

      + hdr('For Housing Office Use &mdash; Record of Service (optional)')
      + '<div class="tic-grid-2" style="margin-bottom:4px;">'
      +   fld('Notice Served By',       inp('evx_served_by', '', 'Staff name'))
      +   fld('Date &amp; Time Served', inp('evx_service_dt', '', 'e.g. 2026-07-17 2:15 PM'))
      +   fld('Method of Service',
            '<select id="evx_service_method" style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px;font-family:DM Sans,sans-serif;background:var(--surface);color:var(--text);box-sizing:border-box;">'
          +   '<option value="">&mdash; Select &mdash;</option>'
          +   '<option>hand-delivered</option><option>posted on door</option><option>registered mail</option><option>email</option>'
          + '</select>')
      +   fld('Executive Director Notified', inp('evx_ed_notified', '', 'e.g. Yes — 2026-07-17'))
      + '</div>'
      + '<div style="font-size:11px;color:var(--muted);margin-top:2px;">Leave the Record of Service blank to complete it by hand on the printed copy.</div>'
      + '</div>'

      // Footer
      + '<div style="padding:14px 24px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:10px;flex-shrink:0;">'
      +   '<button type="button" onclick="document.getElementById(\'tic_eviction_modal\').remove()" class="btn btn-ghost">Cancel</button>'
      +   '<button type="button" onclick="window._ticGenerateEvictionNoticePdf && window._ticGenerateEvictionNoticePdf(\'' + k + '\')" class="btn btn-primary">Generate PDF</button>'
      + '</div>'
      + '</div>';

    document.body.appendChild(modal);
  }

  async function _ticGenerateEvictionNoticePdf(kind) {
    if (!_ticCanEvict()) { if (typeof showToast === 'function') showToast('Eviction notices are restricted to the Housing Manager or Executive Director', {type:'info'}); return; }
    var immediate = (kind === 'immediate');
    if (typeof _loadJsPdf === 'function') await _loadJsPdf();
    if (!window.jspdf || !window.jspdf.jsPDF) { if (typeof showToast === 'function') showToast('PDF library unavailable', {type:'error'}); return; }

    var fv = function(id) { var e = document.getElementById(id); return e ? (e.value || '').trim() : ''; };
    function markRequired(id, on) { var e = document.getElementById(id); if (e) e.style.borderColor = on ? 'var(--danger)' : ''; }

    var tenant     = fv('evx_tenant');
    var address    = fv('evx_address');
    var fileRef    = fv('evx_fileref');
    var letterYmd  = fv('evx_letterdate');
    var discYmd    = fv('evx_discovery_date');
    var discMethod = fv('evx_discovery_method');
    var evidence   = fv('evx_evidence');
    var persons    = fv('evx_persons');
    var policeYmd  = fv('evx_police_date');
    var policeFile = fv('evx_police_file');
    var hmName     = fv('evx_hm');
    var hPhone     = fv('evx_phone');
    var hEmail     = fv('evx_email');
    var servedBy   = fv('evx_served_by');
    var serviceDt  = fv('evx_service_dt');
    var serviceMet = fv('evx_service_method');
    var edNotified = fv('evx_ed_notified');
    var vacate     = fv('evx_vacate');
    // kind-specific
    var edName     = fv('evx_ed_name');
    var edYmd      = fv('evx_ed_date');
    var responseYmd= fv('evx_response');

    // Validation
    var reqIds = immediate
      ? ['evx_tenant','evx_hm','evx_ed_name','evx_ed_date','evx_vacate']
      : ['evx_tenant','evx_hm','evx_response'];
    reqIds.forEach(function(id){ markRequired(id, false); });
    var missing = reqIds.filter(function(id){ return !fv(id); });
    if (missing.length) {
      missing.forEach(function(id){ markRequired(id, true); });
      var f = document.getElementById(missing[0]); if (f) f.focus();
      if (typeof showToast === 'function') {
        showToast(immediate
          ? 'Tenant, Housing Manager, ED name, ED approval date, and vacate date/time are required'
          : 'Tenant, Housing Manager, and response deadline are required', {type:'error'});
      }
      return;
    }

    var nationName = (typeof nationDisplay === 'function') ? nationDisplay() : ((window.NATION_CONFIG||{}).display_name || '');
    var nationSh   = (typeof nationShort   === 'function') ? nationShort()   : ((window.NATION_CONFIG||{}).short || nationName);
    var letterLong = _inspFmtDateLong(letterYmd) || _inspFmtDateLong(new Date().toISOString().split('T')[0]);
    var discLong   = _inspFmtDateLong(discYmd);
    var policeLong = _inspFmtDateLong(policeYmd);
    var edLong     = _inspFmtDateLong(edYmd);
    var respLong   = _inspFmtDateLong(responseYmd);
    var vacateLong = immediate ? vacate : _inspFmtDateLong(vacate); // immediate vacate is free-text date+time

    var logo = (typeof _fetchLogoForPdf === 'function') ? await _fetchLogoForPdf() : null;
    if (typeof _makePdfDoc !== 'function') { if (typeof showToast === 'function') showToast('PDF letterhead helper unavailable', {type:'error'}); return; }
    var ctx = _makePdfDoc({
      headerTitle:    immediate ? 'Notice of Immediate Eviction' : 'Notice of Eviction',
      headerSubtitle: immediate ? 'Housing Policy s. 26.3' : 'Housing Policy s. 26.2',
      logoDataUrl:    logo,
      footerLeft:     nationName + ' Housing Department — Confidential'
    });
    var W = _ticLetterWriters(ctx);
    var para = W.para, metaLine = W.metaLine, bullet = W.bullet, sect = W.sect;

    // Letter head block ------------------------------------------------------
    metaLine('File Reference', fileRef);
    metaLine('Date', letterLong);
    metaLine('Name of Tenant', tenant);
    metaLine('Housing Unit / Address', address);
    metaLine('Community', nationName);
    ctx.gap(3.5);

    var reLine = immediate
      ? 'RE: Notice of IMMEDIATE Eviction — Immediate Safety Risk from Drug-Related Criminal Activity'
      : 'RE: Notice of Eviction — Criminal Activity Involving Drugs in the Housing Unit';
    para(reLine, { bold:true, size:9.5, color:20 });
    ctx.gap(1.5);
    para('Dear ' + (tenant || 'Tenant') + ',');

    if (immediate) {
      para('This letter is formal written notice, under Section 26.3 of the ' + nationName + ' ("' + nationSh + '") Housing Policy, that the Housing Program has determined that your continued occupancy of the housing unit identified above presents an immediate and substantiated risk to the safety of others. As a result, you are being evicted immediately, without the standard notice and response period that would otherwise apply under Section 26.2.');
    } else {
      para('This letter is formal written notice, under Section 26 of the ' + nationName + ' ("' + nationSh + '") Housing Policy, that the Housing Program intends to initiate eviction proceedings in respect of the housing unit identified above. This notice sets out the grounds for eviction, your opportunity to respond, and your right to appeal, as required by Section 26.2 of the Housing Policy.');
    }

    // Grounds ----------------------------------------------------------------
    if (immediate) {
      sect('Grounds for Immediate Eviction (ss. 26.1 & 26.3)');
      para('Drugs and/or evidence of drug-related criminal activity were found in or in direct connection with your housing unit. The Housing Program has determined that this constitutes criminal activity within or directly connected to the housing unit (s. 26.1) and that continued occupancy presents an immediate and substantiated risk to the safety of others (s. 26.3). The determination is based on the following:');
    } else {
      sect('Grounds for Eviction (s. 26.1)');
      para('The Housing Program has determined that drugs and/or evidence of drug-related criminal activity were found in or in direct connection with your housing unit. The following grounds for eviction under Section 26.1 of the Housing Policy apply:');
      bullet('Criminal activity within or directly connected to the housing unit;');
      bullet('Non-compliance with the terms of your housing agreement and this Policy; and');
      bullet('Where a conviction is entered, conviction of selling drugs or alcohol from the Band housing unit.');
      ctx.gap(1);
      para('The determination is based on the following:');
    }
    metaLine('Housing unit inspected / attended on', discLong);
    metaLine('Discovered during', discMethod);
    metaLine('Description of substances / evidence found', evidence);
    metaLine('Person(s) involved / residing in unit', persons);
    metaLine('Referred to police (NAPS) on', policeLong);
    metaLine('Police file no.', policeFile);
    ctx.gap(1);
    if (immediate) {
      para('In keeping with the Housing Policy, this matter has been reported to the police.');
      sect('Executive Director Approval (s. 26.3)');
      para('As required by Section 26.3 of the Housing Policy, the decision to proceed with immediate eviction has been approved by the Executive Director, ' + edName + ', on ' + edLong + ', and has been documented in the housing file.');
      sect('You Are Required to Vacate');
      para('You are required to vacate the housing unit and return all keys by ' + vacateLong + '. You remain responsible for the unit, and for all rent and charges, until the unit is vacated and keys are returned. Any personal belongings must be removed by that time.');
      sect('Your Right to Appeal Is Preserved (ss. 26.3 & 29)');
      para('Although this is an immediate eviction, your right to appeal is preserved. An appeal must be submitted in writing to the Housing Manager within five (5) business days of this decision, must identify the specific grounds for appeal, and must include all relevant supporting information. Appeals are conducted in accordance with the Housing Governance and Administration Policy, Section 9. You have the right to appear before the appropriate authority with supporting witnesses and documentation. Filing an appeal does not, on its own, delay the requirement to vacate unless the appeal authority orders otherwise.');
    } else {
      para('Section 13.1 of the Housing Policy requires all tenants, as a condition of their housing agreement, to ensure that household members and guests conduct themselves in a manner that does not endanger others or damage the unit. In keeping with the Housing Policy, this matter has been reported to the police.');
      sect('Your Opportunity to Respond (s. 26.2)');
      para('Before any final decision to evict is made, you have a reasonable opportunity to respond to this notice in writing. Any response must be submitted to the Housing Manager on or before ' + respLong + '. You may include any explanation, information, or supporting documentation you wish the Housing Program to consider.');
      sect('What Happens Next');
      para('After the response date, the Housing Manager will review any response received and a decision will be made. If the decision is to proceed with eviction, you will be notified in writing of that decision and required to vacate the housing unit by ' + (vacateLong || 'a date specified in that decision') + '. You will remain responsible for the unit, and for all rent and charges, until the unit is vacated and keys are returned.');
      sect('Your Right to Appeal (s. 29)');
      para('If a decision to evict is made, you have the right to appeal. An appeal must be submitted in writing to the Housing Manager within five (5) business days of the decision, must identify the specific grounds for appeal, and must include all relevant supporting information. Appeals are conducted in accordance with the Housing Governance and Administration Policy, Section 9. You have the right to appear before the appropriate authority with supporting witnesses and documentation.');
    }

    var contact = (hPhone || hEmail)
      ? ('If you have any questions about this notice, please contact the Housing Department at ' + [hPhone, hEmail].filter(Boolean).join(' or ') + '.')
      : 'If you have any questions about this notice, please contact the Housing Department.';
    para(contact);
    ctx.gap(2.5);
    W.signature(hmName, nationName, hPhone, hEmail);

    // Record of Service (office use) -----------------------------------------
    sect('For Housing Office Use — Record of Service');
    metaLine('Notice served by', servedBy);
    metaLine('Date & time served', serviceDt);
    metaLine('Method of service', serviceMet);
    metaLine('Executive Director notified', edNotified);
    ctx.gap(3);
    var pdf = ctx.pdf, L = W.L, CW = W.CW;
    pdf.setFont('helvetica','italic'); pdf.setFontSize(7.3); pdf.setTextColor(120);
    var authTxt = immediate
      ? 'Authority: ' + nationSh + ' Housing Policy, Version 5.8 — s. 26.1 (Grounds for Eviction), s. 26.3 (Immediate Eviction), and s. 29 (Appeals). Immediate eviction requires Executive Director approval and must be documented.'
      : 'Authority: ' + nationSh + ' Housing Policy, Version 5.8 — s. 26.1 (Grounds for Eviction), s. 26.2 (Eviction Process), s. 13.1 (General Obligations), and s. 29 (Appeals).';
    var authLines = pdf.splitTextToSize(authTxt, CW);
    ctx.needSpace(authLines.length * 3.2 + 1);
    pdf.text(authLines, L, ctx.y + 2.4); ctx.y += authLines.length * 3.2;
    pdf.setTextColor(0); pdf.setFont('helvetica','normal');

    ctx.finish(); // draw footers (Page X of Y)

    var tenantSlug = (tenant || 'Tenant').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '') || 'Tenant';
    var filename   = nationSh.replace(/[^a-z0-9]+/gi, '') + '_Eviction_Notice_' + (immediate ? 'Immediate_' : 'Standard_') + tenantSlug + '.pdf';

    pdf.save(filename);

    // Save to tenant document library
    var unit = _ticState.unit || {};
    var mo = document.getElementById('tic_eviction_modal');
    if (unit.id && typeof window.sbUploadFile === 'function') {
      try {
        var blob      = pdf.output('blob');
        var storePath = 'tenants/' + unit.id + '/' + Date.now() + '_' + filename;
        await window.sbUploadFile(storePath, blob);
        if (typeof window.sbSaveFileMeta === 'function') {
          await window.sbSaveFileMeta('tenant', String(unit.id), storePath, filename, blob.size, 'application/pdf');
        }
        _ticDocLibKey = null; _ticDocLib = null; // force doc-lib remount so it appears
        if (mo) mo.remove();
        if (typeof showToast === 'function') showToast('✓ Eviction notice saved to document library', {type:'info'});
      } catch (e) {
        console.warn('[tic] eviction notice upload failed:', e);
        if (mo) mo.remove();
        if (typeof showToast === 'function') showToast('✓ Notice downloaded (document library save failed — see console)', {type:'error'});
      }
    } else {
      if (mo) mo.remove();
      if (typeof showToast === 'function') showToast('✓ Eviction notice generated', {type:'info'});
    }
  }

  window._ticOpenEvictionNoticeModal   = _ticOpenEvictionNoticeModal;
  window._ticGenerateEvictionNoticePdf = _ticGenerateEvictionNoticePdf;

  // ════════════════════════════════════════════════════════════════════════════
  // Replacement Lease Agreement (the legacy "No Appliances" house rental
  // agreement, reproduced verbatim with a "Replacement Lease Agreement" header).
  // Nation identity (name / committee / mailing block / province) comes from
  // NATION_CONFIG, never literals. Tenant name, address, and rent are pre-filled
  // from the card; dates / initials / signatures print as fill-in blanks.
  // ════════════════════════════════════════════════════════════════════════════
  // Data-entry modal — collects the fill-in fields, the Section-2 tenant
  // initials, and the Section-24 signatures using the app's shared sig/initial
  // pads (Draw / Type / Wet), then hands off to the generator.
  function _ticOpenReplacementLeaseModal() {
    var t = _ticState.tenant || {}, u = _ticState.unit || {}, app = _ticState.application || {};
    var tenantName = t[TIC_C.full_name] || ((app.fn||'') + ' ' + (app.ln||'')).trim();
    var streetName = u.num ? ((u.num||'') + ' ' + (u.street||'')).trim() : (app.street||'');
    var rentAmt = (u.monthlyRent != null ? u.monthlyRent : (u.monthly_rent != null ? u.monthly_rent : ''));
    rentAmt = (rentAmt !== '' && rentAmt != null && !isNaN(parseFloat(rentAmt))) ? parseFloat(rentAmt).toFixed(2) : '';
    var today = new Date().toISOString().split('T')[0];

    var ex = document.getElementById('tic_rlease_modal'); if (ex) ex.remove();

    function inp(id, val, ph, type){ return '<input id="' + id + '" type="' + (type||'text') + '" value="' + _ticEsc(val||'') + '" placeholder="' + _ticEsc(ph||'') + '" style="width:100%;padding:6px 9px;border:1px solid var(--border);border-radius:5px;font-size:12px;font-family:DM Sans,sans-serif;background:var(--surface);color:var(--text);box-sizing:border-box;"/>'; }
    function fld(label, html){ return '<div class="tic-field"><label class="tic-field-lbl">' + label + '</label>' + html + '</div>'; }
    function secH(title){ return '<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:var(--yellow);margin:16px 0 10px;padding-bottom:5px;border-bottom:1px solid var(--border);">' + title + '</div>'; }
    function initPad(id, label){
      return '<div class="sig-canvas-wrap"><div class="tab-bar">'
        + '<button type="button" onclick="setSigMethod(\'' + id + '\',\'canvas\')" id="' + id + '_tab_canvas" class="tab-item active">&#9999;&#65039; Draw</button>'
        + '<button type="button" onclick="setSigMethod(\'' + id + '\',\'type\')"   id="' + id + '_tab_type"   class="tab-item">&#9000;&#65039; Type</button>'
        + '<button type="button" onclick="setSigMethod(\'' + id + '\',\'wet\')"    id="' + id + '_tab_wet"    class="tab-item">&#128396; Wet</button>'
        + '</div>'
        + '<div id="' + id + '_panel_canvas" class="bg-paper"><canvas id="' + id + '" width="400" height="70" style="width:100%;height:70px;display:block;touch-action:none;cursor:crosshair;"></canvas>'
        + '<div style="display:flex;align-items:center;justify-content:space-between;padding:3px 10px;border-top:1px solid var(--border);">'
        + '<span class="txt-xs-muted">Initial with finger or mouse</span>'
        + '<button type="button" onclick="clearSig(\'' + id + '\')" style="background:none;border:1px solid var(--border);border-radius:5px;padding:2px 8px;font-size:10px;color:var(--muted);cursor:pointer;font-family:DM Sans,sans-serif;">Clear</button>'
        + '</div></div>'
        + '<div id="' + id + '_panel_type" class="sec-hidden"><input type="text" id="' + id + '_typed" placeholder="Type initials (e.g. JD)" style="width:100%;border:none;border-bottom:2px solid var(--dark);background:transparent;font-size:20px;font-family:Georgia,serif;font-style:italic;color:var(--text);outline:none;padding:4px 0;box-sizing:border-box;"/>'
        + '<div style="font-size:10px;color:var(--muted);margin-top:6px;">Typing your initials constitutes a legal electronic acknowledgement</div></div>'
        + '<div id="' + id + '_panel_wet" class="sec-hidden"><div style="font-size:11px;color:var(--muted);line-height:1.5;margin-bottom:8px;">Print this form and collect initials on paper.</div>'
        + '<input type="text" id="' + id + '_wet_ref" placeholder="Reference # (optional)" style="width:100%;padding:6px 9px;border:1px solid var(--border);border-radius:5px;font-size:12px;font-family:DM Sans,sans-serif;background:var(--surface);color:var(--text);box-sizing:border-box;"/></div>'
        + '</div>';
    }
    function sigPad(id, label){
      return '<div style="margin-bottom:14px;"><div class="tic-field-lbl" style="margin-bottom:6px;">' + label + '</div>'
        + '<div class="sig-canvas-wrap"><div class="tab-bar">'
        + '<button type="button" onclick="setSigMethod(\'' + id + '\',\'canvas\')" id="' + id + '_tab_canvas" class="tab-item active">&#9999;&#65039; Draw</button>'
        + '<button type="button" onclick="setSigMethod(\'' + id + '\',\'type\')"   id="' + id + '_tab_type"   class="tab-item">&#9000;&#65039; Type</button>'
        + '<button type="button" onclick="setSigMethod(\'' + id + '\',\'wet\')"    id="' + id + '_tab_wet"    class="tab-item">&#128396; Wet</button>'
        + '</div>'
        + '<div id="' + id + '_panel_canvas" class="bg-paper"><canvas id="' + id + '" width="600" height="90" style="width:100%;height:90px;display:block;touch-action:none;cursor:crosshair;"></canvas>'
        + '<div style="display:flex;align-items:center;justify-content:space-between;padding:4px 10px;border-top:1px solid var(--border);">'
        + '<span class="txt-xs-muted">Sign with finger or mouse</span>'
        + '<button type="button" onclick="clearSig(\'' + id + '\')" style="background:none;border:1px solid var(--border);border-radius:5px;padding:2px 8px;font-size:10px;color:var(--muted);cursor:pointer;font-family:DM Sans,sans-serif;">Clear</button>'
        + '</div></div>'
        + '<div id="' + id + '_panel_type" class="sec-hidden"><input type="text" id="' + id + '_typed" placeholder="Type full legal name" style="width:100%;border:none;border-bottom:2px solid var(--dark);background:transparent;font-size:18px;font-family:Georgia,serif;font-style:italic;color:var(--text);outline:none;padding:4px 0;box-sizing:border-box;"/>'
        + '<div style="font-size:10px;color:var(--muted);margin-top:6px;">Typing your name constitutes a legal electronic signature</div></div>'
        + '<div id="' + id + '_panel_wet" class="sec-hidden"><div style="font-size:11px;color:var(--muted);line-height:1.5;margin-bottom:8px;">Print this form and collect a wet signature, or attach a signed copy to this tenant\'s file.</div>'
        + '<input type="text" id="' + id + '_wet_ref" placeholder="Reference # or e-sign envelope ID (optional)" style="width:100%;padding:6px 9px;border:1px solid var(--border);border-radius:5px;font-size:12px;font-family:DM Sans,sans-serif;background:var(--surface);color:var(--text);box-sizing:border-box;"/></div>'
        + '</div></div>';
    }

    var INIT_LABELS = [
      '2(a) — Monthly rent payment',
      '2(b) — 15-day late payment fee ($25)',
      '2(c) — NSF fee ($45)',
      '2(d) — Rental arrears ($25)',
      '2(e) — Water and sewer ($16/month)',
      '2(f) — One-time maintenance deposit ($100)'
    ];

    var modal = document.createElement('div');
    modal.id = 'tic_rlease_modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.72);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px;';
    modal.innerHTML =
        '<div style="background:var(--surface);border-radius:12px;width:100%;max-width:700px;max-height:95vh;display:flex;flex-direction:column;box-shadow:0 8px 40px rgba(0,0,0,.35);">'
      + '<div class="modal-hdr"><div>'
      +   '<div class="lbl-yellow">&#128209; Replacement Lease Agreement</div>'
      +   '<div class="txt-sm-meta">Enter the details, collect the tenant initials and signatures, then generate. Files to this tenant\'s documents.</div>'
      + '</div><button type="button" onclick="var m=document.getElementById(\'tic_rlease_modal\');if(m)m.remove();" style="background:none;border:none;font-size:22px;cursor:pointer;color:var(--muted);">&times;</button></div>'
      + '<div style="overflow-y:auto;padding:18px 22px;flex:1;">'

      + secH('Parties &amp; Dates')
      + '<div class="tic-grid-2">'
      +   fld('Agreement / Lease Start Date', inp('rl_date', today, '', 'date'))
      +   fld('Tenant Name',       inp('rl_tenant', tenantName, 'Full legal name'))
      +   fld('Tenant P.O. Box',   inp('rl_pobox', '', 'Box #'))
      +   fld('Lot #',             inp('rl_lot', '', 'Lot number'))
      +   fld('Street Name',       inp('rl_street', streetName, 'e.g. 42 Wawaskashoo'))
      +   fld('Monthly Rent ($)',  inp('rl_rent', rentAmt, '0.00'))
      + '</div>'

      + secH('Required Tenant Initials (Section 2)')
      + '<div style="font-size:11px;color:var(--muted);margin-bottom:12px;">The tenant initials each payment term below.</div>'
      + INIT_LABELS.map(function(lb, i){
          return '<div style="margin-bottom:14px;"><div style="font-size:11px;font-weight:700;color:var(--text);margin-bottom:6px;">' + lb + '</div>' + initPad('rl_init_' + i, lb) + '</div>';
        }).join('')

      + secH('Signatures (Section 24)')
      + '<div class="tic-field-lbl" style="margin:4px 0 6px;font-weight:800;color:var(--text);">For the Landlord</div>'
      + sigPad('rl_sig_landlord', 'Landlord Signature')
      + '<div class="tic-grid-2">' + fld('Landlord Print Name', inp('rl_landlord_name', '', 'Name')) + fld('Date', inp('rl_landlord_date', today, '', 'date')) + '</div>'
      + '<div class="tic-field-lbl" style="margin:16px 0 6px;font-weight:800;color:var(--text);">For the Tenant(s)</div>'
      + sigPad('rl_sig_tenant', 'Tenant Signature')
      + '<div class="tic-grid-2">' + fld('Tenant Print Name', inp('rl_tenant_print', tenantName, 'Name')) + fld('Date', inp('rl_tenant_date', today, '', 'date')) + '</div>'
      + sigPad('rl_sig_tenant2', 'Second Tenant Signature (optional)')
      + '<div class="tic-grid-2">' + fld('Second Tenant Print Name', inp('rl_tenant2_print', '', 'Name')) + fld('Date', inp('rl_tenant2_date', '', '', 'date')) + '</div>'

      + '</div>'
      + '<div style="padding:14px 22px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:10px;flex-shrink:0;">'
      +   '<button type="button" onclick="var m=document.getElementById(\'tic_rlease_modal\');if(m)m.remove();" class="btn btn-ghost">Cancel</button>'
      +   '<button type="button" onclick="window._ticGenerateReplacementLeasePdf && window._ticGenerateReplacementLeasePdf()" class="btn btn-primary">Generate PDF</button>'
      + '</div>'
      + '</div>';

    document.body.appendChild(modal);
    var pads = ['rl_sig_landlord','rl_sig_tenant','rl_sig_tenant2','rl_init_0','rl_init_1','rl_init_2','rl_init_3','rl_init_4','rl_init_5'];
    setTimeout(function(){ if (typeof _initSigPad === 'function') pads.forEach(function(id){ _initSigPad(id); }); }, 80);
  }
  window._ticOpenReplacementLeaseModal = _ticOpenReplacementLeaseModal;

  async function _ticGenerateReplacementLeasePdf() {
    if (typeof _loadJsPdf === 'function') await _loadJsPdf();
    if (!window.jspdf || !window.jspdf.jsPDF) { if (typeof showToast === 'function') showToast('PDF library unavailable', {type:'error'}); return; }
    if (typeof _makePdfDoc !== 'function') { if (typeof showToast === 'function') showToast('PDF letterhead helper unavailable', {type:'error'}); return; }

    var fv = function(id){ var e = document.getElementById(id); return e ? (e.value||'').trim() : ''; };
    var sigVal = function(id){ return (typeof getSigDataURL === 'function') ? getSigDataURL(id) : ''; };
    var t = _ticState.tenant || {}, u = _ticState.unit || {}, app = _ticState.application || {};

    // Fields (from the modal; fall back to card data if the modal isn't open).
    var tenantName = fv('rl_tenant')  || t[TIC_C.full_name] || ((app.fn||'') + ' ' + (app.ln||'')).trim();
    var streetName = fv('rl_street')  || (u.num ? ((u.num||'') + ' ' + (u.street||'')).trim() : (app.street||''));
    var poBoxT     = fv('rl_pobox');
    var lotNum     = fv('rl_lot');
    var rentRaw    = fv('rl_rent') || (u.monthlyRent != null ? u.monthlyRent : (u.monthly_rent != null ? u.monthly_rent : ''));
    var _rentNum   = parseFloat(String(rentRaw).replace(/[^0-9.]/g, ''));
    var rent       = (!isNaN(_rentNum) && String(rentRaw).trim() !== '') ? _rentNum.toFixed(2) : '';

    // Agreement date → day / month / year parts for the intro + Section 3.
    var agDate = fv('rl_date');
    var dDay = '', dMonth = '', dYear = '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(agDate)) {
      var _dd = new Date(agDate + 'T12:00:00');
      if (!isNaN(_dd)) { dDay = String(_dd.getDate()); dMonth = _dd.toLocaleDateString('en-CA', { month:'long' }); dYear = String(_dd.getFullYear()); }
    }

    // Captured initials (Section 2 a–f) + signatures.
    var initCaps = [];
    for (var _ii = 0; _ii < 6; _ii++) initCaps.push(sigVal('rl_init_' + _ii));
    var sigLandlord = sigVal('rl_sig_landlord'), sigTenant = sigVal('rl_sig_tenant'), sigTenant2 = sigVal('rl_sig_tenant2');
    var landlordName = fv('rl_landlord_name'), landlordDate = fv('rl_landlord_date');
    var tenantPrint  = fv('rl_tenant_print') || tenantName, tenantDate = fv('rl_tenant_date');
    var tenant2Print = fv('rl_tenant2_print'), tenant2Date = fv('rl_tenant2_date');

    var nc         = window.NATION_CONFIG || {};
    var nationName = (typeof nationDisplay === 'function') ? nationDisplay() : (nc.display_name || '');
    var committee  = nc.landlord_committee || 'Housing Committee';
    var poBox      = nc.mailing_po_box || '';
    var postal     = nc.mailing_postal || '';
    var province   = nc.province || '';

    function blank(v, n){ v = (v == null ? '' : String(v)).trim(); return v || new Array((n||12) + 1).join('_'); }

    var logo = (typeof _fetchLogoForPdf === 'function') ? await _fetchLogoForPdf() : null;
    var ctx = _makePdfDoc({
      headerTitle:    'Replacement Lease Agreement',
      headerSubtitle: 'No Appliances',
      logoDataUrl:    logo,
      footerLeft:     nationName + ' Housing — Confidential'
    });
    var pdf = ctx.pdf;
    var L = ctx.marginL, CW = ctx.contentW, RX = ctx.pageW - ctx.marginR, CX = ctx.pageW / 2;
    var BODY = 10, STEP = 4.6;

    function para(text, o){
      o = o || {};
      pdf.setFont('helvetica', o.bold ? 'bold' : 'normal');
      pdf.setFontSize(o.size || BODY);
      pdf.setTextColor(o.color != null ? o.color : 20);
      var indent = o.indent || 0;
      var lines = pdf.splitTextToSize(String(text), CW - indent);
      ctx.needSpace(lines.length * STEP + (o.after != null ? o.after : 2));
      if (o.center)     pdf.text(lines, CX, ctx.y + 3, { align:'center' });
      else if (o.right) pdf.text(lines, RX, ctx.y + 3, { align:'right' });
      else              pdf.text(lines, L + indent, ctx.y + 3);
      ctx.y += lines.length * STEP + (o.after != null ? o.after : 2);
      pdf.setTextColor(0); pdf.setFont('helvetica','normal');
    }
    function gap(mm){ ctx.y += mm; }
    function titleBlock(){
      pdf.setFont('helvetica','bold'); pdf.setFontSize(15); pdf.setTextColor(0);
      var tt = 'RESIDENTIAL HOUSE RENTAL AGREEMENT';
      pdf.text(tt, CX, ctx.y + 5, { align:'center' });
      var tw = pdf.getTextWidth(tt);
      pdf.setLineWidth(0.4); pdf.line(CX - tw/2, ctx.y + 6.5, CX + tw/2, ctx.y + 6.5);
      ctx.y += 8;
      pdf.setFontSize(13); pdf.text("(No Appliance's)", CX, ctx.y + 5, { align:'center' });
      ctx.y += 11; pdf.setFont('helvetica','normal');
    }
    function secHead(n, title){
      ctx.needSpace(STEP + 5); ctx.y += 3;
      pdf.setFont('helvetica','bold'); pdf.setFontSize(BODY); pdf.setTextColor(0);
      pdf.text(String(n) + '.', L, ctx.y + 3);
      pdf.text(title, L + 9, ctx.y + 3);
      ctx.y += STEP + 1.5; pdf.setFont('helvetica','normal');
    }
    // Hanging-indent lettered/numbered clause.
    function clause(marker, text, indent){
      indent = (indent == null) ? 9 : indent;
      var mx = L + indent, tx = L + indent + 9, tw = CW - indent - 9;
      pdf.setFont('helvetica','normal'); pdf.setFontSize(BODY); pdf.setTextColor(20);
      var lines = pdf.splitTextToSize(String(text), tw);
      ctx.needSpace(lines.length * STEP + 2.5);
      pdf.text(String(marker), mx, ctx.y + 3);
      pdf.text(lines, tx, ctx.y + 3);
      ctx.y += lines.length * STEP + 2.5;
      pdf.setTextColor(0);
    }
    // Draw a captured initial (image / typed / wet / blank) after a payment clause.
    function embedInitial(cap){
      ctx.needSpace(9);
      var lx = L + 18;
      pdf.setFont('helvetica','normal'); pdf.setFontSize(BODY); pdf.setTextColor(20);
      pdf.text('Initial:', lx, ctx.y + 3);
      var vx = lx + pdf.getTextWidth('Initial:  ');
      if (cap && cap.indexOf('data:image/png') === 0) { try { pdf.addImage(cap, 'PNG', vx, ctx.y - 3, 20, 8); } catch(e){} }
      else if (cap && cap.indexOf('typed:') === 0) { pdf.setFont('helvetica','italic'); pdf.setFontSize(12); pdf.text(cap.replace('typed:',''), vx, ctx.y + 3); pdf.setFont('helvetica','normal'); pdf.setFontSize(BODY); }
      else if (cap && cap.indexOf('wet:') === 0) { pdf.setTextColor(90); pdf.text('(initialed on paper)', vx, ctx.y + 3); pdf.setTextColor(20); }
      else { pdf.setDrawColor(150); pdf.setLineWidth(0.3); pdf.line(vx, ctx.y + 3, vx + 28, ctx.y + 3); pdf.setDrawColor(0); }
      ctx.y += 8; pdf.setTextColor(0);
    }
    // Signature line with a captured signature image / typed name / value drawn on it.
    function sigLineVal(x, label, w, sigCap, textVal){
      pdf.setFont('helvetica','normal'); pdf.setFontSize(BODY); pdf.setTextColor(20);
      pdf.text(label, x, ctx.y + 3);
      var lx = x + pdf.getTextWidth(label + ' '), lineY = ctx.y + 4, avail = (x + w) - lx;
      if (sigCap && sigCap.indexOf('data:image/png') === 0) { try { pdf.addImage(sigCap, 'PNG', lx, lineY - 9, Math.min(avail, 46), 9); } catch(e){} }
      else if (sigCap && sigCap.indexOf('typed:') === 0) { pdf.setFont('helvetica','italic'); pdf.setFontSize(14); pdf.text(sigCap.replace('typed:',''), lx, lineY - 1); pdf.setFont('helvetica','normal'); pdf.setFontSize(BODY); }
      else if (sigCap && sigCap.indexOf('wet:') === 0) { pdf.setFontSize(8); pdf.setTextColor(90); pdf.text('wet signature on file', lx, lineY - 1); pdf.setFontSize(BODY); pdf.setTextColor(20); }
      else if (textVal) { pdf.text(String(textVal), lx, lineY - 1); }
      pdf.setDrawColor(120); pdf.setLineWidth(0.3); pdf.line(lx, lineY, x + w, lineY); pdf.setDrawColor(0);
      pdf.setTextColor(0);
    }

    // ── Title + intro ───────────────────────────────────────────────────────
    titleBlock();
    para('THIS HOUSE RENTAL AGREEMENT (hereinafter the "Agreement") is entered into on this ' + blank(dMonth, 10) + ' of ' + blank(dDay, 8) + ', ' + blank(dYear, 6) + ' between:', { after:3 });

    para('The Lessor:', { bold:true });
    para(nationName.toUpperCase(), { center:true, bold:true, after:1 });
    para(committee, { center:true, bold:true, after:1 });
    if (poBox)   para(poBox, { center:true, after:1 });
    para(nationName.toUpperCase() + (province ? ', ' + province.toUpperCase().slice(0,2) : ''), { center:true, after:1 });
    if (postal)  para(postal, { center:true, after:1 });
    para('(Called the "Landlord")', { right:true, after:3 });

    para('and the Lessee:', { bold:true });
    para(blank(tenantName, 24), { center:true, after:1 });
    para('of ' + nationName.toUpperCase(), { center:true, after:1 });
    para('P.O. Box ' + blank(poBoxT, 8) + ',', { center:true, after:1 });
    para(nationName.toUpperCase() + (province ? ', ' + province.toUpperCase().slice(0,2) : ''), { center:true, after:1 });
    if (postal)  para(postal, { center:true, after:1 });
    para('(Called the "Tenant")', { right:true, after:3 });

    para('In regards to the Property:', { bold:true });
    para('Lot # ' + blank(lotNum, 8), { center:true, after:1 });
    para('Street name: ' + blank(streetName, 18), { center:true, after:1 });
    para(nationName + ', ' + (province || 'Ontario'), { center:true, bold:true, after:1 });
    para('(Called the "Residence")', { right:true, after:3 });

    para('The Housing Authority and Tenant do hereby agree to abide by the terms set out in this Agreement. The terms of this Agreement are as follows:', { after:2 });

    // ── 1. USE of the RESIDENCE ─────────────────────────────────────────────
    secHead(1, 'USE of the RESIDENCE:');
    clause('a.', 'In consideration of the rent payment to be paid by Tenant and of the other covenants and agreements herein contained, the Landlord rents the Residence to the Tenant.');
    clause('b.', 'Tenant shall use the Residence only for residential purposes.');
    clause('c.', "Tenant shall not use or allow the use of the premises in any way that interferes with other tenants' use and enjoyment of the premises or neighboring property.");
    clause('d.', 'Tenants shall not use the Residence for any illegal or improper use.');
    clause('e.', 'Additionally, the Tenant agrees that the Residence may be a smoking environment. The Tenant agrees shall be liable to the Landlord for any damage and liability that may arise as a result of smoking.');

    // ── 2. PAYMENT SCHEDULE AND DETAILS ─────────────────────────────────────
    secHead(2, 'PAYMENT SCHEDULE AND DETAILS');
    clause('a)', 'The Tenant agrees to pay the Landlord $ ' + blank(rent, 8) + ' (CDN), monthly. Payments shall be made on or before the first of every calendar month of during the entire length of this Agreement. Payments shall be made to the: ' + nationName + '.');
    embedInitial(initCaps[0]);
    clause('b)', 'Should a Tenant’s payment be 15 days late, the Tenant shall be subject to a $ 25.00 late payment fee as a penalty.');
    embedInitial(initCaps[1]);
    clause('c)', 'The Tenant agrees to pay a $45.00 fee for non-sufficient funds (NSF) fees when a cheque does not clear at the financial institution.');
    embedInitial(initCaps[2]);
    clause('d)', 'The Tenant shall pay Rental Arrears of $25.00.');
    embedInitial(initCaps[3]);
    clause('e)', 'The Tenant shall pay Water and Sewer rate of $16.00 per month.');
    embedInitial(initCaps[4]);
    clause('f)', 'The Tenant shall pay a 1 time fee for Maintenance Deposit of $100.00.');
    embedInitial(initCaps[5]);

    // ── 3. LENGTH OF AGREEMENT ──────────────────────────────────────────────
    secHead(3, 'LENGTH OF AGREEMENT');
    clause('a.', 'This Agreement shall commence until at which time either party decides to dissolve said agreement on ' + blank(dDay, 6) + ' day of ' + blank(dMonth, 10) + ', ' + blank(dYear, 6) + '.');

    // ── 4. TERMINATION ──────────────────────────────────────────────────────
    secHead(4, 'TERMINATION');
    clause('a.', 'After the anniversary date, either party may terminate this Agreement by giving written notice to the other no later than the first day of the calendar month on which the party wishes to terminate the agreement. The premises shall be considered vacated only after all areas including storage areas are clear of all Tenant belongings, and keys and other property furnished for Tenant use are returned to Landlord.');
    clause('b.', "Should the Tenant continue beyond the termination date or fail to vacate all possessions on or before the termination date, Tenant shall be liable for additional rent and damages, which may include damages due to the Landlord’s loss of prospective new renters.");

    // ── 5. DEFAULT ──────────────────────────────────────────────────────────
    secHead(5, 'DEFAULT');
    clause('a.', "It is understood and agreed that if the Tenant fails to fulfill or perform any obligation under this Agreement, the Tenant shall be considered to be in default of this Agreement. The Tenant shall receive 15 days’ notice by Landlord to remedy the default (i.e. non-payment of rent).");
    clause('b.', "In the event the Tenant does not remedy a default for which he or she has been given notice by the Landlord under this Article, the Landlord may, at Landlord’s sole discretion, remedy such default and the cost of so doing will be added to the Tenant’s payments under this Agreement, or declare the Tenant in default of the Agreement.");
    clause('c.', 'The Landlord may re-enter the premises and re-possession of the premises in the event of default. After default, the Tenant may be held liable for the balance of the unpaid rent under this Agreement if Landlord cannot re-let the House during the remaining term of this Agreement.');

    // ── 6. ENFORCING OUR RIGHTS ─────────────────────────────────────────────
    secHead(6, 'ENFORCING OUR RIGHTS');
    clause('a.', "It is understood and agreed upon that the Tenant(s)’ right to continue in occupancy of the Residence rental is conditional upon the continued payment of the monthly payments as stipulated in this Agreement. Upon failure to make such monthly payments, this Agreement shall terminate immediately and all the Tenant’s rights hereunder shall be forfeited.");
    clause('b.', 'The Landlord may enforce its right to be paid the total balance due under this Agreement by:');
    clause('1.', 'Taking legal action for what (s)he owes', 18);
    clause('2.', 'Taking possession of the Residence or', 18);
    clause('3.', 'Both (a) and (b)', 18);

    // ── 7. TENANT RESPONSIBILITIES ──────────────────────────────────────────
    secHead(7, 'TENANT RESPONSIBILITIES');
    clause('a.', 'The Tenant shall comply with all obligations imposed upon tenants by applicable provisions of building, housing, and health codes; maintain the Premises in good condition during the entire length of this Agreement and shall neither cause nor allow any abuse of the facilities therein.');
    clause('b.', 'The Tenant shall inform the Landlord of any condition that may cause damage to the Premises. If the Premises, or any part of the Premises, is partially damaged by fire or other casualty not due to the negligence or willful act of the Tenant or an agent of the Tenant, the Premises will be repaired by the Landlord.');
    clause('c.', 'Upon the termination or expiry of this Agreement the Tenant shall redeliver the property, appliances and any other applicable aspects of the Unit, in as good condition as at the commencement of the Agreement. Reasonable wear and tear from use to the Unit shall be accepted.');

    // ── 8. HOUSE ALTERATIONS ────────────────────────────────────────────────
    secHead(8, 'HOUSE ALTERATIONS');
    clause('a.', 'Tenant shall make no alterations, additions or improvements to the Premises (including the application of paints, stains, nails or screws to the woodwork, walls, floors or furnishings) without first obtaining the express written consent of the Landlord.');
    clause('b.', 'All alterations must be approved by the Landlord. All drawings of the alterations shall be kept on file at the office of the Landlord.');

    // ── 9. INSURANCE ────────────────────────────────────────────────────────
    secHead(9, 'INSURANCE');
    clause('a.', "Tenant acknowledges that Landlord’s insurance does not cover personal property damage caused by fire, theft, rain, war, acts of God, acts of others, and/or any other causes, nor shall Housing Authority be held liable for such losses.");
    clause('b.', 'The Tenant is responsible to obtain their own insurance policy to cover any personal liability losses occasioned by damaged to the Premises i.e. life insurance, content insurance.');

    // ── 10. ENTRY FOR REPAIRS OR SHOW ───────────────────────────────────────
    secHead(10, 'ENTRY FOR REPAIRS OR SHOW');
    clause('a.', 'The Landlord shall have the right to enter the Unit at all reasonable times for the purpose of inspecting the and/or showing the same to prospective tenants, and to make such reasonable repairs and alterations as may be deemed necessary by the Landlord for the preservation of the Unit or the building and to remove any alterations, additions, fixtures, and any other objects which may be affixed or erected in violation of the terms of this Agreement.');
    clause('b.', 'The Landlord shall give reasonable notice of intent to enter Premises, except in the case of an emergency.');

    // ── 11. QUIET ENJOYMENT ─────────────────────────────────────────────────
    secHead(11, 'QUIET ENJOYMENT');
    clause('a.', 'The Tenant shall be entitled to quiet enjoyment of the Unit for the term of this Agreement provided that the Tenant performs all covenants and obligations under this Agreement.');

    // ── 12. POSSESSION AND SURRENDER OF THE AGREEMENT ───────────────────────
    secHead(12, 'POSSESSION AND SURRENDER OF THE AGREEMENT');
    clause('a.', 'At the expiration of the Agreement Term, Tenant shall immediately surrender the Unit to the Landlord in the same condition as at the start of the Agreement, reasonable wear and tear elements are accepted.');
    clause('b.', 'The Tenant shall return the complete set of keys to the Landlord.');
    clause('c.', "If any Tenant remains on the Premises after the expiration or termination of this Agreement without the Landlord’s written permission, the Landlord may recover possession of the Premises in the manner provided for by law.");

    // ── 13. ABANDONMENT ─────────────────────────────────────────────────────
    secHead(13, 'ABANDONMENT');
    clause('a.', 'Abandonment is defined as absence of the Tenant from the premises for a period of seven (7) or more consecutive days while monthly payments or other payments under this Agreement remain unpaid, whereupon Tenant will be considered in breach of this Agreement.');
    clause('b.', 'If the Tenant abandons the Unit during the term of this Agreement, the Landlord may enter the Unit by any legal means, without being liable for such entering, and without becoming liable to the Tenant for damages caused upon entering. Landlord may consider any personal property belonging to the Tenant and left on the property to have been abandoned, in which case the Landlord may dispose of all such personal property in any manner the Landlord deems proper without becoming liable to the Tenant for doing so.');
    clause('c.', 'In case of abandonment as defined by this Agreement, the Landlord may, at its option, terminate the Agreement and re-let the Unit, and may receive and collect all payments payable by virtue of such re-letting. Should this Agreement continue in force, the Landlord may hold the Tenant liable for any difference between the rent that would have been payable under this Agreement during the balance of the unexpired term and the net rent for such period that would have been realized by the Landlord by means of the re-letting.');

    // ── 14. LEGAL FEES ──────────────────────────────────────────────────────
    secHead(14, 'LEGAL FEES');
    clause('a.', 'If the Tenant is in breach of this Agreement, and the Landlord finds it necessary to enforce this Agreement, or collect rental or other damages, through a collection agency or by virtue of other legal action, the Landlord shall be indemnified by the Tenant for any reasonable legal fees and out-or-pocket costs which in any way relate to, or were precipitated by, the breach of this Agreement by the Tenant.');

    // ── 15. WAIVER ──────────────────────────────────────────────────────────
    secHead(15, 'WAIVER');
    clause('a.', "The Landlord’s failure to enforce or insist on compliance with any provisions of this Agreement shall not be deemed a waiver or a limitation of the Landlord’s right to enforce or insist on compliance with the provisions of this Agreement.");

    // ── 16. BINDING EFFECT ──────────────────────────────────────────────────
    secHead(16, 'BINDING EFFECT');
    clause('a.', 'Except as otherwise provided in this Agreement, all of the covenants, conditions, and provisions of this Agreement shall apply to and bind the parties and the heirs, personal representatives, successors, and assigns of the parties.');

    // ── 17. HEADINGS ────────────────────────────────────────────────────────
    secHead(17, 'HEADINGS');
    clause('a.', 'Headings are inserted for the convenience of the parties only and are not to be considered when interpreting this Agreement.');

    // ── 18. ASSIGNMENT, SUB-LET AND LICENSES ────────────────────────────────
    secHead(18, 'ASSIGNMENT, SUB-LET AND LICENSES');
    clause('a.', 'The Tenant shall not assign this Agreement, or sub-let or grant any license to use the Unit or any part thereof without the prior written consent of the Landlord.');
    clause('b.', 'Consent by the Landlord to one such assignment, sub-letting or license shall not be deemed to be a consent to any subsequent assignment, sub-letting or license.');
    clause('c.', 'An assignment, sub-letting or license without the prior written consent of the Landlord or an assignment or sub-letting by operation of law shall be absolutely null and void and may, at the Landlord option, result in immediate termination of this Agreement.');

    // ── 19. AMENDMENT OF AGREEMENT ──────────────────────────────────────────
    secHead(19, 'AMENDMENT OF AGREEMENT');
    clause('a.', 'Any amendment or modification of this Agreement, or additional obligation assumed by either party that is not specified in this Agreement will only be binding if evidenced in writing signed by both parties.');

    // ── 20. ENTIRE AGREEMENT ────────────────────────────────────────────────
    secHead(20, 'ENTIRE AGREEMENT');
    clause('a.', 'This Agreement constitutes the entire agreement between the parties and supercedes any prior written or oral covenants or representations relating thereto and not set forth herein shall be binding on either party hereto. This Agreement may not be amended, modified, extended, or supplemented except by written instrument executed by the Landlord and Tenant. The Landlord has made no representation or warranty to Tenant except as herein expressly set forth.');

    // ── 21. SEVERABILITY ────────────────────────────────────────────────────
    secHead(21, 'SEVERABILITY');
    clause('a.', 'In the event any of the provisions of this Agreement are held to be invalid or unenforceable in whole or in part, those provisions to the extent enforceable and all other provisions will nevertheless continue to be valid and enforceable as though the invalid or unenforceable parts had not been included in this Agreement.');

    // ── 22. GOVERNING LAW ───────────────────────────────────────────────────
    secHead(22, 'GOVERNING LAW');
    clause('a.', 'This Agreement shall be governed and construed in accordance with the laws of the Province of ' + (province || 'Ontario') + ' or Canada, as applicable.');

    // ── 23. THE LAND ────────────────────────────────────────────────────────
    secHead(23, 'THE LAND');
    clause('a.', 'The Tenant agrees that this Agreement does not attach to the land upon which the Unit sits, and is not an Agreement to rent or lease such land.');

    // ── 24. SIGNATURES ──────────────────────────────────────────────────────
    secHead(24, 'SIGNATURES');
    clause('a.', 'The parties hereby indicate by their signatures below that they have read and agree with the terms and conditions of this Agreement in its entirety.');
    gap(4);
    ctx.needSpace(72);
    var colGap = 12, colW = (CW - colGap) / 2, cxL = L, cxR = L + colW + colGap;
    pdf.setFont('helvetica','bold'); pdf.setFontSize(BODY); pdf.setTextColor(0);
    pdf.text('For the Landlord', cxL, ctx.y + 3);
    pdf.text('For the Tenant(s)', cxR, ctx.y + 3);
    ctx.y += 13; pdf.setFont('helvetica','normal');
    sigLineVal(cxL, 'Signature:', colW, sigLandlord, ''); sigLineVal(cxR, 'Signature:', colW, sigTenant, '');  ctx.y += 12;
    sigLineVal(cxL, 'Print:',     colW, '', landlordName); sigLineVal(cxR, 'Print:',     colW, '', tenantPrint); ctx.y += 12;
    sigLineVal(cxL, 'Date:',      colW, '', landlordDate); sigLineVal(cxR, 'Signature:', colW, sigTenant2, '');  ctx.y += 12;
    sigLineVal(cxR, 'Print:',     colW, '', tenant2Print); ctx.y += 12;
    sigLineVal(cxR, 'Date:',      colW, '', tenantDate);   ctx.y += 6;

    ctx.finish();

    var slug = (tenantName || 'Tenant').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '') || 'Tenant';
    var nationSh = (typeof nationShort === 'function') ? nationShort() : (nc.short || 'Nation');
    var filename = nationSh.replace(/[^a-z0-9]+/gi, '') + '_Replacement_Lease_' + slug + '.pdf';
    pdf.save(filename);

    var mo = document.getElementById('tic_rlease_modal');
    if (u.id && typeof window.sbUploadFile === 'function') {
      try {
        var blob = pdf.output('blob');
        var storePath = 'tenants/' + u.id + '/' + Date.now() + '_' + filename;
        await window.sbUploadFile(storePath, blob);
        if (typeof window.sbSaveFileMeta === 'function') {
          await window.sbSaveFileMeta('tenant', String(u.id), storePath, filename, blob.size, 'application/pdf');
        }
        _ticDocLibKey = null; _ticDocLib = null;
        if (mo) mo.remove();
        if (typeof showToast === 'function') showToast('✓ Replacement lease saved to document library', {type:'info'});
      } catch (e) {
        console.warn('[tic] replacement lease upload failed:', e);
        if (mo) mo.remove();
        if (typeof showToast === 'function') showToast('✓ Lease downloaded (document library save failed — see console)', {type:'error'});
      }
    } else {
      if (mo) mo.remove();
      if (typeof showToast === 'function') showToast('✓ Replacement lease generated', {type:'info'});
    }
  }
  window._ticGenerateReplacementLeasePdf = _ticGenerateReplacementLeasePdf;

  // ════════════════════════════════════════════════════════════════════════════
  // Set Location & Photo (SLP) — Admin Workflow
  // Requires APPROVAL_AUTHORITY.can('setUnitLocation', role).
  // Self-contained: _slpEnsureModal() dynamically injects the overlay HTML and
  // lazy-loads Leaflet + exifr on any page that shares housing-tic.js.
  // tenants.html has the static overlay in DOM and scripts in <head> — both are
  // detected and skipped so there is no double-load or double-wire.
  // Photos upload to housing-files bucket under units/{id}/photo/.
  // photo_url column stores the path; sbGetFileUrl() resolves it at render time.
  // ════════════════════════════════════════════════════════════════════════════

  var _slpMap    = null;
  var _slpMarker = null;
  var _slpLat    = null;
  var _slpLng    = null;
  var _slpFile   = null;
  var _slpWired  = false;
  var _CLFN_LAT  = 49.8063;
  var _CLFN_LNG  = -84.1434;

  var _SLP_MODAL_HTML = '<div class="slp-modal">'
    + '<div class="slp-header">'
    +   '<div><div class="slp-header-label">Admin</div>'
    +   '<div class="slp-header-title">Set Unit Location &amp; Photo</div></div>'
    +   '<button class="slp-close" id="slp-close" aria-label="Close">&#x2715;</button>'
    + '</div>'
    + '<div class="slp-body">'
    +   '<div class="slp-photo-col">'
    +     '<div class="slp-section-label">House Photo</div>'
    +     '<div class="slp-dropzone" id="slp-dropzone">'
    +       '<div class="slp-dropzone-inner" id="slp-dropzone-inner">'
    +         '<span class="slp-dropzone-icon">&#127968;</span>'
    +         '<p class="slp-dropzone-text">Drop photo here<br>or click to browse</p>'
    +         '<p class="slp-dropzone-hint">JPEG &middot; PNG &middot; HEIC</p>'
    +       '</div>'
    +       '<img class="slp-photo-preview" id="slp-photo-preview" src="" alt="House photo preview" style="display:none;"/>'
    +       '<input type="file" id="slp-file-input" accept="image/jpeg,image/png,image/heic,image/heif" style="display:none;"/>'
    +     '</div>'
    +     '<div class="slp-exif-banner slp-exif-found" id="slp-exif-found" style="display:none;">'
    +       '<span>&#9989;</span>'
    +       '<div><strong>GPS found in photo</strong><div id="slp-exif-coords-text">&#8212;</div></div>'
    +     '</div>'
    +     '<div class="slp-exif-banner slp-exif-none" id="slp-exif-none" style="display:none;">'
    +       '<span>&#9888;&#65039;</span>'
    +       '<div><strong>No GPS in this photo</strong><div>Drop a pin on the map manually.</div></div>'
    +     '</div>'
    +     '<button class="slp-remove-photo" id="slp-remove-photo" style="display:none;">&#x2715; Remove photo</button>'
    +     '<div class="slp-section-label" style="margin-top:20px;">Coordinates</div>'
    +     '<div class="slp-coords-row">'
    +       '<div class="slp-coord-field"><label>Latitude</label>'
    +       '<input type="text" id="slp-lat-display" readonly placeholder="Drop a pin"/></div>'
    +       '<div class="slp-coord-field"><label>Longitude</label>'
    +       '<input type="text" id="slp-lng-display" readonly placeholder="Drop a pin"/></div>'
    +     '</div>'
    +     '<button class="slp-geolocate-btn" id="slp-geolocate">&#127919; Use my current location</button>'
    +   '</div>'
    +   '<div class="slp-map-col">'
    +     '<div class="slp-section-label">Pin Location'
    +       '<span class="slp-map-hint">Click map to place pin</span>'
    +     '</div>'
    +     '<div id="slp-map"></div>'
    +     '<p class="slp-map-note">OSM tiles &middot; No address data sent externally</p>'
    +   '</div>'
    + '</div>'
    + '<div class="slp-footer">'
    +   '<button class="slp-btn-cancel" id="slp-cancel">Cancel</button>'
    +   '<button class="slp-btn-save" id="slp-save" disabled>Save Location &amp; Photo</button>'
    + '</div>'
    + '</div>';

  function _slpLoadScript(src, cb) {
    var s = document.createElement('script');
    s.src = src;
    s.onload = cb;
    s.onerror = function(){ console.error('[SLP] Script load failed:', src); cb(); };
    document.head.appendChild(s);
  }

  function _slpEnsureModal(cb) {
    var overlay = document.getElementById('slp-overlay');
    if(!overlay) {
      if(!document.getElementById('slp-leaflet-css')) {
        var link = document.createElement('link');
        link.id   = 'slp-leaflet-css';
        link.rel  = 'stylesheet';
        link.href = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css';
        document.head.appendChild(link);
      }
      overlay = document.createElement('div');
      overlay.className = 'slp-overlay';
      overlay.id        = 'slp-overlay';
      overlay.setAttribute('style', 'display:none;');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('role', 'dialog');
      overlay.innerHTML = _SLP_MODAL_HTML;
      document.body.appendChild(overlay);
    }

    var pending = 0;
    function done() { if(--pending === 0) { _slpWireEvents(); cb(overlay); } }
    if(typeof L === 'undefined') {
      pending++;
      _slpLoadScript('https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js', done);
    }
    if(typeof exifr === 'undefined') {
      pending++;
      _slpLoadScript('https://cdn.jsdelivr.net/npm/exifr/dist/lite.umd.js', done);
    }
    if(pending === 0) { _slpWireEvents(); cb(overlay); }
  }

  function _slpWireEvents() {
    if(_slpWired) return;
    _slpWired = true;
    var overlay   = document.getElementById('slp-overlay');
    if(!overlay) return;
    var btnClose  = document.getElementById('slp-close');
    var btnCancel = document.getElementById('slp-cancel');
    var btnSave   = document.getElementById('slp-save');
    var btnGeo    = document.getElementById('slp-geolocate');
    var btnRemove = document.getElementById('slp-remove-photo');
    var fileInput = document.getElementById('slp-file-input');
    var dropzone  = document.getElementById('slp-dropzone');

    btnClose.addEventListener('click', _slpClose);
    btnCancel.addEventListener('click', _slpClose);
    overlay.addEventListener('click', function(e){ if(e.target === overlay) _slpClose(); });

    dropzone.addEventListener('click', function(){ fileInput.click(); });
    dropzone.addEventListener('dragover', function(e){ e.preventDefault(); dropzone.classList.add('drag-over'); });
    dropzone.addEventListener('dragleave', function(){ dropzone.classList.remove('drag-over'); });
    dropzone.addEventListener('drop', function(e){
      e.preventDefault();
      dropzone.classList.remove('drag-over');
      if(e.dataTransfer.files[0]) _slpHandlePhoto(e.dataTransfer.files[0]);
    });
    fileInput.addEventListener('change', function(){
      if(fileInput.files[0]) _slpHandlePhoto(fileInput.files[0]);
    });

    btnRemove.addEventListener('click', function(){
      _slpFile = null;
      document.getElementById('slp-photo-preview').style.display   = 'none';
      document.getElementById('slp-dropzone-inner').style.display   = 'flex';
      document.getElementById('slp-exif-found').style.display       = 'none';
      document.getElementById('slp-exif-none').style.display        = 'none';
      btnRemove.style.display = 'none';
      fileInput.value = '';
      _slpCheckSave();
    });

    btnGeo.addEventListener('click', function(){
      if(!navigator.geolocation){
        if(typeof showToast === 'function') showToast('Geolocation not supported on this device.', {type:'error'});
        return;
      }
      btnGeo.textContent = 'Getting location...';
      btnGeo.disabled = true;
      navigator.geolocation.getCurrentPosition(
        function(pos){
          _slpPlacePin(pos.coords.latitude, pos.coords.longitude);
          btnGeo.textContent = '🎯 Use my current location';
          btnGeo.disabled = false;
        },
        function(){
          if(typeof showToast === 'function') showToast('Could not get location. Allow location access in your browser.', {type:'error'});
          btnGeo.textContent = '🎯 Use my current location';
          btnGeo.disabled = false;
        },
        { enableHighAccuracy: true, timeout: 10000 }
      );
    });

    btnSave.addEventListener('click', _slpSave);
  }

  function _slpInit() {
    var overlay = document.getElementById('slp-overlay');
    if(overlay) _slpWireEvents();
  }

  function _slpOpen() {
    _slpEnsureModal(function(overlay) {
      overlay.style.display = 'flex';
      _slpReset();
      _slpInitMap();
    });
  }

  function _slpClose() {
    var overlay = document.getElementById('slp-overlay');
    if(overlay) overlay.style.display = 'none';
    if(_slpMap){ _slpMap.remove(); _slpMap = null; _slpMarker = null; }
  }

  function _slpReset() {
    _slpLat = null; _slpLng = null; _slpFile = null;
    var ids = ['slp-photo-preview','slp-dropzone-inner','slp-exif-found','slp-exif-none','slp-remove-photo'];
    var display = ['none','flex','none','none','none'];
    for(var i=0;i<ids.length;i++){
      var el = document.getElementById(ids[i]);
      if(el) el.style.display = display[i];
    }
    var ld = document.getElementById('slp-lat-display');
    var nd = document.getElementById('slp-lng-display');
    var bs = document.getElementById('slp-save');
    var fi = document.getElementById('slp-file-input');
    if(ld) ld.value = '';
    if(nd) nd.value = '';
    if(bs){ bs.disabled = true; bs.textContent = 'Save Location & Photo'; }
    if(fi) fi.value = '';
  }

  function _slpInitMap() {
    // setTimeout fires after paint (unlike rAF which fires before) — overlay flex
    // layout is fully committed before Leaflet measures the container.
    setTimeout(function() {
      if(typeof L === 'undefined') return;
      var u = _ticState.unit || {};
      var startLat = u.latitude  ? parseFloat(u.latitude)  : _CLFN_LAT;
      var startLng = u.longitude ? parseFloat(u.longitude) : _CLFN_LNG;
      _slpMap = L.map('slp-map', { center: [startLat, startLng], zoom: 12, scrollWheelZoom: true });
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
      }).addTo(_slpMap);
      if(u.latitude && u.longitude) _slpPlacePin(startLat, startLng);
      _slpMap.on('click', function(e){ _slpPlacePin(e.latlng.lat, e.latlng.lng); });
      setTimeout(function(){ if(_slpMap) _slpMap.invalidateSize({ animate: false }); }, 300);
    }, 50);
  }

  function _slpPlacePin(lat, lng) {
    if(!_slpMap) return;
    var icon = L.divIcon({
      className: '',
      html: '<div style="width:12px;height:12px;background:#111110;border:2px solid #F8E41A;'
          + 'border-radius:50% 50% 50% 0;transform:rotate(-45deg);box-shadow:0 2px 6px rgba(0,0,0,.4);"></div>',
      iconSize: [12,12], iconAnchor: [6,12]
    });
    if(_slpMarker){
      _slpMarker.setLatLng([lat, lng]);
    } else {
      _slpMarker = L.marker([lat, lng], { icon: icon, draggable: true }).addTo(_slpMap);
      _slpMarker.on('dragend', function(){
        var p = _slpMarker.getLatLng();
        _slpUpdateCoords(p.lat, p.lng);
      });
    }
    _slpMap.setView([lat, lng], Math.max(_slpMap.getZoom(), 15));
    _slpUpdateCoords(lat, lng);
  }

  function _slpUpdateCoords(lat, lng) {
    _slpLat = lat; _slpLng = lng;
    var ld = document.getElementById('slp-lat-display');
    var nd = document.getElementById('slp-lng-display');
    if(ld) ld.value = parseFloat(lat).toFixed(7);
    if(nd) nd.value = parseFloat(lng).toFixed(7);
    _slpCheckSave();
  }

  function _slpCheckSave() {
    var bs = document.getElementById('slp-save');
    if(bs) bs.disabled = !(_slpLat && _slpLng);
  }

  async function _slpHandlePhoto(file) {
    _slpFile = file;
    var reader = new FileReader();
    reader.onload = function(e){
      var pp = document.getElementById('slp-photo-preview');
      var di = document.getElementById('slp-dropzone-inner');
      var br = document.getElementById('slp-remove-photo');
      if(pp){ pp.src = e.target.result; pp.style.display = 'block'; }
      if(di) di.style.display = 'none';
      if(br) br.style.display = 'inline-block';
    };
    reader.readAsDataURL(file);
    try {
      var gps = await exifr.gps(file);
      var ef  = document.getElementById('slp-exif-found');
      var en  = document.getElementById('slp-exif-none');
      var ec  = document.getElementById('slp-exif-coords-text');
      if(gps && gps.latitude && gps.longitude){
        if(ef){ ef.style.display = 'flex'; }
        if(en) en.style.display = 'none';
        if(ec) ec.textContent = parseFloat(gps.latitude).toFixed(5) + '° N, '
                              + Math.abs(parseFloat(gps.longitude)).toFixed(5) + '° W';
        _slpPlacePin(gps.latitude, gps.longitude);
      } else {
        if(ef) ef.style.display = 'none';
        if(en){ en.style.display = 'flex'; }
      }
    } catch(e) {
      var en2 = document.getElementById('slp-exif-none');
      if(en2) en2.style.display = 'flex';
    }
    _slpCheckSave();
  }

  async function _slpSave() {
    var btnSave = document.getElementById('slp-save');
    if(btnSave){ btnSave.disabled = true; btnSave.textContent = 'Saving...'; }
    try {
      var unitId = _ticState.unit && _ticState.unit.id;
      if(!unitId) throw new Error('No unit loaded');

      var photoPath = null;
      if(_slpFile){
        var ts       = Date.now();
        var safeName = _slpFile.name.replace(/[^a-zA-Z0-9._-]/g, '_');
        var path     = 'units/' + unitId + '/photo/' + ts + '_' + safeName;
        var uploaded = await window.sbUploadFile(path, _slpFile);
        photoPath = uploaded.path;
      }

      var updates = { latitude: parseFloat(_slpLat), longitude: parseFloat(_slpLng) };
      if(photoPath) updates.photo_url = photoPath;

      // PATCH housing_units + sync window.housingUnits (same keys as the columns here)
      var patched = await sbPatchUnit(unitId, updates, updates);
      if(!patched) throw new Error('could not update the unit record');

      _ticState.unit = Object.assign({}, _ticState.unit, updates);
      // Belt-and-suspenders: also flush via sbSaveUnit so coords land in the
      // data blob even if the targeted PATCH column grant wasn't applied yet.
      if(typeof sbSaveUnit === 'function') sbSaveUnit(_ticState.unit).catch(function(){});

      if(typeof _ticAudit === 'function')
        _ticAudit('unit_location_set', 'Set GPS coordinates' + (photoPath ? ' and house photo' : '') + ' for unit');

      if(typeof showToast === 'function') showToast('Location saved.', {type:'info'});
      _slpClose();
      _ticRenderOverview();

    } catch(err) {
      console.error('[SLP] Save failed:', err);
      if(typeof showToast === 'function') showToast('Save failed: ' + err.message, {type:'error'});
      if(btnSave){ btnSave.disabled = false; btnSave.textContent = 'Save Location & Photo'; }
    }
  }

  document.addEventListener('DOMContentLoaded', _slpInit);
  window._slpOpen = _slpOpen;

  window.openTenantCard = openTenantCard;
  window.closeTenantCard = _ticClose;
  window._ticOpenHydroOneConsentModal  = _ticOpenHydroOneConsentModal;
  window._ticGenerateHydroOneConsentPdf = _ticGenerateHydroOneConsentPdf;
  window._ticOpenLeaseModal             = _ticOpenLeaseModal;
  window._ticGenerateLeasePdf           = _ticGenerateLeasePdf;
  window._ticOpenInitialsPopout         = _ticOpenInitialsPopout;
  window._ticInitialSaveAndNav          = _ticInitialSaveAndNav;
  window._ticCloseLeaseModal            = _ticCloseLeaseModal;
})();
