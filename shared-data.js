// @ts-check
/* ============================================================
 * shared-data.js — CLFN Housing Suite
 * Supabase data layer: role mapping, CRUD operations, audit
 * ============================================================
 * Depends on: shared-config.js (SUPABASE_URL, SUPABASE_ANON)
 *             shared-auth.js   (HOUSING_SESSION, HOUSING_HEADERS)
 * Load order: shared.js → shared-config.js → shared-auth.js → shared-ui.js → THIS FILE
 *
 * Exposes (as globals):
 *   sbMapRole(staffRow)            — canonical role from a staff table row
 *   sbLoadApplications()           — fetch + map all applications
 *   sbSaveApplication(app)         — upsert one application
 *   sbSaveAllApplications(apps)    — batch upsert (used during migration)
 *   sbLoadUnits()                  — fetch + map all housing units
 *   sbSaveUnit(u)                  — upsert one unit
 *   sbSaveAllUnits(units)          — batch upsert
 *   sbLoadAuditLog(limit)          — fetch recent audit entries
 *   sbSaveSetting(key, value)      — upsert a housing_settings row
 *   sbLoadContractors()            — fetch + map contractors
 *   sbSaveContractor(ct)           — upsert one contractor
 *   auditEntry(appId, action, detail, user) — write to in-memory log + Supabase
 *
 * Design notes:
 *   - All functions are fire-and-forget safe (catch + warn, never throw to caller)
 *   - Upserts use Prefer: resolution=merge-duplicates so callers don't need
 *     to distinguish insert vs update
 *   - auditEntry writes to both the in-memory auditLog[] array (for display)
 *     and the Supabase housing_audit_log table (for persistence + compliance)
 * ============================================================ */

// ── Module-level state ────────────────────────────────────────────────────────
// Declare all implicit globals here so they're never undefined on first access.
var _scoresSortKey   = 'score';
var _scoresSortDir   = -1;

// ── _sbValidateSaveInput ──────────────────────────────────────────────────────
// Defensive guard for the sb*Save* family. Catches malformed records before
// they get serialized + sent to Supabase. Returns true if the input is valid;
// returns false (and logs a warn / shows an error toast) otherwise so the
// caller can early-out without the network round-trip.
//
// opts:
//   requireId   — boolean; when true, obj.id must be a non-empty string
//   maxBytes    — soft cap on JSON.stringify(obj).length, in bytes
//   keyMaxLen   — when provided, validates obj.key as a 1..keyMaxLen string
//   valueField  — when provided, validates obj[valueField] up to maxBytes bytes
function _sbValidateSaveInput(obj, opts) {
  opts = opts || {};
  if (!obj || typeof obj !== 'object') {
    console.warn('[sbValidate] rejected: not an object', obj);
    if (typeof showToast === 'function') showToast('Save aborted — invalid input', { type: 'error' });
    return false;
  }
  if (opts.requireId) {
    if (typeof obj.id !== 'string' || !obj.id.trim()) {
      console.warn('[sbValidate] rejected: missing/empty id', obj);
      if (typeof showToast === 'function') showToast('Save aborted — record has no id', { type: 'error' });
      return false;
    }
  }
  if (opts.keyMaxLen) {
    if (typeof obj.key !== 'string' || obj.key.length < 1 || obj.key.length > opts.keyMaxLen) {
      console.warn('[sbValidate] rejected: key must be 1..' + opts.keyMaxLen + ' chars', obj.key);
      if (typeof showToast === 'function') showToast('Save aborted — invalid setting key', { type: 'error' });
      return false;
    }
  }
  if (opts.maxBytes) {
    var sample;
    if (opts.valueField) {
      try { sample = (obj[opts.valueField] === undefined) ? '' : JSON.stringify(obj[opts.valueField]); }
      catch (e) { sample = ''; }
    } else {
      try { sample = JSON.stringify(obj); }
      catch (e) { sample = ''; }
    }
    if (sample.length > opts.maxBytes) {
      console.warn('[sbValidate] rejected: payload ' + sample.length + 'B > limit ' + opts.maxBytes + 'B');
      if (typeof showToast === 'function') showToast('Save aborted — payload too large', { type: 'error' });
      return false;
    }
  }
  return true;
}

// ── sbMapRole ─────────────────────────────────────────────────────────────────
// Maps a staff table row to a canonical role string.
// Uses CLFN_PERMS.normalizeRole() to handle legacy aliases.
function sbMapRole(staffRow) {
  if (!staffRow) return 'housing_employee_l1';
  var raw = staffRow.role;
  // Legacy guard: 'manager' from a non-Housing department → base access only
  if (raw === 'manager' && !(staffRow.department || '').toLowerCase().includes('housing')) {
    return 'housing_employee_l1';
  }
  if (window.CLFN_PERMS && window.CLFN_PERMS.isValidRole(raw)) {
    return window.CLFN_PERMS.normalizeRole(raw);
  }
  return 'housing_employee_l1';
}

// ── formatAppStatusLabel ──────────────────────────────────────────────────────
// Pretty-print an APP_STATUS internal value for user-facing surfaces (toasts,
// banners, pills). The raw values (hm_approved, mgr_approved, etc.) read as
// terminal-style debug strings to staff — this gives the polished label.
// Defined here in shared-data.js so it loads before housing-modals / -init.
// Per-surface wording variants. Each variant is a COMPLETE label map for its
// surface (not a delta over the canonical map) so migrated call sites render
// byte-identically — including statuses a surface deliberately leaves unmapped:
// with opts.variant a miss returns '' and the CALL SITE keeps its historical
// fallback expression (these surfaces fall back to the raw status string, not
// the canonical prettifier). Do NOT "unify" wording across variants.
var _APP_STATUS_LABEL_VARIANTS = {
  // Match view status column (housing-views.js renderMatchView). Only the
  // appIsAssignable statuses ever reach this surface.
  match: {
    submitted:    'Pending HM',
    hm_approved:  'HM Approved',
    ed_approved:  'ED Approved',
    mgr_approved: 'Mgr Approved',
    assigned:     'Assigned'
  },
  // Housing KPI drilldowns (housing-views.js showHousingKpiDrilldown).
  // Note: unmapped statuses (e.g. 'draft' rows in the drills) render the raw
  // status via the call-site fallback — same as the old inline map.
  kpi: {
    submitted:    'Pending HM',
    file_update:  'File Update',
    mgr_approved: 'Mgr Approved',
    ed_approved:  'ED Approved',
    hm_approved:  'HM Approved',
    returned:     'Returned',
    declined:     'Declined',
    assigned:     'Assigned'
  },
  // Worklist "Applications" section rows (renderWorklist below).
  worklist: {
    submitted:    'Awaiting Review',
    file_update:  'File Update',
    mgr_approved: 'Awaiting ED Approval',
    returned:     'Returned — Action Needed',
    transfer_request_submitted: 'Transfer Request'
  },
  // Add-Tenant modal application picker (housing-modals.js atSelectApp).
  add_tenant: {
    ed_approved:  'ED Approved',
    mgr_approved: 'HM Recommended',
    submitted:    'Submitted',
    returned:     'Returned',
    declined:     'Declined'
  },
  // Scorecard info strip (showScorecard below) — file-update oriented wording.
  scorecard: {
    draft:        'Draft',
    submitted:    'Awaiting HM Review',
    file_update:  'File Update — Awaiting HM',
    mgr_approved: 'Awaiting ED Approval',
    hm_approved:  'File Update Approved',
    ed_approved:  'ED Approved',
    declined:     'Declined',
    returned:     'Returned for Info',
    housed:       'Housed'
  }
};
function formatAppStatusLabel(status, opts) {
  // Variant lookup is exact-match only; '' on a miss (see note above).
  if (opts && opts.variant) {
    var vmap = _APP_STATUS_LABEL_VARIANTS[opts.variant] || {};
    return vmap[status] || '';
  }
  var map = {
    'draft':         'Draft',
    'submitted':     'Awaiting HM Review',
    'file_update':   'File Update',
    'mgr_approved':  'HM Recommended (Awaiting ED)',
    'hm_approved':   'HM Approved',
    'ed_approved':   'ED Approved',
    'returned':      'Returned',
    'declined':      'Declined',
    'assigned':      'Assigned',
    'archived':      'Archived'
  };
  if (map[status]) return map[status];
  // Fallback: replace underscores, uppercase HM/ED/Mgr tokens, title-case rest.
  return String(status || '')
    .replace(/_/g, ' ')
    .replace(/\bhm\b/gi, 'HM')
    .replace(/\bed\b/gi, 'ED')
    .replace(/\bmgr\b/gi, 'Mgr')
    .replace(/\b\w/g, function(c){ return c.toUpperCase(); });
}
window.formatAppStatusLabel = formatAppStatusLabel;

// ── sowStatusBadge ────────────────────────────────────────────────────────────
// Single source of truth for SOW approval-status → badge {key, label, bg, c}.
// Stored approval_status values are '' (new/draft), 'draft', 'signed',
// 'submitted', 'hm_approved', 'ed_approved', 'completed' — labels like
// "Pending HM" are computed, never stored. Shared rules encapsulated here:
//   • system_approved (RFQ auto-approval) renders the indigo "System Approved"
//     badge instead of "ED Approved" — never a manual ED sign-off. Whether it
//     also overrides a 'completed' status is per-variant (matches each
//     surface's historical behaviour).
//   • archived override (grey "Archived" pill) is per-variant — only the
//     inventory unit SOW table renders it; other surfaces show the underlying
//     status for archived rows (renos approvals view included).
// opts.variant selects per-surface wording/colors — byte-identical to the
// inline maps this replaced; do NOT "unify" wording across variants:
//   (default)         — renos.html approvals routing (pure-status branches)
//   'picker'          — _openSowPicker cards (housing-modals-sow.js)
//   'unit_table'      — udpRenderSowTable rows (housing-modals-sow.js)
//   'contractor_list' — contractor card Forms & SOWs list (label used only)
//   'worklist'        — renderWorklist "Renovations Waiting Approval" rows
//                       (label used only; pass {approval_status: item.status})
var _SOW_BADGE_VARIANTS = {
  'default': {
    map: {
      '':           {bg:'#f4f4f0', c:'#666',    label:'Draft'},
      draft:        {bg:'#f4f4f0', c:'#666',    label:'Draft'},
      signed:       {bg:'var(--info-blue-bg)', c:'#1d4ed8', label:'Signed'},
      submitted:    {bg:'var(--warn-amber-bg)', c:'var(--warn-amber-text)', label:'Submitted'},
      hm_approved:  {bg:'var(--warn-amber-bg)', c:'var(--warn-amber-text)', label:'HM Approved'},
      ed_approved:  {bg:'var(--success-bg)', c:'var(--success)', label:'ED Approved'},
      completed:    {bg:'var(--success-bg)', c:'var(--success)', label:'Completed'}
    },
    fallback: function(st){ return {bg:'#f4f4f0', c:'#666', label: st || '—'}; }
  },
  picker: {
    map: {
      '':           {bg:'#f4f4f0', c:'#666',    label:'Draft'},
      draft:        {bg:'#f4f4f0', c:'#666',    label:'Draft'},
      signed:       {bg:'var(--info-blue-bg)', c:'#1d4ed8', label:'Signed'},
      submitted:    {bg:'var(--warn-amber-bg)', c:'var(--warn-amber-text)', label:'Submitted'},
      hm_approved:  {bg:'var(--warn-amber-bg)', c:'var(--warn-amber-text)', label:'HM Approved'},
      ed_approved:  {bg:'var(--success-bg)', c:'var(--success)', label:'ED Approved'}
    },
    systemEvenIfCompleted: true,
    fallback: function(st){ return {bg:'#f4f4f0', c:'#666', label: st || 'Draft'}; }
  },
  unit_table: {
    map: {
      draft:        {bg:'#f4f4f0', c:'#666',    label:'Draft'},
      signed:       {bg:'var(--info-blue-bg)', c:'#1d4ed8', label:'Signed'},
      hm_approved:  {bg:'var(--warn-amber-bg)', c:'var(--warn-amber-text)', label:'HM Approved'},
      ed_approved:  {bg:'var(--success-bg)', c:'var(--success)', label:'ED Approved'},
      completed:    {bg:'var(--success-bg)', c:'var(--success)', label:'Completed'}
    },
    // Archived SOWs always render the "Archived" pill on this surface (it
    // overrides the approval-status pill AND the System Approved badge).
    archived: {bg:'#f4f4f0', c:'var(--gray)', label:'Archived'},
    fallback: function(st){ return {bg:'#f4f4f0', c:'#666', label: st || '—'}; }
  },
  // Label-only surface (colors carried for the {key,label,bg,c} contract but
  // not rendered there).
  contractor_list: {
    map: {
      draft:        {bg:'#f4f4f0', c:'#666',    label:'Draft'},
      signed:       {bg:'var(--info-blue-bg)', c:'#1d4ed8', label:'Signed'},
      hm_approved:  {bg:'var(--warn-amber-bg)', c:'var(--warn-amber-text)', label:'HM Approved'},
      ed_approved:  {bg:'var(--success-bg)', c:'var(--success)', label:'ED Approved'},
      completed:    {bg:'var(--success-bg)', c:'var(--success)', label:'Completed'}
    },
    systemEvenIfCompleted: true,
    fallback: function(st){ return {bg:'#f4f4f0', c:'#666', label: st || '—'}; }
  },
  // Label-only surface (colors carried for the contract but not rendered).
  worklist: {
    map: {
      '':           {bg:'#f4f4f0', c:'#666',    label:'Awaiting HM Review'},
      draft:        {bg:'#f4f4f0', c:'#666',    label:'Awaiting HM Review'},
      signed:       {bg:'#f4f4f0', c:'#666',    label:'Signed — Awaiting HM'},
      submitted:    {bg:'#f4f4f0', c:'#666',    label:'Awaiting HM Review'},
      hm_approved:  {bg:'#f4f4f0', c:'#666',    label:'HM Approved — Awaiting ED'}
    },
    fallback: function(){ return {bg:'#f4f4f0', c:'#666', label:'Awaiting Review'}; }
  }
};
function sowStatusBadge(sow, opts) {
  sow  = sow  || {};
  opts = opts || {};
  var v = _SOW_BADGE_VARIANTS[opts.variant] || _SOW_BADGE_VARIANTS['default'];
  // '' means new/draft; null/undefined are treated the same (matches the old
  // per-surface lookups). Callers with a plain status string pass
  // {approval_status: status}.
  var st = (sow.approval_status == null) ? '' : sow.approval_status;
  var badge, key;
  if (sow.cancelled) {
    // A cancelled request is terminal and overrides every other state.
    badge = {bg:'var(--danger-bg)', c:'var(--danger)', label:'Cancelled'};
    key = 'cancelled';
  } else if (v.archived && sow.archived) {
    badge = v.archived;
    key = 'archived';
  } else if (sow.system_approved && (v.systemEvenIfCompleted || st !== 'completed')) {
    badge = {bg:'#eef2ff', c:'#4338ca', label:'System Approved'};
    key = 'system_approved';
  } else {
    badge = v.map[st] || v.fallback(st);
    key = st;
  }
  return {key: key, label: badge.label, bg: badge.bg, c: badge.c};
}
window.sowStatusBadge = sowStatusBadge;

// ── contractorStatusBadge ─────────────────────────────────────────────────────
// Single source of truth for contractor registry status → badge. Default
// returns {bg, c, label} (the status banners); opts.variant 'table' returns
// {cls, label} (contractor table pills styled by shared.css classes). Returns
// null for unknown statuses — call sites keep their own historical fallbacks.
var _CT_BADGE_BANNER = {
  pending_review: {bg:'var(--warn-amber-bg)', c:'var(--warn-amber-text)', label:'⏳ Pending Housing Manager Review'},
  hm_recommended: {bg:'var(--info-blue-bg)', c:'#1d4ed8', label:'📋 HM Recommended — Awaiting Final Approval'},
  approved:       {bg:'var(--success-bg)', c:'var(--success)', label:'✅ Approved — Active Contractor'},
  declined:       {bg:'var(--danger-bg)', c:'var(--danger)', label:'❌ Declined'},
  returned:       {bg:'#faf5ff', c:'#7c3aed', label:'↩ Returned for More Information'}
};
var _CT_BADGE_TABLE = {
  pending_review: {cls:'pending-review', label:'⏳ Pending HM'},
  hm_recommended: {cls:'hm-recommended', label:'📋 Awaiting Approval'},
  approved:       {cls:'approved',        label:'✅ Approved'},
  declined:       {cls:'declined',        label:'❌ Declined'},
  returned:       {cls:'returned',        label:'↩ Returned'}
};
function contractorStatusBadge(status, opts) {
  var map = (opts && opts.variant === 'table') ? _CT_BADGE_TABLE : _CT_BADGE_BANNER;
  return map[status] || null;
}
window.contractorStatusBadge = contractorStatusBadge;

// ── sbLoadApplications ────────────────────────────────────────────────────────
// Fetches all applications and maps DB columns → app object shape.
// Prefers dedicated columns over the jsonb data blob for queryable fields.
async function sbLoadApplications() {
  try {
    var r = await fetch(
      SUPABASE_URL + '/rest/v1/housing_applications?select=*&order=submitted_at.desc&limit=9999',
      { headers: HOUSING_HEADERS }
    );
    if (!r.ok) return null;
    var data = await r.json();
    return data.map(function(row) {
      return Object.assign({}, row.data || {}, {
        // Identity
        id:               row.id,
        // Status & scoring
        status:           row.status,
        score:            row.score,
        tier:             row.tier,
        classification:   row.classification,
        reserve:          row.reserve,
        archived:         (row.archived !== undefined ? !!row.archived : !!(row.data || {}).archived),
        // Unit assignment
        assignedUnit:     row.assigned_unit_id,
        assignedAddress:  row.assigned_address,
        submittedAt:      row.submitted_at,
        // Application type
        appType:          row.app_type         || (row.data || {}).appType         || 'new_housing',
        transferPending:  row.transfer_pending !== undefined ? !!row.transfer_pending : !!(row.data || {}).transferPending,
        // V2 scoring inputs (dedicated columns win over jsonb)
        urgentNeed:          row.urgent_need           || (row.data || {}).urgentNeed          || 'none',
        healthRisk:          row.health_risk           || (row.data || {}).healthRisk          || 'none',
        personsOverStandard: row.persons_over_standard !== undefined ? row.persons_over_standard : ((row.data || {}).personsOverStandard || 0),
        loneParent:          row.lone_parent           !== undefined ? !!row.lone_parent        : !!(row.data || {}).loneParent,
        elderInHousehold:    row.elder_in_household    !== undefined ? !!row.elder_in_household : !!(row.data || {}).elderInHousehold,
        householdDisability: row.household_disability  !== undefined ? !!row.household_disability : !!(row.data || {}).householdDisability,
        incomeStability:     row.income_stability      || (row.data || {}).incomeStability      || 'stable',
        arrears_status:      row.arrears_status        || (row.data || {}).arrears_status       || 'none',
        // Prior tenancy (HM/ED assessed fields)
        rentPaymentHistory:  row.rent_payment_history  || (row.data || {}).rentPaymentHistory   || 'no_history',
        unitCondition:       row.unit_condition        || (row.data || {}).unitCondition        || 'no_history',
        tenancyConduct:      row.tenancy_conduct       || (row.data || {}).tenancyConduct       || 'no_history',
        // V2 scoring outputs
        score_v2:            row.score_v2 !== undefined ? row.score_v2 : (row.data || {}).score_v2,
        tier_v2:             row.tier_v2              || (row.data || {}).tier_v2,
        scoreBreakdown:      row.score_breakdown_v2   || (row.data || {}).scoreBreakdown || null,
        // Ownership (RLS — HE-L1 own-draft rule)
        created_by_email:    row.created_by_email     || null,
        // Columns added via migration 2026-04-19
        spId:                row.sp_id != null ? row.sp_id : ((row.data || {}).spId || null),
        noPriorTenancy:      row.no_prior_tenancy     !== undefined ? !!row.no_prior_tenancy : !!(row.data || {}).noPriorTenancy
      });
    });
  } catch(e) {
    console.warn('[SB] load applications failed:', e);
    return null;
  }
}

// ── sbSaveApplication ─────────────────────────────────────────────────────────
// Upserts one application. All V2 scoring fields are promoted to dedicated
// columns so they're queryable; the full app object is also stored in data jsonb.
// COLUMNS: only send columns confirmed to exist in housing_applications table.
// Columns data, archived, no_prior_tenancy, sp_id require a migration before
// being re-enabled (see CLFN Supabase migration notes).
async function sbSaveApplication(app) {
  if (!_sbValidateSaveInput(app, { requireId: true, maxBytes: 1024 * 1024 })) {
    return Promise.reject(new Error('sbSaveApplication: invalid input'));
  }
  var row = {
    id:               app.id,
    status:           app.status || 'draft',
    score:            typeof app.score === 'number' ? app.score : null,
    tier:             app.tier || null,
    classification:   app.classification || null,
    reserve:          app.reserve || null,
    assigned_unit_id: app.assignedUnit || null,
    assigned_address: app.assignedAddress || null,
    submitted_at:     app.submittedAt || null,
    // V2 scoring inputs (all confirmed in table)
    urgent_need:           app.urgentNeed           || app.urgent_need           || 'none',
    health_risk:           app.healthRisk           || app.health_risk           || 'none',
    persons_over_standard: parseInt(app.personsOverStandard || app.persons_over_standard || 0) || 0,
    lone_parent:           !!(app.loneParent        || app.lone_parent),
    elder_in_household:    !!(app.elderInHousehold  || app.elder_in_household),
    household_disability:  !!(app.householdDisability || app.household_disability),
    rent_payment_history:  app.rentPaymentHistory   || app.rent_payment_history  || 'no_history',
    unit_condition:        app.unitCondition        || app.unit_condition        || 'no_history',
    tenancy_conduct:       app.tenancyConduct       || app.tenancy_conduct       || 'no_history',
    income_stability:      app.incomeStability      || app.income_stability      || 'stable',
    arrears_status:        app.arrearsStatus        || app.arrears_status        || 'none',
    // V2 scoring outputs (all confirmed in table)
    score_v2:           typeof app.score_v2 === 'number' ? app.score_v2 : (typeof app.score === 'number' ? app.score : null),
    tier_v2:            app.tier_v2 || app.tier || null,
    score_breakdown_v2: app.scoreBreakdown || null,
    // Application type (confirmed in table)
    app_type:           app.appType || app.app_type || 'new_housing',
    transfer_pending:   !!(app.transferPending || app.transfer_pending),
    // Ownership (confirmed in table)
    created_by_email:   app.created_by_email || HOUSING_SESSION.email || null,
    // Columns added via migration 2026-04-19
    sp_id:            app.spId || null,
    data:             app,
    archived:         !!app.archived,
    no_prior_tenancy: (app.noPriorTenancy !== undefined ? !!app.noPriorTenancy : !!(app.no_prior_tenancy !== false))
  };
  var _appSaveHeaders = Object.assign({}, HOUSING_HEADERS, {
    'Prefer': 'resolution=merge-duplicates,return=minimal',
    'Accept-Profile': 'public',
    'Content-Profile': 'public'
  });
  var _doPost = function(rowObj) {
    return fetch(SUPABASE_URL + '/rest/v1/housing_applications', {
      method: 'POST', headers: _appSaveHeaders, body: JSON.stringify(rowObj)
    });
  };
  try {
    var r = await _doPost(row);
    if (!r.ok) {
      var errText = await r.text();
      // If Supabase rejects with "undefined column" (42703), the migration that
      // adds sp_id / archived / no_prior_tenancy hasn't run yet. Strip those
      // optional columns and retry — the full app object is still in data jsonb.
      if (r.status === 400 && errText.indexOf('"42703"') !== -1) {
        console.warn('[SB] migration columns not in table yet (42703) — retrying without them');
        var safeRow = Object.assign({}, row);
        delete safeRow.sp_id;
        delete safeRow.archived;
        delete safeRow.no_prior_tenancy;
        r = await _doPost(safeRow);
        if (!r.ok) {
          var e2 = await r.text();
          console.error('[SB] save application (safe) '+r.status+' — Supabase says:', e2);
          throw new Error('save failed ('+r.status+'): '+e2);
        }
        return true;
      }
      console.error('[SB] save application '+r.status+' — Supabase says:', errText);
      console.error('[SB] row keys sent:', Object.keys(row).join(', '));
      throw new Error('save failed ('+r.status+'): '+errText);
    }
    return true;
  } catch(e) {
    console.warn('[SB] save application error:', e);
    throw e;
  }
}

// ── Local-first save queue ────────────────────────────────────────────────────
// On flaky networks (iPad cellular, marginal wifi) and on PostgREST auth errors
// (PGRST301/302/303), in-flight sb*Save* calls reject and edits would be lost
// on tab close. The queue keeps every save attempt in localStorage immediately
// so nothing disappears, then drains in the background and on next boot.
//
// Storage shape (key = SAVE_QUEUE_KEY):
//   {
//     "app:APP-000123": {
//       entityType: 'app',
//       id:         'APP-000123',
//       entity:     { ...full object... },
//       ownerEmail: 'kevin.proctor@clfn.on.ca',
//       updatedAt:  '2026-05-14T10:33:00.000Z',
//       lastError:  'save failed (401): {...}'  // optional
//     },
//     "unit:UNIT-42": { entityType:'unit', ... },
//     "contractor:CT-9": { ... },
//     "app_note:APP-000123|1747234567890": { ... },
//     "setting:approval_authority": { ... }
//   }
// Entries are removed on successful sync.
var SAVE_QUEUE_KEY       = 'clfn_save_queue';
// Legacy app-only queue key (pre-2026-05-14). Migrated on first boot then dropped.
var APP_DRAFT_QUEUE_KEY  = 'clfn_housing_draft_queue';

function _saveQueueRead(){
  try {
    var raw = localStorage.getItem(SAVE_QUEUE_KEY);
    if(!raw) return {};
    var parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch(e) { return {}; }
}

function _saveQueueWrite(map){
  try { localStorage.setItem(SAVE_QUEUE_KEY, JSON.stringify(map || {})); }
  catch(e) { console.warn('[save-queue] write failed:', e); }
}

function _queueKey(entityType, id) { return entityType + ':' + id; }

// Owner-email guard: each queue entry is stamped with the staff email that
// created it. On shared devices (multi-staff iPad), syncSaveQueue only pushes
// entries owned by the currently signed-in user. Other users' entries are
// left untouched until their owner signs back in.
function _currentOwnerEmail(){
  var s = window.HOUSING_SESSION || {};
  return (s.email || '').toLowerCase();
}

function saveQueueAdd(entityType, id, entity, lastError){
  if(!entityType || !id) return;
  var map = _saveQueueRead();
  var k = _queueKey(entityType, id);
  // Preserve the original ownerEmail on subsequent updates — never silently
  // re-stamp ownership to whoever happens to be signed in now.
  var existing = map[k] || {};
  map[k] = {
    entityType: entityType,
    id:         id,
    entity:     entity,
    ownerEmail: existing.ownerEmail || _currentOwnerEmail() || null,
    updatedAt:  new Date().toISOString(),
    lastError:  lastError || null
  };
  _saveQueueWrite(map);
}

function saveQueueRemove(entityType, id){
  if(!entityType || !id) return;
  var map = _saveQueueRead();
  var k = _queueKey(entityType, id);
  if(map[k]) { delete map[k]; _saveQueueWrite(map); }
}

function saveQueueGetAll(){
  var map = _saveQueueRead();
  return Object.keys(map).map(function(k){ return map[k]; });
}

// Retry-dispatch table — maps entityType → network function. Each adapter
// takes the cached entity and returns a Promise (resolves on success, rejects
// on failure). Adapters are looked up at retry time so they pick up the
// latest sb*Save* implementation.
//
// Mixed contracts: sbSaveApplication and sbAddAppNote *throw* on failure;
// sbSaveUnit, sbSaveContractor, sbSaveSetting resolve to false. The adapter
// normalizes the latter to a rejection so the wrapper's .catch always fires.
function _rejectIfFalse(promise, label){
  return promise.then(function(ok){
    if(ok === false) throw new Error(label + ' returned false (HTTP error or RLS rejection — see console)');
    return true;
  });
}
// Wrap a save promise with a 10-second hard timeout so weak-but-not-dead
// connections fail fast rather than hanging until the browser's own TCP timeout
// (which can be 60+ seconds). The entry stays in the queue and retries on sync.
var _SAVE_TIMEOUT_MS = 10000;
function _withSaveTimeout(promise){
  return new Promise(function(resolve, reject){
    var timer = setTimeout(function(){
      reject(new Error('save timed out after ' + (_SAVE_TIMEOUT_MS / 1000) + 's'));
    }, _SAVE_TIMEOUT_MS);
    promise.then(function(v){ clearTimeout(timer); resolve(v); },
                 function(e){ clearTimeout(timer); reject(e); });
  });
}

var _SAVE_RETRY = {
  app:        function(entity){ return _withSaveTimeout(sbSaveApplication(entity)); },
  unit:       function(entity){ return _withSaveTimeout(_rejectIfFalse(sbSaveUnit(entity), 'sbSaveUnit')); },
  contractor: function(entity){ return _withSaveTimeout(_rejectIfFalse(sbSaveContractor(entity), 'sbSaveContractor')); },
  // App notes are append-only POSTs with a fresh server-generated UUID. The
  // queue entity carries the original args; the retry re-fires the insert.
  app_note:   function(entity){ return _withSaveTimeout(sbAddAppNote(entity.app_id, entity.body)); },
  setting:    function(entity){ return _withSaveTimeout(_rejectIfFalse(sbSaveSetting(entity.key, entity.value), 'sbSaveSetting')); },
  // Maintenance Requests: one merge-duplicates upsert per unit (housing_sow.data
  // holds the unit's whole SOW list), so retries are idempotent and the queue's
  // per-(type,id) last-write-wins matches the server's semantics exactly.
  sow:        function(entity){ return _withSaveTimeout(_rejectIfFalse(sbSaveSowRow(entity), 'sbSaveSowRow')); }
};

// ── Degraded-mode (slow cell) guard ─────────────────────────────────────────
// When a save times out on a connected-but-slow network, we flip into degraded
// mode for _DEGRADED_COOLDOWN_MS. In that window all saves skip the network and
// queue locally (instant). After the cooldown, one probe fires; if it succeeds
// we exit degraded mode and normal sync resumes. If it times out we extend
// another cooldown cycle.
var _DEGRADED_COOLDOWN_MS  = 30000; // 30 s cooldown after a timeout
var _degradedUntil         = 0;     // epoch ms — 0 means not degraded
var _degradedProbeRunning  = false;

function _inDegradedMode(){ return Date.now() < _degradedUntil; }

function _enterDegradedMode(){
  _degradedUntil = Date.now() + _DEGRADED_COOLDOWN_MS;
  console.warn('[save-queue] slow network detected — degraded mode for ' + (_DEGRADED_COOLDOWN_MS/1000) + 's');
  if(typeof showToast === 'function'){
    showToast('Slow connection — saving locally. Will sync when signal improves.', { type: 'info' });   // string 2nd arg was silently DROPPED by showToast
  }
  // Schedule a probe at the end of the cooldown window.
  setTimeout(_runDegradedProbe, _DEGRADED_COOLDOWN_MS + 100);
}

function _runDegradedProbe(){
  if(_degradedProbeRunning) return;
  if(!navigator.onLine) return; // still fully offline — online event will handle it
  _degradedProbeRunning = true;
  // Probe with one of the CURRENT user's queued entries (shared-iPad safety —
  // never push another signed-in user's entity under this user's token), and
  // remember it so success can DEQUEUE it: the old code left the probed entry
  // in the queue and then ran syncSaveQueue, which re-sent it (duplicate rows
  // for append-only types like tenant notes).
  var _own    = (typeof _currentOwnerEmail === 'function' ? _currentOwnerEmail() : '') || '';
  var entries = saveQueueGetAll().filter(function(e){ return !e.ownerEmail || !_own || e.ownerEmail === _own; });
  var probe   = entries.length ? entries[0] : null;
  var attempt = probe
    ? _SAVE_RETRY[probe.entityType](probe.entity)
    : _withSaveTimeout(fetch(
        (typeof SUPABASE_URL !== 'undefined' ? SUPABASE_URL : '') + '/rest/v1/',
        { method: 'HEAD' }
      ));
  attempt.then(function(){
    _degradedProbeRunning = false;
    _degradedUntil = 0; // exit degraded mode
    console.log('[save-queue] probe succeeded — exiting degraded mode');
    if(probe) saveQueueRemove(probe.entityType, probe.id);   // probed entry already persisted — don't re-send it
    if(typeof showToast === 'function') showToast('Connection restored — syncing saved data.', { type: 'info' });
    syncSaveQueue().catch(function(){});
    if(typeof window.flushOfflineFiles === 'function') window.flushOfflineFiles();   // O2: sync queued PDFs/files
  }).catch(function(){
    _degradedProbeRunning = false;
    // Still slow — extend cooldown and schedule another probe.
    _degradedUntil = Date.now() + _DEGRADED_COOLDOWN_MS;
    console.warn('[save-queue] probe timed out — extending degraded mode');
    setTimeout(_runDegradedProbe, _DEGRADED_COOLDOWN_MS + 100);
  });
}

// saveWithDraftFallback — write to localStorage FIRST, then push to Supabase
// in the background. Never throws. Returns a Promise<bool> indicating whether
// the cloud sync succeeded. Local copy is always preserved.
//
// Skips the network when:
//   a) navigator.onLine === false (fully offline), or
//   b) degraded mode is active (previous save timed out on slow cell).
// In both cases the entry is queued locally and syncs automatically when the
// connection recovers.
function saveWithDraftFallback(entityType, id, entity){
  if(!entityType || !id || entity == null) return Promise.resolve(false);
  if(typeof _SAVE_RETRY[entityType] !== 'function'){
    console.warn('[save-queue] no retry adapter registered for entityType:', entityType);
    return Promise.resolve(false);
  }
  // Stash locally before touching the network.
  saveQueueAdd(entityType, id, entity, null);
  // Skip network when fully offline or connection is known-slow.
  if(!navigator.onLine){
    console.log('[save-queue] offline — queued ' + entityType + ':' + id + ' for later sync');
    return Promise.resolve(false);
  }
  if(_inDegradedMode()){
    console.log('[save-queue] degraded mode — queued ' + entityType + ':' + id + ' for later sync');
    return Promise.resolve(false);
  }
  return _SAVE_RETRY[entityType](entity).then(function(){
    saveQueueRemove(entityType, id);
    return true;
  }).catch(function(err){
    var msg = (err && err.message) ? err.message : String(err);
    saveQueueAdd(entityType, id, entity, msg);
    // A timeout on a connected device means slow cell — enter degraded mode.
    if(msg.indexOf('timed out') !== -1){ _enterDegradedMode(); }
    console.warn('[save-queue] cloud sync failed for ' + entityType + ':' + id + ' — kept in queue:', msg);
    return false;
  });
}

// ── Per-entity convenience wrappers ──────────────────────────────────────────
function saveApplicationWithDraftFallback(app){
  if(!app || !app.id) return Promise.resolve(false);
  return saveWithDraftFallback('app', app.id, app).then(function(ok){
    // Application-wizard "last saved" indicator (housing-app.js) — no-op on
    // pages without the wizard or when it's closed.
    if (typeof window._appStampSaved === 'function') window._appStampSaved(app.id, ok);
    return ok;
  });
}
function saveUnitWithDraftFallback(unit){
  if(!unit || !unit.id) return Promise.resolve(false);
  return saveWithDraftFallback('unit', unit.id, unit);
}
function saveContractorWithDraftFallback(ct){
  if(!ct || !ct.id) return Promise.resolve(false);
  return saveWithDraftFallback('contractor', ct.id, ct);
}
function saveAppNoteWithDraftFallback(appId, body){
  if(!appId || !body) return Promise.resolve(false);
  // Notes have no client-side primary key — synthesize a stable queue id so
  // retries don't duplicate. The appId+timestamp combo never repeats.
  var qid = appId + '|' + Date.now();
  return saveWithDraftFallback('app_note', qid, { app_id: appId, body: body });
}
function saveSettingWithDraftFallback(key, value){
  if(!key) return Promise.resolve(false);
  return saveWithDraftFallback('setting', key, { key: key, value: value });
}

// One-time migration: move entries from the old app-only queue (pre-2026-05-14)
// into the unified queue, then drop the old key. Safe to re-run.
function _migrateLegacyAppDraftQueue(){
  var oldMap = {};
  try {
    var raw = localStorage.getItem(APP_DRAFT_QUEUE_KEY);
    if(!raw) return;
    oldMap = JSON.parse(raw) || {};
  } catch(e) { return; }
  var keys = Object.keys(oldMap);
  if(!keys.length) { try { localStorage.removeItem(APP_DRAFT_QUEUE_KEY); } catch(e){} return; }
  var newMap = _saveQueueRead();
  keys.forEach(function(appId){
    var entry = oldMap[appId] || {};
    var k = _queueKey('app', appId);
    if(!newMap[k]) {
      newMap[k] = {
        entityType: 'app',
        id:         appId,
        entity:     entry.app,
        ownerEmail: entry.ownerEmail || null,
        updatedAt:  entry.updatedAt || new Date().toISOString(),
        lastError:  entry.lastError || null
      };
    }
  });
  _saveQueueWrite(newMap);
  try { localStorage.removeItem(APP_DRAFT_QUEUE_KEY); } catch(e) {}
  console.log('[save-queue] migrated ' + keys.length + ' legacy app draft(s) to unified queue');
}

// syncSaveQueue — called on boot after auth resolves. Tries to push every
// queued entry owned by the current user to Supabase, in parallel. Entries
// stamped with a different ownerEmail are skipped (shared-iPad safety) and
// stay in the queue for that owner's next sign-in. Successes drop out of the
// queue; failures stay for next time.
function syncSaveQueue(){
  var entries = saveQueueGetAll();
  if(!entries.length) return Promise.resolve({ tried:0, synced:0, skipped:0 });
  var me = _currentOwnerEmail();
  var mine    = [];
  var skipped = 0;
  entries.forEach(function(entry){
    var owner = (entry.ownerEmail || '').toLowerCase();
    // Unowned entries (pre-guard upgrade or non-staff context) attach to the
    // current user — they came from this device, no one else can claim them.
    if(!owner) { mine.push(entry); return; }
    if(owner === me) { mine.push(entry); return; }
    skipped++;
  });
  if(skipped > 0) console.log('[save-queue] skipped ' + skipped + ' entry(ies) owned by another user');
  if(!mine.length) return Promise.resolve({ tried:0, synced:0, skipped: skipped });
  console.log('[save-queue] retrying ' + mine.length + ' unsynced entry(ies)…');
  var synced = 0;
  return Promise.all(mine.map(function(entry){
    var adapter = _SAVE_RETRY[entry.entityType];
    if(typeof adapter !== 'function'){
      console.warn('[save-queue] no retry adapter for entityType:', entry.entityType);
      return null;
    }
    return adapter(entry.entity).then(function(){
      saveQueueRemove(entry.entityType, entry.id);
      synced++;
    }).catch(function(err){
      var msg = (err && err.message) ? err.message : String(err);
      saveQueueAdd(entry.entityType, entry.id, entry.entity, msg);
      console.warn('[save-queue] retry failed for ' + entry.entityType + ':' + entry.id + ':', msg);
    });
  })).then(function(){
    if(synced > 0 && typeof showToast === 'function'){
      showToast(synced + ' item' + (synced === 1 ? '' : 's') + ' synced from local backup.', {type:'info'});
    }
    return { tried: mine.length, synced: synced, skipped: skipped };
  });
}

// Backwards-compatible alias. Boot path still calls syncDraftQueue().
function syncDraftQueue(){
  _migrateLegacyAppDraftQueue();
  return syncSaveQueue();
}

// Auto-sync when WiFi reconnects — drains the queue without waiting for the
// next login. Only fires if the user is already authenticated this session.
// Also clears degraded mode immediately since we know connectivity is back.
window.addEventListener('online', function(){
  if(!window.HOUSING_SESSION || !window.HOUSING_SESSION.accessToken) return;
  _degradedUntil = 0; // full connectivity restored — exit degraded mode
  console.log('[save-queue] network restored — running sync');
  syncSaveQueue().catch(function(e){ console.warn('[save-queue] online-sync error:', e); });
});

// ── sbSaveAllApplications ─────────────────────────────────────────────────────
// Batch upsert — used during localStorage→Supabase migration and bulk ops.
async function sbSaveAllApplications(apps) {
  var rows = apps.map(function(app) {
    return {
      id:               app.id,
      sp_id:            app.spId || null,
      data:             app,
      status:           app.status || 'draft',
      score:            typeof app.score === 'number' ? app.score : null,
      tier:             app.tier || null,
      classification:   app.classification || null,
      reserve:          app.reserve || null,
      archived:         !!app.archived,
      assigned_unit_id: app.assignedUnit || null,
      assigned_address: app.assignedAddress || null,
      submitted_at:     app.submittedAt || null,
      created_by_email: app.created_by_email || null
    };
  });
  for (var i = 0; i < rows.length; i += 100) {
    var batch = rows.slice(i, i + 100);
    var r = await fetch(SUPABASE_URL + '/rest/v1/housing_applications', {
      method:  'POST',
      headers: Object.assign({}, HOUSING_HEADERS, { 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
      body:    JSON.stringify(batch)
    });
    if (!r.ok) { console.warn('[SB] batch save applications failed:', await r.text()); return false; }
  }
  return true;
}

// ── sbLoadUnits ───────────────────────────────────────────────────────────────
async function sbLoadUnits() {
  try {
    var r = await fetch(
      SUPABASE_URL + '/rest/v1/housing_units?select=*&order=street,num&limit=9999',
      { headers: HOUSING_HEADERS }
    );
    if (!r.ok) return null;
    var data = await r.json();
    return data.map(function(row) {
      return Object.assign({}, row.data || {}, {
        id:               row.id,
        num:              row.num,
        street:           row.street,
        bedrooms:         row.bedrooms,
        bathrooms:        row.bathrooms,
        type:             row.type,
        foundation:       row.foundation,
        funder:           row.funder,
        // Backward compat: units that were saved with status='under_repair'
        // (old model) are migrated in-memory to under_renovation=true.
        status:           row.status === 'under_repair'
                            ? ((row.data && row.data.priorStatus) || 'vacant')
                            : row.status,
        under_renovation: !!row.under_renovation || row.status === 'under_repair',
        accessible:       !!row.accessible,
        isElders:         !!row.is_elders,
        archived:         !!row.archived,
        assignedTo:       row.assigned_to,
        assignedName:     row.assigned_name,
        assignedDate:     row.assigned_date,
        label_slug:       (row.label_slug != null ? row.label_slug : (row.data && row.data.label_slug)) || null,
        constructionCost: (row.construction_cost != null) ? Number(row.construction_cost) : null,
        latitude:  row.latitude  != null ? Number(row.latitude)
                 : (row.data && row.data.latitude  != null ? Number(row.data.latitude)  : null),
        longitude: row.longitude != null ? Number(row.longitude)
                 : (row.data && row.data.longitude != null ? Number(row.data.longitude) : null),
        hydro_meter_number: row.hydro_meter_number || (row.data && row.data.hydro_meter_number) || null,
        gas_meter_number:   row.gas_meter_number   || (row.data && row.data.gas_meter_number)   || null,
        // Inspection dates: prefer the top-level columns (sbSaveUnit writes
        // them; SQL backfills only set these) — without this mapping a unit
        // whose next_inspection_due existed only as a column was never counted
        // overdue (dashboard KPI) and showed blank in the unit modal.
        lastInspectionDate: row.last_inspection_date || (row.data && row.data.lastInspectionDate) || null,
        nextInspectionDue:  row.next_inspection_due  || (row.data && row.data.nextInspectionDue)  || null
      });
    });
  } catch(e) {
    console.warn('[SB] load units failed:', e);
    return null;
  }
}

// ── sbSaveUnit ────────────────────────────────────────────────────────────────
async function sbSaveUnit(u) {
  if (!_sbValidateSaveInput(u, { requireId: true, maxBytes: 512 * 1024 })) {
    return Promise.reject(new Error('sbSaveUnit: invalid input'));
  }
  var row = {
    id:                u.id,
    num:               u.num           || null,
    street:            u.street        || null,
    bedrooms:          u.bedrooms      || null,
    bathrooms:         u.bathrooms     || null,
    type:              u.type          || null,
    foundation:        u.foundation    || null,
    funder:            u.funder        || null,
    status:            u.status        || 'vacant',
    under_renovation:  !!u.under_renovation,
    accessible:        !!u.accessible,
    is_elders:         !!u.isElders,
    archived:          !!u.archived,
    assigned_to:       u.assignedTo   || null,
    assigned_name:     u.assignedName || null,
    assigned_date:     u.assignedDate || null,
    construction_cost: (u.constructionCost != null && u.constructionCost !== '') ? Number(u.constructionCost) : null,
    data:              u
  };
  // Only include lat/lng and meter numbers when present — omitting keeps existing DB value intact on merge
  if (u.latitude            != null) row.latitude            = Number(u.latitude);
  if (u.longitude           != null) row.longitude           = Number(u.longitude);
  if (u.hydro_meter_number  != null) row.hydro_meter_number  = u.hydro_meter_number  || null;
  if (u.gas_meter_number    != null) row.gas_meter_number    = u.gas_meter_number    || null;
  if (u.lastInspectionDate  !== undefined) row.last_inspection_date = u.lastInspectionDate || null;
  if (u.nextInspectionDue   !== undefined) row.next_inspection_due  = u.nextInspectionDue  || null;
  try {
    var r = await fetch(SUPABASE_URL + '/rest/v1/housing_units', {
      method:  'POST',
      headers: Object.assign({}, HOUSING_HEADERS, { 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
      body:    JSON.stringify(row)
    });
    if (!r.ok) { console.warn('[SB] save unit failed:', await r.text()); return false; }
    return true;
  } catch(e) {
    console.warn('[SB] save unit error:', e);
    return false;
  }
}

// ── sbPatchUnit ───────────────────────────────────────────────────────────────
// Targeted column PATCH on housing_units (vs sbSaveUnit's full-row upsert).
// partial   — snake_case column updates sent to PostgREST.
// cacheSync — optional object of camelCase updates Object.assign'd onto the
//             matching entry in window.housingUnits on success (caller decides
//             what the in-memory equivalents are).
// Resolves true/false; never throws.
async function sbPatchUnit(unitId, partial, cacheSync) {
  try {
    var r = await fetch(
      SUPABASE_URL + '/rest/v1/housing_units?id=eq.' + encodeURIComponent(unitId),
      {
        method:  'PATCH',
        headers: Object.assign({}, HOUSING_HEADERS, { 'Prefer': 'return=minimal' }),
        body:    JSON.stringify(partial)
      }
    );
    if (!r.ok) { console.warn('[SB] patch unit failed:', await r.text()); return false; }
    if (cacheSync && typeof housingUnits !== 'undefined' && Array.isArray(housingUnits)) {
      for (var i = 0; i < housingUnits.length; i++) {
        if (String(housingUnits[i].id) === String(unitId)) {
          Object.assign(housingUnits[i], cacheSync);
          break;
        }
      }
    }
    return true;
  } catch(e) {
    console.warn('[SB] patch unit error:', e);
    return false;
  }
}
window.sbPatchUnit = sbPatchUnit;

// ── sbSaveAllUnits ────────────────────────────────────────────────────────────
async function sbSaveAllUnits(units) {
  if (!units || !units.length) return true;
  var rows = units.map(function(u) {
    var r = {
      id:                u.id,
      num:               u.num           || null,
      street:            u.street        || null,
      bedrooms:          u.bedrooms      || null,
      bathrooms:         u.bathrooms     || null,
      type:              u.type          || null,
      foundation:        u.foundation    || null,
      funder:            u.funder        || null,
      status:            u.status        || 'vacant',
      accessible:        !!u.accessible,
      is_elders:         !!u.isElders,
      archived:          !!u.archived,
      assigned_to:       u.assignedTo   || null,
      assigned_name:     u.assignedName || null,
      assigned_date:     u.assignedDate || null,
      construction_cost: (u.constructionCost != null && u.constructionCost !== '') ? Number(u.constructionCost) : null,
      data:              u
    };
    if (u.latitude  != null) r.latitude  = Number(u.latitude);
    if (u.longitude != null) r.longitude = Number(u.longitude);
    return r;
  });
  for (var i = 0; i < rows.length; i += 100) {
    var batch = rows.slice(i, i + 100);
    var r = await fetch(SUPABASE_URL + '/rest/v1/housing_units', {
      method:  'POST',
      headers: Object.assign({}, HOUSING_HEADERS, { 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
      body:    JSON.stringify(batch)
    });
    if (!r.ok) { console.warn('[SB] batch save units failed:', await r.text()); return false; }
  }
  return true;
}


// ── sbLoadAuditLog ────────────────────────────────────────────────────────────
function _parseAuditRow(row) {
  var d = (typeof row.detail === 'object' ? row.detail : null)
       || (function() { try { return JSON.parse(row.detail || '{}'); } catch(e) { return {}; } })();
  return {
    ts:     row.created_at,
    appId:  row.entity_id,
    action: row.action,
    detail: d.detail || d.summary || '',
    user:   row.actor,
    name:   d.name || ''   // display name stored in detail JSON by auditEntry()
  };
}

// Full audit log load — used by Settings → Audit Log. No user filter.
async function sbLoadAuditLog(limit) {
  try {
    var r = await fetch(
      SUPABASE_URL + '/rest/v1/housing_audit_log?select=*&order=created_at.desc&limit=' + (limit || 500),
      { headers: HOUSING_HEADERS }
    );
    if (!r.ok) return null;
    return (await r.json()).map(_parseAuditRow);
  } catch(e) {
    console.warn('[SB] load audit log failed:', e);
    return null;
  }
}

// User-scoped load for Recent Activity — filters by the current user's email
// (stored in actor column for entries created after this fix). Falls back to
// a broader fetch when no email is available (e.g. legacy role-string entries).
async function sbLoadMyRecentActivity(limit) {
  var email = (window.HOUSING_SESSION && window.HOUSING_SESSION.email) || '';
  try {
    var qs = email
      ? '?select=*&actor=eq.' + encodeURIComponent(email) + '&order=created_at.desc&limit=' + (limit || 100)
      : '?select=*&order=created_at.desc&limit=' + (limit || 100);
    var r = await fetch(SUPABASE_URL + '/rest/v1/housing_audit_log' + qs, { headers: HOUSING_HEADERS });
    if (!r.ok) return null;
    return (await r.json()).map(_parseAuditRow);
  } catch(e) {
    console.warn('[SB] load recent activity failed:', e);
    return null;
  }
}

// ── housing_application_notes ─────────────────────────────────────────────────
// Append-only internal staff notes on a housing application. DB enforces
// no-update / no-delete (RLS + trigger). Returns newest-first.
async function sbLoadAppNotes(appId) {
  if (!appId) return [];
  try {
    var r = await fetch(
      SUPABASE_URL + '/rest/v1/housing_application_notes'
        + '?select=*&app_id=eq.' + encodeURIComponent(appId)
        + '&order=created_at.desc&limit=500',
      { headers: HOUSING_HEADERS }
    );
    if (!r.ok) { console.warn('[SB] load app notes failed:', r.status); return []; }
    return await r.json();
  } catch(e) {
    console.warn('[SB] load app notes error:', e);
    return [];
  }
}

async function sbAddAppNote(appId, body) {
  if (!appId || !body || !String(body).trim()) {
    return Promise.reject(new Error('sbAddAppNote: appId and body required'));
  }
  var sess = window.HOUSING_SESSION || {};
  var row = {
    app_id:         String(appId),
    body:           String(body).trim(),
    author_email:   sess.email || null,
    author_name:    sess.name  || null,
    author_role:    sess.role  || (window.currentRole || null)
  };
  try {
    var r = await fetch(SUPABASE_URL + '/rest/v1/housing_application_notes', {
      method:  'POST',
      headers: Object.assign({}, HOUSING_HEADERS, { 'Prefer': 'return=representation' }),
      body:    JSON.stringify(row)
    });
    if (!r.ok) {
      var e = await r.text();
      console.error('[SB] add app note '+r.status+':', e);
      throw new Error('add note failed ('+r.status+'): '+e);
    }
    var data = await r.json();
    return Array.isArray(data) ? data[0] : data;
  } catch(e) {
    console.warn('[SB] add app note error:', e);
    throw e;
  }
}

// ── Tenant notes (workflow prompts) ──────────────────────────────────────────
// Reusable helpers so common flows (move-in, inspection, work-order complete)
// can capture a quick note against the tenant file. Notes live in `tenant_notes`
// keyed by tenant_id; these mirror the TIC's own note save path but work from
// any page. All are fire-and-forget safe (catch + warn, never throw).

// Resolve a tenant_id by full name. Find-first (avoids minting duplicate tenant
// rows, which the trigger-synced tenants table is prone to); creates a minimal
// row only as a last resort. Returns null if it can't resolve.
async function sbResolveTenantId(fullName) {
  fullName = (fullName || '').trim();
  if (!fullName) return null;
  try {
    // merged_into=is.null mirrors the TIC's own resolver (_ticResolveTenant):
    // without it a note could land on a merged-away tenant row the TIC never
    // displays — the note "saves" but is invisible in the tenant file, and the
    // hero badge falsely reports "No notes". order=id.asc makes the limit=1
    // pick deterministic when duplicates exist.
    var r = await fetch(SUPABASE_URL + '/rest/v1/tenants?full_name=eq.'
      + encodeURIComponent(fullName) + '&merged_into=is.null&select=id&order=id.asc&limit=1', { headers: HOUSING_HEADERS });
    if (r.ok) { var rows = await r.json(); if (rows && rows.length && rows[0].id) return rows[0].id; }
    var ins = await fetch(SUPABASE_URL + '/rest/v1/tenants', {
      method: 'POST',
      headers: Object.assign({}, HOUSING_HEADERS, { 'Prefer': 'return=representation' }),
      body: JSON.stringify({ full_name: fullName })
    });
    if (ins.ok) { var created = await ins.json(); return (created && created[0] && created[0].id) || null; }
  } catch (e) { console.warn('[note] resolve tenant failed:', e); }
  return null;
}

// Save a note to tenant_notes for the given tenant (by name or explicit id).
// opts.prefix prepends a workflow tag; opts.context is recorded in the audit row.
async function sbSaveTenantNote(fullName, body, opts) {
  opts = opts || {};
  body = (body || '').trim();
  if (!body) return false;
  var tid = opts.tenantId || await sbResolveTenantId(fullName);
  if (!tid) { if (typeof showToast === 'function') showToast('Could not save note — tenant not found', { type: 'error' }); return false; }
  var author = (window.HOUSING_SESSION && HOUSING_SESSION.name)
             || (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('clfn_housing_name'))
             || 'Unknown';
  try {
    var r = await fetch(SUPABASE_URL + '/rest/v1/tenant_notes', {
      method: 'POST',
      headers: Object.assign({}, HOUSING_HEADERS, { 'Prefer': 'return=minimal' }),
      body: JSON.stringify({
        tenant_id:   tid,
        note_body:   (opts.prefix ? opts.prefix + ' ' : '') + body,
        author_name: author,
        created_at:  new Date().toISOString()
      })
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    if (typeof auditEntry === 'function') {
      auditEntry('TENANT:' + tid, 'tenant_note_add', 'Note added via ' + (opts.context || 'workflow'), window.currentRole || 'staff');
    }
    if (typeof showToast === 'function') showToast('Note saved.', {type:'info'});
    return true;
  } catch (e) {
    console.warn('[note] save failed:', e);
    if (typeof showToast === 'function') showToast('Note save failed: ' + e.message, { type: 'error' });
    return false;
  }
}

// Show an OPTIONAL note prompt inside a workflow, then save what's entered.
// Never blocks the flow — returns a promise that resolves whether or not a note
// was saved. Skipping (Cancel / empty) is a no-op.
function promptTenantNote(fullName, opts) {
  opts = opts || {};
  if (!fullName || typeof showPrompt !== 'function') return Promise.resolve(false);
  return showPrompt({
    title:       opts.title || 'Add a note (optional)',
    message:     opts.message || ('Add a quick note for ' + escapeHtml(fullName) + '. Leave blank to skip.'),
    placeholder: opts.placeholder || 'Type a note…',
    multiline:   true,
    confirmText: opts.confirmText || 'Save note',
    cancelText:  'Skip'
  }).then(function (txt) {
    if (txt == null) return false;
    if (!String(txt).trim()) return false;
    return sbSaveTenantNote(fullName, txt, { context: opts.context, prefix: opts.prefix });
  });
}
if (typeof window !== 'undefined') {
  window.sbResolveTenantId = sbResolveTenantId;
  window.sbSaveTenantNote  = sbSaveTenantNote;
  window.promptTenantNote  = promptTenantNote;
}

// ── Unit notes (note log per housing unit; mirrors tenant_notes) ───────────
// Load the note rows for a unit, newest first.
async function sbLoadUnitNotes(unitId) {
  if (!unitId) return [];
  try {
    var r = await fetch(SUPABASE_URL + '/rest/v1/unit_notes?unit_id=eq.'
                        + encodeURIComponent(unitId) + '&select=*&order=created_at.desc',
                        { headers: HOUSING_HEADERS });
    if (!r.ok) { console.warn('[unit-note] load HTTP ' + r.status); return []; }
    var rows = await r.json();
    return Array.isArray(rows) ? rows : [];
  } catch (e) { console.warn('[unit-note] load failed:', e); return []; }
}
// Append a note to unit_notes (author + timestamp from the session). Returns the
// saved row (or a local shape) on success, null on failure.
async function sbSaveUnitNote(unitId, body) {
  body = (body || '').trim();
  if (!unitId || !body) return null;
  var author = (window.HOUSING_SESSION && HOUSING_SESSION.name)
             || (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('clfn_housing_name'))
             || 'Unknown';
  var email  = (window.HOUSING_SESSION && HOUSING_SESSION.email) || '';
  var payload = { unit_id: unitId, note_body: body, author_name: author, author_email: email, created_at: new Date().toISOString() };
  try {
    var r = await fetch(SUPABASE_URL + '/rest/v1/unit_notes', {
      method: 'POST',
      headers: Object.assign({}, HOUSING_HEADERS, { 'Prefer': 'return=representation' }),
      body: JSON.stringify(payload)
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    var rows = await r.json();
    var added = (rows && rows[0]) || payload;
    if (typeof auditEntry === 'function') {
      auditEntry('UNIT:' + unitId, 'unit_note_add', 'Note added (' + body.length + ' chars)', window.currentRole || 'staff');
    }
    return added;
  } catch (e) {
    console.warn('[unit-note] save failed:', e);
    if (typeof showToast === 'function') showToast('Note save failed: ' + e.message, { type: 'error' });
    return null;
  }
}
if (typeof window !== 'undefined') {
  window.sbLoadUnitNotes = sbLoadUnitNotes;
  window.sbSaveUnitNote  = sbSaveUnitNote;
}

// Contractor notes — same append-only note log as unit_notes / tenant_notes,
// keyed by the contractor's TEXT id ('CT-...'). Read via contractor_notes.
async function sbLoadContractorNotes(contractorId) {
  if (!contractorId) return [];
  try {
    var r = await fetch(SUPABASE_URL + '/rest/v1/contractor_notes?contractor_id=eq.'
                        + encodeURIComponent(contractorId) + '&select=*&order=created_at.desc',
                        { headers: HOUSING_HEADERS });
    if (!r.ok) { console.warn('[ct-note] load HTTP ' + r.status); return []; }
    var rows = await r.json();
    return Array.isArray(rows) ? rows : [];
  } catch (e) { console.warn('[ct-note] load failed:', e); return []; }
}
// Append a note to contractor_notes (author + timestamp from the session).
// Returns the saved row (or a local shape) on success, null on failure.
async function sbSaveContractorNote(contractorId, body) {
  body = (body || '').trim();
  if (!contractorId || !body) return null;
  var author = (window.HOUSING_SESSION && HOUSING_SESSION.name)
             || (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('clfn_housing_name'))
             || 'Unknown';
  var email  = (window.HOUSING_SESSION && HOUSING_SESSION.email) || '';
  var payload = { contractor_id: contractorId, note_body: body, author_name: author, author_email: email, created_at: new Date().toISOString() };
  try {
    var r = await fetch(SUPABASE_URL + '/rest/v1/contractor_notes', {
      method: 'POST',
      headers: Object.assign({}, HOUSING_HEADERS, { 'Prefer': 'return=representation' }),
      body: JSON.stringify(payload)
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    var rows = await r.json();
    var added = (rows && rows[0]) || payload;
    if (typeof auditEntry === 'function') {
      auditEntry('CT:' + contractorId, 'contractor_note_add', 'Note added (' + body.length + ' chars)', window.currentRole || 'staff');
    }
    return added;
  } catch (e) {
    console.warn('[ct-note] save failed:', e);
    if (typeof showToast === 'function') showToast('Note save failed: ' + e.message, { type: 'error' });
    return null;
  }
}
if (typeof window !== 'undefined') {
  window.sbLoadContractorNotes = sbLoadContractorNotes;
  window.sbSaveContractorNote  = sbSaveContractorNote;
}

// ── Required-field helpers ────────────────────────────────────────────────────
// Drive both the application form's red * markers AND validation off a single
// settings key (housing_settings.required_fields). ED-only edit; everyone else
// just observes whatever the saved config says.
function getRequiredFieldsConfig() {
  var cfg = ((window._appSettings || {}).required_fields) || {};
  var out = {};
  (window.APP_REQ_FIELDS || []).forEach(function(f){
    out[f.id] = (cfg[f.id] === undefined) ? !!f.defaultRequired : !!cfg[f.id];
  });
  (window.APP_REQ_SECTIONS || []).forEach(function(s){
    out[s.id] = (cfg[s.id] === undefined) ? !!s.defaultRequired : !!cfg[s.id];
  });
  return out;
}
function isFieldRequired(fieldId) {
  var cfg = getRequiredFieldsConfig();
  return cfg[fieldId] !== false;
}
function isSectionRequired(sectionId) {
  var cfg = getRequiredFieldsConfig();
  return cfg[sectionId] === true;
}
// Toggle the red * marker on every wrapper to match the saved config.
// Two passes:
//   1. Static  — `.f[data-req="<id>"]` wrappers in housing.html
//   2. Dynamic — for each registry entry with rowOf+dataRole, walk every
//                .rrow in that container and find the .f wrapping the
//                input[data-role="<dataRole>"], then toggle the .r marker.
//                Called by add* row builders so newly-added rows pick up
//                the saved config without page reload.
// Hidden via the .hidden utility class — no inline styles touched.
function applyRequiredFields() {
  var cfg = getRequiredFieldsConfig();
  // Pass 1: static fields
  document.querySelectorAll('.f[data-req]').forEach(function(wrap){
    var key = wrap.getAttribute('data-req');
    var star = wrap.querySelector('.r');
    if (!star) return;
    star.classList.toggle('hidden', cfg[key] === false);
  });
  // Pass 2: dynamic-row fields
  (window.APP_REQ_FIELDS || []).forEach(function(f){
    if (!f.rowOf || !f.dataRole) return;
    var container = document.querySelector(f.rowOf);
    if (!container) return;
    container.querySelectorAll('.rrow').forEach(function(row){
      var input = row.querySelector('[data-role="' + f.dataRole + '"]');
      if (!input) return;
      var wrap = input.closest('.f');
      if (!wrap) return;
      // Stamp data-req for symmetry with static fields (handy for selectors)
      if (!wrap.hasAttribute('data-req')) wrap.setAttribute('data-req', f.id);
      // Row templates pre-include <span class="r"> (visible or .hidden) for
      // every configurable field — we only toggle, never create. Income type
      // and employment status get their markers managed dynamically by
      // onIncomePersonChange so we don't fight that logic.
      var star = wrap.querySelector('.r');
      if (star) star.classList.toggle('hidden', cfg[f.id] === false);
    });
  });
}

// ── sbSaveSetting ─────────────────────────────────────────────────────────────
async function sbSaveSetting(key, value) {
  if (!_sbValidateSaveInput({ key: key, value: value }, {
    keyMaxLen: 100,
    maxBytes:  512 * 1024,
    valueField:'value'
  })) {
    return false;
  }
  try {
    // Try PATCH first (update existing row). Falls through to INSERT if no row exists.
    var patchR = await fetch(
      SUPABASE_URL + '/rest/v1/housing_settings?key=eq.' + encodeURIComponent(key),
      {
        method:  'PATCH',
        headers: Object.assign({}, HOUSING_HEADERS, { 'Prefer': 'return=minimal,count=exact' }),
        body:    JSON.stringify({ value: value })
      }
    );
    if (patchR.ok) {
      var cr = patchR.headers.get('Content-Range');
      // Content-Range: */0 means 0 rows matched — need to INSERT instead
      var total = cr ? parseInt((cr.split('/')[1] || '').trim()) : -1;
      if (total !== 0) return true; // patched 1+ rows
    }
    // INSERT new row (no existing row for this key)
    var r = await fetch(SUPABASE_URL + '/rest/v1/housing_settings', {
      method:  'POST',
      headers: Object.assign({}, HOUSING_HEADERS, { 'Prefer': 'return=minimal' }),
      body:    JSON.stringify({ key: key, value: value })
    });
    if (!r.ok) {
      var errBody = await r.text();
      console.warn('[SB] save setting failed (HTTP ' + r.status + '):', errBody);
      return false;
    }
    return true;
  } catch(e) {
    console.warn('[SB] save setting error:', e);
    return false;
  }
}

// ── persistSetting ────────────────────────────────────────────────────────────
// One shared "upsert a housing_settings row + update the _appSettings cache +
// audit + toast" flow. Replaces 7 hand-rolled copies of the identical
// POST/merge-duplicates block (notifications.js x6, scoring.js x1). Keeps the
// merge-duplicates upsert those sites already used (byte-identical server
// behavior — deliberately NOT switched to sbSaveSetting's PATCH-then-INSERT).
// opts: { auditAction, auditDetail, okMsg, failMsg, onSuccess }
// Resolves true/false; never throws.
function persistSetting(key, value, opts) {
  opts = opts || {};
  function _fail(msg) {
    if (typeof showToast === 'function') showToast(opts.failMsg || msg, {type:'error'});
    return false;
  }
  return fetch(SUPABASE_URL + '/rest/v1/housing_settings', {
    method:  'POST',
    headers: Object.assign({}, HOUSING_HEADERS, { 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
    body:    JSON.stringify({ key: key, value: value })
  }).then(function(r) {
    if (!r.ok) return _fail('Save failed — check connection');
    if (!window._appSettings) window._appSettings = {};
    window._appSettings[key] = value;
    if (opts.auditAction && typeof auditEntry === 'function') {
      auditEntry('SETTINGS', opts.auditAction, opts.auditDetail || (key + ' updated'), window.currentRole || 'ed');
    }
    if (opts.okMsg && typeof showToast === 'function') showToast(opts.okMsg, {type:'info'});
    if (typeof opts.onSuccess === 'function') opts.onSuccess();
    return true;
  }).catch(function(e) {
    console.warn('[settings] persist ' + key + ' failed:', e);
    return _fail('Save failed');
  });
}
window.persistSetting = persistSetting;

// ── sbLoadContractors ─────────────────────────────────────────────────────────
async function sbLoadContractors() {
  try {
    var r = await fetch(
      SUPABASE_URL + '/rest/v1/housing_contractors?select=*&order=created_at',
      { headers: HOUSING_HEADERS }
    );
    if (!r.ok) return null;
    var data = await r.json();
    return data.map(function(row) {
      return Object.assign({}, row.data || {}, {
        id:     row.id,
        name:   row.name,
        trade:  row.trade,
        status: row.status
      });
    });
  } catch(e) {
    console.warn('[SB] load contractors failed:', e);
    return null;
  }
}

// ── sbSaveContractor ──────────────────────────────────────────────────────────
async function sbSaveContractor(ct) {
  if (!_sbValidateSaveInput(ct, { requireId: true, maxBytes: 512 * 1024 })) {
    return Promise.reject(new Error('sbSaveContractor: invalid input'));
  }
  try {
    var r = await fetch(SUPABASE_URL + '/rest/v1/housing_contractors', {
      method:  'POST',
      headers: Object.assign({}, HOUSING_HEADERS, { 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
      body:    JSON.stringify({
        id:         ct.id,
        name:       ct.name   || null,
        trade:      ct.trade  || null,
        status:     ct.status || 'pending_review',
        data:       ct,
        updated_at: new Date().toISOString()
      })
    });
    if (!r.ok) { console.warn('[SB] save contractor failed:', await r.text()); return false; }
    return true;
  } catch(e) {
    console.warn('[SB] save contractor error:', e);
    return false;
  }
}


// ── sbLookup* ─────────────────────────────────────────────────────────────────
// Synchronous lookups against the in-memory caches. Used by the landing-page
// Quick Lookup panel — no Supabase round-trips. Each function returns an
// array of {id, label, meta} suitable for direct render.
function sbLookupTenants(q) {
  q = (q || '').toLowerCase().trim();
  if (!q) return [];
  var apps = (typeof applications !== 'undefined' && applications) ? applications : [];
  var out = [];
  for (var i = 0; i < apps.length && out.length < 20; i++) {
    var a = apps[i]; if (!a || a.archived) continue;
    var name = ((a.fn || '') + ' ' + (a.ln || '')).trim();
    var hay  = (name + ' ' + (a.id || '') + ' ' + (a.email || '') + ' ' + (a.phone || '')).toLowerCase();
    if (hay.indexOf(q) === -1) continue;
    var statusDisplay = a.status === 'draft' ? '✏️ Draft' : (a.status || '');
    out.push({
      id:    a.id,
      label: name || a.id,
      meta:  (a.id || '') + (statusDisplay ? ' · ' + statusDisplay : '') + (a.tier ? ' · ' + a.tier : '')
    });
  }
  return out;
}

// ── BCR registry (banished / housing-ineligible persons) ─────────────────────
// Name-keyed list (Phase T1). Loaded at boot; checks are case-insensitive.
window._bcrRegistry = window._bcrRegistry || [];

async function sbLoadBcrRegistry() {
  try {
    var r = await fetch(SUPABASE_URL + '/rest/v1/bcr_registry?select=*&active=eq.true&order=full_name',
      { headers: HOUSING_HEADERS });
    if (r.ok) window._bcrRegistry = await r.json();
  } catch (e) { console.warn('[BCR] load failed:', e); }
  return window._bcrRegistry;
}
window.sbLoadBcrRegistry = sbLoadBcrRegistry;

// Case-insensitive name lookup → active BCR record, or null.
function bcrLookup(name) {
  var n = (name || '').trim().toLowerCase();
  if (!n) return null;
  var list = window._bcrRegistry || [];
  for (var i = 0; i < list.length; i++) {
    if (((list[i].full_name) || '').trim().toLowerCase() === n) return list[i];
  }
  return null;
}
window.bcrLookup = bcrLookup;
window.isBcrd = function (name) { return !!bcrLookup(name); };

// Application-level ineligibility: the applicant's name is on the active BCR
// list (banished, or evicted for harbouring). Used to keep them out of the
// Applications-by-Type KPI counts while Match still lists them flagged as
// ineligible (their record stays; nothing is deleted).
function appIsBcrIneligible(app){
  if (!app) return false;
  return !!bcrLookup(((app.fn || '') + ' ' + (app.ln || '')).trim());
}
window.appIsBcrIneligible = appIsBcrIneligible;

async function sbAddBcr(fullName, bcrdDate, reason, dateOfBirth) {
  var actor = (window.HOUSING_SESSION && HOUSING_SESSION.email) || window.currentRole || '';
  var body = {
    full_name: (fullName || '').trim(), bcrd_date: bcrdDate || null,
    reason: reason || null, date_of_birth: dateOfBirth || null, active: true, created_by: actor
  };
  if (!body.full_name) throw new Error('A name is required.');
  // Server-side dedupe: the in-memory registry can be stale (tab open all
  // morning; two staff at once; the Tenant-Card stub written seconds ago from
  // another device). A duplicate ACTIVE row is dangerous — Lift then only
  // deactivates one and the ban appears un-liftable. Check the server first
  // and UPDATE the existing row instead of inserting a twin.
  try {
    var chk = await fetch(SUPABASE_URL + '/rest/v1/bcr_registry?full_name=ilike.'
      + encodeURIComponent(body.full_name.replace(/[%_\\]/g, '\\$&')) + '&active=eq.true&select=*',
      { headers: HOUSING_HEADERS });
    if (chk.ok) {
      var dups = await chk.json();
      if (dups && dups.length) {
        var ex = dups[0];
        // Refresh the cache with what the server actually has.
        window._bcrRegistry = (window._bcrRegistry || []).filter(function(x){ return x.id !== ex.id; }).concat([ex]);
        return sbUpdateBcr(ex.id, {
          bcrd_date: body.bcrd_date || ex.bcrd_date || null,
          reason: body.reason || ex.reason || null,
          date_of_birth: body.date_of_birth || ex.date_of_birth || null
        });
      }
    }
  } catch (e) { /* offline — fall through to the plain insert */ }
  var r = await fetch(SUPABASE_URL + '/rest/v1/bcr_registry', {
    method: 'POST',
    headers: Object.assign({}, HOUSING_HEADERS, { 'Prefer': 'return=representation' }),
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(await r.text());
  var rows = await r.json();
  var row = (rows && rows[0]) || body;
  window._bcrRegistry = window._bcrRegistry || [];
  window._bcrRegistry.push(row);
  if (typeof auditEntry === 'function') auditEntry(row.id || '-', 'bcr_added', 'BCR added: ' + body.full_name + (bcrdDate ? ' (' + bcrdDate + ')' : ''));
  return row;
}
window.sbAddBcr = sbAddBcr;

async function sbLiftBcr(id) {
  var actor = (window.HOUSING_SESSION && HOUSING_SESSION.email) || window.currentRole || '';
  var patch = { active: false, lifted_at: new Date().toISOString(), lifted_by: actor };
  // Lift by NAME, not just id: historical duplicates (from before server-side
  // dedupe) would otherwise keep the person blocked after a "lift". Fall back
  // to the id-only lift when the name can't be resolved.
  var row = (window._bcrRegistry || []).find(function (x) { return x.id === id; });
  var name = row && (row.full_name || '').trim();
  var url = name
    ? SUPABASE_URL + '/rest/v1/bcr_registry?full_name=ilike.' + encodeURIComponent(name.replace(/[%_\\]/g, '\\$&')) + '&active=eq.true'
    : SUPABASE_URL + '/rest/v1/bcr_registry?id=eq.' + encodeURIComponent(id);
  var r = await fetch(url, {
    method: 'PATCH',
    headers: Object.assign({}, HOUSING_HEADERS, { 'Prefer': 'return=minimal' }),
    body: JSON.stringify(patch)
  });
  if (!r.ok) throw new Error(await r.text());
  var lname = (name || '').toLowerCase();
  window._bcrRegistry = (window._bcrRegistry || []).filter(function (x) {
    return x.id !== id && (!lname || ((x.full_name || '').trim().toLowerCase() !== lname));
  });
  if (typeof auditEntry === 'function') auditEntry(id, 'bcr_lifted', 'BCR lifted' + (name ? ' for ' + name + ' (all active entries)' : ''));
  return true;
}
window.sbLiftBcr = sbLiftBcr;

// Complete/update an existing active BCR row (fills in a details-pending
// stub written by the Tenant Card sync without minting a duplicate).
async function sbUpdateBcr(id, patch) {
  var r = await fetch(SUPABASE_URL + '/rest/v1/bcr_registry?id=eq.' + encodeURIComponent(id), {
    method: 'PATCH',
    headers: Object.assign({}, HOUSING_HEADERS, { 'Prefer': 'return=representation' }),
    body: JSON.stringify(patch)
  });
  if (!r.ok) throw new Error(await r.text());
  var rows = await r.json();
  var row = (rows && rows[0]) || null;
  window._bcrRegistry = (window._bcrRegistry || []).map(function (x) {
    return x.id === id ? (row || Object.assign({}, x, patch)) : x;
  });
  if (typeof auditEntry === 'function') auditEntry(id, 'bcr_updated', 'BCR details completed/updated');
  return row;
}
window.sbUpdateBcr = sbUpdateBcr;

// The marker sbAddBcr stubs carry until staff fill in the real details.
var BCR_PENDING_REASON = 'Details pending — set from Tenant Card';
window.BCR_PENDING_REASON = BCR_PENDING_REASON;
function bcrIsIncomplete(b){
  // Reason is optional by design — the BCR date (or the pending marker) is
  // what distinguishes a completed entry from a Tenant-Card stub.
  if (!b) return false;
  return !b.bcrd_date || (b.reason || '') === BCR_PENDING_REASON;
}
window.bcrIsIncomplete = bcrIsIncomplete;

function _bcrEsc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];}); }

// Self-contained BCR manager modal — add / lift banished persons. Gated by the
// manageBcr approval authority. Available wherever shared-data.js loads.
window.openBcrManager = function(prefillName){
  if (typeof APPROVAL_AUTHORITY !== 'undefined' && !APPROVAL_AUTHORITY.can('manageBcr', window.currentRole)) {
    if (typeof showToast === 'function') showToast('Only authorized staff can manage the BCR list.', { type:'error' });
    return;
  }
  var ex = document.getElementById('modalBcrManager'); if (ex) ex.remove();
  var mo = document.createElement('div');
  mo.className = 'modal-ov'; mo.id = 'modalBcrManager';
  mo.innerHTML =
    '<div class="modal" style="max-width:640px;width:96%;">'
    + '<div class="modal-hdr">'
    +   '<div><h2>BCR / Ineligibility List</h2>'
    +   '<div class="modal-hdr-sub">People banished by Band Council Resolution &mdash; not eligible for housing.</div></div>'
    +   '<button class="modal-close" onclick="var m=document.getElementById(\'modalBcrManager\');if(m)m.remove();">&#x2715;</button>'
    + '</div>'
    + '<div class="modal-body" style="padding:18px 20px;">'
    +   '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;">'
    +     '<div style="flex:1;min-width:150px;"><label class="tic-field-lbl">Full name</label><input id="bcr_name" type="text" class="tic-input" placeholder="First Last"/></div>'
    +     '<div><label class="tic-field-lbl">Date of birth</label><input id="bcr_dob" type="date" class="tic-input"/></div>'
    +     '<div><label class="tic-field-lbl">BCR date</label><input id="bcr_date" type="date" class="tic-input"/></div>'
    +   '</div>'
    +   '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-bottom:8px;">'
    +     '<div style="flex:1;min-width:150px;"><label class="tic-field-lbl">Reason (optional)</label><input id="bcr_reason" type="text" class="tic-input" placeholder="e.g. BCR 2026-014"/></div>'
    +     '<button class="btn btn-primary" onclick="_bcrAddSubmit()">+ Add</button>'
    +   '</div>'
    +   '<label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);margin-bottom:16px;cursor:pointer;">'
    +     '<input id="bcr_harbouring" type="checkbox" onchange="_bcrHarbouringToggle(this)"/>'
    +     'Evicted for harbouring (housing/sheltering someone already on this list)'
    +   '</label>'
    +   '<div id="bcr_list"></div>'
    + '</div>'
    + '</div>';
  mo.addEventListener('click', function(e){ if (e.target === mo) mo.remove(); });
  // Above the TIC overlay (z-index 900) — the manager is opened FROM the
  // Tenant Card when a tenancy is set to Banished/Harbouring, and .modal-ov's
  // default 200 left it hidden behind the card.
  mo.style.zIndex = '1000';
  document.body.appendChild(mo);
  mo.style.display = ''; mo.classList.add('on');
  if (prefillName) { var ni = document.getElementById('bcr_name'); if (ni) ni.value = prefillName; }
  _bcrRenderList();
};

function _bcrRenderList(){
  var el = document.getElementById('bcr_list'); if (!el) return;
  var list = (window._bcrRegistry || []).slice().sort(function(a,b){ return (a.full_name||'').localeCompare(b.full_name||''); });
  if (!list.length) { el.innerHTML = '<div style="text-align:center;color:var(--muted);font-size:13px;padding:18px;">No one on the BCR list.</div>'; return; }
  el.innerHTML = list.map(function(b){
    return '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 0;border-bottom:1px solid var(--border);">'
      + '<div><div style="font-weight:700;font-size:13px;">' + _bcrEsc(b.full_name||'') + '</div>'
      + '<div style="font-size:11px;color:var(--muted);">' + (b.date_of_birth ? 'DOB ' + _bcrEsc(b.date_of_birth) + ' &middot; ' : '') + 'BCR&#39;d' + (b.bcrd_date ? ' ' + _bcrEsc(b.bcrd_date) : '') + (b.reason ? ' &middot; ' + _bcrEsc(b.reason) : '') + '</div></div>'
      + '<button class="btn btn-ghost" style="font-size:12px;" onclick="_bcrLift(\'' + _bcrEsc(b.id) + '\')">Lift</button>'
      + '</div>';
  }).join('');
}

// Toggling the "Evicted for harbouring" checkbox fills the free-text Reason
// field with a standard phrase, so staff don't need to type it themselves —
// but only when Reason is empty (won't overwrite something already typed),
// and unchecking only clears it back out if Reason still exactly matches
// (so a manually edited reason is never silently wiped).
var _BCR_HARBOURING_TEXT = 'Evicted for harbouring';
function _bcrHarbouringToggle(cb){
  var r = document.getElementById('bcr_reason'); if (!r) return;
  if (cb.checked) {
    if (!r.value.trim()) r.value = _BCR_HARBOURING_TEXT;
  } else if (r.value.trim() === _BCR_HARBOURING_TEXT) {
    r.value = '';
  }
}
window._bcrHarbouringToggle = _bcrHarbouringToggle;

function _bcrAddSubmit(){
  var name   = (document.getElementById('bcr_name')   || {}).value || '';
  var dob    = (document.getElementById('bcr_dob')    || {}).value || '';
  var date   = (document.getElementById('bcr_date')   || {}).value || '';
  var reason = (document.getElementById('bcr_reason') || {}).value || '';
  if (!name.trim()) { if (typeof showToast === 'function') showToast('Enter a name.', { type:'error' }); return; }
  // Same name already active on the list (e.g. the details-pending stub the
  // Tenant Card sync wrote) → complete that row instead of duplicating it.
  var existing = bcrLookup(name);
  var op = existing
    ? sbUpdateBcr(existing.id, {
        bcrd_date: date || existing.bcrd_date || null,
        reason: reason || (bcrIsIncomplete(existing) ? null : existing.reason) || null,
        date_of_birth: dob || existing.date_of_birth || null
      })
    : sbAddBcr(name, date, reason, dob);
  op.then(function(){
    ['bcr_name','bcr_dob','bcr_date','bcr_reason'].forEach(function(id){ var e=document.getElementById(id); if(e) e.value=''; });
    var hb = document.getElementById('bcr_harbouring'); if (hb) hb.checked = false;
    _bcrRenderList();
    if (typeof showToast === 'function') showToast(existing ? 'BCR details updated.' : 'Added to BCR list.', {type:'info'});
  }).catch(function(e){ if (typeof showToast === 'function') showToast((existing ? 'Update' : 'Add') + ' failed: ' + e.message, { type:'error' }); });
}
window._bcrAddSubmit = _bcrAddSubmit;

function _bcrLift(id){
  if (!window.confirm('Lift the BCR for this person? They will become eligible for housing again.')) return;
  sbLiftBcr(id).then(function(){ _bcrRenderList(); if (typeof showToast === 'function') showToast('BCR lifted.', {type:'info'}); })
    .catch(function(e){ if (typeof showToast === 'function') showToast('Lift failed: ' + e.message, { type:'error' }); });
}
window._bcrLift = _bcrLift;

// ── Tenant merge (person identity, Phase T3) ─────────────────────────────────
// The sync trigger creates a new tenants row per assignment, so one person can
// have several rows. merged_into points a duplicate at the canonical row.
async function sbLoadAllTenants(){
  try {
    var r = await fetch(SUPABASE_URL + '/rest/v1/tenants?select=id,full_name,status,current_unit_id,application_id,merged_into,created_at&order=full_name,created_at',
      { headers: HOUSING_HEADERS });
    if (r.ok) return await r.json();
  } catch (e) { console.warn('[merge] load tenants failed:', e); }
  return [];
}
window.sbLoadAllTenants = sbLoadAllTenants;

async function sbMergeTenants(canonicalId, dupIds){
  for (var i = 0; i < dupIds.length; i++) {
    if (dupIds[i] === canonicalId) continue;
    var r = await fetch(SUPABASE_URL + '/rest/v1/tenants?id=eq.' + encodeURIComponent(dupIds[i]), {
      method: 'PATCH',
      headers: Object.assign({}, HOUSING_HEADERS, { 'Prefer': 'return=minimal' }),
      body: JSON.stringify({ merged_into: canonicalId, updated_at: new Date().toISOString() })
    });
    if (!r.ok) throw new Error(await r.text());
  }
  if (typeof auditEntry === 'function') auditEntry(canonicalId, 'tenants_merged', dupIds.length + ' duplicate tenant record(s) merged');
  return true;
}
window.sbMergeTenants = sbMergeTenants;

window.openTenantMergeManager = function(){
  if (typeof APPROVAL_AUTHORITY !== 'undefined' && !APPROVAL_AUTHORITY.can('mergeTenants', window.currentRole)) {
    if (typeof showToast === 'function') showToast('Only authorized staff can merge tenant records.', { type:'error' });
    return;
  }
  var ex = document.getElementById('modalTenantMerge'); if (ex) ex.remove();
  var mo = document.createElement('div');
  mo.className = 'modal-ov'; mo.id = 'modalTenantMerge';
  mo.innerHTML =
    '<div class="modal" style="max-width:680px;width:96%;">'
    + '<div class="modal-hdr"><div><h2>Merge Duplicate Tenants</h2>'
    +   '<div class="modal-hdr-sub">Same person, multiple records. Pick the record to keep; the others point to it (reversible).</div></div>'
    +   '<button class="modal-close" onclick="var m=document.getElementById(\'modalTenantMerge\');if(m)m.remove();">&#x2715;</button></div>'
    + '<div class="modal-body" style="padding:16px 20px;"><div id="merge_body">Loading&hellip;</div></div>'
    + '</div>';
  mo.addEventListener('click', function(e){ if (e.target === mo) mo.remove(); });
  document.body.appendChild(mo); mo.style.display = ''; mo.classList.add('on');
  _mergeReload();
};

function _mergeReload(){
  var body = document.getElementById('merge_body'); if (!body) return;
  body.innerHTML = 'Loading&hellip;';
  sbLoadAllTenants().then(function(rows){
    var groups = {};
    rows.forEach(function(t){
      if (t.merged_into) return;                 // already merged away
      var k = (t.full_name || '').trim().toLowerCase();
      if (!k) return;
      (groups[k] = groups[k] || []).push(t);
    });
    var dups = Object.keys(groups).map(function(k){ return groups[k]; }).filter(function(g){ return g.length > 1; });
    window._mergeGroups = dups;
    if (!dups.length) { body.innerHTML = '<div style="text-align:center;color:var(--muted);padding:20px;font-size:13px;">No duplicate tenant records found.</div>'; return; }
    body.innerHTML = dups.map(function(g, gi){
      var canonIdx = 0; for (var i = 0; i < g.length; i++){ if (g[i].status === 'active'){ canonIdx = i; break; } }
      var rowsHtml = g.map(function(t, ri){
        var unit = '';
        try { var u = (window.housingUnits||[]).find(function(x){ return x.id === t.current_unit_id; }); unit = u ? (u.num + ' ' + u.street) : (t.current_unit_id ? ('unit ' + t.current_unit_id) : ''); } catch(e){}
        var meta = [t.status, unit, (t.created_at||'').slice(0,10)].filter(Boolean).join(' · ');
        return '<label style="display:flex;align-items:center;gap:8px;padding:6px 0;font-size:13px;cursor:pointer;">'
          + '<input type="radio" name="merge_canon_' + gi + '" value="' + _bcrEsc(t.id) + '"' + (ri === canonIdx ? ' checked' : '') + '/>'
          + '<span><strong>' + _bcrEsc(t.full_name||'') + '</strong> <span style="color:var(--muted);font-size:11px;">' + _bcrEsc(meta) + '</span></span></label>';
      }).join('');
      return '<div style="border:1px solid var(--border);border-radius:8px;padding:12px 14px;margin-bottom:12px;">'
        + '<div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--muted);margin-bottom:6px;">' + _bcrEsc(g[0].full_name||'') + ' &mdash; ' + g.length + ' records</div>'
        + rowsHtml
        + '<div style="text-align:right;margin-top:8px;"><button class="btn btn-primary" onclick="_mergeDoGroup(' + gi + ')">Merge into selected</button></div>'
        + '</div>';
    }).join('');
  });
}

// Merges immediately on click -- no separate confirm step. Which record is
// canonical is already a deliberate choice (the radio picker above this
// button), so a second "are you sure" click was just extra friction; the
// operation is reversible anyway (sbMergeTenants sets merged_into rather
// than deleting).
function _mergeDoGroup(gi){
  var g = (window._mergeGroups || [])[gi]; if (!g) return;
  var sel = document.querySelector('input[name="merge_canon_' + gi + '"]:checked');
  var canonicalId = sel ? sel.value : null;
  if (!canonicalId) { if (typeof showToast === 'function') showToast('Pick a record to keep.', { type:'error' }); return; }
  var dupIds = g.map(function(t){ return t.id; }).filter(function(id){ return id !== canonicalId; });
  if (!dupIds.length) return;
  sbMergeTenants(canonicalId, dupIds)
    .then(function(){ _mergeReload(); if (typeof showToast === 'function') showToast('Records merged.', {type:'info'}); })
    .catch(function(e){ if (typeof showToast === 'function') showToast('Merge failed: ' + e.message, { type:'error' }); });
}
window._mergeDoGroup = _mergeDoGroup;

function sbLookupUnits(q) {
  q = (q || '').toLowerCase().trim();
  if (!q) return [];
  var units = (typeof housingUnits !== 'undefined' && housingUnits) ? housingUnits : (window.HOUSING_UNITS_DATA || []);
  var out = [];
  for (var i = 0; i < units.length && out.length < 20; i++) {
    var u = units[i]; if (!u || u.archived) continue;
    var addr = ((u.num||'') + ' ' + (u.street||'')).trim();
    var hay  = (addr + ' ' + (u.assignedName||'') + ' ' + (u.id||'') + ' ' + (u.phase||'') + ' ' + (u.acctNumber||'') + ' ' + (u.status||'')).toLowerCase();
    if (hay.indexOf(q) === -1) continue;
    out.push({
      id:    u.id,
      label: addr || u.id,
      meta:  (u.status||'') + (u.assignedName ? ' · ' + u.assignedName : '') + (u.bedrooms ? ' · ' + u.bedrooms + 'bd' : '')
    });
  }
  return out;
}

function sbLookupSOWs(q) {
  q = (q || '').toLowerCase().trim();
  if (!q) return [];
  var cache = window._sowCache || {};
  var units = (typeof housingUnits !== 'undefined' && housingUnits) ? housingUnits : [];
  var out = [];
  Object.keys(cache).forEach(function(unitId) {
    if (out.length >= 20) return;
    // Use getUnitSowList to handle both multi-SOW and legacy flat cache shapes
    var sows = (typeof getUnitSowList === 'function') ? getUnitSowList(unitId) : [];
    if (!sows.length) { var _r = cache[unitId]; if (_r && (_r.contractor||_r.project_number)) sows = [_r]; }
    var unit = null;
    for (var i = 0; i < units.length; i++) { if (units[i] && units[i].id === unitId) { unit = units[i]; break; } }
    var addr = unit ? ((unit.num||'') + ' ' + (unit.street||'')).trim() : unitId;
    sows.forEach(function(sow) {
      if (out.length >= 20 || !sow) return;
      var pn  = sow.project_number || sow.projectNumber || '';
      var hay = (addr + ' ' + pn + ' ' + (sow.contractor||'') + ' ' + (sow.approval_status||sow.approvalStatus||'')).toLowerCase();
      if (hay.indexOf(q) === -1) return;
      out.push({
        id:    unitId,
        label: pn || ('Request · ' + addr),
        meta:  addr + (sow.contractor ? ' · ' + sow.contractor : '') + (sow.approval_status ? ' · ' + sow.approval_status : '')
      });
    });
  });
  return out;
}

function sbLookupRFQs(q) {
  q = (q || '').toLowerCase().trim();
  if (!q) return [];
  var cache = window._rfqCache || {};
  var units = (typeof housingUnits !== 'undefined' && housingUnits) ? housingUnits : [];
  var cts   = window._contractors || [];
  var out = [];
  Object.keys(cache).forEach(function(rfqId) {
    if (out.length >= 20) return;
    var rfq = cache[rfqId]; if (!rfq) return;
    var unit = null;
    for (var i = 0; i < units.length; i++) { if (units[i] && units[i].id === rfq.sow_unit_id) { unit = units[i]; break; } }
    var addr  = unit ? ((unit.num||'') + ' ' + (unit.street||'')).trim() : (rfq.sow_unit_id||'');
    var ctName = '';
    if (rfq.awarded_contractor_id) {
      var ct = cts.find(function(c){ return c && c.id === rfq.awarded_contractor_id; });
      if (ct) ctName = ct.name || '';
    }
    var hay = (rfqId + ' ' + addr + ' ' + (rfq.sow_project_number||'') + ' ' + ctName + ' ' + (rfq.status||'')).toLowerCase();
    if (hay.indexOf(q) === -1) return;
    out.push({
      id:    rfqId,
      label: rfqId,
      meta:  addr + (rfq.status ? ' · ' + rfq.status : '') + (ctName ? ' · ' + ctName : '')
    });
  });
  return out;
}

// Quick Lookup — contractors (name / trade / phone / email / status).
function sbLookupContractors(q) {
  q = (q || '').toLowerCase().trim();
  if (!q) return [];
  var cts = window._contractors || [];
  var out = [];
  for (var i = 0; i < cts.length; i++) {
    if (out.length >= 20) break;
    var c = cts[i];
    if (!c) continue;
    var hay = ((c.name||'') + ' ' + (c.trade||'') + ' ' + (c.phone||'') + ' ' + (c.email||'') + ' ' + (c.status||'')).toLowerCase();
    if (hay.indexOf(q) === -1) continue;
    var bits = [];
    if (c.trade)  bits.push(c.trade);
    if (c.status) bits.push(String(c.status).replace(/_/g, ' '));
    if (c.phone)  bits.push(c.phone);
    out.push({ id: c.id, label: c.name || '(unnamed contractor)', meta: bits.join(' · ') });
  }
  return out;
}

// ── auditEntry ────────────────────────────────────────────────────────────────
// Writes one entry to both:
//   1. window.auditLog[]  — in-memory array for current-session display
//   2. housing_audit_log  — Supabase table for persistence and compliance
//
// entity_type is derived from the appId prefix convention:
//   'SOW:UNIT-123'  → 'sow'
//   'CT:abc'        → 'contractor'
//   'UNIT:xyz'      → 'unit'
//   'SETTINGS'      → 'settings'
//   anything else   → 'application'
function auditEntry(appId, action, detail, user) {
  // Store the logged-in user's email as the actor so entries can be filtered
  // per-user. Multiple HMs / EDs are common — role strings alone don't identify
  // who took the action. Fall back to role string for unauthenticated submissions.
  var actorEmail = (window.HOUSING_SESSION && window.HOUSING_SESSION.email) || '';
  var actor = actorEmail || user || window.currentRole || 'Staff';
  var actorName = (window.HOUSING_SESSION && window.HOUSING_SESSION.name) || '';
  // Applicant submissions on housing.html happen before HOUSING_SESSION.name
  // is populated for them — fall back to whatever the applicant typed into the
  // primary-applicant fn/ln fields so the audit "By" column isn't blank.
  if (!actorName && typeof document !== 'undefined') {
    var fnEl = document.getElementById('fn');
    var lnEl = document.getElementById('ln');
    var fn = (fnEl && fnEl.value || '').trim();
    var ln = (lnEl && lnEl.value || '').trim();
    actorName = (fn + ' ' + ln).trim();
  }
  var entry = { ts: new Date().toISOString(), appId: appId, action: action, detail: detail, user: actor, name: actorName };

  // In-memory log (page-scoped array, may not exist on all pages)
  if (typeof auditLog !== 'undefined') {
    auditLog.unshift(entry);
    if (auditLog.length > 500) auditLog = auditLog.slice(0, 500);
  }

  // Derive entity_type from appId prefix convention
  var sid   = String(appId || '');
  var etype = sid.startsWith('SOW:')  ? 'sow'
            : sid.startsWith('CT:')   ? 'contractor'
            : sid.startsWith('UNIT:') ? 'unit'
            : sid.startsWith('PRJ:')  ? 'project'
            : sid.startsWith('LOT:')  ? 'project_lot'
            : sid === 'SETTINGS'      ? 'settings'
            : 'application';

  // Persist to Supabase (fire-and-forget). Stash actor's display name inside
  // the detail JSON blob so the audit log "By" column can show a real name —
  // the actor column only carries the role string.
  fetch(SUPABASE_URL + '/rest/v1/housing_audit_log', {
    method:  'POST',
    headers: Object.assign({}, HOUSING_HEADERS, { 'Prefer': 'return=minimal' }),
    body: JSON.stringify({
      entity_type: etype,
      entity_id:   sid,
      action:      action,
      detail:      JSON.stringify({ detail: detail, name: actorName }),
      actor:       actor,
      created_at:  new Date().toISOString()
    })
  }).catch(function(e) { console.warn('[audit] save failed:', e); });
}


/* ════════════════════════════════════════════════════════════════════════════
 * SHARED DOMAIN FUNCTIONS
 * These were identical in housing.html and renos.html. Single source here.
 * Pages reference them directly — no import/export needed (all globals).
 *
 * Sections:
 *  A. Field helpers          — g(), fv(), fb(), fmtCurrency()
 *  B. Navigation utilities   — goBack variants, showDash, showWorklist...
 *  C. Worklist rendering     — renderWorklist, wlOpenApp...
 *  D. Contractor workflow    — open/close/save/render contractor modals
 *  E. SOW (Scope of Work)    — modal, save, collect, recalc
 *  F. Reno + Budget          — renderRenosView, budget pools, RBA
 *  G. Scoring                — unit score model, RBA scoring
 *  H. Staff management       — lookupUser, renderHousingUserTable
 *  I. Exports + Print        — exportInventory, exportRenos, triggerPrint
 *  J. Photos + Files         — removeRenoPhoto, scLoadDocs
 *  K. Miscellaneous          — _rsm, _realRoleForPermissions, sig helpers
 * ════════════════════════════════════════════════════════════════════════════ */
// Signature block helper for printable agreements / SOWs.
// Lives here (rather than in housing-modals.js) so that contractor pages
// — which only load shared-data.js — can also call it via printContractorAgreement.
// Signature block helper for printable agreements / SOWs.
// Two calling conventions for backwards compatibility:
//   sigBlock(label, pName, dt, imgSrc)              — 4-arg (SOW prints, etc.)
//   sigBlock(label, pName, title, dt, imgSrc)       — 5-arg (Contractor print)
// The 5-arg form was added because the contractor agreement renders the
// contractor's job title under their name; passing it through a 5th param
// avoids breaking existing callers. When called with 4 args, `title` is
// treated as empty and the remaining args shift into dt/imgSrc.
// When `imgSrc` is empty (wet ink, e-sign envelope, or just unsigned) the
// box renders empty — no "Sign here" placeholder. The bordered box itself
// is sufficient signal for a wet signature, and avoids placeholder text
// muddying the printed page.
function sigBlock(label, pName, title, dt, imgSrc) {
  if (arguments.length === 4) { imgSrc = dt; dt = title; title = ''; }
  var sigHtml = imgSrc
    ? '<img src="'+imgSrc+'" style="max-height:55px;max-width:100%;object-fit:contain;"/>'
    : '';
  var titleRow = title
    ? '<div style="font-size:9px;color:var(--muted);font-style:italic;margin-top:2px;">'+title+'</div>'
    : '';
  return '<div class="print-sec">'
    +'<div style="font-size:8.5px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:var(--muted);margin-bottom:5px;padding-bottom:3px;border-bottom:1px solid var(--border);">'+label+'</div>'
    +'<div style="display:grid;grid-template-columns:1fr 90px;gap:8px;margin-bottom:6px;">'
      +'<div><div class="sig-lbl">Full Name</div>'
        +'<div style="font-size:10.5px;font-weight:600;border-bottom:1px solid var(--border);padding-bottom:2px;min-height:15px;">'+(pName||'')+'</div>'
        +titleRow+'</div>'
      +'<div><div class="sig-lbl">Date</div>'
        +'<div style="font-size:10px;border-bottom:1px solid var(--border);padding-bottom:2px;min-height:15px;">'+(dt||'')+'</div></div>'
    +'</div>'
    +'<div style="width:100%;height:65px;border:1px solid var(--border);border-radius:3px;background:var(--bg);display:flex;align-items:center;justify-content:center;">'+sigHtml+'</div>'
    +'</div>';
}

function _buildContractorAgreementHTML(ct) {
  // Print-window HTML is same-origin — escape every stored contractor field
  // (an injected name/address executed in the popup otherwise).
  var _esc2 = function(v){ return escapeHtml(v == null || v === '' ? '—' : String(v)); };
  var today = new Date().toLocaleDateString('en-CA');
  var logoSrc = (document.querySelector('.app-logo img')||{}).src || '';
  var _natDisp  = (window.NATION_CONFIG && (NATION_CONFIG.display_name || NATION_CONFIG.name)) || '';
  var _natShort = (window.NATION_CONFIG && NATION_CONFIG.short) || '';

  var classLabels = {
    internal_indigenous:     'Internal — Indigenous',
    external_indigenous:     'External — Indigenous',
    external_non_indigenous: 'External — Non-Indigenous'
  };
  var classLabel = classLabels[ct.classification] || '—';



  return '<!DOCTYPE html><html lang="en"><head>'
    +'<meta charset="UTF-8"/>'
    +'<title>Contractor Agreement — '+_natShort+' Housing</title>'
    +'<style>'
    +_printThemeStyles()
    +'*{box-sizing:border-box;margin:0;padding:0;}'
    +'body{font-family:Georgia,serif;font-size:11px;color:var(--text);background:var(--surface);}'
    +'@page{size:letter portrait;margin:15mm 15mm 18mm 15mm;}'
    +'@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact;}.no-print{display:none!important;}}'
    +'.header{background:var(--dark);color:#fff;padding:14px 20px;display:flex;align-items:center;justify-content:space-between;}'
    +'.org{font-size:13px;font-weight:bold;color:'+window._themeAccentInkHex()+';letter-spacing:.04em;}'
    +'.dept{font-size:10px;color:var(--txt-on-dark);margin-top:2px;}'
    +'.doc-type{font-size:16px;font-weight:bold;color:'+window._themeAccentInkHex()+';letter-spacing:.05em;text-align:right;}'
    +'.doc-date{font-size:9px;color:var(--muted);margin-top:3px;text-align:right;}'
    +'.yellow-bar{background:'+window._themeAccentHex()+';height:4px;}'
    +'.body{padding:18px 0 0;}'
    +'.section{margin-bottom:18px;}'
    +'.section-title{font-size:9px;font-weight:bold;text-transform:uppercase;letter-spacing:.08em;color:#fff;background:var(--dark);padding:5px 10px;}'
    +'.section-body{border:1px solid var(--border);border-top:none;padding:12px 14px;}'
    +'.grid-2{display:grid;grid-template-columns:1fr 1fr;gap:10px 24px;}'
    +'.grid-3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px 18px;}'
    +'.field label{display:block;font-size:8.5px;font-weight:bold;text-transform:uppercase;letter-spacing:.06em;color:#666;margin-bottom:3px;}'
    +'.field span{display:block;font-size:11px;color:var(--text);min-height:14px;border-bottom:1px solid #e0e0e0;padding-bottom:3px;}'
    +'.class-badge{display:inline-block;background:'+window._themeAccentHex()+';color:#000;font-size:9px;font-weight:bold;padding:3px 10px;border-radius:3px;margin-top:4px;}'
    +'table{width:100%;border-collapse:collapse;}'
    +'th{background:var(--dark);color:var(--yellow);padding:6px 10px;text-align:left;font-size:9px;font-weight:bold;text-transform:uppercase;}'
    +'td{padding:6px 10px;font-size:10px;border-bottom:1px solid #eee;}'
    +'.tor-clause{margin-bottom:8px;padding:8px 12px;background:var(--bg);border-left:3px solid '+window._themeAccentHex()+';font-size:9.5px;color:#333;line-height:1.6;}'
    +'.tor-clause strong{display:block;font-size:9px;text-transform:uppercase;letter-spacing:.05em;color:#000;margin-bottom:3px;}'
    +'.sig-grid{display:grid;grid-template-columns:1fr 1fr;gap:28px;margin-top:4px;}'
    +'.footer{margin-top:20px;border-top:3px solid '+window._themeAccentHex()+';padding-top:8px;display:flex;justify-content:space-between;}'
    +'.footer span{font-size:8px;color:var(--muted);}'
    +'</style></head><body>'

    /* HEADER */
    +'<div class="header">'
      +'<div style="display:flex;align-items:center;gap:14px;">'
        +(logoSrc ? '<img src="'+logoSrc+'" style="height:48px;width:auto;" alt="'+_natShort+'"/>' : '')
        +'<div><div class="org">'+_natDisp+'</div><div class="dept">Housing Department — Contractor Registry</div></div>'
      +'</div>'
      +'<div><div class="doc-type">CONTRACTOR AGREEMENT</div><div class="doc-date">Generated: '+today+'</div></div>'
    +'</div>'
    +'<div class="yellow-bar"></div>'

    +'<div class="body">'

    /* Company Information */
    +'<div class="section"><div class="section-title">Contractor Information</div>'
    +'<div class="section-body"><div class="grid-3">'
      +'<div class="field"><label>Company / Name</label><span>'+_esc2(ct.name)+'</span></div>'
      +'<div class="field"><label>Trade / Specialty</label><span>'+_esc2(ct.trade)+'</span></div>'
      +'<div class="field"><label>HST / Business #</label><span>'+_esc2(ct.hst)+'</span></div>'
      +'<div class="field"><label>Phone</label><span>'+(ct.phone?formatPhone(ct.phone):'—')+'</span></div>'
      +'<div class="field"><label>Email</label><span>'+_esc2(ct.email)+'</span></div>'
      +'<div class="field"><label>Address</label><span>'+_esc2(ct.address)+'</span></div>'
    +'</div></div></div>'

    /* Classification */
    +'<div class="section"><div class="section-title">Business Classification</div>'
    +'<div class="section-body">'
      +'<div class="field"><label>Classification</label>'
        +'<span class="class-badge">'+classLabel+'</span>'
      +'</div>'
      +(ct.classProof ? '<div class="field" style="margin-top:8px;"><label>Proof of Indigenous Ownership</label><span>'+_esc2(ct.classProof)+'</span></div>' : '')
    +'</div></div>'

    /* Compliance */
    +'<div class="section"><div class="section-title">Compliance &amp; Insurance</div>'
    +'<div class="section-body"><div class="grid-3">'
      +'<div class="field"><label>WSIB Account #</label><span>'+_esc2(ct.wsibNum)+'</span></div>'
      +'<div class="field"><label>WSIB Expiry</label><span>'+_esc2(ct.wsibExpiry)+'</span></div>'
      +'<div class="field"></div>'
      +'<div class="field"><label>Insurance Provider</label><span>'+_esc2(ct.insProvider)+'</span></div>'
      +'<div class="field"><label>Policy #</label><span>'+_esc2(ct.insPolicy)+'</span></div>'
      +'<div class="field"><label>Coverage / Expiry</label><span>'+_esc2(ct.insAmount)+' · '+_esc2(ct.insExpiry)+'</span></div>'
    +'</div></div></div>'

    /* Terms of Reference */
    +'<div class="section"><div class="section-title">Terms of Reference</div>'
    +'<div class="section-body">'
      +'<div class="tor-clause"><strong>1. Scope of Engagement</strong>The contractor agrees to perform only the work described in the approved SOW. No work beyond the approved scope may commence without written amendment signed by the Housing Manager or Executive Director.</div>'
      +'<div class="tor-clause"><strong>2. Licensing &amp; Insurance</strong>The contractor warrants that it holds all required trade licences, WSIB clearance, and liability insurance in force for the duration of the work. Expiry of any required coverage automatically suspends the right to work on '+_natShort+' property.</div>'
      +'<div class="tor-clause"><strong>3. Invoicing &amp; Payment</strong>Invoices must reference the SOW number, unit address, and work completed. Payment is subject to satisfactory inspection. Standard payment terms are Net 30 days from invoice approval. Holdback provisions apply per the Construction Act (Ontario).</div>'
      +'<div class="tor-clause"><strong>4. On-Reserve Conduct</strong>The contractor and all workers must conduct themselves respectfully on reserve lands. Alcohol, drugs, and firearms are prohibited on all work sites. All workers must check in with the Housing Department on first arrival.</div>'
      +'<div class="tor-clause"><strong>5. Deficiency &amp; Warranty</strong>The contractor guarantees all labour and materials for a minimum of one (1) year from the date of completion. Deficiencies must be rectified within 30 days at no additional cost to '+_natShort+'.</div>'
      +'<div class="tor-clause"><strong>6. Indigenous Procurement Priority</strong>'+_natShort+' is committed to economic reconciliation. Classification provided is subject to verification. Misrepresentation of Indigenous status may result in termination and removal from the approved contractor list.</div>'
      +'<div class="tor-clause"><strong>7. Termination</strong>'+_natShort+' may terminate with 5 days written notice for convenience, or immediately for cause. The contractor is entitled to payment only for work satisfactorily completed to the date of termination.</div>'
      +(ct.torAgreed ? '<div style="margin-top:10px;padding:6px 12px;background:var(--success-bg);border:1px solid var(--success-border);border-radius:4px;font-size:9px;color:var(--success);font-weight:bold;">✓ Terms agreed by contractor representative — '+( ct.torAgreedAt||today)+'</div>' : '')
    +'</div></div>'

    /* Signatures */
    +'<div class="section"><div class="section-title">Signatures &amp; Acknowledgement</div>'
    +'<div class="section-body">'
      +'<div style="font-size:9.5px;color:var(--text);line-height:1.6;margin-bottom:14px;padding:10px 12px;background:var(--bg);border-left:3px solid var(--yellow);">'
        +'By signing below, the contractor representative confirms that all information provided is accurate and complete, and that they have read and agree to the Terms of Reference above. The '+_natShort+' Housing staff member confirms this registration is authorized.'
      +'</div>'
      +'<div class="sig-grid">'
        +sigBlock(_natShort+' Housing Staff', ct.sigStaff && ct.sigStaff.name, '', ct.sigStaff && ct.sigStaff.date, ct.sigStaff && ct.sigStaff.image)
        +sigBlock('Contractor Representative', ct.sigCt && ct.sigCt.name, ct.sigCt && ct.sigCt.title, ct.sigCt && ct.sigCt.date, ct.sigCt && ct.sigCt.image)
      +'</div>'
    +'</div></div>'

    +'</div>' /* end body */

    +'<div class="footer"><span>'+escapeHtml(buildNationFooterStrip({ suffix: "Contractor Registry", includeConfidential: false }))+'</span><span>Generated '+today+' · CONFIDENTIAL</span></div>'
    +'</body></html>';
}
// Tab names for the CIC modal. Drives the "Save Draft → Submit Contractor"
// gate via _updateCicSaveButtonState — until every tab has been opened the
// Save button writes status='draft' so the contractor doesn't enter the
// HM review queue prematurely. Mirrors _SOW_TAB_NAMES in housing-modals-sow.js.
var _CIC_TAB_NAMES = ['overview','compliance','documents','terms','sigs'];
var _CIC_TAB_TOTAL = _CIC_TAB_NAMES.length;

// Tab switcher for the Contractor Information Card (CIC) modal. Mirrors
// the TIC/SOW pattern (setSowTab in housing-modals-sow.js) but scoped to the
// CIC's container IDs so the modals don't collide. Toggles the .tic-tab
// buttons (#cic_tab_bar) and the .tic-panel[data-cic-panel="..."] bodies via
// .tic-active. Visited tabs get the .visited class so the amber unread-dot
// disappears once a tab has been opened.
function setCicTab(name) {
  if (!window._cicVisitedTabs) window._cicVisitedTabs = new Set();
  window._cicVisitedTabs.add(name);
  // TIC-shell tabs: .tic-tab buttons carry data-cic-tab, .tic-panel bodies
  // carry data-cic-panel; the active tab/panel gets .tic-active (matching
  // setSowTab / _ueSwitchTab). Visited tabs get .visited for the unread dot.
  var bar = document.getElementById('cic_tab_bar');
  if (bar) {
    bar.querySelectorAll('.tic-tab').forEach(function(b){
      var n = b.getAttribute('data-cic-tab');
      b.classList.toggle('tic-active', n === name);
      b.classList.toggle('visited', window._cicVisitedTabs.has(n));
    });
  }
  // Scope panel toggle to the CIC modal so SOW/TIC panels elsewhere in the
  // DOM (which also use .tic-panel) aren't affected.
  var modal = document.getElementById('addContractorModal');
  var scope = modal || document;
  scope.querySelectorAll('.tic-panel[data-cic-panel]').forEach(function(p){
    p.classList.toggle('tic-active', p.getAttribute('data-cic-panel') === name);
  });
  // The Notes tab renders lazily (like the TIC's) so it reflects the latest
  // contractor_notes each time it's opened.
  if (name === 'notes' && typeof cicRenderNotes === 'function') {
    cicRenderNotes(window._ctLastSaved && window._ctLastSaved.id);
  }
  if (typeof _cicRefreshStrip === 'function') _cicRefreshStrip();
  _updateCicSaveButtonState();
}

// Refreshes the 6 info-strip tiles from the current form + saved record.
// Status comes from the saved contractor (contractorStatusBadge); the rest
// mirror whatever is in the Overview/Compliance fields. Called on open and
// on every tab switch.
function _cicRefreshStrip() {
  var get = function(id){ var el = document.getElementById(id); return el ? (el.value || '') : ''; };
  var set = function(id, val, color){
    var el = document.getElementById(id);
    if (!el) return;
    el.textContent = (val === '' || val == null) ? '—' : val;
    el.style.color = color || '';
  };
  var ct = window._ctLastSaved;
  var statusEl = document.getElementById('cic_strip_status');
  if (statusEl) {
    if (ct && typeof contractorStatusBadge === 'function') {
      var ss = contractorStatusBadge(ct.status || 'pending_review') || {c:'', label:(ct.status||'—')};
      statusEl.textContent = ss.label || '—';
      statusEl.style.color = ss.c || '';
    } else {
      statusEl.textContent = 'New — not yet saved';
      statusEl.style.color = '';
    }
  }
  set('cic_strip_trade', get('ct_trade'));
  set('cic_strip_phone', get('ct_phone'));
  set('cic_strip_email', get('ct_email'));
  set('cic_strip_wsib',  get('ct_wsib_expiry'));
  set('cic_strip_ins',   get('ct_ins_expiry'));
}
window._cicRefreshStrip = _cicRefreshStrip;

// ── Contractor Notes tab (append-only log, same UX as unit/tenant notes) ──
function _cicNoteHtml(n){
  var esc  = (typeof escapeHtml === 'function') ? escapeHtml : function(s){ return String(s==null?'':s); };
  var when = '';
  try { if(n.created_at) when = new Date(n.created_at).toLocaleString('en-CA'); } catch(e){ when = n.created_at || ''; }
  return '<div class="tic-note"><div class="tic-note-meta"><span class="tic-note-author">'
       + esc(n.author_name || 'Unknown') + '</span>' + (when ? ' &middot; ' + esc(when) : '') + '</div>'
       + '<div class="tic-note-body">' + esc(n.note_body || '') + '</div></div>';
}
function cicRenderNotes(contractorId){
  var mount = document.getElementById('cic_notes_mount');
  if(!mount) return;
  var esc = (typeof escapeHtml === 'function') ? escapeHtml : function(s){ return String(s==null?'':s); };
  window._cicNotesCtId = contractorId || null;
  // A brand-new contractor has no id yet — notes are keyed by contractor id,
  // so prompt the user to save first (mirrors how unit notes need a saved unit).
  if(!contractorId){
    mount.innerHTML = '<div class="tic-section"><div class="tic-section-h">Notes</div>'
      + '<div class="tic-empty">Save the contractor first to start adding notes.</div></div>';
    return;
  }
  mount.innerHTML =
      '<div class="tic-section"><div class="tic-section-h">Add a Note</div>'
    +   '<textarea id="cic_note_input" class="tic-textarea" placeholder="Type your note…"></textarea>'
    +   '<div class="tic-form-actions" style="margin-top:8px;"><button type="button" class="btn btn-primary" onclick="cicSaveNote()">Add Note</button></div>'
    + '</div>'
    + '<div class="tic-section tic-section-spaced"><div class="tic-section-h">Notes &amp; History</div>'
    +   '<div id="cic_notes_list"><div class="tic-empty">Loading…</div></div>'
    + '</div>';
  // Any legacy single-field ct.notes value is shown read-only so nothing is lost.
  var legacy = (window._ctLastSaved && window._ctLastSaved.notes) ? String(window._ctLastSaved.notes).trim() : '';
  function _render(notes){
    var list = document.getElementById('cic_notes_list');
    if(!list) return;
    var html = '';
    (notes || []).forEach(function(n){ html += _cicNoteHtml(n); });
    if(legacy){
      html += '<div class="tic-note"><div class="tic-note-meta"><span class="tic-note-author">Legacy note</span></div>'
            + '<div class="tic-note-body">' + esc(legacy) + '</div></div>';
    }
    list.innerHTML = html || '<div class="tic-empty">No notes yet.</div>';
  }
  if(typeof sbLoadContractorNotes === 'function'){
    sbLoadContractorNotes(contractorId).then(_render).catch(function(){ _render([]); });
  } else { _render([]); }
}
function cicSaveNote(){
  var inp = document.getElementById('cic_note_input');
  var body = (inp && inp.value || '').trim();
  if(!body){ if(typeof showToast === 'function') showToast('Note cannot be empty.', { type:'error' }); return; }
  var ctId = window._cicNotesCtId || (window._ctLastSaved && window._ctLastSaved.id);
  if(!ctId || typeof sbSaveContractorNote !== 'function') return;
  sbSaveContractorNote(ctId, body).then(function(added){
    if(!added) return;
    var list = document.getElementById('cic_notes_list');
    if(list){
      var empty = list.querySelector('.tic-empty');
      if(empty) list.innerHTML = '';
      list.insertAdjacentHTML('afterbegin', _cicNoteHtml(added));
    }
    if(inp) inp.value = '';
    if(typeof showToast === 'function') showToast('Note added.', {type:'info'});
  });
}
window.cicRenderNotes = cicRenderNotes;
window.cicSaveNote    = cicSaveNote;

// Flips the contractor Save button between three modes:
//   "edit"   → existing contractor being edited; label is "Save Changes",
//              gate is skipped (status preserved as-is)
//   "draft"  → new contractor with at least one tab unvisited; label is
//              "Save Draft", saveContractor forces status='draft' so the
//              record doesn't enter the HM review queue yet
//   "submit" → new contractor with every tab visited; label is "Submit
//              Contractor", saveContractor lets the normal status
//              ('pending_review') take effect
// The footer progress label ("3 of 5 sections reviewed") only renders for
// the new-contractor case — edits don't need it.
function _updateCicSaveButtonState() {
  var btn  = document.getElementById('ct_save_btn');
  var prog = document.getElementById('cic_review_progress');
  if (!btn) return;
  // Re-opened drafts and returned contractors aren't really "edits" — the
  // user is still authoring. They share the gate with brand-new contractors
  // so reviewing all tabs is required to flip into "Submit Contractor"
  // (and out of status=draft into status=pending_review).
  var isEdit = (typeof window._ctEditIdx === 'number') && window._ctEditIdx >= 0;
  var isAuthoring = !isEdit; // new contractor with no row yet
  if (isEdit) {
    var _ctList = window._contractors || [];
    var _ctRow  = _ctList[window._ctEditIdx];
    var _status = (_ctRow && _ctRow.status) || '';
    if (_status === 'draft' || _status === 'returned') isAuthoring = true;
  }
  if (!isAuthoring) {
    btn.dataset.mode = 'edit';
    btn.textContent  = 'Save Changes';
    if (prog) prog.textContent = '';
    return;
  }
  var visited = (window._cicVisitedTabs && window._cicVisitedTabs.size) || 0;
  var allReviewed = visited >= _CIC_TAB_TOTAL;
  btn.dataset.mode = allReviewed ? 'submit' : 'draft';
  btn.textContent  = allReviewed ? '📤 Submit Contractor' : '💾 Save Draft';
  if (prog) prog.textContent = allReviewed ? 'All sections reviewed' : (visited + ' of ' + _CIC_TAB_TOTAL + ' sections reviewed');
}

// prefix lets the same renderer feed two surfaces: the legacy side panel
// (ctap_*) and the new inline CIC section in the edit modal (cic_*). The
// host id is `${prefix}_actions`; action pill clicks pass the prefix
// through to initCtAction so confirm/cancel target the right notes UI.
function _ctRenderActions(ct, prefix) {
  prefix = prefix || 'ctap';
  var el = document.getElementById(prefix + '_actions');
  if(!el) return;
  var role = window.currentRole || 'housing_employee_l1';
  var status = ct.status || 'pending_review';
  var actions = [];

  var canRecommend = APPROVAL_AUTHORITY.can('recommendContractor', role);
  var canApprove   = APPROVAL_AUTHORITY.can('approveContractor', role);   // HM or ED
  if(status === 'pending_review' || status === 'returned') {
    if(canApprove) {
      // Verification is by EITHER the Housing Manager or the ED, in one step —
      // whoever gets to it approves the contractor directly (no separate
      // recommend -> ED stage). Matches "change the verify to either the ED or HM".
      actions.push({label:'✅ Approve Contractor', cls:'btn-primary',      action:'approved',  needsNotes:false});
      actions.push({label:'↩ Return for Info',    cls:'btn-ghost',        action:'returned',  needsNotes:true});
      actions.push({label:'❌ Decline',             cls:'btn-danger-ghost', action:'declined',  needsNotes:true});
    } else if(canRecommend) {
      // A recommender who is NOT an approver (Housing Employee L2) can only move
      // the contractor forward for HM/ED verification.
      actions.push({label:'✅ Recommend for Approval', cls:'btn-primary',      action:'hm_recommended', needsNotes:false});
      actions.push({label:'↩ Return for Info',        cls:'btn-ghost',        action:'returned',       needsNotes:true});
      actions.push({label:'❌ Decline',                 cls:'btn-danger-ghost', action:'declined',       needsNotes:true});
    }
  }
  if(canApprove) {
    // A contractor an L2 recommended is waiting on HM/ED final approval.
    if(status === 'hm_recommended') {
      actions.push({label:'✅ Approve Contractor', cls:'btn-primary',      action:'approved', needsNotes:false});
      actions.push({label:'↩ Return for Info',    cls:'btn-ghost',        action:'returned', needsNotes:true});
      actions.push({label:'❌ Decline',             cls:'btn-danger-ghost', action:'declined', needsNotes:true});
    }
    if(status === 'approved') {
      actions.push({label:'⛔ Revoke Approval', cls:'btn-danger-ghost', action:'declined', needsNotes:true});
    }
  }

  if(!actions.length) {
    el.innerHTML = '<div class="empty-state-ctr">No actions available for your role at this stage.</div>';
    return;
  }
  el.innerHTML = '<div class="action-pills-center">' + actions.map(function(a){
    return '<button class="btn btn-sm ' + a.cls + '" data-act="' + a.action + '" data-notes="' + (a.needsNotes?'1':'0') + '">' + a.label + '</button>';
  }).join('') + '</div>';
  el.querySelectorAll('[data-act]').forEach(function(b){
    b.addEventListener('click',function(){initCtAction(b.getAttribute('data-act'),b.getAttribute('data-notes')==='1',prefix);});
  });
}
// Click handler for a row in the contractor card's Forms & SOWs list.
// If the SOW modal is loaded on the current page (housing/inventory/match/tenants),
// open it directly. Otherwise — most importantly when called from contractors.html —
// hand off to inventory.html with URL params it can pick up on init, and stash a
// return marker so closing the SOW comes back to this same contractor card.
function _ctOpenSowFromList(unitId, projectNumber, ctId) {
  if (typeof openSowModal === 'function') {
    openSowModal(unitId, projectNumber);
    return;
  }
  try {
    sessionStorage.setItem('clfn_sow_return', JSON.stringify({ page: 'contractors', ctId: ctId || '' }));
  } catch (e) { /* sessionStorage not critical */ }
  var url = 'inventory.html?openSow=' + encodeURIComponent(unitId)
          + '&pn='     + encodeURIComponent(projectNumber);
  window.location.href = url;
}

// Returns all SOWs across the entire unit cache that reference this contractor.
// Each entry: { unitId, sow }.
function getAllSowsForContractor(contractorId) {
  var cache = window._sowCache || {};
  var out = [];
  Object.keys(cache).forEach(function(unitId){
    var raw = cache[unitId];
    if (!raw) return;
    var sows = Array.isArray(raw.sows) ? raw.sows : [raw];
    sows.forEach(function(sow){
      if (sow && sow.contractorId === contractorId) {
        out.push({ unitId: unitId, sow: sow });
      }
    });
  });
  return out;
}

// Renders the contractor's Forms & SOWs in the contractor detail card.
// Audit entries themselves continue to be written via auditEntry() and shown
// on the master Audit Log (Settings → Audit Log) — they no longer surface here.
function _ctRenderFormsSows(ctId, prefix) {
  prefix = prefix || 'ctap';
  var el = document.getElementById(prefix + '_forms_sows');
  if (!el) return;
  var rows = getAllSowsForContractor(ctId);
  if (!rows.length) {
    el.innerHTML = '<div class="empty-state-italic">No forms or maintenance requests filed for this contractor yet.</div>';
    return;
  }
  // Sort newest first by created_at
  rows.sort(function(a, b){ return (b.sow.created_at || '').localeCompare(a.sow.created_at || ''); });

  var fmtMoney = formatCurrency; // canonical $1,234.56

  el.innerHTML = '<div class="ct-sow-list">' + rows.map(function(r){
    var s = r.sow;
    var addr = s.address || '—';
    var pn   = s.project_number || '—';
    var stat = sowStatusBadge(s, {variant:'contractor_list'}).label;
    var date = s.created_at || s.date || '—';
    var amt  = fmtMoney(s.amount || s.totalCost);
    var uid  = String(r.unitId).replace(/'/g, "\\'");
    var pnEsc = String(pn).replace(/'/g, "\\'");
    var ctIdEsc = String(ctId || '').replace(/'/g, "\\'");
    return '<div class="ct-sow-row" onclick="_ctOpenSowFromList(\'' + uid + '\', \'' + pnEsc + '\', \'' + ctIdEsc + '\')">'
      + '<div class="ct-sow-row-main">'
        + '<div class="ct-sow-row-pn">' + pn + '</div>'
        + '<div class="ct-sow-row-addr">' + addr + '</div>'
      + '</div>'
      + '<div class="ct-sow-row-meta">'
        + '<span class="ct-sow-status">' + stat + '</span>'
        + '<span class="ct-sow-date">' + date + '</span>'
        + '<span class="ct-sow-amt">' + amt + '</span>'
      + '</div>'
      + '</div>';
  }).join('') + '</div>';
}
function _ctRenderFlow(status, ct, prefix) {
  prefix = prefix || 'ctap';
  var flow = document.getElementById(prefix + '_flow');
  if(!flow) return;

  var steps = [
    {key:'pending_review', label:'Employee\nSubmits',   icon:'👤'},
    {key:'hm_recommended', label:'HM\nVerifies',        icon:'🏠'},
    // Final approval is HM-or-ED (approveContractor authority) — not ED-only.
    {key:'approved',       label:'Final\nApproval',      icon:'✅'}
  ];

  var order = ['pending_review','hm_recommended','approved'];
  var declined = status==='declined';
  var returned = status==='returned';
  var currentIdx = order.indexOf(status);
  if(declined||returned) currentIdx = order.indexOf(declined?'pending_review':'pending_review')-1;

  var hmAt = ct.hmActionAt ? ct.hmActionAt.slice(0,10) : '';
  var edAt = ct.edActionAt ? ct.edActionAt.slice(0,10) : '';

  flow.innerHTML = steps.map(function(step, i){
    var done = i < currentIdx || (i===2 && status==='approved');
    var active = i === currentIdx && !declined && !returned;
    var bg = done?'var(--success)':active?'var(--yellow)':'var(--border)';
    var col = done?'#fff':active?'#111':'var(--gray)';
    var note = i===1&&hmAt?hmAt:i===2&&edAt?edAt:'';
    return '<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;position:relative;">'
      +(i>0?'<div style="position:absolute;left:-50%;top:18px;width:100%;height:2px;background:'+(done?'var(--success)':'var(--border)')+'"></div>':'')
      +'<div style="width:36px;height:36px;border-radius:50%;background:'+bg+';display:flex;align-items:center;justify-content:center;font-size:14px;z-index:1;">'+step.icon+'</div>'
      +'<div style="font-size:9px;font-weight:700;text-align:center;color:'+(done||active?'var(--text)':'var(--muted)')+';white-space:pre-line;line-height:1.3;">'+step.label+'</div>'
      +(note?'<div style="font-size:9px;color:var(--muted);">'+note+'</div>':'')
      +'</div>';
  }).join('');

  if(declined) {
    flow.innerHTML += '<div style="margin-left:12px;padding:4px 10px;background:var(--danger-bg);border-radius:6px;font-size:10px;font-weight:700;color:var(--danger);">Declined'+(ct.declinedAt?' '+ct.declinedAt.slice(0,10):'')+'</div>';
  } else if(returned) {
    flow.innerHTML += '<div style="margin-left:12px;padding:4px 10px;background:var(--info-blue-bg);border-radius:6px;font-size:10px;font-weight:700;color:var(--info-blue);">Returned'+(ct.returnedAt?' '+ct.returnedAt.slice(0,10):'')+'</div>';
  }
}
// Inline Export dropdown toggle — pair with .export-dropdown markup
// (see shared.css). Pass `this` from the button onclick. Closes on
// outside-click and auto-closes any other open inline dropdowns.
function toggleExportMenu(btnEl) {
  var wrap = btnEl && btnEl.closest ? btnEl.closest('.export-dropdown') : null;
  if (!wrap) return;
  document.querySelectorAll('.export-dropdown.open').forEach(function(w) {
    if (w !== wrap) w.classList.remove('open');
  });
  var isOpen = wrap.classList.toggle('open');
  if (isOpen) {
    setTimeout(function() {
      document.addEventListener('click', _exportMenuOutsideClick, { once: true });
    }, 0);
  }
}
function _exportMenuOutsideClick(ev) {
  document.querySelectorAll('.export-dropdown.open').forEach(function(wrap) {
    if (!wrap.contains(ev.target)) wrap.classList.remove('open');
  });
}

function _doExport(format, headers, data, filename, colWidths, pdfLandscape) {
  if(format==='csv') {
    var csv = [headers].concat(data).map(function(r){
      return r.map(function(v){ return '"'+(String(v||'').replace(/"/g,'""'))+'"'; }).join(',');
    }).join('\r\n');
    var blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a'); a.href=url; a.download=filename+'.csv'; a.click();
    URL.revokeObjectURL(url);
    showToast('CSV exported — '+data.length+' rows', {type:'info'});

  } else if(format==='excel') {
    var loadXLSX = function(cb){
      if(window.XLSX){ cb(); return; }
      var s=document.createElement('script');
      s.src='https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
      s.onload=cb; s.onerror=function(){showToast('Could not load Excel library.', {type:'error'});};
      document.head.appendChild(s);
    };
    loadXLSX(function(){
      var wb = XLSX.utils.book_new();
      var ws = XLSX.utils.aoa_to_sheet([headers].concat(data));
      ws['!cols'] = (colWidths||headers.map(function(){return 16;})).map(function(w){return{wch:w};});
      XLSX.utils.book_append_sheet(wb, ws, 'Data');
      XLSX.writeFile(wb, filename+'.xlsx');
      showToast('Excel exported — '+data.length+' rows', {type:'info'});
    });

  } else if(format==='pdf') {
    var loadjsPDF = function(cb){
      // Delegates to the shared lazy-loader in shared.js (single implementation;
      // also fixes the old copy skipping autotable when jsPDF was already loaded).
      window.loadJsPdf({ autotable: true }).then(function(){ cb(); }, function(){
        showToast('Could not load PDF library.', {type:'error'});
      });
    };
    loadjsPDF(function(){
      var doc = new window.jspdf.jsPDF({orientation: pdfLandscape?'landscape':'portrait', unit:'mm', format:'a4'});
      doc.setFontSize(13); doc.setFont('helvetica','bold');
      var _ncShort = nationShort();
      doc.text(_ncShort+' — '+filename.replace(/^[A-Za-z]+_/,'').replace(/_/g,' '), 14, 16);
      doc.setFontSize(8); doc.setFont('helvetica','normal');
      doc.text('Exported: '+new Date().toLocaleDateString('en-CA')+'  |  '+data.length+' records', 14, 22);
      var totalWidth = pdfLandscape ? 267 : 180;
      var cellW = colWidths ? colWidths.map(function(w){ return w * totalWidth / colWidths.reduce(function(a,b){return a+b;},0); }) : null;
      var colStyles = {};
      if(cellW) cellW.forEach(function(w,i){ colStyles[i]={cellWidth:w}; });
      doc.autoTable({
        startY:27, head:[headers], body:data, theme:'striped',
        headStyles:{fillColor:[17,17,15],textColor: window._themeAccentHex(),fontSize:8,fontStyle:'bold'},
        bodyStyles:{fontSize:7.5},
        alternateRowStyles:{fillColor:[248,248,246]},
        columnStyles: colStyles,
        margin:{left:14,right:14}
      });
      doc.save(filename+'.pdf');
      showToast('PDF exported — '+data.length+' records', {type:'info'});
    });
  }
}
function _getHmLimit() {
  try { return parseFloat((window._appSettings||{}).hmBudgetLimit)||25000; } catch(e) { return 25000; }
}
// A maintenance request (SOW) needs ED final approval ONLY when its cost
// exceeds the HM budget limit. At or under the limit, HM approval is final and
// the request does not route to the Executive Director. Single source of truth
// for the worklist, the SOW modal, and the renos approvals table.
function sowRequiresEdApproval(sow) {
  if (!sow) return false;
  var cost = (typeof sow.amount === 'number')
    ? sow.amount
    : parseFloat(String(sow.totalCost || '').replace(/[^0-9.\-]/g, '')) || 0;
  return cost > _getHmLimit();
}
window.sowRequiresEdApproval = sowRequiresEdApproval;

// ════════════════════════════════════════════════════════════════════════
// Auto-approve engine — approval steps switched OFF in Settings
// ════════════════════════════════════════════════════════════════════════
// When the ED turns an approval step OFF (Settings > Approval Authority),
// the owning workflow auto-approves instead of routing to a person. Two
// halves: (1) submit-time — each workflow calls APPROVAL_AUTHORITY.chainDisabled
// at its save point and stamps the terminal status (wired in each workflow);
// (2) retroactive — flipping a switch off sweeps the CURRENT queue via
// applyApprovalDisabledSweep(). Auto-approvals are recorded under a System
// actor and carry an `approval_auto` flag so they read as System, not a real
// person's sign-off. "Any step in a chain off => the whole item auto-approves."
var _APPROVAL_SYSTEM_ACTOR = 'System — approval disabled';

// Is a SOW still awaiting a human sign-off given its threshold?
function _sowIsApprovalPending(sow){
  var s = sow.approval_status || '';
  if (s === 'completed' || s === 'ed_approved') return false;
  if (sowRequiresEdApproval(sow)) {
    // over threshold: pending through hm_approved (still needs ED)
    return s === '' || s === 'draft' || s === 'signed' || s === 'submitted' || s === 'hm_approved';
  }
  // under threshold: hm_approved is terminal
  return s === '' || s === 'draft' || s === 'signed' || s === 'submitted';
}

// Count items that WOULD be auto-approved if `gate` were switched off — used
// for the Settings confirm dialog. (gate is not disabled yet at call time.)
function approvalSweepCount(gate){
  var n = 0;
  var apps = window.applications || [];
  if (gate === 'reviewApplication' || gate === 'finalApproveApp') {
    apps.forEach(function(a){
      if (a && !a.archived && a.appType !== 'existing_tenant' && a.appType !== 'commercial'
          && (a.status === 'submitted' || a.status === 'mgr_approved')) n++;
    });
  }
  if (gate === 'reviewFileUpdate' || gate === 'approveFileUpdate') {
    apps.forEach(function(a){
      if (a && !a.archived && a.appType === 'existing_tenant' && a.status === 'file_update') n++;
    });
  }
  if (gate === 'recommendContractor' || gate === 'approveContractor') {
    (window._contractors || []).forEach(function(c){
      if (c && (c.status === 'pending_review' || c.status === 'hm_recommended')) n++;
    });
  }
  if (gate === 'approveSowUnderThreshold' || gate === 'approveSowOverThreshold') {
    var onlyOver = (gate === 'approveSowOverThreshold');
    var cache = window._sowCache || {};
    Object.keys(cache).forEach(function(uid){
      var list = (typeof getUnitSowList === 'function') ? getUnitSowList(uid) : [];
      list.forEach(function(sow){
        if (!sow || sow.archived || sow.cancelled) return;
        if (onlyOver && !sowRequiresEdApproval(sow)) return;
        if (_sowIsApprovalPending(sow)) n++;
      });
    });
  }
  return n;
}

// Retroactively auto-approve every queued item whose approval chain now has a
// disabled step. Idempotent: re-scans all workflows and only touches items
// still pending. Called after a gate is switched off.
function applyApprovalDisabledSweep(gate){
  if (typeof APPROVAL_AUTHORITY === 'undefined') return 0;
  var today = new Date().toISOString().slice(0,10);
  var swept = 0;
  var apps  = window.applications || [];

  // Housing / transfer applications — chain: reviewApplication → finalApproveApp
  if (APPROVAL_AUTHORITY.chainDisabled('application')) {
    apps.forEach(function(a){
      if (!a || a.archived || a.appType === 'existing_tenant' || a.appType === 'commercial') return;
      if (a.status !== 'submitted' && a.status !== 'mgr_approved') return;
      a.status = 'ed_approved'; a.approvalAuto = true;
      a.edApprovedBy = _APPROVAL_SYSTEM_ACTOR; a.edApprovedAt = today;
      if (typeof saveApplicationWithDraftFallback === 'function') saveApplicationWithDraftFallback(a);
      if (typeof auditEntry === 'function') auditEntry(a.id, 'application_auto_approved', 'Auto-approved (ED approval disabled in Settings)', _APPROVAL_SYSTEM_ACTOR);
      swept++;
    });
  }
  // File updates — chain: reviewFileUpdate → approveFileUpdate
  if (APPROVAL_AUTHORITY.chainDisabled('file_update')) {
    apps.forEach(function(a){
      if (!a || a.archived || a.appType !== 'existing_tenant' || a.status !== 'file_update') return;
      a.status = 'hm_approved'; a.approvalAuto = true;
      a.hmApprovedBy = _APPROVAL_SYSTEM_ACTOR; a.hmApprovedAt = today;
      if (typeof saveApplicationWithDraftFallback === 'function') saveApplicationWithDraftFallback(a);
      if (typeof auditEntry === 'function') auditEntry(a.id, 'file_update_auto_approved', 'Auto-approved (file-update approval disabled in Settings)', _APPROVAL_SYSTEM_ACTOR);
      swept++;
    });
  }
  // Contractors — chain: recommendContractor → approveContractor
  if (APPROVAL_AUTHORITY.chainDisabled('contractor')) {
    (window._contractors || []).forEach(function(c){
      if (!c || (c.status !== 'pending_review' && c.status !== 'hm_recommended')) return;
      c.status = 'approved'; c.approvalAuto = true;
      c.edActionAt = today; c.edActionBy = _APPROVAL_SYSTEM_ACTOR;
      if (typeof saveContractorWithDraftFallback === 'function') saveContractorWithDraftFallback(c);
      if (typeof auditEntry === 'function') auditEntry('CT:' + (c.id||'?'), 'contractor_auto_approved', 'Auto-approved (contractor approval disabled in Settings)', _APPROVAL_SYSTEM_ACTOR);
      swept++;
    });
  }
  // SOWs — chain depends on threshold (sow_under / sow_over)
  var cache = window._sowCache || {};
  Object.keys(cache).forEach(function(uid){
    var list = (typeof getUnitSowList === 'function') ? getUnitSowList(uid) : [];
    list.forEach(function(sow){
      // Cancelled requests keep their pre-cancel approval_status, so without
      // this skip the auto-approve sweep would "approve" cancelled MRs (and a
      // later ED reopen would resurrect them pre-approved by "System").
      if (!sow || sow.archived || sow.cancelled || !_sowIsApprovalPending(sow)) return;
      var over  = sowRequiresEdApproval(sow);
      if (!APPROVAL_AUTHORITY.chainDisabled(over ? 'sow_over' : 'sow_under')) return;
      sow.approval_status = over ? 'ed_approved' : 'hm_approved';
      sow.approval_auto = true;
      if (over) { sow.edName = 'System'; sow.edDate = today; }
      else      { sow.hmName = 'System'; sow.hmDate = today; }
      if (typeof upsertSowInList === 'function') upsertSowInList(uid, sow);
      if (typeof auditEntry === 'function') auditEntry('SOW:' + uid, 'sow_auto_approved', 'Maintenance request ' + (sow.project_number||'') + ' auto-approved (approval disabled in Settings)', _APPROVAL_SYSTEM_ACTOR);
      swept++;
    });
  });

  // Inspections — chain: approveInspection. Data may not be loaded on this
  // page (the toggle lives on housing.html), so sweep straight over REST.
  if (APPROVAL_AUTHORITY.chainDisabled('inspection')) {
    _sweepInspectionsViaRest(); // async, detached — self-toasts its own count
  }

  if (swept && typeof showToast === 'function') showToast('✓ ' + swept + ' item(s) auto-approved', {type:'info'});
  // Refresh any open surfaces that show queues.
  if (typeof renderWorklist === 'function') renderWorklist();
  if (typeof renderDashTable === 'function') try { renderDashTable(); } catch(e){}
  return swept;
}

// Approve every completed-but-unsigned inspection over REST (used by the
// sweep, since inspection records / _inspSave aren't loaded on housing.html).
// Pending = a real result (pass/fail/needs_repair) with no approved_by yet.
async function _sweepInspectionsViaRest(){
  if (typeof SUPABASE_URL === 'undefined' || typeof HOUSING_HEADERS === 'undefined') return 0;
  try {
    var listUrl = SUPABASE_URL + '/rest/v1/inspections'
      + '?approved_by=is.null&overall_status=in.(pass,fail,needs_repair)&select=id';
    var lr = await fetch(listUrl, { headers: HOUSING_HEADERS });
    if (!lr.ok) return 0;
    var rows = await lr.json();
    if (!rows || !rows.length) return 0;
    var when = new Date().toISOString();
    var n = 0;
    for (var i = 0; i < rows.length; i++) {
      var pr = await fetch(SUPABASE_URL + '/rest/v1/inspections?id=eq.' + encodeURIComponent(rows[i].id), {
        method:  'PATCH',
        headers: Object.assign({}, HOUSING_HEADERS, { 'Prefer': 'return=minimal' }),
        body:    JSON.stringify({ approved_by: _APPROVAL_SYSTEM_ACTOR, approved_at: when })
      });
      if (pr.ok) {
        n++;
        if (typeof auditEntry === 'function') auditEntry(rows[i].id, 'inspection_auto_approved', 'Inspection auto-approved (approval disabled in Settings)', _APPROVAL_SYSTEM_ACTOR);
      }
    }
    // Reflect into the in-memory cache if this page has one loaded.
    (window._inspections || []).forEach(function(ins){
      if (ins && !ins.approved_by && ['pass','fail','needs_repair'].indexOf(ins.overall_status) !== -1) {
        ins.approved_by = _APPROVAL_SYSTEM_ACTOR; ins.approved_at = when;
      }
    });
    if (n && typeof showToast === 'function') showToast('✓ ' + n + ' inspection report(s) auto-approved', {type:'info'});
    if (typeof renderInspectionsList === 'function') try { renderInspectionsList(); } catch(e){}
    return n;
  } catch(e) { console.warn('[approval sweep] inspections:', e); return 0; }
}

window.approvalSweepCount = approvalSweepCount;
window.applyApprovalDisabledSweep = applyApprovalDisabledSweep;

// ════════════════════════════════════════════════════════════════════════════
// Tenant maintenance submissions — staff review queue (scan-to-report Phase B)
// ════════════════════════════════════════════════════════════════════════════
// External tenants submit via the tenant-mr Edge Function into the isolated
// tenant_mr_submissions staging table. Staff (management) load the `new` ones,
// review, and either approve (seeds + opens a real maintenance request for the
// unit) or reject. RLS lets active staff read/update this table.
async function sbLoadTenantMrSubmissions(){
  try {
    var url = SUPABASE_URL + '/rest/v1/tenant_mr_submissions?status=eq.new&order=created_at.desc&limit=200';
    var r = await fetch(url, { headers: HOUSING_HEADERS });
    if(!r.ok){ window._tenantMrSubmissions = window._tenantMrSubmissions || []; return window._tenantMrSubmissions; }
    var rows = await r.json();
    window._tenantMrSubmissions = Array.isArray(rows) ? rows : [];
    return window._tenantMrSubmissions;
  } catch(e){
    console.warn('[tenant-mr] load failed:', e);
    window._tenantMrSubmissions = window._tenantMrSubmissions || [];
    return window._tenantMrSubmissions;
  }
}
window.sbLoadTenantMrSubmissions = sbLoadTenantMrSubmissions;

async function sbResolveTenantMr(id, status, notes, sowPn){
  var actor = (window.HOUSING_SESSION && HOUSING_SESSION.email) || window.currentRole || '';
  var body = { status: status, reviewed_by: actor, reviewed_at: new Date().toISOString() };
  if(notes)  body.review_notes = String(notes).slice(0, 1000);
  if(sowPn)  body.sow_project_number = sowPn;
  var r = await fetch(SUPABASE_URL + '/rest/v1/tenant_mr_submissions?id=eq.' + encodeURIComponent(id), {
    method: 'PATCH', headers: Object.assign({}, HOUSING_HEADERS, { 'Prefer': 'return=minimal' }), body: JSON.stringify(body)
  });
  if(!r.ok) throw new Error(await r.text());
  window._tenantMrSubmissions = (window._tenantMrSubmissions || []).filter(function(s){ return s.id !== id; });
  return true;
}
window.sbResolveTenantMr = sbResolveTenantMr;

// Parse the photo_path column (JSON array of Storage paths; tolerates a bare
// single path string from any older row) into an array of paths.
function _tenantMrPhotoPaths(s){
  if(!s || !s.photo_path) return [];
  try { var p = JSON.parse(s.photo_path); return Array.isArray(p) ? p : (p ? [String(p)] : []); }
  catch(_e){ return [String(s.photo_path)]; }
}
window._tenantMrPhotoPaths = _tenantMrPhotoPaths;

// Fill the review modal's photo strip with signed URLs (bucket is private).
async function _tenantMrRenderPhotos(paths){
  var wrap = document.getElementById('tenant_mr_photos');
  if(!wrap) return;
  for(var i=0;i<paths.length;i++){
    try {
      var url = (typeof sbGetSignedUrl === 'function') ? await sbGetSignedUrl(paths[i]) : '';
      var a = document.getElementById('tenant_mr_ph_' + i);
      if(a && url){ a.href = url; var img = a.querySelector('img'); if(img) img.src = url; }
    } catch(_e){}
  }
}
window._tenantMrRenderPhotos = _tenantMrRenderPhotos;

// Review modal for a single tenant-reported request.
function openTenantMrReview(id){
  var s = (window._tenantMrSubmissions || []).find(function(x){ return x.id === id; });
  if(!s){ if(typeof showToast === 'function') showToast('Request not found', {type:'error'}); return; }
  var e = function(t){ return String(t==null?'':t).replace(/[&<>"']/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); };
  var photoPaths = _tenantMrPhotoPaths(s);
  var photosHtml = photoPaths.length
    ? '<div class="tic-field-lbl">Photos (' + photoPaths.length + ')</div>'
      + '<div id="tenant_mr_photos" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;">'
      +   photoPaths.map(function(_p, i){ return '<a id="tenant_mr_ph_' + i + '" href="#" target="_blank" rel="noopener" '
          + 'style="display:block;width:84px;height:84px;border-radius:8px;overflow:hidden;border:1px solid var(--border);background:var(--bg);">'
          + '<img alt="Tenant photo" style="width:100%;height:100%;object-fit:cover;display:block;"/></a>'; }).join('')
      + '</div>'
    : '';
  var when = s.created_at ? new Date(s.created_at).toLocaleString() : '';
  var urg = (s.urgency || 'routine');
  var urgColor = urg === 'emergency' ? 'var(--danger)' : (urg === 'urgent' ? 'var(--warn-amber-text)' : 'var(--muted)');
  var ex = document.getElementById('tenant_mr_modal'); if(ex) ex.remove();
  var m = document.createElement('div');
  m.id = 'tenant_mr_modal';
  m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.72);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px;';
  m.innerHTML =
      '<div style="background:var(--surface);border-radius:12px;width:100%;max-width:560px;max-height:92vh;display:flex;flex-direction:column;box-shadow:0 8px 40px rgba(0,0,0,.35);">'
    + '<div class="modal-hdr"><div><div class="lbl-yellow">&#128238; Tenant Maintenance Request</div>'
    +   '<div class="txt-sm-meta">' + e(s.unit_address || s.unit_id) + (when ? ' &middot; ' + e(when) : '') + '</div></div>'
    +   '<button type="button" onclick="var x=document.getElementById(\'tenant_mr_modal\');if(x)x.remove();" style="background:none;border:none;font-size:22px;cursor:pointer;color:var(--muted);">&times;</button></div>'
    + '<div style="overflow-y:auto;padding:18px 22px;flex:1;">'
    +   '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px;">'
    +     '<span style="font-size:12px;font-weight:700;background:var(--bg);border:1px solid var(--border);border-radius:999px;padding:5px 12px;">' + e(s.category || 'Uncategorized') + '</span>'
    +     '<span style="font-size:12px;font-weight:800;border-radius:999px;padding:5px 12px;border:1px solid ' + urgColor + ';color:' + urgColor + ';">' + e(urg.toUpperCase()) + '</span>'
    +   '</div>'
    +   '<div class="tic-field-lbl">Reported problem</div>'
    +   '<div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:11px 13px;font-size:14px;white-space:pre-wrap;margin-bottom:14px;">' + e(s.description || '') + '</div>'
    +   photosHtml
    +   (s.contact_name || s.contact_phone || s.contact_email ? '<div class="tic-field-lbl">Contact</div><div style="font-size:13px;margin-bottom:14px;">' + e([s.contact_name, s.contact_phone, s.contact_email].filter(Boolean).join(' · ')) + '</div>' : '')
    +   '<div class="tic-field-lbl">Review note (optional)</div>'
    +   '<textarea id="tenant_mr_note" rows="2" placeholder="Shown to the MEMBER on their portal, and on the audit trail — write it for the tenant to read" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px;font-family:DM Sans,sans-serif;background:var(--surface);color:var(--text);box-sizing:border-box;resize:vertical;"></textarea>'
    + '</div>'
    + '<div style="padding:14px 22px;border-top:1px solid var(--border);display:flex;justify-content:space-between;gap:10px;flex-shrink:0;">'
    +   '<button type="button" onclick="_tenantMrReject(\'' + e(s.id) + '\')" class="btn btn-ghost" style="color:var(--danger);border-color:var(--danger);">Reject</button>'
    +   '<button type="button" onclick="_tenantMrApprove(\'' + e(s.id) + '\')" class="btn btn-primary">&#10003; Approve &amp; create request</button>'
    + '</div></div>';
  document.body.appendChild(m);
  if(photoPaths.length) _tenantMrRenderPhotos(photoPaths);
}
window.openTenantMrReview = openTenantMrReview;

function _tenantMrApprove(id){
  var s = (window._tenantMrSubmissions || []).find(function(x){ return x.id === id; });
  if(!s) return;
  var note = (document.getElementById('tenant_mr_note') || {}).value || '';
  var actor = (window.HOUSING_SESSION && HOUSING_SESSION.email) || window.currentRole || '';
  var photoPaths = _tenantMrPhotoPaths(s);
  sbResolveTenantMr(id, 'approved', note).then(function(){
    if(typeof showToast === 'function') showToast('✓ Approved — creating maintenance request', {type:'info'});
    var x = document.getElementById('tenant_mr_modal'); if(x) x.remove();
    if(typeof auditEntry === 'function') auditEntry('UNIT:' + s.unit_id, 'tenant_mr_approved', 'Tenant maintenance request approved — ' + (s.category || '') + ': ' + String(s.description || '').slice(0, 140), actor);
    // Carry the tenant photos onto the unit's Documents tab (they already live
    // in Storage under tenants/<unitId>/...; a file-meta row surfaces them).
    _tenantMrFilePhotos(s.unit_id, photoPaths);
    if(typeof renderWorklist === 'function') renderWorklist();
    // Seed a fresh maintenance request with the tenant's report, then open it so
    // staff can categorize / cost / assign before submitting.
    window._sowForceNew = true;
    window._sowSeed = {
      items: [{ category: '', description: '[' + (s.category || 'Tenant report') + '] ' + (s.description || '') }],
      notes: 'Tenant-reported via QR maintenance form.'
        + (s.contact_name || s.contact_phone || s.contact_email ? '\nContact: ' + [s.contact_name, s.contact_phone, s.contact_email].filter(Boolean).join(' · ') : '')
        + '\nReported urgency: ' + (s.urgency || 'routine')
        + (photoPaths.length ? '\n' + photoPaths.length + ' tenant photo(s) filed on the unit Documents tab.' : '')
    };
    if(typeof openSowModal === 'function') openSowModal(s.unit_id);
    else { if(typeof setNavReferrer === 'function') setNavReferrer('home'); window.location.href = 'renos.html?unit=' + encodeURIComponent(s.unit_id); }
  }).catch(function(err){ console.warn('[tenant-mr] approve failed:', err); if(typeof showToast === 'function') showToast('Approve failed — please retry', {type:'error'}); });
}
window._tenantMrApprove = _tenantMrApprove;

// Write a housing_audit_log `file_uploaded` row for each already-stored tenant
// photo so the unit's DocLibrary (entity 'tenant', prefix tenants/<unitId>)
// picks them up. Fire-and-forget; a failure never blocks approval.
function _tenantMrFilePhotos(unitId, paths){
  if(!unitId || !paths || !paths.length) return;
  var actorEmail = (window.HOUSING_SESSION && HOUSING_SESSION.email) || window.currentRole || 'staff';
  var actorName  = (window.HOUSING_SESSION && HOUSING_SESSION.name) || '';
  paths.forEach(function(path, i){
    try {
      fetch(SUPABASE_URL + '/rest/v1/housing_audit_log', {
        method: 'POST',
        headers: Object.assign({}, HOUSING_HEADERS, { 'Prefer': 'return=minimal' }),
        body: JSON.stringify({
          entity_type: 'tenant',
          entity_id: String(unitId),
          action: 'file_uploaded',
          detail: JSON.stringify({ path: path, name: 'Tenant photo ' + (i + 1) + '.jpg', type: 'image/jpeg',
            category: 'image', actor_name: actorName, source: 'tenant_mr' }),
          actor: actorEmail,
          created_at: new Date().toISOString()
        })
      }).catch(function(){});
    } catch(_e){}
  });
}
window._tenantMrFilePhotos = _tenantMrFilePhotos;

function _tenantMrReject(id){
  var s = (window._tenantMrSubmissions || []).find(function(x){ return x.id === id; });
  var note = (document.getElementById('tenant_mr_note') || {}).value || '';
  sbResolveTenantMr(id, 'rejected', note).then(function(){
    if(typeof showToast === 'function') showToast('Request rejected', {type:'info'});
    var x = document.getElementById('tenant_mr_modal'); if(x) x.remove();
    if(s && typeof auditEntry === 'function') auditEntry('UNIT:' + s.unit_id, 'tenant_mr_rejected', 'Tenant maintenance request rejected' + (note ? ' — ' + note : ''), (window.HOUSING_SESSION && HOUSING_SESSION.email) || window.currentRole || '');
    if(typeof renderWorklist === 'function') renderWorklist();
  }).catch(function(err){ console.warn('[tenant-mr] reject failed:', err); if(typeof showToast === 'function') showToast('Reject failed — please retry', {type:'error'}); });
}
window._tenantMrReject = _tenantMrReject;

// ══ Application submissions (applicant portal → staff verify → real app) ══════
// Applicants submit through the apply.html portal into the quarantine table
// application_submissions. Management reviews each and, on approval, creates the
// real housing_applications record (via the existing save path) + links it to
// the applicant's account. Mirrors the tenant-MR review flow above.
async function sbLoadApplicationSubmissions(){
  try {
    var url = SUPABASE_URL + '/rest/v1/application_submissions'
      + '?status=in.(submitted,in_review,changes_requested)&order=submitted_at.desc.nullslast,created_at.desc&limit=300';
    var r = await fetch(url, { headers: HOUSING_HEADERS });
    if(!r.ok){ window._appSubmissions = window._appSubmissions || []; return window._appSubmissions; }
    var rows = await r.json();
    window._appSubmissions = Array.isArray(rows) ? rows : [];
    return window._appSubmissions;
  } catch(e){
    console.warn('[app-sub] load failed:', e);
    window._appSubmissions = window._appSubmissions || [];
    return window._appSubmissions;
  }
}
window.sbLoadApplicationSubmissions = sbLoadApplicationSubmissions;

async function _appSubNextAppId(){
  try {
    var r = await fetch(SUPABASE_URL + '/rest/v1/rpc/next_housing_app_id', {
      method:'POST', headers: Object.assign({}, HOUSING_HEADERS, { 'Content-Type':'application/json' }), body:'{}'
    });
    if(r.ok){ var v = await r.json(); if(typeof v === 'string' && v) return v; }
  } catch(e){ console.warn('[app-sub] id RPC failed, falling back:', e); }
  if(typeof generateAppId === 'function') return generateAppId();
  return 'APP-' + String(Date.now()).slice(-6);
}

async function _appSubResolve(id, status, notes, createdAppId){
  var actor = (window.HOUSING_SESSION && HOUSING_SESSION.email) || window.currentRole || '';
  var body = { status: status, reviewed_by: actor, reviewed_at: new Date().toISOString() };
  if(notes)        body.review_notes = String(notes).slice(0, 1000);
  if(createdAppId) body.created_app_id = createdAppId;
  var r = await fetch(SUPABASE_URL + '/rest/v1/application_submissions?id=eq.' + encodeURIComponent(id), {
    method:'PATCH', headers: Object.assign({}, HOUSING_HEADERS, { 'Prefer':'return=minimal' }), body: JSON.stringify(body)
  });
  if(!r.ok) throw new Error(await r.text());
  window._appSubmissions = (window._appSubmissions || []).filter(function(s){ return s.id !== id; });
  return true;
}

// Append the created app id to the applicant's profile so their portal switches
// from "start new" to "update / transfer" and can see the linked application.
async function _appSubLinkProfile(uid, appId){
  if(!uid || !appId) return;
  try {
    var r = await fetch(SUPABASE_URL + '/rest/v1/applicant_profiles?uid=eq.' + encodeURIComponent(uid) + '&select=linked_app_ids', { headers: HOUSING_HEADERS });
    var arr = [];
    if(r.ok){ var rows = await r.json(); arr = (rows[0] && rows[0].linked_app_ids) || []; }
    if(arr.indexOf(appId) === -1) arr.push(appId);
    await fetch(SUPABASE_URL + '/rest/v1/applicant_profiles?uid=eq.' + encodeURIComponent(uid), {
      method:'PATCH', headers: Object.assign({}, HOUSING_HEADERS, { 'Prefer':'return=minimal' }),
      body: JSON.stringify({ linked_app_ids: arr, updated_at: new Date().toISOString() })
    });
  } catch(e){ console.warn('[app-sub] link profile failed:', e); }
}

// Arrears warning for the submission review modal: a person record with this
// exact name carrying a balance (e.g. minted by the A/R import for a FORMER
// tenancy) is matched by name — the same rule the good-standing allocation
// gate applies later — so staff see the debt at APPROVAL time, not first at
// unit assignment. Best-effort: silent when the arrears cache isn't loaded.
function _appSubArrearsWarn(p, esc){
  try {
    if (typeof arrearsTenantByName !== 'function' || !window._arrearsCache || !_arrearsCache.loaded) return '';
    var fullName = [p.fn, p.ln].filter(Boolean).join(' ');
    var t = arrearsTenantByName(fullName);
    var st = (t && typeof arrearsStateForTenant === 'function') ? arrearsStateForTenant(t.id) : null;
    if (st && st.balance > 0) {
      return '<div style="margin-top:12px;font-size:13px;border:1px solid var(--danger);border-left:3px solid var(--danger);border-radius:6px;padding:8px 10px;">'
        + '<b>⚠ Arrears on file:</b> ' + esc('$' + st.balance.toFixed(2)) + ' owed by a person record with this exact name'
        + (st.hasApproved
            ? ' (approved repayment arrangement in place).'
            : ' — no approved repayment arrangement. Approving adds them to the wait list as usual, but the good-standing gate will block unit assignment until an arrangement is approved.')
        + '</div>';
    }
    // No exact match — check joint ("&") accounts containing this person's
    // name. Warning-only: token matching is not conclusive identification.
    if (typeof arrearsJointMatches === 'function') {
      var jm = arrearsJointMatches(fullName);
      if (jm.length) {
        return '<div style="margin-top:12px;font-size:13px;border:1px solid var(--warn-amber-text);border-left:3px solid var(--warn-amber-text);border-radius:6px;padding:8px 10px;">'
          + '<b>⚠ Possible joint account:</b> ' + jm.map(function(x){
              return '"' + esc(x.tenant.full_name) + '" owes ' + esc('$' + x.balance.toFixed(2));
            }).join(' · ')
          + '. This applicant\'s name appears in the joint account name — verify whether they are a party to that debt before approving. (Name-token match only; the good-standing gate does not block on joint accounts.)'
          + '</div>';
      }
    }
    return '';
  } catch(_ae){ return ''; }
}

var _APPSUB_TYPE_LABEL = { new:'New application', update:'Application update', transfer:'Transfer request' };

function openApplicationSubmissionReview(id){
  var s = (window._appSubmissions || []).find(function(x){ return x.id === id; });
  if(!s){ if(typeof showToast === 'function') showToast('Submission not found', {type:'error'}); return; }
  var e = function(t){ return String(t==null?'':t).replace(/[&<>"']/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); };
  var p = s.payload || {};
  var when = s.submitted_at ? new Date(s.submitted_at).toLocaleString() : (s.created_at ? new Date(s.created_at).toLocaleString() : '');
  var row = function(l, v){ return v ? '<div style="font-size:13px;margin:3px 0;"><span style="color:var(--muted);">' + e(l) + ':</span> ' + e(v) + '</div>' : ''; };
  var listBlock = function(title, arr, fmt){
    if(!arr || !arr.length) return '';
    return '<div style="margin-top:10px;"><div class="tic-field-lbl">' + e(title) + ' (' + arr.length + ')</div>'
      + arr.map(function(it){ return '<div style="font-size:12px;color:var(--text);padding:4px 0;border-bottom:1px solid var(--border);">' + e(fmt(it)) + '</div>'; }).join('') + '</div>';
  };
  var addr = [p.street, p.city, p.province, p.postal].filter(Boolean).join(', ');
  var flags = [p.homeless ? 'Homeless / no fixed address' : '', p.haveHouse ? 'Has house on reserve' : ''].filter(Boolean).join(' · ');
  var co = p.hasCoApp && p.coApp ? [p.coApp.fn, p.coApp.ln].filter(Boolean).join(' ') : '';

  // Candidate existing applications to merge into (email exact, or name+DOB) —
  // for update/transfer submissions, and as a duplicate warning for new ones.
  var pEmail = String(p.email || '').toLowerCase();
  var cands = (window.applications || []).filter(function(a){
    if(!a || a.archived || a.appType === 'commercial') return false;
    var em = String(a.email || '').toLowerCase();
    if(pEmail && em && em === pEmail) return true;
    if(p.fn && p.ln && String(a.fn||'').toLowerCase() === String(p.fn).toLowerCase() && String(a.ln||'').toLowerCase() === String(p.ln).toLowerCase()){
      if(!p.dob || !a.dob || a.dob === p.dob) return true;
    }
    return false;
  }).slice(0, 6);
  var isUpdateType = (s.submission_type === 'update' || s.submission_type === 'transfer');
  var preselect = (isUpdateType && cands.length) ? cands[0].id : '';
  var candChips = cands.map(function(a){
    var nm = ((a.fn||'') + ' ' + (a.ln||'')).trim();
    return '<button type="button" onclick="_appSubPickLink(\'' + e(a.id) + '\')" class="btn btn-ghost" style="font-size:12px;padding:3px 9px;margin:2px 4px 2px 0;">' + e(a.id) + (nm ? ' &middot; ' + e(nm) : '') + '</button>';
  }).join('');
  var linkSection =
      '<div class="tic-field-lbl" style="margin-top:14px;">Link to existing application ' + (isUpdateType ? '<span style="color:var(--warn-amber-text);">(recommended for ' + e(s.submission_type) + ')</span>' : '(optional)') + '</div>'
    + (cands.length
        ? '<div style="font-size:12px;color:var(--muted);margin-bottom:6px;">Possible match' + (cands.length>1?'es':'') + ': ' + candChips + '</div>'
        : '<div style="font-size:12px;color:var(--muted);margin-bottom:6px;">Blank = create a new application. Enter an APP id to merge these changes into it.</div>')
    + '<input id="app_sub_link_id" type="text" placeholder="APP-000123" value="' + e(preselect) + '" oninput="_appSubSyncPrimary()" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px;font-family:DM Sans,sans-serif;background:var(--surface);color:var(--text);box-sizing:border-box;">';

  var docs = (p._docs && p._docs.length) ? p._docs : [];
  var docsHtml = docs.length
    ? '<div class="tic-field-lbl" style="margin-top:12px;">Documents (' + docs.length + ')</div>'
      + '<div style="display:flex;flex-direction:column;gap:5px;">'
      + docs.map(function(d, i){ return '<a id="app_sub_doc_' + i + '" href="#" target="_blank" rel="noopener" style="font-size:13px;color:#0b6bcb;text-decoration:underline;word-break:break-all;">'
          + e(d.name || 'Document') + (d.category ? ' <span style="color:var(--muted);">· ' + e(d.category) + '</span>' : '') + '</a>'; }).join('')
      + '</div>'
    : '';

  var ex = document.getElementById('app_sub_modal'); if(ex) ex.remove();
  var m = document.createElement('div');
  m.id = 'app_sub_modal';
  m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.72);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px;';
  m.innerHTML =
      '<div style="background:var(--surface);border-radius:12px;width:100%;max-width:600px;max-height:92vh;display:flex;flex-direction:column;box-shadow:0 8px 40px rgba(0,0,0,.35);">'
    + '<div class="modal-hdr"><div><div class="lbl-yellow">&#128196; ' + e(_APPSUB_TYPE_LABEL[s.submission_type] || 'Application') + '</div>'
    +   '<div class="txt-sm-meta">' + e(([p.fn, p.ln].filter(Boolean).join(' ')) || 'Applicant') + (when ? ' &middot; ' + e(when) : '') + '</div></div>'
    +   '<button type="button" onclick="var x=document.getElementById(\'app_sub_modal\');if(x)x.remove();" style="background:none;border:none;font-size:22px;cursor:pointer;color:var(--muted);">&times;</button></div>'
    + '<div style="overflow-y:auto;padding:18px 22px;flex:1;">'
    +   row('Name', [p.fn, p.ln].filter(Boolean).join(' '))
    +   row('Date of birth', p.dob) + row('Band / membership #', p.band) + row('Marital', p.marital) + row('Reserve status', p.reserve)
    +   row('Phone', p.phone) + row('Email', p.email) + row('Address', addr) + row('Needed by', p.occDate)
    +   (flags ? row('Flags', flags) : '')
    +   (co ? row('Co-applicant', co + (p.coApp.dob ? ' (' + e(p.coApp.dob) + ')' : '')) : '')
    +   listBlock('Household members', p.habitants, function(h){ return [h.fn, h.ln].filter(Boolean).join(' ') + (h.relationship ? ' — ' + h.relationship : '') + (h.dob ? ' · ' + h.dob : ''); })
    +   listBlock('Income', p.incomes, function(i){ return [i.person, i.incomeType, i.employer, (i.primaryAmt ? '$' + i.primaryAmt + '/mo' : '')].filter(Boolean).join(' · '); })
    +   listBlock('References', p.references, function(r2){ return [r2.fn, r2.ln].filter(Boolean).join(' ') + (r2.phone ? ' · ' + r2.phone : '') + (r2.relationship ? ' · ' + r2.relationship : ''); })
    +   listBlock('Pets', p.pets, function(pt){ return [pt.name, pt.type, pt.size].filter(Boolean).join(' · '); })
    +   ((p.sig && p.sig.typed) ? '<div style="margin-top:10px;">' + row('Signed', p.sig.typed + (p.sig.date ? ' · ' + e(p.sig.date) : '')) + '</div>' : '')
    +   (p.applicantComments
          ? '<div class="tic-field-lbl" style="margin-top:12px;">Applicant comments</div>'
            + '<div style="font-size:13px;white-space:pre-wrap;border:1px solid var(--border);border-left:3px solid var(--warn-amber-text);border-radius:6px;padding:8px 10px;">' + e(p.applicantComments) + '</div>'
          : '')
    +   _appSubArrearsWarn(p, e)
    +   docsHtml
    +   linkSection
    +   '<div class="tic-field-lbl" style="margin-top:14px;">Review note (shown to the applicant if you request changes)</div>'
    +   '<textarea id="app_sub_note" rows="2" placeholder="Optional note for the applicant / record" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px;font-family:DM Sans,sans-serif;background:var(--surface);color:var(--text);box-sizing:border-box;resize:vertical;"></textarea>'
    // Approval email checkbox — only when the applicant has an email and this
    // isn't a file update (a file update joins no wait list). The email's
    // wording is deliberate: approval = added to the WAIT LIST, not a house.
    +   ((p.email && s.submission_type !== 'update')
          ? '<label style="display:flex;align-items:center;gap:8px;font-size:12px;margin-top:10px;cursor:pointer;">'
            + '<input type="checkbox" id="app_sub_email_ok" checked style="width:auto;"/> '
            + 'On approval, email ' + e(p.email) + ': application approved &amp; added to the wait list (states this is not an offer of housing)</label>'
          : '')
    + '</div>'
    + '<div style="padding:14px 22px;border-top:1px solid var(--border);display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;flex-shrink:0;">'
    +   '<div style="display:flex;gap:8px;">'
    +     '<button type="button" onclick="_appSubReject(\'' + e(s.id) + '\')" class="btn btn-ghost" style="color:var(--danger);border-color:var(--danger);">Reject</button>'
    +     '<button type="button" onclick="_appSubRequestChanges(\'' + e(s.id) + '\')" class="btn btn-ghost">Request changes</button>'
    +   '</div>'
    +   '<button type="button" id="app_sub_primary_btn" onclick="_appSubApproveSmart(\'' + e(s.id) + '\')" class="btn btn-primary">&#10003; Approve &amp; create application</button>'
    + '</div></div>';
  document.body.appendChild(m);
  _appSubSyncPrimary();
  if(docs.length) _appSubRenderDocs(docs);
}
window.openApplicationSubmissionReview = openApplicationSubmissionReview;

// Resolve signed URLs for the applicant's uploaded documents (private bucket).
async function _appSubRenderDocs(docs){
  for(var i=0;i<docs.length;i++){
    try {
      var url = (typeof sbGetSignedUrl === 'function' && docs[i].path) ? await sbGetSignedUrl(docs[i].path) : '';
      var a = document.getElementById('app_sub_doc_' + i);
      if(a && url) a.href = url;
    } catch(_e){}
  }
}
window._appSubRenderDocs = _appSubRenderDocs;

// Carry the applicant's uploaded documents into the real application's
// DocLibrary (copy from the intake quarantine to applications/<appId>/ and
// write a file_uploaded meta row so they show on the app's Documents tab).
function _appSubCarryDocs(appId, docs){
  if(!appId || !docs || !docs.length) return;
  docs.forEach(function(d, idx){
    if(!d || !d.path || typeof sbCopyFile !== 'function') return;
    var nm = (d.name || 'document').replace(/[^\w.\-]+/g, '_');
    var dest = 'applications/' + appId + '/' + (new Date().getTime()) + '_' + idx + '_' + nm;
    sbCopyFile(d.path, dest).then(function(){
      if(typeof sbSaveFileMeta === 'function') sbSaveFileMeta('application', appId, dest, d.name || nm, d.size || 0, d.type || 'application/octet-stream');
    }).catch(function(err){ console.warn('[app-sub] doc carry failed:', err); });
  });
}
window._appSubCarryDocs = _appSubCarryDocs;

function _appSubClose(){ var x = document.getElementById('app_sub_modal'); if(x) x.remove(); }

function _appSubApprove(id){
  var s = (window._appSubmissions || []).find(function(x){ return x.id === id; });
  if(!s) return;
  var note = (document.getElementById('app_sub_note') || {}).value || '';
  // Read the checkbox BEFORE the modal is torn down by _appSubClose().
  var emailOk = !!((document.getElementById('app_sub_email_ok') || {}).checked);
  var p = s.payload || {};
  var staffEmail = (window.HOUSING_SESSION && HOUSING_SESSION.email) || '';
  var staffName  = (window.HOUSING_SESSION && HOUSING_SESSION.name) || '';
  // No "Creating…" progress toast: showToast rows are persistent (nothing
  // auto-dismisses), so a progress + result pair leaves two stacked messages
  // for one action. The ✓ result toast below is the only message.
  _appSubNextAppId().then(function(appId){
    var app = Object.assign({}, p, {
      id: appId, status: 'submitted', appType: p.appType || 'new_housing',
      created_by_email: staffEmail, created_by_name: staffName,
      submittedAt: new Date().toISOString(),
      source: 'portal', portal_submission_id: s.id, applicant_uid: s.applicant_uid
    });
    return sbSaveApplication(app).then(function(){
      return _appSubResolve(id, 'approved', note, appId).then(function(){
        _appSubLinkProfile(s.applicant_uid, appId);
        _appSubCarryDocs(appId, p._docs);
        if(emailOk && typeof notifyApplicationApprovedWaitlist === 'function'){
          try { notifyApplicationApprovedWaitlist(app); } catch(_ne){}
        }
        if(typeof auditEntry === 'function') auditEntry(appId, 'application_created_from_portal', 'Created from applicant portal submission ' + s.id + ' — ' + ([p.fn, p.ln].filter(Boolean).join(' ')), staffEmail);
        if(typeof applications !== 'undefined' && Array.isArray(applications)) applications.push(app);
        _appSubClose();
        if(typeof showToast === 'function') showToast('✓ Application ' + appId + ' created — open it to add scoring & approve', {type:'info'});
        if(typeof renderWorklist === 'function') renderWorklist();
        if(typeof renderDashboard === 'function') try { renderDashboard(); } catch(_e){}
      });
    });
  }).catch(function(err){ console.warn('[app-sub] approve failed:', err); if(typeof showToast === 'function') showToast('Could not create the application — please retry', {type:'error'}); });
}
window._appSubApprove = _appSubApprove;

// Link-field helpers: chip click fills the input; input change relabels the
// primary button (Merge into <id> vs Create application).
function _appSubPickLink(appId){ var el = document.getElementById('app_sub_link_id'); if(el){ el.value = appId; } _appSubSyncPrimary(); }
window._appSubPickLink = _appSubPickLink;
function _appSubSyncPrimary(){
  var el = document.getElementById('app_sub_link_id'); var btn = document.getElementById('app_sub_primary_btn');
  if(!btn) return;
  var v = el ? el.value.trim() : '';
  btn.innerHTML = v ? ('✓ Merge into ' + (v.replace(/[<>&]/g,''))) : '✓ Approve &amp; create application';
}
window._appSubSyncPrimary = _appSubSyncPrimary;

// Route the primary action: merge into an existing app if a valid id is set,
// otherwise create a fresh application.
function _appSubApproveSmart(id){
  var el = document.getElementById('app_sub_link_id');
  var targetId = el ? el.value.trim() : '';
  if(targetId){
    var exists = (window.applications || []).some(function(a){ return a.id === targetId; });
    if(!exists){ if(typeof showToast === 'function') showToast('No application found with id ' + targetId, {type:'error'}); return; }
    _appSubMerge(id, targetId);
  } else {
    _appSubApprove(id);
  }
}
window._appSubApproveSmart = _appSubApproveSmart;

// Merge a portal update/transfer submission into an existing application. Only
// applicant-provided fields overwrite; staff-owned scoring/status are preserved.
function _appSubMerge(id, targetAppId){
  var s = (window._appSubmissions || []).find(function(x){ return x.id === id; });
  if(!s) return;
  var target = (window.applications || []).find(function(a){ return a.id === targetAppId; });
  if(!target){ if(typeof showToast === 'function') showToast('Application ' + targetAppId + ' not found', {type:'error'}); return; }
  var note = (document.getElementById('app_sub_note') || {}).value || '';
  // Read the checkbox BEFORE the modal is torn down by _appSubClose().
  // (Hidden for file-update submissions, so it reads false there.)
  var emailOk = !!((document.getElementById('app_sub_email_ok') || {}).checked);
  var p = s.payload || {};
  var staffEmail = (window.HOUSING_SESSION && HOUSING_SESSION.email) || '';
  // Merge onto a CLONE, save, and only adopt onto the live app after the save
  // resolves. The old code mutated the live object first with no rollback —
  // after a failed save every screen showed portal data that wasn't in the DB
  // until a reload silently reverted it.
  var merged = JSON.parse(JSON.stringify(target));
  // Scalar applicant fields — overwrite only when the applicant supplied a value.
  ['fn','ln','dob','band','marital','reserve','phone','email','street','city','province','postal','occDate','homeless','haveHouse','homeCondition','hasCoApp','livingSituation','applicantComments'].forEach(function(k){
    if(p[k] !== undefined && p[k] !== '' && p[k] !== null) merged[k] = p[k];
  });
  if(p.hasCoApp && p.coApp) merged.coApp = p.coApp;
  // Repeater lists — replace only if the applicant provided a non-empty set.
  ['habitants','incomes','references','pets'].forEach(function(k){ if(Array.isArray(p[k]) && p[k].length) merged[k] = p[k]; });
  if(s.submission_type === 'transfer'){ merged.appType = 'transfer_request'; merged.transferPending = true; }
  merged.last_portal_merge = { submission_id: s.id, type: s.submission_type, at: new Date().toISOString(), by: staffEmail };
  // No "Merging…" progress toast — same persistent-msgbox reasoning as the
  // create path above; the ✓ Merged toast is the only message.
  sbSaveApplication(merged).then(function(){
    Object.assign(target, merged);   // save confirmed — adopt onto the live app
    return _appSubResolve(id, 'approved', note, targetAppId).then(function(){
      _appSubLinkProfile(s.applicant_uid, targetAppId);
      _appSubCarryDocs(targetAppId, p._docs);
      if(emailOk && s.submission_type !== 'update' && typeof notifyApplicationApprovedWaitlist === 'function'){
        try { notifyApplicationApprovedWaitlist(target); } catch(_ne){}
      }
      if(typeof auditEntry === 'function') auditEntry(targetAppId, 'application_updated_from_portal', 'Merged portal ' + s.submission_type + ' submission ' + s.id + ' into ' + targetAppId + (note ? ' — ' + note : ''), staffEmail);
      _appSubClose();
      if(typeof showToast === 'function') showToast('✓ Merged into ' + targetAppId, {type:'info'});
      if(typeof renderWorklist === 'function') renderWorklist();
      if(typeof renderDashboard === 'function') try { renderDashboard(); } catch(_e){}
    });
  }).catch(function(err){ console.warn('[app-sub] merge failed:', err); if(typeof showToast === 'function') showToast('Could not merge — please retry', {type:'error'}); });
}
window._appSubMerge = _appSubMerge;

function _appSubRequestChanges(id){
  var note = (document.getElementById('app_sub_note') || {}).value || '';
  if(!note){ if(typeof showToast === 'function') showToast('Add a note so the applicant knows what to change', {type:'error'}); return; }
  _appSubResolve(id, 'changes_requested', note).then(function(){
    _appSubClose();
    if(typeof showToast === 'function') showToast('Sent back to the applicant for changes', {type:'info'});
    if(typeof auditEntry === 'function') auditEntry('APPSUB:' + id, 'application_submission_changes_requested', note, (window.HOUSING_SESSION && HOUSING_SESSION.email) || '');
    if(typeof renderWorklist === 'function') renderWorklist();
  }).catch(function(err){ console.warn('[app-sub] request changes failed:', err); if(typeof showToast === 'function') showToast('Failed — please retry', {type:'error'}); });
}
window._appSubRequestChanges = _appSubRequestChanges;

function _appSubReject(id){
  var note = (document.getElementById('app_sub_note') || {}).value || '';
  _appSubResolve(id, 'rejected', note).then(function(){
    _appSubClose();
    if(typeof showToast === 'function') showToast('Submission rejected', {type:'info'});
    if(typeof auditEntry === 'function') auditEntry('APPSUB:' + id, 'application_submission_rejected', note, (window.HOUSING_SESSION && HOUSING_SESSION.email) || '');
    if(typeof renderWorklist === 'function') renderWorklist();
  }).catch(function(err){ console.warn('[app-sub] reject failed:', err); if(typeof showToast === 'function') showToast('Failed — please retry', {type:'error'}); });
}
window._appSubReject = _appSubReject;

// Staff action: email an applicant a branded portal sign-in link, pre-linking
// their existing application (appId) to their email so they land on it (update
// / transfer) instead of "start new". Used from the scorecard header + TIC
// footer. Routes through the applicant-intake `invite` action (staff-gated).
function _appSubSendInvite(email, appId){
  var base = (typeof nationPortalBase === 'function') ? nationPortalBase() : location.origin;
  var body = { action: 'invite', email: email, redirect_to: base + '/apply.html' };
  if(appId) body.app_id = appId;
  return fetch(SUPABASE_URL + '/functions/v1/applicant-intake', {
    method: 'POST', headers: Object.assign({}, HOUSING_HEADERS, { 'Content-Type':'application/json' }), body: JSON.stringify(body)
  }).then(function(r){ return r.json().catch(function(){ return {}; }).then(function(d){ return { ok: r.ok, data: d }; }); });
}
function inviteApplicantToPortal(email, name, appId){
  var EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  email = (email || '').trim();
  var who = name || 'this applicant';
  var send = function(addr){
    _appSubSendInvite(addr, appId).then(function(res){
      if(res.ok && res.data && res.data.ok){
        if(typeof showToast === 'function') showToast('✓ Portal invite sent to ' + addr, {type:'info'});
        if(appId && typeof auditEntry === 'function') auditEntry(appId, 'portal_invite_sent', 'Portal invite emailed to ' + addr, (window.HOUSING_SESSION && HOUSING_SESSION.email) || '');
      } else {
        if(typeof showToast === 'function') showToast((res.data && res.data.error) || 'Could not send the invite', { type:'error' });
      }
    }).catch(function(){ if(typeof showToast === 'function') showToast('Network error sending invite', { type:'error' }); });
  };
  if(email && EMAIL_RE.test(email)){
    if(typeof showConfirm === 'function'){
      showConfirm({ title:'Send portal invite?', message:'Email a sign-in link to ' + who + ' at ' + email + '? They can sign in to submit or update their application.', confirmText:'Send invite' })
        .then(function(ok){ if(ok) send(email); });
    } else if(typeof confirm === 'function' && confirm('Send portal invite to ' + email + '?')){ send(email); }
  } else {
    // No/invalid email on file — capture one.
    var entered = (typeof prompt === 'function') ? prompt('Enter ' + who + '’s email to send a portal invite:', email || '') : null;
    if(entered && EMAIL_RE.test(entered.trim())) send(entered.trim());
    else if(entered != null && typeof showToast === 'function') showToast('Please enter a valid email address', { type:'error' });
  }
}
window.inviteApplicantToPortal = inviteApplicantToPortal;

// ── Assignment: single source of truth ──────────────────────────────────
// One rule for "is this application approved enough to be placed in a unit?"
// Shared by the Match queue (row inclusion), confirmAssignment, the unit-edit
// tenant gate, and the Add-Tenant modal so the four can no longer drift with
// different checks and different error messages.
// ── "Is this applicant housed?" — single source ──────────────────────────────
// The rule: an application is HOUSED when it carries an assignment
// (status==='assigned' or assignedUnit set) OR a non-archived unit's
// assignedTo points at it. Six near-identical copies of this existed across
// the KPI counts, drilldowns, reconcile, and likely-housed review before
// consolidation — build the index once per render and test through it.
function buildHousedIndex(units){
  var idx = {};
  (units || (typeof housingUnits !== 'undefined' && housingUnits) || window.housingUnits || [])
    .forEach(function(u){
      if (u && !u.archived && u.assignedTo) idx[u.assignedTo] = ((u.num||'')+' '+(u.street||'')).trim() || true;
    });
  return idx;
}
function appIsHoused(app, idx){
  if (!app) return false;
  if (app.status === 'assigned' || !!app.assignedUnit) return true;
  return !!(idx || buildHousedIndex())[app.id];
}
window.buildHousedIndex = buildHousedIndex;
window.appIsHoused = appIsHoused;

// Is this applicant a CURRENT TENANT — i.e. does a real unit assignment back
// them? Same rule as appIsHoused (kept as a named alias for the hard rule
// that a current tenant can never be typed as a New Application).
function _appIsTenancyHolder(app){
  return appIsHoused(app);
}
window._appIsTenancyHolder = _appIsTenancyHolder;

// The hard-rule message, shared by the radio guard (housing-settings.js) and
// the validateStep0 backstop (housing-app.js). `forHtml` escapes the
// record-data address for innerHTML surfaces.
function tenancyHolderMsg(app, forHtml){
  var addr = (app && app.assignedAddress) || 'a unit';
  var name = app ? (((app.fn||'')+' '+(app.ln||'')).trim() || 'This applicant') : 'This applicant';
  if (forHtml && typeof escapeHtml === 'function') { addr = escapeHtml(addr); name = escapeHtml(name); }
  return name + ' is assigned to ' + addr
    + ' — a current tenant cannot file a New Application. Use Transfer Request (seeking a different unit) or File Update, or clear the unit link first.';
}
window.tenancyHolderMsg = tenancyHolderMsg;

// Mark an application deceased / not-deceased: assignment + save + audit +
// KPI refresh in one place (three hand-copies existed: the wizard checkbox,
// and the Tenant Card sync's two paths). Toast wording stays with callers.
function setAppDeceased(app, opts){
  opts = opts || {};
  if (!app) return;
  var flag = opts.deceased !== false;
  app.deceased = flag;
  if (flag) { if (opts.date || !app.deceasedDate) app.deceasedDate = opts.date || app.deceasedDate || new Date().toISOString().slice(0,10); }
  else if (opts.clearDate) { app.deceasedDate = ''; }
  if (typeof saveApplicationWithDraftFallback === 'function') saveApplicationWithDraftFallback(app);
  else if (typeof sbSaveApplication === 'function') sbSaveApplication(app).catch(function(){});
  if (typeof auditEntry === 'function') auditEntry(app.id,
    flag ? 'app_deceased_set' : 'app_deceased_cleared',
    opts.detail || (flag ? ('Applicant marked deceased' + (app.deceasedDate ? ' — ' + app.deceasedDate : '')) : 'Deceased status cleared'),
    opts.role || window.currentRole || 'staff');
  if (typeof _renderLandingKpis === 'function') { try { _renderLandingKpis(); } catch(e){} }
}
window.setAppDeceased = setAppDeceased;

// Clear the assignment cluster off an application and restore the approved
// status (shared by the not-housed action and the reconcile stale-link
// cleaner). Caller saves + audits.
function clearAppUnitLink(a){
  if (!a) return;
  a.assignedUnit = ''; a.assignedAddress = '';
  if (a.status === 'assigned' && typeof APP_STATUS !== 'undefined') a.status = APP_STATUS.ED_APPROVED;
}
window.clearAppUnitLink = clearAppUnitLink;

function appAssignabilityStatus(app, unit, opts){
  if(!app) return { ok:false, reason:'Application not found' };
  if(app.archived) return { ok:false, reason:'Application is archived' };
  if(app.deceased) return { ok:false, reason:'Applicant is deceased — this application cannot be assigned' };
  // Commercial (business/department) applications are assigned to BUILDINGS,
  // never residential units. With a unit in hand (unit card / Add-Tenant), a
  // commercial app may be assigned when the unit is a commercial, admin, or
  // band building — type must match type. Without unit context (Match queue
  // inclusion etc.) they stay excluded from the residential paths.
  if((app.appType || app.app_type) === 'commercial'){
    var _sec = window._SECONDARY_TYPES || ['commercial_building', 'admin_building', 'band_building'];
    if(unit && _sec.indexOf(unit.type) !== -1){
      // building types match — fall through to the status check below
    } else if(unit){
      return { ok:false, reason:'Commercial applications can only be assigned to a commercial, admin, or band building — this unit is residential' };
    } else {
      return { ok:false, reason:'Commercial applications are assigned from the Business/Department review modal, or from a commercial building\'s unit card' };
    }
  }
  var s = app.status || '';
  var ok = (s === 'ed_approved' || s === 'mgr_approved' || s === 'hm_approved');
  if(ok){
    // Policy 8.5 / 12.5 good-standing gate — arrears with no approved
    // repayment arrangement block assignment. Applied ONLY at the actual
    // assignment actions (opts.forAssignment: confirmAssignment /
    // saveUnitEdit / saveAddTenant) — an arrears-flagged applicant stays
    // VISIBLE on Match and Ready-to-Match with a warning badge (mirrors the
    // BCR pattern) instead of silently vanishing from the queue, and a mere
    // name collision with a debtor can't hide an innocent applicant.
    // Fails open while the finance cache hasn't loaded and when the policy
    // rule is disabled (arrears.js / policy-rules.js).
    if(opts && opts.forAssignment && typeof arrearsAllocationBlock === 'function'){
      var _gs = arrearsAllocationBlock(((app.fn||'') + ' ' + (app.ln||'')).trim());
      if(_gs) return { ok:false, reason:_gs };
    }
    return { ok:true, reason:'' };
  }
  var lbl = (typeof formatAppStatusLabel === 'function') ? formatAppStatusLabel(s) : String(s).replace(/_/g,' ');
  return { ok:false, reason:'Approval required before assigning — application is: ' + lbl };
}
function appIsAssignable(app){ return appAssignabilityStatus(app).ok; }
window.appAssignabilityStatus = appAssignabilityStatus;
window.appIsAssignable = appIsAssignable;

// The good-standing warning for LIST surfaces (Match rows, worklist): the
// same message the assignment gate blocks with, as a badge-able string —
// null when clear / cache unloaded / rule off.
function appArrearsWarning(app){
  if(!app || typeof arrearsAllocationBlock !== 'function') return null;
  try { return arrearsAllocationBlock(((app.fn||'') + ' ' + (app.ln||'')).trim()); }
  catch(e){ return null; }
}
window.appArrearsWarning = appArrearsWarning;

// After a commercial (business/department) application is assigned to a
// building, type the trigger-created tenant row: business/department kind,
// contact person, rent, and the application link. Mirrors the commercial
// review modal's own patch so a unit-card assignment is not second-class
// (the delay lets the housing_units sync trigger create the tenant first).
function sbTypeCommercialTenantForAssignment(app, unit){
  try {
    if(!app || (app.appType || app.app_type) !== 'commercial' || !unit) return;
    var org = app.orgName || app.fn || '';
    if(!org) return;
    var rent = parseFloat(String(app.rentAmount || '').replace(/[^0-9.\-]/g, ''));
    var fields = {
      tenant_type:     app.kind === 'department' ? 'department' : 'business',
      contact_person:  app.contactPerson || null,
      application_id:  app.id,
      current_unit_id: unit.id
    };
    if(!isNaN(rent)) fields.monthly_rent = rent;
    // The tenants row is created by the DB trigger when the unit save lands —
    // an unknown delay (slow cell, degraded-mode queue). Poll for the row
    // instead of a fixed timer, and SCOPE the match to THIS unit so a
    // department housed in two buildings doesn't get its other tenancy's
    // unit link repointed. Prefer return=representation so a 0-row match
    // (trigger not fired yet) is detectable and retried.
    // Match the row for THIS unit — or a not-yet-linked row (the trigger may
    // not stamp current_unit_id). Rows linked to OTHER units are never touched.
    var _filter = '/rest/v1/tenants?full_name=eq.' + encodeURIComponent(org)
                + '&merged_into=is.null'
                + '&or=(current_unit_id.eq.' + encodeURIComponent(unit.id) + ',current_unit_id.is.null)';
    var _attempt = 0;
    var _tryPatch = function(){
      _attempt++;
      fetch(SUPABASE_URL + _filter, {
        method: 'PATCH',
        headers: Object.assign({}, HOUSING_HEADERS, { 'Prefer': 'return=representation' }),
        body: JSON.stringify(fields)
      }).then(function(r){ return r.ok ? r.json() : []; })
        .then(function(rows){
          if(rows && rows.length) return;                       // typed — done
          if(_attempt < 6){ setTimeout(_tryPatch, 1500); return; }  // trigger not fired yet
          console.warn('[commercial] tenant row for "' + org + '" on ' + unit.id + ' never appeared — typing skipped.');
          if(typeof showToast === 'function') showToast(
            'Could not type the commercial tenant record for ' + org + ' — open their Tenant Card and check the type/rent fields.',
            {type:'error'});
        })
        .catch(function(e){
          if(_attempt < 6){ setTimeout(_tryPatch, 1500); return; }
          console.warn('[commercial] tenant type patch failed:', e);
        });
    };
    setTimeout(_tryPatch, 700);
  } catch(e){ console.warn('[commercial] tenant typing threw:', e); }
}
window.sbTypeCommercialTenantForAssignment = sbTypeCommercialTenantForAssignment;

// Whenever a unit is assigned to an application, mirror the tenancy back onto
// the application record (assignedUnit / assignedAddress / status='assigned').
// This is the "always write back" rule: without it, applicants housed through
// paths that only wrote the unit side keep leaking onto Match as if unhoused
// (the Cheryl Neegan class of bug). Safe no-op when the sides already agree.
function writeTenancyToApplication(unit){
  if(!unit || !unit.assignedTo) return null;
  var apps = (typeof applications !== 'undefined') ? applications : [];
  var app = apps.find(function(a){ return a && a.id === unit.assignedTo; });
  if(!app) return null;
  var addr = ((unit.num||'') + ' ' + (unit.street||'')).trim();
  var changed = false;
  if(app.assignedUnit !== unit.id){        app.assignedUnit    = unit.id; changed = true; }
  if(app.assignedAddress !== addr){         app.assignedAddress = addr;    changed = true; }
  // The tenant now LIVES at the unit — their street address follows the
  // assignment (unit wins, same convention as the reconcile address merge:
  // street line only, city/province/postal left as entered). Commercial
  // applications keep their business address.
  if(addr && (app.appType || app.app_type) !== 'commercial' && (app.street||'').trim() !== addr){
    var _prevStreet = app.street || '(blank)';
    app.street = addr;
    changed = true;
    if(typeof auditEntry === 'function') auditEntry(app.id, 'app_address_merged',
      'Address set to assigned unit: "' + _prevStreet + '" → "' + addr + '" (unit assignment; unit wins)',
      window.currentRole || 'staff');
  }
  if(app.status !== 'assigned'){
    app.status     = 'assigned';
    app.assignedAt = app.assignedAt || unit.assignedDate || new Date().toISOString();
    changed = true;
  }
  // NOTE: app_type is NOT mutated here. "Housed vs new application" is derived
  // from live unit linkage (see the New Applications count + reconcileAssignments
  // reverse pass), so unlinking a tenant returns them to the waitlist automatically
  // instead of leaving a stale/sticky classification.
  if(changed){
    if(typeof saveApplicationWithDraftFallback === 'function') saveApplicationWithDraftFallback(app);
    else if(typeof sbSaveApplication === 'function') sbSaveApplication(app).catch(function(e){ console.warn('[tenancy] app write-back failed:', e); });
  }
  return app;
}
window.writeTenancyToApplication = writeTenancyToApplication;

function _getPoolSpent(pid) {
  // Sum all previously approved reno budgets for this pool
  var total = 0;
  var allUnits = getAllUnits();
  allUnits.forEach(function(u){
    try{
      var approval = (window._renoBudget && window._renoBudget[u.id]) || null;
      if(!approval || !approval.allocations) return;
      Object.keys(approval.allocations).forEach(function(key){
        var a = approval.allocations[key];
        if(a.pool===pid) total += parseFloat(a.amount)||0;
      });
    }catch(e){}
  });
  return total;
}
function _initSigPad(canvasId) {
  var canvas = document.getElementById(canvasId);
  if (!canvas) return;
  // If _sigPads already holds THIS exact element, it's already wired — skip.
  // A new element with the same ID (modal reopened) won't match, so it gets
  // initialized fresh instead of being silently skipped.
  if (_sigPads[canvasId] === canvas) return;
  var ctx = canvas.getContext('2d');
  var drawing = false;
  var lastX = 0, lastY = 0;
  function getPos(e) {
    var rect = canvas.getBoundingClientRect();
    var scaleX = canvas.width / rect.width;
    var scaleY = canvas.height / rect.height;
    var src = e.touches ? e.touches[0] : e;
    return { x: (src.clientX - rect.left) * scaleX, y: (src.clientY - rect.top) * scaleY };
  }
  function start(e) { e.preventDefault(); drawing = true; var p = getPos(e); lastX = p.x; lastY = p.y; }
  function move(e) {
    if (!drawing) return; e.preventDefault();
    var p = getPos(e);
    ctx.beginPath(); ctx.moveTo(lastX, lastY); ctx.lineTo(p.x, p.y);
    ctx.strokeStyle = '#111'; ctx.lineWidth = 1.8; ctx.lineCap = 'round'; ctx.stroke();
    lastX = p.x; lastY = p.y;
    canvas.classList.add('has-sig');
  }
  function end() { drawing = false; }
  canvas.addEventListener('mousedown', start);
  canvas.addEventListener('mousemove', move);
  canvas.addEventListener('mouseup', end);
  canvas.addEventListener('mouseleave', end);
  canvas.addEventListener('touchstart', start, { passive: false });
  canvas.addEventListener('touchmove', move, { passive: false });
  canvas.addEventListener('touchend', end);
  _sigPads[canvasId] = canvas; // store element ref so re-open detection works
}
function _rbaAllocRow(key, label, suggestedCost, eligiblePools, budgetData, approval) {
  var prevAlloc = approval && approval.allocations && approval.allocations[key];
  var poolOpts = eligiblePools.map(function(pid){
    var pool = BUDGET_POOLS.find(function(p){ return p.id===pid; });
    return '<option value="'+pid+'"'+(prevAlloc&&prevAlloc.pool===pid?' selected':'')+'>'+((pool&&pool.label)||pid)+'</option>';
  }).join('');
  return '<div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px 14px;display:grid;grid-template-columns:1fr auto auto;gap:10px;align-items:center;">'
    +'<div class="js-txt-bold">'+label+'</div>'
    +'<select id="rba_pool_'+key+'" style="padding:6px 10px;border:1px solid var(--border);border-radius:7px;font-size:12px;font-family:\'DM Sans\',sans-serif;background:var(--surface);color:var(--text);">'+poolOpts+'</select>'
    +'<input type="number" id="rba_amt_'+key+'" value="'+(prevAlloc?prevAlloc.amount:Math.round(suggestedCost))+'" min="0" step="100" '
      +'style="width:110px;padding:6px 10px;border:1px solid var(--border);border-radius:7px;font-size:13px;font-weight:700;text-align:right;background:var(--surface);color:var(--text);" placeholder="$"/>'
    +'</div>';
}
function _rbaStat(label, value, col) {
  return '<div style="text-align:center;">'
    +'<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:var(--muted);margin-bottom:4px;">'+label+'</div>'
    +'<div style="font-size:16px;font-weight:800;color:'+col+';">'+value+'</div>'
    +'</div>';
}
function _readContractorFormData() {
  // Reads the current state of the contractor form without requiring a save
  var get = function(id){ var el=document.getElementById(id); return el ? el.value.trim() : ''; };
  var classRadio = document.querySelector('input[name="ct_classification"]:checked');
  var torEl = document.getElementById('ct_tor_agreed');
  return {
    id:          '',
    name:        get('ct_name'),
    trade:       get('ct_trade'),
    phone:       get('ct_phone'),
    email:       get('ct_email'),
    address:     get('ct_address'),
    hst:         get('ct_hst'),
    wsibNum:     get('ct_wsib_num'),
    wsibExpiry:  get('ct_wsib_expiry'),
    insProvider: get('ct_ins_provider'),
    insPolicy:   get('ct_ins_policy'),
    insAmount:   get('ct_ins_amount'),
    insExpiry:   get('ct_ins_expiry'),
    notes:       get('ct_notes'),
    classification: classRadio ? classRadio.value : '',
    classProof:  get('ct_class_proof'),
    torAgreed:   torEl ? torEl.checked : false,
    torAgreedAt: torEl && torEl.checked ? new Date().toISOString().split('T')[0] : '',
    sigStaff: {
      name:  get('ct_sig_staff_name'),
      date:  get('ct_sig_staff_date'),
      image: (typeof getSigDataURL === 'function') ? getSigDataURL('ct_sig_canvas_staff') : ''
    },
    sigCt: {
      name:  get('ct_sig_ct_name'),
      title: get('ct_sig_ct_title'),
      date:  get('ct_sig_ct_date'),
      image: (typeof getSigDataURL === 'function') ? getSigDataURL('ct_sig_canvas_ct') : ''
    },
    people: (typeof ctGetPeople === 'function') ? ctGetPeople() : []
  };
}
function _renderRpPendingPhotos() {
  var preview = document.getElementById('rp_photo_preview');
  if(!preview) return;
  var stored  = (window._rpStoredPhotos||[]).map(function(src, i) {
    return '<div style="position:relative;width:80px;height:80px;border-radius:8px;overflow:hidden;border:1px solid var(--border);">'
      +'<img src="'+src+'" class="img-cover"/>'
      +'<button type="button" onclick="removeRenoPhoto('+i+')" class="btn-photo-remove" style="position:absolute;top:3px;right:3px;">✕</button>'
      +'</div>';
  });
  var pending = (window._rpPendingPhotos||[]).map(function(src) {
    return '<div style="position:relative;width:80px;height:80px;border-radius:8px;overflow:hidden;border:2px solid var(--yellow);" title="New — not yet saved">'
      +'<img src="'+src+'" class="img-cover"/>'
      +'<div style="position:absolute;bottom:0;left:0;right:0;background:rgba(248,228,26,0.85);font-size:8px;font-weight:700;text-align:center;padding:2px;color:var(--dark);">NEW</div>'
      +'</div>';
  });
  preview.innerHTML = stored.concat(pending).join('');
}
function _restoreSigCanvas(canvasId, dataURL) {
  if(!dataURL || !dataURL.startsWith('data:')) return;
  var canvas = document.getElementById(canvasId);
  if(!canvas) return;
  var img = new Image();
  img.onload = function() {
    var ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  };
  img.src = dataURL;
}
// Restore a saved signature VALUE onto its pad, whichever method was used:
//   'data:...'   -> draw onto the canvas (Draw tab)
//   'typed:<name>' -> fill the typed input + switch to the Type tab
//   'wet:<ref>'    -> fill the wet-reference input + switch to the Wet tab
// Without this, reopening a typed/wet-signed record left the pad on the empty
// Draw tab, so re-saving from the review step overwrote the stored signature
// with '' (getSigDataURL reads the visible panel). Use this instead of
// _restoreSigCanvas anywhere a saved signature is restored into a live pad.
function _restoreSignature(canvasId, value) {
  if(!value) return;
  if(value.indexOf('data:') === 0){ _restoreSigCanvas(canvasId, value); return; }
  if(value.indexOf('typed:') === 0){
    var tEl = document.getElementById(canvasId + '_typed');
    if(tEl) tEl.value = value.slice(6);
    if(typeof setSigMethod === 'function') setSigMethod(canvasId, 'type');
    return;
  }
  if(value.indexOf('wet:') === 0){
    var ref = value.slice(4);
    var wEl = document.getElementById(canvasId + '_wet_ref');
    if(wEl) wEl.value = (ref === 'pending') ? '' : ref;
    if(typeof setSigMethod === 'function') setSigMethod(canvasId, 'wet');
    return;
  }
}
window._restoreSignature = _restoreSignature;
function _rsm(model, id) {
  var r = model.find(function(x){ return x.id === id; });
  return r ? (r.pts||0) : 0;
}
// Contractor workflow notifications are not yet wired to the new
// notifications.js pipeline. When they are, replace the call site at
// the contractor approval action handler with notifyContractor<Event>().

// ════════════════════════════════════════════════════════════════════════
// window.sendNotification — generic Edge Function wrapper
// ────────────────────────────────────────────────────────────────────────
// Posts to the deployed `send-notification` Edge Function (Microsoft Graph
// pipeline) using the caller's Supabase JWT. Throws on HTTP/network
// errors so callers can attach a .catch() for logging — most callers
// should fire-and-forget.
//
// Per-event composition + recipient resolution lives in notifications.js.
// ════════════════════════════════════════════════════════════════════════
// Resolve the nation's email brand colour as a server-acceptable hex string.
// Pass a candidate to normalise it (trim, auto-prefix a missing '#'); with no
// argument it resolves: registry primary_color -> the LIVE theme accent.
// Returns '' when nothing valid is available. Shared by sendNotification and
// the magic-link email (which builds its brand object separately and used to
// send the raw registry value - un-normalised and with no theme fallback - so
// its header stayed the Edge Function's slate default).
function _resolveBrandColorHex(candidate) {
  var norm = function(v){
    var s = String(v == null ? '' : v).trim();
    if(/^[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(s)) s = '#' + s;
    return /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(s) ? s : '';
  };
  if (candidate != null) return norm(candidate);
  var _nc = window.NATION_CONFIG || {};
  var bc = norm(_nc.primary_color);
  if (!bc && typeof window._themeAccentHex === 'function') bc = norm(window._themeAccentHex());
  return bc;
}
window._resolveBrandColorHex = _resolveBrandColorHex;

// Canonical name-equality key: lowercase, collapse whitespace, trim. The
// Correct Name feature, A/R import matching, joint-account warning and the
// policy prior-allocation check all key on name equality — they must agree,
// so they all resolve through this one normalizer (variants that also strip
// punctuation stay local and documented at their site).
function normNameKey(s){ return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
window.normNameKey = normNameKey;

// The brand payload the magic-link / password-reset emails carry — one
// builder so the reset and magic-link paths can't drift (they were copies).
function _magicLinkBrand(){
  var _nc = window.NATION_CONFIG || {};
  var _contact = [];
  if(_nc.phone) _contact.push(_nc.phone);
  var _em = _nc.email || _nc.housing_email; if(_em) _contact.push(_em);
  return {
    nation_name:  _nc.display_name || _nc.short || '',
    // Normalised registry colour -> live theme accent fallback (shared
    // resolver) — the raw registry value alone left these emails slate.
    brand_color:  (typeof _resolveBrandColorHex === 'function' ? _resolveBrandColorHex() : (_nc.primary_color || '')),
    contact_line: _contact.join('  |  ')
  };
}
window._magicLinkBrand = _magicLinkBrand;

window.sendNotification = async function(opts) {
  if(!opts || !opts.to || !opts.subject || (!opts.message && !opts.html && !opts.bodyHtml)) {
    throw new Error('sendNotification: requires to + subject + (message|html|bodyHtml)');
  }
  // Nation branding for the email footer + reply-to. The send-notification Edge
  // Function reads these (falling back to its own secret/default), so each
  // nation's mail is branded without per-nation code. Harmless on the legacy
  // function (extra payload fields are ignored).
  try {
    var _nc = window.NATION_CONFIG || {};
    if(opts.brand == null){ var _s = _nc.short || _nc.display_name; if(_s) opts.brand = _s + ' Housing'; }
    if(opts.reply_to == null && _nc.email) opts.reply_to = _nc.email;
    // Branded email shell inputs (read by the send-notification Edge Function).
    if(opts.nation_name == null && _nc.display_name) opts.nation_name = _nc.display_name;
    // Email header colour: registry primary_color first, else the LIVE theme
    // accent (what the ED actually set in Settings -> Themes and what the app
    // renders on screen). The Edge Function's sanitizer accepts ONLY #rgb/
    // #rrggbb and silently falls back to its slate default otherwise, so
    // normalise here: trim, auto-prefix a missing '#', drop anything that
    // still isn't valid hex (so a bad registry value can't shadow the good
    // theme accent). Without this, nations whose branding lives only in the
    // saved theme - or whose registry colour was entered as 'f8e41a' - got
    // the slate-blue default header on every email.
    if(opts.brand_color != null) opts.brand_color = _resolveBrandColorHex(opts.brand_color) || opts.brand_color;
    if(opts.brand_color == null){
      var _bc = _resolveBrandColorHex();
      if(_bc) opts.brand_color = _bc;
    }
    if(opts.contact_line == null){
      var _cp = [];
      if(_nc.phone) _cp.push(_nc.phone);
      var _em = _nc.email || _nc.housing_email; if(_em) _cp.push(_em);
      if(_nc.mailing_address) _cp.push(String(_nc.mailing_address).split('\n')[0]);
      if(_cp.length) opts.contact_line = _cp.join('  |  ');
    }
    // Per-nation email delivery method. The Edge Function honours the requested
    // provider only when its keys are configured server-side, else falls back to
    // its EMAIL_PROVIDER secret. from/from_name apply to the resend/sendgrid path.
    if(_nc.email_config){
      if(opts.email_provider  == null && _nc.email_config.provider)  opts.email_provider  = _nc.email_config.provider;
      if(opts.email_from      == null && _nc.email_config.from)      opts.email_from      = _nc.email_config.from;
      if(opts.email_from_name == null && _nc.email_config.from_name) opts.email_from_name = _nc.email_config.from_name;
    }
  } catch(e) {}
  var session = (typeof HOUSING_SESSION !== 'undefined' && HOUSING_SESSION) ? HOUSING_SESSION : null;
  var token   = session && session.accessToken;
  if(!token) throw new Error('sendNotification: no access token (not signed in)');
  var url = SUPABASE_URL + '/functions/v1/send-notification';
  var r = await fetch(url, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': 'Bearer ' + token
    },
    body: JSON.stringify(opts)
  });
  var data;
  try { data = await r.json(); } catch(_) { data = {}; }
  if(!r.ok) {
    var msg = data.error || 'Unknown error';
    if(data.detail)  msg += ' — detail: ' + (typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail));
    if(data.missing) msg += ' — missing: ' + JSON.stringify(data.missing);
    if(data.status)  msg += ' — graph status: ' + data.status;
    throw new Error('sendNotification ' + r.status + ': ' + msg);
  }
  return data;
};

function _updateRbaAllocSummary(totalCost, eligiblePools, budgetData) {
  var totalAlloc = 0;
  document.querySelectorAll('#rba_alloc_rows input[type="number"]').forEach(function(inp){
    totalAlloc += parseFloat(inp.value)||0;
  });
  var diff = totalAlloc - totalCost;
  var overBudget = false;

  // Check per-pool over-budget
  var poolTotals = {};
  document.querySelectorAll('#rba_alloc_rows [id^="rba_pool_"]').forEach(function(sel){
    var key = sel.id.replace('rba_pool_','');
    var amtEl = document.getElementById('rba_amt_'+key);
    var amt = parseFloat((amtEl&&amtEl.value)||0)||0;
    var pid = sel.value;
    poolTotals[pid] = (poolTotals[pid]||0)+amt;
  });

  var poolWarnings = [];
  eligiblePools.forEach(function(pid){
    var pool = BUDGET_POOLS.find(function(p){ return p.id===pid; });
    var poolData = budgetData.pools[pid]||{allocated:0};
    var allocated = poolData.allocated||0;
    var spent = _getPoolSpent(pid);
    var available = allocated - spent;
    var using = poolTotals[pid]||0;
    if(using > available) {
      overBudget = true;
      poolWarnings.push((pool?pool.label:pid)+' is over available balance by '+formatCurrency(using-available));
    }
  });

  var summaryEl = document.getElementById('rba_alloc_summary');
  var overBudgetSection = document.getElementById('rba_over_budget_section');
  var statusBadge = document.getElementById('rba_status_badge');

  if(overBudget) {
    summaryEl.style.background='var(--danger-bg)'; summaryEl.style.border='1px solid var(--danger)';
    summaryEl.innerHTML = '<div style="color:var(--danger);font-weight:700;margin-bottom:4px;">⚠️ Over Budget</div>'
      +'<div style="font-size:11px;color:var(--danger);">'+poolWarnings.join('<br/>')+'</div>';
    overBudgetSection.style.display='block';
    var msg = document.getElementById('rba_over_budget_msg');
    if(msg) msg.textContent = 'The allocated amounts exceed available pool balances. Executive Director approval and written justification are required.';
    statusBadge.textContent='Over Budget — ED Approval Required'; statusBadge.style.background='var(--danger-bg)'; statusBadge.style.color='var(--danger)';
  } else {
    summaryEl.style.background='var(--success-bg)'; summaryEl.style.border='1px solid var(--success-border)';
    summaryEl.innerHTML = '<div style="color:var(--success);font-weight:700;">✓ Within Budget</div>'
      +'<div style="font-size:11px;color:var(--success);">Total allocated: '+formatCurrency(totalAlloc)+' of '+formatCurrency(totalCost)+' SOW cost</div>';
    overBudgetSection.style.display='none';
    statusBadge.textContent='Pending Approval'; statusBadge.style.background='var(--bg)'; statusBadge.style.color='var(--muted)';
  }
}
function addSowItem(data){
  var cont=document.getElementById('sow_items');if(!cont)return;
  var idx=_sowItemIdx++;
  var catOpts=SOW_CATEGORIES.map(function(cat){return '<option value="'+cat+'"'+(data&&data.category===cat?' selected':'')+'>'+cat+'</option>';}).join('');
  var div=document.createElement('div');div.id='sow_item_'+idx;
  div.style.cssText='display:grid;grid-template-columns:160px 1fr 110px auto;gap:8px;align-items:start;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px;';
  div.innerHTML='<select data-sow="category" style="font-size:12px;padding:6px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);"><option value="">Category</option>'+catOpts+'</select>'
    +'<input data-sow="description" type="text" placeholder="Describe the work required…" value="'+(data&&data.description?data.description.replace(/"/g,'&quot;'):'')+'" style="font-size:12px;padding:6px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);"/>'
    +'<input data-sow="cost" type="number" placeholder="Est. $" min="0" step="100" value="'+(data&&data.cost?parseFloat((data.cost||'').replace(/[^0-9.]/g,''))||'':'')+'" style="font-size:12px;padding:6px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);" oninput="recalcSowTotal()" title="Estimated cost"/>'
    // Quote is captured via the RFQ / contracting flow, not on this form. Keep
    // any existing value in a hidden field so editing + re-saving an old SOW
    // does not wipe a previously entered quote.
    +'<input data-sow="quote" type="hidden" value="'+(data&&data.quote?parseFloat((data.quote||'').replace(/[^0-9.]/g,''))||'':'')+'"/>'
    +'<button type="button" data-sow-del="'+idx+'" style="background:none;border:1px solid var(--danger-border);color:var(--danger);border-radius:6px;padding:6px 8px;cursor:pointer;font-size:12px;">✕</button>';
  cont.appendChild(div);
  div.querySelector('[data-sow-del]').addEventListener('click',function(){
    var el=document.getElementById('sow_item_'+idx);if(el)el.remove();
    recalcSowTotal();
  });
  recalcSowTotal();
}
function cancelCtAction() {
  var prefix = (_ctPendingAction && _ctPendingAction.prefix) || 'ctap';
  _ctPendingAction = null;
  var nw = document.getElementById(prefix + '_notes_wrap');
  if(nw) nw.style.display='none';
  var ni = document.getElementById(prefix + '_notes');
  if(ni) ni.value='';
}
function closeAddContractorModal(opts){
  opts = opts || {};
  var acm=document.getElementById('addContractorModal');if(acm){acm.style.display='none';acm.style.zIndex='';}
  // Deep-link return: a card opened via a cross-page worklist link goes back to
  // the origin page on close (only when a nav referrer was actually set).
  if(!opts.handoff && window._ctDeepLinkReturn){
    window._ctDeepLinkReturn = false;
    if(typeof _returnToNavReferrer === 'function' && _returnToNavReferrer()) return;
  }
  // If search modal was the caller and is still mounted, refresh its results
  var sm = document.getElementById('contractorSearchModal');
  if(sm && sm.style.display !== 'none') {
    var inp = document.getElementById('ct_search_input');
    contractorSearchFilter(inp ? inp.value : '');
  }
}
function closeCtApprovalPanel() {
  var panel = document.getElementById('ctApprovalPanel');
  if(panel) panel.style.display='none';
  _ctApprovalIdx = -1;
  _ctPendingAction = null;
}
function closePrintPanel() {
  var panel = document.getElementById('printPanel');
  if(panel) panel.classList.remove('is-open');
  document.body.style.overflow = '';
  _printPanelDoc = '';
}
function closeRenoBudget() {
  var modal = document.getElementById('renoBudgetModal');
  if(modal) modal.style.display='none';
}
function closeRenoProgress() {
  var modal = document.getElementById('renoProgressModal');
  if(modal) modal.style.display = 'none';
  window._rpPendingPhotos = [];
  window._rpStoredPhotos = [];
}
function closeSowModal(opts) {
  opts = opts || {};
  var modal = document.getElementById('sowModal');
  if(modal) modal.style.display = 'none';
  // Internal hand-off (e.g. footer "New Request" closes this form only to
  // immediately reopen a fresh one on the same unit): skip BOTH return
  // navigations below — they would leave the page before the reopen runs.
  // The stored referrer/return keys stay set so the eventual real close of
  // the follow-up form still returns the user to where they came from.
  // Mirrors closeAddContractorModal's opts.handoff.
  if (opts.handoff) return;
  // Cross-page handoff back: if we arrived via _ctOpenSowFromList from
  // contractors.html, return to that contractor card.
  try {
    var ret = sessionStorage.getItem('clfn_sow_return');
    if (ret) {
      sessionStorage.removeItem('clfn_sow_return');
      var data = JSON.parse(ret);
      if (data && data.page === 'contractors') {
        window.location.href = 'contractors.html?openContractor=' + encodeURIComponent(data.ctId || '');
        return;
      }
    }
  } catch (e) { /* harmless */ }
  // Deep-link / worklist return: if a nav referrer was set (e.g. a SOW opened
  // via a cross-page worklist link, or handed off from a deep-linked unit
  // card), closing the request returns the user to where they came from.
  // No referrer (a SOW opened in-place on this page) → stays here.
  if (typeof _returnToNavReferrer === 'function') _returnToNavReferrer();
}
function collectSowItems(){
  var items=[];
  document.querySelectorAll('#sow_items > div').forEach(function(row){
    items.push({
      category:    (row.querySelector('[data-sow="category"]')||{}).value||'',
      description: (row.querySelector('[data-sow="description"]')||{}).value||'',
      cost:        (row.querySelector('[data-sow="cost"]')||{}).value||'',
      quote:       (row.querySelector('[data-sow="quote"]')||{}).value||''
    });
  });
  return items;
}
function confirmCtAction() {
  if(!_ctPendingAction) return;
  var action = _ctPendingAction.action;
  var needsNotes = _ctPendingAction.needsNotes;
  var prefix = _ctPendingAction.prefix || 'ctap';
  var notesEl = document.getElementById(prefix + '_notes');
  var notes = (notesEl && notesEl.value) ? notesEl.value.trim() : '';

  if(needsNotes && !notes) {
    showToast('Please add a note explaining this decision.', {type:'error'});
    if(notesEl) notesEl.focus();
    return;
  }

  var contractors = window._contractors || [];
  if(_ctApprovalIdx < 0 || _ctApprovalIdx >= contractors.length) return;
  var ct = contractors[_ctApprovalIdx];
  var role = window.currentRole || 'staff';
  var today = new Date().toISOString().split('T')[0];

  // Apply status change
  ct.status = action;
  if(action === 'hm_recommended') { ct.hmActionAt = today; ct.hmActionBy = role; ct.hmNotes = notes; }
  if(action === 'approved')        { ct.edActionAt = today; ct.edActionBy = role; ct.edNotes  = notes; }
  if(action === 'declined')        { ct.declinedAt = today; ct.declinedBy = role; ct.declinedReason = notes; }
  if(action === 'returned')        { ct.returnedAt = today; ct.returnedBy = role; ct.returnedNotes  = notes; }

  contractors[_ctApprovalIdx] = ct;
  window._contractors = contractors;
  // Keep _ctLastSaved current so Print uses the latest status without
  // requiring a separate Save Changes click.
  window._ctLastSaved = ct;

  // Audit entry
  var actionLabels = {hm_recommended:'HM verified and recommended to ED',approved:'Final approval granted ('+role+')',declined:'Application declined'+(notes?' — '+notes:''),returned:'Returned for more information'+(notes?' — '+notes:'')};
  auditEntry('CT:'+ct.id, action, (actionLabels[action]||action)+': '+ct.name, role);

  // Persist the status change so it survives a reload — without this,
  // approvals only live in window._contractors and vanish on refresh.
  if(typeof sbSaveContractor === 'function') {
    saveContractorWithDraftFallback(ct);
  }

  if (typeof notifyContractorStatusChange === 'function') {
    notifyContractorStatusChange(ct, action, notes);
  }

  var toastLabels = {hm_recommended:'Recommended to ED',approved:'Contractor approved',declined:'Application declined',returned:'Returned for more info'};
  showToast(toastLabels[action]||action, {type:'info'});
  cancelCtAction();
  // Refresh whichever surface the action came from. CIC = inline approval
  // sections inside the edit modal (stays open — the user is editing the
  // contractor). ctap = the approval side panel: the decision is made, so close
  // the panel and return to the initiating screen (contractors list / worklist)
  // rather than leaving the form open on the post-action state.
  if(prefix === 'cic') {
    _ctRenderCicApproval(ct);
  } else {
    if(typeof closeCtApprovalPanel === 'function') closeCtApprovalPanel();
  }
  renderContractorsView();
  // If the panel was opened from the landing-page worklist, refresh it so the
  // just-actioned contractor drops out of "Contractors Waiting Approval".
  if(typeof renderWorklist === 'function' && document.getElementById('worklist_body')) renderWorklist();
}
// Re-render the inline approval surface inside the edit modal. Used after
// confirmCtAction lands, so the status banner / flow / action pills reflect
// the new state without closing and reopening the CIC.
function _ctRenderCicApproval(ct) {
  if(!ct) return;
  _ctSetCicStatusBanner(ct);
  if(typeof _ctRenderActions === 'function')   _ctRenderActions(ct, 'cic');
  if(typeof _ctRenderFlow === 'function')      _ctRenderFlow(ct.status || 'pending_review', ct, 'cic');
  if(typeof _ctRenderFormsSows === 'function') _ctRenderFormsSows(ct.id, 'cic');
}
function _ctSetCicStatusBanner(ct) {
  var banner = document.getElementById('cic_status_banner');
  if(!banner) return;
  var ss = contractorStatusBadge(ct.status || 'pending_review') || {bg:'#f4f4f0',c:'var(--gray)',label:ct.status||'Unknown'};
  banner.textContent = ss.label;
  banner.style.background = ss.bg;
  banner.style.color = ss.c;
}
function ctFileDragLeave(zoneId){var z=document.getElementById(zoneId);if(z){z.style.borderColor='var(--border)';z.style.background='var(--bg)';}}
function ctFileUpload(input,bucket){
  if(!input.files||!input.files.length)return;
  if(!window._ctFiles)window._ctFiles={wsib:[],insurance:[],other:[]};
  Array.from(input.files).forEach(function(file){
    var reader=new FileReader();
    reader.onload=function(e){
      window._ctFiles[bucket].push({name:file.name,type:file.type,size:file.size,data:e.target.result,added:new Date().toISOString().slice(0,10)});
      renderCtFilePreview(bucket);
    };
    reader.readAsDataURL(file);
  });
  input.value='';
}
function ctGetPeople() {
  // Flush current input values back into the in-memory array before returning.
  // This keeps _ctPeople in sync with whatever the user has typed so far.
  var people = window._ctPeople || [];
  document.querySelectorAll('#ct_people_list [data-pi]').forEach(function(el) {
    var i = parseInt(el.getAttribute('data-pi'));
    if(!people[i]) people[i] = {name:'',phone:'',email:''};
    if(el.classList.contains('ct-person-name'))  people[i].name  = el.value;
    if(el.classList.contains('ct-person-phone')) people[i].phone = el.value;
    if(el.classList.contains('ct-person-email')) people[i].email = el.value;
  });
  window._ctPeople = people;
  // Return a filtered copy for saving — blank rows are excluded from the payload.
  return people.filter(function(p){ return p && (p.name||p.phone||p.email); });
}
function ctRenderPeople(people) {
  // Sync in-memory array — always render from _ctPeople, not a filtered copy,
  // so blank rows persist while the user is still filling them in.
  window._ctPeople = people || [];
  var list = document.getElementById('ct_people_list');
  if(!list) return;
  if(!window._ctPeople.length) {
    list.innerHTML = '<div style="font-size:12px;color:var(--muted);font-style:italic;padding:4px 0;">No key contacts added yet.</div>';
    return;
  }
  list.innerHTML = window._ctPeople.map(function(p, i) {
    // value attributes escaped — a stored name/email containing a double quote
    // (or an injected payload) broke out of the attribute otherwise.
    return '<div style="display:grid;grid-template-columns:1fr 1fr 1fr auto;gap:8px;align-items:center;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:6px;">'
      +'<input type="text"  class="ct-person-name"  data-pi="'+i+'" value="'+escapeHtml(p.name||'')+'"  placeholder="Full name"  style="padding:6px 10px;border:1px solid var(--border);border-radius:6px;font-size:12px;font-family:DM Sans,sans-serif;background:var(--surface);color:var(--text);"/>'
      +'<input type="tel"   class="ct-person-phone" data-pi="'+i+'" value="'+escapeHtml(p.phone?formatPhone(p.phone):'')+'" placeholder="(705)-000-0000" oninput="fmtPhone(this)" style="padding:6px 10px;border:1px solid var(--border);border-radius:6px;font-size:12px;font-family:DM Sans,sans-serif;background:var(--surface);color:var(--text);"/>'
      +'<input type="email" class="ct-person-email" data-pi="'+i+'" value="'+escapeHtml(p.email||'')+'" placeholder="Email"      style="padding:6px 10px;border:1px solid var(--border);border-radius:6px;font-size:12px;font-family:DM Sans,sans-serif;background:var(--surface);color:var(--text);"/>'
      +'<button type="button" onclick="ctRemovePerson('+i+')" style="background:none;border:none;color:var(--danger);cursor:pointer;font-size:16px;padding:2px 6px;line-height:1;" title="Remove">✕</button>'
      +'</div>';
  }).join('');
}
function ctUpdateClassBorders() {
  var labels = document.querySelectorAll('input[name="ct_classification"]');
  labels.forEach(function(radio) {
    var label = radio.closest('label');
    if(!label) return;
    label.style.borderColor = radio.checked ? 'var(--yellow)' : 'var(--border)';
    label.style.background  = radio.checked ? 'rgba(248,228,26,0.06)' : '';
    // Show/hide proof field for indigenous types
    var proofRow = document.getElementById('ct_class_proof_row');
    var anyIndigenous = document.querySelector('input[name="ct_classification"][value="internal_indigenous"]:checked')
                     || document.querySelector('input[name="ct_classification"][value="external_indigenous"]:checked');
    if(proofRow) proofRow.style.display = anyIndigenous ? '' : 'none';
  });
}
async function deactivateStaff(id, btn){
  var ok = await showConfirm({
    title:       'Deactivate this staff member?',
    message:     'They will lose access to the app immediately. Their account record is preserved.',
    confirmText: 'Deactivate',
    danger:      true
  });
  if (!ok) return;
  if(btn){btn.disabled=true;btn.textContent='...';}
  try {
    var r = await fetch(SUPABASE_URL+'/rest/v1/staff?id=eq.'+id,{
      method:'PATCH',
      headers:Object.assign({},HOUSING_HEADERS,{'Prefer':'return=minimal'}),
      body:JSON.stringify({is_active:false})
    });
    if(r.ok){
      showToast('Staff member deactivated', {type:'info'});
      renderHousingUserTable();
    } else {
      showToast('Could not deactivate — check permissions', {type:'error'});
      if(btn){btn.disabled=false;btn.textContent='Deactivate';}
    }
  } catch(e){
    showToast('Error: '+e.message, {type:'error'});
    if(btn){btn.disabled=false;btn.textContent='Deactivate';}
  }
}
// Flip a deactivated staff record back on. The underlying Supabase Auth
// user is untouched by deactivation, so a single PATCH on the staff row
// fully restores app access. The admin should follow up with Send Reset
// if the returning employee can't recall their password.
async function reactivateStaff(id, btn){
  var u = (window._staffCache||{})[id] || {};
  var email = (u.email||'').toLowerCase();
  var name  = u.name || email;
  var ok = await showConfirm({
    title:       'Reactivate this staff member?',
    message:     'They regain access to the app. If their Supabase login was deleted, it is recreated with a temporary password (shown after). If the login still exists, it is kept — use Send Reset if they forgot the password.',
    confirmText: 'Reactivate'
  });
  if (!ok) return;
  if(btn){btn.disabled=true;btn.textContent='...';}
  try {
    // Recreate/adopt the login (idempotent): signup creates the auth user if it
    // was deleted out-of-band; if it still exists, Supabase reports "already
    // registered" and we keep it. Fixes the "reactivated but can't log in"
    // orphaned-record case.
    var pw = (typeof nationShort==='function' ? nationShort() : 'HOME') + ((name||'').split(' ')[0]||'') + '2026!';
    var newLogin = false;
    if(email){
      try {
        var sr = await fetch(SUPABASE_URL+'/auth/v1/signup',{ method:'POST', headers:HOUSING_HEADERS,
          body:JSON.stringify({email:email, password:pw, data:{full_name:name}}) });
        var sd = await sr.json().catch(function(){ return {}; });
        var already = (sd.code==='user_already_exists') || /already.*(registered|exists)/i.test((sd.msg||'')+' '+(sd.error_description||'')+' '+(sd.error||''));
        newLogin = !!(sr.ok && ((sd.user && sd.user.id) || sd.id) && !already);
      } catch(_e){ /* best-effort; the PATCH below still reactivates the record */ }
    }
    var r = await fetch(SUPABASE_URL+'/rest/v1/staff?id=eq.'+id,{
      method:'PATCH',
      headers:Object.assign({},HOUSING_HEADERS,{'Prefer':'return=minimal'}),
      body:JSON.stringify({is_active:true})
    });
    if(r.ok){
      showToast(newLogin ? ('Reactivated + login recreated — temporary password: '+pw) : 'Staff member reactivated', {type:'info'});
      auditEntry('SETTINGS','settings_user_reactivate','Staff reactivated (id='+id+')'+(newLogin?' + login recreated':''),window.currentRole||'ed');
      if(newLogin && email && typeof sendNotification==='function'){
        try {
          var portal = (window.NATION_CONFIG && NATION_CONFIG.portal_base) || location.origin;
          var nname  = (window.NATION_CONFIG && (NATION_CONFIG.display_name||NATION_CONFIG.short)) || 'Housing';
          sendNotification({ to: email, to_name: name, subject: 'Your '+nname+' Housing account is ready',
            html: '<p>Hello '+escapeHtml(name)+',</p><p>Your access to the '+escapeHtml(nname)+' Housing app has been restored.</p>'
              + '<p><b>Sign in:</b> <a href="'+escapeHtml(portal)+'">'+escapeHtml(portal)+'</a><br>'
              + '<b>Email:</b> '+escapeHtml(email)+'<br><b>Temporary password:</b> '+escapeHtml(pw)+'</p>'
              + '<p>Please sign in and change your password from Settings.</p>' });
        } catch(_we){}
      }
      renderHousingUserTable();
    } else {
      showToast('Could not reactivate — check permissions', {type:'error'});
      if(btn){btn.disabled=false;btn.textContent='Reactivate';}
    }
  } catch(e){
    showToast('Error: '+e.message, {type:'error'});
    if(btn){btn.disabled=false;btn.textContent='Reactivate';}
  }
}
// Send a password-reset email to a staff member from the admin table. Uses
// the same /auth/v1/recover endpoint + redirect_to as the public Forgot
// Password flow, so the email link lands on the reset panel on index.html.
// We don't surface response details (anti-enumeration) and we don't gate
// resends — Supabase rate-limits the endpoint server-side per email + IP.
async function sendStaffPasswordReset(email, btn){
  if(!email){ showToast('No email on file', {type:'error'}); return; }
  if(btn){btn.disabled=true; btn.textContent='Sending…';}
  try {
    var redirectTo = window.location.origin + '/index.html';
    // Preferred path: the send-magic-link Edge Function with type 'recovery'
    // generates the reset link and emails it through the nation's BRANDED
    // pipeline (housing mailbox) — the old /auth/v1/recover endpoint depends
    // on the Supabase auth mailer, which this project doesn't configure, so
    // sends were failing with an unexplained "could not be sent".
    var token = (window.HOUSING_SESSION && HOUSING_SESSION.accessToken) || '';
    var fnDown = false;
    try {
      var fr = await fetch(SUPABASE_URL + '/functions/v1/send-magic-link', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body:    JSON.stringify({
          type: 'recovery',
          email: email,
          redirect_to: redirectTo,
          brand: _magicLinkBrand()
        })
      });
      if (fr.status === 404) { fnDown = true; }   // function not deployed yet — legacy fallback
      else {
        var fd = await fr.json().catch(function(){ return {}; });
        if (fr.ok && fd.ok) {
          showToast('Reset link sent to '+email, {type:'info'});
          auditEntry('SETTINGS','settings_user_send_reset','Password reset sent to '+email,window.currentRole||'ed');
          return;
        }
        showToast('Could not send reset — ' + (fd.error || ('HTTP ' + fr.status)) + (fd.detail ? ' (' + fd.detail + ')' : ''), {type:'error'});
        return;
      }
    } catch(_fe){ fnDown = true; }   // function unreachable — legacy fallback

    // Legacy fallback: Supabase's own recover mailer. Surface the REAL reason
    // on failure (SMTP not configured, redirect URL not allowlisted, ...)
    // instead of a generic message.
    var r = await fetch(SUPABASE_URL + '/auth/v1/recover', {
      method:  'POST',
      headers: { 'apikey': SUPABASE_ANON, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email: email, redirect_to: redirectTo })
    });
    if(r.status === 429){
      showToast('Too many reset attempts — try again in a few minutes', {type:'error'});
    } else if(!r.ok){
      var eb = await r.json().catch(function(){ return {}; });
      showToast('Could not send reset — ' + (eb.msg || eb.message || eb.error_description || ('HTTP ' + r.status)), {type:'error'});
    } else {
      showToast('Reset link sent to '+email, {type:'info'});
      auditEntry('SETTINGS','settings_user_send_reset','Password reset sent to '+email,window.currentRole||'ed');
    }
  } catch(e){
    showToast('Error: '+e.message, {type:'error'});
  } finally {
    if(btn){btn.disabled=false; btn.textContent='Send Reset';}
  }
}
// Issue a passwordless magic-link sign-in for a magic-link-enabled user.
// Admin-only, in-app — there is no public self-request. If a consultant's link
// expires, they ask an admin to issue a new one from Settings -> Users.
// The row button opens a chooser: EMAIL the link through the nation's branded
// pipeline (the original behaviour), or COPY the link so the admin can paste
// it into their own email / Teams / text message.
function sendStaffMagicLink(email, btn){
  if(!email){ showToast('No email on file', {type:'error'}); return; }
  if(typeof APPROVAL_AUTHORITY !== 'undefined' && !APPROVAL_AUTHORITY.can('manageStaffRecord', window.currentRole)){
    showToast('Not permitted', {type:'error'}); return;
  }
  if(document.getElementById('_staffMagicOv')) return;
  var esc = (typeof escapeHtml === 'function') ? escapeHtml : function(s){ return String(s==null?'':s); };
  var ov = document.createElement('div');
  ov.id = '_staffMagicOv';
  ov.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:20px;';
  ov.innerHTML =
    '<div style="background:var(--surface);border-radius:14px;max-width:520px;width:100%;box-shadow:0 24px 60px rgba(0,0,0,.35);overflow:hidden;">' +
      '<div class="modal-hdr compact"><div>' +
        '<div class="modal-hdr-title">&#128273; Sign-in link</div>' +
        '<div class="modal-hdr-sub">' + esc(email) + '</div>' +
      '</div></div>' +
      '<div style="padding:16px 18px;font-size:13px;color:var(--text);line-height:1.55;">' +
        'The link is <strong>single-use</strong> and expires shortly — have them open it on the device they will sign in on.' +
        '<div id="_staffMagicLinkWrap" style="display:none;margin-top:12px;">' +
          '<input id="_staffMagicLinkInput" type="text" readonly onclick="this.select()" ' +
            'style="width:100%;box-sizing:border-box;border:1.5px solid var(--border);border-radius:8px;padding:9px 11px;font-size:11.5px;font-family:monospace;background:var(--bg);color:var(--text);"/>' +
          '<div id="_staffMagicLinkNote" style="margin-top:6px;font-size:11.5px;color:var(--muted);"></div>' +
        '</div>' +
      '</div>' +
      '<div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;">' +
        '<button class="btn btn-ghost" onclick="_staffMagicClose()">Close</button>' +
        '<button class="btn btn-ghost" id="_staffMagicCopyBtn" onclick="_staffMagicCopy(\'' + esc(email).replace(/'/g,"\\'") + '\')">&#128203; Copy link</button>' +
        '<button class="btn btn-primary" id="_staffMagicEmailBtn" onclick="_staffMagicEmail(\'' + esc(email).replace(/'/g,"\\'") + '\')">&#128231; Email the link</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(ov);
  ov.addEventListener('click', function(e){ if(e.target === ov) _staffMagicClose(); });
}
function _staffMagicClose(){
  var ov = document.getElementById('_staffMagicOv');
  if(ov && ov.parentNode) ov.parentNode.removeChild(ov);
}
// COPY path: generate the link server-side (same admin + target gates as the
// email path) and hand it to the admin — clipboard first, with the visible
// selectable input as the always-works fallback.
async function _staffMagicCopy(email){
  // Defense-in-depth: window-exposed and callable directly, so re-check the
  // authority here too (send-magic-link enforces server-side regardless).
  if(typeof APPROVAL_AUTHORITY !== 'undefined' && !APPROVAL_AUTHORITY.can('manageStaffRecord', window.currentRole)){
    showToast('You are not authorized to generate sign-in links.', {type:'error'}); return;
  }
  var btn = document.getElementById('_staffMagicCopyBtn');
  if(btn){ btn.disabled = true; btn.textContent = 'Generating…'; }
  try {
    var token = (window.HOUSING_SESSION && HOUSING_SESSION.accessToken) || '';
    var r = await fetch(SUPABASE_URL + '/functions/v1/send-magic-link', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body:    JSON.stringify({ email: email, redirect_to: window.location.origin + '/index.html', mode: 'link' })
    });
    var data = await r.json().catch(function(){ return {}; });
    if(!r.ok || !data.ok || !data.link){
      showToast(data.error || 'Could not generate a sign-in link — try again', {type:'error'});
      return;
    }
    var wrap = document.getElementById('_staffMagicLinkWrap');
    var inp  = document.getElementById('_staffMagicLinkInput');
    var note = document.getElementById('_staffMagicLinkNote');
    if(wrap && inp){
      wrap.style.display = '';
      inp.value = data.link;
      if(note) note.textContent = (data.expiry ? 'Their access is valid until ' + data.expiry + '. ' : '')
        + 'Pasted into an email it appears as a "Sign in" link, not the raw address; plain-text fields get the full URL.';
    }
    // Copy BOTH flavors: text/html (a friendly named hyperlink — what Outlook/
    // Gmail/Teams/Word render on paste) and text/plain (the raw URL, for
    // plain-text fields). The URL itself can't be shortened — it carries the
    // one-time sign-in token.
    var _esc = (typeof escapeHtml === 'function') ? escapeHtml : function(s){ return String(s==null?'':s); };
    var label = 'Sign in to ' + ((typeof nationShort === 'function') ? nationShort() : 'the') + ' Housing system';
    var linkHtml = '<a href="' + _esc(data.link) + '">' + _esc(label) + '</a>';
    var copied = false;
    try {
      if (navigator.clipboard && window.ClipboardItem) {
        await navigator.clipboard.write([new ClipboardItem({
          'text/html':  new Blob([linkHtml],  { type: 'text/html' }),
          'text/plain': new Blob([data.link], { type: 'text/plain' })
        })]);
        copied = true;
      }
    } catch(e){}
    if(!copied){
      // Fallback 1: copy a selected contenteditable region (carries the HTML
      // flavor on most older browsers).
      try {
        var host = document.createElement('div');
        host.contentEditable = 'true';
        host.style.cssText = 'position:fixed;opacity:0;pointer-events:none;';
        host.innerHTML = linkHtml;
        document.body.appendChild(host);
        var range = document.createRange(); range.selectNodeContents(host);
        var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
        copied = document.execCommand('copy');
        sel.removeAllRanges(); document.body.removeChild(host);
      } catch(e){}
    }
    if(!copied){
      // Fallback 2: plain URL only.
      try { if(navigator.clipboard && navigator.clipboard.writeText){ await navigator.clipboard.writeText(data.link); copied = true; } } catch(e){}
      if(!copied && inp){ inp.focus(); inp.select(); try { copied = document.execCommand('copy'); } catch(e){} }
    }
    showToast(copied ? 'Sign-in link copied — pasting into an email shows "' + label + '" as a clickable link.' : 'Link generated — select and copy it from the box.', {type:'info'});
    auditEntry('SETTINGS','settings_user_copy_magic_link','Magic-link sign-in link generated (copy) for '+email, window.currentRole||'ed');
  } catch(e){
    showToast('Error: '+e.message, {type:'error'});
  } finally {
    if(btn){ btn.disabled = false; btn.textContent = '📋 Copy link'; }
  }
}
// EMAIL path — the original behaviour (branded pipeline, expiry line included).
async function _staffMagicEmail(email){
  // Defense-in-depth: window-exposed and callable directly, so re-check the
  // authority here too (send-magic-link enforces server-side regardless).
  if(typeof APPROVAL_AUTHORITY !== 'undefined' && !APPROVAL_AUTHORITY.can('manageStaffRecord', window.currentRole)){
    showToast('You are not authorized to send sign-in links.', {type:'error'}); return;
  }
  var btn = document.getElementById('_staffMagicEmailBtn');
  if(btn){ btn.disabled=true; btn.textContent='Sending…'; }
  try {
    // Send through the send-magic-link Edge Function, which generates the link
    // and emails it via the nation's branded pipeline (from housing mailbox),
    // including the recipient's access-expiry date — instead of Supabase's own
    // generic auth email.
    var token = (window.HOUSING_SESSION && HOUSING_SESSION.accessToken) || '';
    var r = await fetch(SUPABASE_URL + '/functions/v1/send-magic-link', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body:    JSON.stringify({
        email: email,
        redirect_to: window.location.origin + '/index.html',
        brand: _magicLinkBrand()
      })
    });
    var data = await r.json().catch(function(){ return {}; });
    if(r.ok && data.ok){
      showToast('Sign-in link sent to '+email, {type:'info'});
      auditEntry('SETTINGS','settings_user_send_magic_link','Magic-link sign-in link sent to '+email, window.currentRole||'ed');
      _staffMagicClose();
    } else {
      showToast(data.error || 'Could not send sign-in link — try again', {type:'error'});
    }
  } catch(e){
    showToast('Error: '+e.message, {type:'error'});
  } finally {
    if(btn){ btn.disabled=false; btn.textContent='📧 Email the link'; }
  }
}
window.sendStaffMagicLink = sendStaffMagicLink;
window._staffMagicClose   = _staffMagicClose;
window._staffMagicCopy    = _staffMagicCopy;
window._staffMagicEmail   = _staffMagicEmail;
async function _sbEditStaffModal(id) {
  // Fetch current staff record
  var r = await fetch(SUPABASE_URL+'/rest/v1/staff?id=eq.'+id+'&select=*', { headers: HOUSING_HEADERS });
  var data = await r.json();
  var u = data[0];
  if(!u) { showToast('Staff member not found', {type:'error'}); return; }

  // Determine current housing role
  var currentHrole = sbMapRole(u);

  // Build modal
  var modal = document.getElementById('editStaffModal');
  if(!modal) {
    modal = document.createElement('div');
    modal.id = 'editStaffModal';
    modal.className = 'modal-overlay modal-overlay-centered modal-z-1100';
    document.body.appendChild(modal);
  }

  modal.innerHTML = '<div class="modal-body modal-body-sm">'
      +'<div class="modal-hdr">'
        +'<div class="modal-hdr-title">Edit Staff Member</div>'
        +'<button id="editStaffClose" class="btn-close-dark-30">&times;</button>'
      +'</div>'
      +'<div class="modal-body-stack">'
        +'<div class="f"><label>Full Name</label><input type="text" id="edit_staff_name" value="'+escapeHtml(u.name)+'"/></div>'
        +'<div class="f"><label>Email</label><input type="text" value="'+escapeHtml(u.email)+'" disabled title="Email cannot be changed"/></div>'
        +'<div class="f"><label>Housing Role</label>'
          +'<select id="edit_staff_role">'
          + (function(){
              var perms = window.CLFN_PERMS;
              if(!perms) return '<option value="housing_employee_l1">Housing Employee L1</option>';
              return Object.keys(perms.ROLE_LABELS).map(function(k){
                return '<option value="'+escapeHtml(k)+'"'+(currentHrole===k?' selected':'')+'>'+escapeHtml(perms.roleLabel(k))+'</option>';
              }).join('');
            })()
          +'</select></div>'
        +'<div class="f"><label>Feature Access <span style="font-weight:normal;color:var(--muted);">— untick to restrict; all ticked = full access</span></label>'
          +'<div id="edit_staff_features" style="display:grid;grid-template-columns:1fr 1fr;gap:8px 18px;padding:8px 2px;">'
          + (function(){
              var reg = window.FEATURE_REGISTRY || [];
              var list = (Array.isArray(u.feature_access) && u.feature_access.length) ? u.feature_access : null;
              return reg.map(function(f){
                var checked = list ? (list.indexOf(f.key)!==-1) : true;
                // Checkbox is pinned to 16px + flex:none so the app-wide
                // ".f input{width:100%}" rule can't stretch it and shove the label.
                return '<label style="display:flex;align-items:center;justify-content:flex-start;gap:8px;text-align:left;font-size:12.5px;font-weight:400;line-height:1.3;cursor:pointer;">'
                  +'<input type="checkbox" class="ef-feat" value="'+escapeHtml(f.key)+'"'+(checked?' checked':'')+' style="width:16px;height:16px;min-width:16px;flex:0 0 16px;margin:0;accent-color:#2563eb;"/>'
                  +'<span>'+escapeHtml(f.label)+'</span></label>';
              }).join('');
            })()
          +'</div></div>'
        +'<div class="f"><label>Access Expires <span style="font-weight:normal;color:var(--muted);">— optional; blank = no expiry</span></label>'
          +'<input type="date" id="edit_staff_expires" value="'+escapeHtml(String(u.access_expires_at||'').slice(0,10))+'"/></div>'
        +'<div class="f"><label style="display:flex;align-items:center;gap:8px;font-weight:400;cursor:pointer;">'
          +'<input type="checkbox" id="edit_staff_magic" '+(u.magic_link?'checked':'')+' style="width:16px;height:16px;min-width:16px;flex:0 0 16px;margin:0;accent-color:#2563eb;"/>'
          +'<span><strong>Passwordless (magic-link) sign-in</strong> — for consultants / external users. When on, they sign in with an emailed link; when off, this account uses a password (regular staff).</span></label></div>'
        +'<div class="box-bg-card txt-help">Role + feature changes take effect the next time this staff member signs in. Restricting features hides those functions and blocks their pages; it does not grant approval rights (set separately in Approval Authority). Access Expires denies sign-in after that date (reversible — clear or extend it to restore).</div>'
      +'</div>'
      +'<div class="modal-footer">'
        +'<button id="editStaffCancel" class="btn btn-ghost">Cancel</button>'
        +'<button id="editStaffSave" class="btn btn-primary">Save Changes</button>'
      +'</div>'
    +'</div>';

  modal.classList.add('is-open');
  document.getElementById('editStaffClose').addEventListener('click', function(){ modal.remove(); });
  document.getElementById('editStaffCancel').addEventListener('click', function(){ modal.remove(); });
  document.getElementById('editStaffSave').addEventListener('click', function(){ saveStaffEdit(id, u, modal); });
}
function emailContractorAgreement() {
  // Stub — the contractor-agreement send was on the legacy EmailJS path.
  // Re-implement against window.sendNotification when the contractor
  // notification surface is wired into notifications.js (Phase 3+).
  // Two buttons in contractors.html still bind to this onclick, so
  // keeping it callable (with a clear "not wired yet" toast) avoids
  // ReferenceErrors on click.
  showToast('Email agreement is being re-wired — coming soon.', {type:'info'});
}
function exportContractors(format) {
  var contractors = window._contractors || [];
  var headers=['Company','Trade','Phone','Email','Address','HST #','WSIB #','WSIB Expiry','Insurance Provider','Insurance Expiry','Key Contacts'];
  var data=contractors.map(function(ct){
    var people=(ct.people||[]).map(function(p){return p.name+(p.phone?' ('+formatPhone(p.phone)+')':'');}).join('; ');
    return[ct.name||'',ct.trade||'',ct.phone?formatPhone(ct.phone):'',ct.email||'',ct.address||'',ct.hst||'',ct.wsibNum||'',ct.wsibExpiry||'',ct.insProvider||'',ct.insExpiry||'',people];
  });
  var _ns1=nationShort();
  _doExport(format,headers,data,_ns1+'_Contractors_'+new Date().toISOString().slice(0,10),[28,18,14,24,24,14,14,14,20,14,24],true);
}
function exportInventory(format) {
  var units = getAllUnits();
  var search=(document.getElementById('inv_search')||{}).value||'';
  var fStatus=(document.getElementById('inv_filter_status')||{}).value||'';
  var fType=(document.getElementById('inv_filter_type')||{}).value||'';
  var fAccess=(document.getElementById('inv_filter_access')||{}).value||'';
  var rows=units.filter(function(u){
    if(search&&!(u.street+' '+u.num).toLowerCase().includes(search.toLowerCase())) return false;
    if(fStatus&&u.status!==fStatus) return false;
    if(fType){var t=(u.type||'').toLowerCase();if(fType==='detached'&&!t.includes('detached'))return false;if(fType==='duplex'&&!t.includes('duplex'))return false;if(fType==='plex'&&!t.match(/plex/))return false;if(fType==='complex'&&!t.includes('complex'))return false;if(fType==='mobile'&&!t.includes('mobile'))return false;}
    if(fAccess==='yes'&&!u.accessible)return false;
    if(fAccess==='no'&&u.accessible)return false;
    return true;
  });
  var headers=['Address','Beds','Baths','Type','Foundation','Accessible','Funder','Status','Tenant','Phase'];
  var data=rows.map(function(u){return[u.num+' '+u.street,u.bedrooms,(u.bathrooms&&u.bathrooms!=='0'&&u.bathrooms!=='nan')?u.bathrooms:'',(u.type&&u.type!=='0'&&u.type!=='nan')?u.type:'',(u.foundation&&u.foundation!=='nan'&&u.foundation!=='0')?u.foundation:'',u.accessible?'Yes':'No',u.funder||'',u.status,u.assignedName||'',(u.phase&&u.phase!=='nan'&&u.phase!=='0')?u.phase:''];});
  var _ns2=nationShort();
  _doExport(format,headers,data,_ns2+'_Housing_Inventory_'+new Date().toISOString().slice(0,10),[28,6,6,18,14,10,12,14,22,8],true);
}
function exportTenants(format) {
  // Mirror renderTenantsView's inclusion + search + column-menu sort/filter so
  // the export matches exactly what's on screen (occupied/reserved, not archived).
  var units = getAllUnits().filter(function(u){ return (u.status==='occupied'||u.status==='reserved') && !u.archived; });
  var search = ((document.getElementById('tenant_search')||{}).value||'').toLowerCase().trim();
  if(search) units = units.filter(function(u){
    var hay = [u.num,u.street,u.assignedName,u.assignedDate,u.status,u.bedrooms,u.type,u.classification]
      .filter(function(v){ return v != null; }).join(' ').toLowerCase();
    return hay.indexOf(search) !== -1;
  });
  units.sort(function(a,b){
    var av=((a.num||'')+' '+(a.street||'')).toLowerCase(), bv=((b.num||'')+' '+(b.street||'')).toLowerCase();
    return av<bv?-1:av>bv?1:0;
  });
  var _isMgmt = (typeof ROLE!=='undefined' && ROLE.isManagement) ? ROLE.isManagement(window.currentRole) : false;
  function _tenHasReno(uid){
    if(typeof calcRenoScore!=='function') return false;
    try{
      var sow = (typeof getSowData==='function') ? getSowData(uid) : null;
      var prog = (window._renoProgress && window._renoProgress[uid]) || null;
      return !!(sow&&sow!=='null') || !!(prog&&prog!=='null');
    }catch(e){ return false; }
  }
  function _tenReno(uid){ return _tenHasReno(uid) ? (calcRenoScore(uid).score||0) : ''; }
  // Same accessors + state key the table uses, so a column sort/filter carries
  // into the export.
  var _tenAcc = {
    address:    function(u){ return ((u.num||'')+' '+(u.street||'')).trim(); },
    tenant:     function(u){ return u.assignedName || '(unassigned)'; },
    move_in:    function(u){ return u.assignedDate || '(none)'; },
    status:     function(u){ return u.status==='reserved' ? 'Reserved' : 'Occupied'; },
    reno_score: function(u){ return _tenHasReno(u.id) ? (calcRenoScore(u.id).score||0) : 0; }
  };
  var _tenState = (typeof tableStateGet==='function') ? tableStateGet('tenants') : {sort:{key:'',dir:1},filters:{}};
  if(typeof tableApplyFilterSort==='function') units = tableApplyFilterSort(units, _tenAcc, _tenState);

  var headers = ['Address','Tenant','Move-In Date','Status','Beds','Type'];
  if(_isMgmt) headers.push('Reno Score');
  var data = units.map(function(u){
    var row = [
      ((u.num||'')+' '+(u.street||'')).trim(),
      u.assignedName||'',
      u.assignedDate||'',
      (u.status==='reserved'?'Reserved':'Occupied'),
      u.bedrooms||'',
      (u.type&&u.type!=='0'&&u.type!=='nan')?u.type:''
    ];
    if(_isMgmt) row.push(_tenReno(u.id));
    return row;
  });
  var _nsT = nationShort();
  var widths = _isMgmt ? [28,24,14,12,6,18,10] : [28,24,14,12,6,18];
  _doExport(format,headers,data,_nsT+'_Tenants_'+new Date().toISOString().slice(0,10),widths,true);
}
function exportMatch(format) {
  var allApps=(typeof applications!=='undefined'?applications:[]);
  var search=(document.getElementById('match_search')||{}).value||'';
  var fTier=(document.getElementById('match_filter_tier')||{}).value||'';
  var fStatus=(document.getElementById('match_filter_status')||{}).value||'';
  var rows=allApps.filter(function(a){
    if(a.status===APP_STATUS.DRAFT||a.status===APP_STATUS.ARCHIVED) return false;
    if(fTier&&a.tier!==fTier) return false;
    if(fStatus&&a.status!==fStatus) return false;
    if(search){var name=((a.fn||'')+' '+(a.ln||'')).toLowerCase();if(!name.includes(search.toLowerCase())&&!(a.id||'').toLowerCase().includes(search.toLowerCase())) return false;}
    return true;
  });
  var headers=['App ID','Name','Score','Tier','Status','Classification','Band Member','Reserve','Bedrooms Needed','Accessibility','Arrears'];
  var data=rows.map(function(a){return[a.id,(a.fn||'')+' '+(a.ln||''),a.score||0,a.tier||'',a.status,a.classification||'',a.band?'Yes':'No',a.reserve||'',a.bedNeed||'',(a.accessibility?'Yes':'No'),(a.hasArrears?'Yes':'No')];});
  var _ns3=nationShort();
  _doExport(format,headers,data,_ns3+'_Match_'+new Date().toISOString().slice(0,10),[16,22,10,16,14,20,12,14,14,12,10],true);
}


function g(id)  { const e=document.getElementById(id); return e?e.value:''; }
// Single source for "the units array on this page". Replaces a defensive idiom
// that was copy-pasted ~25x. Returns the live `housingUnits` reference when it
// has entries, else the legacy fallback (empty on pages without unit data).
// Callers that MUTATE the result must use getAllUnits().slice() to keep a copy.
function getAllUnits(){
  return (typeof housingUnits !== 'undefined' && housingUnits && housingUnits.length)
    ? housingUnits
    : (window.HOUSING_UNITS_DATA || []);
}
window.getAllUnits = getAllUnits;
function getDefaultBudget(){
  var obj={fiscalYear:'2025-2026', fncfsDependantAge:17, pools:{}};
  BUDGET_POOLS.forEach(function(p){ obj.pools[p.id]={allocated:0,notes:''}; });
  return obj;
}
function getRenoScoreModel() {
  var model = (typeof DEFAULT_RENO_SCORE_MODEL !== 'undefined') ? DEFAULT_RENO_SCORE_MODEL : [];
  if (!model.length) return [];
  try {
    var saved = (window._appSettings && window._appSettings['reno_score_model']) || null;
    if(!saved) return model.map(function(r){ return Object.assign({},r); });
    return model.map(function(def) {
      var match = saved.find(function(s){ return s.id === def.id; });
      return match ? Object.assign({},def,{pts:match.pts}) : Object.assign({},def);
    });
  } catch(e) { return model.map(function(r){ return Object.assign({},r); }); }
}
function getUnitScoreModel(){
  var saved=loadUnitScoreModel();
  if(!saved)return DEFAULT_UNIT_SCORE_MODEL.map(function(r){return Object.assign({},r);});
  return DEFAULT_UNIT_SCORE_MODEL.map(function(def){
    var match=saved.find(function(s){return s.id===def.id;});
    return match?Object.assign({},def,{pts:match.pts}):Object.assign({},def);
  });
}
function headerExport(format) {
  // Close the v2 header export dropdown after a format is picked.
  var m = document.getElementById('header_export_menu_v2');
  if(m) m.classList.remove('open');
  var view = window._currentExportView;
  if(view==='inventory')   exportInventory(format);
  else if(view==='match')  exportMatch(format);
  else if(view==='renos')  exportRenos(format);
  else if(view==='contractors') exportContractors(format);
  else if(view==='tenants') exportTenants(format);
  else showToast('Nothing to export on this page.', {type:'info'});
}
function initCtAction(action, needsNotes, prefix) {
  prefix = prefix || 'ctap';
  // Stash the prefix on the pending action so confirm/cancel know which
  // notes UI to read from / hide.
  _ctPendingAction = {action:action, needsNotes:needsNotes, prefix:prefix};
  var nw = document.getElementById(prefix + '_notes_wrap');
  var nr = document.getElementById(prefix + '_notes_req');
  var cb = document.getElementById(prefix + '_confirm_btn');
  var actionLabels = {hm_recommended:'Confirm Recommendation',approved:'Confirm Approval',declined:'Confirm Decline',returned:'Confirm Return'};
  if(nw) nw.style.display='block';
  if(nr) nr.textContent = needsNotes?'*':'';
  if(cb) cb.textContent = actionLabels[action]||action;
}
function loadBudgetData(){
  return (window._appSettings && window._appSettings['budget_pools']) || null;
}
function loadUnitScoreModel(){
  return (window._appSettings && window._appSettings['unit_score_model']) || null;
}
async function lookupUser(){
  var emailEl = document.getElementById('user_lookup_email');
  var email = emailEl ? emailEl.value.trim().toLowerCase() : '';
  var resultEl = document.getElementById('user_lookup_result');
  if(!resultEl) return;
  if(!email){ resultEl.style.display='none'; return; }
  // No domain configured for this nation -> no domain gate (not "everyone is
  // external"). Never substitute another nation's domain here (OCAP).
  var _lkDom = nationEmailDomain();
  var _isExternal = _lkDom ? !email.endsWith('@' + _lkDom) : false;
  // External (non-nation-domain) emails are allowed ONLY for the ED, and only as
  // external consultants (passwordless magic-link, restricted). This keeps the
  // domain gate intact for regular staff while enabling a consultant to use
  // their own email.
  var _canExternal = (typeof APPROVAL_AUTHORITY !== 'undefined') && APPROVAL_AUTHORITY.can('manageAllStaffRoles', window.currentRole);
  if(_isExternal && !_canExternal){
    resultEl.style.display='block';
    resultEl.innerHTML='<div style="padding:10px 14px;background:var(--danger-bg);border:1px solid var(--danger-border);border-radius:8px;font-size:12px;color:var(--danger);">External (non-' + _lkDom + ') emails can only be added by the Executive Director, as an external consultant.</div>';
    return;
  }
  resultEl.innerHTML='<div style="padding:10px;font-size:12px;color:var(--muted);">Searching…</div>';
  resultEl.style.display='block';
  try {
    var r = await fetch(SUPABASE_URL+'/rest/v1/staff?select=*&email=eq.'+encodeURIComponent(email),{headers:HOUSING_HEADERS});
    var rows = await r.json();
    if(rows&&rows.length){
      var u=rows[0];
      var housingRole=sbMapRole(u);
      resultEl.innerHTML='<div style="display:flex;align-items:center;justify-content:space-between;padding:12px 14px;background:var(--warn-amber-bg);border:1px solid var(--yellow-mid);border-radius:8px;">'
        +'<div><div class="js-txt-bold">'+u.name+'</div>'
        +'<div class="js-lbl-sm">'+email+' &middot; '+u.department+' &middot; <strong>'+housingRole+'</strong></div></div>'
        +'<span style="font-size:11px;color:var(--warn-amber);font-weight:600;">Already registered</span>'
        +'</div>';
    } else {
      window._pendingLookupUser = {email:email, external:_isExternal};
      resultEl.innerHTML='<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 14px;background:var(--bg);border:1px solid var(--border);border-radius:8px;">'
        +'<div class="js-txt-muted">'+email+' — not yet in staff directory'
        + (_isExternal ? '<div style="font-size:11px;color:var(--warn-amber);margin-top:3px;">External email — will be added as an external consultant: passwordless (magic-link) sign-in, restricted access.</div>' : '')
        +'</div>'
        +'<button onclick="showAddHousingStaff()" class="btn btn-primary empty-sub">Add Staff Member</button>'
        +'</div>';
    }
  } catch(e){
    resultEl.innerHTML='<div style="padding:10px;font-size:12px;color:var(--danger);">Error: '+e.message+'</div>';
  }
}
function openAddContractorModal(editIdx){
  // Mount the modal on demand. contractors.html ships only a host div now
  // (the full markup lives in the single _buildAddContractorModalHTML builder),
  // and sub-pages never had it — _ensureAddContractorModal is idempotent.
  if (typeof _ensureAddContractorModal === 'function') _ensureAddContractorModal();
  window._ctEditIdx = (editIdx !== undefined) ? editIdx : -1;
  window._ctLastSaved = null;
  window._ctFiles={wsib:[],insurance:[],other:[]};
  // Reset the hero title to the new-contractor default; edit mode sets it to
  // the company name below.
  var _ctTitle0 = document.getElementById('ct_modal_title');
  if (_ctTitle0) _ctTitle0.textContent = 'New Contractor';
  // Approval index gates the Approve/Decline pill handlers. Reset on every
  // open — edit mode will re-set it below.
  _ctApprovalIdx = -1;
  _ctPendingAction = null;
  // Print/Email buttons (both footer and modal header) are hidden until
  // edit mode confirms we have a saved contractor to print.
  ['ct_print_btn','ct_email_btn','ct_header_print_btn','ct_header_email_btn'].forEach(function(id){var e=document.getElementById(id);if(e)e.style.display='none';});
  // Hide the inline CIC approval surface by default — only shown in edit
  // mode below. The Approval Flow + Forms & SOWs cards were dropped from
  // the CIC entirely (internal-only flow now), so only the inline action
  // pills / status banner / notes wrap remain.
  var cas = document.getElementById('cic_approval_surface');
  if (cas) cas.style.display = 'none';
  var cicNotesWrap=document.getElementById('cic_notes_wrap'); if(cicNotesWrap) cicNotesWrap.style.display='none';
  // Reset visited-tab tracking. The gate applies to:
  //   • new contractors (no _ctEditIdx)
  //   • re-opened drafts (still being authored)
  //   • returned contractors (needs fixes before resubmit)
  // For contractors past those states (pending_review / hm_recommended /
  // approved / declined), pre-fill every tab as visited so the button
  // sits in "Save Changes" edit mode and the user can touch up fields
  // without re-walking the form.
  window._cicVisitedTabs = new Set();
  if ((typeof window._ctEditIdx === 'number') && window._ctEditIdx >= 0) {
    var _ctList = window._contractors || [];
    var _ctRow  = _ctList[window._ctEditIdx];
    var _status = (_ctRow && _ctRow.status) || '';
    if (_status && _status !== 'draft' && _status !== 'returned') {
      _CIC_TAB_NAMES.forEach(function(t){ window._cicVisitedTabs.add(t); });
    }
  }
  if (typeof setCicTab === 'function') setCicTab('overview');
  ['ct_name','ct_trade','ct_phone','ct_email','ct_notes','ct_address','ct_hst',
   'ct_wsib_num','ct_wsib_expiry','ct_ins_provider','ct_ins_policy','ct_ins_amount','ct_ins_expiry',
   'ct_class_proof','ct_sig_staff_name','ct_sig_staff_date','ct_sig_ct_name','ct_sig_ct_title','ct_sig_ct_date'
  ].forEach(function(id){var el=document.getElementById(id);if(el)el.value='';});
  ['ct_wsib_preview','ct_insurance_preview','ct_other_preview'].forEach(function(id){
    var el=document.getElementById(id);if(el)el.innerHTML='';
  });
  // Reset classification
  document.querySelectorAll('input[name="ct_classification"]').forEach(function(r){r.checked=false;});
  ctUpdateClassBorders();
  var torAgreed=document.getElementById('ct_tor_agreed'); if(torAgreed)torAgreed.checked=false;
  // Reset sig canvases
  ['ct_sig_canvas_staff','ct_sig_canvas_ct'].forEach(function(id){clearSig(id);});
  ctRenderPeople([]);
  // Init sig pads after modal is visible
  setTimeout(function(){
    ['ct_sig_canvas_staff','ct_sig_canvas_ct'].forEach(_initSigPad);
  }, 80);
  // Pre-fill if editing
  if(window._ctEditIdx >= 0) {
    var contractors = window._contractors || [];
    var ct = contractors[window._ctEditIdx];
    if(ct) {
      var set = function(id,v){ var el=document.getElementById(id); if(el) el.value=v||''; };
      set('ct_name', ct.name); set('ct_trade', ct.trade); set('ct_phone', ct.phone ? formatPhone(ct.phone) : '');
      set('ct_email', ct.email); set('ct_notes', ct.notes); set('ct_address', ct.address);
      set('ct_hst', ct.hst); set('ct_wsib_num', ct.wsibNum); set('ct_wsib_expiry', ct.wsibExpiry);
      set('ct_ins_provider', ct.insProvider); set('ct_ins_policy', ct.insPolicy);
      set('ct_ins_amount', ct.insAmount); set('ct_ins_expiry', ct.insExpiry);
      // New fields
      if(ct.classification){ var r=document.querySelector('input[name="ct_classification"][value="'+ct.classification+'"]'); if(r){r.checked=true;} ctUpdateClassBorders(); }
      set('ct_class_proof', ct.classProof);
      set('ct_sig_staff_name', ct.sigStaff && ct.sigStaff.name);
      set('ct_sig_staff_date', ct.sigStaff && ct.sigStaff.date);
      set('ct_sig_ct_name',  ct.sigCt && ct.sigCt.name);
      set('ct_sig_ct_title', ct.sigCt && ct.sigCt.title);
      set('ct_sig_ct_date',  ct.sigCt && ct.sigCt.date);
      var torEl=document.getElementById('ct_tor_agreed'); if(torEl)torEl.checked=!!ct.torAgreed;
      setTimeout(function(){
        ['ct_sig_canvas_staff','ct_sig_canvas_ct'].forEach(_initSigPad);
        // _restoreSignature handles draw/typed/wet (not just canvas images).
        if(ct.sigStaff && ct.sigStaff.image) _restoreSignature('ct_sig_canvas_staff', ct.sigStaff.image);
        if(ct.sigCt    && ct.sigCt.image)    _restoreSignature('ct_sig_canvas_ct',    ct.sigCt.image);
      }, 80);
      ctRenderPeople(ct.people || []);
      // Hydrate previously-uploaded files so they show in the WSIB / Insurance
      // / Other tiles. Without this, the user thinks attachments were lost and
      // re-uploads, creating duplicate blobs in storage.
      if(ct.id && typeof _loadCtFilesFromStorage === 'function') _loadCtFilesFromStorage(ct.id);
    }
    // Update modal title — the Save button label is owned by
    // _updateCicSaveButtonState (Save Changes / Save Draft / Submit
    // Contractor) so we no longer set it here.
    var title = document.getElementById('ct_modal_title');
    if(title) title.textContent = (ct && ct.name) ? ct.name : 'Contractor Information';
    // Wire the unified CIC: status banner + action pills + flow + Forms&SOWs.
    // _ctApprovalIdx is what initCtAction / confirmCtAction key off of;
    // _ctLastSaved lets Print render the current record without a fresh save.
    if(ct) {
      _ctApprovalIdx = window._ctEditIdx;
      window._ctLastSaved = ct;
      // Reveal the inline approval surface (banner + pills + notes).
      // The Approval Flow diagram and Forms & SOWs cards are gone from
      // the modal — those concerns moved to internal-only views.
      var cas = document.getElementById('cic_approval_surface');
      if (cas) cas.style.display = '';
      if(typeof _ctSetCicStatusBanner === 'function') _ctSetCicStatusBanner(ct);
      if(typeof _ctRenderActions === 'function')      _ctRenderActions(ct, 'cic');
      // Show header Print (always) and Email (only when contractor has an
      // email on file). Footer copies stay hidden — header buttons are the
      // canonical surface now.
      var hp=document.getElementById('ct_header_print_btn'); if(hp){ hp.classList.remove('hidden'); hp.style.display=''; }
      var he=document.getElementById('ct_header_email_btn'); if(he && ct.email){ he.classList.remove('hidden'); he.style.display=''; }
    }
  } else {
    var title = document.getElementById('ct_modal_title');
    if(title) title.textContent = 'New Contractor';
    // Save button label is owned by _updateCicSaveButtonState (currently
    // "💾 Save Draft" until all tabs are visited, then "📤 Submit Contractor").
  }
  var acm=document.getElementById('addContractorModal');
  if(acm) acm.style.display = 'flex';
  // Refresh the glance strip now that every field is populated (setCicTab ran
  // before the edit-mode fill above), pre-render the Notes tab for the current
  // contractor, and wire the scroll-collapse shrink on the info strip (mirrors
  // the TIC / Edit Unit / SOW modals).
  if (typeof _cicRefreshStrip === 'function') _cicRefreshStrip();
  if (typeof cicRenderNotes === 'function') cicRenderNotes(window._ctLastSaved && window._ctLastSaved.id);
  if (acm && typeof _initScrollCollapse === 'function') {
    var _cicBody = acm.querySelector('.tic-body'), _cicStrip = acm.querySelector('.tic-strip');
    if (_cicBody && _cicStrip) _initScrollCollapse(_cicBody, _cicStrip);
  }
}
function openCtApprovalPanel(idx) {
  var contractors = window._contractors || [];
  var ct = contractors[idx];
  if(!ct) return;
  _ctApprovalIdx = idx;
  // Make this contractor the "current" one so printContractorAgreement() and
  // any other shared helpers that fall back to _ctLastSaved get the right data.
  window._ctLastSaved = ct;

  var classLabels = {internal_indigenous:'Internal — Indigenous',external_indigenous:'External — Indigenous',external_non_indigenous:'External — Non-Indigenous'};
  var setT = function(id,v){ var el=document.getElementById(id); if(el) el.textContent=v||'—'; };

  setT('ctap_name',  ct.name);
  setT('ctap_trade', ct.trade);
  setT('ctap_phone', ct.phone ? formatPhone(ct.phone) : '');
  setT('ctap_email', ct.email);
  setT('ctap_class', classLabels[ct.classification]||ct.classification||'Not specified');
  setT('ctap_hst',   ct.hst);
  setT('ctap_wsib',  ct.wsibNum ? ct.wsibNum + (ct.wsibExpiry?' · Exp '+ct.wsibExpiry:'') : '—');
  setT('ctap_ins',   ct.insExpiry||'—');
  setT('ctap_tor',   ct.torAgreed ? 'Yes — '+( ct.torAgreedAt||'on file') : 'Not agreed');
  setT('ctap_submitted', ct.submittedAt||'—');

  // Status banner
  var ss = contractorStatusBadge(ct.status||'pending_review') || {bg:'#f4f4f0',c:'var(--gray)',label:ct.status};
  var banner = document.getElementById('ctap_status_banner');
  if(banner){ banner.textContent=ss.label; banner.style.background=ss.bg; banner.style.color=ss.c; }

  // Render approval flow diagram
  _ctRenderFlow(ct.status||'pending_review', ct);

  // Render action buttons
  _ctRenderActions(ct);

  // Reset notes area
  var nw = document.getElementById('ctap_notes_wrap');
  if(nw) nw.style.display='none';
  var ni = document.getElementById('ctap_notes');
  if(ni) ni.value='';
  _ctPendingAction = null;

  // Render audit trail
  _ctRenderFormsSows(ct.id);

  // Show panel
  var panel = document.getElementById('ctApprovalPanel');
  if(panel) panel.style.display = 'flex';
}
function populateSettings(){
  // Populate HM budget limit
  var limitEl = document.getElementById('settings_hm_budget_limit');
  if(limitEl) {
    var s = window._appSettings || {};
    limitEl.value = s.hmBudgetLimit || 25000;
  }
  var settings = window._appSettings || {};
  // Load user table from Supabase
  renderHousingUserTable();
  // Show and render the scoring model section
  var sms = document.getElementById('scoring_model_section');
  if(sms) sms.style.display = 'block';
  // V2 scoring editor — gated by editScoreModel authority
  if (APPROVAL_AUTHORITY.can('editScoreModel', window.currentRole)) {
    renderV2ScoringEditor();
  } else {
    var wrap = document.getElementById('scoring_model_table_wrap');
    if (wrap) wrap.innerHTML = '<div class="empty-state-italic">Scoring model configuration is only available to the Executive Director.</div>';
  }
}
function populateSow(data){
  var set=function(id,v){ var el=document.getElementById(id); if(el) el.value=v||''; };
  set('sow_address',data.address); set('sow_date',data.date); set('sow_prepared_by',data.preparedBy);
  set('sow_po_number', data.poNumber);
  set('sow_tenant_name',data.tenantName);
  set('sow_contractor',data.contractor); set('sow_condition',data.condition);
  set('sow_fund_source', data.fundSource);
  var sowHid = document.getElementById('sow_contractor_id'); if(sowHid) sowHid.value = data.contractorId||'';
  set('sow_total_cost',data.totalCost); set('sow_start_date',data.startDate);
  set('sow_end_date',data.endDate); set('sow_notes',data.notes);
  set('sow_hm_name',data.hmName); set('sow_hm_date',data.hmDate);
  set('sow_ed_name',data.edName); set('sow_ed_date',data.edDate);
  // Restore signatures
  if(data.tenantSig) {
    set('sow_sig_tenant_name', data.tenantSig.name);
    set('sow_sig_tenant_date', data.tenantSig.date);
    // Use _restoreSignature (not _restoreSigCanvas) so TYPED and WET signatures
    // restore too — and the pad lands on the right tab, so re-saving from the
    // review step doesn't overwrite the stored signature with '' (getSigDataURL
    // reads the visible panel).
    setTimeout(function(){ _restoreSignature('sow_sig_canvas_tenant', data.tenantSig.image); }, 150);
  }
  if(data.staffSig) {
    set('sow_sig_staff_name', data.staffSig.name);
    set('sow_sig_staff_date', data.staffSig.date);
    setTimeout(function(){ _restoreSignature('sow_sig_canvas_staff', data.staffSig.image); }, 150);
  }
  // Restore attached files — render via housing-modals.js helper
  window._sowFiles = (data.files || []).slice();
  if (typeof renderSowFiles === 'function') renderSowFiles();
  var chk=function(id,v){ var el=document.getElementById(id); if(el) el.checked=!!v; };
  chk('sow_mold',data.mold); chk('sow_asbestos',data.asbestos);
  chk('sow_electrical',data.electrical); chk('sow_structural',data.structural);
  chk('sow_plumbing',data.plumbing); chk('sow_fire',data.fire);
  chk('sow_rent_arrears',data.rentArrears); chk('sow_tenant_damage',data.tenantDamage);
  chk('sow_negligence',data.negligence); chk('sow_vandalism',data.vandalism);
  chk('sow_police_report',data.policeReport);
  set('sow_accountability_notes', data.accountabilityNotes);
  var cont=document.getElementById('sow_items'); if(cont) cont.innerHTML='';
  _sowItemIdx=0;
  if(data.items && data.items.length) { data.items.forEach(function(item){ addSowItem(item); }); }
  else { addSowItem(); }
  // Work Order (execution) block — fill checklist + measurements/materials/notes.
  if (typeof _sowPopulateWorkOrder === 'function') _sowPopulateWorkOrder(data.workOrder);
}
function printContractorAgreement() {
  // Read live form data — no save required to print
  var ct = window._ctLastSaved || _readContractorFormData();
  var html = _buildContractorAgreementHTML(ct);
  var w = window.open('','_blank','width=900,height=750,toolbar=0,menubar=0');
  if(!w){ showToast('Please allow popups to print', {type:'error'}); return; }
  w.document.open(); w.document.write(html); w.document.close();
  w.onload = function(){ w.focus(); w.print(); };
}

function printWorkOrder(){
  // Persist form edits only when safe — printing an approved/archived request
  // must not re-save it (a non-approver's save strips HM/ED sign-offs and
  // downgrades the status). Falls back to the old unconditional save only if
  // the guard helper isn't loaded on this page.
  if (typeof _sowSafePreprintSave === 'function') _sowSafePreprintSave();
  else saveSOW({ keepOpen: true });   // printing must never close the form under the preview
  var get = function(id){ var el=document.getElementById(id); return el ? el.value.trim() : ''; };
  var items = collectSowItems().filter(function(it){ return it.category||it.description||it.quote||it.cost; });
  var today = new Date().toLocaleDateString('en-CA');
  var address  = get('sow_address');
  var contractor = get('sow_contractor');
  var startDate  = get('sow_start_date');
  var endDate    = get('sow_end_date');
  var preparedBy = get('sow_prepared_by');
  var tenantName = get('sow_tenant_name');
  var _natDisp  = (window.NATION_CONFIG && (NATION_CONFIG.display_name || NATION_CONFIG.name)) || '';
  var _natShort = (window.NATION_CONFIG && NATION_CONFIG.short) || '';
  var esc = (typeof escapeHtml === 'function') ? escapeHtml : function(s){ return String(s==null?'':s); };

  // ── In-house crew work order (printable field checklist) ──────────────────
  // When the request is assigned to the nation's own Housing Department (not a
  // contractor), print a checklist form for the field employee: no pricing, no
  // terms/authorization, plus space to check off items, record measurements,
  // confirm materials, and add notes. Contractor requests fall through to the
  // priced/authorized work order below.
  var _woTeamEl = document.getElementById('sow_assigned_team');
  if (_woTeamEl && _woTeamEl.value === 'in_house') {
    var projNumIH = (window._sowEditingProjectNumber) || '—';
    var assigneeIH = (function(){
      var s = document.getElementById('sow_assigned_to');
      if (!s) return '';
      var o = s.options[s.selectedIndex];
      return (o && o.getAttribute('data-name')) || '';
    })();
    // Captured Work Order (execution) data from the Work Order tab.
    var woIH = (typeof _sowCollectWorkOrder === 'function') ? _sowCollectWorkOrder() : {};
    woIH = woIH || {};
    var woDoneIH = woIH.itemsDone || {};
    var notesIH = woIH.fieldNotes || '';
    var logoSrcIH = '';
    try { var _lg = document.querySelector('.hlogo'); if(_lg && _lg.src) logoSrcIH = _lg.src; } catch(e) {}
    var boxOpen   = '<span style="display:inline-block;width:14px;height:14px;border:1.5px solid #333;border-radius:3px;vertical-align:middle;margin-right:6px;"></span>';
    var boxDone   = '<span style="display:inline-block;width:14px;height:14px;border:1.5px solid #333;border-radius:3px;vertical-align:middle;margin-right:6px;text-align:center;line-height:12px;font-weight:700;">&#10007;</span>';
    var mkbox = function(on){ return on ? boxDone : boxOpen; };
    var blankLines = function(n){ var s=''; for(var i=0;i<n;i++){ s+='<div style="height:22px;border-bottom:1px solid #c9c9c9;"></div>'; } return s; };

    // Use the SAME item filter as the Work Order tab (_sowRenderWorkOrderItems)
    // so the done-state indices in woDoneIH line up with the rows printed here.
    var woItemsIH = items.filter(function(it){ return it.category || it.description; });
    var checklistRows = woItemsIH.length
      ? woItemsIH.map(function(it,i){
          var doneCell = woDoneIH[i]
            ? '<span style="display:inline-block;width:16px;height:16px;border:1.5px solid #333;border-radius:3px;text-align:center;line-height:14px;font-weight:700;">&#10007;</span>'
            : '<span style="display:inline-block;width:16px;height:16px;border:1.5px solid #333;border-radius:3px;"></span>';
          return '<tr style="'+(i%2===1?'background:var(--bg);':'')+'">'
            +'<td style="padding:9px 10px;border-bottom:1px solid var(--border);width:34px;text-align:center;">'+doneCell+'</td>'
            +'<td style="padding:9px 10px;border-bottom:1px solid var(--border);font-size:10px;color:var(--text);width:150px;'+(woDoneIH[i]?'font-weight:700;':'')+'">'+esc(it.category||'—')+'</td>'
            +'<td style="padding:9px 10px;border-bottom:1px solid var(--border);font-size:10px;color:var(--text);'+(woDoneIH[i]?'font-weight:700;':'')+'">'+esc(it.description||'—')+'</td>'
            +'</tr>';
        }).join('')
      : '<tr><td colspan="3" style="padding:10px;font-size:10px;color:var(--muted);font-style:italic;">No line items - describe the work in the Notes section below.</td></tr>';

    var htmlIH = '<!DOCTYPE html><html lang="en"><head>'
      +'<meta charset="UTF-8"/>'
      +'<title>Work Order - '+esc(_natShort)+' Housing</title>'
      +'<style>'
      +_printThemeStyles()
      +'*{box-sizing:border-box;margin:0;padding:0;}'
      +'body{font-family:Georgia,serif;font-size:11px;color:var(--text);background:var(--surface);}'
      +'@page{size:letter portrait;margin:15mm 15mm 18mm 15mm;}'
      +'@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact;}.no-print{display:none!important;}}'
      +'.header{background:var(--dark);color:#fff;padding:14px 20px;display:flex;align-items:center;justify-content:space-between;}'
      +'.org{font-size:13px;font-weight:bold;color:'+window._themeAccentInkHex()+';}'
      +'.dept{font-size:10px;color:var(--txt-on-dark);margin-top:2px;}'
      +'.doc-type{font-size:18px;font-weight:bold;color:'+window._themeAccentInkHex()+';letter-spacing:.05em;}'
      +'.doc-sub{font-size:9px;color:var(--muted);margin-top:3px;}'
      +'.yellow-bar{background:'+window._themeAccentHex()+';height:4px;}'
      +'.section-title{font-size:9px;font-weight:bold;text-transform:uppercase;letter-spacing:.08em;color:#fff;background:var(--dark);padding:5px 10px;margin-top:16px;}'
      +'.section-body{border:1px solid var(--border);border-top:none;padding:12px 14px;}'
      +'.grid-2{display:grid;grid-template-columns:1fr 1fr;gap:10px 24px;}'
      +'.field label{display:block;font-size:8px;font-weight:bold;text-transform:uppercase;letter-spacing:.06em;color:#666;margin-bottom:3px;}'
      +'.field span{display:block;font-size:11px;color:var(--text);border-bottom:1px solid #e0e0e0;padding-bottom:3px;min-height:15px;}'
      +'table{width:100%;border-collapse:collapse;}'
      +'th{background:var(--dark);color:var(--yellow);padding:7px 10px;text-align:left;font-size:9px;font-weight:bold;text-transform:uppercase;letter-spacing:.05em;}'
      +'.chk-line{font-size:10px;color:var(--text);margin:6px 0;display:flex;align-items:center;gap:18px;flex-wrap:wrap;}'
      +'.sig-grid{display:grid;grid-template-columns:1fr 1fr;gap:32px;margin-top:8px;}'
      +'.sig-box .role{font-size:8px;font-weight:bold;text-transform:uppercase;letter-spacing:.05em;color:#666;margin-bottom:6px;}'
      +'.sig-box .sig-line{height:48px;border-bottom:1.5px solid #333;margin-bottom:5px;}'
      +'.sig-box .sig-label{font-size:9px;color:var(--muted);}'
      +'.footer{margin-top:20px;border-top:3px solid '+window._themeAccentHex()+';padding-top:8px;display:flex;justify-content:space-between;font-size:8.5px;color:#666;}'
      +'</style></head><body>'
      // Header
      +'<div class="header">'
        +'<div style="display:flex;align-items:center;gap:14px;">'
          +(logoSrcIH?'<img src="'+logoSrcIH+'" style="height:44px;width:auto;" alt="'+esc(_natShort)+'"/>':'')
          +'<div><div class="org">'+esc(_natDisp)+'</div><div class="dept">Housing Department</div></div>'
        +'</div>'
        +'<div style="text-align:right;"><div class="doc-type">WORK ORDER</div><div class="doc-sub">'+esc(projNumIH)+' &middot; '+today+'</div></div>'
      +'</div>'
      +'<div class="yellow-bar"></div>'
      // Project info
      +'<div class="section-title">Project Information</div>'
      +'<div class="section-body">'
        +'<div class="grid-2">'
          +'<div class="field"><label>Unit Address</label><span>'+esc(address||'—')+'</span></div>'
          +'<div class="field"><label>Tenant</label><span>'+esc(tenantName||'—')+'</span></div>'
          +'<div class="field"><label>Tenant Phone</label><span>'+esc(get('sow_tenant_phone')||'—')+'</span></div>'
          +'<div class="field"><label>Assigned To</label><span>'+esc(assigneeIH||_natShort+' Housing Department')+'</span></div>'
          +'<div class="field"><label>Issued By</label><span>'+esc(preparedBy||'—')+'</span></div>'
          +'<div class="field"><label>Start Date</label><span>'+esc(startDate||'—')+'</span></div>'
          +'<div class="field"><label>Target Completion</label><span>'+esc(endDate||'—')+'</span></div>'
        +'</div>'
      +'</div>'
      // Work checklist
      +'<div class="section-title">Work Checklist</div>'
      +'<table><thead><tr>'
        +'<th style="width:34px;">Done</th><th style="width:150px;">Category</th><th>Description of Work</th>'
      +'</tr></thead><tbody>'
      +checklistRows
      +'</tbody></table>'
      // Measurements
      +'<div class="section-title">Measurements</div>'
      +'<div class="section-body">'
        +(woIH.measurements
            ? '<div style="font-size:10px;color:var(--text);white-space:pre-wrap;">'+esc(woIH.measurements)+'</div>'
            : '<div style="font-size:9px;color:#666;margin-bottom:8px;">Record measurements taken on site (rooms, openings, materials).</div>'+blankLines(4))
      +'</div>'
      // Materials
      +'<div class="section-title">Materials</div>'
      +'<div class="section-body">'
        +'<div class="chk-line"><span>Materials required?</span><span>'+mkbox(woIH.materialsRequired)+'Yes</span><span>'+mkbox(false)+'No</span></div>'
        +'<div class="chk-line"><span>Materials ordered?</span><span>'+mkbox(woIH.materialsOrdered)+'Yes</span><span>'+mkbox(false)+'No</span><span>'+mkbox(false)+'N/A</span></div>'
        +(woIH.materialsList
            ? '<div style="font-size:10px;color:var(--text);white-space:pre-wrap;margin-top:8px;">'+esc(woIH.materialsList)+'</div>'
            : '<div style="font-size:9px;color:#666;margin:10px 0 6px;">List materials needed / ordered and the order date:</div>'+blankLines(3))
      +'</div>'
      // Field employee notes
      +'<div class="section-title">Field Employee Notes</div>'
      +'<div class="section-body">'
        +(notesIH?'<div style="font-size:10px;color:var(--text);white-space:pre-wrap;margin-bottom:8px;">'+esc(notesIH)+'</div>':'')
        +blankLines(notesIH?2:4)
      +'</div>'
      // Completion sign-off (no terms/authorization for in-house crew)
      +'<div class="section-title">Completion Sign-Off</div>'
      +'<div class="section-body">'
        +'<div class="sig-grid">'
          +'<div class="sig-box"><div class="role">Field Employee</div><div class="sig-line"></div><div class="sig-label">Signature &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; Date: ____________</div><div style="margin-top:8px;font-size:9px;color:var(--muted);">Print name: ____________________________</div></div>'
          +'<div class="sig-box"><div class="role">'+esc(_natShort)+' Housing - Supervisor</div><div class="sig-line"></div><div class="sig-label">Signature &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; Date: ____________</div><div style="margin-top:8px;font-size:9px;color:var(--muted);">Print name: ____________________________</div></div>'
        +'</div>'
      +'</div>'
      +'<div class="footer"><span>'+escapeHtml(buildNationFooterStrip({ suffix: "Work Order", includeConfidential: false }))+'</span><span>Generated: '+today+'</span></div>'
      +'</body></html>';

    // Show in the in-app print panel (Print / Close) — same as the Tenant form
    // button — instead of a popup that auto-fires window.print() (which caused a
    // blank page + "connecting to printer" retry loop).
    showPrintPanel(htmlIH, 'Work Order');
    // Offer to email the work order (contractor or in-house employee + HM).
    if (typeof _sowPromptWorkOrderEmail === 'function') _sowPromptWorkOrderEmail();
    return;
  }

  // Quote total — use contractor quote if available, else blank
  var quoteTotal = 0;
  var hasQuotes = false;
  items.forEach(function(it){
    if(it.quote && parseFloat(it.quote) > 0) {
      quoteTotal += parseFloat(it.quote);
      hasQuotes = true;
    }
  });

  // Get logo
  var logoSrc = '';
  try {
    var logoImg = document.querySelector('.hlogo');
    if(logoImg && logoImg.src) logoSrc = logoImg.src;
  } catch(e) {}

  var itemRows = items.map(function(it, i){
    var quote = (it.quote && parseFloat(it.quote) > 0)
      ? formatCurrency(parseFloat(it.quote)||0)
      : '<span style="color:var(--muted);">Pending</span>';
    return '<tr style="'+(i%2===1?'background:var(--bg);':'')+'">'
      +'<td style="padding:8px 10px;border-bottom:1px solid var(--border);font-size:10px;color:var(--text);width:140px;">'+( it.category||'—')+'</td>'
      +'<td style="padding:8px 10px;border-bottom:1px solid var(--border);font-size:10px;color:var(--text);">'+(it.description||'—')+'</td>'
      +'<td style="padding:8px 10px;border-bottom:1px solid var(--border);font-size:11px;text-align:right;font-weight:600;color:var(--text);width:110px;">'+quote+'</td>'
      +'</tr>';
  }).join('');

  var totalRow = hasQuotes
    ? '<tr class="total-row"><td colspan="2" style="text-align:right;padding:9px 10px;font-size:10px;font-weight:bold;text-transform:uppercase;letter-spacing:.04em;">Total Quoted Amount</td><td style="text-align:right;padding:9px 10px;font-size:12px;font-weight:bold;">'+formatCurrency(quoteTotal)+'</td></tr>'
    : '<tr><td colspan="3" style="padding:9px 10px;font-size:10px;color:var(--muted);font-style:italic;">Pricing to be confirmed by contractor</td></tr>';

  var html = '<!DOCTYPE html><html lang="en"><head>'
    +'<meta charset="UTF-8"/>'
    +'<title>Work Order — '+_natShort+' Housing</title>'
    +'<style>'
    +_printThemeStyles()
    +'*{box-sizing:border-box;margin:0;padding:0;}'
    +'body{font-family:Georgia,serif;font-size:11px;color:var(--text);background:var(--surface);}'
    +'@page{size:letter portrait;margin:15mm 15mm 18mm 15mm;}'
    +'@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact;}.no-print{display:none!important;}}'
    +'.header{background:var(--dark);color:#fff;padding:14px 20px;display:flex;align-items:center;justify-content:space-between;}'
    +'.org{font-size:13px;font-weight:bold;color:'+window._themeAccentInkHex()+';}'
    +'.dept{font-size:10px;color:var(--txt-on-dark);margin-top:2px;}'
    +'.doc-type{font-size:18px;font-weight:bold;color:'+window._themeAccentInkHex()+';letter-spacing:.05em;}'
    +'.doc-sub{font-size:9px;color:var(--muted);margin-top:3px;}'
    +'.yellow-bar{background:'+window._themeAccentHex()+';height:4px;}'
    +'.section-title{font-size:9px;font-weight:bold;text-transform:uppercase;letter-spacing:.08em;color:#fff;background:var(--dark);padding:5px 10px;}'
    +'.section-body{border:1px solid var(--border);border-top:none;padding:12px 14px;}'
    +'.grid-2{display:grid;grid-template-columns:1fr 1fr;gap:10px 24px;}'
    +'.field label{display:block;font-size:8px;font-weight:bold;text-transform:uppercase;letter-spacing:.06em;color:#666;margin-bottom:3px;}'
    +'.field span{display:block;font-size:11px;color:var(--text);border-bottom:1px solid #e0e0e0;padding-bottom:3px;min-height:15px;}'
    +'table{width:100%;border-collapse:collapse;}'
    +'th{background:var(--dark);color:var(--yellow);padding:7px 10px;text-align:left;font-size:9px;font-weight:bold;text-transform:uppercase;letter-spacing:.05em;}'
    +'th.r{text-align:right;}'
    +'.total-row td{background:'+window._themeAccentHex()+';color:#000;font-weight:bold;padding:9px 10px;}'
    +'.notice{background:#fffbeb;border:1px solid #fde68a;border-radius:4px;padding:10px 14px;font-size:10px;color:#7a6000;margin-top:16px;line-height:1.6;}'
    +'.sig-grid{display:grid;grid-template-columns:1fr 1fr;gap:32px;margin-top:8px;}'
    +'.sig-box .role{font-size:8px;font-weight:bold;text-transform:uppercase;letter-spacing:.05em;color:#666;margin-bottom:6px;}'
    +'.sig-box .sig-line{height:48px;border-bottom:1.5px solid #333;margin-bottom:5px;}'
    +'.sig-box .sig-label{font-size:9px;color:var(--muted);}'
    +'.footer{margin-top:20px;border-top:3px solid '+window._themeAccentHex()+';padding-top:8px;display:flex;justify-content:space-between;font-size:8.5px;color:#666;}'
    +'</style></head><body>'
    // Header
    +'<div class="header">'
      +'<div style="display:flex;align-items:center;gap:14px;">'
        +(logoSrc?'<img src="'+logoSrc+'" style="height:44px;width:auto;" alt="'+_natShort+'"/>':'')
        +'<div><div class="org">'+_natDisp+'</div><div class="dept">Housing Department</div></div>'
      +'</div>'
      +'<div style="text-align:right;"><div class="doc-type">WORK ORDER</div><div class="doc-sub">Date: '+today+'</div></div>'
    +'</div>'
    +'<div class="yellow-bar"></div>'
    // Project info
    +'<div style="margin-top:16px;">'
    +'<div class="section-title">Project Information</div>'
    +'<div class="section-body">'
      +'<div class="grid-2" style="margin-bottom:10px;">'
        +'<div class="field"><label>Unit Address</label><span>'+esc(address||'—')+'</span></div>'
        +'<div class="field"><label>Tenant</label><span>'+esc(tenantName||'—')+'</span></div>'
        +'<div class="field"><label>Tenant Phone</label><span>'+esc(get('sow_tenant_phone')||'—')+'</span></div>'
        +'<div class="field"><label>Contractor</label><span>'+esc(contractor||'—')+'</span></div>'
        +'<div class="field"><label>Issued By</label><span>'+esc(preparedBy||'—')+'</span></div>'
        +'<div class="field"><label>Start Date</label><span>'+(startDate||'—')+'</span></div>'
        +'<div class="field"><label>Completion Date</label><span>'+(endDate||'—')+'</span></div>'
      +'</div>'
    +'</div>'
    // Scope items
    +'<div style="margin-top:16px;">'
    +'<div class="section-title">Maintenance Request</div>'
    +'<table><thead><tr>'
      +'<th>Category</th><th>Description of Work</th><th class="r">Quoted Price</th>'
    +'</tr></thead><tbody>'
    +itemRows
    +totalRow
    +'</tbody></table>'
    +'</div>'
    // Terms notice — rendered from Settings → Terms & Conditions (ED-editable).
    +(function(){
      var _tp = (typeof _termsParseHtml === 'function' && typeof getTermsBody === 'function')
              ? _termsParseHtml(getTermsBody('work_order'))
              : { introHtml: '', itemsHtml: [] };
      var body = '';
      if (_tp.introHtml) body += '<p style="margin:0 0 6px;">' + _tp.introHtml + '</p>';
      if (_tp.itemsHtml.length) {
        body += '<ol style="margin:0;padding-left:16px;">'
             + _tp.itemsHtml.map(function(h){ return '<li>' + h + '</li>'; }).join('')
             + '</ol>';
      }
      if (!body) {
        body = '<strong>Work Authorization:</strong> The contractor is authorized to perform only the work described above. '
             + 'Any additional work or changes to scope must be approved in writing by the '+_natShort+' '+CLFN_PERMS.roleLabel(ROLE.HOUSING_MANAGER)+' or '+CLFN_PERMS.roleLabel(ROLE.ED)+' before work commences. '
             + 'Invoices must reference this work order and unit address. Payment is subject to satisfactory completion and inspection.';
      }
      return '<div class="notice">' + body + '</div>';
    })()
    // Signatures
    +'<div style="margin-top:24px;">'
    +'<div class="section-title">Authorization</div>'
    +'<div class="section-body">'
      +'<div class="sig-grid">'
        +'<div class="sig-box"><div class="role">Contractor Representative</div><div class="sig-line"></div><div class="sig-label">Signature &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; Date: ____________</div><div style="margin-top:8px;font-size:9px;color:var(--muted);">Print name: ____________________________</div></div>'
        +'<div class="sig-box"><div class="role">'+_natShort+' Housing — Authorized Signatory</div><div class="sig-line"></div><div class="sig-label">Signature &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; Date: ____________</div><div style="margin-top:8px;font-size:9px;color:var(--muted);">Print name: ____________________________</div></div>'
      +'</div>'
    +'</div></div>'
    +'<div class="footer"><span>'+escapeHtml(buildNationFooterStrip({ suffix: "Work Order", includeConfidential: false }))+'</span><span>Generated: '+today+'</span></div>'
    +'</body></html>';

  // In-app print panel (Print / Close) — same as the Tenant form button.
  showPrintPanel(html, 'Work Order');
  // Offer to email the work order to the assigned contractor.
  if (typeof _sowPromptWorkOrderEmail === 'function') _sowPromptWorkOrderEmail();
}
function recalcSowTotal(){
  var total=0;
  document.querySelectorAll('#sow_items [data-sow="cost"]').forEach(function(inp){
    var v=parseFloat((inp.value||'').replace(/[^0-9.]/g,''))||0;
    total+=v;
  });
  var el=document.getElementById('sow_total_cost');
  if(el) el.value = total>0 ? formatCurrency(total) : '';
  if (typeof _sowRefreshStrip === 'function') _sowRefreshStrip();
}
function removeRenoPhoto(idx) {
  window._rpStoredPhotos = window._rpStoredPhotos || [];
  window._rpStoredPhotos.splice(idx, 1);
  var preview = document.getElementById('rp_photo_preview');
  if(preview) {
    preview.innerHTML = window._rpStoredPhotos.map(function(src, i) {
      return '<div style="position:relative;width:80px;height:80px;border-radius:8px;overflow:hidden;border:1px solid var(--border);">'
        +'<img src="'+src+'" class="img-cover"/>'
        +'<button type="button" onclick="removeRenoPhoto('+i+')" class="btn-photo-remove" style="position:absolute;top:3px;right:3px;">✕</button>'
        +'</div>';
    }).join('');
    _renderRpPendingPhotos();
  }
}
function renderBudgetPools(){
  var tbody = document.getElementById('budget_pools_tbody');
  if(!tbody) return;
  var fyEl  = document.getElementById('budget_fiscal_year');
  var ageEl = document.getElementById('budget_fncfs_age');
  var data  = loadBudgetData() || getDefaultBudget();
  if(fyEl)  fyEl.value  = data.fiscalYear       || '2025-2026';
  if(ageEl) ageEl.value = data.fncfsDependantAge != null ? data.fncfsDependantAge : 17;

  var total = 0;
  tbody.innerHTML = BUDGET_POOLS.map(function(p){
    var pool  = data.pools[p.id] || {allocated:0, notes:''};
    var alloc = pool.allocated || 0;
    total += alloc;
    var eligNote = p.requiresDependants
      ? '<div style="font-size:10px;color:var(--muted);margin-top:2px;">Requires dependants under configured age</div>'
      : '';
    return '<tr>'
      +'<td>'
        +'<div style="display:flex;align-items:center;gap:10px;">'
          +'<span style="font-size:18px;flex-shrink:0;">'+p.icon+'</span>'
          +'<div><span style="font-weight:600;font-size:13px;">'+p.label+'</span>'+eligNote+'</div>'
        +'</div>'
      +'</td>'
      +'<td style="text-align:right;">'
        +'<input type="number" id="budget_alloc_'+p.id+'" value="'+alloc+'" min="0" step="1000"'
          +' style="width:140px;text-align:right;padding:6px 10px;border:1px solid var(--border);border-radius:7px;font-size:14px;font-weight:700;background:var(--surface);color:var(--text);"'
          +' oninput="updateBudgetTotal()"/>'
      +'</td>'
      +'<td>'
        +'<input type="text" id="budget_notes_'+p.id+'" value="'+(pool.notes||'').replace(/"/g,'&quot;')+'" placeholder="e.g. approved projects, restrictions…"'
          +' style="width:100%;padding:6px 10px;border:1px solid var(--border);border-radius:7px;font-size:12px;background:var(--surface);color:var(--text);box-sizing:border-box;"/>'
      +'</td>'
      +'</tr>';
  }).join('');

  var gt = document.getElementById('budget_grand_total');
  if(gt) gt.textContent = formatCurrency(total);
}
// ── Contractor row stats ──────────────────────────────────────────────
// Returns the number of SOWs filed against a contractor and the cumulative
// dollar value (sum of totalCost across all SOWs). Used by both the KPI
// strip and the per-row #Jobs / Cumulative $ columns.
//
// Built as ONE pass over _sowCache shared by every caller in the same
// synchronous render burst — the old per-contractor getAllSowsForContractor
// walk made the contractor list O(contractors × SOWs). The memo is dropped on
// the next macrotask (setTimeout 0), so it can never outlive the render that
// built it or go stale after a save.
var _ctStatsMemo = null;
function _ctBuildStatsMap() {
  var map = {};
  var cache = window._sowCache || {};
  Object.keys(cache).forEach(function(unitId){
    var raw = cache[unitId];
    if (!raw) return;
    var sows = Array.isArray(raw.sows) ? raw.sows : [raw];
    sows.forEach(function(s){
      if (!s || !s.contractorId) return;
      var e = map[s.contractorId] || (map[s.contractorId] = { jobCount: 0, totalValue: 0 });
      e.jobCount++;
      e.totalValue += (typeof s.amount === 'number' && !isNaN(s.amount)) ? s.amount
        : parseFloat(String(s.totalCost || '').replace(/[^0-9.\-]/g, '')) || 0;
    });
  });
  return map;
}
function _ctRowStats(ct) {
  var ctId = ct && ct.id;
  if (!ctId) return { jobCount: 0, totalValue: 0 };
  if (!_ctStatsMemo) {
    _ctStatsMemo = _ctBuildStatsMap();
    setTimeout(function(){ _ctStatsMemo = null; }, 0);
  }
  return _ctStatsMemo[ctId] || { jobCount: 0, totalValue: 0 };
}

// ── Contractor KPIs ──────────────────────────────────────────────────
// Aggregates over the whole contractor + SOW set for the page header
// strip. "Top trade" is the trade with the highest job count (computed
// by walking each contractor's SOWs and crediting them to that
// contractor's trade — so a Plumbing contractor's SOWs count toward
// Plumbing regardless of the SOW's own line items).
function _ctComputeKpis() {
  var contractors = (window._contractors || []).filter(function(c){ return c && !c.archived; });
  var byStatus = { approved:0, pending:0 };
  var totalJobs = 0;
  var totalSpend = 0;
  var jobsByTrade = {};
  contractors.forEach(function(ct){
    var st = ct.status || 'pending_review';
    if (st === 'approved') byStatus.approved++;
    else if (st === 'pending_review' || st === 'hm_recommended' || st === 'returned') byStatus.pending++;
    var s = _ctRowStats(ct);
    totalJobs  += s.jobCount;
    totalSpend += s.totalValue;
    var trade = (ct.trade || 'Unspecified').trim() || 'Unspecified';
    jobsByTrade[trade] = (jobsByTrade[trade] || 0) + s.jobCount;
  });
  var topTrade = null;
  Object.keys(jobsByTrade).forEach(function(t){
    if (!topTrade || jobsByTrade[t] > jobsByTrade[topTrade]) topTrade = t;
  });
  return {
    totalContractors: contractors.length,
    approved:         byStatus.approved,
    pending:          byStatus.pending,
    totalJobs:        totalJobs,
    totalSpend:       totalSpend,
    topTrade:         topTrade,
    topTradeJobs:     topTrade ? jobsByTrade[topTrade] : 0
  };
}

// Short relative-expiry label + colour class for WSIB / Insurance dates.
function _ctExpiryCell(dateStr) {
  if (!dateStr) return '<span class="txt-xs-muted">—</span>';
  var d = new Date(dateStr);
  if (isNaN(d.getTime())) return '<span class="txt-xs-muted">'+escapeHtml(dateStr)+'</span>';
  var days = Math.round((d.getTime() - Date.now()) / (24*3600*1000));
  var cls = days < 0 ? 'ct-tag-expired' : days < 30 ? 'ct-tag-expiring' : 'ct-tag-valid';
  var lbl = days < 0 ? 'Expired' : days < 30 ? '<30 days' : 'Valid';
  return '<div class="ct-exp-cell">' +
           '<div class="ct-exp-date">'+escapeHtml(dateStr)+'</div>' +
           '<span class="ct-card-tag '+cls+'">'+lbl+'</span>' +
         '</div>';
}

// Thin wrapper kept for backwards compat — _ctFmtCurrency originally
// rendered $1,234 (no decimals). Now routed through the canonical
// formatCurrency so every dollar value across the app uses the same
// "$###,###.00" style. Callers don't need to change.
function _ctFmtCurrency(n) { return formatCurrency(n); }

// Print a contractor agreement directly from the table row, without
// opening the CIC modal. Sets _ctLastSaved (which printContractorAgreement
// reads), then triggers the print.
function ctPrintFromRow(idx) {
  var contractors = window._contractors || [];
  var ct = contractors[idx];
  if (!ct) { showToast('Contractor not found', {type:'error'}); return; }
  window._ctLastSaved = ct;
  if (typeof printContractorAgreement === 'function') printContractorAgreement();
  else showToast('Print is not available on this page', {type:'error'});
}

// ⋮ menu for a contractor row — HM/ED only. Items intentionally lean:
// Decline + Archive are the two destructive actions that make sense to
// expose without opening the CIC. Approval pills still live inside the
// CIC where the manager can see context before acting.
function ctOpenRowMenu(idx, anchorEl) {
  var role = window.currentRole || 'housing_employee_l1';
  if (typeof ROLE === 'undefined' || !ROLE.isManagement(role)) return;
  var contractors = window._contractors || [];
  var ct = contractors[idx];
  if (!ct) return;

  // Remove any existing menu
  var prev = document.getElementById('_ctRowMenu');
  if (prev) prev.remove();

  var items = [];
  if (ct.status !== 'declined' && ct.status !== 'archived') {
    items.push({ icon: '❌', label: 'Decline Contractor', action: 'decline' });
  }
  if (!ct.archived) {
    items.push({ icon: '📦', label: 'Archive', action: 'archive' });
  } else {
    items.push({ icon: '📤', label: 'Unarchive', action: 'unarchive' });
  }
  if (!items.length) return;

  var menu = document.createElement('div');
  menu.id = '_ctRowMenu';
  menu.className = 'ct-row-menu';
  menu.innerHTML = items.map(function(it){
    return '<button class="ct-row-menu-item" data-act="'+it.action+'">'+
             '<span class="ct-row-menu-icon">'+it.icon+'</span>'+
             '<span>'+it.label+'</span>'+
           '</button>';
  }).join('');
  // Position next to the trigger button
  var rect = anchorEl ? anchorEl.getBoundingClientRect() : { top: 100, right: 100 };
  menu.style.top   = (rect.bottom + 4) + 'px';
  menu.style.right = (window.innerWidth - rect.right) + 'px';
  document.body.appendChild(menu);
  menu.querySelectorAll('[data-act]').forEach(function(btn){
    btn.addEventListener('click', function(ev){
      ev.stopPropagation();
      var act = btn.getAttribute('data-act');
      menu.remove();
      _ctHandleRowAction(act, idx);
    });
  });
  setTimeout(function(){
    document.addEventListener('click', function _close(){ menu.remove(); document.removeEventListener('click', _close); }, { once: true });
  }, 0);
}

function _ctHandleRowAction(action, idx) {
  var contractors = window._contractors || [];
  var ct = contractors[idx];
  if (!ct) return;
  var role = window.currentRole || 'staff';
  if (action === 'archive') {
    showConfirm({
      title: 'Archive this contractor?',
      message: 'It will be hidden from the main list. Existing maintenance requests and audit records are preserved.',
      confirmText: 'Archive',
      danger: true
    }).then(function(ok){
      if (!ok) return;
      ct.archived = true;
      contractors[idx] = ct;
      if (typeof saveContractorWithDraftFallback === 'function') saveContractorWithDraftFallback(ct);
      else if (typeof sbSaveContractor === 'function') sbSaveContractor(ct).catch(function(e){ console.warn('archive failed:', e); });
      auditEntry('CT:'+ct.id, 'ct_archived', 'Contractor archived: ' + (ct.name||''), role);
      showToast('📦 Contractor archived', {type:'info'});
      renderContractorsView();
    });
  } else if (action === 'unarchive') {
    ct.archived = false;
    contractors[idx] = ct;
    if (typeof saveContractorWithDraftFallback === 'function') saveContractorWithDraftFallback(ct);
    else if (typeof sbSaveContractor === 'function') sbSaveContractor(ct).catch(function(e){ console.warn('unarchive failed:', e); });
    auditEntry('CT:'+ct.id, 'ct_unarchived', 'Contractor restored from archive: ' + (ct.name||''), role);
    showToast('📤 Contractor unarchived', {type:'info'});
    renderContractorsView();
  } else if (action === 'decline') {
    showPrompt({
      title:       'Decline contractor',
      message:     'Reason for declining (optional):',
      placeholder: 'e.g. compliance docs incomplete, …',
      confirmText: 'Decline',
      danger:      true,
      multiline:   true
    }).then(function(reason){
      if (reason === null) return;
      ct.status = 'declined';
      ct.declinedAt = new Date().toISOString().split('T')[0];
      ct.declinedBy = role;
      if (reason) ct.declinedReason = reason;
      contractors[idx] = ct;
      if (typeof saveContractorWithDraftFallback === 'function') saveContractorWithDraftFallback(ct);
      else if (typeof sbSaveContractor === 'function') sbSaveContractor(ct).catch(function(e){ console.warn('decline failed:', e); });
      auditEntry('CT:'+ct.id, 'declined', 'Contractor declined' + (reason ? ' — ' + reason : ''), role);
      showToast('Contractor declined', {type:'info'});
      renderContractorsView();
    });
  }
}

function renderContractorsView(){
  var tbody    = document.getElementById('ct_tbody');
  var thead    = document.getElementById('ct_thead');
  var kpiHost  = document.getElementById('ct_kpi_strip_host');
  var emptyHost= document.getElementById('ct_empty_host');
  var tableWrap= document.getElementById('ct_table_wrap');
  if(!tbody) return;
  var allContractors = window._contractors || [];

  // ── Fully-empty directory ────────────────────────────────────────────
  // No contractors yet → swap the search/KPI/table out for a single empty
  // card. Search input stays visible (sits above) but with nothing to
  // search, that's harmless.
  var _ctCardsEl0  = document.getElementById('ct_cards');
  var _ctToggleEl0 = document.getElementById('ct_view_toggle');
  if(!allContractors.length){
    if (kpiHost)   kpiHost.innerHTML = '';
    if (tableWrap) tableWrap.style.display = 'none';
    if (_ctCardsEl0)  { _ctCardsEl0.style.display = 'none'; _ctCardsEl0.innerHTML = ''; }
    if (_ctToggleEl0) _ctToggleEl0.innerHTML = '';
    if (emptyHost) emptyHost.innerHTML = '<div class="card ct-empty"><div class="ct-empty-inner"><span class="ct-empty-icon">🧰</span><div class="ct-empty-title">No contractors added yet</div><div class="ct-empty-sub">Click "Add Contractor" to build your directory.</div></div></div>';
    return;
  }
  if (emptyHost) emptyHost.innerHTML = '';

  // ── KPIs ─────────────────────────────────────────────────────────────
  var kpi = _ctComputeKpis();
  if (kpiHost) {
    kpiHost.innerHTML =
      '<div class="ct-kpi-strip">' +
        '<div class="ct-kpi-card"><div class="ct-kpi-label">Total Contractors</div>'+
          '<div class="ct-kpi-val">'+kpi.totalContractors+'</div>'+
          '<div class="ct-kpi-sub">'+kpi.approved+' approved · '+kpi.pending+' pending</div></div>' +
        '<div class="ct-kpi-card"><div class="ct-kpi-label">Total Requests</div>'+
          '<div class="ct-kpi-val">'+kpi.totalJobs+'</div>'+
          '<div class="ct-kpi-sub">across all contractors</div></div>' +
        '<div class="ct-kpi-card"><div class="ct-kpi-label">Total Spend</div>'+
          '<div class="ct-kpi-val">'+_ctFmtCurrency(kpi.totalSpend)+'</div>'+
          '<div class="ct-kpi-sub">cumulative request value</div></div>' +
        '<div class="ct-kpi-card"><div class="ct-kpi-label">Top Trade</div>'+
          '<div class="ct-kpi-val ct-kpi-val-sm">'+escapeHtml(kpi.topTrade || '—')+'</div>'+
          '<div class="ct-kpi-sub">'+(kpi.topTrade ? kpi.topTradeJobs + ' job' + (kpi.topTradeJobs===1?'':'s') : 'no jobs yet')+'</div></div>' +
      '</div>';
  }

  var classLabels = {internal_indigenous:'Internal — Indigenous',external_indigenous:'External — Indigenous',external_non_indigenous:'External — Non-Indigenous'};
  var role = window.currentRole || 'housing_employee_l1';
  var isMgmt = (typeof ROLE !== 'undefined') && ROLE.isManagement(role);

  // Decorate each contractor with derived stats once. Hide archived rows
  // by default (no filter UI to surface them yet — Phase 2C, mirrors
  // inventory's archived treatment).
  var enriched = allContractors.map(function(ct, i){
    var stats = _ctRowStats(ct);
    var statusKey = ct.status || 'pending_review';
    return {
      ct: ct, i: i,
      name:       ct.name || '',
      classLabel: classLabels[ct.classification] || '(none)',
      jobs:       stats.jobCount,
      value:      stats.totalValue,
      wsib:       ct.wsibExpiry || '',
      ins:        ct.insExpiry  || '',
      statusKey:  statusKey,
      statusLabel:(contractorStatusBadge(statusKey, {variant:'table'}) || {label:statusKey}).label
    };
  }).filter(function(r){ return !r.ct.archived; });

  // Search filter — scans every visible column.
  var ctSearch = ((document.getElementById('ct_search_input')||{}).value || '').toLowerCase().trim();
  if (ctSearch) {
    enriched = enriched.filter(function(r){
      var hay = [
        r.name, r.ct.trade, r.ct.phone, r.ct.email,
        r.ct.address, r.ct.city, r.ct.bbb_id,
        r.statusLabel, r.classLabel
      ].filter(Boolean).join(' ').toLowerCase();
      return hay.indexOf(ctSearch) !== -1;
    });
  }

  // Default sort — name asc. Preserved when state.sort.key is empty.
  enriched.sort(function(a,b){
    var av=(a.name||'').toLowerCase(), bv=(b.name||'').toLowerCase();
    return av < bv ? -1 : av > bv ? 1 : 0;
  });

  // ── Column-menu sort + filter (Phase 2B) ─────────────────────────────
  var _ctColumns = {
    name:   { label: 'Contractor',        accessor: function(r){ return r.name || '(none)'; } },
    class:  { label: 'Indigenous Status', accessor: function(r){ return r.classLabel || '(none)'; } },
    jobs:   { label: '# Jobs',            accessor: function(r){ return r.jobs || 0; } },
    value:  { label: 'Cumulative $',      accessor: function(r){ return r.value || 0; } },
    wsib:   { label: 'WSIB Expiry',       accessor: function(r){ return r.wsib || '(none)'; } },
    ins:    { label: 'Insurance Expiry',  accessor: function(r){ return r.ins  || '(none)'; } },
    status: { label: 'Status',            accessor: function(r){ return r.statusLabel || '(none)'; } }
  };
  var _ctAccessors = {};
  Object.keys(_ctColumns).forEach(function(k){ _ctAccessors[k] = _ctColumns[k].accessor; });

  var _ctState = (typeof tableStateGet === 'function') ? tableStateGet('contractors') : { sort:{key:'',dir:1}, filters:{} };

  if (typeof tableRegisterColumns === 'function') {
    tableRegisterColumns('contractors', {
      columns:  _ctColumns,
      getRows:  function(){ return enriched; },
      onChange: renderContractorsView
    });
  }

  var rows = (typeof tableApplyFilterSort === 'function')
    ? tableApplyFilterSort(enriched, _ctAccessors, _ctState)
    : enriched;

  // ── List / Cards toggle (mirrors Inventory / Match / Tenants) ─────────
  var _ctMode    = (typeof _viewMode === 'function') ? _viewMode('contractors') : 'cards';
  var _ctCardsEl = document.getElementById('ct_cards');
  var _ctToggle  = document.getElementById('ct_view_toggle');
  if (_ctToggle && typeof _viewToggleHtml === 'function') _ctToggle.innerHTML = _viewToggleHtml('contractors', '_ctSetView');
  if (tableWrap)  tableWrap.style.display  = (_ctMode === 'cards') ? 'none' : '';
  if (_ctCardsEl) _ctCardsEl.style.display = (_ctMode === 'cards') ? '' : 'none';

  // ── Cards view — same filtered + sorted rows as the table ────────────
  if (_ctMode === 'cards') {
    if (_ctCardsEl) {
      if (!rows.length) {
        _ctCardsEl.innerHTML = '<div class="card" style="text-align:center;padding:40px;color:var(--muted);">No contractors match the current filters.</div>';
      } else if (typeof _cardTile === 'function' && typeof _cardGrid === 'function') {
        _ctCardsEl.innerHTML = _cardGrid(rows.map(function(r){
          var ct = r.ct; var i = r.i;
          var ss = contractorStatusBadge(r.statusKey, {variant:'table'}) || {label:r.statusKey};
          var contact = ct.phone ? formatPhone(ct.phone) : (ct.email || '');
          return _cardTile({
            title: ct.name || '(unnamed)',
            pill: {text: ss.label, bg: (ss.bg||'var(--bg)'), color: (ss.c||'var(--muted)')},
            metas: [
              {k:'Trade',            v: ct.trade || 'General Contractor'},
              {k:'Contact',          v: contact},
              {k:'Indigenous',       v: (r.classLabel && r.classLabel !== '(none)') ? r.classLabel : ''},
              {k:'# Jobs',           v: r.jobs},
              {k:'Cumulative $',     v: _ctFmtCurrency(r.value)},
              {k:'WSIB Expiry',      v: ct.wsibExpiry || ''},
              {k:'Insurance Expiry', v: ct.insExpiry  || ''}
            ],
            open: 'openAddContractorModal('+i+')',
            actions: [
              {text:'🖨 Print', onclick:'event.stopPropagation();ctPrintFromRow('+i+')', ghost:true},
              {text:'✏️ Edit',  onclick:'event.stopPropagation();openAddContractorModal('+i+')'}
            ]
          });
        }).join(''));
      }
    }
    // Column registration already ran above so List mode's popovers stay in
    // sync; there's no table header to bind in Cards mode.
    return;
  }

  // ── Table rows ───────────────────────────────────────────────────────
  if(!rows.length){
    tbody.innerHTML = '<tr><td colspan="10" class="ct-table-empty">No contractors match the current filters.</td></tr>';
  } else {
    tbody.innerHTML = rows.map(function(r){
      var ct = r.ct; var i = r.i;
      var ss = contractorStatusBadge(r.statusKey, {variant:'table'}) || {cls:'', label:r.statusKey};
      var initials = (function(n){var w=(n||'??').trim().split(/\s+/);return w.length>=2?w[0][0].toUpperCase()+w[w.length-1][0].toUpperCase():(n||'??').slice(0,2).toUpperCase();})(ct.name);
      var contact = ct.phone ? formatPhone(ct.phone) : (ct.email || '—');
      var indigClass = 'ct-indig-other';
      if (ct.classification === 'internal_indigenous') indigClass = 'ct-indig-internal';
      else if (ct.classification === 'external_indigenous') indigClass = 'ct-indig-external';
      else if (ct.classification === 'external_non_indigenous') indigClass = 'ct-indig-nonindig';
      var indigLabel = r.classLabel || '—';
      return '<tr class="ct-row" onclick="openAddContractorModal('+i+')" title="Open contractor">' +
        '<td class="ct-row-avatar"><div class="std-row-avatar">'+escapeHtml(initials)+'</div></td>' +
        '<td class="ct-row-name"><div class="ct-name-line">'+escapeHtml(ct.name||'—')+'</div><div class="ct-name-trade">'+escapeHtml(ct.trade||'General Contractor')+'</div></td>' +
        '<td class="ct-th-hide-mobile ct-row-contact">'+escapeHtml(contact)+'</td>' +
        '<td class="ct-th-hide-mobile"><span class="ct-indig-pill '+indigClass+'">'+escapeHtml(indigLabel.replace(' — Indigenous','').replace(' — Non-Indigenous',''))+'</span></td>' +
        '<td class="ct-th-num">'+r.jobs+'</td>' +
        '<td class="ct-th-num">'+_ctFmtCurrency(r.value)+'</td>' +
        '<td class="ct-th-hide-mobile">'+_ctExpiryCell(ct.wsibExpiry)+'</td>' +
        '<td class="ct-th-hide-mobile">'+_ctExpiryCell(ct.insExpiry)+'</td>' +
        '<td class="ct-row-status"><span class="std-pill ct-status-pill '+ss.cls+'">'+escapeHtml(ss.label)+'</span></td>' +
        '<td class="ct-row-actions">' +
          '<div class="ct-row-actions-inner">' +
            '<button class="dash-action-btn" onclick="event.stopPropagation();openAddContractorModal('+i+')" title="Edit">'+
              '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>'+
            '</button>' +
            '<button class="dash-action-btn" onclick="event.stopPropagation();ctPrintFromRow('+i+')" title="Print Agreement">'+
              '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>'+
            '</button>' +
            (isMgmt
              ? '<button class="dash-action-btn" onclick="event.stopPropagation();ctOpenRowMenu('+i+', this)" title="More options" style="font-size:14px;line-height:1;">⋮</button>'
              : '') +
          '</div>' +
        '</td>' +
      '</tr>';
    }).join('');
  }

  // Column-menu click + sort indicators
  if (typeof tableBindColumnMenuClicks === 'function')   tableBindColumnMenuClicks(thead, 'contractors');
  if (typeof tableRefreshSortIndicators === 'function') tableRefreshSortIndicators(thead, 'contractors');
}
// List/Cards toggle setter for the Contractors page (mirrors _invSetView /
// _matchSetView / _tenSetView in housing-views.js). Persisted per device.
window._ctSetView = function(v){
  try { localStorage.setItem('clfn_contractors_view', v === 'cards' ? 'cards' : 'list'); } catch(e){}
  if (typeof renderContractorsView === 'function') renderContractorsView();
};
function renderCtFilePreview(bucket){
  var container=document.getElementById('ct_'+bucket+'_preview');
  if(!container)return;
  var files=(window._ctFiles||{})[bucket]||[];
  container.innerHTML=files.map(function(f,i){
    return '<div style="display:flex;align-items:center;gap:5px;padding:4px 10px;background:var(--bg);border:1px solid var(--border);border-radius:6px;font-size:11px;">'
      +(f.type&&f.type.includes('pdf')?'📄':'📎')
      +' <span data-open-bucket="'+escapeHtml(bucket)+'" data-open-idx="'+i+'" title="Open file" style="max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;text-decoration:underline;text-decoration-color:var(--border);">'+escapeHtml(f.name)+'</span>'
      +'<button type="button" data-bucket="'+escapeHtml(bucket)+'" data-idx="'+i+'" style="background:none;border:none;color:var(--danger);cursor:pointer;font-size:12px;padding:0 2px;">✕</button></div>';
  }).join('');
  // Filename click → open the file. Staged uploads still have the base64
  // data URL in memory; saved-and-reloaded files have a storage path opened
  // via a signed URL (sbGetSignedUrl).
  container.querySelectorAll('span[data-open-bucket]').forEach(function(el){
    el.onclick=function(){
      var bk = el.getAttribute('data-open-bucket');
      var idx = parseInt(el.getAttribute('data-open-idx'));
      var rec = (window._ctFiles||{})[bk] && window._ctFiles[bk][idx];
      if(!rec) return;
      // Saved-and-reloaded files have a storage path (no in-memory data URL).
      // Fetch a short-lived signed URL and open it. Open the tab synchronously
      // (preserves the click user-gesture so the browser doesn't block it),
      // then point it at the signed URL once it resolves.
      if(rec.path && typeof sbGetSignedUrl === 'function'){
        var w = window.open('', '_blank');
        sbGetSignedUrl(rec.path).then(function(url){
          if(!url){ if(w) w.close(); if(typeof showToast==='function') showToast('Could not open file.', { type:'error' }); return; }
          if(w) w.location.href = url; else window.open(url, '_blank');
        }).catch(function(e){
          if(w) w.close();
          if(typeof showToast==='function') showToast('Could not open file: ' + (e && e.message || e), { type:'error' });
        });
        return;
      }
      if(rec.data){
        try {
          var w = window.open();
          if(w){
            if((rec.type||'').indexOf('pdf') !== -1){
              w.location.href = rec.data;
            } else {
              w.document.write('<title>'+escapeHtml(rec.name)+'</title><img src="'+rec.data+'" style="max-width:100%;max-height:100vh;display:block;margin:auto;"/>');
            }
          }
        } catch(e){ console.warn('[ct file] open failed:', e); }
      }
    };
  });
  container.querySelectorAll('button[data-bucket]').forEach(function(btn){
    btn.onclick=function(){
      var bk = btn.getAttribute('data-bucket');
      var idx = parseInt(btn.getAttribute('data-idx'));
      var rec = (window._ctFiles||{})[bk] && window._ctFiles[bk][idx];
      // Existing files (have a storage path) need their blob removed AND a
      // file_deleted audit row so the next sbLoadFileMeta() filters them out.
      // Staged files (have .data, no .path) only live in memory — splice is
      // enough.
      if (rec && rec.path) {
        var ctId = (window._ctEditIdx >= 0 && (window._contractors||[])[window._ctEditIdx])
                   ? (window._contractors[window._ctEditIdx].id || null)
                   : null;
        if (typeof sbDeleteFile === 'function') {
          sbDeleteFile(rec.path).catch(function(e){ console.warn('[ct file] storage delete failed:', e); });
        }
        if (ctId) {
          try {
            fetch(SUPABASE_URL + '/rest/v1/housing_audit_log', {
              method: 'POST',
              headers: Object.assign({}, HOUSING_HEADERS, { 'Prefer': 'return=minimal' }),
              body: JSON.stringify({
                entity_type: 'contractor',
                entity_id:   String(ctId),
                action:      'file_deleted',
                detail:      JSON.stringify({ path: rec.path, name: rec.name, bucket: bk }),
                actor:       window.currentRole || 'staff',
                created_at:  new Date().toISOString()
              })
            }).catch(function(e){ console.warn('[ct file] file_deleted audit failed:', e); });
          } catch(e) { console.warn('[ct file] file_deleted audit threw:', e); }
        }
      }
      window._ctFiles[bk].splice(idx, 1);
      renderCtFilePreview(bk);
    };
  });
}
// _loadCtFilesFromStorage(ctId) — populate window._ctFiles from the audit log
// when an existing contractor is opened for edit. Without this, files that
// were uploaded on prior saves (under contractors/{ctId}/{bucket}/) remain
// in storage but invisible in the modal — users think their attachments are
// missing and re-upload, creating duplicates.
//
// Bucket recovery: the upload path written by saveContractor is
//   contractors/{ctId}/{bucket}/{ts}_{name}
// so we split on '/' and take index 2. Falls back to 'other' if the path
// doesn't match the expected prefix (e.g. legacy data).
async function _loadCtFilesFromStorage(ctId){
  if(!ctId || typeof sbLoadFileMeta !== 'function') return;
  try {
    var meta = await sbLoadFileMeta('contractor', ctId);
    if(!Array.isArray(meta) || !meta.length) return;
    if(!window._ctFiles) window._ctFiles = {wsib:[],insurance:[],other:[]};
    meta.forEach(function(f){
      var parts = String(f.path||'').split('/');
      var bk = (parts[0] === 'contractors' && ['wsib','insurance','other'].indexOf(parts[2]) !== -1)
             ? parts[2]
             : 'other';
      if(!window._ctFiles[bk]) window._ctFiles[bk] = [];
      // Existing-file marker: has .path, no .data. saveContractor skips these.
      window._ctFiles[bk].push({
        name: f.name, type: f.type, size: f.size, path: f.path,
        added: f.addedAt
      });
    });
    ['wsib','insurance','other'].forEach(function(bk){ renderCtFilePreview(bk); });
  } catch(e) { console.warn('[ct file] load from storage failed:', e); }
}
// Short relative-time formatter for the Last Login column. Returns strings
// like "2h ago", "3d ago", "5w ago", "Today", "Yesterday", "Never". Keeps
// cells narrow so the table doesn't reflow on a wide last-login string.
function _fmtRelativeTime(iso) {
  if (!iso) return 'Never';
  var t = new Date(iso).getTime();
  if (isNaN(t)) return '—';
  var diffMs   = Date.now() - t;
  var diffMin  = Math.floor(diffMs / 60000);
  if (diffMin < 1)    return 'Just now';
  if (diffMin < 60)   return diffMin + 'm ago';
  var diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24)  return diffHour + 'h ago';
  var diffDay  = Math.floor(diffHour / 24);
  if (diffDay === 1)  return 'Yesterday';
  if (diffDay < 7)    return diffDay + 'd ago';
  if (diffDay < 30)   return Math.floor(diffDay / 7) + 'w ago';
  if (diffDay < 365)  return Math.floor(diffDay / 30) + 'mo ago';
  return Math.floor(diffDay / 365) + 'y ago';
}

// Active / Inactive tab switcher for the Settings → Application Users table.
// Flips window._staffFilter and re-renders. Deactivated staff are kept in
// the DB (is_active=false) so historical audit references resolve; this
// surface lets an admin find them and bring them back via reactivateStaff.
function setStaffFilter(which) {
  window._staffFilter = (which === 'inactive') ? 'inactive' : 'active';
  var a = document.getElementById('staff_tab_active');
  var i = document.getElementById('staff_tab_inactive');
  if(a) a.classList.toggle('active', window._staffFilter === 'active');
  if(i) i.classList.toggle('active', window._staffFilter === 'inactive');
  renderHousingUserTable();
}

// Access-expiry status chip for the Users table. '' when no expiry is set;
// red "Expired" once past; amber "Expires <date> (Nd)" within 14 days; a neutral
// "Expires <date>" otherwise.
function _staffExpiryChip(u){
  var v = u && u.access_expires_at;
  if(!v) return '';
  var s = String(v).slice(0,10);
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if(!m) return '';
  var endOfDay = new Date(+m[1],(+m[2])-1,(+m[3])+1).getTime();
  var now = Date.now();
  var days = Math.ceil((endOfDay - now)/86400000);
  var style, label;
  if(now >= endOfDay){ style='background:var(--danger-bg);color:var(--danger);border:1px solid var(--danger-border);'; label='Expired'; }
  else if(days <= 14){ style='background:var(--warn-amber-bg);color:var(--warn-amber-text);border:1px solid #fed7aa;'; label='Expires '+s+' ('+days+'d)'; }
  else { style='background:#f4f4f0;color:#555;border:1px solid var(--border);'; label='Expires '+s; }
  return '<span title="Access expiry" style="display:inline-block;font-size:10px;font-weight:700;padding:2px 7px;border-radius:6px;'+style+'">🕒 '+label+'</span>';
}
async function renderHousingUserTable(){
  var tbody = document.getElementById('userTableBody');
  if(!tbody) return;
  tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--muted);font-size:12px;font-style:italic;">Loading…</td></tr>';
  try {
    var filter   = window._staffFilter === 'inactive' ? 'inactive' : 'active';
    var activeQ  = filter === 'inactive' ? 'eq.false' : 'eq.true';
    var results = await Promise.all([
      fetch(SUPABASE_URL+'/rest/v1/staff?select=*&is_active='+activeQ+'&order=name', {headers:HOUSING_HEADERS}),
      fetch(SUPABASE_URL+'/rest/v1/housing_audit_log?action=eq.user_login&select=actor,created_at&order=created_at.desc&limit=500', {headers:HOUSING_HEADERS})
    ]);
    var r = results[0];
    var staff = await r.json();
    var loginRows = results[1].ok ? await results[1].json() : [];
    // Build email → most recent login timestamp from audit_log (fallback for users whose
    // staff.last_login_at PATCH is blocked by RLS)
    var _loginMap = {};
    loginRows.forEach(function(row){
      var actor = (row.actor||'').toLowerCase();
      if (actor && !_loginMap[actor]) _loginMap[actor] = row.created_at;
    });
    if(!staff||!staff.length){
      var emptyMsg = filter === 'inactive' ? 'No deactivated staff.' : 'No staff found.';
      tbody.innerHTML='<tr><td colspan="6" style="text-align:center;color:var(--muted);font-size:12px;font-style:italic;">'+emptyMsg+'</td></tr>';
      return;
    }
    var roleColors = {
      super_user:          {bg:'#1e293b', c:'#f8fafc'},
      ed:                  {bg:'var(--success-bg)', c:'var(--success)'},
      housing_manager:     {bg:'var(--info-blue-bg)', c:'#1d4ed8'},
      housing_employee_l2: {bg:'#faf5ff', c:'#7c3aed'},
      housing_employee_l1: {bg:'#f4f4f0', c:'#555'},
      employee:            {bg:'#f4f4f0', c:'#555'},
      cfo:                 {bg:'var(--warn-amber-bg)', c:'var(--warn-amber-text)'},
      finance_l1:          {bg:'var(--warn-amber-bg)', c:'var(--warn-amber-text)'}
    };
    // Source labels from CLFN_PERMS so display titles stay nation-configurable.
    // Legacy 'employee' key is kept for old DB rows that haven't been normalized.
    var roleLabels = {
      super_user:          CLFN_PERMS.roleLabel(ROLE.SUPER_USER),
      ed:                  CLFN_PERMS.roleLabel(ROLE.ED),
      housing_manager:     CLFN_PERMS.roleLabel(ROLE.HOUSING_MANAGER),
      housing_employee_l2: CLFN_PERMS.roleLabel(ROLE.HE_L2),
      housing_employee_l1: CLFN_PERMS.roleLabel(ROLE.HE_L1),
      employee:            'Employee',
      cfo:                 CLFN_PERMS.roleLabel(ROLE.CFO),
      finance_l1:          CLFN_PERMS.roleLabel(ROLE.FINANCE_L1)
    };
    window._staffCache = {};
    staff.forEach(function(u){ window._staffCache[u.id] = u; });
    tbody.innerHTML = staff.map(function(u){
      var hr    = sbMapRole(u);
      var rc    = roleColors[hr] || {bg:'#f4f4f0', c:'#555'};
      var rl    = roleLabels[hr] || hr;
      var isMe  = HOUSING_SESSION.email === (u.email||'').toLowerCase();
      var words = (u.name||'').trim().split(/\s+/);
      var initials = words.length >= 2
        ? words[0][0].toUpperCase() + words[words.length-1][0].toUpperCase()
        : (u.name||'??').slice(0,2).toUpperCase();
      var canManage = APPROVAL_AUTHORITY.can('manageStaffRecord', window.currentRole);
      var actionsHtml = '';
      if (isMe) {
        actionsHtml = '<span style="font-size:11px;color:var(--muted);">You</span>';
      } else if (canManage) {
        if (filter === 'inactive') {
          // Inactive: offer Reactivate. No Send Reset here — handle that
          // after they're brought back so the standard Active-row controls
          // apply uniformly.
          actionsHtml = '<div class="flex-end gap-8">'
            +'<button onclick="reactivateStaff('+u.id+',this)" class="btn btn-sm btn-primary">Reactivate</button>'
            +'</div>';
        } else {
          // Active: Edit + (Send Reset | Send Sign-in Link) + Deactivate.
          // Magic-link users sign in by an admin-issued link, so they get
          // "Send Sign-in Link" instead of the password-reset action.
          var _sendBtn = (u.magic_link === true)
            ? '<button onclick="sendStaffMagicLink(\''+escapeHtml(u.email)+'\',this)" class="btn btn-ghost btn-sm">Send Sign-in Link</button>'
            : '<button onclick="sendStaffPasswordReset(\''+escapeHtml(u.email)+'\',this)" class="btn btn-ghost btn-sm">Send Reset</button>';
          actionsHtml = '<div class="flex-end gap-8">'
            +'<button onclick="_sbEditStaffModal('+u.id+')" class="btn btn-ghost btn-sm">Edit</button>'
            +_sendBtn
            +'<button onclick="deactivateStaff('+u.id+',this)" class="btn btn-sm" style="border-color:var(--danger-border);color:var(--danger);">Deactivate</button>'
            +'</div>';
        }
      }
      // Last-login cell. Muted "Never" reads as a soft warning prompt for
      // freshly-added staff who haven't signed in yet, without alarming
      // colour. Tooltip carries the absolute timestamp for precise lookup.
      var lastLogin = u.last_login_at || _loginMap[(u.email||'').toLowerCase()] || null;
      var lastLoginCell = '<td style="font-size:12px;color:var(--muted);"'
        + (lastLogin ? ' title="'+escapeHtml(lastLogin)+'"' : '')
        + '>'+escapeHtml(_fmtRelativeTime(lastLogin))+'</td>';
      return '<tr>'
        +'<td class="std-row-avatar-cell"><div class="std-row-avatar">'+escapeHtml(initials)+'</div></td>'
        +'<td style="font-weight:600;">'+escapeHtml(u.name)
          + (function(){ var c=_staffExpiryChip(u); return c ? '<div style="margin-top:3px;">'+c+'</div>' : ''; })()
        +'</td>'
        +'<td style="color:var(--muted);font-size:12px;">'+escapeHtml(u.email)+'</td>'
        +'<td><span style="font-size:11px;font-weight:700;padding:3px 10px;border-radius:8px;background:'+rc.bg+';color:'+rc.c+';">'+escapeHtml(rl)+'</span></td>'
        +lastLoginCell
        +'<td class="std-cell-right">'+actionsHtml+'</td>'
        +'</tr>';
    }).join('');
  } catch(e){
    tbody.innerHTML='<tr><td colspan="6" style="text-align:center;color:var(--danger);font-size:12px;">Error loading staff: '+escapeHtml(e.message)+'</td></tr>';
  }
}
function renderRenoScoreBadge(unitId) {
  var el = document.getElementById('rp_reno_score_badge');
  if(!el) return;
  var result = calcRenoScore(unitId);
  var s = result.score;
  var tier = s >= 40 ? {label:'Critical',  bg:'var(--danger-bg)', c:'var(--danger)'}
           : s >= 25 ? {label:'High',      bg:'#fef9ec', c:'#7a6000'}
           : s >= 12 ? {label:'Medium',    bg:'var(--info-blue-bg)', c:'#1d4ed8'}
           :           {label:'Low',       bg:'var(--success-bg)', c:'var(--success)'};
  el.innerHTML = '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">'
    +'<div style="font-size:30px;font-weight:800;color:var(--text);">'+s+'</div>'
    +'<div>'
      +'<span style="display:inline-block;font-size:11px;font-weight:700;padding:3px 10px;border-radius:10px;background:'+tier.bg+';color:'+tier.c+';">'+tier.label+' Priority</span>'
      +'<div style="font-size:11px;color:var(--muted);margin-top:3px;">Renovation Priority Score</div>'
    +'</div>'
    +'<div style="flex:1;min-width:120px;margin-left:8px;">'
      +'<div style="height:6px;background:var(--border);border-radius:3px;overflow:hidden;">'
        +'<div style="height:100%;width:'+Math.min(100,Math.round((s/60)*100))+'%;background:'+tier.c+';border-radius:3px;transition:width .4s;"></div>'
      +'</div>'
    +'</div>'
    +'</div>'
    +'<div style="margin-top:10px;display:flex;flex-direction:column;gap:4px;">'
    +result.breakdown.map(function(b){
      return '<div style="display:flex;justify-content:space-between;font-size:12px;padding:3px 0;border-bottom:1px solid var(--border);">'
        +'<span class="js-lbl-xs">'+b.label+'</span>'
        +'<span style="font-weight:700;color:var(--success);">+'+b.pts+'</span>'
        +'</div>';
    }).join('')
    +'</div>';
}
function renderRenoScoreTable() {
  var tbody = document.getElementById('reno_score_tbody');
  if(!tbody) return;
  var model = getRenoScoreModel();
  var prevFactor = '';
  tbody.innerHTML = model.map(function(row) {
    var isNew = row.factor !== prevFactor;
    prevFactor = row.factor;
    var ptsColor = row.pts > 0 ? 'var(--success)' : row.pts < 0 ? 'var(--danger)' : 'var(--gray)';
    return '<tr class="row-divider">'
      +'<td style="padding:9px 12px;font-size:13px;font-weight:600;color:var(--text);">'+(isNew?row.factor:'')+'</td>'
      +'<td style="padding:9px 12px;font-size:13px;color:var(--muted);">'+row.condition+'</td>'
      +'<td style="padding:9px 12px;text-align:center;">'
        +(row.editable
          ?'<input type="number" data-rsm-id="'+row.id+'" value="'+row.pts+'" step="1" min="-50" max="50"'
            +' style="width:60px;text-align:center;padding:4px 6px;border:1px solid var(--border);border-radius:6px;font-size:13px;font-weight:700;color:'+ptsColor+';background:var(--surface);"'
            +' onchange="this.style.color=+this.value>0?\'var(--success)\':\'var(--gray)\'"/>'
          :'<span style="font-size:13px;font-weight:700;color:'+ptsColor+';">'+row.pts+'</span>')
      +'</td>'
      +'<td style="padding:9px 12px;font-size:11px;color:var(--muted);">'+row.notes+'</td>'
      +'</tr>';
  }).join('');
}
function renderRenosView(){
  /* getSowData defined globally below */
  function getRenoProgress(uid){ return window._renoProgress && window._renoProgress[uid] ? window._renoProgress[uid] : {}; }
  var units=getAllUnits();

  var allReno = units.filter(function(u){
    if(u.archived) return false;
    // Condemned is terminal — only listed here when a request is on file.
    if(u.status==='condemned') return !!getSowData(u.id);
    return !!u.under_renovation;
  });

  // Per-render memo — calcRenoScore does a full-inventory find + SOW read per
  // call, and this render used to call it from the sort comparator
  // (O(n log n) scans), the Priority column accessor, the score badge, and
  // each card tile. Scoped to this render's closure so it can never go stale.
  var _rsMemo = {};
  function _renoScoreOf(uid){
    if (!Object.prototype.hasOwnProperty.call(_rsMemo, uid)) _rsMemo[uid] = calcRenoScore(uid);
    return _rsMemo[uid];
  }

  // Default sort — priority desc. Stays in effect until the user picks
  // a column-menu sort (tableApplyFilterSort preserves this when no
  // sort key is set).
  allReno.sort(function(a,b){ return _renoScoreOf(b.id).score - _renoScoreOf(a.id).score; });

  // Search filter — scans every visible column.
  var _renoSearch = ((document.getElementById('renos_search')||{}).value || '').toLowerCase().trim();
  var filtered = allReno;
  if (_renoSearch) {
    filtered = filtered.filter(function(u){
      var sow  = getSowData(u.id) || {};
      var hay = [
        u.num, u.street, u.bedrooms, u.type, u.status,
        sow.contractor, sow.project_number, sow.poNumber
      ].filter(function(v){ return v != null && v !== ''; }).join(' ').toLowerCase();
      return hay.indexOf(_renoSearch) !== -1;
    });
  }

  function scoreBadge(uid){
    var r=_renoScoreOf(uid); var s=r.score;
    var tier=s>=40?{label:'Critical',c:'var(--danger)',bg:'var(--danger-bg)'}:s>=25?{label:'High',c:'#7a6000',bg:'#fef9ec'}:s>=12?{label:'Medium',c:'#1d4ed8',bg:'var(--info-blue-bg)'}:{label:'Low',c:'var(--success)',bg:'var(--success-bg)'};
    return '<span style="font-size:15px;font-weight:800;color:var(--text);">'+s+'</span>'
      +' <span style="font-size:10px;font-weight:700;padding:2px 7px;border-radius:8px;background:'+tier.bg+';color:'+tier.c+';">'+tier.label+'</span>';
  }

  // ── Column-menu sort + filter (Phase 2B) ─────────────────────
  var _renosColumns = {
    addr:       { label: 'Address',    accessor: function(u){ return ((u.num||'')+' '+(u.street||'')).trim(); } },
    bedrooms:   { label: 'Beds',       accessor: function(u){ return parseInt(u.bedrooms, 10) || 0; } },
    status:     { label: 'Status',     accessor: function(u){ return u.status === 'condemned' ? 'Condemned' : 'Under Repair'; } },
    progress:   { label: 'Progress',   accessor: function(u){ var p=getRenoProgress(u.id); return p && p.overallPct || 0; } },
    contractor: { label: 'Contractor', accessor: function(u){ var s=getSowData(u.id); return (s && s.contractor) || '(none)'; } },
    priority:   { label: 'Priority',   accessor: function(u){ return _renoScoreOf(u.id).score || 0; } }
  };
  var _renosAccessors = {};
  Object.keys(_renosColumns).forEach(function(k){ _renosAccessors[k] = _renosColumns[k].accessor; });

  var _renosState = (typeof tableStateGet === 'function') ? tableStateGet('renos') : { sort:{key:'',dir:1}, filters:{} };

  if (typeof tableRegisterColumns === 'function') {
    tableRegisterColumns('renos', {
      columns:  _renosColumns,
      getRows:  function(){ return filtered; },
      onChange: renderRenosView
    });
  }

  var _renosRows = (typeof tableApplyFilterSort === 'function')
    ? tableApplyFilterSort(filtered, _renosAccessors, _renosState)
    : filtered;

  // ── KPI strip ────────────────────────────────────────────────────────────
  var _rvKpiEl = document.getElementById('rv_kpi');
  if (_rvKpiEl) {
    var _rvTotalVal = 0;
    var _rvCatCounts = {};
    var _rvCatValues = {};
    allReno.forEach(function(u) {
      var _rvSow = getSowData(u.id);
      if (_rvSow) {
        var _rvCost = parseFloat((_rvSow.totalCost || '').toString().replace(/[^0-9.]/g, '')) || 0;
        _rvTotalVal += _rvCost;
        if (_rvSow.items) {
          _rvSow.items.forEach(function(it) {
            var c = (it.category || 'Other').trim();
            if (!c) return;
            _rvCatCounts[c] = (_rvCatCounts[c] || 0) + 1;
            _rvCatValues[c] = (_rvCatValues[c] || 0) + (parseFloat(it.cost) || 0);
          });
        }
      }
    });
    var _rvTopCats = Object.keys(_rvCatCounts).sort(function(a, b) { return _rvCatCounts[b] - _rvCatCounts[a]; }).slice(0, 3);
    function _rvKpiCard(lbl, val, meta, acc) {
      return '<div class="kpi-card' + (acc ? ' kpi-accent-' + acc : '') + '">'
        + '<div class="kpi-label">' + lbl + '</div>'
        + '<div class="kpi-value">' + val + '</div>'
        + (meta ? '<div class="kpi-meta">' + meta + '</div>' : '')
        + '</div>';
    }
    function _rvCatMeta(cat) {
      var v = _rvCatValues[cat] || 0;
      return (v > 0 ? '$' + Math.round(v).toLocaleString() : '—');
    }
    _rvKpiEl.innerHTML =
      _rvKpiCard('Active Renovations', allReno.length, allReno.length === 1 ? '1 unit' : allReno.length + ' units') +
      _rvKpiCard('Total Value', _rvTotalVal > 0 ? formatCurrency(_rvTotalVal) : '—', 'across all requests', 'info') +
      (_rvTopCats[0] ? _rvKpiCard(_rvTopCats[0], _rvCatCounts[_rvTopCats[0]], _rvCatMeta(_rvTopCats[0]), 'success') : _rvKpiCard('#1 Category', '—', 'no items yet')) +
      (_rvTopCats[1] ? _rvKpiCard(_rvTopCats[1], _rvCatCounts[_rvTopCats[1]], _rvCatMeta(_rvTopCats[1])) : '') +
      (_rvTopCats[2] ? _rvKpiCard(_rvTopCats[2], _rvCatCounts[_rvTopCats[2]], _rvCatMeta(_rvTopCats[2])) : '');
  }

  // ── List / Cards toggle ──────────────────────────────────────
  var _rnMode = (typeof _viewMode === 'function') ? _viewMode('renovations') : 'cards';
  var _rnToggleEl = document.getElementById('rv_view_toggle');
  if (_rnToggleEl && typeof _viewToggleHtml === 'function') _rnToggleEl.innerHTML = _viewToggleHtml('renovations', '_renosSetView');
  var _rnTableWrap = document.getElementById('renos_table_wrap');
  var _rnCardsEl   = document.getElementById('renos_cards');
  if (_rnTableWrap) _rnTableWrap.style.display = (_rnMode === 'cards') ? 'none' : '';
  if (_rnCardsEl)   _rnCardsEl.style.display   = (_rnMode === 'cards') ? '' : 'none';
  if (_rnMode === 'cards' && _rnCardsEl && typeof _cardGrid === 'function') {
    var _rnEsc = (typeof escapeHtml === 'function') ? escapeHtml : function(s){ return String(s==null?'':s); };
    if (!_renosRows.length) {
      _rnCardsEl.innerHTML = '<div class="card" style="text-align:center;padding:40px;color:var(--muted);">No units match the current filters.</div>';
    } else {
      _rnCardsEl.innerHTML = _cardGrid(_renosRows.map(function(u){
        var isCondemned = u.status === 'condemned';
        var sow = getSowData(u.id);
        var prog = getRenoProgress(u.id);
        var pct = prog.overallPct || 0;
        var uid = String(u.id).replace(/'/g,"\\'");
        var _rs = _renoScoreOf(u.id).score;
        var _tier = _rs>=40?{l:'Critical',c:'var(--danger)',bg:'var(--danger-bg)'}:_rs>=25?{l:'High',c:'#7a6000',bg:'#fef9ec'}:_rs>=12?{l:'Medium',c:'#1d4ed8',bg:'var(--info-blue-bg)'}:{l:'Low',c:'var(--success)',bg:'var(--success-bg)'};
        return _cardTile({
          title: _rnEsc(((u.num||'')+' '+(u.street||'')).trim()),
          pill: isCondemned ? {text:'🚫 Condemned', bg:'var(--danger-bg)', color:'var(--danger)'} : {text:'🔨 Under Repair', bg:'var(--warn-amber-bg)', color:'var(--warn-amber)'},
          badges: ['<span style="font-size:10px;font-weight:700;padding:2px 7px;border-radius:8px;background:'+_tier.bg+';color:'+_tier.c+';">'+_rs+' · '+_tier.l+'</span>'],
          metas: [
            {k:'Beds',       v: u.bedrooms},
            {k:'Progress',   v: sow ? ((prog.status||'No updates yet')+(pct?' — '+pct+'%':'')) : 'No request filed'},
            {k:'Contractor', v: _rnEsc((sow&&sow.contractor) || '—')}
          ],
          open: "openRenoProgress('"+uid+"')",
          actions: [
            {text:'🔨 Request',  onclick:"event.stopPropagation();openSowModal('"+uid+"')", ghost:true},
            {text:'📊 Progress', onclick:"event.stopPropagation();openRenoProgress('"+uid+"')"}
          ]
        });
      }).join(''));
    }
    return;
  }

  var tbody = document.getElementById('renos_tbody');
  if(!tbody) return;

  if(!_renosRows.length){
    tbody.innerHTML = '<tr><td colspan="7" style="padding:40px;text-align:center;color:var(--muted);">No units match the current filters.</td></tr>';
  } else {
    tbody.innerHTML = _renosRows.map(function(u){
      var isCondemned = u.status === 'condemned';
      var statusPill = isCondemned
        ? '<span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:8px;background:var(--danger-bg);color:var(--danger);">🚫 Condemned</span>'
        : '<span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:8px;background:var(--warn-amber-bg);color:var(--warn-amber);">🔨 Under Repair</span>';
      var sow=getSowData(u.id);
      var prog=getRenoProgress(u.id);
      var pct=prog.overallPct||0;
      var progressCell=sow
        ?'<div style="font-size:12px;font-weight:600;margin-bottom:3px;">'+(prog.status||'No updates yet')+(pct?' — '+pct+'%':'')+'</div>'
          +'<div style="height:4px;width:100px;background:var(--border);border-radius:2px;overflow:hidden;"><div style="height:100%;width:'+pct+'%;background:'+(pct>=100?'var(--success)':'var(--yellow)')+';border-radius:2px;"></div></div>'
        :'<span class="js-lbl-sm">No request filed</span>';
      // Address/contractor escaped like the cards branch (_rnEsc) already does.
      var ctName=sow&&sow.contractor?_rnEsc(sow.contractor):'—';
      return '<tr style="border-bottom:1px solid var(--border);cursor:pointer;" data-rpid="'+_rnEsc(u.id)+'">'
        +'<td style="padding:10px 14px;font-weight:600;font-size:13px;'+(isCondemned?'color:var(--danger);':'')+'">'+_rnEsc((u.num||'')+' '+(u.street||''))+'</td>'
        +'<td style="padding:10px 10px;text-align:center;font-weight:700;">'+u.bedrooms+'</td>'
        +'<td class="pad-10">'+statusPill+'</td>'
        +'<td class="pad-10">'+progressCell+'</td>'
        +'<td style="padding:10px 10px;font-size:12px;color:var(--muted);">'+ctName+'</td>'
        +'<td class="pad-10">'+scoreBadge(u.id)+'</td>'
        +'<td style="padding:10px 14px;text-align:right;white-space:nowrap;">'
          +'<div style="display:flex;gap:5px;justify-content:flex-end;">'
          +'<button type="button" data-sow-rpid="'+u.id+'" style="background:none;border:1px solid var(--border);border-radius:6px;padding:4px 10px;cursor:pointer;font-size:11px;font-weight:600;font-family:DM Sans,sans-serif;white-space:nowrap;color:var(--muted);">🔨 Request</button>'
          +'<button type="button" data-rp-rpid="'+u.id+'" style="background:var(--yellow);border:1px solid var(--yellow);border-radius:6px;padding:4px 10px;cursor:pointer;font-size:11px;font-weight:600;font-family:DM Sans,sans-serif;white-space:nowrap;color:var(--dark);">📊 Progress</button>'
          +'</div>'
        +'</td></tr>';
    }).join('');

    tbody.querySelectorAll('[data-rpid]').forEach(function(row){
      row.addEventListener('click',function(){ openRenoProgress(row.getAttribute('data-rpid')); });
    });
    tbody.querySelectorAll('[data-sow-rpid]').forEach(function(btn){
      btn.addEventListener('click',function(e){ e.stopPropagation(); openSowModal(btn.getAttribute('data-sow-rpid')); });
    });
    tbody.querySelectorAll('[data-rp-rpid]').forEach(function(btn){
      btn.addEventListener('click',function(e){ e.stopPropagation(); openRenoProgress(btn.getAttribute('data-rp-rpid')); });
    });
  }

  // Column-menu click + sort indicators
  var _renosThead = document.getElementById('renos_thead');
  if (typeof tableBindColumnMenuClicks === 'function')   tableBindColumnMenuClicks(_renosThead, 'renos');
  if (typeof tableRefreshSortIndicators === 'function') tableRefreshSortIndicators(_renosThead, 'renos');
}
window._renosSetView = function(v){
  try { localStorage.setItem('clfn_renovations_view', v === 'cards' ? 'cards' : 'list'); } catch(e){}
  if (typeof renderRenosView === 'function') renderRenosView();
};

function renderSowAuditLog(unitId) {
  // Re-wired to housing_audit_log (rows keyed entity_id = 'SOW:<unitId>' by
  // auditEntry). The previous version's data load had been removed, leaving a
  // permanently empty panel that told staff "No audit entries yet" while rows
  // existed in the table.
  var tbody = document.getElementById('sow_audit_tbody');
  if(!tbody || !unitId) return;

  var actionLabels = {
    'sow_created':       '🆕 Created',
    'sow_updated':       '✏️ Updated',
    'sow_tenant_signed': '✍️ Tenant Signed',
    'sow_staff_signed':  '✍️ Staff Signed',
    'sow_hm_approval':   '✅ HM Approval',
    'sow_ed_approval':   '✅ ED Approval',
    'sow_accountability':'⚠️ Accountability',
    'sow_completed':     '🏁 Completed',
    'sow_reopened':      '↺ Reopened',
    'sow_cancelled':     '✖ Cancelled',
    'sow_archived':      '🗄 Archived',
    'sow_renumbered':    '# Renumbered'
  };

  tbody.innerHTML = '<tr><td colspan="4" style="padding:16px 14px;color:var(--muted);font-style:italic;font-size:12px;">Loading history…</td></tr>';
  fetch(SUPABASE_URL + '/rest/v1/housing_audit_log?entity_id=eq.' + encodeURIComponent('SOW:' + unitId)
      + '&select=action,detail,actor,created_at&order=created_at.desc&limit=40',
      { headers: HOUSING_HEADERS })
    .then(function(r){ return r.ok ? r.json() : []; })
    .then(function(rows){
      var el = document.getElementById('sow_audit_tbody');
      if(!el) return;
      if(!rows || !rows.length) {
        el.innerHTML = '<tr><td colspan="4" style="padding:16px 14px;color:var(--muted);font-style:italic;font-size:12px;">No audit entries yet — save the Maintenance Request to begin tracking.</td></tr>';
        return;
      }
      el.innerHTML = rows.map(function(e) {
        var d   = new Date(e.created_at);
        var ds  = isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-CA') + ' ' + d.toLocaleTimeString('en-CA',{hour:'2-digit',minute:'2-digit'});
        var lbl = actionLabels[e.action] || e.action;
        // detail is a JSON blob {detail, name} written by auditEntry.
        var det = e.detail, who = e.actor || '—';
        try { var pj = JSON.parse(e.detail); if (pj && typeof pj === 'object') { det = pj.detail || ''; if (pj.name) who = pj.name; } } catch(err) {}
        return '<tr class="row-divider">'
          + '<td style="padding:8px 14px;font-size:11px;color:var(--muted);white-space:nowrap;">' + ds + '</td>'
          + '<td style="padding:8px 14px;font-size:12px;font-weight:600;white-space:nowrap;">' + escapeHtml(lbl) + '</td>'
          + '<td style="padding:8px 14px;font-size:12px;color:var(--text);">' + escapeHtml(det || '—') + '</td>'
          + '<td style="padding:8px 14px;font-size:11px;color:var(--muted);white-space:nowrap;">' + escapeHtml(who) + '</td>'
          + '</tr>';
      }).join('');
    })
    .catch(function(e){ console.warn('[sow audit] load failed:', e); });
}
function renderUnitScoreTable(){
  var tbody=document.getElementById('unit_score_tbody');
  if(!tbody)return;
  var model=getUnitScoreModel();
  var maxScore=0;
  ['bed','acc','eld'].forEach(function(g){
    var maxInGroup=Math.max.apply(null,model.filter(function(r){return r.group===g;}).map(function(r){return r.pts;}));
    if(maxInGroup>0)maxScore+=maxInGroup;
  });
  var maxEl=document.getElementById('unit_score_max');
  if(maxEl)maxEl.textContent=String(maxScore);
  var prevFactor='';
  tbody.innerHTML=model.map(function(row){
    var isNew=row.factor!==prevFactor;
    prevFactor=row.factor;
    var rowStyle='border-bottom:1px solid var(--border);'+(isNew&&prevFactor!==model[0].factor?'border-top:2px solid var(--border);':'');
    var ptsColor=row.pts>0?'var(--success)':row.pts<0?'var(--danger)':'var(--gray)';
    var ptsDisplay=(row.pts>0?'+':'')+row.pts;
    return '<tr style="'+rowStyle+'">'
      +'<td style="padding:9px 12px;font-size:13px;font-weight:600;color:var(--text);">'+(isNew?row.factor:'')+'</td>'
      +'<td style="padding:9px 12px;font-size:13px;color:var(--muted);">'+row.condition+'</td>'
      +'<td style="padding:9px 12px;text-align:center;">'
        +(row.editable
          ?'<input type="number" data-usm-id="'+row.id+'" value="'+row.pts+'" step="1" min="-20" max="30"'
            +' style="width:60px;text-align:center;padding:4px 6px;border:1px solid var(--border);border-radius:6px;font-size:13px;font-weight:700;color:'+ptsColor+';background:var(--surface);"'
            +' data-usm-onchange="1"/>'
          :'<span style="font-size:13px;font-weight:700;color:'+ptsColor+';">'+ptsDisplay+'</span>')
      +'</td>'
      +'<td style="padding:9px 12px;font-size:11px;color:var(--muted);">'+row.notes+'</td>'
      +'</tr>';
  }).join('');
  tbody.querySelectorAll('[data-usm-onchange]').forEach(function(inp){
    inp.addEventListener('change',function(){
      updateUnitScorePts(inp.getAttribute('data-usm-id'),inp.value);
    });
  });
}
// Single refresh point for all app-facing tables. Call this after any
// operation that changes application or unit status so every visible
// surface (dashboard stats, dashboard table, worklist) stays in sync.
function _refreshAppViews() {
  if (typeof updateDashStats  === 'function') updateDashStats();
  if (typeof renderDashTable  === 'function') renderDashTable();
  if (typeof renderWorklist   === 'function') renderWorklist();
}
window._refreshAppViews = _refreshAppViews;

// ── renderWorklist — landing-page action queue ──────────────────────────────
// Shows ONLY items requiring action across all entity types, grouped by type.
// Auto-updates when called after any approval/action (all callsites that
// trigger after status changes already call this function).
// Field Employees only see in-house work orders assigned to them (the logged-in
// key person). Returns true when the given SOW should be HIDDEN from the current
// user; non-field roles always see everything. Nation-agnostic — keys off the
// SOW's assignment fields and the session email.
function sowHiddenFromCurrentFieldEmployee(sow){
  var role = window._viewAsRole || window._realRole || window.currentRole || '';
  if(role !== 'field_employee') return false;
  if(!sow) return true;
  if((sow.assignedTeam || sow.assigned_team || '') !== 'in_house') return true;
  var email = ((window.HOUSING_SESSION && HOUSING_SESSION.email) || '').toLowerCase();
  var to    = (sow.assignedTo || sow.assigned_to || '').toLowerCase();
  return !(email && to && email === to);
}
window.sowHiddenFromCurrentFieldEmployee = sowHiddenFromCurrentFieldEmployee;

// ── Worklist collectors ──────────────────────────────────────────────────
// Pure data-collection helpers for renderWorklist. Each takes the shared
// context object computed ONCE by the orchestrator ({role, email, myName,
// apps, isManagement, canFinal}) and returns its section's items. No DOM
// writes here — all rendering stays in renderWorklist.

// ── 0. My Drafts — items the current user started but hasn't submitted ───
// Shown for ALL roles so an employee, HM, or ED can find and continue
// their own in-progress work without navigating to another page.
// Super User bypasses the "started by me" filter entirely — it aggregates
// every staff member's outstanding drafts (each row tagged with a `by`
// preparer so the multi-person list stays legible), per the ED's request
// to use Super User as a nation-wide "everything outstanding" view.
function _wlCollectDrafts(ctx) {
  var email = ctx.email, myName = ctx.myName, apps = ctx.apps;
  var isSuperUser = !!ctx.isSuperUser;
  var draftApps = apps.filter(function(a) {
    if (!a || a.archived || a.status !== 'draft') return false;
    if (isSuperUser) return true;
    return (a.created_by_email || '').toLowerCase() === email;
  }).slice(0, isSuperUser ? 20 : 8);
  if (isSuperUser) {
    draftApps.forEach(function(a){ a._wlBy = a.created_by_email || ''; });
  }

  var draftSows = [];
  if (isSuperUser || email || myName) {
    var sowCache = window._sowCache || {};
    Object.keys(sowCache).forEach(function(uid) {
      var list = (typeof getUnitSowList === 'function') ? getUnitSowList(uid) : [];
      list.forEach(function(sow) {
        if (!sow || sow.archived) return;              // skip archived drafts
        var status = sow.approval_status || '';
        if (status && status !== 'draft') return;       // skip submitted/approved
        var prep = (sow.preparedBy || sow.prepared_by || '').trim();
        if (!isSuperUser) {
          if (!prep || (myName && prep !== myName)) return;
        }
        var u = (ctx.unitById || {})[uid];
        var addr = u ? ((u.num||'') + ' ' + (u.street||'')).trim() : uid;
        draftSows.push({ uid: uid, pn: sow.project_number || '', addr: addr, by: isSuperUser ? prep : '' });
      });
    });
    draftSows = draftSows.slice(0, isSuperUser ? 15 : 6);
  }

  var draftRfqs = [];
  if ((isSuperUser || email) && (typeof moduleOn !== 'function' || moduleOn('rfq'))) {
    var rfqCache = window._rfqCache || {};
    Object.keys(rfqCache).forEach(function(rfqId) {
      var rfq = rfqCache[rfqId];
      if (!rfq || rfq.status !== 'draft') return;
      if (!isSuperUser && (rfq.created_by || '').toLowerCase() !== email) return;
      var u = (ctx.unitById || {})[rfq.sow_unit_id];
      var addr = u ? ((u.num||'') + ' ' + (u.street||'')).trim() : (rfq.sow_unit_id||'');
      draftRfqs.push({ id: rfqId, addr: addr, by: isSuperUser ? (rfq.created_by || '') : '' });
    });
    draftRfqs = draftRfqs.slice(0, isSuperUser ? 15 : 6);
  }

  return { draftApps: draftApps, draftSows: draftSows, draftRfqs: draftRfqs };
}

// ── 1. Applications requiring action ────────────────────────────────────
// Keep the FULL filtered list so the "+N more" overflow under the section is
// computed from the same role-gated filter as the rows themselves (it used
// to be re-derived from a role-blind 3-status filter, over- and
// under-counting).
function _wlCollectApps(ctx) {
  var email = ctx.email, isManagement = ctx.isManagement, canFinal = ctx.canFinal, apps = ctx.apps;
  var appItemsAll = apps.filter(function(a) {
    if (!a || a.archived) return false;
    // Commercial (business/department) applications are non-scored and reviewed
    // from the Applications list, not this scored worklist queue.
    if (a.appType === 'commercial') return false;
    var owner = (a.created_by_email || '').toLowerCase();
    if (owner === email && a.status === 'returned') return true;
    if (isManagement && !canFinal && (a.status === 'submitted' || a.status === 'file_update' || a.status === 'mgr_approved' || a.status === 'transfer_request_submitted')) return true;
    if (canFinal && (a.status === 'mgr_approved' || a.status === 'submitted' || a.status === 'file_update' || a.status === 'transfer_request_submitted')) return true;
    return false;
  });
  var appItems = appItemsAll.slice(0, 10);
  return { appItemsAll: appItemsAll, appItems: appItems };
}

// ── 2. SOWs awaiting the logged-in user's approval ──────────────────────
// Stored approval_status values: ''/'draft'/'signed' = needs HM review,
// 'hm_approved' = needs ED final approval. 'ed_approved'/'completed' = done.
function _wlCollectSows(ctx) {
  var canFinal = ctx.canFinal;
  var sowItems = [];
  if (ctx.isManagement) {
    var sowCache2 = window._sowCache || {};
    Object.keys(sowCache2).forEach(function(uid) {
      var list = (typeof getUnitSowList === 'function') ? getUnitSowList(uid) : [];
      list.forEach(function(sow) {
        if (!sow || !sow.items || !sow.items.length) return; // no content
        // Cancelled and archived requests are terminal — they keep their
        // pre-cancel approval_status by design (see CLAUDE.md), so without
        // this check a cancelled 'submitted' MR stayed in the approval queue
        // with a live Approve button.
        if (sow.cancelled || sow.archived) return;
        var status = sow.approval_status || '';
        if (status === 'ed_approved' || status === 'completed') return; // already done
        // A draft the current user prepared already shows under "My Drafts" — it
        // hasn't been submitted for approval, so don't also list it here (this was
        // showing the creator's own draft in both sections). Mirrors the
        // _wlCollectDrafts inclusion rule (status ''/draft + prepared by me).
        if (status === '' || status === 'draft') {
          var _prep = (sow.preparedBy || sow.prepared_by || '').trim();
          if (ctx.myName && _prep === ctx.myName) return;
        }
        // HM sees SOWs not yet HM-approved (needs their review)
        var needsHm = !canFinal && (status === '' || status === 'draft' || status === 'signed' || status === 'submitted');
        // ED sees SOWs at HM-approved stage ONLY when the cost is over the HM
        // budget limit (under the limit, HM approval is final and ED is not in
        // the chain) -- or earlier-stage SOWs the ED chooses to act on directly.
        var needsEd = canFinal && (
          (status === 'hm_approved' && sowRequiresEdApproval(sow)) ||
          status === '' || status === 'draft' || status === 'signed' || status === 'submitted'
        );
        if (!needsHm && !needsEd) return;
        var u = (ctx.unitById || {})[uid];
        var addr = u ? ((u.num||'') + ' ' + (u.street||'')).trim() : uid;
        sowItems.push({ uid: uid, pn: sow.project_number || '', addr: addr, status: status,
          amount:     (typeof sow.amount === 'number' ? sow.amount : (parseFloat(String(sow.totalCost||'').replace(/[^0-9.\-]/g,'')) || 0)),
          contractor: (sow.assignedTeam === 'in_house' ? (sow.assignedToName || 'In-house crew') : (sow.contractor || '')),
          itemCount:  (sow.items && sow.items.length) || 0 });
      });
    });
    // Keep a display cap of 8 rows, but remember the TRUE pending count so the
    // section header shows the real number and a "+N more" overflow link —
    // otherwise, with a backlog > 8, approving rows just refills the slots and
    // the "(8)" never moves, so it looks like approvals aren't clearing.
    var _fullCount = sowItems.length;
    sowItems = sowItems.slice(0, 8);
    sowItems._total = _fullCount;
  }
  return sowItems;
}

// ── 2b. Field Employee: approved work orders to execute ──────────────────
// Maintenance crew queue — SOWs that HM/ED have approved and that aren't yet
// completed, i.e. the work the crew can go do now and then mark complete.
function _wlCollectFieldSows(ctx) {
  var fieldSowItems = [];
  if (ctx.role === 'field_employee') {
    var fsCache = window._sowCache || {};
    Object.keys(fsCache).forEach(function(uid) {
      var list = (typeof getUnitSowList === 'function') ? getUnitSowList(uid) : [];
      list.forEach(function(sow) {
        // Cancelled work orders are terminal — the crew must not see them.
        if (!sow || sow.archived || sow.cancelled) return;
        var status = sow.approval_status || '';
        if (status !== 'hm_approved' && status !== 'ed_approved') return; // approved, not completed
        if (sowHiddenFromCurrentFieldEmployee(sow)) return;               // in-house + assigned to me
        var u = (ctx.unitById || {})[uid];
        var addr = u ? ((u.num||'') + ' ' + (u.street||'')).trim() : uid;
        fieldSowItems.push({ uid: uid, pn: sow.project_number || '', addr: addr, status: status });
      });
    });
    fieldSowItems = fieldSowItems.slice(0, 12);
  }
  return fieldSowItems;
}

// ── 3. RFQs needing action ───────────────────────────────────────────────
function _wlCollectRfqs(ctx) {
  var rfqItems = [];
  if (ctx.isManagement && (typeof moduleOn !== 'function' || moduleOn('rfq'))) {
    var rfqCache = window._rfqCache || {};
    Object.keys(rfqCache).forEach(function(rfqId) {
      var rfq = rfqCache[rfqId]; if (!rfq) return;
      if (rfq.status !== 'issued') return;
      var u = (ctx.unitById || {})[rfq.sow_unit_id];
      var addr = u ? ((u.num||'') + ' ' + (u.street||'')).trim() : (rfq.sow_unit_id||'');
      var closes = rfq.closes_at ? new Date(rfq.closes_at).toLocaleDateString('en-CA') : '';
      rfqItems.push({ id: rfqId, addr: addr, closes: closes, recipients: (rfq.recipient_contractor_ids||[]).length,
        bids: Object.keys((rfq.data && rfq.data.bids) || {}).length, sowPn: rfq.sow_project_number || '' });
    });
    rfqItems = rfqItems.slice(0, 6);
  }
  return rfqItems;
}

// ── 4. Contractors awaiting the logged-in user's approval ────────────────
// Contractor status values: 'pending_review' = needs recommend/verify,
// 'hm_recommended' = needs final approval (HM or ED). Bucket off the real
// contractor authorities (not the application-level canFinal): a recommender
// (HE-L2/HM) sees pending_review; a final approver (HM/ED) sees hm_recommended
// (and pending_review directly only if they cannot recommend — i.e. the ED).
function _wlCollectContractors(ctx) {
  var role = ctx.role;
  var ctItems = [];
  if (ctx.isManagement) {
    var canRecommendCt = typeof APPROVAL_AUTHORITY !== 'undefined' && APPROVAL_AUTHORITY.can('recommendContractor', role);
    var canApproveCt   = typeof APPROVAL_AUTHORITY !== 'undefined' && APPROVAL_AUTHORITY.can('approveContractor', role);
    var cts = window._contractors || [];
    cts.forEach(function(ct) {
      if (!ct) return;
      var st = ct.status;
      var needsRecommend = canRecommendCt && st === 'pending_review';
      var needsApprove   = canApproveCt && (st === 'hm_recommended' || (st === 'pending_review' && !canRecommendCt));
      if (!needsRecommend && !needsApprove) return;
      ctItems.push({ id: ct.id, name: ct.name || ct.id, trade: ct.trade || '', status: ct.status, submitted: ct.submittedAt || '' });
    });
    ctItems = ctItems.slice(0, 6);
  }
  return ctItems;
}

// ── Shared "which vacant units fit this applicant?" scorer ────────────────
// Single source for bedroom-fit + accessibility + Elders-unit scoring, so the
// Match page (bestUnit() in housing-views.js, which delegates here) and the
// worklist's Ready to Match section (below) score/filter applicants against
// real inventory identically. Mirrors the hard "2+ bedrooms oversized needs
// ED approval" rule enforced in confirmAssignment() (housing-init.js) via the
// same -50 penalty, without excluding the unit outright — an oversized unit
// is still "a match" that exists, just one requiring escalation. Returns
// every eligible vacant unit scored and sorted best-first (an empty array if
// none are eligible at all).
function matchScoreCandidateUnits(app) {
  var allUnits = getAllUnits();
  var vacantUnits = allUnits.filter(function(u){ return u && u.status === 'vacant' && !u.archived; });
  var needsBeds = 1;
  if (app.habitants) needsBeds = Math.max(1, 1 + (app.coApp ? 1 : 0) + app.habitants.length);
  var needsAccess = app.accessibility && app.accessibility !== 'None' && app.accessibility !== '0' && app.accessibility !== 0;
  var age = app.dob ? Math.floor((new Date().getTime() - new Date(app.dob).getTime()) / (365.25*24*3600*1000)) : 0;
  var eldersMin = (window._appSettings && window._appSettings.eldersAgeMin) || 65;
  var isElders = age >= eldersMin;
  var eligible = isElders ? vacantUnits : vacantUnits.filter(function(u){ return !u.isElders; });
  return eligible.map(function(u){
    var sc = 0;
    if (u.bedrooms === needsBeds)          sc += 10;
    else if (u.bedrooms === needsBeds + 1) sc += 5;
    else if (u.bedrooms === needsBeds - 1) sc += 3;
    else if (u.bedrooms >= needsBeds + 2)  sc -= 50;
    if (needsAccess && u.accessible)  sc += 8;
    if (needsAccess && !u.accessible) sc -= 4;
    if (isElders && u.isElders) sc += 6;
    return { unit: u, score: sc, maxPossible: 24 };
  }).sort(function(a, b){ return b.score - a.score; });
}
// Independent, non-exclusive "best unit for this applicant in isolation"
// lookup — used for eligibility checks (e.g. Match Priority's hasMatchBonus)
// where the question is "does a suitable unit category exist at all", not
// "which specific unit is theirs" — so it must NOT depend on allocation
// order (that would make ranking circular, since ranking order also decides
// allocation order — see matchAllocateExclusive below).
function matchBestUnit(app) {
  return matchScoreCandidateUnits(app)[0] || null;
}
// ── Shared "who gets matched first" placement-order score ─────────────────
// Combines "has a matching unit" + that unit's Assignment Type + reserve
// status + current-house status on top of the raw need score (see
// liveMatchPriorityModel, scoring.js) so ranking/allocation order is
// identical everywhere it's used. The Match page (_matchPriorityOf() in
// housing-views.js, which delegates here) and the worklist's Ready to Match
// section both need the SAME order — otherwise the same applicant could get
// a different Best Unit recommendation (or Unmatched status) depending on
// which page shows them, since matchAllocateExclusive's result depends on
// the order applicants are walked in. opts.hasHouse lets a caller that has
// already resolved a fuller current-tenancy cross-reference (the Match
// page's _currentTenancyAddr, built from occupied/reserved units) pass a
// more accurate value in; callers without that context (the worklist) fall
// back to the simpler assignedUnit/transfer_request check.
function matchPriorityOf(app, opts) {
  opts = opts || {};
  var w = window.liveMatchPriorityModel || DEFAULT_MATCH_PRIORITY_MODEL;
  var best = matchBestUnit(app);
  var hasMatch = !!best;
  var assignType = (best && best.unit) ? (best.unit.assignmentType||'') : '';
  var isTemporary = assignType === 'temporary';
  var isTransition = assignType === 'transition';
  var onReserve = !isTransition && app.reserve === 'On Reserve';
  var hasHouseReal = opts.hasHouse != null ? opts.hasHouse : !!(app.assignedUnit || app.appType === 'transfer_request');
  var hasHouse = isTransition || hasHouseReal;
  var bonus = (hasMatch ? (w.hasMatchBonus||0) : 0)
            + (isTemporary ? (w.temporaryBonus||0) : 0)
            + (onReserve ? (w.onReserveBonus||0) : 0)
            + (!hasHouse ? (w.noHouseBonus||0) : 0);
  return bonus + (app.score||0);
}
// ── Exclusive one-unit-per-applicant allocation ───────────────────────────
// matchBestUnit() scores each applicant against inventory in isolation, so
// two different applicants can each be told the SAME still-vacant unit is
// their best match before either is actually assigned. This walks a list of
// applicants already in PRIORITY ORDER (caller decides it — Match Priority
// order on the Match page, raw score on the worklist) and greedily claims
// each one's best still-unclaimed vacant unit, so a unit only ever "belongs"
// to one recommendation at a time. An applicant whose eligible units were
// all claimed by higher-priority applicants ahead of them gets null here
// (render this as "Unmatched"), even though matchBestUnit() would have found
// them a unit in isolation. Real assignment is unaffected — this only
// governs what gets shown as a *recommendation*; staff can still manually
// assign any vacant unit via the Assign modal, which lists all of them.
// Returns a map of appId -> {unit,score,maxPossible} or null.
function matchAllocateExclusive(orderedApps) {
  var claimed = {};
  var result = {};
  (orderedApps || []).forEach(function(app) {
    var candidates = matchScoreCandidateUnits(app);
    var pick = null;
    for (var i = 0; i < candidates.length; i++) {
      if (!claimed[candidates[i].unit.id]) { pick = candidates[i]; break; }
    }
    if (pick) claimed[pick.unit.id] = true;
    result[app.id] = pick;
  });
  return result;
}

// ── 5. Approved apps ready to match (no unit assigned) ───────────────────
// Uses the shared appIsAssignable() (the same eligibility rule the Match
// page, confirmAssignment, the unit-edit gate, and the Add-Tenant modal all
// use) so an hm_approved application shows up here exactly when it's
// assignable everywhere else — this list used to hand-check only
// ed_approved/mgr_approved and silently never surfaced hm_approved apps.
// Commercial apps are excluded — they're assigned to buildings via their own
// review modal, never the residential Match queue. existing_tenant "file
// update" records are excluded too — they're not housing requests and are
// never scored/ranked, same rule as the Match page's own filter (they used
// to be able to slip in here if one happened to carry an approved status).
// An applicant with no suitable vacant unit is still included (not filtered
// out) — their card renders an "Unmatched" status instead of a Best Unit;
// see matchAllocateExclusive below, which also ensures two applicants here
// never both show the SAME still-vacant unit as their recommendation.
function _wlCollectMatch(ctx) {
  var matchItems = [];
  if (ctx.isManagement) {
    matchItems = ctx.apps.filter(function(a) {
      if (!a || a.assignedUnit) return false;
      if (a.appType === 'existing_tenant') return false;
      return (typeof appIsAssignable === 'function')
        ? appIsAssignable(a)
        : (!a.archived && a.appType !== 'commercial' && (a.status === 'ed_approved' || a.status === 'mgr_approved' || a.status === 'hm_approved'));
    })
    // Rank by Match Priority (the same shared matchPriorityOf() formula the
    // full Match page uses for its own allocation order) rather than raw
    // score alone -- otherwise this list and the Match page could rank the
    // same two applicants differently and hand out conflicting Best Unit
    // recommendations. Sort BEFORE the cap so the top 6 shown are the top 6
    // by priority, and BEFORE matchAllocateExclusive so allocation walks
    // applicants in that same order.
    .sort(function(a, b) { return matchPriorityOf(b) - matchPriorityOf(a); })
    .slice(0, 6);
  }
  return matchItems;
}

// ── 6. Inventory / unit approvals pending ────────────────────────────────
// Shows units where an HM or ED approval decision has been initiated but
// not yet set (decision field is blank). HM sees their pending block;
// ED sees ED-pending items and any HM-deferred items.
function _wlCollectUnitApprovals(ctx) {
  var canFinal = ctx.canFinal;
  var unitApprItems = [];
  if (ctx.isManagement) {
    var allUnitsAppr = (typeof housingUnits !== 'undefined' && housingUnits) ? housingUnits : [];
    allUnitsAppr.forEach(function(u) {
      if (!u) return;
      var needsHm = !canFinal && u.unitHmSig && !u.unitHmSig.decision;
      var needsEd = canFinal && (
        (u.unitEdSig && !u.unitEdSig.decision) ||
        (u.unitHmSig && u.unitHmSig.decision === 'deferred')
      );
      if (!needsHm && !needsEd) return;
      var addr = ((u.num||'') + ' ' + (u.street||'')).trim() || u.id;
      var lbl = needsEd
        ? (u.unitHmSig && u.unitHmSig.decision === 'deferred' ? 'Deferred to ED' : 'Awaiting ED Decision')
        : 'Awaiting HM Decision';
      unitApprItems.push({ id: u.id, addr: addr, lbl: lbl });
    });
    unitApprItems = unitApprItems.slice(0, 8);
  }
  return unitApprItems;
}

function renderWorklist() {
  var body = document.getElementById('worklist_body');
  if (!body) return;
  var role  = window._viewAsRole || window._realRole || window.currentRole || 'housing_employee_l1';
  var email = (typeof HOUSING_SESSION !== 'undefined' && HOUSING_SESSION ? HOUSING_SESSION.email : '').toLowerCase();
  var isManagement = typeof ROLE !== 'undefined' && ROLE.isManagement(role);
  var canFinal     = typeof APPROVAL_AUTHORITY !== 'undefined' && APPROVAL_AUTHORITY.can('finalApproveApp', role);
  // Super User is a nation-wide "everything outstanding" view — it aggregates
  // every staff member's drafts instead of scoping "My Drafts" to the actual
  // logged-in person (see _wlCollectDrafts).
  var isSuperUser  = (role === 'super_user');

  var myName = (typeof HOUSING_SESSION !== 'undefined' && HOUSING_SESSION ? HOUSING_SESSION.name : '') || '';
  var apps   = (typeof applications !== 'undefined' && applications) ? applications : [];

  // Shared context — computed ONCE and passed to every collector. unitById
  // replaces the per-item housingUnits.find() scans the collectors used to do.
  var unitById = {};
  (typeof housingUnits !== 'undefined' && housingUnits ? housingUnits : []).forEach(function(u){ if (u && u.id != null) unitById[u.id] = u; });
  var ctx = { role: role, email: email, myName: myName, apps: apps, isManagement: isManagement, canFinal: canFinal, isSuperUser: isSuperUser, unitById: unitById };

  var _drafts       = _wlCollectDrafts(ctx);
  var draftApps     = _drafts.draftApps;
  var draftSows     = _drafts.draftSows;
  var draftRfqs     = _drafts.draftRfqs;
  var _wlApps       = _wlCollectApps(ctx);
  var appItemsAll   = _wlApps.appItemsAll;
  var appItems      = _wlApps.appItems;
  var sowItems      = _wlCollectSows(ctx);
  var fieldSowItems = _wlCollectFieldSows(ctx);
  var rfqItems      = _wlCollectRfqs(ctx);
  var ctItems       = _wlCollectContractors(ctx);
  var matchItems    = _wlCollectMatch(ctx);
  var unitApprItems = _wlCollectUnitApprovals(ctx);
  // ── Inline archive helpers (exposed on window so onclick can reach them) ──
  window._wlArchiveSow = function(uid, pn) {
    if (typeof showConfirm !== 'function') return;
    showConfirm({ title: 'Archive this draft request?', message: 'Project ' + pn + ' will be hidden. You can restore it from the Unit Detail Panel.', confirmText: 'Archive' }).then(function(ok) {
      if (!ok) return;
      if (typeof archiveSow === 'function') archiveSow(uid, pn, window.currentRole || 'staff');
      if (typeof auditEntry === 'function') auditEntry('SOW:'+uid, 'sow_archived', 'SOW '+pn+' archived from worklist', window.currentRole||'staff');
      renderWorklist();
    });
  };
  window._wlArchiveApp = function(appId) {
    if (typeof showConfirm !== 'function') return;
    var apps2 = (typeof applications !== 'undefined' && applications) ? applications : [];
    var app = apps2.find(function(a){ return a && a.id === appId; });
    var name = app ? (((app.fn||'') + ' ' + (app.ln||'')).trim() || appId) : appId;
    showConfirm({ title: 'Archive this draft application?', message: name + ' will be archived and removed from your worklist.', confirmText: 'Archive' }).then(function(ok) {
      if (!ok) return;
      if (app) { app.archived = true; if (typeof saveApplicationWithDraftFallback === 'function') saveApplicationWithDraftFallback(app); }
      renderWorklist();
    });
  };
  window._wlCancelRfq = function(rfqId) {
    if (typeof showConfirm !== 'function') return;
    showConfirm({ title: 'Cancel this draft RFQ?', message: rfqId + ' will be cancelled and removed from your worklist.', confirmText: 'Cancel RFQ', danger: true }).then(function(ok) {
      if (!ok) return;
      var rfqCache2 = window._rfqCache || {};
      var rfq = rfqCache2[rfqId];
      if (rfq) {
        rfq.status = 'cancelled';
        fetch(SUPABASE_URL + '/rest/v1/housing_rfq?id=eq.' + encodeURIComponent(rfqId), {
          method: 'PATCH', headers: Object.assign({}, HOUSING_HEADERS, {'Prefer':'return=minimal'}),
          body: JSON.stringify({ status: 'cancelled' })
        }).catch(function(e){ console.warn('[wl rfq cancel]', e); });
      }
      renderWorklist();
    });
  };

  // ── Count + empty state ───────────────────────────────────────────────────
  // fieldSowItems MUST be in the total: a field employee is not management, so
  // every other bucket is empty for them — omitting it made their entire
  // "Work Orders to Complete" queue hit the empty-state early return below.
  var draftTotal = draftApps.length + draftSows.length + draftRfqs.length;
  // Use the TRUE pending-SOW count (not the 8-row display cap) so the header
  // badge reflects the real backlog and visibly decreases as SOWs are approved.
  var sowTotalCount = (typeof sowItems._total === 'number') ? sowItems._total : sowItems.length;
  // Tenant-reported maintenance requests awaiting staff review (management only).
  var tenantMrCount = isManagement ? (window._tenantMrSubmissions || []).length : 0;
  var appSubCount   = isManagement ? (window._appSubmissions || []).length : 0;
  var total = appItems.length + sowTotalCount + fieldSowItems.length + rfqItems.length + ctItems.length + matchItems.length + unitApprItems.length + draftTotal + tenantMrCount + appSubCount;
  var pill = document.getElementById('worklist_count_pill'); if (pill) pill.textContent = total;
  var qa   = document.getElementById('qa_pending_count');   if (qa) qa.textContent = total;

  if (!total) {
    body.innerHTML = '<div style="padding:28px 16px;text-align:center;color:var(--muted);font-size:13px;">'
      + '<div style="font-size:22px;margin-bottom:8px;">&#10003;</div>'
      + 'Nothing requires your attention right now.</div>';
    return;
  }

  // ── Render helpers ────────────────────────────────────────────────────────
  function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }

  function sectionWrap(icon, label, count, link, rows, extra) {
    return '<div style="margin-bottom:12px;">'
      + '<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 14px;'
      +   'background:var(--bg);border-radius:8px 8px 0 0;border:1px solid var(--border);">'
      +   '<div style="font-size:12px;font-weight:700;">' + icon + ' ' + esc(label)
      +     ' <span style="font-size:11px;font-weight:400;color:var(--muted);">(' + count + ')</span></div>'
      +   (link ? '<a href="' + esc(link) + '" style="font-size:11px;color:var(--text);font-weight:600;'
      +     'text-decoration:none;border:1px solid var(--border);border-radius:6px;padding:3px 9px;'
      +     'white-space:nowrap;">View All &#8599;</a>' : '')
      + '</div>'
      + '<div style="border:1px solid var(--border);border-top:none;border-radius:0 0 8px 8px;overflow:hidden;">'
      + rows
      + (extra > 0 ? '<div style="padding:7px 14px;font-size:11px;color:var(--muted);text-align:center;'
      +   'border-top:1px solid var(--border);">+' + extra + ' more — <a href="' + esc(link) + '" '
      +   'style="color:var(--text);font-weight:600;">View All</a></div>' : '')
      + '</div></div>';
  }

  function actionRow(href, cols, btn, navRef) {
    // Row = info columns (clickable link) + yellow action button on the right.
    // navRef (optional): a CLFN_PAGE_ROUTES key stamped as the nav referrer on
    // click, so CLOSING the deep-link-opened destination modal returns here.
    var refOnclick = navRef ? ' onclick="if(typeof setNavReferrer===\'function\')setNavReferrer(\'' + navRef + '\')"' : '';
    return '<div style="display:flex;align-items:center;gap:8px;padding:9px 14px;'
      + 'border-top:1px solid var(--border);background:var(--surface);" '
      + 'onmouseover="this.style.background=\'var(--bg)\'" '
      + 'onmouseout="this.style.background=\'var(--surface)\'">'
      + '<a href="' + esc(href) + '"' + refOnclick + ' style="display:flex;align-items:center;gap:10px;flex:1;min-width:0;text-decoration:none;color:inherit;">'
      + cols.map(function(c){ return '<span style="' + (c.style||'flex:1;font-size:12px;') + '">' + esc(c.text||'') + '</span>'; }).join('')
      + '</a>'
      + '<a href="' + esc((btn && btn.href) || href) + '"' + refOnclick + ' '
      + 'style="flex-shrink:0;background:var(--yellow);color:var(--dark);border-radius:6px;'
      + 'padding:5px 12px;font-size:11px;font-weight:700;font-family:DM Sans,sans-serif;'
      + 'text-decoration:none;white-space:nowrap;display:inline-block;">'
      + esc((btn && btn.text) || 'Open') + '</a>'
      + '</div>';
  }

  // ── View mode (List vs Cards) — persisted per device, defaults to Cards ────
  var _view = (function(){ try { return localStorage.getItem('clfn_worklist_view') === 'list' ? 'list' : 'cards'; } catch(e){ return 'cards'; } })();
  window._wlSetView = function(v){
    try { localStorage.setItem('clfn_worklist_view', v === 'cards' ? 'cards' : 'list'); } catch(e){}
    renderWorklist();
    // Recent Activity shares this preference — re-render it too when present.
    if (typeof renderRecentActivity === 'function') {
      try { renderRecentActivity(window._viewAsRole || window._realRole || window.currentRole || 'housing_employee_l1'); } catch(e){}
    }
  };
  function _wlToggleBar(){
    function b(v, label, icon){
      var on = _view === v;
      return '<button type="button" onclick="_wlSetView(\'' + v + '\')" style="display:flex;align-items:center;gap:5px;padding:5px 12px;'
        + 'border:1px solid ' + (on ? 'var(--yellow)' : 'var(--border)') + ';background:' + (on ? 'var(--yellow)' : 'var(--surface)') + ';'
        + 'color:' + (on ? 'var(--dark)' : 'var(--muted)') + ';font-size:11px;font-weight:700;font-family:DM Sans,sans-serif;cursor:pointer;'
        + 'border-radius:' + (v === 'list' ? '7px 0 0 7px' : '0 7px 7px 0') + ';' + (v === 'cards' ? 'margin-left:-1px;' : '') + '">' + icon + ' ' + label + '</button>';
    }
    return '<div style="display:flex;justify-content:flex-end;margin-bottom:10px;"><div style="display:flex;">'
      + b('list', 'List', '&#9776;') + b('cards', 'Cards', '&#9638;') + '</div></div>';
  }

  // Card renderers (used when _view === 'cards'). wlGrid lays cards out
  // responsively inside a section; wlCard builds one tile with a title, an
  // optional status pill, label:value meta rows, and one or two action buttons.
  function wlGrid(cards){ return '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(232px,1fr));gap:8px;padding:8px;background:var(--surface);">' + cards + '</div>'; }
  function wlPill(p){ if(!p || !p.text) return ''; return '<span style="flex-shrink:0;font-size:10px;font-weight:700;color:' + (p.color||'var(--muted)') + ';background:' + (p.bg||'var(--bg)') + ';border:1px solid var(--border);border-radius:20px;padding:2px 8px;white-space:nowrap;">' + esc(p.text) + '</span>'; }
  function wlCard(o){
    var metas = (o.metas||[]).filter(function(m){ return m && m.v != null && String(m.v) !== ''; }).map(function(m){
      return '<div style="display:flex;justify-content:space-between;gap:10px;font-size:11px;margin-top:4px;">'
        + '<span style="color:var(--muted);flex-shrink:0;">' + esc(m.k) + '</span>'
        + '<span style="color:var(--text);font-weight:600;text-align:right;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(m.v) + '</span></div>';
    }).join('');
    var badges = (o.badges||[]).join(' ');
    var actions = (o.actions||[]).map(function(a){
      return '<button type="button" onclick="' + a.onclick + '" style="flex:1;background:' + (a.ghost ? 'none' : 'var(--yellow)') + ';color:' + (a.ghost ? 'var(--muted)' : 'var(--dark)') + ';'
        + 'border:' + (a.ghost ? '1px solid var(--border)' : 'none') + ';border-radius:6px;padding:7px 10px;font-size:11px;font-weight:700;font-family:DM Sans,sans-serif;cursor:pointer;white-space:nowrap;">' + esc(a.text) + '</button>';
    }).join('');
    return '<div style="border:1px solid var(--border);border-radius:10px;background:var(--surface);padding:11px 12px;display:flex;flex-direction:column;">'
      + '<div ' + (o.open ? 'onclick="' + o.open + '"' : '') + ' style="cursor:' + (o.open ? 'pointer' : 'default') + ';">'
      +   '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;">'
      +     '<span style="font-size:13px;font-weight:700;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(o.title) + '</span>'
      +     wlPill(o.pill)
      +   '</div>'
      +   (badges ? '<div style="margin-top:4px;">' + badges + '</div>' : '')
      +   metas
      + '</div>'
      + (actions ? '<div style="display:flex;gap:6px;margin-top:10px;">' + actions + '</div>' : '')
      + '</div>';
  }
  var _money = function(n){ return '$' + (Math.round((parseFloat(n)||0))).toLocaleString(); };
  var _appTypeLabel = { new_housing:'New Housing', existing_tenant:'File Update', transfer_request:'Transfer', commercial:'Commercial' };

  var html = _wlToggleBar();

  // Draft row with Continue + Archive buttons
  function draftRow(info, continueHref, continueOnclick, archiveOnclick) {
    var openAction = continueOnclick
      ? 'onclick="' + continueOnclick + '"'
      : 'href="' + esc(continueHref) + '"';
    return '<div style="display:flex;align-items:center;gap:6px;padding:9px 14px;border-top:1px solid var(--border);background:var(--surface);" '
      + 'onmouseover="this.style.background=\'var(--bg)\'" onmouseout="this.style.background=\'var(--surface)\'">'
      + '<a ' + openAction + ' style="display:flex;align-items:center;gap:10px;flex:1;min-width:0;text-decoration:none;color:inherit;">'
      + info
      + '</a>'
      + '<a ' + openAction + ' style="flex-shrink:0;background:var(--yellow);color:var(--dark);border-radius:6px;padding:5px 11px;font-size:11px;font-weight:700;font-family:DM Sans,sans-serif;text-decoration:none;white-space:nowrap;cursor:pointer;display:inline-block;">Continue &#8594;</a>'
      + '<button onclick="' + archiveOnclick + '" style="flex-shrink:0;background:none;border:1px solid var(--border);border-radius:6px;padding:5px 11px;font-size:11px;font-weight:600;font-family:DM Sans,sans-serif;color:var(--muted);cursor:pointer;white-space:nowrap;" title="Archive">&#128228; Archive</button>'
      + '</div>';
  }

  // Tenant Requests — maintenance issues reported by tenants via the scan-to-
  // report QR form (management review queue). Reviewing/approving seeds and
  // opens a real maintenance request for the unit.
  var tenantMrItems = isManagement ? (window._tenantMrSubmissions || []) : [];
  if (tenantMrItems.length) {
    var tmrRows = '', tmrCards = '';
    tenantMrItems.forEach(function(s){
      var idJs = esc(s.id).replace(/'/g, "\\'");
      var open = 'openTenantMrReview(\'' + idJs + '\')';
      var urg = (s.urgency || 'routine');
      var urgColor = urg === 'emergency' ? 'var(--danger)' : (urg === 'urgent' ? 'var(--warn-amber-text)' : 'var(--muted)');
      var info = '<span style="flex:1;font-size:12px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(s.unit_address || s.unit_id) + '</span>'
               + '<span style="font-size:11px;color:var(--muted);width:130px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(s.category || '—') + '</span>'
               + '<span style="font-size:10px;font-weight:800;color:' + urgColor + ';width:78px;flex-shrink:0;">' + esc(urg.toUpperCase()) + '</span>';
      tmrRows += '<div style="display:flex;align-items:center;gap:8px;padding:9px 14px;border-top:1px solid var(--border);background:var(--surface);" onmouseover="this.style.background=\'var(--bg)\'" onmouseout="this.style.background=\'var(--surface)\'">'
        + '<div onclick="' + open + '" style="display:flex;align-items:center;gap:10px;flex:1;min-width:0;cursor:pointer;">' + info + '</div>'
        + '<button onclick="' + open + '" style="flex-shrink:0;background:var(--yellow);color:var(--dark);border:none;border-radius:6px;padding:5px 12px;font-size:11px;font-weight:700;font-family:DM Sans,sans-serif;cursor:pointer;white-space:nowrap;">Review</button>'
        + '</div>';
      tmrCards += wlCard({ title: s.unit_address || s.unit_id, pill:{ text: urg.toUpperCase(), color: urgColor }, open: open,
        metas:[{k:'Category',v:s.category||'—'},{k:'Reported',v:s.description ? String(s.description).slice(0,60) : ''}],
        actions:[{text:'Review',onclick:open}] });
    });
    html += sectionWrap('📮', 'Tenant Requests', tenantMrItems.length, '', _view === 'cards' ? wlGrid(tmrCards) : tmrRows, 0);
  }

  // Application Submissions — housing applications submitted through the
  // applicant portal (management review queue). Approving creates the real
  // housing_applications record and links it to the applicant's account.
  var appSubItems = isManagement ? (window._appSubmissions || []) : [];
  if (appSubItems.length) {
    var asRows = '', asCards = '';
    var _asTypeLbl = { new:'New application', update:'Application update', transfer:'Transfer request' };
    var _asStatusLbl = { submitted:'New', in_review:'In review', changes_requested:'Returned' };
    appSubItems.forEach(function(s){
      var idJs = esc(s.id).replace(/'/g, "\\'");
      var open = 'openApplicationSubmissionReview(\'' + idJs + '\')';
      var p = s.payload || {};
      var nm = ([p.fn, p.ln].filter(Boolean).join(' ')) || 'Applicant';
      var typeLbl = _asTypeLbl[s.submission_type] || 'Application';
      var stLbl = _asStatusLbl[s.status] || s.status;
      var info = '<span style="flex:1;font-size:12px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(nm) + '</span>'
               + '<span style="font-size:11px;color:var(--muted);width:140px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(typeLbl) + '</span>'
               + '<span style="font-size:10px;font-weight:800;color:' + (s.status==='changes_requested'?'var(--warn-amber-text)':'var(--muted)') + ';width:64px;flex-shrink:0;">' + esc(String(stLbl).toUpperCase()) + '</span>';
      asRows += '<div style="display:flex;align-items:center;gap:8px;padding:9px 14px;border-top:1px solid var(--border);background:var(--surface);" onmouseover="this.style.background=\'var(--bg)\'" onmouseout="this.style.background=\'var(--surface)\'">'
        + '<div onclick="' + open + '" style="display:flex;align-items:center;gap:10px;flex:1;min-width:0;cursor:pointer;">' + info + '</div>'
        + '<button onclick="' + open + '" style="flex-shrink:0;background:var(--yellow);color:var(--dark);border:none;border-radius:6px;padding:5px 12px;font-size:11px;font-weight:700;font-family:DM Sans,sans-serif;cursor:pointer;white-space:nowrap;">Review</button>'
        + '</div>';
      asCards += wlCard({ title: nm, pill:{ text: stLbl }, open: open,
        metas:[{k:'Type',v:typeLbl},{k:'Submitted',v:s.submitted_at ? new Date(s.submitted_at).toLocaleDateString() : ''}],
        actions:[{text:'Review',onclick:open}] });
    });
    html += sectionWrap('📄', 'Application Submissions', appSubItems.length, '', _view === 'cards' ? wlGrid(asCards) : asRows, 0);
  }

  // My Drafts — in-progress items the current user hasn't submitted yet.
  // Super User sees every staff member's drafts (see _wlCollectDrafts), so
  // each row is tagged with who prepared it and the section is relabeled.
  if (draftTotal > 0) {
    var _draftPill = { text:'Draft', color:'var(--muted)', bg:'var(--bg)' };
    var draftRows = '', draftCards = '';
    draftApps.forEach(function(a) {
      var name = ((a.fn||'') + ' ' + (a.ln||'')).trim() || a.id;
      var idJs = esc(a.id).replace(/'/g,"\\'");
      var open = 'window.location.href=\'housing.html?openApp=' + encodeURIComponent(a.id) + '\'';
      var byTxt = isSuperUser && a._wlBy ? (' · by ' + a._wlBy) : '';
      var info = '<span style="flex:1;font-size:12px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(name) + '</span>'
               + '<span style="font-size:11px;color:var(--muted);width:' + (isSuperUser?160:100) + 'px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">Application' + esc(byTxt) + '</span>'
               + '<span style="font-size:11px;color:var(--muted);width:50px;text-align:right;flex-shrink:0;font-style:italic;">Draft</span>';
      draftRows += draftRow(info, 'housing.html?openApp=' + encodeURIComponent(a.id), null, '_wlArchiveApp(\'' + idJs + '\')');
      draftCards += wlCard({ title:name, pill:_draftPill, open:open, metas:[{k:'Type',v:'Application'}].concat(isSuperUser && a._wlBy ? [{k:'By',v:a._wlBy}] : []),
        actions:[{text:'Continue →',onclick:open},{text:'📥 Archive',ghost:true,onclick:'_wlArchiveApp(\'' + idJs + '\')'}] });
    });
    draftSows.forEach(function(s) {
      var sowOpen = 'if(typeof openSowModal===\'function\'){openSowModal(\'' + esc(s.uid).replace(/'/g,"\\'") + '\');}else{window.location.href=\'renos.html?sow=' + encodeURIComponent(s.uid) + '\';}';
      var sByTxt = isSuperUser && s.by ? (' · by ' + s.by) : '';
      var info = '<span style="flex:1;font-size:12px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(s.addr) + '</span>'
               + '<span style="font-size:11px;color:var(--muted);width:' + (isSuperUser?160:100) + 'px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc((s.pn || 'Request') + sByTxt) + '</span>'
               + '<span style="font-size:11px;color:var(--muted);width:50px;text-align:right;flex-shrink:0;font-style:italic;">Draft</span>';
      draftRows += draftRow(info, null, sowOpen, '_wlArchiveSow(\'' + esc(s.uid).replace(/'/g,"\\'") + '\',\'' + esc(s.pn).replace(/'/g,"\\'") + '\')');
      draftCards += wlCard({ title:s.addr, pill:_draftPill, open:sowOpen, metas:[{k:'Type',v:'Maintenance'},{k:'Project',v:s.pn||'Request'}].concat(isSuperUser && s.by ? [{k:'By',v:s.by}] : []),
        actions:[{text:'Continue →',onclick:sowOpen},{text:'📥 Archive',ghost:true,onclick:'_wlArchiveSow(\'' + esc(s.uid).replace(/'/g,"\\'") + '\',\'' + esc(s.pn).replace(/'/g,"\\'") + '\')'}] });
    });
    draftRfqs.forEach(function(r) {
      var idJs = esc(r.id).replace(/'/g,"\\'");
      var open = 'window.location.href=\'rfq.html?rfq=' + encodeURIComponent(r.id) + '\'';
      var rByTxt = isSuperUser && r.by ? (' · by ' + r.by) : '';
      var info = '<span style="font-size:12px;font-weight:600;width:130px;flex-shrink:0;">' + esc(r.id) + '</span>'
               + '<span style="flex:1;font-size:12px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(r.addr + rByTxt) + '</span>'
               + '<span style="font-size:11px;color:var(--muted);width:50px;text-align:right;flex-shrink:0;font-style:italic;">Draft</span>';
      draftRows += draftRow(info, 'rfq.html?rfq=' + encodeURIComponent(r.id), null, '_wlCancelRfq(\'' + idJs + '\')');
      draftCards += wlCard({ title:r.id, pill:_draftPill, open:open, metas:[{k:'Type',v:'RFQ'},{k:'Unit',v:r.addr}].concat(isSuperUser && r.by ? [{k:'By',v:r.by}] : []),
        actions:[{text:'Continue →',onclick:open},{text:'Cancel',ghost:true,onclick:'_wlCancelRfq(\'' + idJs + '\')'}] });
    });
    html += sectionWrap('✏️', isSuperUser ? 'All Staff Drafts' : 'My Drafts', draftTotal, '', _view==='cards' ? wlGrid(draftCards) : draftRows, 0);
  }

  // Applications
  if (appItems.length) {
    var appBtnText = { submitted:'Review', file_update:'Review', mgr_approved: canFinal ? 'Approve' : 'View', returned:'Edit', transfer_request_submitted:'Review' };
    var _wlReviewStatuses = ['submitted', 'file_update', 'mgr_approved', 'transfer_request_submitted'];
    var appRows = appItems.map(function(a) {
      var name  = ((a.fn||'') + ' ' + (a.ln||'')).trim() || a.id;
      var lbl   = formatAppStatusLabel(a.status, {variant:'worklist'}) || a.status;
      var score = (a.score != null && a.appType !== 'existing_tenant') ? (a.score + ' pts') : '';
      var btnHref = (_wlReviewStatuses.indexOf(a.status) >= 0)
        ? 'housing.html?openScorecard=' + encodeURIComponent(a.id)
        : 'housing.html?openApp=' + encodeURIComponent(a.id);
      return actionRow(btnHref, [
        { text: name, style: 'flex:1;font-size:12px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' },
        { text: lbl,  style: 'font-size:11px;color:var(--muted);width:170px;flex-shrink:0;' },
        { text: score,style: 'font-size:11px;color:var(--muted);width:55px;text-align:right;flex-shrink:0;' }
      ], { text: (appBtnText[a.status] || 'Open') + ' →', href: btnHref });
    }).join('');
    var appCards = appItems.map(function(a) {
      var name  = ((a.fn||'') + ' ' + (a.ln||'')).trim() || a.id;
      var lbl   = formatAppStatusLabel(a.status, {variant:'worklist'}) || a.status;
      var score = (a.score != null && a.appType !== 'existing_tenant') ? (a.score + ' pts') : '';
      var btnHref = (_wlReviewStatuses.indexOf(a.status) >= 0)
        ? 'housing.html?openScorecard=' + encodeURIComponent(a.id)
        : 'housing.html?openApp=' + encodeURIComponent(a.id);
      var open = 'window.location.href=\'' + btnHref + '\'';
      return wlCard({ title:name, pill:{text:lbl}, open:open,
        metas:[{k:'Type',v:_appTypeLabel[a.appType]||''},{k:'Score',v:score},{k:'Tier',v:(a.tier?a.tier.replace(' Priority',''):'')}],
        actions:[{text:(appBtnText[a.status]||'Open')+' →',onclick:open}] });
    }).join('');
    // Overflow = same filter as the rows (appItemsAll), just past the display cap.
    html += sectionWrap('📋', 'Applications', appItems.length, 'housing.html?view=worklist', _view==='cards' ? wlGrid(appCards) : appRows, Math.max(0, appItemsAll.length - appItems.length));
  }

  // SOWs
  if (sowItems.length) {
    var sowRows = sowItems.map(function(s) {
      // Open the SOW modal in-place on the current page when possible (housing.html
      // has openSowModal); fall back to navigating to renos.html only when needed.
      var btnText  = s.status === 'hm_approved' ? 'Final Approve' : 'Approve';
      var _uidJs   = escapeHtml(s.uid).replace(/'/g, "\\'");
      var _pnJs    = escapeHtml(s.pn || '').replace(/'/g, "\\'");
      var openCall = 'if(typeof openSowModal===\'function\'){openSowModal(\''
                   + _uidJs + '\');}'
                   + 'else{window.location.href=\'renos.html?sow=' + encodeURIComponent(s.uid) + '\';}';
      // The Approve button approves the specific request in place (single confirm,
      // no modal). Falls back to opening the modal where _wlApproveSow isn't
      // loaded (e.g. renos.html without housing-modals-sow.js).
      var approveCall = 'event.stopPropagation();if(typeof _wlApproveSow===\'function\'){_wlApproveSow(\''
                   + _uidJs + '\',\'' + _pnJs + '\');}else{' + openCall + '}';
      return '<div style="display:flex;align-items:center;gap:8px;padding:9px 14px;border-top:1px solid var(--border);background:var(--surface);" '
        + 'onmouseover="this.style.background=\'var(--bg)\'" onmouseout="this.style.background=\'var(--surface)\'">'
        + '<div onclick="' + openCall + '" style="display:flex;align-items:center;gap:10px;flex:1;min-width:0;cursor:pointer;">'
        +   '<span style="flex:1;font-size:12px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHtml(s.addr) + '</span>'
        +   '<span style="font-size:11px;color:var(--muted);width:120px;flex-shrink:0;">' + escapeHtml(s.pn || '—') + '</span>'
        +   '<span style="font-size:11px;color:var(--muted);width:180px;flex-shrink:0;">' + escapeHtml(sowStatusBadge({approval_status: s.status}, {variant:'worklist'}).label) + '</span>'
        + '</div>'
        + '<button onclick="' + approveCall + '" style="flex-shrink:0;background:var(--yellow);color:var(--dark);border:none;border-radius:6px;'
        +   'padding:5px 12px;font-size:11px;font-weight:700;font-family:DM Sans,sans-serif;cursor:pointer;white-space:nowrap;">'
        +   escapeHtml(btnText) + '</button>'
        + '</div>';
    }).join('');
    var sowCards = sowItems.map(function(s) {
      var _uidJs = escapeHtml(s.uid).replace(/'/g, "\\'");
      var _pnJs  = escapeHtml(s.pn || '').replace(/'/g, "\\'");
      var openCall = 'if(typeof openSowModal===\'function\'){openSowModal(\'' + _uidJs + '\');}else{window.location.href=\'renos.html?sow=' + encodeURIComponent(s.uid) + '\';}';
      var approveCall = 'event.stopPropagation();if(typeof _wlApproveSow===\'function\'){_wlApproveSow(\'' + _uidJs + '\',\'' + _pnJs + '\');}else{' + openCall + '}';
      var badge = sowStatusBadge({approval_status: s.status}, {variant:'worklist'});
      return wlCard({ title:s.addr, pill:{text:badge.label}, open:openCall,
        metas:[{k:'Project',v:s.pn||'—'},{k:'Total',v:s.amount?_money(s.amount):''},{k:'Contractor',v:s.contractor},{k:'Work items',v:s.itemCount||''}],
        actions:[{text:(s.status==='hm_approved'?'Final Approve':'Approve'),onclick:approveCall}] });
    }).join('');
    var _sowTotal = (typeof sowItems._total === 'number') ? sowItems._total : sowItems.length;
    html += sectionWrap('🔨', 'Renovations Waiting Approval', _sowTotal, 'renos.html', _view==='cards' ? wlGrid(sowCards) : sowRows, Math.max(0, _sowTotal - sowItems.length));
  }

  // Field Employee — approved work orders to complete
  if (fieldSowItems.length) {
    var fsRows = fieldSowItems.map(function(s) {
      var openCall = 'if(typeof openSowModal===\'function\'){openSowModal(\''
                   + escapeHtml(s.uid).replace(/'/g, "\\'") + '\');}'
                   + 'else{window.location.href=\'renos.html?sow=' + encodeURIComponent(s.uid) + '\';}';
      var statLbl = (s.status === 'ed_approved') ? 'Approved — Ready to Work' : 'HM Approved — Ready to Work';
      return '<div style="display:flex;align-items:center;gap:8px;padding:9px 14px;border-top:1px solid var(--border);background:var(--surface);" '
        + 'onmouseover="this.style.background=\'var(--bg)\'" onmouseout="this.style.background=\'var(--surface)\'">'
        + '<div onclick="' + openCall + '" style="display:flex;align-items:center;gap:10px;flex:1;min-width:0;cursor:pointer;">'
        +   '<span style="flex:1;font-size:12px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHtml(s.addr) + '</span>'
        +   '<span style="font-size:11px;color:var(--muted);width:120px;flex-shrink:0;">' + escapeHtml(s.pn || '—') + '</span>'
        +   '<span style="font-size:11px;color:var(--muted);width:180px;flex-shrink:0;">' + escapeHtml(statLbl) + '</span>'
        + '</div>'
        + '<button onclick="' + openCall + '" style="flex-shrink:0;background:var(--yellow);color:var(--dark);border:none;border-radius:6px;'
        +   'padding:5px 12px;font-size:11px;font-weight:700;font-family:DM Sans,sans-serif;cursor:pointer;white-space:nowrap;">Open →</button>'
        + '</div>';
    }).join('');
    var fsCards = fieldSowItems.map(function(s) {
      var openCall = 'if(typeof openSowModal===\'function\'){openSowModal(\'' + escapeHtml(s.uid).replace(/'/g, "\\'") + '\');}else{window.location.href=\'renos.html?sow=' + encodeURIComponent(s.uid) + '\';}';
      var statLbl = (s.status === 'ed_approved') ? 'Approved — Ready to Work' : 'HM Approved — Ready to Work';
      return wlCard({ title:s.addr, pill:{text:statLbl,color:'var(--success)',bg:'var(--success-bg)'}, open:openCall,
        metas:[{k:'Project',v:s.pn||'—'}], actions:[{text:'Open →',onclick:openCall}] });
    }).join('');
    html += sectionWrap('🔧', 'Work Orders to Complete', fieldSowItems.length, 'renos.html', _view==='cards' ? wlGrid(fsCards) : fsRows, 0);
  }

  // RFQs
  if (rfqItems.length) {
    var rfqRows = rfqItems.map(function(r) {
      var rfqHref = 'rfq.html?rfq=' + encodeURIComponent(r.id);
      // Mobile-safe layout: RFQ id stays full width, the closes date takes the
      // flexible middle (ellipsizes on a narrow phone), and the recipient count
      // is a compact fixed chip. Dropping the (redundant) address column keeps
      // the row from overflowing under the Award button on small screens.
      return actionRow(rfqHref, [
        { text: r.id, style: 'font-size:12px;font-weight:600;flex-shrink:0;white-space:nowrap;' },
        { text: r.closes ? 'Closes ' + r.closes : '', style: 'flex:1;min-width:0;font-size:11px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' },
        { text: '👥 ' + r.recipients, style: 'font-size:11px;color:var(--muted);flex-shrink:0;white-space:nowrap;text-align:right;' }
      ], { text: 'Award →', href: rfqHref });
    }).join('');
    var rfqCards = rfqItems.map(function(r) {
      var open = 'window.location.href=\'rfq.html?rfq=' + encodeURIComponent(r.id) + '\'';
      return wlCard({ title:r.id, pill:{text:'Open for Bids',color:'#1d4ed8',bg:'var(--info-blue-bg)'}, open:open,
        metas:[{k:'Unit',v:r.addr},{k:'Closes',v:r.closes},{k:'Invited',v:r.recipients},{k:'Bids in',v:r.bids}],
        actions:[{text:'Award →',onclick:open}] });
    }).join('');
    html += sectionWrap('📊', 'RFQs Open for Bids', rfqItems.length, 'rfq.html', _view==='cards' ? wlGrid(rfqCards) : rfqRows, 0);
  }

  // Contractors
  if (ctItems.length) {
    var ctLabel = { pending_review:'Awaiting HM Verification', hm_recommended:'Awaiting Final Approval' };
    var ctStatusLabel = { pending_review:'Awaiting HM Verification', hm_recommended:'HM Verified — Awaiting Approval' };
    var ctBtnText     = { pending_review:'Verify →', hm_recommended:'Approve →' };
    var ctRows = ctItems.map(function(c) {
      // Set nav referrer so contractors.html back-button returns here
      var ctNav = 'if(typeof setNavReferrer===\'function\')setNavReferrer(\'home\');'
                + 'window.location.href=\'contractors.html?openContractor=' + encodeURIComponent(c.id) + '\';';
      return '<div style="display:flex;align-items:center;gap:8px;padding:9px 14px;border-top:1px solid var(--border);background:var(--surface);" '
        + 'onmouseover="this.style.background=\'var(--bg)\'" onmouseout="this.style.background=\'var(--surface)\'">'
        + '<div onclick="' + ctNav + '" style="display:flex;align-items:center;gap:10px;flex:1;min-width:0;cursor:pointer;">'
        +   '<span style="flex:1;font-size:12px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHtml(c.name) + '</span>'
        +   '<span style="font-size:11px;color:var(--muted);width:120px;flex-shrink:0;">' + escapeHtml(c.trade) + '</span>'
        +   '<span style="font-size:11px;color:var(--muted);width:180px;flex-shrink:0;">' + escapeHtml(ctStatusLabel[c.status] || c.status) + '</span>'
        + '</div>'
        + '<button onclick="' + ctNav + '" style="flex-shrink:0;background:var(--yellow);color:var(--dark);border:none;border-radius:6px;'
        +   'padding:5px 12px;font-size:11px;font-weight:700;font-family:DM Sans,sans-serif;cursor:pointer;white-space:nowrap;">'
        +   escapeHtml(ctBtnText[c.status] || 'Review') + '</button>'
        + '</div>';
    }).join('');
    var ctCards = ctItems.map(function(c) {
      var ctNav = 'if(typeof setNavReferrer===\'function\')setNavReferrer(\'home\');window.location.href=\'contractors.html?openContractor=' + encodeURIComponent(c.id) + '\';';
      return wlCard({ title:c.name, pill:{text:ctStatusLabel[c.status] || c.status, color:'#b45309', bg:'var(--warn-amber-bg)'}, open:ctNav,
        metas:[{k:'Trade',v:c.trade},{k:'Submitted',v:(c.submitted?String(c.submitted).slice(0,10):'')}],
        actions:[{text:ctBtnText[c.status] || 'Review →',onclick:ctNav}] });
    }).join('');
    html += sectionWrap('👷', 'Contractors Waiting Approval', ctItems.length, 'contractors.html', _view==='cards' ? wlGrid(ctCards) : ctRows, 0);
  }

  // Inventory approvals
  if (unitApprItems.length) {
    var unitApprRows = unitApprItems.map(function(u) {
      var href = 'inventory.html?unit=' + encodeURIComponent(u.id);
      return actionRow(href, [
        { text: u.addr, style: 'flex:1;font-size:12px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' },
        { text: u.lbl,  style: 'font-size:11px;color:var(--muted);width:200px;flex-shrink:0;' }
      ], { text: 'Review →', href: href }, 'home');
    }).join('');
    var unitApprCards = unitApprItems.map(function(u) {
      var open = 'if(typeof setNavReferrer===\'function\')setNavReferrer(\'home\');window.location.href=\'inventory.html?unit=' + encodeURIComponent(u.id) + '\'';
      return wlCard({ title:u.addr, pill:{text:u.lbl}, open:open, metas:[], actions:[{text:'Review →',onclick:open}] });
    }).join('');
    html += sectionWrap('🏘️', 'Inventory Approvals', unitApprItems.length, 'inventory.html', _view==='cards' ? wlGrid(unitApprCards) : unitApprRows, 0);
  }

  // Match queue — pill colors mirror the Match page's own tierColor map
  // (housing-views.js) so a tier reads identically in both places.
  if (matchItems.length) {
    var _wlTierColor = {
      'Critical Priority': { color: 'var(--success)', bg: 'var(--success-bg)' },
      'High Priority':     { color: '#1d4ed8', bg: 'var(--info-blue-bg)' },
      'Medium Priority':   { color: 'var(--warn-amber-text)', bg: 'var(--warn-amber-bg)' },
      'Low Priority':      { color: '#6b7280', bg: 'var(--bg)' }
    };
    // Allocate one vacant unit per applicant, in the same score order the
    // list is already ranked by, so two cards here never both show the same
    // still-vacant unit as their recommendation — see matchAllocateExclusive.
    var _wlMatchAllocation = (typeof matchAllocateExclusive === 'function') ? matchAllocateExclusive(matchItems) : {};
    function _wlAllocatedUnit(a){ return _wlMatchAllocation[a.id] || null; }
    var matchRows = matchItems.map(function(a) {
      var name = ((a.fn||'') + ' ' + (a.ln||'')).trim() || a.id;
      var tier  = a.tier ? a.tier.replace(' Priority','') : '';
      var score = a.score != null ? a.score + ' pts' : '';
      var best  = _wlAllocatedUnit(a);
      var unitTxt = best ? (best.unit.num + ' ' + best.unit.street) : 'Unmatched';
      return actionRow('housing.html?view=match', [
        { text: name,    style: 'flex:1;font-size:12px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' },
        { text: unitTxt, style: 'font-size:11px;color:var(--muted);width:150px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' },
        { text: score,   style: 'font-size:11px;color:var(--muted);width:60px;flex-shrink:0;' },
        { text: tier,    style: 'font-size:11px;color:var(--muted);width:100px;text-align:right;flex-shrink:0;' }
      ], { text: 'Match →', href: 'housing.html?view=match' });
    }).join('');
    var matchCards = matchItems.map(function(a) {
      var name = ((a.fn||'') + ' ' + (a.ln||'')).trim() || a.id;
      var tier = a.tier || 'Low Priority';
      var tierLbl = tier.replace(' Priority','');
      var isTransfer = (a.appType || a.app_type) === 'transfer_request';
      var open = 'window.location.href=\'housing.html?view=match\'';
      var pillColor = _wlTierColor[tier] || _wlTierColor['Low Priority'];
      var best = _wlAllocatedUnit(a);
      var matchPct = best ? Math.round(Math.max(0, best.score) / best.maxPossible * 100) : 0;
      var badges = [];
      if (isTransfer) badges.push('<span style="display:inline-block;font-size:10px;font-weight:700;background:var(--warn-amber);color:#111;padding:1px 7px;border-radius:4px;white-space:nowrap;">🏠 On Rez</span>');
      return wlCard({ title:name, pill:(tierLbl?{text:tierLbl,color:pillColor.color,bg:pillColor.bg}:null), open:open,
        badges: badges,
        metas:[
          {k:'Score',     v:(a.score!=null?a.score+' pts':'')},
          {k:'Reserve',   v:(a.reserve||'')},
          {k:'Best Unit', v:(best ? (best.unit.num+' '+best.unit.street+' · '+matchPct+'% match') : 'Unmatched')},
          {k:'Type',      v:_appTypeLabel[a.appType]||''},
          {k:'Has House', v:(isTransfer ? 'Yes' : 'No')}
        ],
        actions:[{text:'Match →',onclick:open}] });
    }).join('');
    html += sectionWrap('🏠', 'Ready to Match', matchItems.length, 'housing.html?view=match', _view==='cards' ? wlGrid(matchCards) : matchRows, 0);
  }

  // ── Arrears — action needed (Policy s.12 machine, management only) ──────
  // Pending-ED arrangement approvals, overdue quarterly reviews, and 12-month
  // windows expiring/expired. Data comes from the arrears machine's cache of
  // the FINANCE tables; the section simply doesn't render until it loads
  // (arrears.js re-triggers renderWorklist once ready).
  if (isManagement && typeof arrearsWorklistItems === 'function' && window._arrearsCache && window._arrearsCache.loaded) {
    var arrItems = arrearsWorklistItems();
    if (arrItems.length) {
      var _arrOpen = function(it){
        var target = (window._arrearsCache.byTenant[it.tid].tenant.current_unit_id || it.tid);
        return "if(typeof openTenantCard==='function')openTenantCard('" + String(target).replace(/'/g,"\\'") + "')";
      };
      var arrRows = arrItems.map(function(it){
        return '<div style="display:flex;align-items:center;gap:8px;padding:9px 14px;border-top:1px solid var(--border);background:var(--surface);">'
          + '<a onclick="' + _arrOpen(it) + '" style="display:flex;align-items:center;gap:10px;flex:1;min-width:0;text-decoration:none;color:inherit;cursor:pointer;">'
          +   '<span style="flex:0 0 30%;font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(it.name) + '</span>'
          +   '<span style="flex:1;font-size:12px;color:var(--muted);">' + esc(it.label) + '</span>'
          + '</a>'
          + '<a onclick="' + _arrOpen(it) + '" style="flex-shrink:0;background:var(--yellow);color:var(--dark);border-radius:6px;padding:5px 12px;font-size:11px;font-weight:700;font-family:DM Sans,sans-serif;text-decoration:none;white-space:nowrap;cursor:pointer;display:inline-block;">Open &#8594;</a>'
          + '</div>';
      }).join('');
      var arrCards = arrItems.map(function(it){
        return wlCard({ title: it.name, open: _arrOpen(it), metas:[{k:'Action', v: it.label}], actions:[{text:'Open →', onclick: _arrOpen(it)}] });
      }).join('');
      html += sectionWrap('💰', 'Arrears — Action Needed', arrItems.length, '', _view==='cards' ? wlGrid(arrCards) : arrRows, 0);
    }
  }

  body.innerHTML = html;
}

function resetRenoScoreModel() {
  showConfirm({
    title:       'Reset renovation scoring?',
    message:     'All custom criteria will be replaced by the defaults.',
    confirmText: 'Reset to Defaults',
    danger:      true
  }).then(function(ok){
    if (!ok) return;
    if(window._appSettings) delete window._appSettings['reno_score_model'];
    renderRenoScoreTable();
    showToast('Renovation scoring reset', {type:'info'});
  });
}
function resetSow(){
  ['sow_address','sow_tenant_name','sow_prepared_by','sow_po_number','sow_contractor','sow_total_cost',
   'sow_notes','sow_hm_name','sow_ed_name',
   'sow_sig_tenant_name','sow_sig_staff_name'].forEach(function(id){
    var el=document.getElementById(id); if(el) el.value='';
  });
  ['sow_condition','sow_start_date','sow_end_date','sow_hm_date','sow_ed_date',
   'sow_sig_tenant_date','sow_sig_staff_date'].forEach(function(id){
    var el=document.getElementById(id); if(el) el.value='';
  });
  // Clear signature canvases
  if(typeof clearSig === 'function') {
    clearSig('sow_sig_canvas_tenant');
    clearSig('sow_sig_canvas_staff');
  }
  ['sow_mold','sow_asbestos','sow_electrical','sow_structural','sow_plumbing','sow_fire',
   'sow_rent_arrears','sow_tenant_damage','sow_negligence','sow_vandalism','sow_police_report'].forEach(function(id){
    var el=document.getElementById(id); if(el) el.checked=false;
  });
  var items=document.getElementById('sow_items'); if(items) items.innerHTML='';
  _sowItemIdx=0;
  addSowItem();
  // Clear attached files
  window._sowFiles = [];
  if (typeof renderSowFiles === 'function') renderSowFiles();
  // Clear the Work Order (execution) block for a brand-new request.
  ['sow_wo_measurements','sow_wo_materials','sow_wo_field_notes'].forEach(function(id){
    var el=document.getElementById(id); if(el) el.value='';
  });
  ['sow_wo_mat_required','sow_wo_mat_ordered'].forEach(function(id){
    var el=document.getElementById(id); if(el) el.checked=false;
  });
  if (typeof _sowPopulateWorkOrder === 'function') _sowPopulateWorkOrder(null);
}
function rpAddNewContractor() {
  var dd = document.getElementById('rp_ct_dropdown');
  if(dd) dd.style.display = 'none';
  // Mount the modal on demand (it's built by the shared builder now).
  if (typeof _ensureAddContractorModal === 'function') _ensureAddContractorModal();
  var typed = (document.getElementById('rp_contractor')||{}).value||'';
  // Close progress modal first
  var prog = document.getElementById('renoProgressModal');
  if(prog) prog.style.display = 'none';
  // Open via the canonical helper so all per-mode setup (field reset, sig pads,
  // strip/notes render, tab reset) runs and the modal is guaranteed mounted.
  if (typeof openAddContractorModal === 'function') openAddContractorModal();
  var m = document.getElementById('addContractorModal');
  if(m){ m.style.display = 'flex'; m.style.zIndex = '1000'; }
  // Pre-fill the name AFTER open (openAddContractorModal resets fields, so
  // setting it earlier would be wiped).
  var nameField = document.getElementById('ct_name');
  if(nameField && typed) nameField.value = typed;
  if (typeof _cicRefreshStrip === 'function') _cicRefreshStrip();
  // Flag so saveContractor knows to reopen progress modal after
  window._rpAfterContractorSave = true;
}
function rpSelectContractor(el) {
  var name = el.getAttribute('data-ct-name');
  var id   = el.getAttribute('data-ct-id');
  var inp  = document.getElementById('rp_contractor');
  var hid  = document.getElementById('rp_contractor_id');
  if(inp) inp.value = name;
  if(hid) hid.value = id;
  var dd = document.getElementById('rp_ct_dropdown');
  if(dd) dd.style.display = 'none';
}
// Name-only match against every other contractor (mirrors the "nameOnly"
// tier of _findDuplicateApplications() in housing-app.js) — excludes the
// record currently being edited so re-saving an unchanged name doesn't warn
// against itself.
function _findDuplicateContractor(name, excludeId){
  var contractors = window._contractors || [];
  var n = (name || '').trim().toLowerCase();
  if(!n) return null;
  for(var i=0;i<contractors.length;i++){
    var c = contractors[i];
    if(!c || c.id === excludeId) continue;
    if((c.name||'').trim().toLowerCase() === n) return c;
  }
  return null;
}

function saveContractor(){
  // Returns true on a completed save, false when it aborts (missing name,
  // declined duplicate warning). saveContractorAndFinalize keys off this —
  // finalizing after an aborted save used to flip the new-contractor form
  // into edit mode pointed at the LAST contractor in the directory, so the
  // user's next Save overwrote that unrelated record.
  var get=function(id){var el=document.getElementById(id);return el?el.value.trim():'';};
  // Preserve-when-absent reader: if a form input doesn't exist on this page
  // (markup drift), keep the previously saved value instead of wiping it to ''.
  var _prevCt = (function(){
    var cts = window._contractors || [];
    var ei = (window._ctEditIdx !== undefined) ? window._ctEditIdx : -1;
    return (ei >= 0 && ei < cts.length) ? cts[ei] : null;
  })();
  var getOrKeep=function(id, field){
    var el=document.getElementById(id);
    if(el) return el.value.trim();
    return (_prevCt && _prevCt[field] != null) ? _prevCt[field] : '';
  };
  var name=get('ct_name');
  if(!name){showToast('Contractor name is required.', {type:'error'});return false;}
  var contractors = window._contractors || [];
  var editIdx = (window._ctEditIdx !== undefined) ? window._ctEditIdx : -1;
  var isEdit = editIdx >= 0 && editIdx < contractors.length;
  var id = isEdit ? (contractors[editIdx].id || ('CT-'+editIdx)) : ('CT-'+Date.now());

  // Warn (don't block) on a name-only match — same tone/pattern as the
  // application submit flow's "Applicant Name Already Exists" check. Uses a
  // synchronous window.confirm() rather than the async showConfirm() helper
  // so saveContractor() stays synchronous — saveContractorAndFinalize() reads
  // window._contractors back immediately after calling this function.
  var _dupCt = _findDuplicateContractor(name, isEdit ? id : null);
  if(_dupCt){
    var _dupDetail = [_dupCt.trade, _dupCt.status].filter(Boolean).join(' · ');
    if(!window.confirm('A contractor named "' + name + '" already exists'
      + (_dupDetail ? ' (' + _dupDetail + ')' : '') + '.\n\n'
      + 'Please confirm this is a different contractor or company before saving.\n\n'
      + 'Save anyway?')) {
      return false;
    }
  }

  var classRadio = document.querySelector('input[name="ct_classification"]:checked');
  var torEl = document.getElementById('ct_tor_agreed');
  var data = {
    id:id,name:name,trade:get('ct_trade'),phone:get('ct_phone'),email:get('ct_email'),
    address:get('ct_address'),hst:get('ct_hst'),
    wsibNum:get('ct_wsib_num'),wsibExpiry:get('ct_wsib_expiry'),
    insProvider:getOrKeep('ct_ins_provider','insProvider'),insPolicy:get('ct_ins_policy'),
    insAmount:getOrKeep('ct_ins_amount','insAmount'),insExpiry:get('ct_ins_expiry'),
    notes:get('ct_notes'), people:ctGetPeople(),
    classification: classRadio ? classRadio.value : '',
    classProof: get('ct_class_proof'),
    torAgreed: torEl ? torEl.checked : false,
    torAgreedAt: (torEl && torEl.checked) ? new Date().toISOString().split('T')[0] : '',
    sigStaff: { name:get('ct_sig_staff_name'), date:get('ct_sig_staff_date'), image:(typeof getSigDataURL==='function'?getSigDataURL('ct_sig_canvas_staff'):'') },
    sigCt:    { name:get('ct_sig_ct_name'),    title:get('ct_sig_ct_title'), date:get('ct_sig_ct_date'), image:(typeof getSigDataURL==='function'?getSigDataURL('ct_sig_canvas_ct'):'') },
    addedAt: isEdit ? (contractors[editIdx].addedAt||new Date().toISOString().slice(0,10)) : new Date().toISOString().slice(0,10)
  };
  // Set workflow status. The "Save Draft → Submit Contractor" gate
  // applies to:
  //   • brand-new contractors (no edit row)
  //   • re-opened DRAFT rows (still being authored)
  //   • RETURNED rows (need fixes before resubmit)
  // Already-submitted rows (pending_review / hm_recommended / approved /
  // declined) preserve their current status — the user is just editing
  // a field, not advancing the workflow.
  var _saveBtn = document.getElementById('ct_save_btn');
  var _saveMode = _saveBtn && _saveBtn.dataset ? _saveBtn.dataset.mode : null;
  if(isEdit) {
    var _prevStatus = contractors[editIdx].status || 'pending_review';
    var _gated = (_prevStatus === 'draft' || _prevStatus === 'returned');
    if (_gated) {
      // Honour the Save button's mode: submit → advance to pending_review,
      // draft → stay where you are (or move to 'draft' if previously
      // 'returned' — same author-phase semantics).
      data.status = (_saveMode === 'submit') ? 'pending_review' : 'draft';
      data.submittedAt = (_saveMode === 'submit')
        ? new Date().toISOString().split('T')[0]
        : (contractors[editIdx].submittedAt || '');
    } else {
      data.status = _prevStatus;
      data.submittedAt = contractors[editIdx].submittedAt || new Date().toISOString().split('T')[0];
    }
    contractors[editIdx] = data;
    var _editAuditAction = _gated && data.status === 'pending_review' ? 'ct_submitted' : 'ct_updated';
    var _editAuditDetail = _gated && data.status === 'pending_review'
      ? 'Contractor application submitted: ' + name
      : 'Contractor record updated: ' + name;
    auditEntry('CT:'+id, _editAuditAction, _editAuditDetail, window.currentRole||'staff');
    // Notify approvers when a draft is being submitted for review.
    if (_editAuditAction === 'ct_submitted' && typeof notifyContractorSubmitted === 'function') {
      notifyContractorSubmitted(data);
    }
  } else {
    // Brand-new contractor — same gate.
    data.status = (_saveMode === 'submit') ? 'pending_review' : 'draft';
    data.submittedAt = (_saveMode === 'submit') ? new Date().toISOString().split('T')[0] : '';
    contractors.push(data);
    var _auditAction = (data.status === 'draft') ? 'ct_drafted' : 'ct_submitted';
    var _auditDetail = (data.status === 'draft')
      ? 'Contractor saved as draft: ' + name
      : 'Contractor application submitted: ' + name;
    auditEntry('CT:'+id, _auditAction, _auditDetail, window.currentRole||'staff');
    // Drafts don't notify (nothing to act on yet). Only submitted
    // contractors trigger an approver notification.
    if (_auditAction === 'ct_submitted' && typeof notifyContractorSubmitted === 'function') {
      notifyContractorSubmitted(data);
    }
  }
  // Auto-approve on submit when the contractor approval chain is switched OFF
  // in Settings (Approval Authority). "Any off = fully approved."
  if (data.status === 'pending_review' && !data.approvalAuto
      && typeof APPROVAL_AUTHORITY !== 'undefined' && APPROVAL_AUTHORITY.chainDisabled
      && APPROVAL_AUTHORITY.chainDisabled('contractor')) {
    data.status     = 'approved';
    data.approvalAuto = true;
    data.edActionAt = new Date().toISOString().split('T')[0];
    data.edActionBy = 'System — approval disabled';
    auditEntry('CT:'+id, 'contractor_auto_approved', 'Contractor auto-approved on submit — approval disabled in Settings', 'System — approval disabled');
  }
  window._contractors = contractors;
  // Persist to Supabase. The contractor record is `data` (built above) — an
  // older revision named it `ct`, this site was missed in the rename and
  // threw a ReferenceError that aborted the save mid-flight (so the
  // contractor stayed in memory but never reached the DB).
  saveContractorWithDraftFallback(data);
  // Upload contractor files to Supabase Storage. Only newly-staged files
  // (those with .data and no .path) get uploaded — existing files loaded
  // from storage on edit-open already have a .path and are skipped to avoid
  // creating duplicate blobs.
  var ctf = window._ctFiles||{wsib:[],insurance:[],other:[]};
  ['wsib','insurance','other'].forEach(function(bucket){
    (ctf[bucket]||[]).forEach(function(fileRecord){
      if (!fileRecord || !fileRecord.data || fileRecord.path) return;
      // fileRecord has .name .type .size .data (base64) — convert back to blob and upload
      try {
        var byteStr = atob(fileRecord.data.split(',')[1]||fileRecord.data);
        var arr = new Uint8Array(byteStr.length);
        for(var i=0;i<byteStr.length;i++) arr[i]=byteStr.charCodeAt(i);
        var blob = new Blob([arr],{type:fileRecord.type||'application/octet-stream'});
        var file = new File([blob], fileRecord.name, {type:fileRecord.type||'application/octet-stream'});
        sbUploadAndSave('contractor', id, file, 'contractors/'+id+'/'+bucket).catch(function(e){ console.warn('Contractor file upload failed:',e); });
      } catch(e){ console.warn('Could not upload contractor file:',e); }
    });
  });
  closeAddContractorModal();
  if(!isEdit && window._rpAfterContractorSave) {
    window._rpAfterContractorSave = false;
    var inp = document.getElementById('rp_contractor');
    var hid = document.getElementById('rp_contractor_id');
    if(inp) inp.value = name;
    if(hid) hid.value = id;
    var prog = document.getElementById('renoProgressModal');
    if(prog) prog.style.setProperty('display','flex','important');
  } else if(window._sowAfterContractorSave) {
    window._sowAfterContractorSave = false;
    var sowInp = document.getElementById('sow_contractor');
    var sowHid = document.getElementById('sow_contractor_id');
    if(sowInp) sowInp.value = name;
    if(sowHid) sowHid.value = id;
  } else {
    // If the search modal is open (employee flow), refresh it; otherwise refresh management view
    var searchModal = document.getElementById('contractorSearchModal');
    var isSearchOpen = searchModal && searchModal.style.display !== 'none' && getComputedStyle(searchModal).display !== 'none';
    if(isSearchOpen) {
      contractorSearchFilter(document.getElementById('ct_search_input') ? document.getElementById('ct_search_input').value : '');
    } else {
      // Re-open search modal in employee mode, otherwise re-render management view
      var role = window.currentRole || 'housing_employee_l1';
      if(ROLE.isManagement(role)) {
        renderContractorsView();
      } else {
        openContractorSearch();
      }
    }
  }
  showToast((isEdit ? 'Updated: ' : 'Added: ') + name, {type:'info'});
  return true;
}
function saveContractorAndFinalize() {
  // Save first (reuses existing saveContractor logic). BAIL if the save
  // aborted (missing name / declined duplicate confirm) — finalizing anyway
  // used to flip the still-unsaved new-contractor form into edit mode pointed
  // at the last contractor in the directory, so the next Save overwrote that
  // unrelated record.
  if (saveContractor() === false) return;
  // After save, grab the record back and reveal the header Print + Email
  // buttons. The CIC modal uses header buttons as the canonical Print
  // surface — the older footer copies stay hidden but are kept in markup
  // for backwards compatibility with any external callers.
  try {
    var contractors = (window._contractors || []).slice();
    if(contractors.length) {
      window._ctLastSaved = contractors[contractors.length - 1];
      if(window._ctEditIdx >= 0 && window._ctEditIdx < contractors.length) {
        window._ctLastSaved = contractors[window._ctEditIdx];
      }
      var hp = document.getElementById('ct_header_print_btn');
      var he = document.getElementById('ct_header_email_btn');
      if(hp){ hp.classList.remove('hidden'); hp.style.display=''; }
      if(he && window._ctLastSaved.email){ he.classList.remove('hidden'); he.style.display=''; }
      // Keep the hero title on the company name and refresh the glance strip
      // (Status tile now reflects the saved record). Re-render the Notes tab
      // too: a brand-new contractor now has an id, so notes become addable.
      var _htitle = document.getElementById('ct_modal_title');
      if(_htitle && window._ctLastSaved.name) _htitle.textContent = window._ctLastSaved.name;
      if(typeof _cicRefreshStrip === 'function') _cicRefreshStrip();
      if(typeof cicRenderNotes === 'function')   cicRenderNotes(window._ctLastSaved.id);
      // If we just saved a brand-new contractor, switch the modal into
      // edit mode so the CIC approval surface appears for managers
      // without a second click.
      if(window._ctEditIdx < 0) {
        window._ctEditIdx = contractors.length - 1;
        _ctApprovalIdx = window._ctEditIdx;
        var cas2 = document.getElementById('cic_approval_surface');
        if (cas2) cas2.style.display = '';
        if(typeof _ctSetCicStatusBanner === 'function') _ctSetCicStatusBanner(window._ctLastSaved);
        if(typeof _ctRenderActions === 'function')      _ctRenderActions(window._ctLastSaved, 'cic');
        // Now that this is an edit (saved contractor exists), pre-fill
        // all tabs as visited and refresh the Save button — it'll flip
        // to "Save Changes" mode automatically.
        if (window._cicVisitedTabs && typeof _CIC_TAB_NAMES !== 'undefined') {
          _CIC_TAB_NAMES.forEach(function(t){ window._cicVisitedTabs.add(t); });
        }
        if(typeof _updateCicSaveButtonState === 'function') _updateCicSaveButtonState();
      }
    }
  } catch(e) {}
}
function saveRenoScoreModel() {
  var model = getRenoScoreModel();
  document.querySelectorAll('[data-rsm-id]').forEach(function(inp) {
    var row = model.find(function(r){ return r.id === inp.getAttribute('data-rsm-id'); });
    if(row) row.pts = parseInt(inp.value)||0;
  });
  if(!window._appSettings) window._appSettings={};
  window._appSettings['reno_score_model']=model;
  saveSettingWithDraftFallback('reno_score_model', model).then(function(ok){
    if(!ok){ showToast('Renovation scoring did NOT save to server — please retry.', {type:'error'}); return; }
    auditEntry('SETTINGS','settings_reno_score_save','Renovation priority scoring model saved',window.currentRole||'staff');
    showToast('Renovation scoring saved', {type:'info'});
    renderRenoScoreTable();
  });
}
function saveUnitScoreModel(){
  var model=getUnitScoreModel();
  document.querySelectorAll('[data-usm-id]').forEach(function(inp){
    var row=model.find(function(r){return r.id===inp.getAttribute('data-usm-id');});
    if(row)row.pts=parseInt(inp.value)||0;
  });
  if(!window._appSettings) window._appSettings={};
  window._appSettings['unit_score_model']=model;
  saveSettingWithDraftFallback('unit_score_model', model).then(function(ok){
    if(!ok){ showToast('Unit match scoring did NOT save to server — please retry.', {type:'error'}); return; }
    auditEntry('SETTINGS','settings_unit_score_save','Unit matching scoring model saved',window.currentRole||'staff');
    showToast('Unit match scoring saved', {type:'info'});
    renderUnitScoreTable();
  });
}
function saveUnitScoreModelED() {
  edGuard('Unit Matching Scoring updated', function() {
    saveUnitScoreModel();
  });
}
// Match selected pool files to an applicant: copy each into the app's Storage
// folder, insert an app_documents row pointing to the new path, then delete
// the original from the shared pool so it no longer appears in the match list.
async function scSaveAssignedDocs(app) {
  var checkboxes = document.querySelectorAll('#assignDocsList input[type=checkbox]');
  var appId      = app.id || '';
  var matched    = 0;
  var errors     = [];

  for (var i = 0; i < checkboxes.length; i++) {
    var cb = checkboxes[i];
    if (!cb.checked) continue;
    var srcPath = cb.dataset.path;
    var fname   = cb.dataset.name;
    var destPath = 'applications/' + appId + '/' + Date.now() + '_' + fname;

    try {
      await sbCopyFile(srcPath, destPath);
      await fetch(SUPABASE_URL + '/rest/v1/app_documents', {
        method:  'POST',
        headers: Object.assign({}, HOUSING_HEADERS, { 'Prefer': 'return=minimal' }),
        body:    JSON.stringify({
          app_id:    appId,
          file_path: destPath,
          file_name: fname,
          file_size: parseInt(cb.dataset.size) || 0,
          file_type: cb.dataset.type,
          added_by:  window.currentUser || window.currentRole || 'admin'
        })
      });
      await sbDeleteFile(srcPath);
      matched++;
    } catch (e) {
      console.warn('[assignDocs] failed for ' + fname + ':', e);
      errors.push(fname);
    }
  }

  if (errors.length) {
    showToast('⚠ ' + matched + ' matched, ' + errors.length + ' failed — see console', {type:'error'});
  } else if (matched > 0) {
    showToast('✓ ' + matched + ' file' + (matched === 1 ? '' : 's') + ' added to document library', {type:'info'});
  } else {
    showToast('No files selected', {type:'error'});
    return;
  }
  if (matched > 0) {
    scLoadDocs(app);
    // Refresh the modal so the newly matched files appear in the Assigned section
    scShowAssignDocs(app);
  }
}

async function scShowAssignDocs(app) {
  var existing = document.getElementById('assignDocsModal');
  if (existing) existing.remove();
  var modal = document.createElement('div');
  modal.id = 'assignDocsModal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';
  document.body.appendChild(modal);

  var appName = ((app.fn || '') + ' ' + (app.ln || '')).trim();
  modal.innerHTML =
      '<div style="background:var(--surface);border-radius:12px;width:100%;max-width:580px;max-height:88vh;display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,0.25);">'
    + '<div style="display:flex;justify-content:space-between;align-items:center;padding:18px 22px;border-bottom:1px solid var(--border);flex-shrink:0;">'
    +   '<div style="font-size:14px;font-weight:700;">Assign / Manage Files &mdash; ' + escapeHtml(appName) + '</div>'
    +   '<button id="assignDocsClose" style="background:none;border:none;font-size:22px;cursor:pointer;color:var(--muted);">&times;</button>'
    + '</div>'
    + '<div id="assignDocsBody" style="overflow-y:auto;padding:18px 22px;flex:1;">Loading&hellip;</div>'
    + '</div>';
  document.getElementById('assignDocsClose').addEventListener('click', function() { modal.remove(); });

  // Load both in parallel
  var assigned = [], available = [];
  try {
    var [assignedRes, poolFiles] = await Promise.all([
      fetch(SUPABASE_URL + '/rest/v1/app_documents?app_id=eq.' + encodeURIComponent(app.id || '') + '&select=*&order=added_at.asc', { headers: HOUSING_HEADERS }),
      sbListFiles('applications/APP-/')
    ]);
    if (assignedRes.ok) assigned = await assignedRes.json();
    available = (poolFiles || []).filter(function(f) { return f.name && f.name !== '.emptyFolderPlaceholder'; });
  } catch (e) { console.warn('[assignDocs] load error:', e); }

  var body = document.getElementById('assignDocsBody');
  if (!body) return;

  var secH = 'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:var(--yellow);margin-bottom:10px;padding-bottom:5px;border-bottom:1px solid var(--border);';
  var html = '';

  // ── Section 1: already assigned ──────────────────────────────────────────
  html += '<div style="' + secH + '">Assigned to this applicant (' + assigned.length + ')</div>';
  if (!assigned.length) {
    html += '<div style="font-size:12px;color:var(--muted);margin-bottom:18px;">No files currently assigned.</div>';
  } else {
    html += '<div style="margin-bottom:18px;">';
    assigned.forEach(function(doc) {
      var fname = doc.file_name || doc.file_path.split('/').pop();
      html += '<div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--border);">'
            +   '<span style="flex:1;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + escapeHtml(fname) + '">' + escapeHtml(fname) + '</span>'
            +   '<button class="btn btn-ghost btn-sm" onclick="scDeleteAssignedDoc(' + escapeHtml(JSON.stringify(doc)) + ')" style="white-space:nowrap;color:var(--danger);">Delete</button>'
            +   '<button class="btn btn-ghost btn-sm" onclick="scReassignDoc(' + escapeHtml(JSON.stringify(doc)) + ')" style="white-space:nowrap;">Reassign &rarr;</button>'
            + '</div>';
    });
    html += '</div>';
  }

  // ── Section 2: shared pool ────────────────────────────────────────────────
  html += '<div style="' + secH + '">Shared pool (' + available.length + ')</div>';
  if (!available.length) {
    html += '<div style="font-size:12px;color:var(--muted);">No files in the shared pool.</div>';
  } else {
    html += '<div style="font-size:12px;color:var(--muted);margin-bottom:10px;">Select files to copy into this applicant\'s document library. Each matched file is removed from the pool.</div>';
    html += '<div id="assignDocsList">';
    available.forEach(function(f) {
      var fpath = 'applications/APP-/' + f.name;
      var sz    = f.metadata ? (f.metadata.size || 0) : 0;
      var mime  = f.metadata ? (f.metadata.mimetype || '') : '';
      html += '<label style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);cursor:pointer;">'
            +   '<input type="checkbox" data-path="' + escapeHtml(fpath) + '" data-name="' + escapeHtml(f.name) + '" data-size="' + sz + '" data-type="' + escapeHtml(mime) + '"/>'
            +   '<span style="font-size:12px;">' + escapeHtml(f.name) + '</span>'
            + '</label>';
    });
    html += '</div>'
          + '<button onclick="scSaveAssignedDocs(' + escapeHtml(JSON.stringify({id: app.id, fn: app.fn, ln: app.ln})) + ')" '
          +   'style="margin-top:14px;background:var(--yellow);border:none;color:var(--text);padding:10px 20px;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;width:100%;">'
          +   'Match Selected Files'
          + '</button>';
  }

  body.innerHTML = html;
  // Store app on modal for refresh after delete/reassign
  modal._scApp = app;
}

async function scDeleteAssignedDoc(doc) {
  if (!doc || !doc.id) return;
  var fname = doc.file_name || doc.file_path.split('/').pop();
  var confirmed = await showConfirm({
    title:       'Delete "' + fname + '"?',
    message:     'This permanently removes the file from this applicant\'s document library and from Storage.',
    confirmText: 'Delete',
    danger:      true
  });
  if (!confirmed) return;

  try {
    // Remove app_documents row
    await fetch(SUPABASE_URL + '/rest/v1/app_documents?id=eq.' + encodeURIComponent(doc.id), {
      method: 'DELETE', headers: HOUSING_HEADERS
    });
    // Delete from Storage (only if file is in the applicant's own folder, not a pool path)
    if (doc.file_path && doc.file_path.indexOf('applications/APP-/') === -1) {
      await sbDeleteFile(doc.file_path);
    }
    showToast('File deleted', {type:'info'});
    // Re-open modal for the same app
    var modal = document.getElementById('assignDocsModal');
    var app   = modal && modal._scApp;
    if (app) scShowAssignDocs(app);
  } catch (e) {
    console.warn('[assignDocs] delete failed:', e);
    showToast('Delete failed — see console', {type:'error'});
  }
}

async function scReassignDoc(doc) {
  if (!doc || !doc.id) return;
  var fname = doc.file_name || doc.file_path.split('/').pop();
  var apps  = (typeof applications !== 'undefined' ? applications : [])
    .filter(function(a) { return a && a.id && a.id !== doc.app_id && !a.archived; });

  // Build picker modal
  var picker = document.createElement('div');
  picker.id  = 'reassignPickerModal';
  picker.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px;';

  picker.innerHTML =
      '<div style="background:var(--surface);border-radius:12px;width:100%;max-width:480px;max-height:75vh;display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,0.3);">'
    + '<div style="display:flex;justify-content:space-between;align-items:center;padding:16px 20px;border-bottom:1px solid var(--border);flex-shrink:0;">'
    +   '<div><div style="font-size:13px;font-weight:700;">Reassign &mdash; ' + escapeHtml(fname) + '</div>'
    +   '<div style="font-size:11px;color:var(--muted);margin-top:2px;">Select the applicant to move this file to</div></div>'
    +   '<button onclick="document.getElementById(\'reassignPickerModal\').remove()" style="background:none;border:none;font-size:20px;cursor:pointer;color:var(--muted);">&times;</button>'
    + '</div>'
    + '<div style="padding:12px 20px;border-bottom:1px solid var(--border);flex-shrink:0;">'
    +   '<input id="reassignSearch" type="text" placeholder="Search applicant name or ID…" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px;font-family:DM Sans,sans-serif;background:var(--surface);color:var(--text);box-sizing:border-box;"/>'
    + '</div>'
    + '<div id="reassignList" style="overflow-y:auto;flex:1;"></div>'
    + '</div>';

  document.body.appendChild(picker);

  function renderPicker(filter) {
    var listEl = document.getElementById('reassignList');
    if (!listEl) return;
    var filtered = apps.filter(function(a) {
      if (!filter) return true;
      var name = ((a.fn || '') + ' ' + (a.ln || '')).toLowerCase();
      return name.indexOf(filter.toLowerCase()) !== -1 || (a.id || '').toLowerCase().indexOf(filter.toLowerCase()) !== -1;
    });
    if (!filtered.length) {
      listEl.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted);font-size:12px;">No matching applicants.</div>';
      return;
    }
    listEl.innerHTML = filtered.map(function(a) {
      var aName = ((a.fn || '') + ' ' + (a.ln || '')).trim() || '—';
      return '<button style="display:block;width:100%;text-align:left;padding:10px 20px;border:none;border-bottom:1px solid var(--border);background:none;cursor:pointer;font-family:DM Sans,sans-serif;" '
           + 'onmouseover="this.style.background=\'var(--bg)\'" onmouseout="this.style.background=\'none\'" '
           + 'onclick="_scDoReassign(' + escapeHtml(JSON.stringify(doc)) + ',\'' + escapeHtml(a.id) + '\',\'' + escapeHtml(aName) + '\')">'
           +   '<div style="font-size:13px;font-weight:600;color:var(--text);">' + escapeHtml(aName) + '</div>'
           +   '<div style="font-size:11px;color:var(--muted);">' + escapeHtml(a.id || '') + ' &middot; ' + escapeHtml(a.status || '') + '</div>'
           + '</button>';
    }).join('');
  }

  renderPicker('');
  var searchEl = document.getElementById('reassignSearch');
  if (searchEl) searchEl.addEventListener('input', function() { renderPicker(this.value); });
}

async function _scDoReassign(doc, targetAppId, targetName) {
  document.getElementById('reassignPickerModal') && document.getElementById('reassignPickerModal').remove();
  var fname = doc.file_name || doc.file_path.split('/').pop();
  showToast('Reassigning ' + fname + '…', {type:'info'});
  try {
    var destPath = 'applications/' + targetAppId + '/' + Date.now() + '_' + fname;
    // Copy to target applicant's folder
    await sbCopyFile(doc.file_path, destPath);
    // Insert new app_documents row for target
    await fetch(SUPABASE_URL + '/rest/v1/app_documents', {
      method:  'POST',
      headers: Object.assign({}, HOUSING_HEADERS, { 'Prefer': 'return=minimal' }),
      body:    JSON.stringify({
        app_id:    targetAppId,
        file_path: destPath,
        file_name: fname,
        file_size: doc.file_size || 0,
        file_type: doc.file_type || '',
        added_by:  window.currentUser || window.currentRole || 'admin'
      })
    });
    // Delete old app_documents row
    await fetch(SUPABASE_URL + '/rest/v1/app_documents?id=eq.' + encodeURIComponent(doc.id), {
      method: 'DELETE', headers: HOUSING_HEADERS
    });
    // Delete source file from Storage (if not a pool path)
    if (doc.file_path && doc.file_path.indexOf('applications/APP-/') === -1) {
      await sbDeleteFile(doc.file_path);
    }
    showToast('✓ ' + fname + ' reassigned to ' + targetName, {type:'info'});
    // Refresh the assign modal
    var modal = document.getElementById('assignDocsModal');
    var app   = modal && modal._scApp;
    if (app) scShowAssignDocs(app);
  } catch (e) {
    console.warn('[assignDocs] reassign failed:', e);
    showToast('Reassign failed — see console', {type:'error'});
  }
}

// One-time migration: for any existing app_documents rows still pointing to the
// shared pool (applications/APP-/...), copy the file into the app's own folder,
// update the row, and delete the original from the pool.
// Run once from the browser console: runDocPoolMigration()
async function runDocPoolMigration() {
  console.log('[migration] Loading pool-assigned app_documents rows...');
  var r = await fetch(
    SUPABASE_URL + '/rest/v1/app_documents?file_path=like.applications%2FAPP-%2F%25&select=*',
    { headers: HOUSING_HEADERS }
  );
  if (!r.ok) { console.error('[migration] Could not load app_documents:', await r.text()); return; }
  var rows = await r.json();
  console.log('[migration] ' + rows.length + ' row(s) to migrate.');

  var ok = 0, fail = 0;
  for (var i = 0; i < rows.length; i++) {
    var row    = rows[i];
    var fname  = row.file_name || row.file_path.split('/').pop();
    var destPath = 'applications/' + row.app_id + '/' + fname;
    try {
      await sbCopyFile(row.file_path, destPath);
      var upR = await fetch(SUPABASE_URL + '/rest/v1/app_documents?id=eq.' + encodeURIComponent(row.id), {
        method:  'PATCH',
        headers: Object.assign({}, HOUSING_HEADERS, { 'Prefer': 'return=minimal' }),
        body:    JSON.stringify({ file_path: destPath })
      });
      if (!upR.ok) throw new Error('Row update failed: ' + await upR.text());
      await sbDeleteFile(row.file_path);
      console.log('[migration] ✓ ' + fname + ' → ' + row.app_id);
      ok++;
    } catch (e) {
      console.error('[migration] ✗ ' + (row.file_path || row.id) + ':', e);
      fail++;
    }
  }
  console.log('[migration] Done. ' + ok + ' migrated, ' + fail + ' failed.');
  if (typeof showToast === 'function') showToast('Migration: ' + ok + ' moved, ' + fail + ' failed', {type: fail ? 'error' : 'info'});
}
window.runDocPoolMigration = runDocPoolMigration;
function setExportView(viewName) {
  window._currentExportView = viewName;
  var exportableViews = ['inventory','match','renos','contractors','tenants'];
  var visible = exportableViews.indexOf(viewName) >= 0;
  var wrap = document.getElementById('header_export_wrap_v2');
  if(wrap) wrap.style.display = visible ? 'flex' : 'none';
}
function showContractorsForRole() {
  // All roles see the full contractor directory. Previously non-management
  // roles were routed to a search-only modal (openContractorSearch), which
  // meant HE-L1/L2 couldn't add contractors or browse the list. Approval
  // actions (Recommend / Approve / Decline) are still gated inside the card
  // via APPROVAL_AUTHORITY — HM recommends, ED approves — so opening the
  // directory to everyone widens *access*, not *authority*.
  showContractors();
}
function showInventory(){
  // Inventory lives in inventory.html. Use an element-based check (the page's
  // own view markup) instead of pathname.includes('inventory.html') — clean
  // URL servers like `npx serve` strip the .html extension, so the URL check
  // would falsely fail and trigger a redirect loop on /inventory.
  if(document.getElementById('inventoryView')) {
    if(!window._navSkipPush) pushNav('inventory');
    setExportView('inventory');
    setNavActive('tab_inventory');
    _showView('inventoryView', renderInventoryView);
  } else {
    window.location.href = 'inventory.html?view=inventory';
  }
}
function showTenants(){
  // Tenants lives in tenants.html. Element-based check (see showInventory).
  if(document.getElementById('tenantsView')) {
    if(!window._navSkipPush) pushNav('tenants');
    setExportView('tenants');
    setNavActive('tab_tenants');
    _showView('tenantsView', renderTenantsView);
  } else {
    window.location.href = 'tenants.html';
  }
}
function showWorklist() {
  // The standalone worklistView was folded into landingView (Phase B). If
  // landingView is in DOM (housing.html), expand the section + render. On
  // any other page, navigate to housing.html?view=worklist so the boot
  // dispatches into this function with landingView present.
  if (document.getElementById('landingView') && typeof showLanding === 'function') {
    if(!window._navSkipPush) pushNav('worklist');
    showLanding();
    var sec = document.getElementById('sec-worklist');
    if (sec) sec.classList.remove('collapsed');
    if (typeof renderWorklist === 'function') renderWorklist();
    if (typeof setHeaderNavActive === 'function') setHeaderNavActive('worklist');
    // Bring the worklist section into view — clicking the tab while already
    // on landing otherwise scrolls nowhere and looks like nothing happened.
    if (sec && sec.scrollIntoView) {
      try { sec.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch(_) {}
    }
    // Keep worklist_datetime populated for any downstream readers.
    var dtEl = document.getElementById('worklist_datetime');
    if (dtEl) {
      var now = new Date();
      var days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
      var months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
      var h = now.getHours(), m = now.getMinutes();
      var ampm = h >= 12 ? 'PM' : 'AM';
      h = h % 12 || 12;
      dtEl.textContent = days[now.getDay()] + ' · ' + months[now.getMonth()] + ' ' + now.getDate() + ', ' + now.getFullYear() + ' · ' + h + ':' + (m < 10 ? '0' : '') + m + ' ' + ampm;
    }
    return;
  }
  // Sub-page (inventory / tenants / match / renos / contractors): navigate
  // to housing.html with the view param. The landing-page boot picks it up
  // and dispatches back into this function on the right DOM.
  window.location.href = 'housing.html?view=worklist';
}
// ── Add-Contractor modal: lazy mount ─────────────────────────────────────
// The full markup originally lived only in contractors.html. The SOW modal
// "Add new contractor" affordance is reachable from any page that opens
// SOWs (housing.html, renos.html, …), so on those pages the modal element
// didn't exist and the click silently no-op'd. _ensureAddContractorModal
// injects the markup once per page (idempotent — bails if the modal is
// already in the DOM, which is the case on contractors.html where the
// HTML still ships it directly). Element IDs and inline handlers match
// contractors.html exactly so openAddContractorModal / saveContractor /
// the existing return-to-SOW flow (`_sowAfterContractorSave`) keep
// working with zero changes.
function _ensureAddContractorModal() {
  if (document.getElementById('addContractorModal')) return;
  var wrap = document.createElement('div');
  wrap.innerHTML = _buildAddContractorModalHTML();
  // The builder returns a single root <div id="addContractorModal">.
  var node = wrap.firstChild;
  if (node) document.body.appendChild(node);
}

// Inline toggle helper for the Terms-of-Reference collapser. Pulled out of
// the markup so the builder string doesn't need to embed a quote-soup
// onclick. Matches the original behaviour (rotate the chevron, toggle the
// body display).
function _ctTorToggle(el) {
  var body  = document.getElementById('ct_tor_body');
  var arrow = el && el.querySelector ? el.querySelector('.ct-tor-arrow') : null;
  if (!body) return;
  if (body.style.display === 'block') {
    body.style.display = 'none';
    if (arrow) arrow.style.transform = '';
  } else {
    body.style.display = 'block';
    if (arrow) arrow.style.transform = 'rotate(90deg)';
  }
}

function _buildAddContractorModalHTML() {
  return [
    // TIC-shell layout — mirrors the Tenant Information Card / Edit Unit modal
    // (hero + 6-tile glance strip + tic-tabs + tic-panels + tic-section headers
    // + tic-footer). Overlay is .modal-overlay (shown via display:flex by
    // openAddContractorModal, same as before) at z-900 so it sits above the
    // SOW modal; sowAddNewContractor bumps it to 1000 inline when needed.
    '<div id="addContractorModal" class="modal-overlay modal-z-900">',
      '<div class="tic-shell">',

        // ── Hero ────────────────────────────────────────────────────────
        '<div class="tic-hero">',
          '<div class="tic-hero-main">',
            '<div class="lbl-uppercase-sm">Contractor Application</div>',
            '<h2 id="ct_modal_title" class="tic-name">New Contractor</h2>',
          '</div>',
          '<div class="flex-gap8 flex-wrap">',
            '<button type="button" id="ct_header_print_btn" class="btn btn-ghost hidden" onclick="printContractorAgreement()">🖨 Print / Save PDF</button>',
            '<button type="button" id="ct_header_email_btn" class="btn btn-ghost hidden" onclick="emailContractorAgreement()">✉ Email to Contractor</button>',
            '<button type="button" onclick="closeAddContractorModal()" class="tic-close-btn" aria-label="Close">✕</button>',
          '</div>',
        '</div>',

        // ── Info strip (6 tiles: Status/Trade/Phone/Email/WSIB exp/Ins exp) ──
        '<div class="tic-strip">',
          '<div class="tic-strip-tile"><span class="tic-strip-icon">📋</span><div class="tic-strip-lbl">Status</div><div id="cic_strip_status" class="tic-strip-val">—</div></div>',
          '<div class="tic-strip-tile"><span class="tic-strip-icon">🔧</span><div class="tic-strip-lbl">Trade</div><div id="cic_strip_trade" class="tic-strip-val">—</div></div>',
          '<div class="tic-strip-tile"><span class="tic-strip-icon">📞</span><div class="tic-strip-lbl">Phone</div><div id="cic_strip_phone" class="tic-strip-val">—</div></div>',
          '<div class="tic-strip-tile"><span class="tic-strip-icon">✉️</span><div class="tic-strip-lbl">Email</div><div id="cic_strip_email" class="tic-strip-val">—</div></div>',
          '<div class="tic-strip-tile"><span class="tic-strip-icon">🦺</span><div class="tic-strip-lbl">WSIB Expiry</div><div id="cic_strip_wsib" class="tic-strip-val">—</div></div>',
          '<div class="tic-strip-tile"><span class="tic-strip-icon">🛡️</span><div class="tic-strip-lbl">Insurance Expiry</div><div id="cic_strip_ins" class="tic-strip-val">—</div></div>',
        '</div>',

        // Inline approval surface (edit/view mode only). Sits between the strip
        // and the tabs so the status banner + action pills read at a glance.
        '<div id="cic_approval_surface" style="display:none;margin:12px 28px 0;">',
          '<div id="cic_status_banner" class="ct-status-banner"></div>',
          '<div id="cic_actions"></div>',
          '<div id="cic_notes_wrap" class="cic-notes-wrap" style="display:none;">',
            '<label class="cic-notes-label">Notes <span id="cic_notes_req" class="cic-notes-req"></span></label>',
            '<textarea id="cic_notes" rows="2" class="cic-notes-input"></textarea>',
            '<div class="cic-notes-actions">',
              '<button type="button" onclick="cancelCtAction()" class="btn btn-ghost btn-sm">Cancel</button>',
              '<button type="button" id="cic_confirm_btn" onclick="confirmCtAction()" class="btn btn-primary btn-sm">Confirm</button>',
            '</div>',
          '</div>',
        '</div>',

        // ── Tabs ────────────────────────────────────────────────────────
        '<div class="tic-tabs" id="cic_tab_bar" role="tablist">',
          '<button type="button" class="tic-tab tic-active" data-cic-tab="overview"   onclick="setCicTab(\'overview\')"   role="tab">Overview</button>',
          '<button type="button" class="tic-tab"            data-cic-tab="notes"      onclick="setCicTab(\'notes\')"      role="tab">Notes</button>',
          '<button type="button" class="tic-tab"            data-cic-tab="compliance" onclick="setCicTab(\'compliance\')" role="tab">Compliance</button>',
          '<button type="button" class="tic-tab"            data-cic-tab="documents"  onclick="setCicTab(\'documents\')"  role="tab">Documents</button>',
          '<button type="button" class="tic-tab"            data-cic-tab="terms"      onclick="setCicTab(\'terms\')"      role="tab">Terms</button>',
          '<button type="button" class="tic-tab"            data-cic-tab="sigs"       onclick="setCicTab(\'sigs\')"       role="tab">Signatures</button>',
        '</div>',

        // ── Body / tab panels ───────────────────────────────────────────
        '<div class="tic-body">',

          // ── OVERVIEW tab ──────────────────────────────────────────────
          '<div class="tic-panel tic-active" data-cic-panel="overview">',

            '<div class="tic-section">',
              '<div class="tic-section-h">Company Information</div>',
              '<div class="grid-c2-10">',
                '<div class="f ct-full-col"><label>Company / Name <span class="r">*</span></label><input id="ct_name" type="text" placeholder="e.g. Northern Builds Ltd."/></div>',
                '<div class="f"><label>Trade / Specialty</label>',
                  '<select id="ct_trade">',
                    '<option value="">— Select trade —</option>',
                    '<optgroup label="General Construction"><option>General Contractor</option><option>Carpentry / Framing</option><option>Concrete &amp; Foundations</option><option>Demolition</option><option>Insulation</option><option>Roofing</option><option>Flooring</option><option>Drywall / Plastering</option><option>Painting &amp; Finishing</option><option>Windows &amp; Doors</option></optgroup>',
                    '<optgroup label="Mechanical &amp; Utilities"><option>Plumbing</option><option>Electrical</option><option>HVAC / Heating &amp; Cooling</option><option>Mechanical</option><option>Gas Fitting</option><option>Sprinkler / Fire Suppression</option></optgroup>',
                    '<optgroup label="Exterior &amp; Site Work"><option>Excavation &amp; Grading</option><option>Civil Works</option><option>Landscaping</option><option>Septic &amp; Drainage</option><option>Siding &amp; Cladding</option></optgroup>',
                    '<optgroup label="Professional Services"><option>Architecture</option><option>Structural Engineering</option><option>Civil Engineering</option><option>Project Management</option><option>Building Inspection</option><option>Environmental Consulting</option><option>Interior Design</option></optgroup>',
                    '<optgroup label="Accessibility &amp; Specialty"><option>Accessibility Modifications</option><option>Mould Remediation</option><option>Asbestos Abatement</option><option>Energy Efficiency / Retrofits</option></optgroup>',
                  '</select>',
                '</div>',
                '<div class="f"><label>Phone</label><input id="ct_phone" type="tel" placeholder="(705)-000-0000" oninput="fmtPhone(this)"/></div>',
                '<div class="f"><label>Email</label><input id="ct_email" type="email" placeholder="contact@company.com"/></div>',
                '<div class="f"><label>Address</label><input id="ct_address" type="text" placeholder="Company address"/></div>',
                '<div class="f"><label>HST / Business #</label><input id="ct_hst" type="text" placeholder="123456789 RT0001"/></div>',
              '</div>',
            '</div>',

            '<div class="tic-section tic-section-spaced">',
              '<div class="tic-section-h flex-sb">',
                '<span>Key People</span>',
                '<button type="button" onclick="ctAddPerson()" class="btn btn-primary btn-sm">+ Add Person</button>',
              '</div>',
              '<div id="ct_people_list" class="ct-people-list"></div>',
            '</div>',

          '</div>',

          // ── NOTES tab (contractor_notes append-only log) ──────────────
          '<div class="tic-panel" data-cic-panel="notes"><div id="cic_notes_mount" style="padding:6px 2px;"></div></div>',

          // ── COMPLIANCE tab ────────────────────────────────────────────
          '<div class="tic-panel" data-cic-panel="compliance">',

            '<div class="tic-section">',
              '<div class="tic-section-h">WSIB Clearance Certificate</div>',
              '<div class="ct-sec-col">',
                '<div class="grid-c2-10">',
                  '<div class="f"><label>WSIB Account #</label><input id="ct_wsib_num" type="text" placeholder="1234567"/></div>',
                  '<div class="f"><label>Expiry Date</label><input id="ct_wsib_expiry" type="date"/></div>',
                '</div>',
                '<div id="ct_wsib_preview" class="ct-upload-preview"></div>',
                '<div id="ct_wsib_drop" ondragover="ctFileDragOver(event,\'ct_wsib_drop\')" ondragleave="ctFileDragLeave(\'ct_wsib_drop\')" ondrop="ctFileDrop(event,\'wsib\')" class="upload-zone" onclick="document.getElementById(\'ct_wsib_input\').click()">',
                  '<div class="ct-upload-label">📎 Upload WSIB Certificate &nbsp;<span class="lbl-yellow">browse</span></div>',
                '</div>',
                '<input type="file" id="ct_wsib_input" accept=".pdf,image/*" style="display:none;" onchange="ctFileUpload(this,\'wsib\')"/>',
              '</div>',
            '</div>',

            '<div class="tic-section tic-section-spaced">',
              '<div class="tic-section-h">Liability Insurance</div>',
              '<div class="ct-sec-col">',
                // Provider + Coverage were dropped in the CIC rebuild while the
                // save kept reading them — every edit-save wiped the stored
                // values to ''. Restored so compliance data round-trips again.
                '<div class="grid-c2-10">',
                  '<div class="f"><label>Insurance Provider</label><input id="ct_ins_provider" type="text" placeholder="e.g. Intact, Aviva"/></div>',
                  '<div class="f"><label>Coverage Amount ($)</label><input id="ct_ins_amount" type="text" inputmode="decimal" placeholder="e.g. 2,000,000"/></div>',
                '</div>',
                '<div class="grid-c2-10">',
                  '<div class="f"><label>Policy #</label><input id="ct_ins_policy" type="text" placeholder="Policy number"/></div>',
                  '<div class="f"><label>Expiry Date</label><input id="ct_ins_expiry" type="date"/></div>',
                '</div>',
                '<div id="ct_insurance_preview" class="ct-upload-preview"></div>',
                '<div id="ct_insurance_drop" ondragover="ctFileDragOver(event,\'ct_insurance_drop\')" ondragleave="ctFileDragLeave(\'ct_insurance_drop\')" ondrop="ctFileDrop(event,\'insurance\')" class="upload-zone" onclick="document.getElementById(\'ct_insurance_input\').click()">',
                  '<div class="ct-upload-label">📎 Upload Insurance Certificate &nbsp;<span class="lbl-yellow">browse</span></div>',
                '</div>',
                '<input type="file" id="ct_insurance_input" accept=".pdf,image/*" style="display:none;" onchange="ctFileUpload(this,\'insurance\')"/>',
              '</div>',
            '</div>',

            '<div class="tic-section tic-section-spaced">',
              '<div class="tic-section-h">Classification &amp; Compliance</div>',
              '<div class="ct-sec-col-gap12">',
                '<div>',
                  '<div class="ct-lbl-muted">Contractor Classification</div>',
                  '<div id="ct_class_options" class="ct-sec-col">',
                    '<label class="ct-class-option"><input type="radio" name="ct_classification" value="internal_indigenous" onchange="ctUpdateClassBorder(this)"/><div class="ct-class-meta"><div class="ct-txt-xs-val">Internal — Indigenous</div><div class="ct-txt-sm-muted"><span data-nation="short">CLFN</span> member or Indigenous-owned business</div></div></label>',
                    '<label class="ct-class-option"><input type="radio" name="ct_classification" value="external_indigenous" onchange="ctUpdateClassBorder(this)"/><div class="ct-class-meta"><div class="ct-txt-xs-val">External — Indigenous</div><div class="ct-txt-sm-muted">Non-<span data-nation="short">CLFN</span> Indigenous business</div></div></label>',
                    '<label class="ct-class-option"><input type="radio" name="ct_classification" value="external_non_indigenous" onchange="ctUpdateClassBorder(this)"/><div class="ct-class-meta"><div class="ct-txt-xs-val">External — Non-Indigenous</div><div class="ct-txt-sm-muted">Non-Indigenous owned business</div></div></label>',
                  '</div>',
                  '<div id="ct_class_proof_row" class="f" style="display:none;"><label>Classification Proof / Notes</label><input id="ct_class_proof" type="text" placeholder="Optional — document number, notes"/></div>',
                '</div>',
              '</div>',
            '</div>',

          '</div>',

          // ── DOCUMENTS tab ─────────────────────────────────────────────
          '<div class="tic-panel" data-cic-panel="documents">',
            '<div class="tic-section">',
              '<div class="tic-section-h">Other Documents</div>',
              '<div class="ct-sec-col">',
                '<div id="ct_other_preview" class="ct-upload-preview"></div>',
                '<div id="ct_other_drop" ondragover="ctFileDragOver(event,\'ct_other_drop\')" ondragleave="ctFileDragLeave(\'ct_other_drop\')" ondrop="ctFileDrop(event,\'other\')" class="upload-zone" onclick="document.getElementById(\'ct_other_input\').click()">',
                  '<div class="ct-upload-label">📎 Upload Other Documents &nbsp;<span class="lbl-yellow">browse</span></div>',
                '</div>',
                '<input type="file" id="ct_other_input" multiple accept=".pdf,image/*,.doc,.docx" style="display:none;" onchange="ctFileUpload(this,\'other\')"/>',
              '</div>',
            '</div>',
          '</div>',

          // ── TERMS tab ─────────────────────────────────────────────────
          '<div class="tic-panel" data-cic-panel="terms">',
            '<div class="tic-section">',
              '<div class="tic-section-h ct-tor-toggle" onclick="_ctTorToggle(this)">',
                '<span>Terms of Reference</span>',
                '<svg class="ct-tor-arrow" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>',
              '</div>',
              '<div id="ct_tor_body" class="ct-tor-body">',
                '<div class="ct-tor-lbl" data-nation-template="{NATION} — Housing Contractor Terms of Reference">Constance Lake First Nation — Housing Contractor Terms of Reference</div>',
                '<div class="ct-sec-col">',
                  '<div class="ct-tor-clause"><div class="ct-txt-xs-val">1. Compliance with Laws</div><div class="ct-txt-sm-muted">The contractor agrees to comply with all applicable federal, provincial, and municipal laws...</div></div>',
                  '<div class="ct-tor-clause"><div class="ct-txt-xs-val">2. Insurance &amp; WSIB</div><div class="ct-txt-sm-muted">Valid liability insurance and WSIB clearance must be maintained throughout the engagement.</div></div>',
                  '<div class="ct-tor-clause"><div class="ct-txt-xs-val">3. Indigenous Procurement</div><div class="ct-txt-sm-muted"><span data-nation="short">CLFN</span> prioritizes Indigenous-owned businesses and encourages subcontracting to community members.</div></div>',
                  '<div class="ct-tor-clause"><div class="ct-txt-xs-val">4. Community Conduct</div><div class="ct-txt-sm-muted">All personnel must conduct themselves respectfully on <span data-nation="short">CLFN</span> territory at all times.</div></div>',
                  '<div class="ct-tor-clause"><div class="ct-txt-xs-val">5. Confidentiality</div><div class="ct-txt-sm-muted">Contractor agrees to keep all resident and community information strictly confidential.</div></div>',
                  '<div class="ct-tor-clause"><div class="ct-txt-xs-val">6. Dispute Resolution</div><div class="ct-txt-sm-muted">Any disputes will be resolved through <span data-nation="short">CLFN</span> internal processes before external arbitration.</div></div>',
                  '<div class="ct-tor-clause"><div class="ct-txt-xs-val">7. Environmental Responsibility</div><div class="ct-txt-sm-muted">Work must comply with environmental standards; hazardous materials must be disposed of properly.</div></div>',
                '</div>',
                '<div class="ct-tor-note"><div class="ct-txt-sm-muted">This agreement becomes binding upon submission and <span data-nation="short">CLFN</span> approval of this contractor application.</div></div>',
                '<div class="ct-class-actions" style="margin-top:12px;">',
                  '<input type="checkbox" id="ct_tor_agreed" onchange="ctUpdateClassBorder(this)"/>',
                  '<label for="ct_tor_agreed" class="ct-txt-sm-muted">I agree to the Terms of Reference above</label>',
                '</div>',
              '</div>',
            '</div>',
          '</div>',

          // ── SIGNATURES tab ────────────────────────────────────────────
          '<div class="tic-panel" data-cic-panel="sigs">',
            '<div class="tic-section">',
              '<div class="tic-section-h">Signatures</div>',
              '<div class="ct-sec-col-lg">',
                '<div class="ct-txt-sm-muted">By signing below, both parties acknowledge the accuracy of the information provided and agreement to the Terms of Reference above.</div>',

                // Staff signature
                '<div class="ct-sig-block">',
                  '<div class="ct-sig-header">',
                    '<div class="ct-sig-avatar-hm">HM</div>',
                    '<div><div class="ct-txt-sm-val" data-nation-template="{SHORT} Housing Staff">CLFN Housing Staff</div><div class="ct-txt-xs-muted">Employee taking this application</div></div>',
                  '</div>',
                  '<div class="ct-sig-grid">',
                    '<div class="f"><label>Printed Name</label><input type="text" id="ct_sig_staff_name" placeholder="Full name"/></div>',
                    '<div class="f"><label>Date</label><input type="date" id="ct_sig_staff_date"/></div>',
                  '</div>',
                  '<div class="ct-sig-wrap">',
                    '<div class="ct-sig-tabs">',
                      '<button type="button" onclick="setSigMethod(\'ct_sig_canvas_staff\',\'canvas\')" id="ct_sig_canvas_staff_tab_canvas" class="ct-sig-tab active">✏️ Draw</button>',
                      '<button type="button" onclick="setSigMethod(\'ct_sig_canvas_staff\',\'type\')"   id="ct_sig_canvas_staff_tab_type"   class="ct-sig-tab">⌨️ Type</button>',
                      '<button type="button" onclick="setSigMethod(\'ct_sig_canvas_staff\',\'wet\')"    id="ct_sig_canvas_staff_tab_wet"    class="ct-sig-tab">🖊 Wet / E-Sign</button>',
                    '</div>',
                    '<div id="ct_sig_canvas_staff_panel_canvas" class="ct-sig-panel">',
                      '<canvas id="ct_sig_canvas_staff" width="560" height="90" class="ct-sig-canvas"></canvas>',
                      '<div class="ct-sig-canvas-foot"><span class="ct-txt-xs-muted">Sign with finger or mouse</span><button type="button" onclick="clearSig(\'ct_sig_canvas_staff\')" class="ct-sig-clear">Clear</button></div>',
                    '</div>',
                    '<div id="ct_sig_canvas_staff_panel_type" class="ct-sig-panel hidden">',
                      '<input type="text" id="ct_sig_canvas_staff_typed" placeholder="Type full legal name" class="ct-sig-typed"/>',
                      '<div class="ct-sig-note">Typing your name constitutes a legal electronic signature</div>',
                    '</div>',
                    '<div id="ct_sig_canvas_staff_panel_wet" class="ct-sig-panel hidden">',
                      '<div class="ct-sig-wet-note">Print this form for a wet signature, or send via DocuSign / Adobe Sign and attach the signed copy.</div>',
                      '<input type="text" id="ct_sig_canvas_staff_wet_ref" placeholder="Reference # or e-sign envelope ID (optional)" class="ct-sig-wet-input"/>',
                    '</div>',
                  '</div>',
                '</div>',

                // Contractor signature
                '<div class="ct-sig-block">',
                  '<div class="ct-sig-header">',
                    '<div class="ct-sig-avatar-ct">CT</div>',
                    '<div><div class="ct-txt-sm-val">Contractor Representative</div><div class="ct-txt-xs-muted">Authorized signatory for the contracting business</div></div>',
                  '</div>',
                  '<div class="ct-sig-grid">',
                    '<div class="f"><label>Printed Name</label><input type="text" id="ct_sig_ct_name" placeholder="Full name"/></div>',
                    '<div class="f"><label>Title / Role</label><input type="text" id="ct_sig_ct_title" placeholder="e.g. Owner, Project Manager"/></div>',
                    '<div class="f"><label>Date</label><input type="date" id="ct_sig_ct_date"/></div>',
                  '</div>',
                  '<div class="ct-sig-wrap">',
                    '<div class="ct-sig-tabs">',
                      '<button type="button" onclick="setSigMethod(\'ct_sig_canvas_ct\',\'canvas\')" id="ct_sig_canvas_ct_tab_canvas" class="ct-sig-tab active">✏️ Draw</button>',
                      '<button type="button" onclick="setSigMethod(\'ct_sig_canvas_ct\',\'type\')"   id="ct_sig_canvas_ct_tab_type"   class="ct-sig-tab">⌨️ Type</button>',
                      '<button type="button" onclick="setSigMethod(\'ct_sig_canvas_ct\',\'wet\')"    id="ct_sig_canvas_ct_tab_wet"    class="ct-sig-tab">🖊 Wet / E-Sign</button>',
                    '</div>',
                    '<div id="ct_sig_canvas_ct_panel_canvas" class="ct-sig-panel">',
                      '<canvas id="ct_sig_canvas_ct" width="560" height="90" class="ct-sig-canvas"></canvas>',
                      '<div class="ct-sig-canvas-foot"><span class="ct-txt-xs-muted">Sign with finger or mouse</span><button type="button" onclick="clearSig(\'ct_sig_canvas_ct\')" class="ct-sig-clear">Clear</button></div>',
                    '</div>',
                    '<div id="ct_sig_canvas_ct_panel_type" class="ct-sig-panel hidden">',
                      '<input type="text" id="ct_sig_canvas_ct_typed" placeholder="Type full legal name" class="ct-sig-typed"/>',
                      '<div class="ct-sig-note">Typing your name constitutes a legal electronic signature</div>',
                    '</div>',
                    '<div id="ct_sig_canvas_ct_panel_wet" class="ct-sig-panel hidden">',
                      '<div class="ct-sig-wet-note">Print this form for a wet signature, or send via DocuSign / Adobe Sign and attach the signed copy.</div>',
                      '<input type="text" id="ct_sig_canvas_ct_wet_ref" placeholder="Reference # or e-sign envelope ID (optional)" class="ct-sig-wet-input"/>',
                    '</div>',
                  '</div>',
                '</div>',

              '</div>',
            '</div>',
          '</div>',

        '</div>', // end tic-body

        // ── Footer (mirrors the TIC / Edit Unit footer) ─────────────────
        // Print/Email footer copies are kept (hidden) for the open-logic that
        // toggles ct_print_btn/ct_email_btn; the header copies in the hero are
        // the visible surface. Cancel + the single primary Save sit at the end.
        '<div class="tic-footer">',
          '<button type="button" id="ct_print_btn" class="btn btn-ghost hidden" onclick="printContractorAgreement()">🖨 Print / Save PDF</button>',
          '<button type="button" id="ct_email_btn" class="btn btn-ghost hidden" onclick="emailContractorAgreement()">✉ Email to Contractor</button>',
          '<span class="tic-footer-spacer"></span>',
          '<div id="cic_review_progress" class="txt-muted-sm cic-review-progress"></div>',
          '<button type="button" onclick="closeAddContractorModal()" class="btn btn-ghost">Cancel</button>',
          '<button type="button" id="ct_save_btn" onclick="saveContractorAndFinalize()" class="btn btn-primary" data-mode="draft">💾 Save Draft</button>',
        '</div>',

      '</div>', // end tic-shell
    '</div>'    // end addContractorModal
  ].join('');
}

function sowAddNewContractor() {
  var dd = document.getElementById('sow_ct_dropdown');
  if(dd) dd.style.display = 'none';
  // Lazy-mount the modal on pages that don't ship it directly (housing.html,
  // renos.html, …). No-op on contractors.html where the markup already exists.
  _ensureAddContractorModal();
  var typed = (document.getElementById('sow_contractor')||{}).value||'';
  // Open via the canonical helper so all per-mode setup (radio default,
  // signature pads, save-button gate, tab reset, file-bucket state) runs.
  if(typeof openAddContractorModal === 'function') openAddContractorModal();
  // The SOW modal sits at z-index 900 (.modal-overlay.modal-z-900); the
  // contractor modal defaults to 800, so without this bump it opens
  // behind the SOW and looks like nothing happened. Set inline so the
  // boost is scoped to this open and reset by closeAddContractorModal.
  var acm = document.getElementById('addContractorModal');
  if(acm) acm.style.zIndex = '1000';
  // Pre-fill the name field with whatever the user already typed into the
  // SOW contractor combobox. Done AFTER openAddContractorModal so its reset
  // logic doesn't blow it away.
  var nameField = document.getElementById('ct_name');
  if(nameField && typed) nameField.value = typed;
  // Flag for the save handler to back-fill the SOW contractor + id and skip
  // the post-save re-render of the contractors list view.
  window._sowAfterContractorSave = true;
}
// Nation-driven label for the in-house Housing Department option. No hardcoded
// nation name — derived from NATION_CONFIG (Settings → Nation).
function sowInHouseLabel() {
  var s = (window.NATION_CONFIG && (NATION_CONFIG.short || NATION_CONFIG.display_name)) || '';
  return (s ? s + ' Housing Department' : 'Housing Department');
}
window.sowInHouseLabel = sowInHouseLabel;

function sowContractorSearch(q) {
  var dd = document.getElementById('sow_ct_dropdown');
  if(!dd) return;
  var contractors = window._contractors || [];
  var term = (q||'').toLowerCase().trim();
  var matches = term
    ? contractors.filter(function(c){ return (c.name||'').toLowerCase().includes(term)||(c.trade||'').toLowerCase().includes(term); })
    : contractors;

  var rows = [];
  // In-house Housing Department always offered first (it's the nation's own crew).
  // Shown unless the search term clearly doesn't match "housing"/the nation name.
  var inh = sowInHouseLabel();
  if(!term || inh.toLowerCase().indexOf(term) !== -1 || 'housing department in-house crew'.indexOf(term) !== -1){
    rows.push('<div data-ct-inhouse="1" onmousedown="sowSelectInHouse(this)" '
      +'style="padding:9px 14px;cursor:pointer;font-size:13px;border-bottom:1px solid var(--border);background:#fffdf2;" '
      +'onmouseover="this.style.background=\'var(--bg)\'" onmouseout="this.style.background=\'#fffdf2\'">'
      +'<div style="font-weight:700;">&#127968; '+inh+'</div>'
      +'<div class="js-lbl-sm">In-house crew — assign a field employee</div>'
      +'</div>');
  }

  // Names/trades/query escaped — a contractor name containing a double quote
  // broke the data-ct-name attribute (wrong name written onto the request), and
  // an HTML payload in name/trade/q executed in the dropdown.
  rows = rows.concat(matches.map(function(c){
    return '<div data-ct-name="'+escapeHtml(c.name)+'" data-ct-id="'+escapeHtml(c.id||'')+'" onmousedown="sowSelectContractor(this)" '
      +'style="padding:9px 14px;cursor:pointer;font-size:13px;border-bottom:1px solid var(--border);" '
      +'onmouseover="this.style.background=\'var(--bg)\'" onmouseout="this.style.background=\'\'">'
      +'<div style="font-weight:600;">'+escapeHtml(c.name)+'</div>'
      +(c.trade?'<div class="js-lbl-sm">'+escapeHtml(c.trade)+'</div>':'')
      +'</div>';
  }));

  if(!matches.length && term) {
    rows.push('<div style="padding:9px 14px;font-size:12px;color:var(--muted);">'
      +'No contractor matching "'+escapeHtml(q)+'" found.</div>');
  }
  rows.push('<div onmousedown="sowAddNewContractor()" style="padding:9px 14px;cursor:pointer;font-size:12px;font-weight:700;color:var(--yellow);border-top:1px solid var(--border);display:flex;align-items:center;gap:6px;" '
    +'onmouseover="this.style.background=\'var(--bg)\'" onmouseout="this.style.background=\'\'">'
    +'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>'
    +(term&&!matches.length?'Add "'+escapeHtml(q)+'" as new contractor':'Add new contractor')
    +'</div>');

  dd.innerHTML = rows.join('');
  dd.style.display = 'block';
}
function sowSelectContractor(el) {
  var name = el.getAttribute('data-ct-name');
  var id   = el.getAttribute('data-ct-id');
  var inp  = document.getElementById('sow_contractor');
  var hid  = document.getElementById('sow_contractor_id');
  var team = document.getElementById('sow_assigned_team');
  var feSel= document.getElementById('sow_assigned_to');
  if(inp) inp.value = name;
  if(hid) hid.value = id;
  if(team) team.value = 'contractor';
  // External contractor — no field-employee sub-menu.
  if(feSel){ feSel.value = ''; feSel.style.display = 'none'; }
  var dd = document.getElementById('sow_ct_dropdown');
  if(dd) dd.style.display = 'none';
}
// In-house Housing Department picked — flag the work as in-house and reveal the
// field-employee sub-menu so a key person can be assigned.
function sowSelectInHouse(el) {
  var inp  = document.getElementById('sow_contractor');
  var hid  = document.getElementById('sow_contractor_id');
  var team = document.getElementById('sow_assigned_team');
  var feSel= document.getElementById('sow_assigned_to');
  if(inp) inp.value = (typeof sowInHouseLabel === 'function') ? sowInHouseLabel() : 'Housing Department';
  if(hid) hid.value = '';
  if(team) team.value = 'in_house';
  var dd = document.getElementById('sow_ct_dropdown');
  if(dd) dd.style.display = 'none';
  if(typeof _sowPopulateFieldEmployees === 'function') {
    _sowPopulateFieldEmployees((feSel && feSel.value) || '');
  }
  if(feSel) feSel.style.display = '';
}
window.sowSelectInHouse = sowSelectInHouse;
function triggerPrint() {
  if(!_printPanelDoc) return;
  // Use a hidden iframe — no popup blocker, panel stays visible
  var iframe = document.getElementById('_printFrame');
  if(!iframe) {
    iframe = document.createElement('iframe');
    iframe.id = '_printFrame';
    iframe.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;border:none;';
    document.body.appendChild(iframe);
  }
  iframe.onload = function() {
    setTimeout(function() {
      try {
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
      } catch(e) {
        window.print();
      }
    }, 300);
  };
  iframe.srcdoc = _printPanelDoc;
}
function updateBudgetTotal(){
  var total = 0;
  BUDGET_POOLS.forEach(function(p){
    var el = document.getElementById('budget_alloc_'+p.id);
    total += parseFloat((el&&el.value)||0) || 0;
  });
  var gt = document.getElementById('budget_grand_total');
  if(gt) gt.textContent = formatCurrency(total);
}
function userLookupDebounce(){
  clearTimeout(window._userLookupTimer);
  window._userLookupTimer = setTimeout(lookupUser, 400);
}
// (removed dead worklist helpers wlEditApp / wlPreviewApp / wlEmpty — the
//  current renderWorklist builds its own markup and calls none of them. See
//  DEAD_CODE_AUDIT.md.)
function wlOpenApp(el) {
  // Accepts an application id STRING (the only live caller — selectTenantRecord
  // — passes rec.appId; the old element-only signature made every such click
  // throw a TypeError) or a legacy element carrying data-wl-id.
  var id = (typeof el === 'string')
    ? el
    : (el && el.getAttribute && (el.getAttribute('data-wl-id') || (el.closest && el.closest('[data-wl-id]') && el.closest('[data-wl-id]').getAttribute('data-wl-id'))));
  if(!id) return;
  var apps = typeof applications !== 'undefined' ? applications : [];
  var app = apps.find(function(x){ return x.id === id; });
  if(!app) return;
  // Branch by status
  if(app.status === APP_STATUS.DRAFT || app.status === 'returned') {
    // Open the edit form so they can complete/update it
    if(typeof window.openEditModal === 'function') window.openEditModal(id);
  } else {
    // All other statuses — open read-only scorecard
    if(true) showScorecard(app);
  }
}
// (removed dead worklist helpers wlAssignApp / wlOpenApplicantCell /
//  wlOpenIdCell / wlSection — superseded when renderWorklist was rewritten.
//  See DEAD_CODE_AUDIT.md.)
/* ════════════════════════════════════════════════════════════════════════════
 * SHARED DOMAIN FUNCTIONS — BATCH 2
 * Diverged-but-equivalent (housing.html version used — most complete).
 * ════════════════════════════════════════════════════════════════════════════ */

function _migrateLegacySow(rawData){
  // Returns { sows: [...] } regardless of input shape.
  if(!rawData) return { sows: [] };
  if(Array.isArray(rawData.sows)) return rawData;  // already new format
  // Legacy flat SOW — wrap as single-item list.
  // Synthesize project_number from address if missing; preserve all fields.
  var legacy = Object.assign({}, rawData);
  if(!legacy.project_number) legacy.project_number = (legacy.address || 'UNIT') + '-SOW-001';
  if(!legacy.created_at) legacy.created_at = legacy.date || new Date().toISOString().slice(0,10);
  if(!legacy.approval_status){
    // Derive from existing approval fields if present.
    if(legacy.ed_approved) legacy.approval_status = 'ed_approved';
    else if(legacy.hm_approved) legacy.approval_status = 'hm_approved';
    else if(legacy.tenant_signed_at || legacy.staff_signed_at) legacy.approval_status = 'signed';
    else legacy.approval_status = 'draft';
  }
  if(legacy.amount == null){
    // Try common fields where the amount might live.
    var amt = legacy.estimated_total || legacy.total_cost || legacy.budget || 0;
    legacy.amount = typeof amt === 'number' ? amt : (parseFloat(String(amt).replace(/[^0-9.\-]/g,''))||0);
  }
  return { sows: [legacy] };
}

function _realRoleForPermissions(){
  // For override authority we check the REAL role, not view-as.
  // This way an ED previewing "as HM" still has edit power on completed SOWs.
  return window._realRole || window.currentRole || '';
}

function calcRenoScore(unitId) {
  var model = getRenoScoreModel();
  var score = 0;
  var breakdown = [];

  var allUnits = getAllUnits();
  var u = allUnits.find(function(x){ return x.id === unitId; });
  if(!u) return {score:0, breakdown:[]};

  var sow = null;
  sow = getSowData(unitId);

  function addPts(id, label, pts) {
    if(pts) { score += pts; breakdown.push({label:label, pts:pts}); }
  }

  // Condition
  var status = u.status||'';
  var cond   = u.homeCondition||'';
  if(status === 'condemned') {
    addPts('rs_cond_critical', 'Condemned / Critical', _rsm(model,'rs_cond_critical'));
  } else if(cond === 'Poor') {
    addPts('rs_cond_poor', 'Poor condition', _rsm(model,'rs_cond_poor'));
  } else if(cond === 'Average') {
    addPts('rs_cond_average', 'Average condition', _rsm(model,'rs_cond_average'));
  } else if(cond === 'Good') {
    addPts('rs_cond_good', 'Good condition', _rsm(model,'rs_cond_good'));
  }

  // Critical Systems — detect from SOW line item categories (additive)
  if(sow && sow.items && sow.items.length) {
    var cats = sow.items.map(function(it){ return (it.category||'').toLowerCase(); });
    var systems = [
      {id:'rs_sys_furnace',    label:'Furnace / Heating',       match:['heating','hvac']},
      {id:'rs_sys_hvac',       label:'HVAC / Ventilation',      match:['hvac','ventil']},
      {id:'rs_sys_electrical', label:'Electrical system',       match:['electrical']},
      {id:'rs_sys_roof',       label:'Roofing',                 match:['roof']},
      {id:'rs_sys_windows',    label:'Windows & Doors',         match:['windows','doors']},
    ];
    systems.forEach(function(sys) {
      var found = cats.some(function(c){ return sys.match.some(function(m){ return c.includes(m); }); });
      if(found) addPts(sys.id, sys.label+' in SOW', _rsm(model, sys.id));
    });
  }

  // SOW cost
  var totalCost = sow ? parseFloat((sow.totalCost||'').replace(/[^0-9.]/g,''))||0 : 0;
  if(totalCost >= 50000)       addPts('rs_cost_5', 'SOW $50k+',          _rsm(model,'rs_cost_5'));
  else if(totalCost >= 25001)  addPts('rs_cost_4', 'SOW $25k–$50k',      _rsm(model,'rs_cost_4'));
  else if(totalCost >= 10001)  addPts('rs_cost_3', 'SOW $10k–$25k',      _rsm(model,'rs_cost_3'));
  else if(totalCost >= 2501)   addPts('rs_cost_2', 'SOW $2.5k–$10k',     _rsm(model,'rs_cost_2'));
  else if(sow)                 addPts('rs_cost_1', 'SOW < $2.5k',         _rsm(model,'rs_cost_1'));

  // Hazards (additive)
  if(sow) {
    var hazards = [
      {key:'mold',       id:'rs_haz_mold',       label:'Mould hazard'},
      {key:'asbestos',   id:'rs_haz_asbestos',    label:'Asbestos risk'},
      {key:'electrical', id:'rs_haz_electrical',  label:'Electrical hazard'},
      {key:'structural', id:'rs_haz_structural',  label:'Structural concern'},
      {key:'plumbing',   id:'rs_haz_plumbing',    label:'Plumbing failure'},
      {key:'fire',       id:'rs_haz_fire',         label:'Fire safety concern'},
    ];
    hazards.forEach(function(h) {
      if(sow[h.key]) addPts(h.id, h.label, _rsm(model, h.id));
    });
  }

  // SOW scope (item count)
  var itemCount = sow && sow.items ? sow.items.length : 0;
  if(itemCount >= 10)      addPts('rs_items_5', itemCount+' SOW items', _rsm(model,'rs_items_5'));
  else if(itemCount >= 6)  addPts('rs_items_4', itemCount+' SOW items', _rsm(model,'rs_items_4'));
  else if(itemCount >= 3)  addPts('rs_items_3', itemCount+' SOW items', _rsm(model,'rs_items_3'));
  else if(itemCount >= 1)  addPts('rs_items_2', itemCount+' SOW item'+(itemCount>1?'s':''), _rsm(model,'rs_items_2'));

  // Tenant Conduct — Damage (additive, increases urgency)
  if(sow) {
    if(sow.tenantDamage)  addPts('rs_ten_damage',    'Tenant-caused damage',   _rsm(model,'rs_ten_damage'));
    if(sow.negligence)    addPts('rs_ten_negligence', 'Negligence',             _rsm(model,'rs_ten_negligence'));
    if(sow.vandalism)     addPts('rs_ten_vandalism',  'Vandalism',              _rsm(model,'rs_ten_vandalism'));
    if(sow.policeReport)  addPts('rs_ten_police',     'Police report on file',  _rsm(model,'rs_ten_police'));
  }

  // Tenant Arrears — look up from linked application (mirrors housing app scoring, negative)
  var arrAmt = 0;
  var payMonths = 0;
  if(u && u.assignedTo) {
    var apps = typeof applications !== 'undefined' ? applications : [];
    var linkedApp = apps.find(function(a){ return a.id === u.assignedTo; });
    if(linkedApp) {
      arrAmt = parseFloat(linkedApp.arrBalAmt)||0;
      payMonths = parseInt(linkedApp.arrPlanMonths)||0;
    }
  }
  // Also check SOW rent arrears flag as fallback
  if(sow && sow.rentArrears && arrAmt === 0) arrAmt = 1; // flag set but no linked app amount — treat as minimal

  if(arrAmt <= 0) {
    addPts('rs_arr_0', 'No arrears', 0);
  } else if(arrAmt <= 500) {
    addPts('rs_arr_1', 'Arrears $1–$500', _rsm(model,'rs_arr_1'));
  } else if(arrAmt <= 1500) {
    addPts('rs_arr_2', 'Arrears $501–$1,500', _rsm(model,'rs_arr_2'));
  } else if(arrAmt <= 3000) {
    addPts('rs_arr_3', 'Arrears $1,501–$3,000', _rsm(model,'rs_arr_3'));
  } else if(arrAmt <= 5000) {
    addPts('rs_arr_4', 'Arrears $3,001–$5,000', _rsm(model,'rs_arr_4'));
  } else {
    addPts('rs_arr_5', 'Arrears $5,001+', _rsm(model,'rs_arr_5'));
  }

  // Payment arrangement bonus — offsets arrears penalty (only if there are arrears)
  if(arrAmt > 0 && payMonths > 0) {
    var payId, payLabel;
    if(payMonths <= 12)       { payId='rs_pay_1'; payLabel='Payment plan 0–12mo'; }
    else if(payMonths <= 36)  { payId='rs_pay_2'; payLabel='Payment plan 13–36mo'; }
    else if(payMonths <= 60)  { payId='rs_pay_3'; payLabel='Payment plan 37–60mo'; }
    else if(payMonths <= 120) { payId='rs_pay_4'; payLabel='Payment plan 61–120mo'; }
    else if(payMonths <= 180) { payId='rs_pay_5'; payLabel='Payment plan 121–180mo'; }
    else                      { payId='rs_pay_6'; payLabel='Payment plan 181mo+'; }
    addPts(payId, payLabel, _rsm(model, payId));
  }

  // Occupancy
  if(status === 'condemned')      addPts('rs_occ_condemned', 'Condemned',        _rsm(model,'rs_occ_condemned'));
  else if(u.under_renovation)    addPts('rs_occ_displaced', 'Tenant displaced',  _rsm(model,'rs_occ_displaced'));
  else if(status === 'vacant')    addPts('rs_occ_vacant',    'Vacant',            _rsm(model,'rs_occ_vacant'));

  return { score:score, breakdown:breakdown };
}

function ctAddPerson() {
  // Flush any current DOM input values into _ctPeople first, then append blank row.
  ctGetPeople(); // side-effect: syncs DOM → _ctPeople
  var people = (window._ctPeople || []).slice();
  people.push({name:'', phone:'', email:''});
  ctRenderPeople(people);
  // Focus the name field of the new row
  var inputs = document.querySelectorAll('.ct-person-name');
  if(inputs.length) inputs[inputs.length-1].focus();
}
function ctRemovePerson(idx) {
  ctGetPeople(); // flush current values first
  var people = (window._ctPeople || []).slice();
  people.splice(idx, 1);
  ctRenderPeople(people);
}


function exportRenos(format) {
  var units=getAllUnits();
  // Condemned units are only exported when they have a request on file
  // (matches _getAllRenoUnits / renderRenosView).
  var rows=units.filter(function(u){
    if(u.status==='condemned') return !!getSowData(u.id);
    return !!u.under_renovation;
  });
  var headers=['Address','Beds','Type','Foundation','Status','Priority Score','Contractor','Maintenance Request Filed','Progress %'];
  var data=rows.map(function(u){
    var rs=calcRenoScore(u.id);
    var sow=null;sow = getSowData(u.id);
    var prog=null;prog = (window._renoProgress && window._renoProgress[u.id]) || {};
    return[u.num+' '+u.street,u.bedrooms,(u.type&&u.type!=='0'&&u.type!=='nan')?u.type:'',(u.foundation&&u.foundation!=='0'&&u.foundation!=='nan')?u.foundation:'',u.status,rs.score||0,(prog.contractor||sow&&sow.contractor||''),(sow?'Yes':'No'),(prog.overallPct||0)+'%'];
  });
  var _ns4=nationShort();
  _doExport(format,headers,data,_ns4+'_Renovations_'+new Date().toISOString().slice(0,10),[30,8,16,14,14,14,22,10,12],true);
}

function getSowData(unitId){
  // Backwards compat: callers that predate multi-SOW expect a flat SOW object.
  // We return the most recent SOW from the list so "does this unit have a SOW?" and
  // "show summary of its SOW" both keep working.
  // For multi-SOW-aware code, use getUnitSowList() / getSowByProjectNumber() directly.
  var raw = (window._sowCache && window._sowCache[unitId]) || null;
  if(!raw) return null;
  if(Array.isArray(raw.sows)){
    if(!raw.sows.length) return null;
    // Most recent first (same sort as the table).
    var sorted = raw.sows.slice().sort(function(a, b){
      return (b.created_at || '').localeCompare(a.created_at || '');
    });
    return sorted[0];
  }
  return raw;  // legacy flat shape
}

function getUnitSowList(unitId){
  // Returns an array of SOW objects for this unit (migrated if needed).
  // Must read the RAW cache entry (the wrapper {sows:[...]} or legacy flat shape) —
  // NOT getSowData() which already unwraps to the single most-recent SOW.
  var raw = (window._sowCache && window._sowCache[unitId]) || null;
  var migrated = _migrateLegacySow(raw);
  return migrated.sows || [];
}

function isSowCompleted(sow){
  if(!sow) return false;
  return sow.approval_status === 'completed';
}

function saveBudgetData(data){
  if(!window._appSettings) window._appSettings={};
  var prev = window._appSettings['budget_pools'];
  window._appSettings['budget_pools']=data;
  saveSettingWithDraftFallback('budget_pools', data).then(function(ok){
    if(!ok){
      // Roll back in-memory so UI reflects reality
      if(prev === undefined) delete window._appSettings['budget_pools'];
      else window._appSettings['budget_pools'] = prev;
      showToast('Could not save budget — changes NOT persisted. Please retry.', {type:'error'});
    }
  });
}

// Network writer for one unit's SOW row. Resolves true/false (same contract as
// sbSaveUnit) so the save-queue's _rejectIfFalse adapter can normalize HTTP
// errors into retryable failures. updated_at is stamped at SEND time (not
// enqueue time) so a queued retry carries a fresh timestamp.
//
// STALE-REPLAY GUARD: one housing_sow row holds a unit's ENTIRE Maintenance
// Request list, so a queued save replayed days later (field device that never
// got signal back) would silently erase every change other staff made to that
// unit in between. Each payload carries the moment it was captured
// (_snapshotAt, stamped by saveSowData); before writing we read the server
// row's updated_at — if the server changed AFTER our snapshot, the write is
// DROPPED with a persistent warning instead of clobbering. Returning true in
// that case is deliberate: the queue entry must clear (a retry can never
// succeed — the payload is permanently stale).
function sbSaveSowRow(entity){
  var _doWrite = function(){
    return fetch(SUPABASE_URL+'/rest/v1/housing_sow', {
      method: 'POST',
      headers: Object.assign({}, HOUSING_HEADERS, {'Prefer':'resolution=merge-duplicates,return=minimal'}),
      body: JSON.stringify({ unit_id: entity.unit_id, data: entity.data, updated_at: new Date().toISOString() })
    }).then(function(r){
      if(!r.ok) console.warn('SOW save failed: HTTP '+r.status);
      return r.ok;
    });
  };
  if(!entity._snapshotAt) return _doWrite();   // legacy queue entries: old behavior
  return fetch(SUPABASE_URL+'/rest/v1/housing_sow?unit_id=eq.'+encodeURIComponent(entity.unit_id)+'&select=updated_at',
    { headers: HOUSING_HEADERS })
    .then(function(r){ return r.ok ? r.json() : null; })
    .catch(function(){ return null; })
    .then(function(rows){
      // Can't check (offline / error) → write path decides via normal retry.
      if(rows === null) return _doWrite();
      var serverTs = rows && rows[0] && rows[0].updated_at;
      if(serverTs && new Date(serverTs).getTime() > new Date(entity._snapshotAt).getTime()){
        console.warn('[SOW] stale queued save for unit '+entity.unit_id+' dropped — server row changed after this snapshot ('+entity._snapshotAt+').');
        if(typeof showToast === 'function') showToast(
          'A Maintenance Request save for unit '+entity.unit_id+' was NOT applied — the unit was updated by someone else after your copy was made. Open the unit\'s requests, check them, and re-apply your change.',
          {type:'error'});
        if(typeof auditEntry === 'function') auditEntry('SOW:'+entity.unit_id, 'sow_save_conflict',
          'Queued Maintenance Request save dropped — server row newer than the queued snapshot', window.currentRole || 'staff');
        // Pull the fresh server copy into the local cache so the screen
        // stops showing the stale list.
        fetch(SUPABASE_URL+'/rest/v1/housing_sow?unit_id=eq.'+encodeURIComponent(entity.unit_id)+'&select=data',
          { headers: HOUSING_HEADERS })
          .then(function(r){ return r.ok ? r.json() : null; })
          .then(function(fr){
            if(fr && fr[0] && window._sowCache) window._sowCache[entity.unit_id] = fr[0].data;
            // Refresh the surfaces still showing the stale list the toast
            // just warned about.
            try {
              if(typeof udpRenderSowTable === 'function' && document.getElementById('udp_sow_table_wrap')) udpRenderSowTable(entity.unit_id);
              if(typeof renderWorklist === 'function' && document.getElementById('worklist_body')) renderWorklist();
              if(typeof renderRenoApprovalsView === 'function' && document.getElementById('ra_tbody')) renderRenoApprovalsView();
            } catch(e){}
          })
          .catch(function(){});
        return true;   // clear the queue entry — this payload must never retry
      }
      return _doWrite();
    });
}

function saveSowData(unitId, data){
  // Update in-memory cache (writes the RAW wrapper — callers should pass {sows:[...]}).
  if(!window._sowCache) window._sowCache = {};
  window._sowCache[unitId] = data;
  // Persist through the offline save-queue (Phase O: a Maintenance Request
  // written up in the field on a dead/slow connection must not vanish). The
  // row is a merge-duplicates upsert keyed by unit_id, so queued retries are
  // idempotent and last-write-wins — same semantics as the direct POST this
  // replaced. Falls back to the raw writer if the queue layer isn't loaded.
  // _snapshotAt records WHEN this copy of the unit's request list was
  // captured — the stale-replay guard in sbSaveSowRow compares it against the
  // server row so a delayed queue flush can't clobber newer changes.
  var payload = { unit_id: unitId, data: data, _snapshotAt: new Date().toISOString() };
  if(typeof saveWithDraftFallback === 'function'){
    return saveWithDraftFallback('sow', unitId, payload);
  }
  return sbSaveSowRow(payload)
    .catch(function(e){ console.warn('SOW save failed:', e); return false; });
}

function saveSowList(unitId, sowList){
  // Persist the whole list to the housing_sow.data column.
  saveSowData(unitId, { sows: sowList });
}

async function saveStaffEdit(id, original, modal) {
  var name = (document.getElementById('edit_staff_name')||{}).value || '';
  var hrole = (document.getElementById('edit_staff_role')||{}).value || 'housing_employee_l1';
  var saveBtn = document.getElementById('editStaffSave');
  if(saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }

  // Store canonical CLFN_PERMS role value directly (Phase A0 migrated DB to canonical).
  var patch = { name: name.trim(), role: hrole };
  patch.department = ROLE_FORCED_DEPT[hrole] || original.department || 'Housing';

  try {
    var r = await fetch(SUPABASE_URL+'/rest/v1/staff?id=eq.'+id, {
      method: 'PATCH',
      headers: Object.assign({}, HOUSING_HEADERS, { 'Prefer': 'return=minimal' }),
      body: JSON.stringify(patch)
    });
    if(r.ok) {
      // Feature access: subset of registry => restrict to it; all (or none)
      // ticked => null (no restriction). Sent as a SEPARATE best-effort PATCH so
      // that, before the staff.feature_access migration is applied, the name/role
      // save above still succeeds (this one just no-ops).
      try {
        var featEls = document.querySelectorAll('#edit_staff_features .ef-feat');
        var checked = [], total = 0;
        featEls.forEach(function(cb){ total++; if(cb.checked) checked.push(cb.value); });
        var featureAccess = (checked.length && checked.length < total) ? checked : null;
        var fr = await fetch(SUPABASE_URL+'/rest/v1/staff?id=eq.'+id, {
          method: 'PATCH',
          headers: Object.assign({}, HOUSING_HEADERS, { 'Prefer': 'return=minimal' }),
          body: JSON.stringify({ feature_access: featureAccess })
        });
        if(!fr.ok) console.warn('[feature-access] save skipped — run the staff.feature_access migration', fr.status);
        else auditEntry('SETTINGS', 'settings_user_features', 'Feature access for '+name+': '+(featureAccess?featureAccess.join(', '):'full access'), window.currentRole||'ed');
      } catch(e){ console.warn('[feature-access] save error', e); }
      // Access expiry — separate best-effort PATCH so it can't block the
      // feature/role save if the access_expires_at column isn't migrated yet.
      try {
        var expEl2 = document.getElementById('edit_staff_expires');
        var expVal = (expEl2 && expEl2.value) ? expEl2.value : null;
        var er = await fetch(SUPABASE_URL+'/rest/v1/staff?id=eq.'+id, {
          method: 'PATCH',
          headers: Object.assign({}, HOUSING_HEADERS, { 'Prefer': 'return=minimal' }),
          body: JSON.stringify({ access_expires_at: expVal })
        });
        if(!er.ok) console.warn('[access-expiry] save skipped — run the staff.access_expires_at migration', er.status);
        else auditEntry('SETTINGS', 'settings_user_expiry', 'Access expiry for '+name+': '+(expVal||'none'), window.currentRole||'ed');
      } catch(e){ console.warn('[access-expiry] save error', e); }
      // Magic-link eligibility — separate best-effort PATCH (new column).
      try {
        var magicEl = document.getElementById('edit_staff_magic');
        var magicVal = !!(magicEl && magicEl.checked);
        var mr = await fetch(SUPABASE_URL+'/rest/v1/staff?id=eq.'+id, {
          method: 'PATCH',
          headers: Object.assign({}, HOUSING_HEADERS, { 'Prefer': 'return=minimal' }),
          body: JSON.stringify({ magic_link: magicVal })
        });
        if(!mr.ok) console.warn('[magic-link] save skipped — run the staff.magic_link migration', mr.status);
        else auditEntry('SETTINGS', 'settings_user_magic_link', 'Magic-link sign-in for '+name+': '+(magicVal?'enabled':'disabled'), window.currentRole||'ed');
      } catch(e){ console.warn('[magic-link] save error', e); }
      modal.remove();
      showToast('✓ Staff member updated', {type:'info'});
      auditEntry('SETTINGS', 'settings_user_edit', 'Staff updated: '+name+' — role set to '+hrole, window.currentRole||'ed');
      renderHousingUserTable();
    } else {
      showToast('Could not save — check permissions', {type:'error'});
      if(saveBtn){ saveBtn.disabled=false; saveBtn.textContent='Save Changes'; }
    }
  } catch(e) {
    showToast('Error: '+e.message, {type:'error'});
    if(saveBtn){ saveBtn.disabled=false; saveBtn.textContent='Save Changes'; }
  }
}

function setSigMethod(canvasId, method) {
  var methods = ['canvas', 'type', 'wet'];
  methods.forEach(function(m) {
    var panel = document.getElementById(canvasId + '_panel_' + m);
    var tab   = document.getElementById(canvasId + '_tab_' + m);
    if(panel) panel.style.display = (m === method) ? 'block' : 'none';
    if(tab) {
      tab.style.borderBottomColor = (m === method) ? 'var(--yellow)' : 'transparent';
      tab.style.color = (m === method) ? 'var(--text)' : 'var(--muted)';
      tab.style.fontWeight = (m === method) ? '700' : '600';
    }
  });
  // Init canvas pad when switching to draw mode
  if(method === 'canvas') _initSigPad(canvasId);
}

function clearSig(canvasId) {
  var canvas = document.getElementById(canvasId);
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  canvas.classList.remove('has-sig');
}


function getSigDataURL(canvasId) {
  // Read the *computed* display so panels hidden via the .sec-hidden class
  // (no inline style) are correctly treated as not visible. Reading
  // panel.style.display alone returns '' on first render and falsely
  // reports the panel as visible — which made canvas drawings get dropped.
  function _visible(el) {
    if (!el) return false;
    var d = getComputedStyle(el).display;
    return d && d !== 'none';
  }
  var typePanel = document.getElementById(canvasId + '_panel_type');
  if (_visible(typePanel)) {
    var typed = document.getElementById(canvasId + '_typed');
    return (typed && typed.value.trim()) ? 'typed:' + typed.value.trim() : '';
  }
  var wetPanel = document.getElementById(canvasId + '_panel_wet');
  if (_visible(wetPanel)) {
    var ref = document.getElementById(canvasId + '_wet_ref');
    return (ref && ref.value.trim()) ? 'wet:' + ref.value.trim() : 'wet:pending';
  }
  // Canvas draw mode — capture only if at least one pixel was drawn
  var canvas = document.getElementById(canvasId);
  if (!canvas) return '';
  var ctx = canvas.getContext('2d');
  var data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  for (var i = 3; i < data.length; i += 4) {
    if (data[i] > 0) return canvas.toDataURL('image/png');
  }
  return '';
}


function udpRenderFilePreviews(unitId){
  var mount = document.getElementById('udp_files_mount');
  if (!mount) return;
  // Rebuild the library on each panel open so it targets the right tenant
  mount.innerHTML = '';
  if (!window.DocLibrary) {
    mount.innerHTML = '<div style="padding:12px;text-align:center;color:var(--muted);font-size:11px;">Document library unavailable.</div>';
    return;
  }
  _udpFilesLib = window.DocLibrary.create(mount, {
    entityType:    'tenant',
    entityId:      unitId,
    pathPrefix:    'tenants/' + unitId,
    supabaseUrl:   SUPABASE_URL,
    supabaseAnon:  SUPABASE_ANON,
    storageBucket: STORAGE_BUCKET,
    getAuthToken:  function(){ return (window.HOUSING_HEADERS && window.HOUSING_HEADERS['Authorization'] || '').replace('Bearer ',''); },
    auditTable:    'housing_audit_log',
    getActor:      function(){ return (window.HOUSING_SESSION && window.HOUSING_SESSION.email) || window.currentRole || 'staff'; },
    categories:    _HOUSING_TENANT_DOC_CATEGORIES
  });
}

async function udpRenderRfqSection(unitId) {
  // RFQ module gate — hide the whole "RFQs & Contracts" section when off.
  var rfqSection = document.getElementById('udp_rfq_section');
  if (typeof moduleOn === 'function' && !moduleOn('rfq')) {
    if (rfqSection) rfqSection.style.display = 'none';
    return;
  }
  if (rfqSection) rfqSection.style.display = '';
  var el = document.getElementById('udp_rfq_list');
  if (!el) return;
  el.innerHTML = '<div style="font-size:11px;color:var(--muted);padding:6px 0;">Loading&hellip;</div>';
  try {
    var url = SUPABASE_URL + '/rest/v1/housing_rfq?sow_unit_id=eq.' + encodeURIComponent(unitId)
            + '&select=id,status,award_amount,awarded_contractor_id,data&order=created_at.desc';
    var r = await fetch(url, { headers: HOUSING_HEADERS });
    if (!r.ok) { el.innerHTML = '<div style="font-size:11px;color:var(--muted);font-style:italic;">Could not load RFQs.</div>'; return; }
    var rfqs = await r.json();
    if (!rfqs.length) {
      el.innerHTML = '<div style="font-size:11px;color:var(--muted);font-style:italic;">No RFQs for this unit.</div>';
      return;
    }
    var statusLabel = { draft:'Draft', issued:'Issued', awarded:'Awarded', cancelled:'Cancelled' };
    var statusColor = { draft:'var(--muted)', issued:'var(--info-blue,#1d4ed8)', awarded:'var(--success,#15803d)', cancelled:'var(--danger,#dc2626)' };
    el.innerHTML = rfqs.map(function(rfq) {
      var d = rfq.data || {};
      var ct = rfq.awarded_contractor_id ? (window._contractors || []).find(function(c){ return c && c.id === rfq.awarded_contractor_id; }) : null;
      var ctName = ct ? ct.name : '';
      var contractNo = d.contract_number || '';
      var amount = rfq.award_amount ? '$' + Number(rfq.award_amount).toLocaleString('en-CA', {minimumFractionDigits:2}) : '';
      var label = statusLabel[rfq.status] || rfq.status;
      var color = statusColor[rfq.status] || 'var(--muted)';
      return '<div onclick="window.location.href=\'rfq.html?rfq=' + escapeHtml(rfq.id) + '\'" '
           + 'style="display:flex;align-items:center;justify-content:space-between;padding:9px 11px;background:var(--bg);border-radius:7px;margin-bottom:6px;cursor:pointer;border:1px solid var(--border);" '
           + 'onmouseover="this.style.borderColor=\'var(--yellow)\'" onmouseout="this.style.borderColor=\'var(--border)\'">'
           + '<div>'
           +   '<div style="font-size:12px;font-weight:600;color:var(--text);">' + escapeHtml(rfq.id) + (contractNo ? ' &mdash; ' + escapeHtml(contractNo) : '') + '</div>'
           +   (ctName || amount ? '<div style="font-size:11px;color:var(--muted);margin-top:2px;">' + escapeHtml(ctName) + (ctName && amount ? ' &middot; ' : '') + escapeHtml(amount) + '</div>' : '')
           + '</div>'
           + '<span style="font-size:10px;font-weight:700;color:' + color + ';text-transform:uppercase;letter-spacing:.4px;">' + escapeHtml(label) + '</span>'
           + '</div>';
    }).join('');
  } catch(e) {
    console.warn('[udp rfq]', e);
    el.innerHTML = '<div style="font-size:11px;color:var(--muted);font-style:italic;">Could not load RFQs.</div>';
  }
}

function updateUnitScorePts(id,val){
  var model=getUnitScoreModel();
  var row=model.find(function(r){return r.id===id;});
  if(row)row.pts=parseInt(val)||0;
  if(!window._appSettings) window._appSettings={};
  window._appSettings['unit_score_model']=model;
  // Fire-and-forget — this runs on every keystroke so we only log, not toast
  saveSettingWithDraftFallback('unit_score_model', model);
  var maxScore=0;
  ['bed','acc','eld'].forEach(function(g){
    var mx=Math.max.apply(null,model.filter(function(r){return r.group===g;}).map(function(r){return r.pts;}));
    if(mx>0)maxScore+=mx;
  });
  var maxEl=document.getElementById('unit_score_max');
  if(maxEl)maxEl.textContent=String(maxScore);
}

// Inject the print-panel DOM on first use so every page gets it for free —
// avoids duplicating the markup in housing/inventory/match/tenants/etc.
function _ensurePrintPanel() {
  if (document.getElementById('printPanel')) return;
  var panel = document.createElement('div');
  panel.id = 'printPanel';
  panel.className = 'print-panel';
  panel.innerHTML =
      '<div class="modal-hdr sticky">'
    +   '<span id="printPanelTitle" class="print-panel-title">Document Preview</span>'
    +   '<div class="print-panel-actions">'
    +     '<button onclick="triggerPrint()" class="btn btn-primary btn-sm">🖨 Print</button>'
    +     '<button onclick="closePrintPanel()" class="btn btn-ghost-dark btn-sm">✕ Close</button>'
    +   '</div>'
    + '</div>'
    + '<div id="printPanelBody"></div>';
  document.body.appendChild(panel);
}

function showPrintPanel(docHtml, title) {
  try {
  _ensurePrintPanel();
  _printPanelDoc = docHtml;
  var panel  = document.getElementById('printPanel');
  var body   = document.getElementById('printPanelBody');
  var ptitle = document.getElementById('printPanelTitle');
  if(!panel || !body) return;
  if(ptitle) ptitle.textContent = title || 'Document Preview';

  // Extract <body> content from the doc string
  var bOpen  = docHtml.indexOf('<body');
  var bClose = docHtml.indexOf('</body>');
  var content = (bOpen >= 0 && bClose >= 0)
    ? docHtml.substring(docHtml.indexOf('>', bOpen) + 1, bClose)
    : docHtml;

  // Remove any fixed footer or page-num divs (simple string split)
  var parts = content.split('<div class="footer"');
  if(parts.length > 1) {
    content = parts[0] + parts.slice(1).map(function(p) {
      var close = p.indexOf('</div>');
      return close >= 0 ? p.substring(close + 6) : '';
    }).join('');
  }

  // Extract <style> and sanitise @page rules
  var sOpen  = docHtml.indexOf('<style');
  var sClose = docHtml.indexOf('</style>');
  var inlineStyle = '';
  if(sOpen >= 0 && sClose >= 0) {
    var css = docHtml.substring(docHtml.indexOf('>', sOpen) + 1, sClose);
    // Remove @page blocks
    while(css.indexOf('@page') >= 0) {
      var ps = css.indexOf('@page');
      var pb = css.indexOf('{', ps);
      var pe = css.indexOf('}', pb);
      css = css.substring(0, ps) + css.substring(pe + 1);
    }
    // Scope body rules to panel
    css = css.replace(/body\s*\{/g, '#printPanelBody {');
    inlineStyle = '<style>' + css + '</style>';
  }

  body.innerHTML = inlineStyle
    + '<div class="print-panel-doc">'
    + content
    + '</div>';

  panel.classList.add('is-open');
  panel.scrollTop = 0;
  document.body.style.overflow = 'hidden';
  } catch(err) { console.error('showPrintPanel error:', err); }
}

function showMatch(){
  if(window.CLFN_MODULES && !window.CLFN_MODULES.isEnabled('match')){
    showToast('Match module is not enabled for this nation.', {type:'error'});
    return;
  }
  // Match lives in match.html. Element-based check (see showInventory).
  if(document.getElementById('matchView')) {
    if(!window._navSkipPush) pushNav('match');
    setExportView('match');
    setNavActive('tab_match');
    window._matchActiveChip = '';
    _showView('matchView', renderMatchView);
  } else {
    window.location.href = 'match.html';
  }
}

// ── rpContractorSearch — used by renoProgressModal to assign contractor ────────
// Lives here (shared) so both renos.html and contractors.html can call it.
function rpContractorSearch(q) {
  var dd = document.getElementById('rp_ct_dropdown');
  if(!dd) return;
  var contractors = window._contractors || [];
  var term = (q||'').toLowerCase().trim();
  var matches = term
    ? contractors.filter(function(c){ return (c.name||'').toLowerCase().includes(term) || (c.trade||'').toLowerCase().includes(term); })
    : contractors;

  // Escaped for the same reasons as sowContractorSearch (attribute breakage +
  // stored XSS via contractor name/trade, reflected q).
  var rows = matches.map(function(c) {
    return '<div data-ct-name="'+escapeHtml(c.name)+'" data-ct-id="'+escapeHtml(c.id||'')+'" style="padding:9px 14px;cursor:pointer;font-size:13px;border-bottom:1px solid var(--border);" '
      +'onmousedown="rpSelectContractor(this)" '
      +'onmouseover="this.style.background=\'var(--bg)\'" onmouseout="this.style.background=\'\'">'
      +'<div style="font-weight:600;">'+escapeHtml(c.name)+'</div>'
      +(c.trade?'<div style="font-size:11px;color:var(--muted);">'+escapeHtml(c.trade)+'</div>':'')
      +'</div>';
  });

  // Always show "Add new contractor" option
  rows.push('<div onmousedown="rpAddNewContractor()" style="padding:9px 14px;cursor:pointer;font-size:12px;font-weight:700;color:var(--yellow);border-top:1px solid var(--border);display:flex;align-items:center;gap:6px;" '
    +'onmouseover="this.style.background=\'var(--bg)\'" onmouseout="this.style.background=\'\'">'
    +'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>'
    +(term && !matches.length ? 'Add "'+escapeHtml(q)+'" as new contractor' : 'Add new contractor')
    +'</div>');

  dd.innerHTML = rows.join('');
  dd.style.display = 'block';
}


function showContractors(){
  if(window.CLFN_MODULES && !window.CLFN_MODULES.isEnabled('contractors')){
    showToast('Contractors module is not enabled for this nation.', {type:'error'});
    return;
  }
  // contractorsView markup lives in contractors.html
  window.location.href = 'contractors.html';
}

function showRenos(){
  if(window.CLFN_MODULES && !window.CLFN_MODULES.isEnabled('renovations')){
    showToast('Renovations module is not enabled for this nation.', {type:'error'});
    return;
  }
  // The renoApprovalsView/renosView markup lives in renos.html —
  // always navigate cross-page so the correct page loads with its own init.
  var role = window.currentRole || 'housing_employee_l1';
  if(ROLE.isManagement(role)) {
    window.location.href = 'renos.html?view=approvals';
  } else {
    window.location.href = 'renos.html?view=renovations';
  }
}

function _getAllRenoUnits() {
  var units = getAllUnits().slice();
  return units.filter(function(u) {
    if(u.archived) return false;
    var hasSow = !!getSowData(u.id);
    // Condemned is a terminal classification, not a renovation state — a
    // condemned unit only appears here if it actually has a request on file.
    if(u.status==='condemned') return hasSow;
    return hasSow || u.under_renovation;
  });
}

function showScorecard(app){
  if(!app)return;
  // Commercial (business/department) applications are NOT scored/waitlisted and
  // have their own review modal — never show them the residential scorecard.
  if(app.appType === 'commercial'){
    if(typeof window.openCommercialApp === 'function'){ window.openCommercialApp(app.id); return; }
    if(typeof showToast === 'function') showToast('Commercial application viewer is not available on this page.', {type:'error'});
    return;
  }
  window._currentScorecardApp=app;
  hideAllViews('scorecardView');
  var _scv=document.getElementById('scorecardView');if(!_scv)return;
  _scv.style.display='flex';
  setNavActive('tab_dash');
  setText('sc_back_name',((app.fn||'')+' '+(app.ln||'')).trim());
  setText('sc_back_id',app.id+' · '+(app.appDate||''));
  var s=app.score||0;
  // Use V2 tier thresholds (ED-adjustable, stored in liveV2Tiers) for both color and tier label
  var _t = (typeof liveV2Tiers === 'object' && liveV2Tiers) ? liveV2Tiers : {critical:80, high:60, medium:40};
  var tc = s >= _t.critical ? {bg:'var(--success-bg)',c:'var(--success)',bar:'var(--success)'}
         : s >= _t.high     ? {bg:'#e8eef5',c:'#1e3a5f',bar:'#3b82f6'}
         : s >= _t.medium   ? {bg:'#fef9ec',c:'#7a6000',bar:'var(--warn-amber-text)'}
         :                    {bg:'var(--danger-bg)',c:'var(--danger)',bar:'var(--danger)'};
  setText('sc_score_total',s);
  var tierEl=document.getElementById('sc_score_tier');if(tierEl){tierEl.textContent=app.tier||'—';tierEl.style.background=tc.bg;tierEl.style.color=tc.c;}
  // Bar: scale against the critical threshold so Low/Med/High/Critical labels align visually with tier boundaries
  // Max is 100 (sum of all positive V2 criteria); but pegging at critical keeps the bar meaningful
  var barMax = Math.max(100, (_t.critical||80) * 1.25);
  var barEl=document.getElementById('sc_score_bar');if(barEl){barEl.style.width=Math.min(100,Math.max(0,Math.round((s/barMax)*100)))+'%';barEl.style.background=tc.bar;}
  var infoEl=document.getElementById('sc_info_strip');
  if(infoEl){
    var fields=[['Reserve Status',app.reserve||'—'],['Classification',(app.classification||'—').replace(' Housing','')],['App Type',app.appType==='existing_tenant'?'File Update':app.appType==='transfer_request'?'Transfer Request':'New Housing'],['Arrears',app.hasArrears?'Yes':'No'],['Status',formatAppStatusLabel(app.status,{variant:'scorecard'})||((app.status||'draft').replace(/_/g,' '))]];
    infoEl.innerHTML=fields.map(function(f){return'<div><div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);margin-bottom:2px;">'+f[0]+'</div><div style="font-size:13px;font-weight:500;color:var(--text);">'+f[1]+'</div></div>';}).join('');
  }
  var bd=app.scoreBreakdown||{};
  var rubricData={
    waitlist:bd.waitlist||0,waitlist_label:(bd.waitlist||0)+' year'+((bd.waitlist||0)!==1?'s':'')+' on waitlist',
    reserve:bd.reserve||0,reserve_label:bd.reserve?'Off Reserve':'On Reserve',
    band:bd.band||0,income:bd.income||0,income_label:bd.income===2?'Employment/Self-Employed':bd.income===1?'Pension':'Social/Other',
    relation:bd.relation||0,relation_label:bd.relation===3?'Divorced / Separated':app.marital||'—',
    ages:bd.ages||0,age_people:[],access:bd.access||0,access_label:bd.access?'Has accessibility needs':'None',
    moveIn:bd.moveIn||0,movein_label:bd.moveIn===3?'Within 1 year':bd.moveIn===2?'1–3 years':bd.moveIn===1?'3+ years':'No target date',
    homeCond:bd.homeCond||0,homecond_label:bd.homeCond===2?'Good':bd.homeCond===1?'Average':bd.homeCond===-2?'Poor':'No house',
    renos:bd.renos||0,renos_amt:0,arrears:bd.arrears||0,
    arrears_amt:app.arrBalAmt?parseFloat(app.arrBalAmt)||0:0,payment:bd.payment||0,payment_months:0,
  };
  // Render rubric directly into sc_rubric_rows
  var scRubricEl=document.getElementById('sc_rubric_rows');
  if(scRubricEl){
    // Seed _lastScoreResult from stored breakdown so rubric renders without re-scoring
    if(!window._lastScoreResult && app.scoreBreakdown) {
      window._lastScoreResult = { score: app.score||0, tier: app.tier||'', breakdown: app.scoreBreakdown };
    }
    // If no V2 breakdown, fall back to legacy rubric
    if(window._lastScoreResult && window._lastScoreResult.breakdown && window._lastScoreResult.breakdown.sectionA) {
      renderRubricTableV2(window._lastScoreResult.breakdown, scRubricEl);
    } else {
      renderRubricTable(rubricData, scRubricEl);
    }
  }
  var edAdj=bd.edAdjustment||app.edAdjustment||0;
  var edReason=bd.edAdjustReason||app.edAdjustReason||'';
  var edSec=document.getElementById('sc_ed_section');var edCon=document.getElementById('sc_ed_content');
  if(edSec&&edCon){
    if(edAdj||(app.edNotes)){edSec.style.display='block';edCon.innerHTML=(edAdj?'<div style="font-size:13px;margin-bottom:6px;"><strong>'+(edAdj>0?'+':'')+edAdj+' pts</strong>'+(edReason?' — '+edReason:'')+'</div>':'')+(app.edNotes?'<div class="js-txt-muted">'+app.edNotes+'</div>':'');}
    else edSec.style.display='none';
  }
  _scv.scrollTop=0;
  // Load application documents from Supabase Storage
  scLoadDocs(app);
  // Wire Assign Files button
  var assignBtn = document.getElementById('sc_assign_btn');
  if(assignBtn) { assignBtn.onclick = null; assignBtn.addEventListener('click', function(){ scShowAssignDocs(app); }); }

  // Pre-fill ED panel with existing values
  var edAdjEl     = document.getElementById('sc_ed_adj_pts');
  var edReasonEl  = document.getElementById('sc_ed_adj_reason');
  var edNotesEl   = document.getElementById('sc_ed_adj_notes');
  if(edAdjEl)    edAdjEl.value    = app.edAdjustment   || (bd.edAdjustment   || 0);
  if(edReasonEl) edReasonEl.value = app.edAdjustReason || (bd.edAdjustReason || '');
  if(edNotesEl)  edNotesEl.value  = app.edNotes        || '';

  // Render role-appropriate approval action buttons
  if(typeof renderScorecardActions === 'function') renderScorecardActions(app);
}

// ── Panel helpers — used by housing.html and renos.html ─────────────────────

function openTenantFilesPanel(unitId){
  _tenantFilesUnitId = unitId;
  var allUnits = getAllUnits();
  var u = allUnits.find(function(x){ return x.id===unitId; });
  var title = document.getElementById('tfp_title');
  if(title) title.textContent = u ? u.num+' '+u.street+(u.assignedName?' — '+u.assignedName:'') : unitId;

  // Mount DocLibrary into #tfp_mount. If a prior instance exists from a
  // different tenant, clear it so the mount re-initializes cleanly.
  var mount = document.getElementById('tfp_mount');
  if (mount) {
    mount.innerHTML = '';
    if (window.DocLibrary) {
      _tenantFilesLib = window.DocLibrary.create(mount, {
        entityType:    'tenant',
        entityId:      unitId,
        pathPrefix:    'tenants/' + unitId,
        supabaseUrl:   SUPABASE_URL,
        supabaseAnon:  SUPABASE_ANON,
        storageBucket: STORAGE_BUCKET,
        getAuthToken:  function(){ return (window.HOUSING_HEADERS && window.HOUSING_HEADERS['Authorization'] || '').replace('Bearer ',''); },
        auditTable:    'housing_audit_log',
        getActor:      function(){ return (window.HOUSING_SESSION && window.HOUSING_SESSION.email) || window.currentRole || 'staff'; },
        categories:    _HOUSING_TENANT_DOC_CATEGORIES,
        // Soft-archive of tenant files (recoverable) — gated by the
        // archiveTenantFiles approval authority (Settings -> Approval Authority
        // -> Tenants). Only shows the Archive/Restore controls for permitted
        // roles; archived files are hidden from the normal list either way.
        canArchive: (window.APPROVAL_AUTHORITY &&
                     APPROVAL_AUTHORITY.can('archiveTenantFiles', window.currentRole || window._realRole)) || false,
        // When anything changes, refresh the Unit Detail Panel preview if
        // it's currently rendered for the same unit (shares data source).
        onChange: function(){
          if (typeof _currentDetailUnitId !== 'undefined' &&
              _currentDetailUnitId === unitId) {
            udpRenderFilePreviews(unitId);
          }
        }
      });
    } else {
      mount.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted);font-size:13px;">Document library unavailable (shared.js not loaded).</div>';
    }
  }

  var panel = document.getElementById('tenantFilesPanel');
  if(panel){ panel.style.setProperty('display','flex','important'); document.body.classList.add('modal-open'); }
}

function closeTenantFilesPanel(){
  var panel = document.getElementById('tenantFilesPanel');
  if(panel) panel.style.display='none';
  document.body.classList.remove('modal-open');
  _tenantFilesUnitId = null;
  _tenantFilesLib = null;
  // Refresh tenants view so file count badge updates
  if(typeof renderTenantsView === 'function') renderTenantsView();
}

function closeUnitDetail() {
  var p = document.getElementById('unitDetailPanel');
  if (p) {
    p.style.display = 'none';
    p.classList.remove('is-open');
  }
}

// ════════════════════════════════════════════════════════════════════════
// RFQ (Request for Quotes) module -- shared functions
// ════════════════════════════════════════════════════════════════════════

async function loadRfqCache() {
  window._rfqCache = {};
  try {
    var r = await fetch(SUPABASE_URL + '/rest/v1/housing_rfq?select=*&order=created_at.desc', { headers: HOUSING_HEADERS });
    if (!r.ok) { console.warn('[rfq] cache load failed:', r.status); return; }
    var rows = await r.json();
    (rows || []).forEach(function(row) { window._rfqCache[row.id] = row; });
    console.log('[rfq] loaded ' + (rows || []).length + ' RFQ(s)');
  } catch(e) { console.warn('[rfq] cache error:', e); }
}

function generateRfqNumber() {
  var year = new Date().getFullYear();
  var prefix = 'RFQ-' + year + '-';
  var maxSeq = 0;
  Object.keys(window._rfqCache || {}).forEach(function(id) {
    if (id.indexOf(prefix) === 0) {
      var seq = parseInt(id.slice(prefix.length), 10);
      if (!isNaN(seq) && seq > maxSeq) maxSeq = seq;
    }
  });
  return prefix + String(maxSeq + 1).padStart(4, '0');
}

function _sowMeetsRfqThreshold(sow) {
  var threshold = ((window._appSettings && window._appSettings.rfq_threshold) || 10000);
  // Accept .cost too so the renos.html approval table (which carries r.cost)
  // shares this single threshold rule instead of an inline copy.
  var amt = parseFloat((sow && (sow.amount || sow.totalCost || sow.total_cost || sow.cost)) || 0) || 0;
  return amt >= threshold;
}
window._sowMeetsRfqThreshold = _sowMeetsRfqThreshold;

function buildRfqDocumentHtml(rfq, sow, unit) {
  var nc       = window.NATION_CONFIG || {};
  var natDisp  = nc.display_name || nc.name || nationDisplay() || '';
  var natShort = nationShort();

  // Editable RFQ-document strings (Settings -> Contracts -> RFQ Bid Document).
  // Fallback = the current literal, so output is unchanged if the config/notify
  // layer isn't loaded. S() = single string, L() = list.
  var S = function(k, fb){ return (typeof _rfqDocStr === 'function') ? _rfqDocStr(k) : fb; };
  var L = function(k, fb){ return (typeof _rfqDocList === 'function') ? _rfqDocList(k) : fb; };
  var _sigsHidden = (typeof _docSigsHidden === 'function') && _docSigsHidden();

  // Theme — primary color drives header strip, section headers, table headers
  var theme       = (window._appSettings && window._appSettings.theme) || {};
  var primary     = theme.primary_color || '#F8E41A';
  var logoUrl     = theme.logo || '';

  // Nation contact info from Settings → Admin → Nation
  var natAddress  = nc.mailing_address ? nc.mailing_address.split('\n')[0] : '';
  var natPhone    = nc.phone    || '';
  var natEmail    = nc.email    || '';
  var natWebsite  = nc.website  || '';

  var addr     = unit ? ((unit.num || '') + ' ' + (unit.street || '')).trim() : (rfq.sow_unit_id || '--');
  var today    = new Date().toLocaleDateString('en-CA');
  var closingDisplay = rfq.closes_at ? new Date(rfq.closes_at).toLocaleString('en-CA', {dateStyle:'long', timeStyle:'short'}) : '--';
  var items    = (rfq.data && rfq.data.scope_snapshot) || (sow && sow.items) || [];
  var contact  = (rfq.data && rfq.data.contact_person) || '';
  var contactEmail = (rfq.data && rfq.data.contact_email) || '';
  var subMethod = (rfq.data && rfq.data.submission_method) || 'email';

  var termsHtml = '';
  var rawTerms = (window._appSettings && window._appSettings.rfq_terms);
  if (rawTerms && typeof _termsParseHtml === 'function') {
    var tp = _termsParseHtml(typeof rawTerms === 'string' ? rawTerms : (rawTerms.bodyHtml || ''));
    if (tp.introHtml) termsHtml += '<p style="font-size:10px;line-height:1.6;margin-bottom:8px;">' + tp.introHtml + '</p>';
    if (tp.itemsHtml.length) {
      termsHtml += '<ol style="font-size:10px;line-height:1.65;padding-left:18px;">';
      tp.itemsHtml.forEach(function(h){ termsHtml += '<li style="margin-bottom:4px;">' + h + '</li>'; });
      termsHtml += '</ol>';
    }
  }

  var visItems = items.filter(function(it){ return it && !it._hidden && (it.category || it.description); });

  var scopeRows = visItems.map(function(it, i) {
    return '<tr style="' + (i%2 ? 'background:#f9f9f9;' : '') + '">'
      + '<td style="padding:7px 10px;border-bottom:1px solid #e0e0e0;font-size:10px;">' + escapeHtml(it.category || '--') + '</td>'
      + '<td style="padding:7px 10px;border-bottom:1px solid #e0e0e0;font-size:10px;">' + escapeHtml(it.description || '--') + '</td>'
      + '</tr>';
  }).join('');

  var bidRows = visItems.map(function(it) {
    return '<tr><td style="padding:10px;border-bottom:1px solid #e0e0e0;font-size:10px;min-height:32px;">' + escapeHtml(it.description || it.category || '--') + '</td>'
      + '<td style="padding:10px;border-bottom:1px solid #e0e0e0;"></td>'
      + '<td style="padding:10px;border-bottom:1px solid #e0e0e0;"></td>'
      + '<td style="padding:10px;border-bottom:1px solid #e0e0e0;"></td></tr>';
  }).join('');

  var subInstr = subMethod === 'email'  ? 'Email your complete bid package to: <strong>' + escapeHtml(contactEmail || contact) + '</strong>'
               : subMethod === 'office' ? 'Deliver your complete bid package to the ' + escapeHtml(natShort) + ' Housing Department office.'
               : 'Submit by email to <strong>' + escapeHtml(contactEmail || contact) + '</strong> OR deliver to the ' + escapeHtml(natShort) + ' Housing Department office.';

  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>'
    + '<title>' + escapeHtml(rfq.id) + ' -- ' + escapeHtml(natShort) + ' Housing</title>'
    + '<style>*{box-sizing:border-box;margin:0;padding:0;}'
    + 'body{font-family:Georgia,serif;font-size:11px;color:#222;background:#fff;}'
    + '@page{size:letter portrait;margin:15mm 15mm 18mm 15mm;}'
    + '@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact;}}'
    + '.hdr{background:#111;color:#fff;padding:14px 20px;display:flex;align-items:flex-start;justify-content:space-between;gap:16px;}'
    + '.hdr-logo{height:44px;max-width:80px;object-fit:contain;margin-right:12px;}'
    + '.hdr-left{display:flex;align-items:flex-start;gap:10px;}'
    + '.hdr-org{font-size:13px;font-weight:bold;letter-spacing:.04em;}'
    + '.hdr-dept{font-size:10px;color:#ccc;margin-top:2px;}'
    + '.hdr-contact{font-size:9px;color:#aaa;margin-top:4px;line-height:1.6;}'
    + '.hdr-type{font-size:18px;font-weight:bold;letter-spacing:.05em;text-align:right;}'
    + '.hdr-num{font-size:10px;color:#aaa;margin-top:3px;text-align:right;}'
    + '.ybar{height:5px;}'
    + '.body{padding:20px 0 0;}'
    + '.sec{margin-bottom:18px;}'
    + '.sec-h{font-size:9px;font-weight:bold;text-transform:uppercase;letter-spacing:.08em;color:#fff;padding:5px 10px;}'
    + '.sec-b{border:1px solid #ddd;border-top:none;padding:12px 14px;}'
    + '.mgrid{display:grid;grid-template-columns:1fr 1fr;gap:8px 24px;}'
    + '.mf label{display:block;font-size:8px;font-weight:bold;text-transform:uppercase;letter-spacing:.06em;color:#888;margin-bottom:2px;}'
    + '.mf span{display:block;font-size:11px;color:#222;}'
    + 'table{width:100%;border-collapse:collapse;}'
    + 'th{padding:7px 10px;text-align:left;font-size:9px;font-weight:bold;text-transform:uppercase;}'
    + '.cl{list-style:none;padding:0;}'
    + '.cl li{padding:4px 0;font-size:10px;line-height:1.5;}'
    + '.cl li:before{content:"\\2610  ";font-size:12px;}'
    + '.sig-line{margin-top:30px;border-top:1px solid #333;padding-top:5px;font-size:9px;color:#888;}'
    + '.footer{margin-top:20px;padding-top:8px;border-top:3px solid ' + primary + ';display:flex;justify-content:space-between;font-size:8px;color:#888;}'
    + '</style></head><body>'

    // ── Header ─────────────────────────────────────────────────────────────
    + '<div class="hdr">'
    +   '<div class="hdr-left">'
    +   (logoUrl ? '<img class="hdr-logo" src="' + escapeHtml(logoUrl) + '" alt=""/>' : '')
    +   '<div>'
    +     '<div class="hdr-org" style="color:' + primary + ';">' + escapeHtml(natDisp.toUpperCase()) + '</div>'
    +     '<div class="hdr-dept">Housing Department</div>'
    +     '<div class="hdr-contact">'
    +     (natAddress ? escapeHtml(natAddress) + '<br/>' : '')
    +     (natPhone   ? escapeHtml(natPhone) : '')
    +     (natPhone && natEmail ? '  &bull;  ' : '')
    +     (natEmail   ? escapeHtml(natEmail) : '')
    +     (natWebsite ? '<br/>' + escapeHtml(natWebsite) : '')
    +     '</div>'
    +   '</div>'
    +   '</div>'
    +   '<div>'
    +     '<div class="hdr-type" style="color:' + primary + ';">REQUEST FOR QUOTES</div>'
    +     '<div class="hdr-num">' + escapeHtml(rfq.id) + '</div>'
    +   '</div>'
    + '</div>'
    + '<div class="ybar" style="background:' + primary + ';"></div>'
    + '<div class="body">'

    + (function() {
        var d = rfq.data || {};
        var issueDate = d.issue_date || today;
        var startDate = d.target_start_date ? new Date(d.target_start_date + 'T12:00:00').toLocaleDateString('en-CA', {year:'numeric',month:'long',day:'numeric'}) : '--';
        var endDate   = d.target_completion_date ? new Date(d.target_completion_date + 'T12:00:00').toLocaleDateString('en-CA', {year:'numeric',month:'long',day:'numeric'}) : '--';
        return '<div class="sec"><div class="sec-h" style="background:' + primary + ';color:#111;">Project Details</div><div class="sec-b"><div class="mgrid">'
          + '<div class="mf"><label>RFQ Number</label><span>' + escapeHtml(rfq.id) + '</span></div>'
          + '<div class="mf"><label>Issue Date</label><span>' + escapeHtml(issueDate) + '</span></div>'
          + '<div class="mf"><label>Project Address</label><span>' + escapeHtml(addr) + '</span></div>'
          + '<div class="mf"><label>Maintenance Request Reference</label><span>' + escapeHtml(rfq.sow_project_number || '--') + '</span></div>'
          + '<div class="mf"><label>Target Start Date</label><span>' + escapeHtml(startDate) + '</span></div>'
          + '<div class="mf"><label>Target Completion Date</label><span>' + escapeHtml(endDate) + '</span></div>'
          + '<div class="mf"><label>Bid Closing Date &amp; Time</label><span style="font-weight:bold;color:#b91c1c;">' + escapeHtml(closingDisplay) + '</span></div>'
          + '<div class="mf"><label>' + escapeHtml(natShort) + ' Contact</label><span>' + escapeHtml(contact) + (contactEmail ? ' &lt;' + escapeHtml(contactEmail) + '&gt;' : '') + '</span></div>'
          + '</div></div></div>';
      })()

    + '<div class="sec"><div class="sec-h" style="background:' + primary + ';color:#111;">Maintenance Request</div>'
    + '<table><thead><tr>'
    +   '<th style="width:28%;background:' + primary + ';color:#111;">Category</th>'
    +   '<th style="background:' + primary + ';color:#111;">Description of Work Required</th>'
    + '</tr></thead>'
    + '<tbody>' + (scopeRows || '<tr><td colspan="2" style="padding:10px;text-align:center;color:#888;">No line items specified.</td></tr>') + '</tbody>'
    + '</table></div>'

    // Notes / access requirements carried over from the initiating maintenance
    // request, so contractors see special instructions and site access details.
    + (function(){
        var _n = String((sow && sow.notes) || (rfq.data && rfq.data.sow_notes) || '').trim();
        if (!_n) return '';
        return '<div class="sec"><div class="sec-h" style="background:' + primary + ';color:#111;">Additional Notes &amp; Access Requirements</div>'
          + '<div class="sec-b" style="font-size:10px;line-height:1.6;white-space:pre-wrap;">' + escapeHtml(_n) + '</div></div>';
      })()

    + '<div class="sec"><div class="sec-h" style="background:' + primary + ';color:#111;">' + escapeHtml(S('h_bidform', 'Contractor Bid Form — Complete and Return')) + '</div>'
    + '<div class="sec-b">'
    + '<p style="font-size:9.5px;color:#333;margin-bottom:6px;">' + escapeHtml(S('bidform_intro', 'Price all line items below in Canadian dollars (CDN), exclusive of HST.')) + '</p>'
    + '<p style="font-size:9px;color:#666;font-style:italic;margin-bottom:10px;">' + escapeHtml(S('bidform_print_note', 'This form has been provided as a read-only document. Please print it, complete all fields by hand, sign where required, and submit the completed form with your supporting documents. You may also attach a separate quote in your own format — this form must still accompany it.')) + '</p>'
    + '<table><thead>'
    +   '<tr>'
    +     '<th style="background:' + primary + ';color:#111;">' + escapeHtml(S('col_lineitem', 'Line Item / Description')) + '</th>'
    +     '<th style="width:18%;background:' + primary + ';color:#111;">' + escapeHtml(S('col_unitprice', 'Unit Price ($)')) + '</th>'
    +     '<th style="width:18%;background:' + primary + ';color:#111;">' + escapeHtml(S('col_extended', 'Extended Price ($)')) + '</th>'
    +     '<th style="width:16%;background:' + primary + ';color:#111;">' + escapeHtml(S('col_notes', 'Notes')) + '</th>'
    +   '</tr>'
    +   '<tr style="background:#f5f5f5;">'
    +     '<td style="padding:3px 10px;"></td>'
    +     '<td style="padding:3px 10px;font-size:8px;color:#777;font-style:italic;">Price per unit of measure (e.g., per item, per hour, per metre)</td>'
    +     '<td style="padding:3px 10px;font-size:8px;color:#777;font-style:italic;">Unit Price &times; Quantity = line total</td>'
    +     '<td style="padding:3px 10px;"></td>'
    +   '</tr>'
    + '</thead>'
    + '<tbody>' + (bidRows || '<tr><td colspan="4" style="padding:10px;"></td></tr>') + '</tbody>'
    + '<tfoot><tr style="background:' + primary + ';"><td colspan="2" style="padding:8px 10px;font-size:11px;font-weight:bold;text-align:right;color:#111;">' + escapeHtml(S('total_bid_amount', 'TOTAL BID AMOUNT:')) + '</td><td style="padding:8px 10px;border:1px solid #ccc;min-width:80px;background:#fff;">&nbsp;</td><td style="background:#fff;"></td></tr></tfoot>'
    + '</table>'
    // ── Bid Cost Breakdown (blank — contractor fills in) ──────────────────
    + '<p style="font-size:9.5px;color:#333;margin:14px 0 6px;"><strong>' + escapeHtml(S('h_breakdown', 'Bid Cost Breakdown')) + '</strong> &mdash; ' + escapeHtml(S('breakdown_intro', 'break your total bid out by category (CDN, exclusive of HST). The total must equal the Total Bid Amount above.')) + '</p>'
    + '<table><thead><tr>'
    +   '<th style="background:' + primary + ';color:#111;">' + escapeHtml(S('breakdown_col_cat', 'Category')) + '</th>'
    +   '<th style="width:32%;background:' + primary + ';color:#111;">' + escapeHtml(S('breakdown_col_amt', 'Amount ($)')) + '</th>'
    + '</tr></thead><tbody>'
    +   L('breakdown_categories', ['Materials', 'Labour', 'Equipment', 'Subcontractors', 'Other']).map(function(c){
          return '<tr><td style="padding:9px 10px;border-bottom:1px solid #e0e0e0;font-size:10px;">' + escapeHtml(c) + '</td>'
            + '<td style="padding:9px 10px;border-bottom:1px solid #e0e0e0;background:#fff;"></td></tr>';
        }).join('')
    + '</tbody>'
    + '<tfoot><tr style="background:' + primary + ';"><td style="padding:8px 10px;font-size:11px;font-weight:bold;text-align:right;color:#111;">' + escapeHtml(S('breakdown_total', 'TOTAL BID:')) + '</td><td style="padding:8px 10px;border:1px solid #ccc;background:#fff;">&nbsp;</td></tr></tfoot>'
    + '</table>'
    + '<p style="font-size:10px;color:#333;margin-top:10px;">' + escapeHtml(S('labour_hours_label', 'Estimated total labour hours:')) + ' <span style="display:inline-block;border-bottom:1px solid #333;min-width:120px;">&nbsp;</span> hrs</p>'
    + '<p style="font-size:9px;color:#444;margin-top:10px;"><strong>Supporting documents:</strong> Please attach any additional documents to support your bid — shop drawings, product specifications, material substitution notices, alternative scope notes, or any other information relevant to your submission.</p>'
    + '</div></div>'

    + '<div class="sec"><div class="sec-h" style="background:' + primary + ';color:#111;">' + escapeHtml(S('h_mandatory', 'Mandatory Inclusions')) + '</div><div class="sec-b">'
    + '<div style="font-size:9.5px;color:#555;margin-bottom:8px;">' + escapeHtml(S('mandatory_intro', 'The following documents must be included with your bid. Incomplete packages will not be considered.')) + '</div>'
    + '<ul class="cl">' + L('mandatory_items', ['Current WSIB clearance certificate', 'Certificate of general liability insurance (minimum $2,000,000 per occurrence)', 'List of at least two comparable completed projects (name, owner, value, completion date)', 'Proposed project start date and estimated completion timeline', 'Fully completed bid form above with all line items priced']).map(function(it){ var sub = (typeof _rfqDocSub === 'function') ? _rfqDocSub(it) : it; return '<li>' + escapeHtml(sub) + '</li>'; }).join('') + '</ul></div></div>'

    + '<div class="sec"><div class="sec-h" style="background:' + primary + ';color:#111;">Submission Instructions</div><div class="sec-b" style="font-size:10px;line-height:1.7;">'
    + '<p>' + subInstr + '</p>'
    + '<p style="margin-top:6px;">Bids must be received by: <strong>' + escapeHtml(closingDisplay) + '</strong>. Late submissions will not be accepted under any circumstances.</p>'
    + '</div></div>'

    + (termsHtml ? '<div class="sec"><div class="sec-h" style="background:' + primary + ';color:#111;">Terms &amp; Conditions</div><div class="sec-b">' + termsHtml + '</div></div>' : '')

    + (_sigsHidden ? '' : (function() {
        var d = rfq.data || {};
        var sigData   = d.sig_data  || '';
        var sigName   = d.sig_name  || '';
        var sigTitle  = d.sig_title || '';
        var issueDate = d.issue_date || today;
        var sigHtml = '';
        if (sigData && sigData.indexOf('data:image/png;base64,') === 0) {
          sigHtml = '<img src="' + sigData + '" style="max-height:52px;max-width:220px;display:block;margin-bottom:4px;" alt="signature"/>';
        } else if (sigData && sigData.indexOf('typed:') === 0) {
          sigHtml = '<div style="font-family:Georgia,serif;font-style:italic;font-size:18px;color:#111;margin-bottom:4px;min-height:32px;">' + escapeHtml(sigData.replace('typed:','')) + '</div>';
        } else if (sigData && sigData.indexOf('wet:') === 0) {
          var ref = sigData.replace('wet:','');
          sigHtml = '<div style="font-size:9px;color:#555;margin-bottom:4px;min-height:32px;">' + escapeHtml(ref === 'pending' ? 'Wet signature on file' : 'E-sign ref: ' + ref) + '</div>';
        } else {
          sigHtml = '<div style="min-height:44px;border-bottom:1.5px solid #555;margin-bottom:4px;"></div>';
        }
        return '<div class="sec" style="page-break-inside:avoid;">'
          + '<div class="sec-h" style="background:' + primary + ';color:#111;">Authorization</div>'
          + '<div class="sec-b">'
          + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:28px;padding:10px 0 8px;">'
          // Issued By column
          + '<div>'
          +   '<div style="font-size:8.5px;font-weight:bold;text-transform:uppercase;letter-spacing:.05em;color:#888;margin-bottom:8px;">Issued by</div>'
          +   sigHtml
          +   '<div style="font-size:9px;color:#444;margin-top:2px;"><strong>Date:</strong> ' + escapeHtml(issueDate) + '</div>'
          +   '<div style="font-size:9px;color:#444;margin-top:4px;"><strong>Print name:</strong> ' + escapeHtml(sigName || '____________________________') + '</div>'
          +   '<div style="font-size:9px;color:#444;margin-top:2px;"><strong>Title:</strong> ' + escapeHtml(sigTitle || '____________________________') + '</div>'
          + '</div>';
      })()
    + '<div><div style="font-size:9px;font-weight:bold;text-transform:uppercase;color:#888;margin-bottom:4px;">On behalf of</div>'
    + '<div style="font-size:11px;font-weight:bold;margin-top:8px;">' + escapeHtml(natDisp) + '</div>'
    + '<div style="font-size:10px;color:#555;">Housing Department</div></div>'
    + '</div></div></div>')
    + '</div>'
    + '<div class="footer"><span>' + escapeHtml(natShort) + ' Housing  |  ' + escapeHtml(rfq.id) + '</span><span>Generated: ' + today + '</span></div>'
    + '</body></html>';
}

async function sendRfqToRecipients(rfq, contractorList) {
  var units   = (typeof housingUnits !== 'undefined' ? housingUnits : []);
  var unit    = units.find(function(u){ return u && u.id === rfq.sow_unit_id; }) || {};
  var addr    = ((unit.num || '') + ' ' + (unit.street || '')).trim() || rfq.sow_unit_id;
  var closing = rfq.closes_at ? new Date(rfq.closes_at).toLocaleString('en-CA') : '--';
  var rfqLink = (rfq.data && rfq.data.document_url) ? rfq.data.document_url : '(contact Housing Department for document)';
  var contact     = (rfq.data && rfq.data.contact_person) || '';
  var contactEmail = (rfq.data && rfq.data.contact_email) || '';
  var subMethod   = (rfq.data && rfq.data.submission_method) || 'email';
  var natShort    = nationShort();

  // Use the saved template from Settings > Notifications > RFQ Invitation
  var rendered = null;
  if (typeof _renderEmailTemplate === 'function') {
    rendered = _renderEmailTemplate('rfq_invite', {
      rfqNumber: rfq.id, projectAddress: addr, closingDate: closing,
      contactPerson: contact, contactEmail: contactEmail,
      submissionMethod: subMethod, rfqLink: rfqLink,
      nationShort: natShort, contractorName: '{contractorName}' // substituted per-contractor below
    });
  }

  // Resolve CC recipients from saved ccRoles (standard checkbox pattern)
  var ccRoles = [];
  if (typeof _emailEventCcRoles === 'function') ccRoles = _emailEventCcRoles('rfq_invite');
  var ccRecipients = [];
  if (ccRoles.length && typeof _resolveActiveStaffForRoles === 'function') {
    ccRecipients = await _resolveActiveStaffForRoles(ccRoles);
  }

  // Auto-generate the RFQ document as a PDF and prepend to attachments
  var attachments = [];
  try {
    if (typeof _generateRfqPdfBase64 === 'function') {
      var rfqPdfB64 = await _generateRfqPdfBase64(rfq, unit);
      if (rfqPdfB64) {
        attachments.push({ name: (rfq.id || 'RFQ') + '_' + addr.replace(/[^a-zA-Z0-9]/g,'_') + '.pdf', contentType: 'application/pdf', contentBytes: rfqPdfB64 });
      }
    }
  } catch(e) { console.warn('[rfq] RFQ PDF generation failed:', e); }

  // Fetch selected document attachments once — re-used for every contractor
  var attachedPaths = (rfq.data && rfq.data.attached_doc_paths) || [];
  var _attachSkipped = 0;
  if (attachedPaths.length && typeof sbGetFileUrl === 'function') {
    var _authHdr = (window.HOUSING_HEADERS && window.HOUSING_HEADERS['Authorization']) || '';
    for (var ai = 0; ai < attachedPaths.length; ai++) {
      try {
        var fileUrl = sbGetFileUrl(attachedPaths[ai]);
        var fResp = await fetch(fileUrl, _authHdr ? { headers: { 'Authorization': _authHdr } } : undefined);
        if (!fResp.ok) { console.warn('[rfq attach] fetch failed:', attachedPaths[ai], fResp.status); _attachSkipped++; continue; }
        var fBlob = await fResp.blob();
        if (fBlob.size > 3 * 1024 * 1024) { console.warn('[rfq attach] skipping (>3MB):', attachedPaths[ai]); _attachSkipped++; continue; }
        var b64 = await new Promise(function(resolve) {
          var reader = new FileReader();
          reader.onload  = function(e) { var d = /** @type {string} */ (e.target.result); resolve(d.substring(d.indexOf(',') + 1)); };
          reader.onerror = function()  { resolve(null); };
          reader.readAsDataURL(fBlob);
        });
        if (!b64) { _attachSkipped++; continue; }
        var dispName = attachedPaths[ai].split('/').pop().replace(/^\d+_/, '');
        attachments.push({ name: dispName, contentType: fBlob.type || 'application/octet-stream', contentBytes: b64 });
      } catch(e) { console.warn('[rfq attach] error:', attachedPaths[ai], e); _attachSkipped++; }
    }
  }
  if (_attachSkipped > 0 && typeof showToast === 'function') {
    showToast(_attachSkipped + ' selected attachment' + (_attachSkipped > 1 ? 's' : '') + ' could not be loaded and will be omitted from the email', {type:'error'});
  }

  var ok = 0, fail = 0, failNames = [];
  for (var i = 0; i < contractorList.length; i++) {
    var ct = contractorList[i];
    if (!ct || !ct.email) { fail++; failNames.push((ct && ct.name) || '(no email)'); continue; }

    // Substitute contractor name into the rendered template
    var subject  = rendered ? rendered.subject.replace(/\{contractorName\}/g, ct.name || 'Contractor')
                            : (rfq.id + ' -- ' + addr + ' -- Bids close ' + closing);
    var bodyHtml = rendered ? rendered.bodyHtml.replace(/\{contractorName\}/g, ct.name || 'Contractor')
                            : ('<p>Dear ' + escapeHtml(ct.name || 'Contractor') + ',</p><p>Please see the attached RFQ package.</p>');

    var payload = {
      to: ct.email, to_name: ct.name || '',
      subject: subject,
      bodyHtml: bodyHtml,
      event: 'rfq_invite', entity_type: 'rfq', entity_id: rfq.id
    };
    if (attachments.length) payload.attachments = attachments;
    // Add CC staff if configured
    if (ccRecipients.length) {
      payload.cc = ccRecipients.map(function(r){ return r.email; }).filter(Boolean).join(',');
    }

    try {
      await window.sendNotification(payload);
      if (typeof auditEntry === 'function') auditEntry('RFQ:' + rfq.id, 'recipient_emailed', 'Emailed to ' + ct.name + ' <' + ct.email + '>', window.currentRole || 'staff');
      ok++;
    } catch(e) {
      console.warn('[rfq] send failed:', ct.email, e);
      fail++; failNames.push(ct.name || ct.email);
    }
  }
  if (typeof showToast === 'function') {
    if (fail) showToast('Sent to ' + ok + ' of ' + (ok+fail) + ' -- failed: ' + failNames.join(', '), {type:'error'});
    else      showToast('RFQ sent to ' + ok + ' contractor' + (ok === 1 ? '' : 's'), {type:'info'});
  }
  return { ok: ok, fail: fail, failNames: failNames };
}

// Marks the SOW linked to an RFQ as approved — awarding/contracting an RFQ
// greenlights the underlying scope of work, so it should no longer sit in the
// reno-approval queue. Idempotent; safe to call more than once.
function _rfqApproveLinkedSow(unitId, projectNumber, role, contractor) {
  if (!unitId || typeof getUnitSowList !== 'function' || typeof saveSowData !== 'function') return;
  var list = getUnitSowList(unitId);
  if (!list.length) return;
  var sow = (projectNumber ? list.find(function(s){ return s && s.project_number === projectNumber; }) : null) || list[0];
  if (!sow) return;

  // Assign the AWARDED contractor as the MR's work-order assignee, so the work
  // order + its emails/PDF go to the winning contractor. Previously the RFQ award
  // approved the MR but left its "Assigned To" untouched. Done even if the MR is
  // already approved — the award is the authoritative contractor choice.
  var didAssign = false;
  if (contractor && contractor.id && sow.contractorId !== contractor.id) {
    sow.assignedTeam   = 'contractor';
    sow.contractorId   = contractor.id;
    sow.contractor     = contractor.name || sow.contractor || '';
    sow.assignedTo     = '';   // clear any prior in-house crew assignment
    sow.assignedToName = '';
    didAssign = true;
  }

  // Flag the job as RFQ-awarded regardless of how it was approved, so the "RFQ"
  // button hides once a job is awarded (via _sowRfqStillOpen) — even when a
  // person had already ED-approved it BEFORE the tender was awarded. Note:
  // approved_via_rfq alone does NOT relabel the badge "System Approved" (that
  // keys on system_approved), so an ED-approved job keeps its "ED Approved" badge.
  var didFlagRfq = !sow.approved_via_rfq;
  sow.approved_via_rfq = true;

  // System Approved: the SOW is approved BY the tendering workflow (RFQ award),
  // not by a person. Keep approval_status='ed_approved' so every existing
  // "is this approved?" check recognizes it, but flag system_approved so the UI
  // can label it "System Approved". Only for a job NOT already approved by a
  // person — an already-ED-approved job keeps its human approval + badge.
  var alreadyApproved = (sow.approval_status === 'completed' || sow.approval_status === 'ed_approved');
  if (!alreadyApproved) {
    sow.approval_status = 'ed_approved';
    sow.system_approved = true;
    sow.edName = 'System';
    sow.edDate = (new Date().toISOString().slice(0, 10));
  }

  if (didAssign || !alreadyApproved || didFlagRfq) {
    saveSowData(unitId, { sows: list });
    if (typeof auditEntry === 'function') {
      var _msg = (!alreadyApproved ? (projectNumber || '') + ' system-approved via RFQ award/contract'
                                   : (projectNumber || '') + ' updated via RFQ award')
               + (didAssign && contractor ? ' -- assigned to ' + (contractor.name || contractor.id) : '');
      auditEntry('SOW:' + unitId, 'sow_system_approval', _msg, role || window.currentRole || 'staff');
    }
  }
}

// opts.skipNotify — record the award WITHOUT emailing the winner or the other
// bidders (for tenders run manually/offline where the app is used only for
// contracting).
async function awardRfq(rfqId, contractorId, amount, notes, opts) {
  opts = opts || {};
  var rfq = (window._rfqCache || {})[rfqId];
  if (!rfq) { if (typeof showToast === 'function') showToast('RFQ not found', {type:'error'}); return false; }
  var role = window.currentRole || 'staff';
  var updates = { status: 'awarded', awarded_contractor_id: contractorId,
                  award_amount: parseFloat(amount) || 0, award_notes: notes || null,
                  updated_at: new Date().toISOString() };
  try {
    var r = await fetch(SUPABASE_URL + '/rest/v1/housing_rfq?id=eq.' + encodeURIComponent(rfqId), {
      method: 'PATCH', headers: Object.assign({}, HOUSING_HEADERS, {'Prefer':'return=minimal'}),
      body: JSON.stringify(updates)
    });
    if (!r.ok) throw new Error('PATCH failed: ' + await r.text());
    Object.assign(rfq, updates);
    var ct = (window._contractors || []).find(function(c){ return c && c.id === contractorId; });
    if (typeof auditEntry === 'function') auditEntry('RFQ:' + rfqId, 'awarded', 'Awarded to ' + ((ct && ct.name) || contractorId) + ' -- $' + (parseFloat(amount)||0).toFixed(2) + (opts.skipNotify ? ' (no notifications)' : '') + (notes ? ' -- ' + notes : ''), role);
    // Awarding an RFQ approves the linked SOW AND assigns the winning contractor
    // as its work-order assignee (ct is the awarded contractor from the cache;
    // fall back to just the id if it isn't loaded).
    _rfqApproveLinkedSow(rfq.sow_unit_id, rfq.sow_project_number, role, ct || (contractorId ? { id: contractorId } : null));
    // Resolve the unit address BEFORE the winner-email branch: the regret
    // notices below also use it, and when the winner has no email this branch
    // is skipped — addr used to stay undefined and losers' emails lost the
    // address.
    var units = (typeof housingUnits !== 'undefined' ? housingUnits : []);
    var unit  = units.find(function(u){ return u && u.id === rfq.sow_unit_id; }) || {};
    var addr  = ((unit.num || '') + ' ' + (unit.street || '')).trim() || rfq.sow_unit_id;
    // Winner notification — composed from the editable `rfq_award` template
    // (Settings -> Notifications) via notifyRfqAward. Inline send kept only as a
    // defensive fallback for pages without notifications.js loaded.
    if (!opts.skipNotify && ct && ct.email) {
      if (typeof notifyRfqAward === 'function') {
        notifyRfqAward(rfq, ct, amount, notes, addr).catch(function(e){ console.warn('[rfq] award notify failed:', e); });
      } else if (typeof window.sendNotification === 'function') {
        window.sendNotification({
          to: ct.email, to_name: ct.name || '',
          subject: rfq.id + ' -- Contract Award Notification',
          bodyHtml: '<p>Dear ' + escapeHtml(ct.name || 'Contractor') + ',</p><p>We are pleased to inform you that your bid for <strong>' + escapeHtml(rfq.id) + '</strong> (' + escapeHtml(addr) + ') has been accepted. The awarded amount is <strong>$' + (parseFloat(amount)||0).toFixed(2) + ' CDN</strong>.</p>' + (notes ? '<p>Notes: ' + escapeHtml(notes) + '</p>' : '') + '<p>The Housing Department will contact you shortly to arrange commencement. Thank you for your submission.</p>',
          event: 'rfq_award', entity_type: 'rfq', entity_id: rfqId
        }).catch(function(e){ console.warn('[rfq] award notify failed:', e); });
      }
    }
    // Regret notices to the OTHER bidders (recorded a bid, not the winner) —
    // composed from the editable `rfq_regret` template via notifyRfqRegret,
    // which serializes the sends. Inline fallback as above.
    var _bids = (rfq.data && rfq.data.bids) || {};
    var _loserIds = Object.keys(_bids).filter(function(bid){ return bid !== contractorId; });
    if (!opts.skipNotify && _loserIds.length) {
      var _losers = _loserIds.map(function(id){ return (window._contractors || []).find(function(c){ return c && c.id === id; }); }).filter(Boolean);
      if (typeof notifyRfqRegret === 'function') {
        notifyRfqRegret(rfq, _losers, addr).catch(function(e){ console.warn('[rfq] regret notify failed:', e); });
      } else if (typeof window.sendNotification === 'function') {
        (async function(){
          var natShort = (window.NATION_CONFIG && NATION_CONFIG.short) || 'Housing';
          for (var i = 0; i < _losers.length; i++) {
            var loser = _losers[i];
            if (!loser || !loser.email) continue;
            try {
              await window.sendNotification({
                to: loser.email, to_name: loser.name || '',
                subject: rfq.id + ' -- Request for Quotes Outcome',
                bodyHtml: '<p>Dear ' + escapeHtml(loser.name || 'Contractor') + ',</p>'
                  + '<p>Thank you for submitting a quote for <strong>' + escapeHtml(rfq.id) + '</strong>'
                  + (addr ? ' (' + escapeHtml(addr) + ')' : '') + '. After review, the contract has been awarded to '
                  + 'another bidder on this occasion. We appreciate your interest and encourage you to quote on future opportunities.</p>'
                  + '<p>Sincerely,<br/>' + escapeHtml(natShort) + ' Housing</p>',
                event: 'rfq_regret', entity_type: 'rfq', entity_id: rfqId
              });
            } catch(e){ console.warn('[rfq] regret notify failed:', e); }
          }
        })();
      }
    }
    if (typeof showToast === 'function') showToast('RFQ ' + rfqId + ' awarded' + (opts.skipNotify ? ' (no notifications) — Maintenance Request approved' : ' — Maintenance Request approved'), {type:'info'});
    return true;
  } catch(e) { console.warn('[rfq] award failed:', e); if (typeof showToast === 'function') showToast('Award failed -- see console', {type:'error'}); return false; }
}
window.awardRfq = awardRfq;
