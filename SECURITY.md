# Security policy

## Reporting a vulnerability

MCP Portico is a security-sensitive project because it will proxy tenant
credentials and enforce catalog-gated access to upstream APIs. If you find a
vulnerability, please do **not** open a public issue.

Use GitHub's private security-advisory reporting flow:

<https://github.com/yashcodelabs/mcp-portico/security/advisories>

Select **Report a vulnerability** when private vulnerability reporting is
enabled for the repository. Do not open a public issue. Include:

- The affected version and platform
- Steps to reproduce
- Impact, especially around tenant isolation, credential exposure, SSRF, or
  catalog-gate bypass

We will acknowledge the report, work with you on a fix, and coordinate
disclosure.

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |

The maintainers target an acknowledgement within five business days. The
timeline may vary when the report requires coordination with an upstream
dependency or affected users.

## Security expectations for contributors

- Never commit secrets, tokens, or live API keys.
- Never log or echo authorization headers, API keys, cookies, or configured
  sensitive fields.
- Keep upstream credentials out of catalogs, registry files, MCP responses, and
  telemetry; use secret references only.
- Treat `MCP_PORTICO_KEY_PEPPER` as a secret: it is the keying material for
  every Portico API-key digest. Store it in a secret manager and rotate it
  deliberately (rotation requires reissuing keys).
- Fail closed: unknown operations, content types, auth requirements, and target
  connections must be denied.
- Remote binding with authentication disabled (`MCP_PORTICO_AUTH_MODE=none`) is
  a startup error.
- Destinations are restricted by network policy; cloud metadata endpoints are
  always denied and redirects are disabled by default.
