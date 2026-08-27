import { Effect, Layer, Result, Schedule, Schema } from "effect";

import { BankProvider } from "./bank-provider";
import type { BankProviderError } from "./bank-provider";
import type {
  BankAccount,
  PendingTransaction,
  PostedTransaction,
} from "./domain";
import {
  AuthenticationError,
  InvalidProviderResponseError,
  ProviderRateLimitError,
  ProviderUnavailableError,
} from "./errors";

const DateTime = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value: string) => !Number.isNaN(Date.parse(value)))
  )
);
const NullableString = Schema.optional(Schema.NullOr(Schema.String));
const NullableNumber = Schema.optional(Schema.NullOr(Schema.Number));
const Meta = Schema.optional(
  Schema.Struct({
    card_suffix: NullableString,
    code: NullableString,
    other_account: NullableString,
    particulars: NullableString,
    reference: NullableString,
  })
);
const AkahuAccount = Schema.Struct({
  _id: Schema.String,
  balance: Schema.optional(
    Schema.Struct({
      available: NullableNumber,
      currency: Schema.String,
      current: Schema.Number,
    })
  ),
  connection: Schema.Struct({ name: Schema.String }),
  formatted_account: NullableString,
  meta: Schema.optional(Schema.Struct({ holder: NullableString })),
  name: Schema.String,
  refreshed: Schema.optional(
    Schema.Struct({
      balance: Schema.optional(DateTime),
      transactions: Schema.optional(DateTime),
    })
  ),
  status: Schema.Literals(["ACTIVE", "INACTIVE"]),
  type: Schema.String,
});
const AkahuTransaction = Schema.Struct({
  _account: Schema.String,
  _id: Schema.String,
  amount: Schema.Number,
  balance: NullableNumber,
  category: Schema.optional(Schema.Struct({ name: Schema.String })),
  created_at: DateTime,
  date: DateTime,
  description: Schema.String,
  merchant: Schema.optional(Schema.Struct({ name: Schema.String })),
  meta: Meta,
  type: Schema.String,
  updated_at: DateTime,
});
const AkahuPending = Schema.Struct({
  _account: Schema.String,
  amount: Schema.Number,
  date: DateTime,
  description: Schema.String,
  meta: Meta,
  type: Schema.String,
  updated_at: DateTime,
});
const AccountsResponse = Schema.Struct({
  items: Schema.Array(AkahuAccount),
  success: Schema.Literal(true),
});
const TransactionsResponse = Schema.Struct({
  cursor: Schema.optional(
    Schema.Struct({ next: Schema.NullOr(Schema.String) })
  ),
  items: Schema.Array(AkahuTransaction),
  success: Schema.Literal(true),
});
const PendingResponse = Schema.Struct({
  items: Schema.Array(AkahuPending),
  success: Schema.Literal(true),
});
const RefreshResponse = Schema.Struct({ success: Schema.Literal(true) });
const ProviderPayloadSchema = Schema.Struct({});
type ProviderPayload = typeof ProviderPayloadSchema.Type;
const maxTransactionPages = 100;
const maxPostedTransactions = 750;

export interface AkahuConfig {
  readonly baseUrl: string;
  readonly appToken: string;
  readonly userToken: string;
  readonly requestTimeoutMs?: number;
}

const decode = <A>(
  schema: Schema.Codec<A, unknown, never, never>,
  operation: string,
  input: ProviderPayload
): Effect.Effect<A, BankProviderError> =>
  Effect.gen(function* decodePayload() {
    const result = yield* Effect.result(
      Schema.decodeUnknownEffect(schema)(input)
    );
    if (Result.isFailure(result)) {
      return yield* Effect.fail(
        new InvalidProviderResponseError({
          details: String(result.failure),
          operation,
        })
      );
    }
    return result.success;
  });

export const decodeAkahuAccounts = (input: ProviderPayload, now: string) =>
  decode(AccountsResponse, "getAccounts", input).pipe(
    Effect.map((response) =>
      response.items.map((item): BankAccount => ({
        availableBalance: item.balance?.available ?? null,
        currency: item.balance?.currency ?? null,
        currentBalance: item.balance?.current ?? null,
        dataUpdatedAt: now,
        formattedAccount: item.formatted_account ?? null,
        holderName: item.meta?.holder ?? null,
        id: `account_${item._id}`,
        institution: item.connection.name,
        name: item.name,
        providerBalanceRefreshedAt: item.refreshed?.balance ?? null,
        providerId: item._id,
        providerTransactionsRefreshedAt: item.refreshed?.transactions ?? null,
        status: item.status === "ACTIVE" ? "active" : "inactive",
        syncedAt: now,
        type: item.type.toLowerCase(),
      }))
    )
  );

