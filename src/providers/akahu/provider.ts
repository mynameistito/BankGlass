import {
  Clock,
  Duration,
  Effect,
  Redacted,
  Schedule,
  Schema,
} from "effect";

import type { ProviderAccount } from "@/domain/account";
import {
  ProviderAccountIdSchema,
  ProviderIdSchema,
  ProviderTransactionIdSchema,
} from "@/domain/identifiers";
import type {
  ProviderPendingTransaction,
  ProviderPostedTransaction,
} from "@/domain/transaction";
import {
  AuthenticationError,
  InvalidProviderResponseError,
  ProviderRateLimitError,
  ProviderUnavailableError,
} from "@/errors";
import type {
  BankProviderAdapter,
  BankProviderError,
} from "@/provider-registry";
import {
  AccountsResponse,
  PendingResponse,
  RefreshResponse,
  TransactionsResponse,
} from "@/providers/akahu/schemas";

const maxTransactionPages = 100;
const maxPostedTransactions = 750;

/** Stable provider ID for the bundled Akahu adapter. */
export const AkahuProviderId = Schema.decodeUnknownSync(ProviderIdSchema)(
  "akahu"
);

/** Credentials and transport options for the Akahu Personal App API. */
export interface AkahuConfig {
  /** Akahu API origin and version prefix. */
  readonly baseUrl: string;
  /** Personal App ID token. */
  readonly appToken: Redacted.Redacted<string>;
  /** User access token for the Personal App. */
  readonly userToken: Redacted.Redacted<string>;
  /** Per-request timeout; defaults to ten seconds. */
  readonly requestTimeoutMs?: number;
}

const nowIso = Clock.currentTimeMillis.pipe(
  Effect.map((millis) => new Date(millis).toISOString())
);

const normalizeAccounts = (
  response: typeof AccountsResponse.Type,
  now: string
): readonly ProviderAccount[] =>
  response.items.map((item): ProviderAccount => ({
    availableBalance: item.balance?.available ?? null,
    currency: item.balance?.currency ?? null,
    currentBalance: item.balance?.current ?? null,
    dataUpdatedAt: now,
    formattedAccount: item.formatted_account ?? null,
    holderName: item.meta?.holder ?? null,
    institution: item.connection.name,
    name: item.name,
    providerAccountId: Schema.decodeUnknownSync(ProviderAccountIdSchema)(
      item._id
    ),
    providerBalanceRefreshedAt: item.refreshed?.balance ?? null,
    providerTransactionsRefreshedAt: item.refreshed?.transactions ?? null,
    status: item.status === "ACTIVE" ? "active" : "inactive",
    type: item.type.toLowerCase(),
  }));

const pendingId = (item: typeof PendingResponse.Type["items"][number]) =>
  Effect.promise(() =>
    crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        [
          item._account,
          item.date,
          item.description,
          item.amount,
          item.type,
        ].join("\u001F")
      )
    )
  ).pipe(
    Effect.map((hash) =>
      Schema.decodeUnknownSync(ProviderTransactionIdSchema)(
        `pending_${[...new Uint8Array(hash)]
          .slice(0, 16)
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("")}`
      )
    )
  );

const parseResponseJson = <A>(
  operation: string,
  response: Response,
  schema: Schema.Codec<A, unknown, never, never>
): Effect.Effect<A, BankProviderError> => {
  if (response.status === 401 || response.status === 403) {
    return Effect.fail(
      new AuthenticationError({
        message: "Akahu rejected the configured credentials",
      })
    );
  }
  if (response.status === 429) {
    const raw = response.headers.get("Retry-After");
    return Effect.fail(
      new ProviderRateLimitError({
        retryAfterSeconds: raw === null ? null : Math.trunc(Number(raw)),
      })
    );
  }
  if (!response.ok) {
    return Effect.fail(
      new ProviderUnavailableError({
        cause: `HTTP ${response.status}`,
        operation,
      })
    );
  }
  return Effect.tryPromise({
    catch: (error) =>
      new InvalidProviderResponseError({ details: String(error), operation }),
    try: async () => await response.json(),
  }).pipe(
    Effect.flatMap((json) =>
      Schema.decodeUnknownEffect(schema)(json).pipe(
        Effect.mapError(
          (error) =>
            new InvalidProviderResponseError({
              details: String(error),
              operation,
            })
        )
      )
    )
  );
};

const normalizePendingTransaction = (
  item: typeof PendingResponse.Type["items"][number],
  currencyByAccount: ReadonlyMap<string, string | null>
) =>
  Effect.gen(function* normalizePending() {
    const providerTransactionId = yield* pendingId(item);
    const now = yield* nowIso;
    const providerAccountId = Schema.decodeUnknownSync(ProviderAccountIdSchema)(
      item._account
    );
    return {
      amount: item.amount,
      cardSuffix: item.meta?.card_suffix ?? null,
      code: item.meta?.code ?? null,
      currency: currencyByAccount.get(providerAccountId) ?? null,
      dataUpdatedAt: now,
      description: item.description,
      otherAccount: item.meta?.other_account ?? null,
      particulars: item.meta?.particulars ?? null,
      providerAccountId,
      providerTransactionId,
      providerUpdatedAt: item.updated_at,
      reference: item.meta?.reference ?? null,
      status: "pending",
      transactionAt: item.date,
      type: item.type,
    } satisfies ProviderPendingTransaction;
  });

/**
 * Construct the bundled Akahu provider adapter.
 *
 * @param config - Redacted Akahu credentials and request settings.
 * @param fetchImplementation - Fetch function, injectable at the transport seam for tests.
 * @returns An adapter that hides Akahu transport, schemas, pagination and normalization.
 */
