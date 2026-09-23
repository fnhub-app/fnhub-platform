/* ============================================================
 * housing-init.js — CLFN Housing Suite
 * Auth, session, data loading, page initialisation
 *
 * Load order: ... housing-app.js → THIS FILE (last before inline)
 *
 * Covers: showDashboard, login/logout, session restore,
 *   loadHousingData, initHousingPage,
 *   staff management modal, email notifications, sign-in flow
 * ============================================================ */

'use strict';

// ── ROLE safety fallback — if shared-config.js fails to load ─────────────────
if (typeof ROLE === 'undefined') {
  window.ROLE = {
    ED:              'ed',
    HOUSING_MANAGER: 'housing_manager',
    HE_L2:           'housing_employee_l2',
    HE_L1:           'housing_employee_l1',
    isManagement: function(r) { return r === 'ed' || r === 'housing_manager'; }
  };
  console.warn('[CLFN] ROLE fallback — shared-config.js may not have loaded');
}

// ── Build marker ──────────────────────────────────────────────────────────────
if (window.CLFN_DEBUG) console.log('%c[CLFN HOUSING] Build: F1-2026-04-21', 'background:#F8E41A;color:#111;font-weight:700;padding:4px 8px;');

// ── Page-specific role switch hook ────────────────────────────────────────────
// shared-ui.js switchRole() calls this after updating window.currentRole,
// the header, and nav visibility. Housing-page-specific logic goes here.
window._onSwitchRole = function(role) {
  if (window._currentScorecardApp && typeof renderScorecardActions === 'function')
    renderScorecardActions(window._currentScorecardApp);
  if (typeof applyTenancyFieldRoles === 'function') applyTenancyFieldRoles();
  // Only navigate home if no view is currently visible (i.e. during boot).
  // Includes landingView so role switches on the landing page don't trigger a
  // redundant re-render via showEmployeeHome (which already handles landing).
  var anyVisible = ['landingView','worklistView','inventoryView','matchView',
    'tenantsView','settingsView','scorecardView','appLayout'].some(function(id) {
    var el = document.getElementById(id);
    return el && el.style.display !== 'none' && el.style.display !== '';
  });
  if (!anyVisible && typeof showEmployeeHome === 'function') showEmployeeHome();
};

// ── Page-specific logout hook ─────────────────────────────────────────────────
// shared-auth.js doLogout() calls this after clearing all state.
window._onLogout = function() {
  applications = []; housingUnits = [];
  if (typeof showLoginScreen === 'function') showLoginScreen();
};

// ── Page-specific nav map (used by shared-ui.js goBack()) ─────────────────────
// Registered after page functions are defined (see bottom of script block).


function _toggleHomelessAddress(isHomeless) {
  var blk = document.getElementById('addrBlk');
  if (blk) blk.style.display = isHomeless ? 'none' : '';
  // When homeless is turned on, pre-fill urgent_need if it hasn't been assessed yet.
  // If staff have already chosen a non-default value, leave it alone.
  var needEl = document.getElementById('urgent_need');
  if (needEl) {
    if (isHomeless && needEl.value === 'none') {
      needEl.value = 'homeless';
      if (typeof triggerV2Score === 'function') triggerV2Score();
    }
  }
}

// (removed _saveToggleStates — it wrote sessionStorage '_toggleStates' that
// nothing ever read; the inline onchange callers in housing.html were cleaned
// up with it. See AUDIT_2026-07.md storage-key inventory.)

function syncAccessibility(){
  // Read every checked acc_* checkbox by its visible value, write to the
  // hidden #accessibility field that the save path reads.
  var checks = document.querySelectorAll('input[id^="acc_"]:checked');
  var vals = [];
  checks.forEach(function(el){ vals.push(el.value); });
  var field = document.getElementById('accessibility');
  if(field) field.value = vals.join(', ') || 'None';
}

function clearCurrentUnit(){
  var idEl  = document.getElementById('currentUnitId');      if(idEl)  idEl.value  = '';
  var adEl  = document.getElementById('currentUnitAddress'); if(adEl)  adEl.value  = '';
  var srEl  = document.getElementById('currentUnitSearch');  if(srEl)  srEl.value  = '';
  var dd    = document.getElementById('currentUnitDropdown');if(dd)    dd.style.display = 'none';
  var sel   = document.getElementById('currentUnitSelected');if(sel)   sel.style.display = 'none';
}

function searchCurrentUnit(q){
  var dd = document.getElementById('currentUnitDropdown');
  if(!dd) return;
  if(!q || q.length < 2){ dd.style.display='none'; dd.innerHTML=''; return; }
  var allUnits = [];
  try {
    var _s = JSON.stringify(housingUnits);
    allUnits = _s ? JSON.parse(_s) : [];
  } catch(e) {}
  if(!allUnits.length) allUnits = getAllUnits();
  // For "current house on reserve" search: show occupied, under_repair, condemned — the unit the person lives in
  var matches = allUnits.filter(function(u){
    return (u.num+' '+u.street).toLowerCase().includes(q.toLowerCase());
  }).slice(0,8);
  if(!matches.length){
    dd.innerHTML='<div style="padding:8px 12px;color:var(--muted);font-size:13px;">No units found</div>';
    dd.style.display='block'; return;
  }
  dd.innerHTML = matches.map(function(u){
    var addr = u.num+' '+u.street;
    var statusLabel = {occupied:'Occupied',vacant:'Vacant',condemned:'Condemned',reserved:'Reserved'}[u.status]||u.status;
    return '<div style="padding:8px 12px;cursor:pointer;border-bottom:1px solid var(--border);font-size:13px;" '
      +'data-uid="'+u.id+'" data-label="'+addr+'" onmousedown="selectCurrentUnit(this)">'
      +'<span style="font-weight:600;">'+addr+'</span>'
      +' <span style="font-size:11px;color:var(--muted);">('+u.bedrooms+'-bed · '+statusLabel+')</span>'
      +'</div>';
  }).join('');
  dd.style.display='block';
}

function selectCurrentUnit(el){
  var id    = el.getAttribute('data-uid');
  var label = el.getAttribute('data-label');
  var idEl  = document.getElementById('currentUnitId');      if(idEl)  idEl.value  = id;
  var adEl  = document.getElementById('currentUnitAddress'); if(adEl)  adEl.value  = label;
  var srEl  = document.getElementById('currentUnitSearch');  if(srEl)  srEl.value  = label;
  var dd    = document.getElementById('currentUnitDropdown');if(dd)    { dd.style.display='none'; dd.innerHTML=''; }
  // Show the selected card
  var sel   = document.getElementById('currentUnitSelected');
  var nm    = document.getElementById('currentUnitSelectedName');
  var det   = document.getElementById('currentUnitSelectedDetail');
  if(nm)  nm.textContent  = label;
  // Find unit detail
  var allUnits = getAllUnits();
  var u = allUnits.find(function(x){ return x.id===id; });
  if(det) det.textContent = u ? u.bedrooms+'-bedroom · '+u.type : '';
  if(sel) sel.style.display='block';
  if(typeof calcPersonsOverStandard === "function") { calcPersonsOverStandard(); triggerV2Score(); }
}
function closeApplicationForm(){
  // Hide the form
  var al = document.getElementById('appLayout'); if(al) al.style.display='none';
  var spb = document.getElementById('stepProgressBar'); if(spb) spb.style.display='none';
  var abr = document.getElementById('appBackRow'); if(abr) abr.style.display='none';
  var apf = document.getElementById('appProgressFoot'); if(apf) apf.style.display='none';
  var em = document.getElementById('editModal'); if(em) em.classList.remove('on');

  // If the app was opened from a KPI drilldown list (or the Likely Already
  // Housed report), Back should land on that list again — captured here,
  // reopened after the underlying view is restored below.
  var _returnDrill = window._appFormReturnDrill || null;
  window._appFormReturnDrill = null;

  // Cross-page referrer wins — the user came from match.html (or similar)
  // via a hard navigation, so the in-memory _navStack is empty on this page
  // and would otherwise dump them at home/landing.
  if (typeof consumeNavReferrer === 'function') {
    var ref = consumeNavReferrer();
    var routes = window.CLFN_PAGE_ROUTES || {};
    if (ref && routes[ref]) { window.location.href = routes[ref]; return; }
  }

  // Use in-memory nav stack to go back to wherever the user came from on this
  // page (e.g. they were on Inventory in this same tab before opening the app).
  var stack = window._navStack || [];
  // Pop the 'app' entry if it's on top
  if(stack.length && stack[stack.length-1] === 'app') stack.pop();

  var prev = stack.length ? stack[stack.length-1] : null;
  var navMap = {
    'home':        showEmployeeHome,
    'inventory':   showInventory,
    'match':       showMatch,
    'tenants':     showTenants,
    'renos':       showRenos,
    'contractors': showContractors,
    'settings':    showSettings,
  };
  window._navSkipPush = true;
  if(prev && navMap[prev]) {
    navMap[prev]();
  } else {
    showEmployeeHome();
  }
  window._navSkipPush = false;

  // Reopen the drill list on top of the restored view (recomputed fresh, so
  // any status/type change made in the form is already reflected).
  if (_returnDrill) {
    if (_returnDrill === 'likely_housed') {
      if (typeof showLikelyHousedReport === 'function') showLikelyHousedReport();
    } else if (typeof showHousingKpiDrilldown === 'function') {
      showHousingKpiDrilldown(_returnDrill);
    }
  }
}

function newApp(){
  // The application wizard's DOM (#appLayout) exists only on housing.html.
  // Called from any other page — the unit card's "Start New Application"
  // (inventory/tenants/match) or the Add-Tenant modal's link — the reset
  // below ran against a missing form and visibly did nothing. Hand off to
  // housing.html's ?view= dispatcher instead (same pattern as showSettings).
  if (!document.getElementById('appLayout')) {
    window.location.href = 'housing.html?view=newapp';
    return;
  }
  // Reset editing state
  currentAppId = null;
  window._appFormReturnTo = null;
  window._appFormReturnDrill = null;   // fresh apps aren't drill-launched
  _step6DocLib = null;       // reset so DocLibrary re-mounts for new app ID
  _step6DocLibAppId = null;  // companion tracker — must be cleared together
  // Hide Internal Notes tab — re-appears after the first auto-save.
  if (typeof _refreshAppNotesTabVisibility === 'function') _refreshAppNotesTabVisibility();
  var _noteTa = document.getElementById('appNoteBody');     if(_noteTa) _noteTa.value = '';
  var _noteEr = document.getElementById('appNoteError');    if(_noteEr) { _noteEr.style.display='none'; _noteEr.textContent=''; }
  // Unlock signature panels — a fresh application is always editable.
  if (typeof _unlockApplicantSignatures === 'function') _unlockApplicantSignatures();

  // Clear all form fields
  document.querySelectorAll('#appLayout input[type="text"], #appLayout input[type="email"], #appLayout input[type="tel"], #appLayout input[type="number"], #appLayout input[type="date"], #appLayout textarea').forEach(function(el){
    el.value = '';
  });
  document.querySelectorAll('#appLayout select').forEach(function(el){
    el.selectedIndex = 0;
  });
  document.querySelectorAll('#appLayout input[type="checkbox"], #appLayout input[type="radio"]').forEach(function(el){
    el.checked = false;
  });

  // Clear draft from localStorage
  // Legacy residue cleanup: 'clfn_housing_draft' was never written by any
  // current code path (superseded by clfn_housing_draft_queue).
  try{ localStorage.removeItem('clfn_housing_draft'); }catch(e){}

  // Clear the editing banner
  var secHdr = document.querySelector('#step0 .sec-hdr p');
  if(secHdr) secHdr.textContent = 'Primary applicant\'s personal details, contact, address, utilities, and ' + (window.NATION_CONFIG && NATION_CONFIG.short || '') + ' arrears.';

  // Reset appType toggle to New Housing
  var newRadio = document.getElementById('apptype_new');
  var exRadio  = document.getElementById('apptype_existing');
  if(newRadio){ newRadio.checked = true; }
  if(exRadio) { exRadio.checked  = false; }
  if(typeof onAppTypeChange === 'function') onAppTypeChange();

  // Generate fresh app ID
  if(typeof initAppId === 'function') initAppId();

  // Update page header
  var t = document.getElementById('appLayout_title');
  var s = document.getElementById('appLayout_subtitle');
  var ctx = document.getElementById('appLayout_ctx_bar');
  if(t) t.textContent = '';
  if(s) s.textContent = '';
  if(ctx) ctx.style.display = 'none';

  // Show the form at step 0
  showApp();
  if(typeof goTo === 'function') goTo(0);

  // Apply role-based field locks and run initial V2 score
  applyTenancyFieldRoles();
  buildV2FormSelects();
  triggerV2Score();
  // Fields are cleared above — hide any stale Residency-card flag badges.
  if (typeof _syncOnRezBadge === 'function') _syncOnRezBadge();
  // Fresh form — reset the last-saved indicator until the first auto-save.
  if (typeof _appResetSavedIndicator === 'function') _appResetSavedIndicator();
}




// ══════════════════════════════════════════════════════
// SIGNATURE PAD — clearSig, getSigDataURL, initSignaturePads
// ══════════════════════════════════════════════════════
var _sigPads = {};





// Switch signature method tabs


function initSignaturePads() {
  ['sig_canvas_app','sig_canvas_co','sig_canvas_staff'].forEach(_initSigPad);
}
// Auto-init when step 8 is reached — signature pads are initialized inside goTo()

// ══════════════════════════════════════════════════════
// MISSING CLOSE FUNCTIONS
// ══════════════════════════════════════════════════════
// closePrintPanel defined above
function closeAddUnitModal() {
  var m = document.getElementById('addUnitModal');
  if (m) m.style.display = 'none';
  window._auStagedPhotos = [];
}
function handleAddUnitPhotoUpload(input) {
  if (!window._auStagedPhotos) window._auStagedPhotos = [];
  var files = Array.from(input.files || []);
  files.forEach(function(f) {
    var reader = new FileReader();
    reader.onload = function(e) {
      window._auStagedPhotos.push({ data: e.target.result, name: f.name });
      renderAddUnitPhotoPreview();
    };
    reader.readAsDataURL(f);
  });
}
// Edit-unit photo upload: unit already exists, so upload straight to Supabase Storage
// and append the returned path to the unit's photo list (which persists across sessions).
async function handleEditUnitPhotoUpload(input) {
  var unitId = window._editingUnitId;
  if (!unitId) { showToast('No unit being edited', {type:'error'}); return; }
  var files = Array.from(input.files || []).filter(function(f){ return f.type && f.type.startsWith('image/'); });
  if (!files.length) { input.value = ''; return; }
  var zone = document.getElementById('ue_drop_zone');
  if (zone) zone.style.borderColor = 'var(--yellow)';
  try {
    var existing = getUnitPhotos(unitId) || [];
    for (var i = 0; i < files.length; i++) {
      var rec = await sbUploadAndSave('unit', unitId, files[i], 'units/' + unitId + '/photos');
      existing.push(rec.path);
    }
    saveUnitPhotos(unitId, existing);
    renderEditUnitPhotoPreview(unitId);
    showToast('✓ ' + files.length + ' photo' + (files.length > 1 ? 's' : '') + ' uploaded', {type:'info'});
  } catch (e) {
    console.warn('[EDIT UNIT PHOTO] upload failed:', e);
    showToast('Photo upload failed: ' + (e.message || 'unknown error'), {type:'error'});
  }
  if (zone) zone.style.borderColor = 'var(--border)';
  input.value = '';
}
function renderAddUnitPhotoPreview() {
  var el = document.getElementById('au_photo_preview');
  if (!el) return;
  var photos = window._auStagedPhotos || [];
  if (!photos.length) { el.innerHTML = ''; return; }
  el.innerHTML = photos.map(function(p, i) {
    return '<div style="position:relative;flex-shrink:0;">'
      + '<img src="' + p.data + '" style="width:70px;height:55px;object-fit:cover;border-radius:6px;border:1px solid var(--border);"/>'
      + '<button type="button" onclick="(function(){window._auStagedPhotos.splice(' + i + ',1);renderAddUnitPhotoPreview();})()" style="position:absolute;top:-5px;right:-5px;background:var(--danger);border:none;color:#fff;width:16px;height:16px;border-radius:50%;cursor:pointer;font-size:9px;">✕</button>'
      + '</div>';
  }).join('');
}

// ══════════════════════════════════════════════════════
// PHOTO DRAG/DROP HELPERS (addUnitModal)
// ══════════════════════════════════════════════════════
function photoDragOver(e, zoneId) {
  e.preventDefault();
  var z = document.getElementById(zoneId);
  if (z) { z.style.borderColor = 'var(--yellow)'; z.style.background = 'var(--yellow-light)'; }
}
function photoDragLeave(zoneId) {
  var z = document.getElementById(zoneId);
  if (z) { z.style.borderColor = 'var(--border)'; z.style.background = 'var(--bg)'; }
}
function photoDrop(e, mode) {
  e.preventDefault();
  var zoneId = mode === 'add' ? 'au_drop_zone' : 'ue_drop_zone';
  photoDragLeave(zoneId);
  var files = Array.from(e.dataTransfer.files || []);
  if (mode === 'add') {
    if (!window._auStagedPhotos) window._auStagedPhotos = [];
    files.forEach(function(f) {
      if (!f.type.startsWith('image/')) return;
      var r = new FileReader();
      r.onload = function(ev) {
        window._auStagedPhotos.push({ data: ev.target.result, name: f.name });
        renderAddUnitPhotoPreview();
      };
      r.readAsDataURL(f);
    });
  } else if (mode === 'edit') {
    if (typeof handleEditUnitPhotoUpload === 'function') {
      var dt = new DataTransfer();
      files.forEach(function(f) { dt.items.add(f); });
      var inp = document.getElementById('ue_photo_input');
      if (inp) { Object.defineProperty(inp, 'files', { value: dt.files }); handleEditUnitPhotoUpload(inp); }
    }
  }
}

// ══════════════════════════════════════════════════════
// INIT ON LOAD
// ══════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', function() {
  // Clear field-error highlight when user starts editing a field
  var appLayout = document.getElementById('appLayout');
  if (appLayout) {
    appLayout.addEventListener('input', function(e) {
      if (e.target.classList.contains('field-error')) {
        e.target.classList.remove('field-error');
      }
    });
    appLayout.addEventListener('change', function(e) {
      if (e.target.classList.contains('field-error')) {
        e.target.classList.remove('field-error');
      }
    });
  }
  // Init sig pads when step 8 becomes visible
  var origGoTo = window.goTo;
  if (typeof origGoTo === 'function') {
    window.goTo = function(s) {
      origGoTo(s);
      if (s === 8) setTimeout(initSignaturePads, 100);
    };
  }
  // Init staged photos array
  window._auStagedPhotos = [];
});


