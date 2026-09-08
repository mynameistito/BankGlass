import { Context } from "effect";
import type { Effect } from "effect";

import type {
  AccountQuery,
  BankAccount,
  ProviderAccount,
} from "@/domain/account";
import type { BankConnection } from "@/domain/connection";
import type { ConnectionId, ProviderId } from "@/domain/identifiers";
import type { SyncStatus } from "@/domain/sync";
import type {
  ProviderPendingTransaction,
  ProviderPostedTransaction,
  TransactionPage,
  TransactionQuery,
} from "@/domain/transaction";
import type {
  ApiRateLimitError,
  DatabaseError,
  NotFoundError,
  SyncInProgressError,
} from "@/errors";

/** Connection-scoped provider snapshot accepted by persistence. */
export interface ProviderSnapshot {
  /** Accounts normalized by the provider. */
  readonly accounts: readonly ProviderAccount[];
  /** Connection whose local data is being reconciled. */
  readonly connectionId: ConnectionId;
  /** Lease that authorizes this write. */
  readonly leaseId: string;
  /** Pending transactions returned by the provider. */
  readonly pending: readonly ProviderPendingTransaction[];
  /** Posted transactions returned by the provider. */
  readonly posted: readonly ProviderPostedTransaction[];
  /** Stable provider implementation backing the connection. */
  readonly providerId: ProviderId;
  /** Start of the posted-transaction reconciliation window. */
  readonly reconcilePostedFrom: string;
  /** Timestamp assigned when the snapshot is committed. */
  readonly syncedAt: string;
}

/** Persistence operations for normalized banking data and connection-scoped synchronization state. */
export interface BankStoreService {
  /** List persisted, non-secret provider connections. */
  readonly listConnections: Effect.Effect<
    readonly BankConnection[],
    DatabaseError
  >;
  /** Retrieve one persisted connection. */
  readonly getConnection: (
    connectionId: ConnectionId
  ) => Effect.Effect<BankConnection, DatabaseError | NotFoundError>;
  /** Create or update safe connection metadata and initialize its sync state. */
  readonly saveConnection: (
    connection: BankConnection
  ) => Effect.Effect<void, DatabaseError>;
  /** Remove one connection and only its locally cached data. */
  readonly deleteConnection: (
    connectionId: ConnectionId
  ) => Effect.Effect<void, DatabaseError | NotFoundError>;
  /** List cached accounts using optional provider/connection filters. */
  readonly listAccounts: (
    query: AccountQuery
  ) => Effect.Effect<readonly BankAccount[], DatabaseError>;
  /** Retrieve one cached account by its stable BankGlass identifier. */
  readonly getAccount: (
    id: BankAccount["id"]
  ) => Effect.Effect<BankAccount, DatabaseError | NotFoundError>;
  /** Query cached transactions using source filters and keyset pagination. */
  readonly listTransactions: (
    query: TransactionQuery
  ) => Effect.Effect<TransactionPage, DatabaseError>;
  /** Atomically reconcile one provider connection's snapshot. */
  readonly saveSnapshot: (
    snapshot: ProviderSnapshot
  ) => Effect.Effect<void, DatabaseError | SyncInProgressError>;
  /** Read synchronization state for one connection. */
  readonly getSyncStatus: (
    connectionId: ConnectionId
  ) => Effect.Effect<SyncStatus, DatabaseError | NotFoundError>;
  /** List synchronization state for all configured connections. */
  readonly listSyncStatuses: Effect.Effect<
    readonly SyncStatus[],
    DatabaseError
  >;
  /** Attempt to acquire the synchronization lease for one connection. */
  readonly acquireSync: (
    connectionId: ConnectionId,
    now: string,
    leaseId: string,
    providerRefreshAllowedBefore: string | null
  ) => Effect.Effect<void, DatabaseError | SyncInProgressError>;
  /** Record an upstream refresh request for one connection and lease. */
  readonly markRefreshRequested: (
    connectionId: ConnectionId,
    now: string,
    leaseId: string
  ) => Effect.Effect<void, DatabaseError | SyncInProgressError>;
  /** Mark one connection synchronization as successfully completed. */
  readonly completeSync: (
    connectionId: ConnectionId,
    now: string,
    providerRefreshedAt: string | null,
    leaseId: string
  ) => Effect.Effect<void, DatabaseError | SyncInProgressError>;
  /** Mark one connection synchronization as failed. */
  readonly failSync: (
    connectionId: ConnectionId,
    now: string,
    code: string,
    leaseId: string
  ) => Effect.Effect<void, DatabaseError>;
  /** Consume one request from a fixed one-minute rate-limit bucket. */
  readonly consumeRateLimit: (
    bucket: string,
    nowSeconds: number,
    limit: number
  ) => Effect.Effect<void, DatabaseError | ApiRateLimitError>;
}

/** Effect service tag for the Durable Object-backed BankGlass store. */
export class BankStore extends Context.Service<BankStore, BankStoreService>()(
  "@bankglass/BankStore"
) {}
