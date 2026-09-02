import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import {
  ProviderUnavailableError,
  RefreshCooldownError,
  SyncInProgressError,
} from "@/errors";
import { synchronizeScheduled } from "@/scheduled-sync";

const expectDeferral = async (
  error: RefreshCooldownError | SyncInProgressError
) => {
  let calls = 0;
  const refreshOptions: boolean[] = [];
  const service = {
    synchronize: (options: { readonly requestProviderRefresh: boolean }) =>
      Effect.gen(function* synchronize() {
        calls += 1;
        refreshOptions.push(options.requestProviderRefresh);
        return yield* Effect.fail(error);
      }),
  };

  await Effect.runPromise(synchronizeScheduled(service));

  expect(calls).toBe(1);
  expect(refreshOptions).toStrictEqual([true]);
};

const expectRetryDeferral = async (
  error: RefreshCooldownError | SyncInProgressError
) => {
  let calls = 0;
  const refreshOptions: boolean[] = [];
  const service = {
    synchronize: (options: { readonly requestProviderRefresh: boolean }) =>
      Effect.gen(function* synchronize() {
        calls += 1;
        refreshOptions.push(options.requestProviderRefresh);
        return yield* Effect.fail(
          calls === 1
            ? new ProviderUnavailableError({
                cause: new TypeError("temporary provider failure"),
                operation: "getAccounts",
              })
            : error
        );
      }),
  };

  await Effect.runPromise(
    Effect.gen(function* retryAfterDelay() {
      const fiber = yield* synchronizeScheduled(service).pipe(Effect.forkChild);
      yield* TestClock.adjust("1 minute");
      yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestClock.layer()))
  );

  expect(calls).toBe(2);
  expect(refreshOptions).toStrictEqual([true, true]);
};

describe("scheduled synchronization policy", () => {
  it("defers when a refresh is still inside its cooldown", async () => {
    expect.hasAssertions();
    await expectDeferral(
      new RefreshCooldownError({ retryAt: "2026-09-02T09:17:00.000Z" })
    );
  });

  it("defers while another synchronization owns the lease", async () => {
    expect.hasAssertions();
    await expectDeferral(new SyncInProgressError({}));
  });

  it("defers when the refresh retry enters its cooldown", async () => {
    expect.hasAssertions();
    await expectRetryDeferral(
      new RefreshCooldownError({ retryAt: "2026-09-02T09:17:00.000Z" })
    );
  });

  it("defers when another synchronization starts before the refresh retry", async () => {
    expect.hasAssertions();
    await expectRetryDeferral(new SyncInProgressError({}));
  });
});
