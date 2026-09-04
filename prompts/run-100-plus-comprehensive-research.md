# Run prompt: 100+ Marx prospects with MCP, checkpoints, and SVG QA

You are operating the Marx X Growth Engine project at:

`/Users/0x79de/dev/x-growth-engine`

The goal is a comprehensive but bounded, evidence-based research run that
produces more than 100 potential Marx prospects for human review. A result
below 100 is acceptable if the configured source and caps are exhausted; never
invent or pad candidates to reach the target.

## First inspect the project

Read:

- `README.md`
- `config/research-policy.json`
- `config/query-buckets.json`
- `scripts/run-comprehensive.mjs`

Preserve all existing files and prior outputs. Do not delete or overwrite a
previous run. Use a new timestamped run directory under `outputs/runs/`.

## Collection source and tool contract

Use the XActions MCP tools as the primary source:

- `mcp__xactions__x_search_tweets`
- `mcp__xactions__x_get_profile`
- `mcp__xactions__x_get_tweets`

Use only public read operations. Do not call or perform:

- follow, unfollow, like, repost, post, reply, DM, bookmark, delete, profile edit
- scheduling, auto-engagement, persona runs, or network expansion

Do not call `x_login`. Do not ask for or print `auth_token`, `ct0`, cookies, or
environment variables containing secrets.

If MCP search is unavailable, returns `AUTH_REQUIRED`, returns a rate-limit or
challenge, or returns zero for both a known control query and the first
research query, stop early with an explicit status. Do not silently switch to
another data source. The existing Comet collector may be used only as an
explicitly labelled fallback after MCP failure; do not mix sources in one run
without recording the source per row.

## Expand the query universe before running

Extend `config/query-buckets.json` to at least 12 distinct intent buckets with
up to 10 non-duplicate query variants per bucket. Keep the target audience
narrowly relevant to Marx:

1. direct AI trading agents
2. autonomous and agentic trading
3. AI crypto trading
4. AI stock and portfolio trading
5. quant and algorithmic trading
6. backtesting and strategy automation
7. execution, risk, and portfolio agents
8. founders and builders shipping finance agents
9. developers using LLMs for trading
10. explicit product/user/buyer intent
11. trading infrastructure and agent frameworks
12. pain points, failed experiments, and replacement intent

Deduplicate normalized queries before collection. Use conservative query-level
exclusions only: `-airdrop -giveaway`. Apply signal-seller, bot, shill, and
spam penalties during local qualification instead of adding many quoted
negative phrases that can erase valid results.

Every final query must include:

- `lang:en`
- `since:<date 90 days before the run date>`
- `-airdrop -giveaway`

## Run limits

Use these proposed ceilings unless a project configuration explicitly overrides
them:

- maximum 12 buckets
- maximum 10 variants per bucket
- maximum 120 MCP search calls
- maximum 10 results per search call
- maximum 1,200 raw tweets
- maximum 500 unique authors
- maximum 200 enriched authors
- maximum 20 recent tweets per enriched author
- sequential calls only; no parallel burst
- proposed delay: 3–6 seconds between calls, confirm against observed tool/server behavior

The objective is 100+ reviewable potential prospects, not 100+ unverified
handles. A row can enter the review CSV only if it has a username, public tweet
URL, tweet text, timestamp, and a matching public-evidence signal.

## Reliability and checkpoint rules

Implement or use a resumable run manifest with:

- run ID and start time
- normalized query list and bucket for every query
- query status: pending, running, completed, empty, retryable, failed, stopped
- attempt count and sanitized error class
- raw result count per query
- deduplicated author count
- enrichment status per author
- last completed query index
- source name and action ledger

After every query and every enrichment batch:

1. persist a checkpoint atomically to a temporary file and rename it
2. append raw records to JSONL or another resumable store
3. never rewrite a whole large JSON file on every request
4. flush a compact progress line with counts, never secrets

