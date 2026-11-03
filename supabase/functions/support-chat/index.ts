// ============================================================================
// support-chat - Help Assistant for the housing app (Phase S2).
//
// A conversational support bot for ALL signed-in audiences (staff, community
// members, contractors). It answers how-to / troubleshooting questions grounded
// in a built-in knowledge base scoped to the caller's audience, plus an optional
// per-nation FAQ passed from the client. It has NO data tools and NO privileged
// access - it only gives help. When it cannot resolve something (a real bug, an
// account/data problem, anything needing a human), it tells the user to use the
// "Report an issue to a person" button, which files a support ticket.
//
// Auth: requires a valid Supabase user JWT (any signed-in user). The caller's
// audience is taken from the client but only scopes which how-tos the bot uses;
// a staff email is confirmed against the staff table so members cannot get the
// staff knowledge base. No secret beyond the project's ANTHROPIC_API_KEY (shared
// with ai-chat). Source MUST stay ASCII-only.
//
// Deploy: supabase functions deploy support-chat  (or the functions workflow).
// ============================================================================

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const ANTHROPIC_KEY        = Deno.env.get('ANTHROPIC_API_KEY')
const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')
const SUPABASE_ANON_KEY    = Deno.env.get('SUPABASE_ANON_KEY')
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

const MODEL        = 'claude-sonnet-5-5'
const MAX_HISTORY  = 16    // cap the conversation turns sent to the model

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

// ---- Knowledge base (concise how-tos; keep ASCII) ---------------------------
const KB_STAFF = [
  'STAFF HOW-TO:',
  '- New application: Applications -> New Application. Fill the wizard (applicant, household, income, references, documents). Save Draft keeps it under My Drafts; Submit sends it to the Housing Manager for review.',
  '- Approve an application: open it from the worklist or Applications, review the scorecard, then Recommend / HM Approve / ED Approve per your role. Scored applications must have the staff scoring screens completed first.',
  '- Match a unit: an approved application appears on Match (and "Ready to Match" on the landing worklist). Click Assign to open the Assign-Unit modal, or open a vacant unit and use its Matches tab.',
  '- Maintenance Request (work order): open a unit -> Maintenance Requests tab -> New Maintenance Request. Add work items, assign in-house crew or a contractor, Save Draft or Submit for approval. ("Maintenance Request" is the current name for what the system also calls a SOW / Scope of Work / work order - they are the same thing.)',
  '- Inspections: Operations -> Inspections -> New Inspection. Pick the unit and type, fill the room checklist, add photos, Save. A failed item can create a Maintenance Request.',
  '- Contractors: Operations -> Contractors. Add/edit a contractor, add Key People, and Invite to portal.',
  '- Reports / exports: most list pages (Inventory, Match, Renos) have an Export button (CSV/Excel).',
  '- Settings are under the gear / Settings menu (ED/Housing Manager): Approval Authority, Scoring, Users (incl. 2FA policy), Nation/Modules, Notifications, and the Help & Support FAQ / floating Help button.',
  '',
  'ROLES: Executive Director (ED), Housing Manager, Housing Employee L2, Housing Employee L1, Field Employee (maintenance crew), CFO, Finance Clerk L1. ED and Housing Manager are "management" - they see approvals, Settings, and the full worklist. A Field Employee is in-house maintenance labour: they use Inventory and Renovations, can create/edit Maintenance Requests, complete work orders, and edit progress reports, but are kept out of applications, approvals, finance, and settings.',
  '',
  'WORK ORDERS FOR THE CREW (Field Employees):',
  '- A Field Employee only sees in-house work orders (Maintenance Requests) that are ASSIGNED TO THEM - unassigned in-house work is invisible to the crew until a Housing Manager or ED assigns a key person.',
  '- WHEN A NEW WORK ORDER IS ASSIGNED TO A CREW MEMBER: assigning an in-house Maintenance Request to a Field Employee and submitting it emails that crew member a work-order notification (to the email on their staff record), and the job appears in their "Work Orders to Complete" list on their home page. Re-submitting with the same assignee does not re-notify them.',
  '- Setting the assignee: inside the Maintenance Request, the "Assigned To" control chooses in-house crew vs a contractor; picking in-house lets you choose a Field Employee. This control is limited to Housing Manager / ED by default.',
  '',
  'NOTIFICATIONS (email): the app sends staff/applicant/contractor emails on key workflow steps - application submitted, recommended, approved, returned, or declined; a new Maintenance Request; a work order assigned to a Field Employee; a work order sent to a contractor; contractor submitted, approved, returned, or declined; and RFQ award, regret, or cancellation. The ED can turn each event on/off, choose which roles receive it, and edit the subject and body in Settings -> Notifications.',
  '',
  'APPROVALS: a submitted application is recommended by the Housing Manager and then approved by the ED (exact steps depend on role and your nation Approval Authority settings). A Maintenance Request whose cost is over the Housing Manager budget limit needs ED sign-off.',
  '',
  'RFQs (Requests for Quotes): from a Maintenance Request you can start an RFQ to invite contractors to bid, record their bids on the Recipients tab, award the chosen bid, and generate a contract. Awarding an RFQ approves the linked Maintenance Request automatically. RFQ editing is limited to Housing Manager / ED.',
  '',
  'CONTRACTOR PORTAL: a contractor you invite (from their Contractor card) can sign in by text-message code and see only their assigned work orders, where they upload photos, invoices, notes, and percent-complete; those come back to staff on the landing-page worklist under "Contractor Submissions".',
].join('\n')

