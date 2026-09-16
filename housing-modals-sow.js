/* ============================================================
 * housing-modals-sow.js — SOW (Scope of Work) modal & helpers
 *
 * Extracted from housing-modals.js for size. Covers:
 *   - SOW photos & documents widget (window._sowFiles staging)
 *   - openSowModal / saveSOW / markSowComplete / reopenSow
 *   - SOW lock & permission helpers (canEditSow, canMarkSowComplete, …)
 *   - SOW table on the Edit Unit card (udpRenderSowTable, udpNewSow, …)
 *   - printSOW (print template)
 *
 * Loaded AFTER housing-modals.js because:
 *   - _currentDetailUnitId is declared in housing-modals.js
 *   - The SOW table renderer is invoked from openUnitEditModal there
 * ============================================================ */

// ══════════════════════════════════════════════════════════
// RENOVATION SCOPE OF WORK
// ══════════════════════════════════════════════════════════

// SOW modal state — which unit's SOW is currently open and which line item
// index is being edited inline. Reset by openSowModal / closeSowModal.
var _sowUnitId  = null;
var _sowItemIdx = 0;


// ── SOW Photos & Documents widget ───────────────────────────────────────────
// Files list is staged on window._sowFiles while the modal is open; saveSOW()
// writes it to data.files, populateSow() restores it. Files are uploaded
// directly to Supabase Storage via sbUploadAndSave() — same bucket as photos.
window._sowFiles      = [];
window._SOW_MAX_BYTES = 50 * 1024 * 1024; // 50MB cumulative cap

function _sowFileIcon(name, type) {
  var n = (name || '').toLowerCase();
  if ((type||'').indexOf('image/') === 0) return '🖼️';        // 🖼
  if (n.endsWith('.pdf'))                   return '📄';            // 📄
  if (/\.(xlsx?|csv)$/.test(n))             return '📊';            // 📊
  if (/\.(docx?|txt|rtf)$/.test(n))         return '📝';            // 📝
  return '📎';                                                       // 📎
}
function _sowFmtSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024)              return bytes + ' B';
  if (bytes < 1024 * 1024)       return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
function _sowTotalBytes() {
  return (window._sowFiles || []).reduce(function(sum, f){ return sum + (f.size || 0); }, 0);
}
function renderSowFiles() {
  var list = document.getElementById('sow_files_list');
  var meta = document.getElementById('sow_files_size');
  if (!list) return;
  var files = window._sowFiles || [];
  if (meta) {
    var used = _sowTotalBytes();
    var pct  = Math.round(used / window._SOW_MAX_BYTES * 100);
    meta.textContent = files.length
      ? _sowFmtSize(used) + ' of 50 MB used (' + pct + '%)'
      : '';
    meta.classList.toggle('is-warn', used >= window._SOW_MAX_BYTES);
  }
  if (!files.length) {
    list.innerHTML = '<div class="file-list-empty">No photos or documents attached.</div>';
    return;
  }
  list.innerHTML = files.map(function(f){
    var icon  = _sowFileIcon(f.name, f.type);
    var size  = _sowFmtSize(f.size);
    var added = f.addedAt || '';
    var pathAttr = (f.path || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    return '<div class="file-row">'
      + '<span class="file-icon">' + icon + '</span>'
      + '<span class="file-name">' + (f.name || f.path || '—') + '</span>'
      + '<span class="file-meta">' + size + (added ? ' &middot; ' + added : '') + '</span>'
      + '<span class="file-actions">'
        + '<button type="button" class="file-download" onclick="_sowViewFile(\'' + pathAttr + '\')" title="View">View</button>'
        + '<button type="button" class="file-delete" onclick="removeSowFile(\'' + pathAttr + '\')" title="Remove">&times;</button>'
      + '</span>'
      + '</div>';
  }).join('');
}
async function handleSowFileUpload(input) {
  var files = Array.from(input.files || []);
  if (!files.length) return;
  if (!_sowUnitId) {
    showToast('Save the request first or open it on a unit before attaching files.', {type:'error'});
    input.value = '';
    return;
  }
  // Cumulative size check
  var available = window._SOW_MAX_BYTES - _sowTotalBytes();
  var queued = 0, accepted = [];
  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    if (queued + f.size > available) {
      showToast('Skipped "' + f.name + '" — would exceed 50 MB limit.', {type:'info'});
      continue;
    }
    queued += f.size;
    accepted.push(f);
  }
  if (!accepted.length) { input.value = ''; return; }
  var zone = document.getElementById('sow_drop_zone');
  if (zone) zone.classList.add('is-drag');
  try {
    for (var j = 0; j < accepted.length; j++) {
      var rec = await sbUploadAndSave('sow', _sowUnitId, accepted[j], 'units/' + _sowUnitId + '/sow_files');
      window._sowFiles.push(rec);
    }
    renderSowFiles();
    showToast('✓ ' + accepted.length + ' file' + (accepted.length > 1 ? 's' : '') + ' attached', {type:'info'});
  } catch (e) {
    console.warn('[SOW FILE] upload failed:', e);
    showToast('Upload failed: ' + (e.message || 'unknown error'), {type:'error'});
  }
  if (zone) zone.classList.remove('is-drag');
  input.value = '';
}
function sowFileDrop(e) {
  e.preventDefault();
  var zone = document.getElementById('sow_drop_zone');
  if (zone) zone.classList.remove('is-drag');
  var dt = e.dataTransfer;
  if (!dt || !dt.files || !dt.files.length) return;
  // Reuse handleSowFileUpload by faking an input shape
  handleSowFileUpload({ files: dt.files, value: '' });
}
// Open the file in a new tab for viewing (inline for PDFs/images), matching
// the DocLibrary "View" action used everywhere else — standardized on viewing
// rather than downloading.
async function _sowViewFile(path) {
  if (!path) return;
  try {
    var url = (typeof sbGetSignedUrl === 'function')
      ? await sbGetSignedUrl(path)
      : null;
    if (url) { window.open(url, '_blank', 'noopener'); }
    else { showToast('Could not generate a link for that file.', {type:'error'}); }
  } catch(e) {
    console.warn('[SOW FILE] view failed:', e);
    showToast('Could not open file: ' + (e.message || 'unknown error'), {type:'error'});
  }
}
// Back-compat alias in case any cached markup still calls the old name.
// (_sowDownloadFile alias removed — zero call sites)
window._sowViewFile = _sowViewFile;
async function removeSowFile(path) {
  if (!path) return;
  var ok = await showConfirm({
    title:       'Remove this file?',
    message:     'The file will be deleted from this Maintenance Request. This cannot be undone.',
    confirmText: 'Remove',
    danger:      true
  });
  if (!ok) return;
  try {
    if (typeof sbDeleteFile === 'function') await sbDeleteFile(path);
  } catch (e) { console.warn('[SOW FILE] delete failed:', e); }
  window._sowFiles = (window._sowFiles || []).filter(function(f){ return f.path !== path; });
  renderSowFiles();
}

var SOW_CATEGORIES = [
  'Foundation / Structure','Roofing','Exterior Walls / Siding','Windows & Doors',
  'Insulation','Plumbing','Electrical','Heating / HVAC','Interior Walls / Drywall',
  'Flooring','Kitchen','Bathroom','Painting','Accessibility Modifications','Other'
];

// ════════════════════════════════════════════════════════════════════════════
// SOW MODAL TEMPLATE — single source of truth
// ════════════════════════════════════════════════════════════════════════════
// Until Stop B the SOW modal markup was duplicated across renos.html,
// inventory.html, match.html, and tenants.html — four copies that drifted
// (renos.html was an older variant missing project number, file uploads,
// mark-complete/reopen buttons, and used inline styles instead of semantic
// classes). The template lives here now; each page just hosts an empty
// <div id="sowModalHost"></div> and openSowModal() mounts the template on
// first call via _ensureSowModal().
//
// Sections are wrapped in 7 .tic-panel containers (same hero/strip/tabs shell
// as the TIC and Edit Unit card) so the modal can scroll far less on
// iPad/iPhone (Stop C tab refactor):
//   overview     — Unit Information + Condition Assessment
//   scope        — Scope of Work Items + Photos & Documents
//   safety       — Health & Safety Concerns
//   acct         — Tenant Accountability (no longer collapsible; tabs handle it)
//   notes        — Additional Notes + Terms & Conditions
//   sigs         — Signatures & Acknowledgement (Required)
//   approvals    — HM + ED approval fields
//
// All element IDs and onclick handlers are preserved exactly so existing JS
// (saveSOW, addSowItem, setSigMethod, clearSig, sowContractorSearch,
// markSowComplete, reopenSow, archiveCurrentSow, handleSowFileUpload,
// photoDragOver, photoDragLeave, sowFileDrop, printSOW, printWorkOrder,
// closeSowModal) keeps working unchanged.
function _buildSowModalHTML() {
  return '' +
    '<div class="tic-shell">' +

      // ── Hero ─────────────────────────────────────────────────────────────
      '<div class="tic-hero">' +
        '<div class="tic-hero-main">' +
          '<div class="lbl-uppercase-sm" data-nation-template="{NATION} — Housing">Constance Lake First Nation — Housing</div>' +
          '<h2 id="sow_unit_label" class="tic-name">—</h2>' +
          '<div class="sow-pn-row"><span class="sow-pn-lbl">Project #</span><span id="sow_project_number_label" class="sow-pn-val"></span></div>' +
        '</div>' +
        '<button type="button" onclick="closeSowModal()" class="tic-close-btn" aria-label="Close">✕</button>' +
      '</div>' +

      // ── Info strip ───────────────────────────────────────────────────────
      // 4 tiles only — Fund Source and Condition are one tap away on the
      // Overview tab immediately below, so the strip sticks to the fields
      // worth a glance without opening a tab: workflow state, budget, who's
      // doing it, and when it's due.
      '<div class="tic-strip">' +
        '<div class="tic-strip-tile"><span class="tic-strip-icon">🛠️</span><div class="tic-strip-lbl">Status</div><div id="sow_strip_status" class="tic-strip-val">—</div></div>' +
        '<div class="tic-strip-tile"><span class="tic-strip-icon">💰</span><div class="tic-strip-lbl">Est. Cost</div><div id="sow_strip_cost" class="tic-strip-val">—</div></div>' +
        '<div class="tic-strip-tile"><span class="tic-strip-icon">👷</span><div class="tic-strip-lbl">Assigned To</div><div id="sow_strip_assigned" class="tic-strip-val">—</div></div>' +
        '<div class="tic-strip-tile"><span class="tic-strip-icon">📅</span><div class="tic-strip-lbl">Target Completion</div><div id="sow_strip_target" class="tic-strip-val">—</div></div>' +
      '</div>' +

      // Read-only banner (shown when SOW is marked Complete and locked)
      '<div id="sow_readonly_banner" class="banner-strip-success" style="display:none;margin:12px 28px 0;"><span class="banner-icon">🔒</span>This Maintenance Request is marked Completed and is read-only. Only the Executive Director can reopen or modify a completed request.</div>' +

      // ── Tabs ─────────────────────────────────────────────────────────────
      '<div class="tic-tabs" id="sow_tab_bar" role="tablist">' +
        '<button type="button" class="tic-tab tic-active" data-modal-tab="overview"  onclick="setSowTab(\'overview\')"  role="tab">Overview</button>' +
        '<button type="button" class="tic-tab"            data-modal-tab="scope"     onclick="setSowTab(\'scope\')"     role="tab">Work Items</button>' +
        '<button type="button" class="tic-tab"            data-modal-tab="workorder" onclick="setSowTab(\'workorder\')" role="tab">Work Order</button>' +
        '<button type="button" class="tic-tab"            data-modal-tab="payments"  onclick="setSowTab(\'payments\')"  role="tab" id="sow_tab_payments">Payments</button>' +
        '<button type="button" class="tic-tab"            data-modal-tab="contracting" onclick="setSowTab(\'contracting\')" role="tab" id="sow_tab_contracting">Contracting</button>' +
        '<button type="button" class="tic-tab"            data-modal-tab="documents" onclick="setSowTab(\'documents\')" role="tab">Documents</button>' +
        '<button type="button" class="tic-tab"            data-modal-tab="safety"    onclick="setSowTab(\'safety\')"    role="tab">Health &amp; Safety</button>' +
        '<button type="button" class="tic-tab"            data-modal-tab="acct"      onclick="setSowTab(\'acct\')"      role="tab">Accountability</button>' +
        '<button type="button" class="tic-tab"            data-modal-tab="notes"     onclick="setSowTab(\'notes\')"     role="tab">Notes &amp; Terms</button>' +
        '<button type="button" class="tic-tab"            data-modal-tab="sigs"      onclick="setSowTab(\'sigs\')"      role="tab">Signatures</button>' +
      '</div>' +

      // ── Body / tab panels ────────────────────────────────────────────────
      '<div class="tic-body">' +

        // ── OVERVIEW ─────────────────────────────────────────────────────
        '<div class="tic-panel tic-active" data-modal-panel="overview">' +
          '<div class="tic-section">' +
            '<div class="tic-section-h">Unit Information</div>' +
            '<div class="grid-c2-10">' +
              '<div class="f"><label>Unit Address</label><input id="sow_address" type="text" placeholder="e.g. 11 Musko Road"/></div>' +
              '<div class="f"><label>Date Prepared</label><input id="sow_date" type="date"/></div>' +
              '<div class="f"><label>Current Tenant Name</label><input id="sow_tenant_name" type="text" placeholder="Full name of tenant"/></div>' +
              '<div class="f"><label>Prepared By (Staff)</label><input id="sow_prepared_by" type="text" placeholder="Staff name"/></div>' +
              '<div class="f"><label>PO Number <span style="font-size:10px;font-weight:400;color:var(--muted);">(from accounting)</span></label><input id="sow_po_number" type="text" placeholder="e.g. PO-2026-0042"/></div>' +
              '<div class="f sow-ct-row"><label>Assigned To</label>' +
                '<input id="sow_contractor" type="text" placeholder="Search — your Housing Dept or a contractor…" autocomplete="off"' +
                  ' oninput="sowContractorSearch(this.value)" onfocus="sowContractorSearch(\'\')"' +
                  ' onblur="setTimeout(function(){var d=document.getElementById(\'sow_ct_dropdown\');if(d)d.style.display=\'none\';},180)"/>' +
                '<input type="hidden" id="sow_contractor_id"/>' +
                '<input type="hidden" id="sow_assigned_team"/>' +
                '<div id="sow_ct_dropdown"></div>' +
                // Employee sub-menu — revealed when the in-house Housing Dept is picked.
                '<select id="sow_assigned_to" style="margin-top:6px;display:none;">' +
                  '<option value="">— Select field employee —</option>' +
                '</select>' +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div class="tic-section">' +
            '<div class="tic-section-h">Condition Assessment</div>' +
            '<div class="grid-c2-10">' +
              '<div class="f"><label>Overall Condition</label>' +
                '<select id="sow_condition">' +
                  '<option value="">— Select —</option>' +
                  '<option value="Good">Good — minor maintenance only</option>' +
                  '<option value="Fair">Fair — moderate repairs needed</option>' +
                  '<option value="Poor">Poor — significant repairs needed</option>' +
                  '<option value="Critical">Critical — unsafe / condemned</option>' +
                '</select>' +
              '</div>' +
              '<div class="f"><label>Fund Source <span id="sow_fund_badge" style="display:none;margin-left:6px;padding:1px 8px;border-radius:10px;font-size:10px;font-weight:700;vertical-align:middle;"></span></label>' +
                '<select id="sow_fund_source" onchange="_sowUpdateFundBadge(this.value)">' +
                  '<option value="">— Select fund source —</option>' +
                '</select>' +
                '<div id="sow_fund_rule" style="font-size:10px;color:var(--muted);margin-top:3px;"></div>' +
              '</div>' +
              '<div class="f"><label>Target Start Date</label><input id="sow_start_date" type="date"/></div>' +
              '<div class="f"><label>Target Completion Date</label><input id="sow_end_date" type="date"/></div>' +
            '</div>' +
          '</div>' +
        '</div>' +

        // ── SCOPE OF WORK ────────────────────────────────────────────────
        // Estimated Total Cost sits HERE (not on Overview) because the
        // value is auto-calculated from the SOW Items list above it —
        // reading top-to-bottom: itemize the work → see the total.
        '<div class="tic-panel" data-modal-panel="scope">' +
          '<div class="tic-section">' +
            '<div class="tic-section-h">Work Items</div>' +
            '<div id="sow_items"></div>' +
            '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px;">' +
              '<button type="button" onclick="addSowItem()" class="sow-add-item-btn">+ Add Work Item</button>' +
              '<button type="button" id="sow_quote_ai_btn" onclick="sowUploadQuoteClick()" class="btn btn-ghost btn-sm" title="Upload a contractor quote (PDF or photo) and let AI fill in the work items">✦ Auto-fill from quote</button>' +
              '<button type="button" id="sow_scope_ai_btn" onclick="sowDraftScopeClick()" class="btn btn-ghost btn-sm" title="Describe the job in plain words (e.g. bathroom renovation) and AI drafts the scope of work">✦ Draft scope with AI</button>' +
              '<input type="file" id="sow_quote_file" accept="application/pdf,image/*" style="display:none;" onchange="_sowQuotePicked(this)"/>' +
            '</div>' +
          '</div>' +
          '<div class="tic-section">' +
            '<div class="tic-section-h">Estimated Total Cost</div>' +
            '<div class="grid-c2-10">' +
              '<div class="f"><label>Sum of items above</label><input id="sow_total_cost" type="text" placeholder="Auto-calculated" readonly class="sow-total-cost-input"/></div>' +
            '</div>' +
          '</div>' +
        '</div>' +

        // ── DOCUMENTS ────────────────────────────────────────────────────
        // Photos + supporting documents (PDFs, quotes, inspection reports).
        // Split out of the Scope of Work tab so files don't compete with
        // the work-items list for screen space, especially on tablet.
        '<div class="tic-panel" data-modal-panel="documents">' +
          '<div class="tic-section">' +
            '<div class="tic-section-h flex-sb"><span>Photos &amp; Documents</span><span id="sow_files_size" class="file-list-meta"></span></div>' +
            '<div id="sow_drop_zone" class="upload-zone"' +
              ' ondragover="photoDragOver(event,\'sow_drop_zone\')"' +
              ' ondragleave="photoDragLeave(\'sow_drop_zone\')"' +
              ' ondrop="sowFileDrop(event)"' +
              ' onclick="document.getElementById(\'sow_files_input\').click()">' +
              '<svg class="upload-zone-icon" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>' +
              '<div class="upload-zone-title">Drag files here or <span class="link-yellow">browse</span></div>' +
              '<div class="txt-muted-xs">Photos · PDF · DOC/DOCX · XLS/XLSX · CSV · TXT — up to 50 MB total</div>' +
              '<input type="file" id="sow_files_input" accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.csv,.txt" multiple onchange="handleSowFileUpload(this)"/>' +
            '</div>' +
            '<div id="sow_files_list" class="file-list"></div>' +
          '</div>' +
        '</div>' +

        // ── HEALTH & SAFETY ──────────────────────────────────────────────
        '<div class="tic-panel" data-modal-panel="safety">' +
          '<div class="tic-section">' +
            '<div class="tic-section-h">Health &amp; Safety Concerns</div>' +
            '<div class="grid-c3-tight">' +
              '<label class="check-row"><input type="checkbox" id="sow_mold" class="icon-sm"/> Mould / Mildew</label>' +
              '<label class="check-row"><input type="checkbox" id="sow_asbestos" class="icon-sm"/> Asbestos Risk</label>' +
              '<label class="check-row"><input type="checkbox" id="sow_electrical" class="icon-sm"/> Electrical Hazard</label>' +
              '<label class="check-row"><input type="checkbox" id="sow_structural" class="icon-sm"/> Structural Concern</label>' +
              '<label class="check-row"><input type="checkbox" id="sow_plumbing" class="icon-sm"/> Plumbing / Sewage</label>' +
              '<label class="check-row"><input type="checkbox" id="sow_fire" class="icon-sm"/> Fire Safety</label>' +
            '</div>' +
          '</div>' +
        '</div>' +

        // ── ACCOUNTABILITY ───────────────────────────────────────────────
        '<div class="tic-panel" data-modal-panel="acct">' +
          '<div class="tic-section">' +
            '<div class="tic-section-h">Tenant Accountability</div>' +
            '<div class="sow-acct-hint">Record factors that affect renovation priority and tenant responsibility.</div>' +
            '<div class="sow-acct-list">' +
              '<div class="ftog"><label class="tsw"><input type="checkbox" id="sow_rent_arrears"/><span class="tsl"></span></label><label for="sow_rent_arrears" class="txt-sm-bold">Tenant has rent arrears</label></div>' +
              '<div class="ftog"><label class="tsw"><input type="checkbox" id="sow_tenant_damage"/><span class="tsl"></span></label><label for="sow_tenant_damage" class="txt-sm-bold">Damage caused by tenant</label></div>' +
              '<div class="ftog"><label class="tsw"><input type="checkbox" id="sow_negligence"/><span class="tsl"></span></label><label for="sow_negligence" class="txt-sm-bold">Negligence (failure to maintain / report issues)</label></div>' +
              '<div class="ftog"><label class="tsw"><input type="checkbox" id="sow_vandalism"/><span class="tsl"></span></label><label for="sow_vandalism" class="txt-sm-bold">Vandalism</label></div>' +
              '<div class="ftog"><label class="tsw"><input type="checkbox" id="sow_police_report"/><span class="tsl"></span></label><label for="sow_police_report" class="txt-sm-bold">Police report on file</label></div>' +
            '</div>' +
            '<div class="f"><label>Accountability Notes</label>' +
              '<textarea id="sow_accountability_notes" rows="2" placeholder="Details on tenant responsibility, incident dates, report numbers…"></textarea>' +
            '</div>' +
          '</div>' +
        '</div>' +

        // ── NOTES & TERMS ────────────────────────────────────────────────
        '<div class="tic-panel" data-modal-panel="notes">' +
          '<div class="tic-section">' +
            '<div class="tic-section-h">Additional Notes</div>' +
            '<div class="f"><label>Special Instructions / Access Requirements</label>' +
              '<textarea id="sow_notes" rows="3" placeholder="Any additional context, access requirements, tenant considerations…"></textarea>' +
            '</div>' +
          '</div>' +
          // Terms & Conditions default to COLLAPSED — the section is long
          // boilerplate that users rarely need to read in full once they've
          // seen it once. The accordion uses the shared .collapsible-card
          // pattern (toggling .is-collapsed on the wrapper hides the
          // .collapsible-body and rotates the chevron).
          '<div class="tic-section collapsible-card is-collapsed">' +
            '<div class="tic-section-h flex-sb collapsible-head" onclick="this.parentElement.classList.toggle(\'is-collapsed\')">' +
              '<span>Terms &amp; Conditions</span>' +
              '<svg class="collapsible-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>' +
            '</div>' +
            '<div id="sow_terms_body" class="sow-terms-body collapsible-body">' +
              '<p class="sow-terms-eyebrow" data-nation-template="{NATION} — Housing Department">Constance Lake First Nation — Housing Department</p>' +
              '<p class="sow-terms-lead">By completing and submitting this Maintenance Request, the submitting party acknowledges and agrees to the following terms.</p>' +
              '<div class="flex-col-12">' +
                '<div class="yellow-accent"><div class="lbl-field">1. Prioritization of Requests</div><p class="txt-muted-sm">Renovation requests are assessed and prioritized based on the urgency of need, health and safety risk to occupants, and the overall condition of the unit. Requests involving immediate hazards — including structural, electrical, plumbing, or fire safety concerns — are given priority consideration over general maintenance and cosmetic work.</p></div>' +
                '<div class="yellow-accent"><div class="lbl-field">2. Funding Eligibility &amp; Unit Qualifying Criteria</div><p class="txt-muted-sm">Approval is subject to available funding and the qualifying criteria of the unit under its applicable program (e.g. ISC, CMHC Section 95, CMHC Section 56.1, or Band-funded). Not all units qualify under all funding sources, and funding availability may affect the scope, cost ceiling, or timing of approved work. Requests will be assessed against the current budget allocation for the relevant funding pool.</p></div>' +
                '<div class="yellow-accent"><div class="lbl-field">3. Budget Authority &amp; Approval Routing</div><p class="txt-muted-sm">Renovation requests within the Housing Manager’s approved budget authority may be approved by the Housing Manager. Any request exceeding that threshold — as established in the Housing Department’s current budget policy — requires Executive Director approval before work may commence. No work is to be initiated until all required approvals have been obtained and documented.</p></div>' +
                '<div class="yellow-accent"><div class="lbl-field">4. Tenant Responsibilities</div><p class="txt-muted-sm">The tenant is required to provide timely and reasonable access to the unit for inspection, assessment, and the completion of approved work. Damage, negligence, or vandalism attributed to the tenant may reduce the priority of the request and may result in the tenant being held financially responsible for a portion of repair costs, as determined by the Housing Manager.</p></div>' +
                '<div class="yellow-accent"><div class="lbl-field">5. No Guarantee of Approval or Timeline</div><p class="txt-muted-sm">Submission of this form does not guarantee approval or a specific completion date. The <span data-nation="short">CLFN</span> Housing Department will communicate decisions in writing. Priority and scheduling are subject to change based on available resources, contractor availability, and emerging urgent needs within the community.</p></div>' +
                '<div class="yellow-accent"><div class="lbl-field">6. Accuracy of Information</div><p class="txt-muted-sm">All information provided in this Maintenance Request must be accurate and complete. Submitting false or misleading information may result in the request being cancelled, delayed, or referred for further review.</p></div>' +
              '</div>' +
              '<p class="sow-terms-foot">By signing below, the tenant and the housing staff member confirm they have read, understood, and agree to these terms.</p>' +
            '</div>' +
          '</div>' +
        '</div>' +

        // ── SIGNATURES ───────────────────────────────────────────────────
        '<div class="tic-panel" data-modal-panel="sigs">' +
          '<div class="tic-section">' +
            '<div class="tic-section-h">Signatures &amp; Acknowledgement<span class="lbl-required">Required</span></div>' +
            '<div id="sow_sig_body" class="sow-sig-body">' +
              // Tenant signature
              '<div class="box-bg-card">' +
                '<div class="flex-row-mb">' +
                  '<div class="sow-sig-badge sow-sig-badge-tenant">T</div>' +
                  '<div><div class="fw-bold-sm">Tenant</div><div class="txt-xs-muted">I acknowledge the maintenance request and grant access to the unit</div></div>' +
                '</div>' +
                '<div class="grid-c2-tight-mb">' +
                  '<div class="f"><label>Printed Name</label><input type="text" id="sow_sig_tenant_name" placeholder="Tenant full name"/></div>' +
                  '<div class="f"><label>Date</label><input type="date" id="sow_sig_tenant_date"/></div>' +
                '</div>' +
                '<div class="sig-canvas-wrap">' +
                  '<div class="tab-bar">' +
                    '<button type="button" onclick="setSigMethod(\'sow_sig_canvas_tenant\',\'canvas\')" id="sow_sig_canvas_tenant_tab_canvas" class="ct-sig-tab active">✏️ Draw</button>' +
                    '<button type="button" onclick="setSigMethod(\'sow_sig_canvas_tenant\',\'type\')"   id="sow_sig_canvas_tenant_tab_type"   class="ct-sig-tab">⌨️ Type</button>' +
                    '<button type="button" onclick="setSigMethod(\'sow_sig_canvas_tenant\',\'wet\')"    id="sow_sig_canvas_tenant_tab_wet"    class="ct-sig-tab">🖊 Wet / E-Sign</button>' +
                  '</div>' +
                  '<div id="sow_sig_canvas_tenant_panel_canvas" class="bg-paper">' +
                    '<canvas id="sow_sig_canvas_tenant" width="620" height="90" class="sig-canvas"></canvas>' +
                    '<div class="sig-footer-row"><span class="txt-xs-muted">Sign with finger or mouse</span><button type="button" onclick="clearSig(\'sow_sig_canvas_tenant\')" class="sig-clear-btn">Clear</button></div>' +
                  '</div>' +
                  '<div id="sow_sig_canvas_tenant_panel_type" class="sec-hidden"><input type="text" id="sow_sig_canvas_tenant_typed" placeholder="Type full legal name" class="sig-typed-input"/><div class="txt-fineprint">Typing your name constitutes a legal electronic signature</div></div>' +
                  '<div id="sow_sig_canvas_tenant_panel_wet" class="sec-hidden"><div class="txt-help">Print this form for a wet signature, or send via DocuSign / Adobe Sign and attach the signed copy.</div><input type="text" id="sow_sig_canvas_tenant_wet_ref" placeholder="Reference # or e-sign envelope ID (optional)" class="sig-wet-input"/></div>' +
                '</div>' +
              '</div>' +
              // Staff signature
              '<div class="box-bg-card">' +
                '<div class="flex-row-mb">' +
                  '<div class="sow-sig-badge sow-sig-badge-staff">S</div>' +
                  '<div><div class="fw-bold-sm">Housing Staff</div><div class="txt-xs-muted">Employee completing this maintenance request</div></div>' +
                '</div>' +
                '<div class="grid-c2-tight-mb">' +
                  '<div class="f"><label>Printed Name</label><input type="text" id="sow_sig_staff_name" placeholder="Staff full name"/></div>' +
                  '<div class="f"><label>Date</label><input type="date" id="sow_sig_staff_date"/></div>' +
                '</div>' +
                '<div class="sig-canvas-wrap">' +
                  '<div class="tab-bar">' +
                    '<button type="button" onclick="setSigMethod(\'sow_sig_canvas_staff\',\'canvas\')" id="sow_sig_canvas_staff_tab_canvas" class="ct-sig-tab active">✏️ Draw</button>' +
                    '<button type="button" onclick="setSigMethod(\'sow_sig_canvas_staff\',\'type\')"   id="sow_sig_canvas_staff_tab_type"   class="ct-sig-tab">⌨️ Type</button>' +
                    '<button type="button" onclick="setSigMethod(\'sow_sig_canvas_staff\',\'wet\')"    id="sow_sig_canvas_staff_tab_wet"    class="ct-sig-tab">🖊 Wet / E-Sign</button>' +
                  '</div>' +
                  '<div id="sow_sig_canvas_staff_panel_canvas" class="bg-paper">' +
                    '<canvas id="sow_sig_canvas_staff" width="620" height="90" class="sig-canvas"></canvas>' +
                    '<div class="sig-footer-row"><span class="txt-xs-muted">Sign with finger or mouse</span><button type="button" onclick="clearSig(\'sow_sig_canvas_staff\')" class="sig-clear-btn">Clear</button></div>' +
                  '</div>' +
                  '<div id="sow_sig_canvas_staff_panel_type" class="sec-hidden"><input type="text" id="sow_sig_canvas_staff_typed" placeholder="Type full legal name" class="sig-typed-input"/><div class="txt-fineprint">Typing your name constitutes a legal electronic signature</div></div>' +
                  '<div id="sow_sig_canvas_staff_panel_wet" class="sec-hidden"><div class="txt-help">Print this form for a wet signature, or send via DocuSign / Adobe Sign and attach the signed copy.</div><input type="text" id="sow_sig_canvas_staff_wet_ref" placeholder="Reference # or e-sign envelope ID (optional)" class="sig-wet-input"/></div>' +
                '</div>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</div>' +

        // ── WORK ORDER (execution) ───────────────────────────────────────
        // The functional, editable record the crew (or the office, if the
        // field employee does not update it) fills in as the work is done.
        // Persisted on the SOW's `workOrder` block; drives the in-house Work
        // Order PDF/print. NOT part of the submit "review all tabs" gate.
        '<div class="tic-panel" data-modal-panel="workorder">' +
          '<div class="tic-section">' +
            '<div class="tic-section-h">Work Checklist</div>' +
            '<div class="txt-muted-xs" style="margin-bottom:8px;">Field staff (or the office) check off each item as it is completed on site. Items come from the Work Items tab.</div>' +
            '<div id="sow_wo_items"></div>' +
          '</div>' +
          '<div class="tic-section">' +
            '<div class="tic-section-h">Measurements</div>' +
            '<div class="f"><label>Measurements taken on site</label>' +
              '<textarea id="sow_wo_measurements" rows="3" placeholder="Rooms, openings, materials — e.g. Kitchen window 900 x 1200 mm"></textarea></div>' +
          '</div>' +
          '<div class="tic-section">' +
            '<div class="tic-section-h">Materials</div>' +
            '<div class="grid-c3-tight">' +
              '<label class="check-row"><input type="checkbox" id="sow_wo_mat_required" class="icon-sm"/> Materials required</label>' +
              '<label class="check-row"><input type="checkbox" id="sow_wo_mat_ordered" class="icon-sm"/> Materials ordered</label>' +
            '</div>' +
            '<div class="f"><label>Materials list / order details</label>' +
              '<textarea id="sow_wo_materials" rows="2" placeholder="What is needed / ordered, supplier, order date…"></textarea></div>' +
          '</div>' +
          '<div class="tic-section">' +
            '<div class="tic-section-h">Field Employee Notes</div>' +
            '<div class="f"><label>Notes from the field</label>' +
              '<textarea id="sow_wo_field_notes" rows="3" placeholder="Observations, issues found, follow-up needed…"></textarea></div>' +
          '</div>' +
          '<div class="tic-section">' +
            '<div id="sow_wo_meta" class="txt-muted-xs"></div>' +
          '</div>' +
        '</div>' +

        // ── PAYMENTS (PO draw-down + progress) ───────────────────────────
        // Purchase-order draw-down tracking: PO total (from an awarded RFQ or
        // entered manually), a multi-step payment schedule (Material / Phase
        // 1..N / Holdback), an invoice attached to each payment, and a
        // paid-vs-outstanding progress bar. Reaching 100% paid surfaces the
        // "Mark Job Complete" action. Rendered on demand by _sowRenderPayments
        // (setSowTab hook) so it always reflects the current saved record.
        '<div class="tic-panel" data-modal-panel="payments">' +
          '<div id="sow_payments_body"></div>' +
        '</div>' +

        // Contracting tab — full Contractor Agreement, mirroring the RFQ
        // Contracting tab, for a Maintenance Request assigned directly to a
        // contractor (no tender). Rendered on demand by _sowRenderContracting.
        '<div class="tic-panel" data-modal-panel="contracting">' +
          '<div id="sow_contracting_body"></div>' +
        '</div>' +

        // Approvals tab removed — HM / ED approval flow is handled outside
        // the SOW form (Renovation Approvals view, internal-only). The
        // hidden inputs below preserve the IDs that saveSOW reads so the
        // existing status-computation logic doesn't break. Empty values
        // mean the auto-promote-to-hm_approved/ed_approved branches never
        // fire from the modal — the SOW status caps at "signed" until an
        // external approval action lifts it.
        '<div class="sow-hidden-approvals" hidden>' +
          '<input id="sow_hm_name" type="hidden"/>' +
          '<input id="sow_hm_date" type="hidden"/>' +
          '<input id="sow_ed_name" type="hidden"/>' +
          '<input id="sow_ed_date" type="hidden"/>' +
          // Tenant phone, resolved from the tenants record at open — printed in
          // the Work Order Project Information so the crew can reach the tenant.
          '<input id="sow_tenant_phone" type="hidden"/>' +
          '<span id="sow_budget_badge"></span>' +
        '</div>' +

      '</div>' + /* /tic-body */

      // ── Footer ───────────────────────────────────────────────────────────
      // Mirrors the TIC / Edit Unit footer: a row of secondary actions (all
      // .btn-ghost), a spacer, then Cancel + the single primary action.
      '<div class="tic-footer">' +
        '<div id="sow_saved_indicator" class="txt-muted-sm"></div>' +
        '<button id="sow_approve_btn" type="button" onclick="sowApproveInline()" class="btn btn-ghost" style="display:none;">✓ Approve</button>' +
        '<button id="sow_mark_complete_btn" type="button" onclick="markSowComplete()" class="btn btn-ghost" style="display:none;">✓ Mark Complete</button>' +
        '<button id="sow_reopen_btn" type="button" onclick="reopenSow()" class="btn btn-ghost" style="display:none;">↺ Reopen</button>' +
        '<button id="sow_cancel_btn" type="button" onclick="cancelSow()" class="btn btn-ghost" style="display:none;color:var(--danger);border-color:var(--danger-border);">✖ Cancel Request</button>' +
        '<button id="sow_archive_btn" type="button" onclick="archiveCurrentSow()" class="btn btn-ghost" style="display:none;">🗄 Archive</button>' +
        // Start ANOTHER request for the same unit (e.g. a second work order under
        // a different contractor). Shown when a saved request is open — you do
        // NOT have to complete the current one first (units support multiple).
        '<button id="sow_new_request_btn" type="button" onclick="sowStartNewRequest()" class="btn btn-ghost" style="display:none;">🆕 New Request</button>' +
        '<button type="button" onclick="printWorkOrder()" class="btn btn-ghost">🏗 Work Order</button>' +
        '<button type="button" onclick="printSOW()" class="btn btn-ghost">🖨 Tenant form</button>' +
        '<button type="button" id="sow_progress_btn" onclick="_sowOpenProgress()" class="btn btn-ghost">📊 Progress Report</button>' +
        '<button type="button" id="sow_rfq_btn" onclick="sowOpenRfq()" class="btn btn-ghost" style="display:none;">📋 RFQ</button>' +
        '<span class="tic-footer-spacer"></span>' +
        // Review progress label — populated by _updateSowSaveButtonState.
        // Reads "3 of 7 sections reviewed" until all tabs have been
        // visited at least once; then flips to "All sections reviewed".
        '<div id="sow_review_progress" class="txt-muted-sm sow-review-progress"></div>' +
        '<button type="button" onclick="closeSowModal()" class="btn btn-ghost">Cancel</button>' +
        // Initial label is "Save Draft" because a fresh modal starts with
        // only the Overview tab visited. _updateSowSaveButtonState flips
        // it to "Submit Request" once all 7 tabs have been opened.
        '<button id="sow_save_btn" type="button" onclick="sowSaveClicked()" class="btn btn-primary" data-mode="draft">💾 Save Draft</button>' +
      '</div>' +

    '</div>'; /* /tic-shell */
}

