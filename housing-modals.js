/* ============================================================
 * housing-modals.js — CLFN Housing Suite
 * All modal open/close/save handlers for housing.html
 *
 * Load order: ... housing-settings.js → THIS FILE
 *
 * Covers:
 *   Unit edit modal (openUnitEditModal, saveUnitEdit, closeUnitEditModal)
 *   SOW modal (openSowModal, saveSOW, markSowComplete, reopenSow)
 *   Unit edit modal — also the only unit view (openUnitEditModal, udpRenderSowTable)
 *   Add unit modal (openAddUnitModal, saveNewUnit)
 *   Add tenant modal (openAddTenantModal, saveAddTenant)
 *   Tenant/contractor detail panels
 *   Scorecard (openMatchScorecard, printScorecard)
 *   Contractor search (openContractorSearch, contractorSearchFilter)
 *   Photo management (renderUnitPhotos, saveUnitPhotos)
 * ============================================================ */

'use strict';

function openContractorSearch(preserveQuery) {
  var m = document.getElementById('contractorSearchModal');
  if(m){ m.style.setProperty('display','flex','important'); document.body.classList.add('modal-open'); }
  if(!preserveQuery) {
    contractorSearchFilter('');
    setTimeout(function(){ var i=document.getElementById('ct_search_input'); if(i){i.value='';i.focus();} }, 150);
  } else {
    var inp = document.getElementById('ct_search_input');
    contractorSearchFilter(inp ? inp.value : '');
  }
}

function closeContractorSearch() {
  var m = document.getElementById('contractorSearchModal');
  if(m) m.style.display='none';
  document.body.classList.remove('modal-open');
}

function contractorSearchFilter(q) {
  var contractors = window._contractors || [];
  var results = document.getElementById('ct_search_results');
  if(!results) return;

  var filtered = q.trim().length > 0
    ? contractors.filter(function(c){
        var qq = q.toLowerCase();
        return (c.name||'').toLowerCase().includes(qq)
          || (c.trade||'').toLowerCase().includes(qq)
          || (c.phone||'').toLowerCase().includes(qq)
          || (c.email||'').toLowerCase().includes(qq);
      })
    : contractors;

  if(!filtered.length) {
    results.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted);">'
      +'<div class="empty-icon-lg">🧰</div>'
      +'<div class="empty-title">'+(q.trim().length > 0 ? 'No contractors matching "'+escapeHtml(q)+'"' : 'No contractors added yet')+'</div>'
      +'<div class="empty-sub">'+( q.trim().length > 0 ? 'Try a different search.' : 'Use the button above to add your first contractor.')+'</div>'
      +'</div>';
    return;
  }

  results.innerHTML = filtered.map(function(c, i) {
    var idx = contractors.indexOf(c);
    var initials = (c.name||'?').split(' ').map(function(w){return w[0]||'';}).slice(0,2).join('').toUpperCase();
    return '<div style="background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:14px 16px;display:flex;align-items:center;gap:12px;cursor:pointer;transition:border-color .15s;"'
      +' onmouseover="this.style.borderColor=&quot;var(--yellow)&quot;"'  
      +' onmouseout="this.style.borderColor=&quot;var(--border)&quot;"'  
      +' onclick="closeContractorSearch();openAddContractorModal('+idx+')">'
      +'<div style="width:40px;height:40px;border-radius:10px;background:var(--dark);color:var(--yellow);font-size:14px;font-weight:800;display:flex;align-items:center;justify-content:center;flex-shrink:0;">'+escapeHtml(initials)+'</div>'
      +'<div style="flex:1;min-width:0;">'
        +'<div style="font-size:13px;font-weight:700;color:var(--text);margin-bottom:2px;">'+escapeHtml(c.name||'Unknown')+'</div>'
        +'<div class="js-lbl-sm">'+escapeHtml(c.trade||'General')+(c.phone?' · '+escapeHtml(formatPhone(c.phone)):'')+'</div>'
      +'</div>'
      +'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>'
      +'</div>';
  }).join('');
}

// Read-only mode for roles that can view but not edit unit records (currently
// field_employee — they still need to see the unit, its SOWs/work orders, and
// RFQs, since this modal is now the only unit view). Mirrors _rfqApplyReadOnly
// in rfq.js: disable inputs/selects/textareas/buttons except ones marked
// data-ue-keep (Cancel, the SOW button/section — field employees can still
// create/edit work orders).
function _ueApplyReadOnly(ro){
  window._ueReadOnly = ro;
  var modal = document.getElementById('unitEditModal');
  if(!modal) return;
  modal.classList.toggle('ue-readonly', ro);
  modal.querySelectorAll('input, select, textarea').forEach(function(c){
    if(c.closest('[data-ue-keep]')) return;
    if(ro){
      if(!c.hasAttribute('data-ro-was')) c.setAttribute('data-ro-was', c.disabled ? '1' : '0');
      c.disabled = true;
    } else if(c.hasAttribute('data-ro-was')){
      if(c.getAttribute('data-ro-was') === '0') c.disabled = false;
      c.removeAttribute('data-ro-was');
    }
  });
  modal.querySelectorAll('button').forEach(function(b){
    if(b.hasAttribute('data-ue-keep') || b.closest('[data-ue-keep]')) return;
    if(ro){
      if(!b.hasAttribute('data-ro-was')) b.setAttribute('data-ro-was', b.disabled ? '1' : '0');
      b.disabled = true;
    } else if(b.hasAttribute('data-ro-was')){
      if(b.getAttribute('data-ro-was') === '0') b.disabled = false;
      b.removeAttribute('data-ro-was');
    }
  });
  var banner = document.getElementById('ueReadOnlyBanner');
  if(ro && !banner){
    banner = document.createElement('div');
    banner.id = 'ueReadOnlyBanner';
    banner.style.cssText = 'background:var(--warn-amber-bg);color:var(--warn-amber-text);border:1px solid var(--warn-amber-border);border-radius:8px;padding:9px 14px;font-size:12px;font-weight:600;margin-bottom:12px;';
    banner.textContent = '🔒 View only — Field Employees cannot edit unit records, but can still manage Maintenance Requests.';
    var body = modal.querySelector('.tic-body');
    if(body) body.insertBefore(banner, body.firstChild);
  } else if(!ro && banner){
    banner.remove();
  }
}

// Tab switching for the Edit Unit card — mirrors _ticSwitchTab in
// housing-tic.js. All tab content is already rendered eagerly by
// openUnitEditModal regardless of which tab is active, so this is purely
// a show/hide toggle (no lazy re-render needed).
// ── Unit Notes tab (note log; mirrors the TIC Notes tab) ───────────────────
// Renders an "Add a Note" box + a reverse-chronological list of notes for the
// unit, using the same tenant-note visual design (author, timestamp, body).
// Notes are stored append-only in the unit_notes table (sbSaveUnitNote). Any
// legacy single-field note (u.notes) is shown read-only at the bottom.
function _udpUnitNoteHtml(n){
  var esc  = (typeof escapeHtml === 'function') ? escapeHtml : function(s){ return String(s==null?'':s); };
  var when = '';
  try { if(n.created_at) when = new Date(n.created_at).toLocaleString('en-CA'); } catch(e){ when = n.created_at || ''; }
  return '<div class="tic-note"><div class="tic-note-meta"><span class="tic-note-author">'
       + esc(n.author_name || 'Unknown') + '</span>' + (when ? ' &middot; ' + esc(when) : '') + '</div>'
       + '<div class="tic-note-body">' + esc(n.note_body || '') + '</div></div>';
}
function udpRenderUnitNotes(unitId){
  var mount = document.getElementById('ue_notes_mount');
  if(!mount) return;
  var esc = (typeof escapeHtml === 'function') ? escapeHtml : function(s){ return String(s==null?'':s); };
  window._ueNotesUnitId = unitId;
  mount.innerHTML =
      '<div class="tic-section"><div class="tic-section-h">Add a Note</div>'
    +   '<textarea id="ue_note_input" class="tic-textarea" placeholder="Type your note…"></textarea>'
    +   '<div class="tic-form-actions" style="margin-top:8px;"><button type="button" class="btn btn-primary" onclick="udpSaveUnitNote()">Add Note</button></div>'
    + '</div>'
    + '<div class="tic-section tic-section-spaced"><div class="tic-section-h">Notes &amp; History</div>'
    +   '<div id="ue_notes_list"><div class="tic-empty">Loading…</div></div>'
    + '</div>';
  var u = (typeof getAllUnits === 'function') ? getAllUnits().find(function(x){ return x && x.id === unitId; }) : null;
  var legacy = u && u.notes ? String(u.notes).trim() : '';
  function _render(notes){
    var list = document.getElementById('ue_notes_list');
    if(!list) return;
    var html = '';
    (notes || []).forEach(function(n){ html += _udpUnitNoteHtml(n); });
    if(legacy){
      html += '<div class="tic-note"><div class="tic-note-meta"><span class="tic-note-author">Legacy note</span></div>'
            + '<div class="tic-note-body">' + esc(legacy) + '</div></div>';
    }
    list.innerHTML = html || '<div class="tic-empty">No notes yet.</div>';
  }
  if(typeof sbLoadUnitNotes === 'function'){
    sbLoadUnitNotes(unitId).then(_render).catch(function(){ _render([]); });
  } else { _render([]); }
}
function udpSaveUnitNote(){
  var inp = document.getElementById('ue_note_input');
  var body = (inp && inp.value || '').trim();
  if(!body){ if(typeof showToast === 'function') showToast('Note cannot be empty.', { type:'error' }); return; }
  var unitId = window._ueNotesUnitId || _currentDetailUnitId;
  if(!unitId || typeof sbSaveUnitNote !== 'function') return;
  sbSaveUnitNote(unitId, body).then(function(added){
    if(!added) return;
    var list = document.getElementById('ue_notes_list');
    if(list){
      var empty = list.querySelector('.tic-empty');
      if(empty) list.innerHTML = '';
      list.insertAdjacentHTML('afterbegin', _udpUnitNoteHtml(added));
    }
    if(inp) inp.value = '';
    if(typeof showToast === 'function') showToast('Note added.', {type:'info'});
  });
}
window.udpRenderUnitNotes = udpRenderUnitNotes;
window.udpSaveUnitNote    = udpSaveUnitNote;

function _ueSwitchTab(name){
  var modal = document.getElementById('unitEditModal');
  if(!modal) return;
  var tabs = modal.querySelectorAll('.tic-tab');
  for(var i=0;i<tabs.length;i++){
    tabs[i].classList.toggle('tic-active', tabs[i].getAttribute('data-ue-tab') === name);
  }
  var panels = modal.querySelectorAll('.tic-panel');
  for(var j=0;j<panels.length;j++){
    panels[j].classList.remove('tic-active');
  }
  var p = document.getElementById('ue_panel_' + name);
  if(p) p.classList.add('tic-active');
}

// Derive a next-inspection-due default (last inspection + 12 months) when the
// unit has no explicit next-due stored. Keeps the Edit Unit modal's inspection
// dates in step with the unit's actual inspection history (annual cadence).
function _ueDeriveNextDue(u){
  if(!u || u.nextInspectionDue) return (u && u.nextInspectionDue) || '';
  var last = u.lastInspectionDate;
  if(!last) return '';
  var d = new Date(last + 'T00:00:00');
  if(isNaN(d.getTime())) return '';
  d.setMonth(d.getMonth() + 12);
  return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
}

// ── Placeholder renderers (to be built out) ──
function openUnitEditModal(unitId){
  var isFieldEmployee = (window.currentRole || '') === 'field_employee';
  var units = getAllUnits();
  var u = units.find(function(x){ return x.id === unitId; });
  if(!u){ showToast('Unit not found: ' + unitId, {type:'error'}); return; }
  window._editingUnitId    = unitId;
  window._currentDetailUnitId = unitId; // back-compat: udpNewSow(), renos.html, file-panel sync all key off this
  var set = function(id,val){ var el=document.getElementById(id); if(el) el.value=(val===null||val===undefined||val==='nan')?'':String(val); };
  set('ue_street',u.street); set('ue_num',u.num);
  set('ue_bathrooms',u.bathrooms); set('ue_type',u.type); set('ue_foundation',u.foundation);
  ueTypeChanged('ue');         // swap room options + show building name before setting bedrooms
  set('ue_bedrooms',u.bedrooms);
  set('ue_building_name', u.buildingName || '');
  set('ue_funder',u.funder); set('ue_phase',u.phase); set('ue_year',u.year);
  set('ue_major_reno_year', u.majorRenoYear != null ? u.majorRenoYear : '');
  set('ue_square_feet', u.squareFeet != null ? u.squareFeet : '');
  set('ue_dept_number', u.deptNumber);
  set('ue_cmhc_value', u.cmhcValue);
  set('ue_acct_number', u.acctNumber);
  set('ue_hydro_meter', u.hydro_meter_number);
  set('ue_gas_meter',   u.gas_meter_number);
  ueFunderChanged();
  set('ue_constructionCost', (u.constructionCost != null ? u.constructionCost : (u.construction_cost != null ? u.construction_cost : '')));
  set('ue_rent', (u.monthlyRent != null ? u.monthlyRent : (u.monthly_rent != null ? u.monthly_rent : '')));
  _gateRentInput('ue_rent');
  _ueSetEmrField(u);                      // auto-fills from the Settings rent table by bedroom count
  // (ue_est_market_rent is read-only derived — no rent-authority gate needed,
  // and _gateRentInput would clobber its derivation tooltip.)
  _ueSetStatus(u.status||'vacant');
  _ueSetUnderRenovation(!!u.under_renovation);
  set('ue_assignedDate',u.assignedDate);
  set('ue_last_inspection', u.lastInspectionDate || '');
  // Next-due pre-populates from the unit's inspection history: use the stored
  // value if set, else derive last-inspection + 1yr (annual cadence) so a unit
  // that's only ever had a last-inspection date still shows a sensible due date.
  set('ue_next_inspection', u.nextInspectionDue || _ueDeriveNextDue(u));
  set('ue_notes',u.notes);
  // Populate hidden assignment fields
  var toEl = document.getElementById('ue_assignedTo');
  var nmEl = document.getElementById('ue_assignedName');
  if(toEl) toEl.value = u.assignedTo||'';
  if(nmEl) nmEl.value = u.assignedName||'';
  // Show current tenant card or clear search
  var srch = document.getElementById('ue_tenant_search');
  if(srch) srch.value='';
  var curCard = document.getElementById('ue_current_tenant');
  var curName = document.getElementById('ue_current_tenant_name');
  var curMeta = document.getElementById('ue_current_tenant_meta');
  var selCard = document.getElementById('ue_tenant_selected');
  var nfCard  = document.getElementById('ue_tenant_notfound');
  if(selCard) selCard.style.display='none';
  if(nfCard)  nfCard.style.display='none';
  if(u.assignedName && u.assignedTo){
    if(curCard) curCard.style.display='block';
    if(curName) curName.textContent = u.assignedName;
    var linkedApp = (typeof applications!=='undefined'?applications:[]).find(function(a){return a.id===u.assignedTo;});
    var meta = u.assignedTo;
    if(linkedApp){ meta += ' · ' + (linkedApp.status||'').replace(/_/g,' '); }
    if(curMeta) curMeta.textContent = meta;
  } else {
    if(curCard) curCard.style.display='none';
  }
  // Tenant Card header button — only meaningful when a tenant is assigned.
  var tenantBtn = document.getElementById('ue_tenant_btn');
  if(tenantBtn) tenantBtn.style.display = (u.assignedName && u.assignedTo) ? '' : 'none';
  // (removed) Redundant tenant display card population — the duplicate Tenant
  // section in #ue_sig_section was removed; tenant info lives in #ue_assign_row.
  var acc=document.getElementById('ue_accessible'); if(acc) acc.checked=!!u.accessible;
  var eld=document.getElementById('ue_isElders');   if(eld) eld.checked=!!u.isElders;
  var atype=document.getElementById('ue_assignment_type'); if(atype) atype.value=u.assignmentType||'';
  var title=document.getElementById('ue_modal_title'); if(title) title.textContent=u.num+' '+u.street;
  // Hero subtitle + info strip (mirrors the TIC hero/strip layout)
  var heroSub = [_roomBedLabel(u), (u.bathrooms&&u.bathrooms!=='nan')?u.bathrooms+' bath':'', _fmtUnitType(u.type)||''].filter(Boolean).join(' · ');
  setText('ue_hero_sub', heroSub);
  var _ueStatusLabels = { vacant:'Vacant', occupied:'Occupied', reserved:'Reserved', condemned:'Condemned' };
  setText('ue_strip_status',    _ueStatusLabels[u.status] || (u.status || '—'));
  setText('ue_strip_bedrooms',  (u.bedrooms != null && u.bedrooms !== '') ? String(u.bedrooms) : '—');
  setText('ue_strip_bathrooms', (u.bathrooms && u.bathrooms !== 'nan') ? String(u.bathrooms) : '—');
  setText('ue_strip_type',      _fmtUnitType(u.type) || '—');
  setText('ue_strip_funder',    _fmtFunder(u.funder) || 'Band');
  var _ueRentVal = (u.monthlyRent != null ? u.monthlyRent : u.monthly_rent);
  setText('ue_strip_rent', (_ueRentVal != null && _ueRentVal !== '') ? ('$' + Number(_ueRentVal).toLocaleString('en-CA', {minimumFractionDigits:0, maximumFractionDigits:2})) : '—');
  unitEditStatusChange();
  _ueCurrentUnitId = unitId;
  renderEditUnitPhotoPreview(unitId);
  _ueSwitchTab('overview');
  var _uem=document.getElementById('unitEditModal'); if(_uem){_uem.style.removeProperty('display');_uem.style.setProperty('display','flex','important');}
  // Scroll-collapse: shrink the info strip to icon-only once the tab body
  // scrolls, freeing space on tablet/mobile (shared-ui.js). _initScrollCollapse
  // is itself idempotent, so calling it on every open is safe.
  if(_uem && typeof _initScrollCollapse === 'function'){
    var _ueBody = _uem.querySelector('.tic-body');
    var _ueStrip = _uem.querySelector('.tic-strip');
    if(_ueBody && _ueStrip) _initScrollCollapse(_ueBody, _ueStrip);
  }

  // Restore saved unit signatures (HM / ED only — tenant block was removed
  // because the inputs duplicated u.assignedName/u.assignedDate and the snapshot
  // they wrote to (u.unitSig.tenant) was never read anywhere).
  var _set = function(id,val){ var e=document.getElementById(id); if(e&&val) e.value=val; };
  if(u.unitHmSig) {
    _set('ue_sig_hm_name',     u.unitHmSig.name);
    _set('ue_sig_hm_date',     u.unitHmSig.date);
    _set('ue_sig_hm_notes',    u.unitHmSig.notes);
    var _hd = document.getElementById('ue_sig_hm_decision');
    if(_hd && u.unitHmSig.decision) _hd.value = u.unitHmSig.decision;
    var _hb = document.getElementById('ue_sig_hm_badge');
    if(_hb && u.unitHmSig.decision) {
      _hb.textContent  = u.unitHmSig.decision === 'approved' ? 'Approved ✓' : u.unitHmSig.decision;
      _hb.style.background = u.unitHmSig.decision === 'approved' ? 'var(--success-bg)' : 'var(--info-blue-bg)';
      _hb.style.color      = u.unitHmSig.decision === 'approved' ? 'var(--success)' : '#1d4ed8';
    }
  }
  if(u.unitEdSig) {
    _set('ue_sig_ed_name',  u.unitEdSig.name);
    _set('ue_sig_ed_date',  u.unitEdSig.date);
    _set('ue_sig_ed_notes', u.unitEdSig.notes);
    var _ed = document.getElementById('ue_sig_ed_decision');
    if(_ed && u.unitEdSig.decision) _ed.value = u.unitEdSig.decision;
    var _eb = document.getElementById('ue_sig_ed_badge');
    if(_eb && u.unitEdSig.decision) {
      _eb.textContent  = u.unitEdSig.decision === 'approved' ? 'Approved ✓' : u.unitEdSig.decision;
      _eb.style.background = u.unitEdSig.decision === 'approved' ? 'var(--success-bg)' : 'var(--warn-amber-bg)';
      _eb.style.color      = u.unitEdSig.decision === 'approved' ? 'var(--success)' : 'var(--warn-amber-text)';
    }
  }

  // Archive / Restore button in footer — gated by archiveUnit authority
  var archWrap = document.getElementById('ue_archive_btn_wrap');
  if(archWrap) {
    var role = window.currentRole || 'housing_employee_l1';
    if(APPROVAL_AUTHORITY.can('archiveUnit', role)) {
      if(u.archived) {
        archWrap.innerHTML = '<button type="button" onclick="unarchiveUnit(\''+unitId.replace(/'/g,"\\'")+'\')" style="background:none;border:1.5px solid var(--muted);color:var(--muted);padding:6px 14px;border-radius:8px;cursor:pointer;font-size:12px;font-weight:700;font-family:DM Sans,sans-serif;display:flex;align-items:center;gap:6px;">📤 Restore Unit</button>';
      } else {
        archWrap.innerHTML = '<button type="button" onclick="archiveUnit(\''+unitId.replace(/'/g,"\\'")+'\')" style="background:none;border:1.5px solid var(--danger);color:var(--danger);padding:6px 14px;border-radius:8px;cursor:pointer;font-size:12px;font-weight:700;font-family:DM Sans,sans-serif;display:flex;align-items:center;gap:6px;">🏚️ Archive Unit</button>';
      }
    } else {
      archWrap.innerHTML = '';
    }
  }

  // Check budget routing
  setTimeout(ueUpdateBudgetRouting, 50);

  // Sections merged in from the removed Unit Detail Panel (Phase — single
  // unit view). Field employees get these too (read-only below) since this
  // modal is now the only way to see a unit's SOWs/RFQs/documents/history.
  udpRenderSowTable(unitId);
  if(typeof udpRenderRfqSection === 'function') udpRenderRfqSection(unitId);
  if(typeof udpRenderTenantHistory === 'function') udpRenderTenantHistory(unitId);
  udpRenderMap(u);
  if(typeof udpRenderFilePreviews === 'function') udpRenderFilePreviews(unitId);
  if(typeof udpRenderUnitNotes === 'function') udpRenderUnitNotes(unitId);

  _ueApplyReadOnly(isFieldEmployee);
  var saveBtn = document.getElementById('ue_save_btn');
  if(saveBtn) saveBtn.style.display = isFieldEmployee ? 'none' : '';
}
var _UE_BLDG_TYPES = ['admin_building', 'band_building', 'commercial_building'];
var _UE_ROOM_OPTS_BLDG = '<option value="0">0</option><option value="1">1</option><option value="2">2</option><option value="3">3</option><option value="4">4</option><option value="5">5</option><option value="6">6</option><option value="8">8</option><option value="10">10</option><option value="12">12</option><option value="15">15</option><option value="20">20</option><option value="25">25</option><option value="30">30</option>';
var _UE_ROOM_OPTS_RES  = '<option value="1">1</option><option value="2">2</option><option value="3">3</option><option value="4">4</option><option value="5">5</option><option value="6">6</option>';

function ueTypeChanged(prefix) {
  var p = prefix || 'ue';
  var type = (document.getElementById(p + '_type') || {}).value || '';
  var isBldg = _UE_BLDG_TYPES.indexOf(type) >= 0;

  // Show/hide building name field
  var nameRow = document.getElementById(p + '_building_name_row');
  if (nameRow) nameRow.style.display = isBldg ? '' : 'none';

  // Relabel Bedrooms ↔ Rooms
  var lbl = document.getElementById(p + '_bedrooms_label');
  if (lbl) lbl.textContent = isBldg ? 'Rooms' : 'Bedrooms';

  // Swap room-count options and restore current value
  var sel = document.getElementById(p + '_bedrooms');
  if (sel) {
    var cur = sel.value;
    sel.innerHTML = isBldg ? _UE_ROOM_OPTS_BLDG : _UE_ROOM_OPTS_RES;
    if (cur) sel.value = cur;
  }
}

function ueFunderChanged() {
  var funder  = (document.getElementById('ue_funder') || {}).value;
  var cmhcEl  = document.getElementById('ue_cmhc_value');
  if (!cmhcEl) return;
  var isCmhc  = (funder === 'CMHC_95');
  cmhcEl.disabled           = !isCmhc;
  cmhcEl.style.background   = isCmhc ? '' : 'var(--bg)';
  cmhcEl.style.color        = isCmhc ? '' : 'var(--muted)';
  cmhcEl.placeholder        = isCmhc ? 'e.g. 180000' : 'CMHC Section 95 only';
  if (!isCmhc) cmhcEl.value = '';
}

// ── Status pill helpers ───────────────────────────────────────────────────────
function ueStatusPillClick(val) {
  var inp = document.getElementById('ue_status');
  if (inp) inp.value = val;
  document.querySelectorAll('.ue-status-pill').forEach(function(b) {
    b.classList.toggle('active', b.getAttribute('data-status') === val);
  });
  unitEditStatusChange();
}

function ueRenoPillClick() {
  var chk = document.getElementById('ue_under_renovation');
  var pill = document.getElementById('ue_reno_pill');
  if (!chk || (pill && pill.classList.contains('ue-reno-locked'))) return;
  chk.checked = !chk.checked;
  if (pill) pill.classList.toggle('active', chk.checked);
}

function _ueSetStatus(val) {
  var inp = document.getElementById('ue_status');
  if (inp) inp.value = val || 'vacant';
  document.querySelectorAll('.ue-status-pill').forEach(function(b) {
    b.classList.toggle('active', b.getAttribute('data-status') === (val || 'vacant'));
  });
  unitEditStatusChange();
}

function _ueSetUnderRenovation(val) {
  var chk = document.getElementById('ue_under_renovation');
  var pill = document.getElementById('ue_reno_pill');
  if (chk) chk.checked = !!val;
  if (pill) pill.classList.toggle('active', !!val);
}

function unitEditStatusChange(){
  var status=(document.getElementById('ue_status')||{}).value||'';
  var row=document.getElementById('ue_assign_row');
  // Show tenant section for all statuses except condemned (or archived)
  var hideStatuses = ['archived','condemned'];
  if(row) row.style.display = hideStatuses.includes(status) ? 'none' : 'flex';
  // Condemned units cannot be under renovation — disable and uncheck
  var urChk = document.getElementById('ue_under_renovation');
  var pill  = document.getElementById('ue_reno_pill');
  if(status === 'condemned'){
    if(urChk) urChk.checked = false;
    if(pill){ pill.classList.remove('active'); pill.classList.add('ue-reno-locked'); }
  } else {
    if(pill){ pill.classList.remove('ue-reno-locked'); pill.classList.toggle('active', !!urChk && urChk.checked); }
  }
}
function closeUnitEditModal(opts){
  opts = opts || {};
  var _m = document.getElementById('unitEditModal');
  if(_m) _m.style.display='none';
  window._editingUnitId=null;
  // If this card was opened via a cross-page deep link (landing → Inventory
  // Approvals), a plain user close returns to the origin page. `opts.handoff`
  // is passed by internal callers that close the card only to open ANOTHER
  // modal (SOW / TIC / New Application) on this same page — those must NOT
  // navigate away, and they keep the flag armed for the next modal's close.
  if(window._ueDeepLinkReturn){
    window._ueDeepLinkReturn = false;   // clear on ANY close so it can't linger
    if(!opts.handoff && typeof _returnToNavReferrer === 'function' && _returnToNavReferrer()) return;
  }
}

// ── SOW link from edit unit modal ─────────────────────────────────────────────
function ueOpenSow() {
  var uid = window._editingUnitId;
  if(!uid) return;
  closeUnitEditModal({handoff:true});
  openSowModal(uid);
}

// Open the Tenant Information Card for the tenant assigned to this unit.
// The TIC only exists on housing.html + tenants.html, so on pages without it
// (inventory / match) we hand off to tenants.html, which already auto-opens a
// TIC from the ?tic=<unitId> deep-link (tenants-init.js).
function ueOpenTenantCard() {
  var uid = window._editingUnitId;
  if(!uid) return;
  if(typeof openTenantCard === 'function'){
    closeUnitEditModal({handoff:true});
    openTenantCard(uid);
  } else {
    window.location.href = 'tenants.html?tic=' + encodeURIComponent(uid);
  }
}
window.ueOpenTenantCard = ueOpenTenantCard;

// ── Maintenance QR (scan-to-report) ─────────────────────────────────────────
// Generate/print a per-unit QR that opens the public tenant maintenance-request
// form (report.html). The QR encodes the unit id + a per-unit secret token
// (stored in the unit's data jsonb) that the tenant-mr Edge Function validates.
function _qresc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];}); }
function _qrLoadLib(){
  return new Promise(function(resolve, reject){
    if (window.QRCode) return resolve();
    var s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
    s.onload = function(){ resolve(); };
    s.onerror = function(){ reject(new Error('QR library failed to load')); };
    document.head.appendChild(s);
  });
}
async function ueOpenMaintenanceQr(){
  var uid = window._editingUnitId;
  if(!uid) return;
  var units = getAllUnits();
  var u = units.find(function(x){ return x.id === uid; });
  if(!u){ showToast('Unit not found', {type:'error'}); return; }
  // Get or create the per-unit secret token (persists into the unit data jsonb).
  if(!u.qrToken){
    u.qrToken = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
      : (Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2));
    if(typeof saveUnitWithDraftFallback === 'function') saveUnitWithDraftFallback(u);
    else if(typeof sbSaveUnit === 'function') sbSaveUnit(u);
  }
  var addr   = ((u.num||'') + ' ' + (u.street||'')).trim();
  var nation = (window.NATION_CONFIG && (NATION_CONFIG.display_name || NATION_CONFIG.short)) || 'Housing';
  var _qrBase = (typeof nationPortalBase === 'function') ? nationPortalBase() : location.origin;
  var url    = _qrBase + '/report.html?u=' + encodeURIComponent(uid) + '&t=' + encodeURIComponent(u.qrToken);
  window._ueQrData = { url:url, addr:addr, nation:nation };

  var ex = document.getElementById('ue_qr_modal'); if(ex) ex.remove();
  var modal = document.createElement('div');
  modal.id = 'ue_qr_modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.72);z-index:10001;display:flex;align-items:center;justify-content:center;padding:16px;';
  modal.innerHTML =
      '<div style="background:var(--surface);border-radius:12px;width:100%;max-width:420px;box-shadow:0 8px 40px rgba(0,0,0,.35);overflow:hidden;">'
    + '<div class="modal-hdr"><div><div class="lbl-yellow">&#128295; Maintenance QR</div>'
    +   '<div class="txt-sm-meta">' + _qresc(addr) + '</div></div>'
    +   '<button type="button" onclick="var m=document.getElementById(\'ue_qr_modal\');if(m)m.remove();" style="background:none;border:none;font-size:22px;cursor:pointer;color:var(--muted);">&times;</button></div>'
    + '<div id="ue_qr_body" style="padding:22px;text-align:center;">'
    +   '<div id="ue_qr_canvas" style="display:inline-block;padding:14px;background:#fff;border:1px solid var(--border);border-radius:10px;"></div>'
    +   '<div style="font-size:12px;color:var(--muted);margin:14px 0 4px;">Tenants scan this to report a maintenance issue for this unit.</div>'
    +   '<div style="font-size:10px;color:var(--muted);word-break:break-all;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:6px 8px;margin-top:8px;">' + _qresc(url) + '</div>'
    + '</div>'
    + '<div style="padding:14px 22px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:10px;">'
    +   '<button type="button" onclick="ueCopyQrLink()" class="btn btn-ghost">Copy link</button>'
    +   '<button type="button" onclick="uePrintMaintenanceQr()" class="btn btn-primary">&#128424; Print</button>'
    + '</div></div>';
  document.body.appendChild(modal);
  try {
    await _qrLoadLib();
    var host = document.getElementById('ue_qr_canvas'); if(host){ host.innerHTML=''; new QRCode(host, { text:url, width:220, height:220, correctLevel: QRCode.CorrectLevel.M }); }
  } catch(e){
    var b = document.getElementById('ue_qr_body');
    if(b) b.innerHTML = '<div style="color:var(--danger);font-size:13px;padding:20px;">Could not load the QR generator. Check your connection and try again.</div>';
  }
}
function ueCopyQrLink(){
  var url = (window._ueQrData && window._ueQrData.url) || '';
  if(navigator.clipboard && url){ navigator.clipboard.writeText(url).then(function(){ showToast('Link copied', {type:'info'}); }); }
  else if(url){ showToast('Copy this link: ' + url, {type:'info'}); }
}
function uePrintMaintenanceQr(){
  var d = window._ueQrData || {};
  var host = document.getElementById('ue_qr_canvas');
  var el = host ? (host.querySelector('img') || host.querySelector('canvas')) : null;
  var src = '';
  try { src = el ? (el.tagName === 'IMG' ? el.src : el.toDataURL('image/png')) : ''; } catch(e){}
  var w = window.open('', '_blank', 'width=480,height=680');
  if(!w){ showToast('Allow pop-ups to print the QR', {type:'error'}); return; }
  w.document.write('<html><head><title>Maintenance QR</title><style>body{font-family:-apple-system,Segoe UI,sans-serif;text-align:center;padding:44px 20px;}h2{margin:0 0 2px;font-size:20px;}p{color:#555;margin:0 0 22px;font-size:13px;letter-spacing:.5px;text-transform:uppercase;}img{width:300px;height:300px;}.cap{margin-top:18px;font-size:17px;font-weight:800;}.hint{font-size:13px;color:#555;margin-top:8px;}</style></head><body>'
    + '<h2>' + _qresc(d.nation||'Housing') + '</h2><p>Maintenance Request</p>'
    + (src ? '<img src="' + src + '"/>' : '')
    + '<div class="cap">' + _qresc(d.addr||'') + '</div>'
    + '<div class="hint">Scan this code with your phone camera to report a maintenance issue for this unit.</div>'
    + '</body></html>');
  w.document.close();
  setTimeout(function(){ try{ w.focus(); w.print(); }catch(e){} }, 350);
}
window.ueOpenMaintenanceQr    = ueOpenMaintenanceQr;
window.ueCopyQrLink           = ueCopyQrLink;
window.uePrintMaintenanceQr   = uePrintMaintenanceQr;

