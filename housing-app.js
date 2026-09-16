/* ============================================================
 * housing-app.js — CLFN Housing Suite
 * Application form: steps, validation, submission, scoring
 *
 * Load order: ... housing-modals.js → THIS FILE
 *
 * Covers: application form steps (goTo, validateStep*),
 *   income/household/reference/pet forms, file uploads,
 *   approval flow, submit modal, print preview,
 *   dashboard table (renderDashTable, updateDashStats),
 *   assign unit modal, reno approvals view
 * ============================================================ */

'use strict';

// ── Preview from Dash ──


let cur = 0;
const STEPS = 9; // 7 visible steps (0-6) + review (8) = 8 total
let currentAppId = null;

// ── Helpers ──



function setText(id,val){var e=document.getElementById(id);if(e)e.textContent=val;}

// ── Arrears payment-plan duration calculation ──
// Reads Amount Owed and Monthly Payment, computes ceil(amount / monthly) as
// integer months, writes that into the (readonly) #arrPlanMonths input so
// downstream save logic and V2 scoring still find an integer there. Also
// renders a "X yr Y mo" hint underneath. Triggers V2 rescore on change.
function _calcArrearsMonths(){
  function toNum(id){
    var el = document.getElementById(id);
    if(!el) return 0;
    var n = parseFloat(String(el.value||'').replace(/[^0-9.]/g,''));
    return isFinite(n) ? n : 0;
  }
  var owed     = toNum('arrBalAmt');
  var monthly  = toNum('arrMonthlyPayment');
  var monthsEl = document.getElementById('arrPlanMonths');
  var hintEl   = document.getElementById('arrPlanMonthsHint');
  var months   = (owed > 0 && monthly > 0) ? Math.ceil(owed / monthly) : 0;
  if(monthsEl) monthsEl.value = months || '';
  if(hintEl){
    if(months > 0){
      var yrs = Math.floor(months / 12);
      var mo  = months % 12;
      var parts = [];
      if(yrs) parts.push(yrs + ' yr' + (yrs !== 1 ? 's' : ''));
      if(mo)  parts.push(mo  + ' mo');
      if(!parts.length) parts.push('—');
      hintEl.textContent = months + ' months  (' + parts.join(' ') + ')';
    } else {
      hintEl.textContent = '';
    }
  }
  if(typeof triggerV2Score === 'function') triggerV2Score();
}

// ── Co-applicant arrears payment-plan duration ──
// Mirrors _calcArrearsMonths but reads/writes the coArr* field ids. Lives next
// to its applicant counterpart so future tweaks land on both sides together.
function _calcCoArrearsMonths(){
  function toNum(id){
    var el = document.getElementById(id);
    if(!el) return 0;
    var n = parseFloat(String(el.value||'').replace(/[^0-9.]/g,''));
    return isFinite(n) ? n : 0;
  }
  var owed     = toNum('coArrBalAmt');
  var monthly  = toNum('coArrMonthlyPayment');
  var monthsEl = document.getElementById('coArrPlanMonths');
  var hintEl   = document.getElementById('coArrPlanMonthsHint');
  var months   = (owed > 0 && monthly > 0) ? Math.ceil(owed / monthly) : 0;
  if(monthsEl) monthsEl.value = months || '';
  if(hintEl){
    if(months > 0){
      var yrs = Math.floor(months / 12);
      var mo  = months % 12;
      var parts = [];
      if(yrs) parts.push(yrs + ' yr' + (yrs !== 1 ? 's' : ''));
      if(mo)  parts.push(mo  + ' mo');
      if(!parts.length) parts.push('—');
      hintEl.textContent = months + ' months  (' + parts.join(' ') + ')';
    } else {
      hintEl.textContent = '';
    }
  }
  if(typeof triggerV2Score === 'function') triggerV2Score();
}

// ── Phone formatter ──
// Now a thin wrapper around the shared window.formatPhone — single source
// of truth for "(705)-000-0000" canonical formatting (parens + dashes).
function fmtPhone(input){
  if (!input) return;
  input.value = (typeof formatPhone === 'function')
    ? formatPhone(input.value)
    : input.value;
}

// ── App ID ──
function generateAppId(){
  try {
    // Filter out NaN: one unconventional id (portal/UUID row) used to poison
    // Math.max forever — every new id became 'APP-000NaN' and duplicated.
    // (The old code also concat'd the array with a copy of itself — pointless.)
    const existing=(typeof applications!=='undefined'?applications:[])
      .map(function(a){return parseInt((a.id||'').replace('APP-',''),10);})
      .filter(function(n){return isFinite(n);});
    const max=existing.length?Math.max.apply(null,existing):184;
    return 'APP-'+String(max+1).padStart(6,'0');
  } catch(e) { return 'APP-000185'; }
}
function initAppId(){
  if(!currentAppId)currentAppId=generateAppId();
  const el=document.getElementById('appNumCard');
  if(el)el.textContent=currentAppId;
}

function showStepErrors(step, errs, bannerId) {
  // Clear previous field highlights in this step
  var stepEl = document.getElementById(step);
  if (stepEl) {
    stepEl.querySelectorAll('.field-error').forEach(function(el){ el.classList.remove('field-error'); });
  }
  var b = document.getElementById(bannerId);
  if (!b) return;
  if (!errs || !errs.length) { b.style.display = 'none'; return; }
  // Render as a list
  var items = errs.map(function(e){ return '<li>' + e + '</li>'; }).join('');
  b.innerHTML = '<div class="err-title"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>'
    + (errs.length === 1 ? 'Please fix the following:' : errs.length + ' fields need attention:')
    + '</div><ul>' + items + '</ul>';
  b.style.display = 'block';
  // Scroll banner into view
  b.scrollIntoView({ behavior: 'smooth', block: 'start' });
  window.scrollTo({ top: 0, behavior: 'smooth' });
  // Shake
  b.style.animation = 'none';
  b.offsetHeight; // reflow
  b.style.animation = 'shake .35s ease';
  // Highlight invalid fields — match error messages to field IDs.
  // Only matches static field errors; dynamic-row errors (Reference 1: …,
  // Household member 2: …, Pet 3: …, Income record 1: …) are skipped so
  // their inner phrasing doesn't accidentally highlight a same-named static
  // field on a different step.
  var fieldMap = {
    'First name': 'fn', 'Last name': 'ln', 'Date of birth': 'dob',
    'On Reserve': 'reserve', 'Marital status': 'marital', 'Marital Status': 'marital',
    'Cell phone': 'phone', 'Phone': 'phone', 'Email': 'email',
    'Classification': 'classification', 'Housing Classification': 'classification',
    'Street': 'street', 'City': 'city', 'Province': 'prov', 'Postal': 'postal',
    'Expected occupancy': 'occDate', 'Arrears amount': 'arrBalAmt',
    'Home condition': 'homeCondition',
    'Co-applicant first': 'co_fn', 'Co-applicant last': 'co_ln',
    'Co-applicant date': 'co_dob', 'Co-applicant reserve': 'co_reserve',
    'Co-applicant cell': 'co_cell', 'Co-applicant email': 'co_email'
  };
  var ROW_PREFIX_RE = /^(Reference |Household member |Pet |Income record |Row )/i;
  errs.forEach(function(err) {
    if (ROW_PREFIX_RE.test(err)) return; // dynamic-row error — handled at the row level
    Object.keys(fieldMap).forEach(function(key) {
      if (err.toLowerCase().includes(key.toLowerCase())) {
        var el = document.getElementById(fieldMap[key]);
        if (el) el.classList.add('field-error');
      }
    });
  });
}
function clearStepErrors(step, bannerId) {
  var b = document.getElementById(bannerId);
  if (b) { b.innerHTML = ''; b.style.display = 'none'; }
  // Remove field highlights
  var stepEl = document.getElementById(step);
  if (stepEl) {
    stepEl.querySelectorAll('.field-error').forEach(function(el){ el.classList.remove('field-error'); });
  }
}
function showStep0Errors(errs, bannerId) { showStepErrors('step0', errs, bannerId || 'step0_error_banner'); }
function clearStep0Errors() { clearStepErrors('step0', 'step0_error_banner'); }

function validateStep0() {
  var errs = [];
  function fld(id){ var e=document.getElementById(id); return e?e.value.trim():''; }
  // Drive required-field checks off the configurable registry so the ED's
  // Settings → App Settings → Required Fields choices are respected.
  // SCOPE: only step-0 static fields. Other steps have their own validators
  // (validateStep1/2/3/4/5) — pulling them in here would treat dynamic-row
  // fields as static IDs (they aren't) and step-2 co-applicant fields as
  // unconditional (they're gated by the co_status toggle).
  var isHomeless = !!(document.getElementById('homelessToggle') || {}).checked;
  var addrIds = ['street', 'city', 'prov', 'postal'];
  (window.APP_REQ_FIELDS || [])
    .filter(function(f){ return f.step === 0 && !f.rowOf; })
    .forEach(function(f){
      if (isHomeless && addrIds.indexOf(f.id) !== -1) return;
      if (typeof isFieldRequired === 'function' && !isFieldRequired(f.id)) return;
      if (!fld(f.id)) errs.push(f.errorLabel || (f.label + ' is required.'));
    });
  // Policy Rules: minimum applicant age (Policy 8.1b, configurable per
  // nation in Settings > Policy Rules). Only fires when a DOB is entered —
  // missing DOB stays the Required-Fields registry's call.
  if (typeof policyRule === 'function' && policyRule('min_age').enabled) {
    var _minY = policyParam('min_age', 'years', 18);
    var _age = (typeof policyAgeYears === 'function') ? policyAgeYears(fld('dob')) : null;
    if (_age != null && _age < _minY) {
      errs.push('The primary applicant must be at least ' + _minY + ' years old' + ((typeof policyCiteSuffix==='function')?policyCiteSuffix('min_age'):'') + ' — DOB gives age ' + _age + '.');
    }
  }

  // Conditional fields — always required when their toggle is on, regardless
  // of the global config.
  var arrTog = document.getElementById('arrToggle');
  if(arrTog && arrTog.checked) {
    if(!fld('arrBalAmt')) errs.push('Arrears amount is required when arrears are selected.');
  }
  var houseTog = document.getElementById('hasHouseToggle');
  if(houseTog && houseTog.checked) {
    if(!fld('homeCondition')) errs.push('Home condition is required when a current unit is selected.');
  }
  // On-reserve screen for New Applications — catches doubled-up members at
  // intake. Always enforced for this combination, regardless of the global
  // Required Fields config (same pattern as the arrears/home-condition
  // conditionals above). "Own home on reserve" contradicts a New Application;
  // Living Situation "Other" is the escape hatch for genuine edge cases.
  var _apt = (typeof getAppType === 'function') ? getAppType() : 'new_housing';
  // HARD RULE backstop: a current tenant (real unit assignment) can never be
  // a New Application — the radio guard in onAppTypeChange reverts the UI,
  // this blocks any path that slips past it.
  if (_apt === 'new_housing' && typeof currentAppId !== 'undefined' && currentAppId
      && typeof _appIsTenancyHolder === 'function') {
    var _curTen = ((typeof applications !== 'undefined' && applications) || []).find(function(a){ return a && a.id === currentAppId; });
    if (_curTen && _appIsTenancyHolder(_curTen)) {
      // Shared message builder; forHtml=true because showStepErrors renders
      // via innerHTML and the address is record data.
      errs.push((typeof tenancyHolderMsg === 'function') ? tenancyHolderMsg(_curTen, true)
        : 'This applicant is assigned to a unit — use Transfer Request or File Update.');
    }
  }
  if (_apt === 'new_housing' && typeof onRezNewAppIssue === 'function') {
    // Shared rule (shared-config.js) — also drives the Residency-card badges
    // and the reconcile doubled-up backlog.
    var _orIssue = onRezNewAppIssue(fld('reserve'), fld('living_situation'));
    if (_orIssue === 'prompt') {
      errs.push('On-reserve applicant: select their Living Situation — if they are not in their own home, choose "Staying with family on reserve (doubled up)".');
    } else if (_orIssue === 'conflict') {
      errs.push('On-reserve applicant in their own home should not be a New Application — change the Application Type to Transfer Request (seeking a different unit) or File Update, or correct the Living Situation.');
    }
  }
  return errs;
}
function validateStep2() {
  var errs = [];
  var coSel = document.getElementById('co_status');
  if(!coSel || coSel.value !== 'yes') return errs;
  function fld(id){ var e=document.getElementById(id); return e?e.value.trim():''; }
  (window.APP_REQ_FIELDS || []).filter(function(f){ return f.step === 2; }).forEach(function(f){
    if (typeof isFieldRequired === 'function' && !isFieldRequired(f.id)) return;
    if (!fld(f.id)) errs.push(f.errorLabel || (f.label + ' is required.'));
  });
  return errs;
}
// Generic dynamic-row validator — used by steps 1, 3, 4, 5. A row counts as
// "started" when ANY tracked field has a value; only started rows are
// validated, plus the section-required toggle blocks empty sections.
function _validateDynamicStep(stepNum, sectionId) {
  var errs = [];
  var fields = (window.APP_REQ_FIELDS || []).filter(function(f){ return f.step === stepNum && f.rowOf; });
  if (!fields.length) return errs;
  var container = document.querySelector(fields[0].rowOf);
  var rows = container ? container.querySelectorAll('.rrow') : [];
  var startedRows = 0;
  rows.forEach(function(row, i){
    // A row is "started" if any tracked field is filled
    var anyFilled = fields.some(function(f){
      var input = row.querySelector('[data-role="' + f.dataRole + '"]');
      return input && (input.value || '').trim();
    });
    if (!anyFilled) return;
    startedRows++;
    fields.forEach(function(f){
      if (typeof isFieldRequired === 'function' && !isFieldRequired(f.id)) return;
      var input = row.querySelector('[data-role="' + f.dataRole + '"]');
      var v = input ? (input.value || '').trim() : '';
      if (!v) errs.push(_rowErrorLabel(f, i + 1));
    });
  });
  if (sectionId && typeof isSectionRequired === 'function' && isSectionRequired(sectionId) && startedRows === 0) {
    var sec = (window.APP_REQ_SECTIONS || []).find(function(s){ return s.id === sectionId; });
    errs.unshift((sec && sec.errorLabel) || 'At least one entry is required.');
  }
  return errs;
}
function _rowErrorLabel(field, rowIdx) {
  // Customize the row prefix per step for clearer messages
  var prefix = field.rowOf === '#habList' ? 'Household member ' + rowIdx
            : field.rowOf === '#refList' ? 'Reference ' + rowIdx
            : field.rowOf === '#petList' ? 'Pet ' + rowIdx
            : field.rowOf === '#incomeList' ? 'Income record ' + rowIdx
            : 'Row ' + rowIdx;
  return prefix + ': ' + field.label.replace(/^Pet\s+|^Reference:\s*|^Household.*?:\s*|^Income.*?:\s*/i, '').toLowerCase() + ' is required.';
}
function validateStep1() { return _validateDynamicStep(1, 'sec_step1'); }
function validateStep3() { return _validateDynamicStep(3, 'sec_step3'); }
function validateStep4() { return _validateDynamicStep(4, 'sec_step4'); }
function validateStep5() {
  return _validateDynamicStep(5, 'sec_step5');
}
// setNavActive defined below (comprehensive version handles all tabs)

document.addEventListener('DOMContentLoaded',initAppId);

// ── Role-aware step nav for the staff-only steps 9 (Housing Needs) and
//    10 (Tenancy History). They sit between Pets (5) and Documents (6) in
//    the visible flow for HM/ED, but applicants skip them entirely.
function _isHmOrEdRole(){
  var r = window.currentRole || '';
  return r === ROLE.HOUSING_MANAGER || r === ROLE.ED || r === ROLE.SUPER_USER;
}
function _goAfterPets(){ goTo(_isHmOrEdRole() ? 9 : 6); }
function _goBeforeDocuments(){ goTo(_isHmOrEdRole() ? 10 : 5); }

// ── Conditional wizard flow ──────────────────────────────────────────────
// File updates (existing_tenant) and transfer requests already have a full
// tenant file on record, so the applicant wizard skips Income (1),
// References/Emergency Contacts (4) and Pets (5) for them. goTo() jumps over
// these steps; the progress pills and the two forward-button labels that would
// otherwise point at a skipped step are kept in sync by _syncWizardNavFlow().
function _appSkippedSteps(){
  var at = (typeof getAppType === 'function') ? getAppType() : 'new_housing';
  return (at === 'existing_tenant' || at === 'transfer_request') ? {1:true, 4:true, 5:true} : {};
}
function _syncWizardNavFlow(){
  var skip = _appSkippedSteps();
  [1,4,5].forEach(function(i){
    var b = document.getElementById('spb_'+i);
    if(b) b.style.display = skip[i] ? 'none' : '';
  });
  var n0 = document.getElementById('nav_next_0');
  if(n0) n0.innerHTML = skip[1] ? 'Next: Co-Applicant &rarr;' : 'Next: Employment &amp; Income &rarr;';
  var n3 = document.getElementById('nav_next_3');
  if(n3) n3.innerHTML = skip[4] ? 'Next: Documents &rarr;' : 'Next: Emergency Contacts &rarr;';
}
window._syncWizardNavFlow = _syncWizardNavFlow;

