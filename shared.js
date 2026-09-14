// @ts-check
/* ═══════════════════════════════════════════════════════════════════════
   shared.js — CLFN Housing Suite shared factories
   ───────────────────────────────────────────────────────────────────────
   Loaded by: finance.html, housing.html, renos.html, index.html
   Exposes:  window.CLFN_PERMS, window.SigWidget, window.DocLibrary,
             window.SbStorage (and bare sb* aliases)

   IMPORTANT: Pure browser script. No ES modules, no imports, no build
   step — matches the suite's "vanilla JS with direct fetch calls"
   architectural constraint. Reads NO globals; everything is passed in
   via opts to keep these factories dependency-free and testable.

   CSS classes live in shared.css under the .sigw-* and .doclib-*
   namespaces; see the shared.css file for the full list.
   ═══════════════════════════════════════════════════════════════════════ */

// ═══════════════════════════════════════════════════════════════════════
// _printThemeStyles — emit current theme tokens as a <style>:root{...}</style>
// block for print/preview documents opened via window.open(). Those documents
// don't inherit the parent's CSS variables, so we read computed values once
// and inject them so the same var(--*) tokens resolve correctly in the
// detached print HTML.
// ═══════════════════════════════════════════════════════════════════════
window._printThemeStyles = function() {
  var s = getComputedStyle(document.documentElement);
  var keys = ['--yellow','--dark','--dark2','--text','--muted','--border',
              '--surface','--bg','--success','--success-bg','--success-border',
              '--danger','--danger-bg','--danger-border',
              '--info-blue','--info-blue-bg',
              '--warn-amber','--warn-amber-bg','--warn-amber-border'];
  return ':root{' + keys.map(function(k){
    return k + ':' + s.getPropertyValue(k).trim() + ';';
  }).join('') + '}';
};

// ═══════════════════════════════════════════════════════════════════════
// _applyTheme — apply a saved brand theme to the live document.
// Theme shape: { yellow: '#...', dark: '#...', text: '#...', logo: 'data:image/...' }
// Any field may be missing/empty — that token then keeps its CSS default.
// Logo data URL is applied to all <img class="hlogo"> + #login-logo elements.
// ═══════════════════════════════════════════════════════════════════════
window.THEME_KEYS = ['yellow','action','dark','text','bg','surface','border','muted','sans','serif','radius'];
// Platform default palette = Home Land Homes brand (Clay). A nation overrides
// the accent (and the header ink derives from it) via the admin portal; a
// nation with no override inherits this palette. Keep in sync with :root in
// shared.css.
window.THEME_DEFAULTS = { yellow:'#9A4A1F', action:'#FFFFFF', tint:'#F3E4D8', dark:'#26221C', text:'#26221C',
                          bg:'#FAF7F2', surface:'#FFFDF9', border:'#D8CFC0', muted:'#57503F',
                          sans:'DM Sans', serif:'DM Serif Display', radius:'10px' };

// Font definitions — maps font name → { css: full font-family stack, google: needs Google Fonts }
window.FONT_DEFS = {
  'DM Sans':          { css:"'DM Sans', sans-serif",                       google:true  },
  'Inter':            { css:"'Inter', sans-serif",                         google:true  },
  'Roboto':           { css:"'Roboto', sans-serif",                        google:true  },
  'Open Sans':        { css:"'Open Sans', sans-serif",                     google:true  },
  'Nunito':           { css:"'Nunito', sans-serif",                        google:true  },
  'Source Sans 3':    { css:"'Source Sans 3', sans-serif",                 google:true  },
  'System Default':   { css:"system-ui, -apple-system, sans-serif",        google:false },
  'DM Serif Display': { css:"'DM Serif Display', serif",                   google:true  },
  'Playfair Display': { css:"'Playfair Display', serif",                   google:true  },
  'Lora':             { css:"'Lora', serif",                               google:true  },
  'Merriweather':     { css:"'Merriweather', serif",                       google:true  },
  'Georgia':          { css:"Georgia, serif",                              google:false },
};

// Load a Google Font dynamically — idempotent, no-op if already loaded.
window._loadGoogleFont = function(name) {
  if (!name) return;
  var id = 'gfont-' + name.replace(/\s+/g, '-').toLowerCase();
  if (document.getElementById(id)) return;
  var link = document.createElement('link');
  link.id   = id;
  link.rel  = 'stylesheet';
  link.href = 'https://fonts.googleapis.com/css2?family=' + encodeURIComponent(name) + ':wght@300;400;500;600;700&display=swap';
  document.head.appendChild(link);
};

// ═══════════════════════════════════════════════════════════════════════
// showAlert — centered branded notification with a single OK button.
// Same visual language as showConfirm but for one-way information.
//
//   showAlert({
//     title:   'Renovation request saved',
//     message: 'Your scope of work has been recorded.',
//     okText:  'Continue'                // optional, default 'OK'
//   }).then(function(){ window.location.href = 'renos.html?view=approvals'; });
//
// The promise resolves when the user dismisses (OK / × / overlay click).
// ═══════════════════════════════════════════════════════════════════════
window.showAlert = function(opts) {
  opts = opts || {};
  return new Promise(function(resolve){
    var ov = document.createElement('div');
    ov.className = 'modal-overlay modal-overlay-centered modal-z-1100 is-open';
    ov.innerHTML =
      '<div class="modal-body modal-body-sm">' +
        '<div class="modal-hdr">' +
          '<div class="modal-hdr-title">' + (opts.title || 'Notice') + '</div>' +
          '<button type="button" class="btn-close-dark-30" data-al-close>&times;</button>' +
        '</div>' +
        '<div class="modal-body-stack">' +
          '<p class="txt-help m-0">' + (opts.message || '') + '</p>' +
        '</div>' +
        '<div class="modal-footer">' +
          '<button type="button" class="btn btn-primary" data-al-close>' + (opts.okText || 'OK') + '</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);
    function close(){ if (ov.parentNode) ov.parentNode.removeChild(ov); resolve(); }
    ov.querySelectorAll('[data-al-close]').forEach(function(b){ b.onclick = close; });
    ov.addEventListener('click', function(e){ if (e.target === ov) close(); });
  });
};

// Mix two hex colours by fraction t (0 = a, 1 = b). Returns #rrggbb, or null
// for an unparseable input so callers can fall back to the stock palette.
window._mixHex = function(a, b, t){
  function parse(h){
    h = String(h||'').trim().replace('#','');
    if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
    var n = parseInt(h,16); return [(n>>16)&255,(n>>8)&255,n&255];
  }
  var ca = parse(a), cb = parse(b); if (!ca || !cb) return null;
  var out = ca.map(function(v,i){ return Math.round(v + (cb[i]-v)*t); });
  return '#' + out.map(function(x){ return ('0'+Math.max(0,Math.min(255,x)).toString(16)).slice(-2); }).join('');
};
// Parse a hex colour to an "r, g, b" string for rgba() var interpolation, or
// null if unparseable.
window._hexToRgbStr = function(hex){
  var h = String(hex||'').trim().replace('#','');
  if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  var n = parseInt(h,16); return ((n>>16)&255)+', '+((n>>8)&255)+', '+(n&255);
};
// Deep brand-tinted "ink" — the accent colour mixed heavily toward black. Used
// for the app header / modal headers / print banners so they carry the nation's
// brand hue while staying dark enough for white text on any brand colour.
window._brandInk = function(hex, k){ return window._mixHex(hex, '#000000', k==null?0.88:k); };

// Relative luminance (WCAG) of a hex colour, 0..1.
window._luminance = function(hex){
  var h = String(hex||'').trim().replace('#','');
  if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  var n = parseInt(h,16);
  var c = [(n>>16)&255, (n>>8)&255, n&255].map(function(v){ v/=255; return v<=0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); });
  return 0.2126*c[0] + 0.7152*c[1] + 0.0722*c[2];
};
function _contrast(l1, l2){ var a=Math.max(l1,l2), b=Math.min(l1,l2); return (a+0.05)/(b+0.05); }
// A readable "ink" version of the accent for TEXT on a light (white) surface:
// the accent darkened just enough to clear ~5:1 contrast, so a bright accent
// (e.g. yellow) becomes a legible dark-accent text colour while an already-dark
// accent (e.g. clay) is left essentially as-is. Returns null on a bad hex.
window._accentInk = function(accent){
  var lw = window._luminance('#ffffff');
  var la = window._luminance(accent);
  if (la == null) return null;
  if (_contrast(la, lw) >= 4.8) return accent;         // already readable as text
  var ink = accent;
  for (var m = 0.1; m <= 0.9; m += 0.05){
    ink = window._mixHex(accent, '#000000', m);
    if (ink && _contrast(window._luminance(ink), lw) >= 4.8) return ink;
  }
  return ink;
};
// Text colour to place ON an accent FILL (button, pill): black on a light
// accent, white on a dark one — whichever contrasts better.
window._onAccent = function(accent){
  var la = window._luminance(accent);
  if (la == null) return '#131313';
  return _contrast(la, window._luminance('#131313')) >= _contrast(la, window._luminance('#ffffff')) ? '#131313' : '#ffffff';
};

// ── Theme accent for PDF / print code (which can't read CSS variables) ───────
// _themeAccentHex/_themeAccentInkHex return the LIVE resolved --yellow /
// --accent-ink; the *Rgb variants return [r,g,b] for jsPDF. Use the ACCENT for
// FILLS (a coloured bar/header) and the INK for accent TEXT on white paper (a
// bright accent is unreadable there — same rule as the on-screen tokens).
window._themeAccentHex = function(){
  try { var v = getComputedStyle(document.documentElement).getPropertyValue('--yellow').trim(); if (v) return v; } catch(e){}
  return (window.NATION_CONFIG && window.NATION_CONFIG.primary_color) || (window.THEME_DEFAULTS && window.THEME_DEFAULTS.yellow) || '#9A4A1F';
};
window._themeAccentInkHex = function(){
  try { var v = getComputedStyle(document.documentElement).getPropertyValue('--accent-ink').trim(); if (v) return v; } catch(e){}
  return window._accentInk(window._themeAccentHex()) || '#6B6100';
};
window._themeOnAccentHex = function(){ return window._onAccent(window._themeAccentHex()); };
function _hexToRgbArr(hex){ var s = window._hexToRgbStr(hex); return s ? s.split(',').map(function(n){ return parseInt(n, 10); }) : [154, 74, 31]; }
window._themeAccentRgb    = function(){ return _hexToRgbArr(window._themeAccentHex()); };
window._themeAccentInkRgb = function(){ return _hexToRgbArr(window._themeAccentInkHex()); };
window._themeOnAccentRgb  = function(){ return _hexToRgbArr(window._themeOnAccentHex()); };

// Paint the dark surfaces (--dark/--dark2/--dark3) from the brand accent so the
// header aligns to the nation's brand colour. When the ED has NOT explicitly
// chosen a header colour (customDark falsy or the stock near-black), a deep ink
// is derived from the accent; otherwise the chosen colour is used and its two
// lighter companion surfaces are derived from it. A bad accent hex leaves the
// stock CSS palette untouched.
window._applyBrandDark = function(accent, customDark){
  var root  = document.documentElement;
  var D     = window.THEME_DEFAULTS || {};
  var stock = D.dark || '#111110';
  var defAccent = String(D.yellow || '').toLowerCase();
  var accentIsDefault = accent && String(accent).toLowerCase() === defAccent;
  // Header / dark surfaces:
  //  - an explicit non-stock header colour wins;
  //  - the platform-default accent keeps the curated default ink (so the brand's
  //    own Ink shows, not a near-black derivation of the accent);
  //  - a distinct brand accent derives a matching deep ink.
  var isCustom = customDark && String(customDark).toLowerCase() !== stock.toLowerCase();
  var base  = isCustom ? customDark : (accentIsDefault ? stock : window._brandInk(accent, 0.88));
  if (base){
    root.style.setProperty('--dark', base);
    var d2 = window._mixHex(base, '#ffffff', 0.06);
    var d3 = window._mixHex(base, '#ffffff', 0.14);
    if (d2) root.style.setProperty('--dark2', d2);
    if (d3) root.style.setProperty('--dark3', d3);
  }
  // Accent companions (hover + soft tint + rgba glow base) — derive from a
  // DISTINCT brand accent so hover/tint/glows don't stay the default clay on a
  // differently-coloured nation. The platform-default accent keeps the curated
  // --yellow-mid/--yellow-light/--accent-rgb from :root.
  if (accent && !accentIsDefault){
    var hov = window._mixHex(accent, '#000000', 0.20);
    var tnt = window._mixHex(accent, '#ffffff', 0.85);
    var rgb = window._hexToRgbStr(accent);
    if (hov) root.style.setProperty('--yellow-mid', hov);
    if (tnt) root.style.setProperty('--yellow-light', tnt);
    if (rgb) root.style.setProperty('--accent-rgb', rgb);
  }
  // Accent INK (readable accent text on light) + ON-ACCENT (text on an accent
  // fill) are derived for EVERY accent, since they must stay legible no matter
  // how light/dark the accent is. An explicit theme.accentInk override wins
  // (applied in _applyTheme after this).
  if (accent){
    var ink = window._accentInk(accent);
    if (ink) root.style.setProperty('--accent-ink', ink);
    root.style.setProperty('--on-accent', window._onAccent(accent));
  }
};

