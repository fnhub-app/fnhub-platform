// @ts-check
/* ============================================================
 * shared-auth.js — CLFN Housing Suite
 * Session management, authentication state, role resolution
 * ============================================================
 * Depends on: shared-config.js (SUPABASE_URL, SUPABASE_ANON, HOUSING_SESSION)
 * Load order: shared.js → shared-config.js → THIS FILE → shared-ui.js → shared-data.js
 *
 * Exposes (on window):
 *   window.CLFN_AUTH        — auth state object with setSession / clearSession / getRole
 *   window.HOUSING_SESSION  — mutable session bag (email, name, role, accessToken)
 *   window.HOUSING_HEADERS  — Supabase REST headers (kept in sync with auth state)
 *   window.currentRole      — canonical role string (always read from here)
 *   window._realRole        — actual authenticated role (honours view-as separation)
 *   window._viewAsRole      — ED "view as" role override ('' = not overriding)
 *
 *   resolveHousingRole()    — async; looks up staff table, sets role globals
 *   doLogout()              — async; signs out, clears state, fires onLogout hook
 *   _clearLocalClientState()— wipes localStorage, sessionStorage, window caches
 *
 * Page-specific logout behaviour:
 *   Register a callback before calling doLogout():
 *     window._onLogout = function() { showLoginScreen(); applications = []; };
 *   shared-auth.js calls it automatically after clearing state.
 * ============================================================ */

// ── Session bag ─────────────────────────────────────────────────────────────
// Mutable object — auth layer writes to it; app layer reads from it.
// Never cache a copy; always read the current reference.
/** @type {HousingSession} */
var HOUSING_SESSION = { email: '', name: '', role: '', accessToken: '' };

// ── Supabase REST headers ───────────────────────────────────────────────────
// Rebuilt on login (Bearer = user access token) and on logout (Bearer = anon).
// Guard against SUPABASE_ANON being undefined if shared-config.js failed to load.
if (typeof SUPABASE_ANON === 'undefined') {
  console.error('[CLFN] FATAL: shared-config.js did not load before shared-auth.js. Check your <script> tags and that shared-config.js is accessible.');
}
/** @type {Record<string, string>} */
var HOUSING_HEADERS = {
  'apikey':        (typeof SUPABASE_ANON !== 'undefined' ? SUPABASE_ANON : ''),
  'Authorization': 'Bearer ' + (typeof SUPABASE_ANON !== 'undefined' ? SUPABASE_ANON : ''),
  'Content-Type':  'application/json'
};

// ── Role globals ────────────────────────────────────────────────────────────
window.currentRole  = 'housing_employee_l1'; // effective role (may be view-as)
window._realRole    = null;                   // actual authenticated role
window._viewAsRole  = '';                     // '' = not using view-as

// ── CLFN_AUTH ───────────────────────────────────────────────────────────────
// Central auth state object. All session reads should go through here or
// window.currentRole. Direct reads of HOUSING_SESSION are also fine.
window.CLFN_AUTH = /** @type {any} */ ({
  currentRole:     'housing_employee_l1',
  isAuthenticated: false,

  // ── Called on logout ────────────────────────────────────────────────────
  clearSession: function() {
    this.currentRole     = 'housing_employee_l1';
    this.isAuthenticated = false;
    window.currentRole   = 'housing_employee_l1';
    window._realRole     = null;
    window._viewAsRole   = '';
    console.log('[CLFN] Session cleared');
  }
});

// ── Access-token refresh ─────────────────────────────────────────────────────
// The Supabase access token (JWT) expires (default ~1h). Without refreshing it,
// long sessions — and especially mobile devices that sleep and wake — start
// failing authenticated calls (e.g. Storage uploads: 403 "exp claim timestamp
// check failed"). We keep the refresh_token + expiry and proactively refresh
// before expiry, on boot, and whenever the tab regains focus. Fail-safe: a
// failed refresh never disturbs the existing (possibly stale) session.
var _TOKEN_REFRESH_BUFFER_MS = 120000; // refresh ~2 min before expiry
var _tokenRefreshTimer = null;

function _hydrateTokenMeta() {
  try {
    if (!HOUSING_SESSION.refreshToken) {
      var rt = sessionStorage.getItem('clfn_housing_refresh');
      if (rt) HOUSING_SESSION.refreshToken = rt;
    }
    if (!HOUSING_SESSION.tokenExp) {
      var ex = parseInt(sessionStorage.getItem('clfn_housing_token_exp') || '0', 10);
      if (ex) HOUSING_SESSION.tokenExp = ex;
    }
  } catch (e) {}
}

// Apply a token payload ({access_token, refresh_token, expires_in}) to the
// session + headers + sessionStorage. Returns true on success.
function _applyTokenPayload(data) {
  if (!data || !data.access_token) return false;
  HOUSING_SESSION.accessToken = data.access_token;
  HOUSING_HEADERS['Authorization'] = 'Bearer ' + data.access_token;
  if (data.refresh_token) HOUSING_SESSION.refreshToken = data.refresh_token;
  HOUSING_SESSION.tokenExp = Date.now() + ((data.expires_in || 3600) * 1000);
  try {
    sessionStorage.setItem('clfn_housing_token', data.access_token);
    if (data.refresh_token) sessionStorage.setItem('clfn_housing_refresh', data.refresh_token);
    sessionStorage.setItem('clfn_housing_token_exp', String(HOUSING_SESSION.tokenExp));
  } catch (e) {}
  return true;
}
window._applyTokenPayload = _applyTokenPayload;

async function refreshHousingToken() {
  _hydrateTokenMeta();
  var rt = HOUSING_SESSION.refreshToken;
  if (!rt || typeof SUPABASE_URL === 'undefined') return false;
  try {
    var r = await fetch(SUPABASE_URL + '/auth/v1/token?grant_type=refresh_token', {
      method:  'POST',
      headers: { 'apikey': SUPABASE_ANON, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ refresh_token: rt })
    });
    if (!r.ok) { console.warn('[auth] token refresh failed:', r.status); return false; }
    var data = await r.json();
    if (!_applyTokenPayload(data)) return false;
    scheduleTokenRefresh();
    return true;
  } catch (e) {
    console.warn('[auth] token refresh error:', e);
    return false;
  }
}
window.refreshHousingToken = refreshHousingToken;

// Arm a one-shot timer to refresh shortly before the token expires.
function scheduleTokenRefresh() {
  _hydrateTokenMeta();
  if (_tokenRefreshTimer) { clearTimeout(_tokenRefreshTimer); _tokenRefreshTimer = null; }
  if (!HOUSING_SESSION.refreshToken || !HOUSING_SESSION.tokenExp) return;
  var delay = HOUSING_SESSION.tokenExp - Date.now() - _TOKEN_REFRESH_BUFFER_MS;
  if (delay < 0) delay = 0;
  if (delay > 86400000) delay = 86400000; // setTimeout sanity cap
  _tokenRefreshTimer = setTimeout(function () { refreshHousingToken(); }, delay);
}
window.scheduleTokenRefresh = scheduleTokenRefresh;

function stopTokenRefresh() {
  if (_tokenRefreshTimer) { clearTimeout(_tokenRefreshTimer); _tokenRefreshTimer = null; }
}

// Ensure the access token is usable right now; refresh if expired/near-expiry.
async function ensureFreshToken() {
  _hydrateTokenMeta();
  if (!HOUSING_SESSION.refreshToken) return false;
  if (!HOUSING_SESSION.tokenExp || (HOUSING_SESSION.tokenExp - Date.now()) < _TOKEN_REFRESH_BUFFER_MS) {
    return await refreshHousingToken();
  }
  return true;
}
window.ensureFreshToken = ensureFreshToken;

