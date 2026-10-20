# Autonomous Instagram prospecting system

Local, single-machine system that prospects on Instagram on its own — discover → qualify → first DM through the operator's real Chrome → hand off to the official Meta API on reply → AI-driven conversation → WhatsApp / affiliate group → measure → learn → adapt — inside limits set in `.env` and the panel.

Business data lives only in `config/business.json` and secrets only in `.env`. The operator manual (PT-BR) is [`SETUP.md`](SETUP.md).

```bash
pnpm install
cp .env.example .env && cp config/business.example.json config/business.json   # fill both
pnpm dev                     # panel (Next.js) + worker, one command
pnpm check                   # lint + typecheck + tests + production build
pnpm build && pnpm e2e       # full end-to-end run against local stand-ins
```

## Architecture

Modular monolith. One repo, one SQLite file, two processes started together: the Next.js panel (also receives the Meta webhook) and the worker (durable jobs).

```
config/business.json         business identity, offer, ICP, claims (gitignored)
drizzle/                     versioned SQL migrations
src/app                      PT-BR panel: Server Components, Server Actions, webhook route
src/db                       schema, connection (WAL, FK, busy timeout), backup/restore
src/features/leads           dedupe, pipeline state machine, qualification, do-not-contact
src/features/conversations   channel lock, outbound reservations, inbound handoff, AI engine, claims guard
src/features/campaigns       account-health pacing, warm-up, metrics
src/features/experiments     deterministic assignment, z-test evaluation, gradual ramp, optimizer
src/features/affiliates      creator qualification
src/features/safety          audit trail, alerts, exceptions, settings, circuit breaker, budget
src/integrations/browser     Playwright over CDP, Instagram UI actions, encrypted failure artifacts
src/integrations/instagram   webhook signature/parsing, Send API, username lookup
src/integrations/openai      the single OpenAI entry point (budget check + cost accounting)
src/integrations/whatsapp    hand-off links
src/worker                   job queue, handlers, scheduler loop
src/test                     test helpers, real-Chromium launcher, Instagram mock
scripts/e2e.ts               multi-process end-to-end run
```

### Channels and the ownership lock

| Stage | Channel | Why |
|---|---|---|
| First contact, follow-ups without reply | Operator's Chrome via CDP | The Meta API cannot open a conversation |
| After the lead replies | Official API + webhook | Supported, auditable path |

`conversations.channel_state` / `channel_owner` form a compare-and-swap lock (`transitionChannel`, versioned). The browser may write only in `browser_contact_pending` / `waiting_inbound_reply`; the API only in `api_eligible` / `api_active` with an open 24 h window. An inbound message moves ownership to the API atomically. An echo the CRM does not know (operator typed by hand) moves the thread to `human_review_required`. API failures never fall back to the browser — they go to the exception queue.

Pipeline (`leads.pipeline_status`, forward-only, audited) and channel state are separate fields.

### Duplicate-send protection

Every outbound message is **reserved** in `messages` under a unique `dedupe_key` (`opening:<lead>`, `followup:<lead>:<n>`, `reply:<inbound message>`) before the browser or API is touched:

- `failed`/`blocked` → certainly not delivered, retry reuses the row;
- `pending` found on retry → the previous attempt may have been delivered → refuse, trip the breaker, open a `delivery_unknown` exception for the operator to reconcile;
- `sent` → refuse.

The browser distinguishes failures before pressing Enter (`delivered: "no"`) from failures after (`"unknown"`).

### Worker

`jobs` table, no Redis. Leased claims (`lease_until`), idempotency keys, exponential backoff, dead-letter with alert, and recovery of expired leases on every tick (restart-safe). Two lanes: one browser job at a time (also guarded by a DB mutex) and a general lane. Periodic jobs are enqueued with time-bucket idempotency keys. Waiting conditions (pacing, pause, window, `BROWSER_SEND_ENABLED=false`) reschedule without consuming attempts.

### AI

`callStructured` is the only OpenAI path: checks `OPENAI_MONTHLY_BUDGET_USD` first (pauses the system at the ceiling), uses strict JSON-schema structured outputs, and writes one `ai_calls` row with tokens and estimated cost per call. `OPENAI_MODEL` drafts and decides; `OPENAI_MODEL_FAST` classifies intent and reviews claims. Every draft passes a deterministic claims guard (unverified claims, invented figures, guarantees/superlatives, impersonation, unknown links) plus a model review; blocked drafts are re-drafted once, then escalated. Explicit opt-out keywords are handled before the model and are permanent (`do_not_contact`).

### Learning loop

- Experiments: one variable per funnel at a time, deterministic hashed assignment stored per lead, fixed exploration slice, control group, minimum sample per variant, two-proportion z-test (p < 0.05); the winner's weight ramps in steps and the experiment concludes at 80 % share. A concluded opening experiment spawns a new one with an AI-proposed challenger.
- Niche insights: reply rate by niche and by local send hour adjust priority (bounded ±15) and preferred send hour.
- Every automated change is a row in `strategy_changes` and can be reverted from the panel.

### Safety

Env validation (zod), business config validation (rejects leftover placeholders), webhook HMAC verification (constant time), structured JSON logs with secret redaction, encrypted browser failure artifacts (AES-256-GCM), audit trail in `events`, circuit breaker (restriction, lost session, browser error rate, duplicate suspicion, opt-out/block spike, channel divergence, repeated claim blocks, budget), global pause, hard limits the optimizer and operator cannot exceed. No fingerprint spoofing, automation masking, private APIs or restriction workarounds — human pacing exists for account health.

## Tests

`pnpm test` runs Vitest. Browser tests launch a **real headless Chromium** with remote debugging and connect over CDP exactly like production, with Instagram pages served by request interception (`src/test/mock-instagram.ts`). Covered: lead dedupe, pipeline and channel transitions, first contact through the browser, browser → webhook → API handoff, duplicate-send lock, webhook signature and idempotency, follow-ups, experiment assignment and evaluation, restart recovery (leases and interrupted sends), 24 h window expiry, do-not-contact, circuit breaker, budget cutoff, backup/restore, claims guard.

`pnpm e2e` (after `pnpm build`) starts `next start` and the worker as separate processes with local HTTP stand-ins for Instagram web, the Graph API and the OpenAI Responses API, then drives the panel with Playwright: import → enrich → qualify → first DM → worker crash → signed webhook (twice) → worker restart → single API reply with WhatsApp hand-off → every panel page in PT-BR → global pause. Screenshots land in `artifacts/e2e/`.

Browser levels on the operator's machine: `pnpm browser:dry-run <handle>` (types and erases, never sends) and `pnpm browser:smoke <handle> "<msg>" --confirm` (one real DM after typed confirmation).

## Running in a sandbox

Cloud/CI containers cannot reach the operator's Chrome. Everything except the real dry-run and smoke test runs there; those two are documented in `SETUP.md` for the operator's machine.

## Database

SQLite (WAL, foreign keys, busy timeout, UTC timestamps in ms), migrations generated by drizzle-kit (`pnpm db:generate`) and applied on connect. Daily online backups (14 kept); `pnpm db:restore` verifies integrity before replacing the file. Migrate to PostgreSQL only for multiple machines, remote deploy or real write concurrency.
