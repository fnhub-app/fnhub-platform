/* ============================================================
 * auth-login.js — CLFN Housing Suite
 * Login screen behaviour: panel switching, sign-in flow, password
 * reset / email verification, "remember me" persistence. After a
 * successful sign-in, control hands off to housing.html via a
 * redirect — that's where the business app lives, the data cache
 * is hydrated, and the post-login views render. Keeping the
 * unauthenticated entry page (index.html) free of business code
 * is intentional for both security and bundle-size reasons.
 *
 * Loaded only by index.html.
 *
 * Load order: shared.js → shared-config.js → shared-auth.js →
 *             shared-ui.js → shared-data.js → THIS FILE
 * ============================================================ */

'use strict';

// Post-login destination. If a sub-page stashed a deep link before bouncing an
// unauthenticated user here (e.g. the Maintenance Request approval email ->
// renos.html?sow=...&action=approve), return to that exact request after
// sign-in instead of the default dashboard. Strictly validated to a same-origin
// relative app page (no scheme, no //, no ..) and expired after 30 minutes, so
// a stale or tampered value can never redirect off-site.
function _loginDest(){
  try {
    var raw = localStorage.getItem('clfn_login_return');
    localStorage.removeItem('clfn_login_return');
    if (raw) {
      var o = JSON.parse(raw);
      if (o && typeof o.u === 'string' && (Date.now() - (o.t || 0)) < 30 * 60 * 1000
          && /^[a-z0-9_-]+\.html(\?[^\s]*)?$/i.test(o.u)
          && o.u.indexOf('//') === -1 && o.u.indexOf('..') === -1) {
        return o.u;
      }
    }
  } catch(e) {}
  return 'housing.html?view=home';
}

// ── "Remember me" persistence (cookie + localStorage) ─────────────────────────
// Both mechanisms are written on save and read on load. Cookie is written
// with `path=/;SameSite=Lax` so it's reachable from any path the app uses
// (`/`, `/index.html`, etc.) and deleted with the SAME signature so the
// browser actually removes the original (a path mismatch on deletion silently
// creates a new orphan cookie instead of deleting the existing one).
var HOUSING_REMEMBER_KEY = 'clfn_housing_email';
function hSetCookie(name, value, days) {
  try {
    var exp = new Date(Date.now() + days * 864e5).toUTCString();
    document.cookie = name + '=' + encodeURIComponent(value) + ';expires=' + exp + ';path=/;SameSite=Lax';
  } catch(e) {}
}
function hGetCookie(name) {
  try {
    var m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  } catch(e) { return null; }
}
function hDeleteCookie(name) {
  // Delete with the SAME flags used on set (path + SameSite) so the browser
  // matches the original cookie. Without this, an "uncheck → sign in" cycle
  // leaves the cookie in place and the email is still remembered next visit.
  try { document.cookie = name + '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;SameSite=Lax'; } catch(e) {}
}

// loadRememberedEmail — pre-fills the email field and ticks the checkbox.
// Idempotent + safe to call multiple times. Called from the login boot AND
// from showSignInPanel() so navigating between sub-panels (forgot/verify)
// and back re-applies the saved value (some browsers wipe on hide/show).
function loadRememberedEmail() {
  try {
    var saved = null;
    try { saved = localStorage.getItem(HOUSING_REMEMBER_KEY); } catch(e) {}
    if (!saved) saved = hGetCookie(HOUSING_REMEMBER_KEY);

    var emailEl = document.getElementById('signin-email');
    var remEl   = document.getElementById('remember-me');
    if (saved) {
      if (emailEl && !emailEl.value) emailEl.value = saved;
      if (remEl) remEl.checked = true;
      // If the email is already filled (we have a remembered value), focus
      // the password field so the user can type immediately. The 150ms delay
      // lets the panel transition complete first.
      setTimeout(function(){
        var p = document.getElementById('signin-password');
        if (p && !p.value) p.focus();
      }, 150);
    } else {
      // No saved value — leave the checkbox at whatever state the user has
      // chosen. Do not force-uncheck here; that would surprise users who
      // ticked the box and haven't signed in yet.
    }
  } catch(e) {}
}