// ── Budget threshold helpers ──────────────────────────────────────────────────
function getHmBudgetLimit() {
  // Default: HM can approve up to $25,000 unilaterally; above that needs ED
  try {
    var s = window._appSettings || {};
    return (s.hmBudgetLimit && parseFloat(s.hmBudgetLimit)) || 25000;
  } catch(e) { return 25000; }
}

function ueUpdateBudgetRouting() {
  // Read SOW total for this unit and set approval routing accordingly
  var uid = window._editingUnitId;
  if(!uid) return;

  var limit = getHmBudgetLimit();
  // Route on the LARGEST active, not-yet-approved Maintenance Request for the
  // unit — not just the most recently created one (getSowData). With multiple
  // open MRs, keying off "most recent" let a small follow-up request hide a
  // big earlier one still awaiting sign-off, collapsing the ED block.
  var maxPending = 0, maxActive = 0;
  var _sows = (typeof getUnitSowList === 'function') ? getUnitSowList(uid) : [];
  _sows.forEach(function(s){
    if (!s || s.cancelled || s.archived) return;
    var v = parseFloat(((s.totalCost != null ? s.totalCost : (s.amount != null ? s.amount : s.cost)) || '').toString().replace(/[^0-9.]/g, '')) || 0;
    if (v > maxActive) maxActive = v;
    if (s.approval_status !== 'ed_approved' && s.approval_status !== 'completed' && v > maxPending) maxPending = v;
  });
  // Pending requests drive the routing; if everything is already signed off,
  // keep showing the blocks for the largest active request so existing
  // signatures stay visible rather than collapsing.
  var totalCost = maxPending || maxActive;
  // Fallback for the legacy flat cache shape (getUnitSowList unavailable).
  if (!totalCost && !_sows.length) {
    var sowData = (typeof getSowData === 'function') ? getSowData(uid) : null;
    totalCost = sowData ? (parseFloat((sowData.totalCost||'').toString().replace(/[^0-9.]/g,''))||0) : 0;
  }

  var indicator = document.getElementById('ue_budget_indicator');
  var hmBlock   = document.getElementById('ue_sig_hm_block');
  var edBlock   = document.getElementById('ue_sig_ed_block');

  if(!totalCost) {
    if(indicator) indicator.style.display = 'none';
    if(hmBlock) hmBlock.style.display = 'none';
    if(edBlock) edBlock.style.display = 'none';
    return;
  }

  var overBudget = totalCost > limit;
  var fmtCost  = formatCurrency(totalCost);
  var fmtLimit = formatCurrency(limit);

  if(indicator) {
    indicator.style.display = 'block';
    if(overBudget) {
      indicator.style.background = 'var(--warn-amber-bg)';
      indicator.style.border = '1.5px solid var(--warn-amber-border)';
      indicator.style.color  = '#7a5c00';
      indicator.innerHTML = '<div class="flex-g8">'
        +'<span style="font-size:16px;">⚠️</span>'
        +'<div><strong>ED Approval Required</strong><br>'
        +'Maintenance Request total is <strong>'+fmtCost+'</strong> — exceeds the HM budget authority of '+fmtLimit+'.<br>'
        +'<span style="font-size:11px;">Executive Director must sign off before work begins.</span></div>'
        +'</div>';
    } else {
      indicator.style.background = 'var(--success-bg)';
      indicator.style.border = '1.5px solid #86efac';
      indicator.style.color  = 'var(--success)';
      indicator.innerHTML = '<div class="flex-g8">'
        +'<span style="font-size:16px;">✅</span>'
        +'<div><strong>HM Approval Sufficient</strong><br>'
        +'Maintenance Request total is <strong>'+fmtCost+'</strong> — within HM budget authority of '+fmtLimit+'.<br>'
        +'<span style="font-size:11px;">Housing Manager signature below is all that is required.</span></div>'
        +'</div>';
    }
  }

  // Show appropriate approval block
  if(hmBlock) hmBlock.style.display = 'block';
  if(edBlock) edBlock.style.display = overBudget ? 'block' : 'none';
}

// ── Unit edit sig pads removed (no signature canvases in unit edit form) ──


function saveUnitEdit(){
  // Field Employees (maintenance crew) view inventory but never edit unit
  // records (funder, budget, identity). Backstop in case the edit UI is reached.
  if((window.currentRole || '') === 'field_employee'){
    if(typeof showToast === 'function') showToast('Read-only — Field Employees cannot edit unit records.', {type:'error'});
    return;
  }
  var unitId=window._editingUnitId;
  var units=getAllUnits();
  var idx=units.findIndex(function(x){ return x.id===unitId; });
  if(idx===-1){ showToast('Unit not found', {type:'error'}); return; }
  var get=function(id){ var el=document.getElementById(id); return el?el.value.trim():''; };
  var chk=function(id){ var el=document.getElementById(id); return el?el.checked:false; };
  var u=units[idx];
  var prevAssignedTo = u.assignedTo || null;
  // Snapshot the full assignment cluster: u is the LIVE in-memory unit and is
  // mutated in place below BEFORE the approval gate runs. When the gate blocks
  // and returns, these must be rolled back — otherwise the poisoned in-memory
  // assignedTo made the NEXT save's "assignment changed?" check false, so a
  // second click sailed straight past the gate (e.g. linking a commercial
  // application from the unit card by just pressing Save twice).
  var prevAssignedName = u.assignedName || null;
  var prevAssignedDate = u.assignedDate || null;
  var prevStatusVal    = u.status || 'vacant';
  // Validate BEFORE the first u.* assignment: an early return after in-place
  // mutation leaves unsaved form values displayed (and persistable) as real —
  // the same poisoning the assignment-cluster rollback below guards against.
  var mryRaw = get('ue_major_reno_year');
  var mryN = null;
  if(mryRaw !== '' && mryRaw != null){
    mryN = parseInt(mryRaw, 10);
    if(isNaN(mryN) || mryN < 1800 || mryN > 2200){
      showToast('Major Renovation Year must be a valid year (e.g. 2015)', {type:'error'});
      return;
    }
  }
  u.street=get('ue_street')||u.street; u.num=get('ue_num')||u.num;
  u.bedrooms=parseInt(get('ue_bedrooms'))||u.bedrooms;
  u.bathrooms=get('ue_bathrooms'); u.type=get('ue_type'); u.foundation=get('ue_foundation');
  u.buildingName = get('ue_building_name') || null;
  u.funder=get('ue_funder'); u.phase=get('ue_phase'); u.year=get('ue_year');
  // Major renovation year — resets the effective age for the rent age factor.
  u.majorRenoYear = mryN;
  // Square footage — informational (buildings/facility records); rides the
  // data jsonb like every other unit field.
  var sfRaw = get('ue_square_feet');
  var sfN = (sfRaw === '' || sfRaw == null) ? null : Math.round(Number(sfRaw));
  u.squareFeet = (sfN != null && !isNaN(sfN) && sfN >= 0) ? sfN : null;
  u.deptNumber=get('ue_dept_number');
  u.acctNumber=get('ue_acct_number');
  u.hydro_meter_number = get('ue_hydro_meter') || null;
  u.gas_meter_number   = get('ue_gas_meter')   || null;
  var cmhcRaw = get('ue_cmhc_value');
  u.cmhcValue = (u.funder === 'CMHC_95' && cmhcRaw !== '') ? (Math.round(Number(cmhcRaw) * 100) / 100) : null;
  var ccRaw = get('ue_constructionCost');
  u.constructionCost = (ccRaw === '' || ccRaw == null) ? null : Math.round(Number(ccRaw) * 100) / 100;
  if(_canEditUnitRent()){
    var rentRaw = get('ue_rent');
    // Round to 2 dp on save so any floating-point drift from the number input
    // (e.g. 400 → 399.9999999 when the browser computes step grids) doesn't
    // get persisted.
    u.monthlyRent = (rentRaw === '' || rentRaw == null) ? null : Math.round(Number(rentRaw) * 100) / 100;
    // Estimated Rent — the field is a read-only DERIVED display (table rate
    // x age factor x payable %), never written back on save. A legacy
    // per-unit market override (estimatedMarketRent) is preserved as stored
    // and only changes via the "Clear market override" details action.
  }
  // Capture the prior status BEFORE the user's pick so we can detect a manual
  // status change. The auto-revert lifecycle (priorStatus, set when a SOW
  // approval flipped the unit to under_repair) must NOT survive a manual
  // status change — otherwise we'd later "revert" to a stale value the user
  // already overrode. Drop priorStatus whenever the user explicitly picks
  // any status other than under_repair.
  u.status=get('ue_status')||'vacant'; u.accessible=chk('ue_accessible'); u.isElders=chk('ue_isElders');
  u.assignmentType=get('ue_assignment_type')||'';
  u.under_renovation = u.status !== 'condemned' && chk('ue_under_renovation');
  u.lastInspectionDate = get('ue_last_inspection') || null;
  u.nextInspectionDue  = get('ue_next_inspection')  || null;
  u.notes=get('ue_notes');
  // HM approval
  var hmDec = (document.getElementById('ue_sig_hm_decision')||{}).value||'';
  if(get('ue_sig_hm_name') || hmDec) {
    u.unitHmSig = { name: get('ue_sig_hm_name'), date: get('ue_sig_hm_date'), decision: hmDec, notes: get('ue_sig_hm_notes'), savedAt: new Date().toISOString().split('T')[0] };
    // Update budget indicator badge
    var _hb = document.getElementById('ue_sig_hm_badge');
    if(_hb && hmDec) { _hb.textContent = hmDec==='approved'?'Approved ✓':hmDec; _hb.style.color = hmDec==='approved'?'var(--success)':'#1d4ed8'; }
  }
  // ED approval
  var edDec = (document.getElementById('ue_sig_ed_decision')||{}).value||'';
  if(get('ue_sig_ed_name') || edDec) {
    u.unitEdSig = { name: get('ue_sig_ed_name'), date: get('ue_sig_ed_date'), decision: edDec, notes: get('ue_sig_ed_notes'), savedAt: new Date().toISOString().split('T')[0] };
    var _eb = document.getElementById('ue_sig_ed_badge');
    if(_eb && edDec) { _eb.textContent = edDec==='approved'?'Approved ✓':edDec; _eb.style.color = 'var(--success)'; }
  }
  // Read from hidden fields (populated by tenant search)
  var toVal=(document.getElementById('ue_assignedTo')||{}).value||'';
  var nmVal=(document.getElementById('ue_assignedName')||{}).value||'';
  u.assignedTo=toVal; u.assignedName=nmVal;
  u.assignedDate=get('ue_assignedDate');
  // Belt-and-suspenders: if a tenant was selected but status is still vacant,
  // flip to 'occupied' so the vacant-clears-assignment guard below doesn't
  // silently wipe the selection (users used to lose tenants this way).
  if(u.assignedTo && u.status==='vacant'){
    u.status = 'occupied';
  }
  // If status is vacant or condemned, clear assignment
  if(u.status==='vacant'||u.status==='condemned'){
    u.assignedTo=null; u.assignedName=null; u.assignedDate=null;
  }
  // HM approval gate — must have at least mgr_approved to assign tenant.
  // Only runs when the assignment is actually being added or changed; saving
  // an already-assigned unit (e.g. just to update rent or notes) skips the gate.
  var assignmentChanged = (u.assignedTo || null) !== prevAssignedTo;
  if(assignmentChanged && u.assignedTo && (u.status==='occupied'||u.status==='reserved')) {
    var apps2 = typeof applications!=='undefined'?applications:[];
    var linkedApp2 = apps2.find(function(a){return a.id===u.assignedTo;});
    var role2 = window.currentRole||'housing_employee_l1';
    if(linkedApp2) {
      // Shared approval rule (appAssignabilityStatus) — same check the Match
      // queue, confirmAssignment and the Add-Tenant modal use, so the four
      // never drift. Any approved-flavour status is fine regardless of role;
      // ED can assign hm_approved file updates, HM can assign past ed_approved.
      var _as = (typeof appAssignabilityStatus === 'function')
        ? appAssignabilityStatus(linkedApp2, u, { forAssignment: true })
        : { ok:false, reason:'Approval required before assigning' };
      if(!_as.ok) {
        // Roll back the in-place assignment mutation so a repeat Save can't
        // slip past the gate via the "unchanged assignment" fast path.
        u.assignedTo   = prevAssignedTo;
        u.assignedName = prevAssignedName;
        u.assignedDate = prevAssignedDate;
        u.status       = prevStatusVal;
        showToast('⚠ ' + _as.reason, {type:'error'});
        return;
      }
      // Record who actually gated the assignment — the saver's real role, not
      // a forced ED/HM label (an L2 saving here used to be stamped "Housing
      // Manager", misattributing the sign-off).
      u.tenantApprovedBy = CLFN_PERMS.roleLabel(role2);
      u.tenantApprovedAt = new Date().toISOString().split('T')[0];
      // Commercial → building assignment from the unit card: carry the
      // cost-centre onto the building (never overwriting one already set) and
      // type the tenant row like the review modal's own assign path does.
      if((linkedApp2.appType || linkedApp2.app_type) === 'commercial'){
        if(linkedApp2.deptNumber && !u.deptNumber) u.deptNumber = linkedApp2.deptNumber;
        if(typeof sbTypeCommercialTenantForAssignment === 'function') sbTypeCommercialTenantForAssignment(linkedApp2, u);
      }
    }
  }
  // Save unit to Supabase
  saveUnitWithDraftFallback(u);
  // Sync assigned unit back onto the application record. Also flip status to
  // ASSIGNED so the applicant drops out of the Match queue (which filters by
  // status). Without this the same applicant keeps showing on the Match page
  // even though they're now housed.
  if(u.assignedTo) {
    var apps3 = typeof applications!=='undefined'?applications:[];
    var aIdx = apps3.findIndex(function(a){return a.id===u.assignedTo;});
    if(aIdx>=0){
      apps3[aIdx].assignedUnit    = u.id;
      apps3[aIdx].assignedAddress = (u.num+' '+u.street).trim();
      apps3[aIdx].status          = APP_STATUS.ASSIGNED;
      apps3[aIdx].assignedAt      = new Date().toISOString();
      saveApplicationWithDraftFallback(apps3[aIdx]);
    }
  }
  // If the unit had a different tenant before, return that prior application
  // to ed_approved so it isn't permanently stuck in 'assigned' state with no
  // unit. Skip if the prior tenant is the same as the new one (no-op edit).
  if(prevAssignedTo && prevAssignedTo !== u.assignedTo){
    var apps4 = typeof applications!=='undefined'?applications:[];
    var prevIdx = apps4.findIndex(function(a){return a.id===prevAssignedTo;});
    if(prevIdx>=0 && apps4[prevIdx].status === APP_STATUS.ASSIGNED){
      apps4[prevIdx].assignedUnit    = null;
      apps4[prevIdx].assignedAddress = null;
      apps4[prevIdx].status          = APP_STATUS.ED_APPROVED;
      saveApplicationWithDraftFallback(apps4[prevIdx]);
    }
  }
  // UNIT: prefix is required so shared-data.js auditEntry classifies the
  // entry as entity_type='unit' rather than defaulting to 'application'.
  auditEntry('UNIT:'+u.id,'unit_edit','Unit saved'+(u.assignedTo?' — tenant: '+u.assignedName:''),window.currentRole||'staff');
  closeUnitEditModal(); renderInventoryView();
  if(typeof updateDashStats==='function') updateDashStats();
  showToast('✓ Saved — '+u.num+' '+u.street, {type:'info'});
}


