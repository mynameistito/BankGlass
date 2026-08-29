import { env } from "cloudflare:test";
import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { makeD1BankStore } from "../d1-bank-store";
import type {
  BankAccount,
  PendingTransaction,
  PostedTransaction,
} from "../domain";
import { routeMcpRequest, validateMcpTransactionQuery } from "../mcp-api";

const hostname = "bank.example.test";
const time = "2026-08-26T00:00:00.000Z";
const store = makeD1BankStore(env.DB);

const account: BankAccount = {
  availableBalance: 18,
  currency: "NZD",
  currentBalance: 20,
  dataUpdatedAt: time,
  formattedAccount: null,
  holderName: null,
  id: "account_test",
  institution: "BNZ",
  name: "Everyday",
  providerBalanceRefreshedAt: time,
  providerId: "provider_account_test",
  providerTransactionsRefreshedAt: time,
  status: "active",
  syncedAt: time,
  type: "checking",
};

const transaction = (id: string, transactionAt: string): PostedTransaction => ({
  accountId: account.id,
  amount: -5,
  balance: 20,
  cardSuffix: null,
  categoryName: null,
  code: null,
  currency: "NZD",
  dataUpdatedAt: time,
  description: "Coffee",
  id,
  merchantName: "Cafe",
  otherAccount: null,
  particulars: null,
  providerCreatedAt: time,
  providerId: `provider_${id}`,
  providerUpdatedAt: time,
  reference: null,
  status: "posted",
  syncedAt: time,
  transactionAt,
  type: "EFTPOS",
});

const pending: PendingTransaction = {
  accountId: account.id,
  amount: -3,
  cardSuffix: null,
  code: null,
  currency: "NZD",
  dataUpdatedAt: time,
  description: "Pending coffee",
  id: "pending_test",
  otherAccount: null,
  particulars: null,
  providerId: "provider_pending_test",
  providerUpdatedAt: time,
  reference: null,
  status: "pending",
  syncedAt: time,
  transactionAt: "2026-08-25T12:00:00.000Z",
  type: "EFTPOS",
};

interface RpcRequest {
  readonly id: number;
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: object;
}
interface ToolArguments {
  readonly accountId?: string;
  readonly cursor?: string;
  readonly from?: string;
  readonly limit?: number;
  readonly status?: "posted" | "pending";
  readonly to?: string;
}
const toolResponseSchema = z.object({
  result: z.object({ content: z.array(z.object({ text: z.string() })) }),
});

const request = (message: RpcRequest, headers: Record<string, string> = {}) =>
  new Request(`https://${hostname}/mcp`, {
    body: JSON.stringify(message),
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      Host: hostname,
      ...headers,
    },
    method: "POST",
  });

const send = async (message: RpcRequest, headers?: Record<string, string>) => {
  const response = await routeMcpRequest(
    request(message, headers),
    store,
    hostname
  );
  const body = await response.text();
  const dataLine = body.split("\n").find((line) => line.startsWith("data: "));
  return { body, message: JSON.parse(dataLine?.slice(6) ?? "{}"), response };
};

const callTool = (id: number, name: string, args: ToolArguments = {}) =>
  send({
    id,
    jsonrpc: "2.0",
    method: "tools/call",
    params: { arguments: args, name },
  });