// saveRememberedEmail — writes (or clears) BOTH localStorage and cookie.
// Called from startSignIn() on successful auth. Defensive: if either store
// fails (private browsing, full quota, etc.) the other still persists.
function saveRememberedEmail(email, remember) {
  try {
    if (remember && email) {
      try { localStorage.setItem(HOUSING_REMEMBER_KEY, email); } catch(e) {}
      hSetCookie(HOUSING_REMEMBER_KEY, email, 365);
    } else {
      try { localStorage.removeItem(HOUSING_REMEMBER_KEY); } catch(e) {}
      hDeleteCookie(HOUSING_REMEMBER_KEY);
    }
  } catch(e) {}
}

// ── Login screen panel switchers ──────────────────────────────────────────────
function showSignInPanel() {
  var p = document.getElementById('signin-panel');
  var v = document.getElementById('verify-panel');
  var f = document.getElementById('forgot-panel');
  var r = document.getElementById('reset-panel');
  if (p) p.style.display = '';
  if (v) v.style.display = 'none';
  if (f) f.style.display = 'none';
  if (r) r.style.display = 'none';
  // Re-apply the remembered email when returning to the sign-in panel from
  // the verify / forgot-password / reset panels. Without this, navigating
  // Back from those panels leaves the email blank even though localStorage
  // has it.
  loadRememberedEmail();
}
function showForgotPassword() {
  var p = document.getElementById('signin-panel');
  var f = document.getElementById('forgot-panel');
  if (p) p.style.display = 'none';
  if (f) f.style.display = '';
}
function showLoginScreen() {
  var ls = document.getElementById('loginScreen');
  if (ls) { ls.style.display = 'flex'; }
  showSignInPanel();
  var p = document.getElementById('signin-password'); if (p) p.value = '';
  var e = document.getElementById('signin-error');    if (e) e.style.display = 'none';
}

// ── Email verification + password reset (Supabase auth endpoints) ─────────────
async function resendVerification() {
  var msgEl  = document.getElementById('verify-msg');
  var dispEl = document.getElementById('verify-email-display');
  var email  = dispEl ? (dispEl.textContent || '').trim() : '';
  if (!email) {
    if (msgEl) { msgEl.textContent = 'No email address on file. Please sign in again.'; msgEl.style.color = '#fca5a5'; msgEl.style.display = ''; }
    return;
  }
  if (msgEl) { msgEl.textContent = 'Sending…'; msgEl.style.color = 'var(--gray)'; msgEl.style.display = ''; }
  try {
    var r = await fetch(SUPABASE_URL + '/auth/v1/resend', {
      method:  'POST',
      headers: { 'apikey': SUPABASE_ANON, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ type: 'signup', email: email })
    });
    if (!r.ok) {
      var d; try { d = await r.json(); } catch(e) { d = {}; }
      throw new Error(d.error_description || d.msg || 'Could not resend verification email');
    }
    if (msgEl) { msgEl.textContent = 'Verification email resent. Check your inbox.'; msgEl.style.color = '#86efac'; }
  } catch(e) {
    if (msgEl) { msgEl.textContent = e.message || 'Failed to resend.'; msgEl.style.color = '#fca5a5'; }
  }
}