Retry at most twice for transient network/browser errors with bounded backoff.
Do not retry authentication errors, rate limits, challenges, or policy errors;
stop and report them. Stop after three repeated runtime failures or any write
action attempt.

## Enrichment and qualification

Deduplicate authors case-insensitively and rank them using matching evidence and
engagement. Enrich at most 200 authors with:

- `mcp__xactions__x_get_profile`
- `mcp__xactions__x_get_tweets` with `limit: 20`

Keep public fields only: username, name, bio, website, public follower/following
counts, tweet text, URL, timestamp, and public engagement counts.

Classify each author as one primary category:

- Builder/developer
- Founder/owner
- Trader/quant
- Potential end user
- Infrastructure/framework
- Influencer/content creator
- Review
- Spam/noise

Use the existing deterministic scorer. Keep `score >=70` as a high-intent
heuristic and `score >=50` as a review threshold. Do not label a row
“qualified” until a human verifies person identity, dated evidence, direct
Marx relevance, and public provenance.

## Output files

Create a new timestamped directory under:

`/Users/0x79de/dev/x-growth-engine/outputs/runs/`

It must contain:

- `run-manifest.json`
- `search-results.jsonl`
- `profiles.jsonl`
- `recent-tweets.jsonl`
- `mcp-comprehensive-x-export.json`
- `comprehensive-candidates.csv`
- `research-pipeline.svg`
- `run-report.md`

The JSON export must remain compatible with the existing scorer:

```json
{
  "run_status": "OK",
  "run_started_at": "<ISO timestamp>",
  "lookback_since": "<YYYY-MM-DD>",
  "search_results": [],
  "profiles": [],
  "recent_tweets": {},
  "network_users": [],
  "actions_performed": []
}
```

The action ledger must be exactly empty for this run. Do not include any
credential, cookie, private contact field, or raw browser storage in any output.

## SVG requirement

Generate a standalone valid SVG at `research-pipeline.svg` showing the actual
run flow and actual counts, not placeholder numbers:

`query buckets → MCP search → raw tweets → author dedupe → profile/timeline enrichment → deterministic scoring → human review CSV`

Also show the fail-closed branches:

- auth/rate-limit/challenge → stop and report
- cap reached → checkpoint and finalize
- write/action detected → stop immediately

The SVG must include:

- a valid XML declaration or valid standalone SVG root
- `viewBox`
- readable labels with no clipping or overlap
- source, limits, and actual run counts
- a visible note that scores are heuristics and outreach is human-approved

Prefer deterministic handwritten SVG or Mermaid CLI if available. If Mermaid
CLI is used, render and inspect the SVG. Validate with:

```bash
xmllint --noout <svg-path>
file <svg-path>
```

If a renderer is available, render a PNG preview and inspect it for clipped
labels, missing nodes, overlap, or an unreadable legend. Fix issues before the
final report.

## Final QA

Run:

```bash
python3 /Users/0x79de/Documents/Codex/2026-09-02/bun/run_pipeline.py \
  --input <run-dir>/mcp-comprehensive-x-export.json \
  --output <run-dir>/comprehensive-candidates.csv \
  --min-score 50
```

Verify:

- JSON parses
- CSV is rectangular with stable headers
- no duplicate usernames
- no duplicate tweet URLs
- every promoted row has public evidence URL and timestamp
- raw tweet, author, and enrichment caps were not exceeded
- checkpoint can resume without duplicating records
- SVG is valid and visually legible
- action ledger is empty
- no token or cookie appears in outputs or logs

Final report must state:

- `OK`, `NO_ACTION`, `PARTIAL`, or `STOPPED`
- exact counts and caps
- number of review rows
- number of heuristic high-intent rows
- top candidates with evidence URLs and one-sentence reasons
- all errors and retry counts
- whether 100+ potential review rows were reached
- that no X write/action or outreach occurred
- the next decision: review, iterate, stop, or separately approve network expansion

Do not claim causal growth impact. Do not claim that 100+ rows were achieved
unless the final validated CSV contains at least 100 rows.