// Refresh when the tab/app regains focus — covers mobile devices whose timers
// are frozen while asleep, so the token is fresh before the user acts.
if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && HOUSING_SESSION && HOUSING_SESSION.email) {
      ensureFreshToken();
    }
  });
}

// ── resolveHousingRole ───────────────────────────────────────────────────────
// Called after navigation to a housing/renos page to re-establish the role
// from the staff table using the stored session token.
// Depends on: sbMapRole() from shared-data.js (loaded after this file).
async function resolveHousingRole() {
  window._booting = true;
  try {
    // Refresh the access token first if it's expired/near-expiry, then keep it
    // fresh for the rest of this page's lifetime. Prevents "exp claim" 403s.
    try { await ensureFreshToken(); } catch (e) {}
    scheduleTokenRefresh();
    // select=* (not a fixed column list) so newer columns like feature_access
    // load if present but a pre-migration DB still resolves cleanly.
    var r = await fetch(
      SUPABASE_URL + '/rest/v1/staff?select=*&email=eq.' +
      encodeURIComponent(HOUSING_SESSION.email) + '&is_active=eq.true',
      { headers: HOUSING_HEADERS }
    );
    // Distinguish "the server answered: no active staff row" from "the lookup
    // itself failed" — the two must NOT be conflated: no-row means this
    // authenticated account isn't staff (fail CLOSED, sign out), while a
    // transient failure must NOT log field staff out on a flaky connection
    // (fail SOFT into the least-privileged role, with a visible notice).
    var lookupOk = r.ok;
    var rows = lookupOk ? await r.json() : [];
    if (lookupOk && (!rows || !rows.length)) {
      // Authenticated, but not an active staff member. The old code silently
      // handed them a working L1 employee UI (RLS was the only real gate).
      console.warn('[HOUSING] authenticated user has no active staff row — signing out');
      try {
        ['clfn_housing_token','clfn_housing_refresh','clfn_housing_token_exp',
         'clfn_housing_role','clfn_housing_name','clfn_housing_email_session']
          .forEach(function(k){ try { sessionStorage.removeItem(k); } catch (e) {} });
      } catch (e) {}
      try { if (typeof doLogout === 'function') doLogout(); } catch (e) {}
      try { window.location.href = 'index.html'; } catch (e) {}
      return;
    }
    if (rows && rows.length) {
      var staffRow    = rows[0];

      // Access expiry (Phase FA): deny past the expiry date, regardless of auth
      // method (password or magic link). Deny-by-date only — is_active is not
      // touched, so extending the date restores access immediately.
      if (_isStaffExpired(staffRow)) { _denyExpiredAccess(); return; }

      var housingRole = (typeof sbMapRole === 'function')
        ? sbMapRole(staffRow)
        : (staffRow.role || 'housing_employee_l1');

      // Per-user Feature Access (Phase FA): a non-empty array restricts this
      // user to those functions; null/absent = no restriction (full access).
      HOUSING_SESSION.featureAccess = Array.isArray(staffRow.feature_access) ? staffRow.feature_access : null;

      HOUSING_SESSION.name = staffRow.name || HOUSING_SESSION.name;
      HOUSING_SESSION.role = housingRole;
      window.currentRole   = housingRole;
      window._realRole     = housingRole;
      window._viewAsRole   = '';
      window.CLFN_AUTH.isAuthenticated = true;
      window.CLFN_AUTH.currentRole     = housingRole;

      if (typeof switchRole === 'function') switchRole(housingRole);

      // Session is real — start the idle-logout watcher
      if (typeof startIdleTimer === 'function') startIdleTimer();

      // Record the sign-in once per browser session. This runs on every page's
      // boot, but the flag inside makes it idempotent — so a session *resume*
      // (token already in sessionStorage, app handed off straight to
      // housing.html without re-entering credentials) is captured too, not just
      // fresh sign-ins through startSignIn().
      _recordSessionLogin();

      // Feature-access page guard: a feature-restricted user who lands on a page
      // they aren't granted (nav hidden, but a direct URL still loads it) is
      // bounced to the home page. Only affects users with an explicit list.
      _enforcePageFeature();
    } else {
      // Lookup HTTP-failed (r.ok false) — transient. Fail soft to the
      // least-privileged role, but say so: a manager silently downgraded to
      // the L1 UI on a flaky boot had no idea why their nav/approvals vanished.
      console.warn('[HOUSING] staff lookup HTTP ' + r.status + ' — falling back to L1 for this session');
      HOUSING_SESSION.role = 'housing_employee_l1';
      window.currentRole   = 'housing_employee_l1';
      if (typeof showToast === 'function') showToast('Could not verify your role (connection issue) — limited access this session. Reload to retry.', { type: 'error' });
    }
  } catch(e) {
    console.warn('[HOUSING] role lookup failed:', e);
    HOUSING_SESSION.role = 'housing_employee_l1';
    window.currentRole   = 'housing_employee_l1';
    if (typeof showToast === 'function') showToast('Could not verify your role (connection issue) — limited access this session. Reload to retry.', { type: 'error' });
  } finally {
    window._booting = false;
  }
}

// ── Access expiry (deny-by-date) ──────────────────────────────────────────────
// True when the staff row carries an access_expires_at date that has passed.
// The date is INCLUSIVE — access works through the whole of that local day —
// so we deny only once the clock is at/after the following local midnight.
function _isStaffExpired(row) {
  var v = row && row.access_expires_at;
  if (!v) return false;
  var m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return false;
  var endOfDay = new Date(+m[1], (+m[2]) - 1, (+m[3]) + 1).getTime();
  return Date.now() >= endOfDay;
}
// Mirror the idle-logout teardown: clear tokens synchronously, fire logout
// detached, redirect to the login page with an expired notice. Sets a flag so an
// in-flight sign-in caller can bail instead of racing a redirect to the app.
function _denyExpiredAccess() {
  window._accessExpired = true;
  try { if (typeof _clearLocalClientState === 'function') _clearLocalClientState(); } catch (e) {}
  try {
    ['clfn_housing_token','clfn_housing_refresh','clfn_housing_token_exp',
     'clfn_housing_role','clfn_housing_name','clfn_housing_email_session']
      .forEach(function(k){ try { sessionStorage.removeItem(k); } catch (e) {} });
  } catch (e) {}
  try { if (typeof doLogout === 'function') doLogout(); } catch (e) {}
  try { window.location.href = 'index.html?expired=1'; } catch (e) {}
}
window._isStaffExpired = _isStaffExpired;
window._denyExpiredAccess = _denyExpiredAccess;

// ── _enforcePageFeature ───────────────────────────────────────────────────────
// Redirect a feature-restricted user off a page whose function they aren't
// granted. No-op for unrestricted users (the common case). Belt-and-suspenders
// to the nav hiding — closes the direct-URL hole for external accounts.
function _enforcePageFeature() {
  try {
    if (typeof window.isFeatureRestricted !== 'function' || !window.isFeatureRestricted()) return;
    var path = (location.pathname || '').toLowerCase();
    var MAP = {
      'inventory.html':   'inventory',
      'match.html':       'match',
      'renos.html':       'renovations',
      'rfq.html':         'rfq',
      'contractors.html': 'contractors',
      'inspections.html': 'inspections',
      'tenants.html':     'tenants',
      'finance.html':     'finance'
    };
    var feat = null;
    Object.keys(MAP).forEach(function(f){ if (path.indexOf(f) !== -1) feat = MAP[f]; });
    if (feat && typeof window.canUseFeature === 'function' && !window.canUseFeature(feat)) {
      try { sessionStorage.setItem('clfn_feature_denied', feat); } catch(e) {}
      location.href = 'housing.html';
    }
  } catch(e) {}
}
window._enforcePageFeature = _enforcePageFeature;

