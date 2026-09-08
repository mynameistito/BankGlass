import { Effect, Result } from "effect";

import type { ConnectionSyncOutcome } from "@/domain/sync";
import type { SyncServiceService } from "@/sync-service";

type FailedConnectionSync = Extract<
  ConnectionSyncOutcome,
  { readonly _tag: "Failure" }
>;

const failureOutcome = (
  original: FailedConnectionSync,
  errorTag: string
): ConnectionSyncOutcome => ({
  _tag: "Failure",
  connectionId: original.connectionId,
  errorTag,
  providerId: original.providerId,
});

const readAvailableConnection = (
  service: SyncServiceService,
  original: FailedConnectionSync
) =>
  service
    .synchronizeConnection({
      connectionId: original.connectionId,
      refresh: "ReadAvailable",
    })
    .pipe(
      Effect.match({
        onFailure: (error) => failureOutcome(original, error._tag),
        onSuccess: (success): ConnectionSyncOutcome => success,
      })
    );

const retryConnection = (
  service: SyncServiceService,
  original: FailedConnectionSync
) =>
  Effect.gen(function* retryFailedConnection() {
    const refreshed = yield* Effect.result(
      service.synchronizeConnection({
        connectionId: original.connectionId,
        refresh: "RequestIfSupported",
      })
    );
    if (Result.isSuccess(refreshed)) {
      return refreshed.success;
    }
    if (refreshed.failure._tag === "SyncInProgressError") {
      return failureOutcome(original, refreshed.failure._tag);
    }
    yield* Effect.logWarning(
      "Scheduled refresh retry failed; reading current provider cache",
      {
        connectionId: original.connectionId,
        errorTag: refreshed.failure._tag,
        providerId: original.providerId,
      }
    );
    return yield* readAvailableConnection(service, original);
  });

const isRetryableFailure = (
  outcome: ConnectionSyncOutcome
): outcome is FailedConnectionSync =>
  outcome._tag === "Failure" && outcome.errorTag !== "SyncInProgressError";

/** Run scheduled synchronization across enabled connections with isolated retries. */
export const synchronizeScheduled = (service: SyncServiceService) =>
  Effect.gen(function* synchronizeScheduledSync() {
    const first = yield* service.synchronizeEnabled({
      refresh: "RequestIfSupported",
    });
    const afterCooldownFallback = yield* Effect.all(
      first.map((outcome) => {
        if (
          outcome._tag !== "Failure" ||
          outcome.errorTag !== "RefreshCooldownError"
        ) {
          return Effect.succeed(outcome);
        }
        return Effect.logInfo(
          "Scheduled refresh deferred; reading current provider cache",
          {
            connectionId: outcome.connectionId,
            providerId: outcome.providerId,
          }
        ).pipe(Effect.andThen(readAvailableConnection(service, outcome)));
      }),
      { concurrency: 4 }
    );
    const retryable = afterCooldownFallback.filter(isRetryableFailure);
    for (const outcome of afterCooldownFallback) {
      if (
        outcome._tag === "Failure" &&
        outcome.errorTag === "SyncInProgressError"
      ) {
        yield* Effect.logInfo("Scheduled connection synchronization deferred", {
          connectionId: outcome.connectionId,
          errorTag: outcome.errorTag,
          providerId: outcome.providerId,
        });
      }
    }
    if (retryable.length === 0) {
      return afterCooldownFallback;
    }
    yield* Effect.logWarning(
      "Scheduled connection synchronization failed; retrying failed connections in one minute",
      { failedConnections: retryable.length }
    );
    yield* Effect.sleep("1 minute");
    const retries = yield* Effect.all(
      retryable.map((original) => retryConnection(service, original)),
      { concurrency: 4 }
    );
    const retriedIds = new Set(
      retryable.map((outcome) => outcome.connectionId)
    );
    return [
      ...afterCooldownFallback.filter(
        (outcome) => !retriedIds.has(outcome.connectionId)
      ),
      ...retries,
    ];
  });
