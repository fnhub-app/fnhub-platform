/* ============================================================================
 * labels.js -- Unit Labels module (Settings -> Unit Labels).
 *
 * Real printable 2" x 1" unit labels, per-nation configurable, with emergency
 * contacts, a QR module-size gate, laser-sheet / roll / alignment-test / metal
 * PDF outputs, and print history (a "stale" reprint worklist).
 *
 * Backed by 20260819_labels_module.sql (label_config, label_emergency_contacts,
 * unit_label_prints + get_label_config / set_emergency_contacts /
 * record_label_prints / v_unit_label_status). Follows the app's conventions:
 * raw fetch to Supabase (no SDK), window-exposed handlers, _qrLoadLib / _qresc
 * shared helpers, jsPDF lazy-loaded from the CSP-allowlisted CDN.
 *
 * ED / super_user only (matches the settings tab gate + DB RLS).
 * ==========================================================================*/
(function () {
  'use strict';

  var S = {
    cfg: null, contacts: [], units: [], status: {}, sel: {},
    filter: '', staleOnly: false, occOnly: false, loaded: false,
    // laser-sheet geometry (Avery 5163 / 10-up defaults; inches)
    sheet: { cols: 2, rows: 5, mTop: 0.5, mLeft: 0.19, colGap: 0.13, rowGap: 0.0 }
  };

  // ---- small helpers --------------------------------------------------------
  function esc(s) { return (typeof _qresc === 'function') ? _qresc(s) : String(s == null ? '' : s); }
  function portalBase() { return (typeof nationPortalBase === 'function') ? nationPortalBase() : location.origin; }
  function nationName() { return (window.NATION_CONFIG && (NATION_CONFIG.display_name || NATION_CONFIG.short)) || 'Housing'; }
  function nationLogo() {
    return (window._appSettings && _appSettings.theme && _appSettings.theme.logo)
        || (window.NATION_CONFIG && NATION_CONFIG.logo)
        || window.HLH_LOGO_DATA_URL || window.CLFN_LOGO_DATA_URL || '';
  }
  function isAdmin() { var r = window.currentRole || ''; return r === 'ed' || r === 'super_user'; }
  // Default untyped calls to 'info' so confirmations are visible; callers
  // passing {type:'error'} keep their type.
  function toast(m, o) { if (typeof showToast === 'function') showToast(m, (o && o.type) ? o : Object.assign({type:'info'}, o || {})); }

  // QR payload for a unit: <qr_base or portal base, scheme-stripped>/u/<slug|id>.
  function qrBase() {
    var b = (S.cfg && S.cfg.qr_base_url) || portalBase();
    return String(b).replace(/^https?:\/\//, '').replace(/\/+$/, '');
  }
  function unitSlug(u) { return (u && u.label_slug != null) ? String(u.label_slug) : String(u.id); }
  function qrUrl(u) { return qrBase() + '/u/' + unitSlug(u); }
  function unitAddr(u) { return ((u.num || '') + ' ' + (u.street || '')).trim() || ('Unit ' + u.id); }

  // ---- QR module-size gate (byte-mode capacity, versions 1-10) --------------
  var QR_CAP = {
    L: [17, 32, 53, 78, 106, 134, 154, 192, 230, 271],
    M: [14, 26, 42, 62, 84, 106, 122, 152, 180, 213],
    Q: [11, 20, 32, 46, 60, 74, 86, 108, 130, 151],
    H: [7, 14, 24, 34, 44, 58, 64, 84, 98, 119]
  };
  function utf8Len(s) { try { return unescape(encodeURIComponent(s)).length; } catch (e) { return s.length; } }
  function qrModuleCount(text, ec) {
    var caps = QR_CAP[ec] || QR_CAP.M, n = utf8Len(text);
    for (var v = 0; v < caps.length; v++) { if (n <= caps[v]) return (v + 1) * 4 + 17; }
    return null; // longer than version 10 -- the base URL is too long for a small label
  }
  // Geometry (inches) derived from label dims + active-contact count.
  function geom() {
    var W = Number(S.cfg && S.cfg.label_width_in) || 2.0;
    var H = Number(S.cfg && S.cfg.label_height_in) || 1.0;
    var pad = 0.055;
    var rows = (S.contacts.length || 2) + 1;            // contacts + housing line
    var band = Math.min(H * 0.55, 0.045 + 0.095 * rows);
    var topH = H - band;
    var qr = Math.max(0.3, topH - 2 * pad);             // QR fills the top-left square
    return { W: W, H: H, pad: pad, band: band, topH: topH, qr: qr, rows: rows };
  }
  // mm per QR module at the printed size, for the longest selected payload.
  function moduleMm() {
    var ec = (S.cfg && S.cfg.qr_error_level) || 'M';
    var longest = '';
    selectedUnits().forEach(function (u) { var s = qrUrl(u); if (s.length > longest.length) longest = s; });
    if (!longest) longest = qrBase() + '/u/000';
    var mods = qrModuleCount(longest, ec);
    if (!mods) return { mm: 0, mods: null, payload: longest };
    var qrIn = geom().qr;
    return { mm: (qrIn * 25.4) / mods, mods: mods, payload: longest };
  }

  // ---- data load ------------------------------------------------------------
  function _units() {
    var u = (typeof getAllUnits === 'function') ? getAllUnits().slice() : [];
    return u.filter(function (x) { return x && x.id && !x.archived; }).sort(function (a, b) {
      var sa = (a.street || '').toLowerCase(), sb = (b.street || '').toLowerCase();
      if (sa !== sb) return sa < sb ? -1 : 1;
      return (parseInt(a.num, 10) || 0) - (parseInt(b.num, 10) || 0);
    });
  }
  async function load() {
    // Config + contacts (one RPC).
    try {
      var r = await fetch(SUPABASE_URL + '/rest/v1/rpc/get_label_config', {
        method: 'POST', headers: Object.assign({}, HOUSING_HEADERS, { 'Content-Type': 'application/json' }), body: '{}'
      });
      if (r.ok) {
        var j = await r.json();
        S.cfg = (j && j.config) || {};
        S.contacts = (j && j.contacts) || [];
      }
    } catch (e) { /* pre-migration -> empty; the panel shows the run-migration note */ }
    if (!S.cfg) S.cfg = {};
    if (S.contacts.length === 0) S.contacts = [{ label: '', phone: '' }, { label: '', phone: '' }];
    // Ensure short slugs (reuses the 20260818 helper) so the QR stays small.
    S.units = _units();
    if (typeof _maintEnsureSlugs === 'function') { try { await _maintEnsureSlugs(S.units); } catch (e) {} }
    // Stale/current/never-printed status.
    S.status = {};
    try {
      var sr = await fetch(SUPABASE_URL + '/rest/v1/v_unit_label_status?select=unit_id,label_status,last_printed_at', { headers: HOUSING_HEADERS });
      if (sr.ok) (await sr.json()).forEach(function (row) { S.status[row.unit_id] = row; });
    } catch (e) { /* pre-migration */ }
    S.loaded = true;
  }

  function selectedUnits() { return S.units.filter(function (u) { return S.sel[u.id]; }); }
  function visibleUnits() {
    var f = (S.filter || '').toLowerCase();
    return S.units.filter(function (u) {
      if (S.occOnly && !(u.assignedName || u.assignedTo)) return false;
      if (S.staleOnly && (S.status[u.id] || {}).label_status !== 'stale') return false;
      if (f && unitAddr(u).toLowerCase().indexOf(f) === -1) return false;
      return true;
    });
  }

  // ---- render ---------------------------------------------------------------
  async function render() {
    var body = document.getElementById('maint_qr_panel_body');
    if (!body) return;
    if (!isAdmin()) { body.innerHTML = '<div class="empty-state-ctr">Only the ED can manage unit labels.</div>'; return; }
    body.innerHTML = '<div class="empty-state-ctr">Loading labels...</div>';
    if (!S.loaded) await load();

    var preMigration = !(S.cfg && S.cfg.nation_id);
    body.innerHTML =
      (preMigration ? _migrationBanner() : '')
      + _configCard()
      + _contactsCard()
      + _unitsCard();

    // Draw preview QR after DOM is in place.
    try {
      if (typeof _qrLoadLib === 'function') await _qrLoadLib();
      _drawPreview();
    } catch (e) {}
  }

  function _migrationBanner() {
    return '<div style="background:var(--warn-amber-bg);border:1px solid var(--warn-amber-text);border-radius:10px;padding:12px 14px;margin-bottom:14px;font-size:13px;">'
      + '<b>Run the migration first.</b> This nation\'s label tables are not set up yet. Run '
      + '<code>supabase/migrations/20260819_labels_module.sql</code> in this project\'s SQL Editor, then reload. '
      + 'Config saving and print history need it.</div>';
  }

  function _fieldRow(label, id, val, ph, type) {
    return '<div><label style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:4px;">' + esc(label) + '</label>'
      + '<input id="' + id + '" type="' + (type || 'text') + '" value="' + esc(val == null ? '' : val) + '" placeholder="' + esc(ph || '') + '" style="width:100%;padding:8px 12px;border:1px solid var(--border);border-radius:7px;font-size:13px;box-sizing:border-box;"/></div>';
  }

  function _configCard() {
    var c = S.cfg || {};
    // Error-correction level = how much of the code can be damaged/dirty and
    // still scan. Higher recovery packs MORE modules into the same square, so
    // each module prints smaller (harder to scan at small label sizes) — L
    // gives the biggest modules, H the densest code.
    var EC_LEVELS = [
      ['L', 'L — Low (7%)',      'Recovers up to 7% damage. Least dense code = biggest modules, easiest scan at small sizes. Best when the module-size gate reads Marginal.'],
      ['M', 'M — Medium (15%)',  'Recovers up to 15% damage. The default — a good balance of durability and module size.'],
      ['Q', 'Q — Quartile (25%)','Recovers up to 25% damage. Denser code, smaller modules. For labels likely to get scuffed or dirty.'],
      ['H', 'H — High (30%)',    'Recovers up to 30% damage. Densest code = smallest modules; only for large labels in harsh conditions.']
    ];
    var ecOpts = EC_LEVELS.map(function (o) {
      return '<option value="' + o[0] + '" title="' + esc(o[2]) + '"' + ((c.qr_error_level || 'M') === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
    }).join('');
    var ecTitle = 'How much of the printed code can be damaged or dirty and still scan. Higher recovery = denser code = smaller squares (harder to scan on small labels). '
      + EC_LEVELS.map(function (o) { return o[1] + ': ' + o[2]; }).join('  ');
    // Prefill from the nation's own config when nothing is saved yet — the
    // values were previously only greyed placeholders, so a fresh nation saw
    // an apparently-empty form even though the app already knows its mailbox,
    // display name, portal URL, and theme accent. Everything comes from
    // NATION_CONFIG / the live theme (no nation literals); staff can still
    // edit any value before saving.
    var _nc = window.NATION_CONFIG || {};
    var _accDefault = (typeof window._themeAccentHex === 'function' ? window._themeAccentHex() : '') || '#F8E41A';
    return '<div class="std-table-card" style="padding:16px;margin-bottom:16px;">'
      + '<div class="lbl-yellow" style="margin-bottom:10px;">Label configuration</div>'
      + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">'
      +   _fieldRow('Department label', 'lbl_dept', c.department_label || 'Housing Department', 'Housing Department')
      +   _fieldRow('CTA text', 'lbl_cta', c.cta_text || 'SCAN TO REPORT AN ISSUE', 'SCAN TO REPORT AN ISSUE')
      +   _fieldRow('Housing email', 'lbl_email', c.housing_email || _nc.housing_email || '', 'housing@nation.ca', 'email')
      +   _fieldRow('Housing phone', 'lbl_phone', c.housing_phone || _nc.phone || '', '705-555-1234')
      +   _fieldRow('Default community', 'lbl_comm', c.default_community || (typeof nationDisplay === 'function' ? nationDisplay() : ''), (typeof nationDisplay === 'function' ? nationDisplay() : ''))
      +   _fieldRow('QR base URL', 'lbl_qrbase', c.qr_base_url || qrBase(), qrBase())
      + '</div>'
      + '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:12px;">'
      +   '<div><label title="' + esc(ecTitle) + '" style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:4px;cursor:help;">QR error level <span style="font-weight:400;">&#9432;</span></label>'
      +     '<select id="lbl_ec" title="' + esc(ecTitle) + '" style="width:100%;padding:8px 12px;border:1px solid var(--border);border-radius:7px;font-size:13px;">' + ecOpts + '</select>'
      +     '<div style="font-size:10.5px;color:var(--muted);margin-top:3px;line-height:1.4;">Lower = bigger squares, easier scan. Drop to L if the QR gate reads Marginal.</div></div>'
      +   _fieldRow('Accent colour', 'lbl_accent', c.accent_colour || _accDefault, _accDefault)
      +   _fieldRow('Label width (in)', 'lbl_w', c.label_width_in != null ? c.label_width_in : 2.0, '2.00', 'number')
      +   _fieldRow('Label height (in)', 'lbl_h', c.label_height_in != null ? c.label_height_in : 1.0, '1.00', 'number')
      + '</div>'
      + '<div style="display:flex;gap:8px;margin-top:12px;">'
      +   '<button type="button" class="btn btn-primary btn-sm" onclick="_lblSaveConfig()">Save configuration</button>'
      + '</div>'
      + '</div>';
  }

  function _contactsCard() {
    var rows = S.contacts.map(function (c, i) {
      return '<div style="display:grid;grid-template-columns:1fr 1fr 34px;gap:8px;margin-bottom:8px;align-items:center;">'
        // maxlength keeps label + number inside what a 2" label can print —
        // longer text was silently ellipsized on the band ("1-866-763-5…").
        + '<input value="' + esc(c.label || '') + '" maxlength="18" placeholder="Label (e.g. Emergency)" oninput="_lblContactEdit(' + i + ',\'label\',this.value)" style="padding:8px 10px;border:1px solid var(--border);border-radius:7px;font-size:13px;"/>'
        + '<input value="' + esc(c.phone || '') + '" maxlength="14" placeholder="Phone" oninput="_lblContactEdit(' + i + ',\'phone\',this.value)" style="padding:8px 10px;border:1px solid var(--border);border-radius:7px;font-size:13px;"/>'
        + '<button type="button" class="btn btn-ghost btn-sm" onclick="_lblRemoveContact(' + i + ')"' + (S.contacts.length <= 2 ? ' disabled title="A nation needs at least 2 contacts"' : '') + ' style="padding:6px 0;">&times;</button>'
        + '</div>';
    }).join('');
    return '<div class="std-table-card" style="padding:16px;margin-bottom:16px;">'
      + '<div class="lbl-yellow" style="margin-bottom:4px;">Emergency contacts</div>'
      + '<div class="txt-sm-meta" style="margin-bottom:10px;">2 to 3 contacts. These print in the accent colour on every label\'s bottom band. Keep the label short (18 characters max) so the full phone number fits on the printed label — check the preview.</div>'
      + rows
      + '<div style="display:flex;gap:8px;margin-top:6px;">'
      +   '<button type="button" class="btn btn-ghost btn-sm" onclick="_lblAddContact()"' + (S.contacts.length >= 3 ? ' disabled title="Maximum 3 contacts"' : '') + '>+ Add contact</button>'
      +   '<button type="button" class="btn btn-primary btn-sm" onclick="_lblSaveContacts()">Save contacts</button>'
      + '</div>'
      + '</div>';
  }

  function _unitsCard() {
    var mm = moduleMm();
    var gateColor = mm.mm >= 0.6 ? 'var(--success)' : (mm.mm >= 0.45 ? 'var(--warn-amber-text)' : 'var(--danger)');
    var gateMsg = !mm.mods ? 'QR base URL too long for a small label — shorten it.'
      : (mm.mm >= 0.6 ? 'Good — scans reliably.'
        : (mm.mm >= 0.45 ? 'Marginal — shorten the QR base URL to improve scanning.'
          : 'Too dense — printing is blocked until the QR base URL is shorter.'));
    var selCount = selectedUnits().length;
    return '<div class="std-table-card" style="padding:16px;">'
      + '<div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;margin-bottom:10px;">'
      +   '<div class="lbl-yellow">Units &amp; printing</div>'
      +   '<div id="lbl_gate" style="font-size:12px;color:' + gateColor + ';font-weight:700;">QR module: ' + (mm.mods ? mm.mm.toFixed(2) + ' mm' : 'n/a') + ' &middot; ' + esc(gateMsg) + '</div>'
      + '</div>'
      + '<div style="display:flex;flex-wrap:wrap;gap:10px 16px;align-items:center;margin-bottom:10px;">'
      +   '<input placeholder="Filter by address" value="' + esc(S.filter) + '" oninput="_lblSetFilter(this.value)" style="flex:1;min-width:160px;padding:8px 12px;border:1px solid var(--border);border-radius:7px;font-size:13px;"/>'
      +   '<label style="font-size:13px;font-weight:600;cursor:pointer;"><input type="checkbox" ' + (S.occOnly ? 'checked' : '') + ' onchange="_lblToggleOcc(this.checked)"/> Occupied only</label>'
      +   '<label style="font-size:13px;font-weight:600;cursor:pointer;"><input type="checkbox" ' + (S.staleOnly ? 'checked' : '') + ' onchange="_lblToggleStale(this.checked)"/> Stale only</label>'
      +   '<button type="button" class="btn btn-ghost btn-sm" onclick="_lblSelectAll(true)">Select all shown</button>'
      +   '<button type="button" class="btn btn-ghost btn-sm" onclick="_lblSelectAll(false)">Clear</button>'
      + '</div>'
      + '<div style="display:grid;grid-template-columns:1fr auto;gap:16px;align-items:start;">'
      +   '<div style="max-height:340px;overflow:auto;border:1px solid var(--border);border-radius:8px;">'
      +     '<table class="std-table" style="margin:0;"><thead><tr><th></th><th>Address</th><th>Label</th></tr></thead>'
      +       '<tbody id="lbl_unit_rows">' + _unitRowsHtml() + '</tbody></table>'
      +   '</div>'
      +   '<div style="width:230px;">'
      +     '<div class="txt-sm-meta" style="margin-bottom:6px;">Preview</div>'
      +     '<div id="lbl_preview" style="border:1px solid var(--border);border-radius:8px;background:#fff;padding:6px;"></div>'
      +     '<div class="txt-sm-meta" style="margin-top:8px;"><span id="lbl_selcount">' + selCount + '</span> selected</div>'
      +   '</div>'
      + '</div>'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px;">'
      +   '<button type="button" class="btn btn-primary btn-sm" onclick="_lblPrint(\'laser_sheet\')">&#128424; Print sheet</button>'
      +   '<button type="button" class="btn btn-ghost btn-sm" onclick="_lblPrint(\'roll\')">Print roll</button>'
      +   '<button type="button" class="btn btn-ghost btn-sm" onclick="_lblPrint(\'alignment\')">Alignment test</button>'
      +   '<button type="button" class="btn btn-ghost btn-sm" onclick="_lblPrint(\'metal_pdf\')">Metal PDF</button>'
      +   '<button type="button" class="btn btn-ghost btn-sm" onclick="_lblRefresh()">&#8635; Refresh</button>'
      + '</div>'
      + '</div>';
  }

  function _unitRowsHtml() {
    var vis = visibleUnits();
    if (!vis.length) return '<tr><td colspan="3" class="empty-state-italic">No units match.</td></tr>';
    return vis.map(function (u) {
      var st = (S.status[u.id] || {}).label_status || 'never_printed';
      var pill = st === 'current' ? '<span class="pill green">Current</span>'
        : st === 'stale' ? '<span class="pill" style="background:var(--warn-amber-bg);color:var(--warn-amber-text);">Stale</span>'
          : '<span class="pill" style="background:#f4f4f0;color:var(--gray);">Never</span>';
      return '<tr>'
        + '<td style="width:34px;"><input type="checkbox" ' + (S.sel[u.id] ? 'checked' : '') + ' onchange="_lblToggleUnit(\'' + String(u.id).replace(/'/g, "\\'") + '\',this.checked)"/></td>'
        + '<td style="font-weight:700;">' + esc(unitAddr(u)) + '</td>'
        + '<td>' + pill + '</td>'
        + '</tr>';
    }).join('');
  }
  // Refresh just the rows (keeps the filter input focused).
  function _renderUnitRows() { var t = document.getElementById('lbl_unit_rows'); if (t) t.innerHTML = _unitRowsHtml(); }
  function _updateSelCount() { var el = document.getElementById('lbl_selcount'); if (el) el.textContent = selectedUnits().length; }
  function _updateGate() {
    var el = document.getElementById('lbl_gate'); if (!el) return;
    var mm = moduleMm();
    var color = mm.mm >= 0.6 ? 'var(--success)' : (mm.mm >= 0.45 ? 'var(--warn-amber-text)' : 'var(--danger)');
    var msg = !mm.mods ? 'QR base URL too long for a small label — shorten it.'
      : (mm.mm >= 0.6 ? 'Good — scans reliably.'
        : (mm.mm >= 0.45 ? 'Marginal — shorten the QR base URL to improve scanning.'
          : 'Too dense — printing is blocked until the QR base URL is shorter.'));
    el.style.color = color;
    el.innerHTML = 'QR module: ' + (mm.mods ? mm.mm.toFixed(2) + ' mm' : 'n/a') + ' &middot; ' + esc(msg);
  }

  // Draw the preview QR + a scaled HTML label of the first selected (or first) unit.
  function _drawPreview() {
    var host = document.getElementById('lbl_preview'); if (!host) return;
    var u = selectedUnits()[0] || S.units[0]; if (!u) { host.innerHTML = '<div class="txt-sm-meta">No units.</div>'; return; }
    host.innerHTML = _labelHtml(u, 220);   // 220px wide preview
    var qh = host.querySelector('.lbl-qr-host');
    if (qh && typeof QRCode !== 'undefined') {
      qh.innerHTML = '';
      // Draw at the host's ACTUAL rendered size — a fixed 150px QR overflowed
      // the ~40px preview slot and smeared across the address text and the
      // contact band. The print/PDF paths are untouched (they render at full
      // physical size); this only affects the on-screen preview.
      var _qs = Math.max(24, Math.round(qh.getBoundingClientRect().width) || parseInt(qh.style.width, 10) || 40);
      new QRCode(qh, { text: qrUrl(u), width: _qs, height: _qs, correctLevel: QRCode.CorrectLevel[(S.cfg && S.cfg.qr_error_level) || 'M'] });
    }
  }

  // One label as scalable HTML (px width supplied; everything else proportional).
  function _labelHtml(u, pxW) {
    var g = geom();
    var scale = pxW / g.W;                      // px per inch for this render
    var accent = (S.cfg && S.cfg.accent_colour)
      || (typeof window._themeAccentHex === 'function' ? window._themeAccentHex() : '')
      || '#F8E41A';
    var qrPx = g.qr * scale, bandPx = g.band * scale, padPx = g.pad * scale;
    var contacts = S.contacts.filter(function (c) { return (c.label || c.phone); });
    var bandLines = contacts.map(function (c) {
      return '<div style="color:' + esc(accent) + ';font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc((c.label ? c.label + ': ' : '') + (c.phone || '')) + '</div>';
    }).join('');
    var housing = [((S.cfg && S.cfg.department_label) || ''), ((S.cfg && S.cfg.housing_email) || ''), ((S.cfg && S.cfg.housing_phone) || '')].filter(Boolean).join('  |  ');
    var logo = nationLogo();
    // White-knockout the band logo ONLY when the theme marks it transparent —
    // the filter turns every opaque pixel white, so a logo with a solid
    // background became a blank white square on the black band.
    var logoTransparent = !!(window._appSettings && _appSettings.theme && _appSettings.theme.logoTransparent);
    var logoStyle = 'height:' + (bandPx * 0.62) + 'px;width:auto;flex:0 0 auto;'
      + (logoTransparent ? 'filter:brightness(0) invert(1);' : 'border-radius:3px;');
    return '<div style="width:' + pxW + 'px;height:' + (g.H * scale) + 'px;position:relative;overflow:hidden;font-family:Arial,Helvetica,sans-serif;background:#fff;">'
      + '<div style="display:flex;gap:' + padPx + 'px;padding:' + padPx + 'px;height:' + (g.topH * scale) + 'px;box-sizing:border-box;">'
      +   '<div class="lbl-qr-host" style="width:' + qrPx + 'px;height:' + qrPx + 'px;flex:0 0 auto;"></div>'
      +   '<div style="flex:1;min-width:0;">'
      +     '<div style="font-weight:800;color:#111;line-height:1.02;font-size:' + (0.145 * scale) + 'px;overflow:hidden;">' + esc(unitAddr(u)) + '</div>'
      +     '<div style="color:#888;font-size:' + (0.08 * scale) + 'px;margin-top:' + (0.02 * scale) + 'px;">' + esc((S.cfg && S.cfg.default_community) || '') + '</div>'
      +     '<div style="color:#666;font-weight:700;font-size:' + (0.062 * scale) + 'px;margin-top:' + (0.02 * scale) + 'px;">' + esc((S.cfg && S.cfg.cta_text) || 'SCAN TO REPORT AN ISSUE') + '</div>'
      +   '</div>'
      + '</div>'
      + '<div style="position:absolute;bottom:0;left:0;right:0;height:' + bandPx + 'px;background:#000;color:#fff;display:flex;align-items:center;gap:' + padPx + 'px;padding:0 ' + padPx + 'px;box-sizing:border-box;">'
      +   (logo ? '<img src="' + esc(logo) + '" style="' + logoStyle + '"/>' : '')
      +   '<div style="flex:1;min-width:0;font-size:' + (0.072 * scale) + 'px;line-height:1.12;">' + bandLines
      +     '<div style="color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(housing) + '</div>'
      +   '</div>'
      + '</div>'
      + '</div>';
  }

  // ---- config / contact handlers -------------------------------------------
  window._lblRefresh = function () { S.loaded = false; render(); };
  window._lblSetFilter = function (v) { S.filter = v || ''; _renderUnitRows(); };
  window._lblToggleOcc = function (v) { S.occOnly = !!v; _renderUnitRows(); };
  window._lblToggleStale = function (v) { S.staleOnly = !!v; _renderUnitRows(); };
  window._lblToggleUnit = function (id, v) { S.sel[id] = !!v; _drawPreview(); _updateSelCount(); _updateGate(); };
  window._lblSelectAll = function (v) { visibleUnits().forEach(function (u) { S.sel[u.id] = !!v; }); _renderUnitRows(); _drawPreview(); _updateSelCount(); _updateGate(); };
  window._lblContactEdit = function (i, k, v) { if (S.contacts[i]) S.contacts[i][k] = v; };
  window._lblAddContact = function () { if (S.contacts.length < 3) { S.contacts.push({ label: '', phone: '' }); render(); } };
  window._lblRemoveContact = function (i) { if (S.contacts.length > 2) { S.contacts.splice(i, 1); render(); } };

  // Nation id for label rows: saved config row -> nation registry id. NEVER a
  // hardcoded nation literal (multi-tenant hard rule) — writing another
  // nation's id silently cross-tenants label config/print history. Empty =
  // refuse to write.
  function _lblNation(){
    return (S.cfg && S.cfg.nation_id) || (typeof nationId === 'function' ? nationId() : '') || '';
  }

  window._lblSaveConfig = async function () {
    if (!isAdmin()) { toast('Only the ED can change label settings'); return; }
    if (!_lblNation()) { toast('Nation is not configured — cannot save label settings', { type: 'error' }); return; }
    var g = function (id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; };
    var row = {
      nation_id: _lblNation(),
      department_label: g('lbl_dept') || null,
      cta_text: g('lbl_cta') || 'SCAN TO REPORT AN ISSUE',
      housing_email: g('lbl_email') || null,
      housing_phone: g('lbl_phone') || null,
      default_community: g('lbl_comm') || null,
      qr_base_url: g('lbl_qrbase') || null,
      qr_error_level: (document.getElementById('lbl_ec') || {}).value || 'M',
      accent_colour: g('lbl_accent') || '#F8E41A',
      label_width_in: parseFloat(g('lbl_w')) || 2.0,
      label_height_in: parseFloat(g('lbl_h')) || 1.0,
      updated_at: new Date().toISOString(),
      updated_by: (window.HOUSING_SESSION && HOUSING_SESSION.email) || null
    };
    try {
      var r = await fetch(SUPABASE_URL + '/rest/v1/label_config?on_conflict=nation_id', {
        method: 'POST',
        headers: Object.assign({}, HOUSING_HEADERS, { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify(row)
      });
      if (!r.ok) { var t = await r.text(); toast('Could not save config' + (/label_config/.test(t) ? ' — run the labels migration first' : ''), { type: 'error' }); return; }
      S.cfg = Object.assign({}, S.cfg, row);
      if (typeof auditEntry === 'function') auditEntry('SETTINGS', 'label_config_save', 'Label configuration saved', window.currentRole || 'ed');
      toast('Label configuration saved');
      render();
    } catch (e) { toast('Save failed', { type: 'error' }); }
  };

  window._lblSaveContacts = async function () {
    if (!isAdmin()) { toast('Only the ED can change contacts'); return; }
    var clean = S.contacts.map(function (c) { return { label: (c.label || '').trim(), phone: (c.phone || '').trim() }; })
      .filter(function (c) { return c.label || c.phone; });
    if (clean.length < 2 || clean.length > 3) { toast('Enter 2 or 3 emergency contacts', { type: 'error' }); return; }
    if (!_lblNation()) { toast('Nation is not configured — cannot save contacts', { type: 'error' }); return; }
    try {
      var r = await fetch(SUPABASE_URL + '/rest/v1/rpc/set_emergency_contacts', {
        method: 'POST', headers: Object.assign({}, HOUSING_HEADERS, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ p_contacts: clean, p_nation: _lblNation() })
      });
      if (!r.ok) { var t = await r.text(); toast('Could not save contacts' + (/2 or 3/.test(t) ? ' — need 2 or 3' : (/emergency_contacts/.test(t) ? ' — run the labels migration first' : '')), { type: 'error' }); return; }
      S.contacts = clean;
      if (typeof auditEntry === 'function') auditEntry('SETTINGS', 'label_contacts_save', 'Emergency contacts saved (' + clean.length + ')', window.currentRole || 'ed');
      toast('Emergency contacts saved');
      render();
    } catch (e) { toast('Save failed', { type: 'error' }); }
  };

  // ---- printing -------------------------------------------------------------
  function _preflight() {
    var units = selectedUnits();
    if (!units.length) { toast('Select at least one unit'); return null; }
    var mm = moduleMm();
    if (!mm.mods || mm.mm < 0.45) { toast('QR too dense to print (' + (mm.mods ? mm.mm.toFixed(2) + ' mm' : 'URL too long') + '). Shorten the QR base URL.', { type: 'error' }); return null; }
    return units;
  }

  // Build a data-URL PNG QR for one payload (uses qrcodejs into an offscreen node).
  async function _qrPng(text) {
    if (typeof _qrLoadLib === 'function') await _qrLoadLib();
    return new Promise(function (resolve) {
      var host = document.createElement('div'); host.style.position = 'fixed'; host.style.left = '-9999px'; document.body.appendChild(host);
      new QRCode(host, { text: text, width: 512, height: 512, correctLevel: QRCode.CorrectLevel[(S.cfg && S.cfg.qr_error_level) || 'M'] });
      setTimeout(function () {
        var el = host.querySelector('img') || host.querySelector('canvas'); var src = '';
        try { src = el ? (el.tagName === 'IMG' ? el.src : el.toDataURL('image/png')) : ''; } catch (e) {}
        document.body.removeChild(host); resolve(src);
      }, 60);
    });
  }

  async function _recordPrints(unitIds, output, substrate, notes) {
    try {
      await fetch(SUPABASE_URL + '/rest/v1/rpc/record_label_prints', {
        method: 'POST', headers: Object.assign({}, HOUSING_HEADERS, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ p_unit_ids: unitIds, p_output: output, p_substrate: substrate || null, p_notes: notes || null, p_nation: _lblNation() })
      });
      if (typeof auditEntry === 'function') auditEntry('SETTINGS', 'label_prints_recorded', 'Printed ' + unitIds.length + ' label(s) [' + output + ']', window.currentRole || 'ed');
    } catch (e) { /* history is best-effort; never block the print */ }
  }

  // Master print entry.
  window._lblPrint = async function (mode) {
    var units = (mode === 'alignment') ? [S.units[0]].filter(Boolean) : _preflight();
    if (!units || !units.length) { if (mode === 'alignment') toast('No units to build an alignment label'); return; }
    if (mode === 'metal_pdf') return _printMetalPdf(units);
    return _printHtml(units, mode);
  };

  // Laser sheet / roll / alignment -- exact-inch HTML print.
  async function _printHtml(units, mode) {
    var g = geom();
    // Pre-generate QR PNGs so the print window has static images.
    var pngs = {};
    for (var i = 0; i < units.length; i++) { pngs[units[i].id] = await _qrPng(qrUrl(units[i])); }
    var labelsHtml = units.map(function (u) { return _labelPrintHtml(u, pngs[u.id], g); }).join('');

    var css, wrapOpen, wrapClose;
    if (mode === 'roll') {
      css = '@page{size:' + g.W + 'in ' + g.H + 'in;margin:0;} .lp{page-break-after:always;}';
      wrapOpen = ''; wrapClose = '';
    } else if (mode === 'alignment') {
      css = '@page{size:letter;margin:' + S.sheet.mTop + 'in ' + S.sheet.mLeft + 'in;}'
        + '.grid{display:grid;grid-template-columns:repeat(' + S.sheet.cols + ',' + g.W + 'in);column-gap:' + S.sheet.colGap + 'in;row-gap:' + S.sheet.rowGap + 'in;justify-content:start;}'
        + '.lp{outline:1px solid #000;}';
      // one label + a ruler note
      labelsHtml = _labelPrintHtml(units[0], pngs[units[0].id], g)
        + '<div style="grid-column:1/-1;font:10pt Arial;margin-top:12pt;">Alignment test: the outlined box must measure exactly ' + g.W + '" x ' + g.H + '". Print at 100% scale (turn OFF "fit to page"). Adjust margins/pitch to your stock if it is off.</div>';
      wrapOpen = '<div class="grid">'; wrapClose = '</div>';
    } else { // laser_sheet
      css = '@page{size:letter;margin:' + S.sheet.mTop + 'in ' + S.sheet.mLeft + 'in;}'
        + '.grid{display:grid;grid-template-columns:repeat(' + S.sheet.cols + ',' + g.W + 'in);column-gap:' + S.sheet.colGap + 'in;row-gap:' + S.sheet.rowGap + 'in;justify-content:start;}';
      wrapOpen = '<div class="grid">'; wrapClose = '</div>';
    }

    var w = window.open('', '_blank', 'width=900,height=1000');
    if (!w) { toast('Allow pop-ups to print labels'); return; }
    w.document.write('<!doctype html><html><head><meta charset="utf-8"><title>Unit Labels</title><style>'
      + '*{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact;margin:0;padding:0;}'
      + 'html,body{font-family:Arial,Helvetica,sans-serif;}' + css
      + '@media screen{body{background:#eee;padding:16px;}.grid,.lp{background:#fff;}.lp{outline:1px dashed #ccc;}}'
      + '</style></head><body>' + wrapOpen + labelsHtml + wrapClose
      + '<scr' + 'ipt>setTimeout(function(){window.focus();window.print();},350);</scr' + 'ipt></body></html>');
    w.document.close();

    if (mode !== 'alignment') _recordPrints(units.map(function (u) { return u.id; }), mode, mode === 'roll' ? 'roll' : 'laser sheet', null);
  }

  // One label for the print sheet (exact inches).
  function _labelPrintHtml(u, qrSrc, g) {
    var accent = (S.cfg && S.cfg.accent_colour)
      || (typeof window._themeAccentHex === 'function' ? window._themeAccentHex() : '')
      || '#F8E41A';
    var contacts = S.contacts.filter(function (c) { return (c.label || c.phone); });
    var bandLines = contacts.map(function (c) {
      return '<div style="color:' + esc(accent) + ';font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc((c.label ? c.label + ': ' : '') + (c.phone || '')) + '</div>';
    }).join('');
    var housing = [((S.cfg && S.cfg.department_label) || ''), ((S.cfg && S.cfg.housing_email) || ''), ((S.cfg && S.cfg.housing_phone) || '')].filter(Boolean).join('  |  ');
    var logo = nationLogo();
    return '<div class="lp" style="width:' + g.W + 'in;height:' + g.H + 'in;position:relative;overflow:hidden;">'
      + '<div style="display:flex;gap:' + g.pad + 'in;padding:' + g.pad + 'in;height:' + g.topH + 'in;">'
      +   '<div style="width:' + g.qr + 'in;height:' + g.qr + 'in;flex:0 0 auto;">' + (qrSrc ? '<img src="' + qrSrc + '" style="width:100%;height:100%;"/>' : '') + '</div>'
      +   '<div style="flex:1;min-width:0;">'
      +     '<div style="font-weight:800;color:#111;line-height:1.02;font-size:12.5pt;overflow:hidden;">' + esc(unitAddr(u)) + '</div>'
      +     '<div style="color:#888;font-size:7pt;margin-top:0.02in;">' + esc((S.cfg && S.cfg.default_community) || '') + '</div>'
      +     '<div style="color:#666;font-weight:700;font-size:5.4pt;margin-top:0.02in;">' + esc((S.cfg && S.cfg.cta_text) || 'SCAN TO REPORT AN ISSUE') + '</div>'
      +   '</div>'
      + '</div>'
      + '<div style="position:absolute;bottom:0;left:0;right:0;height:' + g.band + 'in;background:#000;display:flex;align-items:center;gap:' + g.pad + 'in;padding:0 ' + g.pad + 'in;">'
      +   (logo ? '<img src="' + esc(logo) + '" style="height:' + (g.band * 0.6) + 'in;width:auto;flex:0 0 auto;filter:brightness(0) invert(1);"/>' : '')
      +   '<div style="flex:1;min-width:0;font-size:6pt;line-height:1.12;">' + bandLines
      +     '<div style="color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(housing) + '</div>'
      +   '</div>'
      + '</div>'
      + '</div>';
  }

  // ---- Metal press PDF (single-ink K, knockout band) ------------------------
  function _loadJsPdf() {
    // Delegates to the shared lazy-loader in shared.js (single implementation).
    return window.loadJsPdf();
  }
  // Recolour a logo to a solid-white silhouette (knockout on the black band).
  function _whiteSilhouette(src) {
    return new Promise(function (resolve) {
      if (!src) return resolve('');
      var img = new Image(); img.crossOrigin = 'anonymous';
      img.onload = function () {
        try {
          var cv = document.createElement('canvas'); cv.width = img.naturalWidth || 256; cv.height = img.naturalHeight || 256;
          var ctx = cv.getContext('2d'); ctx.drawImage(img, 0, 0);
          ctx.globalCompositeOperation = 'source-in'; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
          resolve(cv.toDataURL('image/png'));
        } catch (e) { resolve(''); }
      };
      img.onerror = function () { resolve(''); };
      img.src = src;
    });
  }

  async function _printMetalPdf(units) {
    var jsPDF;
    try { jsPDF = await _loadJsPdf(); } catch (e) { toast('Could not load the PDF engine (offline?)', { type: 'error' }); return; }
    if (!jsPDF) { toast('PDF engine unavailable', { type: 'error' }); return; }
    var g = geom();
    var bleed = 0.125, pageW = g.W + 2 * bleed, pageH = g.H + 2 * bleed;
    // Orientation must match the label's aspect: jsPDF normalises a custom
    // format so the SMALLER dimension is the width in portrait, so a 2x1 label
    // under the default portrait came out as a 1.25x2.25 PORTRAIT page with
    // the content drawn 2.25in wide - off the right edge, bottom half empty.
    var orient = pageW >= pageH ? 'landscape' : 'portrait';
    var doc = new jsPDF({ orientation: orient, unit: 'in', format: [pageW, pageH] });
    var whiteLogo = await _whiteSilhouette(nationLogo());
    var accentContacts = S.contacts.filter(function (c) { return (c.label || c.phone); });

    for (var i = 0; i < units.length; i++) {
      if (i > 0) doc.addPage([pageW, pageH], orient);
      var u = units[i];
      var ox = bleed, oy = bleed;                       // trim origin inside the bleed
      // Everything is 100% K. White (255) reads as "no ink" = bare metal (knockout).
      // QR -- black on bare metal.
      var qrSrc = await _qrPng(qrUrl(u));
      if (qrSrc) doc.addImage(qrSrc, 'PNG', ox + g.pad, oy + g.pad, g.qr, g.qr);
      // Address / community / CTA -- black text on bare metal.
      doc.setTextColor(0, 0, 0);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(12.5);
      doc.text(String(unitAddr(u)), ox + g.pad * 2 + g.qr, oy + g.pad + 0.16, { baseline: 'alphabetic' });
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(90, 90, 90);
      doc.text(String((S.cfg && S.cfg.default_community) || ''), ox + g.pad * 2 + g.qr, oy + g.pad + 0.30);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(5.4);
      doc.text(String((S.cfg && S.cfg.cta_text) || 'SCAN TO REPORT AN ISSUE'), ox + g.pad * 2 + g.qr, oy + g.pad + 0.42);
      // Bottom band -- black flood, knocked-out (white) content.
      var by = oy + g.H - g.band;
      doc.setFillColor(0, 0, 0); doc.rect(ox, by, g.W, g.band, 'F');
      if (whiteLogo) { try { doc.addImage(whiteLogo, 'PNG', ox + g.pad, by + g.band * 0.2, g.band * 0.6, g.band * 0.6); } catch (e) {} }
      doc.setTextColor(255, 255, 255);
      var lineY = by + 0.09, lx = ox + g.pad * 2 + g.band * 0.6;
      doc.setFont('helvetica', 'bold'); doc.setFontSize(6);
      accentContacts.forEach(function (c) {
        doc.text(String((c.label ? c.label + ': ' : '') + (c.phone || '')), lx, lineY); lineY += 0.095;
      });
      doc.setFont('helvetica', 'normal');
      var housing = [((S.cfg && S.cfg.department_label) || ''), ((S.cfg && S.cfg.housing_email) || ''), ((S.cfg && S.cfg.housing_phone) || '')].filter(Boolean).join('  |  ');
      if (housing) doc.text(String(housing), lx, lineY);
      // Crop marks at the trim corners.
      doc.setDrawColor(0, 0, 0); doc.setLineWidth(0.004);
      var m = 0.06;
      [[ox, oy], [ox + g.W, oy], [ox, oy + g.H], [ox + g.W, oy + g.H]].forEach(function (p, idx) {
        var sx = (idx % 2 === 0) ? -1 : 1, sy = (idx < 2) ? -1 : 1;
        doc.line(p[0], p[1], p[0] + sx * m, p[1]); doc.line(p[0], p[1], p[0], p[1] + sy * m);
      });
    }
    doc.save('metal-labels-' + new Date().toISOString().slice(0, 10) + '.pdf');
    _recordPrints(units.map(function (u) { return u.id; }), 'metal_pdf', 'anodised aluminium', null);
  }

  // Settings hook + boot.
  window.renderLabelsPanel = render;
})();