export const makeAkahuProvider = (
  config: AkahuConfig,
  fetchImplementation: typeof fetch = fetch
): BankProviderAdapter => {
  const request = <A>(
    operation: string,
    path: string,
    schema: Schema.Codec<A, unknown, never, never>,
    init?: RequestInit
  ): Effect.Effect<A, BankProviderError> => {
    const requestEffect = Effect.acquireUseRelease(
      Effect.sync(() => new AbortController()),
      (controller) =>
        Effect.tryPromise({
          catch: (error) =>
            new ProviderUnavailableError({ cause: error, operation }),
          try: () =>
            fetchImplementation(`${config.baseUrl}${path}`, {
              ...init,
              headers: {
                Accept: "application/json",
                Authorization: `Bearer ${Redacted.value(config.userToken)}`,
                "X-Akahu-Id": Redacted.value(config.appToken),
              },
              signal: controller.signal,
            }),
        }).pipe(
          Effect.flatMap((response) =>
            parseResponseJson(operation, response, schema)
          )
        ),
      (controller) => Effect.sync(() => controller.abort())
    ).pipe(
      Effect.timeoutOrElse({
        duration: config.requestTimeoutMs ?? 10_000,
        orElse: () =>
          Effect.fail(
            new ProviderUnavailableError({ cause: "timeout", operation })
          ),
      })
    );
    return init?.method === "POST"
      ? requestEffect
      : requestEffect.pipe(
          Effect.retry({
            schedule: Schedule.exponential("100 millis").pipe(
              Schedule.upTo({ times: 2 })
            ),
            while: (error) => error._tag === "ProviderUnavailableError",
          })
        );
  };

  const readAccounts = Effect.gen(function* readAccounts() {
    const now = yield* nowIso;
    const response = yield* request("getAccounts", "/accounts", AccountsResponse);
    return normalizeAccounts(response, now);
  });

  const readPosted = (
    start: string | null,
    currencyByAccount: ReadonlyMap<string, string | null>
  ) =>
    Effect.gen(function* readPostedTransactions() {
      const items: ProviderPostedTransaction[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | null = null;
      let page = 0;
      do {
        page += 1;
        if (page > maxTransactionPages) {
          return yield* Effect.fail(
            new InvalidProviderResponseError({
              details: `Pagination exceeded ${maxTransactionPages} pages`,
              operation: "getTransactions",
            })
          );
        }
        const query = new URLSearchParams();
        if (start !== null) {
          query.set("start", start);
        }
        if (cursor !== null) {
          query.set("cursor", cursor);
        }
        const response = yield* request(
          "getTransactions",
          `/transactions?${query.toString()}`,
          TransactionsResponse
        );
        const now = yield* nowIso;
        if (items.length + response.items.length > maxPostedTransactions) {
          return yield* Effect.fail(
            new InvalidProviderResponseError({
              details: `Response exceeded ${maxPostedTransactions} transactions`,
              operation: "getTransactions",
            })
          );
        }
        items.push(
          ...response.items.map((item): ProviderPostedTransaction => {
            const providerAccountId = Schema.decodeUnknownSync(
              ProviderAccountIdSchema
            )(item._account);
            return {
              amount: item.amount,
              balance: item.balance ?? null,
              cardSuffix: item.meta?.card_suffix ?? null,
              categoryName: item.category?.name ?? null,
              code: item.meta?.code ?? null,
              currency: currencyByAccount.get(providerAccountId) ?? null,
              dataUpdatedAt: now,
              description: item.description,
              merchantName: item.merchant?.name ?? null,
              otherAccount: item.meta?.other_account ?? null,
              particulars: item.meta?.particulars ?? null,
              providerAccountId,
              providerCreatedAt: item.created_at,
              providerTransactionId: Schema.decodeUnknownSync(
                ProviderTransactionIdSchema
              )(item._id),
              providerUpdatedAt: item.updated_at,
              reference: item.meta?.reference ?? null,
              status: "posted",
              transactionAt: item.date,
              type: item.type,
            };
          })
        );
        const nextCursor = response.cursor?.next ?? null;
        if (nextCursor !== null && seenCursors.has(nextCursor)) {
          return yield* Effect.fail(
            new InvalidProviderResponseError({
              details: "Provider returned a repeated pagination cursor",
              operation: "getTransactions",
            })
          );
        }
        if (nextCursor !== null) {
          seenCursors.add(nextCursor);
        }
        cursor = nextCursor;
      } while (cursor !== null);
      return items;
    });

  const readPending = (currencyByAccount: ReadonlyMap<string, string | null>) =>
    Effect.gen(function* readPendingTransactions() {
      const response = yield* request(
        "getPendingTransactions",
        "/transactions/pending",
        PendingResponse
      );
      return yield* Effect.all(
        response.items.map((item) =>
          normalizePendingTransaction(item, currencyByAccount)
        )
      );
    });

  const requestRefresh = request(
    "requestRefresh",
    "/refresh",
    RefreshResponse,
    { method: "POST" }
  ).pipe(Effect.asVoid);

  return {
    displayName: "Akahu",
    id: AkahuProviderId,
    pendingTransactions: { _tag: "Available" },
    readSnapshot: ({ start }) =>
      Effect.gen(function* readSnapshot() {
        const accounts = yield* readAccounts;
        const currencyByAccount = new Map(
          accounts.map((account) => [
            account.providerAccountId,
            account.currency,
          ] as const)
        );
        const [posted, pending] = yield* Effect.all(
          [readPosted(start, currencyByAccount), readPending(currencyByAccount)],
          { concurrency: 2 }
        );
        return { accounts, pending, posted };
      }),
    refresh: {
      _tag: "Explicit",
      minimumInterval: Duration.seconds(3600),
      propagationDelay: Duration.seconds(5),
      request: () => requestRefresh,
    },
  };
};