// ── _recordSessionLogin ──────────────────────────────────────────────────────
// Writes a single "Signed In" audit row per browser session. Guarded by the
// sessionStorage flag `clfn_login_audited` so the many resolveHousingRole()
// calls across page navigations within one session don't each write a row. The
// flag clears on browser close (sessionStorage is per-session) and on logout
// (see _clearLocalClientState / _idleLogout), so the next session start records
// a fresh login. Self-contained direct write (keepalive so it survives the
// sign-in redirect) — mirrors the logout write in doLogout().
function _recordSessionLogin() {
  try {
    if (sessionStorage.getItem('clfn_login_audited') === '1') return;
  } catch(e) {}
  var email = (HOUSING_SESSION && HOUSING_SESSION.email) || '';
  if (!email) return;
  try { sessionStorage.setItem('clfn_login_audited', '1'); } catch(e) {}
  try {
    fetch(SUPABASE_URL + '/rest/v1/housing_audit_log', {
      method:    'POST',
      keepalive: true,
      headers:   Object.assign({}, HOUSING_HEADERS, { 'Prefer': 'return=minimal' }),
      body:      JSON.stringify({
        entity_type: 'auth',
        entity_id:   'LOGIN',
        action:      'user_login',
        detail:      JSON.stringify({ detail: 'Signed in', name: (HOUSING_SESSION && HOUSING_SESSION.name) || '' }),
        actor:       email,
        created_at:  new Date().toISOString()
      })
    }).catch(function(e){ console.warn('[auth] login audit write failed:', e); });
  } catch(e) {}
}
window._recordSessionLogin = _recordSessionLogin;

// ── _clearLocalClientState ───────────────────────────────────────────────────
// Wipes all client-side state: localStorage keys, sessionStorage keys,
// and in-memory window caches. Called on logout and on session expiry.
function _clearLocalClientState() {
  // localStorage
  var lsKeys = [
    'clfn_applications', 'clfn_housing_units',
    'clfn_scoring_model', 'clfn_scoring_model_v2', 'clfn_scoring_tiers_v2',
    'clfn_budget_pools', 'clfn_reno_score_model_v3', 'clfn_unit_score_model',
    'clfn_housing_email'
  ];
  try { lsKeys.forEach(function(k) { try { localStorage.removeItem(k); } catch(e) {} }); } catch(e) {}

  // sessionStorage
  try {
    ['clfn_housing_token','clfn_housing_refresh','clfn_housing_token_exp',
     'clfn_housing_role','clfn_housing_name','clfn_housing_email_session',
     'clfn_logo_cache','clfn_logo_transparent','clfn_login_audited']
      .forEach(function(k) { try { sessionStorage.removeItem(k); } catch(e) {} });
  } catch(e) {}

  // In-memory window caches
  var winKeys = [
    '_contractors','_sowCache','_renoProgress','_appSettings','_renoBudget',
    '_unitPhotos','_staffCache','_editingUnitId','_rbaUnitId','_sowUnitId',
    '_currentDetailUnitId','_ctLastSaved','_pendingLookupUser','_currentScorecardApp',
    '_auStagedPhotos','_ueStagedPhotos','_rpPendingPhotos','_rpStoredPhotos',
    '_rpUnitId','_tenantFilesUnitId','_appFormReturnTo','_appFormReturnDrill','_appMenuId',
    '_userLookupTimer','_ctEditIdx','_ctFilter','_sowWasPreviouslySaved',
    '_sowAfterContractorSave','_rpAfterContractorSave','_printPanelDoc'
  ];
  winKeys.forEach(function(k) { try { window[k] = undefined; delete window[k]; } catch(e) {} });
}

// ── doLogout ─────────────────────────────────────────────────────────────────
// Signs the user out of Supabase, clears all client state, resets headers,
// then calls window._onLogout() if registered (page-specific: show login screen,
// clear data arrays, etc.).
// `reason` distinguishes a deliberate sign-out via the logout button (default)
// from an automatic idle-timeout sign-out ('idle'), so the two are recorded as
// separate audit events.
async function doLogout(reason) {
  stopIdleTimer();
  if (typeof stopTokenRefresh === 'function') stopTokenRefresh();

  // Audit the sign-out before tearing down the session — the user's token is
  // still valid in HOUSING_HEADERS at this point. Self-contained direct write
  // (matching the login write in auth-login.js) because shared-data.js's
  // auditEntry() isn't loaded on every page that can call doLogout. keepalive:true
  // lets the request survive the immediate redirect on an idle-timeout logout.
  try {
    var _isIdle = (reason === 'idle' || reason === 'timeout');
    var _logoutEmail = (HOUSING_SESSION && HOUSING_SESSION.email) || '';
    if (_logoutEmail) {
      fetch(SUPABASE_URL + '/rest/v1/housing_audit_log', {
        method:    'POST',
        keepalive: true,
        headers:   Object.assign({}, HOUSING_HEADERS, { 'Prefer': 'return=minimal' }),
        body:      JSON.stringify({
          entity_type: 'auth',
          entity_id:   'LOGOUT',
          action:      _isIdle ? 'user_logout_timeout' : 'user_logout',
          detail:      JSON.stringify({
            detail: _isIdle ? 'Signed out — idle timeout' : 'Signed out — logout button',
            name:   (HOUSING_SESSION && HOUSING_SESSION.name) || ''
          }),
          actor:       _logoutEmail,
          created_at:  new Date().toISOString()
        })
      }).catch(function(e){ console.warn('[auth] logout audit write failed:', e); });
    }
  } catch(e) {}

  try {
    await fetch(SUPABASE_URL + '/auth/v1/logout', { method: 'POST', headers: HOUSING_HEADERS });
  } catch(e) {}

  _clearLocalClientState();
  window.CLFN_AUTH.clearSession();

  HOUSING_SESSION = { email: '', name: '', role: '', accessToken: '' };
  HOUSING_HEADERS['Authorization'] = 'Bearer ' + SUPABASE_ANON;

  // Notify the page — each page registers window._onLogout to handle
  // page-specific teardown (show login screen, clear data arrays, etc.)
  if (typeof window._onLogout === 'function') {
    try { window._onLogout(); } catch(e) { console.warn('[auth] _onLogout error:', e); }
  }
}

// ── Idle timeout ─────────────────────────────────────────────────────────────
// Auto-logout after IDLE_TIMEOUT_MS of no user activity.
// startIdleTimer() is called automatically by setSession() and resolveHousingRole();
// stopIdleTimer() runs in doLogout(). Pages don't need to wire anything up.
//
// To customise per nation later, override window.IDLE_TIMEOUT_MS before
// shared-auth.js loads — or set it from NATION_CONFIG at boot.
window.IDLE_TIMEOUT_MS = window.IDLE_TIMEOUT_MS || 15 * 60 * 1000; // 15 min
var _idleTimer = null;
var _idleListenersAttached = false;
var _IDLE_EVENTS = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'click'];

