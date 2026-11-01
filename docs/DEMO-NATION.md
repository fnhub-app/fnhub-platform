# Demo nation — build plan (`demo.fnhub.app`)

A permanently-live, self-contained instance of the platform running a **fictional
nation**, used for sales demos, screenshots, and marketing video. It is a real
nation on the real platform — its own Supabase project, its own subdomain, its
own data — so what a prospect sees is exactly what they would buy, not a mockup.

**Status:** **live at https://demo.fnhub.app** — provisioned, branded, and seeded
(D0/D1/D2/D4 done via `supabase/demo/demo-config.sql` + `docs/demo-seed.js`).
**D3 (`is_demo` guardrails) is NOT built** — there is no client-side email/SMS
suppression, no demo banner, and no `noindex` meta. The live controls today are
(a) the demo project having **no outbound provider credentials** and (b) the
sensitive modules being pinned OFF in `demo-config.sql`. Building D3 is still
open and is now higher priority because the environment is live, not planned.

---

## 1. Decisions (locked)

| Question | Decision |
| --- | --- |
| Hosting | **Real Supabase project** (`fnhub-demo`), database-per-nation like every customer |
| URL | `demo.fnhub.app` — covered by the existing `*.fnhub.app` wildcard cert |
| Access | **Private — sales team only.** Credentials live in the team password manager, never in this repo, never published |
| Writes | **Full writes.** A visitor can approve, match, generate PDFs, award an RFQ — the whole workflow |
| Cleanup | **Nightly automated reset** to a pristine seeded state, plus an on-demand reset |
| Data source | **Synthetic.** No CLFN data, scrubbed or otherwise |

### Non-goals (for v1)
- Self-serve prospect signup / lead capture — deferred until the demo has proven
  itself in live calls.
- A public "try it" link. The URL is shared deliberately, one prospect at a time.
- Any change to CLFN's live instance beyond the gated `is_demo` guardrails in §4.

---

## 2. Why this is also a platform test

The demo is the **first end-to-end exercise of the Phase N provisioning path**
(`docs/NATION-ONBOARDING.md` Part B + the `provision-nation` Edge Function).
Every step that turns out to be manual, undocumented, or broken while standing
up the demo is a step that would have broken on the first paying nation instead.

Concretely, it forces the one blocking N1 item that is still open: there is no
committed `supabase/bootstrap/schema.sql`, so no nation can currently be
provisioned reproducibly. That is workstream **D0** below, and it is a hard
prerequisite — not something to work around with hand-run SQL, because a
hand-built demo would drift from the real schema within weeks and stop being a
faithful preview of the product.

**Rule for the whole build:** if a step can't be done through the documented
provisioning path, fix the path rather than the demo.

---

## 3. Workstreams

### D0 — Capture the schema  *(blocking, user-run)*
- With the Supabase CLI linked to CLFN: `supabase db dump --linked -f supabase/bootstrap/schema.sql`, then commit it.
- Verify the dump is complete: tables, RLS policies, triggers, functions, sequences, and the `tenants` sync trigger.
- Adopt the standing rule already written in `supabase/bootstrap/README.md` — **regenerate the dump whenever a migration lands**, or every new nation (including the demo) starts behind. Add it to the migration checklist so it isn't remembered by luck.

**Effort:** small (one command + verification), but it gates everything else.

