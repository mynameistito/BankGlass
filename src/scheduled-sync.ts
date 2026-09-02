import { Effect, Result } from "effect";

import type { SyncServiceService } from "@/sync-service";

const isDeferralError = (error: { readonly _tag: string }) =>
  error._tag === "RefreshCooldownError" || error._tag === "SyncInProgressError";

/** Run the hourly synchronization while deferring to an existing refresh or sync. */
export const synchronizeScheduled = (service: SyncServiceService) =>
  Effect.gen(function* synchronizeScheduledSync() {
    const firstAttempt = yield* Effect.result(
      service.synchronize({ requestProviderRefresh: true })
    );
    if (Result.isSuccess(firstAttempt)) {
      return firstAttempt.success;
    }

    if (isDeferralError(firstAttempt.failure)) {
      yield* Effect.logInfo("Scheduled synchronization deferred", {
        errorTag: firstAttempt.failure._tag,
      });
      return;
    }

    yield* Effect.logWarning(
      "Scheduled synchronization failed; retrying in one minute",
      { errorTag: firstAttempt.failure._tag }
    );
    yield* Effect.sleep("1 minute");

    const refreshedRetry = yield* Effect.result(
      service.synchronize({ requestProviderRefresh: true })
    );
    if (Result.isSuccess(refreshedRetry)) {
      return refreshedRetry.success;
    }

    if (isDeferralError(refreshedRetry.failure)) {
      yield* Effect.logInfo("Scheduled synchronization deferred", {
        errorTag: refreshedRetry.failure._tag,
      });
      return;
    }

    yield* Effect.logWarning(
      "Scheduled refresh retry failed; synchronizing current provider cache",
      { errorTag: refreshedRetry.failure._tag }
    );
    return yield* service.synchronize({ requestProviderRefresh: false });
  });