// Mount the SOW template into a host on first call. Re-using #sowModal as
// the overlay element so existing JS (display:flex toggles, status-driven
// lock styling) doesn't need to change. _sowModalMounted is a one-shot
// guard so we don't redo the innerHTML work on every open.
function _ensureSowModal() {
  if (window._sowModalMounted) return;
  // Resolve a host element. Each page should declare ONE of:
  //   <div id="sowModalHost"></div>            (preferred, post-consolidation)
  //   <div id="sowModal" class="modal-overlay">…stale markup…</div> (legacy)
  // If a host is present we mount cleanly. If only a legacy #sowModal
  // exists we replace its innerHTML so the old markup is shed.
  var host = document.getElementById('sowModalHost');
  var modal;
  if (host) {
    host.outerHTML = '<div id="sowModal" class="modal-overlay modal-z-900"></div>';
    modal = document.getElementById('sowModal');
  } else {
    modal = document.getElementById('sowModal');
    if (!modal) {
      // No host at all — page hasn't been wired up. Bail loudly so we
      // notice during dev rather than silently no-op.
      console.warn('[SOW] Neither #sowModalHost nor #sowModal exists on this page. SOW modal will not render.');
      return;
    }
  }
  modal.innerHTML = _buildSowModalHTML();
  window._sowModalMounted = true;
}

// Total tabs in the SOW modal — keep in sync with _buildSowModalHTML and
// _SOW_TAB_NAMES below. Drives the "Save Draft → Submit" gate: until the
// user has visited every tab the Save button writes draft status only.
var _SOW_TAB_NAMES  = ['overview','scope','documents','safety','acct','notes','sigs'];
var _SOW_TAB_TOTAL  = _SOW_TAB_NAMES.length;

// Tab switcher for the SOW modal. Mirrors _ueSwitchTab/_ticSwitchTab
// (data-modal-tab on the buttons, data-modal-panel on the panels, .tic-tab/
// .tic-panel + .tic-active). Also tracks visited tabs in
// window._sowVisitedTabs (a Set) so the Save button can flip between draft
// and submit modes, and refreshes the info strip so it reflects whatever the
// user just entered on the tab they're leaving.
function setSowTab(name) {
  if (!window._sowVisitedTabs) window._sowVisitedTabs = new Set();
  window._sowVisitedTabs.add(name);
  var bar = document.getElementById('sow_tab_bar');
  if (bar) {
    bar.querySelectorAll(".tic-tab").forEach(function(b){
      var n = b.getAttribute('data-modal-tab');
      b.classList.toggle('tic-active', n === name);
      b.classList.toggle('visited', window._sowVisitedTabs.has(n));
    });
  }
  var modal = document.getElementById('sowModal');
  if (modal) {
    modal.querySelectorAll(".tic-panel").forEach(function(p){
      p.classList.toggle('tic-active', p.getAttribute('data-modal-panel') === name);
    });
  }
  // The Work Order (execution) tab renders its checklist from the current
  // work items on open, so items added on the Work Items tab show up here.
  if (name === 'workorder' && typeof _sowRenderWorkOrderItems === 'function') _sowRenderWorkOrderItems();
  if (name === 'payments'  && typeof _sowRenderPayments === 'function') _sowRenderPayments();
  if (name === 'contracting' && typeof _sowRenderContracting === 'function') _sowRenderContracting();
  if (typeof _sowRefreshStrip === 'function') _sowRefreshStrip();
  _updateSowSaveButtonState();
}

// Flips the Save button between "Save Draft" (not all tabs reviewed yet)
// and "Submit Request" (every tab has been clicked at least once).
// saveSOW reads btn.dataset.mode to decide whether to force draft status.
function _updateSowSaveButtonState() {
  var btn = document.getElementById('sow_save_btn');
  var prog = document.getElementById('sow_review_progress');
  if (!btn) return;

  // Editing an already-SUBMITTED/approved request: the draft->submit review gate
  // is moot and "Submit" is confusing (it already exists). Show a clear
  // "Save Changes" action. Keep data-mode='submit' so saveSOW PRESERVES the
  // current approval_status (a non-submit save forces it back to draft — see
  // _sowComputeApprovalStatus); the `existing` flag tells sowSaveClicked to skip
  // the Submit dialog. Drafts (status 'draft' or unsaved '') keep the gate below.
  var _st = (window._sowCurrentSowMeta && window._sowCurrentSowMeta.approval_status) || '';
  if (_st && _st !== 'draft') {
    btn.dataset.mode     = 'submit';
    btn.dataset.existing = '1';
    btn.textContent      = '💾 Save Changes';
    if (prog) prog.textContent = 'Editing a submitted request';
    return;
  }
  btn.dataset.existing = '';

  // Count only the real review tabs — the Work Order (execution) tab is
  // filled after the request is set up, so visiting it must not satisfy the
  // "review every section" submit gate.
  var visited = 0;
  if (window._sowVisitedTabs) {
    _SOW_TAB_NAMES.forEach(function(t){ if (window._sowVisitedTabs.has(t)) visited++; });
  }
  var allReviewed = visited >= _SOW_TAB_TOTAL;
  btn.dataset.mode  = allReviewed ? 'submit' : 'draft';
  btn.textContent   = allReviewed ? '📤 Submit Request' : '💾 Save Draft';
  if (prog) prog.textContent = allReviewed ? 'All sections reviewed' : (visited + ' of ' + _SOW_TAB_TOTAL + ' sections reviewed');
}

// Refreshes the info-strip tiles (Status/Est. Cost/Assigned To/Target
// Completion) from whatever is currently in the form — called on open, on
// every tab switch, and after the total cost recalculates. Status is the
// exception: it isn't a form field, so it reads window._sowCurrentSowMeta
// (set in openSowModal from the saved record).
function _sowRefreshStrip() {
  var get = function(id){ var el = document.getElementById(id); return el ? el.value : ''; };

  var statusEl = document.getElementById('sow_strip_status');
  if (statusEl) {
    var meta = window._sowCurrentSowMeta || {approval_status:''};
    var sb = (typeof sowStatusBadge === 'function') ? sowStatusBadge(meta, {variant:'unit_table'}) : null;
    statusEl.textContent = sb ? sb.label : '—';
    statusEl.style.color = sb ? sb.c : '';
  }

  var costEl = document.getElementById('sow_strip_cost');
  if (costEl) costEl.textContent = get('sow_total_cost') || '—';

  var asgEl = document.getElementById('sow_strip_assigned');
  if (asgEl) asgEl.textContent = get('sow_contractor') || '—';

  var tgtEl = document.getElementById('sow_strip_target');
  if (tgtEl) tgtEl.textContent = get('sow_end_date') || '—';
}
window._sowRefreshStrip = _sowRefreshStrip;

// ── Fund Source dropdown helpers ─────────────────────────────────────────
// Populates #sow_fund_source with pools eligible for the unit's funder type
// (from RENO_FUND_RULES). FNCFS is appended for all units with a note about
// the configurable dependent-age threshold (set in Settings → Reno Budget).
function _sowPopulateFundSourceDropdown(unitId, savedFundSource) {
  var sel = document.getElementById('sow_fund_source');
  if (!sel) return;

  var allUnits = getAllUnits();
  var u      = unitId ? allUnits.find(function(x){ return x && x.id === unitId; }) : null;
  var funder = u ? (u.funder || '') : '';

  var rules   = (typeof RENO_FUND_RULES !== 'undefined') ? RENO_FUND_RULES : {};
  var rule    = rules[funder] || rules['band_house'] || rules[''] || { pools:[], rule:'' };
  var pools   = (typeof BUDGET_POOLS !== 'undefined') ? BUDGET_POOLS : [];

  var budgetData = (typeof loadBudgetData === 'function' && loadBudgetData()) || {};
  var fncfsAge   = (budgetData.fncfsDependantAge != null) ? budgetData.fncfsDependantAge : 17;

  var html = '<option value="">— Select fund source —</option>';
  rule.pools.forEach(function(pid) {
    var pool = pools.find(function(p){ return p.id === pid; });
    if (!pool || pool.requiresDependants) return; // FNCFS handled below
    html += '<option value="' + pid + '"' + (savedFundSource === pid ? ' selected' : '') + '>'
          + pool.icon + ' ' + pool.label + '</option>';
  });

  // Always offer FNCFS with an eligibility note
  var fncfs = pools.find(function(p){ return p.id === 'fncfs'; });
  if (fncfs) {
    html += '<option value="fncfs"' + (savedFundSource === 'fncfs' ? ' selected' : '') + '>'
          + fncfs.icon + ' ' + fncfs.label + ' (dependants under ' + fncfsAge + ')</option>';
  }

  sel.innerHTML = html;

  // Eligibility rule note
  var ruleEl = document.getElementById('sow_fund_rule');
  if (ruleEl) ruleEl.textContent = rule.rule || '';

  // Restore badge for already-saved fund source
  if (savedFundSource) _sowUpdateFundBadge(savedFundSource);
}

function _sowUpdateFundBadge(poolId) {
  var badge = document.getElementById('sow_fund_badge');
  if (!badge) return;
  if (!poolId) { badge.style.display = 'none'; return; }
  var pools = (typeof BUDGET_POOLS !== 'undefined') ? BUDGET_POOLS : [];
  var pool  = pools.find(function(p){ return p.id === poolId; });
  if (!pool) { badge.style.display = 'none'; return; }
  badge.textContent    = pool.icon + ' ' + pool.label;
  badge.style.display  = 'inline-block';
  badge.style.background = pool.bg || 'var(--bg)';
  badge.style.color      = pool.color || 'var(--text)';
  badge.style.border     = '1px solid ' + (pool.color || 'var(--border)');
}

// ── SOW Picker — shown when a unit has multiple active maintenance requests ──
// Lets the user choose which request to open (or start a new one).
function _openSowPicker(unitId, activeList) {
  var _PICK_ID = 'sowPickerOverlay';
  var existing = document.getElementById(_PICK_ID);
  if (existing) existing.parentNode.removeChild(existing);

  var allUnits = getAllUnits();
  var u = allUnits.find(function(x){ return x.id === unitId; });
  var unitLabel = u ? u.num + ' ' + u.street : unitId;

  function _card(sow) {
    // Shared badge helper (shared-data.js) — 'picker' variant keeps this
    // card's exact labels/colors, incl. the System Approved override.
    var ss = sowStatusBadge(sow, {variant:'picker'});
    var pn = sow.project_number || '—';
    var date = (sow.created_at || sow.date || '').slice(0, 10) || '—';
    var amount = (sow.amount != null && sow.amount !== '') ? (typeof formatCurrency === 'function' ? formatCurrency(sow.amount) : '$' + sow.amount) : '—';
    var scope = (sow.scope || sow.description || '');
    var scopePreview = scope.slice(0, 90) + (scope.length > 90 ? '…' : '');
    var contractor = sow.contractor || sow.contractorName || '';
    return '<div style="border:1px solid var(--border);border-radius:10px;padding:14px 16px;background:var(--surface);display:flex;align-items:center;justify-content:space-between;gap:12px;">'
      + '<div style="flex:1;min-width:0;">'
        + '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px;">'
          + '<span style="font-size:11px;font-family:ui-monospace,monospace;font-weight:700;color:var(--text);">' + pn + '</span>'
          + '<span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:8px;background:' + ss.bg + ';color:' + ss.c + ';">' + ss.label + '</span>'
          + '<span style="font-size:10px;color:var(--muted);">' + date + '</span>'
        + '</div>'
        + (contractor ? '<div style="font-size:11px;color:var(--muted);margin-bottom:2px;">👷 ' + escapeHtml(contractor) + '</div>' : '')
        + (scopePreview ? '<div style="font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escapeHtml(scopePreview) + '</div>' : '')
        + '<div style="font-size:12px;font-weight:700;color:var(--text);margin-top:4px;">' + amount + '</div>'
      + '</div>'
      + '<button data-pick-pn="' + pn + '" style="flex-shrink:0;background:var(--yellow);border:none;color:var(--dark);padding:7px 16px;border-radius:7px;font-size:12px;font-weight:700;cursor:pointer;font-family:DM Sans,sans-serif;">Open →</button>'
      + '</div>';
  }

  var sorted = activeList.slice().sort(function(a, b){ return (b.created_at||'').localeCompare(a.created_at||''); });
  var overlay = document.createElement('div');
  overlay.id = _PICK_ID;
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:1100;display:flex;align-items:center;justify-content:center;padding:20px;';
  overlay.innerHTML = '<div style="background:var(--card);border-radius:14px;max-width:520px;width:100%;max-height:80vh;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.35);">'
    + '<div style="background:var(--dark);padding:16px 20px;display:flex;align-items:center;justify-content:space-between;border-radius:14px 14px 0 0;">'
      + '<div>'
        + '<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:rgba(255,255,255,.5);margin-bottom:3px;">Maintenance Requests</div>'
        + '<div style="font-size:15px;font-weight:700;color:#fff;">' + unitLabel + '</div>'
      + '</div>'
      + '<button id="sowPickerClose" style="background:none;border:none;color:rgba(255,255,255,.6);font-size:18px;cursor:pointer;padding:4px 8px;line-height:1;">✕</button>'
    + '</div>'
    + '<div style="padding:16px;overflow-y:auto;display:flex;flex-direction:column;gap:10px;">'
      + sorted.map(_card).join('')
    + '</div>'
    + '<div style="padding:14px 16px;border-top:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;">'
      + '<span style="font-size:11px;color:var(--muted);">' + sorted.length + ' active request' + (sorted.length !== 1 ? 's' : '') + '</span>'
      + '<button id="sowPickerNew" style="background:none;border:1.5px solid var(--border);color:var(--text);padding:7px 16px;border-radius:7px;font-size:12px;font-weight:700;cursor:pointer;font-family:DM Sans,sans-serif;">+ New Request</button>'
    + '</div>'
    + '</div>';

  document.body.appendChild(overlay);

  function _close() { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }

  overlay.addEventListener('click', function(e){ if (e.target === overlay) _close(); });
  document.getElementById('sowPickerClose').addEventListener('click', _close);
  document.getElementById('sowPickerNew').addEventListener('click', function(){
    _close();
    window._sowForceNew = true;  // bypass picker on next openSowModal call
    openSowModal(unitId);
  });
  overlay.querySelectorAll('[data-pick-pn]').forEach(function(btn){
    btn.addEventListener('click', function(){
      var pn = btn.getAttribute('data-pick-pn');
      _close();
      openSowModal(unitId, pn);
    });
  });
}

function openSowModal(unitId, projectNumber) {
  // Per-user Feature Access: block Maintenance Requests for a user restricted
  // away from that function (no-op for unrestricted users).
  if (typeof window.canUseFeature === 'function' && !window.canUseFeature('maintenance_requests')) {
    if (typeof showToast === 'function') showToast('You do not have access to Maintenance Requests.', { type:'error' });
    return;
  }
  // Mount the consolidated template on first call. Stays idempotent on
  // subsequent opens so element IDs survive between sessions.
  _ensureSowModal();
  // Reset visited-tab tracking. The prefill for existing SOWs (and the
  // initial setSowTab) happen BELOW, after the target SOW is resolved — two
  // bugs lived in doing them up here: (1) `willBeEdit` counted ANY SOW history
  // on the unit (even completed/archived, and before _sowForceNew was read),
  // so a genuinely NEW request on a unit with history skipped the
  // review-every-tab submit gate; (2) setSowTab ran before _sowCurrentSowMeta
  // was refreshed, so _updateSowSaveButtonState read the PREVIOUS SOW's status
  // — after viewing a submitted MR, a brand-new one opened in "Save Changes"
  // submit mode and saved straight to 'submitted' with no review or confirm.
  window._sowVisitedTabs = new Set();
  _sowUnitId  = unitId || null;
  _sowItemIdx = 0;

  // Resolve which SOW to open:
  //   - If projectNumber was passed, edit that specific SOW.
  //   - If no projectNumber but the unit has existing SOWs, open the most recent one.
  //     This preserves legacy behavior where call sites like the inventory 🔨 button
  //     expect "open the SOW for this unit" and fall back gracefully for multi-SOW.
  //   - If no projectNumber AND the unit has zero SOWs, create a new one with a
  //     freshly-auto-incremented project number.
  var existingList = unitId ? (typeof getUnitSowList === 'function' ? getUnitSowList(unitId) : []) : [];
  // window._sowForceNew (set by the Reno Questionnaire or SOW picker) forces a
  // brand-new SOW even when the unit already has requests. One-shot — cleared on read.
  var _forceNew = !!window._sowForceNew; window._sowForceNew = false;
  var activeList = existingList.filter(function(s){ return !s.archived && !s.cancelled && s.approval_status !== 'completed'; });
  if(!projectNumber && !_forceNew){
    if(activeList.length > 1){
      // Multiple active requests — show a picker so the user can choose which to open.
      _openSowPicker(unitId, activeList);
      return;
    }
    if(activeList.length === 1){
      // Exactly one active request — open it.
      projectNumber = activeList[0].project_number || null;
    }
    // Zero ACTIVE requests (unit has none, or all are completed/archived) — fall
    // through with projectNumber null to start a BRAND-NEW request. We must NOT
    // open a completed request here: completed SOWs open locked, which stranded
    // the user with no way to add another work order after completing one.
    // Completed/archived SOWs are still viewable/printable from the unit's SOW
    // table (udpEditSow / udpOpenSowDocument pass an explicit project number).
  }

  var isEdit = !!projectNumber;
  var saved = (unitId && projectNumber) ? getSowByProjectNumber(unitId, projectNumber) : null;
  window._sowEditingProjectNumber = isEdit ? projectNumber : null;  // remember for save
  window._sowWasPreviouslySaved = isEdit && !!saved;
  // Status tile (info strip) reads approval state from here, not a form field —
  // sowStatusBadge needs approval_status/system_approved/archived off the saved record.
  window._sowCurrentSowMeta = saved ? {approval_status: saved.approval_status, system_approved: saved.system_approved, archived: saved.archived, cancelled: saved.cancelled} : {approval_status:''};
  // Re-opening an EXISTING saved SOW pre-fills all tabs as reviewed (the user
  // is editing, not first-walking the form) so the Save button offers
  // Submit/Save-Changes immediately. Brand-new SOWs start with none — the
  // "review every tab" gate applies only to first-time authoring. Keyed off
  // the RESOLVED `saved` record (not raw unit history) — see the note at top.
  if (saved) {
    _SOW_TAB_NAMES.forEach(function(t){ window._sowVisitedTabs.add(t); });
  }
  // Always reset the tab to Overview on open — otherwise re-opening shows
  // whatever tab the user was last on. Runs AFTER the meta/visited state above
  // so _updateSowSaveButtonState computes the right button mode for THIS SOW.
  if (typeof setSowTab === 'function') setSowTab('overview');
  var label = '';
  if(unitId) {
    var allUnits = getAllUnits();
    var u = allUnits.find(function(x){ return x.id===unitId; });
    if(u) label = u.num+' '+u.street+' · '+_roomBedLabel(u);
  }
  var lbl = document.getElementById('sow_unit_label');
  if(lbl) lbl.textContent = label || 'No unit selected';
  var today = new Date().toISOString().slice(0,10);
  var dateEl = document.getElementById('sow_date'); if(dateEl) dateEl.value = today;
  if(saved) {
    populateSow(saved);
  } else {
    resetSow();
  }
  if(label) { var addr=document.getElementById('sow_address'); if(addr) addr.value=label; }
  // Populate fund source dropdown for this unit's funder type
  var savedFs = saved ? (saved.fundSource || '') : '';
  _sowPopulateFundSourceDropdown(unitId, savedFs);

  // Auto-populate tenant name from the unit's assigned tenant whenever the
  // field is empty — covers both brand-new SOWs and existing SOWs that were
  // saved before this auto-fill existed (tenantName missing from the payload).
  // Never overwrites a value the user already entered.
  if(unitId) {
    var tnEl = document.getElementById('sow_tenant_name');
    if(tnEl && !tnEl.value) {
      var allUnits2 = getAllUnits();
      var u2 = allUnits2.find(function(x){ return x.id===unitId; });
      if(u2 && u2.assignedName) tnEl.value = u2.assignedName;
    }
  }
  // Resolve the tenant's phone (async) into the hidden field the Work Order
  // Project Information prints. Clear first so a stale value from a previous
  // open never leaks onto a different unit's work order.
  (function(){
    var phEl = document.getElementById('sow_tenant_phone');
    if(phEl) phEl.value = '';
    if(unitId && typeof _resolveTenantPhoneForUnit === 'function'){
      var uPh = getAllUnits().find(function(x){ return x.id===unitId; });
      if(uPh){
        _resolveTenantPhoneForUnit(uPh).then(function(ph){
          var el = document.getElementById('sow_tenant_phone');
          if(el && ph) el.value = ph;
        }).catch(function(){});
      }
    }
  })();
  // Auto-populate "Prepared By (Staff)" from the logged-in user. Done for both
  // new and existing SOWs, but only when the field is empty — never overwrite
  // a saved value (the original preparer should be preserved on re-open).
  var pbEl = document.getElementById('sow_prepared_by');
  if(pbEl && !pbEl.value){
    var sess = (typeof HOUSING_SESSION !== 'undefined' && HOUSING_SESSION) ? HOUSING_SESSION : null;
    var who = (sess && (sess.name || sess.email)) || (window.currentUserName || '');
    if(who) pbEl.value = who;
  }

  // Show project number header (new visual identifier for the SOW).
  var pnLabel = document.getElementById('sow_project_number_label');
  if(pnLabel){
    var pn = isEdit ? projectNumber : (unitId ? nextProjectNumber(unitId) : '(no unit)');
    pnLabel.textContent = pn;
    window._sowEditingProjectNumber = pn;  // lock in the project number for save (handles new too)
  }

  var modal = document.getElementById('sowModal');
  if(modal){ modal.style.removeProperty('display'); modal.style.setProperty('display','flex','important'); }

  // Init signature pads
  setTimeout(function(){
    if(true) {
      _initSigPad('sow_sig_canvas_tenant');
      _initSigPad('sow_sig_canvas_staff');
    }
  }, 100);

  // Hide budget badge
  setTimeout(function(){
    var badge = document.getElementById('sow_budget_badge');
    if(badge) badge.style.display = 'none';
  }, 50);

  // Apply the locked/unlocked state based on the SOW's status and the current user's role.
  _applySowModalLock(saved);

  // Initialize the PO draw-down / payments working state once per open, from
  // the saved record (or prefilled from an awarded RFQ / the MR total for a
  // new one). _sowRenderPayments reads this; input handlers mutate it in place.
  if (typeof _sowInitPayState === 'function') _sowInitPayState(saved);
  if (typeof _sowInitContractState === 'function') _sowInitContractState(saved);

  // Apply a one-shot seed handed off by the Reno Questionnaire. Done in-flow
  // (the modal DOM is fully mounted here) instead of a post-open setTimeout
  // DOM-scrape race — the previous approach could silently drop items.
  if (window._sowSeed) {
    var _seed = window._sowSeed; window._sowSeed = null;
    try { _applySowSeed(_seed); } catch(e){ console.warn('[sow] seed apply failed:', e); }
  }

  if (typeof _sowRefreshStrip === 'function') _sowRefreshStrip();

  // Scroll-collapse: shrink the info strip to icon-only once the tab body
  // scrolls, freeing space on tablet/mobile (shared-ui.js). _initScrollCollapse
  // is itself idempotent, so calling it on every open is safe.
  if (modal && typeof _initScrollCollapse === 'function') {
    var _sowBody = modal.querySelector('.tic-body');
    var _sowStrip = modal.querySelector('.tic-strip');
    if (_sowBody && _sowStrip) _initScrollCollapse(_sowBody, _sowStrip);
  }
}

// Populate a brand-new SOW from a structured seed (Reno Questionnaire hand-off):
// work items, overall condition, Health & Safety flags, and appended notes.
function _applySowSeed(seed){
  if(!seed) return;
  // Drop the blank default row(s) so seeded items don't sit next to an empty one.
  var cont = document.getElementById('sow_items');
  if(cont){
    Array.prototype.slice.call(cont.querySelectorAll('div[id^="sow_item_"]')).forEach(function(row){
      var desc=(row.querySelector('[data-sow="description"]')||{}).value||'';
      var cat =(row.querySelector('[data-sow="category"]')||{}).value||'';
      if(!desc && !cat) row.remove();
    });
  }
  (seed.items||[]).forEach(function(it){
    if(typeof addSowItem === 'function') addSowItem({ category: it.category, description: it.description });
  });
  if(typeof recalcSowTotal === 'function') recalcSowTotal();
  // Overall condition (worst severity from the questionnaire) — only if unset.
  if(seed.condition){
    var c = document.getElementById('sow_condition');
    if(c && !c.value) c.value = seed.condition;
  }
  // Health & Safety flags inferred from the reported issues.
  (seed.hsFlags||[]).forEach(function(id){
    var el = document.getElementById(id); if(el) el.checked = true;
  });
  if(seed.notes){
    var n = document.getElementById('sow_notes');
    if(n) n.value = n.value ? (n.value + '\n\n' + seed.notes) : seed.notes;
  }
}
window._applySowSeed = _applySowSeed;

// ── AI: auto-fill Work Items from an uploaded quote ───────────────────────
// User uploads a contractor quote (PDF or photo) on the Scope of Work tab; the
// ai-extract-quote Edge Function returns structured line items which the user
// reviews and inserts into the Work Items list. Gated by the ai_assistant module.
function sowUploadQuoteClick(){
  if (window.CLFN_MODULES && typeof CLFN_MODULES.isEnabled === 'function' && !CLFN_MODULES.isEnabled('ai_assistant')) {
    if (typeof showToast === 'function') showToast('AI Assistant is disabled for this nation.', { type:'error' });
    return;
  }
  var inp = document.getElementById('sow_quote_file');
  if (inp) { inp.value = ''; inp.click(); }
}

function _sowQuotePicked(input){
  var file = input && input.files && input.files[0];
  if (!file) return;
  var okType = /pdf$/i.test(file.type) || /^image\//i.test(file.type);
  if (!okType) { if (typeof showToast==='function') showToast('Upload a PDF or an image (JPG/PNG).', { type:'error' }); return; }
  if (file.size > 12 * 1024 * 1024) { if (typeof showToast==='function') showToast('That file is too large (max ~12 MB).', { type:'error' }); return; }

  var btn = document.getElementById('sow_quote_ai_btn');
  var btnLabel = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Reading quote…'; }
  if (typeof showToast==='function') showToast('Reading the quote with AI…', { type:'info' });

  var reader = new FileReader();
  reader.onload = function(){
    var dataUrl = String(reader.result || '');
    var b64 = dataUrl.indexOf(',') >= 0 ? dataUrl.split(',')[1] : dataUrl;
    var token = (window.HOUSING_SESSION && window.HOUSING_SESSION.accessToken) || window.SUPABASE_ANON || '';
    fetch((window.SUPABASE_URL || '') + '/functions/v1/ai-extract-quote', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'Authorization':'Bearer ' + token },
      body: JSON.stringify({
        file: { name: file.name, contentType: file.type, dataBase64: b64 },
        categories: (typeof SOW_CATEGORIES !== 'undefined') ? SOW_CATEGORIES : []
      })
    })
    .then(function(r){ return r.json(); })
    .then(function(res){
      if (btn) { btn.disabled = false; btn.textContent = btnLabel; }
      if (res && res.error) { if (typeof showToast==='function') showToast('Could not read that quote: ' + res.error, { type:'error' }); return; }
      var items = (res && res.items) || [];
      if (!items.length) { if (typeof showToast==='function') showToast('No work items were found in that document.', { type:'error' }); return; }
      _sowShowQuotePreview(items, (res && res.summary) || '', file.name);
    })
    .catch(function(e){
      if (btn) { btn.disabled = false; btn.textContent = btnLabel; }
      if (typeof showToast==='function') showToast('Quote extraction failed: ' + (e && e.message || e), { type:'error' });
    });
  };
  reader.onerror = function(){
    if (btn) { btn.disabled = false; btn.textContent = btnLabel; }
    if (typeof showToast==='function') showToast('Could not read that file.', { type:'error' });
  };
  reader.readAsDataURL(file);
}

