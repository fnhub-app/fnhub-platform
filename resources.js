// ============================================================================
// resources.js — Shareable, nation-branded one-page reference cards.
//
// A self-injecting full-screen modal (window.openResources()) that renders the
// Contractor Portal and Community/Tenant Portal fact sheets as printable one-
// page handouts, in the NATION'S OWN identity (logo + name + accent + contacts
// + portal URL), so any nation can print or Save-as-PDF and share them.
//
// NATION-NEUTRAL by design (the same hard rule as help-training.js): no nation
// name, logo, colour literal or URL is baked in. Branding is read at view time
// from NATION_CONFIG + the saved theme, and every colour is a theme token
// (var(--yellow)/--text/--border/--muted/--surface), so the file is colour-
// literal-free (tools/check-colors.js stays clean). The QR uses the app's
// existing qrcodejs (lazy-loaded from cdnjs, already CSP-allowlisted).
//
// Loaded app-wide (a <script> tag on every page that loads housing-init.js) and
// opened from the avatar menu "Shareable Resources" item.
// ============================================================================
(function () {
  'use strict';

  var CARDS = ['contractor', 'tenant'];
  var _current = 'contractor';

  function _nc() { return window.NATION_CONFIG || {}; }
  function _theme() { return (window._appSettings && window._appSettings.theme) || {}; }
  function _nationName() {
    var nc = _nc();
    return nc.display_name || nc.short || 'Housing';
  }
  function _logoSrc() {
    var t = _theme(), nc = _nc();
    return t.logo || nc.logo || '';
  }
  function _phone() { var nc = _nc(); return nc.phone || nc.contact_phone || ''; }
  function _email() { var nc = _nc(); return nc.email || nc.housing_email || ''; }
  function _origin() { return (window.location && window.location.origin) || ''; }
  function _contractorUrl() { return _origin() + '/contractor-portal.html'; }
  function _tenantUrl() {
    var nc = _nc();
    return (nc.portal_base || _origin()) + '/portal';
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c];
    });
  }

  // ── Styles (theme tokens only) ──────────────────────────────────────────────
  function _ensureStyles() {
    if (document.getElementById('resources_styles')) return;
    var css = ''
      + '#resourcesModal{position:fixed;inset:0;z-index:10080;background:var(--bg);overflow:auto;}'
      + '#resourcesModal .res-chrome{position:sticky;top:0;z-index:2;background:var(--surface);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 18px;}'
      + '#resourcesModal .res-title{font-size:15px;font-weight:700;color:var(--text);margin-right:auto;}'
      + '#resourcesModal .res-tabs{display:flex;gap:6px;}'
      + '#resourcesModal .res-tab{border:1px solid var(--border);background:var(--surface);color:var(--text);border-radius:999px;padding:6px 14px;font-size:12.5px;font-weight:700;cursor:pointer;font-family:inherit;}'
      + '#resourcesModal .res-tab.res-on{border-color:var(--yellow);box-shadow:inset 0 -3px 0 var(--yellow);}'
      + '#resourcesModal .res-stage{display:flex;justify-content:center;padding:20px 14px 48px;}'
      // The printable sheet
      + '#resourcesModal .sheet{width:820px;max-width:100%;background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:12px;padding:26px 30px 30px;font-family:\'Segoe UI\',system-ui,-apple-system,sans-serif;font-size:15px;line-height:1.5;}'
      + '#resourcesModal .masthead{display:flex;align-items:center;gap:18px;padding-bottom:13px;border-bottom:4px solid var(--yellow);}'
      + '#resourcesModal .masthead img{height:58px;width:auto;display:block;border-radius:8px;}'
      + '#resourcesModal .org{font-weight:800;color:var(--text);font-size:1.15rem;letter-spacing:.03em;line-height:1.15;text-transform:uppercase;}'
      + '#resourcesModal .doc-title{color:var(--muted);font-size:.95rem;margin-top:3px;}'
      + '#resourcesModal .lede{margin:16px 0 6px;font-size:1rem;color:var(--text);}'
      + '#resourcesModal .cta{display:inline-flex;align-items:center;gap:7px;margin:6px 0 2px;padding:5px 12px;border-radius:6px;background:var(--yellow);color:var(--text);font-weight:800;font-size:.86rem;text-decoration:none;word-break:break-all;}'
      + '#resourcesModal h2{font-weight:800;color:var(--text);font-size:1rem;text-transform:uppercase;letter-spacing:.04em;margin:20px 0 10px;padding-left:12px;border-left:4px solid var(--yellow);}'
      + '#resourcesModal .need{margin:0 0 11px;padding:8px 12px;border:1px solid var(--border);border-left:4px solid var(--yellow);border-radius:4px;font-size:.95rem;color:var(--text);}'
      + '#resourcesModal .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px 22px;}'
      + '#resourcesModal .thing h3{font-weight:800;font-size:.95rem;margin:0 0 2px;color:var(--text);}'
      + '#resourcesModal .thing p{margin:0;color:var(--muted);font-size:.9rem;}'
      + '#resourcesModal ol.steps{margin:0;padding:0;list-style:none;counter-reset:s;}'
      + '#resourcesModal ol.steps li{position:relative;padding:8px 0 8px 40px;counter-increment:s;border-bottom:1px solid var(--border);font-size:.96rem;}'
      + '#resourcesModal ol.steps li:last-child{border-bottom:0;}'
      + '#resourcesModal ol.steps li::before{content:counter(s);position:absolute;left:0;top:50%;transform:translateY(-50%);width:24px;height:24px;border:2px solid var(--text);border-radius:50%;font-weight:800;font-size:.84rem;display:flex;align-items:center;justify-content:center;color:var(--text);}'
      + '#resourcesModal .muted{color:var(--muted);}'
      + '#resourcesModal .callout{margin:16px 0 4px;padding:12px 16px;border:1px solid var(--border);border-left:5px solid var(--yellow);border-radius:4px;}'
      + '#resourcesModal .callout h3{font-weight:800;font-size:1rem;margin:0 0 5px;color:var(--text);}'
      + '#resourcesModal .callout p{margin:0;color:var(--text);font-size:.93rem;}'
      + '#resourcesModal .contact{display:flex;align-items:center;justify-content:space-between;gap:24px;margin-top:20px;padding-top:14px;border-top:3px solid var(--yellow);}'
      + '#resourcesModal .ci-label{font-weight:800;text-transform:uppercase;letter-spacing:.04em;font-size:.8rem;color:var(--text);margin-bottom:6px;}'
      + '#resourcesModal .ci-line{font-size:1rem;color:var(--text);margin:2px 0;}'
      + '#resourcesModal .ci-line .k{color:var(--muted);display:inline-block;min-width:58px;}'
      + '#resourcesModal .qr{flex:0 0 auto;text-align:center;}'
      + '#resourcesModal .qr-box{width:116px;height:116px;border:1px solid var(--border);padding:5px;background:var(--surface);}'
      + '#resourcesModal .qr-box img,#resourcesModal .qr-box canvas{width:100%!important;height:100%!important;display:block;}'
      + '#resourcesModal .qr-cap{font-size:.72rem;color:var(--muted);margin-top:5px;max-width:120px;word-break:break-all;line-height:1.3;}'
      + '#resourcesModal .res-foot{margin-top:12px;color:var(--muted);font-size:.82rem;}'
      + '@media (max-width:620px){#resourcesModal .grid{grid-template-columns:1fr;}#resourcesModal .contact{flex-direction:column-reverse;align-items:flex-start;}#resourcesModal .sheet{padding:20px 16px 26px;}}'
      // Print: show ONLY the sheet, one page, no app chrome.
      + '@media print{'
      +   'body.res-printing *{visibility:hidden!important;}'
      +   'body.res-printing #resourcesModal,body.res-printing #resourcesModal *{visibility:visible!important;}'
      +   'body.res-printing #resourcesModal{position:absolute;inset:0;background:var(--surface);overflow:visible;}'
      +   'body.res-printing #resourcesModal .res-chrome{display:none!important;}'
      +   'body.res-printing #resourcesModal .res-stage{padding:0;display:block;}'
      +   'body.res-printing #resourcesModal .sheet{width:auto;max-width:none;border:0;border-radius:0;padding:0;font-size:11px;line-height:1.34;}'
      +   'body.res-printing #resourcesModal h2{margin:10px 0 6px;}'
      +   'body.res-printing #resourcesModal .masthead img{height:48px;}'
      +   'body.res-printing #resourcesModal ol.steps li{padding:6px 0 6px 38px;}'
      +   'body.res-printing #resourcesModal .need{margin:0 0 7px;padding:5px 11px;}'
      +   'body.res-printing #resourcesModal .grid{gap:5px 20px;}'
      +   'body.res-printing #resourcesModal .callout{margin:9px 0 3px;padding:8px 12px;}'
      +   'body.res-printing #resourcesModal .contact{margin-top:10px;padding-top:8px;}'
      +   'body.res-printing #resourcesModal .qr-box{width:96px;height:96px;}'
      +   '@page{margin:9mm;}'
      + '}';
    var el = document.createElement('style');
    el.id = 'resources_styles';
    el.textContent = css;
    document.head.appendChild(el);
  }

  // ── Fact-sheet content (nation-neutral; branding filled at render) ──────────
  function _contractorSheet() {
    var url = _contractorUrl();
    return ''
      + _masthead('Contractor Portal — Sign-in & Quick Reference')
      + '<p class="lede">See the work orders assigned to you and send <b>photos, invoices, notes and progress</b> to the Housing office &mdash; right from your phone, with no app to install and no password to remember.</p>'
      + '<a class="cta" href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(url.replace(/^https?:\/\//, '')) + ' &rarr;</a>'
      + '<h2>Getting access</h2>'
      + '<p class="need"><b>The Housing office sets you up first.</b> They send a sign-in link by <b>text</b> to the mobile number on your contractor file. You can&rsquo;t register yourself &mdash; if you haven&rsquo;t been invited yet, call the office and ask to be <b>invited to the Contractor Portal</b>.</p>'
      + '<h2>How to sign in</h2>'
      + '<ol class="steps">'
      +   '<li>Open the portal (tap the link we text you, or scan the code).</li>'
      +   '<li>Enter the <b>mobile number</b> the office has on file for you, then tap &ldquo;Text me a code.&rdquo;</li>'
      +   '<li>We text you a <b>6-digit code</b>. Type it in and tap &ldquo;Verify &amp; sign in.&rdquo; <span class="muted">The code is automated, so it may come from a short code or an unfamiliar number.</span></li>'
      +   '<li>You&rsquo;re in. You&rsquo;ll see <b>only your own</b> assigned work orders.</li>'
      + '</ol>'
      + '<h2>What you can do</h2>'
      + '<div class="grid">'
      +   _thing('See your work orders', 'Scope, tenant contact, target dates, and any documents the office shares.')
      +   _thing('Report progress', 'Slide to set % complete. 100% tells the office it&rsquo;s ready for sign-off.')
      +   _thing('Send invoices &amp; photos', 'Submit your invoice (even after a job is complete), site photos, and notes.')
      +   _thing('Upload compliance docs', 'Attach your current WSIB clearance and liability insurance certificates.')
      +   _thing('Request a team member', 'Ask the office to give a colleague portal access &mdash; once approved they get their own sign-in.')
      +   _thing('Track submissions', 'See whether an invoice is awaiting review or approved, and which photos were read.')
      + '</div>'
      + '<div class="callout"><h3>&ldquo;Not set up yet&rdquo; when you sign in?</h3>'
      +   '<p>Your number isn&rsquo;t linked to a contractor yet &mdash; either the office hasn&rsquo;t sent an invite, or the number you entered isn&rsquo;t the one on your contractor file. Call or email and ask them to invite your mobile number.</p></div>'
      + _contact(url);
  }

  function _tenantSheet() {
    var url = _tenantUrl();
    return ''
      + _masthead('Housing Portal — Community Guide')
      + '<p class="lede">Apply for housing, request a transfer, or update your information online &mdash; anytime, from your phone or computer, with no app to install.</p>'
      + '<a class="cta" href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(url.replace(/^https?:\/\//, '')) + ' &rarr;</a>'
      + '<h2>What you can do</h2>'
      + '<div class="grid">'
      +   _thing('Submit a new application', 'Apply to be placed on the housing list for a home.')
      +   _thing('Request a transfer', 'Already housed and need a different unit? Ask for a transfer.')
      +   _thing('Update your information', 'Keep your contact details, household and circumstances current.')
      + '</div>'
      + '<h2>How to sign in</h2>'
      + '<p class="need"><b>Before you start:</b> have your <b>band / membership number</b> ready &mdash; you&rsquo;ll enter it when you sign in.</p>'
      + '<ol class="steps">'
      +   '<li>Open the portal (or scan the code below).</li>'
      +   '<li>Enter your <b>email address</b> and <b>band / membership number</b>, then tap &ldquo;Email me a sign-in link.&rdquo;</li>'
      +   '<li>Open the email and click the <b>secure link</b> &mdash; it signs you in. <span class="muted">No password to remember.</span></li>'
      + '</ol>'
      + '<div class="callout"><h3>Already applied before? Please still submit a new application.</h3>'
      +   '<p>Even if you already have a file with the Housing Department, submit a <b>new application</b> through the portal. Staff then <b>merge your online file with your existing one</b> into a single, up-to-date record &mdash; you only do this once.</p></div>'
      + '<h2>After your files are merged</h2>'
      + '<p>Once your files are joined and your tenancy is linked, housed tenants can use the portal&rsquo;s <b>My Home</b> section to submit <b>renovation and maintenance requests</b> straight to the Housing Department.</p>'
      + _contact(url);
  }

  function _masthead(docTitle) {
    var logo = _logoSrc();
    var logoImg = logo ? '<img src="' + esc(logo) + '" alt=""/>' : '';
    return '<header class="masthead">' + logoImg
      + '<div><div class="org">' + esc(_nationName()) + '</div>'
      + '<div class="doc-title">' + esc(docTitle) + '</div></div></header>';
  }
  function _thing(h, p) { return '<div class="thing"><h3>' + h + '</h3><p>' + p + '</p></div>'; }
  function _contact(url) {
    var ph = _phone(), em = _email();
    var lines = '';
    if (ph) lines += '<div class="ci-line"><span class="k">Phone</span> <b>' + esc(ph) + '</b></div>';
    if (em) lines += '<div class="ci-line"><span class="k">Email</span> <b>' + esc(em) + '</b></div>';
    if (!lines) lines = '<div class="ci-line muted">Contact your Housing office for help.</div>';
    return '<section class="contact">'
      + '<div><div class="ci-label">' + esc(_nationName()) + ' &mdash; Housing office</div>' + lines
      +   '<div class="ci-line muted" style="font-size:.9rem;margin-top:7px;">Need help signing in? Call or email and we&rsquo;ll walk you through it.</div></div>'
      + '<div class="qr"><div class="qr-box" id="res_qr"></div><div class="qr-cap">' + esc(url.replace(/^https?:\/\//, '')) + '</div></div>'
      + '</section>'
      + '<footer class="res-foot">' + esc(_nationName()) + ' Housing Department</footer>';
  }

  // ── qrcodejs lazy-load (same CDN the unit-label QR uses) ─────────────────────
  function _loadQr() {
    return new Promise(function (resolve) {
      if (window.QRCode) return resolve(true);
      var s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
      s.onload = function () { resolve(!!window.QRCode); };
      s.onerror = function () { resolve(false); };
      document.head.appendChild(s);
    });
  }
  function _renderQr(url) {
    var host = document.getElementById('res_qr');
    if (!host) return;
    _loadQr().then(function (ok) {
      host = document.getElementById('res_qr');
      if (!host) return;
      host.innerHTML = '';
      if (ok && window.QRCode) {
        try { new window.QRCode(host, { text: url, width: 220, height: 220, correctLevel: window.QRCode.CorrectLevel.M }); }
        catch (e) { host.innerHTML = '<div class="qr-cap">QR unavailable</div>'; }
      } else {
        host.innerHTML = '<div class="qr-cap">Scan the address above</div>';
      }
    });
  }

  // ── Modal ────────────────────────────────────────────────────────────────
  function _render() {
    var host = document.getElementById('resourcesModal');
    if (!host) { host = document.createElement('div'); host.id = 'resourcesModal'; document.body.appendChild(host); }
    var sheet = (_current === 'tenant') ? _tenantSheet() : _contractorSheet();
    function tab(key, label) {
      return '<button type="button" class="res-tab' + (_current === key ? ' res-on' : '') + '" data-res-tab="' + key + '">' + label + '</button>';
    }
    host.innerHTML =
        '<div class="res-chrome">'
      +   '<div class="res-title">Shareable Resources</div>'
      +   '<div class="res-tabs">' + tab('contractor', 'Contractor guide') + tab('tenant', 'Tenant guide') + '</div>'
      +   '<button type="button" class="btn btn-primary" data-res-print>🖨️ Print / Save PDF</button>'
      +   '<button type="button" class="btn btn-ghost" data-res-close>Close</button>'
      + '</div>'
      + '<div class="res-stage"><div class="sheet">' + sheet + '</div></div>';
    _renderQr(_current === 'tenant' ? _tenantUrl() : _contractorUrl());
    try { host.scrollTop = 0; } catch (e) {}
  }

  function openResources(which) {
    _ensureStyles();
    if (CARDS.indexOf(which) !== -1) _current = which;
    _render();
    // Delegated handlers (wired once on the persistent host).
    var host = document.getElementById('resourcesModal');
    if (host && !host._resWired) {
      host._resWired = true;
      host.addEventListener('click', function (e) {
        var t = e.target;
        if (!t || !t.closest) return;
        if (t.closest('[data-res-close]')) { closeResources(); return; }
        if (t.closest('[data-res-print]')) { _print(); return; }
        var tb = t.closest('[data-res-tab]');
        if (tb) { _current = tb.getAttribute('data-res-tab'); _render(); }
      });
    }
  }
  function closeResources() {
    var host = document.getElementById('resourcesModal');
    if (host) host.innerHTML = '';
  }
  function _print() {
    document.body.classList.add('res-printing');
    var done = function () { try { document.body.classList.remove('res-printing'); } catch (e) {} };
    try { window.addEventListener('afterprint', function h() { window.removeEventListener('afterprint', h); done(); }); } catch (e) {}
    setTimeout(function () { try { window.print(); } catch (e) {} setTimeout(done, 1500); }, 60);
  }

  window.openResources  = openResources;
  window.closeResources = closeResources;
})();