### D1 — Provision the demo nation
1. Create Supabase project `fnhub-demo` (via the admin panel's provisioning wizard, so the wizard gets exercised).
2. Apply `supabase/bootstrap/schema.sql` + `supabase/seed.sql` (storage bucket).
3. Deploy the Edge Functions the demo needs: `ai-chat`, `applicant-intake`, `tenant-mr`, `send-magic-link`, and `send-notification` — the last one **deliberately without working provider credentials** (see §4).
4. Add the `nations` registry row (`subdomain: 'demo'`, status `active`) on the platform project. **Do not** hardcode the demo in `NATIONS_DIRECTORY` — routing it through the registry is a live test of the registry path that CLFN's hardcoded entry can never exercise.
5. Cloudflare: confirm `demo.fnhub.app` resolves through the wildcard (no new DNS record needed) and add a Transform Rule setting `X-Robots-Tag: noindex, nofollow` for `host = demo.fnhub.app`.
6. Supabase Auth → URL Configuration: Site URL `https://demo.fnhub.app`.

**Effort:** half a day, assuming D0 is clean.

### D2 — Nation identity (config only)
Everything here is configuration; the CLAUDE.md hard rule means **no literal
belongs in code** — not the demo nation's name either. A hardcoded `"Demo First
Nation"` is exactly the bug the rule exists to prevent.

- **Name: `Demo First Nation` (short `DEMO`)** — decided 2026-08-16. A plausible invented name (e.g. "Riverbend First Nation") would look better on video, but carries a residual risk of colliding with a real band, and a screenshot could read as a real community's private housing file. A generic name removes both. Note this is a *configuration value*, not a code literal — the CLAUDE.md hard rule still applies, and a hardcoded `"Demo First Nation"` anywhere in the source is exactly the bug it exists to prevent.
- **Registry row values** (admin panel → Add a nation):

  | Field | Value | Note |
  | --- | --- | --- |
  | Subdomain | `demo` | the only field that is expensive to change later |
  | Short code | `DEMO` | surfaces as `NATION_CONFIG.short` |
  | Display name | `Demo First Nation` | editable any time via Configure |
  | Supabase URL / anon key | **blank until D1 completes** | blank registers `status: 'provisioning'`, and `nations_public` only exposes `status = 'active'`, so the subdomain stays dark until the project is ready |
  | Staff email domain | `demo.fnhub.app` | **a hard sign-in gate** (`auth-login.js:412` rejects any other domain before the network call) |
  | Primary color | `#4FC3F7` | must be **light**: it is a fill behind dark text (PDF header strips + table headers, `shared-data.js:8829`; `--accent` on the public portals). A dark brand colour makes generated PDFs unreadable |
  | Licensed modules | all **9** ticked | licensing only — the in-app Settings → Nation → Modules toggles (`_enabled`) are separate and also need turning on |

- **Also set in `housing_settings`:** `nation_config_override` (display name, contact block, mailing address, province) and the `theme` key (primary colour + logo) so generated PDFs, leases, and emails carry demo branding.
- **Logo:** a generic invented mark. Not the CLFN logo, not a real nation's. **Still open.**
- **Demo accounts must match the email domain** — `ed@demo.fnhub.app`, `manager@demo.fnhub.app`, etc. Nothing delivers mail to that domain, so create them in the Supabase dashboard with **auto-confirm on**, or they will sit unverified with no way to receive a confirmation link.

**Effort:** small. Name is settled; only the logo is outstanding.

### D3 — Demo-mode guardrails  *(the only shipped-app code change)*
Add an `is_demo` boolean to the nation config (registry column + `nations_public`
view + `_mapNationRow` in `shared-config.js`). It is false everywhere except the
demo, so CLFN's boot is unchanged. It then drives four behaviours:

1. **Outbound email is suppressed at the single chokepoint.** `window.sendNotification` (`shared-data.js:3475`) is the one door every message goes through. In demo mode it short-circuits before the fetch, writes the audit row it would have written, and shows the composed message in the existing message box: *"Demo — email suppressed. Would have sent to X: <subject>."* This is a **better** demo than actually sending (the prospect sees the email content without waiting for an inbox), and it means the demo can never mail a real person.
2. **Defense in depth at the provider.** The demo project's `send-notification` gets **no** working provider credentials, so even a code path that bypassed the client guard cannot deliver mail. Both layers, not either.
3. **A persistent demo banner** in `renderAppHeader` (`housing-init.js:2034`): *"DEMO — fictional data. Resets nightly."* Present on every page, including the public applicant/report portals.
4. **`noindex`** — a `<meta name="robots" content="noindex,nofollow">` injected from `shared.js` when `is_demo`. The Cloudflare `_headers` file is path-scoped, not host-scoped, and the same static assets serve every subdomain, so a `_headers` rule or a `robots.txt` **cannot** target only the demo. The meta tag plus the D1 Transform Rule is how this actually gets done.

**SMS guardrail (added 2026-10 — SMS Phase 1).** Email is not the only outbound
channel anymore. `window.sendSms` (`shared-data.js`) is a **second, parallel
chokepoint** that `is_demo` does **not** yet guard. Mirror behaviour 1 for it:
in demo mode `sendSms` short-circuits before the fetch, writes its audit row, and
shows *"Demo — text suppressed. Would have sent to X: <body>."* **And** the
defense-in-depth layer (behaviour 2) applies identically — the demo project gets
**no Twilio secrets** (`SMS_PROVIDER`/`TWILIO_*` unset), so `send-sms` returns a
not-configured error even if the client guard were bypassed. Until the client
short-circuit lands, two things are the live control: leaving Twilio unset on the
demo project (no credentials = no text can leave), **and** pinning both
**`sms_notifications` and `contractor_portal` OFF** in `demo-config.sql` (done —
the `sms_notifications` code default is `true`, so it must be explicitly false or
the demo silently has SMS on). The portal's login also needs Twilio Verify (real
texts to real phones), which the demo avoids; the portal story can be shown from
a scripted walkthrough rather than a live send.

