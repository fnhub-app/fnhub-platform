// ========================================================================
// contractor-upload - Contractor Portal: contractor-submitted photos/invoices
// ------------------------------------------------------------------------
// POST (Authorization: Bearer <contractor phone-auth JWT>)
//   body: { unitId, projectNumber, kind: "photo"|"invoice",
//           filename, contentType, dataBase64 }
//
// Lets a contractor upload ONE file against a work order, but only after
// verifying server-side that the caller is a linked, active contractor AND
// owns that work order (contractor_work_orders). The file is written with the
// service role to a contractor-scoped storage path, and a file_uploaded audit
// row is recorded against the unit (entity "tenant") so it surfaces on the
// unit's Documents for staff. The client is never trusted; size + MIME are
// enforced here (size checked BEFORE decode, mirroring _shared/mr.ts).
//
// Secrets: auto-injected SUPABASE_URL, SUPABASE_ANON_KEY,
// SUPABASE_SERVICE_ROLE_KEY. Optional STORAGE_BUCKET (default housing-files).
// Deploys with JWT verification ON (default path in
// deploy-supabase-functions.yml). ASCII-only source.
// ========================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL         = Deno.env.get("SUPABASE_URL");
const SUPABASE_ANON_KEY    = Deno.env.get("SUPABASE_ANON_KEY");
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const STORAGE_BUCKET       = Deno.env.get("STORAGE_BUCKET") || "housing-files";
const MAX_B64_LEN          = 14000000;              // ~10 MB raw
const ALLOWED_KINDS        = ["photo", "invoice"];

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

// Keep only filename-safe chars; cap length. Never trust the client's name.
function safeName(s: unknown): string {
  const n = String(s == null ? "" : s).replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120);
  return n || "file";
}

function isAllowedType(ct: string): boolean {
  return /^image\//.test(ct) || ct === "application/pdf";
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST")    return jsonResponse({ error: "Method not allowed" }, 405);

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_KEY) {
    return jsonResponse({ error: "Server not configured" }, 500);
  }

  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) {
    return jsonResponse({ error: "Missing Authorization header" }, 401);
  }
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: authErr } = await userClient.auth.getUser();
  if (authErr || !user) return jsonResponse({ error: "Unauthorized", detail: authErr?.message }, 401);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch (_e) { body = {}; }
  const unitId        = String(body.unitId ?? "").trim();
  const projectNumber = String(body.projectNumber ?? "").trim();
  const kind          = String(body.kind ?? "").trim();
  const filename      = safeName(body.filename);
  const contentType   = String(body.contentType ?? "").trim().toLowerCase();
  let   dataBase64     = String(body.dataBase64 ?? "");

  if (!unitId || !projectNumber) return jsonResponse({ error: "Missing unitId / projectNumber" }, 400);
  if (ALLOWED_KINDS.indexOf(kind) === -1) return jsonResponse({ error: "Invalid kind" }, 400);
  if (!isAllowedType(contentType)) return jsonResponse({ error: "Only images and PDFs are allowed" }, 415);
  // Strip a data: URI prefix if the client left one on.
  const comma = dataBase64.indexOf(",");
  if (dataBase64.slice(0, 5) === "data:" && comma !== -1) dataBase64 = dataBase64.slice(comma + 1);
  if (!dataBase64) return jsonResponse({ error: "Empty file" }, 400);
  if (dataBase64.length > MAX_B64_LEN) return jsonResponse({ error: "File too large (max ~10 MB)" }, 413);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // 1) Resolve the caller's contractor id (linked + active).
  const { data: cuRows } = await admin
    .from("contractor_users")
    .select("contractor_id, is_active")
    .eq("auth_user_id", user.id)
    .limit(1);
  const cu = cuRows && (cuRows[0] as Record<string, unknown> | undefined);
  if (!cu || cu.is_active === false) return jsonResponse({ error: "Not a linked contractor" }, 403);
  const contractorId = String(cu.contractor_id);

  // 2) Confirm the work order is THEIRS.
  const { data: woRows } = await admin
    .from("contractor_work_orders")
    .select("contractor_id")
    .eq("sow_unit_id", unitId)
    .eq("sow_project_number", projectNumber)
    .limit(1);
  const wo = woRows && (woRows[0] as Record<string, unknown> | undefined);
  if (!wo || String(wo.contractor_id) !== contractorId) {
    return jsonResponse({ error: "Not your work order" }, 403);
  }

  // 3) Decode (size already bounded above).
  let bytes: Uint8Array;
  try {
    const bin = atob(dataBase64);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch (_e) {
    return jsonResponse({ error: "Could not decode file" }, 400);
  }

  // 4) Store it, contractor-scoped (service role).
  const path = "contractor-uploads/" + unitId + "/" + projectNumber + "/" + kind + "s/"
    + Date.now() + "_" + filename;
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const up = await fetch(SUPABASE_URL + "/storage/v1/object/" + STORAGE_BUCKET + "/" + encodedPath, {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + SUPABASE_SERVICE_KEY,
      "apikey": SUPABASE_SERVICE_KEY,
      "Content-Type": contentType,
      "x-upsert": "true",
    },
    body: bytes,
  });
  if (!up.ok) {
    const t = await up.text().catch(() => "");
    return jsonResponse({ error: "Upload failed", detail: t.slice(0, 200) }, 502);
  }

  // 5) Record the file so it appears on the unit's Documents for staff. Matches
  //    sbSaveFileMeta's file_uploaded audit-row shape; the name is prefixed so
  //    staff can see it was contractor-submitted at a glance.
  const displayName = (kind === "invoice" ? "[Contractor invoice] " : "[Contractor photo] ") + filename;
  try {
    await admin.from("housing_audit_log").insert({
      entity_type: "tenant",
      entity_id:   unitId,
      action:      "file_uploaded",
      detail:      JSON.stringify({
        path: path, name: displayName, size: bytes.length, type: contentType,
        source: "contractor_portal", kind: kind, project_number: projectNumber,
        actor_name: user.phone || contractorId,
      }),
      actor:       user.phone || user.id,
      created_at:  new Date().toISOString(),
    });
  } catch (_e) { /* non-fatal: the file is stored regardless */ }

  return jsonResponse({ ok: true, name: displayName });
});
