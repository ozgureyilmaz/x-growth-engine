# Experimental X Growth Engine Plan

Plan status: implementation in progress on branch `experimental-x-growth-engine`; V1 publication remains manual.

## Objective

Turn this repository into two bounded systems: a daily XActions MCP discovery
system and an engagement-intelligence system that produces English,
Marx-oriented drafts for founder review. The repository must remain local-first,
free of paid X APIs and paid model APIs, and safe to rerun.

## Fixed boundaries

- XActions is an explicitly unofficial experimental read source. Only the
  allowlisted read tools `x_search_tweets`, `x_get_profile`, `x_get_tweets`,
  `x_get_thread`, and `x_get_replies` are callable by the source adapter.
- V1 automates read, ranking, context analysis, candidate generation,
  independent evaluation, deterministic QA, and founder-review export. It never
  publishes, likes, reposts, follows, bookmarks, DMs, or edits an X account.
- V2 publication is a dormant, hash-bound request/receipt contract. It remains
  disabled until a separate platform-permission and risk decision; no non-API
  write adapter is enabled by this branch.
- All cross-system messages are versioned JSON. SQLite is the durable source of
  truth; JSONL logs and review bundles are derived/audit artifacts.
- All model work uses the authenticated Codex Plus session through
  `codex exec`, model `gpt-5.6-luna`, reasoning effort `xhigh`, read-only
  sandbox, ephemeral sessions, bounded retries, and no paid API fallback.
- Approved product claims are read only from `config/marx-facts.json`; raw
  content retention is bounded to 30 days and hashed identifiers survive purge.

## Daily V1 flow

```text
preflight + kill switch
  -> rotating 12-bucket XActions read discovery (48h overlap)
  -> normalize, evidence-hash, deduplicate, enrich top accounts/threads
  -> deterministic relevance and opportunity prefilter
  -> Codex context/opportunity batch
  -> Codex strategy-diverse draft batch
  -> independent Codex evaluation batch
  -> deterministic anti-slop, duplicate, policy, and evidence QA
  -> READY_FOR_FOUNDER_REVIEW or NO_ACTION
  -> founder-review JSON/Markdown bundle
```

## Initial caps

- 12 rotated search calls per daily run, up to 10 results each.
- 120 raw posts, 10 account enrichments, 20 timeline posts per account.
- 10 full contexts, 5 generated opportunities, 3 candidates per opportunity,
  and 5 final review drafts maximum. Zero is valid.
- 3 logical Codex stages, 2 attempts per stage, 8 absolute calls per run,
  sequential execution, 120-second task timeout, 60-second source-call timeout,
  and 30-minute total run timeout.

## Content contract

Supported V1 actions are `POST_DRAFT`, `REPLY_DRAFT`, `QUOTE_DRAFT`, and
`NO_ACTION`. Selected drafts are English, at most 280 characters, tied to a
source anchor, contain one useful new idea, use at most one natural `Marx`
mention, contain no default link/CTA/hashtag, and make no unsupported
performance, profitability, safety, or investment claim. Exact, near,
shared-phrase, repeated-hook, generic-praise, feature-dump, hype, and
standalone-marketing drafts are rejected.

## Durable contracts

Every record carries `schema_version`, `message_type`, `event_id`, `run_id`,
`created_at`, `idempotency_key`, and payload hashes. Action drafts additionally
carry source IDs, context hash, target, action type, body hash, action hash,
strategy/prompt/model provenance, evaluation scores, QA results, and account
identity. Founder decisions bind to the exact action hash.

V2-only request states are `PENDING`, `CLAIMED`, `PUBLISHED`, `FAILED`,
`RETRYABLE`, and `RECONCILIATION_REQUIRED`; unknown provider outcomes are never
blindly retried.

## Verification and rollout

V1 is operated manually on the Mac with `npm run daily -- doctor --live-read`,
`npm run daily -- recover --run-id <id>`, `npm run daily -- replay
--run-id <id> --max-drafts 0|1`, and `npm run daily -- run --mode
EXPERIMENTAL_LIVE_READ --max-drafts 5`. The first live-read pilot must keep
publishing disabled and inspect the JSON review bundle. A future Hermes no-agent
cron may own the daily clock only after local replay, lock, failure-injection,
and founder-review import tests pass. Hermes must not rewrite or invent action
bodies.

Primary metric: founder publishability approval rate = founder-approved drafts / reviewed drafts; source of truth: exact-hash founder-review import; cohort/window: one daily run and its weekly aggregate; evidence status: proposed.

Guardrail: any X write/action; definition/unit: count of publish, reply, quote, like, repost, follow, bookmark, DM, edit, or schedule calls; source of truth: tool allowlist and audit log; cohort/window: every run; evidence status: proposed; trigger/action/responder: any value above zero -> stop/quarantine; responder: unassigned — growth operations owner.
