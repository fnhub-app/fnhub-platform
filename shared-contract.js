// @ts-nocheck
/* ============================================================================
 * shared-contract.js - Shared Contractor Agreement PDF generation.
 *
 * Single source for the contract document produced by BOTH the RFQ Contracting
 * tab (rfq.js) and the Maintenance Request Contracting tab (housing-modals-sow
 * .js). The PDF builder was lifted verbatim from rfq.js's _rfqBuildContractPdf
 * (it only ever depended on shared helpers already loaded on every page:
 * loadJsPdf, _makePdfDoc, _fetchLogoForPdf, _parseHtmlToBlocks/_renderBlocksTo
 * Pdf, _substitutePlaceholders, getContractBody, getSigDataURL, sbUploadFile/
 * sbSaveFileMeta). The only page-specific bits - the three signature canvas ids
 * and the doc-library filing targets - are now parameters, so each page passes
 * its own. Load AFTER shared.js / shared-data.js / notifications.js.
 * ==========================================================================*/

// Date + N days -> YYYY-MM-DD (shared copy of rfq.js's _rfqAddDays so the
// holdback-release date computes on the SOW page too).
function _contractAddDays(dateStr, days) {
  if (!dateStr) return '';
  var d = new Date(dateStr + 'T12:00:00');
  if (isNaN(d.getTime())) return '';
  d.setDate(d.getDate() + (parseInt(days, 10) || 0));
  return d.toISOString().slice(0, 10);
}