// Internal-notes step is a side panel, not part of the wizard flow. We skip
// the validation/auto-save/progress-bar machinery for it.
function _isStaffSession(){
  var s = window.HOUSING_SESSION || {};
  return !!(s.email && s.role);
}

// ── Step navigation ──
function goTo(s){
  // Internal-notes tab — side panel, bypass wizard flow entirely.
  if (s === 11) { _openAppNotesStep(); return; }

  // Applicants never visit the staff-only steps. If they somehow target one
  // (saved-state restore, deep link, programmatic), forward them to the next
  // visible step in the flow.
  if((s === 9 || s === 10) && !_isHmOrEdRole()) { return goTo(6); }

  // Keep the progress pills + forward-button labels in sync with the current
  // application type, then skip any step that doesn't apply (file update /
  // transfer). Never land on a skipped step — jump in the direction of travel.
  _syncWizardNavFlow();
  var _skip = _appSkippedSteps();
  if(_skip[s] && s !== cur){
    var _dir = (s >= cur) ? 1 : -1;
    var _t = s + _dir;
    while(_t > 0 && _t < 8 && _skip[_t]) _t += _dir;
    if(_t < 0) _t = 0;
    if(_t > 8) _t = 8;
    return goTo(_t);
  }

  // ── Run validation BEFORE any DOM changes ──
  if(cur===0 && s>0){
    var errs=validateStep0 ? validateStep0() : [];
    if(errs.length){ showStep0Errors(errs); return; }
    clearStepErrors('step0', 'step0_error_banner');
  }
  if(cur===1 && s>1){
    var incErrs=validateStep1 ? validateStep1() : [];
    if(incErrs.length){ showStepErrors('step1',incErrs,'step1_error_banner'); return; }
    clearStepErrors('step1','step1_error_banner');
  }
  if(cur===2 && s>2){
    var coErrs=validateStep2 ? validateStep2() : [];
    if(coErrs.length){ showStepErrors('step2',coErrs,'step2_error_banner'); return; }
    clearStepErrors('step2','step2_error_banner');
  }
  if(cur===3 && s>3){
    var habErrs=validateStep3 ? validateStep3() : [];
    if(habErrs.length){ showStepErrors('step3',habErrs,'step3_error_banner'); return; }
    clearStepErrors('step3','step3_error_banner');
  }
  if(cur===4 && s>4){
    var refErrs=validateStep4 ? validateStep4() : [];
    if(refErrs.length){ showStepErrors('step4',refErrs,'step4_error_banner'); return; }
    clearStepErrors('step4','step4_error_banner');
  }
  if(cur===5 && s>5){
    var petErrs=validateStep5 ? validateStep5() : [];
    if(petErrs.length){ showStepErrors('step5',petErrs,'step5_error_banner'); return; }
    clearStepErrors('step5','step5_error_banner');
  }

  // Auto-save draft on every forward step. saveApplicationRecord now routes
  // through the local-first wrapper internally, so we don't need to re-queue
  // here — just trigger the save and refresh the Notes tab.
  if(s > cur) {
    var _ds = saveApplicationRecord({draft: true});
    if(_ds) {
      // Application now exists in-memory → enable the Internal Notes tab.
      if (typeof _refreshAppNotesTabVisibility === 'function') _refreshAppNotesTabVisibility();
    }
  }

  // ── All validation passed — now switch steps ──
  var _stepCur=document.getElementById('step'+cur); if(_stepCur) _stepCur.classList.remove('on');
  var _stepS=document.getElementById('step'+s); if(_stepS) _stepS.classList.add('on');

  const pct=Math.round((s/(STEPS-1))*100);
  const pf=document.getElementById('pfill');if(pf)pf.style.width=pct+'%';
  const pp=document.getElementById('pPct');if(pp)pp.textContent=pct+'%';

  cur=s;
  window.scrollTo(0,0);
  // Shelter-allowance panel reflects income rows + marital + household —
  // recompute whenever the Employment & Income step is entered.
  if(s === 1 && typeof _updateAssistPanel === 'function') _updateAssistPanel();
  // Init DocLibrary when user reaches step 6 (Documents)
  if(s === 6) _initStep6DocLib();
  // Restore toggle states for new step

  // Sync step progress bar — fill line + step states. Pills carry STATE
  // (✓ done / filled current / hollow upcoming), never numbers. Order and
  // "done" are computed from the VISIBLE pills in DOM order, so role-gated
  // steps (9/10, which the old fixed loop never touched) and type-skipped
  // steps can't desync anything.
  var _pillDefs = [
    {id:'spb_0',step:0},{id:'spb_1',step:1},{id:'spb_2',step:2},{id:'spb_3',step:3},
    {id:'spb_4',step:4},{id:'spb_5',step:5},{id:'spb_9',step:9},{id:'spb_10',step:10},
    {id:'spb_6',step:6},{id:'spb_7',step:8}
  ];
  var _visible = _pillDefs.filter(function(p){
    var b = document.getElementById(p.id);
    return b && getComputedStyle(b).display !== 'none';
  });
  var _activeIdx = -1;
  _visible.forEach(function(p, i){ if(p.step === s) _activeIdx = i; });
  var _fill = document.getElementById('spb_fill');
  if(_fill && _activeIdx >= 0 && _visible.length > 1) {
    _fill.style.width = Math.round((_activeIdx / (_visible.length - 1)) * 100) + '%';
  }
  _pillDefs.forEach(function(p){
    var _btn = document.getElementById(p.id);
    if(!_btn) return;
    var _idx    = _visible.indexOf(p);
    var _active = p.step === s;
    var _done   = _activeIdx >= 0 && _idx >= 0 && _idx < _activeIdx;
    _btn.classList.toggle('active', _active);
    _btn.classList.toggle('done', _done && !_active);
    var _dot = _btn.querySelector('.spb-dot');
    if(_dot) {
      _dot.innerHTML = (_done && !_active)
        ? '<svg viewBox="0 0 10 10" width="8" height="8"><polyline points="1,5 4,8 9,2" stroke="currentColor" stroke-width="2" fill="none"/></svg>'
        : '';
    }
  });

  // Leaving the Internal Notes row — reset its highlight.
  var _notesBtn = document.getElementById('spb_notes_row');
  if (_notesBtn) _notesBtn.classList.remove('active');

  if(s===7){ goTo(8); return; }
  if(s===8){
    setTimeout(function(){
      triggerV2Score();
      // Populate review summary + approval flow
      if(typeof popReview === 'function') popReview();
      // Show/hide co-applicant signature block based on current co_status
      var _coSel   = document.getElementById('co_status');
      var _coBlock = document.getElementById('sig_coapplicant_block');
      if(_coBlock) _coBlock.style.display = (_coSel && _coSel.value==='yes') ? 'block' : 'none';
      // Init signature pads
      if(typeof initSignaturePads === 'function') initSignaturePads();
      // Restore signature drawings if editing an existing application
      if(window._pendingSigRestore) {
        var _sr = window._pendingSigRestore;
        setTimeout(function(){
          // Use _restoreSignature (not _restoreSigCanvas) so typed/wet
          // signatures restore to their tab + input and survive a re-save.
          var _rs = (typeof _restoreSignature === 'function') ? _restoreSignature : _restoreSigCanvas;
          _rs('sig_canvas_app',   _sr.applicant   && _sr.applicant.image);
          _rs('sig_canvas_co',    _sr.coApplicant && _sr.coApplicant.image);
          _rs('sig_canvas_staff', _sr.staff       && _sr.staff.image);
          window._pendingSigRestore = null;
        }, 200);
      }
      // ── Auto-populate staff name and today's date ──
      var _today = new Date().toISOString().slice(0,10);
      var _staffNameEl = document.getElementById('sig_staff');
      var _staffDateEl = document.getElementById('sig_recv');
      var _sessionName = (window.HOUSING_SESSION && window.HOUSING_SESSION.name) ? window.HOUSING_SESSION.name : (window.currentUser && window.currentUser.name ? window.currentUser.name : '');
      if(_staffNameEl && !_staffNameEl.value && _sessionName) _staffNameEl.value = _sessionName;
      if(_staffDateEl && !_staffDateEl.value) _staffDateEl.value = _today;
      // ── Role-based unlock + auto-populate for HM/ED audit fields ──
      var _role = window.currentRole || '';
      var _hmNameEl = document.getElementById('sig_hm_name');
      var _hmDateEl = document.getElementById('sig_hm_date');
      var _edNameEl = document.getElementById('sig_ed_name');
      var _edDateEl = document.getElementById('sig_ed_date');
      if(ROLE.isManagement(_role)) {
        // Unlock HM fields for HM and ED
        if(_hmNameEl) { _hmNameEl.removeAttribute('readonly'); _hmNameEl.style.borderBottom = '1px solid var(--yellow)'; }
        if(_hmDateEl) { _hmDateEl.removeAttribute('readonly'); _hmDateEl.style.borderBottom = '1px solid var(--yellow)'; }
        if(APPROVAL_AUTHORITY.can('reviewApplication', _role) && _sessionName) {
          if(_hmNameEl && !_hmNameEl.value) _hmNameEl.value = _sessionName;
          if(_hmDateEl && !_hmDateEl.value) _hmDateEl.value = _today;
        }
        // Offer the other active Housing Managers as a changeable dropdown.
        if(typeof wireApproverPicker === 'function') wireApproverPicker('sig_hm_name', 'housing_manager');
      }
      if(APPROVAL_AUTHORITY.can('finalApproveApp', _role)) {
        // Unlock ED fields for ED only
        if(_edNameEl) { _edNameEl.removeAttribute('readonly'); _edNameEl.style.borderBottom = '1px solid var(--yellow)'; }
        if(_edDateEl) { _edDateEl.removeAttribute('readonly'); _edDateEl.style.borderBottom = '1px solid var(--yellow)'; }
        if(_sessionName) {
          if(_edNameEl && !_edNameEl.value) _edNameEl.value = _sessionName;
          if(_edDateEl && !_edDateEl.value) _edDateEl.value = _today;
        }
        // Offer the other active Executive Directors as a changeable dropdown.
        if(typeof wireApproverPicker === 'function') wireApproverPicker('sig_ed_name', 'ed');
      }
    },150);
  }
}

// ── Dynamic rows ──
function addIncome(){
  var list=document.getElementById('incomeList');
  var n=list.querySelectorAll('.rrow').length+1;
  var div=document.createElement('div');div.className='rrow';
  div.innerHTML=''
    +'<div class="rhdr"><span class="rlbl">Record '+n+'</span><button class="btn-rm" onclick="rmRow(this)">Remove</button></div>'
    +'<div class="fg c3">'
    +'<div class="f"><label>Person <span class="r">*</span></label>'
    +'<select data-role="person" onchange="onIncomePersonChange(this)">'
    +'<option value="">Select person</option>'
    +'<option value="Applicant">Applicant</option>'
    +'<option value="Co-Applicant">Co-Applicant</option>'
    +'</select></div>'
    +'<div class="f"><label data-lbl="incType">Income Type</label>'
    +'<select data-role="incType" onchange="onIncomeTypeChange(this)" disabled style="opacity:.5">'
    +'<option value="">Select type</option>'
    +'<option value="Employed">Employed</option>'
    +'<option value="Self-Employment">Self-Employment</option>'
    +'<option value="OW">OW (Ontario Works)</option>'
    +'<option value="ODSP">ODSP</option>'
    +'<option value="CPP">CPP</option>'
    +'<option value="EI">EI (Employment Insurance)</option>'
    +'<option value="Pension">Pension</option>'
    +'<option value="Other">Other</option>'
    +'<option value="No Income">No Income</option>'
    +'</select></div>'
    +'<div class="f"><label data-lbl="empStatus">Employment Status</label>'
    +'<select data-role="empStatus" disabled style="opacity:.5">'
    +'<option value="">Select</option>'
    +'<option value="Full-Time">Full-Time</option>'
    +'<option value="Part-Time">Part-Time</option>'
    +'<option value="Seasonal">Seasonal</option>'
    +'<option value="Contract">Contract</option>'
    +'<option value="Unemployed">Unemployed</option>'
    +'</select></div>'
    +'</div>'
    +'<div data-grp="employer_grp">'
    +'<div class="js-lbl-muted" style="margin:10px 0 6px;">Employer Details</div>'
    +'<div class="fg c3">'
    +'<div class="f"><label>Employer Name <span class="r">*</span></label><input data-role="empName" type="text" placeholder="Employer or N/A"/></div>'
    +'<div class="f"><label>Employer Phone <span class="r">*</span></label><input data-role="empPhone" type="tel" placeholder="(705)-555-0100" oninput="fmtPhone(this)"/></div>'
    +'<div class="f"><label>Manager / Supervisor <span class="r">*</span></label><input data-role="mgr" type="text"/></div>'
    +'<div class="f"><label>Start / Hire Date <span class="r">*</span></label><input data-role="startDate" type="date" onchange="calcDuration(this)"/></div>'
    +'<div class="f"><label>Duration</label><input type="text" data-role="duration" readonly placeholder="Calculated from start date" style="background:var(--bg);color:var(--muted);cursor:default;"/></div>'
    +'<div class="f"><label>Employer Address <span class="r">*</span></label><input data-role="empAddr" type="text" placeholder="Address"/></div>'
    +'</div></div>'
    +'<div data-grp="employer_optional_grp">'
    +'<div class="js-lbl-muted" style="margin:10px 0 6px;">Employer / Source Details</div>'
    +'<div class="fg c3">'
    +'<div class="f"><label>Employer / Source Name</label><input type="text" placeholder="Employer or source"/></div>'
    +'<div class="f"><label>Phone</label><input type="tel" placeholder="(705)-555-0100" oninput="fmtPhone(this)"/></div>'
    +'<div class="f"><label>Manager / Supervisor</label><input type="text"/></div>'
    +'<div class="f"><label>Start / Hire Date</label><input data-role="startDate" type="date" onchange="calcDuration(this)"/></div>'
    +'<div class="f"><label>Duration</label><input type="text" data-role="duration" readonly placeholder="Calculated from start date" style="background:var(--bg);color:var(--muted);cursor:default;"/></div>'
    +'<div class="f"><label>Address</label><input type="text" placeholder="Address"/></div>'
    +'</div></div>'
    +'<div data-grp="amount_grp">'
    +'<div class="js-lbl-muted" style="margin:10px 0 6px;">Income Amount</div>'
    +'<div class="fg c2">'
    +'<div class="f"><label>Primary Income &amp; Period <span class="r">*</span></label>'
    +'<div style="display:flex;gap:6px;align-items:center;">'
    +'<input type="text" placeholder="$0" oninput="fmtCurrency(this)" inputmode="numeric" style="flex:1;"/>'
    +'<select data-role="incPeriod" required style="width:110px;padding:8px 6px;border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:6px;"><option value="">— Period * —</option><option value="month">/ Month</option><option value="annual">/ Year</option></select>'
    +'</div></div>'
    +'<div class="f"><label>Other / Additional Income</label>'
    +'<div style="display:flex;gap:6px;align-items:center;">'
    +'<input type="text" placeholder="$0" oninput="fmtCurrency(this)" inputmode="numeric" style="flex:1;"/>'
    +'<select style="width:110px;padding:8px 6px;"><option value="month">/ Month</option><option value="annual">/ Year</option></select>'
    +'</div></div>'
    +'<div class="f"><label>Other Income Source</label><input type="text" placeholder="e.g. rental, child support"/></div>'
    +'<div class="f"><label>If Unemployed — Source</label><input type="text" placeholder="Describe source"/></div>'
    +'</div></div>'
    +'<div data-grp="notes_grp">'
    +'<div class="f" style="margin-top:8px;"><label>Notes</label>'
    +'<textarea rows="2" placeholder="Notes..." style="width:100%;padding:8px 10px;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:13px;resize:vertical;"></textarea>'
    +'</div></div>';
  list.appendChild(div);
  if (typeof applyRequiredFields === 'function') applyRequiredFields();
}

