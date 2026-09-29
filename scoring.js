/* ============================================================
 * scoring.js — CLFN Housing Suite
 * Application scoring, unit matching, reno priority models
 *
 * Load order: shared-config.js → shared-auth.js → shared.js →
 *             shared-ui.js → THIS FILE → shared-data.js
 *
 * Exposes globals:
 *   liveScoreModel        — mutable V1 scoring criteria array
 *   liveV2ScoreModel      — mutable V2 scoring object (from Supabase)
 *   liveV2Tiers           — mutable tier thresholds (from Supabase)
 *   DEFAULT_SCORING_MODEL — V1 default criteria
 *   DEFAULT_V2_SCORE_MODEL— V2 default criteria
 *   DEFAULT_UNIT_SCORE_MODEL — unit matching criteria
 *   DEFAULT_RENO_SCORE_MODEL — reno priority criteria
 *   DEFAULT_NOS_TABLE     — NOS occupancy standards
 *   calcScore()           — score current application form
 *   triggerV2Score()      — re-score using V2 model
 *   autoPopulateScore()   — populate score fields from form data
 *   scoreApplicationLocally(app) — score a saved application
 *   tierColor(tier)       — returns {bg,c} for a priority tier
 *   renderV2ScoringEditor()  — render the V2 scoring editor UI
 *   renderUnitScoreTable()   — render unit matching score table
 * ============================================================ */

'use strict';

// ── Core data arrays (shared across all housing functions) ──────────────────
window.applications = window.applications || [];
window.housingUnits = window.housingUnits || [];

// ── Mutable model references (populated from Supabase on login) ───────────────
// Default priority-tier thresholds — single source for init, the fallbacks
// below, and resetV2TiersED() (which previously referenced an undefined
// DEFAULT_V2_TIERS and threw on "Reset Defaults").
var DEFAULT_V2_TIERS = { critical: 80, high: 60, medium: 40 };
window.liveV2ScoreModel = window.liveV2ScoreModel || {};
window.liveV2Tiers      = window.liveV2Tiers      || Object.assign({}, DEFAULT_V2_TIERS);

// ── Single tier resolver + palettes ────────────────────────────────────────
// tierFor(score) is THE tier derivation — always reads the ED-adjustable
// liveV2Tiers thresholds. Four drifted copies used to exist (calcScore
// hardcoded 80/60/40 and ignored the ED's settings entirely; triggerV2Score,
// tierColor, and scoreApplicationLocally each re-derived their own), so the
// same score could label differently between the V1 and V2 display paths.
// Two palettes are deliberate: tierColorDark for pills on the dark scorecard
// header, tierColor (below, light) for pills on light surfaces.
window.tierFor = function tierFor(score) {
  var t = window.liveV2Tiers || { critical: 80, high: 60, medium: 40 };
  var s = Number(score) || 0;
  return s >= t.critical ? 'Critical Priority'
       : s >= t.high     ? 'High Priority'
       : s >= t.medium   ? 'Medium Priority'
       : 'Low Priority';
};
window.tierColorDark = function tierColorDark(tier) {
  return ({
    'Critical Priority': { bg:'#0d2d1a', col:'#4ade80' },
    'High Priority':     { bg:'#0d2040', col:'#93c5fd' },
    'Medium Priority':   { bg:'#3d3000', col:'#fcd34d' },
    'Low Priority':      { bg:'#3d1515', col:'#f87171' }
  })[tier] || { bg:'var(--dark3)', col:'#aaa' };
};
window.liveScoreModel   = window.liveScoreModel   || null;

// ── Match Priority Model (ED-adjustable) ──────────────────────────────
// Governs placement ORDER on the Match page — separate from the application
// score above, which measures need/urgency. These bonuses are added on top
// of an applicant's score to form the "Match Priority" sort key:
//   hasMatchBonus   — added when the applicant has at least one suitable
//                     vacant unit (bestUnit() in housing-views.js returns
//                     non-null). The single dominant factor: an applicant
//                     nobody can actually place right now shouldn't occupy
//                     the top of the queue ahead of someone who CAN be
//                     placed today, regardless of score/reserve/house tier.
//   onReserveBonus  — added when the applicant's "On Reserve Status" is
//                     'On Reserve' (see the application form's `reserve`
//                     field). Off-reserve applicants get 0.
//   noHouseBonus    — added when the applicant does NOT currently have a
//                     house (i.e. isn't a transfer_request / doesn't already
//                     hold an assigned unit / no resolvable current tenancy —
//                     the same "Has House" check the Match table/cards show).
//   temporaryBonus  — added when the applicant's best-matching unit is
//                     designated a Temporary unit (`housing_units.assignmentType
//                     === 'temporary'` — see the Edit Unit modal's Assignment
//                     Type field). Temporary units are for urgent/emergency
//                     placements, so a match against one should jump the
//                     queue outright — this stacks on top of the tiering
//                     below rather than replacing it.
// noHouseBonus outweighs onReserveBonus because house status is the primary
// split, reserve status the secondary one — the four combinations rank:
// On-Reserve+NoHouse > Off-Reserve+NoHouse > On-Reserve+HasHouse >
// Off-Reserve+HasHouse. In particular an off-reserve applicant with no house
// outranks an on-reserve applicant who already has one. Separately, when the
// best-matching unit is a **Transition** unit (for tenants demonstrating
// they can care for a unit — lower urgency than a genuine placement), the
// applicant's own reserve/house status is ignored and they're scored as if
// off-reserve with a house (the bottom of that tiering), regardless of their
// real status. hasMatchBonus outweighs every other bonus combined so it
// always applies first, ahead of temporary/reserve/house tiering. Every
// bonus is far larger than the ~100-point max application score so, within
// a tier, the highest score always wins. Set any of these to 0 to remove
// that factor from ranking.
var DEFAULT_MATCH_PRIORITY_MODEL = { hasMatchBonus: 10000, temporaryBonus: 5000, onReserveBonus: 1000, noHouseBonus: 2000 };
window.liveMatchPriorityModel = window.liveMatchPriorityModel || Object.assign({}, DEFAULT_MATCH_PRIORITY_MODEL);

// ── V2 Scoring Model Defaults ──────────────────────────────────────────
// These are the editable point values for each option in the V2 model.
// Stored in housing_settings as 'scoring_model_v2'. ED can adjust via Settings.

// ── V2 Priority Tier Thresholds (ED-adjustable) ──────────────────────



function saveV2ScoringModel() {
  // (localStorage mirror removed — nothing ever read it; housing_settings is
  // the real persistence via saveSettingWithDraftFallback below.)
  saveSettingWithDraftFallback('scoring_model_v2', liveV2ScoreModel).then(function(ok){
    if(!ok) showToast('Scoring model saved locally but did not reach the server — it may revert on next sign-in.', { type: 'error' });
  });
}

function saveV2Tiers() {
  // (localStorage mirror removed — nothing ever read it; housing_settings is
  // the real persistence via saveSettingWithDraftFallback below.)
  saveSettingWithDraftFallback('scoring_tiers_v2', liveV2Tiers).then(function(ok){
    if(!ok) {
      showToast('Tier thresholds saved locally but did not reach the server — please retry.', { type: 'error' });
      return;
    }
    showToast('Tier thresholds saved — rescore all to apply', {type:'info'});
  });
}

// ── V2 Scoring Editor Renderer ──────────────────────────────────────
function renderV2ScoringEditor() {
  var wrap = document.getElementById('scoring_model_table_wrap');
  if (!wrap) return;

  var m = liveV2ScoreModel;
  var t = liveV2Tiers;

  function pts(val, cat, key) {
    var col = val > 0 ? 'var(--success)' : val < 0 ? 'var(--danger)' : 'var(--gray)';
    var sign = val > 0 ? '+' : '';
    return '<input type="number" value="' + val + '" step="1" min="-30" max="30" data-cat="' + cat + '" data-key="' + key + '" '
      + 'style="width:60px;padding:4px 6px;border:1.5px solid var(--border);border-radius:6px;font-size:13px;font-weight:700;'
      + 'color:' + col + ';text-align:center;font-family:DM Sans,sans-serif;background:var(--surface);" '
      + 'onchange="updateV2ScoreOption(this)" oninput="this.style.color=+this.value>0?\x27var(--success)\x27:+this.value<0?\x27var(--danger)\x27:\x27var(--gray)\x27"/>';
  }

  function maxPts(cat, key) {
    var val = typeof m[cat] === 'object' && m[cat][key] !== undefined ? m[cat][key] : 0;
    var col = val > 0 ? 'var(--success)' : val < 0 ? 'var(--danger)' : 'var(--gray)';
    return '<input type="number" value="' + val + '" step="1" min="0" max="30" data-cat="' + cat + '" data-key="' + key + '" '
      + 'style="width:60px;padding:4px 6px;border:1.5px solid var(--border);border-radius:6px;font-size:13px;font-weight:700;'
      + 'color:' + col + ';text-align:center;font-family:DM Sans,sans-serif;background:var(--surface);" '
      + 'onchange="updateV2ScoreOption(this)" oninput="this.style.color=+this.value>0?\x27var(--success)\x27:\x27var(--gray)\x27"/>';
  }

  // Standard borderless section header (matches .tic-section-h, used by the
  // TIC / Edit Unit / Maintenance Request modals) instead of a full-bleed dark
  // bar. The old version used negative horizontal margins to force the dark
  // background edge-to-edge, assuming the parent wrap always has exactly
  // 20px of padding — when it didn't, the bar overflowed past the card's
  // rounded corners/border instead of lining up with it.
  function sectionHdr(label, maxScore) {
    return '<div style="margin:22px 0 12px;padding-bottom:8px;border-bottom:2px solid var(--yellow);display:flex;align-items:center;justify-content:space-between;">'
      + '<div style="font-size:13px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--text);">' + label + '</div>'
      + (maxScore ? '<div style="font-size:11px;color:var(--muted);">max ' + maxScore + ' pts</div>' : '')
      + '</div>';
  }

  function optRow(label, inputHtml, note) {
    return '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 10px;border-radius:7px;margin-bottom:3px;background:var(--bg);">'
      + '<div style="flex:1;"><span class="js-txt-bold2" style="font-weight:400;">' + label + '</span>'
      + (note ? '<div style="font-size:10px;color:var(--muted);margin-top:1px;">' + note + '</div>' : '')
      + '</div>'
      + '<div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">' + inputHtml + '<span class="js-lbl-sm">pts</span></div>'
      + '</div>';
  }

  var html = '<div style="padding:16px;">';

  // ── Section A ──
  html += sectionHdr('Section A — Housing Need', 70);

  html += '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--muted);margin:10px 0 6px;">Urgent Need / Displacement</div>';
  html += optRow('Homeless / No Fixed Address', pts(m.urgent_need.homeless, 'urgent_need', 'homeless'));
  html += optRow('Temporary Shelter', pts(m.urgent_need.temporary_shelter, 'urgent_need', 'temporary_shelter'));
  html += optRow('Domestic Violence / Intimate Partner Abuse', pts(m.urgent_need.domestic_violence, 'urgent_need', 'domestic_violence'));
  html += optRow('Fire, Flood or Disaster', pts(m.urgent_need.fire_disaster, 'urgent_need', 'fire_disaster'));
  html += optRow('Homelessness / Imminent Eviction', pts(m.urgent_need.homeless_eviction, 'urgent_need', 'homeless_eviction'));
  html += optRow('Eviction Risk from Current Landlord', pts(m.urgent_need.eviction_risk, 'urgent_need', 'eviction_risk'));
  html += optRow('Separation or Divorce Requiring Housing', pts(m.urgent_need.separation, 'urgent_need', 'separation'));
  html += optRow('No Urgent Need', pts(m.urgent_need.none, 'urgent_need', 'none'));

  html += '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--muted);margin:14px 0 6px;">Health &amp; Safety Risk</div>';
  html += optRow('Severe / Imminent Risk', pts(m.health_risk.severe, 'health_risk', 'severe'));
  html += optRow('Moderate Risk', pts(m.health_risk.moderate, 'health_risk', 'moderate'));
  html += optRow('Minor Risk', pts(m.health_risk.minor, 'health_risk', 'minor'));
  html += optRow('None', pts(m.health_risk.none, 'health_risk', 'none'));

  html += '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--muted);margin:14px 0 6px;">Overcrowding</div>';
  html += optRow('Points per person over occupancy standard', maxPts('overcrowding', 'per_person'), '');
  html += optRow('Maximum points (cap)', maxPts('overcrowding', 'max'), 'Scored field stops accumulating points after this maximum');

  html += '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--muted);margin:14px 0 6px;">Household Composition</div>';
  html += optRow('Per dependent under 18', maxPts('household', 'per_dependent_u18'), '');
  html += optRow('Maximum points for dependents', maxPts('household', 'max_dependents'), '');
  html += optRow('Elder in household', maxPts('household', 'elder'), '');
  html += optRow('Lone parent', maxPts('household', 'lone_parent'), '');
  html += optRow('Household member with disability', maxPts('household', 'disability'), '');
  html += optRow('Maximum total household points', maxPts('household', 'max_total'), 'Combined cap for all household composition factors');

  html += '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--muted);margin:14px 0 6px;">Accessibility / Medical Need</div>';
  html += optRow('High need — structural modification required', pts(m.accessibility.high, 'accessibility', 'high'));
  html += optRow('Moderate need', pts(m.accessibility.moderate, 'accessibility', 'moderate'));
  html += optRow('None', pts(m.accessibility.none, 'accessibility', 'none'));

  html += '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--muted);margin:14px 0 6px;">Waitlist Time</div>';
  html += optRow('Points per full year on waitlist', maxPts('waitlist', 'per_year'), 'No maximum — points keep accruing for every year an applicant waits.');

  // ── Section B ──
  html += sectionHdr('Section B — Tenant Responsibility', 30);

  html += '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--muted);margin:10px 0 6px;">Rent Payment History</div>';
  html += optRow('Excellent — consistently on time 12+ months', pts(m.rent_payment.excellent, 'rent_payment', 'excellent'));
  html += optRow('Mostly on time', pts(m.rent_payment.mostly, 'rent_payment', 'mostly'));
  html += optRow('Occasionally late', pts(m.rent_payment.occasional, 'rent_payment', 'occasional'));
  html += optRow('Frequently late', pts(m.rent_payment.frequent, 'rent_payment', 'frequent'));
  html += optRow('No prior ' + ((window.NATION_CONFIG && NATION_CONFIG.short) || 'housing') + ' tenancy (neutral baseline)', pts(m.rent_payment.no_history, 'rent_payment', 'no_history'), 'Applied automatically for new applicants');

  html += '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--muted);margin:14px 0 6px;">Unit Condition / No Damage</div>';
  html += optRow('Excellent — no damage at last inspection', pts(m.unit_condition.excellent, 'unit_condition', 'excellent'));
  html += optRow('Good', pts(m.unit_condition.good, 'unit_condition', 'good'));
  html += optRow('Fair', pts(m.unit_condition.fair, 'unit_condition', 'fair'));
  html += optRow('Damage noted', pts(m.unit_condition.damage, 'unit_condition', 'damage'));
  html += optRow('No prior ' + ((window.NATION_CONFIG && NATION_CONFIG.short) || 'housing') + ' tenancy (neutral baseline)', pts(m.unit_condition.no_history, 'unit_condition', 'no_history'), 'Applied automatically for new applicants');

  html += '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--muted);margin:14px 0 6px;">Tenancy Conduct</div>';
  html += optRow('No complaints or violations in 2 years', pts(m.tenancy_conduct.clean, 'tenancy_conduct', 'clean'));
  html += optRow('Minor complaints, resolved', pts(m.tenancy_conduct.minor, 'tenancy_conduct', 'minor'));
  html += optRow('Ongoing unresolved complaints', pts(m.tenancy_conduct.unresolved, 'tenancy_conduct', 'unresolved'));
  html += optRow('No prior ' + ((window.NATION_CONFIG && NATION_CONFIG.short) || 'housing') + ' tenancy (neutral baseline)', pts(m.tenancy_conduct.no_history, 'tenancy_conduct', 'no_history'), 'Applied automatically for new applicants');

  html += '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--muted);margin:14px 0 6px;">Income Stability</div>';
  html += optRow('Stable income — any source', pts(m.income_stability.stable, 'income_stability', 'stable'), 'Employment, social assistance, pension, LTD');
  html += optRow('Irregular income', pts(m.income_stability.irregular, 'income_stability', 'irregular'));
  html += optRow('No income', pts(m.income_stability.none, 'income_stability', 'none'));

  // ── Section C ──
  html += sectionHdr('Section C — Arrears Deduction', 0);
  html += '<div style="font-size:12px;color:var(--muted);margin-bottom:8px;">Values should be zero or negative. Score cannot go below zero regardless of deduction.</div>';
  html += optRow('No arrears', pts(m.arrears.none, 'arrears', 'none'));
  html += optRow('Arrears fully cleared', pts(m.arrears.cleared, 'arrears', 'cleared'));
  html += optRow('Active repayment plan in good standing', pts(m.arrears.repayment, 'arrears', 'repayment'));
  html += optRow('Arrears with no repayment plan', pts(m.arrears.no_repayment, 'arrears', 'no_repayment'));

  // ── Tier Thresholds ──
  html += sectionHdr('Priority Tier Thresholds', 0);
  html += '<div style="font-size:12px;color:var(--muted);margin-bottom:12px;">Set the minimum score required for each tier. Scores are evaluated from highest to lowest — an application meeting the Critical threshold is Critical Priority, even if it also meets the High threshold. The Low tier is anything below the Medium threshold.</div>';

  function tierRow(label, key, col, rangeLabel) {
    var val = t[key];
    return '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;border-radius:8px;margin-bottom:6px;background:var(--bg);border-left:3px solid ' + col + ';">'
      + '<div>'
      +   '<div style="font-size:13px;font-weight:700;color:var(--text);">' + label + '</div>'
      +   '<div class="js-lbl-sm" id="tier_range_' + key + '">' + rangeLabel + '</div>'
      + '</div>'
      + '<div style="display:flex;align-items:center;gap:6px;">'
      +   '<span class="js-lbl-sm">Score &ge;</span>'
      +   '<input type="number" value="' + val + '" min="0" max="100" step="1" data-tier="' + key + '" '
      +   'style="width:64px;padding:4px 8px;border:1.5px solid ' + col + ';border-radius:6px;font-size:15px;font-weight:700;color:' + col + ';text-align:center;font-family:DM Sans,sans-serif;background:var(--surface);" '
      +   'onchange="updateV2Tier(this)"/>'
      +   '<span class="js-lbl-sm">pts</span>'
      + '</div>'
      + '</div>';
  }

  // Compute display ranges
  var critR = t.critical + '+ pts';
  var highR = t.high + '–' + Math.max(t.high, t.critical - 1) + ' pts';
  var medR  = t.medium + '–' + Math.max(t.medium, t.high - 1) + ' pts';
  var lowR  = '0–' + Math.max(0, t.medium - 1) + ' pts';

  html += tierRow('Critical Priority', 'critical', '#4ade80', critR);
  html += tierRow('High Priority',     'high',     '#93c5fd', highR);
  html += tierRow('Medium Priority',   'medium',   '#fcd34d', medR);
  html += '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;border-radius:8px;margin-bottom:6px;background:var(--bg);border-left:3px solid var(--danger);">'
    + '<div>'
    +   '<div style="font-size:13px;font-weight:700;color:var(--text);">Low Priority</div>'
    +   '<div class="js-lbl-sm" id="tier_range_low">' + lowR + '</div>'
    + '</div>'
    + '<div style="font-size:11px;color:var(--muted);font-style:italic;">Anything below Medium</div>'
    + '</div>';

  html += '<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;">'
    + '<button onclick="saveV2TiersED()" class="btn btn-primary">Save Tier Thresholds</button>'
    + '<button onclick="saveV2TiersAndRescoreED()" class="btn btn-ghost">Save &amp; Rescore All</button>'
    + '<button onclick="resetV2TiersED()" class="btn btn-ghost">Reset Defaults</button>'
    + '</div>';

  html += '</div>';
  wrap.innerHTML = html;
}

