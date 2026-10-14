/* reseller.js — Platform Admin "Resellers" tab.
 *
 * Runs the SaaS Reseller Commission Agreement end to end:
 *   - Owner: the software owner's details (one record, platform_owner). Also
 *     names the Provider on the nation subscription agreement (admin.js).
 *   - Resellers: registry of individuals / companies.
 *   - Agreements: every bracketed term of the contract, signatures, activation
 *     (freezes both parties' details), the completed contract PDF, and term /
 *     termination / non-solicit tracking (ss.1, 6, 7, 9, 10, 13, 14, 16, 17).
 *   - Customers: lead submission + registration (s.7.4, first-to-submit).
 *   - Statements: monthly Net Revenue + Commission (ss.7-9, Schedule A), built
 *     from amounts actually COLLECTED on nation_invoices, with clawback/offset,
 *     issue, payment and a statement PDF.
 *
 * Schema: supabase/platform/reseller.sql (run on the platform project).
 * Uses the helper kit admin.js exposes as window._adminKit. All buttons go
 * through data-act (the panel CSP blocks inline handlers).
 */
(function () {
  'use strict';

  function K(){ return window._adminKit; }
  function esc(s){ return K().esc(s); }
  function money(n){ return K().money(n); }
  function r2(n){ return Math.round((Number(n) || 0) * 100) / 100; }
  function today(){ return new Date().toISOString().slice(0, 10); }

  var S = { loaded: false, missing: false, owner: null, resellers: [], agreements: [], customers: [], statements: [],
            view: 'home', id: '', stmt: null };

  // ---- Date helpers (YYYY-MM-DD strings, UTC) ---------------------------------
  function dObj(s){ return new Date(s + 'T00:00:00Z'); }
  function dStr(d){ return d.toISOString().slice(0, 10); }
  function addDays(s, n){ var d = dObj(s); d.setUTCDate(d.getUTCDate() + n); return dStr(d); }
  function addMonths(s, n){
    var d = dObj(s), day = d.getUTCDate();
    d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n);
    var last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last)); return dStr(d);
  }
  function monthStart(s){ return s.slice(0, 7) + '-01'; }
  function monthEnd(s){ return addDays(addMonths(monthStart(s), 1), -1); }
  var MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  function fmtLong(s){ if (!s) return ''; var d = dObj(s); return MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate() + ', ' + d.getUTCFullYear(); }
  function fmtMonth(s){ var d = dObj(s); return MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear(); }
  function periodWords(months){
    months = Number(months) || 0;
    if (months % 12 === 0){ var y = months / 12; return y === 1 ? '1 year' : y + ' years'; }
    return months === 1 ? '1 month' : months + ' months';
  }

  // ---- Styles (scoped, injected once) ----------------------------------------
  function ensureStyle(){
    if (document.getElementById('rs-style')) return;
    var s = document.createElement('style'); s.id = 'rs-style';
    s.textContent =
      '.rs-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 14px}'
    + '.rs-grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:0 14px}'
    + '.rs-grid .full,.rs-grid3 .full{grid-column:1/-1}'
    + '@media(max-width:640px){.rs-grid,.rs-grid3{grid-template-columns:1fr}}'
    + '#rs-root textarea{width:100%;padding:10px 12px;border:1px solid var(--hair);border-radius:9px;font-size:15px;font-family:inherit;min-height:64px;background:var(--surface);color:var(--ink)}'
    + '#rs-root input:disabled,#rs-root select:disabled,#rs-root textarea:disabled{background:var(--bg);color:var(--muted)}'
    + '#rs-root .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:14px}'
    + '@media(max-width:640px){#rs-root .kpis{grid-template-columns:repeat(2,1fr)}}'
    + '#rs-root .kpi{border:1px solid var(--line);border-radius:9px;padding:10px 12px;background:var(--bg)}'
    + '#rs-root .kpi .l{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:var(--muted)}'
    + '#rs-root .kpi .v{font-size:17px;font-weight:800;margin-top:2px}'
    + '#rs-root .chk{display:flex;align-items:center;gap:8px;font-weight:600;font-size:13px;margin:14px 0 0}'
    + '#rs-root .chk input{width:auto}'
    + '#rs-root .tbl-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}'
    + '#rs-root .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}'
    + '#rs-root .st-in{width:84px;padding:6px 6px;font-size:14px;text-align:right}'
    + '#rs-stmt td:first-child{min-width:150px}#rs-stmt td{padding:6px 4px}'
    + '#rs-root .note{font-size:12px;color:var(--muted);line-height:1.5;margin:6px 0 0}'
    + '#rs-root .warn{background:#fffbeb;border:1px solid #fde68a;color:#7a5c00;border-radius:9px;padding:10px 12px;font-size:12px;margin-top:10px;line-height:1.5}'
    + '#rs-root .crumb{background:none;border:none;color:#1d4ed8;font-weight:700;font-size:13px;padding:0;cursor:pointer;font-family:inherit;margin-top:14px}'
    + '#rs-root .btns{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px;align-items:center}'
    + '#rs-root .btns .btn{margin-top:0}'
    + '.pill.draft,.pill.submitted,.pill.none{background:#f4f4f0;color:#696960}'
    + '.pill.signed,.pill.issued,.pill.terminating{background:#fffbeb;color:#7a5c00;border:1px solid #fde68a}'
    + '.pill.registered,.pill.paid{background:#dcfce7;color:#166534}'
    + '.pill.terminated,.pill.declined,.pill.inactive,.pill.overdue{background:#fee2e2;color:#991b1b}';
    document.head.appendChild(s);
  }

  // ---- Form helpers ----------------------------------------------------------
  function v(id){ var e = document.getElementById(id); return e ? String(e.value || '').trim() : ''; }
  function n(id){ return Number(v(id)) || 0; }
  function c(id){ var e = document.getElementById(id); return !!(e && e.checked); }
  function attrDis(dis){ return dis ? ' disabled' : ''; }
  function fld(label, id, val, o){
    o = o || {};
    return '<div' + (o.full ? ' class="full"' : '') + '><label for="' + id + '">' + label + '</label>'
      + (o.area
          ? '<textarea id="' + id + '"' + attrDis(o.dis) + (o.ph ? ' placeholder="' + esc(o.ph) + '"' : '') + '>' + esc(val == null ? '' : val) + '</textarea>'
          : '<input id="' + id + '" type="' + (o.type || 'text') + '" value="' + esc(val == null ? '' : val) + '"' + attrDis(o.dis)
            + (o.step ? ' step="' + o.step + '"' : '') + (o.min != null ? ' min="' + o.min + '"' : '') + (o.ph ? ' placeholder="' + esc(o.ph) + '"' : '') + '/>')
      + (o.hint ? '<div class="note" style="font-size:11px;margin-top:3px;">' + o.hint + '</div>' : '')
      + '</div>';
  }
  function sel(label, id, val, opts, o){
    o = o || {};
    return '<div' + (o.full ? ' class="full"' : '') + '><label for="' + id + '">' + label + '</label><select id="' + id + '"' + attrDis(o.dis) + '>'
      + opts.map(function(p){ return '<option value="' + esc(p[0]) + '"' + (String(p[0]) === String(val == null ? '' : val) ? ' selected' : '') + '>' + esc(p[1]) + '</option>'; }).join('')
      + '</select>' + (o.hint ? '<div class="note" style="font-size:11px;margin-top:3px;">' + o.hint + '</div>' : '') + '</div>';
  }
  function btn(label, act, attrs, cls){ return '<button class="btn sm' + (cls ? ' ' + cls : '') + '" type="button" data-act="' + act + '"' + (attrs || '') + '>' + label + '</button>'; }
  function pill(st, label){ return '<span class="pill ' + esc(st) + '">' + esc(label || st) + '</span>'; }
  function msgBox(id){ return '<div class="msg" id="' + id + '"></div>'; }
  function entityLabel(t){ var L = K().ENTITY_TYPES; for (var i = 0; i < L.length; i++){ if (L[i][0] === t) return L[i][1]; } return t || ''; }

  // Shared party form (Owner + Reseller): identity + address + contact.
  function partyFields(pre, p, dis){
    p = p || {};
    var prov = [['', '—']].concat(K().PROVINCES);
    return '<div class="rs-grid">'
      + fld('Legal name', pre + 'legal_name', p.legal_name, { dis: dis, ph: 'Full legal name of the person or entity' })
      + sel('Entity type', pre + 'entity_type', p.entity_type || 'individual', K().ENTITY_TYPES, { dis: dis })
      + fld('Operating as (business / trade name)', pre + 'operating_as', p.operating_as, { dis: dis, ph: 'Optional' })
      + fld('Jurisdiction (if incorporated / registered)', pre + 'jurisdiction', p.jurisdiction, { dis: dis, ph: 'e.g. Ontario, or Canada (CBCA)' })
      + fld('Street address', pre + 'street', p.street, { dis: dis, full: true })
      + fld('City / town', pre + 'city', p.city, { dis: dis })
      + sel('Province / territory', pre + 'province', p.province || '', prov, { dis: dis })
      + fld('Postal code', pre + 'postal_code', p.postal_code, { dis: dis })
      + fld('Country', pre + 'country', p.country || 'Canada', { dis: dis })
      + fld('Email', pre + 'email', p.email, { dis: dis, type: 'email' })
      + fld('Phone', pre + 'phone', p.phone, { dis: dis, type: 'tel' })
      + '</div>';
  }
  function readParty(pre){
    var o = {};
    ['legal_name','entity_type','operating_as','jurisdiction','street','city','province','postal_code','country','email','phone']
      .forEach(function(k){ o[k] = v(pre + k) || null; });
    return o;
  }

  // ---- Data -----------------------------------------------------------------
  async function getJson(path){
    var r = await K().api('GET', path);
    if (!r.ok){ var t = await r.text(); var e = new Error(t); e.status = r.status; throw e; }
    return r.json();
  }
  async function load(){
    try {
      var res = await Promise.all([
        getJson('/platform_owner?id=eq.1&select=*'),
        getJson('/resellers?select=*&order=legal_name'),
        getJson('/reseller_agreements?select=*&order=created_at'),
        getJson('/reseller_customers?select=*&order=submitted_date'),
        getJson('/reseller_statements?select=*&order=period_month')
      ]);
      S.owner = res[0][0] || null; S.resellers = res[1]; S.agreements = res[2]; S.customers = res[3]; S.statements = res[4];
      S.loaded = true; S.missing = false;
    } catch (e){
      S.loaded = false;
      S.missing = /platform_owner|reseller|relation|schema cache|does not exist/i.test(String(e && e.message || e)) || e.status === 404;
      S.loadErr = String(e && e.message || e).slice(0, 240);
    }
  }
  function reseller(id){ return S.resellers.filter(function(x){ return x.id === id; })[0] || null; }
  function agreement(id){ return S.agreements.filter(function(x){ return x.id === id; })[0] || null; }
  function agrCustomers(aid){ return S.customers.filter(function(x){ return x.agreement_id === aid; }); }
  function agrStatements(aid){ return S.statements.filter(function(x){ return x.agreement_id === aid; }); }
  function nationBySub(sub){ return (K().nations() || []).filter(function(x){ return x.subdomain === sub; })[0] || null; }

  // ---- Agreement status + term math (s.10) -----------------------------------
  function agrState(a){
    if (a.status === 'draft') return 'draft';
    if (a.terminated_date) return a.terminated_date <= today() ? 'terminated' : 'terminating';
    if (a.effective_date && a.effective_date > today()) return 'signed';
    return 'active';
  }
  var STATE_LABEL = { draft: 'Draft', signed: 'Signed - starts later', active: 'Active', terminating: 'Ending', terminated: 'Ended' };
  // Current term as of `asOf` (initial term, then successive renewals).
  function termInfo(a, asOf){
    if (!a.effective_date) return null;
    var start = a.effective_date, end = addDays(addMonths(start, a.initial_term_months || 12), -1), no = 1;
    while (end < asOf && no < 200){ start = addDays(end, 1); end = addDays(addMonths(start, a.renewal_term_months || 12), -1); no++; }
    return { no: no, start: start, end: end, nonrenewalBy: addDays(end, -(a.nonrenewal_notice_days || 0)) };
  }
  // Last day Commission can accrue: the termination effective date, if any.
  function commissionEnd(a){ return a.terminated_date || null; }

  // Months a statement is owed for: effective month .. last completed month
  // (capped at the termination month).
  function statementMonths(a){
    if (a.status === 'draft' || !a.effective_date) return [];
    var out = [], m = monthStart(a.effective_date), lastDone = monthStart(addDays(monthStart(today()), -1));
    var cap = a.terminated_date ? monthStart(a.terminated_date) : null;
    while (m <= lastDone && (!cap || m <= cap) && out.length < 240){ out.push(m); m = addMonths(m, 1); }
    return out;
  }
  function stmtDueDate(a, m){ return addDays(monthEnd(m), a.payment_days || 30); }

  // ---- Render root -----------------------------------------------------------
  window.renderResellers = async function(force){
    var root = document.getElementById('rs-root'); if (!root) return;
    ensureStyle();
    if (!S.loaded || force){ root.innerHTML = '<p class="sub" style="margin-top:14px;">Loading…</p>'; await load(); }
    if (!S.loaded){
      root.innerHTML = '<div class="card"><h3>Resellers</h3>'
        + (S.missing
            ? '<p class="sub">The reseller tables are not on the platform project yet. Run <code>supabase/platform/reseller.sql</code> in the platform SQL Editor, then reload.</p>'
            : '<p class="sub">Could not load reseller data: ' + esc(S.loadErr || '') + '</p>')
        + btn('Retry', 'rs-refresh') + '</div>';
      return;
    }
    if (S.view === 'reseller') root.innerHTML = resellerView(S.id);
    else if (S.view === 'agreement') { root.innerHTML = agreementView(S.id); if (S.stmt) drawStatement(); }
    else root.innerHTML = homeView();
  };
  function go(view, id){ S.view = view; S.id = id || ''; S.stmt = null; window.renderResellers(); try { window.scrollTo(0, 0); } catch(e){} }

  // ---- Home: KPIs + Owner + reseller list ------------------------------------
  function homeView(){
    var activeAgr = S.agreements.filter(function(a){ var s = agrState(a); return s === 'active' || s === 'terminating'; });
    var regCust = S.customers.filter(function(x){ return x.status === 'registered'; });
    var owing = 0; S.statements.forEach(function(s){ if (s.status === 'issued' && Number(s.amount_due) > 0) owing += Number(s.amount_due); });
    var overdue = 0;
    S.agreements.forEach(function(a){
      statementMonths(a).forEach(function(m){
        var st = agrStatements(a.id).filter(function(s){ return s.period_month === m; })[0];
        if ((!st || st.status !== 'paid') && stmtDueDate(a, m) < today()) overdue++;
      });
    });
    var kpi = function(l, val){ return '<div class="kpi"><div class="l">' + l + '</div><div class="v">' + val + '</div></div>'; };

    var rows = S.resellers.length ? S.resellers.map(function(r){
      var ags = S.agreements.filter(function(a){ return a.reseller_id === r.id; });
      var cur = ags.slice().reverse()[0];
      var custs = S.customers.filter(function(x){ return x.status === 'registered' && ags.some(function(a){ return a.id === x.agreement_id; }); }).length;
      var due = 0; S.statements.forEach(function(s){ if (s.status === 'issued' && ags.some(function(a){ return a.id === s.agreement_id; })) due += Number(s.amount_due) || 0; });
      return '<tr><td><b>' + esc(r.legal_name) + '</b><div style="font-size:11px;color:var(--muted);">' + esc(entityLabel(r.entity_type)) + (r.operating_as ? ' &middot; ' + esc(r.operating_as) : '') + '</div></td>'
        + '<td>' + (cur ? pill(agrState(cur), STATE_LABEL[agrState(cur)]) + '<div style="font-size:11px;color:var(--muted);margin-top:3px;">' + esc(cur.agreement_number) + '</div>' : '<span class="empty">none</span>') + '</td>'
        + '<td class="num">' + custs + '</td><td class="num">' + money(due) + '</td>'
        + '<td>' + btn('Open', 'rs-open-reseller', ' data-id="' + esc(r.id) + '"', 'ghost') + '</td></tr>';
    }).join('') : '<tr><td colspan="5" class="empty">No resellers yet.</td></tr>';

    var o = S.owner || {};
    return '<div class="kpis">'
      + kpi('Active agreements', activeAgr.length) + kpi('Registered customers', regCust.length)
      + kpi('Commission owing', money(owing)) + kpi('Statements overdue', overdue ? '<span style="color:var(--danger);">' + overdue + '</span>' : '0')
      + '</div>'
      + '<div class="card"><h3>Owner <span>' + btn('↻ Refresh', 'rs-refresh', '', 'ghost') + '</span></h3>'
      +   '<p class="sub" style="margin:0;">The party that owns the software: the <b>Owner</b> in every reseller agreement and the <b>Provider</b> on the nation subscription agreement. If ownership moves to a business entity, update it here. New contracts use the new details; activated reseller agreements keep the details they were signed with.</p>'
      +   partyFields('rs-o-', o, false)
      +   '<div class="rs-grid">'
      +     fld('Product / brand name', 'rs-o-product_name', o.product_name, { ph: 'e.g. FN Hub' })
      +     fld('Business / corporation number', 'rs-o-business_number', o.business_number, { ph: 'Optional' })
      +     fld('Authorized signatory', 'rs-o-signatory_name', o.signatory_name)
      +     fld('Signatory title', 'rs-o-signatory_title', o.signatory_title, { ph: 'e.g. Owner, President' })
      +     fld('GST/HST number', 'rs-o-gst_hst_number', o.gst_hst_number, { ph: 'Optional' })
      +     fld('Notes', 'rs-o-notes', o.notes, { area: true, full: true })
      +   '</div>'
      +   (o.updated_at ? '<p class="note">Last updated ' + esc(String(o.updated_at).slice(0, 10)) + (o.updated_by ? ' by ' + esc(o.updated_by) : '') + '.</p>' : '')
      +   '<div class="btns">' + btn('Save owner', 'rs-owner-save') + msgBox('rs-o-msg') + '</div>'
      + '</div>'
      + '<div class="card"><h3>Resellers ' + btn('+ Add reseller', 'rs-open-reseller', ' data-id="new"') + '</h3>'
      +   '<div class="tbl-wrap"><table><thead><tr><th>Reseller</th><th>Agreement</th><th class="num">Customers</th><th class="num">Owing</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>'
      + '</div>';
  }

  window.rsSaveOwner = async function(){
    var b = readParty('rs-o-');
    if (!b.legal_name){ K().setMsg('rs-o-msg', 'Legal name is required.'); return; }
    ['product_name','business_number','signatory_name','signatory_title','gst_hst_number','notes'].forEach(function(k){ b[k] = v('rs-o-' + k) || null; });
    b.id = 1; b.updated_by = K().jwtEmail(); b.updated_at = new Date().toISOString();
    var r = await K().api('POST', '/platform_owner', b, 'resolution=merge-duplicates,return=representation');
    if (!r.ok){ K().setMsg('rs-o-msg', 'Could not save: ' + (await r.text()).slice(0, 200)); return; }
    var rows = await r.json(); S.owner = rows[0] || b;
    await K().audit('owner_saved', 'platform_owner', b.legal_name + ' (' + entityLabel(b.entity_type) + ')');
    K().setMsg('rs-o-msg', 'Owner saved.', 'ok');
  };

  // ---- Reseller view ---------------------------------------------------------
  function resellerView(id){
    var r = id === 'new' ? { entity_type: 'individual', country: 'Canada', hst_rate: 13, status: 'active' } : reseller(id);
    if (!r) return '<button class="crumb" type="button" data-act="rs-home">&larr; All resellers</button><p class="sub">Reseller not found.</p>';
    var ags = id === 'new' ? [] : S.agreements.filter(function(a){ return a.reseller_id === id; });
    var agRows = ags.length ? ags.map(function(a){
      var st = agrState(a);
      return '<tr><td><b>' + esc(a.agreement_number) + '</b></td><td>' + pill(st, STATE_LABEL[st]) + '</td>'
        + '<td>' + esc(a.effective_date ? fmtLong(a.effective_date) : '—') + '</td><td class="num">' + Number(a.commission_rate) + '%</td>'
        + '<td>' + btn('Open', 'rs-open-agreement', ' data-id="' + esc(a.id) + '"', 'ghost') + '</td></tr>';
    }).join('') : '<tr><td colspan="5" class="empty">No agreements yet.</td></tr>';
    return '<button class="crumb" type="button" data-act="rs-home">&larr; All resellers</button>'
      + '<div class="card"><h3>' + (id === 'new' ? 'New reseller' : esc(r.legal_name)) + '</h3>'
      +   partyFields('rs-r-', r, false)
      +   '<div class="rs-grid">'
      +     fld('Contact / signatory name', 'rs-r-contact_name', r.contact_name)
      +     fld('Contact title', 'rs-r-contact_title', r.contact_title, { ph: 'e.g. Owner, President' })
      +     sel('Status', 'rs-r-status', r.status || 'active', [['active', 'Active'], ['inactive', 'Inactive']])
      +     fld('HST rate on commission (%)', 'rs-r-hst_rate', r.hst_rate == null ? 13 : r.hst_rate, { type: 'number', step: '0.01', min: 0 })
      +   '</div>'
      +   '<label class="chk"><input type="checkbox" id="rs-r-gst_hst_registered"' + (r.gst_hst_registered ? ' checked' : '') + '/> Registered for GST/HST (adds HST to the commission they invoice, s.9.4)</label>'
      +   '<div class="rs-grid">'
      +     fld('GST/HST number', 'rs-r-gst_hst_number', r.gst_hst_number)
      +     fld('Commission payment details', 'rs-r-payment_details', r.payment_details, { ph: 'e.g. Interac e-Transfer to name@example.com' })
      +     fld('Notes', 'rs-r-notes', r.notes, { area: true, full: true })
      +   '</div>'
      +   '<div class="btns">' + btn(id === 'new' ? 'Create reseller' : 'Save reseller', 'rs-reseller-save', ' data-id="' + esc(id) + '"')
      +     (id !== 'new' && !ags.length ? btn('Delete', 'rs-reseller-del', ' data-id="' + esc(id) + '"', 'danger') : '')
      +     msgBox('rs-r-msg') + '</div>'
      + '</div>'
      + (id === 'new' ? '' :
        '<div class="card"><h3>Agreements ' + btn('+ New agreement', 'rs-agr-new', ' data-id="' + esc(id) + '"') + '</h3>'
        + '<div class="tbl-wrap"><table><thead><tr><th>Number</th><th>Status</th><th>Effective</th><th class="num">Rate</th><th></th></tr></thead><tbody>' + agRows + '</tbody></table></div>'
        + '<p class="note">A new agreement starts as a draft with the contract\'s default terms. Fill in the terms and signatures, generate the contract, then activate it once both parties have signed.</p></div>');
  }

  window.rsSaveReseller = async function(id){
    var b = readParty('rs-r-');
    if (!b.legal_name){ K().setMsg('rs-r-msg', 'Legal name is required.'); return; }
    ['contact_name','contact_title','status','gst_hst_number','payment_details','notes'].forEach(function(k){ b[k] = v('rs-r-' + k) || null; });
    b.status = b.status || 'active';
    b.gst_hst_registered = c('rs-r-gst_hst_registered');
    b.hst_rate = n('rs-r-hst_rate');
    b.updated_at = new Date().toISOString();
    var r;
    if (id === 'new'){ b.created_by = K().jwtEmail(); r = await K().api('POST', '/resellers', b, 'return=representation'); }
    else r = await K().api('PATCH', '/resellers?id=eq.' + encodeURIComponent(id), b, 'return=representation');
    if (!r.ok){ K().setMsg('rs-r-msg', 'Could not save: ' + (await r.text()).slice(0, 200)); return; }
    var row = (await r.json())[0];
    if (id === 'new') S.resellers.push(row); else S.resellers = S.resellers.map(function(x){ return x.id === id ? row : x; });
    await K().audit(id === 'new' ? 'reseller_created' : 'reseller_saved', row.id, row.legal_name);
    if (id === 'new') go('reseller', row.id); else K().setMsg('rs-r-msg', 'Reseller saved.', 'ok');
  };
  window.rsDeleteReseller = async function(id){
    var r = reseller(id); if (!r) return;
    if (!await K().dlgConfirm('Delete reseller "' + r.legal_name + '"? This cannot be undone.', { title: 'Delete reseller', okText: 'Delete' })) return;
    var res = await K().api('DELETE', '/resellers?id=eq.' + encodeURIComponent(id), null, 'return=minimal');
    if (!res.ok){ K().setMsg('rs-r-msg', 'Could not delete: ' + (await res.text()).slice(0, 200)); return; }
    S.resellers = S.resellers.filter(function(x){ return x.id !== id; });
    await K().audit('reseller_deleted', id, r.legal_name);
    go('home');
  };

  // ---- Agreements ------------------------------------------------------------
  function nextAgreementNumber(){
    var y = new Date().getFullYear(), max = 0, re = new RegExp('^RSA-' + y + '-(\\d+)$');
    S.agreements.forEach(function(a){ var m = re.exec(a.agreement_number || ''); if (m) max = Math.max(max, Number(m[1])); });
    return 'RSA-' + y + '-' + String(max + 1).padStart(2, '0');
  }
  window.rsNewAgreement = async function(rid){
    var r = reseller(rid); if (!r) return;
    var open = S.agreements.filter(function(a){ return a.reseller_id === rid && ['draft', 'active', 'signed', 'terminating'].indexOf(agrState(a)) !== -1; });
    if (open.length && !await K().dlgConfirm('This reseller already has an open agreement (' + open[0].agreement_number + '). Create another one?', { title: 'New agreement', okText: 'Create' })) return;
    var o = S.owner || {};
    // The contract's default values (its bracketed [defaults]); editable while draft.
    var b = { reseller_id: rid, agreement_number: nextAgreementNumber(), status: 'draft', effective_date: today(),
      commission_rate: 33, initial_term_months: 12, renewal_term_months: 12, nonrenewal_notice_days: 60, termination_notice_days: 60,
      cure_days: 30, payment_days: 30, nonsolicit_months: 12, confidentiality_years: 3, liability_months: 12,
      governing_law: 'Ontario', discount_authority: 'never',
      owner_sign_name: o.signatory_name || o.legal_name || null, owner_sign_title: o.signatory_title || null,
      reseller_sign_name: r.contact_name || (r.entity_type === 'individual' ? r.legal_name : null), reseller_sign_title: r.contact_title || null,
      created_by: K().jwtEmail() };
    var res = await K().api('POST', '/reseller_agreements', b, 'return=representation');
    if (!res.ok){ K().setMsg('rs-r-msg', 'Could not create: ' + (await res.text()).slice(0, 200)); return; }
    var row = (await res.json())[0]; S.agreements.push(row);
    await K().audit('reseller_agreement_created', row.agreement_number, r.legal_name);
    go('agreement', row.id);
  };

  // "Information still needed" from the draft contract, as a live checklist.
  function missingItems(a){
    var o = a.owner_snapshot || S.owner || {}, r = a.reseller_snapshot || reseller(a.reseller_id) || {}, m = [];
    if (!o.legal_name) m.push('Owner legal name (Owner card)');
    if (!o.street || !o.city) m.push('Owner address (Owner card)');
    if (!o.product_name) m.push('Owner product / brand name (Owner card)');
    if (!r.legal_name) m.push('Reseller legal name');
    if (!r.street || !r.city) m.push('Reseller address');
    if (!a.effective_date) m.push('Effective date');
    if (!a.pricing_note) m.push('Pricing summary (s.6, "what a customer nation pays")');
    if (!a.owner_sign_name || !a.owner_sign_title) m.push('Owner signatory name + title');
    if (!a.reseller_sign_name) m.push('Reseller signatory name');
    return m;
  }

  function agreementView(id){
    var a = agreement(id);
    if (!a) return '<button class="crumb" type="button" data-act="rs-home">&larr; All resellers</button><p class="sub">Agreement not found.</p>';
    var r = reseller(a.reseller_id) || {};
    var st = agrState(a), draft = a.status === 'draft';
    var miss = missingItems(a);
    var provs = K().PROVINCES.map(function(p){ return [p[1], p[1]]; });

    var terms = '<div class="card"><h3>Agreement terms ' + pill(st, STATE_LABEL[st]) + '</h3>'
      + '<p class="sub" style="margin:0;">Every bracketed value in the contract. ' + (draft ? 'Editable while the agreement is a draft.' : 'Locked: the agreement is active. Changes need a written amendment (s.17.5).') + '</p>'
      + '<div class="rs-grid3">'
      +   fld('Effective date (s.1)', 'rs-a-effective_date', a.effective_date, { type: 'date', dis: !draft })
      +   fld('Commission rate % (s.7.1)', 'rs-a-commission_rate', a.commission_rate, { type: 'number', step: '0.01', min: 0, dis: !draft })
      +   fld('Payment days after month-end (s.9.1)', 'rs-a-payment_days', a.payment_days, { type: 'number', min: 0, dis: !draft })
      +   fld('Initial term, months (s.10.1)', 'rs-a-initial_term_months', a.initial_term_months, { type: 'number', min: 1, dis: !draft })
      +   fld('Renewal term, months (s.10.1)', 'rs-a-renewal_term_months', a.renewal_term_months, { type: 'number', min: 1, dis: !draft })
      +   fld('Non-renewal notice, days (s.10.1)', 'rs-a-nonrenewal_notice_days', a.nonrenewal_notice_days, { type: 'number', min: 0, dis: !draft })
      +   fld('Termination notice, days (s.10.2)', 'rs-a-termination_notice_days', a.termination_notice_days, { type: 'number', min: 0, dis: !draft })
      +   fld('Cure period, days (s.10.3)', 'rs-a-cure_days', a.cure_days, { type: 'number', min: 0, dis: !draft })
      +   fld('Non-solicit tail, months (s.14)', 'rs-a-nonsolicit_months', a.nonsolicit_months, { type: 'number', min: 0, dis: !draft })
      +   fld('Confidentiality, years (s.13.5)', 'rs-a-confidentiality_years', a.confidentiality_years, { type: 'number', min: 0, dis: !draft })
      +   fld('Liability cap, months of commission (s.16.4)', 'rs-a-liability_months', a.liability_months, { type: 'number', min: 0, dis: !draft })
      +   sel('Governing law (s.17.1)', 'rs-a-governing_law', a.governing_law || 'Ontario', provs, { dis: !draft })
      +   sel('Discount authority (s.6.3)', 'rs-a-discount_authority', a.discount_authority || 'never',
            [['never', 'Never - no discounts or non-standard terms'], ['with_approval', 'Only with the Owner\'s prior written approval']], { dis: !draft, full: true })
      +   fld('Pricing summary (s.6.1)', 'rs-a-pricing_note', a.pricing_note, { area: true, full: true, dis: !draft,
            ph: 'e.g. Per the Owner\'s published fee schedule: Small $5,400/yr, Mid-size $9,540/yr, Large $15,000/yr (or monthly at +10%); one-time setup by size.' })
      + '</div>'
      + (draft ? '<div class="btns">' + btn('Save terms', 'rs-agr-save', ' data-id="' + esc(id) + '"') + msgBox('rs-a-msg') + '</div>' : '')
      + '</div>';

    var sig = '<div class="card"><h3>Signatures &amp; completion</h3>'
      + (miss.length && draft ? '<div class="warn"><b>Still needed before signing:</b><br>' + miss.map(esc).join('<br>') + '</div>' : '')
      + '<div class="rs-grid3">'
      +   fld('Owner signatory', 'rs-a-owner_sign_name', a.owner_sign_name, { dis: !draft })
      +   fld('Owner title', 'rs-a-owner_sign_title', a.owner_sign_title, { dis: !draft })
      +   fld('Owner signed', 'rs-a-owner_signed_date', a.owner_signed_date, { type: 'date', dis: !draft })
      +   fld('Reseller signatory', 'rs-a-reseller_sign_name', a.reseller_sign_name, { dis: !draft })
      +   fld('Reseller title', 'rs-a-reseller_sign_title', a.reseller_sign_title, { dis: !draft })
      +   fld('Reseller signed', 'rs-a-reseller_signed_date', a.reseller_signed_date, { type: 'date', dis: !draft })
      + '</div>'
      + (a.owner_snapshot ? '<p class="note">As signed: <b>Owner</b> ' + esc(K().partyRecital(a.owner_snapshot)) + '. <b>Reseller</b> ' + esc(K().partyRecital(a.reseller_snapshot)) + '.</p>' : '')
      + '<div class="btns">'
      +   btn('📄 Generate contract PDF', 'rs-agr-pdf', ' data-id="' + esc(id) + '"', draft ? 'ghost' : '')
      +   (draft ? btn('Save signatures', 'rs-agr-save', ' data-id="' + esc(id) + '"', 'ghost') + btn('✓ Activate agreement', 'rs-agr-activate', ' data-id="' + esc(id) + '"') : '')
      +   (draft ? btn('Delete draft', 'rs-agr-del', ' data-id="' + esc(id) + '"', 'danger') : '')
      +   msgBox('rs-a-sig-msg')
      + '</div>'
      + '<p class="note">Generate the PDF to sign (draft copies carry the "not legal advice" notice). Once both parties have signed, enter the dates and <b>Activate</b>: this freezes both parties\' details and starts commission statements.</p>'
      + '</div>';

    return '<button class="crumb" type="button" data-act="rs-open-reseller" data-id="' + esc(a.reseller_id) + '">&larr; ' + esc(r.legal_name || 'Reseller') + '</button>'
      + '<h1 style="margin-top:8px;">' + esc(a.agreement_number) + ' &middot; ' + esc(r.legal_name || '') + '</h1>'
      + terms + sig
      + (draft ? '' : termCard(a) + customersCard(a) + statementsCard(a));
  }

  function collectAgreementForm(){
    var b = {};
    ['effective_date','governing_law','discount_authority','pricing_note','owner_sign_name','owner_sign_title','owner_signed_date',
     'reseller_sign_name','reseller_sign_title','reseller_signed_date'].forEach(function(k){ b[k] = v('rs-a-' + k) || null; });
    ['commission_rate','payment_days','initial_term_months','renewal_term_months','nonrenewal_notice_days','termination_notice_days',
     'cure_days','nonsolicit_months','confidentiality_years','liability_months'].forEach(function(k){ b[k] = n('rs-a-' + k); });
    if (!b.governing_law) b.governing_law = 'Ontario';
    if (!b.discount_authority) b.discount_authority = 'never';
    if (b.initial_term_months < 1) b.initial_term_months = 12;
    if (b.renewal_term_months < 1) b.renewal_term_months = 12;
    return b;
  }
  async function patchAgreement(id, b){
    b.updated_at = new Date().toISOString();
    var r = await K().api('PATCH', '/reseller_agreements?id=eq.' + encodeURIComponent(id), b, 'return=representation');
    if (!r.ok) throw new Error((await r.text()).slice(0, 200));
    var row = (await r.json())[0];
    S.agreements = S.agreements.map(function(x){ return x.id === id ? row : x; });
    return row;
  }
  window.rsSaveAgreement = async function(id){
    try { await patchAgreement(id, collectAgreementForm()); }
    catch (e){ K().setMsg('rs-a-msg', 'Could not save: ' + e.message); K().setMsg('rs-a-sig-msg', 'Could not save: ' + e.message); return; }
    await K().audit('reseller_agreement_saved', agreement(id).agreement_number, '');
    window.renderResellers();
    K().setMsg('rs-a-sig-msg', 'Saved.', 'ok');
  };
  window.rsActivate = async function(id){
    var a = agreement(id); if (!a) return;
    var b = collectAgreementForm();
    var probe = Object.assign({}, a, b), miss = missingItems(probe);
    if (!b.owner_signed_date || !b.reseller_signed_date) miss.push('Both signature dates');
    if (miss.length){ K().setMsg('rs-a-sig-msg', 'Before activating: ' + miss.join('; ') + '.'); return; }
    var r = reseller(a.reseller_id);
    if (!await K().dlgConfirm('Activate ' + a.agreement_number + ' with ' + r.legal_name + ', effective ' + fmtLong(b.effective_date) + '?\n\nThis locks the terms and freezes both parties\' details as signed.', { title: 'Activate agreement', okText: 'Activate' })) return;
    var strip = function(p){ var o = Object.assign({}, p); delete o.id; delete o.notes; delete o.created_at; delete o.updated_at; delete o.created_by; delete o.updated_by; return o; };
    b.status = 'active'; b.owner_snapshot = strip(S.owner); b.reseller_snapshot = strip(r);
    try { await patchAgreement(id, b); } catch (e){ K().setMsg('rs-a-sig-msg', 'Could not activate: ' + e.message); return; }
    await K().audit('reseller_agreement_activated', a.agreement_number, r.legal_name + ' effective ' + b.effective_date);
    window.renderResellers();
  };
  window.rsDeleteAgreement = async function(id){
    var a = agreement(id); if (!a || a.status !== 'draft') return;
    if (!await K().dlgConfirm('Delete draft ' + a.agreement_number + '?', { title: 'Delete draft', okText: 'Delete' })) return;
    var r = await K().api('DELETE', '/reseller_agreements?id=eq.' + encodeURIComponent(id), null, 'return=minimal');
    if (!r.ok){ K().setMsg('rs-a-sig-msg', 'Could not delete: ' + (await r.text()).slice(0, 200)); return; }
    S.agreements = S.agreements.filter(function(x){ return x.id !== id; });
    await K().audit('reseller_agreement_deleted', a.agreement_number, '');
    go('reseller', a.reseller_id);
  };

  // ---- Term & termination (s.10, 13, 14) -------------------------------------
  function termCard(a){
    var asOf = a.terminated_date && a.terminated_date < today() ? a.terminated_date : today();
    var t = termInfo(a, asOf), row = function(l, val){ return '<tr><td style="color:var(--muted);width:46%;">' + l + '</td><td>' + val + '</td></tr>'; };
    var body = '<table><tbody>'
      + row('Effective date', esc(fmtLong(a.effective_date)))
      + (t ? row('Current term', 'Term ' + t.no + ': ' + esc(fmtLong(t.start)) + ' to ' + esc(fmtLong(t.end))) : '')
      + (t && !a.terminated_date ? row('Non-renewal notice due by', esc(fmtLong(t.nonrenewalBy)) + (t.nonrenewalBy < today() ? ' <span class="pill overdue">passed - renews</span>' : '')) : '');
    if (a.terminated_date){
      var tail = addMonths(a.terminated_date, a.nonsolicit_months || 0), conf = addMonths(a.terminated_date, (a.confidentiality_years || 0) * 12);
      body += row('Ending', esc(({ convenience: 'For convenience (s.10.2)', cause: 'For cause (s.10.3)', nonrenewal: 'Non-renewal (s.10.1)' })[a.termination_type] || a.termination_type || ''))
        + row('Notice given', esc(fmtLong(a.termination_notice_date)))
        + row('Termination effective', '<b>' + esc(fmtLong(a.terminated_date)) + '</b> &mdash; Commission stops accruing (s.10.4)')
        + row('Non-solicitation ends (s.14)', esc(fmtLong(tail)) + (tail >= today() ? ' ' + pill('issued', 'in force') : ''))
        + row('Confidentiality ends (s.13.5)', esc(fmtLong(conf)))
        + (a.termination_reason ? row('Reason / notes', esc(a.termination_reason)) : '');
    }
    body += '</tbody></table>';
    var form = a.terminated_date
      ? '<div class="btns">' + btn('Undo termination', 'rs-term-undo', ' data-id="' + esc(a.id) + '"', 'ghost') + msgBox('rs-t-msg') + '</div>'
      : '<details style="margin-top:12px;"><summary style="cursor:pointer;font-weight:700;font-size:13px;">Record a termination or non-renewal notice</summary>'
        + '<div class="rs-grid3">'
        +   sel('Type', 'rs-t-type', 'convenience', [['convenience', 'For convenience (' + a.termination_notice_days + ' days\' notice)'], ['nonrenewal', 'Non-renewal (ends at term end)'], ['cause', 'For cause (immediate)']])
        +   fld('Notice date', 'rs-t-notice', today(), { type: 'date' })
        +   fld('Effective date', 'rs-t-effective', addDays(today(), a.termination_notice_days || 0), { type: 'date', hint: 'Calculated from the type; adjust if needed.' })
        +   fld('Reason / notes', 'rs-t-reason', '', { area: true, full: true })
        + '</div>'
        + '<div class="btns">' + btn('Record termination', 'rs-term-save', ' data-id="' + esc(a.id) + '"', 'danger') + msgBox('rs-t-msg') + '</div></details>';
    return '<div class="card"><h3>Term &amp; termination</h3>' + body + form + '</div>';
  }
  function calcTermEffective(){
    var a = agreement(S.id); if (!a) return;
    var type = v('rs-t-type'), notice = v('rs-t-notice'), out = document.getElementById('rs-t-effective');
    if (!out || !notice) return;
    if (type === 'cause') out.value = notice;
    else if (type === 'nonrenewal'){
      var t = termInfo(a, notice);
      // Late notice (after the non-renewal deadline) runs to the end of the next term.
      out.value = (t && notice > t.nonrenewalBy) ? termInfo(a, addDays(t.end, 1)).end : (t ? t.end : notice);
    } else out.value = addDays(notice, a.termination_notice_days || 0);
  }
  window.rsSaveTermination = async function(id){
    var a = agreement(id); if (!a) return;
    var b = { termination_type: v('rs-t-type'), termination_notice_date: v('rs-t-notice') || null, terminated_date: v('rs-t-effective') || null, termination_reason: v('rs-t-reason') || null, status: 'terminated' };
    if (!b.termination_notice_date || !b.terminated_date){ K().setMsg('rs-t-msg', 'Notice and effective dates are required.'); return; }
    if (!await K().dlgConfirm('Record termination of ' + a.agreement_number + ', effective ' + fmtLong(b.terminated_date) + '?\n\nCommission stops on that date. Nothing is owed on later collections (s.10.4).', { title: 'Record termination', okText: 'Record' })) return;
    try { await patchAgreement(id, b); } catch (e){ K().setMsg('rs-t-msg', 'Could not save: ' + e.message); return; }
    await K().audit('reseller_agreement_terminated', a.agreement_number, b.termination_type + ' effective ' + b.terminated_date);
    window.renderResellers();
  };
  window.rsUndoTermination = async function(id){
    var a = agreement(id); if (!a) return;
    if (!await K().dlgConfirm('Clear the recorded termination on ' + a.agreement_number + '? Use this only to correct a mistake.', { title: 'Undo termination', okText: 'Clear' })) return;
    try { await patchAgreement(id, { termination_type: null, termination_notice_date: null, terminated_date: null, termination_reason: null, status: 'active' }); }
    catch (e){ K().setMsg('rs-t-msg', 'Could not save: ' + e.message); return; }
    await K().audit('reseller_agreement_termination_cleared', a.agreement_number, '');
    window.renderResellers();
  };

  // ---- Customers (s.7.4 registration) ----------------------------------------
  function normName(s){ return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
  function customersCard(a){
    var list = agrCustomers(a.id);
    var nations = K().nations() || [];
    var natOpts = [['', '— not in the registry yet —']].concat(nations.map(function(x){ return [x.subdomain, x.display_name + ' (' + x.subdomain + ')']; }));
    var rows = list.length ? list.map(function(cu){
      var nat = cu.subdomain ? nationBySub(cu.subdomain) : null;
      var acts = cu.status === 'submitted'
        ? btn('Register', 'rs-cust-status', ' data-id="' + esc(cu.id) + '" data-status="registered"') + btn('Decline', 'rs-cust-status', ' data-id="' + esc(cu.id) + '" data-status="declined"', 'ghost')
        : btn('Reset', 'rs-cust-status', ' data-id="' + esc(cu.id) + '" data-status="submitted"', 'ghost');
      return '<tr><td><b>' + esc(cu.prospect_name) + '</b>' + (cu.notes ? '<div style="font-size:11px;color:var(--muted);">' + esc(cu.notes) + '</div>' : '') + '</td>'
        + '<td>' + (nat ? esc(nat.display_name) : (cu.subdomain ? esc(cu.subdomain) : '<span class="empty">not linked</span>'))
        +   ' ' + btn('Link', 'rs-cust-link', ' data-id="' + esc(cu.id) + '"', 'ghost') + '</td>'
        + '<td>' + esc(cu.submitted_date) + '</td>'
        + '<td>' + pill(cu.status) + (cu.decision_date ? '<div style="font-size:11px;color:var(--muted);">' + esc(cu.decision_date) + '</div>' : '') + '</td>'
        + '<td><div class="row-actions">' + acts + btn('✕', 'rs-cust-del', ' data-id="' + esc(cu.id) + '" title="Remove"', 'ghost') + '</div></td></tr>';
    }).join('') : '<tr><td colspan="5" class="empty">No leads submitted yet.</td></tr>';
    var locked = a.terminated_date && a.terminated_date <= today();
    return '<div class="card"><h3>Reseller customers (s.7)</h3>'
      + '<p class="sub" style="margin:0;">Leads the reseller submits. Only <b>registered</b> customers linked to a nation earn commission, and only once that nation starts paying (s.6.4). If two resellers submit the same prospect, the first one to submit gets it (s.7.4).</p>'
      + '<div class="tbl-wrap"><table><thead><tr><th>Prospect</th><th>Nation</th><th>Submitted</th><th>Status</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>'
      + (locked ? '' :
        '<details style="margin-top:12px;"><summary style="cursor:pointer;font-weight:700;font-size:13px;">+ Submit a lead</summary><div class="rs-grid">'
        + fld('Prospect name', 'rs-c-name', '', { ph: 'e.g. the nation\'s name' })
        + sel('Nation (if already in the registry)', 'rs-c-sub', '', natOpts)
        + fld('Date submitted', 'rs-c-date', today(), { type: 'date' })
        + fld('Notes', 'rs-c-notes', '', { ph: 'Contact, context, prior discussions…' })
        + '</div><div class="btns">' + btn('Add lead', 'rs-cust-add', ' data-id="' + esc(a.id) + '"') + msgBox('rs-c-msg') + '</div></details>')
      + '</div>';
  }
  window.rsAddCustomer = async function(aid){
    var name = v('rs-c-name'), sub = v('rs-c-sub') || null;
    if (!name && sub){ var nat = nationBySub(sub); name = nat ? nat.display_name : sub; }
    if (!name){ K().setMsg('rs-c-msg', 'Enter the prospect name.'); return; }
    // First-to-submit: warn when another agreement already holds this prospect.
    var clash = S.customers.filter(function(x){ return x.status !== 'declined' && ((sub && x.subdomain === sub) || normName(x.prospect_name) === normName(name)); })[0];
    if (clash){
      var ca = agreement(clash.agreement_id), cr = ca ? reseller(ca.reseller_id) : null;
      if (!await K().dlgConfirm('"' + clash.prospect_name + '" was already submitted on ' + clash.submitted_date + ' under ' + (ca ? ca.agreement_number : 'another agreement') + (cr ? ' (' + cr.legal_name + ')' : '') + '.\n\nUnder s.7.4 the first reseller to submit a prospect gets it. Add this lead anyway?', { title: 'Possible duplicate lead', okText: 'Add anyway' })) return;
    }
    var b = { agreement_id: aid, prospect_name: name, subdomain: sub, status: 'submitted', submitted_date: v('rs-c-date') || today(), notes: v('rs-c-notes') || null, created_by: K().jwtEmail() };
    var r = await K().api('POST', '/reseller_customers', b, 'return=representation');
    if (!r.ok){ K().setMsg('rs-c-msg', 'Could not add: ' + (await r.text()).slice(0, 200)); return; }
    S.customers.push((await r.json())[0]);
    await K().audit('reseller_lead_submitted', agreement(aid).agreement_number, name);
    window.renderResellers();
  };
  window.rsCustomerStatus = async function(cid, status){
    var cu = S.customers.filter(function(x){ return x.id === cid; })[0]; if (!cu) return;
    if (status === 'registered' && !cu.subdomain){
      if (!await K().dlgConfirm('Register "' + cu.prospect_name + '" without linking it to a nation? It won\'t earn commission until it\'s linked (use Link once the nation is set up).', { title: 'Register lead', okText: 'Register' })) return;
    }
    var b = { status: status, decision_date: status === 'submitted' ? null : today() };
    var r = await K().api('PATCH', '/reseller_customers?id=eq.' + encodeURIComponent(cid), b, 'return=representation');
    if (!r.ok){ await K().dlgAlert('Could not update: ' + (await r.text()).slice(0, 200)); return; }
    var row = (await r.json())[0]; S.customers = S.customers.map(function(x){ return x.id === cid ? row : x; });
    await K().audit('reseller_customer_' + status, cu.prospect_name, agreement(cu.agreement_id).agreement_number);
    window.renderResellers();
  };
  window.rsLinkCustomer = async function(cid){
    var cu = S.customers.filter(function(x){ return x.id === cid; })[0]; if (!cu) return;
    S._linkPick = null;
    var nations = K().nations() || [];
    var opts = '<option value="">— none —</option>' + nations.map(function(x){ return '<option value="' + esc(x.subdomain) + '"' + (x.subdomain === cu.subdomain ? ' selected' : '') + '>' + esc(x.display_name + ' (' + x.subdomain + ')') + '</option>'; }).join('');
    var ok = await K().dlgConfirm('', { title: 'Link "' + cu.prospect_name + '" to a nation', okText: 'Save',
      bodyHtml: '<label for="rs-link-sel">Nation</label><select id="rs-link-sel">' + opts + '</select>' });
    // dlgConfirm removes the dialog on close, so read the value via a capture listener below.
    if (!ok) return;
    var sub = S._linkPick == null ? cu.subdomain : S._linkPick; S._linkPick = null;
    var r = await K().api('PATCH', '/reseller_customers?id=eq.' + encodeURIComponent(cid), { subdomain: sub || null }, 'return=representation');
    if (!r.ok){ await K().dlgAlert('Could not link: ' + (await r.text()).slice(0, 200)); return; }
    var row = (await r.json())[0]; S.customers = S.customers.map(function(x){ return x.id === cid ? row : x; });
    await K().audit('reseller_customer_linked', cu.prospect_name, sub || '(none)');
    window.renderResellers();
  };
  window.rsDeleteCustomer = async function(cid){
    var cu = S.customers.filter(function(x){ return x.id === cid; })[0]; if (!cu) return;
    if (!await K().dlgConfirm('Remove "' + cu.prospect_name + '" from this agreement?', { title: 'Remove lead', okText: 'Remove' })) return;
    var r = await K().api('DELETE', '/reseller_customers?id=eq.' + encodeURIComponent(cid), null, 'return=minimal');
    if (!r.ok){ await K().dlgAlert('Could not remove: ' + (await r.text()).slice(0, 200)); return; }
    S.customers = S.customers.filter(function(x){ return x.id !== cid; });
    await K().audit('reseller_customer_removed', cu.prospect_name, '');
    window.renderResellers();
  };

  // ---- Statements (ss.7-9, Schedule A) ---------------------------------------
  function statementsCard(a){
    var months = statementMonths(a).slice().reverse();
    var rows = months.length ? months.map(function(m){
      var st = agrStatements(a.id).filter(function(s){ return s.period_month === m; })[0];
      var due = stmtDueDate(a, m), late = (!st || st.status !== 'paid') && due < today();
      var status = st ? st.status : 'none';
      return '<tr><td><b>' + esc(fmtMonth(m)) + '</b></td>'
        + '<td>' + pill(status, status === 'none' ? 'not prepared' : status) + (late ? ' ' + pill('overdue') : '') + '</td>'
        + '<td>' + esc(due) + '</td>'
        + '<td class="num">' + (st ? money(st.net_revenue) : '—') + '</td>'
        + '<td class="num">' + (st ? '<b>' + money(st.amount_due) + '</b>' : '—') + '</td>'
        + '<td>' + btn(st ? 'Open' : 'Prepare', 'rs-stmt-open', ' data-id="' + esc(a.id) + '" data-month="' + m + '"', st ? 'ghost' : '') + '</td></tr>';
    }).join('') : '<tr><td colspan="6" class="empty">No completed months yet. The first statement is due after the end of the effective month.</td></tr>';
    var paid = 0, owing = 0;
    agrStatements(a.id).forEach(function(s){ if (s.status === 'paid') paid += Number(s.amount_due) || 0; else if (s.status === 'issued') owing += Number(s.amount_due) || 0; });
    return '<div class="card"><h3>Monthly commission statements (s.9)</h3>'
      + '<p class="sub" style="margin:0;">Due ' + (a.payment_days || 30) + ' days after each month-end. Commission is ' + Number(a.commission_rate) + '% of Net Revenue actually <b>collected</b> from registered customers (s.7–8). Paid to date: <b>' + money(paid) + '</b> &middot; issued, unpaid: <b>' + money(owing) + '</b>.</p>'
      + '<div class="tbl-wrap"><table><thead><tr><th>Month</th><th>Status</th><th>Due</th><th class="num">Net revenue</th><th class="num">Amount due</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>'
      + '<div id="rs-stmt"></div></div>';
  }

  // Recurring Subscription Fees only (s.7.3): subscription + the monthly AI
  // add-on. Setup, consulting, travel, interest and carried balances excluded.
  function isRecurringLine(d){ d = String(d || ''); return /subscription|ai staff assistant/i.test(d) && !/setup|carried forward|interest/i.test(d); }
  // Recurring share of what was COLLECTED on one invoice (tax-inclusive) + its tax part.
  function invoiceCollected(inv){
    var rec = 0;
    (inv.line_items || []).forEach(function(l){ if (isRecurringLine(l.description)) rec += (Number(l.qty) || 0) * (Number(l.unit_price) || 0); });
    var sub = Number(inv.subtotal) || 0, total = Number(inv.total) || 0, paid = Number(inv.amount_paid) || 0;
    if (rec <= 0 || sub <= 0 || total <= 0 || paid <= 0) return null;
    var share = Math.min(1, rec / sub);
    var preTax = rec - (Number(inv.discount) || 0) * share, tax = (Number(inv.tax) || 0) * share;
    var f = Math.min(1, paid / total);
    return { collected: r2((preTax + tax) * f), tax: r2(tax * f) };
  }

  // Build a fresh draft for (agreement, month) from invoices + usage.
  async function buildStatement(a, m){
    var start = monthStart(m), end = monthEnd(m), stop = commissionEnd(a);
    if (a.effective_date > start) start = a.effective_date;
    if (stop && stop < end) end = stop;
    var custs = agrCustomers(a.id).filter(function(x){ return x.status === 'registered' && x.subdomain; });
    // Amounts already counted on other statements (partial payments that later
    // complete would otherwise be counted twice).
    var prior = {};
    agrStatements(a.id).forEach(function(s){
      if (s.period_month === m) return;
      (s.lines || []).forEach(function(l){ (l.invoices || []).forEach(function(i){ prior[i.id] = (prior[i.id] || { c: 0, t: 0 }); prior[i.id].c += Number(i.collected) || 0; prior[i.id].t += Number(i.tax) || 0; }); });
    });
    var invs = [], usage = [];
    if (custs.length){
      var subs = custs.map(function(x){ return encodeURIComponent(x.subdomain); }).join(',');
      invs = await getJson('/nation_invoices?select=id,number,subdomain,line_items,subtotal,discount,tax,total,amount_paid,paid_date,status'
        + '&subdomain=in.(' + subs + ')&status=neq.void&paid_date=gte.' + start + '&paid_date=lte.' + end);
      try { usage = await getJson('/nation_usage?select=*&subdomain=in.(' + subs + ')'); } catch (e){ usage = []; }
    }
    var lines = custs.map(function(cu){
      var nat = nationBySub(cu.subdomain), u = usage.filter(function(x){ return x.subdomain === cu.subdomain; })[0];
      var counted = [];
      invs.filter(function(i){ return i.subdomain === cu.subdomain; }).forEach(function(i){
        var col = invoiceCollected(i); if (!col) return;
        var p = prior[i.id] || { c: 0, t: 0 };
        var cNew = r2(col.collected - p.c), tNew = r2(col.tax - p.t);
        if (cNew > 0.004) counted.push({ id: i.id, number: i.number, paid_date: i.paid_date, collected: cNew, tax: Math.max(0, tNew) });
      });
      var gross = r2(counted.reduce(function(s, i){ return s + i.collected; }, 0));
      var taxes = r2(counted.reduce(function(s, i){ return s + i.tax; }, 0));
      return { customer_id: cu.id, subdomain: cu.subdomain, name: nat ? nat.display_name : cu.prospect_name, invoices: counted,
        gross: gross, hosting: gross > 0 && nat ? K().estCost(nat, u).total : 0, processing: 0, taxes: taxes, refunds: 0 };
    });
    // Carry an unrecovered negative balance from the previous statement (s.9.2).
    var prev = agrStatements(a.id).filter(function(s){ return s.period_month < m && s.status !== 'draft'; }).sort(function(x, y){ return x.period_month < y.period_month ? 1 : -1; })[0];
    var carry = prev && Number(prev.amount_due) < 0 ? r2(-Number(prev.amount_due)) : 0;
    return { agreement_id: a.id, period_month: m, lines: lines, commission_rate: Number(a.commission_rate),
      clawback: carry, clawback_note: carry ? 'Carried from ' + fmtMonth(prev.period_month) : '', status: 'draft', due_date: stmtDueDate(a, m), notes: '' };
  }

  function calcStatement(st){
    var rate = Number(st.commission_rate) || 0, gross = 0, ded = 0, net = 0, com = 0;
    (st.lines || []).forEach(function(l){
      l.net = r2((Number(l.gross) || 0) - (Number(l.hosting) || 0) - (Number(l.processing) || 0) - (Number(l.taxes) || 0) - (Number(l.refunds) || 0));
      l.commission = r2(Math.max(0, l.net) * rate / 100);
      gross += Number(l.gross) || 0; ded += (Number(l.gross) || 0) - l.net; net += l.net; com += l.commission;
    });
    st.gross_revenue = r2(gross); st.deductions = r2(ded); st.net_revenue = r2(net); st.commission = r2(com);
    st.amount_due = r2(com - (Number(st.clawback) || 0));
    return st;
  }

  window.rsOpenStatement = async function(aid, m){
    var a = agreement(aid); if (!a) return;
    var host = document.getElementById('rs-stmt'); if (host) host.innerHTML = '<p class="sub" style="margin-top:12px;">Preparing ' + esc(fmtMonth(m)) + '…</p>';
    var saved = agrStatements(aid).filter(function(s){ return s.period_month === m; })[0];
    try { S.stmt = saved ? JSON.parse(JSON.stringify(saved)) : await buildStatement(a, m); }
    catch (e){ if (host) host.innerHTML = '<div class="msg err">Could not build the statement: ' + esc(String(e && e.message || e).slice(0, 200)) + '</div>'; return; }
    calcStatement(S.stmt); drawStatement();
    if (host) try { host.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e){}
  };

  function drawStatement(){
    var st = S.stmt, host = document.getElementById('rs-stmt'); if (!st || !host) return;
    var a = agreement(st.agreement_id), r = reseller(a.reseller_id) || {}, draft = st.status === 'draft', dis = draft ? '' : ' disabled';
    var cell = function(i, k){ return '<td class="num"><input class="st-in" type="number" step="0.01" data-line="' + i + '" data-k="' + k + '" value="' + (Number(st.lines[i][k]) || 0).toFixed(2) + '"' + dis + '/></td>'; };
    var rows = (st.lines || []).length ? st.lines.map(function(l, i){
      var invs = (l.invoices || []).map(function(x){ return esc(x.number) + ' (' + esc(x.paid_date || '') + ', ' + money(x.collected) + ')'; }).join(', ');
      return '<tr><td><b>' + esc(l.name) + '</b><div style="font-size:11px;color:var(--muted);">' + (invs || 'no recurring collections this month') + '</div></td>'
        + cell(i, 'gross') + cell(i, 'hosting') + cell(i, 'processing') + cell(i, 'taxes') + cell(i, 'refunds')
        + '<td class="num" data-out="net-' + i + '">' + money(l.net) + '</td><td class="num" data-out="com-' + i + '"><b>' + money(l.commission) + '</b></td></tr>';
    }).join('') : '<tr><td colspan="8" class="empty">No registered, nation-linked customers on this agreement, so nothing is owed this month.</td></tr>';
    var hst = r.gst_hst_registered && st.amount_due > 0 ? r2(st.amount_due * (Number(r.hst_rate) || 0) / 100) : 0;
    host.innerHTML = '<div style="margin-top:18px;padding-top:14px;border-top:2px solid var(--accent);">'
      + '<h3 style="margin:0 0 4px;">Statement &middot; ' + esc(fmtMonth(st.period_month)) + ' ' + pill(st.status) + '</h3>'
      + '<p class="note" style="margin-top:0;">Gross = recurring Subscription Fees collected (incl. tax), taken from invoices paid this month. Setup, consulting, travel and interest are excluded (s.7.3). Hosting is pre-filled from the nation\'s estimated platform cost. Check every figure before issuing.</p>'
      + '<div class="tbl-wrap"><table><thead><tr><th>Customer</th><th class="num">Gross collected</th><th class="num">Hosting</th><th class="num">Processing</th><th class="num">Taxes</th><th class="num">Refunds / credits</th><th class="num">Net revenue</th><th class="num">Commission ' + Number(st.commission_rate) + '%</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
      + '<div class="rs-grid3">'
      +   fld('Clawback / offset (s.9.2)', 'rs-s-clawback', (Number(st.clawback) || 0).toFixed(2), { type: 'number', step: '0.01', dis: !draft })
      +   fld('Clawback note', 'rs-s-clawback_note', st.clawback_note, { dis: !draft, ph: 'e.g. Refund on HLH-2026-07' })
      +   fld('Payment due', 'rs-s-due_date', st.due_date, { type: 'date', dis: !draft })
      +   fld('Notes', 'rs-s-notes', st.notes, { area: true, full: true, dis: !draft })
      + '</div>'
      + '<table style="max-width:420px;margin-left:auto;"><tbody>'
      +   '<tr><td>Net revenue</td><td class="num" id="rs-s-net">' + money(st.net_revenue) + '</td></tr>'
      +   '<tr><td>Commission</td><td class="num" id="rs-s-com">' + money(st.commission) + '</td></tr>'
      +   '<tr><td>Less clawback / offset</td><td class="num" id="rs-s-claw">' + (Number(st.clawback) ? '-' : '') + money(st.clawback) + '</td></tr>'
      +   '<tr><td><b>Amount due to reseller</b></td><td class="num"><b id="rs-s-due">' + money(st.amount_due) + '</b></td></tr>'
      + '</tbody></table>'
      + '<p class="note" id="rs-s-hint">' + dueHint(st, r, hst) + '</p>'
      + (st.status === 'paid' ? '<p class="note">Paid ' + esc(st.paid_date || '') + (st.payment_ref ? ' &middot; ref ' + esc(st.payment_ref) : '') + (st.reseller_invoice_number ? ' &middot; reseller invoice ' + esc(st.reseller_invoice_number) : '') + '.</p>' : '')
      + '<div class="btns">'
      +   (draft ? btn('Save draft', 'rs-stmt-save') + btn('Issue statement', 'rs-stmt-issue') + btn('↻ Rebuild from invoices', 'rs-stmt-rebuild', '', 'ghost') : '')
      +   (st.status === 'issued' ? btn('Record payment', 'rs-stmt-pay') + btn('Back to draft', 'rs-stmt-unissue', '', 'ghost') : '')
      +   (st.status === 'paid' ? btn('Undo payment', 'rs-stmt-unpay', '', 'ghost') : '')
      +   btn('📄 Statement PDF', 'rs-stmt-pdf', '', 'ghost')
      +   (draft && st.id ? btn('Delete draft', 'rs-stmt-del', '', 'danger') : '')
      +   msgBox('rs-s-msg')
      + '</div></div>';
  }
  function dueHint(st, r, hst){
    if (st.amount_due < 0) return 'Commission doesn\'t cover the clawback. The remaining ' + money(-st.amount_due) + ' is carried into next month\'s statement (s.9.2).';
    if (hst > 0) return r.legal_name + ' is GST/HST-registered: their invoice should be ' + money(st.amount_due) + ' + HST ' + money(hst) + ' = <b>' + money(st.amount_due + hst) + '</b> (s.9.4).';
    return 'The reseller invoices the Owner for this amount (s.9.4).' + (r.payment_details ? ' Pay by: ' + esc(r.payment_details) + '.' : '');
  }
  function readStatementForm(){
    var st = S.stmt; if (!st || st.status !== 'draft') return;
    Array.prototype.forEach.call(document.querySelectorAll('#rs-stmt .st-in'), function(inp){
      var i = Number(inp.getAttribute('data-line')), k = inp.getAttribute('data-k');
      if (st.lines[i]) st.lines[i][k] = r2(inp.value);
    });
    st.clawback = r2(v('rs-s-clawback')); st.clawback_note = v('rs-s-clawback_note') || null;
    st.due_date = v('rs-s-due_date') || st.due_date; st.notes = v('rs-s-notes') || null;
    calcStatement(st);
  }
  function refreshStatementTotals(){
    readStatementForm(); var st = S.stmt; if (!st) return;
    st.lines.forEach(function(l, i){
      var ne = document.querySelector('#rs-stmt [data-out="net-' + i + '"]'), ce = document.querySelector('#rs-stmt [data-out="com-' + i + '"]');
      if (ne) ne.textContent = money(l.net); if (ce) ce.innerHTML = '<b>' + money(l.commission) + '</b>';
    });
    var set = function(id, t){ var e = document.getElementById(id); if (e) e.textContent = t; };
    set('rs-s-net', money(st.net_revenue)); set('rs-s-com', money(st.commission)); set('rs-s-claw', (st.clawback ? '-' : '') + money(st.clawback)); set('rs-s-due', money(st.amount_due));
    var a = agreement(st.agreement_id), r = reseller(a.reseller_id) || {};
    var hst = r.gst_hst_registered && st.amount_due > 0 ? r2(st.amount_due * (Number(r.hst_rate) || 0) / 100) : 0;
    var h = document.getElementById('rs-s-hint'); if (h) h.innerHTML = dueHint(st, r, hst);
  }
  async function persistStatement(extra){
    var st = S.stmt;
    var b = { agreement_id: st.agreement_id, period_month: st.period_month, lines: st.lines, gross_revenue: st.gross_revenue, deductions: st.deductions,
      net_revenue: st.net_revenue, commission_rate: st.commission_rate, commission: st.commission, clawback: st.clawback, clawback_note: st.clawback_note || null,
      amount_due: st.amount_due, status: st.status, due_date: st.due_date, issued_date: st.issued_date || null, paid_date: st.paid_date || null,
      payment_ref: st.payment_ref || null, reseller_invoice_number: st.reseller_invoice_number || null, notes: st.notes || null, updated_at: new Date().toISOString() };
    Object.assign(b, extra || {});
    var r;
    if (st.id) r = await K().api('PATCH', '/reseller_statements?id=eq.' + encodeURIComponent(st.id), b, 'return=representation');
    else { b.created_by = K().jwtEmail(); r = await K().api('POST', '/reseller_statements', b, 'return=representation'); }
    if (!r.ok) throw new Error((await r.text()).slice(0, 200));
    var row = (await r.json())[0];
    S.statements = S.statements.filter(function(x){ return x.id !== row.id; }).concat([row]);
    S.stmt = JSON.parse(JSON.stringify(row));
    return row;
  }
  async function stmtAction(fn, okMsg, auditAction){
    try { await fn(); } catch (e){ K().setMsg('rs-s-msg', 'Could not save: ' + e.message); return; }
    var a = agreement(S.stmt.agreement_id);
    if (auditAction) await K().audit(auditAction, a.agreement_number, S.stmt.period_month + ' ' + money(S.stmt.amount_due));
    window.renderResellers(); // redraws the list + the open statement (S.stmt)
    setTimeout(function(){ if (okMsg) K().setMsg('rs-s-msg', okMsg, 'ok'); }, 0);
  }
  window.rsStatementSave = function(){ readStatementForm(); return stmtAction(function(){ return persistStatement(); }, 'Draft saved.', 'reseller_statement_saved'); };
  window.rsStatementIssue = async function(){
    readStatementForm();
    if (!await K().dlgConfirm('Issue the ' + fmtMonth(S.stmt.period_month) + ' statement? Amount due: ' + money(S.stmt.amount_due) + '.\n\nIssued statements are locked. Use "Back to draft" to correct one.', { title: 'Issue statement', okText: 'Issue' })) return;
    return stmtAction(function(){ S.stmt.status = 'issued'; S.stmt.issued_date = today(); return persistStatement(); }, 'Statement issued. Generate the PDF to send to the reseller.', 'reseller_statement_issued');
  };
  window.rsStatementUnissue = function(){ return stmtAction(function(){ S.stmt.status = 'draft'; S.stmt.issued_date = null; return persistStatement(); }, 'Back to draft.', 'reseller_statement_reopened'); };
  window.rsStatementPay = async function(){
    var st = S.stmt;
    var f = await K().dlgForm('Record commission payment', [
      { key: 'paid_date', label: 'Payment date', inputType: 'date', defaultValue: today(), validate: function(x){ return x ? '' : 'Required'; } },
      { key: 'payment_ref', label: 'Payment reference (e-Transfer / EFT / cheque #)', defaultValue: st.payment_ref || '' },
      { key: 'reseller_invoice_number', label: 'Reseller\'s invoice number (s.9.4)', defaultValue: st.reseller_invoice_number || '' }
    ], { okText: 'Mark paid', message: 'Amount due: ' + money(st.amount_due) });
    if (!f) return;
    return stmtAction(function(){ Object.assign(S.stmt, f, { status: 'paid' }); return persistStatement(); }, 'Payment recorded.', 'reseller_statement_paid');
  };
  window.rsStatementUnpay = function(){ return stmtAction(function(){ Object.assign(S.stmt, { status: 'issued', paid_date: null, payment_ref: null }); return persistStatement(); }, 'Payment cleared.', 'reseller_statement_unpaid'); };
  window.rsStatementRebuild = async function(){
    var st = S.stmt, a = agreement(st.agreement_id);
    if (!await K().dlgConfirm('Rebuild this draft from the current invoices? Your manual edits to the figures will be replaced.', { title: 'Rebuild statement', okText: 'Rebuild' })) return;
    var fresh = await buildStatement(a, st.period_month);
    fresh.id = st.id; fresh.notes = st.notes; S.stmt = calcStatement(fresh); drawStatement();
    K().setMsg('rs-s-msg', 'Rebuilt. Save the draft to keep it.', 'ok');
  };
  window.rsStatementDelete = async function(){
    var st = S.stmt; if (!st.id) return;
    if (!await K().dlgConfirm('Delete the ' + fmtMonth(st.period_month) + ' draft statement?', { title: 'Delete draft', okText: 'Delete' })) return;
    var r = await K().api('DELETE', '/reseller_statements?id=eq.' + encodeURIComponent(st.id), null, 'return=minimal');
    if (!r.ok){ K().setMsg('rs-s-msg', 'Could not delete: ' + (await r.text()).slice(0, 200)); return; }
    S.statements = S.statements.filter(function(x){ return x.id !== st.id; }); S.stmt = null;
    window.renderResellers();
  };

  // ---- PDFs ------------------------------------------------------------------
  function openPdf(doc, fname, msgId){
    var url = URL.createObjectURL(doc.output('blob'));
    doc.save(fname);
    K().setMsgWithView(msgId, 'Generated ' + fname + '.', url);
  }

  // The SaaS Reseller Commission Agreement, every placeholder filled from the
  // agreement + Owner + Reseller records (marker format: see AGREEMENT_TPL in
  // admin.js — # title, % subtitle, ## heading, - bullet, > notice).
  function resellerContractText(a){
    var o = a.owner_snapshot || S.owner || {}, r = a.reseller_snapshot || reseller(a.reseller_id) || {};
    var oName = o.legal_name || '[OWNER LEGAL NAME]', rName = r.legal_name || '[RESELLER LEGAL NAME]';
    var product = o.product_name ? 'marketed as "' + o.product_name + '" ' : '';
    var rate = Number(a.commission_rate), law = a.governing_law || 'Ontario';
    var eff = a.effective_date ? fmtLong(a.effective_date) : '____________________';
    var exGross = 1000, exHost = 120, exProc = 30, exNet = exGross - exHost - exProc, exCom = r2(exNet * rate / 100);
    var fmt2 = function(x){ return Number(x).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','); };
    var L = [];
    if (a.status === 'draft') L.push('>DRAFT FOR REVIEW - not legal advice. This agreement has not been reviewed by a lawyer. Before anyone signs, have it reviewed by qualified legal counsel licensed in ' + law + '; commission structures and restrictive covenants in particular turn on local law.');
    L.push('#SAAS RESELLER COMMISSION AGREEMENT', '%Agreement No. ' + a.agreement_number,
      '##1. Parties and Background',
      'This Reseller Commission Agreement (the "Agreement") is made as of ' + eff + ' between:',
      '-' + (K().partyRecital(o) || oName) + ' (the "Owner"); and',
      '-' + (K().partyRecital(r) || rName) + ' (the "Reseller").',
      'The Owner and the Reseller are each a "Party" and together the "Parties."',
      'Background:',
      '-The Owner owns and operates a multi-tenant, cloud-based housing-management software platform ' + product + '(the "Platform") that it licenses to First Nations and similar organizations on a subscription basis.',
      '-The Owner wishes to engage the Reseller, on a non-exclusive basis, to find and refer prospective customers for the Platform.',
      '-The Reseller wishes to do so on the terms below.',
      'The Parties agree as follows.',
      '##2. Definitions',
      '-"Commission" means the amount payable to the Reseller under Section 7.',
      '-"Customer" means an organization that enters into a Customer Subscription Agreement with the Owner.',
      '-"Customer Subscription Agreement" means the subscription contract between the Owner and a Customer for use of the Platform.',
      '-"Reseller Customer" means a Customer that the Reseller sourced and that the Owner has registered to the Reseller under Section 7.',
      '-"Subscription Fees" means the recurring fees a Customer actually pays the Owner for the Platform.',
      '-"Gross Revenue" means Subscription Fees actually collected by the Owner from a Reseller Customer in a given month.',
      '-"Net Revenue" has the meaning in Section 8.',
      '-"Confidential Information" has the meaning in Section 13.',
      '-"Effective Date" means the date stated in Section 1.',
      '-"Term" has the meaning in Section 10.',
      '##3. Appointment and Scope',
      '3.1 Non-exclusive appointment. The Owner appoints the Reseller as a non-exclusive reseller to market and refer the Platform, and the Reseller accepts.',
      '3.2 Sell-only role. The Reseller\'s role is limited to sourcing and referring prospective Customers. The Owner contracts directly with each Customer and is solely responsible for onboarding, implementation, training, and support.',
      '3.3 No authority to bind. The Reseller has no authority to enter into agreements for the Owner, set or change prices, grant discounts, make commitments or warranties, or otherwise bind the Owner, and will not represent that it has such authority.',
      '3.4 Owner retains freedom. Nothing limits the Owner from marketing or selling the Platform directly, or through other resellers, to any person. There is no territory restriction and no exclusivity.',
      '##4. Reseller\'s Responsibilities',
      'The Reseller will:',
      '-4.1 Market and promote the Platform lawfully, ethically, and accurately, using only marketing materials and claims approved by the Owner in writing.',
      '-4.2 Submit leads and opportunities through the Owner\'s designated process so they can be registered under Section 7.',
      '-4.3 Make no misrepresentations about the Platform and no commitments, prices, discounts, or warranties on the Owner\'s behalf.',
      '-4.4 Comply with all applicable laws and the Owner\'s brand and conduct guidelines.',
      '-4.5 Use commercially reasonable efforts to promote the Platform.',
      '-4.6 Not access, collect, store, or handle any Customer data (see Section 12).',
      '##5. Owner\'s Responsibilities',
      'The Owner will:',
      '-5.1 Provide, host, maintain, secure, and support the Platform.',
      '-5.2 Set pricing and enter into and manage all Customer Subscription Agreements.',
      '-5.3 Invoice Customers and collect Subscription Fees.',
      '-5.4 Onboard, implement, train, and support each Customer.',
      '-5.5 Provide the Reseller with approved sales and marketing materials.',
      '-5.6 Register Reseller Customers and provide monthly Commission statements under Sections 7-9.',
      '##6. Pricing and Customer Subscription Agreements',
      '6.1 Owner sets pricing. The Owner sets, and may change at any time in its discretion, all pricing for the Platform, including any flat subscription fee or per-module licensing.' + (a.pricing_note ? ' For reference only, the Owner\'s pricing at the Effective Date is: ' + a.pricing_note : ''),
      '6.2 Owner is the contracting party. Each Customer contracts directly with the Owner. The Reseller is not a party to any Customer Subscription Agreement.',
      a.discount_authority === 'with_approval'
        ? '6.3 No unauthorized terms. The Reseller may not offer any discount, credit, refund, or non-standard term unless the Owner approves it in writing in advance.'
        : '6.3 No discounts. The Reseller may not offer any discount, credit, refund, or non-standard term under any circumstances.',
      '6.4 When a Customer counts. A prospect becomes a Reseller Customer only once the Owner accepts it, registers it to the Reseller under Section 7, and the Customer begins paying Subscription Fees.',
      '##7. Commission',
      '7.1 Rate. For each Reseller Customer, the Owner will pay the Reseller a Commission equal to ' + rate + '% of Net Revenue (Section 8) actually collected from that Customer.',
      '7.2 Duration. The Commission is payable for each month in which both (a) the Reseller Customer remains subscribed and pays Subscription Fees, and (b) this Agreement remains in effect. On termination of this Agreement, the Commission ceases under Section 10.',
      '7.3 Recurring fees only. Commission is calculated on recurring Subscription Fees only. One-time fees (for example, setup, data migration, or training) are excluded unless the Parties agree otherwise in writing for a specific Customer.',
      '7.4 Attribution. The Owner will register a prospect as a Reseller Customer where the Reseller is the first to submit that prospect through the Owner\'s process and the prospect was not already in discussions with the Owner. If attribution is disputed, the Owner\'s reasonable, good-faith determination from its records governs.',
      '##8. Net Revenue',
      '"Net Revenue" for a Reseller Customer in a month means the Gross Revenue actually collected from that Customer that month, minus, without duplication:',
      '-8.1 Hosting and infrastructure costs reasonably attributable to that Customer (for example, hosting, database, and platform services such as Supabase and Cloudflare);',
      '-8.2 Payment-processing and bank fees charged on collecting that Customer\'s Subscription Fees; and',
      '-8.3 Taxes (such as GST/HST and similar amounts), and any refunds, chargebacks, credits, or waived amounts relating to that Customer.',
      'The Owner\'s direct support and implementation labor is not deducted in calculating Net Revenue. Commission is based on amounts actually collected, not amounts invoiced. A worked example is in Schedule A.',
      '##9. Payment, Reporting, Clawback, and Taxes',
      '9.1 Monthly statement and payment. Within ' + a.payment_days + ' days after the end of each calendar month, the Owner will give the Reseller a statement of Net Revenue and Commission for that month and pay the Commission then due on amounts collected that month.',
      '9.2 Clawback / offset. If an amount is later refunded, charged back, reversed, or found uncollectible, the related Commission is reversed and offset against current or future Commission (or repaid if none is pending).',
      '9.3 Collected amounts only. No Commission is owed on invoiced amounts that are not collected.',
      '9.4 Taxes. The Reseller is responsible for its own taxes. The Reseller will invoice the Owner for Commission and add GST/HST if the Reseller is registered.',
      '9.5 Records and audit. The Owner will keep reasonable records supporting its statements. No more than once per year, on reasonable notice, the Reseller (or its representative) may review those records solely to verify Commission.',
      '9.6 Currency. All amounts are in Canadian dollars (CAD).',
      '##10. Term and Termination',
      '10.1 Term. This Agreement begins on the Effective Date and continues for ' + periodWords(a.initial_term_months) + ' (the "Initial Term"), then renews for successive ' + periodWords(a.renewal_term_months) + ' periods unless either Party gives notice of non-renewal at least ' + a.nonrenewal_notice_days + ' days before the end of the then-current term (together, the "Term").',
      '10.2 Termination for convenience. Either Party may terminate on ' + a.termination_notice_days + ' days\' written notice.',
      '10.3 Termination for cause. Either Party may terminate immediately if the other materially breaches and fails to cure within ' + a.cure_days + ' days of written notice, or becomes insolvent or bankrupt.',
      '10.4 Effect of termination - Commission ceases. On the effective date of termination or expiry, the Owner\'s obligation to pay Commission ends. The Reseller is entitled only to Commission accrued on amounts collected up to that date (net of any clawbacks), and to no further Commission on any Reseller Customer, even if that Customer keeps subscribing. There is no post-termination tail.',
      '10.5 Survival. Sections 8 and 9 (as to accrued amounts), 11, 12, 13, 14, 15, 16, and 17 survive termination.',
      '##11. Intellectual Property and Brand Licence',
      '11.1 Ownership. The Owner owns and retains all intellectual property in the Platform, its source code, documentation, and all product and brand names, logos, and marks (the "Marks"). Nothing transfers any ownership to the Reseller.',
      '11.2 Limited licence. During the Term, the Owner grants the Reseller a limited, revocable, non-exclusive, non-transferable licence to use the Marks and approved materials solely to market and refer the Platform under this Agreement.',
      '11.3 Restrictions. The Reseller will not modify, reverse engineer, decompile, or attempt to access the Platform\'s source code or administrative tooling, and will not register or use any confusingly similar mark or domain.',
      '11.4 Goodwill. All goodwill from the Reseller\'s use of the Marks inures to the Owner. The licence ends automatically on termination, and the Reseller will stop using the Marks and materials.',
      '##12. Data Protection, Privacy, and Data Sovereignty',
      '12.1 No access to Customer data. The Reseller will have no access to any Customer\'s data and will not collect, store, process, or export it.',
      '12.2 Data sovereignty (OCAP(R)). The Parties acknowledge that each Customer\'s data remains under that Customer\'s ownership and control, consistent with the principles of OCAP(R) (Ownership, Control, Access, and Possession) and the Platform\'s per-Customer data separation. Nothing in this Agreement gives the Reseller any right in Customer data.',
      '12.3 Privacy compliance. Each Party will comply with applicable privacy laws in performing this Agreement.',
      '12.4 Incident notice. If the Reseller becomes aware of any actual or suspected unauthorized access to Customer data or Owner systems, it will notify the Owner promptly.',
      '##13. Confidentiality',
      '13.1 Definition. "Confidential Information" means non-public information disclosed by one Party to the other that is marked or would reasonably be understood as confidential, including the Owner\'s pricing, product, customer, and technical information.',
      '13.2 Obligations. The receiving Party will use Confidential Information only to perform this Agreement, protect it with at least reasonable care, and not disclose it except to personnel who need it and are bound by similar obligations.',
      '13.3 Exclusions. Confidential Information does not include information that is public through no fault of the receiving Party, independently developed, or rightfully received from a third party.',
      '13.4 Return. On termination or request, the receiving Party will return or destroy Confidential Information.',
      '13.5 Duration. These obligations survive for ' + a.confidentiality_years + ' year' + (Number(a.confidentiality_years) === 1 ? '' : 's') + ' after termination; trade secrets and Customer data remain protected for as long as the law allows.',
      '##14. Non-Solicitation (No Non-Competition)',
      '14.1 Non-solicitation of Customers. During the Term and for ' + a.nonsolicit_months + ' months afterward, the Reseller will not solicit, divert, or attempt to take any Reseller Customer away from the Owner, or interfere with the Owner\'s direct relationship with any Customer.',
      '14.2 Non-solicitation of personnel. During the same period, the Reseller will not solicit for employment any of the Owner\'s staff or contractors involved in the Platform.',
      '14.3 No non-competition. For clarity, this Agreement contains no non-competition restriction. The Reseller may market and sell other products and services, provided it does not breach Sections 11-13 or this Section 14 and does not use the Owner\'s Confidential Information or Marks to do so.',
      '##15. Independent Contractor',
      'The Reseller is an independent contractor. Nothing in this Agreement creates an employment, partnership, joint-venture, or agency relationship, and neither Party may bind the other. The Reseller is responsible for its own taxes, expenses, tools, and personnel, and is not entitled to any employee benefits.',
      '##16. Warranties, Indemnification, and Limitation of Liability',
      '16.1 Mutual warranties. Each Party warrants that it has authority to enter into this Agreement and will comply with laws applicable to its performance.',
      '16.2 Reseller indemnity. The Reseller will defend and indemnify the Owner against claims arising from the Reseller\'s misrepresentations, unauthorized commitments, or breach of this Agreement.',
      '16.3 Owner indemnity. The Owner will defend and indemnify the Reseller against third-party claims that the Platform, as provided by the Owner, infringes that third party\'s intellectual property.',
      '16.4 Liability cap. Except for the indemnities, confidentiality, and a Party\'s wilful misconduct, each Party\'s total liability under this Agreement is limited to the total Commission paid or payable in the ' + a.liability_months + ' months before the claim.',
      '16.5 No indirect damages. Neither Party is liable for indirect, incidental, special, or consequential damages, or lost profits, even if advised of the possibility.',
      '##17. General Provisions',
      '17.1 Governing law. This Agreement is governed by the laws of ' + law + ' and the federal laws of Canada applicable there, without regard to conflict-of-laws rules.',
      '17.2 Disputes. The Parties will first try in good faith to resolve any dispute by negotiation. Failing that, it will be resolved by the courts of ' + law + ' (or, if the Parties agree in writing, by arbitration in ' + law + ').',
      '17.3 Assignment. The Reseller may not assign this Agreement without the Owner\'s written consent. The Owner may assign it to an affiliate or in connection with a sale of its business or the Platform.',
      '17.4 Entire agreement. This Agreement is the entire agreement on its subject and supersedes prior discussions.',
      '17.5 Amendments and waiver. Any amendment must be in writing and signed by both Parties. A waiver is effective only if in writing.',
      '17.6 Notices. Notices must be in writing and sent to the addresses in Section 1 (or as updated in writing), by hand, courier, or email with confirmation.' + (o.email || r.email ? ' Notice email: Owner ' + (o.email || '-') + '; Reseller ' + (r.email || '-') + '.' : ''),
      '17.7 Severability. If any provision is unenforceable, the rest remains in effect and the provision is limited to the minimum extent needed.',
      '17.8 Force majeure. Neither Party is liable for delay or failure caused by events beyond its reasonable control.',
      '17.9 Counterparts and electronic signature. This Agreement may be signed in counterparts and by electronic signature, each an original.',
      '##18. Signatures',
      'Each person signing below represents that they are authorized to bind the Party for whom they sign.',
      '',
      '###' + K().partyName(o).replace(/"/g, '') + ' (Owner)',
      'Signature: ______________________________',
      'Name: ' + (a.owner_sign_name || '____________________') + '     Title: ' + (a.owner_sign_title || '____________________') + '     Date: ' + (a.owner_signed_date ? fmtLong(a.owner_signed_date) : '______________'),
      '',
      '###' + K().partyName(r).replace(/"/g, '') + ' (Reseller)',
      'Signature: ______________________________',
      'Name: ' + (a.reseller_sign_name || '____________________') + '     Title: ' + (a.reseller_sign_title || '____________________') + '     Date: ' + (a.reseller_signed_date ? fmtLong(a.reseller_signed_date) : '______________'),
      (r.gst_hst_registered && r.gst_hst_number ? 'Reseller GST/HST number: ' + r.gst_hst_number : ''),
      '##Schedule A - Net Revenue and Commission: Worked Example',
      'Illustrative only, using sample numbers for one Reseller Customer in one month (CAD).',
      '-Subscription Fees collected (Gross Revenue): ' + fmt2(exGross),
      '-Less: hosting and infrastructure attributable to the Customer: (' + fmt2(exHost) + ')',
      '-Less: payment-processing and bank fees: (' + fmt2(exProc) + ')',
      '-Less: taxes, refunds, chargebacks, and credits: (0.00)',
      '-Net Revenue: ' + fmt2(exNet),
      '-Commission at ' + rate + '% of Net Revenue: ' + fmt2(exCom),
      'The Owner\'s direct support and implementation labor is not deducted. Actual figures depend on real costs and amounts collected.');
    return L.filter(function(x){ return x !== ''; }).join('\n').replace(/\n###/g, '\n\n###');
  }
  window.rsAgreementPdf = function(id){
    var a = agreement(id); if (!a) return;
    if (a.status === 'draft'){ var f = collectAgreementForm(); a = Object.assign({}, a, f); }
    K().setMsg('rs-a-sig-msg', 'Generating…', 'ok');
    K().ensureJsPdf(function(){
      try {
        var doc = K().renderMarkerPdf(resellerContractText(a), 'Reseller Commission Agreement ' + a.agreement_number, function(h){ return h.indexOf('18. Signatures') === 0 || h.indexOf('Schedule A') === 0; });
        var r = reseller(a.reseller_id) || {};
        openPdf(doc, a.agreement_number + '_' + String(r.legal_name || 'reseller').replace(/[^a-z0-9]+/gi, '_') + (a.status === 'draft' ? '_DRAFT' : '') + '.pdf', 'rs-a-sig-msg');
        K().audit('reseller_agreement_pdf', a.agreement_number, a.status);
      } catch (e){ K().setMsg('rs-a-sig-msg', 'Could not generate: ' + String(e && e.message || e)); }
    }, function(){ K().setMsg('rs-a-sig-msg', 'Could not load the PDF generator (offline?).'); });
  };

  window.rsStatementPdf = function(){
    if (S.stmt && S.stmt.status === 'draft') readStatementForm();
    var st = S.stmt; if (!st) return;
    var a = agreement(st.agreement_id), r = reseller(a.reseller_id) || {}, o = a.owner_snapshot || S.owner || {};
    K().ensureJsPdf(function(){
      try {
        var jsPDF = window.jspdf.jsPDF, doc = new jsPDF({ unit: 'pt', format: 'letter', orientation: 'landscape' });
        var M = 48, W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), y = M;
        function t(s, x, yy, op){ op = op || {}; doc.setFont('helvetica', op.style || 'normal'); doc.setFontSize(op.size || 10); var col = op.color || [20, 20, 20]; doc.setTextColor(col[0], col[1], col[2]); doc.text(String(s), x, yy, op.align ? { align: op.align } : undefined); }
        t(K().partyName(o).replace(/"/g, ''), M, y, { style: 'bold', size: 15 });
        t('COMMISSION STATEMENT', W - M, y, { style: 'bold', size: 16, align: 'right', color: [120, 120, 120] });
        y += 15; t(K().fmtPartyAddress(o), M, y, { size: 9, color: [110, 110, 110] });
        t(fmtMonth(st.period_month) + (st.status === 'draft' ? '  (DRAFT)' : ''), W - M, y, { size: 11, align: 'right' });
        y += 12; if (o.email || o.phone) t([o.phone, o.email].filter(Boolean).join('   ·   '), M, y, { size: 9, color: [110, 110, 110] });
        y += 18; doc.setDrawColor(220); doc.line(M, y, W - M, y); y += 18;
        t('RESELLER', M, y, { style: 'bold', size: 9, color: [120, 120, 120] }); t('DETAILS', W - 260, y, { style: 'bold', size: 9, color: [120, 120, 120] }); y += 14;
        t(K().partyName(r).replace(/"/g, ''), M, y, { style: 'bold', size: 11 }); t('Agreement: ' + a.agreement_number, W - 260, y); y += 13;
        t(K().fmtPartyAddress(r), M, y, { size: 9, color: [110, 110, 110] }); t('Commission rate: ' + Number(st.commission_rate) + '% of Net Revenue', W - 260, y); y += 13;
        t('Payment due: ' + (st.due_date || ''), W - 260, y); if (st.issued_date) { y += 13; t('Issued: ' + st.issued_date, W - 260, y); }
        y += 24;
        var cols = [{ l: 'Customer', x: M }, { l: 'Gross collected', x: M + 270, r: 1 }, { l: 'Hosting', x: M + 345, r: 1 }, { l: 'Processing', x: M + 420, r: 1 },
          { l: 'Taxes', x: M + 485, r: 1 }, { l: 'Refunds', x: M + 550, r: 1 }, { l: 'Net revenue', x: M + 625, r: 1 }, { l: 'Commission', x: W - M, r: 1 }];
        doc.setFillColor(245, 245, 242); doc.rect(M - 6, y - 12, W - M * 2 + 12, 20, 'F');
        cols.forEach(function(cl){ t(cl.l, cl.x, y, { style: 'bold', size: 8.5, color: [90, 90, 90], align: cl.r ? 'right' : undefined }); });
        y += 20;
        (st.lines || []).forEach(function(l){
          if (y > H - 150){ doc.addPage(); y = M; }
          t(l.name, M, y, { size: 10 });
          [l.gross, l.hosting, l.processing, l.taxes, l.refunds, l.net, l.commission].forEach(function(val, i){ t(money(val), cols[i + 1].x, y, { size: 10, align: 'right' }); });
          var inv = (l.invoices || []).map(function(x){ return x.number + ' (' + x.paid_date + ')'; }).join(', ');
          if (inv){ y += 11; doc.splitTextToSize('Invoices: ' + inv, 270).forEach(function(ln){ t(ln, M, y, { size: 7.5, color: [120, 120, 120] }); y += 9; }); y -= 9; }
          y += 16;
        });
        if (!(st.lines || []).length){ t('No registered customers with collected Subscription Fees this month.', M, y, { size: 10, color: [110, 110, 110] }); y += 16; }
        doc.setDrawColor(225); doc.line(W - M - 330, y, W - M, y); y += 16;
        var tot = function(lab, val, b){ t(lab, W - M - 100, y, { size: b ? 11 : 10, align: 'right', style: b ? 'bold' : 'normal' }); t(val, W - M, y, { size: b ? 11 : 10, align: 'right', style: b ? 'bold' : 'normal' }); y += b ? 18 : 15; };
        tot('Net revenue', money(st.net_revenue)); tot('Commission', money(st.commission));
        if (Number(st.clawback)) tot('Less clawback / offset' + (st.clawback_note ? ' (' + st.clawback_note + ')' : ''), '-' + money(st.clawback));
        tot(st.amount_due < 0 ? 'Carried forward to next statement' : 'Amount due to Reseller', money(st.amount_due), true);
        if (r.gst_hst_registered && st.amount_due > 0){
          var hst = r2(st.amount_due * (Number(r.hst_rate) || 0) / 100);
          tot('Plus HST ' + Number(r.hst_rate) + '% (on Reseller\'s invoice)', money(hst)); tot('Reseller invoice total', money(st.amount_due + hst), true);
        }
        if (st.status === 'paid'){ y += 4; t('PAID ' + (st.paid_date || '') + (st.payment_ref ? '  ·  ref ' + st.payment_ref : '') + (st.reseller_invoice_number ? '  ·  Reseller invoice ' + st.reseller_invoice_number : ''), W - M, y, { style: 'bold', size: 10, align: 'right', color: [21, 128, 61] }); y += 16; }
        if (st.notes){ y += 6; t('Notes', M, y, { style: 'bold', size: 9, color: [120, 120, 120] }); y += 13; doc.splitTextToSize(String(st.notes), W - M * 2).forEach(function(ln){ t(ln, M, y, { size: 9.5 }); y += 12; }); }
        if (y > H - 90){ doc.addPage(); y = M; }
        y += 10;
        ['Net Revenue = recurring Subscription Fees actually collected, less attributable hosting and infrastructure, payment-processing and bank fees, taxes, refunds, chargebacks and credits (Section 8). One-time fees are excluded (Section 7.3).',
         'Commission is reversed and offset for later refunds, chargebacks or uncollectible amounts (Section 9.2). The Reseller invoices the Owner for Commission and adds GST/HST if registered (Section 9.4). All amounts in CAD.'
        ].forEach(function(p){ doc.splitTextToSize(p, W - M * 2).forEach(function(ln){ t(ln, M, y, { size: 8, color: [110, 110, 110] }); y += 10; }); y += 3; });
        t('Reseller Commission Agreement ' + a.agreement_number + ' - statement ' + st.period_month.slice(0, 7), M, H - 24, { size: 8, color: [130, 130, 130] });
        openPdf(doc, 'Commission_' + a.agreement_number + '_' + st.period_month.slice(0, 7) + (st.status === 'draft' ? '_DRAFT' : '') + '.pdf', 'rs-s-msg');
      } catch (e){ K().setMsg('rs-s-msg', 'Could not generate: ' + String(e && e.message || e)); }
    }, function(){ K().setMsg('rs-s-msg', 'Could not load the PDF generator (offline?).'); });
  };

  // ---- Events (data-act; the panel CSP blocks inline handlers) ---------------
  document.addEventListener('click', function(e){
    var el = e.target && e.target.closest ? e.target.closest('[data-act^="rs-"]') : null;
    if (!el) return;
    var id = el.getAttribute('data-id') || '';
    switch (el.getAttribute('data-act')){
      case 'rs-refresh':          window.renderResellers(true); break;
      case 'rs-home':             go('home'); break;
      case 'rs-owner-save':       window.rsSaveOwner(); break;
      case 'rs-open-reseller':    go('reseller', id); break;
      case 'rs-reseller-save':    window.rsSaveReseller(id); break;
      case 'rs-reseller-del':     window.rsDeleteReseller(id); break;
      case 'rs-agr-new':          window.rsNewAgreement(id); break;
      case 'rs-open-agreement':   go('agreement', id); break;
      case 'rs-agr-save':         window.rsSaveAgreement(id); break;
      case 'rs-agr-activate':     window.rsActivate(id); break;
      case 'rs-agr-del':          window.rsDeleteAgreement(id); break;
      case 'rs-agr-pdf':          window.rsAgreementPdf(id); break;
      case 'rs-term-save':        window.rsSaveTermination(id); break;
      case 'rs-term-undo':        window.rsUndoTermination(id); break;
      case 'rs-cust-add':         window.rsAddCustomer(id); break;
      case 'rs-cust-status':      window.rsCustomerStatus(id, el.getAttribute('data-status') || ''); break;
      case 'rs-cust-link':        window.rsLinkCustomer(id); break;
      case 'rs-cust-del':         window.rsDeleteCustomer(id); break;
      case 'rs-stmt-open':        window.rsOpenStatement(id, el.getAttribute('data-month') || ''); break;
      case 'rs-stmt-save':        window.rsStatementSave(); break;
      case 'rs-stmt-issue':       window.rsStatementIssue(); break;
      case 'rs-stmt-unissue':     window.rsStatementUnissue(); break;
      case 'rs-stmt-pay':         window.rsStatementPay(); break;
      case 'rs-stmt-unpay':       window.rsStatementUnpay(); break;
      case 'rs-stmt-rebuild':     window.rsStatementRebuild(); break;
      case 'rs-stmt-del':         window.rsStatementDelete(); break;
      case 'rs-stmt-pdf':         window.rsStatementPdf(); break;
    }
  });
  document.addEventListener('input', function(e){
    var t = e.target; if (!t || !t.closest || !t.closest('#rs-stmt')) return;
    if (t.classList.contains('st-in') || t.id === 'rs-s-clawback') refreshStatementTotals();
  });
  document.addEventListener('change', function(e){
    var t = e.target; if (!t) return;
    if (t.id === 'rs-t-type' || t.id === 'rs-t-notice') calcTermEffective();
    if (t.id === 'rs-link-sel') S._linkPick = t.value;   // read before the dialog closes
  });
})();
