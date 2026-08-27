import { Stack } from "alchemy";
import type { InferEnv } from "alchemy/Cloudflare";
import {
  D1,
  Worker as WorkerResource,
  providers,
  state,
} from "alchemy/Cloudflare";
import { redacted, string } from "effect/Config";
import { gen } from "effect/Effect";

// The deploy action sets STAGE before invoking Alchemy so preview resources
// receive the same stable names as the action's preview URL matcher.
const stage = process.env["STAGE"] ?? "prod";
const isProduction = stage === "prod";

export const Worker = gen(function* defineWorker() {
  const database = yield* D1.Database("Database", {
    migrations: "./migrations",
    name: isProduction ? "bankglass" : `bankglass-${stage}`,
  });

  return yield* WorkerResource("Worker", {
    compatibility: {
      date: "2026-08-26",
      flags: ["nodejs_compat"],
    },
    crons: ["17 3 * * *"],
    domain: isProduction ? "bank.honetito.com" : null,
    env: {
      ACCESS_APP_HOSTNAME: string("ACCESS_APP_HOSTNAME"),
      ACCESS_POLICY_AUD: string("ACCESS_POLICY_AUD"),
      ACCESS_TEAM_DOMAIN: string("ACCESS_TEAM_DOMAIN"),
      AKAHU_API_BASE_URL: string("AKAHU_API_BASE_URL"),
      AKAHU_APP_TOKEN: redacted("AKAHU_APP_TOKEN"),
      AKAHU_USER_TOKEN: redacted("AKAHU_USER_TOKEN"),
      API_BEARER_TOKEN: redacted("API_BEARER_TOKEN"),
      API_RATE_LIMIT_PER_MINUTE: string("API_RATE_LIMIT_PER_MINUTE"),
      DB: database,
      REFRESH_COOLDOWN_SECONDS: string("REFRESH_COOLDOWN_SECONDS"),
      SYNC_LOOKBACK_DAYS: string("SYNC_LOOKBACK_DAYS"),
    },
    main: "./src/index.ts",
    name: `bankglass-${stage}`,
    observability: {
      enabled: true,
      logs: { enabled: true, headSamplingRate: 1, invocationLogs: true },
      traces: { enabled: true, headSamplingRate: 0.1 },
    },
    workersDev: !isProduction,
  });
});

export default Stack(
  "BankGlass",
  {
    providers: providers(),
    state: state(),
  },
  gen(function* defineStack() {
    const worker = yield* Worker;

    return {
      url: worker.url,
    };
  })
);

export type WorkerEnv = InferEnv<typeof Worker>;
