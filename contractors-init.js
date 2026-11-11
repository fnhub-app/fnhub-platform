// ── contractors.html page init ───────────────────────────────────────────────
// ── ROLE safety fallback — in case shared-config.js fails to load ────────────
if(typeof ROLE === 'undefined') {
  window.ROLE = {
    ED:              'ed',
    HOUSING_MANAGER: 'housing_manager',
    HE_L2:           'housing_employee_l2',
    HE_L1:           'housing_employee_l1',
    isManagement: function(r) { return r==='ed'||r==='housing_manager'; }
  };
  console.warn('[CLFN] ROLE fallback — shared-config.js may not have loaded');
}

// ═══════════════════════════════════════════════════════════════════════════
// NATION CONFIG (multi-tenant foundation) — mirrored from housing.html
// ═══════════════════════════════════════════════════════════════════════════
// Each page is self-contained for now; Phase C will extract this to shared.js.

// ── Supabase Storage helpers ──────────────────────────────────────────────
// Moved to /shared.js (Turn 3, Phase C dedup). Same behavior, same call
// sites — just loaded from the shared file now.

// ══════════════════════════════════════════════════════════════
// SUPABASE DATA LAYER
// All localStorage reads/writes have Supabase equivalents here.
// The app falls back to localStorage if Supabase is unavailable.
// ══════════════════════════════════════════════════════════════

window._contractors=[];window._sowCache={};window._renoProgress={};
var _sigPads = {};  // signature pad state — referenced by _initSigPad in shared-data.js
window._renoBudget={};window._unitPhotos={};window._appSettings={};
var housingUnits=[];var applications=[];var auditLog=[];
// ── Helpers ──





function showDash() {
  window.location.href = '/housing.html?view=home';
}

window._navStack = window._navStack || [];
window._navMap = {
  'contractors': function(){ showContractors(); },
};

// ── Contractor functions ─────────────────────────────────────────────────────
// setRenosNav — no-op on contractors.html (nav tabs only exist on renos.html)
function setRenosNav(active) {}

function showContractors() {
  hideAllViews('contractorsView');
  setRenosNav('contractors');
  var v = document.getElementById('contractorsView');
  if (v) { v.style.display = 'flex'; v.style.flexDirection = 'column'; }
  if (typeof renderContractorsView === 'function') renderContractorsView();
}

function ctUpdateClassBorder(label) {
  var radio = label.querySelector('input[name="ct_classification"]');
  if(radio && !radio.checked) label.style.borderColor = 'var(--border)';
}

function ctFileDragOver(e,zoneId){e.preventDefault();var z=document.getElementById(zoneId);if(z){z.style.borderColor='var(--yellow)';z.style.background='rgba(248,228,26,0.06)';}}

function ctFileDrop(e,bucket){e.preventDefault();ctFileDragLeave('ct_'+bucket+'_drop');ctFileUpload({files:e.dataTransfer.files,value:''},bucket);}

// ── loadRenosData — fetches units, SOW, reno progress, settings, contractors ──
async function loadRenosData() {
  try {
    var results = await Promise.all([
      fetch(SUPABASE_URL+'/rest/v1/housing_units?select=*&order=street,num&limit=9999',{headers:HOUSING_HEADERS}),
      fetch(SUPABASE_URL+'/rest/v1/housing_sow?select=*',{headers:HOUSING_HEADERS}),
      fetch(SUPABASE_URL+'/rest/v1/housing_reno_progress?select=*',{headers:HOUSING_HEADERS}),
      fetch(SUPABASE_URL+'/rest/v1/housing_settings?select=key,value',{headers:HOUSING_HEADERS}),
      sbLoadContractors()
    ]);
    var uR=results[0], sowR=results[1], rpR=results[2], stR=results[3], cR=results[4];
    if(uR && uR.ok) {
      var rawU = await uR.json();
      housingUnits = rawU.map(function(row){
        return Object.assign({}, row.data||{}, {
          id:row.id, num:row.num, street:row.street,
          bedrooms:row.bedrooms, bathrooms:row.bathrooms,
          type:row.type, foundation:row.foundation, funder:row.funder,
          status:row.status||'vacant', accessible:!!row.accessible,
          isElders:!!row.is_elders, archived:!!row.archived,
          assignedTo:row.assigned_to, assignedName:row.assigned_name
        });
      });
    }
    if(cR) window._contractors = cR;
    if(sowR && sowR.ok){var sd=await sowR.json();sd.forEach(function(r){window._sowCache[r.unit_id]=r.data;});}
    if(rpR && rpR.ok){var rpd=await rpR.json();rpd.forEach(function(r){window._renoProgress[r.unit_id]=r.data;});}
    if(stR && stR.ok){var stD=await stR.json();window._appSettings={};stD.forEach(function(r){window._appSettings[r.key]=r.value;});if(typeof _flattenLegacyAppSettings==='function')_flattenLegacyAppSettings();}
    if(typeof initApprovalAuthority === 'function') initApprovalAuthority();
    // Apply saved module-enablement NOW that _appSettings is fully loaded. Without
    // this, moduleOn()'s lazy hydration may have already run against the empty
    // _appSettings set at boot and marked itself "hydrated" — so gates like
    // moduleOn('contractor_portal') would read the registry DEFAULT (off) and hide
    // the portal Invite buttons even though the nation enabled the module. Mirrors
    // what housing.html does at login.
    window._moduleEnablementHydrated = false;
    if(typeof initModuleEnablement === 'function') initModuleEnablement();
    // Apply saved theme (logo + brand colors) — without this, the shared
    // header keeps the build-time default logo instead of the one uploaded
    // in Settings → Admin → Branding. Mirrors what loadHousingData() does
    // for inventory / tenants / match.
    if(typeof _applyTheme === 'function') _applyTheme((window._appSettings||{}).theme || {});
    if(typeof applyNationOverrides === 'function') applyNationOverrides();
  } catch(e){ console.warn('[contractors] data load error:', e); }
}

