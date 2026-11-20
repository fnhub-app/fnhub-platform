# AI Assistant — per-nation setup

> **The AI key is the platform owner's (Nation Pathways') key — never the
> nation's.** AI usage is the platform's cost, not the nation's. Nation Pathways
> owns the Anthropic account, supplies the key, and pays for all usage; the nation
> has **no separate Anthropic bill**. The AI Staff Assistant add-on fee ($150/mo,
> flat for every plan size, includes up to 3,000,000 AI tokens/month) covers it, and the in-app help chat (`support-chat`)
> runs on **every** plan — including nations without the AI add-on — also at the
> platform's cost. Each nation's usage is tracked per month (see "Usage tracking"
> below) so the platform can see cost per nation and, optionally, apply a fair-use
> limit.

The AI chat (and draft-note) assistant is backed by the **`ai-chat` Edge
Function**, which runs on each nation's own Supabase project and reads that
project's **`ANTHROPIC_API_KEY`** secret. So every nation needs two things:

1. the `ai-chat` (and `send-notification`) functions **deployed** to its project, and
2. the **platform owner's Anthropic API key** set as the `ANTHROPIC_API_KEY`
   secret on that project (set by the platform, from the admin portal — the
   nation is never asked for a key).

Fresh provisioning runs the database schema but does **not** deploy Edge
Functions, which is why a brand-new nation (e.g. the demo) shows
"failed to fetch" in AI chat — there is no function to call yet.

## 1. Deploy the nation functions to a nation's project

Use the **"Deploy Supabase Edge Functions"** GitHub workflow with a target ref:

- GitHub → Actions → **Deploy Supabase Edge Functions** → **Run workflow** →
  set **project_ref** to the nation's project ref (the `<ref>` in
  `https://<ref>.supabase.co`, shown in the admin NIC → Supabase tab) → Run.

This deploys `ai-chat`, `send-notification`, and the other nation functions to
that project. (Leaving `project_ref` blank targets the default
`SUPABASE_PROJECT_ID` secret — the lead nation.) Control-plane functions
(`provision-nation`, `report-nation-usage`, `recurring-invoices`,
`set-nation-secret`) are skipped by this workflow by design.

CLI equivalent, if you prefer:
`supabase functions deploy ai-chat --project-ref <nation-ref>`

## 2. Set the platform owner's Anthropic key from the admin portal

In the admin portal → open the nation → **Supabase** tab → **AI Assistant key**:
paste **the platform owner's (Nation Pathways') `sk-ant-...` key** and **Save &
apply to project**. (Use the platform's own Anthropic key for every nation — the
nation does not supply one.)

This calls the control-plane **`set-nation-secret`** function, which writes the
key straight into that nation project's `ANTHROPIC_API_KEY` secret via the
Supabase Management API. The key is **never** stored in the control plane or
sent back to the browser — only a masked marker (`...1234` + timestamp) is kept
on the nation row so the panel can show "key set".

### One-time platform setup for the key feature
- Run `supabase/platform/nation_ai_key.sql` on the platform project (adds the
  masked-marker columns).
- The `set-nation-secret` function needs the **`SB_MGMT_TOKEN`** secret on the
  platform project — the same Management API token `provision-nation` already
  uses. `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` are
  auto-injected.

## Result

Once the functions are deployed and the platform owner's key is set, AI chat
works for that nation, billed to the **platform owner's** Anthropic account (not
the nation's). Disabling the `ai_assistant` module (Settings → Nation → Modules)
hides the assistant regardless.

## Usage tracking & fair-use limit

- **Tracking.** `ai-chat` and `support-chat` record the Anthropic
  `input_tokens` / `output_tokens` of every response in the audit row's detail
  (actions `ai_query` / `ai_draft` / `support_chat`). `hs_data_usage()` sums the
  current calendar month's tokens; `report-nation-usage` carries them to the
  control-plane `nation_usage` table; the admin **Nations** dashboard prices them
  (Sonnet 5.5: US$2 / M input, US$10 / M output) into each nation's monthly
  hosting estimate. Run `supabase/platform/nation_usage_ai.sql` (platform) and
  the `20261114_ai_usage_tracking.sql` migration (fleet) once to enable this.
- **Optional fair-use limit (default off).** A nation can be given a monthly
  token ceiling in its own `housing_settings` row `key='ai_fair_use'`
  (`{"monthly_tokens": N}`; 0 or absent = no limit). When month-to-date usage
  reaches it, `ai-chat` returns *"This nation has reached its monthly AI usage
  limit. Please contact your administrator."* instead of calling Anthropic.

## Redeploy note

Changes to `ai-chat` / `support-chat` / `report-nation-usage` take effect only
after redeploy (the **Deploy Supabase Edge Functions** workflow per nation, or
`supabase functions deploy`). `ai-chat` and `support-chat` are nation functions
(deploy to each nation project); `report-nation-usage` is control-plane.
