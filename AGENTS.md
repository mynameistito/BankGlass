# Agent guide

Read [README.md](README.md) for product behavior, local development, and security constraints. Read [the provider and connection architecture decision](docs/architecture/provider-connections.md) before changing provider, identity, persistence, or synchronization code.

## Project boundaries

- BankGlass is a self-hosted, single-user, read-only Cloudflare Worker, REST API, and MCP service. Preserve those boundaries: no tenants, payments, write operations, arbitrary upstream proxy, or bank-login credential handling.
- Provider adapters are bundled code, selected at the composition root, and exposed through the validated `ProviderRegistry`. Do not add remote runtime plugins.
- Adapters normalize upstream data; persistence owns stable local IDs, scoped by connection. Keep persistence and synchronization state connection-scoped, and reconciliation isolated to its connection.
- Keep secrets in the configured secret manager or runtime secret bindings. Never commit credentials or resolved environment files, or expose secrets and financial data in logs.

## Code and verification

- Follow the repository's strict TypeScript settings and existing Effect service, schema, error, and composition patterns. Keep provider mechanics in adapters and orchestration, leases, persistence ordering, and failure isolation in application services.
- Follow the workerd/Vitest patterns and fixtures in `src/__tests__`; keep tests independent of real provider credentials.
- Safe setup: `bun install`.
- CI verification runs `bun run typecheck`, `bun run knip`, `bun run test`, and `bun run check`. These scripts are defined in `package.json`; CI installs with `bun install --frozen-lockfile`.
- Do not run deployment, authentication, or credential-loading commands as part of routine code changes.
- Use conventional commit prefixes such as `feat:`, `fix:`, `docs:`, and `chore:`.
