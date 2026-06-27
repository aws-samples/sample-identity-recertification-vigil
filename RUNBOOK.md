# VIGIL Runbook

Operational runbook for the VIGIL access recertification engine. It explains how the engine
works under the hood and gives step-by-step procedures for deploying, monitoring, and
recovering it. For the full developer reference (API, connectors, data model, extension), see
the **[Developer Guide](engine/DEVELOPER_GUIDE.md)**.

---

## Table of contents

1. [System overview](#system-overview)
2. [How a recertification cycle works](#how-a-recertification-cycle-works)
3. [The enforcement engine](#the-enforcement-engine)
4. [Evidence, snapshots, and rollback](#evidence-snapshots-and-rollback)
5. [Data model](#data-model)
6. [Deployment](#deployment)
7. [Monitoring](#monitoring)
8. [Operational procedures](#operational-procedures)
9. [Key design decisions](#key-design-decisions)
10. [Legacy platform components](#legacy-platform-components)

---

## System overview

The engine is a set of four Lambda functions, a DynamoDB single table, an SQS queue with a
dead-letter queue (DLQ), an optional S3 Object Lock evidence bucket, and Amazon SES for
notifications. The REST API is fronted by API Gateway with an Amazon Cognito user pool
authorizer.

| Function | Trigger | Responsibility |
|---|---|---|
| `recert-api` | API Gateway | Cycles, reviews, decision intake, snapshots, rollback. Enqueues decisions to SQS. |
| `recert-discovery` | Async invoke / schedule | Owner-tag discovery + access enumeration → review items. |
| `recert-enforcer` | SQS | Applies decisions via connectors; writes evidence; updates status. |
| `recert-notifier` | Async invoke | Sends owner emails (initial / reminder / escalation / confirmation). |

See [docs/architecture.png](docs/architecture.png) for the diagram.

---

## How a recertification cycle works

A cycle moves through five phases.

**Phase 1 — Initiate.** A client calls `POST /cycles` (or the quarterly EventBridge schedule
fires). `recert-api` writes a `CYCLE#<id> / SUMMARY` record with status `INITIATING` and
asynchronously invokes `recert-discovery`.

**Phase 2 — Discover.** `recert-discovery` calls the Resource Groups Tagging API for every
resource tagged `owner=<email>`. For each resource it enriches access details (for S3: bucket
policy, public access block, ACL) and derives **access entries** — the principals that have
access, with their access source (`BUCKET_POLICY`, `IAM_POLICY`, `IAM_GROUP`, `ACL`) and
permissions. It writes one review item per (owner, resource), flips the cycle to `ACTIVE` with
totals, and triggers `recert-notifier`.

> The Tagging API is eventually consistent; a freshly tagged resource may take a few minutes
> to appear.

**Phase 3 — Notify.** `recert-notifier` emails each owner the list of pending reviews with a
deep link built from `UI_BASE_URL`.

**Phase 4 — Decide.** Owners call `POST /decisions` (via the UI). `recert-api` validates each
decision against the stored review item, enriches it (resource type, access info, per-principal
access source), writes an immutable `DECISION` record with a deterministic id, and enqueues it
to SQS. Decisions are write-once per `(cycle, resource, principal)` via a conditional write.

**Phase 5 — Enforce.** `recert-enforcer` consumes the queue. For each decision it captures a
snapshot, applies the change through the matching connector, appends evidence, and sets the
decision and review-item statuses. `CERTIFY` is recorded as evidence with status
`NOT_REQUIRED`; `REVOKE`/`MODIFY` produce a real change (`ENFORCED`) or a `TICKETED` record when
automation is unsafe.

Ad-hoc cycles use the id format `<year>-ADHOC-<timestamp>`; quarterly cycles use `<year>-Q<n>`.

---

## The enforcement engine

Enforcement is performed by **connectors**, one per resource type, behind a common interface
(`snapshot` / `revoke` / `modify` / `rollback`). The enforcer never calls AWS resource APIs
directly.

| Connector | Type | Behavior |
|---|---|---|
| S3 | `s3:bucket` | Bucket-policy/ACL principal removal; scoped explicit `Deny` when access is IAM-sourced; full lockdown (delete policy + block public + private ACL); partial removal of statements/grants/actions. |
| IAM user | `iam:user` | Full: detach policies, remove from groups, deactivate keys, delete login profile. Modify: remove only the selected items. |
| IAM role | `iam:role` | Full: detach all managed policies. Modify: detach selected policies. |

**Guarantees**

- **Scoped.** A change only affects the target resource. When access comes from a principal's
  IAM policy (not the resource), the engine adds a scoped explicit `Deny` on the resource
  rather than altering the principal's IAM identity.
- **No silent no-ops.** Every enforced decision records the actions taken; if nothing can be
  done safely, it becomes a `TICKETED` record, not a fake success.
- **Idempotent.** The deterministic `decisionId` (`cycleId::resourceArn::principalArn`) plus a
  terminal-status guard means SQS redeliveries never double-apply.
- **Durable.** Failures are retried; after `maxReceiveCount` the message goes to the DLQ and a
  CloudWatch alarm fires.

---

## Evidence, snapshots, and rollback

Every decision and change appends to a per-resource, append-only hash chain:
`evidenceHash = sha256(canonical(fields) + "|" + prevHash)`. Tampering breaks the chain;
`verifyResourceChain(arn)` validates it. With `EVIDENCE_BUCKET` set, records are also mirrored
to S3 Object Lock (WORM).

Before any mutation, the connector captures a **snapshot** of the resource's prior state
(`RESOURCE#<arn> / SNAPSHOT#<ts>`). An admin can restore it via `POST /rollback`.

---

## Data model

Single DynamoDB table; `GSI1` for type/cycle fan-out.

| Entity | PK | SK |
|---|---|---|
| Cycle | `CYCLE#<id>` | `SUMMARY` |
| Review item | `OWNER#<email>` | `REVIEW#<cycleId>#<arn>` |
| Decision | `DECISION#<decisionId>` | `META` |
| Snapshot | `RESOURCE#<arn>` | `SNAPSHOT#<ts>` |
| Evidence | `RESOURCE#<arn>` | `EVIDENCE#<ts>` |
| Ticket | `TYPE#TICKET` | `<ts>#<arn>#<principal>` |

All writes use `attribute_not_exists(PK)` for idempotency. The table and (optional) evidence
bucket use `DeletionPolicy: Retain`.

---

## Deployment

```bash
cd engine
sam build
sam deploy --guided --stack-name recert-engine-<stage> \
  --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM \
  --parameter-overrides Stage=<stage> SesSenderEmail=you@example.com \
                        UiBaseUrl=https://your-ui.example.com
```

Outputs: `ApiEndpoint`, `TableName`, `EnforcementQueueUrl`, and (if created)
`CognitoUserPoolId` / `CognitoUserPoolClientId`. Then create a user and add them to `owner`
(and `admin` for cycle/rollback rights). The Lambda runtime is `nodejs24.x`, which provides
AWS SDK v3 — no dependency bundling is required.

---

## Monitoring

- **DLQ alarm** (`recert-engine-enforcement-dlq-not-empty-<stage>`) — fires when a decision
  could not be enforced after retries. This is the primary "something went wrong" signal.
- **Structured logs** — each function logs JSON with `level` and `code`. Watch for
  `ENFORCEMENT_FAILED`, `EMAIL_SEND_FAILED`, `REVIEW_STATUS_UPDATE_FAILED`,
  `CROSS_ACCOUNT_ASSUME_ROLE_FAILED`.
- **Stuck decisions** — a decision in `PENDING`/`IN_PROGRESS` for long means the enforcer has
  not processed it; check enforcer logs and the queue.

---

## Operational procedures

### Run a discovery cycle on demand

UI **Discovery** → **Run Discovery**, or:
```bash
curl -X POST "$API/cycles" -H "Authorization: <ID_TOKEN>" \
  -H 'Content-Type: application/json' -d '{"cycleType":"AD_HOC"}'
```

### Check a decision's enforcement status

```bash
curl "$API/decisions?decisionId=<id>" -H "Authorization: <ID_TOKEN>"
```

### Investigate and redrive the DLQ

1. Inspect a message: `aws sqs receive-message --queue-url <DLQ_URL>`.
2. Read the enforcer logs for the `decisionId` to find the root cause (`ENFORCEMENT_FAILED`).
3. Fix the cause (for example, a missing IAM permission or cross-account role).
4. Redrive from the SQS console (Start DLQ redrive) or re-enqueue
   `{"decisionId":"<id>"}` to the main queue.

### Roll back a resource

```bash
curl -X POST "$API/rollback" -H "Authorization: <ADMIN_ID_TOKEN>" \
  -H 'Content-Type: application/json' -d '{"resourceArn":"<arn>"}'
```
Omitting `snapshotSK` restores the most recent snapshot.

### Verify the evidence chain (incident / audit)

Read the resource's `EVIDENCE#*` records (ordered) and confirm each `prevHash` links to the
prior `evidenceHash`; `verifyResourceChain` performs this programmatically.

### Add a new resource type

Implement a connector (`engine/src/connectors/`), register it in `registry.mjs`, grant the
enforcer the new IAM actions in `template.yaml`, add a unit test, and redeploy. See the
Developer Guide.

---

## Key design decisions

**Asynchronous enforcement.** Decisions are queued and applied by a separate, idempotent
worker so the API stays fast and the change is durable, retried, and observable — not a
best-effort inline call.

**Tag-driven ownership.** Tags are the one universal metadata mechanism across AWS services,
so `owner` works for any taggable resource without per-service ownership logic.

**Scoped enforcement / explicit Deny.** Revoking IAM-sourced access by editing the principal's
IAM policy would affect unrelated resources. A resource-side explicit `Deny` removes access to
*only* the target resource and is fully reversible.

**Connectors over special-casing.** Each resource type's behavior is isolated behind one
interface, so new types are additive and the enforcer stays generic.

**Automated for S3/IAM, ticket otherwise.** These types have well-defined, reversible
revocation semantics. For others, a human-in-the-loop ticket is safer than guessing.

---

## Legacy platform components

The original VIGIL platform (under `src/`, `scripts/`, `stackset-templates/`) included a user
lifecycle audit trail, IdP sync / deletion proof, activity tracking, dashboards, and the
`recert-initiator`/`recert-processor` functions. Those components are **not part of the shipped
recertification engine** and are retained for reference only. The full pre-engine state is
recoverable at the git tag `pre-engine`.
