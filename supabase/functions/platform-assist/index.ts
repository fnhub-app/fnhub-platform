// ============================================================================
// platform-assist - Admin assistant for the Nation Pathways control plane.
//
// A conversational help assistant for the platform admin panel (admin.fnhub.app).
// It answers how-to questions about running the control plane - provisioning a
// nation, modules + licensing, the AI and email/SMS keys, fleet migrations,
// billing / invoices / recurring billing, resellers + commission, the Business
// profile, the aggregated Support inbox, the Requests build-prompt queue, and
// generating the subscription / consulting agreements - grounded in a built-in
// knowledge base. It has NO data tools and NO privileged data access; it only
// gives help.
//
// Auth: requires a valid Supabase user JWT AND that the caller is a platform
// super-admin (checked against the control-plane `super_admins` table with the
// service role). Non-admins are refused. Deployed to the PLATFORM project with
// JWT verify ON. The only secret beyond the auto-injected ones is the platform
// project's ANTHROPIC_API_KEY. Source MUST stay ASCII-only.
//
// Deploy: deploy-platform-functions.yml (platform project).
// ============================================================================

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const ANTHROPIC_KEY        = Deno.env.get('ANTHROPIC_API_KEY')
const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')
const SUPABASE_ANON_KEY    = Deno.env.get('SUPABASE_ANON_KEY')
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

const MODEL        = 'claude-sonnet-5-5'
const MAX_HISTORY  = 16

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

// ---- Control-plane knowledge base (concise how-tos; keep ASCII) -------------
const KB_ADMIN = [
  'CONTROL PLANE OVERVIEW: this is the Nation Pathways admin panel (admin.fnhub.app), which runs on the control-plane Supabase project, separate from each nation. From the left rail you manage every nation, provisioning, billing, resellers, migrations, support, and build requests. Each nation is database-per-nation and subdomain-per-nation; a nation subscribes to the platform and licenses optional modules.',
  '',
  'NATIONS: Dashboard -> Nations lists every nation. Open one to get its detail card with tabs: Overview (status, modules, Sold by), Supabase, Email Config, Email Intake, SMS, Agreements, Finance, Notes, Documents.',
  '',
  'ADD / PROVISION A NATION:',
  '- Add a nation: Dashboard -> Add a nation registers a nation in the platform directory (subdomain, display name, Supabase URL + anon key, licensed modules).',
  '- Provision: Dashboard -> Provision is the assisted wizard. You create the new Supabase project yourself, then the wizard runs the schema, creates the storage bucket, creates the first ED sign-in, and writes the registry row. The service_role key is used once and never stored.',
  '- Full onboarding checklist (migrations, secrets, Cloudflare routing, test) lives on the Provision tab guides and the per-nation setup checklist (Overview).',
  '',
  'MODULES + LICENSING: a nation Overview -> Modules card lists optional modules (finance, match, contractors, renovations, rfq, mapping, ai_assistant, inspections, projects, email_intake, sms_notifications, contractor_portal, support, custom_module). Ticking a module ON LICENSES AND ENABLES it. For billable add-ons (AI Staff Assistant, SMS / Text Notifications) the explicit ON is what puts the line on the nation invoice.',
  '',
  'AI ASSISTANT KEY: a nation Dashboard -> Config -> AI Assistant key sets the PLATFORM OWNER (Nation Pathways) Anthropic key onto that nation project (the ANTHROPIC_API_KEY secret that ai-chat and support-chat read). Nation Pathways supplies and pays for this key - the nation never provides its own and has no separate Anthropic bill. There is also a per-nation monthly AI token cap (default 3,000,000) set here. The nation also needs the ai-chat function deployed to its project.',
  '',
  'EMAIL CONFIG: a nation Email Config tab sets its outbound email provider - Microsoft 365 (Graph, sends from the nation mailbox), Resend, or SendGrid (verified domain, e.g. the already-verified fnhub.app). Fill the From identity + reply-to, Save changes, then Apply to project with the provider API key - the panel writes the EMAIL_* secrets onto the nation project. Provider-side setup (Entra app for Graph, domain verification for Resend) is manual; see the Email delivery setup guide on Provision.',
  '',
  'SMS / TEXT: a nation SMS tab configures the text provider (Twilio) - the sender number or a Messaging Service SID. Texting also needs the sms_notifications module ON and, per event, the Text toggle in that nation Settings -> Notifications, and each recipient opted in. If texts do not send, those are the gates to check.',
  '',
  'FLEET MIGRATIONS: Dashboard -> Migrations runs a SQL migration across every nation at once. Give the EXACT filename under supabase/migrations/ including the .sql extension (e.g. 20261101_contractor_portal_b1.sql), NOT just a date prefix. Control-plane (platform) tables are run in the fnhub-platform SQL Editor instead, not the fleet tool.',
  '',
  'BUSINESS PROFILE: Dashboard -> Business profile holds the owner entity details (Proctor Solutions, operating the Nation Pathways brand) - the logo, business name, address, contacts and signatory used on generated invoices and contracts. Upload the logo here; it flows onto invoice + contract PDFs.',
  '',
  'FINANCE (per nation): a nation Finance tab is laid out like the app TIC card - a KPI strip on top (Outstanding / Paid / Next / Overdue), then inner tabs: Invoices (status chips, Export CSV, a collapsible New invoice builder with the flat-plan + add-on quick-adds), Projects (a per-nation project / PO list), Time & activities (a daily timesheet tagged to a project + a branching service category, billed into an invoice), and Recurring billing (the auto-invoice schedule). Pricing is the flat per-home plan (base + per-home/month) plus add-ons (AI, SMS) and hourly consulting/travel; never retype a price - it comes from the fee schedule.',
  '',
  'AGREEMENTS: a nation Agreements tab generates two PDFs from the party details - the Software Subscription Agreement and the Consulting Services Agreement. Both use the Business profile party + logo. The subscription agreement Schedule D lists the third-party subprocessors (Supabase, Cloudflare, email provider, Anthropic, OpenStreetMap, SMS provider).',
  '',
  'RESELLERS: Dashboard -> Resellers runs the reseller commission program - reseller records, agreements (every contract term, signing, activation), registered customers (first-to-submit), monthly commission statements built from paid invoices, marketing-expense claims, and a sales-by-seller report. The Owner / Provider party (Proctor Solutions) is edited on the Business profile tab.',
  '',
  'PRICING CALCULATOR: Dashboard -> Pricing models a nation subscription on the flat per-home plan (base platform fee + per-home monthly, plus setup and add-ons).',
  '',
  'SUPPORT INBOX: Dashboard -> Support is the aggregated, cross-nation help-desk inbox - support tickets filed from every nation (and the portals) mirror here. Open a ticket to read the thread, reply to the reporter by email, and triage new / in-progress / resolved. Replying needs an email provider configured on the PLATFORM project.',
  '',
  'REQUESTS (build queue): Dashboard -> Requests turns a plain-language feature or fix request into an optimized build prompt (context, goal, roles, reusable building blocks, rules, Done-when) and saves it to the build queue as REQ-NNN. It can flag a request as a per-nation custom module. Copy the prompt to hand to a developer / coding assistant.',
  '',
  'ADMINISTRATORS + SIGN-IN: Dashboard -> Administrators manages platform admins. Admin sign-in is an email magic link plus enforced two-factor (TOTP) - the dashboard requires AAL2 before it renders. Reset your own authenticator from the Administrators card.',
].join('\n')

