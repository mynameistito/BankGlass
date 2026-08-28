import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/index.ts",
      miniflare: {
        bindings: {
          ACCESS_APP_HOSTNAME: "replace-with-custom-hostname",
          ACCESS_POLICY_AUD: "REPLACE_WITH_ACCESS_AUD",
          ACCESS_TEAM_DOMAIN:
            "https://replace-with-team-name.cloudflareaccess.com",
          AKAHU_API_BASE_URL: "https://api.akahu.io/v1",
          AKAHU_APP_TOKEN: "test-akahu-app-token",
          AKAHU_USER_TOKEN: "test-akahu-user-token",
          API_BEARER_TOKEN: "test-api-bearer-token",
          API_RATE_LIMIT_PER_MINUTE: "60",
          REFRESH_COOLDOWN_SECONDS: "3600",
          SYNC_LOOKBACK_DAYS: "14",
          TEST_MIGRATIONS: migrations,
        },
        // The test pool's bundled workerd trails today's production compatibility date by four days.
        compatibilityDate: "2026-08-22",
        d1Databases: { DB: "bankglass-test" },
        durableObjects: {
          BANK_STORE: { className: "BankStoreDO", useSQLite: true },
        },
      },
    }),
  ],
  test: {
    setupFiles: ["./src/__tests__/setup.ts"],
  },
});
