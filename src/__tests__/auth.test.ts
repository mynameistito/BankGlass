import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { authenticate } from "../auth";

describe("API authentication", () => {
  it("accepts the configured bearer token", async () => {
    await expect(
      Effect.runPromise(
        authenticate(
          new Request("https://example.test", {
            headers: { Authorization: "Bearer secret-token" },
          }),
          "secret-token"
        )
      )
    ).resolves.toBeUndefined();
  });

  it("returns a typed error for missing or wrong credentials", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        authenticate(new Request("https://example.test"), "secret-token")
      )
    );
    expect(error._tag).toBe("UnauthorizedApiRequestError");
  });
});
