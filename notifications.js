/* ════════════════════════════════════════════════════════════════════════
 * notifications.js — CLFN Housing email notification framework
 * ────────────────────────────────────────────────────────────────────────
 * Owns:
 *   • EMAIL_EVENT_REGISTRY — single source of truth for every workflow
 *     notification: key, label, recipient role(s), placeholders, and the
 *     default subject + bodyHtml template.
 *   • _renderEmailTemplate — pulls the saved template (if any) for an
 *     event from _appSettings.email_templates, falls back to the registry
 *     default, and substitutes {placeholder} tokens with values from the
 *     application context.
 *   • _sbLoadActiveStaffByRole — staff-table lookup helper used by the
 *     per-event notify functions.
 *   • Per-event notify functions (notifyApplicationSubmitted today,
 *     more added as they get wired in).
 *
 * The actual HTTP call to the Edge Function lives in
 *   shared-data.js → window.sendNotification(opts)
 * — generic transport, kept shared because anything in the app can use it.
 *
 * Phase 2 will append the Settings → Notifications tab UI + rich text
 * editor + Send Test button to this same file.
 * ════════════════════════════════════════════════════════════════════════ */

// ── Event registry ─────────────────────────────────────────────────────────
// Adding a new workflow notification = add an entry here. The Settings tab
// (Phase 2) will auto-render it. Placeholders listed are the ones the
// renderer knows how to substitute for that event.
var EMAIL_EVENT_REGISTRY = [
  {
    key:                   'application_submitted',
    label:                 'New Application Submitted',
    description:           'Sent when a new applicant submits.',
    defaultRecipientRoles: ['housing_manager'],
    defaultCcRoles:        [],
    wired:                 true,
    placeholders:          ['applicantName','applicantId','score','tier','nationShort','appLink'],
    defaults: {
      subject:  '{nationShort} Housing — New Application Submitted: {applicantName}',
      bodyHtml: '<p>A new housing application has been submitted by <strong>{applicantName}</strong> ({applicantId}).</p>'
              + '<p>Score: <strong>{score}</strong> · Tier: <strong>{tier}</strong></p>'
              + '<p>Please log in to the {nationShort} Housing app to review and recommend.</p>'
              + '<p style="margin:22px 0 4px;"><a href="{appLink}" style="{brandBtnStyle}">Open {nationShort} Housing &rarr;</a></p>'
    }
  },
  {
    key:                   'file_update_submitted',
    label:                 'File Update Submitted',
    description:           'Sent when an existing tenant submits a file update.',
    defaultRecipientRoles: ['housing_manager'],
    defaultCcRoles:        [],
    wired:                 true,
    placeholders:          ['applicantName','applicantId','nationShort','appLink'],
    defaults: {
      subject:  '{nationShort} Housing — File Update Requires Your Review: {applicantName}',
      bodyHtml: '<p>A file update has been submitted for <strong>{applicantName}</strong> ({applicantId}) and requires your review and approval in the {nationShort} Housing app.</p>'
              + '<p style="margin:22px 0 4px;"><a href="{appLink}" style="{brandBtnStyle}">Open {nationShort} Housing &rarr;</a></p>'
    }
  },
  {
    key:                   'transfer_request_submitted',
    label:                 'Transfer / New Housing Request Submitted',
    description:           'Sent when an existing tenant submits a new housing or transfer request.',
    defaultRecipientRoles: ['housing_manager'],
    defaultCcRoles:        [],
    wired:                 true,
    placeholders:          ['applicantName','applicantId','score','tier','nationShort','appLink'],
    defaults: {
      subject:  '{nationShort} Housing — Transfer Request Submitted: {applicantName}',
      bodyHtml: '<p>An existing tenant has submitted a new housing / transfer request and requires your review.</p>'
              + '<p>Tenant: <strong>{applicantName}</strong> ({applicantId})<br/>'
              +    'Score: <strong>{score}</strong> &middot; Tier: <strong>{tier}</strong></p>'
              + '<p>Please log in to the {nationShort} Housing app to review and recommend.</p>'
              + '<p style="margin:22px 0 4px;"><a href="{appLink}" style="{brandBtnStyle}">Open {nationShort} Housing &rarr;</a></p>'
    }
  },
  {
    key:                   'application_updated',
    label:                 'Application Updated (Resubmission)',
    description:           'Sent when an application that already exists in the system (an existing application number) is edited and re-submitted, in place of the new-application email.',
    defaultRecipientRoles: ['housing_manager'],
    defaultCcRoles:        [],
    wired:                 true,
    placeholders:          ['applicantName','applicantId','score','tier','nationShort','appLink'],
    defaults: {
      subject:  '{nationShort} Housing — Application Updated: {applicantName}',
      bodyHtml: '<p>An existing housing application has been <strong>updated and re-submitted</strong> by <strong>{applicantName}</strong> ({applicantId}).</p>'
              + '<p>Score: <strong>{score}</strong> &middot; Tier: <strong>{tier}</strong></p>'
              + '<p>This is a change to an application already in the system &mdash; not a new application. Please log in to the {nationShort} Housing app to review the updated details.</p>'
              + '<p style="margin:22px 0 4px;"><a href="{appLink}" style="{brandBtnStyle}">Open {nationShort} Housing &rarr;</a></p>'
    }
  },
  {
    key:                   'sow_created',
    label:                 'Maintenance Request Created',
    description:           'Sent on the first save of a new maintenance request (not on subsequent edits).',
    defaultRecipientRoles: ['housing_manager'],
    defaultCcRoles:        [],
    wired:                 true,
    placeholders:          ['unitAddress','totalCost','condition','contractor','nationShort','appLink'],
    defaults: {
      subject:  '{nationShort} Housing — New Maintenance Request: {unitAddress}',
      bodyHtml: '<p>A new Maintenance Request has been submitted for <strong>{unitAddress}</strong> and requires your review.</p>'
              + '<p>Total cost: <strong>{totalCost}</strong></p>'
              + '<p>Condition: <strong>{condition}</strong></p>'
              + '<p>Contractor: <strong>{contractor}</strong></p>'
              + '<p style="margin:22px 0 4px;"><a href="{appLink}" style="{brandBtnStyle}">Open {nationShort} Housing &rarr;</a></p>'
    }
  },
  {
    key:                   'contractor_submitted',
    label:                 'New Contractor Submitted for Review',
    description:           'Sent when a new contractor record is submitted (not when saved as draft).',
    defaultRecipientRoles: ['housing_manager'],
    defaultCcRoles:        [],
    wired:                 true,
    placeholders:          ['contractorName','contractorTrade','contractorClassification','nationShort','appLink'],
    defaults: {
      subject:  '{nationShort} Housing — New Contractor Submitted: {contractorName}',
      bodyHtml: '<p>A new contractor application has been submitted and requires your review and recommendation.</p>'
              + '<p>Contractor: <strong>{contractorName}</strong></p>'
              + '<p>Trade: <strong>{contractorTrade}</strong></p>'
              + '<p>Classification: <strong>{contractorClassification}</strong></p>'
              + '<p style="margin:22px 0 4px;"><a href="{appLink}" style="{brandBtnStyle}">Open {nationShort} Housing &rarr;</a></p>'
    }
  },
  {
    key:                   'application_confirmation_to_applicant',
    label:                 'Applicant Confirmation (PDF Copy)',
    description:           'Sent to the applicant (and co-applicant if a separate email) on every submit, with a PDF copy of the application attached.',
    recipientType:         'applicant',
    defaultRecipientRoles: [],
    defaultCcRoles:        [],
    wired:                 true,
    placeholders:          ['applicantName','applicantId','nationShort','appLink'],
    defaults: {
      subject:  '{nationShort} Housing — Application Received: {applicantId}',
      bodyHtml: '<p>Hello {applicantName},</p>'
              + '<p>Thank you for submitting your housing application to {nationShort} Housing. We have received your submission and a copy is attached to this email for your records.</p>'
              + '<p>Your reference ID is <strong>{applicantId}</strong>. Please keep this for any future correspondence.</p>'
              + '<p>The {nationShort} Housing team will review your application and contact you with next steps. If you have any questions in the meantime, reply directly to this email.</p>'
              + '<p>Thank you,<br/>{nationShort} Housing</p>'
    }
  },
  {
    key:                   'application_approved_waitlist',
    label:                 'Applicant Approved — Added to Wait List',
    description:           'Sent to the applicant when staff approve their application (checkbox on the portal-submission review). Wording is deliberate: approval means the application joined the housing wait list — it is NOT an offer of housing.',
    recipientType:         'applicant',
    defaultRecipientRoles: [],
    defaultCcRoles:        [],
    wired:                 true,
    placeholders:          ['applicantName','applicantId','nationShort'],
    defaults: {
      subject:  '{nationShort} Housing — Application {applicantId} Approved: You Are on the Wait List',
      bodyHtml: '<p>Hello {applicantName},</p>'
              + '<p>The {nationShort} Housing Department has reviewed and <strong>approved</strong> your housing application (reference <strong>{applicantId}</strong>).</p>'
              + '<p><strong>What approval means:</strong> your application has been added to the housing <strong>wait list</strong>. Approval is not an offer of housing, and it does not mean a home is available for you at this time. Homes are offered as they become available, based on the Housing Policy’s priority ranking, so we are not able to say how long the wait will be.</p>'
              + '<p>While you wait, please keep your file up to date &mdash; sign in to the applicant portal any time to update your contact information, household members, or income. A current file makes sure your application is ranked fairly.</p>'
              + '<p>If your situation changes, or you have any questions, contact the Housing office.</p>'
              + '<p>Thank you,<br/>{nationShort} Housing</p>'
    }
  },
  {
    key:                   'sow_tenant_copy',
    label:                 'Tenant Copy of Maintenance Request (PDF)',
    description:           'Sent to the tenant when a request is submitted (only if the tenant has an email on file and the preparer ticks the inline checkbox). PDF of the request is attached.',
    recipientType:         'tenant',
    defaultRecipientRoles: [],
    defaultCcRoles:        [],
    wired:                 true,
    placeholders:          ['tenantName','unitAddress','projectNumber','totalCost','condition','contractor','nationShort','appLink'],
    defaults: {
      subject:  '{nationShort} Housing — Maintenance Request for {unitAddress}',
      bodyHtml: '<p>Hello {tenantName},</p>'
              + '<p>A Maintenance Request has been prepared for <strong>{unitAddress}</strong> and a copy is attached to this email for your records.</p>'
              + '<p>Project #: <strong>{projectNumber}</strong><br/>'
              +    'Estimated cost: <strong>{totalCost}</strong><br/>'
              +    'Condition: <strong>{condition}</strong><br/>'
              +    'Contractor: <strong>{contractor}</strong></p>'
              + '<p>If you have any questions, please reply to this email or contact the {nationShort} Housing office.</p>'
              + '<p>Thank you,<br/>{nationShort} Housing</p>'
    }
  },
  {
    key:                   'rfq_invite',
    label:                 'RFQ Invitation to Contractors',
    description:           'Sent to each selected contractor individually when an RFQ is issued. The housing mailbox is always the TO; contractors are BCC\'d. Use CC below to include housing staff.',
    recipientType:         'rfq_contractor',
    defaultRecipientRoles: [],
    defaultCcRoles:        ['housing_manager'],
    wired:                 true,
    placeholders:          ['contractorName','rfqNumber','projectAddress','closingDate','contactPerson','contactEmail','submissionMethod','rfqLink','nationShort'],
    defaults: {
      subject:  '{nationShort} Housing — RFQ {rfqNumber}: {projectAddress} — Bids close {closingDate}',
      bodyHtml: '<p>Dear {contractorName},</p>'
              + '<p>{nationShort} Housing invites your firm to submit a competitive bid for the project referenced above. The RFQ package — including the maintenance request, bid form, and terms and conditions — is attached to this email.</p>'
              + '<p><strong>RFQ Number:</strong> {rfqNumber}<br/>'
              + '<strong>Project:</strong> {projectAddress}<br/>'
              + '<strong>Bids close:</strong> {closingDate}</p>'
              + '<p><strong>Insurance Requirement:</strong> Valid WSIB clearance and a minimum of $2,000,000 in general liability insurance are required to be awarded a contract. Proof of both must be submitted with your bid.</p>'
              + '<p>If your firm is new to working with {nationShort} Housing, please include at least two comparable project references with complete contact information.</p>'
              + '<p>If using subcontractors, a complete list must be provided including contact information, valid WSIB clearance certificate, and proof of minimum $2,000,000 general liability insurance for each subcontractor.</p>'
              + '<p>Your complete bid package must include: completed bid form, current WSIB clearance certificate, general liability insurance certificate (minimum $2,000,000), at least two comparable project references, and your proposed timeline.</p>'
              + '<p>Submission method: {submissionMethod}<br/>Questions: contact {contactPerson} at {contactEmail}.</p>'
              + '<p>Thank you for your interest.<br/>{contactPerson}<br/>{nationShort} Housing Department</p>'
    }
  },
  {
    key:                   'rfq_award',
    label:                 'RFQ Award Notification to Winner',
    description:           'Sent to the winning contractor when an RFQ is awarded (full-tender / Recipients-tab Award or Generate & Award). Skipped for the "no notifications" manual award, or if the winner has no email on file.',
    recipientType:         'contractor',
    defaultRecipientRoles: [],
    defaultCcRoles:        [],
    wired:                 true,
    placeholders:          ['contractorName','rfqNumber','projectAddress','awardAmount','awardNotes','nationShort'],
    defaults: {
      subject:  '{rfqNumber} — Contract Award Notification',
      bodyHtml: '<p>Dear {contractorName},</p>'
              + '<p>We are pleased to inform you that your bid for <strong>{rfqNumber}</strong> ({projectAddress}) has been accepted. The awarded amount is <strong>{awardAmount}</strong>.</p>'
              + '{awardNotes}'
              + '<p>The Housing Department will contact you shortly to arrange commencement. Thank you for your submission.</p>'
              + '<p>Sincerely,<br/>{nationShort} Housing</p>'
    }
  },
  {
    key:                   'rfq_regret',
    label:                 'RFQ Regret Notice to Other Bidders',
    description:           'Sent to each OTHER contractor who submitted a bid (not the winner) when an RFQ is awarded. Serialized to respect the email throttle. Skipped for the "no notifications" manual award.',
    recipientType:         'contractor',
    defaultRecipientRoles: [],
    defaultCcRoles:        [],
    wired:                 true,
    placeholders:          ['contractorName','rfqNumber','projectAddress','nationShort'],
    defaults: {
      subject:  '{rfqNumber} — Request for Quotes Outcome',
      bodyHtml: '<p>Dear {contractorName},</p>'
              + '<p>Thank you for submitting a quote for <strong>{rfqNumber}</strong> ({projectAddress}). After review, the contract has been awarded to another bidder on this occasion. We appreciate your interest and encourage you to quote on future opportunities.</p>'
              + '<p>Sincerely,<br/>{nationShort} Housing</p>'
    }
  },
  {
    key:                   'rfq_cancelled',
    label:                 'RFQ Cancellation Notice to Contractor',
    description:           'Sent to the awarded contractor when an awarded RFQ is cancelled (only when the canceller ticks the inline checkbox on the Cancel dialog and the contractor has an email on file).',
    recipientType:         'contractor',
    defaultRecipientRoles: [],
    defaultCcRoles:        [],
    wired:                 true,
    placeholders:          ['contractorName','rfqNumber','projectAddress','nationShort'],
    defaults: {
      subject:  '{rfqNumber} — Contract Cancellation Notice',
      bodyHtml: '<p>Dear {contractorName},</p>'
              + '<p>We are writing to inform you that <strong>{rfqNumber}</strong> ({projectAddress}), previously awarded to you, has been <strong>cancelled</strong>.</p>'
              + '<p>Please do not proceed with any further work under this award. If work was already underway, contact the Housing Department to arrange settlement for work completed to date.</p>'
              + '<p>We apologize for any inconvenience and thank you for your understanding.</p>'
              + '<p>Sincerely,<br/>{nationShort} Housing</p>'
    }
  },
  {
    key:                   'sow_work_order_to_contractor',
    label:                 'Work Order to Contractor (PDF)',
    description:           'Sent to the assigned contractor when an HM or ED approves the maintenance request (only if the contractor has an email on file and the approver ticks the inline checkbox). PDF work order is attached.',
    recipientType:         'contractor',
    defaultRecipientRoles: [],
    defaultCcRoles:        [],
    wired:                 true,
    placeholders:          ['contractorName','unitAddress','projectNumber','totalCost','tenantName','startDate','endDate','nationShort','appLink'],
    defaults: {
      subject:  '{nationShort} Housing — Work Order: {unitAddress} ({projectNumber})',
      bodyHtml: '<p>Hello {contractorName},</p>'
              + '<p>A Work Order has been approved for the project below and is attached to this email for your records.</p>'
              + '<p>Unit address: <strong>{unitAddress}</strong><br/>'
              +    'Project #: <strong>{projectNumber}</strong><br/>'
              +    'Tenant: <strong>{tenantName}</strong><br/>'
              +    'Estimated value: <strong>{totalCost}</strong><br/>'
              +    'Start date: <strong>{startDate}</strong><br/>'
              +    'Target completion: <strong>{endDate}</strong></p>'
              + '<p>Please review the attached Work Order. Work may only proceed on the items listed; any change to scope requires written approval before commencing. Invoices must reference this Work Order and unit address.</p>'
              + '<p>If you have any questions, please reply to this email or contact the {nationShort} Housing office.</p>'
              + '<p>Thank you,<br/>{nationShort} Housing</p>'
    }
  },
  {
    key:                   'sow_assigned_to_field_employee',
    label:                 'Work Order Assigned to Field Employee',
    description:           'Sent to the assigned in-house field employee (and CC\'d to the Housing Manager) when a maintenance request is submitted with them assigned. The printable in-house Work Order checklist PDF is attached. Goes to the employee\'s email on file (silent skip if none).',
    recipientType:         'field_employee',
    defaultRecipientRoles: [],
    defaultCcRoles:        ['housing_manager'],
    wired:                 true,
    placeholders:          ['employeeName','unitAddress','projectNumber','tenantName','totalCost','startDate','endDate','nationShort','appLink'],
    defaults: {
      subject:  '{nationShort} Housing — Work Order Assigned: {unitAddress} ({projectNumber})',
      bodyHtml: '<p>Hello {employeeName},</p>'
              + '<p>A maintenance work order has been assigned to you.</p>'
              + '<p>Unit address: <strong>{unitAddress}</strong><br/>'
              +    'Project #: <strong>{projectNumber}</strong><br/>'
              +    'Tenant: <strong>{tenantName}</strong><br/>'
              +    'Target start: <strong>{startDate}</strong><br/>'
              +    'Target completion: <strong>{endDate}</strong></p>'
              + '<p>Please review the work order in the Housing app and update progress as you complete the work.</p>'
              + '<p>Thank you,<br/>{nationShort} Housing</p>'
    }
  },

  // ── Application workflow status-change events ───────────────────────────
  {
    key:                   'application_mgr_recommended',
    label:                 'Application Recommended by HM',
    description:           'Sent when the Housing Manager recommends an application to the Executive Director for final approval.',
    defaultRecipientRoles: ['ed', 'housing_manager'],
    defaultCcRoles:        [],
    wired:                 true,
    placeholders:          ['applicantName','applicantId','score','tier','actionNotes','nationShort','appLink'],
    defaults: {
      subject:  '{nationShort} Housing — Application Recommended for Approval: {applicantName}',
      bodyHtml: '<p>The Housing Manager has reviewed and recommended the following application for your final approval.</p>'
              + '<p>Applicant: <strong>{applicantName}</strong> ({applicantId})<br/>'
              +    'Score: <strong>{score}</strong> &middot; Tier: <strong>{tier}</strong></p>'
              + '<p>{actionNotes}</p>'
              + '<p>Please log in to the {nationShort} Housing app to grant final approval or return the file.</p>'
              + '<p style="margin:22px 0 4px;"><a href="{appLink}" style="{brandBtnStyle}">Open {nationShort} Housing &rarr;</a></p>'
    }
  },
  {
    key:                   'application_hm_approved',
    label:                 'File Update Approved by HM',
    description:           'Sent when the Housing Manager approves a file update (existing tenant).',
    defaultRecipientRoles: ['housing_manager'],
    defaultCcRoles:        [],
    wired:                 true,
    placeholders:          ['applicantName','applicantId','actionNotes','nationShort','appLink'],
    defaults: {
      subject:  '{nationShort} Housing — File Update Approved: {applicantName}',
      bodyHtml: '<p>A file update has been reviewed and approved by the Housing Manager.</p>'
              + '<p>Applicant: <strong>{applicantName}</strong> ({applicantId})</p>'
              + '<p>{actionNotes}</p>'
              + '<p style="margin:22px 0 4px;"><a href="{appLink}" style="{brandBtnStyle}">Open {nationShort} Housing &rarr;</a></p>'
    }
  },
  {
    key:                   'application_ed_approved',
    label:                 'Application Final Approval (ED)',
    description:           'Sent when the Executive Director grants final approval.',
    defaultRecipientRoles: ['housing_manager'],
    defaultCcRoles:        [],
    wired:                 true,
    placeholders:          ['applicantName','applicantId','score','tier','actionNotes','nationShort','appLink'],
    defaults: {
      subject:  '{nationShort} Housing — Final Approval Granted: {applicantName}',
      bodyHtml: '<p>The Executive Director has granted final approval for the following application.</p>'
              + '<p>Applicant: <strong>{applicantName}</strong> ({applicantId})<br/>'
              +    'Score: <strong>{score}</strong> &middot; Tier: <strong>{tier}</strong></p>'
              + '<p>{actionNotes}</p>'
              + '<p style="margin:22px 0 4px;"><a href="{appLink}" style="{brandBtnStyle}">Open {nationShort} Housing &rarr;</a></p>'
    }
  },
  {
    key:                   'application_declined',
    label:                 'Application Declined',
    description:           'Sent when an application is declined by the Housing Manager or Executive Director.',
    defaultRecipientRoles: ['housing_manager'],
    defaultCcRoles:        [],
    wired:                 true,
    placeholders:          ['applicantName','applicantId','actionNotes','nationShort','appLink'],
    defaults: {
      subject:  '{nationShort} Housing — Application Declined: {applicantName}',
      bodyHtml: '<p>The following application has been declined.</p>'
              + '<p>Applicant: <strong>{applicantName}</strong> ({applicantId})</p>'
              + '<p>{actionNotes}</p>'
              + '<p style="margin:22px 0 4px;"><a href="{appLink}" style="{brandBtnStyle}">Open {nationShort} Housing &rarr;</a></p>'
    }
  },
  {
    key:                   'application_returned',
    label:                 'Application Returned for More Information',
    description:           'Sent when an application is returned for more information by the Housing Manager or Executive Director.',
    defaultRecipientRoles: ['housing_manager'],
    defaultCcRoles:        [],
    wired:                 true,
    placeholders:          ['applicantName','applicantId','actionNotes','nationShort','appLink'],
    defaults: {
      subject:  '{nationShort} Housing — Application Returned: {applicantName}',
      bodyHtml: '<p>The following application has been returned for more information.</p>'
              + '<p>Applicant: <strong>{applicantName}</strong> ({applicantId})</p>'
              + '<p>{actionNotes}</p>'
              + '<p style="margin:22px 0 4px;"><a href="{appLink}" style="{brandBtnStyle}">Open {nationShort} Housing &rarr;</a></p>'
    }
  },

  // ── Contractor workflow status-change events ────────────────────────────
  {
    key:                   'contractor_hm_recommended',
    label:                 'Contractor Recommended by HM',
    description:           'Sent when the Housing Manager verifies and recommends a contractor to the Executive Director.',
    defaultRecipientRoles: ['ed', 'housing_manager'],
    defaultCcRoles:        [],
    wired:                 true,
    placeholders:          ['contractorName','contractorTrade','contractorClassification','actionNotes','nationShort','appLink'],
    defaults: {
      subject:  '{nationShort} Housing — Contractor Recommended for Approval: {contractorName}',
      bodyHtml: '<p>The Housing Manager has verified and recommended the following contractor for your final approval.</p>'
              + '<p>Contractor: <strong>{contractorName}</strong><br/>'
              +    'Trade: <strong>{contractorTrade}</strong><br/>'
              +    'Classification: <strong>{contractorClassification}</strong></p>'
              + '<p>{actionNotes}</p>'
              + '<p>Please log in to the {nationShort} Housing app to grant final approval or return the file.</p>'
              + '<p style="margin:22px 0 4px;"><a href="{appLink}" style="{brandBtnStyle}">Open {nationShort} Housing &rarr;</a></p>'
    }
  },
  {
    key:                   'contractor_approved',
    label:                 'Contractor Approved by ED',
    description:           'Sent when the Executive Director grants final approval to a contractor.',
    defaultRecipientRoles: ['housing_manager'],
    defaultCcRoles:        [],
    wired:                 true,
    placeholders:          ['contractorName','contractorTrade','contractorClassification','actionNotes','nationShort','appLink'],
    defaults: {
      subject:  '{nationShort} Housing — Contractor Approved: {contractorName}',
      bodyHtml: '<p>The Executive Director has granted final approval for the following contractor.</p>'
              + '<p>Contractor: <strong>{contractorName}</strong><br/>'
              +    'Trade: <strong>{contractorTrade}</strong><br/>'
              +    'Classification: <strong>{contractorClassification}</strong></p>'
              + '<p>{actionNotes}</p>'
              + '<p style="margin:22px 0 4px;"><a href="{appLink}" style="{brandBtnStyle}">Open {nationShort} Housing &rarr;</a></p>'
    }
  },
  {
    key:                   'contractor_declined',
    label:                 'Contractor Application Declined',
    description:           'Sent when a contractor application is declined.',
    defaultRecipientRoles: ['housing_manager'],
    defaultCcRoles:        [],
    wired:                 true,
    placeholders:          ['contractorName','contractorTrade','actionNotes','nationShort','appLink'],
    defaults: {
      subject:  '{nationShort} Housing — Contractor Declined: {contractorName}',
      bodyHtml: '<p>The following contractor application has been declined.</p>'
              + '<p>Contractor: <strong>{contractorName}</strong><br/>'
              +    'Trade: <strong>{contractorTrade}</strong></p>'
              + '<p>{actionNotes}</p>'
              + '<p style="margin:22px 0 4px;"><a href="{appLink}" style="{brandBtnStyle}">Open {nationShort} Housing &rarr;</a></p>'
    }
  },
  {
    key:                   'contractor_returned',
    label:                 'Contractor Application Returned',
    description:           'Sent when a contractor application is returned for more information.',
    defaultRecipientRoles: ['housing_manager'],
    defaultCcRoles:        [],
    wired:                 true,
    placeholders:          ['contractorName','contractorTrade','actionNotes','nationShort','appLink'],
    defaults: {
      subject:  '{nationShort} Housing — Contractor Returned: {contractorName}',
      bodyHtml: '<p>The following contractor application has been returned for more information.</p>'
              + '<p>Contractor: <strong>{contractorName}</strong><br/>'
              +    'Trade: <strong>{contractorTrade}</strong></p>'
              + '<p>{actionNotes}</p>'
              + '<p style="margin:22px 0 4px;"><a href="{appLink}" style="{brandBtnStyle}">Open {nationShort} Housing &rarr;</a></p>'
    }
  }
];

// Role choices shown in the Recipients picker. Order is intentional —
// management roles first, finance last. Labels are pulled from
// CLFN_PERMS at render time so nation-configurable display names win.
var NTF_ROLE_CHOICES = [
  'ed',
  'housing_manager',
  'housing_employee_l2',
  'housing_employee_l1',
  'cfo',
  'finance_l1'
];

// Lookup helper — returns the registry entry by key, or undefined.
function _emailEventConfig(eventKey) {
  for (var i = 0; i < EMAIL_EVENT_REGISTRY.length; i++) {
    if (EMAIL_EVENT_REGISTRY[i].key === eventKey) return EMAIL_EVENT_REGISTRY[i];
  }
  return undefined;
}

// ── Template renderer ──────────────────────────────────────────────────────
// Returns { subject, bodyHtml } for the given event, with placeholders
// substituted from the supplied tokens map. Unknown placeholders left
// untouched in the saved template are replaced with '—' so they never
// reach the recipient as raw {token}.
//
// Per-event notify functions build the tokens map via _emailTokensForApp,
// _emailTokensForSow, _emailTokensForContractor, etc. Adding a new
// entity type = add a token builder + use it from the notify function.
// CTA-button style for email templates, derived from the NATION's brand
// colour (registry/theme via _resolveBrandColorHex) with a luminance-picked
// text colour — per the brand rule that a button is the ONE surface a brand
// fill is allowed on (a yellow brand needs black text, a dark one white).
// Falls back to a neutral dark slate when no brand colour resolves.
function _brandBtnStyle() {
  var bg = (typeof _resolveBrandColorHex === 'function' ? _resolveBrandColorHex() : '') || '#1f2937';
  var h = String(bg).replace('#', '');
  if (h.length === 3) h = h.split('').map(function (c) { return c + c; }).join('');
  var r = parseInt(h.slice(0, 2), 16) || 0, g = parseInt(h.slice(2, 4), 16) || 0, b = parseInt(h.slice(4, 6), 16) || 0;
  var fg = ((0.299 * r + 0.587 * g + 0.114 * b) / 255) > 0.6 ? '#111827' : '#ffffff';
  return 'display:inline-block;background:' + bg + ';color:' + fg + ';text-decoration:none;font-weight:700;font-size:14px;padding:11px 22px;border-radius:8px;';
}
window._brandBtnStyle = _brandBtnStyle;

function _renderEmailTemplate(eventKey, tokens) {
  var cfg = _emailEventConfig(eventKey);
  if (!cfg) {
    console.warn('[notifications] unknown event:', eventKey);
    return null;
  }
  // Saved override (Settings → Notifications tab) wins; otherwise default.
  var saved = (window._appSettings && window._appSettings.email_templates
            && window._appSettings.email_templates[eventKey]) || {};
  var subject  = (saved.subject  != null && saved.subject  !== '') ? saved.subject  : cfg.defaults.subject;
  var bodyHtml = (saved.bodyHtml != null && saved.bodyHtml !== '') ? saved.bodyHtml : cfg.defaults.bodyHtml;

  // Global tokens merged for every event (entity builders never need to
  // remember them): {brandBtnStyle} styles CTA buttons in the brand colour.
  var t = Object.assign({ brandBtnStyle: _brandBtnStyle() }, tokens || {});
  return {
    subject:  _substitutePlaceholders(subject,  t),
    bodyHtml: _substitutePlaceholders(bodyHtml, t)
  };
}

// appLink token — best-effort deep link to the housing app at the
// current origin. Shared by every entity-specific token builder so
// recipients always have a way to open the app.
function _emailAppLink() {
  if (typeof window === 'undefined' || !window.location) return '/';
  return window.location.origin + (window.location.pathname.indexOf('/housing.html') >= 0 ? '/housing.html' : '/');
}

function _emailNationShort() {
  return nationShort();
}

// Build the placeholder token map from an application object.
function _emailTokensForApp(app) {
  var name = ((app && app.fn) || '') + ' ' + ((app && app.ln) || '');
  name = name.trim() || 'Applicant';
  return {
    applicantName: name,
    applicantId:   (app && app.id)    || '—',
    score:         (app && app.score != null) ? String(app.score) : '—',
    tier:          (app && app.tier)  || '—',
    nationShort:   _emailNationShort(),
    appLink:       _emailAppLink()
  };
}

// Build tokens from an SOW save payload. `unitId` falls back to a unit
// lookup for the address when the form's address field is blank.
function _emailTokensForSow(sow, unitId) {
  var addr = (sow && sow.address) || '';
  if (!addr && unitId && typeof housingUnits !== 'undefined') {
    var u = (housingUnits || []).find(function(x){ return x.id === unitId; });
    if (u) addr = ((u.num || '') + ' ' + (u.street || '')).trim();
  }
  if (!addr) addr = unitId || '—';
  return {
    unitAddress: addr,
    totalCost:   (sow && sow.totalCost)  || '—',
    condition:   (sow && sow.condition)  || '—',
    contractor:  (sow && sow.contractor) || '—',
    nationShort: _emailNationShort(),
    appLink:     _emailAppLink()
  };
}

// Build tokens for the tenant-copy variant of the SOW email. Reuses the
// SOW builder fields but adds the tenantName + projectNumber tokens the
// tenant-facing template uses. `unit` is the housing_units row (for the
// fallback address derivation); `tenantName` is the resolved tenant name
// — taken from the SOW form field if entered, else from unit.assignedName.
function _emailTokensForSowTenant(sow, unit, tenantName) {
  var base = _emailTokensForSow(sow, unit && unit.id);
  base.tenantName    = tenantName || (sow && sow.tenantName) || (unit && unit.assignedName) || '—';
  base.projectNumber = (sow && sow.project_number) || '—';
  return base;
}

// Build tokens for the work-order-to-contractor email. Mirrors the tenant
// builder but keys on contractorName instead, and surfaces the start/end
// dates the contractor cares about. `contractor` is the contractors row;
// `tenantName` falls back to unit.assignedName.
function _emailTokensForWorkOrder(sow, unit, contractor) {
  var base = _emailTokensForSow(sow, unit && unit.id);
  base.contractorName = (contractor && contractor.name) || (sow && sow.contractor) || '—';
  base.tenantName     = (sow && sow.tenantName) || (unit && unit.assignedName) || '—';
  base.projectNumber  = (sow && sow.project_number) || '—';
  base.startDate      = (sow && sow.startDate) || '—';
  base.endDate        = (sow && sow.endDate)   || '—';
  return base;
}

// Build tokens from a contractor record.
function _emailTokensForContractor(ct) {
  var classLabels = {
    internal_indigenous:     'Internal - Indigenous',
    external_indigenous:     'External - Indigenous',
    external_non_indigenous: 'External - Non-Indigenous'
  };
  return {
    contractorName:           (ct && ct.name)  || '—',
    contractorTrade:          (ct && ct.trade) || '—',
    contractorClassification: (ct && classLabels[ct.classification]) || (ct && ct.classification) || '—',
    nationShort:              _emailNationShort(),
    appLink:                  _emailAppLink()
  };
}

// Plain {token} substitution. Unknown tokens that survived editing get
// replaced with '—' so recipients never see raw braces.
function _substitutePlaceholders(template, tokens) {
  if (template == null) return '';
  return String(template).replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, function(_match, key) {
    return (tokens && Object.prototype.hasOwnProperty.call(tokens, key))
      ? String(tokens[key])
      : '—';
  });
}

// ── Recipient resolution ───────────────────────────────────────────────────
// Pull active staff with the given role from the staff table.
// Returns [{name, email}, …] — empty array on any error so callers
// never blow up on transient network failures.
async function _sbLoadActiveStaffByRole(role) {
  if (!role) return [];
  try {
    // select=* (not a fixed column list) so the magic_link filter below stays
    // safe on a nation DB that hasn't added that column yet.
    var url = SUPABASE_URL
            + '/rest/v1/staff?select=*'
            + '&is_active=eq.true&role=eq.' + encodeURIComponent(role);
    var r = await fetch(url, { headers: HOUSING_HEADERS });
    if (!r.ok) { console.warn('[staff lookup] ' + role + ' failed:', await r.text()); return []; }
    var rows = await r.json();
    // Exclude external consultants (passwordless / magic-link accounts) from
    // role-based workflow notifications — they should not receive staff emails.
    return (rows || []).filter(function(s){ return s && s.email && s.magic_link !== true; });
  } catch (e) {
    console.warn('[staff lookup] ' + role + ' error:', e);
    return [];
  }
}

