# VIGIL - Vigilant Identity Governance & Intelligence Layer

A lightweight, serverless identity governance solution built entirely on native AWS services. VIGIL provides immutable user lifecycle audit trails, proof of user deletion synchronization between external IdPs and AWS, user activity tracking, and quarterly access recertification workflows - all designed for Indian compliance requirements (MCA Rule 11(g), BSA 2023, DPDP Act 2023).

---

## Architecture Overview

VIGIL is a single-account serverless application deployed via AWS SAM. It uses a single DynamoDB table (single-table design), 10 Lambda functions, API Gateway with Cognito authorization, S3 with Object Lock for tamper-proof evidence storage, and EventBridge for scheduling and event routing. The UI is a React 18 SPA served from S3.

```
+-------------------------------------------------------------------------+
|                         AWS Management Account                          |
|                                                                         |
|  +----------+    +--------------+    +------------------------------+   |
|  |  React   |--->| API Gateway  |--->|       Lambda Functions       |   |
|  |  UI (S3) |    |  + Cognito   |    |  +--------+ +------------+  |   |
|  +----------+    |  Authorizer  |    |  | Audit  | |  Recert    |  |   |
|                  +--------------+    |  | Writer | | Initiator  |  |   |
|                                      |  +--------+ +------------+  |   |
|  +----------+    +--------------+    |  | Audit  | |  Recert    |  |   |
|  |CloudTrail|--->| EventBridge  |--->|  | Query  | | Processor  |  |   |
|  +----------+    |  + Scheduler |    |  +--------+ +------------+  |   |
|                  +--------------+    |  |Activity| |  Recert    |  |   |
|                                      |  |Tracker | | Notifier   |  |   |
|  +----------+                        |  +--------+ +------------+  |   |
|  | Cognito  |                        |  |  Sync  | |  Evidence  |  |   |
|  |UserPool  |                        |  |Reconcl.| |  Archiver  |  |   |
|  +----------+                        |  +--------+ +------------+  |   |
|                                      +------------------------------+   |
|                                                |                        |
|                          +--------------------+--------------------+    |
|                          v                    v                    v    |
|                  +--------------+    +--------------+    +---------+    |
|                  |   DynamoDB   |    |  S3 Evidence |    |   SES   |    |
|                  | Single-Table |    | (Object Lock)|    | (Email) |    |
|                  +--------------+    +--------------+    +---------+    |
|                                                                         |
+-------------------------------------------------------------------------+
|                    AWS Organizations (Phase 2)                           |
|  +-------------+  +-------------+  +-------------+                     |
|  |  Member Acct|  |  Member Acct|  |  Member Acct|  <- StackSet        |
|  |  (VIGIL    |  |  (VIGIL    |  |  (VIGIL    |    deploys            |
|  |   Role)    |  |   Role)    |  |   Role)    |    cross-account      |
|  +-------------+  +-------------+  +-------------+    IAM roles        |
+-------------------------------------------------------------------------+
```

---

## Prerequisites

### Tools Required

- AWS CLI v2
- AWS SAM CLI v1.100+
- Node.js 20.x
- npm 10+

### IAM Permissions Required by Deployer

The IAM user/role running the deploy script needs the following permissions:

| Service | Permissions | Purpose |
|---------|-------------|---------|
| **CloudFormation** | Full access (`cloudformation:*`) | Create/update/delete stacks |
| **S3** | `s3:CreateBucket`, `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`, `s3:PutBucketPolicy`, `s3:PutPublicAccessBlock`, `s3:PutBucketWebsite` | SAM artifacts + UI hosting + evidence bucket |
| **Lambda** | `lambda:CreateFunction`, `lambda:UpdateFunctionCode`, `lambda:UpdateFunctionConfiguration`, `lambda:AddPermission`, `lambda:DeleteFunction`, `lambda:GetFunction`, `lambda:InvokeFunction` | Create/update Lambda functions |
| **API Gateway** | `apigateway:*` | Create/manage REST APIs, stages, deployments |
| **DynamoDB** | `dynamodb:CreateTable`, `dynamodb:DescribeTable`, `dynamodb:UpdateTable`, `dynamodb:TagResource` | Create governance table |
| **Cognito** | `cognito-idp:CreateUserPool`, `cognito-idp:CreateUserPoolClient`, `cognito-idp:CreateGroup`, `cognito-idp:AdminCreateUser`, `cognito-idp:AdminAddUserToGroup` | Create user pool + admin users |
| **IAM** | `iam:CreateRole`, `iam:PutRolePolicy`, `iam:AttachRolePolicy`, `iam:PassRole`, `iam:CreatePolicy`, `iam:DeleteRole`, `iam:DeletePolicy` | Lambda execution roles, scheduler role |
| **CloudFront** | `cloudfront:CreateDistribution`, `cloudfront:CreateInvalidation`, `cloudfront:ListDistributions` | UI CDN (optional) |
| **SES** | `ses:VerifyEmailIdentity`, `ses:SendEmail` | Email notifications |
| **EventBridge Scheduler** | `scheduler:CreateSchedule`, `scheduler:UpdateSchedule`, `scheduler:DeleteSchedule` | Cron jobs for reconciliation, recert |
| **CloudTrail** | `cloudtrail:CreateTrail`, `cloudtrail:PutEventSelectors`, `cloudtrail:StartLogging` | Audit event capture |
| **Organizations** | `organizations:ListAccounts`, `organizations:ListRoots` | StackSet deployment targets |
| **CloudFormation StackSets** | `cloudformation:CreateStackSet`, `cloudformation:CreateStackInstances`, `cloudformation:DescribeStackSet` | Cross-account role deployment |
| **SSM Parameter Store** | `ssm:PutParameter`, `ssm:GetParameter` | IdP configuration secrets |
| **STS** | `sts:GetCallerIdentity`, `sts:AssumeRole` | Account ID lookup, cross-account |

---

## Quick Start

```bash
# Deploy everything with defaults (profile=default, region=us-east-1, stage=dev)
./scripts/deploy.sh

# Or specify parameters
./scripts/deploy.sh my-profile us-east-1 prod
```

The script is idempotent - safe to run multiple times.

---

## Configuration

### Environment Variables (UI)

Edit `ui/.env` after deployment:

```env
VITE_API_URL=https://xxxxxxxx.execute-api.us-east-1.amazonaws.com/dev
VITE_COGNITO_USER_POOL_ID=us-east-1_XXXXXXXXX
VITE_COGNITO_CLIENT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxx
VITE_REGION=us-east-1
```

### SAM Configuration (`samconfig.toml`)

```toml
[default.deploy.parameters]
stack_name = "identity-governance-dev"
resolve_s3 = true
region = "us-east-1"
capabilities = "CAPABILITY_IAM CAPABILITY_NAMED_IAM"
parameter_overrides = "Stage=dev"
```

### Template Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `Stage` | `dev` | Deployment stage (dev/staging/prod) |
| `SesSenderEmail` | `noreply@example.com` | Verified SES sender email |
| `RecertDeadlineDays` | `14` | Days to complete recertification |
| `ReconciliationGraceHours` | `1` | Grace period before flagging orphans |
| `IdentityStoreId` | (empty) | IAM Identity Center store ID |

---

## Multi-Account Setup (StackSet)

VIGIL uses a CloudFormation StackSet to deploy a cross-account IAM role (`VIGILCrossAccountRole`) to all member accounts in your AWS Organization. This role allows the management account's Lambda functions to:

- **Discover** IAM users, S3 buckets, and resources in member accounts
- **Revoke** access (disable access keys, detach policies, modify bucket policies)
- **Audit** CloudTrail events across accounts

### How It Works

1. The StackSet uses `SERVICE_MANAGED` permission model (no manual role setup)
2. Auto-deployment is enabled - new accounts automatically get the role
3. The role trusts only the management account (`sts:AssumeRole`)
4. Deployed to the root OU, covering all member accounts

### Manual StackSet Deployment

```bash
# Get your account ID
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# Get root OU
ROOT_OU_ID=$(aws organizations list-roots --query "Roots[0].Id" --output text)

# Create StackSet
aws cloudformation create-stack-set \
  --stack-set-name VIGILCrossAccountRole \
  --template-body file://stackset-templates/cross-account-role.yaml \
  --parameters ParameterKey=ManagementAccountId,ParameterValue=$ACCOUNT_ID \
  --permission-model SERVICE_MANAGED \
  --auto-deployment Enabled=true,RetainStacksOnAccountRemoval=false \
  --capabilities CAPABILITY_NAMED_IAM

# Deploy to all accounts
aws cloudformation create-stack-instances \
  --stack-set-name VIGILCrossAccountRole \
  --deployment-targets OrganizationalUnitIds=$ROOT_OU_ID \
  --regions us-east-1 \
  --operation-preferences FailureTolerancePercentage=100,MaxConcurrentPercentage=100
```

