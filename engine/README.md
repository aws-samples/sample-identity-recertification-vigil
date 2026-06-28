# Recertification Engine

A standalone, production-grade **access recertification engine** for AWS. It discovers
resources by `owner` tag, raises review requests to owners, accepts owner decisions
(**certify / modify / revoke**), and **durably enforces the resulting permission change**
on the resource, with an immutable, hash-chained evidence trail for every decision and
every change applied.

This module is self-contained and integration-first: your UI (or any client) drives it
through a documented REST API. It does not depend on the legacy VIGIL dashboards,
audit-writer, IdP-sync, or activity-tracking code.

---

## Scope (what this engine does, and only this)

1. **Discovery**: enumerate resources tagged `owner=<email>`, resolve who has access to
   each (bucket policy / IAM / ACL), and create per-owner review items for a cycle.
2. **Request / Notify**: email each owner their pending reviews with a deep link.
3. **Decision intake**: owners certify, modify (remove specific permissions), or revoke,
   per-resource or per-principal, via `POST /decisions`.
4. **Enforcement**: a durable, idempotent worker applies the change through a pluggable
   **resource connector** (S3, IAM shipped; extensible), snapshotting before-state for
   rollback and recording hash-chained evidence.

Out of scope (intentionally): general lifecycle audit, IdP sync / deletion proof,
activity tracking, dashboards. Those live in the legacy tree and are not shipped here.

---

## Architecture

```
                       +-------------------+
  Client UI  --REST-->  |   recert-api      |  cycles / reviews / decisions / rollback
                       +---------+---------+
                                 | enqueue (decision)
                                 v
                          +-------------+        +------------------+
                          |  SQS queue  |--DLQ-->|  alarms / replay |
                          +------+------+        +------------------+
                                 |
                                 v
                       +-------------------+    snapshot -> apply -> verify
                       |  recert-enforcer  |--> Resource Connectors (S3, IAM, ...)
                       +---------+---------+    -> evidence (hash chain) + status
                                 |
              +------------------+------------------+
              v                  v                  v
        DynamoDB            Evidence (S3 WORM)     SES (owner notifications)
   (cycles/items/        (immutable decision +
    decisions/snapshots)  snapshot evidence)
```

Discovery and notification run as their own functions (`recert-discovery`,
`recert-notifier`), triggered on cycle creation and by schedule.

### Why enforcement is async
The API records and validates the decision, then enqueues it. The `recert-enforcer`
consumes the queue, is **idempotent** (keyed by `decisionId`), retries with backoff, and
dead-letters poison messages. This makes "the action actually changes the permission"
reliable and observable instead of a best-effort inline call.

---

## Layout

```
engine/
  README.md
  package.json
  template.yaml            # slim SAM stack (engine only)
  openapi.yaml             # integration contract for client UIs
  src/
    lib/                   # config, ddb, time, hash, logging, http responses
    core/                  # models, decision state machine, evidence, enforcement orchestration
    connectors/            # base interface + s3/iam connectors + registry
    api/                   # single API handler (cycles, reviews, decisions, snapshots)
    discovery/             # owner-tag discovery + access enumeration
    enforcer/              # SQS consumer -> connectors
    notifier/              # SES owner notifications
  tests/                   # node:test unit + integration tests
```

---

## Evidence model (hash chain)

Every decision and every enforced change writes an append-only evidence record:

```
evidenceHash = sha256( canonical(recordFields) + "|" + prevHash )
```

Records are linked per resource (`prevHash` -> previous record's `evidenceHash`), giving a
tamper-evident chain. Before-state **snapshots** are captured prior to any mutation, so a
revocation/modification is fully reconstructable and reversible via `POST /rollback`.
When `EVIDENCE_BUCKET` is configured, evidence is also written to S3 with Object Lock
(WORM) for long-term compliance retention.

---

## Configuration (all via env / SSM, no hardcoded account)

| Variable | Required | Purpose |
|---|---|---|
| `TABLE_NAME` | yes | DynamoDB single-table store |
| `ENFORCEMENT_QUEUE_URL` | yes | SQS queue the API enqueues decisions to |
| `EVIDENCE_BUCKET` | no | S3 WORM bucket for evidence (omit to disable) |
| `SES_SENDER_EMAIL` | yes | Verified sender for owner emails |
| `UI_BASE_URL` | yes | Base URL used in email deep links |
| `RECERT_DEADLINE_DAYS` | no (14) | Review window |
| `MANAGEMENT_ACCOUNT_ID` | no | Resolved from STS at runtime if unset |
| `CROSS_ACCOUNT_ROLE_NAME` | no (`VIGILCrossAccountRole`) | Role assumed in member accounts |

---

## Integration contract (summary, see `openapi.yaml`)

- `POST /cycles`: start a recertification cycle (quarterly or ad-hoc/scoped)
- `GET  /cycles/{cycleId}`: cycle summary + per-owner progress
- `GET  /reviews?cycleId=`: current owner's pending review items
- `POST /decisions`, submit decisions: `{ cycleId, decisions: [{ resourceArn, principalArn?, decision, reason?, changes? }] }`
- `GET  /decisions/{decisionId}`: enforcement status (`PENDING|IN_PROGRESS|ENFORCED|FAILED|NOT_REQUIRED`)
- `GET  /resources/{arn}/snapshots`: before-state snapshots
- `POST /rollback`: restore a resource to a prior snapshot

---

## Status

Scaffolding in progress. Build order: foundation (lib/core/connector contract) →
connectors (S3, IAM) → enforcer → discovery → api → notifier → SAM template + OpenAPI →
tests.
