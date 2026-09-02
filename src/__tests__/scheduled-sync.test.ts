import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { RefreshCooldownError, SyncInProgressError } from "@/errors";
import { synchronizeScheduled } from "@/scheduled-sync";

const expectDeferral = async (
  error: RefreshCooldownError | SyncInProgressError
) => {
  let calls = 0;
  const service = {
    synchronize: () =>
      Effect.gen(function* synchronize() {
        calls += 1;
        return yield* Effect.fail(error);
      }),
  };

  await Effect.runPromise(synchronizeScheduled(service));

  expect(calls).toBe(1);
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
});
