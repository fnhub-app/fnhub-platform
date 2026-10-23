/* ============================================================
 * ai-assistant.js — CLFN Housing Suite
 * AI chat panel + draft-note assist via Supabase Edge Function
 *
 * Load order: ... housing-init.js → THIS FILE
 *
 * Exposes globals:
 *   toggleAIChat()   — open / close the floating chat panel
 *   aiDraftNote()    — auto-draft approval notes for current app + action
 *   aiSendMessage()  — send the typed chat message
 * ============================================================ */

'use strict';

var _aiHistory   = [];
var _aiPanelOpen = false;

var AI_EDGE_URL  = (window.SUPABASE_URL || '') + '/functions/v1/ai-chat';

// ── Core: call Edge Function ─────────────────────────────────────────────────
// Sends the signed-in user's access token (the Edge Function verifies the JWT
// and that the caller is active staff). Falls back to the anon key only if no
// session is present, which the function will reject with 401.
function _aiCall(payload) {
  var token = (window.HOUSING_SESSION && window.HOUSING_SESSION.accessToken)
    || window.SUPABASE_ANON || '';
  return fetch(AI_EDGE_URL, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': 'Bearer ' + token,
    },
    body: JSON.stringify(payload),
  }).then(function(r) { return r.json(); });
}

// ── Draft Note ───────────────────────────────────────────────────────────────
// Called by the "Draft with AI" button inside the approval modal.
function aiDraftNote() {
  if (window.CLFN_MODULES && !CLFN_MODULES.isEnabled('ai_assistant')) {
    showToast('AI Assistant is disabled for this nation.', { type: 'error' }); return;
  }
  var app = window._currentScorecardApp;
  if (!app) { showToast('No application selected.', { type: 'error' }); return; }

  var action = (window._pendingApprovalAction || {}).action || '';
  var unitEl  = document.getElementById('approvalModal_unit_display');
  var unit    = unitEl ? unitEl.textContent.trim() : '';

  var btn = document.getElementById('ai_draft_btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Drafting…'; }

  _aiCall({
    type:    'draft',
    message: 'Draft the note.',
    context: {
      app:    app,
      action: action,
      unit:   unit,
      role:   window._effectiveRole || window.currentRole || '',
    },
    history: [],
  }).then(function(data) {
    if (data.error) throw new Error(data.error);
    var notesEl = document.getElementById('approvalModal_notes');
    if (notesEl) { notesEl.value = data.reply; notesEl.focus(); }
  }).catch(function(err) {
    showToast('AI draft failed: ' + err.message, { type: 'error' });
  }).finally(function() {
    if (btn) { btn.disabled = false; btn.innerHTML = '<span style="color:var(--yellow)">✦</span> Draft with AI'; }
  });
}

// ── Chat Panel: self-inject ──────────────────────────────────────────────────
// housing.html ships the panel as static markup, but the assistant button is in
// the shared header on every page that loads housing-init.js. Self-inject the
// panel (idempotent) so the AI works on any page that loads this script, not
// just the ones with the static markup -- mirrors how the TIC / reno
// questionnaire inject their own modals.
function _ensureAIPanel() {
  if (document.getElementById('ai_chat_panel')) return;
  if (!document.body) return;
  var natSub = (window.NATION_CONFIG && (NATION_CONFIG.display_name || NATION_CONFIG.name)) || '';
  var wrap = document.createElement('div');
  wrap.id = 'ai_chat_panel';
  wrap.style.cssText = 'display:none;position:fixed;bottom:24px;right:24px;width:360px;max-height:520px;background:var(--surface);border:1px solid var(--border);border-radius:16px;box-shadow:0 24px 60px rgba(0,0,0,0.5);z-index:1200;flex-direction:column;overflow:hidden;';
  wrap.innerHTML = ''
    + '<div style="background:var(--dark);padding:14px 18px;border-bottom:2px solid var(--yellow);display:flex;align-items:center;justify-content:space-between;flex-shrink:0;">'
    +   '<div style="display:flex;align-items:center;gap:8px;">'
    +     '<span style="color:var(--yellow);font-size:16px;">✦</span>'
    +     '<div>'
    +       '<div style="font-family:\'DM Serif Display\',serif;font-size:15px;color:#fff;">AI Assistant</div>'
    +       '<div style="font-size:11px;color:#666;">' + natSub + '</div>'
    +     '</div>'
    +   '</div>'
    +   '<button onclick="closeAIChat()" style="background:none;border:1px solid #444;color:#ccc;width:28px;height:28px;border-radius:6px;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center;">✕</button>'
    + '</div>'
    + '<div id="ai_chat_messages" style="flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;"></div>'
    + '<div style="padding:12px 14px;border-top:1px solid var(--border);display:flex;gap:8px;flex-shrink:0;">'
    +   '<textarea id="ai_chat_input" rows="1" placeholder="Ask anything about applications, units, or policy..." style="flex:1;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:8px 12px;font-size:13px;color:var(--text);font-family:DM Sans,sans-serif;resize:none;outline:none;line-height:1.4;max-height:80px;overflow-y:auto;" oninput="this.style.height=\'auto\';this.style.height=Math.min(this.scrollHeight,80)+\'px\'"></textarea>'
    +   '<button id="ai_chat_send" onclick="aiSendMessage()" class="btn btn-primary" style="flex-shrink:0;align-self:flex-end;">Send</button>'
    + '</div>';
  document.body.appendChild(wrap);
  // Bind Enter-to-send on the freshly injected input (the static-panel binding
  // in the DOMContentLoaded handler below only catches housing.html's markup).
  var inp = wrap.querySelector('#ai_chat_input');
  if (inp) inp.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); aiSendMessage(); }
  });
}

