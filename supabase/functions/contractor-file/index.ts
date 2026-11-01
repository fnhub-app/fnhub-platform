// ========================================================================
// contractor-file - Contractor Portal: signed URL for a work-order document
// ------------------------------------------------------------------------
// POST (Authorization: Bearer <contractor phone-auth JWT>)
//   body: { unitId, projectNumber, path }
//
// Returns a short-lived signed URL for ONE document, but ONLY when:
//   (a) the caller is a linked, active contractor (contractor_users), AND
//   (b) the requested storage path is listed on one of THEIR OWN work
//       orders (contractor_work_orders.data.documents[] for a row whose
//       contractor_id matches the caller).
// A contractor can therefore never request an arbitrary storage path: it
// must already be attached to their work order by staff. The data boundary
// is enforced here with the service role AFTER these checks, never by the
// client. Signed URLs are short-lived (5 min).
//
// Secrets: auto-injected SUPABASE_URL, SUPABASE_ANON_KEY,
// SUPABASE_SERVICE_ROLE_KEY. Optional STORAGE_BUCKET (default housing-files).
// Deploys with JWT verification ON (the default path in
// deploy-supabase-functions.yml) so the gateway rejects anon/invalid callers
// before this code runs. ASCII-only source.
// ========================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL         = Deno.env.get("SUPABASE_URL");
const SUPABASE_ANON_KEY    = Deno.env.get("SUPABASE_ANON_KEY");
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const STORAGE_BUCKET       = Deno.env.get("STORAGE_BUCKET") || "housing-files";
const SIGNED_URL_TTL       = 300; // seconds

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

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch (_e) { body = {}; }
  const unitId        = String(body.unitId ?? "").trim();
  const projectNumber = String(body.projectNumber ?? "").trim();
  const path          = String(body.path ?? "").trim();
  if (!unitId || !projectNumber || !path) {
    return jsonResponse({ error: "Missing unitId / projectNumber / path" }, 400);
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // 1) Resolve the caller's contractor id (must be linked + active).
  const { data: cuRows } = await admin
    .from("contractor_users")
    .select("contractor_id, is_active")
    .eq("auth_user_id", user.id)
    .limit(1);
  const cu = cuRows && (cuRows[0] as Record<string, unknown> | undefined);
  if (!cu || cu.is_active === false) {
    return jsonResponse({ error: "Not a linked contractor" }, 403);
  }
  const contractorId = String(cu.contractor_id);

  // 2) Fetch the work order and confirm it is THEIRS and lists this path.
  const { data: woRows } = await admin
    .from("contractor_work_orders")
    .select("contractor_id, data")
    .eq("sow_unit_id", unitId)
    .eq("sow_project_number", projectNumber)
    .limit(1);
  const wo = woRows && (woRows[0] as Record<string, unknown> | undefined);
  if (!wo || String(wo.contractor_id) !== contractorId) {
    return jsonResponse({ error: "Not your work order" }, 403);
  }
  const data = (wo.data && typeof wo.data === "object") ? wo.data as Record<string, unknown> : {};
  const docs = Array.isArray(data.documents) ? data.documents as Array<Record<string, unknown>> : [];
  const allowed = docs.some((d) => d && String(d.path) === path);
  if (!allowed) {
    return jsonResponse({ error: "Document not found on this work order" }, 403);
  }

  // 3) Sign the object (service role), short-lived. Mirrors sbGetSignedUrl in
  //    shared.js: POST /storage/v1/object/sign/<bucket>/<path> -> relative URL.
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const signResp = await fetch(SUPABASE_URL + "/storage/v1/object/sign/" + STORAGE_BUCKET + "/" + encodedPath, {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + SUPABASE_SERVICE_KEY,
      "apikey": SUPABASE_SERVICE_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ expiresIn: SIGNED_URL_TTL }),
  });
  if (!signResp.ok) {
    const t = await signResp.text().catch(() => "");
    return jsonResponse({ error: "Could not sign the document", detail: t.slice(0, 200) }, 502);
  }
  const signData = await signResp.json().catch(() => ({} as Record<string, unknown>));
  const rel = signData && (signData.signedURL || signData.signedUrl);
  if (!rel) return jsonResponse({ error: "No signed URL returned" }, 502);
  const url = SUPABASE_URL + "/storage/v1" + rel;

  // Best-effort audit (service role; append-only).
  try {
    await admin.from("housing_audit_log").insert({
      entity_type: "contractor",
      entity_id:   contractorId,
      action:      "contractor_file_access",
      detail:      "Portal document opened: " + path,
      actor:       user.phone || user.id,
      created_at:  new Date().toISOString(),
    });
  } catch (_e) { /* non-fatal */ }

  return jsonResponse({ url: url });
});
