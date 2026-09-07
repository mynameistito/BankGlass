import { Effect, Result } from "effect";

import type { ConnectionSyncOutcome } from "@/domain/sync";
import type { SyncServiceService } from "@/sync-service";

type FailedConnectionSync = Extract<
  ConnectionSyncOutcome,
  { readonly _tag: "Failure" }
>;

const isDeferralTag = (errorTag: string) =>
  errorTag === "RefreshCooldownError" || errorTag === "SyncInProgressError";

const failureOutcome = (
  original: FailedConnectionSync,
  errorTag: string
): ConnectionSyncOutcome => ({
  _tag: "Failure",
  connectionId: original.connectionId,
  errorTag,
  providerId: original.providerId,
});

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
    if (isDeferralTag(refreshed.failure._tag)) {
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
    return yield* service
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
  });

const isRetryableFailure = (
  outcome: ConnectionSyncOutcome
): outcome is FailedConnectionSync =>
  outcome._tag === "Failure" && !isDeferralTag(outcome.errorTag);

/**
 * Run scheduled synchronization across enabled connections with isolated retries.
 *
 * Deferrals caused by a connection refresh cooldown or active lease are left alone.
 * Other failed connections retry once after one minute and then fall back to reading
 * the provider's currently available cache without requesting another refresh.
 */
export const synchronizeScheduled = (service: SyncServiceService) =>
  Effect.gen(function* synchronizeScheduledSync() {
    const first = yield* service.synchronizeEnabled({
      refresh: "RequestIfSupported",
    });
    const retryable = first.filter(isRetryableFailure);

    for (const outcome of first) {
      if (outcome._tag === "Failure" && isDeferralTag(outcome.errorTag)) {
        yield* Effect.logInfo("Scheduled connection synchronization deferred", {
          connectionId: outcome.connectionId,
          errorTag: outcome.errorTag,
          providerId: outcome.providerId,
        });
      }
    }

    if (retryable.length === 0) {
      return first;
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
    const retriedIds = new Set(retryable.map((outcome) => outcome.connectionId));
    const retained: ConnectionSyncOutcome[] = [];
    for (const outcome of first) {
      if (!retriedIds.has(outcome.connectionId)) {
        retained.push(outcome);
      }
    }
    return [...retained, ...retries];
  });
