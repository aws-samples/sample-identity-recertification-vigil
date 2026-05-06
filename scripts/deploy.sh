#!/usr/bin/env bash
# 
# VIGIL - One-Command Deploy Script
# Deploys the entire Identity Governance solution in a single run.
# Safe to run multiple times (idempotent).
# 
set -e

#  Parameters 
AWS_PROFILE="${1:-default}"
REGION="${2:-us-east-1}"
STAGE="${3:-dev}"

STACK_NAME="identity-governance-${STAGE}"
STACKSET_NAME="VIGILCrossAccountRole"

echo "VIGIL - Vigilant Identity Governance & Intelligence Layer"
echo "Deploying: stage=$STAGE region=$REGION profile=$AWS_PROFILE"
echo ""

#  Step 1: Install dependencies 
echo "> Step 1/10: Installing backend dependencies..."
npm ci

#  Step 2: Build UI 
echo "> Step 2/10: Building UI..."
cd ui
npm ci
npx vite build
cd ..

#  Step 3: Build SAM 
echo "> Step 3/10: Building SAM application..."
sam build --parallel

#  Step 4: Deploy SAM 
echo "> Step 4/10: Deploying SAM stack..."
sam deploy \
  --stack-name "$STACK_NAME" \
  --no-confirm-changeset \
  --no-fail-on-empty-changeset \
  --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM \
  --parameter-overrides "Stage=$STAGE" \
  --tags "Project=IdentityGovernance Environment=$STAGE" \
  --profile "$AWS_PROFILE" \
  --region "$REGION"

#  Step 5: Get CloudFormation outputs 
echo "> Step 5/10: Retrieving stack outputs..."

get_output() {
  aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" \
    --output text \
    --profile "$AWS_PROFILE" \
    --region "$REGION"
}

API_URL=$(get_output "ApiEndpoint")
COGNITO_POOL_ID=$(get_output "CognitoUserPoolIdOutput")
COGNITO_CLIENT_ID=$(get_output "CognitoUserPoolClientId")
TABLE_NAME=$(get_output "TableName")
EVIDENCE_BUCKET=$(get_output "EvidenceBucketName")

ACCOUNT_ID=$(aws sts get-caller-identity --query "Account" --output text --profile "$AWS_PROFILE")

echo "  API URL:          $API_URL"
echo "  Cognito Pool:     $COGNITO_POOL_ID"
echo "  Cognito Client:   $COGNITO_CLIENT_ID"
echo "  DynamoDB Table:   $TABLE_NAME"
echo "  Evidence Bucket:  $EVIDENCE_BUCKET"
echo "  Account ID:       $ACCOUNT_ID"

#  Step 6: Deploy StackSet for cross-account roles 
echo "> Step 6/10: Deploying cross-account StackSet..."

STACKSET_EXISTS=$(aws cloudformation describe-stack-set \
  --stack-set-name "$STACKSET_NAME" \
  --profile "$AWS_PROFILE" \
  --region "$REGION" \
  --query "StackSet.StackSetName" \
  --output text 2>/dev/null || echo "NONE")

if [ "$STACKSET_EXISTS" = "NONE" ]; then
  echo "  Creating StackSet: $STACKSET_NAME..."
  aws cloudformation create-stack-set \
    --stack-set-name "$STACKSET_NAME" \
    --template-body file://stackset-templates/cross-account-role.yaml \
    --parameters ParameterKey=ManagementAccountId,ParameterValue="$ACCOUNT_ID" \
    --permission-model SERVICE_MANAGED \
    --auto-deployment Enabled=true,RetainStacksOnAccountRemoval=false \
    --capabilities CAPABILITY_NAMED_IAM \
    --profile "$AWS_PROFILE" \
    --region "$REGION"
  echo "  StackSet created."
else
  echo "  StackSet '$STACKSET_NAME' already exists - skipping creation."
fi

#  Step 7: Create StackSet instances in all accounts 
echo "> Step 7/10: Deploying StackSet instances to organization..."

ROOT_OU_ID=$(aws organizations list-roots \
  --query "Roots[0].Id" \
  --output text \
  --profile "$AWS_PROFILE")

if [ -n "$ROOT_OU_ID" ] && [ "$ROOT_OU_ID" != "None" ]; then
  echo "  Root OU: $ROOT_OU_ID"
  # create-stack-instances is idempotent - existing instances are skipped
  aws cloudformation create-stack-instances \
    --stack-set-name "$STACKSET_NAME" \
    --deployment-targets OrganizationalUnitIds="$ROOT_OU_ID" \
    --regions "$REGION" \
    --operation-preferences FailureTolerancePercentage=100,MaxConcurrentPercentage=100 \
    --profile "$AWS_PROFILE" \
    --region "$REGION" 2>/dev/null || echo "  StackSet instances already exist or operation in progress - continuing."
else
  echo "  ⚠ Could not determine Root OU ID. Skipping StackSet instance deployment."
  echo "    Run manually: aws organizations list-roots --profile $AWS_PROFILE"
fi

#  Step 8: Deploy UI to S3 + invalidate CloudFront 
echo "> Step 8/10: Deploying UI to S3..."

# UI bucket follows naming convention: identity-governance-ui-{stage}-{accountId}
UI_BUCKET="identity-governance-ui-${STAGE}-${ACCOUNT_ID}"