describe("MCP protocol boundary", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM transactions"),
      env.DB.prepare("DELETE FROM accounts"),
      env.DB.prepare("DELETE FROM rate_limits"),
    ]);
    await Effect.runPromise(store.acquireSync(time, "mcp-test", null));
    await Effect.runPromise(
      store.saveSnapshot({
        accounts: [account],
        leaseId: "mcp-test",
        pending: [pending],
        posted: [
          transaction("transaction_new", "2026-08-25T00:00:00.000Z"),
          transaction("transaction_old", "2026-08-24T00:00:00.000Z"),
        ],
        reconcilePostedFrom: "2026-08-23T00:00:00.000Z",
        syncedAt: time,
      })
    );
    await env.DB.prepare(
      "UPDATE sync_state SET status='idle',started_at=NULL,lease_id=NULL"
    ).run();
  });

  it("initializes and lists all read-only tools", async () => {
    const initialized = await send({
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "test-agent", version: "1.0.0" },
        protocolVersion: "2025-06-18",
      },
    });
    expect(initialized.response.status).toBe(200);
    expect(initialized.message).toMatchObject({
      id: 1,
      result: { serverInfo: { name: "bankglass", version: "1.0.0" } },
    });

    const listed = await send({ id: 2, jsonrpc: "2.0", method: "tools/list" });
    expect(listed.message).toMatchObject({
      id: 2,
      result: {
        tools: [
          { name: "list_accounts" },
          { name: "get_balance" },
          { name: "list_transactions" },
          { name: "get_sync_status" },
        ],
      },
    });
  });

  it("serves all four tools with defaults and filters", async () => {
    const accounts = await callTool(1, "list_accounts");
    expect(accounts.message).toMatchObject({
      result: {
        content: [{ text: JSON.stringify([account]) }],
        structuredContent: { result: [account] },
      },
    });

    const balance = await callTool(2, "get_balance", { accountId: account.id });
    expect(balance.message).toMatchObject({
      result: {
        content: [
          {
            text: JSON.stringify({
              accountId: account.id,
              available: 18,
              currency: "NZD",
              current: 20,
              dataUpdatedAt: time,
              providerRefreshedAt: time,
              syncedAt: time,
            }),
          },
        ],
        structuredContent: {
          accountId: account.id,
          available: 18,
          currency: "NZD",
          current: 20,
          dataUpdatedAt: time,
          providerRefreshedAt: time,
          syncedAt: time,
        },
      },
    });

    const transactions = await callTool(3, "list_transactions", {
      accountId: account.id,
      from: "2026-08-24T00:00:00+00:00",
      limit: 1,
      to: "2026-08-25T00:00:00+00:00",
    });
    expect(transactions.message).toMatchObject({
      result: {
        content: [{ text: expect.stringContaining('"nextCursor":"') }],
        structuredContent: {
          items: [{ id: "transaction_new" }],
          nextCursor: expect.any(String),
        },
      },
    });

    const status = await callTool(4, "get_sync_status");
    expect(status.message).toMatchObject({
      result: {
        content: [{ text: expect.stringContaining('"status":"idle"') }],
        structuredContent: { status: "idle" },
      },
    });
  });

  it("paginates transaction results using the returned cursor", async () => {
    const first = await callTool(1, "list_transactions", { limit: 1 });
    const firstMessage = toolResponseSchema.parse(first.message);
    const firstPage = z
      .object({
        items: z.object({ id: z.string() }).array(),
        nextCursor: z.string(),
      })
      .parse(JSON.parse(firstMessage.result.content[0]?.text ?? "{}"));
    const next = await callTool(2, "list_transactions", {
      cursor: firstPage.nextCursor,
      limit: 1,
    });
    expect(next.message).toMatchObject({
      result: {
        content: [{ text: expect.stringContaining('"transaction_old"') }],
      },
    });
    expect(firstPage.items[0]?.id).not.toBe("transaction_old");

    const pendingPage = await callTool(3, "list_transactions", {
      status: "pending",
    });
    expect(pendingPage.message).toMatchObject({
      result: { structuredContent: { items: [{ id: "pending_test" }] } },
    });
  });

  it("returns tool errors for unknown accounts and malformed cursors", async () => {
    const unknown = await callTool(1, "get_balance", { accountId: "missing" });
    expect(unknown.message).toMatchObject({
      result: {
        content: [
          { text: "Not found: the requested banking record does not exist" },
        ],
        isError: true,
      },
    });

    const malformed = await callTool(2, "list_transactions", { cursor: "%%%" });
    expect(malformed.message).toMatchObject({
      result: {
        content: [{ text: "Invalid request: check the supplied parameters" }],
        isError: true,
      },
    });
  });

  it("rejects unsupported methods and hostile hosts or origins", async () => {
    const unsupported = await send({ id: 1, jsonrpc: "2.0", method: "ping" });
    expect(unsupported.response.status).toBe(200);
    expect(unsupported.message).toMatchObject({
      id: 1,
      result: {},
    });

    const hostileHost = await routeMcpRequest(
      request(
        { id: 2, jsonrpc: "2.0", method: "tools/list" },
        { Host: "evil.test" }
      ),
      store,
      hostname
    );
    expect(hostileHost.status).toBe(403);

    const hostileOrigin = await routeMcpRequest(
      request(
        { id: 3, jsonrpc: "2.0", method: "tools/list" },
        { Origin: "https://evil.test" }
      ),
      store,
      hostname
    );
    expect(hostileOrigin.status).toBe(403);
  });

  it("adds no-store and nosniff security headers", async () => {
    const result = await send({ id: 1, jsonrpc: "2.0", method: "tools/list" });
    expect(result.response.headers.get("Cache-Control")).toBe("no-store");
    expect(result.response.headers.get("X-Content-Type-Options")).toBe(
      "nosniff"
    );
  });

  it("rejects invalid transaction ranges and cursor shapes", async () => {
    const reversed = await Effect.runPromiseExit(
      validateMcpTransactionQuery({
        from: "2026-08-28T00:00:00+00:00",
        to: "2026-08-27T00:00:00+00:00",
      })
    );
    expect(reversed._tag).toBe("Failure");

    const malformed = await callTool(1, "list_transactions", {
      cursor: btoa(JSON.stringify({ date: 1 })),
    });
    expect(malformed.message).toMatchObject({
      result: {
        content: [{ text: "Invalid request: check the supplied parameters" }],
        isError: true,
      },
    });
  });
});
