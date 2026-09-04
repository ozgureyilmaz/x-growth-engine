# Production Hardening Implementation Plan

## Goal

Make the existing bounded, public-read X research pipeline deterministic and
safe to operate repeatedly in real-world runs. This project remains an XActions
MCP batch controller and evidence processor; it is not being expanded into a
general-purpose web scraper or an autonomous X client.

## Work plan

1. **Freeze behavior with black-box tests**
   - Add Node's built-in test runner with isolated temporary run directories.
   - Reproduce incomplete finalization, missing control gates, duplicate resume,
     invalid evidence, lock contention, and policy-driven retry behavior.
2. **Enforce a fail-closed run state machine**
   - Require a passed control check before search or enrichment ingest.
   - Permit finalization only after all searches finish, or after an explicit
     hard stop.
   - Make finalized runs immutable.
3. **Make ingest idempotent and recoverable**
   - Prevent repeated batches from changing records or completion counters.
   - Reconcile stored-record counts from JSONL after every accepted batch.
   - Serialize run mutations with an atomic per-run lock.
4. **Validate evidence at the trust boundary**
   - Accept only canonical public X status URLs whose handle matches the record.
   - Require valid timestamps inside the frozen lookback window and not in the
     future.
   - Count rejected records without promoting them to the evidence dataset.
5. **Remove hidden machine coupling**
   - Make the scorer path configurable by CLI, environment, or policy.
   - Validate scorer availability before producing final artifacts.
   - Freeze retry and scoring thresholds into each run manifest.
6. **Update operations documentation and verify**
   - Document state gates, locking, recovery, validation, and scorer selection.
   - Run syntax checks, unit/integration tests, scorer tests, and a full isolated
     initialization-to-finalization smoke test.

## Acceptance criteria

- Replaying a search or enrichment batch produces no duplicate records and does
  not inflate completed-operation counters.
- Search cannot start until the control query passes.
- An incomplete non-stopped run cannot report `OK` or emit final artifacts.
- Invalid or out-of-window evidence never reaches JSONL or the scoring export.
- Concurrent writers fail clearly instead of racing.
- Retry behavior comes from the frozen run policy.
- `npm test` and the isolated end-to-end smoke test pass without network access.

## Implementation result

Completed on 2026-09-04. The controller suite passes 13 black-box tests, the
reference scorer passes its 4 tests, and an isolated 120-query empty-source run
completed as `NO_ACTION` with schema version 2, an empty action ledger, valid
CSV/SVG artifacts, and no residual lock. This verifies local behavior only;
live MCP reliability and production deployment remain separate gates.
