import { Effect, Layer } from "effect";

import { authenticateAccess } from "./access-auth";
import { AkahuBankProviderLive } from "./akahu-provider";
import { BankStore } from "./bank-store";
import { parseConfig } from "./config";
import type { WorkerSecrets } from "./config";
import { D1BankStoreLive } from "./d1-bank-store";
import { routeRequest } from "./http-api";
import { routeMcpRequest } from "./mcp-api";
import { SyncService, makeSyncService } from "./sync-service";

const programLayer = (
  env: Env & WorkerSecrets,
  cooldown: number,
  lookback: number
) => {
  const dependencies = Layer.merge(
    D1BankStoreLive(env.DB),
    AkahuBankProviderLive({
      appToken: env.AKAHU_APP_TOKEN,
      baseUrl: env.AKAHU_API_BASE_URL,
      userToken: env.AKAHU_USER_TOKEN,
    })
  );
  return Layer.merge(
    dependencies,
    Layer.effect(SyncService, makeSyncService(cooldown, lookback)).pipe(
      Layer.provide(dependencies)
    )
  );
};

const accessDeniedResponse = () =>
  Response.json(
    {
      error: {
        code: "UNAUTHORIZED_ACCESS_REQUEST",
        message: "Cloudflare Access authentication is required",
      },
    },
    {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      },
      status: 403,
    }
  );

const internalErrorResponse = () =>
  Response.json(
    {
      error: {
        code: "INTERNAL_ERROR",
        message: "Request could not be completed",
      },
    },
    { headers: { "Cache-Control": "no-store" }, status: 500 }
  );

const rateLimitedResponse = (retryAfterSeconds: number) =>
  Response.json(
    {
      error: {
        code: "API_RATE_LIMIT",
        message: "Request could not be completed",
      },
    },
    {
      headers: {
        "Cache-Control": "no-store",
        "Retry-After": String(retryAfterSeconds),
      },
      status: 429,
    }
  );

const run = (request: Request, env: Env & WorkerSecrets) =>
  Effect.gen(function* runRequest() {
    const config = yield* parseConfig(env);
    return yield* Effect.gen(function* authenticatedRequest() {
      yield* authenticateAccess(request, config);
      if (new URL(request.url).pathname === "/mcp") {
        const store = yield* BankStore;
        const nowSeconds = Math.floor(Date.now() / 1000);
        return yield* Effect.gen(function* limitedMcpRequest() {
          const rateLimit = yield* Effect.either(
            store.consumeRateLimit(
              `mcp:${Math.floor(nowSeconds / 60)}`,
              nowSeconds,
              Number(config.apiRateLimitPerMinute)
            )
          );
          if (rateLimit._tag === "Left") {
            return rateLimit.left._tag === "ApiRateLimitError"
              ? rateLimitedResponse(rateLimit.left.retryAfterSeconds)
              : internalErrorResponse();
          }
          return yield* Effect.tryPromise({
            catch: () => new TypeError("MCP request failed"),
            try: () =>
              routeMcpRequest(request, store, config.accessAppHostname),
          }).pipe(
            Effect.catchAll(() => Effect.succeed(internalErrorResponse()))
          );
        });
      }
      return yield* routeRequest(request, config);
    }).pipe(
      Effect.provide(
        programLayer(
          env,
          Number(config.refreshCooldownSeconds),
          Number(config.syncLookbackDays)
        )
      )
    );
  }).pipe(
    Effect.catchTag("UnauthorizedAccessRequestError", () =>
      Effect.succeed(accessDeniedResponse())
    ),
    Effect.catchAll(() =>
      Effect.succeed(
        Response.json(
          {
            error: {
              code: "CONFIGURATION_ERROR",
              message: "Service configuration is invalid",
            },
          },
          { status: 500 }
        )
      )
    )
  );

export default {
  fetch: (request: Request, env: Env) =>
    Effect.runPromise(run(request, env as Env & WorkerSecrets)),
  scheduled: (
    _controller: ScheduledController,
    env: Env,
    context: ExecutionContext
  ) => {
    const secrets = env as Env & WorkerSecrets;
    const sync = Effect.gen(function* sync() {
      yield* parseConfig(secrets);
      const service = yield* SyncService;
      yield* service.synchronize({ requestProviderRefresh: true });
    }).pipe(
      Effect.provide(
        programLayer(
          secrets,
          Number(secrets.REFRESH_COOLDOWN_SECONDS),
          Number(secrets.SYNC_LOOKBACK_DAYS)
        )
      ),
      Effect.catchAll((error) =>
        Effect.logError("Scheduled synchronization failed", {
          errorTag: error._tag,
        })
      )
    );
    context.waitUntil(Effect.runPromise(sync));
  },
} satisfies ExportedHandler<Env>;
