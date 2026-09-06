# V2 Chrome Default-Profile Realtime Publishing Plan

## 1. Objective

Build a production-oriented V2 pipeline that discovers fresh, relevant X posts in realtime, generates natural Marx-related responses, and publishes them through Hermes using the authenticated Chrome `Default` profile.

The publisher account is `@nullquanty`. Comet is out of scope. The system must use the browser tools recognized by Hermes and must never treat an unverified or ambiguous browser result as a successful publication.

## 2. Fixed assumptions

- Hermes browser profile: Chrome `Default`.
- Expected visible account: `@nullquanty`.
- Source: XActions MCP read tools only; no paid X API.
- Publisher: Hermes browser execution, never a direct XActions write adapter.
- Model: `gpt-5.6-luna` with `xhigh` reasoning for all Codex/Hermes model work.
- Publication mode: automatic after deterministic policy approval; no founder approval in V2.
- Output language: English.
- Every engine-to-Hermes boundary is JSON and hash-bound.
- Unknown publication outcomes are never retried automatically.

## 3. Target architecture

```text
XActions MCP (read-only)
        |
        v
Realtime discovery + freshness + dedupe
        |
        v
Context enrichment (profile, timeline, thread, replies)
        |
        v
Codex opportunity analysis
        |
        v
Codex draft generation + independent evaluation
        |
        v
Deterministic QA + automatic policy gate
        |
        v
X_PUBLICATION_REQUEST JSON
        |
        v
Hermes CLI (browser-use tools, Chrome Default profile)
        |
        v
X UI action on @nullquanty
        |
        v
Visible read-back + X_PUBLICATION_RECEIPT JSON
        |
        v
SQLite ledger + permalink + monitoring
```

## 4. Chrome Default profile contract

Hermes must be configured explicitly, not inferred from whichever Chrome profile was last used:

```yaml
browser:
  use_real_profile: true
  real_profile_pin: "Default"
```

The preflight must prove all of the following before a publication request is dispatched:

1. The pinned `Default` profile exists.
2. Chrome launches from the supported Chromium path.
3. `x.com` is reachable.
4. The visible account is exactly `@nullquanty`.
5. The target tweet is readable.
6. The requested composer (reply, quote, or post) is available.

If any check fails, the run stops before a write action and records a typed failure.

## 5. Work phases

### Phase A — State and profile hardening

- Pin Hermes to Chrome `Default`.
- Remove dependence on Comet and on a changing Chrome `last_used` profile.
- Add a profile identity field to the V2 runtime configuration and policy hash.
- Add an account preflight command that returns only redacted account identity and readiness state.
- Keep the current Chrome profile untouched except for normal authenticated browser use.

Acceptance criteria:

- A read-only Hermes preflight repeatedly reports `@nullquanty` from `Default`.
- Selecting another Chrome profile cannot silently change the publisher identity.

### Phase B — Hermes browser transport hardening

- Invoke Hermes with the browser tool registry required by the installed Browser Use backend.
- Preload the `x-growth-publisher` skill explicitly.
- Generate a unique browser session name from each action ID.
- Close only stale Hermes-owned sessions before dispatch; never close the user’s live Chrome profile.
- Capture redacted Hermes stdout/stderr and tool-call metadata in the run artifact.
- Map failures to typed codes: `BROWSER_TOOL_UNAVAILABLE`, `PROFILE_NOT_FOUND`, `ACCOUNT_MISMATCH`, `X_ACCESS_DENIED`, `COMPOSER_NOT_FOUND`, `ACTION_TIMEOUT`, `READBACK_MISSING`, and `INVALID_RECEIPT`.

Acceptance criteria:

- A read-only browser probe completes without a stale-session hang.
- A malformed or missing receipt is diagnosable from the run artifact without exposing cookies or tokens.

### Phase C — Realtime discovery and content quality

- Keep XActions search read-only and bounded by lookback time.
- Persist source retrieval timestamps and evidence hashes.
- Deduplicate by provider ID, canonical URL, body hash, and target/body combination.
- Enrich only the highest-ranked fresh contexts.
- Generate at most one candidate per context in a batch to reduce semantic repetition.
- Keep the Marx bridge factual, source-specific, and non-promotional.
- Preserve `NO_ACTION` when no candidate satisfies all gates.

Acceptance criteria:

- A live run reports discovered posts, fresh contexts, generated candidates, and rejection reasons separately.
- No stale, duplicate, generic, or unsupported draft reaches the publisher.

### Phase D — Deterministic automatic publication

For each selected candidate, sequentially:

1. Evaluate the automatic policy.
2. Persist an `X_PUBLICATION_REQUEST`.
3. Claim the request idempotently.
4. Send the exact JSON file to Hermes.
5. Perform exactly one X UI action.
6. Verify the resulting post/reply/quote visibly.
7. Parse and validate the hash-bound `X_PUBLICATION_RECEIPT`.
8. Persist the receipt and permalink before starting the next action.

No parallel X writes are allowed. If the outcome is uncertain, the action becomes `RECONCILIATION_REQUIRED` and the batch stops or continues only according to the configured safe policy.

### Phase E — Reconciliation of historical unknowns

- Reconcile the existing `RECONCILIATION_REQUIRED` requests before creating new retries.
- Search the `@nullquanty` profile and target conversations for exact body/target matches.
- Import only evidence-backed provider IDs and permalinks.
- Mark unresolved requests as permanently blocked for retry until manually reconciled.

Acceptance criteria:

- No old unknown request can be retried by a normal automatic run.
- Every imported publication has a provider permalink and an observed timestamp.

### Phase F — Canary and production rollout

1. Run a read-only Default-profile preflight.
2. Run one automatic canary with `--max-actions 1`.
3. Require one real `PUBLISHED` receipt and visible read-back.
4. Run three consecutive canary cycles without timeout, account mismatch, or reconciliation.
5. Increase the batch cap to five actions.
6. Only then connect the Hermes cron job.

Canary command:

```bash
npm run daily -- auto \
  --config config/daily-v2.json \
  --max-actions 1
```

Production command after canary acceptance:

```bash
npm run daily -- auto \
  --config config/daily-v2.json \
  --max-actions 5
```

## 6. Failure policy

| Failure | Action |
|---|---|
| Default profile missing | Stop before model/publish; operator setup required |
| Visible account is not `@nullquanty` | Stop; never click a write control |
| X returns 403/blocked page | Stop and record `X_ACCESS_DENIED`; no blind retry |
| Browser tool unavailable | Stop before request claim |
| Composer not found | `FAILED` only if no action occurred; otherwise reconcile |
| Hermes timeout | `RECONCILIATION_REQUIRED`; never retry automatically |
| Invalid receipt | `RECONCILIATION_REQUIRED`; retain raw redacted diagnostics |
| No publishable candidate | `NO_ACTION`, not an error |
| Codex limit exhausted | Persist run checkpoint and resume only with the same run identity |

## 7. Definition of done

V2 is production-ready only when all are true:

- Chrome `Default` consistently resolves to `@nullquanty`.
- Hermes browser preflight passes without Comet or direct X API usage.
- One canary action produces a real, validated permalink.
- Three consecutive canary runs complete without an unknown outcome.
- A five-action run persists receipts for every published action.
- Reconciliation, kill switch, idempotency, and stale-session cleanup are tested.
- Run artifacts contain enough redacted diagnostics to explain any failure without exposing secrets.
- Hermes cron is the sole scheduler owner.
