import { Effect, Fiber, Schema } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import { ConnectionIdSchema, ProviderIdSchema } from "@/domain/identifiers";
import { ProviderUnavailableError, RefreshCooldownError } from "@/errors";
import { synchronizeScheduled } from "@/scheduled-sync";
import type { SyncServiceService } from "@/sync-service";

const connectionId = Schema.decodeUnknownSync(ConnectionIdSchema)(
  "connection_scheduled_test"
);
const deferredConnectionId = Schema.decodeUnknownSync(ConnectionIdSchema)(
  "connection_scheduled_deferred"
);
const successfulConnectionId = Schema.decodeUnknownSync(ConnectionIdSchema)(
  "connection_scheduled_success"
);
const providerId = Schema.decodeUnknownSync(ProviderIdSchema)("scheduled");

const failure = (errorTag: string, id = connectionId) => ({
  _tag: "Failure" as const,
  connectionId: id,
  errorTag,
  providerId,
});

const successFor = (id = connectionId) => ({
  _tag: "Success" as const,
  accounts: 0,
  connectionId: id,
  pendingTransactions: 0,
  postedTransactions: 0,
  providerId,
  providerRefreshedAt: null,
  syncedAt: "1970-01-01T00:01:00.000Z",
});

const success = successFor();

const runAfterRetryDelay = (service: SyncServiceService) =>
  Effect.runPromise(
    Effect.gen(function* runScheduled() {
      const fiber = yield* synchronizeScheduled(service).pipe(Effect.forkChild);
      yield* TestClock.adjust("1 minute");
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestClock.layer()))
  );

describe("scheduled synchronization policy", () => {
  it("does not retry an active-lease deferral", async () => {
    let connectionCalls = 0;
    const service: SyncServiceService = {
      synchronizeConnection: () =>
        Effect.sync(() => {
          connectionCalls += 1;
          return success;
        }),
      synchronizeEnabled: () =>
        Effect.succeed([failure("SyncInProgressError")]),
    };
    const outcomes = await Effect.runPromise(synchronizeScheduled(service));
    expect({ connectionCalls, outcomes }).toStrictEqual({
      connectionCalls: 0,
      outcomes: [failure("SyncInProgressError")],
    });
  });

  it("reads provider cache immediately when the first pass hits refresh cooldown", async () => {
    const refreshModes: string[] = [];
    const service: SyncServiceService = {
      synchronizeConnection: ({ refresh }) =>
        Effect.sync(() => {
          refreshModes.push(refresh);
          return success;
        }),
      synchronizeEnabled: () =>
        Effect.succeed([failure("RefreshCooldownError")]),
    };
    const outcomes = await Effect.runPromise(synchronizeScheduled(service));
    expect({ outcomes, refreshModes }).toStrictEqual({
      outcomes: [success],
      refreshModes: ["ReadAvailable"],
    });
  });

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

    const outcomes = await runAfterRetryDelay(service);

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

    const outcomes = await runAfterRetryDelay(service);

    expect(refreshModes).toStrictEqual(["RequestIfSupported", "ReadAvailable"]);
    expect(outcomes).toStrictEqual([success]);
  });

  it("falls back to provider cache when the refresh retry hits cooldown", async () => {
    const refreshModes: string[] = [];
    const service: SyncServiceService = {
      synchronizeConnection: ({ refresh }) => {
        refreshModes.push(refresh);
        return refresh === "RequestIfSupported"
          ? Effect.fail(
              new RefreshCooldownError({
                retryAt: "1970-01-01T01:00:00.000Z",
              })
            )
          : Effect.succeed(success);
      },
      synchronizeEnabled: () =>
        Effect.succeed([failure("ProviderUnavailableError")]),
    };

    const outcomes = await runAfterRetryDelay(service);

    expect({ outcomes, refreshModes }).toStrictEqual({
      outcomes: [success],
      refreshModes: ["RequestIfSupported", "ReadAvailable"],
    });
  });

  it("retains success and deferral outcomes while replacing only retryable failures", async () => {
    const calls: string[] = [];
    const successful = successFor(successfulConnectionId);
    const deferred = failure("SyncInProgressError", deferredConnectionId);
    const service: SyncServiceService = {
      synchronizeConnection: ({ connectionId: id }) =>
        Effect.sync(() => {
          calls.push(id);
          return successFor(id);
        }),
      synchronizeEnabled: () =>
        Effect.succeed([
          successful,
          deferred,
          failure("ProviderUnavailableError"),
        ]),
    };

    const outcomes = await runAfterRetryDelay(service);

    expect({ calls, outcomes }).toStrictEqual({
      calls: [connectionId],
      outcomes: [successful, deferred, success],
    });
  });
});