async function sendPasswordReset() {
  var inp   = document.getElementById('forgot-email');
  var msgEl = document.getElementById('forgot-msg');
  var email = inp ? (inp.value || '').trim() : '';
  if (!email) {
    if (msgEl) { msgEl.textContent = 'Enter your email address.'; msgEl.style.color = '#fca5a5'; msgEl.style.background = '#3b0a0a'; msgEl.style.display = ''; }
    return;
  }
  if (msgEl) { msgEl.textContent = 'Sending reset link…'; msgEl.style.color = 'var(--gray)'; msgEl.style.background = 'transparent'; msgEl.style.display = ''; }
  try {
    // redirect_to pins the email link to the page that actually knows how to
    // consume the recovery token (#reset-panel below). Without this, the link
    // falls back to whatever Site URL is configured in the Supabase dashboard,
    // which has drifted before and sent users to a dead page.
    // The redirect_to host must be in the dashboard's Redirect URLs allowlist.
    var redirectTo = window.location.origin + '/index.html';
    // Preferred path: the PUBLIC request-password-reset Edge Function, which
    // mints the recovery link server-side and emails it from the nation's own
    // mailbox (the /auth/v1/recover endpoint below depends on the Supabase
    // auth mailer, which this project doesn't configure — those emails never
    // arrived). Anti-enumeration is server-side: it answers ok either way.
    var viaFn = false;
    try {
      var _nc = window.NATION_CONFIG || {};
      var fr = await fetch(SUPABASE_URL + '/functions/v1/request-password-reset', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON, 'Authorization': 'Bearer ' + SUPABASE_ANON },
        body:    JSON.stringify({
          email: email,
          redirect_to: redirectTo,
          nation_name: _nc.display_name || _nc.short || '',
          brand_color: _nc.primary_color || ''
        })
      });
      if (fr.ok) {
        var fd = await fr.json().catch(function(){ return {}; });
        if (fd && fd.ok) viaFn = true;
      }
      // Not deployed yet (404), email unconfigured (503), or any other
      // not-ok answer: fall through to the legacy Supabase recover mailer.
    } catch(_fe) { /* function unreachable — legacy fallback below */ }
    if (!viaFn) {
      var r = await fetch(SUPABASE_URL + '/auth/v1/recover', {
        method:  'POST',
        headers: { 'apikey': SUPABASE_ANON, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email: email, redirect_to: redirectTo })
      });
      // Supabase rate-limits /auth/v1/recover per-email and per-IP. Surface
      // the throttle honestly — previously the UI showed a generic success
      // message on 429 too, which made the button look broken when really
      // the request was just being throttled.
      if (r.status === 429) {
        if (msgEl) { msgEl.textContent = 'Too many reset attempts. Please wait a few minutes and try again.'; msgEl.style.color = '#fca5a5'; msgEl.style.background = '#3b0a0a'; msgEl.style.display = ''; }
        return;
      }
      if (!r.ok) {
        if (msgEl) { msgEl.textContent = 'Could not send the reset link. Please try again.'; msgEl.style.color = '#fca5a5'; msgEl.style.background = '#3b0a0a'; msgEl.style.display = ''; }
        return;
      }
    }
    // 200 path: Supabase returns 200 whether or not the email is registered
    // (anti-enumeration). Keep the generic "if registered" wording here.
    if (msgEl) { msgEl.textContent = 'If that email is registered, a reset link has been sent. Check your inbox.'; msgEl.style.color = '#86efac'; msgEl.style.background = 'rgba(22,101,52,0.2)'; }
  } catch(e) {
    console.warn('[FORGOT PWD]', e);
    if (msgEl) { msgEl.textContent = 'Request could not be completed. Please try again.'; msgEl.style.color = '#fca5a5'; msgEl.style.background = '#3b0a0a'; }
  }
}

