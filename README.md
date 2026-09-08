# Outreach Mailer

Send personalized outreach emails pitching your company's services, from your own Gmail or
a custom business email (SMTP), with open/click tracking, reply and bounce detection,
automated follow-up sequences, and a chat-based AI assistant that can act on your account
directly. A separate app from any job-application tool — built for sales/business outreach
instead.

Multi-user: anyone signs up with email/password, gets isolated settings, their own email
connection (Gmail OAuth or custom SMTP — pick either, per user), and their own send
history. Uses a shared platform OpenRouter key by default (with a daily cap); anyone can
add their own key in Settings for unlimited use. Everything is stored in Postgres — no
filesystem, no volume needed for the app itself.

- `/signup.html`, `/login.html` — accounts
- `/` — compose: pick a prospect (company, contact name, notes) or paste a LinkedIn
  bio/note and let AI pull out the details → generate → review → confirm → send. Warns if
  you've already emailed that address.
- `/bulk.html` — upload a CSV/Excel file (up to 50 rows) of prospects → generate a
  personalized pitch per row → review/edit → confirm → send as a batch
- `/sequences.html` — build a multi-step follow-up sequence (initial pitch → bump in 3
  days → breakup email in 7, or whatever cadence you want), enroll prospects, and the
  background scheduler sends each step automatically until it's done, stopped, bounces, or
  gets a reply
- `/agent.html` — chat with an AI assistant that has real access to your analytics,
  sequences, and drafting tools — see "AI Assistant" below
- `/logs.html` — activity log of everything the background schedulers and the AI assistant
  have done on your account
- `/settings.html` — your company info, arbitrary links (website, pricing page, case
  study, calendar booking link — add as many as you want), what you offer, any number of
  collateral docs (PDF/DOCX — each one's text can ground the AI, and you choose per-email
  whether to actually attach the file), email format instructions, OpenRouter key, sending
  method (Gmail OAuth or custom SMTP), open/click tracking toggles, manual bounce check
- `/history.html` — sent/opened/clicked/bounced/failed counts and rates, per-campaign
  breakdown (including sequences, tagged automatically), searchable log, CSV export

## How tracking actually works

**Opens**: every sent email is HTML (with a plain-text fallback for clients that don't
render HTML) containing an invisible 1×1 pixel image pointing back at this server. When the
recipient's email client loads that image, it's logged as an open. This is the same
mechanism basically all email tracking uses — and the same limitations apply: if the
recipient's client blocks remote images by default (many do, until the user clicks
"display images"), the open won't register even though they read the email. Treat open
rates as directional, not exact.

**Clicks**: any link in the email body gets rewritten to route through this server first,
which logs the click and then redirects to the real URL. A click also counts as an open
(in case the pixel itself got blocked).

**Bounces — read this carefully.** Gmail has no dedicated "delivery failed" webhook for
apps sending on a user's behalf. When a real bounce happens, Gmail auto-generates a
"Delivery Status Notification" email and drops it in *your own inbox* — so the only way to
detect it is to periodically scan your inbox for these auto-replies and try to match them
back to a specific send by looking for the recipient's address in the bounce message body.
That's what this app does, automatically every `BOUNCE_CHECK_INTERVAL_MINUTES` (default
15) for any connected account, plus a manual "Check for bounces now" button in Settings.

This is **best-effort, not authoritative**:
- Bounce notification formats vary between providers and aren't guaranteed to contain the
  failed address in a predictable place — the matching is a keyword + address-in-body
  heuristic, not a structured parse.
- Some bounces (soft bounces, greylisting, spam-folder silent drops) never generate a
  notification email at all, and won't be detected.
- There's a delay — bounces are only caught on the next sweep, not instantly.
- This requires the `gmail.readonly` scope in addition to `gmail.send` — reading someone's
  inbox is a more sensitive permission than sending, which raises the bar further for
  Google's app verification (see below). If you only care about tracking sends and don't
  need bounce data, you could remove `gmail.readonly` from `lib/google.js` and skip the
  bounce detector entirely — sending, opens, and clicks all work without it.

If real bounce data matters a lot for your use case, a dedicated transactional email
service (SES, Postmark, SendGrid, Mailgun) with proper bounce webhooks will be far more
reliable than anything built on top of a personal Gmail account. This app sends through
Gmail because that's what was asked for, not because it's the ideal tool for volume
outreach with hard deliverability requirements.