// ── Approver name pickers (HM / ED) ──────────────────────────────────────────
// An approval name field pre-populates with a sensible default and offers the
// active staff who hold that role as a dropdown, so a nation with more than one
// Housing Manager / Executive Director can pick the right person while still
// being able to type a name. Uses a <datalist> so it drops onto any existing
// text input with no layout change. Cached per role for the session.
window._approverNameCache = window._approverNameCache || {};
async function _loadApproverNames(role){
  if(!role) return [];
  if(window._approverNameCache[role]) return window._approverNameCache[role];
  var rows = (typeof _sbLoadActiveStaffByRole === 'function') ? await _sbLoadActiveStaffByRole(role) : [];
  var names = (rows || []).map(function(s){ return String((s && s.name) || '').trim(); }).filter(Boolean);
  names = names.filter(function(n, i){ return names.indexOf(n) === i; });   // de-dupe
  window._approverNameCache[role] = names;
  return names;
}
// Wire one approval name input. role: 'housing_manager' | 'ed'. Attaches a
// datalist of active staff of that role and, when the field is empty, pre-fills
// a default: the logged-in user if they hold the role, else the sole staff
// member of that role. opts.unlock=false leaves a readonly field readonly.
async function wireApproverPicker(inputId, role, opts){
  opts = opts || {};
  var el = document.getElementById(inputId);
  if(!el) return;
  try {
    var names = await _loadApproverNames(role);
    var listId = inputId + '__approvers';
    var dl = document.getElementById(listId);
    if(!dl){ dl = document.createElement('datalist'); dl.id = listId; (el.parentNode || document.body).appendChild(dl); }
    dl.innerHTML = names.map(function(n){ return '<option value="' + String(n).replace(/"/g,'&quot;') + '"></option>'; }).join('');
    el.setAttribute('list', listId);
    el.setAttribute('autocomplete', 'off');
    if(opts.unlock !== false) el.removeAttribute('readonly');
    if(!el.value || !el.value.trim()){
      var def = '';
      var myName = (window.HOUSING_SESSION && HOUSING_SESSION.name) || '';
      var myRoleRaw = window._realRole || window.currentRole || '';
      var myRole = (typeof CLFN_PERMS !== 'undefined' && CLFN_PERMS.normalizeRole) ? CLFN_PERMS.normalizeRole(myRoleRaw) : myRoleRaw;
      var iHoldRole = (myRole === role) || (role === 'ed' && myRole === 'super_user');
      if(myName && iHoldRole) def = myName;             // I'm the HM/ED entering this
      else if(names.length === 1) def = names[0];       // only one on file — obvious default
      if(def) el.value = def;
    }
  } catch(e){ console.warn('[approver picker] ' + inputId + ':', e); }
}
window.wireApproverPicker = wireApproverPicker;

// ── Per-event notify functions ─────────────────────────────────────────────
// Each function: resolve recipients, render template, fan out via
// window.sendNotification. Best-effort, never throws.

// Wired from finalSubmit() in housing-app.js. Picks the event based on
// whether this is an UPDATE (an application that already existed / had been
// submitted before) or a first submission, then by app.appType:
//   opts.isUpdate === true → application_updated (explains it's a resubmission)
//   existing_tenant        → file_update_submitted
//   transfer_request       → transfer_request_submitted
//   else                   → application_submitted
async function notifyApplicationSubmitted(app, opts) {
  if (!app) return;
  opts = opts || {};
  var eventKey = opts.isUpdate                       ? 'application_updated'
               : app.appType === 'existing_tenant'  ? 'file_update_submitted'
               : app.appType === 'transfer_request' ? 'transfer_request_submitted'
               : 'application_submitted';
  var cfg      = _emailEventConfig(eventKey);
  if (!cfg) return;
  var roles    = _emailEventRecipientRoles(eventKey).concat(_emailEventCcRoles(eventKey));
  if (!roles.length) {
    console.warn('[notify] no recipient roles configured for ' + eventKey);
    return;
  }
  var recipients = await _resolveActiveStaffForRoles(roles);
  if (!recipients.length) {
    console.warn('[notify] no active staff in roles ' + roles.join(',') + ' for ' + (app.id || 'new app'));
    return;
  }
  var rendered = _renderEmailTemplate(eventKey, _emailTokensForApp(app));
  if (!rendered) return;

  await _sendSerially(recipients, function(rcp){
    return {
      to:          rcp.email,
      to_name:     rcp.name || '',
      subject:     rendered.subject,
      bodyHtml:    rendered.bodyHtml,
      event:       eventKey,
      entity_type: 'application',
      entity_id:   app.id || '—'
    };
  }, eventKey);
}

// Send a list of payloads serially (one Graph call at a time) so the
// app stays under Microsoft Graph's MailboxConcurrency throttle (~4
// concurrent sends per app per mailbox). Continues on per-recipient
// failure so one bad address doesn't block the rest.
async function _sendSerially(recipients, payloadBuilder, eventKey) {
  for (var i = 0; i < recipients.length; i++) {
    var rcp = recipients[i];
    try {
      await window.sendNotification(payloadBuilder(rcp));
    } catch (err) {
      console.warn('[notify] ' + eventKey + ' to ' + (rcp.email || rcp) + ' failed:', err);
    }
  }
}

// Wired from saveSOW() in housing-modals-sow.js, only on the FIRST save
// of a SOW (subsequent edits do not re-notify). Emails every active
// staff member whose role is in the saved (or default) recipient list.
async function notifySowCreated(sow, unitId) {
  if (!sow) return;
  var eventKey = 'sow_created';
  var roles    = _emailEventRecipientRoles(eventKey).concat(_emailEventCcRoles(eventKey));
  if (!roles.length) {
    console.warn('[notify] no recipient roles configured for ' + eventKey);
    return;
  }
  var recipients = await _resolveActiveStaffForRoles(roles);
  if (!recipients.length) {
    console.warn('[notify] no active staff in roles ' + roles.join(',') + ' for SOW on ' + (unitId || 'unknown unit'));
    return;
  }
  var rendered = _renderEmailTemplate(eventKey, _emailTokensForSow(sow, unitId));
  if (!rendered) return;

  await _sendSerially(recipients, function(rcp){
    return {
      to:          rcp.email,
      to_name:     rcp.name || '',
      subject:     rendered.subject,
      bodyHtml:    rendered.bodyHtml,
      event:       eventKey,
      entity_type: 'sow',
      entity_id:   unitId || '—'
    };
  }, eventKey);
}

// Wired from saveContractor() in shared-data.js, only when a contractor
// is submitted (status === 'pending_review'). Drafts do not notify
// because there's nothing for an approver to act on yet.
async function notifyContractorSubmitted(ct) {
  if (!ct) return;
  var eventKey = 'contractor_submitted';
  var roles    = _emailEventRecipientRoles(eventKey).concat(_emailEventCcRoles(eventKey));
  if (!roles.length) {
    console.warn('[notify] no recipient roles configured for ' + eventKey);
    return;
  }
  var recipients = await _resolveActiveStaffForRoles(roles);
  if (!recipients.length) {
    console.warn('[notify] no active staff in roles ' + roles.join(',') + ' for contractor ' + (ct.id || ct.name || 'unknown'));
    return;
  }
  var rendered = _renderEmailTemplate(eventKey, _emailTokensForContractor(ct));
  if (!rendered) return;

  await _sendSerially(recipients, function(rcp){
    return {
      to:          rcp.email,
      to_name:     rcp.name || '',
      subject:     rendered.subject,
      bodyHtml:    rendered.bodyHtml,
      event:       eventKey,
      entity_type: 'contractor',
      entity_id:   ct.id || '—'
    };
  }, eventKey);
}

// ── Application status-change notifications ────────────────────────────────
// Maps the action string from confirmApprovalAction() to a registry key,
// builds tokens, and fans out to configured recipients via _sendSerially.
// Wired from housing-modals.js confirmApprovalAction() after save + audit.

var _APP_ACTION_EVENT_KEY = {
  mgr_approved: 'application_mgr_recommended',
  hm_approved:  'application_hm_approved',
  ed_approved:  'application_ed_approved',
  declined:     'application_declined',
  returned:     'application_returned'
};

var _APP_ACTION_LABEL = {
  mgr_approved: 'Recommended to Executive Director',
  hm_approved:  'File Update Approved',
  ed_approved:  'Final Approval Granted',
  declined:     'Declined',
  returned:     'Returned for More Information'
};

function _emailTokensForAppAction(app, action, notes) {
  var base = _emailTokensForApp(app);
  base.actionLabel = _APP_ACTION_LABEL[action] || action;
  base.actionNotes = (notes && notes.trim()) ? notes.trim() : '';
  return base;
}

async function notifyApplicationStatusChange(app, action, notes) {
  if (!app || !action) return;
  var eventKey = _APP_ACTION_EVENT_KEY[action];
  if (!eventKey) return;
  var roles = _emailEventRecipientRoles(eventKey).concat(_emailEventCcRoles(eventKey));
  if (!roles.length) {
    console.warn('[notify] no recipient roles configured for ' + eventKey);
    return;
  }
  var recipients = await _resolveActiveStaffForRoles(roles);
  if (!recipients.length) {
    console.warn('[notify] no active staff in roles ' + roles.join(',') + ' for ' + (app.id || 'app'));
    return;
  }
  var rendered = _renderEmailTemplate(eventKey, _emailTokensForAppAction(app, action, notes));
  if (!rendered) return;

  await _sendSerially(recipients, function(rcp){
    return {
      to:          rcp.email,
      to_name:     rcp.name || '',
      subject:     rendered.subject,
      bodyHtml:    rendered.bodyHtml,
      event:       eventKey,
      entity_type: 'application',
      entity_id:   app.id || '—'
    };
  }, eventKey);
}

// ── Contractor workflow status-change notifications ─────────────────────────
// Maps the action string from confirmCtAction() to a registry key and sends.
// Wired from shared-data.js confirmCtAction() after save + audit.

var _CT_ACTION_EVENT_KEY = {
  hm_recommended: 'contractor_hm_recommended',
  approved:       'contractor_approved',
  declined:       'contractor_declined',
  returned:       'contractor_returned'
};

var _CT_ACTION_LABEL = {
  hm_recommended: 'HM Verified and Recommended to ED',
  approved:       'ED Final Approval Granted',
  declined:       'Declined',
  returned:       'Returned for More Information'
};

function _emailTokensForContractorAction(ct, action, notes) {
  var base = _emailTokensForContractor(ct);
  base.actionLabel = _CT_ACTION_LABEL[action] || action;
  base.actionNotes = (notes && notes.trim()) ? notes.trim() : '';
  return base;
}

async function notifyContractorStatusChange(ct, action, notes) {
  if (!ct || !action) return;
  var eventKey = _CT_ACTION_EVENT_KEY[action];
  if (!eventKey) return;
  var roles = _emailEventRecipientRoles(eventKey).concat(_emailEventCcRoles(eventKey));
  if (!roles.length) {
    console.warn('[notify] no recipient roles configured for ' + eventKey);
    return;
  }
  var recipients = await _resolveActiveStaffForRoles(roles);
  if (!recipients.length) {
    console.warn('[notify] no active staff in roles ' + roles.join(',') + ' for contractor ' + (ct.id || ct.name || 'unknown'));
    return;
  }
  var rendered = _renderEmailTemplate(eventKey, _emailTokensForContractorAction(ct, action, notes));
  if (!rendered) return;

  await _sendSerially(recipients, function(rcp){
    return {
      to:          rcp.email,
      to_name:     rcp.name || '',
      subject:     rendered.subject,
      bodyHtml:    rendered.bodyHtml,
      event:       eventKey,
      entity_type: 'contractor',
      entity_id:   ct.id || '—'
    };
  }, eventKey);
}

// ── Applicant confirmation w/ PDF attachment ───────────────────────────────
// Wired from finalSubmit() in housing-app.js. Sends a copy of the just-
// submitted application as a PDF to the applicant's email (and the
// co-applicant's email if it's set and different). Silent skip if the
// applicant didn't provide an email — the audit log records the no-op.
// Applicant "approved → wait list" email — fired from the portal-submission
// review (Approve & create / Merge) when the reviewer leaves the email
// checkbox ticked. Wording is policy-sensitive: approval means the applicant
// joined the WAIT LIST — never an offer of housing. Silent skip when the
// application has no valid email.
async function notifyApplicationApprovedWaitlist(app) {
  if (!app) return;
  var eventKey = 'application_approved_waitlist';
  var email = String(app.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.log('[notify] approved-waitlist skipped - no applicant email on ' + (app.id || 'app'));
    return;
  }
  var rendered = _renderEmailTemplate(eventKey, _emailTokensForApp(app));
  if (!rendered) return;
  await _sendSerially([{ email: email }], function (rcp) {
    return {
      to:          rcp.email,
      to_name:     ((app.fn || '') + ' ' + (app.ln || '')).trim(),
      subject:     rendered.subject,
      bodyHtml:    rendered.bodyHtml,
      event:       eventKey,
      entity_type: 'application',
      entity_id:   app.id || '—'
    };
  }, eventKey);
}
window.notifyApplicationApprovedWaitlist = notifyApplicationApprovedWaitlist;

async function notifyApplicationConfirmation(app) {
  if (!app) return;
  var eventKey = 'application_confirmation_to_applicant';

  // Collect the applicant's email + co-applicant's email if distinct,
  // PLUS any active staff in the configured CC roles. All deduped by
  // lowercased email so a staffer who happens to also be the applicant
  // doesn't get two copies.
  var seen   = {};
  var emails = [];
  function _addEmail(addr) {
    if (!addr) return;
    var clean = String(addr).trim().toLowerCase();
    if (!clean || seen[clean]) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) return;
    seen[clean] = true;
    emails.push(clean);
  }
  _addEmail(app.email);
  _addEmail(app.coApp && app.coApp.email);   // field lives on coApp — app.co_email never existed, so co-applicants never got the copy

  // Additional staff recipients: primary + CC role checkboxes from the
  // Settings -> Notifications tab. Both default to empty for this event
  // (applicant is the only required recipient). Combined + deduped
  // against the applicant emails already collected above.
  var extraRoles = _emailEventRecipientRoles(eventKey).concat(_emailEventCcRoles(eventKey));
  if (extraRoles.length) {
    var extraRecipients = await _resolveActiveStaffForRoles(extraRoles);
    extraRecipients.forEach(function(r){ _addEmail(r.email); });
  }

  if (!emails.length) {
    console.log('[notify] application_confirmation skipped - no applicant email or CC recipients on ' + (app.id || 'app'));
    return;
  }

  // Render template (reuses applicant token builder — same placeholder set).
  var rendered = _renderEmailTemplate(eventKey, _emailTokensForApp(app));
  if (!rendered) return;

  // Generate the PDF from the live form (the just-submitted form is still
  // in the DOM at this point). If the PDF generator fails for any reason,
  // we still send the email — just without the attachment, with a note in
  // the body. Best-effort: never block delivery on PDF rendering.
  var pdfBase64 = null;
  try {
    pdfBase64 = await _generateApplicationPdfBase64();
  } catch (e) {
    console.warn('[notify] PDF generation failed, sending without attachment:', e);
  }

  var attachments;
  var bodyHtml = rendered.bodyHtml;
  if (pdfBase64) {
    attachments = [{
      name:         'Application ' + (app.id || 'submitted') + '.pdf',
      contentType:  'application/pdf',
      contentBytes: pdfBase64
    }];
  } else {
    bodyHtml += '<p style="color:#888;font-size:12px;font-style:italic;">'
              + '(PDF copy could not be generated automatically. Reply to this email to request one.)'
              + '</p>';
  }

  await _sendSerially(emails.map(function(e){ return { email: e }; }), function(rcp){
    return {
      to:          rcp.email,
      to_name:     '',
      subject:     rendered.subject,
      bodyHtml:    bodyHtml,
      attachments: attachments,
      event:       eventKey,
      entity_type: 'application',
      entity_id:   app.id || '—'
    };
  }, eventKey);
}

async function _loadJsPdf() {
  // Delegates to the shared lazy-loader in shared.js (single implementation).
  await window.loadJsPdf();
}
// Generate the applicant confirmation PDF as a text-rendered (vector)
// document using jsPDF's native text + line primitives. Walks the live
// form fields the same way printApplicationPreview() does, but emits
// selectable text rather than rasterised HTML. Signature canvases are
// embedded as small PNG images at the end (the only raster content).
// Output is typically ~20-60 KB and the text stays sharp at any zoom.

// ── Shared PDF scaffolding ──────────────────────────────────────────────────
// Called by each _generate*PdfBase64 function. Returns a ctx object with
// the pdf instance, layout constants, mutable cursor state (ctx.y /
// ctx.pageNum), and six shared layout primitives. ctx.finish() stamps the
// final page footer and returns the base64 string.
// Fetches the nation logo (from _appSettings.theme.logo) and returns a data
// URL suitable for pdf.addImage(). Returns null on any error.
var _logoDataUrlCache = null;

async function _fetchLogoForPdf() {
  if (_logoDataUrlCache !== null) return _logoDataUrlCache || null;
  try {
    // Prefer the per-nation theme logo; fall back to the cached logo, then the
    // embedded default-nation logo (same chain the finance PDFs use) so the
    // header is branded even when no theme logo is configured on this page.
    var logoUrl = (window._appSettings && _appSettings.theme && _appSettings.theme.logo) || null;
    if (!logoUrl) { try { logoUrl = sessionStorage.getItem('clfn_logo_cache'); } catch(e) {} }
    if (!logoUrl) logoUrl = window.HLH_LOGO_DATA_URL || window.CLFN_LOGO_DATA_URL || null;
    if (!logoUrl) { _logoDataUrlCache = ''; return null; }
    // Already a data URL (embedded / cached) — use directly, no fetch needed.
    if (logoUrl.indexOf('data:') === 0) { _logoDataUrlCache = logoUrl; return logoUrl; }
    var resp = await fetch(logoUrl);
    if (!resp.ok) { _logoDataUrlCache = ''; return null; }
    var blob = await resp.blob();
    _logoDataUrlCache = await new Promise(function(resolve) {
      var reader = new FileReader();
      reader.onload  = function(e) { resolve(e.target.result); };
      reader.onerror = function()  { resolve(''); };
      reader.readAsDataURL(blob);
    });
    return _logoDataUrlCache || null;
  } catch(e) {
    console.warn('[pdf] logo fetch failed:', e);
    _logoDataUrlCache = '';
    return null;
  }
}

// opts (all optional — contact fields are auto-read from NATION_CONFIG when present):
//   nationName     — overrides NATION_CONFIG.display_name
//   headerTitle    — document title (top-right); triggers header/footer mode
//   headerSubtitle — reference line (top-right, below title)
//   footerLeft     — left-side footer text (defaults to "[Nation] Housing — Confidential")
function _makePdfDoc(opts) {
  opts = opts || {};
  if (!window.jspdf || !window.jspdf.jsPDF) throw new Error('jsPDF not available');
  var pdf      = new window.jspdf.jsPDF({ unit: 'mm', format: 'a4', compress: true });
  var pageW    = pdf.internal.pageSize.getWidth();
  var pageH    = pdf.internal.pageSize.getHeight();
  var marginL  = 14, marginR = 14, marginB = 18;

  // Read nation contact info from NATION_CONFIG (set in shared-config.js / Nation settings)
  var nc           = window.NATION_CONFIG || {};
  var nationName   = opts.nationName   || nc.display_name || nc.name || '';
  var nationPhone  = nc.phone          || '';
  var nationEmail  = nc.email          || '';
  var nationAddr   = nc.mailing_address ? nc.mailing_address.split('\n')[0] : ''; // first line only

  var hasHeader = !!opts.headerTitle;
  // marginT: base 14mm; +10 for name+rule, +4 per contact line
  var contactLines = (nationAddr ? 1 : 0) + (nationPhone || nationEmail ? 1 : 0);
  var marginT  = hasHeader ? (22 + contactLines * 4) : 14;
  var contentW = pageW - marginL - marginR;

  var ctx = {
    pdf: pdf, pageW: pageW, pageH: pageH,
    marginL: marginL, marginR: marginR, marginT: marginT, marginB: marginB,
    contentW: contentW,
    y: marginT, pageNum: 1
  };

  ctx.drawHeader = function() {
    if (!hasHeader) return;
    var lx = marginL, rx = pageW - marginR;

    // Logo — top-left, max 20mm wide × 14mm tall
    var logoOffsetX = 0;
    if (opts.logoDataUrl) {
      try {
        var fmt = opts.logoDataUrl.indexOf('image/png') >= 0 ? 'PNG' : 'JPEG';
        var logoH = 13, logoW = 20;
        pdf.addImage(opts.logoDataUrl, fmt, lx, 3, logoW, logoH);
        logoOffsetX = logoW + 3; // text starts after logo + 3mm gap
      } catch(e) { console.warn('[pdf header] logo embed failed:', e); }
    }

    var tx = lx + logoOffsetX; // left text anchor
    var y  = 8;

    // Left — nation name
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(8);
    pdf.setTextColor(30);
    pdf.text(nationName.toUpperCase(), tx, y);

    // Right — document title
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(9);
    pdf.setTextColor(20);
    pdf.text(opts.headerTitle, rx, y, { align: 'right' });

    y += 4;

    // Left — mailing address (line 1)
    if (nationAddr) {
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(7);
      pdf.setTextColor(100);
      pdf.text(nationAddr, tx, y);
      y += 4;
    }

    // Left — phone | email
    if (nationPhone || nationEmail) {
      var contactStr = [nationPhone, nationEmail].filter(Boolean).join('  |  ');
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(7);
      pdf.setTextColor(100);
      pdf.text(contactStr, tx, y);
    }

    // Right — subtitle / reference
    if (opts.headerSubtitle) {
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(7);
      pdf.setTextColor(110);
      pdf.text(opts.headerSubtitle, rx, 12, { align: 'right' });
    }

    // Yellow separator rule
    var ruleY = marginT - 4;
    pdf.setDrawColor(window._themeAccentHex());
    pdf.setLineWidth(0.6);
    pdf.line(lx, ruleY, rx, ruleY);
    pdf.setDrawColor(0);
    pdf.setFont('helvetica', 'normal');
    pdf.setTextColor(0);
  };

  // Footer is drawn in finish() so total page count is known
  ctx.needSpace = function(h) {
    if (ctx.y + h > pageH - marginB) {
      // Callers typically set their font/size/color BEFORE needSpace and draw
      // AFTER it. drawHeader() (run on the new page) changes the font state, so
      // without restoring it the text would render in the header's leftover
      // font — e.g. a body paragraph that crosses a page break printing at the
      // 7pt header size. Save and restore around the page break.
      var _fs = null, _f = null, _tc = null;
      try { _fs = pdf.getFontSize(); } catch(e) {}
      try { _f  = pdf.getFont(); } catch(e) {}
      try { _tc = pdf.getTextColor(); } catch(e) {}
      pdf.addPage();
      ctx.pageNum++;
      ctx.y = marginT;
      ctx.drawHeader();
      try { if (_f) pdf.setFont(_f.fontName, _f.fontStyle); } catch(e) {}
      try { if (_fs != null) pdf.setFontSize(_fs); } catch(e) {}
      try { if (_tc != null) pdf.setTextColor(_tc); } catch(e) {}
    }
  };
  ctx.sectionHeader = function(title) {
    ctx.needSpace(10);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(10);
    pdf.setTextColor(100);
    pdf.text(String(title).toUpperCase(), marginL, ctx.y + 3);
    pdf.setDrawColor(window._themeAccentHex());
    pdf.setLineWidth(0.8);
    pdf.line(marginL, ctx.y + 4.5, pageW - marginR, ctx.y + 4.5);
    pdf.setDrawColor(0);
    pdf.setTextColor(0);
    ctx.y += 7;
  };
  ctx.row = function(label, value) {
    var labelW = 55, colGap = 3;
    var valueX = marginL + labelW + colGap;
    var valueW = contentW - labelW - colGap;
    var v = (value == null || value === '') ? '—' : String(value);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8.5);
    var labelLines = pdf.splitTextToSize(label, labelW);
    var valueLines = pdf.splitTextToSize(v, valueW);
    var rowH = Math.max(labelLines.length, valueLines.length) * 4 + 1;
    ctx.needSpace(rowH + 1);
    pdf.setTextColor(110);
    pdf.text(labelLines, marginL, ctx.y + 3);
    pdf.setTextColor(20);
    pdf.text(valueLines, valueX, ctx.y + 3);
    ctx.y += rowH;
    pdf.setDrawColor(230);
    pdf.setLineWidth(0.1);
    pdf.line(marginL, ctx.y, pageW - marginR, ctx.y);
    pdf.setDrawColor(0);
    ctx.y += 1.5;
  };
  ctx.paragraph = function(text, fontSize) {
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(fontSize || 9);
    pdf.setTextColor(40);
    var lines = pdf.splitTextToSize(String(text), contentW);
    ctx.needSpace(lines.length * 4 + 2);
    pdf.text(lines, marginL, ctx.y + 3);
    ctx.y += lines.length * 4 + 2;
    pdf.setTextColor(0);
  };
  ctx.gap = function(h) { ctx.y += (h || 3); };
  ctx.finish = function() {
    // Draw footer on every page now that total page count is known
    var total = pdf.internal.getNumberOfPages();
    var footerLeft = opts.footerLeft || (nationName ? nationName + ' Housing — Confidential' : '');
    for (var p = 1; p <= total; p++) {
      pdf.setPage(p);
      // Separator line
      pdf.setDrawColor(200);
      pdf.setLineWidth(0.2);
      pdf.line(marginL, pageH - 12, pageW - marginR, pageH - 12);
      pdf.setDrawColor(0);
      // Left text
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(7.5);
      pdf.setTextColor(140);
      if (footerLeft) pdf.text(footerLeft, marginL, pageH - 7);
      // Page X of Y — right
      pdf.text('Page ' + p + ' of ' + total, pageW - marginR, pageH - 7, { align: 'right' });
      pdf.setTextColor(0);
    }
    var dataUri = pdf.output('datauristring');
    return dataUri.substring(dataUri.indexOf(',') + 1);
  };

  // Draw header on page 1; subsequent pages get it via needSpace → addPage
  ctx.drawHeader();

  return ctx;
}

async function _generateApplicationPdfBase64() {
  await _loadJsPdf();
  var ctx         = _makePdfDoc();
  var pdf         = ctx.pdf, pageW = ctx.pageW, pageH = ctx.pageH;
  var marginL     = ctx.marginL, marginR = ctx.marginR, marginT = ctx.marginT;
  var contentW    = ctx.contentW;
  var needSpace   = ctx.needSpace.bind(ctx);
  var sectionHeader = ctx.sectionHeader.bind(ctx);
  var row         = ctx.row.bind(ctx);
  var paragraph   = ctx.paragraph.bind(ctx);
  var gap         = ctx.gap.bind(ctx);

  // ── Form readers ──────────────────────────────────────────────────
  function fld(id) {
    var e = document.getElementById(id);
    return (e && e.value && String(e.value).trim()) ? String(e.value).trim() : '';
  }
  function chk(id) {
    var e = document.getElementById(id); return e ? !!e.checked : false;
  }
  function yn(v) { return v ? 'Yes' : 'No'; }
  function fmtPhone(v) {
    return (typeof formatPhone === 'function' && v) ? formatPhone(v) : (v || '');
  }
  function fmtCur(v) {
    if (v == null || v === '') return '';
    if (typeof formatCurrency === 'function' && typeof parseCurrency === 'function') {
      return formatCurrency(parseCurrency(v));
    }
    return '$' + v;
  }
  function dollarQ(sel) {
    var e = document.querySelector(sel); return e ? fmtCur(e.value) : '';
  }
  function getSig(canvasId) {
    if (typeof getSigDataURL === 'function') {
      try { return getSigDataURL(canvasId); } catch (e) { return ''; }
    }
    var c = document.getElementById(canvasId);
    try { return c ? c.toDataURL('image/png') : ''; } catch (e) { return ''; }
  }

  var today   = new Date().toLocaleDateString('en-CA');
  var appId   = (typeof currentAppId !== 'undefined' && currentAppId) ? currentAppId : '—';
  var nation  = (window.NATION_CONFIG && (NATION_CONFIG.display_name || NATION_CONFIG.name)) || '';
  var short   = nationShort();
  var fnVal   = fld('fn');
  var lnVal   = fld('ln');
  var fullName= (fnVal + ' ' + lnVal).trim() || '—';
  var hasCoApp  = (document.getElementById('co_status') || {}).value === 'yes';
  var hasHouse  = chk('hasHouseToggle');
  var hasArr    = chk('arrToggle');
  var isHomeless= chk('homelessToggle');

  // ── HEADER ────────────────────────────────────────────────────────
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(15);
  pdf.text((short ? short + ' ' : '') + 'Housing Application', marginL, ctx.y + 5);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(9);
  pdf.setTextColor(110);
  if (nation) pdf.text(nation, marginL, ctx.y + 10);

  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(11);
  pdf.setTextColor(20);
  pdf.text(fullName, pageW - marginR, ctx.y + 5, { align: 'right' });
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(9);
  pdf.setTextColor(110);
  pdf.text(appId,             pageW - marginR, ctx.y + 10, { align: 'right' });
  pdf.text('Date: ' + today,  pageW - marginR, ctx.y + 15, { align: 'right' });
  ctx.y += 17;
  pdf.setDrawColor(window._themeAccentHex());
  pdf.setLineWidth(1);
  pdf.line(marginL, ctx.y, pageW - marginR, ctx.y);
  pdf.setDrawColor(0);
  pdf.setTextColor(0);
  ctx.y += 6;

  // ── 1. APPLICANT INFORMATION ──────────────────────────────────────
  sectionHeader('Applicant Information');
  row('First Name',             fld('fn'));
  row('Last Name',              fld('ln'));
  row('Date of Birth',          fld('dob'));
  row('Band Number',            fld('band'));
  row('On Reserve Status',      fld('reserve'));
  row('Marital Status',         fld('marital'));
  row('Cell Phone',             fmtPhone(fld('phone')));
  row('Email Address',          fld('email'));
  row('Application Date',       fld('appDate'));
  row('Accessibility Needs',    fld('accessibility'));
  row('Housing Classification',
    typeof getHousingClassification === 'function' ? getHousingClassification() : '');
  gap();

  // ── 2. CURRENT ADDRESS ────────────────────────────────────────────
  sectionHeader('Current Address');
  if (isHomeless) {
    row('Status', 'Homeless / No Fixed Address');
  } else {
    row('Street Address',  fld('street'));
    row('City',            fld('city'));
    row('Province',        fld('prov'));
    row('Postal Code',     fld('postal'));
  }
  row('Expected Occupancy Date',  fld('occDate'));
  gap();

  // ── 3. CURRENT HOUSING & ARREARS ──────────────────────────────────
  sectionHeader('Current Housing & Arrears');
  row('Currently Has a House', yn(hasHouse));
  if (hasHouse) {
    row('Home Condition',       fld('homeCondition'));
    row('Est. Renovation Cost', dollarQ('#homeCondBlk input[type="number"]'));
  }
  row('Arrears Owed to ' + short, yn(hasArr));
  var arrNums  = document.querySelectorAll('#arrBlk input[type="number"]');
  var arrDates = document.querySelectorAll('#arrBlk input[type="date"]');
  var arrSel   = document.querySelector('#arrBlk select');
  row('Amount Owed',        hasArr ? fmtCur(arrNums[0] && arrNums[0].value) : 'N/A');
  row('Monthly Payment',    hasArr ? fmtCur(arrNums[1] && arrNums[1].value) : 'N/A');
  row('Plan Duration',      hasArr ? (arrNums[3] && arrNums[3].value ? arrNums[3].value + ' months' : '—') : 'N/A');
  row('Payment Frequency',  hasArr ? (arrSel ? arrSel.value : '') : 'N/A');
  row('Agreement Date',     hasArr ? (arrDates[0] ? arrDates[0].value : '') : 'N/A');
  gap();

  // ── 4. EMPLOYMENT & INCOME ────────────────────────────────────────
  sectionHeader('Employment & Income');
  var incomeRows = 0;
  document.querySelectorAll('#incomeList .rrow').forEach(function(r, i){
    var sels = r.querySelectorAll('select');
    var nums = r.querySelectorAll('input[type="number"]');
    var txts = r.querySelectorAll('input[type="text"]');
    var person = sels[0] ? sels[0].value : '';
    var type   = sels[1] ? sels[1].value : '';
    var amt    = nums[0] && nums[0].value ? fmtCur(nums[0].value) : '';
    var emp    = txts[0] ? txts[0].value : '';
    row(person || ('Income ' + (i + 1)),
        type + (amt ? ' — ' + amt : '') + (emp ? ' · ' + emp : ''));
    incomeRows++;
  });
  if (!incomeRows) row('Income / Employment', '');
  gap();

  // ── 5. CO-APPLICANT ───────────────────────────────────────────────
  sectionHeader('Co-Applicant');
  row('Co-Applicant', hasCoApp ? 'Yes' : 'No');
  if (hasCoApp) {
    row('First Name',     fld('co_fn'));
    row('Last Name',      fld('co_ln'));
    row('Date of Birth',  fld('co_dob'));
    row('Band Number',    fld('co_band'));
    row('Reserve Status', fld('co_reserve'));
    row('Cell Phone',     fmtPhone(fld('co_cell')));
    row('Email',          fld('co_email'));
  }
  gap();

  // ── 6. HOUSEHOLD MEMBERS ──────────────────────────────────────────
  sectionHeader('Household Members');
  var habRows = 0;
  document.querySelectorAll('#habList .rrow').forEach(function(r, i){
    var txts = r.querySelectorAll('input[type="text"]');
    var dt   = r.querySelector('input[type="date"]');
    var sel  = r.querySelector('select');
    var nm   = [(txts[0] ? txts[0].value : ''), (txts[1] ? txts[1].value : '')]
                 .filter(Boolean).join(' ') || ('Member ' + (i + 1));
    row(nm, (sel ? sel.value : '') + (dt && dt.value ? ' · DOB: ' + dt.value : ''));
    habRows++;
  });
  if (!habRows) row('Household Members', '');
  gap();

  // ── 7. REFERENCES ─────────────────────────────────────────────────
  sectionHeader('References');
  var refRows = 0;
  document.querySelectorAll('#refList .rrow').forEach(function(r, i){
    var txts = r.querySelectorAll('input[type="text"]');
    var tels = r.querySelectorAll('input[type="tel"]');
    var ems  = r.querySelectorAll('input[type="email"]');
    var sel  = r.querySelector('select');
    var nm   = [(txts[0] ? txts[0].value : ''), (txts[1] ? txts[1].value : '')]
                 .filter(Boolean).join(' ') || ('Reference ' + (i + 1));
    row(nm, (sel ? sel.value : '')
          + (tels[0] && tels[0].value ? ' · ' + fmtPhone(tels[0].value) : '')
          + (ems[0]  && ems[0].value  ? ' · ' + ems[0].value : ''));
    refRows++;
  });
  if (!refRows) row('References', '');
  gap();

  // ── 8. PETS ───────────────────────────────────────────────────────
  var petRows = document.querySelectorAll('#petList .rrow');
  if (petRows.length) {
    sectionHeader('Pets');
    petRows.forEach(function(r, i){
      var txts = r.querySelectorAll('input[type="text"]');
      var sels = r.querySelectorAll('select');
      var ta   = r.querySelector('textarea');
      var nm   = txts[0] ? txts[0].value : ('Pet ' + (i + 1));
      row(nm, [(sels[0] ? sels[0].value : ''),
               (sels[1] ? sels[1].value : ''),
               (ta      ? ta.value      : '')].filter(Boolean).join(' · '));
    });
    gap();
  }

  // ── 9. SUPPORTING DOCUMENTS ───────────────────────────────────────
  sectionHeader('Supporting Documents Submitted');
  var docLabels = ['Government Issued Photo ID', 'Proof of Band Membership',
                   'Income / Employment Letter', 'Last 2 Pay Stubs',
                   'Utility Bills',              'Arrears Payment Agreement'];
  document.querySelectorAll('#step6 input[type="checkbox"]').forEach(function(cb, i){
    row(docLabels[i] || ('Doc ' + (i + 1)), cb.checked ? 'Included' : 'Not included');
  });
  gap();

  // ── TERMS & CONDITIONS ────────────────────────────────────────────
  needSpace(20);
  sectionHeader('Terms & Conditions — Applicant Declaration');

  var consented    = (document.getElementById('consent_share_programs') || {}).checked;
  var _tParsed     = _termsParseHtml(typeof getTermsBody === 'function' ? getTermsBody('housing_application') : '');
  var termsIntro   = _tParsed.intro || ('By signing below, I hereby apply for housing assistance from the '
    + (nation ? nation + ' ' : '') + (short ? '(' + short + ') ' : '')
    + 'Housing Program and declare the following:');
  var terms        = _tParsed.items.length ? _tParsed.items : [
    'All information provided in this application is true, accurate, and complete to the best of my knowledge.',
    'I understand that providing false or misleading information may result in immediate disqualification and removal from the housing waitlist.',
    'I consent to ' + short + ' collecting, using, and sharing my personal information for the purpose of assessing this application, in accordance with applicable privacy legislation (PIPEDA).',
    'I understand that my application will be scored according to the ' + short + ' Housing Scoring Rubric and that priority is determined by score, not date of application alone.',
    'I agree to notify the ' + short + ' Housing Department within 30 days of any change in household composition, income, address, or contact information.',
    'I understand that acceptance into ' + short + ' housing is conditional upon satisfying all outstanding arrears or entering into a formal payment arrangement approved by ' + short + ' prior to occupancy.',
    'I agree to comply with all ' + short + ' Housing policies, lease agreements, and community by-laws as a condition of tenancy.',
    'I authorize ' + short + ' to verify any information in this application with relevant third parties including employers, financial institutions, and utility providers.'
  ];

  paragraph(termsIntro);
  gap(1);

  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(9);
  pdf.setTextColor(40);
  terms.forEach(function(t, i) {
    var lines = pdf.splitTextToSize((i + 1) + '. ' + t, contentW - 4);
    needSpace(lines.length * 4 + 1.5);
    pdf.text(lines, marginL + 3, ctx.y + 3);
    ctx.y += lines.length * 4 + 1.5;
  });
  pdf.setTextColor(0);
  gap();

  // ── CONSENT CONFIRMED BOX (when ticked) ───────────────────────────
  if (consented) {
    var boxH = 26;
    needSpace(boxH + 2);
    pdf.setFillColor(240, 253, 244);
    pdf.setDrawColor(21, 128, 61);
    pdf.setLineWidth(0.5);
    pdf.rect(marginL, ctx.y, contentW, boxH, 'FD');
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(9);
    pdf.setTextColor(21, 128, 61);
    pdf.text('[X] Consent to Share — ' + (short || '') + ' Programs — CONFIRMED', marginL + 3, ctx.y + 5);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8.5);
    pdf.setTextColor(40);
    var cLines = pdf.splitTextToSize(
      'The applicant has consented to ' + short
      + ' Housing sharing relevant information from this application with other '
      + (nation || nationDisplay())
      + ' programs and departments — including Health, Education, Wellness, Ontario Works, and Finance — in support of this housing application.',
      contentW - 6
    );
    pdf.text(cLines, marginL + 3, ctx.y + 10);
    pdf.setFontSize(8);
    pdf.setTextColor(100);
    var capturedBy = (typeof HOUSING_SESSION !== 'undefined' && HOUSING_SESSION && HOUSING_SESSION.email)
      ? ' · Captured by ' + HOUSING_SESSION.email : '';
    pdf.text('Recorded: ' + today + capturedBy, marginL + 3, ctx.y + boxH - 2);
    pdf.setTextColor(0);
    pdf.setDrawColor(0);
    ctx.y += boxH + 4;
  }

  // ── SIGNATURES ────────────────────────────────────────────────────
  var sigBlockH = 34;
  needSpace(sigBlockH + 10);
  sectionHeader('Signatures');

  var sigCount  = hasCoApp ? 3 : 2;
  var sigGap    = 4;
  var sigW      = (contentW - (sigCount - 1) * sigGap) / sigCount;
  var sigAppImg = getSig('sig_canvas_app');
  var sigCoImg  = getSig('sig_canvas_co');
  var sigStaImg = getSig('sig_canvas_staff');
  var sigName   = fld('sig_name') || fullName;
  var sigDate   = fld('sig_date') || today;
  var coFn      = fld('co_fn');
  var coLn      = fld('co_ln');
  var coSigName = fld('sig_co_name') || ((coFn + ' ' + coLn).trim() || '—');
  var staffName = fld('sig_staff') || '—';
  var staffDate = fld('sig_recv')  || today;

  function drawSig(x, label, name, date, imgUrl) {
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(8);
    pdf.setTextColor(100);
    pdf.text(String(label).toUpperCase(), x, ctx.y + 3);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8.5);
    pdf.setTextColor(20);
    pdf.text('Name: ' + (name || '—'), x, ctx.y + 8);
    pdf.text('Date: ' + (date || '—'), x, ctx.y + 12);
    pdf.setDrawColor(180);
    pdf.setLineWidth(0.2);
    pdf.rect(x, ctx.y + 14, sigW, sigBlockH - 14);
    if (imgUrl) {
      try { pdf.addImage(imgUrl, 'PNG', x + 1, ctx.y + 15, sigW - 2, sigBlockH - 16); }
      catch (e) { /* ignore unreadable canvas */ }
    } else {
      pdf.setFontSize(7);
      pdf.setTextColor(180);
      pdf.text('(unsigned)', x + sigW / 2, ctx.y + sigBlockH - 3, { align: 'center' });
    }
    pdf.setDrawColor(0);
    pdf.setTextColor(0);
  }

  var sigX = marginL;
  drawSig(sigX, 'Applicant', sigName, sigDate, sigAppImg);
  sigX += sigW + sigGap;
  if (hasCoApp) {
    drawSig(sigX, 'Co-Applicant', coSigName, sigDate, sigCoImg);
    sigX += sigW + sigGap;
  }
  drawSig(sigX, 'Received by — Housing Staff', staffName, staffDate, sigStaImg);
  ctx.y += sigBlockH + 4;

  return ctx.finish();
}