function _resetIdleTimer() {
  // Don't run the timer if nobody's logged in
  if (!HOUSING_SESSION || !HOUSING_SESSION.email) return;
  if (_idleTimer) clearTimeout(_idleTimer);
  _idleTimer = setTimeout(_idleLogout, window.IDLE_TIMEOUT_MS);
}

function _idleLogout() {
  console.log('[CLFN] Idle timeout — signing out');

  // 1. Immediately clear session tokens so any subsequent housing page loads
  //    bounce to login without waiting for network.
  try {
    ['clfn_housing_token','clfn_housing_refresh','clfn_housing_token_exp',
     'clfn_housing_role','clfn_housing_name',
     'clfn_housing_email_session','clfn_login_audited'].forEach(function(k){
      try { sessionStorage.removeItem(k); } catch(e) {}
    });
  } catch(e) {}

  // 2. Fire the full cleanup + Supabase sign-out in the background.
  //    We don't await it — the redirect below must not block on network.
  stopIdleTimer();
  if (typeof doLogout === 'function') {
    try { doLogout('idle').catch(function(e){ console.warn('[CLFN] idle doLogout:', e); }); } catch(e) {}
  }

  // 3. Navigate immediately. Pass ?timeout=1 so the login page can show a
  //    "session expired" message instead of a generic blank form.
  var path = window.location.pathname;
  var onLogin = /(?:^|\/)index\.html$/.test(path) || path === '/' || path === '';
  if (!onLogin) {
    window.location.href = 'index.html?timeout=1';
  }
}