// Review modal: lists the extracted items with a checkbox each; the user picks
// which to add (all checked by default) and they are APPENDED to the Work Items
// list (nothing existing is removed). AI output is a draft — every inserted row
// stays fully editable.
function _sowShowQuotePreview(items, summary, fileName, title){
  var esc = function(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); };
  var money = function(n){ return (n==null||n==='') ? '<span style="color:var(--muted);">no price</span>' : ('$' + (parseFloat(n)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})); };
  window._sowQuoteItems = items;
  var rows = items.map(function(it, i){
    return '<label style="display:grid;grid-template-columns:20px 130px 1fr 90px;gap:8px;align-items:start;padding:8px 4px;border-bottom:1px solid var(--border);font-size:12.5px;cursor:pointer;">' +
      '<input type="checkbox" data-sowq="'+i+'" checked style="margin-top:2px;"/>' +
      '<span style="color:var(--muted);">'+esc(it.category||'Other')+'</span>' +
      '<span style="color:var(--text);">'+esc(it.description)+'</span>' +
      '<span style="text-align:right;font-variant-numeric:tabular-nums;">'+money(it.cost)+'</span>' +
    '</label>';
  }).join('');
  var ov = document.createElement('div');
  ov.id = '_sowQuotePreviewOv';
  ov.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:20px;';
  ov.innerHTML =
    '<div style="background:var(--surface);border-radius:14px;max-width:620px;width:100%;max-height:85vh;display:flex;flex-direction:column;box-shadow:0 24px 60px rgba(0,0,0,.35);overflow:hidden;">' +
      '<div class="modal-hdr compact"><div>' +
        '<div class="modal-hdr-title">' + esc(title || 'Quote read by AI') + '</div>' +
        '<div class="modal-hdr-sub">'+esc(fileName||'')+' &middot; '+items.length+' item(s) found</div>' +
      '</div></div>' +
      '<div style="padding:14px 18px 4px;">' +
        (summary ? '<p style="margin:0 0 10px;font-size:12.5px;color:var(--muted);line-height:1.5;">'+esc(summary)+'</p>' : '') +
        '<div style="display:grid;grid-template-columns:20px 130px 1fr 90px;gap:8px;font-size:10.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);padding:0 4px 4px;">' +
          '<span></span><span>Category</span><span>Description</span><span style="text-align:right;">Est. cost</span></div>' +
      '</div>' +
      '<div style="overflow:auto;padding:0 18px;flex:1;">'+rows+'</div>' +
      '<div style="padding:14px 18px;border-top:1px solid var(--border);display:flex;gap:10px;justify-content:space-between;align-items:center;flex-wrap:wrap;">' +
        '<span style="font-size:11.5px;color:var(--muted);">Review &amp; edit these after adding. Existing items are kept.</span>' +
        '<div style="display:flex;gap:10px;">' +
          '<button class="btn btn-ghost" onclick="_sowCloseQuotePreview()">Cancel</button>' +
          '<button class="btn btn-primary" onclick="_sowInsertQuoteItems()">Add selected to scope</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  document.body.appendChild(ov);
  ov.addEventListener('click', function(e){ if (e.target === ov) _sowCloseQuotePreview(); });
}
function _sowCloseQuotePreview(){
  var ov = document.getElementById('_sowQuotePreviewOv');
  if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
  window._sowQuoteItems = null;
}
function _sowInsertQuoteItems(){
  var ov = document.getElementById('_sowQuotePreviewOv');
  var items = window._sowQuoteItems || [];
  var added = 0;
  if (ov) {
    ov.querySelectorAll('[data-sowq]').forEach(function(cb){
      if (!cb.checked) return;
      var it = items[parseInt(cb.getAttribute('data-sowq'), 10)];
      if (!it) return;
      if (typeof addSowItem === 'function') {
        addSowItem({ category: it.category || '', description: it.description || '',
                     cost: (it.cost != null ? String(it.cost) : '') });
        added++;
      }
    });
  }
  if (typeof recalcSowTotal === 'function') recalcSowTotal();
  _sowCloseQuotePreview();
  if (typeof showToast === 'function') showToast(added ? ('Added ' + added + ' work item(s) to the scope.') : 'No items selected.', { type: added?'info':'error' });
}
window.sowUploadQuoteClick   = sowUploadQuoteClick;
window._sowQuotePicked       = _sowQuotePicked;
window._sowShowQuotePreview  = _sowShowQuotePreview;
window._sowCloseQuotePreview = _sowCloseQuotePreview;
window._sowInsertQuoteItems  = _sowInsertQuoteItems;

// ── AI: draft a scope of work from a plain-language job description ─────────
// Staff type what the job is ("Bathroom renovation", "Replace exterior windows
// in bedroom, basement, living room") and the ai-extract-quote Edge Function's
// draft mode returns a structured work-item breakdown (no prices — costs are
// set by staff or the tendering process). Items flow through the SAME review
// modal + insert path as the quote extractor, so every line is reviewed and
// stays editable. Gated by the ai_assistant module.
function sowDraftScopeClick(){
  if (window.CLFN_MODULES && typeof CLFN_MODULES.isEnabled === 'function' && !CLFN_MODULES.isEnabled('ai_assistant')) {
    if (typeof showToast === 'function') showToast('AI Assistant is disabled for this nation.', { type:'error' });
    return;
  }
  if (document.getElementById('_sowScopeAiOv')) return;
  var ov = document.createElement('div');
  ov.id = '_sowScopeAiOv';
  ov.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:20px;';
  ov.innerHTML =
    '<div style="background:var(--surface);border-radius:14px;max-width:520px;width:100%;box-shadow:0 24px 60px rgba(0,0,0,.35);overflow:hidden;">' +
      '<div class="modal-hdr compact"><div>' +
        '<div class="modal-hdr-title">✦ Draft scope of work with AI</div>' +
        '<div class="modal-hdr-sub">Describe the job — AI drafts the work items for review</div>' +
      '</div></div>' +
      '<div style="padding:16px 18px;">' +
        '<textarea id="sow_scope_ai_prompt" rows="3" placeholder="e.g. Bathroom renovation&#10;e.g. Replace exterior windows in bedroom, basement and living room" ' +
          'style="width:100%;box-sizing:border-box;border:1.5px solid var(--border);border-radius:8px;padding:10px 12px;font-size:13px;font-family:inherit;resize:vertical;background:var(--surface);color:var(--text);"></textarea>' +
        '<div style="margin-top:10px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;">' +
          '<span style="font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);">Detail</span>' +
          '<button type="button" class="btn btn-ghost btn-sm" data-sow-detail="summary" onclick="_sowSetScopeDetail(\'summary\')">Summary</button>' +
          '<button type="button" class="btn btn-ghost btn-sm" data-sow-detail="full" onclick="_sowSetScopeDetail(\'full\')">Full breakdown</button>' +
          '<span id="sow_scope_detail_hint" style="font-size:11px;color:var(--muted);"></span>' +
        '</div>' +
        '<div style="margin-top:6px;font-size:11.5px;color:var(--muted);">No prices are generated — costs stay with staff / contractor quotes. You pick which items to add.</div>' +
      '</div>' +
      '<div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;gap:10px;justify-content:flex-end;">' +
        '<button class="btn btn-ghost" onclick="_sowCloseScopeAi()">Cancel</button>' +
        '<button class="btn btn-primary" id="sow_scope_ai_go" onclick="_sowRunScopeAi()">✦ Draft Scope</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(ov);
  ov.addEventListener('click', function(e){ if (e.target === ov) _sowCloseScopeAi(); });
  // Detail toggle: restore this device's last choice ('full' first time).
  var savedDetail = 'full';
  try { savedDetail = localStorage.getItem('clfn_sow_ai_detail') || 'full'; } catch(e){}
  _sowSetScopeDetail(savedDetail === 'summary' ? 'summary' : 'full');
  var ta = document.getElementById('sow_scope_ai_prompt');
  if (ta) {
    ta.focus();
    // Enter submits; Shift+Enter makes a newline for multi-part descriptions.
    ta.addEventListener('keydown', function(e){
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); _sowRunScopeAi(); }
    });
  }
}
// Selected detail level lives on window so _sowRunScopeAi can read it; the
// buttons restyle to show which is active, and the choice is remembered
// per device (localStorage) so field staff aren't re-picking every time.
function _sowSetScopeDetail(v){
  window._sowScopeAiDetail = (v === 'summary') ? 'summary' : 'full';
  try { localStorage.setItem('clfn_sow_ai_detail', window._sowScopeAiDetail); } catch(e){}
  var ov = document.getElementById('_sowScopeAiOv');
  if (!ov) return;
  ov.querySelectorAll('[data-sow-detail]').forEach(function(b){
    var on = b.getAttribute('data-sow-detail') === window._sowScopeAiDetail;
    b.className = on ? 'btn btn-primary btn-sm' : 'btn btn-ghost btn-sm';
  });
  var hint = document.getElementById('sow_scope_detail_hint');
  if (hint) hint.textContent = window._sowScopeAiDetail === 'summary'
    ? '4–8 broad items — good for big jobs like a whole-house reno'
    : 'Complete step-by-step breakdown — good for tenders';
}
function _sowCloseScopeAi(){
  var ov = document.getElementById('_sowScopeAiOv');
  if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
}
function _sowRunScopeAi(){
  var ta = document.getElementById('sow_scope_ai_prompt');
  var promptText = ((ta && ta.value) || '').trim();
  if (!promptText) { if (typeof showToast==='function') showToast('Describe the job first — e.g. "Bathroom renovation".', { type:'error' }); return; }
  var go = document.getElementById('sow_scope_ai_go');
  if (go) { go.disabled = true; go.textContent = 'Drafting…'; }
  var token = (window.HOUSING_SESSION && window.HOUSING_SESSION.accessToken) || window.SUPABASE_ANON || '';
  fetch((window.SUPABASE_URL || '') + '/functions/v1/ai-extract-quote', {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'Authorization':'Bearer ' + token },
    body: JSON.stringify({
      prompt: promptText,
      detail: window._sowScopeAiDetail === 'summary' ? 'summary' : 'full',
      categories: (typeof SOW_CATEGORIES !== 'undefined') ? SOW_CATEGORIES : []
    })
  })
  .then(function(r){ return r.json(); })
  .then(function(res){
    if (go) { go.disabled = false; go.textContent = '✦ Draft Scope'; }
    if (res && res.error) { if (typeof showToast==='function') showToast('Could not draft the scope: ' + res.error, { type:'error' }); return; }
    var items = (res && res.items) || [];
    if (!items.length) { if (typeof showToast==='function') showToast('No work items were generated — try describing the job differently.', { type:'error' }); return; }
    _sowCloseScopeAi();
    _sowShowQuotePreview(items, (res && res.summary) || '', promptText, 'Scope drafted by AI');
  })
  .catch(function(e){
    if (go) { go.disabled = false; go.textContent = '✦ Draft Scope'; }
    if (typeof showToast==='function') showToast('Scope draft failed: ' + (e && e.message || e), { type:'error' });
  });
}
window.sowDraftScopeClick = sowDraftScopeClick;
window._sowCloseScopeAi   = _sowCloseScopeAi;
window._sowRunScopeAi     = _sowRunScopeAi;
window._sowSetScopeDetail = _sowSetScopeDetail;

// ── Work Order (execution) tab ────────────────────────────────────────────
// The editable, functional work-order record kept on the SOW's `workOrder`
// block (round-trips through the SOW `data` jsonb — no schema change). Field
// staff OR the office fill it in as the work is done; it drives the in-house
// Work Order PDF/print.

// Render the per-item completion checklist from the current work items,
// preserving check state. Pass an explicit doneMap (from a saved record) to
// restore saved ticks; omit it to preserve whatever is currently checked
// (used when re-opening the tab after items changed).
function _sowRenderWorkOrderItems(doneMap){
  var cont = document.getElementById('sow_wo_items');
  if(!cont) return;
  var esc = (typeof escapeHtml === 'function') ? escapeHtml : function(s){ return String(s==null?'':s); };
  var items = (typeof collectSowItems === 'function') ? collectSowItems() : [];
  items = items.filter(function(it){ return it.category || it.description; });
  if(!doneMap){
    var prev = {};
    cont.querySelectorAll('input[type=checkbox][data-wo-idx]').forEach(function(cb){
      prev[cb.getAttribute('data-wo-idx')] = cb.checked;
    });
    doneMap = prev;
  }
  if(!items.length){
    cont.innerHTML = '<div class="txt-muted-xs" style="padding:6px 0;">No work items yet — add them on the Work Items tab.</div>';
    return;
  }
  cont.innerHTML = items.map(function(it,i){
    var done = !!(doneMap && doneMap[i]);
    var lbl  = (it.category ? esc(it.category) + ' — ' : '') + esc(it.description || 'Item');
    return '<label class="check-row" style="align-items:flex-start;gap:8px;">'
      + '<input type="checkbox" class="icon-sm" data-wo-idx="' + i + '"' + (done ? ' checked' : '') + '/> '
      + '<span>' + lbl + '</span></label>';
  }).join('');
}
window._sowRenderWorkOrderItems = _sowRenderWorkOrderItems;

// Read the Work Order tab fields into a plain object for saveSOW.
function _sowCollectWorkOrder(){
  var g = function(id){ var e=document.getElementById(id); return e ? String(e.value||'').trim() : ''; };
  var c = function(id){ var e=document.getElementById(id); return e ? !!e.checked : false; };
  var wo = {
    itemsDone:        {},
    measurements:     g('sow_wo_measurements'),
    materialsRequired:c('sow_wo_mat_required'),
    materialsOrdered: c('sow_wo_mat_ordered'),
    materialsList:    g('sow_wo_materials'),
    fieldNotes:       g('sow_wo_field_notes')
  };
  var cont = document.getElementById('sow_wo_items');
  var total = 0, done = 0;
  if(cont){
    cont.querySelectorAll('input[type=checkbox][data-wo-idx]').forEach(function(cb){
      total++; if(cb.checked) done++;
      wo.itemsDone[cb.getAttribute('data-wo-idx')] = cb.checked;
    });
  }
  var hasAny = done > 0 || wo.measurements || wo.materialsList || wo.fieldNotes || wo.materialsRequired || wo.materialsOrdered;
  wo.status = (total > 0 && done === total) ? 'done' : (hasAny ? 'in_progress' : 'not_started');
  if(hasAny){
    wo.updatedAt = new Date().toISOString();
    wo.updatedBy = (typeof HOUSING_SESSION !== 'undefined' && HOUSING_SESSION && (HOUSING_SESSION.email || HOUSING_SESSION.name)) || '';
  }
  return wo;
}
window._sowCollectWorkOrder = _sowCollectWorkOrder;

// Fill the Work Order tab from a saved `workOrder` block (called from
// populateSow). Safe to call with null/undefined for a brand-new request.
function _sowPopulateWorkOrder(wo){
  wo = wo || {};
  var s = function(id,v){ var e=document.getElementById(id); if(e) e.value = v || ''; };
  var k = function(id,v){ var e=document.getElementById(id); if(e) e.checked = !!v; };
  s('sow_wo_measurements', wo.measurements);
  s('sow_wo_materials',    wo.materialsList);
  s('sow_wo_field_notes',  wo.fieldNotes);
  k('sow_wo_mat_required', wo.materialsRequired);
  k('sow_wo_mat_ordered',  wo.materialsOrdered);
  _sowRenderWorkOrderItems(wo.itemsDone || {});
  _sowUpdateWorkOrderMeta(wo);
}
window._sowPopulateWorkOrder = _sowPopulateWorkOrder;

function _sowUpdateWorkOrderMeta(wo){
  var el = document.getElementById('sow_wo_meta'); if(!el) return;
  if(!wo || !wo.updatedAt){ el.textContent = ''; return; }
  var when = ''; try { when = new Date(wo.updatedAt).toLocaleString('en-CA'); } catch(e){ when = wo.updatedAt; }
  var stat = wo.status === 'done' ? 'Completed' : (wo.status === 'in_progress' ? 'In progress' : 'Not started');
  el.textContent = 'Work order status: ' + stat + ' · Last updated ' + when + (wo.updatedBy ? (' by ' + wo.updatedBy) : '');
}

// ── Email confirmation after a document is generated ─────────────────────
// Called from INSIDE printWorkOrder()/printSOW() so EVERY entry point (modal
// footer, the unit-card SOW table, renos) behaves identically: open the
// document, then confirm the email. _sowPromptWorkOrderEmail asks about the
// work order (contractor OR in-house employee + Housing Manager CC).
async function _sowPromptWorkOrderEmail(){
  try{
    if(typeof showConfirm !== 'function') return;
    var sow = (_sowUnitId && window._sowEditingProjectNumber && typeof getSowByProjectNumber === 'function')
            ? getSowByProjectNumber(_sowUnitId, window._sowEditingProjectNumber) : null;
    if(!sow) return;
    var unit = (_sowUnitId && typeof getAllUnits === 'function')
             ? (getAllUnits().find(function(x){ return x.id === _sowUnitId; }) || null) : null;
    var team = sow.assignedTeam || (sow.contractorId ? 'contractor' : '');
    var _esc = escapeHtml; // shared-ui.js (same five-char escape)
    if(team === 'in_house'){
      // In-house: the work order always goes to the Housing Manager; the
      // selected field employee (if any) is added. The employee is optional.
      if(typeof notifyWorkOrderToFieldEmployee !== 'function') return;
      var hmLabel = (window.CLFN_PERMS && CLFN_PERMS.roleLabel) ? CLFN_PERMS.roleLabel('housing_manager') : 'Housing Manager';
      var hasEmp = !!(sow.assignedTo && String(sow.assignedTo).trim());
      var who = sow.assignedToName || sow.assignedTo || '';
      var msg = hasEmp
        ? 'Send this work order (PDF attached) to the assigned employee and the ' + hmLabel + '? Uncheck to skip sending.'
        : 'Send this work order (PDF attached) to the ' + hmLabel + '? Uncheck to skip sending.';
      var lbl = hasEmp
        ? (_esc(who) + ' (' + _esc(sow.assignedTo) + ') + ' + _esc(hmLabel))
        : _esc(hmLabel);
      var r = await showConfirm({
        title:'Email Work Order?',
        message: msg,
        confirmText:'Send Email', cancelText:'Cancel',
        checkbox:{ label: lbl, defaultChecked:true }
      });
      var ok  = (typeof r === 'object' && r) ? r.ok : r;
      var snd = (typeof r === 'object' && r) ? r.checked : false;
      if(ok && snd){
        notifyWorkOrderToFieldEmployee(sow, unit);
        _sowMarkWorkStarted(unit && unit.id, sow, sow.assignedToName || 'the assigned employee');
      }
    } else if(sow.contractorId){
      if(typeof notifyWorkOrderToContractor !== 'function' || typeof _resolveContractorForEmail !== 'function') return;
      var ct = await _resolveContractorForEmail(sow.contractorId);
      if(!ct){ if(typeof showToast === 'function') showToast('Contractor record not found.', {type:'error'}); return; }
      // Build the recipient list: the company email (default on) plus each Key
      // Contact that has an email on file (default off — the user opts each in).
      var _validEmail = function(e){ return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e||'').trim()); };
      var recips = [], seenR = {};
      var _pushRecip = function(id, email, name, defOn){
        var e = String(email||'').trim();
        if(!_validEmail(e)) return;
        var key = e.toLowerCase();
        if(seenR[key]) return;            // never email the same address twice
        seenR[key] = true;
        recips.push({ id:id, email:e,
          label: _esc(name || 'Contact') + ' &middot; <span style="color:var(--muted);">' + _esc(e) + '</span>',
          defaultChecked: !!defOn });
      };
      _pushRecip('company', ct.email, (ct.name || 'Company') + ' (company)', true);
      (ct.people || []).forEach(function(p, i){
        _pushRecip('kc_'+i, p && p.email, (p && p.name) ? (p.name + ' (key contact)') : 'Key contact', false);
      });
      if(!recips.length){ if(typeof showToast === 'function') showToast('No contractor or key-contact email on file.', {type:'error'}); return; }
      var r2 = await showConfirm({
        title:'Email Work Order?',
        message:'Select who should receive this work order (PDF attached):',
        confirmText:'Send Email', cancelText:'Cancel',
        checkboxes: recips.map(function(x){ return { id:x.id, label:x.label, defaultChecked:x.defaultChecked }; })
      });
      if(!r2 || !r2.ok) return;
      var picked = (r2.items) || {};
      var chosen = recips.filter(function(x){ return picked[x.id]; }).map(function(x){ return x.email; });
      if(!chosen.length){ if(typeof showToast === 'function') showToast('No recipients selected — nothing sent.', {type:'info'}); return; }
      notifyWorkOrderToContractor(sow, unit, ct, chosen);
      _sowMarkWorkStarted(unit && unit.id, sow, ct.name || 'the contractor');
    } else {
      if(typeof showToast === 'function') showToast('Assign this request to a contractor or employee to email the work order.', {type:'info'});
    }
  }catch(e){ console.warn('[sow] work-order email prompt threw:', e); }
}
window._sowPromptWorkOrderEmail = _sowPromptWorkOrderEmail;