**The Anthropic key for `ai-chat`** — yes, load it; the assistant demos
extremely well and a demo without it undersells the product. Three rules:
- **A separate key from CLFN's**, created for the demo, so it can be revoked or
  capped without touching production and demo usage never lands on CLFN's bill.
- **A low spend cap** set on that key in the Anthropic Console.
- **Stored only as an Edge Function secret** in the demo project (Project
  Settings → Edge Functions → Secrets), never in the repo or client code.

Exposure is narrower than it first appears: `ai-chat` requires a valid Supabase
user JWT and resolves the caller's role from the `staff` table, rejecting
non-staff with a 403 — so an anonymous crawler cannot spend anything. The cap
guards against a logged-in prospect hammering it, which is a real but bounded
risk. Load the key at D1 step 3, when `ai-chat` is deployed; it is not needed to
register the nation row.

**Effort:** small. Low risk — every branch is behind `is_demo`.

### D4 — The seed pack  *(the real work)*
`supabase/demo/seed-demo.sql` — deterministic, idempotent, entirely fictional,
and sized so that **no screen in the app is empty**. An empty worklist or a blank
dashboard is what kills a demo.

**Design rule: every date is relative to `now()`, never a literal.** Seed
"submitted 6 days ago", not "2026-08-10". Otherwise the demo visibly rots — the
12-month trend chart empties out, overdue inspections stop being overdue, lease
end dates drift into the past. Implement as a function using intervals so the
nightly reset in D5 re-derives fresh dates every single night.

Coverage target:

| Data | Volume | Must include |
| --- | --- | --- |
| Staff | ~8 | one per role: ed, housing_manager, he_l2, he_l1, field_employee, cfo, finance_l1, super_user |
| Units | ~45 | funder + bedroom mix; occupied / vacant / reserved; a few elders units; at least one **Temporary** and one **Transition** (drives the Match Priority story); lat/long clustered on a plausible fictional location so the map widget renders |
| Tenants | ~35 | lease dates, a spread of arrears, a couple with no email on file |
| Applications | ~25 | all three `app_type`s, all statuses and tiers; drafts owned by the demo ED; one returned; several approved-awaiting-match; one transfer request so the "On Rez" badge shows |
| Maintenance requests (SOWs) | ~15 | every `approval_status`; one **System Approved** via RFQ; one assigned in-house to the field employee |
| Contractors | ~10 | mixed approval status; one with **expired WSIB** so the award eligibility warning fires |
| RFQs | 3 | one draft, one issued with bids recorded, one awarded with a contract |
| Inspections | ~8 | one failed that spawned a SOW; one overdue |
| Capital projects | 2 | a lot development and a house build — milestones, grants, expenses with attached docs, one submitted payment request |
| Finance | — | rent ledger, a loan, an arrangement, some collections activity |
| Audit log | — | enough history that Recent Activity and the audit view aren't blank |
| Other | — | tenant notes, 1–2 fictional BCR registry entries, placeholder PDFs/photos in Storage so DocLibrary isn't empty |

**Effort:** the bulk of the project — 2–3 days, and iterative. Expect to walk the
demo script (D6) and go back for more data twice.