function updateV2ScoreOption(el) {
  var cat = el.getAttribute('data-cat');
  var key = el.getAttribute('data-key');
  var val = parseInt(el.value) || 0;
  if (!liveV2ScoreModel[cat]) liveV2ScoreModel[cat] = {};
  liveV2ScoreModel[cat][key] = val;
  saveV2ScoringModel();
  auditEntry('SETTINGS', 'scoring_v2_change', 'V2 Scoring: ' + cat + '.' + key + ' set to ' + val + ' pts', window.currentRole || 'ed');
  showToast('Score updated — rescore all to apply', {type:'info'});
}

function updateV2Tier(el) {
  var key = el.getAttribute('data-tier');
  var val = parseInt(el.value) || 0;
  liveV2Tiers[key] = val;
  // Validate ordering — warn but don't block
  if (liveV2Tiers.critical <= liveV2Tiers.high) {
    showToast('Warning: Critical threshold should be higher than High', { type: 'error' });
  }
  if (liveV2Tiers.high <= liveV2Tiers.medium) {
    showToast('Warning: High threshold should be higher than Medium', { type: 'error' });
  }
  // Live-update the range labels so the ED can see the effect immediately
  var t = liveV2Tiers;
  var critR = t.critical + '+ pts';
  var highR = t.high + '–' + Math.max(t.high, t.critical - 1) + ' pts';
  var medR  = t.medium + '–' + Math.max(t.medium, t.high - 1) + ' pts';
  var lowR  = '0–' + Math.max(0, t.medium - 1) + ' pts';
  var labels = {critical:critR, high:highR, medium:medR, low:lowR};
  Object.keys(labels).forEach(function(k){
    var lblEl = document.getElementById('tier_range_' + k);
    if(lblEl) lblEl.textContent = labels[k];
  });
}

function saveV2TiersED() {
  edGuard('V2 tier thresholds updated', function() {
    saveV2Tiers();
    auditEntry('SETTINGS', 'scoring_v2_tiers', 'Priority tier thresholds updated: Critical=' + liveV2Tiers.critical + ' High=' + liveV2Tiers.high + ' Medium=' + liveV2Tiers.medium, 'ed');
  });
}

// Save tier thresholds AND immediately rescore all applications so existing records
// reflect the new tier boundaries in their `tier` field. Without this, the editor
// saves the thresholds but the dashboard keeps showing the old tier labels until
// the ED separately clicks "Rescore All".
function saveV2TiersAndRescoreED() {
  edGuard('V2 tier thresholds updated and applications rescored', function() {
    saveV2Tiers();
    auditEntry('SETTINGS', 'scoring_v2_tiers', 'Priority tier thresholds updated: Critical=' + liveV2Tiers.critical + ' High=' + liveV2Tiers.high + ' Medium=' + liveV2Tiers.medium + ' — auto-rescored', 'ed');
    if(typeof rescoreAndSave === 'function') {
      rescoreAndSave();
    } else if(typeof rescoreAllApplications === 'function') {
      rescoreAllApplications();
    }
  });
}

function resetV2TiersED() {
  edGuard('V2 tier thresholds reset to defaults', function() {
    liveV2Tiers = Object.assign({}, DEFAULT_V2_TIERS);
    saveV2Tiers();
    renderV2ScoringEditor();
    showToast('Tier thresholds reset to defaults', {type:'info'});
    auditEntry('SETTINGS', 'scoring_v2_tiers_reset', 'Priority tier thresholds reset to defaults', 'ed');
  });
}

function resetV2ScoringModelED() {
  edGuard('V2 Scoring Model reset to defaults', function() {
    liveV2ScoreModel = JSON.parse(JSON.stringify(DEFAULT_V2_SCORE_MODEL));
    saveV2ScoringModel();
    renderV2ScoringEditor();
    showToast('Scoring model reset to defaults', {type:'info'});
    auditEntry('SETTINGS', 'scoring_v2_reset', 'V2 scoring model reset to defaults', 'ed');
  });
}

// ── Match Priority Editor — ED-adjustable bonus weights (see the model
// comment above) that decide placement order on the Match page. Kept as its
// own small card next to the V2 scoring editor rather than folded into it,
// since it governs WHO gets matched first, not an applicant's raw score.
function renderMatchPriorityEditor() {
  var wrap = document.getElementById('match_priority_wrap');
  if (!wrap) return;
  var m = liveMatchPriorityModel;
  function bonusInput(key, label, hint) {
    var inputHtml = '<input type="number" value="' + (m[key] != null ? m[key] : 0) + '" step="100" min="0" data-priority-key="' + key + '" '
      + 'style="width:70px;padding:4px 6px;border:1.5px solid var(--border);border-radius:6px;font-size:13px;font-weight:700;text-align:center;font-family:DM Sans,sans-serif;background:var(--surface);" '
      + 'onchange="updateMatchPriorityOption(this)"/>';
    return '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 10px;border-radius:7px;margin-bottom:3px;background:var(--bg);">'
      + '<div style="flex:1;"><span class="js-txt-bold2" style="font-weight:400;">' + label + '</span>'
      + '<div style="font-size:10px;color:var(--muted);margin-top:1px;">' + hint + '</div>'
      + '</div>'
      + '<div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">' + inputHtml + '<span class="js-lbl-sm">pts</span></div>'
      + '</div>';
  }
  // No wrapping padding div here — #match_priority_wrap already sits inside a
  // padded container in housing.html (the section header/description/buttons
  // share that same padding, matching the Priority Tier Thresholds layout).
  wrap.innerHTML = bonusInput('hasMatchBonus',   'Has A Matching Unit Bonus', 'Added when there is at least one suitable vacant unit for the applicant. Dominates everything below.')
    + bonusInput('temporaryBonus',  'Temporary Unit Bonus', 'Added when the best-matching unit is a Temporary (emergency placement) unit. Stacks on top of reserve/house status.')
    + bonusInput('onReserveBonus', 'On-Reserve Priority Bonus', 'Added when the applicant\'s On Reserve Status is "On Reserve". Ignored when matched to a Transition unit.')
    + bonusInput('noHouseBonus',   'No Current House Priority Bonus', 'Added when the applicant does not already have a house (per the Has House column). Ignored when matched to a Transition unit.');
}

function updateMatchPriorityOption(input) {
  var key = input.getAttribute('data-priority-key');
  var val = parseInt(input.value, 10);
  if (isNaN(val) || val < 0) val = 0;
  liveMatchPriorityModel[key] = val;
  input.value = val;
}

// Guards Match Priority edits against the dedicated 'editMatchPriority'
// authority (Settings -> Approval Authority -> Scoring) rather than the
// shared edGuard()/editScoreModel check, so an ED can delegate WHO gets
// matched first (this) separately from WHO can edit the application scoring
// model itself (editScoreModel).
function _matchPriorityGuard(featureName, callback) {
  var role = window.currentRole;
  if (window.APPROVAL_AUTHORITY && APPROVAL_AUTHORITY.can('editMatchPriority', role)) {
    if (typeof callback === 'function') {
      var rv = callback();
      return (rv === undefined) ? true : rv;
    }
    return true;
  }
  if (typeof showToast === 'function') showToast((featureName || 'This action') + ' is not available for your role.', { type: 'error' });
  return false;
}

function saveMatchPriorityModelED() {
  _matchPriorityGuard('Match Priority weighting updated', function() {
    saveSettingWithDraftFallback('match_priority_model', liveMatchPriorityModel).then(function(ok){
      if(!ok){ showToast('Match priority weights saved locally but did not reach the server — it may revert on next sign-in.', { type: 'error' }); return; }
      showToast('Match priority weights saved', {type:'info'});
    });
    auditEntry('SETTINGS', 'match_priority_model', 'Match priority weights updated: Has-Match=' + liveMatchPriorityModel.hasMatchBonus + ' Temporary=' + liveMatchPriorityModel.temporaryBonus + ' On-Reserve=' + liveMatchPriorityModel.onReserveBonus + ' No-House=' + liveMatchPriorityModel.noHouseBonus, window.currentRole);
  });
}

function resetMatchPriorityModelED() {
  _matchPriorityGuard('Match Priority weighting reset to defaults', function() {
    liveMatchPriorityModel = Object.assign({}, DEFAULT_MATCH_PRIORITY_MODEL);
    renderMatchPriorityEditor();
    saveSettingWithDraftFallback('match_priority_model', liveMatchPriorityModel).then(function(ok){
      if(!ok){ showToast('Match priority weights reset locally but did not reach the server — it may revert on next sign-in.', { type: 'error' }); return; }
      showToast('Match priority weights reset to defaults', {type:'info'});
    });
    auditEntry('SETTINGS', 'match_priority_model_reset', 'Match priority weights reset to defaults', window.currentRole);
  });
}


// Load or init scoring model


// ── Live scoring helpers — read from liveScoreModel ──────────────────
// ── Rescore all applications from current liveScoreModel ─────────────