// ══════════════════════════════════════════════════════
// UNIT EDIT — Tenant Search Functions
// ══════════════════════════════════════════════════════

function ueTenantSearch(q) {
  var dd = document.getElementById('ue_tenant_dropdown');
  var nf = document.getElementById('ue_tenant_notfound');
  if (!dd) return;

  var apps = typeof applications !== 'undefined' ? applications : [];
  var role = window.currentRole || 'housing_employee_l1';

  // Show ed_approved to all roles; management also sees mgr_approved and
  // hm_approved — the SAME approved set the shared appAssignabilityStatus
  // rule accepts. hm_approved was missing here, so an HM-approved applicant
  // was "approved" everywhere else but invisible in this search.
  var eligible = apps.filter(function(a) {
    if (a.status === APP_STATUS.ED_APPROVED) return true;
    if (ROLE.isManagement(role) && (a.status === APP_STATUS.MGR_APPROVED || a.status === APP_STATUS.HM_APPROVED)) return true;
    return false;
  });

  var query = (q || '').trim().toLowerCase();
  var matches = query.length > 0
    ? eligible.filter(function(a) {
        var name = ((a.fn || '') + ' ' + (a.ln || '')).toLowerCase();
        return name.includes(query) || (a.id || '').toLowerCase().includes(query);
      })
    : eligible.slice(0, 10);

  // Hide "not found" card while typing
  if (nf) nf.style.display = 'none';

  if (!matches.length) {
    dd.innerHTML = '<div style="padding:12px 14px;font-size:12px;color:var(--muted);">No approved applications found'
      + (query.length > 1 ? ' matching "<strong>' + q + '</strong>"' : '')
      + '</div>'
      + '<div style="padding:10px 14px;border-top:1px solid var(--border);">'
      + '<button type="button" onmousedown="dd_showNotFound()" style="background:none;border:none;font-size:12px;font-weight:600;color:var(--yellow);cursor:pointer;font-family:DM Sans,sans-serif;padding:0;">📝 Start a new application instead →</button>'
      + '</div>';
    dd.style.display = 'block';
    return;
  }

  window._ueTenantMatches = {};
  dd.style.display = 'block';
  dd.innerHTML = matches.map(function(a) {
    var name = ((a.fn || '') + ' ' + (a.ln || '')).trim() || 'Unknown';
    var isED = a.status === APP_STATUS.ED_APPROVED;
    var isHMApp = a.status === APP_STATUS.HM_APPROVED;
    var statusLabel = isED ? 'ED Approved' : isHMApp ? 'HM Approved' : 'HM Recommended';
    var statusColor = (isED || isHMApp) ? 'var(--success)' : '#1d4ed8';
    var statusBg    = (isED || isHMApp) ? 'var(--success-bg)'  : 'var(--info-blue-bg)';
    window._ueTenantMatches[a.id] = {name: name, status: a.status};
    return '<div onmousedown="ueTenantSelectById(\''+a.id+'\')"'
      + ' style="padding:10px 14px;cursor:pointer;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:10px;"'
      + ' onmouseover="this.style.background=\'var(--bg)\'" onmouseout="this.style.background=\'none\'">' 
      + '<div>'
      + '<div class="js-txt-bold">' + escapeHtml(name) + '</div>'
      + '<div class="js-lbl-sm">' + escapeHtml(a.id)
        + (a.bedrooms ? ' · ' + escapeHtml(String(a.bedrooms)) + ' bed needed' : '') + '</div>'
      + '</div>'
      + '<span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px;background:' + statusBg + ';color:' + statusColor + ';white-space:nowrap;">' + statusLabel + '</span>'
      + '</div>';
  }).join('');
}

function dd_showNotFound() {
  var dd = document.getElementById('ue_tenant_dropdown');
  var nf = document.getElementById('ue_tenant_notfound');
  if (dd) dd.style.display = 'none';
  if (nf) nf.style.display = 'block';
}

function ueTenantSelectById(appId) {
  var match = (window._ueTenantMatches || {})[appId];
  if (!match) return;
  ueTenantSelect(appId, match.name, match.status);
}

function ueTenantSelect(appId, name, status) {
  // Hide dropdown
  var dd = document.getElementById('ue_tenant_dropdown');
  if (dd) dd.style.display = 'none';

  // Clear search box
  var srch = document.getElementById('ue_tenant_search');
  if (srch) srch.value = '';

  // Populate hidden fields
  var toEl = document.getElementById('ue_assignedTo');
  var nmEl = document.getElementById('ue_assignedName');
  if (toEl) toEl.value = appId;
  if (nmEl) nmEl.value = name;

  // Selecting a tenant on a vacant unit implies an occupancy. Auto-flip the
  // status so saveUnitEdit's vacant-clears-assignment guard doesn't wipe the
  // selection. User can still change to 'reserved' or other before saving.
  var statusEl = document.getElementById('ue_status');
  if (statusEl && (statusEl.value === 'vacant' || statusEl.value === '')) {
    statusEl.value = 'occupied';
    if (typeof unitEditStatusChange === 'function') unitEditStatusChange();
  }

  // Hide current tenant card (we're replacing it)
  var curCard = document.getElementById('ue_current_tenant');
  if (curCard) curCard.style.display = 'none';

  // Hide "not found" prompt
  var nf = document.getElementById('ue_tenant_notfound');
  if (nf) nf.style.display = 'none';

  // Show selected card
  var sel = document.getElementById('ue_tenant_selected');
  if (!sel) return;

  var isED      = status === APP_STATUS.ED_APPROVED;
  var isHMRec   = status === APP_STATUS.MGR_APPROVED;     // HM recommended → awaiting ED
  var isHMApp   = status === APP_STATUS.HM_APPROVED;      // HM final approval (file-update terminal)
  var isApprovedAtAll = isED || isHMRec || isHMApp;
  var statusLabel = (typeof formatAppStatusLabel === 'function') ? formatAppStatusLabel(status) : status.replace(/_/g,' ');
  var statusColor = isED ? 'var(--success)' : isHMApp ? 'var(--success)' : isHMRec ? '#1d4ed8' : 'var(--warn-amber-text)';
  var statusBg    = isED ? 'var(--success-bg)' : isHMApp ? 'var(--success-bg)' : isHMRec ? 'var(--info-blue-bg)' : 'var(--warn-amber-bg)';

  // Role-based warning
  var role = window.currentRole || 'housing_employee_l1';
  var warn = '';
  if (!isApprovedAtAll) {
    warn = '<div style="margin-top:8px;padding:8px 10px;background:var(--danger-bg);border-radius:6px;font-size:11px;color:var(--danger);font-weight:600;">⛔ This application has not been approved. Cannot assign tenant.</div>';
  } else if (isHMRec && APPROVAL_AUTHORITY.can('finalApproveApp', role)) {
    warn = '<div style="margin-top:8px;padding:8px 10px;background:var(--info-blue-bg);border-radius:6px;font-size:11px;color:var(--info-blue);">ℹ️ Recommended by Housing Manager — awaiting your final approval. You may proceed with assignment.</div>';
  }

  sel.style.display = 'block';
  sel.innerHTML = '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;">'
    + '<div>'
    + '<div style="font-size:13px;font-weight:700;">' + escapeHtml(name) + '</div>'
    + '<div class="js-lbl-sm" class="mt-4">' + escapeHtml(appId) + '</div>'
    + '</div>'
    + '<div class="flex-g8">'
    + '<span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px;background:' + statusBg + ';color:' + statusColor + ';">' + statusLabel + '</span>'
    + '<button type="button" onclick="ueClearTenantSelection()" style="background:none;border:1px solid var(--border);border-radius:5px;padding:3px 8px;font-size:11px;color:var(--muted);cursor:pointer;font-family:DM Sans,sans-serif;">✕</button>'
    + '</div>'
    + '</div>'
    + warn;
}

function ueClearTenantSelection() {
  var toEl = document.getElementById('ue_assignedTo');
  var nmEl = document.getElementById('ue_assignedName');
  if (toEl) toEl.value = '';
  if (nmEl) nmEl.value = '';
  var sel = document.getElementById('ue_tenant_selected');
  if (sel) { sel.style.display = 'none'; sel.innerHTML = ''; }
  var srch = document.getElementById('ue_tenant_search');
  if (srch) { srch.value = ''; srch.focus(); }
  var nf = document.getElementById('ue_tenant_notfound');
  if (nf) nf.style.display = 'none';
}

function _showMoveOutDialog(tenantName) {
  return new Promise(function(resolve) {
    var ov = document.createElement('div');
    ov.className = 'modal-overlay modal-overlay-centered modal-z-1100 is-open';
    var today = new Date().toISOString().split('T')[0];
    ov.innerHTML =
      '<div class="modal-body modal-body-sm">' +
        '<div class="modal-hdr">' +
          '<div class="modal-hdr-title">Remove Tenant</div>' +
          '<button type="button" class="btn-close-dark-30" data-cancel>&times;</button>' +
        '</div>' +
        '<div class="modal-body-stack">' +
          '<p class="txt-help m-0">Record move-out date for <strong>' + (tenantName || 'this tenant') + '</strong> before removing them. A history entry will be saved.</p>' +
          '<div style="margin-top:12px;">' +
            '<label style="font-size:11.5px;font-weight:600;color:var(--muted);display:block;margin-bottom:4px;">Move-Out Date</label>' +
            '<input type="date" id="_ue_moveout_input" value="' + today + '" style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--border);border-radius:7px;font-size:13px;font-family:DM Sans,sans-serif;background:var(--surface);color:var(--text);"/>' +
          '</div>' +
        '</div>' +
        '<div class="modal-footer">' +
          '<button type="button" class="btn btn-ghost" data-cancel>Cancel</button>' +
          '<button type="button" class="btn btn-danger" data-confirm>Remove Tenant</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);
    function getDate(){ var el = ov.querySelector('#_ue_moveout_input'); return el ? el.value : today; }
    function close(ok){
      var d = ok ? getDate() : null;
      if (ov.parentNode) ov.parentNode.removeChild(ov);
      resolve(d);
    }
    ov.querySelectorAll('[data-cancel]').forEach(function(b){ b.onclick = function(){ close(false); }; });
    ov.querySelector('[data-confirm]').onclick = function(){ close(true); };
    ov.addEventListener('click', function(e){ if (e.target === ov) close(false); });
  });
}

function _ueRemoveTenantFields() {
  var toEl = document.getElementById('ue_assignedTo');
  var nmEl = document.getElementById('ue_assignedName');
  var dtEl = document.getElementById('ue_assignedDate');
  if (toEl) toEl.value = '';
  if (nmEl) nmEl.value = '';
  if (dtEl) dtEl.value = '';
  var curCard = document.getElementById('ue_current_tenant');
  if (curCard) curCard.style.display = 'none';
  var srch = document.getElementById('ue_tenant_search');
  if (srch) { srch.value = ''; srch.focus(); }
  var sel = document.getElementById('ue_tenant_selected');
  if (sel) { sel.style.display = 'none'; sel.innerHTML = ''; }
  var statusEl = document.getElementById('ue_status');
  if (statusEl && statusEl.value === 'occupied') {
    _ueSetStatus('vacant');
  }
}

async function ueRemoveTenant() {
  var units = getAllUnits();
  var unitId = window._editingUnitId || window._ueCurrentUnitId;
  var u = unitId ? units.find(function(x){ return String(x.id) === String(unitId); }) : null;

  var tenantName  = (u && u.assignedName) || '';
  var tenantAppId = (u && u.assignedTo)   || '';
  var moveIn      = (u && u.assignedDate) || '';

  var moveOut = await _showMoveOutDialog(tenantName);
  if (moveOut === null) return;

  if (unitId && tenantName) {
    var addr = (u && u.num && u.street) ? (u.num + ' ' + u.street) : '';
    var durationDays = null;
    if (moveIn && moveOut) {
      var d1 = new Date(moveIn), d2 = new Date(moveOut);
      if (!isNaN(d1.getTime()) && !isNaN(d2.getTime())) {
        durationDays = Math.round((d2.getTime() - d1.getTime()) / 86400000);
      }
    }
    var actor = (window.HOUSING_SESSION && window.HOUSING_SESSION.email) || window.currentRole || 'staff';
    fetch(SUPABASE_URL + '/rest/v1/tenant_movement_log', {
      method: 'POST',
      headers: Object.assign({}, HOUSING_HEADERS, { 'Prefer': 'return=minimal' }),
      body: JSON.stringify({
        unit_id:       String(unitId),
        unit_address:  addr || null,
        tenant_name:   tenantName,
        application_id: tenantAppId || null,
        move_in_date:  moveIn || null,
        move_out_date: moveOut || null,
        duration_days: durationDays,
        recorded_by:   actor
      })
    }).catch(function(e){ console.warn('[tenantMovement] insert failed:', e); });
    auditEntry(tenantAppId || String(unitId), 'tenant_vacated',
      tenantName + ' vacated unit ' + (addr || unitId) + ' (move-out: ' + moveOut + ')', actor);
  }

  _ueRemoveTenantFields();
  showToast('Tenant removed — remember to Save Changes', {type:'info'});
}



function _initStep6DocLib() {
  var mount = document.getElementById('step6_doclib_mount');
  if (!mount || !window.DocLibrary) return;
  // currentAppId is set by saveApplicationRecord() in goTo() before this runs
  var appId = window.currentAppId || currentAppId;
  if (!appId && typeof generateAppId === 'function') {
    appId = generateAppId();
    currentAppId = appId;
    window.currentAppId = appId;
  }
  if (!appId) { console.warn('[DocLib] step6: no appId available'); return; }
  // Reuse the existing DocLib only when it was built for THIS specific app.
  // If the user opened a different app (editing an existing application), the
  // old lib still points to the previous app's storage path — reusing it would
  // silently upload files into the wrong application's folder.
  if (_step6DocLib && _step6DocLibAppId === appId) { _step6DocLib.refresh(); return; }
  // Different app or first mount — clear any stale DOM and recreate.
  mount.innerHTML = '';
  _step6DocLibAppId = appId;
  _step6DocLib = window.DocLibrary.create(mount, {
    entityType:    'application',
    entityId:      appId,
    pathPrefix:    'applications/' + appId,
    supabaseUrl:   SUPABASE_URL,
    supabaseAnon:  SUPABASE_ANON,
    storageBucket: STORAGE_BUCKET,
    getAuthToken:  function(){ return (window.HOUSING_HEADERS && window.HOUSING_HEADERS['Authorization'] || '').replace('Bearer ',''); },
    auditTable:    'housing_audit_log',
    getActor:      function(){ return (window.HOUSING_SESSION && window.HOUSING_SESSION.email) || window.currentRole || 'staff'; },
    categories:    [
      { key:'id',          label:'ID',              icon:'\uD83E\uDDFE' },
      { key:'income',      label:'Income / Pay',    icon:'\uD83D\uDCB0' },
      { key:'reference',   label:'Reference',       icon:'\uD83D\uDCDD' },
      { key:'housing_hist',label:'Housing History', icon:'\uD83C\uDFE0' },
      { key:'medical',     label:'Medical',         icon:'\u2695\uFE0F'  },
      { key:'migrated',    label:'Migrated',        icon:'\uD83D\uDCC2' },
      { key:'image',       label:'Image',           icon:'\uD83D\uDDBC\uFE0F' },
      { key:'other',       label:'Other',           icon:'\uD83D\uDCCE' }
    ],
    maxSizeMB:     25
  });
}

// Categories for application documents. Drive the upload picker + chips.
var _SCORECARD_APP_DOC_CATEGORIES = [
  { key:'id',          label:'ID',              icon:'\uD83E\uDDFE' },
  { key:'income',      label:'Income / Pay',    icon:'\uD83D\uDCB0' },
  { key:'reference',   label:'Reference',       icon:'\uD83D\uDCDD' },
  { key:'housing_hist',label:'Housing History', icon:'\uD83C\uDFE0' },
  { key:'medical',     label:'Medical',         icon:'\u2695\uFE0F'  },
  { key:'migrated',    label:'Migrated',        icon:'\uD83D\uDCC2' },
  { key:'image',       label:'Image',           icon:'\uD83D\uDDBC\uFE0F' },
  { key:'other',       label:'Other',           icon:'\uD83D\uDCCE' }
];

// Active factory instance — allows scSaveAssignedDocs to refresh the list
window._scDocsLib = null;

async function scLoadDocs(app) {
  var mount = document.getElementById('sc_docs_mount');
  if (!mount || !app) return;
  var appId = app.id || '';

  // Tear down any prior instance so we don't double-mount
  mount.innerHTML = '';
  if (!window.DocLibrary) {
    mount.innerHTML = '<div style="padding:16px;text-align:center;color:var(--muted);font-size:12px;">Document library unavailable.</div>';
    return;
  }
  var canDelete = (ROLE.isManagement(window.currentRole));

  window._scDocsLib = window.DocLibrary.create(mount, {
    entityType:    'application',
    entityId:      appId,
    pathPrefix:    'applications/' + appId,
    supabaseUrl:   SUPABASE_URL,
    supabaseAnon:  SUPABASE_ANON,
    storageBucket: STORAGE_BUCKET,
    getAuthToken:  function(){ return (window.HOUSING_HEADERS && window.HOUSING_HEADERS['Authorization'] || '').replace('Bearer ',''); },
    auditTable:    'housing_audit_log',
    getActor:      function(){ return (window.HOUSING_SESSION && window.HOUSING_SESSION.email) || window.currentRole || 'staff'; },
    categories:    _SCORECARD_APP_DOC_CATEGORIES,
    readOnly:      true,  // Upload happens in step 6; scorecard is review-only
    customLoader:  async function() {
      var allFiles = [];
      // Primary: app_documents table (manually assigned)
      try {
        var r = await fetch(
          SUPABASE_URL + '/rest/v1/app_documents?app_id=eq.' + encodeURIComponent(appId) + '&order=added_at.asc',
          { headers: HOUSING_HEADERS }
        );
        if (r.ok) {
          var rows = await r.json();
          rows.forEach(function(row){
            allFiles.push({
              path:     row.file_path,
              name:     row.file_name,
              size:     row.file_size || 0,
              type:     row.file_type || '',
              category: 'migrated',
              addedAt:  (row.added_at || '').slice(0,10),
              addedBy:  row.added_by || '',
              docId:    row.id
            });
          });
        }
      } catch(e) { console.warn('app_documents load error:', e); }

      // Secondary: direct uploads to this app's folder
      try {
        var appFiles = await sbListFiles('applications/' + appId + '/');
        if (appFiles && appFiles.length) {
          appFiles.forEach(function(f){
            if (!f.name || f.name === '.emptyFolderPlaceholder') return;
            var fpath = 'applications/' + appId + '/' + f.name;
            if (!allFiles.find(function(x){ return x.path === fpath; })) {
              allFiles.push({
                path:     fpath,
                name:     f.name,
                size:     f.metadata ? f.metadata.size : 0,
                type:     f.metadata ? f.metadata.mimetype : '',
                category: 'other',
                addedAt:  (f.created_at || '').slice(0,10),
                addedBy:  ''
              });
            }
          });
        }
      } catch(e) { /* folder may not exist yet */ }

      // Category enrichment: read audit-log rows for this app so we can
      // apply the per-file category stored in details JSON at upload time.
      try {
        var audit = await sbLoadFileMeta('application', appId);
        if (Array.isArray(audit)) {
          var catByPath = {};
          audit.forEach(function(row){
            if (row.path && row.category) catByPath[row.path] = row.category;
          });
          allFiles.forEach(function(f){
            if (!f.docId && catByPath[f.path]) f.category = catByPath[f.path];
          });
        }
      } catch(e) { /* non-fatal */ }

      return allFiles;
    },
    customDelete: async function(file) {
      if (file.docId) {
        // app_documents row — remove the assignment only; the underlying
        // storage file (shared migrated folder) stays put.
        await fetch(
          SUPABASE_URL + '/rest/v1/app_documents?id=eq.' + encodeURIComponent(file.docId),
          { method:'DELETE', headers: HOUSING_HEADERS }
        );
      } else {
        // Direct upload: delete the storage object + write a tombstone
        // audit row. We intentionally keep the original file_uploaded
        // audit row so history is preserved.
        await sbDeleteFile(file.path);
        await fetch(SUPABASE_URL + '/rest/v1/housing_audit_log', {
          method:'POST',
          headers: Object.assign({}, HOUSING_HEADERS, { 'Prefer':'return=minimal' }),
          body: JSON.stringify({
            entity_type: 'application',
            entity_id:   String(appId),
            action:      'file_deleted',
            detail:      JSON.stringify({ path: file.path, name: file.name }),
            actor:       window.currentRole || 'staff',
            created_at:  new Date().toISOString()
          })
        });
      }
    }
  });

  // Wire the Assign Files button (scorecard-specific flow, stays outside factory)
  var assignBtn = document.getElementById('sc_assign_btn');
  if (assignBtn) {
    assignBtn.onclick = null;
    assignBtn.addEventListener('click', function(){ scShowAssignDocs(app); });
  }
}