function onIncomePersonChange(sel) {
  if(typeof _updateAssistPanel === 'function') setTimeout(_updateAssistPanel, 0);
  var row = sel.closest('.rrow');
  var hasPerson = sel.value !== '';
  var typeSel   = row.querySelector('[data-role="incType"]');
  var statusSel = row.querySelector('[data-role="empStatus"]');
  var typeLbl   = row.querySelector('[data-lbl="incType"]');
  var statusLbl = row.querySelector('[data-lbl="empStatus"]');
  if(typeSel)   { typeSel.disabled = !hasPerson; typeSel.style.opacity = hasPerson ? '1' : '.5'; if(!hasPerson) typeSel.value = ''; }
  if(statusSel) { statusSel.disabled = !hasPerson; statusSel.style.opacity = hasPerson ? '1' : '.5'; if(!hasPerson) statusSel.value = ''; }
  if(typeLbl)   typeLbl.innerHTML   = hasPerson ? 'Income Type <span class="r">*</span>' : 'Income Type';
  if(statusLbl) statusLbl.innerHTML = hasPerson ? 'Employment Status <span class="r">*</span>' : 'Employment Status';
  if(typeSel) onIncomeTypeChange(typeSel);
}

function onIncomeTypeChange(sel) {
  if(!sel) return;
  if(typeof _updateAssistPanel === 'function') setTimeout(_updateAssistPanel, 0);
  var row  = sel.closest('.rrow');
  if(!row) return;
  var type = sel.value;
  var isEmployed = (type === 'Employed');
  var hasType    = (type !== '');
  var empGrp    = row.querySelector('[data-grp="employer_grp"]');
  var empOpt    = row.querySelector('[data-grp="employer_optional_grp"]');
  var amtGrp    = row.querySelector('[data-grp="amount_grp"]');
  var notesGrp  = row.querySelector('[data-grp="notes_grp"]');
  if(empGrp)   empGrp.style.display   = isEmployed ? 'block' : 'none';
  if(empOpt)   empOpt.style.display   = (!isEmployed && hasType) ? 'block' : 'none';
  if(amtGrp)   amtGrp.style.display   = hasType ? 'block' : 'none';
  if(notesGrp) notesGrp.style.display = hasType ? 'block' : 'none';
}

function addHab(){
  const list=document.getElementById('habList');
  const n=list.querySelectorAll('.rrow').length+1;
  const div=document.createElement('div');div.className='rrow';
  div.innerHTML=''
    +'<div class="rhdr"><span class="rlbl">Member '+n+'</span><button class="btn-rm" onclick="rmRow(this)">Remove</button></div>'
    +'<div class="fg c3">'
    +'<div class="f"><label>First Name <span class="r">*</span></label><input type="text" data-role="habFn"/></div>'
    +'<div class="f"><label>Last Name <span class="r">*</span></label><input type="text" data-role="habLn"/></div>'
    +'<div class="f"><label>Date of Birth <span class="r">*</span></label><input type="date" data-role="habDob" onchange="triggerV2Score()"/></div>'
    +'<div class="f"><label>Relationship <span class="r">*</span></label>'
    +'<select data-role="habRel"><option value="">Select</option><option>Spouse</option><option>Child</option><option>Parent</option><option>Sibling</option><option>Other</option></select></div>'
    +'<div class="f"><label>Band Member #</label><input type="number"/></div>'
    +'<div class="f"><label>Accessibility</label>'
    +'<select><option>None</option><option>Wheelchair Accessible</option><option>Visual Impairment</option><option>Hearing Impairment</option><option>Other</option></select></div>'
    +'</div>'
    +'<div class="js-lbl-muted" style="margin:10px 0 6px;">Income</div>'
    +'<div class="fg c3">'
    +'<div class="f"><label>Income Source</label>'
    +'<select>'
    +'<option value="">Select (optional)</option>'
    +'<option value="Employed">Employed</option>'
    +'<option value="Self-Employment">Self-Employment</option>'
    +'<option value="OW">OW (Ontario Works)</option>'
    +'<option value="ODSP">ODSP</option>'
    +'<option value="CPP">CPP</option>'
    +'<option value="EI">EI (Employment Insurance)</option>'
    +'<option value="Pension">Pension</option>'
    +'<option value="Other">Other</option>'
    +'</select></div>'
    +'<div class="f"><label>Income Amount ($)</label>'
    +'<input type="text" placeholder="$0" oninput="fmtCurrency(this)" inputmode="numeric"/></div>'
    +'<div class="f"><label>Frequency</label>'
    +'<select>'
    +'<option value="">— Select —</option>'
    +'<option value="monthly">Monthly</option>'
    +'<option value="biweekly">Bi-Weekly</option>'
    +'<option value="weekly">Weekly</option>'
    +'<option value="annual">Annual</option>'
    +'</select></div>'
    +'</div>';
  list.appendChild(div);
  if (typeof applyRequiredFields === 'function') applyRequiredFields();
  if(typeof calcPersonsOverStandard === "function") calcPersonsOverStandard();
  if(typeof triggerV2Score === "function") triggerV2Score();
}
function addRef(){
  var list=document.getElementById('refList');
  var n=list.querySelectorAll('.rrow').length+1;
  var div=document.createElement('div');div.className='rrow';
  div.innerHTML=''
    +'<div class="rhdr"><span class="rlbl">Emergency Contact '+n+'</span><button class="btn-rm" onclick="rmRow(this)">Remove</button></div>'
    +'<div class="fg c3">'
    +'<div class="f"><label>First Name <span class="r">*</span></label><input type="text" data-role="refFn"/></div>'
    +'<div class="f"><label>Last Name <span class="r">*</span></label><input type="text" data-role="refLn"/></div>'
    +'<div class="f"><label>Relationship <span class="r">*</span></label>'
    +'<select data-role="refRel">'
    +'<option value="">Select</option>'
    +'<option value="Personal">Personal</option>'
    +'<option value="Professional">Professional</option>'
    +'<option value="Community Member">Community Member</option>'
    +'<option value="Former Landlord">Former Landlord</option>'
    +'<option value="Other">Other</option>'
    +'</select></div>'
    +'<div class="f"><label>Phone <span class="r">*</span></label><input type="tel" data-role="refPhone" oninput="fmtPhone(this)"/></div>'
    +'<div class="f"><label>Email <span class="r hidden">*</span></label><input type="email" data-role="refEmail"/></div>'
    +'</div>';
  list.appendChild(div);
  if (typeof applyRequiredFields === 'function') applyRequiredFields();
}
function addPet(){
  var list=document.getElementById('petList');
  var n=list.querySelectorAll('.rrow').length+1;
  var div=document.createElement('div');div.className='rrow';
  div.innerHTML=''
    +'<div class="rhdr"><span class="rlbl">Pet '+n+'</span><button class="btn-rm" onclick="rmRow(this)">Remove</button></div>'
    +'<div class="fg c3">'
    +'<div class="f"><label>Pet Name <span class="r">*</span></label><input type="text" data-role="petName" placeholder="Pet name"/></div>'
    +'<div class="f"><label>Pet Type <span class="r">*</span></label>'
    +'<select data-role="petType">'
    +'<option value="">Select</option>'
    +'<option value="Dog">Dog</option>'
    +'<option value="Cat">Cat</option>'
    +'<option value="Bird">Bird</option>'
    +'<option value="Fish">Fish</option>'
    +'<option value="Reptile">Reptile</option>'
    +'<option value="Other">Other</option>'
    +'</select></div>'
    +'<div class="f"><label>Size <span class="r">*</span></label>'
    +'<select data-role="petSize">'
    +'<option value="">Select</option>'
    +'<option value="Small">Small</option>'
    +'<option value="Medium">Medium</option>'
    +'<option value="Large">Large</option>'
    +'</select></div>'
    +'<div class="f s3"><label>Description</label><textarea rows="2" style="width:100%;padding:8px 10px;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:13px;resize:vertical;"></textarea></div>'
    +'</div>';
  list.appendChild(div);
  if (typeof applyRequiredFields === 'function') applyRequiredFields();
}
// ── Rent-model derivations (single sources of truth — never asked twice) ─────
// Assistance program: the APPLICANT's income rows, stable values 'OW'/'ODSP'.
function _appAssistProgram(){
  var prog = '';
  document.querySelectorAll('#incomeList .rrow').forEach(function(row){
    if(prog) return;
    var p = (row.querySelector('[data-role="person"]')||{}).value;
    var t = (row.querySelector('[data-role="incType"]')||{}).value;
    if(p === 'Applicant' && (t === 'OW' || t === 'ODSP')) prog = t;
  });
  return prog;
}
// Spouse indicator: Marital Status (Married / Common-Law) or a household
// member recorded as Spouse — the existing fields, not a duplicate question.
function _appSpouseIndicator(){
  var m = (document.getElementById('marital')||{}).value || '';
  if(m === 'Married' || m === 'Common-Law') return 1;
  var hasSpouse = false;
  document.querySelectorAll('#habList .rrow').forEach(function(row){
    if(((row.querySelector('[data-role="habRel"]')||{}).value) === 'Spouse') hasSpouse = true;
  });
  return hasSpouse ? 1 : 0;
}
// Dependents: counted from the Household Members step (relationship Child, or
// any non-spouse member under 18 by DOB). Changed only through that step.
function _appDependentsCount(){
  var n = 0;
  document.querySelectorAll('#habList .rrow').forEach(function(row){
    var rel = (row.querySelector('[data-role="habRel"]')||{}).value || '';
    if(rel === 'Spouse') return;
    var dob = (row.querySelector('[data-role="habDob"]')||{}).value || '';
    var minor = false;
    if(dob){ var age = (Date.now() - new Date(dob).getTime()) / 31557600000; minor = age >= 0 && age < 18; }
    if(rel === 'Child' || minor) n++;
  });
  return n;
}
// Shelter-allowance panel on the Employment & Income step — visible only when
// the applicant's income type is OW/ODSP; read-only views + the configured
// maximum shelter amount from the applicable rate table.
function _updateAssistPanel(){
  var panel = document.getElementById('assistPanel'); if(!panel) return;
  var prog = _appAssistProgram();
  if(!prog){ panel.style.display = 'none'; return; }
  if(typeof computeRentCalc !== 'function'){ panel.style.display = 'none'; return; }
  var spouse = _appSpouseIndicator(), deps = _appDependentsCount();
  var calc = computeRentCalc({ incomeType: prog, spouse: spouse, dependents: deps, estimatedMarketRent: null });
  panel.style.display = '';
  var set = function(id, v){ var e = document.getElementById(id); if(e) e.value = v; };
  var t = document.getElementById('assist_title');
  if(t) t.textContent = 'Shelter Allowance — ' + calc.program;
  set('assist_spouse', spouse ? 'Yes' : 'No');
  set('assist_deps', String(deps));
  set('assist_size', String(calc.benefitUnitSize));
  set('assist_shelter', '$' + calc.shelterAmount.toFixed(2));
  var note = document.getElementById('assist_note');
  if(note) note.textContent = 'Rates effective ' + (calc.effectiveDate || 'n/a') + '. ' + (calc.sourceNote || '');
}
window._updateAssistPanel = _updateAssistPanel;

function rmRow(btn){
  const row=btn.closest('.rrow');if(row)row.remove();
  if(typeof _updateAssistPanel === 'function') _updateAssistPanel();
}

// ── File upload ──

// Called after application is submitted — uploads staged files to Supabase Storage
async function uploadPendingAppFiles(appId){
  var files = window._pendingAppFiles || [];
  if(!files.length) return;
  for(var i=0;i<files.length;i++){
    try {
      await sbUploadAndSave('application', appId, files[i], 'applications/'+appId);
    } catch(e){ console.warn('App file upload failed:', e); }
  }
  window._pendingAppFiles = [];
}

// ── Housing Classification ──
function getHousingClassification(){
  var el = document.getElementById('classification');
  if(el && el.value) return el.value;
  return 'Undetermined';
}

// ── Scoring rubric ──
const SCORING_RUBRIC={
  renos:[{max:2500,score:0},{max:5000,score:-1},{max:10000,score:-2},{max:20000,score:-3},{max:Infinity,score:-5}],
  arrears:[{max:500,score:0},{max:1500,score:-1},{max:3000,score:-2},{max:5000,score:-3},{max:Infinity,score:-5}],
  payment:[{max:12,score:5},{max:36,score:4},{max:60,score:3},{max:120,score:2},{max:180,score:1},{max:Infinity,score:0}],
  housingSizes:{1:{bedrooms:'Bachelor / 1-Bedroom'},2:{bedrooms:'1-Bedroom'},3:{bedrooms:'2-Bedroom'},4:{bedrooms:'3-Bedroom'},5:{bedrooms:'3-Bedroom'},6:{bedrooms:'4-Bedroom'},7:{bedrooms:'4+ Bedroom'}}
};
// ── Live Scoring Model (editable, stored in localStorage) ──
// ── Dashboard ──
// ── Dashboard (RETIRED) ─────────────────────────────────────────────────────
// The #dashView applications dashboard was retired when the landing page took
// over. ~370 lines of its render/menu/decline machinery (updateDashStats,
// renderDashTable, openAppMenu, _handleAppMenuAction, _finishDeclineApp,
// filterDash) were deleted in the audit cleanup — no HTML for them exists on
// any page, and every remaining call site is typeof-guarded so they no-op.
// The one piece of live behaviour they contained — declining an already-
// assigned applicant unwinds the unit — was ported into
// confirmApprovalAction (housing-modals.js) before deletion.

// ── View switchers ──
// ── Inventory view ──


// ── Match view ──


// ── Tenants view ──


// ── Renovations view ──

// ── Contractors view ──




// ══ RESTORED APP FORM FUNCTIONS ══

function updateRenosHint(){
  // Updates any UI hint related to the reno cost field — currently a no-op placeholder
}

function liveSync(){
  var cls=getHousingClassification();
  var el=document.getElementById('classificationCard');
  if(el)el.textContent=cls;
}

// ── Collect all form fields into an app object and save ──
// opts.draft: true → treat as autosave; status stays 'draft' until the user
//                    explicitly submits. Never downgrades an already-submitted
//                    or approved application back to draft.
// True when the application id belongs to a commercial (business/department)
// application — routed to the commercial modal instead of the residential one.
function _appIsCommercial(id){
  var a = (typeof applications !== 'undefined' ? applications : []).find(function(x){ return x.id === id; });
  return !!(a && a.appType === 'commercial');
}

// Signature image for save: read the live pad, but fall back to the PREVIOUSLY
// saved signature when the pad reads blank (e.g. the record was reopened and the
// drawn pad wasn't re-rendered before this save). This guarantees a re-save can
// never wipe an existing signature with '' — it only ever adds/keeps one.
function _appSigImg(appId, canvasId, sigKey){
  var cur = (typeof getSigDataURL === 'function') ? getSigDataURL(canvasId) : '';
  if (cur) return cur;
  var prev = (((applications || []).find(function(a){ return a && a.id === appId; })) || {}).sig || {};
  return (prev[sigKey] && prev[sigKey].image) || '';
}
// "Last saved" indicator in the wizard's progress footer. Called by
// saveApplicationWithDraftFallback (shared-data.js) after every application
// save — auto-saves on step navigation, type changes, deceased changes, and
// explicit saves all stamp it. ok === false means the save was queued locally
// (offline / degraded mode), which is still safe — say so instead of a time.
window._appStampSaved = function(appId, ok){
  try {
    var el = document.getElementById('app_saved_indicator');
    if (!el) return;
    var al = document.getElementById('appLayout');
    if (!al || al.style.display === 'none') return;               // wizard closed
    if (typeof currentAppId !== 'undefined' && currentAppId && appId && currentAppId !== appId) return;
    el.textContent = ok
      ? ('✓ Auto-saved ' + new Date().toLocaleTimeString([], {hour:'numeric', minute:'2-digit'}))
      : '🕒 Saved on this device — will sync when connection returns';
  } catch(e){}
};
function _appResetSavedIndicator(msg){
  var el = document.getElementById('app_saved_indicator');
  if (el) el.textContent = msg || '💾 Auto-saves as you go';
}
window._appResetSavedIndicator = _appResetSavedIndicator;

