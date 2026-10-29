# SimpleFIN support design spike

## Purpose and current behavior

This bounded spike records what it would take to support user-configured SimpleFIN connections while preserving BankGlass's personal, single-user, read-only scope. It does not enable SimpleFIN or describe behavior that is already available to an operator. **The proposed support is not implemented.**

Repository facts checked for this spike:

- `src/index.ts` constructs the runtime registry with Akahu only. The SimpleFIN adapter is not registered or reachable from the Worker composition root.
- `src/providers/simplefin/provider.ts` implements a bundled adapter. It resolves a redacted Access URL by `ConnectionId`, requires the URL to use HTTPS, removes credentials from the request URL, and sends its credentials as HTTP Basic Auth. It requests SimpleFIN v2 accounts including pending transactions. Its refresh strategy is `ProviderManaged`.
- `src/__tests__/simplefin-provider.test.ts` tests transport authentication, normalization, duplicate identity scoping, pending and posted transactions, and failure handling. These tests verify the adapter boundary, not a deployed SimpleFIN flow.
- `src/domain/connection.ts` models tagged authorization state and string-valued metadata. It has no credential field.
- `src/bank-store.ts` and `src/bank-store-do.ts` persist and retrieve connection records and scoped sync data. These are internal store operations; there is no public connection-management API for adding, changing, revoking, or removing connections.
- `.env.tpl` and `alchemy.run.ts` declare Akahu-oriented provider deployment configuration. The existing preview configuration disables Akahu credentials, but shares other sensitive deployment values with previews as described in the README.
- `docs/architecture/provider-connections.md` says bundled adapter selection happens at the composition root, credentials may later use a separate credential-vault authority seam, and runtime-loaded plugins are out of scope.
- The README describes a personal, single-user, read-only service.

The existing connection and synchronization model is a useful foundation: identities and reconciliation are scoped by connection, and synchronization handles enabled connections independently. It does not solve how a SimpleFIN Access URL is obtained, stored, rotated, or removed securely.

## Options

| Option | Benefits | Costs and risks |
| --- | --- | --- |
| **A. Retain the dormant adapter** | No new credential or lifecycle surface; no runtime behavior or deployment secret changes; keeps the unregistered adapter available for future work. | No operator can configure SimpleFIN; adapter code and tests may drift; the existence of adapter code can be mistaken for supported product behavior. |
| **B. Support configurable SimpleFIN connections** | Uses the existing bundled adapter and connection-scoped synchronization model; permits multiple user-configured SimpleFIN connections without changing the product's single-user, read-only boundary. | Requires a credential authority, protected management operations, lifecycle and migration decisions, safe preview/deploy isolation, and operational failure handling. The current adapter alone is insufficient. |

## Recommendation

Recommend **Option B as a staged, explicitly opt-in product capability**, with no enablement until a credential authority and protected connection lifecycle are designed and reviewed. The repo already separates provider adapters from connection identity, scopes persisted data by connection, has an adapter that expects a redacted URL per connection, and declares a future credential-vault seam. That evidence lowers the cost of integration.

This recommendation is a proposal, not a repository decision or implementation. Option A remains the safer short-term choice if the project cannot provide isolated secret storage and management authentication. A SimpleFIN feature must not add provider code downloaded or evaluated at runtime; only bundled adapters selected at the composition root fit the accepted architecture.

## Proposed behavior and security boundary

### Setup and credential authority

1. An authenticated single-user operator starts a connection setup flow and supplies or redeems a SimpleFIN setup token using a documented, deliberately bounded process. The setup token should be short-lived and never persisted by BankGlass. Whether BankGlass performs redemption or the operator supplies the resulting Access URL is an open question.
2. The resulting Access URL is treated as a bearer credential: anyone holding it can access the associated SimpleFIN data. Store it in a dedicated credential authority keyed by `ConnectionId`, separate from `BankConnection`, SQLite metadata, account data, logs, API responses, and backups of ordinary application data.
3. The adapter receives a redacted credential only for the connection being synchronized. Errors, traces, and diagnostics must identify the connection and safe error category without including the URL, Basic Auth header, username, password, or provider response body.
4. Store only non-secret metadata on the connection, such as provider ID, operator label, enabled state, authorization state, timestamps, and a non-sensitive credential reference if the vault requires one. Do not place secrets in `metadata` merely because it is a string map.

