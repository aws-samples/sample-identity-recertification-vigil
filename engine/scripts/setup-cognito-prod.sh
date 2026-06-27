#!/usr/bin/env bash
#
# setup-cognito-prod.sh — provision a hardened production Cognito user pool for
# the Recertification Engine, then print the User Pool ARN to pass to the SAM
# deploy via the CognitoUserPoolArn parameter.
#
# Hardening applied:
#   - MFA required (TOTP / authenticator app)
#   - Advanced security ENFORCED (compromised-credential + risk detection)
#   - SRP-only auth (NO admin/password flows) on the app client
#   - 14-char complex password policy, short token lifetimes
#   - Admin-only user creation (no self sign-up), user-existence errors masked
#
# Usage:
#   ./setup-cognito-prod.sh \
#       --region us-east-1 \
#       --pool-name recert-engine-prod \
#       --admin-email security-admin@yourcompany.com \
#       [--profile <aws-cli-profile>]
#
# Safe to re-run: it reuses an existing pool with the same name if found.

set -euo pipefail

REGION="us-east-1"
POOL_NAME="recert-engine-prod"
ADMIN_EMAIL=""
CLIENT_NAME="recert-engine-web"
PROFILE_ARG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --region)      REGION="$2"; shift 2 ;;
    --pool-name)   POOL_NAME="$2"; shift 2 ;;
    --admin-email) ADMIN_EMAIL="$2"; shift 2 ;;
    --client-name) CLIENT_NAME="$2"; shift 2 ;;
    --profile)     PROFILE_ARG="--profile $2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$ADMIN_EMAIL" ]]; then
  echo "ERROR: --admin-email is required" >&2
  exit 1
fi

aws() { command aws $PROFILE_ARG --region "$REGION" "$@"; }

echo ">> Looking for an existing pool named '$POOL_NAME'..."
POOL_ID="$(aws cognito-idp list-user-pools --max-results 60 \
  --query "UserPools[?Name=='$POOL_NAME'].Id | [0]" --output text)"

if [[ "$POOL_ID" == "None" || -z "$POOL_ID" ]]; then
  echo ">> Creating hardened user pool '$POOL_NAME'..."
  POOL_ID="$(aws cognito-idp create-user-pool \
    --pool-name "$POOL_NAME" \
    --mfa-configuration ON \
    --admin-create-user-config AllowAdminCreateUserOnly=true \
    --auto-verified-attributes email \
    --username-attributes email \
    --policies '{"PasswordPolicy":{"MinimumLength":14,"RequireUppercase":true,"RequireLowercase":true,"RequireNumbers":true,"RequireSymbols":true,"TemporaryPasswordValidityDays":3}}' \
    --user-pool-add-ons '{"AdvancedSecurityMode":"ENFORCED"}' \
    --query 'UserPool.Id' --output text)"
  echo "   created pool: $POOL_ID"
else
  echo "   reusing existing pool: $POOL_ID"
fi

echo ">> Enforcing TOTP (authenticator app) MFA..."
aws cognito-idp set-user-pool-mfa-config \
  --user-pool-id "$POOL_ID" \
  --mfa-configuration ON \
  --software-token-mfa-configuration Enabled=true >/dev/null

echo ">> Ensuring SRP-only app client '$CLIENT_NAME'..."
CLIENT_ID="$(aws cognito-idp list-user-pool-clients --user-pool-id "$POOL_ID" --max-results 60 \
  --query "UserPoolClients[?ClientName=='$CLIENT_NAME'].ClientId | [0]" --output text)"

if [[ "$CLIENT_ID" == "None" || -z "$CLIENT_ID" ]]; then
  CLIENT_ID="$(aws cognito-idp create-user-pool-client \
    --user-pool-id "$POOL_ID" \
    --client-name "$CLIENT_NAME" \
    --no-generate-secret \
    --explicit-auth-flows ALLOW_USER_SRP_AUTH ALLOW_REFRESH_TOKEN_AUTH \
    --prevent-user-existence-errors ENABLED \
    --access-token-validity 60 --id-token-validity 60 --refresh-token-validity 30 \
    --token-validity-units '{"AccessToken":"minutes","IdToken":"minutes","RefreshToken":"days"}' \
    --query 'UserPoolClient.ClientId' --output text)"
  echo "   created app client: $CLIENT_ID"
else
  echo "   reusing app client: $CLIENT_ID"
fi

echo ">> Ensuring groups 'admin' and 'owner'..."
aws cognito-idp create-group --user-pool-id "$POOL_ID" --group-name admin 2>/dev/null || echo "   admin exists"
aws cognito-idp create-group --user-pool-id "$POOL_ID" --group-name owner 2>/dev/null || echo "   owner exists"

echo ">> Creating first admin user '$ADMIN_EMAIL' (forced password reset + MFA on first login)..."
aws cognito-idp admin-create-user --user-pool-id "$POOL_ID" \
  --username "$ADMIN_EMAIL" \
  --user-attributes Name=email,Value="$ADMIN_EMAIL" Name=email_verified,Value=true \
  2>/dev/null || echo "   user already exists"
aws cognito-idp admin-add-user-to-group --user-pool-id "$POOL_ID" \
  --username "$ADMIN_EMAIL" --group-name admin >/dev/null

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
POOL_ARN="arn:aws:cognito-idp:${REGION}:${ACCOUNT_ID}:userpool/${POOL_ID}"

cat <<EOF

============================================================
Hardened Cognito pool ready.

  User Pool ID:   $POOL_ID
  App Client ID:  $CLIENT_ID
  User Pool ARN:  $POOL_ARN

Next: deploy the engine pointed at this pool. Either pass:

  sam deploy --config-env prod \\
    --parameter-overrides ... CognitoUserPoolArn="$POOL_ARN"

or set CognitoUserPoolArn in engine/samconfig.toml [prod.deploy.parameters].

The admin user must complete first-login password reset and register an
authenticator-app MFA device before calling the API.
============================================================
EOF