function saveApplicationRecord(opts){
  var appType = typeof getAppType === 'function' ? getAppType() : 'new_housing';
  var isFileUpdate = (appType === 'existing_tenant');

  // Helpers
  function fv(id){ var e=document.getElementById(id); return e ? e.value.trim() : ''; }
  function fb(id){ var e=document.getElementById(id); return e ? e.checked : false; }
  function fsel(id){ var e=document.getElementById(id); return e ? e.value : ''; }

  // Collect incomes
  var incomes=[];
  document.querySelectorAll('#incomeList .rrow').forEach(function(row){
    var person=row.querySelector('[data-role="person"]');
    var type=row.querySelector('[data-role="incType"]');
    var empName=row.querySelector('[data-role="empName"]');
    var incAmt=row.querySelector('[data-role="incPeriod"]');
    // grab primary income amount — first currency input inside amount_grp
    var amtGrp=row.querySelector('[data-grp="amount_grp"]');
    var amt=amtGrp?amtGrp.querySelector('input[type="text"]'):null;
    if(person&&person.value){
      incomes.push({
        person:person.value||'Applicant',
        incomeType:(type&&type.value)||'',
        employer:(empName&&empName.value)||'',
        primaryAmt:amt?parseFloat((amt.value||'').replace(/[^0-9.]/g,''))||null:null
      });
    }
  });
  // Fallback: read from any income inputs
  if(!incomes.length){
    var incType=document.querySelector('#incomeList select');
    var incAmt=document.querySelector('#incomeList input[type="number"]');
    if(incType&&incType.value) incomes.push({person:'Applicant',incomeType:incType.value,employer:'',primaryAmt:incAmt?parseFloat(incAmt.value)||null:null});
  }

  // Collect habitants
  var habitants=[];
  document.querySelectorAll('#habList .rrow').forEach(function(row){
    var fn=row.querySelector('[data-role="habFn"]');
    var ln=row.querySelector('[data-role="habLn"]');
    var dob=row.querySelector('[data-role="habDob"]');
    var rel=row.querySelector('[data-role="habRel"]');
    if(fn&&fn.value) habitants.push({fn:fn.value,ln:(ln&&ln.value)||'',dob:(dob&&dob.value)||'',relationship:(rel&&rel.value)||''});
  });

  // Co-applicant
  var hasCoApp = fsel('co_status')==='yes';
  var coApp = hasCoApp ? {
    fn:fv('co_fn'), ln:fv('co_ln'), dob:fv('co_dob'),
    band:fv('co_band'), reserve:fsel('co_reserve'),
    cell:fv('co_cell'), home:fv('co_home'), email:fv('co_email'),
    occDate:fv('coOccDate'),
    sameAddr: fb('co_same_addr') ? 'True' : 'False',
    hasArrears:        fb('coArrToggle'),
    arrBalAmt:         fb('coArrToggle') ? parseFloat((fv('coArrBalAmt')||'').replace(/[^0-9.]/g,''))||null : null,
    arrMonthlyPayment: fb('coArrToggle') ? parseFloat((fv('coArrMonthlyPayment')||'').replace(/[^0-9.]/g,''))||null : null,
    arrFrequency:      fb('coArrToggle') ? fsel('coArrFrequency') : null,
    arrPlanMonths:     fv('coArrPlanMonths') ? parseInt(fv('coArrPlanMonths'))||null : null,
    arrAgreementDate:  fv('coArrAgreementDate') || null,
    arrFirstDueDate:   fv('coArrFirstDueDate') || null
  } : null;

  // Pets
  var pets=[];
  document.querySelectorAll('#petList .rrow').forEach(function(row){
    var name=row.querySelector('[data-role="petName"]');
    var type=row.querySelector('[data-role="petType"]');
    var size=row.querySelector('[data-role="petSize"]');
    var desc=row.querySelector('textarea');
    if(type&&type.value) pets.push({
      name:(name&&name.value)||'',
      type:type.value,
      size:(size&&size.value)||'',
      desc:(desc&&desc.value)||''
    });
  });

  // References
  var refs=[];
  document.querySelectorAll('#refList .rrow').forEach(function(row){
    var fn=row.querySelector('[data-role="refFn"]');
    var ln=row.querySelector('[data-role="refLn"]');
    var ph=row.querySelector('[data-role="refPhone"]');
    var rel=row.querySelector('[data-role="refRel"]');
    var em=row.querySelector('[data-role="refEmail"]');
    if(fn&&fn.value) refs.push({
      fn:fn.value,
      ln:(ln&&ln.value)||'',
      phone:(ph&&ph.value)||'',
      relationship:(rel&&rel.value)||'',
      email:(em&&em.value)||''
    });
  });

  // Score — only for new housing applications
  var scoreTotal = 0, scoreTier = 'Unscored';
  if(!isFileUpdate && typeof calcScore === 'function'){
    var scoreEl = document.getElementById('sc_score_total');
    var tierEl  = document.getElementById('sc_score_tier');
    scoreTotal = scoreEl ? (parseInt(scoreEl.textContent)||0) : 0;
    scoreTier  = tierEl  ? (tierEl.textContent||'Low Priority') : 'Low Priority';
  }

  // Accessibility
  var accVals=[];
  document.querySelectorAll('#accChecks input[type="checkbox"]:checked,[data-acc]:checked').forEach(function(el){
    accVals.push(el.getAttribute('data-acc')||el.value);
  });
  var accStr = accVals.join(', ') || fsel('accessibility') || '0';

  var appId = currentAppId || (typeof generateAppId==='function' ? generateAppId() : 'APP-000000');
  currentAppId = appId;

  var appObj = {
    id:          appId,
    appType:     appType,        // 'new_housing' | 'existing_tenant'
    fn:          fv('fn'),
    ln:          fv('ln'),
    dob:         fv('dob'),
    band:        fv('band'),
    reserve:     fsel('reserve'),
    livingSituation: fsel('living_situation'),
    deceased:     fb('deceased_flag'),
    deceasedDate: fv('deceased_date'),
    // Shelter-allowance snapshot. Active only while the applicant's income
    // type is OW/ODSP; switching away RETAINS the last values marked inactive
    // (never silently deleted) and excludes them from the calculation.
    rentAssist: (function(){
      var p = (typeof _appAssistProgram === 'function') ? _appAssistProgram() : '';
      if(p){
        var sp = _appSpouseIndicator(), dp = _appDependentsCount();
        return { program: p, spouse: sp, dependents: dp, benefitUnitSize: 1 + sp + dp, active: true };
      }
      var _pv = (typeof currentAppId !== 'undefined' && currentAppId && typeof applications !== 'undefined')
        ? (applications.find(function(a){ return a && a.id === currentAppId; }) || {}).rentAssist : null;
      return _pv ? Object.assign({}, _pv, { active: false }) : null;
    })(),
    marital:     fsel('marital'),
    phone:       fv('phone'),
    email:       fv('email'),
    homeless:    fb('homelessToggle'),
    street:      fv('street'),
    city:        fv('city'),
    province:    fsel('prov'),
    postal:      fv('postal'),
    occDate:     fv('occDate'),
    appDate:     fv('appDate') || new Date().toISOString().slice(0,10),
    accessibility: accStr,
    haveHouse:   fb('hasHouseToggle'),
    homeCondition: fb('hasHouseToggle') ? fsel('homeCondition') : null,
    hasArrears:  fb('arrToggle'),
    arrBalAmt:   fb('arrToggle') ? parseFloat((fv('arrBalAmt')||'').replace(/[^0-9.]/g,''))||null : null,
    arrMonthlyPayment: fb('arrToggle') ? parseFloat((fv('arrMonthlyPayment')||'').replace(/[^0-9.]/g,''))||null : null,
    arrFrequency: fb('arrToggle') ? fsel('arrFrequency') : null,
    arrPlanMonths: fv('arrPlanMonths') ? parseInt(fv('arrPlanMonths'))||null : null,
    // ── V2 scoring fields ──
    urgentNeed:          fsel('urgent_need') || 'none',
    healthRisk:          fsel('health_risk') || 'none',
    personsOverStandard: parseInt(fv('persons_over_standard'))||0,
    loneParent:          fb('lone_parent'),
    elderInHousehold:    fb('elder_in_household'),
    householdDisability: fb('household_disability'),
    incomeStability:     fsel('income_stability') || 'stable',
    noPriorTenancy:      (fsel('no_prior_tenancy') || 'true') === 'true',
    rentPaymentHistory:  fsel('rent_payment_history') || 'no_history',
    unitCondition:       fsel('unit_condition') || 'no_history',
    tenancyConduct:      fsel('tenancy_conduct') || 'no_history',
    arrearsStatus:       (function() {
      if (!fb('arrToggle')) return 'none';
      return (parseInt(fv('arrPlanMonths'))||0) > 0 ? 'repayment' : 'no_repayment';
    })(),
    hasCoApp:    hasCoApp,
    coApp:       coApp,
    incomes:     incomes,
    habitants:   habitants,
    pets:        pets.length ? pets : [{name:null,type:null,size:null,desc:null}],
    references:  refs.length ? refs : [{fn:null,ln:null,phone:null,email:null,relationship:null}],
    classification: (function(){ var v=(document.getElementById('classification')||{}).value||''; if(v) return v; var t=((document.getElementById('classificationCard')||{}).textContent||'').trim(); return (t&&t!=='—')?t:'Undetermined'; })(),
    // Consent to share with other CLFN programs (PIPEDA-aligned). Recorded but
    // not gated — applicants can submit either way; HM/ED can see the choice
    // when reviewing. Timestamp + capturing role tell us when/by-whom the box
    // was last toggled.
    consentShareCLFN:    fb('consent_share_programs'),
    consentShareCLFNAt:  (function(){
      var existing = applications.find(function(a){ return a.id === appId; });
      var checkedNow = fb('consent_share_programs');
      // Stamp on the first save that has the box checked; preserve existing stamp.
      if(checkedNow && existing && existing.consentShareCLFNAt) return existing.consentShareCLFNAt;
      if(checkedNow) return new Date().toISOString();
      return null;
    })(),
    consentShareCLFNBy:  (function(){
      var existing = applications.find(function(a){ return a.id === appId; });
      var checkedNow = fb('consent_share_programs');
      if(checkedNow && existing && existing.consentShareCLFNBy) return existing.consentShareCLFNBy;
      if(checkedNow) return (typeof HOUSING_SESSION !== 'undefined' && HOUSING_SESSION.email) || (window.currentRole || 'staff');
      return null;
    })(),
    status:      (function(){
      // Autosave path: stay in 'draft' until the user explicitly submits, but
      // never downgrade an already submitted/approved application.
      if (opts && opts.draft) {
        var existingApp = applications.find(function(a){ return a.id === appId; });
        var existingStatus = existingApp && existingApp.status;
        if (!existingStatus || existingStatus === APP_STATUS.DRAFT) {
          return APP_STATUS.DRAFT;
        }
        return existingStatus;
      }
      var baseStatus = isFileUpdate ? 'file_update' : 'submitted';
      // Auto-approve on submit when this application's approval chain has a
      // step switched OFF in Settings (Approval Authority). Commercial apps
      // use their own review flow, so they're left on the base status.
      if (appType !== 'commercial' && typeof APPROVAL_AUTHORITY !== 'undefined'
          && APPROVAL_AUTHORITY.chainDisabled) {
        if (isFileUpdate) {
          if (APPROVAL_AUTHORITY.chainDisabled('file_update')) return 'hm_approved';
        } else if (APPROVAL_AUTHORITY.chainDisabled('application')) {
          return 'ed_approved';
        }
      }
      return baseStatus;
    })(),
    submittedAt: new Date().toISOString().slice(0,10),
    score:       isFileUpdate ? null : scoreTotal,
    // ── Ownership ──
    // On first create: set to the logged-in user.
    // On subsequent edits: carry forward the original owner so the
    // HE-L1 RLS rule (own-draft-only) keeps working correctly.
    created_by_email: (function() {
      var existing = applications.find(function(a){ return a.id === appId; });
      return (existing && existing.created_by_email)
        ? existing.created_by_email
        : (HOUSING_SESSION.email || null);
    })(),
    created_by_name: (function() {
      var existing = applications.find(function(a){ return a.id === appId; });
      return (existing && existing.created_by_name)
        ? existing.created_by_name
        : (HOUSING_SESSION.name || null);
    })(),
    tier:        isFileUpdate ? 'File Update' : scoreTier,
    scoreBreakdown: isFileUpdate ? {} : (window._lastScoreBreakdown || {}),

    // ── Signatures (applicant + co-applicant + staff) ──
    sig: {
      applicant: {
        name:  fv('sig_name'),
        date:  fv('sig_date'),
        image: _appSigImg(appId, 'sig_canvas_app', 'applicant')
      },
      coApplicant: hasCoApp ? {
        name:  fv('sig_co_name'),
        date:  fv('sig_co_date'),
        image: _appSigImg(appId, 'sig_canvas_co', 'coApplicant')
      } : null,
      staff: {
        name:  fv('sig_staff'),
        date:  fv('sig_recv'),
        image: _appSigImg(appId, 'sig_canvas_staff', 'staff')
      }
    },
    // Internal use fields (filled during approval process)
    hmSig: {
      name:     fv('sig_hm_name'),
      date:     fv('sig_hm_date'),
      decision: fv('sig_hm_decision') || (document.getElementById('sig_hm_decision') ? document.getElementById('sig_hm_decision').value : ''),
      notes:    fv('sig_hm_notes')
    },
    edSig: {
      name:     fv('sig_ed_name'),
      date:     fv('sig_ed_date'),
      decision: fv('sig_ed_decision') || (document.getElementById('sig_ed_decision') ? document.getElementById('sig_ed_decision').value : ''),
      notes:    fv('sig_ed_notes_sig')
    }
  };

  // Update or insert into applications array
  var idx = applications.findIndex(function(a){ return a.id === appId; });
  if(idx >= 0){
    applications[idx] = Object.assign({}, applications[idx], appObj);
  } else {
    applications.push(appObj);
  }

  // Persist via the local-first wrapper. The wrapper writes to the localStorage
  // draft queue synchronously before attempting the Supabase upsert, so a
  // PGRST303 / 401 / network blip cannot drop the row (including signature
  // images captured on the Review step). The next housing.html boot drains
  // the queue automatically.
  if (typeof saveApplicationWithDraftFallback === 'function') {
    saveApplicationWithDraftFallback(appObj).then(function(ok){
      if(!ok && typeof showToast === 'function') {
        showToast('Cloud sync failed — saved locally. Check your connection or open DevTools (F12) for details.', { type:'warning', duration:6000 });
      }
    });
  } else {
    // Defensive fallback if shared-data.js hasn't loaded yet.
    sbSaveApplication(appObj).catch(function(e){
      console.warn('App save failed:', e);
      if (typeof showToast === 'function') {
        showToast('Could not save application — ' + ((e && e.message) || 'check your connection'), { type:'error', duration:5000 });
      }
    });
  }

  // Audit — log save/update events
  var _isNew = (idx < 0);  // idx was set before push
  var _appType = appObj.appType === 'existing_tenant'  ? 'File Update'
              : appObj.appType === 'transfer_request' ? 'Transfer Request'
              : 'New Housing';
  var _status  = appObj.status || 'draft';
  if(_status === APP_STATUS.DRAFT) {
    // Only log draft saves once (first time)
    if(_isNew) auditEntry(appId, 'draft_saved', _appType + ' — draft created', window.currentRole||'staff');
  }
  // Signature capture audit
  if(appObj.sig) {
    if(appObj.sig.applicant && appObj.sig.applicant.image)
      auditEntry(appId, 'signature_captured', 'Applicant signature recorded — ' + (appObj.sig.applicant.name||'name not provided'), window.currentRole||'staff');
    if(appObj.sig.coApplicant && appObj.sig.coApplicant.image)
      auditEntry(appId, 'signature_captured', 'Co-applicant signature recorded — ' + (appObj.sig.coApplicant.name||'name not provided'), window.currentRole||'staff');
    if(appObj.sig.staff && appObj.sig.staff.image)
      auditEntry(appId, 'signature_captured', 'Staff signature recorded — ' + (appObj.sig.staff.name||'name not provided'), window.currentRole||'staff');
  }

  // Upload any staged documents to Supabase Storage
  if(typeof uploadPendingAppFiles === 'function' && (appObj.status === APP_STATUS.SUBMITTED || appObj.status === APP_STATUS.FILE_UPDATE)) {
    uploadPendingAppFiles(appId).catch(function(e){ console.warn('App file upload error:', e); });
  }

  return appId;
}