window._applyTheme = function(theme) {
  theme = theme || {};
  var root = document.documentElement;
  var fontKeys = { sans: true, serif: true };
  window.THEME_KEYS.forEach(function(k){
    var val = theme[k];
    if (fontKeys[k]) {
      var def = val && window.FONT_DEFS && window.FONT_DEFS[val];
      var css = def ? def.css : (val ? ("'" + val + "', " + (k==='serif'?'serif':'sans-serif')) : null);
      if (css) {
        if (def && def.google) window._loadGoogleFont(val);
        root.style.setProperty('--' + k, css);
      } else {
        root.style.removeProperty('--' + k);
      }
    } else {
      if (val) root.style.setProperty('--' + k, val);
      else     root.style.removeProperty('--' + k);
    }
  });
  // Header / dark surfaces follow the brand accent unless the ED has explicitly
  // overridden the header colour (theme.dark set to something other than stock).
  window._applyBrandDark(theme.yellow || (window.THEME_DEFAULTS||{}).yellow, theme.dark);
  // Explicit tint override (Themes editor "Tint / highlight") wins over the
  // value derived from the accent. Handled here, not in the THEME_KEYS loop,
  // so leaving it unset doesn't wipe the derived/default --yellow-light.
  if (theme.tint) root.style.setProperty('--yellow-light', theme.tint);
  if (theme.accentInk) root.style.setProperty('--accent-ink', theme.accentInk);
  if (theme.accentHover)  root.style.setProperty('--yellow-mid', theme.accentHover);
  if (theme.borderStrong) root.style.setProperty('--border-strong', theme.borderStrong);
  if (theme.inputBorder)  root.style.setProperty('--input-border', theme.inputBorder);
  // Semantic status colours: set the base colour AND derive its light pill
  // background + border (a tint toward white) so the whole pill follows.
  function _semantic(colour, base, bgVar, borderVar){
    root.style.setProperty(base, colour);
    if (bgVar)     { var b = window._mixHex(colour, '#ffffff', 0.90); if (b) root.style.setProperty(bgVar, b); }
    if (borderVar) { var d = window._mixHex(colour, '#ffffff', 0.68); if (d) root.style.setProperty(borderVar, d); }
  }
  if (theme.success) _semantic(theme.success, '--success', '--success-bg', '--success-border');
  if (theme.danger)  _semantic(theme.danger,  '--danger',  '--danger-bg',  '--danger-border');
  if (theme.info)    _semantic(theme.info,     '--info-blue', '--info-blue-bg', null);
  if (theme.warning){ _semantic(theme.warning, '--warn-amber', '--warn-amber-bg', '--warn-amber-border'); root.style.setProperty('--warn-amber-text', theme.warning); }
  // Logo src + transparency — also covers the Themes panel preview thumbnail.
  document.querySelectorAll('img.hlogo, #login-logo, #theme_logo_preview').forEach(function(img){
    if (theme.logo) img.src = theme.logo;
    img.classList.toggle('logo-transparent', !!theme.logoTransparent);
  });
  // Cache logo in sessionStorage so renderAppHeader() can apply it
  // synchronously on subsequent page navigations, eliminating the flash
  // of the hardcoded fallback logo between DOMContentLoaded and settings load.
  try {
    if (theme.logo) {
      sessionStorage.setItem('clfn_logo_cache', theme.logo);
      sessionStorage.setItem('clfn_logo_transparent', theme.logoTransparent ? '1' : '');
    }
  } catch(e) {}
  // Favicon / bookmark icon — drive the tab + saved-link icon from the nation's
  // saved logo (Settings, persisted as theme.logo). No hardcoded brand here; if
  // the nation hasn't configured a logo yet, the browser default is left as-is.
  try {
    if (theme.logo && typeof _setFavicon === 'function') _setFavicon(theme.logo);
  } catch(e) {}
  // Cache the fully-resolved theme CSS custom properties (everything _applyTheme
  // set inline on <html>, incl. derived tokens) so the tiny inline <head> script
  // on each page can re-apply them SYNCHRONOUSLY before first paint on the next
  // navigation — eliminating the flash of the default colour scheme between page
  // load and settings load. Logo lives in its own cache (img src, not here).
  try {
    var _css = document.documentElement.style.cssText || '';
    if (_css) sessionStorage.setItem('clfn_theme_css', _css);
  } catch(e) {}
};

// _setFavicon — point the tab/bookmark icon at `href` (a data URL or path).
// Ensures both an "icon" and an "apple-touch-icon" link exist and updates them,
// so the browser tab/address bar AND iOS "Add to Home Screen" use the same
// nation logo. Pages ship no static icon link — this is the only source.
window._setFavicon = function(href) {
  if (!href) return;
  var head = document.head || document.getElementsByTagName('head')[0];
  if (!head) return;
  ['icon', 'apple-touch-icon'].forEach(function(rel) {
    // iOS "Add to Home Screen" ignores data-URI apple-touch-icons, so a nation
    // logo stored as a data URI must NOT overwrite the static app icon
    // (apple-touch-icon.png) — leave that in place for the home screen. The
    // browser-tab favicon ('icon') still takes the data-URI logo. A nation whose
    // logo is a real hosted URL still flows through to the home-screen icon.
    if (rel === 'apple-touch-icon' && /^data:/i.test(href)) return;
    var sel = (rel === 'icon')
      ? 'link[rel="icon"], link[rel="shortcut icon"]'
      : 'link[rel="apple-touch-icon"]';
    var nodes = head.querySelectorAll(sel);
    if (nodes.length) {
      for (var i = 0; i < nodes.length; i++) nodes[i].setAttribute('href', href);
    } else {
      var l = document.createElement('link');
      l.setAttribute('rel', rel);
      if (rel === 'icon') l.setAttribute('type', 'image/png');
      l.setAttribute('href', href);
      head.appendChild(l);
    }
  });
};

// Apply the nation's saved logo as the favicon as early as possible, from the
// sessionStorage cache that _applyTheme writes on each load. This avoids a
// blank icon between page load and the settings fetch on navigations, and keeps
// everything nation-config-driven (no hardcoded brand image).
try {
  var _cachedLogo = sessionStorage.getItem('clfn_logo_cache');
  if (_cachedLogo) window._setFavicon(_cachedLogo);
} catch(e) {}

// ── jsPDF lazy-loader (single implementation) ─────────────────────────────
// Loads jsPDF (and optionally the autotable plugin) from the CSP-allowlisted
// CDN on first use. Every per-file copy of this loader delegated here in the
// audit cleanup (notifications.js, labels.js, projects-init.js,
// inspections-init.js, shared-data.js exports, finance-pdf-jspdf.js) — do not
// re-add a local one. Returns a Promise resolving to the jsPDF constructor.
// Unlike some of the old copies, this correctly loads autotable even when
// jsPDF itself is already present (a page that first generated a plain PDF
// used to throw `doc.autoTable is not a function` on its next table export).
window.loadJsPdf = function loadJsPdf(opts) {
  opts = opts || {};
  var JS_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
  var AT_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.5.31/jspdf.plugin.autotable.min.js';
  function haveJs(){ return !!(window.jspdf && window.jspdf.jsPDF); }
  function haveAt(){ return !!(haveJs() && window.jspdf.jsPDF.API && window.jspdf.jsPDF.API.autoTable); }
  function addScript(src) {
    return new Promise(function(resolve, reject){
      // Dedupe: reuse an in-flight/loaded tag rather than injecting twice.
      var existing = document.querySelector('script[src="' + src + '"]');
      if (existing) {
        if (existing.dataset.jspdfLoaded) return resolve();
        existing.addEventListener('load',  function(){ resolve(); });
        existing.addEventListener('error', function(){ reject(new Error('script load failed: ' + src)); });
        return;
      }
      var s = document.createElement('script');
      s.src = src;
      s.onload  = function(){ s.dataset.jspdfLoaded = '1'; resolve(); };
      s.onerror = function(){ reject(new Error('script load failed: ' + src)); };
      document.head.appendChild(s);
    });
  }
  var p = haveJs() ? Promise.resolve() : addScript(JS_SRC);
  if (opts.autotable) p = p.then(function(){ return haveAt() ? null : addScript(AT_SRC); });
  return p.then(function(){
    if (!haveJs()) throw new Error('jsPDF unavailable');
    return window.jspdf.jsPDF;
  });
};

// ── PWA / offline (Phase O1) ──────────────────────────────────────────────
// Register the service worker (sw.js) so the app shell + PDF libraries are
// cached and staff can open the app and generate/sign forms with no internet,
// and inject the web-app manifest link so it can be installed to a device home
// screen. Both are best-effort and never block boot.
(function(){
  try {
    if (!document.querySelector('link[rel="manifest"]')) {
      var l = document.createElement('link');
      l.rel = 'manifest';
      l.href = 'manifest.json';
      (document.head || document.documentElement).appendChild(l);
    }
    // Static home-screen icon. iOS "Add to Home Screen" needs a real hosted PNG
    // (it ignores the data-URI nation logo), so ship a neutral house app icon.
    // _setFavicon deliberately won't overwrite this with a data-URI logo.
    var _head = document.head || document.documentElement;
    if (!document.querySelector('link[rel="apple-touch-icon"]')) {
      var ai = document.createElement('link');
      ai.setAttribute('rel', 'apple-touch-icon');
      ai.setAttribute('href', 'apple-touch-icon.png');
      _head.appendChild(ai);
    }
    // Standard cross-browser PWA meta (the modern replacement for the Apple one).
    if (!document.querySelector('meta[name="mobile-web-app-capable"]')) {
      var mcap = document.createElement('meta');
      mcap.setAttribute('name', 'mobile-web-app-capable');
      mcap.setAttribute('content', 'yes');
      _head.appendChild(mcap);
    }
    // Kept for older iOS Safari, which still only honours the apple- prefix.
    if (!document.querySelector('meta[name="apple-mobile-web-app-capable"]')) {
      var cap = document.createElement('meta');
      cap.setAttribute('name', 'apple-mobile-web-app-capable');
      cap.setAttribute('content', 'yes');
      _head.appendChild(cap);
    }
    if (!document.querySelector('meta[name="apple-mobile-web-app-title"]')) {
      var t = document.createElement('meta');
      t.setAttribute('name', 'apple-mobile-web-app-title');
      // Nation-neutral fallback; the browser tab still shows the nation title.
      t.setAttribute('content', (window.NATION_CONFIG && (NATION_CONFIG.short || NATION_CONFIG.display_name)) || 'Housing');
      _head.appendChild(t);
    }
  } catch(e){}
  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    window.addEventListener('load', function(){
      navigator.serviceWorker.register('sw.js').catch(function(e){ console.warn('[sw] register failed:', e); });
    });
  }
})();

// ═══════════════════════════════════════════════════════════════════════
// formatPhone — canonical phone-string formatter "(705)-555-0100".
// Strips non-digits, caps at 10 digits, and emits the parens + dash form
// progressively as the user types: "(705)-555-0100" / "(705)-555" /
// "(705" depending on length. Used by both the typing-side fmtPhone(input)
// helper and every display surface that renders a stored phone value, so
// legacy strings like "705-555-0100" or "7055550100" all reformat to
// "(705)-555-0100" without a DB migration.
// ═══════════════════════════════════════════════════════════════════════
window.formatPhone = function(str){
  var v = String(str || '').replace(/\D/g, '').slice(0, 10);
  if (v.length >= 7) return '(' + v.slice(0, 3) + ')-' + v.slice(3, 6) + '-' + v.slice(6);
  if (v.length >= 4) return '(' + v.slice(0, 3) + ')-' + v.slice(3);
  return v ? '(' + v : '';
};