// Before bouncing an unauthenticated user to the login screen, remember a deep
// link (e.g. the button in a Maintenance Request / RFQ / application email ->
// a specific record) so auth-login.js (_loginDest) returns them there after
// sign-in instead of the dashboard. Only a relative, same-origin app URL
// carrying a known entity param is stored; _loginDest re-validates + expires it.
//
// Two channels, both consumed by _loginDest: (1) localStorage, and (2) the
// RETURN value of this function -- an 'index.html?return=<dest>' URL the caller
// navigates to. The URL channel survives even when localStorage is unavailable
// or wiped (private mode, in-app webviews, a stale cached deep-link page),
// because the destination rides the redirect itself through a same-tab login.
// Returns null when there's no deep link to preserve (caller falls back to a
// plain 'index.html').
window._stashLoginReturn = function(){
  try {
    var qs = window.location.search || '';
    if (/[?&](sow|unit|rfq|openApp|openScorecard)=/.test(qs)) {
      var dest = (window.location.pathname.replace(/^\//, '') + qs).slice(0, 500);
      localStorage.setItem('clfn_login_return', JSON.stringify({ u: dest, t: Date.now() }));
      // Also remember an MR deep link specifically. If the return navigation
      // doesn't land the user back on the request (it drops to the dashboard),
      // the landing page reads this to surface a notification about the request
      // instead of a silent landing. Independent of clfn_login_return, which
      // _loginDest consumes on the way back. Cleared by whichever page handles
      // it (renos opens the MR, or housing.html shows the notice).
      try {
        var _p = new URLSearchParams(qs);
        if (_p.get('sow')) {
          localStorage.setItem('clfn_mr_notice', JSON.stringify({
            sow: _p.get('sow'), pn: _p.get('pn') || '', action: _p.get('action') || '', t: Date.now()
          }));
        }
      } catch(e) {}
      return 'index.html?return=' + encodeURIComponent(dest);
    }
  } catch(e) {}
  return null;
};

// Session/token-expiry teardown. When an authenticated Supabase call comes back
// 401 and the token can't be refreshed, the session is dead and the user is
// otherwise stranded on a page making failing calls. Mirror _idleLogout exactly
// (synchronous token clear -> detached sign-out -> immediate redirect; never
// await network before navigating) so they land on the login screen with the
// same "session expired" banner (?timeout=1). This is distinct from the slow-
// connection save timeout, which intentionally stays in the offline queue.
function _handleSessionExpired() {
  console.log('[CLFN] Session expired - signing out');
  try {
    ['clfn_housing_token','clfn_housing_refresh','clfn_housing_token_exp',
     'clfn_housing_role','clfn_housing_name',
     'clfn_housing_email_session','clfn_login_audited'].forEach(function(k){
      try { sessionStorage.removeItem(k); } catch(e) {}
    });
  } catch(e) {}
  stopIdleTimer();
  if (typeof doLogout === 'function') {
    try { doLogout('expired').catch(function(e){ console.warn('[CLFN] expired doLogout:', e); }); } catch(e) {}
  }
  var path = window.location.pathname;
  var onLogin = /(?:^|\/)index\.html$/.test(path) || path === '/' || path === '';
  if (!onLogin) {
    window.location.href = 'index.html?timeout=1';
  }
}
window._handleSessionExpired = _handleSessionExpired;

// Global 401 interceptor. Any authenticated Supabase REST / Storage / Edge
// Function call that returns 401 means the JWT is dead (PostgREST returns 403,
// not 401, for RLS/permission denials, so this won't fire on those). Try ONE
// token refresh; if it succeeds the session self-heals silently, if it fails
// the session is genuinely expired -> _handleSessionExpired() bounces to login.
// Guards: only Supabase URLs, never /auth/v1/ (so login + refresh failures don't
// trip it and there's no redirect loop), and only when we believed we had a
// session. Slow-save TIMEOUTS never reach here -- they reject locally and the
// degraded-mode/offline queue handles them.
(function(){
  if (typeof window === 'undefined' || !window.fetch || window._authFetchWrapped) return;
  window._authFetchWrapped = true;
  var _origFetch = window.fetch.bind(window);
  var _handling = false;
  window.fetch = function(input, init){
    return _origFetch(input, init).then(function(resp){
      try {
        if (resp && resp.status === 401 && !_handling
            && typeof SUPABASE_URL !== 'undefined' && SUPABASE_URL) {
          var url = (typeof input === 'string') ? input : (input && /** @type {Request} */ (input).url) || '';
          var isSb   = url.indexOf(SUPABASE_URL) === 0;
          var isAuth = url.indexOf('/auth/v1/') !== -1;
          var haveSession = !!(typeof HOUSING_SESSION !== 'undefined'
                               && HOUSING_SESSION && HOUSING_SESSION.accessToken);
          if (isSb && !isAuth && haveSession) {
            _handling = true;
            (typeof refreshHousingToken === 'function'
               ? refreshHousingToken() : Promise.resolve(false))
              .then(function(ok){
                if (ok) { _handling = false; }            // recovered silently
                else if (typeof _handleSessionExpired === 'function') _handleSessionExpired();
              })
              .catch(function(){
                if (typeof _handleSessionExpired === 'function') _handleSessionExpired();
              });
          }
        }
      } catch(e){}
      return resp;
    });
  };
})();

function startIdleTimer() {
  if (!HOUSING_SESSION || !HOUSING_SESSION.email) return;
  if (!_idleListenersAttached) {
    _IDLE_EVENTS.forEach(function(evt) {
      document.addEventListener(evt, _resetIdleTimer, { passive: true });
    });
    _idleListenersAttached = true;
  }
  _resetIdleTimer();
}

function stopIdleTimer() {
  if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
  if (_idleListenersAttached) {
    _IDLE_EVENTS.forEach(function(evt) {
      document.removeEventListener(evt, _resetIdleTimer);
    });
    _idleListenersAttached = false;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Two-factor authentication (TOTP) — Phase 1: OPT-IN.
// Direct GoTrue MFA REST (no SDK). Nothing here forces a factor, so no one can
// be locked out: a staff member enrolls from the avatar menu (openMfaSetup),
// and only THEN does login step up (_mfaLoginStepUp). Requires MFA to be
// enabled in the Supabase project (Auth settings). No colour literals — the
// modals use theme tokens (var(--...)) like the rest of the app.
// ════════════════════════════════════════════════════════════════════════════
function _mfaHeaders(token) {
  return { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON, 'Authorization': 'Bearer ' + token };
}
function _mfaEsc(s) { return (typeof escapeHtml === 'function') ? escapeHtml(String(s == null ? '' : s)) : String(s == null ? '' : s); }

// Timed fetch for the 2FA LISTING / POLICY reads only. Plain fetch() has no
// built-in timeout, so a stalled request on a flaky mobile connection hangs
// forever — and because these reads sit in the sign-in flow (step-up factor
// list, role-enforcement policy + factor list), a stall froze the whole sign-in
// on "Signing in..." with no way out. This aborts after `ms` and rejects, so the
// callers' catch blocks fail soft/open and the login proceeds. NOT used for the
// interactive code/enroll modals (those legitimately wait on the user).
function _mfaFetch(url, opts, ms) {
  opts = opts || {};
  var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  if (ctrl) opts.signal = ctrl.signal;
  var timer = setTimeout(function () { try { if (ctrl) ctrl.abort(); } catch (e) {} }, ms || 8000);
  return fetch(url, opts).then(
    function (r) { clearTimeout(timer); return r; },
    function (e) { clearTimeout(timer); throw e; }
  );
}

// All TOTP factors for an access token (used by setup to clean up unverified).
async function _mfaListAllFactors(token) {
  try {
    var r = await _mfaFetch(SUPABASE_URL + '/auth/v1/user', { headers: _mfaHeaders(token) }, 8000);
    if (!r.ok) return [];
    var u = await r.json();
    var fx = (u && u.factors) || [];
    return fx.filter(function (f) { return f && (f.factor_type === 'totp' || f.factor_type === 'phone'); });
  } catch (e) { return []; }
}
async function _mfaListVerifiedFactors(token) {
  var all = await _mfaListAllFactors(token);
  return all.filter(function (f) { return f.status === 'verified'; });
}

// Start a challenge for a factor -> challenge id. For a PHONE factor this is
// what triggers the SMS send; for TOTP it is instant (code comes from the app).
async function _mfaChallenge(token, factorId) {
  var cr = await fetch(SUPABASE_URL + '/auth/v1/factors/' + encodeURIComponent(factorId) + '/challenge', { method: 'POST', headers: _mfaHeaders(token) });
  var cd = await cr.json().catch(function () { return {}; });
  if (!cr.ok || !cd.id) throw new Error((cd && (cd.msg || cd.error_description || cd.error)) || 'Could not start the challenge');
  return cd.id;
}
// Verify a challenge with a 6-digit code -> new (AAL2) session, or throw.
async function _mfaVerify(token, factorId, challengeId, code) {
  var vr = await fetch(SUPABASE_URL + '/auth/v1/factors/' + encodeURIComponent(factorId) + '/verify', {
    method: 'POST', headers: _mfaHeaders(token),
    body: JSON.stringify({ challenge_id: challengeId, code: String(code || '').trim() })
  });
  var vd = await vr.json().catch(function () { return {}; });
  if (!vr.ok || !vd.access_token) throw new Error((vd && (vd.msg || vd.error_description || vd.error)) || 'That code was not valid');
  return vd;
}
// Challenge + verify in one step (TOTP: the code is already in hand from the app).
async function _mfaChallengeVerify(token, factorId, code) {
  var challengeId = await _mfaChallenge(token, factorId);
  return _mfaVerify(token, factorId, challengeId, code);
}
async function _mfaUnenroll(token, factorId) {
  try { await fetch(SUPABASE_URL + '/auth/v1/factors/' + encodeURIComponent(factorId), { method: 'DELETE', headers: _mfaHeaders(token) }); } catch (e) { /* non-fatal */ }
}

// ── Login step-up ───────────────────────────────────────────────────────────
// Called from auth-login.js right after the password grant. Returns
// { ok:true } (no factor, proceed), { ok:true, session } (stepped up to AAL2),
// or { ok:false } (user cancelled -> abort login). Listing fails soft (opt-in,
// no enforcement); the VERIFY itself is strict (success or cancel only).
async function _mfaLoginStepUp(sessionData) {
  var token = sessionData && sessionData.access_token;
  if (!token) return { ok: true };
  var factors = await _mfaListVerifiedFactors(token);
  if (!factors.length) return { ok: true };
  var newSession = await _mfaPromptCode(token, factors[0]);
  if (!newSession) return { ok: false };
  return { ok: true, session: newSession };
}
window._mfaLoginStepUp = _mfaLoginStepUp;

// Full-screen code prompt used at login. Resolves to the new session on a
// correct code, or null if the user cancels. Loops on wrong codes.
// `factor` may be a factor object { id, factor_type } or a bare id. For a PHONE
// factor the challenge is fired when the prompt OPENS (that is what sends the
// SMS), and a "Resend" button re-sends it; TOTP verifies challenge+code together.
function _mfaPromptCode(token, factor) {
  var factorId = (factor && factor.id) || factor;
  var isPhone  = !!(factor && factor.factor_type === 'phone');
  return new Promise(function (resolve) {
    var ov = document.createElement('div');
    ov.id = '_mfaCodeOverlay';
    // `.mfa-code-overlay` (shared.css) carries the fixed full-screen layout so
    // this works on the LOGIN page, which loads shared.css but not housing.css
    // (where `.modal-overlay` is defined). Keeping `.modal-overlay` too is
    // harmless on app pages. Without the self-positioning class the prompt fell
    // to the bottom of the page in normal flow -- invisible -- and sign-in hung.
    ov.className = 'modal-overlay mfa-code-overlay';
    ov.setAttribute('style', 'z-index:100000;');
    var intro = isPhone
      ? 'We just texted a 6-digit code to your phone. Enter it below.'
      : 'Enter the 6-digit code from your authenticator app.';
    ov.innerHTML =
      '<div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;width:100%;max-width:380px;padding:22px;">'
      + '<div style="font-size:16px;font-weight:700;color:var(--text);margin-bottom:4px;">Two-factor verification</div>'
      + '<div style="font-size:13px;color:var(--muted);margin-bottom:14px;line-height:1.5;">' + intro + '</div>'
      + '<input id="_mfaCodeInput" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456" style="width:100%;box-sizing:border-box;padding:12px;font-size:18px;letter-spacing:4px;text-align:center;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);"/>'
      + '<div id="_mfaCodeMsg" style="min-height:16px;font-size:12px;color:var(--danger);margin-top:8px;"></div>'
      + '<div style="display:flex;gap:8px;margin-top:12px;">'
      +   (isPhone ? '<button type="button" id="_mfaCodeResend" class="btn btn-ghost" style="flex:1;">Resend</button>' : '')
      +   '<button type="button" id="_mfaCodeCancel" class="btn btn-ghost" style="flex:1;">Cancel</button>'
      +   '<button type="button" id="_mfaCodeVerify" class="btn btn-primary" style="flex:1;">Verify</button>'
      + '</div></div>';
    document.body.appendChild(ov);
    var input = ov.querySelector('#_mfaCodeInput');
    var msg = ov.querySelector('#_mfaCodeMsg');
    var vbtn = ov.querySelector('#_mfaCodeVerify');
    var cbtn = ov.querySelector('#_mfaCodeCancel');
    var rbtn = ov.querySelector('#_mfaCodeResend');
    if (input) input.focus();
    var challengeId = null;
    function done(val) { try { ov.remove(); } catch (e) {} resolve(val); }
    async function tryVerify() {
      var code = (input && input.value || '').trim();
      if (code.length < 6) { if (msg) msg.textContent = 'Enter all 6 digits.'; return; }
      if (vbtn) { vbtn.disabled = true; vbtn.textContent = 'Verifying…'; }
      if (msg) msg.textContent = '';
      try {
        var newSession;
        if (isPhone) {
          if (!challengeId) challengeId = await _mfaChallenge(token, factorId);
          newSession = await _mfaVerify(token, factorId, challengeId, code);
        } else {
          newSession = await _mfaChallengeVerify(token, factorId, code);
        }
        done(newSession);
      } catch (e) {
        if (msg) msg.textContent = (e && e.message) || 'That code was not valid.';
        if (vbtn) { vbtn.disabled = false; vbtn.textContent = 'Verify'; }
        if (input) { input.value = ''; input.focus(); }
      }
    }
    if (vbtn) vbtn.addEventListener('click', tryVerify);
    if (cbtn) cbtn.addEventListener('click', function () { done(null); });
    if (rbtn) rbtn.addEventListener('click', async function () {
      if (msg) msg.textContent = '';
      rbtn.disabled = true; rbtn.textContent = 'Sending…';
      try { challengeId = await _mfaChallenge(token, factorId); if (msg) msg.textContent = 'New code sent.'; }
      catch (e) { if (msg) msg.textContent = (e && e.message) || 'Could not resend.'; }
      rbtn.disabled = false; rbtn.textContent = 'Resend';
    });
    if (input) input.addEventListener('keydown', function (/** @type {KeyboardEvent} */ e) { if (e.key === 'Enter') tryVerify(); });
    // For a phone factor, send the SMS as soon as the prompt opens.
    if (isPhone) { _mfaChallenge(token, factorId).then(function (id) { challengeId = id; }).catch(function (e) { if (msg) msg.textContent = (e && e.message) || 'Could not send the code.'; }); }
  });
}

// ── Enrollment / status modal (opt-in, from the avatar menu) ─────────────────
function openMfaSetup() {
  var token = (window.HOUSING_SESSION && HOUSING_SESSION.accessToken) || '';
  if (!token) { if (typeof showToast === 'function') showToast('Please sign in again before changing two-factor settings.', { type: 'error' }); return; }
  var host = document.getElementById('mfaSetupModal');
  if (!host) { host = document.createElement('div'); host.id = 'mfaSetupModal'; document.body.appendChild(host); }

  function shell(bodyHtml) {
    host.innerHTML =
      '<div class="modal-overlay" style="display:flex;z-index:1200;" onclick="if(event.target===this)_mfaCloseSetup()">'
      + '<div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;width:100%;max-width:440px;max-height:92vh;display:flex;flex-direction:column;overflow:hidden;">'
      +   '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 20px;border-bottom:3px solid var(--accent);">'
      +     '<div style="font-size:16px;font-weight:700;color:var(--text);">&#128274; Two-Factor Authentication</div>'
      +     '<button type="button" onclick="_mfaCloseSetup()" class="tic-close-btn" aria-label="Close">&#10005;</button>'
      +   '</div>'
      +   '<div style="padding:18px 20px;overflow-y:auto;">' + bodyHtml + '</div>'
      + '</div></div>';
  }
  shell('<div style="color:var(--muted);font-size:13px;">Loading…</div>');

  _mfaListAllFactors(token).then(function (factors) {
    var verified = factors.filter(function (f) { return f.status === 'verified'; });
    if (verified.length) {
      var onMethod = verified[0].factor_type === 'phone' ? 'sent to you by text message' : 'from your authenticator app';
      shell(
        '<div style="display:flex;align-items:center;gap:8px;padding:10px 12px;background:var(--success-bg,var(--bg));border:1px solid var(--success,var(--border));border-radius:8px;color:var(--success,var(--text));font-size:13px;font-weight:600;margin-bottom:14px;">&#10003; Two-factor authentication is ON for your account.</div>'
        + '<div style="font-size:13px;color:var(--muted);line-height:1.5;margin-bottom:14px;">You will be asked for a 6-digit code ' + onMethod + ' each time you sign in.</div>'
        + '<button type="button" id="_mfaTurnOff" class="btn btn-ghost" style="color:var(--danger);border-color:var(--danger);">Turn off two-factor</button>'
      );
      var off = document.getElementById('_mfaTurnOff');
      if (off) off.addEventListener('click', function () {
        off.disabled = true; off.textContent = 'Turning off…';
        var jobs = verified.map(function (f) { return _mfaUnenroll(token, f.id); });
        Promise.all(jobs).then(function () {
          if (typeof showToast === 'function') showToast('Two-factor authentication turned off.', { type: 'info' });
          openMfaSetup();
        });
      });
      return;
    }
    // Not enrolled: clean up any dangling unverified factors, then show setup.
    var stale = factors.filter(function (f) { return f.status !== 'verified'; });
    Promise.all(stale.map(function (f) { return _mfaUnenroll(token, f.id); })).then(function () {
      shell(
        '<div style="font-size:13px;color:var(--muted);line-height:1.5;margin-bottom:14px;">Add a second step to your sign-in. Choose how you want to receive your code:</div>'
        + '<button type="button" id="_mfaStartTotp" class="btn btn-primary" style="width:100%;margin-bottom:8px;">Use an authenticator app</button>'
        + '<button type="button" id="_mfaStartPhone" class="btn btn-ghost" style="width:100%;">Use text messages (SMS)</button>'
        + '<div style="font-size:11px;color:var(--muted);line-height:1.5;margin-top:10px;">An authenticator app (Google Authenticator, Microsoft Authenticator, Authy, 1Password) is free and works without cell signal. Text messages require SMS to be enabled for your nation.</div>'
      );
      var startT = document.getElementById('_mfaStartTotp');
      var startP = document.getElementById('_mfaStartPhone');
      if (startT) startT.addEventListener('click', function () { _mfaBeginEnroll(token, shell); });
      if (startP) startP.addEventListener('click', function () { _mfaBeginEnrollPhone(token, shell); });
    });
  });
}
window.openMfaSetup = openMfaSetup;

function _mfaCloseSetup() { var h = document.getElementById('mfaSetupModal'); if (h) h.innerHTML = ''; }
window._mfaCloseSetup = _mfaCloseSetup;

function _mfaBeginEnroll(token, shell, onDone, onCancel) {
  shell('<div style="color:var(--muted);font-size:13px;">Generating your code…</div>');
  var friendly = (window.HOUSING_SESSION && HOUSING_SESSION.email) || ('Staff-' + Date.now());
  fetch(SUPABASE_URL + '/auth/v1/factors', {
    method: 'POST', headers: _mfaHeaders(token),
    body: JSON.stringify({ factor_type: 'totp', friendly_name: friendly })
  }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, d: d }; }); })
    .then(function (res) {
      if (!res.ok || !res.d || !res.d.id || !res.d.totp) {
        var em = (res.d && (res.d.msg || res.d.error_description || res.d.error)) || 'Could not start enrollment. Make sure MFA is enabled for this nation.';
        shell('<div style="color:var(--danger);font-size:13px;">' + _mfaEsc(em) + '</div>');
        return;
      }
      var factorId = res.d.id, totp = res.d.totp || {};
      var qr = String(totp.qr_code || '');
      var qrHtml = qr.indexOf('data:') === 0
        ? '<img src="' + _mfaEsc(qr) + '" alt="QR code" style="width:180px;height:180px;background:var(--white,#fff);border-radius:8px;padding:6px;"/>'
        : (qr.indexOf('<svg') !== -1
            ? '<div style="width:180px;height:180px;background:var(--white,#fff);border-radius:8px;padding:6px;box-sizing:border-box;">' + qr + '</div>'
            : '');
      shell(
        '<div style="font-size:13px;color:var(--muted);line-height:1.5;margin-bottom:12px;">Scan this with your authenticator app, then enter the 6-digit code it shows.</div>'
        + '<div style="display:flex;justify-content:center;margin-bottom:10px;">' + qrHtml + '</div>'
        + (totp.secret ? '<div style="font-size:11px;color:var(--muted);text-align:center;margin-bottom:14px;">Or enter this key manually:<br><code style="font-size:12px;color:var(--text);word-break:break-all;">' + _mfaEsc(totp.secret) + '</code></div>' : '')
        + '<input id="_mfaEnrollCode" type="text" inputmode="numeric" maxlength="6" placeholder="123456" style="width:100%;box-sizing:border-box;padding:12px;font-size:18px;letter-spacing:4px;text-align:center;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);"/>'
        + '<div id="_mfaEnrollMsg" style="min-height:16px;font-size:12px;color:var(--danger);margin-top:8px;"></div>'
        + '<div style="display:flex;gap:8px;margin-top:12px;">'
        +   '<button type="button" id="_mfaEnrollCancel" class="btn btn-ghost" style="flex:1;">Cancel</button>'
        +   '<button type="button" id="_mfaEnrollVerify" class="btn btn-primary" style="flex:1;">Verify &amp; turn on</button>'
        + '</div>'
      );
      var inp = document.getElementById('_mfaEnrollCode');
      var msg = document.getElementById('_mfaEnrollMsg');
      var vb = document.getElementById('_mfaEnrollVerify');
      var cb = document.getElementById('_mfaEnrollCancel');
      if (inp) inp.focus();
      async function verify() {
        var code = (inp && inp.value || '').trim();
        if (code.length < 6) { if (msg) msg.textContent = 'Enter all 6 digits.'; return; }
        if (vb) { vb.disabled = true; vb.textContent = 'Verifying…'; }
        if (msg) msg.textContent = '';
        try {
          var newSession = await _mfaChallengeVerify(token, factorId, code);
          // Apply the fresh AAL2 session so the current tab is now fully signed in.
          if (typeof _applyTokenPayload === 'function' && newSession && newSession.access_token) _applyTokenPayload(newSession);
          if (typeof showToast === 'function') showToast('Two-factor authentication is on.', { type: 'info' });
          if (typeof onDone === 'function') onDone(newSession); else openMfaSetup();
        } catch (e) {
          if (msg) msg.textContent = (e && e.message) || 'That code was not valid.';
          if (vb) { vb.disabled = false; vb.textContent = 'Verify & turn on'; }
          if (inp) { inp.value = ''; inp.focus(); }
        }
      }
      if (vb) vb.addEventListener('click', verify);
      if (cb) cb.addEventListener('click', function () { _mfaUnenroll(token, factorId).then(typeof onCancel === 'function' ? onCancel : openMfaSetup); });
      if (inp) inp.addEventListener('keydown', function (/** @type {KeyboardEvent} */ e) { if (e.key === 'Enter') verify(); });
    })
    .catch(function (e) { shell('<div style="color:var(--danger);font-size:13px;">Enrollment failed: ' + _mfaEsc(e && e.message) + '</div>'); });
}