function renderApprovalFlow(){
  var el = document.getElementById('approvalFlow');
  if(!el) return;
  var isFileUpdate = typeof getAppType === 'function' && getAppType() === 'existing_tenant';
  var _hmLbl = CLFN_PERMS.roleLabel(ROLE.HOUSING_MANAGER);
  var _edLbl = CLFN_PERMS.roleLabel(ROLE.ED);
  var steps = isFileUpdate
    ? [{label:'Employee',icon:'📝',done:true},{label:_hmLbl,icon:'✅',done:false}]
    : [{label:'Employee',icon:'📝',done:true},{label:_hmLbl,icon:'🔍',done:false},{label:_edLbl,icon:'✅',done:false}];
  el.innerHTML = steps.map(function(s,i){
    var circleStyle = s.done
      ? 'background:var(--yellow);color:var(--text);border:2px solid var(--yellow);'
      : 'background:var(--surface);color:var(--muted);border:2px solid var(--border);';
    var html = '<div style="display:flex;flex-direction:column;align-items:center;gap:4px;">'
      +'<div style="width:36px;height:36px;border-radius:50%;'+circleStyle+'display:flex;align-items:center;justify-content:center;font-size:14px;">'+s.icon+'</div>'
      +'<div style="font-size:10px;font-weight:600;color:'+(s.done?'var(--text)':'var(--muted)')+';">'+s.label+'</div>'
      +'</div>';
    if(i < steps.length-1) html += '<div style="flex:1;height:2px;background:var(--border);align-self:center;margin:0 6px;min-width:20px;"></div>';
    return html;
  }).join('');
}

function popReview(){
  // Populate the review summary card in step 8
  var rc = document.getElementById('reviewContent');
  if(!rc) return;
  function fld(id){ var e=document.getElementById(id); return (e&&e.value&&e.value.trim())?e.value.trim():'—'; }
  function chk(id){ var e=document.getElementById(id); return e?e.checked:false; }
  function sel(id){ var e=document.getElementById(id); return (e&&e.options&&e.selectedIndex>=0&&e.options[e.selectedIndex].text!=='— Select —')?e.options[e.selectedIndex].text:'—'; }

  var fn=fld('fn'), ln=fld('ln');
  var name = (fn!=='—'||ln!=='—') ? (fn+' '+ln).replace('— ','').replace(' —','').trim() : '—';
  var isFileUpdate = typeof getAppType==='function' && getAppType()==='existing_tenant';
  var appId = (document.getElementById('appNumCard')||{}).textContent || (typeof currentAppId!=='undefined'?currentAppId:'—');

  function row(k,v,highlight){
    var vColor = highlight ? 'color:var(--danger);' : '';
    return '<div style="display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid var(--border);font-size:13px;">'
      +'<span style="color:var(--muted);flex-shrink:0;font-size:12px;">'+k+'</span>'
      +'<span style="font-weight:600;text-align:right;'+vColor+'">'+(v||'—')+'</span>'
      +'</div>';
  }
  function section(title, rowsHtml, icon){
    return '<div style="padding:16px 20px;border-bottom:1px solid var(--border);">'
      +'<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--muted);margin-bottom:12px;display:flex;align-items:center;gap:6px;">'
      +(icon?'<span>'+icon+'</span>':'')+'<span>'+title+'</span></div>'
      + rowsHtml + '</div>';
  }

  var html = '';

  // ── Dark header bar ──────────────────────────────────────────────────────
  html += '<div style="padding:14px 20px;background:var(--dark);border-bottom:2px solid var(--yellow);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">'
    +'<div>'
    +'<div style="font-size:16px;font-weight:700;color:#fff;">'+name+'</div>'
    +'<div style="font-size:11px;color:var(--muted);margin-top:2px;">'+appId+'  ·  '+(isFileUpdate?'File Update':'New Housing Application')+'</div>'
    +'</div>';
  // Score badge (if calculated)
  var scoreEl = document.getElementById('totalScore');
  var score = scoreEl ? parseInt(scoreEl.textContent)||0 : 0;
  if(score){
    var tierEl = document.getElementById('priorityTier');
    var tier = tierEl ? tierEl.textContent : '';
    html += '<div style="text-align:right;">'
      +'<div style="font-size:22px;font-weight:800;color:var(--yellow);">'+score+'</div>'
      +'<div style="font-size:10px;color:var(--muted);">'+tier+'</div>'
      +'</div>';
  }
  html += '</div>';

  // ── Personal Information ──────────────────────────────────────────────────
  var band = fld('band');
  var access = fld('accessibility') || (chk('acc_wheelchair')?'Wheelchair':chk('acc_visual')?'Visual':chk('acc_hearing')?'Hearing':'None');
  html += section('Personal Information',
    row('Full Name', name) +
    row('Date of Birth', fld('dob')) +
    row('Band Number', band!=='—'?band:'') +
    row('Reserve Status', fld('reserve')) +
    row('Living Situation', (typeof livingSituationLabel === 'function' ? livingSituationLabel(fld('living_situation')) : '') || '') +
    ((document.getElementById('deceased_flag')||{}).checked ? row('Deceased', 'Yes' + (fld('deceased_date') ? ' — ' + fld('deceased_date') : '')) : '') +
    row('Marital Status', fld('marital')) +
    row('Phone', fld('phone')) +
    row('Email', fld('email')) +
    (access && access!=='—'&&access!=='None' ? row('Accessibility Needs', access) : '')
  , '👤');

  // ── Current Address ───────────────────────────────────────────────────────
  var isHomelessReview = chk('homelessToggle');
  html += section('Current Address',
    (isHomelessReview
      ? row('Status', 'Homeless / No Fixed Address')
      : row('Address', [fld('street'),fld('city'),fld('prov')].filter(function(p){return p&&p!=='—';}).join(', ')||'—') +
        row('Postal Code', fld('postal'))
    ) +
    row('Application Date', fld('appDate')) +
    row('Expected Move-in', fld('occDate'))
  , '🏠');

  // ── Housing Needs ─────────────────────────────────────────────────────────
  var bedsEl = document.getElementById('f_bedrooms') || document.getElementById('f_bed') || document.getElementById('beds');
  var beds = bedsEl ? (bedsEl.value||'—') : '—';
  var classEl = document.getElementById('classificationCard');
  var classDropdown = document.getElementById('classification');
  var classification = (classDropdown && classDropdown.value) ? classDropdown.value : (classEl ? classEl.textContent : '—');
  var hasHouse = chk('hasHouseToggle');
  html += section('Housing Needs',
    row('Classification', classification!==''?classification:'—') +
    row('Bedrooms Requested', beds) +
    row('Currently Has a Unit', hasHouse?'Yes':'No') +
    (hasHouse ? row('Home Condition', fld('homeCondition')) : '')
  , '🔑');

  // ── Employment & Income ───────────────────────────────────────────────────
  var incomeRows = [];
  document.querySelectorAll('#incomeList .rrow').forEach(function(r){
    var sels = r.querySelectorAll('select');
    var inputs = r.querySelectorAll('input[type="text"],input[type="number"]');
    var person = sels[0]?sels[0].value:'';
    var type   = sels[1]?sels[1].value:'';
    var amt    = inputs[0]?inputs[0].value:'';
    if(person||type) incomeRows.push(row((person||'Income')+(type?' — '+type:''), amt||'On file'));
  });
  if(incomeRows.length) {
    html += section('Employment & Income', incomeRows.join(''), '💼');
  }

  // ── Nation arrears ───────────────────────────────────────────────────────
  if(chk('arrToggle')){
    html += section((window.NATION_CONFIG&&NATION_CONFIG.short||'')+' Arrears',
      row('Amount Owed', fld('arrBalAmt'), true) +
      row('Monthly Payment', fld('arrMonthAmt')) +
      row('Plan Duration', fld('arrPlanMonths')!=='—'?fld('arrPlanMonths')+' months':'—')
    , '⚠️');
  }

  // ── Co-Applicant ─────────────────────────────────────────────────────────
  if(fld('co_status')==='yes'){
    html += section('Co-Applicant',
      row('Name', (fld('co_fn')+' '+fld('co_ln')).trim().replace(/^—\s|—$/g,'')) +
      row('Date of Birth', fld('co_dob')) +
      row('Reserve Status', fld('co_reserve')) +
      row('Phone', fld('co_cell')) +
      row('Email', fld('co_email'))
    , '👥');
  }

  // ── Household Members ────────────────────────────────────────────────────
  var habRows = [];
  document.querySelectorAll('#habList .rrow').forEach(function(r){
    var txts = r.querySelectorAll('input[type="text"]');
    var relEl = r.querySelector('select');
    var fn2 = txts[0]?txts[0].value.trim():'';
    var ln2 = txts[1]?txts[1].value.trim():'';
    var rel = relEl?relEl.value:'';
    if(fn2||ln2) habRows.push(row((fn2+' '+ln2).trim(), rel||'—'));
  });
  if(habRows.length) html += section('Household Members ('+habRows.length+')', habRows.join(''), '👨‍👩‍👧');

  // ── References ───────────────────────────────────────────────────────────
  var refRows = [];
  document.querySelectorAll('#refList .rrow').forEach(function(r){
    var txts = r.querySelectorAll('input[type="text"]');
    var tels = r.querySelectorAll('input[type="tel"]');
    var fn3 = txts[0]?txts[0].value.trim():'';
    var ln3 = txts[1]?txts[1].value.trim():'';
    var ph  = tels[0]?tels[0].value.trim():'';
    if(fn3||ln3) refRows.push(row((fn3+' '+ln3).trim(), ph||'—'));
  });
  if(refRows.length) html += section('References ('+refRows.length+')', refRows.join(''), '📋');

  // ── Pets ─────────────────────────────────────────────────────────────────
  var petRows = [];
  document.querySelectorAll('#petList .rrow').forEach(function(r){
    var sels2 = r.querySelectorAll('select');
    var type2 = sels2[0]?sels2[0].value:'';
    var size  = sels2[1]?sels2[1].value:'';
    if(type2) petRows.push(row(type2, size||''));
  });
  if(petRows.length) html += section('Pets ('+petRows.length+')', petRows.join(''), '🐾');

  // ── Documents ────────────────────────────────────────────────────────────
  var docCount = document.querySelectorAll('#fileList .file-item').length;
  html += section('Documents',
    row('Files Attached', docCount > 0 ? docCount+' file'+(docCount!==1?'s':'') : 'None')
  , '📎');

  // ── Close ────────────────────────────────────────────────────────────────
  rc.innerHTML = html + ((typeof _rentCalcCardHtml === 'function') ? _rentCalcCardHtml() : '');
  // Render the approval flow diagram
  renderApprovalFlow();
}

// Confirm before submitting. Uses the branded showConfirm() helper from
// shared.js so we don't depend on per-page submitModal markup (which only
// existed on match.html — that's why the Submit button on housing.html
// silently did nothing before this fix).
// Returns { hard, soft, nameOnly }
//   hard     — exact email match (blocks submission)
//   soft     — same first name + last name + date of birth (warns, requires confirmation)
//   nameOnly — same first name + last name only, DOB absent or different (warns, requires confirmation)
// Excludes the current draft (currentAppId), archived apps, and declined apps.
function _findDuplicateApplications() {
  var allApps = (typeof applications !== 'undefined') ? applications : [];
  var fn    = ((document.getElementById('fn')||{}).value||'').trim().toLowerCase();
  var ln    = ((document.getElementById('ln')||{}).value||'').trim().toLowerCase();
  var dob   = ((document.getElementById('dob')||{}).value||'').trim();
  var email = ((document.getElementById('email')||{}).value||'').trim().toLowerCase();
  var hard = [], soft = [], nameOnly = [];
  allApps.forEach(function(a) {
    if (!a || a.archived || a.status === 'declined' || a.id === currentAppId) return;
    var aEmail = (a.email||'').trim().toLowerCase();
    var aFn    = (a.fn||'').trim().toLowerCase();
    var aLn    = (a.ln||'').trim().toLowerCase();
    var aDob   = (a.dob||'').trim();
    if (email && aEmail && email === aEmail) { hard.push(a); return; }
    if (fn && ln && fn === aFn && ln === aLn) {
      if (dob && aDob && dob === aDob) soft.push(a);
      else nameOnly.push(a);
    }
  });
  return { hard: hard, soft: soft, nameOnly: nameOnly };
}

function openSubmitModal(){
  popReview();
  var appType = (typeof getAppType==='function') ? getAppType() : 'new_housing';
  var isFileUpdate = (appType === 'existing_tenant');

  // ── Duplicate check ───────────────────────────────────────────────────────
  var _dups = _findDuplicateApplications();
  if (_dups.hard.length) {
    var d     = _dups.hard[0];
    var dName = (((d.fn||'')+' '+(d.ln||'')).trim()) || d.id;
    showConfirm({
      title:       'Duplicate Email — Cannot Submit',
      message:     'An application with this email address already exists:<br><br>'
                 + '<strong>' + escapeHtml(dName) + '</strong> &nbsp;·&nbsp; ' + escapeHtml(d.id) + ' &nbsp;·&nbsp; ' + escapeHtml(d.status||'unknown') + '<br><br>'
                 + 'Use a different email address, or archive the existing application before submitting.',
      confirmText: 'Open Existing',
      cancelText:  'Close'
    }).then(function(ok) {
      if (ok) window.location.href = 'housing.html?openApp=' + encodeURIComponent(d.id);
    });
    return;
  }

  function _proceed() {

  // If the applicant supplied an email, surface an inline opt-in to send
  // them a PDF copy along with the submit confirmation. Default ticked
  // because most applicants want their own record. If no email is on
  // file, skip the checkbox entirely (nothing to opt into).
  var emailEl       = document.getElementById('email');
  var coEmailEl     = document.getElementById('co_email');
  var applicantEmail = (emailEl && emailEl.value && emailEl.value.trim().toLowerCase()) || '';
  var coEmail        = (coEmailEl && coEmailEl.value && coEmailEl.value.trim().toLowerCase()) || '';
  var hasAnyEmail    = !!(applicantEmail || (coEmail && coEmail !== applicantEmail));

  var copyTarget = applicantEmail
    || coEmail
    || '';
  var copyLabel  = (applicantEmail && coEmail && coEmail !== applicantEmail)
    ? ('Email a PDF copy to ' + applicantEmail + ' and ' + coEmail)
    : ('Email a PDF copy to ' + copyTarget);

  var _submitTitle = isFileUpdate        ? 'Submit file update?'
                  : (appType === 'transfer_request') ? 'Submit transfer request?'
                  : 'Submit application?';
  var confirmOpts = {
    title:       _submitTitle,
    message:     'This will send the application to the Housing Manager for review. You will not be able to edit it after submission.',
    confirmText: 'Confirm Submit'
  };
  if (hasAnyEmail) {
    confirmOpts.checkbox = { label: copyLabel, defaultChecked: true };
  }

  showConfirm(confirmOpts).then(function(result){
    // showConfirm returns a plain boolean unless a checkbox was passed
    // in opts — then it returns { ok, checked }. Normalise.
    var ok       = (typeof result === 'object' && result !== null) ? !!result.ok      : !!result;
    var sendCopy = (typeof result === 'object' && result !== null) ? !!result.checked : false;
    if (!ok) return;
    finalSubmit({ sendApplicantCopy: sendCopy });
  });
  } // end _proceed

  if (_dups.soft.length) {
    var softLines = _dups.soft.slice(0, 3).map(function(a) {
      return '&bull; <strong>' + escapeHtml(((a.fn||'')+' '+(a.ln||'')).trim()||a.id) + '</strong>'
           + ' &nbsp;(' + escapeHtml(a.id) + ')&nbsp; &mdash; ' + escapeHtml(a.status||'unknown')
           + (a.appDate ? ' &nbsp;· Applied ' + escapeHtml(a.appDate) : '');
    }).join('<br>');
    showConfirm({
      title:       'Possible Duplicate Application',
      message:     'An application with the same name and date of birth already exists:<br><br>'
                 + softLines + '<br><br>Do you want to submit anyway?',
      confirmText: 'Submit Anyway',
      danger:      true
    }).then(function(ok) { if (ok) _proceed(); });
    return;
  }

  if (_dups.nameOnly.length) {
    var nameLines = _dups.nameOnly.slice(0, 3).map(function(a) {
      return '&bull; <strong>' + escapeHtml(((a.fn||'')+' '+(a.ln||'')).trim()||a.id) + '</strong>'
           + ' &nbsp;(' + escapeHtml(a.id) + ')&nbsp; &mdash; ' + escapeHtml(a.status||'unknown')
           + (a.appDate ? ' &nbsp;· Applied ' + escapeHtml(a.appDate) : '');
    }).join('<br>');
    showConfirm({
      title:       'Applicant Name Already Exists',
      message:     'An application with the same name already exists:<br><br>'
                 + nameLines + '<br><br>'
                 + 'Please confirm this is a different person before submitting.',
      confirmText: 'Submit Anyway',
      danger:      true
    }).then(function(ok) { if (ok) _proceed(); });
    return;
  }

  _proceed();
}

