#!/usr/bin/env bash
#
# seed-github.sh - one-time repo grooming for discoverability + contributor onboarding.
# Sets the repo description and topics, creates a "good first issue" label, and opens a
# small set of scoped starter issues. Requires the GitHub CLI (gh) authenticated with
# write access to the target repo.
#
# Usage:
#   ./seed-github.sh                                  # uses aws-samples repo below
#   REPO=paramanandmallik/VIGIL ./seed-github.sh      # target your fork instead
#
set -euo pipefail

REPO="${REPO:-aws-samples/sample-identity-recertification-vigil}"
echo ">> Target repo: $REPO"

# --- Description + topics (repo SEO) ---
gh repo edit "$REPO" \
  --description "Serverless AWS access recertification engine: discover resources by owner tag, collect keep/trim/revoke decisions, and actually enforce them with scoped changes, hash-chained evidence, and rollback." \
  --add-topic iam \
  --add-topic access-governance \
  --add-topic recertification \
  --add-topic access-review \
  --add-topic cloud-security \
  --add-topic compliance \
  --add-topic serverless \
  --add-topic aws-sam \
  --add-topic lambda \
  --add-topic least-privilege

# --- good first issue label (ignore error if it already exists) ---
gh label create "good first issue" --repo "$REPO" \
  --color 7057ff --description "Small, scoped task suitable for a first-time contributor" 2>/dev/null || true

# --- Starter issues ---
issue() { gh issue create --repo "$REPO" --label "good first issue" --title "$1" --body "$2"; }

issue "Add an SNS topic connector" \
"Implement a connector for \`sns:topic\` so the engine can enforce decisions on SNS topics (today they are ticket-routed).

Scope:
- \`snapshot\`: capture the topic policy.
- \`revoke\`/\`modify\`: remove the principal (or specific actions) from the topic policy, scoped to this topic only.
- \`rollback\`: restore the captured policy.

See CONTRIBUTING.md ('Add a connector: step by step') and the existing \`s3-connector.mjs\` for the pattern. Register in \`registry.mjs\`, add the least-privilege IAM actions to the enforcer, and add a unit test."

issue "Add an SQS queue connector" \
"Implement a connector for \`sqs:queue\` (currently ticket-routed). Mirror the SNS/S3 pattern: snapshot the queue policy, scoped revoke/modify of the principal or actions, and rollback. Add IAM actions to the enforcer and a unit test. See CONTRIBUTING.md."

issue "Add a Secrets Manager connector" \
"Implement a connector for \`secretsmanager:secret\`. Snapshot the resource policy, scoped revoke/modify, rollback. Register, grant least-privilege IAM, add a test. See CONTRIBUTING.md."

issue "Add a 'no resources found' empty state to the discovery run history" \
"In the UI Discovery page (\`ui/src/pages/CyclesAdmin.jsx\`), when a cycle returns 0 resources, show a friendly empty-state message explaining that no resources are tagged \`owner=\` yet, with a one-line hint on how to tag one. Small, self-contained UI task."

issue "Document tagging a resource for discovery" \
"Add a short 'Tag a resource' subsection to the README quick start showing the exact CLI to add an \`owner=<email>\` tag to an S3 bucket / EC2 instance, so first-time users can produce a non-empty cycle. Docs-only."

echo ""
echo ">> Done. Verify at: https://github.com/$REPO  (About panel + Issues tab)"
