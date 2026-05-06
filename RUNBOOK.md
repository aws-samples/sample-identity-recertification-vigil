# VIGIL Runbook

This document explains how VIGIL works under the hood. It is written for engineers who want to understand the system deeply enough to build their own version or extend this one.

---

## Table of Contents

1. [Recertification Engine](#recertification-engine)
2. [User Lifecycle Audit Trail](#user-lifecycle-audit-trail)
3. [Multi-Account Architecture](#multi-account-architecture)
4. [Evidence Chain and Tamper-Proofing](#evidence-chain-and-tamper-proofing)
5. [Revocation Engine](#revocation-engine)
6. [DynamoDB Data Model](#dynamodb-data-model)
7. [Deployment and Operations](#deployment-and-operations)

---

## Recertification Engine

The recertification engine is the core of VIGIL. It answers the question: "Does this person still need access to this resource?" It runs on a quarterly schedule (configurable) and can also be triggered manually for ad-hoc reviews.

### How a Cycle Works

A recertification cycle has five phases:

**Phase 1: Resource Discovery**

The `recert-initiator` Lambda uses the AWS Resource Groups Tagging API to discover all tagged resources in the account. Every resource that has an `owner` tag is included. The owner tag value is an email address that maps to the person responsible for reviewing access to that resource.

Resources without an `owner` tag are flagged as "unowned" and surfaced in the Admin Console for manual assignment.

Discovery happens per-account. In multi-account mode, the initiator iterates through all registered member accounts, assumes a cross-account role, and runs the same Tagging API calls in each one.

**Phase 2: Access Discovery**

For each discovered resource, VIGIL determines WHO has access and HOW they got it. This uses two data sources in parallel:

1. **IAM Policy Simulator** - Evaluates every IAM user in the account against the resource ARN. For each user, it calls `SimulatePrincipalPolicy` with the resource's relevant actions (e.g., s3:GetObject, s3:PutObject for S3 buckets). Users with at least one allowed action are included.

2. **CloudTrail Lookup** - Queries CloudTrail for actual access events against the resource in the last 90 days. This catches principals who accessed the resource historically but may no longer have policy-based access.

3. **Bucket Policy Extraction** (S3 only) - Parses the bucket policy JSON to extract principals referenced in Allow statements. For service principals, it also reads the Condition block to find `aws:SourceArn` and derives a friendly name (e.g., "Lambda: my-function-name").

These three sources are merged into a unified `accessEntries` array per resource. Each entry contains: principalArn, principalName, principalType (IAM_USER, IAM_ROLE, AWS_SERVICE, AWS_ACCOUNT), accessSource, permissions list, and last-accessed timestamp.

**Phase 3: Review Item Creation**

For each resource, a review item is written to DynamoDB under the owner's partition key: `OWNER#{ownerEmail}` / `RECERT_ITEM#{cycleId}#{resourceArn}`. The review item contains the full accessEntries array, resource metadata, and a deadline.

The cycle summary is also written: `CYCLE#{cycleId}` / `SUMMARY` with total counts, deadline, and status.

**Phase 4: Owner Review**

Resource owners log into the UI and see their pending reviews. For each resource, they see every principal with access and can make per-principal decisions:

- **CERTIFIED** - Access is appropriate, keep it
- **REVOKED** - Access should be removed
- **MODIFIED** - Access needs adjustment (partial revocation)

Decisions are immutable. Once submitted for a principal+cycle combination, they cannot be changed. This is enforced by a conditional write: `ConditionExpression: 'attribute_not_exists(PK)'` on the decision audit record.

**Phase 5: Revocation Execution**

When an owner revokes access, the system attempts automated revocation for supported resource types (S3 buckets, IAM users). For unsupported types, it creates a revocation ticket for IT admin manual action.

### Scheduling and Notifications

- Cycle initiation: EventBridge Scheduler, quarterly (configurable cron)
- Reminder at day 7: EventBridge Scheduler triggers `recert-notifier`
- Reminder at day 12: Same
- Escalation at day 14 (deadline): Overdue items are escalated to admin

### Ad-Hoc Cycles

Admins can trigger ad-hoc cycles scoped to:
- ALL resources
- A specific owner (OWNER scope)
- Specific resource ARNs (RESOURCES scope)

Ad-hoc cycles use the same machinery but get a different cycleId format: `{year}-ADHOC-{timestamp}`.

### Deadline Extensions

Owners can request a one-time 7-day extension per cycle. The extension is recorded as an immutable record and all their review items get updated deadlines.

### Transfer of Reviews

If an owner leaves or is unavailable, an admin can transfer their pending reviews to another owner. This moves the review items to the new owner's partition key.

---

## User Lifecycle Audit Trail

The audit trail captures every identity lifecycle event with legal-grade immutability. It answers: "When was user X created, modified, disabled, or deleted, and by whom?"

### Event Sources

1. **Cognito PostConfirmation Trigger** - Fires on user signup. The `audit-writer` Lambda captures the creation event immediately, including identity source (local signup vs JIT federation).

2. **CloudTrail via EventBridge** - EventBridge rules route Cognito CloudTrail events (AdminUpdateUserAttributes, AdminDeleteUser, AdminDisableUser, AdminCreateUser) to the audit-writer. Each event is mapped to a lifecycle type: CREATED, MODIFIED, DELETED, DISABLED.

3. **SCIM Events** - Identity Center SCIM provisioning events (CreateUser, UpdateUser, DeleteUser) from external IdPs (Entra ID, Okta) are captured via CloudTrail. The audit-writer extracts the userId from the `onBehalfOf` element in the CloudTrail record.

### Immutability Guarantees

Every audit record is written with `ConditionExpression: 'attribute_not_exists(PK)'` to prevent overwrites. The DynamoDB table has an IAM policy that denies UpdateItem and DeleteItem on records with `USER#` prefix keys. This means once written, an audit record cannot be modified or deleted by any user, including the root account (at the IAM level).

### Deletion Proof

When a SCIM DeleteUser event is captured, the audit-writer creates a DELETION_PROOF record. This record contains:
- The source timestamp (when the IdP deleted the user)
- The capture timestamp (when VIGIL recorded it)
- The CloudTrail event ID (for cross-reference)
- A SHA-256 proof hash covering all fields

This proof is also archived to S3 with Object Lock, making it legally admissible evidence that the deletion occurred and was recorded.

### Re-provisioning Detection

If a previously deleted user's email is re-used for a new account, the audit-writer detects this by querying the EMAIL lookup records. It creates a new governance ID, links it to the previous one, and raises an admin alert for review.

---

## Multi-Account Architecture

VIGIL supports governing identities across an AWS Organization. The management account runs the VIGIL stack, and member accounts get a cross-account IAM role deployed via CloudFormation StackSet.

### Cross-Account Role

The StackSet template (`stackset-templates/cross-account-role.yaml`) deploys a role called `VIGILCrossAccountRole` to each member account. This role trusts the management account and grants read-only access to:
- Resource Groups Tagging API (resource discovery)
- IAM (user enumeration, policy listing)
- S3 (bucket policy, ACL, public access block reads)
- CloudTrail (access history lookup)

For revocation, the role also grants write access to S3 bucket policies and IAM user modifications.

### How Cross-Account Calls Work

1. The `recert-initiator` calls `sts:AssumeRole` on `arn:aws:iam::{memberAccountId}:role/VIGILCrossAccountRole`
2. It gets temporary credentials (15-minute session)
3. It creates a new SDK client with those credentials
4. All API calls to that member account use the temporary client

This is handled by `src/shared/cross-account-credentials.mjs` which wraps the STS call with structured error logging.

### Account Registry

Member accounts are stored in DynamoDB: `ACCOUNT#{accountId}` / `METADATA`. The admin can sync accounts from AWS Organizations via the `/admin/accounts/sync` API endpoint, which calls `organizations:ListAccounts` and upserts the results.

### Per-Account Scanning

Each account can be scanned individually via `/admin/accounts/{accountId}/scan`. This discovers resources in that specific account and returns them without creating review items (useful for previewing before a cycle).

### Fail-Forward Design

If a cross-account AssumeRole fails (role not deployed, permissions issue), the initiator logs the error and continues to the next account. One failed account does not block the entire cycle.

---

## Evidence Chain and Tamper-Proofing

VIGIL uses a three-layer evidence chain designed to satisfy Indian compliance requirements (MCA Rule 11(g) requires 8-year tamper-proof audit trails).

### Layer 1: CloudTrail Digest Chain

AWS CloudTrail creates hourly digest files. Each digest contains SHA-256 hashes of all log files delivered in that hour, plus the digital signature of the previous digest. This forms a verifiable chain maintained by AWS itself. VIGIL does not manage this layer - it relies on CloudTrail being enabled with log file validation.

### Layer 2: DynamoDB Hash Chain

Every audit record written by VIGIL includes an `evidenceHash` field. This is a SHA-256 hash computed over the record's identity-critical fields (userId, eventType, timestamp, metadata). The hash function is in `src/shared/crypto-utils.mjs`.

For deletion proofs, a separate `proofHash` is computed that covers the userId, source timestamp, capture timestamp, CloudTrail event ID, and source event type.

### Layer 3: S3 Object Lock

The `evidence-archiver` Lambda is triggered by DynamoDB Streams. When a new lifecycle event is inserted, it:
1. Serializes the record to JSON
2. Computes a SHA-256 hash of the serialized content
3. Writes it to S3 with Object Lock (Compliance mode, 8-year retention)
4. Updates the DynamoDB record with the evidence hash and S3 key

Object Lock in Compliance mode means the object cannot be deleted or overwritten by anyone - including the root account - until the retention period expires.

### Metadata Overflow

If a serialized record exceeds 300KB, the archiver splits the metadata into a separate S3 object and stores a reference in the main evidence file. This handles edge cases where CloudTrail events have large request/response payloads.

---

## Revocation Engine

The revocation engine handles automated access removal for supported resource types and creates manual tickets for everything else.

### Supported Automated Revocations

**S3 Buckets (Full Revocation):**
1. Delete the bucket policy
2. Enable Public Access Block (all four settings)
3. Reset ACL to private (owner-only)

**S3 Buckets (Partial Revocation):**
- Remove specific policy statements by Sid
- Remove specific ACL grants by grantee URI/ID
- Enable Public Access Block only

**IAM Users (Full Revocation):**
1. Detach all managed policies
2. Remove from all groups
3. Deactivate all active access keys

**IAM Users (Partial Revocation):**
- Detach specific managed policies by ARN
- Remove from specific groups by name
- Deactivate specific access keys by ID

### State Snapshots

Before any modification, the revocation handler captures a full state snapshot of the resource's current access configuration. This snapshot is stored in DynamoDB as a `REVOCATION_SNAPSHOT` record and includes:
- The complete before-state (bucket policy, ACL, PAB for S3; policies, groups, keys for IAM)
- Whether it was a full or partial revocation
- The partial revoke selections (if applicable)
- An evidence hash

This ensures you can always reconstruct what the resource looked like before revocation.

### Failure Handling

If an automated revocation fails (API error, permissions issue), the handler:
1. Creates a REVOCATION_TICKET for IT admin manual action
2. Updates the review item status to REVOCATION_FAILED
3. Logs the error with full context

The ticket contains the resource ARN, type, cycle ID, owner, reason, and the error that occurred.

### Per-Principal Revocation

In the per-principal model (V2), owners can revoke access for a specific principal to a specific resource. For S3 bucket policies, this means:
- Finding all policy statements that reference the principal
- Removing the principal from those statements
- If a statement has no principals left, removing the entire statement
- If no statements remain, deleting the bucket policy

---

## DynamoDB Data Model

VIGIL uses single-table design. All data lives in one DynamoDB table with composite primary keys.

### Key Structure

- **PK (Partition Key):** `ENTITY_TYPE#identifier` (e.g., `USER#abc123`, `OWNER#alice@example.com`)
- **SK (Sort Key):** `SUB_TYPE#timestamp_or_id` (e.g., `LIFECYCLE#2026-05-04T10:30:00Z`)

### Global Secondary Indexes

- **GSI1:** `GSI1PK` / `GSI1SK` - Used for type-based queries (all events of a certain type, sorted by time)
- **GSI2:** `GSI2PK` / `GSI2SK` - Used for source-based queries (all users from a specific identity source)

### Key Access Patterns

| What you want | PK | SK |
|---|---|---|
| User's full audit trail | USER#{userId} | LIFECYCLE#{timestamp} |
| User's activity log | USER#{userId} | ACTIVITY#{date}#{timestamp} |
| Owner's review items | OWNER#{ownerEmail} | RECERT_ITEM#{cycleId}#{resourceArn} |
| Cycle summary | CYCLE#{cycleId} | SUMMARY |
| All events of a type | GSI1: TYPE#{eventType} | {timestamp} |
| All users by source | GSI2: SOURCE#{source} | {userId} |
| Email to user lookup | EMAIL#{email} | USER#{userId} |
| Resource revocation snapshot | RESOURCE#{resourceArn} | REVOCATION_SNAPSHOT#{timestamp} |

### Immutability Rules

- Records with `USER#` PK prefix: never updated or deleted (IAM policy enforced)
- All writes use `ConditionExpression: 'attribute_not_exists(PK)'` for idempotency
- Recertification decisions are write-once per principal+cycle combination

---

## Deployment and Operations

### Prerequisites

- AWS account with Identity Center enabled (for identity store APIs)
- SAM CLI installed
- Node.js 20.x
- Verified SES sender email (for notifications)
- CloudTrail enabled with management events

### Deploy

```bash
# One-command deploy
./scripts/deploy.sh

# Or manually:
npm install
cd ui && npm install && npx vite build && cd ..
sam build --parallel
sam deploy
```

### Environment Variables (Lambda)

| Variable | Purpose |
|---|---|
| TABLE_NAME | DynamoDB table name |
| EVIDENCE_BUCKET | S3 bucket for evidence archival |
| SES_SENDER_EMAIL | Verified SES sender for notifications |
| COGNITO_USER_POOL_ID | Cognito pool for user enumeration |
| IDENTITY_STORE_ID | Identity Center store ID |
| RECERT_DEADLINE_DAYS | Days to complete review (default: 14) |
| MANAGEMENT_ACCOUNT_ID | Account ID where VIGIL runs |
| DEFAULT_REVIEWER_EMAIL | Fallback reviewer for unowned resources |

### Monitoring

All Lambdas emit structured JSON logs with consistent fields:
- `errorCode` - Machine-readable error identifier
- `message` - Human-readable description
- `function` - Which Lambda emitted it
- `timestamp` - ISO 8601 UTC

Key CloudWatch metrics to watch:
- `audit-writer` invocation errors (missed lifecycle events)
- `evidence-archiver` failures (broken evidence chain)
- `recert-initiator` duration (approaching 15-min timeout with many resources)
- Cross-account AssumeRole failures (StackSet deployment issues)

### Cost Estimate (1000 users, single account)

- DynamoDB: ~$5/month (on-demand, mostly reads)
- Lambda: ~$2/month (infrequent invocations)
- S3: ~$3/month (evidence storage, grows over time)
- EventBridge: negligible
- API Gateway: ~$3/month
- SES: ~$1/month
- Total: ~$15-25/month

---

## Key Design Decisions

**Why single-table DynamoDB?**
One table means one set of IAM policies, one backup configuration, one set of capacity settings. For a governance system where data integrity matters more than query flexibility, this simplifies operations significantly.

**Why tag-driven ownership?**
Tags are the only universal metadata mechanism across all AWS resource types. By using an `owner` tag, VIGIL works with any resource that supports tagging without needing per-service ownership logic.

**Why Object Lock instead of just DynamoDB immutability?**
DynamoDB immutability is enforced by IAM policy, which can be changed by someone with sufficient privileges. S3 Object Lock in Compliance mode cannot be bypassed by anyone, including root. This satisfies the legal requirement for tamper-proof storage.

**Why automated revocation for S3 and IAM only?**
These are the two resource types where revocation is well-defined and reversible (you can re-attach a policy). For other resources (EC2, RDS, Lambda), "revoking access" is ambiguous and potentially destructive, so a human-in-the-loop ticket is safer.

**Why per-principal decisions instead of per-resource?**
A single S3 bucket might have 10 principals with access. Revoking the entire bucket's access because one principal shouldn't have it is too coarse. Per-principal decisions give owners granular control.
