# Marx X Prospect Research

Separate, bounded workspace for comprehensive—but reviewable—public X research
for Marx potential customers. The target universe is AI-trading/finance-agent
builders, founders, owners, quant/developer users, and explicit product users.

## Current status

Implementation status: locally hardened and test-covered. Live provider health,
credentials, deployment, and an unattended production pilot are not verified.

The collector contract is XActions MCP public read tools. The local runner
does not hold credentials or invoke MCP itself; it initializes a timestamped
run, accepts one MCP response batch at a time, atomically checkpoints the
manifest, appends JSONL records, and finalizes the scorer-compatible export.
The previous Comet-based outputs remain preserved under `outputs/`.

The runner enforces a passed control check, strict public-X evidence validation,
idempotent batch replay, a per-run mutation lock, policy-frozen retry limits,
and complete-search finalization. These guarantees apply to the local batch
controller; they do not turn it into a general web scraper or prove that the
external MCP provider is production-ready.

## Proposed comprehensive-run boundary

- Source: `mcp__xactions__x_search_tweets`, `mcp__xactions__x_get_profile`, and
  `mcp__xactions__x_get_tweets`, public read operations only.
- Window: last 90 days, dynamically calculated at run time.
- Query universe: 12 intent buckets × up to 10 query variants = at most 120
  normalized, deduplicated MCP search calls. Query-level exclusions are
  intentionally conservative: only `-airdrop -giveaway`; the scorer handles
  the remaining spam signals.
- Discovery cap: at most 10 tweets per query and 1,200 raw tweets total.
- Author cap: at most 500 unique authors; enrich at most 200, ranked by
  matching tweet engagement.
- Enrichment: one public profile and up to 20 recent public tweets per selected
  author.
- Network expansion: disabled for the first comprehensive run. Followers and
  following require a separate approval and a new cap.
- Actions: follows, likes, reposts, posts, replies, DMs, bookmarks, profile
  edits, and scheduling are disabled.
- Data: no private contact inference, no password/cookie in exports, and no
  automatic outreach. The output is a human review queue.

Hard stops are defined in `config/research-policy.json`: login/auth wall,
rate-limit or challenge interstitial, cap exceedance, repeated browser failure,
or any attempted write/action.

## Quick start

The project is designed to run from the Codex app with the XActions MCP
connector available. The Node runner stores and validates MCP responses; it
does not log in to X and does not call XActions by itself.

From this directory, initialize a new run. Always use a new run directory:

```bash
cd /Users/0x79de/dev/x-growth-engine
node scripts/run-comprehensive.mjs --new-run
```

The command prints the new `run_dir`, for example
`outputs/runs/20260902T114600Z`. For each query, call the public MCP tool
`mcp__xactions__x_search_tweets` with `platform: "twitter"`, `limit: 10`, and
the exact query from the manifest. Send its parsed array as one NDJSON batch to
the runner. The same pattern applies to `mcp__xactions__x_get_profile` and
`mcp__xactions__x_get_tweets` for ranked authors. See
[`docs/mcp-batch-contract.md`](docs/mcp-batch-contract.md) for copy-pasteable
batch shapes and resume behavior.

After collection and enrichment, finalize the run:

```bash
node scripts/run-comprehensive.mjs --finalize \
  --run-dir outputs/runs/<run-id> \
  --scorer /absolute/path/to/run_pipeline.py
```

The scorer may be selected with `--scorer /absolute/path/to/run_pipeline.py` or
`XGE_SCORER_PATH`. CLI takes precedence over the environment and optional
`scorer_path` policy value. The historical local path is a compatibility
fallback only.

The run must report `OK`, `NO_ACTION`, or `STOPPED`; an empty result is not a
qualified-lead result. The finalizer applies the existing deterministic scorer.
Scores are heuristics and never replace evidence review.

For the full operating procedure, read
[`docs/runbook.md`](docs/runbook.md). For output fields and QA checks, read
[`docs/output-schema.md`](docs/output-schema.md).

## Repository map

- `config/research-policy.json` — caps, lookback, exclusions, hard stops, and review thresholds.
- `config/query-buckets.json` — the 12 intent buckets and query variants.
- `scripts/run-comprehensive.mjs` — run initialization, atomic manifest checkpoints, JSONL ingest, final export, report, and SVG generation.
- `outputs/runs/<run-id>/` — immutable-by-convention run artifacts; never reuse a previous directory.
- `docs/` — operating and data-contract documentation.

## Evidence and decision contract

Primary evidence question: does a bounded public-X pass produce enough
identity-matched, dated AI-trading/finance-agent evidence to justify a second
research pass or approved network expansion?

Primary metric: high-intent review rate = rows with score ≥70 / scored rows;
source of truth: `outputs/comprehensive-candidates.csv`; cohort/window: one
run using the configured 90-day window; evidence status: proposed.

Guardrail: unintended X write; definition/unit: count of follow, like, repost,
post, reply, DM, bookmark, profile-edit, or schedule actions; source of truth:
collector action ledger and MCP/tool logs; cohort/window: every run; evidence
status: proposed; trigger/action/responder: any value >0 stops the run and
requires credential review / unassigned — system owner.

Guardrail: source-quality failure; definition/unit: auth wall, challenge,
rate-limit, or repeated empty pages before the configured cap; source of truth:
collector run output; cohort/window: one run; evidence status: proposed;
trigger/action/responder: stop and inspect the source/query contract /
unassigned — research owner.

## Contributing and maintenance

Keep query variants unique and narrow. If you change a field or cap, update the
policy, the batch contract, the output schema, and the QA procedure together.
Run `npm run check`, `npm test`, the exact scorer command, and the test suite
from the scorer bundle’s own directory before sharing a run.