// ═══════════════════════════════════════════════════════════════
// APPROVAL WORKFLOW ENGINE
// ═══════════════════════════════════════════════════════════════

// ── Contact settings helpers ──
function renderScorecardActions(app) {
  var bar  = document.getElementById('sc_action_bar');
  var btns = document.getElementById('sc_action_buttons');
  if(!bar || !btns || !app) return;

  var role   = window.currentRole || 'housing_employee_l1';
  var status = app.status || 'draft';
  var isFileUpdate = (app.appType === 'existing_tenant');
  var actions = [];

  // ── Housing Manager actions ──
  if(APPROVAL_AUTHORITY.can('reviewApplication', role)) {
    if(status === APP_STATUS.SUBMITTED) {
      // New housing app — HM recommends to ED
      actions.push({ label: '✅ Recommend to ED', cls: 'btn-green',   action: 'mgr_approved',  confirmLabel: 'Recommend to Executive Director' });
      actions.push({ label: '↩️ Return for Info',  cls: 'btn-sec',    action: 'returned',       confirmLabel: 'Return to Submitter' });
      actions.push({ label: '❌ Decline',           cls: 'btn-ghost',  action: 'declined',       confirmLabel: 'Decline Application', needsNotes: true });
    }
    if(status === APP_STATUS.FILE_UPDATE) {
      // File update — HM is final approver
      actions.push({ label: '✅ Approve File Update', cls: 'btn-green', action: 'hm_approved', confirmLabel: 'Approve File Update' });
      actions.push({ label: '↩️ Return for Info',     cls: 'btn-sec',   action: 'returned',    confirmLabel: 'Return to Submitter' });
    }
    if(status === 'returned') {
      actions.push({ label: '📋 Move to Review Queue', cls: 'btn-primary', action: 'submitted', confirmLabel: 'Send Back to Review Queue' });
    }
  }

  // ── Executive Director actions ──
  if(APPROVAL_AUTHORITY.can('finalApproveApp', role)) {
    if(status === APP_STATUS.FILE_UPDATE) {
      actions.push({ label: '✅ Approve File Update', cls: 'btn-green', action: 'ed_approved', confirmLabel: 'Approve File Update' });
      actions.push({ label: '↩️ Return for Info',     cls: 'btn-sec',   action: 'returned',    confirmLabel: 'Return to Submitter' });
    }
    if(status === APP_STATUS.MGR_APPROVED) {
      actions.push({ label: '✅ Final Approval',  cls: 'btn-green',  action: 'ed_approved', confirmLabel: 'Grant Final Approval' });
      actions.push({ label: '↩️ Return to HM',    cls: 'btn-sec',    action: 'returned',    confirmLabel: 'Return to Housing Manager' });
      actions.push({ label: '❌ Decline',          cls: 'btn-ghost',  action: 'declined',    confirmLabel: 'Decline Application', needsNotes: true });
    }
    if(status === APP_STATUS.SUBMITTED) {
      // ED can also act directly on submitted apps
      actions.push({ label: '✅ Final Approval',  cls: 'btn-green',  action: 'ed_approved', confirmLabel: 'Grant Final Approval' });
      actions.push({ label: '↩️ Return for Info', cls: 'btn-sec',    action: 'returned',    confirmLabel: 'Return for More Info' });
      actions.push({ label: '❌ Decline',          cls: 'btn-ghost',  action: 'declined',    confirmLabel: 'Decline Application', needsNotes: true });
    }
  }

  // A user holding both HM (reviewApplication) and ED (finalApproveApp)
  // authority would otherwise see the shared actions (Return for Info, Decline,
  // Approve File Update) twice — once from each block. Dedupe by visible label,
  // keeping the first occurrence, so each action shows once.
  var _seenLbl = {};
  actions = actions.filter(function(a){
    if (_seenLbl[a.label]) return false;
    _seenLbl[a.label] = true;
    return true;
  });

  var canAssignSecondary = status === 'assigned' && APPROVAL_AUTHORITY.can('assignUnit', role);

  if(!actions.length && !canAssignSecondary) { bar.style.display = 'none'; return; }

  bar.style.display = 'block';
  btns.innerHTML = actions.map(function(a) {
    return '<button class="btn ' + a.cls + '" style="font-size:13px;" '
      + 'onclick="openApprovalModal(\'' + a.action + '\',\'' + (a.confirmLabel||a.label) + '\',' + (a.needsNotes?'true':'false') + ')">'
      + a.label + '</button>';
  }).join('');

  // Secondary unit assign button — available once primary unit is assigned
  if (canAssignSecondary) {
    var secBtn = document.createElement('button');
    secBtn.className = 'btn btn-primary';
    secBtn.style.fontSize = '13px';
    secBtn.textContent = '🏢 Assign Secondary Unit';
    secBtn.onclick = function() { openAssignModal(app.id); };
    btns.appendChild(secBtn);
  }

  // Secondary units strip — list any additional units this tenant holds
  var secStrip = document.getElementById('sc_secondary_units');
  if (secStrip) {
    var secIds = app.secondaryUnits || [];
    var secAddrs = app.secondaryAddresses || [];
    if (secIds.length) {
      var allUnits2 = getAllUnits();
      var secCards = secIds.map(function(uid, i) {
        var su = allUnits2.find(function(x){ return x.id === uid; });
        var addr2 = su ? su.num+' '+su.street : (secAddrs[i] || uid);
        var typeLabel = su ? (_fmtUnitType(su.type)||'—') : '—';
        var funderLabel = su ? (_fmtFunder(su.funder)||'—') : '—';
        return '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:var(--surface);border:1px solid var(--border);border-radius:8px;">'
          +'<div>'
            +'<div style="font-size:13px;font-weight:700;color:var(--text);">'+addr2+'</div>'
            +'<div style="font-size:11px;color:var(--muted);margin-top:2px;">'+typeLabel+' · '+funderLabel+'</div>'
          +'</div>'
          +'<span style="font-size:10px;font-weight:700;padding:2px 9px;border-radius:10px;background:var(--info-blue-bg);color:var(--info-blue);">Secondary</span>'
          +'</div>';
      }).join('');
      secStrip.innerHTML = '<div class="sc-surface sc-action-bar" style="margin-top:0;">'
        +'<div class="lbl-muted mb-12">Secondary Units</div>'
        +'<div style="display:flex;flex-direction:column;gap:8px;">'+secCards+'</div>'
        +'</div>';
      secStrip.style.display = 'block';
    } else {
      secStrip.style.display = 'none';
      secStrip.innerHTML = '';
    }
  }
}

// ══════════════════════════════════════════════════════════════
// CONTRACTOR AGREEMENT — Print & Email
// ══════════════════════════════════════════════════════════════












// ══════════════════════════════════════════════════════════════
// CONTRACTOR APPROVAL WORKFLOW
// ══════════════════════════════════════════════════════════════

var _ctApprovalIdx = -1;
var _ctPendingAction = null;






















// ══════════════════════════════════════════════════════════════
// ASSIGN UNIT — Direct from match view
// ══════════════════════════════════════════════════════════════

var _amAppId = null;
var _amBestUnitId = null;
var _amSelectedUnitId = null;
var _amAllScored = [];
var _amSecondaryScored = []; // commercial / privately-owned units shown in secondary section
// Search/filter state for the assign-unit modal — kept module-level so
// amFilterUnits() can re-render with the captured role/needsAccess context.
var _amSearchQuery = '';
var _amCurrentRole = '';
var _amCurrentNeedsAccess = false;

// Secondary-eligible unit definition — commercial / band buildings or privately-owned funder.
// These units can be assigned to a tenant who already holds a primary band unit.
var _SECONDARY_FUNDERS = ['privately_owned'];
var _SECONDARY_TYPES   = ['commercial_building', 'admin_building', 'band_building'];
function _isSecondaryEligibleUnit(u) {
  if (!u) return false;
  return _SECONDARY_FUNDERS.indexOf(u.funder) !== -1 || _SECONDARY_TYPES.indexOf(u.type) !== -1;
}

// A unit two or more bedrooms bigger than what the applicant needs (e.g. a
// 3-bed for someone who needs 1) is out of the normal auto-assignable range —
// one size up (needsBeds+1) is fine, but anything beyond that needs ED
// approval. Shared by _scoreUnit() below and confirmAssignment()'s hard gate.
function _isOversizedUnit(u, needsBeds) {
  return u && u.bedrooms != null && u.bedrooms >= needsBeds + 2;
}

function _scoreUnit(u, needsBeds, needsAccess, isElders) {
  var sc = 0;
  if(u.bedrooms === needsBeds)            sc += 10;
  else if(u.bedrooms === needsBeds + 1)   sc += 5;
  else if(u.bedrooms === needsBeds - 1)   sc += 3;
  else if(_isOversizedUnit(u, needsBeds)) sc -= 50; // 2+ bedrooms over — requires ED approval
  if(needsAccess && u.accessible)     sc += 8;
  if(needsAccess && !u.accessible)    sc -= 4;
  if(isElders && u.isElders)          sc += 6;
  if(!isElders && u.isElders)         sc -= 100; // ineligible — cannot appear as RECOMMENDED
  return sc;
}

// ════════════════════════════════════════════════════════════════════════════
// ASSIGN-UNIT MODAL TEMPLATE — single source of truth
// ════════════════════════════════════════════════════════════════════════════
// The modal markup used to live only in match.html, but the Assign button on
// the housing.html dashboard also calls openAssignModal — which crashed when
// the modal element wasn't on the current page. Same divergence pattern that
// hit the SOW modal. Both pages now host an empty <div id="assignModalHost">
// which the template mounts into on first call via _ensureAssignModal().
function _buildAssignModalHTML() {
  return '' +
    '<div class="assign-modal-body">' +
      // ── Header ───────────────────────────────────────────────────────
      '<div class="modal-hdr spacious assign-modal-hdr">' +
        '<div>' +
          '<div class="assign-modal-eyebrow">Housing Match</div>' +
          '<div class="panel-title">Assign Unit to Applicant</div>' +
        '</div>' +
        '<button onclick="closeAssignModal()" class="btn-close-sm">✕</button>' +
      '</div>' +

      '<div class="assign-modal-content">' +

        // ── Applicant summary strip ────────────────────────────────────
        '<div style="background:var(--bg);border-radius:10px;padding:14px 16px;display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;border:1px solid var(--border);">' +
          '<div>' +
            '<div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px;">Applicant</div>' +
            '<div id="am_app_name" class="txt-md-bold"></div>' +
            '<div id="am_app_id"   style="font-size:11px;color:var(--muted);margin-top:1px;"></div>' +
          '</div>' +
          '<div>' +
            '<div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px;">Score</div>' +
            '<div id="am_app_score"  class="txt-md-bold"></div>' +
            '<div id="am_app_status" style="font-size:11px;font-weight:700;margin-top:1px;"></div>' +
          '</div>' +
          '<div>' +
            '<div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px;">Needs</div>' +
            '<div id="am_app_reqs" style="font-size:12px;color:var(--text);line-height:1.4;"></div>' +
          '</div>' +
        '</div>' +

        // ── Unit match list ────────────────────────────────────────────
        '<div class="card card-flush">' +
          '<div class="modal-hdr compact">' +
            '<div class="lbl-yellow">Available Units — Ranked by Match</div>' +
            '<div id="am_role_badge" style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:8px;background:rgba(255,255,255,0.1);color:var(--txt-on-dark);"></div>' +
          '</div>' +
          '<div class="search-row">' +
            '<input type="text" id="am_search_input" oninput="amFilterUnits(this.value)" placeholder="&#128269; Search by address or street…" autocomplete="off"/>' +
          '</div>' +
          '<div id="am_unit_list"></div>' +
        '</div>' +

        // ── Selection / Override notes ─────────────────────────────────
        '<div id="am_override_wrap">' +
          '<div class="f">' +
            '<label><span id="am_notes_label" style="font-weight:700;">Selection Notes</span> <span id="am_notes_req_star" style="color:var(--danger);display:none;">*</span></label>' +
            '<textarea id="am_override_notes" rows="2" placeholder="Notes…" style="width:100%;box-sizing:border-box;padding:8px 12px;border:1.5px solid var(--border);border-radius:7px;font-size:13px;font-family:DM Sans,sans-serif;background:var(--surface);color:var(--text);resize:vertical;"></textarea>' +
          '</div>' +
        '</div>' +

        // ── Move-in date + warning ─────────────────────────────────────
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:end;">' +
          '<div class="f">' +
            '<label>Move-in / Occupancy Date</label>' +
            '<input type="date" id="am_movein_date" style="font-size:13px;"/>' +
          '</div>' +
          '<div id="am_warn" style="display:none;padding:10px 12px;border-radius:8px;font-size:11px;font-weight:600;"></div>' +
        '</div>' +

      '</div>' + /* /assign-modal-content */

      // ── Footer ───────────────────────────────────────────────────────
      '<div class="assign-modal-footer">' +
        '<button onclick="closeAssignModal()" class="btn btn-ghost">Cancel</button>' +
        '<button onclick="confirmAssignment()" id="am_confirm_btn" class="btn btn-primary assign-modal-confirm" disabled>Select a unit above</button>' +
      '</div>' +

    '</div>'; /* /assign-modal-body */
}

// Mount the assign template into a host on first call. Re-uses
// #assignUnitModal as the overlay element so existing close/show logic
// keeps working unchanged. Idempotent — the _assignModalMounted guard
// prevents redoing the innerHTML on subsequent opens.
function _ensureAssignModal() {
  if (window._assignModalMounted) return;
  var host = document.getElementById('assignModalHost');
  var modal;
  if (host) {
    host.outerHTML = '<div id="assignUnitModal" class="modal-overlay modal-z-900" onclick="if(event.target===this)closeAssignModal()"></div>';
    modal = document.getElementById('assignUnitModal');
  } else {
    modal = document.getElementById('assignUnitModal');
    if (!modal) {
      console.warn('[ASSIGN] Neither #assignModalHost nor #assignUnitModal exists on this page. Assign modal will not render.');
      return;
    }
  }
  modal.innerHTML = _buildAssignModalHTML();
  window._assignModalMounted = true;
}

function openAssignModal(appId, suggestedUnitId) {
  // Mount the consolidated template on first call. Idempotent so element
  // IDs survive between opens.
  _ensureAssignModal();
  _amAppId = appId; _amBestUnitId = suggestedUnitId || ''; _amSelectedUnitId = null;
  var allApps  = (typeof applications !== 'undefined' ? applications : []);
  var allUnits = getAllUnits().slice();
  var app = allApps.find(function(a){ return a.id===appId; });
  if(!app){ showToast('Application not found', {type:'error'}); return; }
  var role = window.currentRole || 'housing_employee_l1';

  // Primary pool: vacant units that are NOT secondary-eligible (band/ISC/CMHC housing)
  var vacantUnits = allUnits.filter(function(u){ return u.status==='vacant' && !u.archived && !_isSecondaryEligibleUnit(u); });
  var name = ((app.fn||'')+' '+(app.ln||'')).trim();
  var needsBeds   = Math.max(1,1+(app.coApp?1:0)+((app.habitants||[]).length));
  var needsAccess = app.accessibility&&app.accessibility!=='None'&&app.accessibility!=='0'&&app.accessibility!==0;
  var age = app.dob?Math.floor((new Date()-new Date(app.dob))/(365.25*24*3600*1000)):0;
  var _eldersMin = (window._appSettings && window._appSettings.eldersAgeMin) || 65;
  var isElders = age >= _eldersMin;

  // Populate applicant strip
  document.getElementById('am_app_name').textContent  = name;
  document.getElementById('am_app_id').textContent    = app.id;
  var scoreEl = document.getElementById('am_app_score');
  if(scoreEl) scoreEl.textContent = (app.score||0)+' pts · '+(app.tier||'—').replace(' Priority','');
  var statusColors={ed_approved:'var(--success)',hm_approved:'var(--success)',mgr_approved:'#1d4ed8',submitted:'var(--warn-amber-text)'};
  var statusEl=document.getElementById('am_app_status');
  if(statusEl){
    statusEl.textContent = (typeof formatAppStatusLabel === 'function') ? formatAppStatusLabel(app.status) : (app.status||'—');
    statusEl.style.color = statusColors[app.status]||'var(--gray)';
  }
  var reqs=[needsBeds+' bed'+(needsBeds!==1?'s':'')+' needed'];
  if(needsAccess) reqs.push('Accessible');
  if(isElders)    reqs.push('Elders eligible');
  document.getElementById('am_app_reqs').textContent = reqs.join(' · ');

  // Role badge
  var roleBadge = document.getElementById('am_role_badge');
  if(roleBadge){
    roleBadge.textContent = role=== ROLE.ED ? 'Executive Director — can override' : role=== ROLE.HOUSING_MANAGER ? 'Housing Manager — notes required' : 'Staff';
  }

  // Score and rank all primary-pool vacant units
  _amAllScored = vacantUnits.map(function(u){
    return { unit:u, score:_scoreUnit(u, needsBeds, needsAccess, isElders), maxPossible:24 };
  }).sort(function(a,b){ return b.score-a.score; });

  // Secondary pool: commercial / privately-owned units that are currently unassigned.
  // A tenant can hold any number of these in addition to their primary unit.
  _amSecondaryScored = allUnits.filter(function(u){
    return !u.archived && _isSecondaryEligibleUnit(u) && !u.assignedTo;
  }).sort(function(a, b){
    return ((a.num||'') + ' ' + (a.street||'')).localeCompare((b.num||'') + ' ' + (b.street||''));
  });

  // Capture context for filter re-renders + reset search input
  _amCurrentRole = role;
  _amCurrentNeedsAccess = needsAccess;
  _amSearchQuery = '';
  var searchEl = document.getElementById('am_search_input');
  if(searchEl) searchEl.value = '';

  // Render the unit card list
  amRenderUnitList(role, needsAccess);

  // Default move-in to today
  var mi=document.getElementById('am_movein_date'); if(mi) mi.value=new Date().toISOString().split('T')[0];

  // Reset override notes + warning. For override-authority users (ED), keep
  // the notes textarea visible from the start — required only when they pick
  // a unit below the top tied band, but always reachable to type into.
  var ow=document.getElementById('am_override_wrap');
  var preShowNotes = (typeof APPROVAL_AUTHORITY !== 'undefined') && APPROVAL_AUTHORITY.can('overrideMatch', role);
  // Set an explicit 'block' value rather than '' — the CSS has #am_override_wrap
  // { display:none } as the default, so '' would let that rule re-apply.
  if(ow) ow.style.display = preShowNotes ? 'block' : 'none';
  var on=document.getElementById('am_override_notes'); if(on) on.value='';
  var preLabel = document.getElementById('am_notes_label');
  if(preLabel && preShowNotes) {
    preLabel.textContent = 'Selection Notes (optional) — why this unit for this applicant?';
    preLabel.style.color = 'var(--text)';
  }
  var warn=document.getElementById('am_warn'); if(warn) warn.style.display='none';

  // Reset confirm button
  var cb=document.getElementById('am_confirm_btn');
  if(cb){ cb.textContent='Select a unit above'; cb.disabled=true; cb.style.opacity='.45'; cb.style.cursor='not-allowed'; }

  // Show modal
  var modal=document.getElementById('assignUnitModal');
  if(modal){ modal.style.removeProperty('display'); modal.style.setProperty('display','flex','important'); }
}

