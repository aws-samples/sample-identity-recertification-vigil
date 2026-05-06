# Security Scan Summary - VIGIL

Date: 2026-05-06
Project: VIGIL (Vigilant Identity Governance & Intelligence Layer)

---

## Technologies Present

| Technology | Files | Scan Tool | Result |
|---|---|---|---|
| JavaScript (Node.js 20.x ES Modules) | 59 source files | Semgrep | 0 findings |
| CloudFormation / SAM (YAML) | template.yaml, cross-account-role.yaml | Holmes | Run manually |
| npm packages (backend) | 141 dependencies | npm audit | 0 vulnerabilities |
| npm packages (frontend) | 380 dependencies | npm audit | 0 vulnerabilities |

## Technologies NOT Present

- Python: None
- Containers/Docker: None
- Terraform: None
- CDK: None

---

## Semgrep Results (JavaScript)

- Tool: semgrep v1.161.0
- Config: auto (community rules)
- Rules evaluated: 200
- Files scanned: 59
- Findings: 0 (0 blocking)
- Parse coverage: ~100%

Full output: `semgrep-results.json`

---

## npm audit Results (Backend)

- Package file: ./package.json
- Total dependencies: 141 (126 prod, 16 dev)
- Critical: 0
- High: 0
- Moderate: 0
- Low: 0
- Info: 0

Full output: `npm-audit-backend.json`

---

## npm audit Results (Frontend)

- Package file: ./ui/package.json
- Total dependencies: 380 (271 prod, 110 dev, 52 optional)
- Critical: 0
- High: 0
- Moderate: 0
- Low: 0
- Info: 0

Full output: `npm-audit-frontend.json`

---

## CloudFormation / SAM (Holmes)

To be run manually from console:
- `template.yaml` - Main SAM template (all infrastructure)
- `stackset-templates/cross-account-role.yaml` - Cross-account IAM role

---

## Notes

- NO CODE is provided as part of this solution. This is a reference architecture for customers to learn from.
- No secrets, credentials, or PII found in source code.
- All AWS SDK interactions use IAM roles (no hardcoded credentials).
- S3 evidence bucket uses Object Lock (Compliance mode, 8-year retention).
- All API endpoints require Cognito authorization.
- DynamoDB audit records are immutable (IAM policy enforced).