// ── Nation & Modules panel (read-only, Phase A0) ─────────────────────────
// Renders the NATION_CONFIG identity + the CLFN_MODULES enablement list so
// the ED can see what their nation is licensed for. Module toggles are
// controlled by the platform admin tool (separate codebase), not here.
function renderNationPanel(){
  var identEl = document.getElementById('nation_panel_identity');
  var modsEl  = document.getElementById('nation_panel_modules');
  if(!identEl || !modsEl) return;
  // Render the per-tenant Position Names section in its own host div.
  // ED-only edit; everyone else sees the same block but read-only.
  if (typeof _renderNationPositionsBlock === 'function') _renderNationPositionsBlock();
  var cfg = window.NATION_CONFIG || {};
  var modApi = window.CLFN_MODULES;
  var role = window.currentRole || '';
  var canEdit = (window.APPROVAL_AUTHORITY && APPROVAL_AUTHORITY.can('editApprovalAuthority', role));

  var host = (window.location.hostname || '').toLowerCase();
  var dispVal  = escapeHtml(cfg.display_name || cfg.name || '');
  var shortVal = escapeHtml(cfg.short || '');
  var idVal    = escapeHtml(cfg.id || '');
  var socials   = cfg.socials || {};

  if (!canEdit) {
    // Read-only view — same shape as before, plus contact + social readback.
    var contactRows = [
      cfg.mailing_address ? _nationContactRow('Mailing Address', cfg.mailing_address.replace(/\n/g,'<br/>'), true) : '',
      cfg.phone           ? _nationContactRow('Phone',   escapeHtml(cfg.phone))    : '',
      cfg.email           ? _nationContactRow('Email',   '<a href="mailto:'+escapeHtml(cfg.email)+'" style="color:var(--text);">'+escapeHtml(cfg.email)+'</a>') : '',
      cfg.website         ? _nationContactRow('Website', '<a href="'+escapeHtml(_nationLinkify(cfg.website))+'" target="_blank" rel="noopener" style="color:var(--text);">'+escapeHtml(cfg.website)+'</a>') : ''
    ].join('');
    var socialChips = ['facebook','instagram','linkedin','twitter','youtube'].map(function(k){
      var url = socials[k];
      if (!url) return '';
      var label = ({facebook:'Facebook',instagram:'Instagram',linkedin:'LinkedIn',twitter:'X',youtube:'YouTube'})[k];
      return '<a href="'+escapeHtml(_nationLinkify(url))+'" target="_blank" rel="noopener" '
        + 'style="display:inline-flex;align-items:center;gap:5px;padding:4px 10px;font-size:12px;font-weight:600;background:var(--surface);border:1px solid var(--border);border-radius:14px;color:var(--text);text-decoration:none;margin-right:6px;">'
        + label + ' ↗</a>';
    }).join('');

    identEl.innerHTML =
        '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;">'
      +   '<div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px 14px;">'
      +     '<div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;margin-bottom:4px;">Nation</div>'
      +     '<div style="font-size:16px;font-weight:700;color:var(--text);">'+dispVal+'</div>'
      +     '<div class="js-lbl-sm" class="mt-4">ID: <code style="font-family:Consolas,Monaco,monospace;">'+idVal+'</code></div>'
      +   '</div>'
      +   '<div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px 14px;">'
      +     '<div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;margin-bottom:4px;">Hosting</div>'
      +     '<div style="font-size:13px;font-weight:700;color:var(--text);font-family:Consolas,Monaco,monospace;word-break:break-all;">'+escapeHtml(host)+'</div>'
      +     '<div class="js-lbl-sm" class="mt-4">Subdomain-routed</div>'
      +   '</div>'
      + '</div>'
      + (contactRows
          ? '<div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px 14px;margin-top:14px;">'
            + '<div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;margin-bottom:8px;">Contact</div>'
            + '<table style="font-size:13px;color:var(--text);border-collapse:collapse;">' + contactRows + '</table>'
            + '</div>'
          : '')
      + (socialChips
          ? '<div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px 14px;margin-top:14px;">'
            + '<div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;margin-bottom:8px;">Social</div>'
            + socialChips
            + '</div>'
          : '')
      + '<div style="font-size:11px;color:var(--muted);margin-top:12px;font-style:italic;">Nation identity, contact info, and logo are managed by the Executive Director.</div>';
  } else {
    // Editable form — display name, short name, logo upload, save.
    var inputStyle = 'width:100%;padding:8px 12px;border:1px solid var(--border);border-radius:7px;font-size:13px;font-family:DM Sans,sans-serif;box-sizing:border-box;';
    var lblStyle   = 'display:block;font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.7px;margin-bottom:5px;';
    var idleMin    = parseInt(cfg.idle_timeout_minutes, 10) || 15;

    identEl.innerHTML =
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:16px;">'
      +   '<div>'
      +     '<label style="'+lblStyle+'">Nation Display Name</label>'
      +     '<input id="nation_input_display" type="text" value="'+dispVal+'" style="'+inputStyle+'" placeholder="e.g. Your First Nation"/>'
      +     '<div class="js-lbl-sm" style="margin-top:4px;">Used in headers, print templates, and email subjects.</div>'
      +   '</div>'
      +   '<div>'
      +     '<label style="'+lblStyle+'">Short Name / Acronym</label>'
      +     '<input id="nation_input_short" type="text" value="'+shortVal+'" maxlength="16" style="'+inputStyle+'" placeholder="e.g. YFN"/>'
      +     '<div class="js-lbl-sm" style="margin-top:4px;">Used in compact contexts (titles, badges, password defaults).</div>'
      +   '</div>'
      // ── Contact section ─────────────────────────────────────────────
      +   '<div style="grid-column:1/-1;border-top:1px solid var(--border);padding-top:12px;margin-top:4px;">'
      +     '<div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.7px;margin-bottom:10px;">Contact Information</div>'
      +     '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">'
      +       '<div style="grid-column:1/-1;">'
      +         '<label style="'+lblStyle+'">Mailing Address</label>'
      +         '<textarea id="nation_input_address" rows="3" style="'+inputStyle+'resize:vertical;font-family:DM Sans,sans-serif;" placeholder="PO Box 100&#10;Your Community, ON&#10;A1A 1A1">'+escapeHtml(cfg.mailing_address||'')+'</textarea>'
      +         '<div class="js-lbl-sm" style="margin-top:4px;">Free-form. Line breaks are preserved on display; collapsed to one line in print footers.</div>'
      +       '</div>'
      +       '<div>'
      +         '<label style="'+lblStyle+'">Website</label>'
      +         '<input id="nation_input_website" type="text" value="'+escapeHtml(cfg.website||'')+'" style="'+inputStyle+'" placeholder="www.example.ca"/>'
      +       '</div>'
      +       '<div>'
      +         '<label style="'+lblStyle+'">Main Email</label>'
      +         '<input id="nation_input_email" type="email" value="'+escapeHtml(cfg.email||'')+'" style="'+inputStyle+'" placeholder="housing@example.ca"/>'
      +       '</div>'
      +       '<div>'
      +         '<label style="'+lblStyle+'">Main Phone</label>'
      +         '<input id="nation_input_phone" type="tel" value="'+escapeHtml(cfg.phone?formatPhone(cfg.phone):'')+'" style="'+inputStyle+'" placeholder="(705)-555-0100" oninput="fmtPhone(this)"/>'
      +       '</div>'
      +       '<div>'
      +         '<label style="'+lblStyle+'">Email Intake Address</label>'
      +         '<input id="nation_input_intake_email" type="email" value="'+escapeHtml(cfg.intake_email||'')+'" style="'+inputStyle+'" placeholder="clfn@fnhub.app"/>'
      +         '<div class="js-lbl-sm" style="margin-top:4px;">Staff forward emails here to file them to a unit/tenant (Operations &rarr; Email Intake). A matching Cloudflare Email Routing rule to the housing-email-intake worker must exist.</div>'
      +       '</div>'
      +     '</div>'
      +   '</div>'

      // ── Social media section ───────────────────────────────────────
      +   '<div style="grid-column:1/-1;border-top:1px solid var(--border);padding-top:12px;">'
      +     '<div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.7px;margin-bottom:10px;">Social Media</div>'
      +     '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">'
      +       _nationSocialField('facebook',  'Facebook',  'https://facebook.com/yourpage',  socials.facebook)
      +       _nationSocialField('instagram', 'Instagram', 'https://instagram.com/yourpage', socials.instagram)
      +       _nationSocialField('linkedin',  'LinkedIn',  'https://linkedin.com/company/…', socials.linkedin)
      +       _nationSocialField('twitter',   'X (Twitter)','https://x.com/yourpage',         socials.twitter)
      +       _nationSocialField('youtube',   'YouTube',   'https://youtube.com/@yourchannel', socials.youtube)
      +     '</div>'
      +     '<div class="js-lbl-sm" style="margin-top:6px;">Stored for use in future public-facing pages. Leave any field blank to skip it.</div>'
      +   '</div>'

      // ── Session / auto sign-out section ────────────────────────────
      +   '<div style="grid-column:1/-1;border-top:1px solid var(--border);padding-top:12px;">'
      +     '<div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.7px;margin-bottom:10px;">Session</div>'
      +     '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">'
      +       '<div>'
      +         '<label style="'+lblStyle+'">Auto Sign-Out After (minutes idle)</label>'
      +         '<input id="nation_input_idle_minutes" type="number" min="1" max="1440" step="1" value="'+idleMin+'" style="'+inputStyle+'" placeholder="15"/>'
      +         '<div class="js-lbl-sm" style="margin-top:4px;">Inactivity before a user is signed out. The timer resets on any tap or scroll, so active use never triggers it. Field crews on phones/iPads may want a longer window (e.g. 60+).</div>'
      +       '</div>'
      +     '</div>'
      +   '</div>'

      +   '<div style="grid-column:1/-1;display:flex;gap:8px;align-items:center;border-top:1px solid var(--border);padding-top:12px;margin-top:4px;">'
      +     '<button type="button" onclick="saveNationSettings()" class="btn btn-primary">Save Nation Settings</button>'
      +     '<div class="js-lbl-sm">Hosting <code style="font-family:Consolas,Monaco,monospace;">'+escapeHtml(host)+'</code> · ID <code style="font-family:Consolas,Monaco,monospace;">'+idVal+'</code></div>'
      +   '</div>'
      + '</div>';
  }

  // Modules list — core vs optional. Super-users see interactive on/off
  // toggles + license badges; everyone else sees read-only status pills.
  if(!modApi){
    modsEl.innerHTML = '<div class="js-txt-muted-sm">Module registry not available.</div>';
    return;
  }
  // Module enable/disable is managed centrally in the admin portal, not here.
  // This list is read-only (status only) for everyone, including super users.
  var canToggleModules = false;

  var pill = function(label, c, bg){
    return '<span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px;background:'+bg+';color:'+c+';">'+label+'</span>';
  };
  var MODULE_LABELS = {
    rfq:          'RFQ (Request for Quotes)',
    mapping:      'Mapping (Unit Location & Photo)',
    ai_assistant: 'AI Assistant (Chat + Draft Notes)',
    inspections:  'Inspections (Unit Condition Reports)',
    projects:     'Capital Projects (Lots & Builds)',
    email_intake: 'Email Intake (Forward-to-File)'
  };
  var humanize = function(name){
    if(MODULE_LABELS[name]) return MODULE_LABELS[name];
    return name.replace(/_/g,' ').replace(/\b\w/g, function(m){return m.toUpperCase();});
  };
  var coreRow = function(name){
    return '<tr class="row-divider">'
         +   '<td style="padding:10px 12px;font-size:13px;font-weight:600;color:var(--text);">'+humanize(name)+'</td>'
         +   '<td class="pad-12">'+pill('Core','#1d4ed8','var(--info-blue-bg)')+'</td>'
         +   '<td class="pad-12">'+pill('Enabled','var(--success)','var(--success-bg)')+'</td>'
         +   (canToggleModules ? '<td class="pad-12"></td>' : '')
         + '</tr>';
  };
  var optRow = function(name){
    var enabled  = modApi.isEnabled(name);
    var licensed = (typeof modApi.isLicensed === 'function') ? modApi.isLicensed(name) : true;
    var statusPill = enabled
      ? pill('Enabled','var(--success)','var(--success-bg)')
      : pill('Disabled','var(--gray)','#f4f4f0');
    var licensePill = licensed
      ? pill('Licensed','#1d4ed8','var(--info-blue-bg)')
      : pill('Not Licensed','var(--danger)','var(--danger-bg)');
    var typeCell = '<td class="pad-12">'+pill('Optional','#7a6000','#fef9ec')+' '+licensePill+'</td>';
    var toggleCell = '';
    if(canToggleModules){
      var disabledAttr = licensed ? '' : ' disabled';
      var checkedAttr  = enabled ? ' checked' : '';
      toggleCell = '<td class="pad-12">'
        +   '<label class="tsw" title="'+(licensed ? 'Toggle module on/off' : 'Module is not licensed')+'">'
        +     '<input type="checkbox" data-module-toggle="'+name+'"'+checkedAttr+disabledAttr+'/>'
        +     '<span class="tsl"></span>'
        +   '</label>'
        + '</td>';
    }
    return '<tr class="row-divider">'
         +   '<td style="padding:10px 12px;font-size:13px;font-weight:600;color:var(--text);">'+humanize(name)+'</td>'
         +   typeCell
         +   '<td class="pad-12">'+statusPill+'</td>'
         +   toggleCell
         + '</tr>';
  };
  var coreRows = modApi.CORE.map(coreRow).join('');
  var optRows  = modApi.listOptional().map(optRow).join('');
  var toggleHeader = canToggleModules
    ? '<th style="text-align:left;padding:8px 12px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:var(--muted);width:80px;">Toggle</th>'
    : '';

  modsEl.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">'
    +   '<div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;">Modules</div>'
    +   (canToggleModules ? '<div style="font-size:10px;font-weight:700;padding:3px 9px;border-radius:10px;background:#fef9ec;color:#7a6000;border:1px solid var(--warn-amber-border);">Super User</div>' : '')
    + '</div>'
    + '<div class="overflow-x">'
    + '<table class="std-tbl">'
    +   '<thead><tr style="background:var(--bg);border-bottom:2px solid var(--border);">'
    +     '<th style="text-align:left;padding:8px 12px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:var(--muted);">Module</th>'
    +     '<th style="text-align:left;padding:8px 12px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:var(--muted);width:200px;">Type</th>'
    +     '<th style="text-align:left;padding:8px 12px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:var(--muted);width:110px;">Status</th>'
    +     toggleHeader
    +   '</tr></thead>'
    +   '<tbody>'+coreRows+optRows+'</tbody>'
    + '</table>'
    + '</div>'
    + (canToggleModules
        ? '<div style="font-size:11px;color:var(--muted);margin-top:12px;font-style:italic;">Disabling a module hides its nav tile and redirects anyone currently on its page back to the dashboard. Changes are audited.</div>'
        : '<div style="font-size:11px;color:var(--muted);margin-top:12px;font-style:italic;">To enable or disable optional modules for your nation, contact your platform administrator.</div>');

  // Wire toggles (super-user only)
  if(canToggleModules){
    var inputs = modsEl.querySelectorAll('input[data-module-toggle]');
    for(var i=0;i<inputs.length;i++){
      inputs[i].addEventListener('change', function(ev){
        var modName = ev.target.getAttribute('data-module-toggle');
        var nowOn   = !!ev.target.checked;
        _onModuleToggle(modName, nowOn);
      });
    }
  }
  if (typeof renderDataUsagePanel === 'function') renderDataUsagePanel();
}

// ── Data & Storage usage card (Settings -> Nation) ────────────────────────────
// Real byte sizes from the hs_data_usage() SQL function so staff can watch the
// two Supabase tiers this app can exceed (database disk 8 GB, file storage
// 100 GB). Management only; MAU/egress live in the Supabase dashboard.
function _duFmtBytes(b){
  if (b == null) return '—';
  b = Number(b) || 0;
  if (b < 1024*1024)             return (b/1024).toFixed(0) + ' KB';
  if (b < 1024*1024*1024)        return (b/1024/1024).toFixed(1) + ' MB';
  return (b/1024/1024/1024).toFixed(2) + ' GB';
}
function _duBar(usedBytes, limitGB, label, baseColor){
  var used = Number(usedBytes) || 0;
  var limitBytes = limitGB * 1024*1024*1024;
  var pct = Math.min(100, Math.round(used/limitBytes*1000)/10);
  var col = pct >= 90 ? 'var(--danger)' : (pct >= 70 ? 'var(--warn-amber-text)' : (baseColor || 'var(--success)'));
  return '<div style="margin-bottom:14px;">' +
    '<div style="display:flex;justify-content:space-between;gap:8px;font-size:12px;margin-bottom:4px;">' +
      '<span style="font-weight:600;">' + label + '</span>' +
      '<span style="color:var(--muted);">' + _duFmtBytes(used) + ' of ' + limitGB + ' GB included</span></div>' +
    '<div style="height:8px;background:var(--border);border-radius:4px;overflow:hidden;"><div style="height:100%;width:' + pct + '%;background:' + col + ';border-radius:4px;transition:width .4s;"></div></div>' +
    '<div style="font-size:11px;color:' + (pct>=70?col:'var(--muted)') + ';margin-top:3px;">' + pct + '% used' + (pct>=90?' — approaching the included limit':'') + '</div>' +
  '</div>';
}
function _duProjectRef(){
  try { var m = String(SUPABASE_URL||'').match(/https:\/\/([a-z0-9]+)\.supabase/); return (m && m[1]) || ''; } catch(e){ return ''; }
}
// Human-readable label for a raw table name (Largest Tables list). Uses the
// app's user-facing vocabulary -- notably housing_sow -> "Maintenance Requests"
// (the SOW/MR display rule in CLAUDE.md). Unknown tables fall back to a
// prefix-stripped, title-cased form.
function _duTableLabel(name){
  var MAP = {
    housing_audit_log:         'Audit Log',
    housing_applications:      'Applications',
    housing_application_notes: 'Application Notes',
    housing_rfq:               'RFQs',
    housing_units:             'Units',
    housing_sow:               'Maintenance Requests',
    housing_reno_progress:     'Renovation Progress',
    housing_settings:          'Settings',
    housing_contractors:       'Contractors',
    housing_projects:          'Capital Projects',
    housing_project_lots:      'Capital Project Lots',
    tenants:                   'Tenants',
    tenant_notes:              'Tenant Notes',
    inspections:               'Inspections',
    bcr_registry:              'BCR Registry',
    staff:                     'Staff',
    finance_audit_log:         'Finance Audit Log'
  };
  var n = String(name == null ? '' : name);
  if (MAP[n]) return MAP[n];
  var s = n.replace(/^housing_/, '').replace(/_/g, ' ').trim();
  s = s.replace(/\bfinance\b/i, 'Finance').replace(/\brfq\b/i, 'RFQ');
  return s.replace(/\b\w/g, function(m){ return m.toUpperCase(); });
}
function _renderUsageHtml(d){
  var esc = (typeof escapeHtml === 'function') ? escapeHtml : function(s){ return String(s==null?'':s); };
  var tables = (d.tables || []).slice(0, 8).map(function(t){
    return '<tr><td style="padding:4px 8px;">' + esc(_duTableLabel(t.table)) + '</td>' +
      '<td style="padding:4px 8px;text-align:right;font-variant-numeric:tabular-nums;">' + _duFmtBytes(t.bytes) + '</td></tr>';
  }).join('');
  var ref = _duProjectRef();
  var billingLink = ref ? ('https://supabase.com/dashboard/project/' + ref + '/settings/billing') : 'https://supabase.com/dashboard';
  return _duBar(d.database_bytes, 8, 'Database size', '#1d4ed8') +
    _duBar(d.storage_bytes, 100, 'File storage (documents & photos)', '#7c3aed') +
    '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:16px 0 6px;">Largest tables</div>' +
    '<div class="std-table-card"><table class="std-table" style="font-size:12px;"><tbody>' + tables + '</tbody></table></div>' +
    '<div style="font-size:11px;color:var(--muted);margin-top:12px;line-height:1.55;">Included tiers are Supabase Pro. Overage: <strong>$0.125/GB</strong> over 8 GB database, <strong>$0.0213/GB</strong> over 100 GB storage. <strong>Monthly active users, egress, and log retention</strong> aren\'t measurable from the app — see the <a href="' + billingLink + '" target="_blank" rel="noopener" style="color:var(--info,#1d4ed8);font-weight:600;">Supabase Usage &amp; Billing</a> page. Audit-log rows grow fastest; they can be trimmed in the SQL Editor if needed.</div>';
}
function renderDataUsagePanel(){
  var host = document.getElementById('nation_panel_usage');
  if (!host) return;
  var isMgmt = (typeof ROLE !== 'undefined' && ROLE.isManagement) ? ROLE.isManagement(window.currentRole) : false;
  if (!isMgmt) { host.innerHTML = ''; return; }
  host.innerHTML = '<div class="card card-flush"><div class="modal-hdr"><div class="lbl-yellow">&#128190; Data &amp; Storage Usage</div>' +
    '<button type="button" onclick="renderDataUsagePanel()" class="btn btn-ghost-dark btn-sm" title="Refresh" style="color:var(--yellow);border-color:var(--yellow);font-size:15px;line-height:1;padding:5px 11px;">&#8635;</button></div>' +
    '<div class="sec-pad" id="nation_usage_body"><div style="color:var(--muted);font-size:13px;">Loading usage…</div></div></div>';
  fetch(SUPABASE_URL + '/rest/v1/rpc/hs_data_usage', {
    method:  'POST',
    headers: Object.assign({}, HOUSING_HEADERS, { 'Content-Type': 'application/json' }),
    body:    '{}'
  }).then(function(r){
    return r.text().then(function(t){ return { ok: r.ok, status: r.status, text: t }; });
  }).then(function(res){
    var body = document.getElementById('nation_usage_body'); if (!body) return;
    var d = null; try { d = JSON.parse(res.text); } catch(e){}
    if (res.ok && d) { body.innerHTML = _renderUsageHtml(d); _reportUsageToPlatform(d); return; }
    // Distinguish the real failure modes so this isn't always "run the migration".
    var msg;
    if (res.status === 404) {
      msg = 'The <code>hs_data_usage</code> function isn\'t in the database yet. Run its migration in the Supabase SQL Editor.';
    } else if (/not permitted/i.test(res.text)) {
      msg = 'Your account doesn\'t have permission to view usage (management only).';
    } else {
      msg = 'Usage data unavailable right now. View sizes in the Supabase dashboard, or re-run the <code>hs_data_usage</code> migration.';
    }
    body.innerHTML = '<div style="color:var(--muted);font-size:13px;">' + msg + '</div>';
  }).catch(function(){
    var body = document.getElementById('nation_usage_body'); if (body) body.innerHTML = '<div style="color:var(--muted);font-size:13px;">Could not load usage right now.</div>';
  });
}
window.renderDataUsagePanel = renderDataUsagePanel;