// Emailing a work order STARTS the job: flip the unit's progress report to
// In Progress and stamp startDate = the day the contractor/crew was emailed,
// with a timeline entry saying so. Writes the same housing_reno_progress row
// saveRenoProgress uses (merge-duplicates upsert), and mirrors status onto
// the SOW's work-progress so the Renovations tables read In Progress.
async function _sowMarkWorkStarted(unitId, sow, whoLabel){
  try {
    if(!unitId) return;
    window._renoProgress = window._renoProgress || {};
    // AUDIT FIX: _renoProgress is only hydrated on renos/contractors pages.
    // Writing from housing/inventory/tenants used to upsert a near-empty
    // record over the server row, erasing progress %, photos and history.
    // Always fetch the server row and merge onto it.
    var prog = null;
    try {
      var pr = await fetch(SUPABASE_URL + '/rest/v1/housing_reno_progress?unit_id=eq.' + encodeURIComponent(unitId) + '&select=data', { headers: HOUSING_HEADERS });
      if(pr.ok){ var prows = await pr.json(); prog = (prows && prows[0] && prows[0].data) || null; }
    } catch(_pe){ /* fall back to local cache below */ }
    if(!prog) prog = window._renoProgress[unitId] || { updates: [], photos: [] };
    var today = new Date().toISOString().slice(0,10);
    if(!prog.startDate) prog.startDate = today;
    if(prog.status !== 'Completed') prog.status = 'In Progress';
    if(!prog.contractor && typeof sowContractorLabel === 'function'){
      var _cl = sowContractorLabel(sow);
      if(_cl) prog.contractor = _cl;
    }
    if(sow && sow.contractorId && !prog.contractorId) prog.contractorId = sow.contractorId;
    prog.updates = prog.updates || [];
    prog.updates.push({ date: today, status: 'In Progress', pct: prog.overallPct || 0,
      notes: 'Work order ' + ((sow && sow.project_number) || '') + ' emailed to ' + (whoLabel || 'the assignee') + ' — work started.' });
    window._renoProgress[unitId] = prog;
    fetch(SUPABASE_URL + '/rest/v1/housing_reno_progress', {
      method: 'POST',
      headers: Object.assign({}, HOUSING_HEADERS, { 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify({ unit_id: unitId, data: prog, updated_at: new Date().toISOString() })
    }).catch(function(e){ console.warn('[sow] progress start save failed:', e); });
    if(sow){
      sow.progress = sow.progress || {};
      if(sow.progress.percent == null) sow.progress.percent = prog.overallPct || 0;
      sow.progress.status = 'In Progress';
      sow.progress.updated_at = new Date().toISOString();
      if(typeof upsertSowInList === 'function') upsertSowInList(unitId, sow);
    }
    if(typeof renderRenoApprovalsView === 'function' && document.getElementById('ra_tbody')) renderRenoApprovalsView();
    if(typeof auditEntry === 'function') auditEntry('UNIT:' + unitId, 'reno_progress_started',
      'Progress set to In Progress — work order emailed to ' + (whoLabel || 'assignee'), window.currentRole || 'staff');
  } catch(e){ console.warn('[sow] mark work started threw:', e); }
}

// Footer "Progress Report" button: opens the unit's progress report. The
// progress modal only exists on renos.html — elsewhere we navigate there
// with a deep link the renos boot handles (?progress=<unitId>).
function _sowOpenProgress(){
  var uid = _sowUnitId;
  if(!uid){ if(typeof showToast === 'function') showToast('Save the request first — progress reports attach to the unit.', {type:'info'}); return; }
  if(typeof openRenoProgress === 'function' && document.getElementById('renoProgressModal')){
    // handoff: a plain closeSowModal() runs the contractors-/nav-referrer
    // return navigation, which would navigate away before the progress modal
    // opens (same fix as sowStartNewRequest).
    if(typeof closeSowModal === 'function') closeSowModal({handoff:true});
    openRenoProgress(uid);
  } else {
    window.location.href = 'renos.html?progress=' + encodeURIComponent(uid);
  }
}
window._sowOpenProgress = _sowOpenProgress;
// Back-compat aliases: any (possibly cached) markup still calling the old
// button handlers routes through the document functions, which now own both
// printing and the email prompt.
function sowWorkOrderClicked(){ if(typeof printWorkOrder === 'function') printWorkOrder(); }
function sowTenantFormClicked(){ if(typeof printSOW === 'function') printSOW(); }
window.sowWorkOrderClicked = sowWorkOrderClicked;
window.sowTenantFormClicked = sowTenantFormClicked;

// _sowPromptTenantEmail asks about emailing the tenant a copy of the request.
async function _sowPromptTenantEmail(){
  try{
    if(typeof showConfirm !== 'function' || typeof notifySowTenantCopy !== 'function') return;
    var sow = (_sowUnitId && window._sowEditingProjectNumber && typeof getSowByProjectNumber === 'function')
            ? getSowByProjectNumber(_sowUnitId, window._sowEditingProjectNumber) : null;
    if(!sow) return;
    var unit = (_sowUnitId && typeof getAllUnits === 'function')
             ? (getAllUnits().find(function(x){ return x.id === _sowUnitId; }) || null) : null;
    if(!unit) return;
    var email = '';
    if(typeof _resolveTenantEmailForUnit === 'function'){ try { email = await _resolveTenantEmailForUnit(unit); } catch(e){ email = ''; } }
    if(!email){ if(typeof showToast === 'function') showToast('No tenant email on file for this unit.', {type:'info'}); return; }
    var _esc = escapeHtml; // shared-ui.js (same five-char escape)
    var tenantName = unit.assignedName || 'the tenant';
    var r = await showConfirm({
      title:'Email Tenant Copy?',
      message:'Email a PDF copy of this maintenance request to the tenant? Uncheck to skip sending.',
      confirmText:'Send Email', cancelText:'Cancel',
      checkbox:{ label: _esc(tenantName) + ' (' + _esc(email) + ')', defaultChecked:true }
    });
    var ok  = (typeof r === 'object' && r) ? r.ok : r;
    var snd = (typeof r === 'object' && r) ? r.checked : false;
    if(ok && snd) notifySowTenantCopy(sow, unit);
  }catch(e){ console.warn('[sow] tenant-copy email prompt threw:', e); }
}
window._sowPromptTenantEmail = _sowPromptTenantEmail;

// ── SOW completion state control ──────────────────────────────────────────
// Applies read-only lock when a SOW is completed AND the viewer isn't the ED.
// Also toggles the Mark Complete / Reopen buttons based on status + permissions.
// True when a SOW is approved for RFQ purposes — completed, ED-approved, or
// HM-approved when ED isn't required (cost within the HM limit). Mirrors the
// renos approval table's 'approved' state. Once approved, requesting quotes is
// moot, so RFQ entry points hide.
function _sowIsApproved(sow){
  if(!sow) return false;
  var st = sow.approval_status || '';
  if(st === 'completed' || st === 'ed_approved') return true;
  if(st === 'hm_approved'){
    var cost = (typeof sow.amount === 'number' ? sow.amount
              : parseFloat((sow.totalCost||'').toString().replace(/[^0-9.]/g,''))) || 0;
    var hmLimit = (typeof _getHmLimit === 'function') ? _getHmLimit() : 25000;
    return cost <= hmLimit;
  }
  return false;
}
window._sowIsApproved = _sowIsApproved;

// Whether the RFQ (tender) process is still available for a request. A manual
// HM/ED approval authorizes the work/budget but does NOT select the contractor,
// so the RFQ button stays available after approval. It's only gone once the
// work is COMPLETED, the request is archived, or a contractor was already
// selected via an awarded RFQ (system_approved). Previously this hid on ANY
// approval (_sowIsApproved), which removed the button right after approving.
function _sowRfqStillOpen(sow){
  if(!sow) return false;
  if(sow.archived) return false;
  if(sow.approval_status === 'completed') return false;
  if(sow.system_approved || sow.approved_via_rfq) return false;
  return true;
}
window._sowRfqStillOpen = _sowRfqStillOpen;

// Navigate from the open request to the RFQ page for it. Persists any form
// edits FIRST — but only when the request isn't already approved, because
// re-saving an approved request as a non-ED can strip the ED sign-off and
// downgrade its status (the review step defaults to blank approval fields for
// roles that can't sign at that tier). For an approved request we hand off the
// already-saved record untouched.
// Pre-print/handoff save guard. Printing must never MOVE workflow state: an
// unconditional saveSOW() from a print button used to (a) strip HM/ED sign-offs
// when the printer lacked approval authority (the authority gate blanks the
// fields, the status recomputes downward, and the approved MR re-entered the
// approval queue), and (b) rebuild the record without its archived flag. So we
// only persist form edits when the request is still safely editable: unsaved,
// or saved but not approved/archived/cancelled. Approved/terminal requests
// print from the already-saved record untouched.
function _sowSafePreprintSave(){
  if(typeof saveSOW !== 'function') return;
  var _ex = (_sowUnitId && window._sowEditingProjectNumber && typeof getSowByProjectNumber === 'function')
    ? getSowByProjectNumber(_sowUnitId, window._sowEditingProjectNumber) : null;
  if(_ex && (_sowIsApproved(_ex) || _ex.archived || _ex.cancelled || _ex.system_approved)) return;
  // keepOpen: this save is a side effect of printing, not the user moving the
  // request forward — without it, saveSOW's completion path closes the modal
  // (and navigates back to the origin page) right under the print preview.
  saveSOW({ keepOpen: true });
}
window._sowSafePreprintSave = _sowSafePreprintSave;

function sowOpenRfq(){
  if(!(_sowUnitId && window._sowEditingProjectNumber)){
    if(typeof showToast === 'function') showToast('Save the request first', {type:'error'});
    return;
  }
  var _existing = (typeof getSowByProjectNumber === 'function')
    ? getSowByProjectNumber(_sowUnitId, window._sowEditingProjectNumber) : null;
  if(!_existing || !_sowIsApproved(_existing)){ if(typeof saveSOW === 'function') saveSOW(); }
  try {
    var _c  = window._sowCache && window._sowCache[_sowUnitId];
    var _sa = _c && Array.isArray(_c.sows) ? _c.sows : (_c && Array.isArray(_c) ? _c : []);
    var _sh = _sa.find(function(s){ return s && s.project_number === window._sowEditingProjectNumber; }) || null;
    if(_sh) sessionStorage.setItem('_rfq_sow_handoff', JSON.stringify(_sh));
  } catch(e){}
  window.location.href = 'rfq.html?unit=' + encodeURIComponent(_sowUnitId) + '&sow=' + encodeURIComponent(window._sowEditingProjectNumber);
}
window.sowOpenRfq = sowOpenRfq;

// Start a brand-new request for the SAME unit as the one currently open. Lets
// staff add a second work order (e.g. under a different contractor) without
// completing or archiving the existing one -- a unit can hold multiple requests,
// each with its own project number. Closes the current request first (save it
// before clicking this if you have unsaved edits).
function sowStartNewRequest(){
  var unitId = _sowUnitId;
  if(!unitId){ if(typeof showToast === 'function') showToast('Open a request on a unit first.', {type:'error'}); return; }
  // handoff: close WITHOUT the nav-referrer return — closing normally here
  // navigated back to the origin page (worklist/deep link) before the fresh
  // form below could open, so "New Request" just closed the modal.
  if(typeof closeSowModal === 'function') closeSowModal({handoff:true});
  window._sowForceNew = true;          // one-shot: bypass the open-existing / picker path
  openSowModal(unitId);
}
window.sowStartNewRequest = sowStartNewRequest;


// Fill the "Assigned To" field-employee dropdown from active staff whose role is
// field_employee. Uses _staffCache when present, otherwise fetches once and
// caches in window._fieldEmployeeCache. selectedEmail pre-selects the saved value.
function _sowPopulateFieldEmployees(selectedEmail){
  var sel = document.getElementById('sow_assigned_to');
  if(!sel) return;
  var esc = (typeof escapeHtml === 'function') ? escapeHtml : function(s){ return String(s==null?'':s); };
  var norm = (window.CLFN_PERMS && CLFN_PERMS.normalizeRole) ? CLFN_PERMS.normalizeRole : function(r){ return String(r||'').toLowerCase(); };
  var want = (selectedEmail || '').toLowerCase();
  function build(list){
    var opts = ['<option value="">— Select field employee —</option>'];
    (list||[]).forEach(function(s){
      var email = (s.email||'').toLowerCase();
      var name  = s.name || s.email || email;
      if(!email) return;
      opts.push('<option value="'+esc(email)+'" data-name="'+esc(name)+'"'+(email===want?' selected':'')+'>'+esc(name)+'</option>');
    });
    sel.innerHTML = opts.join('');
  }
  if(Array.isArray(window._fieldEmployeeCache)){ build(window._fieldEmployeeCache); return; }
  var fromStaff = [];
  if(window._staffCache){
    Object.keys(window._staffCache).forEach(function(id){
      var s = window._staffCache[id];
      if(s && s.is_active !== false && norm(s.role) === 'field_employee') fromStaff.push(s);
    });
  }
  if(fromStaff.length){ window._fieldEmployeeCache = fromStaff; build(fromStaff); return; }
  try {
    fetch(SUPABASE_URL + '/rest/v1/staff?is_active=eq.true&select=id,name,email,role,department&order=name', { headers: HOUSING_HEADERS })
      .then(function(r){ return r.ok ? r.json() : []; })
      .then(function(rows){
        var fes = (rows||[]).filter(function(s){ return norm(s.role) === 'field_employee'; });
        window._fieldEmployeeCache = fes;
        build(fes);
      }).catch(function(){ build([]); });
  } catch(e){ build([]); }
}

function _applySowModalLock(sow){
  var modal = document.getElementById('sowModal');
  if(!modal) return;
  var completed = isSowCompleted(sow);
  var cancelled = !!(sow && sow.cancelled);
  var canEdit   = canEditSow(sow);
  var _canReopen = (typeof canReopenSow === 'function') && canReopenSow();
  // A cancelled request is frozen for everyone except the ED tier (who can
  // reopen it). Completed keeps its existing lock rule.
  var readOnly  = (completed && !canEdit) || (cancelled && !_canReopen);

  // Banner
  var banner = document.getElementById('sow_readonly_banner');
  if(banner) banner.style.display = readOnly ? 'block' : 'none';

  // ── Work-order assignment (in-house Housing Dept vs contractor) ───────────
  // The "Assigned To" field is one picker (sow_contractor): the search lists the
  // nation's own Housing Department first, then external contractors. Picking the
  // Housing Dept reveals the field-employee sub-menu.
  var _aRoleAssign = window.currentRole || '';
  var _canAssign = (typeof APPROVAL_AUTHORITY !== 'undefined') && APPROVAL_AUTHORITY.can('assignWorkOrder', _aRoleAssign);
  var _ctInp   = document.getElementById('sow_contractor');
  var _ctHid   = document.getElementById('sow_contractor_id');
  var _teamHid = document.getElementById('sow_assigned_team');
  var _feSel   = document.getElementById('sow_assigned_to');

  // Load saved assignment; infer 'contractor' for legacy SOWs with a contractor.
  var _savedTeam = (sow && (sow.assignedTeam || sow.assigned_team)) || '';
  var _savedTo   = (sow && (sow.assignedTo   || sow.assigned_to))   || '';
  var _savedCtr  = (sow && sow.contractor) || '';
  var _savedCtrId= (sow && (sow.contractorId || sow.contractor_id)) || '';
  if(!_savedTeam && (_savedCtrId || _savedCtr)) _savedTeam = 'contractor';

  if(_teamHid) _teamHid.value = _savedTeam;
  if(_savedTeam === 'in_house'){
    if(_ctInp) _ctInp.value = (typeof sowInHouseLabel === 'function') ? sowInHouseLabel() : 'Housing Department';
    if(_ctHid) _ctHid.value = '';
    if(typeof _sowPopulateFieldEmployees === 'function') _sowPopulateFieldEmployees(_savedTo);
    if(_feSel) _feSel.style.display = '';
  } else {
    if(_ctInp) _ctInp.value = _savedCtr || '';
    if(_ctHid) _ctHid.value = _savedCtrId || '';
    if(_feSel) _feSel.style.display = 'none';
  }

  // Only roles with assignWorkOrder authority can change the assignment.
  if(_ctInp) _ctInp.disabled = !_canAssign || readOnly;
  if(_feSel) _feSel.disabled = !_canAssign || readOnly;

  // Inline Approve button — shown when the current user has approval authority
  // and the SOW is in a state that requires their specific action.
  var apBtn = document.getElementById('sow_approve_btn');
  if (apBtn) {
    var _aRole   = window._realRole || window.currentRole || '';
    var _canHm   = (typeof APPROVAL_AUTHORITY !== 'undefined') && APPROVAL_AUTHORITY.can('approveSowUnderThreshold', _aRole);
    var _canEd   = (typeof APPROVAL_AUTHORITY !== 'undefined') && APPROVAL_AUTHORITY.can('approveSowOverThreshold', _aRole);
    var _sowSt   = sow ? (sow.approval_status || '') : '';
    var _hasPn   = !!(sow && sow.project_number);
    var _hasItems= !!(sow && sow.items && sow.items.length);
    // HM sees button when SOW is unreviewed (not yet hm_approved or higher)
    var _showHm  = _canHm && !_canEd && _hasPn && _hasItems && !completed &&
                   (_sowSt === '' || _sowSt === 'draft' || _sowSt === 'signed' || _sowSt === 'submitted');
    // ED sees button when SOW is at hm_approved AND over the budget limit (needs
    // ED final), or at any pre-approval stage (ED can approve directly — an ED
    // approval is terminal, so the HM does not also need to approve). NOTE:
    // 'submitted' must be included or the ED cannot approve a submitted SOW even
    // though the worklist shows it to them.
    var _needsEd = (typeof sowRequiresEdApproval === 'function') && sowRequiresEdApproval(sow);
    var _showEd  = _canEd && _hasPn && _hasItems && !completed &&
                   ((_sowSt === 'hm_approved' && _needsEd) || _sowSt === '' || _sowSt === 'draft' || _sowSt === 'signed' || _sowSt === 'submitted');
    var _showAp  = (_showHm || _showEd) && !cancelled;
    apBtn.style.display = _showAp ? 'flex' : 'none';
    apBtn.textContent   = (_sowSt === 'hm_approved') ? '✓ Final Approve' : '✓ Approve';
  }

  // Mark Complete button: only show when SOW is NOT completed/cancelled AND viewer is HM or ED AND there's a unit/saved SOW.
  var mcBtn = document.getElementById('sow_mark_complete_btn');
  if(mcBtn){
    var showMC = !completed && !cancelled && canMarkSowComplete() && !!_sowUnitId && !!window._sowEditingProjectNumber;
    mcBtn.style.display = showMC ? 'flex' : 'none';
  }

  // Cancel Request button: management-only, on a SAVED request that isn't
  // already cancelled or completed. Cancelling a request whose work order was
  // sent to a contractor offers to email them a cancellation notice.
  var cxBtn = document.getElementById('sow_cancel_btn');
  if(cxBtn){
    var _cxRole = window._realRole || window.currentRole || '';
    var _cxMgmt = (typeof ROLE !== 'undefined' && ROLE.isManagement) ? ROLE.isManagement(_cxRole) : true;
    var showCx  = _cxMgmt && !cancelled && !completed && !!_sowUnitId && !!(sow && sow.project_number);
    cxBtn.style.display = showCx ? 'flex' : 'none';
  }

  // Reopen button: show when completed OR cancelled AND viewer is ED (reopen
  // un-cancels / un-completes back to an editable state).
  var roBtn = document.getElementById('sow_reopen_btn');
  if(roBtn){
    roBtn.style.display = ((completed || cancelled) && _canReopen) ? 'flex' : 'none';
  }

  // Archive button: visible whenever the SOW has been initiated (has a
  // project_number) and isn't already archived — regardless of viewer role.
  // Hidden on new SOWs (no project number yet — nothing to archive) and on
  // already-archived SOWs (restore happens from the unit-detail-panel SOW
  // table where the archived row is visible).
  var arBtn = document.getElementById('sow_archive_btn');
  if(arBtn){
    var _arSaved = !!sow && !!sow.project_number;
    var _arShow  = _arSaved && !sow.archived;
    arBtn.style.display = _arShow ? 'flex' : 'none';
  }

  // New Request: shown whenever a SAVED request is open (any status). Lets staff
  // add another request for this unit -- e.g. a second work order under a
  // different contractor -- without having to complete/archive this one.
  var nrBtn = document.getElementById('sow_new_request_btn');
  if(nrBtn){
    nrBtn.style.display = (!!sow && !!sow.project_number) ? 'flex' : 'none';
  }

  // RFQ button: show on ANY saved maintenance request that is still tenderable
  // (not completed / already awarded), whenever the RFQ module is on -- no cost
  // threshold. It requires the MR to be SAVED (a project number) so the RFQ has
  // a SOW to link to; RFQ editing itself stays HM/ED-gated on the RFQ page.
  var rfqBtn = document.getElementById('sow_rfq_btn');
  if (rfqBtn) {
    var _rfqShow = !!(sow && sow.project_number)
      && !cancelled
      && _sowRfqStillOpen(sow)
      && (typeof moduleOn !== 'function' || moduleOn('rfq'));
    rfqBtn.style.display = _rfqShow ? 'flex' : 'none';
  }

  // Save button: hidden in read-only mode.
  var saveBtn = document.getElementById('sow_save_btn');
  if(saveBtn) saveBtn.style.display = readOnly ? 'none' : '';

  // Disable every form control inside the modal body when read-only.
  // Scoped to .tic-body so header/footer controls (close, Cancel) are
  // untouched — mirrors _ueApplyReadOnly's use of the same class.
  var body = modal.querySelector('.tic-body');
  if(body){
    var controls = body.querySelectorAll('input, select, textarea, button');
    controls.forEach(function(el){
      // Never disable the "close the modal" or "add SOW line" structural controls? Actually,
      // when read-only we disable them all so the SOW is effectively frozen in view.
      // The only escape is the X in the modal header (not inside body), which stays enabled.
      if(readOnly){
        el.setAttribute('data-sow-locked', '1');
        el.disabled = true;
        el.style.opacity = '0.6';
        el.style.cursor = 'not-allowed';
      } else if(el.getAttribute('data-sow-locked') === '1'){
        // Un-lock if we previously locked this element.
        el.removeAttribute('data-sow-locked');
        el.disabled = false;
        el.style.opacity = '';
        el.style.cursor = '';
      }
    });
    // Disable signature canvases too (they're <canvas> not form controls; swap pointer-events).
    body.querySelectorAll('canvas').forEach(function(c){
      c.style.pointerEvents = readOnly ? 'none' : '';
      c.style.opacity = readOnly ? '0.55' : '';
    });
  }
}

// Inline approval from the SOW modal header — used when HM or ED opens a SOW
// directly (e.g. from the landing-page worklist) and wants to approve without
// navigating to the Renos Approvals page.
function sowApproveInline() {
  var role   = window._realRole || window.currentRole || '';
  var canHm  = (typeof APPROVAL_AUTHORITY !== 'undefined') && APPROVAL_AUTHORITY.can('approveSowUnderThreshold', role);
  var canEd  = (typeof APPROVAL_AUTHORITY !== 'undefined') && APPROVAL_AUTHORITY.can('approveSowOverThreshold', role);
  if (!canHm && !canEd) { if (typeof showToast === 'function') showToast('You do not have approval authority for this request.', {type:'info'}); return; }

  var approver = canEd ? 'ed' : 'hm';
  var today    = new Date().toISOString().split('T')[0];
  var staffName = (typeof HOUSING_SESSION !== 'undefined' && HOUSING_SESSION.name) || role;

  // Does this request still need ED final approval? Only if its cost is over the
  // HM budget limit. Under the limit, HM approval is final (no ED step).
  var _apTotalEl = document.getElementById('sow_total_cost');
  var _apCost = _apTotalEl ? (parseFloat(String(_apTotalEl.value).replace(/[^0-9.\-]/g, '')) || 0) : 0;
  if (!_apCost && _sowUnitId && window._sowEditingProjectNumber && typeof getSowByProjectNumber === 'function') {
    var _apSow = getSowByProjectNumber(_sowUnitId, window._sowEditingProjectNumber);
    if (_apSow && typeof _apSow.amount === 'number') _apCost = _apSow.amount;
  }
  var _apNeedsEd = (typeof sowRequiresEdApproval === 'function') && sowRequiresEdApproval({ amount: _apCost });

  var title   = approver === 'ed'
    ? 'Grant ED Final Approval?'
    : (_apNeedsEd ? 'Approve as Housing Manager?' : 'Approve Maintenance Request?');
  var message = approver === 'ed'
    ? 'This will record your ED approval on this Maintenance Request.'
    : (_apNeedsEd
        ? 'This request is over the budget limit, so this records your HM approval and forwards it to the Executive Director for final approval.'
        : 'This records your approval. The request will be approved and ready for the work order — no further sign-off is required.');

  if (typeof showConfirm !== 'function') return;
  showConfirm({ title: title, message: message, confirmText: 'Approve', danger: false }).then(function(ok) {
    if (!ok) return;
    // Capture the prior status BEFORE saving so we only prompt the next step on
    // the FIRST approval transition (an over-threshold request goes HM -> ED).
    var _prevSt = '';
    try {
      if (_sowUnitId && window._sowEditingProjectNumber && typeof getSowByProjectNumber === 'function') {
        var _pr = getSowByProjectNumber(_sowUnitId, window._sowEditingProjectNumber);
        _prevSt = (_pr && _pr.approval_status) || '';
      }
    } catch (e) {}
    // Set the appropriate approval fields (picked up by saveSOW → approval_status logic)
    var nmId  = approver === 'ed' ? 'sow_ed_name' : 'sow_hm_name';
    var dtId  = approver === 'ed' ? 'sow_ed_date' : 'sow_hm_date';
    var nmEl  = document.getElementById(nmId);
    var dtEl  = document.getElementById(dtId);
    if (nmEl) nmEl.value = staffName;
    if (dtEl) dtEl.value = today;
    // Save directly rather than via sowSaveClicked(): approving is not the same
    // as the preparer *submitting*, so we skip that path's "Submit + email a
    // tenant PDF copy" prompt. saveSOW derives approval_status from the hm/ed
    // name+date fields set above.
    if (typeof saveSOW === 'function') saveSOW();
    // Now approved — prompt the next step (issue work order / start RFQ), once.
    var _wasApproved = _prevSt === 'hm_approved' || _prevSt === 'ed_approved' || _prevSt === 'completed';
    var js = window._sowJustSaved;
    if (!_wasApproved && js && js.unitId && js.projectNumber && typeof _sowPromptIssue === 'function') {
      _sowPromptIssue(js.unitId, js.projectNumber, js.amount);
    }
  });
}

// Headless inline approval fired straight from the "My Worklist" Approve button
// (renderWorklist in shared-data.js) — approves a SPECIFIC SOW by unit + project
// number WITHOUT opening the modal. This removes the friction of the old flow
// (worklist button just opened the modal, then the user had to find the modal's
// tiny "Approve" button, and a multi-SOW unit showed a picker first). Authority
// is resolved from the REAL authenticated role (view-as is a preview), matching
// sowApproveInline + saveSOW. Reuses _sowComputeApprovalStatus + _sowFireEmails
// so status derivation and the contractor work-order email stay identical to the
// modal path.
// The ED tier (real role ed / super_user) always retains final SOW approval
// authority, regardless of the configurable Approval Authority lists. Those
// lists exist to DELEGATE approval down to the Housing Manager — they must not
// be able to lock the ED out of their own final sign-off (which stranded
// over-threshold requests in "Awaiting ED" with the ED unable to approve them).
function _isEdApprovalTier(role){
  var r = role || window._realRole || window.currentRole || '';
  if (window.CLFN_PERMS && typeof CLFN_PERMS.normalizeRole === 'function') {
    try { r = CLFN_PERMS.normalizeRole(r) || r; } catch(e){}
  }
  return r === 'ed' || r === 'super_user' || (window.ROLE && r === ROLE.ED);
}
window._isEdApprovalTier = _isEdApprovalTier;

function _wlApproveSow(uid, pn){
  var role  = window._realRole || window.currentRole || '';
  var _edTier = _isEdApprovalTier(role);
  var canHm = _edTier || ((typeof APPROVAL_AUTHORITY !== 'undefined') && APPROVAL_AUTHORITY.can('approveSowUnderThreshold', role));
  var canEd = _edTier || ((typeof APPROVAL_AUTHORITY !== 'undefined') && APPROVAL_AUTHORITY.can('approveSowOverThreshold', role));
  if(!canHm && !canEd){
    if(typeof showToast === 'function') showToast('Your role (' + (role || 'unknown') + ') is not set up to approve this request. Check Settings → Approval Authority.', {type:'error'});
    return;
  }
  // Fall back to opening the modal if we can't resolve the specific SOW here.
  if(typeof getSowByProjectNumber !== 'function' || !uid || !pn){
    if(typeof openSowModal === 'function') openSowModal(uid, pn);
    return;
  }
  var sow = getSowByProjectNumber(uid, pn);
  if(!sow){
    if(typeof openSowModal === 'function') openSowModal(uid, pn);
    return;
  }
  var approver = canEd ? 'ed' : 'hm';
  var needsEd  = (typeof sowRequiresEdApproval === 'function') && sowRequiresEdApproval(sow);
  var title    = approver === 'ed'
    ? 'Grant ED Final Approval?'
    : (needsEd ? 'Approve as Housing Manager?' : 'Approve Maintenance Request?');
  var message  = approver === 'ed'
    ? 'This records your ED approval on ' + pn + '. ED approval is final — no further sign-off is required and it will clear from the worklist.'
    : (needsEd
        ? 'This request is over the budget limit, so this records your HM approval on ' + pn + ' and forwards it to the Executive Director for final approval.'
        : 'This records your approval on ' + pn + '. The request will be approved and ready for the work order — no further sign-off is required.');
  if(typeof showConfirm !== 'function'){ if(typeof openSowModal === 'function') openSowModal(uid, pn); return; }

  showConfirm({ title: title, message: message, confirmText: 'Approve', danger: false }).then(function(ok){
    if(!ok) return;
    var today = new Date().toISOString().split('T')[0];
    var name  = (typeof HOUSING_SESSION !== 'undefined' && HOUSING_SESSION.name) || role;
    var prevStatus = sow.approval_status || '';
    if(approver === 'ed'){ sow.edName = name; sow.edDate = today; }
    else                 { sow.hmName = name; sow.hmDate = today; }
    // Derive approval_status with the shared helper (real role, submit mode so
    // the review-all-tabs gate doesn't force it back to draft).
    if(typeof _sowComputeApprovalStatus === 'function'){
      _sowComputeApprovalStatus(sow, sow, role, 'submit');
    }
    // Explicitly stamp the target status for a worklist approval. This is a
    // deliberate, direct action (the ED/HM clicked Approve on this request), so
    // it must advance the status even if _sowComputeApprovalStatus hit an
    // edge-case branch that preserved the prior status — e.g. a stale
    // `approval_auto` flag (auto-approved earlier under a higher ED threshold
    // that has since been lowered) kept it at 'hm_approved', leaving the request
    // stuck in "Awaiting ED" no matter how many times the ED approved it.
    if(approver === 'ed'){
      sow.approval_status = 'ed_approved';
      sow.approval_auto = false;   // a real human ED sign-off supersedes any auto-approval
    } else if(sow.approval_status !== 'ed_approved'){
      sow.approval_status = 'hm_approved';
    }
    if(typeof upsertSowInList === 'function') upsertSowInList(uid, sow);
    if(typeof auditEntry === 'function'){
      auditEntry('SOW:'+uid, approver === 'ed' ? 'sow_ed_approval' : 'sow_hm_approval',
        (approver === 'ed' ? 'ED' : 'HM') + ' approval recorded (worklist) — ' + name + ' on ' + today + ' · ' + pn, role);
    }
    // Unit auto-flip to under-repair on first approval (mirrors saveSOW).
    try {
      var units = (typeof housingUnits !== 'undefined' && housingUnits.length) ? housingUnits : [];
      var u = units.find(function(x){ return x && x.id === uid; });
      if(u && typeof maybeAutoFlipUnitForSow === 'function' && maybeAutoFlipUnitForSow(u, sow, prevStatus)
         && typeof saveUnitWithDraftFallback === 'function'){
        saveUnitWithDraftFallback(u);
      }
    } catch(e){ console.warn('[wlApprove] unit flip threw:', e); }
    // Contractor work-order email on the approval transition (saveMode null so
    // only the status-transition email fires, not the submit-only ones).
    try {
      if(typeof _sowFireEmails === 'function'){
        var _prevUnitId = _sowUnitId; _sowUnitId = uid;   // _sowFireEmails reads this
        _sowFireEmails(sow, { approval_status: prevStatus, assignedTo: sow.assignedTo, contractorId: sow.contractorId }, false, false, null);
        _sowUnitId = _prevUnitId;
      }
    } catch(e){ console.warn('[wlApprove] email fire threw:', e); }
    if(typeof showToast === 'function') showToast('✓ ' + pn + ' approved', {type:'info'});
    if(typeof renderWorklist === 'function') renderWorklist();
    if(typeof udpRenderSowTable === 'function' && document.getElementById('udp_sow_table_wrap')) udpRenderSowTable(uid);
    // Now approved — prompt the next step (issue work order / start RFQ). Only
    // on the FIRST approval transition, so an over-threshold request that goes
    // HM -> ED doesn't prompt twice.
    var _wasApproved = prevStatus === 'hm_approved' || prevStatus === 'ed_approved' || prevStatus === 'completed';
    if(!_wasApproved && typeof _sowPromptIssue === 'function'){
      var _amt = parseFloat(sow.amount) || parseFloat(String(sow.totalCost||'').replace(/[^0-9.]/g,'')) || 0;
      _sowPromptIssue(uid, pn, _amt);
    }
  });
}
window._wlApproveSow = _wlApproveSow;

// One-step completion: a single dialog carries the lock warning AND the
// optional tenant-file note (they used to be two dialogs, followed by a
// manual save + manual close — five steps for one action). Confirming marks
// the request complete, saves the note if one was typed, CLOSES the modal,
// and refreshes the lists behind it.
function markSowComplete(){
  if(!_sowUnitId || !window._sowEditingProjectNumber){
    showToast('Save the request before marking complete.', {type:'error'});
    return;
  }
  if(!canMarkSowComplete()){
    showToast('Only Housing Manager or Executive Director can mark a request complete.', {type:'info'});
    return;
  }
  var pn = window._sowEditingProjectNumber;
  var _cu = (typeof housingUnits !== 'undefined' ? housingUnits : []).find(function(x){ return x.id === _sowUnitId; });
  var tenantName = (_cu && _cu.assignedName) || '';
  var esc = function(s){ return (typeof escapeHtml === 'function') ? escapeHtml(s) : String(s == null ? '' : s); };
  var ex = document.getElementById('sowCompleteModal'); if(ex) ex.remove();
  var mo = document.createElement('div');
  mo.id = 'sowCompleteModal';
  mo.className = 'modal-ov on';
  mo.style.zIndex = '10070';
  mo.innerHTML =
      '<div class="modal" style="max-width:470px;">'
    + '<div class="modal-hdr"><div><h2 style="font-size:16px;">Mark ' + esc(pn) + ' Completed?</h2>'
    +   '<div class="modal-hdr-sub">This locks the request, work order and progress reports. Only the Executive Director can reopen it.</div></div>'
    +   '<button class="modal-close" onclick="var m=document.getElementById(\'sowCompleteModal\');if(m)m.remove();">&#x2715;</button></div>'
    + '<div style="padding:16px;">'
    +   (tenantName
          ? '<div class="f"><label>Completion note for ' + esc(tenantName) + '\u2019s file (optional)</label>'
            + '<textarea id="sow_complete_note" rows="3" placeholder="e.g. Replaced furnace igniter, tested OK. Tenant advised\u2026" style="width:100%;box-sizing:border-box;"></textarea></div>'
          : '')
    +   '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px;">'
    +     '<button class="btn btn-ghost" onclick="var m=document.getElementById(\'sowCompleteModal\');if(m)m.remove();">Cancel</button>'
    +     '<button class="btn btn-primary" id="sow_complete_go">&#10003; Mark Complete</button>'
    +   '</div>'
    + '</div></div>';
  mo.addEventListener('click', function(e){ if(e.target === mo) mo.remove(); });
  document.body.appendChild(mo);
  mo.querySelector('#sow_complete_go').addEventListener('click', function(){
    var note = ((document.getElementById('sow_complete_note')||{}).value || '').trim();
    mo.remove();
    _sowDoComplete(pn, tenantName, note);
  });
}

function _sowDoComplete(pn, tenantName, note){
  var sow = getSowByProjectNumber(_sowUnitId, pn);
  if(!sow){ showToast('Request not found', {type:'error'}); return; }
  sow.approval_status = 'completed';
  sow.completed_at = new Date().toISOString();
  sow.completed_by = window.currentUserName || _realRoleForPermissions();
  upsertSowInList(_sowUnitId, sow);
  auditEntry('SOW:'+_sowUnitId, 'sow_completed', 'SOW '+pn+' marked Completed', _realRoleForPermissions());
  // If this completion drained the last active SOW on the unit, revert the
  // unit's status back to whatever it was before the renovation kicked in.
  try {
    var _allUnits = (typeof housingUnits !== 'undefined' && housingUnits.length) ? housingUnits : [];
    var _u = _allUnits.find(function(x){ return x.id === _sowUnitId; });
    if(_u && typeof hasActiveSows === 'function' && !hasActiveSows(_sowUnitId)
       && typeof revertUnitFromRepair === 'function' && revertUnitFromRepair(_u)){
      saveUnitWithDraftFallback(_u);
      auditEntry('UNIT:'+_sowUnitId, 'unit_status_auto', (_u.num+' '+_u.street).trim()+' \u2192 '+(_u.status||'updated')+' (SOW '+pn+' completed, no active SOWs remain)', _realRoleForPermissions());
    }
  } catch(e){ console.warn('[SOW] complete-revert threw:', e); }
  // Note typed in the completion dialog goes straight to the tenant file.
  if(note && tenantName && typeof sbSaveTenantNote === 'function'){
    try { sbSaveTenantNote(tenantName, note, { context: 'sow_complete', prefix: '[Work order ' + pn + ']' }); }
    catch(e){ console.warn('[SOW] completion note save threw:', e); }
  }
  showToast('\u2713 Request ' + pn + ' marked Completed' + (note ? ' \u2014 note saved to the tenant file' : ''), {type:'info'});
  // Done means DONE: close the request form and land back on the list.
  if(typeof closeSowModal === 'function') closeSowModal();
  // Re-render the surfaces that filter completed requests — the reno-approvals
  // table ("Hide completed" only applies at render time) and the worklist.
  if(typeof renderRenoApprovalsView === 'function' && document.getElementById('ra_tbody')) renderRenoApprovalsView();
  if(typeof renderWorklist === 'function' && document.getElementById('worklist_body')) renderWorklist();
  if(typeof udpRenderSowTable === 'function' && _sowUnitId && document.getElementById('udp_sow_table_wrap')) udpRenderSowTable(_sowUnitId);
}

function reopenSow(){
  if(!_sowUnitId || !window._sowEditingProjectNumber) return;
  if(!canReopenSow()){
    showToast('Only the Executive Director can reopen a completed or cancelled request.', {type:'error'});
    return;
  }
  var pn = window._sowEditingProjectNumber;
  var _wasCancelled = (function(){ var s = getSowByProjectNumber(_sowUnitId, pn); return !!(s && s.cancelled); })();
  showConfirm({
    title:       'Reopen Request ' + pn + ' for editing?',
    message:     _wasCancelled
      ? 'This un-cancels the request and returns it to its prior approval state so it can be modified.'
      : 'This returns the request to its prior approval state so it can be modified.',
    confirmText: 'Reopen'
  }).then(function(ok){
    if (!ok) return;
    var sow = getSowByProjectNumber(_sowUnitId, pn);
    if(!sow){ showToast('Request not found', {type:'error'}); return; }
    // Clear a cancelled state on reopen (un-cancel).
    if(sow.cancelled){ sow.cancelled = false; sow.cancelled_at = null; sow.cancelled_by = null; }
    if(sow.edName && sow.edDate) sow.approval_status = 'ed_approved';
    else if(sow.hmName && sow.hmDate) sow.approval_status = 'hm_approved';
    else if((sow.tenantSig && sow.tenantSig.image) || (sow.staffSig && sow.staffSig.image)) sow.approval_status = 'signed';
    else sow.approval_status = 'draft';
    sow.reopened_at = new Date().toISOString();
    sow.reopened_by = window.currentUserName || _realRoleForPermissions();
    upsertSowInList(_sowUnitId, sow);
    window._sowCurrentSowMeta = {approval_status: sow.approval_status, system_approved: sow.system_approved, archived: sow.archived, cancelled: sow.cancelled};
    auditEntry('SOW:'+_sowUnitId, 'sow_reopened', 'SOW '+pn+(_wasCancelled?' un-cancelled and reopened':' reopened for editing'), _realRoleForPermissions());
    if(typeof renderWorklist === 'function' && document.getElementById('worklist_body')) renderWorklist();
    if(typeof udpRenderSowTable === 'function' && document.getElementById('udp_sow_table_wrap')) udpRenderSowTable(_sowUnitId);
    showToast(_wasCancelled ? 'Request reopened (un-cancelled)' : 'Request reopened', {type:'info'});
    _applySowModalLock(sow);
  });
}

// ── Cancel a Maintenance Request ──────────────────────────────────────────
// Management-only. Marks the request cancelled (frozen; ED can reopen), and —
// when the work order was assigned to a contractor with an email on file —
// offers to send them a cancellation notice.
function cancelSow(){
  // Guard toasts carry {type:'error'} — type-less toasts are suppressed
  // entirely, so these bails used to give NO visible feedback (dead button).
  if(!_sowUnitId || !window._sowEditingProjectNumber){
    showToast('Save the request before cancelling.', {type:'error'});
    return;
  }
  var _cxRole = window._realRole || window.currentRole || '';
  if(!(typeof ROLE !== 'undefined' && ROLE.isManagement && ROLE.isManagement(_cxRole))){
    showToast('Only the Housing Manager or Executive Director can cancel a request.', {type:'error'});
    return;
  }
  var pn  = window._sowEditingProjectNumber;
  var sow = getSowByProjectNumber(_sowUnitId, pn);
  if(!sow){ showToast('Request not found', {type:'error'}); return; }

  // Resolve an assigned contractor with an email (only for contractor-assigned
  // work — in-house jobs have no external party to notify).
  var _isContractor = (sow.assignedTeam === 'contractor') || (!sow.assignedTeam && (sow.contractorId || sow.contractor));
  var _ctId = sow.contractorId || sow.contractor_id || '';

  (async function(){
    var ct = null;
    if(_isContractor && _ctId && typeof _resolveContractorForEmail === 'function'){
      try { ct = await _resolveContractorForEmail(_ctId); } catch(e){ ct = null; }
    }
    var canNotify = !!(ct && ct.email);
    var conf;
    if(canNotify){
      conf = await showConfirm({
        title:       'Cancel Request ' + pn + '?',
        message:     'This marks the Maintenance Request cancelled and frees the unit. The work order was assigned to <strong>' + escapeHtml(ct.name || 'the contractor') + '</strong>. Only the Executive Director can reopen it.',
        confirmText: 'Cancel Request', danger: true,
        checkbox:    { label: 'Email a cancellation notice to ' + (ct.name || 'the contractor'), defaultChecked: true }
      });
    } else {
      conf = await showConfirm({
        title:       'Cancel Request ' + pn + '?',
        message:     'This marks the Maintenance Request cancelled and frees the unit. Only the Executive Director can reopen it.',
        confirmText: 'Cancel Request', danger: true
      });
    }
    var ok = (typeof conf === 'object' && conf !== null) ? !!conf.ok : !!conf;
    if(!ok) return;
    var doNotify = canNotify && (typeof conf === 'object' && conf !== null ? !!conf.checked : false);

    sow.cancelled = true;
    sow.cancelled_at = new Date().toISOString();
    sow.cancelled_by = window.currentUserName || _realRoleForPermissions();
    upsertSowInList(_sowUnitId, sow);
    window._sowCurrentSowMeta = {approval_status: sow.approval_status, system_approved: sow.system_approved, archived: sow.archived, cancelled: true};
    auditEntry('SOW:'+_sowUnitId, 'sow_cancelled', 'MR '+pn+' cancelled'+(doNotify?' — contractor notified':''), _realRoleForPermissions());

    // Revert the unit's status if this drained the last active request.
    try {
      var _allUnits = (typeof housingUnits !== 'undefined' && housingUnits.length) ? housingUnits : [];
      var _u = _allUnits.find(function(x){ return x.id === _sowUnitId; });
      if(_u && typeof hasActiveSows === 'function' && !hasActiveSows(_sowUnitId)
         && typeof revertUnitFromRepair === 'function' && revertUnitFromRepair(_u)){
        saveUnitWithDraftFallback(_u);
      }
    } catch(e){ console.warn('[SOW] cancel-revert threw:', e); }

    if(doNotify && ct && ct.email && typeof window.sendNotification === 'function'){
      var _u2 = (typeof housingUnits !== 'undefined' ? housingUnits : []).find(function(x){ return x.id === _sowUnitId; }) || {};
      var _addr = ((_u2.num||'') + ' ' + (_u2.street||'')).trim() || _sowUnitId || '';
      var _natShort = (window.NATION_CONFIG && NATION_CONFIG.short) || 'Housing';
      window.sendNotification({
        to: ct.email, to_name: ct.name || '',
        subject: 'Work Order Cancellation — ' + (_addr || pn),
        bodyHtml: '<p>Dear ' + escapeHtml(ct.name || 'Contractor') + ',</p>'
          + '<p>The work order for <strong>' + escapeHtml(_addr || pn) + '</strong> (ref ' + escapeHtml(pn) + ') has been <strong>cancelled</strong>.</p>'
          + '<p>Please do not proceed with any further work. If work was already underway, contact the Housing Department to arrange settlement for work completed to date.</p>'
          + '<p>We apologize for any inconvenience.</p>'
          + '<p>Sincerely,<br/>' + escapeHtml(_natShort) + ' Housing</p>',
        event: 'sow_cancelled', entity_type: 'sow', entity_id: pn
      }).catch(function(e){ console.warn('[SOW] cancel notify failed:', e); });
    }

    showToast('✖ Request ' + pn + ' cancelled' + (doNotify ? ' — contractor notified' : ''), {type:'info'});
    _applySowModalLock(sow);
    if(typeof renderWorklist === 'function' && document.getElementById('worklist_body')) renderWorklist();
    if(typeof udpRenderSowTable === 'function' && document.getElementById('udp_sow_table_wrap')) udpRenderSowTable(_sowUnitId);
    if(typeof renderRenoApprovalsView === 'function' && document.getElementById('renoApprovalsView')) renderRenoApprovalsView();
  })();
}
window.cancelSow = cancelSow;
























// ═══════════════════════════════════════════════════════════════════════════
// MULTI-SOW MODEL (one unit → many scopes of work)
// ═══════════════════════════════════════════════════════════════════════════
// Storage shape in housing_sow.data:
//   NEW:    { sows: [{project_number, created_at, approval_status, amount, progress, ...sowFields}, ...] }
//   LEGACY: { ...sowFields }  (a single SOW stored flat — migrated on read)
//
// Migration: _migrateLegacySow wraps legacy records as { sows: [legacy] } transparently.
// Writes always use the NEW shape.





// ── SOW helpers (getSowByProjectNumber, canEditSow, canMarkSowComplete,
//    canReopenSow, upsertSowInList, nextProjectNumber) live in shared-sow.js ──

// ── SOW table on Unit Detail card ─────────────────────────────────────────
// Renders every SOW for a given unit as a row in a table inside the Unit Detail modal.
function udpRenderSowTable(unitId){
  var wrap = document.getElementById('udp_sow_table_wrap');
  if(!wrap) return;
  var list = getUnitSowList(unitId);
  // Field Employees only see in-house work orders assigned to them.
  if(typeof sowHiddenFromCurrentFieldEmployee === 'function'){
    list = list.filter(function(s){ return !sowHiddenFromCurrentFieldEmployee(s); });
  }
  if(!list.length){
    wrap.innerHTML = '<div style="padding:18px;text-align:center;color:var(--muted);font-size:12px;font-style:italic;background:var(--bg);">No maintenance requests yet. Click <strong style="color:var(--text);">New Request</strong> to create one.</div>';
    return;
  }
  // Filter archived SOWs out by default (toggle re-includes them).
  var _archivedTotal = list.filter(function(s){ return !!s.archived; }).length;
  var _visibleList = window._udpShowArchived ? list.slice() : list.filter(function(s){ return !s.archived; });
  // Sort newest first by created_at.
  list = _visibleList.sort(function(a, b){
    return (b.created_at || '').localeCompare(a.created_at || '');
  });

  // Archive UI gating: HM/ED only. Read-only viewers don't see the button.
  var _udpRole = window.currentRole || 'staff';
  var _canArchive = (typeof ROLE !== 'undefined' && ROLE.isManagement && ROLE.isManagement(_udpRole));
  // "Show archived" toggle state lives on window so it survives re-renders
  // within the same panel session. Default: hide archived.
  if(window._udpShowArchived == null) window._udpShowArchived = false;

  // Local alias to the canonical formatCurrency so existing call sites
  // in this function keep working without renaming.
  var fmtCurrency = formatCurrency;
  function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  var rows = list.map(function(sow){
    // Shared badge helper (shared-data.js) — 'unit_table' variant keeps this
    // table's exact labels/colors, incl. the System Approved override (not for
    // completed SOWs) and the Archived pill override below.
    var ss = sowStatusBadge(sow, {variant:'unit_table'});
    var pn = esc(sow.project_number || '—');
    var date = esc(sow.created_at || sow.date || '—');
    var amount = (sow.amount == null) ? '—' : fmtCurrency(sow.amount);
    var progressPct = (sow.progress && typeof sow.progress.percent === 'number') ? sow.progress.percent : null;
    var progressCell = progressPct == null
      ? '<span style="color:var(--muted);font-size:11px;">—</span>'
      : '<div style="display:flex;align-items:center;gap:6px;min-width:80px;"><div style="flex:1;height:4px;background:var(--border);border-radius:2px;overflow:hidden;"><div style="height:100%;width:'+Math.min(100,Math.max(0,progressPct))+'%;background:'+(progressPct>=100?'var(--success)':'var(--info-blue)')+';"></div></div><span style="font-size:10px;font-weight:700;color:var(--muted);min-width:26px;text-align:right;">'+progressPct+'%</span></div>';
    // Project # cell is clickable — opens the Maintenance Request form (edit modal).
    // Build row actions based on completion state + viewer role.
    // Completed SOW + non-ED → View (opens read-only) instead of Edit.
    // Work Order stays available to everyone regardless of status.
    var locked = (isSowCompleted(sow) && !canEditSow(sow)) || (sow.cancelled && !(typeof canReopenSow === 'function' && canReopenSow()));
    var isArchived = !!sow.archived;
    // Archived SOWs always render the "Archived" pill (overrides the
    // approval-status pill) so the row's state is unmistakable when the
    // "Show archived" toggle is on — handled inside sowStatusBadge's
    // 'unit_table' variant.
    var editBtn = locked
      ? '<button onclick="udpEditSow(\''+esc(unitId)+'\',\''+pn+'\')" title="View request (read-only)" style="background:none;border:1px solid var(--border);color:var(--muted);padding:4px 9px;border-radius:5px;cursor:pointer;font-size:10px;font-weight:600;font-family:DM Sans,sans-serif;margin-right:4px;">View</button>'
      : '<button onclick="udpEditSow(\''+esc(unitId)+'\',\''+pn+'\')" title="Edit request" style="background:none;border:1px solid var(--border);color:var(--text);padding:4px 9px;border-radius:5px;cursor:pointer;font-size:10px;font-weight:600;font-family:DM Sans,sans-serif;margin-right:4px;">Edit</button>';
    // Archive / Unarchive — HM/ED only. Archive on active SOWs, Unarchive
    // (restore) on archived ones. Both feed udpArchiveSow / udpUnarchiveSow
    // which confirm + persist + may revert the unit's status.
    var archiveBtn = '';
    if(_canArchive){
      archiveBtn = isArchived
        ? '<button onclick="udpUnarchiveSow(\''+esc(unitId)+'\',\''+pn+'\')" title="Restore archived request" style="background:none;border:1px solid var(--border);color:var(--muted);padding:4px 9px;border-radius:5px;cursor:pointer;font-size:10px;font-weight:600;font-family:DM Sans,sans-serif;margin-right:4px;">Restore</button>'
        : '<button onclick="udpArchiveSow(\''+esc(unitId)+'\',\''+pn+'\')" title="Archive this request" style="background:none;border:1px solid var(--border);color:var(--muted);padding:4px 9px;border-radius:5px;cursor:pointer;font-size:10px;font-weight:600;font-family:DM Sans,sans-serif;margin-right:4px;">🗄 Archive</button>';
    }
    return '<tr style="border-top:1px solid var(--border);'+(isArchived?'opacity:.6;':'')+'">'
      +'<td style="padding:8px 10px;font-size:11px;color:var(--muted);white-space:nowrap;">'+date+'</td>'
      +'<td style="padding:8px 10px;"><span style="font-size:10px;font-weight:700;padding:3px 8px;border-radius:10px;background:'+ss.bg+';color:'+ss.c+';white-space:nowrap;">'+ss.label+(locked?' 🔒':'')+'</span></td>'
      +'<td style="padding:8px 10px;font-size:12px;font-weight:700;white-space:nowrap;">'+amount+'</td>'
      +'<td style="padding:8px 10px;font-size:11px;"><button onclick="udpEditSow(\''+esc(unitId)+'\',\''+pn+'\')" style="background:none;border:none;color:var(--text);padding:0;font-family:ui-monospace,Menlo,Monaco,\'Courier New\',monospace;font-size:11px;font-weight:600;cursor:pointer;text-decoration:underline;text-decoration-color:var(--border);text-underline-offset:2px;" title="Open the Maintenance Request">'+pn+'</button></td>'
      +'<td style="padding:8px 10px;font-size:10px;">'+progressCell+'</td>'
      +'<td style="padding:6px 8px;white-space:nowrap;text-align:right;">'
        +editBtn
        +archiveBtn
        +'<button onclick="udpPrintWorkOrder(\''+esc(unitId)+'\',\''+pn+'\')" title="Print work order" style="background:var(--yellow);border:none;color:var(--dark);padding:4px 9px;border-radius:5px;cursor:pointer;font-size:10px;font-weight:700;font-family:DM Sans,sans-serif;">Work Order</button>'
        +((typeof moduleOn !== 'function' || moduleOn('rfq')) && _sowRfqStillOpen(sow) && typeof _sowMeetsRfqThreshold === 'function' && _sowMeetsRfqThreshold(sow)
          ? '<a href="rfq.html?unit='+esc(unitId)+'&sow='+esc(pn)+'" style="margin-left:4px;background:#1d4ed8;border:none;color:#fff;padding:4px 9px;border-radius:5px;cursor:pointer;font-size:10px;font-weight:700;font-family:DM Sans,sans-serif;text-decoration:none;display:inline-block;">RFQ</a>'
          : '')
      +'</td>'
      +'</tr>';
  }).join('');

  // "Show archived" toggle — only rendered if at least one archived SOW
  // exists, to avoid clutter when there's nothing to reveal.
  var archivedToggle = '';
  if(_archivedTotal > 0){
    archivedToggle = '<div style="display:flex;justify-content:flex-end;align-items:center;gap:6px;font-size:11px;color:var(--muted);margin-bottom:6px;">'
      +'<label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;">'
      +'<input type="checkbox" '+(window._udpShowArchived?'checked':'')+' onchange="window._udpShowArchived=this.checked;udpRenderSowTable(\''+esc(unitId)+'\')" style="margin:0;cursor:pointer;accent-color:var(--yellow);"/>'
      +'Show archived ('+_archivedTotal+')'
      +'</label></div>';
  }
  wrap.innerHTML = archivedToggle
    +'<div class="overflow-x"><table style="width:100%;border-collapse:collapse;font-family:DM Sans,sans-serif;">'
    +'<thead><tr style="background:var(--bg);"><th style="padding:7px 10px;font-size:9px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:var(--muted);text-align:left;">Date</th>'
    +'<th style="padding:7px 10px;font-size:9px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:var(--muted);text-align:left;">Status</th>'
    +'<th style="padding:7px 10px;font-size:9px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:var(--muted);text-align:left;">Amount</th>'
    +'<th style="padding:7px 10px;font-size:9px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:var(--muted);text-align:left;">Project #</th>'
    +'<th style="padding:7px 10px;font-size:9px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:var(--muted);text-align:left;">Progress</th>'
    +'<th style="padding:7px 10px;"></th></tr></thead>'
    +'<tbody>'+rows+'</tbody></table></div>';
}

// ── udpArchiveSow / udpUnarchiveSow ─────────────────────────────────────
// Confirm + persist + re-render. archiveSow flips the per-SOW flag and
// (if no other active SOWs remain) reverts the unit's status. Restoring
// an archived SOW does NOT auto-flip the unit back to under_repair —
// that requires a fresh approval (matches the lifecycle direction).
window.udpArchiveSow = function(unitId, projectNumber){
  if(!unitId || !projectNumber) return;
  showConfirm({
    title:       'Archive this Request?',
    message:     'Project ' + projectNumber + ' will be hidden from the active list. This is reversible — use the "Show archived" toggle to find it again.',
    confirmText: 'Archive'
  }).then(function(ok){
    if(!ok) return;
    var role = window.currentRole || 'staff';
    if(typeof archiveSow !== 'function'){ showToast('Archive helper missing.', {type:'error'}); return; }
    var sow = archiveSow(unitId, projectNumber, role);
    if(!sow){ showToast('Request not found', {type:'error'}); return; }
    auditEntry('SOW:'+unitId, 'sow_archived', 'SOW '+projectNumber+' archived', role);
    // If archiving emptied the active-SOW set on this unit, revert the
    // unit's status back to its prior state.
    try {
      var allUnits = (typeof housingUnits !== 'undefined' && housingUnits.length) ? housingUnits : [];
      var u = allUnits.find(function(x){ return x.id === unitId; });
      if(u && typeof hasActiveSows === 'function' && !hasActiveSows(unitId)
         && typeof revertUnitFromRepair === 'function' && revertUnitFromRepair(u)){
        saveUnitWithDraftFallback(u);
        auditEntry('UNIT:'+unitId, 'unit_status_auto', (u.num+' '+u.street).trim()+' → '+(u.status||'updated')+' (last active SOW archived)', role);
      }
    } catch(e){ console.warn('[SOW archive] revert threw:', e); }
    udpRenderSowTable(unitId);
    showToast('✓ Request '+projectNumber+' archived', {type:'info'});
  });
};
window.udpUnarchiveSow = function(unitId, projectNumber){
  if(!unitId || !projectNumber) return;
  if(typeof unarchiveSow !== 'function'){ showToast('Unarchive helper missing.', {type:'error'}); return; }
  var sow = unarchiveSow(unitId, projectNumber);
  if(!sow){ showToast('Request not found', {type:'error'}); return; }
  auditEntry('SOW:'+unitId, 'sow_unarchived', 'SOW '+projectNumber+' restored', window.currentRole || 'staff');
  udpRenderSowTable(unitId);
  showToast('✓ Request '+projectNumber+' restored', {type:'info'});
};

// archiveCurrentSow — invoked by the 🗄 Archive button in the SOW modal
// header. Archives the SOW currently open in the modal (uses _sowUnitId +
// window._sowEditingProjectNumber), reverts the unit's status if no other
// active SOWs remain, closes the modal, and refreshes whichever upstream
// view rendered the row (Reno Approvals, Unit Detail Panel SOW table).
window.archiveCurrentSow = function(){
  var unitId = _sowUnitId;
  var projectNumber = window._sowEditingProjectNumber;
  if(!unitId || !projectNumber){ showToast('No request to archive.', {type:'info'}); return; }
  // Permission: anyone with the SOW modal open can archive an initiated SOW.
  // The audit-log entry below records who archived it for accountability.
  var role = window.currentRole || 'staff';
  showConfirm({
    title:       'Archive this Request?',
    message:     'Project ' + projectNumber + ' will be hidden from the active list. This is reversible — use the "Show archived" toggle on the Unit Detail Panel to restore it.',
    confirmText: 'Archive'
  }).then(function(ok){
    if(!ok) return;
    if(typeof archiveSow !== 'function'){ showToast('Archive helper missing.', {type:'error'}); return; }
    var sow = archiveSow(unitId, projectNumber, role);
    if(!sow){ showToast('Request not found', {type:'error'}); return; }
    auditEntry('SOW:'+unitId, 'sow_archived', 'SOW '+projectNumber+' archived from SOW modal', role);
    // If this was the last active SOW, revert the unit's status.
    try {
      var allUnits = (typeof housingUnits !== 'undefined' && housingUnits.length) ? housingUnits : [];
      var u = allUnits.find(function(x){ return x.id === unitId; });
      if(u && typeof hasActiveSows === 'function' && !hasActiveSows(unitId)
         && typeof revertUnitFromRepair === 'function' && revertUnitFromRepair(u)){
        saveUnitWithDraftFallback(u);
        auditEntry('UNIT:'+unitId, 'unit_status_auto', (u.num+' '+u.street).trim()+' → '+(u.status||'updated')+' (last active SOW archived)', role);
      }
    } catch(e){ console.warn('[SOW archive modal] revert threw:', e); }
    closeSowModal();
    showToast('✓ Request '+projectNumber+' archived', {type:'info'});
    // Refresh whichever upstream view is in the DOM.
    if(typeof renderRenoApprovalsView === 'function' && document.getElementById('ra_tbody')) renderRenoApprovalsView();
    if(typeof udpRenderSowTable === 'function' && document.getElementById('udp_sow_table_wrap')) udpRenderSowTable(unitId);
    if(typeof renderWorklist === 'function' && document.getElementById('worklist_body')) renderWorklist();
  });
};

function udpNewSow(){
  if(!_currentDetailUnitId) return;
  closeUnitEditModal({handoff:true});
  // Force a brand-new request — otherwise openSowModal opens the unit's most
  // recent ACTIVE SOW (and this button would never actually create a new one).
  window._sowForceNew = true;
  openSowModal(_currentDetailUnitId);
}

function udpEditSow(unitId, projectNumber){
  closeUnitEditModal({handoff:true});
  openSowModal(unitId, projectNumber);
}

function udpOpenSowDocument(unitId, projectNumber){
  // Opens the full SOW as a print-ready document (same as "Full SOW" button inside the modal).
  // Loads the SOW into the modal first so printSOW() has the right data, then triggers print.
  var sow = getSowByProjectNumber(unitId, projectNumber);
  if(!sow){ showToast('Request not found', {type:'error'}); return; }
  closeUnitEditModal({handoff:true});
  openSowModal(unitId, projectNumber);
  // Give the modal a tick to populate before printing.
  setTimeout(function(){ if(true) printSOW(); }, 250);
}

function udpPrintWorkOrder(unitId, projectNumber){
  // Prints a work order for the specific SOW. Loads the SOW into the modal briefly so
  // the existing printWorkOrder() (which reads from modal state) produces the right output.
  var sow = getSowByProjectNumber(unitId, projectNumber);
  if(!sow){ showToast('Request not found', {type:'error'}); return; }
  closeUnitEditModal({handoff:true});
  openSowModal(unitId, projectNumber);
  setTimeout(function(){ if(true) printWorkOrder(); }, 250);
}














// Submit-confirmation gate for the save button. In draft mode we just save
// — no prompt, no tenant copy. In submit mode we look up the tenant email
// and, if one is on file, show an inline "Email a copy to the tenant"
// checkbox on the confirm modal. Mirror of housing-app.js openSubmitModal /
// finalSubmit. Called only via the #sow_save_btn onclick; programmatic
// saveSOW() callers (printSOW, etc.) skip this entirely.
async function sowSaveClicked() {
  var btn = document.getElementById('sow_save_btn');
  var mode = (btn && btn.dataset) ? btn.dataset.mode : 'draft';
  // "Save Changes" on an already-created request: plain save, no confusing
  // Submit dialog. data-mode stays 'submit' so saveSOW preserves approval_status.
  // keepOpen — the form stays open and just confirms with a toast; the user is
  // still working the request and should not be redirected off the form.
  if (btn && btn.dataset && btn.dataset.existing === '1') { saveSOW({keepOpen:true}); return; }
  // "Save Draft" on a new/draft request: also stay open (still authoring).
  if (mode !== 'submit') { saveSOW({keepOpen:true}); return; }

  if (typeof showConfirm !== 'function') { saveSOW(); return; }

  // Cost + threshold decisions. RFQ vs Work Order is the RFQ threshold; the
  // approval chain (over/under) uses the ED budget limit.
  var _costEl = document.getElementById('sow_total_cost');
  var cost  = parseFloat(String((_costEl && _costEl.value) || '').replace(/[^0-9.\-]/g, '')) || 0;
  var over  = (typeof _sowMeetsRfqThreshold === 'function') && _sowMeetsRfqThreshold({ amount: cost });
  var rfqOn = (typeof moduleOn !== 'function') || moduleOn('rfq');
  var needsEd = (typeof sowRequiresEdApproval === 'function') && sowRequiresEdApproval({ amount: cost });
  // Will this submit auto-approve? (approval turned off in Settings). Only then
  // is the request immediately actionable, so we FOLD the next step into the
  // submit dialog. When approval is required, the prompt fires at approval.
  var autoApprove = (typeof APPROVAL_AUTHORITY !== 'undefined' && APPROVAL_AUTHORITY.chainDisabled)
    ? APPROVAL_AUTHORITY.chainDisabled(needsEd ? 'sow_over' : 'sow_under') : false;
  var wantRfq = over && rfqOn;

  var conf;
  if (autoApprove) {
    conf = await showConfirm({
      title:       'Submit maintenance request?',
      message:     'Submitting approves this request (approval is turned off in Settings).',
      confirmText: 'Submit',
      checkbox:    { label: wantRfq ? 'Start the RFQ process now' : 'Issue the work order now', defaultChecked: true }
    });
  } else {
    conf = await showConfirm({
      title:       'Submit Maintenance Request?',
      message:     'This submits the request for review. Once it is approved you will be prompted to ' + (wantRfq ? 'start the RFQ process.' : 'issue the work order.'),
      confirmText: 'Confirm Submit'
    });
  }
  var ok = (typeof conf === 'object' && conf !== null) ? !!conf.ok : !!conf;
  if (!ok) return;
  var doNext = autoApprove && (typeof conf === 'object' && conf !== null) ? !!conf.checked : false;

  saveSOW();

  // Folded action (approval off): the checkbox WAS the prompt, so act directly.
  if (doNext) {
    var js = window._sowJustSaved;
    if (js && js.unitId && js.projectNumber) _sowDoIssue(js.unitId, js.projectNumber, wantRfq);
  }
}

// One-dialog "next step" prompt fired when a request reaches an approved state
// (from the approval flow when approval is required). RFQ threshold decides
// whether it offers to start the RFQ process or issue the work order.
function _sowPromptIssue(unitId, projectNumber, amount) {
  if (typeof showConfirm !== 'function') return;
  var amt   = parseFloat(amount) || 0;
  var over  = (typeof _sowMeetsRfqThreshold === 'function') && _sowMeetsRfqThreshold({ amount: amt });
  var rfqOn = (typeof moduleOn !== 'function') || moduleOn('rfq');
  var wantRfq = over && rfqOn;
  showConfirm({
    title:       wantRfq ? 'Start the RFQ process?' : 'Issue the work order?',
    message:     wantRfq
      ? 'This maintenance request is at or above the RFQ threshold, so it should go out to contractors for competitive quotes. Start the RFQ process now?'
      : 'This maintenance request is approved. Do you want to issue the work order now?',
    confirmText: wantRfq ? 'Start RFQ' : 'Issue Work Order',
    cancelText:  'Not now'
  }).then(function (r) {
    var yes = (typeof r === 'object' && r !== null) ? !!r.ok : !!r;
    if (yes) _sowDoIssue(unitId, projectNumber, wantRfq);
  });
}
window._sowPromptIssue = _sowPromptIssue;

// Perform the chosen next step: start the RFQ (hand off to rfq.html) or issue
// (print) the work order for this request.
function _sowDoIssue(unitId, projectNumber, isRfq) {
  if (isRfq) {
    try {
      var _c  = window._sowCache && window._sowCache[unitId];
      var _sa = _c && Array.isArray(_c.sows) ? _c.sows : [];
      var _sh = _sa.find(function (s) { return s && s.project_number === projectNumber; }) || null;
      if (_sh) sessionStorage.setItem('_rfq_sow_handoff', JSON.stringify(_sh));
    } catch (e) {}
    window.location.href = 'rfq.html?unit=' + encodeURIComponent(unitId) + '&sow=' + encodeURIComponent(projectNumber);
  } else if (typeof udpPrintWorkOrder === 'function') {
    udpPrintWorkOrder(unitId, projectNumber);
  }
}
window._sowDoIssue = _sowDoIssue;

// Reconcile assignment: in-house work has no contractor; contractor work has
// no field-employee assignee. Prevents a stale contractor email firing on an
// in-house job, and keeps the Field Employee filter clean.
function _sowReconcileAssignment(data){
  if(data.assignedTeam === 'in_house'){ data.contractor = ''; data.contractorId = ''; }
  else if(data.assignedTeam === 'contractor'){ data.assignedTo = ''; data.assignedToName = ''; }
}

// ── Approval-chain authority gate + status derivation ─────────────────────
// Mutates `data` in place: strips approval name/date fields the actor isn't
// authorized to fill, then computes data.approval_status (preserving the
// terminal 'completed' and System Approved states), then applies the
// review-all-tabs draft gate. Extracted verbatim from saveSOW.
function _sowComputeApprovalStatus(data, existingForStatus, saveRole, saveMode){
  // The ED tier always retains SOW approval authority (see _isEdApprovalTier).
  var _edTier = (typeof _isEdApprovalTier === 'function') && _isEdApprovalTier(saveRole);
  // Strip name/date fields the actor isn't authorized to fill so the
  // auto-promotion below cannot bump status past what they're allowed.
  if(!_edTier && !APPROVAL_AUTHORITY.can('approveSowOverThreshold', saveRole)){
    data.edName = ''; data.edDate = '';
  }
  if(!_edTier && !APPROVAL_AUTHORITY.can('approveSowUnderThreshold', saveRole) &&
     !APPROVAL_AUTHORITY.can('approveSowOverThreshold', saveRole)){
    data.hmName = ''; data.hmDate = '';
  }
  // A fresh, authorized ED sign-off now present on the form (one the existing
  // record didn't already carry). This must WIN over the auto-approval /
  // preserve branches below — otherwise a request that was auto-approved earlier
  // (approval_auto) can never be manually advanced by the ED.
  var _freshEdApproval = !!(data.edName && data.edDate
    && (_edTier || APPROVAL_AUTHORITY.can('approveSowOverThreshold', saveRole))
    && !(existingForStatus && existingForStatus.edName));

  // Compute a simple approval_status from the signature / approval fields on the form.
  // EXCEPTION: if the SOW was already marked 'completed', preserve that — only markSowComplete/reopenSow
  // should transition into or out of the completed state. This keeps Save from accidentally
  // downgrading a completed SOW when an ED edits its fields.
  if(existingForStatus && existingForStatus.approval_status === 'completed'){
    data.approval_status = 'completed';
    if(existingForStatus.completed_at) data.completed_at = existingForStatus.completed_at;
    if(existingForStatus.completed_by) data.completed_by = existingForStatus.completed_by;
  } else if(existingForStatus && existingForStatus.system_approved){
    // System Approved (auto-approved by an RFQ award) is terminal like
    // 'completed'. The form carries no field for these flags, so a routine
    // edit-and-save must not shed them or let the status recompute downward
    // (the authority gate above strips edName/edDate for non-ED savers, which
    // would otherwise downgrade the SOW back into the approval queue while its
    // RFQ stays awarded).
    data.approval_status   = 'ed_approved';
    data.system_approved   = true;
    if(existingForStatus.approved_via_rfq) data.approved_via_rfq = true;
    data.edName = existingForStatus.edName || 'System';
    data.edDate = existingForStatus.edDate || '';
  } else if(existingForStatus && existingForStatus.approval_auto && !_freshEdApproval){
    // Auto-approved because a Maintenance Request approval step was switched
    // OFF in Settings. Terminal like completed/System Approved — a routine
    // re-save (the authority gate above strips name/date for non-approvers)
    // must not recompute it back down into the approval queue. EXCEPTION: a
    // fresh ED sign-off (_freshEdApproval) advances it to ed_approved instead of
    // preserving the auto status.
    data.approval_status = existingForStatus.approval_status || 'hm_approved';
    data.approval_auto   = true;
    if(existingForStatus.hmName){ data.hmName = existingForStatus.hmName; data.hmDate = existingForStatus.hmDate; }
    if(existingForStatus.edName){ data.edName = existingForStatus.edName; data.edDate = existingForStatus.edDate; }
  } else if(data.edName && data.edDate && (_edTier || APPROVAL_AUTHORITY.can('approveSowOverThreshold', saveRole))){ data.approval_status = 'ed_approved'; if(_freshEdApproval) data.approval_auto = false; }
  else if(data.hmName && data.hmDate && (_edTier || APPROVAL_AUTHORITY.can('approveSowUnderThreshold', saveRole))) data.approval_status = 'hm_approved';
  else if((data.tenantSig && data.tenantSig.image) || (data.staffSig && data.staffSig.image)) data.approval_status = 'signed';
  else data.approval_status = 'draft';

  // Review-all-tabs gate. The Save button switches between data-mode="draft"
  // (some tabs unvisited) and data-mode="submit" (all 8 tabs clicked). In
  // draft mode we override the auto-computed status back to 'draft' so the
  // SOW can't accidentally advance into the approval workflow before the
  // user has walked every section. Edits to an existing saved SOW open
  // with every tab pre-marked visited, so this gate is effectively skipped
  // for re-edits — only first-time authoring is forced through the walk.
  if (saveMode !== 'submit' && data.approval_status !== 'completed' && !data.system_approved && !data.approval_auto) {
    data.approval_status = 'draft';
  } else if (saveMode === 'submit' && data.approval_status === 'draft') {
    // The user clicked "Submit Request" (all sections reviewed) but the request
    // carries no signature or HM/ED approval yet, so the status above computed
    // to 'draft'. Promote it to 'submitted' (Awaiting HM Review) — otherwise a
    // genuinely submitted request lingers under the preparer's "My Drafts" even
    // though they submitted it and received a confirmation email.
    data.approval_status = 'submitted';
  }

  // Auto-approve on submit when this request's approval chain has a step
  // switched OFF in Settings (Approval Authority). "Any off = fully approved."
  if (saveMode === 'submit' && data.approval_status === 'submitted' && !data.approval_auto
      && typeof APPROVAL_AUTHORITY !== 'undefined' && APPROVAL_AUTHORITY.chainDisabled) {
    var _over = (typeof sowRequiresEdApproval === 'function') && sowRequiresEdApproval(data);
    if (APPROVAL_AUTHORITY.chainDisabled(_over ? 'sow_over' : 'sow_under')) {
      var _td = new Date().toISOString().slice(0,10);
      data.approval_status = _over ? 'ed_approved' : 'hm_approved';
      data.approval_auto   = true;
      if (_over) { data.edName = 'System'; data.edDate = _td; }
      else       { data.hmName = 'System'; data.hmDate = _td; }
    }
  }
}

// ── Post-persist notification block ───────────────────────────────────────
// All the workflow emails saveSOW fires after the SOW is persisted, with
// their dedupe conditions exactly as before. Extracted verbatim from saveSOW.
function _sowFireEmails(data, existingForStatus, isNew, sendTenantCopy, saveMode){
  // Notify approvers on FIRST save only — subsequent edits don't re-fire
  // so the SOW reviewers don't get spammed during iteration. Fire-and-
  // forget; UI never blocks on delivery.
  if (isNew && typeof notifySowCreated === 'function') {
    notifySowCreated(data, _sowUnitId);
  }

  // NOTE: Work Order emails (to the contractor or the in-house employee +
  // Housing Manager) and the tenant copy are NO LONGER sent automatically on
  // submit/approve. They are sent explicitly, with a confirmation dialog,
  // from the "Work Order" and "Tenant form" buttons (sowWorkOrderClicked /
  // sowTenantFormClicked). This keeps saving side-effect-free — no surprise
  // emails, no PDF-generation spin on save.
}

function saveSOW(opts){
  opts = opts || {};
  var sendTenantCopy = opts.sendTenantCopy === true;
  var get=function(id){ var el=document.getElementById(id); return el?el.value.trim():''; };
  var chk=function(id){ var el=document.getElementById(id); return el?el.checked:false; };
  var data = {
    unitId:_sowUnitId, address:get('sow_address'), date:get('sow_date'),
    tenantName:get('sow_tenant_name'),
    preparedBy:get('sow_prepared_by'), contractor:get('sow_contractor'), contractorId:(document.getElementById('sow_contractor_id')||{}).value||'',
    assignedTeam:(document.getElementById('sow_assigned_team')||{}).value||'',
    assignedTo:(document.getElementById('sow_assigned_team')||{}).value==='in_house' ? ((document.getElementById('sow_assigned_to')||{}).value||'') : '',
    assignedToName:(function(){ var s=document.getElementById('sow_assigned_to'); if(!s||((document.getElementById('sow_assigned_team')||{}).value)!=='in_house') return ''; var o=s.options[s.selectedIndex]; return (o&&o.getAttribute('data-name'))||''; })(),
    poNumber:get('sow_po_number'),
    condition:get('sow_condition'), fundSource:get('sow_fund_source'), totalCost:get('sow_total_cost'),
    startDate:get('sow_start_date'), endDate:get('sow_end_date'), notes:get('sow_notes'),
    hmName:get('sow_hm_name'), hmDate:get('sow_hm_date'),
    edName:get('sow_ed_name'), edDate:get('sow_ed_date'),
    tenantSig: {
      name:  get('sow_sig_tenant_name'),
      date:  get('sow_sig_tenant_date'),
      image: (typeof getSigDataURL === 'function') ? getSigDataURL('sow_sig_canvas_tenant') : ''
    },
    staffSig: {
      name:  get('sow_sig_staff_name'),
      date:  get('sow_sig_staff_date'),
      image: (typeof getSigDataURL === 'function') ? getSigDataURL('sow_sig_canvas_staff') : ''
    },
    mold:chk('sow_mold'), asbestos:chk('sow_asbestos'), electrical:chk('sow_electrical'),
    structural:chk('sow_structural'), plumbing:chk('sow_plumbing'), fire:chk('sow_fire'),
    rentArrears:chk('sow_rent_arrears'), tenantDamage:chk('sow_tenant_damage'),
    negligence:chk('sow_negligence'), vandalism:chk('sow_vandalism'),
    policeReport:chk('sow_police_report'), accountabilityNotes:get('sow_accountability_notes'),
    items:collectSowItems(),
    files: (window._sowFiles || []).slice(),
    workOrder: (typeof _sowCollectWorkOrder === 'function') ? _sowCollectWorkOrder() : null,
    savedAt:new Date().toISOString()
  };
  // Reconcile assignment (in-house vs contractor — see _sowReconcileAssignment).
  _sowReconcileAssignment(data);
  // ── Multi-SOW fields ───────────────────────────────────────────────────
  // Stamp the project number (either the one being edited or a fresh one for new SOWs).
  data.project_number = window._sowEditingProjectNumber || (_sowUnitId ? nextProjectNumber(_sowUnitId) : 'NO-UNIT-SOW-001');
  // Lock the modal onto this project number so a subsequent Save, or the
  // Work Order / Tenant form document buttons, target THIS saved request
  // (not a fresh one) — matters for brand-new requests whose number was
  // just generated on this first save.
  window._sowEditingProjectNumber = data.project_number;
  // Preserve created_at if editing an existing SOW; otherwise stamp today.
  if(_sowUnitId){
    var existing = getSowByProjectNumber(_sowUnitId, data.project_number);
    data.created_at = (existing && existing.created_at) || data.date || new Date().toISOString().slice(0,10);
    // Preserve progress block so editing SOW doesn't wipe progress.
    if(existing && existing.progress) data.progress = existing.progress;
    // Preserve a cancelled state across edits — only cancelSow / reopenSow flip
    // it. Without this, saving a cancelled request (ED, who can edit it) would
    // silently un-cancel it since `data` is rebuilt from the form.
    if(existing && existing.cancelled){ data.cancelled = existing.cancelled; data.cancelled_at = existing.cancelled_at; data.cancelled_by = existing.cancelled_by; }
    // Preserve the archived state the same way — only archiveSow/unarchiveSow
    // flip it. `data` is rebuilt from the form, so without this any re-save
    // (including a print-triggered one) silently un-archived the request.
    if(existing && existing.archived){
      data.archived = existing.archived;
      if(existing.archivedAt) data.archivedAt = existing.archivedAt;
      if(existing.archivedBy) data.archivedBy = existing.archivedBy;
    }
  } else {
    data.created_at = data.date || new Date().toISOString().slice(0,10);
  }
  // Normalize the amount to a number for table display / sorting.
  var totalNum = parseFloat(String(data.totalCost||'').replace(/[^0-9.\-]/g,'')) || 0;
  data.amount = totalNum;

  // PO draw-down / payments — copy the working state onto the record and
  // compute paid-vs-PO into data.paymentProgress (a field distinct from
  // data.progress, which is renovation work-progress). Preserves any po/draws
  // saved earlier when the payments tab was never opened this session (state
  // was seeded from `saved` at open).
  if (typeof _sowCollectPayments === 'function') _sowCollectPayments(data);
  if (typeof _sowCollectContract === 'function') _sowCollectContract(data);

  // ── Approval-chain authority gate + status derivation ────────────────────
  // Extracted to _sowComputeApprovalStatus (mutates data in place): authority
  // gate, completed / System Approved preservation, review-all-tabs draft gate.
  // Use the REAL authenticated role (not the effective/view-as role) so the
  // authority check matches the approve button (line ~996) and sowApproveInline,
  // which both key off _realRole. Otherwise an ED with "view as HM" active would
  // set the ED signature via sowApproveInline but have it stripped here (HM can't
  // approve over threshold) -> the approval silently vanishes and the SOW never
  // clears from the worklist. View-as is a preview; approving acts as the real ED.
  var _saveRole = window._realRole || window.currentRole || 'staff';
  var existingForStatus = _sowUnitId && data.project_number ? getSowByProjectNumber(_sowUnitId, data.project_number) : null;
  var _saveBtn = document.getElementById('sow_save_btn');
  var _saveMode = _saveBtn && _saveBtn.dataset ? _saveBtn.dataset.mode : null;
  _sowComputeApprovalStatus(data, existingForStatus, _saveRole, _saveMode);

  if(_sowUnitId) upsertSowInList(_sowUnitId, data);

  // ── Unit status auto-flip ────────────────────────────────────────────────
  // When this save took the SOW into its first HM/ED-approved state, flip
  // the unit to 'under_repair' so it surfaces in the Renovations view. When
  // it took the SOW to 'completed' AND no other SOWs on the unit are still
  // active, revert the unit to its prior status. See maybeAutoFlipUnitForSow
  // in shared-sow.js for the transition rules.
  if(_sowUnitId){
    try {
      var _allUnits = (typeof housingUnits !== 'undefined' && housingUnits.length) ? housingUnits : [];
      var _u = _allUnits.find(function(x){ return x.id === _sowUnitId; });
      var _prev = existingForStatus ? existingForStatus.approval_status : null;
      if(_u && typeof maybeAutoFlipUnitForSow === 'function' && maybeAutoFlipUnitForSow(_u, data, _prev)){
        saveUnitWithDraftFallback(_u);
        var _newStatus = _u.under_renovation ? 'Under Renovations' : (_u.status || 'updated');
        auditEntry('UNIT:'+_sowUnitId, 'unit_status_auto', (_u.num+' '+_u.street).trim()+' → '+_newStatus+' (SOW '+(data.project_number||'')+' '+(data.approval_status==='completed'?'completed':'approved')+')', _saveRole);
      }
    } catch(e){ console.warn('[SOW] auto-flip threw:', e); }
  }

  // ── Audit trail ──────────────────────────────────────────────────────────
  var role = window.currentRole || 'staff';
  var addr = data.address || _sowUnitId || 'unit';
  var isNew = !window._sowWasPreviouslySaved;
  window._sowWasPreviouslySaved = true;

  // Core save event
  var detail = (isNew ? 'SOW created' : 'SOW updated') + ' — ' + addr;
  if(data.totalCost) detail += ' · Total: ' + data.totalCost;
  if(data.condition) detail += ' · Condition: ' + data.condition;
  auditEntry('SOW:'+(_sowUnitId||'?'), isNew ? 'sow_created' : 'sow_updated', detail, role);

  // Policy 8.4(i) — renovation-support window (Settings > Policy Rules).
  // A NEW request on a unit with completed renovations inside the window
  // gets a persistent warning toast; never blocks (health & safety work is
  // exempt by policy and can't be auto-detected reliably).
  if (isNew && typeof policyRule === 'function' && policyRule('renovation_years').enabled) {
    try {
      var _rvYears = policyParam('renovation_years', 'years', 5);
      var _rvCut = new Date(); _rvCut.setFullYear(_rvCut.getFullYear() - _rvYears);
      var _rvPrior = ((typeof getUnitSowList === 'function') ? getUnitSowList(_sowUnitId) : []).find(function(sw){
        if(!sw || sw.project_number === data.project_number) return false;
        if(sw.approval_status !== 'completed') return false;
        var when = sw.completedAt || sw.completed_at || sw.edDate || sw.hmDate || '';
        return when && new Date(String(when).slice(0,10) + 'T12:00:00') >= _rvCut;
      });
      if(_rvPrior){
        showToast('⚠' + ((typeof policyCite==='function' && policyCite('renovation_years')) ? ' ' + policyCite('renovation_years') + ':' : '') + ' this unit had renovations completed within the last ' + _rvYears + ' years ('
          + (_rvPrior.project_number || 'prior request') + '). Additional support requires a health & safety justification.', {type:'error'});
      }
    } catch(e){}
  }

  // Workflow emails (sow_created / tenant copy / contractor work order /
  // in-house field-employee work order) — extracted to _sowFireEmails with
  // the dedupe conditions unchanged.
  _sowFireEmails(data, existingForStatus, isNew, sendTenantCopy, _saveMode);

  // Tenant/staff signature captured — transitions only (same rule as the
  // approval rows below: populateSow restores signatures on open, so an
  // unconditional log re-recorded them on every subsequent save).
  var _hadTenantSig = !!(existingForStatus && existingForStatus.tenantSig && (existingForStatus.tenantSig.name || existingForStatus.tenantSig.image));
  var _hadStaffSig  = !!(existingForStatus && existingForStatus.staffSig  && (existingForStatus.staffSig.name  || existingForStatus.staffSig.image));
  if(data.tenantSig && (data.tenantSig.name || data.tenantSig.image) && !_hadTenantSig) {
    auditEntry('SOW:'+(_sowUnitId||'?'), 'sow_tenant_signed',
      'Tenant signature recorded — ' + (data.tenantSig.name || 'name not provided') +
      (data.tenantSig.date ? ' on ' + data.tenantSig.date : ''), role);
  }
  if(data.staffSig && (data.staffSig.name || data.staffSig.image) && !_hadStaffSig) {
    auditEntry('SOW:'+(_sowUnitId||'?'), 'sow_staff_signed',
      'Staff signature recorded — ' + (data.staffSig.name || 'name not provided') +
      (data.staffSig.date ? ' on ' + data.staffSig.date : ''), role);
  }
  // HM/ED approval recorded — TRANSITIONS only. populateSow restores the
  // approval names into the (hidden) fields on every open, so logging whenever
  // the field is non-empty re-wrote "approval recorded" rows on every edit and
  // print of an already-approved request, attributed to whoever saved —
  // polluting the append-only audit trail with phantom approvals.
  if(data.hmName && !(existingForStatus && existingForStatus.hmName)) {
    auditEntry('SOW:'+(_sowUnitId||'?'), 'sow_hm_approval',
      'HM approval recorded — ' + data.hmName + (data.hmDate ? ' on ' + data.hmDate : ''), role);
  }
  if(data.edName && !(existingForStatus && existingForStatus.edName)) {
    auditEntry('SOW:'+(_sowUnitId||'?'), 'sow_ed_approval',
      'ED approval recorded — ' + data.edName + (data.edDate ? ' on ' + data.edDate : ''), role);
  }
  // Accountability flags
  var flags = [];
  if(data.rentArrears)  flags.push('rent arrears');
  if(data.tenantDamage) flags.push('tenant damage');
  if(data.negligence)   flags.push('negligence');
  if(data.vandalism)    flags.push('vandalism');
  if(data.policeReport) flags.push('police report');
  if(flags.length) {
    auditEntry('SOW:'+(_sowUnitId||'?'), 'sow_accountability',
      'Accountability flags set: ' + flags.join(', '), role);
  }
  // Refresh the inline audit panel if visible
  if(true) renderSowAuditLog(_sowUnitId);

  var ind=document.getElementById('sow_saved_indicator');
  if(ind) ind.textContent='✓ Saved '+new Date().toLocaleTimeString();

  // keepOpen (a plain "Save Changes" / "Save Draft"): leave the form open and
  // just confirm with a toast — the user is still working the request, not
  // moving it forward. Submit and inline-approval saves still close + navigate.
  var _keepOpen = opts.keepOpen === true;

  if(!_keepOpen){
    // Close the SOW modal, then show a centered branded confirmation.
    // Dismissing the confirmation routes the user to the Renovation Approvals
    if(typeof closeSowModal === 'function') closeSowModal();
  }

  var _msg = _keepOpen ? (isNew ? '✓ Draft saved' : '✓ Changes saved') : (isNew ? '✓ Maintenance request submitted' : '✓ Request saved');
  if(typeof showToast === 'function') showToast(_msg, {type:'info'});

  if(_keepOpen){
    // Keep the open modal in sync with what was just persisted: status tile,
    // lock state, info strip, and the Save button label all read from the
    // saved record's approval_status.
    window._sowCurrentSowMeta = {approval_status: data.approval_status, system_approved: data.system_approved, archived: data.archived};
    if(typeof _applySowModalLock === 'function') _applySowModalLock(data);
    if(typeof _sowRefreshStrip === 'function') _sowRefreshStrip();
    if(typeof _updateSowSaveButtonState === 'function') _updateSowSaveButtonState();
  }

  // Return to whichever page opened the SOW modal (background refresh even when
  // the modal stays open, so the underlying list reflects the save):
  //   • Landing page (housing.html) → refresh worklist in-place
  //   • Renos approvals page        → refresh the approvals table in-place
  //   • Any other page              → just the toast; no navigation
  if (document.getElementById('worklist_body') && typeof renderWorklist === 'function') {
    renderWorklist();
  } else if (!_keepOpen && typeof showRenoApprovals === 'function' && document.getElementById('renoApprovalsView')) {
    showRenoApprovals();
  } else if (_keepOpen && typeof renderRenoApprovalsView === 'function' && document.getElementById('renoApprovalsView')) {
    // Refresh the approvals table in place without switching the active view.
    renderRenoApprovalsView();
  }
  // Inventory unit detail panel: refresh its in-place SOW table. The panel may be
  // hidden but is still in the DOM, so the new/edited request shows up without
  // the user having to close and re-open the unit.
  if (typeof udpRenderSowTable === 'function' && _sowUnitId && document.getElementById('udp_sow_table_wrap')) {
    udpRenderSowTable(_sowUnitId);
  }

  // Stash a summary so sowSaveClicked can fire the post-create "issue work
  // order / start RFQ" prompt after this save (the modal is now closed).
  window._sowJustSaved = { unitId: _sowUnitId, projectNumber: data.project_number, amount: (parseFloat(data.amount) || 0) };
}








function printSOW(){
  // Persist form edits only when safe — printing an approved/archived request
  // must not re-save it (see _sowSafePreprintSave).
  _sowSafePreprintSave();
  var get = function(id){ var el=document.getElementById(id); return el ? el.value.trim() : ''; };
  var chk = function(id){ var el=document.getElementById(id); return el && el.checked; };
  var items   = collectSowItems();
  var hazards = [
    {id:'sow_mold',       label:'Mould / Mildew'},
    {id:'sow_asbestos',   label:'Asbestos Risk'},
    {id:'sow_electrical', label:'Electrical Hazard'},
    {id:'sow_structural', label:'Structural Concern'},
    {id:'sow_plumbing',   label:'Plumbing / Sewage'},
    {id:'sow_fire',       label:'Fire Safety'}
  ].filter(function(h){ return chk(h.id); }).map(function(h){ return h.label; });

  var totalCost = get('sow_total_cost');
  var today = new Date().toLocaleDateString('en-CA');

  // Tenant / staff signature data
  var tenantName     = get('sow_sig_tenant_name') || get('sow_tenant_name') || '—';
  var tenantDate     = get('sow_sig_tenant_date') || '—';
  var tenantSigImg   = (typeof getSigDataURL === 'function') ? getSigDataURL('sow_sig_canvas_tenant') : '';
  var staffName      = get('sow_sig_staff_name') || get('sow_prepared_by') || '—';
  var staffDate      = get('sow_sig_staff_date') || today;
  var staffSigImg    = (typeof getSigDataURL === 'function') ? getSigDataURL('sow_sig_canvas_staff') : '';

  // Accountability flags
  var acctFlags = [];
  if(chk('sow_rent_arrears'))   acctFlags.push('Rent arrears');
  if(chk('sow_tenant_damage'))  acctFlags.push('Tenant damage');
  if(chk('sow_negligence'))     acctFlags.push('Negligence');
  if(chk('sow_vandalism'))      acctFlags.push('Vandalism');
  if(chk('sow_police_report'))  acctFlags.push('Police report on file');
  var acctNotes = get('sow_accountability_notes');

  // Helper: render a signature block (with or without image)
  

  // Helper: approval sig block (no canvas — printed blanks or filled names)
  function approvalBlock(role, name, date) {
    return '<div class="print-sec">'
      +'<div style="font-size:8.5px;font-weight:bold;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:4px;">'+role+'</div>'
      +'<div style="font-size:11px;font-weight:bold;color:var(--text);margin-bottom:6px;">'+(name||'_____________________________')+'</div>'
      +'<div style="height:40px;border-bottom:1px solid var(--muted);margin-bottom:4px;"></div>'
      +'<div style="font-size:9px;color:var(--muted);">Date: '+(date||'_____________')+'</div>'
      +'</div>';
  }

  var itemRows = items.filter(function(it){ return it.category||it.description||it.cost; }).map(function(it, i){
    var cost = it.cost ? formatCurrency(parseFloat(it.cost)||0) : '—';
    return '<tr style="'+(i%2===1?'background:var(--bg);':'')+'">'
      +'<td style="padding:7px 10px;border-bottom:1px solid var(--border);font-size:10px;color:var(--text);">'+( it.category||'—')+'</td>'
      +'<td style="padding:7px 10px;border-bottom:1px solid var(--border);font-size:10px;color:var(--text);">'+(it.description||'—')+'</td>'
      +'<td style="padding:7px 10px;border-bottom:1px solid var(--border);font-size:10px;text-align:right;font-weight:600;color:var(--text);">'+cost+'</td>'
      +'</tr>';
  }).join('');

  var _natDisp  = (window.NATION_CONFIG && (NATION_CONFIG.display_name || NATION_CONFIG.name)) || '';
  var _natShort = (window.NATION_CONFIG && NATION_CONFIG.short) || '';
  var html = '<!DOCTYPE html><html lang="en"><head>'
    +'<meta charset="UTF-8"/>'
    +'<title>Maintenance Request — '+_natShort+' Housing</title>'
    +'<style>'
    +'*{box-sizing:border-box;margin:0;padding:0;}'
    +'body{font-family:Georgia,serif;font-size:11px;color:var(--text);background:#fff;}'
    +'@page{size:letter portrait;margin:15mm 15mm 18mm 15mm;}'
    +'@media print{'
      +'body{-webkit-print-color-adjust:exact;print-color-adjust:exact;}'
      +'.no-print{display:none!important;}'
      +'.page-break{page-break-before:always;}'
    +'}'
    +'.header{background:#000;color:#fff;padding:14px 20px;display:flex;align-items:center;justify-content:space-between;margin-bottom:0;}'
    +'.header-left{display:flex;align-items:center;gap:14px;}'
    +'.header-logo{height:48px;width:auto;background:#000;}'
    +'.header-title{font-family:Georgia,serif;}'
    +'.header-title .org{font-size:13px;font-weight:bold;color:var(--yellow);letter-spacing:.04em;}'
    +'.header-title .dept{font-size:10px;color:#ccc;margin-top:2px;}'
    +'.header-right{text-align:right;}'
    +'.header-right .doc-type{font-size:16px;font-weight:bold;color:var(--yellow);letter-spacing:.05em;}'
    +'.header-right .doc-date{font-size:9px;color:#aaa;margin-top:3px;}'
    +'.yellow-bar{background:var(--yellow);height:4px;}'
    +'.body{padding:20px 0 0;}'
    +'.section{margin-bottom:20px;}'
    +'.section-title{font-size:9px;font-weight:bold;text-transform:uppercase;letter-spacing:.08em;color:#fff;background:#000;padding:5px 10px;margin-bottom:0;}'
    +'.section-body{border:1px solid var(--border);border-top:none;padding:12px 14px;}'
    +'.grid-2{display:grid;grid-template-columns:1fr 1fr;gap:10px 24px;}'
    +'.grid-4{display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:10px 16px;}'
    +'.field label{display:block;font-size:8.5px;font-weight:bold;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:3px;}'
    +'.field span{display:block;font-size:11px;color:var(--text);min-height:14px;border-bottom:1px solid #e0e0e0;padding-bottom:3px;}'
    +'table{width:100%;border-collapse:collapse;font-size:10px;}'
    +'th{background:#000;color:var(--yellow);padding:7px 10px;text-align:left;font-size:9px;font-weight:bold;text-transform:uppercase;letter-spacing:.05em;}'
    +'th.right{text-align:right;}'
    +'.total-row td{background:var(--yellow);color:#000;font-weight:bold;padding:8px 10px;font-size:11px;}'
    +'.hazard-badge{display:inline-block;background:#fff0f0;color:#b91c1c;border:1px solid #fca5a5;padding:3px 9px;border-radius:3px;font-size:9px;font-weight:bold;margin:2px;}'
    +'.sig-block{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:4px;}'
    +'.sig-line{margin-top:32px;border-top:1px solid #333;padding-top:5px;font-size:9px;color:var(--muted);}'
    +'.sig-name{font-size:11px;font-weight:bold;color:var(--text);margin-bottom:2px;}'
    +'.footer{margin-top:24px;border-top:3px solid var(--yellow);padding-top:8px;display:flex;justify-content:space-between;align-items:center;}'
    +'.footer-left{font-size:8.5px;color:var(--muted);}'
    +'.footer-right{font-size:8.5px;color:var(--muted);}'
    +'</style>'
    +'</head><body>'

    /* HEADER */
    +'<div class="header">'
      +'<div class="header-left">'
        +'<img class="header-logo" src="LOGO_SRC" alt="'+_natShort+'"/>'
        +'<div class="header-title">'
          +'<div class="org">'+_natDisp+'</div>'
          +'<div class="dept">Housing Department</div>'
        +'</div>'
      +'</div>'
      +'<div class="header-right">'
        +'<div class="doc-type">MAINTENANCE REQUEST</div>'
        +'<div class="doc-date">Generated: '+today+'</div>'
      +'</div>'
    +'</div>'
    +'<div class="yellow-bar"></div>'

    /* BODY */
    +'<div class="body">'

    /* Unit Info */
    +'<div class="section">'
      +'<div class="section-title">Unit Information</div>'
      +'<div class="section-body">'
        +'<div class="grid-4">'
          +'<div class="field"><label>Unit Address</label><span>'+get('sow_address')+'</span></div>'
          +'<div class="field"><label>Current Tenant</label><span>'+(get('sow_tenant_name')||'—')+'</span></div>'
          +'<div class="field"><label>Date Prepared</label><span>'+get('sow_date')+'</span></div>'
          +'<div class="field"><label>Prepared By</label><span>'+get('sow_prepared_by')+'</span></div>'
          +'<div class="field"><label>Contractor</label><span>'+(get('sow_contractor')||'—')+'</span></div>'
          +'<div class="field"></div>'
        +'</div>'
      +'</div>'
    +'</div>'

    /* Condition & Schedule */
    +'<div class="section">'
      +'<div class="section-title">Condition Assessment &amp; Schedule</div>'
      +'<div class="section-body">'
        +'<div class="grid-4">'
          +'<div class="field"><label>Overall Condition</label><span>'+get('sow_condition')+'</span></div>'
          +'<div class="field"><label>Estimated Total Cost</label><span>'+totalCost+'</span></div>'
          +'<div class="field"><label>Target Start Date</label><span>'+get('sow_start_date')+'</span></div>'
          +'<div class="field"><label>Target Completion</label><span>'+get('sow_end_date')+'</span></div>'
        +'</div>'
      +'</div>'
    +'</div>'

    /* Scope Items */
    +'<div class="section">'
      +'<div class="section-title">Work Items</div>'
      +'<table>'
        +'<thead><tr>'
          +'<th style="width:22%">Category</th>'
          +'<th>Description of Work</th>'
          +'<th class="right" style="width:14%">Est. Cost</th>'
        +'</tr></thead>'
        +'<tbody>'+itemRows+'</tbody>'
        +'<tfoot>'
          +'<tr class="total-row">'
            +'<td colspan="2" style="text-align:right;padding-right:16px;">TOTAL ESTIMATED COST</td>'
            +'<td style="text-align:right;">'+totalCost+'</td>'
          +'</tr>'
        +'</tfoot>'
      +'</table>'
    +'</div>'

    /* Health & Safety */
    +(hazards.length
      ? '<div class="section">'
          +'<div class="section-title">Health &amp; Safety Concerns</div>'
          +'<div class="section-body">'
            +hazards.map(function(h){ return '<span class="hazard-badge">⚠ '+h+'</span>'; }).join('')
          +'</div>'
        +'</div>'
      : '')

    /* Notes */
    +(get('sow_notes')
      ? '<div class="section">'
          +'<div class="section-title">Additional Notes</div>'
          +'<div class="section-body" style="font-size:11px;line-height:1.6;color:var(--text);">'+get('sow_notes')+'</div>'
        +'</div>'
      : '')

    /* Accountability */
    +((acctFlags.length || acctNotes)
      ? '<div class="section">'
          +'<div class="section-title">Tenant Accountability</div>'
          +'<div class="section-body">'
            +(acctFlags.length ? '<div style="margin-bottom:8px;">'+acctFlags.map(function(f){ return '<span class="hazard-badge">'+f+'</span>'; }).join(' ')+'</div>' : '')
            +(acctNotes ? '<div style="font-size:10px;color:var(--text);line-height:1.5;">'+acctNotes+'</div>' : '')
          +'</div>'
        +'</div>'
      : '')

    /* Terms & Conditions — rendered from Settings → Terms & Conditions (ED-editable) */
    +(function(){
      var _tp = (typeof _termsParseHtml === 'function' && typeof getTermsBody === 'function')
              ? _termsParseHtml(getTermsBody('sow_reno_request'))
              : { introHtml: '', itemsHtml: [] };
      var introHtml = _tp.introHtml
        ? '<p style="margin:0 0 8px;">' + _tp.introHtml + '</p>'
        : '';
      var liHtml = _tp.itemsHtml.length
        ? _tp.itemsHtml.map(function(h){ return '<li>' + h + '</li>'; }).join('')
        : ('<li><strong>Prioritization of Requests.</strong> Renovation requests are assessed and prioritized based on urgency of need, health and safety risk to occupants, and overall unit condition.</li>'
          +'<li><strong>Funding Eligibility.</strong> Approval is subject to available funding and the qualifying criteria of the unit under its applicable program.</li>'
          +'<li><strong>Budget Authority.</strong> Requests within the HM\'s budget authority may be approved by the HM. Requests exceeding that threshold require Executive Director approval before work commences.</li>'
          +'<li><strong>Tenant Responsibilities.</strong> The tenant must provide timely access to the unit for inspection and work.</li>'
          +'<li><strong>No Guarantee of Approval or Timeline.</strong> Submission does not guarantee approval or a specific completion date.</li>'
          +'<li><strong>Accuracy of Information.</strong> All information must be accurate and complete.</li>');
      return '<div class="section">'
           + '<div class="section-title">Terms &amp; Conditions</div>'
           + '<div class="section-body" style="font-size:9.5px;color:var(--text);line-height:1.65;">'
           + '<p style="font-size:8.5px;font-weight:bold;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:10px;">' + _natDisp + ' &mdash; Housing Department</p>'
           + introHtml
           + '<ol style="margin:0;padding-left:16px;">' + liHtml + '</ol>'
           + '</div>'
           + '</div>';
    })()
    /* Acknowledgement & Signatures */
    +'<div class="section">'
      +'<div class="section-title">Signatures &amp; Acknowledgement</div>'
      +'<div class="section-body">'
        /* Declaration text */
        +'<div style="font-size:9.5px;color:var(--text);line-height:1.6;margin-bottom:14px;padding:10px 12px;background:var(--bg);border-left:3px solid var(--yellow);">'
          +'By signing below, the tenant acknowledges the maintenance request described in this document and grants access to the unit for the purpose of completing the renovation. '
          +'The Housing Staff member confirms this Maintenance Request is accurate and complete.'
        +'</div>'
        /* Tenant + Staff */
        +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-bottom:20px;">'
          +sigBlock('Tenant Signature', tenantName, tenantDate, tenantSigImg)
          +sigBlock('Housing Staff Signature', staffName, staffDate, staffSigImg)
        +'</div>'
      +'</div>'
    +'</div>'

    /* Approvals */
    +'<div class="section">'
      +'<div class="section-title">Management Approvals</div>'
      +'<div class="section-body">'
        +'<div style="font-size:9px;color:var(--muted);margin-bottom:12px;">Budget authority: HM may approve up to the configured limit. Work exceeding this limit requires Executive Director approval.</div>'
        +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;">'
          +approvalBlock('Housing Manager Approval', get('sow_hm_name'), get('sow_hm_date'))
          +approvalBlock('Executive Director Approval', get('sow_ed_name'), get('sow_ed_date'))
        +'</div>'
      +'</div>'
    +'</div>'

    +'</div>'/* /body */

    /* FOOTER */
    +'<div class="footer">'
      +'<div class="footer-left">'+escapeHtml(buildNationFooterStrip())+'</div>'
      +'<div class="footer-right">Generated '+today+'</div>'
    +'</div>'

    +'</body></html>';

  /* Inject logo */
  html = html.replace('LOGO_SRC', 'data:image/png;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCAbXB9ADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AIyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB//9k=');

  showPrintPanel(html, 'Maintenance Request');
  // Offer to email a copy of the request to the tenant.
  if (typeof _sowPromptTenantEmail === 'function') _sowPromptTenantEmail();
}

/* =====================================================================
 * PO draw-down / Payments (Maintenance Request)
 * ---------------------------------------------------------------------
 * A Maintenance Request with a Purchase Order can be paid down in steps:
 * a Material deposit, one or more construction Phases, and a Holdback
 * (with a release date). Each payment carries its own invoice (PDF/photo)
 * and a paid flag. The panel shows a paid-vs-outstanding progress bar; at
 * 100% paid the "Mark Job Complete" action appears (calls markSowComplete).
 *
 * State lives on window._sowPayState = { po:{number,amount,source,...},
 * draws:[{id,type,phaseNo,label,amount,paid,paidDate,releaseDate,invoice}] }
 * seeded once per open from the saved record (or an awarded RFQ / MR total).
 * On save, _sowCollectPayments copies it onto the record and stamps
 * data.paymentProgress = {percent,paid,po} — a field DISTINCT from
 * data.progress (renovation work-progress, owned by saveRenoProgress in
 * renos.html). The reno approvals "Payments" column reads paymentProgress
 * via the shared sowPaymentInfo(sow) helper (shared-sow.js).
 * ===================================================================== */

function _sowPayUid(){ return 'dr_' + Math.random().toString(36).slice(2,9) + Date.now().toString(36); }

function _sowPayMoney(n){
  n = Number(n) || 0;
  return (typeof formatCurrency === 'function') ? formatCurrency(n) : ('$' + n.toLocaleString('en-CA', {minimumFractionDigits:2}));
}
function _sowPayNum(v){ return parseFloat(String(v==null?'':v).replace(/[^0-9.\-]/g,'')) || 0; }

// Find an AWARDED RFQ linked to this SOW (unit + project number) so the PO can
// prefill from its awarded contract value + contract number.
function _sowResolveAwardedRfq(unitId, pn){
  if(!unitId || !pn) return null;
  var cache = window._rfqCache || {};
  var found = null;
  Object.keys(cache).forEach(function(k){
    var r = cache[k];
    if(r && r.sow_unit_id === unitId && r.sow_project_number === pn && r.status === 'awarded') found = r;
  });
  return found;
}

// Seed the working payments state once per modal open.
function _sowInitPayState(saved){
  var st = { po:null, draws:[] };
  if(saved){
    if(saved.po && typeof saved.po === 'object') st.po = JSON.parse(JSON.stringify(saved.po));
    if(Array.isArray(saved.draws)) st.draws = JSON.parse(JSON.stringify(saved.draws));
  }
  if(!st.po){
    var poNumEl = document.getElementById('sow_po_number');
    var poNum   = (poNumEl && poNumEl.value) ? poNumEl.value.trim() : '';
    var rfq     = _sowResolveAwardedRfq(_sowUnitId, window._sowEditingProjectNumber);
    var mrTotal = _sowPayNum((document.getElementById('sow_total_cost')||{}).value);
    if(rfq){
      var conNum = (rfq.data && rfq.data.contract_number) || '';
      st.po = {
        number: poNum || conNum || '',
        amount: Number(rfq.award_amount) || mrTotal || 0,
        source: 'rfq',
        rfqId: rfq.id || '',
        contractorId: rfq.awarded_contractor_id || ''
      };
    } else {
      st.po = { number: poNum, amount: mrTotal || 0, source: 'manual' };
    }
  }
  window._sowPayState = st;
}

// Editing gate: management only (PO draw-downs are an accounting concern), and
// never on a completed request the viewer can't reopen.
function _sowPayEditable(){
  var meta = window._sowCurrentSowMeta || {};
  if(meta.approval_status === 'completed'){
    if(typeof canReopenSow === 'function' && !canReopenSow()) return false;
  }
  var role = window._realRole || window.currentRole || 'staff';
  if(typeof ROLE !== 'undefined' && ROLE.isManagement) return !!ROLE.isManagement(role);
  return true;
}

// Sum of paid draws.
function _sowPayPaidTotal(){
  var st = window._sowPayState || {po:null,draws:[]};
  return (st.draws||[]).reduce(function(s,d){ return s + (d.paid ? (_sowPayNum(d.amount)) : 0); }, 0);
}
function _sowPayScheduledTotal(){
  var st = window._sowPayState || {po:null,draws:[]};
  return (st.draws||[]).reduce(function(s,d){ return s + _sowPayNum(d.amount); }, 0);
}
function _sowPayPercent(){
  var st = window._sowPayState || {po:null,draws:[]};
  var po = (st.po && _sowPayNum(st.po.amount)) || 0;
  if(po <= 0) return 0;
  return Math.round(_sowPayPaidTotal() / po * 100);
}

// Default multi-step schedule: 20% material, remainder = Phase 1, 10% holdback.
function _sowPayStandardSchedule(){
  var st = window._sowPayState;
  var total = (st.po && _sowPayNum(st.po.amount)) || 0;
  var holdback = Math.round(total * 0.10);
  var material = Math.round(total * 0.20);
  var phase1   = Math.max(0, total - holdback - material);
  return [
    { id:_sowPayUid(), type:'material', label:'Material Deposit', amount:material, paid:false, paidDate:'', invoice:null },
    { id:_sowPayUid(), type:'phase', phaseNo:1, label:'Phase 1', amount:phase1, paid:false, paidDate:'', invoice:null },
    { id:_sowPayUid(), type:'holdback', label:'Holdback', amount:holdback, paid:false, paidDate:'', releaseDate:'', invoice:null }
  ];
}

// ── Render ────────────────────────────────────────────────────────────────
function _sowRenderPayments(){
  var mount = document.getElementById('sow_payments_body');
  if(!mount) return;
  if(!window._sowPayState) _sowInitPayState(null);
  var st = window._sowPayState;
  var editable = _sowPayEditable();
  var isSaved  = !!(window._sowWasPreviouslySaved && _sowUnitId && window._sowEditingProjectNumber);
  var esc = function(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); };
  var dis = editable ? '' : ' disabled';

  var poAmt = (st.po && _sowPayNum(st.po.amount)) || 0;
  var srcBadge = (st.po && st.po.source === 'rfq')
    ? '<span style="margin-left:8px;padding:2px 9px;border-radius:10px;font-size:10px;font-weight:700;background:var(--info-blue-bg);color:var(--info-blue);vertical-align:middle;">From awarded RFQ</span>'
    : '';

  var html = '';

  // ── PO summary ────────────────────────────────────────────────────────
  html += '<div class="tic-section">';
  html +=   '<div class="tic-section-h">Purchase Order' + srcBadge + '</div>';
  html +=   '<div class="grid-c2-10">';
  html +=     '<div class="f"><label>PO / Contract #</label><input id="sow_pay_po_number" type="text" placeholder="e.g. PO-2026-0042" value="' + esc(st.po ? st.po.number : '') + '"' + dis + ' oninput="_sowPaySetPoField(\'number\', this.value)"/></div>';
  html +=     '<div class="f"><label>PO Total <span style="font-size:10px;font-weight:400;color:var(--muted);">(the amount to be paid down)</span></label><input id="sow_pay_po_amount" type="text" inputmode="decimal" placeholder="0.00" value="' + (poAmt ? esc(String(poAmt)) : '') + '"' + dis + ' oninput="_sowPaySetPoField(\'amount\', this.value)"/></div>';
  html +=   '</div>';
  if(editable){
    var mrTotal = _sowPayNum((document.getElementById('sow_total_cost')||{}).value);
    html += '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">';
    if(mrTotal > 0 && Math.abs(mrTotal - poAmt) > 0.005){
      html += '<button type="button" class="btn btn-ghost btn-sm" onclick="_sowPayUseMrTotal()">Use MR total (' + _sowPayMoney(mrTotal) + ')</button>';
    }
    html += '</div>';
  }
  html += '</div>';

  // ── Progress bar ──────────────────────────────────────────────────────
  html += '<div class="tic-section"><div id="sow_pay_summary">' + _sowPaySummaryHtml() + '</div></div>';

  // ── Payment schedule ──────────────────────────────────────────────────
  html += '<div class="tic-section">';
  html +=   '<div class="tic-section-h flex-sb"><span>Payment Schedule</span></div>';
  if(!(st.draws && st.draws.length)){
    html += '<div class="txt-muted-xs" style="margin-bottom:10px;">No payments set up yet. A standard schedule is a Material deposit, one or more Phases, and a Holdback.</div>';
    if(editable){
      html += '<div style="display:flex;gap:8px;flex-wrap:wrap;">';
      html +=   '<button type="button" class="btn btn-primary btn-sm" onclick="_sowPaySetupSchedule()">+ Set up standard schedule</button>';
      html +=   '<button type="button" class="btn btn-ghost btn-sm" onclick="_sowPayAddDraw(\'material\')">+ Material</button>';
      html +=   '<button type="button" class="btn btn-ghost btn-sm" onclick="_sowPayAddDraw(\'phase\')">+ Phase</button>';
      html +=   '<button type="button" class="btn btn-ghost btn-sm" onclick="_sowPayAddDraw(\'holdback\')">+ Holdback</button>';
      html += '</div>';
    }
  } else {
    html += '<div class="sow-pay-rows" style="display:flex;flex-direction:column;gap:10px;">';
    (st.draws||[]).forEach(function(d){ html += _sowPayDrawRowHtml(d, editable, isSaved); });
    html += '</div>';
    if(editable){
      html += '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;">';
      html +=   '<button type="button" class="btn btn-ghost btn-sm" onclick="_sowPayAddDraw(\'phase\')">+ Add Phase</button>';
      html +=   '<button type="button" class="btn btn-ghost btn-sm" onclick="_sowPayAddDraw(\'material\')">+ Material</button>';
      html +=   '<button type="button" class="btn btn-ghost btn-sm" onclick="_sowPayAddDraw(\'holdback\')">+ Holdback</button>';
      html += '</div>';
    }
    if(!isSaved){
      html += '<div class="txt-muted-xs" style="margin-top:10px;">Save the Maintenance Request to attach invoice files to each payment.</div>';
    }
  }
  html += '</div>';

  mount.innerHTML = html;
}

// Progress bar + totals — updated on its own so amount edits don't lose focus.
function _sowPaySummaryHtml(){
  var st = window._sowPayState || {po:null,draws:[]};
  var po  = (st.po && _sowPayNum(st.po.amount)) || 0;
  var paid = _sowPayPaidTotal();
  var pct  = _sowPayPercent();
  var outstanding = Math.max(0, po - paid);
  var sched = _sowPayScheduledTotal();
  var barColor = pct >= 100 ? 'var(--success)' : 'var(--info-blue)';

  var h = '';
  h += '<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px;">';
  h +=   '<span style="font-size:12px;font-weight:700;color:var(--text);">Payment progress</span>';
  h +=   '<span style="font-size:13px;font-weight:800;color:' + (pct>=100?'var(--success)':'var(--text)') + ';">' + pct + '%</span>';
  h += '</div>';
  h += '<div style="height:10px;background:var(--border);border-radius:5px;overflow:hidden;"><div style="height:100%;width:' + Math.min(100,Math.max(0,pct)) + '%;background:' + barColor + ';transition:width .2s;"></div></div>';
  h += '<div style="display:flex;gap:18px;flex-wrap:wrap;margin-top:10px;">';
  h +=   '<div><div class="txt-muted-xs">PO Total</div><div style="font-weight:800;font-size:14px;">' + _sowPayMoney(po) + '</div></div>';
  h +=   '<div><div class="txt-muted-xs">Paid</div><div style="font-weight:800;font-size:14px;color:var(--success);">' + _sowPayMoney(paid) + '</div></div>';
  h +=   '<div><div class="txt-muted-xs">Outstanding</div><div style="font-weight:800;font-size:14px;color:' + (outstanding>0?'var(--warn-amber-text,var(--text))':'var(--muted)') + ';">' + _sowPayMoney(outstanding) + '</div></div>';
  h += '</div>';

  // Schedule vs PO reconciliation hint.
  if(po > 0 && st.draws && st.draws.length){
    var diff = sched - po;
    if(Math.abs(diff) > 0.005){
      var msg = diff > 0
        ? ('Scheduled payments exceed the PO by ' + _sowPayMoney(diff))
        : (_sowPayMoney(-diff) + ' of the PO is not yet scheduled');
      h += '<div style="margin-top:8px;font-size:11px;font-weight:600;color:var(--warn-amber-text,#8a6d3b);">&#9888; ' + msg + '</div>';
    }
  }

  // Job-complete CTA at 100% paid.
  if(po > 0 && pct >= 100){
    var meta = window._sowCurrentSowMeta || {};
    if(meta.approval_status === 'completed'){
      h += '<div style="margin-top:12px;padding:10px 12px;border-radius:8px;background:var(--success-bg);border:1px solid var(--success-border);font-size:12px;font-weight:700;color:var(--success);">&#10003; Fully paid &mdash; this request is marked Completed.</div>';
    } else {
      h += '<div style="margin-top:12px;padding:10px 12px;border-radius:8px;background:var(--success-bg);border:1px solid var(--success-border);display:flex;gap:10px;align-items:center;flex-wrap:wrap;">';
      h +=   '<span style="font-size:12px;font-weight:700;color:var(--success);flex:1;min-width:180px;">&#10003; All payments recorded &mdash; the job is fully paid.</span>';
      if(typeof canMarkSowComplete === 'function' && canMarkSowComplete()){
        h += '<button type="button" class="btn btn-primary btn-sm" onclick="_sowPayMarkComplete()">&#10003; Mark Job Complete</button>';
      }
      h += '</div>';
    }
  }
  return h;
}

function _sowPayRefreshSummary(){
  var el = document.getElementById('sow_pay_summary');
  if(el) el.innerHTML = _sowPaySummaryHtml();
  // Keep the unit SOW table progress cell live if it's mounted behind us.
  if(typeof _sowRefreshStrip === 'function') _sowRefreshStrip();
}

// One payment row.
function _sowPayDrawRowHtml(d, editable, isSaved){
  var esc = function(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); };
  var dis = editable ? '' : ' disabled';
  var typeBadge = {
    material: '<span style="padding:1px 7px;border-radius:9px;font-size:9px;font-weight:800;background:rgba(var(--accent-rgb),.16);color:var(--accent-ink,var(--text));">MATERIAL</span>',
    phase:    '<span style="padding:1px 7px;border-radius:9px;font-size:9px;font-weight:800;background:var(--info-blue-bg);color:var(--info-blue);">PHASE</span>',
    holdback: '<span style="padding:1px 7px;border-radius:9px;font-size:9px;font-weight:800;background:var(--warn-amber-bg);color:var(--warn-amber-text,#8a6d3b);">HOLDBACK</span>'
  }[d.type] || '';
  var idJs = "'" + d.id + "'";

  var h = '<div class="box-bg-card" style="padding:12px;border:1px solid var(--border);border-radius:8px;' + (d.paid ? 'background:var(--success-bg);' : '') + '">';

  // Header: badge + label + remove
  h += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">';
  h +=   typeBadge;
  h +=   '<input type="text" value="' + esc(d.label||'') + '"' + dis + ' oninput="_sowPaySetDrawField(' + idJs + ',\'label\',this.value)" style="flex:1;min-width:120px;border:none;background:transparent;font-weight:700;font-size:13px;color:var(--text);padding:2px 0;" placeholder="Payment name"/>';
  if(editable) h += '<button type="button" title="Remove" onclick="_sowPayRemoveDraw(' + idJs + ')" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:16px;line-height:1;">&times;</button>';
  h += '</div>';

  // Amount + paid toggle + dates
  h += '<div class="grid-c2-10">';
  h +=   '<div class="f"><label>Amount</label><input type="text" inputmode="decimal" value="' + (d.amount ? esc(String(d.amount)) : '') + '"' + dis + ' oninput="_sowPaySetDrawField(' + idJs + ',\'amount\',this.value)" placeholder="0.00"/></div>';
  if(d.type === 'holdback'){
    h += '<div class="f"><label>Holdback release date</label><input type="date" value="' + esc(d.releaseDate||'') + '"' + dis + ' onchange="_sowPaySetDrawField(' + idJs + ',\'releaseDate\',this.value)"/></div>';
  } else {
    h += '<div class="f"></div>';
  }
  h += '</div>';

  // Paid row
  h += '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:8px;">';
  h +=   '<label class="check-row" style="margin:0;"><input type="checkbox"' + (d.paid?' checked':'') + dis + ' onchange="_sowPayTogglePaid(' + idJs + ',this.checked)" class="icon-sm"/> Paid</label>';
  if(d.paid){
    h += '<div class="f" style="margin:0;"><input type="date" value="' + esc(d.paidDate||'') + '"' + dis + ' onchange="_sowPaySetDrawField(' + idJs + ',\'paidDate\',this.value)" title="Date paid"/></div>';
  }
  h += '</div>';

  // Invoice chip
  h += '<div style="margin-top:10px;padding-top:8px;border-top:1px dashed var(--border);">';
  if(d.invoice && d.invoice.path){
    h += '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">';
    h +=   '<span style="font-size:11px;font-weight:700;color:var(--success);">&#128206; Invoice:</span>';
    h +=   '<button type="button" class="link-yellow" style="background:none;border:none;cursor:pointer;font-size:11px;padding:0;text-decoration:underline;" onclick="_sowViewDrawInvoice(' + idJs + ')">' + esc(d.invoice.name||'View invoice') + '</button>';
    if(editable) h += '<button type="button" onclick="_sowRemoveDrawInvoice(' + idJs + ')" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:11px;text-decoration:underline;">remove</button>';
    h += '</div>';
  } else if(editable){
    if(isSaved){
      h += '<label style="font-size:11px;font-weight:600;color:var(--info-blue);cursor:pointer;">';
      h +=   '&#128206; Attach invoice (PDF/photo)';
      h +=   '<input type="file" accept="application/pdf,image/*" style="display:none;" onchange="_sowUploadDrawInvoice(' + idJs + ',this)"/>';
      h += '</label>';
    } else {
      h += '<span class="txt-muted-xs">&#128206; Save the request first to attach an invoice.</span>';
    }
  } else {
    h += '<span class="txt-muted-xs">No invoice attached.</span>';
  }
  h += '</div>';

  h += '</div>';
  return h;
}