// Text-message (SMS) enrollment. Needs the Phone sign-in provider + an SMS
// provider configured in the nation's Supabase project; otherwise the enroll
// call errors and the message says so. Flow: enroll phone factor -> challenge
// (sends the SMS) -> verify the texted code -> factor becomes verified.
function _mfaBeginEnrollPhone(token, shell, onDone, onCancel) {
  shell(
    '<div style="font-size:13px;color:var(--muted);line-height:1.5;margin-bottom:12px;">Enter your mobile number in full international format, then we will text you a code to confirm it.</div>'
    + '<input id="_mfaPhoneInput" type="tel" inputmode="tel" autocomplete="tel" placeholder="+1 705 555 1234" style="width:100%;box-sizing:border-box;padding:12px;font-size:16px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);"/>'
    + '<div id="_mfaPhoneMsg" style="min-height:16px;font-size:12px;color:var(--danger);margin-top:8px;"></div>'
    + '<div style="display:flex;gap:8px;margin-top:12px;">'
    +   '<button type="button" id="_mfaPhoneCancel" class="btn btn-ghost" style="flex:1;">Cancel</button>'
    +   '<button type="button" id="_mfaPhoneSend" class="btn btn-primary" style="flex:1;">Text me a code</button>'
    + '</div>'
  );
  var inp = document.getElementById('_mfaPhoneInput');
  var msg = document.getElementById('_mfaPhoneMsg');
  var sb = document.getElementById('_mfaPhoneSend');
  var cb = document.getElementById('_mfaPhoneCancel');
  if (inp) inp.focus();
  if (cb) cb.addEventListener('click', function () { (typeof onCancel === 'function' ? onCancel : openMfaSetup)(); });
  async function send() {
    var phone = (inp && inp.value || '').replace(/[^\d+]/g, '');
    if (phone.length < 8) { if (msg) msg.textContent = 'Enter your full mobile number, including the country code.'; return; }
    if (sb) { sb.disabled = true; sb.textContent = 'Sending…'; }
    if (msg) msg.textContent = '';
    try {
      var er = await fetch(SUPABASE_URL + '/auth/v1/factors', {
        method: 'POST', headers: _mfaHeaders(token),
        body: JSON.stringify({ factor_type: 'phone', phone: phone, friendly_name: (window.HOUSING_SESSION && HOUSING_SESSION.email) || phone })
      });
      var ed = await er.json().catch(function () { return {}; });
      if (!er.ok || !ed.id) throw new Error((ed && (ed.msg || ed.error_description || ed.error)) || 'Could not start enrollment. Make sure text-message two-factor is enabled for your nation.');
      var factorId = ed.id;
      var challengeId = await _mfaChallenge(token, factorId);   // triggers the SMS
      _mfaEnrollPhoneVerifyStep(token, shell, factorId, challengeId, phone, onDone, onCancel);
    } catch (e) {
      if (msg) msg.textContent = (e && e.message) || 'Could not send the code.';
      if (sb) { sb.disabled = false; sb.textContent = 'Text me a code'; }
    }
  }
  if (sb) sb.addEventListener('click', send);
  if (inp) inp.addEventListener('keydown', function (/** @type {KeyboardEvent} */ e) { if (e.key === 'Enter') send(); });
}