const pendingId = (item: typeof AkahuPending.Type) =>
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
    Effect.map(
      (hash) =>
        `pending_${[...new Uint8Array(hash)]
          .slice(0, 16)
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("")}`
    )
  );

const parseResponse = (
  operation: string,
  response: Response
): Effect.Effect<ProviderPayload, BankProviderError> => {
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
  return Effect.tryPromise<ProviderPayload, BankProviderError>({
    catch: (cause) =>
      new InvalidProviderResponseError({ details: String(cause), operation }),
    try: async () =>
      Schema.decodeUnknownSync(ProviderPayloadSchema)(await response.json()),
  });
};

export const makeAkahuBankProvider = (
  config: AkahuConfig,
  fetchImplementation: typeof fetch = fetch
) => {
  const request = (
    operation: string,
    path: string,
    init?: RequestInit
  ): Effect.Effect<ProviderPayload, BankProviderError> => {
    const requestEffect = Effect.acquireUseRelease(
      Effect.sync(() => new AbortController()),
      (controller) =>
        Effect.tryPromise({
          catch: (cause) => new ProviderUnavailableError({ cause, operation }),
          try: () =>
            fetchImplementation(`${config.baseUrl}${path}`, {
              ...init,
              headers: {
                Accept: "application/json",
                Authorization: `Bearer ${config.userToken}`,
                "X-Akahu-Id": config.appToken,
              },
              signal: controller.signal,
            }),
        }).pipe(
          Effect.flatMap((response) => parseResponse(operation, response))
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

  const getAccounts = Effect.gen(function* getAccounts() {
    const now = new Date().toISOString();
    return yield* request("getAccounts", "/accounts").pipe(
      Effect.flatMap((body) => decodeAkahuAccounts(body, now))
    );
  });

  const getTransactions = ({ start }: { readonly start: string | null }) =>
    Effect.gen(function* listTransactions() {
      const items: PostedTransaction[] = [];
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
          `/transactions?${query.toString()}`
        ).pipe(
          Effect.flatMap((body) =>
            decode(TransactionsResponse, "getTransactions", body)
          )
        );
        const now = new Date().toISOString();
        if (items.length + response.items.length > maxPostedTransactions) {
          return yield* Effect.fail(
            new InvalidProviderResponseError({
              details: `Response exceeded ${maxPostedTransactions} transactions`,
              operation: "getTransactions",
            })
          );
        }
        items.push(
          ...response.items.map((item): PostedTransaction => ({
            accountId: `account_${item._account}`,
            amount: item.amount,
            balance: item.balance ?? null,
            cardSuffix: item.meta?.card_suffix ?? null,
            categoryName: item.category?.name ?? null,
            code: item.meta?.code ?? null,
            currency: "NZD",
            dataUpdatedAt: now,
            description: item.description,
            id: `transaction_${item._id}`,
            merchantName: item.merchant?.name ?? null,
            otherAccount: item.meta?.other_account ?? null,
            particulars: item.meta?.particulars ?? null,
            providerCreatedAt: item.created_at,
            providerId: item._id,
            providerUpdatedAt: item.updated_at,
            reference: item.meta?.reference ?? null,
            status: "posted",
            syncedAt: now,
            transactionAt: item.date,
            type: item.type,
          }))
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

  const getPendingTransactions = Effect.gen(function* getPendingTransactions() {
    const response = yield* request(
      "getPendingTransactions",
      "/transactions/pending"
    ).pipe(
      Effect.flatMap((body) =>
        decode(PendingResponse, "getPendingTransactions", body)
      )
    );
    return yield* Effect.all(
      response.items.map((item) =>
        pendingId(item).pipe(
          Effect.map((id): PendingTransaction => {
            const now = new Date().toISOString();
            return {
              accountId: `account_${item._account}`,
              amount: item.amount,
              cardSuffix: item.meta?.card_suffix ?? null,
              code: item.meta?.code ?? null,
              currency: "NZD",
              dataUpdatedAt: now,
              description: item.description,
              id,
              otherAccount: item.meta?.other_account ?? null,
              particulars: item.meta?.particulars ?? null,
              providerId: id,
              providerUpdatedAt: item.updated_at,
              reference: item.meta?.reference ?? null,
              status: "pending",
              syncedAt: now,
              transactionAt: item.date,
              type: item.type,
            };
          })
        )
      )
    );
  });

  const requestRefresh = request("requestRefresh", "/refresh", {
    method: "POST",
  }).pipe(
    Effect.flatMap((body) => decode(RefreshResponse, "requestRefresh", body)),
    Effect.asVoid
  );
  return BankProvider.of({
    getAccounts,
    getPendingTransactions,
    getTransactions,
    requestRefresh,
  });
};

export const akahuBankProviderLive = (config: AkahuConfig) =>
  Layer.succeed(BankProvider, makeAkahuBankProvider(config));