// ── SOW PDF generator ─────────────────────────────────────────────────────
// Mirrors _generateApplicationPdfBase64 but emits a Scope of Work doc. Reads
// from the live SOW modal form fields (the modal is still open at notify
// time, same as the application-confirmation flow). Selectable text, sharp
// at any zoom; tenant + staff signatures embedded as PNG images.
async function _generateSowPdfBase64() {
  await _loadJsPdf();
  var ctx         = _makePdfDoc();
  var pdf         = ctx.pdf, pageW = ctx.pageW, pageH = ctx.pageH;
  var marginL     = ctx.marginL, marginR = ctx.marginR, marginT = ctx.marginT;
  var contentW    = ctx.contentW;
  var needSpace   = ctx.needSpace.bind(ctx);
  var sectionHeader = ctx.sectionHeader.bind(ctx);
  var row         = ctx.row.bind(ctx);
  var paragraph   = ctx.paragraph.bind(ctx);
  var gap         = ctx.gap.bind(ctx);

  function fld(id) {
    var e = document.getElementById(id);
    return (e && e.value && String(e.value).trim()) ? String(e.value).trim() : '';
  }
  function chk(id) {
    var e = document.getElementById(id); return e ? !!e.checked : false;
  }
  function fmtCur(v) {
    if (v == null || v === '') return '';
    if (typeof formatCurrency === 'function') {
      var n = parseFloat(String(v).replace(/[^0-9.\-]/g,'')) || 0;
      return formatCurrency(n);
    }
    return String(v);
  }
  function getSig(canvasId) {
    if (typeof getSigDataURL === 'function') {
      try { return getSigDataURL(canvasId); } catch (e) { return ''; }
    }
    var c = document.getElementById(canvasId);
    try { return c ? c.toDataURL('image/png') : ''; } catch (e) { return ''; }
  }

  var today    = new Date().toLocaleDateString('en-CA');
  var nation   = (window.NATION_CONFIG && (NATION_CONFIG.display_name || NATION_CONFIG.name)) || '';
  var short    = nationShort();
  var projNum  = (window._sowEditingProjectNumber) || '—';
  var unitAddr = fld('sow_address') || '—';

  // Header
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(15);
  pdf.text((short ? short + ' ' : '') + 'Maintenance Request', marginL, ctx.y + 5);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(9);
  pdf.setTextColor(110);
  if (nation) pdf.text(nation + ' — Housing Department', marginL, ctx.y + 10);

  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(11);
  pdf.setTextColor(20);
  pdf.text(unitAddr,           pageW - marginR, ctx.y + 5,  { align: 'right' });
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(9);
  pdf.setTextColor(110);
  pdf.text(projNum,            pageW - marginR, ctx.y + 10, { align: 'right' });
  pdf.text('Date: ' + today,   pageW - marginR, ctx.y + 15, { align: 'right' });
  ctx.y += 17;
  pdf.setDrawColor(window._themeAccentHex());
  pdf.setLineWidth(1);
  pdf.line(marginL, ctx.y, pageW - marginR, ctx.y);
  pdf.setDrawColor(0);
  pdf.setTextColor(0);
  ctx.y += 6;

  // Unit Information
  sectionHeader('Unit Information');
  row('Unit Address',     unitAddr);
  row('Current Tenant',   fld('sow_tenant_name'));
  row('Project Number',   projNum);
  row('Date Prepared',    fld('sow_date'));
  row('Prepared By',      fld('sow_prepared_by'));
  row('Contractor',       fld('sow_contractor'));
  gap();

  // Condition & Schedule
  sectionHeader('Condition Assessment & Schedule');
  row('Overall Condition',     fld('sow_condition'));
  row('Estimated Total Cost',  fmtCur(fld('sow_total_cost')) || '—');
  row('Target Start Date',     fld('sow_start_date'));
  row('Target Completion',     fld('sow_end_date'));
  gap();

  // Work items — table-style rows using the row() helper.
  sectionHeader('Work Items');
  var items = (typeof collectSowItems === 'function') ? collectSowItems() : [];
  var filtered = items.filter(function(it){ return it.category || it.description || it.cost; });
  if (filtered.length) {
    filtered.forEach(function(it){
      var cost = it.cost ? fmtCur(it.cost) : '—';
      row((it.category || '—'),
          (it.description || '—') + '  ·  ' + cost);
    });
  } else {
    row('Scope Items', 'No line items added.');
  }
  gap();

  // Health & Safety hazards
  var hazards = [
    {id:'sow_mold',       label:'Mould / Mildew'},
    {id:'sow_asbestos',   label:'Asbestos Risk'},
    {id:'sow_electrical', label:'Electrical Hazard'},
    {id:'sow_structural', label:'Structural Concern'},
    {id:'sow_plumbing',   label:'Plumbing / Sewage'},
    {id:'sow_fire',       label:'Fire Safety'}
  ].filter(function(h){ return chk(h.id); }).map(function(h){ return h.label; });
  if (hazards.length) {
    sectionHeader('Health & Safety Concerns');
    paragraph(hazards.join(' · '));
    gap();
  }

  // Notes
  var sowNotes = fld('sow_notes');
  if (sowNotes) {
    sectionHeader('Additional Notes');
    paragraph(sowNotes);
    gap();
  }

  // Tenant Accountability
  var acctFlags = [];
  if (chk('sow_rent_arrears'))  acctFlags.push('Rent arrears');
  if (chk('sow_tenant_damage')) acctFlags.push('Tenant damage');
  if (chk('sow_negligence'))    acctFlags.push('Negligence');
  if (chk('sow_vandalism'))     acctFlags.push('Vandalism');
  if (chk('sow_police_report')) acctFlags.push('Police report on file');
  var acctNotes = fld('sow_accountability_notes');
  if (acctFlags.length || acctNotes) {
    sectionHeader('Tenant Accountability');
    if (acctFlags.length) paragraph(acctFlags.join(' · '));
    if (acctNotes)        paragraph(acctNotes);
    gap();
  }

  // Terms & Conditions — Renovation Request
  var _sowTP = _termsParseHtml(typeof getTermsBody === 'function' ? getTermsBody('sow_reno_request') : '');
  if (_sowTP.items.length) {
    sectionHeader('Terms & Conditions — Renovation Request');
    if (_sowTP.intro) { paragraph(_sowTP.intro); gap(1); }
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(9);
    pdf.setTextColor(40);
    _sowTP.items.forEach(function(t, i) {
      var lines = pdf.splitTextToSize((i + 1) + '. ' + t, contentW - 4);
      needSpace(lines.length * 4 + 1.5);
      pdf.text(lines, marginL + 3, ctx.y + 3);
      ctx.y += lines.length * 4 + 1.5;
    });
    pdf.setTextColor(0);
    gap();
  }

  // Signatures — omitted when Settings -> Contracts hides signature sections.
  if (!_docSigsHidden()) {
  sectionHeader('Signatures');
  var tenantSig    = getSig('sow_sig_canvas_tenant');
  var staffSig     = getSig('sow_sig_canvas_staff');
  var tenantName   = fld('sow_sig_tenant_name') || fld('sow_tenant_name') || '—';
  var tenantDate   = fld('sow_sig_tenant_date') || '—';
  var staffName    = fld('sow_sig_staff_name')  || fld('sow_prepared_by') || '—';
  var staffDate    = fld('sow_sig_staff_date')  || today;

  var sigBlockH = 26;
  var sigGap    = 6;
  var sigW      = (contentW - sigGap) / 2;
  needSpace(sigBlockH + 6);

  function drawSig(x, title, name, date, imgUrl) {
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(9);
    pdf.setTextColor(60);
    pdf.text(title, x, ctx.y + 4);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8);
    pdf.setTextColor(110);
    pdf.text((name || '—') + '  ·  ' + (date || '—'), x, ctx.y + 9);
    pdf.setDrawColor(200);
    pdf.setLineWidth(0.2);
    pdf.rect(x, ctx.y + 11, sigW, sigBlockH - 11);
    if (imgUrl) {
      try { pdf.addImage(imgUrl, 'PNG', x + 1, ctx.y + 12, sigW - 2, sigBlockH - 13); }
      catch (e) { /* ignore unreadable canvas */ }
    } else {
      pdf.setFontSize(7);
      pdf.setTextColor(180);
      pdf.text('(unsigned)', x + sigW / 2, ctx.y + sigBlockH - 3, { align: 'center' });
    }
    pdf.setDrawColor(0);
    pdf.setTextColor(0);
  }
  drawSig(marginL,                'Tenant Signature',        tenantName, tenantDate, tenantSig);
  drawSig(marginL + sigW + sigGap,'Housing Staff Signature', staffName,  staffDate,  staffSig);
  ctx.y += sigBlockH + 4;
  }

  return ctx.finish();
}

// Resolve the tenant's email from the tenants table by looking up the
// unit's assigned_name. Returns '' on any error / no match. The tenants
// table is the source of truth (TIC reads from it) and unit.assignedName
// is trigger-synced from housing_units.assigned_name — same join that
// the TIC's _ticResolveTenant uses, just slimmed down for one column.
// Resolve the tenant's on-file contact info (email + phone) for a unit,
// mirroring the TIC's tenant resolution: exclude merged-away duplicate rows
// (merged_into=is.null) and pick the first row that actually has a value.
// Returns { email, phone } (either may be '').
async function _resolveTenantContactForUnit(unit) {
  var out = { email: '', phone: '' };
  if (!unit || !unit.assignedName) return out;
  if (typeof SUPABASE_URL === 'undefined' || typeof HOUSING_HEADERS === 'undefined') return out;
  try {
    var url = SUPABASE_URL
            + '/rest/v1/tenants?select=email,phone,merged_into&full_name=eq.'
            + encodeURIComponent(unit.assignedName)
            + '&merged_into=is.null';
    var r = await fetch(url, { headers: HOUSING_HEADERS });
    if (!r.ok) {
      console.warn('[notify] tenant contact lookup HTTP ' + r.status);
      return out;
    }
    var rows = await r.json();
    if (!Array.isArray(rows)) return out;
    var em = rows.find(function(t){ return t && t.email && String(t.email).trim(); });
    var ph = rows.find(function(t){ return t && t.phone && String(t.phone).trim(); });
    out.email = em ? String(em.email).trim() : '';
    out.phone = ph ? String(ph.phone).trim() : '';
    return out;
  } catch (e) {
    console.warn('[notify] tenant contact lookup error:', e);
    return out;
  }
}
window._resolveTenantContactForUnit = _resolveTenantContactForUnit;

async function _resolveTenantEmailForUnit(unit) {
  var c = await _resolveTenantContactForUnit(unit);
  return c.email;
}
async function _resolveTenantPhoneForUnit(unit) {
  var c = await _resolveTenantContactForUnit(unit);
  return c.phone;
}
window._resolveTenantPhoneForUnit = _resolveTenantPhoneForUnit;

// Wired from saveSOW() in housing-modals-sow.js when the preparer ticks
// the inline "Email a copy to the tenant" checkbox on the submit
// confirmation. Sends the SOW PDF to the tenant's email + any active
// staff in CC roles configured on the Settings -> Notifications tab.
// Silent skip when there's no tenant email AND no CC roles configured.
async function notifySowTenantCopy(sow, unit) {
  if (!sow) return;
  var eventKey = 'sow_tenant_copy';

  var seen   = {};
  var emails = [];
  function _addEmail(addr) {
    if (!addr) return;
    var clean = String(addr).trim().toLowerCase();
    if (!clean || seen[clean]) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) return;
    seen[clean] = true;
    emails.push(clean);
  }

  // Tenant email — silent skip if nothing on file.
  var tenantEmail = await _resolveTenantEmailForUnit(unit);
  _addEmail(tenantEmail);

  // Additional staff recipients: primary + CC role checkboxes from the
  // Settings -> Notifications tab. Both default to empty for this event.
  var extraRoles = _emailEventRecipientRoles(eventKey).concat(_emailEventCcRoles(eventKey));
  if (extraRoles.length) {
    var extraRecipients = await _resolveActiveStaffForRoles(extraRoles);
    extraRecipients.forEach(function(r){ _addEmail(r.email); });
  }

  if (!emails.length) {
    console.log('[notify] sow_tenant_copy skipped - no tenant email or CC recipients for SOW ' + (sow.project_number || '—'));
    return;
  }

  var tenantName = (sow.tenantName) || (unit && unit.assignedName) || '';
  var rendered = _renderEmailTemplate(eventKey, _emailTokensForSowTenant(sow, unit, tenantName));
  if (!rendered) return;

  // Generate the SOW PDF. Best-effort — never block delivery on PDF.
  var pdfBase64 = null;
  try {
    pdfBase64 = await _generateSowPdfBase64();
  } catch (e) {
    console.warn('[notify] SOW PDF generation failed, sending without attachment:', e);
  }

  var attachments;
  var bodyHtml = rendered.bodyHtml;
  if (pdfBase64) {
    attachments = [{
      name:         'Maintenance Request ' + (sow.project_number || 'scope') + '.pdf',
      contentType:  'application/pdf',
      contentBytes: pdfBase64
    }];
  } else {
    bodyHtml += '<p style="color:#888;font-size:12px;font-style:italic;">'
              + '(PDF copy could not be generated automatically. Reply to this email to request one.)'
              + '</p>';
  }

  await _sendSerially(emails.map(function(e){ return { email: e }; }), function(rcp){
    return {
      to:          rcp.email,
      to_name:     '',
      subject:     rendered.subject,
      bodyHtml:    bodyHtml,
      attachments: attachments,
      event:       eventKey,
      entity_type: 'sow',
      entity_id:   sow.project_number || '—'
    };
  }, eventKey);
}

// ── RFQ PDF generator ────────────────────────────────────────────────────
// Generates the Request for Quotations document as a PDF base64 string.
// Called by sendRfqToRecipients so it is auto-attached to every contractor
// email. Mirrors the buildRfqDocumentHtml sections: Project Details, Scope,
// Bid Form, Mandatory Inclusions, Submission Instructions, T&C, Authorization.
async function _generateRfqPdfBase64(rfq, unit) {
  await _loadJsPdf();
  var logoDataUrl = await _fetchLogoForPdf();
  var nc       = window.NATION_CONFIG || {};
  var natShort = nationShort();
  var natDisp  = nc.display_name || nc.name || natShort;
  var ctx = _makePdfDoc({
    headerTitle:    'Request for Quotations',
    headerSubtitle: rfq.id || '',
    logoDataUrl:    logoDataUrl || null
  });
  var pdf = ctx.pdf, marginL = ctx.marginL, marginR = ctx.marginR, contentW = ctx.contentW;
  var sectionHeader = ctx.sectionHeader.bind(ctx);
  var row           = ctx.row.bind(ctx);
  var paragraph     = ctx.paragraph.bind(ctx);
  var gap           = ctx.gap.bind(ctx);

  var addr         = unit ? ((unit.num || '') + ' ' + (unit.street || '')).trim() : (rfq.sow_unit_id || '--');
  var d            = rfq.data || {};
  var closing      = rfq.closes_at ? new Date(rfq.closes_at).toLocaleString('en-CA', { dateStyle: 'long', timeStyle: 'short' }) : '--';
  var contact      = d.contact_person || '';
  var contactEmail = d.contact_email  || '';
  var subMethod    = d.submission_method || 'email';
  var officePhone  = nc.phone || '705-463-4511';
  var today        = new Date().toLocaleDateString('en-CA');
  var issueDate    = d.issue_date || today;
  var isBldgUnit   = unit && ['admin_building','band_building','commercial_building'].indexOf(unit.type || '') >= 0;
  var buildingName = (isBldgUnit && unit && unit.buildingName) ? unit.buildingName : '';
  var startDate    = d.target_start_date       ? new Date(d.target_start_date + 'T12:00:00').toLocaleDateString('en-CA', {year:'numeric',month:'long',day:'numeric'}) : '--';
  var endDate      = d.target_completion_date  ? new Date(d.target_completion_date + 'T12:00:00').toLocaleDateString('en-CA', {year:'numeric',month:'long',day:'numeric'}) : '--';
  var items        = (d.scope_snapshot || []).filter(function(it){ return it && !it._hidden && (it.category || it.description); });

  // ── 1. Project Details ───────────────────────────────────────────────────
  sectionHeader(_rfqDocStr('h_project'));
  row('RFQ Number',             rfq.id || '--');
  if (buildingName)             row('Building Name',           buildingName);
  row('Project Address',        addr);
  row('Maintenance Request Reference', rfq.sow_project_number || '--');
  row('Issue Date',             issueDate);
  row('Bid Closing Date & Time', closing);
  row('Target Start Date',      startDate);
  row('Target Completion Date', endDate);
  row((natShort || 'Nation') + ' Contact', contact + (contactEmail ? '  <' + contactEmail + '>' : ''));
  gap(4);

  // ── 2. Scope of Work ─────────────────────────────────────────────────────
  if (items.length) {
    sectionHeader('Maintenance Request');
    var colW = [contentW * 0.32, contentW * 0.68];
    ctx.needSpace(8);
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(8); pdf.setTextColor(80);
    pdf.text('Category',    marginL,           ctx.y + 3);
    pdf.text('Description of Work Required', marginL + colW[0], ctx.y + 3);
    ctx.y += 5;
    pdf.setDrawColor(200); pdf.line(marginL, ctx.y, marginL + contentW, ctx.y); ctx.y += 3;
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9); pdf.setTextColor(20);
    items.forEach(function(it) {
      var catLines  = pdf.splitTextToSize(it.category || '--',    colW[0] - 3);
      var descLines = pdf.splitTextToSize(it.description || '--', colW[1] - 3);
      var lines = Math.max(catLines.length, descLines.length);
      var rowH  = lines * 4 + 1;
      ctx.needSpace(rowH + 1.5);
      pdf.text(catLines,  marginL,           ctx.y + 3);
      pdf.text(descLines, marginL + colW[0], ctx.y + 3);
      ctx.y += rowH;
      pdf.setDrawColor(230); pdf.line(marginL, ctx.y, marginL + contentW, ctx.y); ctx.y += 1.5;
    });
    gap(4);
  }

  // ── 2b. Notes & access requirements from the initiating request ───────────
  var _rfqSowNotes = String(d.sow_notes || '').trim();
  if (!_rfqSowNotes && rfq.sow_unit_id && window._sowCache) {
    // Fallback for RFQs saved before the notes snapshot existed.
    var _sce = window._sowCache[rfq.sow_unit_id];
    var _sarr = _sce && Array.isArray(_sce.sows) ? _sce.sows : [];
    var _ssow = _sarr.find(function(s){ return s && s.project_number === rfq.sow_project_number; }) || _sarr[0];
    if (_ssow && _ssow.notes) _rfqSowNotes = String(_ssow.notes).trim();
  }
  if (_rfqSowNotes) {
    sectionHeader('Additional Notes & Access Requirements');
    paragraph(_rfqSowNotes, 9);
    gap(4);
  }

  // ── 3. Contractor Bid Form ────────────────────────────────────────────────
  if (items.length) {
    sectionHeader(_rfqDocStr('h_bidform'));
    paragraph(_rfqDocStr('bidform_intro'), 8.5);
    gap(3);

    var c1 = contentW * 0.50, c2 = contentW * 0.17, c3 = contentW * 0.17, c4 = contentW * 0.16;
    var tX = marginL, hH = 7;
    ctx.needSpace(hH + 2);

    // Header row (yellow fill)
    pdf.setFillColor(window._themeAccentHex());
    pdf.rect(tX, ctx.y, contentW, hH, 'F');
    pdf.setDrawColor(160); pdf.setLineWidth(0.3);
    pdf.rect(tX, ctx.y, contentW, hH);
    [c1, c1+c2, c1+c2+c3].forEach(function(x){ pdf.line(tX+x, ctx.y, tX+x, ctx.y+hH); });
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(7.5); pdf.setTextColor(30);
    pdf.text(_rfqDocStr('col_lineitem'),  tX + 2,         ctx.y + 4.5);
    pdf.text(_rfqDocStr('col_unitprice'), tX + c1 + 2,    ctx.y + 4.5);
    pdf.text(_rfqDocStr('col_extended'),  tX + c1+c2 + 2, ctx.y + 4.5);
    pdf.text(_rfqDocStr('col_notes'),     tX + c1+c2+c3+2, ctx.y + 4.5);
    ctx.y += hH;

    // One row per scope item
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8.5); pdf.setTextColor(30);
    items.forEach(function(it) {
      var txt   = it.description || it.category || '--';
      var lines = pdf.splitTextToSize(txt, c1 - 4);
      var rH    = Math.max(lines.length * 4 + 4, 10);
      ctx.needSpace(rH + 1);
      pdf.setDrawColor(200); pdf.setLineWidth(0.2);
      pdf.rect(tX, ctx.y, contentW, rH);
      [c1, c1+c2, c1+c2+c3].forEach(function(x){ pdf.line(tX+x, ctx.y, tX+x, ctx.y+rH); });
      pdf.text(lines, tX + 2, ctx.y + 4);
      ctx.y += rH;
    });

    // Total row
    ctx.needSpace(9);
    pdf.setFillColor(window._themeAccentHex());
    pdf.rect(tX, ctx.y, contentW, 9, 'F');
    pdf.setDrawColor(160); pdf.setLineWidth(0.3);
    pdf.rect(tX, ctx.y, contentW, 9);
    [c1, c1+c2, c1+c2+c3].forEach(function(x){ pdf.line(tX+x, ctx.y, tX+x, ctx.y+9); });
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(8.5); pdf.setTextColor(20);
    pdf.text(_rfqDocStr('total_bid_amount'), tX + c1 - 2, ctx.y + 5.5, { align: 'right' });
    ctx.y += 9;

    // Bid Cost Breakdown — blank table for the contractor to break their total
    // bid out by category (mirrors the RFQ Contracting-tab Price Breakdown).
    gap(4);
    ctx.needSpace(12);
    paragraph(_rfqDocStr('h_breakdown') + ' - ' + _rfqDocStr('breakdown_intro'), 8.5);
    gap(1);
    var bc1 = contentW * 0.68, bH = 7;
    ctx.needSpace(bH + 2);
    pdf.setFillColor(window._themeAccentHex()); pdf.rect(tX, ctx.y, contentW, bH, 'F');
    pdf.setDrawColor(160); pdf.setLineWidth(0.3); pdf.rect(tX, ctx.y, contentW, bH);
    pdf.line(tX + bc1, ctx.y, tX + bc1, ctx.y + bH);
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(7.5); pdf.setTextColor(30);
    pdf.text(_rfqDocStr('breakdown_col_cat'), tX + 2, ctx.y + 4.5);
    pdf.text(_rfqDocStr('breakdown_col_amt'), tX + bc1 + 2, ctx.y + 4.5);
    ctx.y += bH;
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8.5); pdf.setTextColor(30);
    _rfqDocList('breakdown_categories').forEach(function(cat){
      ctx.needSpace(10);
      pdf.setDrawColor(200); pdf.setLineWidth(0.2); pdf.rect(tX, ctx.y, contentW, 9);
      pdf.line(tX + bc1, ctx.y, tX + bc1, ctx.y + 9);
      pdf.text(cat, tX + 2, ctx.y + 5.5);
      ctx.y += 9;
    });
    ctx.needSpace(9);
    pdf.setFillColor(window._themeAccentHex()); pdf.rect(tX, ctx.y, contentW, 9, 'F');
    pdf.setDrawColor(160); pdf.setLineWidth(0.3); pdf.rect(tX, ctx.y, contentW, 9);
    pdf.line(tX + bc1, ctx.y, tX + bc1, ctx.y + 9);
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(8.5); pdf.setTextColor(20);
    pdf.text(_rfqDocStr('breakdown_total'), tX + bc1 - 2, ctx.y + 5.5, { align: 'right' });
    ctx.y += 9;
    gap(2);
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8.5); pdf.setTextColor(30);
    pdf.text(_rfqDocStr('labour_hours_label') + ' __________ hrs', tX + 2, ctx.y + 4);
    ctx.y += 6;
    gap(4);
  }

  // ── 4. Mandatory Inclusions ───────────────────────────────────────────────
  sectionHeader(_rfqDocStr('h_mandatory'));
  paragraph(_rfqDocStr('mandatory_intro'), 8.5);
  gap(3);
  var checkList = _rfqDocList('mandatory_items').map(function(s){ return _rfqDocSub(s); });
  pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9); pdf.setTextColor(40);
  checkList.forEach(function(item) {
    var lines = pdf.splitTextToSize(item, contentW - 9);
    var rH = lines.length * 4 + 4;
    ctx.needSpace(rH);
    pdf.setDrawColor(80); pdf.setLineWidth(0.4);
    pdf.rect(marginL, ctx.y + 0.5, 3.5, 3.5);
    pdf.text(lines, marginL + 7, ctx.y + 3.5);
    ctx.y += rH;
  });
  gap(4);

  // ── 5. Submission Instructions ────────────────────────────────────────────
  sectionHeader(_rfqDocStr('h_submission'));
  var subInstr = subMethod === 'email'
    ? 'Email your complete bid package to: ' + (contactEmail || contact)
    : subMethod === 'office'
    ? 'Deliver your complete bid package to the ' + (natShort || 'Housing') + ' Department office.'
    : 'Submit by email to ' + (contactEmail || contact) + ' OR deliver to the ' + (natShort || 'Housing') + ' Department office.';
  paragraph(subInstr);
  paragraph('Bids must be received by: ' + closing + '. Late submissions will not be accepted under any circumstances.');
  gap(2);
  if (contact) row('Contact', contact + (contactEmail ? '  |  ' + contactEmail : ''));
  row('Office Phone', officePhone);
  gap(4);

  // ── 6. Terms & Conditions (if saved in settings) ──────────────────────────
  var rawTerms = window._appSettings && window._appSettings.rfq_terms;
  if (rawTerms) {
    var termsStr = typeof rawTerms === 'string' ? rawTerms : (rawTerms.bodyHtml || '');
    var plainTerms = termsStr.replace(/<li[^>]*>/gi, '• ').replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();
    if (plainTerms) { sectionHeader('Terms & Conditions'); paragraph(plainTerms, 8); gap(4); }
  }

  // ── 7. Authorization (signature) — omitted when signatures are hidden ──────
  if (!_docSigsHidden()) {
  sectionHeader('Authorization');
  gap(2);
  var sigData  = d.sig_data  || '';
  var sigName  = d.sig_name  || '';
  var sigTitle = d.sig_title || '';

  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(8); pdf.setTextColor(100);
  pdf.text('ISSUED BY', marginL, ctx.y); ctx.y += 5;

  if (sigData && sigData.indexOf('data:image/png;base64,') === 0) {
    ctx.needSpace(20);
    try { pdf.addImage(sigData, 'PNG', marginL, ctx.y, 55, 15); ctx.y += 17; } catch(e) { ctx.y += 14; }
  } else if (sigData && sigData.indexOf('typed:') === 0) {
    ctx.needSpace(12);
    pdf.setFont('helvetica', 'italic'); pdf.setFontSize(14); pdf.setTextColor(20);
    pdf.text(sigData.replace('typed:', ''), marginL, ctx.y + 7); ctx.y += 12;
  } else {
    ctx.needSpace(16);
    pdf.setDrawColor(80); pdf.setLineWidth(0.5);
    pdf.line(marginL, ctx.y + 12, marginL + contentW * 0.45, ctx.y + 12); ctx.y += 14;
  }

  pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8.5); pdf.setTextColor(60);
  pdf.text('Date: ' + issueDate, marginL, ctx.y); ctx.y += 5;
  pdf.text('Print name: ' + (sigName  || '___________________________'), marginL, ctx.y); ctx.y += 5;
  pdf.text('Title: '      + (sigTitle || '___________________________'), marginL, ctx.y); ctx.y += 6;

  gap(3);
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(8); pdf.setTextColor(100);
  pdf.text('ON BEHALF OF', marginL, ctx.y); ctx.y += 5;
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(11); pdf.setTextColor(20);
  pdf.text(natDisp, marginL, ctx.y); ctx.y += 5;
  pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9); pdf.setTextColor(80);
  pdf.text('Housing Department', marginL, ctx.y);
  }

  return ctx.finish();
}

// ── Work Order PDF generator ──────────────────────────────────────────────
// Mirrors printWorkOrder's structure (contractor-facing variant of the SOW
// PDF). Reads from the live SOW modal form fields. Different from the SOW
// PDF: surfaces line-item quoted prices (not estimates), includes the
// Work Authorization notice, and has signature lines for both the
// contractor representative and the authorized housing signatory.
async function _generateWorkOrderPdfBase64() {
  await _loadJsPdf();
  var ctx         = _makePdfDoc();
  var pdf         = ctx.pdf, pageW = ctx.pageW, pageH = ctx.pageH;
  var marginL     = ctx.marginL, marginR = ctx.marginR, marginT = ctx.marginT;
  var contentW    = ctx.contentW;
  var needSpace   = ctx.needSpace.bind(ctx);
  var sectionHeader = ctx.sectionHeader.bind(ctx);
  var row         = ctx.row.bind(ctx);
  var paragraph   = ctx.paragraph.bind(ctx);
  var gap         = ctx.gap.bind(ctx);

  function fld(id) {
    var e = document.getElementById(id);
    return (e && e.value && String(e.value).trim()) ? String(e.value).trim() : '';
  }
  function fmtCur(v) {
    if (v == null || v === '') return '';
    if (typeof formatCurrency === 'function') {
      var n = parseFloat(String(v).replace(/[^0-9.\-]/g,'')) || 0;
      return formatCurrency(n);
    }
    return String(v);
  }

  var today    = new Date().toLocaleDateString('en-CA');
  var nation   = (window.NATION_CONFIG && (NATION_CONFIG.display_name || NATION_CONFIG.name)) || '';
  var short    = nationShort();
  var projNum  = (window._sowEditingProjectNumber) || '—';
  var unitAddr = fld('sow_address') || '—';

  // Header
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(15);
  pdf.text((short ? short + ' ' : '') + 'Work Order', marginL, ctx.y + 5);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(9);
  pdf.setTextColor(110);
  if (nation) pdf.text(nation + ' — Housing Department', marginL, ctx.y + 10);

  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(11);
  pdf.setTextColor(20);
  pdf.text(unitAddr,           pageW - marginR, ctx.y + 5,  { align: 'right' });
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(9);
  pdf.setTextColor(110);
  pdf.text(projNum,            pageW - marginR, ctx.y + 10, { align: 'right' });
  pdf.text('Date: ' + today,   pageW - marginR, ctx.y + 15, { align: 'right' });
  ctx.y += 17;
  pdf.setDrawColor(window._themeAccentHex());
  pdf.setLineWidth(1);
  pdf.line(marginL, ctx.y, pageW - marginR, ctx.y);
  pdf.setDrawColor(0);
  pdf.setTextColor(0);
  ctx.y += 6;

  // In-house crew work orders print as a field checklist (no pricing, no terms);
  // contractor work orders keep quoted prices + a work-authorization notice.
  // Team is read from the (still-mounted) modal field.
  var _teamEl = document.getElementById('sow_assigned_team');
  var inHouse = !!(_teamEl && _teamEl.value === 'in_house');
  function _woAssigneeName() {
    var s = document.getElementById('sow_assigned_to');
    if (!s) return '';
    var o = s.options[s.selectedIndex];
    return (o && o.getAttribute('data-name')) || '';
  }

  // Project Information
  sectionHeader('Project Information');
  row('Unit Address',     unitAddr);
  row('Tenant',           fld('sow_tenant_name'));
  row('Tenant Phone',     fld('sow_tenant_phone'));
  if (inHouse) row('Assigned To', _woAssigneeName() || fld('sow_contractor'));
  else         row('Contractor',  fld('sow_contractor'));
  row('Issued By',        fld('sow_prepared_by'));
  row('Start Date',       fld('sow_start_date'));
  row('Completion Date',  fld('sow_end_date'));
  row('Project Number',   projNum);
  gap();

  if (inHouse) {
    // ── In-house crew checklist (printable field form) ─────────────────────
    // Small drawing helpers scoped to this branch so they can't collide with
    // the contractor path's own signature box below.
    var woCheckbox = function(label, done) {
      var lines = pdf.splitTextToSize(String(label), contentW - 8);
      needSpace(Math.max(lines.length * 4, 5) + 2);
      pdf.setDrawColor(120); pdf.setLineWidth(0.3);
      pdf.rect(marginL, ctx.y, 4, 4);
      if (done) {
        // Draw an X to mark the item complete.
        pdf.setLineWidth(0.5);
        pdf.line(marginL + 0.7, ctx.y + 0.7, marginL + 3.3, ctx.y + 3.3);
        pdf.line(marginL + 3.3, ctx.y + 0.7, marginL + 0.7, ctx.y + 3.3);
      }
      pdf.setDrawColor(0);
      pdf.setFont('helvetica', done ? 'bold' : 'normal'); pdf.setFontSize(9); pdf.setTextColor(20);
      pdf.text(lines, marginL + 6, ctx.y + 3.2);
      pdf.setFont('helvetica', 'normal');
      ctx.y += Math.max(lines.length * 4, 5) + 2;
      pdf.setTextColor(0);
    };
    // options: array of { label, checked } — draws a box per option, X'd when checked.
    var woInlineChecks = function(label, options) {
      needSpace(7);
      pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9); pdf.setTextColor(20);
      pdf.text(String(label), marginL, ctx.y + 3.2);
      var x = marginL + 72;
      options.forEach(function(op) {
        pdf.setDrawColor(120); pdf.setLineWidth(0.3);
        pdf.rect(x, ctx.y, 4, 4);
        if (op.checked) {
          pdf.setLineWidth(0.5);
          pdf.line(x + 0.7, ctx.y + 0.7, x + 3.3, ctx.y + 3.3);
          pdf.line(x + 3.3, ctx.y + 0.7, x + 0.7, ctx.y + 3.3);
        }
        pdf.setDrawColor(0);
        pdf.text(op.label, x + 6, ctx.y + 3.2);
        x += 6 + pdf.getTextWidth(op.label) + 9;
      });
      ctx.y += 7;
      pdf.setTextColor(0);
    };
    var woBlankLines = function(n) {
      n = n || 3;
      for (var i = 0; i < n; i++) {
        needSpace(7);
        pdf.setDrawColor(205); pdf.setLineWidth(0.2);
        pdf.line(marginL, ctx.y + 5, pageW - marginR, ctx.y + 5);
        pdf.setDrawColor(0);
        ctx.y += 7;
      }
    };
    var woSigBox = function(x, sigW, role) {
      pdf.setFont('helvetica', 'bold'); pdf.setFontSize(9); pdf.setTextColor(60);
      pdf.text(role, x, ctx.y + 4);
      pdf.setDrawColor(160); pdf.setLineWidth(0.3);
      pdf.line(x, ctx.y + 16, x + sigW, ctx.y + 16);
      pdf.setFont('helvetica', 'normal'); pdf.setFontSize(7); pdf.setTextColor(120);
      pdf.text('Signature', x, ctx.y + 20);
      pdf.text('Date: ____________', x + sigW, ctx.y + 20, { align: 'right' });
      pdf.text('Print name: ____________________________', x, ctx.y + 25);
      pdf.setDrawColor(0); pdf.setTextColor(0);
    };

    // Captured Work Order (execution) data — filled in the app on the Work
    // Order tab by field OR office staff. Falls back to a blank fill-in form
    // when nothing has been entered yet.
    var wo = (typeof _sowCollectWorkOrder === 'function') ? _sowCollectWorkOrder() : {};
    wo = wo || {};
    var woDone = wo.itemsDone || {};

    sectionHeader('Work Checklist');
    paragraph('Items checked are complete; unchecked remain outstanding.', 8);
    var woItems = (typeof collectSowItems === 'function') ? collectSowItems() : [];
    var woFiltered = woItems.filter(function(it){ return it.category || it.description; });
    if (woFiltered.length) {
      woFiltered.forEach(function(it, i){
        woCheckbox((it.category ? it.category + ' - ' : '') + (it.description || 'Item'), !!woDone[i]);
      });
    } else {
      woCheckbox('(No line items listed - describe the work in Notes below.)');
    }
    gap();

    sectionHeader('Measurements');
    if (wo.measurements) {
      paragraph(wo.measurements);
    } else {
      paragraph('Record measurements taken on site (rooms, openings, materials).', 8);
      woBlankLines(4);
    }
    gap();

    sectionHeader('Materials');
    // Only mark "Yes" when the Work Order tab checkbox is set; No / N/A stay
    // blank (nothing to infer from a single boolean — and blank boxes stay
    // hand-markable on a printed form).
    woInlineChecks('Materials required?', [{label:'Yes', checked:!!wo.materialsRequired}, {label:'No', checked:false}]);
    woInlineChecks('Materials ordered?',  [{label:'Yes', checked:!!wo.materialsOrdered}, {label:'No', checked:false}, {label:'N/A', checked:false}]);
    if (wo.materialsList) {
      paragraph(wo.materialsList);
    } else {
      paragraph('List materials needed / ordered and the order date:', 8);
      woBlankLines(3);
    }
    gap();

    sectionHeader('Field Employee Notes');
    var _feNotes = wo.fieldNotes || '';
    if (_feNotes) paragraph(_feNotes);
    woBlankLines(_feNotes ? 2 : 4);
    gap();

    sectionHeader('Completion Sign-Off');
    var _sgGap = 6, _sgW = (contentW - _sgGap) / 2;
    needSpace(30);
    woSigBox(marginL,                   _sgW, 'Field Employee');
    woSigBox(marginL + _sgW + _sgGap,   _sgW, (short ? short + ' ' : '') + 'Housing - Supervisor');
    ctx.y += 30;

    return ctx.finish();
  }

  // Scope of Work — use quoted price when available, fall back to estimate.
  sectionHeader('Maintenance Request');
  var items = (typeof collectSowItems === 'function') ? collectSowItems() : [];
  var filtered = items.filter(function(it){ return it.category || it.description || it.quote || it.cost; });
  var quoteTotal = 0;
  var hasQuotes  = false;
  if (filtered.length) {
    filtered.forEach(function(it){
      var price;
      if (it.quote && parseFloat(it.quote) > 0) {
        quoteTotal += parseFloat(it.quote);
        hasQuotes   = true;
        price       = fmtCur(it.quote);
      } else {
        price = 'Pending';
      }
      row((it.category || '—'),
          (it.description || '—') + '  ·  ' + price);
    });
    if (hasQuotes) {
      row('Total Quoted Amount', fmtCur(quoteTotal));
    } else {
      row('Pricing', 'To be confirmed by contractor.');
    }
  } else {
    row('Scope Items', 'No line items added.');
  }
  gap();

  // Work Authorization notice
  sectionHeader('Work Authorization');
  var _woParsed    = _termsParseHtml(typeof getTermsBody === 'function' ? getTermsBody('work_order') : '');
  var woTermsIntro = _woParsed.intro;
  var woTermsItems = _woParsed.items;
  if (woTermsIntro) paragraph(woTermsIntro);
  if (woTermsItems.length) {
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(9);
    pdf.setTextColor(40);
    woTermsItems.forEach(function(t, i) {
      var lines = pdf.splitTextToSize((i + 1) + '. ' + t, contentW - 4);
      needSpace(lines.length * 4 + 1.5);
      pdf.text(lines, marginL + 3, ctx.y + 3);
      ctx.y += lines.length * 4 + 1.5;
    });
    pdf.setTextColor(0);
  } else {
    paragraph(
      'The contractor is authorized to perform only the work described above. '
      + 'Any additional work or changes to scope must be approved in writing by ' + short
      + ' Housing before work commences. Invoices must reference this Work Order and unit address. '
      + 'Payment is subject to satisfactory completion and inspection.'
    );
  }
  gap();

  // Notes
  var sowNotes = fld('sow_notes');
  if (sowNotes) {
    sectionHeader('Additional Notes');
    paragraph(sowNotes);
    gap();
  }

  // Signature blocks — omitted when Settings -> Contracts hides signatures.
  if (!_docSigsHidden()) {
  sectionHeader('Authorization');
  var sigBlockH = 26;
  var sigGap    = 6;
  var sigW      = (contentW - sigGap) / 2;
  needSpace(sigBlockH + 6);
  function sigBox(x, role) {
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(9);
    pdf.setTextColor(60);
    pdf.text(role, x, ctx.y + 4);
    pdf.setDrawColor(160);
    pdf.setLineWidth(0.3);
    // Signature line
    pdf.line(x, ctx.y + 16, x + sigW, ctx.y + 16);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(7);
    pdf.setTextColor(120);
    pdf.text('Signature', x, ctx.y + 20);
    pdf.text('Date: ____________', x + sigW, ctx.y + 20, { align: 'right' });
    pdf.text('Print name: ____________________________', x, ctx.y + 25);
    pdf.setDrawColor(0);
    pdf.setTextColor(0);
  }
  sigBox(marginL,                'Contractor Representative');
  sigBox(marginL + sigW + sigGap,short + ' Housing — Authorized Signatory');
  ctx.y += sigBlockH + 4;
  }

  return ctx.finish();
}

