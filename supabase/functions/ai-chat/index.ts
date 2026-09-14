// CLFN Housing AI Chat - Supabase Edge Function
// Deploy: supabase functions deploy ai-chat
// Secret:  supabase secrets set ANTHROPIC_API_KEY=<your-key>
//
// Security: requires a valid Supabase user JWT (the browser must send the
// signed-in user's access token, NOT the public anon key) and the user must be
// active staff in the `staff` table. This stops anonymous abuse of the function
// (it calls the paid Anthropic API) and makes the assistant role-aware from the
// verified role rather than trusting a client-supplied one.
//
// Data: the client supplies an in-memory data `context` (apps/units/SOWs/etc).
// In chat mode the assistant ALSO has a read-only `query_database` tool for
// precise/large-data lookups beyond what the client loaded. The tool reads via
// the service-role key but is gated by a per-table role allowlist + forced row
// filters, with hard caps. There are NO write tools.
//
// Source must stay ASCII-only (dashboard editor parser breaks on non-ASCII).

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const ANTHROPIC_KEY        = Deno.env.get('ANTHROPIC_API_KEY')
const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')
const SUPABASE_ANON_KEY    = Deno.env.get('SUPABASE_ANON_KEY')
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

const MODEL          = 'claude-sonnet-4-6'
const MAX_ROW_LIMIT  = 50   // hard cap on rows returned per query
const MAX_TOOL_TURNS = 6    // hard cap on the tool-use loop

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

// ----- role groups (super_user inherits ed everywhere) -----------------------
const MGMT    = ['ed', 'super_user', 'housing_manager', 'housing_employee_l2', 'housing_employee_l1']
const FINANCE = ['ed', 'super_user', 'cfo', 'finance_l1']
const ALL     = MGMT.concat(['field_employee', 'cfo', 'finance_l1'])

function normRole(r: string): string {
  const v = (r || '').toLowerCase().trim()
  if (v === 'hm' || v === 'manager') return 'housing_manager'
  if (v === 'employee' || v === 'staff') return 'housing_employee_l1'
  if (v === 'executive_director' || v === 'executivedirector') return 'ed'
  return v
}

// ----- per-table read access + column hints ---------------------------------
// Only tables that are RELATIONALLY queryable are listed. Some have a `data`
// jsonb that holds extra form fields - filter on the named top-level columns and
// use select=* to inspect the rest. NOTE: housing_sow is intentionally absent -
// it stores one row per unit with all SOW details nested in a `data` jsonb array,
// so it is not row-per-SOW queryable; answer SOW/work-order questions from the
// client-supplied context instead.
type TableDef = { roles: string[]; cols: string }
const TABLES: Record<string, TableDef> = {
  housing_units: {
    roles: ALL,
    cols: 'id, num (unit number), street, status (vacant|occupied|reserved|under_repair|condemned|archived), assigned_name (current tenant), archived, latitude, longitude, last_inspection_date, next_inspection_due. Condemned is an ACCEPTED out-of-service state (its own KPI breakdown; not an error and not part of the reconcile gap). Other fields (bedrooms, type, funder, insured_value) live in a `data` jsonb - use select=* to read them.',
  },
  housing_applications: {
    roles: MGMT,
    cols: 'id, status, score, tier, app_type, urgent_need, health_risk, assigned_unit_id, assigned_address, submitted_at, created_by_email, archived. Applicant name and household details live in a `data` jsonb (filter on these top-level columns; names are also in the loaded context). app_type is one of: new_housing (applicant seeking a new unit; scored and ranked), existing_tenant (a file update only -- NOT scored, never on Match), transfer_request (a current CLFN tenant who already has a house on reserve applying for a DIFFERENT unit; scored and ranked; this is the "On Rez" / transfer case shown on the Match page), commercial (a business or department requesting a commercial/admin/band building -- short form, never scored or waitlisted, assignable ONLY to those building types). The data jsonb also carries: livingSituation (own_home | family_on_reserve = staying with family on reserve i.e. DOUBLED UP | renting_off_reserve | temporary_shelter | no_fixed_address | other), deceased (boolean) + deceasedDate, and reserve. A deceased application is kept as a record but is zero-scored, never on Match, unassignable, and excluded from every application count.',
  },
  tenants: {
    roles: ALL,
    cols: 'id, full_name, email, phone, hydro_account, gas_account, lease_start_date, lease_end_date',
  },
  housing_contractors: {
    roles: ALL,
    cols: 'id, name, email, status. Other fields may live in a `data` jsonb - use select=* to inspect.',
  },
  housing_rfq: {
    roles: MGMT,
    cols: 'id (e.g. RFQ-2026-0007), status (draft|issued|awarded|cancelled), sow_unit_id, sow_project_number, awarded_contractor_id, award_amount, created_at. Most form fields (bids, contract_number, contract details) live in a `data` jsonb - use select=* to inspect.',
  },
  inspections: {
    roles: ALL,
    cols: 'id, unit_id, unit_address, type (Move-In|Move-Out|Annual|Routine|Emergency), inspection_date, inspector_name, overall_status (pending|pass|fail|needs_repair), sow_created, created_at',
  },
  housing_application_notes: {
    roles: MGMT,
    cols: 'id, app_id (application), body, author_email, created_at. Dedicated application notes - use this (NOT the audit log) to count/list notes on applications.',
  },
  tenant_notes: {
    roles: ALL,
    cols: 'id, tenant_id, note_body, author_email, created_at. Dedicated tenant notes - use this (NOT the audit log) to count/list notes on tenants.',
  },
  housing_projects: {
    roles: ALL,
    cols: 'id, project_number (CP-YYYY-NN, e.g. CP-2026-01), name, type (lot_development|house_build|mixed|commercial_building|band_building|infrastructure), status (planning|active|on_hold|completed|cancelled), funding_source, budget, start_date, target_date, archived, created_at. These are CAPITAL PROJECTS (funded initiatives like "build 5 houses" or "develop 20 lots") - NOT the SOW-YYYY-NN "Project #" on maintenance requests. Milestones, expenses, grants, payment requests, PO/department numbers, and the cost-allocation snapshot live in a `data` jsonb: poNumber, deptNumber, grants[] (source, reference, amount - a project can have several grants; budget = their sum), milestones[] (budgetAmount = per-milestone P&L budget), expenses[] (amount; vendor + contractorId when the payee is a registered contractor, else vendorAddress/vendorPhone for manual vendors; docs{invoice,eft,bank} = funder-compliance attachments), paymentRequests[] (number REQ-NN, funder, expenseIds, total), allocation. Which payment request billed an expense is DERIVED: an expense id appearing in a paymentRequests[].expenseIds list (do not look for claimedIn/claimedNumber fields - no longer written). Use select=* to read them and sum expenses[].amount for spend-to-date.',
  },
  housing_project_lots: {
    roles: ALL,
    cols: 'id, project_id (-> housing_projects), lot_number, address, legal_description, status (raw|serviced|built), unit_id (-> housing_units, set once a unit is built/linked on the lot), created_at. Count units delivered by a project via unit_id is not null.',
  },
  bcr_registry: {
    roles: ['ed', 'super_user', 'housing_manager'],
    cols: 'id, full_name, bcrd_date, reason, active, created_at, created_by, lifted_at, lifted_by, date_of_birth. The Band Council Resolution ineligibility list: a person with an ACTIVE row (banished, or evicted for harbouring) is INELIGIBLE for housing -- their applications are excluded from every application count and flagged "Ineligible -- BCR list" on Match. An entry with no bcrd_date is a details-pending stub written from the Tenant Card; the block is ALREADY in effect for it. Treat this list as highly sensitive -- only discuss it when directly asked by ED/HM staff.',
  },
  housing_audit_log: {
    roles: ['ed', 'super_user', 'housing_manager'],
    cols: 'id, entity_type, entity_id, action, detail, actor (email), created_at',
  },
  staff: {
    roles: ['ed', 'super_user', 'housing_manager'],
    cols: 'id, name, email, role, department, is_active',
  },
}