function finalSubmit(opts){
  opts = opts || {};
  var sendApplicantCopy = opts.sendApplicantCopy === true;
  var appType = (typeof getAppType==='function') ? getAppType() : 'new_housing';
  var isFileUpdate      = (appType === 'existing_tenant');
  var isTransferRequest = (appType === 'transfer_request');
  // An UPDATE is a re-submission of an application that already exists in the
  // system — it has a record ("application number") and a non-draft status.
  // A brand-new draft being submitted for the first time is NOT an update.
  var _priorApp = currentAppId ? applications.find(function(a){ return a.id === currentAppId; }) : null;
  var isUpdate  = !!(_priorApp && _priorApp.status && _priorApp.status !== 'draft');
  var actionLabel = isUpdate          ? 'application_updated'
                  : isFileUpdate      ? 'file_update_submitted'
                  : isTransferRequest ? 'transfer_request_submitted'
                  : 'application_submitted';
  var detail = isUpdate          ? 'Existing application updated and re-submitted by applicant — awaiting Housing Manager review'
             : isFileUpdate      ? 'File update submitted by applicant — awaiting Housing Manager review'
             : isTransferRequest ? 'Transfer / new housing request submitted by existing tenant — awaiting Housing Manager review'
             : 'New housing application submitted by applicant — awaiting Housing Manager review';
  auditEntry(currentAppId||'new', actionLabel, detail, 'Applicant');
  renderApprovalFlow();
  triggerV2Score();
  var id=saveApplicationRecord();
  var submittedApp = applications.find(function(a){ return a.id === id; }) || null;
  // If an approval step is switched off in Settings, saveApplicationRecord
  // returns an already-approved status (never the case for a normal submit).
  // Flag + audit it so it reads as a System auto-approval, not a person's.
  if (submittedApp && ((isFileUpdate && submittedApp.status === 'hm_approved')
        || (!isFileUpdate && appType !== 'commercial' && submittedApp.status === 'ed_approved'))) {
    submittedApp.approvalAuto = true;
    auditEntry(id, isFileUpdate ? 'file_update_auto_approved' : 'application_auto_approved',
      'Auto-approved on submit — approval disabled in Settings', 'System — approval disabled');
  }
  // Lock the applicant-side signature panels immediately — the document is
  // now a submitted record and the canvases shouldn't be alterable.
  if (typeof _lockApplicantSignatures === 'function') _lockApplicantSignatures();
  auditEntry(id, 'signatures_locked', 'Applicant / Co-Applicant / Staff signature panels locked on submission', window.currentRole||'staff');
  // Microsoft Graph notification pipeline — emails every active Housing
  // Manager resolved from the staff table. Fire-and-forget; UI never
  // blocks on delivery.
  if(typeof notifyApplicationSubmitted === 'function') notifyApplicationSubmitted(submittedApp, { isUpdate: isUpdate });
  // Confirmation email to the applicant (and co-applicant if a separate
  // address) with a PDF copy attached. Only fires when the applicant
  // opted in via the inline checkbox on openSubmitModal — keeps the
  // applicant in control and avoids sending when they don't want a copy.
  if(sendApplicantCopy && typeof notifyApplicationConfirmation === 'function') {
    notifyApplicationConfirmation(submittedApp);
  }
  showSubmissionConfirmation(id, isFileUpdate);
}

function showSubmissionConfirmation(appId, isFileUpdate) {
  // Remove any existing confirmation
  var existing = document.getElementById('submission_confirmation');
  if (existing) existing.remove();

  var applicantName = ((document.getElementById('fn')||{}).value||'') + ' ' + ((document.getElementById('ln')||{}).value||'');
  applicantName = applicantName.trim() || 'Applicant';
  var today = new Date().toLocaleDateString('en-CA', { year:'numeric', month:'long', day:'numeric' });

  var overlay = document.createElement('div');
  overlay.id = 'submission_confirmation';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:2000;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;padding:20px;';

  overlay.innerHTML = '<div style="background:var(--surface);border-radius:16px;max-width:520px;width:100%;padding:0;overflow:hidden;box-shadow:0 8px 40px rgba(0,0,0,0.5);">'
    // Header bar
    + '<div style="background:var(--dark);padding:20px 28px;border-bottom:3px solid var(--yellow);text-align:center;">'
    +   '<div style="font-size:36px;margin-bottom:8px;">✓</div>'
    +   '<div style="font-size:18px;font-weight:700;color:var(--yellow);">' + (isFileUpdate ? 'File Update Submitted' : 'Application Submitted') + '</div>'
    +   '<div style="font-size:12px;color:var(--txt-on-dark);margin-top:4px;">' + appId + '</div>'
    + '</div>'
    // Body
    + '<div style="padding:24px 28px;">'
    +   '<div style="font-size:14px;color:var(--text);margin-bottom:16px;">Thank you, <strong>' + applicantName + '</strong>. Your ' + (isFileUpdate ? 'file update' : 'housing application') + ' has been successfully submitted to the Housing Department.</div>'
    +   '<div style="background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:14px 18px;margin-bottom:20px;">'
    +     '<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:var(--muted);margin-bottom:10px;">Submission Details</div>'
    +     '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:12px;">'
    +       '<div><div class="js-lbl-xs mb-4">Application ID</div><div style="font-weight:700;color:var(--yellow);">' + appId + '</div></div>'
    +       '<div><div class="js-lbl-xs mb-4">Date Submitted</div><div style="font-weight:600;">' + today + '</div></div>'
    +       '<div><div class="js-lbl-xs mb-4">Status</div><div style="font-weight:600;color:var(--success);">Submitted — Awaiting HM Review</div></div>'
    +       '<div><div class="js-lbl-xs mb-4">Next Step</div><div style="font-weight:600;">Housing Manager review</div></div>'
    +     '</div>'
    +   '</div>'
    +   '<div style="font-size:12px;color:var(--muted);margin-bottom:20px;line-height:1.6;">The Housing Manager will review your application and contact you if additional information is required. Please keep your application ID for your records.</div>'
    +   '<div style="display:flex;gap:10px;justify-content:flex-end;">'
    +     '<button onclick="closeSubmissionConfirmation(true);" class="btn btn-ghost">Return Home</button>'
    +     '<button onclick="closeSubmissionConfirmation(false);" class="btn btn-primary">Done</button>'
    +   '</div>'
    + '</div>'
    + '</div>';

  document.body.appendChild(overlay);

  // Close on backdrop click
  overlay.addEventListener('click', function(e) {
    if (e.target === overlay) closeSubmissionConfirmation(false);
  });
}

function closeSubmissionConfirmation(returnHome) {
  var el = document.getElementById('submission_confirmation');
  if (el) el.remove();
  if (returnHome && typeof closeApplicationForm === 'function') closeApplicationForm();
}

