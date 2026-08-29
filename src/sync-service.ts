import { Context, Effect, Layer, Result } from "effect";

import { BankProvider } from "@/bank-provider";
import type { BankProviderError } from "@/bank-provider";
import { BankStore } from "@/bank-store";
import { RefreshCooldownError } from "@/errors";
import type { DatabaseError, SyncInProgressError } from "@/errors";

/** Failures that can prevent a synchronization from completing. */
export type SyncError =
  | BankProviderError
  | DatabaseError
  | RefreshCooldownError
  | SyncInProgressError;
/** Counts and freshness metadata produced by a successful synchronization. */
export interface SyncResult {
  /** Timestamp at which the normalized snapshot was stored. */
  readonly syncedAt: string;
  /** Earliest provider freshness timestamp observed in the snapshot. */
  readonly providerRefreshedAt: string | null;
  /** Number of accounts stored. */
  readonly accounts: number;
  /** Number of posted transactions stored. */
  readonly postedTransactions: number;
  /** Number of pending transactions stored. */
  readonly pendingTransactions: number;
}
const accountFreshness = (account: {
  readonly providerBalanceRefreshedAt: string | null;
  readonly providerTransactionsRefreshedAt: string | null;
}) => [
  account.providerBalanceRefreshedAt,
  account.providerTransactionsRefreshedAt,
];
const isPresent = (value: string | null): value is string => value !== null;
/** Application operation that coordinates provider refresh and persistence. */
export interface SyncServiceService {
  /** Synchronize cached data, optionally requesting a provider refresh first. */
  readonly synchronize: (options: {
    /** Whether the upstream provider should be asked to refresh. */
    readonly requestProviderRefresh: boolean;
  }) => Effect.Effect<SyncResult, SyncError>;
}
/** Effect service tag for synchronization operations. */
export class SyncService extends Context.Service<
  SyncService,
  SyncServiceService
>()("@bankglass/SyncService") {}

/**
 * Construct the synchronization service from its timing policy.
 *
 * @param cooldownSeconds - Minimum interval between provider refresh requests.
 * @param lookbackDays - Number of days of posted transactions to reconcile.
 * @returns An Effect that constructs a `SyncService` implementation from the
 * services available in its environment.
 */
export const makeSyncService = (
  cooldownSeconds: number,
  lookbackDays: number
) =>
  Effect.gen(function* buildSyncService() {
    const provider = yield* BankProvider;
    const store = yield* BankStore;
    const synchronize = Effect.fn("SyncService.synchronize")(
      function* synchronize(options: {
        readonly requestProviderRefresh: boolean;
      }) {
        const startedAt = new Date().toISOString();
        const providerRefreshAllowedBefore = options.requestProviderRefresh
          ? new Date(Date.now() - cooldownSeconds * 1000).toISOString()
          : null;
        const leaseId = crypto.randomUUID();
        const acquisition = yield* Effect.result(
          store.acquireSync(startedAt, leaseId, providerRefreshAllowedBefore)
        );
        if (Result.isFailure(acquisition)) {
          if (options.requestProviderRefresh) {
            const status = yield* store.getSyncStatus;
            if (status.lastProviderRefreshRequestedAt !== null) {
              const retryAtMs =
                Date.parse(status.lastProviderRefreshRequestedAt) +
                cooldownSeconds * 1000;
              if (retryAtMs > Date.now()) {
                return yield* Effect.fail(
                  new RefreshCooldownError({
                    retryAt: new Date(retryAtMs).toISOString(),
                  })
                );
              }
            }
          }
          return yield* Effect.fail(acquisition.failure);
        }
        const run = Effect.gen(function* run() {
          if (options.requestProviderRefresh) {
            yield* provider.requestRefresh;
            yield* store.markRefreshRequested(startedAt, leaseId);
            yield* Effect.sleep("5 seconds");
          }
          const start = new Date(
            Date.now() - lookbackDays * 86_400_000
          ).toISOString();
          const [accounts, posted, pending] = yield* Effect.all(
            [
              provider.getAccounts,
              provider.getTransactions({ start }),
              provider.getPendingTransactions,
            ],
            { concurrency: 3 }
          );
          const syncedAt = new Date().toISOString();
          yield* store.saveSnapshot({
            accounts,
            leaseId,
            pending,
            posted,
            reconcilePostedFrom: start,
            syncedAt,
          });
          const freshness = accounts
            .flatMap(accountFreshness)
            .filter(isPresent)
            .toSorted();
          const providerRefreshedAt = freshness.at(0) ?? null;
          yield* store.completeSync(syncedAt, providerRefreshedAt, leaseId);
          return {
            accounts: accounts.length,
            pendingTransactions: pending.length,
            postedTransactions: posted.length,
            providerRefreshedAt,
            syncedAt,
          };
        });
        return yield* run.pipe(
          Effect.tapError((error) =>
            store
              .failSync(new Date().toISOString(), error._tag, leaseId)
              .pipe(Effect.ignore)
          )
        );
      }
    );
    return SyncService.of({ synchronize });
  });

/** Provide a live synchronization service with the supplied timing policy. */
export const syncServiceLive = (
  cooldownSeconds: number,
  lookbackDays: number
) => Layer.effect(SyncService, makeSyncService(cooldownSeconds, lookbackDays));