// NOTE: 'not' removed -- PostgREST's `not` is a modifier PREFIX (not.eq.x),
// not a standalone op, so `col=not.<value>` was malformed and silently errored.
const SAFE_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'in', 'is']

function schemaHintFor(role: string): string {
  const lines: string[] = []
  for (const t of Object.keys(TABLES)) {
    if (TABLES[t].roles.indexOf(role) !== -1) lines.push('  ' + t + ': ' + TABLES[t].cols)
  }
  if (FINANCE.indexOf(role) !== -1) {
    lines.push('  finance_* : finance ledger/loan/invoice tables (use select=*&limit=3 to learn columns)')
  }
  return lines.join('\n') || '  (no tables available for this role)'
}

// Decide if a role may read a given table; apply forced filters for narrow roles.
function tableAccess(role: string, table: string): { ok: boolean; forced: string[]; reason?: string } {
  const def = TABLES[table]
  if (def) {
    if (def.roles.indexOf(role) === -1) {
      return { ok: false, forced: [], reason: "Your role is not permitted to read the '" + table + "' table." }
    }
    return { ok: true, forced: [] }
  }
  if (table.indexOf('finance_') === 0) {
    if (FINANCE.indexOf(role) === -1) {
      return { ok: false, forced: [], reason: 'Finance data is restricted to ED, CFO, and Finance roles.' }
    }
    return { ok: true, forced: [] }
  }
  return { ok: false, forced: [], reason: "Unknown or non-readable table: '" + table + "'." }
}

// Run one whitelisted read query against PostgREST with the service-role key.
async function runQuery(role: string, email: string, input: Record<string, unknown>): Promise<{ rows?: unknown[]; error?: string }> {
  const table = String(input.table || '').trim()
  if (!table || !/^[a-z0-9_]+$/.test(table)) return { error: 'Invalid table name.' }
  const access = tableAccess(role, table)
  if (!access.ok) return { error: access.reason || 'Access denied.' }
  if (!SUPABASE_SERVICE_KEY) return { error: 'Server not configured for data queries.' }

  const params: string[] = []

  // SECURITY: no parentheses/colons in select. PostgREST resource EMBEDDING
  // (select=*,finance_rent_ledger(*)) runs with the service-role key and only
  // the BASE table's role is checked above, so allowing '(' let any staff role
  // read MGMT/finance-only tables through an embedded relation. Embedding is
  // never needed here -- the schema hints tell the model to use select=* and
  // read jsonb fields client-side.
  let select = String(input.select || '*').trim()
  if (!/^[a-z0-9_,* ]+$/i.test(select)) select = '*'
  params.push('select=' + encodeURIComponent(select))

  for (const f of access.forced) params.push(f)

  const filters = Array.isArray(input.filters) ? input.filters : []
  for (const f of filters as Array<Record<string, unknown>>) {
    const col = String(f.column || '').trim()
    const op  = String(f.op || 'eq').trim().toLowerCase()
    const val = f.value == null ? '' : String(f.value)
    if (!/^[a-z0-9_]+$/.test(col)) return { error: 'Invalid filter column: ' + col }
    if (SAFE_OPS.indexOf(op) === -1) return { error: 'Unsupported filter op: ' + op }
    params.push(encodeURIComponent(col) + '=' + op + '.' + encodeURIComponent(val))
  }

  if (input.order) {
    const ord = String(input.order).trim()
    if (/^[a-z0-9_]+(\.(asc|desc))?$/i.test(ord)) params.push('order=' + ord)
  }

  let limit = parseInt(String(input.limit || '20'), 10)
  if (isNaN(limit) || limit < 1) limit = 20
  if (limit > MAX_ROW_LIMIT) limit = MAX_ROW_LIMIT
  params.push('limit=' + limit)

  const url = SUPABASE_URL + '/rest/v1/' + table + '?' + params.join('&')
  try {
    const r = await fetch(url, {
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: 'Bearer ' + SUPABASE_SERVICE_KEY,
        Accept: 'application/json',
      },
    })
    const text = await r.text()
    if (!r.ok) return { error: 'Query failed (' + r.status + '): ' + text.slice(0, 500) }
    let rows: unknown[]
    try { rows = JSON.parse(text) } catch { return { error: 'Could not parse query result.' } }
    return { rows }
  } catch (e) {
    return { error: 'Query error: ' + (e as Error).message }
  }
}

