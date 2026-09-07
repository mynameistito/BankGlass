import { Effect, Fiber, Schema } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import {
  ConnectionIdSchema,
  ProviderIdSchema,
} from "@/domain/identifiers";
import { ProviderUnavailableError } from "@/errors";
import { synchronizeScheduled } from "@/scheduled-sync";
import type { SyncServiceService } from "@/sync-service";

const connectionId = Schema.decodeUnknownSync(ConnectionIdSchema)(
  "connection_scheduled_test"
);
const providerId = Schema.decodeUnknownSync(ProviderIdSchema)("scheduled");

const failure = (errorTag: string) => ({
  _tag: "Failure" as const,
  connectionId,
  errorTag,
  providerId,
});

const success = {
  _tag: "Success" as const,
  accounts: 0,
  connectionId,
  pendingTransactions: 0,
  postedTransactions: 0,
  providerId,
  providerRefreshedAt: null,
  syncedAt: "1970-01-01T00:01:00.000Z",
};

describe("scheduled synchronization policy", () => {
  it.each(["RefreshCooldownError", "SyncInProgressError"])(
    "does not retry a %s deferral",
    async (errorTag) => {
      let connectionCalls = 0;
      const service: SyncServiceService = {
        synchronizeConnection: () =>
          Effect.sync(() => {
            connectionCalls += 1;
            return success;
          }),
        synchronizeEnabled: () => Effect.succeed([failure(errorTag)]),
      };

      const outcomes = await Effect.runPromise(synchronizeScheduled(service));

      expect(outcomes).toStrictEqual([failure(errorTag)]);
      expect(connectionCalls).toBe(0);
    }
  );

  it("retries a failed connection and keeps a successful retry", async () => {
    const refreshModes: string[] = [];
    const service: SyncServiceService = {
      synchronizeConnection: ({ refresh }) =>
        Effect.sync(() => {
          refreshModes.push(refresh);
          return success;
        }),
      synchronizeEnabled: () =>
        Effect.succeed([failure("ProviderUnavailableError")]),
    };

    const outcomes = await Effect.runPromise(
      Effect.gen(function* runScheduled() {
        const fiber = yield* synchronizeScheduled(service).pipe(Effect.forkChild);
        yield* TestClock.adjust("1 minute");
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestClock.layer()))
    );

    expect(refreshModes).toStrictEqual(["RequestIfSupported"]);
    expect(outcomes).toStrictEqual([success]);
  });

  it("falls back to provider cache after a failed refresh retry", async () => {
    const refreshModes: string[] = [];
    const service: SyncServiceService = {
      synchronizeConnection: ({ refresh }) => {
        refreshModes.push(refresh);
        return refresh === "RequestIfSupported"
          ? Effect.fail(
              new ProviderUnavailableError({
                cause: "temporary",
                operation: "refresh",
              })
            )
          : Effect.succeed(success);
      },
      synchronizeEnabled: () =>
        Effect.succeed([failure("ProviderUnavailableError")]),
    };

    const outcomes = await Effect.runPromise(
      Effect.gen(function* runScheduled() {
        const fiber = yield* synchronizeScheduled(service).pipe(Effect.forkChild);
        yield* TestClock.adjust("1 minute");
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestClock.layer()))
    );

    expect(refreshModes).toStrictEqual([
      "RequestIfSupported",
      "ReadAvailable",
    ]);
    expect(outcomes).toStrictEqual([success]);
  });
});
