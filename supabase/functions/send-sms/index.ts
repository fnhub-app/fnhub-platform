// ========================================================================
// send-sms - Housing transactional SMS Edge Function (Phase 1)
// ------------------------------------------------------------------------
// POST { to, body, event?, entity_type?, entity_id?, sms_provider?, sms_from? }
//
// Mirrors send-notification: requires an authenticated ACTIVE staff JWT, picks
// a per-nation provider, sends, and logs every attempt. SMS-specific guards:
//   - recipient must be E.164 (+15551234567)
//   - the global opt-out ledger (sms_optouts) is checked BEFORE every send;
//     an opted-out number is skipped (logged, never sent) - CASL STOP handling
//
// Multi-nation: the provider is selectable per nation via the SMS_PROVIDER
// secret (and an optional per-request sms_provider the function honours only
// when that provider's keys exist server-side).
//   SMS_PROVIDER = "twilio" (default) | "telnyx"
//
// Secrets (Project Settings -> Edge Functions -> Secrets):
//   SMS_PROVIDER   optional, default "twilio"
//   SMS_FROM       sender number (E.164) or alphanumeric sender id; per nation
//   -- Twilio --
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN
//   TWILIO_MESSAGING_SERVICE_SID  optional (used instead of From when set)
//   -- Telnyx --
//   TELNYX_API_KEY
//   -- auto-injected --
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
//
// ASCII-only source (the dashboard editor's parser has choked on non-ASCII).
// ========================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SMS_PROVIDER            = (Deno.env.get("SMS_PROVIDER") || "twilio").toLowerCase();
const SMS_FROM                = Deno.env.get("SMS_FROM");

const TWILIO_ACCOUNT_SID      = Deno.env.get("TWILIO_ACCOUNT_SID");
const TWILIO_AUTH_TOKEN       = Deno.env.get("TWILIO_AUTH_TOKEN");
const TWILIO_MSG_SERVICE_SID  = Deno.env.get("TWILIO_MESSAGING_SERVICE_SID");

const TELNYX_API_KEY          = Deno.env.get("TELNYX_API_KEY");

const SUPABASE_URL            = Deno.env.get("SUPABASE_URL");
const SUPABASE_ANON_KEY       = Deno.env.get("SUPABASE_ANON_KEY");
const SUPABASE_SERVICE_KEY    = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

const MAX_BODY_LEN = 1500;

const corsHeaders = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type OutSms = { to: string; body: string; from: string };
type SendResult = { sid: string };

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// E.164: a leading '+' then 8 to 15 digits, first digit non-zero.
function isE164(v: unknown): boolean {
  return /^\+[1-9]\d{7,14}$/.test(String(v ?? "").trim());
}

const KNOWN_PROVIDERS = ["twilio", "telnyx"];

function providerEnvMissingFor(p: string): string[] {
  const missing: string[] = [];
  if (p === "twilio") {
    if (!TWILIO_ACCOUNT_SID) missing.push("TWILIO_ACCOUNT_SID");
    if (!TWILIO_AUTH_TOKEN)  missing.push("TWILIO_AUTH_TOKEN");
    if (!TWILIO_MSG_SERVICE_SID && !SMS_FROM) missing.push("SMS_FROM_or_TWILIO_MESSAGING_SERVICE_SID");
  } else if (p === "telnyx") {
    if (!TELNYX_API_KEY) missing.push("TELNYX_API_KEY");
    if (!SMS_FROM)       missing.push("SMS_FROM");
  } else {
    missing.push("UNKNOWN_PROVIDER");
  }
  return missing;
}
function providerHasKeys(p: string): boolean {
  return KNOWN_PROVIDERS.indexOf(p) !== -1 && providerEnvMissingFor(p).length === 0;
}
// Requested provider if its keys exist, else the SMS_PROVIDER secret, else any
// configured provider. null if none usable.
function resolveProvider(requested: string): string | null {
  if (providerHasKeys(requested)) return requested;
  if (providerHasKeys(SMS_PROVIDER)) return SMS_PROVIDER;
  for (const p of KNOWN_PROVIDERS) if (providerHasKeys(p)) return p;
  return null;
}

// ----- Twilio ----------------------------------------------------------------
async function sendViaTwilio(m: OutSms): Promise<SendResult> {
  const url = "https://api.twilio.com/2010-04-01/Accounts/" +
    encodeURIComponent(TWILIO_ACCOUNT_SID!) + "/Messages.json";
  const form = new URLSearchParams();
  form.set("To", m.to);
  form.set("Body", m.body);
  // A Messaging Service (sender pool) is preferred when configured; otherwise a
  // single From number.
  if (TWILIO_MSG_SERVICE_SID) form.set("MessagingServiceSid", TWILIO_MSG_SERVICE_SID);
  else                        form.set("From", m.from);
  const auth = btoa(TWILIO_ACCOUNT_SID + ":" + TWILIO_AUTH_TOKEN);
  const r = await fetch(url, {
    method:  "POST",
    headers: { Authorization: "Basic " + auth, "Content-Type": "application/x-www-form-urlencoded" },
    body:    form.toString(),
  });
  const data = await r.json().catch(() => ({} as Record<string, unknown>));
  if (!r.ok) {
    throw new Error("Twilio " + r.status + ": " + JSON.stringify(data));
  }
  return { sid: String((data as Record<string, unknown>).sid || "") };
}