const QUERY_TOOL = {
  name: 'query_database',
  description: 'Read rows from an allowed housing table (read-only). Use for exact counts, complete lists, or records not in the loaded context. Returns up to ' + MAX_ROW_LIMIT + ' rows as JSON.',
  input_schema: {
    type: 'object',
    properties: {
      table:  { type: 'string', description: 'Table name to read from.' },
      select: { type: 'string', description: 'Comma-separated columns, or * for all. Default *.' },
      filters: {
        type: 'array',
        description: 'Row filters, ANDed together.',
        items: {
          type: 'object',
          properties: {
            column: { type: 'string' },
            op:     { type: 'string', description: 'One of eq, neq, gt, gte, lt, lte, like, ilike, in, is, not. Default eq.' },
            value:  { type: 'string' },
          },
          required: ['column', 'value'],
        },
      },
      order: { type: 'string', description: 'e.g. created_at.desc' },
      limit: { type: 'integer', description: 'Max rows (1-' + MAX_ROW_LIMIT + ').' },
    },
    required: ['table'],
  },
}

// ----- audit_activity: server-side staff-activity aggregation ----------------
// The 50-row query cap + created_at.desc silently drops staff whose rows are
// pushed past the cap, so "who was active / usage today" could show only the
// most-recent (often the asker) on a busy day. This scans the WHOLE window
// server-side (paginated, well past the model row cap) and returns only a small
// per-actor / per-action summary, so the answer is complete regardless of volume.
const AUDIT_ROLES    = ['ed', 'super_user', 'housing_manager']
const AUDIT_MAX_SCAN = 6000   // safety cap on rows scanned server-side

function dayWindowUTC(dateStr: string): { from: string; to: string } {
  // Treat YYYY-MM-DD as a UTC calendar day: from 00:00 up to the next 00:00.
  const from = dateStr + 'T00:00:00.000Z'
  const d = new Date(from)
  d.setUTCDate(d.getUTCDate() + 1)
  return { from, to: d.toISOString() }
}

function dayWindowLocal(dateStr: string, offsetMin: number): { from: string; to: string } {
  // Treat YYYY-MM-DD as a LOCAL calendar day and return its UTC bounds.
  // offsetMin is JS getTimezoneOffset() for the client (minutes to ADD to
  // local to reach UTC, e.g. +240 for Eastern Daylight / UTC-4). So local
  // midnight in UTC = UTC-midnight-of-that-date + offsetMin.
  const base = Date.parse(dateStr + 'T00:00:00.000Z')
  const fromMs = base + offsetMin * 60000
  return { from: new Date(fromMs).toISOString(), to: new Date(fromMs + 86400000).toISOString() }
}

async function runAuditActivity(role: string, input: Record<string, unknown>, tz?: { localDate?: string; offsetMin?: number }): Promise<{ summary?: Record<string, unknown>; error?: string }> {
  if (AUDIT_ROLES.indexOf(role) === -1) {
    return { error: 'Activity reports are restricted to ED and Housing Manager roles.' }
  }
  if (!SUPABASE_SERVICE_KEY || !SUPABASE_URL) return { error: 'Server not configured for activity reports.' }

  // Resolve the time window: explicit from/to win; else a single day; else today.
  // Days are the CLIENT'S LOCAL calendar day when a timezone offset was sent, so
  // an evening report doesn't roll into the next UTC day and miss the day's work.
  let from = input.from ? String(input.from).trim() : ''
  let to   = input.to   ? String(input.to).trim()   : ''
  const date = input.date ? String(input.date).trim() : ''
  if (!from || !to) {
    const hasTz = tz && typeof tz.offsetMin === 'number'
    const localToday = (tz && tz.localDate && /^\d{4}-\d{2}-\d{2}$/.test(tz.localDate))
      ? tz.localDate
      : new Date().toISOString().slice(0, 10)
    const d = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : localToday
    const w = hasTz ? dayWindowLocal(d, tz!.offsetMin as number) : dayWindowUTC(d)
    from = from || w.from
    to   = to   || w.to
  }
  const action = input.action ? String(input.action).trim().toLowerCase() : ''
  if (action && !/^[a-z0-9_]+$/.test(action)) return { error: 'Invalid action filter.' }

  // Scan the window in pages (bypasses the model-facing 50-row cap).
  const rows: Array<Record<string, unknown>> = []
  const pageSize = 1000
  let offset = 0
  let truncated = false
  while (offset < AUDIT_MAX_SCAN) {
    const params = [
      'select=' + encodeURIComponent('actor,action,entity_type,created_at'),
      'created_at=gte.' + encodeURIComponent(from),
      'created_at=lt.'  + encodeURIComponent(to),
      'order=created_at.asc',
      'limit=' + pageSize,
      'offset=' + offset,
    ]
    if (action) params.push('action=eq.' + action)
    const url = SUPABASE_URL + '/rest/v1/housing_audit_log?' + params.join('&')
    const r = await fetch(url, {
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: 'Bearer ' + SUPABASE_SERVICE_KEY, Accept: 'application/json' },
    })
    if (!r.ok) return { error: 'Activity query failed (' + r.status + '): ' + (await r.text()).slice(0, 300) }
    let batch: Array<Record<string, unknown>>
    try { batch = await r.json() } catch { return { error: 'Could not parse activity result.' } }
    if (!Array.isArray(batch) || batch.length === 0) break
    for (const b of batch) rows.push(b)
    if (batch.length < pageSize) break
    offset += pageSize
    if (offset >= AUDIT_MAX_SCAN) truncated = true
  }

  // Aggregate per actor and per action; collect logins.
  const actorMap: Record<string, { count: number; first: string; last: string }> = {}
  const actionMap: Record<string, number> = {}
  const logins: Array<{ actor: string; at: string }> = []
  for (const row of rows) {
    const a  = String(row.actor || 'unknown')
    const ts = String(row.created_at || '')
    if (!actorMap[a]) actorMap[a] = { count: 0, first: ts, last: ts }
    actorMap[a].count++
    if (ts && ts < actorMap[a].first) actorMap[a].first = ts
    if (ts && ts > actorMap[a].last)  actorMap[a].last  = ts
    const act = String(row.action || 'unknown')
    actionMap[act] = (actionMap[act] || 0) + 1
    if (act === 'user_login') logins.push({ actor: a, at: ts })
  }
  const by_actor = Object.keys(actorMap)
    .map((k) => ({ actor: k, events: actorMap[k].count, first: actorMap[k].first, last: actorMap[k].last }))
    .sort((x, y) => y.events - x.events)
  const by_action = Object.keys(actionMap)
    .map((k) => ({ action: k, count: actionMap[k] }))
    .sort((x, y) => y.count - x.count)

  return { summary: {
    window: { from, to },
    total_events: rows.length,
    distinct_actors: by_actor.length,
    logins_count: logins.length,
    by_actor,
    by_action,
    logins,
    truncated,
    note: truncated ? 'Scan hit the ' + AUDIT_MAX_SCAN + '-row safety cap; counts may be partial.' : '',
  } }
}