// Resolve the contractor's email + name from the in-memory cache first,
// falling back to Supabase REST if the cache is empty (sub-pages may not
// have loaded contractors yet). Returns { email, name } or null.
// Resolve a contractor for work-order emailing. Returns
//   { email, name, people:[{name,phone,email}] }
// where `email` is the company address and `people` are the Key Contacts from
// the Contractor Info Card. Returns the object even when the company email is
// blank (a key contact may still have one); callers decide who to send to.
async function _resolveContractorForEmail(contractorId) {
  if (!contractorId) return null;
  function _shape(email, name, people) {
    return {
      email:  (email || '').trim(),
      name:   name || '',
      people: Array.isArray(people) ? people : []
    };
  }
  var cache = window._contractors || [];
  for (var i = 0; i < cache.length; i++) {
    if (cache[i] && cache[i].id === contractorId) {
      return _shape(cache[i].email, cache[i].name, cache[i].people);
    }
  }
  if (typeof SUPABASE_URL === 'undefined' || typeof HOUSING_HEADERS === 'undefined') return null;
  try {
    // Key Contacts live in the `data` jsonb blob on housing_contractors.
    var url = SUPABASE_URL
            + '/rest/v1/housing_contractors?select=name,data&id=eq.'
            + encodeURIComponent(contractorId);
    var r = await fetch(url, { headers: HOUSING_HEADERS });
    if (!r.ok) {
      console.warn('[notify] contractor lookup HTTP ' + r.status);
      return null;
    }
    var rows = await r.json();
    var row  = rows && rows[0];
    if (!row) return null;
    var d = row.data || {};
    return _shape(d.email, row.name || d.name, d.people);
  } catch (e) {
    console.warn('[notify] contractor lookup error:', e);
    return null;
  }
}

// Wired from saveSOW() when the save transitions the SOW into an approved
// state (hm_approved or ed_approved) AND the approver ticked the inline
// checkbox on the post-save "send work order?" confirm. Silent skip when
// no contractor is assigned, no email on file, or save is fire-and-forget
// and any step throws. CC roles configurable via Settings -> Notifications.
// recipientEmails (optional): the exact contractor-side addresses the user
// picked in the work-order recipient dialog (company + selected Key Contacts).
// When omitted, falls back to the contractor's company email. Staff primary/CC
// roles from Settings -> Notifications are always added on top.
async function notifyWorkOrderToContractor(sow, unit, contractor, recipientEmails) {
  if (!sow) return;
  var eventKey = 'sow_work_order_to_contractor';

  var seen   = {};
  var emails = [];
  function _addEmail(addr) {
    if (!addr) return;
    var clean = String(addr).trim().toLowerCase();
    if (!clean || seen[clean]) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) return;
    seen[clean] = true;
    emails.push(clean);
  }

  if (Array.isArray(recipientEmails) && recipientEmails.length) {
    recipientEmails.forEach(function(e){ _addEmail(e); });
  } else if (contractor && contractor.email) {
    _addEmail(contractor.email);
  }

  // Additional staff recipients: primary + CC role checkboxes.
  var extraRoles = _emailEventRecipientRoles(eventKey).concat(_emailEventCcRoles(eventKey));
  if (extraRoles.length) {
    var extraRecipients = await _resolveActiveStaffForRoles(extraRoles);
    extraRecipients.forEach(function(r){ _addEmail(r.email); });
  }

  if (!emails.length) {
    console.log('[notify] sow_work_order_to_contractor skipped - no contractor email or CC recipients for SOW ' + (sow.project_number || '—'));
    return;
  }

  var rendered = _renderEmailTemplate(eventKey, _emailTokensForWorkOrder(sow, unit, contractor));
  if (!rendered) return;

  var pdfBase64 = null;
  try {
    pdfBase64 = await _generateWorkOrderPdfBase64();
  } catch (e) {
    console.warn('[notify] Work Order PDF generation failed, sending without attachment:', e);
  }

  var attachments;
  var bodyHtml = rendered.bodyHtml;
  if (pdfBase64) {
    attachments = [{
      name:         'Work Order ' + (sow.project_number || 'wo') + '.pdf',
      contentType:  'application/pdf',
      contentBytes: pdfBase64
    }];
  } else {
    bodyHtml += '<p style="color:#888;font-size:12px;font-style:italic;">'
              + '(Work Order PDF could not be generated automatically. Reply to this email to request one.)'
              + '</p>';
  }

  await _sendSerially(emails.map(function(e){ return { email: e }; }), function(rcp){
    return {
      to:          rcp.email,
      to_name:     '',
      subject:     rendered.subject,
      bodyHtml:    bodyHtml,
      attachments: attachments,
      event:       eventKey,
      entity_type: 'sow',
      entity_id:   sow.project_number || '—'
    };
  }, eventKey);
}

// RFQ cancellation notice to the awarded contractor. Mirrors
// notifyWorkOrderToContractor (no PDF attachment). Uses the editable
// `rfq_cancelled` template (Settings -> Notifications). Fire-and-forget; the
// caller (cancelRfq) already gated on the user's "email" checkbox + contractor
// email. `addr` is the resolved unit/project address for the {projectAddress}
// token.
// RFQ award notification to the winning contractor. Uses the editable
// `rfq_award` template. Fire-and-forget; caller gates on skipNotify + email.
async function notifyRfqAward(rfq, contractor, amount, notes, addr) {
  if (!rfq || !contractor) return;
  var eventKey = 'rfq_award';
  var seen = {}, emails = [];
  function _addEmail(a){ if(!a) return; var c=String(a).trim().toLowerCase(); if(!c||seen[c]) return; if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c)) return; seen[c]=true; emails.push(c); }
  if (contractor.email) _addEmail(contractor.email);
  var extraRoles = _emailEventRecipientRoles(eventKey).concat(_emailEventCcRoles(eventKey));
  if (extraRoles.length) {
    var extra = await _resolveActiveStaffForRoles(extraRoles);
    extra.forEach(function(r){ _addEmail(r.email); });
  }
  if (!emails.length) { console.log('[notify] rfq_award skipped — no winner email or CC recipients for ' + (rfq.id || '—')); return; }
  var natShort = (window.NATION_CONFIG && NATION_CONFIG.short) || 'Housing';
  var amtNum = parseFloat(amount) || 0;
  var esc = (typeof escapeHtml === 'function') ? escapeHtml : function(s){ return String(s == null ? '' : s); };
  var rendered = _renderEmailTemplate(eventKey, {
    contractorName: contractor.name || 'Contractor',
    rfqNumber:      rfq.id || '',
    projectAddress: addr || rfq.sow_unit_id || '',
    awardAmount:    '$' + amtNum.toFixed(2) + ' CDN',
    awardNotes:     notes ? ('<p>Notes: ' + esc(notes) + '</p>') : '',
    nationShort:    natShort
  });
  if (!rendered) return;
  await _sendSerially(emails.map(function(e){ return { email: e }; }), function(rcp){
    return { to: rcp.email, to_name: '', subject: rendered.subject, bodyHtml: rendered.bodyHtml, event: eventKey, entity_type: 'rfq', entity_id: rfq.id || '—' };
  }, eventKey);
}
window.notifyRfqAward = notifyRfqAward;

// RFQ regret notices to the OTHER bidders (recorded a bid, not the winner).
// `losers` is an array of contractor records. Uses the editable `rfq_regret`
// template, rendered per-recipient (each gets their own {contractorName}), and
// serialized to respect the Graph ~4-concurrent sendMail throttle.
async function notifyRfqRegret(rfq, losers, addr) {
  if (!rfq || !Array.isArray(losers) || !losers.length) return;
  var eventKey = 'rfq_regret';
  var natShort = (window.NATION_CONFIG && NATION_CONFIG.short) || 'Housing';
  var seen = {}, recipients = [];
  losers.forEach(function(ct){
    if (!ct || !ct.email) return;
    var c = String(ct.email).trim().toLowerCase();
    if (!c || seen[c] || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c)) return;
    seen[c] = true;
    recipients.push({ email: c, name: ct.name || 'Contractor' });
  });
  if (!recipients.length) return;
  await _sendSerially(recipients, function(rcp){
    var rendered = _renderEmailTemplate(eventKey, {
      contractorName: rcp.name || 'Contractor',
      rfqNumber:      rfq.id || '',
      projectAddress: addr || rfq.sow_unit_id || '',
      nationShort:    natShort
    });
    if (!rendered) return null;
    return { to: rcp.email, to_name: '', subject: rendered.subject, bodyHtml: rendered.bodyHtml, event: eventKey, entity_type: 'rfq', entity_id: rfq.id || '—' };
  }, eventKey);
}
window.notifyRfqRegret = notifyRfqRegret;

async function notifyRfqCancelled(rfq, contractor, addr) {
  if (!rfq || !contractor) return;
  var eventKey = 'rfq_cancelled';
  var seen = {}, emails = [];
  function _addEmail(a){ if(!a) return; var c=String(a).trim().toLowerCase(); if(!c||seen[c]) return; if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c)) return; seen[c]=true; emails.push(c); }
  if (contractor.email) _addEmail(contractor.email);
  // Optional staff recipients from the template's primary + CC role checkboxes.
  var extraRoles = _emailEventRecipientRoles(eventKey).concat(_emailEventCcRoles(eventKey));
  if (extraRoles.length) {
    var extra = await _resolveActiveStaffForRoles(extraRoles);
    extra.forEach(function(r){ _addEmail(r.email); });
  }
  if (!emails.length) { console.log('[notify] rfq_cancelled skipped — no contractor email or CC recipients for ' + (rfq.id || '—')); return; }
  var natShort = (window.NATION_CONFIG && NATION_CONFIG.short) || 'Housing';
  var rendered = _renderEmailTemplate(eventKey, {
    contractorName: contractor.name || 'Contractor',
    rfqNumber:      rfq.id || '',
    projectAddress: addr || rfq.sow_unit_id || '',
    nationShort:    natShort
  });
  if (!rendered) return;
  await _sendSerially(emails.map(function(e){ return { email: e }; }), function(rcp){
    return { to: rcp.email, to_name: '', subject: rendered.subject, bodyHtml: rendered.bodyHtml, event: eventKey, entity_type: 'rfq', entity_id: rfq.id || '—' };
  }, eventKey);
}
window.notifyRfqCancelled = notifyRfqCancelled;

// Tokens for the in-house field-employee work-order email — reuses the work
// order token set and adds the assignee's name.
function _emailTokensForFieldWorkOrder(sow, unit) {
  var base = _emailTokensForWorkOrder(sow, unit, null);
  base.employeeName = (sow && sow.assignedToName) || '—';
  return base;
}

// Email an in-house work order. The assigned field employee (if one is
// selected) gets it, and the Housing Manager ALWAYS gets it (via the event's
// CC roles). The employee is optional — the work order still goes out to the
// Housing Manager when no specific employee is picked. Fire-and-forget.
async function notifyWorkOrderToFieldEmployee(sow, unit) {
  if (!sow) return;
  var eventKey = 'sow_assigned_to_field_employee';
  var to = (sow.assignedTo || '').trim().toLowerCase();
  var hasEmployee = !!(to && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to));
  var seen = {}; var emails = [];
  if (hasEmployee) { emails.push(to); seen[to] = true; }
  var extraRoles = _emailEventRecipientRoles(eventKey).concat(_emailEventCcRoles(eventKey));
  if (extraRoles.length) {
    var extra = await _resolveActiveStaffForRoles(extraRoles);
    extra.forEach(function(r){ var c = (r.email||'').trim().toLowerCase(); if (c && !seen[c]) { seen[c] = true; emails.push(c); } });
  }
  if (!emails.length) {
    console.log('[notify] sow_assigned_to_field_employee skipped - no employee email and no Housing Manager on file for SOW ' + (sow.project_number || '—'));
    return;
  }
  var rendered = _renderEmailTemplate(eventKey, _emailTokensForFieldWorkOrder(sow, unit));
  if (!rendered) return;

  // Attach the in-house Work Order PDF (checklist form) so the crew and the
  // Housing Manager receive the printable form, not just a notice. Best-effort:
  // if generation fails the email still sends with a short note. The SOW modal
  // is still mounted (closeSowModal only hides it), so the generator's DOM
  // reads resolve to the in-house checklist variant.
  var attachments = null;
  var bodyHtml    = rendered.bodyHtml;
  if (typeof _generateWorkOrderPdfBase64 === 'function') {
    try {
      var pdfBase64 = await _generateWorkOrderPdfBase64();
      if (pdfBase64) {
        attachments = [{
          name:         'Work Order ' + (sow.project_number || 'wo') + '.pdf',
          contentType:  'application/pdf',
          contentBytes: pdfBase64
        }];
      }
    } catch (e) {
      console.warn('[notify] in-house Work Order PDF generation failed, sending without attachment:', e);
    }
  }
  if (!attachments) {
    bodyHtml += '<p style="color:#888;font-size:12px;font-style:italic;">'
              + '(Work Order PDF could not be generated automatically. Open the request in the Housing app to print it.)'
              + '</p>';
  }

  await _sendSerially(emails.map(function(e){ return { email: e }; }), function(rcp){
    return {
      to:          rcp.email,
      to_name:     (rcp.email === to ? (sow.assignedToName || '') : ''),
      subject:     rendered.subject,
      bodyHtml:    bodyHtml,
      attachments: attachments,
      event:       eventKey,
      entity_type: 'sow',
      entity_id:   sow.project_number || '—'
    };
  }, eventKey);
}

// Returns the recipient role list for an event — saved override if the
// ED has set one, otherwise the registry default. Always returns an
// array (possibly empty).
function _emailEventRecipientRoles(eventKey) {
  var saved = (window._appSettings && window._appSettings.email_templates
            && window._appSettings.email_templates[eventKey]) || {};
  if (Array.isArray(saved.recipientRoles)) return saved.recipientRoles.slice();
  var cfg = _emailEventConfig(eventKey);
  return (cfg && Array.isArray(cfg.defaultRecipientRoles)) ? cfg.defaultRecipientRoles.slice() : [];
}

// Same shape for the optional CC role list. Empty by default for every
// event; the ED can opt-in via the Settings -> Notifications tab.
function _emailEventCcRoles(eventKey) {
  var saved = (window._appSettings && window._appSettings.email_templates
            && window._appSettings.email_templates[eventKey]) || {};
  if (Array.isArray(saved.ccRoles)) return saved.ccRoles.slice();
  var cfg = _emailEventConfig(eventKey);
  return (cfg && Array.isArray(cfg.defaultCcRoles)) ? cfg.defaultCcRoles.slice() : [];
}

// Look up active staff across multiple roles + dedupe by email so a
// staffer with overlapping roles doesn't get two copies of the same
// notification. Order is by the role list passed in (first role's
// matches first), but within a role the order is whatever PostgREST
// returned (no specific guarantee).
async function _resolveActiveStaffForRoles(roles) {
  var seen = {};
  var out  = [];
  for (var i = 0; i < roles.length; i++) {
    var rcps = await _sbLoadActiveStaffByRole(roles[i]);
    for (var j = 0; j < rcps.length; j++) {
      var r = rcps[j];
      if (!r || !r.email) continue;
      var k = r.email.toLowerCase();
      if (seen[k]) continue;
      seen[k] = true;
      out.push(r);
    }
  }
  return out;
}


// ════════════════════════════════════════════════════════════════════════
// Settings -> Notifications tab UI (Phase 2)
// ────────────────────────────────────────────────────────────────────────
// Two-column layout:
//   • Left  - registry-driven event list, click to load template
//   • Right - editor pane (subject + placeholder chips + rich text body
//             + Save/Reset/Send Test buttons)
// All functions in this section are window-globals via plain function
// declarations so onclick="..." handlers in dynamically-rendered HTML
// can reach them (matches the rest of the app's pattern).
// ════════════════════════════════════════════════════════════════════════

// Currently selected event in the editor. Survives across tab re-renders
// in the same session so a misclick on Reset doesn't bounce the user.
var _ntfSelectedEvent = null;

function renderNotificationsTab() {
  var body = document.getElementById('notifications_panel_body');
  if (!body) return;

  // Default to the first event in the registry on first open.
  if (!_ntfSelectedEvent) _ntfSelectedEvent = EMAIL_EVENT_REGISTRY[0] && EMAIL_EVENT_REGISTRY[0].key;

  // Pipeline test strip — one click sends a real branded email to the
  // signed-in admin through the full send-notification path, so a nation's
  // email setup (provider, secrets, DNS) can be verified without staging a
  // workflow event. Errors surface verbatim for troubleshooting.
  // Recipient is editable: the signed-in address is only a default, because
  // seeded/demo logins (e.g. ed@demo.fnhub.app) are identities, not real
  // mailboxes — and an editable recipient also makes mail-tester.com checks
  // a one-click job (paste its throwaway address, send).
  var _myEmail = (window.HOUSING_SESSION && HOUSING_SESSION.email) || '';
  var testStrip =
      '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:14px;padding:11px 14px;background:var(--bg);border:1px solid var(--border);border-radius:9px;">'
    +   '<span style="font-size:12.5px;color:var(--text);flex-shrink:0;"><strong>Test the email pipeline</strong> — send a branded test to:</span>'
    +   '<input type="email" id="ntf_test_to" value="' + _ntfEsc(_myEmail) + '" placeholder="you@example.com" '
    +     'style="flex:1;min-width:200px;border:1.5px solid var(--border);border-radius:7px;padding:7px 10px;font-size:12.5px;background:var(--surface);color:var(--text);"/>'
    +   '<button type="button" id="ntf_test_btn" onclick="ntfSendTestEmail()" class="btn btn-primary btn-sm">📧 Send test email</button>'
    +   '<span style="font-size:11px;color:var(--muted);flex-basis:100%;">Sends through this nation\'s configured provider. Use a real mailbox you can check — or paste a mail-tester.com address to score spam-readiness.</span>'
    + '</div>';

  body.innerHTML =
      testStrip
    + '<div class="ntf-grid">'
    +   '<div class="ntf-event-list" id="ntf_event_list">' + _ntfRenderEventListHtml() + '</div>'
    +   '<div class="ntf-editor"      id="ntf_editor">'    + _ntfRenderEditorHtml(_ntfSelectedEvent) + '</div>'
    + '</div>';

  _ntfWireEventListClicks();
  _ntfWireEditor();
}

