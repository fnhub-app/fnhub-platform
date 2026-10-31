// ============================================================================
// contractor-portal.js — Contractor Portal B1 proof surface.
//
// Minimal, self-contained. SMS one-time-code login via Supabase phone auth
// (Twilio Verify), then a read-only "My Work Orders" list from the RLS-scoped
// contractor_work_orders projection. Loads only the shared CONFIG layer
// (SUPABASE_URL/ANON + nation branding) — never the staff bundle.
//
// The data boundary is enforced by Postgres RLS, not by this file: a contractor
// only ever receives their own rows regardless of what this code requests.
// ============================================================================
(function () {
  'use strict';

  function el(id) { return document.getElementById(id); }
  function show(id) { var e = el(id); if (e) e.classList.remove('hidden'); }
  function hide(id) { var e = el(id); if (e) e.classList.add('hidden'); }
  function setMsg(m, isErr) {
    var e = el('cp_msg'); if (!e) return;
    e.textContent = m || '';
    e.className = isErr ? 'cp-msg cp-err' : 'cp-msg';
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c];
    });
  }

  // Local E.164 normalizer (the portal does not load shared-data.js). NA-first:
  // 10 digits -> +1…, 11 starting with 1 -> +…, else digits-only with a '+'.
  function e164(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (/^\+[1-9]\d{7,14}$/.test(s)) return s;
    var d = s.replace(/[^\d]/g, '');
    if (d.length === 10) return '+1' + d;
    if (d.length === 11 && d.charAt(0) === '1') return '+' + d;
    if (d.length >= 8 && d.length <= 15) return '+' + d;
    return '';
  }

  var SB = window.SUPABASE_URL;
  var ANON = window.SUPABASE_ANON;
  var session = null;

  async function requestCode() {
    var phone = e164(el('cp_phone').value);
    if (!phone) { setMsg('Enter a valid mobile number.', true); return; }
    setMsg('Sending code…');
    try {
      var r = await fetch(SB + '/auth/v1/otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': ANON },
        body: JSON.stringify({ phone: phone })
      });
      if (!r.ok) {
        var d = await r.json().catch(function () { return {}; });
        throw new Error(d.msg || d.error_description || d.error || ('HTTP ' + r.status));
      }
      el('cp_phone_sent').textContent = phone;
      hide('cp_step_phone'); show('cp_step_code'); setMsg('');
    } catch (err) { setMsg('Could not send a code: ' + err.message, true); }
  }

  async function verifyCode() {
    var phone = e164(el('cp_phone').value);
    var token = (el('cp_code').value || '').trim();
    if (!token) { setMsg('Enter the code from the text.', true); return; }
    setMsg('Verifying…');
    try {
      var r = await fetch(SB + '/auth/v1/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': ANON },
        body: JSON.stringify({ phone: phone, token: token, type: 'sms' })
      });
      var d = await r.json();
      if (!r.ok || !d.access_token) {
        throw new Error(d.msg || d.error_description || d.error || ('HTTP ' + r.status));
      }
      session = d;
      await claimAndLoad();
    } catch (err) { setMsg('Verification failed: ' + err.message, true); }
  }

  async function claimAndLoad() {
    setMsg('Signing you in…');
    // Link this login to a contractor (invite/claim). The Edge Function creates
    // the mapping only when an invite matches AND the phone is on the
    // contractor's record; otherwise there is simply no access (empty).
    try {
      var cr = await fetch(SB + '/functions/v1/contractor-claim', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': ANON,
          'Authorization': 'Bearer ' + session.access_token
        },
        body: '{}'
      });
      var cd = await cr.json().catch(function () { return {}; });
      if (!cr.ok || !cd.linked) { hide('cp_login'); show('cp_notlinked'); return; }
    } catch (e) { hide('cp_login'); show('cp_notlinked'); return; }
    await loadWorkOrders();
  }

  async function loadWorkOrders() {
    try {
      var r = await fetch(SB + '/rest/v1/contractor_work_orders?select=*&order=updated_at.desc', {
        headers: { 'apikey': ANON, 'Authorization': 'Bearer ' + session.access_token }
      });
      var rows = await r.json();
      renderWorkOrders(Array.isArray(rows) ? rows : []);
      hide('cp_login'); show('cp_app');
    } catch (e) { setMsg('Could not load your work orders: ' + e.message, true); }
  }

  function bucket(rows, status) {
    return rows.filter(function (x) { return (x.status || 'active') === status; });
  }
  function renderWorkOrders(rows) {
    el('cp_count').textContent = rows.length + (rows.length === 1 ? ' work order' : ' work orders');
    function section(title, list) {
      if (!list.length) return '';
      return '<h3 class="cp-h3">' + title + ' (' + list.length + ')</h3>' + list.map(function (w) {
        return '<div class="cp-wo"><div class="cp-wo-addr">' + esc(w.address || w.sow_unit_id || '') + '</div>'
             + '<div class="cp-wo-meta">#' + esc(w.sow_project_number || '') + '</div></div>';
      }).join('');
    }
    var html = section('Active', bucket(rows, 'active'))
             + section('In process', bucket(rows, 'in_process'))
             + section('Closed', bucket(rows, 'closed'));
    el('cp_list').innerHTML = html || '<div class="cp-empty">No work orders assigned to you yet.</div>';
  }

  function init() {
    if (!SB || !ANON) { setMsg('Portal is not configured for this nation.', true); return; }
    var s = el('cp_send'); if (s) s.addEventListener('click', requestCode);
    var v = el('cp_verify'); if (v) v.addEventListener('click', verifyCode);
    var b = el('cp_back'); if (b) b.addEventListener('click', function () {
      hide('cp_step_code'); show('cp_step_phone'); setMsg('');
    });
    try {
      var nc = window.NATION_CONFIG || {};
      el('cp_brand').textContent = (nc.display_name || nc.short || 'Housing') + ' — Contractor Portal';
    } catch (e) { /* keep default brand */ }
  }

  if (document.readyState !== 'loading') init();
  else document.addEventListener('DOMContentLoaded', init);
})();
