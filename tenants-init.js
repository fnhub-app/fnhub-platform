// ── tenants.html page init ───────────────────────────────────────────────────
(async function initTenantsPage() {
  var token = sessionStorage.getItem('clfn_housing_token');
  if (!token) { window.location.href = 'index.html'; return; }
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
    try { await resolveHousingRole(); } catch(e) { console.warn('[tenants] role resolve:', e); }
  }
  var role = HOUSING_SESSION.role || savedRole;
  window.currentRole = role; window._realRole = role;
  if (typeof updateHeaderUser === 'function') updateHeaderUser(role);
  if (typeof updateRoleSwitcherVisibility === 'function') updateRoleSwitcherVisibility();
  if (typeof renderHeaderNav === 'function') renderHeaderNav();
  if (typeof applyRoleVisibility === 'function') applyRoleVisibility(role);
  if (typeof setHeaderNavActive === 'function') setHeaderNavActive('tenants');
  // Reveal the shell immediately (progressive render); the view fills as data loads.
  if (document.body) document.body.style.opacity = '1';
  if (typeof loadHousingData === 'function') {
    try { await loadHousingData(); } catch(e) { console.warn('[tenants] data load error:', e); }
  }
  if (typeof showTenants === 'function') showTenants();
  document.body.style.opacity = '1';
  // Cross-page handoff from landing-page Create menu / Quick Lookup.
  try {
    var qp = new URLSearchParams(window.location.search);
    if (qp.get('action') === 'newTenant' && typeof openAddTenantModal === 'function') {
      setTimeout(function(){ openAddTenantModal(); }, 80);
    }
    var ticId = qp.get('tic');
    if (ticId && typeof openTenantCard === 'function') {
      setTimeout(function(){ openTenantCard(ticId); }, 80);
    }
  } catch (e) { /* harmless */ }
}());