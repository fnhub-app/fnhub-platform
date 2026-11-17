// ========================================================================
// _shared/sms.ts - transactional SMS sender for nation Edge Functions that
// must text staff WITHOUT a staff JWT.
// ------------------------------------------------------------------------
// The staff-facing send-sms function gates on an ACTIVE STAFF JWT, so a
// function running under a non-staff identity (e.g. contractor-upload, which
// runs under a contractor phone-auth JWT) cannot call it. This module mirrors
// send-sms's provider logic + opt-out gate + logging so such a function can
// send one transactional SMS directly with the service role.
//
// Keep in sync with supabase/functions/send-sms/index.ts (same providers, same
// opt-out ledger, same sms_log / housing_audit_log rows). ASCII-only source.
// ========================================================================

// deno-lint-ignore no-explicit-any
type Admin = any;

export function isE164(v: unknown): boolean {
  return /^\+[1-9]\d{7,14}$/.test(String(v ?? "").trim());
}

const KNOWN_PROVIDERS = ["twilio", "telnyx"];

function env(k: string): string | undefined { return Deno.env.get(k); }

function providerHasKeys(p: string): boolean {
  if (p === "twilio") {
    return !!env("TWILIO_ACCOUNT_SID") && !!env("TWILIO_AUTH_TOKEN")
      && (!!env("TWILIO_MESSAGING_SERVICE_SID") || !!env("SMS_FROM"));
  }
  if (p === "telnyx") {
    return !!env("TELNYX_API_KEY") && !!env("SMS_FROM");
  }
  return false;
}

// The SMS_PROVIDER secret if usable, else any configured provider. null if none.
export function resolveProvider(): string | null {
  const dflt = (env("SMS_PROVIDER") || "twilio").toLowerCase();
  if (providerHasKeys(dflt)) return dflt;
  for (const p of KNOWN_PROVIDERS) if (providerHasKeys(p)) return p;
  return null;
}

export function smsConfigured(): boolean { return resolveProvider() !== null; }

async function sendViaTwilio(to: string, body: string, from: string): Promise<string> {
  const sid = env("TWILIO_ACCOUNT_SID")!;
  const url = "https://api.twilio.com/2010-04-01/Accounts/" + encodeURIComponent(sid) + "/Messages.json";
  const form = new URLSearchParams();
  form.set("To", to);
  form.set("Body", body);
  const msgSvc = env("TWILIO_MESSAGING_SERVICE_SID");
  if (msgSvc) form.set("MessagingServiceSid", msgSvc);
  else        form.set("From", from);
  const auth = btoa(sid + ":" + env("TWILIO_AUTH_TOKEN"));
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: "Basic " + auth, "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const data = await r.json().catch(() => ({} as Record<string, unknown>));
  if (!r.ok) throw new Error("Twilio " + r.status + ": " + JSON.stringify(data).slice(0, 300));
  return String((data as Record<string, unknown>).sid || "");
}

async function sendViaTelnyx(to: string, body: string, from: string): Promise<string> {
  const r = await fetch("https://api.telnyx.com/v2/messages", {
    method: "POST",
    headers: { Authorization: "Bearer " + env("TELNYX_API_KEY"), "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, text: body }),
  });
  const data = await r.json().catch(() => ({} as Record<string, unknown>));
  if (!r.ok) throw new Error("Telnyx " + r.status + ": " + JSON.stringify(data).slice(0, 300));
  const d = (data as Record<string, unknown>).data as Record<string, unknown> | undefined;
  return String((d && d.id) || "");
}

export type SmsResult = { ok: boolean; skipped?: string; error?: string };

// Send ONE transactional SMS with the service role. Mirrors send-sms: checks the
// opt-out ledger first (CASL STOP), sends via the resolved provider, and writes
// sms_log + a short housing_audit_log row. Never throws (fire-and-forget safe).
export async function sendTransactionalSms(admin: Admin, opts: {
  to: string;
  body: string;
  event: string;
  entity_type: string;
  entity_id: string;
  actor: string;
}): Promise<SmsResult> {
  try {
    const to = String(opts.to || "").trim();
    const body = String(opts.body || "").replace(/\r/g, "").trim().slice(0, 1500);
    if (!isE164(to)) return { ok: false, error: "not_e164" };
    if (!body) return { ok: false, error: "empty_body" };

    const provider = resolveProvider();
    if (!provider) return { ok: false, error: "no_provider" };
    const from = env("SMS_FROM") || "";
    if (provider === "telnyx" && !from) return { ok: false, error: "no_from" };

    // Opt-out gate (CASL STOP). Never send to a number on the ledger. If the
    // ledger can't be read, fail closed on SMS (don't risk texting opted-out).
    try {
      const { data: outRows, error } = await admin.from("sms_optouts").select("phone").eq("phone", to).limit(1);
      if (error) return { ok: false, error: "optout_read_failed" };
      if (outRows && outRows.length) {
        try {
          await admin.from("sms_log").insert({
            provider: null, provider_sid: null, to_number: to, event: opts.event,
            entity_type: opts.entity_type, entity_id: opts.entity_id, status: "skipped_optout",
            detail: "Recipient on opt-out ledger", actor: opts.actor, created_at: new Date().toISOString(),
          });
        } catch (_e) { /* best-effort log */ }
        return { ok: true, skipped: "optout" };
      }
    } catch (_e) { return { ok: false, error: "optout_read_failed" }; }

    let sid = "";
    try {
      sid = provider === "telnyx" ? await sendViaTelnyx(to, body, from) : await sendViaTwilio(to, body, from);
    } catch (e) {
      try {
        await admin.from("sms_log").insert({
          provider, provider_sid: null, to_number: to, event: opts.event,
          entity_type: opts.entity_type, entity_id: opts.entity_id, status: "failed",
          detail: (e as Error).message.slice(0, 500), actor: opts.actor, created_at: new Date().toISOString(),
        });
      } catch (_e) { /* best-effort log */ }
      return { ok: false, error: "send_failed" };
    }

    try {
      await admin.from("sms_log").insert({
        provider, provider_sid: sid || null, to_number: to, event: opts.event,
        entity_type: opts.entity_type, entity_id: opts.entity_id, status: "sent",
        actor: opts.actor, created_at: new Date().toISOString(),
      });
    } catch (_e) { /* best-effort */ }
    try {
      await admin.from("housing_audit_log").insert({
        entity_type: opts.entity_type, entity_id: opts.entity_id,
        action: opts.event + "_sms", detail: "SMS -> " + to + " | via " + provider,
        actor: opts.actor, created_at: new Date().toISOString(),
      });
    } catch (_e) { /* best-effort */ }
    return { ok: true };
  } catch (_e) {
    return { ok: false, error: "exception" };
  }
}
