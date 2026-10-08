/* ============================================================
 * finance-data.js — Finance Module Persistence Layer (Phase F3)
 *
 * Contains:
 *   - Session restore and finance access gate
 *   - In-memory store (_memStore) + boot load from Supabase
 *   - All 20 toRow/fromRow shape mappers (10 tables)
 *   - _FIN_TABLES registry, saveData(), loadData(), getData()
 *   - Audit writer (_writeAuditEntry / writeAuditEntry)
 *
 * Immediately-invoked top-level code (session restore, auth gate,
 * FINANCE_HEADERS, localStorage cleanup) still runs at load time.
 * ============================================================ */

// ═══════════════════════════════════════════════════════════════════════════
// MULTI-TENANCY, MODULE GATING, PERMISSIONS (Phase F1)
// ═══════════════════════════════════════════════════════════════════════════

// ── Finance session restore ────────────────────────────────────────────────
// HOUSING_SESSION is initialised by shared-auth.js to an empty object.
// Finance restores the token from sessionStorage (set by housing.html on
// navigation to finance). HOUSING_HEADERS is also updated so all REST
// calls carry the authenticated Bearer token.
try {
  var _raw = sessionStorage.getItem('HOUSING_SESSION');
  if (_raw) {
    var _s = JSON.parse(_raw);
    if (_s && _s.accessToken && _s.role) {
      HOUSING_SESSION.email       = _s.email || '';
      HOUSING_SESSION.name        = _s.name  || '';
      HOUSING_SESSION.role        = _s.role;
      HOUSING_SESSION.accessToken = _s.accessToken;
      HOUSING_HEADERS['Authorization'] = 'Bearer ' + _s.accessToken;
    }
  }
} catch(e) { console.warn('[finance] session restore failed:', e); }

// Finance-module access gate
var _hs = (typeof HOUSING_SESSION !== 'undefined') ? HOUSING_SESSION : null;
if (!_hs || !_hs.accessToken) {
  console.warn('[finance] No authenticated session; redirecting to login.');
  window.location.replace('index.html');
}
if (_hs && window.CLFN_PERMS && !window.CLFN_PERMS.hasFinanceAccess(_hs.role)) {
  console.warn('[finance] Role ' + _hs.role + ' has no finance access.');
  window.location.replace('housing.html');
}

// Finance-specific Supabase headers (uses authenticated token, not anon)
var FINANCE_HEADERS = {
  'apikey': SUPABASE_ANON,
  'Authorization': 'Bearer ' + (HOUSING_SESSION.accessToken || SUPABASE_ANON),
  'Content-Type': 'application/json'
};

// ═══════════════════════════════════════════════════════════════════════════
// END FINANCE MODULE BOOT
// ═══════════════════════════════════════════════════════════════════════════

if (window.CLFN_DEBUG) console.log('[CLFN FINANCE] Build: F3A-2026-04-17-deepclone — tenant persistence fix');


// ═══════════════════════════════════════════════════════════════════════════
// PERSISTENCE LAYER — Supabase-backed (Phase F3)
// ═══════════════════════════════════════════════════════════════════════════
// This layer replaced a localStorage-only implementation in Phase F3. The
// design goals (from F3 decision log):
//
//   • Zero changes to the ~125 existing saveData()/getData() call sites.
//     They remain synchronous and continue to mutate an in-memory object.
//   • Boot loads everything from Supabase into _memStore (one fetch per
//     table, in parallel). getData() continues to return _memStore by
//     reference — fully synchronous, zero latency after boot.
//   • saveData(d) diffs against the previous _memStore, identifies
//     changed/new rows per table, and fires parallel upserts to Supabase
//     as fire-and-forget. UI responds instantly; persistence is async.
//   • On write failure: red toast + console error. No retry queue for now
//     (Phase F3B will add that if operational experience demands it).
//   • Every saveData() also writes one row to finance_audit_log with actor,
//     action summary, entity type/ids. Audit is also fire-and-forget but
//     failures here are especially loud (red toast).
//   • Void pattern is NOT surfaced in the UI in this phase; deferred to
//     Phase F3B. Ledger rows the UI "deletes" today still get removed from
//     _memStore (and therefore get DELETEd at Supabase). That's a temporary
//     compromise — UI surfacing of void will arrive next session.
//
// Shape translation: the in-memory shape uses camelCase and positive-number
// charge/payment columns (legacy). The Supabase shape uses snake_case and
// a signed `amount` column. Mapper functions toRow()/fromRow() live at the
// bottom of this block.

var currentUtilityType='hydro';
var currentReversalId=null;
var currentArrId=null;

var _memStore = null;               // authoritative in-memory copy, hydrated at boot
var _bootLoadPromise = null;        // resolves when initial load completes
var _writeInFlight = 0;             // counter for pending Supabase writes (for debug)

// Replace the old random-id generator with proper UUIDs so ids match
// Supabase's uuid columns with no translation required.
function uid(){
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  // Fallback for very old browsers — RFC4122 v4-ish
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c){
    var r = Math.random()*16|0, v = c === 'x' ? r : (r&0x3|0x8);
    return v.toString(16);
  });
}

// Empty-store default shape. Every table exported by the app lives here.
function _emptyStore(){
  return {
    tenants:[], rentLedger:[], loanList:[], loanPayments:[],
    hydroLedger:[], gasLedger:[], journalEntries:[],
    arrangements:[], arrPayments:[], collections:[], auditLog:[]
  };
}

// ── Toasts ─────────────────────────────────────────────────────────────────
function _toastError(msg){
  if (typeof showToast === 'function') { showToast('⚠ ' + msg, {type: 'error', duration: 8000}); return; }
  console.error('[finance] ' + msg);
}

// ── Shape mappers ──────────────────────────────────────────────────────────
// Convert between in-memory camelCase shape and Supabase snake_case/signed-
// amount shape. Any field omitted from fromRow/toRow pairs is considered
// transient and not persisted.

var _ACTOR = function(){
  // Best-effort actor identity for audit trails + created_by columns. Reads
  // from HOUSING_SESSION populated at boot by index.html → finance.html.
  try {
    if (typeof HOUSING_SESSION !== 'undefined' && HOUSING_SESSION) {
      return HOUSING_SESSION.email || HOUSING_SESSION.name || 'unknown';
    }
  } catch(e) {}
  return 'unknown';
};

var _NATION = function(){
  try {
    if (window.NATION_CONFIG && window.NATION_CONFIG.id) return window.NATION_CONFIG.id;
  } catch(e) {}
  // Only reachable if shared-config failed entirely (every directory entry —
  // including _default — carries an id). Neutral fallback, never another
  // nation's id (OCAP): 'clfn' here would have cross-tenanted rows.
  return 'default';
};