// Push model: report this nation's usage up to the control plane so the FN Hub
// admin portal can show per-nation usage. The platform Edge Function re-verifies
// the caller through the nation's own hs_data_usage() gate and re-reads the
// authoritative numbers, so `d` here is only a "we have fresh usage" trigger,
// not the source of truth. Fully fail-safe; once per browser session per nation.
function _reportUsageToPlatform(d){
  try {
    var purl = String(window.PLATFORM_REGISTRY_URL || '');
    var anon = String(window.PLATFORM_REGISTRY_ANON || '');
    if (!purl || !anon || /REPLACE_WITH/.test(anon)) return;
    // Subdomain must be a real <sub>.fnhub.app host (skips localhost / previews).
    var host = (typeof location !== 'undefined' && location.hostname || '').toLowerCase();
    var m = host.match(/^([a-z0-9-]+)\.fnhub\.app$/);
    var sub = m && m[1]; if (!sub) return;
    var token = (window.HOUSING_SESSION && HOUSING_SESSION.accessToken) || '';
    if (!token) return;
    // Report once per session, but only mark it done on SUCCESS -- so if the
    // platform function isn't deployed yet a later refresh retries instead of
    // being permanently suppressed for the session.
    var flag = '_fnhub_usage_reported_' + sub;
    try { if (sessionStorage.getItem(flag)) return; } catch(e){}
    fetch(purl.replace(/\/+$/, '') + '/functions/v1/report-nation-usage', {
      method:  'POST',
      headers: { apikey: anon, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ subdomain: sub })
    }).then(function(r){
      if (r && r.ok) { try { sessionStorage.setItem(flag, '1'); } catch(e){} }
    }).catch(function(){ /* telemetry only -- never disrupts the page */ });
  } catch(e){ /* never let reporting break the usage card */ }
}
window._reportUsageToPlatform = _reportUsageToPlatform;

// Super-user toggle handler. Mutates CLFN_MODULES, persists to housing_settings,
// audits, re-renders the panel, and — if disabling a module the user is
// currently on — redirects them back to the dashboard.
function _onModuleToggle(modName, nowOn) {
  var modApi = window.CLFN_MODULES;
  if(!modApi) return;
  var prev = modApi.isEnabled(modName);
  if(nowOn) modApi.enable(modName); else modApi.disable(modName);

  // Persist via the existing housing_settings save helper
  var payload = modApi.serialize();
  if(typeof sbSaveSetting === 'function'){
    saveSettingWithDraftFallback('module_enablement', payload).catch(function(e){
      console.warn('[modules] save failed:', e);
      if(typeof showToast === 'function') showToast('Module save failed: ' + (e && e.message || e), { type:'error' });
    });
  }
  // Mirror locally so subsequent reads on this page see the new state
  if(window._appSettings) window._appSettings['module_enablement'] = payload;

  // Audit
  if(typeof auditEntry === 'function'){
    var actor = (window.HOUSING_SESSION && HOUSING_SESSION.email) || (window.currentRole || 'super_user');
    auditEntry('SETTINGS', 'module_toggle',
      modName + ': ' + (prev ? 'enabled' : 'disabled') + ' → ' + (nowOn ? 'enabled' : 'disabled'),
      actor);
  }

  // Re-render panel + nav tiles. Re-run the home renderer if the user is
  // currently on the landing (or legacy employeeHomeView, sub-page only) so
  // module enable/disable changes show up immediately in the nav strip.
  renderNationPanel();
  if (typeof _syncAIHeaderBtn === 'function') _syncAIHeaderBtn();
  var landingEl = document.getElementById('landingView');
  var ehv       = document.getElementById('employeeHomeView');
  var onHome = (landingEl && landingEl.style.display !== 'none' && landingEl.style.display !== '')
            || (ehv       && ehv.style.display       !== 'none' && ehv.style.display       !== '');
  if(onHome && typeof showEmployeeHome === 'function') showEmployeeHome();
  if(landingEl && typeof renderHeaderNav === 'function') renderHeaderNav();

  // If the module is being disabled and the current page is that module's
  // page, redirect to the dashboard. Same-tab guarantee only — other open
  // sessions will redirect on their next navigation since gate checks at the
  // top of each module page now read the persisted state.
  if(!nowOn){
    var path = (window.location.pathname || '').toLowerCase();
    var moduleHosts = {
      finance:      'finance.html',
      match:        'match.html',
      contractors:  'contractors.html',
      renovations:  'renos.html'
    };
    var host = moduleHosts[modName];
    if(host && path.indexOf(host) !== -1){
      window.location.href = 'housing.html';
    }
  }

  if(typeof showToast === 'function') showToast(modName + (nowOn ? ' enabled' : ' disabled') + '.', {type:'info'});
}