const AUDIT_TOOL = {
  name: 'audit_activity',
  description: 'Server-computed staff activity summary from the audit log for a date window (bypasses the ' + MAX_ROW_LIMIT + '-row cap). USE THIS for ANY question about app usage or staff activity, e.g. "app usage report", "who used the app today", "how many people / how many staff were active", "who was active", "usage today", "activity report", "who logged in". It aggregates EVERY event in the window and returns per-actor and per-action counts plus the login list, so it is complete even when a day has hundreds of events. Do NOT answer app-usage / activity questions from query_database -- its 50-row cap silently drops people and will make a busy day look like one person. ED and Housing Manager only.',
  input_schema: {
    type: 'object',
    properties: {
      date:   { type: 'string', description: "Single day as YYYY-MM-DD, interpreted in the user's local timezone. Defaults to the user's local today if omitted." },
      from:   { type: 'string', description: 'Optional ISO start timestamp (inclusive); overrides date.' },
      to:     { type: 'string', description: 'Optional ISO end timestamp (exclusive); overrides date.' },
      action: { type: 'string', description: 'Optional single action filter, e.g. user_login.' },
    },
  },
}

async function callClaude(system: string, messages: unknown[], tools?: unknown[]): Promise<Record<string, unknown>> {
  const payload: Record<string, unknown> = { model: MODEL, max_tokens: 1500, system, messages }
  if (tools && tools.length) payload.tools = tools
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(payload),
  })
  const data = await r.json()
  if (!r.ok) throw new Error(JSON.stringify(data).slice(0, 600))
  return data
}

// Write one append-only audit row per AI interaction. Server-side (service-role)
// so it cannot be bypassed by a tampered client. Columns mirror the rest of the
// app's auditEntry(): actor = verified email; detail is a JSON string carrying
// the staff name (for the audit "By" column) plus the question, mode, role, and
// which tables the read-only query tool touched. Best-effort: never throws into
// the request path. Awaited before responding so the insert completes before the
// function instance is reclaimed.
async function writeAiAudit(opts: {
  email: string
  name: string
  role: string
  mode: string
  question: string
  replyChars: number
  tables: string[]
  turns: number
}): Promise<void> {
  if (!SUPABASE_SERVICE_KEY || !SUPABASE_URL) return
  try {
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    const q = (opts.question || '').slice(0, 2000)
    // `detail` is the human-readable summary the audit-log UI shows in its
    // Detail column (_parseAuditRow reads d.detail); the rest are structured
    // fields kept for the AI's own usage reports and compliance review.
    const summary = (opts.mode === 'draft' ? 'AI draft note: ' : 'AI question: ') + q
      + (opts.tables && opts.tables.length ? ' [queried: ' + opts.tables.join(', ') + ']' : '')
    const detail: Record<string, unknown> = {
      detail: summary,
      name: opts.name || opts.email,
      mode: opts.mode,
      role: opts.role,
      question: q,
      reply_chars: opts.replyChars,
      tables_queried: opts.tables,
      turns: opts.turns,
    }
    await admin.from('housing_audit_log').insert({
      entity_type: 'ai',
      entity_id: 'AI',
      action: opts.mode === 'draft' ? 'ai_draft' : 'ai_query',
      detail: JSON.stringify(detail),
      actor: opts.email,
      created_at: new Date().toISOString(),
    })
  } catch (e) {
    console.warn('[ai-audit] insert failed:', (e as Error).message)
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    if (!ANTHROPIC_KEY) return json({ error: 'ANTHROPIC_API_KEY secret not set on this function' }, 500)
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return json({ error: 'Supabase env not configured' }, 500)

    // --- Auth: require a valid Supabase user JWT (not the anon key) ---
    const authHeader = req.headers.get('Authorization') || ''
    if (!authHeader.startsWith('Bearer ')) return json({ error: 'Missing or malformed Authorization header' }, 401)
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: { user }, error: authErr } = await userClient.auth.getUser()
    if (authErr || !user) return json({ error: 'Unauthorized', detail: authErr?.message }, 401)

    // --- Resolve the verified, authoritative staff role (active staff only) ---
    const email = (user.email || '').toLowerCase()
    let role = ''
    let actorName = ''
    if (SUPABASE_SERVICE_KEY) {
      const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
      const { data: rows } = await admin
        .from('staff')
        .select('role, name')
        .eq('email', email)
        .eq('is_active', true)
        .limit(1)
      if (rows && rows.length) {
        role = normRole(rows[0].role || '')
        actorName = rows[0].name || ''
      }
    }
    if (!role) return json({ error: 'AI assistant is available to active housing staff only.' }, 403)

    const body = await req.json()
    const type    = body.type
    const message = body.message
    const history = body.history
    const context = body.context || {}
    context.role = role  // trust the verified role, never the client-supplied one

    // --- Draft mode: single call, no tools ---
    if (type === 'draft') {
      const data = await callClaude(buildSystem('draft', context), buildMessages(message, history))
      const reply = (data.content as any)?.[0]?.text || '(no response)'
      await writeAiAudit({ email, name: actorName, role, mode: 'draft', question: message || '', replyChars: reply.length, tables: [], turns: 1 })
      return json({ reply })
    }

    // --- Project milestones: single call, no tools; returns a JSON array ---
    if (type === 'project_milestones') {
      const data = await callClaude(buildSystem('project_milestones', context), buildMessages(message, history))
      const reply = (data.content as any)?.[0]?.text || '(no response)'
      await writeAiAudit({ email, name: actorName, role, mode: 'draft', question: (message || '').slice(0, 500), replyChars: reply.length, tables: [], turns: 1 })
      return json({ reply })
    }

    // --- Chat mode: tool-use loop with the read-only query_database tool ---
    const system = buildSystem('chat', context)
    const messages = buildMessages(message, history)
    const tablesQueried: string[] = []
    let turns = 0
    while (turns < MAX_TOOL_TURNS) {
      turns++
      const resp = await callClaude(system, messages, [QUERY_TOOL, AUDIT_TOOL])
      const content = (resp.content as Array<Record<string, unknown>>) || []
      messages.push({ role: 'assistant', content })

      if (resp.stop_reason !== 'tool_use') {
        const text = content.filter((b) => b.type === 'text').map((b) => b.text as string).join('\n').trim()
        const reply = text || '(no response)'
        await writeAiAudit({ email, name: actorName, role, mode: 'chat', question: message || '', replyChars: reply.length, tables: tablesQueried, turns })
        return json({ reply })
      }

      const toolResults: unknown[] = []
      for (const block of content) {
        if (block.type !== 'tool_use') continue
        let resultText: string
        if (block.name === 'query_database') {
          const input = (block.input as Record<string, unknown>) || {}
          const tbl = String(input.table || '')
          if (tbl && tablesQueried.indexOf(tbl) === -1) tablesQueried.push(tbl)
          const qr = await runQuery(role, email, input)
          resultText = qr.error
            ? 'ERROR: ' + qr.error
            : 'Returned ' + (qr.rows || []).length + ' row(s):\n' + JSON.stringify(qr.rows).slice(0, 12000)
        } else if (block.name === 'audit_activity') {
          const input = (block.input as Record<string, unknown>) || {}
          if (tablesQueried.indexOf('audit_activity') === -1) tablesQueried.push('audit_activity')
          const ar = await runAuditActivity(role, input, { localDate: context.localDate, offsetMin: context.tzOffsetMin })
          resultText = ar.error ? 'ERROR: ' + ar.error : JSON.stringify(ar.summary).slice(0, 12000)
        } else {
          resultText = "ERROR: unknown tool '" + block.name + "'."
        }
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: resultText })
      }
      messages.push({ role: 'user', content: toolResults })
    }
    await writeAiAudit({ email, name: actorName, role, mode: 'chat', question: message || '', replyChars: 0, tables: tablesQueried, turns })
    return json({ reply: "I couldn't finish that lookup. Try narrowing the question." })
  } catch (err) {
    return json({ error: (err as Error).message }, 500)
  }
})