// Send a real test email to the signed-in user through the normal pipeline
// (sendNotification -> send-notification Edge Function -> the nation's
// provider). Success/failure toasts carry the server's actual error so a
// misconfigured provider is diagnosable from the app.
function ntfSendTestEmail() {
  var inp = document.getElementById('ntf_test_to');
  var me = ((inp && inp.value) || (window.HOUSING_SESSION && HOUSING_SESSION.email) || '').trim();
  if (!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(me)) { if (typeof showToast === 'function') showToast('Enter a valid recipient email address first.', {type:'error'}); return; }
  var btn = document.getElementById('ntf_test_btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
  var nation = (typeof nationDisplay === 'function') ? nationDisplay() : 'Housing';
  window.sendNotification({
    to: me,
    subject: 'Test email — ' + nation + ' Housing notifications',
    bodyHtml:
        '<p style="font-size:14px;line-height:1.65;color:#374151;margin:0 0 12px;">This is a <strong>test message</strong> from the '
      +   _ntfEsc(nation) + ' Housing system, sent ' + new Date().toLocaleString('en-CA') + '.</p>'
      + '<p style="font-size:13px;line-height:1.6;color:#374151;margin:0;">If you received this, the email pipeline is working: the provider is configured, the sending domain authenticates, and workflow notifications will deliver.</p>',
    event: 'test_email', entity_type: 'settings', entity_id: 'TEST'
  }).then(function(){
    if (typeof showToast === 'function') showToast('Test email sent to ' + me + ' — check your inbox (and spam folder on the first send).', {type:'info'});
    if (typeof auditEntry === 'function') auditEntry('SETTINGS', 'test_email_sent', 'Test email sent to ' + me, window.currentRole || 'staff');
  }).catch(function(e){
    if (typeof showToast === 'function') showToast('Test email failed: ' + (e && e.message ? e.message : 'unknown error'), {type:'error'});
  }).finally(function(){
    if (btn) { btn.disabled = false; btn.textContent = '📧 Send test email'; }
  });
}
window.ntfSendTestEmail = ntfSendTestEmail;

// Left column — one row per registry entry. Wired (live) events get
// a green dot; pending events get a grey dot so the ED can pre-author
// templates that take effect once the firing point is wired in code.
function _ntfRenderEventListHtml() {
  return EMAIL_EVENT_REGISTRY.map(function(ev){
    var isActive = ev.key === _ntfSelectedEvent;
    var dotCls   = ev.wired ? 'ntf-dot ntf-dot-on' : 'ntf-dot ntf-dot-off';
    var status   = ev.wired ? 'Wired'              : 'Pending';
    return '<button type="button" data-ntf-event="' + _ntfEsc(ev.key) + '" '
         + 'class="ntf-event-item' + (isActive ? ' is-active' : '') + '">'
         + '<span class="' + dotCls + '" title="' + status + '"></span>'
         + '<div class="ntf-event-text">'
         +   '<div class="ntf-event-label">' + _ntfEsc(ev.label) + '</div>'
         +   '<div class="ntf-event-desc">'  + _ntfEsc(ev.description || '') + '</div>'
         + '</div>'
         + '</button>';
  }).join('');
}

// Right column — recipients picker + subject + placeholder chips +
// toolbar + contentEditable body. The current saved (or default)
// template is loaded into the fields; edits are not persisted until Save.
function _ntfRenderEditorHtml(eventKey) {
  var cfg = _emailEventConfig(eventKey);
  if (!cfg) return '<div class="empty-state-italic">Select a notification event from the list to edit it.</div>';

  // Saved override wins, otherwise registry default.
  var saved = (window._appSettings && window._appSettings.email_templates
            && window._appSettings.email_templates[eventKey]) || {};
  var subject  = (saved.subject  != null && saved.subject  !== '') ? saved.subject  : cfg.defaults.subject;
  var bodyHtml = (saved.bodyHtml != null && saved.bodyHtml !== '') ? saved.bodyHtml : cfg.defaults.bodyHtml;
  // Recipients block - unified layout across every event:
  //   1) Primary Recipients - either the applicant's email (fixed, for
  //      applicant-type events) OR a role checklist (everyone else).
  //   2) Optional CC - always a role checklist, defaulting to nothing
  //      ticked. Anyone ticked here gets a copy in addition to the
  //      primary recipient(s). Deduped at send time.
  var primaryRoles = _emailEventRecipientRoles(eventKey);
  var ccRoles      = _emailEventCcRoles(eventKey);

  function _buildRoleChecks(checkedRoles, gridDataAttr) {
    var set = {}; (checkedRoles || []).forEach(function(r){ set[r] = true; });
    return NTF_ROLE_CHOICES.map(function(rk){
      var label = (typeof CLFN_PERMS !== 'undefined' && CLFN_PERMS.roleLabel)
                  ? CLFN_PERMS.roleLabel(rk) : rk;
      var checked = set[rk] ? ' checked' : '';
      return '<label class="ntf-role-check">'
           +   '<input type="checkbox" ' + gridDataAttr + '="' + _ntfEsc(rk) + '"' + checked + '/>'
           +   '<span>' + _ntfEsc(label) + '</span>'
           + '</label>';
    }).join('');
  }

  // Primary block. Every event renders the role checkbox grid so the
  // editor pane reads consistently. Applicant- and tenant-type events
  // ALSO show a static info line above the grid noting the implicit
  // recipient — the grid then adds additional staff roles on top.
  var primaryBlock = '';
  if (cfg.recipientType === 'applicant') {
    primaryBlock +=
        '<div class="ntf-recipients-fixed">'
      +   'Always sends to the <strong>applicant&#39;s email</strong> from the application form '
      +   '(plus the <strong>co-applicant&#39;s email</strong> if it differs).'
      + '</div>';
  } else if (cfg.recipientType === 'tenant') {
    primaryBlock +=
        '<div class="ntf-recipients-fixed">'
      +   'Always sends to the <strong>tenant&#39;s email</strong> from their Tenant Information Card '
      +   '(silent skip if no email is on file).'
      + '</div>';
  } else if (cfg.recipientType === 'contractor') {
    primaryBlock +=
        '<div class="ntf-recipients-fixed">'
      +   'Always sends to the <strong>assigned contractor&#39;s email</strong> from their contractor record '
      +   '(silent skip if no email is on file).'
      + '</div>';
  } else if (cfg.recipientType === 'field_employee') {
    primaryBlock +=
        '<div class="ntf-recipients-fixed">'
      +   'Always sends to the <strong>assigned field employee&#39;s email</strong> (the in-house crew member assigned the work order; '
      +   'silent skip if none is assigned or no email is on file).'
      + '</div>';
  } else if (cfg.recipientType === 'rfq_contractor') {
    primaryBlock +=
        '<div class="ntf-recipients-fixed">'
      +   'Sent to each <strong>selected contractor</strong> individually when an RFQ is issued '
      +   '(each contractor only sees their own email &mdash; addresses are never shared). '
      +   'The <strong>housing mailbox</strong> is always included. '
      +   'Use the CC checkboxes below to include additional housing staff on every RFQ email.'
      + '</div>';
  }
  primaryBlock += '<div class="ntf-roles" id="ntf_roles">'
               + _buildRoleChecks(primaryRoles, 'data-ntf-role')
               + '</div>';

  // Optional CC block — identical structure across every event so the
  // editor pane reads consistently. Different data-attr so the reader
  // can tell the two grids apart.
  var ccBlock = '<div class="ntf-roles" id="ntf_cc_roles">'
              + _buildRoleChecks(ccRoles, 'data-ntf-cc-role')
              + '</div>';

  var chips = (cfg.placeholders || []).map(function(t){
    return '<button type="button" class="ntf-chip" data-ntf-token="' + _ntfEsc(t) + '" '
         + 'title="Insert {' + _ntfEsc(t) + '} at cursor">{' + _ntfEsc(t) + '}</button>';
  }).join('');

  var toolbar =
      '<div class="ntf-toolbar" role="toolbar" aria-label="Formatting">'
    +   '<button type="button" class="ntf-tool" data-ntf-cmd="bold"               title="Bold (Ctrl+B)"><b>B</b></button>'
    +   '<button type="button" class="ntf-tool" data-ntf-cmd="italic"             title="Italic (Ctrl+I)"><i>I</i></button>'
    +   '<button type="button" class="ntf-tool" data-ntf-cmd="underline"          title="Underline (Ctrl+U)"><u>U</u></button>'
    +   '<span class="ntf-tool-sep"></span>'
    +   '<button type="button" class="ntf-tool" data-ntf-cmd="formatBlock-p"      title="Paragraph">&para;</button>'
    +   '<button type="button" class="ntf-tool" data-ntf-cmd="insertUnorderedList" title="Bulleted list">&bull;</button>'
    +   '<button type="button" class="ntf-tool" data-ntf-cmd="insertOrderedList"   title="Numbered list">1.</button>'
    +   '<span class="ntf-tool-sep"></span>'
    +   '<button type="button" class="ntf-tool" data-ntf-cmd="createLink"          title="Insert link">&#128279;</button>'
    +   '<button type="button" class="ntf-tool" data-ntf-cmd="unlink"              title="Remove link">&#10005;&#128279;</button>'
    + '</div>';

  return ''
    + '<div class="ntf-editor-header">'
    +   '<div class="ntf-editor-title">' + _ntfEsc(cfg.label) + '</div>'
    +   '<div class="ntf-editor-meta">'
    +     'Status: <strong>' + (cfg.wired ? 'Wired (live)' : 'Pending wiring') + '</strong>'
    +   '</div>'
    + '</div>'
    + '<div class="ntf-field">'
    +   '<label class="ntf-label">Recipients' + (cfg.recipientType === 'applicant' || cfg.recipientType === 'tenant' || cfg.recipientType === 'contractor' || cfg.recipientType === 'field_employee'
          ? ''
          : ' <span class="ntf-label-hint">(active staff in any ticked role)</span>') + '</label>'
    +   primaryBlock
    + '</div>'
    + '<div class="ntf-field">'
    +   '<label class="ntf-label">Optional CC <span class="ntf-label-hint">(active staff in any ticked role; deduped against the primary recipients)</span></label>'
    +   ccBlock
    + '</div>'
    + '<div class="ntf-field">'
    +   '<label class="ntf-label" for="ntf_subject">Subject</label>'
    +   '<input type="text" id="ntf_subject" class="ntf-input" value="' + _ntfEsc(subject) + '"/>'
    + '</div>'
    + '<div class="ntf-field">'
    +   '<label class="ntf-label">Available placeholders <span class="ntf-label-hint">(click to insert at cursor)</span></label>'
    +   '<div class="ntf-chips" id="ntf_chips">' + chips + '</div>'
    + '</div>'
    + '<div class="ntf-field">'
    +   '<label class="ntf-label">Body</label>'
    +   toolbar
    +   '<div id="ntf_body" class="ntf-body" contenteditable="true">' + bodyHtml + '</div>'
    + '</div>'
    + '<div class="ntf-actions">'
    +   '<button type="button" class="btn btn-primary" onclick="saveNotificationTemplate()">Save</button>'
    +   '<button type="button" class="btn btn-ghost"   onclick="resetNotificationTemplate()">Reset to Default</button>'
    +   '<button type="button" class="btn btn-ghost"   onclick="sendNotificationTest()">Send Test Email</button>'
    + '</div>';
}

function _ntfWireEventListClicks() {
  var list = document.getElementById('ntf_event_list');
  if (!list) return;
  list.querySelectorAll('[data-ntf-event]').forEach(function(btn){
    btn.addEventListener('click', function(){
      _ntfSelectedEvent = btn.getAttribute('data-ntf-event');
      // Re-render only what changed: list selection state + editor pane.
      list.innerHTML = _ntfRenderEventListHtml();
      var ed = document.getElementById('ntf_editor');
      if (ed) ed.innerHTML = _ntfRenderEditorHtml(_ntfSelectedEvent);
      _ntfWireEventListClicks();
      _ntfWireEditor();
    });
  });
}

// Wire the toolbar + placeholder chips. Idempotent so it can be re-run
// after a re-render without piling up listeners.
function _ntfWireEditor() {
  var bodyEl = document.getElementById('ntf_body');
  if (!bodyEl) return;

  // Toolbar
  document.querySelectorAll('.ntf-tool').forEach(function(btn){
    if (btn.getAttribute('data-ntf-bound') === '1') return;
    btn.setAttribute('data-ntf-bound', '1');
    btn.addEventListener('mousedown', function(e){
      // mousedown (not click) so the body editor doesn't lose its
      // selection before we run the command.
      e.preventDefault();
    });
    btn.addEventListener('click', function(e){
      e.preventDefault();
      var cmd = btn.getAttribute('data-ntf-cmd');
      _ntfRunToolbarCmd(cmd, bodyEl);
    });
  });

  // Placeholder chips
  document.querySelectorAll('.ntf-chip').forEach(function(chip){
    if (chip.getAttribute('data-ntf-bound') === '1') return;
    chip.setAttribute('data-ntf-bound', '1');
    chip.addEventListener('mousedown', function(e){ e.preventDefault(); });
    chip.addEventListener('click', function(e){
      e.preventDefault();
      var token = chip.getAttribute('data-ntf-token');
      _ntfInsertAtCursor('{' + token + '}', bodyEl);
    });
  });
}

function _ntfRunToolbarCmd(cmd, bodyEl) {
  bodyEl.focus();
  if (cmd === 'createLink') {
    var url = prompt('Link URL (https://...):', 'https://');
    if (!url) return;
    // Allow only safe schemes
    if (!/^(https?:|mailto:)/i.test(url)) {
      alert('Only http://, https://, and mailto: links are allowed.');
      return;
    }
    document.execCommand('createLink', false, url);
    return;
  }
  if (cmd === 'formatBlock-p') {
    document.execCommand('formatBlock', false, 'P');
    return;
  }
  if (cmd === 'unlink') {
    document.execCommand('unlink', false, null);
    return;
  }
  document.execCommand(cmd, false, null);
}

// Insert plain text at the current selection in the body editor. Used
// by the placeholder chips so the user can drop {applicantName} mid-
// sentence without copy-pasting.
function _ntfInsertAtCursor(text, bodyEl) {
  bodyEl.focus();
  var sel = window.getSelection();
  if (sel && sel.rangeCount && bodyEl.contains(sel.anchorNode)) {
    var range = sel.getRangeAt(0);
    range.deleteContents();
    range.insertNode(document.createTextNode(text));
    // Move cursor to end of inserted text
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  } else {
    // No selection inside the body — append at the end.
    bodyEl.appendChild(document.createTextNode(text));
  }
}

// Sanitise contentEditable HTML before persisting. Whitelist of safe
// inline/structural tags + a tight attribute filter on links. Anything
// not on the whitelist is replaced with its text content.
var _NTF_TAG_WHITELIST = {
  P:1, BR:1, DIV:1, SPAN:1,
  STRONG:1, B:1, EM:1, I:1, U:1,
  UL:1, OL:1, LI:1,
  A:1,
  H1:1, H2:1, H3:1, H4:1  // allowed in Contracts editor + jsPDF renderer
};
function _ntfSanitizeBodyHtml(rawHtml) {
  var doc = new DOMParser().parseFromString('<div id="root">' + rawHtml + '</div>', 'text/html');
  var root = doc.getElementById('root');
  _ntfSanitizeNode(root);
  return root.innerHTML;
}
function _ntfSanitizeNode(node) {
  // Walk a snapshot so removals don't break iteration.
  var children = Array.prototype.slice.call(node.childNodes);
  children.forEach(function(child){
    if (child.nodeType === 1 /* element */) {
      var tag = child.tagName;
      if (!_NTF_TAG_WHITELIST[tag]) {
        // Replace with text content of the disallowed element.
        var text = document.createTextNode(child.textContent || '');
        node.replaceChild(text, child);
        return;
      }
      // Strip every attribute except whitelisted ones.
      var attrs = Array.prototype.slice.call(child.attributes);
      attrs.forEach(function(a){
        var ok = false;
        if (tag === 'A' && a.name === 'href') {
          ok = /^(https?:|mailto:)/i.test(a.value);
        }
        if (!ok) child.removeAttribute(a.name);
      });
      // Force target=_blank rel=noopener on surviving links so they open
      // in a new tab and can't tamper with the opener.
      if (tag === 'A' && child.getAttribute('href')) {
        child.setAttribute('target', '_blank');
        child.setAttribute('rel',    'noopener');
      }
      _ntfSanitizeNode(child);
    } else if (child.nodeType !== 3 /* text */) {
      // Drop comments / processing instructions / etc.
      node.removeChild(child);
    }
  });
}

// Save the current editor state to housing_settings (key=email_templates).
// Uses the existing PostgREST upsert pattern from saveScoringModelED.
// ED-only: same gate as the rest of the editable settings surfaces.
function saveNotificationTemplate() {
  if (!_cfgEdGuard('Only the Executive Director can edit notification templates')) return;
  var ed = _ntfReadEditorState();
  if (!ed) return;
  var all  = (window._appSettings && window._appSettings.email_templates) || {};
  // Clone so we don't mutate the cached copy until the upsert succeeds.
  var next = Object.assign({}, all);
  next[ed.eventKey] = {
    subject:        ed.subject,
    bodyHtml:       ed.bodyHtml,
    recipientRoles: ed.recipientRoles,
    ccRoles:        ed.ccRoles
  };

  var _detail = 'Email template updated: ' + ed.eventKey
              + ' (recipients: ' + (ed.recipientRoles.join(',') || '-')
              + '; cc: '         + (ed.ccRoles.join(',')        || '-')
              + ')';
  persistSetting('email_templates', next, {
    auditAction: 'email_template_save',
    auditDetail: _detail,
    okMsg:       '✓ Template saved',
    failMsg:     'Save failed - check connection'
  });
}

// Reset the editor (NOT the saved template) to the registry defaults —
// subject, body, AND recipient role checkboxes. User must click Save
// to actually wipe the persisted override.
function resetNotificationTemplate() {
  if (!_ntfSelectedEvent) return;
  var cfg = _emailEventConfig(_ntfSelectedEvent);
  if (!cfg) return;
  var subj = document.getElementById('ntf_subject');
  var body = document.getElementById('ntf_body');
  if (subj) subj.value     = cfg.defaults.subject;
  if (body) body.innerHTML = cfg.defaults.bodyHtml;
  // Restore both checkbox grids from registry defaults. For applicant-
  // type events there's no primary grid (no #ntf_roles in the DOM), so
  // the querySelectorAll is a no-op there.
  var defaultRoles = (cfg.defaultRecipientRoles || []).reduce(function(m,r){ m[r] = true; return m; }, {});
  var rolesEl = document.getElementById('ntf_roles');
  if (rolesEl) {
    rolesEl.querySelectorAll('input[type="checkbox"][data-ntf-role]').forEach(function(cb){
      cb.checked = !!defaultRoles[cb.getAttribute('data-ntf-role')];
    });
  }
  var defaultCc = (cfg.defaultCcRoles || []).reduce(function(m,r){ m[r] = true; return m; }, {});
  var ccEl = document.getElementById('ntf_cc_roles');
  if (ccEl) {
    ccEl.querySelectorAll('input[type="checkbox"][data-ntf-cc-role]').forEach(function(cb){
      cb.checked = !!defaultCc[cb.getAttribute('data-ntf-cc-role')];
    });
  }
  showToast('Reverted to default. Click Save to persist.', {type:'info'});
}

// Send the current (unsaved) template to the logged-in user's email,
// substituted with mock data so they can preview without touching real
// applications. Tagged event=email_test in the audit log.
function sendNotificationTest() {
  var ed = _ntfReadEditorState();
  if (!ed) return;
  var session = (typeof HOUSING_SESSION !== 'undefined' && HOUSING_SESSION) ? HOUSING_SESSION : null;
  var to      = session && session.email;
  if (!to) { showToast('No signed-in email to send to', {type:'info'}); return; }

  var tokens   = _ntfMockTokensForEvent(ed.eventKey);
  var subject  = _substitutePlaceholders(ed.subject,  tokens);
  var bodyHtml = _substitutePlaceholders(ed.bodyHtml, tokens);

  showToast('Sending test to ' + to + '...', {type:'info'});
  window.sendNotification({
    to:          to,
    to_name:     (session && session.name) || '',
    subject:     '[TEST] ' + subject,
    bodyHtml:    bodyHtml,
    event:       'email_test',
    entity_type: 'notification_test',
    entity_id:   ed.eventKey
  }).then(function(){
    showToast('✓ Test email sent to ' + to, {type:'info'});
  }).catch(function(err){
    console.warn('[ntf] test send failed:', err);
    showToast('Test send failed - see console', {type:'error'});
  });
}

// Mock data for Send Test — picks the right token builder per event so
// every notification can be previewed against representative-looking
// values. Add a new branch here when adding a new entity type.
function _ntfMockTokensForEvent(eventKey) {
  if (eventKey === 'application_submitted'
   || eventKey === 'file_update_submitted'
   || eventKey === 'application_confirmation_to_applicant') {
    return _emailTokensForApp({
      id: 'APP-TEST-0001', fn: 'Jane', ln: 'Sample',
      score: 42, tier: 'High Priority', appType: 'new_housing'
    });
  }
  if (eventKey === 'sow_created') {
    return _emailTokensForSow({
      address:    '123 Test Street',
      totalCost:  '$15,000',
      condition:  'Habitable - needs work',
      contractor: 'Sample Contractor Ltd.'
    }, 'TEST-UNIT');
  }
  if (eventKey === 'sow_tenant_copy') {
    return _emailTokensForSowTenant({
      address:        '123 Test Street',
      project_number: '123 Test Street-SOW-001',
      totalCost:      '$15,000',
      condition:      'Habitable - needs work',
      contractor:     'Sample Contractor Ltd.',
      tenantName:     'Jane Sample'
    }, null, 'Jane Sample');
  }
  if (eventKey === 'sow_work_order_to_contractor') {
    return _emailTokensForWorkOrder({
      address:        '123 Test Street',
      project_number: '123 Test Street-SOW-001',
      totalCost:      '$15,000',
      tenantName:     'Jane Sample',
      startDate:      '2026-06-01',
      endDate:        '2026-07-15'
    }, null, { name: 'Sample Contractor Ltd.' });
  }
  if (eventKey === 'contractor_submitted') {
    return _emailTokensForContractor({
      id:             'CT-TEST-0001',
      name:           'Sample Contractor Ltd.',
      trade:          'General Contractor',
      classification: 'internal_indigenous'
    });
  }
  if (eventKey === 'rfq_award') {
    return {
      nationShort:    _emailNationShort(),
      appLink:        _emailAppLink(),
      contractorName: 'Sample Contractor Ltd.',
      rfqNumber:      'RFQ-2026-0007',
      projectAddress: '123 Test Street',
      awardAmount:    '$15,000.00 CDN',
      awardNotes:     '<p>Notes: Award subject to a signed contract.</p>'
    };
  }
  if (eventKey === 'rfq_regret') {
    return {
      nationShort:    _emailNationShort(),
      appLink:        _emailAppLink(),
      contractorName: 'Sample Contractor Ltd.',
      rfqNumber:      'RFQ-2026-0007',
      projectAddress: '123 Test Street'
    };
  }
  if (eventKey === 'rfq_cancelled') {
    return {
      nationShort:    _emailNationShort(),
      appLink:        _emailAppLink(),
      contractorName: 'Sample Contractor Ltd.',
      rfqNumber:      'RFQ-2026-0007',
      projectAddress: '123 Test Street'
    };
  }
  // Fallback — only the always-available tokens are populated.
  return {
    nationShort: _emailNationShort(),
    appLink:     _emailAppLink()
  };
}

// Read + sanitize the current editor state. Returns null on missing
// inputs so callers can early-return cleanly.
function _ntfReadEditorState() {
  if (!_ntfSelectedEvent) { showToast('Pick a notification event first', {type:'info'}); return null; }
  var subjEl = document.getElementById('ntf_subject');
  var bodyEl = document.getElementById('ntf_body');
  if (!subjEl || !bodyEl) { showToast('Editor not ready', {type:'info'}); return null; }
  var subject  = (subjEl.value || '').trim();
  var bodyHtml = _ntfSanitizeBodyHtml(bodyEl.innerHTML || '');
  if (!subject)  { showToast('Subject is required', {type:'error'}); subjEl.focus(); return null; }
  if (!bodyHtml || bodyHtml === '<br>' || bodyHtml.replace(/<[^>]+>/g,'').trim() === '') {
    showToast('Body is required', {type:'error'}); bodyEl.focus(); return null;
  }
  // Read both checkbox grids. Primary (#ntf_roles) is required for
  // non-applicant events; applicant-type events have no primary grid
  // because the applicant's email is the fixed primary recipient.
  // CC (#ntf_cc_roles) is always optional.
  var cfg   = _emailEventConfig(_ntfSelectedEvent);
  var roles = [];
  var rolesEl = document.getElementById('ntf_roles');
  if (rolesEl) {
    rolesEl.querySelectorAll('input[type="checkbox"][data-ntf-role]').forEach(function(cb){
      if (cb.checked) roles.push(cb.getAttribute('data-ntf-role'));
    });
  }
  var ccRoles = [];
  var ccEl = document.getElementById('ntf_cc_roles');
  if (ccEl) {
    ccEl.querySelectorAll('input[type="checkbox"][data-ntf-cc-role]').forEach(function(cb){
      if (cb.checked) ccRoles.push(cb.getAttribute('data-ntf-cc-role'));
    });
  }
  var isImplicitRecipient = cfg && (cfg.recipientType === 'applicant' || cfg.recipientType === 'tenant' || cfg.recipientType === 'contractor' || cfg.recipientType === 'rfq_contractor' || cfg.recipientType === 'field_employee');
  if (!isImplicitRecipient && !roles.length) {
    showToast('Pick at least one recipient role', {type:'info'});
    return null;
  }
  return {
    eventKey:       _ntfSelectedEvent,
    subject:        subject,
    bodyHtml:       bodyHtml,
    recipientRoles: roles,
    ccRoles:        ccRoles
  };
}

// Tiny HTML escaper used for everything we render into innerHTML where
// the text could contain <, >, &, etc. (Reuses the page-wide escapeHtml
// when available; falls back to a local impl for standalone tests.)
function _ntfEsc(s) {
  if (typeof escapeHtml === 'function') return escapeHtml(s == null ? '' : String(s));
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}


// ════════════════════════════════════════════════════════════════════════
// Settings -> Config tab (display-only reference)
// ────────────────────────────────────────────────────────────────────────
// Shows the non-secret values used at app setup time (today: the
// Microsoft Graph email pipeline IDs). All values are read from
// shared-config.js constants - the actual sending continues to use
// the Supabase Edge Function secrets, which are NEVER exposed here.
// Editing is via the deep-link to the Supabase Dashboard.
// ════════════════════════════════════════════════════════════════════════

async function renderConfigPanel() {
  var body = document.getElementById('config_panel_body');
  if (!body) return;

  // Per-nation email pipeline config (resolved from this nation's own directory
  // entry / registry row). NEVER a global -- a global CLFN_GRAPH_CONFIG used to
  // render CLFN's Entra tenant/client + mailbox on every nation's settings page.
  var gc = (window.NATION_CONFIG && window.NATION_CONFIG.email_config) || {};
  var gcProvider = String(gc.provider || '').toLowerCase();
  var gcIsGraph  = gcProvider === 'graph';
  var gcProviderLabel = gcIsGraph ? 'Microsoft 365 (Graph)'
    : gcProvider === 'resend'   ? 'Resend'
    : gcProvider === 'sendgrid' ? 'SendGrid'
    : (gc.from ? (gcProvider || 'Email service') : 'Not configured');

  // Project ref from the Supabase URL drives the deep-link to the
  // Edge Function secrets page. Falls back to the dashboard root if
  // we can't parse the project ref.
  var projectRef = '';
  if (typeof SUPABASE_URL === 'string') {
    var m = SUPABASE_URL.match(/https:\/\/([^.]+)\.supabase\.co/);
    if (m) projectRef = m[1];
  }
  var secretsUrl = projectRef
    ? 'https://supabase.com/dashboard/project/' + projectRef + '/settings/functions'
    : 'https://supabase.com/dashboard';
  var entraUrl = 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationMenuBlade/~/Overview/appId/'
               + encodeURIComponent(gc.client_id || '');

  // Pipeline health — recent email_sent rows from the audit log.
  var health = await _renderPipelineHealth();

  var currentThreshold = ((window._appSettings && window._appSettings.rfq_threshold) || 10000);
  var currentEldersAge = ((window._appSettings && window._appSettings.eldersAgeMin) || 65);

  body.innerHTML =
      '<div class="cfg-section">'
    +   '<div class="cfg-section-title">RFQ Settings</div>'
    +   '<div class="cfg-section-sub">Configure the Request for Quotes module. Changes take effect immediately.</div>'
    +   '<div class="cfg-grid">'
    +     '<div class="cfg-row">'
    +       '<div class="cfg-label">RFQ Trigger Threshold ($)</div>'
    +       '<div class="cfg-value" style="display:flex;align-items:center;gap:8px;">'
    +         '<input type="number" id="cfg_rfq_threshold" value="' + _ntfEsc(String(currentThreshold)) + '" min="0" step="1000"'
    +         ' style="width:120px;padding:6px 10px;border:1.5px solid var(--border);border-radius:7px;font-size:13px;font-weight:700;color:var(--text);font-family:DM Sans,sans-serif;background:var(--surface);text-align:right;"/>'
    +         '<button type="button" class="btn btn-primary btn-sm" onclick="saveRfqThreshold()">Save</button>'
    +       '</div>'
    +     '</div>'
    +   '</div>'
    +   '<div style="font-size:11px;color:var(--muted);margin-top:8px;padding:0 0 4px;">Maintenance Request totals at or above this amount will show the RFQ button on the Renovations pipeline. Housing Managers and the ED can override below-threshold maintenance requests.</div>'
    + '</div>'

    + '<div class="cfg-section">'
    +   '<div class="cfg-section-title">Elders Housing</div>'
    +   '<div class="cfg-section-sub">Sets the minimum age for matching applicants to Elders-designated units.</div>'
    +   '<div class="cfg-grid">'
    +     '<div class="cfg-row">'
    +       '<div class="cfg-label">Minimum Age (years)</div>'
    +       '<div class="cfg-value" style="display:flex;align-items:center;gap:8px;">'
    +         '<input type="number" id="cfg_elders_age_min" value="' + _ntfEsc(String(currentEldersAge)) + '" min="18" max="99" step="1"'
    +         ' style="width:80px;padding:6px 10px;border:1.5px solid var(--border);border-radius:7px;font-size:13px;font-weight:700;color:var(--text);font-family:DM Sans,sans-serif;background:var(--surface);text-align:right;"/>'
    +         '<button type="button" class="btn btn-primary btn-sm" onclick="saveEldersAgeMin()">Save</button>'
    +       '</div>'
    +     '</div>'
    +   '</div>'
    +   '<div style="font-size:11px;color:var(--muted);margin-top:8px;padding:0 0 4px;">Applicants below this age will not be suggested as a best match for Elders units and cannot be scored as Elders-eligible in the housing match view.</div>'
    + '</div>'

    + '<div class="cfg-section">'
    +   '<div class="cfg-section-title">Notifications display</div>'
    +   '<div class="cfg-section-sub">How long messages stay in the corner notifications box before clearing themselves.</div>'
    +   '<div class="cfg-grid">'
    +     '<div class="cfg-row">'
    +       '<div class="cfg-label">Auto-clear after (seconds)</div>'
    +       '<div class="cfg-value" style="display:flex;align-items:center;gap:8px;">'
    +         '<input type="number" id="cfg_toast_timeout" value="' + _ntfEsc(String((window._appSettings && window._appSettings.toast_timeout_seconds != null) ? window._appSettings.toast_timeout_seconds : 10)) + '" min="0" max="600" step="1"'
    +         ' style="width:80px;padding:6px 10px;border:1.5px solid var(--border);border-radius:7px;font-size:13px;font-weight:700;color:var(--text);font-family:DM Sans,sans-serif;background:var(--surface);text-align:right;"/>'
    +         '<button type="button" class="btn btn-primary btn-sm" onclick="saveToastTimeout()">Save</button>'
    +       '</div>'
    +     '</div>'
    +   '</div>'
    +   '<div style="font-size:11px;color:var(--muted);margin-top:8px;padding:0 0 4px;">Each message clears itself this many seconds after it appears (default 10). Set <b>0</b> to keep messages until they are dismissed by hand. Applies on every page for all staff.</div>'
    + '</div>'

    + '<div class="cfg-section">'
    +   '<div class="cfg-section-title">Applicant portal (external applications)</div>'
    +   '<div class="cfg-section-sub">Community members submitting their own applications online at <b>apply.html</b>. Turning the portal off closes it completely: no sign-in links are sent and nothing can be started or submitted until it is turned back on.</div>'
    +   '<div class="cfg-grid">'
    +     '<div class="cfg-row">'
    +       '<div class="cfg-label">External applications</div>'
    +       '<div class="cfg-value" style="display:flex;align-items:center;gap:10px;">'
    +         '<label style="display:inline-flex;align-items:center;gap:8px;cursor:pointer;font-weight:700;font-size:13px;"><input type="checkbox" id="cfg_external_apps" style="width:auto;"' + (((window._appSettings && window._appSettings.external_applications_enabled) !== false) ? ' checked' : '') + '/> <span>' + (((window._appSettings && window._appSettings.external_applications_enabled) !== false) ? 'Enabled' : 'Disabled') + '</span></label>'
    +         '<button type="button" class="btn btn-primary btn-sm" onclick="saveExternalAppsEnabled()">Save</button>'
    +       '</div>'
    +     '</div>'
    +     '<div class="cfg-row">'
    +       '<div class="cfg-label">Nation number (band membership #)</div>'
    +       '<div class="cfg-value" style="display:flex;align-items:center;gap:8px;">'
    +         '<input type="text" id="cfg_nation_band" inputmode="numeric" maxlength="3" placeholder="e.g. 550" value="' + _ntfEsc(String((window._appSettings && window._appSettings.nation_band_number) || '')) + '"'
    +         ' style="width:80px;padding:6px 10px;border:1.5px solid var(--border);border-radius:7px;font-size:13px;font-weight:700;color:var(--text);font-family:DM Sans,sans-serif;background:var(--surface);text-align:right;"/>'
    +         '<button type="button" class="btn btn-primary btn-sm" onclick="saveNationBandNumber()">Save</button>'
    +       '</div>'
    +     '</div>'
    +   '</div>'
    +   '<div style="font-size:11px;color:var(--muted);margin-top:8px;padding:0 0 4px;">The nation’s 3-digit band membership number. When set, self-serve applicants must enter a 10-digit band (registry) number that <b>starts with these 3 digits</b> before they can submit — the first three digits of a registry number are always the band membership number. Leave blank to skip that verification.</div>'
    + '</div>'

    + '<div class="cfg-section">'
    +   '<div class="cfg-section-title">Email pipeline (' + _ntfEsc(gcProviderLabel) + ')</div>'
    +   '<div class="cfg-section-sub">Reference only for this nation. Update the actual secrets via the Supabase Dashboard.</div>'

    +   '<div class="cfg-grid">'
    +     _cfgRow('Provider',           gcProviderLabel)
    +     _cfgRow('FROM address',       gc.from      || '—', { mono: true, copy: true })
    +     _cfgRow('From name',          gc.from_name || '—')
    +     _cfgRow('Reply-To',           gc.reply_to  || '—', { mono: true })
    +     (gcIsGraph ? (
            _cfgRow('Entra app',        gc.app_name  || '—')
          + _cfgRow('Tenant ID',        gc.tenant_id || '—', { mono: true, copy: true })
          + _cfgRow('Client ID',        gc.client_id || '—', { mono: true, copy: true })
          ) : '')
    +     _cfgRow(gcIsGraph ? 'Client secret' : 'API key', 'Stored in Supabase secrets - not shown', { muted: true })
    +   '</div>'

    +   '<div class="cfg-health">' + health + '</div>'

    +   '<div class="cfg-actions">'
    +     '<a class="btn btn-primary" href="' + _ntfEsc(secretsUrl) + '" target="_blank" rel="noopener">Open Supabase Edge Function Secrets</a>'
    +     (gcIsGraph
          ? '<a class="btn btn-ghost" href="' + _ntfEsc(entraUrl) + '" target="_blank" rel="noopener">Open Entra App Registration</a>'
          : '')
    +   '</div>'
    + '</div>'

    + '<div class="cfg-section">'
    +   '<div class="cfg-section-title">Platform Support Access</div>'
    +   '<div class="cfg-section-sub">Controls whether ' + _ntfEsc((window.NATION_CONFIG && NATION_CONFIG.display_name) ? 'the platform operator' : 'platform support') + ' can open a signed-in support session on your app for troubleshooting. When ON, a platform super-admin can enter as a full-access &ldquo;Platform Support&rdquo; user; every entry is written to your Audit Log and the access lapses the same day. Turn OFF to refuse platform support login entirely.</div>'
    +   '<div class="cfg-grid">'
    +     '<div class="cfg-row">'
    +       '<div class="cfg-label">Allow platform support login</div>'
    +       '<div class="cfg-value" style="display:flex;align-items:center;gap:10px;">'
    +         '<label style="display:inline-flex;align-items:center;gap:8px;cursor:pointer;font-weight:700;font-size:13px;"><input type="checkbox" id="cfg_support_login" style="width:auto;"' + (((window._appSettings && window._appSettings.support_login_enabled) !== false) ? ' checked' : '') + '/> <span id="cfg_support_login_lbl">' + (((window._appSettings && window._appSettings.support_login_enabled) !== false) ? 'Enabled' : 'Disabled') + '</span></label>'
    +         '<button type="button" class="btn btn-primary btn-sm" onclick="saveSupportLoginEnabled()">Save</button>'
    +       '</div>'
    +     '</div>'
    +   '</div>'
    +   '<div style="font-size:11px;color:var(--muted);margin-top:8px;padding:0 0 4px;">Only the Executive Director can change this. Support sessions always appear in the Audit Log (action &ldquo;support_session_started&rdquo;).</div>'
    + '</div>'

    + '<div class="cfg-section">'
    +   '<div class="cfg-section-title">Duplicate Application Audit</div>'
    +   '<div class="cfg-section-sub">Scans active applications for duplicate email addresses (hard conflict) or matching name + date of birth (soft conflict). Archived and declined applications are excluded.</div>'
    +   '<div class="cfg-grid" style="margin-top:12px;">'
    +     '<div class="cfg-row">'
    +       '<div class="cfg-label">Scan for duplicates</div>'
    +       '<div class="cfg-value">'
    +         '<button type="button" class="btn btn-ghost" onclick="runDuplicateAppsAudit()">&#128269; Run Audit</button>'
    +       '</div>'
    +     '</div>'
    +   '</div>'
    +   '<div id="duplicate_apps_output" style="margin-top:14px;font-size:12px;"></div>'
    + '</div>'

    ;
}

function _cfgRow(label, value, opts) {
  opts = opts || {};
  var valClass = 'cfg-value' + (opts.mono ? ' is-mono' : '') + (opts.muted ? ' is-muted' : '');
  var copyBtn  = opts.copy
    ? ' <button type="button" class="cfg-copy" onclick="_cfgCopyValue(this)" title="Copy">&#128203;</button>'
    : '';
  return '<div class="cfg-row">'
       +   '<div class="cfg-label">' + _ntfEsc(label) + '</div>'
       +   '<div class="' + valClass + '"><span class="cfg-value-text">' + _ntfEsc(value) + '</span>' + copyBtn + '</div>'
       + '</div>';
}

function _cfgCopyValue(btn) {
  try {
    var txt = btn.parentNode.querySelector('.cfg-value-text');
    var val = txt ? (txt.textContent || '') : '';
    if (!val) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(val).then(function(){ showToast('Copied', {type:'info'}); });
    } else {
      // Fallback for older browsers
      var ta = document.createElement('textarea');
      ta.value = val; document.body.appendChild(ta);
      ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
      showToast('Copied', {type:'info'});
    }
  } catch (e) {
    console.warn('[cfg] copy failed:', e);
  }
}

// Save the RFQ trigger threshold to housing_settings.
// ED-tier gate for the Settings > Config save handlers (super_user inherits
// ED authority platform-wide). One definition — six hand-copies drifted
// before (one had even dropped super_user).
function _cfgEdGuard(msg){
  var role = window.currentRole || window._realRole;
  if (role !== 'ed' && role !== 'super_user') {
    showToast(msg || 'Only the Executive Director can change this setting', {type:'error'});
    return false;
  }
  return true;
}

function saveRfqThreshold() {
  if (!_cfgEdGuard('Only the Executive Director can change the RFQ threshold')) return;
  var inp = document.getElementById('cfg_rfq_threshold');
  if (!inp) return;
  var val = parseFloat(inp.value);
  if (isNaN(val) || val < 0) { showToast('Enter a valid dollar amount', {type:'error'}); inp.focus(); return; }
  persistSetting('rfq_threshold', val, {
    auditAction: 'rfq_threshold_save',
    auditDetail: 'RFQ threshold set to $' + val.toLocaleString(),
    okMsg:       'RFQ threshold saved — $' + val.toLocaleString()
  });
}

function saveToastTimeout() {
  if (!_cfgEdGuard('Only the Executive Director can change this setting')) return;
  var inp = document.getElementById('cfg_toast_timeout');
  if (!inp) return;
  var val = parseInt(inp.value, 10);
  if (isNaN(val) || val < 0 || val > 600) { showToast('Enter a number of seconds from 0 (never clear) to 600', {type:'error'}); inp.focus(); return; }
  persistSetting('toast_timeout_seconds', val, {
    auditAction: 'toast_timeout_save',
    auditDetail: 'Notification auto-clear set to ' + (val === 0 ? 'never (manual dismiss)' : val + 's'),
    okMsg:       val === 0 ? 'Notifications will stay until dismissed' : 'Notifications will clear after ' + val + ' seconds'
  });
}
window.saveToastTimeout = saveToastTimeout;

// Applicant portal master switch (external self-serve applications).
function saveExternalAppsEnabled() {
  if (!_cfgEdGuard('Only the Executive Director can change this setting')) return;
  var cb = document.getElementById('cfg_external_apps');
  if (!cb) return;
  var on = !!cb.checked;
  persistSetting('external_applications_enabled', on, {
    auditAction: 'external_apps_toggle',
    auditDetail: 'External (self-serve) applications turned ' + (on ? 'ON' : 'OFF'),
    okMsg:       on ? 'Applicant portal is ON — community members can apply online'
                    : 'Applicant portal is OFF — online applications are closed'
  });
  if (typeof renderConfigPanel === 'function') setTimeout(renderConfigPanel, 300);
}
window.saveExternalAppsEnabled = saveExternalAppsEnabled;

// Nation band membership number (3 digits) — enables the applicant portal's
// band-number verification: registry numbers must be 10 digits starting with
// this prefix. Blank clears the setting and disables the check.
function saveNationBandNumber() {
  if (!_cfgEdGuard('Only the Executive Director can change this setting')) return;
  var inp = document.getElementById('cfg_nation_band');
  if (!inp) return;
  var val = (inp.value || '').trim();
  if (val !== '' && !/^\d{3}$/.test(val)) { showToast('Enter the 3-digit band membership number (e.g. 192), or leave blank to disable the check', {type:'error'}); inp.focus(); return; }
  persistSetting('nation_band_number', val, {
    auditAction: 'nation_band_number_save',
    auditDetail: val ? ('Nation band number set to ' + val + ' — applicant registry numbers must be 10 digits starting with it') : 'Nation band number cleared — applicant band-number verification off',
    okMsg:       val ? ('Saved — self-serve applicants must enter a 10-digit registry number starting with ' + val) : 'Cleared — band-number verification is off'
  });
}
window.saveNationBandNumber = saveNationBandNumber;

function saveEldersAgeMin() {
  if (!_cfgEdGuard('Only the Executive Director can change this setting')) return;
  var inp = document.getElementById('cfg_elders_age_min');
  if (!inp) return;
  var val = parseInt(inp.value, 10);
  if (isNaN(val) || val < 18 || val > 99) { showToast('Enter a valid age between 18 and 99', {type:'error'}); inp.focus(); return; }
  persistSetting('eldersAgeMin', val, {
    auditAction: 'elders_age_min_save',
    auditDetail: 'Elders minimum age set to ' + val,
    okMsg:       'Elders minimum age saved — ' + val + ' yrs'
  });
}

// Toggle whether the platform operator may open a support session on this
// nation (OCAP consent switch; read server-side by the support-login function).
function saveSupportLoginEnabled() {
  if (!_cfgEdGuard('Only the Executive Director can change platform support access')) return;
  var inp = document.getElementById('cfg_support_login');
  if (!inp) return;
  var enabled = !!inp.checked;
  var lbl = document.getElementById('cfg_support_login_lbl');
  if (lbl) lbl.textContent = enabled ? 'Enabled' : 'Disabled';
  persistSetting('support_login_enabled', enabled, {
    auditAction: 'support_login_toggle',
    auditDetail: 'Platform support login ' + (enabled ? 'ENABLED' : 'DISABLED'),
    okMsg:       enabled ? 'Platform support login enabled' : 'Platform support login disabled — the operator can no longer enter'
  });
}

var _dupAuditRows = []; // retained for CSV export

