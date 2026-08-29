import { Context } from "effect";
import type { Effect } from "effect";

import type {
  BankAccount,
  PendingTransaction,
  PostedTransaction,
  SyncStatus,
  TransactionPage,
  TransactionQuery,
} from "./domain";
import type {
  ApiRateLimitError,
  DatabaseError,
  NotFoundError,
  SyncInProgressError,
} from "./errors";

/** Persistence operations for normalized banking data and synchronization state. */
export interface BankStoreService {
  /** List all cached accounts in store order. */
  readonly listAccounts: Effect.Effect<readonly BankAccount[], DatabaseError>;
  /** Retrieve one cached account by its normalized identifier. */
  readonly getAccount: (
    id: string
  ) => Effect.Effect<BankAccount, DatabaseError | NotFoundError>;
  /** Query cached transactions using filters and keyset pagination. */
  readonly listTransactions: (
    query: TransactionQuery
  ) => Effect.Effect<TransactionPage, DatabaseError>;
  /** Atomically persist a provider snapshot owned by the supplied sync lease. */
  readonly saveSnapshot: (snapshot: {
    /** Accounts returned by the provider. */
    readonly accounts: readonly BankAccount[];
    /** Lease that authorizes this write. */
    readonly leaseId: string;
    /** Posted transactions returned by the provider. */
    readonly posted: readonly PostedTransaction[];
    /** Pending transactions returned by the provider. */
    readonly pending: readonly PendingTransaction[];
    /** Start of the posted-transaction reconciliation window. */
    readonly reconcilePostedFrom: string;
    /** Timestamp assigned to this snapshot. */
    readonly syncedAt: string;
  }) => Effect.Effect<void, DatabaseError | SyncInProgressError>;
  /** Read synchronization state without modifying it. */
  readonly getSyncStatus: Effect.Effect<SyncStatus, DatabaseError>;
  /** Attempt to acquire the single synchronization lease. */
  readonly acquireSync: (
    now: string,
    leaseId: string,
    providerRefreshAllowedBefore: string | null
  ) => Effect.Effect<void, DatabaseError | SyncInProgressError>;
  /** Record that an upstream refresh was requested by this lease. */
  readonly markRefreshRequested: (
    now: string,
    leaseId: string
  ) => Effect.Effect<void, DatabaseError | SyncInProgressError>;
  /** Mark a lease-owned synchronization as successfully completed. */
  readonly completeSync: (
    now: string,
    providerRefreshedAt: string | null,
    leaseId: string
  ) => Effect.Effect<void, DatabaseError | SyncInProgressError>;
  /** Mark a lease-owned synchronization as failed. */
  readonly failSync: (
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
/** Effect service tag for the Durable Object-backed bank store. */
export class BankStore extends Context.Service<BankStore, BankStoreService>()(
  "@bankglass/BankStore"
) {}
