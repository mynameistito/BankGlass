import { Effect, Layer, Redacted, Result } from "effect";

import { authenticateAccess } from "@/access-auth";
import type { WorkerEnv } from "@/alchemy.run";
import { BankStore } from "@/bank-store";
import { doBankStoreLive } from "@/bank-store-do";
import { parseConfig } from "@/config";
import { routeRequest } from "@/http-api";
import { routeMcpRequest } from "@/mcp-api";
import { providerRegistryLayer } from "@/provider-registry";
import { makeAkahuProvider } from "@/providers/akahu/provider";
import { synchronizeScheduled } from "@/scheduled-sync";
import { SyncService, syncServiceLive } from "@/sync-service";

/** Durable Object class exported for the Worker binding. */
export { BankStoreDO } from "@/bank-store-do";

const previewProviderSentinel = "preview-provider-disabled";

const programLayer = (env: WorkerEnv, lookbackDays: number) => {
  const storeLayer = doBankStoreLive(env.BANK_STORE);
  const providers =
    env.AKAHU_APP_TOKEN === previewProviderSentinel ||
    env.AKAHU_USER_TOKEN === previewProviderSentinel
      ? []
      : [
          makeAkahuProvider({
            appToken: Redacted.make(env.AKAHU_APP_TOKEN),
            baseUrl: env.AKAHU_API_BASE_URL,
            userToken: Redacted.make(env.AKAHU_USER_TOKEN),
          }),
        ];
  const registryLayer = providerRegistryLayer(providers);
  const dependencies = Layer.merge(storeLayer, registryLayer);
  const synchronization = syncServiceLive(lookbackDays).pipe(
    Layer.provide(dependencies)
  );
  return Layer.merge(dependencies, synchronization);
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

const runMcpRequest = (
  request: Request,
  store: ReturnType<typeof BankStore.of>,
  hostname: string
) =>
  Effect.tryPromise({
    catch: () => new TypeError("MCP request failed"),
    try: () => routeMcpRequest(request, store, hostname),
  });

const run = (request: Request, env: WorkerEnv) =>
  Effect.gen(function* runRequest() {
    const config = yield* parseConfig(env);
    return yield* Effect.gen(function* authenticatedRequest() {
      yield* authenticateAccess(request, config);
      if (new URL(request.url).pathname === "/mcp") {
        const store = yield* BankStore;
        const nowSeconds = Math.floor(Date.now() / 1000);
        return yield* Effect.gen(function* limitedMcpRequest() {
          const rateLimit = yield* Effect.result(
            store.consumeRateLimit(
              `mcp:${Math.floor(nowSeconds / 60)}`,
              nowSeconds,
              Number(config.apiRateLimitPerMinute)
            )
          );
          if (Result.isFailure(rateLimit)) {
            return rateLimit.failure._tag === "ApiRateLimitError"
              ? rateLimitedResponse(rateLimit.failure.retryAfterSeconds)
              : internalErrorResponse();
          }
          const response = yield* Effect.result(
            runMcpRequest(request, store, config.accessAppHostname)
          );
          return Result.isSuccess(response)
            ? response.success
            : internalErrorResponse();
        });
      }
      return yield* routeRequest(request, config);
    }).pipe(
      Effect.provide(programLayer(env, Number(config.syncLookbackDays)))
    );
  }).pipe(
    Effect.catchTag("UnauthorizedAccessRequestError", () =>
      Effect.succeed(accessDeniedResponse())
    ),
    Effect.catchIf(
      () => true,
      () =>
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
  /** Handle an authenticated HTTP or MCP request. */
  fetch: (request: Request, env: WorkerEnv) => Effect.runPromise(run(request, env)),
  /** Run the scheduled synchronization across every enabled provider connection. */
  scheduled: (
    _controller: ScheduledController,
    env: WorkerEnv,
    context: ExecutionContext
  ) => {
    const sync = Effect.gen(function* sync() {
      yield* parseConfig(env);
      const service = yield* SyncService;
      return yield* synchronizeScheduled(service);
    }).pipe(
      Effect.provide(programLayer(env, Number(env.SYNC_LOOKBACK_DAYS)))
    );
    const completion = Effect.gen(function* scheduledCompletion() {
      const result = yield* Effect.result(sync);
      if (Result.isFailure(result)) {
        yield* Effect.logError("Scheduled synchronization failed", {
          errorTag: result.failure._tag,
        });
      }
    });
    context.waitUntil(Effect.runPromise(completion));
  },
} satisfies ExportedHandler<WorkerEnv>;