The architecture guide identifies a credential-vault authority seam as possible future work, but does not select its storage implementation, encryption model, access policy, or recovery process. Those decisions are prerequisites, not implied facts.

### Add, update, revoke, and remove

- **Add:** validate the setup result and Access URL before creating the record; create a new stable `ConnectionId`; store the secret in the credential authority; save non-secret connection metadata; then optionally run an initial sync. A failed step must not leave an enabled connection that cannot resolve its credential.
- **Update / rotate:** stage and validate the replacement credential, atomically switch the credential reference/version, mark the connection connected, and retain the old secret only as long as needed for rollback. Never overwrite an active credential with an unvalidated value.
- **Revoke:** allow an operator to revoke access at the SimpleFIN side, then mark the local connection `Revoked` or `ReauthorizationRequired` and disable scheduled sync. A provider 401/403 should mark or surface authorization failure without silently deleting cached data.
- **Remove:** disable sync first, delete the connection's credential, then delete the connection and only its locally cached records and sync state. Define retryable cleanup behavior so partial failure cannot leave an enabled, credential-bearing orphan. Removal should clearly disclose the local data it deletes.

The current store has internal connection save/delete methods and connection-scoped reconciliation, but no public API to enact this lifecycle. The operation ordering and recovery guarantees above are proposals.

### Preview and deployment secret isolation

Production Access URLs must never be available to untrusted preview code. A future deployment design should use separate credential namespaces and access policies per environment, omit production SimpleFIN credentials from previews, and ensure preview setup data cannot write into the production vault or Durable Object. Prefer previews with SimpleFIN disabled and synthetic credentials/data. Review the current deployment's shared preview secrets and state bindings before adding any credential path; simply adding another environment variable to `.env.tpl` or `alchemy.run.ts` would not create connection-level isolation.

Credential reads should be limited to the Worker path that synchronizes the matching connection. Secret values must not cross into browser JavaScript, public discovery, REST/MCP output, or logs. Deploy and preview identity, vault permissions, backup/restore, and rotation behavior need an explicit threat review.

### HTTPS, redirects, and outbound requests

The adapter currently rejects a non-HTTPS Access URL and strips user info from its request URL before sending Basic Auth. That is a sound minimum, but it does not by itself establish safe configurable network access. A user-supplied URL can target an unintended HTTPS host, and default fetch redirect handling deserves an explicit policy.

Before enabling connection setup, validate the URL structure and reject unexpected ports, fragments, query credentials, and malformed user-info. Do not allow redirects for credentialed requests, or validate every redirect target and ensure authorization is never forwarded; rejecting redirects is the simpler safe default. Apply request timeouts and bounded response sizes, and consider an egress/host policy that still permits legitimate SimpleFIN bridges. Do not log the raw URL on parse or fetch failures. Test downgrade, cross-origin redirect, redirect loops, and private or platform-internal destination handling at the transport boundary.

The adapter presently checks HTTPS, derives Basic Auth from URL user-info, and uses a ten-second timeout by default. The stricter URL and redirect controls above are proposed hardening; they are not a claim about existing behavior.

### Identity, pending data, refresh, and failures

