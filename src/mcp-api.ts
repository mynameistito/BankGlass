import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { Effect } from "effect";
import { z } from "zod";

import type { BankStoreService } from "./bank-store";

const readOnlyAnnotations = {
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
  readOnlyHint: true,
};

const successfulToolResult = <Data>(data: Data) => ({
  content: [{ text: JSON.stringify(data), type: "text" as const }],
});

const failedToolResult = (errorTag: string) => ({
  content: [
    {
      text:
        errorTag === "NotFoundError"
          ? "The requested banking record was not found"
          : "Banking data could not be read",
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

const createServer = (store: BankStoreService) => {
  const server = new McpServer({
    name: "bankglass",
    version: "1.0.0",
  });

  server.registerTool(
    "list_accounts",
    {
      annotations: readOnlyAnnotations,
      description: "List the owner's locally cached BNZ accounts and balances",
      inputSchema: z.object({}),
    },
    () => runTool(store.listAccounts)
  );

  server.registerTool(
    "get_balance",
    {
      annotations: readOnlyAnnotations,
      description: "Get one account balance and its freshness timestamps",
      inputSchema: z.object({ accountId: z.string().min(1) }),
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
    },
    ({ accountId, cursor, from, limit, status, to }) =>
      runTool(
        store.listTransactions({
          accountId: accountId ?? null,
          cursor: cursor ?? null,
          from: from === undefined ? null : new Date(from).toISOString(),
          limit,
          status,
          to: to === undefined ? null : new Date(to).toISOString(),
        })
      )
  );

  server.registerTool(
    "get_sync_status",
    {
      annotations: readOnlyAnnotations,
      description:
        "Get synchronization state and provider freshness timestamps",
      inputSchema: z.object({}),
    },
    () => runTool(store.getSyncStatus)
  );

  return server;
};

/** Handle one stateless Streamable HTTP MCP request. */
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
