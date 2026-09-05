# V2 Automatic X Publication

V2 runs the V1 discovery and intelligence pipeline and publishes eligible
`POST_DRAFT`, `REPLY_DRAFT`, and `QUOTE_DRAFT` actions without a founder review
step. The engine owns the policy gate and publication; Hermes is only the clock
that invokes the explicit `auto` command.

## Configuration

Use `config/daily-v2.json`. It is intentionally separate from the V1
manual-safe configuration:

```json
{
  "mode": "EXPERIMENTAL_LIVE_AUTO",
  "publisher": {
    "enabled": true,
    "mode": "AUTOMATIC",
    "kill_switch": false,
    "max_actions_per_run": 5
  }
}
```

The configured XActions wrapper loads session material through macOS Keychain.
Do not put cookies, `auth_token`, `ct0`, or bearer tokens in `.env`, command
arguments, JSON artifacts, or Hermes prompts.

Set `XGE_PUBLISHER_KILL_SWITCH=1` (or `true`/`yes`) for an immediate fail-closed
stop without editing the V2 config. The override never enables publishing; it
only engages the kill switch.

## Preflight and dry-run

Check the automatic configuration and required MCP tools without publishing:

```bash
npm run daily -- doctor --auto --config config/daily-v2.json
npm run daily -- auto --config config/daily-v2.json --max-actions 1 --dry-run
```

Dry-run writes the exact V2 request JSON and audit bundle, but never calls a
write tool.

## Automatic run

```bash
npm run daily -- auto --config config/daily-v2.json --max-actions 5
```

`--max-actions` can lower the configured cap but cannot raise it. The command
prints one final JSON result on stdout; progress and diagnostics are written to
stderr so Hermes can parse the result safely.

The run performs discovery, context enrichment, Codex opportunity analysis,
strategy-diverse generation, independent evaluation, deterministic QA, the
publication policy gate, write, read-back, and receipt persistence.

Replies and thread reads are optional context enrichments. A known runtime or
timeout failure on either helper is recorded as partial context and the run
continues; authentication, challenge, and rate-limit failures remain fatal.

The control search is retried within the configured transient retry budget when
XActions returns an empty control result. Persistent empty or failed control
checks still stop the run before any draft or write action.

## Policy gate

An action is publishable only when its action/body hashes, account, target,
approved facts, source freshness, evaluator scores, anti-slop QA, duplicate
history, action allowlist, and per-run cap all pass. The policy decision is
stored with a policy version and hash; it does not manufacture a founder
approval record.

## Request and receipt lifecycle

Each action produces a versioned `X_PUBLICATION_REQUEST` with an automated
policy authorization, a run-scoped grant, an idempotency key, and exact hashes.
The writer maps requests to the three allowlisted XActions tools. A generic
provider success is not treated as publication evidence.

Read-back must find exactly one matching post/reply/quote authored by
`nullquanty`. A verified result creates an `X_PUBLICATION_RECEIPT` with provider
ID and permalink. A timeout, ambiguous match, or missing match becomes
`RECONCILIATION_REQUIRED`; it is never blindly retried.

## Results and recovery

- `AUTO_PUBLISHED`: all attempted actions were verified.
- `NO_ACTION`: no content passed the gate; this is a valid result.
- `PARTIAL`: at least one action failed while other actions completed.
- `RECONCILIATION_REQUIRED`: an action outcome cannot be established.
- `FAILED`: the run failed before a usable publication result.

If a process stops after claiming a request, run recovery before another
automatic run. Claimed requests are reconciled first and are not republished
blindly.

Model checkpoints are namespaced by the compact-input version. After a payload
format change, resume safely recomputes the affected model stages instead of
accepting an incompatible checkpoint hash.

## Hermes integration

The engine does not create or edit Hermes schedules. Configure Hermes to invoke
the explicit command above from this repository. Keep one scheduler owner and
let the engine's run lock reject concurrent runs.
