// ============================================================================
// Help & Training — in-app SOP / training library.
// ----------------------------------------------------------------------------
// A self-injecting full-screen modal (window.openHelpTraining) that renders the
// standard operating procedures as readable, THEMED documents. The content is
// NATION-NEUTRAL: it describes the app's own workflow and carries no nation
// name, logo, or colour literals. Branding is supplied by the app at view time
// -- the nation's display name and logo come from NATION_CONFIG / the active
// theme, and every colour is a theme token (var(--yellow)/--text/--border/...),
// so each nation sees the same procedures in its own identity.
//
// Loaded app-wide (every page that loads housing-init.js); opened from the
// avatar menu "Help & Training" item. Mirrors the self-injecting-modal pattern
// of the TIC / reno-questionnaire. Videos are a placeholder until produced.
// ============================================================================
(function () {
  'use strict';

  function nc() { return window.NATION_CONFIG || {}; }
  function nationName() { return nc().display_name || nc().short || 'Housing'; }

  // Nation-neutral SOP bodies (HTML). Trusted static strings authored here; no
  // user content is interpolated, so no escaping is needed.
  var HOUSING_SOP = ''
    + '<h2>Purpose &amp; Scope</h2>'
    + '<p>This procedure describes the core housing workflow a file follows from application to inspection: <strong>intake &rarr; scoring &rarr; approval &rarr; matching &rarr; move-in &rarr; maintenance/renovations &rarr; inspections</strong>. It names who does each step and where it happens in the app.</p>'
    + '<p>It does not cover the Finance module (rent, arrears, collections), Capital Projects, Email Intake, or scoring-model configuration &mdash; those have their own procedures.</p>'

    + '<h2>Roles &amp; Responsibilities</h2>'
    + '<table><thead><tr><th>Role</th><th>Responsibilities across the housing workflow</th></tr></thead><tbody>'
    + '<tr><td>Executive Director (ED)</td><td>Final approval on applications, renovations, and units; override authority (e.g. oversized-unit matches); can view-as other roles.</td></tr>'
    + '<tr><td>Housing Manager (HM)</td><td>Completes staff scoring, gives approvals, matches applicants to units, assigns work orders, signs off inspections.</td></tr>'
    + '<tr><td>Housing Employee L2 (HE-L2)</td><td>Intake and editing of applications, preparing maintenance requests and RFQs, recommending for approval.</td></tr>'
    + '<tr><td>Housing Employee L1 (HE-L1)</td><td>Front-desk intake: creating and updating applications and tenant files.</td></tr>'
    + '<tr><td>Field Employee</td><td>In-house maintenance crew: completing assigned work orders and updating progress reports. Sees only work assigned to them.</td></tr>'
    + '</tbody></table>'

    + '<h2>Application Intake</h2>'
    + '<ol>'
    + '<li><strong>Create the application.</strong> From the landing page, start a New Application (or open the Applications view).</li>'
    + '<li><strong>Choose the application type:</strong><ul>'
    + '<li><strong>New Housing</strong> &mdash; someone seeking a unit (scored and ranked).</li>'
    + '<li><strong>Transfer Request</strong> &mdash; a current tenant seeking a different unit (scored and ranked).</li>'
    + '<li><strong>File Update</strong> &mdash; updating an existing tenant\'s details only (not scored, never on the waitlist).</li></ul></li>'
    + '<li>Complete applicant details, household members, income, references, and emergency contacts. Transfers and file updates skip the income/references/pets steps.</li>'
    + '<li>On <strong>Documents</strong>, upload supporting files (ID, income proof, medical letters).</li>'
    + '<li><strong>Submit.</strong> New-housing and transfer applications go to the review queue; the applicant can be emailed a copy if ticked.</li>'
    + '</ol>'
    + '<p>Applications can also arrive through the member portal &mdash; staff review those from the <strong>Application Submissions</strong> queue on the landing page before they become live records.</p>'

    + '<h2>Scoring &amp; the Waitlist</h2>'
    + '<p>Scored applications (New Housing, Transfer) are ranked by a points score that measures need and urgency.</p>'
    + '<ol>'
    + '<li>The two staff scoring screens &mdash; <strong>Housing Needs</strong> and <strong>Tenancy History</strong> &mdash; are completed by <strong>HM or ED</strong>. An application a regular employee created has not had these done yet.</li>'
    + '<li>On the approval <strong>scorecard</strong>, an application whose scoring screens aren\'t complete shows <strong>&ldquo;Complete scoring screens&rdquo;</strong> in place of the approve buttons. Complete them to unlock approval.</li>'
    + '<li>The resulting score places the applicant on the waitlist by tier. Urgent-need categories (overcrowded, structural, no running water, mold/health hazard, caregiver, homeless) add points.</li>'
    + '</ol>'
    + '<p>The waitlist order on screen is the <strong>score</strong>. Who gets matched first is a separate, ED-adjustable decision &mdash; see Matching to a Unit.</p>'

    + '<h2>Approval</h2>'
    + '<p>Applications move through a recommend-then-approve chain on the <strong>scorecard</strong> (open an application from the Applications queue).</p>'
    + '<ol>'
    + '<li><strong>Recommend</strong> &mdash; a manager reviewing the file recommends it (<em>Manager Approved</em>).</li>'
    + '<li><strong>Approve</strong> &mdash; HM, then ED as the authority requires, gives approval (<em>HM Approved</em> / <em>ED Approved</em>). Who can approve at each step is set in Settings &rarr; Approval Authority.</li>'
    + '<li><strong>Return</strong> &mdash; send it back to the preparer for missing information.</li>'
    + '<li><strong>Decline</strong> &mdash; reject the application with a reason.</li>'
    + '</ol>'
    + '<p>The scorecard also flags warnings &mdash; an arrears / good-standing note and a BCR (Band Council Resolution) ineligibility flag. These are warnings to weigh, not automatic blocks. After final approval, the applicant becomes <strong>Ready to Match</strong>.</p>'

    + '<h2>Matching to a Unit</h2>'
    + '<ol>'
    + '<li>Open the <strong>Match</strong> page &mdash; it lists approved applicants (Ready to Match) and recommends suitable vacant units.</li>'
    + '<li><strong>Match Priority</strong> (not the raw score) decides who is placed first: whether a suitable unit exists at all, that unit\'s type (Temporary / Transition), the applicant\'s reserve status, and whether they already have a house. These are ED-adjustable in Settings &rarr; Scoring &rarr; Match Priority.</li>'
    + '<li>Click <strong>Assign</strong> on an applicant, pick the unit, and confirm. A unit <strong>two or more bedrooms oversize</strong> (e.g. a 3-bed for a 1-bed need) requires ED override.</li>'
    + '<li>Assigning writes the tenancy back to the application (status becomes <em>Assigned</em>) and removes them from the Match queue.</li>'
    + '</ol>'
    + '<p>After assignment the app offers <strong>Generate Agreement</strong>, which leads into move-in.</p>'

    + '<h2>Move-In &amp; Tenancy</h2>'
    + '<ol>'
    + '<li>From the assigned application (or the Tenant Information Card), open the <strong>occupancy agreement / lease</strong>. It pre-fills the unit, occupants, and rent.</li>'
    + '<li>Capture the clause initials and signatures inline, then <strong>Generate</strong> the signed PDF. A missing fixed-term end date blocks generation; missing signatures prompt a &ldquo;generate unsigned copy?&rdquo; option for signing on paper.</li>'
    + '<li>The tenant now has a <strong>Tenant Information Card (TIC)</strong> &mdash; their file for notes, documents, utilities, and unit history. Add a move-in note when prompted.</li>'
    + '<li>The unit\'s status moves to occupied and the tenant appears on the Tenants list.</li>'
    + '</ol>'
    + '<p>Keep the TIC current: its hero shows a red badge when there are no notes or the newest is over 90 days old.</p>'

    + '<h2>Maintenance &amp; Renovations</h2>'
    + '<ol>'
    + '<li>Open the unit &rarr; <strong>Maintenance Requests</strong> &rarr; <strong>+ New Maintenance Request</strong> (or use the Renovation Questionnaire quick action to build the scope through guided questions).</li>'
    + '<li>Fill the scope: work items, condition, health &amp; safety flags, target dates, and estimated cost.</li>'
    + '<li>In <strong>Assigned To</strong>, pick either the in-house Housing crew (a field employee) or a contractor.</li>'
    + '<li><strong>Submit / Approve.</strong> Requests needing sign-off appear under <em>Renovations Waiting Approval</em> on the landing page for HM/ED. Larger jobs can go to RFQ for contractor bids.</li>'
    + '<li>On approval the <strong>work order</strong> is issued: an in-house job notifies the assigned crew; a contractor job can be emailed/texted and appears in their Contractor Portal.</li>'
    + '</ol>'
    + '<p>Track work progress and payments on the request\'s <strong>Payments</strong> tab. Contractor submissions (photos, invoices, notes) come back to your landing page &mdash; see the Contractor Module procedure.</p>'

    + '<h2>Inspections</h2>'
    + '<ol>'
    + '<li>Open the <strong>Inspections</strong> page (Operations menu) &rarr; <strong>New Inspection</strong>.</li>'
    + '<li>Pick the unit, the type (Move-In, Move-Out, Annual, Routine, Emergency), the date, and the inspector.</li>'
    + '<li>Work the room-by-room checklist &mdash; rate each item pass / fail / needs-repair with notes. Add custom rows where needed and attach photos.</li>'
    + '<li>Set the overall status. A <strong>failed or needs-repair</strong> inspection can <strong>spawn a maintenance request</strong> for the unit directly from the report.</li>'
    + '<li>An authorized approver clicks <strong>Approve Report</strong> to sign it off.</li>'
    + '</ol>'
    + '<p>Inspection dates roll up to the unit (last inspection / next due), and overdue inspections surface on the leadership dashboard.</p>';

  var CONTRACTOR_SOP = ''
    + '<h2>Purpose &amp; Scope</h2>'
    + '<p>The Contractor Module manages external contractors end to end &mdash; onboarding, compliance, and work-order assignment &mdash; and gives each approved contractor a phone-based <strong>Contractor Portal</strong> to see their jobs and submit photos, invoices, notes, progress, and insurance proof.</p>'
    + '<p><strong>This procedure covers:</strong> onboarding and approving a contractor, inviting them to the portal, assigning work orders, what the contractor does in the portal, reviewing their submissions, and paying invoices.</p>'

    + '<h2>Roles &amp; Responsibilities</h2>'
    + '<table><thead><tr><th>Role</th><th>Responsibilities in the contractor workflow</th></tr></thead><tbody>'
    + '<tr><td>Executive Director (ED)</td><td>Final approval authority. Approves contractors and the payment chain; can override and reopen.</td></tr>'
    + '<tr><td>Housing Manager (HM)</td><td>Day-to-day owner. Onboards contractors, invites them to the portal, assigns work orders, reviews submissions, and approves invoices into payment draws.</td></tr>'
    + '<tr><td>Housing Employee L2 (HE-L2)</td><td>Prepares contractor records and work orders and recommends a contractor for approval.</td></tr>'
    + '<tr><td>Contractor (portal user)</td><td>Signs in by phone. Views assigned work orders; submits photos, invoices, notes, % progress, and WSIB/insurance proof; sees each submission\'s status.</td></tr>'
    + '</tbody></table>'

    + '<h2>Onboard &amp; Approve a Contractor</h2>'
    + '<ol>'
    + '<li><strong>Create the record.</strong> Contractors page &rarr; <strong>+ New Contractor</strong>. Enter the company/name, trade, phone, email, HST/business #, and address. Under <strong>Key People</strong>, add each contact with their <strong>mobile number</strong> &mdash; this is the number the portal invite texts.</li>'
    + '<li><strong>Capture compliance.</strong> On the Compliance tab, record WSIB and insurance policy numbers and expiry dates. On Documents, upload the WSIB clearance and liability insurance certificates.</li>'
    + '<li><strong>Submit for approval.</strong> Save, then <strong>Submit Contractor</strong> &mdash; it appears under <strong>Contractors Waiting Approval</strong> on the landing page.</li>'
    + '<li><strong>Approve.</strong> HM or ED approves it from that worklist. The status becomes <strong>Approved &mdash; Active Contractor</strong>.</li>'
    + '</ol>'
    + '<p>Only an approved contractor can be assigned a work order or invited to the portal.</p>'

    + '<h2>Invite a Contractor to the Portal</h2>'
    + '<ol>'
    + '<li>Open the approved contractor\'s card &rarr; footer &rarr; <strong>Invite to portal</strong>.</li>'
    + '<li>Tick which Key People get the sign-in text, then <strong>Send</strong>. This authorizes those exact mobile numbers.</li>'
    + '<li>The contractor opens the Contractor Portal link, enters their mobile number, gets a one-time code by text, and signs in.</li>'
    + '</ol>'
    + '<p>If sign-in says &ldquo;no invite for this number,&rdquo; send the invite from this contractor\'s card. If they sign in but see no jobs, make sure the work orders are assigned to the <strong>same</strong> contractor record they signed in under.</p>'

    + '<h2>Assign a Work Order</h2>'
    + '<ol>'
    + '<li>Open the unit &rarr; <strong>Maintenance Requests</strong> &rarr; open or create the request.</li>'
    + '<li>In <strong>Assigned To</strong>, pick the contractor. Save &mdash; the job syncs to their portal.</li>'
    + '<li>Use the footer <strong>Work Order</strong> button to send it: tick the email recipients and, if the SMS module is on, the <strong>Text</strong> option (shows the contractor\'s mobile).</li>'
    + '</ol>'
    + '<p>The contractor sees only contractor-appropriate detail &mdash; tenant name/phone, scope, condition, health &amp; safety flags, target dates, and documents. Internal cost estimates, fund source, the approval chain, and the accountability section are never shown.</p>'

    + '<h2>What the Contractor Does in the Portal</h2>'
    + '<p>Opening a job, the contractor can:</p>'
    + '<ul>'
    + '<li><strong>See the job</strong> &mdash; address, tenant contact, scope, condition, H&amp;S flags, target dates, housing contact.</li>'
    + '<li><strong>Set % complete</strong> &mdash; feeds your Progress column.</li>'
    + '<li><strong>Add photos</strong> &mdash; filed to the unit\'s Documents.</li>'
    + '<li><strong>Submit an invoice</strong> &mdash; comes to you for approval; it does not pay itself.</li>'
    + '<li><strong>Add a note</strong> for the housing office.</li>'
    + '<li><strong>Upload WSIB / insurance proof.</strong></li>'
    + '</ul>'

    + '<h2>Review Contractor Submissions</h2>'
    + '<p>Submissions appear in the <strong>Contractor Submissions</strong> section of your landing-page worklist. Reload to pick up new ones.</p>'
    + '<table><thead><tr><th>Submission</th><th>What you do</th></tr></thead><tbody>'
    + '<tr><td><strong>Invoice</strong> (Pending)</td><td><strong>Approve</strong> &mdash; adds a payment draw to the job\'s Payments tab. Or <strong>Reject</strong> &mdash; dismissed; the file stays on Documents.</td></tr>'
    + '<tr><td><strong>Photo</strong> (New)</td><td><strong>View</strong>, then <strong>Mark read</strong>. Already filed to the unit\'s Documents.</td></tr>'
    + '<tr><td><strong>Note</strong> (New)</td><td><strong>View</strong>, then <strong>Mark read</strong>. Also appears on the work order\'s Notes &amp; Terms tab.</td></tr>'
    + '<tr><td><strong>WSIB / Insurance</strong> (New)</td><td><strong>View</strong>, then <strong>Mark read</strong>. Filed on the contractor\'s card under Documents.</td></tr>'
    + '</tbody></table>'
    + '<p>Invoices are the only submission that needs a decision &mdash; photos, notes, and compliance docs are flagged so you know to look.</p>'

    + '<h2>Payments &amp; Close-out</h2>'
    + '<ol>'
    + '<li>Approving an invoice adds a <strong>payment draw</strong> to the work order\'s <strong>Payments</strong> tab.</li>'
    + '<li>Pay it down there: mark the draw <strong>paid</strong> with a date and attach the payment proof.</li>'
    + '<li>When the work is finished and paid, use <strong>Mark Job Complete</strong> to close out the request.</li>'
    + '</ol>'
    + '<p>Reject any duplicate or incorrect invoice rather than approving it, so only real costs become draws.</p>';

  var DOCS = [
    { id: 'housing',    title: 'Housing Department SOP', sub: 'Application to inspection', html: HOUSING_SOP },
    { id: 'contractor', title: 'Contractor Module SOP',  sub: 'Onboarding to payment',    html: CONTRACTOR_SOP }
  ];

  function _ensureStyles() {
    if (document.getElementById('help_training_styles')) return;
    var s = document.createElement('style');
    s.id = 'help_training_styles';
    // Theme tokens only (no colour literals) so each nation's palette brands it.
    s.textContent =
      '#helpTrainingModal .ht-shell{background:var(--surface);border-radius:14px;max-width:960px;width:100%;max-height:92vh;display:flex;flex-direction:column;overflow:hidden;}'
    + '#helpTrainingModal .ht-hero{display:flex;align-items:center;gap:14px;padding:18px 24px;border-bottom:1px solid var(--border);}'
    + '#helpTrainingModal .ht-logo{height:40px;width:auto;flex-shrink:0;}'
    + '#helpTrainingModal .ht-h-main{flex:1;min-width:0;}'
    + '#helpTrainingModal .ht-nation{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--muted);}'
    + '#helpTrainingModal .ht-title{font-family:var(--serif,Georgia,serif);font-size:22px;color:var(--text);line-height:1.1;}'
    + '#helpTrainingModal .ht-tabs{display:flex;gap:6px;flex-wrap:wrap;padding:12px 24px 0;border-bottom:1px solid var(--border);}'
    + '#helpTrainingModal .ht-tab{border:none;background:none;padding:8px 14px;border-bottom:3px solid transparent;font-size:13px;font-weight:700;color:var(--muted);cursor:pointer;font-family:inherit;}'
    + '#helpTrainingModal .ht-tab.active{color:var(--text);border-bottom-color:var(--yellow);}'
    + '#helpTrainingModal .ht-body{padding:20px 24px 28px;overflow-y:auto;color:var(--text);}'
    + '#helpTrainingModal .ht-body h2{font-size:15px;font-weight:700;color:var(--text);border-left:3px solid var(--yellow);padding-left:11px;margin:22px 0 9px;}'
    + '#helpTrainingModal .ht-body h2:first-child{margin-top:4px;}'
    + '#helpTrainingModal .ht-body p{margin:0 0 9px;font-size:13.5px;line-height:1.6;}'
    + '#helpTrainingModal .ht-body ul,#helpTrainingModal .ht-body ol{margin:0 0 10px;padding-left:22px;font-size:13.5px;line-height:1.6;}'
    + '#helpTrainingModal .ht-body li{margin:0 0 5px;}'
    + '#helpTrainingModal .ht-body table{width:100%;border-collapse:collapse;margin:6px 0 14px;font-size:12.5px;}'
    + '#helpTrainingModal .ht-body th{text-align:left;font-weight:700;border-bottom:2px solid var(--yellow);padding:7px 9px;vertical-align:top;color:var(--text);}'
    + '#helpTrainingModal .ht-body td{border:1px solid var(--border);padding:7px 9px;vertical-align:top;}'
    + '#helpTrainingModal .ht-videos{border:1px dashed var(--border);border-radius:10px;padding:26px;text-align:center;color:var(--muted);font-size:13.5px;}'
    + '#helpTrainingModal .ht-foot{padding:12px 24px;border-top:1px solid var(--border);text-align:right;}';
    document.head.appendChild(s);
  }

  function _tabBtn(d, activeId) {
    return '<button type="button" class="ht-tab' + (d.id === activeId ? ' active' : '') + '" onclick="openHelpTraining(\'' + d.id + '\')">' + d.title + '</button>';
  }

  function _render(activeId) {
    var doc = null, i;
    for (i = 0; i < DOCS.length; i++) { if (DOCS[i].id === activeId) doc = DOCS[i]; }
    var tabs = '';
    for (i = 0; i < DOCS.length; i++) tabs += _tabBtn(DOCS[i], activeId);
    tabs += '<button type="button" class="ht-tab' + (activeId === 'videos' ? ' active' : '') + '" onclick="openHelpTraining(\'videos\')">Training Videos</button>';

    var theme = (window._appSettings && window._appSettings.theme) || {};
    var logo = theme.logo || nc().logo || nc().logo_url || '';
    var logoHtml = logo ? '<img class="ht-logo" src="' + logo + '" alt=""/>' : '';
    var bodyInner;
    if (activeId === 'videos') {
      bodyInner = '<div class="ht-videos">&#127909; Training videos are coming soon.<br/>Walkthroughs will be added here as they are produced.</div>';
    } else {
      bodyInner = (doc && doc.html) || '';
    }

    return ''
      + '<div class="ht-shell" onclick="event.stopPropagation()">'
      +   '<div class="ht-hero">' + logoHtml
      +     '<div class="ht-h-main"><div class="ht-nation">' + _esc(nationName()) + ' &middot; Help &amp; Training</div>'
      +       '<div class="ht-title">' + _esc((activeId === 'videos') ? 'Training Videos' : (doc ? doc.title : 'Help & Training')) + '</div></div>'
      +     '<button type="button" class="tic-close-btn" aria-label="Close" onclick="closeHelpTraining()">&times;</button>'
      +   '</div>'
      +   '<div class="ht-tabs">' + tabs + '</div>'
      +   '<div class="ht-body">' + bodyInner + '</div>'
      +   '<div class="ht-foot"><button type="button" class="btn btn-ghost" onclick="closeHelpTraining()">Close</button></div>'
      + '</div>';
  }

  function _esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

  function openHelpTraining(docId) {
    _ensureStyles();
    var id = docId || (DOCS[0] && DOCS[0].id) || 'housing';
    var host = document.getElementById('helpTrainingModal');
    if (!host) {
      host = document.createElement('div');
      host.id = 'helpTrainingModal';
      host.className = 'modal-overlay';
      host.style.display = 'none';
      host.onclick = closeHelpTraining;   // click backdrop to close
      document.body.appendChild(host);
    }
    host.innerHTML = _render(id);
    host.style.setProperty('display', 'flex', 'important');
    var b = host.querySelector('.ht-body'); if (b) b.scrollTop = 0;
  }
  window.openHelpTraining = openHelpTraining;

  function closeHelpTraining() {
    var host = document.getElementById('helpTrainingModal');
    if (host) { host.style.display = 'none'; host.innerHTML = ''; }
  }
  window.closeHelpTraining = closeHelpTraining;
})();
