import { Effect, Redacted, Schema } from "effect";

import type { ProviderAccount } from "@/domain/account";
import type { BankConnection } from "@/domain/connection";
import {
  ProviderAccountIdSchema,
  ProviderIdSchema,
  ProviderTransactionIdSchema,
} from "@/domain/identifiers";
import type { ConnectionId } from "@/domain/identifiers";
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
import { SimpleFinAccountSetSchema } from "@/providers/simplefin/schemas";

const operation = "getAccounts";

/** Stable provider ID for the bundled SimpleFIN adapter. */
export const SimpleFinProviderId =
  Schema.decodeUnknownSync(ProviderIdSchema)("simplefin");

/** Connection-specific SimpleFIN Access URLs and transport policy. */
export interface SimpleFinConfig {
  /** Secret Access URL for each configured BankGlass SimpleFIN connection. */
  readonly accessUrls: ReadonlyMap<ConnectionId, Redacted.Redacted<string>>;
  /** Per-request timeout; defaults to ten seconds. */
  readonly requestTimeoutMs?: number;
}

const invalidResponse = (details: string) =>
  new InvalidProviderResponseError({ details, operation });

const epochIso = (seconds: number) => new Date(seconds * 1000).toISOString();

const scopedAccountId = (connectionId: string, accountId: string) =>
  Schema.decodeUnknownSync(ProviderAccountIdSchema)(
    `${encodeURIComponent(connectionId)}:${encodeURIComponent(accountId)}`
  );

const scopedTransactionId = (
  connectionId: string,
  accountId: string,
  transactionId: string
) =>
  Schema.decodeUnknownSync(ProviderTransactionIdSchema)(
    `${encodeURIComponent(connectionId)}:${encodeURIComponent(accountId)}:${encodeURIComponent(transactionId)}`
  );

const basicAuthorization = (url: URL) => {
  if (url.username.length === 0 || url.password.length === 0) {
    throw new TypeError(
      "SimpleFIN Access URL is missing Basic Auth credentials"
    );
  }
  const credentials = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
  return `Basic ${btoa(credentials)}`;
};

const requestUrl = (accessUrl: string, start: string | null) => {
  const url = new URL(accessUrl);
  if (url.protocol !== "https:") {
    throw new TypeError("SimpleFIN Access URL must use HTTPS");
  }
  const authorization = basicAuthorization(url);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  url.pathname = `${url.pathname.replace(/\/$/u, "")}/accounts`;
  url.searchParams.set("version", "2");
  url.searchParams.set("pending", "1");
  if (start !== null) {
    url.searchParams.set(
      "start-date",
      String(Math.floor(new Date(start).getTime() / 1000))
    );
  }
  return { authorization, url };
};

const parseRetryAfter = (raw: string | null) => {
  if (raw === null) {
    return null;
  }
  if (/^\d+$/u.test(raw)) {
    const seconds = Number(raw);
    return Number.isFinite(seconds) ? Math.max(0, Math.trunc(seconds)) : null;
  }
  const retryAt = Date.parse(raw);
  return Number.isNaN(retryAt)
    ? null
    : Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
};