// ── Mutators ────────────────────────────────────────────────────────────────
function _sowPaySetPoField(field, v){
  var st = window._sowPayState; if(!st) return;
  if(!st.po) st.po = { number:'', amount:0, source:'manual' };
  if(field === 'amount'){ st.po.amount = _sowPayNum(v); st.po.source = 'manual'; }
  else st.po[field] = v;
  if(field === 'amount') _sowPayRefreshSummary();
  // Mirror PO number back onto the Overview field so the two stay in step.
  if(field === 'number'){ var o = document.getElementById('sow_po_number'); if(o) o.value = v; }
}
function _sowPayUseMrTotal(){
  var st = window._sowPayState; if(!st) return;
  if(!st.po) st.po = { number:'', amount:0, source:'manual' };
  st.po.amount = _sowPayNum((document.getElementById('sow_total_cost')||{}).value);
  st.po.source = 'manual';
  _sowRenderPayments();
}
function _sowPaySetupSchedule(){
  var st = window._sowPayState; if(!st) return;
  if(st.draws && st.draws.length){ if(typeof showToast==='function') showToast('A schedule already exists.', {type:'info'}); return; }
  if(!st.po || _sowPayNum(st.po.amount) <= 0){ if(typeof showToast==='function') showToast('Enter the PO total first.', {type:'error'}); return; }
  st.draws = _sowPayStandardSchedule();
  _sowRenderPayments();
}
function _sowPayAddDraw(type){
  var st = window._sowPayState; if(!st) return;
  if(!st.draws) st.draws = [];
  var draw;
  if(type === 'phase'){
    var maxPhase = 0;
    st.draws.forEach(function(d){ if(d.type==='phase' && (d.phaseNo||0) > maxPhase) maxPhase = d.phaseNo||0; });
    var no = maxPhase + 1;
    draw = { id:_sowPayUid(), type:'phase', phaseNo:no, label:'Phase ' + no, amount:0, paid:false, paidDate:'', invoice:null };
  } else if(type === 'holdback'){
    draw = { id:_sowPayUid(), type:'holdback', label:'Holdback', amount:0, paid:false, paidDate:'', releaseDate:'', invoice:null };
  } else {
    draw = { id:_sowPayUid(), type:'material', label:'Material', amount:0, paid:false, paidDate:'', invoice:null };
  }
  // Keep holdback rows last; insert new phases/material before any holdback.
  if(type !== 'holdback'){
    var hbIdx = st.draws.findIndex(function(d){ return d.type==='holdback'; });
    if(hbIdx >= 0) st.draws.splice(hbIdx, 0, draw); else st.draws.push(draw);
  } else {
    st.draws.push(draw);
  }
  _sowRenderPayments();
}
function _sowPayRemoveDraw(id){
  var st = window._sowPayState; if(!st || !st.draws) return;
  st.draws = st.draws.filter(function(d){ return d.id !== id; });
  _sowRenderPayments();
  _sowPersistPayments();
}
function _sowPaySetDrawField(id, field, v){
  var st = window._sowPayState; if(!st || !st.draws) return;
  var d = st.draws.find(function(x){ return x.id === id; });
  if(!d) return;
  d[field] = (field === 'amount') ? _sowPayNum(v) : v;
  if(field === 'amount') _sowPayRefreshSummary();
  if(field === 'paidDate' || field === 'releaseDate') _sowPersistPayments();
}
function _sowPayTogglePaid(id, checked){
  var st = window._sowPayState; if(!st || !st.draws) return;
  var d = st.draws.find(function(x){ return x.id === id; });
  if(!d) return;
  d.paid = !!checked;
  if(d.paid && !d.paidDate) d.paidDate = new Date().toISOString().slice(0,10);
  _sowRenderPayments();
  _sowPersistPayments();
}

