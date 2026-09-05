# V1 capabilities and limits

V1 is an experimental X research and draft-review workflow operated from a Mac.
A successful local test or source preflight does not establish full end-to-end
live draft quality. The release criterion agreed for this project is human
approval of a real-data post draft, reply draft, and quote draft.

## Execution modes

| Mode | Input | Model execution | Context |
|---|---|---|---|
| `FIXTURE_DRY_RUN` | Local export/fixture | Deterministic fixture candidate | Synthetic/test only |
| `EXPERIMENTAL_LIVE_READ` | Local XActions MCP | Codex for shortlisted opportunities | Bounded account/timeline/thread/reply samples |
| `REPLAY_REAL_DATA` | Previously stored posts | Codex when drafts are requested | Post-only; no fresh X lookup |

Replay does not refresh the post or establish current reply context. Empty
reply arrays do not prove there are no replies. Source completeness is recorded
as sampled, unknown, or post-only rather than inferred from a count.

## Current configured ceilings

| Resource | Default |
|---|---:|
| Search lookback | 48 hours |
| Query variants per run | 12 |
| Results requested per query | 10 |
| Stored posts per run | 120 |
| Configured account enrichment ceiling | 10 |
| Timeline posts per account | 20 |
| Shortlisted contexts reaching analysis | Up to 5 with current settings |
| Candidates per eligible opportunity | Up to 3 |
| Review drafts | Up to 5 |
| Codex calls across a run and its resumes | 8 |
| Attempts per model stage in an invocation | 2 |
| Concurrent model calls | 1 |
| Model-call timeout | 120 seconds |
| Source operation timeout | 60 seconds |
| Total invocation timeout | 30 minutes |

The control search is additional to the research query count. Live enrichment
also makes profile, timeline, reply, and thread calls. `--max-drafts 1` caps final
selected drafts; it does not necessarily reduce analysis to one source post.
The application may return fewer drafts or none. It does not lower thresholds
to fill a quota.

## Model and product facts

Model and effort are fixed by the config schema to `gpt-5.6-luna` and `xhigh`.
The CLI session supplies authentication; the engine does not request an API key
or purchase credits. A successful login check is not proof of remaining usage
capacity. `MODEL_LIMIT_STOPPED` can reflect the local call budget or provider
quota; inspect the stored model events before rerunning.

`config/marx-facts.json` is the approved claim registry. The draft pipeline
checks approval identity/time, expiry, source domain, and claim hash before
model execution. Generated fact IDs must exist in that registry. Evaluator
judgment is still needed to detect an unsupported paraphrase or extrapolation.

## Persistence and known boundaries

- Post IDs deduplicate storage and run/post links preserve discovery lineage.
- Checkpoints are reused only when their stored input hash matches.
- Draft-body history separates fixture runs from non-fixture runs.
- Action IDs currently include the run ID. Cross-run text duplicate protection
  is performed by history checks, not by a global action-ID guarantee.
- Replay currently loads stored posts, not a fresh copy of account/thread context.
- `doctor` checks prerequisites and optionally one live search. It does not
  invoke the model, test all enrichment tools, or validate all runtime states.
- `verify-v1` is a narrow review gate; passing it does not prove fresh source
  health, all tests, or permission to publish.
- Retention currently removes older raw post/account rows on explicit `--apply`.
  It does not scrub raw text already copied into checkpoints, review bundles,
  backups, or event files. It is not a complete data-deletion guarantee.
- Shared-phrase and semantic repetition are requested in evaluator prompts;
  deterministic duplicate detection currently uses token overlap.
- Human review imports update the recorded decision; the current importer is
  not an append-only, cryptographically authenticated reviewer system.

## Not provided

V1 does not publish to X, run Hermes cron, schedule posts, monitor publication
outcomes, contact prospects, or measure causal growth. V2 automatic publication
is isolated behind `npm run daily -- auto --config config/daily-v2.json`; V1
commands cannot invoke it. Do not treat V1 draft generation or approval import
as proof of publication.

For commands and recovery guidance, use [V1 usage](v1-usage.md).
