import {
  Clock,
  Context,
  Duration,
  Effect,
  Layer,
  Result,
} from "effect";

import { BankStore } from "@/bank-store";
import type { ConnectionId } from "@/domain/identifiers";
import type {
  ConnectionSyncOutcome,
  ConnectionSyncSuccess,
  SyncRefreshMode,
} from "@/domain/sync";
import {
  RefreshCooldownError,
} from "@/errors";
import type {
  DatabaseError,
  NotFoundError,
  SyncInProgressError,
} from "@/errors";
import type { ProviderNotRegisteredError } from "@/errors/provider-registry";
import {
  ProviderRegistry,
  type BankProviderError,
} from "@/provider-registry";

/** Failures that can prevent one connection from synchronizing. */
export type SyncError =
  | BankProviderError
  | DatabaseError
  | NotFoundError
  | ProviderNotRegisteredError
  | RefreshCooldownError
  | SyncInProgressError;

const isPresent = (value: string | null): value is string => value !== null;
const accountFreshness = (account: {
  readonly providerBalanceRefreshedAt: string | null;
  readonly providerTransactionsRefreshedAt: string | null;
}) => [
  account.providerBalanceRefreshedAt,
  account.providerTransactionsRefreshedAt,
];
const toIso = (millis: number) => new Date(millis).toISOString();
const errorTag = (error: SyncError): string => error._tag;

/** Application operations that coordinate provider reads and connection-scoped persistence. */
export interface SyncServiceService {
  /** Synchronize one configured provider connection. */
  readonly synchronizeConnection: (input: {
    readonly connectionId: ConnectionId;
    readonly refresh: SyncRefreshMode;
  }) => Effect.Effect<ConnectionSyncSuccess, SyncError>;
  /** Synchronize every enabled connection with bounded concurrency and isolated failures. */
  readonly synchronizeEnabled: (input: {
    readonly refresh: SyncRefreshMode;
  }) => Effect.Effect<readonly ConnectionSyncOutcome[], DatabaseError>;
}

/** Effect service tag for synchronization application operations. */
export class SyncService extends Context.Service<SyncService, SyncServiceService>()(
  "@bankglass/SyncService"
) {}

/**
 * Construct connection-scoped synchronization policy.
 *
 * @param lookbackDays - Number of days of posted transactions reconciled on each sync.
 * @returns A synchronization service using the application-owned provider registry and store.
 */
export const makeSyncService = (lookbackDays: number) =>
  Effect.gen(function* buildSyncService() {
    const registry = yield* ProviderRegistry;
    const store = yield* BankStore;

    const synchronizeConnection = Effect.fn(
      "SyncService.synchronizeConnection"
    )(function* synchronizeConnection(input: {
      readonly connectionId: ConnectionId;
      readonly refresh: SyncRefreshMode;
    }) {
      const connection = yield* store.getConnection(input.connectionId);
      const provider = yield* registry.get(connection.providerId);
      const startedMillis = yield* Clock.currentTimeMillis;
      const startedAt = toIso(startedMillis);
      const explicitRefresh =
        input.refresh === "RequestIfSupported" &&
        provider.refresh._tag === "Explicit"
          ? provider.refresh
          : null;
      const refreshAllowedBefore =
        explicitRefresh === null
          ? null
          : toIso(
              startedMillis -
                Duration.toMillis(explicitRefresh.minimumInterval)
            );
      const leaseId = crypto.randomUUID();
      const acquisition = yield* Effect.result(
        store.acquireSync(
          connection.id,
          startedAt,
          leaseId,
          refreshAllowedBefore
        )
      );
      if (Result.isFailure(acquisition)) {
        if (explicitRefresh !== null) {
          const status = yield* store.getSyncStatus(connection.id);
          if (status.lastProviderRefreshRequestedAt !== null) {
            const retryAtMillis =
              Date.parse(status.lastProviderRefreshRequestedAt) +
              Duration.toMillis(explicitRefresh.minimumInterval);
            if (retryAtMillis > startedMillis) {
              return yield* Effect.fail(
                new RefreshCooldownError({ retryAt: toIso(retryAtMillis) })
              );
            }
          }
        }
        return yield* Effect.fail(acquisition.failure);
      }

      const run = Effect.gen(function* runConnectionSync() {
        if (explicitRefresh !== null) {
          yield* explicitRefresh.request(connection);
          yield* store.markRefreshRequested(connection.id, startedAt, leaseId);
          yield* Effect.sleep(explicitRefresh.propagationDelay);
        }
        const start = toIso(startedMillis - lookbackDays * 86_400_000);
        const snapshot = yield* provider.readSnapshot({ connection, start });
        const syncedMillis = yield* Clock.currentTimeMillis;
        const syncedAt = toIso(syncedMillis);
        yield* store.saveSnapshot({
          ...snapshot,
          connectionId: connection.id,
          leaseId,
          providerId: connection.providerId,
          reconcilePostedFrom: start,
          syncedAt,
        });
        const providerRefreshedAt =
          snapshot.accounts
            .flatMap(accountFreshness)
            .filter(isPresent)
            .toSorted()
            .at(0) ?? null;
        yield* store.completeSync(
          connection.id,
          syncedAt,
          providerRefreshedAt,
          leaseId
        );
        return {
          _tag: "Success",
          accounts: snapshot.accounts.length,
          connectionId: connection.id,
          pendingTransactions: snapshot.pending.length,
          postedTransactions: snapshot.posted.length,
          providerId: connection.providerId,
          providerRefreshedAt,
          syncedAt,
        } satisfies ConnectionSyncSuccess;
      });

      return yield* run.pipe(
        Effect.tapError((error) =>
          Clock.currentTimeMillis.pipe(
            Effect.flatMap((millis) =>
              store.failSync(
                connection.id,
                toIso(millis),
                errorTag(error),
                leaseId
              )
            ),
            Effect.ignore
          )
        )
      );
    });

    const synchronizeEnabled: SyncServiceService["synchronizeEnabled"] = (
      input
    ) =>
      Effect.gen(function* synchronizeAllEnabled() {
        const connections = yield* store.listConnections;
        return yield* Effect.forEach(
          connections.filter((connection) => connection.enabled),
          (connection) =>
            synchronizeConnection({
              connectionId: connection.id,
              refresh: input.refresh,
            }).pipe(
              Effect.match({
                onFailure: (error): ConnectionSyncOutcome => ({
                  _tag: "Failure",
                  connectionId: connection.id,
                  errorTag: errorTag(error),
                  providerId: connection.providerId,
                }),
                onSuccess: (success): ConnectionSyncOutcome => success,
              })
            ),
          { concurrency: 4 }
        );
      });

    return SyncService.of({ synchronizeConnection, synchronizeEnabled });
  });

/** Provide the synchronization application service with its lookback policy. */
export const syncServiceLive = (lookbackDays: number) =>
  Layer.effect(SyncService, makeSyncService(lookbackDays));
