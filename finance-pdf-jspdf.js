/* ============================================================================
 * finance-pdf-jspdf.js -- jsPDF finance documents (finance PDF migration;
 * see docs/FINANCE-JSPDF-MIGRATION.md).
 *
 * Replaces HTML print-window finance docs with jsPDF so each can be DOWNLOADED
 * as a real PDF or EMAILED to the tenant (print windows can't hand you the
 * bytes). Covers: statement of account (Phase 1), transaction voucher / payment
 * receipt (Phase 1b), and invoice (Phase 2). All share headerFooter(doc,title)
 * for an identical per-nation branded header -- logo + name + contact from
 * NATION_CONFIG/theme, accent from the runtime _themeAccentHex() helpers (jsPDF
 * takes hex strings; CSS var() would not work here).
 *
 * The voucher modal (modalVoucher) hosts both vouchers and invoices, so its
 * Download/Email buttons call buildDoc(), which dispatches on txn.invoiceBalance.
 * ==========================================================================*/
(function () {
  'use strict';

  function _load(cb, onerr) {
    // Delegates to the shared lazy-loader in shared.js (single implementation).
    window.loadJsPdf({ autotable: true }).then(function () { cb(); }, function () { (onerr || function () {})(); });
  }

  function accent() { return (typeof window._themeAccentHex === 'function') ? window._themeAccentHex() : '#9A4A1F'; }
  function money(n) { return (typeof fmt === 'function') ? fmt(n) : ('$' + (Number(n) || 0).toFixed(2)); }
  function nationLogo() {
    var s = null;
    try { s = sessionStorage.getItem('clfn_logo_cache'); } catch (e) {}
    var logo = s || (window._appSettings && _appSettings.theme && _appSettings.theme.logo)
      || (window.NATION_CONFIG && NATION_CONFIG.logo) || window.CLFN_LOGO_DATA_URL || '';
    // jsPDF addImage can't rasterize SVG -- only use PNG/JPEG data URLs.
    return /^data:image\/(png|jpe?g)/i.test(logo || '') ? logo : '';
  }

  // hex '#rrggbb' -> [r,g,b] for jsPDF setter functions.
  function rgb(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return [0, 0, 0];
    var n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function onAccentRgb() { return (typeof window._themeOnAccentHex === 'function') ? rgb(window._themeOnAccentHex()) : [255, 255, 255]; }

  // Shared branded header + footer, bound to one doc. Reused by every finance PDF
  // so the nation header/footer stay identical across documents.
  function headerFooter(doc, title) {
    var pageW = doc.internal.pageSize.getWidth(), M = 14, aRGB = rgb(accent()), logo = nationLogo();
    var nc = window.NATION_CONFIG || {};
    var nationName = nc.display_name || nc.short || 'Housing';
    var contact = [nc.mailing_address, nc.phone, (nc.email || nc.housing_email)].filter(Boolean).join('   ');
    var generatedOn = new Date().toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric' });
    return {
      M: M, pageW: pageW, aRGB: aRGB,
      header: function () {
        var y = 12;
        if (logo) { try { doc.addImage(logo, 'PNG', M, y - 2, 16, 16); } catch (e) {} }
        var tx = logo ? M + 20 : M;
        doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(20, 20, 20);
        doc.text(String(nationName).toUpperCase(), tx, y + 2);
        doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(110, 110, 110);
        if (contact) doc.text(String(contact), tx, y + 6.5, { maxWidth: pageW / 2 });
        doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(20, 20, 20);
        doc.text(String(title), pageW - M, y + 1, { align: 'right' });
        doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(140, 140, 140);
        doc.text('Generated: ' + generatedOn, pageW - M, y + 6, { align: 'right' });
        doc.setDrawColor(aRGB[0], aRGB[1], aRGB[2]); doc.setLineWidth(0.7); doc.line(M, y + 12, pageW - M, y + 12);
      },
      footer: function (data) {
        var ph = doc.internal.pageSize.getHeight();
        doc.setFontSize(8); doc.setTextColor(140, 140, 140); doc.setFont('helvetica', 'normal');
        doc.text('CONFIDENTIAL', M, ph - 8);
        doc.text('Page ' + data.pageNumber, pageW - M, ph - 8, { align: 'right' });
      }
    };
  }

  // Build the statement jsPDF doc for a tenant id. Returns { doc, tenant } or null.
  function buildStatement(tid) {
    var t = (typeof getTenant === 'function') ? getTenant(tid) : null;
    if (!t) return null;
    var d = getData();
    var totals = (typeof calcAllTotals === 'function') ? calcAllTotals(d) : {};
    var v = totals[tid] || {};
    var nc = window.NATION_CONFIG || {};
    var today = new Date();
    var monthYM = today.toISOString().slice(0, 7);
    var monthLabel = today.toLocaleDateString('en-CA', { month: 'long', year: 'numeric' });
    var generatedOn = today.toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric' });

    var rentOwing = Math.max(0, v.rent || 0);
    var arrOwing = Math.max(0, v.arrangement || 0);
    var approvedLoans = (d.loanList || []).filter(function (l) { return l.tenantId === tid && l.status === 'approved'; });
    var loanTotal = approvedLoans.reduce(function (s, l) {
      var paid = (d.loanPayments || []).filter(function (p) { return p.loanId === l.id && p.status !== 'reversed'; }).reduce(function (a, p) { return a + p.amount; }, 0);
      return s + Math.max(0, (l.principal || 0) - paid);
    }, 0);
    var grandTotal = rentOwing + arrOwing + loanTotal;

    var charges = (d.rentLedger || []).filter(function (r) {
      return r.tenantId === tid && (r.charge || 0) > 0 && r.status !== 'reversed' && r.status !== 'paid';
    }).slice().sort(function (a, b) { return (a.date || '').localeCompare(b.date || ''); });
    var chargeTotal = charges.reduce(function (s, r) { return s + (r.charge || 0); }, 0);

    var pays = [];
    (d.rentLedger || []).filter(function (r) { return r.tenantId === tid && (r.payment || 0) > 0 && r.status !== 'reversed' && (r.date || '').slice(0, 7) === monthYM; })
      .forEach(function (r) { pays.push({ date: r.date, ledger: 'Rent', desc: r.desc || 'Rent Payment', method: r.method || '', amount: r.payment || 0 }); });
    (d.arrPayments || []).forEach(function (p) {
      var a = (d.arrangements || []).find(function (x) { return x.id === p.arrId; });
      if (a && a.tenantId === tid && p.status !== 'reversed' && (p.date || '').slice(0, 7) === monthYM) pays.push({ date: p.date, ledger: 'Arrangement', desc: 'Arrangement Payment' + (a.ref ? ' - ' + a.ref : ''), method: p.method || '', amount: p.amount || 0 });
    });
    (d.loanPayments || []).forEach(function (p) {
      var l = (d.loanList || []).find(function (x) { return x.id === p.loanId; });
      if (l && l.tenantId === tid && p.status !== 'reversed' && (p.date || '').slice(0, 7) === monthYM) pays.push({ date: p.date, ledger: 'Loan', desc: 'Loan Payment' + (l.type ? ' - ' + l.type : ''), method: p.method || '', amount: p.amount || 0 });
    });
    pays.sort(function (a, b) { return (a.date || '').localeCompare(b.date || ''); });
    var payTotal = pays.reduce(function (s, p) { return s + p.amount; }, 0);

    var jsPDF = window.jspdf.jsPDF;
    var doc = new jsPDF({ unit: 'mm', format: 'letter' });
    var hf = headerFooter(doc, 'Statement of Account');
    var pageW = hf.pageW, M = hf.M, aRGB = hf.aRGB;

    // Tenant block + Total Owing summary (drawn once, above the first table).
    var startY = 34;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(14); doc.setTextColor(20, 20, 20);
    doc.text(String((typeof tenantName === 'function') ? tenantName(t) : (t.name || '')), M, startY);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(100, 100, 100);
    doc.text([t.unit, (t.type || '').replace(/-/g, ' ')].filter(Boolean).join('  -  '), M, startY + 5.5);
    // Total Owing box (accent), right-aligned.
    var boxW = 62, boxX = pageW - M - boxW, boxY = startY - 6, boxH = 16;
    doc.setFillColor(aRGB[0], aRGB[1], aRGB[2]); doc.rect(boxX, boxY, boxW, boxH, 'F');
    var onAcc = (typeof window._themeOnAccentHex === 'function') ? rgb(window._themeOnAccentHex()) : [255, 255, 255];
    doc.setTextColor(onAcc[0], onAcc[1], onAcc[2]);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.text('TOTAL OWING', boxX + boxW / 2, boxY + 5, { align: 'center' });
    doc.setFont('helvetica', 'bold'); doc.setFontSize(15); doc.text(money(grandTotal), boxX + boxW / 2, boxY + 12, { align: 'center' });
    doc.setFontSize(8); doc.setTextColor(120, 120, 120); doc.setFont('helvetica', 'normal');
    doc.text('Rent ' + money(rentOwing) + '   Arrangements ' + money(arrOwing) + '   Loans ' + money(loanTotal), M, startY + 12);

    var tableStart = startY + 18;

    // Outstanding charges.
    doc.autoTable({
      startY: tableStart, margin: { top: 30, left: M, right: M },
      head: [['Date', 'Outstanding Invoices & Charges', 'Amount']],
      body: charges.length ? charges.map(function (r) { return [r.date || '', r.desc || '', money(r.charge || 0)]; })
        : [[{ content: 'No outstanding charges.', colSpan: 3, styles: { textColor: [150, 150, 150], fontStyle: 'italic' } }]],
      foot: charges.length ? [['', 'Total Outstanding', money(chargeTotal)]] : null,
      styles: { fontSize: 9, cellPadding: 2 },
      headStyles: { fillColor: aRGB, textColor: (typeof window._themeOnAccentHex === 'function') ? rgb(window._themeOnAccentHex()) : [255, 255, 255], fontStyle: 'bold' },
      footStyles: { fillColor: [245, 245, 245], textColor: [20, 20, 20], fontStyle: 'bold' },
      columnStyles: { 0: { cellWidth: 26 }, 2: { halign: 'right', cellWidth: 30 } },
      didDrawPage: function (data) { hf.header(); hf.footer(data); }
    });

    // Payments this month.
    doc.autoTable({
      startY: doc.lastAutoTable.finalY + 8, margin: { top: 30, left: M, right: M },
      head: [['Date', 'Ledger', 'Payments - ' + monthLabel, 'Method', 'Amount']],
      body: pays.length ? pays.map(function (p) { return [p.date || '', p.ledger, p.desc, p.method, money(p.amount)]; })
        : [[{ content: 'No payments recorded for ' + monthLabel + '.', colSpan: 5, styles: { textColor: [150, 150, 150], fontStyle: 'italic' } }]],
      foot: pays.length ? [['', '', '', 'Total Payments', money(payTotal)]] : null,
      styles: { fontSize: 9, cellPadding: 2 },
      headStyles: { fillColor: aRGB, textColor: (typeof window._themeOnAccentHex === 'function') ? rgb(window._themeOnAccentHex()) : [255, 255, 255], fontStyle: 'bold' },
      footStyles: { fillColor: [245, 245, 245], textColor: [20, 20, 20], fontStyle: 'bold' },
      columnStyles: { 0: { cellWidth: 24 }, 1: { cellWidth: 24 }, 4: { halign: 'right', cellWidth: 26 } },
      didDrawPage: function (data) { hf.header(); hf.footer(data); }
    });

    return { doc: doc, tenant: t, grandTotal: grandTotal, monthLabel: monthLabel };
  }

  function fileName(t) {
    var nm = ((typeof tenantName === 'function') ? tenantName(t) : (t.name || 'tenant')).replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '');
    return 'Statement-' + nm + '-' + new Date().toISOString().slice(0, 10) + '.pdf';
  }

  // Download the current statement tenant's PDF.
  window.finStatementDownload = function () {
    var tid = window._stmtTid; if (!tid) { if (typeof toast === 'function') toast('Open a tenant statement first'); return; }
    _load(function () {
      var r = buildStatement(tid);
      if (!r) { if (typeof toast === 'function') toast('Could not build the statement'); return; }
      r.doc.save(fileName(r.tenant));
    }, function () { if (typeof toast === 'function') toast('Could not load the PDF engine (offline?)'); });
  };

  // Email the current statement to the tenant (PDF attachment) via the nation's
  // own email provider through the existing send-notification pipeline.
  window.finStatementEmail = function () {
    var tid = window._stmtTid; if (!tid) { if (typeof toast === 'function') toast('Open a tenant statement first'); return; }
    _load(function () {
      var r = buildStatement(tid);
      if (!r) { if (typeof toast === 'function') toast('Could not build the statement'); return; }
      var email = (r.tenant.email || '').trim();
      if (!email) { if (typeof toast === 'function') toast('No email on file for this tenant'); return; }
      var b64 = '';
      try { b64 = r.doc.output('datauristring').split(',')[1]; } catch (e) { if (typeof toast === 'function') toast('Could not render the PDF'); return; }
      var nm = (typeof tenantName === 'function') ? tenantName(r.tenant) : (r.tenant.name || '');
      var nationName = (window.NATION_CONFIG && NATION_CONFIG.display_name) || 'Housing';
      if (typeof window.sendNotification !== 'function') { if (typeof toast === 'function') toast('Email is not available on this page'); return; }
      window.sendNotification({
        to: email, to_name: nm,
        subject: 'Your ' + nationName + ' statement of account (' + r.monthLabel + ')',
        bodyHtml: '<p>Hello ' + nm + ',</p><p>Please find your current statement of account attached. Your total owing is <b>' + money(r.grandTotal) + '</b> as of ' + new Date().toLocaleDateString('en-CA') + '.</p><p>If you have questions about your account, please contact the housing office.</p>',
        attachments: [{ name: fileName(r.tenant), contentType: 'application/pdf', contentBytes: b64 }]
      }).then(function () {
        if (typeof toast === 'function') toast('Statement emailed to ' + email);
        if (typeof auditEntry === 'function') auditEntry(tid, 'statement_emailed', 'Statement of account emailed to ' + email, window.currentRole || 'staff');
      }).catch(function () { if (typeof toast === 'function') toast('Could not send the email'); });
    }, function () { if (typeof toast === 'function') toast('Could not load the PDF engine (offline?)'); });
  };

  // ---- Transaction voucher / receipt ---------------------------------------
  // Build from the currently-open voucher (currentVoucherData). Returns { doc, tenant }.
  function buildVoucher(txn) {
    if (!txn) return null;
    var d = getData();
    var t = (typeof getTenant === 'function') ? getTenant(txn.tenantId) : null;
    var isPayment = (txn.payment || 0) > 0;
    var amount = isPayment ? (txn.payment || 0) : (txn.charge || 0);
    var ledgerLabels = { rent: 'Rent', arrangement: 'Payment Arrangement', loan: 'Loan', combined: 'Rent + Arrangement + Loan', journal: 'Journal Entry', overpayment: 'Credit / Overpayment' };
    var method = (typeof methodLabel === 'function') ? methodLabel(txn.method) : (txn.method || '');
    var vref = txn.id ? ('VCH-' + String(txn.id).slice(-8)) : ('VCH-' + Date.now().toString().slice(-8));
    var nm = t ? ((typeof tenantName === 'function') ? tenantName(t) : (t.name || '')) : (txn.tenantId || '');
    var notes = ((document.getElementById('voucher-notes') || {}).value || '').trim();

    var jsPDF = window.jspdf.jsPDF;
    var doc = new jsPDF({ unit: 'mm', format: 'letter' });
    var title = isPayment ? 'Payment Receipt' : 'Transaction Voucher';
    var hf = headerFooter(doc, title);
    var pageW = hf.pageW, M = hf.M, aRGB = hf.aRGB;

    var startY = 34;
    // Voucher meta.
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(120, 120, 120);
    doc.text('VOUCHER NO.', M, startY);
    doc.text('BILLED TO', pageW / 2, startY);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(20, 20, 20);
    doc.text(vref, M, startY + 6);
    doc.text(String(nm), pageW / 2, startY + 6);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(100, 100, 100);
    doc.text('Date: ' + (txn.date || ''), M, startY + 12);
    if (t && t.unit) doc.text(String(t.unit), pageW / 2, startY + 12);

    // Detail rows.
    var rows = [
      ['Ledger', ledgerLabels[txn.ledger] || txn.ledger || ''],
      ['Description', txn.desc || ''],
      ['Payment Method', method],
      ['Status', txn.status || '']
    ];
    if ((txn.charge || 0) > 0) rows.push(['Charge / Debit', money(txn.charge)]);
    if ((txn.payment || 0) > 0) rows.push(['Payment / Credit', money(txn.payment)]);
    doc.autoTable({
      startY: startY + 18, margin: { top: 30, left: M, right: M },
      body: rows,
      styles: { fontSize: 10, cellPadding: 2.5 },
      columnStyles: { 0: { fontStyle: 'bold', cellWidth: 45, textColor: [90, 90, 90] }, 1: { textColor: [20, 20, 20] } },
      theme: 'plain',
      didDrawPage: function (data) { hf.header(); hf.footer(data); }
    });

    // Amount box (accent).
    var y = doc.lastAutoTable.finalY + 6, boxH = 16;
    doc.setFillColor(aRGB[0], aRGB[1], aRGB[2]); doc.rect(M, y, pageW - 2 * M, boxH, 'F');
    var oa = onAccentRgb(); doc.setTextColor(oa[0], oa[1], oa[2]);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
    doc.text(isPayment ? 'AMOUNT PAID' : 'AMOUNT CHARGED', M + 5, y + 10);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(18);
    doc.text(money(amount), pageW - M - 5, y + 11, { align: 'right' });

    if (notes) {
      y = y + boxH + 8; doc.setTextColor(60, 60, 60); doc.setFont('helvetica', 'bold'); doc.setFontSize(9);
      doc.text('Notes', M, y); doc.setFont('helvetica', 'normal');
      doc.text(doc.splitTextToSize(notes, pageW - 2 * M), M, y + 5);
    }

    // Signature lines.
    var sy = doc.internal.pageSize.getHeight() - 34, colW = (pageW - 2 * M - 12) / 2;
    doc.setDrawColor(120, 120, 120); doc.setLineWidth(0.3);
    doc.line(M, sy, M + colW, sy); doc.line(pageW - M - colW, sy, pageW - M, sy);
    doc.setFontSize(8); doc.setTextColor(120, 120, 120);
    doc.text('Received by (tenant)', M, sy + 4);
    doc.text('Authorized by', pageW - M - colW, sy + 4);

    return { doc: doc, tenant: t, amount: amount, vref: vref, title: title };
  }

  function voucherFileName(r) {
    var nm = (r.tenant ? ((typeof tenantName === 'function') ? tenantName(r.tenant) : (r.tenant.name || 'tenant')) : 'tenant').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '');
    return r.vref + '-' + nm + '.pdf';
  }

  // ---- Invoice (a rent-ledger charge with a balance + applied payments) -----
  function buildInvoice(txn) {
    if (!txn) return null;
    var t = (typeof getTenant === 'function') ? getTenant(txn.tenantId) : null;
    var nm = t ? ((typeof tenantName === 'function') ? tenantName(t) : (t.name || '')) : (txn.tenantId || '');
    var vref = txn.ref || ('INV-' + String(txn.id || '').slice(-6).toUpperCase());
    var payList = (txn.payments || []);
    var paid = payList.reduce(function (s, p) { return s + (p.amount || 0); }, 0);
    var balance = (txn.invoiceBalance != null) ? txn.invoiceBalance : Math.max(0, (txn.charge || 0) - paid);
    var isPaid = balance <= 0.005;
    var isPartial = !isPaid && payList.length > 0;
    var statusLabel = isPaid ? 'PAID IN FULL' : isPartial ? 'PARTIALLY PAID' : 'UNPAID';
    var notes = ((document.getElementById('voucher-notes') || {}).value || '').trim();

    var jsPDF = window.jspdf.jsPDF;
    var doc = new jsPDF({ unit: 'mm', format: 'letter' });
    var hf = headerFooter(doc, 'Invoice');
    var pageW = hf.pageW, M = hf.M, aRGB = hf.aRGB;

    var startY = 34;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(120, 120, 120);
    doc.text('INVOICE NO.', M, startY);
    doc.text('BILL TO', pageW / 2, startY);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(20, 20, 20);
    doc.text(vref, M, startY + 6);
    doc.text(String(nm), pageW / 2, startY + 6);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(100, 100, 100);
    doc.text('Invoice date: ' + (txn.date || ''), M, startY + 12);
    if (t && t.unit) doc.text(String(t.unit), pageW / 2, startY + 12);

    // Charge line(s).
    doc.autoTable({
      startY: startY + 18, margin: { top: 30, left: M, right: M },
      head: [['Description', 'Amount']],
      body: [[txn.desc || 'Charge', money(txn.charge || 0)]],
      foot: (function () {
        var f = [['Total Charged', money(txn.charge || 0)]];
        if (paid > 0.005) f.push(['Total Paid', money(paid)]);
        f.push([{ content: 'Balance Owing', styles: { fontStyle: 'bold' } }, { content: money(balance), styles: { fontStyle: 'bold' } }]);
        return f;
      })(),
      styles: { fontSize: 10, cellPadding: 2.5 },
      headStyles: { fillColor: aRGB, textColor: onAccentRgb(), fontStyle: 'bold' },
      footStyles: { fillColor: [245, 245, 245], textColor: [20, 20, 20] },
      columnStyles: { 1: { halign: 'right', cellWidth: 40 } },
      didDrawPage: function (data) { hf.header(); hf.footer(data); }
    });

    // Payments applied.
    if (payList.length) {
      doc.autoTable({
        startY: doc.lastAutoTable.finalY + 6, margin: { top: 30, left: M, right: M },
        head: [['Date', 'Method', 'Payment Applied']],
        body: payList.map(function (p) { return [p.date || '', (typeof methodLabel === 'function') ? methodLabel(p.method) : (p.method || ''), money(p.amount || 0)]; }),
        styles: { fontSize: 9, cellPadding: 2 },
        headStyles: { fillColor: [80, 80, 80], textColor: [255, 255, 255], fontStyle: 'bold' },
        columnStyles: { 2: { halign: 'right', cellWidth: 40 } },
        didDrawPage: function (data) { hf.header(); hf.footer(data); }
      });
    }

    // Status + Amount Due box (accent).
    var y = doc.lastAutoTable.finalY + 6, boxH = 16;
    doc.setFillColor(aRGB[0], aRGB[1], aRGB[2]); doc.rect(M, y, pageW - 2 * M, boxH, 'F');
    var oa = onAccentRgb(); doc.setTextColor(oa[0], oa[1], oa[2]);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
    doc.text(statusLabel, M + 5, y + 10);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(18);
    doc.text((isPaid ? money(txn.charge || 0) : money(balance) + ' due'), pageW - M - 5, y + 11, { align: 'right' });

    if (notes) {
      y = y + boxH + 8; doc.setTextColor(60, 60, 60); doc.setFont('helvetica', 'bold'); doc.setFontSize(9);
      doc.text('Notes', M, y); doc.setFont('helvetica', 'normal');
      doc.text(doc.splitTextToSize(notes, pageW - 2 * M), M, y + 5);
    }

    return { doc: doc, tenant: t, amount: (isPaid ? (txn.charge || 0) : balance), vref: vref, title: 'Invoice' };
  }

  // Pick the right document for the currently-open modal txn.
  function buildDoc(txn) {
    return (txn && txn.invoiceBalance !== undefined) ? buildInvoice(txn) : buildVoucher(txn);
  }

  // ---- Batch invoice worksheet ---------------------------------------------
  // The tenants pending their monthly rent invoice (same rule as renderBatchList).
  window.finBatchWorksheetDownload = function () {
    _load(function () {
      var d = getData();
      var now = new Date();
      var months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
      var monthLabel = months[now.getMonth()] + ' ' + now.getFullYear();
      var ym = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
      var pending = (d.tenants || []).filter(function (t) {
        var already = (d.rentLedger || []).some(function (r) { return r.tenantId === t.id && r.type === 'invoice' && (r.date || '').slice(0, 7) === ym && r.status !== 'reversed'; });
        return !already && t.active !== false && (t.rent || 0) > 0;
      });
      if (!pending.length) { if (typeof toast === 'function') toast('No pending invoices for ' + monthLabel); return; }

      var jsPDF = window.jspdf.jsPDF;
      var doc = new jsPDF({ unit: 'mm', format: 'letter' });
      var hf = headerFooter(doc, 'Batch Invoice Worksheet');
      var pageW = hf.pageW, M = hf.M, aRGB = hf.aRGB;
      doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(90, 90, 90);
      doc.text('Tenants to be invoiced for ' + monthLabel + '  (' + pending.length + ')', M, 34);
      var total = pending.reduce(function (s, t) { return s + (t.rent || 0); }, 0);

      doc.autoTable({
        startY: 38, margin: { top: 30, left: M, right: M },
        head: [['#', 'Tenant', 'Unit', 'Monthly Rent']],
        body: pending.map(function (t, i) { return [String(i + 1), (typeof tenantName === 'function') ? tenantName(t) : (t.name || ''), t.unit || '', money(t.rent || 0)]; }),
        foot: [['', '', 'Total', money(total)]],
        styles: { fontSize: 9, cellPadding: 2 },
        headStyles: { fillColor: aRGB, textColor: onAccentRgb(), fontStyle: 'bold' },
        footStyles: { fillColor: [245, 245, 245], textColor: [20, 20, 20], fontStyle: 'bold' },
        columnStyles: { 0: { cellWidth: 12 }, 3: { halign: 'right', cellWidth: 34 } },
        didDrawPage: function (data) { hf.header(); hf.footer(data); }
      });
      doc.save('Batch-Invoice-Worksheet-' + ym + '.pdf');
    }, function () { if (typeof toast === 'function') toast('Could not load the PDF engine (offline?)'); });
  };

  // ---- Batch statements (one statement per selected tenant, one PDF) --------
  window.finBatchStatementsDownload = function () {
    var checked = document.querySelectorAll('.rs-chk:checked');
    if (!checked.length) { if (typeof toast === 'function') toast('No tenants selected.'); return; }
    var tids = []; for (var i = 0; i < checked.length; i++) tids.push(checked[i].getAttribute('data-tid'));
    _load(function () {
      var d = getData();
      var totals = (typeof calcAllTotals === 'function') ? calcAllTotals(d) : {};
      var allTxns = (typeof getAllTransactions === 'function') ? getAllTransactions() : [];
      var jsPDF = window.jspdf.jsPDF;
      var doc = new jsPDF({ unit: 'mm', format: 'letter' });
      var hf = headerFooter(doc, 'Statement of Account');
      var pageW = hf.pageW, M = hf.M, aRGB = hf.aRGB;
      var rendered = 0;
      for (var j = 0; j < tids.length; j++) {
        var tid = tids[j];
        var t = (typeof getTenant === 'function') ? getTenant(tid) : null;
        if (!t) continue;
        if (rendered > 0) doc.addPage();
        rendered++;
        var v = totals[tid] || {}, rentOwe = v.rent || 0, loanOwe = v.loan || 0, arrOwe = v.arrangement || 0, grand = rentOwe + loanOwe + arrOwe;
        var startY = 34;
        doc.setFont('helvetica', 'bold'); doc.setFontSize(14); doc.setTextColor(20, 20, 20);
        doc.text(String((typeof tenantName === 'function') ? tenantName(t) : (t.name || '')), M, startY);
        doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(100, 100, 100);
        doc.text([t.unit, (t.type || '').replace(/-/g, ' ')].filter(Boolean).join('  -  '), M, startY + 5.5);
        // Balances line, Total Owing emphasized in the accent colour.
        doc.setFontSize(9); doc.setTextColor(90, 90, 90);
        doc.text('Rent ' + money(rentOwe) + '     Arrangements ' + money(arrOwe) + '     Loans ' + money(loanOwe), M, startY + 12);
        doc.setFont('helvetica', 'bold'); doc.setTextColor(aRGB[0], aRGB[1], aRGB[2]);
        doc.text('Total Owing ' + money(grand), pageW - M, startY + 12, { align: 'right' });

        var entries = allTxns.filter(function (e) { return e.tenantId === tid; }).slice().sort(function (a, b) { return (a.date || '').localeCompare(b.date || ''); });
        doc.autoTable({
          startY: startY + 18, margin: { top: 30, left: M, right: M },
          head: [['Date', 'Description', 'Ledger', 'Charge', 'Payment', 'Method']],
          body: entries.length ? entries.map(function (r) {
            return [r.date || '', r.desc || '', (r.ledger || 'rent'), (r.charge > 0 ? money(r.charge) : '-'), (r.payment > 0 ? money(r.payment) : '-'), r.method || ''];
          }) : [[{ content: 'No transactions on file.', colSpan: 6, styles: { textColor: [150, 150, 150], fontStyle: 'italic' } }]],
          styles: { fontSize: 8.5, cellPadding: 1.6 },
          headStyles: { fillColor: aRGB, textColor: onAccentRgb(), fontStyle: 'bold' },
          columnStyles: { 0: { cellWidth: 22 }, 3: { halign: 'right' }, 4: { halign: 'right' } },
          didDrawPage: function (data) { hf.header(); hf.footer(data); }
        });
      }
      if (!rendered) { if (typeof toast === 'function') toast('No valid tenants selected.'); return; }
      doc.save('Tenant-Statements-' + new Date().toISOString().slice(0, 10) + '.pdf');
    }, function () { if (typeof toast === 'function') toast('Could not load the PDF engine (offline?)'); });
  };

  window.finVoucherDownload = function () {
    var txn = window.currentVoucherData; if (!txn) { if (typeof toast === 'function') toast('Open a voucher first'); return; }
    _load(function () {
      var r = buildDoc(txn); if (!r) { if (typeof toast === 'function') toast('Could not build the voucher'); return; }
      r.doc.save(voucherFileName(r));
    }, function () { if (typeof toast === 'function') toast('Could not load the PDF engine (offline?)'); });
  };

  window.finVoucherEmailTenant = function () {
    var txn = window.currentVoucherData; if (!txn) { if (typeof toast === 'function') toast('Open a voucher first'); return; }
    _load(function () {
      var r = buildDoc(txn); if (!r) { if (typeof toast === 'function') toast('Could not build the voucher'); return; }
      var email = (r.tenant && r.tenant.email || '').trim();
      if (!email) { if (typeof toast === 'function') toast('No email on file for this tenant'); return; }
      var b64 = '';
      try { b64 = r.doc.output('datauristring').split(',')[1]; } catch (e) { if (typeof toast === 'function') toast('Could not render the PDF'); return; }
      var nm = (typeof tenantName === 'function' && r.tenant) ? tenantName(r.tenant) : '';
      var nationName = (window.NATION_CONFIG && NATION_CONFIG.display_name) || 'Housing';
      if (typeof window.sendNotification !== 'function') { if (typeof toast === 'function') toast('Email is not available on this page'); return; }
      window.sendNotification({
        to: email, to_name: nm,
        subject: nationName + ' - ' + r.title + ' ' + r.vref,
        bodyHtml: '<p>Hello ' + nm + ',</p><p>Please find your ' + r.title.toLowerCase() + ' (' + r.vref + ') for <b>' + money(r.amount) + '</b> attached.</p><p>Thank you.</p>',
        attachments: [{ name: voucherFileName(r), contentType: 'application/pdf', contentBytes: b64 }]
      }).then(function () {
        if (typeof toast === 'function') toast('Receipt emailed to ' + email);
        if (typeof auditEntry === 'function') auditEntry(txn.tenantId || '', 'voucher_emailed', r.title + ' ' + r.vref + ' emailed to ' + email, window.currentRole || 'staff');
      }).catch(function () { if (typeof toast === 'function') toast('Could not send the email'); });
    }, function () { if (typeof toast === 'function') toast('Could not load the PDF engine (offline?)'); });
  };
})();
