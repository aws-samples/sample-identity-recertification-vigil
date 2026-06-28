# Contributing

Thanks for contributing to the VIGIL access recertification engine. This guide focuses on the
most common and impactful contribution: **adding a resource connector** so the engine can
automatically enforce decisions for a new AWS resource type. General contribution notes are at
the end.

For architecture and the full reference, see the
[Developer Guide](engine/DEVELOPER_GUIDE.md).

---

## Ways to help

You don't need deep context to make a useful first contribution:

- **Add a resource connector** (the highest-impact path, detailed below). Good targets:
  RDS, Lambda, SNS, SQS, DynamoDB, Secrets Manager. Each is self-contained.
- **Improve docs**: clarify a setup step, fix a typo, or add an example you wish you'd had.
- **Harden an existing connector**: add edge-case tests, tighten an IAM action, improve an
  error message.
- **Try a deployment and report friction**: open an issue describing anything that was
  confusing or broke. Bug reports are genuinely valuable.
- **Pick up a [good first issue](../../issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)**:
  small, scoped tasks tagged for new contributors.

If you're unsure where to start, open an issue describing what you'd like to work on and we'll
point you at the right place.

---

## Development setup

```bash
cd engine
node --test tests/connectors.test.mjs    # run unit tests (no AWS calls; fake clients)
sam validate -t template.yaml --lint     # validate the SAM template
sam build                                 # build before deploy
```

- Node.js 20+ (the Lambda runtime is `nodejs24.x`, which provides AWS SDK v3, so do not bundle
  the SDK).
- Source is ES modules (`.mjs`). Keep modules small and dependency-injectable so they can be
  unit tested without AWS.

---

## What a connector is

A **connector** encapsulates everything the engine needs to enforce recertification decisions
for one resource type. The enforcer never calls AWS resource APIs directly; it calls
connectors. A connector implements four operations:

| Method | Purpose |
|---|---|
| `snapshot(ctx)` | Capture the resource's current access configuration (before-state) for evidence and rollback. |
| `revoke(ctx)` | Remove access, full (resource-level) or per-principal, **scoped to this resource only**. |
| `modify(ctx)` | Remove a *subset* of access. Throw `TicketRequiredError` if it can't be done safely. |
| `rollback(ctx, snapshot)` | Restore the resource to a captured snapshot. |

Connectors extend `BaseConnector` (`src/connectors/base-connector.mjs`).

---

## Connector rules (read before writing one)

These rules are what make the engine safe and auditable. A connector **must**:

1. **Stay scoped.** A revoke/modify may only affect the **target resource**. Never widen the
   blast radius. In particular, when access is granted through a principal's IAM identity
   (not the resource), do **not** mutate the principal's IAM policies; add a resource-side
   scoped explicit `Deny` (see the S3 connector for the pattern), or raise
   `TicketRequiredError`.
2. **Never silently no-op.** If a change cannot be applied safely or the type/shape isn't
   supported, throw `TicketRequiredError(reason)` so the engine records a `TICKETED` decision
   for manual action. Do not return success without doing anything.
3. **Snapshot before mutating.** `snapshot(ctx)` must return a serializable before-state that
   `rollback(ctx, snapshot)` can fully restore (note any irreversible exceptions in the result
   `note`).
4. **Use injected clients.** Use `ctx.clients` (already scoped to the resource's account).
   Never construct your own credentials or clients inside the connector; this keeps it
   unit-testable and cross-account-safe.
5. **Return a structured result.** `{ applied: boolean, actions: string[], note?: string }`.
   `actions` is recorded verbatim in the evidence trail, so make it human-meaningful (e.g.
   `DetachRolePolicy:arn:aws:iam::aws:policy/...`).
6. **Be idempotent-friendly.** The enforcer guarantees a decision is processed once, but write
   your operations so a re-run would not corrupt state (prefer declarative puts/removes).

---

## Context and result shapes

```js
// EnforcementContext (ctx)
{
  resourceArn,        // target resource ARN
  resourceType,       // e.g. 'sns:topic'
  principalArn,       // set for per-principal decisions
  accessSource,       // BUCKET_POLICY | IAM_POLICY | IAM_GROUP | ACL (per-principal)
  accessInfo,         // access config captured at discovery (avoids re-fetch)
  changes,            // for MODIFY, e.g. { removeActions: [...] } / { removePolicies: [...] }
  accountId,          // account the resource lives in
  clients,            // AWS SDK clients scoped to accountId
}

// EnforcementResult
{ applied: true, actions: ['...'], note: 'optional' }
```

---

## Add a connector: step by step

### 1. Implement it

Create `src/connectors/<service>-connector.mjs`:

```js
import { BaseConnector, TicketRequiredError } from './base-connector.mjs';

export class SnsConnector extends BaseConnector {
  static get resourceTypes() { return ['sns:topic']; }
  static get capabilities() { return { revoke: true, modify: true, perPrincipal: true, rollback: true }; }

  async snapshot(ctx) { /* read + return serializable before-state via ctx.clients */ }
  async revoke(ctx)   { /* scoped removal; return { applied, actions } */ }
  async modify(ctx)   { /* remove subset; throw TicketRequiredError if unsafe */ }
  async rollback(ctx, snapshot) { /* restore; return { applied, actions } */ }
}
```

### 2. Register it

Add it to `src/connectors/registry.mjs`:

```js
import { SnsConnector } from './sns-connector.mjs';
const CONNECTORS = [S3Connector, IamConnector, IamRoleConnector, SnsConnector];
```

### 3. Grant least-privilege permissions

Add only the API actions your connector calls to the **enforcer** role in `template.yaml`
(`RecertEnforcerFunction`). If discovery needs to enrich the new type, add read-only actions to
`RecertDiscoveryFunction` too.

### 4. Add tests

Add cases to `tests/connectors.test.mjs` using a **fake client** (no network) that records the
commands sent. Assert the scoped-enforcement invariants for your type, e.g. that `revoke`
only touches the target resource and `modify` removes exactly the selected items. Run:

```bash
node --test tests/connectors.test.mjs
```

### 5. Document it

Update the connector tables in [`engine/DEVELOPER_GUIDE.md`](engine/DEVELOPER_GUIDE.md) and
[`RUNBOOK.md`](RUNBOOK.md), and add the resource type to the data-flow notes if relevant.

---

## Pull request checklist

- [ ] Connector stays **scoped** to the target resource (no broad IAM/identity mutation).
- [ ] Unsafe/unsupported paths throw `TicketRequiredError` (no silent no-ops).
- [ ] `snapshot` + `rollback` round-trip the before-state (note any exceptions).
- [ ] Registered in `registry.mjs`.
- [ ] Least-privilege IAM actions added to the enforcer (and discovery, if needed).
- [ ] Unit tests added and `node --test tests/connectors.test.mjs` passes.
- [ ] `sam validate -t template.yaml --lint` passes.
- [ ] Docs updated (Developer Guide + Runbook tables).

---

## General contribution

- Keep functions small and pure where possible; pass dependencies in so they can be tested
  without AWS.
- Use the structured logger (`lib/http.mjs` `log(level, code, fields)`); avoid `console.log`
  with free-form strings.
- Do not commit secrets, build artifacts (`engine/.aws-sam/`), or `node_modules/`.
- For anything that changes how permissions are enforced, include tests that prove the change
  is scoped and reversible.
- Open an issue to discuss significant changes before sending a large PR.

### Security

If you discover a security issue, do not open a public issue. Follow your organization's
responsible-disclosure process.