// How-to knowledge: lets the assistant answer procedural "how do I ..."
// questions. Grounded in the real UI; tailor steps to the user's role.
const HOW_TO = `

## How-to knowledge (app workflows)
Use this to answer "how do I ..." questions. Tailor steps to the staff role; if
their role cannot do an action, say so and name the role that can. Main pages:
Home (worklist + quick actions + KPIs), Inventory (units), Tenants, Match,
Renovations, Contractors, Inspections, Finance. A "Maintenance Request" is the
same record as a "SOW"; a "Work Order" is its crew/contractor printout.

Create a maintenance request / work order: easiest is the Home page
"Renovation Questionnaire" quick action (a guided wizard) - or open Inventory,
click the hammer icon next to a unit, add line items (category + description),
then Save (draft) or Submit. Management and field employees can create/edit.

Assign a work order: in the request use "Assigned To" - in-house crew (a field
employee) or a contractor. Assigning is restricted to Housing Manager / ED.
An in-house assignee is notified and sees it under "Work Orders to Complete".

Complete a maintenance request: open the request, click "Mark Complete" in the
header and confirm. This locks the request, work order, and progress reports.
Field employees, Housing Manager, and ED can complete; only ED can reopen.

Approve a renovation / maintenance request: items needing sign-off appear in "Renovations
Waiting Approval" on the Home worklist and in Renovations > Reno Approvals.
Housing Manager approves first; higher-cost work then needs ED approval.

Do a housing application (full walkthrough):
  1. Home > "New Application" quick action.
  2. Work through the wizard with Next/Back: Applicant Info -> Employment &
     Income -> Co-Applicant -> Household Members -> Emergency Contacts -> Pets
     -> Documents -> Review & Submit. (HM/ED see two extra staff-only steps -
     Housing Need Assessment and Tenancy History - before Documents.)
  3. Step 6 Documents: upload required files (ID, proof of income, etc.).
  4. Review & Submit; you can tick a box to email the applicant a PDF copy.
  Drafts appear in "My Drafts" on the worklist - use "Continue ->" to finish.
  Management creates/edits applications; field employees do not.

Approve an application: submitted applications show in the worklist
"Applications" section. Open one and choose recommend / approve / decline /
return-with-notes. Flow: management recommends -> Housing Manager approves ->
ED approves, per Settings > Approval Authority. Tip: the approval note box has a
"Draft with AI" button that writes a professional decision note for you.

Match an applicant to a unit: approved applications with no unit show in "Ready
to Match"; use the Match page to assign a vacant unit. The Match page lists only
SCORED applications that have cleared approval (status mgr_approved, hm_approved,
or ed_approved) and have no assigned_unit_id yet. Two app_types are scored and
appear there: new_housing and transfer_request (existing_tenant file updates are
never on Match).

"On Rez" / transfer applicants: an applicant who already has a house on reserve
and is applying for a new/different one is a transfer -- app_type =
'transfer_request'. The Match page flags these with an "On Rez" badge. To count
"how many on the Match list have the On Rez flag" (or "have a house on rez and
are looking for a new house"), count housing_applications where
app_type = 'transfer_request' AND status in (mgr_approved, hm_approved,
ed_approved) AND assigned_unit_id is null AND archived = false. Do NOT answer
this from the applicants' self-reported reserve / haveHouse fields in the data
jsonb -- those are unrelated to the Match On Rez flag and will give the wrong
count (e.g. they include declined or never-approved applications that never
appear on Match).

Applicant statuses and eligibility (added 2026-08):
  - Living Situation (application data jsonb, livingSituation): own_home,
    family_on_reserve (= staying with family on reserve, i.e. DOUBLED UP -- on
    reserve with a reserve address but no home of their own), renting_off_reserve,
    temporary_shelter (living in a temporary shelter -- scores its own
    urgent-need points), no_fixed_address (homeless), other. The Residency & Housing Status card at
    the top of the application wizard captures it; for a New Application from an
    On Reserve member it is mandatory, and "own home" there is rejected (an
    on-reserve member in their own home files a Transfer Request or File Update,
    not a New Application).
  - To count DOUBLED-UP applicants (the "of which Doubled Up" KPI): count
    housing_applications where app_type = 'new_housing' (or null), status not in
    (draft, declined), assigned_unit_id is null, archived = false, and the data
    jsonb livingSituation = 'family_on_reserve'. Doubled-up and no-fixed-address
    applicants show amber/red badges on Match.
  - DECEASED applicants (data jsonb deceased = true): the record is kept but the
    application is zero-scored ("Not Scored"), never on Match, cannot be
    assigned a unit, and is excluded from EVERY application count (Open
    Applications and all Applications-by-Type rows). Setting a Tenant Card
    tenancy status to Deceased flags the linked application automatically.
  - BANISHED / HARBOURING (BCR list): a person with an ACTIVE bcr_registry row
    is ineligible for housing. Their applications are excluded from every
    application count; Match still lists them with a red "Ineligible -- BCR
    list" badge so staff can see and filter them; approval/assignment shows a
    warning gate. "Harbouring" means housing/sheltering someone who is on the
    list -- the HARBOURED person belongs on the list, and eviction for
    harbouring also puts the evicted person on it. Setting a Tenant Card
    tenancy to Banished writes the registry entry immediately (a details-pending
    stub still blocks). Never present a BCR-listed person as a normal waitlist
    applicant.
  - HARD RULE: a current tenant (a unit is assigned to them) can never have
    app_type new_housing -- the form blocks it. Their options are Transfer
    Request (different unit) or File Update. To count the real New Applications
    waitlist, also exclude housed applicants (status assigned / assigned_unit_id
    set), deceased, BCR-listed, and commercial applications.
  - COMMERCIAL applications (app_type = 'commercial'): a business or department
    requesting a building. Short form, never scored, never on the waitlist or
    Match; assignable only to commercial / admin / band buildings from the unit
    card or the Business/Department review modal.

Inspections: open the Inspections page (under the Operations nav) > "New
Inspection". Pick the unit and type (Move-In, Move-Out, Annual, Routine,
Emergency), complete the room-by-room checklist (pass / fail / needs repair),
add notes/photos, and save. A failed/needs-repair inspection can spawn a
maintenance request for the unit. Unit records show last and next inspection
dates.

Capital Projects (under the Operations nav; edit needs the manageProjects
authority, default HM/ED - everyone else views read-only): Projects page >
"+ New Project". Pick the type (Lot Development, House Build, Mixed,
Commercial Building, Band Building, Infrastructure Project) - a
default milestone checklist is applied and can be edited. Tabs on the project
card: Overview (name, funding source, PO number, department number, budget,
dates, a Grants list - a project can be funded by several grants and the
budget is then their sum - and Linked RFQs), Milestones (check off as
completed), Costs, P & L (budget vs actual with variance, one row per
milestone - milestone budgets are entered on this tab), Lots & Units,
Documents. On the Costs tab staff log expenses (optionally tagged to a
milestone) and attach the three funder-compliance documents to each cost
line: the invoice copy, the EFT payment confirmation, and the bank statement
proof. To claim money from a funder: tick the cost lines, click "New Payment
Request", pick the grant being billed, and Export - this downloads a PDF
claim summary plus every attached document, and marks those lines "Claimed"
with a REQ-NN number so nothing is double-claimed (undo is possible if the
claim was never actually submitted). An RFQ can be linked to a capital
project via the Capital Project dropdown on the RFQ's Details tab; linked
RFQs are listed on the project's Overview tab. On Lots & Units: "+ Add Lots" creates lot
records in bulk; lots move raw -> serviced -> built; "Create Units from Lots"
builds housing units on selected lots (they appear in Inventory linked to the
project); "Link existing unit" attaches an already-existing unit to a lot.
"Allocate Costs to Units" (Costs tab, allocateProjectCosts authority, default
ED) divides the project total - actuals to date or the funded budget - equally
across the project's units and writes each unit's Construction Cost; Insured
Value is only prefilled where empty, never overwritten.

View or edit a tenant: Tenants > open a tenant card (TIC). Tabs: Overview,
Utilities (hydro/gas meters + accounts), Documents, Unit History. Lease start
and end dates are recorded on the tenant. Field employees see the TIC read-only.

Edit a housing unit: Inventory > click a unit to open the Edit Unit card
(tabs: Overview, Tenant, Approvals, Maintenance Requests, RFQs & Contracts,
Documents, Map & Photos). Edit fields (address, status, type, funder, account
numbers, insured value, inspection dates, etc.) on the Overview tab.

Add a contractor: Contractors page > add a contractor. New contractors go
pending_review -> HM (or a senior employee) recommends -> hm_recommended ->
final approval by the Housing Manager OR the ED. Either the HM or the ED can
grant the final approval.

Issue an RFQ: from a maintenance request (Renovations or the unit panel) create
an RFQ to invite contractors to bid. Flow: draft -> issued -> awarded; only
drafts can be edited. Only the Housing Manager or ED can edit an RFQ; everyone
else sees it read-only. Awarding an RFQ AUTO-approves the linked maintenance
request (it becomes "System Approved" - see the maintenance requests section).
Award two ways: the "Award ->" button on the Recipients tab (runs the full app
tender - emails the winner and regret notices to other bidders), or, on the
Scope tab's Award card, "Record Award & Approve Maintenance Request - No
Notifications" for a tender run manually/offline (records the award and
approves the maintenance request without issuing the RFQ or emailing anyone). Both then open the
Contracting tab to generate the Contractor Agreement, which is saved to both the
RFQ and the unit document libraries.

Set a unit's location & photo: open the unit's Tenant Information Card and use
"Set Location & Photo" to drop a map pin and add a photo (ED/admin).

Finance (ED, CFO, and Finance roles only): open the Finance page. Sections:
Tenants, Rent Ledger, Loans, Invoices/Charges, Payment Arrangements,
Collections, Journal Entries, Transactions, Reports. Common tasks:
  - Record a rent payment: Rent Ledger > "+ Record Payment" (cash supports a
    denomination breakdown).
  - Set an opening balance: Rent Ledger > "Set Opening Balance".
  - Post a charge/invoice: Invoices > "+ Invoice"; "Batch Print" for many; Void
    from the invoice's Void action.
  - Create a loan: Loans > "+ New Loan"; record repayments with "Record Loan
    Payment"; print the Loan Agreement.
  - Set up a payment arrangement: Payment Arrangements > "New Arrangement";
    record installments with "Record Payment".
  - Flag for collections: Collections > "Flag Account".
  - Post a journal entry: Journal Entries > "+ New Entry" (debits/credits must
    balance).
  - Fix a mistake: do NOT delete - use Reverse Payment / Reverse Entry / Adjust
    Entry (or Void on an invoice). Finance ledgers are append-only and audited.
  - Statements/reports: Finance Reports > "Run Statements"; export buttons on
    each list.

Admin settings (ED / super user): Settings has App Settings (incl. the scoring
model), Approval Authority, Nation (branding, idle timeout, and Module toggles -
including this AI Assistant and Inspections), Notifications (email templates per
event), and Users (add/deactivate staff).
`

