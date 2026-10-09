/* ============================================================================
 * tests/pricing.test.js
 *
 * Dependency-free check of the Home Land Homes price schedule in
 * admin/admin-pricing.js (the single source of truth for control-plane prices):
 * band selection at every edge, the published table vs the formula, the
 * monthly-billing rounding, setup instalments, and "no discount" catalog rules.
 *
 *   Run from the repo root:  node tests/pricing.test.js
 *   Exit code 0 = all pass, 1 = a failure (CI-friendly).
 * ========================================================================== */
'use strict';
const path = require('path');
const P = require(path.join(__dirname, '..', 'admin', 'admin-pricing.js'));

// ── Tiny assert harness ─────────────────────────────────────────────────────
let pass = 0, fail = 0;
function ok(name, cond) { (cond ? pass++ : fail++); console.log((cond ? '  PASS  ' : '  FAIL  ') + name); }
function key(n) { const b = P.bandForHomes(n); return b ? b.key : null; }

// The schedule as published on homelandhomes.ca (2026-10-09), typed in
// independently of the source table so a typo in either one fails here.
const PUBLISHED = [
  // key     top  group    annual  /mo   monthly  setup  ai
  ['b50',    50, 'small',   4560,  380,   420,   3500,  75],
  ['b100',  100, 'small',   5520,  460,   505,   3500,  75],
  ['b150',  150, 'mid',     6480,  540,   595,   6000,  95],
  ['b200',  200, 'mid',     7440,  620,   680,   6000,  95],
  ['b250',  250, 'mid',     8400,  700,   770,   6000,  95],
  ['b300',  300, 'mid',     9360,  780,   860,   6000,  95],
  ['b400',  400, 'large',  11280,  940,  1035,   9500, 150],
  ['b500',  500, 'large',  13200, 1100,  1210,   9500, 150],
  ['b600',  600, 'large',  15120, 1260,  1385,   9500, 150]
];

console.log('\n=== 1. Band selection at every edge ===');
[
  [1, 'b50'], [50, 'b50'], [51, 'b100'], [100, 'b100'], [101, 'b150'],
  [150, 'b150'], [151, 'b200'], [200, 'b200'], [201, 'b250'], [250, 'b250'],
  [251, 'b300'], [300, 'b300'], [301, 'b400'], [400, 'b400'], [401, 'b500'],
  [500, 'b500'], [501, 'b600'], [600, 'b600'], [601, 'xl'], [5000, 'xl']
].forEach(function (c) { ok(c[0] + ' homes -> ' + c[1], key(c[0]) === c[1]); });
ok('0 homes -> null (no band)',        key(0) === null);
ok('negative -> null',                 key(-5) === null);
ok('fractional -> null',               key(50.5) === null);
ok('non-numeric -> null',              key('abc') === null);
ok('blank -> null',                    key('') === null && key(null) === null && key(undefined) === null);
ok('numeric string "101" -> b150',     key('101') === 'b150');
ok('xl is custom (no published price)', P.bandForHomes(601).custom === true && P.bandForHomes(601).annual === undefined);

console.log('\n=== 2. Source table == published schedule ===');
ok('9 published bands', P.BANDS.length === PUBLISHED.length);
PUBLISHED.forEach(function (r, i) {
  const b = P.BANDS[i] || {}, g = P.GROUPS[r[2]] || {};
  ok(r[0] + ' key/top/group',   b.key === r[0] && b.max === r[1] && b.group === r[2]);
  ok(r[0] + ' annual ' + r[3],  b.annual === r[3]);
  ok(r[0] + ' /mo ' + r[4],     b.rate === r[4]);
  ok(r[0] + ' monthly ' + r[5], b.monthly === r[5]);
  ok(r[0] + ' setup ' + r[6],   g.setup === r[6]);
  ok(r[0] + ' AI add-on ' + r[7], g.ai === r[7]);
});
ok('bands are contiguous from 1 to 600', P.BANDS.every(function (b, i) {
  return b.min === (i === 0 ? 1 : P.BANDS[i - 1].max + 1);
}) && P.BANDS[P.BANDS.length - 1].max === 600);
ok('training sessions 2/4/6', P.GROUPS.small.training === 2 && P.GROUPS.mid.training === 4 && P.GROUPS.large.training === 6);

console.log('\n=== 3. Formula: $300 + $1.60 x top; annual = 12 x rate ===');
P.BANDS.forEach(function (b) {
  ok(b.key + ' rate = 300 + 1.60 x ' + b.max, P.rateForTop(b.max) === b.rate);
  ok(b.key + ' annual = 12 x rate',            b.annual === b.rate * 12);
});

