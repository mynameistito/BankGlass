import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { applyD1Migrations, env } from "cloudflare:test";

interface TestBindings {
  readonly TEST_MIGRATIONS: D1Migration[];
}

// SAFETY: Vitest injects TEST_MIGRATIONS from vitest.config.ts before this setup module executes.
const testEnv = env as Cloudflare.Env & TestBindings;
await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