const KB_MEMBER = [
  'COMMUNITY MEMBER (portal) HOW-TO:',
  '- Apply for housing: open the member portal and start/continue your application. Your progress is saved; you can return to it later.',
  '- Check your application status: it shows on your portal home once submitted.',
  '- Report a maintenance issue for your home: use the maintenance / report option in the portal (or scan the QR code posted at the unit).',
  '- Sign-in is by the email link sent to you; if the link expired, request a new one from the sign-in screen.',
].join('\n')

const KB_CONTRACTOR = [
  'CONTRACTOR (portal) HOW-TO:',
  '- Sign in: enter your mobile number to get a one-time code by text, then enter the code.',
  '- You only see work orders assigned to you.',
  '- For a work order you can: upload photos, upload an invoice, add a note, and set the percent complete.',
  '- If you were invited but cannot sign in, your mobile number must match the one the housing office has on file - contact them to confirm it.',
].join('\n')

function kbFor(source: string): string {
  if (source === 'member') return KB_MEMBER
  if (source === 'contractor') return KB_CONTRACTOR
  return KB_STAFF
}

function buildSystem(source: string, nationName: string, faqText: string): string {
  const who = source === 'member' ? 'a community member using the resident/applicant portal'
            : source === 'contractor' ? 'a contractor using the contractor portal'
            : 'a housing staff member using the staff app'
  const parts = [
    'You are the Help Assistant for ' + (nationName || 'a First Nations') + ' housing management software.',
    'You are talking to ' + who + '.',
    'Answer their how-to and troubleshooting questions about using the app, in clear, friendly, plain language. Keep replies short (a few sentences or a short numbered list). Use only the knowledge below and widely-known general help; do not invent features, menus, or policies.',
    'The knowledge below is accurate for THIS app. When it covers the question, answer it directly and confidently - give the steps or the fact. Do NOT add hedges like "I do not have details" or "I cannot say for sure" when the answer is in the knowledge; only say you are unsure when the question is genuinely outside it. A single short "if that is not what you are seeing, Report an issue to a person" line at the end is fine, but do not lead with doubt about things the knowledge answers.',
    'If you are genuinely unsure, if it is a real bug, if it is an account/data problem, or if it needs a person (e.g. "my unit is wrong", "I was charged twice", "nothing loads"), say so plainly and tell them to tap the "Report an issue to a person" button to send it to the housing help desk. Do not promise timelines.',
    'Never ask for or accept passwords, one-time codes, or banking details. Do not give legal, financial, or eligibility decisions - route those to staff.',
    '',
    kbFor(source),
  ]
  if (faqText && faqText.trim()) {
    parts.push('', 'NATION FAQ (authoritative for this nation; prefer it when relevant):', faqText.trim().slice(0, 4000))
  }
  return parts.join('\n')
}

