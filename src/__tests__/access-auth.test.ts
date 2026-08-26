import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { authenticateAccess } from "../access-auth";
import type { RuntimeConfig } from "../config";
import { fetchAccessJwks, makeAccessAssertion } from "./access-fixture";

const config = {
  accessAppHostname: "bank.example.test",
  accessAudience: "REPLACE_WITH_ACCESS_AUD",
  accessTeamDomain: "https://replace-with-team-name.cloudflareaccess.com",
  akahuAppToken: "unused",
  akahuUserToken: "unused",
  apiBaseUrl: "https://api.akahu.io/v1",
  apiBearerToken: "unused",
  apiRateLimitPerMinute: "60",
  refreshCooldownSeconds: "3600",
  syncLookbackDays: "14",
} satisfies RuntimeConfig;

describe("Cloudflare Access authentication", () => {
  it("accepts a correctly signed assertion with the configured issuer and audience", async () => {
    const request = new Request("https://bank.example.test/v1/accounts", {
      headers: { "Cf-Access-Jwt-Assertion": await makeAccessAssertion() },
    });
    await expect(
      Effect.runPromise(authenticateAccess(request, config, fetchAccessJwks))
    ).resolves.toBeUndefined();
  });

  it("rejects missing and invalid assertions as typed failures", async () => {
    const errors = await Promise.all(
      [null, "not-a-jwt"].map((assertion) => {
        const headers = new Headers();
        if (assertion !== null) {
          headers.set("Cf-Access-Jwt-Assertion", assertion);
        }
        return Effect.runPromise(
          Effect.flip(
            authenticateAccess(
              new Request("https://bank.example.test/v1/accounts", { headers }),
              config,
              fetchAccessJwks
            )
          )
        );
      })
    );
    expect(errors.map((error) => error._tag)).toStrictEqual([
      "UnauthorizedAccessRequestError",
      "UnauthorizedAccessRequestError",
    ]);
  });
});
