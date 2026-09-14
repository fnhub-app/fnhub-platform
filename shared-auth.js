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