function buildSystem(): string {
  return [
    'You are the Admin Assistant for the Nation Pathways control plane (the platform admin panel at admin.fnhub.app).',
    'You are talking to a platform super-administrator who runs the whole fleet of nations.',
    'Answer their how-to questions about operating the control plane in clear, plain language. Keep replies short (a few sentences or a short numbered list). Use only the knowledge below and widely-known general help; do not invent menus, features, prices, or policies.',
    'The knowledge below is accurate for THIS control plane. When it covers the question, answer directly and confidently - give the steps or the fact, and name the exact tab or button. Do not hedge when the answer is in the knowledge; only say you are unsure when the question is genuinely outside it.',
    'If it is a real bug, a Supabase/Cloudflare outage, or a billing dispute that needs a person, say so plainly instead of guessing. Do not promise timelines.',
    'Never ask for or accept passwords, API keys, service-role keys, or one-time codes. Do not expose secrets.',
    'SCOPE: you ONLY help with operating this control plane. If asked to write or debug software code, do general development, or anything unrelated to running the platform, politely decline in one sentence and offer to help with a control-plane task instead. Do not produce code (the Requests tab is where a build prompt is generated).',
    '',
    KB_ADMIN,
  ].join('\n')
}

async function callClaude(system: string, messages: unknown[]): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const systemBlocks = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 700, system: systemBlocks, messages }),
  })
  let data: Record<string, unknown> = {}
  try { data = await r.json() } catch (_e) { data = {} }
  return { ok: r.ok, status: r.status, data }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    if (!ANTHROPIC_KEY) return json({ error: 'ANTHROPIC_API_KEY secret not set on the platform project' }, 500)
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return json({ error: 'Supabase env not configured' }, 500)

    const authHeader = req.headers.get('Authorization') || ''
    if (!authHeader.startsWith('Bearer ')) return json({ error: 'Missing or malformed Authorization header' }, 401)
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } })
    const { data: { user }, error: authErr } = await userClient.auth.getUser()
    if (authErr || !user) return json({ error: 'Please sign in.' }, 401)

    // Gate strictly to platform super-admins (control-plane super_admins table).
    const email = (user.email || '').toLowerCase()
    let isAdmin = false
    if (email && SUPABASE_SERVICE_KEY) {
      const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
      const { data: rows } = await admin.from('super_admins').select('email').ilike('email', email).limit(1)
      isAdmin = !!(rows && rows.length)
    }
    if (!isAdmin) return json({ error: 'Admin access required.' }, 403)

    const body = await req.json()
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

    const res = await callClaude(buildSystem(), messages)
    const data = res.data || {}
    let reply = ''
    try {
      const blocks: any[] = Array.isArray((data as any).content) ? (data as any).content : []
      reply = blocks.filter((b) => b && b.type === 'text').map((b) => String(b.text || '')).join('\n').trim()
    } catch (_e) { reply = '' }
    if (!reply) {
      if (!res.ok) console.error('[platform-assist] upstream ' + res.status + ' ' + JSON.stringify(data).slice(0, 200))
      reply = res.ok
        ? 'Sorry, I could not answer that one. Try rephrasing, or check the Provision tab guides.'
        : 'The admin assistant is temporarily unavailable. Please try again shortly.'
    }
    return json({ reply })
  } catch (e) {
    return json({ error: 'platform-assist failed', detail: String((e as Error)?.message || e).slice(0, 300) }, 500)
  }
})