console.log('\n=== 4. Monthly billing = rate x 1.10, nearest $5 ===');
P.BANDS.forEach(function (b) {
  ok(b.key + ' ' + b.rate + ' x 1.10 -> ' + b.monthly, P.monthlyBillingFor(b.rate) === b.monthly);
});
// Rounding direction cases (raw value -> expected):
ok('380 -> 418.0 rounds up to 420',   P.monthlyBillingFor(380) === 420);
ok('460 -> 506.0 rounds down to 505', P.monthlyBillingFor(460) === 505);
ok('620 -> 682.0 rounds down to 680', P.monthlyBillingFor(620) === 680);
ok('940 -> 1034.0 rounds up to 1035', P.monthlyBillingFor(940) === 1035);
ok('1260 -> 1386.0 rounds down to 1385', P.monthlyBillingFor(1260) === 1385);
ok('exact tie 25 -> 27.5 rounds half up to 30', P.monthlyBillingFor(25) === 30);
ok('result always a multiple of $5', P.BANDS.every(function (b) { return b.monthly % 5 === 0; }));

console.log('\n=== 5. Setup spread across first year (no interest / fee) ===');
['small', 'mid', 'large'].forEach(function (g) {
  [1, 4, 12].forEach(function (n) {
    const parts = P.setupInstalments(g, n);
    const sumC = parts.reduce(function (s, x) { return s + Math.round(x * 100); }, 0);
    ok(g + ' x' + n + ' sums exactly to setup', parts.length === n && sumC === P.GROUPS[g].setup * 100);
  });
});
ok('small x12 = 291.67 x11 + 291.63', (function () {
  const p = P.setupInstalments('small', 12);
  return p.slice(0, 11).every(function (x) { return x === 291.67; }) && p[11] === 291.63;
})());
ok('unknown group / bad count -> null', P.setupInstalments('xl', 12) === null && P.setupInstalments('small', 0) === null);

console.log('\n=== 6. Catalog: no discounts; legacy kept for locked terms ===');
const cat = P.feeSchedule();
const current = cat.filter(function (it) { return !it.legacy; });
ok('no catalog line mentions a discount / prepay', !cat.some(function (it) { return /discount|prepa|coupon/i.test(it.g + ' ' + it.d); }));
ok('no 50% setup prices (1750/3000/4750) anywhere', !cat.some(function (it) { return [1750, 3000, 4750].indexOf(it.p) !== -1; }));
ok('every band has an annual + monthly line', P.BANDS.every(function (b) {
  return current.some(function (it) { return it.band === b.key && it.p === b.annual && /annual$/.test(it.d); })
      && current.some(function (it) { return it.band === b.key && it.p === b.monthly && /monthly$/.test(it.d); });
}));
ok('setup lines 3500 / 6000 / 9500', [3500, 6000, 9500].every(function (p) {
  return current.some(function (it) { return /^One-time setup/.test(it.d) && it.p === p; });
}));
ok('AI add-on lines 75 / 95 / 150', [75, 95, 150].every(function (p) {
  return current.some(function (it) { return /^AI Staff Assistant/.test(it.d) && it.p === p; });
}));
ok('600+ line is free-entry (custom)', current.some(function (it) { return /600\+/.test(it.d) && it.custom; }));
ok('catalog descriptions are unique', new Set(cat.map(function (it) { return it.d; })).size === cat.length);
ok('legacy lines keep their exact old descriptions (saved schedules re-match)', [
  'Subscription — Small (up to 100 homes), annual', 'Subscription — Mid-size (101-300 homes), monthly',
  'AI Staff Assistant (per month)'
].every(function (d) { return cat.some(function (it) { return it.legacy && it.d === d; }); }));
ok('legacy lines are grouped apart from current prices', cat.filter(function (it) { return it.legacy; })
  .every(function (it) { return /Legacy/.test(it.g); }));

console.log('\n=== 7. Schedule A text ===');
const sa = P.scheduleALines().join('\n');
ok('lists every band price', P.BANDS.every(function (b) {
  return sa.indexOf(P.money(b.annual)) !== -1 && sa.indexOf(P.money(b.monthly) + '/month') !== -1;
}));
ok('states non-residential buildings do not count', /do not count toward the band/.test(sa));
ok('no discount wording', !/discount|prepa/i.test(sa));
ok('money() formats thousands', P.money(15120) === '$15,120' && P.money(380) === '$380');

console.log('\n=== RESULTS: ' + pass + ' passed, ' + fail + ' failed ===');
process.exit(fail ? 1 : 0);