function runDuplicateAppsAudit() {
  var out = document.getElementById('duplicate_apps_output');
  if (!out) return;
  var allApps = (typeof applications !== 'undefined') ? applications : [];
  var active = allApps.filter(function(a){ return a && !a.archived && a.status !== 'declined'; });

  var emailMap = {};
  active.forEach(function(a) {
    var e = (a.email||'').trim().toLowerCase();
    if (!e) return;
    if (!emailMap[e]) emailMap[e] = [];
    emailMap[e].push(a);
  });

  var nameMap = {};
  active.forEach(function(a) {
    var key = (a.fn||'').trim().toLowerCase()+'|'+(a.ln||'').trim().toLowerCase()+'|'+(a.dob||'').trim();
    if (key === '||') return;
    if (!nameMap[key]) nameMap[key] = [];
    nameMap[key].push(a);
  });

  _dupAuditRows = [];
  var seen = {};

  Object.keys(emailMap).forEach(function(e) {
    var grp = emailMap[e]; if (grp.length < 2) return;
    grp.forEach(function(a) {
      _dupAuditRows.push({ app: a, badge: seen[a.id] ? '' : 'Email' });
      seen[a.id] = true;
    });
  });
  Object.keys(nameMap).forEach(function(k) {
    var grp = nameMap[k]; if (grp.length < 2) return;
    grp.forEach(function(a) {
      if (seen[a.id]) return;
      _dupAuditRows.push({ app: a, badge: 'Name+DOB' });
      seen[a.id] = true;
    });
  });

  if (!_dupAuditRows.length) {
    out.innerHTML = '<div style="padding:10px 0;color:var(--success);font-weight:600;">&#10003; No duplicate applications found.</div>';
    return;
  }

  var rows = _dupAuditRows.map(function(r) {
    var a    = r.app;
    var name = (((a.fn||'')+' '+(a.ln||'')).trim()) || '—';
    var badgeHtml = r.badge === 'Email'
      ? '<span style="font-size:10px;font-weight:700;padding:2px 6px;border-radius:8px;background:#fee2e2;color:var(--danger);">&#128308; Email</span>'
      : r.badge === 'Name+DOB'
      ? '<span style="font-size:10px;font-weight:700;padding:2px 6px;border-radius:8px;background:var(--warn-amber-bg);color:#854d0e;">&#128993; Name+DOB</span>'
      : '';
    var appHref = 'housing.html?openApp=' + encodeURIComponent(a.id);
    return '<tr style="border-bottom:1px solid var(--border);">'
      + '<td style="padding:6px 8px;">' + badgeHtml + '</td>'
      + '<td style="padding:6px 8px;font-weight:600;">'
      +   '<a href="' + _ntfEsc(appHref) + '" style="color:var(--text);text-decoration:underline;text-underline-offset:2px;">' + _ntfEsc(name) + '</a>'
      + '</td>'
      + '<td style="padding:6px 8px;color:var(--muted);font-size:11px;">' + _ntfEsc(a.id) + '</td>'
      + '<td style="padding:6px 8px;color:var(--muted);">' + _ntfEsc(a.email||'—') + '</td>'
      + '<td style="padding:6px 8px;color:var(--muted);">' + _ntfEsc(a.dob||'—') + '</td>'
      + '<td style="padding:6px 8px;color:var(--muted);">' + _ntfEsc(a.status||'—') + '</td>'
      + '<td style="padding:6px 8px;">'
      +   '<button onclick="_dupArchiveApp(\'' + _ntfEsc(a.id).replace(/'/g,"\\'") + '\')" '
      +     'style="font-size:11px;padding:3px 10px;border:1px solid var(--danger-border);color:var(--danger);'
      +     'background:none;border-radius:6px;cursor:pointer;font-family:DM Sans,sans-serif;white-space:nowrap;">Archive</button>'
      + '</td>'
      + '</tr>';
  }).join('');

  out.innerHTML = '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">'
    + '<span style="font-size:12px;font-weight:600;color:var(--danger);">' + _dupAuditRows.length + ' duplicate application' + (_dupAuditRows.length===1?'':'s') + ' found</span>'
    + '<button onclick="exportDuplicateAppsCSV()" class="btn btn-ghost btn-sm">&#128229; Export CSV</button>'
    + '</div>'
    + '<table style="width:100%;border-collapse:collapse;font-size:12px;">'
    + '<thead><tr style="border-bottom:2px solid var(--border);background:var(--bg);">'
    + '<th style="padding:6px 8px;text-align:left;font-size:11px;">Type</th>'
    + '<th style="padding:6px 8px;text-align:left;font-size:11px;">Name</th>'
    + '<th style="padding:6px 8px;text-align:left;font-size:11px;">App ID</th>'
    + '<th style="padding:6px 8px;text-align:left;font-size:11px;">Email</th>'
    + '<th style="padding:6px 8px;text-align:left;font-size:11px;">DOB</th>'
    + '<th style="padding:6px 8px;text-align:left;font-size:11px;">Status</th>'
    + '<th style="padding:6px 8px;text-align:left;font-size:11px;">Archive</th>'
    + '</tr></thead><tbody>' + rows + '</tbody></table>';
}

function exportDuplicateAppsCSV() {
  if (!_dupAuditRows.length) { showToast('Run the audit first', {type:'info'}); return; }
  var lines = [['Type','Name','App ID','Email','DOB','Status'].map(function(h){ return '"'+h+'"'; }).join(',')];
  _dupAuditRows.forEach(function(r) {
    var a = r.app;
    var esc = function(v){ return '"' + String(v==null?'':v).replace(/"/g,'""') + '"'; };
    lines.push([esc(r.badge), esc(((a.fn||'')+' '+(a.ln||'')).trim()), esc(a.id), esc(a.email||''), esc(a.dob||''), esc(a.status||'')].join(','));
  });
  var blob = new Blob([lines.join('\r\n')], { type: 'text/csv' });
  var url  = URL.createObjectURL(blob);
  var link = document.createElement('a');
  link.href = url; link.download = 'duplicate_applications_' + new Date().toISOString().slice(0,10) + '.csv';
  document.body.appendChild(link); link.click();
  document.body.removeChild(link); URL.revokeObjectURL(url);
}

function _dupArchiveApp(appId) {
  if (typeof showConfirm !== 'function') return;
  showConfirm({
    title:       'Archive as Duplicate?',
    message:     'This will archive application ' + appId + ' and mark it as a duplicate. This can be undone by an administrator.',
    confirmText: 'Archive',
    danger:      true
  }).then(function(ok) {
    if (!ok) return;
    var allApps = (typeof applications !== 'undefined') ? applications : [];
    var app = allApps.find(function(a){ return a && a.id === appId; });
    if (!app) { showToast('Application not found', {type:'error'}); return; }
    app.archived     = true;
    app.declineReason = (app.declineReason ? app.declineReason + '; ' : '') + 'Archived as duplicate';
    if (typeof saveApplicationWithDraftFallback === 'function') saveApplicationWithDraftFallback(app);
    if (typeof auditEntry === 'function') auditEntry(appId, 'archived_duplicate', 'Application archived as duplicate from audit tool', window.currentRole||'staff');
    showToast('Application archived', {type:'info'});
    runDuplicateAppsAudit();
  });
}

// Pipeline health card — queries housing_audit_log for recent email_sent
// rows. Best-effort: any error renders as "status unknown" so the panel
// stays usable when the API is unreachable.
async function _renderPipelineHealth() {
  try {
    var sinceIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    // The Edge Function writes detail as "Email -> <recipient> | <subject>".
    // Filtering by entity_type='notification' misses real sends because the
    // function uses the passed entity_type (application, sow, etc.) when
    // available and only falls back to 'notification' when none is provided.
    var url = SUPABASE_URL + '/rest/v1/housing_audit_log'
            + '?select=created_at,action,detail,actor'
            + '&detail=like.' + encodeURIComponent('Email -> %')
            + '&created_at=gte.' + encodeURIComponent(sinceIso)
            + '&order=created_at.desc&limit=50';
    var r = await fetch(url, { headers: HOUSING_HEADERS });
    if (!r.ok) return _healthBlock('unknown', 'Could not load recent send history.');
    var rows = await r.json();
    if (!rows.length) return _healthBlock('warn', 'No sends in the last 7 days.');
    var last = rows[0];
    var when = new Date(last.created_at);
    var ageMin = Math.round((Date.now() - when.getTime()) / 60000);
    var ageLabel = ageMin < 60 ? (ageMin + ' min ago')
                 : ageMin < 1440 ? (Math.round(ageMin / 60) + ' h ago')
                 : (Math.round(ageMin / 1440) + ' d ago');
    return _healthBlock('ok',
        '<strong>Last send:</strong> ' + _ntfEsc(when.toLocaleString()) + ' (' + ageLabel + ')'
      + (last.actor ? ' &mdash; by ' + _ntfEsc(last.actor) : '') + '<br/>'
      + '<span style="font-size:11px;color:var(--muted);">' + _ntfEsc(last.action || '') + ' &nbsp;&bull;&nbsp; ' + _ntfEsc(last.detail || '') + '</span><br/>'
      + '<span class="cfg-health-meta">' + rows.length + ' send' + (rows.length === 1 ? '' : 's') + ' in the last 7 days.</span>');
  } catch (e) {
    console.warn('[cfg] pipeline health load failed:', e);
    return _healthBlock('unknown', 'Could not load recent send history.');
  }
}

function _healthBlock(level, html) {
  var cls = 'cfg-health-box cfg-health-' + level;
  var icon = level === 'ok' ? '&#9989;' : level === 'warn' ? '&#9888;&#65039;' : '&#10067;';
  return '<div class="' + cls + '">'
       +   '<div class="cfg-health-icon">' + icon + '</div>'
       +   '<div class="cfg-health-body">' + html + '</div>'
       + '</div>';
}


// ════════════════════════════════════════════════════════════════════════
// Settings → Terms & Conditions tab
// ────────────────────────────────────────────────────────────────────────
// Two-column layout mirroring the Notifications tab:
//   Left  - document list (Housing Application T&C, Work Order T&C)
//   Right - rich text editor (toolbar + contenteditable body)
// Saved to housing_settings key='terms_and_conditions' as
//   { housing_application: { bodyHtml: '...' }, work_order: { bodyHtml: '...' } }
// Loaded automatically at boot alongside all other settings rows.
// Public accessor: getTermsBody(docKey) - used by PDF generators.
// ════════════════════════════════════════════════════════════════════════

var TERMS_DOCS_REGISTRY = [
  {
    key:         'housing_application',
    label:       'Housing Application — Terms & Conditions',
    description: 'Printed on the applicant declaration page of every housing application PDF.',
    defaultBody: '<p>By signing below, I hereby apply for housing assistance from the {nationName} ({nationShort}) Housing Program and declare the following:</p>'
               + '<ol>'
               + '<li><strong>Truthful Information.</strong> All information provided in this application is true, accurate, and complete to the best of my knowledge. I understand that providing false or misleading information may result in immediate disqualification, removal from the housing waitlist, and — where tenancy has already commenced — may constitute grounds for termination of my housing agreement.</li>'
               + '<li><strong>Eligibility.</strong> I confirm that I am a registered Band member of {nationName}, am 18 years of age or older, and meet the eligibility requirements set out in the {nationShort} Housing Policy. I understand that all registered Band members are eligible regardless of on- or off-reserve residency, and that ownership of property off-reserve does not affect my eligibility.</li>'
               + '<li><strong>Privacy and Consent.</strong> I consent to {nationShort} collecting, using, retaining, and sharing my personal information for the purpose of assessing this application, administering housing services, and meeting reporting obligations, in accordance with PIPEDA and the OCAP® principles of the First Nations Information Governance Centre (FNIGC).</li>'
               + '<li><strong>Assessment and Priority.</strong> I understand that my application will be assessed against the criteria set out in the {nationShort} Housing Policy, and that placement priority is determined by assessed need and unit availability — not by date of application alone.</li>'
               + '<li><strong>Duty to Update.</strong> I agree to notify the {nationShort} Housing Department within thirty (30) days of any change in household composition, income, employment, address, contact information, or any other matter that may affect my eligibility or assessment. Failure to notify may result in re-assessment or removal from the waitlist.</li>'
               + '<li><strong>Arrears and Good Standing.</strong> I understand that I must be in good standing with {nationShort}, or actively working toward good standing through a written payment arrangement approved by the Housing Department, as a condition of placement. I acknowledge that {nationShort} follows a supportive arrears model providing up to twelve (12) months under a payment arrangement before eviction proceedings may be initiated, and that the minimum monthly payment under such an arrangement is regular rent plus fifty percent (50%) of monthly rent applied against arrears.</li>'
               + '<li><strong>Utilities and Band Payment Recovery.</strong> I authorize {nationShort} to recover unpaid utilities, rent, damage charges, or other housing-related debts from any monetary payments administered by the Band to me, including but not limited to per capita distributions, honoraria, and program benefits, as provided under the {nationShort} Housing Policy.</li>'
               + '<li><strong>Compliance.</strong> I agree to comply with the {nationShort} Housing Policy, my Housing Agreement or lease, the Governance and Administration Policy, and all applicable community by-laws as a condition of tenancy.</li>'
               + '<li><strong>Verification.</strong> I authorize {nationShort} to verify any information provided in this application with relevant third parties, including employers, financial institutions, utility providers, previous landlords, and other First Nations housing authorities where applicable.</li>'
               + '<li><strong>Acknowledgement of Policy.</strong> I acknowledge that I have been offered access to the current {nationShort} Housing Policy and Governance and Administration Policy, and that I am responsible for familiarizing myself with their contents.</li>'
               + '</ol>'
  },
  {
    key:         'work_order',
    label:       'Work Order — Terms & Conditions',
    description: 'Printed in the Work Authorization section of every contractor work order PDF.',
    defaultBody: '<p>By accepting this Work Order, the contractor agrees to the following terms and conditions:</p>'
               + '<ol>'
               + '<li><strong>Authorized Scope.</strong> The contractor is authorized to perform only the work described in this Work Order. Any additional work or changes to scope require prior written approval from {nationShort} Housing before work commences.</li>'
               + '<li><strong>Invoicing.</strong> All invoices must reference this Work Order number and the unit address. Payment is subject to satisfactory completion and inspection by {nationShort} Housing staff.</li>'
               + '<li><strong>Quality and Standards.</strong> All work must be performed in a good and workmanlike manner, in compliance with applicable building codes, health and safety regulations, and {nationShort} Housing standards.</li>'
               + '<li><strong>Timeline.</strong> Work must commence and be completed within the dates specified in this Work Order. Any anticipated delays must be reported promptly to {nationShort} Housing in writing before the affected date.</li>'
               + '<li><strong>Workplace Safety and Insurance.</strong> The contractor assumes full responsibility for workplace safety and must maintain current WSIB clearance and general liability insurance throughout the project. Certificates must be provided to {nationShort} Housing upon request.</li>'
               + '<li><strong>Deficiencies.</strong> The contractor is responsible for correcting any deficiencies identified during inspection at no additional cost to {nationShort}.</li>'
               + '<li><strong>Compliance.</strong> The contractor must comply with all applicable federal, provincial, and First Nations regulations, as well as {nationShort} community by-laws, while on-reserve.</li>'
               + '</ol>'
  },
  {
    key:         'sow_reno_request',
    label:       'Maintenance Request — Terms & Conditions',
    description: 'Printed on the Terms & Conditions section of the Maintenance Request sent to tenants.',
    defaultBody: '<p>By submitting this renovation request, I acknowledge and agree to the following:</p>'
               + '<ol>'
               + '<li><strong>Prioritization of Requests.</strong> Renovation requests are assessed and prioritized based on urgency of need, health and safety risk to occupants, and overall unit condition. Immediate hazards — structural, electrical, plumbing, fire safety, or matters affecting habitability — take priority over general maintenance and cosmetic work.</li>'
               + '<li><strong>Funding Eligibility and Unit Qualifying Criteria.</strong> Approval is subject to available funding and the qualifying criteria of the unit under its applicable program (e.g. ISC, CMHC Section 95, or Band-funded). Funding availability and program restrictions may affect the scope, cost ceiling, materials, or timing of approved work.</li>'
               + '<li><strong>Budget Authority and Approval Routing.</strong> Requests within the Housing Manager\'s approved budget authority may be approved by the Housing Manager. Requests exceeding that threshold require Executive Director approval, and requests beyond the Executive Director\'s authority require Chief and Council approval by Band Council Resolution before work commences. No work begins until all required approvals are documented in writing.</li>'
               + '<li><strong>Tenant Responsibilities.</strong> The tenant must provide timely and reasonable access to the unit for inspection, assessment, and the performance of work, in accordance with the {nationShort} Housing Policy. Failure to permit reasonable access may result in the request being delayed, deprioritized, or closed.</li>'
               + '<li><strong>Tenant Neglect and Cost Recovery.</strong> Damage or unsafe conditions arising from willful damage, misuse, failure to report issues in a timely manner, or tenant neglect may reduce the priority of the request and may result in the tenant being financially responsible for all or part of the repair cost. Outstanding charges may be recovered through the Band payment recovery provisions of the {nationShort} Housing Policy, including from rent, per capita distributions, honoraria, or other monetary payments administered by the Band.</li>'
               + '<li><strong>Good Standing.</strong> Non-emergency renovation work may be conditional on the tenant being in good standing with {nationShort}, or actively working toward good standing through a written payment arrangement approved by the Housing Department. Emergency health and safety work will not be withheld on the basis of arrears.</li>'
               + '<li><strong>No Guarantee of Approval or Timeline.</strong> Submission of a request does not guarantee approval or a specific completion date. Decisions will be communicated in writing. Priority and scheduling may be adjusted based on available resources, weather, contractor availability, and emerging urgent community needs.</li>'
               + '<li><strong>Maintenance Request and Change Orders.</strong> Approved work will be performed in accordance with the documented maintenance request. Any additions, deletions, or substantive changes require a written change order approved through the same approval routing as the original request before that work is undertaken.</li>'
               + '<li><strong>Procurement and Contractors.</strong> All contractors performing work must meet {nationShort} procurement, insurance, and WSIB requirements. Tenants may not engage contractors directly on behalf of {nationShort}, and unauthorized work will not be reimbursed.</li>'
               + '<li><strong>Accuracy of Information.</strong> All information provided in this request must be accurate and complete. False or misleading information may result in the request being cancelled, delayed, or referred for further review.</li>'
               + '<li><strong>Privacy and Consent.</strong> I consent to {nationShort} collecting, using, and retaining information related to this request — including photographs, inspection notes, and contractor records — for the purpose of assessing, performing, and documenting the work, in accordance with PIPEDA and OCAP® principles.</li>'
               + '<li><strong>Compliance with Policy.</strong> I agree that all renovation work and related obligations are governed by the {nationShort} Housing Policy, my Housing Agreement or lease, and applicable community by-laws.</li>'
               + '</ol>'
  },
  {
    key:         'rfq_terms',
    label:       'Request for Quotes (RFQ) — Terms & Conditions',
    description: 'Printed in the Terms & Conditions section of every RFQ document issued to contractors.',
    defaultBody: '<p>By submitting a bid in response to this Request for Quotes, the contractor agrees to the following terms and conditions:</p>'
               + '<ol>'
               + '<li><strong>Bid Validity.</strong> All bids submitted in response to this RFQ shall remain valid and irrevocable for a minimum of sixty (60) calendar days from the bid closing date.</li>'
               + '<li><strong>Compliance with Scope.</strong> Bids must address the full maintenance request as described. Partial bids will not be considered unless explicitly invited in writing.</li>'
               + '<li><strong>WSIB and Insurance.</strong> The contractor must provide a current WSIB clearance certificate and proof of general liability insurance (minimum $2,000,000) with this bid. Failure to include these documents will result in disqualification.</li>'
               + '<li><strong>No Award Guarantee.</strong> Submission of a bid does not guarantee award. {nationName} reserves the right to reject any or all bids, to cancel this RFQ at any time, and to award the work to the contractor deemed most advantageous to the community, price and other factors considered.</li>'
               + '<li><strong>Indigenous Preference.</strong> In accordance with the {nationShort} Housing Policy, preference will be given to Indigenous-owned and {nationShort}-member-owned businesses where qualifications and price are competitive.</li>'
               + '<li><strong>Confidentiality.</strong> All bid information submitted is confidential and will not be disclosed to other bidders.</li>'
               + '<li><strong>Accuracy.</strong> All information submitted must be accurate and complete. Misrepresentation will result in immediate disqualification and may affect future eligibility.</li>'
               + '<li><strong>Governing Authority.</strong> This RFQ and any resulting contract are governed by the inherent jurisdiction of {nationName} and applicable federal and provincial law.</li>'
               + '</ol>'
  }
];

function _termsDocConfig(docKey) {
  for (var i = 0; i < TERMS_DOCS_REGISTRY.length; i++) {
    if (TERMS_DOCS_REGISTRY[i].key === docKey) return TERMS_DOCS_REGISTRY[i];
  }
  return null;
}

// Nation-identity token substitution for T&C bodies. The registry defaults
// use {nationName}/{nationShort} instead of hardcoded nation literals
// (HARD RULE); values resolve from NATION_CONFIG via the shared-config
// accessors, so rendered output for the configured nation is unchanged.
// Idempotent and safe on saved bodies (plain text passes through untouched).
function _termsApplyNationTokens(html) {
  if (!html) return html || '';
  var name  = (typeof nationDisplay === 'function') ? nationDisplay()
            : ((window.NATION_CONFIG && (NATION_CONFIG.display_name || NATION_CONFIG.name)) || '');
  var short = (typeof nationShort === 'function') ? nationShort()
            : ((window.NATION_CONFIG && NATION_CONFIG.short) || '');
  return String(html).replace(/\{nationName\}/g, name).replace(/\{nationShort\}/g, short);
}

// Public accessor for PDF generators. Falls back to the registry default
// when no ED override has been saved yet. Nation tokens are substituted on
// the way out so no consumer ever renders raw {nationName}/{nationShort}.
function getTermsBody(docKey) {
  var saved = (window._appSettings && window._appSettings.terms_and_conditions
            && window._appSettings.terms_and_conditions[docKey]) || {};
  if (saved.bodyHtml != null && saved.bodyHtml !== '') return _termsApplyNationTokens(saved.bodyHtml);
  var cfg = _termsDocConfig(docKey);
  return cfg ? _termsApplyNationTokens(cfg.defaultBody) : '';
}

var _termsSelectedDoc = null;

function renderTermsTab() {
  var body = document.getElementById('terms_panel_body');
  if (!body) return;

  if (!_termsSelectedDoc) _termsSelectedDoc = TERMS_DOCS_REGISTRY[0] && TERMS_DOCS_REGISTRY[0].key;

  body.innerHTML =
      '<div class="ntf-grid">'
    +   '<div class="ntf-event-list" id="terms_doc_list">' + _termsRenderDocListHtml() + '</div>'
    +   '<div class="ntf-editor"     id="terms_editor">'   + _termsRenderEditorHtml(_termsSelectedDoc) + '</div>'
    + '</div>';

  _termsWireDocListClicks();
  _termsWireEditor();
}

function _termsRenderDocListHtml() {
  return TERMS_DOCS_REGISTRY.map(function(doc) {
    var isActive = doc.key === _termsSelectedDoc;
    return '<button type="button" data-terms-doc="' + _ntfEsc(doc.key) + '" '
         + 'class="ntf-event-item' + (isActive ? ' is-active' : '') + '">'
         + '<span class="ntf-dot ntf-dot-on" title="Active"></span>'
         + '<div class="ntf-event-text">'
         +   '<div class="ntf-event-label">' + _ntfEsc(doc.label) + '</div>'
         +   '<div class="ntf-event-desc">'  + _ntfEsc(doc.description || '') + '</div>'
         + '</div>'
         + '</button>';
  }).join('');
}

function _termsRenderEditorHtml(docKey) {
  var cfg = _termsDocConfig(docKey);
  if (!cfg) return '<div class="empty-state-italic">Select a document from the list to edit it.</div>';

  var saved    = (window._appSettings && window._appSettings.terms_and_conditions
               && window._appSettings.terms_and_conditions[docKey]) || {};
  // Default bodies carry {nationName}/{nationShort} tokens — resolve them so
  // the ED edits (and saves) the real nation wording, never raw tokens.
  var bodyHtml = (saved.bodyHtml != null && saved.bodyHtml !== '') ? saved.bodyHtml : _termsApplyNationTokens(cfg.defaultBody);

  var toolbar =
      '<div class="ntf-toolbar" role="toolbar" aria-label="Formatting">'
    +   '<button type="button" class="ntf-tool" data-ntf-cmd="bold"                title="Bold (Ctrl+B)"><b>B</b></button>'
    +   '<button type="button" class="ntf-tool" data-ntf-cmd="italic"              title="Italic (Ctrl+I)"><i>I</i></button>'
    +   '<button type="button" class="ntf-tool" data-ntf-cmd="underline"           title="Underline (Ctrl+U)"><u>U</u></button>'
    +   '<span class="ntf-tool-sep"></span>'
    +   '<button type="button" class="ntf-tool" data-ntf-cmd="formatBlock-p"       title="Paragraph">&para;</button>'
    +   '<button type="button" class="ntf-tool" data-ntf-cmd="insertUnorderedList" title="Bulleted list">&bull;</button>'
    +   '<button type="button" class="ntf-tool" data-ntf-cmd="insertOrderedList"   title="Numbered list">1.</button>'
    +   '<span class="ntf-tool-sep"></span>'
    +   '<button type="button" class="ntf-tool" data-ntf-cmd="createLink"          title="Insert link">&#128279;</button>'
    +   '<button type="button" class="ntf-tool" data-ntf-cmd="unlink"              title="Remove link">&#10005;&#128279;</button>'
    + '</div>';

  return ''
    + '<div class="ntf-editor-header">'
    +   '<div class="ntf-editor-title">' + _ntfEsc(cfg.label) + '</div>'
    +   '<div class="ntf-editor-meta">Paste from Word supported &mdash; formatting is preserved, styles are stripped.</div>'
    + '</div>'
    + '<div class="ntf-field">'
    +   '<label class="ntf-label">Body</label>'
    +   toolbar
    +   '<div id="terms_body" class="ntf-body" contenteditable="true">' + bodyHtml + '</div>'
    + '</div>'
    + '<div class="ntf-actions">'
    +   '<button type="button" class="btn btn-primary" onclick="saveTermsDoc()">Save</button>'
    +   '<button type="button" class="btn btn-ghost"   onclick="resetTermsDoc()">Reset to Default</button>'
    + '</div>';
}

function _termsWireDocListClicks() {
  var list = document.getElementById('terms_doc_list');
  if (!list) return;
  list.querySelectorAll('[data-terms-doc]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      _termsSelectedDoc = btn.getAttribute('data-terms-doc');
      list.innerHTML = _termsRenderDocListHtml();
      var ed = document.getElementById('terms_editor');
      if (ed) ed.innerHTML = _termsRenderEditorHtml(_termsSelectedDoc);
      _termsWireDocListClicks();
      _termsWireEditor();
    });
  });
}

function _termsWireEditor() {
  var editorEl = document.getElementById('terms_editor');
  var bodyEl   = document.getElementById('terms_body');
  if (!editorEl || !bodyEl) return;

  // Scope toolbar wiring to this editor container so it targets terms_body,
  // not ntf_body, even when both sections have been rendered.
  editorEl.querySelectorAll('.ntf-tool').forEach(function(btn) {
    if (btn.getAttribute('data-ntf-bound') === '1') return;
    btn.setAttribute('data-ntf-bound', '1');
    btn.addEventListener('mousedown', function(e) { e.preventDefault(); });
    btn.addEventListener('click', function(e) {
      e.preventDefault();
      _ntfRunToolbarCmd(btn.getAttribute('data-ntf-cmd'), bodyEl);
    });
  });

  // Paste handler: strip Word MSO styles on paste, preserve semantic markup.
  if (!bodyEl.getAttribute('data-paste-wired')) {
    bodyEl.setAttribute('data-paste-wired', '1');
    bodyEl.addEventListener('paste', function(e) {
      e.preventDefault();
      var html = (e.clipboardData && e.clipboardData.getData('text/html')) || '';
      if (!html) {
        var text = (e.clipboardData && e.clipboardData.getData('text/plain')) || '';
        html = '<p>' + text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
                           .replace(/\n\n+/g,'</p><p>').replace(/\n/g,'<br>') + '</p>';
      }
      document.execCommand('insertHTML', false, _ntfSanitizeBodyHtml(html));
    });
  }
}

function saveTermsDoc() {
  if (!_cfgEdGuard('Only the Executive Director can edit terms & conditions')) return;
  if (!_termsSelectedDoc) { showToast('Select a document first', {type:'error'}); return; }

  var bodyEl = document.getElementById('terms_body');
  if (!bodyEl) { showToast('Editor not ready', {type:'info'}); return; }

  var bodyHtml = _ntfSanitizeBodyHtml(bodyEl.innerHTML || '');
  if (!bodyHtml || bodyHtml === '<br>' || bodyHtml.replace(/<[^>]+>/g, '').trim() === '') {
    showToast('Body cannot be empty', {type:'error'}); bodyEl.focus(); return;
  }

  var all  = (window._appSettings && window._appSettings.terms_and_conditions) || {};
  var next = Object.assign({}, all);
  next[_termsSelectedDoc] = { bodyHtml: bodyHtml };

  persistSetting('terms_and_conditions', next, {
    auditAction: 'terms_save',
    auditDetail: 'Terms & Conditions updated: ' + _termsSelectedDoc,
    okMsg:       '✓ Terms & Conditions saved'
  });
}

function resetTermsDoc() {
  if (!_termsSelectedDoc) return;
  var cfg    = _termsDocConfig(_termsSelectedDoc);
  var bodyEl = document.getElementById('terms_body');
  if (cfg && bodyEl) bodyEl.innerHTML = _termsApplyNationTokens(cfg.defaultBody);
  showToast('Reverted to default. Click Save to persist.', {type:'info'});
}

// Parse saved T&C HTML into parts for both renderers.
// Returns:
//   intro     — plain text of the opening paragraph (for jsPDF)
//   introHtml — innerHTML of the opening paragraph (for HTML print)
//   items     — plain text of each <li> (for jsPDF numbered list)
//   itemsHtml — innerHTML of each <li>, preserving <strong> etc. (for HTML print)
function _termsParseHtml(html) {
  var result = { intro: '', introHtml: '', items: [], itemsHtml: [] };
  if (!html) return result;
  try {
    var doc  = new DOMParser().parseFromString('<div id="r">' + html + '</div>', 'text/html');
    var root = doc.getElementById('r');
    if (!root) return result;
    var nodes = Array.prototype.slice.call(root.childNodes);
    nodes.forEach(function(node) {
      if (!node.tagName) return;
      var tag = node.tagName.toUpperCase();
      if ((tag === 'P' || tag === 'DIV') && !result.intro) {
        result.intro    = (node.textContent || '').trim();
        result.introHtml = node.innerHTML || '';
      } else if (tag === 'OL' || tag === 'UL') {
        var lis = node.querySelectorAll('li');
        lis.forEach(function(li) {
          var text = (li.textContent || '').trim();
          if (text) {
            result.items.push(text);
            result.itemsHtml.push(li.innerHTML || text);
          }
        });
      }
    });
  } catch (e) {
    console.warn('[terms] parse failed:', e);
  }
  return result;
}

// ════════════════════════════════════════════════════════════════════════════
// Contracts & Agreements tab
// ────────────────────────────────────────────────────────────────────────────
// Saved to housing_settings key='contracts_agreements' as
//   { residential_lease: { bodyHtml: '...', initials_clauses: [{id,label,text}] } }
// Public accessors: getContractBody(key), getContractClauses(key)
// jsPDF HTML renderer (_parseHtmlToBlocks / _renderBlocksToPdf) is also
// exported here and called by the rewritten _ticGenerateLeasePdf() in
// housing-tic.js.
// ════════════════════════════════════════════════════════════════════════════

var _CONTRACT_DEFAULT_CLAUSES = [
  {
    id:    'ls_init_drug',
    label: 'Section 2(c)–(g) — Smoking, Cannabis & Drug Provisions',
    text:  'The Residence is a smoking-permitted environment. Cannabis cultivation, production, and processing in any quantity is strictly prohibited as a condition of this Agreement regardless of federal legality. Any breach of the cannabis prohibition constitutes immediate grounds for termination without a cure period. Unlawful drug activity — including possession, production, trafficking, or storage of controlled substances — also constitutes immediate grounds for termination. The Tenant acknowledges full liability for all remediation costs arising from smoking damage, cannabis cultivation, or prohibited drug activity on the premises.'
  },
  {
    id:    'ls_init_3_3',
    label: "Section 3.3 — First Month's Rent",
    text:  "The Tenant shall pay the first month's rent in full on or before the commencement date of this Agreement. No occupancy shall commence until the first month's rent is paid in full."
  },
  {
    id:    'ls_init_3_4a',
    label: 'Section 3.4 — Late Payment Fee',
    text:  "Where any rent payment remains unpaid fifteen (15) days past the due date, a late payment fee of $25.00 shall be added to the Tenant's account. This fee is in addition to the outstanding rent and is recoverable as arrears."
  },
  {
    id:    'ls_init_3_4b',
    label: 'Section 3.4 — NSF Fee',
    text:  "Where a cheque or pre-authorized debit is returned by the financial institution for insufficient funds, a $45.00 NSF (Non-Sufficient Funds) fee shall be added to the Tenant's account, in addition to any charges imposed by the financial institution. Repeated NSF occurrences may result in a change of required payment method."
  },
  {
    id:    'ls_init_juris',
    label: 'Section 21 — Acknowledgement of Jurisdiction',
    text:  'This Agreement is governed by the inherent jurisdiction of {nationName} and the Indian Act, R.S.C. 1985, c. I-5. The Ontario Residential Tenancies Act, 2006 does not apply to this Agreement. Any dispute arising under this Agreement shall be addressed through the internal grievance process established by the {nationName} Housing Policy, and where unresolved, through the Ontario Superior Court of Justice as a matter of contract law.'
  }
];

// ── RFQ bid document — editable strings ──────────────────────────────────────
// Every fixed string in the RFQ bid document (headings, bid-form labels/columns,
// cost-breakdown labels, mandatory-inclusions list, submission text). Defaults
// equal the current hard-coded text, so the document is unchanged until an ED
// edits it in Settings -> Contracts -> RFQ Bid Document. Both generators
// (buildRfqDocumentHtml in shared-data.js + _generateRfqPdfBase64 here) read
// these via _rfqDocStr()/_rfqDocList(). Saved overrides live in
// _appSettings.rfq_document (housing_settings key 'rfq_document').
var RFQ_DOC_DEFAULTS = {
  h_project:            'Project Details',
  h_scope:             'Scope of Work',
  h_bidform:           'Contractor Bid Form — Complete and Return',
  bidform_intro:       'Price all line items below in CDN dollars, exclusive of HST. Print, complete by hand, sign, and return with your supporting documents.',
  bidform_print_note:  'This form has been provided as a read-only document. Please print it, complete all fields by hand, sign where required, and submit the completed form with your supporting documents. You may also attach a separate quote in your own format — this form must still accompany it.',
  col_lineitem:        'Line Item / Description',
  col_unitprice:       'Unit Price ($)',
  col_extended:        'Extended Price ($)',
  col_notes:           'Notes',
  total_bid_amount:    'TOTAL BID AMOUNT:',
  h_breakdown:         'Bid Cost Breakdown',
  breakdown_intro:     'break your total bid out by category (CDN, exclusive of HST). The total must equal the Total Bid Amount above.',
  breakdown_col_cat:   'Category',
  breakdown_col_amt:   'Amount ($)',
  breakdown_categories:['Materials', 'Labour', 'Equipment', 'Subcontractors', 'Other'],
  breakdown_total:     'TOTAL BID:',
  labour_hours_label:  'Estimated total labour hours:',
  h_mandatory:         'Mandatory Inclusions',
  mandatory_intro:     'The following documents must be included with your bid. Incomplete packages will not be considered.',
  // {short} = nation short code, {nation} = full name (substituted at render).
  mandatory_items:     [
    'Current WSIB clearance certificate',
    'Certificate of general liability insurance (minimum $2,000,000 per occurrence)',
    'List of at least two comparable completed projects (name, owner, value, completion date)',
    'If new to working with {short} Housing: at least two project references with complete contact information',
    'If using subcontractors: complete list with contact info, WSIB certificate, and proof of $2M+ liability insurance for each',
    'Proposed project start date and estimated completion timeline',
    'Fully completed bid form (above) with all line items priced'
  ],
  h_submission:        'Submission Instructions',
  h_authorization:     'Authorization'
};
// String accessor — saved override, else the default.
function _rfqDocStr(key) {
  var o = (window._appSettings && window._appSettings.rfq_document) || {};
  var v = o[key];
  return (v != null && v !== '') ? String(v) : (RFQ_DOC_DEFAULTS[key] != null ? String(RFQ_DOC_DEFAULTS[key]) : '');
}
// List accessor (mandatory items / breakdown categories) — saved override, else default.
function _rfqDocList(key) {
  var o = (window._appSettings && window._appSettings.rfq_document) || {};
  var v = o[key];
  if (Array.isArray(v) && v.length) return v.slice();
  return (RFQ_DOC_DEFAULTS[key] || []).slice();
}
// Substitute nation tokens in an editable RFQ-document string.
function _rfqDocSub(s) {
  var nc = window.NATION_CONFIG || {};
  var shortC = (typeof nationShort === 'function') ? nationShort() : (nc.short || '');
  var disp   = nc.display_name || nc.name || shortC;
  return String(s == null ? '' : s).replace(/\{short\}/g, shortC).replace(/\{nation\}/g, disp);
}
window._rfqDocStr = _rfqDocStr;
window._rfqDocList = _rfqDocList;
window._rfqDocSub = _rfqDocSub;

// Hide signature sections on generated documents (RFQ bid doc, contractor
// contract, SOW/maintenance-request doc, work order). The housing APPLICATION
// document always keeps its signatures and is never gated by this. Toggle in
// Settings -> Contracts. Saved to housing_settings key 'hide_signatures'.
function _docSigsHidden() { return !!(window._appSettings && window._appSettings.hide_signatures); }
window._docSigsHidden = _docSigsHidden;