// ══ IN-PAGE PRINT PANEL ══
// ══════════════════════════════════════════════════════════
// IN-PAGE PRINT PANEL
// ══════════════════════════════════════════════════════════
var _printPanelDoc = '';







// Close panel on Escape key
document.addEventListener('keydown', function(e) {
  if(e.key === 'Escape') closePrintPanel();
});

// ── Save ED adjustment ──
function saveEdAdjustment(){
  if(!APPROVAL_AUTHORITY.can('applyScoreAdjustment', window.currentRole)){ showToast('Only the Executive Director can apply adjustments.', {type:'error'}); return; }
  var app = window._currentScorecardApp;
  if(!app){ showToast('No application selected.', {type:'error'}); return; }
  var pts = parseInt((document.getElementById('sc_ed_adj_pts')||{}).value||0)||0;
  var reason = ((document.getElementById('sc_ed_adj_reason')||{}).value||'').trim();
  var notes  = ((document.getElementById('sc_ed_adj_notes')||{}).value||'').trim();
  var idx = applications.findIndex(function(a){ return a.id===app.id; });
  if(idx===-1){ showToast('Application not found', {type:'error'}); return; }
  applications[idx].edAdjustment   = pts;
  applications[idx].edAdjustReason = reason;
  applications[idx].edNotes        = notes;
  // Recompute score with adjustment
  if(typeof rescoreApplication === 'function') {
    rescoreApplication(applications[idx]);
  } else {
    // Simple fallback: add pts to existing score
    var bd = applications[idx].scoreBreakdown || {};
    bd.edAdjustment = pts;
    applications[idx].scoreBreakdown = bd;
    var base = Object.keys(bd).filter(function(k){return k!=='edAdjustment';})
      .reduce(function(sum,k){return sum+(bd[k]||0);},0);
    applications[idx].score = base + pts;
  }
  saveApplicationWithDraftFallback(applications[idx]);
  auditEntry(app.id, 'ed_adjustment', 'ED adjusted score by '+(pts>=0?'+':'')+pts+(reason?' — '+reason:''), CLFN_PERMS.roleLabel(ROLE.ED));
  // Update display
  window._currentScorecardApp = applications[idx];
  var scoreEl = document.getElementById('sc_score_total');
  if(scoreEl) scoreEl.textContent = applications[idx].score;
  var edSec = document.getElementById('sc_ed_section');
  var edCon = document.getElementById('sc_ed_content');
  if(edSec&&edCon&&(pts||notes)){
    edSec.style.display='block';
    edCon.innerHTML = (pts?'<div style="font-size:13px;margin-bottom:6px;"><strong>'+(pts>0?'+':'')+pts+' pts</strong>'+(reason?' — '+reason:'')+'</div>':'')+(notes?'<div class="js-txt-muted">'+notes+'</div>':'');
  }
  var msg=document.getElementById('sc_ed_save_msg');
  if(msg){msg.style.display='flex';setTimeout(function(){msg.style.display='none';},2000);}
  if(typeof _refreshAppViews==='function') _refreshAppViews();
  showToast('ED adjustment saved'+(pts?' ('+( pts>0?'+':'')+pts+' pts)':''), {type:'info'});
}

// ── User management (Settings > Users) ──


// ── Print Scorecard ──
function printScorecard(){
  var app=window._currentScorecardApp;if(!app)return;
  var name=((app.fn||'')+' '+(app.ln||'')).trim();
  var today=new Date().toLocaleDateString('en-CA');
  var bd=app.scoreBreakdown||{};var s=app.score||0;
  var logoSrc=(document.querySelector('.app-logo img')||{}).src||'';
  // Use V2 tier thresholds (ED-adjustable); fall back to defaults if not loaded yet.
  var _t = (typeof liveV2Tiers === 'object' && liveV2Tiers) ? liveV2Tiers : {critical:80, high:60, medium:40};
  var tierColor2 = s >= _t.critical ? '#14532d'
                 : s >= _t.high     ? '#1e3a5f'
                 : s >= _t.medium   ? 'var(--warn-amber-text)'
                 :                    '#b91c1c';
  var tierBg2    = s >= _t.critical ? '#f0fdf4'
                 : s >= _t.high     ? '#e8eef5'
                 : s >= _t.medium   ? 'var(--warn-amber-bg)'
                 :                    '#fef2f2';
  // V2 breakdown has a nested structure: sectionA.{urgent,health,...}, sectionB.{rent,condition,...}, arrears, edAdjustment.
  // Flatten it into a flat list of rows with friendly labels.
  var sA = bd.sectionA || {};
  var sB = bd.sectionB || {};
  var V2ROWS = [
    {section:'A', label:'Urgent Need / Displacement',    val:sA.urgent},
    {section:'A', label:'Health & Safety Risk',          val:sA.health},
    {section:'A', label:'Overcrowding',                  val:sA.overcrowding},
    {section:'A', label:'Household Composition',         val:sA.household},
    {section:'A', label:'Accessibility Need',            val:sA.accessibility},
    {section:'A', label:'Waitlist Duration',             val:sA.waitlist},
    {section:'B', label:'Rent Payment History',          val:sB.rent},
    {section:'B', label:'Unit Condition History',        val:sB.condition},
    {section:'B', label:'Tenancy Conduct',               val:sB.conduct},
    {section:'B', label:'Income Stability',              val:sB.income},
    {section:'C', label:'Arrears Deduction',             val:bd.arrears}
  ];
  var currentSection = '';
  var tableRows = V2ROWS.map(function(row){
    var v = (row.val === undefined || row.val === null) ? 0 : row.val;
    var col = v>0?'var(--success)':v<0?'var(--danger)':'var(--muted)';
    var sectionHdr = '';
    if(row.section !== currentSection) {
      currentSection = row.section;
      var sectLabel = row.section === 'A' ? 'Section A — Housing Need'
                   : row.section === 'B' ? 'Section B — Tenant Responsibility'
                   :                       'Section C — Arrears';
      sectionHdr = '<tr><td colspan="2" style="padding:10px 12px 4px;font-weight:700;font-size:10px;text-transform:uppercase;letter-spacing:.8px;color:var(--muted);background:var(--bg);border-top:1px solid var(--border);">'+sectLabel+'</td></tr>';
    }
    return sectionHdr + '<tr style="border-bottom:1px solid var(--border);"><td style="padding:8px 12px;font-weight:600;font-size:11px;">'+row.label+'</td><td style="padding:8px 12px;text-align:right;font-size:14px;font-weight:700;color:'+col+';">'+(v>0?'+':'')+v+'</td></tr>';
  }).join('');
  var edAdj=bd.edAdjustment||0;
  if(edAdj)tableRows+='<tr style="border-top:2px solid var(--yellow);"><td style="padding:8px 12px;font-weight:700;">ED Adjustment</td><td style="padding:8px 12px;text-align:right;font-size:14px;font-weight:700;color:'+(edAdj>0?'var(--success)':'var(--danger)')+'">'+(edAdj>0?'+':'')+edAdj+'</td></tr>';
  var doc='<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>Score Report — '+name+'</title>'
    +'<style>'+_printThemeStyles()+'*{box-sizing:border-box;margin:0;padding:0;}@page{size:letter;margin:16mm 14mm;}body{font-family:Arial,sans-serif;font-size:11px;color:var(--text);background:var(--surface);}.footer{position:fixed;bottom:8mm;left:0;right:0;padding:0 14mm;display:flex;justify-content:space-between;font-size:9px;color:var(--muted);border-top:1px solid var(--border);padding-top:5px;}</style>'
    +'</head><body>'
    +'<div style="display:flex;align-items:center;justify-content:space-between;border-bottom:3px solid var(--yellow);padding-bottom:12px;margin-bottom:16px;">'
    +'<div class="flex-g10">'+(logoSrc?'<img src="'+logoSrc+'" style="width:40px;height:40px;object-fit:contain;" alt="'+(window.NATION_CONFIG&&NATION_CONFIG.short||'')+'"/>':'')+'<div><div class="js-txt-lg">'+(window.NATION_CONFIG&&NATION_CONFIG.short||'')+' Housing — Score Report</div><div style="font-size:10px;color:var(--muted);">'+(window.NATION_CONFIG&&(NATION_CONFIG.display_name||NATION_CONFIG.name)||'')+'</div></div></div>'
    +'<div style="text-align:right;font-size:10px;color:var(--muted);line-height:1.7;"><strong style="font-size:12px;color:var(--text);">'+name+'</strong><br/>'+app.id+'<br/>Generated: '+today+'</div></div>'
    +'<div style="display:flex;align-items:center;gap:24px;background:var(--dark);border-radius:8px;padding:16px 20px;margin-bottom:16px;">'
    +'<div><div style="font-size:9px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--muted);margin-bottom:4px;">Total Score</div><div style="font-size:40px;font-weight:700;color:var(--yellow);line-height:1;">'+s+'</div></div>'
    +'<div style="width:1px;height:40px;background:var(--dark-border);"></div>'
    +'<div><div style="font-size:9px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--muted);margin-bottom:6px;">Priority Tier</div><div style="font-size:13px;font-weight:700;padding:6px 14px;border-radius:6px;background:'+tierBg2+';color:'+tierColor2+';">'+(app.tier||'—')+'</div></div>'
    +'<div style="flex:1;"><div style="font-size:9px;color:var(--muted);margin-bottom:4px;">Score Bar</div><div style="height:6px;background:var(--dark-border);border-radius:3px;overflow:hidden;"><div style="height:100%;width:'+Math.min(100,Math.max(0,Math.round((s/Math.max(100,(_t.critical||80)*1.25))*100)))+'%;background:'+tierColor2+';border-radius:3px;"></div></div></div></div>'
    +'<table style="width:100%;border-collapse:collapse;border:1px solid var(--border);margin-bottom:16px;">'
    +'<thead><tr style="background:var(--dark);border-bottom:2px solid var(--yellow);"><th style="padding:8px 12px;text-align:left;font-size:9px;text-transform:uppercase;letter-spacing:.7px;color:var(--muted);font-weight:700;">Category</th><th style="padding:8px 12px;text-align:right;font-size:9px;text-transform:uppercase;letter-spacing:.7px;color:var(--muted);font-weight:700;width:60px;">Score</th></tr></thead>'
    +'<tbody>'+tableRows+'</tbody>'
    +'<tfoot><tr style="background:var(--bg);border-top:2px solid var(--dark);"><td style="padding:10px 12px;font-weight:700;">Total</td><td style="padding:10px 12px;text-align:right;font-size:18px;font-weight:700;">'+(s>0?'+':'')+s+'</td></tr></tfoot></table>'
    +'<div class="footer"><span>'+escapeHtml(buildNationFooterStrip())+'</span><span>Generated '+today+'</span></div>'
  showPrintPanel(doc, 'Score Report');
}





// (previewFromDash removed — ~275-line print template with zero call sites;
// the live equivalent is printApplicationPreview in housing-app.js.)

function openMatchScorecard(appId, unitId) {
  var app  = (typeof applications !== 'undefined' ? applications : []).find(function(a){ return a.id===appId; });
  var allUnits = getAllUnits();
  var unit = allUnits.find(function(u){ return u.id===unitId; });
  if(!app || !unit) return;

  var modal = document.getElementById('matchScorecardModal');
  if(!modal) return;

  var appName  = ((app.fn||'')+' '+(app.ln||'')).trim();
  var unitAddr = unit.num+' '+unit.street;
  var age = app.dob ? Math.floor((new Date()-new Date(app.dob))/(365.25*24*3600*1000)) : null;
  var isElders  = age !== null && age >= 55;
  var needsBeds = 1;
  if(app.habitants) needsBeds = Math.max(1, 1+(app.coApp?1:0)+app.habitants.length);
  var needsAccess = app.accessibility && app.accessibility!=='None' && app.accessibility!=='0' && app.accessibility!==0;

  // Scoring breakdown
  var breakdown = [];
  var bedScore = 0;
  if(unit.bedrooms === needsBeds)     { bedScore=10; breakdown.push({label:'Bedroom fit (exact match)',    pts:10, max:10}); }
  else if(unit.bedrooms > needsBeds)  { bedScore=5;  breakdown.push({label:'Bedroom fit (larger than needed)', pts:5, max:10}); }
  else if(unit.bedrooms===needsBeds-1){ bedScore=3;  breakdown.push({label:'Bedroom fit (one short)',     pts:3, max:10}); }
  else                                { bedScore=0;  breakdown.push({label:'Bedroom fit (insufficient)',  pts:0, max:10}); }

  var accScore = 0;
  if(needsAccess && unit.accessible)  { accScore=8;  breakdown.push({label:'Accessibility (needs met)',   pts:8,  max:8}); }
  else if(needsAccess && !unit.accessible){ accScore=-4; breakdown.push({label:'Accessibility (unmet need)', pts:-4, max:8}); }
  else                                { breakdown.push({label:'Accessibility (not required)',             pts:0,  max:8}); }

  var eldScore = 0;
  if(isElders && unit.isElders)       { eldScore=6; breakdown.push({label:'Elders eligibility (matched)',  pts:6, max:6}); }
  else if(!isElders && unit.isElders) { eldScore=-2; breakdown.push({label:'Elders unit (not eligible)',   pts:-2, max:6}); }
  else if(isElders && !unit.isElders) { breakdown.push({label:'Elders eligible (standard unit)',           pts:0,  max:6}); }
  else                                { breakdown.push({label:'Elders (not applicable)',                   pts:0,  max:6}); }

  var total = bedScore + accScore + eldScore;
  var maxScore = 24;
  var pct = Math.round(Math.max(0,total)/maxScore*100);
  var tierColor = total>=16?'var(--success)':total>=10?'var(--warn-amber-text)':'var(--danger)';

  // Build rows
  var rows = breakdown.map(function(b){
    var col = b.pts > 0 ? 'var(--success)' : b.pts < 0 ? 'var(--danger)' : 'var(--gray)';
    var bar = Math.round(Math.max(0,b.pts)/b.max*100);
    return '<tr class="row-divider">'
      +'<td style="padding:10px 14px;font-size:13px;color:var(--text);">'+b.label+'</td>'
      +'<td style="padding:10px 14px;text-align:right;">'
        +'<div style="display:flex;align-items:center;gap:8px;justify-content:flex-end;">'
        +'<div style="height:4px;width:60px;background:var(--border);border-radius:3px;overflow:hidden;"><div style="height:100%;width:'+Math.max(0,bar)+'%;background:'+col+';border-radius:3px;"></div></div>'
        +'<span style="font-size:13px;font-weight:700;color:'+col+';">'+(b.pts>0?'+':'')+b.pts+'</span>'
        +'</td>'
      +'</tr>';
  }).join('');

  document.getElementById('msc_title').textContent   = 'Match Scorecard';
  document.getElementById('msc_app').textContent     = appName + ' (' + appId + ')';
  document.getElementById('msc_unit').textContent    = unitAddr;
  document.getElementById('msc_score').textContent   = total;
  document.getElementById('msc_pct').textContent     = pct + '% match';
  document.getElementById('msc_score').style.color   = tierColor;
  document.getElementById('msc_bar_fill').style.width = pct + '%';
  document.getElementById('msc_bar_fill').style.background = tierColor;
  document.getElementById('msc_rows').innerHTML = rows;

  // Summary flags
  var flags = [];
  if(needsAccess && !unit.accessible) flags.push('<span style="color:var(--danger);font-size:12px;">⚠ Unit does not meet accessibility needs</span>');
  if(!isElders && unit.isElders) flags.push('<span style="color:var(--danger);font-size:12px;">⚠ Applicant not eligible for Elders unit</span>');
  if(unit.bedrooms < needsBeds)  flags.push('<span style="color:var(--warn-amber);font-size:12px;">⚠ Unit has fewer bedrooms than needed</span>');
  if(total >= 14)                flags.push('<span style="color:var(--success);font-size:12px;">✓ Strong match — recommended for assignment</span>');
  document.getElementById('msc_flags').innerHTML = flags.join('<br>') || '<span class="js-txt-muted-sm">No issues flagged</span>';

  modal.style.removeProperty('display');
  modal.style.setProperty('display','flex','important');
}












// Module-level: which unit's detail panel is currently open. Read by SOW
// shortcut buttons, file-preview render, and the unit-edit handoff.
var _currentDetailUnitId = null;

