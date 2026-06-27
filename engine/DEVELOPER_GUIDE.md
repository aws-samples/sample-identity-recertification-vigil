# Recertification Engine — Developer Guide

This guide explains how the access recertification engine works, how to deploy and operate
it, how to integrate it with a client application, and how to extend it to new AWS resource
types.

**Topics**

- [What is the Recertification Engine?](#what-is-the-recertification-engine)
- [How it works](#how-it-works)
- [Concepts](#concepts)
- [Getting started](#getting-started)
- [Authentication and authorization](#authentication-and-authorization)
- [API reference](#api-reference)
- [The decision and enforcement model](#the-decision-and-enforcement-model)
- [Resource connectors](#resource-connectors)
- [Extending the engine: write a connector](#extending-the-engine-write-a-connector)
- [Data model](#data-model)
- [Evidence and rollback](#evidence-and-rollback)
- [Operations](#operations)
- [Security and least privilege](#security-and-least-privilege)
- [Configuration reference](#configuration-reference)
- [Testing](#testing)
- [Cleanup](#cleanup)
- [Troubleshooting](#troubleshooting)
- [Related AWS documentation](#related-aws-documentation)

---

## What is the Recertification Engine?

The Recertification Engine is a serverless service that runs **periodic access reviews** of
your AWS resources and **enforces the outcome**. For each resource tagged with an owner, the
engine asks that owner to confirm who should still have access. When an owner revokes or
modifies access, the engine applies the change to the live resource and records tamper-evident
evidence of what was reviewed, who decided, and what changed.

Use the engine when you need to:

- Run quarterly or ad-hoc access recertification across many resources and owners.
- Guarantee that a reviewer's decision actually changes the resource — not just a ticket.
- Produce a defensible, immutable audit trail of access decisions for compliance.

The engine is **API-first**. All behavior is driven through a REST API, so you can use the
included UI or embed the engine behind your own application.

---

## How it works

![Recertification engine architecture](../docs/architecture.png)

A recertification cycle moves through these stages:

1. **Initiate.** A client calls `POST /cycles` (or a schedule fires). The API writes a cycle
   record and asynchronously invokes the **discovery** function.
2. **Discover.** The discovery function uses the Resource Groups Tagging API to find every
   resource tagged `owner=<email>`, enriches each with its access configuration (for example,
   an S3 bucket's policy/ACL), derives the principals that have access, and writes one
   **review item** per (owner, resource). It then triggers the **notifier**.
3. **Notify.** The notifier sends each owner an email listing their pending reviews with a
   deep link into the UI.
4. **Decide.** Owners submit decisions through `POST /decisions`. The API validates each
   decision against the review item, writes an immutable **decision** record, and enqueues it
   to Amazon SQS.
5. **Enforce.** The **enforcer** consumes the queue. For each decision it captures a
   before-state **snapshot**, applies the change through the matching **connector**, writes
   hash-chained **evidence**, and updates the decision and review item statuses. Failures are
   retried and ultimately dead-lettered.

Because enforcement is asynchronous and idempotent, the API stays fast and the actual
permission change is durable and observable rather than a best-effort inline call.

---

## Concepts

| Term | Description |
|---|---|
| **Cycle** | A recertification run, identified by a `cycleId` (for example `2026-Q3` or `2026-ADHOC-<ts>`). Tracks status and totals. |
| **Review item** | One resource assigned to one owner within a cycle. Holds the resource's access configuration and the list of access entries. |
| **Access entry** | A principal (IAM user/role, account, service) that has access to a resource, with its access source (`BUCKET_POLICY`, `IAM_POLICY`, `IAM_GROUP`, `ACL`) and permissions. |
| **Decision** | An owner's verdict on a resource or a specific principal: `CERTIFY`, `MODIFY`, or `REVOKE`. Identified by a deterministic `decisionId` for idempotency. |
| **Enforcement status** | The lifecycle of applying a decision: `NOT_REQUIRED`, `PENDING`, `IN_PROGRESS`, `ENFORCED`, `FAILED`, `TICKETED`. |
| **Connector** | A pluggable component that performs the actual change for a resource type (snapshot / revoke / modify / rollback). |
| **Snapshot** | The before-state of a resource captured prior to any change, used for evidence and rollback. |
| **Evidence** | An append-only, hash-chained record of every decision and change, per resource. |
| **Ticket** | A record created for a manual IT action when a change cannot be safely automated. |

---

## Getting started

### Prerequisites

- AWS CLI v2 and AWS SAM CLI v1.100+
- Node.js 20+ (Lambda runtime is `nodejs24.x`, which provides AWS SDK v3 — no bundling needed)
- Permission to deploy CloudFormation/SAM stacks, and (for cross-account enforcement) the
  `VIGILCrossAccountRole` deployed in member accounts

### Step 1: Deploy the engine

```bash
cd engine
sam build
sam deploy --guided --stack-name recert-engine-dev \
  --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM
```

Template parameters:

| Parameter | Default | Description |
|---|---|---|
| `Stage` | `dev` | Deployment stage (`dev`/`staging`/`prod`). |
| `SesSenderEmail` | `noreply@example.com` | Verified SES sender for owner emails. |
| `UiBaseUrl` | *(empty)* | Base URL of your UI, used in email deep links. |
| `RecertDeadlineDays` | `14` | Review window. |
| `CrossAccountRoleName` | `VIGILCrossAccountRole` | Role assumed in member accounts. |
| `CognitoUserPoolArn` | *(empty)* | Bring your own pool. Leave blank to create one. |
| `EnableEvidenceBucket` | `true` | Create an S3 Object Lock (WORM) evidence bucket. |

Stack outputs include `ApiEndpoint`, `TableName`, `EnforcementQueueUrl`, and — when the
engine creates the pool — `CognitoUserPoolId` and `CognitoUserPoolClientId`.

### Step 2: Create a user

```bash
POOL=<CognitoUserPoolId>
aws cognito-idp admin-create-user --user-pool-id $POOL \
  --username owner@example.com --user-attributes Name=email,Value=owner@example.com \
  --message-action SUPPRESS
aws cognito-idp admin-set-user-password --user-pool-id $POOL \
  --username owner@example.com --password '<StrongPassword>' --permanent
aws cognito-idp admin-add-user-to-group --user-pool-id $POOL \
  --username owner@example.com --group-name owner   # use 'admin' for cycle/rollback rights
```

### Step 3: Tag resources for discovery

The engine discovers any resource that carries an `owner` tag whose value is the reviewer's
email:

```bash
aws s3api put-bucket-tagging --bucket my-bucket \
  --tagging 'TagSet=[{Key=owner,Value=owner@example.com}]'
```

### Step 4: Run a cycle

From the UI **Discovery** page, choose **Run Discovery**, or call the API:

```bash
curl -X POST "$ApiEndpoint/cycles" -H "Authorization: <ID_TOKEN>" \
  -H 'Content-Type: application/json' -d '{"cycleType":"AD_HOC"}'
```

> **Note**: The Resource Groups Tagging API is eventually consistent. A newly tagged resource
> can take a few minutes to appear in discovery results.

---

## Authentication and authorization

The REST API is protected by an **Amazon Cognito user pool authorizer**
(`COGNITO_USER_POOLS`). Send a Cognito **ID token** in the `Authorization` header of every
request. API Gateway validates the token against the user pool before invoking the function.
See [Control access to REST APIs using Amazon Cognito user pools as an authorizer](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-integrate-with-cognito.html).

Owner identity is taken from the token's `email` claim — never from the request body — so a
caller can only act on their own reviews. Admin-only operations (such as `POST /rollback`)
additionally require the `admin` group in the token's `cognito:groups` claim.

User pool groups:

| Group | Capability |
|---|---|
| `owner` | Submit decisions for resources they own. |
| `admin` | Start cycles, perform rollbacks. |

---

## API reference

All responses use the envelope `{ "success": boolean, "data"?: object, "error"?: string }`.
See [`openapi.yaml`](openapi.yaml) for the machine-readable contract.

| Method & path | Description |
|---|---|
| `POST /cycles` | Start a cycle (triggers async discovery). Body: `{ cycleType, cycleId?, deadlineDays?, scope? }`. |
| `GET /cycles` | List cycles with per-cycle stats (certified/revoked/modified/pending, completion %). |
| `GET /cycles/{cycleId}` | Cycle summary, stats, and per-owner progress. |
| `GET /reviews?cycleId=` | The caller's review items for a cycle. |
| `POST /decisions` | Submit decisions (see below). |
| `GET /decisions?decisionId=` | Enforcement status of a decision. |
| `GET /resources/{arn}/snapshots` | Before-state snapshots captured for a resource (`{arn}` URL-encoded). |
| `POST /rollback` | Restore a resource to a prior snapshot (admin only). Body: `{ resourceArn, snapshotSK? }`. |

### Submitting decisions

`POST /decisions`

```json
{
  "cycleId": "2026-Q3",
  "onBehalfOf": null,
  "decisions": [
    { "resourceArn": "arn:aws:s3:::acme-data",
      "principalArn": "arn:aws:iam::111122223333:user/alice",
      "decision": "REVOKE",
      "reason": "Unnecessary access" },

    { "resourceArn": "arn:aws:s3:::acme-data",
      "principalArn": "arn:aws:iam::111122223333:user/bob",
      "decision": "MODIFY",
      "changes": { "removeActions": ["s3:PutObject", "s3:DeleteObject"] } },

    { "resourceArn": "arn:aws:iam::111122223333:role/app-role",
      "decision": "MODIFY",
      "changes": { "removePolicies": ["arn:aws:iam::aws:policy/AmazonS3FullAccess"] } }
  ]
}
```

**Decision verbs**

| Verb | Effect |
|---|---|
| `CERTIFY` | Access is approved. No change to the resource; recorded as evidence. |
| `MODIFY` | Remove a *subset* of access. Provide `changes` (see below). |
| `REVOKE` | Remove the principal's access to the resource (or fully lock down a resource-level decision). |

**`changes` shape (for `MODIFY`)**

| Resource type | Fields |
|---|---|
| S3 bucket | `removeActions` (per principal), or resource-level `removeStatements` (by Sid), `removeAclGrants` (by grantee), `enablePublicAccessBlock`. |
| IAM user | `removePolicies`, `removeGroups`, `removeAccessKeys`. |
| IAM role | `removePolicies`. |

Each result entry returns a `decisionId` and a `status` of `QUEUED`, `DUPLICATE`, `INVALID`,
or `NOT_FOUND`. Poll `GET /decisions?decisionId=` for the enforcement outcome.

---

## The decision and enforcement model

The engine enforces the **least disruptive, scoped** change that satisfies the decision, and
never silently does nothing:

- **S3, access via bucket policy / ACL** — the principal (or selected actions) is removed
  from the bucket policy or ACL. If a statement is left with no principals, it is dropped; if
  no statements remain, the bucket policy is deleted.
- **S3, access via IAM** — because the grant lives in the principal's IAM policy (not the
  bucket), the engine adds a **scoped explicit `Deny`** for that principal on this bucket.
  This guarantees loss of access to *this resource only* without touching the principal's IAM
  policies or its access to anything else.
- **IAM user / role** — when the resource being recertified *is* the user or role, a full
  revoke detaches managed policies (and for users, removes group memberships, deactivates
  active access keys, and deletes the login profile). A modify removes only the selected
  items.
- **Unsupported or unsafe to automate** — the connector raises `TicketRequiredError` and the
  engine creates a `TICKETED` record for manual IT action instead of guessing.

Enforcement is **idempotent**: the `decisionId` is deterministic
(`cycleId::resourceArn::principalArn`) and the enforcer skips any decision already in a
terminal state, so SQS redeliveries cannot double-apply a change.

---

## Resource connectors

A connector encapsulates everything the engine needs to enforce decisions for one resource
type. Built-in connectors:

| Connector | Resource type | Revoke | Modify | Per-principal | Rollback |
|---|---|---|---|---|---|
| `S3Connector` | `s3:bucket` | ✅ | ✅ | ✅ | ✅ |
| `IamConnector` | `iam:user` | ✅ | ✅ | — | ✅ |
| `IamRoleConnector` | `iam:role` | ✅ | ✅ | — | ✅ |

Resource types without a connector are still discoverable and reviewable; their decisions are
routed to a ticket.

---

## Extending the engine: write a connector

Adding a resource type requires implementing one class and registering it. There are no other
code changes.

### 1. Implement the contract

Extend `BaseConnector` (`src/connectors/base-connector.mjs`):

```js
import { BaseConnector, TicketRequiredError } from './base-connector.mjs';

export class SnsConnector extends BaseConnector {
  static get resourceTypes() { return ['sns:topic']; }
  static get capabilities() { return { revoke: true, modify: true, perPrincipal: true, rollback: true }; }

  // Capture before-state for evidence + rollback.
  async snapshot(ctx) { /* return serializable config */ }

  // Remove access, scoped to THIS resource only.
  async revoke(ctx) { /* return { applied, actions, note? } */ }

  // Remove a subset of access. Throw TicketRequiredError if it can't be done safely.
  async modify(ctx) { /* return { applied, actions } */ }

  // Restore a prior snapshot.
  async rollback(ctx, snapshot) { /* return { applied, actions } */ }
}
```

The `ctx` (EnforcementContext) provides `resourceArn`, `resourceType`, `principalArn`,
`accessSource`, `accessInfo`, `changes`, `accountId`, and `clients` (AWS SDK clients already
scoped to the resource's account). Connectors must use `ctx.clients` and must never widen the
blast radius beyond the target resource.

### 2. Register it

Add the connector to `src/connectors/registry.mjs`:

```js
import { SnsConnector } from './sns-connector.mjs';
const CONNECTORS = [S3Connector, IamConnector, IamRoleConnector, SnsConnector];
```

### 3. Grant permissions and test

Add the connector's API actions to the enforcer role in `template.yaml`, and add a unit test
that injects a fake client (see `tests/connectors.test.mjs`).

---

## Data model

The engine uses a single Amazon DynamoDB table with one global secondary index (`GSI1`) for
type/cycle fan-out queries.

| Entity | PK | SK | GSI1PK / GSI1SK |
|---|---|---|---|
| Cycle summary | `CYCLE#<id>` | `SUMMARY` | `TYPE#CYCLE` / `<startDate>` |
| Review item | `OWNER#<email>` | `REVIEW#<cycleId>#<arn>` | `TYPE#REVIEW_ITEM` / `<cycleId>#<status>` |
| Decision | `DECISION#<decisionId>` | `META` | `TYPE#DECISION` / `<cycleId>#<ts>` |
| Snapshot | `RESOURCE#<arn>` | `SNAPSHOT#<ts>` | — |
| Evidence | `RESOURCE#<arn>` | `EVIDENCE#<ts>` | `TYPE#EVIDENCE` / `<ts>` |
| Ticket | `TYPE#TICKET` | `<ts>#<arn>#<principal>` | `TYPE#TICKET` / `<ts>` |

Key builders and entity/status enums live in `src/core/models.mjs`.

---

## Evidence and rollback

Every decision and change appends a record to a per-resource, append-only chain:

```
evidenceHash = sha256( canonical(recordFields) + "|" + prevHash )
```

Each record links to the previous record's hash, so any tampering breaks the chain.
`verifyResourceChain(resourceArn)` recomputes and validates the full chain. Event types
include `SNAPSHOT_CAPTURED`, `CHANGE_APPLIED`, `ACCESS_CERTIFIED`, `TICKET_CREATED`,
`ENFORCEMENT_FAILED`, and `ROLLBACK_APPLIED`.

When `EVIDENCE_BUCKET` is set, each record is also written to Amazon S3 with Object Lock
(WORM) for long-term, immutable retention.

Before any mutation the connector captures a **snapshot** of the resource's prior state. An
admin can restore it:

```bash
curl -X POST "$ApiEndpoint/rollback" -H "Authorization: <ADMIN_ID_TOKEN>" \
  -H 'Content-Type: application/json' \
  -d '{"resourceArn":"arn:aws:s3:::acme-data"}'   # most recent snapshot, or pass snapshotSK
```

---

## Operations

### Durable, retried enforcement

Decisions are processed from an SQS queue by the enforcer Lambda, which is configured with
`ReportBatchItemFailures`. The function returns a `batchItemFailures` list so only the
messages that failed are retried, rather than the whole batch. After `maxReceiveCount`
attempts a message moves to the dead-letter queue (DLQ). See
[Handling errors for an SQS event source in Lambda](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-errorhandling.html)
and [Reporting batch item failures](https://docs.aws.amazon.com/lambda/latest/dg/example_serverless_SQS_Lambda_batch_item_failures_section.html).

### Monitoring

- A CloudWatch alarm fires when the DLQ is non-empty (a decision could not be enforced after
  retries). Inspect the DLQ message, fix the cause, and redrive.
- Each function emits structured JSON logs (`level`, `code`, contextual fields) to CloudWatch
  Logs. Useful codes: `ENFORCEMENT_FAILED`, `DISCOVERY_COMPLETE`, `EMAIL_SEND_FAILED`,
  `REVIEW_STATUS_UPDATE_FAILED`.
- A decision stuck in `PENDING`/`IN_PROGRESS` indicates the enforcer has not yet (or could
  not) process it; check the enforcer logs and the DLQ.

---

## Security and least privilege

Each Lambda assumes a role scoped to only the actions it performs:

| Function | Key permissions |
|---|---|
| `recert-api` | DynamoDB read/write; SQS `SendMessage`; invoke discovery; (rollback) S3/IAM restore + `sts:AssumeRole`. |
| `recert-discovery` | `tag:GetResources`; S3/IAM read; DynamoDB write; invoke notifier; `sts:AssumeRole`. |
| `recert-enforcer` | DynamoDB read/write; S3 policy/ACL/PAB; IAM detach/attach/group/key for users and roles; `sts:AssumeRole`; (optional) S3 `PutObject` to the evidence bucket. |
| `recert-notifier` | DynamoDB read; SES `SendEmail`. |

For cross-account enforcement, deploy `VIGILCrossAccountRole` in each member account; the
engine assumes it with a 15-minute session. Enforcement is always **scoped to the target
resource** — the engine prefers a resource-side explicit `Deny` over mutating a principal's
IAM identity.

---

## Configuration reference

| Variable | Required | Purpose |
|---|---|---|
| `TABLE_NAME` | yes | DynamoDB single-table store. |
| `ENFORCEMENT_QUEUE_URL` | yes | SQS queue the API enqueues decisions to. |
| `EVIDENCE_BUCKET` | no | S3 Object Lock (WORM) bucket for evidence mirroring. |
| `SES_SENDER_EMAIL` | yes | Verified SES sender for owner emails. |
| `UI_BASE_URL` | yes | Base URL used in email deep links. |
| `RECERT_DEADLINE_DAYS` | no (14) | Review window in days. |
| `MANAGEMENT_ACCOUNT_ID` | no | Resolved from STS at runtime if unset. |
| `CROSS_ACCOUNT_ROLE_NAME` | no (`VIGILCrossAccountRole`) | Role assumed in member accounts. |
| `DISCOVERY_FUNCTION` / `NOTIFIER_FUNCTION` | set by template | Function names for async invocation. |

---

## Testing

```bash
cd engine
node --test tests/connectors.test.mjs
```

Tests inject fake AWS clients (no network) and assert the correctness invariants: scoped
revoke (no over-broad detach), scoped modify, full revoke, S3 statement/ACL partials, IAM
user/role partials, and idempotent enforcement (a second run is a verified no-op).

---

## Cleanup

```bash
cd engine
sam delete --stack-name recert-engine-dev
```

The DynamoDB table and (if enabled) the evidence bucket are retained on stack deletion. WORM
evidence objects cannot be deleted until their Object Lock retention period expires.

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Discovery finds no resources | The resource is not tagged `owner=…`, or the Tagging API has not yet indexed a newly tagged resource (wait a few minutes). |
| Owner sees no reviews | They are not the `owner` tag value, or the cycle is still `INITIATING` (discovery in progress). |
| Decision stays `PENDING` | The enforcer has not processed it yet, or it errored — check enforcer logs and the DLQ. |
| Decision is `TICKETED` | The resource type has no connector, or the change could not be automated safely. Action the ticket manually or add a connector. |
| API returns 401/403 | Missing/expired Cognito token, or an admin-only endpoint called without the `admin` group. |
| Email not delivered | `SES_SENDER_EMAIL` not verified, or SES is in sandbox (verify recipients). |

---

## Related AWS documentation

- [Control access to REST APIs using Amazon Cognito user pools as an authorizer](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-integrate-with-cognito.html)
- [Handling errors for an Amazon SQS event source in Lambda](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-errorhandling.html)
- [Reporting batch item failures for Lambda functions with an Amazon SQS trigger](https://docs.aws.amazon.com/lambda/latest/dg/example_serverless_SQS_Lambda_batch_item_failures_section.html)
- [Resource Groups Tagging API](https://docs.aws.amazon.com/resourcegroupstagging/latest/APIReference/overview.html)
- [Locking objects with Amazon S3 Object Lock](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html)
