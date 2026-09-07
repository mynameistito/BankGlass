import { Duration, Effect, Layer, Schema } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import { BankStore } from "@/bank-store";
import type { BankStoreService } from "@/bank-store";
import type { BankConnection } from "@/domain/connection";
import {
  ConnectionIdSchema,
  ProviderIdSchema,
} from "@/domain/identifiers";
import { SyncInProgressError } from "@/errors";
import type { BankProviderAdapter } from "@/provider-registry";
import { providerRegistryLayer } from "@/provider-registry";
import { makeSyncService } from "@/sync-service";

const akahuProviderId = Schema.decodeUnknownSync(ProviderIdSchema)("akahu");
const managedProviderId = Schema.decodeUnknownSync(ProviderIdSchema)("managed");
const missingProviderId = Schema.decodeUnknownSync(ProviderIdSchema)("missing");
const akahuConnectionId = Schema.decodeUnknownSync(ConnectionIdSchema)(
  "connection_akahu_test"
);
const managedConnectionId = Schema.decodeUnknownSync(ConnectionIdSchema)(
  "connection_managed_test"
);
const missingConnectionId = Schema.decodeUnknownSync(ConnectionIdSchema)(
  "connection_missing_test"
);
const epoch = "1970-01-01T00:00:00.000Z";

const connection = (
  id: typeof akahuConnectionId,
  providerId: typeof akahuProviderId
): BankConnection => ({
  authorization: { _tag: "Connected" },
  createdAt: epoch,
  enabled: true,
  id,
  label: String(id),
  lastSyncAt: null,
  metadata: {},
  providerId,
  updatedAt: epoch,
});

const unusedStore = (): BankStoreService => ({
  acquireSync: () => Effect.die("unused"),
  completeSync: () => Effect.die("unused"),
  consumeRateLimit: () => Effect.die("unused"),
  deleteConnection: () => Effect.die("unused"),
  failSync: () => Effect.die("unused"),
  getAccount: () => Effect.die("unused"),
  getConnection: () => Effect.die("unused"),
  getSyncStatus: () => Effect.die("unused"),
  listAccounts: () => Effect.die("unused"),
  listConnections: Effect.die("unused"),
  listSyncStatuses: Effect.die("unused"),
  listTransactions: () => Effect.die("unused"),
  markRefreshRequested: () => Effect.die("unused"),
  saveConnection: () => Effect.die("unused"),
  saveSnapshot: () => Effect.die("unused"),
});

const makeService = (
  store: BankStoreService,
  providers: readonly BankProviderAdapter[]
) =>
  Effect.runPromise(
    makeSyncService(14).pipe(
      Effect.provide(
        Layer.merge(
          Layer.succeed(BankStore, BankStore.of(store)),
          providerRegistryLayer(providers)
        )
      )
    )
  );

describe("connection synchronization policy", () => {
  it("reports an explicit provider refresh cooldown for only that connection", async () => {
    let refreshCalls = 0;
    let failCalls = 0;
    const provider: BankProviderAdapter = {
      displayName: "Akahu test",
      id: akahuProviderId,
      pendingTransactions: { _tag: "Available" },
      readSnapshot: () => Effect.succeed({ accounts: [], pending: [], posted: [] }),
      refresh: {
        _tag: "Explicit",
        minimumInterval: Duration.hours(1),
        propagationDelay: Duration.zero,
        request: () =>
          Effect.sync(() => {
            refreshCalls += 1;
          }),
      },
    };
    const store: BankStoreService = {
      ...unusedStore(),
      acquireSync: () => Effect.fail(new SyncInProgressError({})),
      failSync: () =>
        Effect.sync(() => {
          failCalls += 1;
        }),
      getConnection: () =>
        Effect.succeed(connection(akahuConnectionId, akahuProviderId)),
      getSyncStatus: () =>
        Effect.succeed({
          connectionId: akahuConnectionId,
          errorCode: null,
          errorMessage: null,
          lastAttemptAt: null,
          lastProviderRefreshRequestedAt: epoch,
          lastSuccessAt: null,
          providerId: akahuProviderId,
          providerRefreshedAt: null,
          startedAt: null,
          status: "idle",
        }),
    };
    const service = await makeService(store, [provider]);

    const error = await Effect.runPromise(
      Effect.flip(
        service.synchronizeConnection({
          connectionId: akahuConnectionId,
          refresh: "RequestIfSupported",
        })
      ).pipe(Effect.provide(TestClock.layer()))
    );

    expect(error._tag).toBe("RefreshCooldownError");
    expect(refreshCalls).toBe(0);
    expect(failCalls).toBe(0);
  });

  it("syncs provider-managed freshness without reserving or requesting refresh", async () => {
    let refreshAllowedBefore: string | null | undefined;
    let snapshotWrites = 0;
    const provider: BankProviderAdapter = {
      displayName: "Managed provider",
      id: managedProviderId,
      pendingTransactions: { _tag: "Available" },
      readSnapshot: () => Effect.succeed({ accounts: [], pending: [], posted: [] }),
      refresh: { _tag: "ProviderManaged" },
    };
    const managedConnection = connection(
      managedConnectionId,
      managedProviderId
    );
    const store: BankStoreService = {
      ...unusedStore(),
      acquireSync: (_connectionId, _now, _leaseId, before) =>
        Effect.sync(() => {
          refreshAllowedBefore = before;
        }),
      completeSync: () => Effect.void,
      failSync: () => Effect.void,
      getConnection: () => Effect.succeed(managedConnection),
      saveSnapshot: () =>
        Effect.sync(() => {
          snapshotWrites += 1;
        }),
    };
    const service = await makeService(store, [provider]);

    const result = await Effect.runPromise(
      service.synchronizeConnection({
        connectionId: managedConnectionId,
        refresh: "RequestIfSupported",
      })
    );

    expect(result._tag).toBe("Success");
    expect(refreshAllowedBefore).toBeNull();
    expect(snapshotWrites).toBe(1);
  });

  it("isolates an unregistered provider failure from another enabled connection", async () => {
    const provider: BankProviderAdapter = {
      displayName: "Managed provider",
      id: managedProviderId,
      pendingTransactions: { _tag: "Unavailable" },
      readSnapshot: () => Effect.succeed({ accounts: [], pending: [], posted: [] }),
      refresh: { _tag: "ProviderManaged" },
    };
    const managedConnection = connection(
      managedConnectionId,
      managedProviderId
    );
    const missingConnection = connection(
      missingConnectionId,
      missingProviderId
    );
    const store: BankStoreService = {
      ...unusedStore(),
      acquireSync: () => Effect.void,
      completeSync: () => Effect.void,
      failSync: () => Effect.void,
      getConnection: (connectionId) =>
        Effect.succeed(
          connectionId === managedConnectionId
            ? managedConnection
            : missingConnection
        ),
      listConnections: Effect.succeed([managedConnection, missingConnection]),
      saveSnapshot: () => Effect.void,
    };
    const service = await makeService(store, [provider]);

    const outcomes = await Effect.runPromise(
      service.synchronizeEnabled({ refresh: "ReadAvailable" })
    );

    expect(outcomes).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          _tag: "Success",
          connectionId: managedConnectionId,
        }),
        expect.objectContaining({
          _tag: "Failure",
          connectionId: missingConnectionId,
          errorTag: "ProviderNotRegisteredError",
        }),
      ])
    );
  });
});
