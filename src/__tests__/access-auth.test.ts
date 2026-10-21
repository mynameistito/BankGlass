import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  fetchAccessJwks,
  makeAccessAssertion,
} from "@/__tests__/access-fixture";
import { authenticateAccess } from "@/access-auth";
import type { RuntimeConfig } from "@/config";

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
  it("allows loopback requests when Alchemy's local Access stub is enabled", async () => {
    await expect(
      Effect.runPromise(
        authenticateAccess(
          new Request("http://localhost:1337/v1/accounts"),
          config,
          fetchAccessJwks,
          true
        )
      )
    ).resolves.toBeUndefined();
  });

  it("does not bypass Access for non-loopback requests", async () => {
    const result = await Effect.runPromise(
      Effect.flip(
        authenticateAccess(
          new Request("https://bank.example.test/v1/accounts"),
          config,
          fetchAccessJwks,
          true
        )
      )
    );

    expect(result._tag).toBe("UnauthorizedAccessRequestError");
  });

  it("accepts a correctly signed assertion with the configured issuer and audience", async () => {
    const request = new Request("https://bank.example.test/v1/accounts", {
      headers: { "Cf-Access-Jwt-Assertion": await makeAccessAssertion() },
    });

    await expect(
      Effect.runPromise(authenticateAccess(request, config, fetchAccessJwks))
    ).resolves.toBeUndefined();
  });

  it("reuses the JWKS resolver for repeated requests", async () => {
    let fetchCount = 0;

    const countingFetch: typeof fetch = async (...args) => {
      fetchCount += 1;

      return await fetchAccessJwks(...args);
    };

    const assertion = await makeAccessAssertion();

    const request = () =>
      new Request("https://bank.example.test/v1/accounts", {
        headers: { "Cf-Access-Jwt-Assertion": assertion },
      });

    await expect(
      Effect.runPromise(authenticateAccess(request(), config, countingFetch))
    ).resolves.toBeUndefined();
    await expect(
      Effect.runPromise(authenticateAccess(request(), config, countingFetch))
    ).resolves.toBeUndefined();

    expect(fetchCount).toBe(1);
  });

  it("rejects missing and invalid assertions as typed failures", async () => {
    const errors = await Promise.all(
      [null, "not-a-jwt"].map(async (assertion) => {
        const headers = new Headers();

        if (assertion !== null) {
          headers.set("Cf-Access-Jwt-Assertion", assertion);
        }

        return await Effect.runPromise(
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
