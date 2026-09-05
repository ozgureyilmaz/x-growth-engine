# Documentation

This directory explains how to operate the bounded Marx public-X research
pipeline.

## Start here

For the daily V1 engine:

- [V1 features](v1-features.md) — what the implemented workflow provides.
- [V1 capabilities and limits](v1-capabilities.md) — supported modes, budgets and known boundaries.
- [Using V1](v1-usage.md) — environment, real-data runs, review, resume and release.

The documents below include the older comprehensive scraping workflow and
design material. Use the V1 guides above for current daily CLI commands.

1. [`runbook.md`](runbook.md) — end-to-end collection, resume, finalize, and stop procedure.
2. [`mcp-batch-contract.md`](mcp-batch-contract.md) — how MCP responses are passed to the local runner.
3. [`output-schema.md`](output-schema.md) — run files, fields, evidence requirements, and QA.
4. [`architecture.md`](architecture.md) — data flow and design boundaries.
5. [`troubleshooting.md`](troubleshooting.md) — common failures and safe recovery.
6. [`EXPERIMENTAL_X_GROWTH_ENGINE_PLAN.md`](EXPERIMENTAL_X_GROWTH_ENGINE_PLAN.md) — the two-system daily discovery/draft design and V1/V2 boundaries.
7. [`daily-architecture.md`](daily-architecture.md) — the daily discovery, draft, founder-review, and dormant Hermes flow.
8. [`founder-review-contract.md`](founder-review-contract.md) — exact JSON review/import shape.
9. [`.env.example`](../.env.example) — optional non-secret local path overrides.

The system is intentionally split into two responsibilities:

- XActions MCP performs public read-only discovery and enrichment.
- The local Node runner checkpoints, deduplicates, exports, scores, and reports.

Credentials, cookies, contact inference, outreach, and X write actions are out
of scope.
