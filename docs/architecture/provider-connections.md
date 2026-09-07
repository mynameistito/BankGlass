# ADR: provider and connection boundaries

## Status

Accepted for the multi-provider migration.

## Context

BankGlass currently has one global `BankProvider`, one global synchronization lease, and persistence keys that assume upstream account and transaction IDs are globally unique. That is safe only while one Akahu Personal App is the sole source.

A provider and a connection are different concepts:

- a **provider** is bundled software that knows how to talk to and normalize one banking-data protocol or vendor;
- a **connection** is one configured/authorized instance of that provider.

A single-user BankGlass deployment may have several connections to the same provider, and different providers may legitimately expose identical upstream IDs or the same real-world bank account.

## Decision

BankGlass owns five distinct identity domains: `ProviderId`, `ConnectionId`, local `AccountId`, local `TransactionId`, and connection-scoped upstream account/transaction IDs. Provider adapters normalize upstream identities but never choose BankGlass-local IDs. Persistence owns the mapping from `(connectionId, providerAccountId)` and `(connectionId, providerTransactionId)` to stable local IDs.

Provider behavior is represented by tagged operational strategies rather than capability booleans. In particular, refresh is one of `Explicit`, `ProviderManaged`, or `Unavailable`; pending transactions are `Available` or `Unavailable`. The application synchronization service owns timing, leases, lookback, persistence ordering, and failure isolation. Adapters own authentication mechanics, transport, pagination, upstream parsing/error classification, and normalization.

Concrete provider adapters are selected only at the composition root and exposed to application code through a validated `ProviderRegistry`. BankGlass does not load remote JavaScript, evaluate provider code, or download runtime plugins.

Persistence and synchronization state are scoped by `ConnectionId`. Reconciliation for one connection is forbidden from deleting or mutating another connection's records. Cross-provider account deduplication is explicitly out of scope.

## Migration compatibility

The first schema migration creates a deterministic default Akahu connection for existing installations. Existing Akahu local account and transaction IDs are preserved when rows are migrated. New local IDs are assigned only by persistence and remain stable on later synchronization.

## Consequences

- REST and MCP can continue to aggregate accounts and transactions while exposing provider/connection source metadata.
- A future provider can be added without changing reconciliation rules or local identity policy.
- OAuth and setup-token credentials can be attached to connections behind a separate credential-vault authority seam.
- Provider catalog metadata remains deterministic reference data and is not part of the operational registry.