// ── Chat Panel: open / close / toggle ────────────────────────────────────────
function openAIChat() {
  if (window.CLFN_MODULES && !CLFN_MODULES.isEnabled('ai_assistant')) return;
  _ensureAIPanel();
  var panel = document.getElementById('ai_chat_panel');
  if (panel) panel.style.display = 'flex';
  _aiPanelOpen = true;
  // Greet on first open
  if (_aiHistory.length === 0) {
    _appendAIMessage('assistant', 'Hi! I can help you look up applications, check unit availability, or answer housing policy questions. What do you need?');
  }
  setTimeout(function() {
    var inp = document.getElementById('ai_chat_input');
    if (inp) inp.focus();
  }, 80);
}

function closeAIChat() {
  var panel = document.getElementById('ai_chat_panel');
  if (panel) panel.style.display = 'none';
  _aiPanelOpen = false;
}

function toggleAIChat() {
  _aiPanelOpen ? closeAIChat() : openAIChat();
}

// ── Chat: send a message ─────────────────────────────────────────────────────
function aiSendMessage() {
  var inp = document.getElementById('ai_chat_input');
  if (!inp) return;
  var msg = inp.value.trim();
  if (!msg) return;
  inp.value = '';

  _appendAIMessage('user', msg);
  _aiHistory.push({ role: 'user', content: msg });

  var sendBtn = document.getElementById('ai_chat_send');
  if (sendBtn) sendBtn.disabled = true;
  _appendAIMessage('assistant', '…', 'ai_typing_msg');

  // Flatten SOW cache into an array for context. _sowCache[unitId] is a wrapper
  // { sows:[...] } — one entry PER SOW — so we must iterate .sows, not read
  // fields off the wrapper. Surface the real approval state incl. the
  // system_approved flag (auto-approval via RFQ award, distinct from a manual
  // ED sign-off) so the assistant doesn't mislabel it as "ED Approved".
  var sowList = [];
  try {
    var sowCache = window._sowCache || {};
    Object.keys(sowCache).forEach(function(uid) {
      var wrap = sowCache[uid];
      if (!wrap || typeof wrap !== 'object') return;
      var arr = Array.isArray(wrap.sows) ? wrap.sows : (Array.isArray(wrap) ? wrap : [wrap]);
      arr.forEach(function(s) {
        if (!s || typeof s !== 'object') return;
        var items = Array.isArray(s.items) ? s.items
                  : Array.isArray(s.sow_items) ? s.sow_items
                  : Array.isArray(s.line_items) ? s.line_items : [];
        var total = (typeof s.amount === 'number' ? s.amount : parseFloat(s.amount)) ||
                    items.reduce(function(sum, i) {
                      return sum + (parseFloat(i.cost || i.amount || i.total || 0) || 0);
                    }, 0);
        var status = s.approval_status || '';
        sowList.push({
          unit_id:          uid,
          project_number:   s.project_number || '',
          contractor:       s.assignedToName || s.contractor_name || s.contractor || '',
          assigned_team:    s.assignedTeam || '',
          approval_status:  status,
          approved:         (status === 'ed_approved' || status === 'hm_approved' || status === 'completed'),
          system_approved:  !!s.system_approved,   // auto-approved via RFQ award, NOT a manual ED sign-off
          approved_via_rfq: !!s.approved_via_rfq,
          total:            total,
          item_count:       items.length
        });
      });
    });
  } catch(e) { console.warn('[AI] SOW build error:', e); }

  var ctx = {
    role:        window._effectiveRole || window.currentRole || '',
    // Local-time context so "today"/"yesterday" in activity reports use the
    // nation's calendar day, not UTC (an evening report was rolling into the
    // next UTC day and showing almost no activity).
    localDate:   (function(){ var d=new Date(); return d.getFullYear()+'-'+('0'+(d.getMonth()+1)).slice(-2)+'-'+('0'+d.getDate()).slice(-2); })(),
    tzOffsetMin: new Date().getTimezoneOffset(),
    tzName:      (function(){ try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch(e){ return ''; } })(),
    apps:        (window.applications  || []).map(function(a) {
      return {
        id: a.id, fn: a.fn, ln: a.ln, status: a.status,
        score: a.score || a.total_score, tier: a.tier,
        bedrooms: a.bed_req || a.bedrooms, household_size: a.household_size || a.adults,
        app_type: a.appType || a.app_type || a.type,  // loaded apps use camelCase appType (sbLoadApplications mapper)
        assignedUnit: a.assignedUnit, assignedAddress: a.assignedAddress,
        submittedAt: a.submittedAt,
        reserve: a.reserve,
        living_situation: a.livingSituation || undefined,   // own_home | family_on_reserve (doubled up) | renting_off_reserve | temporary_shelter | no_fixed_address | other
        deceased: a.deceased || undefined,
        bcr_ineligible: (typeof appIsBcrIneligible === 'function' && appIsBcrIneligible(a)) || undefined,
      };
    }),
    units:       (window.housingUnits  || []).map(function(u) {
      return {
        id: u.id, address: (u.num ? u.num + ' ' + u.street : u.address || u.unit_address),
        bedrooms: u.bedrooms, bathrooms: u.bathrooms, type: u.type,
        status: u.status, accessible: u.accessible, isElders: u.isElders,
        funder: u.funder, assignedTo: u.assignedTo, assignedName: u.assignedName,
      };
    }),
    sows:        sowList,
    rfqs:        Object.keys(window._rfqCache || {}).map(function(id) {
      var r = window._rfqCache[id] || {};
      var d = r.data || {};
      return {
        id: id,
        unit_id: r.sow_unit_id || '',
        sow_project_number: r.sow_project_number || '',
        status: r.status || '',
        awarded_contractor_id: r.awarded_contractor_id || '',
        award_amount: r.award_amount || d.award_amount || 0,
        contract_number: d.contract_number || '',
        created_at: r.created_at
      };
    }),
    contractors: (window._contractors || []).map(function(c) {
      return { name: c.name, trade: c.trade, phone: c.phone, email: c.email, status: c.status };
    }),
    renoProgress: (function() {
      var rp = window._renoProgress || {};
      return Object.keys(rp).map(function(uid) {
        var d = rp[uid];
        return { unit_id: uid, overallPct: d.overallPct || 0, phases: d.phases || [] };
      });
    }()),
    // Capital projects (loaded on projects.html only — elsewhere the model
    // falls back to the query_database tool's housing_projects table).
    projects: (window._prjProjects || []).map(function(p) {
      var d = (p && typeof p.data === 'object' && p.data) || {};
      var expenses = d.expenses || [];
      var ms = d.milestones || [];
      var lots = (window._prjLots || []).filter(function(l){ return l.project_id === p.id; });
      return {
        id: p.id,
        project_number: p.project_number || '',
        name: p.name || '',
        type: p.type || '',
        status: p.status || '',
        funding_source: p.funding_source || '',
        po_number: d.poNumber || '',
        budget: p.budget != null ? Number(p.budget) : null,
        spent: expenses.reduce(function(s, e){ return s + (Number(e.amount) || 0); }, 0),
        milestones_done: ms.filter(function(m){ return m.done; }).length,
        milestones_total: ms.length,
        lots_total: lots.length,
        units_delivered: lots.filter(function(l){ return l.unit_id; }).length,
        start_date: p.start_date || null,
        target_date: p.target_date || null,
        allocated: !!d.allocation,
      };
    }),
  };

  _aiCall({
    type:    'chat',
    message: msg,
    context: ctx,
    history: _aiHistory.slice(0, -1),
  }).then(function(data) {
    if (data.error) throw new Error(data.error);
    _removeTyping();
    _appendAIMessage('assistant', data.reply);
    _aiHistory.push({ role: 'assistant', content: data.reply });
  }).catch(function(err) {
    _removeTyping();
    _appendAIMessage('assistant', 'Sorry, something went wrong: ' + err.message);
  }).finally(function() {
    if (sendBtn) sendBtn.disabled = false;
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function _removeTyping() {
  var t = document.getElementById('ai_typing_msg');
  if (t) t.remove();
}

function _appendAIMessage(role, text, id) {
  var msgs = document.getElementById('ai_chat_messages');
  if (!msgs) return;

  var wrap   = document.createElement('div');
  var isUser = role === 'user';
  wrap.style.cssText = 'display:flex;flex-direction:column;' +
    (isUser ? 'align-items:flex-end;' : 'align-items:flex-start;') +
    'margin-bottom:8px;';
  if (id) wrap.id = id;

  // Assistant replies may include ```chart {json}``` blocks — pull them out and
  // render real charts; the bubble keeps the surrounding prose.
  var charts = [];
  var displayText = text;
  if (!isUser && typeof text === 'string') {
    displayText = text.replace(/```chart\s*([\s\S]*?)```/g, function (_m, json) {
      try { charts.push(JSON.parse(json.trim())); return ''; }
      catch (e) { return _m; }   // leave unparseable blocks as text
    }).trim();
  }
  // No explicit chart blocks? Derive charts from any count/breakdown tables so
  // visuals appear without needing the ai-chat function redeploy.
  if (!isUser && !charts.length) charts = _aiDeriveChartSpecs(text).slice(0, 8);

  var bubble = document.createElement('div');
  bubble.style.cssText = [
    'max-width:85%;padding:9px 13px;border-radius:12px;font-size:13px;',
    'line-height:1.5;white-space:pre-wrap;word-break:break-word;',
    isUser
      ? 'background:var(--yellow);color:var(--dark);border-bottom-right-radius:3px;'
      : 'background:#2f3033;border:1px solid #444;color:#e8e8e5;border-bottom-left-radius:3px;',
  ].join('');
  bubble.textContent = displayText;

  if (displayText || !charts.length) wrap.appendChild(bubble);
  charts.forEach(function (spec) { _aiRenderChart(wrap, spec); });

  // Export-to-PDF affordance on substantive assistant replies (reports etc.).
  if (!isUser && id !== 'ai_typing_msg' && ((displayText && displayText.length > 60) || charts.length)) {
    var pdfBtn = document.createElement('button');
    pdfBtn.type = 'button';
    pdfBtn.textContent = '⬇ Export PDF';
    pdfBtn.style.cssText = 'align-self:flex-start;margin-top:6px;background:none;border:1px solid #555;color:#aaa;border-radius:6px;font-size:11px;font-weight:700;padding:3px 9px;cursor:pointer;font-family:DM Sans,sans-serif;';
    pdfBtn.addEventListener('click', function(){ _aiExportReplyPdf(text); });
    wrap.appendChild(pdfBtn);
  }

  msgs.appendChild(wrap);
  msgs.scrollTop = msgs.scrollHeight;
}

// ── Charts (lazy-loaded Chart.js, CSP-allowed cdnjs) ──────────────────────────
function _aiLoadChartJs(cb) {
  if (window.Chart) { cb(); return; }
  if (window._aiChartCbs) { window._aiChartCbs.push(cb); return; }
  window._aiChartCbs = [cb];
  var s = document.createElement('script');
  s.src = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js';
  s.onload  = function () { (window._aiChartCbs || []).forEach(function (f) { try { f(); } catch (e) {} }); window._aiChartCbs = null; };
  s.onerror = function () { window._aiChartCbs = null; };
  document.head.appendChild(s);
}

var _AI_CHART_PALETTE = ['#F8E41A','#3b82f6','#22c55e','#f59e0b','#ef4444','#a855f7','#06b6d4','#ec4899','#84cc16','#f97316','#94a3b8','#14b8a6'];

// ── Word cloud (notes/theme analytics) ───────────────────────────────────────
// wordcloud2.js is lazy-loaded from cdnjs (already CSP-allowlisted). The AI
// emits {"type":"wordcloud","title":"...","words":[{"text":"leak","weight":12}]}
// and we render it to a canvas (and to PNG for the PDF export).
function _aiLoadWordCloud(cb) {
  if (window.WordCloud) { cb(); return; }
  if (window._aiWcCbs) { window._aiWcCbs.push(cb); return; }
  window._aiWcCbs = [cb];
  var s = document.createElement('script');
  s.src = 'https://cdnjs.cloudflare.com/ajax/libs/wordcloud2.js/1.2.0/wordcloud2.min.js';
  s.onload  = function () { (window._aiWcCbs || []).forEach(function (f) { try { f(); } catch (e) {} }); window._aiWcCbs = null; };
  s.onerror = function () { window._aiWcCbs = null; };
  document.head.appendChild(s);
}
// Normalize a wordcloud spec's words into wordcloud2's [word, weight] list.
function _aiWordList(spec) {
  var words = spec.words || spec.list || [];
  var out = [];
  words.forEach(function (w) {
    if (Array.isArray(w)) { if (w[0]) out.push([String(w[0]), Number(w[1]) || 1]); }
    else if (w && typeof w === 'object') {
      var t = w.text || w.word || w.label;
      var wt = w.weight || w.count || w.value || 1;
      if (t) out.push([String(t), Number(wt) || 1]);
    }
  });
  return out;
}
// Draw a word cloud onto `canvas`. cb (optional) fires when rendering finishes
// (used by the PDF exporter, since wordcloud2 draws asynchronously).
function _aiDrawWordCloud(canvas, spec, cb) {
  _aiLoadWordCloud(function () {
    if (!window.WordCloud) { if (cb) cb(false); return; }
    var list = _aiWordList(spec);
    if (!list.length) { if (cb) cb(false); return; }
    var maxW = list.reduce(function (m, p) { return Math.max(m, p[1]); }, 1);
    var pal = _AI_CHART_PALETTE, ci = 0;
    var minFont = 13, maxFont = Math.min(64, Math.max(28, canvas.width / 9));
    if (cb) {
      var done = false;
      var finish = function (ok) { if (done) return; done = true; if (cb) cb(ok); };
      canvas.addEventListener('wordcloudstop', function h() { canvas.removeEventListener('wordcloudstop', h); finish(true); });
      setTimeout(function () { finish(true); }, 1200); // fallback if the event never fires
    }
    try {
      window.WordCloud(canvas, {
        list: list,
        gridSize: Math.round(canvas.width / 90),
        weightFactor: function (w) { return minFont + (w / maxW) * (maxFont - minFont); },
        fontFamily: 'DM Sans, Helvetica, sans-serif',
        color: function () { return pal[(ci++) % pal.length]; },
        backgroundColor: '#ffffff',
        rotateRatio: 0.3, rotationSteps: 2,
        drawOutOfBound: false, shrinkToFit: true
      });
    } catch (e) { if (cb) cb(false); }
  });
}

function _aiRenderChart(wrap, spec) {
  if (!spec || !spec.type) return;
  var holder = document.createElement('div');
  holder.style.cssText = 'background:#fff;border:1px solid #444;border-radius:10px;padding:10px;margin-top:8px;width:85%;max-width:100%;box-sizing:border-box;';
  var canvas = document.createElement('canvas');
  // Word cloud uses wordcloud2.js, not Chart.js.
  if (spec.type === 'wordcloud') {
    if (spec.title) {
      var wcTitle = document.createElement('div');
      wcTitle.textContent = spec.title;
      wcTitle.style.cssText = 'font-weight:700;color:#111;font-size:13px;margin-bottom:6px;text-align:center;';
      holder.appendChild(wcTitle);
    }
    canvas.width = 560; canvas.height = 300;
    canvas.style.cssText = 'width:100%;height:auto;max-height:300px;';
    holder.appendChild(canvas);
    wrap.appendChild(holder);
    _aiDrawWordCloud(canvas, spec, null);
    return;
  }
  canvas.style.cssText = 'width:100%;max-height:280px;';
  holder.appendChild(canvas);
  wrap.appendChild(holder);
  _aiLoadChartJs(function () {
    if (!window.Chart) { holder.textContent = 'Chart unavailable.'; return; }
    var isPie = spec.type === 'pie' || spec.type === 'doughnut';
    var labels = spec.labels || [];
    try {
      var datasets = (spec.datasets || []).map(function (d, i) {
        var color = isPie
          ? labels.map(function (_l, k) { return _AI_CHART_PALETTE[k % _AI_CHART_PALETTE.length]; })
          : _AI_CHART_PALETTE[i % _AI_CHART_PALETTE.length];
        return Object.assign({
          backgroundColor: color,
          borderColor: isPie ? '#fff' : color,
          borderWidth: isPie ? 1 : (spec.type === 'line' ? 2 : 1),
          fill: spec.type === 'line' ? false : undefined
        }, d);
      });
      new window.Chart(canvas.getContext('2d'), {
        type: spec.type,
        data: { labels: labels, datasets: datasets },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: {
            title:  { display: !!spec.title, text: spec.title || '', color: '#111' },
            legend: { display: isPie || (spec.datasets || []).length > 1, labels: { color: '#333' } }
          },
          scales: isPie ? {} : { x: { ticks: { color: '#333' } }, y: { ticks: { color: '#333' }, beginAtZero: true } }
        }
      });
    } catch (e) { holder.textContent = 'Could not render chart.'; }
  });
}

// ── Export an assistant reply as a branded PDF ───────────────────────────────
function _aiLoadScript(src, cb){ var s=document.createElement('script'); s.src=src; s.onload=cb; s.onerror=cb; document.head.appendChild(s); }
function _aiLoadPdfLibs(cb){
  // Delegates to the shared lazy-loader in shared.js (single implementation).
  // Preserves the old behaviour of always calling cb (the caller re-checks
  // window.jspdf before use), matching _aiLoadScript's onerror=cb semantics.
  window.loadJsPdf({ autotable: true }).then(function(){ cb(); }, function(){ cb(); });
}
// Render a chart spec to a PNG data URL via an offscreen Chart.js canvas.
function _aiChartToImage(spec, cb){
  // Word cloud renders via wordcloud2.js (asynchronous — wait for completion).
  if (spec && spec.type === 'wordcloud') {
    var wcCanvas = document.createElement('canvas'); wcCanvas.width = 700; wcCanvas.height = 360;
    _aiDrawWordCloud(wcCanvas, spec, function (ok) {
      if (!ok) { cb(null); return; }
      try { cb(wcCanvas.toDataURL('image/png')); } catch (e) { cb(null); }
    });
    return;
  }
  _aiLoadChartJs(function(){
    if (!window.Chart) { cb(null); return; }
    try {
      var canvas = document.createElement('canvas'); canvas.width = 700; canvas.height = 350;
      var isPie = spec.type === 'pie' || spec.type === 'doughnut';
      var labels = spec.labels || [];
      var datasets = (spec.datasets || []).map(function (d, i) {
        var color = isPie ? labels.map(function (_l, k) { return _AI_CHART_PALETTE[k % _AI_CHART_PALETTE.length]; }) : _AI_CHART_PALETTE[i % _AI_CHART_PALETTE.length];
        return Object.assign({ backgroundColor: color, borderColor: isPie ? '#fff' : color, borderWidth: 1 }, d);
      });
      var chart = new window.Chart(canvas.getContext('2d'), {
        type: spec.type, data: { labels: labels, datasets: datasets },
        options: { animation: false, responsive: false, plugins: { title: { display: !!spec.title, text: spec.title || '' }, legend: { display: isPie || (spec.datasets || []).length > 1 } } }
      });
      var img = canvas.toDataURL('image/png'); chart.destroy(); cb(img);
    } catch (e) { cb(null); }
  });
}
function _aiPdfClean(s){
  return String(s == null ? '' : s)
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{FE0F}]/gu, '')
    .replace(/\*\*/g, '').replace(/`/g, '').replace(/•/g, '').trim();
}
// Parse a number out of a markdown cell (handles $, %, commas).
function _aiParseNum(s){ if (s == null) return null; var m = String(s).replace(/[$,%\s]/g,'').match(/-?\d+(\.\d+)?/); return m ? parseFloat(m[0]) : null; }
// Markdown tables in order, each tagged with the nearest preceding heading.
function _aiMarkdownTables(md){
  var lines = String(md||'').split('\n'), out = [], lastHeading = '', i = 0;
  while (i < lines.length){
    var raw = (lines[i]||'').trim();
    var h = raw.match(/^#{1,6}\s+(.+)$/);
    if (h){ lastHeading = _aiPdfClean(h[1]); i++; continue; }
    if (raw.charAt(0) === '|'){
      var tbl = [];
      while (i < lines.length && (lines[i]||'').trim().charAt(0) === '|'){
        var cells = (lines[i]||'').trim().replace(/^\||\|$/g,'').split('|').map(function(c){ return c.trim(); });
        if (!cells.every(function(c){ return /^:?-{2,}:?$/.test(c) || c===''; })) tbl.push(cells);
        i++;
      }
      if (tbl.length >= 2) out.push({ header: tbl[0], rows: tbl.slice(1), title: lastHeading });
      continue;
    }
    i++;
  }
  return out;
}
// Turn a count/breakdown table into a bar-chart spec (or null if it isn't one).
function _aiTableToChartSpec(header, rows, title){
  if (!header || header.length < 2 || !rows || rows.length < 2) return null;
  var valCol = -1, valHeader = '';
  for (var c = 1; c < header.length; c++){
    if (/%|percent/i.test(header[c]||'')) continue;
    var nums = 0;
    rows.forEach(function(r){ if (_aiParseNum(r[c]) != null) nums++; });
    if (nums >= Math.ceil(rows.length * 0.6)) { valCol = c; valHeader = header[c]; break; }
  }
  if (valCol === -1) return null;
  var labels = [], data = [];
  rows.forEach(function(r){
    var label = _aiPdfClean(r[0]||'');
    if (!label || /^total\b/i.test(label)) return;
    var v = _aiParseNum(r[valCol]);
    if (v == null) return;
    labels.push(label); data.push(v);
  });
  if (labels.length < 2 || labels.length > 14) return null;
  return { type:'bar', title: _aiPdfClean(title || header[0] || ''), labels: labels, datasets: [{ label: _aiPdfClean(valHeader) || 'Count', data: data }] };
}
function _aiDeriveChartSpecs(md){
  return _aiMarkdownTables(md).map(function(t){ return _aiTableToChartSpec(t.header, t.rows, t.title); }).filter(Boolean);
}

function _aiExportReplyPdf(md){
  if (typeof md !== 'string' || !md.trim()) return;
  var explicit = [];
  var work = md.replace(/```chart\s*([\s\S]*?)```/g, function (_m, json) {
    try { explicit.push(JSON.parse(json.trim())); return '\n@@CHART' + (explicit.length - 1) + '@@\n'; }
    catch (e) { return ''; }
  }).replace(/```[\s\S]*?```/g, '');   // drop other code fences (ASCII bars etc.)
  // If the model didn't emit explicit charts, derive one per count table.
  var tableSpecs = explicit.length ? [] : _aiDeriveChartSpecs(work);
  _aiLoadPdfLibs(function () {
    if (!(window.jspdf && window.jspdf.jsPDF)) { if (typeof showToast==='function') showToast('PDF library failed to load.', { type:'error' }); return; }
    var allSpecs = explicit.concat(tableSpecs);
    var images = new Array(allSpecs.length).fill(null);
    var pending = allSpecs.length;
    function go(){ _aiBuildReplyPdf(work, images.slice(0, explicit.length), images.slice(explicit.length)); }
    if (!pending) { go(); return; }
    allSpecs.forEach(function (spec, i) {
      _aiChartToImage(spec, function (img) { images[i] = img; if (--pending === 0) go(); });
    });
  });
}
function _aiBuildReplyPdf(work, explicitImages, tableImages){
  var jsPDF = window.jspdf.jsPDF;
  var doc = new jsPDF({ orientation:'portrait', unit:'mm', format:'letter' });
  var pageW = doc.internal.pageSize.getWidth(), pageH = doc.internal.pageSize.getHeight();
  var margin = 16, y = 16, contentW = pageW - margin * 2;
  var nation = nationDisplay();
  var tm = work.match(/^#\s+(.+)$/m); var title = tm ? _aiPdfClean(tm[1]) : 'Report';
  var today = new Date().toISOString().slice(0, 10);

  doc.setFont('helvetica','bold'); doc.setFontSize(13); doc.setTextColor(20);
  doc.text(nation + ' Housing', margin, y); y += 7;
  doc.setFontSize(16); doc.text(title, margin, y); y += 6;
  doc.setFont('helvetica','normal'); doc.setFontSize(9); doc.setTextColor(120);
  doc.text('Generated ' + today, margin, y); y += 3;
  doc.setDrawColor(220); doc.line(margin, y, pageW - margin, y); y += 6;
  doc.setTextColor(25);

  function ensure(h){ if (y + h > pageH - 16) { doc.addPage(); y = 16; } }
  var lines = work.split('\n'), i = 0, _tblCount = 0;
  while (i < lines.length){
    var raw = (lines[i] || '').trim();
    if (!raw){ i++; continue; }
    var cm = raw.match(/^@@CHART(\d+)@@$/);
    if (cm){
      var img = explicitImages[parseInt(cm[1], 10)];
      if (img){ var iw = Math.min(contentW, 150), ih = iw * 0.5; ensure(ih + 4); try { doc.addImage(img, 'PNG', margin, y, iw, ih); } catch(e){} y += ih + 5; }
      i++; continue;
    }
    if (raw.charAt(0) === '|'){
      var tbl = [];
      while (i < lines.length && (lines[i]||'').trim().charAt(0) === '|'){
        var cells = (lines[i]||'').trim().replace(/^\||\|$/g, '').split('|').map(function (c){ return _aiPdfClean(c); });
        if (!cells.every(function (c){ return /^:?-{2,}:?$/.test(c) || c === ''; })) tbl.push(cells);
        i++;
      }
      if (tbl.length){
        ensure(12);
        doc.autoTable({ startY:y, head:[tbl[0]], body:tbl.slice(1), theme:'striped',
          styles:{ fontSize:8, cellPadding:2 },
          headStyles:{ fillColor:[17,17,15], textColor: window._themeAccentHex(), fontStyle:'bold', fontSize:8 },
          margin:{ left:margin, right:margin } });
        y = doc.lastAutoTable.finalY + 5;
        // Derived chart for this count table (when the model didn't emit one).
        if (tableImages && tableImages.length && _aiTableToChartSpec(tbl[0], tbl.slice(1), '')) {
          var tci = tableImages[_tblCount++];
          if (tci){ var tw = Math.min(contentW, 140), th = tw * 0.5; ensure(th + 4); try { doc.addImage(tci, 'PNG', margin, y, tw, th); } catch(e){} y += th + 5; }
        }
      }
      continue;
    }
    var h = raw.match(/^(#{1,3})\s+(.+)$/);
    if (h){
      var lvl = h[1].length, sz = lvl === 1 ? 14 : lvl === 2 ? 12 : 10.5;
      ensure(sz * 0.6 + 4); y += lvl === 1 ? 2 : 3;
      doc.setFont('helvetica','bold'); doc.setFontSize(sz); doc.text(_aiPdfClean(h[2]), margin, y);
      y += sz * 0.5; doc.setFont('helvetica','normal'); doc.setFontSize(10);
      i++; continue;
    }
    var isList = /^[-*]\s+/.test(raw) || /^\d+\.\s+/.test(raw);
    var isQuote = raw.charAt(0) === '>';
    var txt = _aiPdfClean(raw.replace(/^[-*>]\s*/, '').replace(/^\d+\.\s*/, ''));
    if (!txt){ i++; continue; }
    doc.setFont('helvetica', isQuote ? 'italic' : 'normal'); doc.setFontSize(10);
    var wrapped = doc.splitTextToSize((isList ? '• ' : '') + txt, contentW);
    ensure(wrapped.length * 5); doc.text(wrapped, margin, y); y += wrapped.length * 5 + 1;
    doc.setFont('helvetica','normal');
    i++;
  }
  var pages = doc.internal.getNumberOfPages();
  for (var p = 1; p <= pages; p++){
    doc.setPage(p); doc.setFontSize(8); doc.setTextColor(150);
    doc.text(nation + ' Housing', margin, pageH - 8);
    doc.text('Page ' + p + ' of ' + pages, pageW - margin, pageH - 8, { align:'right' });
  }
  doc.save(nation.replace(/[^a-zA-Z0-9]+/g, '_') + '_Report_' + today + '.pdf');
}

// ── Keyboard: Enter to send ───────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function() {
  var inp = document.getElementById('ai_chat_input');
  if (inp) {
    inp.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); aiSendMessage(); }
    });
  }
});

// ── Write Letter with AI (Document Library) ──────────────────────────────────
// Invoked by the "Write Letter with AI" button the DocLibrary renders when
// opts.aiLetters is set (tenant & unit libraries). Drafts a professional
// resident letter GROUNDED in the nation's housing policy, lets staff review
// and edit it, then saves it as a branded PDF back into that same library via
// the ctx.saveFile() hook the DocLibrary provides.
var _aiLetterCtx = null;
var _AI_LETTER_PURPOSES = [
  'General correspondence',
  'Payment / arrears reminder',
  'Lease / occupancy matter',
  'Maintenance / repair follow-up',
  'Inspection notice or result',
  'Policy clarification',
  'Notice / warning',
  'Welcome / move-in',
  'Other'
];

function _aiPolicyText() {
  var p = (window._appSettings && window._appSettings.housing_policy) || null;
  if (p && typeof p === 'object') return String(p.text || '');
  if (typeof p === 'string') return p;
  return '';
}

function _aiLetterEnsureModal() {
  if (document.getElementById('ai_letter_modal')) return;
  if (!document.body) return;
  var purposeOpts = _AI_LETTER_PURPOSES.map(function(p){ return '<option>' + p + '</option>'; }).join('');
  var wrap = document.createElement('div');
  wrap.id = 'ai_letter_modal';
  wrap.style.cssText = 'display:none;position:fixed;inset:0;z-index:1300;background:rgba(0,0,0,.55);align-items:flex-start;justify-content:center;overflow-y:auto;padding:24px 14px;';
  wrap.innerHTML =
    '<div style="background:var(--surface);border:1px solid var(--border);border-radius:16px;max-width:720px;width:100%;box-shadow:0 24px 60px rgba(0,0,0,0.5);overflow:hidden;margin:auto;">'
    + '<div style="background:var(--dark);padding:14px 18px;border-bottom:2px solid var(--yellow);display:flex;align-items:center;justify-content:space-between;">'
    +   '<div style="display:flex;align-items:center;gap:8px;"><span style="color:var(--yellow);font-size:16px;">✦</span><span style="font-family:\'DM Serif Display\',serif;font-size:16px;color:#fff;">Write a Letter with AI</span></div>'
    +   '<button type="button" onclick="_aiLetterClose()" style="background:none;border:1px solid #444;color:#ccc;width:28px;height:28px;border-radius:6px;cursor:pointer;">✕</button>'
    + '</div>'
    + '<div style="padding:18px;max-height:calc(100vh - 160px);overflow-y:auto;">'
    +   '<div id="ai_letter_policywarn" style="display:none;background:var(--warn-amber-bg);color:var(--warn-amber-text);border:1px solid var(--warn-amber-border);border-radius:8px;padding:8px 12px;font-size:12px;margin-bottom:12px;"></div>'
    +   '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">'
    +     '<div class="f"><label>Recipient name</label><input type="text" id="ai_letter_recipient" placeholder="Full name"/></div>'
    +     '<div class="f"><label>Re: / Address</label><input type="text" id="ai_letter_address" placeholder="Unit address or subject"/></div>'
    +     '<div class="f"><label>Purpose</label><select id="ai_letter_purpose">' + purposeOpts + '</select></div>'
    +     '<div class="f"><label>Tone</label><select id="ai_letter_tone"><option value="professional">Professional</option><option value="warm">Warm / supportive</option><option value="firm">Firm</option></select></div>'
    +   '</div>'
    +   '<div class="f" style="margin-top:4px;"><label>What should the letter say? (the situation / details)</label>'
    +     '<textarea id="ai_letter_details" rows="4" placeholder="Describe the situation and anything the letter must mention. The AI grounds the letter in the housing policy." style="width:100%;box-sizing:border-box;"></textarea></div>'
    +   '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:4px;">'
    +     '<button type="button" id="ai_letter_gen_btn" class="btn btn-primary btn-sm" onclick="_aiLetterGenerate()"><span style="color:var(--dark);">✦</span> Generate letter</button>'
    +     '<span id="ai_letter_status" style="font-size:12px;color:var(--muted);"></span>'
    +   '</div>'
    +   '<div id="ai_letter_result_wrap" style="display:none;margin-top:16px;border-top:1px solid var(--border);padding-top:14px;">'
    +     '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:6px;">'
    +       '<label style="font-size:12px;font-weight:700;color:var(--text);">Drafted letter &mdash; review &amp; edit</label>'
    +       '<span style="font-size:11px;color:var(--muted);">Grounded in the housing policy</span>'
    +     '</div>'
    +     '<textarea id="ai_letter_result" rows="14" style="width:100%;box-sizing:border-box;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px;line-height:1.5;"></textarea>'
    +     '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px;">'
    +       '<button type="button" class="btn btn-ghost btn-sm" onclick="_aiLetterGenerate()">↻ Regenerate</button>'
    +       '<button type="button" id="ai_letter_save_btn" class="btn btn-primary btn-sm" onclick="_aiLetterSavePdf()">📄 Save as PDF to documents</button>'
    +     '</div>'
    +   '</div>'
    + '</div>'
    + '</div>';
  document.body.appendChild(wrap);
  wrap.addEventListener('click', function(e){ if (e.target === wrap) _aiLetterClose(); });
}

window.aiWriteLetter = function(ctx) {
  if (window.CLFN_MODULES && !CLFN_MODULES.isEnabled('ai_assistant')) {
    if (typeof showToast === 'function') showToast('AI Assistant is disabled for this nation.', {type:'error'});
    return;
  }
  _aiLetterCtx = ctx || {};
  _aiLetterEnsureModal();
  var modal = document.getElementById('ai_letter_modal');
  if (!modal) return;
  // Prefill + reset.
  var rec = document.getElementById('ai_letter_recipient'); if (rec) rec.value = _aiLetterCtx.recipientName || '';
  var adr = document.getElementById('ai_letter_address');   if (adr) adr.value = _aiLetterCtx.address || '';
  var det = document.getElementById('ai_letter_details');   if (det) det.value = '';
  var res = document.getElementById('ai_letter_result');    if (res) res.value = '';
  var rw  = document.getElementById('ai_letter_result_wrap');if (rw) rw.style.display = 'none';
  var st  = document.getElementById('ai_letter_status');    if (st) st.textContent = '';
  var warn = document.getElementById('ai_letter_policywarn');
  if (warn) {
    if (!_aiPolicyText().trim()) {
      warn.textContent = 'No housing policy text is set yet, so the letter will not cite specific policy. Add it in Settings → Housing policy.';
      warn.style.display = '';
    } else { warn.style.display = 'none'; }
  }
  modal.style.display = 'flex';
};

window._aiLetterClose = function() {
  var m = document.getElementById('ai_letter_modal');
  if (m) m.style.display = 'none';
};

window._aiLetterGenerate = function() {
  var recipient = (document.getElementById('ai_letter_recipient') || {}).value || '';
  var address   = (document.getElementById('ai_letter_address')   || {}).value || '';
  var purpose   = (document.getElementById('ai_letter_purpose')   || {}).value || 'General correspondence';
  var tone      = (document.getElementById('ai_letter_tone')      || {}).value || 'professional';
  var details   = (document.getElementById('ai_letter_details')   || {}).value || '';
  if (!recipient.trim() && !details.trim()) {
    if (typeof showToast === 'function') showToast('Add a recipient and/or describe what the letter should say.', {type:'error'});
    return;
  }
  var btn = document.getElementById('ai_letter_gen_btn');
  var st  = document.getElementById('ai_letter_status');
  if (btn) btn.disabled = true;
  if (st) st.textContent = 'Drafting…';
  _aiCall({
    type: 'letter',
    message: 'Write the letter.',
    context: {
      nation:     (window.NATION_CONFIG && (NATION_CONFIG.display_name || NATION_CONFIG.short)) || 'the First Nation',
      recipient:  recipient.trim() || 'the resident',
      address:    address.trim(),
      purpose:    purpose,
      tone:       tone,
      details:    details.trim(),
      sender:     ((window.NATION_CONFIG && (NATION_CONFIG.display_name || NATION_CONFIG.short)) || '') + ' Housing Department',
      policyText: _aiPolicyText(),
      role:       window._effectiveRole || window.currentRole || ''
    },
    history: []
  }).then(function(data){
    if (data.error) throw new Error(data.error);
    var res = document.getElementById('ai_letter_result');
    if (res) res.value = data.reply || '';
    var rw = document.getElementById('ai_letter_result_wrap');
    if (rw) rw.style.display = '';
    if (res) res.focus();
  }).catch(function(err){
    if (typeof showToast === 'function') showToast('Letter draft failed: ' + err.message, {type:'error'});
  }).finally(function(){
    if (btn) btn.disabled = false;
    if (st) st.textContent = '';
  });
};

// Build a branded letter PDF (nation letterhead + date + body) and return a Blob.
async function _aiLetterPdfBlob(letterText) {
  var jsPDF = await window.loadJsPdf();
  var doc = new jsPDF({ unit: 'pt', format: 'letter' });
  var pageW = doc.internal.pageSize.getWidth();
  var pageH = doc.internal.pageSize.getHeight();
  var margin = 56;
  var nation = (window.NATION_CONFIG && (NATION_CONFIG.display_name || NATION_CONFIG.short)) || 'Housing';
  var y = margin;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(16);
  doc.text(String(nation), margin, y);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
  y += 15; doc.text('Housing Department', margin, y);
  y += 12; doc.setDrawColor(190); doc.setLineWidth(0.8); doc.line(margin, y, pageW - margin, y);
  y += 20;
  var today = new Date().toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric' });
  doc.setFontSize(10); doc.text(today, pageW - margin, y, { align: 'right' });
  y += 22;
  doc.setFontSize(11);
  var lineH = 15;
  var lines = doc.splitTextToSize(String(letterText || '').replace(/\r\n/g, '\n'), pageW - margin * 2);
  for (var i = 0; i < lines.length; i++) {
    if (y > pageH - margin) { doc.addPage(); y = margin; }
    doc.text(lines[i], margin, y);
    y += lineH;
  }
  return doc.output('blob');
}

window._aiLetterSavePdf = function() {
  var res = document.getElementById('ai_letter_result');
  var text = res ? (res.value || '').trim() : '';
  if (!text) { if (typeof showToast === 'function') showToast('Nothing to save yet.', {type:'error'}); return; }
  if (!_aiLetterCtx || typeof _aiLetterCtx.saveFile !== 'function') {
    if (typeof showToast === 'function') showToast('Cannot file the letter here.', {type:'error'}); return;
  }
  var btn = document.getElementById('ai_letter_save_btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  var purpose = ((document.getElementById('ai_letter_purpose') || {}).value || 'Letter')
    .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'Letter';
  var fname = 'Letter-' + purpose + '-' + new Date().toISOString().slice(0, 10) + '.pdf';
  _aiLetterPdfBlob(text).then(function(blob){
    _aiLetterCtx.saveFile(blob, fname, 'other');
    if (typeof showToast === 'function') showToast('Letter saved to documents.', {type:'info'});
    _aiLetterClose();
  }).catch(function(err){
    if (typeof showToast === 'function') showToast('Could not create the PDF: ' + (err && err.message ? err.message : err), {type:'error'});
  }).finally(function(){
    if (btn) { btn.disabled = false; btn.innerHTML = '📄 Save as PDF to documents'; }
  });
};
