// ── inventory.html page init ──────────────────────────────────────────────────
(async function initInventoryPage() {
  var token = sessionStorage.getItem('clfn_housing_token');
  if (!token) { var _d = (typeof _stashLoginReturn==='function') && _stashLoginReturn(); window.location.href = _d || 'index.html'; return; }
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
    try { await resolveHousingRole(); } catch(e) { console.warn('[inventory] role resolve:', e); }
  }
  var role = HOUSING_SESSION.role || savedRole;
  window.currentRole = role; window._realRole = role;
  if (typeof updateHeaderUser === 'function') updateHeaderUser(role);
  if (typeof updateRoleSwitcherVisibility === 'function') updateRoleSwitcherVisibility();
  // Stop C: rebuild the dynamic header nav once the resolved role is in.
  // Boot suppresses _onSwitchRole, so call directly here.
  if (typeof renderHeaderNav === 'function') renderHeaderNav();
  if (typeof applyRoleVisibility === 'function') applyRoleVisibility(role);
  if (typeof setHeaderNavActive === 'function') setHeaderNavActive('inventory');
  // Reveal the shell (header/nav) immediately so navigation feels instant; the
  // view below fills in once data arrives (progressive render).
  if (document.body) document.body.style.opacity = '1';
  if (typeof loadHousingData === 'function') {
    try { await loadHousingData(); } catch(e) { console.warn('[inventory] data load error:', e); }
  }
  if (typeof showInventory === 'function') showInventory();
  document.body.style.opacity = '1';

  // Cross-page handoff: if landed here from a contractor card with
  // ?openSow=<unitId>&pn=<projectNumber>, hide the inventory chrome so only
  // the SOW modal is visible, then open the SOW.
  // Also: ?unit=<unitId> from landing-page Quick Lookup opens the unit
  // edit card; ?action=newUnit opens the Add Unit modal.
  try {
    var qp = new URLSearchParams(window.location.search);
    var openUid = qp.get('openSow');
    var openPn  = qp.get('pn');
    if (openUid && typeof openSowModal === 'function') {
      document.body.classList.add('is-sow-only');
      setTimeout(function(){ openSowModal(openUid, openPn || null); }, 100);
    }
    var deepUnit = qp.get('unit');
    if (deepUnit && typeof openUnitEditModal === 'function') {
      // Opened via a cross-page deep link (e.g. landing → Inventory Approvals).
      // Arm the return so CLOSING the card sends the user back where they came
      // from instead of stranding them on inventory.html.
      window._ueDeepLinkReturn = true;
      setTimeout(function(){ openUnitEditModal(deepUnit); }, 100);
    }
    if (qp.get('action') === 'newUnit' && typeof openAddUnitModal === 'function') {
      setTimeout(function(){ openAddUnitModal(); }, 100);
    }
  } catch (e) { /* URLSearchParams not critical */ }
}());