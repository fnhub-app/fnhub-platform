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
const MAX_NOTE_LEN         = 4000;
const ALLOWED_KINDS        = ["photo", "invoice", "note", "progress"];

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
  const amount        = Number(String(body.amount ?? "").replace(/[^0-9.\-]/g, "")) || 0;
  const noteText      = String(body.text ?? "").trim();
  const percent       = Math.max(0, Math.min(100, Math.round(Number(body.percent))));

  if (!unitId || !projectNumber) return jsonResponse({ error: "Missing unitId / projectNumber" }, 400);
  if (ALLOWED_KINDS.indexOf(kind) === -1) return jsonResponse({ error: "Invalid kind" }, 400);
  if (kind === "note") {
    if (!noteText) return jsonResponse({ error: "Empty note" }, 400);
    if (noteText.length > MAX_NOTE_LEN) return jsonResponse({ error: "Note too long" }, 413);
  } else if (kind === "progress") {
    if (!Number.isFinite(Number(body.percent))) return jsonResponse({ error: "Invalid percent" }, 400);
  } else {
    if (!isAllowedType(contentType)) return jsonResponse({ error: "Only images and PDFs are allowed" }, 415);
    // Strip a data: URI prefix if the client left one on.
    const comma = dataBase64.indexOf(",");
    if (dataBase64.slice(0, 5) === "data:" && comma !== -1) dataBase64 = dataBase64.slice(comma + 1);
    if (!dataBase64) return jsonResponse({ error: "Empty file" }, 400);
    if (dataBase64.length > MAX_B64_LEN) return jsonResponse({ error: "File too large (max ~10 MB)" }, 413);
  }

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
    .select("id, contractor_id, address, data")
    .eq("sow_unit_id", unitId)
    .eq("sow_project_number", projectNumber)
    .limit(1);
  const wo = woRows && (woRows[0] as Record<string, unknown> | undefined);
  if (!wo || String(wo.contractor_id) !== contractorId) {
    return jsonResponse({ error: "Not your work order" }, 403);
  }
  const woAddress = (wo.address == null) ? "" : String(wo.address);
  const createdBy = user.phone || contractorId;

  // Insert a staff review-queue row (service role). Every submission surfaces on
  // the landing-page worklist: invoices as 'pending' (need approval), photos and
  // notes as 'new' (flagged to read). Returns true on success. For a photo/note
  // the file/audit row written alongside is authoritative, so a failure here is
  // non-fatal; for an INVOICE this row IS the approval workflow (nothing enters
  // the payment schedule without it), so the caller treats a failure as fatal.
  async function recordSubmission(fields: Record<string, unknown>): Promise<boolean> {
    try {
      const { error } = await admin.from("contractor_submissions").insert(Object.assign({
        contractor_id:      contractorId,
        unit_id:            unitId,
        sow_project_number: projectNumber,
        address:            woAddress,
        created_by:         createdBy,
        created_at:         new Date().toISOString(),
      }, fields));
      return !error;
    } catch (_e) { return false; }
  }

  // Note: no file. Record an append-only contractor_note audit row against the
  // unit (authoritative; shows in the master Audit Log), and best-effort append
  // it to the SOW's data.contractorNotes[] so it rides the work order too.
  if (kind === "note") {
    const nowIso = new Date().toISOString();
    try {
      await admin.from("housing_audit_log").insert({
        entity_type: "tenant",
        entity_id:   unitId,
        action:      "contractor_note",
        detail:      JSON.stringify({
          text: noteText, project_number: projectNumber, source: "contractor_portal",
          actor_name: user.phone || contractorId,
        }),
        actor:       user.phone || user.id,
        created_at:  nowIso,
      });
    } catch (_e) {
      return jsonResponse({ error: "Could not save the note" }, 500);
    }
    try {
      const { data: sowRows } = await admin.from("housing_sow").select("data").eq("unit_id", unitId).limit(1);
      const sowRow = sowRows && (sowRows[0] as Record<string, unknown> | undefined);
      const data = sowRow && (sowRow.data as Record<string, unknown> | undefined);
      const sows = data && Array.isArray(data.sows) ? data.sows as Array<Record<string, unknown>> : null;
      if (sows) {
        const sow = sows.find((s) => s && String(s.project_number) === projectNumber);
        if (sow) {
          if (!Array.isArray(sow.contractorNotes)) sow.contractorNotes = [];
          (sow.contractorNotes as Array<Record<string, unknown>>).push({
            text: noteText, at: nowIso, by: user.phone || contractorId,
          });
          await admin.from("housing_sow").update({ data: data, updated_at: nowIso }).eq("unit_id", unitId);
        }
      }
    } catch (_e) { /* best-effort; the audit row above is the authoritative record */ }
    // Flag it on the staff worklist (no approval needed for notes).
    await recordSubmission({ kind: "note", status: "new", text: noteText });
    return jsonResponse({ ok: true, kind: "note" });
  }

  // Progress: no file, no approval. Write the contractor-reported % to the SOW's
  // work-progress field (sow.progress.percent) so it drives the staff Progress
  // columns immediately, and mirror it onto this work order's projection row so
  // the contractor sees it persist in the portal. Stamped by:'contractor' so a
  // staff reno-progress update can still override it (last write wins).
  if (kind === "progress") {
    const nowIso = new Date().toISOString();
    try {
      const { data: sowRows } = await admin.from("housing_sow").select("data").eq("unit_id", unitId).limit(1);
      const sowRow = sowRows && (sowRows[0] as Record<string, unknown> | undefined);
      const data = sowRow && (sowRow.data as Record<string, unknown> | undefined);
      const sows = data && Array.isArray(data.sows) ? data.sows as Array<Record<string, unknown>> : null;
      const sow = sows ? sows.find((s) => s && String(s.project_number) === projectNumber) : null;
      if (!data || !sow) return jsonResponse({ error: "Work order not found" }, 404);
      const prevProgress = (sow.progress && typeof sow.progress === "object") ? sow.progress as Record<string, unknown> : {};
      sow.progress = Object.assign({}, prevProgress, {
        percent: percent, updatedAt: nowIso, by: "contractor", byName: user.phone || contractorId,
      });
      await admin.from("housing_sow").update({ data: data, updated_at: nowIso }).eq("unit_id", unitId);
    } catch (_e) {
      return jsonResponse({ error: "Could not save progress" }, 500);
    }
    // Mirror onto the projection so the contractor's portal reflects it on reload
    // (best-effort; the SOW write above is authoritative and drives staff views).
    try {
      const woData = (wo.data && typeof wo.data === "object") ? wo.data as Record<string, unknown> : {};
      woData.progressPercent = percent;
      await admin.from("contractor_work_orders").update({ data: woData, updated_at: nowIso }).eq("id", wo.id);
    } catch (_e) { /* non-fatal */ }
    try {
      await admin.from("housing_audit_log").insert({
        entity_type: "tenant", entity_id: unitId, action: "contractor_progress",
        detail: JSON.stringify({ percent: percent, project_number: projectNumber, source: "contractor_portal", actor_name: user.phone || contractorId }),
        actor: user.phone || user.id, created_at: nowIso,
      });
    } catch (_e) { /* non-fatal */ }
    return jsonResponse({ ok: true, kind: "progress", percent: percent });
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

  // 6) Flag it on the staff worklist. An INVOICE is 'pending' -- staff approve
  //    it on the landing page, which is what creates the payment draw on the SOW
  //    (NOT auto-created here anymore, so nothing enters the payment schedule
  //    without review). A PHOTO is 'new' -- already filed to Documents above, but
  //    flagged so staff know to look.
  const recorded = await recordSubmission({
    kind:      kind,
    status:    (kind === "invoice") ? "pending" : "new",
    amount:    (kind === "invoice") ? amount : null,
    file_path: path,
    file_name: filename,
    file_type: contentType,
  });
  // For an invoice, the review-queue row is the workflow: if it did not record,
  // tell the contractor so they retry rather than believing it was submitted.
  if (kind === "invoice" && !recorded) {
    return jsonResponse({ error: "The invoice was received but could not be queued for review. Please try again." }, 500);
  }

  return jsonResponse({ ok: true, name: displayName });
});