// Filter the visible units in the assign-unit modal by address/street.
// Re-renders with captured role/needsAccess context.
function amFilterUnits(q) {
  _amSearchQuery = (q || '').toLowerCase();
  amRenderUnitList(_amCurrentRole, _amCurrentNeedsAccess);
}

function amRenderUnitList(role, needsAccess) {
  var list = document.getElementById('am_unit_list');
  if(!list) return;

  var q = _amSearchQuery;
  function _matchesQ(u) {
    if (!q) return true;
    return ((u.num||'') + ' ' + (u.street||'')).toLowerCase().indexOf(q) !== -1;
  }

  var html = '';

  // ── Primary section: vacant band/ISC/CMHC units ranked by match ──────────
  var visiblePrimary = _amAllScored.filter(function(obj){ return _matchesQ(obj.unit); });
  if (visiblePrimary.length) {
    var topUnitId = _amAllScored[0].unit.id;
    var topScore  = _amAllScored[0].score;
    html += '<div style="padding:8px 16px 4px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);">Primary Units — Ranked by Match</div>';
    html += visiblePrimary.map(function(obj){
      var u = obj.unit;
      var pct = Math.round(Math.max(0, obj.score) / obj.maxPossible * 100);
      var isTop = u.id === topUnitId;
      var isAccMismatch = needsAccess && !u.accessible;
      var barColor = isAccMismatch ? 'var(--danger)' : pct >= 70 ? 'var(--success)' : pct >= 40 ? 'var(--warn-amber)' : 'var(--muted)';
      var badges = [];
      var isTiedUnit = obj.score >= topScore - 1;
      if(isTop) badges.push('<span style="font-size:9px;font-weight:800;padding:1px 7px;border-radius:10px;background:var(--yellow);color:var(--dark);">★ RECOMMENDED</span>');
      else if(isTiedUnit) badges.push('<span style="font-size:9px;font-weight:700;padding:1px 7px;border-radius:10px;background:rgba(248,228,26,0.15);color:var(--warn-amber);border:1px solid var(--yellow);">≈ TIED MATCH</span>');
      if(isAccMismatch) badges.push('<span style="font-size:9px;font-weight:700;padding:1px 7px;border-radius:10px;background:var(--danger-bg);color:var(--danger);">⚠ Not accessible</span>');
      if(u.accessible && !isAccMismatch) badges.push('<span style="font-size:9px;font-weight:700;padding:1px 7px;border-radius:10px;background:var(--info-blue-bg);color:var(--info-blue);">♿ Accessible</span>');
      if(u.isElders) badges.push('<span style="font-size:9px;font-weight:700;padding:1px 7px;border-radius:10px;background:var(--warn-amber-bg);color:var(--warn-amber);">Elders Unit</span>');
      return '<div data-unit-id="'+u.id+'" style="padding:14px 16px;border-bottom:1px solid var(--border);cursor:pointer;transition:background .1s;">'
        +'<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:6px;">'
          +'<div>'
            +'<div style="font-size:13px;font-weight:700;color:var(--text);">'+u.num+' '+u.street+'</div>'
            +'<div style="font-size:11px;color:var(--muted);margin-top:1px;">'+u.bedrooms+' bed · '+(_fmtUnitType(u.type)||'—')+(u.funder?' · '+_fmtFunder(u.funder):'')+'</div>'
          +'</div>'
          +'<div style="text-align:right;flex-shrink:0;">'
            +'<div style="font-size:16px;font-weight:800;color:'+barColor+';">'+pct+'%</div>'
            +'<div class="js-lbl-xs">match</div>'
          +'</div>'
        +'</div>'
        +'<div style="height:4px;background:var(--border);border-radius:2px;overflow:hidden;margin-bottom:6px;">'
          +'<div style="height:100%;width:'+pct+'%;background:'+barColor+';border-radius:2px;transition:width .3s;"></div>'
        +'</div>'
        +(badges.length?'<div style="display:flex;gap:4px;flex-wrap:wrap;">'+badges.join('')+'</div>':'')
        +'</div>';
    }).join('');
  }

  // ── Secondary section: commercial / privately-owned units ─────────────────
  var visibleSecondary = _amSecondaryScored.filter(function(u){ return _matchesQ(u); });
  if (visibleSecondary.length) {
    html += '<div style="padding:8px 16px 4px;margin-top:'+(visiblePrimary.length?'8px':'0')+';font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);border-top:'+(visiblePrimary.length?'1px solid var(--border)':'none')+';">'
      +'Secondary Units — Commercial &amp; Private'
      +'<span style="margin-left:8px;font-size:9px;font-weight:600;padding:1px 7px;border-radius:8px;background:var(--info-blue-bg);color:var(--info-blue);">Can hold multiple</span>'
      +'</div>';
    html += visibleSecondary.map(function(u){
      var statusLabel = u.status ? u.status.charAt(0).toUpperCase() + u.status.slice(1) : 'Unknown';
      var typeLabel = _fmtUnitType(u.type) || '—';
      var funderLabel = _fmtFunder(u.funder) || '—';
      return '<div data-unit-id="'+u.id+'" data-secondary="1" style="padding:14px 16px;border-bottom:1px solid var(--border);cursor:pointer;transition:background .1s;">'
        +'<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">'
          +'<div>'
            +'<div style="font-size:13px;font-weight:700;color:var(--text);">'+u.num+' '+u.street+'</div>'
            +'<div style="font-size:11px;color:var(--muted);margin-top:1px;">'+typeLabel+' · '+funderLabel+'</div>'
          +'</div>'
          +'<span style="font-size:10px;font-weight:700;padding:2px 9px;border-radius:10px;background:var(--bg);border:1px solid var(--border);color:var(--muted);white-space:nowrap;">'+statusLabel+'</span>'
        +'</div>'
        +'</div>';
    }).join('');
  }

  if (!visiblePrimary.length && !visibleSecondary.length) {
    html = '<div class="empty-state-ctr">' + (q ? 'No units match your search.' : 'No available units.') + '</div>';
  }

  list.innerHTML = html;

  // Wire click events for all unit cards (primary + secondary)
  list.querySelectorAll('[data-unit-id]').forEach(function(el){
    el.addEventListener('click', function(){
      amSelectUnit(el.getAttribute('data-unit-id'));
    });
    el.addEventListener('mouseover', function(){ if(!el.classList.contains('am-selected')) el.style.background='var(--bg)'; });
    el.addEventListener('mouseout',  function(){ if(!el.classList.contains('am-selected')) el.style.background=''; });
  });
}