// Build the Contractor Agreement PDF -> Blob. tokens = formatted display values
// fed to the template; d = the raw contract-data object (price_*, milestones[],
// *_rows, dates); savedBody = the CONTRACTS_DOCS_REGISTRY body html; numFmt = a
// currency formatter. opts.sigIds = {initial, owner, contractor} canvas ids
// (defaults are the RFQ ids, so rfq.js needs no opts).
window.buildContractPdf = async function(tokens, d, savedBody, numFmt, opts) {
      var _sig = (opts && opts.sigIds) || { initial: 'rfq_ct_initial', owner: 'rfq_sig', contractor: 'rfq_ct_sig' };
      await window.loadJsPdf();
      var logoDataUrl = (typeof _fetchLogoForPdf === 'function') ? await _fetchLogoForPdf() : null;
      var ctx = _makePdfDoc({
        nationName:     tokens.nationName,
        headerTitle:    'Contractor Agreement',
        headerSubtitle: [tokens.contractNumber, tokens.rfqNumber ? 'RFQ: ' + tokens.rfqNumber : ''].filter(Boolean).join('  |  '),
        logoDataUrl:    logoDataUrl
      });
      var pdf = ctx.pdf;

      var substituted = (typeof _substitutePlaceholders === 'function')
        ? _substitutePlaceholders(savedBody, tokens) : savedBody;
      // Defense against saved template overrides that still carry the old
      // Schedule B stub / Signatures block: cut the body at the first of those
      // headings so we don't duplicate the dynamic Schedule B + Signatures below.
      var _cut = substituted.search(/<h2>\s*(SCHEDULE B|SIGNATURES)/i);
      if (_cut >= 0) substituted = substituted.slice(0, _cut);
      if (typeof _parseHtmlToBlocks === 'function' && typeof _renderBlocksToPdf === 'function') {
        _renderBlocksToPdf(ctx, _parseHtmlToBlocks(substituted));
      }

      // Section heading that matches the body template's <h2> (12pt bold) so the
      // appended Schedule B / Signatures sections are consistent with the body
      // rather than the smaller uppercase sectionHeader style.
      function h2Heading(text) {
        ctx.needSpace(15); ctx.gap(2);
        pdf.setFont('helvetica', 'bold'); pdf.setFontSize(12); pdf.setTextColor(30);
        var hl = pdf.splitTextToSize(String(text), ctx.contentW);
        pdf.text(hl, ctx.marginL, ctx.y + 4);
        ctx.y += hl.length * 5.5 + 4;
        pdf.setTextColor(0);
      }

      // ── Contract Price Breakdown ──
      // Breaks the total bid out by the categories entered on the RFQ Contracting
      // tab's Price Breakdown (Materials / Labour / Equipment / Subcontractors,
      // + Other and Labour Hours). Not a lettered Schedule — "Schedule A" is
      // already the maintenance-request scope and "Schedule B" the milestones.
      // Skipped when no breakdown was entered.
      (function _priceBreakdown(){
        var core = [
          ['Materials',      parseFloat(d.price_materials)      || 0],
          ['Labour',         parseFloat(d.price_labour)         || 0],
          ['Equipment',      parseFloat(d.price_equipment)      || 0],
          ['Subcontractors', parseFloat(d.price_subcontractors) || 0]
        ];
        var other = parseFloat(d.price_other) || 0;
        var rows  = other > 0 ? core.concat([['Other', other]]) : core;
        var subtotal = rows.reduce(function(s, r){ return s + r[1]; }, 0);
        var lh = (d.labour_hours != null) ? String(d.labour_hours).trim() : '';
        var lhHas = lh !== '' && lh !== '0';
        if (subtotal <= 0 && !lhHas) return;   // nothing entered — skip the section

        h2Heading('Contract Price Breakdown');
        var cW = ctx.contentW, mL = ctx.marginL, amtX = mL + cW - 1;
        ctx.needSpace(8);
        pdf.setFont('helvetica', 'bold'); pdf.setFontSize(8); pdf.setTextColor(90);
        pdf.text('Category', mL, ctx.y + 3, { align: 'left' });
        pdf.text('Amount',   amtX, ctx.y + 3, { align: 'right' });
        ctx.y += 5; pdf.setDrawColor(210); pdf.setLineWidth(0.2); pdf.line(mL, ctx.y, mL + cW, ctx.y); ctx.y += 1;
        pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8.5); pdf.setTextColor(30);
        rows.forEach(function(r){
          ctx.needSpace(6);
          pdf.text(r[0], mL, ctx.y + 3, { align: 'left' });
          pdf.text(numFmt(r[1]) || '$0.00', amtX, ctx.y + 3, { align: 'right' });
          ctx.y += 5.5;
        });
        ctx.needSpace(7);
        pdf.setDrawColor(210); pdf.line(mL, ctx.y, mL + cW, ctx.y); ctx.y += 1;
        pdf.setFont('helvetica', 'bold'); pdf.setFontSize(8.5); pdf.setTextColor(20);
        pdf.text('Total Contract Price', mL, ctx.y + 3, { align: 'left' });
        pdf.text(numFmt(subtotal) || '$0.00', amtX, ctx.y + 3, { align: 'right' });
        ctx.y += 6; pdf.setTextColor(0);
        if (lhHas) {
          pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8.5); pdf.setTextColor(80);
          pdf.text('Estimated Labour Hours: ' + lh + ' hrs', mL, ctx.y + 3);
          ctx.y += 6; pdf.setTextColor(0);
        }
        ctx.gap(2);
      })();

      // ── Schedule B — Milestone Payment Schedule + holdback release terms ──
      var _ms = (d.milestones || []).filter(function(m){ return m && (m.name || parseFloat(m.gross)); });
      h2Heading('Schedule B — Milestone Payment Schedule');
      if (_ms.length) {
        var cW = ctx.contentW, mL = ctx.marginL;
        var cols = [
          { w:0.34, label:'Milestone',      align:'left'  },
          { w:0.10, label:'%',              align:'right' },
          { w:0.19, label:'Gross',          align:'right' },
          { w:0.19, label:'Holdback (10%)', align:'right' },
          { w:0.18, label:'Net Payable',    align:'right' }
        ];
        var xs = [], xacc = mL; cols.forEach(function(c){ xs.push(xacc); xacc += c.w * cW; });
        var cellX = function(i){ return cols[i].align === 'right' ? xs[i] + cols[i].w * cW - 1 : xs[i]; };
        ctx.needSpace(8);
        pdf.setFont('helvetica', 'bold'); pdf.setFontSize(8); pdf.setTextColor(90);
        cols.forEach(function(c, i){ pdf.text(c.label, cellX(i), ctx.y + 3, { align: c.align }); });
        ctx.y += 5; pdf.setDrawColor(210); pdf.setLineWidth(0.2); pdf.line(mL, ctx.y, mL + cW, ctx.y); ctx.y += 1;
        var sumG = 0, sumH = 0, sumN = 0;
        pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8.5); pdf.setTextColor(30);
        _ms.forEach(function(m){
          ctx.needSpace(6);
          var g = parseFloat(m.gross) || 0, h = parseFloat(m.holdback) || 0, n = parseFloat(m.net) || 0;
          sumG += g; sumH += h; sumN += n;
          var vals = [ m.name || '—', (m.pct ? (Math.round(parseFloat(m.pct) * 10) / 10 + '%') : ''), numFmt(g) || '$0.00', numFmt(h) || '$0.00', numFmt(n) || '$0.00' ];
          cols.forEach(function(c, i){ pdf.text(pdf.splitTextToSize(String(vals[i]), c.w * cW - 2), cellX(i), ctx.y + 3, { align: c.align }); });
          ctx.y += 5.5;
        });
        ctx.needSpace(7);
        pdf.setDrawColor(210); pdf.line(mL, ctx.y, mL + cW, ctx.y); ctx.y += 1;
        pdf.setFont('helvetica', 'bold'); pdf.setFontSize(8.5); pdf.setTextColor(20);
        pdf.text('Total', cellX(0), ctx.y + 3, { align: 'left' });
        pdf.text(numFmt(sumG) || '$0.00', cellX(2), ctx.y + 3, { align: 'right' });
        pdf.text(numFmt(sumH) || '$0.00', cellX(3), ctx.y + 3, { align: 'right' });
        pdf.text(numFmt(sumN) || '$0.00', cellX(4), ctx.y + 3, { align: 'right' });
        ctx.y += 6; pdf.setTextColor(0);
      } else {
        ctx.paragraph('Payment shall be made as a single lump sum upon Substantial Completion, subject to the holdback provisions below.', 9);
      }
      var _hbDays = d.holdback_days || '60';
      var _hbDate = (typeof _contractAddDays === 'function') ? _contractAddDays(d.substantial_completion_date || d.total_completion_date || '', _hbDays) : '';
      ctx.paragraph('Statutory holdback (10% of the value of each progress payment): ' + (numFmt(d.holdback_release) || '$0.00')
        + '. The holdback shall be released ' + _hbDays + ' days after the date of Substantial Completion'
        + (_hbDate ? ' (on or about ' + _hbDate + ')' : '')
        + ', following expiry of the applicable lien period under the Construction Act and provided no liens have been preserved.', 9);

      // ── Subcontractors + mandatory WSIB / liability clause ──
      (function _subcontractors(){
        var subs = (d.subcontractor_rows || []).filter(function(s){ return s && (s.name || s.contractorId || s.scope); });
        h2Heading('Subcontractors');
        if (subs.length) {
          var cW = ctx.contentW, mL = ctx.marginL;
          var cols = [
            { w:0.32, label:'Subcontractor' },
            { w:0.24, label:'Trade' },
            { w:0.44, label:'Scope of Work' }
          ];
          var xs = [], xacc = mL; cols.forEach(function(c){ xs.push(xacc); xacc += c.w * cW; });
          ctx.needSpace(8);
          pdf.setFont('helvetica','bold'); pdf.setFontSize(8); pdf.setTextColor(90);
          cols.forEach(function(c,i){ pdf.text(c.label, xs[i], ctx.y + 3); });
          ctx.y += 5; pdf.setDrawColor(210); pdf.setLineWidth(0.2); pdf.line(mL, ctx.y, mL + cW, ctx.y); ctx.y += 1;
          pdf.setFont('helvetica','normal'); pdf.setFontSize(8.5); pdf.setTextColor(30);
          subs.forEach(function(s){
            var vals = [ s.name || '—', s.trade || '', s.scope || '' ];
            var wrapped = cols.map(function(c,i){ return pdf.splitTextToSize(String(vals[i]||''), c.w*cW - 2); });
            var lines = wrapped.reduce(function(m,w){ return Math.max(m, w.length); }, 1);
            ctx.needSpace(lines * 4.6 + 2);
            cols.forEach(function(c,i){ pdf.text(wrapped[i], xs[i], ctx.y + 3); });
            ctx.y += lines * 4.6 + 1.5;
          });
          pdf.setTextColor(0); ctx.gap(2);
        } else {
          ctx.paragraph('The Contractor has not identified any subcontractors for this project as of the date of this Agreement. Any subcontractor subsequently engaged is subject to the requirements below.', 9);
        }
        ctx.paragraph('Subcontractor / Sub-Trade Requirements: Prior to commencing any work, every subcontractor or sub-trade engaged by the Contractor for this project must provide the Owner with (a) a valid WSIB Clearance Certificate confirming coverage in good standing, and (b) proof of Commercial General Liability insurance with a minimum limit of $2,000,000 per occurrence. The Contractor is fully responsible for the work, acts, and omissions of all subcontractors, and shall ensure each subcontractor complies with this Agreement, the Construction Act, and the Occupational Health and Safety Act (OHSA).', 9);
      })();

      // ── Contractor Acknowledgement (initialled) ──
      h2Heading('Contractor Acknowledgement');
      ctx.paragraph('By initialling below, the Contractor confirms that it is in good standing with WSIB, holds the insurance required under this Agreement, will comply with the Construction Act and the Occupational Health and Safety Act (OHSA), and accepts the prompt payment and adjudication framework set out in this Agreement.', 9);
      ctx.needSpace(18);
      pdf.setFont('helvetica', 'bold'); pdf.setFontSize(9); pdf.setTextColor(60);
      pdf.text('Contractor Initials:', ctx.marginL, ctx.y + 4);
      var _ix = ctx.marginL + 34;
      var _initData = (typeof getSigDataURL === 'function') ? getSigDataURL(_sig.initial) : '';
      if (_initData && _initData.indexOf('data:image/png;base64,') === 0) {
        try { pdf.addImage(_initData, 'PNG', _ix, ctx.y - 1, 24, 9); } catch(e) {}
      } else if (_initData && _initData.indexOf('typed:') === 0) {
        pdf.setFont('helvetica', 'italic'); pdf.setFontSize(13); pdf.setTextColor(20);
        pdf.text(_initData.replace('typed:', ''), _ix, ctx.y + 4);
      } else if (_initData && _initData.indexOf('wet:') === 0) {
        pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9); pdf.setTextColor(80);
        pdf.text('Initialled (on file)', _ix, ctx.y + 4);
      } else {
        pdf.setDrawColor(160); pdf.setLineWidth(0.4); pdf.line(_ix, ctx.y + 5, _ix + 30, ctx.y + 5);
      }
      pdf.setTextColor(0);
      ctx.y += 12;

      // Signatures section — keep the block together on a page, but let
      // h2Heading own the spacing so it matches the other section headers.
      if (typeof _docSigsHidden !== 'function' || !_docSigsHidden()) {
      ctx.needSpace(50);
      h2Heading('Signatures');

      function _addSigBlock(label, sigId, nameVal) {
        ctx.needSpace(24);
        pdf.setFont('helvetica', 'bold'); pdf.setFontSize(9); pdf.setTextColor(60);
        pdf.text(label, ctx.marginL, ctx.y + 3); ctx.y += 6;
        var sigData = (typeof getSigDataURL === 'function') ? getSigDataURL(sigId) : '';
        if (sigData && sigData.indexOf('data:image/png;base64,') === 0) {
          try { pdf.addImage(sigData, 'PNG', ctx.marginL, ctx.y, 50, 12); } catch(e) {}
          ctx.y += 14;
        } else if (sigData && sigData.indexOf('typed:') === 0) {
          pdf.setFont('helvetica', 'italic'); pdf.setFontSize(14); pdf.setTextColor(20);
          pdf.text(sigData.replace('typed:',''), ctx.marginL, ctx.y + 4); ctx.y += 8;
        } else if (sigData && sigData.indexOf('wet:') === 0) {
          pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9); pdf.setTextColor(80);
          var ref = sigData.replace('wet:','');
          pdf.text(ref === 'pending' ? 'Wet signature on file' : 'E-sign: '+ref, ctx.marginL, ctx.y + 4); ctx.y += 8;
        } else {
          pdf.setDrawColor(160); pdf.setLineWidth(0.4);
          pdf.line(ctx.marginL, ctx.y + 8, ctx.marginL + 70, ctx.y + 8); ctx.y += 11;
        }
        pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8.5); pdf.setTextColor(80);
        if (nameVal) { pdf.text(nameVal, ctx.marginL, ctx.y + 3); ctx.y += 5; }
        pdf.setTextColor(0);
        ctx.y += 3;
      }

      _addSigBlock('Owner Representative', _sig.owner,         tokens.clfnSignatoryName + (tokens.clfnSignatoryTitle ? ', ' + tokens.clfnSignatoryTitle : ''));
      _addSigBlock('Contractor',           _sig.contractor,       tokens.contractorSignatoryName + (tokens.contractorSignatoryTitle ? ', ' + tokens.contractorSignatoryTitle : ''));
      }

      var base64 = ctx.finish();
      var binStr = atob(base64);
      var arr = new Uint8Array(binStr.length);
      for (var bi = 0; bi < binStr.length; bi++) arr[bi] = binStr.charCodeAt(bi);
      return new Blob([arr], {type:'application/pdf'});
};