// ═══════════════════════════════════════════════════════════════════════
// formatCurrency — canonical "$1,234.56" formatter for any rendered dollar
// amount in the app. Always uses en-CA so commas + dot-decimal stay
// consistent regardless of the browser's locale. Single source of truth
// — every dollar( ), _ctFmtCurrency, and inline `'$'+x.toLocaleString()`
// site should resolve through here so the app reads as one product.
// ═══════════════════════════════════════════════════════════════════════
window.formatCurrency = function(n){
  var v = Number(n) || 0;
  return '$' + v.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

// ═══════════════════════════════════════════════════════════════════════
// fmtCurrency — input-side live formatter (called from oninput).
// Strips non-numeric chars while the user types, keeps at most one
// decimal point and two fraction digits, emits e.g. "1,234.56" WITHOUT
// the $ sign so the input stays editable. The $ is added at display
// time via formatCurrency.
//
// Used by housing-app.js currency inputs (income, arrears, etc.) via
// the existing oninput="fmtCurrency(this)" attribute, which previously
// referred to an undefined global and silently no-op'd.
// ═══════════════════════════════════════════════════════════════════════
window.fmtCurrency = function(input){
  if (!input) return;
  var raw     = String(input.value || '').replace(/[^\d.]/g, '');
  var parts   = raw.split('.');
  // Drop leading zeros on the integer part (so "01234" → "1,234").
  var intPart = parts[0].replace(/^0+(?=\d)/, '');
  // Reattach the decimal portion, capped at two digits.
  var decPart = parts.length > 1 ? '.' + parts.slice(1).join('').slice(0, 2) : '';
  if (!intPart && !decPart) { input.value = ''; return; }
  input.value = (intPart ? Number(intPart).toLocaleString('en-CA') : '0') + decPart;
};

// Parse a "$1,234.56" / "1,234.56" / "1234" style string back into a
// number. Useful at save-time when the input value carries display
// formatting that the DB shouldn't store.
window.parseCurrency = function(str){
  if (str == null) return 0;
  return parseFloat(String(str).replace(/[^0-9.\-]/g, '')) || 0;
};

// ═══════════════════════════════════════════════════════════════════════
// showConfirm — branded replacement for native window.confirm().
// Renders a centered modal using the standard .modal-hdr / .modal-body
// pattern, returns a Promise<boolean>. Pass `danger: true` for destructive
// actions (red confirm button instead of yellow primary).
//
//   showConfirm({
//     title: 'Reset theme?',
//     message: 'This clears any saved colors.',
//     confirmText: 'Reset',           // optional, default 'Confirm'
//     cancelText:  'Cancel',          // optional
//     danger:      true               // optional, red confirm button
//   }).then(function(ok){ if (ok) ... });
// ═══════════════════════════════════════════════════════════════════════
// showConfirm — styled replacement for native confirm().
// Returns Promise<boolean> by default, OR Promise<{ok, checked}> when
// opts.checkbox is passed (so callers can read an opt-in toggle inline
// with the confirm). The mixed return type keeps every existing
// `if (ok) ...` caller working unchanged.
//
//   opts.checkbox: { label: '...', defaultChecked: true } — optional
window.showConfirm = function(opts) {
  opts = opts || {};
  return new Promise(function(resolve){
    var ov = document.createElement('div');
    ov.className = 'modal-overlay modal-overlay-centered modal-z-1100 is-open';
    var btnClass    = opts.danger ? 'btn btn-danger' : 'btn btn-primary';
    var hasCheckbox = !!(opts.checkbox && opts.checkbox.label);
    var detailHtml  = opts.detail
      ? '<div style="margin-top:12px;background:var(--bg);border:1px solid var(--border);border-left:3px solid var(--yellow);border-radius:7px;padding:11px 14px;">'
          + opts.detail
        + '</div>'
      : '';
    var checkboxHtml = hasCheckbox
      ? '<label style="display:flex;align-items:flex-start;gap:8px;margin-top:12px;font-size:13px;cursor:pointer;line-height:1.4;">' +
          '<input type="checkbox" data-cn-checkbox' + (opts.checkbox.defaultChecked ? ' checked' : '') + ' style="margin-top:3px;flex-shrink:0;cursor:pointer;accent-color:var(--yellow);"/>' +
          '<span>' + opts.checkbox.label + '</span>' +
        '</label>'
      : '';
    // opts.checkboxes: [{ id, label, defaultChecked }] — a multi-select list
    // (e.g. pick which contacts receive an email). Labels are trusted HTML,
    // so callers must pre-escape. Resolves { ok, items:{id:bool}, selected:[ids] }.
    var hasCheckboxes = !!(opts.checkboxes && opts.checkboxes.length);
    var checkboxesHtml = hasCheckboxes
      ? '<div style="margin-top:12px;display:flex;flex-direction:column;gap:7px;">' +
          opts.checkboxes.map(function(cb, i){
            return '<label style="display:flex;align-items:flex-start;gap:8px;font-size:13px;cursor:pointer;line-height:1.4;">' +
                '<input type="checkbox" data-cn-multi="' + i + '"' + (cb.defaultChecked ? ' checked' : '') + ' style="margin-top:3px;flex-shrink:0;cursor:pointer;accent-color:var(--yellow);"/>' +
                '<span>' + (cb.label || '') + '</span>' +
              '</label>';
          }).join('') +
        '</div>'
      : '';
    ov.innerHTML =
      '<div class="modal-body modal-body-sm">' +
        '<div class="modal-hdr">' +
          '<div class="modal-hdr-title">' + (opts.title || 'Confirm') + '</div>' +
          '<button type="button" class="btn-close-dark-30" data-cn-cancel>&times;</button>' +
        '</div>' +
        '<div class="modal-body-stack">' +
          '<p class="txt-help m-0">' + (opts.message || 'Are you sure?') + '</p>' +
          detailHtml +
          checkboxHtml +
          checkboxesHtml +
        '</div>' +
        '<div class="modal-footer">' +
          '<button type="button" class="btn btn-ghost" data-cn-cancel>' + (opts.cancelText || 'Cancel') + '</button>' +
          '<button type="button" class="' + btnClass + '" data-cn-confirm>' + (opts.confirmText || 'Confirm') + '</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);
    function getCheckboxState(){
      var cb = ov.querySelector('[data-cn-checkbox]');
      return cb ? !!cb.checked : false;
    }
    function getMultiState(){
      var items = {}, selected = [];
      ov.querySelectorAll('[data-cn-multi]').forEach(function(cb){
        var idx = parseInt(cb.getAttribute('data-cn-multi'), 10);
        var def = opts.checkboxes[idx] || {};
        var id  = (def.id != null) ? def.id : idx;
        items[id] = !!cb.checked;
        if (cb.checked) selected.push(id);
      });
      return { items: items, selected: selected };
    }
    function close(ok){
      var checked = hasCheckbox ? getCheckboxState() : false;
      var multi   = hasCheckboxes ? getMultiState() : null;
      if (ov.parentNode) ov.parentNode.removeChild(ov);
      if (hasCheckboxes) { resolve({ ok: ok, items: multi.items, selected: multi.selected }); return; }
      resolve(hasCheckbox ? { ok: ok, checked: checked } : ok);
    }
    ov.querySelectorAll('[data-cn-cancel]').forEach(function(b){ b.onclick = function(){ close(false); }; });
    ov.querySelector('[data-cn-confirm]').onclick = function(){ close(true); };
    ov.addEventListener('click', function(e){ if (e.target === ov) close(false); });
  });
};

// ═══════════════════════════════════════════════════════════════════════
// showPrompt — styled replacement for the native browser prompt().
// Returns a Promise<string|null>: the entered text on confirm, or null
// when the user cancels. Mirrors showConfirm's modal-overlay-centered
// styling so the dialog feels like part of the app instead of dropping
// from the top of the viewport.
//
//   var reason = await showPrompt({
//     title: 'Decline application',
//     message: 'Reason for declining (optional):',
//     placeholder: 'e.g. duplicate submission',
//     confirmText: 'Decline',
//     danger: true,
//     multiline: true
//   });
//   if (reason === null) return; // cancelled
//
// Options:
//   title, message, placeholder, confirmText, cancelText — strings
//   danger    — boolean; red confirm button if true
//   multiline — boolean; renders a textarea instead of an input
//   required  — boolean; when true, confirm stays disabled until non-empty
//   value     — string; initial value (defaults to '')
// ═══════════════════════════════════════════════════════════════════════
window.showPrompt = function(opts) {
  opts = opts || {};
  return new Promise(function(resolve){
    var ov = document.createElement('div');
    ov.className = 'modal-overlay modal-overlay-centered modal-z-1100 is-open';
    var btnClass = opts.danger ? 'btn btn-danger' : 'btn btn-primary';
    var fieldId = 'showPrompt_' + Date.now();
    var field = opts.multiline
      ? '<textarea id="' + fieldId + '" rows="3" placeholder="' + (opts.placeholder || '') + '" style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--border);border-radius:7px;font-size:13px;font-family:DM Sans,sans-serif;background:var(--surface);color:var(--text);resize:vertical;">' + (opts.value || '') + '</textarea>'
      : '<input id="' + fieldId + '" type="text" placeholder="' + (opts.placeholder || '') + '" value="' + (opts.value || '') + '" style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--border);border-radius:7px;font-size:13px;font-family:DM Sans,sans-serif;background:var(--surface);color:var(--text);"/>';
    ov.innerHTML =
      '<div class="modal-body modal-body-sm">' +
        '<div class="modal-hdr">' +
          '<div class="modal-hdr-title">' + (opts.title || 'Enter a value') + '</div>' +
          '<button type="button" class="btn-close-dark-30" data-cn-cancel>&times;</button>' +
        '</div>' +
        '<div class="modal-body-stack">' +
          (opts.message ? '<p class="txt-help m-0" style="margin-bottom:8px;">' + opts.message + '</p>' : '') +
          field +
        '</div>' +
        '<div class="modal-footer">' +
          '<button type="button" class="btn btn-ghost" data-cn-cancel>' + (opts.cancelText || 'Cancel') + '</button>' +
          '<button type="button" class="' + btnClass + '" data-cn-confirm>' + (opts.confirmText || 'Confirm') + '</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);
    var input = document.getElementById(fieldId);
    var confirmBtn = ov.querySelector('[data-cn-confirm]');
    function syncRequired(){
      if(!opts.required || !confirmBtn) return;
      var v = (input && input.value ? input.value.trim() : '');
      confirmBtn.disabled = !v;
      confirmBtn.style.opacity = v ? '' : '.45';
    }
    syncRequired();
    if(input){
      input.addEventListener('input', syncRequired);
      // Enter submits on single-line input; Ctrl/Cmd-Enter submits on textarea.
      input.addEventListener('keydown', function(e){
        if(e.key === 'Enter' && (!opts.multiline || e.ctrlKey || e.metaKey)){
          e.preventDefault();
          if(!confirmBtn.disabled) confirmBtn.click();
        }
      });
      setTimeout(function(){ input.focus(); }, 30);
    }
    function close(result){ if (ov.parentNode) ov.parentNode.removeChild(ov); resolve(result); }
    ov.querySelectorAll('[data-cn-cancel]').forEach(function(b){ b.onclick = function(){ close(null); }; });
    confirmBtn.onclick = function(){ close(input ? input.value : ''); };
    ov.addEventListener('click', function(e){ if (e.target === ov) close(null); });
  });
};

// ═══════════════════════════════════════════════════════════════════════
// CLFN_PERMS — Authoritative role definitions and capability checks
// Single source of truth for all four app pages.
// Previously duplicated in housing.html, renos.html, finance.html,
// index.html — now lives here only.
// ═══════════════════════════════════════════════════════════════════════
(function initPerms(){

  // ── Authoritative role keys ───────────────────────────────────────────
  // Canonical values stored in staff.role. The DB was normalized to these
  // via the Phase A0 migration.
  var ROLES = Object.freeze({
    ED:         'ed',
    HM:         'housing_manager',
    HE_L2:      'housing_employee_l2',
    HE_L1:      'housing_employee_l1',
    // Maintenance crew. Executes approved renovation work: edits/completes
    // SOWs & work orders and updates progress. No application, approval,
    // finance, tenant-edit, or settings access. See approval-authority.js.
    FIELD_EMPLOYEE: 'field_employee',
    CFO:        'cfo',
    FINANCE_L1: 'finance_l1',
    // Cross-department admin tier — same authority as ED everywhere, no
    // forced department. See approval-authority.js can() for the inheritance.
    SUPER_USER: 'super_user'
  });

  // ── Legacy-name aliases ───────────────────────────────────────────────
  // Normalized at read-time so any pre-existing session tokens or cached
  // strings keep working.
  var LEGACY_ALIASES = Object.freeze({
    'employee':  ROLES.HE_L1,
    'staff':     ROLES.HE_L1,
    'hm':        ROLES.HM,
    'manager':   ROLES.HM,
    'finance':   ROLES.FINANCE_L1
  });

  // ── Human-readable labels (role switcher, badges, audit log) ──────────
  var ROLE_LABELS = Object.freeze({
    'ed':                   'Executive Director',
    'housing_manager':      'Housing Manager',
    'housing_employee_l2':  'Housing Employee L2',
    'housing_employee_l1':  'Housing Employee L1',
    'field_employee':       'Field Employee',
    'cfo':                  'CFO',
    'finance_l1':           'Finance Clerk L1',
    'super_user':           'Super User'
  });

  var VALID_KEYS = Object.freeze(Object.keys(ROLE_LABELS));

  // ── Core helpers ──────────────────────────────────────────────────────

  function normalizeRole(role){
    if(role == null) return null;
    var r = String(role).toLowerCase().trim();
    if(r in LEGACY_ALIASES) return LEGACY_ALIASES[r];
    return r;
  }

  function isValidRole(role){
    var r = normalizeRole(role);
    return VALID_KEYS.indexOf(r) !== -1;
  }

  function assertRole(role, caller){
    var r = normalizeRole(role);
    if(r == null) throw new Error('[permissions] '+(caller||'check')+': role is required');
    if(VALID_KEYS.indexOf(r) === -1){
      throw new Error('[permissions] '+(caller||'check')+': unknown role "'+role+'" (normalized to "'+r+'"). Valid: '+VALID_KEYS.join(', '));
    }
    return r;
  }

  // ── Overridable display labels ───────────────────────────────────────
  // Three-layer fallback for the human-readable role label:
  //   1. _appSettings.role_labels      — saved by ED via Settings → Nation
  //                                      → Position Names (per-tenant)
  //   2. NATION_CONFIG.role_labels     — build-time per-nation override
  //   3. ROLE_LABELS                   — system default
  // The role *key* itself is never overridden; only the display string changes.
  function roleLabel(role){
    var r = normalizeRole(role);
    var db = (window._appSettings && window._appSettings.role_labels) || null;
    if (db && r && db[r]) return db[r];
    var natCfg = (window.NATION_CONFIG && window.NATION_CONFIG.role_labels) || null;
    if (natCfg && r && natCfg[r]) return natCfg[r];
    return ROLE_LABELS[r] || String(role||'');
  }

  // ── Effective vs. real role ───────────────────────────────────────────
  // effectiveRole: the role the app is currently acting as (honors view-as).
  // realRole:      the actual authenticated user's role — used for override
  //                authority (only the real ED can unlock a completed SOW,
  //                regardless of which role they're previewing as).
  function effectiveRole(){
    return normalizeRole(window._viewAsRole || window.currentRole || null);
  }
  function realRole(){
    return normalizeRole(window._realRole || window.currentRole || null);
  }

  // ── Module-level access gates ─────────────────────────────────────────
  function hasHousingAccess(role){
    var r = assertRole(role, 'hasHousingAccess');
    return r === ROLES.ED || r === ROLES.HM || r === ROLES.HE_L2 || r === ROLES.HE_L1
        || r === ROLES.FIELD_EMPLOYEE || r === ROLES.SUPER_USER;
  }

  function hasFinanceAccess(role){
    var r = assertRole(role, 'hasFinanceAccess');
    return r === ROLES.ED || r === ROLES.HM || r === ROLES.HE_L2
        || r === ROLES.CFO || r === ROLES.FINANCE_L1
        || r === ROLES.SUPER_USER;
  }

  // ── Housing-app capabilities ──────────────────────────────────────────

  function canCreateApp(role){
    var r = assertRole(role, 'canCreateApp');
    // Field Employees (maintenance crew) have housing access for renovations
    // but never create or touch applications.
    if(r === ROLES.FIELD_EMPLOYEE) return false;
    return hasHousingAccess(r);
  }

  // Super User inherits ED's authority everywhere. _isEdTier centralises
  // the check so callers don't have to enumerate both keys.
  function _isEdTier(r) { return r === ROLES.ED || r === ROLES.SUPER_USER; }

  function canEditApp(role, opts){
    var r = assertRole(role, 'canEditApp');
    if(_isEdTier(r) || r === ROLES.HM || r === ROLES.HE_L2) return true;
    if(r === ROLES.HE_L1){
      if(!opts) return false;
      var isOwner = (opts.ownerRole === r) || (opts.ownerName && opts.ownerName === opts.currentUserName);
      var isDraft = !opts.status || opts.status === 'draft';
      return !!(isOwner && isDraft);
    }
    return false;
  }

  function canEditSow(role, sowStatus){
    var r = assertRole(role, 'canEditSow');
    if(!hasHousingAccess(r)) return false;
    if(sowStatus === 'completed') return _isEdTier(realRole());
    if(r === ROLES.HE_L1) return false;
    return true;
  }

  function canEditProgressForUnit(role, unitHasCompletedSow){
    var r = assertRole(role, 'canEditProgressForUnit');
    if(!hasHousingAccess(r)) return false;
    if(r === ROLES.HE_L1) return false;
    if(unitHasCompletedSow) return _isEdTier(realRole());
    return true;
  }

  // ── Approval authority ────────────────────────────────────────────────
  function canApproveSowHm(role){
    var r = assertRole(role, 'canApproveSowHm');
    return r === ROLES.HM || _isEdTier(r);
  }
  function canApproveSowEd(role){
    var r = assertRole(role, 'canApproveSowEd');
    return _isEdTier(r);
  }
  function canMarkSowComplete(role){
    var r = assertRole(role, 'canMarkSowComplete');
    // Field Employees execute the work, so they close out (complete) work
    // orders. Authorizing/approving a SOW stays with HM/ED.
    return _isEdTier(r) || r === ROLES.HM || r === ROLES.FIELD_EMPLOYEE;
  }
  function canReopenSow(role){
    var r = assertRole(role, 'canReopenSow');
    return _isEdTier(r);
  }

  // ── Role switcher (ED & Super User "view as") ────────────────────────
  function getViewAsOptions(role){
    var r = assertRole(role, 'getViewAsOptions');
    if(!_isEdTier(r)) return [];
    // Super User and ED see every OTHER role in their view-as picker. Skip
    // your own role so the dropdown doesn't include a no-op option.
    return VALID_KEYS.filter(function(k){ return k !== r; });
  }

  // Expose immutable API.
  window.CLFN_PERMS = Object.freeze({
    ROLES:                  ROLES,
    ROLE_LABELS:            ROLE_LABELS,
    normalizeRole:          normalizeRole,
    isValidRole:            isValidRole,
    assertRole:             assertRole,
    roleLabel:              roleLabel,
    effectiveRole:          effectiveRole,
    realRole:               realRole,
    hasHousingAccess:       hasHousingAccess,
    hasFinanceAccess:       hasFinanceAccess,
    canCreateApp:           canCreateApp,
    canEditApp:             canEditApp,
    canEditSow:             canEditSow,
    canEditProgressForUnit: canEditProgressForUnit,
    canApproveSowHm:        canApproveSowHm,
    canApproveSowEd:        canApproveSowEd,
    canMarkSowComplete:     canMarkSowComplete,
    canReopenSow:           canReopenSow,
    getViewAsOptions:       getViewAsOptions
  });
})();

// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
// SHARED SIGNATURE WIDGET FACTORY (Phase F3B — shared JS, v1)
// Single entry point: window.SigWidget.create(mountEl, opts)
// Produces a 3-tab signature widget (Draw / Type / Wet-or-E-Sign) and
// returns a controller with methods: getDataURL(), clear(), getMeta(),
// lock(), unlock(), isSigned().
//
// This factory is intentionally self-contained with ZERO external
// dependencies (no jQuery, no getData, no toast) so that when Phase C
// refactor introduces /shared.js, this block can be moved verbatim.
// CSS lives in shared.css under the .sigw-* namespace.
//
// Consumers in this file: initVoucherSigs() (voucher modal).
// Consumers elsewhere (housing.html, etc.) can adopt this factory too.
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
window.SigWidget = (function(){
  'use strict';

  // Render a single typed name into an offscreen canvas so we can produce
  // a consistent data URL regardless of which tab the user signed on.
  function _renderTypedToDataURL(name, width, height) {
    var c = document.createElement('canvas');
    c.width = width || 600; c.height = height || 90;
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#111';
    ctx.font = 'italic 34px Georgia, serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(name || '', 12, c.height/2);
    return c.toDataURL('image/png');
  }

  function create(mountEl, opts) {
    opts = opts || {};
    var id = opts.id || ('sigw_' + Math.random().toString(36).slice(2,9));
    var height = opts.height || 90;
    var allowTabs = opts.tabs || ['draw','type','wet'];
    var labelDraw = opts.labelDraw || '\u270F\uFE0F Draw';
    var labelType = opts.labelType || '\u2328\uFE0F Type';
    var labelWet  = opts.labelWet  || '\uD83D\uDD8A Wet / E-Sign';

    // Build DOM
    var root = document.createElement('div');
    root.className = 'sigw';
    root.dataset.sigwId = id;

    var tabs = document.createElement('div');
    tabs.className = 'sigw-tabs';

    var panels = {};
    var tabBtns = {};

    function makeTab(key, label) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'sigw-tab';
      b.dataset.tab = key;
      b.textContent = label;
      b.onclick = function(){ setMethod(key); };
      tabs.appendChild(b);
      tabBtns[key] = b;
    }

    if (allowTabs.indexOf('draw') >= 0) makeTab('draw', labelDraw);
    if (allowTabs.indexOf('type') >= 0) makeTab('type', labelType);
    if (allowTabs.indexOf('wet')  >= 0) makeTab('wet',  labelWet);

    root.appendChild(tabs);

    // ── Draw panel ──
    var drawPanel, canvas, drawCtx;
    if (allowTabs.indexOf('draw') >= 0) {
      drawPanel = document.createElement('div');
      drawPanel.className = 'sigw-panel';
      drawPanel.dataset.panel = 'draw';
      canvas = document.createElement('canvas');
      canvas.className = 'sigw-canvas';
      canvas.width = 700; canvas.height = height;
      canvas.style.height = height + 'px';
      drawPanel.appendChild(canvas);
      var footer = document.createElement('div');
      footer.className = 'sigw-canvas-footer';
      var hint = document.createElement('span');
      hint.className = 'sigw-hint';
      hint.textContent = 'Sign with finger or mouse';
      var clearBtn = document.createElement('button');
      clearBtn.type = 'button';
      clearBtn.className = 'sigw-clear';
      clearBtn.textContent = 'Clear';
      clearBtn.onclick = function(){ clear(); };
      footer.appendChild(hint);
      footer.appendChild(clearBtn);
      drawPanel.appendChild(footer);
      root.appendChild(drawPanel);
      panels.draw = drawPanel;

      drawCtx = canvas.getContext('2d', { willReadFrequently: true });
      drawCtx.strokeStyle = '#111';
      drawCtx.lineWidth = 2;
      drawCtx.lineCap = 'round';
      drawCtx.lineJoin = 'round';

      // Pointer handling (covers mouse + touch via pointer events where available)
      var drawing = false, lastX = 0, lastY = 0, _locked = false;
      function pos(ev){
        var rect = canvas.getBoundingClientRect();
        var sx = canvas.width / rect.width, sy = canvas.height / rect.height;
        var src = ev.touches ? ev.touches[0] : ev;
        return { x:(src.clientX - rect.left) * sx, y:(src.clientY - rect.top) * sy };
      }
      function start(ev){ if(_locked)return; ev.preventDefault(); drawing = true; var p = pos(ev); lastX = p.x; lastY = p.y; }
      function move(ev){ if(!drawing||_locked)return; ev.preventDefault(); var p = pos(ev); drawCtx.beginPath(); drawCtx.moveTo(lastX,lastY); drawCtx.lineTo(p.x,p.y); drawCtx.stroke(); lastX=p.x; lastY=p.y; _updateSignedState(); }
      function end(){ drawing = false; }
      canvas.addEventListener('mousedown', start);
      canvas.addEventListener('mousemove', move);
      canvas.addEventListener('mouseup', end);
      canvas.addEventListener('mouseleave', end);
      canvas.addEventListener('touchstart', start, {passive:false});
      canvas.addEventListener('touchmove', move, {passive:false});
      canvas.addEventListener('touchend', end);
      root._setDrawLocked = function(v){ _locked = !!v; };
    }

    // ── Type panel ──
    var typeInput;
    if (allowTabs.indexOf('type') >= 0) {
      var typePanel = document.createElement('div');
      typePanel.className = 'sigw-panel';
      typePanel.dataset.panel = 'type';
      typePanel.hidden = true;
      var pad = document.createElement('div');
      pad.className = 'sigw-type-pad';
      typeInput = document.createElement('input');
      typeInput.type = 'text';
      typeInput.className = 'sigw-type-input';
      typeInput.placeholder = 'Type full legal name';
      typeInput.addEventListener('input', _updateSignedState);
      var note = document.createElement('div');
      note.className = 'sigw-type-note';
      note.textContent = 'Typing your name constitutes a legal electronic signature';
      pad.appendChild(typeInput);
      pad.appendChild(note);
      typePanel.appendChild(pad);
      root.appendChild(typePanel);
      panels.type = typePanel;
    }

    // ── Wet panel ──
    var wetInput;
    if (allowTabs.indexOf('wet') >= 0) {
      var wetPanel = document.createElement('div');
      wetPanel.className = 'sigw-panel';
      wetPanel.dataset.panel = 'wet';
      wetPanel.hidden = true;
      var wpad = document.createElement('div');
      wpad.className = 'sigw-wet-pad';
      var wnote = document.createElement('div');
      wnote.className = 'sigw-wet-note';
      wnote.textContent = 'Print this form for a wet signature, or send via DocuSign / Adobe Sign and attach the signed copy.';
      wetInput = document.createElement('input');
      wetInput.type = 'text';
      wetInput.className = 'sigw-wet-input';
      wetInput.placeholder = 'Reference # or e-sign envelope ID (optional)';
      wetInput.addEventListener('input', _updateSignedState);
      wpad.appendChild(wnote);
      wpad.appendChild(wetInput);
      wetPanel.appendChild(wpad);
      root.appendChild(wetPanel);
      panels.wet = wetPanel;
    }

    // Mount
    if (mountEl && mountEl.appendChild) mountEl.appendChild(root);

    // ── Controller state ──
    var currentMethod = allowTabs[0] || 'draw';
    var locked = false;

    function setMethod(method) {
      if (locked) return;
      if (!panels[method]) return;
      currentMethod = method;
      Object.keys(panels).forEach(function(k){
        panels[k].hidden = (k !== method);
        tabBtns[k].classList.toggle('is-active', k === method);
      });
      _updateSignedState();
    }

    function isSigned() {
      if (currentMethod === 'draw' && canvas) {
        try {
          var data = drawCtx.getImageData(0,0,canvas.width,canvas.height).data;
          for (var i = 3; i < data.length; i += 4) if (data[i] > 0) return true;
          return false;
        } catch(e) { return false; }
      }
      if (currentMethod === 'type' && typeInput) return typeInput.value.trim().length > 0;
      if (currentMethod === 'wet'  && wetInput)  return wetInput.value.trim().length > 0;
      return false;
    }

    function _updateSignedState() {
      root.classList.toggle('is-signed', isSigned());
    }

    function getDataURL() {
      // Returns a PNG data URL regardless of method, so downstream print /
      // email code can just slot an <img src=...>.
      if (currentMethod === 'draw' && canvas) {
        return isSigned() ? canvas.toDataURL('image/png') : '';
      }
      if (currentMethod === 'type' && typeInput) {
        var v = typeInput.value.trim();
        return v ? _renderTypedToDataURL(v, canvas ? canvas.width : 700, height) : '';
      }
      // Wet / external e-sign doesn't produce a pixel signature in-app;
      // return empty data URL and caller should use getMeta() for the ref.
      return '';
    }

    function getMeta() {
      return {
        method: currentMethod,
        typedName: typeInput ? typeInput.value.trim() : '',
        wetRef:    wetInput  ? wetInput.value.trim()  : '',
        signed:    isSigned()
      };
    }

    function clear() {
      if (locked) return;
      if (canvas && drawCtx) drawCtx.clearRect(0, 0, canvas.width, canvas.height);
      if (typeInput) typeInput.value = '';
      if (wetInput)  wetInput.value  = '';
      _updateSignedState();
    }

    function lock() {
      locked = true;
      if (root._setDrawLocked) root._setDrawLocked(true);
      if (typeInput) typeInput.disabled = true;
      if (wetInput)  wetInput.disabled  = true;
      Object.keys(tabBtns).forEach(function(k){ tabBtns[k].disabled = true; });
    }

    function unlock() {
      locked = false;
      if (root._setDrawLocked) root._setDrawLocked(false);
      if (typeInput) typeInput.disabled = false;
      if (wetInput)  wetInput.disabled  = false;
      Object.keys(tabBtns).forEach(function(k){ tabBtns[k].disabled = false; });
    }

    // Initialize default tab
    setMethod(currentMethod);

    return {
      id: id,
      root: root,
      setMethod: setMethod,
      getDataURL: getDataURL,
      getMeta: getMeta,
      clear: clear,
      lock: lock,
      unlock: unlock,
      isSigned: isSigned
    };
  }

  // ── createPair ──────────────────────────────────────────────────────
  // Bundles two SigWidgets with a shared Yes/No presence toggle.
  // Everything consumer-specific (CURRENT_USER, role-validation copy,
  // label strings) is passed through opts — the factory just applies.
  //
  // opts shape:
  //   toggleMount: HTMLElement          (required) where to render toggle
  //   toggleLabel: '...'                label next to toggle (default 'Customer Present?')
  //   initialMode: 'yes' | 'no'         default 'yes'
  //   modes: { yes: {...}, no: {...} }  (required) see below
  //   leftNameInput, leftNameNote,      (optional) DOM refs for auto-fill + notes
  //   rightNameInput, rightNameNote,
  //   widgetOpts: {...}                 passed to each create()
  //   onChange: function(mode)          fired after a mode change
  //
  // modes[k] shape:
  //   yesButtonText, noButtonText       button labels (only consulted on 'yes')
  //   description                       subtitle shown next to toggle
  //   left:  { title, sub, nameAuto, nameNote, nameNoteKind }
  //   right: { title, sub, nameAuto, nameNote, nameNoteKind }
  //     nameNoteKind: 'success' | 'warning' | 'danger' | '' (default)
  //
  // Returns:
  //   left, right                       the two controllers
  //   setMode(m), getMode()
  //   lock(), unlock(), isLocked()
  //   isBothSigned()
  //   getDataURLs()  -> {left, right}
  //   root                              the toggle element (for styling)
  function createPair(mountLeft, mountRight, opts) {
    opts = opts || {};
    if (!opts.modes || !opts.modes.yes || !opts.modes.no) {
      throw new Error('SigWidget.createPair: opts.modes.{yes,no} required');
    }
    var widgetOpts = opts.widgetOpts || {};

    // Build the two widgets first so we can reach them from the toggle
    var leftW  = create(mountLeft,  widgetOpts);
    var rightW = create(mountRight, widgetOpts);

    // Build the toggle strip
    var tmount = opts.toggleMount;
    var toggleEl = document.createElement('div');
    toggleEl.className = 'sigw-presence';
    var label = document.createElement('span');
    label.className = 'sigw-presence-label';
    label.textContent = opts.toggleLabel || 'Customer Present?';
    var btnGroup = document.createElement('div');
    btnGroup.className = 'sigw-presence-btns';
    var yesBtn = document.createElement('button');
    yesBtn.type = 'button';
    yesBtn.className = 'sigw-presence-btn';
    yesBtn.textContent = (opts.modes.yes.yesButtonText) || '\u2713 Yes';
    var noBtn = document.createElement('button');
    noBtn.type = 'button';
    noBtn.className = 'sigw-presence-btn';
    noBtn.textContent = (opts.modes.yes.noButtonText) || 'No';
    btnGroup.appendChild(yesBtn);
    btnGroup.appendChild(noBtn);
    var desc = document.createElement('span');
    desc.className = 'sigw-presence-desc';
    toggleEl.appendChild(label);
    toggleEl.appendChild(btnGroup);
    toggleEl.appendChild(desc);
    if (tmount && tmount.appendChild) tmount.appendChild(toggleEl);

    var currentMode = opts.initialMode || 'yes';
    var locked = false;

    function _applyNote(el, text, kind) {
      if (!el) return;
      el.textContent = text || '';
      var c = 'var(--muted)';
      if (kind === 'success') c = 'var(--success)';
      else if (kind === 'warning' || kind === 'danger') c = 'var(--danger)';
      el.style.color = c;
    }

    function _applyPadLabels(side, cfg) {
      // side: 'left' | 'right'; cfg: {title, sub, nameAuto, nameNote, nameNoteKind}
      if (!cfg) return;
      var titleEl = opts[side + 'TitleEl'];
      var subEl   = opts[side + 'SubEl'];
      var nameEl  = opts[side + 'NameInput'];
      var noteEl  = opts[side + 'NameNote'];
      if (titleEl && cfg.title != null) titleEl.innerHTML  = cfg.title;
      if (subEl   && cfg.sub   != null) subEl.textContent  = cfg.sub;
      if (nameEl  && cfg.nameAuto != null && !locked) nameEl.value = cfg.nameAuto;
      if (noteEl) _applyNote(noteEl, cfg.nameNote || '', cfg.nameNoteKind || '');
    }

    function setMode(m) {
      if (locked) return;
      if (m !== 'yes' && m !== 'no') return;
      currentMode = m;
      var modeCfg = opts.modes[m];
      // Update button visuals
      yesBtn.classList.toggle('is-active', m === 'yes');
      noBtn.classList.toggle('is-active',  m === 'no');
      // Update description
      desc.textContent = modeCfg.description || '';
      // Apply labels + name inputs + notes
      _applyPadLabels('left',  modeCfg.left);
      _applyPadLabels('right', modeCfg.right);
      // Clear pads on switch
      leftW.clear();
      rightW.clear();
      if (typeof opts.onChange === 'function') opts.onChange(m);
    }

    yesBtn.onclick = function(){ setMode('yes'); };
    noBtn.onclick  = function(){ setMode('no');  };

    // Initial application
    setMode(currentMode);

    function lock() {
      locked = true;
      leftW.lock(); rightW.lock();
      yesBtn.disabled = true; noBtn.disabled = true;
    }
    function unlock() {
      locked = false;
      leftW.unlock(); rightW.unlock();
      yesBtn.disabled = false; noBtn.disabled = false;
    }
    function isBothSigned() { return leftW.isSigned() && rightW.isSigned(); }
    function getDataURLs() { return { left: leftW.getDataURL(), right: rightW.getDataURL() }; }

    return {
      left: leftW,
      right: rightW,
      root: toggleEl,
      setMode: setMode,
      getMode: function(){ return currentMode; },
      lock: lock,
      unlock: unlock,
      isLocked: function(){ return locked; },
      isBothSigned: isBothSigned,
      getDataURLs: getDataURLs
    };
  }

  return { create: create, createPair: createPair };
})();


// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
// SHARED DOCUMENT LIBRARY FACTORY (Phase F3B — shared JS, v2)
//
// Single entry point: window.DocLibrary.create(mountEl, opts)
// Produces an upload + list + delete UI for per-entity document storage.
// Storage backend: Supabase Storage bucket (path-scoped per entity).
// Metadata backend: audit-log row with `detail` JSON (category lives here
// in v1; will move to its own column in Phase F3C).
//
// Designed zero-dependency: no jQuery, no getData(), no toast(), no
// window.NATION_CONFIG reads inside the factory. Everything is passed via
// opts so the factory can be lifted verbatim into /shared.js in Phase C.
//
// Opts (all in window.DocLibrary.create(mountEl, opts)):
//   REQUIRED:
//     entityType, entityId, pathPrefix, supabaseUrl, supabaseAnon,
//     storageBucket
//   OPTIONAL:
//     auditTable       default 'housing_audit_log'
//     categories       array of {key,label,icon?}; default [{Other}]
//     getActor         function returning the actor string for audit rows
//     getAuthToken     function returning a bearer token override
//     readOnly         hides upload + delete controls
//     maxSizeMB        per-file upload cap, default 25
//     onChange         (action, file) => void — hook for external refresh
//     customLoader     async () => files[] — replaces default audit-log
//                      fetch. Files must have {path,name,size?,type?,
//                      category?,addedAt?,addedBy?}; extra fields are
//                      preserved on the file object and reach customDelete.
//                      Use when files come from a non-audit-log source
//                      (e.g. app_documents table + storage listing).
//     customDelete     async (file) => void — replaces default storage +
//                      tombstone delete flow. Receives the full file
//                      object from customLoader; should return a Promise
//                      that resolves after the delete is committed.
//
// Uses existing shared styles: std-table-card, std-table, tic-hist-chip,
// plus a few doclib-* classes added to shared.css for upload area.
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
window.DocLibrary = (function(){
  'use strict';

  // ── Helpers ──────────────────────────────────────────────────────────
  function _fmtBytes(b) {
    if (b == null || isNaN(b)) return '\u2014';
    if (b < 1024) return b + ' B';
    if (b < 1024*1024) return (b/1024).toFixed(0) + ' KB';
    return (b/1024/1024).toFixed(1) + ' MB';
  }
  function _safeName(n) { return String(n || 'file').replace(/[^a-zA-Z0-9._-]/g, '_'); }
  function _iconForType(mime) {
    mime = (mime||'').toLowerCase();
    if (mime.indexOf('pdf') >= 0) return '\uD83D\uDCC4';
    if (mime.indexOf('image') >= 0) return '\uD83D\uDDBC\uFE0F';
    if (mime.indexOf('word') >= 0 || mime.indexOf('officedocument') >= 0) return '\uD83D\uDCDD';
    if (mime.indexOf('sheet') >= 0 || mime.indexOf('excel') >= 0) return '\uD83D\uDCCA';
    return '\uD83D\uDCCE';
  }
  function _escAttr(s) { return String(s||'').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
  function _escHtml(s) {
    return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // ── Network layer ────────────────────────────────────────────────────
  // All calls use raw fetch() + REST/Storage endpoints. No supabase-js.
  function _storageHeaders(opts) {
    var tok = (typeof opts.getAuthToken === 'function' && opts.getAuthToken()) || opts.supabaseAnon;
    return { 'apikey': opts.supabaseAnon, 'Authorization': 'Bearer ' + tok };
  }
  function _restHeaders(opts) {
    var tok = (typeof opts.getAuthToken === 'function' && opts.getAuthToken()) || opts.supabaseAnon;
    return {
      'apikey': opts.supabaseAnon,
      'Authorization': 'Bearer ' + tok,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    };
  }

  function _mimeType(file) {
    // Browsers sometimes return empty or wrong MIME for Office files.
    // Use file extension as authoritative source when browser type is absent.
    var t = file.type || '';
    if (t && t !== 'application/octet-stream') return t;
    var ext = (file.name || '').split('.').pop().toLowerCase();
    var map = {
      'pdf':  'application/pdf',
      'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'doc':  'application/msword',
      'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'xls':  'application/vnd.ms-excel',
      'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'png':  'image/png',
      'jpg':  'image/jpeg',
      'jpeg': 'image/jpeg',
      'gif':  'image/gif',
      'webp': 'image/webp',
      'txt':  'text/plain',
      'csv':  'text/csv',
    };
    return map[ext] || 'application/octet-stream';
  }

  function _uploadBytes(opts, path, file) {
    var url = opts.supabaseUrl + '/storage/v1/object/' + opts.storageBucket + '/' + path;
    return fetch(url, {
      method: 'POST',
      headers: Object.assign({}, _storageHeaders(opts), {
        'Content-Type': _mimeType(file),
        'x-upsert': 'true'
      }),
      body: file
    });
  }

  function _signUrl(opts, path) {
    var url = opts.supabaseUrl + '/storage/v1/object/sign/' + opts.storageBucket + '/' + path;
    return fetch(url, {
      method: 'POST',
      headers: Object.assign({}, _storageHeaders(opts), { 'Content-Type':'application/json' }),
      body: JSON.stringify({ expiresIn: 3600 })
    }).then(function(r){ return r.ok ? r.json() : null; })
      .then(function(d){
        if (!d || !d.signedURL && !d.signedUrl) return null;
        var rel = d.signedURL || d.signedUrl;
        // Supabase returns a relative path; prepend storage host
        return opts.supabaseUrl + '/storage/v1' + rel;
      });
  }

  function _deleteObject(opts, path) {
    var url = opts.supabaseUrl + '/storage/v1/object/' + opts.storageBucket + '/' + path;
    return fetch(url, { method:'DELETE', headers: _storageHeaders(opts) });
  }

  function _saveMeta(opts, path, name, size, type, category) {
    var url = opts.supabaseUrl + '/rest/v1/' + opts.auditTable;
    var actor = (typeof opts.getActor === 'function' && opts.getActor()) || 'staff';
    // Column name is `detail` (singular) in both housing_audit_log and
    // finance_audit_log. Type differs: housing is text, finance is jsonb.
    // opts.detailAsJson:true sends the object directly (jsonb-friendly);
    // default stringifies (text-friendly). See PLAN.md schema notes.
    var detailPayload = { path:path, name:name, size:size, type:type, category:category||'other',
                          actor_name: (window.HOUSING_SESSION && window.HOUSING_SESSION.name) || '' };
    return fetch(url, {
      method: 'POST',
      headers: _restHeaders(opts),
      body: JSON.stringify({
        entity_type: opts.entityType,
        entity_id:   String(opts.entityId),
        action:      'file_uploaded',
        detail:      opts.detailAsJson ? detailPayload : JSON.stringify(detailPayload),
        actor:       actor,
        created_at:  new Date().toISOString()
      })
    });
  }

  function _loadMeta(opts) {
    // We list by entity + action=file_uploaded AND exclude any rows that
    // have been marked 'file_deleted' for the same path. A small query
    // gets us both in one round-trip.
    // Column is `detail` (singular). housing_audit_log stores it as text
    // (stringified JSON); finance_audit_log stores it as jsonb (object).
    // _parseDetail handles both cases tolerantly.
    var base = opts.supabaseUrl + '/rest/v1/' + opts.auditTable +
      '?entity_type=eq.' + encodeURIComponent(opts.entityType) +
      '&entity_id=eq.' + encodeURIComponent(String(opts.entityId)) +
      '&action=in.(file_uploaded,file_deleted,file_category_changed,file_archived,file_restored)' +
      '&order=created_at.desc&limit=500';
    var tok = (typeof opts.getAuthToken === 'function' && opts.getAuthToken()) || opts.supabaseAnon;
    return fetch(base, {
      headers: { 'apikey': opts.supabaseAnon, 'Authorization': 'Bearer ' + tok, 'Accept':'application/json' }
    }).then(function(r){ return r.ok ? r.json() : []; })
      .then(function(rows){
        if (!Array.isArray(rows)) return [];
        var deletedPaths = {};
        var categoryOverrides = {}; // path → latest category
        var archivedState = {};     // path → true/false (latest archive/restore wins)
        // Rows are ordered desc — first occurrence of each action per path wins.
        var seenCatPath = {};
        var seenArchPath = {};
        rows.forEach(function(r){
          if (r.action === 'file_deleted') {
            var d = _parseDetail(r.detail);
            if (d.path) deletedPaths[d.path] = true;
          }
          if (r.action === 'file_category_changed') {
            var d = _parseDetail(r.detail);
            if (d.path && d.category && !seenCatPath[d.path]) {
              seenCatPath[d.path] = true;
              categoryOverrides[d.path] = d.category;
            }
          }
          if (r.action === 'file_archived' || r.action === 'file_restored') {
            var da = _parseDetail(r.detail);
            if (da.path && !seenArchPath[da.path]) {
              seenArchPath[da.path] = true;
              archivedState[da.path] = (r.action === 'file_archived');
            }
          }
        });
        var files = [];
        var seenPath = {};
        rows.forEach(function(r){
          if (r.action !== 'file_uploaded') return;
          var d = _parseDetail(r.detail);
          if (!d.path || deletedPaths[d.path]) return;
          if (seenPath[d.path]) return;
          seenPath[d.path] = true;
          files.push({
            path: d.path,
            name: d.name || d.path.split('/').pop(),
            size: d.size || 0,
            type: d.type || '',
            category: categoryOverrides[d.path] || d.category || 'other',
            archived: !!archivedState[d.path],
            addedAt: (r.created_at || '').slice(0,10),
            addedBy: r.actor || ''
          });
        });
        return files;
      });
  }

  // Tolerant: handles text columns (stringified JSON) and jsonb columns
  // (already-parsed objects). Returns {} on anything unparseable.
  function _parseDetail(v) {
    if (v == null) return {};
    if (typeof v === 'object') return v;
    if (typeof v === 'string') {
      try { return JSON.parse(v); } catch(e) { return {}; }
    }
    return {};
  }

  function _markDeleted(opts, path, name) {
    var url = opts.supabaseUrl + '/rest/v1/' + opts.auditTable;
    var actor = (typeof opts.getActor === 'function' && opts.getActor()) || 'staff';
    var detailPayload = { path:path, name:name };
    return fetch(url, {
      method:'POST',
      headers: _restHeaders(opts),
      body: JSON.stringify({
        entity_type: opts.entityType,
        entity_id:   String(opts.entityId),
        action:      'file_deleted',
        detail:      opts.detailAsJson ? detailPayload : JSON.stringify(detailPayload),
        actor:       actor,
        created_at:  new Date().toISOString()
      })
    });
  }

  // Soft-archive / restore a file — writes an append-only audit row. The object
  // is NEVER removed from storage; it is only hidden from the normal list and
  // recoverable via restore. Opt-in per DocLibrary via opts.canArchive.
  function _markArchived(opts, path, name, archive) {
    var url = opts.supabaseUrl + '/rest/v1/' + opts.auditTable;
    var actor = (typeof opts.getActor === 'function' && opts.getActor()) || 'staff';
    var detailPayload = { path:path, name:name };
    return fetch(url, {
      method:'POST',
      headers: _restHeaders(opts),
      body: JSON.stringify({
        entity_type: opts.entityType,
        entity_id:   String(opts.entityId),
        action:      archive ? 'file_archived' : 'file_restored',
        detail:      opts.detailAsJson ? detailPayload : JSON.stringify(detailPayload),
        actor:       actor,
        created_at:  new Date().toISOString()
      })
    });
  }

  function _updateCategory(opts, path, name, newCategory) {
    var url = opts.supabaseUrl + '/rest/v1/' + opts.auditTable;
    var actor = (typeof opts.getActor === 'function' && opts.getActor()) || 'staff';
    var detailPayload = { path:path, name:name, category:newCategory };
    return fetch(url, {
      method:'POST',
      headers: _restHeaders(opts),
      body: JSON.stringify({
        entity_type: opts.entityType,
        entity_id:   String(opts.entityId),
        action:      'file_category_changed',
        detail:      opts.detailAsJson ? detailPayload : JSON.stringify(detailPayload),
        actor:       actor,
        created_at:  new Date().toISOString()
      })
    });
  }

  // ── Factory ──────────────────────────────────────────────────────────
  function create(mountEl, opts) {
    opts = opts || {};
    // Required opts
    ['entityType','entityId','pathPrefix','supabaseUrl','supabaseAnon','storageBucket']
      .forEach(function(k){ if (!opts[k]) throw new Error('DocLibrary: opts.'+k+' required'); });
    // Defaults
    opts.categories = opts.categories && opts.categories.length ? opts.categories : [
      { key:'other', label:'Other', icon:'\uD83D\uDCCE' }
    ];
    opts.auditTable = opts.auditTable || 'housing_audit_log';
    opts.maxSizeMB  = opts.maxSizeMB || 25;

    var state = {
      files: [],
      loading: true,
      filter: 'all',      // category key or 'all'
      uploadCategory: opts.categories[0].key,
      uploading: false,
      error: null,
      showArchived: false // when opts.canArchive: toggles the archived-files view
    };

    // Build DOM once
    var root = document.createElement('div');
    root.className = 'std-table-card doclib';
    mountEl.appendChild(root);

    function render() {
      // Archived files are hidden from the normal list everywhere; the archived
      // view (and the archive/restore actions) is only offered when canArchive.
      var activeFiles   = state.files.filter(function(f){ return !f.archived; });
      var archivedFiles = state.files.filter(function(f){ return f.archived; });
      var inArchived = !!(opts.canArchive && state.showArchived);
      var viewFiles = inArchived ? archivedFiles : activeFiles;

      var hasFiles = viewFiles.length > 0;
      var filtered = state.filter === 'all'
        ? viewFiles
        : viewFiles.filter(function(f){ return f.category === state.filter; });
      var totalCount = viewFiles.length;
      var shownCount = filtered.length;

      var catByKey = {};
      opts.categories.forEach(function(c){ catByKey[c.key] = c; });

      // Header (+ optional archived-view toggle when the viewer may archive)
      var archiveToggleHTML = '';
      if (opts.canArchive) {
        archiveToggleHTML = inArchived
          ? '<button type="button" class="btn btn-ghost btn-sm" data-dl-arch-toggle>\u2190 Back to active</button>'
          : (archivedFiles.length
              ? '<button type="button" class="btn btn-ghost btn-sm" data-dl-arch-toggle>\uD83D\uDDC4 Archived ('+archivedFiles.length+')</button>'
              : '');
      }
      var headerHTML =
        '<div class="std-table-hdr">' +
          '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">' +
            '<h3 style="margin:0;font-size:15px;font-weight:700;">Documents' + (inArchived ? ' \u00B7 Archived' : '') + '</h3>' +
            '<span class="std-table-count">' +
              (shownCount === totalCount ? totalCount + ' total' : shownCount + ' shown \u00B7 ' + totalCount + ' total') +
            '</span>' +
          '</div>' +
          (archiveToggleHTML ? '<div>'+archiveToggleHTML+'</div>' : '') +
        '</div>';

      // Upload area (skipped when readOnly or viewing the archived list)
      var uploadHTML = '';
      if (!opts.readOnly && !inArchived) {
        var catOptions = opts.categories.map(function(c){
          var sel = c.key === state.uploadCategory ? ' selected' : '';
          return '<option value="'+_escAttr(c.key)+'"'+sel+'>'+(c.icon?c.icon+' ':'')+_escHtml(c.label)+'</option>';
        }).join('');
        uploadHTML =
          '<div class="doclib-upload-area">' +
            '<div class="doclib-upload-drop" data-dl-drop>' +
              '<input type="file" multiple data-dl-file-input style="display:none;">' +
              '<span class="doclib-upload-icon">\uD83D\uDCC1</span>' +
              '<div class="doclib-upload-text">' +
                '<strong>Drop files here or click to upload</strong>' +
                '<span>Max ' + opts.maxSizeMB + ' MB per file</span>' +
              '</div>' +
            '</div>' +
            '<div class="doclib-upload-cat">' +
              '<label class="doclib-upload-cat-label">Category</label>' +
              '<select data-dl-cat class="std-filter-control">'+catOptions+'</select>' +
            '</div>' +
          '</div>' +
          (state.uploading ? '<div class="doclib-status doclib-status-info">Uploading\u2026</div>' : '') +
          (state.error ? '<div class="doclib-status doclib-status-error">'+_escHtml(state.error)+'</div>' : '');
      }

      // Filter chips
      var chipAll = '<button type="button" class="tic-hist-chip' +
        (state.filter==='all'?' is-active':'') + '" data-dl-chip="all">All</button>';
      var chips = opts.categories.map(function(c){
        var active = state.filter === c.key ? ' is-active' : '';
        return '<button type="button" class="tic-hist-chip'+active+'" data-dl-chip="'+_escAttr(c.key)+'">' +
          (c.icon ? c.icon + ' ' : '') + _escHtml(c.label) + '</button>';
      }).join('');
      var filterHTML =
        '<div class="doclib-filter-row">' +
          '<span class="doclib-filter-label">Category</span>' +
          '<div class="doclib-filter-chips">' + chipAll + chips + '</div>' +
        '</div>';

      // Table body
      var bodyRows;
      if (state.loading) {
        bodyRows = '<tr class="empty-row"><td colspan="5">Loading\u2026</td></tr>';
      } else if (!hasFiles) {
        bodyRows = '<tr class="empty-row"><td colspan="5">No documents yet.' +
          (opts.readOnly ? '' : ' Upload your first file above.') + '</td></tr>';
      } else if (!filtered.length) {
        bodyRows = '<tr class="empty-row"><td colspan="5">No documents match this filter.</td></tr>';
      } else {
        bodyRows = filtered.map(function(f){
          var cat = catByKey[f.category] || { label: f.category || 'Other', icon:'\uD83D\uDCCE' };
          var mime = (f.type || '').toLowerCase();
          var isImage = mime.indexOf('image') === 0 ||
            /\.(jpg|jpeg|png|gif|webp|heic|heif|bmp|svg)$/i.test(f.name);
          var icon = isImage
            ? '<img data-dl-thumb="'+_escAttr(f.path)+'" src="" alt="" '+
                'style="width:36px;height:36px;object-fit:cover;border-radius:4px;border:1px solid var(--border);display:none;">'
            : '<span style="font-size:16px;">'+_iconForType(f.type)+'</span>';
          var categoryCell;
          if (opts.readOnly || inArchived) {
            categoryCell = '<span class="std-pill std-pill-info">' + (cat.icon?cat.icon+' ':'') + _escHtml(cat.label) + '</span>';
          } else {
            var catOpts = opts.categories.map(function(c){
              return '<option value="'+_escAttr(c.key)+'"'+(c.key===f.category?' selected':'')+'>'+
                (c.icon?c.icon+' ':'')+_escHtml(c.label)+'</option>';
            }).join('');
            categoryCell = '<select class="std-filter-control doclib-cat-edit" '+
              'data-dl-cat-edit="'+_escAttr(f.path)+'" '+
              'data-dl-cat-name="'+_escAttr(f.name)+'" '+
              'style="font-size:12px;padding:3px 6px;min-width:110px;">'+catOpts+'</select>';
          }
          return '<tr>' +
            '<td style="width:44px;padding:6px 4px;">'+icon+'</td>' +
            '<td class="std-cell-primary" style="max-width:320px;white-space:normal;word-break:break-word;">' +
              _escHtml(f.name.replace(/^\d+_/, '')) +
              '<div style="font-size:11px;color:var(--muted);font-weight:normal;">' +
                _escHtml(f.addedAt||'') + (f.addedBy?' \u00B7 '+_escHtml(f.addedBy):'') + '</div>' +
            '</td>' +
            '<td>'+categoryCell+'</td>' +
            '<td class="std-cell-right std-cell-mono">'+_fmtBytes(f.size)+'</td>' +
            '<td class="std-cell-tail" style="white-space:nowrap;">' +
              '<button class="btn btn-ghost btn-sm" data-dl-view="'+_escAttr(f.path)+'">View</button>' +
              (inArchived
                ? (opts.canArchive ? ' <button class="btn btn-ghost btn-sm" data-dl-restore="'+_escAttr(f.path)+'" data-dl-restore-name="'+_escAttr(f.name)+'">Restore</button>' : '')
                : (
                    (opts.canArchive ? ' <button class="btn btn-ghost btn-sm" data-dl-arch="'+_escAttr(f.path)+'" data-dl-arch-name="'+_escAttr(f.name)+'">Archive</button>' : '') +
                    (opts.readOnly ? '' : ' <button class="btn btn-ghost btn-sm" style="color:var(--danger);" data-dl-del="'+_escAttr(f.path)+'" data-dl-del-name="'+_escAttr(f.name)+'">Delete</button>')
                  )
              ) +
            '</td>' +
          '</tr>';
        }).join('');
      }

      var tableHTML =
        '<div class="doclib-table-wrap">' +
          '<table class="std-table doclib-table">' +
            '<thead><tr>' +
              '<th></th><th>File</th><th>Category</th>' +
              '<th class="std-cell-right">Size</th>' +
              '<th class="std-cell-tail">Actions</th>' +
            '</tr></thead>' +
            '<tbody>'+bodyRows+'</tbody>' +
          '</table>' +
        '</div>';

      root.innerHTML = headerHTML + uploadHTML + filterHTML + tableHTML;

      _wireEvents();
    }

    function _wireEvents() {
      // Chip click
      root.querySelectorAll('[data-dl-chip]').forEach(function(btn){
        btn.onclick = function(){ state.filter = btn.getAttribute('data-dl-chip'); render(); };
      });
      // Archived-view toggle
      var archToggle = root.querySelector('[data-dl-arch-toggle]');
      if (archToggle) archToggle.onclick = function(){ state.showArchived = !state.showArchived; state.filter = 'all'; render(); };
      // Archive a file (soft-hide, recoverable)
      root.querySelectorAll('[data-dl-arch]').forEach(function(btn){
        btn.onclick = function(){
          var p = btn.getAttribute('data-dl-arch');
          var n = btn.getAttribute('data-dl-arch-name');
          btn.disabled = true;
          _markArchived(opts, p, n, true).then(function(){
            var file = state.files.find(function(f){ return f.path === p; });
            if (file) file.archived = true;
            if (typeof opts.onChange === 'function') opts.onChange('archive', file);
            render();
          }).catch(function(){ _setError('Could not archive that file.'); btn.disabled = false; });
        };
      });
      // Restore an archived file
      root.querySelectorAll('[data-dl-restore]').forEach(function(btn){
        btn.onclick = function(){
          var p = btn.getAttribute('data-dl-restore');
          var n = btn.getAttribute('data-dl-restore-name');
          btn.disabled = true;
          _markArchived(opts, p, n, false).then(function(){
            var file = state.files.find(function(f){ return f.path === p; });
            if (file) file.archived = false;
            if (typeof opts.onChange === 'function') opts.onChange('restore', file);
            render();
          }).catch(function(){ _setError('Could not restore that file.'); btn.disabled = false; });
        };
      });
      // Category dropdown (upload)
      var cat = root.querySelector('[data-dl-cat]');
      if (cat) cat.onchange = function(){ state.uploadCategory = cat.value; };
      // Drop zone click opens file picker
      var drop = root.querySelector('[data-dl-drop]');
      var fi   = root.querySelector('[data-dl-file-input]');
      if (drop && fi) {
        drop.onclick = function(){ fi.click(); };
        drop.ondragover = function(e){ e.preventDefault(); drop.classList.add('is-drag'); };
        drop.ondragleave = function(){ drop.classList.remove('is-drag'); };
        drop.ondrop = function(e){
          e.preventDefault(); drop.classList.remove('is-drag');
          if (e.dataTransfer && e.dataTransfer.files) _handleFiles(e.dataTransfer.files);
        };
        fi.onchange = function(){ _handleFiles(fi.files); fi.value = ''; };
      }
      // Image thumbnails — lazy-load signed URLs
      root.querySelectorAll('[data-dl-thumb]').forEach(function(img){
        var path = img.getAttribute('data-dl-thumb');
        // Memoize signed URLs per path (valid 1h; cache for 45min). Without
        // this, every render — each chip click, category change, upload, and
        // error banner — re-signed EVERY visible thumbnail: 30 photos meant 30
        // Storage sign requests per filter click on the slow cell connections
        // this app is designed around.
        state._thumbUrlCache = state._thumbUrlCache || {};
        var hit = state._thumbUrlCache[path];
        if (hit && hit.exp > Date.now()) {
          img.src = hit.url; img.style.display = 'block';
          return;
        }
        _signUrl(opts, path).then(function(u){
          if (u) {
            state._thumbUrlCache[path] = { url: u, exp: Date.now() + 45*60*1000 };
            img.src = u; img.style.display = 'block';
          }
        }).catch(function(){});
      });
      // Inline category edit
      root.querySelectorAll('[data-dl-cat-edit]').forEach(function(sel){
        sel.onchange = function(){
          var path    = sel.getAttribute('data-dl-cat-edit');
          var name    = sel.getAttribute('data-dl-cat-name');
          var newCat  = sel.value;
          var file    = state.files.find(function(f){ return f.path === path; });
          if (file) file.category = newCat;
          _updateCategory(opts, path, name, newCat).catch(function(e){
            console.warn('[doclib] category update failed:', e);
            _setError('Could not save category change.');
          });
          if (typeof opts.onChange === 'function') opts.onChange('category', file);
        };
      });
      // View + delete
      root.querySelectorAll('[data-dl-view]').forEach(function(btn){
        btn.onclick = function(){
          var p = btn.getAttribute('data-dl-view');
          _signUrl(opts, p).then(function(u){
            if (u) window.open(u, '_blank');
            else _setError('Could not generate link for that file.');
          }).catch(function(){ _setError('Could not generate link for that file.'); });
        };
      });
      root.querySelectorAll('[data-dl-del]').forEach(function(btn){
        btn.onclick = function(){
          var p = btn.getAttribute('data-dl-del');
          var n = btn.getAttribute('data-dl-del-name').replace(/^\d+_/, '');
          // Branded confirm modal — replaces browser confirm()
          var ov = document.createElement('div');
          ov.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:20px;';
          ov.innerHTML =
            '<div style="background:var(--surface);border-radius:14px;max-width:420px;width:100%;box-shadow:0 24px 60px rgba(0,0,0,.35);overflow:hidden;">' +
              '<div class="modal-hdr compact">' +
                '<div>' +
                  '<div class="modal-hdr-title">Delete File?</div>' +
                  '<div class="modal-hdr-sub">This cannot be undone</div>' +
                '</div>' +
              '</div>' +
              '<div style="padding:20px;">' +
                '<p style="margin:0 0 20px;font-size:13px;color:var(--muted);line-height:1.5;">' +
                  'Are you sure you want to delete <strong style="color:var(--text);">' + _escHtml(n) + '</strong>?' +
                '</p>' +
                '<div style="display:flex;gap:10px;justify-content:flex-end;">' +
                  '<button class="btn btn-ghost" data-dl-cancel>Cancel</button>' +
                  '<button class="btn" style="background:var(--danger);color:#fff;border-color:var(--danger);" data-dl-confirm>Delete</button>' +
                '</div>' +
              '</div>' +
            '</div>';
          document.body.appendChild(ov);
          ov.querySelector('[data-dl-cancel]').onclick = function(){ document.body.removeChild(ov); };
          ov.addEventListener('click', function(e){ if (e.target === ov) document.body.removeChild(ov); });
          ov.querySelector('[data-dl-confirm]').onclick = function(){
            document.body.removeChild(ov);
            btn.disabled = true;
          var file = state.files.find(function(f){ return f.path === p; }) || { path:p, name:n };
          var deleteFlow;
          if (typeof opts.customDelete === 'function') {
            deleteFlow = Promise.resolve(opts.customDelete(file));
          } else {
            deleteFlow = _deleteObject(opts, p).then(function(){ return _markDeleted(opts, p, n); });
          }
          deleteFlow
            .then(function(){
              state.files = state.files.filter(function(f){ return f.path !== p; });
              // Stop tracking it as a pending upload so refresh() won't re-add it.
              if (state.pendingUploads) delete state.pendingUploads[p];
              if (typeof opts.onChange === 'function') opts.onChange('delete', file);
              render();
            })
            .catch(function(){ _setError('Delete failed.'); btn.disabled = false; });
          };
        };
      });
    }

    function _setError(msg) {
      state.error = msg; render();
      setTimeout(function(){ state.error = null; render(); }, 4000);
    }

    function _handleFiles(fileList) {
      if (!fileList || !fileList.length) return;
      var files = Array.prototype.slice.call(fileList);
      // Size guard
      var tooBig = files.filter(function(f){ return f.size > opts.maxSizeMB * 1024 * 1024; });
      if (tooBig.length) { _setError('Some files exceed the '+opts.maxSizeMB+' MB limit.'); return; }

      state.uploading = true; state.error = null; render();

      // Sequential uploads \u2014 keeps order predictable + avoids rate limits
      function next(i) {
        if (i >= files.length) {
          state.uploading = false;
          return refresh();
        }
        var f = files[i];
        var ts = Date.now();
        var path = opts.pathPrefix.replace(/\/$/,'') + '/' + ts + '_' + _safeName(f.name);
        _uploadBytes(opts, path, f).then(function(r){
          if (!r.ok) {
            return r.text().then(function(body){
              console.error('[DocLib] Storage upload failed:', r.status, body, 'path:', path, 'type:', _mimeType(f));
              throw new Error('storage '+r.status+': ' + body);
            });
          }
          // Storage upload succeeded — now record the metadata. If THIS step
          // fails (RLS denial on housing_audit_log), the file is in Storage but
          // invisible in the UI; the catch below surfaces that explicitly.
          return _saveMeta(opts, path, f.name, f.size, f.type, state.uploadCategory).then(function(metaResp){
            if (metaResp && !metaResp.ok) {
              return metaResp.text().then(function(body){
                console.error('[DocLib] Metadata save failed:', metaResp.status, body);
                throw new Error('metadata '+metaResp.status+': ' + body);
              });
            }
          });
        }).then(function(){
          // Optimistic insert — show the file immediately rather than waiting for
          // the audit-log re-read, which can race the just-written file_uploaded
          // row (the "uploaded but doesn't show at first" symptom). Tracked in
          // state.pendingUploads and reconciled by refresh() once the server
          // read confirms it.
          var optimistic = {
            path:     path,
            name:     f.name,
            size:     f.size,
            type:     f.type || '',
            category: state.uploadCategory || 'other',
            addedAt:  new Date().toISOString().slice(0,10),
            addedBy:  (typeof opts.getActor === 'function' && opts.getActor()) || ''
          };
          state.pendingUploads = state.pendingUploads || {};
          state.pendingUploads[path] = optimistic;
          if (!state.files.some(function(x){ return x.path === path; })) {
            state.files.unshift(optimistic);
          }
          render();
          if (typeof opts.onChange === 'function') {
            opts.onChange('upload', { path:path, name:f.name, category:state.uploadCategory });
          }
          next(i+1);
        }).catch(function(err){
          var msg = (err && err.message) ? err.message : 'unknown error';
          _setError('Upload failed: ' + f.name + ' (' + msg + ')');
          // Also fire a toast — the in-widget banner auto-dismisses and users
          // miss it. The toast keeps the failure visible long enough to read.
          if (typeof window.showToast === 'function') {
            window.showToast('Upload failed: ' + f.name, { type:'error' });
          }
          // CONTINUE with the remaining files — the old code aborted the whole
          // batch here, so dropping 5 files with a transient failure on #2
          // silently never attempted #3–#5 (and skipped the final refresh).
          next(i+1);
        });
      }
      next(0);
    }

    function refresh() {
      state.loading = true; render();
      // customLoader opt overrides the default audit-log load. Expected
      // return: Promise resolving to an array of {path, name, size, type,
      // category?, addedAt?, addedBy?} objects. Any extra fields (like
      // scorecard's docId) are preserved on the file object and reach
      // customDelete if set.
      var loader = (typeof opts.customLoader === 'function')
        ? opts.customLoader()
        : _loadMeta(opts);
      return Promise.resolve(loader).then(function(files){
        var serverFiles = Array.isArray(files) ? files : [];
        // Reconcile optimistic uploads: keep any just-uploaded file the server
        // read doesn't yet reflect (read-after-write race), and stop tracking a
        // pending file once the server confirms it. Guarantees an upload never
        // flickers away between the optimistic insert and the server catching up.
        var pend = state.pendingUploads || {};
        var serverPaths = {};
        serverFiles.forEach(function(x){ if (x && x.path) serverPaths[x.path] = true; });
        Object.keys(pend).forEach(function(p){
          if (serverPaths[p]) { delete pend[p]; }      // confirmed persisted
          else { serverFiles.unshift(pend[p]); }        // not visible yet — keep showing
        });
        state.files = serverFiles;
        state.loading = false;
        render();
      }).catch(function(){
        state.loading = false;
        _setError('Could not load documents.');
      });
    }

    // Initial render + load
    render();
    refresh();

    return {
      root: root,
      refresh: refresh,
      setCategoryFilter: function(k){ state.filter = k; render(); },
      getFiles: function(){ return state.files.slice(); }
    };
  }

  return { create: create };
})();


// ═══════════════════════════════════════════════════════════════════════
// SUPABASE STORAGE HELPERS (Phase C — extracted from housing/renos)
// ───────────────────────────────────────────────────────────────────────
// These helpers were duplicated byte-for-byte across housing.html and
// renos.html. They now live here and both apps get them from shared.js.
//
// Config dependencies — these must exist as window globals BEFORE any
// helper is called. Both housing.html and renos.html already declare
// them near the top of their scripts:
//   window.SUPABASE_URL     — Supabase project URL (from NATION_CONFIG)
//   window.SUPABASE_ANON    — anon/public key (from NATION_CONFIG)
//   window.STORAGE_BUCKET   — bucket name (from NATION_CONFIG, or
//                             'housing-files' default)
//   window.HOUSING_HEADERS  — {'apikey', 'Authorization'} object used
//                             by housing_audit_log REST calls
//   window.currentRole      — optional; used as the audit 'actor'
//   window._sb              — optional; Supabase JS client for signed URLs
//
// Path conventions:
//   tenants/{unitId}/{timestamp}_{filename}
//   applications/{appId}/{timestamp}_{filename}
//   contractors/{contractorId}/{bucket}/{timestamp}_{filename}
//   units/{unitId}/photos/{timestamp}_{filename}
//   sow/{unitId}/{timestamp}_{filename}
//
// Exposes both window.SbStorage (namespaced) and the legacy top-level
// names (sbUploadFile, sbGetSignedUrl, etc.) — the latter because 15+
// existing call sites use them bare.
// ═══════════════════════════════════════════════════════════════════════
(function(){
  'use strict';

  function sbStorageHeaders() {
    var h = { 'apikey': window.SUPABASE_ANON };
    if (window.HOUSING_HEADERS && window.HOUSING_HEADERS['Authorization']) {
      h['Authorization'] = window.HOUSING_HEADERS['Authorization'];
    }
    return h;
  }

  // Return authenticated URL with properly encoded path and token
  function sbGetFileUrl(path) {
    var token = (window.HOUSING_HEADERS && window.HOUSING_HEADERS['Authorization'] || '').replace('Bearer ','');
    var encodedPath = path.split('/').map(function(seg){ return encodeURIComponent(seg); }).join('/');
    var base = window.SUPABASE_URL + '/storage/v1/object/authenticated/' + window.STORAGE_BUCKET + '/' + encodedPath;
    return token ? (base + '?token=' + encodeURIComponent(token)) : base;
  }

  // Upload a File object to Supabase Storage. Returns {path, url} or throws.
  async function sbUploadFile(path, file) {
    var url = window.SUPABASE_URL + '/storage/v1/object/' + window.STORAGE_BUCKET + '/' + path;
    var res = await fetch(url, {
      method: 'POST',
      headers: Object.assign({}, sbStorageHeaders(), { 'x-upsert': 'true' }),
      body: file
    });
    if (!res.ok) {
      var err = await res.text();
      throw new Error('Upload failed: ' + err);
    }
    return { path: path, url: sbGetFileUrl(path) };
  }

  // Get a signed URL for a file (valid 1 hour)
  async function sbGetSignedUrl(path) {
    // POST to Supabase Storage sign endpoint — returns a URL valid for 1 hour
    // that can be opened directly in a browser tab without auth headers.
    try {
      var signUrl = window.SUPABASE_URL + '/storage/v1/object/sign/' + window.STORAGE_BUCKET + '/' + path;
      var res = await fetch(signUrl, {
        method: 'POST',
        headers: Object.assign({}, sbStorageHeaders(), { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ expiresIn: 3600 })
      });
      if (res.ok) {
        var d = await res.json();
        var rel = d && (d.signedURL || d.signedUrl);
        if (rel) return window.SUPABASE_URL + '/storage/v1' + rel;
      }
    } catch(e) { console.warn('[sbGetSignedUrl] sign failed:', e); }
    // Last resort: authenticated URL (requires auth header — won't open in new tab)
    return sbGetFileUrl(path);
  }

  // Copy a file within the same bucket by fetching as a blob and re-uploading.
  // Supabase Storage has no native server-side copy REST endpoint.
  // Uses Authorization headers (same as sbUploadFile) rather than the token
  // query-string URL — the latter returns 400 on some paths/token lengths.
  async function sbCopyFile(sourcePath, destPath) {
    function encodePath(p) {
      return p.split('/').map(function(seg){ return encodeURIComponent(seg); }).join('/');
    }
    var downUrl = window.SUPABASE_URL + '/storage/v1/object/' + window.STORAGE_BUCKET + '/' + encodePath(sourcePath);
    var blobRes = await fetch(downUrl, { headers: sbStorageHeaders() });
    if (!blobRes.ok) throw new Error('Could not read source file: ' + sourcePath + ' (HTTP ' + blobRes.status + ')');
    var blob = await blobRes.blob();
    var upUrl = window.SUPABASE_URL + '/storage/v1/object/' + window.STORAGE_BUCKET + '/' + encodePath(destPath);
    var upRes = await fetch(upUrl, {
      method:  'POST',
      headers: Object.assign({}, sbStorageHeaders(), {
        'x-upsert':     'true',
        'Content-Type': blob.type || 'application/octet-stream'
      }),
      body: blob
    });
    if (!upRes.ok) throw new Error('Copy upload failed: ' + await upRes.text());
  }

  // Delete a file from storage
  async function sbDeleteFile(path) {
    var url = window.SUPABASE_URL + '/storage/v1/object/' + window.STORAGE_BUCKET;
    var res = await fetch(url, {
      method: 'DELETE',
      headers: Object.assign({}, sbStorageHeaders(), { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ prefixes: [path] })
    });
    return res.ok;
  }

  // List files under a path prefix
  async function sbListFiles(prefix) {
    var cleanPrefix = prefix.replace(/\/$/, '');
    var url = window.SUPABASE_URL + '/storage/v1/object/list/' + window.STORAGE_BUCKET;
    var res = await fetch(url, {
      method: 'POST',
      headers: Object.assign({}, sbStorageHeaders(), { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ prefix: cleanPrefix, limit: 100, offset: 0, sortBy: { column: 'name', order: 'asc' } })
    });
    if (!res.ok) return [];
    var data = await res.json();
    return Array.isArray(data) ? data : [];
  }

  // Save file metadata to housing_audit_log (text detail column)
  async function sbSaveFileMeta(entityType, entityId, filePath, fileName, fileSize, fileType) {
    try {
      await fetch(window.SUPABASE_URL + '/rest/v1/housing_audit_log', {
        method: 'POST',
        headers: Object.assign({}, window.HOUSING_HEADERS, { 'Prefer': 'return=minimal' }),
        body: JSON.stringify({
          entity_type: entityType,
          entity_id: String(entityId),
          action: 'file_uploaded',
          detail: JSON.stringify({ path: filePath, name: fileName, size: fileSize, type: fileType,
            actor_name: (window.HOUSING_SESSION && window.HOUSING_SESSION.name) || '' }),
          actor: (window.HOUSING_SESSION && window.HOUSING_SESSION.email) || window.currentRole || 'staff',
          created_at: new Date().toISOString()
        })
      });
    } catch(e) { console.warn('File meta save failed:', e); }
  }

  // ── Offline file queue (Phase O2) ─────────────────────────────────────────
  // sbUploadFile is a direct Storage upload that fails with no internet, so a
  // generated/signed form (PDF) can't reach the document library offline. Wrap
  // it: when offline / degraded / on failure, stash the blob + metadata in
  // IndexedDB (too big for localStorage) and flush on reconnect. The doc-library
  // "metadata" is a file_uploaded audit row written by sbSaveFileMeta.
  function _offFileDB() {
    return new Promise(function(resolve, reject){
      try {
        var rq = indexedDB.open('clfn_offline_files', 1);
        rq.onupgradeneeded = function(){ var db = rq.result; if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath:'id', autoIncrement:true }); };
        rq.onsuccess = function(){ resolve(rq.result); };
        rq.onerror   = function(){ reject(rq.error); };
      } catch(e){ reject(e); }
    });
  }
  function _offFilePut(rec) {
    return _offFileDB().then(function(db){ return new Promise(function(resolve, reject){
      var tx = db.transaction('files','readwrite');
      tx.objectStore('files').add(Object.assign({ queuedAt: Date.now() }, rec));
      tx.oncomplete = function(){ resolve(true); };
      tx.onerror    = function(){ reject(tx.error); };
    }); });
  }
  function _offFileAll() {
    return _offFileDB().then(function(db){ return new Promise(function(resolve, reject){
      var tx = db.transaction('files','readonly'); var r = tx.objectStore('files').getAll();
      r.onsuccess = function(){ resolve(r.result || []); };
      r.onerror   = function(){ reject(r.error); };
    }); });
  }
  function _offFileDel(id) {
    return _offFileDB().then(function(db){ return new Promise(function(resolve){
      var tx = db.transaction('files','readwrite'); tx.objectStore('files').delete(id);
      tx.oncomplete = function(){ resolve(true); }; tx.onerror = function(){ resolve(false); };
    }); });
  }
  function _offFileDegraded(){ return (typeof window._inDegradedMode === 'function') && window._inDegradedMode(); }

  // Upload a file + write its file_uploaded audit row; if offline / degraded /
  // it fails, queue it for later. Resolves { queued: boolean }. Drop-in for the
  // sbUploadFile + sbSaveFileMeta pair.
  async function uploadFileResilient(path, blob, meta) {
    meta = meta || {};
    async function doIt(){
      await sbUploadFile(path, blob);
      await sbSaveFileMeta(meta.entityType, meta.entityId, path, meta.filename,
        (meta.size != null ? meta.size : (blob && blob.size)),
        meta.contentType || (blob && blob.type) || 'application/octet-stream');
    }
    if ((typeof navigator !== 'undefined' && navigator.onLine === false) || _offFileDegraded()) {
      try { await _offFilePut({ path: path, blob: blob, meta: meta }); } catch(e){ console.warn('[offline-file] queue failed:', e); }
      return { queued: true };
    }
    try { await doIt(); return { queued: false }; }
    catch(e) {
      try { await _offFilePut({ path: path, blob: blob, meta: meta }); } catch(e2){ console.warn('[offline-file] queue failed:', e2); }
      return { queued: true };
    }
  }

  var _offFileFlushing = false;
  async function flushOfflineFiles() {
    if (_offFileFlushing) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    _offFileFlushing = true;
    var uploaded = 0;
    try {
      var items = await _offFileAll();
      for (var i = 0; i < items.length; i++) {
        var it = items[i], m = it.meta || {};
        try {
          await sbUploadFile(it.path, it.blob);
          await sbSaveFileMeta(m.entityType, m.entityId, it.path, m.filename, m.size, m.contentType || 'application/octet-stream');
          await _offFileDel(it.id);
          uploaded++;
        } catch(e){ console.warn('[offline-file] flush item kept (will retry):', e); }
      }
    } catch(e){ console.warn('[offline-file] flush failed:', e); }
    _offFileFlushing = false;
    if (uploaded && typeof window.showToast === 'function') {
      window.showToast('Synced ' + uploaded + ' saved file' + (uploaded > 1 ? 's' : '') + ' to the server.', { type: 'info' });
    }
  }
  if (typeof window !== 'undefined') {
    window.uploadFileResilient = uploadFileResilient;
    window.flushOfflineFiles   = flushOfflineFiles;
    try { window.addEventListener('online', flushOfflineFiles); } catch(e){}
    try { window.addEventListener('load', function(){ setTimeout(flushOfflineFiles, 3000); }); } catch(e){}
  }

  // Load file list for an entity from audit log (filters out deleted).
  // Column is `detail` (singular, text). Uses a tolerant parser in case
  // of jsonb drift later.
  function _sbParseDetail(v) {
    if (v == null) return {};
    if (typeof v === 'object') return v;
    if (typeof v === 'string') {
      try { return JSON.parse(v); } catch(e) { return {}; }
    }
    return {};
  }
  async function sbLoadFileMeta(entityType, entityId) {
    try {
      var r = await fetch(
        window.SUPABASE_URL + '/rest/v1/housing_audit_log?entity_type=eq.'+entityType+'&entity_id=eq.'+encodeURIComponent(String(entityId))+'&action=in.(file_uploaded,file_deleted)&order=created_at.desc',
        { headers: window.HOUSING_HEADERS }
      );
      if (!r.ok) return [];
      var rows = await r.json();
      var deleted = rows.filter(function(row){ return row.action === 'file_deleted'; }).map(function(row){ return _sbParseDetail(row.detail).path; });
      return rows
        .filter(function(row){ return row.action === 'file_uploaded'; })
        .filter(function(row){ var d = _sbParseDetail(row.detail); return d.path && !deleted.includes(d.path); })
        .map(function(row){
          var d = _sbParseDetail(row.detail);
          return { path: d.path, name: d.name, size: d.size, type: d.type, category: d.category, addedAt: (row.created_at||'').slice(0,10), addedBy: row.actor, logId: row.id };
        });
    } catch(e) { return []; }
  }

  // Unified upload handler: uploads to Supabase Storage + saves metadata
  async function sbUploadAndSave(entityType, entityId, file, pathPrefix) {
    var ts = Date.now();
    var safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    var path = pathPrefix + '/' + ts + '_' + safeName;
    var result = await sbUploadFile(path, file);
    await sbSaveFileMeta(entityType, String(entityId), path, file.name, file.size, file.type);
    return { path: path, name: file.name, size: file.size, type: file.type,
             addedAt: new Date().toISOString().slice(0,10), addedBy: window.currentRole || 'staff' };
  }

  // Expose namespaced API
  window.SbStorage = {
    storageHeaders: sbStorageHeaders,
    getFileUrl: sbGetFileUrl,
    uploadFile: sbUploadFile,
    getSignedUrl: sbGetSignedUrl,
    deleteFile: sbDeleteFile,
    listFiles: sbListFiles,
    saveFileMeta: sbSaveFileMeta,
    loadFileMeta: sbLoadFileMeta,
    uploadAndSave: sbUploadAndSave
  };
  // Expose legacy top-level aliases — 15+ call sites across housing.html
  // and renos.html use these bare names. Keep them until every caller
  // migrates to window.SbStorage.
  window.sbStorageHeaders = sbStorageHeaders;
  window.sbGetFileUrl     = sbGetFileUrl;
  window.sbUploadFile     = sbUploadFile;
  window.sbGetSignedUrl   = sbGetSignedUrl;
  window.sbCopyFile       = sbCopyFile;
  window.sbDeleteFile     = sbDeleteFile;
  window.sbListFiles      = sbListFiles;
  window.sbSaveFileMeta   = sbSaveFileMeta;
  window.sbLoadFileMeta   = sbLoadFileMeta;
  window.sbUploadAndSave  = sbUploadAndSave;
})();
