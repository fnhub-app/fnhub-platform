/* ============================================================================
 * admin/admin-pricing.js -- Home Land Homes price schedule (SINGLE SOURCE).
 *
 * Every price the control plane offers (invoice-builder catalog, recurring
 * billing picker, Schedule A of the subscription agreement) is read from this
 * file. Loaded by admin/index.html BEFORE admin.js; also require()-able from
 * Node so tests/pricing.test.js checks the real numbers.
 *
 * Published schedule effective 2026-10-09 (homelandhomes.ca), all CAD:
 *   - Band by RESIDENTIAL homes managed. Band offices, community buildings and
 *     commercial space do NOT count toward the band and cost nothing extra.
 *   - Monthly rate on annual billing = $300 + $1.60 x top of band.
 *   - Monthly billing = that rate x 1.10, rounded to the nearest $5.
 *   - Setup: one-time, fixed per group; paid up front OR spread across the
 *     first year's invoices at no extra cost (no interest or fee).
 *   - AI Staff Assistant add-on: optional, per month, by group.
 *   - Annual billing aligns to April-March fiscal years.
 *   - NO discounts of any kind.
 *
 * Price lock: changing this file never reprices an existing nation. Recurring
 * schedules (nation_billing.unit_amount) and invoices store their own amounts;
 * the catalog only prefills NEW lines. The new schedule applies to new
 * signings and renewals, which an operator sets up by hand.
 *
 * NOTE: never edit an existing `d` string -- saved nation_billing rows
 * re-select their catalog item by exact-description match (admin.js).
 * ========================================================================== */
