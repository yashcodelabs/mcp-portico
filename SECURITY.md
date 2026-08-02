# Security policy

## Reporting a vulnerability

MCP Portico is a security-sensitive project because it will proxy tenant
credentials and enforce catalog-gated access to upstream APIs. If you find a
vulnerability, please do **not** open a public issue.

Report privately to the maintainers. Include:

- The affected version and platform
- Steps to reproduce
- Impact, especially around tenant isolation, credential exposure, SSRF, or
  catalog-gate bypass

We will acknowledge the report, work with you on a fix, and coordinate
disclosure.

## Security expectations for contributors

- Never commit secrets, tokens, or live API keys.
- Never log or echo authorization headers, API keys, cookies, or configured
  sensitive fields.
- Keep upstream credentials out of catalogs, registry files, MCP responses, and
  telemetry; use secret references only.
- Fail closed: unknown operations, content types, auth requirements, and target
  connections must be denied.
- Remote binding with authentication disabled (`MCP_PORTICO_AUTH_MODE=none`) is
  a startup error.
