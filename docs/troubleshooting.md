# Troubleshooting

## `usage` or missing `run-dir`

Use one of the supported modes:

```bash
node scripts/run-comprehensive.mjs --new-run
node scripts/run-comprehensive.mjs --ingest --run-dir outputs/runs/<run-id>
node scripts/run-comprehensive.mjs --finalize --run-dir outputs/runs/<run-id>
```

Do not point a new collection at an old run directory.

## MCP returns an empty result

An empty result is not automatically a failure. Check the manifest and the
query:

- If the known control query is empty, the runner stops with
  `CONTROL_CHECK_EMPTY`; report the source issue.
- If only a narrow query is empty, mark that query `empty`, checkpoint, and
  continue sequentially.
- Do not replace MCP with Comet or another source without an explicit fallback
  decision and per-row source labeling.

## Authentication, challenge, or rate limit

Stop immediately. Do not retry, call `x_login`, inspect cookies, or paste
credentials into the runner. Record the sanitized error class and escalate to
the research/system owner.

## Transient runtime error

Send an `error` batch with `scope`, `index`, `attempt`, and a sanitized message.
Retry only if it is a transient runtime/browser failure and the attempt count is
below the configured two retries. Stop after three repeated runtime failures.

## `src` import error in tests

The scorer tests must run from the scorer bundle directory:

```bash
cd /Users/0x79de/Documents/Codex/2026-09-02/bun
python3 -m unittest discover -s tests -p 'test_pipeline.py'
```

## CSV has fewer rows than expected

This can be valid. The scorer filters at `--min-score 50`, while raw discovery
may contain duplicates, noise, missing explicit AI/trading signals, or spam
penalties. Report the raw/author/scored counts separately. Never lower the
threshold silently or pad rows.

## Resume appears to duplicate data

Check that you reused the exact same `run_dir`. The runner deduplicates search
records by ID/URL and profiles by case-insensitive username. If a duplicate was
written, stop sharing the run, preserve the directory, and inspect the JSONL
record IDs before attempting repair.

## `control_check_not_passed` or `search_plan_not_complete`

Ingest the control batch before search. Complete every frozen search query
before enrichment. Do not edit manifest statuses to bypass these gates.

## `incomplete_search_plan`

A non-stopped run cannot be finalized while a query is pending, running, or
retryable. Resume it or ingest the real hard-stop error; do not label partial
collection as success.

## `run_locked`

Inspect `.run.lock/owner.json` and wait for the owning process. If the PID no
longer exists, preserve the run and remove only that run's stale lock directory
before resuming.

## `scorer_not_found`

Pass an existing scorer with `--scorer`, set `XGE_SCORER_PATH`, or configure
`scorer_path` before initializing the run. Do not swap scoring algorithms during
an active run.

## SVG does not validate or looks clipped

Run `xmllint --noout` first. If XML is valid, render a preview with an available
renderer such as Quick Look and inspect every node, branch, and label. Fix the
generator and rerun `--finalize`; do not hand-edit the generated SVG.

## Secret-pattern match

Treat any `auth_token`, `ct0`, cookie, bearer token, password, or API-key match
as a release blocker. Preserve the evidence privately, remove the affected
run from sharing, and escalate for credential review. Do not print the value.