function buildSystem(type: string, ctx: any): string {
  if (type === 'project_milestones') {
    const nation = ctx?.nation || 'the First Nation'
    const ptype = ctx?.projectType || 'capital project'
    const pname = ctx?.projectName || 'this project'
    const existing = Array.isArray(ctx?.existingMilestones) && ctx.existingMilestones.length
      ? ('\n\nMilestones already on the plan (do NOT repeat these): ' + ctx.existingMilestones.join('; '))
      : ''
    return `You are a capital-projects planner for a First Nations housing department (` + nation + `). You help staff draft a realistic milestone plan for a housing capital project.

Project: ` + pname + ` (type: ` + ptype + `).

The user will describe the project, or paste text from a scoping/funding document. From that, produce an ordered milestone plan a housing manager could work from: planning and approvals, funding confirmation, design/engineering, permits, procurement/tender, site work, construction phases, inspections, and closeout/occupancy - adapted to what the input actually describes.

Rules:
- Output ONLY a JSON array. No prose, no code fence, no explanation before or after.
- Each element: {"name": string, "targetDate": string, "notes": string}.
- name: short, specific milestone label (a few words).
- targetDate: "YYYY-MM-DD" ONLY if the input clearly implies a date or sequence you can date; otherwise an empty string "". Never invent precise dates that were not implied.
- notes: one short sentence of context, or "".
- Order the array chronologically. Produce 8 to 16 milestones unless the input clearly calls for fewer or more.
- Ground every milestone in the input; do not pad with generic filler.` + existing
  }
  if (type === 'draft') {
    const app = ctx?.app ?? {}
    const name = [app.fn, app.ln].filter(Boolean).join(' ') || 'the applicant'
    const action = ctx?.action ?? ''
    const actionLabel: Record<string, string> = {
      submitted: 'submission acknowledgement',
      mgr_approved: 'manager approval',
      hm_approved: 'housing manager approval',
      ed_approved: 'executive director approval',
      declined: 'application decline',
      returned: 'return to applicant for more information',
      file_update: 'request for updated documents',
      assigned: 'unit assignment',
    }
    const label = actionLabel[action] ?? action

    return `You are a professional housing administrator at Constance Lake First Nation (CLFN). Write a brief, professional note for a housing application decision.

Application details:
- Applicant: ${name} (${app.id ?? ''})
- Decision: ${label}
- Priority score: ${app.total_score ?? app.score ?? 'N/A'}
- Bedrooms requested: ${app.bed_req ?? app.bedrooms ?? 'N/A'}
- Household size: ${app.household_size ?? app.adults ?? 'N/A'}
- Unit assigned: ${ctx?.unit || 'N/A'}

Write 2-4 sentences. Be professional, clear, and compassionate. Reference specific details where relevant. Output ONLY the note text - no subject line, no greeting, no signature.`
  }

  // Chat mode
  const role = ctx?.role ?? 'staff'

  const appsJson = ctx?.apps?.length
    ? `\n\n## Housing Applications (${ctx.apps.length} total)\nEach record is one application. Fields: id, fn/ln (name), status, score, tier (priority tier), bedrooms (requested), household_size, app_type, assignedUnit/assignedAddress (if placed), submittedAt, reserve, living_situation (family_on_reserve = doubled up), deceased (true = record kept, excluded from all counts), bcr_ineligible (true = on the BCR banishment list, excluded from counts, flagged on Match).\n` + JSON.stringify(ctx.apps.slice(0, 50))
    : '\n\n## Housing Applications\nNo application data available.'

  const unitsJson = ctx?.units?.length
    ? `\n\n## Housing Units (${ctx.units.length} total)\nComplete list of CLFN housing units - use this for unit counts and availability questions. Fields: id, address, bedrooms, bathrooms, type, status (vacant/occupied/reserved/condemned), accessible, isElders, funder, assignedTo/assignedName.\n` + JSON.stringify(ctx.units.slice(0, 60))
    : '\n\n## Housing Units\nNo unit data available.'

  const sowsJson = ctx?.sows?.length
    ? `\n\n## Maintenance Requests - ${ctx.sows.length} records\nThese are stored internally as SOWs (Scope of Work) in the housing_sow table, but ALWAYS call them "Maintenance Requests" when talking to staff - that is the term shown in the app UI. Each maintenance request is linked to a housing unit.\nApproval fields: approval_status is one of ''/draft/signed/submitted/hm_approved/ed_approved/completed; approved=true means hm_approved, ed_approved, or completed. IMPORTANT: if system_approved=true the maintenance request was AUTO-approved by the tendering workflow (an RFQ was awarded), NOT signed off by the Executive Director - call this "System Approved", and do NOT count it as an ED approval even though approval_status reads 'ed_approved'. approved_via_rfq marks the same thing.\n` + JSON.stringify(ctx.sows)
    : '\n\n## Maintenance Requests\nNo maintenance request data loaded yet.'

  const rfqsJson = ctx?.rfqs?.length
    ? `\n\n## RFQs / Requests for Quotes - ${ctx.rfqs.length} records\nRFQs are procurement requests sent to contractors for pricing on upcoming work.\n` + JSON.stringify(ctx.rfqs.slice(0, 30))
    : ''

  const contractorsJson = ctx?.contractors?.length
    ? `\n\n## Contractors - ${ctx.contractors.length} on file\n` + JSON.stringify(ctx.contractors.slice(0, 30))
    : ''

  const renoJson = ctx?.renoProgress?.length
    ? `\n\n## Renovation Progress - ${ctx.renoProgress.length} units with active renos\noverallPct is % complete (0-100).\n` + JSON.stringify(ctx.renoProgress)
    : ''

  const projectsJson = ctx?.projects?.length
    ? `\n\n## Capital Projects - ${ctx.projects.length} records\nFunded capital initiatives (lot development / house builds), reference numbers CP-YYYY-NN - distinct from the SOW-YYYY-NN "Project #" on maintenance requests. Fields: project_number, name, type, status, funding_source, budget, spent (actual expenses to date), milestones_done/milestones_total, lots_total, units_delivered, start_date, target_date, allocated (true once costs were allocated to units).\n` + JSON.stringify(ctx.projects.slice(0, 30))
    : ''

  // Compute quick summary stats for the prompt
  const vacantCount = (ctx?.units || []).filter((u: any) => u.status === 'vacant').length
  const pendingApps = (ctx?.apps  || []).filter((a: any) => !['assigned','declined','archived'].includes(a.status)).length

  return `You are an AI assistant for the Constance Lake First Nation (CLFN) Housing Department. You help housing staff answer questions about applications, housing units, maintenance requests (work orders), renovations, contractors, inspections, capital projects, and housing policy, and explain how to do things in the app.

Staff role: ${role}
Current date/time (UTC): ${new Date().toISOString()} (audit timestamps are stored in UTC).
User's local day: ${ctx?.localDate || '(unknown)'}${ctx?.tzName ? ' (' + ctx.tzName + ')' : ''}. When a question says "today" / "yesterday", it means the user's LOCAL day, not the UTC day. The audit_activity tool already defaults to the local day and converts to UTC internally, so for "today" just call it with no date, and for another local day pass date=YYYY-MM-DD (it is interpreted in the user's local timezone).
Quick stats: ${ctx?.units?.length ?? 0} total units (${vacantCount} vacant), ${ctx?.apps?.length ?? 0} applications (${pendingApps} pending), ${ctx?.sows?.length ?? 0} maintenance requests on file.

IMPORTANT terminology for this system:
- "Maintenance request" is the term shown in the app UI; internally these are stored as SOW (Scope of Work) records - there is no separate maintenance table. Staff may also say "work order" or "repair job" and mean the same thing.
- "RFQ" = Request for Quotes (sent to contractors for pricing)
- "Tier" on an application = priority tier (e.g. Emergency, High, Medium, Low)
- "Capital Project" = a funded initiative (build N houses / develop N lots), numbered CP-YYYY-NN in the housing_projects table. This is DIFFERENT from the SOW-YYYY-NN "Project #" shown on a maintenance request - do not mix them up. Capital projects track milestones, budget vs actual expenses, lots (raw/serviced/built), and units built on those lots; "allocate costs" means dividing the project total equally across its units to set each unit's construction cost.
${appsJson}${unitsJson}${sowsJson}${rfqsJson}${contractorsJson}${renoJson}${projectsJson}

## query_database tool
You also have a read-only query_database tool for precise or large-data lookups
that go beyond the loaded context above - exact counts, complete lists, or
records not on the current page. Tables you may query for this role (with columns):
${schemaHintFor(role)}
Use ilike with *term* for fuzzy text matches (e.g. applicant_name=ilike.*smith*).
Vacant units: housing_units status=eq.vacant. If unsure of a table's columns, run
select=* with limit=3. Prefer the loaded context for quick questions; use the tool
when you need exact or complete data. Only state facts present in the context or
returned by the tool - never invent records, names, numbers, or statuses.

## audit_activity tool (staff activity / usage reports)
For ANY "who was active", "usage today", "activity report", "who logged in", or
per-staff activity question, call the audit_activity tool -- NOT query_database.
It aggregates EVERY audit event in the window server-side (it is not limited to
50 rows), and returns { window, total_events, distinct_actors, logins_count,
by_actor:[{actor,events,first,last}], by_action:[{action,count}], logins:[...] }.
Pass date=YYYY-MM-DD for a single day (interpreted in the user's LOCAL
timezone; defaults to the user's local today), or from/to ISO timestamps for
a custom range, and optionally action=user_login. Report the
per-actor breakdown; do not conclude "only X was active" from query_database,
whose row cap silently drops people on busy days.
${HOW_TO}
## Charts / visual reports
When the user asks to show / chart / graph / visualize something, or wants a
breakdown, trend, or comparison, append a fenced code block tagged "chart"
containing ONLY JSON describing it, for example:
\`\`\`chart
{"type":"bar","title":"Applications by status","labels":["Submitted","Approved","Declined"],"datasets":[{"label":"Count","data":[12,5,2]}]}
\`\`\`
- type is one of: bar, line, pie, doughnut, wordcloud.
- Compute the numbers yourself from the loaded context or query_database results
  (e.g. count audit-log logins per day). Use at most ~12 labels; group or top-N
  if there are more.
- WORD CLOUD (best for note / theme analytics): when asked for a word cloud, or
  for the common themes / frequent terms in notes, query the notes table(s)
  (housing_application_notes.body and tenant_notes.note_body), read the bodies,
  extract meaningful words (lowercase, strip punctuation, DROP common English
  stopwords and generic filler like the/and/for/with/this/that/tenant/unit/note/
  request), tally how often each remaining word appears, and emit the top ~40 as:
  {"type":"wordcloud","title":"Common themes in notes","words":[{"text":"leak","weight":12},{"text":"furnace","weight":9},{"text":"roof","weight":7}]}
  weight = frequency. The query tool returns up to 50 rows, so base the cloud on
  the notes you can read and say how many notes it covers (e.g. "from the 50 most
  recent notes"). Word clouds are only for free-text fields (notes), not for
  status/category counts -- use a bar/pie chart for those.
- Put a 1-2 sentence plain-text summary BEFORE the chart block.
- Only include a chart when a visual genuinely helps; otherwise answer in text.

Rules:
- For unit counts, ALWAYS use the Housing Units section (or query_database) - never the maintenance request count.
- For maintenance/repair/work-order questions, use the Maintenance Requests section from the loaded context (the housing_sow table is not directly queryable).
- The audit log (housing_audit_log) records ACTIONS (who did what, when), NOT records. For "how many / list X" about records - notes, applications, tenants, units, inspections, contractors, RFQs - query the dedicated table for X (e.g. housing_application_notes + tenant_notes for notes). Do not answer record-count questions from the audit log.
- For "how do I ..." questions, use the How-to knowledge above and tailor to the staff role.
- Perform calculations (totals, counts, averages) directly from the data.
- Answer concisely and confidently. Do not tell staff to check another system if the data is available here or via the tool.
- This is sensitive community data governed by OCAP principles - keep answers grounded in the records and do not speculate about individuals.`
}

function buildMessages(message: string, history: any[]): any[] {
  const prior = (history ?? []).map((h: any) => ({ role: h.role, content: h.content }))
  return [...prior, { role: 'user', content: message }]
}