---

## Login Credentials

After deployment, create an admin user:

```bash
# Create user
aws cognito-idp admin-create-user \
  --user-pool-id <POOL_ID> \
  --username admin@yourcompany.com \
  --user-attributes Name=email,Value=admin@yourcompany.com \
  --temporary-password "TempPass123!"

# Add to admin group
aws cognito-idp admin-add-user-to-group \
  --user-pool-id <POOL_ID> \
  --username admin@yourcompany.com \
  --group-name admin
```

### User Groups

| Group | Role | Access |
|-------|------|--------|
| `admin` | System administrator | Full access, cycle management, system config |
| `auditor` | Compliance auditor | Read-only audit trails, export, evidence |
| `manager` | People manager | Recertification reviews for their reports |
| `owner` | Resource owner | Recertification reviews for owned resources |
| `designated_leader` | Escalation target | Receives escalated reviews |

---

## Cost Estimate

For an organization with ~1,000 identities:

| Service | Monthly Cost |
|---------|-------------|
| Lambda (10 functions, low invocation) | ~$2 |
| DynamoDB (on-demand, ~100K items) | ~$5 |
| API Gateway (~50K requests/month) | ~$2 |
| S3 (evidence + UI hosting) | ~$3 |
| Cognito (50 admin users) | Free tier |
| EventBridge (schedulers + events) | ~$1 |
| SES (email notifications) | ~$1 |
| CloudTrail (management events) | Free (1 trail) |
| **Total** | **~$15–25/month** |

Costs scale linearly. At 5,000 identities: ~$50–75/month.

---

## Project Structure

```
|-- template.yaml              # SAM template (all infrastructure)
|-- samconfig.toml             # SAM deployment configuration
|-- package.json               # Backend dependencies
|-- scripts/
|   |-- deploy.sh              # One-command deploy
|   |-- seed-data.mjs          # Seed test data
|   |-- seed-real-data.mjs     # Seed production-like data
|-- src/
|   |-- functions/             # 10 Lambda functions
|   |   |-- audit-writer/      # Lifecycle event capture
|   |   |-- audit-query/       # Auditor API endpoints
|   |   |-- evidence-archiver/ # DynamoDB Streams -> S3
|   |   |-- activity-tracker/  # Login/activity tracking
|   |   |-- stats-aggregator/  # Dashboard statistics
|   |   |-- sync-reconciler/   # IdP reconciliation
|   |   |-- recert-initiator/  # Recertification cycle start
|   |   |-- recert-processor/  # Decision processing
|   |   |-- recert-notifier/   # Email notifications
|   |   |-- bulk-import-scanner/ # Backfill missing records
|   |-- shared/                # Shared utilities
|       |-- identity-adapters/ # Pluggable IdP adapters
|       |-- idp-adapters/      # External IdP adapters (Okta, Entra)
|       |-- dynamo-client.mjs
|       |-- crypto-utils.mjs   # Hash chain utilities
|       |-- models.mjs
|-- stackset-templates/
|   |-- cross-account-role.yaml  # StackSet template for member accounts
|-- ui/                        # React 18 + Vite SPA
|   |-- src/
|       |-- pages/             # Dashboard, UserSearch, Recert, Admin
|       |-- components/        # Shared UI components
|-- tests/
    |-- unit/                  # Node.js built-in test runner
```

---

## Development

```bash
# Run unit tests
npm test

# Run SAM locally
sam local start-api

# Build and deploy
sam build --parallel && sam deploy

# Seed test data
node scripts/seed-data.mjs
```

---

## Compliance

VIGIL implements a three-layer cryptographic evidence chain:

1. **CloudTrail Digest Chain** - SHA-256 hashing with RSA signing, hourly digests
2. **DynamoDB Append-Only Hash Chain** - Each record references the SHA-256 hash of its predecessor
3. **S3 Object Lock (Compliance Mode)** - WORM storage, 8-year retention

This satisfies:
- **MCA Rule 11(g)** - 8-year tamper-proof audit trail
- **BSA 2023 Section 63** - Electronic evidence admissibility
- **DPDP Act 2023** - Purpose-based retention with statutory override
- **CERT-In** - Incident reporting guidelines
- **RBI Cybersecurity Framework** - For fintech contexts

---

## License

Proprietary. Internal use only.
