# Protecting `admin.fnhub.app` with Cloudflare Access (Zero Trust)

Goal: require SSO / email-OTP **before the admin panel page even loads**, so the
public can't view the source (which includes pricing, the agreement template,
and app logic), and add a second independent auth layer in front of the panel's
own magic-link + `super_admins` gate.

This is a **dashboard-only** change — no code, no redeploy. Free: Cloudflare
Zero Trust covers up to 50 users at no cost.

> ⚠️ **The one thing you must get right:** apply Access to the **`admin`
> subdomain only** (`admin.fnhub.app`). Never scope it to `fnhub.app` or
> `*.fnhub.app` — that would gate **every nation's app** (`clfn.fnhub.app`,
> `demo.fnhub.app`, …) and lock out all staff and tenants.

---

## Prerequisites

- The `fnhub.app` zone is already in this Cloudflare account (it is — the app
  runs on it).
- You can receive email at each admin address you'll allow-list.

## Step 1 — Turn on Zero Trust (one-time)

1. Cloudflare dashboard → **Zero Trust** (left sidebar).
2. If it's your first time, pick a **team name** (e.g. `nationpathways`). Your
   team login domain becomes `nationpathways.cloudflareaccess.com`.
3. Choose the **Free** plan when prompted (no card needed for ≤50 users).

## Step 2 — Pick a login method

Zero Trust → **Settings → Authentication → Login methods**.

- **One-time PIN** (email OTP) is on by default and needs no setup — users enter
  their email and get a 6-digit code. This alone is sufficient for a small admin
  set.
- *(Optional)* Add **Google / Microsoft / GitHub** as an identity provider for
  true SSO. Recommended if the admin emails are Google/M365 accounts, since it
  then inherits that account's MFA.

## Step 3 — Create the Access application

Zero Trust → **Access → Applications → Add an application → Self-hosted**.

- **Application name:** `FN Hub Admin`
- **Session duration:** `24 hours` (shorten to `8 hours` or `1 hour` for tighter
  security — users re-auth after it expires).
- **Application domain:** subdomain `admin`, domain `fnhub.app`, **path blank**
  (protects the whole panel). Confirm it reads exactly **`admin.fnhub.app`**.
- **Identity providers:** tick One-time PIN (and any IdP you added in Step 2).
- Continue to policies.

## Step 4 — Add the allow-list policy

- **Policy name:** `Admins`
- **Action:** **Allow**
- **Configure rules → Include → Selector: `Emails`** → add each admin address
  exactly:
  - `kevint.proctor@gmail.com`
  - `kevin.proctor@clfn.on.ca`
  - (add/remove here as your admin team changes)
- *(Optional hardening)* add a **Require** block — e.g. Require → Login Method →
  your SSO IdP — so email-OTP alone isn't accepted.
- Save the policy, then **Save / Add application**.

## Step 5 — Verify

1. Open `https://admin.fnhub.app` in a **private/incognito window**.
2. You should be redirected to a **Cloudflare Access login** (email → OTP, or
   your IdP) *before* any panel content appears.
3. After authenticating, the panel loads and you sign into the app itself
   (magic link) as before.
4. In a normal window where you're already authed, confirm a nation app
   (`clfn.fnhub.app`) still loads with **no** Access prompt — proving the policy
   is scoped to `admin` only.

---

## How this fits the existing security

Access is a **second, independent layer**, not a replacement:

1. **Cloudflare Access** — must pass before the page/source loads (new).
2. **App magic-link sign-in** — the panel's own Supabase auth (existing).
3. **`super_admins` + RLS** — the database gate that actually protects every
   nation's data server-side (existing).

Keep all three. For least confusion, **keep the Access email list in sync with
the `super_admins` table** — same addresses in both.

### Notes / gotchas

- **The panel's API calls are unaffected.** The page loads from
  `admin.fnhub.app` (now gated by Access), but its data calls go to the
  control-plane Supabase host (`…supabase.co`), a different origin Access does
  not intercept. Those stay protected by Supabase RLS.
- **All paths are gated**, including `admin.js` / `admin-config.js` — that's the
  point (hides the source + pricing).
- **No service tokens needed** — the admin panel is browser-only; nothing
  automated hits `admin.fnhub.app`. (If that ever changes, add an Access
  *service token* for the automation rather than weakening the policy.)
- **Removing access** for someone = delete their email from the `Admins` policy
  **and** from the `super_admins` table.
- This does **not** touch the deploy pipeline — the `fnhub-admin` Worker and its
  CI deploy are unchanged; Access sits in front of the served domain.
