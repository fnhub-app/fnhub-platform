// ========================================================================
// send-notification - Housing transactional email Edge Function
// ------------------------------------------------------------------------
// POST { to, to_name, subject, message, html?, bodyHtml?, reply_to?, brand?,
//        event?, entity_type?, entity_id?, attachments? }
//
// Multi-nation: the email PROVIDER is selectable per nation via the
// EMAIL_PROVIDER secret, so nations without Microsoft 365 can still send.
//   EMAIL_PROVIDER = "graph"    (default) - Microsoft Graph / M365 mailbox
//                  | "resend"             - Resend HTTP API
//                  | "sendgrid"           - SendGrid HTTP API
//
// Requires an authenticated Supabase user (Authorization: Bearer <jwt>) so the
// function can't be abused by anonymous callers. Logs each send to
// housing_audit_log via the service-role key (best-effort, never fails a send).
//
// Secrets (set per nation in Project Settings -> Edge Functions -> Secrets):
//   EMAIL_PROVIDER    optional, default "graph"
//   EMAIL_REPLY_TO    optional reply-to override (default housing@clfn.on.ca)
//   EMAIL_BRAND       optional footer brand     (default "CLFN Housing")
//   -- Graph (when EMAIL_PROVIDER=graph) --
//   GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET, GRAPH_FROM_USER
//   -- Resend (when EMAIL_PROVIDER=resend) --
//   RESEND_API_KEY, EMAIL_FROM (sender email), EMAIL_FROM_NAME (optional)
//   -- SendGrid (when EMAIL_PROVIDER=sendgrid) --
//   SENDGRID_API_KEY, EMAIL_FROM (sender email), EMAIL_FROM_NAME (optional)
//   -- auto-injected --
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
// ========================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const EMAIL_PROVIDER       = (Deno.env.get("EMAIL_PROVIDER") || "graph").toLowerCase();
const EMAIL_REPLY_TO       = Deno.env.get("EMAIL_REPLY_TO");
const EMAIL_BRAND          = Deno.env.get("EMAIL_BRAND");
const EMAIL_FROM           = Deno.env.get("EMAIL_FROM");
const EMAIL_FROM_NAME      = Deno.env.get("EMAIL_FROM_NAME");
const EMAIL_LOGO_URL       = Deno.env.get("EMAIL_LOGO_URL");
const APP_URL_ENV          = (Deno.env.get("APP_URL") || "").replace(/\/$/, "");

const GRAPH_TENANT_ID      = Deno.env.get("GRAPH_TENANT_ID");
const GRAPH_CLIENT_ID      = Deno.env.get("GRAPH_CLIENT_ID");
const GRAPH_CLIENT_SECRET  = Deno.env.get("GRAPH_CLIENT_SECRET");
const GRAPH_FROM_USER      = Deno.env.get("GRAPH_FROM_USER");

const RESEND_API_KEY       = Deno.env.get("RESEND_API_KEY");
const SENDGRID_API_KEY     = Deno.env.get("SENDGRID_API_KEY");

const SUPABASE_URL         = Deno.env.get("SUPABASE_URL");
const SUPABASE_ANON_KEY    = Deno.env.get("SUPABASE_ANON_KEY");
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

const DEFAULT_REPLY_TO = "housing@clfn.on.ca";
const DEFAULT_BRAND    = "CLFN Housing";

const corsHeaders = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Attachment = { name: string; contentType: string; contentBytes: string };
type OutMessage = {
  to: string;
  to_name?: string;
  subject: string;
  emailHtml: string;
  replyTo: string;
  attachments?: Attachment[];
  fromEmail?: string;   // resend/sendgrid only (Graph sends from GRAPH_FROM_USER)
  fromName?: string;
};

// Basic sender-address validation so a client-supplied From cannot inject mail
// headers or a bogus address. Returns a clean address or "" if implausible.
function cleanFromEmail(v: unknown): string {
  const s = String(v ?? "").trim().replace(/[\r\n]+/g, "");
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : "";
}
function cleanFromName(v: unknown): string {
  return String(v ?? "").trim().replace(/[\r\n]+/g, " ").slice(0, 120);
}

// ----- Microsoft Graph (M365) ------------------------------------------------
let _cachedToken: { access_token: string; expires_at: number } | null = null;

