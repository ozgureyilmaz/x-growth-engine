# V1 features

V1 discovers relevant public X conversations and prepares English drafts for
human review on behalf of `nullquanty`. Start with [Usage](v1-usage.md); consult
[Capabilities and limits](v1-capabilities.md) for what has and has not been
verified. This describes the current experimental branch, not a future roadmap.

## Discovery

- Local XActions MCP integration with a five-tool read allowlist: search,
  profile, timeline, thread, and replies.
- Twelve configured query buckets covering AI trading, financial agents,
  builders, infrastructure, buyers, and concrete workflow problems.
- Deterministic daily query rotation: one variant per selected bucket, chosen
  from the UTC date. Search includes English language and a date cutoff.
- A default 48-hour search overlap with canonical post IDs, URLs, normalized
  usernames, timestamps, and evidence hashes.
- Relevance scoring before expensive model work; account/timeline/context
  collection is limited to shortlisted posts.
- `--max-drafts 0` collects evidence without enrichment or model generation.
- Stored-data replay reads existing SQLite evidence without calling X.

## Draft intelligence

The three model stages are opportunity analysis, generation, and independent
evaluation. They use `gpt-5.6-luna` with `xhigh` through the existing authenticated
Codex CLI. Each stage runs in a separate ephemeral process. No paid model API
fallback is configured.

Supported outputs:

| Output | Intended human use |
|---|---|
| `POST_DRAFT` | An original post grounded in source evidence |
| `REPLY_DRAFT` | A response to the linked source post |
| `QUOTE_DRAFT` | Commentary accompanying the linked post |
| `NO_ACTION` | A recorded decision when no suitable contribution is available |

Candidates reference approved Marx facts. Generation accepts only configured
strategy families and valid context/fact IDs. Evaluation must cover every
candidate and return valid scores plus an explicit decision.

The current content rules require 40–280 JavaScript string characters, one
Marx mention, a source anchor, and passing quality/risk thresholds. Checks
reject configured praise/hype patterns, links, CTAs, hashtags, repeated words,
near-duplicate text, and configured financial-advice terms. These checks are
heuristics; the independent evaluator and human review remain necessary.

## Evidence and review

- SQLite stores runs, posts, account observations, run/post links, actions,
  source calls, model events, checkpoints, and founder decisions.
- Versioned JSON messages and stable hashes connect a draft to its text,
  target, context, model, prompt versions, and product fact IDs.
- Each successful run writes `founder-review.json` and a readable
  `founder-review.md` with source excerpts and draft details.
- Founder decisions can be imported using the exact stored action hash.
- `verify-v1` checks for approved real-data drafts across all three draft types
  and the presence of approved product facts. It is an acceptance counter,
  not an automated deployment or publication command.

## Operations

- Configuration schema validation and explicit run modes.
- Single-run lock with owner token and periodic heartbeat.
- Stored step checkpoints and resume support for interrupted, failed, and
  model-limit-stopped runs.
- Source-call and model-call budgets, timeouts, process cancellation, and
  structured progress/error output.
- `doctor`, `status`, `recover`, and retention commands.
- Legacy comprehensive scraping scripts and historical outputs remain available
  through their [separate runbook](runbook.md).

V1 ends at local draft/review artifacts. Hermes publishing and automatic cron
execution are not enabled by these features.