// Download + file the contract PDF. Always files to the unit's docs (entity
// 'tenant' + unitId) so it shows on the inventory unit card; opts.entities adds
// extra file-meta rows (e.g. the RFQ or the SOW). opts.onFiled(storePath) runs
// after a successful upload (doc-lib refreshes).
window.fileContractPdf = async function(blob, filename, opts) {
  opts = opts || {};
  var dlUrl = URL.createObjectURL(blob);
  var dlLink = document.createElement('a');
  dlLink.href = dlUrl; dlLink.download = filename; dlLink.click();
  setTimeout(function(){ URL.revokeObjectURL(dlUrl); }, 3000);

  var unitId = opts.unitId;
  var entities = opts.entities || [];
  var extra = 0, storePath = '';
  if (unitId && typeof window.sbUploadFile === 'function') {
    try {
      storePath = 'tenants/' + unitId + '/' + Date.now() + '_' + filename;
      await window.sbUploadFile(storePath, blob);
      if (typeof window.sbSaveFileMeta === 'function') {
        await window.sbSaveFileMeta('tenant', String(unitId), storePath, filename, blob.size, 'application/pdf');
        for (var i = 0; i < entities.length; i++) {
          if (entities[i] && entities[i].id) {
            await window.sbSaveFileMeta(entities[i].type, String(entities[i].id), storePath, filename, blob.size, 'application/pdf');
            extra++;
          }
        }
      }
      if (typeof opts.onFiled === 'function') { try { opts.onFiled(storePath); } catch(e){} }
    } catch(e) { console.warn('[contract] document library upload failed:', e); }
  }
  if (typeof showToast === 'function') {
    showToast(opts.savedMsg || (extra
      ? 'Contract PDF saved - added to documents'
      : 'Contract PDF saved - also added to unit documents'), { type: 'info' });
  }
  return storePath;
};

// Next CON-YYYY-NNNN. Scans BOTH the RFQ cache (rfq.data.contract_number) and
// the SOW cache (sow.contract.contract_number under each unit's .sows[]) so RFQ
// and MR contracts never collide on a number. Client-side max-scan (same model
// as the old rfq.js generateContractNumber).
window.nextContractNumber = function() {
  var year = new Date().getFullYear();
  var prefix = 'CON-' + year + '-';
  var maxSeq = 0;
  function consider(cn) {
    if (cn && String(cn).indexOf(prefix) === 0) {
      var seq = parseInt(String(cn).slice(prefix.length), 10);
      if (!isNaN(seq) && seq > maxSeq) maxSeq = seq;
    }
  }
  var rc = window._rfqCache || {};
  Object.keys(rc).forEach(function(id){ var r = rc[id]; consider(r && r.data && r.data.contract_number); });
  var sc = window._sowCache || {};
  Object.keys(sc).forEach(function(uid){
    var w = sc[uid]; var sows = (w && w.sows) || (Array.isArray(w) ? w : []);
    sows.forEach(function(s){ consider(s && s.contract && s.contract.contract_number); });
  });
  return prefix + String(maxSeq + 1).padStart(4, '0');
};