// Rent ledger row ↔ Supabase row.
// Legacy shape uses { charge, payment } (both >= 0). Supabase stores a
// single signed amount where charges are positive and payments negative.
// entry_type values align with schema CHECK: opening_balance, rent_charge,
// payment, adjustment_credit, adjustment_debit, void.
function _rentLedgerToRow(e){
  // Journal entries live in finance_journal — skip them here to avoid
  // entry_type constraint violations on finance_rent_ledger.
  if (e.type === 'journal') return null;
  // Determine signed amount and entry_type from legacy fields.
  var amt = 0, etype = 'rent_charge';
  if (e.type === 'opening' || e.type === 'opening_balance') { amt = Number(e.charge||0); etype = 'opening_balance'; }
  else if (e.type === 'invoice') { amt = Number(e.charge||0); etype = 'rent_charge'; }
  else if (e.type === 'payment') { amt = -Number(e.payment||0); etype = 'payment'; }
  else if (e.type === 'void') {
    amt = Number(e.charge||0) > 0 ? Number(e.charge) : -Number(e.payment||0);
    etype = 'void';
  }
  else if (Number(e.charge||0) > 0) { amt = Number(e.charge); etype = 'adjustment_debit'; }
  else if (Number(e.payment||0) > 0) { amt = -Number(e.payment); etype = 'adjustment_credit'; }
  // _rawTenantId is the original DB pointer preserved when a merged duplicate
  // was canonicalized in memory (_finCanonicalizeTenantRefs). Persist it, not
  // the canonical id, so a merge never silently repoints the row (it stays
  // reversible). Canonical rows have no _rawTenantId and use tenantId as before.
  var _etid = e._rawTenantId || e.tenantId;
  var tenantId = _etid && _etid !== '' ? _etid : null;
  var entryDate = e.date || new Date().toISOString().slice(0,10);
  var row = {
    id: e.id, nation_id: _NATION(),
    tenant_id: tenantId, unit_id: e.unitId || null,
    entry_type: etype, amount: amt,
    entry_date: entryDate, description: e.desc || '',
    voids_id: e.voidsId || null, void_reason: e.voidReason || null,
    created_by: e.createdBy || _ACTOR()
  };
  // method/reference columns exist only after the optional
  // 20260820_finance_ledger_method migration — feature-detected at boot.
  // Writing them unconditionally would 400 every ledger save pre-migration.
  if (window._finLedgerHasMethod) {
    row.method    = e.method || null;
    row.reference = e.ref || null;
  }
  return row;
}
function _rentLedgerFromRow(r){
  var charge = 0, payment = 0, type = 'invoice';
  if (r.entry_type === 'opening_balance') { charge = Number(r.amount); type = 'opening'; }
  else if (r.entry_type === 'rent_charge') { charge = Number(r.amount); type = 'invoice'; }
  else if (r.entry_type === 'payment') { payment = -Number(r.amount); type = 'payment'; }
  else if (r.entry_type === 'adjustment_debit') { charge = Number(r.amount); type = 'invoice'; }
  else if (r.entry_type === 'adjustment_credit') { payment = -Number(r.amount); type = 'payment'; }
  else if (r.entry_type === 'void') {
    // Reversal row: the signed amount encodes the direction (toRow stored
    // charge as +amount, payment as -amount). The old mapper left BOTH at 0,
    // so after any reload the reversal contributed nothing to balances while
    // the voided original counted fully — every void silently un-did itself.
    if (Number(r.amount) >= 0) charge = Number(r.amount); else payment = -Number(r.amount);
    type = 'void';
  }
  return {
    id: r.id, tenantId: r.tenant_id, unitId: r.unit_id,
    date: r.entry_date, desc: r.description || '',
    charge: charge, payment: payment, type: type,
    // method/reference persist only where the optional migration added the
    // columns (see _finLedgerHasMethod) — absent columns read as undefined.
    method: r.method || '',
    // Reversal rows carry status 'void' (mirrors _makeReversalEntry); voided
    // ORIGINALS are re-marked post-load by _finDeriveVoidedOriginals from the
    // voids_id backrefs — status itself has no column.
    status: (r.entry_type === 'void' || r.voids_id) ? 'void' : 'posted',
    ref: r.reference || '',
    voidsId: r.voids_id, voidReason: r.void_reason, createdBy: r.created_by
  };
}

function _tenantToRow(t){
  return {
    id: t.id, nation_id: _NATION(),
    full_name: ((t.first||'') + ' ' + (t.last||'')).trim() || '(unnamed)',
    email: t.email || null, phone: t.phone || null,
    current_unit_id: t.currentUnitId || null,  // FK to housing_units.id (text)
    status: t.status || 'active', archived: !!t.archived,
    notes: t.notes || null,
    // Preserve the person-merge pointer on edit (finance never sets it; the
    // housing-side merge tooling / SQL does). '' -> null keeps a canonical row.
    merged_into: t.mergedInto || null,

    // Personal (added F3A)
    date_of_birth:   t.dob || null,
    band_number:     t.bandNumber || null,

    // Address (added F3A)
    street_address:  t.street || null,
    community:       t.community || null,
    province:        t.province || null,
    postal_code:     t.postalCode || null,
    mailing_address: t.mailingAddress || null,

    // Finance settings (added F3A)
    tenant_type:         t.type || null,
    contact_person:      t.contact || null,
    monthly_rent:        Number(t.rent || 0),
    invoice_preference:  t.invPref || null,
    auto_pay:            !!t.autoPay,
    auto_pay_type:       t.autoPayType || null,
    hydro_account:       t.hydroAcct || null,
    gas_account:         t.gasAcct || null,
    home_care:           !!t.homeCare,

    created_by: t.createdBy || _ACTOR(),
    updated_by: _ACTOR()
  };
}
function _tenantFromRow(r){
  var parts = (r.full_name||'').split(/\s+/);
  var first = parts.shift() || '';
  var last  = parts.join(' ');

  // Build the denormalized `unit` display string the UI expects. When we
  // have a current_unit_id we could join against housing_units, but keeping
  // the render cheap here: fall back to street_address if populated.
  var unitDisplay = r.street_address || '';

  return {
    id: r.id, first: first, last: last,

    // Personal
    dob:         r.date_of_birth || '',
    bandNumber:  r.band_number || '',

    // Address
    street:          r.street_address || '',
    community:       r.community || '',
    province:        r.province || '',
    postalCode:      r.postal_code || '',
    mailingAddress:  r.mailing_address || '',

    // Finance settings
    unit:         unitDisplay,
    type:         r.tenant_type || 'community',
    contact:      r.contact_person || '',
    rent:         Number(r.monthly_rent || 0),
    invPref:      r.invoice_preference || 'email',
    autoPay:      !!r.auto_pay,
    autoPayType:  r.auto_pay_type || null,
    hydroAcct:    r.hydro_account || '',
    gasAcct:      r.gas_account || '',
    homeCare:     !!r.home_care,

    // Contact
    email: r.email || '', phone: r.phone || '',

    // State
    notes: r.notes || '',
    status: r.status, archived: !!r.archived,
    currentUnitId: r.current_unit_id || '',
    active: (r.status || 'active') === 'active',

    // Person identity. The tenant-sync trigger inserts a new row per
    // assignment and never matches by name, so one person accumulates
    // several rows; merged_into points a duplicate at its canonical row
    // (NULL/'' = canonical). Finance surfaces skip merged-away rows so a
    // person shows once. See migration 20260624_tenants_merged_into.sql.
    mergedInto: r.merged_into || '',

    createdBy: r.created_by, updatedBy: r.updated_by
  };
}