function printApplicationPreview() {
  try {
  popReview();
  var today   = new Date().toLocaleDateString('en-CA');
  var logoSrc = (document.querySelector('.app-logo img')||{}).src || '';
  var appId   = currentAppId || '—';

  // Read every field — fall back to dash so rows always show
  function fld(id) {
    var e = document.getElementById(id);
    return (e && e.value && e.value.trim()) ? e.value.trim() : '—';
  }
  function chk(id) {
    var e = document.getElementById(id); return e ? e.checked : false;
  }

  var fn2  = fld('fn'),  ln2  = fld('ln');
  var name = (fn2 !== '—' || ln2 !== '—') ? (fn2+' '+ln2).replace('— ','').replace(' —','').trim() : '—';
  var hasCoApp = document.getElementById('co_status') && document.getElementById('co_status').value === 'yes';
  var hasHouse = chk('hasHouseToggle');
  var hasArr   = chk('arrToggle');

  // ── Sig images ──
  var sigApp   = getSigDataURL('sig_canvas_app');
  var sigCo    = getSigDataURL('sig_canvas_co');
  var sigStaff = getSigDataURL('sig_canvas_staff');
  var sigHM    = getSigDataURL('sig_canvas_hm');
  var sigED    = getSigDataURL('sig_canvas_ed');
  var hmName   = fld('sig_hm_name');
  var hmDate   = fld('sig_hm_date') !== '—' ? fld('sig_hm_date') : today;
  var hmDec    = fld('sig_hm_decision');
  var edSigName= fld('sig_ed_name');
  var edDate   = fld('sig_ed_date') !== '—' ? fld('sig_ed_date') : today;
  var edDec    = fld('sig_ed_decision');
  var sigName  = fld('sig_name') !== '—' ? fld('sig_name') : name;
  var sigDate  = fld('sig_date') !== '—' ? fld('sig_date') : today;
  var coFn     = fld('co_fn'), coLn = fld('co_ln');
  var coSigName= fld('sig_co_name') !== '—' ? fld('sig_co_name')
               : (coFn !== '—' || coLn !== '—') ? (coFn+' '+coLn).trim() : '—';
  var staffName= fld('sig_staff');
  var staffDate= fld('sig_recv') !== '—' ? fld('sig_recv') : today;

  // ── Helpers ──
  function row(k, v) {
    var val = (v !== null && v !== undefined && v !== '') ? v : '—';
    return '<tr>'
      +'<td style="padding:4px 10px;color:var(--muted);font-size:10px;font-weight:600;width:34%;'
      +'border-bottom:1px solid var(--border);vertical-align:top;">'+k+'</td>'
      +'<td style="padding:4px 10px;font-size:10px;border-bottom:1px solid var(--border);">'+val+'</td>'
      +'</tr>';
  }
  function section(title, body) {
    return '<div style="margin-bottom:12px;page-break-inside:avoid;">'
      +'<div style="font-size:9.5px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;'
      +'color:var(--muted);border-bottom:2.5px solid '+window._themeAccentHex()+';padding-bottom:3px;margin-bottom:0;">'
      +title+'</div>'
      +'<table class="std-tbl">'+body+'</table>'
      +'</div>';
  }
  function yn(v) { return v ? 'Yes' : 'No'; }
  function dollar(id) { var e=document.getElementById(id); return (e&&e.value) ? formatCurrency(parseCurrency(e.value)) : '—'; }
  function dollarQ(sel) { var e=document.querySelector(sel); return (e&&e.value) ? formatCurrency(parseCurrency(e.value)) : '—'; }

  // ── Income rows ──
  var incBody = '';
  document.querySelectorAll('#incomeList .rrow').forEach(function(r, i) {
    var sels = r.querySelectorAll('select');
    var nums = r.querySelectorAll('input[type="number"]');
    var txts = r.querySelectorAll('input[type="text"]');
    var person = sels[0] ? sels[0].value : '';
    var type   = sels[1] ? sels[1].value : '';
    var amt    = nums[0] && nums[0].value ? formatCurrency(parseCurrency(nums[0].value)) : '';
    var emp    = txts[0] ? txts[0].value : '';
    incBody += row(person || ('Income '+(i+1)), type+(amt?' — '+amt:'')+(emp?' · '+emp:''));
  });
  if(!incBody) incBody = row('Income / Employment', '—');

  // ── Household members ──
  var habBody = '';
  document.querySelectorAll('#habList .rrow').forEach(function(r, i) {
    var txts = r.querySelectorAll('input[type="text"]');
    var dt   = r.querySelector('input[type="date"]');
    var sel  = r.querySelector('select');
    var nm   = [(txts[0]?txts[0].value:''),(txts[1]?txts[1].value:'')].filter(Boolean).join(' ') || ('Member '+(i+1));
    habBody += row(nm, (sel?sel.value:'')+(dt&&dt.value?' · DOB: '+dt.value:''));
  });
  if(!habBody) habBody = row('Household Members', '—');

  // ── References ──
  var refBody = '';
  document.querySelectorAll('#refList .rrow').forEach(function(r, i) {
    var txts = r.querySelectorAll('input[type="text"]');
    var tels = r.querySelectorAll('input[type="tel"]');
    var ems  = r.querySelectorAll('input[type="email"]');
    var sel  = r.querySelector('select');
    var nm   = [(txts[0]?txts[0].value:''),(txts[1]?txts[1].value:'')].filter(Boolean).join(' ') || ('Reference '+(i+1));
    refBody += row(nm, (sel?sel.value:'')+(tels[0]&&tels[0].value?' · '+formatPhone(tels[0].value):'')+(ems[0]&&ems[0].value?' · '+ems[0].value:''));
  });
  if(!refBody) refBody = row('References', '—');

  // ── Pets ──
  var petBody = '';
  document.querySelectorAll('#petList .rrow').forEach(function(r, i) {
    var txts = r.querySelectorAll('input[type="text"]');
    var sels = r.querySelectorAll('select');
    var ta   = r.querySelector('textarea');
    var nm   = txts[0]?txts[0].value:'Pet '+(i+1);
    petBody += row(nm, [(sels[0]?sels[0].value:''),(sels[1]?sels[1].value:''),(ta?ta.value:'')].filter(Boolean).join(' · '));
  });

  // ── Arrears details ──
  var arrNums  = document.querySelectorAll('#arrBlk input[type="number"]');
  var arrDates = document.querySelectorAll('#arrBlk input[type="date"]');
  var arrSel   = document.querySelector('#arrBlk select');

  // ── Docs ──
  var docsBody = '';
  var docLabels = ['Government Issued Photo ID','Proof of Band Membership',
                   'Income / Employment Letter','Last 2 Pay Stubs',
                   'Utility Bills','Arrears Payment Agreement'];
  document.querySelectorAll('#step6 input[type="checkbox"]').forEach(function(cb, i) {
    docsBody += row(docLabels[i]||('Doc '+(i+1)), cb.checked ? '✓ Included' : '✗ Not included');
  });
  if(!docsBody) docsBody = row('Documents', '—');

  // ── Sig block (canvas) ──
  function sigBlock(label, pName, dt, imgSrc) {
    return '<div class="print-sec">'
      +'<div style="font-size:8.5px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;'
      +     'color:var(--muted);margin-bottom:5px;padding-bottom:3px;border-bottom:1px solid #ddd;">'+label+'</div>'
      +'<div style="display:grid;grid-template-columns:1fr 90px;gap:8px;margin-bottom:6px;">'
      +  '<div><div class="sig-lbl">Full Name</div>'
      +       '<div style="font-size:10.5px;font-weight:600;border-bottom:1px solid var(--border);padding-bottom:2px;min-height:15px;">'+pName+'</div></div>'
      +  '<div><div class="sig-lbl">Date</div>'
      +       '<div style="font-size:10px;border-bottom:1px solid var(--border);padding-bottom:2px;min-height:15px;">'+dt+'</div></div>'
      +'</div>'
      +(imgSrc
        ? '<img src="'+imgSrc+'" style="width:100%;height:65px;border:1px solid var(--border);border-radius:3px;object-fit:contain;background:var(--bg);display:block;"/>'
        : '<div style="width:100%;height:65px;border:1px solid var(--border);border-radius:3px;background:var(--bg);'
        +      'display:flex;align-items:center;justify-content:center;">'
        +   '<span style="font-size:9px;color:var(--border);">Sign here</span></div>')
      +'</div>';
  }

  // ── Internal sig block (pen on paper) ──
  function internalSig(label) {
    return '<div class="print-sec">'
      +'<div style="font-size:8.5px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;'
      +     'color:#7a5c00;margin-bottom:5px;padding-bottom:3px;border-bottom:1px solid #e8d87a;">'+label+'</div>'
      +'<div class="sig-lbl">Name &amp; Title</div>'
      +'<div style="border-bottom:1px solid var(--dark-border);height:16px;margin-bottom:8px;"></div>'
      +'<div class="sig-lbl">Signature</div>'
      +'<div style="border-bottom:1px solid var(--dark-border);height:52px;margin-bottom:8px;"></div>'
      +'<div style="display:grid;grid-template-columns:1fr 90px;gap:10px;">'
      +  '<div><div class="sig-lbl">Date</div>'
      +       '<div class="sig-line"></div></div>'
      +  '<div><div class="sig-lbl">Decision</div>'
      +       '<div class="sig-line"></div></div>'
      +'</div>'
      +'</div>';
  }

  // ── Sig columns: always show all 3, grey out co-app if none ──
  var sigCols = hasCoApp ? '1fr 1fr 1fr' : '1fr 1fr';

  // ════════════════════════════════
  var doc = '<!DOCTYPE html><html><head><meta charset="UTF-8"/>'
    +'<title>'+(window.NATION_CONFIG&&NATION_CONFIG.short||'')+' — '+name+'</title>'
    +'<style>'
    +_printThemeStyles()
    +'*{box-sizing:border-box;margin:0;padding:0;}'
    +'@page{size:letter;margin:14mm 13mm 22mm 13mm;}'
    +'body{font-family:Arial,Helvetica,sans-serif;font-size:10.5px;color:var(--text);background:var(--surface);line-height:1.4;counter-reset:page;}'
    +'@page{@bottom-right{content:"Page " counter(page) " of " counter(pages);font-family:Arial,sans-serif;font-size:8.5px;color:var(--muted);}}'
    +'.footer{position:fixed;bottom:7mm;left:0;right:0;padding:0 13mm;'
    +'display:flex;justify-content:space-between;font-size:8.5px;color:var(--muted);'
    +'border-top:1px solid #eee;padding-top:4px;}'
    +'.page-num{position:fixed;bottom:7mm;right:13mm;font-size:8.5px;color:var(--muted);'
    +'font-family:Arial,sans-serif;}'
    +'</style>'
    +'</head><body>'

    // HEADER
    +'<div style="display:flex;align-items:center;justify-content:space-between;'
    +     'border-bottom:3px solid '+window._themeAccentHex()+';padding-bottom:10px;margin-bottom:14px;">'
    +  '<div class="flex-g10">'
    +    (logoSrc?'<img src="'+logoSrc+'" style="width:40px;height:40px;object-fit:contain;" alt="'+(window.NATION_CONFIG&&NATION_CONFIG.short||'')+'"/>'     :'')
    +    '<div><div class="js-txt-lg">'+(window.NATION_CONFIG&&NATION_CONFIG.short||'')+' Housing Application</div>'
    +         '<div style="font-size:9.5px;color:var(--muted);">'+(window.NATION_CONFIG&&(NATION_CONFIG.display_name||NATION_CONFIG.name)||'')+'</div></div>'
    +  '</div>'
    +  '<div style="text-align:right;font-size:9.5px;color:var(--muted);line-height:1.9;">'
    +    '<strong style="font-size:12px;color:var(--text);">'+name+'</strong><br/>'
    +    appId+'<br/>Date: '+today
    +  '</div>'
    +'</div>'

    // 1. APPLICANT
    +section('Applicant Information',
       row('First Name',           fld('fn'))
      +row('Last Name',            fld('ln'))
      +row('Date of Birth',        fld('dob'))
      +row('Band Number',          fld('band'))
      +row('On Reserve Status',    fld('reserve'))
      +row('Living Situation',     (typeof livingSituationLabel === 'function' ? livingSituationLabel(fld('living_situation')) : '') || '')
      +((document.getElementById('deceased_flag')||{}).checked ? row('Deceased', 'Yes' + (fld('deceased_date') ? ' — ' + fld('deceased_date') : '')) : '')
      +row('Marital Status',       fld('marital'))
      +row('Cell Phone',           fld('phone'))
      +row('Email Address',        fld('email'))
      +row('Application Date',     fld('appDate'))
      +row('Accessibility Needs',  fld('accessibility'))
      +row('Housing Classification', getHousingClassification ? getHousingClassification() : '—')
    )

    // 2. CURRENT ADDRESS
    +section('Current Address',
       row('Street Address',       fld('street'))
      +row('City',                 fld('city'))
      +row('Province',             fld('prov'))
      +row('Postal Code',          fld('postal'))
      +row('Expected Occupancy Date', fld('occDate'))
    )

    // 3. HOUSING CONDITION & ARREARS
    +section('Current Housing & Arrears',
       row('Currently Has a House', yn(hasHouse))
      +(hasHouse ? row('Home Condition',          fld('homeCondition')) : '')
      +(hasHouse ? row('Est. Renovation Cost',    dollarQ('#homeCondBlk input[type="number"]')) : '')
      +row('Arrears Owed to '+(window.NATION_CONFIG&&NATION_CONFIG.short||''), yn(hasArr))
      +row('Amount Owed',          hasArr ? (arrNums[0]&&arrNums[0].value?formatCurrency(parseCurrency(arrNums[0].value)):'—') : 'N/A')
      +row('Monthly Payment',      hasArr ? (arrNums[1]&&arrNums[1].value?formatCurrency(parseCurrency(arrNums[1].value)):'—') : 'N/A')
      +row('Plan Duration',        hasArr ? (arrNums[3]&&arrNums[3].value?arrNums[3].value+' months':'—') : 'N/A')
      +row('Payment Frequency',    hasArr ? (arrSel?arrSel.value:'—') : 'N/A')
      +row('Agreement Date',       hasArr ? (arrDates[0]&&arrDates[0].value?arrDates[0].value:'—') : 'N/A')
    )

    // 4. EMPLOYMENT & INCOME
    +section('Employment &amp; Income', incBody)

    // 5. CO-APPLICANT
    +section('Co-Applicant',
       row('Co-Applicant', hasCoApp ? 'Yes' : 'No')
      +(hasCoApp ? row('First Name',   fld('co_fn'))  : '')
      +(hasCoApp ? row('Last Name',    fld('co_ln'))  : '')
      +(hasCoApp ? row('Date of Birth',fld('co_dob')) : '')
      +(hasCoApp ? row('Band Number',  fld('co_band'))    : '')
      +(hasCoApp ? row('Reserve Status',fld('co_reserve')): '')
      +(hasCoApp ? row('Cell Phone',   fld('co_cell'))    : '')
      +(hasCoApp ? row('Email',        fld('co_email'))   : '')
    )

    // 6. HOUSEHOLD MEMBERS
    +section('Household Members', habBody)

    // 7. REFERENCES
    +section('References', refBody)

    // 8. PETS
    +(petBody ? section('Pets', petBody) : '')

    // 9. DOCUMENTS
    +section('Supporting Documents Submitted', docsBody)

    // TERMS & CONDITIONS — rendered from Settings → Terms & Conditions (ED-editable).
    +(function(){
      var _tp = (typeof _termsParseHtml === 'function' && typeof getTermsBody === 'function')
              ? _termsParseHtml(getTermsBody('housing_application'))
              : { intro: '', introHtml: '', items: [], itemsHtml: [] };
      var _nation = (window.NATION_CONFIG && (NATION_CONFIG.display_name || NATION_CONFIG.name)) || '';
      var _short  = (window.NATION_CONFIG && NATION_CONFIG.short) || '';
      var introHtml = _tp.introHtml
        ? '<p style="font-size:9.5px;color:var(--text);line-height:1.6;margin-bottom:5px;">' + _tp.introHtml + '</p>'
        : '<p style="font-size:9.5px;color:var(--text);line-height:1.6;margin-bottom:5px;">By signing below, I hereby apply for housing assistance from the ' + _nation + ' (' + _short + ') Housing Program and declare the following:</p>';
      var liHtml = _tp.itemsHtml.length
        ? _tp.itemsHtml.map(function(h){ return '<li>' + h + '</li>'; }).join('')
        : ('<li>All information provided in this application is true, accurate, and complete to the best of my knowledge.</li>'
          +'<li>I understand that providing false or misleading information may result in immediate disqualification and removal from the housing waitlist.</li>'
          +'<li>I consent to ' + _short + ' collecting, using, and sharing my personal information for the purpose of assessing this application, in accordance with applicable privacy legislation (PIPEDA).</li>'
          +'<li>I understand that my application will be scored according to the ' + _short + ' Housing Scoring Rubric and that priority is determined by score, not date of application alone.</li>'
          +'<li>I agree to notify the ' + _short + ' Housing Department within 30 days of any change in household composition, income, address, or contact information.</li>'
          +'<li>I understand that acceptance into ' + _short + ' housing is conditional upon satisfying all outstanding arrears or entering into a formal payment arrangement approved by ' + _short + ' prior to occupancy.</li>'
          +'<li>I agree to comply with all ' + _short + ' Housing policies, lease agreements, and community by-laws as a condition of tenancy.</li>'
          +'<li>I authorize ' + _short + ' to verify any information in this application with relevant third parties including employers, financial institutions, and utility providers.</li>');
      return '<div style="margin-top:14px;padding:10px 12px;border:1px solid var(--border);border-radius:4px;background:var(--bg);page-break-inside:avoid;">'
           + '<div style="font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--muted);margin-bottom:7px;padding-bottom:4px;border-bottom:1.5px solid '+window._themeAccentHex()+';">'
           + 'Terms &amp; Conditions — Applicant Declaration</div>'
           + introHtml
           + '<ol style="font-size:9.5px;color:var(--text);line-height:1.7;padding-left:14px;">'
           + liHtml
           + '</ol>'
           + '</div>';
    })()

    // CONSENT ACKNOWLEDGMENT — visible confirmation block (only when ticked).
    // Mirrors the on-screen Step 8 consent box and stamps when/by whom the
    // box was confirmed so HM/ED have a clear paper trail in the printed PDF.
    +((document.getElementById('consent_share_programs')||{}).checked
      ? '<div style="margin-top:12px;padding:10px 12px;border:1.5px solid #15803d;border-radius:4px;background:#f0fdf4;page-break-inside:avoid;">'
        + '<div style="font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:#15803d;margin-bottom:6px;padding-bottom:4px;border-bottom:1px solid #bbf7d0;">'
        + '&#x2611; Consent to Share &mdash; '+(window.NATION_CONFIG&&NATION_CONFIG.short||'')+' Programs &middot; <span style="font-weight:700;">CONFIRMED</span></div>'
        + '<p style="font-size:9.5px;color:var(--text);line-height:1.55;margin:0 0 5px;">'
        + 'The applicant has consented to '+(window.NATION_CONFIG&&NATION_CONFIG.short||'')+' Housing sharing relevant information from this application with other '+(window.NATION_CONFIG&&(NATION_CONFIG.display_name||NATION_CONFIG.name)||'')+' programs and departments &mdash; including Health, Education, Wellness, Ontario Works, and Finance &mdash; in support of this housing application.'
        + '</p>'
        + '<p style="font-size:8.5px;color:var(--muted);margin:0;">'
        + 'Recorded: '+today
        + ((typeof HOUSING_SESSION !== 'undefined' && HOUSING_SESSION && HOUSING_SESSION.email) ? ' &middot; Captured by '+escapeHtml(HOUSING_SESSION.email) : '')
        + '</p>'
        + '</div>'
      : '')

    // SIGNATURES
    +'<div style="margin-top:14px;page-break-inside:avoid;">'
    +'<div style="font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;'
    +     'color:var(--muted);border-bottom:2.5px solid '+window._themeAccentHex()+';padding-bottom:3px;margin-bottom:10px;">Signatures</div>'
    +'<div style="display:grid;grid-template-columns:'+sigCols+';gap:12px;">'
    +sigBlock('Applicant', sigName, sigDate, sigApp)
    +sigBlock('Co-Applicant', coSigName, sigDate, sigCo)
    +sigBlock('Received by — Housing Staff', staffName, staffDate, sigStaff)
    +'</div></div>'

    +'<div class="footer"><span>'+escapeHtml(buildNationFooterStrip())+'</span><span>Generated '+today+'</span></div>'
    +'<!-- print handled by panel -->'
    +'</body></html>';

  showPrintPanel(doc, 'Application Preview');
  } catch(err) {
    console.error('printApplicationPreview error:', err);
    showToast('Print error — see browser console (F12)', {type:'error'});
  }
}

// ═══════════════════════════════════════════════════════════════
// INTERNAL APPLICATION NOTES (step 11) — staff-only side panel
// Append-only via DB (housing_application_notes). Never printed.
// ═══════════════════════════════════════════════════════════════

function _openAppNotesStep() {
  if (!_isStaffSession()) { showToast && showToast('Notes are staff-only.', {type:'info'}); return; }
  if (!currentAppId) {
    showToast && showToast('Save the application first to add notes.', {type:'info'});
    return;
  }

  var _stepCur = document.getElementById('step'+cur);
  if (_stepCur) _stepCur.classList.remove('on');
  var _stepN = document.getElementById('step11');
  if (_stepN) _stepN.classList.add('on');

  var btn = document.getElementById('spb_notes_row');
  if (btn) btn.classList.add('active');

  cur = 11;
  window.scrollTo(0, 0);
  _renderAppNoteAuthorHint();
  renderAppNotes();
}

function _renderAppNoteAuthorHint() {
  var sess = window.HOUSING_SESSION || {};
  var nm = document.getElementById('appNoteAuthorName');
  var rl = document.getElementById('appNoteAuthorRole');
  if (nm) nm.textContent = sess.name || sess.email || '—';
  if (rl) rl.textContent = sess.role || (window.currentRole || '—');
}

function _formatNoteTs(iso) {
  if (!iso) return '';
  try {
    var d = new Date(iso);
    return d.toLocaleDateString('en-CA') + ' ' + d.toLocaleTimeString([], { hour:'numeric', minute:'2-digit' });
  } catch(e) { return iso; }
}

function _roleLabel(r) {
  if (!r) return '';
  var map = {
    'ed':                   'Executive Director',
    'housing_manager':      'Housing Manager',
    'housing_employee_l2':  'Housing Employee (L2)',
    'housing_employee_l1':  'Housing Employee (L1)',
    'cfo':                  'CFO',
    'finance_l1':           'Finance (L1)'
  };
  return map[r] || r;
}

// ═══════════════════════════════════════════════════════════════
// SIGNATURE LOCKING — applicant-side panels only
// Locked on application submission (status !== 'draft'). HM/ED
// approval signatures are NOT touched; they're governed separately
// by the approval workflow gates.
// ═══════════════════════════════════════════════════════════════

function _shouldLockApplicantSignatures(app) {
  if (!app || !app.status) return false;
  // draft and returned both need editable signatures
  return app.status !== 'draft' && app.status !== 'returned';
}

function _lockSignaturePanel(canvasId) {
  var canvas = document.getElementById(canvasId);
  if (!canvas) return;
  var wrap = canvas.closest('.sig-canvas-wrap');
  if (!wrap) return;
  if (wrap.getAttribute('data-sig-locked') === '1') return; // idempotent
  // Only lock panels that actually have a signature.
  if (typeof getSigDataURL === 'function' && !getSigDataURL(canvasId)) return;
  wrap.setAttribute('data-sig-locked', '1');

  // Hide mode tabs.
  var tabs = wrap.querySelector('.tab-bar');
  if (tabs) tabs.style.display = 'none';

  // Canvas inert.
  canvas.style.pointerEvents = 'none';
  canvas.style.cursor = 'default';

  // Clear button hidden.
  var canvasPanel = document.getElementById(canvasId + '_panel_canvas');
  if (canvasPanel) {
    var clearBtn = canvasPanel.querySelector('button');
    if (clearBtn) clearBtn.style.display = 'none';
  }

  // Typed input readonly.
  var typed = document.getElementById(canvasId + '_typed');
  if (typed) { typed.readOnly = true; typed.style.opacity = '0.7'; typed.style.cursor = 'default'; }

  // Wet-ref input readonly.
  var wetRef = document.getElementById(canvasId + '_wet_ref');
  if (wetRef) { wetRef.readOnly = true; wetRef.style.opacity = '0.7'; wetRef.style.cursor = 'default'; }

  // "Locked" badge at the top of the wrap.
  if (!wrap.querySelector('.sig-locked-badge')) {
    var badge = document.createElement('div');
    badge.className = 'sig-locked-badge';
    badge.style.cssText = 'background:rgba(248,228,26,0.15);border:1px solid var(--yellow);color:var(--dark);padding:6px 12px;border-radius:6px;font-size:11px;font-weight:700;margin-bottom:10px;display:flex;align-items:center;gap:6px;';
    badge.innerHTML = '🔒 Signed — locked';
    wrap.insertBefore(badge, wrap.firstChild);
  }
}

function _unlockSignaturePanel(canvasId) {
  var canvas = document.getElementById(canvasId);
  if (!canvas) return;
  var wrap = canvas.closest('.sig-canvas-wrap');
  if (!wrap) return;
  if (wrap.getAttribute('data-sig-locked') !== '1') return;
  wrap.removeAttribute('data-sig-locked');

  var badge = wrap.querySelector('.sig-locked-badge');
  if (badge) badge.remove();

  var tabs = wrap.querySelector('.tab-bar');
  if (tabs) tabs.style.display = '';

  canvas.style.pointerEvents = '';
  canvas.style.cursor = 'crosshair';

  var canvasPanel = document.getElementById(canvasId + '_panel_canvas');
  if (canvasPanel) {
    var clearBtn = canvasPanel.querySelector('button');
    if (clearBtn) clearBtn.style.display = '';
  }

  var typed = document.getElementById(canvasId + '_typed');
  if (typed) { typed.readOnly = false; typed.style.opacity = ''; typed.style.cursor = ''; }

  var wetRef = document.getElementById(canvasId + '_wet_ref');
  if (wetRef) { wetRef.readOnly = false; wetRef.style.opacity = ''; wetRef.style.cursor = ''; }
}

function _lockApplicantSignatures() {
  _lockSignaturePanel('sig_canvas_app');
  _lockSignaturePanel('sig_canvas_co');
  _lockSignaturePanel('sig_canvas_staff');
}

function _unlockApplicantSignatures() {
  _unlockSignaturePanel('sig_canvas_app');
  _unlockSignaturePanel('sig_canvas_co');
  _unlockSignaturePanel('sig_canvas_staff');
}