function _mfaEnrollPhoneVerifyStep(token, shell, factorId, challengeId, phone, onDone, onCancel) {
  shell(
    '<div style="font-size:13px;color:var(--muted);line-height:1.5;margin-bottom:12px;">Enter the 6-digit code we texted to ' + _mfaEsc(phone) + '.</div>'
    + '<input id="_mfaPEnrollCode" type="text" inputmode="numeric" maxlength="6" placeholder="123456" style="width:100%;box-sizing:border-box;padding:12px;font-size:18px;letter-spacing:4px;text-align:center;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);"/>'
    + '<div id="_mfaPEnrollMsg" style="min-height:16px;font-size:12px;color:var(--danger);margin-top:8px;"></div>'
    + '<div style="display:flex;gap:8px;margin-top:12px;">'
    +   '<button type="button" id="_mfaPEnrollCancel" class="btn btn-ghost" style="flex:1;">Cancel</button>'
    +   '<button type="button" id="_mfaPEnrollVerify" class="btn btn-primary" style="flex:1;">Verify &amp; turn on</button>'
    + '</div>'
  );
  var inp = document.getElementById('_mfaPEnrollCode');
  var msg = document.getElementById('_mfaPEnrollMsg');
  var vb = document.getElementById('_mfaPEnrollVerify');
  var cb = document.getElementById('_mfaPEnrollCancel');
  if (inp) inp.focus();
  if (cb) cb.addEventListener('click', function () { _mfaUnenroll(token, factorId).then(typeof onCancel === 'function' ? onCancel : openMfaSetup); });
  async function verify() {
    var code = (inp && inp.value || '').trim();
    if (code.length < 6) { if (msg) msg.textContent = 'Enter all 6 digits.'; return; }
    if (vb) { vb.disabled = true; vb.textContent = 'Verifying…'; }
    if (msg) msg.textContent = '';
    try {
      var newSession = await _mfaVerify(token, factorId, challengeId, code);
      if (typeof _applyTokenPayload === 'function' && newSession && newSession.access_token) _applyTokenPayload(newSession);
      if (typeof showToast === 'function') showToast('Two-factor authentication is on.', { type: 'info' });
      if (typeof onDone === 'function') onDone(newSession); else openMfaSetup();
    } catch (e) {
      if (msg) msg.textContent = (e && e.message) || 'That code was not valid.';
      if (vb) { vb.disabled = false; vb.textContent = 'Verify & turn on'; }
      if (inp) { inp.value = ''; inp.focus(); }
    }
  }
  if (vb) vb.addEventListener('click', verify);
  if (inp) inp.addEventListener('keydown', function (/** @type {KeyboardEvent} */ e) { if (e.key === 'Enter') verify(); });
}

