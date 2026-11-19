#!/usr/bin/env node
/* ============================================================================
 * check-nation-literals.js -- hardcoded nation-identity ratchet guard.
 *
 * This is a multi-tenant product that may be sold to other First Nations, so
 * nation identity must come from configuration, never from literals (the CLAUDE.md
 * "HARD RULE"). User-facing code should read NATION_CONFIG.display_name / .short,
 * the saved theme, and the data-nation / data-nation-template override hooks that
 * applyNationOverrides() rewrites at runtime -- not bare "CLFN" / "Constance Lake"
 * strings or clfn.on.ca addresses.
 *
 * Like the color guard, this counts UNPROTECTED nation-identity literals per
 * tracked file and compares to a committed baseline (tools/nation-literals-baseline.json):
 *   - a file's count going UP fails the check (a new hardcoded nation string landed),
 *   - a file's count going DOWN is fine (cleanup) and you should re-baseline.
 *
 * It deliberately does NOT count (these are legitimate, not violations):
 *   - shared-config.js            -- the nation registry IS the source of truth,
 *   - comments (// and block)     -- internal, not user-facing branding,
 *   - console.* dev logging        -- developer-facing, never shown to a nation,
 *   - any line carrying a data-nation / data-nation-template attribute -- the
 *     literal there is only the CLFN-default fallback; applyNationOverrides swaps it.
 *
 * What it DOES count is the real backlog: user-facing nation literals with no
 * config/override hook (placeholder example text, PDF/form generators, etc.).
 *
 * Usage:
 *   node tools/check-nation-literals.js            # check against baseline (exit 1 on regression)
 *   node tools/check-nation-literals.js --update   # regenerate the baseline from current counts
 *   node tools/check-nation-literals.js --list     # print every counted literal with file:line
 * ==========================================================================*/
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BASELINE = path.join(__dirname, 'nation-literals-baseline.json');

// shared-config.js is the nation registry (the source of truth); sw.js is the
// service worker (no UI). Both are excluded, same spirit as the color guard.
const EXCLUDE = new Set(['sw.js', 'shared-config.js']);
function trackedFiles() {
  return fs.readdirSync(ROOT)
    .filter(f => f.endsWith('.js') && !EXCLUDE.has(f))
    .filter(f => fs.statSync(path.join(ROOT, f)).isFile())
    .sort();
}

// The nation-identity literals we flag. Kept narrow + specific so it can't match
// the allowed CLFN_* identifier prefixes (CLFN_MODULES, CLFN_AUTH, ...).
const NATION_RE = /(?<![A-Za-z0-9_])CLFN(?!_)(?![A-Za-z0-9])|[Cc]onstance\s+[Ll]ake|clfn\.on\.ca|clfn\.fnhub|housing@clfn/g;

// Return the counted literals in a file as [{line, text}], after stripping the
// legitimate (non-violation) contexts. Line-based: a ratchet tolerates minor
// imprecision, and we bias toward UNDER-counting (stripping too much only lowers
// the backlog; it never invents a false regression).
function findLiterals(src) {
  // Drop block comments wholesale (/* ... */), replacing with blank lines so line
  // numbers stay accurate for --list.
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '));
  const out = [];
  const lines = noBlock.split('\n');
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    // Strip a line comment (// to end of line). Our nation tokens never contain
    // "//", so this can only remove potential matches, never add one.
    line = line.replace(/\/\/.*$/, '');
    if (!line.trim()) continue;
    if (/\bconsole\s*\./.test(line)) continue;            // dev logging
    if (/data-nation(-template)?\s*=/.test(line)) continue; // runtime-swapped by applyNationOverrides
    const m = line.match(NATION_RE);
    if (m) for (const hit of m) out.push({ line: i + 1, text: hit, src: lines[i].trim() });
  }
  return out;
}

function currentCounts() {
  const out = {};
  for (const f of trackedFiles()) out[f] = findLiterals(fs.readFileSync(path.join(ROOT, f), 'utf8')).length;
  return out;
}

const update = process.argv.includes('--update');
const list = process.argv.includes('--list');

if (list) {
  let total = 0;
  for (const f of trackedFiles()) {
    const hits = findLiterals(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    if (!hits.length) continue;
    console.log('\n' + f + ' (' + hits.length + '):');
    for (const h of hits) console.log('  ' + f + ':' + h.line + '  [' + h.text + ']  ' + h.src.slice(0, 110));
    total += hits.length;
  }
  console.log('\nTotal counted nation literals: ' + total);
  process.exit(0);
}

const counts = currentCounts();

if (update) {
  // Only keep files that actually have counted literals, to keep the baseline small.
  const nonzero = {};
  for (const f of Object.keys(counts)) if (counts[f] > 0) nonzero[f] = counts[f];
  fs.writeFileSync(BASELINE, JSON.stringify(nonzero, null, 2) + '\n');
  const total = Object.values(nonzero).reduce((a, b) => a + b, 0);
  console.log('Wrote nation-literals baseline: ' + Object.keys(nonzero).length + ' file(s), ' + total + ' literal(s).');
  process.exit(0);
}

let baseline = {};
try { baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8')); }
catch (e) { console.error('No baseline found. Run: node tools/check-nation-literals.js --update'); process.exit(2); }

const regressions = [];
for (const f of Object.keys(counts)) {
  const base = baseline[f] || 0;
  if (counts[f] > base) regressions.push(f + ': ' + base + ' -> ' + counts[f] + ' (+' + (counts[f] - base) + ' hardcoded nation literal(s))');
}

if (regressions.length) {
  console.error('Nation-literals guard FAILED — new hardcoded nation identity detected:\n');
  regressions.forEach(r => console.error('  ' + r));
  console.error('\nRead nation identity from NATION_CONFIG / a data-nation hook instead of a literal.');
  console.error('See it with:  node tools/check-nation-literals.js --list');
  console.error('If it is a genuine exception, re-baseline with:  node tools/check-nation-literals.js --update');
  process.exit(1);
}
const total = Object.values(counts).reduce((a, b) => a + b, 0);
console.log('Nation-literals guard passed (' + trackedFiles().length + ' files checked, ' + total + ' baselined literal(s)).');