function udpRenderMap(u) {
  var sec = document.getElementById('udp_map_section');
  if (!sec) return;
  var lat = u.latitude  != null ? parseFloat(u.latitude)  : null;
  var lng = u.longitude != null ? parseFloat(u.longitude) : null;
  var address = [u.num && u.street ? u.num + ' ' + u.street : '', u.city || ''].filter(Boolean).join(', ');
  var canSetLoc = typeof APPROVAL_AUTHORITY !== 'undefined'
    && APPROVAL_AUTHORITY.can('setUnitLocation', window.currentRole || '');
  var locBtn = canSetLoc
    ? '<button onclick="udpOpenLocationPicker(\'' + String(u.id).replace(/'/g, "\\'") + '\')" '
        + 'style="background:var(--yellow);border:1.5px solid var(--yellow);border-radius:7px;padding:5px 14px;'
        + 'font-size:11px;font-weight:700;color:#111110;cursor:pointer;font-family:DM Sans,sans-serif;white-space:nowrap;">'
        + (lat && lng ? '&#128205; Edit Location' : '&#128205; Set Location')
        + '</button>'
    : '';

  sec.innerHTML =
    '<div class="map-widget">' +
      '<div class="map-widget-header">' +
        '<span class="map-pin-icon">&#128205;</span>' +
        '<div>' +
          '<div class="map-widget-label">Unit Location</div>' +
          '<div class="map-widget-address" id="udp_map_address">' + (address || '&mdash;') + '</div>' +
        '</div>' +
        '<div style="margin-left:auto;">' + locBtn + '</div>' +
      '</div>' +
      '<div class="map-frame-wrap">' +
        '<iframe id="udp_map_iframe" class="map-frame" src="" allowfullscreen title="Unit location map"></iframe>' +
        '<div class="map-no-coords" id="udp_map_no_coords" style="display:none;">' +
          '<span>&#128205;</span>' +
          '<p>No coordinates set.' + (canSetLoc ? '<br>Use <strong>Set Location</strong> above to pin this unit.' : '') + '</p>' +
        '</div>' +
      '</div>' +
      '<div class="map-widget-footer">' +
        '<div class="map-coords" id="udp_map_coords">&#8212;</div>' +
        '<a class="map-osm-link" id="udp_map_link" href="#" target="_blank" rel="noopener" style="display:none;">Open in Map &#8599;</a>' +
      '</div>' +
    '</div>';

  var iframeEl = document.getElementById('udp_map_iframe');
  var noCrdEl  = document.getElementById('udp_map_no_coords');
  var coordEl  = document.getElementById('udp_map_coords');
  var linkEl   = document.getElementById('udp_map_link');

  if (!lat || !lng || isNaN(lat) || isNaN(lng)) {
    iframeEl.style.display = 'none';
    if (noCrdEl) noCrdEl.style.display = 'flex';
    if (coordEl) coordEl.textContent   = 'No coordinates set';
    return;
  }

  var OFFSET = 0.005;
  var bbox = [
    (lng - OFFSET).toFixed(6), (lat - OFFSET * 0.7).toFixed(6),
    (lng + OFFSET).toFixed(6), (lat + OFFSET * 0.7).toFixed(6)
  ].join('%2C');
  iframeEl.src = 'https://www.openstreetmap.org/export/embed.html'
    + '?bbox=' + bbox + '&layer=mapnik'
    + '&marker=' + lat.toFixed(7) + '%2C' + lng.toFixed(7);
  iframeEl.style.display = 'block';
  if (noCrdEl) noCrdEl.style.display = 'none';
  if (coordEl) coordEl.textContent   = lat.toFixed(5) + '° N  /  ' + Math.abs(lng).toFixed(5) + '° W';
  if (linkEl) {
    linkEl.href         = 'https://www.openstreetmap.org/?mlat=' + lat + '&mlon=' + lng + '&zoom=17';
    linkEl.style.display = 'inline-block';
  }
}

// ── Unit Card Location Picker ─────────────────────────────────────────────────
// Self-contained Leaflet picker scoped to inventory / unit card context.
// Parallels the TIC's SLP modal but lives here so inventory.html can use it
// without loading housing-tic.js.
var _udpLocMap    = null;
var _udpLocMarker = null;
var _udpLocLat    = null;
var _udpLocLng    = null;
var _udpLocUnitId = null;
var _udpLocWired  = false;
var _UDPLOC_CLFN_LAT = 49.8063;
var _UDPLOC_CLFN_LNG = -84.1434;

function udpOpenLocationPicker(unitId) {
  if (!unitId) return;
  var units = getAllUnits();
  var u = units.find(function(x){ return String(x.id) === String(unitId); });
  if (!u) return;
  _udpLocUnitId = unitId;
  _udpLocLat = u.latitude  ? parseFloat(u.latitude)  : null;
  _udpLocLng = u.longitude ? parseFloat(u.longitude) : null;

  _udpLocEnsureModal(function(overlay) {
    overlay.style.display = 'flex';
    _udpLocResetState(u);
    _udpLocInitMap(u);
  });
}

function _udpLocLoadScript(src, cb) {
  if (document.querySelector('script[src="' + src + '"]')) { cb(); return; }
  var s = document.createElement('script');
  s.src = src; s.onload = cb;
  s.onerror = function(){ console.error('[UDP-Loc] Script load failed:', src); cb(); };
  document.head.appendChild(s);
}

function _udpLocEnsureModal(cb) {
  var overlay = document.getElementById('udp-loc-overlay');
  if (!overlay) {
    if (!document.getElementById('udp-loc-leaflet-css')) {
      var link = document.createElement('link');
      link.id = 'udp-loc-leaflet-css'; link.rel = 'stylesheet';
      link.href = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css';
      document.head.appendChild(link);
    }
    overlay = document.createElement('div');
    overlay.id = 'udp-loc-overlay';
    overlay.setAttribute('style', 'display:none;position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,.55);align-items:center;justify-content:center;');
    overlay.innerHTML =
      '<div style="background:var(--card);border-radius:12px;width:min(760px,96vw);max-height:90vh;display:flex;flex-direction:column;overflow:hidden;">' +
        '<div style="background:var(--dark);color:#fff;padding:16px 20px;display:flex;align-items:center;justify-content:space-between;border-radius:12px 12px 0 0;">' +
          '<div><div style="font-size:10px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;opacity:.6;margin-bottom:2px;">Admin</div>' +
          '<div style="font-size:16px;font-weight:700;">Set Unit Location</div></div>' +
          '<button id="udp-loc-close" style="background:none;border:none;color:#fff;font-size:20px;cursor:pointer;padding:4px 8px;opacity:.8;" aria-label="Close">&#x2715;</button>' +
        '</div>' +
        '<div style="display:flex;gap:0;flex:1;overflow:hidden;">' +
          '<div style="width:200px;min-width:160px;padding:16px;border-right:1px solid var(--border);display:flex;flex-direction:column;gap:12px;">' +
            '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--muted);">Coordinates</div>' +
            '<div>' +
              '<label style="font-size:11px;font-weight:600;color:var(--muted);display:block;margin-bottom:4px;">Latitude</label>' +
              '<input id="udp-loc-lat" type="text" readonly placeholder="Click map" style="width:100%;box-sizing:border-box;border:1px solid var(--border);border-radius:6px;padding:6px 8px;font-size:13px;background:var(--bg);color:var(--text);">' +
            '</div>' +
            '<div>' +
              '<label style="font-size:11px;font-weight:600;color:var(--muted);display:block;margin-bottom:4px;">Longitude</label>' +
              '<input id="udp-loc-lng" type="text" readonly placeholder="Click map" style="width:100%;box-sizing:border-box;border:1px solid var(--border);border-radius:6px;padding:6px 8px;font-size:13px;background:var(--bg);color:var(--text);">' +
            '</div>' +
            '<button id="udp-loc-geolocate" style="background:var(--bg);border:1px solid var(--border);border-radius:7px;padding:7px 10px;font-size:12px;font-weight:600;cursor:pointer;color:var(--text);">&#127919; Use my location</button>' +
          '</div>' +
          '<div style="flex:1;display:flex;flex-direction:column;">' +
            '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--muted);padding:10px 12px 4px;">Map — click to place pin</div>' +
            '<div id="udp-loc-map" style="flex:1;min-height:300px;"></div>' +
          '</div>' +
        '</div>' +
        '<div style="padding:12px 16px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:10px;">' +
          '<button id="udp-loc-cancel" class="btn btn-ghost">Cancel</button>' +
          '<button id="udp-loc-save" disabled class="btn btn-primary" style="opacity:.5;">Save Location</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
  }

  var pending = 0;
  function done() { if (--pending === 0) { _udpLocWireEvents(); cb(overlay); } }
  if (typeof L === 'undefined') {
    pending++;
    _udpLocLoadScript('https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js', done);
  }
  if (pending === 0) { _udpLocWireEvents(); cb(overlay); }
}

function _udpLocWireEvents() {
  if (_udpLocWired) return;
  _udpLocWired = true;
  var overlay = document.getElementById('udp-loc-overlay');
  if (!overlay) return;
  document.getElementById('udp-loc-close').onclick  = _udpLocClose;
  document.getElementById('udp-loc-cancel').onclick = _udpLocClose;
  document.getElementById('udp-loc-save').onclick   = _udpLocSave;
  document.getElementById('udp-loc-geolocate').onclick = function() {
    if (!navigator.geolocation) { if (typeof showToast === 'function') showToast('Geolocation not supported.', {type:'error'}); return; }
    var btn = document.getElementById('udp-loc-geolocate');
    if (btn) { btn.disabled = true; btn.textContent = 'Locating…'; }
    navigator.geolocation.getCurrentPosition(
      function(pos) {
        _udpLocPlacePin(pos.coords.latitude, pos.coords.longitude);
        if (btn) { btn.disabled = false; btn.textContent = '🎯 Use my location'; }
      },
      function() {
        if (typeof showToast === 'function') showToast('Could not get location.', {type:'error'});
        if (btn) { btn.disabled = false; btn.textContent = '🎯 Use my location'; }
      }
    );
  };
  overlay.addEventListener('click', function(e){ if (e.target === overlay) _udpLocClose(); });
}

function _udpLocResetState(u) {
  _udpLocLat = null; _udpLocLng = null;
  var latEl = document.getElementById('udp-loc-lat');
  var lngEl = document.getElementById('udp-loc-lng');
  if (latEl) latEl.value = u && u.latitude  ? parseFloat(u.latitude).toFixed(7)  : '';
  if (lngEl) lngEl.value = u && u.longitude ? parseFloat(u.longitude).toFixed(7) : '';
  if (u && u.latitude && u.longitude) {
    _udpLocLat = parseFloat(u.latitude);
    _udpLocLng = parseFloat(u.longitude);
  }
  _udpLocCheckSave();
  if (_udpLocMap) { _udpLocMap.remove(); _udpLocMap = null; _udpLocMarker = null; }
}

function _udpLocInitMap(u) {
  var tries = 0;
  (function attempt(){
    // Leaflet is loaded on demand — wait for it (up to ~4s) instead of bailing
    // silently, so a slightly-slow load doesn't leave a blank picker.
    if (typeof L === 'undefined') {
      if (++tries > 40) { if (typeof showToast === 'function') showToast('Map library could not load. Check your connection, then reopen.', { type:'error' }); return; }
      setTimeout(attempt, 100);
      return;
    }
    var mapEl = document.getElementById('udp-loc-map');
    if (!mapEl) return;
    var startLat = u.latitude  ? parseFloat(u.latitude)  : _UDPLOC_CLFN_LAT;
    var startLng = u.longitude ? parseFloat(u.longitude) : _UDPLOC_CLFN_LNG;
    _udpLocMap = L.map('udp-loc-map', { center: [startLat, startLng], zoom: 13, scrollWheelZoom: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(_udpLocMap);
    if (u.latitude && u.longitude) _udpLocPlacePin(startLat, startLng);
    _udpLocMap.on('click', function(e){ _udpLocPlacePin(e.latlng.lat, e.latlng.lng); });
    setTimeout(function(){ if (_udpLocMap) _udpLocMap.invalidateSize({ animate: false }); }, 300);
  })();
}

function _udpLocPlacePin(lat, lng) {
  if (!_udpLocMap) return;
  var icon = L.divIcon({
    className: '',
    html: '<div style="width:12px;height:12px;background:#111110;border:2px solid #F8E41A;border-radius:50% 50% 50% 0;transform:rotate(-45deg);box-shadow:0 2px 6px rgba(0,0,0,.4);"></div>',
    iconSize: [12,12], iconAnchor: [6,12]
  });
  if (_udpLocMarker) {
    _udpLocMarker.setLatLng([lat, lng]);
  } else {
    _udpLocMarker = L.marker([lat, lng], { icon: icon, draggable: true }).addTo(_udpLocMap);
    _udpLocMarker.on('dragend', function(){
      var p = _udpLocMarker.getLatLng();
      _udpLocSetCoords(p.lat, p.lng);
    });
  }
  _udpLocMap.setView([lat, lng], Math.max(_udpLocMap.getZoom(), 15));
  _udpLocSetCoords(lat, lng);
}

function _udpLocSetCoords(lat, lng) {
  _udpLocLat = lat; _udpLocLng = lng;
  var latEl = document.getElementById('udp-loc-lat');
  var lngEl = document.getElementById('udp-loc-lng');
  if (latEl) latEl.value = parseFloat(lat).toFixed(7);
  if (lngEl) lngEl.value = parseFloat(lng).toFixed(7);
  _udpLocCheckSave();
}

function _udpLocCheckSave() {
  var btn = document.getElementById('udp-loc-save');
  if (!btn) return;
  var ok = !!(typeof _udpLocLat === 'number' && typeof _udpLocLng === 'number');
  btn.disabled = !ok;
  btn.style.opacity = ok ? '1' : '.5';
}

function _udpLocClose() {
  var overlay = document.getElementById('udp-loc-overlay');
  if (overlay) overlay.style.display = 'none';
  if (_udpLocMap) { _udpLocMap.remove(); _udpLocMap = null; _udpLocMarker = null; }
}

async function _udpLocSave() {
  var btn = document.getElementById('udp-loc-save');
  if (!_udpLocLat || !_udpLocLng) return;
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    var updates = { latitude: parseFloat(_udpLocLat), longitude: parseFloat(_udpLocLng) };
    // PATCH housing_units + sync the in-memory unit (camelCase keys match the columns here)
    var patched = await sbPatchUnit(_udpLocUnitId, updates, updates);
    if (!patched) throw new Error('could not update the unit record');

    var units = getAllUnits();
    if (typeof sbSaveUnit === 'function') {
      var u2 = units.find(function(x){ return String(x.id) === String(_udpLocUnitId); });
      if (u2) sbSaveUnit(u2).catch(function(){});
    }
    if (typeof auditEntry === 'function') auditEntry('UNIT:' + _udpLocUnitId, 'unit_location_set', 'GPS coordinates set via unit card');
    if (typeof showToast === 'function') showToast('Location saved.', {type:'info'});
    _udpLocClose();
    // Re-render the map section if the detail panel is still showing this unit
    if (_currentDetailUnitId === _udpLocUnitId) {
      var u3 = units.find(function(x){ return String(x.id) === String(_udpLocUnitId); });
      if (u3) udpRenderMap(u3);
    }
  } catch(err) {
    console.error('[UDP-Loc] Save failed:', err);
    if (typeof showToast === 'function') showToast('Save failed: ' + err.message, {type:'error'});
    if (btn) { btn.disabled = false; btn.textContent = 'Save Location'; }
  }
}

// ── Unit Detail — tenant history (rendered inside the Edit Unit card) ───
function udpRenderTenantHistory(unitId) {
  var sec  = document.getElementById('udp_history_section');
  var list = document.getElementById('udp_history_list');
  if (!sec || !list) return;
  list.innerHTML = '<div class="js-txt-muted-sm">Loading…</div>';
  sec.style.display = 'block';
  fetch(SUPABASE_URL + '/rest/v1/tenant_movement_log?unit_id=eq.' + encodeURIComponent(String(unitId)) + '&order=move_out_date.desc', {
    headers: HOUSING_HEADERS
  }).then(function(r){ return r.ok ? r.json() : []; })
    .then(function(rows) {
      if (!rows || !rows.length) {
        sec.style.display = 'none';
        return;
      }
      sec.style.display = 'block';
      list.innerHTML = rows.map(function(r) {
        var mi  = r.move_in_date  || '—';
        var mo  = r.move_out_date || '—';
        var dur = r.duration_days != null ? (r.duration_days + ' days') : '—';
        return '<div style="border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:6px;">'
          + '<div style="font-size:13px;font-weight:600;color:var(--text);">' + (r.tenant_name || '—') + '</div>'
          + '<div class="js-txt-muted-sm">' + mi + ' → ' + mo + ' &nbsp;·&nbsp; ' + dur + '</div>'
          + '</div>';
      }).join('');
    })
    .catch(function() { sec.style.display = 'none'; });
}

// ── Unit Detail Panel — tenant files (read-only preview) ────────────
// The Unit Detail Panel shows a lightweight, read-only view of tenant
// files. Uploads + deletes happen in the dedicated tenant-files modal
// (openTenantFilesPanel). Keeping them in one place prevents dual
// data-entry surfaces and matches the "same design across all screens"
// direction.
var _udpFilesLib = null;



function saveNewUnit(){
  var get = function(id){ var el=document.getElementById(id); return el?el.value.trim():''; };
  var chk = function(id){ var el=document.getElementById(id); return el?el.checked:false; };
  var num    = get('au_num');
  var street = get('au_street');
  if(!num || !street){ showToast('Unit number and street are required', {type:'error'}); return; }

  var newId = (street.toUpperCase().replace(/\s+/g,'-') + '-' + num).replace(/[^A-Z0-9\-]/g,'');
  var units = (typeof housingUnits !== 'undefined' && housingUnits.length) ? housingUnits : [];
  if(units.find(function(u){ return u.id === newId; })){ showToast('A unit at that address already exists', {type:'info'}); return; }

  var rentRaw = _canEditUnitRent() ? get('au_rent') : '';
  var auCcRaw = get('au_constructionCost');
  var newUnit = {
    id: newId, street: street, num: num,
    bedrooms: parseInt(get('au_bedrooms'))||3,
    bathrooms: get('au_bathrooms')||'1',
    type: get('au_type')||'detached unit',
    buildingName: get('au_building_name') || null,
    foundation: get('au_foundation')||'',
    funder: get('au_funder')||'',
    phase: get('au_phase')||'',
    year: get('au_year')||'',
    monthlyRent: (rentRaw === '' || rentRaw == null) ? null : Math.round(Number(rentRaw) * 100) / 100,
    constructionCost: (auCcRaw === '' || auCcRaw == null) ? null : Math.round(Number(auCcRaw) * 100) / 100,
    notes: get('au_notes')||'',
    accessible: chk('au_accessible'),
    isElders: chk('au_isElders'),
    status: 'vacant',
    assignedTo: null, assignedDate: null, assignedName: null
  };

  // Optional: build this unit on a vacant lot. Link the unit to the lot and
  // mark the lot as built.
  var _lotId = (document.getElementById('au_lot')||{}).value || '';
  if(_lotId){
    var _lot = housingUnits.find(function(x){ return String(x.id)===String(_lotId); });
    if(_lot){
      newUnit.lotId = _lotId;
      newUnit.lotNumber = _lot.lotNumber || _lot.num || '';
      _lot.builtUnitId = newId;
      _lot.status = 'built';
      saveUnitWithDraftFallback(_lot);
      if(typeof auditEntry==='function') auditEntry('UNIT:'+newId, 'unit_on_lot', 'Built on Lot '+(_lot.lotNumber||_lot.num||'')+' '+(_lot.street||''), window.currentRole||'');
    }
  }

  housingUnits.push(newUnit);
  saveUnitWithDraftFallback(newUnit);
  if(_auStagedPhotos.length){ saveUnitPhotos(newId, _auStagedPhotos); _auStagedPhotos=[]; }
  closeAddUnitModal();
  renderInventoryView();
  showToast(num + ' ' + street + ' added to inventory', {type:'info'});
}

function _canEditUnitRent(){
  var role = window.currentRole || '';
  // Configurable via Settings → Approval Authority → Unit Assignment →
  // "Set / edit unit rent amount". Falls back to HM/ED if APPROVAL_AUTHORITY
  // hasn't loaded yet (e.g. early page boot before settings hydrate).
  if(typeof APPROVAL_AUTHORITY !== 'undefined' && APPROVAL_AUTHORITY && typeof APPROVAL_AUTHORITY.can === 'function'){
    return APPROVAL_AUTHORITY.can('assignRentAmount', role);
  }
  return role === ROLE.ED || role === ROLE.HOUSING_MANAGER;
}
function _gateRentInput(inputId){
  var el = document.getElementById(inputId);
  if(!el) return;
  var allowed = _canEditUnitRent();
  el.disabled = !allowed;
  el.title = allowed ? '' : 'Only Housing Manager or Executive Director can set the unit rent.';
  if(!allowed) el.classList.add('tic-readonly-input'); else el.classList.remove('tic-readonly-input');
}

// ── Estimated Rent (unit card, read-only calculated) ─────────────────────────
// The field DISPLAYS the final calculated estimated rent: table rate (by
// bedroom count) x age factor, dollar-rounded, x the payable percentage.
// It is read-only — the number is derived, and recalculates live as the
// bedrooms / Year Built / Major Renovation Year / rehab override change.
// The full derivation lives in the "How this was calculated" details toggle
// (and the field's tooltip); only the no-construction-year flag stays
// visible inline (spec: the unverified fallback must be visible on the
// card). A legacy per-unit market-rent override (estimatedMarketRent) is
// still honoured in the math and can be cleared from the details panel;
// saveUnitEdit never writes the field back.
// Pseudo-unit from the LIVE form fields + the saved record's override state,
// so the readout tracks edits before they're saved.
function _ueFormUnitForRent(){
  var g = function(id){ return (document.getElementById(id)||{}).value || ''; };
  var saved = null;
  if(window._editingUnitId){
    var all = (typeof getAllUnits === 'function') ? getAllUnits() : (window.housingUnits || []);
    saved = (all || []).find(function(x){ return x && x.id === window._editingUnitId; }) || null;
  }
  return {
    id: window._editingUnitId,
    bedrooms: g('ue_bedrooms'),
    // Legacy per-unit market override comes from the SAVED record (the field
    // itself now shows the derived estimated rent, never a market override).
    estimatedMarketRent: saved ? saved.estimatedMarketRent : null,
    year: g('ue_year'),
    majorRenoYear: g('ue_major_reno_year'),
    rehabOverride: saved ? saved.rehabOverride : null,
    monthlyRent: saved ? saved.monthlyRent : null,
    status: g('ue_status') || (saved ? saved.status : ''),
    assignedName: saved ? saved.assignedName : ''
  };
}
function _ueRefreshEmrCalc(){
  var el = document.getElementById('ue_est_market_rent');
  if(!el) return;
  var out = document.getElementById('ue_emr_calc');
  if(out) out.remove();   // NOTHING renders under the field — tooltip only.
  if(typeof getRentModel !== 'function' || typeof unitMarketRent !== 'function') return;
  var fu = _ueFormUnitForRent();
  var info = unitMarketRent(fu);
  var ai = info.ageInfo;
  var pct = Math.round(info.payablePct * 10000) / 100;
  var money = function(v){ return '$' + Number(v).toLocaleString('en-CA', {minimumFractionDigits:2, maximumFractionDigits:2}); };
  // The FIELD holds the final calculated estimated rent (read-only).
  el.readOnly = true;
  el.style.background = 'var(--bg)';
  el.value = info.estRent != null ? String(Math.round(info.estRent * 100) / 100) : '';
  // EVERYTHING — derivation, flags, grandfather note — lives in the tooltip.
  var deriv = [];
  if(info.marketRent != null){
    deriv.push((info.source === 'manual' ? 'Per-unit market override: ' : 'Rent table (' + (info.beds != null ? Math.min(info.beds,5) + (info.beds >= 5 ? '+' : '') + ' bd' : '') + '): ') + money(info.marketRent));
  }
  if(ai && info.source !== 'manual'){
    if(ai.source === 'band') deriv.push('Age ' + ai.effectiveAge + ' yrs (' + (ai.usedRenoYear ? 'major reno ' : 'built ') + ai.effectiveYear + ') → factor ' + ai.factor.toFixed(2) + (ai.floorApplied ? ' (floor)' : '') + ' · schedule v' + ai.scheduleVersion);
    else if(ai.source === 'override') deriv.push('Pending major rehab override → factor ' + ai.factor.toFixed(2) + (ai.override && ai.override.reason ? ' (' + ai.override.reason + ')' : ''));
    else deriv.push('⚠ No construction year on file → factor 1.00 (unverified default, not an assessed value)');
    if(info.adjustedMarketRent != null && info.adjustedMarketRent !== info.marketRent) deriv.push('Adjusted market rent: $' + Number(info.adjustedMarketRent).toLocaleString() + ' (rounded to the dollar)');
  }
  if(info.estRent != null) deriv.push('× ' + pct + '% payable = ' + money(info.estRent) + '/month');
  if(fu.assignedName && fu.monthlyRent != null && info.estRent != null && Number(fu.monthlyRent) !== info.estRent){
    deriv.push('Current tenant grandfathered at ' + money(fu.monthlyRent) + ' — the calculated rate applies at the next turnover.');
  } else {
    deriv.push('Rent only changes at turnover — sitting tenants are grandfathered.');
  }
  el.title = deriv.join('\n');
  // The rehab-override / clear-override ACTIONS (buttons can't live in a
  // tooltip) render under the Major Renovation Year field instead.
  _ueRenderRehabCtl(fu, info);
}
// Action chips under the Major Renovation Year field: the pending-major-rehab
// override (set/clear) and, when present, clearing a legacy market override.
function _ueRenderRehabCtl(fu, info){
  var host = document.getElementById('ue_major_reno_year');
  if(!host || !host.parentNode) return;
  var ctl = document.getElementById('ue_rehab_ctl');
  if(!ctl){
    ctl = document.createElement('div');
    ctl.id = 'ue_rehab_ctl';
    ctl.style.cssText = 'font-size:11px;color:var(--muted);margin-top:3px;line-height:1.6;';
    host.parentNode.appendChild(ctl);
  }
  var html = _ueRehabOverrideHtml(fu).replace(/^<br\/>/, '');
  if(info && info.source === 'manual' && _canEditUnitRent()){
    html += '<br/><button type="button" class="btn btn-ghost" style="padding:2px 8px;font-size:10px;margin-top:2px;" onclick="_ueClearEmrOverride()" title="This unit has a per-unit market-rent override; clearing returns it to the table + age-factor calculation">✕ Clear market override</button>';
  }
  ctl.innerHTML = html;
}
// Clears a legacy per-unit market override so the unit goes back to the
// table + age-factor derivation. Persists + audits immediately.
function _ueClearEmrOverride(){
  if(!_canEditUnitRent()) return;
  var all = (typeof getAllUnits === 'function') ? getAllUnits() : (window.housingUnits || []);
  var u = (all || []).find(function(x){ return x && x.id === window._editingUnitId; });
  if(!u) return;
  u.estimatedMarketRent = null;
  if(typeof saveUnitWithDraftFallback === 'function') saveUnitWithDraftFallback(u);
  else if(typeof sbSaveUnit === 'function') sbSaveUnit(u);
  if(typeof auditEntry === 'function') auditEntry(u.id, 'rent_est_override_cleared', 'Per-unit market-rent override cleared — unit returns to the table + age-factor calculation', window.currentRole || 'staff');
  showToast('Market override cleared — using the calculated rate.', {type:'info'});
  _ueRefreshEmrCalc();
}
window._ueClearEmrOverride = _ueClearEmrOverride;
// Pending-major-rehab override control (0.60–0.70, reason required) — the only
// path below the schedule floor. Persists immediately (audited), same
// authority as setting the rent amount.
function _ueRehabOverrideHtml(fu){
  if(!_canEditUnitRent() || !window._editingUnitId) return '';
  var esc = (typeof escapeHtml === 'function') ? escapeHtml : function(x){ return String(x == null ? '' : x); };
  // The rehab factor is CONFIGURED in Settings (schedule.rehabFactor,
  // 0.60-0.70) and auto-applied — one confirmed tap flags the unit.
  var schedFactor = (typeof getRentAgeSchedule === 'function') ? getRentAgeSchedule().rehabFactor : 0.65;
  var ovr = fu.rehabOverride;
  if(ovr && (ovr.pending || ovr.factor != null)){
    return '<br/><button type="button" class="btn btn-ghost" style="padding:2px 8px;font-size:10px;margin-top:2px;" onclick="_ueClearRehabOverride()">🔧 Rehab pending · factor ' + Number(schedFactor).toFixed(2) + ' (auto) — clear ✕</button>';
  }
  return '<br/><button type="button" class="btn btn-ghost" style="padding:2px 8px;font-size:10px;margin-top:2px;" title="Applies the configured pending-rehab factor (' + Number(schedFactor).toFixed(2) + ', set in Settings &gt; Rent Model) until the renovation is done" onclick="_ueSaveRehabOverride()">🔧 Pending major rehab…</button>';
}
async function _ueSaveRehabOverride(){
  if(!_canEditUnitRent()) return;
  // Only the FLAG is stored — the factor resolves from the Settings schedule
  // at calculation time (auto, never per-unit). One confirmed tap; audited.
  var schedFactor = (typeof getRentAgeSchedule === 'function') ? getRentAgeSchedule().rehabFactor : 0.65;
  var go = (typeof showConfirm === 'function')
    ? await showConfirm({ title: 'Flag as pending major rehab?',
        message: 'Applies the configured pending-rehab rent factor (' + Number(schedFactor).toFixed(2) + ', from Settings) to this unit until the renovation is done and the flag is cleared.',
        confirmText: 'Apply ' + Number(schedFactor).toFixed(2), cancelText: 'Cancel' })
    : window.confirm('Flag this unit as pending major rehab (factor ' + Number(schedFactor).toFixed(2) + ')?');
  if(!go) return;
  _ueWriteRehabOverride({ pending: true,
    setBy: window.currentRole || 'staff', setAt: new Date().toISOString().split('T')[0] },
    'Pending-major-rehab flag set (factor ' + Number(schedFactor).toFixed(2) + ' from the rent schedule)');
}
function _ueClearRehabOverride(){
  _ueWriteRehabOverride(null, 'Pending-major-rehab rent override cleared');
}
function _ueWriteRehabOverride(ovr, auditMsg){
  var all = (typeof getAllUnits === 'function') ? getAllUnits() : (window.housingUnits || []);
  var u = (all || []).find(function(x){ return x && x.id === window._editingUnitId; });
  if(!u){ showToast('Save the unit first, then set the override.', {type:'error'}); return; }
  u.rehabOverride = ovr;
  if(typeof saveUnitWithDraftFallback === 'function') saveUnitWithDraftFallback(u);
  else if(typeof sbSaveUnit === 'function') sbSaveUnit(u);
  if(typeof auditEntry === 'function') auditEntry(u.id, 'rent_rehab_override', auditMsg, window.currentRole || 'staff');
  showToast(ovr ? 'Rehab override saved.' : 'Rehab override cleared.', {type:'info'});
  _ueRefreshEmrCalc();
}
window._ueSaveRehabOverride = _ueSaveRehabOverride;
window._ueClearRehabOverride = _ueClearRehabOverride;
function _ueSetEmrField(u){
  var el = document.getElementById('ue_est_market_rent');
  if(!el) return;
  if(!el.dataset.emrWired){
    el.dataset.emrWired = '1';
    // Bedrooms + year fields drive the calculation — recalc live.
    var bedsEl = document.getElementById('ue_bedrooms');
    if(bedsEl) bedsEl.addEventListener('change', _ueRefreshEmrCalc);
    ['ue_year','ue_major_reno_year'].forEach(function(yid){
      var yEl = document.getElementById(yid);
      if(yEl && !yEl.dataset.emrWired){
        yEl.dataset.emrWired = '1';
        yEl.addEventListener('input', _ueRefreshEmrCalc);
      }
    });
  }
  _ueRefreshEmrCalc();
}
function openAddUnitModal(){
  var fields = ['au_num','au_street','au_bathrooms','au_year','au_phase','au_notes','au_rent','au_constructionCost','au_building_name'];
  fields.forEach(function(id){ var el=document.getElementById(id); if(el) el.value=''; });
  _gateRentInput('au_rent');
  var typeEl = document.getElementById('au_type'); if(typeEl) typeEl.value='';
  ueTypeChanged('au');  // reset room label + options + hide building name
  var bedEl = document.getElementById('au_bedrooms'); if(bedEl) bedEl.value='3';
  var fndEl = document.getElementById('au_foundation'); if(fndEl) fndEl.value='';
  var funEl = document.getElementById('au_funder'); if(funEl) funEl.value='';
  var accEl = document.getElementById('au_accessible'); if(accEl) accEl.checked=false;
  var eldEl = document.getElementById('au_isElders'); if(eldEl) eldEl.checked=false;
  _auStagedPhotos = [];
  renderAddUnitPhotoPreview();
  // Populate the "Build on Lot" picker with vacant (unbuilt) lots.
  var lotSel = document.getElementById('au_lot');
  if(lotSel){
    var _allU = (typeof getAllUnits==='function') ? getAllUnits() : (window.housingUnits||[]);
    var _vacLots = _allU.filter(function(u){ return _isLot(u) && !u.archived && !u.builtUnitId; });
    lotSel.innerHTML = '<option value="">— None —</option>' + _vacLots.map(function(l){
      var lbl = ((l.lotNumber||l.num||'?') + ' ' + (l.street||'')).trim();
      return '<option value="'+String(l.id).replace(/"/g,'&quot;')+'">Lot '+_escAttrLite(lbl)+'</option>';
    }).join('');
    lotSel.value = '';
  }
  var modal = document.getElementById('addUnitModal');
  if(modal){ modal.style.removeProperty('display'); modal.style.setProperty('display','flex','important'); }
}
function _escAttrLite(s){ return String(s==null?'':s).replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ── Vacant lots (land parcels stored in housing_units, record_type:'lot') ──────
function openAddLotModal(){
  ['al_lotnum','al_street','al_notes'].forEach(function(id){ var el=document.getElementById(id); if(el) el.value=''; });
  var m = document.getElementById('addLotModal');
  if(m){ m.style.removeProperty('display'); m.style.setProperty('display','flex','important'); }
}
function closeAddLotModal(){
  var m = document.getElementById('addLotModal');
  if(m) m.style.display='none';
}
function saveNewLot(){
  var get = function(id){ var el=document.getElementById(id); return el?el.value.trim():''; };
  var lotNum = get('al_lotnum'), street = get('al_street');
  if(!lotNum || !street){ showToast('Lot number and street are required', {type:'error'}); return; }
  var newId = ('LOT-' + street.toUpperCase().replace(/\s+/g,'-') + '-' + lotNum).replace(/[^A-Z0-9\-]/g,'');
  var units = (typeof housingUnits !== 'undefined' && housingUnits.length) ? housingUnits : [];
  if(units.find(function(u){ return u.id === newId; })){ showToast('A lot at that address already exists', {type:'info'}); return; }
  var newLot = {
    id:newId, street:street, num:lotNum, lotNumber:lotNum,
    record_type:'lot', type:'Vacant Lot', status:'vacant_lot',
    notes:get('al_notes')||'', builtUnitId:null,
    bedrooms:null, bathrooms:null, assignedTo:null, assignedName:null, assignedDate:null
  };
  housingUnits.push(newLot);
  saveUnitWithDraftFallback(newLot);
  if(typeof auditEntry==='function') auditEntry('UNIT:'+newId, 'lot_added', 'Vacant lot added: Lot '+lotNum+' '+street, window.currentRole||'');
  closeAddLotModal();
  renderInventoryView();
  showToast('Lot '+lotNum+' '+street+' added', {type:'info'});
}
function _lotArchive(lotId){
  var l = (typeof housingUnits!=='undefined'?housingUnits:[]).find(function(x){ return String(x.id)===String(lotId); });
  if(!l) return;
  var doIt = function(){
    l.archived = true;
    saveUnitWithDraftFallback(l);
    if(typeof auditEntry==='function') auditEntry('UNIT:'+lotId, 'lot_archived', 'Vacant lot archived', window.currentRole||'');
    renderInventoryView();
    showToast('Lot archived', {type:'info'});
  };
  if(typeof showConfirm==='function'){
    showConfirm({ title:'Archive this lot?', message:'It will be removed from the Vacant Lots list.', confirmText:'Archive' }).then(function(ok){ if(ok) doIt(); });
  } else { doIt(); }
}
// Render the Vacant Lots table on the Inventory page.
function _renderLotsList(){
  var tbody = document.getElementById('inv_lots_tbody'); if(!tbody) return;
  var units = (typeof getAllUnits==='function') ? getAllUnits() : (window.housingUnits||[]);
  var esc = (typeof escapeHtml==='function') ? escapeHtml : function(s){ return String(s==null?'':s); };
  var lots = units.filter(function(u){ return _isLot(u) && !u.archived; });
  var cnt = document.getElementById('inv_lots_count'); if(cnt) cnt.textContent = lots.length ? ('· '+lots.length) : '';
  if(!lots.length){ tbody.innerHTML = '<tr><td colspan="5" style="padding:20px;text-align:center;color:var(--muted);">No lots yet. Click "+ Add Lot" to create one.</td></tr>'; return; }
  lots.sort(function(a,b){
    var s=(a.street||'').localeCompare(b.street||''); if(s!==0) return s;
    return (parseInt(a.lotNumber||a.num||0,10)||0) - (parseInt(b.lotNumber||b.num||0,10)||0);
  });
  tbody.innerHTML = lots.map(function(l){
    var built = !!l.builtUnitId;
    var bldg = '';
    if(built){ var bu = units.find(function(x){ return String(x.id)===String(l.builtUnitId); }); bldg = bu ? esc(((bu.num||'')+' '+(bu.street||'')).trim()) : '(building)'; }
    var statusPill = built
      ? '<span style="font-size:11px;font-weight:700;padding:3px 9px;border-radius:8px;background:var(--info-blue-bg);color:#1d4ed8;">Built</span>'
      : '<span style="font-size:11px;font-weight:700;padding:3px 9px;border-radius:8px;background:var(--success-bg);color:var(--success);">Vacant</span>';
    var lid = String(l.id).replace(/'/g,"\\'");
    return '<tr>'
      +'<td style="font-weight:700;">'+esc(l.lotNumber||l.num||'—')+'</td>'
      +'<td>'+esc(l.street||'—')+'</td>'
      +'<td>'+statusPill+'</td>'
      +'<td style="color:var(--muted);font-size:12px;">'+(bldg||'—')+'</td>'
      +'<td style="text-align:right;white-space:nowrap;">'
        + (built ? '' : '<button onclick="_lotArchive(\''+lid+'\')" class="btn btn-ghost btn-sm" style="color:var(--danger);">Archive</button>')
      +'</td>'
    +'</tr>';
  }).join('');
}
window.openAddLotModal = openAddLotModal;
window.closeAddLotModal = closeAddLotModal;
window.saveNewLot = saveNewLot;
window._lotArchive = _lotArchive;
window._renderLotsList = _renderLotsList;

// ── renderBudgetPools ──
// BUDGET_POOLS lives in shared-config.js (single registry — renos.html's copy
// had drifted to 6 pools while this file's had 8). Do not re-add a local copy.








function saveBudgetPools(){
  // Also save HM budget limit
  var limitEl = document.getElementById('settings_hm_budget_limit');
  if(limitEl && limitEl.value) {
    var s = window._appSettings || {};
    var prevLimit = s.hmBudgetLimit;
    s.hmBudgetLimit = parseFloat(limitEl.value)||25000;
    window._appSettings = s;
    // Dedicated row (not the whole map) — see aaSaveBudgetLimit in
    // housing-settings.js for why the old 'app_settings' blob never persisted.
    saveSettingWithDraftFallback('hmBudgetLimit', s.hmBudgetLimit).then(function(ok){
      if(!ok){
        s.hmBudgetLimit = prevLimit;
        window._appSettings = s;
        showToast('Could not save HM budget limit — retry.', {type:'error'});
      }
    });
  }
  var fyEl  = document.getElementById('budget_fiscal_year');
  var ageEl = document.getElementById('budget_fncfs_age');
  var data = {
    fiscalYear:          fyEl  ? fyEl.value  : '2025-2026',
    fncfsDependantAge:   ageEl ? (parseInt(ageEl.value, 10) || 17) : 17,
    pools:{}
  };
  BUDGET_POOLS.forEach(function(p){
    var allocEl = document.getElementById('budget_alloc_'+p.id);
    var notesEl = document.getElementById('budget_notes_'+p.id);
    data.pools[p.id] = {
      allocated: parseFloat((allocEl?allocEl.value:0))||0,
      notes: notesEl ? notesEl.value : ''
    };
  });
  saveBudgetData(data);  // saveBudgetData already surfaces its own errors
  var hmLimitEl=document.getElementById('settings_hm_budget_limit');
  auditEntry('SETTINGS','settings_budget_save','Budget allocations saved for '+data.fiscalYear+(hmLimitEl?' — HM limit: $'+hmLimitEl.value:''),window.currentRole||'staff');
  showToast('Budget allocations saved', {type:'info'});
  renderBudgetPools();
}

// ── renderUnitScoreTable ──
var UNIT_SCORE_KEY = 'clfn_unit_score_model';

function openRenoSearch() {
  renoSearchFilter('');
  var m = document.getElementById('renoSearchModal');
  if(m){ m.style.setProperty('display','flex','important'); document.body.classList.add('modal-open'); }
  setTimeout(function(){ var i=document.getElementById('reno_search_input'); if(i){i.value='';i.focus();} }, 150);
}

function closeRenoSearch() {
  var m = document.getElementById('renoSearchModal');
  if(m) m.style.display='none';
  document.body.classList.remove('modal-open');
}

// (openRenoNewRequest + window._renoNewRequestMode removed — zero call sites;
// the flag was never read anywhere.)

function renoSearchFilter(q) {
  var allUnits = getAllUnits();
  // Condemned is a terminal classification — a condemned unit only shows in the
  // renovation search when it actually has a maintenance request on file
  // (mirrors _getAllRenoUnits in shared-data.js).
  var renoUnits = allUnits.filter(function(u){
    if(u.status==='condemned') return !!((typeof getSowData==='function') && getSowData(u.id));
    return !!u.under_renovation;
  });

  var filtered = q.trim().length > 0
    ? renoUnits.filter(function(u){ return (u.num+' '+u.street).toLowerCase().includes(q.toLowerCase()); })
    : renoUnits;

  // Field Employees only see units that have an in-house work order assigned to
  // them (the logged-in key person).
  if((window.currentRole||'') === 'field_employee' && typeof sowHiddenFromCurrentFieldEmployee === 'function'){
    filtered = filtered.filter(function(u){
      var sows = (typeof getUnitSowList === 'function') ? getUnitSowList(u.id) : [];
      return sows.some(function(s){ return s && !s.archived && !sowHiddenFromCurrentFieldEmployee(s); });
    });
  }

  var statusStyle = {
    vacant:    {bg:'var(--success-bg)',c:'var(--success)',label:'Vacant'},
    occupied:  {bg:'var(--info-blue-bg)',c:'#1d4ed8',label:'Occupied'},
    reserved:  {bg:'#faf5ff',c:'#7c3aed',label:'Reserved'},
    condemned: {bg:'var(--danger-bg)', c:'var(--danger)', label:'Condemned'}
  };

  var container = document.getElementById('reno_search_results');
  if(!container) return;

  if(!filtered.length) {
    container.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted);font-size:13px;font-style:italic;">'
      +(q ? 'No active renovation units matching "'+q+'"' : 'No units currently under repair or condemned.')
      +'</div>';
    return;
  }

  container.innerHTML = filtered.map(function(u) {
    var ss = statusStyle[u.status] || {bg:'#f4f4f0',c:'var(--gray)',label:u.status};
    var rs = calcRenoScore(u.id);
    var scoreBadge = rs.score
      ? '<span style="font-size:10px;font-weight:700;color:var(--muted);margin-left:6px;">Score: '+rs.score+'</span>'
      : '';
    var uid = u.id.replace(/'/g,"\\'");
    return '<div onclick="closeRenoSearch();openRenoProgress(\''+uid+'\')" '
      +'style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 14px;border:1px solid var(--border);border-radius:8px;background:var(--bg);cursor:pointer;transition:border-color .12s;" '
      +'onmouseover="this.style.borderColor=\'var(--yellow)\'" onmouseout="this.style.borderColor=\'var(--border)\'">'
      +'<div style="min-width:0;flex:1;">'
        +'<div style="font-weight:700;font-size:13px;">'+u.num+' '+u.street+'</div>'
        +'<div class="js-lbl-sm">'+_roomBedLabel(u)+(_fmtUnitType(u.type)?' · '+_fmtUnitType(u.type):'')+scoreBadge+'</div>'
      +'</div>'
      +'<div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">'
        +'<span style="font-size:11px;font-weight:700;padding:3px 10px;border-radius:8px;background:'+ss.bg+';color:'+ss.c+';">'+ss.label+'</span>'
        +'<button onclick="event.stopPropagation();closeRenoSearch();openSowModal(\''+uid+'\')" '
          +'title="Open Maintenance Request" '
          +'style="background:none;border:1px solid var(--border);border-radius:6px;padding:4px 8px;cursor:pointer;font-size:11px;font-weight:700;font-family:DM Sans,sans-serif;color:var(--muted);white-space:nowrap;" '
          +'onmouseover="this.style.borderColor=\'var(--yellow)\';this.style.color=\'var(--text)\'" '
          +'onmouseout="this.style.borderColor=\'var(--border)\';this.style.color=\'var(--muted)\'">'
          +'🔨 Request'
        +'</button>'
      +'</div>'
      +'</div>';
  }).join('');
}

// ── Renovations export ──


// ── Contractors export ──


// ── MOBILE MENU ──




// (mobile menu nav close removed — no sidebar)

// ══ RESTORED UNIT/PHOTO FUNCTIONS ══


function openRenoProgress(unitId) {
  var allUnits = getAllUnits();
  var u = allUnits.find(function(x){ return x.id === unitId; });
  if(!u) return;
  window._rpUnitId = unitId;   // (shadowing local removed — only the window global is read)

  // Populate header
  var hdr = document.getElementById('rp_unit_header');
  if(hdr) hdr.textContent = u.num + ' ' + u.street;

  // SOW summary
  var sow = null;
  sow = getSowData(unitId);
  var sumEl = document.getElementById('rp_sow_summary');
  if(sumEl) {
    if(sow && sow.items && sow.items.length) {
      sumEl.innerHTML = '<div class="js-txt-bold2" style="font-weight:400;">Request filed: '+sow.items.length+' items — <span style="color:var(--yellow);cursor:pointer;" data-opensow="1">View Request →</span></div>';
    } else {
      sumEl.innerHTML = '<div class="js-txt-muted">No request filed yet. <span style="color:var(--yellow);cursor:pointer;font-weight:700;" data-createsow="1">Open Request →</span></div>';
    }
    // Wire SOW spans
    if(sumEl){
      var sp=sumEl.querySelector('[data-opensow]');
      if(sp)sp.onclick=function(){openSowModal(unitId);};
      var sp2=sumEl.querySelector('[data-createsow]');
      if(sp2)sp2.onclick=function(){closeRenoProgress();openSowModal(unitId);};
    }
  }

  // Progress data
  var prog = null;
  prog = (window._renoProgress && window._renoProgress[unitId]) || null;

  // Overall progress bar
  var pct = prog ? (prog.overallPct||0) : 0;
  var pctEl = document.getElementById('rp_overall_pct');
  var barEl = document.getElementById('rp_overall_bar');
  var statusEl = document.getElementById('rp_status_label');
  if(pctEl) pctEl.textContent = pct + '%';
  if(barEl) barEl.style.width = pct + '%';
  if(statusEl) statusEl.textContent = prog ? (prog.status||'In Progress') : 'Not Started';

  // Populate editable fields
  var sel = document.getElementById('rp_status_select');
  var pctIn = document.getElementById('rp_pct_input');
  var contr = document.getElementById('rp_contractor');
  var tgt = document.getElementById('rp_target_date');
  var notes = document.getElementById('rp_notes');
  if(sel) sel.value = prog ? (prog.status||'Not Started') : 'Not Started';
  if(pctIn) pctIn.value = pct||'';
  if(contr) contr.value = prog ? (prog.contractor||'') : '';
  var contrId = document.getElementById('rp_contractor_id');
  if(contrId) contrId.value = prog ? (prog.contractorId||'') : '';
  if(tgt) tgt.value = prog ? (prog.targetDate||'') : '';
  if(notes) notes.value = '';  // Clear notes each time — it's for new updates

  // Render photo preview (stored photos)
  var photoPreview = document.getElementById('rp_photo_preview');
  window._rpPendingPhotos = [];
  if(photoPreview) {
    var storedPhotos = prog ? (prog.photos||[]) : [];
    photoPreview.innerHTML = storedPhotos.map(function(src, i) {
      return '<div style="position:relative;width:80px;height:80px;border-radius:8px;overflow:hidden;border:1px solid var(--border);">'
        +'<img src="'+src+'" class="img-cover"/>'
        +'<button type="button" onclick="removeRenoPhoto('+i+')" class="btn-photo-remove" style="position:absolute;top:3px;right:3px;">✕</button>'
        +'</div>';
    }).join('');
    window._rpStoredPhotos = storedPhotos.slice();
  }

  // Render update history
  var histEl = document.getElementById('rp_history');
  if(histEl) {
    var updates = prog ? (prog.updates||[]) : [];
    if(!updates.length) {
      histEl.innerHTML = '<div style="font-size:12px;color:var(--muted);padding:8px 0;">No updates yet.</div>';
    } else {
      histEl.innerHTML = updates.slice().reverse().map(function(u) {
        return '<div style="padding:10px 14px;background:var(--bg);border:1px solid var(--border);border-radius:8px;">'
          +'<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">'
          +'<span style="font-size:11px;font-weight:700;color:var(--text);">'+escapeHtml(u.status)+' — '+escapeHtml(String(u.pct||''))+'%</span>'
          +'<span class="js-lbl-xs">'+escapeHtml(u.date)+'</span>'
          +'</div>'
          +(u.notes?'<div class="js-txt-muted-sm">'+escapeHtml(u.notes)+'</div>':'')
          +(u.photos&&u.photos.length?'<div style="display:flex;gap:5px;margin-top:6px;flex-wrap:wrap;">'
            +u.photos.map(function(s){return '<img src="'+s+'" style="width:48px;height:48px;object-fit:cover;border-radius:5px;border:1px solid var(--border);"/>';}).join('')
            +'</div>':'')
          +'</div>';
      }).join('');
    }
  }

  var modal = document.getElementById('renoProgressModal');
  if(modal){ modal.style.removeProperty('display'); modal.style.setProperty('display','flex','important'); }
  renderRenoScoreBadge(unitId);
}

function openAddTenantModal(){
  var units=getAllUnits();
  var sel=document.getElementById('at_unit');
  if(!sel) return;
  // Only vacant/reserved units available for assignment
  sel.innerHTML='<option value="">— Select a unit —</option>';
  units.filter(function(u){return u.status==='vacant'||u.status==='reserved';}).forEach(function(u){
    var opt=document.createElement('option');
    opt.value=u.id;
    opt.textContent=u.num+' '+u.street+' ('+u.bedrooms+'-bed · '+u.status+')';
    sel.appendChild(opt);
  });
  // Clear all fields
  var appid=document.getElementById('at_appid'); if(appid) appid.value='';
  var appidval=document.getElementById('at_appid_val'); if(appidval) appidval.value='';
  var date=document.getElementById('at_date'); if(date) date.value='';
  var st=document.getElementById('at_status'); if(st) st.value='occupied';
  var sel2=document.getElementById('at_app_selected'); if(sel2){sel2.style.display='none';sel2.innerHTML='';}
  var dd=document.getElementById('at_app_dropdown'); if(dd) dd.style.display='none';
  var err=document.getElementById('at_error'); if(err) err.style.display='none';
  var modal=document.getElementById('addTenantModal');
  if(modal){ modal.style.setProperty('display','flex','important'); document.body.classList.add('modal-open'); }
}

function closeAddTenantModal(){
  var modal=document.getElementById('addTenantModal');
  if(modal) modal.style.display='none';
  document.body.classList.remove('modal-open');
}

function atSearchApps(q){
  var dd=document.getElementById('at_app_dropdown');
  if(!dd) return;
  var apps=typeof applications!=='undefined'?applications:(window.SP_APPLICATIONS||[]);
  // ed_approved = fully approved; mgr_approved = HM recommended (HM role can
  // assign); hm_approved = HM final approval — all three are the shared
  // appAssignabilityStatus approved set (hm_approved was missing here).
  var role = window.currentRole || 'housing_employee_l1';
  var valid=apps.filter(function(a){
    if(APPROVAL_AUTHORITY.can('finalApproveApp', role) || APPROVAL_AUTHORITY.can('reviewApplication', role))
      return a.status===APP_STATUS.ED_APPROVED||a.status===APP_STATUS.MGR_APPROVED||a.status===APP_STATUS.HM_APPROVED;
    return a.status===APP_STATUS.ED_APPROVED;
  });
  var matches=q.trim().length>0
    ? valid.filter(function(a){
        var name=((a.fn||'')+' '+(a.ln||'')).toLowerCase();
        return name.includes(q.toLowerCase())||(a.id||'').toLowerCase().includes(q.toLowerCase());
      })
    : valid.slice(0,8);
  if(!matches.length){
    dd.innerHTML='<div style="padding:10px 14px;font-size:12px;color:var(--muted);">No approved applications found'+(q.trim().length>1?' for <strong>'+escapeHtml(q)+'</strong>':'')+'</div>'
      +'<div style="padding:8px 14px;border-top:1px solid var(--border);background:var(--bg);">'
      +'<button type="button" onmousedown="closeAddTenantModal();newApp();" style="background:none;border:none;font-size:12px;font-weight:600;color:var(--yellow);cursor:pointer;font-family:DM Sans,sans-serif;padding:0;">📝 Start a new application instead →</button>'
      +'</div>';
    dd.style.display='block';
    return;
  }
  dd.style.display='block';
  dd.innerHTML=matches.map(function(a){
    var name=((a.fn||'')+' '+(a.ln||'')).trim()||'Unknown';
    // Replace quotes for the inline JS arg, then escape for HTML rendering.
    var safeName=name.replace(/'/g,'’');
    var isED=a.status===APP_STATUS.ED_APPROVED; var isHM=a.status===APP_STATUS.MGR_APPROVED;
    var isHMApp=a.status===APP_STATUS.HM_APPROVED;
    var statusLabel=(typeof formatAppStatusLabel === 'function') ? formatAppStatusLabel(a.status) : (isED?'ED Approved':isHM?'HM Recommended':a.status.replace(/_/g,' '));
    var statusCol=isED?'var(--success)':isHMApp?'var(--success)':isHM?'#1d4ed8':'var(--gray)';
    var statusBg=isED?'var(--success-bg)':isHMApp?'var(--success-bg)':isHM?'var(--info-blue-bg)':'var(--bg)';
    return '<div onmousedown="atSelectApp(\''+escapeHtml(a.id)+'\',\''+escapeHtml(safeName)+'\',\''+escapeHtml(a.status)+'\') " '
      +'style="padding:9px 14px;cursor:pointer;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:10px;" '
      +'onmouseover="this.style.background=\'var(--bg)\'" onmouseout="this.style.background=\'none\'">'
      +'<div>'
        +'<div class="js-txt-bold">'+escapeHtml(name)+'</div>'
        +'<div class="js-lbl-sm">'+escapeHtml(a.id)+(a.bedrooms?' · '+escapeHtml(String(a.bedrooms))+' bed req\'d':'')+'</div>'
      +'</div>'
      +'<span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px;background:'+statusBg+';color:'+statusCol+';">'+statusLabel+'</span>'
      +'</div>';
  }).join('')
  +'<div style="padding:8px 14px;border-top:1px solid var(--border);background:var(--bg);">'
  +'<button type="button" onmousedown="closeAddTenantModal();newApp();" style="background:none;border:none;font-size:12px;font-weight:600;color:var(--yellow);cursor:pointer;font-family:DM Sans,sans-serif;padding:0;">📝 Not found? Start a new application →</button>'
  +'</div>';
}

function atSelectApp(appId,name,status){
  var dd=document.getElementById('at_app_dropdown'); if(dd) dd.style.display='none';
  var input=document.getElementById('at_appid'); if(input) input.value=name+' ('+appId+')';
  var hidden=document.getElementById('at_appid_val'); if(hidden) hidden.value=appId;
  var sel=document.getElementById('at_app_selected');
  if(sel){
    var _approved = (status===APP_STATUS.ED_APPROVED||status===APP_STATUS.HM_APPROVED);
    var statusCol=_approved?'var(--success)':status===APP_STATUS.MGR_APPROVED?'var(--info-blue)':'var(--warn-amber)';
    var statusBg=_approved?'var(--success-bg)':status===APP_STATUS.MGR_APPROVED?'var(--info-blue-bg)':'var(--warn-amber-bg)';
    var statusLabel=formatAppStatusLabel(status,{variant:'add_tenant'})||status;
    var warn=!_approved&&status!==APP_STATUS.MGR_APPROVED
      ? '<div style="font-size:11px;color:var(--warn-amber);margin-top:4px;">⚠️ This application has not been fully approved. Housing Manager confirmation required before assigning.</div>'
      : (status===APP_STATUS.MGR_APPROVED?'<div style="font-size:11px;color:var(--info-blue);margin-top:4px;">ℹ️ Recommended by HM — awaiting Executive Director final approval.</div>':'');
    sel.innerHTML='<div style="display:flex;align-items:center;justify-content:space-between;">'
      +'<div style="font-size:12px;font-weight:700;">'+name+'</div>'
      +'<span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:6px;background:'+statusBg+';color:'+statusCol+';">'+statusLabel+'</span>'
      +'</div>'
      +'<div class="js-lbl-sm" class="mt-4">'+appId+'</div>'
      +warn;
    sel.style.display='block';
  }
  var err=document.getElementById('at_error'); if(err) err.style.display='none';
}

function saveAddTenant(){
  var unitId=(document.getElementById('at_unit')||{}).value||'';
  var appId=(document.getElementById('at_appid_val')||{}).value||'';
  var appInput=((document.getElementById('at_appid')||{}).value||'').trim();
  var date=(document.getElementById('at_date')||{}).value||'';
  var status=(document.getElementById('at_status')||{}).value||'occupied';

  var err=document.getElementById('at_error');
  function showErr(msg){ if(err){err.textContent=msg;err.style.display='block';}else showToast(msg, {type:'info'}); }

  // Validation
  if(!unitId){ showErr('Please select a unit.'); return; }
  if(!appId && !appInput){ showErr('A housing application is required. Use "Start a New Application" above, or search for an existing approved application.'); return; }
  if(!appId && appInput){ showErr('Please select an application from the search dropdown — type a name or App ID to find it.'); return; }
  if(!date){ showErr('Move-in date is required.'); return; }

  // Pull tenant name from linked application
  var apps=typeof applications!=='undefined'?applications:(window.SP_APPLICATIONS||[]);
  var linkedApp=apps.find(function(a){ return a.id===appId; });
  var tenantName=linkedApp?(((linkedApp.fn||'')+' '+(linkedApp.ln||'')).trim()||'Unknown'):'Unknown';

  var units=getAllUnits();
  var idx=units.findIndex(function(u){return u.id===unitId;});
  if(idx===-1){ showErr('Unit not found.'); return; }

  // BCR / ineligibility gate — warn before housing a banished person.
  if (typeof bcrLookup === 'function') {
    var _bcrRec = bcrLookup(tenantName);
    if (_bcrRec && !window.confirm(
        tenantName + ' is on the BCR (banishment) list'
        + (_bcrRec.bcrd_date ? ' as of ' + _bcrRec.bcrd_date : '')
        + ' and is NOT eligible for housing.'
        + (_bcrRec.reason ? '\n\nReason: ' + _bcrRec.reason : '')
        + '\n\nAssign a unit to them anyway?')) {
      return;
    }
  }

  // Shared approval gate — the Add-Tenant modal used to write the unit with no
  // approval check, so an un-approved app could be housed here and (below) the
  // app was never written back, leaking the tenant onto Match. Enforce the same
  // rule as every other assignment path.
  if(linkedApp && typeof appAssignabilityStatus === 'function'){
    var _as = appAssignabilityStatus(linkedApp, units[idx], { forAssignment: true });
    if(!_as.ok){ showErr('⚠ ' + _as.reason); return; }
  }

  units[idx].assignedName=tenantName;
  units[idx].assignedTo=appId;
  units[idx].assignedDate=date;
  units[idx].status=status;
  saveUnitWithDraftFallback(units[idx]);
  // Commercial → building: type the tenant row (business/department, contact,
  // rent, app link) exactly like the review modal's assign path.
  if(linkedApp && (linkedApp.appType || linkedApp.app_type) === 'commercial'
     && typeof sbTypeCommercialTenantForAssignment === 'function'){
    sbTypeCommercialTenantForAssignment(linkedApp, units[idx]);
  }
  // Always write the tenancy back onto the application so the applicant drops
  // out of the Match queue and every status view reflects the placement.
  if(typeof writeTenancyToApplication === 'function') writeTenancyToApplication(units[idx]);

  closeAddTenantModal();
  if(typeof renderTenantsView==='function') renderTenantsView();
  if(typeof renderInventoryView==='function') renderInventoryView();
  if(typeof renderMatchView==='function') renderMatchView();
  if(typeof renderDashTable==='function') renderDashTable();
  if(typeof renderWorklist==='function') renderWorklist();
  showToast('✓ '+tenantName+' assigned to '+units[idx].num+' '+units[idx].street, {type:'info'});
  // New tenancy = the only moment rent changes (sitting tenants grandfathered).
  if(typeof offerTurnoverRent === 'function') offerTurnoverRent(units[idx], { context: 'add_tenant' });
}


function renderEditUnitPhotoPreview(unitId) {
  var container = document.getElementById('ue_photo_preview');
  if(!container) return;
  var photos = getUnitPhotos(unitId);
  if(!photos.length){ container.innerHTML='<span style="font-size:12px;color:var(--muted);font-style:italic;">No photos yet</span>'; return; }
  var html = '';
  photos.forEach(function(p, i){
    html += '<div style="position:relative;flex-shrink:0;">'
      +'<img src="'+p.data+'" style="width:70px;height:55px;object-fit:cover;border-radius:6px;border:1px solid var(--border);" data-ue-uid="'+unitId+'" data-ue-idx="'+i+'"/>'
      +'<button type="button" data-ue-del-uid="'+unitId+'" data-ue-del-idx="'+i+'" style="position:absolute;top:-5px;right:-5px;background:var(--danger);border:none;color:#fff;width:16px;height:16px;border-radius:50%;cursor:pointer;font-size:9px;line-height:16px;text-align:center;padding:0;">✕</button>'
      +'</div>';
  });
  container.innerHTML = html;
  container.querySelectorAll('button[data-ue-del-uid]').forEach(function(btn){
    btn.onclick = function(){
      var uid = btn.getAttribute('data-ue-del-uid');
      var idx = parseInt(btn.getAttribute('data-ue-del-idx'));
      var p = getUnitPhotos(uid); p.splice(idx,1); saveUnitPhotos(uid,p);
      renderEditUnitPhotoPreview(uid);
    };
  });
}

var _ueCurrentUnitId = null;

function getUnitPhotos(unitId){
  try {
    return (window._unitPhotos && window._unitPhotos[unitId]) ? window._unitPhotos[unitId].map(function(r){ return r.file_path||r; }) : [];
  } catch(e){ return []; }
}

async function saveUnitPhotos(unitId, photos){
  if(!window._unitPhotos) window._unitPhotos = {};
  window._unitPhotos[unitId] = photos;
  // Diff-based sync against current DB state. The previous implementation
  // did DELETE-then-INSERT; if the INSERT failed (network / RLS / 5xx) all
  // photo metadata for the unit was lost while storage blobs were left
  // orphaned. Now we fetch the current rows, compute added/removed, and
  // INSERT first then DELETE — worst-case failure leaves extra rows
  // instead of losing data.
  var nextRecords = (photos || []).map(function(p){
    var path = typeof p === 'string' ? p : ((p && p.file_path) || '');
    return {
      file_path: path,
      file_name: typeof p === 'string' ? path.split('/').pop() : ((p && p.file_name) || '')
    };
  }).filter(function(r){ return r.file_path; });
  var nextPaths = nextRecords.map(function(r){ return r.file_path; });
  try {
    // 1) Read current rows for this unit (source of truth, not the in-memory cache).
    var existingRows = [];
    var existingResp = await fetch(
      SUPABASE_URL + '/rest/v1/housing_unit_photos?unit_id=eq.' + encodeURIComponent(unitId) + '&select=file_path',
      { headers: HOUSING_HEADERS }
    );
    if (existingResp.ok) existingRows = await existingResp.json();
    var existingPaths = (existingRows || []).map(function(row){ return row.file_path; }).filter(Boolean);

    // 2) Diff.
    var added   = nextRecords.filter(function(r){ return existingPaths.indexOf(r.file_path) === -1; });
    var removed = existingPaths.filter(function(p){ return nextPaths.indexOf(p) === -1; });

    // 3) Insert FIRST so a delete failure can't strand the user with empty
    //    metadata on storage blobs that still exist.
    if (added.length) {
      await fetch(SUPABASE_URL + '/rest/v1/housing_unit_photos', {
        method:  'POST',
        headers: Object.assign({}, HOUSING_HEADERS, { 'Prefer': 'return=minimal' }),
        body:    JSON.stringify(added.map(function(r){
          return {
            unit_id:   unitId,
            file_path: r.file_path,
            file_name: r.file_name,
            added_by:  window.currentUser || 'staff'
          };
        }))
      });
    }

    // 4) Delete only paths that are no longer present.
    if (removed.length) {
      var inList = '(' + removed.map(function(p){
        return '"' + String(p).replace(/"/g, '\\"') + '"';
      }).join(',') + ')';
      await fetch(
        SUPABASE_URL + '/rest/v1/housing_unit_photos?unit_id=eq.' + encodeURIComponent(unitId)
          + '&file_path=in.' + encodeURIComponent(inList),
        { method: 'DELETE', headers: HOUSING_HEADERS }
      );
    }
  } catch(e) {
    console.warn('Unit photos save failed:', e);
  }
}

function openAppFromMatch(appId){
  window._appFormReturnTo = 'match';
  // Close the match scorecard modal first; otherwise it stays on top of the
  // application form and the form is hidden behind it.
  closeMatchScorecard();
  // If the app form (#appLayout) doesn't exist on this page (e.g. match.html),
  // hand off to housing.html which owns the form view. Stamp the cross-page
  // referrer so the Back button on the form returns to match.html.
  if(!document.getElementById('appLayout')){
    if (typeof setNavReferrer === 'function') setNavReferrer('match');
    window.location.href = 'housing.html?openApp=' + encodeURIComponent(appId);
    return;
  }
  if(typeof window.openEditModal === 'function') window.openEditModal(appId);
}

function closeMatchScorecard(){
  var modal = document.getElementById('matchScorecardModal');
  if(modal) modal.style.display = 'none';
}

window.openEditModal = function(appId) {
  var app = applications.find(function(a){ return a.id === appId; });
  if(!app) {
    console.warn('[openEditModal] app not found in applications[] — bailing. id:', appId);
    showToast('Application not found', {type:'error'});
    return;
  }

  // Commercial (business/department) applications use their own modal, NOT the
  // residential wizard — otherwise they open demanding housing-only fields
  // (last name, on-reserve, street/city/postal). Route them there.
  if (app.appType === 'commercial') {
    if (typeof window.openCommercialApp === 'function') { window.openCommercialApp(appId); return; }
    showToast('Commercial application viewer is not available on this page.', {type:'error'});
    return;
  }

  // Store the ID so saveApplicationRecord knows which record to update
  currentAppId = app.id;
  // Neutral last-saved indicator until the first save of this editing session.
  if (typeof _appResetSavedIndicator === 'function') _appResetSavedIndicator('💾 Changes auto-save as you go');
  // Existing application → Internal Notes tab is available immediately.
  if (typeof _refreshAppNotesTabVisibility === 'function') _refreshAppNotesTabVisibility();
  // Apply or remove the signature-panel lock based on the app's status —
  // submitted/approved/etc. apps are locked; drafts stay editable.
  if (typeof _applySignatureLockState === 'function') _applySignatureLockState(app);

  // ── Helper: set field value safely ──
  function set(id, val) {
    var el = document.getElementById(id);
    if(!el) return;
    if(el.type === 'checkbox') el.checked = !!val;
    else el.value = val || '';
  }
  function tog(id, val) {
    var el = document.getElementById(id);
    if(el) { el.checked = !!val; el.dispatchEvent(new Event('change')); }
  }

  // ── Step 0: Applicant Info ──
  set('fn',           app.fn);
  set('ln',           app.ln);
  set('dob',          app.dob);
  set('band',         app.band);
  set('reserve',      app.reserve);
  set('living_situation', app.livingSituation);
  if (typeof _syncOnRezBadge === 'function') _syncOnRezBadge();   // Residency card flag badges
  set('marital',      app.marital);
  set('phone',        app.phone?formatPhone(app.phone):'');
  set('email',        app.email);
  set('street',       app.street);
  set('city',         app.city);
  set('prov',         app.province || app.prov);
  set('postal',       app.postal);
  set('occDate',      app.occDate);
  set('appDate',      app.appDate);
  set('accessibility', app.accessibility);
  // Populate classification dropdown — map legacy values to new options
  // Use classification value as-is; only remap truly legacy values that no longer exist as options
  var clsVal = app.classification || '';
  set('classification', clsVal);
  // Restore the CLFN-program consent checkbox (Step 8).
  set('consent_share_programs', !!app.consentShareCLFN);
  liveSync();

  // Restore application type toggle — all three community radios, so the form
  // reflects the SAVED type (transfers used to restore as New Housing, which
  // both confused staff and made persist-on-change unsafe). The restore lock
  // stops onAppTypeChange's persist-on-change from firing during this
  // programmatic pass.
  var isFileUpdate = (app.appType === 'existing_tenant');
  var isTransferTy = (app.appType === 'transfer_request');
  var newRadio = document.getElementById('apptype_new');
  var exRadio  = document.getElementById('apptype_existing');
  var trRadio  = document.getElementById('apptype_transfer');
  if(newRadio) newRadio.checked = !isFileUpdate && !isTransferTy;
  if(exRadio)  exRadio.checked  =  isFileUpdate;
  if(trRadio)  trRadio.checked  =  isTransferTy;
  window._appTypeRestoring = true;
  try { if(typeof onAppTypeChange === 'function') onAppTypeChange(); }
  finally { window._appTypeRestoring = false; }

  // House condition
  tog('hasHouseToggle', app.haveHouse);
  // Restore lock: tog() dispatches a change event, which would fire
  // persistDeceasedChange() before the date field below is populated.
  window._appTypeRestoring = true;
  try {
    tog('deceased_flag', app.deceased);
    set('deceased_date', app.deceasedDate);
  } finally { window._appTypeRestoring = false; }
  (function(){ var w = document.getElementById('deceased_date_wrap'); if (w) w.style.display = app.deceased ? '' : 'none'; })();
  var houseBlk = document.getElementById('homeCondBlk');
  if(houseBlk) houseBlk.style.display = app.haveHouse ? 'block' : 'none';
  if(app.haveHouse) set('homeCondition', app.homeCondition);

  // Arrears
  tog('arrToggle', app.hasArrears);
  var arrBlkEl = document.getElementById('arrBlk');
  if(arrBlkEl) arrBlkEl.style.display = app.hasArrears ? 'block' : 'none';
  if(app.hasArrears) {
    // arrBalAmt and arrMonthlyPayment are type="text" with currency formatting
    var arrBalEl = document.getElementById('arrBalAmt');
    if(arrBalEl && app.arrBalAmt) {
      var _arrNum = parseFloat(app.arrBalAmt) || 0;
      arrBalEl.value = _arrNum ? formatCurrency(_arrNum) : '';
    }
    var arrMonEl = document.getElementById('arrMonthlyPayment');
    if(arrMonEl && app.arrMonthlyPayment) {
      var _monNum = parseFloat(app.arrMonthlyPayment) || 0;
      arrMonEl.value = _monNum ? formatCurrency(_monNum) : '';
    }
    var arrPlanEl = document.getElementById('arrPlanMonths');
    if(arrPlanEl) arrPlanEl.value = app.arrPlanMonths || '';
    var arrAgrEl = document.getElementById('arrAgreementDate');
    if(arrAgrEl) arrAgrEl.value = app.arrAgreementDate || '';
    var arrDueEl = document.getElementById('arrFirstDueDate');
    if(arrDueEl) arrDueEl.value = app.arrFirstDueDate || '';
    var arrFreqEl = document.getElementById('arrFrequency');
    if(arrFreqEl) arrFreqEl.value = app.arrFrequency || 'monthly';
  }

  // ── Step 1: Employment & Income ──
  var incomeList = document.getElementById('incomeList');
  if(incomeList) {
    incomeList.innerHTML = '';
    var incomes = app.incomes || [];
    if(!incomes.length) {
      // Add one blank row
      addIncome();
    } else {
      incomes.forEach(function(inc, i) {
        addIncome();
        var rows = incomeList.querySelectorAll('.rrow');
        var row  = rows[rows.length - 1];
        var sels = row.querySelectorAll('select');
        var txts = row.querySelectorAll('input[type="text"]');
        var nums = row.querySelectorAll('input[type="number"]');
        if(sels[0]) sels[0].value = inc.person    || 'Applicant';
        // Programmatic .value assignment doesn't fire change events, so the
        // dependent dropdowns (Income Type, Employment Status) stay disabled.
        // Trigger the same handler addIncome wires to the onchange so they
        // re-enable when the form is repopulated from a saved application.
        if(sels[0] && typeof onIncomePersonChange === 'function') onIncomePersonChange(sels[0]);
        if(sels[1]) sels[1].value = inc.incomeType || '';
        if(txts[0]) txts[0].value = inc.employer   || '';
        if(nums[0]) nums[0].value = inc.primaryAmt  || '';
      });
    }
  }

  // ── Step 2: Co-Applicant ──
  var co = app.coApp;
  var coStatus = (app.hasCoApp || (co && co.fn)) ? 'yes' : 'no';
  set('co_status', coStatus);
  var coBlk = document.getElementById('coBlk');
  if(coBlk) coBlk.style.display = coStatus === 'yes' ? 'block' : 'none';
  // Co-applicant arrears card lives in step 2 too; show/hide alongside #coBlk.
  var coArrCardEl = document.getElementById('coArrCard');
  if(coArrCardEl) coArrCardEl.style.display = coStatus === 'yes' ? 'block' : 'none';
  if(co) {
    set('co_fn',      co.fn);
    set('co_ln',      co.ln);
    set('co_dob',     co.dob);
    set('co_band',    co.band);
    set('co_reserve', co.reserve);
    set('co_cell',    co.cell ? formatPhone(co.cell) : '');
    set('co_home',    co.home ? formatPhone(co.home) : '');
    set('co_email',   co.email);
    set('coOccDate',  co.occDate);
    // ── Co-applicant arrears (mirrors applicant arrears restore below) ──
    tog('coArrToggle', co.hasArrears);
    var coArrBlkEl = document.getElementById('coArrBlk');
    if(coArrBlkEl) coArrBlkEl.style.display = co.hasArrears ? 'block' : 'none';
    if(co.hasArrears) {
      var _coBalEl = document.getElementById('coArrBalAmt');
      if(_coBalEl && co.arrBalAmt) {
        var _coBalNum = parseFloat(co.arrBalAmt) || 0;
        _coBalEl.value = _coBalNum ? formatCurrency(_coBalNum) : '';
      }
      var _coMonEl = document.getElementById('coArrMonthlyPayment');
      if(_coMonEl && co.arrMonthlyPayment) {
        var _coMonNum = parseFloat(co.arrMonthlyPayment) || 0;
        _coMonEl.value = _coMonNum ? formatCurrency(_coMonNum) : '';
      }
      var _coPlanEl = document.getElementById('coArrPlanMonths');
      if(_coPlanEl) _coPlanEl.value = co.arrPlanMonths || '';
      var _coAgrEl = document.getElementById('coArrAgreementDate');
      if(_coAgrEl) _coAgrEl.value = co.arrAgreementDate || '';
      var _coDueEl = document.getElementById('coArrFirstDueDate');
      if(_coDueEl) _coDueEl.value = co.arrFirstDueDate || '';
      var _coFreqEl = document.getElementById('coArrFrequency');
      if(_coFreqEl) _coFreqEl.value = co.arrFrequency || 'monthly';
    }
  }

  // ── Step 3: Household Members ──
  var habList = document.getElementById('habList');
  if(habList) {
    habList.innerHTML = '';
    var habitants = app.habitants || [];
    if(habitants.length) {
      habitants.forEach(function(h) {
        addHab();
        var rows = habList.querySelectorAll('.rrow');
        var row  = rows[rows.length - 1];
        var txts = row.querySelectorAll('input[type="text"]');
        var dts  = row.querySelectorAll('input[type="date"]');
        var sels = row.querySelectorAll('select');
        if(txts[0]) txts[0].value = h.fn || '';
        if(txts[1]) txts[1].value = h.ln || '';
        if(dts[0])  dts[0].value  = h.dob || '';
        if(sels[0]) sels[0].value = h.relationship || '';
      });
    }
  }

  // ── Step 4: References ──
  var refList = document.getElementById('refList');
  if(refList) {
    refList.innerHTML = '';
    var refs = app.references || [];
    if(refs.length) {
      refs.forEach(function(r) {
        if(!r.fn && !r.phone) return;
        addRef();
        var rows = refList.querySelectorAll('.rrow');
        var row  = rows[rows.length - 1];
        var txts = row.querySelectorAll('input[type="text"]');
        var tels = row.querySelectorAll('input[type="tel"]');
        var ems  = row.querySelectorAll('input[type="email"]');
        var sels = row.querySelectorAll('select');
        if(txts[0]) txts[0].value = r.fn || '';
        if(txts[1]) txts[1].value = r.ln || '';
        if(sels[0]) sels[0].value = r.relationship || '';
        if(tels[0]) tels[0].value = r.phone ? formatPhone(r.phone) : '';
        if(ems[0])  ems[0].value  = r.email || '';
      });
    }
  }

  // ── Step 5: Pets ──
  var petList = document.getElementById('petList');
  if(petList) {
    petList.innerHTML = '';
    var pets = app.pets || [];
    pets.forEach(function(p) {
      if(!p.type && !p.name) return;
      addPet();
      var rows = petList.querySelectorAll('.rrow');
      var row  = rows[rows.length - 1];
      var txts = row.querySelectorAll('input[type="text"]');
      var sels = row.querySelectorAll('select');
      var tas  = row.querySelectorAll('textarea');
      if(txts[0]) txts[0].value = p.name || '';
      if(sels[0]) sels[0].value = p.type || '';
      if(sels[1]) sels[1].value = p.size || '';
      if(tas[0])  tas[0].value  = p.desc || '';
    });
  }

  // ── Navigate to form ──
  showApp();
  goTo(0);

  // Update the app ID display
  var appNumCard = document.getElementById('appNumCard');
  if(appNumCard) appNumCard.textContent = app.id;

  // Show an "editing" banner in the form header
  var secHdr = document.querySelector('#step0 .sec-hdr p');
  if(secHdr) secHdr.innerHTML = '<span style="background:var(--yellow);color:var(--dark);font-size:11px;font-weight:700;padding:2px 8px;border-radius:4px;margin-right:6px;">Editing</span>' + app.id + ' — changes saved when you submit';

  // Show the modal
  var modal = document.getElementById('editModal');
  if(modal) modal.classList.add('on');

  // Update page header for editing
  var _name = ((app.fn||'')+' '+(app.ln||'')).trim();
  var _t = document.getElementById('appLayout_title');
  var _s = document.getElementById('appLayout_subtitle');
  var _ctx = document.getElementById('appLayout_ctx_bar');
  if(_t) _t.textContent = _name || 'Edit Application';
  if(_s) _s.innerHTML = '<span style="background:var(--yellow);color:var(--dark);font-size:11px;font-weight:700;padding:2px 8px;border-radius:4px;margin-right:6px;">Editing</span>' + app.id;
  if(_ctx) _ctx.style.display = 'flex';

  // ── Restore saved signature fields ──────────────────────────────────────
  function _setSigF(id, val){ var e=document.getElementById(id); if(e&&val) e.value=val; }
  // Restore an HM/ED decision <select> tolerant of value drift between the
  // approval workflow (confirmApprovalAction stores 'Approved'/'Declined'/
  // 'More Info Required') and this form's own dropdown options ('Recommended',
  // 'Returned - More Info Required', 'Approved', 'Deferred', ...). Without this
  // an HM recommendation saved via the approval modal came back blank on reopen
  // because 'Approved' matched no HM option.
  function _setDecisionSel(selectId, val){
    var sel=document.getElementById(selectId); if(!sel||!val) return;
    var want=String(val).trim().toLowerCase(), opts=sel.options, i;
    for(i=0;i<opts.length;i++){
      if(String(opts[i].value).trim().toLowerCase()===want || String(opts[i].text).trim().toLowerCase()===want){ sel.selectedIndex=i; return; }
    }
    var intent = /more info|return/.test(want) ? 'moreinfo'
               : /declin|reject/.test(want)    ? 'declined'
               : /defer/.test(want)            ? 'deferred'
               : /approv|recommend/.test(want) ? 'approve'
               : '';
    if(!intent) return;
    for(i=0;i<opts.length;i++){
      var t=String(opts[i].text).trim().toLowerCase(); if(!t) continue;
      if(intent==='moreinfo' && /more info|return/.test(t)){ sel.selectedIndex=i; return; }
      if(intent==='declined' && /declin/.test(t))          { sel.selectedIndex=i; return; }
      if(intent==='deferred' && /defer/.test(t))           { sel.selectedIndex=i; return; }
      if(intent==='approve'  && /approv|recommend/.test(t)){ sel.selectedIndex=i; return; }
    }
  }
  if(app.sig) {
    _setSigF('sig_name',    app.sig.applicant   && app.sig.applicant.name);
    _setSigF('sig_date',    app.sig.applicant   && app.sig.applicant.date);
    _setSigF('sig_co_name', app.sig.coApplicant && app.sig.coApplicant.name);
    _setSigF('sig_co_date', app.sig.coApplicant && app.sig.coApplicant.date);
    _setSigF('sig_staff',   app.sig.staff       && app.sig.staff.name);
    _setSigF('sig_recv',    app.sig.staff       && app.sig.staff.date);
    // Restore canvas drawings (deferred until step 8 is visible)
    window._pendingSigRestore = app.sig;
  }
  if(app.hmSig) {
    _setSigF('sig_hm_name',     app.hmSig.name);
    _setSigF('sig_hm_date',     app.hmSig.date);
    _setSigF('sig_hm_notes',    app.hmSig.notes);
    _setDecisionSel('sig_hm_decision', app.hmSig.decision);
  }
  if(app.edSig) {
    _setSigF('sig_ed_name',     app.edSig.name);
    _setSigF('sig_ed_date',     app.edSig.date);
    _setSigF('sig_ed_notes_sig',app.edSig.notes);
    _setDecisionSel('sig_ed_decision', app.edSig.decision);
  }

  // ── Restore V2 scoring fields ──
  function setV2(id, val) {
    var el = document.getElementById(id);
    if (!el) return;
    if (el.type === 'checkbox') el.checked = !!val;
    else if (val !== undefined && val !== null) el.value = String(val);
  }
  setV2('urgent_need',          app.urgentNeed          || app.urgent_need          || 'none');
  setV2('health_risk',          app.healthRisk          || app.health_risk          || 'none');
  setV2('persons_over_standard',app.personsOverStandard || app.persons_over_standard|| 0);
  setV2('lone_parent',          app.loneParent          || app.lone_parent);
  setV2('elder_in_household',   app.elderInHousehold    || app.elder_in_household);
  setV2('household_disability', app.householdDisability || app.household_disability);
  setV2('income_stability',     app.incomeStability     || app.income_stability     || 'stable');

  // Prior tenancy toggle — drives visibility of history fields
  var noPrior = (app.noPriorTenancy !== undefined) ? app.noPriorTenancy : (app.no_prior_tenancy !== undefined ? app.no_prior_tenancy : true);
  setV2('no_prior_tenancy', noPrior ? 'true' : 'false');
  var histFields = document.getElementById('tenancy_history_fields');
  if (histFields) histFields.style.display = noPrior ? 'none' : 'block';

  // HM-assessed fields — only populate if role allows
  setV2('rent_payment_history', app.rentPaymentHistory || app.rent_payment_history || 'no_history');
  setV2('unit_condition',       app.unitCondition      || app.unit_condition       || 'no_history');
  setV2('tenancy_conduct',      app.tenancyConduct     || app.tenancy_conduct      || 'no_history');

  // Homeless status — restored AFTER V2 fields so auto-populate of urgent_need
  // correctly sees the already-set dropdown value before deciding to override.
  var addrBlkEl = document.getElementById('addrBlk');
  if (addrBlkEl) addrBlkEl.style.display = app.homeless ? 'none' : '';
  tog('homelessToggle', app.homeless);

  // Apply role locks and trigger fresh V2 score
  applyTenancyFieldRoles();
  triggerV2Score();
  // Defensive recalc: at this point co_status and habList are fully populated,
  // so rerun the household totals so occ_total / occ_coapplicant / occ_members
  // reflect the loaded record (otherwise they show defaults from when the
  // edit form was first rendered with co_status='no' and an empty habList).
  if(typeof calcPersonsOverStandard === 'function') calcPersonsOverStandard();

  // Audit — log that this application was opened for editing
  var _editType = app.appType === 'existing_tenant' ? 'File Update' : 'New Housing';
  var _editStatus = (app.status||'draft').replace(/_/g,' ');
  auditEntry(app.id, 'application_opened', _editType + ' opened for editing — current status: ' + _editStatus, window.currentRole||'staff');

  showToast('Editing ' + _name, {type:'info'});
}



// ── sigBlock — top-level helper for printSOW (also used locally in previewFromDash) ──
// (sigBlock moved to shared-data.js so contractor pages can use it without
//  having to load housing-modals.js. printSOW() below still calls it — works
//  because shared-data.js loads before housing-modals.js.)



// ── Approval modal (open / close / confirm) ──────────────────────────────────
// Moved here from housing-init.js so it loads before init and is always in scope
// ── Approval modal ──
var _pendingApprovalAction = null;

function openApprovalModal(action, confirmLabel, requireNotes) {
  _pendingApprovalAction = { action: action, requireNotes: !!requireNotes };
  var app = window._currentScorecardApp;
  if(!app) return;
  var name = ((app.fn||'') + ' ' + (app.ln||'')).trim();

  var titleEl = document.getElementById('approvalModal_title');
  var subEl   = document.getElementById('approvalModal_sub');
  var notesEl = document.getElementById('approvalModal_notes');
  var reqEl   = document.getElementById('approvalModal_notes_req');
  var confirmEl = document.getElementById('approvalModal_confirm');

  if(titleEl) titleEl.textContent = confirmLabel || action;
  if(subEl)   subEl.textContent   = name + ' · ' + app.id;
  if(notesEl) notesEl.value = '';
  if(reqEl)   reqEl.textContent = requireNotes ? '*' : '';
  if(confirmEl) {
    confirmEl.className = 'btn ' + (action === 'declined' ? 'btn-dark' : action === APP_STATUS.ED_APPROVED || action === APP_STATUS.MGR_APPROVED || action === 'hm_approved' ? 'btn-green' : 'btn-primary');
  }

  var modal = document.getElementById('approvalModal');
  if(modal) modal.style.display = 'flex';
}

function closeApprovalModal() {
  var modal = document.getElementById('approvalModal');
  if(modal) modal.style.display = 'none';
  _pendingApprovalAction = null;
}

function confirmApprovalAction() {
  if(!_pendingApprovalAction) return;
  var action = _pendingApprovalAction.action;
  var requireNotes = _pendingApprovalAction.requireNotes;
  var notesEl = document.getElementById('approvalModal_notes');
  var notes = notesEl ? notesEl.value.trim() : '';

  if(requireNotes && !notes) {
    showToast('Please add notes explaining this decision.', {type:'error'});
    if(notesEl) notesEl.focus();
    return;
  }

  var app = window._currentScorecardApp;
  if(!app) { closeApprovalModal(); return; }

  // BCR / ineligibility gate — warn before approving/assigning a banished person.
  if (typeof bcrLookup === 'function' && ['mgr_approved','hm_approved','ed_approved','assigned'].indexOf(action) !== -1) {
    var _bcrNm  = ((app.fn||'') + ' ' + (app.ln||'')).trim() || app.applicant_name || '';
    var _bcrRec = bcrLookup(_bcrNm);
    if (_bcrRec && !window.confirm(
        _bcrNm + ' is on the BCR (banishment) list'
        + (_bcrRec.bcrd_date ? ' as of ' + _bcrRec.bcrd_date : '')
        + ' and is NOT eligible for housing.'
        + (_bcrRec.reason ? '\n\nReason: ' + _bcrRec.reason : '')
        + '\n\nProceed with this approval anyway?')) {
      return;
    }
  }

  // Policy 8.4(h) — years-between-allocations rule (configurable, Settings >
  // Policy Rules). A prior new-housing allocation inside the window makes
  // final approval an ED exception: explicit confirm + an audit row.
  if (typeof policyPriorAllocation === 'function' && action === 'ed_approved') {
    var _pa = policyPriorAllocation(app);
    if (_pa) {
      var _paYears = (typeof policyParam === 'function') ? policyParam('rehousing_years', 'years', 15) : 15;
      if (!window.confirm(
          ((app.fn||'') + ' ' + (app.ln||'')).trim() + ' was allocated housing on ' + _pa.when
          + ' — inside the ' + _paYears + '-year re-housing window' + ((typeof policyCite==='function' && policyCite('rehousing_years')) ? ' (' + policyCite('rehousing_years') + ', application ' + _pa.appId + ')' : ' (application ' + _pa.appId + ')') + '.'
          + '\n\nApproving anyway is an ED EXCEPTION and will be recorded in the audit log.\n\nProceed?')) {
        return;
      }
      if (typeof auditEntry === 'function') auditEntry(app.id, 'policy_exception',
        'ED exception to the ' + _paYears + '-year re-housing rule' + ((typeof policyCiteSuffix==='function')?policyCiteSuffix('rehousing_years'):'') + ' — prior allocation ' + _pa.when + ' on ' + _pa.appId, window.currentRole || 'staff');
    }
  }

  // Find and update the application
  var idx = applications.findIndex(function(a){ return a.id === app.id; });
  if(idx === -1) { showToast('Application not found', {type:'error'}); closeApprovalModal(); return; }

  var oldStatus = applications[idx].status;
  applications[idx].status = action;
  if(notes) applications[idx].lastActionNotes = notes;
  applications[idx].lastActionBy   = window.currentRole || 'staff';
  applications[idx].lastActionAt   = new Date().toISOString();

  // Declining an ALREADY-ASSIGNED applicant must unwind the unit, or it stays
  // occupied/reserved with no live tenancy. (Ported from the retired dashboard
  // decline path when that dead code was removed — this is the only live
  // decline flow now.)
  if(action === 'declined' && applications[idx].assignedUnit){
    var _duHad = applications[idx].assignedUnit;
    var _duAll = (typeof housingUnits !== 'undefined') ? housingUnits : [];
    var _duIdx = _duAll.findIndex(function(u){ return u.id === _duHad; });
    if(_duIdx >= 0){
      var _du = _duAll[_duIdx];
      var _duAddr = ((_du.num||'')+' '+(_du.street||'')).trim() || _duHad;
      _du.assignedTo = ''; _du.assignedName = ''; _du.assignedDate = '';
      _du.tenantApprovedBy = ''; _du.tenantApprovedAt = '';
      _du.transferPending = false; _du.status = 'vacant';
      _duAll[_duIdx] = _du;
      saveUnitWithDraftFallback(_du).then(function(ok){
        if(!ok) showToast('Unit unassignment saved locally — will sync when network is available.', { type:'info' });
      });
      auditEntry(_du.id, 'unit_unassigned', _duAddr + ' returned to vacant — applicant declined', window.currentRole || 'staff');
    }
    applications[idx].assignedUnit = '';
    applications[idx].assignedAddress = '';
    applications[idx].assignmentOverrideNotes = '';
    applications[idx].transferPending = false;
  }

  // ── Capture approval signatures at each stage ──────────────────────────
  function _fv(id){ var e=document.getElementById(id); return e?e.value.trim():''; }
  var role = window.currentRole || 'staff';
  var today = new Date().toISOString().split('T')[0];

  if(action === APP_STATUS.MGR_APPROVED || action === 'returned' || action === 'declined') {
    // Housing Manager action — save HM signature data
    applications[idx].hmSig = {
      name:     _fv('sig_hm_name') || (role === ROLE.HOUSING_MANAGER ? CLFN_PERMS.roleLabel(ROLE.HOUSING_MANAGER) : ''),
      date:     _fv('sig_hm_date') || today,
      decision: action === APP_STATUS.MGR_APPROVED ? 'Approved' : action === 'declined' ? 'Declined' : 'More Info Required',
      notes:    notes || _fv('sig_hm_notes'),
      approvedAt: today,
      approvedBy: role
    };
  }
  if(action === APP_STATUS.ED_APPROVED || (action === 'declined' && role === ROLE.ED)) {
    // Executive Director final approval — save ED signature + create final snapshot
    applications[idx].edSig = {
      name:     _fv('sig_ed_name') || (role === ROLE.ED ? CLFN_PERMS.roleLabel(ROLE.ED) : ''),
      date:     _fv('sig_ed_date') || today,
      decision: action === APP_STATUS.ED_APPROVED ? 'Approved' : 'Declined',
      notes:    notes || _fv('sig_ed_notes_sig'),
      approvedAt: today,
      approvedBy: role
    };
  }
  if(action === APP_STATUS.ED_APPROVED) {
    // ── FINAL APPROVAL SNAPSHOT ──────────────────────────────────────────
    // Save a complete snapshot of the approved application with all fields
    applications[idx].finalApprovalSnapshot = {
      snapshotAt:  new Date().toISOString(),
      snapshotBy:  role,
      status:      APP_STATUS.ED_APPROVED,
      applicant:   { fn: applications[idx].fn, ln: applications[idx].ln, id: applications[idx].id },
      score:       applications[idx].score,
      tier:        applications[idx].tier,
      hmSig:       applications[idx].hmSig || null,
      edSig:       applications[idx].edSig || null,
      sig:         applications[idx].sig   || null,
      scoreBreakdown: applications[idx].scoreBreakdown || {}
    };
  }

  // Persist via the local-first wrapper so a PGRST303 / 401 on iPad doesn't
  // drop the approval action.
  saveApplicationWithDraftFallback(applications[idx]);

  // Audit
  auditEntry(app.id, 'status_change',
    'Status changed from ' + oldStatus + ' to ' + action + (notes ? ' — ' + notes : ''),
    window.currentRole || 'staff');

  // Update scorecard display
  window._currentScorecardApp = applications[idx];

  if (typeof notifyApplicationStatusChange === 'function') {
    notifyApplicationStatusChange(applications[idx], action, notes);
  }

  closeApprovalModal();

  // Refresh dashboard table and match view to reflect new status
  if(typeof renderDashTable === 'function') renderDashTable();
  if(typeof updateDashStats === 'function') updateDashStats();
  if(typeof renderMatchView === 'function' && document.getElementById('matchView') && document.getElementById('matchView').style.display !== 'none') renderMatchView();

  // Refresh the landing-page worklist + KPIs so an actioned application leaves
  // the worklist immediately (previously it lingered until you navigated away
  // and back, because the home view was never re-rendered after the action).
  if(typeof renderWorklist === 'function' && document.getElementById('worklist_body')) renderWorklist();
  if(typeof _renderLandingKpis === 'function') _renderLandingKpis();

  // Status label descriptions
  var statusDesc = {
    mgr_approved: 'Recommended to Executive Director',
    hm_approved:  'File Update Approved',
    ed_approved:  'Final Approval Granted',
    declined:     'Application Declined',
    returned:     'Returned for More Information',
    submitted:    'Returned to Review Queue'
  };

  showToast((statusDesc[action] || action) + ' — ' + ((app.fn||'') + ' ' + (app.ln||'')).trim(), {type:'info'});

  // Hand-off: final approval of a scored applicant with no unit -> offer to jump
  // straight to Match so an approved applicant doesn't sit in limbo.
  var _fa = applications[idx];
  if (action === 'ed_approved' && _fa && (_fa.appType === 'new_housing' || _fa.appType === 'transfer_request')
      && !_fa.assignedUnit && typeof showConfirm === 'function') {
    showConfirm({
      title:   'Approved — ready to match',
      message: ((_fa.fn||'') + ' ' + (_fa.ln||'')).trim() + ' is approved and awaiting a unit. Go to the Match page to assign one?',
      confirmText: 'Go to Match →', cancelText: 'Later'
    }).then(function(ok){
      if (ok) { if (typeof showMatch === 'function') showMatch(); else window.location.href = 'match.html'; }
    });
  }

  // Return to the refreshed landing page after any approval/decision action
  if(typeof showDash === 'function') {
    showDash();
  } else {
    // Fallback: refresh scorecard buttons and dashboard in place
    if(typeof renderScorecardActions === 'function') renderScorecardActions(applications[idx]);
    if(typeof updateDashStats === 'function') updateDashStats();
    if(typeof renderDashTable === 'function') renderDashTable();
  }
}
