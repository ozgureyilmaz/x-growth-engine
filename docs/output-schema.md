# Output schema and QA

Every new run lives under `outputs/runs/<run-id>`. Existing outputs in
`outputs/` are historical and must not be overwritten.

## Files

| File | Purpose |
|---|---|
| `run-manifest.json` | Frozen plan, status, retry/scoring limits, rejection counts, stop reason, and action ledger. |
| `search-results.jsonl` | Append-only normalized public search tweets. |
| `profiles.jsonl` | Append-only normalized public profiles. |
| `recent-tweets.jsonl` | Append-only normalized public enrichment tweets. |
| `mcp-comprehensive-x-export.json` | Scorer-compatible JSON export. |
| `comprehensive-candidates.csv` | Deterministic human-review queue at score ≥50. |
| `research-pipeline.svg` | Actual run flow, counts, limits, and fail-closed branches. |
| `run-report.md` | Human-readable status, metric contract, safety notes, and QA summary. |

## JSON export

The export must retain this compatibility shape:

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

`run_status` may be `OK`, `NO_ACTION`, or `STOPPED`. `actions_performed` must
remain exactly empty for this public-read workflow.

## CSV contract

The scorer currently writes these stable headers in this order:

```text
username,name,bio,category,score,matching_tweet,tweet_url,followers,website,reason,last_tweet_at
```

Each CSV row is a review candidate, not a qualified prospect. A human must
verify identity-to-account match, dated evidence within the lookback window,
direct Marx relevance, and public provenance before outreach.

## Evidence QA

For every promoted row:

- `username` is unique case-insensitively;
- `tweet_url` is unique and maps to a stored public search result;
- the matching raw result has non-empty text and timestamp;
- the raw result URL is an `x.com/<handle>/status/<id>` public URL;
- the row’s score is at least the requested `--min-score`;
- no row is labeled human-qualified by the pipeline.

Finalization revalidates stored search and recent-tweet evidence. Malformed,
non-X, handle-mismatched, ID-mismatched, future, or out-of-window records block
finalization instead of reaching the scorer.

## Cap QA

Check these limits against `config/research-policy.json` and the manifest:

- at most 12 buckets and 10 unique variants per bucket;
- at most 120 search calls and 10 result slots per call;
- at most 1,200 stored raw tweets;
- at most 500 unique authors;
- at most 200 enriched authors and 20 recent tweets per enriched author.

Counts are ceilings, not targets. Empty or duplicate results may produce fewer
records.

## Resume QA

Copy a run to a temporary directory, ingest a duplicate search/enrichment batch,
and confirm that JSONL line counts and completion counters do not increase. Do
not use the temporary copy as a production output. `npm test` automates this QA.

## SVG QA

Validate the standalone SVG and inspect a rendered preview when a renderer is
available:

```bash
xmllint --noout outputs/runs/<run-id>/research-pipeline.svg
file outputs/runs/<run-id>/research-pipeline.svg
```

The visual must show actual counts and these stages:

`query buckets → MCP search → raw tweets → author dedupe → profile/timeline enrichment → deterministic scoring → human review CSV`

It must also show auth/rate-limit/challenge stop, cap checkpoint/finalize, and
write/action immediate-stop branches. Labels must not clip or overlap, and the
note must state that scores are heuristics and outreach is human-approved.

## Secret and action QA

Search the run directory for credential patterns such as `auth_token`, `ct0`,
cookies, bearer tokens, passwords, and API keys. Confirm no matches. Confirm
both the export and manifest contain `actions_performed: []`.
