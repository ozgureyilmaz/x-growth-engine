# Using V1

V1 runs from the terminal and writes review files. It does not publish to X.
Use this guide for the daily engine; [runbook.md](runbook.md) covers the older
comprehensive batch runner.

## 1. Prepare the environment

From the repository root:

```bash
cd /Users/0x79de/dev/x-growth-engine
npm ci
npm run check
npm test
```

Requirements are Node (package minimum: 20), the system `sqlite3` CLI, Codex
CLI with ChatGPT authentication, and the existing local XActions wrapper for
live mode. The wrapper also needs its configured browser and Keychain items.
Replay does not need to start the browser or XActions.

Optional path overrides:

```bash
export XGE_XACTIONS_MCP_COMMAND=/Users/0x79de/Documents/Codex/2026-09-02/bun/scripts/xactions-mcp.sh
export CODEX_EXEC_BIN=/Users/0x79de/.local/bin/codex
export PUPPETEER_EXECUTABLE_PATH=/Applications/Comet.app/Contents/MacOS/Comet
```

These are paths, not secrets. The runner reads exported environment variables;
it does not automatically load `.env`. See [`.env.example`](../.env.example).
The default XActions wrapper reads `xactions-auth-token` and
`xactions-csrf-token` from macOS Keychain. Do not paste their values into chat or
commit them. The configured draft account is `nullquanty` in config, not an
`X_ACCOUNT` environment variable.

Check prerequisites:

```bash
codex login status
npm run daily -- doctor
```

To test one actual XActions search:

```bash
npm run daily -- doctor --live-read
```

That command performs a live read. `PASS` confirms the checks reported in its
JSON, not available Codex quota or full production readiness.

## 2. Choose a run

For a local fixture smoke test:

```bash
npm run daily -- run --mode FIXTURE_DRY_RUN --fixture outputs/mcp-comprehensive-x-export.json
```

This historical export may now be outside the lookback window and produce
`NO_ACTION`. It never exercises the real model. A run without `--mode` defaults
to the checked-in fixture mode.

For fresh discovery only, with zero Codex calls:

```bash
npm run daily -- run --mode EXPERIMENTAL_LIVE_READ --max-drafts 0
```

Use the returned `run_id` to generate at most one draft from that stored data:

```bash
source_run_id='REPLACE_WITH_DISCOVERY_RUN_ID'
npm run daily -- replay --run-id "$source_run_id" --max-drafts 1
```

Replay uses stored post evidence and labels it post-only. It does not claim to
know current replies. Approved, unexpired Marx facts and available Codex usage
are required when generating non-fixture drafts.

After reviewing Stage 1, run fresh discovery plus enrichment and up to five
drafts:

```bash
npm run daily -- run --mode EXPERIMENTAL_LIVE_READ --max-drafts 5
```

You can select an existing compatible JSON config with `--config /absolute/path/config.json`.
Paths inside config resolve from the repository root. Do not change publisher
settings; the V1 schema requires publication to be disabled.

## 3. Read the result

Progress is JSON on stderr. The command's final result is JSON on stdout;
the `npm` wrapper also prints its usual command banner. For stdout suitable for
direct JSON parsing, invoke `node scripts/run-daily.mjs` with the same arguments.

Outputs for a completed run:

```text
outputs/daily/<run-id>/founder-review.json
outputs/daily/<run-id>/founder-review.md
outputs/daily/x-growth.sqlite
outputs/daily/events.jsonl
```

`founder-review.json` contains source evidence, context details, approved facts,
drafts, evaluation/QA results, decisions and model-call count. Markdown makes
the source excerpt and exact draft easier to review. Failures write `failure.json`.

| Status | Meaning |
|---|---|
| `DISCOVERY_COMPLETE` | Evidence collection/replay completed with drafts disabled |
| `READY_FOR_FOUNDER_REVIEW` | One or more drafts passed the current gates |
| `NO_ACTION` | Processing completed without a selected draft |
| `MODEL_LIMIT_STOPPED` | Model/provider budget prevented continuation |
| `INTERRUPTED` | The operation was cancelled or its dead owner was recovered |
| `FAILED` | Inspect the final error code and stored events |

Inspect a run:

```bash
npm run daily -- status --run-id "$source_run_id"
```

For the latest run, omit `--run-id`. Inspect the database's actual run status
when a process exits unexpectedly; an existing output file alone is not success.

## 4. Record human review

Create a decision JSON following [Founder review contract](founder-review-contract.md).
Copy the action ID and hash from the exact draft you reviewed. Then import it:

```bash
npm run review -- --file /absolute/path/to/founder-review-decisions.json
npm run daily -- verify-v1
```

The agreed V1 gate requires one approved real-data `POST_DRAFT`, `REPLY_DRAFT`,
and `QUOTE_DRAFT`. An approval means the text was accepted for the experiment;
it does not send the draft to X. Never fabricate approval records to pass this gate.

## 5. Resume or recover

After resolving a model limit or transient problem, resume the stopped run:

```bash
stopped_run_id='REPLACE_WITH_STOPPED_RUN_ID'
npm run daily -- run --resume "$stopped_run_id"
```

Use the same config as the original run. Resume restores its saved mode, clock,
source run, draft limit and query plan. Changed config or changed checkpoint
input is rejected. The model-call budget includes earlier attempts. A completed
run cannot be resumed as if it were unfinished.

If the error is `DAILY_RUN_LOCKED`, inspect `.daily-run.lock/owner.json` beneath
the configured storage root and the matching process. If that owner is dead:

```bash
npm run daily -- recover --run-id "$stopped_run_id"
```

Recovery targets the supplied run and changes only `RUNNING` records to
`INTERRUPTED`; it does not fix source authentication or replenish model quota.
Do not delete a live owner's lock or stop unrelated browser/Codex processes.

Source auth, challenge, rate-limit and timeout failures stop the stage. Address
the reported cause before trying again. The engine does not switch to a paid
provider or another model automatically.

## 6. Retention and release

The retention preview does not delete data:

```bash
npm run daily -- retention
```

`retention --apply` removes raw post/account database rows older than its
30-day cutoff. Read the retention limitations in [Capabilities](v1-capabilities.md)
and back up the database before using it. Do not rely on this command to scrub
all copies of source text from the workspace.

Publication and cron are outside V1. The release workflow remains: review real
drafts, record the three approvals, verify tests and artifacts, then push the
experimental branch. `verify-v1` never commits, pushes or merges by itself.
