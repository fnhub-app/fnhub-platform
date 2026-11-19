#!/usr/bin/env node
/* ============================================================================
 * check-lint.js -- ESLint ratchet guard.
 *
 * Runs ESLint (eslint.config.mjs -- a bug-focused, no-style rule set) over the
 * root UI JavaScript and compares the problem count per file to a committed
 * baseline (tools/lint-baseline.json):
 *   - a file's count going UP fails the check (a new lint problem slipped in),
 *   - a file's count going DOWN is fine (cleanup) and you should re-baseline.
 *
 * This mirrors tools/check-colors.js exactly, and for the same reason: the
 * codebase is large and hand-written, so we ratchet (block regressions) rather
 * than demand a clean sheet. Fix findings opportunistically, then re-baseline.
 *
 * Needs a global `eslint` on PATH (CI does `npm install -g eslint@<pinned>`,
 * like the type-check installs tsc). Self-contained config, no local deps.
 *
 * Usage:
 *   node tools/check-lint.js            # check against baseline (exit 1 on regression)
 *   node tools/check-lint.js --update   # regenerate the baseline from current counts
 * ==========================================================================*/
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BASELINE = path.join(__dirname, 'lint-baseline.json');

// Run ESLint and return its JSON report (one entry per linted file).
function runEslint() {
  const res = spawnSync('eslint', ['.', '--format', 'json'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024
  });
  if (res.error && res.error.code === 'ENOENT') {
    console.error('ESLint not found on PATH. Install it with:\n  npm install -g eslint@9.15.0');
    process.exit(2);
  }
  const out = (res.stdout || '').trim();
  if (!out) {
    console.error('ESLint produced no JSON output.' + (res.stderr ? '\n' + res.stderr : ''));
    process.exit(2);
  }
  try { return JSON.parse(out); }
  catch (e) {
    console.error('Could not parse ESLint JSON output.' + (res.stderr ? '\n' + res.stderr : ''));
    process.exit(2);
  }
}

// Per-file problem count (errors + warnings), keyed by repo-relative path.
// Only files with at least one problem are stored (a file missing from the
// baseline is treated as 0, so a new problem in a clean file is a regression).
function currentCounts() {
  const out = {};
  for (const f of runEslint()) {
    const rel = path.relative(ROOT, f.filePath);
    const n = (f.errorCount || 0) + (f.warningCount || 0);
    if (n > 0) out[rel] = n;
  }
  return out;
}

const update = process.argv.includes('--update');
const counts = currentCounts();
const totalProblems = Object.values(counts).reduce((a, b) => a + b, 0);

if (update) {
  // Sort keys so the baseline diffs cleanly.
  const sorted = {};
  for (const k of Object.keys(counts).sort()) sorted[k] = counts[k];
  fs.writeFileSync(BASELINE, JSON.stringify(sorted, null, 2) + '\n');
  console.log('Wrote lint baseline: ' + Object.keys(sorted).length + ' file(s) with ' + totalProblems + ' problem(s).');
  process.exit(0);
}

let baseline = {};
try { baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8')); }
catch (e) { console.error('No lint baseline found. Run: node tools/check-lint.js --update'); process.exit(2); }

const regressions = [];
for (const f of Object.keys(counts)) {
  const base = baseline[f] === undefined ? 0 : baseline[f];
  if (counts[f] > base) regressions.push(f + ': ' + base + ' -> ' + counts[f] + ' (+' + (counts[f] - base) + ' lint problem(s))');
}

if (regressions.length) {
  console.error('ESLint ratchet FAILED -- new lint problems detected:\n');
  regressions.forEach(r => console.error('  ' + r));
  console.error('\nRun `eslint .` to see them. Fix them, or -- if intentional -- re-baseline with:\n  node tools/check-lint.js --update');
  process.exit(1);
}

console.log('ESLint ratchet passed (' + totalProblems + ' baselined problem(s) across ' + Object.keys(counts).length + ' file(s); no regressions).');
process.exit(0);