async function getGraphToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (_cachedToken && _cachedToken.expires_at - 60 > now) {
    return _cachedToken.access_token;
  }
  const tokenUrl = "https://login.microsoftonline.com/" + GRAPH_TENANT_ID + "/oauth2/v2.0/token";
  const body = new URLSearchParams({
    client_id:     GRAPH_CLIENT_ID!,
    client_secret: GRAPH_CLIENT_SECRET!,
    scope:         "https://graph.microsoft.com/.default",
    grant_type:    "client_credentials",
  });
  const r = await fetch(tokenUrl, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    body.toString(),
  });
  const data = await r.json();
  if (!r.ok || !data.access_token) {
    throw new Error("Token endpoint " + r.status + ": " + JSON.stringify(data));
  }
  _cachedToken = { access_token: data.access_token, expires_at: now + (data.expires_in || 3600) };
  return data.access_token;
}

async function sendViaGraph(m: OutMessage): Promise<void> {
  const token = await getGraphToken();
  const sendUrl = "https://graph.microsoft.com/v1.0/users/" + encodeURIComponent(GRAPH_FROM_USER!) + "/sendMail";
  const graphAttachments = (m.attachments && m.attachments.length)
    ? m.attachments.map((a) => ({
        "@odata.type": "#microsoft.graph.fileAttachment",
        name:          a.name,
        contentType:   a.contentType,
        contentBytes:  a.contentBytes,
      }))
    : undefined;
  const graphMessage: Record<string, unknown> = {
    subject:      m.subject,
    body:         { contentType: "HTML", content: m.emailHtml },
    toRecipients: [{ emailAddress: { address: m.to, name: m.to_name || undefined } }],
    replyTo:      [{ emailAddress: { address: m.replyTo } }],
  };
  if (graphAttachments) graphMessage.attachments = graphAttachments;
  const r = await fetch(sendUrl, {
    method:  "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body:    JSON.stringify({ message: graphMessage, saveToSentItems: true }),
  });
  if (r.status !== 202) {
    throw new Error("Graph " + r.status + ": " + (await r.text()));
  }
}