function _loanToRow(l){
  return {
    id: l.id, nation_id: _NATION(),
    tenant_id: l._rawTenantId || l.tenantId,  // preserve DB pointer across a person-merge
    loan_number: l.ref || null,
    principal: Number(l.principal||0),
    interest_rate: Number(l.rate||0),
    term_months: Number(l.term||0),
    start_date: l.start || null,
    purpose: l.notes || null,
    status: l.status || 'draft',
    approved_by: l.approvedBy || null,
    approved_at: l.approvedAt || null,
    archived: !!l.archived,
    notes: l.notes || null,
    created_by: l.createdBy || _ACTOR(),
    updated_by: _ACTOR()
  };
}
function _loanFromRow(r){
  return {
    id: r.id, tenantId: r.tenant_id,
    type: 'renovation', rateType: Number(r.interest_rate) > 0 ? 'fixed' : 'none',
    rate: Number(r.interest_rate||0),
    principal: Number(r.principal||0),
    term: Number(r.term_months||0),
    freq: 'monthly',
    start: r.start_date || '',
    notes: r.notes || r.purpose || '',
    status: r.status,
    payment: 0, totalInterest: 0, totalRepay: 0,  // client-computed
    ref: r.loan_number || '',
    archived: !!r.archived,
    approvedBy: r.approved_by, approvedAt: r.approved_at,
    createdBy: r.created_by
  };
}

function _loanPaymentToRow(p){
  return {
    id: p.id, nation_id: _NATION(),
    loan_id: p.loanId,
    payment_date: p.date,
    principal_paid: Number(p.amount||0),  // simplified: all principal; later we'll split
    interest_paid: 0,
    method: p.method || null,
    reference: p.ref || null,
    voids_id: p.voidsId || null,
    void_reason: p.voidReason || null,
    created_by: p.createdBy || _ACTOR()
  };
}
function _loanPaymentFromRow(r){
  return {
    id: r.id, loanId: r.loan_id, tenantId: '',  // tenantId derived via loan lookup at render
    date: r.payment_date,
    amount: Number(r.principal_paid||0) + Number(r.interest_paid||0),
    method: r.method || '', notes: '',
    voidsId: r.voids_id, voidReason: r.void_reason, createdBy: r.created_by
  };
}

function _arrangementToRow(a){
  return {
    id: a.id, nation_id: _NATION(),
    tenant_id: a._rawTenantId || a.tenantId,  // preserve DB pointer across a person-merge
    total_owing: Number(a.totalOwing||0),
    payment_amount: Number(a.monthlyPayment||0),
    frequency: 'monthly',
    start_date: a.startDate || null,
    end_date: a.endDate || null,
    status: a.status || 'active',
    reason: a.notes || null,
    approved_by: a.approvedBy || null,
    approved_at: a.approvedAt || null,
    archived: !!a.archived,
    created_by: a.createdBy || _ACTOR(),
    updated_by: _ACTOR()
  };
}
function _arrangementFromRow(r){
  return {
    id: r.id, tenantId: r.tenant_id,
    ledger: 'all',
    totalOwing: Number(r.total_owing||0),
    monthlyPayment: Number(r.payment_amount||0),
    startDate: r.start_date || '', endDate: r.end_date || '',
    ref: '', notes: r.reason || '',
    status: r.status, archived: !!r.archived,
    approvedBy: r.approved_by, approvedAt: r.approved_at,
    createdBy: r.created_by
  };
}

function _arrPaymentToRow(p){
  return {
    id: p.id, nation_id: _NATION(),
    arrangement_id: p.arrId,
    invoice_id: p.invoiceId || null,
    payment_date: p.date,
    amount: Number(p.amount||0),
    method: p.method || null,
    reference: p.ref || null,
    voids_id: p.voidsId || null,
    void_reason: p.voidReason || null,
    created_by: p.createdBy || _ACTOR()
  };
}
function _arrPaymentFromRow(r){
  return {
    id: r.id, arrId: r.arrangement_id,
    invoiceId: r.invoice_id || '',
    tenantId: '',    // derived via arrangement lookup at render
    date: r.payment_date, amount: Number(r.amount||0),
    method: r.method || '', type: 'regular',
    ref: r.reference || '', notes: '',
    voidsId: r.voids_id, voidReason: r.void_reason, createdBy: r.created_by
  };
}

// Collections mappers — the UI writes {dateFlagged, amountAtReferral, agency,
// status:'approved'|'resolved'} (saveCollectionsFlag / resolveCollection),
// which the old mappers didn't know: every reload zeroed the referral amount,
// dropped the agency, and reset status to 'flagged' (isInCollections then
// returned false — the Collections KPI/banners vanished), and "Mark Resolved"
// produced no mapped change so the diff never fired an upsert.
// finance_collections.stage has a CHECK constraint (flagged/letter_1/letter_2/
// final_notice/legal_referral/written_off/resolved/closed) — 'approved' is a
// UI-only status, so it maps to a valid stage and back. `agency` has no
// column; it round-trips on an 'Agency: <name>' first line inside notes.
var _COLLECTION_STAGES = ['flagged','letter_1','letter_2','final_notice','legal_referral','written_off','resolved','closed'];
function _collectionToRow(c){
  var stage;
  if (c.status === 'resolved') stage = 'resolved';
  else if (_COLLECTION_STAGES.indexOf(c.stage) >= 0 && c.stage !== 'resolved' && c.stage !== 'closed') stage = c.stage;
  else if (c.status === 'approved' || c.status === 'pending-ed' || !c.status) stage = (_COLLECTION_STAGES.indexOf(c.stage) >= 0) ? c.stage : 'flagged';
  else stage = (_COLLECTION_STAGES.indexOf(c.stage) >= 0) ? c.stage : 'flagged';
  var notes = c.notes || '';
  if (c.agency) notes = 'Agency: ' + c.agency + (notes ? '\n' + notes : '');
  return {
    id: c.id, nation_id: _NATION(),
    tenant_id: c._rawTenantId || c.tenantId,  // preserve DB pointer across a person-merge
    opened_date: c.openedDate || c.dateFlagged || c.date || today(),
    closed_date: c.closedDate || (c.status === 'resolved' ? today() : null),
    stage: stage,
    amount_at_open: Number(c.amountAtOpen || c.amountAtReferral || c.amount || 0),
    amount_current: c.amountCurrent != null ? Number(c.amountCurrent) : null,
    notes: notes || null,
    archived: !!c.archived,
    created_by: c.createdBy || _ACTOR(),
    updated_by: _ACTOR()
  };
}
function _collectionFromRow(r){
  var rawNotes = r.notes || '';
  var agency = '';
  var m = /^Agency: ([^\n]*)\n?/.exec(rawNotes);
  if (m) { agency = m[1]; rawNotes = rawNotes.slice(m[0].length); }
  var terminal = (r.stage === 'resolved' || r.stage === 'closed' || r.stage === 'written_off');
  var amt = Number(r.amount_at_open||0);
  return {
    id: r.id, tenantId: r.tenant_id,
    openedDate: r.opened_date, closedDate: r.closed_date,
    dateFlagged: r.opened_date,
    stage: r.stage,
    amountAtOpen: amt,
    amountAtReferral: amt,
    amountCurrent: r.amount_current != null ? Number(r.amount_current) : null,
    // UI status: active cases read as 'approved' (what isInCollections and the
    // KPI/banners key on), terminal stages as 'resolved'.
    status: terminal ? 'resolved' : 'approved',
    agency: agency,
    notes: rawNotes,
    archived: !!r.archived,
    createdBy: r.created_by
  };
}

