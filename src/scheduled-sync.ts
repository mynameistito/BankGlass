import { Effect } from "effect";

import type { ConnectionSyncOutcome } from "@/domain/sync";
import type { SyncServiceService } from "@/sync-service";

const isDeferralTag = (errorTag: string) =>
  errorTag === "RefreshCooldownError" || errorTag === "SyncInProgressError";

const failureOutcome = (
  original: Extract<ConnectionSyncOutcome, { readonly _tag: "Failure" }>,
  errorTag: string
): ConnectionSyncOutcome => ({
  _tag: "Failure",
  connectionId: original.connectionId,
  errorTag,
  providerId: original.providerId,
});

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
    const retryable = first.filter(
      (
        outcome
      ): outcome is Extract<
        ConnectionSyncOutcome,
        { readonly _tag: "Failure" }
      > => outcome._tag === "Failure" && !isDeferralTag(outcome.errorTag)
    );

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

    const retries = yield* Effect.forEach(
      retryable,
      (original) =>
        service
          .synchronizeConnection({
            connectionId: original.connectionId,
            refresh: "RequestIfSupported",
          })
          .pipe(
            Effect.catchAll((refreshError) => {
              if (isDeferralTag(refreshError._tag)) {
                return Effect.succeed(
                  failureOutcome(original, refreshError._tag)
                );
              }
              return Effect.gen(function* readAvailableFallback() {
                yield* Effect.logWarning(
                  "Scheduled refresh retry failed; reading current provider cache",
                  {
                    connectionId: original.connectionId,
                    errorTag: refreshError._tag,
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
                      onFailure: (error) =>
                        failureOutcome(original, error._tag),
                      onSuccess: (success): ConnectionSyncOutcome => success,
                    })
                  );
              });
            })
          ),
      { concurrency: 4 }
    );

    const retriedIds = new Set(retryable.map((outcome) => outcome.connectionId));
    return [
      ...first.filter((outcome) => !retriedIds.has(outcome.connectionId)),
      ...retries,
    ];
  });
