import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { BankProvider } from "@/bank-provider";
import { BankStore } from "@/bank-store";
import { makeSyncService } from "@/sync-service";

describe("provider capabilities", () => {
  it("synchronizes without calling refresh for a provider that cannot refresh", async () => {
    let refreshCalls = 0;
    let markRefreshCalls = 0;
    let refreshAllowedBefore: string | null | undefined;
    const provider = BankProvider.of({
      metadata: {
        displayName: "Revolut-compatible source",
        id: "revolut",
        supportsRefresh: false,
      },
      getAccounts: Effect.succeed([]),
      getPendingTransactions: Effect.succeed([]),
      getTransactions: () => Effect.succeed([]),
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
      saveSnapshot: () => Effect.void,
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

    expect(refreshAllowedBefore).toBeNull();
    expect(refreshCalls).toBe(0);
    expect(markRefreshCalls).toBe(0);
  });
});