function _journalToRow(j){
  var debit = Number(j.debit||0), credit = Number(j.credit||0);
  // Encode status + groupRef into the reference column as 'status|groupRef'
  // since finance_journal has no dedicated status/group_ref columns.
  var status = j.status || 'posted';
  var groupRef = j.ref || '';
  var encodedRef = status + '|' + groupRef;
  var _jtid = j._rawTenantId || j.tenantId;  // preserve DB pointer across a person-merge
  var tenantId = _jtid && _jtid !== '' ? _jtid : null;
  var entryDate = j.date || new Date().toISOString().slice(0,10);
  return {
    id: j.id, nation_id: _NATION(),
    tenant_id: tenantId,
    entry_date: entryDate,
    account_code: j.ledger || null,
    debit: debit, credit: credit,
    description: j.memo || j.desc || '(no memo)',
    reference: encodedRef,
    voids_id: j.voidsId || null,
    void_reason: j.voidReason || null,
    created_by: j.postedBy || j.createdBy || _ACTOR()
  };
}
function _journalFromRow(r){
  // Decode status + groupRef from reference column ('status|groupRef')
  var rawRef = r.reference || '';
  var pipeIdx = rawRef.indexOf('|');
  var status, groupRef;
  // 'void' was missing here, so a voided journal original reloaded as
  // status 'posted' with its group ref corrupted to 'void|<ref>' — the void
  // silently un-did itself and the group link broke.
  var knownStatuses = ['pending-ed','pending','posted','approved','reversed','declined','void'];
  if (pipeIdx >= 0) {
    var maybeStatus = rawRef.slice(0, pipeIdx);
    if (knownStatuses.indexOf(maybeStatus) >= 0) {
      status   = maybeStatus;
      groupRef = rawRef.slice(pipeIdx + 1);
    } else {
      // Legacy row — reference column holds a plain ref string
      status   = 'posted';
      groupRef = rawRef;
    }
  } else {
    status   = knownStatuses.indexOf(rawRef) >= 0 ? rawRef : 'posted';
    groupRef = '';
  }
  return {
    id: r.id, tenantId: r.tenant_id || '',
    date: r.entry_date,
    ledger: r.account_code || 'rent',
    debit: Number(r.debit||0), credit: Number(r.credit||0),
    memo: r.description || '', desc: r.description || '',
    ref: groupRef, postedBy: r.created_by, status: status,
    voidsId: r.voids_id, voidReason: r.void_reason
  };
}



// ── Table registry ─────────────────────────────────────────────────────────
// Binds each in-memory collection name to its Supabase table + mappers.
// orderBy is the column used for initial-load sorting; must exist in the
// actual schema (see f2_finance_schema.sql). Adding a new table = one line
// here plus the two mapper functions above.
var _FIN_TABLES = [
  { key:'tenants',        table:'tenants',                orderBy:'created_at.desc', toRow:_tenantToRow,       fromRow:_tenantFromRow       },
  { key:'rentLedger',     table:'finance_rent_ledger',    orderBy:'entry_date.desc', toRow:_rentLedgerToRow,   fromRow:_rentLedgerFromRow   },
  { key:'loanList',       table:'finance_loans',          orderBy:'created_at.desc', toRow:_loanToRow,         fromRow:_loanFromRow         },
  { key:'loanPayments',   table:'finance_loan_payments',  orderBy:'payment_date.desc', toRow:_loanPaymentToRow,  fromRow:_loanPaymentFromRow  },
  { key:'arrangements',   table:'finance_arrangements',   orderBy:'created_at.desc', toRow:_arrangementToRow,  fromRow:_arrangementFromRow  },
  { key:'arrPayments',    table:'finance_arr_payments',   orderBy:'payment_date.desc', toRow:_arrPaymentToRow,   fromRow:_arrPaymentFromRow   },
  { key:'collections',    table:'finance_collections',    orderBy:'opened_date.desc', toRow:_collectionToRow,   fromRow:_collectionFromRow   },
  { key:'journalEntries', table:'finance_journal',        orderBy:'entry_date.desc', toRow:_journalToRow,      fromRow:_journalFromRow      },
  // (hydroLedger/gasLedger table entries removed — the utility layer was dead
  //  code with zero UI: no save path, no render, two wasted fetches per boot.
  //  _emptyStore keeps the keys so any residual d.hydroLedger read stays safe.)
];

// ── Fetch helpers ──────────────────────────────────────────────────────────
// Build the right headers once so every call uses the bearer from the
// housing login handoff (FINANCE_HEADERS set at boot by F1 infrastructure).
function _fetchFromSupabase(path, opts){
  var headers = (typeof FINANCE_HEADERS !== 'undefined' && FINANCE_HEADERS)
              ? FINANCE_HEADERS
              : { 'apikey': SUPABASE_ANON, 'Content-Type': 'application/json' };
  return fetch(SUPABASE_URL + '/rest/v1/' + path, Object.assign({ headers: headers }, opts||{}));
}