### D5 — Nightly reset
- A `demo_reset()` SQL function in the demo project: truncate the app tables → clear the storage bucket → re-run the seed. Transactional, and it writes an audit row so you can tell a reset from a person.
- **Preserve `auth.users` and `staff`** — wiping those would invalidate the demo passwords every night. Everything else, including `housing_settings`, is re-seeded, so a prospect who fiddles with the scoring model or the approval matrix doesn't leave it changed.
- Schedule with `pg_cron` at **07:00 UTC (~3am ET)** — far from any plausible demo slot.
- **On-demand reset:** a button in the admin panel (and/or Settings, visible only when `is_demo` and role is ED) so you can re-seed between two back-to-back calls.
- **A pause flag** so a reset can't fire mid-demo if someone books an unusual hour.

**Effort:** half a day.

### D6 — Accounts, then the actual marketing asset
- Create the ~8 auth users with strong distinct passwords, stored in the team password manager. No published credentials, no one-click "sign in as ED" buttons on the login screen — those are for a future self-serve demo, not this one.
- Idle timeout stays on, unchanged.
- *Optional hardening:* Cloudflare Access in front of `demo.fnhub.app`. Note it would also gate the public applicant/report portals, so it needs path exclusions if you want to demo those.
- **`docs/DEMO-SCRIPT.md`** — a ~10-minute guided path, which is what turns this from a test environment into a marketing asset: sign in as ED → worklist → approve an application → match it to a unit → generate the occupancy agreement → raise a maintenance request → issue an RFQ → award it → a capital project claim package → the Chief & Council dashboard → ask the AI assistant a question. Plus a screenshot/video capture checklist so marketing shots stay consistent.

**Effort:** ~1 day, mostly writing and rehearsing.

---

## 4. Sequencing

```
D0 schema dump ─┬─> D1 provision ──> D2 identity ──> D4 seed pack ──> D6 script
                └─> D3 guardrails (parallel, independent)
                                     D5 reset (after D4)
```

D3 is the only workstream touching the shipped app and has no dependency on the
others, so it can land while the Supabase project is being stood up.

**Total: roughly a week of focused work**, dominated by D4.

---

## 5. Risks

| Risk | Mitigation |
| --- | --- |
| **Schema drift** — demo falls behind CLFN and stops being a faithful preview | Regenerate `bootstrap/schema.sql` on every migration (D0's standing rule); re-provisioning the demo is the cheapest way to detect drift |
| **The demo emails a real person** | Two independent layers: client-side suppression at `sendNotification`, and no working provider credentials on the demo project |
| ~~**The fictional nation name collides with a real community**~~ | **Closed** — `Demo First Nation` is generic by design, so there is nothing to collide with. If the name is ever revisited in favour of something more immersive, verify it against the ISC First Nation Profiles registry *before* it reaches a logo, a URL, or a slide |
| **Google indexes the demo** | `noindex` meta from `shared.js` + a host-scoped Cloudflare Transform Rule; private credentials as the real control |
| **AI assistant cost creep** | Demo-project-specific Anthropic key with a hard spend cap |
| **A reset fires mid-demo** | 3am ET schedule + a pause flag |
| **Supabase free-tier projects pause after inactivity** | Confirm the tier before launch; nightly `pg_cron` activity may be enough, but a paused demo during a sales call is not a risk worth taking — budget for Pro |
| **Seeded data ages badly** | All dates seeded as intervals from `now()`, re-derived on every nightly reset |

---

## 6. Open questions

1. ~~**Nation name**~~ — settled 2026-08-16: **`Demo First Nation`** / `DEMO` / `demo.fnhub.app`, deliberately generic so it can never be mistaken for a real community. **Logo still open** — needs a generic invented mark.
2. **Public portals** (`apply.html`, `report.html`, tenant maintenance request) — live on the demo, or disabled? Live shows off the whole intake story but means anyone with the URL can post into the demo. Recommendation: live, with the banner and email suppression; the nightly reset cleans up whatever they leave.
3. **Supabase tier** for the demo project — free vs Pro (see the pausing risk above).
4. **Who else gets the credentials** beyond you — that determines whether the password manager entry is shared or personal.
