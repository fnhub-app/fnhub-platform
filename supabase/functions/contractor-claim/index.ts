// ========================================================================
// contractor-claim - Contractor Portal B1 identity linkage
// ------------------------------------------------------------------------
// POST (Authorization: Bearer <contractor phone-auth JWT>)
//
// Runs once after a contractor verifies an SMS one-time code. Creates the
// contractor_users mapping (auth.uid() -> contractor_id) ONLY when:
//   (a) an unused contractor_invites row matches the caller's phone, AND
//   (b) that same phone is already listed on the contractor's record
//       (housing_contractors.people[].phone)  -- double anti-impersonation.
// The row is created with the SERVICE ROLE (bypassing RLS); the client can
// never self-link. Idempotent: returns the existing mapping if already linked.
//
// Returns { linked:true, contractor_id } or { linked:false, reason }.
//
// Secrets: auto-injected SUPABASE_URL, SUPABASE_ANON_KEY,
// SUPABASE_SERVICE_ROLE_KEY. ASCII-only source.
// ========================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL         = Deno.env.get("SUPABASE_URL");
const SUPABASE_ANON_KEY    = Deno.env.get("SUPABASE_ANON_KEY");
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

const corsHeaders = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Last 10+ digits, compared digits-only, so +1 705 960-5076 == 7059605076 etc.
function phoneKey(v: unknown): string {
  const d = String(v ?? "").replace(/[^\d]/g, "");
  return d.length > 10 ? d.slice(-10) : d;   // match on the national number
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST")    return jsonResponse({ error: "Method not allowed" }, 405);

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_KEY) {
    return jsonResponse({ error: "Server not configured" }, 500);
  }

  // Auth: caller must present a valid Supabase (phone-auth) JWT.
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) {
    return jsonResponse({ error: "Missing Authorization header" }, 401);
  }
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: authErr } = await userClient.auth.getUser();
  if (authErr || !user) {
    return jsonResponse({ error: "Unauthorized", detail: authErr?.message }, 401);
  }

  const admin   = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const authUid = user.id;
  const pKey    = phoneKey(user.phone);

  // Already linked? Idempotent.
  {
    const { data: existing } = await admin
      .from("contractor_users")
      .select("contractor_id, is_active")
      .eq("auth_user_id", authUid)
      .limit(1);
    if (existing && existing.length) {
      const row = existing[0] as Record<string, unknown>;
      if (row.is_active === false) return jsonResponse({ linked: false, reason: "deactivated" });
      return jsonResponse({ linked: true, contractor_id: row.contractor_id });
    }
  }

  if (!pKey) return jsonResponse({ linked: false, reason: "no_phone_on_account" });

  // Find unused, unexpired invites, then match by phone (digits-only).
  const nowIso = new Date().toISOString();
  const { data: invites } = await admin
    .from("contractor_invites")
    .select("id, phone, contractor_id, role, invited_by, expires_at, used_at")
    .is("used_at", null);
  const invite = (invites || []).find((iv: Record<string, unknown>) => {
    if (phoneKey(iv.phone) !== pKey) return false;
    if (iv.expires_at && String(iv.expires_at) < nowIso) return false;
    return true;
  });
  if (!invite) return jsonResponse({ linked: false, reason: "no_invite" });

  // Double check: the phone must ALSO be on the contractor's record.
  const { data: ctRows } = await admin
    .from("housing_contractors")
    .select("id, name, people")
    .eq("id", invite.contractor_id)
    .limit(1);
  const ct = ctRows && ctRows[0] as Record<string, unknown> | undefined;
  if (!ct) return jsonResponse({ linked: false, reason: "contractor_not_found" });
  const people = Array.isArray(ct.people) ? ct.people as Array<Record<string, unknown>> : [];
  const onFile = people.some((p) => phoneKey(p.phone) === pKey);
  if (!onFile) {
    return jsonResponse({ linked: false, reason: "phone_not_on_contractor" });
  }

  // Resolve a display name from the matching key contact.
  const match = people.find((p) => phoneKey(p.phone) === pKey);
  const displayName = (match && String(match.name || "")) || "";

  // Create the mapping (service role) and consume the invite.
  const { error: insErr } = await admin.from("contractor_users").insert({
    auth_user_id:  authUid,
    contractor_id: invite.contractor_id,
    display_name:  displayName,
    phone:         user.phone || invite.phone,
    role:          invite.role || "contact",
    is_active:     true,
    invited_by:    invite.invited_by || null,
    created_at:    nowIso,
  });
  if (insErr) {
    return jsonResponse({ error: "Could not link account", detail: insErr.message }, 500);
  }
  await admin.from("contractor_invites").update({ used_at: nowIso }).eq("id", invite.id);

  // Best-effort audit.
  try {
    await admin.from("housing_audit_log").insert({
      entity_type: "contractor",
      entity_id:   String(invite.contractor_id),
      action:      "contractor_portal_claimed",
      detail:      "Portal login linked for " + (displayName || user.phone || authUid),
      actor:       user.phone || authUid,
      created_at:  nowIso,
    });
  } catch (_e) { /* non-fatal */ }

  return jsonResponse({ linked: true, contractor_id: invite.contractor_id });
});
