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

export interface BankStoreService {
  readonly listAccounts: Effect.Effect<readonly BankAccount[], DatabaseError>;
  readonly getAccount: (
    id: string
  ) => Effect.Effect<BankAccount, DatabaseError | NotFoundError>;
  readonly listTransactions: (
    query: TransactionQuery
  ) => Effect.Effect<TransactionPage, DatabaseError>;
  readonly saveSnapshot: (snapshot: {
    readonly accounts: readonly BankAccount[];
    readonly leaseId: string;
    readonly posted: readonly PostedTransaction[];
    readonly pending: readonly PendingTransaction[];
    readonly reconcilePostedFrom: string;
    readonly syncedAt: string;
  }) => Effect.Effect<void, DatabaseError | SyncInProgressError>;
  readonly getSyncStatus: Effect.Effect<SyncStatus, DatabaseError>;
  readonly acquireSync: (
    now: string,
    leaseId: string,
    providerRefreshAllowedBefore: string | null
  ) => Effect.Effect<void, DatabaseError | SyncInProgressError>;
  readonly markRefreshRequested: (
    now: string,
    leaseId: string
  ) => Effect.Effect<void, DatabaseError | SyncInProgressError>;
  readonly completeSync: (
    now: string,
    providerRefreshedAt: string | null,
    leaseId: string
  ) => Effect.Effect<void, DatabaseError | SyncInProgressError>;
  readonly failSync: (
    now: string,
    code: string,
    leaseId: string
  ) => Effect.Effect<void, DatabaseError>;
  readonly consumeRateLimit: (
    bucket: string,
    nowSeconds: number,
    limit: number
  ) => Effect.Effect<void, DatabaseError | ApiRateLimitError>;
}
export class BankStore extends Context.Service<BankStore, BankStoreService>()(
  "@bankglass/BankStore"
) {}