// ----- Telnyx ----------------------------------------------------------------
async function sendViaTelnyx(m: OutSms): Promise<SendResult> {
  const r = await fetch("https://api.telnyx.com/v2/messages", {
    method:  "POST",
    headers: { Authorization: "Bearer " + TELNYX_API_KEY, "Content-Type": "application/json" },
    body:    JSON.stringify({ from: m.from, to: m.to, text: m.body }),
  });
  const data = await r.json().catch(() => ({} as Record<string, unknown>));
  if (!r.ok) {
    throw new Error("Telnyx " + r.status + ": " + JSON.stringify(data));
  }
  const d = (data as Record<string, unknown>).data as Record<string, unknown> | undefined;
  return { sid: String((d && d.id) || "") };
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST")    return jsonResponse({ error: "Method not allowed" }, 405);

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return jsonResponse({ error: "Supabase env not configured" }, 500);
  }
  if (!SUPABASE_SERVICE_KEY) {
    return jsonResponse({ error: "Server not configured" }, 500);
  }

  // Auth: caller must present a valid Supabase user JWT.
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) {
    return jsonResponse({ error: "Missing or malformed Authorization header" }, 401);
  }
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: authErr } = await userClient.auth.getUser();
  if (authErr || !user) {
    return jsonResponse({ error: "Unauthorized", detail: authErr?.message }, 401);
  }

  // SECURITY: a valid JWT is not enough - the portal mints auth accounts for
  // self-registered applicants too. SMS costs money per message and sends from
  // the nation's own number, so gate on an ACTIVE staff row (exact, escaped,
  // case-insensitive), the same gate as send-notification / send-magic-link.
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  {
    const callerEmail = (user.email || "").toLowerCase();
    const emailLit = callerEmail.replace(/[\\%_]/g, (c: string) => "\\" + c);
    const { data: staffRows } = await admin
      .from("staff").select("id").ilike("email", emailLit).eq("is_active", true).limit(1);
    if (!staffRows || !staffRows.length) {
      return jsonResponse({ error: "Staff access required" }, 403);
    }
  }

  // Payload
  let payload: Record<string, unknown>;
  try { payload = await req.json(); }
  catch { return jsonResponse({ error: "Invalid JSON body" }, 400); }

  const to          = String(payload.to ?? "").trim();
  const bodyRaw     = String(payload.body ?? "");
  const event       = payload.event       as string | undefined;
  const entity_type = payload.entity_type as string | undefined;
  const entity_id   = payload.entity_id   as string | undefined;

  if (!isE164(to)) {
    return jsonResponse({ error: "Recipient must be an E.164 number (+15551234567)" }, 400);
  }
  const body = bodyRaw.replace(/\r/g, "").trim().slice(0, MAX_BODY_LEN);
  if (!body) {
    return jsonResponse({ error: "Required field: body" }, 400);
  }

  // Opt-out gate (CASL STOP). Never send to a number on the ledger.
  try {
    const { data: outRows } = await admin
      .from("sms_optouts").select("phone").eq("phone", to).limit(1);
    if (outRows && outRows.length) {
      try {
        await admin.from("sms_log").insert({
          provider: null, provider_sid: null, to_number: to,
          event: event || "sms", entity_type: entity_type || "notification",
          entity_id: entity_id || "-", status: "skipped_optout",
          detail: "Recipient on opt-out ledger", actor: user.email || user.id,
          created_at: new Date().toISOString(),
        });
      } catch (_e) { /* best-effort log */ }
      return jsonResponse({ ok: true, skipped: "optout" });
    }
  } catch (e) {
    // If the ledger can't be read, fail closed on SMS (don't risk texting an
    // opted-out person); the email channel still carried the notice.
    return jsonResponse({ error: "Opt-out check failed", detail: (e as Error).message }, 502);
  }

  // Resolve provider for THIS message.
  const requestedProvider = String(payload.sms_provider ?? "").toLowerCase();
  const provider = resolveProvider(requestedProvider);
  if (!provider) {
    return jsonResponse({
      error: "No usable SMS provider is configured",
      detail: "requested='" + (requestedProvider || "(none)") + "', secret default='" + SMS_PROVIDER + "'",
      missing: providerEnvMissingFor(SMS_PROVIDER),
    }, 500);
  }
  const from = String(payload.sms_from ?? "").trim() || SMS_FROM || "";
  if (provider === "telnyx" && !from) {
    return jsonResponse({ error: "Provider 'telnyx' has no From - set SMS_FROM" }, 500);
  }

  const outSms: OutSms = { to, body, from };

  let sid = "";
  try {
    const res = provider === "telnyx" ? await sendViaTelnyx(outSms) : await sendViaTwilio(outSms);
    sid = res.sid;
  } catch (e) {
    // Log the failure, then surface it.
    try {
      await admin.from("sms_log").insert({
        provider, provider_sid: null, to_number: to, event: event || "sms",
        entity_type: entity_type || "notification", entity_id: entity_id || "-",
        status: "failed", detail: (e as Error).message.slice(0, 500),
        actor: user.email || user.id, created_at: new Date().toISOString(),
      });
    } catch (_e) { /* best-effort log */ }
    return jsonResponse({ error: "Send failed (" + provider + ")", detail: (e as Error).message }, 502);
  }

  // Delivery log + a short mirror into the shared audit log (both best-effort).
  try {
    await admin.from("sms_log").insert({
      provider, provider_sid: sid || null, to_number: to, event: event || "sms",
      entity_type: entity_type || "notification", entity_id: entity_id || "-",
      status: "sent", actor: user.email || user.id, created_at: new Date().toISOString(),
    });
  } catch (e) { console.warn("[send-sms] sms_log failed:", e); }
  try {
    await admin.from("housing_audit_log").insert({
      entity_type: entity_type || "notification",
      entity_id:   entity_id || "-",
      action:      event ? (event + "_sms") : "sms_sent",
      detail:      "SMS -> " + to + " | via " + provider,
      actor:       user.email || user.id,
      created_at:  new Date().toISOString(),
    });
  } catch (e) { console.warn("[send-sms] audit log failed:", e); }

  return jsonResponse({ ok: true, provider, sid });
});
