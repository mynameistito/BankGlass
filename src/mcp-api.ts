import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { Effect, Schema } from "effect";
import { z } from "zod";

import type { BankStoreService } from "@/bank-store";
import { InvalidRequestError } from "@/errors";

const readOnlyAnnotations = {
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
  readOnlyHint: true,
};

const accountOutputSchema = z.object({
  availableBalance: z.number().nullable(),
  currency: z.string().nullable(),
  currentBalance: z.number().nullable(),
  dataUpdatedAt: z.string(),
  formattedAccount: z.string().nullable(),
  holderName: z.string().nullable(),
  id: z.string(),
  institution: z.string(),
  name: z.string(),
  providerBalanceRefreshedAt: z.string().nullable(),
  providerId: z.string(),
  providerTransactionsRefreshedAt: z.string().nullable(),
  status: z.enum(["active", "inactive"]),
  syncedAt: z.string(),
  type: z.string(),
});

const transactionOutputSchema = z.object({
  accountId: z.string(),
  amount: z.number(),
  balance: z.number().nullable(),
  cardSuffix: z.string().nullable(),
  categoryName: z.string().nullable(),
  code: z.string().nullable(),
  currency: z.string(),
  dataUpdatedAt: z.string(),
  description: z.string(),
  id: z.string(),
  merchantName: z.string().nullable(),
  otherAccount: z.string().nullable(),
  particulars: z.string().nullable(),
  providerUpdatedAt: z.string(),
  reference: z.string().nullable(),
  status: z.enum(["posted", "pending"]),
  syncedAt: z.string(),
  transactionAt: z.string(),
  type: z.string(),
});

const syncStatusOutputSchema = z.object({
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  lastAttemptAt: z.string().nullable(),
  lastProviderRefreshRequestedAt: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  providerRefreshedAt: z.string().nullable(),
  startedAt: z.string().nullable(),
  status: z.string(),
});

const successfulToolResult = <Data>(data: Data) => ({
  content: [{ text: JSON.stringify(data), type: "text" as const }],
  structuredContent: data,
});

const failedToolResult = (errorTag: string) => ({
  content: [
    {
      text: (() => {
        switch (errorTag) {
          case "InvalidRequestError": {
            return "Invalid request: check the supplied parameters";
          }
          case "NotFoundError": {
            return "Not found: the requested banking record does not exist";
          }
          case "ApiRateLimitError":
          case "ProviderRateLimitError": {
            return "Rate limited: retry later";
          }
          case "AuthenticationError":
          case "InvalidProviderResponseError":
          case "ProviderUnavailableError": {
            return "Unavailable: banking data is temporarily unavailable; retry later";
          }
          default: {
            return "Internal error: banking data could not be read";
          }
        }
      })(),
      type: "text" as const,
    },
  ],
  isError: true,
});

const runTool = <Value, Failure extends { readonly _tag: string }>(
  effect: Effect.Effect<Value, Failure>
) =>
  Effect.runPromise(
    Effect.match(effect, {
      onFailure: (error) => failedToolResult(error._tag),
      onSuccess: successfulToolResult,
    })
  );

const CursorSchema = Schema.Struct({ date: Schema.String, id: Schema.String });

const validateCursor = (cursor: string) =>
  Effect.try({
    catch: () => new InvalidRequestError({ message: "cursor is invalid" }),
    try: () => Schema.decodeUnknownSync(CursorSchema)(JSON.parse(atob(cursor))),
  }).pipe(Effect.asVoid);

/**
 * Validate cursor and date ordering for MCP transaction queries.
 *
 * @param input - Optional query values supplied by an MCP client.
 * @returns An effect that succeeds for a well-formed query or fails with
 * `InvalidRequestError`.
 */
export const validateMcpTransactionQuery = (input: {
  readonly cursor?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}) =>
  Effect.gen(function* validateMcpQuery() {
    if (
      input.from !== undefined &&
      input.to !== undefined &&
      new Date(input.from).getTime() > new Date(input.to).getTime()
    ) {
      yield* Effect.fail(
        new InvalidRequestError({ message: "from must not be later than to" })
      );
    }
    if (input.cursor !== undefined) {
      yield* validateCursor(input.cursor);
    }
  });