// ── Recovery flow ─────────────────────────────────────────────────────────────
// When a user clicks the reset link in their email, Supabase appends a
// fragment like `#access_token=...&refresh_token=...&type=recovery&expires_in=...`
// to the redirect target and loads this page. _parseRecoveryHash extracts the
// values; initLoginPage routes into showResetPasswordPanel; submitNewPassword
// PUTs the new password using the recovery access_token as a bearer.
//
// Security notes:
//   • URL fragments are NEVER sent to servers, so the token stays client-side.
//   • Recovery tokens are short-lived (Supabase default ~1h) and one-time use.
//   • We history.replaceState() to strip the fragment as soon as we read it,
//     so the token doesn't sit in browser history or get pasted accidentally.
//   • The token is held only in window._recoveryToken (memory, this tab) —
//     never stored to localStorage / sessionStorage / cookies.
//   • Failed attempts don't reveal whether the email exists.
function _parseRecoveryHash() {
  var hash = (window.location.hash || '').replace(/^#/, '');
  if (!hash) return null;
  var params = {};
  hash.split('&').forEach(function(kv){
    var eq = kv.indexOf('=');
    if (eq < 0) return;
    params[decodeURIComponent(kv.slice(0, eq))] = decodeURIComponent(kv.slice(eq + 1));
  });
  if (params.type !== 'recovery' || !params.access_token) return null;
  return params;
}

// Generic auth-hash parser (any Supabase email link that returns a session in
// the URL fragment: magic link, email confirmation). Returns the params when an
// access_token is present, else null. Recovery is handled separately above.
function _parseAuthHash() {
  var hash = (window.location.hash || '').replace(/^#/, '');
  if (!hash) return null;
  var params = {};
  hash.split('&').forEach(function(kv){
    var eq = kv.indexOf('=');
    if (eq < 0) return;
    params[decodeURIComponent(kv.slice(0, eq))] = decodeURIComponent(kv.slice(eq + 1));
  });
  return params.access_token ? params : null;
}

// ── Magic-link (passwordless) sign-in ─────────────────────────────────────────
// Magic links are ISSUED FROM INSIDE THE APP by an authorized admin (Settings ->
// Users -> "Send Sign-in Link"), NOT self-requested from this login screen — so
// there is no public "email me a link" affordance. The emailed link returns to
// this page with the session tokens in the URL fragment; completeMagicLinkSignIn()
// picks them up and hard-gates on an ACTIVE staff row that is magic_link-enabled.
//
// Complete a magic-link return: strip the tokens from the URL, identify the
// user, confirm an ACTIVE staff row exists, apply the session, resolve role, and
// hand off. Rejects back to login if the link is invalid/expired or the email is
// not active staff.
async function completeMagicLinkSignIn(h) {
  var errEl = document.getElementById('signin-error');
  try {
    try { history.replaceState(null, '', window.location.pathname + window.location.search); } catch (e) {}

    var token = h.access_token;
    var ur = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { 'apikey': SUPABASE_ANON, 'Authorization': 'Bearer ' + token }
    });
    var user  = ur.ok ? await ur.json() : null;
    var email = (user && user.email || '').toLowerCase();
    if (!email) throw new Error('invalid-link');

    // HARD GATE: must be an ACTIVE staff row that is explicitly enabled for
    // magic-link sign-in. Mailbox possession alone is not enough, and regular
    // staff (magic_link=false, the default) are limited to password sign-in.
    var sr = await fetch(SUPABASE_URL + '/rest/v1/staff?select=*&is_active=eq.true&email=eq.' + encodeURIComponent(email), {
      headers: { 'apikey': SUPABASE_ANON, 'Authorization': 'Bearer ' + token }
    });
    var srows = sr.ok ? await sr.json() : [];
    if (!srows.length) throw new Error('not-staff');
    if (srows[0].magic_link !== true) throw new Error('password-only');

    if (typeof _applyTokenPayload === 'function') {
      _applyTokenPayload({ access_token: token, refresh_token: h.refresh_token, expires_in: parseInt(h.expires_in || '3600', 10) });
    } else {
      HOUSING_SESSION.accessToken = token;
      HOUSING_HEADERS['Authorization'] = 'Bearer ' + token;
      try { sessionStorage.setItem('clfn_housing_token', token); } catch (e) {}
    }
    HOUSING_SESSION.email = email;
    HOUSING_SESSION.name  = (user.user_metadata && user.user_metadata.full_name) || email;

    await resolveHousingRole();
    if (window._accessExpired) return;   // expired -> resolveHousingRole redirected
    _stampStaffLastLogin(email);
    try {
      sessionStorage.setItem('clfn_housing_role',          window.currentRole || '');
      sessionStorage.setItem('clfn_housing_name',          HOUSING_SESSION.name  || '');
      sessionStorage.setItem('clfn_housing_email_session', HOUSING_SESSION.email || '');
    } catch (e) {}

    window.location.href = _loginDest();
  } catch (e) {
    console.warn('[MAGIC LINK] completion failed:', e && e.message);
    try { sessionStorage.removeItem('clfn_housing_token'); } catch (ee) {}
    showLoginScreen();
    var msg = (e && e.message === 'password-only')
      ? 'This account signs in with a password. Please enter your email and password.'
      : 'That sign-in link is invalid or has expired. Request a new one.';
    if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; }
  }
}