var CONTRACTS_DOCS_REGISTRY = [
  {
    key:         'residential_lease',
    label:       'Residential Lease Agreement',
    description: 'Full lease agreement generated when onboarding a new tenant. Supports {token} substitution for tenant-specific data.',
    defaultBody:
        '<h2>{nationName} Housing Program</h2>'
      + '<h1>Residential Lease Agreement</h1>'
      + '<p>This Agreement is made on the <strong>{executionDay}</strong> day of <strong>{executionMonth}</strong>, <strong>{executionYear}</strong>.</p>'
      + '<h3>Parties</h3>'
      + '<p><strong>Landlord:</strong> {nationName} (hereinafter "the Landlord" or "the Nation")</p>'
      + '<p><strong>Tenant:</strong> {tenantName} (hereinafter "the Tenant")</p>'
      + '<p><strong>Co-Tenant:</strong> {coTenantName}</p>'
      + '<h3>1. Premises</h3>'
      + '<p>The Landlord hereby leases to the Tenant the residential premises located at Lot {residenceLot}, {residenceStreet} on the reserve lands of {nationName} (the "Residence"). Unit type: {residenceBedBath}. Housing stream: {residenceStream}. Allocation date: {residenceAllocDate}.</p>'
      + '<h3>2. Term</h3>'
      + '<p>The tenancy commences on {termStartDate} and continues on a month-to-month basis until terminated in accordance with the {nationName} Housing Policy.</p>'
      + '<h3>3. Rent</h3>'
      + '<p>The Tenant shall pay rent of <strong>{rentAmount}</strong> per month, due on or before the first day of each month. Payments shall be made to the {nationName} Housing Department by pre-authorized debit, cheque, or such other method as approved in writing.</p>'
      + '<h3>4. Authorized Occupants</h3>'
      + '<p>The following persons are authorized to reside in the Residence in addition to the Tenant: {occupant1Name} {occupant2Name} {occupant3Name} {occupant4Name} {occupant5Name} {occupant6Name}. No other person may occupy the Residence without prior written consent of the Landlord.</p>'
      + '<h3>5. Tenant Responsibilities</h3>'
      + '<ol>'
      + '<li>Maintain the Residence in a clean, safe, and habitable condition.</li>'
      + '<li>Report any required repairs or maintenance to the {nationName} Housing Department promptly.</li>'
      + '<li>Not cause or permit damage beyond normal wear and tear.</li>'
      + '<li>Not sublet or assign the Residence without prior written consent of the Landlord.</li>'
      + '<li>Comply with the {nationName} Housing Policy, community by-laws, and all applicable laws.</li>'
      + '<li>Permit the Landlord reasonable access for inspections and repairs with reasonable notice, except in emergencies.</li>'
      + '</ol>'
      + '<h3>6. Smoking, Cannabis &amp; Drug Provisions</h3>'
      + '<p>Cannabis cultivation, production, and processing is strictly prohibited on the premises. Unlawful drug activity constitutes grounds for immediate termination. The Tenant is liable for all remediation costs arising from prohibited activity. <em>(Tenant initials required — see Initials Clauses.)</em></p>'
      + '<h3>7. Landlord Responsibilities</h3>'
      + '<ol>'
      + '<li>Provide the Residence in a habitable condition at commencement of the tenancy.</li>'
      + '<li>Maintain the structural integrity of the Residence and attend to necessary repairs within a reasonable time.</li>'
      + '<li>Provide 24 hours notice before entering the Residence except in emergencies.</li>'
      + '</ol>'
      + '<h3>8. Termination</h3>'
      + '<p>Either party may terminate this Agreement by providing written notice in accordance with the {nationName} Housing Policy. The Nation may terminate immediately for material breach including non-payment of rent, unauthorized occupants, damage, or prohibited activity.</p>'
      + '<h3>9. Recovery of Amounts Owing</h3>'
      + '<p>The Tenant authorizes {nationName} to recover unpaid rent, damage charges, utility arrears, and other housing-related debts from any Band payments, per capita distributions, honoraria, or program benefits administered by the Nation.</p>'
      + '<h3>21. Jurisdiction</h3>'
      + '<p>This Agreement is governed by the inherent jurisdiction of {nationName}. The Ontario Residential Tenancies Act, 2006 does not apply. Disputes shall be resolved through the internal grievance process of the {nationName} Housing Policy. <em>(Tenant initials required — see Initials Clauses.)</em></p>'
      + '<h3>Landlord Signature</h3>'
      + '<p>{landlordName}, Housing Manager &mdash; {nationName}</p>'
      + '<h3>Tenant Signature</h3>'
      + '<p>{tenantName}</p>'
      + '<h3>Co-Tenant Signature</h3>'
      + '<p>{coTenantName}</p>',
    defaultClauses: _CONTRACT_DEFAULT_CLAUSES
  },
  {
    key:         'temporary_lease',
    label:       'Temporary Residential Occupancy Agreement (Fixed Term)',
    description: 'Temporary, fixed-term occupancy agreement with a defined start and end date and no automatic renewal. Generated from the TIC alongside the standard lease. Supports {token} substitution.',
    defaultClauses: [
      {
        id:    'tl_init_vacate',
        label: 'Section 2 — Fixed Term & Obligation to Vacate',
        text:  'This is a temporary, fixed-term occupancy that ends on the end date specified in section 2 of this Agreement. The Occupant acknowledges that there is no automatic renewal and no security of tenure or expectation of permanent or continued housing beyond that date, and agrees to vacate and surrender the Residence on or before the end date unless a written extension is signed by the Housing Manager before that date.'
      },
      {
        id:    'tl_init_drug',
        label: 'Section 8 — Smoking, Cannabis & Drug Provisions',
        text:  'Cannabis cultivation, production, and processing in any quantity is strictly prohibited on the premises as a condition of this Agreement regardless of federal legality. Any breach of the cannabis prohibition constitutes immediate grounds for termination without a cure period. Unlawful drug activity — including possession, production, trafficking, or storage of controlled substances — also constitutes immediate grounds for termination. The Occupant acknowledges full liability for all remediation costs arising from cannabis cultivation or prohibited drug activity on the premises.'
      },
      {
        id:    'tl_init_juris',
        label: 'Section 12 — Acknowledgement of Jurisdiction',
        text:  'This Agreement is governed by the inherent jurisdiction of {nationName} and the Indian Act, R.S.C. 1985, c. I-5. The Ontario Residential Tenancies Act, 2006 does not apply to this Agreement. Any dispute arising under this Agreement shall be addressed through the internal grievance process established by the {nationName} Housing Policy.'
      }
    ],
    defaultBody:
        '<h2>{nationName} Housing Program</h2>'
      + '<h1>Temporary Residential Occupancy Agreement (Fixed Term)</h1>'
      + '<p>This Temporary Agreement is made on the <strong>{executionDay}</strong> day of <strong>{executionMonth}</strong>, <strong>{executionYear}</strong>.</p>'
      + '<h3>Parties</h3>'
      + '<p><strong>Landlord:</strong> {nationName} (hereinafter "the Landlord" or "the Nation")</p>'
      + '<p><strong>Occupant:</strong> {tenantName} (hereinafter "the Occupant")</p>'
      + '<p><strong>Co-Occupant:</strong> {coTenantName}</p>'
      + '<h3>1. Premises</h3>'
      + '<p>The Landlord grants the Occupant temporary occupancy of the residential premises located at Lot {residenceLot}, {residenceStreet} on the reserve lands of {nationName} (the "Residence"). Unit type: {residenceBedBath}. Housing stream: {residenceStream}.</p>'
      + '<h3>2. Temporary Term (Fixed)</h3>'
      + '<p>This is a temporary, fixed-term occupancy. It commences on <strong>{termStartDate}</strong> and ends on <strong>{termEndDate}</strong>. The Occupant agrees to vacate and surrender the Residence on or before the end date. This Agreement does not automatically renew and creates no tenancy, security of tenure, or expectation of permanent or continued housing beyond the end date. <em>(Occupant initials required.)</em></p>'
      + '<h3>3. Renewal or Extension</h3>'
      + '<p>Any extension of the term is at the sole discretion of the Nation and is valid only if made in writing and signed by the Housing Manager before the end date. Absent a signed extension, this Agreement terminates on {termEndDate}.</p>'
      + '<h3>4. Overholding</h3>'
      + '<p>If the Occupant remains in the Residence after {termEndDate} without a signed extension, the continued occupancy is unauthorized (overholding), does not create a tenancy, and the Occupant shall pay an occupancy fee at the rate in section 5 for each day of overholding, in addition to any costs the Nation incurs to recover possession.</p>'
      + '<h3>5. Occupancy Fee</h3>'
      + '<p>The Occupant shall pay an occupancy fee of <strong>{rentAmount}</strong> per month (pro-rated for any partial month) for the term, due on or before the first day of each month, payable to the {nationName} Housing Department.</p>'
      + '<h3>6. Authorized Occupants</h3>'
      + '<p>The following persons are authorized to reside in the Residence in addition to the Occupant: {occupant1Name} {occupant2Name} {occupant3Name} {occupant4Name} {occupant5Name} {occupant6Name}. No other person may occupy the Residence without prior written consent of the Landlord.</p>'
      + '<h3>7. Occupant Responsibilities</h3>'
      + '<ol>'
      + '<li>Maintain the Residence in a clean, safe, and habitable condition.</li>'
      + '<li>Report any required repairs or maintenance to the {nationName} Housing Department promptly.</li>'
      + '<li>Not cause or permit damage beyond normal wear and tear.</li>'
      + '<li>Not sublet, assign, or transfer occupancy of the Residence.</li>'
      + '<li>Comply with the {nationName} Housing Policy, community by-laws, and all applicable laws.</li>'
      + '<li>Permit the Landlord reasonable access for inspections and repairs with reasonable notice, except in emergencies.</li>'
      + '<li>Surrender the Residence on the end date in the same condition as received (reasonable wear and tear excepted) and return all keys.</li>'
      + '</ol>'
      + '<h3>8. Smoking, Cannabis &amp; Drug Provisions</h3>'
      + '<p>Cannabis cultivation, production, and processing is strictly prohibited on the premises. Unlawful drug activity constitutes grounds for immediate termination. The Occupant is liable for all remediation costs arising from prohibited activity. <em>(Occupant initials required.)</em></p>'
      + '<h3>9. Landlord Responsibilities</h3>'
      + '<ol>'
      + '<li>Provide the Residence in a habitable condition at commencement.</li>'
      + '<li>Maintain the structural integrity of the Residence and attend to necessary repairs within a reasonable time.</li>'
      + '<li>Provide 24 hours notice before entering the Residence except in emergencies.</li>'
      + '</ol>'
      + '<h3>10. Early Termination</h3>'
      + '<p>The Nation may terminate this Agreement before the end date for material breach, including non-payment of the occupancy fee, unauthorized occupants, damage, or prohibited activity, by providing written notice in accordance with the {nationName} Housing Policy.</p>'
      + '<h3>11. Recovery of Amounts Owing</h3>'
      + '<p>The Occupant authorizes {nationName} to recover unpaid occupancy fees, damage charges, utility arrears, and other housing-related debts from any Band payments, per capita distributions, honoraria, or program benefits administered by the Nation.</p>'
      + '<h3>12. Jurisdiction</h3>'
      + '<p>This Agreement is governed by the inherent jurisdiction of {nationName}. The Ontario Residential Tenancies Act, 2006 does not apply. Disputes shall be resolved through the internal grievance process of the {nationName} Housing Policy. <em>(Occupant initials required.)</em></p>'
      + '<h3>Landlord Signature</h3>'
      + '<p>{landlordName}, Housing Manager &mdash; {nationName}</p>'
      + '<h3>Occupant Signature</h3>'
      + '<p>{tenantName}</p>'
      + '<h3>Co-Occupant Signature</h3>'
      + '<p>{coTenantName}</p>'
  },
  {
    key:         'monthly_temp_lease',
    label:       'Month-to-Month Occupancy Agreement (All-Inclusive)',
    description: 'Month-to-month (open-ended) occupancy agreement for visiting professionals and community members needing temporary shelter. All-inclusive monthly fee (utilities included). Start date required; end date optional (leave blank for open-ended). Generated from the TIC alongside the other agreements. Supports {token} substitution.',
    defaultClauses: [
      {
        id:    'mo_init_term',
        label: 'Section 2 - Month-to-Month Term & No Security of Tenure',
        text:  'This is a temporary, month-to-month occupancy. It has no fixed end date and continues only from month to month until ended by either party on one clear month of written notice, or on the estimated departure date if one is stated. The Occupant acknowledges that this Agreement creates no permanent tenancy, no security of tenure, and no expectation of continued or permanent housing, and agrees to vacate and surrender the Residence when the occupancy ends.'
      },
      {
        id:    'mo_init_allin',
        label: 'Section 3 - All-Inclusive Fee (Utilities Included)',
        text:  'The monthly fee is all-inclusive and covers heat, hydro/electricity, and water/sewer supplied to the Residence for ordinary residential use. Utility accounts remain in the name of the Nation; the Occupant shall not open, transfer, or close any utility account for the Residence. Personal services (telephone, internet/cable) and insurance on the Occupant\'s own belongings are the Occupant\'s responsibility. The Occupant shall not use the Residence in a way that causes utility consumption grossly beyond normal residential use, and is liable for any such excess.'
      },
      {
        id:    'mo_init_condition',
        label: 'Section 6 - Cleanliness, Damage & Move-Out',
        text:  'The Occupant shall keep the Residence clean and sanitary throughout the occupancy and shall return it at move-out clean, free of the Occupant\'s belongings and garbage, and in the same condition as received, reasonable wear and tear excepted, with all keys returned. The Occupant is responsible for the cost of cleaning, repairs, or replacement arising from any damage beyond normal wear and tear caused by the Occupant, their household, or their guests. The Nation may inspect the Residence at move-in and move-out and may charge cleaning and damage costs against amounts owing.'
      },
      {
        id:    'mo_init_drug',
        label: 'Section 11 - Smoking, Cannabis & Drug Provisions',
        text:  'Cannabis cultivation, production, and processing in any quantity is strictly prohibited on the premises as a condition of this Agreement regardless of federal legality. Any breach of the cannabis prohibition constitutes immediate grounds for termination without a cure period. Unlawful drug activity - including possession, production, trafficking, or storage of controlled substances - also constitutes immediate grounds for termination. The Occupant acknowledges full liability for all remediation costs arising from cannabis cultivation or prohibited drug activity on the premises.'
      },
      {
        id:    'mo_init_juris',
        label: 'Section 15 - Acknowledgement of Jurisdiction',
        text:  'This Agreement is governed by the inherent jurisdiction of {nationName} and the Indian Act, R.S.C. 1985, c. I-5. The Ontario Residential Tenancies Act, 2006 does not apply to this Agreement. Any dispute arising under this Agreement shall be addressed through the internal grievance process established by the {nationName} Housing Policy.'
      }
    ],
    defaultBody:
        '<h2>{nationName} Housing Program</h2>'
      + '<h1>Month-to-Month Occupancy Agreement (All-Inclusive)</h1>'
      + '<p>This Agreement is made on the <strong>{executionDay}</strong> day of <strong>{executionMonth}</strong>, <strong>{executionYear}</strong>.</p>'
      + '<h3>Parties</h3>'
      + '<p><strong>Landlord:</strong> {nationName} (hereinafter "the Landlord" or "the Nation")</p>'
      + '<p><strong>Occupant:</strong> {tenantName} (hereinafter "the Occupant")</p>'
      + '<p><strong>Co-Occupant:</strong> {coTenantName}</p>'
      + '<h3>1. Premises</h3>'
      + '<p>The Landlord grants the Occupant temporary occupancy of the residential premises located at Lot {residenceLot}, {residenceStreet} on the reserve lands of {nationName} (the "Residence"). Unit type: {residenceBedBath}. Housing stream: {residenceStream}. This Agreement is intended for visiting professionals engaged in service to the community and for community members requiring temporary shelter.</p>'
      + '<h3>2. Term (Month-to-Month)</h3>'
      + '<p>This is a temporary, month-to-month occupancy. It commences on <strong>{termStartDate}</strong> and continues from month to month. Estimated departure date (if known): <strong>{termEndDateOrOpen}</strong>. This Agreement has no fixed end date, does not create a permanent tenancy, and confers no security of tenure or expectation of continued or permanent housing. It continues only until ended in accordance with section 4. <em>(Occupant initials required.)</em></p>'
      + '<h3>3. All-Inclusive Monthly Fee (Utilities Included)</h3>'
      + '<p>The Occupant shall pay an all-inclusive occupancy fee of <strong>{rentAmount}</strong> per month (pro-rated for any partial month), due on or before the first day of each month, payable to the {nationName} Housing Department. This all-inclusive fee covers heat, hydro/electricity, and water/sewer supplied to the Residence for ordinary residential use. Telephone, internet/cable, and insurance on the Occupant\'s own belongings are not included and are the Occupant\'s responsibility. Utility accounts remain in the name of the Nation and shall not be opened, transferred, or closed by the Occupant. <em>(Occupant initials required.)</em></p>'
      + '<h3>4. Ending the Occupancy (Notice to Vacate)</h3>'
      + '<p>Either party may end this Agreement by giving one clear month of written notice. The Nation may end this Agreement immediately for material breach, including non-payment of the occupancy fee, unauthorized occupants, damage, or prohibited activity. On the end of the occupancy the Occupant shall vacate and surrender the Residence and return all keys.</p>'
      + '<h3>5. Authorized Occupants</h3>'
      + '<p>The following persons are authorized to reside in the Residence in addition to the Occupant: {occupant1Name} {occupant2Name} {occupant3Name} {occupant4Name} {occupant5Name} {occupant6Name}. No other person may occupy the Residence without prior written consent of the Landlord.</p>'
      + '<h3>6. Cleanliness, Damage &amp; Move-Out</h3>'
      + '<p>The Occupant shall keep the Residence clean and sanitary during the occupancy and shall return it at move-out clean, emptied of the Occupant\'s belongings and garbage, and in the same condition as received (reasonable wear and tear excepted), with all keys returned. The Occupant is responsible for the cost of cleaning, repair, or replacement of any damage beyond normal wear and tear caused by the Occupant, their household, or their guests. The Nation may inspect the Residence at move-in and move-out and may charge cleaning and damage costs against amounts owing. <em>(Occupant initials required.)</em></p>'
      + '<h3>7. Use of the Residence &amp; Conduct</h3>'
      + '<ol>'
      + '<li>Use the Residence only as a private residence and not for any business or unlawful purpose.</li>'
      + '<li>Not disturb the reasonable peace and quiet of neighbours or the community.</li>'
      + '<li>Not sublet, assign, or transfer occupancy of the Residence, and not operate a short-term rental.</li>'
      + '<li>Be responsible for the conduct of household members and guests.</li>'
      + '</ol>'
      + '<h3>8. Furnishings &amp; Contents</h3>'
      + '<p>Where the Residence is provided furnished or with appliances, the Occupant shall use them with reasonable care and return them in the same condition, reasonable wear and tear excepted. The Nation is not responsible for the Occupant\'s personal belongings; the Occupant is responsible for insuring their own contents.</p>'
      + '<h3>9. Occupant Responsibilities</h3>'
      + '<ol>'
      + '<li>Maintain the Residence in a clean, safe, and habitable condition.</li>'
      + '<li>Report any required repairs or maintenance to the {nationName} Housing Department promptly.</li>'
      + '<li>Not cause or permit damage beyond normal wear and tear.</li>'
      + '<li>Comply with the {nationName} Housing Policy, community by-laws, and all applicable laws.</li>'
      + '<li>Permit the Landlord reasonable access for inspections and repairs with reasonable notice, except in emergencies.</li>'
      + '</ol>'
      + '<h3>10. Landlord Responsibilities</h3>'
      + '<ol>'
      + '<li>Provide the Residence in a habitable condition at commencement.</li>'
      + '<li>Maintain the structural integrity of the Residence and attend to necessary repairs within a reasonable time.</li>'
      + '<li>Supply the included utilities in section 3 for ordinary residential use.</li>'
      + '<li>Provide 24 hours notice before entering the Residence except in emergencies.</li>'
      + '</ol>'
      + '<h3>11. Smoking, Cannabis &amp; Drug Provisions</h3>'
      + '<p>Cannabis cultivation, production, and processing is strictly prohibited on the premises. Unlawful drug activity constitutes grounds for immediate termination. The Occupant is liable for all remediation costs arising from prohibited activity. <em>(Occupant initials required.)</em></p>'
      + '<h3>12. Overholding</h3>'
      + '<p>If the Occupant remains in the Residence after the occupancy has ended without the Nation\'s written consent, the continued occupancy is unauthorized (overholding), does not create a tenancy, and the Occupant shall pay an occupancy fee at the rate in section 3 for each day of overholding, in addition to any costs the Nation incurs to recover possession.</p>'
      + '<h3>13. Recovery of Amounts Owing</h3>'
      + '<p>The Occupant authorizes {nationName} to recover unpaid occupancy fees, damage charges, cleaning charges, and other housing-related debts from any Band payments, per capita distributions, honoraria, or program benefits administered by the Nation.</p>'
      + '<h3>14. No Security of Tenure</h3>'
      + '<p>This Agreement is temporary. It creates no tenancy, no security of tenure, and no expectation of permanent or continued housing beyond the occupancy, which may be ended in accordance with section 4.</p>'
      + '<h3>15. Jurisdiction</h3>'
      + '<p>This Agreement is governed by the inherent jurisdiction of {nationName}. The Ontario Residential Tenancies Act, 2006 does not apply. Disputes shall be resolved through the internal grievance process of the {nationName} Housing Policy. <em>(Occupant initials required.)</em></p>'
      + '<h3>Landlord Signature</h3>'
      + '<p>{landlordName}, Housing Manager &mdash; {nationName}</p>'
      + '<h3>Occupant Signature</h3>'
      + '<p>{tenantName}</p>'
      + '<h3>Co-Occupant Signature</h3>'
      + '<p>{coTenantName}</p>'
  },
  {
    key:         'commercial_lease',
    label:       'Commercial Occupancy & Lease Agreement',
    description: 'Fixed-term lease for a business or department occupying a commercial / admin / band building. Generated from the TIC alongside the residential agreements. Supports {token} substitution.',
    defaultClauses: [
      {
        id:    'cl_init_insurance',
        label: 'Section 6 — Insurance & Liability',
        text:  'The Tenant shall, at its own expense, maintain commercial general liability insurance of not less than $2,000,000 per occurrence naming the Nation as an additional insured, and shall provide proof of coverage before occupancy and on renewal. The Tenant is liable for all loss, damage, or claims arising from its use of the Premises and shall indemnify the Nation accordingly.'
      },
      {
        id:    'cl_init_use',
        label: 'Section 3 — Permitted Use & Compliance',
        text:  'The Tenant shall use the Premises solely for the business or operational purpose approved by the Nation and for no other purpose without prior written consent. The Tenant shall comply with the Nation Housing/Lands Policy, community by-laws, all applicable laws, health and safety requirements, and any required business licensing.'
      },
      {
        id:    'cl_init_juris',
        label: 'Section 13 — Acknowledgement of Jurisdiction',
        text:  'This Agreement is governed by the inherent jurisdiction of {nationName} and the Indian Act, R.S.C. 1985, c. I-5. The Ontario Residential Tenancies Act, 2006 does not apply to this Agreement. Any dispute arising under this Agreement shall be addressed through the internal process established by the Nation.'
      }
    ],
    defaultBody:
        '<h2>{nationName} &mdash; Lands &amp; Housing</h2>'
      + '<h1>Commercial Occupancy &amp; Lease Agreement</h1>'
      + '<p>This Agreement is made on the <strong>{executionDay}</strong> day of <strong>{executionMonth}</strong>, <strong>{executionYear}</strong>.</p>'
      + '<h3>Parties</h3>'
      + '<p><strong>Landlord:</strong> {nationName} (hereinafter "the Landlord" or "the Nation")</p>'
      + '<p><strong>Tenant:</strong> {tenantName} (the business or department named herein, hereinafter "the Tenant")</p>'
      + '<p><strong>Authorized Contact:</strong> {contactPerson}</p>'
      + '<h3>1. Premises</h3>'
      + '<p>The Landlord leases to the Tenant the premises located at Lot {residenceLot}, {residenceStreet} on the reserve lands of {nationName} (the "Premises").</p>'
      + '<h3>2. Term (Fixed)</h3>'
      + '<p>This is a fixed-term lease commencing on <strong>{termStartDate}</strong> and ending on <strong>{termEndDate}</strong>. It does not renew automatically; any renewal or extension is valid only if made in writing and signed by both parties before the end date.</p>'
      + '<h3>3. Permitted Use &amp; Compliance</h3>'
      + '<p>The Tenant shall use the Premises solely for the approved business or operational purpose, and shall comply with the Nation\'s policies, community by-laws, all applicable laws, health and safety requirements, and any required licensing. <em>(Tenant initials required.)</em></p>'
      + '<h3>4. Rent / Occupancy Fee</h3>'
      + '<p>The Tenant shall pay <strong>{rentAmount}</strong> per month, due on or before the first day of each month, payable to the {nationName} Lands &amp; Housing Department.</p>'
      + '<h3>5. Utilities &amp; Maintenance</h3>'
      + '<p>Unless otherwise agreed in writing, the Tenant is responsible for the utilities and the interior upkeep of the Premises and shall keep it clean, safe, and in good repair. The Landlord maintains the structural integrity of the building.</p>'
      + '<h3>6. Insurance &amp; Liability</h3>'
      + '<p>The Tenant shall maintain commercial general liability insurance of not less than $2,000,000 naming the Nation as an additional insured, provide proof before occupancy, and indemnify the Nation for loss or damage arising from its use of the Premises. <em>(Tenant initials required.)</em></p>'
      + '<h3>7. Assignment &amp; Alterations</h3>'
      + '<p>The Tenant shall not assign, sublet, or transfer occupancy of the Premises, and shall not make structural alterations, without the prior written consent of the Landlord.</p>'
      + '<h3>8. Default &amp; Termination</h3>'
      + '<p>The Landlord may terminate this Agreement for non-payment, prohibited use, lapse of required insurance, or any material breach, by written notice in accordance with the Nation\'s policy.</p>'
      + '<h3>9. Surrender at End of Term</h3>'
      + '<p>On the end date (or earlier termination) the Tenant shall vacate the Premises, remove its property, return all keys, and leave the Premises in the same condition as received, reasonable wear and tear excepted.</p>'
      + '<h3>10. Recovery of Amounts Owing</h3>'
      + '<p>The Tenant authorizes {nationName} to recover unpaid rent/occupancy fees, damage charges, utility arrears, and other amounts owing under this Agreement through its established processes.</p>'
      + '<h3>13. Jurisdiction</h3>'
      + '<p>This Agreement is governed by the inherent jurisdiction of {nationName}. The Ontario Residential Tenancies Act, 2006 does not apply. Disputes shall be resolved through the internal process established by the Nation. <em>(Tenant initials required.)</em></p>'
      + '<h3>Landlord Signature</h3>'
      + '<p>{landlordName} &mdash; {nationName}</p>'
      + '<h3>Tenant Signature</h3>'
      + '<p>{tenantName} (per {contactPerson})</p>'
  },
  {
    key:         'replacement_contract',
    label:       'Replacement Contract (Rental / Homeownership)',
    description: 'Blank replacement copy of the nation\'s Rental / Homeownership Agreement of Housing Authority, recreated WITHOUT tenant-specific information for re-issuing an agreement. Generated from the TIC. {nationName} substitutes from config; all tenant fields print as blanks for hand-completion.',
    defaultClauses: [],
    defaultBody:
        '<h2>Housing Authority of {nationName}</h2>'
      + '<h1>Rental / Homeownership Agreement</h1>'
      + '<h2>Replacement Contract</h2>'
      + '<p><em>This is a replacement copy of the Rental / Homeownership Agreement of the Housing Authority of {nationName}. It replaces any prior agreement for the premises described below.</em></p>'
      + '<p>Rental Agreement made as of the <strong>{startDay}</strong> day of <strong>{startMonth}</strong>, <strong>{startYear}</strong>.</p>'
      + '<p><strong>BETWEEN: HOUSING AUTHORITY OF {nationName}:</strong> as represented by its duly instituted Band Council (hereinafter called the "Housing Authority") &mdash; OF THE FIRST PART</p>'
      + '<p><strong>AND:</strong> {tenantName} (hereinafter called the "Tenant") &mdash; OF THE SECOND PART</p>'
      + '<h3>Whereas</h3>'
      + '<p>A. The Housing Authority has the authority to administer its own Housing Authority Rental Housing and Homeownership Program.</p>'
      + '<p>B. The Housing Authority has lawful possession of the premises hereinafter described.</p>'
      + '<p>C. The Housing Authority has agreed that the Tenant may occupy the premises on the terms and conditions hereinafter set out.</p>'
      + '<p>WITNESSETH THAT for and in consideration of the premises and the mutual covenants and agreements hereinafter contained, the parties agree as follows:</p>'
      + '<h3>Definition of Terms</h3>'
      + '<p><em>(This Definition of Terms section is an addition for clarification only. It is not part of the original agreement and does not modify, expand, or limit any clause below.)</em></p>'
      + '<p>In this Agreement, unless the context otherwise requires:</p>'
      + '<p><strong>"Agreement"</strong> means this Rental / Homeownership Agreement together with Schedule "B" and any other schedules attached to it, as amended from time to time.</p>'
      + '<p><strong>"Housing Authority"</strong> means the Housing Authority of {nationName}, as represented by its duly instituted Band Council, and includes its officers, employees, and agents.</p>'
      + '<p><strong>"Band Council"</strong> (or <strong>"Chief and Council"</strong>) means the elected Chief and Council of {nationName}.</p>'
      + '<p><strong>"Tenant"</strong> means the person or persons named on the first page of this Agreement who occupy the Premises under it and, where the context permits, includes the authorized dependents named in section 4(i).</p>'
      + '<p><strong>"Premises"</strong> means the residential dwelling and lands described in section 1 of this Agreement.</p>'
      + '<p><strong>"Rent"</strong> (or <strong>"rent or home ownership"</strong>) means the monthly amount payable by the Tenant under section 3(a), being the Tenant\'s contribution toward rent and toward home ownership.</p>'
      + '<p><strong>"Graduated Rental Scale"</strong> means the rental scale for families and elderly citizens established by the Housing Authority, in accordance with which the Rent may be adjusted under section 3(b).</p>'
      + '<p><strong>"Certificate of Purchase"</strong> means the certificate issued by the Housing Authority under section 3(d) once the Tenant has paid the total value of the home in full, evidencing the transfer of ownership of the home to the Tenant.</p>'
      + '<p><strong>"Beneficiary"</strong> means the person designated by the Tenant under section 3(e) to receive the home in the event of the Tenant\'s death, subject to this Agreement and the Housing Policy.</p>'
      + '<p><strong>"Trustee"</strong> means the person appointed by the Tenant under section 3(e) to hold the home in trust where the Beneficiary is a minor at the time of the Tenant\'s death.</p>'
      + '<p><strong>"Housing Policy"</strong> means the housing policy of the Housing Authority and {nationName}, as amended from time to time.</p>'
      + '<p><strong>"Schedule B"</strong> means the amortization / social housing cost schedule attached to this Agreement, showing the application of the Rent over the term and the value remaining at the end of the term.</p>'
      + '<p>Words importing the singular include the plural and vice versa, and words importing one gender include all genders. Headings are for convenience of reference only and do not affect the interpretation of this Agreement.</p>'
      + '<h3>1. Premises</h3>'
      + '<p>The Housing Authority leases to the Tenant for use and occupation as a residential dwelling all those certain premises more particularly known and described as:</p>'
      + '<p>{residenceStreet} (Lot {residenceLot}) &mdash; Unit type: {residenceBedBath}. (hereinafter referred to as the "Premises").</p>'
      + '<h3>2. Duration</h3>'
      + '<p>This Agreement shall commence on <strong>{termStartDate}</strong> and continue through <strong>{termEndDate}</strong>.</p>'
      + '<p><em>Note: This agreement will be reviewed within six (6) months. Thereafter it will be reviewed annually.</em></p>'
      + '<p>The Tenant shall have the right to terminate this Agreement upon two (2) months\' written notice given to the Housing Authority, or the Housing Authority may terminate this Agreement by giving one (1) month\'s notice to the Tenant.</p>'
      + '<h3>3. Rent or Home Ownership</h3>'
      + '<p>(a) The Tenant shall pay to the Housing Authority the rent or home ownership in the sum of <strong>${rentAmount}</strong> per month, payable on the first day of each month at the Housing Administration office or at such other place as the Housing Authority may hereafter direct. Payment will be made in cash or by cheque made payable to the Housing Authority of {nationName} Trust Account.</p>'
      + '<p>(b) The rent may be adjusted annually or in accordance with policies set forth by the Housing Authority for a period of no less than 12 months, in accordance with the Graduated Rental Scale for Families and Elderly citizens established by the Housing Authority and other guidelines; when adjusted, the adjusted rent will become the rent due and payable.</p>'
      + '<p>(c) Prior to signing of this rental agreement, the Tenant shall provide the rents for the first and last months.</p>'
      + '<p>(d) If the Tenant has paid in full the monthly rental payments as prescribed in (a) and (b) herein, as certified correct by the Housing Authority, the Tenant has, upon a further payment of $1.00, the option to purchase the premises and may exercise this option in writing addressed to the Housing Authority within 365 days of making the last rent payment. If the Tenant exercises the option to purchase under this paragraph, the Housing Authority may issue the Tenant a Certificate of Purchase, only after the Tenant has paid in full. The total value of the home is <strong>{homeValue}</strong>{downPaymentClause}.</p>'
      + '<p>(e) Beneficiary Clause: We designate ________________________________ as beneficiary to receive our house in the event of our death, subject to this Agreement\'s guidelines and within the Housing Authority Housing Policy. We have appointed the following trustee should our beneficiary at the time of our death be a minor. Name: ________________________________</p>'
      + '<p>(f) Upon issuance of the Certificate of Purchase, this agreement shall end.</p>'
      + '<h3>4. Tenants\' Covenants</h3>'
      + '<p>(a) To pay rent by the dates specified (as per section 3(a) of this agreement).</p>'
      + '<p>(b) To keep the premises in repair, damage by fire, tempest or other act of God excepted.</p>'
      + '<p>(c) To pay heating, telephone, service fees and hydro charges and/or any other personal utility services.</p>'
      + '<p>(d) The Tenant shall not assign or sub-let the Premises without permission in writing from the Housing Authority.</p>'
      + '<p>(e) The Tenant will indemnify and save the Housing Authority harmless for all liabilities, fines, suits, and claims of any kind for which the Housing Authority may be liable or suffer by reason of the Tenant\'s occupancy of the Premises.</p>'
      + '<p>(f) The Tenant will not do or omit to do anything which may render void or voidable any policy of insurance on the Premises.</p>'
      + '<p>(g) The Tenant will abide by the rules, regulations and by-laws made by the Housing Authority.</p>'
      + '<p>(h) The Tenant will take good care of the premises and keep the Premises in a clean condition.</p>'
      + '<p>(i) The Tenant hereby acknowledges that the premises will only be resided in by him/her and his/her dependents as follows:</p>'
      + '<p>1. {occupant1Name}&nbsp;&nbsp;&nbsp;&nbsp;2. {occupant2Name}</p>'
      + '<p>3. {occupant3Name}&nbsp;&nbsp;&nbsp;&nbsp;4. {occupant4Name}</p>'
      + '<p>5. {occupant5Name}&nbsp;&nbsp;&nbsp;&nbsp;6. {occupant6Name}</p>'
      + '<p>(j) The Tenant agrees that no other person(s) will be allowed to reside in the rented premises, other than those named in 4(i), without the written approval of the Housing Authority. Any discovery of such person(s) shall be deemed a violation of this lease agreement and therefore subject to eviction procedures.</p>'
      + '<p>(k) Repairs &mdash; Tenant\'s Responsibility: Decorating, such as painting, and minor repairs are the responsibility of the tenant. Inspections, at least once a year, will be carried out and repairs required listed. The landlord will bear the cost of repairs deemed to be the landlord\'s responsibility. Repairs deemed to be the Tenant\'s responsibility will be directed to the Tenant to carry out. Failure of the Tenant to carry out the repair within a reasonable time will result in the landlord doing so and charging the cost to the Tenant. Failure of the Tenant to remit payment for the repairs is a breach of the lease agreement. Disagreements between the landlord and the Tenant\'s responsibility for repairs will be taken to the Housing Authority for recommendation, which Chief and Council will make the final decision on.</p>'
      + '<h3>5. Housing Authority Covenants</h3>'
      + '<p>(a) The Housing Authority will ensure the Premises against damage caused by fire.</p>'
      + '<p>(b) The Housing Authority grants the Tenant quiet enjoyment of the Premises.</p>'
      + '<p>(c) Repairs &mdash; Housing Authority Responsibility: The Housing Authority, as stipulated in this agreement, is to keep the premises in a good state of repair and fit for habitation. Repairs that are regarded as the Housing Authority responsibility are those having to do with the structure, whether deemed to be major or minor, heating, electrical, water or a major deficiency not attributed to or caused willfully or negligently by the Tenant(s) or guests, which if not corrected makes the premises unfit for habitation. The Tenant must give the Housing Authority reasonable notice and time to rectify the problem, and the withholding of rent until repairs are corrected will not be accepted as justification for non-payment of rent. In addition, there is no justification for the non-payment of rent for minor deficiencies.</p>'
      + '<h3>6. Default (If the Tenant)</h3>'
      + '<p>(a) fails to pay rent, the tenant will be sent a first notice indicating that they are in default of their rental agreement.</p>'
      + '<p>(b) failure to make payment within 30 days after the first notice, a second notice will be sent demanding payment of rent and an interview to make arrangements for arrears.</p>'
      + '<p>(c) failure to make payment within 30 days after the second notice, an eviction notice will be sent to the tenant; the Housing Authority may declare the tenancy ended, and thereupon the tenancy and the Tenant\'s rights hereunder shall absolutely cease, without re-entry or any other act or legal proceedings, and the Housing Authority or its agent may re-enter the Premises or any part of it, and thereafter have, possess and enjoy it as if this Agreement had not been made; or</p>'
      + '<p>(d) fails to perform or observe any of his covenants, or does anything contrary to the terms of this agreement, the Housing Authority may declare the tenancy ended, and thereupon the tenancy and the Tenant\'s rights hereunder shall absolutely cease, without re-entry or any other act or legal proceedings, and the Housing Authority or its agent may re-enter the Premises or any part of it, and thereafter have, possess and enjoy it as if this Agreement had not been made.</p>'
      + '<p><em>Also, see Schedule "B".</em></p>'
      + '<h3>In Witness Whereof</h3>'
      + '<p>IN WITNESS WHEREOF this Agreement has been executed by the Parties hereto as of the day and year first above written.</p>'
      + '<p>SIGNED, SEALED AND DELIVERED by <strong>{landlordName}</strong> for the Housing Authority, in the presence of ________________________________ (Witness)</p>'
      + '<p>SIGNED, SEALED AND DELIVERED by <strong>{tenantName}</strong> the Tenant, in the presence of ________________________________ (Witness)</p>'
  },
  {
    key:         'contractor_agreement',
    label:       'Contractor Agreement',
    description: 'Renovation/construction contract issued to the awarded contractor. Supports {token} substitution for project-specific data.',
    defaultClauses: [
      {
        id:    'ct_ack',
        label: 'Contractor Acknowledgement',
        text:  'By initialling below, the Contractor confirms that it is in good standing with WSIB, holds the insurance required under section 11, will comply with the Construction Act and OHSA, and accepts the prompt payment and adjudication framework set out in sections 8 and 10.'
      }
    ],
    defaultBody:
        '<h2>{nationName} Housing Program</h2>'
      + '<h2>Renovation &amp; Construction Contract</h2>'
      + '<p>Contract Number: <strong>{contractNumber}</strong>    Date: <strong>{contractDate}</strong></p>'
      + '<p>RFQ Reference: <strong>{rfqNumber}</strong>    Quote Reference: <strong>{quoteNumber}</strong></p>'
      + '<h2>PARTIES</h2>'
      + '<p><strong>OWNER:</strong> {nationName}, a First Nation governed under the Indian Act, R.S.C. 1985, c. I-5, with its housing offices located on reserve (hereinafter the <strong>"Owner"</strong> or the <strong>"Nation"</strong>).</p>'
      + '<p><strong>CONTRACTOR:</strong> {contractorLegalName}, operating as {contractorOperatingName}, having its principal place of business at {contractorAddressLine1} {contractorAddressLine2} (hereinafter the <strong>"Contractor"</strong>).</p>'
      + '<p>HST/Business Number: {contractorGstHst}   WSIB Account: {contractorWsib}   Phone: {contractorPhone}</p>'
      + '<h2>1. PROJECT</h2>'
      + '<p><strong>Property Address:</strong> {propertyAddress}</p>'
      + '<p><strong>Project Type:</strong> {projectType}</p>'
      + '<p><strong>Maintenance Request Reference:</strong> {sowReference}</p>'
      + '<p>The Owner hereby engages the Contractor to perform the renovation and construction work described in this Agreement and the attached Schedules (the <strong>"Work"</strong>). The Contractor accepts this engagement and agrees to perform the Work in accordance with the terms and conditions set out herein.</p>'
      + '<h2>2. MAINTENANCE REQUEST</h2>'
      + '<p>{sowSummary}</p>'
      + '<p>The detailed maintenance request, including all work packages, quantities, and specifications, is set out in <strong>Schedule A</strong> attached to and forming part of this Agreement. The Contractor shall perform all items set out in Schedule A unless a written change order signed by both parties provides otherwise.</p>'
      + '<h2>3. CONTRACT PRICE</h2>'
      + '<p>The Owner agrees to pay the Contractor, subject to the holdback and payment provisions of this Agreement, the all-inclusive Contract Price of:</p>'
      + '<p><strong>Contract Price (excluding tax): {contractPriceExclTax}</strong></p>'
      + '<p><strong>HST/Tax: {priceTax}</strong></p>'
      + '<p><strong>Total Contract Price: {priceTotalInclTax}</strong></p>'
      + '<p>The Contract Price is a fixed, lump-sum price inclusive of all materials, labour, equipment, overhead, and profit required to complete the Work, except as expressly excluded in Schedule A.</p>'
      + '<p>Price breakdown: Materials - {priceMaterials}  Labour - {priceLabour}  Equipment - {priceEquipment}  Other - {priceOther}</p>'
      + '<p>Estimated total labour hours: {labourHours}</p>'
      + '<h2>4. PAYMENT TERMS</h2>'
      + '<p>Payment shall be made by the Owner in accordance with the milestone schedule set out in Schedule B. Each milestone payment is conditional upon the Contractor\'s submission of a proper invoice and the Owner\'s approval of the completed milestone work.</p>'
      + '<p>All invoices must reference the Contract Number, property address, and applicable milestone. Invoices are to be submitted to: <strong>{apEmail}</strong></p>'
      + '<p>The Owner shall make payment within thirty (30) days of receipt of a proper invoice, in accordance with the prompt payment provisions of the Construction Act, R.S.O. 1990, c. C.30, as amended.</p>'
      + '<h2>5. HOLDBACK</h2>'
      + '<p>The Owner shall retain a statutory holdback of ten percent (10%) of the value of each progress payment, as required by the Construction Act. The holdback shall be released in accordance with the Act following the expiry of the applicable lien period, provided no liens have been preserved, and subject to the Contractor\'s compliance with all conditions of this Agreement.</p>'
      + '<p>Holdback release amount: <strong>{holdbackRelease}</strong></p>'
      + '<h2>6. PROMPT PAYMENT AND ADJUDICATION</h2>'
      + '<p>This Agreement is governed by the prompt payment and adjudication provisions of the Construction Act. The Owner acknowledges its obligation to pay proper invoices within thirty (30) days. The Contractor acknowledges its obligation to pay subcontractors and suppliers within seven (7) days of receipt of payment from the Owner. Disputes regarding payment may be referred to adjudication under Part II.1 of the Construction Act.</p>'
      + '<h2>7. SCHEDULE</h2>'
      + '<p><strong>Work Start Date:</strong> {startDate}</p>'
      + '<p><strong>Substantial Completion Date:</strong> {substantialCompletionDate}</p>'
      + '<p><strong>Total Completion Date:</strong> {totalCompletionDate}</p>'
      + '<p>Time is of the essence in this Agreement. The Contractor shall commence Work on the Start Date and shall achieve Substantial Completion no later than the Substantial Completion Date set out above. The Contractor shall notify the Owner in writing of any anticipated delay as soon as the cause of delay becomes known, and before the affected date.</p>'
      + '<p>On-site supervisor: <strong>{contractorSiteLead}</strong>  Phone: {contractorSiteLeadPhone}</p>'
      + '<h2>8. CONTRACTOR OBLIGATIONS</h2>'
      + '<ol>'
      + '<li><strong>Workmanship.</strong> The Contractor shall perform all Work in a good and workmanlike manner, using competent workers and materials of the quality specified or, where not specified, of first-class quality suitable for the intended purpose.</li>'
      + '<li><strong>Compliance with Laws.</strong> The Contractor shall perform the Work in full compliance with the Ontario Building Code, the Occupational Health and Safety Act (OHSA), the Construction Act, all applicable federal, provincial, and municipal laws and regulations, and all by-laws of {nationName}.</li>'
      + '<li><strong>Permits and Approvals.</strong> The Contractor is responsible for obtaining all permits, inspections, and approvals required for the Work, unless otherwise stated in Schedule A, and shall provide copies to the Owner promptly upon receipt.</li>'
      + '<li><strong>Site Safety.</strong> The Contractor is the constructor for the purposes of the OHSA and shall maintain a safe work site, establish a health and safety program, and ensure compliance with all applicable safety requirements throughout the performance of the Work.</li>'
      + '<li><strong>Workers\' Compensation.</strong> The Contractor and all subcontractors shall maintain current WSIB clearance certificates throughout the performance of the Work. Clearance certificates shall be provided to the Owner upon request and as a condition of any progress payment.</li>'
      + '<li><strong>Insurance.</strong> The Contractor shall obtain and maintain, at its own cost, general liability insurance in the amount of not less than Two Million Dollars ($2,000,000.00) per occurrence, naming {nationName} as an additional insured. Proof of insurance shall be provided before Work commences and on each policy renewal.</li>'
      + '<li><strong>Subcontracting.</strong> The Contractor shall not subcontract any portion of the Work without the prior written consent of the Owner. All subcontractors shall meet the same WSIB, insurance, and qualification requirements applicable to the Contractor.</li>'
      + '<li><strong>Materials.</strong> All materials incorporated into the Work shall be new, free from defects, and shall conform to the specifications set out in Schedule A. Substitutions require prior written approval of the Owner.</li>'
      + '<li><strong>Cleanliness.</strong> The Contractor shall keep the work site clean and safe throughout the performance of the Work and shall remove all waste and debris upon completion.</li>'
      + '<li><strong>Deficiencies.</strong> The Contractor shall correct all deficiencies identified by the Owner\'s representative during inspection, at no additional cost to the Owner and within the time specified in the notice of deficiency.</li>'
      + '<li><strong>On-Reserve Conduct.</strong> While on reserve lands, the Contractor and all its workers and subcontractors shall comply with the {nationName} community by-laws and any protocols established by the Nation.</li>'
      + '</ol>'
      + '<h2>9. OWNER OBLIGATIONS</h2>'
      + '<ol>'
      + '<li>Provide the Contractor with reasonable access to the property during normal working hours and at such other times as agreed, upon reasonable notice.</li>'
      + '<li>Review and respond to the Contractor\'s requests for information, change orders, and inspection approvals within a reasonable time.</li>'
      + '<li>Make payments in accordance with the payment terms of this Agreement.</li>'
      + '<li>Designate a representative authorized to act on behalf of the Owner for purposes of this Agreement: <strong>{clfnSignatoryName}</strong>, {clfnSignatoryTitle}.</li>'
      + '</ol>'
      + '<h2>10. CHANGE ORDERS</h2>'
      + '<p>No change to the scope, cost, or schedule of the Work is authorized unless made by written change order signed by both parties before the additional or changed work is performed. Verbal instructions do not constitute authorization for changes. The Contract Price and schedule shall be adjusted only as expressly provided in a signed change order.</p>'
      + '<h2>11. INSURANCE AND WSIB ACKNOWLEDGEMENT</h2>'
      + '<p>The Contractor confirms that, as of the date of execution of this Agreement, it holds general liability insurance in the amount required under Section 8.6, is in good standing with WSIB, and will maintain both throughout the performance of the Work. Failure to maintain required insurance or WSIB clearance is grounds for suspension of payment and, at the Owner\'s election, termination.</p>'
      + '<h2>12. SUBSTANTIAL COMPLETION AND FINAL INSPECTION</h2>'
      + '<p>Substantial Completion occurs when the Work, or a substantial part of the Work, is ready for use or is being used for the purpose intended, and the remainder of the Work can be completed without materially impairing use. The Owner\'s representative shall conduct a final inspection and issue a Certificate of Substantial Completion within ten (10) days of the Contractor\'s written notice that Substantial Completion has been achieved.</p>'
      + '<h2>13. WARRANTY</h2>'
      + '<p>The Contractor warrants the Work against defects in materials and workmanship for a period of one (1) year from the date of Substantial Completion, or such longer period as may be required by the manufacturer of any materials incorporated into the Work. During the warranty period, the Contractor shall promptly remedy any defect at no cost to the Owner upon written notice.</p>'
      + '<h2>14. TERMINATION</h2>'
      + '<p>Either party may terminate this Agreement for material breach upon ten (10) days written notice, provided the breach is not cured within that period. The Owner may terminate for convenience upon thirty (30) days written notice, in which case the Contractor is entitled to payment for Work performed to the date of termination plus reasonable demobilization costs, but not for lost profit on unperformed Work. The Owner may terminate immediately if the Contractor becomes insolvent, abandons the Work, or persistently fails to comply with applicable law.</p>'
      + '<h2>15. LIENS AND STATUTORY TRUST</h2>'
      + '<p>The Contractor shall take all steps necessary to ensure that no lien is preserved against the property arising from the Work. The Contractor shall hold all payments received from the Owner in trust for its subcontractors and suppliers as required by the Construction Act. The Contractor shall provide statutory declarations confirming the discharge of all liens and the payment of all subcontractors and suppliers as a condition of final payment.</p>'
      + '<h2>16. LIMITATION OF LIABILITY</h2>'
      + '<p>The liability of the Owner to the Contractor under this Agreement shall not exceed the total Contract Price paid or payable hereunder. Neither party shall be liable to the other for indirect, incidental, consequential, or punitive damages.</p>'
      + '<h2>17. DISPUTE RESOLUTION</h2>'
      + '<p>The parties shall first attempt to resolve any dispute through good-faith negotiation. If the dispute is not resolved within fifteen (15) days of written notice, either party may refer the dispute to adjudication under Part II.1 of the Construction Act. Nothing in this section prevents a party from seeking urgent interlocutory relief from a court of competent jurisdiction.</p>'
      + '<h2>18. JURISDICTION AND GOVERNING LAW</h2>'
      + '<p>This Agreement is made on the reserve lands of {nationName} and is governed by the inherent jurisdiction of the Nation and applicable federal law, including the Indian Act. The Ontario Residential Tenancies Act does not apply to this Agreement. To the extent provincial law applies, the laws of the Province of Ontario govern.</p>'
      + '<h2>19. GENERAL PROVISIONS</h2>'
      + '<ol>'
      + '<li><strong>Entire Agreement.</strong> This Agreement, together with its Schedules, constitutes the entire agreement between the parties with respect to the Work and supersedes all prior negotiations, representations, and agreements.</li>'
      + '<li><strong>Amendment.</strong> No amendment to this Agreement is effective unless made in writing and signed by both parties.</li>'
      + '<li><strong>Waiver.</strong> Failure by either party to enforce any provision of this Agreement shall not constitute a waiver of that party\'s right to enforce it subsequently.</li>'
      + '<li><strong>Severability.</strong> If any provision of this Agreement is found to be unenforceable, the remaining provisions continue in full force and effect.</li>'
      + '<li><strong>Notices.</strong> All notices under this Agreement shall be in writing and delivered by email, hand, or courier to the addresses set out in this Agreement.</li>'
      + '<li><strong>Counterparts.</strong> This Agreement may be executed in counterparts, each of which shall be deemed an original. Electronic signatures are binding.</li>'
      + '</ol>'
      + '<h2>SCHEDULE A - MAINTENANCE REQUEST</h2>'
      + '<p>Property: {propertyAddress}  Project Type: {projectType}  Maintenance Request Reference: {sowReference}  Quote: {quoteNumber}</p>'
      + '<h3>Work Items</h3>'
      + '<p>{sowDetailTable}</p>'
      + '<h3>Materials and Specifications</h3>'
      + '<p>{materialsSpecifications}</p>'
      + '<h3>Exclusions and Assumptions</h3>'
      + '<p>{exclusionsAssumptions}</p>'
      + '<h3>Items Supplied by Nation</h3>'
      + '<p>{clfnSuppliedItems}</p>'
      // Schedule B (milestone payment table), the Contractor Acknowledgement,
      // and the Signatures block are appended dynamically by the contract
      // generator (generateContractorContract in rfq.js) — the milestone table
      // and captured signature/initial images can't be expressed as {tokens}.
  },
  {
    // Not a rich-text agreement — a form of editable headings/labels for the
    // RFQ bid document (its data tables stay generated). Handled specially in
    // _contractsRenderEditorHtml via `special`. Saved to housing_settings key
    // 'rfq_document'; read by _rfqDocStr()/_rfqDocList().
    key:         'rfq_document',
    label:       'RFQ Bid Document',
    description: 'Headings & labels on the RFQ sent to contractors',
    special:     'rfq_strings'
  }
];