const createServer = (store: BankStoreService) => {
  const server = new McpServer({
    name: "bankglass",
    version: "1.0.0",
  });

  server.registerTool(
    "list_accounts",
    {
      annotations: readOnlyAnnotations,
      description: "List the owner's locally cached accounts and balances",
      inputSchema: z.object({}),
      outputSchema: z.array(accountOutputSchema),
    },
    () => runTool(store.listAccounts)
  );

  server.registerTool(
    "get_balance",
    {
      annotations: readOnlyAnnotations,
      description: "Get one account balance and its freshness timestamps",
      inputSchema: z.object({ accountId: z.string().min(1) }),
      outputSchema: z.object({
        accountId: z.string(),
        available: z.number().nullable(),
        currency: z.string().nullable(),
        current: z.number().nullable(),
        dataUpdatedAt: z.string(),
        providerRefreshedAt: z.string().nullable(),
        syncedAt: z.string(),
      }),
    },
    ({ accountId }) =>
      runTool(
        store.getAccount(accountId).pipe(
          Effect.map((account) => ({
            accountId,
            available: account["availableBalance"],
            currency: account["currency"],
            current: account["currentBalance"],
            dataUpdatedAt: account["dataUpdatedAt"],
            providerRefreshedAt: account["providerBalanceRefreshedAt"],
            syncedAt: account["syncedAt"],
          }))
        )
      )
  );

  server.registerTool(
    "list_transactions",
    {
      annotations: readOnlyAnnotations,
      description:
        "List cached posted or pending transactions with stable cursor pagination",
      inputSchema: z.object({
        accountId: z.string().min(1).optional(),
        cursor: z.string().min(1).optional(),
        from: z.iso.datetime({ offset: true }).optional(),
        limit: z.number().int().min(1).max(200).default(50),
        status: z.enum(["posted", "pending"]).default("posted"),
        to: z.iso.datetime({ offset: true }).optional(),
      }),
      outputSchema: z.object({
        items: z.array(transactionOutputSchema),
        nextCursor: z.string().nullable(),
      }),
    },
    ({ accountId, cursor, from, limit, status, to }) =>
      runTool(
        validateMcpTransactionQuery({ cursor, from, to }).pipe(
          Effect.andThen(() =>
            store.listTransactions({
              accountId: accountId ?? null,
              cursor: cursor ?? null,
              from: from === undefined ? null : new Date(from).toISOString(),
              limit,
              status,
              to: to === undefined ? null : new Date(to).toISOString(),
            })
          )
        )
      )
  );

  server.registerTool(
    "get_sync_status",
    {
      annotations: readOnlyAnnotations,
      description:
        "Get synchronization state and provider freshness timestamps",
      inputSchema: z.object({}),
      outputSchema: syncStatusOutputSchema,
    },
    () => runTool(store.getSyncStatus)
  );

  return server;
};

/**
 * Handle one stateless Streamable HTTP MCP request.
 *
 * @param request - Incoming MCP HTTP request.
 * @param store - Store implementation used by the registered read-only tools.
 * @param accessAppHostname - Hostname allowed by the MCP transport.
 * @returns The MCP protocol response with security headers applied.
 */
export const routeMcpRequest = (
  request: Request,
  store: BankStoreService,
  accessAppHostname: string
) => {
  const handler = createMcpHandler(() => createServer(store), {
    allowedHostnames: [accessAppHostname],
    allowedOriginHostnames: [accessAppHostname],
    legacy: "stateless",
    responseMode: "auto",
    route: "/mcp",
  });
  return (async () => {
    const response = await handler.fetch(request);
    const securedResponse = new Response(response.body, response);
    securedResponse.headers.set("Cache-Control", "no-store");
    securedResponse.headers.set("X-Content-Type-Options", "nosniff");
    return securedResponse;
  })();
};