function showResetPasswordPanel() {
  var p = document.getElementById('signin-panel');
  var v = document.getElementById('verify-panel');
  var f = document.getElementById('forgot-panel');
  var r = document.getElementById('reset-panel');
  if (p) p.style.display = 'none';
  if (v) v.style.display = 'none';
  if (f) f.style.display = 'none';
  if (r) r.style.display = '';
  // Make sure the login screen itself is visible (initLoginPage may have
  // bailed early before reaching showLoginScreen).
  var ls = document.getElementById('loginScreen');
  if (ls) ls.style.display = 'flex';
}

async function submitNewPassword() {
  var pw1El   = document.getElementById('reset-pw1');
  var pw2El   = document.getElementById('reset-pw2');
  var msgEl   = document.getElementById('reset-msg');
  var btn     = document.getElementById('reset-btn');
  var token   = window._recoveryToken || '';

  var pw1 = pw1El ? (pw1El.value || '') : '';
  var pw2 = pw2El ? (pw2El.value || '') : '';

  if (msgEl) msgEl.style.display = 'none';
  if (!token) {
    if (msgEl) { msgEl.textContent = 'Reset link is missing or expired. Please request a new one.'; msgEl.style.color = '#fca5a5'; msgEl.style.background = '#3b0a0a'; msgEl.style.display = ''; }
    return;
  }
  if (pw1.length < 8) {
    if (msgEl) { msgEl.textContent = 'Password must be at least 8 characters.'; msgEl.style.color = '#fca5a5'; msgEl.style.background = '#3b0a0a'; msgEl.style.display = ''; }
    return;
  }
  if (pw1 !== pw2) {
    if (msgEl) { msgEl.textContent = 'Passwords do not match.'; msgEl.style.color = '#fca5a5'; msgEl.style.background = '#3b0a0a'; msgEl.style.display = ''; }
    return;
  }

  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    var r = await fetch(SUPABASE_URL + '/auth/v1/user', {
      method:  'PUT',
      headers: {
        'apikey':        SUPABASE_ANON,
        'Authorization': 'Bearer ' + token,
        'Content-Type':  'application/json'
      },
      body: JSON.stringify({ password: pw1 })
    });
    var data; try { data = await r.json(); } catch(e) { data = {}; }
    if (!r.ok) {
      var msg = (data && (data.error_description || data.msg)) || 'Could not update password. The reset link may have expired.';
      throw new Error(msg);
    }

    // Password updated. The recovery access_token is now a full bearer for
    // this user — stash it and hand off to housing.html the same way
    // startSignIn does. This keeps the user from having to type their brand
    // new password immediately after setting it.
    var email = (data && data.email) || '';
    HOUSING_SESSION.email       = email;
    HOUSING_SESSION.name        = (data && data.user_metadata && data.user_metadata.full_name) || email;
    HOUSING_SESSION.accessToken = token;
    HOUSING_HEADERS['Authorization'] = 'Bearer ' + token;
    try { sessionStorage.setItem('clfn_housing_token', token); } catch(e) {}

    await resolveHousingRole();
    try {
      sessionStorage.setItem('clfn_housing_role',          window.currentRole || 'employee');
      sessionStorage.setItem('clfn_housing_name',          HOUSING_SESSION.name  || '');
      sessionStorage.setItem('clfn_housing_email_session', HOUSING_SESSION.email || '');
    } catch(e) {}

    // Reset is a sign-in event too — stamp last_login_at the same way the
    // regular password path does, so the Settings → Users table reflects
    // when a user came back via the recovery flow.
    _stampStaffLastLogin(email);

    // Clear the recovery token from memory and the URL.
    window._recoveryToken = null;
    try { history.replaceState(null, '', window.location.pathname + window.location.search); } catch(e) {}

    window.location.href = _loginDest();
  } catch(e) {
    console.warn('[RESET PWD]', e);
    if (msgEl) { msgEl.textContent = e.message || 'Could not update password.'; msgEl.style.color = '#fca5a5'; msgEl.style.background = '#3b0a0a'; msgEl.style.display = ''; }
    if (btn) { btn.disabled = false; btn.textContent = 'Save new password'; }
  }
}

