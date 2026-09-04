# MCP batch contract

The local runner is deliberately transport-agnostic. The Codex app calls the
XActions MCP tools; the runner receives sanitized, public result batches. Input
is newline-delimited JSON (NDJSON) when using `--ingest`.

## Control batch

```json
{
  "type": "control",
  "query": "the lang:en since:2026-06-04 -airdrop -giveaway",
  "result": [{"id": "public-id-only"}]
}
```

The control batch is recorded in `run-manifest.json` and is not added to the
research dataset. Search and enrichment are rejected until it passes. An empty
control result stops the run with `CONTROL_CHECK_EMPTY`.

## Search batch

```json
{
  "type": "search",
  "query_index": 0,
  "attempt": 1,
  "result": [
    {
      "id": "2095107468556669391",
      "author": "public_handle",
      "text": "public tweet text",
      "timestamp": "2026-09-02T11:12:00.000Z",
      "likes": "6",
      "retweets": "0",
      "replies": "0",
      "url": "https://x.com/public_handle/status/2095107468556669391",
      "platform": "twitter"
    }
  ]
}
```

The query index must refer to the manifest’s frozen query plan. The runner
adds `source: "xactions_mcp"`, the query, bucket, and platform to accepted
records. Records without username, text, timestamp, or public URL are not
promoted into the search JSONL.

Accepted records must use a canonical public
`https://x.com/<handle>/status/<numeric-id>` URL. The URL handle must match the
normalized username, the URL ID must match a supplied record ID, and the
timestamp must be inside the frozen lookback window and not in the future.
Rejected records increment `counts.rejected_records`.

## Enrichment batch

```json
{
  "type": "enrichment",
  "author_index": 0,
  "attempt": 1,
  "username": "public_handle",
  "profile": {
    "username": "public_handle",
    "name": "Public Name",
    "bio": "Public bio",
    "website": "https://example.com",
    "followers": 1234,
    "following": 321
  },
  "tweets": [
    {
      "id": "2095000000000000000",
      "username": "public_handle",
      "text": "recent public tweet",
      "timeParsed": "2026-09-02T09:00:00.000Z",
      "likes": 4,
      "retweets": 1,
      "replies": 0,
      "permanentUrl": "https://x.com/public_handle/status/2095000000000000000"
    }
  ]
}
```

The runner accepts at most the configured 20 recent tweets per author. The
`timeParsed` and `permanentUrl` fields are normalized to `timestamp` and `url`.
No avatar, location, joined date, user ID, private contact, or browser storage
is needed for the scoring export.

Enrichment begins only after the search plan is complete. `author_index` and
`username` must match the deterministic engagement-ranked search author list.

## Error batch

```json
{
  "type": "error",
  "scope": "search",
  "index": 12,
  "attempt": 1,
  "message": "sanitized transient runtime error"
}
```

The runner stores only a sanitized error class: `AUTH_REQUIRED`, `RATE_LIMIT`,
`CHALLENGE`, `WRITE_ACTION_DETECTED`, or `TRANSIENT_RUNTIME`. Authentication,
rate-limit, challenge, policy, and write/action classes stop the run. A
transient class is retryable only within the two-attempt policy.

## Ingest commands

For a stream of NDJSON batches:

```bash
node scripts/run-comprehensive.mjs --ingest \
  --run-dir outputs/runs/<run-id> < batches.ndjson
```

For an individual batch, use the runner’s encoded argument mode. The encoded
value must be URI-encoded JSON; this prevents tweet text and Unicode from being
interpreted by the shell:

```text
--ingest-batch-encoded <encodeURIComponent(JSON batch)>
```

The mode writes the checkpoint synchronously before returning. Completed search
and enrichment batches are replay-safe: records and completion counters do not
change. A per-run `.run.lock` serializes ingest and finalization.