// Returns the upstream status + parsed body instead of throwing, so the handler
// can diagnose BOTH a non-200 from Anthropic and a 200 with empty content.
async function callClaude(system: string, messages: unknown[]): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 700, system, messages }),
  })
  let data: Record<string, unknown> = {}
  try { data = await r.json() } catch (_e) { data = {} }
  return { ok: r.ok, status: r.status, data }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    if (!ANTHROPIC_KEY) return json({ error: 'ANTHROPIC_API_KEY secret not set on this function' }, 500)
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return json({ error: 'Supabase env not configured' }, 500)

    // Require a valid Supabase user JWT (any signed-in user).
    const authHeader = req.headers.get('Authorization') || ''
    if (!authHeader.startsWith('Bearer ')) return json({ error: 'Missing or malformed Authorization header' }, 401)
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } })
    const { data: { user }, error: authErr } = await userClient.auth.getUser()
    if (authErr || !user) return json({ error: 'Please sign in to use the help assistant.' }, 401)

    const body = await req.json()
    let source: string = (body.source === 'member' || body.source === 'contractor') ? body.source : 'staff'

    // Confirm staff claims against the staff table so a non-staff caller cannot
    // pull the staff knowledge base by sending source:'staff'.
    if (source === 'staff') {
      let isStaff = false
      const email = (user.email || '').toLowerCase()
      if (email && SUPABASE_SERVICE_KEY) {
        const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
        const { data: rows } = await admin.from('staff').select('email').eq('email', email).eq('is_active', true).limit(1)
        isStaff = !!(rows && rows.length)
      }
      if (!isStaff) source = 'member'
    }

    // Build the message list from the conversation history + the new message.
    const message: string = String(body.message || '').slice(0, 4000)
    if (!message.trim()) return json({ error: 'Empty message' }, 400)
    const history = Array.isArray(body.history) ? body.history.slice(-MAX_HISTORY) : []
    const messages: unknown[] = []
    for (const h of history) {
      const role = (h && h.role === 'assistant') ? 'assistant' : 'user'
      const text = String((h && h.text) || '').slice(0, 4000)
      if (text) messages.push({ role, content: text })
    }
    messages.push({ role: 'user', content: message })

    const nationName = String(body.nation_name || '').slice(0, 120)

    // Pull the nation's editable Support FAQ server-side (service role) so it
    // applies to every audience, including the portals which do not load the
    // app settings. Falls back to any client-passed faq.
    let faqText = String(body.faq || '')
    if (SUPABASE_SERVICE_KEY) {
      try {
        const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
        const { data: frows } = await admin.from('housing_settings').select('value').eq('key', 'support_faq').limit(1)
        if (frows && frows.length && frows[0].value) {
          const v = frows[0].value
          faqText = (typeof v === 'string') ? v : JSON.stringify(v)
        }
      } catch (_e) { /* fall back to the client-passed faq */ }
    }

    const res = await callClaude(buildSystem(source, nationName, faqText), messages)
    const data = res.data || {}
    // Join ALL text blocks (not just content[0]), matching ai-chat, so a leading
    // non-text block does not blank the answer.
    let reply = ''
    try {
      const blocks: any[] = Array.isArray((data as any).content) ? (data as any).content : []
      reply = blocks.filter((b) => b && b.type === 'text').map((b) => String(b.text || '')).join('\n').trim()
    } catch (_e) { reply = '' }
    if (!reply) {
      // Non-200 from Anthropic, or an empty completion: log for ops and give a
      // graceful fallback that points the user to the human help desk.
      if (!res.ok) console.error('[support-chat] upstream ' + res.status + ' ' + JSON.stringify(data).slice(0, 200))
      reply = res.ok
        ? 'Sorry, I could not answer that. Please use the "Report an issue to a person" button to reach the help desk.'
        : 'The help assistant is temporarily unavailable. Please use the "Report an issue to a person" button.'
    }
    return json({ reply })
  } catch (e) {
    return json({ error: 'support-chat failed', detail: String((e as Error)?.message || e).slice(0, 300) }, 500)
  }
})
