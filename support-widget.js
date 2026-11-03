/* ============================================================================
 * support-widget.js - Help & Support assistant (Phases S1 + S2)
 *
 * A self-injecting widget for all three audiences (staff, community members,
 * contractors). It opens a CHAT with the support assistant (the `support-chat`
 * Edge Function, grounded in the SOPs/FAQ scoped to the audience); when the bot
 * cannot help, the user escalates to a TICKET form that files a row into
 * public.support_tickets (RLS gates the insert to reporter_user_id = auth.uid(),
 * set from the JWT `sub`) with the chat transcript attached, and best-effort
 * emails the nation's support_email (staff only). Gated by the `support` module.
 *
 * Portability: the staff app opens it from the avatar menu (no host adapter);
 * the portals set window.__supportHost = { source, getToken, reporter? } and get
 * a self-injected floating launcher. The widget is self-styled (var(--token,
 * neutral-fallback)) so it works on the portals, which load no shared CSS.
 * ==========================================================================*/
(function () {
  'use strict';

  function _esc(s) {
    if (typeof escapeHtml === 'function') return escapeHtml(String(s == null ? '' : s));
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  // Host adapter. The member/contractor portals set window.__supportHost =
  // { source, getToken:fn, reporter?:fn }. The staff app sets nothing and falls
  // back to HOUSING_SESSION.
  function _host() { return (window.__supportHost && typeof window.__supportHost === 'object') ? window.__supportHost : null; }
  function _token() {
    var h = _host();
    if (h && typeof h.getToken === 'function') { try { var t = h.getToken(); if (t) return t; } catch (e) {} }
    return (typeof HOUSING_SESSION !== 'undefined' && HOUSING_SESSION && HOUSING_SESSION.accessToken) || '';
  }
  function _claims() {
    try {
      var t = _token(); if (!t) return {};
      var b = t.split('.')[1]; if (!b) return {};
      return JSON.parse(atob(b.replace(/-/g, '+').replace(/_/g, '/'))) || {};
    } catch (e) { return {}; }
  }
  function _authUid() { return _claims().sub || ''; }
  function _source() { var h = _host(); return (h && h.source) || 'staff'; }
  function _hostReporter() { var h = _host(); if (h && typeof h.reporter === 'function') { try { return h.reporter() || {}; } catch (e) {} } return {}; }
  function _anon() { return (typeof SUPABASE_ANON !== 'undefined' && SUPABASE_ANON) || window.SUPABASE_ANON || ''; }
  // Headers for the PostgREST insert / Edge Function call, built from
  // SUPABASE_ANON + the current token so they work on every surface.
  function _insertHeaders() {
    var h = { 'Content-Type': 'application/json', 'Prefer': 'return=representation' };
    if (_anon()) h['apikey'] = _anon();
    var tok = _token(); if (tok) h['Authorization'] = 'Bearer ' + tok;
    return h;
  }
  function _fnHeaders() {
    var h = { 'Content-Type': 'application/json' };
    if (_anon()) h['apikey'] = _anon();
    var tok = _token(); if (tok) h['Authorization'] = 'Bearer ' + tok;
    return h;
  }

  var CATS = [
    { k: 'app_bug', l: 'Something is broken / a bug' },
    { k: 'access',  l: 'Sign-in / access problem' },
    { k: 'housing', l: 'Housing question (how do I...)' },
    { k: 'feature', l: 'Suggestion / feature request' },
    { k: 'other',   l: 'Something else' }
  ];
  var _chat = [];   // [{role:'user'|'assistant', text}]
  var _attach = []; // [{name,type,dataUrl}] screenshots attached to the report form

  function _injectStyles() {
    if (document.getElementById('support_widget_styles')) return;
    var st = document.createElement('style');
    st.id = 'support_widget_styles';
    st.textContent = [
      '#supportWidget{position:fixed;inset:0;z-index:100000;display:none;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,0.55);}',
      '#supportWidget .sw-card{background:var(--surface,#ffffff);color:var(--text,#1c1c1c);border:1px solid var(--border,#dcdcd4);border-radius:14px;width:100%;max-width:520px;max-height:92vh;display:flex;flex-direction:column;box-shadow:0 24px 60px rgba(0,0,0,0.4);font-family:"DM Sans",system-ui,-apple-system,sans-serif;}',
      '#supportWidget .sw-hd{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:14px 18px;border-bottom:1px solid var(--border,#dcdcd4);flex:0 0 auto;}',
      '#supportWidget .sw-title{font-size:16px;font-weight:700;}',
      '#supportWidget .sw-x{background:none;border:none;font-size:20px;line-height:1;cursor:pointer;color:var(--muted,#777068);padding:2px 6px;}',
      '#supportWidget .sw-bd{padding:14px 18px;overflow-y:auto;flex:1 1 auto;}',
      '#supportWidget label{display:block;font-size:12px;font-weight:600;margin:10px 0 4px;color:var(--muted,#555555);}',
      '#supportWidget select,#supportWidget input,#supportWidget textarea{width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid var(--border,#ccc6ba);border-radius:8px;font-size:13px;font-family:inherit;background:var(--surface,#ffffff);color:var(--text,#1c1c1c);}',
      '#supportWidget .sw-hint{font-size:11px;color:var(--muted,#777068);margin:6px 0 2px;line-height:1.5;}',
      '#supportWidget .sw-err{color:var(--danger,#b3261e);font-size:12px;margin-top:8px;display:none;}',
      '#supportWidget .sw-done{text-align:center;padding:14px 0;}',
      '#supportWidget .sw-ft{display:flex;justify-content:flex-end;gap:10px;padding:12px 18px;border-top:1px solid var(--border,#dcdcd4);flex:0 0 auto;}',
      '#supportWidget .sw-btn{padding:8px 16px;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;border:1px solid var(--border,#ccc6ba);background:transparent;color:var(--text,#1c1c1c);}',
      '#supportWidget .sw-btn-primary{background:var(--yellow,#26221c);color:var(--on-accent,#ffffff);border-color:transparent;}',
      '#supportWidget .sw-chat{min-height:180px;display:flex;flex-direction:column;gap:8px;padding:2px 0 10px;}',
      '#supportWidget .sw-msg{max-width:86%;padding:8px 11px;border-radius:12px;font-size:13px;line-height:1.45;white-space:pre-wrap;word-wrap:break-word;}',
      '#supportWidget .sw-msg-user{align-self:flex-end;background:var(--yellow,#26221c);color:var(--on-accent,#ffffff);border-bottom-right-radius:4px;}',
      '#supportWidget .sw-msg-bot{align-self:flex-start;background:var(--bg,#f4f1ea);color:var(--text,#1c1c1c);border:1px solid var(--border,#dcdcd4);border-bottom-left-radius:4px;}',
      '#supportWidget .sw-row{display:flex;gap:8px;align-items:flex-end;margin-top:4px;}',
      '#supportWidget .sw-row textarea{flex:1;min-height:38px;max-height:120px;resize:none;}',
      '#supportWidget .sw-link{background:none;border:none;color:var(--muted,#777068);font-size:12px;text-decoration:underline;cursor:pointer;padding:10px 0 0;font-family:inherit;display:block;}',
      '#supportWidget input[type=file]{padding:6px;font-size:12px;}',
      '#supportWidget .sw-thumbs{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;}',
      '#supportWidget .sw-thumb{position:relative;width:64px;height:64px;border-radius:8px;overflow:hidden;border:1px solid var(--border,#dcdcd4);background:var(--bg,#f4f1ea);}',
      '#supportWidget .sw-thumb img{width:100%;height:100%;object-fit:cover;display:block;}',
      '#supportWidget .sw-thumb button{position:absolute;top:2px;right:2px;width:18px;height:18px;border-radius:50%;border:none;background:var(--danger,#b3261e);color:var(--on-accent,#ffffff);font-size:12px;line-height:1;cursor:pointer;padding:0;}'
    ].join('');
    document.head.appendChild(st);
  }

  function _ensure() {
    _injectStyles();
    if (document.getElementById('supportWidget')) return;
    var ov = document.createElement('div');
    ov.id = 'supportWidget';
    ov.onclick = function (e) { if (e.target === ov) closeSupportWidget(); };
    var optsHtml = CATS.map(function (c) { return '<option value="' + c.k + '">' + _esc(c.l) + '</option>'; }).join('');
    ov.innerHTML = ''
      + '<div class="sw-card">'
      +   '<div class="sw-hd"><div class="sw-title">🛟 Help &amp; Support</div>'
      +     '<button type="button" class="sw-x" onclick="closeSupportWidget()" aria-label="Close">✕</button></div>'
      +   '<div class="sw-bd">'
      +     '<div id="support_chat_view">'
      +       '<div id="support_chat_msgs" class="sw-chat"></div>'
      +       '<div class="sw-row"><textarea id="support_chat_input" rows="1" placeholder="Ask a question..."></textarea>'
      +         '<button type="button" id="support_chat_send" class="sw-btn sw-btn-primary" onclick="_supportChatSend()">Send</button></div>'
      +       '<button type="button" class="sw-link" onclick="_supportShowForm()">Not solved? Report an issue to a person →</button>'
      +     '</div>'
      +     '<div id="support_form_view" style="display:none;">'
      +       '<label>What do you need?</label><select id="support_cat">' + optsHtml + '</select>'
      +       '<label>Subject</label><input id="support_subject" type="text" placeholder="Short summary" autocomplete="off"/>'
      +       '<label>Details</label><textarea id="support_body" rows="4" placeholder="What happened, what you expected, and any steps to reproduce..."></textarea>'
      +       '<label>Screenshots (optional)</label>'
      +       '<input id="support_files" type="file" accept="image/*" multiple onchange="_supportPickFiles(this)"/>'
      +       '<div class="sw-hint">Attach up to 4 images — screenshots help a lot. Large images are shrunk automatically.</div>'
      +       '<div id="support_thumbs" class="sw-thumbs"></div>'
      +       '<div class="sw-hint">We’ll include the page you’re on and your account (and this chat) so the team can follow up.</div>'
      +       '<div id="support_err" class="sw-err"></div>'
      +       '<div class="sw-row" style="justify-content:flex-end;margin-top:12px;">'
      +         '<button type="button" class="sw-btn" onclick="_supportShowChat()">← Back</button>'
      +         '<button type="button" id="support_send_btn" class="sw-btn sw-btn-primary" onclick="_supportSubmit()">Send to help desk</button>'
      +       '</div>'
      +     '</div>'
      +     '<div id="support_done" class="sw-done" style="display:none;">'
      +       '<div style="font-size:34px;line-height:1;">✅</div>'
      +       '<div style="font-weight:700;margin:8px 0 4px;">Thanks — your report was sent.</div>'
      +       '<div class="sw-hint" style="text-align:center;">The housing help desk will follow up.</div>'
      +       '<div id="support_ref" class="sw-hint" style="text-align:center;"></div>'
      +     '</div>'
      +   '</div>'
      +   '<div class="sw-ft"><button type="button" class="sw-btn" onclick="closeSupportWidget()">Close</button></div>'
      + '</div>';
    document.body.appendChild(ov);
    var ci = document.getElementById('support_chat_input');
    if (ci) ci.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); _supportChatSend(); }
    });
  }

  function _setView(v) {
    var map = { chat: 'support_chat_view', form: 'support_form_view', done: 'support_done' };
    Object.keys(map).forEach(function (k) { var e = document.getElementById(map[k]); if (e) e.style.display = (k === v) ? '' : 'none'; });
  }

  function openSupportWidget() {
    if (typeof moduleOn === 'function' && !moduleOn('support')) {
      if (typeof showToast === 'function') showToast('Help & Support is turned off for this nation.', { type: 'info' });
      return;
    }
    _ensure();
    _setView('chat');
    var err = document.getElementById('support_err'); if (err) err.style.display = 'none';
    var btn = document.getElementById('support_send_btn'); if (btn) { btn.disabled = false; btn.textContent = 'Send to help desk'; }
    _attach = [];                                          // fresh session: drop any prior attachments
    var tb = document.getElementById('support_thumbs'); if (tb) tb.innerHTML = '';
    var fi = document.getElementById('support_files'); if (fi) fi.value = '';
    var ov = document.getElementById('supportWidget'); if (ov) ov.style.display = 'flex';
    _greet();
    var ci = document.getElementById('support_chat_input'); if (ci) setTimeout(function () { try { ci.focus(); } catch (e) {} }, 30);
  }
  function closeSupportWidget() { var ov = document.getElementById('supportWidget'); if (ov) ov.style.display = 'none'; }

  // ---- Chat ------------------------------------------------------------------
  function _chatMsgs() { return document.getElementById('support_chat_msgs'); }
  function _chatAppend(role, text) {
    var el = _chatMsgs(); if (!el) return null;
    var d = document.createElement('div');
    d.className = 'sw-msg ' + (role === 'user' ? 'sw-msg-user' : 'sw-msg-bot');
    d.textContent = text;
    el.appendChild(d); el.scrollTop = el.scrollHeight;
    return d;
  }
  function _greet() {
    if (_chat.length) return;
    _chatAppend('assistant', 'Hi! I can help with how-to questions about the app. What do you need? If it’s a bug or needs a person, use “Report an issue to a person” below.');
  }
  async function _supportChatSend() {
    var inp = document.getElementById('support_chat_input');
    var text = ((inp && inp.value) || '').trim();
    if (!text) return;
    if (inp) inp.value = '';
    _chatAppend('user', text);
    _chat.push({ role: 'user', text: text });
    var typing = _chatAppend('assistant', '…');
    var sb = document.getElementById('support_chat_send'); if (sb) sb.disabled = true;
    try {
      var r = await fetch(SUPABASE_URL + '/functions/v1/support-chat', {
        method: 'POST', headers: _fnHeaders(),
        body: JSON.stringify({
          message: text,
          history: _chat.slice(0, -1),
          source: _source(),
          nation_name: (window.NATION_CONFIG && window.NATION_CONFIG.display_name) || '',
          faq: (window._supportFaq || '')
        })
      });
      var d = await r.json().catch(function () { return {}; });
      var reply = d.reply || (r.status === 401 ? 'Please sign in to use the assistant.' : 'Sorry, something went wrong. You can still use “Report an issue to a person” below.');
      if (typing) typing.textContent = reply; else _chatAppend('assistant', reply);
      _chat.push({ role: 'assistant', text: reply });
      var el = _chatMsgs(); if (el) el.scrollTop = el.scrollHeight;
    } catch (e) {
      if (typing) typing.textContent = 'I couldn’t reach the assistant. You can still “Report an issue to a person” below.';
    } finally {
      if (sb) sb.disabled = false;
    }
  }
  function _supportShowChat() { _setView('chat'); var ci = document.getElementById('support_chat_input'); if (ci) try { ci.focus(); } catch (e) {} }
  function _supportShowForm() {
    _setView('form');
    // Details box stays EMPTY for the user to write their own description. The
    // chat is still attached to the ticket via `transcript`, so staff keep the
    // context without the conversation cluttering the reporter's text box.
    var sub = document.getElementById('support_subject'); if (sub) setTimeout(function () { try { sub.focus(); } catch (e) {} }, 30);
  }

  function _ctx() {
    return {
      page: (location.pathname.replace(/^.*\//, '') || 'index.html'),
      url: location.href,
      app_version: (window.CLFN_APP_VERSION || ''),
      user_agent: navigator.userAgent,
      viewport: (window.innerWidth || 0) + 'x' + (window.innerHeight || 0)
    };
  }

  // ---- Screenshot attachments ------------------------------------------------
  // Images are downscaled + JPEG-compressed in the browser and carried as base64
  // in the ticket's `attachments` jsonb. No Storage upload: the portals have no
  // storage grants (and load no shared JS), so this works identically for staff,
  // members and contractors with no bucket policy or migration. Capped so a row
  // stays reasonable (4 images; ~2.2MB each after shrinking).
  function _compressImage(file) {
    return new Promise(function (resolve, reject) {
      if (!file || !/^image\//.test(file.type || '')) { reject(new Error('not an image')); return; }
      var fr = new FileReader();
      fr.onerror = function () { reject(new Error('read failed')); };
      fr.onload = function () {
        var img = new Image();
        img.onerror = function () { reject(new Error('decode failed')); };
        img.onload = function () {
          try {
            var max = 1400;
            var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
            var scale = Math.min(1, max / Math.max(w || 1, h || 1));
            var cw = Math.max(1, Math.round((w || 1) * scale)), ch = Math.max(1, Math.round((h || 1) * scale));
            var cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
            cv.getContext('2d').drawImage(img, 0, 0, cw, ch);
            resolve({ name: file.name || 'screenshot.jpg', type: 'image/jpeg', dataUrl: cv.toDataURL('image/jpeg', 0.7) });
          } catch (e) { reject(e); }
        };
        img.src = fr.result;
      };
      fr.readAsDataURL(file);
    });
  }
  function _noteToast(msg, type) { if (typeof showToast === 'function') try { showToast(msg, { type: type || 'info' }); } catch (e) {} }
  async function _supportPickFiles(input) {
    var files = (input && input.files) ? Array.prototype.slice.call(input.files) : [];
    if (input) input.value = '';   // allow re-picking the same file
    for (var i = 0; i < files.length; i++) {
      if (_attach.length >= 4) { _noteToast('You can attach up to 4 images.'); break; }
      try {
        var a = await _compressImage(files[i]);
        if (a.dataUrl.length > 2200000) { _noteToast('“' + (files[i].name || 'image') + '” is too large even after shrinking — skipped.', 'error'); continue; }
        _attach.push(a);
      } catch (e) { _noteToast('Could not add that image.', 'error'); }
    }
    _renderThumbs();
  }
  function _renderThumbs() {
    var el = document.getElementById('support_thumbs'); if (!el) return;
    el.innerHTML = _attach.map(function (a, i) {
      return '<div class="sw-thumb"><img src="' + a.dataUrl + '" alt=""/>'
        + '<button type="button" title="Remove" onclick="_supportRemoveFile(' + i + ')">&times;</button></div>';
    }).join('');
  }
  function _supportRemoveFile(i) { _attach.splice(i, 1); _renderThumbs(); }

  async function _supportSubmit() {
    var cat = (document.getElementById('support_cat') || {}).value || 'other';
    var subject = ((document.getElementById('support_subject') || {}).value || '').trim();
    var body = ((document.getElementById('support_body') || {}).value || '').trim();
    var err = document.getElementById('support_err');
    function fail(msg) { if (err) { err.textContent = msg; err.style.display = 'block'; } }
    if (!body) { fail('Please describe the issue.'); return; }
    var uid = _authUid();
    if (!uid) { fail(_token() ? 'Could not confirm your sign-in — please reload and try again.' : 'Please sign in first, then report an issue.'); return; }
    var btn = document.getElementById('support_send_btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
    if (err) err.style.display = 'none';
    var nc = window.NATION_CONFIG || {};
    var hr = _hostReporter();
    var cl = _claims();
    var src = _source();
    var row = {
      nation: nc.id || nc.short || '',
      source: src,
      reporter_user_id: uid,
      reporter_name: hr.name || (typeof HOUSING_SESSION !== 'undefined' && HOUSING_SESSION.name) || '',
      reporter_email: hr.email || (typeof HOUSING_SESSION !== 'undefined' && HOUSING_SESSION.email) || cl.email || '',
      reporter_phone: hr.phone || cl.phone || '',
      reporter_role: (src === 'staff') ? (window.currentRole || window._realRole || '') : '',
      category: cat,
      subject: subject || ('[' + cat + '] support request'),
      body: body,
      context: _ctx(),
      transcript: _chat.map(function (m) { return { role: m.role, text: m.text, at: new Date().toISOString() }; }),
      attachments: _attach.slice(),
      status: 'new'
    };
    try {
      var r = await fetch(SUPABASE_URL + '/rest/v1/support_tickets', { method: 'POST', headers: _insertHeaders(), body: JSON.stringify(row) });
      if (!r.ok) { var t = await r.text().catch(function () { return ''; }); throw new Error('HTTP ' + r.status + ' ' + t.slice(0, 160)); }
      var saved = await r.json().catch(function () { return []; });
      var ticket = (saved && saved[0]) || row;
      if (src === 'staff') _supportNotify(ticket);
      _attach = [];                                        // clear attachments after a successful send
      var _tb = document.getElementById('support_thumbs'); if (_tb) _tb.innerHTML = '';
      var _fi = document.getElementById('support_files'); if (_fi) _fi.value = '';
      _setView('done');
      var ref = document.getElementById('support_ref');
      if (ref && ticket.id) ref.textContent = 'Reference: ' + String(ticket.id).slice(0, 8);
    } catch (e) {
      console.warn('[support] submit failed:', e);
      fail('Could not send your report. Check your connection and try again. (If this keeps happening, the support_tickets migration may not be run yet.)');
      if (btn) { btn.disabled = false; btn.textContent = 'Send to help desk'; }
    }
  }

  // Best-effort email to the nation's help desk (staff only; send-notification is
  // staff-JWT gated). The ticket is stored regardless, so a failed email is fine.
  function _supportNotify(ticket) {
    try {
      var nc = window.NATION_CONFIG || {};
      var to = nc.support_email || nc.housing_email || '';
      if (!to || typeof window.sendNotification !== 'function') return;
      var catLabel = (CATS.filter(function (c) { return c.k === ticket.category; })[0] || {}).l || ticket.category;
      var ctxUrl = (ticket.context && ticket.context.url) || '';
      var html = ''
        + '<p><strong>New support request</strong> — ' + _esc(catLabel) + '</p>'
        + '<p><strong>From:</strong> ' + _esc(ticket.reporter_name || ticket.reporter_email || 'staff')
        +   ' (' + _esc(ticket.reporter_email || '') + (ticket.reporter_role ? (' · ' + _esc(ticket.reporter_role)) : '') + ')</p>'
        + (ticket.subject ? ('<p><strong>Subject:</strong> ' + _esc(ticket.subject) + '</p>') : '')
        + '<p><strong>Details:</strong><br>' + _esc(ticket.body).replace(/\n/g, '<br>') + '</p>'
        + (((ticket.attachments || []).length) ? ('<p><strong>' + ticket.attachments.length + ' screenshot(s) attached</strong> — view them in the Support queue.</p>') : '')
        + '<p><small>Page: ' + _esc(ctxUrl) + '</small></p>';
      window.sendNotification({ to: to, subject: 'Support request: ' + (ticket.subject || catLabel), html: html })
        .catch(function (e) { console.warn('[support] notify failed:', e); });
    } catch (e) { /* best-effort */ }
  }

  // Floating "Help" launcher (bottom-right). Portals (host adapter set) always
  // get it -- it's their only entry point. The staff app shows it too, but gated
  // by the nation setting `support_launcher` (default ON, ED-toggled in
  // Settings -> Nation) plus the support module and a signed-in session.
  function _launcherOn() {
    if (typeof moduleOn === 'function' && !moduleOn('support')) return false;
    if (_host()) return true;                                // portals: always on
    var signedIn = (typeof HOUSING_SESSION !== 'undefined' && HOUSING_SESSION && HOUSING_SESSION.accessToken);
    if (!signedIn) return false;                             // not on the login screen
    var s = (window._appSettings && window._appSettings.support_launcher);
    return (typeof s === 'boolean') ? s : true;              // default ON
  }
  // Idempotent: injects when the gate is on and the button is absent, and REMOVES
  // it when the gate turns off -- so the settings toggle applies live.
  function _injectLauncher() {
    var existing = document.getElementById('support_launcher');
    if (!_launcherOn()) { if (existing && existing.remove) existing.remove(); return; }
    if (existing) return;
    _injectStyles();
    var b = document.createElement('button');
    b.id = 'support_launcher';
    b.type = 'button';
    b.textContent = '🛟';
    b.title = 'Help & Support';
    b.setAttribute('aria-label', 'Help and Support');
    b.setAttribute('style', 'position:fixed;right:18px;bottom:18px;z-index:99998;width:56px;height:56px;padding:0;border-radius:50%;border:1px solid var(--border,#ccc6ba);background:var(--surface,#ffffff);color:var(--text,#1c1c1c);font-size:26px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 6px 20px rgba(0,0,0,0.25);');
    b.onclick = openSupportWidget;
    document.body.appendChild(b);
  }
  window.showSupportLauncher = _injectLauncher;

  window.openSupportWidget = openSupportWidget;
  window.closeSupportWidget = closeSupportWidget;
  window._supportSubmit = _supportSubmit;
  window._supportPickFiles = _supportPickFiles;
  window._supportRemoveFile = _supportRemoveFile;
  window._supportChatSend = _supportChatSend;
  window._supportShowForm = _supportShowForm;
  window._supportShowChat = _supportShowChat;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _injectLauncher);
  else _injectLauncher();
  // Re-check after app settings hydrate on staff pages (the nation may have the
  // floating button turned off) and after sign-in state settles. Portals are
  // unaffected. Cheap + idempotent, so a couple of delayed passes are safe.
  try { window.addEventListener('load', _injectLauncher); } catch (e) {}
  setTimeout(_injectLauncher, 1500);
  setTimeout(_injectLauncher, 4000);
})();
