import { Stack } from "alchemy";
import type { InferEnv } from "alchemy/Cloudflare";
import {
  DurableObject as DurableObjectResource,
  Worker as WorkerResource,
  providers,
  state,
} from "alchemy/Cloudflare";
import { Config, Effect } from "effect";

// The deploy action sets STAGE before invoking Alchemy so preview resources
// receive the same stable names as the action's preview URL matcher.
const stage = process.env["STAGE"];
if (!stage) {
  throw new Error("STAGE must be set explicitly before deploying");
}
const isProduction = stage === "prod";

export const Worker = Effect.gen(function* defineWorker() {
  const bankStore = DurableObjectResource("BANK_STORE", {
    className: "BankStoreDO",
  });

  return yield* WorkerResource("Worker", {
    compatibility: {
      date: "2026-07-11",
      flags: ["nodejs_compat"],
    },
    crons: isProduction ? ["17 3 * * *"] : [],
    domain: isProduction ? "bank.honetito.com" : null,
    env: {
      ACCESS_APP_HOSTNAME: Config.string("ACCESS_APP_HOSTNAME"),
      ACCESS_POLICY_AUD: Config.string("ACCESS_POLICY_AUD"),
      ACCESS_TEAM_DOMAIN: Config.string("ACCESS_TEAM_DOMAIN"),
      AKAHU_API_BASE_URL: Config.string("AKAHU_API_BASE_URL").pipe(
        Config.orElse(() => Config.succeed("https://api.akahu.io/v1"))
      ),
      AKAHU_APP_TOKEN: Config.redacted("AKAHU_APP_TOKEN"),
      AKAHU_USER_TOKEN: Config.redacted("AKAHU_USER_TOKEN"),
      API_BEARER_TOKEN: Config.redacted("API_BEARER_TOKEN"),
      API_RATE_LIMIT_PER_MINUTE: Config.string(
        "API_RATE_LIMIT_PER_MINUTE"
      ).pipe(Config.orElse(() => Config.succeed("60"))),
      BANK_STORE: bankStore,
      REFRESH_COOLDOWN_SECONDS: Config.string("REFRESH_COOLDOWN_SECONDS").pipe(
        Config.orElse(() => Config.succeed("3600"))
      ),
      SYNC_LOOKBACK_DAYS: Config.string("SYNC_LOOKBACK_DAYS").pipe(
        Config.orElse(() => Config.succeed("14"))
      ),
    },
    main: "./src/index.ts",
    name: isProduction ? "bankglass" : `bankglass-${stage}`,
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
  Effect.gen(function* defineStack() {
    const worker = yield* Worker;

    return {
      url: worker.url,
    };
  })
);

export type WorkerEnv = InferEnv<typeof Worker>;