var _CONTRACT_TOKENS = [
  { token: 'nationName',             desc: 'Nation full name' },
  { token: 'nationShort',            desc: 'Nation short name' },
  { token: 'executionDay',           desc: 'Execution day of month' },
  { token: 'executionMonth',         desc: 'Execution month name' },
  { token: 'executionYear',          desc: 'Execution year' },
  { token: 'termStartDate',          desc: 'Lease start date' },
  { token: 'tenantName',             desc: 'Primary tenant name' },
  { token: 'coTenantName',           desc: 'Co-tenant name' },
  { token: 'tenantBandNumber',       desc: 'Tenant band/status number' },
  { token: 'tenantDOB',              desc: 'Tenant date of birth' },
  { token: 'tenantPhone',            desc: 'Tenant phone' },
  { token: 'tenantEmail',            desc: 'Tenant email' },
  { token: 'tenantEmergencyContact', desc: 'Emergency contact name & phone' },
  { token: 'residenceLot',           desc: 'Lot number' },
  { token: 'residenceStreet',        desc: 'Street address' },
  { token: 'residenceBedBath',       desc: 'Bedroom/bathroom description' },
  { token: 'residenceStream',        desc: 'Housing stream/program' },
  { token: 'residenceAllocDate',     desc: 'Allocation date' },
  { token: 'rentAmount',             desc: 'Monthly rent amount' },
  { token: 'landlordName',           desc: 'Housing Manager name' },
  { token: 'occupant1Name',          desc: 'Occupant 1 name' },
  { token: 'occupant2Name',          desc: 'Occupant 2 name' },
  { token: 'occupant3Name',          desc: 'Occupant 3 name' },
  { token: 'occupant4Name',          desc: 'Occupant 4 name' },
  { token: 'occupant5Name',          desc: 'Occupant 5 name' },
  { token: 'occupant6Name',          desc: 'Occupant 6 name' },
  { token: 'occupant1Relationship',  desc: 'Occupant 1 relationship' },
  { token: 'occupant2Relationship',  desc: 'Occupant 2 relationship' },
  { token: 'occupant3Relationship',  desc: 'Occupant 3 relationship' },
  { token: 'occupant4Relationship',  desc: 'Occupant 4 relationship' },
  { token: 'occupant5Relationship',  desc: 'Occupant 5 relationship' },
  { token: 'occupant6Relationship',  desc: 'Occupant 6 relationship' },
  // Contractor agreement tokens
  { token: 'rfqNumber',                desc: 'RFQ number' },
  { token: 'contractNumber',           desc: 'Contract number' },
  { token: 'contractDate',             desc: 'Contract date' },
  { token: 'propertyAddress',          desc: 'Project property address' },
  { token: 'projectType',              desc: 'Project type / condition' },
  { token: 'sowReference',             desc: 'Maintenance Request project number' },
  { token: 'quoteNumber',              desc: 'Quote / RFQ number' },
  { token: 'startDate',                desc: 'Work start date' },
  { token: 'substantialCompletionDate',desc: 'Substantial completion date' },
  { token: 'totalCompletionDate',      desc: 'Total completion date' },
  { token: 'contractorLegalName',      desc: 'Contractor legal name' },
  { token: 'contractorOperatingName',  desc: 'Contractor operating name' },
  { token: 'contractorAddressLine1',   desc: 'Contractor address line 1' },
  { token: 'contractorAddressLine2',   desc: 'Contractor address line 2' },
  { token: 'contractorGstHst',         desc: 'Contractor GST/HST number' },
  { token: 'contractorWsib',           desc: 'Contractor WSIB number' },
  { token: 'contractorPhone',          desc: 'Contractor phone' },
  { token: 'contractorSignatoryName',  desc: 'Contractor signatory name' },
  { token: 'contractorSignatoryTitle', desc: 'Contractor signatory title' },
  { token: 'contractorSignatoryEmail', desc: 'Contractor signatory email' },
  { token: 'contractorSiteLead',       desc: 'Site lead name' },
  { token: 'contractorSiteLeadPhone',  desc: 'Site lead phone' },
  { token: 'contractPrice',            desc: 'Award / contract price (formatted)' },
  { token: 'contractPriceExclTax',     desc: 'Contract price excluding tax' },
  { token: 'apEmail',                  desc: 'Accounts payable email' },
  { token: 'clfnSignatoryName',        desc: 'Nation signatory name' },
  { token: 'clfnSignatoryTitle',       desc: 'Nation signatory title' },
  { token: 'sowSummary',               desc: 'Maintenance request summary' },
  { token: 'sowDetailTable',           desc: 'Detailed work packages' },
  { token: 'materialsSpecifications',  desc: 'Materials and specifications' },
  { token: 'exclusionsAssumptions',    desc: 'Exclusions and assumptions' },
  { token: 'clfnSuppliedItems',        desc: 'Items supplied by Nation' },
  { token: 'priceMaterials',           desc: 'Materials total' },
  { token: 'priceLabour',              desc: 'Labour total' },
  { token: 'priceEquipment',           desc: 'Equipment total' },
  { token: 'priceOther',               desc: 'Other costs total' },
  { token: 'priceSubtotal',            desc: 'Subtotal (excl. tax, auto-calculated)' },
  { token: 'priceTax',                 desc: 'Tax total' },
  { token: 'priceTotalInclTax',        desc: 'Total incl. tax (auto-calculated)' },
  { token: 'labourHours',              desc: 'Total labour hours' },
  { token: 'holdbackRelease',          desc: 'Holdback release amount' }
];

function _contractDocConfig(docKey) {
  for (var i = 0; i < CONTRACTS_DOCS_REGISTRY.length; i++) {
    if (CONTRACTS_DOCS_REGISTRY[i].key === docKey) return CONTRACTS_DOCS_REGISTRY[i];
  }
  return null;
}

function getContractBody(docKey) {
  var saved = (window._appSettings && window._appSettings.contracts_agreements
            && window._appSettings.contracts_agreements[docKey]) || {};
  if (saved.bodyHtml != null && saved.bodyHtml !== '') {
    // Guard against corrupted saves (e.g. body saved before H1/H2/H3 were
    // whitelisted in the sanitizer — headings were stripped, leaving only
    // flat text that renders as a blank document). A real contract body
    // has many hundreds of characters of plain text; < 300 means it's broken.
    var plainLen = saved.bodyHtml.replace(/<[^>]+>/g, '').trim().length;
    if (plainLen >= 300) return saved.bodyHtml;
  }
  var cfg = _contractDocConfig(docKey);
  return cfg ? cfg.defaultBody : '';
}

function getContractClauses(docKey) {
  var saved = (window._appSettings && window._appSettings.contracts_agreements
            && window._appSettings.contracts_agreements[docKey]) || {};
  if (saved.initials_clauses && saved.initials_clauses.length) return saved.initials_clauses;
  var cfg = _contractDocConfig(docKey);
  return (cfg && cfg.defaultClauses) ? cfg.defaultClauses : [];
}

// ── Contracts tab renderer ─────────────────────────────────────────────────

var _contractsSelectedDoc = null;

function renderContractsTab() {
  var body = document.getElementById('contracts_panel_body');
  if (!body) return;
  if (!_contractsSelectedDoc) _contractsSelectedDoc = CONTRACTS_DOCS_REGISTRY[0] && CONTRACTS_DOCS_REGISTRY[0].key;

  body.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:2px 2px 12px;margin-bottom:4px;border-bottom:1px solid var(--border);">'
    +   '<label style="display:inline-flex;align-items:center;gap:7px;font-size:13px;font-weight:600;cursor:pointer;">'
    +     '<input type="checkbox" ' + (_docSigsHidden() ? 'checked ' : '') + 'onchange="toggleHideSignatures(this)"/>'
    +     'Hide signature sections on generated documents'
    +   '</label>'
    +   '<span style="font-size:11px;color:var(--muted);">Applies to the RFQ, contract, maintenance request & work order PDFs. The housing application always keeps its signatures.</span>'
    + '</div>'
    + '<div class="ntf-grid">'
    +   '<div class="ntf-event-list" id="contracts_doc_list">' + _contractsRenderDocListHtml() + '</div>'
    +   '<div class="ntf-editor"     id="contracts_editor">'   + _contractsRenderEditorHtml(_contractsSelectedDoc) + '</div>'
    + '</div>';

  _contractsWireDocListClicks();
  _contractsWireEditor();
}

function _contractsRenderDocListHtml() {
  return CONTRACTS_DOCS_REGISTRY.map(function(doc) {
    var isActive = doc.key === _contractsSelectedDoc;
    return '<button type="button" data-contracts-doc="' + _ntfEsc(doc.key) + '" '
         + 'class="ntf-event-item' + (isActive ? ' is-active' : '') + '">'
         + '<span class="ntf-dot ntf-dot-on" title="Active"></span>'
         + '<div class="ntf-event-text">'
         +   '<div class="ntf-event-label">' + _ntfEsc(doc.label) + '</div>'
         +   '<div class="ntf-event-desc">'  + _ntfEsc(doc.description || '') + '</div>'
         + '</div>'
         + '</button>';
  }).join('');
}

function _contractsRenderEditorHtml(docKey) {
  var cfg = _contractDocConfig(docKey);
  if (!cfg) return '<div class="empty-state-italic">Select a document from the list to edit it.</div>';
  if (cfg.special === 'rfq_strings') return _rfqDocEditorHtml();

  var saved     = (window._appSettings && window._appSettings.contracts_agreements
                && window._appSettings.contracts_agreements[docKey]) || {};
  var bodyHtml  = (saved.bodyHtml != null && saved.bodyHtml !== '') ? saved.bodyHtml : cfg.defaultBody;
  var clauses   = (saved.initials_clauses && saved.initials_clauses.length)
                ? saved.initials_clauses : (cfg.defaultClauses || []);

  var toolbar =
      '<div class="ntf-toolbar" role="toolbar">'
    +   '<button type="button" class="ntf-tool" data-ntf-cmd="bold"                title="Bold"><b>B</b></button>'
    +   '<button type="button" class="ntf-tool" data-ntf-cmd="italic"              title="Italic"><i>I</i></button>'
    +   '<button type="button" class="ntf-tool" data-ntf-cmd="underline"           title="Underline"><u>U</u></button>'
    +   '<span class="ntf-tool-sep"></span>'
    +   '<button type="button" class="ntf-tool" data-ntf-cmd="formatBlock-h2"      title="Heading 2">H2</button>'
    +   '<button type="button" class="ntf-tool" data-ntf-cmd="formatBlock-h3"      title="Heading 3">H3</button>'
    +   '<button type="button" class="ntf-tool" data-ntf-cmd="formatBlock-p"       title="Paragraph">&para;</button>'
    +   '<button type="button" class="ntf-tool" data-ntf-cmd="insertUnorderedList" title="Bullet list">&bull;</button>'
    +   '<button type="button" class="ntf-tool" data-ntf-cmd="insertOrderedList"   title="Numbered list">1.</button>'
    + '</div>';

  // Token reference chips
  var tokenChips = _CONTRACT_TOKENS.map(function(t) {
    return '<span class="contracts-token-chip" title="' + _ntfEsc(t.desc) + '" '
         + 'onclick="_contractsInsertToken(\'' + _ntfEsc(t.token) + '\')">'
         + '{' + _ntfEsc(t.token) + '}'
         + '</span>';
  }).join('');

  // Clauses editor
  var clausesHtml = clauses.map(function(cl, i) {
    return _contractsClauseCardHtml(cl, i);
  }).join('');

  return ''
    + '<div class="ntf-editor-header">'
    +   '<div class="ntf-editor-title">' + _ntfEsc(cfg.label) + '</div>'
    +   '<div class="ntf-editor-meta">Edit the full agreement text. Use {tokens} for tenant-specific data. Content is rendered to PDF when generating the lease.</div>'
    + '</div>'

    + '<div class="ntf-field">'
    +   '<label class="ntf-label">Document Body</label>'
    +   toolbar
    +   '<div id="contracts_body" class="ntf-body" contenteditable="true" style="min-height:320px;">' + bodyHtml + '</div>'
    + '</div>'

    + '<div style="margin:10px 0 6px;">'
    +   '<details>'
    +     '<summary style="cursor:pointer;font-size:12px;font-weight:600;color:var(--muted);user-select:none;">&#128196; Available {tokens} &mdash; click to insert</summary>'
    +     '<div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:5px;">' + tokenChips + '</div>'
    +   '</details>'
    + '</div>'

    + '<div style="margin-top:20px;">'
    +   '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--muted);margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid var(--border);">Initials Clauses</div>'
    +   '<div style="font-size:11px;color:var(--muted);margin-bottom:12px;">Each clause is presented to the tenant step-by-step for initialling before the PDF is generated. {tokens} are substituted at generation time.</div>'
    +   '<div id="contracts_clauses_list">' + clausesHtml + '</div>'
    +   '<button type="button" class="btn btn-ghost" style="margin-top:10px;" onclick="addContractsClause()">+ Add Clause</button>'
    + '</div>'

    + '<div class="ntf-actions">'
    +   '<button type="button" class="btn btn-primary" onclick="saveContractsDoc()">Save</button>'
    +   '<button type="button" class="btn btn-ghost"   onclick="resetContractsDoc()">Reset to Default</button>'
    +   '<button type="button" class="btn btn-ghost" style="color:var(--danger,#dc2626);" onclick="clearContractsSavedBody()" title="Remove saved override — generates will use the registry default">Clear Saved Body</button>'
    + '</div>';
}

function _contractsWireDocListClicks() {
  var list = document.getElementById('contracts_doc_list');
  if (!list) return;
  list.querySelectorAll('[data-contracts-doc]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      _contractsSelectedDoc = btn.getAttribute('data-contracts-doc');
      list.innerHTML = _contractsRenderDocListHtml();
      var ed = document.getElementById('contracts_editor');
      if (ed) ed.innerHTML = _contractsRenderEditorHtml(_contractsSelectedDoc);
      _contractsWireDocListClicks();
      _contractsWireEditor();
    });
  });
}

function _contractsWireEditor() {
  var editorEl = document.getElementById('contracts_editor');
  var bodyEl   = document.getElementById('contracts_body');
  if (!editorEl || !bodyEl) return;

  editorEl.querySelectorAll('.ntf-tool').forEach(function(btn) {
    if (btn.getAttribute('data-ntf-bound') === '1') return;
    btn.setAttribute('data-ntf-bound', '1');
    btn.addEventListener('mousedown', function(e) { e.preventDefault(); });
    btn.addEventListener('click', function(e) {
      e.preventDefault();
      _ntfRunToolbarCmd(btn.getAttribute('data-ntf-cmd'), bodyEl);
    });
  });

  if (!bodyEl.getAttribute('data-paste-wired')) {
    bodyEl.setAttribute('data-paste-wired', '1');
    bodyEl.addEventListener('paste', function(e) {
      e.preventDefault();
      var html = (e.clipboardData && e.clipboardData.getData('text/html')) || '';
      if (!html) {
        var text = (e.clipboardData && e.clipboardData.getData('text/plain')) || '';
        html = '<p>' + text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
                           .replace(/\n\n+/g,'</p><p>').replace(/\n/g,'<br>') + '</p>';
      }
      document.execCommand('insertHTML', false, _ntfSanitizeBodyHtml(html));
    });
  }

  // Store reference to body so _contractsInsertToken can find it
  window._contractsBodyEl = bodyEl;
}

function _contractsInsertToken(token) {
  var bodyEl = window._contractsBodyEl || document.getElementById('contracts_body');
  if (!bodyEl) return;
  bodyEl.focus();
  document.execCommand('insertText', false, '{' + token + '}');
}

// ── Save / reset ──────────────────────────────────────────────────────────

function _contractsReadClauses() {
  var clauses = [];
  var i = 0;
  while (document.getElementById('contracts_clause_label_' + i)) {
    var labelEl = document.getElementById('contracts_clause_label_' + i);
    var textEl  = document.getElementById('contracts_clause_text_'  + i);
    var idEl    = document.getElementById('contracts_clause_id_'    + i);
    var label   = (labelEl ? labelEl.value : '').trim();
    var text    = (textEl  ? textEl.value  : '').trim();
    var id      = (idEl    ? idEl.value    : '').trim() || ('ls_custom_' + i);
    if (label || text) {
      clauses.push({ id: id, label: label, text: text });
    }
    i++;
  }
  return clauses;
}

function saveContractsDoc() {
  if (!_cfgEdGuard('Only the Executive Director can edit contracts')) return;
  if (!_contractsSelectedDoc) { showToast('Select a document first', {type:'error'}); return; }

  var bodyEl = document.getElementById('contracts_body');
  if (!bodyEl) { showToast('Editor not ready', {type:'info'}); return; }

  var bodyHtml = _ntfSanitizeBodyHtml(bodyEl.innerHTML || '');
  if (!bodyHtml || bodyHtml === '<br>' || bodyHtml.replace(/<[^>]+>/g, '').trim() === '') {
    showToast('Document body cannot be empty', {type:'error'}); bodyEl.focus(); return;
  }

  var clauses = _contractsReadClauses();
  if (!clauses.length) { showToast('Add at least one initials clause', {type:'error'}); return; }

  var all  = (window._appSettings && window._appSettings.contracts_agreements) || {};
  var next = Object.assign({}, all);
  next[_contractsSelectedDoc] = { bodyHtml: bodyHtml, initials_clauses: clauses };

  persistSetting('contracts_agreements', next, {
    auditAction: 'contracts_save',
    auditDetail: 'Contracts & Agreements updated: ' + _contractsSelectedDoc,
    okMsg:       '✓ Contract saved'
  });
}

// ── RFQ Bid Document editor (headings + labels) ──────────────────────────────
var _RFQDOC_EDIT_KEYS = [
  ['Section Headings', [
    ['h_project',   'Project Details heading'],
    ['h_bidform',   'Bid Form heading'],
    ['h_breakdown', 'Cost Breakdown heading'],
    ['h_mandatory', 'Mandatory Inclusions heading'],
    ['h_submission','Submission Instructions heading']
  ]],
  ['Bid Form', [
    ['bidform_intro',    'Bid form intro', true],
    ['col_lineitem',     'Column: Line Item / Description'],
    ['col_unitprice',    'Column: Unit Price'],
    ['col_extended',     'Column: Extended Price'],
    ['col_notes',        'Column: Notes'],
    ['total_bid_amount', 'Total label']
  ]],
  ['Cost Breakdown', [
    ['breakdown_intro',   'Breakdown intro', true],
    ['breakdown_col_cat', 'Column: Category'],
    ['breakdown_col_amt', 'Column: Amount'],
    ['breakdown_total',   'Breakdown total label'],
    ['labour_hours_label','Labour hours label']
  ]],
  ['Mandatory Inclusions', [
    ['mandatory_intro', 'Mandatory intro', true]
  ]]
];
function _rfqDocEditorHtml() {
  var S = function(k){ return (typeof _rfqDocStr === 'function') ? _rfqDocStr(k) : ''; };
  var inputStyle = 'width:100%;padding:7px 9px;border:1px solid var(--border);border-radius:7px;font-size:13px;font-family:inherit;box-sizing:border-box;';
  function fieldRow(k, label, isArea) {
    var v = _ntfEsc(S(k));
    var ctrl = isArea
      ? '<textarea id="rfqdoc_' + k + '" rows="2" style="' + inputStyle + 'resize:vertical;">' + v + '</textarea>'
      : '<input id="rfqdoc_' + k + '" type="text" value="' + v + '" style="' + inputStyle + '"/>';
    return '<div style="margin-bottom:9px;"><label style="display:block;font-size:11px;font-weight:700;color:var(--muted);margin-bottom:3px;">' + _ntfEsc(label) + '</label>' + ctrl + '</div>';
  }
  var groups = _RFQDOC_EDIT_KEYS.map(function(g) {
    return '<div style="margin-top:14px;"><div style="font-size:12px;font-weight:800;color:var(--text);border-bottom:2px solid var(--yellow);padding-bottom:3px;margin-bottom:9px;">' + _ntfEsc(g[0]) + '</div>'
      + g[1].map(function(f){ return fieldRow(f[0], f[1], f[2]); }).join('') + '</div>';
  }).join('');
  var cats = (typeof _rfqDocList === 'function') ? _rfqDocList('breakdown_categories') : [];
  var catsField = '<div style="margin-top:14px;"><div style="font-size:12px;font-weight:800;color:var(--text);border-bottom:2px solid var(--yellow);padding-bottom:3px;margin-bottom:9px;">Cost Breakdown Categories</div>'
    + '<label style="display:block;font-size:11px;font-weight:700;color:var(--muted);margin-bottom:3px;">One category per line (the contractor fills in an amount for each)</label>'
    + '<textarea id="rfqdoc_breakdown_categories" rows="5" style="' + inputStyle + 'resize:vertical;">' + _ntfEsc(cats.join('\n')) + '</textarea></div>';
  var mand = (typeof _rfqDocList === 'function') ? _rfqDocList('mandatory_items') : [];
  var mandField = '<div style="margin-top:14px;"><div style="font-size:12px;font-weight:800;color:var(--text);border-bottom:2px solid var(--yellow);padding-bottom:3px;margin-bottom:9px;">Mandatory Inclusions List</div>'
    + '<label style="display:block;font-size:11px;font-weight:700;color:var(--muted);margin-bottom:3px;">One item per line. Use <code>{short}</code> for your nation code and <code>{nation}</code> for the full name (e.g. &ldquo;working with {short} Housing&rdquo;).</label>'
    + '<textarea id="rfqdoc_mandatory_items" rows="8" style="' + inputStyle + 'resize:vertical;">' + _ntfEsc(mand.join('\n')) + '</textarea></div>';
  return ''
    + '<div class="ntf-editor-header">'
    +   '<div class="ntf-editor-title">RFQ Bid Document</div>'
    +   '<div class="ntf-editor-meta">Edit the headings and labels on the RFQ bid document sent to contractors. Leave a field blank to use the default. The Scope and Bid Form tables fill in automatically from the request.</div>'
    + '</div>'
    + '<div style="padding:2px 2px 8px;">' + groups + catsField + mandField
    +   '<div style="margin-top:16px;display:flex;gap:8px;">'
    +     '<button type="button" class="btn btn-primary" onclick="saveRfqDocumentStrings()">Save</button>'
    +     '<button type="button" class="btn btn-ghost" onclick="resetRfqDocumentStrings()">Reset to defaults</button>'
    +   '</div>'
    + '</div>';
}
function saveRfqDocumentStrings() {
  if (!_cfgEdGuard('Only the Executive Director can edit contracts')) return;
  var g = function(id){ var e = document.getElementById(id); return e ? e.value.trim() : ''; };
  var obj = {};
  _RFQDOC_EDIT_KEYS.forEach(function(grp){
    grp[1].forEach(function(f){ var v = g('rfqdoc_' + f[0]); if (v !== '') obj[f[0]] = v; });
  });
  var catsRaw = g('rfqdoc_breakdown_categories');
  if (catsRaw !== '') {
    var cats = catsRaw.split(/\n+/).map(function(s){ return s.trim(); }).filter(Boolean);
    if (cats.length) obj.breakdown_categories = cats;
  }
  var mandRaw = g('rfqdoc_mandatory_items');
  if (mandRaw !== '') {
    var mand = mandRaw.split(/\n+/).map(function(s){ return s.trim(); }).filter(Boolean);
    if (mand.length) obj.mandatory_items = mand;
  }
  persistSetting('rfq_document', obj, {
    auditAction: 'rfq_document_save',
    auditDetail: 'RFQ bid document headings/labels updated',
    okMsg:       '✓ RFQ bid document saved'
  });
}
function resetRfqDocumentStrings() {
  persistSetting('rfq_document', {}, {
    auditAction: 'rfq_document_reset',
    auditDetail: 'RFQ bid document reset to defaults',
    okMsg:       '✓ Reset to defaults'
  });
  if (typeof renderContractsTab === 'function') renderContractsTab();
}
window.saveRfqDocumentStrings  = saveRfqDocumentStrings;
window.resetRfqDocumentStrings = resetRfqDocumentStrings;

function toggleHideSignatures(el) {
  if (!_cfgEdGuard('Only the Executive Director can change this')) { if (el) el.checked = _docSigsHidden(); return; }
  var on = !!(el && el.checked);
  persistSetting('hide_signatures', on, {
    auditAction: 'contracts_hide_signatures',
    auditDetail: 'Signature sections ' + (on ? 'hidden' : 'shown') + ' on generated documents',
    okMsg:       on ? '✓ Signature sections hidden' : '✓ Signature sections shown'
  });
}
window.toggleHideSignatures = toggleHideSignatures;

function resetContractsDoc() {
  if (!_contractsSelectedDoc) return;
  var cfg = _contractDocConfig(_contractsSelectedDoc);
  if (!cfg) return;
  var bodyEl = document.getElementById('contracts_body');
  if (bodyEl) bodyEl.innerHTML = cfg.defaultBody;
  var clausesList = document.getElementById('contracts_clauses_list');
  if (clausesList) {
    var clauses = (cfg && cfg.defaultClauses) ? cfg.defaultClauses : [];
    clausesList.innerHTML = clauses.map(function(cl, i) {
      return _contractsClauseCardHtml(cl, i);
    }).join('');
  }
  showToast('Reverted to default. Click Save to persist.', {type:'info'});
}

// Removes a stale or corrupted saved body from _appSettings so the next
// Generate uses the registry defaultBody cleanly.
function clearContractsSavedBody() {
  if (!_contractsSelectedDoc) return;
  var all  = (window._appSettings && window._appSettings.contracts_agreements) || {};
  var next = Object.assign({}, all);
  if (next[_contractsSelectedDoc]) {
    next[_contractsSelectedDoc] = Object.assign({}, next[_contractsSelectedDoc], { bodyHtml: '' });
  }
  persistSetting('contracts_agreements', next, {
    okMsg:   'Saved body cleared — Generate Contract will now use the built-in default.',
    failMsg: 'Clear failed — check connection'
  });
}

function addContractsClause() {
  var list = document.getElementById('contracts_clauses_list');
  if (!list) return;
  var i = list.querySelectorAll('.contracts-clause-card').length;
  var div = document.createElement('div');
  div.innerHTML = _contractsClauseCardHtml({ id: '', label: '', text: '' }, i);
  list.appendChild(div.firstChild);
}

function removeContractsClause(idx) {
  var list = document.getElementById('contracts_clauses_list');
  if (!list) return;
  var cards = list.querySelectorAll('.contracts-clause-card');
  if (cards[idx]) cards[idx].remove();
  // Re-index remaining cards so onclick indices stay correct
  var remaining = list.querySelectorAll('.contracts-clause-card');
  remaining.forEach(function(card, newIdx) {
    card.id = 'contracts_clause_card_' + newIdx;
    var hdr = card.querySelector('div > div:first-child');
    if (hdr) hdr.textContent = 'Clause ' + (newIdx + 1);
    var removeBtn = card.querySelector('button');
    if (removeBtn) removeBtn.setAttribute('onclick', 'removeContractsClause(' + newIdx + ')');
    var lbl = card.querySelector('input[type="text"]');
    if (lbl) lbl.id = 'contracts_clause_label_' + newIdx;
    var txt = card.querySelector('textarea');
    if (txt) txt.id = 'contracts_clause_text_' + newIdx;
  });
}

function _contractsClauseCardHtml(cl, i) {
  return '<div class="contracts-clause-card" id="contracts_clause_card_' + i + '">'
       + '<input type="hidden" id="contracts_clause_id_' + i + '" value="' + _ntfEsc(cl.id || '') + '"/>'
       + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">'
       +   '<div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;">Clause ' + (i + 1) + '</div>'
       +   '<button type="button" class="btn btn-ghost" style="padding:2px 8px;font-size:11px;" onclick="removeContractsClause(' + i + ')">Remove</button>'
       + '</div>'
       + '<div class="f" style="margin-bottom:8px;">'
       +   '<label style="font-size:11px;color:var(--muted);margin-bottom:3px;display:block;">Label</label>'
       +   '<input type="text" id="contracts_clause_label_' + i + '" value="' + _ntfEsc(cl.label || '') + '" '
       +     'style="width:100%;padding:6px 9px;border:1px solid var(--border);border-radius:5px;font-size:12px;font-family:DM Sans,sans-serif;background:var(--surface);color:var(--text);box-sizing:border-box;"/>'
       + '</div>'
       + '<div class="f">'
       +   '<label style="font-size:11px;color:var(--muted);margin-bottom:3px;display:block;">Clause text</label>'
       +   '<textarea id="contracts_clause_text_' + i + '" rows="4" '
       +     'style="width:100%;padding:6px 9px;border:1px solid var(--border);border-radius:5px;font-size:12px;font-family:DM Sans,sans-serif;background:var(--surface);color:var(--text);box-sizing:border-box;resize:vertical;">'
       +     _ntfEsc(cl.text || '')
       +   '</textarea>'
       + '</div>'
       + '</div>';
}

// ── jsPDF HTML renderer ────────────────────────────────────────────────────
// Parses HTML (as produced by the contentEditable body editor) into a
// flat list of typed blocks, then renders them to a jsPDF ctx created by
// _makePdfDoc(). Used by _ticGenerateLeasePdf() in housing-tic.js when a
// saved contract body exists.

function _parseHtmlToBlocks(html) {
  var blocks = [];
  if (!html) return blocks;
  try {
    var doc  = new DOMParser().parseFromString('<div id="r">' + html + '</div>', 'text/html');
    var root = doc.getElementById('r');
    if (!root) return blocks;

    function textOf(node) {
      return (node.textContent || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
    }

    function processNode(node) {
      if (!node.tagName) return;
      var tag = node.tagName.toUpperCase();
      if (tag === 'H1') {
        var t = textOf(node); if (t) blocks.push({ type: 'h1', text: t });
      } else if (tag === 'H2') {
        var t = textOf(node); if (t) blocks.push({ type: 'h2', text: t });
      } else if (tag === 'H3' || tag === 'H4') {
        var t = textOf(node); if (t) blocks.push({ type: 'h3', text: t });
      } else if (tag === 'P' || tag === 'DIV') {
        var t = textOf(node); if (t) blocks.push({ type: 'p', text: t });
      } else if (tag === 'OL') {
        var counter = 1;
        node.querySelectorAll('li').forEach(function(li) {
          var t = textOf(li);
          if (t) blocks.push({ type: 'li-ol', text: t, num: counter++ });
        });
      } else if (tag === 'UL') {
        node.querySelectorAll('li').forEach(function(li) {
          var t = textOf(li);
          if (t) blocks.push({ type: 'li-ul', text: t });
        });
      } else if (tag === 'BR') {
        blocks.push({ type: 'gap' });
      } else if (tag === 'HR') {
        blocks.push({ type: 'hr' });
      }
    }

    Array.prototype.slice.call(root.childNodes).forEach(processNode);
  } catch(e) {
    console.warn('[contracts pdf] HTML parse failed:', e);
  }
  return blocks;
}

function _renderBlocksToPdf(ctx, blocks) {
  var pdf      = ctx.pdf;
  var marginL  = ctx.marginL;
  var contentW = ctx.contentW;

  blocks.forEach(function(block) {
    if (block.type === 'h1') {
      // Balanced heading spacing: the baseline is drawn BELOW the cursor (y + cap
      // ascent) so the leading gap is real space above the text — not eaten by the
      // glyphs ascending over the cursor — and the trailing advance is a matching
      // bottom margin. This keeps every header evenly spaced from the paragraph
      // above and the section text below.
      ctx.needSpace(18);
      ctx.gap(3);
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(15);
      pdf.setTextColor(20);
      var lines = pdf.splitTextToSize(block.text, contentW);
      pdf.text(lines, marginL, ctx.y + 5);
      ctx.y += lines.length * 6.5 + 5;

    } else if (block.type === 'h2') {
      ctx.needSpace(15);
      ctx.gap(2);
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(12);
      pdf.setTextColor(30);
      var lines = pdf.splitTextToSize(block.text, contentW);
      pdf.text(lines, marginL, ctx.y + 4);
      ctx.y += lines.length * 5.5 + 4;

    } else if (block.type === 'h3') {
      ctx.needSpace(12);
      ctx.gap(2);
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(10);
      pdf.setTextColor(50);
      var lines = pdf.splitTextToSize(block.text, contentW);
      pdf.text(lines, marginL, ctx.y + 3.5);
      ctx.y += lines.length * 4.5 + 3.5;

    } else if (block.type === 'p') {
      // Hanging indent for lettered / numbered sub-clauses like "(a) ..." or
      // "1. ..." so agreement clauses line up under a marker gutter instead of
      // wrapping flush-left. Plain paragraphs fall through to ctx.paragraph.
      var _cm = block.text.match(/^(\([a-z0-9]{1,3}\))\s+/i);
      if (_cm) {
        var gutter = 8;
        var rest = block.text.slice(_cm[0].length);
        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(9);
        pdf.setTextColor(40);
        var cLines = pdf.splitTextToSize(rest, contentW - gutter);
        var cH = cLines.length * 4 + 2;
        ctx.needSpace(cH);
        pdf.text(_cm[1], marginL, ctx.y + 3);
        pdf.text(cLines, marginL + gutter, ctx.y + 3);
        ctx.y += cH;
        pdf.setTextColor(0);
      } else {
        ctx.paragraph(block.text, 9);
      }
      ctx.gap(1.5);

    } else if (block.type === 'li-ol') {
      var indent = 5, numW = 9;
      var textW  = contentW - indent - numW;
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(9);
      pdf.setTextColor(40);
      var textLines = pdf.splitTextToSize(block.text, textW);
      var h = textLines.length * 4.5 + 1;
      ctx.needSpace(h);
      pdf.text(block.num + '.', marginL + indent, ctx.y + 3.5);
      pdf.text(textLines,       marginL + indent + numW, ctx.y + 3.5);
      ctx.y += h;

    } else if (block.type === 'li-ul') {
      var indent = 5, bulletW = 5;
      var textW  = contentW - indent - bulletW;
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(9);
      pdf.setTextColor(40);
      var textLines = pdf.splitTextToSize(block.text, textW);
      var h = textLines.length * 4.5 + 1;
      ctx.needSpace(h);
      pdf.text('•', marginL + indent, ctx.y + 3.5);
      pdf.text(textLines, marginL + indent + bulletW, ctx.y + 3.5);
      ctx.y += h;

    } else if (block.type === 'gap') {
      ctx.gap(3);

    } else if (block.type === 'hr') {
      ctx.needSpace(5);
      pdf.setDrawColor(200);
      pdf.setLineWidth(0.3);
      pdf.line(marginL, ctx.y + 2, marginL + contentW, ctx.y + 2);
      pdf.setDrawColor(0);
      ctx.y += 5;
    }

    pdf.setTextColor(0);
    pdf.setFont('helvetica', 'normal');
  });
}
