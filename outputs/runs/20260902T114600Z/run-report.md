# Marx X comprehensive prospect run

- Plan status: proposed — confirm with the research decision owner.
- Run: `20260902T114600Z`
- Status: **OK**
- Started: 2026-09-02T11:46:00.893Z
- Finished: 2026-09-02T14:55:25.135Z
- Source: XActions MCP public read tools; platform: twitter; public read-only MCP calls.
- Lookback: since 2026-06-04; query plan: 120 normalized queries across 12 buckets.

## Observed counts

| Stage | Count | Cap |
|---|---:|---:|
| Completed search calls | 120 | 120 |
| Stored raw tweets | 573 | 1200 |
| Unique authors | 493 | 500 |
| Enriched profiles | 10 | 200 |
| Recent tweets | 200 | 4000 |
| CSV review rows (score ≥ 50) | 72 | — |

## Evidence contract

A CSV row is a deterministic review candidate, not a qualified prospect. The row must be manually checked for identity match, dated public evidence within the lookback window, direct Marx relevance, and provenance before any outreach.

Primary evidence question: does a bounded public-X MCP pass produce enough identity-matched, dated AI-trading/finance-agent evidence to justify a second research pass or approved network expansion? Outcome that changes the decision: human review confirms or rejects the candidate evidence.

Primary metric: high-intent review rate = rows with score ≥70 / scored rows; source of truth: /Users/0x79de/dev/x-growth-engine/outputs/runs/20260902T114600Z/comprehensive-candidates.csv; cohort/window: this run, 2026-06-04 through 2026-09-02T14:55:25.135Z; evidence status: proposed.

Guardrail: unintended X write; definition/unit: count of follow, like, repost, post, reply, DM, bookmark, profile-edit, or schedule actions; source of truth: run manifest and MCP action logs; cohort/window: this run; evidence status: verified for local ledger (0), external tool logs unknown; trigger/action/responder: any value >0 → stop and credential review / unassigned — system owner.

Guardrail: source-quality failure; definition/unit: auth wall, challenge, rate-limit, or repeated runtime failure; source of truth: run manifest; cohort/window: this run; evidence status: proposed; trigger/action/responder: stop and report / unassigned — research owner.

## Safety and QA

- Actions ledger: exactly empty (0). Network expansion: disabled. Private contact inference: disabled.
- Checkpoints are atomic; search, profile, and recent-tweet records are append-only JSONL. Resume uses record IDs/usernames to avoid duplicates.
- Scores are heuristics. Outreach remains human-approved and is outside this run.
- SVG: [research-pipeline.svg](./research-pipeline.svg).