// ── Nation editor render helpers ────────────────────────────────────────────
// Tiny markup builders used by renderNationPanel(). Kept top-level so they
// can be hoisted by the JS engine and referenced from the inline HTML
// template above without depending on render-order quirks.
function _nationSocialField(key, label, placeholder, value) {
  var inputStyle = 'width:100%;padding:8px 12px;border:1px solid var(--border);border-radius:7px;font-size:13px;font-family:DM Sans,sans-serif;box-sizing:border-box;';
  var lblStyle   = 'display:block;font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.7px;margin-bottom:5px;';
  return '<div>'
    +   '<label style="'+lblStyle+'">'+label+'</label>'
    +   '<input id="nation_input_'+key+'" type="text" value="'+escapeHtml(value||'')+'" style="'+inputStyle+'" placeholder="'+placeholder+'"/>'
    + '</div>';
}
function _nationContactRow(label, valueHtml, isMultiline) {
  return '<tr>'
    +   '<td style="padding:4px 14px 4px 0;color:var(--muted);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;vertical-align:top;white-space:nowrap;">'+label+'</td>'
    +   '<td style="padding:4px 0;'+(isMultiline ? 'line-height:1.5;' : '')+'">'+valueHtml+'</td>'
    + '</tr>';
}
// Loose URL normalizer — adds https:// when the user typed a bare host so
// <a href> works without a JS error. Anything that already has a scheme is
// returned as-is. Not a security check — just a quality-of-life helper.
function _nationLinkify(s) {
  s = String(s||'').trim();
  if (!s) return '';
  if (/^[a-z][a-z0-9+.\-]*:\/\//i.test(s)) return s;
  if (/^mailto:/i.test(s)) return s;
  return 'https://' + s.replace(/^\/+/, '');
}

function saveNationSettings() {
  var role = window.currentRole || '';
  if (!APPROVAL_AUTHORITY.can('editApprovalAuthority', role)) {
    showToast('Only the Executive Director can edit nation settings.', { type: 'error' });
    return;
  }
  function v(id){ var el=document.getElementById(id); return el ? (el.value||'').trim() : ''; }
  var disp  = v('nation_input_display');
  var short = v('nation_input_short');
  if (!disp)  { showToast('Display name is required', { type: 'error' }); var de=document.getElementById('nation_input_display'); if(de) de.focus(); return; }
  if (!short) { showToast('Short name is required', { type: 'error' });   var se=document.getElementById('nation_input_short');   if(se) se.focus(); return; }
  if (short.length > 16) { showToast('Short name must be 16 characters or fewer', {type:'info'}); return; }

  var emailVal = v('nation_input_email');
  if (emailVal && !/.+@.+\..+/.test(emailVal)) {
    showToast('Email address looks malformed', {type:'info'}); var ee=document.getElementById('nation_input_email'); if(ee) ee.focus(); return;
  }

  // Build the socials sub-object from whichever fields are populated.
  var socials = {};
  ['facebook','instagram','linkedin','twitter','youtube'].forEach(function(k){
    var val = v('nation_input_'+k);
    if (val) socials[k] = val;
  });

  // Auto sign-out window (minutes idle). Clamp to a sane 1..1440 range and
  // fall back to the 15-minute default for blank/garbage input.
  var idleMin = parseInt(v('nation_input_idle_minutes'), 10);
  if (!idleMin || idleMin < 1) idleMin = 15;
  if (idleMin > 1440) idleMin = 1440;

  // Persist nation identity + contact + social overrides.
  var override = {
    display_name:    disp,
    name:            disp,
    short:           short,
    mailing_address: v('nation_input_address'),
    website:         v('nation_input_website'),
    phone:           v('nation_input_phone'),
    email:           emailVal,
    intake_email:    v('nation_input_intake_email'),
    socials:         socials,
    idle_timeout_minutes: idleMin
  };
  if (!window._appSettings) window._appSettings = {};
  window._appSettings.nation_config_override = override;

  var pending = [];
  pending.push(saveSettingWithDraftFallback('nation_config_override', override));

  Promise.all(pending).then(function(results){
    var allOk = results.every(function(ok){ return ok !== false; });
    // Apply locally regardless of server result so the UI reflects intent.
    if (typeof applyNationOverrides === 'function') applyNationOverrides();
    if (allOk) {
      showToast('Nation settings saved', {type:'info'});
      if (typeof auditEntry === 'function') {
        var summary = 'Nation settings updated: ' + disp + ' (' + short + ')';
        var extras = [];
        if (override.mailing_address) extras.push('address');
        if (override.phone)           extras.push('phone');
        if (override.email)           extras.push('email');
        if (override.website)         extras.push('website');
        var socialKeys = Object.keys(socials);
        if (socialKeys.length) extras.push(socialKeys.length + ' social link' + (socialKeys.length===1?'':'s'));
        if (extras.length) summary += ' — ' + extras.join(', ');
        auditEntry('SETTINGS', 'nation_updated', summary, role);
      }
    } else {
      showToast('Saved locally — server sync failed', { type: 'error' });
    }
    renderNationPanel();
  });
}

function setPts(elId,score){
  const el=document.getElementById(elId);if(!el)return;
  const abs=Math.abs(score);
  el.textContent=score>0?'+'+score+' pts':score<0?score+' pts':'0 pts';
  el.style.background=score>0?'var(--success-bg)':score<0?'var(--danger-bg)':'var(--yellow-light)';
  el.style.color=score>0?'var(--success)':score<0?'var(--danger)':'#7a6000';
}

// ── V2 tenancy prior toggle ──
function onPriorTenancyChange() {
  var val = (document.getElementById('no_prior_tenancy')||{}).value || 'true';
  var isNew = val === 'true';
  var histFields = document.getElementById('tenancy_history_fields');
  if (histFields) histFields.style.display = isNew ? 'none' : 'block';
  triggerV2Score();
}

// ── Unlock HM-only fields based on role ──
function applyTenancyFieldRoles() {
  var role = window.currentRole || 'housing_employee_l1';
  var isHM = (ROLE.isManagement(role));
  var badge = document.getElementById('tenancy_hm_badge');
  var lockedMsg = document.getElementById('tenancy_locked_msg');
  if (badge) badge.style.display = isHM ? 'flex' : 'none';
  document.querySelectorAll('.field-hm-only').forEach(function(el) {
    el.disabled = !isHM;
    el.style.opacity = isHM ? '1' : '0.5';
    el.style.cursor  = isHM ? '' : 'not-allowed';
  });
  if (lockedMsg) lockedMsg.style.display = isHM ? 'none' : 'block';
}

// ── triggerV2Score — calls the Edge Function and updates display ──

// ── Build V2 form selects from live scoring model ──────────────────────────
function buildV2FormSelects() {
  var model = liveScoreModel;
  // Re-read from appSettings in case they loaded after init.
  if(window._appSettings) {
    var src = window._appSettings['scoring_model_v2'] || window._appSettings['scoring_model'];
    if(src && src.length) {
      // Legacy V1 ARRAY format (rows with cat/label/pts).
      model = src.map(function(r) {
        if(r.pts === undefined && r.p !== undefined) return Object.assign({}, r, {pts: r.p});
        return r;
      });
    } else if (src && typeof src === 'object' && typeof _v1RowsFromV2 === 'function') {
      // Saved V2 OBJECT (what saveV2ScoringModel actually persists). The old
      // `src.length` test silently skipped it, so these dropdown point labels
      // never reflected the ED's edits. Merge over defaults, then synthesize
      // the V1 rows this renderer needs.
      var _eff = (typeof _effectiveV2Model === 'function') ? _effectiveV2Model() : src;
      model = _v1RowsFromV2(_eff);
    }
  }

  // Defensive: if neither liveScoreModel nor _appSettings provided a model,
  // bail out gracefully. This can happen on first load before settings
  // fetch completes, or if the scoring_model_v2 key is missing in Supabase.
  // The form will render with its static default <option>s from the HTML.
  if(!model || !model.length) {
    console.warn('[scoring] buildV2FormSelects: no scoring model available yet — leaving form defaults in place');
    return;
  }

  // Helper: get rows for a category
  function catRows(cat) {
    return model.filter(function(r) { return r.cat === cat; });
  }

  // urgent_need select
  var unSel = document.getElementById('urgent_need');
  if(unSel) {
    var unRows = catRows('urgent_need');
    if(unRows.length) {
      var curVal = unSel.value;
      unSel.innerHTML = unRows.map(function(r, i) {
        var pts = (r.pts !== undefined ? r.pts : (r.p||0));
        var val = i === 0 ? 'none' : 'level_'+i;
        // Map by position: un1=none, un2=level_2, un3=level_3, un4=level_4
        val = r.id === 'un1' ? 'none' : r.id === 'un2' ? 'overcrowded' : r.id === 'un3' ? 'eviction' : r.id === 'un4' ? 'emergency' : r.id === 'un5' ? 'homeless' : 'none';
        return '<option value="'+val+'">'+ r.label + (pts > 0 ? ' (+'+pts+' pts)' : ' ('+pts+' pts)') +'</option>';
      }).join('');
      // Categories that exist only in the V2 model (no legacy un* row) —
      // appended so the rebuild doesn't wipe them from the select.
      var _tsPts = ((window.liveV2ScoreModel || {}).urgent_need || {}).temporary_shelter;
      if (_tsPts === undefined) _tsPts = (window.DEFAULT_V2_SCORE_MODEL.urgent_need || {}).temporary_shelter || 0;
      unSel.innerHTML += '<option value="temporary_shelter">Temporary Shelter (+' + _tsPts + ' pts)</option>';
      if(curVal) unSel.value = curVal;
    }
  }

  // health_risk select
  var hrSel = document.getElementById('health_risk');
  if(hrSel) {
    var hrRows = catRows('health_safety');
    if(hrRows.length) {
      var curHr = hrSel.value;
      hrSel.innerHTML = hrRows.map(function(r) {
        var pts = (r.pts !== undefined ? r.pts : (r.p||0));
        var val = r.id === 'hs1' ? 'none' : r.id === 'hs2' ? 'minor' : r.id === 'hs3' ? 'moderate' : 'severe';
        return '<option value="'+val+'">'+r.label+' ('+pts+' pts)</option>';
      }).join('');
      if(curHr) hrSel.value = curHr;
    }
  }

  // income_stability select
  var isSel = document.getElementById('income_stability');
  if(isSel) {
    var isRows = catRows('income_stability');
    if(isRows.length) {
      var curIs = isSel.value;
      isSel.innerHTML = isRows.map(function(r) {
        var pts = (r.pts !== undefined ? r.pts : (r.p||0));
        var val = r.id === 'is1' ? 'stable' : 'unstable';
        return '<option value="'+val+'">'+r.label+' ('+pts+' pts)</option>';
      }).join('');
      if(curIs) isSel.value = curIs;
    }
  }

  // Update household composition pt labels
  var hcRows = catRows('household_comp');
  hcRows.forEach(function(r) {
    var pts = (r.pts !== undefined ? r.pts : (r.p||0));
    var labelId = r.id === 'hc1' ? 'lp_pts_label' : r.id === 'hc2' ? 'ei_pts_label' : 'hd_pts_label';
    var el = document.getElementById(labelId);
    if(el) el.textContent = '(+'+pts+' pts)';
  });

  // Update occupancy per-person label
  var ocRows = catRows('occupancy');
  if(ocRows.length) {
    var ocEl = document.getElementById('oc_pts_label');
    if(ocEl) ocEl.textContent = '('+ocRows[0].pts+' pt each, max 10 pts)';
  }
}



// ══════════════════════════════════════════════════════════════
// NOS TABLE — National Occupancy Standard
// ══════════════════════════════════════════════════════════════

var DEFAULT_NOS_TABLE = {
  '0': 1,   // Studio / no bedroom — 1 person max
  '1': 2,   // 1 bedroom — 2 persons max
  '2': 4,   // 2 bedrooms — 4 persons max
  '3': 6,   // 3 bedrooms — 6 persons max
  '4': 8,   // 4 bedrooms — 8 persons max
  '5': 10   // 5+ bedrooms — 10 persons max
};


function getNosTable() {
  // Read from settings (loaded from Supabase), fall back to default
  if(window._appSettings && window._appSettings['nos_table']) {
    return Object.assign({}, DEFAULT_NOS_TABLE, window._appSettings['nos_table']);
  }
  return Object.assign({}, DEFAULT_NOS_TABLE);
}

function renderNosTable() {
  var tbody = document.getElementById('nos_table_tbody');
  if(!tbody) return;
  var defaults = {'0':1,'1':2,'2':4,'3':6,'4':8,'5':10};
  var bedLabels = {'0':'Studio / 0 bedrooms','1':'1 bedroom','2':'2 bedrooms','3':'3 bedrooms','4':'4 bedrooms','5':'5+ bedrooms'};
  var nos = defaults;
  try { if(typeof getNosTable === 'function') nos = getNosTable(); } catch(e) { nos = defaults; }
  var isED = APPROVAL_AUTHORITY.can('editScoreModel', window.currentRole);
  tbody.innerHTML = Object.keys(bedLabels).map(function(beds) {
    var maxPeople = (nos[beds] !== undefined) ? nos[beds] : defaults[beds];
    var label = bedLabels[beds];
    var inputStyle = 'width:72px;padding:4px 8px;border:1.5px solid var(--border);border-radius:6px;font-size:13px;font-weight:700;color:var(--text);text-align:center;font-family:DM Sans,sans-serif;background:var(--surface);' + (isED ? '' : 'opacity:0.55;cursor:not-allowed;');
    return '<tr class="row-divider">'
      + '<td style="padding:10px 12px;font-size:13px;color:var(--text);">' + label + '</td>'
      + '<td style="padding:10px 12px;text-align:center;">'
      + '<input type="number" data-nos-beds="' + beds + '" value="' + maxPeople + '" min="1" max="20" step="1" ' + (isED ? '' : 'disabled ') + 'style="' + inputStyle + '"/>'
      + '<span style="font-size:11px;color:var(--muted);margin-left:6px;">persons</span>'
      + '</td></tr>';
  }).join('');
}


function saveNosTable() {
  if(!APPROVAL_AUTHORITY.can('editScoreModel', window.currentRole)) {
    showToast('Only the Executive Director can update the NOS table.', { type: 'error' });
    return;
  }
  var nos = {};
  document.querySelectorAll('#nos_table_tbody input[data-nos-beds]').forEach(function(el) {
    var beds = el.getAttribute('data-nos-beds');
    nos[beds] = parseInt(el.value) || DEFAULT_NOS_TABLE[beds];
  });

  // Save to _appSettings and Supabase
  if(!window._appSettings) window._appSettings = {};
  window._appSettings['nos_table'] = nos;

  saveSettingWithDraftFallback('nos_table', nos).then(function(ok) {
    if(ok) {
      showToast('\u2713 NOS table saved', {type:'info'});
      auditEntry('SETTINGS', 'nos_table_save', 'NOS table updated by ED', CLFN_PERMS.roleLabel(ROLE.ED));
    } else {
      showToast('Save failed — check connection', { type: 'error' });
    }
  });
}


// ── Auto-calculate Persons Over Occupancy Standard ───────────────────────────
function calcPersonsOverStandard() {
  // Count total household members
  var habCount  = document.querySelectorAll('#habList .rrow').length;
  var coStatus  = (document.getElementById('co_status')||{}).value || 'no';
  var coCount   = (coStatus === 'yes' || coStatus === 'y') ? 1 : 0;
  var totalPeople = 1 + coCount + habCount; // applicant + co-applicant + members

  // NOS: max occupants allowed per bedroom count — read from settings
  var nosSettings = (typeof getNosTable === 'function') ? getNosTable() : {'0':1,'1':2,'2':4,'3':6,'4':8,'5':10};
  var nosMax = [
    nosSettings['0'] || 1,
    nosSettings['1'] || 2,
    nosSettings['2'] || 4,
    nosSettings['3'] || 6,
    nosSettings['4'] || 8,
    nosSettings['5'] || 10
  ];

  // Recommended bedroom size per NOS — smallest bedroom count whose max ≥ totalPeople.
  // Sizes are 0..nosMax.length-1 (0 = bachelor / studio).
  var recommendedBeds = nosMax.length - 1;
  for (var i = 0; i < nosMax.length; i++) {
    if (nosMax[i] >= totalPeople) { recommendedBeds = i; break; }
  }
  var recommendedLabel = recommendedBeds === 0 ? 'Bachelor / Studio' : (recommendedBeds + '-bedroom');

  // Determine the applicant's current band-unit bedroom count. Only a selected
  // current unit (`currentUnitId`) is treated as a "matched house" — without
  // it we can't know the bedroom count, so we don't compute over-standard.
  var currentUnitEl = document.getElementById('currentUnitId');
  var hasMatchedUnit = !!(currentUnitEl && currentUnitEl.value);
  var currentBeds = 0;
  if(hasMatchedUnit) {
    var allUnits = (typeof housingUnits !== 'undefined') ? housingUnits : [];
    var unit = allUnits.find(function(u){ return u.id === currentUnitEl.value; });
    if(unit) currentBeds = parseInt(unit.bedrooms) || 0;
  }

  // Over-standard only counts when we have a matched unit with a known bedroom count.
  var over = 0;
  if (hasMatchedUnit) {
    var maxAllowed = nosMax[Math.min(currentBeds, nosMax.length-1)];
    over = Math.max(0, Math.min(10, totalPeople - maxAllowed));
  }

  // Update the hidden input that scoring + save read from.
  var posEl = document.getElementById('persons_over_standard');
  if(posEl) posEl.value = over;

  // Composite display on the Housing Needs step.
  var totEl = document.getElementById('occ_total_display');
  if(totEl) totEl.textContent = totalPeople;
  var totLbl = document.getElementById('occ_total_label');
  if(totLbl) totLbl.textContent = totalPeople === 1 ? 'person' : 'people';
  var recEl = document.getElementById('occ_recommended_display');
  if(recEl) recEl.textContent = recommendedLabel;
  var overRow = document.getElementById('occ_over_row');
  var noUnitRow = document.getElementById('occ_no_unit_row');
  if (hasMatchedUnit) {
    if(overRow) overRow.hidden = false;
    if(noUnitRow) noUnitRow.hidden = true;
    var overEl = document.getElementById('occ_over_display');
    if(overEl) overEl.textContent = over;
    var ctxEl = document.getElementById('occ_over_context');
    if(ctxEl) {
      var currentLabel = currentBeds === 0 ? 'Bachelor / Studio' : (currentBeds + '-bedroom');
      ctxEl.textContent = '(current unit: ' + currentLabel + ')';
    }
  } else {
    if(overRow) overRow.hidden = true;
    if(noUnitRow) noUnitRow.hidden = false;
  }

  // Vestigial counters — kept guarded so any leftover wiring still works.
  var occCo  = document.getElementById('occ_coapplicant'); if(occCo) occCo.textContent = coCount;
  var occMem = document.getElementById('occ_members');    if(occMem) occMem.textContent = habCount;
  var occTot = document.getElementById('occ_total');      if(occTot) occTot.textContent = totalPeople;
  var scSize = document.getElementById('sc_size');        if(scSize) scSize.value = Math.min(7, Math.max(1, totalPeople));

  return over;
}


// Resolve the effective V2 scoring model: the ED-saved liveV2ScoreModel merged
// section-by-section over DEFAULT_V2_SCORE_MODEL (so a model saved before a
// section/option existed still gets defaults for the gaps).
function _effectiveV2Model() {
  var def  = window.DEFAULT_V2_SCORE_MODEL || {};
  var live = window.liveV2ScoreModel || {};
  var model = {};
  Object.keys(def).forEach(function(section){
    model[section] = Object.assign({}, def[section], (live[section] && typeof live[section] === 'object') ? live[section] : {});
  });
  return model;
}
window._effectiveV2Model = _effectiveV2Model;

function scoreApplicationLocally(app) {
  // Deceased applicants are never scored: the application is kept as a record
  // but carries no waitlist need — zero score, no tier ranking. (They are
  // also excluded from Match and blocked from assignment.)
  if (app && app.deceased) {
    return { score:0, tier:'Not Scored', isNewApplicant:false, deceased:true,
      breakdown:{ sectionA:{ total:0, urgent:0, health:0, overcrowding:0, household:0, accessibility:0, waitlist:0 },
                  sectionB:{ total:0, rent:0, condition:0, conduct:0, income:0 }, arrears:0, edAdjustment:0 } };
  }
  // Every point value comes from the ED-adjustable model (Settings → Scoring),
  // NOT hardcoded literals. The old version hardcoded all maps — the ED edited
  // weights, got a success toast and audit row, and scoring never changed
  // (several literals didn't even match the editor's displayed defaults).
  // Structural behavior stays code-owned: the haveHouse gate on overcrowding,
  // the +1/yr uncapped waitlist accrual, and the isNew→no_history routing.
  var M = _effectiveV2Model();
  function pts(section, key, fallbackKey){
    var sec = M[section] || {};
    var v = sec[key];
    if (v === undefined && fallbackKey !== undefined) v = sec[fallbackKey];
    return Number(v) || 0;
  }
  // Living-situation fallback (feeds EXISTING factors, no new knobs): when no
  // explicit urgent-need category was set, a no-fixed-address applicant scores
  // the model's own "homeless" points. Never overrides a staff-set category.
  var _effUrgentNeed = app.urgentNeed;
  if (!_effUrgentNeed || _effUrgentNeed === 'none') {
    if (app.livingSituation === 'no_fixed_address') _effUrgentNeed = 'homeless';
    else if (app.livingSituation === 'temporary_shelter') _effUrgentNeed = 'temporary_shelter';
  }
  var urgentPts = pts('urgent_need', _effUrgentNeed || 'none', 'none');
  var healthPts = pts('health_risk', app.healthRisk || 'none', 'none');
  // Overcrowding applies when the applicant lives in a house that is over
  // occupancy: their own (haveHouse), or — the doubled-up case — a family
  // member's home on reserve that is not their own. A member couch-surfing in
  // a packed relative's house scored ZERO here before, understating real need.
  var overcrowdingPts = (app.haveHouse || app.livingSituation === 'family_on_reserve')
    ? Math.min(10, Math.max(0, parseInt(app.personsOverStandard || '0') || 0))
    : 0;
  var H = M.household || {};
  var deps = Math.max(0, parseInt(app.dependentsUnder18 || '0') || 0);
  var depPts = Math.min(Number(H.max_dependents) || 0, deps * (Number(H.per_dependent_u18) || 0));
  var householdPts = Math.min(Number(H.max_total) || 0,
    depPts
    + (app.elderInHousehold   ? (Number(H.elder)       || 0) : 0)
    + (app.loneParent         ? (Number(H.lone_parent) || 0) : 0)
    + (app.householdDisability? (Number(H.disability)  || 0) : 0));
  var accessPts = pts('accessibility', app.accessibilityNeed || 'none', 'none');
  // No cap — an applicant keeps accruing +1 pt for every full year on the
  // waitlist, however long that ends up being.
  var waitlistPts = 0;
  if (app.appDate) { var yrs = (Date.now() - new Date(app.appDate).getTime()) / (365.25*24*3600*1000); waitlistPts = Math.max(0, Math.floor(yrs)); }
  var sectionA = urgentPts + healthPts + overcrowdingPts + householdPts + accessPts + waitlistPts;
  var isNew = (app.noPriorTenancy === true || app.noPriorTenancy === 'true');
  var rentPts    = pts('rent_payment',    isNew ? 'no_history' : (app.rentPaymentHistory || 'no_history'), 'no_history');
  var condPts    = pts('unit_condition',  isNew ? 'no_history' : (app.unitCondition      || 'no_history'), 'no_history');
  var conductPts = pts('tenancy_conduct', isNew ? 'no_history' : (app.tenancyConduct     || 'no_history'), 'no_history');
  var incomePts  = pts('income_stability', app.incomeStability || 'stable', 'stable');
  var sectionB = rentPts + condPts + conductPts + incomePts;
  var arrearsDed = pts('arrears', app.arrearsStatus || 'none', 'none');
  var edAdj = parseInt(app.edAdjustment || '0') || 0;
  var finalScore = Math.max(0, sectionA + sectionB + arrearsDed + edAdj);
  var tier = (typeof tierFor === 'function') ? tierFor(finalScore)
    : (function(){ var _t = window.liveV2Tiers || { critical:80, high:60, medium:40 };
        return finalScore >= _t.critical ? 'Critical Priority' : finalScore >= _t.high ? 'High Priority' : finalScore >= _t.medium ? 'Medium Priority' : 'Low Priority'; })();
  return { score:finalScore, tier:tier, isNewApplicant:isNew, breakdown:{ sectionA:{ total:sectionA, urgent:urgentPts, health:healthPts, overcrowding:overcrowdingPts, household:householdPts, accessibility:accessPts, waitlist:waitlistPts }, sectionB:{ total:sectionB, rent:rentPts, condition:condPts, conduct:conductPts, income:incomePts }, arrears:arrearsDed, edAdjustment:edAdj } };
}

function triggerV2Score() {
  var appDate = (document.getElementById('appDate')||{}).value || '';
  var noPrior = (document.getElementById('no_prior_tenancy')||{}).value === 'true';

  // Auto-calculate persons over standard from household size
  calcPersonsOverStandard();
  var personsOver = parseInt((document.getElementById('persons_over_standard')||{}).value || '0') || 0;

  // Dependents under 18 from habList
  var dependentsUnder18 = 0;
  document.querySelectorAll('#habList .rrow').forEach(function(row) {
    var dobEl = row.querySelector('[data-role="habDob"]');
    if (!dobEl || !dobEl.value) return;
    var age = (Date.now() - new Date(dobEl.value).getTime()) / (365.25*24*3600*1000);
    if (age < 18) dependentsUnder18++;
  });

  // Arrears status — derive from applicant AND co-applicant toggles + plan months.
  // Worst-case wins: if either party has arrears with no repayment plan, status
  // is 'no_repayment'; if either has arrears (and all are on a plan), status is
  // 'repayment'; otherwise 'none'. Both parties' info round-trips separately
  // (app.* for applicant, app.coApp.* for co-applicant); only the derived
  // status feeds the score so we don't have to change the scoring model.
  var appArrChecked = !!(document.getElementById('arrToggle') && document.getElementById('arrToggle').checked);
  var coArrChecked  = !!(document.getElementById('coArrToggle') && document.getElementById('coArrToggle').checked);
  var arrStatus = 'none';
  if (appArrChecked || coArrChecked) {
    var appPlan = parseInt((document.getElementById('arrPlanMonths')||{}).value || '0') || 0;
    var coPlan  = parseInt((document.getElementById('coArrPlanMonths')||{}).value || '0') || 0;
    var anyNoPlan = (appArrChecked && appPlan === 0) || (coArrChecked && coPlan === 0);
    arrStatus = anyNoPlan ? 'no_repayment' : 'repayment';
  }

  // Accessibility — map to high/moderate/none
  var accVal = (document.getElementById('accessibility')||{}).value || '';
  var accessNeed = 'none';
  if (accVal && accVal !== 'None' && accVal !== '' && accVal !== '0') {
    // Wheelchair or structural needs = high, sensory = moderate
    if (/wheelchair/i.test(accVal)) accessNeed = 'high';
    else accessNeed = 'moderate';
  }

  var appData = {
    urgentNeed:          (document.getElementById('urgent_need')||{}).value || 'none',
    healthRisk:          (document.getElementById('health_risk')||{}).value || 'none',
    personsOverStandard: String(personsOver),
    dependentsUnder18:   String(dependentsUnder18),
    loneParent:          !!(document.getElementById('lone_parent')||{}).checked,
    elderInHousehold:    !!(document.getElementById('elder_in_household')||{}).checked,
    householdDisability: !!(document.getElementById('household_disability')||{}).checked,
    accessibilityNeed:   accessNeed,
    appDate:             appDate,
    noPriorTenancy:      noPrior,
    rentPaymentHistory:  (document.getElementById('rent_payment_history')||{}).value || 'no_history',
    unitCondition:       (document.getElementById('unit_condition')||{}).value || 'no_history',
    tenancyConduct:      (document.getElementById('tenancy_conduct')||{}).value || 'no_history',
    incomeStability:     (document.getElementById('income_stability')||{}).value || 'stable',
    arrearsStatus:       arrStatus,
    edAdjustment:        (document.getElementById('edAdjustment')||{}).value || '0',
    deceased:            !!(document.getElementById('deceased_flag')||{}).checked
  };

  // Store for rubric display labels
  window._v2AppData = appData;

  try {
    var result = scoreApplicationLocally(appData);

    // Tier already derived by scoreApplicationLocally via the shared tierFor()
    // (ED-adjustable liveV2Tiers) — no separate re-derivation here.
    var _score = result.score;
    var _tier  = result.tier;

    window._lastScoreResult    = result;
    window._lastScoreBreakdown = result.breakdown;

    // Update display elements
    var scoreEl = document.getElementById('sc_score_total');
    var scoreShadow = document.getElementById('totalScore');
    var tierEl  = document.getElementById('sc_score_tier');
    var tierShadow = document.getElementById('priorityTier');
    var barEl   = document.getElementById('sc_score_bar') || document.getElementById('scoreBarFill');

    if (scoreEl)  scoreEl.textContent  = _score;
    if (scoreShadow) scoreShadow.textContent = _score;
    if (tierEl) {
      tierEl.textContent = _tier;
      var tc = tierColorDark(_tier);
      tierEl.style.background = tc.bg;
      tierEl.style.color      = tc.col;
    }
    if (tierShadow) tierShadow.textContent = _tier;
    if (barEl) barEl.style.width = Math.min(100, Math.round(_score)) + '%';

    // Update rubric display
    renderRubricTableV2(result.breakdown);

    // Store for save chain
    window._appScore = { total: _score, tier: _tier, breakdown: result.breakdown };

    // Auto-save V2 fields to Supabase whenever score changes
    if (window.currentAppId) {
      var v2Patch = {
        score: _score, tier: _tier, score_v2: _score, tier_v2: _tier,
        score_breakdown_v2: result.breakdown,
        urgent_need: appData.urgentNeed,
        health_risk: appData.healthRisk,
        persons_over_standard: parseInt(appData.personsOverStandard) || 0,
        lone_parent: appData.loneParent,
        elder_in_household: appData.elderInHousehold,
        household_disability: appData.householdDisability,
        income_stability: appData.incomeStability,
        rent_payment_history: appData.rentPaymentHistory,
        unit_condition: appData.unitCondition,
        tenancy_conduct: appData.tenancyConduct,
        no_prior_tenancy: appData.noPriorTenancy,
        arrears_status: appData.arrearsStatus
      };
      fetch(SUPABASE_URL + '/rest/v1/housing_applications?id=eq.' + encodeURIComponent(window.currentAppId), {
        method: 'PATCH',
        headers: Object.assign({}, HOUSING_HEADERS, { 'Prefer': 'return=minimal' }),
        body: JSON.stringify(v2Patch)
      }).catch(function(e) { console.warn('[V2 autosave] failed:', e); });
    }

  } catch(err) {
    console.warn('[V2 Score] calculation failed:', err.message);
  }
}

// ── autoPopulateScore ──
function autoPopulateScore(){
  // Reserve
  const reserveVal=g('reserve')==='Off Reserve'?'off':'on';
  const reserveEl=document.getElementById('sc_reserve');if(reserveEl)reserveEl.value=reserveVal;

  // Band
  let bandCount=0;
  if(g('band'))bandCount++;
  if(g('co_band'))bandCount++;
  document.querySelectorAll('#habList .rrow').forEach(function(row){
    var inputs=row.querySelectorAll('input[type="number"]');
    if(inputs.length>0&&inputs[0].value)bandCount++;
  });
  const scBand=document.getElementById('sc_band_count');if(scBand)scBand.value=bandCount;
  const bdDet=document.getElementById('sc_band_detail');
  if(bdDet)bdDet.textContent=bandCount>0?bandCount+' band member'+(bandCount!==1?'s':'')+' — +'+bandCount+' pt'+(bandCount!==1?'s':''):'No band members';

  // Income
  const incomeRows=document.querySelectorAll('#incomeList .rrow');
  let primaryType='';
  incomeRows.forEach(function(row){
    var sels=row.querySelectorAll('select');
    if(sels[0]&&sels[1]&&sels[0].value==='Applicant'&&!primaryType)primaryType=sels[1].value;
  });
  var incomeScore=0;
  if(['Employment','Employed','Self-Employment'].includes(primaryType)) incomeScore=livePoints('employed');
  else if(primaryType==='Pension'||primaryType==='CPP')                 incomeScore=livePoints('pension');
  else                                                                   incomeScore=livePoints('social');
  const scIncome=document.getElementById('sc_income');if(scIncome)scIncome.value=incomeScore;

  // Relation
  const marital=g('marital');
  const relScore=['Divorced','Separated'].includes(marital)?livePoints('div_sep'):livePoints('other');
  const scRel=document.getElementById('sc_rel');if(scRel)scRel.value=relScore;

  // Ages
  function calcAgeScore(dob){
    if(!dob)return 0;
    const age=(new Date()-new Date(dob))/(365.25*24*3600*1000);
    return liveAgePoints(age);
  }
  function ageLabel(dob){
    if(!dob)return'?';
    return Math.floor((new Date()-new Date(dob))/(365.25*24*3600*1000))+' yrs';
  }
  const people=[];
  const appDob=g('dob');if(appDob)people.push({label:'Applicant ('+ageLabel(appDob)+')',dob:appDob});
  const coDob=g('co_dob');if(coDob)people.push({label:'Co-Applicant ('+ageLabel(coDob)+')',dob:coDob});
  document.querySelectorAll('#habList .rrow').forEach(function(row,i){
    var inputs=row.querySelectorAll('input[type="date"]');
    const fn=row.querySelector('input[type="text"]');
    if(inputs.length>0&&inputs[0].value)
      people.push({label:(fn?fn.value||'Member '+(i+1):'Member '+(i+1))+' ('+ageLabel(inputs[0].value)+')',dob:inputs[0].value});
  });
  const breakdown=document.getElementById('sc_age_breakdown');
  const emptyMsg=document.getElementById('sc_age_empty');
  const scAge=document.getElementById('sc_age');
  if(people.length>0){
    if(emptyMsg)emptyMsg.style.display='none';
    if(breakdown)breakdown.innerHTML=people.map(function(p){
      var pts=calcAgeScore(p.dob);
      const col=pts>=3?'var(--success)':pts>=2?'#1e3a5f':'#7a6000';
      return '<div style="display:flex;align-items:center;justify-content:space-between;padding:6px 10px;background:var(--bg);border-radius:6px;font-size:12px;">'
        +'<span class="js-lbl-xs">'+p.label+'</span>'
        +'<span style="font-weight:700;color:'+col+';">+'+pts+' pts</span></div>';
    }).join('');
    if(scAge)scAge.value=people.reduce(function(s,p){return s+calcAgeScore(p.dob);},0);
  }else{
    if(emptyMsg)emptyMsg.style.display='block';
    if(breakdown)breakdown.innerHTML='';
    if(scAge)scAge.value=0;
  }

  // Accessibility
  const accessVal=g('accessibility');
  const hasAccess=accessVal&&accessVal!==''&&accessVal!=='None';
  const scAccess=document.getElementById('sc_access');if(scAccess)scAccess.checked=hasAccess;

  // Move-In
  const occDate=g('occDate');
  let moveInScore=0;
  if(occDate){
    const yrs=(new Date(occDate)-new Date())/(365.25*24*3600*1000);
    if(yrs<=1)      moveInScore=livePoints('within_1yr');
    else if(yrs<=3) moveInScore=livePoints('1_to_3yr');
    else            moveInScore=livePoints('3_plus_yr');
  }
  const scMoveIn=document.getElementById('sc_movein');if(scMoveIn)scMoveIn.value=moveInScore;

  // Home Condition
  const hasHouse=document.getElementById('hasHouseToggle')?document.getElementById('hasHouseToggle').checked:false;
  const homeCond=g('homeCondition');
  let homeCondScore=0;
  if(hasHouse&&homeCond){
    const hcMap={Good:livePoints('good'),Average:livePoints('average'),Poor:livePoints('poor')};
    homeCondScore=hcMap[homeCond]||0;
  }
  const scHomeCond=document.getElementById('sc_homecond');if(scHomeCond)scHomeCond.value=homeCondScore;

  // Renos
  const renosCost=(function(){var v=(g('renosCost')||'').replace(/[^0-9]/g,'');return parseInt(v)||0;})();
  const scRenos=document.getElementById('sc_renos');if(scRenos)scRenos.value=renosCost;

  // Arrears
  const hasArrears=document.getElementById('arrToggle')?document.getElementById('arrToggle').checked:false;
  var _arrEl=document.getElementById('arrBalAmt');
  var _arrRaw=_arrEl?(_arrEl.value||'').replace(/[^0-9]/g,''):'0';
  const arrealAmt=hasArrears?(parseInt(_arrRaw)||0):0;
  const scArrears=document.getElementById('sc_arrears');if(scArrears)scArrears.value=arrealAmt;

  // Payment
  const payDur=parseFloat(g('arrPlanMonths')||'0')||0;
  const scPayment=document.getElementById('sc_payment');if(scPayment)scPayment.value=payDur;

  // Occupants (calculated)
  const habCount=document.querySelectorAll('#habList .rrow').length;
  const coCount=(g('co_status')==='yes')?1:0;
  const totalPeople=1+coCount+habCount;
  const occCo=document.getElementById('occ_coapplicant');if(occCo)occCo.textContent=coCount;
  const occMem=document.getElementById('occ_members');if(occMem)occMem.textContent=habCount;
  const occTot=document.getElementById('occ_total');if(occTot)occTot.textContent=totalPeople;
  const scSize=document.getElementById('sc_size');if(scSize)scSize.value=Math.min(7,Math.max(1,totalPeople));

  // Waitlist
  const appDateVal=g('appDate');
  const scAppdateEl=document.getElementById('sc_appdate');if(scAppdateEl&&appDateVal)scAppdateEl.value=appDateVal;

  // Store rubric data
  window._rubricData={
    waitlist:0,waitlist_label:'',
    reserve:reserveVal==='off'?1:0,reserve_label:g('reserve')||'Not specified',
    band:bandCount,income:incomeScore,income_label:primaryType||'No income record',
    relation:relScore,relation_label:marital||'Not specified',
    ages:people.reduce(function(s,p){return s+calcAgeScore(p.dob);},0),age_people:[],
    access:hasAccess?1:0,access_label:hasAccess?accessVal:'None',
    moveIn:moveInScore,movein_label:'',homeCond:homeCondScore,homecond_label:'',
    renos:0,renos_amt:renosCost,arrears:0,arrears_amt:arrealAmt,payment:0,payment_months:payDur,
  };

  triggerV2Score();
}

// ── calcScore ──
function calcScore(){
  // Local helpers — read form field values by id
  function fv(id){ var e=document.getElementById(id); return e ? e.value.trim() : ''; }
  function fb(id){ var e=document.getElementById(id); return e ? e.checked : false; }
  // If this is a file update for an existing tenant, don't score
  if(typeof getAppType === 'function' && getAppType() === 'existing_tenant') {
    var sc = document.getElementById('sc_score_total');
    if(sc) sc.textContent = 'N/A';
    var tierEl = document.getElementById('sc_score_tier');
    if(tierEl){ tierEl.textContent = 'File Update Only'; tierEl.style.color='var(--gray)'; tierEl.style.background='var(--dark3)'; }
    return;
  }
  let total=0;
  const reserveScore=fv('sc_reserve')==='off'?livePoints('off_reserve'):livePoints('on_reserve');
  setPts('sc_reserve_pts',reserveScore);total+=reserveScore;
  const bandCount=parseInt(fv('sc_band_count')||'0')||0;
  const bandPts=bandCount*livePerMemberPoints('band_membership');
  setPts('sc_band_pts',bandPts);total+=bandPts;
  const incomeVal=parseInt(fv('sc_income')||'0')||0;
  setPts('sc_income_pts',incomeVal);total+=incomeVal;
  const relVal=parseInt(fv('sc_rel')||'0')||0;
  setPts('sc_rel_pts',relVal);total+=relVal;
  const allPeopleRows=document.querySelectorAll('#sc_age_breakdown > div');
  let allAgesTotal=0;
  allPeopleRows.forEach(function(row){
    var badge=row.querySelector('span:last-child');
    if(badge)allAgesTotal+=parseInt((badge.textContent||'').replace(/[^\-0-9]/g,''))||0;
  });
  if(allPeopleRows.length===0)allAgesTotal=parseInt(fv('sc_age')||'0')||0;
  setPts('sc_child_pts',allAgesTotal);total+=allAgesTotal;
  setPts('sc_age_pts',0);
  const accessScore=fb('sc_access')?livePoints('has_needs'):livePoints('none');
  setPts('sc_access_pts',accessScore);total+=accessScore;
  const moveInVal=parseInt(fv('sc_movein')||'0')||0;
  setPts('sc_movein_pts',moveInVal);total+=moveInVal;
  const homeCondVal=parseInt(fv('sc_homecond')||'0')||0;
  setPts('sc_homecond_pts',homeCondVal);total+=homeCondVal;
  const renosAmt=parseFloat(fv('sc_renos')||'0')||0;
  const renosScore=liveRangeScore('renos_estimate',renosAmt);
  setPts('sc_renos_pts',renosScore);total+=renosScore;
  const arrearsAmt=parseFloat(fv('sc_arrears')||'0')||0;
  const arrearsScore=liveRangeScore('arrears',arrearsAmt);
  setPts('sc_arrears_pts',arrearsScore);total+=arrearsScore;
  const paymentMonths=parseFloat(fv('sc_payment')||'0')||0;
  let paymentScore=0;
  if(arrearsAmt>0&&paymentMonths>0)paymentScore=liveRangeScore('payment_arrangement',paymentMonths);
  setPts('sc_payment_pts',paymentScore);total+=paymentScore;

  // Waitlist
  let waitlistScore=0;
  const scAppDate=document.getElementById('sc_appdate');
  if(scAppDate&&scAppDate.value){
    const yearsWaiting=(new Date()-new Date(scAppDate.value))/(365.25*24*3600*1000);
    waitlistScore=Math.max(0,Math.floor(yearsWaiting))*livePerYearPoints();
  }
  setPts('sc_waitlist_pts',waitlistScore);total+=waitlistScore;

  // Household size (informational)
  const sizeVal=parseInt(fv('sc_size')||'1');
  const sizeInfo=SCORING_RUBRIC.housingSizes[sizeVal]||{};
  const bedroomRec=document.getElementById('sc_bedroom_rec');
  if(bedroomRec)bedroomRec.textContent=sizeInfo.bedrooms||'—';

  // ED Adjustment
  const edAdj=parseInt(document.getElementById('edAdjustment')?document.getElementById('edAdjustment').value||'0':'0')||0;
  const adjustedTotal=total+edAdj;
  // Tier from the ED-adjustable thresholds — this path hardcoded 80/60/40 and
  // could label the same score differently from the V2 path once the ED moved
  // a threshold.
  const adjustedTier=tierFor(adjustedTotal);

  const _ts=document.getElementById('totalScore');if(_ts)_ts.textContent=adjustedTotal;
  // Also sync primary display
  const _sct=document.getElementById('sc_score_total');if(_sct)_sct.textContent=adjustedTotal;
  const adjTierEl=document.getElementById('priorityTier');
  if(adjTierEl){
    adjTierEl.textContent=adjustedTier;
    var _tc = tierColorDark(adjustedTier);
    adjTierEl.style.background = _tc.bg;
    adjTierEl.style.color      = _tc.col;
  }
  const adjBar=document.getElementById('scoreBarFill');
  if(adjBar)adjBar.style.width=Math.min(100,Math.round(adjustedTotal))+'%';
  // Update rubric data
  if(window._rubricData){
    window._rubricData.renos=renosScore;
    window._rubricData.arrears=arrearsScore;
    window._rubricData.payment=paymentScore;
    window._rubricData.waitlist=waitlistScore;
    renderRubricTable(window._rubricData);
  }

  window._appScore={
    total:adjustedTotal,rubricTotal:total,edAdjustment:edAdj,
    edAdjustReason:document.getElementById('edAdjustReason')?document.getElementById('edAdjustReason').value||'':'',
    edNotes:document.getElementById('edNotes')?document.getElementById('edNotes').value||'':'',
    tier:adjustedTier,
    breakdown:{
      waitlist:waitlistScore,reserve:reserveScore,band:bandCount,income:incomeVal,
      relation:relVal,ages:allAgesTotal,access:accessScore,moveIn:moveInVal,
      homeCond:homeCondVal,renos:renosScore,arrears:arrearsScore,payment:paymentScore,
      edAdjustment:edAdj,edAdjustReason:document.getElementById('edAdjustReason')?document.getElementById('edAdjustReason').value||'':'',
    }
  };
}

// ── renderRubricTable (V1 — kept for compatibility) ──
function renderRubricTable(scores, targetEl) {
  // V2 scoring is now handled by renderRubricTableV2
  // This stub is kept so any legacy calls don't error
  if (window._lastScoreResult) {
    renderRubricTableV2(window._lastScoreResult.breakdown, targetEl);
  }
}

// ── renderRubricTableV2 — V2 scoring model display ──
function renderRubricTableV2(breakdown, targetEl) {
  var el = targetEl || document.getElementById('sc_rubric_rows');
  if (!el || !breakdown) return;
  var sA = breakdown.sectionA || {};
  var sB = breakdown.sectionB || {};
  var arrDed = breakdown.arrears || 0;
  var edAdj  = breakdown.edAdjustment || 0;

  function sectionHeader(label, total, maxPts) {
    var pct = maxPts > 0 ? Math.round((total / maxPts) * 100) : 0;
    return '<div style="padding:10px 18px;background:var(--dark2);border-bottom:2px solid var(--yellow);display:flex;align-items:center;justify-content:space-between;">'
      + '<div style="font-size:11px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:var(--muted);">' + label + '</div>'
      + '<div style="font-size:13px;font-weight:700;color:var(--yellow);">' + total + ' <span style="font-size:10px;color:var(--muted);">/ ' + maxPts + ' pts</span></div>'
      + '</div>';
  }

  function row(label, pts, maxPts, value, note) {
    var pos  = pts > 0;
    var neg  = pts < 0;
    var col  = pos ? 'var(--success)' : neg ? 'var(--danger)' : 'var(--gray)';
    var bg   = pos ? 'rgba(21,128,61,0.15)' : neg ? 'rgba(185,28,28,0.15)' : 'var(--bg)';
    var sign = pts > 0 ? '+' : '';
    var pct  = maxPts > 0 ? Math.round(Math.abs(pts) / maxPts * 100) : 0;
    return '<div style="padding:12px 18px;border-bottom:1px solid var(--border);">'
      + '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;">'
      +   '<div>'
      +     '<div class="js-txt-bold">' + label + '</div>'
      +     (value ? '<div class="js-lbl-sm" class="mt-4">→ ' + value + '</div>' : '')
      +     (note  ? '<div style="font-size:10px;color:var(--muted);margin-top:4px;font-style:italic;">' + note + '</div>' : '')
      +   '</div>'
      +   '<div style="flex-shrink:0;text-align:right;">'
      +     '<span style="display:inline-block;min-width:46px;text-align:center;font-size:18px;font-weight:700;padding:4px 10px;border-radius:7px;background:' + bg + ';color:' + col + ';">' + sign + pts + '</span>'
      +     (maxPts ? '<div style="font-size:10px;color:var(--muted);margin-top:2px;">max ' + maxPts + '</div>' : '')
      +   '</div>'
      + '</div>'
      + '</div>';
  }

  var urgentLabels = {
    homeless:'Homeless / no fixed address',
    domestic_violence:'Domestic violence (verified)', fire_disaster:'Fire / disaster (verified)',
    homeless_eviction:'Homelessness / eviction', eviction_risk:'Eviction risk from landlord',
    separation:'Separation / divorce', none:'No urgent need'
  };
  var healthLabels  = { severe:'Severe / imminent risk', moderate:'Moderate risk', minor:'Minor risk', none:'None' };
  var rentLabels    = { excellent:'Consistently on time 12+ months', mostly:'Mostly on time',
                        occasional:'Occasionally late', frequent:'Frequently late', no_history:'No prior tenancy (neutral)' };
  var condLabels    = { excellent:'Excellent — no damage', good:'Good', fair:'Fair',
                        damage:'Damage noted', no_history:'No prior tenancy (neutral)' };
  var conductLabels = { clean:'No complaints / violations 2 yrs', minor:'Minor complaints, resolved',
                        unresolved:'Ongoing unresolved complaints', no_history:'No prior tenancy (neutral)' };
  var incLabels     = { stable:'Stable income', irregular:'Irregular income', none:'No income' };
  var arrLabels     = { none:'No arrears', cleared:'Arrears cleared', repayment:'Active repayment plan', no_repayment:'Arrears, no repayment plan' };

  var urgentKey = (window._lastScoreResult && window._lastScoreResult.breakdown) ? '' : '';
  var html = '';

  // Section A
  html += sectionHeader('Section A — Housing Need', sA.total || 0, 70);
  html += row('Urgent Need / Displacement', sA.urgent || 0, 20, urgentLabels[(window._v2AppData||{}).urgentNeed || 'none'], 'Documentation required for points above 0');
  html += row('Health & Safety Risk', sA.health || 0, 15, healthLabels[(window._v2AppData||{}).healthRisk || 'none'], 'Verified by inspection or public health order');
  html += row('Overcrowding', sA.overcrowding || 0, 10, ((sA.overcrowding||0) + ' person' + (sA.overcrowding!==1?'s':'')+' over standard'), '1 pt per person over national occupancy standard');
  html += row('Household Composition', sA.household || 0, 10, '', 'Dependents under 18 (1 pt each, max 5) · Elder +3 · Lone parent +3 · Disability +2');
  html += row('Accessibility / Medical Need', sA.accessibility || 0, 10, '', 'Verified medical documentation required');
  html += row('Waitlist Time', sA.waitlist || 0, 5, (sA.waitlist||0) + ' year' + (sA.waitlist!==1?'s':'') + ' on waitlist', '1 pt per full year, maximum 5 pts');

  // Section B
  html += sectionHeader('Section B — Tenant Responsibility', sB.total || 0, 30);
  html += row('Rent Payment History', sB.rent || 0, 10, rentLabels[(window._v2AppData||{}).rentPaymentHistory || 'no_history'], 'Neutral baseline 6 pts for new applicants');
  html += row('Unit Condition / No Damage', sB.condition || 0, 10, condLabels[(window._v2AppData||{}).unitCondition || 'no_history'], 'Neutral baseline 7 pts for new applicants');
  html += row('Tenancy Conduct', sB.conduct || 0, 5, conductLabels[(window._v2AppData||{}).tenancyConduct || 'no_history'], 'Neutral baseline 4 pts for new applicants');
  html += row('Income Stability', sB.income || 0, 5, incLabels[(window._v2AppData||{}).incomeStability || 'stable'], 'All stable sources treated equally');

  // Section C
  html += sectionHeader('Section C — Arrears', arrDed, 0);
  html += row('Arrears Status', arrDed, 10, arrLabels[(window._v2AppData||{}).arrearsStatus || 'none'], 'Active repayment plan: −5 · No plan: −10 · None or cleared: 0');

  // ED Adjustment
  if (edAdj !== 0) {
    html += sectionHeader('ED Adjustment', edAdj, 0);
    html += row('Executive Director Adjustment', edAdj, 20, '', 'Manual override by Executive Director');
  }

  // Score floor note
  html += '<div style="padding:10px 18px;font-size:11px;color:var(--muted);font-style:italic;border-top:1px solid var(--border);">Score floor: 0. Even with maximum arrears deduction, the reported score cannot go below zero.</div>';

  el.innerHTML = html;
}
function calcDuration(startInput) {
  var row      = startInput.closest('[data-grp]') || startInput.closest('.rrow');
  if(!row) return;
  var durInput = row.querySelector('[data-role="duration"]');
  if(!durInput) return;

  var startVal = startInput.value;
  if(!startVal) { durInput.value = ''; return; }

  var start = new Date(startVal);
  var today = new Date();

  if(isNaN(start.getTime()) || start > today) { durInput.value = ''; return; }

  var years  = today.getFullYear() - start.getFullYear();
  var months = today.getMonth()    - start.getMonth();

  if(months < 0) { years--; months += 12; }

  var parts = [];
  if(years  > 0) parts.push(years  + ' yr'  + (years  !== 1 ? 's' : ''));
  if(months > 0) parts.push(months + ' mo'  + (months !== 1 ? 's' : ''));
  if(!parts.length) parts.push('< 1 month');

  durInput.value = parts.join(' ');
}


// ── Housing Unit Inventory ──
// The canonical array is window.housingUnits (initialized at the top of this
// file). A top-level `let housingUnits` used to live here — global `let`
// SHADOWS the window property for every bare-identifier reference in every
// later script, so the app's core data split into two divergent copies: the
// data loaders assigned the lexical binding while window.* readers (AI
// context, Rescore All, the approval-gate sweep, portal merge, TIC cache
// sync) saw a permanently empty array. Same story for `let applications` /
// `let dashView` further down. Never re-add top-level let/const for shared
// globals — use `var` (which IS the window property) or window.* explicitly.
// (The legacy `const HOUSING_UNITS_DATA=[]` was deleted with it — as a const
// it never created window.HOUSING_UNITS_DATA, so the `window.HOUSING_UNITS_DATA
// || []` fallbacks elsewhere already ran on undefined and keep working.)

// ── Audit Log ──
var auditLog=[];


// ══════════════════════════════════════════════════════════════
// ARCHIVE SYSTEM
// ══════════════════════════════════════════════════════════════

// Collect all unit-linked documents into one bundle object
// (_bundleUnitDocs removed — its data source was long gone, so it always
//  returned {} while the audit text claimed documents were "bundled/preserved".
//  Documents already survive archival in Storage + housing_audit_log.)

// Archive an APPLICATION — bundles any linked unit documents before archiving
function archiveApplication(appId) {
  var idx = applications.findIndex(function(a){ return a.id === appId; });
  if(idx === -1) { showToast('Application not found', {type:'error'}); return; }
  var role = window.currentRole || 'staff';
  var app  = applications[idx];
  var linkedUnitId = app.assignedUnit || app.assignedUnitId || null;
  if(linkedUnitId) {
  }
  app.archived   = true;
  app.archivedAt = new Date().toISOString().split('T')[0];
  app.archivedBy = role;
  if(typeof saveApplicationWithDraftFallback === 'function') saveApplicationWithDraftFallback(app);
  else sbSaveApplication(app).catch(function(e){ console.warn('Archive save failed:',e); });
  auditEntry(appId, 'archived',
    'Application archived',
    role);
  _refreshAppViews();
  showToast('Application and supporting documents archived', {type:'info'});
}

// Archive a UNIT (demolition) — bundles all docs, marks archived, auto-archives linked apps
// Removing a building leaves an empty lot. If the unit was built on a tracked
// lot, free that lot back to vacant; otherwise create a new vacant-lot record at
// the unit's address (record_type:'lot'). Links u.lotId for a possible restore.
function _unitToVacantLot(u, role){
  if(!u) return;
  var units = getAllUnits();
  if(u.lotId){
    var lot = units.find(function(x){ return String(x.id)===String(u.lotId); });
    if(lot){
      lot.builtUnitId = null; lot.status = 'vacant_lot';
      saveUnitWithDraftFallback(lot);
      if(typeof auditEntry==='function') auditEntry('UNIT:'+lot.id, 'lot_vacated', 'Lot freed - building '+((u.num||'')+' '+(u.street||'')).trim()+' removed', role);
      return;
    }
  }
  var lotNum = u.num || '', street = u.street || '';
  if(!street) return;
  var newId = ('LOT-'+street.toUpperCase().replace(/\s+/g,'-')+'-'+lotNum).replace(/[^A-Z0-9\-]/g,'');
  if(units.find(function(x){ return x.id===newId; })){ u.lotId = newId; return; }
  var newLot = {
    id:newId, street:street, num:lotNum, lotNumber:lotNum,
    record_type:'lot', type:'Vacant Lot', status:'vacant_lot',
    notes:'Created when '+((u.num||'')+' '+(u.street||'')).trim()+' was removed.', builtUnitId:null,
    bedrooms:null, bathrooms:null, assignedTo:null, assignedName:null, assignedDate:null
  };
  if(typeof housingUnits!=='undefined') housingUnits.push(newLot);
  saveUnitWithDraftFallback(newLot);
  u.lotId = newId;
  if(typeof auditEntry==='function') auditEntry('UNIT:'+newId, 'lot_added', 'Vacant lot created when '+((u.num||'')+' '+(u.street||'')).trim()+' was removed', role);
}
// Restoring a demolished unit re-occupies its lot (if still vacant).
function _unitRestoreLot(u, role){
  if(!u || !u.lotId) return;
  var lot = getAllUnits().find(function(x){ return String(x.id)===String(u.lotId) && (typeof _isLot!=='function' || _isLot(x)); });
  if(lot && !lot.builtUnitId){
    lot.builtUnitId = u.id; lot.status = 'built';
    saveUnitWithDraftFallback(lot);
    if(typeof auditEntry==='function') auditEntry('UNIT:'+lot.id, 'lot_rebuilt', 'Lot re-linked - '+((u.num||'')+' '+(u.street||'')).trim()+' restored', role);
  }
}
function archiveUnit(unitId) {
  var units = getAllUnits();
  var u = units.find(function(x){ return x.id === unitId; });
  if(!u) { showToast('Unit not found', {type:'error'}); return; }
  var role = window.currentRole || 'staff';
  var addr = u.num + ' ' + u.street;
  showConfirm({
    title:       'Archive ' + addr + '?',
    message:     'This marks the unit as demolished and creates a vacant lot in its place. All documentation (Maintenance Requests, renovation progress, tenant files, photos) is preserved in the archive record. The unit is hidden from active inventory.',
    confirmText: 'Archive Unit',
    danger:      true
  }).then(function(ok){
    if (!ok) return;
    u.unitArchive = {
      archivedAt: new Date().toISOString(),
      archivedBy: role,
      reason: 'Demolished / Removed from active inventory',
      docs: {}
    };
    u.archived   = true;
    u.archivedAt = new Date().toISOString().split('T')[0];
    u.archivedBy = role;
    u.status     = APP_STATUS.ARCHIVED;
    applications.forEach(function(a, ai) {
      if((a.assignedUnit === unitId || a.assignedUnitId === unitId) && !a.archived) {
        applications[ai].archived       = true;
        applications[ai].archivedAt     = u.archivedAt;
        applications[ai].archivedBy     = role;
        applications[ai].archivedReason = 'Unit ' + addr + ' archived (demolished)';
        auditEntry(a.id, 'archived', 'Auto-archived — linked unit ' + addr + ' demolished', role);
      }
    });
    _unitToVacantLot(u, role);   // demolished building -> empty lot
    saveUnitWithDraftFallback(u);
    applications.forEach(function(a){
      if(a.archived && (a.assignedUnit===unitId||a.assignedUnitId===unitId)){
        if(typeof saveApplicationWithDraftFallback === 'function') saveApplicationWithDraftFallback(a);
        else sbSaveApplication(a).catch(function(e){ console.warn('Linked app archive save failed:',e); });
      }
    });
    auditEntry('UNIT:' + unitId, 'unit_archived',
      addr + ' archived (documents remain in Storage / the unit Documents tab)', role);
    closeUnitEditModal();
    renderInventoryView();
    if(typeof updateDashStats === 'function') updateDashStats();
    // Landing-page surfaces — refresh KPI strip (Vacant Units / Awaiting
    // Match), Worklist count (linked apps were auto-archived above), and
    // Recent Activity pill so the new unit_archived event lands without a
    // page reload. All gated — these are no-ops on inventory.html / etc.
    if(typeof _renderLandingKpis === 'function')        _renderLandingKpis();
    if(typeof _renderWorklistCountPills === 'function') _renderWorklistCountPills();
    if(typeof renderRecentActivity === 'function')      renderRecentActivity(role);
    var _wlSec = document.getElementById('sec-worklist');
    if(_wlSec && !_wlSec.classList.contains('collapsed') && typeof renderWorklist === 'function'){
      renderWorklist();
    }
    showToast('Unit archived — all documents preserved', {type:'info'});
  });
}

// Restore a UNIT from archive
function unarchiveUnit(unitId) {
  var units = getAllUnits();
  var u = units.find(function(x){ return x.id === unitId; });
  if(!u) { showToast('Unit not found', {type:'error'}); return; }
  var role = window.currentRole || 'staff';
  var addr = u.num + ' ' + u.street;
  showConfirm({
    title:       'Restore ' + addr + ' from archive?',
    message:     'The unit will return to active inventory with status Vacant. Archived documents remain attached to the unit record.',
    confirmText: 'Restore Unit'
  }).then(function(ok){
    if (!ok) return;
    u.archived   = false;
    u.archivedAt = null;
    u.archivedBy = null;
    u.status     = 'vacant';
    u.assignedTo = null; u.assignedName = null; u.assignedDate = null;
    _unitRestoreLot(u, role);   // re-occupy the lot the demolition freed
    saveUnitWithDraftFallback(u);
    auditEntry('UNIT:' + unitId, 'unit_unarchived', addr + ' restored from archive to Vacant', role);
    closeUnitEditModal();
    renderInventoryView();
    // Mirror archiveUnit: refresh landing surfaces so the restored unit
    // shows up in Vacant Units / Worklist / Recent Activity without a
    // page reload. Gated — no-ops where the landing globals aren't loaded.
    if(typeof _renderLandingKpis === 'function')        _renderLandingKpis();
    if(typeof _renderWorklistCountPills === 'function') _renderWorklistCountPills();
    if(typeof renderRecentActivity === 'function')      renderRecentActivity(role);
    var _wlSec = document.getElementById('sec-worklist');
    if(_wlSec && !_wlSec.classList.contains('collapsed') && typeof renderWorklist === 'function'){
      renderWorklist();
    }
    showToast(addr + ' restored to active inventory', {type:'info'});
  });
}


// (top-level `let applications` / `let dashView` deleted — see the shadowing
// note at the Housing Unit Inventory section above. window.applications is
// initialized at the top of this file; dashView had no remaining readers.)

// Load or init applications
// Applications loaded from Supabase on login (loadAppDataFromSupabase)
// Sample data is only used as fallback if Supabase is unavailable

// ── Score popup ──
// When a user clicks a score cell on the dashboard, route to the full V2 scorecard view
// (the legacy #scorePopup modal DOM was removed but the click handlers survived).
window._openScoreByEl=function(el){
  var id=el.getAttribute('data-score-id');
  window._openScoreById(id);
};
window._openScoreById=function(id){
  var app=null;
  for(var i=0;i<applications.length;i++){if(applications[i].id===id){app=applications[i];break;}}
  if(!app)return;
  if(true) showScorecard(app);
};

// ── Tier/score helpers ──
function scoreMiniBar(score) {
  var pct = Math.min(100, Math.max(0, Math.round((score || 0) / 100 * 100)));
  var color = score >= 80 ? 'var(--danger)' : score >= 60 ? '#1d4ed8' : score >= 40 ? '#7a6000' : 'var(--success)';
  return '<div style="height:3px;width:48px;background:var(--border);border-radius:2px;margin-top:3px;">'
       + '<div style="height:100%;width:'+pct+'%;background:'+color+';border-radius:2px;"></div></div>';
}

function tierColor(tier){
  if(tier==='Critical Priority')return{bg:'var(--success-bg)',c:'var(--success)'};
  if(tier==='High Priority')return{bg:'#e8eef5',c:'#1e3a5f'};
  if(tier==='Medium Priority')return{bg:'#fef9ec',c:'#7a6000'};
  return{bg:'var(--danger-bg)',c:'var(--danger)'};
}


// ── Unit matching + Reno priority models ──────────────────────────────────
// DEFAULT_UNIT_SCORE_MODEL, DEFAULT_RENO_SCORE_MODEL, RENO_FUND_RULES and
// CRITICAL_SOW_CATS now live in shared-config.js (the single file loaded on
// every page) — they used to be duplicated here and in renos.html. Do not
// re-declare them; reference the shared globals.
















// ── Calculate renovation priority score for a unit ──────────────────────────




// ── Render score badge in the progress modal ─────────────────────────────────


// ══ END RENOVATION SCORING ═══════════════════════════════════════════════════

// ══ RENOVATION BUDGET APPROVAL ═══════════════════════════════════════════════













// ══ END RENOVATION BUDGET APPROVAL ═══════════════════════════════════════════


// ── rescoreAllApplications ────────────────────────────────────────────────────
// Re-score every application in the global array using the current V2 model.
// Called after scoring model changes or on data load.
async function rescoreAllApplications() {
  if (!window.applications || !window.applications.length) return 0;
  // Recompute every score, then PERSIST the ones that changed. (An earlier
  // version only mutated the in-memory list — and rescoreAndSave's follow-up
  // reload from Supabase then overwrote the recomputed values with the old
  // stored ones, so "Rescore All" never actually stuck.)
  var changed = [];
  window.applications.forEach(function(app) {
    try {
      var result = scoreApplicationLocally(app);
      if (result && (app.score !== result.score || app.tier !== result.tier)) {
        app.score = result.score;
        app.tier  = result.tier;
        changed.push(app);
      }
    } catch(e) { /* skip individual failures silently */ }
  });
  // Save sequentially in small chunks — only the changed records, so a
  // routine rescore over a large backlog doesn't flood the API.
  for (var i = 0; i < changed.length; i += 5) {
    var batch = changed.slice(i, i + 5).map(function(a){
      return (typeof saveApplicationWithDraftFallback === 'function')
        ? saveApplicationWithDraftFallback(a)
        : (typeof sbSaveApplication === 'function' ? sbSaveApplication(a).catch(function(){}) : Promise.resolve());
    });
    await Promise.all(batch);
  }
  if (typeof auditEntry === 'function' && changed.length) {
    auditEntry('SETTINGS', 'applications_rescored',
      'Rescore All: ' + changed.length + ' of ' + window.applications.length + ' application scores changed and saved',
      window.currentRole || 'ed');
  }
  return changed.length;
}

// ── Default model initialisers ────────────────────────────────────────────────
// These are used only when Supabase settings haven't loaded yet.
// The real values come from housing_settings on login.
if (typeof DEFAULT_SCORING_MODEL === 'undefined') {
  window.DEFAULT_SCORING_MODEL = [];
}
// ── DEFAULT_V2_SCORE_MODEL — full default point values ────────────────────────
window.DEFAULT_V2_SCORE_MODEL = {
  urgent_need: {
    homeless: 25, domestic_violence: 25, fire_disaster: 25, temporary_shelter: 22,
    homeless_eviction: 20, eviction_risk: 15, separation: 10, none: 0
  },
  health_risk: {
    severe: 20, moderate: 12, minor: 6, none: 0
  },
  household: {
    per_dependent_u18: 2, max_dependents: 10, elder: 5,
    lone_parent: 5, disability: 5, max_total: 20
  },
  accessibility: {
    high: 10, moderate: 5, none: 0
  },
  rent_payment: {
    excellent: 10, mostly: 6, occasional: 2, frequent: -5, no_history: 0
  },
  unit_condition: {
    excellent: 5, good: 3, fair: 1, damage: -5, no_history: 0
  },
  tenancy_conduct: {
    clean: 5, minor: 2, unresolved: -10, no_history: 0
  },
  income_stability: {
    stable: 5, irregular: 2, none: 0
  },
  arrears: {
    none: 5, cleared: 3, repayment: 1, no_repayment: -10
  }
};

// Initialise liveV2ScoreModel from DEFAULT_V2_SCORE_MODEL if not yet set
if (!window.liveV2ScoreModel || !Object.keys(window.liveV2ScoreModel).length) {
  window.liveV2ScoreModel = JSON.parse(JSON.stringify(window.DEFAULT_V2_SCORE_MODEL));
}

// Initialise liveScoreModel from DEFAULT_SCORING_MODEL
if (!window.liveScoreModel && window.DEFAULT_SCORING_MODEL.length) {
  window.liveScoreModel = DEFAULT_SCORING_MODEL.map(function(r) {
    return Object.assign({}, r);
  });
}

// ── Built-in V1-format fallback for buildV2FormSelects ───────────────────────
// DEFAULT_SCORING_MODEL is intentionally empty (model comes from Supabase).
// If Supabase hasn't loaded the model yet (or was never saved), seed
// liveScoreModel so New Application form dropdowns always have labelled options.
if (!window.liveScoreModel || !window.liveScoreModel.length) {
  window.liveScoreModel = _v1RowsFromV2(window.DEFAULT_V2_SCORE_MODEL || {});
}

// Synthesize the V1-format row array (used by the New Application form
// dropdown labels) from a V2 model OBJECT. Shared by the boot fallback above
// and buildV2FormSelects, so the dropdowns reflect the ED's live edits.
function _v1RowsFromV2(_v2) {
  _v2 = _v2 || {};
  var _un = _v2.urgent_need || {};
  var _hr = _v2.health_risk || {};
  var _is = _v2.income_stability || {};
  return [
    {id:'un1', cat:'urgent_need',      label:'None',                        pts: _un.none              || 0},
    {id:'un2', cat:'urgent_need',      label:'Overcrowding',                pts: _un.eviction_risk     || 15},
    {id:'un3', cat:'urgent_need',      label:'Eviction / Homelessness Risk',pts: _un.homeless_eviction || 20},
    {id:'un4', cat:'urgent_need',      label:'Emergency (fire / DV)',       pts: _un.domestic_violence || 25},
    {id:'un5', cat:'urgent_need',      label:'Homeless / No Fixed Address', pts: _un.homeless          || 25},
    {id:'hs1', cat:'health_safety',    label:'None',                        pts: _hr.none              || 0},
    {id:'hs2', cat:'health_safety',    label:'Minor',                       pts: _hr.minor             || 6},
    {id:'hs3', cat:'health_safety',    label:'Moderate',                    pts: _hr.moderate          || 12},
    {id:'hs4', cat:'health_safety',    label:'Severe',                      pts: _hr.severe            || 20},
    {id:'is1', cat:'income_stability', label:'Stable income',               pts: _is.stable            || 5},
    {id:'is2', cat:'income_stability', label:'Unstable / irregular',        pts: _is.irregular         || 2},
    {id:'hc1', cat:'household_comp',   label:'Lone parent',                 pts: (_v2.household||{}).lone_parent        || 5},
    {id:'hc2', cat:'household_comp',   label:'Elder household',             pts: (_v2.household||{}).elder              || 5},
    {id:'hc3', cat:'household_comp',   label:'Disability',                  pts: (_v2.household||{}).disability         || 5},
    {id:'oc1', cat:'occupancy',        label:'Per person over NOS',         pts: (_v2.household||{}).per_dependent_u18  || 2},
  ];
}
window._v1RowsFromV2 = _v1RowsFromV2;

// ── Stubs for autoPopulateScore() ────────────────────────────────────────────
// `livePoints(key)` and `liveAgePoints(age)` are referenced inside
// autoPopulateScore() but were never defined. Without them, opening any
// application form throws a ReferenceError and aborts modal init.
// These stubs unblock the modal by looking the key up in liveScoreModel and
// returning 0 if no match. Replace with real V2 lookups when the scoring math
// is finalised.
if (typeof window.livePoints !== 'function') {
  window.livePoints = function(key) {
    var rows = window.liveScoreModel || [];
    for (var i = 0; i < rows.length; i++) {
      if (rows[i] && (rows[i].id === key || rows[i].key === key)) {
        return Number(rows[i].pts || rows[i].points || 0);
      }
    }
    return 0;
  };
}
if (typeof window.liveAgePoints !== 'function') {
  window.liveAgePoints = function(_age) { return 0; };
}
// livePerMemberPoints is referenced once at calcScore (band membership row)
// but was never defined. Same shape as livePoints — alias so opening any
// existing application for edit doesn't throw a ReferenceError mid-render.
if (typeof window.livePerMemberPoints !== 'function') {
  window.livePerMemberPoints = window.livePoints;
}
// liveRangeScore(key, amount) and livePerYearPoints() are also referenced by
// the legacy V1 calcScore path (renos / arrears / payment-plan / waitlist
// rows) without ever being defined. The V2 model owns the real scoring math
// now — these stubs just keep V1 from throwing during edit-modal hydration.
// Returning 0 is safe: V1 totals are no longer used for the persisted score,
// only V2 (driven by triggerV2Score) feeds app.score.
if (typeof window.liveRangeScore !== 'function') {
  window.liveRangeScore = function(_key, _amount) { return 0; };
}
if (typeof window.livePerYearPoints !== 'function') {
  window.livePerYearPoints = function() { return 0; };
}


// ════════════════════════════════════════════════════════════════════════
// Position Names editor (Settings -> Nation)
// ────────────────────────────────────────────────────────────────────────
// Renames the 7 canonical roles for THIS tenant. Stored in
// housing_settings.role_labels = { roleKey: 'Custom Label', ... }.
// Empty/missing entries fall through the 3-layer fallback in
// shared.js -> roleLabel() (DB → NATION_CONFIG → ROLE_LABELS).
// Cannot add or remove roles — only relabel them.
// ════════════════════════════════════════════════════════════════════════

// Canonical role keys in display order. Mirrored from CLFN_PERMS but
// pinned here so the editor's row order is stable regardless of how the
// underlying frozen registry is iterated.
var _POSITION_ROLE_KEYS = [
  'ed',
  'housing_manager',
  'housing_employee_l2',
  'housing_employee_l1',
  'cfo',
  'finance_l1',
  'super_user'
];

function _renderNationPositionsBlock(){
  var host = document.getElementById('nation_panel_positions');
  if (!host) return;
  var role   = window.currentRole || '';
  var canEdit = !!(window.APPROVAL_AUTHORITY && APPROVAL_AUTHORITY.can('editApprovalAuthority', role));

  var defaults = (window.CLFN_PERMS && CLFN_PERMS.ROLE_LABELS) || {};
  var saved    = (window._appSettings && window._appSettings.role_labels) || {};

  function _systemDefault(k) {
    // Defaults are the ROLE_LABELS frozen map — these are what falls
    // through when no override is set. NATION_CONFIG.role_labels
    // would also win above, but the canonical "system default" the
    // user sees in the placeholder is ROLE_LABELS.
    return defaults[k] || k;
  }

  var headerHtml =
      '<div class="cfg-section-title" style="margin-top:4px;">Position names</div>'
    + '<div class="cfg-section-sub">Customise how role titles appear throughout the app '
    +   '(badges, signatures, audit log, sign-in greeting, notifications). '
    +   'Leave blank to use the system default. Cannot add or remove roles here.</div>';

  if (!canEdit) {
    // Read-only — same row layout as the editable form, no inputs.
    var roRows = _POSITION_ROLE_KEYS.map(function(k){
      var sysDef = _systemDefault(k);
      var current = saved[k] || sysDef;
      var note    = (saved[k] && saved[k] !== sysDef) ? ('Default: ' + escapeHtml(sysDef)) : '';
      return '<div class="cfg-row">'
           +   '<div class="cfg-label">' + escapeHtml(k) + '</div>'
           +   '<div class="cfg-value"><span class="cfg-value-text">' + escapeHtml(current) + '</span>'
           +     (note ? ' <span class="cfg-value-note">(' + note + ')</span>' : '')
           +   '</div>'
           + '</div>';
    }).join('');
    host.innerHTML = headerHtml
                   + '<div class="cfg-grid" style="margin-top:10px;">' + roRows + '</div>'
                   + '<div class="js-lbl-sm" style="margin-top:8px;font-style:italic;">Position names are managed by the Executive Director.</div>';
    return;
  }

  // Editable — input per role, placeholder shows the system default.
  var inputStyle = 'width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px;font-family:DM Sans,sans-serif;box-sizing:border-box;background:var(--surface);color:var(--text);';

  var rowsHtml = _POSITION_ROLE_KEYS.map(function(k){
    var sysDef     = _systemDefault(k);
    var currentVal = (saved[k] && saved[k] !== sysDef) ? saved[k] : '';
    return '<div class="cfg-row">'
         +   '<div class="cfg-label">' + escapeHtml(k) + '</div>'
         +   '<div class="cfg-value">'
         +     '<input type="text" data-pos-key="' + escapeHtml(k) + '" '
         +           'value="' + escapeHtml(currentVal) + '" '
         +           'placeholder="' + escapeHtml(sysDef) + '" '
         +           'style="' + inputStyle + '"/>'
         +   '</div>'
         + '</div>';
  }).join('');

  host.innerHTML = headerHtml
    + '<div class="cfg-grid" style="margin-top:10px;">' + rowsHtml + '</div>'
    + '<div style="display:flex;gap:8px;margin-top:10px;align-items:center;flex-wrap:wrap;">'
    +   '<button type="button" class="btn btn-primary" onclick="saveNationPositionLabels()">Save Position Names</button>'
    +   '<button type="button" class="btn btn-ghost"   onclick="resetNationPositionLabels()">Reset all to defaults</button>'
    +   '<span class="js-lbl-sm">Empty inputs fall back to the system default.</span>'
    + '</div>';
}

// Read every input, persist non-empty overrides to housing_settings.role_labels.
// Empty inputs are written as nothing (key omitted) so roleLabel() falls back
// to the system default. Reuses the same PostgREST upsert pattern as the
// other settings (key+value row in housing_settings).
function saveNationPositionLabels(){
  if (typeof APPROVAL_AUTHORITY === 'undefined'
      || !APPROVAL_AUTHORITY.can('editApprovalAuthority', window.currentRole)) {
    showToast('Only the Executive Director can rename positions', {type:'error'});
    return;
  }
  var host = document.getElementById('nation_panel_positions');
  if (!host) return;
  var defaults = (window.CLFN_PERMS && CLFN_PERMS.ROLE_LABELS) || {};
  var next = {};
  host.querySelectorAll('input[data-pos-key]').forEach(function(inp){
    var key = inp.getAttribute('data-pos-key');
    var val = (inp.value || '').trim();
    // Only persist if it's a non-default override — keeps the saved map
    // small and self-describing.
    if (val && val !== defaults[key]) next[key] = val;
  });

  var changed = Object.keys(next).map(function(k){ return k + '=' + next[k]; }).join('; ');
  persistSetting('role_labels', next, {
    auditAction: 'role_labels_save',
    auditDetail: 'Position names updated: ' + (changed || '(all reset to defaults)'),
    okMsg:       'Position names saved',
    failMsg:     'Save failed - check connection',
    onSuccess:   function(){
      // Re-render the block so the placeholders + saved values stay in sync.
      _renderNationPositionsBlock();
      // Push the new labels through the header avatar + badge so the
      // rename is visible without a page reload. Other surfaces (settings
      // tabs, notifications panel) re-render when next opened.
      if (typeof updateHeaderUser === 'function') {
        updateHeaderUser(window._viewAsRole || window.currentRole || window._realRole);
      }
    }
  });
}

// Reset clears EVERY input in the block. User still has to click Save to
// persist the empty state - matches the pattern used by the notifications
// Reset to Default button.
function resetNationPositionLabels(){
  var host = document.getElementById('nation_panel_positions');
  if (!host) return;
  host.querySelectorAll('input[data-pos-key]').forEach(function(inp){
    inp.value = '';
  });
  showToast('Reverted to defaults. Click Save to persist.', {type:'info'});
}