- Preserve the architecture rule that upstream IDs are scoped by `ConnectionId`; identical IDs from two SimpleFIN connections must not collide. Persisted local IDs remain assigned by the store.
- The adapter currently marks pending transactions available and normalizes them separately from posted transactions. Confirm replacement/reconciliation semantics for SimpleFIN pending entries across syncs, including disappearance, posting, and changed upstream IDs, before promising stable pending history.
- The adapter currently declares refresh as `ProviderManaged`: synchronization reads the provider's current snapshot and does not request a provider refresh. Communicate freshness as provider-reported snapshot time, not as a guarantee that upstream data is current. Do not imply that the existing Akahu manual refresh route refreshes SimpleFIN.
- The sync service already isolates per-connection outcomes and uses connection-scoped leases and persistence. A SimpleFIN authorization, rate-limit, malformed-response, or network failure should fail only that connection's sync, preserve its last good local snapshot, and remain distinguishable in status without exposing provider details or credentials. Confirm scheduled retry behavior is suitable for provider-managed refreshes.

## API and migration implications

The public API currently reads cached data and status; there is no connection CRUD endpoint. Supporting operator-managed connections would require a separately authenticated management surface for listing safe metadata and adding, updating, disabling, revoking, and removing a connection. It must never return the Access URL. This expands the API's mutation surface while preserving read-only bank access: management changes BankGlass configuration only and must not initiate payments, bank actions, or arbitrary upstream proxy requests. Decide whether setup is REST, a local-only administrative command, or a Cloudflare Access-protected operator workflow before implementation.

The store schema already has connection records, authorization state, string metadata, connection-scoped accounts/transactions, and sync state. A schema migration may not be needed if the secret stays entirely outside SQLite. A credential-vault reference or version field could require a carefully versioned schema/API change. Existing default Akahu connection migration and local IDs must remain intact. Removing a connection must not remove another connection's data. No persistence or API change is made by this spike.

## Staged implementation slices

1. **Resolve security and product questions:** choose setup-token handling, credential authority, management authentication, preview isolation, URL/redirect policy, and removal/revocation semantics.
2. **Build the credential authority seam:** define narrow put/read/rotate/delete operations scoped by connection and environment; add redaction and access controls; prove that application storage and logs never receive secret values.
3. **Harden and compose the adapter:** enforce URL and redirect policy; inject credentials only for the matching connection; register the bundled adapter behind explicit configuration. Keep it disabled when no SimpleFIN connection is configured.
4. **Add lifecycle management:** implement protected setup and connection add/update/disable/revoke/remove operations with safe metadata-only responses and recoverable ordering across the store and credential authority.
5. **Validate sync and deployment behavior:** verify identity scoping, pending reconciliation, freshness reporting, failure isolation, migrations if needed, and production/preview secret separation with representative integration tests.
6. **Document supported operation:** only after the capability is deployed, update user-facing setup and support claims with exact credential and data-retention behavior.

## Open questions

- Should operators redeem SimpleFIN setup tokens outside BankGlass and provide the resulting Access URL, or should a protected setup flow redeem the token? Which approach avoids unnecessarily accepting and retaining a second credential?
- Which credential authority fits Cloudflare deployment, and how are environment separation, encryption, backup, recovery, rotation, and deletion audited?
- What authenticates management operations beyond existing Access and bearer-token checks, and can a local administrative workflow avoid a new remotely exposed mutation API?
- Are SimpleFIN URLs restricted to known bridge hosts, or is arbitrary operator-supplied HTTPS necessary? What redirect behavior do supported bridges require?
- What exact pending-transaction reconciliation guarantees can the SimpleFIN protocol provide when pending items change or become posted?
- How should status represent provider-managed freshness and persistent authorization failure, and which failures should be retried automatically?
- Should removing a connection delete all cached account and transaction history immediately, or offer an explicit export/retention step first?
- Does deployment state isolation need to change before any preview can exercise connection-management code safely?

## Scope boundary

This design keeps BankGlass personal, single-user, and read-only. It does not add multi-user tenancy, payments, write access to financial institutions, arbitrary upstream proxying, or remote/runtime-loaded plugins. SimpleFIN support described here is proposed behavior only and remains unimplemented.