// Apply or remove the lock based on the application's current status. Safe to
// call on every step transition / modal open — both helpers are idempotent.
function _applySignatureLockState(app) {
  var shouldLock = _shouldLockApplicantSignatures(app);
  if (shouldLock) _lockApplicantSignatures();
  else _unlockApplicantSignatures();
  var bar = document.getElementById('sig_override_bar');
  if (bar) {
    var _role = window.currentRole || '';
    var _canUnlock = typeof APPROVAL_AUTHORITY !== 'undefined' && APPROVAL_AUTHORITY.can('unlockSignatures', _role);
    bar.style.display = (shouldLock && _canUnlock) ? '' : 'none';
  }
}

function unlockSignaturesOverride() {
  var _role = window.currentRole || '';
  if (!(typeof APPROVAL_AUTHORITY !== 'undefined' && APPROVAL_AUTHORITY.can('unlockSignatures', _role))) return;
  showConfirm({
    title:   'Override Signature Lock?',
    message: 'This will unlock the signature blocks so new signatures can be collected. The action will be logged. Continue?',
    okText:  'Unlock'
  }).then(function(ok) {
    if (!ok) return;
    _unlockApplicantSignatures();
    var bar = document.getElementById('sig_override_bar');
    if (bar) bar.style.display = 'none';
    if (typeof auditEntry === 'function') auditEntry(currentAppId, 'sig_lock_override', _role + ' overrode applicant signature lock');
    if (typeof showToast  === 'function') showToast('Signature lock removed.', {type:'info'});
  });
}

function _updateNotesTabPreview(notes) {
  var lbl = document.getElementById('spb_lbl_11');
  if (!lbl) return;
  if (!notes || !notes.length) {
    lbl.innerHTML = 'Internal Notes <span class="spb-lbl-sub">(Staff Only)</span>';
    return;
  }
  var last = notes[0]; // newest-first
  var raw  = (last.body || '').trim().replace(/\s+/g, ' ');
  var snippet = raw.length > 40 ? raw.substring(0, 40) + '…' : raw;
  var count = notes.length;
  lbl.innerHTML = 'Internal Notes <span class="spb-lbl-sub">'
    + count + (count === 1 ? ' note' : ' notes')
    + ' · “' + escapeHtml(snippet) + '”</span>';
}

function renderAppNotes() {
  var listEl  = document.getElementById('appNotesList');
  var countEl = document.getElementById('appNotesCount');
  if (!listEl) return;
  if (!currentAppId) {
    listEl.innerHTML = '<div style="padding:24px;text-align:center;color:var(--muted);font-size:12px;">Save the application first to add notes.</div>';
    if (countEl) countEl.textContent = '0 notes';
    return;
  }
  listEl.innerHTML = '<div style="padding:24px;text-align:center;color:var(--muted);font-size:12px;">Loading…</div>';
  sbLoadAppNotes(currentAppId).then(function(notes) {
    notes = notes || [];
    if (countEl) countEl.textContent = notes.length + (notes.length === 1 ? ' note' : ' notes');
    _updateNotesTabPreview(notes);
    if (!notes.length) {
      listEl.innerHTML = '<div style="padding:24px;text-align:center;color:var(--muted);font-size:12px;">No notes yet. Add the first one above.</div>';
      return;
    }
    var html = '';
    notes.forEach(function(n) {
      var author = n.author_name || n.author_email || 'Unknown';
      var role   = _roleLabel(n.author_role || '');
      var ts     = _formatNoteTs(n.created_at);
      var body   = escapeHtml(n.body || '');
      html += '<div style="padding:14px 18px;border-bottom:1px solid var(--border);">'
        +    '<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:6px;">'
        +      '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">'
        +        '<span style="font-size:12px;font-weight:700;color:var(--text);">'+escapeHtml(author)+'</span>'
        +        (role ? '<span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px;background:var(--bg);border:1px solid var(--border);color:var(--muted);">'+escapeHtml(role)+'</span>' : '')
        +      '</div>'
        +      '<span style="font-size:11px;color:var(--muted);">'+escapeHtml(ts)+'</span>'
        +    '</div>'
        +    '<div style="font-size:13px;line-height:1.55;color:var(--text);white-space:pre-wrap;">'+body+'</div>'
        +  '</div>';
    });
    listEl.innerHTML = html;
  }).catch(function(e) {
    console.warn('[notes] render failed:', e);
    listEl.innerHTML = '<div style="padding:24px;text-align:center;color:var(--danger);font-size:12px;">Failed to load notes. Try refreshing.</div>';
  });
}

function submitAppNote() {
  var ta   = document.getElementById('appNoteBody');
  var btn  = document.getElementById('appNoteSubmitBtn');
  var errE = document.getElementById('appNoteError');
  if (errE) { errE.style.display = 'none'; errE.textContent = ''; }
  if (!ta) return;
  var body = (ta.value || '').trim();
  if (!body) {
    if (errE) { errE.textContent = 'Enter a note before adding.'; errE.style.display = 'block'; }
    ta.focus();
    return;
  }
  if (!currentAppId) {
    if (errE) { errE.textContent = 'Save the application first.'; errE.style.display = 'block'; }
    return;
  }
  if (!_isStaffSession()) {
    if (errE) { errE.textContent = 'Sign in as staff to add notes.'; errE.style.display = 'block'; }
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = 'Adding…'; }
  // Local-first: queue the note immediately. Renders on success or queued-fail
  // both clear the textarea — the note will appear via the queue retry next
  // time if the cloud insert failed.
  saveAppNoteWithDraftFallback(currentAppId, body).then(function(ok) {
    ta.value = '';
    auditEntry && auditEntry(currentAppId, 'note_added', 'Internal note added (' + body.length + ' chars)');
    if(ok) {
      renderAppNotes();
      showToast && showToast('Note added.', {type:'info'});
    } else {
      showToast && showToast('Note saved locally — will sync when network is available.', { type:'info', duration:3500 });
    }
  }).finally(function() {
    if (btn) { btn.disabled = false; btn.textContent = '+ Add Note'; }
  });
}

// Show or hide the Notes tab button. Visible only when (a) we have a staff
// session AND (b) the application has been saved at least once (has an id
// AND is in the in-memory applications array → matches a real DB row).
function _refreshAppNotesTabVisibility() {
  var btn = document.getElementById('spb_notes_row');
  if (!btn) return;
  var staff = _isStaffSession();
  var saved = !!currentAppId
    && Array.isArray(typeof applications !== 'undefined' ? applications : null)
    && applications.some(function(a){ return a && a.id === currentAppId; });
  btn.style.display = (staff && saved) ? '' : 'none';
}

// ── Navigation history stack ──
window._navStack = [];

// ── Page nav map (used by shared-ui.js goBack) ─────────────────────────────
// Uses lazy lookups so this file can load before housing-init.js (which
// defines showDashboard). Functions are resolved at call time, not parse time.
window._navMap = {
  'home':        function(){ return showEmployeeHome.apply(this, arguments); },
  'inventory':   function(){ return showInventory.apply(this, arguments); },
  'match':       function(){ return showMatch.apply(this, arguments); },
  'tenants':     function(){ return showTenants.apply(this, arguments); },
  'renos':       function(){ return showRenos.apply(this, arguments); },
  'contractors': function(){ return showContractors.apply(this, arguments); },
  'settings':    function(){ return showSettings.apply(this, arguments); }
};




// ── Rent Calculation review card (single engine: computeRentCalc) ────────────
function _rcMoney(v){ return v == null ? '\u2014' : '$' + Number(v).toLocaleString('en-CA', {minimumFractionDigits:2, maximumFractionDigits:2}); }
function _rentCalcCardHtml(){
  if(typeof computeRentCalc !== 'function') return '';
  var esc = (typeof escapeHtml === 'function') ? escapeHtml : function(x){ return String(x == null ? '' : x); };
  var app = (typeof currentAppId !== 'undefined' && currentAppId && typeof applications !== 'undefined')
    ? applications.find(function(a){ return a && a.id === currentAppId; }) : null;
  var unit = null;
  if(app && app.assignedUnit && typeof housingUnits !== 'undefined'){
    unit = (housingUnits || []).find(function(u){ return u && u.id === app.assignedUnit; }) || null;
  }
  // Market rent resolves via the shared rule: per-unit override if entered,
  // else the Settings rent-table rate for the unit's bedroom count.
  var emrInfo = (unit && typeof unitMarketRent === 'function') ? unitMarketRent(unit) : null;
  // The age-adjusted market rent (rounded to the dollar) feeds the discount;
  // base + factor render as their own rows below.
  var emr = emrInfo ? (emrInfo.adjustedMarketRent != null ? emrInfo.adjustedMarketRent : emrInfo.marketRent)
                    : (unit ? unit.estimatedMarketRent : null);
  var emrSrc = emrInfo ? emrInfo.source : (emr != null ? 'manual' : null);
  var prog = (typeof _appAssistProgram === 'function') ? _appAssistProgram() : '';
  var spouse = (typeof _appSpouseIndicator === 'function') ? _appSpouseIndicator() : 0;
  var deps = (typeof _appDependentsCount === 'function') ? _appDependentsCount() : 0;
  var model = (typeof getRentModel === 'function') ? getRentModel() : null;
  var c = computeRentCalc({ incomeType: prog, spouse: spouse, dependents: deps, estimatedMarketRent: emr, model: model });
  function row(k, v, strong){
    return '<div style="display:flex;justify-content:space-between;gap:12px;padding:7px 0;border-bottom:1px solid var(--border);font-size:13px;">'
      + '<span style="color:var(--muted);">' + k + '</span><span style="font-weight:' + (strong ? '800' : '600') + ';">' + v + '</span></div>';
  }
  var body = '';
  if(c.method === 'shelter'){
    body += row('Calculation method', 'Shelter Allowance');
    body += row('Assistance Program', esc(c.program));
    body += row('Applicant Count', '1');
    body += row('Spouse/Common-Law Count', String(spouse));
    body += row('Number of Dependents', String(deps));
    body += row('Benefit Unit Size', String(c.benefitUnitSize));
    body += row('Maximum Monthly Shelter Amount', _rcMoney(c.shelterAmount));
    body += row('Standard Discounted Unit Rent', unit ? _rcMoney(c.standardRent) : 'no unit assigned yet');
    body += row('Final Calculated Monthly Rent', _rcMoney(c.finalRent), true);
    body += '<div style="font-size:11px;color:var(--muted);margin-top:6px;">'
      + (c.capApplied
          ? 'The unit\u2019s standard discounted rent is LOWER than the shelter amount, so the lower amount is charged. '
          : (unit ? 'The shelter amount is at or below the unit\u2019s standard rent, so the shelter amount is charged. ' : ''))
      + 'Rates effective ' + esc(c.effectiveDate || 'n/a') + '. ' + esc(c.sourceNote || '') + '</div>';
  } else {
    body += row('Calculation method', 'Standard Market Rent Formula');
    var _ai = emrInfo && emrInfo.ageInfo;
    if(_ai && emrInfo.marketRent != null && emrInfo.adjustedMarketRent !== emrInfo.marketRent){
      body += row('Base Market Rent', _rcMoney(emrInfo.marketRent) + (emrSrc === 'table' ? ' <span style="font-size:10px;color:var(--muted);">(from rent table)</span>' : ''));
      body += row('Age Adjustment', '&times; ' + _ai.factor.toFixed(2)
        + ' <span style="font-size:10px;color:var(--muted);">('
        + (_ai.source === 'override' ? 'pending major rehab' : _ai.source === 'no_year' ? 'no year on file' : _ai.effectiveAge + ' yrs')
        + ' · schedule v' + _ai.scheduleVersion + ')</span>');
      body += row('Adjusted Market Rent', _rcMoney(emr));
    } else {
      body += row('Estimated Market Rent', unit ? (_rcMoney(emr) + (emrSrc === 'table' ? ' <span style="font-size:10px;color:var(--muted);">(from rent table)</span>' : '')) : 'no unit assigned yet');
    }
    body += row('Market Rent Discount', (model ? model.discountPct : '\u2014') + '%');
    body += row('Payable Market Percentage', (Math.round(c.payablePct * 10000) / 100) + '%');
    body += row('Calculated Monthly Rent', c.standardRent != null ? _rcMoney(c.standardRent) : '\u2014 (needs a unit with an Estimated Market Rent)', true);
  }
  // Documented override (authorized roles only — integrates the calculated
  // amount without deleting it; both stay visible).
  var ovr = app && app.rentOverride;
  var canOvr = (typeof APPROVAL_AUTHORITY !== 'undefined') && APPROVAL_AUTHORITY.can('overrideRent', window.currentRole);
  var ovrHtml = '';
  if(ovr && ovr.amount != null){
    ovrHtml = '<div style="margin-top:8px;padding:8px 12px;border-radius:8px;background:var(--warn-amber-bg);color:var(--warn-amber-text);font-size:12px;">'
      + '<strong>Override in effect: ' + _rcMoney(ovr.amount) + '/month.</strong> Reason: ' + esc(ovr.reason || '\u2014')
      + ' \u2014 set by ' + esc(ovr.by || '') + (ovr.at ? ' on ' + esc(String(ovr.at).slice(0,10)) : '') + '.'
      + (canOvr ? ' <button type="button" class="btn btn-ghost" style="padding:2px 8px;font-size:11px;margin-left:6px;" onclick="_clearRentOverride()">Clear</button>' : '')
      + '</div>';
  } else if(canOvr && app){
    ovrHtml = '<div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;">'
      + '<div class="f" style="margin:0;"><label style="font-size:11px;">Override amount ($/month)</label><input id="rent_ovr_amt" type="number" min="0" step="0.01" style="max-width:140px;"/></div>'
      + '<div class="f" style="flex:1;min-width:180px;margin:0;"><label style="font-size:11px;">Override reason (required)</label><input id="rent_ovr_reason" type="text"/></div>'
      + '<button type="button" class="btn btn-ghost" onclick="_applyRentOverride()">Apply Override</button>'
      + '</div>';
  }
  return '<div class="card" style="margin-top:14px;">'
    + '<div class="ctitle">Rent Calculation</div>' + body + ovrHtml + '</div>';
}
function _applyRentOverride(){
  if(typeof APPROVAL_AUTHORITY === 'undefined' || !APPROVAL_AUTHORITY.can('overrideRent', window.currentRole)){
    showToast('Not permitted', {type:'error'}); return;
  }
  var app = (typeof currentAppId !== 'undefined' && currentAppId && typeof applications !== 'undefined')
    ? applications.find(function(a){ return a && a.id === currentAppId; }) : null;
  if(!app){ showToast('Save the application first', {type:'error'}); return; }
  var amt = parseFloat((document.getElementById('rent_ovr_amt')||{}).value);
  var reason = ((document.getElementById('rent_ovr_reason')||{}).value || '').trim();
  if(isNaN(amt) || amt < 0){ showToast('Enter an override amount of zero or greater', {type:'error'}); return; }
  if(!reason){ showToast('An override reason is required (it is recorded)', {type:'error'}); return; }
  app.rentOverride = { amount: Math.round(amt * 100) / 100, reason: reason,
    by: (window.HOUSING_SESSION && HOUSING_SESSION.email) || window.currentRole || '', at: new Date().toISOString() };
  if(typeof saveApplicationWithDraftFallback === 'function') saveApplicationWithDraftFallback(app);
  if(typeof auditEntry === 'function') auditEntry(app.id, 'rent_override_set',
    'Monthly rent override ' + app.rentOverride.amount.toFixed(2) + ' \u2014 ' + reason, window.currentRole || 'staff');
  showToast('Rent override applied', {type:'info'});
  if(typeof popReview === 'function') popReview();
}
window._applyRentOverride = _applyRentOverride;
function _clearRentOverride(){
  if(typeof APPROVAL_AUTHORITY === 'undefined' || !APPROVAL_AUTHORITY.can('overrideRent', window.currentRole)){
    showToast('Not permitted', {type:'error'}); return;
  }
  var app = (typeof currentAppId !== 'undefined' && currentAppId && typeof applications !== 'undefined')
    ? applications.find(function(a){ return a && a.id === currentAppId; }) : null;
  if(!app || !app.rentOverride) return;
  app.rentOverride = null;
  if(typeof saveApplicationWithDraftFallback === 'function') saveApplicationWithDraftFallback(app);
  if(typeof auditEntry === 'function') auditEntry(app.id, 'rent_override_cleared', 'Monthly rent override removed', window.currentRole || 'staff');
  showToast('Rent override cleared', {type:'info'});
  if(typeof popReview === 'function') popReview();
}
window._clearRentOverride = _clearRentOverride;
