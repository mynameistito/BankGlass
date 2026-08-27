import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { BankProvider } from "../bank-provider";
import { BankStore } from "../bank-store";
import { SyncInProgressError } from "../errors";
import { makeSyncService } from "../sync-service";

describe("synchronization policy", () => {
  it("rejects a refresh inside the Personal App one-hour cooldown", async () => {
    let acquireCalls = 0;
    let failCalls = 0;
    let refreshCalls = 0;
    const events: string[] = [];
    const provider = BankProvider.of({
      getAccounts: Effect.succeed([]),
      getPendingTransactions: Effect.succeed([]),
      getTransactions: () => Effect.succeed([]),
      requestRefresh: Effect.sync(() => {
        refreshCalls += 1;
      }),
    });
    const store = BankStore.of({
      acquireSync: () =>
        Effect.gen(function* rejectAcquire() {
          acquireCalls += 1;
          events.push("acquire");
          return yield* Effect.fail(new SyncInProgressError({}));
        }),
      completeSync: () => Effect.void,
      consumeRateLimit: () => Effect.void,
      failSync: () =>
        Effect.sync(() => {
          failCalls += 1;
        }),
      getAccount: () => Effect.die("unused"),
      getSyncStatus: Effect.sync(() => {
        events.push("status");
        return {
          errorCode: null,
          errorMessage: null,
          lastAttemptAt: null,
          lastProviderRefreshRequestedAt: new Date().toISOString(),
          lastSuccessAt: null,
          providerRefreshedAt: null,
          startedAt: null,
          status: "idle",
        };
      }),
      listAccounts: Effect.succeed([]),
      listTransactions: () => Effect.succeed({ items: [], nextCursor: null }),
      markRefreshRequested: () => Effect.void,
      saveSnapshot: () => Effect.void,
    });
    const dependencies = Layer.merge(
      Layer.succeed(BankProvider, provider),
      Layer.succeed(BankStore, store)
    );
    const service = await Effect.runPromise(
      makeSyncService(3600, 14).pipe(Effect.provide(dependencies))
    );
    const error = await Effect.runPromise(
      Effect.flip(service.synchronize({ requestProviderRefresh: true }))
    );
    expect(error._tag).toBe("RefreshCooldownError");
    expect(acquireCalls).toBe(1);
    expect(events).toStrictEqual(["acquire", "status"]);
    expect(failCalls).toBe(0);
    expect(refreshCalls).toBe(0);
  });
});
