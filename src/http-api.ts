import { Effect } from "effect";

import { authenticate } from "./auth";
import { BankStore } from "./bank-store";
import type { BankStoreService } from "./bank-store";
import type { RuntimeConfig } from "./config";
import type { TransactionQuery } from "./domain";
import { InvalidRequestError } from "./errors";
import { SyncService } from "./sync-service";

const securityHeaders = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Content-Type": "application/json; charset=utf-8",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};
const json = (body: unknown, status = 200, extra: HeadersInit = {}) =>
  Response.json(body, { headers: { ...securityHeaders, ...extra }, status });
const parseDate = (value: string | null, name: string) => {
  if (value === null) {
    return null;
  }
  if (Number.isNaN(Date.parse(value))) {
    throw new InvalidRequestError({
      message: `${name} must be an ISO 8601 date-time`,
    });
  }
  return new Date(value).toISOString();
};
const parseQuery = (
  url: URL,
  accountId: string | null,
  status: "posted" | "pending" | null
): TransactionQuery => {
  const rawLimit = url.searchParams.get("limit") ?? "50";
  const limit = Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new InvalidRequestError({
      message: "limit must be an integer from 1 to 200",
    });
  }
  const from = parseDate(url.searchParams.get("from"), "from");
  const to = parseDate(url.searchParams.get("to"), "to");
  if (from !== null && to !== null && from > to) {
    throw new InvalidRequestError({
      message: "from must not be later than to",
    });
  }
  const cursor = url.searchParams.get("cursor");
  if (cursor !== null) {
    try {
      const decoded: unknown = JSON.parse(atob(cursor));
      if (
        typeof decoded !== "object" ||
        decoded === null ||
        !("date" in decoded) ||
        !("id" in decoded)
      ) {
        throw new TypeError("Cursor payload has the wrong shape");
      }
    } catch {
      throw new InvalidRequestError({ message: "cursor is invalid" });
    }
  }
  return { accountId, cursor, from, limit, status, to };
};
const decodeQuery = (
  url: URL,
  accountId: string | null,
  status: "posted" | "pending" | null
) =>
  Effect.try({
    catch: (cause) =>
      cause instanceof InvalidRequestError
        ? cause
        : new InvalidRequestError({ message: "Query parameters are invalid" }),
    try: () => parseQuery(url, accountId, status),
  });

const routeAccountRequest = (
  request: Request,
  url: URL,
  parts: string[],
  store: BankStoreService
) =>
  Effect.gen(function* accountRoute() {
    const accountId = decodeURIComponent(parts[2] ?? "");
    const account = yield* store.getAccount(accountId);
    if (request.method === "GET" && parts.length === 3) {
      return json({ data: account });
    }
    if (
      request.method === "GET" &&
      parts[3] === "balance" &&
      parts.length === 4
    ) {
      return json({
        data: {
          accountId,
          available: account["availableBalance"],
          currency: account["currency"],
          current: account["currentBalance"],
          dataUpdatedAt: account["dataUpdatedAt"],
          providerRefreshedAt: account["providerBalanceRefreshedAt"],
          syncedAt: account["syncedAt"],
        },
      });
    }
    if (
      request.method === "GET" &&
      parts[3] === "transactions" &&
      parts.length === 4
    ) {
      const query = yield* decodeQuery(url, accountId, "posted");
      const page = yield* store.listTransactions(query);
      return json({ data: page.items, nextCursor: page.nextCursor });
    }
    if (
      request.method === "GET" &&
      parts[3] === "pending" &&
      parts.length === 4
    ) {
      const query = yield* decodeQuery(url, accountId, "pending");
      const page = yield* store.listTransactions(query);
      return json({ data: page.items, nextCursor: page.nextCursor });
    }
    return json(
      { error: { code: "NOT_FOUND", message: "Route not found" } },
      404
    );
  });

export const routeRequest = (request: Request, config: RuntimeConfig) =>
  Effect.gen(function* routeRequestProgram() {
    yield* authenticate(request, config.apiBearerToken);
    const store = yield* BankStore;
    const nowSeconds = Math.floor(Date.now() / 1000);
    yield* store.consumeRateLimit(
      `api:${Math.floor(nowSeconds / 60)}`,
      nowSeconds,
      Number(config.apiRateLimitPerMinute)
    );
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "v1") {
      return json(
        { error: { code: "NOT_FOUND", message: "Route not found" } },
        404
      );
    }
    if (request.method === "GET" && url.pathname === "/v1/accounts") {
      return json({ data: yield* store.listAccounts });
    }
    if (request.method === "GET" && url.pathname === "/v1/transactions") {
      const query = yield* decodeQuery(url, null, "posted");
      const page = yield* store.listTransactions(query);
      return json({ data: page.items, nextCursor: page.nextCursor });
    }
    if (request.method === "GET" && url.pathname === "/v1/status") {
      return json({ data: yield* store.getSyncStatus });
    }
    if (request.method === "POST" && url.pathname === "/v1/refresh") {
      const sync = yield* SyncService;
      const result = yield* sync.synchronize({ requestProviderRefresh: true });
      return json({ data: result }, 202);
    }
    if (parts[1] === "accounts" && parts[2] !== undefined) {
      return yield* routeAccountRequest(request, url, parts, store);
    }
    return json(
      { error: { code: "NOT_FOUND", message: "Route not found" } },
      404
    );
  }).pipe(
    Effect.catchAll((error) => {
      const body = {
        error: {
          code: error._tag
            .replace(/Error$/u, "")
            .replaceAll(/(?<lower>[a-z])(?<upper>[A-Z])/gu, "$<lower>_$<upper>")
            .toUpperCase(),
          message: "Request could not be completed",
        },
      };
      switch (error._tag) {
        case "UnauthorizedApiRequestError": {
          return Effect.succeed(
            json(body, 401, { "WWW-Authenticate": "Bearer" })
          );
        }
        case "InvalidRequestError": {
          return Effect.succeed(
            json({ error: { ...body.error, message: error.message } }, 400)
          );
        }
        case "NotFoundError": {
          return Effect.succeed(json(body, 404));
        }
        case "RefreshCooldownError": {
          return Effect.succeed(json({ ...body, retryAt: error.retryAt }, 429));
        }
        case "ApiRateLimitError": {
          return Effect.succeed(
            json(body, 429, { "Retry-After": String(error.retryAfterSeconds) })
          );
        }
        case "ProviderRateLimitError": {
          return Effect.succeed(json(body, 503));
        }
        case "SyncInProgressError": {
          return Effect.succeed(json(body, 409));
        }
        case "AuthenticationError": {
          return Effect.succeed(json(body, 502));
        }
        case "InvalidProviderResponseError":
        case "ProviderUnavailableError": {
          return Effect.succeed(json(body, 503));
        }
        case "DatabaseError": {
          return Effect.succeed(json(body, 500));
        }
        default: {
          return Effect.succeed(json(body, 500));
        }
      }
    })
  );