## Sending: Gmail or custom SMTP

Each user picks one active sending method in Settings:

- **Gmail** — OAuth, same as before. Requires the Google Cloud setup below.
- **Custom SMTP** — host, port, username, password, from address. Works with any provider
  (Google Workspace, Microsoft 365, a transactional service, whatever). No Google OAuth
  verification needed for this path. A "Test connection" button verifies credentials
  without sending anything.

Both connections can be saved at once — the `emailProvider` setting just decides which one
is actually used for the next send. Bounce detection currently only works for the Gmail
path (it needs to read the inbox via the Gmail API); SMTP-based sending doesn't get
automatic bounce checks.

## Follow-up sequences

A sequence is an ordered list of steps, each with a delay (in days) and an "angle" —
instructions telling the AI how that particular email should differ from the others (e.g.
step 1: full pitch; step 2: short bump referencing the first email; step 3: a polite
breakup email). Enrolling a prospect schedules step 1 immediately; a background sweep
(`SEQUENCE_CHECK_INTERVAL_MINUTES`, default 10) finds enrollments whose next step is due,
generates a fresh email for that step, sends it, and schedules the next one — or marks the
sequence complete if that was the last step.

What stops a sequence automatically:
- **A reply** — reply detection (below) marks the enrollment `replied` and it stops.
- A bounce on any step (the bounce detector marks the enrollment `bounced`).
- Manually clicking "Stop" on an enrollment.

Every sequence-generated send is tagged with a batch label of `Sequence: {name}`, so it
shows up automatically in the campaign breakdown on the Analytics page — no separate
reporting needed.

## Reply detection

Checks whether a prospect replied to a sent email — Gmail sending only (SMTP has no
equivalent). Unlike bounce detection (which has to guess from inbox keywords), this is
structurally reliable: every Gmail send has a `threadId`, and if any message shows up in
that thread that isn't from the connected account, that's a reply. Runs automatically as
part of the same sweep as bounce checking (`BOUNCE_CHECK_INTERVAL_MINUTES`, since both need
the same inbox read access), plus a manual "Check for replies now" trigger via
`/api/replies/check`. A detected reply marks the send `replied` in Analytics and, if it was
part of a sequence, stops that sequence automatically.

## Activity logs

`/logs.html` shows what's been happening in the background — every sequence step sent,
every bounce/reply sweep result, and every tool the AI assistant has used, each tagged with
a category and level (info/warn/error). This is the closest thing to an "admin panel" audit
trail in a per-user multi-tenant app like this — it's scoped to your own account, not a
global platform-wide log.

## AI Assistant

`/agent.html` is a chat interface to an agent that can actually do things in the app, not
just answer questions — it has real tool access to your analytics, sequences, and drafting.
Ask it things like "how am I doing this week," "set up a 3-step sequence for cold SaaS
leads," "enroll jane@acme.com in that sequence," or "draft an email to bob@prospect.com."

