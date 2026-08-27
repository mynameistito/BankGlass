import { Context, Effect, Layer } from "effect";

import { BankProvider } from "./bank-provider";
import type { BankProviderError } from "./bank-provider";
import { BankStore } from "./bank-store";
import { RefreshCooldownError } from "./errors";
import type { DatabaseError, SyncInProgressError } from "./errors";

export type SyncError =
  | BankProviderError
  | DatabaseError
  | RefreshCooldownError
  | SyncInProgressError;
export interface SyncResult {
  readonly syncedAt: string;
  readonly providerRefreshedAt: string | null;
  readonly accounts: number;
  readonly postedTransactions: number;
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
export interface SyncServiceService {
  readonly synchronize: (options: {
    readonly requestProviderRefresh: boolean;
  }) => Effect.Effect<SyncResult, SyncError>;
}
export class SyncService extends Context.Service<
  SyncService,
  SyncServiceService
>()("@bankglass/SyncService") {}

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
        const leaseId = crypto.randomUUID();
        yield* store.acquireSync(startedAt, leaseId);
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

export const syncServiceLive = (
  cooldownSeconds: number,
  lookbackDays: number
) => Layer.effect(SyncService, makeSyncService(cooldownSeconds, lookbackDays));