// ── Invoice files ───────────────────────────────────────────────────────────
async function _sowUploadDrawInvoice(id, input){
  var file = input && input.files && input.files[0];
  if(!file) return;
  if(!(window._sowWasPreviouslySaved && _sowUnitId && window._sowEditingProjectNumber)){
    if(typeof showToast==='function') showToast('Save the request first, then attach invoices.', {type:'error'});
    input.value = '';
    return;
  }
  var st = window._sowPayState;
  var d = st && st.draws && st.draws.find(function(x){ return x.id === id; });
  if(!d){ input.value=''; return; }
  var safe = file.name.replace(/[^A-Za-z0-9._-]/g,'_');
  var path = 'sow/' + _sowUnitId + '/' + window._sowEditingProjectNumber + '/payments/' + id + '_' + safe;
  if(typeof showToast==='function') showToast('Uploading invoice…', {type:'info'});
  try{
    await sbUploadFile(path, file);
    if(typeof sbSaveFileMeta === 'function'){
      try { sbSaveFileMeta('tenant', _sowUnitId, path, file.name, file.size, file.type); } catch(e){}
    }
    d.invoice = { path:path, name:file.name };
    _sowPersistPayments();     // persist immediately so the file can't be orphaned
    if(typeof showToast==='function') showToast('✓ Invoice attached', {type:'info'});
    _sowRenderPayments();
  }catch(e){
    console.warn('[SOW pay] invoice upload failed:', e);
    if(typeof showToast==='function') showToast('Invoice upload failed', {type:'error'});
  }
  input.value = '';
}
async function _sowViewDrawInvoice(id){
  var st = window._sowPayState;
  var d = st && st.draws && st.draws.find(function(x){ return x.id === id; });
  if(!d || !d.invoice || !d.invoice.path) return;
  try{
    var url = (typeof sbGetSignedUrl === 'function') ? await sbGetSignedUrl(d.invoice.path) : null;
    if(url) window.open(url, '_blank');
    else if(typeof showToast==='function') showToast('Could not open invoice', {type:'error'});
  }catch(e){
    console.warn('[SOW pay] view invoice failed:', e);
    if(typeof showToast==='function') showToast('Could not open invoice', {type:'error'});
  }
}
function _sowRemoveDrawInvoice(id){
  var st = window._sowPayState;
  var d = st && st.draws && st.draws.find(function(x){ return x.id === id; });
  if(!d) return;
  // Clears the link only — the stored file remains (also surfaces on the unit
  // Documents tab), mirroring the Capital Projects "detach" behaviour.
  d.invoice = null;
  _sowRenderPayments();
  _sowPersistPayments();
}

