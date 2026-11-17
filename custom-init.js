/* ============================================================
 * custom-init.js — STARTER CUSTOM MODULE (template)
 * ------------------------------------------------------------
 * The page init for custom.html. Mirrors the mail-init.js / inspections boot:
 * restore the session, resolve the role, HARD-GATE on the `custom_module`
 * module (redirect to housing.html when off), render the header, then render
 * the feature. Ships DORMANT (the module defaults OFF everywhere) so it is
 * invisible until a nation is licensed + enables it.
 *
 * MODULE_KEY is the ONE place the module name lives in this file. When you turn
 * this template into a real module, rename MODULE_KEY + MODULE_LABEL here and
 * the matching entries in shared-config.js / scoring.js / admin.js / housing-init.js.
 * ============================================================ */

'use strict';

var MODULE_KEY   = 'custom_module';
var MODULE_LABEL = 'Custom Module';

// ---- Your feature's render goes here ----------------------------------------
// Replace this placeholder with the real UI. You have the full shared layer
// available (shared-data.js REST helpers, DocLibrary, dialogs, showToast,
// clfnSearchSelect, the nation theme, NATION_CONFIG, etc.). Store data in the
// nation's own DB: housing_settings jsonb for config, or a dedicated table +
// migration run only on that nation's project.
function renderCustomModule() {
  var body = document.getElementById('custom_body');
  if (!body) return;

  var nationName = (window.NATION_CONFIG && (NATION_CONFIG.display_name || NATION_CONFIG.short)) || 'this nation';

  // Example empty-state scaffold (delete when you build the real thing).
  body.innerHTML =
      '<div class="card" style="padding:0;overflow:hidden;">'
    +   '<div style="padding:28px 22px;border-bottom:1px solid var(--border);">'
    +     '<div style="font-size:15px;font-weight:600;color:var(--text);margin-bottom:6px;">Starter custom module</div>'
    +     '<div style="font-size:13px;color:var(--muted);line-height:1.6;max-width:70ch;">'
    +       'This is a working, module-gated page for <strong>' + _cEsc(nationName) + '</strong>. '
    +       'It only appears when this nation is <strong>licensed</strong> for the module (admin control plane) and a super user <strong>enables</strong> it (Settings &rarr; Nation &rarr; Modules). '
    +       'Build your feature in <code>renderCustomModule()</code> in <code>custom-init.js</code>.'
    +     '</div>'
    +   '</div>'
    +   '<div style="padding:22px;">'
    +     '<div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.6px;margin-bottom:10px;">What you can use here</div>'
    +     '<ul style="margin:0;padding-left:18px;font-size:13px;color:var(--text);line-height:1.9;">'
    +       '<li>The shared REST data layer (<code>shared-data.js</code>) and the nation theme / <code>NATION_CONFIG</code>.</li>'
    +       '<li><code>DocLibrary</code> for file uploads, <code>showToast</code>, <code>clfnSearchSelect</code>, the dialog helpers.</li>'
    +       '<li>Role &amp; approval gating via <code>APPROVAL_AUTHORITY</code>; per-nation config via <code>housing_settings</code>.</li>'
    +       '<li>A dedicated table only if you need relational data &mdash; add a migration and run it on this nation\'s project.</li>'
    +     '</ul>'
    +   '</div>'
    + '</div>';

  // Example KPI strip (optional — delete or replace).
  var strip = document.getElementById('custom_kpi_strip');
  if (strip) {
    strip.innerHTML = _cKpi('Status', 'Scaffold ready') + _cKpi('Module', MODULE_LABEL) + _cKpi('Scope', _cEsc(nationName));
  }
}

// ---- small view helpers (rename/remove as you like) -------------------------
function _cEsc(s) {
  return (typeof escapeHtml === 'function') ? escapeHtml(s == null ? '' : String(s))
    : String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function _cKpi(label, value) {
  return '<div class="card" style="flex:1 1 150px;min-width:140px;padding:14px 16px;">'
    + '<div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;">' + _cEsc(label) + '</div>'
    + '<div style="font-size:18px;font-weight:600;color:var(--text);margin-top:4px;">' + value + '</div></div>';
}

// ---- Page init (mirrors mail-init.js) ---------------------------------------
(async function initCustomPage() {
  try {
    var token = sessionStorage.getItem('clfn_housing_token');
    if (!token) { window.location.href = 'index.html'; return; }

    var savedRole  = sessionStorage.getItem('clfn_housing_role')          || 'housing_employee_l1';
    var savedName  = sessionStorage.getItem('clfn_housing_name')          || '';
    var savedEmail = sessionStorage.getItem('clfn_housing_email_session') || '';
    if (typeof HOUSING_HEADERS !== 'undefined') HOUSING_HEADERS['Authorization'] = 'Bearer ' + token;
    if (typeof HOUSING_SESSION !== 'undefined') {
      HOUSING_SESSION.accessToken = token; HOUSING_SESSION.role = savedRole;
      HOUSING_SESSION.name = savedName; HOUSING_SESSION.email = savedEmail;
    }
    window.currentRole = savedRole; window._realRole = savedRole;

    if (typeof resolveHousingRole === 'function') { try { await resolveHousingRole(); } catch(e) {} }
    var role = (typeof HOUSING_SESSION !== 'undefined' && HOUSING_SESSION.role) || savedRole;
    window.currentRole = role; window._realRole = role;

    // HARD GATE 1 (pre-settings): bounce if the module isn't enabled.
    if (typeof initModuleEnablement === 'function') try { initModuleEnablement(); } catch(e) {}
    if (window.CLFN_MODULES && !window.CLFN_MODULES.isEnabled(MODULE_KEY)) {
      if (typeof showModuleDisabledNotice === 'function') showModuleDisabledNotice(MODULE_LABEL);
      else window.location.href = 'housing.html';
      return;
    }

    if (typeof updateHeaderUser             === 'function') updateHeaderUser(role);
    if (typeof updateRoleSwitcherVisibility === 'function') updateRoleSwitcherVisibility();
    if (typeof renderHeaderNav              === 'function') renderHeaderNav();
    if (typeof applyRoleVisibility          === 'function') applyRoleVisibility(role);
    if (typeof setHeaderNavActive           === 'function') setHeaderNavActive('admin');
    if (document.body) document.body.style.opacity = '1';

    if (typeof loadHousingData === 'function') { try { await loadHousingData(); } catch(e) {} }
    // HARD GATE 2 (after settings hydration): direct-URL fail-open guard.
    if (typeof initModuleEnablement === 'function') try { initModuleEnablement(); } catch(e) {}
    if (typeof moduleOn === 'function' && !moduleOn(MODULE_KEY)) {
      if (typeof showModuleDisabledNotice === 'function') showModuleDisabledNotice(MODULE_LABEL);
      else window.location.href = 'housing.html';
      return;
    }

    var view = document.getElementById('customView');
    if (view) view.style.display = 'flex';
    renderCustomModule();
  } catch (e) {
    console.warn('[custom] init failed:', e);
    if (document.body) document.body.style.opacity = '1';
  }
})();