// ── Page boot ────────────────────────────────────────────────────────────────
(async function initContractorsPage() {
  var token = sessionStorage.getItem('clfn_housing_token');
  if (!token) { window.location.href = 'index.html'; return; }
  // NOTE: the module gate moved BELOW the data load — checking here ran before
  // housing_settings hydrated, so a persisted "module off" was never seen and
  // the gate failed open (any direct URL still worked).
  var savedRole  = sessionStorage.getItem('clfn_housing_role') || 'housing_employee_l1';
  var savedName  = sessionStorage.getItem('clfn_housing_name') || '';
  var savedEmail = sessionStorage.getItem('clfn_housing_email_session') || '';
  if (typeof HOUSING_HEADERS !== 'undefined') HOUSING_HEADERS['Authorization'] = 'Bearer ' + token;
  if (typeof HOUSING_SESSION !== 'undefined') {
    HOUSING_SESSION.accessToken = token; HOUSING_SESSION.role = savedRole;
    HOUSING_SESSION.name = savedName; HOUSING_SESSION.email = savedEmail;
  }
  window.currentRole = savedRole; window._realRole = savedRole;
  if (HOUSING_SESSION.email && typeof resolveHousingRole === 'function') {
    try { await resolveHousingRole(); } catch(e) { console.warn('[contractors] role resolve:', e); }
  }
  var role = HOUSING_SESSION.role || savedRole;
  window.currentRole = role; window._realRole = role;
  if (typeof updateHeaderUser === 'function') updateHeaderUser(role);
  if (typeof updateRoleSwitcherVisibility === 'function') updateRoleSwitcherVisibility();
  if (typeof renderHeaderNav === 'function') renderHeaderNav();
  if (typeof applyRoleVisibility === 'function') applyRoleVisibility(role);
  if (typeof setHeaderNavActive === 'function') setHeaderNavActive('contractors');
  if (typeof loadRenosData === 'function') {
    try { await loadRenosData(); } catch(e) { console.warn('[contractors] data load error:', e); }
  }
  // Module gate — AFTER settings hydration so a persisted "off" is enforced.
  // moduleOn lazily hydrates saved overrides from _appSettings (shared-config).
  if (typeof moduleOn === 'function' && !moduleOn('contractors')) {
    window.location.href = 'housing.html?view=home'; return;
  }
  showContractors();

  // Round-trip handoff: if we returned here from a SOW modal close, re-open
  // the same contractor card the user was viewing before they navigated away.
  try {
    var qp = new URLSearchParams(window.location.search);
    var openCtId = qp.get('openContractor');
    if (openCtId && Array.isArray(window._contractors)) {
      var idx = window._contractors.findIndex(function(c){ return c && c.id === openCtId; });
      // Open the contractor in the new TIC-style card (edit mode reveals the
      // approval surface — Approve / Return for Info / Decline pills — so the
      // "Verify"/"Approve" worklist actions land on the same card layout as
      // every other contractor view, not the old standalone approval panel.
      if (idx >= 0 && typeof openAddContractorModal === 'function') {
        // Opened via a cross-page deep link — arm the return so closing the
        // card goes back to the origin page (e.g. the landing worklist) when a
        // nav referrer was set. No referrer (a SOW round-trip) → stays here.
        window._ctDeepLinkReturn = true;
        setTimeout(function(){ openAddContractorModal(idx); }, 80);
      } else if (idx >= 0 && typeof openCtApprovalPanel === 'function') {
        setTimeout(function(){ openCtApprovalPanel(idx); }, 80);
      }
    }
    // Cross-page handoff from landing-page Create menu.
    if (qp.get('action') === 'newContractor' && typeof openAddContractorModal === 'function') {
      setTimeout(function(){ openAddContractorModal(); }, 80);
    }
  } catch (e) { /* harmless */ }
}());