The one hard rule baked into the system prompt and the architecture itself, not just a
suggestion to the model: **the agent can never send an email on its own.** Its `draft_email`
tool only prepares a draft, which the UI renders as a card with editable To/Subject/Body
fields and a Send button — actually sending goes through the same `/api/send` endpoint (and
the same confirm step) as Compose. The agent can enroll someone in a sequence directly
(since that only *schedules* future sends, it doesn't send anything immediately), and it can
freely read analytics/history and manage sequences. Every tool call it makes is written to
the activity log, so nothing it does is invisible.

Uses the same OpenRouter key/model and the same shared-key daily cap as email generation —
a single chat exchange can consume more than one unit of that cap if the agent also drafts
an email in the same turn. Requires a model that supports OpenAI-style tool/function
calling; most models people actually use through OpenRouter (Claude, GPT-4-class models,
etc.) do.

## 1. Set up Postgres

Same as any Postgres 13+ database. Locally:

```bash
createdb outreach
```

On Railway: add a Postgres database to your project, then reference it from `DATABASE_URL`
(see step 4).

## 2. Run locally

```bash
npm install
cp .env.example .env
# fill in DATABASE_URL, and see step 3 for Google credentials, step 4 for the platform OpenRouter key
npm start
```

Tables are created automatically on first boot. Open http://localhost:3000, sign up.

## 3. Set up Google OAuth

Same process as any Gmail-sending app, but this one requests **two** scopes:
`gmail.send` and `gmail.readonly` (for bounce checking).

1. https://console.cloud.google.com/ → create/select a project.
2. **APIs & Services → Library** → enable the **Gmail API**.
3. **APIs & Services → OAuth consent screen** → User type External → add both scopes
   (`https://www.googleapis.com/auth/gmail.send` and
   `https://www.googleapis.com/auth/gmail.readonly`) → add test user emails.
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID** → Web
   application → redirect URIs:
   - `http://localhost:3000/auth/google/callback`
   - `https://YOUR-RAILWAY-DOMAIN/auth/google/callback` (add once deployed)
5. Set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.

**Verification note**: `gmail.readonly` reading a user's inbox is more sensitive than
`gmail.send`. While in Testing mode, only test users you've explicitly added (max 100) can
connect at all. To open this to the public, Google's app verification process applies —
likely with extra scrutiny given the readonly scope, possibly including a security
assessment. Budget real time for this if you plan to launch broadly.

## 4. Set the platform's shared OpenRouter key

Same pattern as before: get a key at https://openrouter.ai/keys, set
`PLATFORM_OPENROUTER_API_KEY` (+ optionally `PLATFORM_OPENROUTER_MODEL`), set
`PLATFORM_KEY_DAILY_LIMIT` for the free daily cap per user (default 20). Without a platform
key, users just need to add their own in Settings.

## 5. Deploy to Railway

1. Push to GitHub, add a Postgres database to the project if you haven't.
2. Deploy this folder as a service from the repo.
3. Env vars: `DATABASE_URL` (reference your Postgres service), `SESSION_SECRET`,
   `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`,
   `PLATFORM_OPENROUTER_API_KEY`, `PLATFORM_OPENROUTER_MODEL` (optional),
   `PLATFORM_KEY_DAILY_LIMIT` (optional), `PUBLIC_URL` (your Railway domain — **required**,
   this is what gets embedded in tracking pixel/link URLs, so it must be the real public
   URL, not localhost), `BOUNCE_CHECK_INTERVAL_MINUTES` (optional, default 15; set to 0 to
   disable the automatic sweep entirely).
4. Add the real callback URL to the Google OAuth client's redirect URIs.

No volume needed — everything (accounts, settings, collateral file, send history,
opens/clicks) lives in Postgres.

## Notes / limitations

- Sessions are in-memory — fine for one Railway instance, not for multiple replicas without
  adding a shared session store.
- No billing/paid tiers — the platform key is a flat free daily allowance, funded by
  whoever runs this.
- No email verification on signup, no "forgot password" flow yet.
- Login is rate-limited: 5 wrong passwords locks that IP for 15 minutes.
- Sending always shows a confirm step and flags prior sends to the same address, whether
  from Compose or Bulk Send.
- Collateral now supports multiple files (label each one — "One-pager," "Case study,"
  "Pricing sheet") with a default, same pattern as multi-CV in the job-application version.
  Pick a specific one per email/batch, or let the default apply.
- Links are a free-form list (label + URL pairs) rather than fixed fields — add a website,
  pricing page, case study, calendar link, whatever's relevant, and reference them with the
  `{{links}}` token in your email format (renders as one "Label: URL" line per link).
- Bounce and reply detection only work for the Gmail sending method, not custom SMTP.
- No CRM-style lead/deal status (interested, booked, closed) — Analytics tracks email
  engagement (opened/clicked/replied/bounced), not sales pipeline stage.
- No pre-send email/domain verification and no send throttling beyond a flat delay in Bulk
  Send — sequences and bulk sends don't spread across the day or randomize timing, which a
  real deliverability-conscious tool would do.
- Bulk batches are capped at 50 rows per upload.
- The AI Assistant's conversation history is kept client-side (sent back and forth with
  each request) rather than persisted server-side — refreshing the page loses the chat, and
  very long conversations grow the request payload since the whole history round-trips.
- The activity log is per-user, not a true cross-tenant admin log — there's no way for a
  platform operator to see everyone's activity in one place.