const classifyResponse = <A>(
  response: Response,
  schema: Schema.Codec<A, unknown, never, never>
): Effect.Effect<A, BankProviderError> => {
  if (response.status === 401 || response.status === 403) {
    return Effect.fail(
      new AuthenticationError({
        message: "SimpleFIN rejected or revoked the configured Access URL",
      })
    );
  }
  if (response.status === 429) {
    return Effect.fail(
      new ProviderRateLimitError({
        retryAfterSeconds: parseRetryAfter(response.headers.get("Retry-After")),
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
  return Effect.gen(function* parseSimpleFinResponse() {
    const json = yield* Effect.tryPromise({
      catch: () => invalidResponse("Response body was not valid JSON"),
      try: async () => await response.json(),
    });
    return yield* Schema.decodeUnknownEffect(schema)(json).pipe(
      Effect.mapError(() =>
        invalidResponse("Response did not match the SimpleFIN v2 schema")
      )
    );
  });
};

const checkStructuredErrors = (
  response: typeof SimpleFinAccountSetSchema.Type
): Effect.Effect<typeof SimpleFinAccountSetSchema.Type, BankProviderError> => {
  if (response.errlist.length === 0) {
    return Effect.succeed(response);
  }
  const codes = response.errlist.map((error) => error.code);
  if (codes.some((code) => code === "gen.auth" || code === "con.auth")) {
    return Effect.fail(
      new AuthenticationError({
        message: "SimpleFIN reported an authentication error",
      })
    );
  }
  return Effect.fail(
    new ProviderUnavailableError({
      cause: `SimpleFIN errlist: ${codes.join(",")}`,
      operation,
    })
  );
};

const transactionAt = (
  transaction: (typeof SimpleFinAccountSetSchema.Type)["accounts"][number]["transactions"] extends
    | readonly (infer Transaction)[]
    | undefined
    ? Transaction
    : never,
  balanceDate: number
) => {
  if (
    transaction.transacted_at !== undefined &&
    transaction.transacted_at > 0
  ) {
    return epochIso(transaction.transacted_at);
  }
  if (transaction.posted > 0) {
    return epochIso(transaction.posted);
  }
  return epochIso(balanceDate);
};

const normalizeSnapshot = (
  response: typeof SimpleFinAccountSetSchema.Type
): Effect.Effect<
  {
    readonly accounts: readonly ProviderAccount[];
    readonly pending: readonly ProviderPendingTransaction[];
    readonly posted: readonly ProviderPostedTransaction[];
  },
  InvalidProviderResponseError
> =>
  Effect.gen(function* normalizeSimpleFinSnapshot() {
    const connections = new Map(
      response.connections.map((connection) => [connection.conn_id, connection])
    );
    const accounts: ProviderAccount[] = [];
    const pending: ProviderPendingTransaction[] = [];
    const posted: ProviderPostedTransaction[] = [];

    for (const account of response.accounts) {
      const sourceConnection = connections.get(account.conn_id);
      if (sourceConnection === undefined) {
        return yield* Effect.fail(
          invalidResponse(
            `Account references unknown SimpleFIN connection ${account.conn_id}`
          )
        );
      }
      const providerAccountId = scopedAccountId(account.conn_id, account.id);
      const dataUpdatedAt = epochIso(account["balance-date"]);
      const currentBalance = Number(account.balance);
      const availableBalance = Number(
        account["available-balance"] ?? account.balance
      );
      accounts.push({
        availableBalance,
        currency: account.currency,
        currentBalance,
        dataUpdatedAt,
        formattedAccount: null,
        holderName: null,
        institution: sourceConnection.org_name ?? sourceConnection.name,
        name: account.name,
        providerAccountId,
        providerBalanceRefreshedAt: dataUpdatedAt,
        providerTransactionsRefreshedAt: dataUpdatedAt,
        status: "active",
        type: "account",
      });

      for (const transaction of account.transactions ?? []) {
        const occurredAt = transactionAt(transaction, account["balance-date"]);
        const providerTransactionId = scopedTransactionId(
          account.conn_id,
          account.id,
          transaction.id
        );
        const common = {
          amount: Number(transaction.amount),
          cardSuffix: null,
          code: null,
          currency: account.currency,
          dataUpdatedAt,
          description: transaction.description,
          otherAccount: null,
          particulars: null,
          providerAccountId,
          providerTransactionId,
          providerUpdatedAt: dataUpdatedAt,
          reference: null,
          transactionAt: occurredAt,
          type: "simplefin",
        } as const;
        if (transaction.pending === true) {
          pending.push({ ...common, status: "pending" });
        } else {
          posted.push({
            ...common,
            balance: null,
            categoryName: null,
            merchantName: null,
            providerCreatedAt: occurredAt,
            status: "posted",
          });
        }
      }
    }

    return { accounts, pending, posted };
  });

const accessUrlForConnection = (
  config: SimpleFinConfig,
  connection: BankConnection
) => {
  const accessUrl = config.accessUrls.get(connection.id);
  return accessUrl === undefined
    ? Effect.fail(
        new AuthenticationError({
          message: "SimpleFIN access is not configured for this connection",
        })
      )
    : Effect.succeed(accessUrl);
};

/** Construct the bundled SimpleFIN v2 provider adapter. */
export const makeSimpleFinProvider = (
  config: SimpleFinConfig,
  fetchImplementation: typeof fetch = fetch
): BankProviderAdapter => ({
  displayName: "SimpleFIN",
  id: SimpleFinProviderId,
  pendingTransactions: { _tag: "Available" },
  readSnapshot: ({ connection, start }) =>
    Effect.gen(function* readSimpleFinSnapshot() {
      const accessUrl = yield* accessUrlForConnection(config, connection);
      const request = yield* Effect.try({
        catch: () =>
          new AuthenticationError({
            message: "SimpleFIN Access URL is invalid",
          }),
        try: () => requestUrl(Redacted.value(accessUrl), start),
      });
      const response = yield* Effect.tryPromise({
        catch: (error) =>
          new ProviderUnavailableError({ cause: error, operation }),
        try: () =>
          fetchImplementation(request.url, {
            headers: {
              Accept: "application/json",
              Authorization: request.authorization,
            },
            signal: AbortSignal.timeout(config.requestTimeoutMs ?? 10_000),
          }),
      });
      const decoded = yield* classifyResponse(
        response,
        SimpleFinAccountSetSchema
      );
      const complete = yield* checkStructuredErrors(decoded);
      return yield* normalizeSnapshot(complete);
    }),
  refresh: { _tag: "ProviderManaged" },
});
