# Operating runbook

## When to use this

Use this runbook for a new bounded Marx prospect-research run. It produces a
human-review queue from public X evidence. It does not qualify people for
outreach and it does not perform outreach.

For the experimental daily two-system path, use `npm run daily` on branch
`experimental-x-growth-engine`. This runbook remains the legacy comprehensive
batch contract; the daily path is documented in
[`EXPERIMENTAL_X_GROWTH_ENGINE_PLAN.md`](EXPERIMENTAL_X_GROWTH_ENGINE_PLAN.md)
and the repository README.

## Prerequisites

- macOS or a compatible shell with Node.js and Python 3.
- The repository at `/Users/0x79de/dev/x-growth-engine`.
- A compatible deterministic scorer; the current local reference bundle is at
  `/Users/0x79de/Documents/Codex/2026-09-02/bun`.
- XActions MCP connected in the Codex app, with public read tools available:
  `mcp__xactions__x_search_tweets`, `mcp__xactions__x_get_profile`, and
  `mcp__xactions__x_get_tweets`.

Do not ask for, copy, print, or store `auth_token`, `ct0`, cookies, bearer
tokens, or browser storage. Do not call `x_login`.

## 1. Inspect the policy and initialize a run

```bash
cd /Users/0x79de/dev/x-growth-engine
sed -n '1,240p' config/research-policy.json
sed -n '1,260p' config/query-buckets.json
node scripts/run-comprehensive.mjs --new-run
```

Record the printed `run_dir`. Never use an existing run directory for a new
collection. The manifest freezes the query plan, lookback date, caps, and run
ID for that run.

## 2. Run the control check

Before research, call the MCP search tool with a harmless known-control query:

```json
{
  "platform": "twitter",
  "query": "the lang:en since:2026-06-04 -airdrop -giveaway",
  "limit": 1
}
```

Send the result as a `control` batch. If it is empty, the runner stops with
`CONTROL_CHECK_EMPTY`; do not submit research batches or switch sources
silently.

## 3. Search sequentially

For each pending query in `run-manifest.json`, call
`mcp__xactions__x_search_tweets` sequentially with:

- `platform: "twitter"`
- the manifest’s complete `query` string
- `limit: 10`

Send one `search` batch immediately after each MCP response. The runner writes
`search-results.jsonl` append-only and atomically updates the manifest. Keep
the configured 3-second delay between calls when the MCP service returns
quickly; a slow MCP response already provides the delay.

Search ingest is rejected until the control check passes. Records whose X URL,
handle, numeric status ID, or timestamp violates the frozen evidence contract
are rejected and counted in `counts.rejected_records`. A query containing both
accepted and rejected results is `completed_with_rejections`.

Do not add broad negative phrases. The configured exclusions are only
`-airdrop -giveaway`; spam and signal-seller penalties belong to the scorer.

## 4. Enrich ranked authors

Rank unique authors by matching-tweet engagement, then enrich no more than the
configured cap. For each selected author, call both public read tools:

1. `mcp__xactions__x_get_profile` with `platform: "twitter"` and the username.
2. `mcp__xactions__x_get_tweets` with `platform: "twitter"`, the username, and `limit: 20`.

Send the pair as one `enrichment` batch. Store only public username, name, bio,
website, public follower/following counts, tweet text, URL, timestamp, and
public engagement counts.

Do not begin enrichment until every frozen search query has reached a terminal
state. Use the deterministic engagement ranking (likes plus reposts, then
username); each batch's `author_index` and username must match that ranking.

## 5. Resume after interruption

Rerun the same ingest command or continue sending batches to the same
`run_dir`. The runner uses tweet IDs/URLs and case-insensitive usernames to
avoid duplicate JSONL records. Do not initialize a second run to resume the
first one.

All mutations hold `outputs/runs/<run-id>/.run.lock`. A `run_locked` error means
another writer may be active. Inspect `.run.lock/owner.json`; remove a stale
lock only after confirming that its PID is no longer running. Finalized runs are
immutable.

For an MCP error, send an `error` batch with the sanitized error class. Retry a
transient runtime/browser failure at most twice. Do not retry authentication,
rate-limit, challenge, policy, or write/action errors.

## 6. Finalize and score

When the query cap is reached, the source is exhausted, or a hard stop is
recorded, finalize:

```bash
node scripts/run-comprehensive.mjs --finalize \
  --run-dir outputs/runs/<run-id> \
  --scorer /absolute/path/to/run_pipeline.py
```

The finalizer also writes the report and standalone SVG. A result below 100
rows is valid when the configured query/source cap is exhausted; never pad the
CSV.

Scorer selection order is `--scorer`, `XGE_SCORER_PATH`, optional policy
`scorer_path`, then the compatibility fallback. Missing scorers and incomplete
non-stopped search plans block finalization. A stopped run may be finalized to
preserve its explicit failure state.

## 7. Release QA

Run the controller checks:

```bash
cd /Users/0x79de/dev/x-growth-engine
npm run check
npm test
```

Run the scorer-bundle tests from their own directory:

```bash
cd /Users/0x79de/Documents/Codex/2026-09-02/bun
python3 -m unittest discover -s tests -p 'test_pipeline.py'
```

Then verify JSON parsing, rectangular CSV headers, duplicate usernames/URLs,
evidence URLs and timestamps, all caps, an empty action ledger, no secrets, and
SVG validity. The exact checklist is in [`output-schema.md`](output-schema.md).

## Stop and report

Stop immediately when any of these appears:

- `AUTH_REQUIRED`, login wall, rate-limit, challenge, or suspicious-activity interstitial;
- three repeated runtime failures;
- a raw-tweet or unique-author cap breach;
- any attempted follow, unfollow, like, repost, post, reply, DM, bookmark, profile edit, schedule, or delete action.

The report must state the run status, stop reason, completed counts, remaining
uncertainty, and exact next owner/access decision. A successful local export
does not prove production provider health or external deployment.