// ── Boot load ──────────────────────────────────────────────────────────────
// Fetches every finance table in parallel, maps to in-memory shape, and
// populates _memStore. Called once at page load. Returns a promise so the
// DOMContentLoaded handler can await it before the first render.
// Re-mark voided ORIGINALS after a reload. voidLedgerEntry sets
// original.status='void' in memory, but most tables have no status column —
// only the reversal row's voids_id backref survives the round-trip. Without
// this pass, a reloaded original tested as not-voided (finIsVoided false):
// it counted fully in balances, showed as live in every table, and could be
// voided a second time. Runs across every collection generically.
function _finDeriveVoidedOriginals(store){
  try {
    Object.keys(store || {}).forEach(function(key){
      var arr = store[key];
      if (!Array.isArray(arr) || !arr.length) return;
      var voidedIds = {};
      var hasAny = false;
      arr.forEach(function(e){ if (e && e.voidsId) { voidedIds[e.voidsId] = true; hasAny = true; } });
      if (!hasAny) return;
      arr.forEach(function(e){
        if (e && voidedIds[e.id] && e.status !== 'void' && e.status !== 'reversed') e.status = 'void';
      });
    });
  } catch(e) { console.warn('[finance] void derivation failed:', e); }
}

// Roll duplicate-person records up under their canonical tenant. The sync
// trigger makes one person several tenants rows; merged_into points each
// duplicate at the canonical row. We rewrite every child row's tenantId to the
// canonical id IN MEMORY so all per-tenant filters/aggregations (ledger, loans,
// arrears, profile, dashboard) sum under one person. The ORIGINAL id is kept on
// row._rawTenantId and written back by the toRow mappers, so persistence never
// repoints the DB and the merge stays reversible (merged_into can be cleared to
// un-merge). Runs once post-hydration and BEFORE _finBackfillDerivedFields, so
// loan/arr payments (which derive tenantId from their parent there) inherit the
// canonical id automatically. Idempotent: a row already canonical is skipped.
function _finCanonicalizeTenantRefs(store){
  try {
    var byId = {}; (store.tenants || []).forEach(function(t){ if (t && t.id) byId[t.id] = t; });
    // Any merge pointers at all? If not, skip the whole pass.
    var hasMerge = (store.tenants || []).some(function(t){ return t && t.mergedInto; });
    if (!hasMerge) return;
    function canon(id){
      var seen = {}, cur = id;
      for (var i = 0; i < 25 && cur && !seen[cur]; i++){
        seen[cur] = 1;
        var t = byId[cur];
        if (!t || !t.mergedInto) return cur;
        cur = t.mergedInto;
      }
      return cur;
    }
    // Tables that carry a direct tenant_id from the DB. loanPayments/arrPayments
    // are intentionally omitted — they derive tenantId from their parent in the
    // next pass, and never persist a tenant_id column.
    ['rentLedger','loanList','arrangements','collections','journalEntries'].forEach(function(key){
      (store[key] || []).forEach(function(row){
        if (!row || !row.tenantId) return;
        var c = canon(row.tenantId);
        if (c && c !== row.tenantId){
          if (row._rawTenantId == null) row._rawTenantId = row.tenantId;  // preserve DB pointer
          row.tenantId = c;
        }
      });
    });
  } catch(e){ console.warn('[finance] tenant canonicalize failed:', e); }
}

// Derive client-side fields the tables don't store, right after hydration:
// - loan/arrangement payments reload with tenantId:'' ("derived via lookup at
//   render", said the mapper comment — but no lookup existed anywhere), which
//   zeroed per-tenant Period Summary / Transactions / reconciliation rows.
// - loan.payment ("client-computed") was never recomputed, so loan detail,
//   the record-payment prefill, and unified-payment allocation all read $0.00
//   after any reload (finance-batch worked around it locally).
function _finBackfillDerivedFields(store){
  try {
    var loanById = {}; (store.loanList     || []).forEach(function(l){ if (l && l.id) loanById[l.id] = l; });
    var arrById  = {}; (store.arrangements || []).forEach(function(a){ if (a && a.id) arrById[a.id]  = a; });
    (store.loanPayments || []).forEach(function(p){
      if (p && !p.tenantId) { var l = loanById[p.loanId]; if (l) p.tenantId = l.tenantId || ''; }
    });
    (store.arrPayments || []).forEach(function(p){
      if (p && !p.tenantId) { var a = arrById[p.arrId]; if (a) p.tenantId = a.tenantId || ''; }
    });
    if (typeof calcPaymentAmt === 'function') {
      (store.loanList || []).forEach(function(l){
        if (l && !l.payment && Number(l.principal) > 0) {
          l.payment = calcPaymentAmt(Number(l.principal), Number(l.rate || 0), Number(l.term || 0), l.freq || 'monthly') || 0;
        }
      });
    }
  } catch(e) { console.warn('[finance] derived-field backfill failed:', e); }
}

async function _bootLoadFinanceData(){
  var nation = _NATION();
  var results = {};
  try {
    var fetches = _FIN_TABLES.map(function(spec){
      var path = spec.table
        + '?select=*&nation_id=eq.' + encodeURIComponent(nation)
        + '&order=' + spec.orderBy
        + '&limit=10000';
      return _fetchFromSupabase(path).then(function(r){
        if (!r.ok) throw new Error('[finance boot] ' + spec.table + ' HTTP ' + r.status);
        return r.json().then(function(rows){
          results[spec.key] = (rows||[]).map(spec.fromRow);
        });
      }).catch(function(err){
        console.warn('[finance boot] ' + spec.table + ' failed:', err);
        results[spec.key] = [];
      });
    });
    await Promise.all(fetches);
    _memStore = Object.assign(_emptyStore(), results);
    _finCanonicalizeTenantRefs(_memStore);   // roll merged-duplicate persons up (before payment derive)
    _finDeriveVoidedOriginals(_memStore);
    _finBackfillDerivedFields(_memStore);
    if (window.CLFN_DEBUG) console.log('[finance] hydrated:',
      _FIN_TABLES.map(function(s){ return s.key + '=' + (results[s.key]||[]).length; }).join(', '));

    // Feature-detect the optional method/reference columns on the rent ledger
    // (migration 20260820_finance_ledger_method). Pre-migration, the probe
    // 400s and the mapper simply keeps omitting the columns.
    try {
      var _mr = await _fetchFromSupabase('finance_rent_ledger?select=method,reference&limit=1');
      window._finLedgerHasMethod = !!(_mr && _mr.ok);
    } catch(e) { window._finLedgerHasMethod = false; }

    // Load housing_settings so APPROVAL_AUTHORITY overrides are respected on this page
    try {
      var setR = await _fetchFromSupabase('housing_settings?select=key,value');
      if (setR.ok) {
        var setD = await setR.json();
        if (!window._appSettings) window._appSettings = {};
        (setD||[]).forEach(function(r){ window._appSettings[r.key] = r.value; });
        if (typeof _flattenLegacyAppSettings === 'function') _flattenLegacyAppSettings();
        if (typeof initApprovalAuthority === 'function') initApprovalAuthority();
      }
    } catch(e) { console.warn('[finance] settings load skipped:', e); }

    // Also load housing_units — read-only cache used by the unit picker in
    // Add Tenant modal. Not part of the finance write path; just a lookup.
    try {
      var ur = await _fetchFromSupabase('housing_units?select=id,num,street,status,assigned_name,data&order=street,num&limit=10000');
      if (ur.ok) {
        var urows = await ur.json();
        window._housingUnits = urows || [];
        console.log('[finance] housing_units loaded: ' + window._housingUnits.length);
        _populateUnitDatalist();
      } else {
        window._housingUnits = [];
      }
    } catch(e) {
      console.warn('[finance boot] housing_units failed:', e);
      window._housingUnits = [];
    }
  } catch(e) {
    console.error('[finance boot] fatal:', e);
    _memStore = _emptyStore();
    _toastError('Failed to load finance data. Some views may be empty.');
  }
  return _memStore;
}