// -- Login enforcement (Stage 4) ----------------------------------------------
// After the role is known at sign-in, require the role's configured 2FA method
// if the staff member has not already satisfied it. Policy lives in
// housing_settings key 'mfa_policy' ({ role: 'none'|'any'|'totp'|'sms' }); a role
// defaults to 'none' (not required), so NOTHING is enforced until the ED sets it.
// Returns { ok:true } (nothing to do / already satisfied / just enrolled) with an
// optional AAL2 `session`, or { ok:false } if the user cancels (abort sign-in).
// Fail-open on any policy-read error so a glitch never locks everyone out.
async function _mfaEnforceEnrollment(token, role) {
  if (!token || !role) return { ok: true };
  var required = 'none';
  try {
    var r = await _mfaFetch(SUPABASE_URL + '/rest/v1/housing_settings?key=eq.mfa_policy&select=value', { headers: _mfaHeaders(token) }, 8000);
    if (!r.ok) return { ok: true };
    var rows = await r.json().catch(function () { return []; });
    var pol = (rows && rows[0] && rows[0].value) || {};
    required = pol[role] || 'none';
  } catch (e) { return { ok: true }; }
  if (required === 'none') return { ok: true };

  // Read the user's verified factors — but if we CANNOT read them (network
  // error/timeout), fail OPEN: let the user in rather than freezing sign-in, or
  // wrongly forcing re-enrollment on someone who is in fact already enrolled.
  var factors;
  try {
    var ur = await _mfaFetch(SUPABASE_URL + '/auth/v1/user', { headers: _mfaHeaders(token) }, 8000);
    if (!ur.ok) return { ok: true };
    var udata = await ur.json();
    factors = ((udata && udata.factors) || []).filter(function (f) {
      return f && (f.factor_type === 'totp' || f.factor_type === 'phone') && f.status === 'verified';
    });
  } catch (e) { return { ok: true }; }
  var hasTotp  = factors.some(function (f) { return f.factor_type === 'totp'; });
  var hasPhone = factors.some(function (f) { return f.factor_type === 'phone'; });
  var satisfied = (required === 'any')  ? (hasTotp || hasPhone)
                : (required === 'totp') ? hasTotp
                : (required === 'sms')  ? hasPhone
                : true;
  if (satisfied) return { ok: true };   // already enrolled; the step-up already ran

  return _mfaForceEnrollModal(token, required);
}
window._mfaEnforceEnrollment = _mfaEnforceEnrollment;

// Blocking, self-positioning enrollment modal shown at sign-in when the role
// requires a method the user has not set up. Resolves { ok:true, session } once
// they enroll (AAL2), or { ok:false } if they cancel. Uses `.mfa-code-overlay`
// so it works on the login page (which does not load housing.css).
function _mfaForceEnrollModal(token, method) {
  return new Promise(function (resolve) {
    var ov = document.createElement('div');
    ov.id = '_mfaForceOverlay';
    ov.className = 'modal-overlay mfa-code-overlay';
    ov.setAttribute('style', 'z-index:100000;');
    ov.innerHTML =
      '<div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;width:100%;max-width:440px;max-height:92vh;overflow:auto;padding:22px;">'
      + '<div style="font-size:16px;font-weight:700;color:var(--text);margin-bottom:6px;">&#128274; Two-factor authentication required</div>'
      + '<div id="_mfaForceBody"></div></div>';
    document.body.appendChild(ov);
    var card = ov.querySelector('#_mfaForceBody');
    function shell(html) { if (card) card.innerHTML = html; }
    function onDone(session) { try { ov.remove(); } catch (e) {} resolve({ ok: true, session: session }); }
    function onCancel() { try { ov.remove(); } catch (e) {} resolve({ ok: false }); }
    var intro = 'Your role requires two-factor authentication to sign in. Set it up now to continue.';
    if (method === 'totp') {
      shell('<div style="font-size:13px;color:var(--muted);line-height:1.5;margin-bottom:12px;">' + intro + '</div>');
      _mfaBeginEnroll(token, shell, onDone, onCancel);
    } else if (method === 'sms') {
      shell('<div style="font-size:13px;color:var(--muted);line-height:1.5;margin-bottom:12px;">' + intro + '</div>');
      _mfaBeginEnrollPhone(token, shell, onDone, onCancel);
    } else {
      shell(
        '<div style="font-size:13px;color:var(--muted);line-height:1.5;margin-bottom:14px;">' + intro + ' Choose how you want to receive your code:</div>'
        + '<button type="button" id="_mfaForceTotp" class="btn btn-primary" style="width:100%;margin-bottom:8px;">Use an authenticator app</button>'
        + '<button type="button" id="_mfaForcePhone" class="btn btn-ghost" style="width:100%;margin-bottom:8px;">Use text messages (SMS)</button>'
        + '<button type="button" id="_mfaForceCancel" class="btn btn-ghost" style="width:100%;color:var(--danger);border-color:var(--danger);">Cancel sign-in</button>'
      );
      var bt = card.querySelector('#_mfaForceTotp');
      var bp = card.querySelector('#_mfaForcePhone');
      var bc = card.querySelector('#_mfaForceCancel');
      if (bt) bt.addEventListener('click', function () { shell('<div style="color:var(--muted);font-size:13px;">Preparing your code&hellip;</div>'); _mfaBeginEnroll(token, shell, onDone, onCancel); });
      if (bp) bp.addEventListener('click', function () { shell(''); _mfaBeginEnrollPhone(token, shell, onDone, onCancel); });
      if (bc) bc.addEventListener('click', onCancel);
    }
  });
}
