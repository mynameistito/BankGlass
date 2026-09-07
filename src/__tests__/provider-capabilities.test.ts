import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { BankProvider } from "@/bank-provider";
import { BankStore } from "@/bank-store";
import { makeSyncService } from "@/sync-service";

describe("provider capabilities", () => {
  it("synchronizes data without calling refresh for a provider that cannot refresh", async () => {
    let accountReads = 0;
    let markRefreshCalls = 0;
    let pendingReads = 0;
    let postedReads = 0;
    let refreshAllowedBefore: string | null | undefined;
    let refreshCalls = 0;
    let snapshotWrites = 0;
    const provider = BankProvider.of({
      getAccounts: Effect.sync(() => {
        accountReads += 1;
        return [];
      }),
      getPendingTransactions: Effect.sync(() => {
        pendingReads += 1;
        return [];
      }),
      getTransactions: () =>
        Effect.sync(() => {
          postedReads += 1;
          return [];
        }),
      metadata: {
        displayName: "Revolut-compatible source",
        id: "revolut",
        supportsRefresh: false,
      },
      requestRefresh: Effect.sync(() => {
        refreshCalls += 1;
      }),
    });
    const store = BankStore.of({
      acquireSync: (_startedAt, _leaseId, allowedBefore) =>
        Effect.sync(() => {
          refreshAllowedBefore = allowedBefore;
        }),
      completeSync: () => Effect.void,
      consumeRateLimit: () => Effect.void,
      failSync: () => Effect.void,
      getAccount: () => Effect.die("unused"),
      getSyncStatus: Effect.die("unused"),
      listAccounts: Effect.succeed([]),
      listTransactions: () => Effect.succeed({ items: [], nextCursor: null }),
      markRefreshRequested: () =>
        Effect.sync(() => {
          markRefreshCalls += 1;
        }),
      saveSnapshot: () =>
        Effect.sync(() => {
          snapshotWrites += 1;
        }),
    });
    const dependencies = Layer.merge(
      Layer.succeed(BankProvider, provider),
      Layer.succeed(BankStore, store)
    );
    const service = await Effect.runPromise(
      makeSyncService(3600, 14).pipe(Effect.provide(dependencies))
    );

    await Effect.runPromise(
      service.synchronize({ requestProviderRefresh: true })
    );

    expect({
      accountReads,
      markRefreshCalls,
      pendingReads,
      postedReads,
      refreshAllowedBefore,
      refreshCalls,
      snapshotWrites,
    }).toStrictEqual({
      accountReads: 1,
      markRefreshCalls: 0,
      pendingReads: 1,
      postedReads: 1,
      refreshAllowedBefore: null,
      refreshCalls: 0,
      snapshotWrites: 1,
    });
  });
});
