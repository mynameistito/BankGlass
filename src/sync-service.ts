import { Clock, Context, Duration, Effect, Layer, Result } from "effect";

import { BankStore } from "@/bank-store";
import type { BankStoreService } from "@/bank-store";
import type { BankConnection } from "@/domain/connection";
import type { ConnectionId } from "@/domain/identifiers";
import type {
  ConnectionSyncOutcome,
  ConnectionSyncSuccess,
  SyncRefreshMode,
} from "@/domain/sync";
import { RefreshCooldownError } from "@/errors";
import type {
  DatabaseError,
  NotFoundError,
  SyncInProgressError,
} from "@/errors";
import type { ProviderNotRegisteredError } from "@/errors/provider-not-registered";
import { ProviderRegistry } from "@/provider-registry";
import type {
  BankProviderAdapter,
  BankProviderError,
  ProviderRegistryService,
} from "@/provider-registry";

/** Failures that can prevent one connection from synchronizing. */
type SyncError =
  | BankProviderError
  | DatabaseError
  | NotFoundError
  | ProviderNotRegisteredError
  | RefreshCooldownError
  | SyncInProgressError;

type SynchronizeConnection = SyncServiceService["synchronizeConnection"];

type ExplicitRefresh = Extract<
  BankProviderAdapter["refresh"],
  { readonly _tag: "Explicit" }
>;

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

const explicitRefreshFor = (
  mode: SyncRefreshMode,
  provider: BankProviderAdapter
): ExplicitRefresh | null =>
  mode === "RequestIfSupported" && provider.refresh._tag === "Explicit"
    ? provider.refresh
    : null;

const refreshAllowedBefore = (
  startedMillis: number,
  refresh: ExplicitRefresh | null
) =>
  refresh === null
    ? null
    : toIso(startedMillis - Duration.toMillis(refresh.minimumInterval));

const failWithCooldownWhenApplicable = (
  store: BankStoreService,
  connection: BankConnection,
  refresh: ExplicitRefresh | null,
  startedMillis: number,
  acquisitionError: DatabaseError | SyncInProgressError
): Effect.Effect<
  never,
  DatabaseError | NotFoundError | RefreshCooldownError | SyncInProgressError
> =>
  Effect.gen(function* checkRefreshCooldown() {
    if (refresh === null) {
      return yield* Effect.fail(acquisitionError);
    }
    const status = yield* store.getSyncStatus(connection.id);
    if (status.lastProviderRefreshRequestedAt === null) {
      return yield* Effect.fail(acquisitionError);
    }
    const retryAtMillis =
      Date.parse(status.lastProviderRefreshRequestedAt) +
      Duration.toMillis(refresh.minimumInterval);
    return retryAtMillis > startedMillis
      ? yield* Effect.fail(
          new RefreshCooldownError({ retryAt: toIso(retryAtMillis) })
        )
      : yield* Effect.fail(acquisitionError);
  });

const providerFreshness = (
  accounts: readonly {
    readonly providerBalanceRefreshedAt: string | null;
    readonly providerTransactionsRefreshedAt: string | null;
  }[]
) =>
  accounts
    .flatMap(accountFreshness)
    .filter(isPresent)
    .toSorted()
    .at(0) ?? null;

const connectionFailureOutcome = (
  connection: BankConnection,
  error: SyncError
): ConnectionSyncOutcome => ({
  _tag: "Failure",
  connectionId: connection.id,
  errorTag: errorTag(error),
  providerId: connection.providerId,
});

const makeSynchronizeConnection = (
  store: BankStoreService,
  registry: ProviderRegistryService,
  lookbackDays: number
): SynchronizeConnection =>
  Effect.fn("SyncService.synchronizeConnection")(function* synchronizeConnection(
    input: {
      readonly connectionId: ConnectionId;
      readonly refresh: SyncRefreshMode;
    }
  ) {
    const connection = yield* store.getConnection(input.connectionId);
    const provider = yield* registry.get(connection.providerId);
    const startedMillis = yield* Clock.currentTimeMillis;
    const startedAt = toIso(startedMillis);
    const refresh = explicitRefreshFor(input.refresh, provider);
    const leaseId = crypto.randomUUID();
    const acquisition = yield* Effect.result(
      store.acquireSync(
        connection.id,
        startedAt,
        leaseId,
        refreshAllowedBefore(startedMillis, refresh)
      )
    );
    if (Result.isFailure(acquisition)) {
      return yield* failWithCooldownWhenApplicable(
        store,
        connection,
        refresh,
        startedMillis,
        acquisition.failure
      );
    }

    const run = Effect.gen(function* persistProviderSnapshot() {
      if (refresh !== null) {
        yield* refresh.request(connection);
        yield* store.markRefreshRequested(connection.id, startedAt, leaseId);
        yield* Effect.sleep(refresh.propagationDelay);
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
      const providerRefreshedAt = providerFreshness(snapshot.accounts);
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

const synchronizeOneEnabled = (
  synchronizeConnection: SynchronizeConnection,
  connection: BankConnection,
  refresh: SyncRefreshMode
) =>
  synchronizeConnection({ connectionId: connection.id, refresh }).pipe(
    Effect.match({
      onFailure: (error) => connectionFailureOutcome(connection, error),
      onSuccess: (success): ConnectionSyncOutcome => success,
    })
  );

const makeSynchronizeEnabled = (
  store: BankStoreService,
  synchronizeConnection: SynchronizeConnection
): SyncServiceService["synchronizeEnabled"] =>
  (input) =>
    Effect.gen(function* synchronizeAllEnabled() {
      const connections = yield* store.listConnections;
      const effects: Effect.Effect<ConnectionSyncOutcome>[] = [];
      for (const connection of connections) {
        if (connection.enabled) {
          effects.push(
            synchronizeOneEnabled(
              synchronizeConnection,
              connection,
              input.refresh
            )
          );
        }
      }
      return yield* Effect.all(effects, { concurrency: 4 });
    });

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
    const synchronizeConnection = makeSynchronizeConnection(
      store,
      registry,
      lookbackDays
    );
    const synchronizeEnabled = makeSynchronizeEnabled(
      store,
      synchronizeConnection
    );
    return SyncService.of({ synchronizeConnection, synchronizeEnabled });
  });

/** Provide the synchronization application service with its lookback policy. */
export const syncServiceLive = (lookbackDays: number) =>
  Layer.effect(SyncService, makeSyncService(lookbackDays));