// ── Sign-in flow ──────────────────────────────────────────────────────────────
// On success, save token + role to sessionStorage and redirect to housing.html.
// housing-init.js on that page reads the session, fetches the data caches,
// and renders the home view — keeping the unauthenticated entry page minimal.
async function startSignIn() {
  var email    = ((document.getElementById('signin-email')    || {}).value || '').trim().toLowerCase();
  var password = (document.getElementById('signin-password') || {}).value || '';
  var remember = (document.getElementById('remember-me')      || {}).checked || false;
  var errEl    = document.getElementById('signin-error');
  var btn      = document.getElementById('signin-btn');

  if (errEl) errEl.style.display = 'none';

  if (!email || !password) {
    if (errEl) { errEl.textContent = 'Please enter your email and password.'; errEl.style.display = 'block'; }
    return;
  }

  // Generic error for all auth failures — do not leak specifics (wrong domain,
  // invalid password, unverified email, missing user) to the unauthenticated
  // visitor. Real details stay in the console.
  var GENERIC_AUTH_ERROR = 'Sign-in failed. Please check your email and password.';

  // Silent domain prefilter: skip the network call for obviously-wrong emails.
  // Defensive read (no nationEmailDomain() call) in case config didn't load.
  // Only prefilter when THIS nation has a domain configured -- never fall back to
  // a hardcoded CLFN domain, which would both leak CLFN and lock out any other
  // nation's staff whose config has no email_domain (OCAP).
  var _rawDomain = (window.NATION_CONFIG && NATION_CONFIG.email_domain) || '';
  if (_rawDomain && !email.endsWith('@' + _rawDomain)) {
    if (errEl) { errEl.textContent = GENERIC_AUTH_ERROR; errEl.style.display = 'block'; }
    return;
  }

  if (btn) { btn.disabled = true; btn.textContent = 'Signing in…'; }
  try {
    var r = await fetch(SUPABASE_URL + '/auth/v1/token?grant_type=password', {
      method:  'POST',
      headers: HOUSING_HEADERS,
      body:    JSON.stringify({ email: email, password: password })
    });
    var data = await r.json();
    // When "Confirm email" is enabled on the Supabase project, the token
    // endpoint REJECTS sign-in for unverified users (non-ok response with
    // error_code === 'email_not_confirmed'). Without this branch the catch
    // block surfaces the generic "check your email and password" error,
    // making the user think the password is wrong. Detect the specific
    // case and route them to the verify panel instead.
    if (!r.ok) {
      var errCode = data && (data.error_code || data.code || '');
      var errBlob = ((data && (data.msg || data.error_description || data.error)) || '');
      var emailUnconfirmed = errCode === 'email_not_confirmed'
                          || /email\s+not\s+confirmed/i.test(errBlob)
                          || /confirm\s+your\s+email/i.test(errBlob);
      if (emailUnconfirmed) {
        var dispE = document.getElementById('verify-email-display');
        if (dispE) dispE.textContent = email;
        document.getElementById('signin-panel').style.display = 'none';
        document.getElementById('verify-panel').style.display = '';
        if (btn) { btn.disabled = false; btn.textContent = 'Sign in'; }
        return;
      }
      throw new Error(GENERIC_AUTH_ERROR);
    }

    // Email verification check for the success path — covers the case where
    // Supabase returns 200 but the user is still unverified (older project
    // setting). Same destination as the not-ok branch above.
    var emailConfirmed = data.user.email_confirmed_at || data.user.confirmed_at;
    if (!emailConfirmed) {
      var dispEl = document.getElementById('verify-email-display');
      if (dispEl) dispEl.textContent = email;
      document.getElementById('signin-panel').style.display = 'none';
      document.getElementById('verify-panel').style.display = '';
      if (btn) { btn.disabled = false; btn.textContent = 'Sign in'; }
      return;
    }

    // Save token + session globals (used by resolveHousingRole below)
    saveRememberedEmail(email, remember);
    HOUSING_SESSION.email       = email;
    HOUSING_SESSION.name        = (data.user.user_metadata && data.user.user_metadata.full_name) || email;
    // Store the access token AND the refresh token + expiry, so the session can
    // refresh itself before the access token expires (see shared-auth.js).
    if (typeof _applyTokenPayload === 'function') {
      _applyTokenPayload(data);
    } else {
      HOUSING_SESSION.accessToken = data.access_token;
      HOUSING_HEADERS['Authorization'] = 'Bearer ' + data.access_token;
      try { sessionStorage.setItem('clfn_housing_token', data.access_token); } catch(e) {}
    }

    // Resolve role from the staff table — this is the real authorization gate
    await resolveHousingRole();
    // resolveHousingRole redirects to the login page if access has expired; bail
    // here so we don't race it with the hand-off to housing.html.
    if (window._accessExpired) { if (btn) { btn.disabled = false; btn.textContent = 'Sign in'; } return; }

    // Stamp last_login_at on the staff row. Fire-and-forget — a slow PATCH
    // must not delay the redirect to housing.html. Relies on RLS allowing a
    // user to update their own staff row; if it doesn't, the warn lands in
    // the console and the rest of the sign-in continues normally.
    _stampStaffLastLogin(email);

    // Persist session info for module pages so they don't re-validate on navigation
    try {
      sessionStorage.setItem('clfn_housing_role',          window.currentRole || 'employee');
      sessionStorage.setItem('clfn_housing_name',          HOUSING_SESSION.name  || '');
      sessionStorage.setItem('clfn_housing_email_session', HOUSING_SESSION.email || '');
    } catch(e) {}

    // Hand off to the authenticated app — housing-init.js handles data load + home view render
    window.location.href = _loginDest();

  } catch(e) {
    console.error('[HOUSING LOGIN]', e);
    if (errEl) { errEl.textContent = GENERIC_AUTH_ERROR; errEl.style.display = 'block'; }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Sign in'; }
  }
}