// ----- Resend ----------------------------------------------------------------
async function sendViaResend(m: OutMessage): Promise<void> {
  const addr = m.fromEmail || EMAIL_FROM!;
  const nm   = m.fromName  || EMAIL_FROM_NAME;
  const from = nm ? (nm + " <" + addr + ">") : addr;
  const body: Record<string, unknown> = {
    from,
    to:       [m.to],
    subject:  m.subject,
    html:     m.emailHtml,
    reply_to: m.replyTo,
  };
  if (m.attachments && m.attachments.length) {
    body.attachments = m.attachments.map((a) => ({ filename: a.name, content: a.contentBytes }));
  }
  const r = await fetch("https://api.resend.com/emails", {
    method:  "POST",
    headers: { Authorization: "Bearer " + RESEND_API_KEY, "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });
  if (!r.ok) {
    throw new Error("Resend " + r.status + ": " + (await r.text()));
  }
}

// ----- SendGrid --------------------------------------------------------------
async function sendViaSendgrid(m: OutMessage): Promise<void> {
  const body: Record<string, unknown> = {
    personalizations: [{ to: [{ email: m.to, name: m.to_name || undefined }] }],
    from:    { email: m.fromEmail || EMAIL_FROM!, name: m.fromName || EMAIL_FROM_NAME || undefined },
    reply_to:{ email: m.replyTo },
    subject: m.subject,
    content: [{ type: "text/html", value: m.emailHtml }],
  };
  if (m.attachments && m.attachments.length) {
    body.attachments = m.attachments.map((a) => ({
      content:     a.contentBytes,
      filename:    a.name,
      type:        a.contentType,
      disposition: "attachment",
    }));
  }
  const r = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method:  "POST",
    headers: { Authorization: "Bearer " + SENDGRID_API_KEY, "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });
  if (r.status !== 202 && !r.ok) {
    throw new Error("SendGrid " + r.status + ": " + (await r.text()));
  }
}

// ----- helpers ---------------------------------------------------------------
function escapeHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Accept only a plain hex colour so a stray config value can't inject markup.
function sanitizeHexColor(c: unknown): string {
  const s = String(c ?? "").trim();
  return /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(s) ? s : "";
}

// Give any <a> the template supplied WITHOUT its own style a brand-safe look
// (near-black, bold, underlined) -- the Settings rich-text sanitizer strips
// inline styles from edited templates, and unstyled anchors otherwise fall to
// whatever colour the recipient's mail client invents (blue/green).
function styleBareLinks(html: string): string {
  return String(html || "").replace(/<a (?![^>]*style=)/gi,
    '<a style="color:#111827;font-weight:700;text-decoration:underline;" ');
}
// Escape the contact line, then wrap email addresses in pre-styled mailto
// anchors so mail clients' auto-linkers (which paint their own colours) find
// them already linked and leave the footer on-palette.
function contactLineHtml(text: string): string {
  return escapeHtml(text).replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    (m) => '<a href="mailto:' + m + '" style="color:#6b7280;text-decoration:underline;">' + m + '</a>');
}

// Branded, email-client-safe HTML shell (tables + inline styles, mobile-fluid).
// All branding is passed in from the client (nation config); safe fallbacks
// keep it working if a field is missing. ASCII-only.
// BRAND RULE: the accent appears as a RULE, never an area -- the header is a
// white band with the nation name in black over a thick rule in the nation's
// colour (a filled colour band violates the no-background-fills rule, and for
// a yellow brand put yellow-adjacent text one client dark-mode filter away
// from illegible). Fills are reserved for buttons (template CTAs).
function brandedEmailShell(opts: {
  subject: string; innerHtml: string; nationName: string;
  brandColor: string; contactLine: string; brandFooter: string; logoUrl?: string;
}): string {
  const rule    = opts.brandColor || "#1f2937";
  const name    = escapeHtml(opts.nationName || opts.brandFooter || "Housing");
  const logo    = /^https:\/\//i.test(String(opts.logoUrl || "")) ? String(opts.logoUrl) : "";
  const logoImg = logo
    ? '<img src="' + escapeHtml(logo) + '" alt="" width="42" height="42" style="display:block;border:0;outline:none;text-decoration:none;border-radius:10px;margin:0 0 10px;"/>'
    : '';
  const contact = opts.contactLine ? (contactLineHtml(opts.contactLine) + "<br/>") : "";
  return '' +
'<!doctype html><html><head><meta charset="utf-8"/>' +
'<meta name="viewport" content="width=device-width,initial-scale=1"/>' +
// Opt the email OUT of a mail client's automatic dark-mode inversion. This is a
// deliberately LIGHT design (white card, black text, brand-colour rule); without
// these declarations Apple Mail / Outlook force-darken it, which muddies the card
// AND drops the logo's contrast so it reads as an empty box. Declaring light-only
// keeps it rendering as designed on every client that honours color-scheme.
'<meta name="color-scheme" content="light"/>' +
'<meta name="supported-color-schemes" content="light"/>' +
'<style>:root{color-scheme:light;supported-color-schemes:light;}</style>' +
'</head>' +
'<body style="margin:0;padding:0;background:#f4f5f7;">' +
'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;">' +
'<tr><td align="center" style="padding:24px 12px;">' +
'<table role="presentation" cellpadding="0" cellspacing="0" width="600" style="width:600px;max-width:100%;background:#ffffff;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">' +
// Header: white, optional logo, name in black, brand-colour rule beneath
'<tr><td style="background:#ffffff;padding:20px 28px 16px;border-bottom:4px solid ' + rule + ';">' +
logoImg +
'<span style="font-size:16px;font-weight:700;letter-spacing:.4px;color:#111827;">' + name + '</span>' +
'</td></tr>' +
// Body
'<tr><td style="padding:26px 28px 8px;">' +
'<h1 style="font-size:19px;line-height:1.3;margin:0 0 16px;color:#111827;font-weight:700;">' + escapeHtml(opts.subject) + '</h1>' +
'<div style="font-size:14px;line-height:1.65;color:#374151;">' + styleBareLinks(opts.innerHtml) + '</div>' +
'</td></tr>' +
// Footer: white with a hairline rule (no filled block)
'<tr><td style="padding:18px 28px 22px;background:#ffffff;border-top:1px solid #e5e7eb;">' +
'<div style="font-size:12px;line-height:1.6;color:#6b7280;">' +
'<strong style="color:#374151;">' + name + '</strong><br/>' + contact +
'This is an automated notification. Reply to this email to reach the housing team.' +
'</div></td></tr>' +
'</table></td></tr></table></body></html>';
}

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const KNOWN_PROVIDERS = ["graph", "resend", "sendgrid"];

// Which required secrets are missing for a given provider. For resend/sendgrid a
// From address may instead arrive per-request (payload.email_from), so the From
// is NOT treated as a hard requirement here - only the API credentials are.
function providerEnvMissingFor(p: string): string[] {
  const missing: string[] = [];
  if (p === "graph") {
    if (!GRAPH_TENANT_ID)     missing.push("GRAPH_TENANT_ID");
    if (!GRAPH_CLIENT_ID)     missing.push("GRAPH_CLIENT_ID");
    if (!GRAPH_CLIENT_SECRET) missing.push("GRAPH_CLIENT_SECRET");
    if (!GRAPH_FROM_USER)     missing.push("GRAPH_FROM_USER");
  } else if (p === "resend") {
    if (!RESEND_API_KEY) missing.push("RESEND_API_KEY");
  } else if (p === "sendgrid") {
    if (!SENDGRID_API_KEY) missing.push("SENDGRID_API_KEY");
  } else {
    missing.push("UNKNOWN_PROVIDER");
  }
  return missing;
}
function providerHasKeys(p: string): boolean {
  return KNOWN_PROVIDERS.indexOf(p) !== -1 && providerEnvMissingFor(p).length === 0;
}

// Pick the effective provider for THIS message: the requested one if its keys
// are configured, else the EMAIL_PROVIDER secret default, else any provider that
// happens to be configured (so mail still goes out). null if none are usable.
function resolveProvider(requested: string): string | null {
  if (providerHasKeys(requested)) return requested;
  if (providerHasKeys(EMAIL_PROVIDER)) return EMAIL_PROVIDER;
  for (const p of KNOWN_PROVIDERS) if (providerHasKeys(p)) return p;
  return null;
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST")    return jsonResponse({ error: "Method not allowed" }, 405);

  // (The effective email provider is resolved per-request below, after the
  // payload is parsed, so a nation can pick its own delivery method.)
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return jsonResponse({ error: "Supabase env not configured" }, 500);
  }

  // Auth: caller must present a valid Supabase user JWT
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

  // SECURITY: a valid JWT is no longer enough. This function predates the
  // member portal, when every authenticated user was staff -- the portal now
  // mints real auth accounts for ANY self-registered applicant, and this
  // function sends caller-authored HTML (with attachments) from the nation's
  // own mailbox to arbitrary recipients. Without a staff check it is a
  // turnkey phishing relay under the nation's identity. Mirror the
  // send-magic-link gate: the caller's JWT email must match an ACTIVE staff
  // row (exact, escaped, case-insensitive -- never a raw LIKE pattern).
  if (!SUPABASE_SERVICE_KEY) {
    return jsonResponse({ error: "Server not configured" }, 500);
  }
  {
    const callerEmail = (user.email || "").toLowerCase();
    const emailLit = callerEmail.replace(/[\\%_]/g, (c: string) => "\\" + c);
    const adminGate = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const { data: staffRows } = await adminGate
      .from("staff").select("id").ilike("email", emailLit).eq("is_active", true).limit(1);
    if (!staffRows || !staffRows.length) {
      return jsonResponse({ error: "Staff access required" }, 403);
    }
  }

  // Payload
  let payload: Record<string, unknown>;
  try { payload = await req.json(); }
  catch { return jsonResponse({ error: "Invalid JSON body" }, 400); }

  const to          = payload.to          as string | undefined;
  const to_name     = payload.to_name     as string | undefined;
  const subject     = payload.subject     as string | undefined;
  const message     = payload.message     as string | undefined;
  const html        = payload.html        as string | undefined;
  const bodyHtml    = payload.bodyHtml    as string | undefined;
  const event       = payload.event       as string | undefined;
  const entity_type = payload.entity_type as string | undefined;
  const entity_id   = payload.entity_id   as string | undefined;
  const attachments = payload.attachments as Attachment[] | undefined;

  // Nation-driven branding/reply-to: payload override -> secret -> default.
  const replyTo = (payload.reply_to as string) || EMAIL_REPLY_TO || DEFAULT_REPLY_TO;
  const brand   = (payload.brand    as string) || EMAIL_BRAND    || DEFAULT_BRAND;

  if (!to || !subject || (!message && !html && !bodyHtml)) {
    return jsonResponse({
      error: "Required fields: to, subject, and one of message|html|bodyHtml",
    }, 400);
  }
  // Recipient must be a plausible single email address. Previously unvalidated:
  // any staff JWT could pass an arbitrary string straight into the provider
  // payload (header-injection / provider-error surface from the nation mailbox).
  if (!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(String(to).trim())) {
    return jsonResponse({ error: "Invalid recipient address" }, 400);
  }

  // Compose body - three modes, in priority order:
  //   1. `html`     - caller supplies a complete document, used as-is
  //   2. `bodyHtml` - caller supplies inner content (rich text), wrapped in the
  //                   branded shell. NOT escaped (sanitized client-side).
  //   3. `message`  - plain text, escaped + wrapped in the branded shell
  const innerHtml = bodyHtml
    ? bodyHtml
    : '<div style="font-size:14px;line-height:1.6;color:#333;white-space:pre-wrap;">'
        + escapeHtml(message)
      + '</div>';

  // Branding for the shell (client passes nation config; safe fallbacks).
  const nationName  = (payload.nation_name as string) || brand || "Housing";
  const brandColor  = sanitizeHexColor(payload.brand_color) || "#1f2937";
  const contactLine = (payload.contact_line as string) || "";
  // Logo (https only): client-supplied logo_url wins, else EMAIL_LOGO_URL secret,
  // else the app icon at the nation's APP_URL. Data: URIs are rejected (mail
  // clients strip them), so the app's data-URL logo never reaches here.
  const payloadLogo = String((payload.logo_url as string) || "").trim();
  const logoUrl = /^https:\/\//i.test(payloadLogo) ? payloadLogo
    : (/^https:\/\//i.test(String(EMAIL_LOGO_URL || "")) ? String(EMAIL_LOGO_URL)
    : (APP_URL_ENV && /^https:\/\//i.test(APP_URL_ENV) ? APP_URL_ENV + "/icon-192.png" : ""));

  const emailHtml = html ?? brandedEmailShell({
    subject, innerHtml, nationName, brandColor, contactLine, brandFooter: brand, logoUrl,
  });

  // Resolve the delivery method for THIS message. The client (nation config) may
  // request a provider; we honour it only when its keys exist server-side, else
  // fall back to the EMAIL_PROVIDER secret. API keys never come from the client.
  const requestedProvider = String(payload.email_provider ?? "").toLowerCase();
  const provider = resolveProvider(requestedProvider);
  if (!provider) {
    return jsonResponse({
      error: "No usable email provider is configured",
      detail: "requested='" + (requestedProvider || "(none)") + "', secret default='" + EMAIL_PROVIDER + "'",
      missing: providerEnvMissingFor(EMAIL_PROVIDER),
    }, 500);
  }
  // From override for the resend/sendgrid path (Graph always sends from its
  // mailbox). Fall back to the EMAIL_FROM secret; require a valid address there.
  const fromEmail = cleanFromEmail(payload.email_from) || cleanFromEmail(EMAIL_FROM);
  const fromName  = cleanFromName(payload.email_from_name) || EMAIL_FROM_NAME || nationName || brand;
  if (provider !== "graph" && !fromEmail) {
    return jsonResponse({
      error: "Send provider '" + provider + "' has no From address",
      detail: "Set the nation's email.from in config, or the EMAIL_FROM secret.",
    }, 500);
  }

  const outMessage: OutMessage = {
    to, to_name, subject, emailHtml, replyTo, attachments,
    fromEmail: provider === "graph" ? undefined : fromEmail,
    fromName:  provider === "graph" ? undefined : fromName,
  };

  // Send via the resolved provider
  try {
    if (provider === "graph")         await sendViaGraph(outMessage);
    else if (provider === "resend")   await sendViaResend(outMessage);
    else                              await sendViaSendgrid(outMessage);
  } catch (e) {
    return jsonResponse({ error: "Send failed (" + provider + ")", detail: (e as Error).message }, 502);
  }

  // Audit log (best-effort, server-side, service-role).
  if (SUPABASE_SERVICE_KEY) {
    try {
      const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
      await admin.from("housing_audit_log").insert({
        entity_type: entity_type || "notification",
        entity_id:   entity_id || "-",
        action:      event || "email_sent",
        detail:      "Email -> " + to + " | " + subject + " | via " + provider,
        actor:       user.email || user.id,
        created_at:  new Date().toISOString(),
      });
    } catch (e) {
      console.warn("[send-notification] audit log failed:", e);
    }
  }

  return jsonResponse({ ok: true, provider });
});