(function (root) {
  'use strict';

  var EFFECTIVE_DATE = '2026-10-09';

  // Setup + AI add-on are priced per group; training sessions are the stated
  // setup scope (with data migration) for that group.
  var GROUPS = {
    small: { key: 'small', label: 'Small',    homes: '1-100',   setup: 3500, ai: 75,  training: 2 },
    mid:   { key: 'mid',   label: 'Mid-size', homes: '101-300', setup: 6000, ai: 95,  training: 4 },
    large: { key: 'large', label: 'Large',    homes: '301-600', setup: 9500, ai: 150, training: 6 }
  };

  // Published prices, written out exactly as they appear on homelandhomes.ca.
  // tests/pricing.test.js asserts each row equals the formula above, so a typo
  // here (or a formula change without a table change) fails the test.
  //   annual  = per year on annual billing (= 12 x monthly rate)
  //   rate    = monthly rate on annual billing
  //   monthly = monthly-billing price
  var BANDS = [
    { key: 'b50',  min: 1,   max: 50,  group: 'small', annual: 4560,  rate: 380,  monthly: 420  },
    { key: 'b100', min: 51,  max: 100, group: 'small', annual: 5520,  rate: 460,  monthly: 505  },
    { key: 'b150', min: 101, max: 150, group: 'mid',   annual: 6480,  rate: 540,  monthly: 595  },
    { key: 'b200', min: 151, max: 200, group: 'mid',   annual: 7440,  rate: 620,  monthly: 680  },
    { key: 'b250', min: 201, max: 250, group: 'mid',   annual: 8400,  rate: 700,  monthly: 770  },
    { key: 'b300', min: 251, max: 300, group: 'mid',   annual: 9360,  rate: 780,  monthly: 860  },
    { key: 'b400', min: 301, max: 400, group: 'large', annual: 11280, rate: 940,  monthly: 1035 },
    { key: 'b500', min: 401, max: 500, group: 'large', annual: 13200, rate: 1100, monthly: 1210 },
    { key: 'b600', min: 501, max: 600, group: 'large', annual: 15120, rate: 1260, monthly: 1385 }
  ];
  // 600+ / Tribal Council / group pricing: quoted, no published price.
  var XL = { key: 'xl', min: 601, max: null, group: 'custom', custom: true };

  // ---- Formula (documents + verifies the table) ---------------------------
  // Monthly rate on annual billing for a band whose top is `top` homes.
  // Integer math: tops are multiples of 50, so 1.60 x top is a whole dollar.
  function rateForTop(top){ return 300 + (top * 16) / 10; }
  // Monthly-billing price: rate x 1.10 rounded to the nearest $5 (half up).
  // rate*11 is an integer, so rate*1.10/5 = rate*11/50 with no float drift.
  function monthlyBillingFor(rate){ return Math.round((rate * 11) / 50) * 5; }

  // ---- Band selection -------------------------------------------------------
  // `residentialHomes` = residential homes managed ONLY (exclude band offices,
  // community buildings, commercial space). Returns the band row, XL for 601+,
  // or null for a missing / non-integer / < 1 count.
  function bandForHomes(residentialHomes){
    var n = Number(residentialHomes);
    if (!isFinite(n) || n < 1 || Math.floor(n) !== n) return null;
    for (var i = 0; i < BANDS.length; i++){ if (n <= BANDS[i].max) return BANDS[i]; }
    return XL;
  }
  function bandByKey(key){
    if (key === XL.key) return XL;
    for (var i = 0; i < BANDS.length; i++){ if (BANDS[i].key === key) return BANDS[i]; }
    return null;
  }

  // Split a group's setup fee across `count` invoices, cents-exact: every
  // instalment is round(total/count); the last absorbs the rounding remainder
  // so the sum equals the setup fee (no interest, no fee).
  function setupInstalments(groupKey, count){
    var g = GROUPS[groupKey]; var n = Math.floor(Number(count));
    if (!g || !(n >= 1)) return null;
    var totalC = g.setup * 100, eachC = Math.round(totalC / n), out = [];
    for (var i = 0; i < n - 1; i++) out.push(eachC / 100);
    out.push((totalC - eachC * (n - 1)) / 100);
    return out;
  }

  // ---- Display helpers ------------------------------------------------------
  function money(v){
    var s = String(Math.round(v)), out = '';
    while (s.length > 3){ out = ',' + s.slice(-3) + out; s = s.slice(0, -3); }
    return '$' + s + out;
  }
  function bandHomes(b){ return b.min + '-' + b.max + ' homes'; }

  // ---- Invoice / recurring-billing catalog ---------------------------------
  // g=group, d=line description, p=unit price (CAD), q=default qty;
  // hours=qty entered in hours; custom=price is free-entry.
  var G_ANNUAL  = 'Subscription — annual billing (per year, April–March fiscal year)';
  var G_MONTHLY = 'Subscription — monthly billing (annual rate +10%, nearest $5)';
  var G_SETUP   = 'One-time setup (fixed per group, paid up front)';
  var G_SPREAD  = 'One-time setup — spread over first year (no interest or fee; enter instalment)';
  var G_AI      = 'Add-on — AI Staff Assistant (optional, per month)';
  var G_LEGACY  = 'Legacy schedule (before 2026-10-09) — existing price-locked terms ONLY';

  function feeSchedule(){
    var items = [];
    BANDS.forEach(function(b){
      items.push({ g: G_ANNUAL, d: 'Subscription — ' + b.key + ' (' + bandHomes(b) + '), annual', p: b.annual, q: 1, band: b.key });
    });
    BANDS.forEach(function(b){
      items.push({ g: G_MONTHLY, d: 'Subscription — ' + b.key + ' (' + bandHomes(b) + '), monthly', p: b.monthly, q: 1, band: b.key });
    });
    ['small', 'mid', 'large'].forEach(function(k){
      var gr = GROUPS[k];
      items.push({ g: G_SETUP, d: 'One-time setup — ' + gr.label + ' group (' + gr.homes + ' homes)', p: gr.setup, q: 1 });
    });
    ['small', 'mid', 'large'].forEach(function(k){
      var gr = GROUPS[k];
      items.push({ g: G_SPREAD, d: 'One-time setup — ' + gr.label + ' group, instalment (of ' + money(gr.setup) + ' total)', p: 0, q: 1, custom: true });
    });
    ['small', 'mid', 'large'].forEach(function(k){
      var gr = GROUPS[k];
      items.push({ g: G_AI, d: 'AI Staff Assistant — ' + gr.label + ' group (per month)', p: gr.ai, q: 1 });
    });
    items.push(
      // Additional services (hourly; written authorization required)
      { g: 'Additional services (hourly, written authorization)', d: 'Consulting / data cleanup / training / custom reports (per hour, 0.25 incr.)', p: 150, q: 1, hours: true },
      { g: 'Additional services (hourly, written authorization)', d: 'Travel time (per hour, max 8 hrs/travel day)', p: 75, q: 1, hours: true },
      // Custom / at cost (free-entry amount)
      { g: 'Custom / at cost (enter amount)', d: 'Subscription — 600+ / Tribal Council (custom per quote)', p: 0, q: 1, custom: true },
      { g: 'Custom / at cost (enter amount)', d: 'Out-of-scope setup work (per separate written quote)', p: 0, q: 1, custom: true },
      { g: 'Custom / at cost (enter amount)', d: 'Travel expenses (at cost, NJC Travel Directive, no markup)', p: 0, q: 1, custom: true }
    );
    // Prior schedule, kept ONLY so nations still inside a term signed before
    // 2026-10-09 can be invoiced at their locked price (and so their saved
    // recurring schedules still match a catalog line). Never offer these to a
    // new signing or a renewal. The 50% setup discount is gone entirely.
    items.push(
      { g: G_LEGACY, d: 'Subscription — Small (up to 100 homes), annual', p: 5400, q: 1, legacy: true },
      { g: G_LEGACY, d: 'Subscription — Mid-size (101-300 homes), annual', p: 9540, q: 1, legacy: true },
      { g: G_LEGACY, d: 'Subscription — Large (301-600 homes), annual', p: 15000, q: 1, legacy: true },
      { g: G_LEGACY, d: 'Subscription — Small (up to 100 homes), monthly', p: 495, q: 1, legacy: true },
      { g: G_LEGACY, d: 'Subscription — Mid-size (101-300 homes), monthly', p: 875, q: 1, legacy: true },
      { g: G_LEGACY, d: 'Subscription — Large (301-600 homes), monthly', p: 1375, q: 1, legacy: true },
      { g: G_LEGACY, d: 'AI Staff Assistant (per month)', p: 95, q: 1, legacy: true }
    );
    return items;
  }

  // ---- Schedule A (agreement order form) price lines ----------------------
  // Marker-formatted like AGREEMENT_TPL in admin.js ('-' = bullet, '###' = clause).
  function scheduleALines(){
    var L = [];
    L.push('###Subscription band (residential homes managed)');
    L.push('Band offices, community buildings and commercial space do not count toward the band and are included at no extra cost.');
    BANDS.forEach(function(b){
      L.push('-[ ] ' + b.key + ' - ' + b.min + '-' + b.max + ' residential homes (' + GROUPS[b.group].label + ' group): '
        + money(b.annual) + '/year (' + money(b.rate) + '/mo) on annual billing, or ' + money(b.monthly) + '/month on monthly billing.');
    });
    L.push('-[ ] xl - 600+ residential homes / Tribal Council / group pricing: per written quote.');
    L.push('###One-time setup (fixed price for the stated scope - Schedule B)');
    ['small', 'mid', 'large'].forEach(function(k){
      var gr = GROUPS[k];
      L.push('-' + gr.label + ' group (' + gr.homes + ' homes): ' + money(gr.setup) + ' - data migration plus ' + gr.training + ' live training sessions.');
    });
    return L;
  }
  function aiAddonText(){
    return ['small', 'mid', 'large'].map(function(k){
      var gr = GROUPS[k]; return money(gr.ai) + '/month (' + gr.label + ' group)';
    }).join(', ');
  }

  var api = {
    EFFECTIVE_DATE: EFFECTIVE_DATE,
    GROUPS: GROUPS,
    BANDS: BANDS,
    XL: XL,
    rateForTop: rateForTop,
    monthlyBillingFor: monthlyBillingFor,
    bandForHomes: bandForHomes,
    bandByKey: bandByKey,
    setupInstalments: setupInstalments,
    money: money,
    feeSchedule: feeSchedule,
    scheduleALines: scheduleALines,
    aiAddonText: aiAddonText
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.HLH_PRICING = api;
})(typeof window !== 'undefined' ? window : null);