// ── Last-login stamp ──────────────────────────────────────────────────────────
// Writes public.staff.last_login_at on every successful sign-in (regular and
// post-reset auto-sign-in). Used by Settings → Users to show when each staff
// member last opened the app. Fire-and-forget: the PATCH never blocks the
// redirect and a failure (e.g. RLS denies self-update) is logged-only.
//
// The staff row is identified by email. We don't have the staff.id at this
// point in the flow and looking it up would mean an extra round-trip, so we
// rely on email being unique in public.staff (which it is — there's a unique
// index there).
function _stampStaffLastLogin(email) {
  if (!email) return;
  var now = new Date().toISOString();
  try {
    // Try staff.last_login_at — may silently fail for employees if RLS blocks self-update
    fetch(SUPABASE_URL + '/rest/v1/staff?email=eq.' + encodeURIComponent(email), {
      method:  'PATCH',
      headers: Object.assign({}, HOUSING_HEADERS, { 'Prefer': 'return=minimal' }),
      body:    JSON.stringify({ last_login_at: now })
    }).catch(function(e){ console.warn('[LAST LOGIN] staff patch failed:', e); });
    // The "Signed In" audit row is written by _recordSessionLogin() (in
    // shared-auth.js), which resolveHousingRole() already invoked just before
    // this call. Centralizing it there means session *resumes* are captured
    // too — not only fresh credential sign-ins — without writing a duplicate.
  } catch (e) {
    console.warn('[LAST LOGIN] threw:', e);
  }
}

