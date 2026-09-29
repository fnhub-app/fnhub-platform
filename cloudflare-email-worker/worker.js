/**
 * Cloudflare Email Worker - Housing email intake (generic, multi-nation).
 *
 * Bound to a Cloudflare Email Routing address of the form <nation>@fnhub.app
 * (e.g. clfn@fnhub.app). When a staff member FORWARDS an email there, this
 * worker parses the MIME, base64s the attachments, resolves WHICH nation from
 * the recipient's local part, looks up that nation's Supabase project in the
 * platform registry (nations_public), and POSTs to that nation's email-intake
 * Edge Function. Triage-first: nothing is auto-filed.
 *
 * One generic worker serves every nation: a nation enrolled in the registry
 * works automatically, no per-nation worker or code change.
 *
 * Deployed as its OWN Cloudflare Worker (Email Workers) - NOT part of the
 * nation site's static assets. See README.md for setup.
 *
 * Env:
 *   EMAIL_INTAKE_SECRET     - REQUIRED. The shared secret; must equal each
 *                             nation's email-intake EMAIL_INTAKE_SECRET.
 *   PLATFORM_REGISTRY_URL   - optional override (defaults below; public).
 *   PLATFORM_REGISTRY_ANON  - optional override (defaults below; publishable).
 *   FORWARD_ON_FAIL         - optional mailbox to forward to on failure.
 *   MAX_ATTACHMENT_BYTES    - optional per-attachment cap (default 8 MB).
 */

import PostalMime from 'postal-mime';

// Public platform registry (same values the deploy workflow uses). The anon
// key is publishable (ships to every browser); safe to embed here.
const REGISTRY_URL  = 'https://dnaxulsdetlnpupegoiq.supabase.co';
const REGISTRY_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRuYXh1bHNkZXRsbnB1cGVnb2lxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU0NDQ5OTksImV4cCI6MjEwMTAyMDk5OX0.HYKgIe_inzHFk518ilfmhQUqtlldkTSoiwnmcwuaw_A';

// In-isolate cache of the nation list (subdomain -> supabase_url), 5 min TTL.
let _regCache = null, _regAt = 0;

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return btoa(binary);
}

async function resolveIntakeUrl(nation, env) {
  if (!nation) return null;
  const now = Date.now();
  if (!_regCache || now - _regAt > 300000) {
    const base = (env.PLATFORM_REGISTRY_URL || REGISTRY_URL).replace(/\/+$/, '');
    const anon = env.PLATFORM_REGISTRY_ANON || REGISTRY_ANON;
    const r = await fetch(base + '/rest/v1/nations_public?select=subdomain,supabase_url', {
      headers: { apikey: anon, authorization: 'Bearer ' + anon }
    });
    if (!r.ok) throw new Error('registry HTTP ' + r.status);
    _regCache = await r.json();
    _regAt = now;
  }
  const row = (_regCache || []).find((n) => String(n.subdomain || '').toLowerCase() === nation);
  if (!row || !row.supabase_url) return null;
  return String(row.supabase_url).replace(/\/+$/, '') + '/functions/v1/email-intake';
}

export default {
  async email(message, env, ctx) {
    const forwardOnFail = async () => { if (env.FORWARD_ON_FAIL) { try { await message.forward(env.FORWARD_ON_FAIL); } catch (_) {} } };

    // Which nation? The recipient local part is the nation subdomain
    // (clfn@fnhub.app -> "clfn"). Strip any +tag.
    const to = String(message.to || '').toLowerCase();
    const nation = to.split('@')[0].replace(/\+.*$/, '').trim();
    let intakeUrl;
    try {
      intakeUrl = await resolveIntakeUrl(nation, env);
    } catch (e) {
      console.log('[email-worker] registry lookup failed: ' + (e && e.message));
      await forwardOnFail();
      return;
    }
    if (!intakeUrl) { console.log('[email-worker] no nation for recipient "' + to + '"'); await forwardOnFail(); return; }

    try {
      const raw = await new Response(message.raw).arrayBuffer();
      const email = await PostalMime.parse(raw);
      const maxAtt = Number(env.MAX_ATTACHMENT_BYTES) || (8 * 1024 * 1024);
      const attachments = (email.attachments || []).slice(0, 15).map((a) => {
        const content = a.content;
        const size = (content && content.byteLength) || 0;
        if (!size || size > maxAtt) return null;
        return { name: a.filename || 'attachment', contentType: a.mimeType || 'application/octet-stream', size: size, contentBase64: arrayBufferToBase64(content) };
      }).filter(Boolean);

      const from = (email.from && email.from.address) || message.from || '';
      const payload = {
        messageId: email.messageId || '',
        from: String(from).toLowerCase(),
        fromName: (email.from && email.from.name) || '',
        to: to,
        subject: email.subject || '',
        text: email.text || '',
        html: email.html || '',
        attachments: attachments
      };

      const resp = await fetch(intakeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-intake-secret': env.EMAIL_INTAKE_SECRET },
        body: JSON.stringify(payload)
      });
      if (!resp.ok) { console.log('[email-worker] intake POST ' + resp.status + ' -> ' + intakeUrl); await forwardOnFail(); }
    } catch (e) {
      console.log('[email-worker] error: ' + (e && e.message ? e.message : e));
      await forwardOnFail();
    }
  }
};