// ── Persist / collect ───────────────────────────────────────────────────────
// Copy the working payment state onto a SOW record and stamp progress.
function _sowCollectPayments(data){
  var st = window._sowPayState;
  if(!st) return;
  var hasPo    = st.po && _sowPayNum(st.po.amount) > 0;
  var hasDraws = st.draws && st.draws.length;
  if(!hasPo && !hasDraws) return;   // nothing configured — don't write paymentProgress
  data.po = st.po ? {
    number: st.po.number || '',
    amount: _sowPayNum(st.po.amount),
    source: st.po.source || 'manual',
    rfqId: st.po.rfqId || undefined,
    contractorId: st.po.contractorId || undefined
  } : null;
  data.draws = (st.draws||[]).map(function(d){
    return {
      id: d.id, type: d.type, phaseNo: d.phaseNo,
      label: d.label || '', amount: _sowPayNum(d.amount),
      paid: !!d.paid, paidDate: d.paidDate || '',
      releaseDate: d.releaseDate || undefined,
      invoice: (d.invoice && d.invoice.path) ? { path:d.invoice.path, name:d.invoice.name } : null
    };
  });
  // NOTE: payment progress is a DISTINCT concept from renovation work-progress.
  // saveRenoProgress (renos.html) owns sow.progress.percent (physical work % —
  // rendered by the unit SOW table's Progress column and the reno approvals
  // Progress column). Payment progress lives in its OWN field so the two never
  // clobber each other; the reno approvals "Payments" column reads this.
  data.paymentProgress = { percent: _sowPayPercent(), paid: _sowPayPaidTotal(), po: (st.po ? _sowPayNum(st.po.amount) : 0), updatedAt: new Date().toISOString() };
}

// Immediately persist payments onto the already-saved SOW (paid toggles /
// invoice attach/detach). No-op for an unsaved request.
function _sowPersistPayments(){
  if(!(_sowUnitId && window._sowEditingProjectNumber)) return;
  var sow = (typeof getSowByProjectNumber === 'function') ? getSowByProjectNumber(_sowUnitId, window._sowEditingProjectNumber) : null;
  if(!sow) return;
  _sowCollectPayments(sow);
  if(typeof upsertSowInList === 'function') upsertSowInList(_sowUnitId, sow);
  // Light refresh of any visible SOW table / worklist so the progress cell updates.
  try {
    if(typeof udpRenderSowTable === 'function' && window._currentDetailUnitId === _sowUnitId) udpRenderSowTable(_sowUnitId);
    if(typeof renderWorklist === 'function' && document.getElementById('worklist_body')) renderWorklist();
  } catch(e){}
}

function _sowPayMarkComplete(){
  if(typeof markSowComplete === 'function') markSowComplete();
}

// Expose for inline handlers.
window._sowRenderPayments   = _sowRenderPayments;
window._sowInitPayState     = _sowInitPayState;
window._sowCollectPayments  = _sowCollectPayments;
window._sowPaySetPoField    = _sowPaySetPoField;
window._sowPayUseMrTotal    = _sowPayUseMrTotal;
window._sowPaySetupSchedule = _sowPaySetupSchedule;
window._sowPayAddDraw       = _sowPayAddDraw;
window._sowPayRemoveDraw    = _sowPayRemoveDraw;
window._sowPaySetDrawField  = _sowPaySetDrawField;
window._sowPayTogglePaid    = _sowPayTogglePaid;
window._sowUploadDrawInvoice= _sowUploadDrawInvoice;
window._sowViewDrawInvoice  = _sowViewDrawInvoice;
window._sowRemoveDrawInvoice= _sowRemoveDrawInvoice;
window._sowPayMarkComplete  = _sowPayMarkComplete;

// ═══════════════════════════════════════════════════════════════════════════
// Contracting tab — full Contractor Agreement for a Maintenance Request that is
// assigned directly to a contractor (no RFQ tender). Mirrors the RFQ Contracting
// tab and produces the SAME PDF via the shared window.buildContractPdf
// (shared-contract.js). State rides sow.contract on the housing_sow.data jsonb,
// exactly like payments (sow.po/sow.draws). Management-only edit.
// ═══════════════════════════════════════════════════════════════════════════