// ── Login page boot ──────────────────────────────────────────────────────────
// Used to live as an inline <script> in index.html. Moved here so index.html
// is just markup. Two responsibilities:
//   1. Hand off to housing.html if the user already has a session token in
//      sessionStorage (shared-auth.js on that page validates it; if stale,
//      the user gets bounced back here).
//   2. Otherwise show the sign-in screen with the remembered email pre-filled.
//
// `init` is named on the function so the registration is a no-op if the script
// is loaded by a page that doesn't have #loginScreen (e.g. the file is now
// pulled into other entry points).
function initLoginPage() {
  // Only act on pages that actually contain the login markup.
  if (!document.getElementById('loginScreen')) return;

  // Brand the login screen from the platform registry (per-nation colour + logo
  // set in the admin portal), resolved at boot into NATION_CONFIG. A nation's
  // own uploaded logo wins; CLFN's hardcoded mark is used ONLY for CLFN itself;
  // any other nation without a logo shows no mark rather than CLFN's.
  var logoEl = document.getElementById('login-logo');
  var _nc = window.NATION_CONFIG || {};
  if (logoEl) logoEl.src = _nc.logo || window.HLH_LOGO_DATA_URL || (typeof CLFN_LOGO_DATA_URL === 'string' ? CLFN_LOGO_DATA_URL : '');
  if (_nc.primary_color) {
    try { document.documentElement.style.setProperty('--yellow', _nc.primary_color); } catch (e) {}
    // Header / dark surfaces on the sign-in screen follow the brand colour too.
    try { if (typeof window._applyBrandDark === 'function') window._applyBrandDark(_nc.primary_color); } catch (e) {}
  }

  loadRememberedEmail();

  // Recovery flow takes precedence over both the stashed-session redirect
  // AND the regular sign-in panel. If the URL hash carries a Supabase
  // recovery token, the user needs to set a new password before doing
  // anything else — even if they happen to already be signed in in this
  // browser. Without this check, a signed-in user clicking a reset email
  // gets bounced straight to housing.html and the token is silently
  // discarded (this was half of the "reset loops back" symptom).
  var recovery = _parseRecoveryHash();
  if (recovery) {
    window._recoveryToken = recovery.access_token;
    showResetPasswordPanel();
    return;
  }

  // Magic-link return — session tokens arrive in the URL fragment. Handle this
  // before the stashed-session redirect so a magic link always takes effect,
  // even if this browser already has a (possibly stale) session.
  var authHash = _parseAuthHash();
  if (authHash) {
    completeMagicLinkSignIn(authHash);
    return;
  }
  // An expired / already-used link returns with an error fragment (no token).
  if ((window.location.hash || '').indexOf('error') !== -1) {
    try { history.replaceState(null, '', window.location.pathname + window.location.search); } catch (e) {}
    showLoginScreen();
    var e2 = document.getElementById('signin-error');
    if (e2) { e2.textContent = 'That sign-in link is invalid or has expired. Request a new one.'; e2.style.display = 'block'; }
    return;
  }

  // Restored session — hand off directly to housing.html.
  var token = null;
  try { token = sessionStorage.getItem('clfn_housing_token'); } catch(e) {}
  if (token) {
    window.location.href = _loginDest();
    return;
  }

  showLoginScreen();

  // Show session-timeout banner when redirected here by _idleLogout()
  try {
    var urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('timeout') === '1') {
      var banner = document.getElementById('timeout-banner');
      if (banner) banner.style.display = 'block';
      // Strip the param so a refresh doesn't keep showing the banner
      history.replaceState(null, '', window.location.pathname);
    }
    // Access-expired notice — redirected here by _denyExpiredAccess()
    if (urlParams.get('expired') === '1') {
      var expEl = document.getElementById('signin-error');
      if (expEl) { expEl.textContent = 'Your access has expired. Please contact the housing office.'; expEl.style.display = 'block'; }
      history.replaceState(null, '', window.location.pathname);
    }
  } catch(e) {}
}

document.addEventListener('DOMContentLoaded', initLoginPage);
