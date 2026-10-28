// ── match.html page init ─────────────────────────────────────────────────────
(async function initMatchPage() {
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
    try { await resolveHousingRole(); } catch(e) { console.warn('[match] role resolve:', e); }
  }
  var role = HOUSING_SESSION.role || savedRole;
  window.currentRole = role; window._realRole = role;
  if (typeof updateHeaderUser === 'function') updateHeaderUser(role);
  if (typeof updateRoleSwitcherVisibility === 'function') updateRoleSwitcherVisibility();
  if (typeof renderHeaderNav === 'function') renderHeaderNav();
  if (typeof applyRoleVisibility === 'function') applyRoleVisibility(role);
  if (typeof setHeaderNavActive === 'function') setHeaderNavActive('match');
  // Reveal the shell immediately (progressive render); the view fills as data loads.
  if (document.body) document.body.style.opacity = '1';
  if (typeof loadHousingData === 'function') {
    try { await loadHousingData(); } catch(e) { console.warn('[match] data load error:', e); }
  }
  if (typeof showMatch === 'function') showMatch();
  document.body.style.opacity = '1';
}());