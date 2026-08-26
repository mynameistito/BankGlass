import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        bindings: {
          ACCESS_APP_HOSTNAME: "replace-with-custom-hostname",
          ACCESS_POLICY_AUD: "REPLACE_WITH_ACCESS_AUD",
          ACCESS_TEAM_DOMAIN:
            "https://replace-with-team-name.cloudflareaccess.com",
          AKAHU_APP_TOKEN: "test-akahu-app-token",
          AKAHU_USER_TOKEN: "test-akahu-user-token",
          API_BEARER_TOKEN: "test-api-bearer-token",
          TEST_MIGRATIONS: migrations,
        },
        // The test pool's bundled workerd trails today's production compatibility date by four days.
        compatibilityDate: "2026-08-22",
      },
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  test: {
    setupFiles: ["./src/__tests__/setup.ts"],
  },
});
