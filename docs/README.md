# Documentation

This directory explains how to operate the bounded Marx public-X research
pipeline.

## Start here

1. [`runbook.md`](runbook.md) — end-to-end collection, resume, finalize, and stop procedure.
2. [`mcp-batch-contract.md`](mcp-batch-contract.md) — how MCP responses are passed to the local runner.
3. [`output-schema.md`](output-schema.md) — run files, fields, evidence requirements, and QA.
4. [`architecture.md`](architecture.md) — data flow and design boundaries.
5. [`troubleshooting.md`](troubleshooting.md) — common failures and safe recovery.

The system is intentionally split into two responsibilities:

- XActions MCP performs public read-only discovery and enrichment.
- The local Node runner checkpoints, deduplicates, exports, scores, and reports.

Credentials, cookies, contact inference, outreach, and X write actions are out
of scope.
