/**
 * Cloudflare Email Worker - Housing email intake.
 *
 * Bound to a Cloudflare Email Routing address (e.g. files@clfn.on.ca). When a
 * staff member FORWARDS an email there, this worker parses the MIME, base64s
 * the attachments, and POSTs the whole thing to the Supabase `email-intake`
 * Edge Function, which stores it and creates ONE triage row for staff to assign
 * to a unit / tenant in the app (triage-first: nothing is auto-filed here).
 *
 * This worker is deployed as its OWN Cloudflare Worker (Email Workers) - it is
 * NOT part of the nation site's static assets. See README.md for setup.
 *
 * Required environment (wrangler.toml [vars] + secrets):
 *   EMAIL_INTAKE_URL     - https://<project>.supabase.co/functions/v1/email-intake
 *   EMAIL_INTAKE_SECRET  - shared secret; must equal the Edge Function's secret (a wrangler SECRET)
 *   FORWARD_ON_FAIL      - optional mailbox to forward to if intake POST fails (so nothing is lost)
 *   MAX_ATTACHMENT_BYTES - optional per-attachment cap (default 8 MB)
 */

import PostalMime from 'postal-mime';

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 0x8000; // avoid call-stack limits on large buffers
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export default {
  async email(message, env, ctx) {
    const forwardOnFail = async () => {
      if (env.FORWARD_ON_FAIL) { try { await message.forward(env.FORWARD_ON_FAIL); } catch (_) {} }
    };
    try {
      const raw = await new Response(message.raw).arrayBuffer();
      const email = await PostalMime.parse(raw);

      const maxAtt = Number(env.MAX_ATTACHMENT_BYTES) || (8 * 1024 * 1024);
      const attachments = (email.attachments || [])
        .slice(0, 15)
        .map((a) => {
          const content = a.content; // ArrayBuffer for binary parts
          const size = (content && content.byteLength) || 0;
          if (!size || size > maxAtt) return null;
          return {
            name:        a.filename || 'attachment',
            contentType: a.mimeType || 'application/octet-stream',
            size:        size,
            contentBase64: arrayBufferToBase64(content)
          };
        })
        .filter(Boolean);

      const from = (email.from && email.from.address) || message.from || '';
      const payload = {
        messageId: email.messageId || '',
        from:      String(from).toLowerCase(),
        fromName:  (email.from && email.from.name) || '',
        to:        message.to || (email.to && email.to[0] && email.to[0].address) || '',
        subject:   email.subject || '',
        text:      email.text || '',
        html:      email.html || '',
        attachments: attachments
      };

      const resp = await fetch(env.EMAIL_INTAKE_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-intake-secret': env.EMAIL_INTAKE_SECRET },
        body:    JSON.stringify(payload)
      });
      if (!resp.ok) {
        console.log('[email-worker] intake POST failed: ' + resp.status);
        await forwardOnFail();
      }
    } catch (e) {
      console.log('[email-worker] error: ' + (e && e.message ? e.message : e));
      await forwardOnFail();
    }
  }
};
