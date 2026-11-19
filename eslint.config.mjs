// ESLint flat config -- bug-focused lint for the vanilla-JS UI layer.
//
// This project is a no-bundler, no-modules, script-tag SPA: every file is a
// plain <script> and functions/vars are shared across files as GLOBALS
// (window.X). That shapes two choices below:
//   * `no-undef` is OFF -- in a cross-file global-soup codebase it flags every
//     legitimate call to a function defined in another file, so it is pure
//     noise here (we lose some typo-catching; an acceptable trade for signal).
//   * `no-unused-vars` uses `vars: "local"` so a top-level function/var that is
//     used from ANOTHER file is not falsely reported as unused; it still catches
//     dead variables inside a function body.
//
// The rule set is deliberately BUG-focused (ESLint's "Possible Problems"
// family plus a few high-signal suggestions), NOT style. It is enforced as a
// RATCHET (tools/check-lint.js vs tools/lint-baseline.json): existing findings
// are baselined, only NEW ones fail CI. Self-contained -- no @eslint/js or
// `globals` import -- so CI only needs a global `eslint` install, like `tsc`.
//
// Scope: root-level *.js only (the nation UI layer), matching the color guard.
// admin/ (separate deploy), supabase/functions (Deno), the email worker, tools,
// tests and docs are excluded.

export default [
  {
    ignores: [
      "node_modules/**",
      "admin/**",
      "supabase/**",
      "cloudflare-email-worker/**",
      "tools/**",
      "tests/**",
      "docs/**",
      "**/*.mjs",
      "**/*.cjs"
    ]
  },
  {
    files: ["*.js"],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: "script"
    },
    rules: {
      // Tuned for the global-script architecture (see header).
      "no-undef": "off",
      "no-unused-vars": ["error", { vars: "local", args: "none", caughtErrors: "none" }],

      // --- genuine bugs (ESLint "Possible Problems") ---
      "no-cond-assign": ["error", "except-parens"],
      "no-const-assign": "error",
      "no-constant-condition": ["error", { checkLoops: false }],
      "no-dupe-args": "error",
      "no-dupe-else-if": "error",
      "no-dupe-keys": "error",
      "no-duplicate-case": "error",
      "no-empty-character-class": "error",
      "no-ex-assign": "error",
      "no-func-assign": "error",
      "no-import-assign": "error",
      "no-invalid-regexp": "error",
      "no-irregular-whitespace": "error",
      "no-obj-calls": "error",
      "no-self-assign": "error",
      "no-setter-return": "error",
      "no-sparse-arrays": "error",
      "no-unexpected-multiline": "error",
      "no-unreachable": "error",
      "no-unsafe-finally": "error",
      "no-unsafe-negation": "error",
      "use-isnan": "error",
      "valid-typeof": "error",
      "no-fallthrough": "error",
      "no-async-promise-executor": "error",
      "no-compare-neg-zero": "error",
      "no-misleading-character-class": "error",
      "getter-return": "error",

      // --- high-signal "Suggestions" that catch real mistakes ---
      "no-self-compare": "error",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-useless-escape": "error",
      "no-redeclare": "error",
      "no-debugger": "error"
    }
  }
];
