# Holmes Scan - Exception Justifications

These findings were reviewed and intentionally left as-is. They represent architectural decisions required for the demo to function correctly.

---

## IAM_NO_INLINE_POLICY_CHECK - SchedulerExecutionRole (template.yaml)

**Finding:** Inline policies are present on the SchedulerExecutionRole.

**Justification:** EventBridge Scheduler requires a role with lambda:InvokeFunction permissions. The inline policy is scoped to exactly 5 specific Lambda function ARNs (least-privilege). For a single-template SAM deployment, inline policies keep the template self-contained and avoid circular dependency issues between the role and a separate managed policy resource. This is the standard SAM pattern for scheduler roles.

**Risk:** Low. The policy grants only lambda:InvokeFunction to specific function ARNs.

---

## IAM_NO_INLINE_POLICY_CHECK - VIGILCrossAccountRole (cross-account-role.yaml)

**Finding:** Inline policies are present on the cross-account role.

**Justification:** This role is deployed via CloudFormation StackSet to member accounts. Inline policies keep the StackSet template self-contained in a single file. Using managed policies would require creating separate AWS::IAM::ManagedPolicy resources in each member account, adding deployment complexity without security benefit. The policies are already split by function (read vs revocation) with explicit Sid labels.

**Risk:** Low. The template is the single source of truth for what the role can do.

---

## CKV_AWS_107 - Credentials Exposure (cross-account-role.yaml)

**Finding:** IAM policy allows credentials exposure (iam:ListAccessKeys).

**Justification:** The recertification engine needs to enumerate IAM access keys to show resource owners which keys are active and to deactivate them during revocation. `iam:ListAccessKeys` is a read-only action that returns key metadata (key ID, status, creation date) but NOT the secret key itself. This is required for the access discovery and revocation workflows to function.

**Risk:** Low. ListAccessKeys does not expose secret key material. It only returns AccessKeyId and Status.

---

## CKV_AWS_109 - Permissions Management Without Constraints (cross-account-role.yaml)

**Finding:** IAM policy allows permissions management actions (DetachUserPolicy, RemoveUserFromGroup, UpdateAccessKey) without resource constraints.

**Justification:** This is the core automated revocation mechanism. When a resource owner revokes access for an IAM user during recertification, the system must be able to detach any policy, remove from any group, and deactivate any key for that user. Constraining to specific ARNs is not feasible because:
1. The role must operate on ANY IAM user in the member account (users are dynamic)
2. Policy ARNs and group names are not known at deploy time
3. The revocation targets are determined at runtime by the resource owner's decision

The role is only assumable by the management account (trust policy), and revocation only executes after an authenticated owner submits a decision through the Cognito-authorized API.

**Risk:** Medium, mitigated by: (a) trust policy limits assumption to management account only, (b) revocation requires authenticated owner decision, (c) state snapshots are captured before any modification, (d) all actions are logged as immutable audit records.

---

## Summary

| Finding | Status | Reason |
|---|---|---|
| DynamoDB KMS encryption | FIXED | Added SSESpecification |
| S3 access logging | FIXED | Added AccessLogsBucket + LoggingConfiguration |
| API Gateway access logging | FIXED | Added CloudWatch log group + AccessLogSetting |
| S3 missing AccessControl | FIXED | Added AccessControl: Private |
| Unsafe dynamic method (JS) | FIXED | Refactored to explicit switch/if-else |
| Inline policy (Scheduler) | ACCEPTED | Standard SAM pattern, least-privilege scoped |
| Inline policy (CrossAccount) | ACCEPTED | StackSet self-containment requirement |
| Credentials exposure | ACCEPTED | ListAccessKeys is read-only, required for access discovery |
| Permissions management | ACCEPTED | Core revocation mechanism, mitigated by trust policy + auth |
