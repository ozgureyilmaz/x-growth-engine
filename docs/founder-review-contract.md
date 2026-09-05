# Founder review JSON contract

V1 outputs `outputs/daily/<run-id>/founder-review.json`. It is the source of
truth for human review; `founder-review.md` is only a rendered convenience view.

The reviewer imports an array of decisions using:

```bash
npm run review -- --file /absolute/path/to/founder-review-decisions.json
```

Each decision must bind to the exact draft:

```json
[
  {
    "action_id": "xact_...",
    "action_hash": "<64-char-sha256>",
    "decision": "APPROVED",
    "reason": "contextual, specific, and useful",
    "reviewed_at": "2026-09-04T10:00:00.000Z"
  }
]
```

The bundle includes the original source context, retrieval timestamp, approved
fact IDs, model provenance, evaluation scores, deterministic QA reasons, and
the action hash. This lets the reviewer judge the draft without reopening X.

Allowed decisions are `APPROVED`, `NEEDS_REVISION`, `REJECTED_GENERIC`,
`REJECTED_PROMOTIONAL`, `REJECTED_IRRELEVANT`, `REJECTED_UNSUPPORTED`, and
`REJECTED_VOICE`. A stale, forged, or unknown action hash is rejected. Importing
a founder approval does not publish anything in V1 and does not enable the
different V2 automatic publisher. V2 uses its own policy authorization and is
invoked only by the explicit `auto` command.
