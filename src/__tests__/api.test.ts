import { env, exports } from "cloudflare:workers";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BankStore } from "../bank-store";
import { doBankStoreLive, isStoreStub } from "../bank-store-do";
import type { RuntimeConfig } from "../config";
import { routeRequest } from "../http-api";
import { routeMcpRequest } from "../mcp-api";
import { SyncService } from "../sync-service";
import { fetchAccessJwks, makeAccessAssertion } from "./access-fixture";

const headers = { Authorization: "Bearer test-api-bearer-token" };
const config = {
  accessAppHostname: "bank.example.test",
  accessAudience: "REPLACE_WITH_ACCESS_AUD",
  accessTeamDomain: "https://replace-with-team-name.cloudflareaccess.com",
  akahuAppToken: "test-akahu-app-token",
  akahuUserToken: "test-akahu-user-token",
  apiBaseUrl: "https://api.akahu.io/v1",
  apiBearerToken: "test-api-bearer-token",
  apiRateLimitPerMinute: "60",
  refreshCooldownSeconds: "3600",
  syncLookbackDays: "14",
} satisfies RuntimeConfig;
const resetStore = async () => {
  const stub = env.BANK_STORE.getByName("bankglass");
  if (!isStoreStub(stub)) {
    throw new TypeError("BANK_STORE does not expose the command RPC");
  }
  await stub.command({ args: [], name: "reset" });
};

const requestApi = (request: Request) =>
  Effect.runPromise(
    routeRequest(request, config).pipe(
      Effect.provideService(
        SyncService,
        SyncService.of({ synchronize: () => Effect.die("unused") })
      ),
      Effect.provide(doBankStoreLive(env.BANK_STORE))
    )
  );

describe("Cloudflare HTTP boundary", () => {
  beforeEach(async () => {
    await resetStore();
  });

  it("rejects requests that did not pass Cloudflare Access", async () => {
    const response = await exports.default.fetch(
      new Request("https://example.test/v1/accounts")
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "UNAUTHORIZED_ACCESS_REQUEST" },
    });
  });

  it("retains REST bearer authentication behind Access", async () => {
    const response = await requestApi(
      new Request("https://example.test/v1/accounts")
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "UNAUTHORIZED_API_REQUEST" },
    });
  });

  it("returns structured validation errors", async () => {
    const response = await requestApi(
      new Request("https://example.test/v1/transactions?limit=1000", {
        headers,
      })
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "INVALID_REQUEST",
        message: "limit must be an integer from 1 to 200",
      },
    });
  });

  it("requires strict ISO 8601 date-times for transaction filters", async () => {
    const response = await requestApi(
      new Request("https://example.test/v1/transactions?from=2026-08-27", {
        headers,
      })
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "INVALID_REQUEST",
        message: "from must be an ISO 8601 date-time",
      },
    });
  });

  it("reads account data from the Durable Object rather than the provider", async () => {
    const store = await Effect.runPromise(
      BankStore.pipe(Effect.provide(doBankStoreLive(env.BANK_STORE)))
    );
    await Effect.runPromise(
      store.acquireSync("2026-08-26T00:00:00.000Z", "api-test", null)
    );
    await Effect.runPromise(
      store.saveSnapshot({
        accounts: [
          {
            availableBalance: 18,
            currency: "NZD",
            currentBalance: 20,
            dataUpdatedAt: "2026-08-26T00:00:00.000Z",
            formattedAccount: null,
            holderName: null,
            id: "account_test",
            institution: "BNZ",
            name: "Everyday",
            providerBalanceRefreshedAt: null,
            providerId: "provider_test",
            providerTransactionsRefreshedAt: null,
            status: "active",
            syncedAt: "2026-08-26T00:00:00.000Z",
            type: "checking",
          },
        ],
        leaseId: "api-test",
        pending: [],
        posted: [],
        reconcilePostedFrom: "2026-08-26T00:00:00.000Z",
        syncedAt: "2026-08-26T00:00:00.000Z",
      })
    );
    const response = await requestApi(
      new Request("https://example.test/v1/accounts/account_test/balance", {
        headers,
      })
    );
    const responseBody = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(responseBody)).toMatchObject({
      data: { accountId: "account_test", available: 18, current: 20 },
    });
  });

  it("serves a stateless read-only MCP endpoint without the REST bearer", async () => {
    const request = new Request("https://bank.example.test/mcp", {
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: "test-agent", version: "1.0.0" },
          protocolVersion: "2025-06-18",
        },
      }),
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        Host: "bank.example.test",
      },
      method: "POST",
    });
    const response = await Effect.runPromise(
      Effect.gen(function* mcpRequest() {
        const store = yield* BankStore;
        return yield* Effect.promise(() =>
          routeMcpRequest(request, store, config.accessAppHostname)
        );
      }).pipe(Effect.provide(doBankStoreLive(env.BANK_STORE)))
    );
    const responseBody = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const messageLine = responseBody
      .split("\n")
      .find((line) => line.startsWith("data: "));
    expect(JSON.parse(messageLine?.slice(6) ?? "{}")).toMatchObject({
      id: 1,
      result: {
        serverInfo: { name: "bankglass", version: "1.0.0" },
      },
    });
  });

  it("rate-limits MCP requests at the Worker entrypoint", async () => {
    const assertion = await makeAccessAssertion();
    const fetchJwks = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(fetchAccessJwks);
    try {
      const requests = Array.from({ length: 61 }, () =>
        exports.default.fetch(
          new Request("https://replace-with-custom-hostname/mcp", {
            body: JSON.stringify({
              id: 1,
              jsonrpc: "2.0",
              method: "tools/list",
            }),
            headers: {
              Accept: "application/json, text/event-stream",
              "Cf-Access-Jwt-Assertion": assertion,
              "Content-Type": "application/json",
              Host: "replace-with-custom-hostname",
            },
            method: "POST",
          })
        )
      );
      const responses = await Promise.all(requests);
      const limited = responses.find((response) => response.status === 429);
      expect(limited?.status).toBe(429);
      expect(limited?.headers.get("Retry-After")).toBeTruthy();
    } finally {
      fetchJwks.mockRestore();
    }
  });
});