function amSelectUnit(unitId) {
  _amSelectedUnitId = unitId;
  var role = window.currentRole || 'housing_employee_l1';

  // Highlight selected card (covers both primary and secondary cards)
  document.querySelectorAll('[data-unit-id]').forEach(function(el){
    var isThis = el.getAttribute('data-unit-id') === unitId;
    el.classList.toggle('am-selected', isThis);
    el.style.background   = isThis ? 'rgba(248,228,26,0.08)' : '';
    el.style.outline      = isThis ? '2px solid var(--yellow)' : '';
    el.style.outlineOffset = isThis ? '-2px' : '';
  });

  // Secondary unit path — skip match/override logic entirely
  var isSecondary = _amSecondaryScored.some(function(u){ return u.id === unitId; });
  if (isSecondary) {
    var ow2 = document.getElementById('am_override_wrap');
    var onLabel2 = document.getElementById('am_notes_label');
    var onReq2   = document.getElementById('am_notes_req_star');
    if(ow2) ow2.style.display = 'block';
    if(onLabel2) { onLabel2.textContent = 'Assignment Notes (optional)'; onLabel2.style.color = 'var(--text)'; }
    if(onReq2)   onReq2.style.display = 'none';
    var cb2 = document.getElementById('am_confirm_btn');
    if(cb2){ cb2.textContent='✓ Assign Secondary Unit'; cb2.disabled=false; cb2.style.opacity='1'; cb2.style.cursor='pointer'; cb2.style.background='var(--yellow)'; cb2.style.color='#111'; }
    var warn2 = document.getElementById('am_warn'); if(warn2) warn2.style.display='none';
    return;
  }

  var allApps=(typeof applications!=='undefined'?applications:[]);
  var app=allApps.find(function(a){return a.id===_amAppId;});
  var needsAccess = app&&app.accessibility&&app.accessibility!=='None'&&app.accessibility!=='0'&&app.accessibility!==0;
  var needsBeds = Math.max(1, 1 + ((app&&app.coApp)?1:0) + (((app&&app.habitants)||[]).length));

  var allUnits = getAllUnits().slice();
  var u=allUnits.find(function(x){return x.id===unitId;});

  // Tie detection: units within 1 point of the top score are "tied" / equally
  // recommended. A unit 2+ bedrooms bigger than needed is never "tied" even
  // if its score happens to land in that band (e.g. every available unit is
  // oversized) — it always routes to the "ED approval required" path below.
  var topScore = _amAllScored.length > 0 ? _amAllScored[0].score : 0;
  var selectedObj = _amAllScored.find(function(o){ return o.unit.id === unitId; });
  var selectedScore = selectedObj ? selectedObj.score : 0;
  var isOversized = _isOversizedUnit(u, needsBeds);
  var isTied = selectedScore >= topScore - 1 && !isOversized; // within 1 pt of top = tied/recommended
  var canOverride  = APPROVAL_AUTHORITY.can('overrideMatch', role);
  var canAssignTie = APPROVAL_AUTHORITY.can('assignTiedBand', role);
  var isEdOverride = canOverride && !isTied; // override-authority user picking below the tied band

  // Notes field:
  //   HM — always required, label reflects whether tied or not
  //   ED — only required when overriding below the tied score band
  var ow = document.getElementById('am_override_wrap');
  var onLabel = document.getElementById('am_notes_label');
  var onReq   = document.getElementById('am_notes_req_star');
  var onPlaceholder = document.getElementById('am_override_notes');

  if(canAssignTie && !canOverride) {
    if(isTied) {
      // Tied — assign-tied-band user can select, notes required
      if(ow) ow.style.display = 'block';
      if(onLabel) { onLabel.textContent = 'Selection Notes (required) — why this unit for this applicant?'; onLabel.style.color = 'var(--text)'; }
      if(onReq)   onReq.style.display = '';
      if(onPlaceholder) onPlaceholder.placeholder = 'e.g. Closest to family, applicant requested this street, accessibility needs met…';
      var cb = document.getElementById('am_confirm_btn');
      if(cb){ cb.textContent='✓ Confirm Selection'; cb.disabled=false; cb.style.opacity='1'; cb.style.cursor='pointer'; cb.style.background='var(--yellow)'; cb.style.color='#111'; }
    } else {
      // Below tied band — user can't override, ED approval required
      if(ow) ow.style.display = 'none';
      var cb = document.getElementById('am_confirm_btn');
      if(cb){ cb.textContent='⛔ ED Approval Required'; cb.disabled=true; cb.style.opacity='1'; cb.style.cursor='not-allowed'; cb.style.background='var(--danger-bg)'; cb.style.color='var(--danger)'; }
    }
  } else if(canOverride) {
    // Always show the notes wrap for override-authority users so the field is
    // visible whether the pick is the top match (notes optional) or below the
    // tied band (notes required). 'block' explicitly overrides the CSS rule
    // #am_override_wrap { display:none } that hides it by default.
    if(ow) ow.style.display = 'block';
    if(onLabel) {
      onLabel.textContent = isEdOverride
        ? 'Override Notes (required) — this unit scores below the top match band.'
        : 'Selection Notes (optional) — why this unit for this applicant?';
      onLabel.style.color = isEdOverride ? 'var(--warn-amber-text)' : 'var(--text)';
    }
    if(onReq) onReq.style.display = isEdOverride ? '' : 'none';
    if(onPlaceholder) onPlaceholder.placeholder = isEdOverride
      ? 'Reason for overriding the recommended match…'
      : 'e.g. Closest to family, applicant requested this street, accessibility needs met…';
  } else {
    if(ow) ow.style.display = 'none';
  }

  // Accessibility warning (shown alongside whatever state the button is in)
  var warn=document.getElementById('am_warn');
  if(warn && u){
    var warnMsgs = [];
    if(needsAccess && !u.accessible) warnMsgs.push('⚠ Applicant requires accessible unit — this unit is not accessible');
    if(isOversized && !canOverride) warnMsgs.push('⛔ This unit is 2+ bedrooms larger than the applicant needs — only the Executive Director can assign it');
    else if(canAssignTie && !canOverride && !isTied) warnMsgs.push('⛔ This unit scores below the recommended match band — only the Executive Director can assign a lower-scored unit');
    if(warnMsgs.length){
      warn.style.display='block'; warn.style.background='var(--danger-bg)'; warn.style.color='var(--danger)';
      warn.textContent = warnMsgs.join(' · ');
    } else { warn.style.display='none'; }
  }

  // Confirm button for override-authority users (assign-tied button already set in branch above)
  if(canOverride) {
    var cb = document.getElementById('am_confirm_btn');
    if(cb){
      cb.textContent = isEdOverride ? '✓ Override & Assign' : '✓ Confirm Selection';
      cb.disabled = false; cb.style.opacity = '1'; cb.style.cursor = 'pointer';
      cb.style.background = 'var(--yellow)'; cb.style.color = '#111';
    }
  }

  // Make sure the notes textarea is actually on screen — on shorter viewports
  // the unit list can push it below the visible area inside the scrollable
  // modal body. Scroll it into view whenever it's shown.
  if(ow && ow.style.display !== 'none'){
    try { ow.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch(_){}
  }
}

function closeAssignModal() {
  var modal=document.getElementById('assignUnitModal'); if(modal)modal.style.display='none';
  _amAppId=null; _amBestUnitId=null; _amSelectedUnitId=null; _amAllScored=[];
}

function confirmAssignment() {
  var unitId = _amSelectedUnitId;
  var moveIn = (document.getElementById('am_movein_date')||{}).value||'';
  if(!unitId){ showToast('Please select a unit', {type:'error'}); return; }
  if(!_amAppId){ showToast('No application selected', {type:'error'}); return; }

  var role = window.currentRole||'staff';
  var isTopRec = _amAllScored.length>0 && _amAllScored[0].unit.id===unitId;
  var isOverride = !isTopRec && _amAllScored.length>0;

  // Tie detection (same as amSelectUnit)
  var topScore2 = _amAllScored.length > 0 ? _amAllScored[0].score : 0;
  var selectedObj2 = _amAllScored.find(function(o){ return o.unit.id === unitId; });
  var selectedScore2 = selectedObj2 ? selectedObj2.score : 0;
  var isTied2 = selectedScore2 >= topScore2 - 1;
  var canOverride2  = APPROVAL_AUTHORITY.can('overrideMatch', role);
  var canAssignTie2 = APPROVAL_AUTHORITY.can('assignTiedBand', role);

  // Secondary-eligible units sit OUTSIDE the scored pool (_amAllScored), so
  // the tied-band math above always read them as score 0 / "below band" —
  // blocking the HM from completing a secondary assignment the modal's own
  // "Assign Secondary Unit" button had just offered, and forcing the ED into
  // the override-notes path the UI labeled optional. They bypass the tied-band
  // machinery entirely (the explicit oversize gate below still applies).
  var isSecondary2 = false;
  if (typeof _isSecondaryEligibleUnit === 'function') {
    var _secU = getAllUnits().find(function(x){ return x.id === unitId; });
    isSecondary2 = _secU ? !!_isSecondaryEligibleUnit(_secU) : false;
  }
  var isEdOverride2 = canOverride2 && !isTied2 && !isSecondary2;

  // Hard gate: assign-tied-only users cannot assign outside the tied score band — overrideMatch only
  if(!isSecondary2 && !canOverride2 && !isTied2) {
    showToast('This unit requires Executive Director approval to assign', { type: 'error' });
    return;
  }

  // assign-tied users always require notes; override users require notes only when overriding below tied band
  var overrideNotes = ((document.getElementById('am_override_notes')||{}).value||'').trim();
  var needsNotes = !isSecondary2 && ((canAssignTie2 && !canOverride2 && isTied2) || isEdOverride2);
  if(needsNotes && !overrideNotes){
    showToast((canAssignTie2 && !canOverride2) ? 'Please add selection notes before confirming' : 'Please add override notes explaining your selection', {type:'error'});
    var notesEl = document.getElementById('am_override_notes');
    if(notesEl) notesEl.focus();
    return;
  }

  var allApps=(typeof applications!=='undefined'?applications:[]);
  var allUnits = getAllUnits().slice();

  var appIdx=allApps.findIndex(function(a){return a.id===_amAppId;});
  var unitIdx=allUnits.findIndex(function(u){return u.id===unitId;});
  if(appIdx<0){showToast('Application not found', {type:'error'});return;}
  if(unitIdx<0){showToast('Unit not found', {type:'error'});return;}

  var app=allApps[appIdx]; var u=allUnits[unitIdx];
  var name=((app.fn||'')+' '+(app.ln||'')).trim();
  var addr = u.num+' '+u.street;
  var today = new Date().toISOString().split('T')[0];

  // Explicit bedroom-oversize gate — independent of the score-tied-band check
  // above so it holds even in the edge case where every available vacant
  // unit happens to be oversized (they'd all tie with each other on score,
  // which would otherwise let the tied-band path through). One size up from
  // what the applicant needs is fine; two or more sizes up always needs ED
  // approval, regardless of what else is available.
  if (!_isSecondaryEligibleUnit(u)) {
    var _caNeedsBeds = Math.max(1, 1 + (app.coApp?1:0) + ((app.habitants||[]).length));
    if (_isOversizedUnit(u, _caNeedsBeds) && !canOverride2) {
      showToast('This unit is 2+ bedrooms larger than the applicant needs — Executive Director approval required', {type:'error'});
      return;
    }
  }

  // ── Secondary unit path ─────────────────────────────────────────────────
  if (_isSecondaryEligibleUnit(u)) {
    // Gate: tenant must be approved or already have a primary unit assigned
    var _secOk = app.status === APP_STATUS.ED_APPROVED ||
                 app.status === APP_STATUS.MGR_APPROVED ||
                 app.status === APP_STATUS.HM_APPROVED  ||
                 app.status === 'assigned';
    if (!_secOk) {
      showToast('Application must be approved or assigned before adding a secondary unit', {type:'error'});
      return;
    }
    // Write unit — do NOT change the unit's status
    u.assignedTo = app.id; u.assignedName = name; u.assignedDate = moveIn;
    u.tenantApprovedBy = CLFN_PERMS.roleLabel(role === ROLE.ED ? ROLE.ED : ROLE.HOUSING_MANAGER);
    u.tenantApprovedAt = today;
    if(overrideNotes) u.assignmentOverrideNotes = overrideNotes;
    allUnits[unitIdx] = u;
    // Write application — append to secondaryUnits; do NOT change app.status
    allApps[appIdx].secondaryUnits = (allApps[appIdx].secondaryUnits || []).concat(unitId);
    allApps[appIdx].secondaryAddresses = (allApps[appIdx].secondaryAddresses || []).concat(addr);
    if(overrideNotes) allApps[appIdx].assignmentOverrideNotes = overrideNotes;

    saveUnitWithDraftFallback(allUnits.find(function(x){return x.id===unitId;})||{}).then(function(ok){
      if(!ok) showToast('Secondary unit saved locally — will sync when network is available.', { type:'info', duration:3500 });
    });
    saveApplicationWithDraftFallback(allApps[appIdx]).then(function(ok){
      if(!ok) showToast('Assignment saved locally — will sync when network is available.', { type:'info', duration:3500 });
    });
    if(typeof housingUnits!=='undefined') housingUnits.splice(0, housingUnits.length, ...allUnits);

    auditEntry(app.id, 'secondary_unit_assigned', name+' secondary unit assigned: '+addr+(moveIn?' (move-in '+moveIn+')':'')+(overrideNotes?' — '+overrideNotes:''), role);
    auditEntry(u.id,   'secondary_unit_assigned', addr+' secondary-assigned to '+name+' ('+app.id+')', role);

    closeAssignModal();
    if(typeof renderMatchView === 'function') renderMatchView();
    if(typeof renderDashTable === 'function') renderDashTable();
    if(typeof updateDashStats === 'function') updateDashStats();
    if(typeof renderWorklist  === 'function') renderWorklist();
    showToast('✓ '+name+' — secondary unit '+addr+' assigned', {type:'info'});
    return;
  }

  // ── Primary unit path ───────────────────────────────────────────────────
  // Role gate — any approved-flavour status is acceptable for assignment,
  // regardless of role. ED retains higher authority and can assign past any
  // approved state; HM can assign past their own approval. The earlier
  // strict gate blocked file_update apps (hm_approved) even when the ED
  // already had the assign authority.
  var _as = (typeof appAssignabilityStatus === 'function')
    ? appAssignabilityStatus(app, null, { forAssignment: true })
    : { ok: (app.status === APP_STATUS.ED_APPROVED || app.status === APP_STATUS.MGR_APPROVED || app.status === APP_STATUS.HM_APPROVED), reason:'Approval required before assigning' };
  if(!_as.ok){ showToast(_as.reason, {type:'info'}); return; }

  // Write unit
  var isTransferReq = (app.appType === 'transfer_request');
  u.assignedTo=app.id; u.assignedName=name; u.assignedDate=moveIn;
  // For transfer requests: mark new unit as 'reserved' not 'occupied'
  // Tenant stays in current unit until physical move
  u.status = isTransferReq ? 'reserved' : 'occupied';
  u.tenantApprovedBy=CLFN_PERMS.roleLabel(role=== ROLE.ED ? ROLE.ED : ROLE.HOUSING_MANAGER);
  u.tenantApprovedAt=today;
  if(overrideNotes) u.assignmentOverrideNotes = overrideNotes;
  if(isTransferReq) u.transferPending = true;
  allUnits[unitIdx]=u;

  // Write application
  allApps[appIdx].assignedUnit=unitId;
  allApps[appIdx].assignedAddress=addr;
  allApps[appIdx].status='assigned';
  if(isTransferReq) allApps[appIdx].transferPending = true;
  if(overrideNotes) allApps[appIdx].assignmentOverrideNotes = overrideNotes;

  saveUnitWithDraftFallback(allUnits.find(function(x){return x.id===unitId;})||{}).then(function(ok){
    if(!ok) showToast('Unit assignment saved locally — will sync when network is available.', { type:'info', duration:3500 });
  });
  saveApplicationWithDraftFallback(allApps[appIdx]).then(function(ok){
    if(!ok) showToast('Assignment saved locally — will sync when network is available.', { type:'info', duration:3500 });
  });
  // Sync in-memory housingUnits array so all views reflect the change immediately
  if(typeof housingUnits!=='undefined') housingUnits.splice(0, housingUnits.length, ...allUnits);

  // Audit
  var auditDetail = name+' assigned to '+addr+(moveIn?' (move-in '+moveIn+')':'')
    +(isEdOverride2?' — OVERRIDE: '+overrideNotes:(overrideNotes?' — Notes: '+overrideNotes:''));
  auditEntry(app.id,'unit_assigned',auditDetail,role);
  auditEntry(u.id,  'unit_assigned',addr+' assigned to '+name+' ('+app.id+')'+(isEdOverride2?' — OVERRIDE':''),role);

  closeAssignModal();
  if(typeof renderMatchView === 'function') renderMatchView();
  if(typeof renderDashTable === 'function') renderDashTable();
  if(typeof updateDashStats === 'function') updateDashStats();
  // Refresh the Home-page worklist too. Once status flips to 'assigned',
  // the row drops out of the "ED Approved" chip filter and the applicant
  // no longer surfaces in the assignment queue. Without this call the row
  // lingered until the next manual page reload.
  if(typeof renderWorklist === 'function') renderWorklist();
  showToast('✓ '+name+' assigned to '+addr+(isEdOverride2?' (override)':''), {type:'info'});

  // Hand-off: the tenant is now housed -> offer to generate the occupancy
  // agreement right away. Opening their TIC with the _ticAutoLease flag set
  // auto-opens the agreement modal, pre-filled from the application + unit.
  var _agreementHandoff = function(){
    if(typeof showConfirm === 'function' && typeof openTenantCard === 'function'){
      showConfirm({
        title:   'Assigned — generate the agreement?',
        message: escapeHtml(name) + ' is assigned to ' + escapeHtml(addr) + '. Generate the occupancy agreement now?',
        confirmText: 'Generate Agreement →', cancelText: 'Later'
      }).then(function(ok){
        if(ok){ window._ticAutoLease = 'residential_lease'; openTenantCard(u.id); }
      });
    }
  };
  // Sequential dialogs: turnover rent first (new tenancy = the only moment
  // rent changes — sitting tenants are grandfathered), then the optional
  // move-in note, then the agreement hand-off.
  var _rentOffer = (typeof offerTurnoverRent === 'function')
    ? function(){ return offerTurnoverRent(u, { context: 'assignment' }); }
    : function(){ return Promise.resolve(); };
  _rentOffer().then(function(){
    // Notify Finance to BEGIN collecting rent for this new tenancy. Fired after
    // the turnover-rent offer resolves so the rent amount reflects any
    // recalculation. Fire-and-forget; silent skip if no Finance email is set.
    if(typeof notifyFinanceRentStart === 'function'){
      var _rentVal = (u.monthlyRent != null ? u.monthlyRent : u.monthly_rent);
      var _rentStr = (_rentVal == null || _rentVal === '')
        ? ''
        : (typeof formatCurrency === 'function' ? formatCurrency(_rentVal) : ('$' + _rentVal));
      try {
        notifyFinanceRentStart({
          tenantName:  name,
          unitAddress: addr,
          moveInDate:  moveIn || today,
          rentAmount:  _rentStr,
          unitId:      u.id
        });
      } catch(e){ console.warn('[notify] finance_rent_start failed:', e); }
    }
    if(typeof promptTenantNote === 'function'){
      promptTenantNote(name, {
        title: 'Move-in note (optional)',
        message: 'Add a quick note for ' + name + ' — move-in condition, keys handed over, etc. Leave blank to skip.',
        placeholder: 'e.g. Keys handed over, unit clean, minor scuff in hallway…',
        context: 'move_in'
      }).then(_agreementHandoff);
    } else {
      _agreementHandoff();
    }
  });
}


// ══════════════════════════════════════════════════════════════
// RENO APPROVALS VIEW — HM & ED consolidated SOW queue
// ══════════════════════════════════════════════════════════════

// (RETIRED) The pre-multi-SOW reno-approvals implementation that lived here
// (_raFilter, _getRaApprovalStatus, renderRenoApprovalsView, raQuickApprove,
// exportRenoApprovalsCSV/PDF — ~300 lines) was deleted in the audit cleanup.
// renos.html defines the CURRENT per-SOW versions of all of these in its
// inline script; because renos.html loads housing-init.js FIRST, the copies
// here silently shadowed-or-were-shadowed purely by load order — the exact
// divergent-copy trap CLAUDE.md forbids. No other page has the reno-approvals
// view or its export buttons. Do not re-add page-view logic for renos here.


// ══════════════════════════════════════════════════════════════
// LOGIN — auth flow now lives in auth-login.js (loaded only by
// index.html). Other pages restore the session from sessionStorage
// via shared-auth.js; if that fails, _onLogout sends them back to
// index.html where the real sign-in screen lives.
// ══════════════════════════════════════════════════════════════

// On non-index pages an expired session should send the user back to the
// login page rather than try to reuse local sign-in markup that doesn't
// exist here.
function showLoginScreen() {
  try { window.location.href = 'index.html'; } catch(e) {}
}
// ── Global in-memory caches for Supabase data ───────────────────────────────
window._contractors   = window._contractors   || [];
window._sowCache      = window._sowCache      || {};  // keyed by unit_id
window._rfqCache      = window._rfqCache      || {};  // keyed by rfq.id
window._renoProgress  = window._renoProgress  || {};  // keyed by unit_id
window._renoBudget    = window._renoBudget    || {};  // keyed by unit_id
window._unitPhotos    = window._unitPhotos    || {};  // keyed by unit_id
window._appSettings   = window._appSettings   || {};


// ── Check for existing session on page load ────────────────────────────────
// (session restore handled by initHousing IIFE above)

// ══════════════════════════════════════════════════════════════
// STAFF MANAGEMENT — Add users from within the app
// Same pattern as expense claims app
// ══════════════════════════════════════════════════════════════

function showAddHousingStaff() {
  var isED = APPROVAL_AUTHORITY.can('manageAllStaffRoles', window.currentRole);
  var pend = window._pendingLookupUser || {};
  var prefEmail = pend.email || '';
  var isExt0 = !!pend.external && isED;   // external adds are ED-only
  var modal = document.getElementById('globalModal') || document.getElementById('approvalModal');
  // Use the existing showToast + a custom modal approach
  // Build inline modal
  var overlay = document.createElement('div');
  overlay.id = 'staffModal';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center;padding:20px;';

  var depts = ['Housing','Administration','Capital Projects & Infrastructure','Human Resources','Finance','Wellness','Medical Services','Choose Life','Ontario Works','Eagles Earth','Water Treatment Plant','Lands & Resources','Chief & Council','Band Reps'];
  var deptOptions = depts.map(function(d){ return '<option value="'+d+'">'+d+'</option>'; }).join('');
  // Role options — gated by the current user's role.
  // ED can assign any role. HM can assign only HE-L1 / HE-L2. Others shouldn't
  // reach this modal (the Add Staff button is gated earlier).
  var roleOptions = (function(){
    var perms = window.CLFN_PERMS;
    if(!perms){
      // Fallback if permissions module somehow didn't load — safe minimum.
      return '<option value="housing_employee_l1">Housing Employee L1</option>';
    }
    var all = Object.keys(perms.ROLE_LABELS);
    var allowed = isED
      ? all                                   // ED: any role
      : ['housing_employee_l1','housing_employee_l2'];  // HM: employee levels only
    return allowed.map(function(k){
      return '<option value="'+k+'">'+perms.roleLabel(k)+'</option>';
    }).join('');
  })();

  overlay.innerHTML = '<div style="background:var(--surface);border-radius:14px;width:100%;max-width:520px;box-shadow:0 24px 60px rgba(0,0,0,.5);overflow:hidden;">'
    + '<div style="background:var(--dark);border-bottom:3px solid var(--yellow);padding:16px 20px;display:flex;align-items:center;justify-content:space-between;">'
    + '<span style="font-size:15px;font-weight:700;color:#fff;">'+(isED?'Add Staff Member — ED':'Add Staff Member')+'</span>'
    + '<button onclick="closeStaffModal()" style="background:none;border:none;color:var(--muted);font-size:20px;cursor:pointer;line-height:1;">&times;</button>'
    + '</div>'
    + '<div style="padding:22px;display:flex;flex-direction:column;gap:12px;">'
    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">'
    + '<div><label style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:4px;">Full Name</label>'
    + '<input id="hs-name" placeholder="e.g. Edith Moore" style="width:100%;padding:8px 12px;border:1px solid var(--border);border-radius:7px;font-size:13px;font-family:DM Sans,sans-serif;box-sizing:border-box;"></div>'
    + '<div><label style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:4px;">Work Email</label>'
    + '<input id="hs-email" type="email" placeholder="' + (nationEmailDomain() ? ('edith.moore@' + nationEmailDomain()) : 'name@example.com') + '" value="'+escapeHtml(prefEmail)+'" style="width:100%;padding:8px 12px;border:1px solid var(--border);border-radius:7px;font-size:13px;font-family:DM Sans,sans-serif;box-sizing:border-box;">'
    + '<div id="hs-email-hint" style="display:none;font-size:11px;color:var(--danger);margin-top:3px;">&#9888; Must be a @' + nationEmailDomain() + ' address</div></div>'
    + '</div>'
    + (isED ? '<label style="display:flex;align-items:flex-start;gap:8px;font-size:12px;cursor:pointer;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px 14px;">'
        + '<input type="checkbox" id="hs-external" '+(isExt0?'checked':'')+' style="width:16px;height:16px;min-width:16px;flex:0 0 16px;margin:2px 0 0;accent-color:#2563eb;">'
        + '<span><strong>External consultant</strong> &mdash; allow ' + (nationEmailDomain() ? ('a non-@'+nationEmailDomain()) : 'an external') + ' email. The account is <strong>passwordless</strong> (admin-issued magic link only), gets a random password, and starts with restricted access. ED only.</span></label>' : '')
    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">'
    + '<div><label style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:4px;">Department</label>'
    + '<select id="hs-dept" style="width:100%;padding:8px 12px;border:1px solid var(--border);border-radius:7px;font-size:13px;font-family:DM Sans,sans-serif;box-sizing:border-box;">'+deptOptions+'</select></div>'
    + '<div><label style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:4px;">Role</label>'
    + '<select id="hs-role" style="width:100%;padding:8px 12px;border:1px solid var(--border);border-radius:7px;font-size:13px;font-family:DM Sans,sans-serif;box-sizing:border-box;">'+roleOptions+'</select></div>'
    + '</div>'
    + '<div id="hs-pwnote" style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px 14px;font-size:12px;color:var(--muted);">'
    + '&#128274; A login account is created automatically. Default password: <strong>' + (window.NATION_CONFIG && NATION_CONFIG.short || '') + ' + FirstName + 2026!</strong>'
    + '</div>'
    + '<div id="hs-result" style="display:none;border-radius:8px;padding:10px 14px;font-size:12px;"></div>'
    + '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:4px;">'
    + '<button onclick="closeStaffModal()" class="btn btn-ghost">Cancel</button>'
    + '<button id="hs-submit-btn" onclick="submitAddHousingStaff()" class="btn btn-primary">+ Add to Staff Directory</button>'
    + '</div>'
    + '</div></div>';

  document.body.appendChild(overlay);

  // Wire email hint — suppressed when "External consultant" is ticked (an
  // external email is expected there).
  var emailEl = document.getElementById('hs-email');
  if(emailEl) emailEl.addEventListener('input', function(){
    var ext = !!(document.getElementById('hs-external') && document.getElementById('hs-external').checked);
    var h = document.getElementById('hs-email-hint');
    var _d = nationEmailDomain();   // no domain configured -> no gate, no hint
    if(h) h.style.display = (_d && !ext && this.value && !this.value.endsWith('@' + _d)) ? 'block' : 'none';
  });
  // External-consultant toggle: swap the password note + clear the domain hint.
  var extEl = document.getElementById('hs-external');
  function _hsSyncExternal(){
    var ext = !!(extEl && extEl.checked);
    var pw = document.getElementById('hs-pwnote');
    if(pw){
      pw.innerHTML = ext
        ? '&#128273; Passwordless account &mdash; no password to share. After adding, click <strong>Send Sign-in Link</strong> on their row to email them a magic link, then set their features + <strong>Access Expires</strong> via Edit.'
        : '&#128274; A login account is created automatically. Default password: <strong>' + (window.NATION_CONFIG && NATION_CONFIG.short || '') + ' + FirstName + 2026!</strong>';
    }
    if(ext){ var h = document.getElementById('hs-email-hint'); if(h) h.style.display = 'none'; }
  }
  if(extEl) extEl.addEventListener('change', _hsSyncExternal);
  _hsSyncExternal();
}

function closeStaffModal() {
  var m = document.getElementById('staffModal');
  if(m) m.remove();
}

// Cryptographically random password for external consultant accounts. They never
// use it (sign-in is via admin-issued magic link only); a random password stops
// the raw Supabase token endpoint being abused with a guessable one.
function _randomStrongPassword(){
  var chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
  var out='';
  try {
    var arr=new Uint32Array(28); (window.crypto||window.msCrypto).getRandomValues(arr);
    for(var i=0;i<arr.length;i++) out+=chars.charAt(arr[i]%chars.length);
  } catch(e){
    for(var j=0;j<28;j++) out+=chars.charAt(Math.floor(Math.random()*chars.length));
  }
  return out;
}
// fetch() with a hard timeout so an add-staff step can never hang the button on
// "Adding..." forever. On timeout the promise rejects (AbortError) and the
// caller surfaces a message + re-enables the button.
function _staffFetch(url, opts, ms){
  var ac = new AbortController();
  var to = setTimeout(function(){ ac.abort(); }, ms || 20000);
  return fetch(url, Object.assign({}, opts||{}, { signal: ac.signal }))
    .then(function(r){ clearTimeout(to); return r; })
    .catch(function(e){ clearTimeout(to); throw e; });
}

async function submitAddHousingStaff() {
  var name  = ((document.getElementById('hs-name')||{}).value||'').trim();
  var email = ((document.getElementById('hs-email')||{}).value||'').trim().toLowerCase();
  var dept  = (document.getElementById('hs-dept')||{}).value||'';
  var role  = (document.getElementById('hs-role')||{}).value||'housing_employee_l1';
  var btn   = document.getElementById('hs-submit-btn');
  var res   = document.getElementById('hs-result');

  if(!name)  { showToast("Please enter the employee's full name", {type:'error'}); return; }
  if(!email||!email.includes('@')) { showToast('Please enter a valid email address', {type:'error'}); return; }
  var isExternal = !!(document.getElementById('hs-external') && document.getElementById('hs-external').checked);
  var _staffDom = nationEmailDomain();               // '' -> this nation has no domain gate
  var _staffDomain = '@' + _staffDom;
  if(isExternal){
    // External consultants are ED-only and passwordless (magic-link).
    if(!APPROVAL_AUTHORITY.can('manageAllStaffRoles', window.currentRole)){ showToast('Only the ED can add an external consultant', {type:'error'}); return; }
  } else if(_staffDom && !email.endsWith(_staffDomain)) {
    showToast('Only ' + _staffDomain + ' email addresses can be registered (tick "External consultant" for an outside email)', {type:'info'});
    return;
  }

  // Role-based add-staff gate. Only roles with manageAllStaffRoles can assign
  // anything other than HE-L1 / HE-L2. (HM is constrained to HE-L1/L2 by default.)
  if(!APPROVAL_AUTHORITY.can('manageAllStaffRoles', window.currentRole)){
    var allowedForLimited = ['housing_employee_l1','housing_employee_l2'];
    if(allowedForLimited.indexOf(role) === -1){
      showToast('Housing managers can only add Housing Employees. Only the ED can add other roles.', {type:'error'});
      return;
    }
  }

  if(btn){ btn.disabled=true; btn.textContent='Adding…'; }

  try {
    // Check staff table without filtering on is_active so we can also flag
    // deactivated records (the renderHousingUserTable view hides them, but
    // the row still exists in the DB and would 409 on insert).
    var checkR = await _staffFetch(SUPABASE_URL+'/rest/v1/staff?select=id,is_active&email=eq.'+encodeURIComponent(email),{headers:HOUSING_HEADERS});
    var existing = await checkR.json();
    // An ACTIVE duplicate stops here; a DEACTIVATED/orphaned row is REVIVED
    // instead of blocked (recreate the login + reactivate + refresh details in
    // one click). Uses UPDATE (ED-allowed) so no hard-delete is needed.
    var reviving = false, existId = null;
    if(existing && existing.length){
      var existRow = existing[0];
      if(existRow.is_active !== false){
        if(res){
          res.style.background='var(--warn-amber-bg)'; res.style.border='1px solid var(--warn-amber-border)'; res.style.color='var(--warn-amber-text)';
          res.innerHTML = '<strong>Already exists.</strong><br><span style="font-size:11px;">'+escapeHtml(email)+' is <b>already in the staff directory</b> &mdash; they\'re in the Users table, no need to add again.</span>';
          res.style.display='block';
        }
        showToast('Already in the staff directory', {type:'info'});
        if(btn){btn.disabled=false;btn.textContent='+ Add to Staff Directory';}
        return;
      }
      reviving = true; existId = existRow.id;
      if(btn){ btn.textContent='Reactivating…'; }
    }

    var firstName = name.split(' ')[0];
    // Internal staff get the recognizable default; an EXTERNAL consultant gets a
    // cryptographically random password they never use (they sign in only via an
    // admin-issued magic link). Random closes the raw-token-endpoint guess hole.
    var defaultPassword = isExternal ? _randomStrongPassword() : (nationShort()+firstName+'2026!');

    // Step 1: Create Supabase Auth account. Guard with a timeout: when a project
    // has "Confirm email" ON but no working SMTP, GoTrue STALLS here trying to
    // send the verification email, so the button hangs on "Adding..." forever.
    var _ac = new AbortController();
    var _to = setTimeout(function(){ _ac.abort(); }, 20000);
    var signupR;
    try {
      signupR = await fetch(SUPABASE_URL+'/auth/v1/signup',{
        method:'POST', headers:HOUSING_HEADERS, signal:_ac.signal,
        body:JSON.stringify({email:email, password:defaultPassword, data:{full_name:name}})
      });
    } catch(_fe) {
      clearTimeout(_to);
      if(res){
        res.style.background='var(--danger-bg)'; res.style.border='1px solid var(--danger-border)'; res.style.color='var(--danger)';
        res.innerHTML = '<strong>The sign-in account request timed out.</strong><br>'
          + '<span style="font-size:11px;">This usually means the project has <b>&ldquo;Confirm email&rdquo; ON without working SMTP</b>, so Supabase hangs trying to send the verification email. '
          + 'In this nation\'s Supabase &rarr; <b>Authentication &rarr; Sign In / Providers &rarr; Email</b>, turn <b>Confirm email OFF</b> (or configure SMTP), then try again.</span>';
        res.style.display='block';
      }
      if(btn){btn.disabled=false;btn.textContent='+ Add to Staff Directory';}
      return;
    }
    clearTimeout(_to);
    var signupData = await signupR.json();
    // Supabase /auth/v1/signup returns two different shapes depending on
    // whether "Confirm email" is enabled in the dashboard:
    //   • Confirm email OFF → { user: {...}, session: {...} }
    //   • Confirm email ON  → the user object directly at the top level
    //     (no `user` wrapper, no session — there's nothing to session into
    //     until the email is verified)
    // Recognise both shapes; otherwise a successful create-with-confirm
    // flow gets misread as a failure and the staff row never gets inserted.
    var authUserId  = (signupData.user && signupData.user.id) || signupData.id;
    var authCreated = signupR.ok && !!authUserId && !!(signupData.user ? signupData.user.email : signupData.email);
    // emailNeedsConfirmation is true when the user object indicates they
    // haven't verified yet — used to tailor the success message so the
    // admin tells the new hire to check their inbox.
    var emailNeedsConfirmation = !!(signupData.confirmation_sent_at)
        || (signupData.user && !signupData.user.email_confirmed_at && !signupData.user.confirmed_at)
        || (signupData.email_verified === false);
    // Detect "already in auth" robustly. Supabase has used several wordings
    // here over time — "already registered", "already been registered",
    // "User already registered" — plus the newer structured `code` field
    // (e.g. user_already_exists). Match any of them so we can adopt the
    // orphan auth user instead of failing.
    var sdMsg = (signupData.msg || '') + ' ' + (signupData.error_description || '') + ' ' + (signupData.error || '');
    var alreadyInAuth = signupData.code === 'user_already_exists'
                     || /already.*registered/i.test(sdMsg)
                     || /already.*exists/i.test(sdMsg);
    var signupsDisabled = signupData.code === 'signup_disabled'
                       || /signups?\s+not\s+allowed/i.test(sdMsg)
                       || /signups?\s+disabled/i.test(sdMsg);

    if(!authCreated && !alreadyInAuth) {
      // Auth failed and not an "already exists" case. Surface what Supabase
      // actually said + targeted dashboard guidance when we recognise the
      // signups-disabled error specifically (the older copy here told the
      // admin to toggle "Confirm email" — that's a different setting and
      // doesn't address this error at all).
      var errMsg = signupData.msg || signupData.error_description || signupData.error || JSON.stringify(signupData);
      if(res){
        res.style.background='var(--danger-bg)'; res.style.border='1px solid var(--danger-border)'; res.style.color='var(--danger)';
        var html = '<strong>Could not create login account.</strong><br>'
          + '<span style="font-size:11px;">'+errMsg+'</span>';
        if(signupsDisabled){
          html += '<br><br>To fix: in the <strong>Supabase dashboard → Authentication → Sign In / Providers → Email</strong>, '
                + 'turn <strong>ON</strong> "<strong>Allow new users to sign up</strong>" and Save. Then try again.';
        }
        res.innerHTML = html;
        res.style.display='block';
      }
      if(btn){btn.disabled=false;btn.textContent='+ Add to Staff Directory';}
      return;
    }

    // Step 2: staff table. INSERT a new row, or (revive) PATCH the existing
    // deactivated row back to active + refresh its details. Manager = whoever is
    // adding (the signed-in HM/ED), else the nation mailbox -- never a hardcoded
    // CLFN admin (OCAP).
    var _mgr = ((typeof HOUSING_SESSION!=='undefined' && HOUSING_SESSION && HOUSING_SESSION.email) || (window.NATION_CONFIG && NATION_CONFIG.housing_email) || '');
    var staffR;
    if(reviving){
      staffR = await _staffFetch(SUPABASE_URL+'/rest/v1/staff?id=eq.'+encodeURIComponent(existId),{
        method:'PATCH', headers:Object.assign({},HOUSING_HEADERS,{'Prefer':'return=minimal'}),
        body:JSON.stringify({name:name, role:role, department:dept, is_active:true, manager_email:_mgr})
      });
    } else {
      staffR = await _staffFetch(SUPABASE_URL+'/rest/v1/staff',{
        method:'POST', headers:Object.assign({},HOUSING_HEADERS,{'Prefer':'return=minimal'}),
        body:JSON.stringify({name:name, email:email, role:role, department:dept, is_active:true, manager_email:_mgr})
      });
    }

    if(!staffR.ok){
      var staffErr = await staffR.text();
      if(res){
        res.style.background='var(--danger-bg)'; res.style.border='1px solid var(--danger-border)'; res.style.color='var(--danger)';
        res.innerHTML = '<strong>Auth account ready but the staff record '+(reviving?'update':'insert')+' failed.</strong><br><span style="font-size:11px;">'+escapeHtml(staffErr)+'</span>';
        res.style.display='block';
      }
      if(btn){btn.disabled=false;btn.textContent='+ Add to Staff Directory';}
      return;
    }

    // External consultant: enable passwordless magic-link sign-in + restrict to
    // the least-privilege consultant feature set. Best-effort PATCH so a missing
    // column (migration not yet run) can't orphan the just-created auth user.
    if(isExternal){
      try {
        await fetch(SUPABASE_URL+'/rest/v1/staff?email=eq.'+encodeURIComponent(email), {
          method:'PATCH',
          headers:Object.assign({},HOUSING_HEADERS,{'Prefer':'return=minimal'}),
          body:JSON.stringify({ magic_link:true, feature_access:['inventory','renovations','maintenance_requests','rfq','contractors'] })
        });
      } catch(e){ console.warn('[external-consultant] magic_link/feature_access PATCH failed — run the migrations', e); }
      if(typeof auditEntry==='function') auditEntry('SETTINGS','settings_user_add_external','External consultant added: '+email, window.currentRole||'ed');
    }

    // Both succeeded. When we adopted an existing auth user (alreadyInAuth)
    // we don't know their current password, so suppress the default-password
    // hint and tell the admin to use Send Reset on the row instead.
    if(res){
      res.style.background='var(--success-bg)'; res.style.border='1px solid var(--success-border)'; res.style.color='var(--success)';
      var head = '<strong>&#10003; '+escapeHtml(name)+(reviving?' reactivated':' added')+' successfully!</strong><br>'
        + (reviving ? '<span style="font-size:11px;opacity:.8;">This deactivated record was reactivated and its login re-created.</span><br>' : '')
        + 'Email: <code style="background:var(--success-border);padding:2px 6px;border-radius:4px;">'+escapeHtml(email)+'</code><br>';
      if(alreadyInAuth) {
        res.innerHTML = head
          + '<span style="font-size:11px;opacity:.8;">A login account for this email already existed — it has been linked to the new staff record. Use <strong>Send Reset</strong> on their row to issue a fresh password.</span>';
      } else if(isExternal) {
        res.innerHTML = head
          + '<span style="font-size:11px;opacity:.8;">External consultant account created — <strong>passwordless</strong>. Click <strong>Send Sign-in Link</strong> on their row to email them a magic link, then set their <strong>Access Expires</strong> via Edit. Access is restricted to Inventory / Renovations / Maintenance Requests / RFQ / Contractors.</span>';
      } else {
        var pwLine = 'Password: <code style="background:var(--success-border);padding:2px 6px;border-radius:4px;font-weight:700;">'+escapeHtml(defaultPassword)+'</code><br>';
        var tailLine = emailNeedsConfirmation
          ? '<span style="font-size:11px;opacity:.8;">A verification email was sent to <code>'+escapeHtml(email)+'</code>. They must click that link <em>before</em> the password above will work.</span>'
          : '<span style="font-size:11px;opacity:.8;">Share these credentials directly. They can change their password after signing in.</span>';
        res.innerHTML = head + pwLine + tailLine;
      }
      res.style.display='block';
      showToast('\u2713 '+name+' added successfully', {type:'info'});
    }

    // Branded welcome email via the nation's OWN provider (Graph/Resend) --
    // reliable and independent of Supabase's built-in SMTP. Best-effort. External
    // consultants get a magic link instead (via "Send Sign-in Link"), so skip
    // them; and skip when we adopted an existing auth user (password unknown).
    if(!isExternal && !alreadyInAuth && typeof sendNotification==='function'){
      try {
        var _portal = (window.NATION_CONFIG && NATION_CONFIG.portal_base) || location.origin;
        var _nname  = (window.NATION_CONFIG && (NATION_CONFIG.display_name||NATION_CONFIG.short)) || 'Housing';
        sendNotification({
          to: email, to_name: name,
          subject: 'Your ' + _nname + ' Housing account is ready',
          html: '<p>Hello ' + escapeHtml(name) + ',</p>'
            + '<p>An account has been created for you in the ' + escapeHtml(_nname) + ' Housing app.</p>'
            + '<p><b>Sign in:</b> <a href="' + escapeHtml(_portal) + '">' + escapeHtml(_portal) + '</a><br>'
            + '<b>Email:</b> ' + escapeHtml(email) + '<br>'
            + '<b>Temporary password:</b> ' + escapeHtml(defaultPassword) + '</p>'
            + '<p>Please sign in and change your password from Settings after your first login.</p>'
        });
        if(typeof auditEntry==='function') auditEntry('SETTINGS','staff_welcome_email','Welcome email sent to '+email, window.currentRole||'ed');
      } catch(_we){ console.warn('[add-staff] welcome email failed', _we); }
    }

    // Refresh user table if visible
    if(true) renderHousingUserTable();
    if(btn) btn.style.display='none';

  } catch(e) {
    var timedOut = e && (e.name === 'AbortError' || /abort/i.test(e.message||''));
    var emsg = timedOut
      ? 'A request timed out. This usually means a slow/blocked connection or a Supabase Auth misconfiguration. Check your connection and try again; if it persists, open the browser console and share the error.'
      : ('Error: ' + (e && e.message || e));
    if(res){
      res.style.background='var(--danger-bg)'; res.style.border='1px solid var(--danger-border)'; res.style.color='var(--danger)';
      res.innerHTML = '<strong>Could not add the staff member.</strong><br><span style="font-size:11px;">'+escapeHtml(emsg)+'</span>';
      res.style.display='block';
    }
    showToast(timedOut ? 'Add staff timed out — try again' : ('Error: '+(e&&e.message||e)), {type:'error'});
    if(btn){btn.disabled=false;btn.textContent='+ Add to Staff Directory';}
  }
}












// reconcileAssignments — repairs assignment-side drift between housing_units
// and housing_applications. Run after both arrays are loaded. For every unit
// that has assignedTo set, ensure the matching application's assignedUnit /
// assignedAddress / status / assignedAt fields agree. Persists fixes back to
// Supabase so the drift is fixed permanently.
//
// Drift sources:
//   - Old saveUnitEdit (pre-2026-05-04) saved unit.assignedTo + application.assignedUnit
//     but did not flip application.status to 'assigned'. Tenants stuck in
//     ed_approved show up in the Match queue with an Assign button.
//   - In rare cases (failed network call), one side persisted and the other
//     didn't. Re-syncing is a safe no-op when both sides agree.
function reconcileAssignments(){
  if(typeof housingUnits === 'undefined' || typeof applications === 'undefined') return;
  if(!housingUnits.length || !applications.length) return;
  var fixed = 0;
  housingUnits.forEach(function(u){
    if(!u || u.archived) return;
    if(!u.assignedTo) return;
    var app = applications.find(function(a){ return a && a.id === u.assignedTo; });
    if(!app) return;
    var addr = ((u.num||'')+' '+(u.street||'')).trim();
    var changed = false;
    if(app.assignedUnit !== u.id){      app.assignedUnit    = u.id;  changed = true; }
    if(app.assignedAddress !== addr){    app.assignedAddress = addr;  changed = true; }
    if(app.status !== APP_STATUS.ASSIGNED){
      app.status   = APP_STATUS.ASSIGNED;
      app.assignedAt = app.assignedAt || (u.assignedDate || new Date().toISOString());
      changed = true;
    }
    if(changed){
      fixed++;
      if(typeof saveApplicationWithDraftFallback === 'function'){
        saveApplicationWithDraftFallback(app);
      } else if(typeof sbSaveApplication === 'function'){
        sbSaveApplication(app).catch(function(e){ console.warn('[reconcile] save app failed:', e); });
      }
    }
  });
  // ── Reverse pass: unlink stale "assigned" apps ──────────────────────────
  // An application that still claims a unit (status assigned or assignedUnit set)
  // but that NO live unit links to (no unit.assignedTo === app.id) is no longer
  // housed. Clear its tenancy and revert its status so it returns to the active
  // waitlist / New Applications. (Declined apps are left alone.)
  var linkedIds = {};
  housingUnits.forEach(function(u){ if(u && !u.archived && u.assignedTo) linkedIds[u.assignedTo] = true; });
  applications.forEach(function(a){
    if(!a || a.archived) return;
    if(a.status === 'declined') return;
    var claimsUnit = (a.status === APP_STATUS.ASSIGNED) || !!a.assignedUnit;
    if(!claimsUnit) return;
    if(linkedIds[a.id]) return;                 // genuinely linked to a live unit — keep
    a.assignedUnit    = '';
    a.assignedAddress = '';
    if(a.status === APP_STATUS.ASSIGNED) a.status = APP_STATUS.ED_APPROVED;  // un-housed -> back on the list
    fixed++;
    if(typeof auditEntry === 'function'){ try { auditEntry(a.id, 'status_change', 'Unlinked from unit (no live tenancy) — returned to active application', 'system'); } catch(_e){} }
    if(typeof saveApplicationWithDraftFallback === 'function') saveApplicationWithDraftFallback(a);
    else if(typeof sbSaveApplication === 'function') sbSaveApplication(a).catch(function(e){ console.warn('[reconcile] reverse save failed:', e); });
  });
  if(fixed){
    console.info('[CLFN] Reconciled assignment drift on '+fixed+' application(s).');
  }
}

async function loadHousingData() {
  try {
    var appsData = await sbLoadApplications();
    if(appsData) applications = appsData;
    var unitsData = await sbLoadUnits();
    if(unitsData) housingUnits = unitsData;
    if(typeof reconcileAssignments === 'function') reconcileAssignments();
    var cR = await sbLoadContractors(); if(cR) window._contractors = cR;
    var sowR = await fetch(SUPABASE_URL+'/rest/v1/housing_sow?select=*',{headers:HOUSING_HEADERS});
    if(sowR.ok){var sd=await sowR.json(); sd.forEach(function(r){window._sowCache[r.unit_id]=r.data;});}
    var rfqR = await fetch(SUPABASE_URL+'/rest/v1/housing_rfq?select=*&order=created_at.desc',{headers:HOUSING_HEADERS});
    if(rfqR.ok){var rd=await rfqR.json(); window._rfqCache={}; rd.forEach(function(r){window._rfqCache[r.id]=r;});}
    // One-shot repair of duplicate SOW project numbers (the pre-fix generator
    // rolled over at 100 and minted repeated 'SOW-YYYY-00's). Management only;
    // needs both the SOW and RFQ caches above (RFQ links get re-pointed).
    if(typeof reconcileSowNumbers === 'function'){ try { reconcileSowNumbers(); } catch(e){ console.warn('[boot] sow renumber threw:', e); } }
    if(typeof sbLoadBcrRegistry === 'function'){ try { await sbLoadBcrRegistry(); } catch(e){} }
    // Tenant-reported maintenance requests + portal application submissions
    // (review queues) — management only.
    if(typeof ROLE !== 'undefined' && ROLE.isManagement && ROLE.isManagement(window.currentRole)){
      if(typeof sbLoadTenantMrSubmissions === 'function'){ try { await sbLoadTenantMrSubmissions(); } catch(e){} }
      if(typeof sbLoadApplicationSubmissions === 'function'){ try { await sbLoadApplicationSubmissions(); } catch(e){} }
    }
    var stR = await fetch(SUPABASE_URL+'/rest/v1/housing_settings?select=key,value',{headers:HOUSING_HEADERS});
    if(stR.ok){var stD=await stR.json(); window._appSettings={};
      stD.forEach(function(r){window._appSettings[r.key]=r.value;});
      if(typeof _flattenLegacyAppSettings === 'function') _flattenLegacyAppSettings();
      if(window._appSettings['scoring_model_v2']) {
        window.liveV2ScoreModel = window._appSettings['scoring_model_v2'];
        // Fill in criteria added to the defaults AFTER this model was saved
        // (e.g. urgent_need.temporary_shelter) so new categories score their
        // default points instead of silently falling back to zero. Only
        // absent keys are filled — saved values are never overridden.
        try {
          var _dm = window.DEFAULT_V2_SCORE_MODEL || {};
          Object.keys(_dm).forEach(function(sec){
            if(typeof _dm[sec] !== 'object' || _dm[sec] === null) return;
            window.liveV2ScoreModel[sec] = window.liveV2ScoreModel[sec] || {};
            Object.keys(_dm[sec]).forEach(function(k){
              if(window.liveV2ScoreModel[sec][k] === undefined) window.liveV2ScoreModel[sec][k] = _dm[sec][k];
            });
          });
        } catch(e){}
      }
      // Also hydrate liveScoreModel (V1 array format) used by buildV2FormSelects dropdowns
      var _sm = window._appSettings['scoring_model_v2'] || window._appSettings['scoring_model'];
      if(_sm && Array.isArray(_sm) && _sm.length) window.liveScoreModel = _sm;
      // Merge (not replace) over defaults so a model saved before a new bonus
      // was added (e.g. hasMatchBonus) still gets that key instead of undefined.
      if(window._appSettings['match_priority_model']) window.liveMatchPriorityModel=Object.assign({}, DEFAULT_MATCH_PRIORITY_MODEL, window._appSettings['match_priority_model']);
    }
    // Apply theme + nation-name overrides + required-field config now that
    // _appSettings is hydrated. Sub-pages (inventory / match / renos /
    // contractors / tenants) call loadHousingData on boot — without these
    // the shared header (rendered by renderAppHeader) keeps the build-time
    // default logo and "Constance Lake" placeholder strings instead of the
    // customer-saved values from Settings → Admin → Themes / Nation.
    // _applyTheme rewrites every img.hlogo src; applyBrandingToHeader (called
    // from inside applyNationOverrides) updates [data-nation*] text nodes.
    // Base theme from the platform registry (per-nation brand colour + logo set
    // in the admin portal), with the nation's own saved Themes-tab settings
    // layered on top so a local customisation still wins. This is what makes a
    // freshly-provisioned nation show its own colour/logo before the ED has
    // touched Settings -- instead of the CLFN default accent + logo.
    if (typeof _applyTheme === 'function') {
      var _regTheme = {};
      var _nc = window.NATION_CONFIG || {};
      if (_nc.primary_color) _regTheme.yellow = _nc.primary_color;
      if (_nc.logo)          _regTheme.logo   = _nc.logo;
      _applyTheme(Object.assign(_regTheme, (window._appSettings||{}).theme || {}));
    }
    if (typeof applyNationOverrides === 'function')  applyNationOverrides();
    if (typeof applyRequiredFields === 'function')   applyRequiredFields();
    if (typeof initApprovalAuthority === 'function') initApprovalAuthority();
    if (typeof initModuleEnablement === 'function')  initModuleEnablement();
    _syncAIHeaderBtn();
    if(applications.length && typeof rescoreAllApplications==='function') rescoreAllApplications();
    if (window.CLFN_DEBUG) console.log('[CLFN] Loaded '+applications.length+' apps, '+housingUnits.length+' units');
  } catch(e){ console.warn('[HOUSING] data load error:',e); console.warn('[CLFN] Could not load data'); }
}


function initHousingPage() {
  // Show sidebar nav for HM/ED
  
  // Show settings button for HM/ED
  var settingsBtn = document.getElementById('tab_settings_btn');

  // Apply role-based visibility
  var role = window.currentRole || 'housing_employee_l1';
  if(settingsBtn) settingsBtn.style.display = (ROLE.isManagement(role)) ? '' : 'none';
  document.querySelectorAll('.hm-ed-only').forEach(function(e){
    e.style.display=(ROLE.isManagement(role))?'':'none';
  });
  document.querySelectorAll('.ed-only').forEach(function(e){
    e.style.display=APPROVAL_AUTHORITY.can('editApprovalAuthority', role)?'':'none';
  });
  // (Step-progress pills carry state dots, not numbers — the old boot-time
  // renumbering pass is gone; goTo() computes states from visible pills.)

  // Wizard selects that render from shared registries.
  if (typeof _populateLivingSituationSelect === 'function') _populateLivingSituationSelect();

  // Update header
  updateHeaderUser(role);
  // Re-render the header nav + role-vis pass now that the resolved role is in.
  // _onSwitchRole is suppressed during boot, so do it directly here.
  if(typeof renderHeaderNav      === 'function') renderHeaderNav();
  if(typeof applyRoleVisibility  === 'function') applyRoleVisibility(role);
  if(typeof _renderWorklistCountPills === 'function') _renderWorklistCountPills();

  // Navigate to requested view from URL param
  var params = new URLSearchParams(window.location.search);
  // ?openScorecard=APP_ID — open scorecard/approval view directly (worklist Review button)
  var openScorecardId = params.get('openScorecard');
  if(openScorecardId){
    var _scApp = (typeof applications !== 'undefined' ? applications : []).find(function(a){ return a.id === openScorecardId; });
    if(_scApp && typeof showScorecard === 'function'){ showScorecard(_scApp); return; }
  }
  // ?openApp=APP_ID — cross-page handoff (e.g. from match.html applicant click)
  var openAppId = params.get('openApp');
  if(openAppId){
    console.log('[boot] openApp param detected:', openAppId, '| openEditModal type:', typeof window.openEditModal);
    if(typeof window.openEditModal === 'function'){
      window.openEditModal(openAppId);
      return;
    }
    console.warn('[boot] openEditModal not loaded — falling through to default view');
  }
  // Landing is the default for housing.html — old worklistView + employeeHomeView
  // collapsed into landingView. Sub-pages still default to their own views.
  var defaultView = document.getElementById('landingView') ? 'home' : 'dashboard';
  var view = params.get('view') || defaultView;
  if(view==='home')             { if(typeof showLanding==='function') showLanding(); else if(typeof showEmployeeHome==='function') showEmployeeHome(); }
  else if(view==='newapp')      { if(typeof newApp==='function') newApp(); }
  else if(view==='worklist')    { if(true) showWorklist(); }
  else if(view==='inventory')   { if(true) showInventory(); }
  else if(view==='match')       { if(true) showMatch(); }
  else if(view==='tenants')     { if(true) showTenants(); }
  else if(view==='settings')    { if(typeof showSettings==='function') showSettings(); }
  else if(view==='leadership')  { if(typeof showLeadershipDashboard==='function') showLeadershipDashboard(); }
  // Data Health deep links (Operations nav on sub-pages lands here): show the
  // landing page, then open the tool once the data it reads has loaded.
  else if(view==='reconcile' || view==='likely-housed' || view==='archived-apps' || view==='ar-import'){
    if(typeof showLanding==='function') showLanding();
    var _dhOpen = view==='reconcile' ? 'showReconcileReport' : view==='likely-housed' ? 'showLikelyHousedReport' : view==='ar-import' ? 'openArrearsImport' : 'showArchivedApplications';
    var _dhTries = 0;
    (function _dhWait(){
      var ready = (window.applications && applications.length) || (window.housingUnits && housingUnits.length) || _dhTries >= 20;
      if(ready){ if(typeof window[_dhOpen]==='function') window[_dhOpen](); return; }
      _dhTries++; setTimeout(_dhWait, 400);
    })();
  }
  else if(view==='contractors') { if(true) showContractors(); }
  else {
    // Fallback when view doesn't match any branch. The Applications
    // dashboard (#dashView) was retired, so every role now lands on the
    // worklist-based landing page instead.
    if (typeof showLanding === 'function') showLanding();
    else if (typeof showEmployeeHome === 'function') showEmployeeHome();
    else if (typeof showWorklist === 'function') showWorklist();
  }
}

// ══════════════════════════════════════════════════════
// LANDING PAGE WIRING (Stop B) — header nav, role-vis,
// quick lookup, sections, quick actions, deep-links
// ══════════════════════════════════════════════════════
function renderAppHeader(){
  var host = document.getElementById('app_header_host');
  if(!host) return;
  if(host.getAttribute('data-rendered') === '1') return; // idempotent
  // Prefer sessionStorage-cached logo (set by _applyTheme after settings load)
  // to avoid flashing the build-time fallback on page navigation.
  var _logoSrc = (function(){
    try {
      var c = sessionStorage.getItem('clfn_logo_cache');
      if (c) return c;
    } catch(e) {}
    // This nation's own logo, else the Home Land Homes platform default. CLFN's
    // mark is only ever CLFN's own (set on its directory entry), never a fallback
    // for other nations.
    var _regLogo = (window.NATION_CONFIG && window.NATION_CONFIG.logo) || '';
    return _regLogo || window.HLH_LOGO_DATA_URL || window.CLFN_LOGO_DATA_URL || '';
  })();
  var _logoTransparent = (function(){
    try { return sessionStorage.getItem('clfn_logo_transparent') === '1'; } catch(e) { return false; }
  })();
  host.outerHTML = ''
    + '<header class="app-header app-header-v2">'
    +   '<div class="hbrand" id="app_hbrand" title="Return to Home">'
    +     '<img src="'+_logoSrc+'" alt="" class="hlogo hlogo-v2'+(_logoTransparent?' logo-transparent':'')+'" />'
    +     '<div>'
    +       '<strong class="hbrand-title"><span data-nation="short">'+(window.NATION_CONFIG&&NATION_CONFIG.short||'')+'</span> Housing</strong>'
    +       '<span class="hbrand-sub" data-nation="display_name">Constance Lake First Nation</span>'
    +     '</div>'
    +   '</div>'
    +   '<button class="nav-toggle" id="nav_toggle" aria-label="Toggle navigation">'
    +     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>'
    +   '</button>'
    +   '<nav class="app-nav" id="app_nav"></nav>'
    +   '<div class="header-actions">'
    +     '<div class="export-wrap" id="header_export_wrap_v2" style="display:none;">'
    +       '<button id="header_export_btn_v2" class="btn-export-v2" type="button">'
    +         '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>'
    +         '<span>Export</span>'
    +         '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>'
    +       '</button>'
    +       '<div class="export-menu-v2" id="header_export_menu_v2" role="menu">'
    +         '<button class="export-menu-item-v2" data-export="csv"><span>CSV</span></button>'
    +         '<button class="export-menu-item-v2" data-export="excel"><span>Excel (.xlsx)</span></button>'
    +         '<button class="export-menu-item-v2" data-export="pdf"><span>PDF</span></button>'
    +       '</div>'
    +     '</div>'
    +     '<button id="header_settings_btn" class="header-settings" data-roles="ed,housing_manager,super_user">'
    +       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>'
    +       '<span>Settings</span>'
    +     '</button>'
    +     '<button id="header_ai_btn" class="header-settings" onclick="toggleAIChat()" title="AI Assistant">'
    +       '<span class="ai-ico" style="color:var(--yellow);font-size:15px;line-height:1;">✦</span>'
    +       '<span>AI</span>'
    +     '</button>'
    +     '<div class="create-wrap">'
    +       '<button class="btn-create" id="header_create_btn" type="button">'
    +         '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>'
    +         '<span class="btn-create-label">Create</span>'
    +         '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>'
    +       '</button>'
    +       '<div class="create-menu" id="create_menu" role="menu">'
    +         '<button class="create-menu-item" data-create="application"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/></svg> New Application <span class="role-gate">All</span></button>'
    +         '<button class="create-menu-item" data-create="unit" data-roles="ed,housing_manager,super_user"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12l9-9 9 9"/><path d="M5 10v10h14V10"/></svg> New Unit <span class="role-gate">ED &middot; HM &middot; SU</span></button>'
    +         '<button class="create-menu-item" data-create="contractor"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg> New Contractor</button>'
    +         '<button class="create-menu-item" data-create="tenant" data-roles="ed,housing_manager,housing_employee_l2"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg> New Tenant <span class="role-gate">ED &middot; HM &middot; L2</span></button>'
    +       '</div>'
    +     '</div>'
    +     '<div class="avatar-wrap" id="header_user_pill" title="Account">'
    +       '<div id="header_avatar" class="header-avatar">&mdash;</div>'
    +       '<span id="header_role_badge" class="avatar-role-pill">&mdash;</span>'
    +       '<span id="header_user_name" class="visually-hidden"></span>'
    +     '</div>'
    +   '</div>'
    + '</header>';
  // Mark home click — bounce to housing.html on sub-pages, in-page showLanding on housing.html
  var hb = document.getElementById('app_hbrand');
  if(hb){
    hb.addEventListener('click', function(){
      if(typeof showLanding === 'function' && document.getElementById('landingView')) showLanding();
      else window.location.href = 'housing.html';
    });
  }
  // Apply nation branding now that markup exists.
  if(typeof applyBrandingToHeader === 'function') applyBrandingToHeader();
}

// Show or hide the AI header button based on the ai_assistant module state.
// Called after initModuleEnablement() and from _onModuleToggle.
function _syncAIHeaderBtn() {
  var btn = document.getElementById('header_ai_btn');
  if (!btn) return;
  var on = window.CLFN_MODULES && CLFN_MODULES.isEnabled('ai_assistant');
  btn.style.display = on ? 'flex' : 'none';
}

// HEADER_NAV — single source of truth for the primary nav strip.
// Each entry: { key, label, svg, run, module?, drawerOnly? }
//   key        — data-nav attribute (matches landingView active marking)
//   module     — optional CLFN_MODULES key; tab is omitted if not enabled
//   drawerOnly — only shown inside the hamburger drawer (≤1200px)
//   run        — function called on click (returns nothing)
window.HEADER_NAV = [
  { key:'home',         label:'Home',         module:null,           svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12l9-9 9 9"/><path d="M5 10v10h14V10"/></svg>',                                                                                                                                                                                                                run:function(){ if(document.getElementById('landingView') && typeof showLanding==='function') showLanding(); else if(document.getElementById('landingView') && typeof showEmployeeHome==='function') showEmployeeHome(); else window.location.href='housing.html'; } },
  { key:'inventory',    label:'Inventory',    module:'inventory',    svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>',                                                                                                                                            run:function(){ if(typeof showInventory==='function') showInventory(); else window.location.href='inventory.html'; } },
  { key:'match',        label:'Match',        module:'match',        svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',                                                                                                                       run:function(){ if(typeof showMatch==='function') showMatch(); else window.location.href='match.html'; } },
  { key:'leadership',   label:'Reports',      module:null,           authority:'accessLeadershipDashboard', svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>',                                                                                                       run:function(){ if(typeof showLeadershipDashboard==='function') showLeadershipDashboard(); else window.location.href='housing.html?view=leadership'; } },
  { key:'operations', label:'Operations', isGroup:true,
    svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>',
    children: [
      { key:'renovations', label:'Renovations', module:'renovations', svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>', run:function(){ if(typeof showRenos==='function') showRenos(); else window.location.href='renos.html'; } },
      { key:'rfq',         label:'RFQ',         module:'renovations', svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="12" y2="17"/></svg>', run:function(){ window.location.href='rfq.html'; } },
      { key:'contractors', label:'Contractors', module:'contractors',  svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>', run:function(){ if(typeof showContractorsForRole==='function') showContractorsForRole(); else if(typeof showContractors==='function') showContractors(); else window.location.href='contractors.html'; } },
      { key:'inspections', label:'Inspections', module:'inspections',  svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>', run:function(){ window.location.href='inspections.html'; } },
      { key:'projects',    label:'Projects',    module:'projects',     svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 21h18"/><path d="M5 21V7l7-4 7 4v14"/><path d="M9 21v-6h6v6"/></svg>', run:function(){ window.location.href='projects.html'; } },
      // ── Data Health — compliance / cleanup tools (moved from Quick Actions).
      // Management-only visibility (data-roles); each opener re-checks its own
      // gate. run functions are serialized into inline onclick strings, so
      // they must be self-contained: call the opener when this page has it
      // (housing.html), else deep-link via ?view= (handled at boot).
      { divider:true, label:'Data Health', roles:'ed,housing_manager,super_user' },
      { key:'dh_likely',    label:'Likely Already-Housed',   module:null, roles:'ed,housing_manager,super_user', svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9.5L12 3l9 6.5"/><path d="M5 10v10h14V10"/><path d="M9 21v-6h6v6"/></svg>', run:function(){ if(typeof showLikelyHousedReport==='function') showLikelyHousedReport(); else window.location.href='housing.html?view=likely-housed'; } },
      { key:'dh_reconcile', label:'Reconcile Units & Apps',  module:null, roles:'ed,housing_manager,super_user', svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>', run:function(){ if(typeof showReconcileReport==='function') showReconcileReport(); else window.location.href='housing.html?view=reconcile'; } },
      { key:'dh_arimport',  label:'Import Arrears Ledger',    module:null, roles:'ed,housing_manager,super_user', svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>', run:function(){ if(typeof openArrearsImport==='function') openArrearsImport(); else window.location.href='housing.html?view=ar-import'; } },
      { key:'dh_archived',  label:'Archived Applications',   module:null, roles:'ed,housing_manager,super_user', svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 8v13H3V8"/><path d="M1 3h22v5H1z"/><path d="M10 12h4"/></svg>', run:function(){ if(typeof showArchivedApplications==='function') showArchivedApplications(); else window.location.href='housing.html?view=archived-apps'; } },
    ]
  },
  { key:'tenants',      label:'Tenants',      module:'tenants',      svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',                                                                                                       run:function(){ if(typeof showTenants==='function') showTenants(); else window.location.href='tenants.html'; } },
  { key:'finance',      label:'Finance',      module:'finance',      roles:'ed,cfo,finance_l1,super_user', svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',                                                                                                                                                               run:function(){ if(typeof showFinance==='function') showFinance(); else window.location.href='finance.html'; } },
  { key:'settings',     label:'Settings',     module:null,           drawerOnly:true, roles:'ed,housing_manager,super_user', svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>', run:function(){ if(typeof showSettings==='function') showSettings(); else window.location.href='housing.html?view=settings'; } }
];

// renderHeaderNav — rebuilds #app_nav from HEADER_NAV. Skips items whose
// module is disabled. data-roles is only honoured for drawer-only items
// here; in-strip items use module gating + applyRoleVisibility().
function renderHeaderNav(){
  var nav = document.getElementById('app_nav');
  if(!nav) return;
  var html = '';
  var hadDivider = false;
  // Per-user Feature Access: hide a nav entry whose function this user isn't
  // granted. canUseFeature() returns true when the user has no explicit list,
  // so unrestricted users are unaffected. data-feature is also emitted so the
  // post-resolve applyRoleVisibility() pass re-hides if the list loads later.
  function _navFeatDenied(key){
    return key && window.FEATURE_KEYS && FEATURE_KEYS.indexOf(key) !== -1 &&
           typeof window.canUseFeature === 'function' && !window.canUseFeature(key);
  }
  function _featAttr(key){
    return (key && window.FEATURE_KEYS && FEATURE_KEYS.indexOf(key) !== -1) ? ' data-feature="'+key+'"' : '';
  }
  HEADER_NAV.forEach(function(item){
    if(item.module && window.CLFN_MODULES && !CLFN_MODULES.isEnabled(item.module)) return;
    if(_navFeatDenied(item.key)) return;
    if(item.drawerOnly && !hadDivider){
      html += '<div class="nav-divider"></div>';
      hadDivider = true;
    }
    if(item.isGroup && item.children){
      // Filter children by module enablement + per-user feature access
      var visibleChildren = item.children.filter(function(c){
        if(c.divider) return true;
        return (!c.module || !window.CLFN_MODULES || CLFN_MODULES.isEnabled(c.module)) && !_navFeatDenied(c.key);
      });
      if(!visibleChildren.some(function(c){ return !c.divider; })) return;
      var dropItems = visibleChildren.map(function(c){
        // Section divider inside a dropdown (e.g. Operations > Data Health).
        // Carries its own roles (declared on the divider entry, like items)
        // so a role that can't see the section's tools doesn't see a lone
        // heading either — and a future differently-gated section works.
        if(c.divider){
          var dvRoles = c.roles ? ' data-roles="'+c.roles+'"' : '';
          return '<div class="nav-dropdown-sect"'+dvRoles+' style="border-top:1px solid var(--border);margin:6px 0 2px;padding:6px 14px 2px;font-size:10px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--muted);">'+(c.label||'')+'</div>';
        }
        var rolesAttr = c.roles ? ' data-roles="'+c.roles+'"' : '';
        return '<button class="nav-dropdown-item" data-nav="'+c.key+'"'+_featAttr(c.key)+rolesAttr+' onclick="('+c.run.toString()+')();closeNavDropdowns()">'+c.svg+' '+c.label+'</button>';
      }).join('');
      html += '<div class="nav-group" data-group="'+item.key+'">'
            + '<button class="app-nav-item nav-group-toggle" data-nav="'+item.key+'" onclick="toggleNavGroup(\''+item.key+'\')">'
            + item.svg+' '+item.label
            + '<svg class="nav-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="12" height="12"><polyline points="6 9 12 15 18 9"/></svg>'
            + '</button>'
            + '<div class="nav-dropdown" id="navdrop_'+item.key+'">'+dropItems+'</div>'
            + '</div>';
    } else {
      var cls = 'app-nav-item' + (item.drawerOnly ? ' in-drawer-only' : '');
      // Configurable access: derive data-roles from the live approval authority
      // so Settings > Approval Authority controls who sees this nav item.
      var roleList = item.roles || '';
      if(item.authority && window.APPROVAL_AUTHORITY && typeof APPROVAL_AUTHORITY.get==='function'){
        var ar = APPROVAL_AUTHORITY.get(item.authority);
        if(Array.isArray(ar)){
          var rr = ar.slice();
          if(rr.indexOf('ed')!==-1 && rr.indexOf('super_user')===-1) rr.push('super_user'); // ED tier
          roleList = rr.join(',');
        }
      }
      var roles = roleList ? ' data-roles="'+roleList+'"' : '';
      html += '<button class="'+cls+'" data-nav="'+item.key+'"'+roles+_featAttr(item.key)+'>'+item.svg+' '+item.label+'</button>';
    }
  });
  nav.innerHTML = html;
  // Wire flat nav buttons (non-group items)
  nav.querySelectorAll('.app-nav-item:not(.nav-group-toggle)').forEach(function(btn){
    var key = btn.getAttribute('data-nav');
    var item = HEADER_NAV.find(function(n){ return n.key === key; });
    if(item && item.run) btn.addEventListener('click', item.run);
  });
  setHeaderNavActive(_currentNavKey());
}

function toggleNavGroup(groupKey){
  var drop = document.getElementById('navdrop_'+groupKey);
  if(!drop) return;
  var grp = drop.closest('.nav-group');
  var open = drop.classList.toggle('open');
  if(grp) grp.classList.toggle('group-open', open);
  if(open){
    document.addEventListener('click', _navGroupOutsideClick, { once: true, capture: true });
  }
}

function closeNavDropdowns(){
  document.querySelectorAll('.nav-dropdown.open').forEach(function(d){
    d.classList.remove('open');
    var grp = d.closest('.nav-group');
    if(grp) grp.classList.remove('group-open');
  });
}

function _navGroupOutsideClick(e){
  if(!e.target.closest('.nav-group')) closeNavDropdowns();
}

// _currentNavKey — best-effort detection of which nav tab should be active
// based on currently visible view. Used after a re-render or role switch.
function _currentNavKey(){
  function vis(id){ var e=document.getElementById(id); return e && e.style.display !== 'none' && e.style.display !== ''; }
  if(vis('landingView'))      return 'home';
  if(vis('worklistView'))     return 'worklist';
  if(vis('inventoryView'))    return 'inventory';
  if(vis('matchView'))        return 'match';
  if(vis('renosView'))        return 'operations';
  if(vis('contractorsView'))  return 'operations';
  if(window.location.pathname.indexOf('rfq.html')          !== -1) return 'operations';
  if(window.location.pathname.indexOf('inspections.html')  !== -1) return 'operations';
  if(window.location.pathname.indexOf('projects.html')     !== -1) return 'operations';
  if(window.location.pathname.indexOf('finance.html')      !== -1) return 'finance';
  if(vis('tenantsView'))      return 'tenants';
  if(vis('settingsView'))     return 'settings';
  return 'home';
}

function setHeaderNavActive(key){
  var all = document.querySelectorAll('.app-header-v2 .app-nav-item');
  for(var i=0;i<all.length;i++){
    var btn = all[i];
    if(btn.getAttribute('data-nav') === key) btn.classList.add('active');
    else btn.classList.remove('active');
  }
}

// applyRoleVisibility — show/hide every [data-roles] element based on the
// current effective role. Empty/missing data-roles means "visible to all".
// super_user is an ED tier (inherits everything granted to 'ed'), so any
// data-roles list containing 'ed' implicitly admits super_user — several
// static lists omit it and were hiding ED-authorized controls from super
// users (matches APPROVAL_AUTHORITY.can's inheritance rule).
function applyRoleVisibility(role){
  role = role || window.currentRole || 'housing_employee_l1';
  // One pass over elements gated by role AND/OR per-user feature access. An
  // element is visible only if BOTH gates pass (missing attr = that gate open).
  var els = document.querySelectorAll('[data-roles],[data-feature]');
  for(var i=0;i<els.length;i++){
    var el = els[i];
    var roleAttr = el.getAttribute('data-roles');
    var roleOk = true;
    if(roleAttr){
      var allowed = roleAttr.split(',').map(function(s){return s.trim();}).filter(Boolean);
      roleOk = !allowed.length
        || allowed.indexOf(role) !== -1
        || (role === 'super_user' && allowed.indexOf('ed') !== -1);
    }
    var feat = el.getAttribute('data-feature');
    var featOk = !feat || typeof window.canUseFeature !== 'function' || window.canUseFeature(feat);
    el.style.display = (roleOk && featOk) ? '' : 'none';
  }
}

// _debounce — minimal debouncer for the lookup input.
function _debounce(fn, ms){
  var t=null;
  return function(){
    var args=arguments, ctx=this;
    if(t) clearTimeout(t);
    t = setTimeout(function(){ fn.apply(ctx,args); }, ms);
  };
}

// ── Quick Lookup ─────────────────────────────────────────────────────────
// Lookup state lives on window so the tab filter and recently-viewed list
// can read it without re-querying.
window._lookupState = window._lookupState || { tab:'all', q:'', results:{tenants:[],units:[],sows:[],rfqs:[],contractors:[]} };
var LOOKUP_RECENT_KEY = 'clfn_landing_recent_lookups';

function _lookupReadRecent(){
  try { return JSON.parse(localStorage.getItem(LOOKUP_RECENT_KEY) || '[]'); } catch(e){ return []; }
}
// Defensive: an earlier version of the chip design saved labels with a
// leading single-letter type prefix ("T John Smith", "U 12 Maple St").
// Strip it on both save and render so cached entries clean themselves up
// the next time the recent list is touched. Regex requires a single
// uppercase T/U/S followed by whitespace — safe against real names like
// "Tom Smith" or "Sara Lee".
function _lookupStripTypePrefix(s){
  var str = String(s == null ? '' : s);
  var stripped = str.replace(/^[TUS]\s+/, '');
  if (stripped !== str && typeof console !== 'undefined') {
    console.warn('[lookup recent] stripped legacy type prefix:', JSON.stringify(str));
  }
  return stripped;
}
function _lookupPushRecent(entry){
  if(!entry || !entry.id) return;
  // Sanitize before persisting so further saves can't carry the bad prefix.
  if(entry.label) entry.label = _lookupStripTypePrefix(entry.label);
  var list = _lookupReadRecent().filter(function(r){ return !(r.id===entry.id && r.kind===entry.kind); });
  list.unshift(entry);
  if(list.length > 8) list.length = 8;
  try { localStorage.setItem(LOOKUP_RECENT_KEY, JSON.stringify(list)); } catch(e){}
  _renderLookupRecent();
}
function _renderLookupRecent(){
  var host = document.getElementById('lookup_recent');
  if(!host) return;
  var list = _lookupReadRecent();
  if(!list.length){ host.innerHTML = ''; return; } // CSS :empty pseudo handles the empty-state copy
  // Type info is preserved on the data attribute for the click handler — the
  // visible chip just shows the name. The kind class lets CSS tint the chip
  // border/background subtly per type without dropping a letter on the user.
  host.innerHTML = list.map(function(r){
    var lbl = _lookupStripTypePrefix(r.label || r.id);
    return '<button type="button" class="lookup-chip lookup-chip--'+_esc(r.kind)+'" data-recent-kind="'+_esc(r.kind)+'" data-recent-id="'+_esc(r.id)+'">'
        + _esc(lbl) + '</button>';
  }).join('');
}

function _runLookup(q){
  q = (q||'').trim();
  window._lookupState.q = q;
  var results = { tenants:[], units:[], sows:[], rfqs:[], contractors:[] };
  if(q.length >= 1){
    if(typeof sbLookupTenants     === 'function') results.tenants     = sbLookupTenants(q)     || [];
    if(typeof sbLookupUnits       === 'function') results.units       = sbLookupUnits(q)       || [];
    if(typeof sbLookupSOWs        === 'function') results.sows        = sbLookupSOWs(q)        || [];
    if(typeof sbLookupRFQs        === 'function') results.rfqs        = sbLookupRFQs(q)        || [];
    if(typeof sbLookupContractors === 'function') results.contractors = sbLookupContractors(q) || [];
  }
  window._lookupState.results = results;
  _renderLookupCounts();
  _renderLookupResults();
}

function _renderLookupCounts(){
  var r = window._lookupState.results || {tenants:[],units:[],sows:[],rfqs:[],contractors:[]};
  var total = r.tenants.length + r.units.length + r.sows.length + (r.rfqs||[]).length + (r.contractors||[]).length;
  function set(id,n){ var el=document.getElementById(id); if(el) el.textContent = n; }
  set('lookup_tab_count_all',         total);
  set('lookup_tab_count_tenants',     r.tenants.length);
  set('lookup_tab_count_units',       r.units.length);
  set('lookup_tab_count_sows',        r.sows.length);
  set('lookup_tab_count_rfqs',       (r.rfqs||[]).length);
  set('lookup_tab_count_contractors',(r.contractors||[]).length);
}

function _renderLookupResults(){
  var host = document.getElementById('lookup_results');
  if(!host) return;
  var st = window._lookupState;
  if(!st.q){ host.classList.remove('open'); host.innerHTML=''; return; }
  var r = st.results || {tenants:[],units:[],sows:[],rfqs:[],contractors:[]};
  var rows = [];
  if(st.tab==='all' || st.tab==='tenants') r.tenants.forEach(function(x){ rows.push(_lookupRow('tenant', x)); });
  if(st.tab==='all' || st.tab==='units')   r.units  .forEach(function(x){ rows.push(_lookupRow('unit',   x)); });
  if(st.tab==='all' || st.tab==='sows')    r.sows   .forEach(function(x){ rows.push(_lookupRow('sow',    x)); });
  if(st.tab==='all' || st.tab==='rfqs')   (r.rfqs||[]).forEach(function(x){ rows.push(_lookupRow('rfq',  x)); });
  if(st.tab==='all' || st.tab==='contractors')(r.contractors||[]).forEach(function(x){ rows.push(_lookupRow('contractor', x)); });
  host.classList.add('open');
  host.innerHTML = rows.length
    ? rows.join('')
    : '<div class="lookup-empty">No matches for &ldquo;'+_esc(st.q)+'&rdquo;</div>';
}

function _lookupRow(kind, x){
  var label = _esc(x.label || x.id || '');
  var meta  = _esc(x.meta  || '');
  var initial = kind === 'tenant' ? 'T' : kind === 'unit' ? 'U' : kind === 'rfq' ? 'R' : kind === 'contractor' ? 'C' : 'S';
  return '<div class="lookup-result" data-lookup-kind="'+kind+'" data-lookup-id="'+_esc(x.id||'')+'">'
       + '<span class="lookup-result-icon type-'+kind+'">'+initial+'</span>'
       + '<span class="lookup-result-main">'
       +   '<div class="lookup-result-title">'+label+'</div>'
       +   (meta ? '<div class="lookup-result-sub">'+meta+'</div>' : '')
       + '</span>'
       + '<span class="lookup-result-badge badge-'+kind+'">'+kind+'</span>'
       + '</div>';
}
// _esc lives in shared-ui.js (delegates to escapeHtml). The top-level copy that
// was here collided with it on window — last script loaded won, and this copy
// didn't escape single quotes. Do not re-add a page-level _esc.

function _lookupOpen(kind, id, label){
  if(!id) return;
  _lookupPushRecent({ kind:kind, id:id, label:label });
  if(kind==='tenant'){
    // Tenant lookup → open the Tenant Information Card. The TIC keys off a
    // unit id (it resolves the tenant via housing_units.assigned_name) or a
    // tenant UUID. Our lookup gives us an application id, so map it to the
    // assigned unit first. If the applicant has no unit yet, fall back to the
    // application form — the TIC has no record to show until they're housed.
    var apps = (typeof applications !== 'undefined') ? applications : [];
    var app  = null;
    for(var i=0;i<apps.length;i++){ if(apps[i] && apps[i].id === id){ app = apps[i]; break; } }
    var unitId = app && app.assignedUnit;
    if(unitId){
      if(typeof window.openTenantCard === 'function' && document.getElementById('ticModal')){
        window.openTenantCard(unitId);
      } else {
        if (typeof setNavReferrer === 'function') setNavReferrer('home');
        window.location.href = 'tenants.html?tic=' + encodeURIComponent(unitId);
      }
    } else {
      // No unit yet (applicant) — open their Tenant Information Card, built from
      // the application (Phase T2). From there the 'View Application' button
      // opens the application to update it. Falls back to the application form
      // only if the TIC isn't available on this page.
      if(typeof window.openTenantCard === 'function' && document.getElementById('ticModal')){
        window.openTenantCard(id);
      } else if(typeof window.openEditModal === 'function'){
        window.openEditModal(id);
      } else {
        if (typeof setNavReferrer === 'function') setNavReferrer('home');
        window.location.href = 'housing.html?openApp=' + encodeURIComponent(id);
      }
    }
  } else if(kind==='unit'){
    if (typeof setNavReferrer === 'function') setNavReferrer('home');
    window.location.href = 'inventory.html?unit=' + encodeURIComponent(id);
  } else if(kind==='sow'){
    if (typeof setNavReferrer === 'function') setNavReferrer('home');
    window.location.href = 'renos.html?sow=' + encodeURIComponent(id);
  } else if(kind==='rfq'){
    if (typeof setNavReferrer === 'function') setNavReferrer('home');
    window.location.href = 'rfq.html?rfq=' + encodeURIComponent(id);
  } else if(kind==='contractor'){
    if (typeof setNavReferrer === 'function') setNavReferrer('home');
    window.location.href = 'contractors.html?openContractor=' + encodeURIComponent(id);
  }
}

// ── Section toggles (Worklist / Recent activity) ────────────────────────
function _sectionStorageKey(id){ return 'clfn_landing_sec_' + id + '_collapsed'; }
function _sectionSyncAria(sec){
  if(!sec) return;
  var hdr = sec.querySelector('[data-section-toggle]');
  if(hdr) hdr.setAttribute('aria-expanded', sec.classList.contains('collapsed') ? 'false' : 'true');
}
function _sectionApplyState(id){
  var sec = document.getElementById(id);
  if(!sec) return;
  var stored = null;
  try { stored = localStorage.getItem(_sectionStorageKey(id)); } catch(e){}
  var collapsed = (stored === null) ? sec.classList.contains('collapsed') : (stored === '1');
  sec.classList.toggle('collapsed', collapsed);
  _sectionSyncAria(sec);
  if(!collapsed) _sectionOnExpand(id);
}
function _sectionToggle(id){
  var sec = document.getElementById(id);
  if(!sec) return;
  var nowCollapsed = !sec.classList.contains('collapsed');
  sec.classList.toggle('collapsed', nowCollapsed);
  _sectionSyncAria(sec);
  try { localStorage.setItem(_sectionStorageKey(id), nowCollapsed ? '1' : '0'); } catch(e){}
  if(!nowCollapsed) _sectionOnExpand(id);
}
function _sectionOnExpand(id){
  if(id === 'sec-worklist'){
    if(typeof renderWorklist === 'function') renderWorklist();
    _renderWorklistCountPills();
  } else if(id === 'sec-recent'){
    // Use the role-aware version in housing-views.js — it pulls from Supabase
    // when the in-memory auditLog is empty, applies role-scoped filtering,
    // and renders icons. (The local _renderRecentActivity stub was a no-data
    // shim and has been removed.)
    var _role = window._viewAsRole || window.currentRole || 'housing_employee_l1';
    if(typeof renderRecentActivity === 'function') renderRecentActivity(_role);
  }
}
function _renderWorklistCountPills(){
  // Delegate the full count to renderWorklist which tallies all entity types
  // and updates the pill + quick-action label itself (before its empty-state
  // return). Always delegate — even when the section is collapsed. A hand-
  // rolled collapsed-only counter here drifted badly: it compared the raw
  // approval_status against 'pending_hm'/'pending_ed' (labels that never
  // exist in the data, so SOWs counted 0) and omitted drafts + field work
  // orders, making the badge change value on expand/collapse.
  if (typeof renderWorklist === 'function') {
    renderWorklist();
  }
  // "Ready to match" KPI pill (separate from the worklist count). Commercial
  // apps have their own assign flow and never belong in the residential queue.
  var apps2 = (typeof applications !== 'undefined' && applications) ? applications : [];
  var STATUS = (typeof APP_STATUS !== 'undefined') ? APP_STATUS : { ED_APPROVED:'ed_approved', MGR_APPROVED:'mgr_approved' };
  var ready = apps2.filter(function(a){ return a && !a.archived && a.appType !== 'commercial' && (a.status===STATUS.ED_APPROVED || a.status===STATUS.MGR_APPROVED) && !a.assignedUnit; }).length;
  var qr = document.getElementById('qa_ready_count'); if(qr) qr.textContent = ready;
}
// ── Quick Action handlers ────────────────────────────────────────────────
function _runQuickAction(action){
  if(action === 'new-app'){
    if(typeof newApp === 'function') newApp();
  } else if(action === 'reno-questionnaire'){
    if(typeof openRenoQuestionnaire === 'function') openRenoQuestionnaire();
  } else if(action === 'approve-queue'){
    if(typeof showWorklist === 'function') showWorklist();
  } else if(action === 'run-match'){
    if(typeof showMatch === 'function') showMatch();
  } else if(action === 'likely-housed'){
    if(typeof showLikelyHousedReport === 'function') showLikelyHousedReport();
  } else if(action === 'reconcile'){
    if(typeof showReconcileReport === 'function') showReconcileReport();
  } else if(action === 'archived-apps'){
    if(typeof showArchivedApplications === 'function') showArchivedApplications();
  } else if(action === 'rent-payment'){
    showToast('Coming soon — Finance module.', {type:'info'});
  }
}

// ── Create menu handlers ─────────────────────────────────────────────────
function _runCreateAction(action){
  _closeCreateMenu();
  // Element-based check (not `typeof X === 'function'`): the modal-opening
  // helpers are loaded on every page via shared-data.js, but the modal
  // *markup* lives only on its home page. Probing for the modal DOM tells us
  // whether we can open in-place or need to navigate.
  if(action === 'application'){
    if(document.getElementById('appLayout') && typeof newApp === 'function') newApp();
    else window.location.href = 'housing.html?view=newapp';
  } else if(action === 'unit'){
    if(document.getElementById('addUnitModal') && typeof openAddUnitModal === 'function') openAddUnitModal();
    else window.location.href = 'inventory.html?action=newUnit';
  } else if(action === 'contractor'){
    // The CIC modal is built on demand now (host div on contractors.html),
    // so probe for the host rather than the modal itself.
    if(document.getElementById('addContractorModalHost') && typeof openAddContractorModal === 'function') openAddContractorModal();
    else window.location.href = 'contractors.html?action=newContractor';
  } else if(action === 'tenant'){
    if(document.getElementById('addTenantModal') && typeof openAddTenantModal === 'function') openAddTenantModal();
    else window.location.href = 'tenants.html?action=newTenant';
  }
}
function _toggleCreateMenu(){
  var m = document.getElementById('create_menu');
  if(!m) return;
  m.classList.toggle('open');
}
function _closeCreateMenu(){
  var m = document.getElementById('create_menu');
  if(m) m.classList.remove('open');
}
function _toggleNavDrawer(){
  var n = document.getElementById('app_nav');
  if(n) n.classList.toggle('open');
}
function _closeNavDrawer(){
  var n = document.getElementById('app_nav');
  if(n) n.classList.remove('open');
}

// ── Avatar popover (sign out / view-as) ─────────────────────────────────
function _toggleAvatarPopover(){
  var existing = document.getElementById('header_avatar_pop');
  if(existing){ existing.remove(); return; }
  var anchor = document.getElementById('header_user_pill');
  if(!anchor) return;
  var role = window.currentRole || 'housing_employee_l1';
  var realRole = window._realRole || role;
  var name = (typeof HOUSING_SESSION !== 'undefined' && HOUSING_SESSION.name) ? HOUSING_SESSION.name : 'Staff';
  var label = (window.CLFN_PERMS && CLFN_PERMS.roleLabel) ? CLFN_PERMS.roleLabel(role) : role;
  var pop = document.createElement('div');
  pop.id = 'header_avatar_pop';
  pop.className = 'header-avatar-pop';
  // ED and Super User get view-as switcher; everyone gets sign out.
  var viewAs = '';
  if(window.CLFN_PERMS && (realRole === 'ed' || realRole === 'super_user')){
    var opts = CLFN_PERMS.getViewAsOptions(realRole) || [];
    if(opts.length){
      var ownLabel = CLFN_PERMS.roleLabel(realRole);
      viewAs = '<div class="hap-section"><div class="hap-section-label">View as</div>'
             + '<select id="hap_view_as">'
             + '<option value="">My role (' + _esc(ownLabel) + ')</option>'
             + opts.map(function(k){ return '<option value="'+k+'"'+(k===role?' selected':'')+'>'+CLFN_PERMS.roleLabel(k)+'</option>'; }).join('')
             + '</select></div>';
    }
  }
  pop.innerHTML = '<div class="hap-head"><div class="hap-name">'+_esc(name)+'</div><div class="hap-role">'+_esc(label)+'</div></div>'
                + viewAs
                + '<button type="button" class="hap-action" data-hap="signout">Sign out</button>';
  document.body.appendChild(pop);
  var rect = anchor.getBoundingClientRect();
  pop.style.position = 'fixed';
  pop.style.top = (rect.bottom + 8) + 'px';
  pop.style.right = (window.innerWidth - rect.right) + 'px';
}
function _closeAvatarPopover(){
  var p = document.getElementById('header_avatar_pop');
  if(p) p.remove();
}

// ── Delegated event listener ─────────────────────────────────────────────
// One listener on document handles every header / landing interaction.
// Header bits run on any page that has .app-header-v2; landing bits
// (lookup, sections, recent activity) only run on housing.html.
document.addEventListener('DOMContentLoaded', function(){
  // First, render the shared header into #app_header_host if the page uses it.
  // No-op on pages that still ship their own static header markup.
  if(typeof renderAppHeader === 'function') renderAppHeader();

  var hasHeader  = !!document.querySelector('.app-header-v2');
  var hasLanding = !!document.getElementById('landingView');
  if(!hasHeader && !hasLanding) return;

  // Initial render of the dynamic nav + visibility pass (header pages only).
  if(hasHeader){
    if(typeof renderHeaderNav === 'function') renderHeaderNav();
    if(typeof applyRoleVisibility === 'function') applyRoleVisibility(window.currentRole);
  }

  // Landing-only state hydrate.
  if(hasLanding){
    _sectionApplyState('sec-worklist');
    _sectionApplyState('sec-recent');
    _renderLookupRecent();
    _renderWorklistCountPills();

    var lookupInput = document.getElementById('lookup_input');
    if(lookupInput){
      var debounced = _debounce(function(e){ _runLookup(e.target.value); }, 200);
      lookupInput.addEventListener('input', debounced);
      lookupInput.addEventListener('focus', function(){ if(lookupInput.value) _renderLookupResults(); });
    }
  }

  // One delegated click handler for everything else.
  document.addEventListener('click', function(e){
    var t = e.target;
    if(!t || !t.closest) return;

    // Hamburger
    if(t.closest('#nav_toggle')){ e.preventDefault(); _toggleNavDrawer(); return; }

    // Nav item click
    var navBtn = t.closest('.app-header-v2 .app-nav-item[data-nav]');
    if(navBtn){
      e.preventDefault();
      if(navBtn.classList.contains('nav-group-toggle')) return; // handled by toggleNavGroup onclick
      var key = navBtn.getAttribute('data-nav');
      var item = HEADER_NAV.filter(function(x){ return x.key===key; })[0];
      _closeNavDrawer();
      if(item && typeof item.run === 'function') item.run();
      setHeaderNavActive(key);
      return;
    }

    // Header settings button (right-side)
    if(t.closest('#header_settings_btn')){ e.preventDefault(); if(typeof showSettings==='function') showSettings(); setHeaderNavActive('settings'); return; }

    // Export button (header-v2)
    if(t.closest('#header_export_btn_v2')){
      e.preventDefault();
      var menu = document.getElementById('header_export_menu_v2');
      if(menu) menu.classList.toggle('open');
      return;
    }
    var expItem = t.closest('.export-menu-item-v2[data-export]');
    if(expItem){
      e.preventDefault();
      var fmt = expItem.getAttribute('data-export');
      var menu2 = document.getElementById('header_export_menu_v2');
      if(menu2) menu2.classList.remove('open');
      if(typeof headerExport === 'function') headerExport(fmt);
      return;
    }

    // Create menu open/close
    if(t.closest('#header_create_btn')){ e.preventDefault(); _toggleCreateMenu(); return; }
    var createItem = t.closest('.create-menu-item[data-create]');
    if(createItem){ e.preventDefault(); _runCreateAction(createItem.getAttribute('data-create')); return; }

    // #worklist_view_all link was removed along with the Applications
    // dashboard — the worklist itself is now the canonical list view.

    // Section toggles — only when clicking the toggle row itself, not a child
    // button/link inside it that has its own behaviour (e.g. wlOpenApp on a row,
    // the search input, etc.).
    var secHdr = t.closest('[data-section-toggle]');
    if(secHdr){
      // If the click landed on an interactive child (button/a/input/select),
      // don't hijack it — let the inline handler run.
      var interactive = t.closest('button, a, input, select, textarea, [data-wl-id], [data-wl-edit]');
      if(!interactive || !secHdr.contains(interactive)){
        e.preventDefault(); _sectionToggle(secHdr.getAttribute('data-section-toggle')); return;
      }
    }

    // Quick actions
    var qa = t.closest('.qa-btn[data-qa]');
    if(qa){ if(qa.disabled) return; e.preventDefault(); _runQuickAction(qa.getAttribute('data-qa')); return; }

    // Lookup tab
    var ltab = t.closest('.lookup-tab[data-lookup-tab]');
    if(ltab){
      e.preventDefault();
      var tab = ltab.getAttribute('data-lookup-tab');
      window._lookupState.tab = tab;
      var allTabs = document.querySelectorAll('.lookup-tab');
      for(var i=0;i<allTabs.length;i++) allTabs[i].classList.toggle('active', allTabs[i] === ltab);
      _renderLookupResults();
      return;
    }

    // Lookup result row
    var lrow = t.closest('.lookup-result[data-lookup-kind]');
    if(lrow){
      e.preventDefault();
      var kind = lrow.getAttribute('data-lookup-kind');
      var id   = lrow.getAttribute('data-lookup-id');
      var titleEl = lrow.querySelector('.lookup-result-title');
      var label = (titleEl && titleEl.textContent.trim()) || id;
      _lookupOpen(kind, id, label);
      return;
    }

    // Recently-viewed chip
    var chip = t.closest('[data-recent-kind][data-recent-id]');
    if(chip){
      e.preventDefault();
      _lookupOpen(chip.getAttribute('data-recent-kind'), chip.getAttribute('data-recent-id'), (chip.textContent||'').trim());
      return;
    }

    // (Worklist view-all handled earlier — before the section-toggle catch-all.)

    // Recent-activity row → open application
    var rapp = t.closest('[data-recent-app]');
    if(rapp){ e.preventDefault(); if(typeof window.openEditModal==='function') window.openEditModal(rapp.getAttribute('data-recent-app')); return; }

    // Avatar popover
    if(t.closest('#header_user_pill')){ e.preventDefault(); _toggleAvatarPopover(); return; }
    var hap = t.closest('[data-hap]');
    if(hap){
      e.preventDefault();
      if(hap.getAttribute('data-hap')==='signout'){ _closeAvatarPopover(); if(typeof headerSignOut==='function') headerSignOut(); else if(typeof doLogout==='function') doLogout(); }
      return;
    }

    // Outside-click closers (run last)
    if(!t.closest('#app_nav') && !t.closest('#nav_toggle')) _closeNavDrawer();
    if(!t.closest('#create_menu') && !t.closest('#header_create_btn')) _closeCreateMenu();
    if(!t.closest('#header_export_menu_v2') && !t.closest('#header_export_btn_v2')){
      var em = document.getElementById('header_export_menu_v2');
      if(em) em.classList.remove('open');
    }
    if(!t.closest('#header_avatar_pop') && !t.closest('#header_user_pill')) _closeAvatarPopover();
    if(!t.closest('#lookup_input') && !t.closest('#lookup_results')){
      var lr = document.getElementById('lookup_results');
      if(lr){ lr.classList.remove('open'); }
    }
  });

  // ED view-as (delegated change event)
  document.addEventListener('change', function(e){
    if(e.target && e.target.id === 'hap_view_as'){
      var newRole = e.target.value || (window._realRole || 'ed');
      window._viewAsRole = e.target.value || null;
      if(typeof switchRole === 'function') switchRole(newRole);
      _closeAvatarPopover();
      // Worklist retally + re-render happen once, inside the _onSwitchRole
      // wrap below (switchRole always invokes it on interactive switches —
      // _booting is only true during boot). A duplicate "belt-and-suspenders"
      // block here used to render the worklist a second time per switch; the
      // wrap's render code runs unconditionally after prev() (whose errors are
      // caught), so it cannot be skipped.
    }
  });
});

// Refresh dynamic header bits whenever role changes (boot or view-as).
(function(){
  var prev = window._onSwitchRole;
  window._onSwitchRole = function(role){
    try { if(typeof prev === 'function') prev(role); } catch(_){}
    if(typeof renderHeaderNav === 'function') renderHeaderNav();
    if(typeof applyRoleVisibility === 'function') applyRoleVisibility(role);
    _renderWorklistCountPills();
    // Re-render the worklist body if the section is currently expanded.
    var sec = document.getElementById('sec-worklist');
    if(sec && !sec.classList.contains('collapsed') && typeof renderWorklist === 'function'){
      renderWorklist();
    }
  };
})();

// ══════════════════════════════════════════════════════
// PAGE BOOT — only on housing.html
// ══════════════════════════════════════════════════════
// housing-init.js is loaded by multiple pages in the suite (housing.html,
// inventory.html, etc.) because they share helpers like showDashboard,
// newApp, resolveHousingRole, etc. But only housing.html should run this
// page-level boot. On inventory.html (and other sub-pages), the page's
// own inline init block handles view dispatch against its own DOM —
// letting this IIFE run there would call initHousingPage(), which reads
// ?view= from the sub-page's URL and tries to render housing.html views
// (dashView, employeeHomeView) on a DOM that doesn't contain them. That
// either shows the wrong thing or, more commonly, a blank screen.
(function () {
  var path = window.location.pathname;
  // Accept both `/housing.html` (Cloudflare static assets) and `/housing`
  // (static servers like `npx serve` that strip the .html via clean URLs).
  var isHousingHome =
    path.endsWith('/housing.html') ||
    path === '/housing.html' ||
    path.endsWith('/housing') ||
    path === '/housing' ||
    path.endsWith('/') ||
    path === '';
  if (!isHousingHome) {
    return;
  }

  (async function initHousing() {
    var token=null, savedRole=null, savedName=null, savedEmail=null;
    try {
      token      = sessionStorage.getItem('clfn_housing_token');
      savedRole  = sessionStorage.getItem('clfn_housing_role') || 'housing_employee_l1';
      savedName  = sessionStorage.getItem('clfn_housing_name') || '';
      savedEmail = sessionStorage.getItem('clfn_housing_email_session') || '';
    } catch(e) {}
    if(!token) { window.location.href='index.html'; return; }
    HOUSING_HEADERS['Authorization'] = 'Bearer '+token;
    HOUSING_SESSION.accessToken=token; HOUSING_SESSION.role=savedRole;
    HOUSING_SESSION.name=savedName; HOUSING_SESSION.email=savedEmail;
    window.currentRole=savedRole;
    window.CLFN_AUTH = window.CLFN_AUTH||{};
    window.CLFN_AUTH.isAuthenticated=true; window.CLFN_AUTH.currentRole=savedRole;
    try {
      // Resolve the CURRENT role from the staff table before rendering anything.
      // The sessionStorage cache above is stale on every housing.html page load
      // because nothing writes to clfn_housing_role — it will always default to
      // 'employee', which renders the wrong tile grid and causes the Finance
      // tile to be hidden from ED/HM users on first load. This call queries
      // Supabase for the real role based on email, then updates
      // HOUSING_SESSION.role, window.currentRole, and window._realRole to match.
      if(HOUSING_SESSION.email && typeof resolveHousingRole === 'function') {
        await resolveHousingRole();
      }
      // Drain any drafts that the previous session left in localStorage because
      // the cloud upsert failed (network blip, PGRST303, etc). Silent on
      // empty queue. Fires after auth is resolved so the Bearer token is fresh.
      if(typeof syncDraftQueue === 'function') {
        syncDraftQueue().catch(function(e){ console.warn('[boot] syncDraftQueue:', e); });
      }
      await loadHousingData();
      initHousingPage();
      if (document.body) document.body.style.opacity = '1';
    } catch(e) {
      console.error('[HOUSING] init failed:', e.message, e.stack);
      // Guard the catch's body access too — if document.body is null
      // (early boot race), the catch itself would throw and bury the
      // original error in the console.
      if (document.body) document.body.style.opacity = '1';
    }
  }());
}());
