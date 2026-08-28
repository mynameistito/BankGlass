import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { parseConfig } from "../config";

const validEnv = {
  ACCESS_APP_HOSTNAME: "bank.example.test",
  ACCESS_POLICY_AUD: "test-access-audience",
  ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
  AKAHU_API_BASE_URL: "https://api.akahu.io/v1",
  AKAHU_APP_TOKEN: "test-akahu-app-token",
  AKAHU_USER_TOKEN: "test-akahu-user-token",
  API_BEARER_TOKEN: "test-api-bearer-token",
  API_RATE_LIMIT_PER_MINUTE: "60",
  REFRESH_COOLDOWN_SECONDS: "3600",
  SYNC_LOOKBACK_DAYS: "14",
};

const parse = (overrides: Partial<typeof validEnv> = {}) =>
  Effect.runPromise(parseConfig({ ...validEnv, ...overrides }));

describe("runtime configuration", () => {
  it("accepts valid credentials and the default Akahu URL", async () => {
    await expect(parse()).resolves.toMatchObject({
      akahuAppToken: validEnv.AKAHU_APP_TOKEN,
      akahuUserToken: validEnv.AKAHU_USER_TOKEN,
      apiBaseUrl: validEnv.AKAHU_API_BASE_URL,
      apiBearerToken: validEnv.API_BEARER_TOKEN,
    });
  });

  it.each(["AKAHU_APP_TOKEN", "AKAHU_USER_TOKEN", "API_BEARER_TOKEN"] as const)(
    "rejects an empty %s",
    async (name) => {
      await expect(parse({ [name]: "" })).rejects.toMatchObject({
        message: "Worker configuration is missing or invalid",
      });
    }
  );

  it.each(["not-a-url", `http${"://api.akahu.io/v1"}`])(
    "rejects an invalid Akahu API URL: %s",
    async (url) => {
      await expect(parse({ AKAHU_API_BASE_URL: url })).rejects.toMatchObject({
        message: "Worker configuration is missing or invalid",
      });
    }
  );

  it("accepts a valid HTTPS Akahu API URL", async () => {
    await expect(
      parse({ AKAHU_API_BASE_URL: "https://provider.example.test/api" })
    ).resolves.toMatchObject({
      apiBaseUrl: "https://provider.example.test/api",
    });
  });
});
