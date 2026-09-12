import { Effect, Redacted, Schema } from "effect";
import { describe, expect, it } from "vitest";

import type { BankConnection } from "@/domain/connection";
import { ConnectionIdSchema } from "@/domain/identifiers";
import { AkahuProviderId, makeAkahuProvider } from "@/providers/akahu/provider";

const connectionId = Schema.decodeUnknownSync(ConnectionIdSchema)(
  "connection_akahu_blank_scope"
);

const connection: BankConnection = {
  authorization: { _tag: "Connected" },
  createdAt: "2026-09-08T00:00:00.000Z",
  enabled: true,
  id: connectionId,
  label: "Blank Akahu scope",
  lastSyncAt: null,
  metadata: { akahuConnectionId: "   " },
  providerId: AkahuProviderId,
  updatedAt: "2026-09-08T00:00:00.000Z",
};

const scopedConnection: BankConnection = {
  ...connection,
  id: Schema.decodeUnknownSync(ConnectionIdSchema)("connection_akahu_scoped"),
  metadata: { akahuConnectionId: " conn_known " },
};

describe("Akahu connection scope", () => {
  it("rejects blank upstream connection IDs before transport", async () => {
    let requestCount = 0;
    const adapter = makeAkahuProvider(
      {
        appToken: Redacted.make("app-token"),
        baseUrl: "https://api.akahu.test",
        userToken: Redacted.make("user-token"),
      },
      () => {
        requestCount += 1;
        return Promise.resolve(Response.json({ items: [], success: true }));
      }
    );

    const error = await Effect.runPromise(
      Effect.flip(adapter.readSnapshot({ connection, start: null }))
    );

    expect({ requestCount, tag: error._tag }).toStrictEqual({
      requestCount: 0,
      tag: "InvalidProviderResponseError",
    });
  });

  it("rejects a configured upstream connection with no accounts", async () => {
    let requestCount = 0;
    const adapter = makeAkahuProvider(
      {
        appToken: Redacted.make("app-token"),
        baseUrl: "https://api.akahu.test",
        userToken: Redacted.make("user-token"),
      },
      () => {
        requestCount += 1;
        return Promise.resolve(
          Response.json({
            items: [
              {
                _id: "account_other",
                connection: { _id: "conn_other", name: "Other Bank" },
                name: "Other",
                status: "ACTIVE",
                type: "CHECKING",
              },
            ],
            success: true,
          })
        );
      }
    );

    const error = await Effect.runPromise(
      Effect.flip(
        adapter.readSnapshot({ connection: scopedConnection, start: null })
      )
    );

    expect({ requestCount, tag: error._tag }).toStrictEqual({
      requestCount: 1,
      tag: "InvalidProviderResponseError",
    });
  });

  it("trims a valid upstream connection ID before scoping accounts", async () => {
    const adapter = makeAkahuProvider(
      {
        appToken: Redacted.make("app-token"),
        baseUrl: "https://api.akahu.test",
        userToken: Redacted.make("user-token"),
      },
      (input) => {
        const url = String(input);
        if (url.endsWith("/accounts")) {
          return Promise.resolve(
            Response.json({
              items: [
                {
                  _id: "account_known",
                  connection: { _id: "conn_known", name: "Known Bank" },
                  name: "Known",
                  status: "ACTIVE",
                  type: "CHECKING",
                },
              ],
              success: true,
            })
          );
        }
        return Promise.resolve(Response.json({ items: [], success: true }));
      }
    );

    const snapshot = await Effect.runPromise(
      adapter.readSnapshot({ connection: scopedConnection, start: null })
    );

    expect(
      snapshot.accounts.map((account) => account.providerAccountId)
    ).toStrictEqual(["account_known"]);
  });
});