function _sowContractEditable(){
  var meta = window._sowCurrentSowMeta || {};
  if(meta.approval_status === 'completed'){
    if(typeof canReopenSow === 'function' && !canReopenSow()) return false;
  }
  var role = window._realRole || window.currentRole || 'staff';
  if(typeof ROLE !== 'undefined' && ROLE.isManagement) return !!ROLE.isManagement(role);
  return true;
}
function _sowConNum(v){ return (typeof _sowPayNum === 'function') ? _sowPayNum(v) : (parseFloat(String(v==null?'':v).replace(/[^0-9.\-]/g,''))||0); }
function _sowConMoney(n){
  var x = _sowConNum(n);
  return '$' + x.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function _sowConEsc(s){ return (typeof _esc === 'function') ? _esc(s) : String(s==null?'':s).replace(/[&<>"']/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); }

function _sowContractDefault(){
  return {
    contract_number:'', contract_date:'', contract_start:'',
    substantial_completion_date:'', total_completion_date:'', holdback_days:'45', holdback_release:'',
    price_materials:'', price_labour:'', price_equipment:'', price_subcontractors:'', price_other:'', labour_hours:'',
    sig_name:'', sig_title:'', ct_signatory_name:'', ct_signatory_title:'', sow_summary:'',
    scope_detail_rows:[], materials_rows:[], exclusions_rows:[], clfn_supplied_rows:[], subcontractor_rows:[], milestones:[]
  };
}

// Seed the working contract state once per modal open.
function _sowInitContractState(saved){
  var st, def = _sowContractDefault();
  if(saved && saved.contract && typeof saved.contract === 'object'){
    st = JSON.parse(JSON.stringify(saved.contract));
    Object.keys(def).forEach(function(k){ if(st[k]==null) st[k]=def[k]; });
    ['scope_detail_rows','materials_rows','exclusions_rows','clfn_supplied_rows','subcontractor_rows','milestones'].forEach(function(k){ if(!Array.isArray(st[k])) st[k]=[]; });
  } else {
    st = def;
    if(typeof window.nextContractNumber === 'function') st.contract_number = window.nextContractNumber();
    st.contract_date = new Date().toISOString().slice(0,10);
    var total = _sowConNum((document.getElementById('sow_total_cost')||{}).value);
    if(total>0) st.price_labour = String(total);   // seed total under Labour; staff re-split
  }
  // Always ensure a contract number when blank (fresh, or a saved contract that
  // was persisted before a number was assigned).
  if(!st.contract_number && typeof window.nextContractNumber === 'function') st.contract_number = window.nextContractNumber();
  if(!st.contract_date) st.contract_date = new Date().toISOString().slice(0,10);
  // Prefill contract dates from the Overview tab (Target Start / Completion)
  // wherever the contract's own date isn't already set.
  var _ov = function(id){ var e=document.getElementById(id); return (e && e.value) ? e.value : ''; };
  if(!st.contract_start)             st.contract_start = _ov('sow_start_date');
  if(!st.substantial_completion_date) st.substantial_completion_date = _ov('sow_end_date');
  if(!st.total_completion_date)       st.total_completion_date = _ov('sow_end_date');
  window._sowContractState = st;
  window._sowContractCt = null;
  // Auto-fill the default (RFQ-style) payment schedule when none exists yet and
  // a contract price is set — staff can then edit or re-run it. Runs after the
  // state is stored because the builder reads the Materials line from it.
  if((!Array.isArray(st.milestones) || !st.milestones.length) && _sowConSubtotalFrom(st) > 0){
    st.milestones = _sowConBuildStandardSchedule(_sowConSubtotalFrom(st));
  }
}

// ── Row renderers (each mutates window._sowContractState.<arr> and re-renders) ──
function _sowConRows(key){ var st=window._sowContractState||{}; if(!Array.isArray(st[key])) st[key]=[]; return st[key]; }
function _sowConRowField(key, i, field, val){ var a=_sowConRows(key); if(a[i]){ a[i][field]=val; if(key==='milestones' && (field==='pct' || field==='gross')) _sowConMilestoneCalc(i, field); } }
// Bidirectional Schedule B calc (mirrors the RFQ _rfqCalcMilestoneRow): typing a
// % derives gross from the contract price; typing a gross derives the %. Holdback
// is 10% of gross and net = 90%. Sibling fields update in place so focus isn't
// lost while typing.
// Manual %<->gross edit (mirrors the RFQ _rfqCalcMilestoneRow): typing a % sets
// gross from the contract price and marks the row 'phase'; typing a dollar sets
// the % and makes the row fixed (no kind, so it stops auto-tracking the price).
function _sowConMilestoneCalc(i, source){
  var a=_sowConRows('milestones'); var r=a[i]; if(!r) return;
  var total=_sowConSubtotalFrom();
  var pct=_sowConNum(r.pct), gross=_sowConNum(r.gross);
  if(source==='pct' && total>0){
    gross = total*pct/100; r.gross = gross.toFixed(2);
    var ge=document.getElementById('sow_con_ms_gross_'+i); if(ge) ge.value=r.gross;
  } else if(source==='gross' && total>0){
    pct = gross/total*100; r.pct = String(Math.round(pct*100)/100);
    var pe=document.getElementById('sow_con_ms_pct_'+i); if(pe) pe.value=r.pct;
  }
  var holdback=gross*0.10; r.holdback=holdback.toFixed(2);
  var net=gross-holdback; r.net=(net>=0?net:0).toFixed(2);
  r.kind = (source==='pct' && _sowConNum(r.pct)>0) ? 'phase' : '';
  var hb=document.getElementById('sow_con_ms_hb_'+i), nt=document.getElementById('sow_con_ms_net_'+i);
  if(hb) hb.textContent=_sowConMoney(r.holdback); if(nt) nt.textContent=_sowConMoney(r.net);
}
function _sowConAddRow(key, blank){ _sowConRows(key).push(blank); _sowRenderContracting(); if(typeof _sowContractScheduleSave==='function') _sowContractScheduleSave(); }

// Apply a gross to milestone row i: recompute holdback (10%) / net, refresh the
// reference % on material/remainder rows, and update DOM in place.
function _sowConApplyGross(r, i, gross, total, kind){
  gross = Math.round((parseFloat(gross)||0)*100)/100;
  var hb = Math.round(gross*10)/100; var net = Math.round((gross-hb)*100)/100;
  r.gross=String(gross||''); r.holdback=String(hb||''); r.net=String(net>=0?net:0);
  var showPct = (kind==='material' || kind==='remainder');
  if(showPct && total>0) r.pct = String(Math.round(gross/total*10000)/100);
  var ge=document.getElementById('sow_con_ms_gross_'+i); if(ge) ge.value=r.gross;
  var pe=document.getElementById('sow_con_ms_pct_'+i); if(pe && showPct) pe.value=r.pct;
  var hbEl=document.getElementById('sow_con_ms_hb_'+i); if(hbEl) hbEl.textContent=_sowConMoney(r.holdback);
  var ntEl=document.getElementById('sow_con_ms_net_'+i); if(ntEl) ntEl.textContent=_sowConMoney(r.net);
}
// When the contract price changes, re-derive milestones by kind (mirrors the RFQ
// _rfqRefreshMilestonesFromTotal): 'material' = 50% of the Materials line,
// 'phase' = its % of the contract price, fixed = left as-is; then 'remainder'
// rows take whatever is left of the contract.
function _sowConRecalcMilestonesFromPrice(){
  var st=window._sowContractState; if(!st || !Array.isArray(st.milestones)) return;
  var total=_sowConSubtotalFrom();
  var materials=_sowConNum(st.price_materials);
  var sumNon=0, remIdx=[];
  st.milestones.forEach(function(r, i){
    var kind=r.kind||'';
    if(kind==='remainder'){ remIdx.push(i); return; }
    var pct=_sowConNum(r.pct), g;
    if(kind==='material'){ g=Math.round(materials*50)/100; _sowConApplyGross(r, i, g, total, kind); }
    else if(pct>0 && total>0){ g=total*pct/100; _sowConApplyGross(r, i, g, total, kind); }
    else { g=_sowConNum(r.gross); _sowConApplyGross(r, i, g, total, kind); }
    sumNon += (parseFloat(g)||0);
  });
  remIdx.forEach(function(ri){
    var g=Math.max(0, Math.round((total-sumNon)*100)/100);
    _sowConApplyGross(st.milestones[ri], ri, g, total, 'remainder');
    sumNon += g;
  });
}

// Contract price subtotal (sum of the Price Breakdown fields).
function _sowConSubtotalFrom(st){ st = st || window._sowContractState || {}; return ['price_materials','price_labour','price_equipment','price_subcontractors','price_other'].reduce(function(s,k){ return s + _sowConNum(st[k]); }, 0); }
// Milestone from a dollar amount (kind-tagged), holdback = 10%, net = 90%.
function _sowConMsFromAmount(name, gross, pct, kind){
  gross = Math.round((parseFloat(gross)||0)*100)/100;
  var holdback = Math.round(gross*10)/100;
  var net = Math.round((gross-holdback)*100)/100;
  return { name:name, kind:kind||'', pct:(pct==null?'':String(pct)), gross:String(gross||''), holdback:String(holdback||''), net:String(net>=0?net:0) };
}
// Default schedule matching the RFQ Contracting tab (_rfqDefaultMilestones):
//   "50% Material" = 50% of the Materials line (a supply deposit), then fixed
//   phases as a % of the contract price, and a FINAL remainder phase.
//     <  $75k: Material + Phase 1 25% + Phase 2 25% + Phase 3 (remainder)
//     >= $75k: Material + Phase 1-3 at 20% each     + Phase 4 (remainder)
// Rows carry a `kind` (material/phase/remainder) that drives the live recompute.
function _sowConBuildStandardSchedule(subtotal){
  var total = _sowConNum(subtotal);
  var st = window._sowContractState || {};
  var materials = _sowConNum(st.price_materials);
  var matDeposit = Math.round(materials*50)/100;      // 50% of Materials
  if(total>0) matDeposit = Math.min(matDeposit, total);
  var big = total >= 75000;
  var phasePct = big ? 20 : 25;
  var midPhases = big ? ['Phase 1','Phase 2','Phase 3'] : ['Phase 1','Phase 2'];
  function pctOf(g){ return total>0 ? Math.round(g/total*10000)/100 : null; }
  var rows = [ _sowConMsFromAmount('50% Material', matDeposit, pctOf(matDeposit), 'material') ];
  var spent = matDeposit;
  midPhases.forEach(function(name){
    var ideal = Math.round(total*phasePct)/100;
    var remaining = Math.max(0, Math.round((total-spent)*100)/100);
    var gross = Math.min(ideal, remaining);
    var clean = gross === ideal;
    spent += gross;
    rows.push(_sowConMsFromAmount(name, gross, clean?phasePct:null, clean?'phase':''));
  });
  var rem = Math.max(0, Math.round((total-spent)*100)/100);
  rows.push(_sowConMsFromAmount(big?'Phase 4':'Phase 3', rem, pctOf(rem), 'remainder'));
  return rows;
}
// Button: (re)build Schedule B from the current contract price.
function _sowConSetupSchedule(){
  var st = window._sowContractState; if(!st) return;
  st.milestones = _sowConBuildStandardSchedule(_sowConSubtotalFrom(st));
  _sowRenderContracting();
  if(typeof _sowContractScheduleSave==='function') _sowContractScheduleSave();
}
function _sowConRemoveRow(key, i){ var a=_sowConRows(key); a.splice(i,1); _sowRenderContracting(); if(typeof _sowContractScheduleSave==='function') _sowContractScheduleSave(); }

function _sowConSubOptions(selId){
  var cts = window._contractors || [];
  var opts = '<option value="">— Select contractor —</option>';
  cts.forEach(function(c){
    var id = c.id || c.contractor_id || '';
    opts += '<option value="'+_sowConEsc(id)+'"'+(String(selId)===String(id)?' selected':'')+'>'+_sowConEsc(c.name || c.business_name || id)+'</option>';
  });
  return opts;
}
function _sowConSubChange(i, sel){
  var a=_sowConRows('subcontractor_rows'); if(!a[i]) return;
  a[i].contractorId = sel.value;
  var cts = window._contractors || [];
  var ct = cts.filter(function(c){ return String(c.id||c.contractor_id)===String(sel.value); })[0];
  if(ct){ a[i].name = ct.name || ct.business_name || ''; a[i].trade = a[i].trade || ct.trade || ct.specialty || ''; }
  _sowRenderContracting();
  if(typeof _sowContractScheduleSave==='function') _sowContractScheduleSave();
}

// ── Main render ──────────────────────────────────────────────────────────────
function _sowRenderContracting(){
  var host = document.getElementById('sow_contracting_body');
  if(!host) return;
  if(!window._sowContractState) _sowInitContractState(null);
  var st = window._sowContractState;
  if(!st.contract_number && typeof window.nextContractNumber === 'function') st.contract_number = window.nextContractNumber();
  // Keep contract dates in step with the Overview tab when they're still blank.
  var _ovd = function(id){ var e=document.getElementById(id); return (e && e.value) ? e.value : ''; };
  if(!st.contract_start && _ovd('sow_start_date'))             st.contract_start = _ovd('sow_start_date');
  if(!st.substantial_completion_date && _ovd('sow_end_date'))  st.substantial_completion_date = _ovd('sow_end_date');
  if(!st.total_completion_date && _ovd('sow_end_date'))        st.total_completion_date = _ovd('sow_end_date');
  var editable = _sowContractEditable();
  var dis = editable ? '' : ' disabled';

  // Resolve the assigned contractor (async) to show the header + prefill signatory.
  var ctId = (document.getElementById('sow_contractor_id')||{}).value || '';
  if(ctId && !window._sowContractCt && typeof _resolveContractorForEmail==='function'){
    _resolveContractorForEmail(ctId).then(function(ct){
      if(ct){ window._sowContractCt = ct;
        if(!st.ct_signatory_name) st.ct_signatory_name = (ct.sigCt && ct.sigCt.name) || ct.name || '';
        _sowRenderContracting();
      }
    }).catch(function(){});
  }
  var ct = window._sowContractCt;

  function inp(id, val, ph, type){ return '<input id="'+id+'" class="stg-lookup-input" type="'+(type||'text')+'" value="'+_sowConEsc(val||'')+'" placeholder="'+_sowConEsc(ph||'')+'"'+dis+'/>'; }
  function fld(lbl, ctl){ return '<div class="f"><label>'+lbl+'</label>'+ctl+'</div>'; }
  // Section wrapper matching the RFQ Contracting tab (card + dark header bar).
  function sec(title, inner){ return '<div class="card card-flush"><div class="modal-hdr"><div class="lbl-yellow">'+title+'</div></div><div class="sec-pad">'+inner+'</div></div>'; }

  var readOnlyBanner = editable ? '' :
    '<div style="padding:8px 12px;background:var(--warn-amber-bg);border:1px solid var(--border);border-radius:8px;font-size:12px;color:var(--warn-amber-text,#8a6d3b);margin-bottom:12px;">🔒 View only — contracting is management-only.</div>';

  var h = readOnlyBanner;

  // Contractor header
  h += sec('Contractor',
        '<div style="font-size:13px;color:var(--text);">'
      + (ct ? ('<b>'+_sowConEsc(ct.name||'')+'</b>'+(ct.address?(' · '+_sowConEsc(ct.address)):'')+(ct.phone?(' · '+_sowConEsc(ct.phone)):''))
            : (ctId ? 'Resolving assigned contractor…' : '<span style="color:var(--muted);">No contractor assigned. Set “Assigned To” to a contractor on the Overview tab to build a contract.</span>'))
      + '</div>');

  // Contract meta
  h += sec('Contract Details', '<div class="tic-grid-2">'
     + fld('Contract # <span style="font-size:10px;color:var(--muted);">auto-assigned</span>', '<input id="sow_con_number" class="stg-lookup-input" type="text" value="'+_sowConEsc(st.contract_number||'')+'" readonly style="background:var(--bg);color:var(--muted);"/>')
     + fld('Contract Date', inp('sow_con_date', st.contract_date, '', 'date'))
     + fld('Start Date', inp('sow_con_start', st.contract_start, '', 'date'))
     + fld('Substantial Completion Date', inp('sow_con_subcompl', st.substantial_completion_date, '', 'date'))
     + fld('Total Completion Date', inp('sow_con_totcompl', st.total_completion_date, '', 'date'))
     + fld('Holdback (days)', inp('sow_con_hbdays', st.holdback_days, '45'))
     + '</div>');

  // Price breakdown
  h += sec('Contract Price Breakdown', '<div class="tic-grid-2">'
     + fld('Materials ($)', inp('sow_con_pmat', st.price_materials, '$0.00'))
     + fld('Labour ($)', inp('sow_con_plab', st.price_labour, '$0.00'))
     + fld('Equipment ($)', inp('sow_con_peqp', st.price_equipment, '$0.00'))
     + fld('Subcontractors ($)', inp('sow_con_psub', st.price_subcontractors, '$0.00'))
     + fld('Other ($)', inp('sow_con_poth', st.price_other, '$0.00'))
     + fld('Labour Hours', inp('sow_con_lhours', st.labour_hours, ''))
     + '</div>');

  // Schedule B — milestone payments
  var msRows = _sowConRows('milestones').map(function(m, i){
    return '<div style="display:grid;grid-template-columns:1fr 70px 100px 90px 90px 28px;gap:6px;align-items:center;">'
      + '<input type="text" placeholder="Milestone" value="'+_sowConEsc(m.name||'')+'"'+dis+' oninput="_sowConRowField(\'milestones\','+i+',\'name\',this.value)"/>'
      + '<input type="text" id="sow_con_ms_pct_'+i+'" placeholder="%" value="'+_sowConEsc(m.pct||'')+'"'+dis+' oninput="_sowConRowField(\'milestones\','+i+',\'pct\',this.value)"/>'
      + '<input type="text" id="sow_con_ms_gross_'+i+'" placeholder="Gross" value="'+_sowConEsc(m.gross||'')+'"'+dis+' oninput="_sowConRowField(\'milestones\','+i+',\'gross\',this.value)"/>'
      + '<span id="sow_con_ms_hb_'+i+'" style="font-size:12px;color:var(--muted);text-align:right;">'+_sowConMoney(m.holdback)+'</span>'
      + '<span id="sow_con_ms_net_'+i+'" style="font-size:12px;color:var(--text);text-align:right;">'+_sowConMoney(m.net)+'</span>'
      + (editable ? '<button type="button" title="Remove" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:15px;line-height:1;padding:0 4px;" onclick="_sowConRemoveRow(\'milestones\','+i+')">✕</button>' : '<span></span>')
      + '</div>';
  }).join('');
  h += sec('Schedule B — Milestone Payments',
       '<div style="display:grid;grid-template-columns:1fr 70px 100px 90px 90px 28px;gap:6px;font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;margin-bottom:4px;"><span>Name</span><span>%</span><span>Gross</span><span style="text-align:right;">Holdback</span><span style="text-align:right;">Net</span><span></span></div>'
     + '<div style="display:flex;flex-direction:column;gap:6px;">'+ (msRows || '<div class="txt-muted-xs">No milestones. Holdback auto-computes at 10% of gross.</div>') +'</div>'
     + (editable ? '<button type="button" class="btn btn-ghost btn-sm" style="margin-top:8px;margin-right:8px;" onclick="_sowConSetupSchedule()">Reset to default schedule</button>' : '')
     + (editable ? '<button type="button" class="btn btn-ghost btn-sm" style="margin-top:8px;" onclick="_sowConAddRow(\'milestones\',{name:\'\',pct:\'\',gross:\'\',holdback:\'\',net:\'\'})">+ Add milestone</button>' : ''));

  // Generic 3-col / text row sections
  function simpleRows(key, cols){
    return _sowConRows(key).map(function(r, i){
      var inputs = cols.map(function(c){
        return '<input type="text" placeholder="'+_sowConEsc(c.ph)+'" value="'+_sowConEsc(r[c.f]||'')+'"'+dis+' oninput="_sowConRowField(\''+key+'\','+i+',\''+c.f+'\',this.value)" style="flex:'+(c.flex||1)+';min-width:0;"/>';
      }).join('');
      return '<div style="display:flex;gap:6px;align-items:center;">'+inputs+(editable?'<button type="button" title="Remove" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:15px;line-height:1;padding:0 4px;" onclick="_sowConRemoveRow(\''+key+'\','+i+')">✕</button>':'')+'</div>';
    }).join('');
  }
  function section(title, key, cols, blank, hint){
    return sec(title,
        '<div style="display:flex;flex-direction:column;gap:6px;">'+(simpleRows(key,cols) || ('<div class="txt-muted-xs">'+(hint||'None added.')+'</div>'))+'</div>'
      + (editable ? '<button type="button" class="btn btn-ghost btn-sm" style="margin-top:8px;" onclick="_sowConAddRow(\''+key+'\','+JSON.stringify(blank).replace(/"/g,'&quot;')+')">+ Add</button>' : ''));
  }
  h += section('Materials &amp; Specifications', 'materials_rows', [{f:'material',ph:'Material',flex:1},{f:'specification',ph:'Specification',flex:1},{f:'notes',ph:'Notes',flex:1}], {material:'',specification:'',notes:''});
  h += section('Exclusions &amp; Assumptions', 'exclusions_rows', [{f:'text',ph:'Exclusion / assumption',flex:1}], {text:''});
  h += section('Items Supplied by Nation', 'clfn_supplied_rows', [{f:'item',ph:'Item supplied by the Nation',flex:1}], {item:''});

  // Subcontractors (contractor picker + trade + scope)
  var subRows = _sowConRows('subcontractor_rows').map(function(r, i){
    return '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">'
      + '<select'+dis+' onchange="_sowConSubChange('+i+',this)" style="flex:1;min-width:140px;">'+_sowConSubOptions(r.contractorId)+'</select>'
      + '<input type="text" placeholder="Trade" value="'+_sowConEsc(r.trade||'')+'"'+dis+' oninput="_sowConRowField(\'subcontractor_rows\','+i+',\'trade\',this.value)" style="flex:1;min-width:100px;"/>'
      + '<input type="text" placeholder="Scope" value="'+_sowConEsc(r.scope||'')+'"'+dis+' oninput="_sowConRowField(\'subcontractor_rows\','+i+',\'scope\',this.value)" style="flex:1.4;min-width:120px;"/>'
      + (editable?'<button type="button" title="Remove" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:15px;line-height:1;padding:0 4px;" onclick="_sowConRemoveRow(\'subcontractor_rows\','+i+')">✕</button>':'')
      + '</div>';
  }).join('');
  h += sec('Subcontractors',
       '<div class="txt-muted-xs" style="margin-bottom:6px;">Every subcontractor must provide a valid WSIB clearance and proof of $2,000,000 CGL insurance — the requirement prints in the contract automatically.</div>'
     + '<div style="display:flex;flex-direction:column;gap:6px;">'+(subRows || '<div class="txt-muted-xs">None.</div>')+'</div>'
     + (editable ? '<button type="button" class="btn btn-ghost btn-sm" style="margin-top:8px;" onclick="_sowConAddRow(\'subcontractor_rows\',{contractorId:\'\',name:\'\',trade:\'\',scope:\'\'})">+ Add subcontractor</button>' : ''));

  // Signatures
  function sigPad(id, label){
    return '<div style="margin-bottom:14px;"><div class="tic-field-lbl" style="margin-bottom:6px;">'+label+'</div>'
      + '<div class="sig-canvas-wrap"><div class="tab-bar">'
      + '<button type="button" onclick="setSigMethod(\''+id+'\',\'canvas\')" id="'+id+'_tab_canvas" class="tab-item active">&#9999;&#65039; Draw</button>'
      + '<button type="button" onclick="setSigMethod(\''+id+'\',\'type\')"   id="'+id+'_tab_type"   class="tab-item">&#9000;&#65039; Type</button>'
      + '<button type="button" onclick="setSigMethod(\''+id+'\',\'wet\')"    id="'+id+'_tab_wet"    class="tab-item">&#128396; Wet</button>'
      + '</div>'
      + '<div id="'+id+'_panel_canvas" class="bg-paper"><canvas id="'+id+'" width="600" height="90" style="width:100%;height:90px;display:block;touch-action:none;cursor:crosshair;"></canvas>'
      + '<div style="display:flex;align-items:center;justify-content:space-between;padding:4px 10px;border-top:1px solid var(--border);">'
      + '<span class="txt-xs-muted">Sign with finger or mouse</span>'
      + '<button type="button" onclick="clearSig(\''+id+'\')" style="background:none;border:1px solid var(--border);border-radius:5px;padding:2px 8px;font-size:10px;color:var(--muted);cursor:pointer;font-family:DM Sans,sans-serif;">Clear</button>'
      + '</div></div>'
      + '<div id="'+id+'_panel_type" class="sec-hidden"><input type="text" id="'+id+'_typed" placeholder="Type full legal name" style="width:100%;border:none;border-bottom:2px solid var(--dark);background:transparent;font-size:18px;font-family:Georgia,serif;font-style:italic;color:var(--text);outline:none;padding:4px 0;box-sizing:border-box;"/>'
      + '<div style="font-size:10px;color:var(--muted);margin-top:6px;">Typing your name constitutes a legal electronic signature</div></div>'
      + '<div id="'+id+'_panel_wet" class="sec-hidden"><div style="font-size:11px;color:var(--muted);line-height:1.5;margin-bottom:8px;">Print this form and collect a wet signature, or use an e-signature service and attach the signed copy.</div>'
      + '<input type="text" id="'+id+'_wet_ref" placeholder="Reference # or e-sign envelope ID (optional)" style="width:100%;padding:6px 9px;border:1px solid var(--border);border-radius:5px;font-size:12px;font-family:DM Sans,sans-serif;background:var(--surface);color:var(--text);box-sizing:border-box;"/></div>'
      + '</div></div>';
  }
  h += sec('Signatures',
       '<div class="tic-grid-2">'
     +   fld('Owner Representative (name)', inp('sow_con_signame', st.sig_name, 'Housing Manager / ED'))
     +   fld('Owner Representative (title)', inp('sow_con_sigtitle', st.sig_title, 'Title'))
     +   fld('Contractor Signatory (name)', inp('sow_con_ctname', st.ct_signatory_name, 'Signing for the contractor'))
     +   fld('Contractor Signatory (title)', inp('sow_con_cttitle', st.ct_signatory_title, 'Title'))
     + '</div>'
     + '<div style="margin-top:12px;">' + sigPad('sow_ct_sig_owner','Owner Representative Signature') + sigPad('sow_ct_sig','Contractor Signature') + sigPad('sow_ct_initial','Contractor Initials (acknowledgement)') + '</div>');

  // Generate
  if(editable){
    h += '<div style="margin-top:6px;"><button type="button" class="btn btn-primary" onclick="_sowGenerateContract()">📄 Generate Contract</button>'
       + '<span class="txt-muted-xs" style="margin-left:10px;">Fills the standard Contractor Agreement PDF and files it to the unit’s documents.</span></div>';
  }

  host.innerHTML = h;

  // Wire live-state binding for the scalar fields (contract meta + price + sigs names)
  function bind(id, key){ var el=document.getElementById(id); if(el) el.addEventListener('input', function(){ st[key]=el.value; if(typeof _sowContractScheduleSave==='function') _sowContractScheduleSave(); }); }
  // Price fields also re-derive the Schedule B milestone grosses from their %
  // (live, in place) like the RFQ Contracting tab's _rfqRecalcPrices.
  function bindPrice(id, key){ var el=document.getElementById(id); if(el) el.addEventListener('input', function(){ st[key]=el.value; _sowConRecalcMilestonesFromPrice(); if(typeof _sowContractScheduleSave==='function') _sowContractScheduleSave(); }); }
  bind('sow_con_date','contract_date'); bind('sow_con_start','contract_start');
  bind('sow_con_subcompl','substantial_completion_date'); bind('sow_con_totcompl','total_completion_date');
  bind('sow_con_hbdays','holdback_days');
  bindPrice('sow_con_pmat','price_materials'); bindPrice('sow_con_plab','price_labour'); bindPrice('sow_con_peqp','price_equipment');
  bindPrice('sow_con_psub','price_subcontractors'); bindPrice('sow_con_poth','price_other'); bind('sow_con_lhours','labour_hours');
  bind('sow_con_signame','sig_name'); bind('sow_con_sigtitle','sig_title');
  bind('sow_con_ctname','ct_signatory_name'); bind('sow_con_cttitle','ct_signatory_title');

  // Wire signature pads
  if(typeof _initSigPad === 'function'){ ['sow_ct_sig_owner','sow_ct_sig','sow_ct_initial'].forEach(function(id){ try{ _initSigPad(id); }catch(e){} }); }
}

// Persist contract edits onto the saved record (mirrors _sowPersistPayments).
function _sowPersistContract(){
  if(!(_sowUnitId && window._sowEditingProjectNumber)) return;
  var sow = (typeof getSowByProjectNumber === 'function') ? getSowByProjectNumber(_sowUnitId, window._sowEditingProjectNumber) : null;
  if(!sow) return;
  _sowCollectContract(sow);
  if(typeof upsertSowInList === 'function') upsertSowInList(_sowUnitId, sow);
}
// Debounced persist of contract edits (only once the MR has been saved).
var _sowContractSaveTimer = null;
function _sowContractScheduleSave(){
  if(_sowContractSaveTimer) clearTimeout(_sowContractSaveTimer);
  _sowContractSaveTimer = setTimeout(function(){
    if(window._sowCurrentSowMeta) _sowPersistContract();
  }, 2500);
}

// ── Readiness gates (mirror rfq: hard block vs soft warn) ──
function _sowContractMissing(){
  var st = window._sowContractState || {};
  var out = [];
  if(!window._sowContractCt && !((document.getElementById('sow_contractor_id')||{}).value)) out.push('A contractor must be assigned (Overview tab → Assigned To)');
  var priceAny = ['price_materials','price_labour','price_equipment','price_subcontractors','price_other'].some(function(k){ return _sowConNum(st[k])>0; });
  if(!priceAny) out.push('A contract price (at least one Price Breakdown amount)');
  if(!st.contract_date) out.push('A contract date');
  if(!st.total_completion_date && !st.substantial_completion_date) out.push('A completion date');
  var msSum = _sowConRows('milestones').reduce(function(s,m){ return s + _sowConNum(m.gross); }, 0);
  var priceTot = ['price_materials','price_labour','price_equipment','price_subcontractors','price_other'].reduce(function(s,k){ return s + _sowConNum(st[k]); }, 0);
  if(msSum > priceTot + 0.01 && priceTot > 0) out.push('Milestone gross total ('+_sowConMoney(msSum)+') exceeds the contract price ('+_sowConMoney(priceTot)+')');
  return out;
}
function _sowContractMissingSigs(){
  var g = (typeof getSigDataURL==='function') ? getSigDataURL : function(){ return ''; };
  var out = [];
  if(!g('sow_ct_sig_owner')) out.push('Owner representative signature');
  if(!g('sow_ct_sig')) out.push('Contractor signature');
  if(!g('sow_ct_initial')) out.push('Contractor initials');
  return out;
}

// ── Generate the contract PDF (shared builder) ──
async function _sowGenerateContract(){
  if(!_sowContractEditable()){ if(typeof showToast==='function') showToast('Contracting is management-only.', {type:'error'}); return; }
  var st = window._sowContractState || {};
  var hard = _sowContractMissing();
  if(hard.length){
    if(typeof showAlert==='function') showAlert('Not ready to generate the contract:\n\n• ' + hard.join('\n• '));
    else if(typeof showToast==='function') showToast('Missing: ' + hard.join(', '), {type:'error'});
    return;
  }
  var soft = _sowContractMissingSigs();
  if(soft.length && typeof showConfirm==='function'){
    var ok = await showConfirm({ title:'Generate without all signatures?', message:'Missing: ' + soft.join(', ') + '. You can generate an unsigned copy to sign on paper.', confirmText:'Generate anyway' });
    if(!ok) return;
  }

  var ct = window._sowContractCt || {};
  var unitId = window._sowUnitId || '';
  var addr = (document.getElementById('sow_address')||{}).value || '';
  var tenant = (document.getElementById('sow_tenant_name')||{}).value || '';
  var numFmt = _sowConMoney;
  var pMat=_sowConNum(st.price_materials), pLab=_sowConNum(st.price_labour), pEqp=_sowConNum(st.price_equipment),
      pSubc=_sowConNum(st.price_subcontractors), pOth=_sowConNum(st.price_other);
  var pSub = pMat+pLab+pEqp+pSubc+pOth;
  st.holdback_release = (typeof _contractAddDays==='function') ? _contractAddDays(st.substantial_completion_date||st.total_completion_date||'', st.holdback_days) : '';

  var tokens = {
    rfqNumber:'', contractNumber: st.contract_number||'', contractDate: st.contract_date||'',
    propertyAddress: addr, sowReference: window._sowEditingProjectNumber || '',
    startDate: st.contract_start||'', substantialCompletionDate: st.substantial_completion_date||'', totalCompletionDate: st.total_completion_date||'',
    contractorLegalName: ct.name||'', contractorOperatingName: ct.name||'', contractorAddressLine1: ct.address||'', contractorAddressLine2:'',
    contractorGstHst: ct.hst||'', contractorWsib: ct.wsibNum||'', contractorPhone: ct.phone||'',
    contractorSignatoryName: st.ct_signatory_name || (ct.sigCt && ct.sigCt.name) || ct.name || '',
    contractorSignatoryTitle: st.ct_signatory_title || (ct.sigCt && ct.sigCt.title) || '',
    contractorSignatoryEmail: ct.email||'',
    contractPrice: numFmt(pSub), contractPriceExclTax: numFmt(pSub),
    nationName: (window.NATION_CONFIG && NATION_CONFIG.display_name) || 'Housing Authority',
    nationShort: (window.NATION_CONFIG && NATION_CONFIG.short) || '',
    clfnSignatoryName: st.sig_name||'', clfnSignatoryTitle: st.sig_title||'',
    sowSummary: st.sow_summary || (tenant ? ('Maintenance request at '+addr+' for '+tenant+'.') : ('Maintenance request at '+addr+'.')),
    sowDetailTable: (st.scope_detail_rows||[]).filter(function(r){return r.category||r.description;}).map(function(r,i){return (i+1)+'. '+[r.category,r.description,r.notes].filter(Boolean).join(' — ');}).join('\n') || '',
    materialsSpecifications: (st.materials_rows||[]).filter(function(r){return r.material||r.specification;}).map(function(r,i){return (i+1)+'. '+[r.material,r.specification,r.notes].filter(Boolean).join(' — ');}).join('\n') || '',
    exclusionsAssumptions: (st.exclusions_rows||[]).filter(function(r){return r.text;}).map(function(r,i){return (i+1)+'. '+r.text;}).join('\n') || '',
    clfnSuppliedItems: (st.clfn_supplied_rows||[]).filter(function(r){return r.item;}).map(function(r,i){return (i+1)+'. '+r.item;}).join('\n') || 'None',
    priceMaterials: numFmt(pMat), priceLabour: numFmt(pLab), priceEquipment: numFmt(pEqp), priceSubcontractors: numFmt(pSubc), priceOther: numFmt(pOth),
    priceSubtotal: numFmt(pSub), priceTax:'$0.00', priceTotalInclTax: numFmt(pSub),
    labourHours: st.labour_hours||'', holdbackRelease: numFmt(st.holdback_release)
  };
  var savedBody = (typeof getContractBody==='function') ? getContractBody('contractor_agreement') : '';
  try {
    var blob = await window.buildContractPdf(tokens, st, savedBody, numFmt, { sigIds:{ initial:'sow_ct_initial', owner:'sow_ct_sig_owner', contractor:'sow_ct_sig' } });
    var slug = (ct.name || 'contractor').replace(/[^A-Za-z0-9]+/g,'_').slice(0,40);
    var filename = ((window.NATION_CONFIG && NATION_CONFIG.short) || 'Nation') + '_Contract_' + (st.contract_number||'') + '_' + slug + '.pdf';
    // persist the contract state onto the saved record first
    if(window._sowCurrentSowMeta) { try{ _sowPersistContract(); }catch(e){} }
    var storePath = await window.fileContractPdf(blob, filename, {
      unitId: unitId,
      entities: [],
      savedMsg: 'Contract PDF saved — added to this request’s Documents'
    });
    // Also surface it on THIS Maintenance Request's Documents tab (entity 'sow'),
    // not just the unit's Documents. No re-upload — reuse the stored path.
    if(storePath && unitId){
      try { if(typeof sbSaveFileMeta==='function') await sbSaveFileMeta('sow', unitId, storePath, filename, blob.size, 'application/pdf'); } catch(e){ console.warn('[sow contract] sow file meta:', e); }
      if(Array.isArray(window._sowFiles)){
        window._sowFiles.push({ name: filename, type: 'application/pdf', size: blob.size, path: storePath, addedAt: new Date().toLocaleDateString() });
        if(typeof renderSowFiles==='function') renderSowFiles();
      }
    }
    if(typeof auditEntry==='function' && unitId){ auditEntry('SOW:'+unitId, 'sow_contract_generated', 'Contractor Agreement ' + (st.contract_number||'') + ' generated for ' + (ct.name||'contractor') + ' on ' + addr); }
    // Email the contract to the contractor (same as the RFQ process).
    try { await _sowEmailContract(blob, filename, ct, addr, st.contract_number || window._sowEditingProjectNumber || ''); } catch(e){ console.warn('[sow contract] email step:', e); }
  } catch(e){
    console.warn('[sow contract] generate failed:', e);
    if(typeof showToast==='function') showToast('Could not generate the contract. Check your connection and try again.', {type:'error'});
  }
}

// Base64-encode a Blob (strips the data: URI prefix) for email attachments.
function _sowBlobToBase64(blob){
  return new Promise(function(resolve, reject){
    try { var fr=new FileReader(); fr.onload=function(){ var s=String(fr.result||''); resolve(s.substring(s.indexOf(',')+1)); }; fr.onerror=function(){ reject(fr.error||new Error('read failed')); }; fr.readAsDataURL(blob); }
    catch(e){ reject(e); }
  });
}

// Email the generated contract PDF to the assigned contractor — mirrors the RFQ
// _rfqEmailContract flow: a confirm with a default-on recipient checkbox, then
// sendNotification with the PDF attached (from the nation mailbox).
async function _sowEmailContract(blob, filename, ct, addr, ref){
  try {
    if(typeof showConfirm !== 'function' || typeof sendNotification !== 'function') return;
    if(!ct || !ct.email){ if(typeof showToast==='function') showToast('No contractor email on file — contract not emailed.', {type:'error'}); return; }
    var _e = (typeof escapeHtml==='function') ? escapeHtml : function(s){ return String(s==null?'':s); };
    var r = await showConfirm({
      title:'Email Contract to Contractor?',
      message:'Send the generated contract (PDF attached) to the contractor? Uncheck to skip sending.',
      confirmText:'Send Contract', cancelText:'Cancel',
      checkbox:{ label:_e(ct.name||'Contractor')+' ('+_e(ct.email)+')', defaultChecked:true }
    });
    var ok  = (typeof r==='object' && r) ? r.ok : r;
    var snd = (typeof r==='object' && r) ? r.checked : false;
    if(!ok || !snd) return;
    var b64 = await _sowBlobToBase64(blob);
    var short = (window.NATION_CONFIG && NATION_CONFIG.short) || 'Housing';
    await sendNotification({
      to: ct.email, to_name: ct.name || '',
      subject: short + ' Housing — Contract: ' + (addr || ref),
      bodyHtml: '<p>Hello ' + _e(ct.name||'') + ',</p>'
        + '<p>Please find the attached contract for <strong>' + _e(addr||'the project') + '</strong>' + (ref ? (' (' + _e(ref) + ')') : '') + '.</p>'
        + '<p>Please review, sign, and return a copy. If you have any questions, reply to this email.</p>'
        + '<p>Thank you,<br/>' + _e(short) + ' Housing</p>',
      attachments: [{ name: filename, contentType: 'application/pdf', contentBytes: b64 }],
      event: 'sow_contract', entity_type: 'sow', entity_id: String(ref || '')
    });
    if(typeof showToast==='function') showToast('✓ Contract emailed to ' + (ct.name || 'contractor'), {type:'info'});
  } catch(e){
    console.warn('[sow contract] email failed:', e);
    if(typeof showToast==='function') showToast('Contract email failed: ' + (e && e.message || 'unknown error'), {type:'error'});
  }
}

// Copy the working contract state onto the SOW record on save.
function _sowCollectContract(data){
  if(!data) return;
  var st = window._sowContractState;
  if(st && (st.contract_number || st.contract_date || _sowConRows('milestones').length ||
            ['price_materials','price_labour','price_equipment','price_subcontractors','price_other'].some(function(k){ return _sowConNum(st[k])>0; }))){
    data.contract = JSON.parse(JSON.stringify(st));
  }
}

// Expose contracting handlers for inline onclick strings (file is not IIFE-
// wrapped so these are already global; kept explicit like the payments block).
window._sowRenderContracting = _sowRenderContracting;
window._sowInitContractState = _sowInitContractState;
window._sowCollectContract   = _sowCollectContract;
window._sowConRowField       = _sowConRowField;
window._sowConAddRow         = _sowConAddRow;
window._sowConRemoveRow      = _sowConRemoveRow;
window._sowConSubChange      = _sowConSubChange;
window._sowGenerateContract  = _sowGenerateContract;
window._sowConSetupSchedule  = _sowConSetupSchedule;
