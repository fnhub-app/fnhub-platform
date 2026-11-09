// ============================================================================
// Help & Training -- in-app SOP / training library.
// ----------------------------------------------------------------------------
// A self-injecting full-screen modal (window.openHelpTraining) that renders the
// standard operating procedures as readable, THEMED documents. The content is
// NATION-NEUTRAL: it describes the app's own workflow and carries no nation
// name, logo, or colour literals. Branding is supplied by the app at view time
// -- the nation's display name and logo come from NATION_CONFIG / the active
// theme, and every colour is a theme token (var(--yellow)/--text/--border/...),
// so each nation sees the same procedures in its own identity.
//
// Layout: a searchable category sidebar (Guides / Modules / Settings) plus a
// reading pane, so the library scales past a handful of documents. The two
// broad GUIDES give the end-to-end workflow; the MODULE and SETTINGS docs are
// the detailed per-feature / per-tab procedures.
//
// The canonical editable masters are Claude Docs (one per module, one per
// Settings tab). When a master changes, update the matching DOCS[].html here so
// the in-app copy stays in sync.
//
// Loaded app-wide (every page that loads housing-init.js); opened from the
// avatar menu "Help & Training" item. Mirrors the self-injecting-modal pattern
// of the TIC / reno-questionnaire. Videos are a placeholder until produced.
// ============================================================================
(function () {
  'use strict';

  function nc() { return window.NATION_CONFIG || {}; }
  function nationName() { return nc().display_name || nc().short || 'Housing'; }

  // Revision date for the whole SOP set, shown on every document in the reader.
  // BUMP THIS whenever the procedures are updated to match app changes so staff
  // can see how current the guidance is. A single doc may override it with its
  // own `rev` field once its content diverges from the rest of the set.
  var SOP_REVISION = '2026-11-09';

  // Revision history shown at the foot of every document. Add a new entry
  // (keep newest first) whenever the procedures change; a DOCS entry may
  // override it with its own `history` array once its change log diverges.
  var SOP_HISTORY = [
    { date: '2026-11-09', change: 'Added step-flow and approval-chain infographics to every SOP — the two end-to-end guides, each module, and each Settings tab — so key workflows read at a glance.' },
    { date: '2026-11-09', change: 'Added a Notes & File Records SOP: where each kind of note is stored, the Tenant Card as the single place that shows every note about a person, the new “has notes” worklist chips, destination hints on note fields, and Internal Notes shown on the approval scorecard.' },
    { date: '2026-11-03', change: 'Noted that a unit’s utility bills now also appear on the unit card’s Documents tab (cross-linked with the Tenant card’s Utilities tab).' },
    { date: '2026-11-02', change: 'Documented assigning a tenant from a unit’s new Matches tab; clarified that an emailed document filed via Email Intake also appears on the tenant’s profile.' },
    { date: '2026-11-02', change: 'Added a Two-Factor Authentication (2FA) procedure.' },
    { date: '2026-11-02', change: 'Expanded step-by-step detail for creating an application, adding a unit, creating a project / adding lots, and creating / issuing a Maintenance Request; added AI-assistant usage notes.' },
    { date: '2026-11-02', change: 'Initial version of the SOP library.' }
  ];

  // Nation-neutral SOP bodies (HTML). Trusted static strings authored here; no
  // user content is interpolated, so no escaping is needed. Template literals
  // keep the long HTML readable -- they contain no backticks or ${} sequences.

  // ---- GUIDES (broad, end-to-end workflow) ---------------------------------

  var HOUSING_SOP = ''
    + '<h2>Purpose &amp; Scope</h2>'
    + '<p>This procedure describes the core housing workflow a file follows from application to inspection: <strong>intake &rarr; scoring &rarr; approval &rarr; matching &rarr; move-in &rarr; maintenance/renovations &rarr; inspections</strong>. It names who does each step and where it happens in the app.</p>'
    + '<div class="ht-fig"><div class="ht-flow">'
    +   '<div class="ht-fstep"><span class="ht-fnum">1</span><div class="ht-fttl">Intake</div><div class="ht-fsub">Application created by staff or the portal.</div></div>'
    +   '<div class="ht-fstep"><span class="ht-fnum">2</span><div class="ht-fttl">Scoring</div><div class="ht-fsub">Need &amp; tenancy history scored and tiered.</div></div>'
    +   '<div class="ht-fstep"><span class="ht-fnum">3</span><div class="ht-fttl">Approval</div><div class="ht-fsub">Manager &rarr; HM &rarr; ED sign-off.</div></div>'
    +   '<div class="ht-fstep"><span class="ht-fnum">4</span><div class="ht-fttl">Match</div><div class="ht-fsub">Placed in a suitable vacant unit.</div></div>'
    +   '<div class="ht-fstep"><span class="ht-fnum">5</span><div class="ht-fttl">Move-in</div><div class="ht-fsub">Tenancy set and agreement generated.</div></div>'
    +   '<div class="ht-fstep"><span class="ht-fnum">6</span><div class="ht-fttl">Maintenance</div><div class="ht-fsub">Requests, renovations and work orders.</div></div>'
    +   '<div class="ht-fstep"><span class="ht-fnum">7</span><div class="ht-fttl">Inspection</div><div class="ht-fsub">Condition reports and sign-off.</div></div>'
    + '</div></div>'
    + '<p class="ht-fig-note" style="font-size:12px;color:var(--muted);margin:0 0 4px;">Application approval chain:</p>'
    + '<div class="ht-fig"><div class="ht-chain">'
    +   '<span class="ht-cpill">Submitted</span><span class="ht-carrow">&rarr;</span>'
    +   '<span class="ht-cpill">Manager recommended</span><span class="ht-carrow">&rarr;</span>'
    +   '<span class="ht-cpill">HM approved</span><span class="ht-carrow">&rarr;</span>'
    +   '<span class="ht-cpill ht-on">ED approved</span>'
    + '</div></div>'
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
    + '<div class="ht-fig"><div class="ht-flow">'
    +   '<div class="ht-fstep"><span class="ht-fnum">1</span><div class="ht-fttl">Onboard</div><div class="ht-fsub">Create the record + compliance (WSIB, insurance).</div></div>'
    +   '<div class="ht-fstep"><span class="ht-fnum">2</span><div class="ht-fttl">Approve</div><div class="ht-fsub">HM or ED approves &mdash; becomes an active contractor.</div></div>'
    +   '<div class="ht-fstep"><span class="ht-fnum">3</span><div class="ht-fttl">Invite to portal</div><div class="ht-fsub">Text a sign-in link to a key contact.</div></div>'
    +   '<div class="ht-fstep"><span class="ht-fnum">4</span><div class="ht-fttl">Assign work order</div><div class="ht-fsub">Pick the contractor &mdash; the job syncs to their portal.</div></div>'
    +   '<div class="ht-fstep"><span class="ht-fnum">5</span><div class="ht-fttl">Contractor works</div><div class="ht-fsub">Photos, % complete, invoice, notes.</div></div>'
    +   '<div class="ht-fstep"><span class="ht-fnum">6</span><div class="ht-fttl">Review</div><div class="ht-fsub">Approve invoices into payment draws.</div></div>'
    +   '<div class="ht-fstep"><span class="ht-fnum">7</span><div class="ht-fttl">Pay &amp; close</div><div class="ht-fsub">Pay the draws, then Mark Job Complete.</div></div>'
    + '</div></div>'

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

  // ---- MODULE SOPs (detailed per-feature procedures) -----------------------

  var MOD_APPLICATIONS = `
    <p>Applications are the heart of the Housing app. This covers taking an application, the three types, submitting it, and moving it through approval. Placing an approved applicant into a unit is in the Match procedure.</p>
    <p style="font-size:12px;color:var(--muted);margin:0 0 4px;">Approval chain (an approver can Return or Decline at any stage):</p>
    <div class="ht-fig"><div class="ht-chain">
    <span class="ht-cpill">Submitted</span><span class="ht-carrow">&rarr;</span>
    <span class="ht-cpill">Manager recommended</span><span class="ht-carrow">&rarr;</span>
    <span class="ht-cpill">HM approved</span><span class="ht-carrow">&rarr;</span>
    <span class="ht-cpill ht-on">ED approved</span>
    </div></div>
    <h2>Who does what</h2>
    <table><thead><tr><th>Role</th><th>Can do</th></tr></thead><tbody>
    <tr><td>Housing Employee (L1/L2)</td><td>Create and edit applications, submit them.</td></tr>
    <tr><td>Housing Manager</td><td>The above, plus recommend/approve at the HM stage and complete staff scoring screens.</td></tr>
    <tr><td>Executive Director</td><td>Final approval, return, decline, override, and complete scoring.</td></tr>
    </tbody></table>
    <h2>The three application types</h2>
    <table><thead><tr><th>Type</th><th>Meaning</th><th>Scored?</th><th>On Match?</th></tr></thead><tbody>
    <tr><td>New Housing</td><td>Seeking a unit.</td><td>Yes</td><td>Yes</td></tr>
    <tr><td>Transfer Request</td><td>A current tenant on reserve applying for a different unit.</td><td>Yes</td><td>Yes (On Rez / transfer)</td></tr>
    <tr><td>File Update (existing tenant)</td><td>Updating a housed tenant's file only.</td><td>No</td><td>No</td></tr>
    </tbody></table>
    <h2>Create an application &mdash; step by step</h2>
    <ol>
    <li><strong>Start it.</strong> From the landing page or the Applications area, click <strong>New Application</strong>.</li>
    <li><strong>Choose the type</strong> (New Housing, Transfer Request, or File Update). This decides which steps you see &mdash; File Updates and Transfers automatically skip the Income, References/Emergency Contacts, and Pets steps.</li>
    <li><strong>Applicant details.</strong> Enter the main applicant's name, date of birth, contact information, band/membership details, and current housing situation. Fields with a red <span class="r">*</span> are required and block submission while blank (the required set is configured in Settings &rarr; Required Fields).</li>
    <li><strong>Household members.</strong> Add everyone who will live in the unit (name, relationship, date of birth). Household size feeds the overcrowding and bedroom-need calculations.</li>
    <li><strong>Income</strong> (New Housing only). Record each income source and type &mdash; the income type also decides the rent pathway later.</li>
    <li><strong>References &amp; emergency contacts</strong> (New Housing only). Add the references and emergency contacts requested.</li>
    <li><strong>Pets</strong> (New Housing only), if your nation collects them.</li>
    <li><strong>Documents.</strong> Upload supporting files &mdash; ID, income proof, medical or overcrowding letters. Drag-and-drop or browse; each file is kept with the application.</li>
    <li><strong>Staff scoring</strong> (HM/ED only, scored applications). Complete the <strong>Housing Needs</strong> and <strong>Tenancy History</strong> screens. A regular employee does not see these; an HM/ED completes them later, before the application can be approved.</li>
    <li><strong>Review &amp; submit.</strong> Check the summary, then submit. You can tick the box to email the applicant a PDF copy of their application.</li>
    </ol>
    <p>You can save and return to a draft at any point &mdash; it waits for you under <strong>My Drafts</strong> on the landing page.</p>
    <h2>The approval workflow</h2>
    <p>Applications move through stages, each gated by Approval Authority:</p>
    <ol>
    <li><strong>Submitted</strong> &rarr; management reviews on the scorecard.</li>
    <li><strong>Manager recommended</strong> (optional) &rarr; an HM recommends.</li>
    <li><strong>HM approved</strong> &rarr; the Housing Manager signs off.</li>
    <li><strong>ED approved</strong> &rarr; the Executive Director gives final approval, then offers <strong>Go to Match</strong>.</li>
    </ol>
    <p>At any stage an approver can <strong>Return</strong> the application for changes or <strong>Decline</strong> it. Each transition sends the configured email and writes an audit entry.</p>
    <h2>Approve an application</h2>
    <ol>
    <li>Open the application's <strong>scorecard</strong> from the worklist or Applications list.</li>
    <li>Review the score, household, documents, and notes.</li>
    <li>If a scored application has not had its staff scoring screens completed, the approve buttons are hidden and a <strong>Complete scoring screens</strong> button appears. Click it, fill steps 9 and 10, save &mdash; the approve buttons then unlock.</li>
    <li>Use <strong>Draft with AI</strong> (if enabled) for a decision note, or type your own.</li>
    <li>Click the action for your stage (Recommend / HM Approve / ED Approve), or <strong>Return</strong> / <strong>Decline</strong>.</li>
    <li>After final ED approval, use <strong>Go to Match</strong> to place the applicant.</li>
    </ol>
    <h2>Notes and cautions</h2>
    <ul>
    <li><strong>Scoring must be completed before a scored application can be approved</strong>, so Housing Needs and Tenancy History are assessed by an HM/ED.</li>
    <li>A <strong>Return</strong> lets the applicant fix and resubmit; a <strong>Decline</strong> ends it. Choose deliberately.</li>
    <li>File Updates are never scored and never appear on Match.</li>
    <li>Waitlist order comes from the application score; who is placed first comes from Match Priority &mdash; two different things.</li>
    <li>Every action is logged in the Audit Log with your email.</li>
    </ul>`;

  var MOD_INVENTORY = `
    <p>Inventory is the register of every housing unit the nation owns. Each unit has one tabbed card (the Edit Unit modal) holding its details, tenant, approvals, maintenance history, documents, and map location.</p>
    <div class="ht-fig"><div class="ht-flow">
    <div class="ht-fstep"><span class="ht-fnum">1</span><div class="ht-fttl">Add unit</div><div class="ht-fsub">Unit number + street address.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">2</span><div class="ht-fttl">Set details</div><div class="ht-fsub">Beds / baths / type / funder / rent.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">3</span><div class="ht-fttl">Finish on the card</div><div class="ht-fsub">Assignment type, map, approvals, inspection dates.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">4</span><div class="ht-fttl">Assign a tenant</div><div class="ht-fsub">From the Matches tab on a vacant unit.</div></div>
    </div></div>
    <h2>Who can use it</h2>
    <ul>
    <li>Housing staff can view and (for most roles) edit units.</li>
    <li><strong>Field employees</strong> get a read-only view so they can see maintenance details, but cannot change unit data.</li>
    </ul>
    <h2>Opening a unit</h2>
    <p>Click a unit anywhere &mdash; an address link, a table row, or a deep link &mdash; and the <strong>Edit Unit</strong> card opens. There is one card per unit.</p>
    <h2>The unit card tabs</h2>
    <table><thead><tr><th>Tab</th><th>What it holds</th></tr></thead><tbody>
    <tr><td>Overview</td><td>Address, bed/bath/type, flags, funder, status, assignment type, inspection dates, notes.</td></tr>
    <tr><td>Tenant</td><td>The assigned tenant and tenancy history.</td></tr>
    <tr><td>Matches</td><td>Approved applicants who are a potential match for this unit, ranked by fit, with an Assign button. Shown for vacant units when the Match module is on.</td></tr>
    <tr><td>Approvals</td><td>Budget indicator and the HM/ED signature blocks for the unit's renovation budget.</td></tr>
    <tr><td>Maintenance Requests</td><td>The unit's Maintenance Requests, with + New Maintenance Request.</td></tr>
    <tr><td>RFQs &amp; Contracts</td><td>RFQs linked to this unit.</td></tr>
    <tr><td>Documents</td><td>The unit's document library, including its <strong>utility bills</strong> (which also appear on the Tenant card's Utilities tab).</td></tr>
    <tr><td>Map &amp; Photos</td><td>The unit's map location and photo uploader.</td></tr>
    </tbody></table>
    <h2>Add a new unit &mdash; step by step</h2>
    <ol>
    <li>Open <strong>Inventory</strong> and click <strong>+ Add New Unit</strong> (or <strong>Add Unit</strong>).</li>
    <li>Enter the <strong>Unit Number</strong> and <strong>Street Address</strong> (both required).</li>
    <li>Optionally pick <strong>Build on Lot</strong> to tie the unit to a capital-project lot.</li>
    <li>Set <strong>Bedrooms</strong>, <strong>Bathrooms</strong>, <strong>Type</strong> (Detached, Duplex, 4/5/6-Plex, Complex, Mobile, or an Admin/Band/Commercial Building), and <strong>Foundation</strong>.</li>
    <li>Choose the <strong>Funder / Program</strong> (Band, ISC, CMHC Sec. 95, Other) and fill <strong>Phase</strong>, <strong>Year Built</strong>, <strong>Monthly Rent</strong>, and <strong>Construction Cost</strong> as known.</li>
    <li>Toggle <strong>Accessible</strong> or <strong>Elders Unit</strong> if they apply, add any <strong>Notes</strong>, and drag in <strong>Photos</strong>.</li>
    <li>Click <strong>Add Unit</strong>. The unit appears in Inventory and is available for matching once its status is vacant.</li>
    </ol>
    <p>Fields not on this form &mdash; <strong>Assignment Type</strong> (Regular / Temporary / Transition), city/province/postal, map location, approvals, and inspection dates &mdash; are set afterward by opening the unit's card and using its tabs.</p>
    <h2>Edit a unit</h2>
    <ol>
    <li>Open the unit card, go to the relevant tab, change the fields, and <strong>Save</strong>.</li>
    <li>For location, use the <strong>Map &amp; Photos</strong> tab to set the pin.</li>
    </ol>
    <h2>Assign a tenant from the unit (Matches tab)</h2>
    <p>For a vacant unit you can place a tenant from the unit side instead of starting on the Match page:</p>
    <ol>
    <li>Open the unit card and go to the <strong>Matches</strong> tab. It lists approved applicants who fit this unit, ranked best-fit first (with the tightest / exact bedroom fit, accessibility, and Elders eligibility flagged).</li>
    <li>Click <strong>Assign &rarr;</strong> next to the applicant. The Assign-Unit window opens with this unit pre-selected.</li>
    <li>Confirm (and add notes if your role requires them). The usual approval rules apply &mdash; a unit two or more bedrooms larger than the applicant needs still requires ED approval.</li>
    </ol>
    <h2>Assignment types</h2>
    <ul>
    <li><strong>Regular</strong> &mdash; permanent placement (default, no badge).</li>
    <li><strong>Temporary</strong> &mdash; urgent/emergency placement; red TEMPORARY badge; jumps the Match queue.</li>
    <li><strong>Transition</strong> &mdash; probationary placement; blue TRANSITION badge; treated as lower-urgency on Match.</li>
    </ul>
    <h2>List vs Cards view</h2>
    <p>Use the <strong>List / Cards</strong> toggle above the table. It is remembered per device and shows the same filtered, sorted units either way &mdash; only the layout changes.</p>
    <h2>Notes and cautions</h2>
    <ul>
    <li><strong>Tenancy lives on the unit.</strong> Assigning a tenant to a unit marks it occupied and writes the tenancy back to the application. An application does not read as housed until a unit is assigned to that applicant.</li>
    <li>Some fields (CMHC value) enable only for certain funders.</li>
    <li>The budget approval blocks appear only when a request's cost exceeds the HM budget limit, routing it to ED.</li>
    <li>Changes are recorded in the Audit Log.</li>
    </ul>`;

  var MOD_TENANTS = `
    <p>The Tenants page lists everyone housed by the nation. Each tenant has a full-screen <strong>Tenant Information Card (TIC)</strong> holding their details, utilities, documents, notes, and unit history, and generating their occupancy agreement.</p>
    <div class="ht-fig"><div class="ht-flow">
    <div class="ht-fstep"><span class="ht-fnum">1</span><div class="ht-fttl">Open the Tenant Card</div><div class="ht-fsub">From a tenant row or the worklist.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">2</span><div class="ht-fttl">Keep details current</div><div class="ht-fsub">Contact info, utilities, documents.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">3</span><div class="ht-fttl">Add file notes</div><div class="ht-fsub">The hero badge flags stale files.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">4</span><div class="ht-fttl">Generate the agreement</div><div class="ht-fsub">Occupancy / lease PDF from the card.</div></div>
    </div></div>
    <h2>Who can use it</h2>
    <ul><li>Housing staff can open and edit the TIC. <strong>Field employees</strong> see it read-only.</li></ul>
    <h2>The TIC tabs</h2>
    <table><thead><tr><th>Tab</th><th>What it holds</th></tr></thead><tbody>
    <tr><td>Overview</td><td>Tenant detail fields, tenancy status, and (if Mapping is on) the unit map.</td></tr>
    <tr><td>Utilities</td><td>Hydro/gas account and meter numbers, utility-bill documents.</td></tr>
    <tr><td>Documents</td><td>The tenant's document library.</td></tr>
    <tr><td>Notes</td><td>Add and read file notes; a hero badge flags files with no recent note.</td></tr>
    <tr><td>Unit History</td><td>The tenant's tenancy history.</td></tr>
    </tbody></table>
    <h2>Add a file note</h2>
    <ol>
    <li>Open the TIC and go to <strong>Notes</strong>.</li>
    <li>Click <strong>Add a Note</strong>, type it, and confirm.</li>
    <li>The hero shows how long since the last note (red when there are none or the newest is over 90 days old).</li>
    </ol>
    <h2>Generate an occupancy agreement / lease</h2>
    <ol>
    <li>Make sure the tenant is assigned to a <strong>unit</strong> (the agreement pulls address and details from the unit &mdash; no unit, no agreement).</li>
    <li>Open the TIC and start the agreement from the footer, or let it auto-open after a move-in.</li>
    <li>Choose the agreement type (residential, temporary, commercial).</li>
    <li>Fill the fixed-term end date (required) and capture inline initials/signatures on each clause.</li>
    <li>Generate the PDF. Missing signatures prompt a &ldquo;generate unsigned copy?&rdquo; option; a missing term end date hard-blocks.</li>
    <li>The signed PDF files into the tenant's and unit's documents.</li>
    </ol>
    <h2>Tenancy status and the BCR list</h2>
    <p>The Overview tab's <strong>Tenancy Status</strong> includes lifecycle values (active, vacated, transferred, evicted, suspended, deceased, bankrupt) plus <strong>Banished</strong> and <strong>Harbouring</strong>.</p>
    <ul>
    <li>Setting status to <strong>Banished</strong> prompts to add the person to the nation's <strong>BCR ineligibility list</strong> (opens the BCR manager pre-filled; requires BCR authority). It never silently writes a registry row.</li>
    <li><strong>Harbouring</strong> is a label only, with no linked action.</li>
    <li>The BCR list is enforced as a <strong>warning</strong> at application approval and unit assignment.</li>
    </ul>
    <h2>Merge duplicate tenants</h2>
    <p>Because a new tenant row is created each time a unit is assigned, one person can accumulate several rows. Use <strong>Merge Duplicates</strong> (Tenants page, requires merge authority) to point duplicates at the canonical person. It is reversible and is respected across Finance.</p>
    <h2>Notes and cautions</h2>
    <ul>
    <li><strong>Meter vs account numbers:</strong> hydro/gas meter numbers save to the unit; hydro/gas account numbers save to the tenant.</li>
    <li>Keep file notes current &mdash; the red badge is a prompt.</li>
    <li>Do not create tenant rows by hand for production data; tenancy flows from assigning a unit.</li>
    <li>Changes are recorded in the Audit Log.</li>
    </ul>`;

  var MOD_WORKLIST = `
    <p>My Worklist is the action queue on the landing page. It groups everything waiting for you into sections so you can clear the day's work from one screen. What you see depends on your role and your approval authority.</p>
    <div class="ht-fig"><div class="ht-flow">
    <div class="ht-fstep"><span class="ht-fnum">1</span><div class="ht-fttl">Open the landing page</div><div class="ht-fsub">Each section shows its count.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">2</span><div class="ht-fttl">Work top to bottom</div><div class="ht-fsub">Click an item to open it where you act.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">3</span><div class="ht-fttl">Act in place</div><div class="ht-fsub">Approvals often resolve inline.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">4</span><div class="ht-fttl">Queue refreshes</div><div class="ht-fsub">Cleared items drop off automatically.</div></div>
    </div></div>
    <h2>Who can use it</h2>
    <ul><li>Every staff member sees a worklist tailored to their role. Field employees see a Work Orders to Complete section; management sees approval queues.</li></ul>
    <h2>The sections</h2>
    <table><thead><tr><th>Section</th><th>Lists</th><th>Action</th></tr></thead><tbody>
    <tr><td>My Drafts</td><td>Draft applications, Maintenance Requests, and RFQs you started.</td><td>Continue or Archive.</td></tr>
    <tr><td>Applications</td><td>Submitted apps for management; returned apps for the owner.</td><td>Open the scorecard.</td></tr>
    <tr><td>Renovations Waiting Approval</td><td>Maintenance Requests needing HM or ED sign-off.</td><td>Opens the request to approve in place.</td></tr>
    <tr><td>RFQs Open for Bids</td><td>Issued RFQs awaiting bids.</td><td>Open the RFQ.</td></tr>
    <tr><td>Contractors Waiting Approval</td><td>Contractors pending recommend/approve.</td><td>Open the contractor card.</td></tr>
    <tr><td>Contractor Submissions</td><td>Photos, notes, invoices from the Contractor Portal (management).</td><td>Approve/Reject invoices; View/Mark-read photos and notes.</td></tr>
    <tr><td>Inventory Approvals</td><td>Units with HM/ED budget approvals pending.</td><td>Opens the unit.</td></tr>
    <tr><td>Ready to Match</td><td>Approved applicants with no unit yet.</td><td>Go to Match.</td></tr>
    </tbody></table>
    <h2>Work your queue</h2>
    <ol>
    <li>Open the landing page. Each section shows its count.</li>
    <li>Work top to bottom. Click an item to open it where you can act.</li>
    <li>For approvals you can often act <strong>in place</strong> &mdash; a Maintenance Request opens its modal so an HM/ED can approve inline.</li>
    <li>The queue refreshes after you act, so a cleared item drops off.</li>
    </ol>
    <h2>Notes and cautions</h2>
    <ul>
    <li><strong>The worklist routes by authority.</strong> Items appear for the roles allowed to act on them (Settings &rarr; Approval Authority).</li>
    <li>Use <strong>My Drafts &rarr; Archive</strong> to clear abandoned drafts.</li>
    <li>A <strong>List / Cards</strong> toggle changes the layout; it is remembered per device.</li>
    <li>Field employees only see in-house work orders assigned to them.</li>
    </ul>`;

  var MOD_MATCH = `
    <p>The Match page lists approved applicants ready to be placed into a vacant unit, ranked in the order your nation wants to house them, and is where staff assign an applicant to a unit.</p>
    <div class="ht-fig"><div class="ht-flow">
    <div class="ht-fstep"><span class="ht-fnum">1</span><div class="ht-fttl">Approved applicant</div><div class="ht-fsub">Scored (New Housing / Transfer), not yet placed.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">2</span><div class="ht-fttl">Ranked</div><div class="ht-fsub">By Match Priority: has-match, unit type, reserve, house.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">3</span><div class="ht-fttl">Assign</div><div class="ht-fsub">Pick the unit; oversized picks need ED override.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">4</span><div class="ht-fttl">Housed</div><div class="ht-fsub">Unit becomes occupied; agreement generated.</div></div>
    </div></div>
    <h2>Who can use it</h2>
    <ul><li>Staff with match/assignment authority (typically HM/ED). Oversized-unit placements require ED override.</li></ul>
    <h2>Who appears on Match</h2>
    <p>An applicant shows only when all of these are true:</p>
    <ul>
    <li>They are <strong>approved</strong> (HM / manager / ED) and not archived.</li>
    <li>They are a <strong>scored</strong> type &mdash; New Housing or Transfer Request. File Updates never appear.</li>
    <li>They are <strong>not already placed</strong> (no unit assigned).</li>
    </ul>
    <p>A currently-housed applicant applying to transfer is <strong>kept</strong> and flagged On Rez / transfer. Tenancy is read from the unit records, so people housed by other paths do not wrongly appear as unhoused.</p>
    <h2>Placement order</h2>
    <p>The list is sorted by <strong>Match Priority</strong> (Settings &rarr; Application Scoring &rarr; Match Priority), not by raw score alone:</p>
    <ul>
    <li><strong>Has a match dominates</strong> &mdash; an applicant with no suitable vacant unit drops to the bottom.</li>
    <li>A match against a <strong>Temporary</strong> unit jumps the queue.</li>
    <li>Within those, <strong>no house</strong> beats has house, and <strong>on reserve</strong> beats off reserve.</li>
    <li>The application <strong>score</strong> breaks ties inside each tier.</li>
    </ul>
    <h2>Place an applicant</h2>
    <ol>
    <li>Open <strong>Match</strong>.</li>
    <li>Review the ranked list &mdash; applicant, score, whether they already have a house, recommended unit.</li>
    <li>Click <strong>Assign</strong> on the applicant you are placing.</li>
    <li>In the assign modal, pick the unit. It shows the match % and warns if ED approval is required.</li>
    <li>Confirm. You may be prompted to add a move-in note and to <strong>Generate Agreement</strong>.</li>
    <li>The unit becomes occupied and the application is marked assigned.</li>
    </ol>
    <h2>The oversized-unit rule</h2>
    <ul>
    <li>A unit <strong>one size up</strong> from what the applicant needs is a normal match.</li>
    <li>A unit <strong>two or more sizes up</strong> always requires <strong>ED override</strong>, regardless of what else is available, and requires a note.</li>
    </ul>
    <h2>Notes and cautions</h2>
    <ul>
    <li><strong>List vs Cards</strong> toggle changes the layout only.</li>
    <li>An arrears-flagged applicant stays <strong>visible</strong> with an amber warning badge; the arrears good-standing gate fires at assignment.</li>
    <li>Tenancy is authoritative on the unit &mdash; assigning writes the placement back to the application.</li>
    <li>Changes are recorded in the Audit Log.</li>
    </ul>`;

  var MOD_RENOS = `
    <p>A Maintenance Request (internally a Scope of Work) captures the work needed on a unit, routes it for approval, assigns it to crew or a contractor, tracks progress and payments, and closes out. Enabling Renovations also enables the Contractors registry.</p>
    <div class="ht-fig"><div class="ht-flow">
    <div class="ht-fstep"><span class="ht-fnum">1</span><div class="ht-fttl">Create</div><div class="ht-fsub">Scope, work items, fund source, H&amp;S flags.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">2</span><div class="ht-fttl">Submit</div><div class="ht-fsub">Goes to Renovations Waiting Approval.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">3</span><div class="ht-fttl">Approve</div><div class="ht-fsub">HM up to the budget limit; larger goes to ED.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">4</span><div class="ht-fttl">Issue work order</div><div class="ht-fsub">In-house crew or a contractor.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">5</span><div class="ht-fttl">Progress &amp; pay</div><div class="ht-fsub">Track % and pay down the PO draws.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">6</span><div class="ht-fttl">Complete</div><div class="ht-fsub">Mark complete; frees the unit.</div></div>
    </div></div>
    <h2>Who does what</h2>
    <table><thead><tr><th>Role</th><th>Can do</th></tr></thead><tbody>
    <tr><td>Field employee</td><td>Create/edit requests, complete work orders, edit progress (sees only in-house jobs assigned to them).</td></tr>
    <tr><td>Housing staff</td><td>Create and edit requests.</td></tr>
    <tr><td>HM / ED</td><td>Approve requests, assign work orders, manage payments, cancel/reopen.</td></tr>
    </tbody></table>
    <h2>Opening or creating a request</h2>
    <ul>
    <li>From a unit card's <strong>Maintenance Requests</strong> tab, click <strong>+ New Maintenance Request</strong>.</li>
    <li>Or from the <strong>Renovation Questionnaire</strong> quick action, which builds a scope by guided questions and opens a pre-filled request.</li>
    <li>Each request gets a reference number in the SOW-YYYY-NN format (an internal code).</li>
    </ul>
    <h2>The request modal tabs</h2>
    <table><thead><tr><th>Tab</th><th>What it holds</th></tr></thead><tbody>
    <tr><td>Overview</td><td>Unit info, condition assessment, fund source, estimated cost, target dates.</td></tr>
    <tr><td>Work Items</td><td>The list of work to be done, by category, with costs.</td></tr>
    <tr><td>Health &amp; Safety</td><td>Hazard flags (mould, electrical, structural, plumbing, fire).</td></tr>
    <tr><td>Assignment / Work Order</td><td>In-house crew or contractor, and the assignee.</td></tr>
    <tr><td>Payments</td><td>Purchase-order draw-down and progress (management only).</td></tr>
    <tr><td>Notes &amp; Terms</td><td>Contractor notes and terms.</td></tr>
    </tbody></table>
    <h2>Create a Maintenance Request &mdash; step by step</h2>
    <ol>
    <li>Open the unit &rarr; <strong>Maintenance Requests</strong> tab &rarr; <strong>+ New Maintenance Request</strong>. (Or use the <strong>Renovation Questionnaire</strong> quick action on the landing page to build the scope through guided questions &mdash; it opens a pre-filled request.)</li>
    <li>On <strong>Overview</strong>, confirm the unit, record the <strong>Overall Condition</strong>, and set the <strong>Target Start / Completion</strong> dates.</li>
    <li>On <strong>Work Items</strong>, add each piece of work with its category and cost &mdash; the <strong>Estimated Cost</strong> on the info strip updates as you go.</li>
    <li>Choose the <strong>Fund Source</strong>; only sources the unit and household are eligible for are listed.</li>
    <li>On <strong>Health &amp; Safety</strong>, tick any hazards (mould, electrical, structural, plumbing, fire).</li>
    <li>If you have assign authority, set <strong>Assigned To</strong> &mdash; in-house crew (pick a field employee) or a contractor.</li>
    <li>Click <strong>Save</strong> to keep it as a draft, or <strong>Submit</strong> when it is ready for approval. Review every tab first &mdash; the submit step checks you have visited each one. On submit you may be prompted to email the tenant a copy.</li>
    </ol>
    <h2>Submit, approve, and issue the work order</h2>
    <ol>
    <li>A submitted request appears under <strong>Renovations Waiting Approval</strong> on the landing page for the approver.</li>
    <li>The <strong>Housing Manager</strong> can approve requests at or under the HM budget limit; larger ones go to the <strong>ED</strong> (the limit is set in Settings &rarr; Reno Budget).</li>
    <li>Approve by opening the request and signing off, or inline from the worklist.</li>
    <li>On approval the <strong>work order is issued</strong>: an in-house job notifies the assigned crew member; a <strong>contractor</strong> job prompts you to email the work order (and, if SMS is on and the contractor has a mobile, to text a link), and it appears in their Contractor Portal.</li>
    <li>For larger jobs you can tender first via <strong>RFQ</strong>; awarding the RFQ approves the linked request automatically and badges it <strong>System Approved</strong>.</li>
    </ol>
    <h2>Using the AI assistant</h2>
    <ul>
    <li>Click the <strong>&#10022; AI</strong> button in the header on any page to open the chat and ask how-to or data questions &mdash; for example "how do I complete a maintenance request?" or "which units have open maintenance requests?" It answers from the app's data within your role's limits and never changes anything.</li>
    <li><strong>Draft with AI</strong> writes a professional decision note for you to review and edit &mdash; it appears on the <strong>application approval</strong> notes box and on <strong>inspection</strong> general notes (gated by the AI Assistant module). Always read and edit a drafted note before saving; you are accountable for the decision.</li>
    </ul>
    <h2>Payments (PO draw-down)</h2>
    <p>The <strong>Payments</strong> tab (management only) tracks paying down a purchase order in steps:</p>
    <ol>
    <li>The PO is seeded from an awarded RFQ or the request total.</li>
    <li>Add <strong>draws</strong> &mdash; material, phase 1..N, or holdback (with a release date).</li>
    <li>Mark each draw paid, with a date, and attach the <strong>invoice</strong> file.</li>
    <li>A progress bar shows paid vs outstanding. At <strong>100% paid</strong> a <strong>Mark Job Complete</strong> button appears.</li>
    <li>Payment % is shown in its own column in Reno Approvals &mdash; separate from work-progress %.</li>
    </ol>
    <h2>Completing and cancelling</h2>
    <ul>
    <li><strong>Complete:</strong> when the work is done, mark the request complete (optionally capture a note). Completing frees the unit if no other active requests remain.</li>
    <li><strong>Cancel:</strong> management can Cancel Request on a saved request. If a contractor was assigned, you can send a cancellation notice. A cancelled request is frozen and badged Cancelled; only the ED can Reopen it.</li>
    </ul>
    <h2>Notes and cautions</h2>
    <ul>
    <li><strong>"Maintenance Request" is the name; the system calls it a SOW internally</strong> &mdash; reference numbers and some labels still read SOW-. That is expected.</li>
    <li>Cancel is separate from the approval chain and never disturbs the approval status.</li>
    <li>Work-progress % and payment % are <strong>two different numbers</strong>.</li>
    <li>Field employees only see in-house work orders assigned to them.</li>
    <li>All actions are recorded in the Audit Log.</li>
    </ul>`;

  var MOD_RFQ = `
    <p>An RFQ (Request for Quotes) links a Maintenance Request to one or more contractors invited to bid, records their bids, awards the work, and generates the contract. It is how larger jobs are tendered.</p>
    <div class="ht-fig"><div class="ht-flow">
    <div class="ht-fstep"><span class="ht-fnum">1</span><div class="ht-fttl">Create &amp; issue</div><div class="ht-fsub">Link the request, pick recipients, Issue.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">2</span><div class="ht-fttl">Bids received</div><div class="ht-fsub">Enter each bid; lowest is highlighted.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">3</span><div class="ht-fttl">Award</div><div class="ht-fsub">Winner emailed; linked request auto-approved.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">4</span><div class="ht-fttl">Contract</div><div class="ht-fsub">Fill Contracting, sign, Generate Contract.</div></div>
    </div></div>
    <h2>Who can use it</h2>
    <ul><li><strong>Edit:</strong> Housing Manager and ED only. Everyone else gets a read-only view (a View only banner).</li></ul>
    <h2>The status flow</h2>
    <p>draft &rarr; issued &rarr; awarded, and cancelled from any stage (including an awarded job that falls through). RFQ numbers are RFQ-YYYY-NNNN; contract numbers are CON-YYYY-NNNN.</p>
    <h2>The tabs</h2>
    <table><thead><tr><th>Tab</th><th>What it holds</th></tr></thead><tbody>
    <tr><td>Details</td><td>RFQ number, linked request/unit, issue and close dates, contact, scope summary (auto-prefilled), optional Capital Project link.</td></tr>
    <tr><td>Scope</td><td>Structured scope items by category, and the Award card.</td></tr>
    <tr><td>Recipients</td><td>The contractors invited to bid, plus the Bids Received card.</td></tr>
    <tr><td>Documents</td><td>The RFQ's document library (shared with the unit).</td></tr>
    <tr><td>Contracting</td><td>Contract details, pricing, milestones, materials/exclusions/nation-supplied items, subcontractors, signatures.</td></tr>
    </tbody></table>
    <h2>Issue an RFQ</h2>
    <ol>
    <li>From a Maintenance Request or the unit's RFQs section, create a new RFQ.</li>
    <li>On <strong>Details</strong>, confirm the linked request, set the close date and contact. The scope summary prefills.</li>
    <li>On <strong>Scope</strong>, refine the structured scope items.</li>
    <li>On <strong>Recipients</strong>, select the contractors to invite.</li>
    <li>Attach any documents on the <strong>Documents</strong> tab.</li>
    <li>Click <strong>Issue</strong>. The RFQ moves to issued and invited contractors receive the package email.</li>
    </ol>
    <h2>Record bids and award</h2>
    <ol>
    <li>Open the issued RFQ &rarr; <strong>Recipients</strong> &rarr; <strong>Bids Received</strong>.</li>
    <li>Enter each contractor's amount, notes, received date. Bids sort lowest-first with the lowest highlighted.</li>
    <li>Click <strong>Award</strong> on the winning bid. The award modal opens pre-filled with that contractor and amount.</li>
    <li>Confirm. The winner is emailed, regret notices go to the others, and the <strong>linked Maintenance Request is approved automatically</strong> (badged System Approved).</li>
    <li>Use <strong>Set up contract</strong> to open Contracting seeded from the award.</li>
    </ol>
    <p>To award a tender run offline, use <strong>Record Award &amp; Approve SOW &mdash; No Notifications</strong> on the Scope tab's Award card.</p>
    <h2>Generate the contract</h2>
    <ol>
    <li>Open <strong>Contracting</strong>.</li>
    <li>Fill contract details, pricing, milestones, and the dynamic rows (materials, exclusions, nation-supplied items, subcontractors).</li>
    <li>Capture signatures (nation rep + contractor).</li>
    <li>Click <strong>Generate Contract</strong>. A missing awarded contractor, price, contract date, or completion date hard-blocks; missing signatures are a soft confirm.</li>
    <li>The contract PDF files into both the RFQ's and the unit's documents.</li>
    </ol>
    <h2>Notes and cautions</h2>
    <ul>
    <li><strong>Editing an issued RFQ does not re-notify</strong> contractors who already got the package. To materially change it, use the ED Unlock RFQ (back to draft) and re-issue.</li>
    <li>The winning bid amount flows automatically into the Award and the generated contract.</li>
    <li>Subcontractors must provide WSIB clearance and liability insurance of at least $2,000,000; the contract prints this clause even when no subs are listed.</li>
    <li>The RFQ module must be enabled. All actions are recorded in the Audit Log.</li>
    </ul>`;

  var MOD_CONTRACTORS = `
    <p>The Contractors registry holds the businesses the nation hires for renovation and maintenance work. Each contractor has a card with their trade, key contacts, compliance documents, and work history. It is enabled automatically when Renovations is on.</p>
    <p style="font-size:12px;color:var(--muted);margin:0 0 4px;">Contractor approval chain:</p>
    <div class="ht-fig"><div class="ht-chain">
    <span class="ht-cpill">Draft</span><span class="ht-carrow">&rarr;</span>
    <span class="ht-cpill">Pending review</span><span class="ht-carrow">&rarr;</span>
    <span class="ht-cpill">HM recommended</span><span class="ht-carrow">&rarr;</span>
    <span class="ht-cpill ht-on">Approved</span>
    </div></div>
    <h2>Who does what</h2>
    <table><thead><tr><th>Role</th><th>Can do</th></tr></thead><tbody>
    <tr><td>Housing Employee L2 / HM</td><td>Add contractors and recommend them for approval.</td></tr>
    <tr><td>HM / ED</td><td>Give final approval, decline, or return.</td></tr>
    </tbody></table>
    <h2>The approval flow</h2>
    <p>draft &rarr; pending_review (recommended) &rarr; hm_recommended &rarr; approved.</p>
    <ul>
    <li>A role that can both recommend and approve (HM) recommends at pending review, then approves at hm_recommended.</li>
    <li>A pure approver (ED) can approve straight from pending review.</li>
    </ul>
    <h2>Add a contractor</h2>
    <ol>
    <li>Open <strong>Contractors</strong> and choose <strong>Add Contractor</strong>.</li>
    <li>Enter the business name, trade, address, and <strong>key contacts</strong> (people), each with a phone and email.</li>
    <li>Record compliance: <strong>WSIB clearance</strong> and <strong>liability insurance</strong>, with expiry dates and uploaded documents.</li>
    <li>Save. A new contractor starts as a draft.</li>
    <li>When ready, <strong>recommend</strong> it (moves to pending review) &mdash; this notifies management.</li>
    </ol>
    <h2>Approve a contractor</h2>
    <ol>
    <li>Open the contractor from the worklist (Contractors Waiting Approval) or the registry.</li>
    <li>Review the trade, contacts, and compliance documents and expiry dates.</li>
    <li><strong>Approve</strong>, <strong>Return</strong>, or <strong>Decline</strong>. Each sends the configured email and writes an audit entry.</li>
    </ol>
    <h2>Compliance (WSIB &amp; insurance)</h2>
    <ul>
    <li>The card tracks WSIB clearance and liability insurance with expiry dates.</li>
    <li>Expired compliance shows as a flag. Awarding an RFQ to a contractor with expired or missing compliance <strong>warns</strong> (it does not hard-block).</li>
    </ul>
    <h2>Invite to portal</h2>
    <p>If the Contractor Portal is enabled, use <strong>Invite to portal</strong> on the contractor card to text a sign-in link to chosen key contacts. See the Contractor Portal procedure for the full flow.</p>
    <h2>Notes and cautions</h2>
    <ul>
    <li><strong>Contractor details live in a data blob</strong> &mdash; only name, trade, and status are top-level; contacts, phone, email, and compliance ride the contractor's data. This matters only for exports/integration.</li>
    <li>Keep compliance expiry dates current so RFQ eligibility warnings are accurate.</li>
    <li>The recommend step is retained even when one person can both recommend and approve, so there is always a two-check trail where roles allow.</li>
    <li>All actions are recorded in the Audit Log.</li>
    </ul>`;

  var MOD_PORTAL = `
    <p>The Contractor Portal is a contractor-facing site where an invited contractor signs in by phone, sees only their own assigned work orders, and submits photos, invoices, notes, and percent-complete. Staff review those in the app. The module is <strong>off by default</strong> and must be enabled per nation.</p>
    <div class="ht-fig"><div class="ht-flow">
    <div class="ht-fstep"><span class="ht-fnum">1</span><div class="ht-fttl">Invite</div><div class="ht-fsub">Staff text a sign-in link to a key contact.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">2</span><div class="ht-fttl">Sign in</div><div class="ht-fsub">Contractor enters their phone + one-time code.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">3</span><div class="ht-fttl">See jobs</div><div class="ht-fsub">Only their own assigned work orders.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">4</span><div class="ht-fttl">Submit</div><div class="ht-fsub">Photos, invoice, notes, % complete.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">5</span><div class="ht-fttl">Staff review</div><div class="ht-fsub">Approve invoices; view photos and notes.</div></div>
    </div></div>
    <h2>Who does what</h2>
    <table><thead><tr><th>Who</th><th>Does</th></tr></thead><tbody>
    <tr><td>HM / ED</td><td>Invite a contractor's key contact, assign work to that contractor.</td></tr>
    <tr><td>Management</td><td>Review the Contractor Submissions worklist &mdash; approve/reject invoices, view photos and notes.</td></tr>
    <tr><td>Contractor</td><td>Signs in by phone, views work orders, uploads photos/invoices/notes, sets progress.</td></tr>
    </tbody></table>
    <h2>How a contractor gets access</h2>
    <p>Access needs <strong>two</strong> things, both anti-impersonation:</p>
    <ol>
    <li>Staff <strong>invite</strong> the contractor's key contact (whose phone must already be on the contractor's people list).</li>
    <li>The contractor signs in by <strong>phone one-time code (OTP)</strong> and is linked only if an unused, unexpired invite matches that phone <strong>and</strong> that phone is on the contractor's people list.</li>
    </ol>
    <h2>Invite a contractor (staff)</h2>
    <ol>
    <li>Open the contractor's card.</li>
    <li>Click <strong>Invite to portal</strong> in the footer.</li>
    <li>Pick which key contacts should get the sign-in text (only people already on the contractor file).</li>
    <li>Send. The chosen numbers are authorized and a courtesy email goes out.</li>
    <li>Assign a Maintenance Request to that contractor so a work order appears in their portal.</li>
    </ol>
    <h2>The contractor signs in and submits</h2>
    <ol>
    <li>The contractor opens the portal link and enters their mobile number.</li>
    <li>They enter the 6-digit code texted to them.</li>
    <li>They see only their own assigned work orders &mdash; tenant contact to coordinate access, scope, hazards, target dates, housing contact. Internal data (cost, budget, approval chain) is hidden.</li>
    <li>Per job they can upload <strong>photos</strong>, upload an <strong>invoice</strong>, add a <strong>note</strong>, and set <strong>% complete</strong>.</li>
    </ol>
    <h2>Review submissions (staff)</h2>
    <ol>
    <li>On the landing page, open the <strong>Contractor Submissions</strong> worklist section (management only).</li>
    <li><strong>Invoice</strong> &rarr; Approve (adds an unpaid draw to the request's Payments tab) or Reject. Invoices do not auto-create a draw.</li>
    <li><strong>Photo</strong> &rarr; auto-filed to the unit's Documents and flagged; View or Mark read.</li>
    <li><strong>Note</strong> &rarr; logged against the request and flagged; View or Mark read.</li>
    <li>The contractor's % complete feeds the staff Progress column immediately (a staff edit overrides it, last write wins).</li>
    </ol>
    <h2>Notes and cautions</h2>
    <ul>
    <li><strong>The invite alone does not grant access</strong> &mdash; the phone must also be on the contractor's people list. Keep contractor contact phones accurate.</li>
    <li>The portal requires the Phone sign-in provider and an SMS provider configured for your nation, plus the portal migrations.</li>
    <li>A contractor whose work orders are all in-house or unassigned sees an empty list &mdash; assign them a job first.</li>
    <li>Staff can preview exactly what a contractor sees via <strong>Preview portal view</strong>.</li>
    <li>All submissions and file accesses are recorded in the Audit Log.</li>
    </ul>`;

  var MOD_INSPECTIONS = `
    <p>Inspections record a unit's condition room-by-room &mdash; move-in, move-out, annual, routine, or emergency. A failed inspection can spawn a Maintenance Request, and a completed report generates a PDF. The module is gated in Settings &rarr; Nation &rarr; Modules.</p>
    <div class="ht-fig"><div class="ht-flow">
    <div class="ht-fstep"><span class="ht-fnum">1</span><div class="ht-fttl">New inspection</div><div class="ht-fsub">Unit, type, date, inspector.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">2</span><div class="ht-fttl">Checklist</div><div class="ht-fsub">Room-by-room: pass / fail / needs-repair.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">3</span><div class="ht-fttl">Photos &amp; notes</div><div class="ht-fsub">Attach photos; write general notes.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">4</span><div class="ht-fttl">Approve report</div><div class="ht-fsub">Authorized approver stamps the sign-off.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">5</span><div class="ht-fttl">Spawn repairs</div><div class="ht-fsub">A fail can open a Maintenance Request.</div></div>
    </div></div>
    <h2>Who does what</h2>
    <ul><li>Housing staff can create and fill inspections. <strong>Sign-off</strong> requires the Approve Inspection authority (default HM/ED).</li></ul>
    <h2>Run an inspection</h2>
    <ol>
    <li>Open <strong>Inspections</strong> (Operations nav) and click <strong>New Inspection</strong>.</li>
    <li>Pick the <strong>unit</strong>, the <strong>type</strong> (Move-In / Move-Out / Annual / Routine / Emergency), the <strong>date</strong>, and the <strong>inspector</strong>.</li>
    <li>Work the room-by-room checklist (Exterior, Interior, Kitchen, Bathroom(s), Bedrooms, Mechanical, Utility Connections). Rate each item pass / fail / needs-repair with notes.</li>
    <li>Add custom items with <strong>+ Add row</strong> in any section if something is not covered.</li>
    <li>Add <strong>photos</strong> in the Photos &amp; Documents library.</li>
    <li>Write <strong>general notes</strong> (use Draft with AI to summarize findings if the AI module is on).</li>
    <li>Save. The overall status is pending / pass / fail / needs-repair.</li>
    </ol>
    <h2>Approve the report</h2>
    <ol>
    <li>An authorized approver opens the completed inspection.</li>
    <li>Click <strong>Approve Report</strong> &mdash; this stamps who approved it and when.</li>
    <li><strong>Revoke Approval</strong> clears the stamp if needed.</li>
    </ol>
    <h2>Spawning repair work</h2>
    <p>A failed or needs-repair inspection can <strong>spawn a Maintenance Request</strong> for the unit, carrying the findings into the renovation workflow.</p>
    <h2>Inspection dates on the unit</h2>
    <ul><li>The unit card carries <strong>Last inspection date</strong> and <strong>Next inspection due</strong>. Overdue inspections surface on the Leadership Dashboard and reports.</li></ul>
    <h2>Notes and cautions</h2>
    <ul>
    <li><strong>Normal saves preserve the approval stamp</strong> &mdash; only Approve/Revoke change it.</li>
    <li>Custom checklist rows save, reload, and print in the PDF just like default rows.</li>
    <li>Photos use the shared document library scoped to the inspection.</li>
    <li>The module and the Approve Inspection authority both need to be set for sign-off.</li>
    <li>All actions are recorded in the Audit Log.</li>
    </ul>`;

  var MOD_PROJECTS = `
    <p>Capital Projects track funded initiatives &mdash; developing lots, building houses, infrastructure &mdash; with milestones, budget-vs-actual costs, grants, funder payment requests (claims), lots, and unit creation. Reference numbers are CP-YYYY-NN. (This is distinct from a Maintenance Request's internal SOW- "Project #".)</p>
    <div class="ht-fig"><div class="ht-flow">
    <div class="ht-fstep"><span class="ht-fnum">1</span><div class="ht-fttl">Create (CP#)</div><div class="ht-fsub">Name, type, dates; first save assigns the number.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">2</span><div class="ht-fttl">Grants &amp; milestones</div><div class="ht-fsub">Add grants; set milestone budgets.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">3</span><div class="ht-fttl">Log costs</div><div class="ht-fsub">Expenses with invoice / EFT / bank docs.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">4</span><div class="ht-fttl">Claim</div><div class="ht-fsub">Payment request to a funder (docs gated).</div></div>
    <div class="ht-fstep"><span class="ht-fnum">5</span><div class="ht-fttl">Lots &amp; units</div><div class="ht-fsub">Add lots; create units from lots.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">6</span><div class="ht-fttl">Allocate</div><div class="ht-fsub">Split costs across the units (ED).</div></div>
    </div></div>
    <h2>Who can use it</h2>
    <ul>
    <li><strong>Create/edit, lots, units:</strong> Manage Projects authority (HM/ED default).</li>
    <li><strong>Allocate costs to units:</strong> Allocate Costs authority (ED default).</li>
    <li>Everyone else with housing access gets a read-only project modal.</li>
    </ul>
    <h2>The project tabs</h2>
    <table><thead><tr><th>Tab</th><th>What it holds</th></tr></thead><tbody>
    <tr><td>Overview</td><td>Name, type, status, funding source, budget, dates, PO #, Department #, grants, linked RFQs.</td></tr>
    <tr><td>Milestones</td><td>The project's checklist of milestones (per-type templates, drag to reorder, done-toggle).</td></tr>
    <tr><td>P &amp; L</td><td>Budget-vs-actual with variance, one row per milestone.</td></tr>
    <tr><td>Costs</td><td>Expenses, expense documents, and payment requests to funders.</td></tr>
    <tr><td>Lots &amp; Units</td><td>Lots and the units created from them.</td></tr>
    <tr><td>Documents</td><td>The project's document library.</td></tr>
    </tbody></table>
    <h2>Create a project &mdash; step by step</h2>
    <ol>
    <li>Open <strong>Capital Projects</strong> (Operations nav) and click <strong>New Project</strong>.</li>
    <li>Enter the <strong>name</strong>, pick the <strong>type</strong> (lot development, house build, mixed, commercial, band building, infrastructure), set the <strong>status</strong>, the <strong>start</strong> and <strong>target</strong> dates, and the funding.</li>
    <li>Click <strong>Save</strong> &mdash; this assigns the <strong>CP-YYYY-NN</strong> number. (Auto-save only begins after this first explicit save; until then the indicator reads "Draft &mdash; not saved yet".)</li>
    <li>On <strong>Overview</strong>, add one or more <strong>grants</strong> (source, reference, amount). When grants exist, the budget is their sum and the funding source becomes the funder names.</li>
    <li>On <strong>Milestones</strong>, apply or adjust the per-type checklist (add, rename, drag the handle to reorder). Set each milestone's <strong>budget</strong> on the <strong>P &amp; L</strong> tab.</li>
    </ol>
    <h2>Log a cost</h2>
    <ol>
    <li>Open <strong>Costs</strong> and use the Log-an-Expense form.</li>
    <li>Pick the <strong>vendor</strong> (typeahead over contractors) or enter a manual vendor with business name, address, and phone.</li>
    <li>Enter the amount and tag it to a milestone (optional).</li>
    <li>Attach the three compliance documents &mdash; <strong>invoice, EFT confirmation, bank statement</strong>.</li>
    <li>Add the expense. It persists immediately on a saved project.</li>
    </ol>
    <h2>Claim to a funder (payment request)</h2>
    <ol>
    <li>On <strong>Costs</strong>, tick the cost lines to claim.</li>
    <li>Click <strong>New Payment Request</strong>, choose the grant and date.</li>
    <li>Compliance docs are a <strong>hard gate</strong> &mdash; any selected line missing any of its three documents blocks the export until fixed or unticked.</li>
    <li><strong>Export &amp; Mark Claimed</strong> generates the claim summary PDF and downloads every attached compliance document.</li>
    <li>Claimed lines are badged (not locked) &mdash; a cost can be in more than one funder claim.</li>
    </ol>
    <h2>Add lots and create units &mdash; step by step</h2>
    <ol>
    <li>Open the project &rarr; <strong>Lots &amp; Units</strong> tab.</li>
    <li>Click <strong>+ Add Lots</strong>. Set <strong>How many lots</strong>, <strong>Numbering starts at</strong>, the <strong>Lot number prefix</strong> (default "Lot "), and the initial <strong>Status</strong> (raw / serviced / built). Add a shared address/subdivision and legal description if you have them, then click <strong>Add Lots</strong>.</li>
    <li>As work progresses, update each lot's <strong>status</strong> (raw &rarr; serviced &rarr; built) from its row.</li>
    <li>To attach a unit that already exists, use <strong>Link existing unit</strong> on the lot's row.</li>
    <li>To build new units, click <strong>Create Units from Lots</strong>. Fill the shared unit details (Street, Bedrooms, Bathrooms, Type, Funder, Year Built), tick the lots to build on, give each an editable unit number, and click <strong>Create Units</strong>. Each new unit is linked to its lot and the project, and the lot flips to <strong>built</strong>.</li>
    </ol>
    <h2>Allocate costs to units</h2>
    <ol>
    <li>Click <strong>Allocate Costs to Units</strong> (Allocate Costs authority).</li>
    <li>Choose the basis (actuals to date or funded budget).</li>
    <li>Review the per-unit preview, then confirm &mdash; the cost is split evenly (cents-safe) across the units.</li>
    </ol>
    <h2>Notes and cautions</h2>
    <ul>
    <li><strong>"Capital Project" (CP-) is not the same as a Maintenance Request's "Project #" (SOW-).</strong></li>
    <li>Compliance docs can be <strong>shared</strong> across cost lines (one EFT batch, one bank statement) &mdash; the app links the existing file rather than forcing a re-upload.</li>
    <li>The <strong>Status Report</strong> footer button generates a one-click PDF snapshot, available to read-only viewers too.</li>
    <li>Cost allocation never overwrites a unit's insured value when it is already set.</li>
    <li>All actions are recorded in the Audit Log.</li>
    </ul>`;

  var MOD_FINANCE = `
    <p>The Finance module manages the money side of housing &mdash; rent ledgers, loans, invoices, payment arrangements, collections, the journal, and hydro/gas. It shares tenant records with the housing side so each person's history aggregates under one profile.</p>
    <div class="ht-fig"><div class="ht-flow">
    <div class="ht-fstep"><span class="ht-fnum">1</span><div class="ht-fttl">Find the tenant</div><div class="ht-fsub">Search is deduped &mdash; one person, one row.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">2</span><div class="ht-fttl">Open their ledger</div><div class="ht-fsub">Charges, payments, running balance.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">3</span><div class="ht-fttl">Record the entry</div><div class="ht-fsub">Payment, invoice, loan or arrangement.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">4</span><div class="ht-fttl">Balance updates</div><div class="ht-fsub">Posted and written to the finance audit.</div></div>
    </div></div>
    <h2>Who can use it</h2>
    <ul><li>CFO and Finance staff (gated per finance table). ED has access.</li></ul>
    <h2>What it covers</h2>
    <table><thead><tr><th>Area</th><th>What it does</th></tr></thead><tbody>
    <tr><td>Rent ledger</td><td>Charges and payments per tenant, with running balances.</td></tr>
    <tr><td>Loans</td><td>Tenant loans with a repayment schedule and approval.</td></tr>
    <tr><td>Invoices</td><td>Billing a tenant, plus batch and rent-run invoicing.</td></tr>
    <tr><td>Arrangements</td><td>Payment arrangements for tenants in arrears.</td></tr>
    <tr><td>Collections</td><td>Follow-up on overdue balances.</td></tr>
    <tr><td>Journal</td><td>General journal entries.</td></tr>
    <tr><td>Hydro / Gas</td><td>Utility charges tied to tenant accounts.</td></tr>
    </tbody></table>
    <h2>Post a payment</h2>
    <ol>
    <li>Open <strong>Finance</strong> and find the tenant (search is deduped so one person shows once).</li>
    <li>Open their rent ledger.</li>
    <li>Record the payment with its date and amount.</li>
    <li>The running balance updates and the entry is audited.</li>
    </ol>
    <h2>Set up a payment arrangement</h2>
    <ol>
    <li>Find the tenant in arrears.</li>
    <li>Create an <strong>arrangement</strong> with the agreed instalments.</li>
    <li>Generate the arrangement agreement PDF for signature.</li>
    <li>Track adherence against the schedule.</li>
    </ol>
    <h2>Duplicate tenants and one profile</h2>
    <ul>
    <li>Because a tenant row is created on each unit assignment, one person can have several rows. The housing-side <strong>Merge Duplicates</strong> tool points duplicates at a canonical person.</li>
    <li>Finance respects this end-to-end: ledgers, loans, arrangements, collections, and journal entries all aggregate under the canonical person, and merged-away duplicates are never billed.</li>
    </ul>
    <h2>Notes and cautions</h2>
    <ul>
    <li><strong>Do not create tenant rows by hand</strong> &mdash; tenancy flows from the housing side (assigning a unit).</li>
    <li>Saves are resilient: a failure shows a red message; success is silent. Work is not lost on a slow connection (it queues).</li>
    <li>Ledger entries use a <strong>void</strong> pattern, not deletion; entity records are soft-deleted (archived).</li>
    <li>Finance has its <strong>own</strong> append-only audit trail, separate from the housing Audit Log.</li>
    <li>The Finance module must be enabled.</li>
    </ul>`;

  var MOD_EMAIL_INTAKE = `
    <p>Email Intake lets staff forward an email to the nation's intake address and have it land in a triage queue, where it is filed to a unit or tenant. It is triage-first &mdash; nothing is filed automatically. Gated by the Email Intake module.</p>
    <div class="ht-fig"><div class="ht-flow">
    <div class="ht-fstep"><span class="ht-fnum">1</span><div class="ht-fttl">Forward the email</div><div class="ht-fsub">From a staff work email to the intake address.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">2</span><div class="ht-fttl">Lands in triage</div><div class="ht-fsub">Shows as &ldquo;Needs filing&rdquo;.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">3</span><div class="ht-fttl">Review &amp; assign</div><div class="ht-fsub">Check the attachment, pick the unit.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">4</span><div class="ht-fttl">Files to Documents</div><div class="ht-fsub">On the unit &mdash; and the tenant&rsquo;s profile.</div></div>
    </div></div>
    <h2>Email a document to a tenant's file</h2>
    <p>This is the quickest way to get a PDF, photo, or scanned letter onto a tenant's file without logging in and uploading &mdash; just email it in:</p>
    <ol>
    <li>From your work email, <strong>forward or send the message with the document attached</strong> to the nation's intake address (shown on the Email Intake page, and set in Settings &rarr; Nation).</li>
    <li>Open <strong>Email Intake</strong> (Operations nav) and find your email in the triage queue (it shows as <em>Needs filing</em>).</li>
    <li>Open the item, check the attachment, and <strong>assign</strong> it to the tenant's unit (use a suggested match or search for the address).</li>
    <li>The document now appears on that unit's <strong>Documents</strong> tab &mdash; and because a unit and the tenant living in it share one document file, it also appears on the <strong>tenant's profile</strong> (the tenant card's Documents tab). Filing it once puts it in both places.</li>
    </ol>
    <h2>Who can use it</h2>
    <ul><li>Housing staff triage and file. The forwarding address only accepts mail from active staff, so a document must be sent from a staff member's own work email to be accepted.</li></ul>
    <h2>How it works</h2>
    <ol>
    <li>A staff member forwards an email to the nation's intake address (shown as a banner on the Email Intake page, set in Settings &rarr; Nation).</li>
    <li>The email, with attachments, lands in the <strong>triage queue</strong> as a new item.</li>
    <li>Staff open it, review the sender, subject, plain-text body, and attachments, and <strong>assign</strong> it to a unit.</li>
    <li>On assign, the attachments and body file into that unit's Documents &mdash; which is the same document file the tenant's profile shows &mdash; and the item is marked assigned.</li>
    </ol>
    <h2>Triage an email</h2>
    <ol>
    <li>Open <strong>Email Intake</strong> (Operations nav). Items show as Needs filing / Filed / Dismissed.</li>
    <li>Open an item to see the sender, subject, body preview, attachments, and any suggested matches.</li>
    <li>To open an attachment, confirm the "unverified external file &mdash; scan first" prompt, then view it.</li>
    <li><strong>Assign</strong> the item to the correct unit (use a suggested match or search). The files land on that unit's Documents tab.</li>
    <li>Or <strong>Dismiss</strong> an item that does not need filing.</li>
    </ol>
    <h2>Notes and cautions</h2>
    <ul>
    <li><strong>Nothing files itself</strong> &mdash; every email waits in triage until a staff member assigns or dismisses it.</li>
    <li>The intake address only accepts mail from <strong>active staff</strong>, which filters spam. Treat attachments as external files and scan before opening.</li>
    <li>The body is always stored as plain text, so staff never open attacker HTML.</li>
    <li>The <strong>Forwarded by</strong> column shows which employee forwarded the email.</li>
    <li>Setup (the address, the mail routing, the shared secret) is a one-time per-nation configuration.</li>
    <li>All filings and dismissals are recorded in the Audit Log.</li>
    </ul>`;

  var MOD_AI = `
    <p>The AI Assistant is a staff chat helper that answers questions about applications, units, maintenance requests, renovations, contractors, inspections, capital projects, policy, and how-to procedures &mdash; and can draft professional decision notes. It is available on every page via the AI button.</p>
    <div class="ht-fig"><div class="ht-flow">
    <div class="ht-fstep"><span class="ht-fnum">1</span><div class="ht-fttl">Open the AI panel</div><div class="ht-fsub">The ✦ button in the header.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">2</span><div class="ht-fttl">Ask in plain language</div><div class="ht-fsub">Counts, lists, or how-to questions.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">3</span><div class="ht-fttl">It reads (never writes)</div><div class="ht-fsub">Within your role&rsquo;s data limits.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">4</span><div class="ht-fttl">You decide</div><div class="ht-fsub">Review any drafted note before saving.</div></div>
    </div></div>
    <h2>Who can use it</h2>
    <ul><li>Staff. What it can read is limited by the signed-in staff member's role (finance tables only for ED/CFO/Finance; applications hidden from field employees).</li></ul>
    <h2>The two ways to use it</h2>
    <table><thead><tr><th>Surface</th><th>What it does</th></tr></thead><tbody>
    <tr><td>Chat panel (AI button)</td><td>Ask questions in plain language. It answers from the data on your screen, and for exact counts or complete lists it can run a read-only database lookup.</td></tr>
    <tr><td>Draft with AI</td><td>On an approval, fills the notes box with a professional decision note for the current application and action, which you then edit.</td></tr>
    </tbody></table>
    <h2>Ask a question</h2>
    <ol>
    <li>Click the <strong>AI</strong> button in the header to open the chat panel.</li>
    <li>Type a question &mdash; for example "how many applicants are waiting to be matched?" or "how do I complete a maintenance request?"</li>
    <li>Read the answer. For counts and lists it may look records up directly; for how-to questions it explains the real steps.</li>
    </ol>
    <h2>Draft a decision note</h2>
    <ol>
    <li>Open an application's approval modal.</li>
    <li>Click <strong>Draft with AI</strong>.</li>
    <li>The notes box fills with a drafted note. <strong>Review and edit it</strong> before you approve &mdash; it is a starting point, not a final decision.</li>
    </ol>
    <h2>Notes and cautions</h2>
    <ul>
    <li><strong>Read-only.</strong> The assistant can read data (within your role's limits) but has <strong>no ability to change anything</strong>.</li>
    <li><strong>It respects your role</strong> &mdash; it cannot show you data your role is not allowed to see.</li>
    <li>Always <strong>review AI-drafted notes</strong> before saving &mdash; you are accountable for the decision.</li>
    <li>Every AI interaction is logged in the Audit Log.</li>
    <li>The module can be turned off per nation. The assistant cannot browse the internet.</li>
    </ul>`;

  var MOD_LEADERSHIP = `
    <p>The Leadership Dashboard is a read-only, at-a-glance view of the nation's housing picture for Chief &amp; Council. It summarizes data already in the app &mdash; no new queries, and no data leaves the nation's control.</p>
    <div class="ht-fig"><div class="ht-flow">
    <div class="ht-fstep"><span class="ht-fnum">1</span><div class="ht-fttl">Open Council</div><div class="ht-fsub">From the top navigation.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">2</span><div class="ht-fttl">Read the KPI cards</div><div class="ht-fsub">Units, occupancy, waitlist, renos.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">3</span><div class="ht-fttl">Show the charts</div><div class="ht-fsub">Trends by tier, type and pipeline.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">4</span><div class="ht-fttl">Drill down</div><div class="ht-fsub">Go to the source page for detail.</div></div>
    </div></div>
    <h2>Who can use it</h2>
    <ul><li>Configurable, not hardcoded. Access is controlled by the <strong>Access Leadership Dashboard</strong> authority (default ED and Housing Manager) in Settings &rarr; Approval Authority. The ED can grant it to Council members' roles.</li></ul>
    <h2>How to open it</h2>
    <ul><li>Click the <strong>Council</strong> item in the top navigation.</li></ul>
    <h2>What it shows</h2>
    <ul>
    <li><strong>KPI cards:</strong> total units, occupancy, vacant units, waitlist size, applicants awaiting match, active renovations, and overdue inspections.</li>
    <li><strong>Charts:</strong> occupancy breakdown, waitlist by priority tier, applications by type, renovation spending by work category, the renovation pipeline, and a 12-month applications trend.</li>
    </ul>
    <h2>Use the dashboard in a meeting</h2>
    <ol>
    <li>Open <strong>Council</strong> from the nav.</li>
    <li>Read the KPI cards for the headline numbers.</li>
    <li>Use the charts to show trends.</li>
    <li>For detail behind a number, go to the underlying page (Applications, Inventory, Renovations).</li>
    </ol>
    <h2>Notes and cautions</h2>
    <ul>
    <li><strong>Read-only and private.</strong> It only summarizes data already in the app; nothing is editable here and no information is sent to an outside service.</li>
    <li>Access is set in Settings, so you can give Council members a view without edit rights elsewhere.</li>
    <li>Charts load on first open; if the chart library cannot load, the KPI numbers still show.</li>
    <li>Finance KPIs are deferred until the finance model is fully built out.</li>
    </ul>`;

  var MOD_HELP = `
    <p>Help &amp; Training is this library &mdash; the in-app standard operating procedures (and, in time, training videos). It opens as a full-screen reader, styled in the nation's own branding, so staff can look up how to do something without leaving the app.</p>
    <div class="ht-fig"><div class="ht-flow">
    <div class="ht-fstep"><span class="ht-fnum">1</span><div class="ht-fttl">Open the avatar menu</div><div class="ht-fsub">Top-right, then Help &amp; Training.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">2</span><div class="ht-fttl">Pick a category</div><div class="ht-fsub">Guides, Modules or Settings.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">3</span><div class="ht-fttl">Search or browse</div><div class="ht-fsub">Filter the sidebar by keyword.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">4</span><div class="ht-fttl">Read the procedure</div><div class="ht-fsub">In your nation&rsquo;s branding.</div></div>
    </div></div>
    <h2>Who can use it</h2>
    <ul><li>Everyone. It is available on every page.</li></ul>
    <h2>How to open it</h2>
    <ol>
    <li>Click your <strong>avatar</strong> (top-right).</li>
    <li>Choose <strong>Help &amp; Training</strong>.</li>
    <li>The library opens full-screen. Use the sidebar to pick a document, or the search box to find one; the Training Videos entry holds videos as they are added.</li>
    </ol>
    <h2>What is in it</h2>
    <ul>
    <li><strong>Guides</strong> &mdash; the broad end-to-end housing and contractor workflows.</li>
    <li><strong>Modules</strong> &mdash; a detailed procedure per feature area.</li>
    <li><strong>Settings</strong> &mdash; a procedure per Settings tab.</li>
    <li>A Training Videos area (placeholder until videos are produced).</li>
    </ul>
    <h2>How branding works</h2>
    <ul>
    <li>The SOP content is <strong>nation-neutral</strong> &mdash; no nation name, logo, or colour is baked in.</li>
    <li>The app supplies branding at view time: the header logo, the nation name, and every colour come from your saved theme (Settings &rarr; Themes).</li>
    </ul>
    <h2>Notes and cautions</h2>
    <ul>
    <li><strong>This is reference, not a control panel</strong> &mdash; reading an SOP changes nothing in the app.</li>
    <li>The canonical editable masters live as separate documents (one per module, one per Settings tab); when a master changes, the in-app copy is updated.</li>
    <li>If the logo or colours look wrong in the reader, check Settings &rarr; Themes.</li>
    </ul>`;

  var MOD_2FA = `
    <p>Two-factor authentication (2FA) adds a second step to staff sign-in: after your email and password, you enter a 6-digit code from an authenticator app on your phone. It is opt-in &mdash; if you do not turn it on, you sign in exactly as before.</p>
    <p class="ht-fig-note" style="font-size:12px;color:var(--muted);margin:0 0 4px;">Sign-in with 2FA on:</p>
    <div class="ht-fig"><div class="ht-chain">
    <span class="ht-cpill">Email &amp; password</span><span class="ht-carrow">&rarr;</span>
    <span class="ht-cpill">6-digit code</span><span class="ht-carrow">&rarr;</span>
    <span class="ht-cpill ht-on">Signed in</span>
    </div></div>
    <h2>Who can use it</h2>
    <ul><li>Any staff member can turn it on for their own account from the avatar menu. It affects only your own sign-in.</li></ul>
    <h2>What you need</h2>
    <ul><li>An authenticator app on your phone &mdash; Google Authenticator, Microsoft Authenticator, Authy, or 1Password all work.</li></ul>
    <h2>Turn on 2FA</h2>
    <ol>
    <li>Click your <strong>avatar</strong> (top-right) and choose <strong>Two-Factor Authentication</strong>.</li>
    <li>Click <strong>Set up two-factor</strong>.</li>
    <li>In your authenticator app, add an account and <strong>scan the QR code</strong> shown (or type the manual key if you cannot scan).</li>
    <li>Enter the <strong>6-digit code</strong> your app now shows and confirm. 2FA is now ON for your account.</li>
    </ol>
    <h2>Signing in with 2FA on</h2>
    <ol>
    <li>Enter your email and password and click <strong>Sign in</strong>.</li>
    <li>A <strong>Two-factor verification</strong> box appears. Open your authenticator app, read the current 6-digit code for this account, type it in, and click <strong>Verify</strong>.</li>
    <li>Codes change every 30 seconds &mdash; if one is rejected, wait for the next code and try again.</li>
    </ol>
    <h2>Turn off 2FA</h2>
    <ol>
    <li>Click your <strong>avatar</strong> &rarr; <strong>Two-Factor Authentication</strong>.</li>
    <li>Click <strong>Turn off two-factor</strong>. Your next sign-in will be email + password only.</li>
    </ol>
    <h2>Lost or replaced phone</h2>
    <ul>
    <li>If you can still sign in, turn 2FA off (above) and set it up again on the new phone.</li>
    <li>If you are locked out (no access to the codes), ask your <strong>ED / administrator</strong> to remove the second factor from your account. You can then sign in with your password and set 2FA up again.</li>
    </ul>
    <h2>Notes and cautions</h2>
    <ul>
    <li><strong>It protects only your own account</strong> &mdash; each staff member turns it on for themselves.</li>
    <li>Keep your authenticator app and phone backed up so a lost phone does not lock you out.</li>
    <li>2FA must be enabled for your nation before setup works; if the setup screen says it is unavailable, your administrator needs to enable it first.</li>
    <li>If the code box does not appear at sign-in, do a hard refresh of the page and try again.</li>
    </ul>`;

  // ---- SETTINGS SOPs (one per Settings tab) --------------------------------

  var SET_NATION = `
    <p>The Nation &amp; Modules tab shows which nation the app is running for and which optional modules are turned on. Identity and contact details are <strong>read-only</strong> here (set at app setup); module on/off toggles are the one thing a super user changes day-to-day.</p>
    <div class="ht-fig"><div class="ht-flow">
    <div class="ht-fstep"><span class="ht-fnum">1</span><div class="ht-fttl">Open Nation</div><div class="ht-fsub">Scroll to the Modules list.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">2</span><div class="ht-fttl">Find the module</div><div class="ht-fsub">One row per optional module.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">3</span><div class="ht-fttl">Toggle On / Off</div><div class="ht-fsub">Saves at once, writes to the audit.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">4</span><div class="ht-fttl">Appears next load</div><div class="ht-fsub">Nav tiles show or hide.</div></div>
    </div></div>
    <h2>Who can use this tab</h2>
    <ul>
    <li><strong>Open and view:</strong> any staff member with Settings access.</li>
    <li><strong>Toggle modules on/off:</strong> super user / ED only.</li>
    <li>Identity, positions, and contact fields are reference-only here &mdash; edited through the admin console.</li>
    </ul>
    <h2>What the tab shows</h2>
    <ol>
    <li><strong>Identity</strong> &mdash; display name, short name, and logo. These drive the app title, every PDF header, and the branding staff and applicants see.</li>
    <li><strong>Positions / role labels</strong> &mdash; the friendly names your nation uses for each staff role.</li>
    <li><strong>Modules</strong> &mdash; one row per optional module, each with an on/off toggle.</li>
    <li><strong>Usage</strong> &mdash; a summary of current activity.</li>
    </ol>
    <h2>Turn a module on or off</h2>
    <ol>
    <li>Open <strong>Settings &rarr; Nation</strong> and scroll to <strong>Modules</strong>.</li>
    <li>Find the module's row and click its toggle to switch it On or Off.</li>
    <li>The change saves immediately and is written to the audit log.</li>
    <li>Nav tiles and entry points appear (or disappear) on the next page load.</li>
    </ol>
    <h2>Module reference</h2>
    <table><thead><tr><th>Module</th><th>What it enables</th></tr></thead><tbody>
    <tr><td>Finance</td><td>Rent ledger, loans, invoices, arrangements, collections, journal, hydro/gas.</td></tr>
    <tr><td>Match</td><td>The Match page that places approved applicants into vacant units.</td></tr>
    <tr><td>Contractors</td><td>The contractor registry (auto-enabled when Renovations is on).</td></tr>
    <tr><td>Renovations</td><td>Maintenance Requests, scopes of work, progress, reno approvals.</td></tr>
    <tr><td>RFQ</td><td>Requests for Quotes and contractor contracts.</td></tr>
    <tr><td>Mapping</td><td>Unit location pins and the Set Location &amp; Photo tool.</td></tr>
    <tr><td>AI Assistant</td><td>The chat assistant and Draft-with-AI note helper.</td></tr>
    <tr><td>Inspections</td><td>Unit-condition inspection reports.</td></tr>
    <tr><td>Capital Projects</td><td>Funded builds and lot development, milestones, claims.</td></tr>
    <tr><td>Email Intake</td><td>Forward-to-file email triage queue.</td></tr>
    <tr><td>SMS Notifications</td><td>Text-message notifications (e.g. contractor work orders).</td></tr>
    <tr><td>Contractor Portal</td><td>The contractor-facing portal (off by default).</td></tr>
    </tbody></table>
    <h2>Notes and cautions</h2>
    <ul>
    <li><strong>Core features cannot be disabled</strong> &mdash; Applications, Inventory, Tenants, and the Worklist are always on.</li>
    <li><strong>Turning on Renovations also turns on Contractors.</strong></li>
    <li>A module your nation has not licensed will not appear as a toggle.</li>
    <li>Turning a module off hides its pages but does not delete data; turning it back on restores access.</li>
    <li>Every toggle is recorded in the Audit Log.</li>
    </ul>`;

  var SET_THEMES = `
    <p>The Themes tab customizes the app's brand colours and logo. Changes apply <strong>live to every page</strong>, including printed PDF reports, the moment you save &mdash; no deploy or reload needed.</p>
    <div class="ht-fig"><div class="ht-chain">
    <span class="ht-cpill">Pick colour &amp; logo</span><span class="ht-carrow">&rarr;</span>
    <span class="ht-cpill">Save</span><span class="ht-carrow">&rarr;</span>
    <span class="ht-cpill ht-on">Live on every page &amp; PDF</span>
    </div></div>
    <h2>Who can use this tab</h2>
    <ul><li>Super user / ED. Other staff can see the tab but should not change branding without approval.</li></ul>
    <h2>What you can change</h2>
    <table><thead><tr><th>Setting</th><th>Effect</th></tr></thead><tbody>
    <tr><td>Primary / accent colour</td><td>The main brand colour for buttons, headings, highlights, and accents throughout the app, and on PDF headers.</td></tr>
    <tr><td>Logo</td><td>The image in the app header and at the top of every generated PDF.</td></tr>
    <tr><td>Supporting colours</td><td>Secondary tones for text, borders, and surfaces where the theme exposes them.</td></tr>
    </tbody></table>
    <h2>Change the accent colour</h2>
    <ol>
    <li>Open <strong>Settings &rarr; Themes</strong>.</li>
    <li>Use the colour picker (or type a hex value). The page updates live so you can preview.</li>
    <li>Click <strong>Save</strong>. The colour is re-applied every time anyone opens the app.</li>
    </ol>
    <h2>Replace the logo</h2>
    <ol>
    <li>Open <strong>Settings &rarr; Themes</strong> and click the logo upload control.</li>
    <li>Choose your image (a PNG with a transparent background, roughly 400&ndash;800 px wide, works best).</li>
    <li>Confirm the preview and click <strong>Save</strong>. The new logo appears in the header and on the next PDF.</li>
    </ol>
    <h2>Notes and cautions</h2>
    <ul>
    <li><strong>The theme is nation-wide</strong> &mdash; a change affects every staff member and every document.</li>
    <li><strong>PDFs follow the theme</strong> &mdash; generate one work order or lease and check the header after a change.</li>
    <li>The logo in Help &amp; Training, on login, and in documents all read from this saved theme.</li>
    <li>Keep a copy of your logo file safe so you can re-upload it.</li>
    </ul>`;

  var SET_CONFIG = `
    <p>The Config tab is a <strong>read-only reference</strong> of the values your app was configured with at setup time &mdash; the database connection, email provider, storage, and other platform settings. You come here to check a value, not to change it.</p>
    <div class="ht-fig"><div class="ht-flow">
    <div class="ht-fstep"><span class="ht-fnum">1</span><div class="ht-fttl">Open Config</div><div class="ht-fsub">Read the configured value.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">2</span><div class="ht-fttl">Change elsewhere</div><div class="ht-fsub">In the linked admin console.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">3</span><div class="ht-fttl">Confirm here</div><div class="ht-fsub">Return to verify the new value.</div></div>
    </div></div>
    <h2>Who can use this tab</h2>
    <ul><li>ED / super user only. It is hidden from other roles.</li></ul>
    <h2>When to use it</h2>
    <ul>
    <li>Confirming the app is pointed at the correct nation's database and storage.</li>
    <li>Checking which email provider is configured before troubleshooting a send.</li>
    <li>Giving a support contact exact configuration values.</li>
    <li>Verifying a setting after it was changed in an admin console.</li>
    </ul>
    <h2>What the tab shows</h2>
    <table><thead><tr><th>Area</th><th>What it tells you</th></tr></thead><tbody>
    <tr><td>Backend / database</td><td>Which nation database the app is connected to.</td></tr>
    <tr><td>Storage</td><td>The file-storage bucket for uploaded documents and photos.</td></tr>
    <tr><td>Email provider</td><td>Which service sends outbound email and the from-address.</td></tr>
    <tr><td>Branding / nation</td><td>Nation identity values pulled from configuration.</td></tr>
    <tr><td>Linked consoles</td><td>Links to the admin console(s) where these values are actually edited.</td></tr>
    </tbody></table>
    <h2>Check a configured value</h2>
    <ol>
    <li>Open <strong>Settings &rarr; Config</strong> and read the value you need.</li>
    <li>If it is wrong, change it in the linked admin console (or ask your platform administrator), then return here to confirm.</li>
    </ol>
    <h2>Notes and cautions</h2>
    <ul>
    <li><strong>Nothing on this tab is editable in the app</strong> &mdash; it is a window onto setup-time configuration.</li>
    <li>Sensitive secrets (API keys, passwords) are <strong>not</strong> displayed here.</li>
    <li>If a value looks wrong and the app misbehaves, note it and raise it with your platform administrator.</li>
    </ul>`;

  var SET_LABELS = `
    <p>The Unit Labels tab configures and prints real <strong>2" &times; 1" physical labels</strong> for units. Each label carries a scan-to-report <strong>QR code</strong>, emergency contact details, and unit identification. Tenants scan the QR with a phone camera to report a maintenance issue without logging in.</p>
    <div class="ht-fig"><div class="ht-flow">
    <div class="ht-fstep"><span class="ht-fnum">1</span><div class="ht-fttl">Configure</div><div class="ht-fsub">Contacts, format, units.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">2</span><div class="ht-fttl">Print &amp; apply</div><div class="ht-fsub">On matching 2&times;1 stock.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">3</span><div class="ht-fttl">Tenant scans QR</div><div class="ht-fsub">No app, no login.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">4</span><div class="ht-fttl">Lands in the queue</div><div class="ht-fsub">Tied to the right unit.</div></div>
    </div></div>
    <h2>Who can use this tab</h2>
    <ul><li>ED / super user only.</li></ul>
    <h2>What the QR code does</h2>
    <ul>
    <li>Each unit's label has a unique QR code that opens a <strong>scan-to-report</strong> page for that specific unit.</li>
    <li>Anyone at the unit scans it with a phone camera &mdash; no app install, no login &mdash; and submits a maintenance request with a photo.</li>
    <li>The request lands in the staff maintenance review queue tied to the correct unit.</li>
    </ul>
    <h2>Configure and print labels</h2>
    <ol>
    <li>Open <strong>Settings &rarr; Unit Labels</strong>.</li>
    <li>Set the label content &mdash; emergency contact number(s) and any fixed text.</li>
    <li>Choose the print format: <strong>Laser sheet</strong>, <strong>Roll</strong>, or <strong>Metal-press</strong>.</li>
    <li>Select the units you want labels for.</li>
    <li>Generate the PDF, print on the matching stock, and apply the labels.</li>
    </ol>
    <h2>Reprint stale labels</h2>
    <ol>
    <li>Review the <strong>reprint worklist</strong> &mdash; units whose label is out of date because unit details or contacts changed.</li>
    <li>Select the flagged units, generate and print the PDF, and replace the old labels.</li>
    </ol>
    <h2>Notes and cautions</h2>
    <ul>
    <li>Labels are <strong>2" &times; 1"</strong> &mdash; use the matching stock so the QR and text line up.</li>
    <li>The QR is tied to the unit, not the tenant, so a label stays correct across tenant turnover.</li>
    <li>Test one printed label by scanning it before printing a whole batch.</li>
    <li>Keep the emergency contact number current &mdash; it prints onto every new label.</li>
    </ul>`;

  var SET_USERS = `
    <p>The Users tab manages the staff who can sign in and what role each has. This is where you add a new employee, change a role, and deactivate someone who has left.</p>
    <div class="ht-fig"><div class="ht-flow">
    <div class="ht-fstep"><span class="ht-fnum">1</span><div class="ht-fttl">Look up the email</div><div class="ht-fsub">Search before adding.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">2</span><div class="ht-fttl">Add &amp; set role</div><div class="ht-fsub">Lowest role for the job.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">3</span><div class="ht-fttl">They sign in</div><div class="ht-fsub">Landing on their role&rsquo;s home.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">4</span><div class="ht-fttl">Deactivate on exit</div><div class="ht-fsub">Keeps their history.</div></div>
    </div></div>
    <h2>Who can use this tab</h2>
    <ul>
    <li><strong>View the staff list:</strong> any staff member with Settings access.</li>
    <li><strong>Add staff / change roles / activate / deactivate:</strong> ED and Housing Manager.</li>
    </ul>
    <h2>Roles you can assign</h2>
    <table><thead><tr><th>Role</th><th>Typical use</th></tr></thead><tbody>
    <tr><td>Executive Director (ED)</td><td>Full authority, all approvals, all settings, override and view-as.</td></tr>
    <tr><td>Housing Manager</td><td>Day-to-day management, most approvals, can add staff.</td></tr>
    <tr><td>Housing Employee L2</td><td>Senior housing staff; can recommend/review.</td></tr>
    <tr><td>Housing Employee L1</td><td>Housing staff; create and edit applications and records.</td></tr>
    <tr><td>Field Employee</td><td>Maintenance crew; sees only in-house work orders assigned to them.</td></tr>
    <tr><td>CFO</td><td>Finance authority.</td></tr>
    <tr><td>Finance L1</td><td>Finance staff.</td></tr>
    </tbody></table>
    <h2>Add a new staff member</h2>
    <ol>
    <li>Type the person's work email into the search box and click <strong>Look Up</strong>.</li>
    <li>If they are not listed, click <strong>+ Add Staff</strong>.</li>
    <li>Enter their name and select their <strong>Housing Role</strong>.</li>
    <li>Save. They can now sign in and land on the home screen for their role.</li>
    </ol>
    <h2>Change someone's role</h2>
    <ol>
    <li>Find the person in the <strong>Active</strong> list.</li>
    <li>Open their row and change the <strong>Housing Role</strong>.</li>
    <li>Save. The new role takes effect on their next sign-in (or reload).</li>
    </ol>
    <h2>Deactivate someone who has left</h2>
    <ol>
    <li>Find the person in the <strong>Active</strong> list.</li>
    <li>Use the row action to <strong>deactivate</strong> them.</li>
    <li>They move to <strong>Inactive</strong> and can no longer sign in, but their history is preserved.</li>
    <li>Reactivate from the Inactive tab if needed.</li>
    </ol>
    <h2>Notes and cautions</h2>
    <ul>
    <li><strong>Roles drive everything</strong> &mdash; assign the lowest role that lets them do their job.</li>
    <li><strong>Deactivate rather than delete</strong> &mdash; it keeps their past work and audit attribution.</li>
    <li><strong>Last Active</strong> helps spot accounts that can be deactivated.</li>
    <li>A person must be an <strong>active</strong> staff member for approval authority or notification routing to include them.</li>
    </ul>`;

  var SET_APPROVAL = `
    <p>Approval Authority is the single control panel for <strong>which roles can perform each action</strong> &mdash; who approves applications, who signs off renovations, who can match an applicant, who can edit the scoring model, and so on. It is the one place to delegate authority without changing any code.</p>
    <div class="ht-fig"><div class="ht-flow">
    <div class="ht-fstep"><span class="ht-fnum">1</span><div class="ht-fttl">Pick an action</div><div class="ht-fsub">Grouped by area.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">2</span><div class="ht-fttl">Tick the roles</div><div class="ht-fsub">Allowed to do it.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">3</span><div class="ht-fttl">Save Changes</div><div class="ht-fsub">By role, not by person.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">4</span><div class="ht-fttl">Applies app-wide</div><div class="ht-fsub">Everywhere it checks &ldquo;allowed?&rdquo;</div></div>
    </div></div>
    <h2>Who can use this tab</h2>
    <ul><li>ED only. Changes take effect immediately for everyone.</li></ul>
    <h2>How it works</h2>
    <ul>
    <li>Each <strong>action</strong> has a list of the <strong>roles</strong> allowed to do it.</li>
    <li>Actions are grouped by area (Applications, Renovations, Contractors, Inventory, Scoring, Inspections, Capital Projects, Leadership Dashboard, and so on).</li>
    <li>You turn a role on or off for an action with a checkbox.</li>
    <li>The app reads this table everywhere it checks "is this person allowed to do X?" &mdash; so a change ripples through the whole app at once.</li>
    </ul>
    <h2>Delegate or restrict an action</h2>
    <ol>
    <li>Open <strong>Settings &rarr; Approval Authority</strong>.</li>
    <li>Find the action's group, then the action's row.</li>
    <li>Tick the roles that should be allowed; untick the rest.</li>
    <li>Click <strong>Save Changes</strong>.</li>
    <li>Affected staff see the new buttons (or lose them) on their next page load.</li>
    </ol>
    <h2>Common authorities and what they control</h2>
    <table><thead><tr><th>Authority</th><th>Controls</th></tr></thead><tbody>
    <tr><td>Application approvals (recommend / HM / ED)</td><td>Who can advance an application at each stage.</td></tr>
    <tr><td>Renovation / SOW approvals</td><td>Who can sign off a Maintenance Request (HM and ED stages).</td></tr>
    <tr><td>Assign Work Order</td><td>Who can assign a maintenance job to in-house crew or a contractor.</td></tr>
    <tr><td>Match / override match</td><td>Who can place an applicant, and who can approve an oversized-unit match.</td></tr>
    <tr><td>Edit Scoring Model</td><td>Who can change the application scoring point values.</td></tr>
    <tr><td>Edit Match Priority</td><td>Who can change the placement-order model on Match (separate from scoring).</td></tr>
    <tr><td>Approve Inspection</td><td>Who can sign off a unit inspection report.</td></tr>
    <tr><td>Manage Projects / Allocate Costs</td><td>Who can create/edit capital projects, and who can allocate project costs to units.</td></tr>
    <tr><td>Access Leadership Dashboard</td><td>Which roles can open the Chief &amp; Council KPI dashboard.</td></tr>
    <tr><td>Manage BCR / Merge Tenants</td><td>Who can edit the BCR list and merge duplicate tenant records.</td></tr>
    </tbody></table>
    <h2>Notes and cautions</h2>
    <ul>
    <li><strong>This is powerful &mdash; change it deliberately.</strong> Granting an action to a lower role lets everyone in that role do it immediately.</li>
    <li>Authority is by <strong>role, not by person</strong>. To give one person an action, change the action for their whole role (or change that person's role on the Users tab).</li>
    <li>Some actions are deliberately separate so you can delegate them independently (e.g. who gets matched first vs who edits the scoring).</li>
    <li>Sensible defaults (usually HM/ED) apply; Reset options restore them.</li>
    <li>The ED keeps override authority throughout the app. Every change is recorded in the Audit Log.</li>
    </ul>`;

  var SET_EMAIL = `
    <p>The Email tab edits the <strong>subject, body, and recipients</strong> of every automatic workflow email the app sends &mdash; application confirmations, approval notices, work orders, RFQ awards, and so on. Changes apply immediately to the next email sent.</p>
    <div class="ht-fig"><div class="ht-flow">
    <div class="ht-fstep"><span class="ht-fnum">1</span><div class="ht-fttl">Find the event</div><div class="ht-fsub">About 19 workflow emails.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">2</span><div class="ht-fttl">Edit subject &amp; body</div><div class="ht-fsub">Keep the tokens in place.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">3</span><div class="ht-fttl">Choose recipients</div><div class="ht-fsub">Primary roles + optional CC.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">4</span><div class="ht-fttl">Next send uses it</div><div class="ht-fsub">Applies immediately.</div></div>
    </div></div>
    <h2>Who can use this tab</h2>
    <ul><li>ED only.</li></ul>
    <h2>How it works</h2>
    <ul>
    <li>The app sends email for about 19 workflow <strong>events</strong>.</li>
    <li>Each event has an editable <strong>subject</strong>, a rich-text <strong>body</strong>, a set of <strong>primary recipient roles</strong>, and optional <strong>CC roles</strong>.</li>
    <li>The body supports simple tokens (applicant name, unit address, RFQ number) that the app fills in when it sends.</li>
    <li>Some events always send to a fixed person (applicant, tenant, or contractor); for those you only choose extra CC roles.</li>
    </ul>
    <h2>Edit an email template</h2>
    <ol>
    <li>Open <strong>Settings &rarr; Email</strong> and find the event.</li>
    <li>Edit the <strong>subject</strong> line.</li>
    <li>Edit the <strong>body</strong> (bold, italic, underline, lists, links). Leave the tokens in place.</li>
    <li>Tick the <strong>Recipients</strong> roles and any <strong>Optional CC</strong> roles.</li>
    <li>Save. The new wording and recipients apply to the next send.</li>
    </ol>
    <h2>Recipient rules</h2>
    <table><thead><tr><th>Event type</th><th>Who it goes to</th></tr></thead><tbody>
    <tr><td>Applicant-facing</td><td>Always the applicant; you choose CC roles.</td></tr>
    <tr><td>Tenant-facing</td><td>Always the tenant; you choose CC roles.</td></tr>
    <tr><td>Contractor-facing</td><td>Always the contractor; you choose CC roles.</td></tr>
    <tr><td>Staff workflow</td><td>The primary roles you tick, plus any CC roles.</td></tr>
    </tbody></table>
    <h2>Notes and cautions</h2>
    <ul>
    <li><strong>Keep the tokens.</strong> Deleting a token means that detail will be missing from the email.</li>
    <li>Recipient roles must map to real, <strong>active</strong> staff.</li>
    <li>Changes are immediate; send yourself a test after a big edit if you want to confirm.</li>
    <li>Whether email can be sent at all depends on the provider configured for your nation (see the Config tab).</li>
    </ul>`;

  var SET_TERMS = `
    <p>The Terms &amp; Conditions tab edits the terms-and-conditions text printed onto <strong>housing applications and contractor work orders</strong>. It is a rich-text editor and you can paste directly from Word.</p>
    <div class="ht-fig"><div class="ht-chain">
    <span class="ht-cpill">Edit the terms</span><span class="ht-carrow">&rarr;</span>
    <span class="ht-cpill">Save</span><span class="ht-carrow">&rarr;</span>
    <span class="ht-cpill ht-on">Prints on the next document</span>
    </div></div>
    <h2>Who can use this tab</h2>
    <ul><li>ED only.</li></ul>
    <h2>Edit the terms</h2>
    <ol>
    <li>Open <strong>Settings &rarr; Terms &amp; Conditions</strong>.</li>
    <li>Edit the text, or paste a finished version from Word (formatting is preserved where supported).</li>
    <li>Review the formatting &mdash; headings, bold, and lists carry through to the printed document.</li>
    <li>Save. The new terms appear on the <strong>next</strong> application or work order generated.</li>
    </ol>
    <h2>Notes and cautions</h2>
    <ul>
    <li><strong>This is legal/policy text</strong> &mdash; have the wording approved through your governance process first.</li>
    <li>Changes are <strong>forward-looking</strong> &mdash; they apply to documents generated after you save.</li>
    <li>Paste from Word is supported, but check the result; clean up stray styling before saving.</li>
    <li>Keep a copy of the approved wording outside the app for your records.</li>
    </ul>`;

  var SET_CONTRACTS = `
    <p>The Contracts tab edits the <strong>full text of lease agreements and other contracts</strong> the app generates &mdash; the residential occupancy agreement, temporary and commercial agreements, and related documents. The text supports token substitution so each generated contract is filled in with real details.</p>
    <div class="ht-fig"><div class="ht-chain">
    <span class="ht-cpill">Choose contract type</span><span class="ht-carrow">&rarr;</span>
    <span class="ht-cpill">Edit clauses (keep tokens)</span><span class="ht-carrow">&rarr;</span>
    <span class="ht-cpill">Save</span><span class="ht-carrow">&rarr;</span>
    <span class="ht-cpill ht-on">Next contract uses it</span>
    </div></div>
    <h2>Who can use this tab</h2>
    <ul><li>ED only.</li></ul>
    <h2>How it works</h2>
    <ul>
    <li>The app stores a body of clauses for each contract type.</li>
    <li>When staff generate a lease, the app substitutes the tokens and produces the PDF.</li>
    <li>Editing the clauses here changes what every future generated contract of that type says.</li>
    </ul>
    <h2>Edit a contract's wording</h2>
    <ol>
    <li>Open <strong>Settings &rarr; Contracts</strong> and choose the contract type.</li>
    <li>Edit the clause text. Keep the tokens exactly as written where you want details inserted.</li>
    <li>Save. The change takes effect on the <strong>next</strong> contract generated.</li>
    </ol>
    <h2>Notes and cautions</h2>
    <ul>
    <li><strong>Tokens must stay intact</strong> &mdash; a mistyped token will be blank or literal in the contract.</li>
    <li>Contracts are legal documents &mdash; route wording changes through governance/legal review.</li>
    <li>Changes are forward-looking; signed or previously generated agreements are not affected.</li>
    <li>Term dates and signatures come from the generation step on the tenant's card; this tab controls the clause text.</li>
    <li>Keep an approved master copy of each contract's wording outside the app.</li>
    </ul>`;

  var SET_AUDIT = `
    <p>The Audit Log is the full activity trail for the app &mdash; applications, approvals, unit edits, maintenance requests, file uploads, AI queries, and system changes. It is read-only and append-only: entries can be viewed and exported but never edited or deleted.</p>
    <div class="ht-fig"><div class="ht-flow">
    <div class="ht-fstep"><span class="ht-fnum">1</span><div class="ht-fttl">Open the log</div><div class="ht-fsub">Newest entries first.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">2</span><div class="ht-fttl">Read with the Legend</div><div class="ht-fsub">Decode the event codes.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">3</span><div class="ht-fttl">Refresh</div><div class="ht-fsub">Pull the latest entries.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">4</span><div class="ht-fttl">Export</div><div class="ht-fsub">CSV or Excel for an auditor.</div></div>
    </div></div>
    <h2>Who can use this tab</h2>
    <ul><li>Staff with Settings access can view it. Export is available from the tab.</li></ul>
    <h2>What each column means</h2>
    <table><thead><tr><th>Column</th><th>Meaning</th></tr></thead><tbody>
    <tr><td>Date / Time</td><td>When the action happened.</td></tr>
    <tr><td>ID / Ref</td><td>The record the action was on. Maintenance Requests show as MR in this compact view.</td></tr>
    <tr><td>Event</td><td>What happened (e.g. application approved, file uploaded, unit edited).</td></tr>
    <tr><td>Detail</td><td>A short human-readable description of the change.</td></tr>
    <tr><td>By</td><td>The email of the staff member who did it.</td></tr>
    </tbody></table>
    <h2>Look something up</h2>
    <ol>
    <li>Open <strong>Settings &rarr; Audit Log</strong>. The newest entries are shown first.</li>
    <li>Click <strong>Legend</strong> for help reading the event codes.</li>
    <li>Click <strong>Refresh</strong> to pull the latest entries.</li>
    </ol>
    <h2>Export the log</h2>
    <ol>
    <li>Click <strong>Export</strong> at the top of the tab.</li>
    <li>Choose <strong>CSV</strong> or <strong>Excel (.xlsx)</strong>.</li>
    <li>The file downloads for records, reporting, or sharing with an auditor.</li>
    </ol>
    <h2>Notes and cautions</h2>
    <ul>
    <li><strong>The log cannot be altered</strong> &mdash; it is append-only at the database level, which makes it trustworthy for accountability.</li>
    <li><strong>By</strong> shows an email; older entries may show a role instead.</li>
    <li>Finance has its own separate audit trail; this is the housing-side trail.</li>
    <li>Every AI assistant interaction is logged here too.</li>
    <li>Use Export when you need the trail outside the app.</li>
    </ul>`;

  var SET_SCORING = `
    <p>This tab controls two separate things: the <strong>Application Scoring Model</strong> (how much need/urgency each applicant earns, which ranks the waitlist) and <strong>Match Priority</strong> (who gets placed into a vacant unit first). Scoring measures need; match priority decides placement order.</p>
    <div class="ht-fig"><div class="ht-flow">
    <div class="ht-fstep"><div class="ht-fttl">Application Scoring</div><div class="ht-fsub">How urgent is the need? &mdash; ranks the waitlist.</div></div>
    <div class="ht-fstep"><div class="ht-fttl">Match Priority</div><div class="ht-fsub">Who do we house first? &mdash; sets placement order.</div></div>
    </div></div>
    <p class="ht-fig-note" style="font-size:12px;color:var(--muted);margin:0 0 4px;">After editing the scoring model:</p>
    <div class="ht-fig"><div class="ht-chain">
    <span class="ht-cpill">Edit factor points</span><span class="ht-carrow">&rarr;</span>
    <span class="ht-cpill">Adjust tier thresholds</span><span class="ht-carrow">&rarr;</span>
    <span class="ht-cpill ht-on">Rescore all applications</span>
    </div></div>
    <h2>Who can use this tab</h2>
    <ul><li>ED only.</li></ul>
    <h2>Part 1 &mdash; Application Scoring Model</h2>
    <p>The scoring model assigns points to the factors that make a household's housing need urgent. The total ranks applicants and sorts them into priority tiers. Urgent-need categories include overcrowding, structural problems, no running water, mould/health hazard, caregiver situations, and homelessness.</p>
    <ol>
    <li>In the scoring table, change the <strong>point value</strong> for any factor.</li>
    <li>Adjust the <strong>priority tier thresholds</strong> to change the score cut-offs between tiers.</li>
    <li>Click <strong>Rescore All Applications</strong> so every existing application is recalculated.</li>
    <li>Use <strong>Reset All Defaults</strong> to return the model to the built-in values.</li>
    </ol>
    <h2>Part 2 &mdash; Match Priority</h2>
    <p>Match Priority decides the order applicants appear on the Match page. It adds bonuses on top of the application score:</p>
    <table><thead><tr><th>Factor</th><th>What it rewards</th></tr></thead><tbody>
    <tr><td>Has a match</td><td>There is at least one suitable vacant unit (dominates &mdash; someone nobody can place today drops to the bottom).</td></tr>
    <tr><td>Temporary unit</td><td>The best-matching unit is a Temporary (urgent/emergency) unit.</td></tr>
    <tr><td>No house</td><td>The applicant does not already have a house.</td></tr>
    <tr><td>On reserve</td><td>The applicant lives on reserve.</td></tr>
    </tbody></table>
    <p>Default ranking: on-reserve + no house, then off-reserve + no house, then on-reserve + has house, then off-reserve + has house &mdash; with the highest application score winning inside each tier.</p>
    <ol>
    <li>Scroll to the <strong>Match Priority</strong> card.</li>
    <li>Change any factor's bonus value. Set a factor to <strong>0</strong> to remove it; set all to 0 to rank by score alone.</li>
    <li>Click <strong>Save Match Priority</strong> (or Reset Defaults).</li>
    </ol>
    <h2>Notes and cautions</h2>
    <ul>
    <li><strong>Two different questions.</strong> "How urgent is the need?" is the scoring model; "Who do we house first?" is match priority.</li>
    <li>Editing match priority is delegable separately from editing the scoring model (Settings &rarr; Approval Authority &rarr; Scoring).</li>
    <li>After editing the scoring model, always <strong>Rescore All Applications</strong>.</li>
    <li>Each match-priority bonus is far larger than the max application score, so bonuses set the tier and the score breaks ties.</li>
    <li>Changes are nation-wide and recorded in the Audit Log.</li>
    </ul>`;

  var SET_REQUIRED = `
    <p>The Required Fields tab lets you choose which application fields are <strong>mandatory</strong>. A required field shows a red asterisk (*) and the application cannot be submitted while it is blank.</p>
    <div class="ht-fig"><div class="ht-chain">
    <span class="ht-cpill">Toggle a field required</span><span class="ht-carrow">&rarr;</span>
    <span class="ht-cpill">Red * on the form</span><span class="ht-carrow">&rarr;</span>
    <span class="ht-cpill ht-on">Blank blocks submission</span>
    </div></div>
    <h2>Who can use this tab</h2>
    <ul><li>ED / management.</li></ul>
    <h2>How it works</h2>
    <ul>
    <li>The tab lists the application's fields with a toggle for each.</li>
    <li>Turn a field <strong>on</strong> to make it required (red *, blocks submission when empty).</li>
    <li>Turn a field <strong>off</strong> to make it optional.</li>
    <li>The rule applies to new submissions going forward; it does not reject already-submitted applications.</li>
    </ul>
    <h2>Make a field required (or optional)</h2>
    <ol>
    <li>Open <strong>Settings &rarr; Required Fields</strong> and find the field.</li>
    <li>Toggle it required or optional.</li>
    <li>The setting saves and applies to the application form immediately.</li>
    </ol>
    <h2>Notes and cautions</h2>
    <ul>
    <li><strong>Required blocks submission.</strong> If applicants cannot submit, check whether a newly required field is empty.</li>
    <li>Keep the required set realistic &mdash; too many mandatory fields push applicants to enter placeholder data.</li>
    <li>Fields core to scoring/matching (household size, bedrooms needed, income type) improve the waitlist ranking when required.</li>
    <li>This controls the application form only, not internal staff screens.</li>
    </ul>`;

  var SET_UNITMATCH = `
    <p>The Unit Matching tab sets the <strong>point values</strong> used to score how well an applicant fits a particular unit. These points drive the <strong>match %</strong> shown on the Match Scorecard when staff place an applicant into a vacant unit.</p>
    <p class="ht-fig-note" style="font-size:12px;color:var(--muted);margin:0 0 4px;">How the match % is built:</p>
    <div class="ht-fig"><div class="ht-chain">
    <span class="ht-cpill">Points earned</span><span class="ht-carrow">&divide;</span>
    <span class="ht-cpill">Maximum score</span><span class="ht-carrow">&times; 100 =</span>
    <span class="ht-cpill ht-on">Match %</span>
    </div></div>
    <h2>Who can use this tab</h2>
    <ul><li>ED / management (gated by the Scoring approval authority).</li></ul>
    <h2>How the score works</h2>
    <ul>
    <li>Each matching <strong>factor</strong> (bedroom fit, reserve status, accessibility need) earns points when its condition is met.</li>
    <li>The tab shows a table of Factor / Condition / Points / Notes.</li>
    <li>A running <strong>maximum match score</strong> is shown under the table.</li>
    <li>On a scorecard the <strong>match %</strong> is (points earned &divide; maximum score) &times; 100. Higher means a better fit.</li>
    </ul>
    <h2>Adjust the match scoring</h2>
    <ol>
    <li>Open <strong>Settings &rarr; Unit Matching</strong>.</li>
    <li>Change the <strong>Points</strong> on any factor row. The maximum updates automatically.</li>
    <li>Click <strong>Save</strong>. New scorecards use the updated weights immediately.</li>
    </ol>
    <h2>Notes and cautions</h2>
    <ul>
    <li><strong>This is about fit, not need.</strong> Application scoring answers urgency; Match Priority answers who is placed first.</li>
    <li>Because the match % is relative to the maximum, raising one factor lowers every other factor's share &mdash; adjust deliberately.</li>
    <li>A unit two or more bedroom sizes too large always requires ED override to assign, regardless of its match score.</li>
    <li>Changes are nation-wide and recorded in the Audit Log.</li>
    </ul>`;

  var SET_RENOPRIO = `
    <p>The Reno Priority tab sets the <strong>point values used to rank units for renovation</strong>. The resulting Renovation Priority Score helps staff decide which units to renovate first, drawing on unit condition, the maintenance request data, and tenant factors.</p>
    <div class="ht-fig"><div class="ht-flow">
    <div class="ht-fstep"><span class="ht-fnum">1</span><div class="ht-fttl">Category conditions met</div><div class="ht-fsub">Condition, hazard, overcrowding.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">2</span><div class="ht-fttl">Points add up per unit</div><div class="ht-fsub">From request &amp; condition data.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">3</span><div class="ht-fttl">Higher = renovate first</div><div class="ht-fsub">Ranks the units, not applicants.</div></div>
    </div></div>
    <h2>Who can use this tab</h2>
    <ul><li>ED / management (gated by the Scoring approval authority).</li></ul>
    <h2>How the score works</h2>
    <ul>
    <li>Each <strong>category</strong> (condition severity, health/safety hazard, overcrowding, tenant vulnerability) earns points when its condition is met.</li>
    <li>The tab shows a table of Category / Condition / Points / Notes.</li>
    <li>The app adds the points for each unit from its request and condition data to produce the score.</li>
    <li>A higher score means higher renovation priority.</li>
    </ul>
    <h2>Adjust renovation priority scoring</h2>
    <ol>
    <li>Open <strong>Settings &rarr; Reno Priority</strong>.</li>
    <li>Change the <strong>Points</strong> on any category row.</li>
    <li>Click <strong>Save</strong>. Use <strong>Reset Defaults</strong> to restore the built-in values.</li>
    </ol>
    <h2>Notes and cautions</h2>
    <ul>
    <li><strong>This ranks units, not applicants.</strong></li>
    <li>Weight health-and-safety categories high if your nation prioritizes hazards over cosmetic work.</li>
    <li>The score is only as good as the data captured on maintenance requests and unit condition fields.</li>
    <li>Changes are nation-wide and recorded in the Audit Log.</li>
    </ul>`;

  var SET_BUDGET = `
    <p>The Reno Budget tab records your <strong>annual renovation funding by source</strong>, sets the <strong>Housing Manager spending limit</strong> before ED approval is required, and sets the <strong>FNCFS dependant age</strong> used to decide FNCFS fund eligibility.</p>
    <p class="ht-fig-note" style="font-size:12px;color:var(--muted);margin:0 0 4px;">The HM Limit routes approvals:</p>
    <div class="ht-fig"><div class="ht-flow">
    <div class="ht-fstep"><div class="ht-fttl">At or under the HM Limit</div><div class="ht-fsub">Housing Manager can approve.</div></div>
    <div class="ht-fstep"><div class="ht-fttl">Over the HM Limit</div><div class="ht-fsub">Escalates to the ED.</div></div>
    </div></div>
    <h2>Who can use this tab</h2>
    <ul><li>ED / management.</li></ul>
    <h2>The controls at the top</h2>
    <table><thead><tr><th>Control</th><th>What it does</th></tr></thead><tbody>
    <tr><td>Fiscal Year</td><td>The budget year these allocations apply to.</td></tr>
    <tr><td>HM Limit</td><td>The amount a Housing Manager can approve on a Maintenance Request before it must go to the ED.</td></tr>
    <tr><td>FNCFS Dependent Age</td><td>The maximum age (default 17) of a dependant for a home to qualify for FNCFS funds.</td></tr>
    </tbody></table>
    <h2>The allocations table</h2>
    <p>Enter the annual dollar allocation for each renovation fund source; the app totals them.</p>
    <table><thead><tr><th>Fund source</th><th>Eligibility</th></tr></thead><tbody>
    <tr><td>CMHC Section 95</td><td>All unit types.</td></tr>
    <tr><td>Section 10</td><td>All unit types.</td></tr>
    <tr><td>Band Housing</td><td>All unit types.</td></tr>
    <tr><td>Band Rep Funds</td><td>All unit types.</td></tr>
    <tr><td>FNCFS Funds</td><td>Only homes with dependants under the FNCFS age set above.</td></tr>
    </tbody></table>
    <h2>Set the annual budget</h2>
    <ol>
    <li>Open <strong>Settings &rarr; Reno Budget</strong>.</li>
    <li>Set the <strong>Fiscal Year</strong>.</li>
    <li>Set the <strong>HM Limit</strong> and the <strong>FNCFS Dependent Age</strong> if changed.</li>
    <li>Enter each fund source's <strong>Annual Allocation</strong> and check the <strong>Total</strong>.</li>
    <li>Click <strong>Save Budgets</strong>.</li>
    </ol>
    <h2>Notes and cautions</h2>
    <ul>
    <li><strong>The HM Limit drives approval routing</strong> &mdash; requests at or under it can be approved by the HM; larger ones require the ED.</li>
    <li>FNCFS only appears on a Maintenance Request when the unit's household has a qualifying dependant.</li>
    <li>Set the budget at the start of each fiscal year and update the Fiscal Year field.</li>
    <li>Changes are nation-wide and recorded in the Audit Log.</li>
    </ul>`;

  var SET_OCCUPANCY = `
    <p>The Occupancy tab sets the <strong>National Occupancy Standard (NOS)</strong> &mdash; the maximum number of people that can appropriately live in a unit of a given bedroom count. The app uses it to automatically calculate <strong>overcrowding</strong> on applications.</p>
    <div class="ht-fig"><div class="ht-flow">
    <div class="ht-fstep"><span class="ht-fnum">1</span><div class="ht-fttl">Set the NOS max</div><div class="ht-fsub">Persons per bedroom count.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">2</span><div class="ht-fttl">Household exceeds it</div><div class="ht-fsub">= overcrowded.</div></div>
    <div class="ht-fstep"><span class="ht-fnum">3</span><div class="ht-fttl">Feeds the score</div><div class="ht-fsub">+1 point per extra person, max 10.</div></div>
    </div></div>
    <h2>Who can use this tab</h2>
    <ul><li>ED only.</li></ul>
    <h2>How it works</h2>
    <ul>
    <li>The NOS table lists each bedroom count with the <strong>maximum persons</strong> allowed.</li>
    <li>A household is <strong>overcrowded</strong> when the number of people exceeds the NOS maximum for their current home.</li>
    <li>Overcrowding feeds the application score: <strong>each person over the standard earns 1 point, up to 10</strong>.</li>
    </ul>
    <h2>Set the occupancy standard</h2>
    <ol>
    <li>Open <strong>Settings &rarr; Occupancy</strong>.</li>
    <li>Set the <strong>maximum persons</strong> for each bedroom count to match your nation's adopted standard.</li>
    <li>Click <strong>Save NOS Table</strong>.</li>
    </ol>
    <h2>Notes and cautions</h2>
    <ul>
    <li><strong>This defines overcrowding.</strong> Change it only to reflect your nation's adopted standard.</li>
    <li>The overcrowding points are capped at 10.</li>
    <li>After changing the NOS, rescore applications (Settings &rarr; Application Scoring) to reflect it immediately.</li>
    <li>Changes are nation-wide and recorded in the Audit Log.</li>
    </ul>`;

  var SET_RENTMODEL = `
    <p>The Rent Model tab defines how the app <strong>calculates rent</strong>. It holds two pathways: a standard <strong>market-rent discount</strong> and the <strong>Ontario Works / ODSP shelter-allowance</strong> tables. The app picks the pathway automatically from the applicant's income type.</p>
    <p class="ht-fig-note" style="font-size:12px;color:var(--muted);margin:0 0 4px;">Income type picks the pathway:</p>
    <div class="ht-fig"><div class="ht-flow">
    <div class="ht-fstep"><div class="ht-fttl">Employment / pension / other</div><div class="ht-fsub">Market-rent discount model.</div></div>
    <div class="ht-fstep"><div class="ht-fttl">Ontario Works / ODSP</div><div class="ht-fsub">Shelter-allowance tables.</div></div>
    </div></div>
    <h2>Who can use this tab</h2>
    <ul><li>ED / management.</li></ul>
    <h2>The two pathways</h2>
    <table><thead><tr><th>Pathway</th><th>Used when</th><th>How rent is set</th></tr></thead><tbody>
    <tr><td>Market-rent discount</td><td>Income is employment/pension/other (not social assistance).</td><td>A discount is applied to market rent per the model you configure.</td></tr>
    <tr><td>OW / ODSP shelter allowance</td><td>Income type is Ontario Works or ODSP.</td><td>Rent follows the shelter-allowance amounts in the tables you set.</td></tr>
    </tbody></table>
    <h2>Update the rent model</h2>
    <ol>
    <li>Open <strong>Settings &rarr; Rent Model</strong>.</li>
    <li>For the <strong>market-rent discount</strong> pathway, set the discount values your nation uses.</li>
    <li>For the <strong>OW / ODSP</strong> pathway, update the shelter-allowance amounts to the current provincial figures.</li>
    <li>Save. New rent calculations use the updated figures.</li>
    </ol>
    <h2>Notes and cautions</h2>
    <ul>
    <li><strong>The income type chooses the pathway</strong> &mdash; make sure applications capture the correct income type.</li>
    <li>OW and ODSP amounts change periodically &mdash; review this tab when the province updates its rates.</li>
    <li>This defines the model; an individual tenant's rent is managed in the Finance module once housed.</li>
    <li>Changes are nation-wide and recorded in the Audit Log.</li>
    </ul>`;

  var SET_POLICY = `
    <p>The Policy Rules tab holds your nation's <strong>housing-policy parameters</strong> &mdash; the eligibility windows and arrears good-standing timing the app actually enforces. Editing them here changes the app's behaviour <strong>without a software deploy</strong>.</p>
    <div class="ht-fig"><div class="ht-chain">
    <span class="ht-cpill">Edit a policy value</span><span class="ht-carrow">&rarr;</span>
    <span class="ht-cpill">Save</span><span class="ht-carrow">&rarr;</span>
    <span class="ht-cpill ht-on">Enforced at the decision point</span>
    </div></div>
    <h2>Who can use this tab</h2>
    <ul><li>ED / management.</li></ul>
    <h2>What it controls</h2>
    <ul>
    <li><strong>Eligibility windows</strong> &mdash; the time-based rules that decide when an applicant or action qualifies.</li>
    <li><strong>Arrears good-standing gate</strong> &mdash; checks whether an applicant is in good standing on arrears before assignment. A flagged applicant gets an amber warning at approval/assignment time rather than being hidden.</li>
    <li>Other policy timing parameters, each enforced by the app at the relevant decision point.</li>
    </ul>
    <h2>Adjust a policy parameter</h2>
    <ol>
    <li>Open <strong>Settings &rarr; Policy Rules</strong>.</li>
    <li>Change the value for the parameter you need (days/months, a threshold, or an on/off rule).</li>
    <li>Save. The app enforces the new value immediately.</li>
    </ol>
    <h2>Notes and cautions</h2>
    <ul>
    <li><strong>These rules gate real decisions.</strong> Change policy values only to match your nation's adopted housing policy.</li>
    <li>The arrears gate is a <strong>warning at assignment time</strong>, not a silent exclusion.</li>
    <li>Because they are enforced live, test the effect on one record after a change.</li>
    <li>Keep your written housing policy and these settings aligned. Changes are recorded in the Audit Log.</li>
    </ul>`;

  // ---- GUIDES: Notes & File Records ----------------------------------------
  var NOTES_SOP = ''
    + '<h2>Purpose</h2>'
    + '<p>Notes are the running record of a file &mdash; the calls, the context, the decisions behind each step. This procedure explains the kinds of notes the app keeps, <strong>where each one is stored</strong>, and <strong>where to go to read them later</strong>. The short version: a note is always saved with the record you were working on, and every note about a <em>person</em> also gathers in one place &mdash; the Tenant Card.</p>'
    + '<div class="ht-fig"><div class="ht-flow">'
    +   '<div class="ht-fstep"><span class="ht-fnum">1</span><div class="ht-fttl">Write a note</div><div class="ht-fsub">On whatever record you&rsquo;re in &mdash; a person, application, unit, contractor or request.</div></div>'
    +   '<div class="ht-fstep"><span class="ht-fnum">2</span><div class="ht-fttl">It saves with that record</div><div class="ht-fsub">Timestamped and attributed; the field tells you where it lands.</div></div>'
    +   '<div class="ht-fstep"><span class="ht-fnum">3</span><div class="ht-fttl">Read it later</div><div class="ht-fsub">On the record itself &mdash; and, for anything about a person, on the Tenant Card.</div></div>'
    + '</div></div>'

    + '<h2>The one place to see everything about a person</h2>'
    + '<p>Open the <strong>Tenant Card</strong> (the person card &mdash; from a tenant row, or from the worklist) and go to <strong>Notes &amp; History</strong>. It shows <strong>every</strong> note about that person in one list, newest first: staff file notes, application / intake notes, and workflow notes (move-in, inspection sign-off, work-order completion). When you are not sure where a note went, this is where to look.</p>'
    + '<ul>'
    + '<li>The card gathers notes across <strong>all</strong> of a person&rsquo;s records &mdash; every tenancy row and every application they have &mdash; so a note is never hidden on a duplicate record.</li>'
    + '<li>The hero shows a <strong>last-note age</strong> badge (it turns red when there are no notes, or the newest is over 90 days old) so you can tell at a glance whether a file is current.</li>'
    + '</ul>'

    + '<h2>Where you add a note, and where it lands</h2>'
    + '<table><thead><tr><th>Where you add it</th><th>What it is</th><th>Where it is stored / shown</th></tr></thead><tbody>'
    + '<tr><td>Tenant Card &rarr; Notes tab (&ldquo;Add a Note&rdquo;)</td><td>A staff note on the person&rsquo;s file.</td><td>The tenant file. Shows on the Tenant Card.</td></tr>'
    + '<tr><td>Application &rarr; Internal Notes tab; and the quick-add on the approval scorecard</td><td>A staff note on an application.</td><td>The application file. Also appears on the Tenant Card.</td></tr>'
    + '<tr><td>Approval decision note (Approve / Return / Decline)</td><td>The reviewer&rsquo;s reason for a decision.</td><td>Saved to the application file <em>and</em> the sign-off record. Shown on the scorecard&rsquo;s Internal Notes.</td></tr>'
    + '<tr><td>Edit Unit &rarr; Notes tab</td><td>A note about the property / unit.</td><td>The unit record. Shows on the unit card.</td></tr>'
    + '<tr><td>Contractor card &rarr; Notes tab</td><td>A staff note about a contractor.</td><td>The contractor record. Shows on the contractor card.</td></tr>'
    + '<tr><td>Maintenance Request note fields (Additional / Accountability / Field notes)</td><td>Context on a repair request.</td><td>Saved with that Maintenance Request.</td></tr>'
    + '<tr><td>Finance &rarr; payment or opening-balance notes</td><td>A note on a money transaction.</td><td>Saved on that entry; shows in the tenant&rsquo;s ledger.</td></tr>'
    + '<tr><td>Contractor Portal (the contractor types a note)</td><td>The contractor&rsquo;s own site note on a work order.</td><td>Saved on the work order; surfaces on its Overview and in the Contractor Submissions queue.</td></tr>'
    + '</tbody></table>'

    + '<h2>Every note answers three questions</h2>'
    + '<ul>'
    + '<li><strong>Did it save?</strong> You get a confirmation &mdash; the note appears in the list right away, or a message confirms it.</li>'
    + '<li><strong>Where did it go?</strong> Each note field states its destination (for example, a Maintenance Request note reads &ldquo;Saved with this maintenance request&rdquo;; a payment note &ldquo;shows in the tenant&rsquo;s ledger&rdquo;).</li>'
    + '<li><strong>Where do I read it later?</strong> On the record itself, and &mdash; for anything about a person &mdash; on the Tenant Card.</li>'
    + '</ul>'

    + '<h2>Finding notes at a glance</h2>'
    + '<ul>'
    + '<li><strong>Worklist chips.</strong> Application and Contractor rows in My Worklist show a <strong>&#128221; N</strong> chip when the file already has notes; hover (or tap) for the last-note age. No chip means no notes yet.</li>'
    + '<li><strong>On the approval scorecard.</strong> Before you decide, the scorecard shows the application&rsquo;s Internal Notes <em>and</em> the HM/ED sign-off notes, and lets you add a note right there &mdash; so you never approve without seeing the file&rsquo;s history.</li>'
    + '</ul>'

    + '<h2>Rules &amp; cautions</h2>'
    + '<ul>'
    + '<li><strong>Notes are a permanent log.</strong> Tenant, application, unit and contractor notes are <strong>append-only</strong> &mdash; timestamped, attributed to the author, and they cannot be edited or deleted. To correct or update, write a new note.</li>'
    + '<li><strong>Decision reasons are kept.</strong> A note typed when approving, returning or declining (including a required decline reason) is saved to the file, not only the Audit Log.</li>'
    + '<li><strong>Legacy notes.</strong> Older single-field notes on a unit, contractor or finance profile are shown read-only and labelled <em>Legacy note</em> or <em>Finance note</em> so nothing is lost; add new notes through the Notes tab.</li>'
    + '<li><strong>Entity vs. person.</strong> Unit, contractor and Maintenance-Request notes live with that record &mdash; they are about the property, the company or the job &mdash; and are read there, not on a person&rsquo;s Tenant Card.</li>'
    + '</ul>';

  // DOCS registry. cat drives the sidebar grouping; order within a category is
  // the array order. Keep each html in sync with its Claude Doc master.
  var DOCS = [
    { id: 'housing',    cat: 'Guides',   title: 'Housing Department SOP', sub: 'Application to inspection', html: HOUSING_SOP },
    { id: 'contractor', cat: 'Guides',   title: 'Contractor Module SOP',  sub: 'Onboarding to payment',    html: CONTRACTOR_SOP },
    { id: 'notes',      cat: 'Guides',   title: 'Notes & File Records',   sub: 'Where notes live and how to find them', html: NOTES_SOP },

    { id: 'mod-applications', cat: 'Modules', title: 'Applications',                  html: MOD_APPLICATIONS },
    { id: 'mod-inventory',    cat: 'Modules', title: 'Inventory (Units)',             html: MOD_INVENTORY },
    { id: 'mod-tenants',      cat: 'Modules', title: 'Tenants & TIC',                 html: MOD_TENANTS },
    { id: 'mod-worklist',     cat: 'Modules', title: 'My Worklist',                   html: MOD_WORKLIST },
    { id: 'mod-match',        cat: 'Modules', title: 'Match',                         html: MOD_MATCH },
    { id: 'mod-renos',        cat: 'Modules', title: 'Renovations / Maintenance Requests', html: MOD_RENOS },
    { id: 'mod-rfq',          cat: 'Modules', title: 'RFQ (Quotes & Contracts)',      html: MOD_RFQ },
    { id: 'mod-contractors',  cat: 'Modules', title: 'Contractors',                   html: MOD_CONTRACTORS },
    { id: 'mod-portal',       cat: 'Modules', title: 'Contractor Portal',             html: MOD_PORTAL },
    { id: 'mod-inspections',  cat: 'Modules', title: 'Inspections',                   html: MOD_INSPECTIONS },
    { id: 'mod-projects',     cat: 'Modules', title: 'Capital Projects',              html: MOD_PROJECTS },
    { id: 'mod-finance',      cat: 'Modules', title: 'Finance',                       html: MOD_FINANCE },
    { id: 'mod-email-intake', cat: 'Modules', title: 'Email Intake',                  html: MOD_EMAIL_INTAKE },
    { id: 'mod-ai',           cat: 'Modules', title: 'AI Assistant',                  html: MOD_AI },
    { id: 'mod-leadership',   cat: 'Modules', title: 'Leadership Dashboard',          html: MOD_LEADERSHIP },
    { id: 'mod-2fa',          cat: 'Modules', title: 'Two-Factor Authentication',      html: MOD_2FA },
    { id: 'mod-help',         cat: 'Modules', title: 'Help & Training',               html: MOD_HELP },

    { id: 'set-nation',    cat: 'Settings', title: 'Nation & Modules',     html: SET_NATION },
    { id: 'set-themes',    cat: 'Settings', title: 'Themes (Brand)',       html: SET_THEMES },
    { id: 'set-config',    cat: 'Settings', title: 'Config',               html: SET_CONFIG },
    { id: 'set-labels',    cat: 'Settings', title: 'Unit Labels',          html: SET_LABELS },
    { id: 'set-users',     cat: 'Settings', title: 'Users',                html: SET_USERS },
    { id: 'set-approval',  cat: 'Settings', title: 'Approval Authority',   html: SET_APPROVAL },
    { id: 'set-email',     cat: 'Settings', title: 'Email',                html: SET_EMAIL },
    { id: 'set-terms',     cat: 'Settings', title: 'Terms & Conditions',   html: SET_TERMS },
    { id: 'set-contracts', cat: 'Settings', title: 'Contracts',            html: SET_CONTRACTS },
    { id: 'set-audit',     cat: 'Settings', title: 'Audit Log',            html: SET_AUDIT },
    { id: 'set-scoring',   cat: 'Settings', title: 'Application Scoring',  html: SET_SCORING },
    { id: 'set-required',  cat: 'Settings', title: 'Required Fields',      html: SET_REQUIRED },
    { id: 'set-unitmatch', cat: 'Settings', title: 'Unit Matching',        html: SET_UNITMATCH },
    { id: 'set-renoprio',  cat: 'Settings', title: 'Reno Priority',        html: SET_RENOPRIO },
    { id: 'set-budget',    cat: 'Settings', title: 'Reno Budget',          html: SET_BUDGET },
    { id: 'set-occupancy', cat: 'Settings', title: 'Occupancy',            html: SET_OCCUPANCY },
    { id: 'set-rentmodel', cat: 'Settings', title: 'Rent Model',           html: SET_RENTMODEL },
    { id: 'set-policy',    cat: 'Settings', title: 'Policy Rules',         html: SET_POLICY }
  ];

  var CATS = ['Guides', 'Modules', 'Settings'];

  function _docById(id) {
    for (var i = 0; i < DOCS.length; i++) { if (DOCS[i].id === id) return DOCS[i]; }
    return null;
  }

  function _ensureStyles() {
    if (document.getElementById('help_training_styles')) return;
    var s = document.createElement('style');
    s.id = 'help_training_styles';
    // Theme tokens only (no colour literals) so each nation's palette brands it.
    s.textContent =
      '#helpTrainingModal .ht-shell{background:var(--surface);border-radius:14px;max-width:1040px;width:100%;max-height:92vh;display:flex;flex-direction:column;overflow:hidden;}'
    + '#helpTrainingModal .ht-hero{display:flex;align-items:center;gap:14px;padding:18px 24px;border-bottom:1px solid var(--border);flex-shrink:0;}'
    + '#helpTrainingModal .ht-logo{height:40px;width:auto;flex-shrink:0;}'
    + '#helpTrainingModal .ht-h-main{flex:1;min-width:0;}'
    + '#helpTrainingModal .ht-nation{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--muted);}'
    + '#helpTrainingModal .ht-title{font-family:var(--serif,Georgia,serif);font-size:22px;color:var(--text);line-height:1.1;}'
    + '#helpTrainingModal .ht-rev{font-size:11px;color:var(--muted);margin-top:3px;}'
    + '#helpTrainingModal .ht-layout{display:flex;flex:1;min-height:0;}'
    + '#helpTrainingModal .ht-side{width:244px;flex-shrink:0;border-right:1px solid var(--border);overflow-y:auto;padding:12px 10px;}'
    + '#helpTrainingModal .ht-side-toggle{display:none;}'          /* desktop: no toggle, list always shown */
    + '#helpTrainingModal .ht-side-inner{display:block;}'
    + '#helpTrainingModal .ht-search{width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text);font-size:13px;font-family:inherit;margin-bottom:8px;}'
    + '#helpTrainingModal .ht-nav-group{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--muted);margin:14px 0 4px;padding-left:8px;}'
    + '#helpTrainingModal .ht-nav-item{display:block;width:100%;box-sizing:border-box;text-align:left;border:none;background:none;padding:7px 10px;border-radius:7px;border-left:3px solid transparent;font-size:13px;color:var(--text);cursor:pointer;font-family:inherit;line-height:1.3;}'
    + '#helpTrainingModal .ht-nav-item:hover{background:var(--border);}'
    + '#helpTrainingModal .ht-nav-item.active{border-left-color:var(--yellow);background:var(--border);font-weight:700;}'
    + '#helpTrainingModal .ht-nav-empty{padding:10px;font-size:12px;color:var(--muted);}'
    + '#helpTrainingModal .ht-main{flex:1;min-width:0;overflow-y:auto;}'
    + '#helpTrainingModal .ht-body{padding:20px 24px 28px;color:var(--text);}'
    + '#helpTrainingModal .ht-body h2{font-size:15px;font-weight:700;color:var(--text);border-left:3px solid var(--yellow);padding-left:11px;margin:22px 0 9px;}'
    + '#helpTrainingModal .ht-body h2:first-child{margin-top:4px;}'
    + '#helpTrainingModal .ht-body p{margin:0 0 9px;font-size:13.5px;line-height:1.6;}'
    + '#helpTrainingModal .ht-body ul,#helpTrainingModal .ht-body ol{margin:0 0 10px;padding-left:22px;font-size:13.5px;line-height:1.6;}'
    + '#helpTrainingModal .ht-body li{margin:0 0 5px;}'
    + '#helpTrainingModal .ht-body table{width:100%;border-collapse:collapse;margin:6px 0 14px;font-size:12.5px;}'
    + '#helpTrainingModal .ht-body th{text-align:left;font-weight:700;border-bottom:2px solid var(--yellow);padding:7px 9px;vertical-align:top;color:var(--text);}'
    + '#helpTrainingModal .ht-body td{border:1px solid var(--border);padding:7px 9px;vertical-align:top;}'
    + '#helpTrainingModal .ht-videos{border:1px dashed var(--border);border-radius:10px;padding:26px;text-align:center;color:var(--muted);font-size:13.5px;}'
    + '#helpTrainingModal .ht-foot{padding:12px 24px;border-top:1px solid var(--border);text-align:right;flex-shrink:0;}'
    /* Infographics (SOP diagrams) -- theme tokens only, no colour literals */
    + '#helpTrainingModal .ht-body .ht-fig{margin:6px 0 16px;}'
    + '#helpTrainingModal .ht-body .ht-flow{display:flex;flex-wrap:wrap;gap:8px;}'
    + '#helpTrainingModal .ht-body .ht-fstep{flex:1 1 140px;min-width:130px;border:1px solid var(--border);border-top:3px solid var(--yellow);border-radius:8px;padding:9px 11px;background:var(--surface);}'
    + '#helpTrainingModal .ht-body .ht-fnum{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border:2px solid var(--text);border-radius:50%;font-size:11px;font-weight:700;color:var(--text);margin-bottom:5px;}'
    + '#helpTrainingModal .ht-body .ht-fttl{font-size:12.5px;font-weight:700;color:var(--text);line-height:1.25;}'
    + '#helpTrainingModal .ht-body .ht-fsub{font-size:11.5px;color:var(--muted);line-height:1.35;margin-top:3px;}'
    + '#helpTrainingModal .ht-body .ht-chain{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:4px 0 14px;}'
    + '#helpTrainingModal .ht-body .ht-cpill{border:1px solid var(--border);border-radius:14px;padding:4px 11px;font-size:12px;font-weight:700;color:var(--text);background:var(--surface);}'
    + '#helpTrainingModal .ht-body .ht-cpill.ht-on{border-color:var(--yellow);box-shadow:inset 3px 0 0 var(--yellow);}'
    + '#helpTrainingModal .ht-body .ht-carrow{color:var(--muted);font-weight:700;font-size:13px;}'
    + '@media (max-width:760px){'
    +   '#helpTrainingModal .ht-body .ht-fstep{flex-basis:100%;}'
    +   '#helpTrainingModal .ht-layout{flex-direction:column;}'
    +   '#helpTrainingModal .ht-side{width:auto;border-right:none;border-bottom:1px solid var(--border);max-height:none;padding:8px 10px;flex-shrink:0;}'
    +   '#helpTrainingModal .ht-title{font-size:18px;}'
    +   '#helpTrainingModal .ht-hero{padding:12px 16px;gap:10px;}'       /* tighter header */
    +   '#helpTrainingModal .ht-logo{height:32px;}'
    +   '#helpTrainingModal .ht-body{padding:14px 16px 24px;}'
    +   '#helpTrainingModal .ht-side-toggle{display:flex;align-items:center;justify-content:space-between;width:100%;box-sizing:border-box;padding:9px 11px;background:var(--bg);border:1px solid var(--border);border-radius:8px;font-size:13px;font-weight:700;color:var(--text);font-family:inherit;cursor:pointer;}'
    +   '#helpTrainingModal .ht-side-chev{font-size:12px;color:var(--muted);transition:transform .18s ease;}'
    +   '#helpTrainingModal .ht-side-toggle[aria-expanded="true"] .ht-side-chev{transform:rotate(90deg);}'
    +   '#helpTrainingModal .ht-side-inner{display:none;margin-top:8px;max-height:46vh;overflow-y:auto;}'
    +   '#helpTrainingModal .ht-side-inner.open{display:block;}'
    + '}';
    document.head.appendChild(s);
  }

  function _navHtml(activeId) {
    var nav = '', c, i, items;
    for (c = 0; c < CATS.length; c++) {
      items = [];
      for (i = 0; i < DOCS.length; i++) { if (DOCS[i].cat === CATS[c]) items.push(DOCS[i]); }
      if (!items.length) continue;
      nav += '<div class="ht-nav-group">' + _esc(CATS[c]) + '</div>';
      for (i = 0; i < items.length; i++) {
        nav += '<button type="button" class="ht-nav-item' + (items[i].id === activeId ? ' active' : '') + '"'
            +  ' data-title="' + _esc(items[i].title.toLowerCase()) + '"'
            +  ' onclick="openHelpTraining(\'' + items[i].id + '\')">' + _esc(items[i].title) + '</button>';
      }
    }
    nav += '<div class="ht-nav-group">Training</div>';
    nav += '<button type="button" class="ht-nav-item' + (activeId === 'videos' ? ' active' : '') + '"'
        +  ' data-title="training videos" onclick="openHelpTraining(\'videos\')">Training Videos</button>';
    nav += '<div class="ht-nav-empty" id="ht_nav_empty" style="display:none;">No matching documents.</div>';
    return nav;
  }

  // Revision-history table appended to the foot of every document.
  function _historyHtml(doc) {
    var rows = (doc && doc.history) || SOP_HISTORY;
    var body = '';
    for (var i = 0; i < rows.length; i++) {
      body += '<tr><td>' + _esc(rows[i].date) + '</td><td>' + _esc(rows[i].change) + '</td></tr>';
    }
    return '<h2>Revision History</h2><table><thead><tr><th>Date</th><th>Change</th></tr></thead><tbody>' + body + '</tbody></table>';
  }

  function _render(activeId) {
    var doc = (activeId === 'videos') ? null : _docById(activeId);
    var theme = (window._appSettings && window._appSettings.theme) || {};
    var logo = theme.logo || nc().logo || nc().logo_url || '';
    var logoHtml = logo ? '<img class="ht-logo" src="' + logo + '" alt=""/>' : '';
    var bodyInner;
    if (activeId === 'videos') {
      bodyInner = '<div class="ht-videos">&#127909; Training videos are coming soon.<br/>Walkthroughs will be added here as they are produced.</div>';
    } else {
      bodyInner = ((doc && doc.html) || '') + _historyHtml(doc);
    }
    var titleText = (activeId === 'videos') ? 'Training Videos' : (doc ? doc.title : 'Help & Training');
    var rev = (doc && doc.rev) || SOP_REVISION;

    return ''
      + '<div class="ht-shell" onclick="event.stopPropagation()">'
      +   '<div class="ht-hero">' + logoHtml
      +     '<div class="ht-h-main"><div class="ht-nation">' + _esc(nationName()) + ' &middot; Help &amp; Training</div>'
      +       '<div class="ht-title">' + _esc(titleText) + '</div>'
      +       '<div class="ht-rev">Revised ' + _esc(rev) + ' &middot; updated as the app improves</div></div>'
      +     '<button type="button" class="tic-close-btn" aria-label="Close" onclick="closeHelpTraining()">&times;</button>'
      +   '</div>'
      +   '<div class="ht-layout">'
      +     '<div class="ht-side">'
      +       '<button type="button" class="ht-side-toggle" aria-expanded="false" onclick="_htToggleTopics(this)"><span>&#128218; Browse topics</span><span class="ht-side-chev">&#9656;</span></button>'
      +       '<div class="ht-side-inner">'
      +         '<input type="text" class="ht-search" placeholder="Search procedures..." oninput="_htFilterNav(this.value)" aria-label="Search procedures"/>'
      +         '<nav id="ht_nav">' + _navHtml(activeId) + '</nav>'
      +       '</div>'
      +     '</div>'
      +     '<div class="ht-main"><div class="ht-body">' + bodyInner + '</div></div>'
      +   '</div>'
      +   '<div class="ht-foot"><button type="button" class="btn btn-ghost" onclick="closeHelpTraining()">Close</button></div>'
      + '</div>';
  }

  function _esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

  // Filter the sidebar list in place as the user types (no re-render, so focus
  // stays in the search box). Hides non-matching items and empty group headers.
  function _htFilterNav(q) {
    q = (q || '').trim().toLowerCase();
    var nav = document.getElementById('ht_nav');
    if (!nav) return;
    var items = nav.querySelectorAll('.ht-nav-item');
    var anyShown = false, i, t;
    for (i = 0; i < items.length; i++) {
      t = items[i].getAttribute('data-title') || '';
      var show = (!q || t.indexOf(q) >= 0);
      items[i].style.display = show ? '' : 'none';
      if (show) anyShown = true;
    }
    // Hide a group header with no visible items beneath it.
    var groups = nav.querySelectorAll('.ht-nav-group');
    for (i = 0; i < groups.length; i++) {
      var any = false, n = groups[i].nextElementSibling;
      while (n && !/ht-nav-group/.test(n.className) && !/ht-nav-empty/.test(n.className)) {
        if (/ht-nav-item/.test(n.className) && n.style.display !== 'none') { any = true; }
        n = n.nextElementSibling;
      }
      groups[i].style.display = any ? '' : 'none';
    }
    var empty = document.getElementById('ht_nav_empty');
    if (empty) empty.style.display = anyShown ? 'none' : 'block';
  }
  window._htFilterNav = _htFilterNav;

  // Mobile only: expand/collapse the topic list (collapsed by default so the
  // document starts right under the header). On desktop the toggle is hidden
  // and the list is always shown. Picking a topic re-renders the modal, which
  // resets the list to collapsed again.
  function _htToggleTopics(btn) {
    var side = btn && btn.closest ? btn.closest('.ht-side') : null;
    var inner = side ? side.querySelector('.ht-side-inner') : null;
    if (!inner) return;
    var open = !inner.classList.contains('open');
    inner.classList.toggle('open', open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) { var s = inner.querySelector('.ht-search'); if (s) try { s.focus(); } catch (e) {} }
  }
  window._htToggleTopics = _htToggleTopics;

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
    var b = host.querySelector('.ht-main'); if (b) b.scrollTop = 0;
  }
  window.openHelpTraining = openHelpTraining;

  function closeHelpTraining() {
    var host = document.getElementById('helpTrainingModal');
    if (host) { host.style.display = 'none'; host.innerHTML = ''; }
  }
  window.closeHelpTraining = closeHelpTraining;
})();