// Build the <datalist> options for the unit picker. Called after the
// housing_units cache is populated. Idempotent.
function _populateUnitDatalist(){
  var dl = document.getElementById('housingUnitsList');
  if (!dl) return;
  var units = (window._housingUnits || []).filter(function(u){ return !u.archived; });
  // Format: "<num> <street> — <status>" e.g. "42 Main St — vacant"
  dl.innerHTML = units.map(function(u){
    var label = ((u.num||'') + ' ' + (u.street||'')).trim() || ('Unit ' + (u.id||'').slice(0,8));
    var meta  = u.status ? (' — ' + u.status) : '';
    if (u.assigned_name) meta += ' (currently: ' + u.assigned_name + ')';
    return '<option value="' + label.replace(/"/g, '&quot;') + '" data-unit-id="' + u.id + '">' + label + meta + '</option>';
  }).join('');
}

// Resolve a typed unit string back to a housing_units.id. Returns null if
// the user typed free text that doesn't match any unit (we still persist
// the text in tenant.unit for display; only unit_id FK is nullable).
function _resolveUnitId(typedValue){
  if (!typedValue) return null;
  var target = typedValue.trim().toLowerCase();
  var match = (window._housingUnits || []).find(function(u){
    var label = ((u.num||'') + ' ' + (u.street||'')).trim().toLowerCase();
    return label === target;
  });
  return match ? match.id : null;
}

// ── Diff + write ───────────────────────────────────────────────────────────
// Given a new _memStore candidate d, find rows added/changed/removed per
// table vs the prior _memStore, then upsert/delete against Supabase. Done
// fire-and-forget. Best-effort; failures toast red.
function _diffCollection(prev, next, toRow){
  // Compare using toRow output when available — prevents extra in-memory fields
  // (charge, payment, type, method etc.) from causing spurious re-upserts.
  function sig(x) {
    if (!toRow) return JSON.stringify(x);
    try {
      var r = toRow(x);
      // null means 'skip this row entirely' — use a fixed sentinel so it
      // never appears to have changed vs itself
      return r ? JSON.stringify(r) : '__SKIP__';
    } catch(e) { return JSON.stringify(x); }
  }
  var prevMap = {}; (prev||[]).forEach(function(x){ if (x && x.id) prevMap[x.id] = x; });
  var nextMap = {}; (next||[]).forEach(function(x){ if (x && x.id) nextMap[x.id] = x; });
  var toUpsert = [], toDelete = [];
  Object.keys(nextMap).forEach(function(id){
    var p = prevMap[id];
    if (!p || sig(p) !== sig(nextMap[id])) {
      toUpsert.push(nextMap[id]);
    }
  });
  Object.keys(prevMap).forEach(function(id){
    if (!(id in nextMap)) toDelete.push(id);
  });
  return { toUpsert: toUpsert, toDelete: toDelete };
}

function _upsertRows(table, rows){
  if (!rows.length) return Promise.resolve();
  var headers = Object.assign({}, FINANCE_HEADERS || {}, {
    'Prefer': 'resolution=merge-duplicates,return=minimal',
    'Content-Type': 'application/json'
  });
  return fetch(SUPABASE_URL + '/rest/v1/' + table, {
    method: 'POST', headers: headers, body: JSON.stringify(rows)
  }).then(function(r){
    if (!r.ok) return r.text().then(function(t){
      console.error('[finance] UPSERT FAILED', table, r.status, t, 'rows:', JSON.stringify(rows));
      throw new Error(table + ' upsert ' + r.status + ': ' + t);
    });
  });
}

function _deleteRows(table, ids){
  if (!ids.length) return Promise.resolve();
  // Use the in.() list operator; one request per table.
  var inList = ids.map(function(x){ return '"'+x+'"'; }).join(',');
  var path = table + '?id=in.(' + encodeURIComponent(inList) + ')';
  return _fetchFromSupabase(path, { method:'DELETE' }).then(function(r){
    if (!r.ok) return r.text().then(function(t){ throw new Error(table + ' delete ' + r.status + ': ' + t); });
  });
}

// ── saveData — diff and fire-and-forget persist ────────────────────────────
// Synchronous from caller's perspective. Updates _memStore immediately so
// subsequent getData() reflects the change. Supabase writes happen async.
//
// Important: there is NO localStorage fallback here. Previously we mirrored
// to localStorage as a "safety net," but that created a dangerous failure
// mode — if Supabase writes failed silently, localStorage still held the
// data and subsequent page loads would "restore" data that doesn't actually
// exist in Supabase. That masked real persistence failures. Now: if a
// Supabase write fails, the user sees a red toast AND the data won't be
// there on refresh. Painful, but honest.
// Queue to serialize saveData calls - prevents concurrent writes causing duplicate upserts
var _saveQueue = Promise.resolve();
function saveData(d){
  // Enqueue this save - runs after any in-flight save completes
  _saveQueue = _saveQueue.then(function(){ return _doSaveData(d); }).catch(function(){});
}
function _doSaveData(d){
  // Snapshot prev BEFORE we touch _memStore. Deep-clone so later mutations
  // (including _memStore = next on the next line) can't retroactively change
  // what prev looks like during the diff.
  var prev = _cloneStore(_memStore);
  var next = Object.assign(_emptyStore(), d || {});

  console.log('[finance trace] saveData called. tenants: prev=' + (prev.tenants||[]).length + ', next=' + (next.tenants||[]).length);

  // 1) Update in-memory authoritative store immediately.
  _memStore = next;

  // 2) Persist diffs to Supabase in parallel. Collect promises so we can
  //    toast once globally on outcome rather than per-table.
  var writePromises = [];
  var totalUpserts = 0, totalDeletes = 0;
  var perTableReport = [];

  _FIN_TABLES.forEach(function(spec){
    var diff = _diffCollection(prev[spec.key], next[spec.key], spec.toRow);
    totalUpserts += diff.toUpsert.length;
    totalDeletes += diff.toDelete.length;

    if (diff.toUpsert.length) {
      var rows = diff.toUpsert.map(function(x){
        try { return spec.toRow(x); } catch(e) { console.error('[finance] toRow failed on '+spec.key, x, e); return null; }
      }).filter(Boolean);
      console.log('[finance trace] ' + spec.key + ' → ' + spec.table + ': diff=' + diff.toUpsert.length + ' mapped=' + rows.length);
      if (rows.length) {
        console.log('[finance trace] ' + spec.key + ' payload:', JSON.stringify(rows));
        _writeInFlight++;
        var p = _upsertRows(spec.table, rows)
          .then(function(resp){
            console.log('[finance trace] ' + spec.table + ' upsert SUCCESS');
            perTableReport.push(spec.key+':upserted '+rows.length);
          })
          .catch(function(err){
            perTableReport.push(spec.key+':FAILED');
            console.error('[finance] upsert ' + spec.table + ' FAILED:', err.message);
            console.error('[finance] payload that failed:', JSON.stringify(rows, null, 2));
            throw err;  // re-throw so Promise.all rejects
          })
          .finally(function(){ _writeInFlight--; });
        writePromises.push(p);
      }
    }
    if (diff.toDelete.length) {
      _writeInFlight++;
      var dp = _deleteRows(spec.table, diff.toDelete)
        .then(function(){ perTableReport.push(spec.key+':deleted '+diff.toDelete.length); })
        .catch(function(err){
          perTableReport.push(spec.key+':DELETE-FAILED');
          console.error('[finance] delete ' + spec.table + ' failed:', err);
          throw err;
        })
        .finally(function(){ _writeInFlight--; });
      writePromises.push(dp);
    }
  });

  console.log('[finance trace] total writePromises: ' + writePromises.length + ', upserts=' + totalUpserts + ', deletes=' + totalDeletes);

  if (writePromises.length === 0) {
    console.log('[finance trace] no changes detected, nothing to persist');
    return;
  }

  // 3) Handle outcome. Log per-table report on success; toast red on failure.
  return Promise.all(writePromises).then(function(){
    if (window.CLFN_DEBUG) console.log('[finance] save OK —', perTableReport.join(', '));
  }).catch(function(err){
    console.error('[finance] save FAILED —', perTableReport.join(', '), err);
    _toastError('Some changes could not be saved. Check console for details.');
  });
}

// ── Audit writer ───────────────────────────────────────────────────────────
// Inserts one row into finance_audit_log. Fire-and-forget. Failures are
// loud because an audit miss is a compliance gap.
//
// IMPORTANT: tenant_id on audit rows is tricky. The schema has a FK
// (tenant_id → tenants.id ON DELETE RESTRICT) which races with the tenant
// upsert itself on CREATE_TENANT actions — the audit row may reach Supabase
// before the tenant does, failing the FK check. Workaround: do NOT populate
// the top-level tenant_id column for now; always embed tenant context in
// the detail JSON instead. Reports that need per-tenant audit history can
// filter on detail->>'tenant_id' until we drop/relax the FK in F3B.
// ── Finance Audit Log ──────────────────────────────────────────────────────
// POSTs one row to finance_audit_log. Fire-and-forget; failures are logged
// to console but do not interrupt the caller (audit miss should never block
// a save). Column mapping: occurred_at, actor_email, actor_name, actor_role,
// action, entity_type, entity_id, summary, detail (jsonb), nation_id.
// tenant_id is intentionally omitted — FK races on create actions; embed
// tenant context inside detail instead.
function _writeAuditEntry(entry) {
  if (!entry || !entry.action) return;
  var sess   = window.HOUSING_SESSION || {};
  var nation = typeof _NATION === 'function' ? _NATION() : '';
  // Build detail jsonb — merge caller-supplied detail with before/after/tenant
  var det = entry.detail ? (typeof entry.detail === 'object' ? Object.assign({}, entry.detail) : {raw: entry.detail}) : {};
  if (entry.before    && !det.before)     det.before     = entry.before;
  if (entry.after     && !det.after)      det.after      = entry.after;
  if (entry.tenant_id && !det.tenant_id)  det.tenant_id  = entry.tenant_id;
  var payload = {
    nation_id:   nation,
    occurred_at: new Date().toISOString(),
    actor_email: sess.email || '',
    actor_name:  sess.name  || (typeof CURRENT_USER !== 'undefined' ? CURRENT_USER : ''),
    actor_role:  window.currentRole || '',
    action:      entry.action,
    entity_type: entry.entity_type || '',
    entity_id:   entry.entity_id ? String(entry.entity_id) : null,
    summary:     entry.summary || entry.description || '',
    detail:      Object.keys(det).length ? det : null
  };
  var headers = Object.assign({},
    typeof FINANCE_HEADERS !== 'undefined' ? FINANCE_HEADERS : {'apikey': SUPABASE_ANON, 'Content-Type': 'application/json'},
    {'Prefer': 'return=minimal'}
  );
  fetch(SUPABASE_URL + '/rest/v1/finance_audit_log', {
    method: 'POST', headers: headers, body: JSON.stringify(payload)
  }).catch(function(e){ console.warn('[finance audit] write failed:', e); });
}

// Public wrapper so action-specific callers (approveLoan, postPayment, etc.)
// can add richer audit entries. Usage:
//   writeAuditEntry({action:'approve_loan', entity_type:'loan', entity_id:ln.id,
//                    tenant_id:ln.tenantId, summary:'Approved $8000 loan for Mary Atlookan'});
function writeAuditEntry(entry){ return _writeAuditEntry(entry||{}); }

// ═══════════════════════════════════════════════════════════════════════════
// PHASE F3B — Void helpers
// ═══════════════════════════════════════════════════════════════════════════

// Global flag — toggled by the "Show voided entries" checkbox in the header.
window._finShowVoided = false;

// True when an entry is voided (original) OR is a reversing entry (voidsId set).
// Covers both legacy 'reversed' and new 'void' status values.
function finIsVoided(entry) {
  var st = entry && entry.status;
  return st === 'void' || st === 'reversed' || !!(entry && entry.voidsId);
}

// Re-render the currently visible Finance page when the toggle changes.
function finToggleShowVoided(checked) {
  window._finShowVoided = !!checked;
  var curEl = document.querySelector('.page.on');
  var pageId = curEl ? curEl.id.replace('page-', '') : '';
  if (pageId && pageId !== 'home') {
    if (typeof showPage === 'function') showPage(pageId);
  } else {
    if (typeof renderDashboard === 'function') renderDashboard();
  }
}

// Show the shared void-reason modal, then call onConfirm(reason).
// opts: { label, preview }
function showVoidModal(opts, onConfirm) {
  var titleEl   = document.getElementById('void-modal-title');
  var previewEl = document.getElementById('void-entry-preview');
  var inputEl   = document.getElementById('void-reason-input');
  var errEl     = document.getElementById('void-reason-error');
  if (!titleEl) {
    // Fallback if modal not in DOM
    var r = prompt((opts && opts.label || 'Void entry') + ' — reason (required):');
    if (r && r.trim()) onConfirm(r.trim());
    return;
  }
  titleEl.textContent = (opts && opts.label) || 'Void Entry';
  if (previewEl) previewEl.innerHTML = (opts && opts.preview) || '';
  if (inputEl)   inputEl.value = '';
  if (errEl)     errEl.style.display = 'none';
  window._voidConfirmAction = function() {
    var reason = (inputEl ? inputEl.value : '').trim();
    if (!reason) { if (errEl) errEl.style.display = 'block'; return; }
    if (typeof closeModal === 'function') closeModal('modalVoidEntry');
    onConfirm(reason);
  };
  if (typeof openModal === 'function') openModal('modalVoidEntry');
  setTimeout(function(){ if (inputEl) inputEl.focus(); }, 80);
}

// Build a sign-reversed entry for the given collection.
function _makeReversalEntry(collectionKey, original, reversalId, reason, actor) {
  var td = (new Date()).toISOString().slice(0, 10);
  if (collectionKey === 'rentLedger') {
    return {
      id: reversalId,
      tenantId: original.tenantId, unitId: original.unitId || null,
      date: td,
      desc: 'VOID: ' + (original.desc || ''),
      charge: original.payment || 0,
      payment: original.charge || 0,
      type: 'void', method: '', status: 'void',
      voidsId: original.id, voidReason: reason, createdBy: actor
    };
  }
  if (collectionKey === 'loanPayments') {
    return {
      id: reversalId,
      loanId: original.loanId, tenantId: original.tenantId || '',
      date: td,
      amount: -(original.amount || 0),
      method: 'void', notes: 'VOID: ' + reason,
      status: 'void',
      voidsId: original.id, voidReason: reason, createdBy: actor
    };
  }
  if (collectionKey === 'arrPayments') {
    return {
      id: reversalId,
      arrId: original.arrId, invoiceId: original.invoiceId || '',
      tenantId: original.tenantId || '',
      date: td,
      amount: -(original.amount || 0),
      method: 'void', type: 'void',
      ref: '', notes: 'VOID: ' + reason,
      status: 'void',
      voidsId: original.id, voidReason: reason, createdBy: actor
    };
  }
  if (collectionKey === 'journalEntries') {
    return {
      id: reversalId,
      tenantId: original.tenantId || '',
      date: td,
      ledger: original.ledger,
      debit: original.credit || 0, credit: original.debit || 0,
      charge: original.credit || 0, payment: original.debit || 0,
      memo: 'VOID: ' + (original.memo || original.desc || ''),
      desc: 'VOID: ' + (original.memo || original.desc || ''),
      ref: original.ref || '',
      postedBy: actor,
      status: 'void', type: 'journal', method: 'journal',
      voidsId: original.id, voidReason: reason
    };
  }
  // (hydroLedger/gasLedger reversal branch removed with the dead utility layer)
  return null;
}

// Void a single ledger entry by ID. Marks original status='void', inserts a
// sign-reversed entry with voidsId pointing back, writes an audit entry, saves.
function voidLedgerEntry(collectionKey, originalId, reason) {
  var d = getData();
  var collection = d[collectionKey];
  if (!collection) { _toastError('Cannot void: unknown collection ' + collectionKey); return; }
  var original = collection.find(function(x){ return x.id === originalId; });
  if (!original) { if (typeof toast === 'function') toast('Entry not found — may already be voided.'); return; }
  if (finIsVoided(original)) { if (typeof toast === 'function') toast('Entry is already voided.'); return; }
  var actor = _ACTOR();
  var now = new Date().toISOString();
  original.status    = 'void';
  original.voidReason = reason;
  original.voidedAt  = now;
  original.voidedBy  = actor;
  var reversalId = uid();
  var reversal = _makeReversalEntry(collectionKey, original, reversalId, reason, actor);
  if (reversal) collection.push(reversal);
  writeAuditEntry({
    action: 'void_entry',
    entity_type: collectionKey,
    entity_id: originalId,
    summary: 'Void: ' + (original.desc || original.memo || collectionKey) + ' — ' + reason,
    detail: { reason: reason, reversal_id: reversalId, voided_by: actor }
  });
  saveData(d);
}

// Void a journal entry group (all rows sharing the same ref UUID).
function voidJournalGroup(ref, fallbackId, reason) {
  var d = getData();
  var toVoid = (ref && ref !== '')
    ? (d.journalEntries||[]).filter(function(j){ return j.ref === ref; })
    : (d.journalEntries||[]).filter(function(j){ return j.id === fallbackId; });
  if (!toVoid.length) { if (typeof toast === 'function') toast('Journal entry not found.'); return; }
  if (finIsVoided(toVoid[0])) { if (typeof toast === 'function') toast('Already voided.'); return; }
  var actor = _ACTOR();
  var now = new Date().toISOString();
  var groupVoidRef = uid();
  toVoid.forEach(function(j) {
    j.status = 'void'; j.voidReason = reason; j.voidedAt = now; j.voidedBy = actor;
    var rev = _makeReversalEntry('journalEntries', j, uid(), reason, actor);
    if (rev) { rev.ref = groupVoidRef; d.journalEntries.push(rev); }
  });
  writeAuditEntry({
    action: 'void_entry',
    entity_type: 'journalEntries',
    entity_id: ref || fallbackId,
    summary: 'Void journal entry group — ' + reason,
    detail: { reason: reason, ref: ref, line_count: toVoid.length, voided_by: actor }
  });
  saveData(d);
}

// ── loadData / getData — synchronous contract, deep copy ───────────────────
// These must remain synchronous because 125 call sites depend on that, and
// they must return a DEEP COPY of _memStore so that call sites which do
// `var d = getData(); d.tenants.push(...); saveData(d);` don't mutate
// _memStore in place. If they mutated _memStore in place, then by the time
// saveData runs, `prev` (from _memStore) and `next` (from the passed d)
// would be identical and the diff would find no changes — silently
// dropping every write. That was the root-cause of "UI says saved, but
// Supabase has nothing" bugs prior to this version.
//
// NO localStorage fallback. Previously we would restore from localStorage
// if _memStore was null, which masked failed Supabase writes.
function _cloneStore(s){
  // JSON round-trip is sufficient: finance data is plain JSON-compatible
  // (no Date, no functions, no circular refs). Fast enough at this scale.
  return s ? JSON.parse(JSON.stringify(s)) : _emptyStore();
}
function loadData(){
  if (_memStore) return Object.assign(_emptyStore(), _cloneStore(_memStore));
  return _emptyStore();
}
function getData(){ return loadData(); }

// Purge the legacy localStorage store on page load. This prevents lingering
// data from older versions of the app from confusing users about what is
// actually persisted in Supabase.
try { localStorage.removeItem('clfn_finance_v6'); } catch(e) {}