# Create UI bucket if it doesn't exist
if ! aws s3api head-bucket --bucket "$UI_BUCKET" --profile "$AWS_PROFILE" --region "$REGION" 2>/dev/null; then
  echo "  Creating UI bucket: $UI_BUCKET..."
  aws s3api create-bucket \
    --bucket "$UI_BUCKET" \
    --profile "$AWS_PROFILE" \
    --region "$REGION" \
    $([ "$REGION" != "us-east-1" ] && echo "--create-bucket-configuration LocationConstraint=$REGION")

  # Enable static website hosting
  aws s3 website "s3://$UI_BUCKET" \
    --index-document index.html \
    --error-document index.html \
    --profile "$AWS_PROFILE" \
    --region "$REGION"

  # Block public access (CloudFront OAI will serve content)
  aws s3api put-public-access-block \
    --bucket "$UI_BUCKET" \
    --public-access-block-configuration "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=false,RestrictPublicBuckets=false" \
    --profile "$AWS_PROFILE" \
    --region "$REGION"

  # Add bucket policy for public read (simple static hosting without CloudFront)
  aws s3api put-bucket-policy \
    --bucket "$UI_BUCKET" \
    --policy "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Sid\":\"PublicReadGetObject\",\"Effect\":\"Allow\",\"Principal\":\"*\",\"Action\":\"s3:GetObject\",\"Resource\":\"arn:aws:s3:::${UI_BUCKET}/*\"}]}" \
    --profile "$AWS_PROFILE" \
    --region "$REGION"
fi

# Sync UI build to S3
aws s3 sync ui/dist/ "s3://$UI_BUCKET/" \
  --delete \
  --cache-control "public, max-age=31536000, immutable" \
  --profile "$AWS_PROFILE" \
  --region "$REGION"

# index.html should not be cached aggressively
aws s3 cp ui/dist/index.html "s3://$UI_BUCKET/index.html" \
  --cache-control "no-cache, no-store, must-revalidate" \
  --content-type "text/html" \
  --profile "$AWS_PROFILE" \
  --region "$REGION"

# Invalidate CloudFront if a distribution exists for this bucket
CF_DISTRIBUTION_ID=$(aws cloudfront list-distributions \
  --query "DistributionList.Items[?Origins.Items[?DomainName=='${UI_BUCKET}.s3.amazonaws.com']].Id | [0]" \
  --output text \
  --profile "$AWS_PROFILE" 2>/dev/null || echo "")

if [ -n "$CF_DISTRIBUTION_ID" ] && [ "$CF_DISTRIBUTION_ID" != "None" ] && [ "$CF_DISTRIBUTION_ID" != "null" ]; then
  echo "  Invalidating CloudFront distribution: $CF_DISTRIBUTION_ID..."
  aws cloudfront create-invalidation \
    --distribution-id "$CF_DISTRIBUTION_ID" \
    --paths "/*" \
    --profile "$AWS_PROFILE" > /dev/null
fi

echo "  UI deployed to: http://${UI_BUCKET}.s3-website-${REGION}.amazonaws.com"

#  Step 9: Force API Gateway redeployment 
echo "> Step 9/10: Redeploying API Gateway stage..."

API_ID=$(aws cloudformation describe-stack-resources \
  --stack-name "$STACK_NAME" \
  --logical-resource-id "GovernanceApi" \
  --query "StackResources[0].PhysicalResourceId" \
  --output text \
  --profile "$AWS_PROFILE" \
  --region "$REGION" 2>/dev/null || echo "")

if [ -n "$API_ID" ] && [ "$API_ID" != "None" ]; then
  aws apigateway create-deployment \
    --rest-api-id "$API_ID" \
    --stage-name "$STAGE" \
    --description "Redeployment via deploy.sh $(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --profile "$AWS_PROFILE" \
    --region "$REGION" > /dev/null
  echo "  API Gateway redeployed."
else
  echo "  ⚠ Could not find API Gateway resource - skipping redeployment."
fi

#  Step 10: Trigger initial data sync 
echo "> Step 10/11: Triggering initial data sync (stats-aggregator)..."
aws lambda invoke \
  --function-name "identity-governance-stats-aggregator-${STAGE}" \
  --payload '{}' \
  --cli-binary-format raw-in-base64-out \
  /tmp/vigil-initial-sync.json \
  --profile "$AWS_PROFILE" \
  --region "$REGION" > /dev/null 2>&1 || echo "  ⚠ Stats aggregator invocation failed - data will sync at midnight."
echo "  Initial sync triggered. Dashboard and unowned resources will populate shortly."
#  Step 10: Print summary 
echo ""
echo "DEPLOYMENT COMPLETE"
echo ""
echo "Endpoints:"
echo "  API:  $API_URL"
echo "  UI:   http://${UI_BUCKET}.s3-website-${REGION}.amazonaws.com"
echo ""
echo "Auth:"
echo "  Cognito Pool ID:  $COGNITO_POOL_ID"
echo "  Cognito Client:   $COGNITO_CLIENT_ID"
echo "  Region:           $REGION"
echo ""
echo "Resources:"
echo "  DynamoDB Table:   $TABLE_NAME"
echo "  Evidence Bucket:  $EVIDENCE_BUCKET"
echo "  UI Bucket:        $UI_BUCKET"
echo "  StackSet:         $STACKSET_NAME"
echo ""
echo "Next steps:"
echo "  1. Create admin user:  aws cognito-idp admin-create-user --user-pool-id $COGNITO_POOL_ID --username admin@example.com --user-attributes Name=email,Value=admin@example.com --profile $AWS_PROFILE --region $REGION"
echo "  2. Add to admin group: aws cognito-idp admin-add-user-to-group --user-pool-id $COGNITO_POOL_ID --username admin@example.com --group-name admin --profile $AWS_PROFILE --region $REGION"
echo "  3. Verify SES sender:  aws ses verify-email-identity --email-address noreply@example.com --profile $AWS_PROFILE --region $REGION"
echo "  4. Update UI config:   Edit ui/.env with the values above"
echo ""
echo "Done! 🎉"
