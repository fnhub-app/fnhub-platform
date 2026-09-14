# React/TypeScript migration — cross-cutting regression baseline (Phase RX0)

This is the **guardrail baseline** for Phase RX in `PLAN.md`. It records how the
fragile, easy-to-break cross-cutting behaviors work **today** (vanilla JS, pre-any
framework). After **every** RX phase, re-run the "How to verify" steps below and
confirm the behavior is unchanged. These behaviors are correct in production now,
so any drift they show after a phase is a regression introduced by that phase.

> Scope note: RX changes are **front-end only**. Edge functions, SQL, RLS, and the
> Supabase schema are out of scope and must not be touched by any RX phase. The
> Supabase raw-`fetch` data layer (`shared-data.js`) is **wrapped, not rewritten** —
> React reads/writes through the existing `sb*` functions.

Baseline captured: 2026-09-14, from the code as of this commit.

---

## 1. Idle auto-logout
- **Code:** `_idleLogout()` in `shared-auth.js`; timer armed with `window.IDLE_TIMEOUT_MS` (default **15 min**, line ~449).
- **Behavior:** on idle timeout it clears `sessionStorage` tokens **synchronously first**, fires `doLogout()` as a detached async (fire-and-forget), then redirects to `index.html?timeout=1` **synchronously — never awaiting any network call** (awaiting was the old blank-page bug). `auth-login.js` reads `?timeout=1` and shows `#timeout-banner`.
- **How to verify:** sign in, leave the tab idle past the timeout (or temporarily lower `IDLE_TIMEOUT_MS` in the console), confirm it lands on the login screen with the timeout banner and **no blank page / no hang**.
- **Regression risk in RX:** a router or auth-context that awaits sign-out before navigating reintroduces the blank page.

## 2. Session-expiry 401 interceptor
- **Code:** `_handleSessionExpired()` + the global `fetch` interceptor (guarded by `window._authFetchWrapped`) in `shared-auth.js`.
- **Behavior:** on a **401** from a Supabase REST/Storage/Edge call (skips `/auth/v1/`; only fires when `HOUSING_SESSION.accessToken` exists) it attempts **one** `refreshHousingToken()`; success self-heals silently, failure runs the same safe teardown as idle logout (sync token clear → detached sign-out → immediate `index.html?timeout=1`, never awaiting network). PostgREST returns **403** (not 401) for RLS denials, so this must **not** fire on 403. Slow-connection save timeouts are deliberately left to the offline queue (see §4).
- **How to verify:** with a dead/expired token, trigger a Supabase read → should redirect to login once (after one refresh attempt), not loop. Confirm a 403 (permission denial) does **not** redirect.
- **Regression risk in RX:** if React swaps `window.fetch` or introduces its own client, the interceptor may be bypassed or double-wrapped. Keep the data layer going through the wrapped `fetch`.

## 3. Service worker / PWA (offline app shell)
- **Code:** `navigator.serviceWorker.register('sw.js')` in `shared.js` (~line 436); `CACHE` name + strategy in `sw.js`.
- **Behavior:** network-first for our own files, cache-first for the immutable CDN libs, Supabase never cached. Device must load the app **online once** to populate the cache. Bumping `CACHE` in `sw.js` forces every client to drop the old cache.
- **How to verify:** load the app online once, then go offline (DevTools → Offline) and reload → app shell still opens; PDF/chart generation still works offline.
- **Regression risk in RX:** a build step changes filenames/paths; `sw.js` precache list and CSP in `_headers` must be updated in lockstep, and `CACHE` bumped, or clients serve stale/broken assets.

## 4. Degraded mode / save timeout (flaky connections)
- **Code:** `_withSaveTimeout()` (`_SAVE_TIMEOUT_MS = 10000`), `_enterDegradedMode()`, `_runDegradedProbe()`, `saveQueueAdd()` in `shared-data.js`; `_DEGRADED_COOLDOWN_MS` = 30 s.
- **Behavior:** every save promise has a hard 10 s timeout. A timeout while `navigator.onLine === true` enters degraded mode (30 s cooldown), queues saves locally, toasts "Slow connection — saving locally…". During cooldown saves skip the network and queue. A HEAD probe after cooldown exits degraded mode and flushes; the browser `online` event clears it immediately and syncs.
- **How to verify:** throttle the network so a save exceeds 10 s → confirm the "saving locally" toast, that the edit isn't lost, and that it syncs when the connection returns / on `online`.
- **Regression risk in RX:** if React writes bypass `_dispatchSave`/`_withSaveTimeout`, offline field saves silently lose the timeout+queue safety net.

## 5. Offline file upload queue
- **Code:** `uploadFileResilient(path, blob, meta)` + `flushOfflineFiles()` in `shared.js` (IndexedDB store `clfn_offline_files`); flushes on `online`, on load (+3 s), and on degraded-mode recovery. Wired into the TIC lease/agreement generator.
- **Behavior:** stashes the blob + `file_uploaded` audit metadata when offline/degraded/on-failure; flushes when back online. Drop-in for the `sbUploadFile` + `sbSaveFileMeta` pair.
- **How to verify:** offline, generate a TIC agreement PDF (an uploader wired to `uploadFileResilient`) → it queues; go online → it flushes and the file appears in the Documents tab.
- **Regression risk in RX:** a React uploader that calls `sbUploadFile` directly (not `uploadFileResilient`) loses offline resilience.

## 6. Session login audit row
- **Code:** `_recordSessionLogin()` in `shared-auth.js` — writes one `housing_audit_log` row (`action:'user_login'`) once per browser session.
- **How to verify:** sign in fresh → exactly one `user_login` audit row for the session (used by the AI "who was active" reports).
- **Regression risk in RX:** a re-mount/route change that re-runs boot could double-write or skip it; keep it once-per-session.

## 7. Auth state across page loads (only while pages are still multi-page)
- **Code:** `HOUSING_SESSION` stashed in `sessionStorage`; sub-pages rehydrate it; `resolveHousingRole()` resolves role from the `staff` table on boot.
- **How to verify:** sign in on `housing.html`, navigate to a sub-page → still signed in, correct role, `_viewAsRole`/`_realRole` intact for ED.
- **Regression risk in RX:** once a phase converts a cluster to an in-memory SPA (RX4), the hand-off boundary between static pages and the SPA must preserve `HOUSING_SESSION`.

---

## Standing per-phase regression checklist (run after RX1..RX6)
- [ ] §1 Idle logout still redirects cleanly (no blank page)
- [ ] §2 401 → one refresh → login; 403 does **not** redirect
- [ ] §3 App shell opens offline after one online load
- [ ] §4 Save timeout → "saving locally" → syncs on reconnect
- [ ] §5 Offline-generated file queues and flushes online
- [ ] §6 Exactly one `user_login` audit row per session
- [ ] §7 Auth/role preserved across the static↔SPA boundary
- [ ] Color guard passes (`node tools/check-colors.js`)
- [ ] No console errors on boot of every affected page
- [ ] OCAP: no new outbound host in the diff (check CSP in `_headers`)
